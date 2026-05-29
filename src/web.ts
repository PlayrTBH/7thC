import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { config, discordRedirectUri } from './config.js';
import type { TeamBot } from './bot.js';
import type { JsonStore } from './store.js';
import type { DiscordUser, Team, TeamMemberRole } from './types.js';

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

  app.get('/', async (req, res, next) => {
    try {
      const user = req.session.discordUser;
      if (!user) {
        res.send(layout('Discord Team Hub', `<p>Create private Discord team roles and channels from a web form.</p><p><a class="button" href="/auth/discord">Log in with Discord</a></p>`));
        return;
      }

      const currentTeam = await store.getTeamForUser(user.id);
      res.send(
        layout(
          'Dashboard',
          `<p>Logged in as <strong>${escapeHtml(displayUser(user))}</strong>. <a href="/logout">Log out</a></p>
           ${dashboardTeamSection(currentTeam, user.id)}`
        )
      );
    } catch (error) {
      next(error);
    }
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

  app.get('/members/search', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const members = await bot.searchInvitableMembers(user.id, query);
      res.json({ members });
    } catch (error) {
      next(error);
    }
  });

  app.get('/teams/new', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const currentTeam = await store.getTeamForUser(user.id);
      if (currentTeam) {
        res.status(400).send(layout('Already in a team', `<p>You are already in <strong>${escapeHtml(currentTeam.name)}</strong>. Leave or delete your current team before creating another one.</p><p><a class="button" href="/">Back to dashboard</a></p>`));
        return;
      }

      res.send(layout('Create a team', teamForm()));
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const teamName = String(req.body.teamName ?? '');
      const selected = selectedMemberIds(req.body.memberIds);

      const { team, invites } = await bot.createTeam(user.id, teamName, selected);
      res.send(
        layout(
          'Team created',
          `<p><strong>${escapeHtml(team.name)}</strong> was created with a role, private category, text channel, and voice channel.</p>
           <p>${invites.length} invite DM${invites.length === 1 ? '' : 's'} queued.</p>
           <p><a class="button" href="/teams/${encodeURIComponent(team.id)}">Manage team</a> <a class="button secondary" href="/">Back to dashboard</a></p>`
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.get('/teams/:teamId', requireAuth, requireTeamOwner(store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      const members = await bot.getTeamMemberDetails(team.id);
      res.send(layout(`Manage ${team.name}`, manageTeamPage(team, members)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/invites', requireAuth, requireTeamOwner(store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      const user = req.session.discordUser!;
      await bot.inviteTeamMembers(team.id, user.id, selectedMemberIds(req.body.memberIds));
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/color', requireAuth, requireTeamOwner(store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.setTeamRoleColor(team.id, String(req.body.roleColor ?? ''));
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/members/:userId/role', requireAuth, requireTeamOwner(store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      const role = parseTeamMemberRole(req.body.role);
      await bot.setTeamMemberRole(team.id, req.params.userId, role);
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/members/:userId/kick', requireAuth, requireTeamOwner(store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.kickTeamMember(team.id, req.params.userId);
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/delete', requireAuth, requireTeamOwner(store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.deleteTeam(team.id);
      res.redirect('/');
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/leave', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      await bot.leaveTeam(user.id);
      res.redirect('/');
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

function selectedMemberIds(memberIds: unknown) {
  return Array.isArray(memberIds) ? memberIds.map(String) : memberIds ? [String(memberIds)] : [];
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

function requireTeamOwner(store: JsonStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.discordUser!;
      const team = await store.getTeam(req.params.teamId);
      if (!team) {
        res.status(404).send(layout('Team not found', '<p>That team does not exist.</p><p><a href="/">Back home</a></p>'));
        return;
      }
      if (team.ownerId !== user.id) {
        res.status(403).send(layout('Not allowed', '<p>Only the team owner can manage this team.</p><p><a href="/">Back home</a></p>'));
        return;
      }
      res.locals.team = team;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function dashboardTeamSection(team: Team | undefined, userId: string) {
  if (!team) {
    return `<p>You are not currently in a team.</p><p><a class="button" href="/teams/new">Create a team</a></p>`;
  }

  if (team.ownerId === userId) {
    return `<h2>Your team</h2>
      <div class="card">
        <p><strong>${escapeHtml(team.name)}</strong> — role <code>${escapeHtml(team.roleId)}</code></p>
        <p><a class="button" href="/teams/${encodeURIComponent(team.id)}">Manage team</a></p>
      </div>`;
  }

  return `<h2>Your team</h2>
    <div class="card">
      <p>You are currently a member of <strong>${escapeHtml(team.name)}</strong>.</p>
      <form method="post" action="/teams/leave" onsubmit="return confirm('Leave ${escapeJsString(team.name)}? You will lose access to its private channels.');">
        <button class="danger" type="submit">Leave team</button>
      </form>
    </div>`;
}

function teamForm() {
  return `<form method="post" action="/teams">
    <label>Team name <input name="teamName" maxlength="80" required /></label>
    ${invitePicker('Create team and send invites')}
  </form>
  ${inviteSearchScript()}`;
}

function invitePicker(submitLabel: string) {
  return `<h2>Invite server members</h2>
    <p><small>Search by Discord username or server nickname. Only server members who are not already in a team can be invited.</small></p>
    <div class="invite-search">
      <label for="member-search">Discord username</label>
      <input id="member-search" type="search" autocomplete="off" placeholder="Start typing a username…" />
      <small id="member-search-status">Enter at least 2 characters to search.</small>
    </div>
    <div id="selected-members" class="selected-members" aria-live="polite"></div>
    <div id="member-search-results" class="member-list"></div>
    <button type="submit">${escapeHtml(submitLabel)}</button>`;
}

function inviteSearchScript() {
  return `<script>
    (() => {
      const input = document.getElementById('member-search');
      const results = document.getElementById('member-search-results');
      const selected = document.getElementById('selected-members');
      const status = document.getElementById('member-search-status');
      const selectedMembers = new Map();
      let searchTimeout;
      let activeSearch = 0;

      const escapeHtml = (value) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

      const renderSelected = () => {
        selected.innerHTML = selectedMembers.size
          ? '<h3>Selected invites</h3>' + Array.from(selectedMembers.values()).map((member) =>
              '<span class="selected-member">' +
                '<input type="hidden" name="memberIds" value="' + escapeHtml(member.id) + '" />' +
                escapeHtml(member.displayName) + ' <small>@' + escapeHtml(member.tag || member.username) + '</small>' +
                '<button type="button" data-remove-member="' + escapeHtml(member.id) + '" aria-label="Remove ' + escapeHtml(member.displayName) + '">×</button>' +
              '</span>').join('')
          : '';
      };

      const renderResults = (members) => {
        results.innerHTML = members.length
          ? members.map((member) =>
              '<button class="member member-result" type="button" data-add-member="' + escapeHtml(member.id) + '">' +
                '<img src="' + escapeHtml(member.avatarUrl) + '" alt="" />' +
                '<span>' + escapeHtml(member.displayName) + ' <small>@' + escapeHtml(member.tag || member.username) + '</small></span>' +
              '</button>').join('')
          : '<p>No eligible members matched that search.</p>';

        for (const button of results.querySelectorAll('[data-add-member]')) {
          button.addEventListener('click', () => {
            const member = members.find((item) => item.id === button.dataset.addMember);
            if (!member) return;
            selectedMembers.set(member.id, member);
            renderSelected();
          });
        }
      };

      selected.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-remove-member]');
        if (!button) return;
        selectedMembers.delete(button.dataset.removeMember);
        renderSelected();
      });

      input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = input.value.trim();
        if (query.length < 2) {
          activeSearch += 1;
          results.innerHTML = '';
          status.textContent = 'Enter at least 2 characters to search.';
          return;
        }

        status.textContent = 'Searching…';
        searchTimeout = setTimeout(async () => {
          const searchId = ++activeSearch;
          try {
            const response = await fetch('/members/search?query=' + encodeURIComponent(query));
            if (!response.ok) throw new Error('Search failed.');
            const data = await response.json();
            if (searchId !== activeSearch) return;
            renderResults(data.members || []);
            const resultCount = (data.members || []).length;
            status.textContent = resultCount + ' result' + (resultCount === 1 ? '' : 's') + ' found.';
          } catch {
            if (searchId !== activeSearch) return;
            results.innerHTML = '';
            status.textContent = 'Unable to search members right now.';
          }
        }, 300);
      });
    })();
  </script>`;
}

function manageTeamPage(
  team: Team,
  members: Array<{ userId: string; role: TeamMemberRole; displayName: string; username: string; avatarUrl: string; isOwner: boolean }>
) {
  return `<p><a href="/">← Back to dashboard</a></p>
    <section class="card">
      <h2>Team role color</h2>
      <form method="post" action="/teams/${encodeURIComponent(team.id)}/color" class="inline-form">
        <label>Color <input type="color" name="roleColor" value="${escapeHtml(team.roleColor ?? '#5865F2')}" /></label>
        <button type="submit">Change color</button>
      </form>
    </section>

    <section class="card">
      <form method="post" action="/teams/${encodeURIComponent(team.id)}/invites">
        ${invitePicker('Send invites')}
      </form>
    </section>
    ${inviteSearchScript()}

    <section class="card">
      <h2>Members</h2>
      <div class="management-list">
        ${members.map((member) => managedMember(team, member)).join('')}
      </div>
    </section>

    <section class="card danger-zone">
      <h2>Delete team</h2>
      <p>Deletes the Discord team role, private channels, pending invites, and all stored memberships.</p>
      <form method="post" action="/teams/${encodeURIComponent(team.id)}/delete" onsubmit="return confirm('Delete ${escapeJsString(team.name)}? This cannot be undone.');">
        <button class="danger" type="submit">Delete team</button>
      </form>
    </section>`;
}

function managedMember(
  team: Team,
  member: { userId: string; role: TeamMemberRole; displayName: string; username: string; avatarUrl: string; isOwner: boolean }
) {
  return `<div class="managed-member">
    ${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="" />` : '<span class="avatar-placeholder"></span>'}
    <div class="member-info">
      <strong>${escapeHtml(member.displayName)}</strong> ${member.isOwner ? '<span class="pill">owner</span>' : ''}<br />
      <small>@${escapeHtml(member.username)}</small>
    </div>
    <form method="post" action="/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.userId)}/role" class="inline-form">
      <select name="role" aria-label="Team role for ${escapeHtml(member.displayName)}">
        ${teamRoleOptions(member.role)}
      </select>
      <button type="submit">Save role</button>
    </form>
    ${
      member.isOwner
        ? ''
        : `<form method="post" action="/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.userId)}/kick" onsubmit="return confirm('Kick ${escapeJsString(member.displayName)} from ${escapeJsString(team.name)}?');">
             <button class="danger" type="submit">Kick</button>
           </form>`
    }
  </div>`;
}

function teamRoleOptions(selected: TeamMemberRole) {
  return (['sub', 'main', 'coach'] as TeamMemberRole[])
    .map((role) => `<option value="${role}"${role === selected ? ' selected' : ''}>${role}</option>`)
    .join('');
}

function parseTeamMemberRole(role: unknown): TeamMemberRole {
  if (role === 'sub' || role === 'main' || role === 'coach') return role;
  throw new Error('Invalid team member role.');
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
    a { color: #93c5fd; } .button, button { background: #5865f2; color: white; border: 0; border-radius: .5rem; padding: .75rem 1rem; text-decoration: none; cursor: pointer; display: inline-block; }
    .secondary { background: #374151; } .danger { background: #dc2626; } .danger-zone { border-color: #7f1d1d; }
    input, select { border-radius: .4rem; border: 1px solid #4b5563; padding: .6rem; margin-left: .5rem; background: #111827; color: #f9fafb; }
    input[type="color"] { width: 4rem; height: 2.6rem; padding: .2rem; vertical-align: middle; }
    .card { background: #1f2937; border: 1px solid #374151; border-radius: .75rem; padding: 1rem; margin: 1rem 0; }
    .member-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .member, .managed-member { display: flex; align-items: center; gap: .75rem; background: #1f2937; border: 1px solid #374151; border-radius: .75rem; padding: .75rem; }
    .member-result { width: 100%; text-align: left; color: #f9fafb; }
    .member-result:hover { border-color: #93c5fd; }
    .invite-search { display: grid; gap: .4rem; margin: 1rem 0; }
    .invite-search input { margin-left: 0; max-width: 28rem; }
    .selected-members { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 1rem 0; }
    .selected-members h3 { flex-basis: 100%; margin: 0; }
    .selected-member { display: inline-flex; align-items: center; gap: .4rem; background: #374151; border-radius: 999px; padding: .35rem .45rem .35rem .75rem; }
    .selected-member button { border-radius: 999px; padding: .1rem .45rem; background: #4b5563; }
    .managed-member { flex-wrap: wrap; justify-content: space-between; }
    .management-list { display: grid; gap: .75rem; }
    .member-info { flex: 1 1 12rem; }
    .member img, .managed-member img, .avatar-placeholder { width: 36px; height: 36px; border-radius: 999px; background: #374151; }
    .inline-form { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .pill { display: inline-block; margin-left: .35rem; padding: .1rem .45rem; border-radius: 999px; background: #374151; color: #d1d5db; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
    small { color: #9ca3af; }
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

function escapeJsString(value: string) {
  return escapeHtml(value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}
