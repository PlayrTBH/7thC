import { dirname, join } from 'node:path';
import 'dotenv/config';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optionalUrl(name: string, fallback: string) {
  const value = process.env[name] ?? fallback;
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function optionalPort(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${name} must be a positive integer`);
  return port;
}

const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');

export const config = {
  DISCORD_CLIENT_ID: required('DISCORD_CLIENT_ID'),
  DISCORD_CLIENT_SECRET: required('DISCORD_CLIENT_SECRET'),
  DISCORD_BOT_TOKEN: required('DISCORD_BOT_TOKEN'),
  DISCORD_GUILD_ID: required('DISCORD_GUILD_ID'),
  PUBLIC_URL: optionalUrl('PUBLIC_URL', 'http://localhost:3000'),
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: optionalPort('PORT', 3000),
  SESSION_SECRET: sessionSecret,
  DATA_FILE: process.env.DATA_FILE ?? './data/store.json',
  SESSION_FILE:
    process.env.SESSION_FILE ?? join(dirname(process.env.DATA_FILE ?? './data/store.json'), 'sessions.json')
};

export const discordRedirectUri = `${config.PUBLIC_URL}/auth/discord/callback`;

export const DEVELOPER_DISCORD_USER_ID = '743956656429203535';
