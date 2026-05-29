# Discord Team Hub

Self-hosted Discord bot + website integration for creating lightweight teams inside a Discord server.

Users authenticate on the website with Discord OAuth2, choose server members to invite, and submit a team name. The bot then:

- creates a no-permissions team role;
- creates a private category for that role;
- creates one text channel and one voice channel in that category;
- assigns the role to the team owner;
- DMs selected server members with Accept/Decline buttons;
- assigns the team role when an invited member accepts.

## Requirements

- Node.js 20+
- A Discord application with a bot user
- A Discord server where you can invite that bot
- Bot permissions in the server:
  - Manage Roles
  - Manage Channels
  - Send Messages
  - View Channels

> The bot role must be higher in the Discord role list than any team roles it creates or manages.

## Discord application setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **OAuth2** and add this redirect URL:
   - Local: `http://localhost:3000/auth/discord/callback`
   - Production: `https://your-domain.example/auth/discord/callback`
3. Open **Bot** and create/copy the bot token.
4. Enable the **Server Members Intent** for the bot so it can list inviteable members.
5. Use the OAuth2 URL generator to invite the bot to your server with the permissions listed above.

## Configure

Copy the example environment file and fill in values:

```bash
cp .env.example .env
```

```env
DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_CLIENT_SECRET=your_discord_application_client_secret
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_server_guild_id
PUBLIC_URL=http://localhost:3000
PORT=3000
SESSION_SECRET=replace_with_a_long_random_secret
DATA_FILE=./data/store.json
```

Generate a session secret with:

```bash
openssl rand -hex 32
```

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, log in with Discord, create a team, and choose members to invite.

## Docker

```bash
docker compose up -d --build
```

The compose file reads `.env`, exposes port 3000, and persists the JSON store in `./data`.

## Production notes

- Put the app behind HTTPS and set `PUBLIC_URL` to the public HTTPS URL.
- Use a process manager such as systemd, Docker, or PM2 to keep `npm start` running.
- The default persistence layer is a JSON file at `DATA_FILE`; back it up if you rely on invite history.
- Discord users can block DMs from server members. Those invites are marked `failed_dm` in the JSON store and will need manual follow-up.
- Keep `.env` and `data/` private. They contain secrets and Discord IDs.

## Build

```bash
npm run build
npm start
```
