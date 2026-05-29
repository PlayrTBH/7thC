import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { config, discordRedirectUri } from './config.js';
import type { TeamBot } from './bot.js';
import type { JsonStore } from './store.js';
import type { DiscordUser } from './types.js';

declare module 'express-session' {
  interface SessionData {
    discordUser?: DiscordUser;
    oauthState?: string;
  }
}

export function createWebApp(bot: TeamBot, store: JsonStore) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      name: 'teamhub.sid',
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.PUBLIC_URL.startsWith('https://')
      }
    })
  );

  app.get('/', async (req, res) => {
    const user = req.session.discordUser;
    if (!user) {
      res.send(layout('Discord Team Hub', `<p>Create private Discord team roles and channels from a web form.</p><p><a class="button" href="/auth/discord">Log in with Discord</a></p>`));
      return;
    }

    const teams = await store.getTeamsByOwner(user.id);
    res.send(
      layout(
        'Dashboard',
        `<p>Logged in as <strong>${escapeHtml(displayUser(user))}</strong>. <a href="/logout">Log out</a></p>
         <p><a class="button" href="/teams/new">Create a team</a></p>
         <h2>Your teams</h2>
         ${
           teams.length
             ? `<ul>${teams.map((team) => `<li><strong>${escapeHtml(team.name)}</strong> — role <code>${team.roleId}</code></li>`).join('')}</ul>`
             : '<p>No teams created yet.</p>'
         }`
      )
    );
  });

  app.get('/auth/discord', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const params = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      redirect_uri: discordRedirectUri,
      response_type: 'code',
      scope: 'identify',
      state
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get('/auth/discord/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (typeof code !== 'string' || typeof state !== 'string' || state !== req.session.oauthState) {
        res.status(400).send(layout('Login failed', '<p>Invalid OAuth response. Please try logging in again.</p>'));
        return;
      }

      const user = await exchangeCodeForUser(code);
      const member = await bot.getGuildMember(user.id);
      if (!member) {
        res.status(403).send(layout('Not in server', '<p>Your Discord account is not a member of the configured server.</p>'));
        return;
      }

      req.session.discordUser = user;
      delete req.session.oauthState;
      res.redirect('/');
    } catch (error) {
      next(error);
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  app.get('/teams/new', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const members = await bot.listInvitableMembers(user.id);
      res.send(layout('Create a team', teamForm(members)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const teamName = String(req.body.teamName ?? '');
      const selected = Array.isArray(req.body.memberIds)
        ? req.body.memberIds.map(String)
        : req.body.memberIds
          ? [String(req.body.memberIds)]
          : [];

      const { team, invites } = await bot.createTeam(user.id, teamName, selected);
      res.send(
        layout(
          'Team created',
          `<p><strong>${escapeHtml(team.name)}</strong> was created with a role, private category, text channel, and voice channel.</p>
           <p>${invites.length} invite DM${invites.length === 1 ? '' : 's'} queued.</p>
           <p><a class="button" href="/">Back to dashboard</a></p>`
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).send(layout('Something went wrong', `<p>${escapeHtml(message)}</p><p><a href="/">Back home</a></p>`));
  });

  return app;
}

async function exchangeCodeForUser(code: string) {
  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: discordRedirectUri
    })
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed with ${tokenResponse.status}`);
  }

  const token = (await tokenResponse.json()) as { access_token: string; token_type: string };
  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `${token.token_type} ${token.access_token}` }
  });

  if (!userResponse.ok) {
    throw new Error(`Discord user lookup failed with ${userResponse.status}`);
  }

  return (await userResponse.json()) as DiscordUser;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.discordUser) {
    res.redirect('/auth/discord');
    return;
  }
  next();
}

function teamForm(members: Array<{ id: string; displayName: string; username: string; avatarUrl: string }>) {
  return `<form method="post" action="/teams">
    <label>Team name <input name="teamName" maxlength="80" required /></label>
    <h2>Invite server members</h2>
    <div class="member-list">
      ${members
        .map(
          (member) => `<label class="member">
            <input type="checkbox" name="memberIds" value="${escapeHtml(member.id)}" />
            <img src="${escapeHtml(member.avatarUrl)}" alt="" />
            <span>${escapeHtml(member.displayName)} <small>@${escapeHtml(member.username)}</small></span>
          </label>`
        )
        .join('')}
    </div>
    <button type="submit">Create team and send invites</button>
  </form>`;
}

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Discord Team Hub</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; margin: 0; background: #111827; color: #f9fafb; }
    main { max-width: 900px; margin: 0 auto; padding: 3rem 1.25rem; }
    a { color: #93c5fd; } .button, button { background: #5865f2; color: white; border: 0; border-radius: .5rem; padding: .75rem 1rem; text-decoration: none; cursor: pointer; }
    input { border-radius: .4rem; border: 1px solid #4b5563; padding: .6rem; margin-left: .5rem; }
    .member-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .member { display: flex; align-items: center; gap: .75rem; background: #1f2937; border: 1px solid #374151; border-radius: .75rem; padding: .75rem; }
    .member img { width: 36px; height: 36px; border-radius: 999px; } small { color: #9ca3af; }
    code { background: #1f2937; border-radius: .25rem; padding: .15rem .35rem; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
}

function displayUser(user: DiscordUser) {
  return user.global_name || user.username;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}
