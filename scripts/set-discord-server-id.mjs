#!/usr/bin/env node
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const usage = `Usage: npm run set:guild -- <discord_server_id> [--env-file .env] [--no-backup]\n\nUpdates DISCORD_GUILD_ID in the local environment file. Run this only from the server shell you control, then restart the app so the bot uses the new Discord server.`;

const args = process.argv.slice(2);
let guildId;
let envFile = '.env';
let backup = true;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') {
    console.log(usage);
    process.exit(0);
  }
  if (arg === '--env-file') {
    const value = args[index + 1];
    if (!value) fail('--env-file requires a path.');
    envFile = value;
    index += 1;
    continue;
  }
  if (arg === '--no-backup') {
    backup = false;
    continue;
  }
  if (arg.startsWith('--')) fail(`Unknown option: ${arg}`);
  if (guildId) fail('Provide only one Discord server/guild ID.');
  guildId = arg;
}

if (!guildId) fail('Missing Discord server/guild ID.');
if (!/^\d{17,20}$/.test(guildId)) {
  fail('Discord server/guild ID must be a 17-20 digit Discord snowflake.');
}

const resolvedEnvFile = path.resolve(envFile);
let current;
try {
  current = await readFile(resolvedEnvFile, 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') fail(`${envFile} was not found. Run setup first or pass --env-file.`);
  throw error;
}

const lines = current.split(/\r?\n/);
let replaced = false;
const nextLines = lines.map((line) => {
  if (/^\s*DISCORD_GUILD_ID\s*=/.test(line)) {
    replaced = true;
    return `DISCORD_GUILD_ID=${guildId}`;
  }
  return line;
});

if (!replaced) {
  const insertAt = nextLines.findIndex((line) => /^\s*PUBLIC_URL\s*=/.test(line));
  if (insertAt >= 0) {
    nextLines.splice(insertAt, 0, `DISCORD_GUILD_ID=${guildId}`);
  } else {
    if (nextLines.length && nextLines.at(-1) !== '') nextLines.push('');
    nextLines.push(`DISCORD_GUILD_ID=${guildId}`);
  }
}

const next = `${nextLines.join('\n').replace(/\n*$/, '')}\n`;
if (current === next) {
  console.log(`DISCORD_GUILD_ID is already ${guildId} in ${envFile}.`);
  process.exit(0);
}

if (backup) {
  const backupFile = `${resolvedEnvFile}.backup.${timestamp()}`;
  await copyFile(resolvedEnvFile, backupFile, constants.COPYFILE_EXCL);
  console.log(`Backed up ${envFile} to ${path.relative(process.cwd(), backupFile)}.`);
}

await writeFile(resolvedEnvFile, next, 'utf8');
await chmod(resolvedEnvFile, 0o600).catch(() => undefined);
console.log(`Updated DISCORD_GUILD_ID in ${envFile}.`);
console.log('Restart the app for this to take effect: docker compose up -d --force-recreate or restart your local Node process.');

function fail(message) {
  console.error(message);
  console.error(usage);
  process.exit(1);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
