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

## One-line interactive setup

### From a private GitHub repo on a fresh VM

Install GitHub CLI, authenticate with access to this private repo, then pull and run the installer directly from GitHub:

```bash
# Ubuntu/Debian example
sudo apt-get update && sudo apt-get install -y git curl gh

# Log in to GitHub; choose GitHub.com, HTTPS, and browser/device-code auth when prompted.
gh auth login --scopes repo
gh auth setup-git

# Pull install.sh from the private 7thC repo and run it.
GH_REPO=$(gh repo list --limit 200 --json name,nameWithOwner \
  --jq '.[] | select(.name == "7thC") | .nameWithOwner' | head -n 1)
gh api -H "Accept: application/vnd.github.raw" \
  "/repos/$GH_REPO/contents/install.sh?ref=work" | bash
```

When the script is launched this way, it first finds this private `7thC` repository through your authenticated GitHub account, clones or updates it on the VM, then continues the normal setup from that checkout. You can set `DISCORD_TEAM_HUB_DIR=/opt/discord-team-hub` before `bash` if you want a different install directory; otherwise it uses `~/discord-team-hub`.
# Replace OWNER, REPO, and BRANCH. For this branch, BRANCH is usually work.
curl -H "Authorization: Bearer $(gh auth token)" \
  -fsSL https://raw.githubusercontent.com/OWNER/REPO/BRANCH/install.sh \
  | DISCORD_TEAM_HUB_REPO_URL=https://github.com/OWNER/REPO.git \
    DISCORD_TEAM_HUB_BRANCH=BRANCH \
    bash
```

When the script is launched this way, it first clones or updates the private repository on the VM, then continues the normal setup from that checkout. You can set `DISCORD_TEAM_HUB_DIR=/opt/discord-team-hub` before `bash` if you want a different install directory; otherwise it uses `~/discord-team-hub`.

### From an already checked-out repo

```bash
npm run setup
# or
./install.sh
```

The installer prompts for your Discord client ID, client secret, bot token, guild/server ID, public URL, port, data file path, and session secret. It writes a private `.env` file, then offers to finish setup with Docker Compose, local `npm install && npm run build`, or skip dependency installation for later.

## Manual configuration
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
