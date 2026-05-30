# 7th Circle Team Hub

Self-hosted Discord bot + website integration for creating lightweight teams inside a Discord server.

Users authenticate on the website with Discord OAuth2, submit a team name, and optionally choose server members to invite. The bot then:

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

Install GitHub CLI, authenticate with access to this private repo, then pull and run the installer directly from GitHub. If your terminal output mentions `PlayrTBH/7thC`, you are running an older command; use the command below instead.

```bash
# Ubuntu/Debian example
sudo apt-get update && sudo apt-get install -y git curl gh

# Log in to GitHub; choose GitHub.com, HTTPS, and browser/device-code auth when prompted.
gh auth login --scopes repo
gh auth setup-git

# Pull install.sh from the private repo and run it.
# This runs inside a child bash process, so failures will not close your SSH shell.
bash <<'INSTALLER_BOOTSTRAP'
GH_REPO="${DISCORD_TEAM_HUB_GITHUB_REPO:-}"
if [ -z "$GH_REPO" ]; then
  GH_REPO=$(gh repo list --limit 1000 --json name,nameWithOwner \
    --jq '.[] | select((.name | ascii_downcase) == "7thc") | .nameWithOwner' | head -n 1)
fi
if [ -z "$GH_REPO" ]; then
  echo "I could not auto-detect the repo. Pick it from the repos this account can access:" >&2
  mapfile -t GH_REPOS < <(gh repo list --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner')
  select selected_repo in "${GH_REPOS[@]}"; do
    GH_REPO="$selected_repo"
    test -n "$GH_REPO" && break
  done
fi
if [ -z "$GH_REPO" ]; then
  echo "No GitHub repo selected; leaving this shell open." >&2
else
  GH_BRANCH=$(gh repo view "$GH_REPO" --json defaultBranchRef --jq '.defaultBranchRef.name') && \
  INSTALLER=$(mktemp) && \
  gh api -H "Accept: application/vnd.github.raw" \
    "/repos/$GH_REPO/contents/install.sh?ref=$GH_BRANCH" > "$INSTALLER" && \
  DISCORD_TEAM_HUB_REPO_URL="https://github.com/$GH_REPO.git" \
    DISCORD_TEAM_HUB_BRANCH="$GH_BRANCH" \
    bash "$INSTALLER"
  rm -f "${INSTALLER:-}"
fi
INSTALLER_BOOTSTRAP
```


When the script is launched this way, it first tries to find an accessible repo named `7thC`; if it cannot, it lets you pick from the repositories your authenticated GitHub account can access. It does not call `exit`, so a failure should leave your SSH session open. If you already know the exact `owner/repo`, prefix the command with `DISCORD_TEAM_HUB_GITHUB_REPO=owner/repo`. It then downloads `install.sh` from the selected repo default branch, clones or updates the repository on the VM, and continues the normal setup from that checkout. The bootstrap runs in a child `bash`, so a failure will return you to your SSH shell instead of logging you out. You can set `DISCORD_TEAM_HUB_DIR=/opt/discord-team-hub` before `bash` if you want a different install directory; otherwise it uses `~/discord-team-hub`.

### From an already checked-out repo

```bash
npm run setup
# or
./install.sh
```

The installer prompts for your Discord client ID, client secret, bot token, guild/server ID, public URL, bind host, port, data file path, and session secret. It writes a private `.env` file, then offers to finish setup with Docker Compose, local `npm install && npm run build`, or skip dependency installation for later.

## Manual configuration

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
HOST=0.0.0.0
PORT=3000
SESSION_SECRET=replace_with_a_long_random_secret
DATA_FILE=./data/store.json
```

Generate a session secret with:

```bash
openssl rand -hex 32
```


## Developer panel

Discord user ID `743956656429203535` has access to a dedicated **Developer** link after logging in. The panel includes:

- bot and process uptime, Discord gateway latency, memory usage, Node.js version, and cache counts;
- configured server details including member, channel, and role counts;
- a restart action that reconnects the Discord bot client without stopping the website process;
- runtime bot presence configuration for status and activity text/type;
- an in-memory web log viewer for recent console output, with a clear-log action.

The developer presence settings are stored in the JSON data file and reapplied when the bot starts. Environment-backed settings such as Discord credentials, public URL, host, port, guild ID, and data file path stay read-only in the web UI and should still be changed from the server shell.

## Change the managed Discord server

Changing which Discord server/guild the bot manages is intentionally command-line only; there is no website setting for it. Run this from the server shell you control, replacing the ID with the new Discord server/guild ID:

```bash
npm run set:guild -- 123456789012345678
```

The command updates `DISCORD_GUILD_ID` in `.env`, creates a timestamped backup by default, and leaves the file private (`chmod 600`). Restart the app afterward so the bot reconnects using the new server ID:

```bash
docker compose up -d --force-recreate
# or restart your local Node process if you are not using Docker
```

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, log in with Discord, create a team, and optionally choose members to invite during creation or later from the manage team page.

## Docker

```bash
docker compose up -d --build
```

The compose file reads `.env`, exposes port 3000, and persists the JSON store in `./data`.



## Updating an existing install

From the installed repository directory, run one command:

```bash
./update.sh
```

The updater preserves `.env` and `data/`, fetches the latest git changes, and then either rebuilds/restarts Docker Compose if that service exists or runs a local `npm install` and `npm run build`.

You can force a mode if needed:

```bash
UPDATE_MODE=docker ./update.sh
UPDATE_MODE=local ./update.sh
```

If you installed with the default path from `install.sh`, this is usually:

```bash
cd ~/discord-team-hub && ./update.sh
```

## Network troubleshooting

If the VM cannot reach `http://192.168.1.117:3000` or your Cloudflare Tunnel does not resolve:

1. Confirm the app is actually running and listening:

   ```bash
   docker compose ps
   docker compose logs -f discord-team-hub
   ss -ltnp | grep ':3000'
   curl -v http://127.0.0.1:3000
   ```

2. Make sure `.env` exposes the app on all interfaces:

   ```env
   HOST=0.0.0.0
   PORT=3000
   ```

3. If using Docker Compose, confirm the port mapping is still present:

   ```yaml
   ports:
     - "3000:3000"
   ```

4. Configure Cloudflare Tunnel based on where `cloudflared` runs:

   - If `cloudflared` runs on the same VM as this app, point it at:

     ```text
     http://localhost:3000
     ```

   - If `cloudflared` runs on a different VM on the same LAN, point it at the app VM LAN IP:

     ```text
     http://192.168.1.117:3000
     ```

     In this setup, `HOST=0.0.0.0` is required, Docker must publish `3000:3000`, and the app VM firewall must allow TCP 3000 from the Cloudflare Tunnel VM. Test that from the Cloudflare Tunnel VM with:

     ```bash
     curl -v http://192.168.1.117:3000
     ```

5. If `curl http://127.0.0.1:3000` on the app VM fails, check the app logs first. The website starts after the Discord bot login succeeds, so a bad bot token, missing privileged intent, or Discord connection failure can prevent port 3000 from opening.

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
