import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { config, DEVELOPER_DISCORD_USER_ID, discordRedirectUri } from './config.js';
import type { TeamBot } from './bot.js';
import type { JsonStore } from './store.js';
import { clearLogs, getRecentLogs, type CapturedLog } from './logger.js';
import { JsonSessionStore } from './session-store.js';
import type { BotActivityType, BotStatus, DiscordUser, Event, EventRegistration, Team, TeamInvite, TeamMember, TeamMemberRole } from './types.js';

declare module 'express-session' {
  interface SessionData {
    discordUser?: DiscordUser;
    oauthState?: string;
  }
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createWebApp(bot: TeamBot, store: JsonStore) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').send(FAVICON_SVG);
  });

  app.use(
    session({
      name: 'teamhub.sid',
      store: new JsonSessionStore(config.SESSION_FILE),
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.PUBLIC_URL.startsWith('https://'),
        maxAge: SESSION_MAX_AGE_MS
      }
    })
  );

  app.get('/', async (req, res, next) => {
    try {
      const user = req.session.discordUser;
      if (!user) {
        res.send(layout('7th Circle Team Hub', `<section class="hero-card login-card"><p class="eyebrow">7th Circle Team Hub</p><h2>Log in</h2><p><a class="button" href="/auth/discord">Log in with Discord</a></p></section>`));
        return;
      }

      const currentTeam = await store.getTeamForUser(user.id);
      const administratorAccess = await bot.getAdministratorAccess(user.id);
      res.send(
        layout(
          'Dashboard',
          `<p class="page-intro">Logged in as <strong>${escapeHtml(displayUser(user))}</strong>.</p>
           ${administratorAccess.isAdmin ? '<p><a class="button secondary" href="/administrator">Administrator page</a></p>' : ''}
           ${isDeveloperUser(user) ? '<p><a class="button secondary" href="/developer">Developer panel</a></p>' : ''}
           ${dashboardTeamSection(currentTeam, user.id)}`,
          { user, isAdmin: administratorAccess.isAdmin, active: 'dashboard' }
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

  app.get('/settings', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const administratorAccess = await bot.getAdministratorAccess(user.id);
      res.send(layout('Account settings', settingsPage(user), { user, isAdmin: administratorAccess.isAdmin, active: 'settings' }));
    } catch (error) {
      next(error);
    }
  });


  app.get('/events', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [events, counts, currentTeam, administratorAccess] = await Promise.all([
        store.getEvents(),
        store.getEventRegistrationCounts(),
        store.getTeamForUser(user.id),
        bot.getAdministratorAccess(user.id)
      ]);
      res.send(layout('Events', eventsPage(events, counts, currentTeam, user.id), { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/events/:eventId/register', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [event, currentTeam, administratorAccess] = await Promise.all([
        store.getEvent(req.params.eventId),
        store.getTeamForUser(user.id),
        bot.getAdministratorAccess(user.id)
      ]);
      if (!event) {
        res.status(404).send(layout('Event not found', '<p>That event does not exist.</p><p><a href="/events">Back to events</a></p>', { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
        return;
      }
      if (!currentTeam || currentTeam.ownerId !== user.id) {
        res.status(403).send(layout('Captain required', '<p>Only a team captain can register a team for an event.</p><p><a href="/events">Back to events</a></p>', { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
        return;
      }
      const [members, registrations, existingRegistration] = await Promise.all([
        bot.getTeamMemberDetails(currentTeam.id),
        store.getEventRegistrations(event.id),
        store.getEventRegistration(event.id, currentTeam.id)
      ]);
      res.send(layout(`Register for ${event.title}`, eventRegistrationPage(event, currentTeam, members, registrations.length, existingRegistration), { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/events/:eventId/register', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const event = await store.getEvent(req.params.eventId);
      if (!event) throw new Error('Event not found.');
      const team = await store.getTeamForUser(user.id);
      if (!team || team.ownerId !== user.id) throw new Error('Only a team captain can register a team for an event.');

      const members = await store.getTeamMembers(team.id);
      const mainPlayerIds = selectedMemberIds(req.body.mainPlayerIds);
      const substitutePlayerIds = selectedMemberIds(req.body.substitutePlayerIds);
      const registrationCount = (await store.getEventRegistrations(event.id)).length;
      validateEventRegistration(event, members, mainPlayerIds, substitutePlayerIds, registrationCount);

      const now = new Date().toISOString();
      await store.addEventRegistration({
        id: crypto.randomUUID(),
        eventId: event.id,
        teamId: team.id,
        captainId: user.id,
        mainPlayerIds,
        substitutePlayerIds,
        createdAt: now,
        updatedAt: now
      });
      res.redirect(`/events/${encodeURIComponent(event.id)}/registrations`);
    } catch (error) {
      next(error);
    }
  });

  app.get('/events/:eventId/registrations', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [event, administratorAccess] = await Promise.all([store.getEvent(req.params.eventId), bot.getAdministratorAccess(user.id)]);
      if (!event) {
        res.status(404).send(layout('Event not found', '<p>That event does not exist.</p><p><a href="/events">Back to events</a></p>', { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
        return;
      }
      const registrations = await store.getEventRegistrations(event.id);
      const details = await Promise.all(
        registrations.map(async (registration) => ({
          registration,
          team: await store.getTeam(registration.teamId),
          members: await bot.getTeamMemberDetails(registration.teamId)
        }))
      );
      res.send(layout(`${event.title} registrations`, eventRegistrationsPage(event, details), { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/event-management', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const events = await store.getEvents();
      const counts = await store.getEventRegistrationCounts();
      res.send(layout('Event management', eventManagementPage(events, counts), { user: req.session.discordUser, isAdmin: true, active: 'event-management' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/event-management/events', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const now = new Date().toISOString();
      const event = parseEventForm(req.body);
      await store.addEvent({ id: crypto.randomUUID(), ...event, createdBy: req.session.discordUser!.id, createdAt: now, updatedAt: now });
      res.redirect('/event-management');
    } catch (error) {
      next(error);
    }
  });

  app.get('/event-management/events/:eventId/edit', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const [event, counts] = await Promise.all([store.getEvent(req.params.eventId), store.getEventRegistrationCounts()]);
      if (!event) {
        res.status(404).send(layout('Event not found', '<p>That event does not exist.</p><p><a href="/event-management">Back to event management</a></p>', { user: req.session.discordUser, isAdmin: true, active: 'event-management' }));
        return;
      }
      res.send(layout(`Edit ${event.title}`, eventEditPage(event, counts[event.id] ?? 0), { user: req.session.discordUser, isAdmin: true, active: 'event-management' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/event-management/events/:eventId', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const existing = await store.getEvent(req.params.eventId);
      if (!existing) throw new Error('Event not found.');
      const parsed = parseEventForm(req.body);
      await store.updateEvent(existing.id, parsed);
      res.redirect('/event-management');
    } catch (error) {
      next(error);
    }
  });

  app.get('/administrator', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const access = res.locals.administratorAccess as AdministratorAccess;
      const [teams, settings, roles] = await Promise.all([
        store.getTeams(),
        store.getAdministratorSettings(),
        access.isOwner ? bot.getGuildRoles() : Promise.resolve([])
      ]);
      const teamSummaries = await Promise.all(
        teams.map(async (team) => ({
          team,
          memberCount: (await store.getTeamMembers(team.id)).length
        }))
      );
      res.send(layout('Administrator', administratorPage(teamSummaries, access, roles, settings.adminRoleId), { user: req.session.discordUser, isAdmin: true, active: 'administrator' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/settings', requireAuth, requireGuildOwner(bot), async (req, res, next) => {
    try {
      const adminRoleId = String(req.body.adminRoleId ?? '').trim() || undefined;
      if (adminRoleId && !(await bot.getGuildRoles()).some((role) => role.id === adminRoleId)) {
        throw new Error('Selected administrator role was not found in this Discord server.');
      }
      await store.updateAdministratorSettings({ adminRoleId });
      res.redirect('/administrator');
    } catch (error) {
      next(error);
    }
  });

  app.get('/developer', requireAuth, requireDeveloper, async (req, res, next) => {
    try {
      const [stats, teams, settings] = await Promise.all([bot.getDeveloperStats(), store.getTeams(), store.getDeveloperSettings()]);
      const logs = getRecentLogs(250);
      res.send(layout('Developer panel', developerPage(stats, teams.length, settings, logs), { user: req.session.discordUser, isDeveloper: true, active: 'developer' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/developer/restart', requireAuth, requireDeveloper, async (_req, res, next) => {
    try {
      await bot.restart();
      res.redirect('/developer');
    } catch (error) {
      next(error);
    }
  });

  app.post('/developer/config', requireAuth, requireDeveloper, async (req, res, next) => {
    try {
      const botStatus = parseBotStatus(req.body.botStatus);
      const activityType = parseActivityType(req.body.activityType);
      const activityName = String(req.body.activityName ?? '').trim().slice(0, 128) || undefined;
      await bot.updateDeveloperSettings({ botStatus, activityType, activityName });
      res.redirect('/developer');
    } catch (error) {
      next(error);
    }
  });

  app.post('/developer/logs/clear', requireAuth, requireDeveloper, (req, res) => {
    console.warn(`Developer ${req.session.discordUser!.id} cleared the in-memory web log buffer.`);
    clearLogs();
    res.redirect('/developer#logs');
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
      const [currentTeam, administratorAccess] = await Promise.all([
        store.getTeamForUser(user.id),
        bot.getAdministratorAccess(user.id)
      ]);
      if (currentTeam) {
        res.status(400).send(layout('Already in a team', `<p>You are already in <strong>${escapeHtml(currentTeam.name)}</strong>. Leave or delete your current team before creating another one.</p><p><a class="button" href="/">Back to dashboard</a></p>`, { user, isAdmin: administratorAccess.isAdmin, active: 'teams' }));
        return;
      }

      res.send(layout('Create a team', teamForm(), { user, isAdmin: administratorAccess.isAdmin, active: 'teams' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const teamName = String(req.body.teamName ?? '');
      const selected = selectedMemberIds(req.body.memberIds);

      const administratorAccess = await bot.getAdministratorAccess(user.id);
      const { team, invites } = await bot.createTeam(user.id, teamName, selected);
      res.send(
        layout(
          'Team created',
          `<p><strong>${escapeHtml(team.name)}</strong> was created with a role, private category, text channel, and voice channel.</p>
           <p>${teamCreatedInviteMessage(invites.length)}</p>
           <p><a class="button" href="/teams/${encodeURIComponent(team.id)}">Manage team</a> <a class="button secondary" href="/">Back to dashboard</a></p>`,
          { user, isAdmin: administratorAccess.isAdmin, active: 'teams' }
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.get('/teams/:teamId', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      const [members, invites] = await Promise.all([bot.getTeamMemberDetails(team.id), bot.getTeamInviteDetails(team.id)]);
      res.send(layout(`Manage ${team.name}`, manageTeamPage(team, members, invites, Boolean(res.locals.canManageAllTeams)), { user: req.session.discordUser, isAdmin: Boolean(res.locals.canManageAllTeams), active: 'teams' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/invites', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      const user = req.session.discordUser!;
      await bot.inviteTeamMembers(team.id, user.id, selectedMemberIds(req.body.memberIds), Boolean(res.locals.canManageAllTeams));
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/color', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.setTeamRoleColor(team.id, String(req.body.roleColor ?? ''));
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/name', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.renameTeam(team.id, String(req.body.teamName ?? ''));
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/members/:userId/role', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      const role = parseTeamMemberRole(req.body.role);
      await bot.setTeamMemberRole(team.id, req.params.userId, role);
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/members/:userId/kick', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.kickTeamMember(team.id, req.params.userId);
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/members/:userId/transfer-ownership', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.transferTeamOwnership(team.id, req.params.userId);
      res.redirect(`/teams/${encodeURIComponent(team.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/:teamId/delete', requireAuth, requireTeamManager(bot, store), async (req, res, next) => {
    try {
      const team = res.locals.team as Team;
      await bot.deleteTeam(team.id);
      res.redirect(res.locals.canManageAllTeams ? '/administrator' : '/');
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

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).send(layout('Something went wrong', `<p>${escapeHtml(message)}</p><p><a href="/">Back home</a></p>`, { user: req.session.discordUser }));
  });

  return app;
}

type AdministratorAccess = { isOwner: boolean; isAdmin: boolean };
type LayoutOptions = { user?: DiscordUser; isAdmin?: boolean; isDeveloper?: boolean; active?: 'dashboard' | 'events' | 'teams' | 'event-management' | 'administrator' | 'settings' | 'developer' };

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#020202"/>
  <path d="M545 102c200 21 356 190 356 396 0 220-179 399-399 399-171 0-317-108-373-260h113c50 95 149 158 260 158 164 0 297-133 297-297 0-149-110-273-254-294z" fill="#0b0b0c"/>
  <path d="M118 100h377v101L279 592H129l216-378H118z" fill="#c90820"/>
  <path d="M176 264h83L100 541v-58c0-79 27-155 76-219z" fill="#ffffff"/>
</svg>`;


function selectedMemberIds(memberIds: unknown) {
  const values = Array.isArray(memberIds) ? memberIds.map(String) : memberIds ? [String(memberIds)] : [];
  return [...new Set(values)];
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

function requireGuildAdministrator(bot: TeamBot) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = await bot.getAdministratorAccess(req.session.discordUser!.id);
      if (!access.isAdmin) {
        res.status(403).send(layout('Not allowed', '<p>Only the Discord owner or configured administrator role can access this page.</p><p><a href="/">Back home</a></p>', { user: req.session.discordUser }));
        return;
      }
      res.locals.administratorAccess = access;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireGuildOwner(bot: TeamBot) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = await bot.getAdministratorAccess(req.session.discordUser!.id);
      if (!access.isOwner) {
        res.status(403).send(layout('Not allowed', '<p>Only the Discord owner can change administrator settings.</p><p><a href="/administrator">Back to administrator</a></p>', { user: req.session.discordUser }));
        return;
      }
      res.locals.administratorAccess = access;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireDeveloper(req: Request, res: Response, next: NextFunction) {
  if (!req.session.discordUser || !isDeveloperUser(req.session.discordUser)) {
    res.status(403).send(layout('Not allowed', '<p>Only the configured developer Discord account can access this panel.</p><p><a href="/">Back home</a></p>', { user: req.session.discordUser }));
    return;
  }
  next();
}

function isDeveloperUser(user?: DiscordUser) {
  return user?.id === DEVELOPER_DISCORD_USER_ID;
}

function requireTeamManager(bot: TeamBot, store: JsonStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.discordUser!;
      const team = await store.getTeam(req.params.teamId);
      if (!team) {
        res.status(404).send(layout('Team not found', '<p>That team does not exist.</p><p><a href="/">Back home</a></p>', { user }));
        return;
      }
      const access = await bot.getAdministratorAccess(user.id);
      if (team.ownerId !== user.id && !access.isAdmin) {
        res.status(403).send(layout('Not allowed', '<p>Only the team owner or a server administrator can manage this team.</p><p><a href="/">Back home</a></p>', { user, isAdmin: access.isAdmin }));
        return;
      }
      res.locals.team = team;
      res.locals.administratorAccess = access;
      res.locals.canManageAllTeams = access.isAdmin;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function settingsPage(user: DiscordUser) {
  return `<section class="card profile-card">
    <img class="profile-avatar" src="${escapeHtml(discordAvatarUrl(user, 160))}" alt="" />
    <div>
      <p class="eyebrow">Account</p>
      <h2>${escapeHtml(displayUser(user))}</h2>
      <p><small>@${escapeHtml(user.username)} · Discord ID <code>${escapeHtml(user.id)}</code></small></p>
      <p>Use this page to confirm which Discord account is connected to 7th Circle Team Hub.</p>
      <p><a class="button danger" href="/logout">Log out</a></p>
    </div>
  </section>`;
}


type EventFormFields = Pick<Event, 'title' | 'description' | 'teamLimit' | 'requiredMainPlayers' | 'requiredSubstitutes' | 'startsAt' | 'endsAt' | 'registrationOpensAt' | 'registrationClosesAt'>;

type EventRegistrationDetail = {
  registration: EventRegistration;
  team?: Team;
  members: Awaited<ReturnType<TeamBot['getTeamMemberDetails']>>;
};

function eventsPage(events: Event[], counts: Record<string, number>, currentTeam: Team | undefined, currentUserId: string) {
  const visibleEvents = events.filter((event) => eventState(event) !== 'ended');
  return `<p class="page-intro">Upcoming and live events are listed in chronological order. Team captains can register once their roster meets the event requirements.</p>
    ${
      visibleEvents.length
        ? `<div class="event-list">${visibleEvents.map((event) => eventCard(event, counts[event.id] ?? 0, currentTeam, currentUserId)).join('')}</div>`
        : '<section class="card"><h2>No upcoming or live events</h2><p>Check back after administrators create the next event.</p></section>'
    }`;
}

function eventCard(event: Event, registrationCount: number, currentTeam: Team | undefined, currentUserId: string) {
  const state = eventState(event);
  const registrationState = eventRegistrationState(event, registrationCount);
  const canRegister = currentTeam?.ownerId === currentUserId && registrationState === 'open';
  return `<section class="card event-card">
    <div class="section-heading-row">
      <div>
        <p class="eyebrow">${eventStateLabel(state)}</p>
        <h2>${escapeHtml(event.title)}</h2>
      </div>
      <span class="event-capacity">${registrationCount}/${event.teamLimit} teams</span>
    </div>
    <p>${escapeHtml(event.description)}</p>
    <div class="event-meta-grid">
      ${eventMeta('Event starts', formatDateTime(event.startsAt))}
      ${eventMeta('Event ends', formatDateTime(event.endsAt))}
      ${eventMeta('Registration', `${formatDateTime(event.registrationOpensAt)} → ${formatDateTime(event.registrationClosesAt)}`)}
      ${eventMeta('Roster required', `${event.requiredMainPlayers} main, ${event.requiredSubstitutes} sub${event.requiredSubstitutes === 1 ? '' : 's'}`)}
    </div>
    <div class="event-actions">
      <a class="button secondary" href="/events/${encodeURIComponent(event.id)}/registrations">Registered teams</a>
      ${registrationState === 'full' ? '<span class="pill">Full</span>' : ''}
      ${registrationState === 'not-open' ? '<span class="pill">Registration not open</span>' : ''}
      ${registrationState === 'closed' ? '<span class="pill">Registration closed</span>' : ''}
      ${canRegister ? `<a class="button" href="/events/${encodeURIComponent(event.id)}/register">Register</a>` : ''}
      ${!currentTeam ? '<small>Create a team as captain to register.</small>' : ''}
      ${currentTeam && currentTeam.ownerId !== currentUserId ? '<small>Only your team captain can register.</small>' : ''}
    </div>
  </section>`;
}

function eventRegistrationPage(
  event: Event,
  team: Team,
  members: Awaited<ReturnType<TeamBot['getTeamMemberDetails']>>,
  registrationCount: number,
  existingRegistration?: EventRegistration
) {
  const mainMembers = members.filter((member) => member.role === 'main');
  const subMembers = members.filter((member) => member.role === 'sub');
  const registrationState = eventRegistrationState(event, registrationCount);
  if (existingRegistration) {
    return `<p><a href="/events">← Back to events</a></p><section class="card"><h2>${escapeHtml(team.name)} is already registered</h2><p>Your team has already been added to this event.</p><p><a class="button" href="/events/${encodeURIComponent(event.id)}/registrations">View registered teams</a></p></section>`;
  }
  if (registrationState !== 'open') {
    return `<p><a href="/events">← Back to events</a></p><section class="card"><h2>Registration is ${eventRegistrationStateLabel(registrationState)}</h2><p>This event cannot accept new registrations right now.</p></section>`;
  }

  return `<p><a href="/events">← Back to events</a></p>
    <section class="card">
      <p class="eyebrow">${escapeHtml(team.name)}</p>
      <h2>Select roster for ${escapeHtml(event.title)}</h2>
      <p>Choose the players who will compete from your <strong>Main</strong> role and the substitute players from your <strong>Sub</strong> role.</p>
      <div class="event-meta-grid">
        ${eventMeta('Required main players', String(event.requiredMainPlayers))}
        ${eventMeta('Required substitutes', String(event.requiredSubstitutes))}
        ${eventMeta('Teams registered', `${registrationCount}/${event.teamLimit}`)}
        ${eventMeta('Registration closes', formatDateTime(event.registrationClosesAt))}
      </div>
      <form method="post" action="/events/${encodeURIComponent(event.id)}/register" class="stacked-form">
        <fieldset>
          <legend>Main players</legend>
          ${memberCheckboxList('mainPlayerIds', mainMembers, event.requiredMainPlayers, 'No team members currently have the Main role.')}
        </fieldset>
        <fieldset>
          <legend>Substitute players</legend>
          ${memberCheckboxList('substitutePlayerIds', subMembers, event.requiredSubstitutes, 'No team members currently have the Sub role.')}
        </fieldset>
        <button type="submit">Register team</button>
      </form>
    </section>`;
}

function eventRegistrationsPage(event: Event, details: EventRegistrationDetail[]) {
  return `<p><a href="/events">← Back to events</a></p>
    <section class="card">
      <div class="section-heading-row">
        <div><p class="eyebrow">Registered teams</p><h2>${escapeHtml(event.title)}</h2></div>
        <span class="event-capacity">${details.length}/${event.teamLimit} teams</span>
      </div>
      ${
        details.length
          ? `<div class="management-list">${details.map((detail, index) => eventRegistrationCard(detail, index + 1)).join('')}</div>`
          : '<p>No teams have registered yet.</p>'
      }
    </section>`;
}

function eventRegistrationCard(detail: EventRegistrationDetail, index: number) {
  const memberNames = new Map(detail.members.map((member) => [member.userId, member.displayName]));
  const listNames = (ids: string[]) => ids.map((id) => escapeHtml(memberNames.get(id) ?? id)).join(', ') || 'None selected';
  return `<div class="admin-team-row">
    <div>
      <strong>${index}. ${escapeHtml(detail.team?.name ?? detail.registration.teamId)}</strong><br />
      <small>Registered ${escapeHtml(formatDateTime(detail.registration.createdAt))}</small><br />
      <small>Main: ${listNames(detail.registration.mainPlayerIds)}</small><br />
      <small>Subs: ${listNames(detail.registration.substitutePlayerIds)}</small>
    </div>
  </div>`;
}

function eventManagementPage(events: Event[], counts: Record<string, number>) {
  return `<p><a href="/">← Back to dashboard</a></p>
    <section class="card">
      <h2>Create event</h2>
      ${eventForm('/event-management/events')}
    </section>
    <section class="card">
      <h2>Existing events</h2>
      ${
        events.length
          ? `<div class="management-list">${events.map((event) => managedEventRow(event, counts[event.id] ?? 0)).join('')}</div>`
          : '<p>No events have been created yet.</p>'
      }
    </section>`;
}

function eventEditPage(event: Event, registrationCount: number) {
  return `<p><a href="/event-management">← Back to event management</a></p>
    <section class="card">
      <div class="section-heading-row">
        <div><p class="eyebrow">${registrationCount}/${event.teamLimit} teams registered</p><h2>Edit event</h2></div>
        <a class="button secondary" href="/events/${encodeURIComponent(event.id)}/registrations">View registered teams</a>
      </div>
      ${eventForm(`/event-management/events/${encodeURIComponent(event.id)}`, event)}
    </section>`;
}

function managedEventRow(event: Event, registrationCount: number) {
  return `<div class="admin-team-row">
    <div>
      <strong>${escapeHtml(event.title)}</strong> <span class="pill">${eventStateLabel(eventState(event))}</span><br />
      <small>${escapeHtml(formatDateTime(event.startsAt))} · ${registrationCount}/${event.teamLimit} teams · registration ${escapeHtml(eventRegistrationStateLabel(eventRegistrationState(event, registrationCount)))}</small>
    </div>
    <div class="admin-team-actions">
      <a class="button secondary" href="/events/${encodeURIComponent(event.id)}/registrations">Teams</a>
      <a class="button" href="/event-management/events/${encodeURIComponent(event.id)}/edit">Edit</a>
    </div>
  </div>`;
}

function eventForm(action: string, event?: Event) {
  return `<form method="post" action="${escapeHtml(action)}" class="stacked-form">
    <label>Title <input name="title" required maxlength="120" value="${escapeHtml(event?.title ?? '')}" /></label>
    <label>Description <textarea name="description" required rows="4" maxlength="2000">${escapeHtml(event?.description ?? '')}</textarea></label>
    <div class="form-grid">
      <label>Team registration limit <input name="teamLimit" type="number" min="1" required value="${event?.teamLimit ?? 8}" /></label>
      <label>Main players required <input name="requiredMainPlayers" type="number" min="0" required value="${event?.requiredMainPlayers ?? 5}" /></label>
      <label>Substitutes required <input name="requiredSubstitutes" type="number" min="0" required value="${event?.requiredSubstitutes ?? 0}" /></label>
      <label>Event starts <input name="startsAt" type="datetime-local" required value="${escapeHtml(toDateTimeLocalValue(event?.startsAt))}" /></label>
      <label>Event ends <input name="endsAt" type="datetime-local" required value="${escapeHtml(toDateTimeLocalValue(event?.endsAt))}" /></label>
      <label>Registration opens <input name="registrationOpensAt" type="datetime-local" required value="${escapeHtml(toDateTimeLocalValue(event?.registrationOpensAt))}" /></label>
      <label>Registration closes <input name="registrationClosesAt" type="datetime-local" required value="${escapeHtml(toDateTimeLocalValue(event?.registrationClosesAt))}" /></label>
    </div>
    <button type="submit">${event ? 'Save event' : 'Create event'}</button>
  </form>`;
}

function memberCheckboxList(name: string, members: Awaited<ReturnType<TeamBot['getTeamMemberDetails']>>, requiredCount: number, emptyMessage: string) {
  if (!members.length) return `<p><small>${emptyMessage}</small></p>`;
  return `<p><small>Select at least ${requiredCount}.</small></p><div class="checkbox-list">${members.map((member) => `<label class="checkbox-row"><input type="checkbox" name="${name}" value="${escapeHtml(member.userId)}" /> <span>${escapeHtml(member.displayName)} <small>@${escapeHtml(member.username)}</small></span></label>`).join('')}</div>`;
}

function eventMeta(label: string, value: string) {
  return `<div class="stat-card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function parseEventForm(body: Request['body']): EventFormFields {
  const title = String(body.title ?? '').trim().slice(0, 120);
  const description = String(body.description ?? '').trim().slice(0, 2000);
  const teamLimit = parsePositiveInteger(body.teamLimit, 'Team registration limit', 1);
  const requiredMainPlayers = parsePositiveInteger(body.requiredMainPlayers, 'Main players required', 0);
  const requiredSubstitutes = parsePositiveInteger(body.requiredSubstitutes, 'Substitutes required', 0);
  const startsAt = parseDateTimeInput(body.startsAt, 'Event start date');
  const endsAt = parseDateTimeInput(body.endsAt, 'Event end date');
  const registrationOpensAt = parseDateTimeInput(body.registrationOpensAt, 'Registration open date');
  const registrationClosesAt = parseDateTimeInput(body.registrationClosesAt, 'Registration close date');

  if (!title) throw new Error('Event title is required.');
  if (!description) throw new Error('Event description is required.');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error('Event end date must be after the start date.');
  if (new Date(registrationClosesAt).getTime() <= new Date(registrationOpensAt).getTime()) throw new Error('Registration close date must be after the open date.');

  return { title, description, teamLimit, requiredMainPlayers, requiredSubstitutes, startsAt, endsAt, registrationOpensAt, registrationClosesAt };
}

function parsePositiveInteger(value: unknown, label: string, minimum: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label} must be ${minimum === 0 ? 'zero or greater' : `at least ${minimum}`}.`);
  return number;
}

function parseDateTimeInput(value: unknown, label: string) {
  const raw = String(value ?? '').trim();
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) throw new Error(`${label} is required.`);
  return date.toISOString();
}

function validateEventRegistration(event: Event, members: TeamMember[], mainPlayerIds: string[], substitutePlayerIds: string[], registrationCount: number) {
  const registrationState = eventRegistrationState(event, registrationCount);
  if (registrationState === 'full') throw new Error('This event has reached its team registration limit.');
  if (registrationState === 'not-open') throw new Error('Registration is not open yet for this event.');
  if (registrationState === 'closed') throw new Error('Registration has closed for this event.');

  const mainMemberIds = new Set(members.filter((member) => member.role === 'main').map((member) => member.userId));
  const subMemberIds = new Set(members.filter((member) => member.role === 'sub').map((member) => member.userId));
  const duplicateIds = mainPlayerIds.filter((id) => substitutePlayerIds.includes(id));
  if (duplicateIds.length) throw new Error('A player cannot be selected as both a main player and a substitute.');
  if (mainPlayerIds.length < event.requiredMainPlayers) throw new Error(`This event requires at least ${event.requiredMainPlayers} main player${event.requiredMainPlayers === 1 ? '' : 's'}.`);
  if (substitutePlayerIds.length < event.requiredSubstitutes) throw new Error(`This event requires at least ${event.requiredSubstitutes} substitute${event.requiredSubstitutes === 1 ? '' : 's'}.`);
  if (mainPlayerIds.some((id) => !mainMemberIds.has(id))) throw new Error('Main player selections must come from team members with the Main role.');
  if (substitutePlayerIds.some((id) => !subMemberIds.has(id))) throw new Error('Substitute selections must come from team members with the Sub role.');
}

function eventState(event: Event) {
  const now = Date.now();
  if (now < new Date(event.startsAt).getTime()) return 'upcoming';
  if (now <= new Date(event.endsAt).getTime()) return 'live';
  return 'ended';
}

function eventStateLabel(state: ReturnType<typeof eventState>) {
  return state === 'live' ? 'Live' : state === 'upcoming' ? 'Upcoming' : 'Ended';
}

function eventRegistrationState(event: Event, registrationCount: number) {
  const now = Date.now();
  if (registrationCount >= event.teamLimit) return 'full';
  if (now < new Date(event.registrationOpensAt).getTime()) return 'not-open';
  if (now > new Date(event.registrationClosesAt).getTime()) return 'closed';
  return 'open';
}

function eventRegistrationStateLabel(state: ReturnType<typeof eventRegistrationState>) {
  return ({ open: 'open', full: 'full', 'not-open': 'not open yet', closed: 'closed' } as const)[state];
}

function toDateTimeLocalValue(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

function administratorPage(
  teamSummaries: Array<{ team: Team; memberCount: number }>,
  access: AdministratorAccess,
  roles: Array<{ id: string; name: string; managed: boolean; position: number }>,
  adminRoleId?: string
) {
  return `<p><a href="/">← Back to dashboard</a></p>
    <section class="card">
      <h2>All teams</h2>
      ${
        teamSummaries.length
          ? `<div class="management-list">${teamSummaries.map(({ team, memberCount }) => administratorTeamCard(team, memberCount)).join('')}</div>`
          : '<p>No teams have been created yet.</p>'
      }
    </section>
    ${access.isOwner ? administratorSettingsForm(roles, adminRoleId) : ''}`;
}

function administratorTeamCard(team: Team, memberCount: number) {
  return `<div class="admin-team-row">
    <div>
      <strong>${escapeHtml(team.name)}</strong><br />
      <small>${memberCount} member${memberCount === 1 ? '' : 's'} · owner <code>${escapeHtml(team.ownerId)}</code></small>
    </div>
    <div class="admin-team-actions">
      <a class="button" href="/teams/${encodeURIComponent(team.id)}">Manage</a>
      <form method="post" action="/teams/${encodeURIComponent(team.id)}/delete" onsubmit="return confirm('Delete ${escapeJsString(team.name)}? This cannot be undone.');">
        <button class="danger" type="submit">Delete</button>
      </form>
    </div>
  </div>`;
}

function administratorSettingsForm(roles: Array<{ id: string; name: string; managed: boolean }>, adminRoleId?: string) {
  return `<section class="card">
    <h2>Administrator role</h2>
    <p><small>Select a Discord role that can access this administrator page and manage teams. Only the Discord owner can change this setting.</small></p>
    <form method="post" action="/administrator/settings" class="inline-form">
      <label>Admin role
        <select name="adminRoleId">
          <option value="">No administrator role</option>
          ${roles.map((role) => `<option value="${escapeHtml(role.id)}"${role.id === adminRoleId ? ' selected' : ''}>${escapeHtml(role.name)}${role.managed ? ' (managed)' : ''}</option>`).join('')}
        </select>
      </label>
      <button type="submit">Save settings</button>
    </form>
  </section>`;
}

function developerPage(
  stats: Awaited<ReturnType<TeamBot['getDeveloperStats']>>,
  teamCount: number,
  settings: { botStatus?: BotStatus; activityName?: string; activityType?: BotActivityType },
  logs: CapturedLog[]
) {
  return `<p><a href="/">← Back to dashboard</a></p>
    <section class="card">
      <h2>Bot performance</h2>
      <div class="stat-grid">
        ${statCard('Bot uptime', formatDuration(stats.bot.uptimeMs))}
        ${statCard('Process uptime', formatDuration(stats.process.uptimeMs))}
        ${statCard('Gateway latency', `${stats.bot.websocketPingMs} ms`)}
        ${statCard('Memory RSS', formatBytes(stats.process.memoryRssBytes))}
        ${statCard('Heap used', formatBytes(stats.process.memoryHeapUsedBytes))}
        ${statCard('Node.js', stats.process.nodeVersion)}
      </div>
    </section>

    <section class="card">
      <h2>Discord servers and cache</h2>
      <div class="stat-grid">
        ${statCard('Configured server', stats.guild.name)}
        ${statCard('Server members', String(stats.guild.memberCount))}
        ${statCard('Channels', String(stats.guild.channelCount))}
        ${statCard('Roles', String(stats.guild.roleCount))}
        ${statCard('Managed teams', String(teamCount))}
        ${statCard('Cached guilds', String(stats.cache.guilds))}
        ${statCard('Cached users', String(stats.cache.users))}
        ${statCard('Cached channels', String(stats.cache.channels))}
      </div>
      <p><small>Server ID <code>${escapeHtml(stats.guild.id)}</code> · Owner ID <code>${escapeHtml(stats.guild.ownerId)}</code> · Bot <code>${escapeHtml(stats.bot.tag)}</code> (<code>${escapeHtml(stats.bot.id)}</code>)</small></p>
    </section>

    <section class="card danger-zone">
      <h2>Restart bot connection</h2>
      <p>Reconnects the Discord client and reapplies team role placement and developer presence settings. The website process stays online.</p>
      <form method="post" action="/developer/restart" onsubmit="return confirm('Restart the Discord bot connection now?');">
        <button class="danger" type="submit">Restart bot</button>
      </form>
    </section>

    <section class="card">
      <h2>Bot configuration</h2>
      <p><small>Runtime presence settings are stored in the JSON data file and reapplied whenever the bot starts.</small></p>
      <form method="post" action="/developer/config" class="inline-form">
        <label>Status
          <select name="botStatus">
            ${botStatusOptions(settings.botStatus ?? 'online')}
          </select>
        </label>
        <label>Activity type
          <select name="activityType">
            ${activityTypeOptions(settings.activityType ?? 'Playing')}
          </select>
        </label>
        <label>Activity <input name="activityName" maxlength="128" value="${escapeHtml(settings.activityName ?? '')}" placeholder="Managing teams" /></label>
        <button type="submit">Save configuration</button>
      </form>
      <p><small>Environment-backed values are read-only here: public URL <code>${escapeHtml(config.PUBLIC_URL)}</code>, host <code>${escapeHtml(config.HOST)}</code>, port <code>${config.PORT}</code>, data file <code>${escapeHtml(config.DATA_FILE)}</code>.</small></p>
    </section>

    <section class="card" id="logs">
      <div class="section-heading-row">
        <div>
          <h2>Web logs</h2>
          <p><small>Recent in-memory console output from this Node.js process. Restarting the process clears this buffer.</small></p>
        </div>
        <form method="post" action="/developer/logs/clear" onsubmit="return confirm('Clear the in-memory log buffer?');">
          <button class="secondary" type="submit">Clear logs</button>
        </form>
      </div>
      <div class="log-viewer">${logs.length ? logs.map(logRow).join('') : '<p>No logs captured yet.</p>'}</div>
    </section>`;
}

function statCard(label: string, value: string) {
  return `<div class="stat-card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function logRow(log: CapturedLog) {
  return `<div class="log-row log-${log.level}"><span>${escapeHtml(formatDateTime(log.createdAt))}</span><span>${escapeHtml(log.level.toUpperCase())}</span><pre>${escapeHtml(log.message)}</pre></div>`;
}

function botStatusOptions(selected: BotStatus) {
  return (['online', 'idle', 'dnd', 'invisible'] as BotStatus[])
    .map((status) => `<option value="${status}"${status === selected ? ' selected' : ''}>${status}</option>`)
    .join('');
}

function activityTypeOptions(selected: BotActivityType) {
  return (['Playing', 'Watching', 'Listening', 'Competing'] as BotActivityType[])
    .map((type) => `<option value="${type}"${type === selected ? ' selected' : ''}>${type}</option>`)
    .join('');
}

function parseBotStatus(status: unknown): BotStatus {
  if (status === 'online' || status === 'idle' || status === 'dnd' || status === 'invisible') return status;
  throw new Error('Invalid bot status.');
}

function parseActivityType(activityType: unknown): BotActivityType {
  if (activityType === 'Playing' || activityType === 'Watching' || activityType === 'Listening' || activityType === 'Competing') return activityType;
  throw new Error('Invalid activity type.');
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${seconds}s`].filter(Boolean).join(' ');
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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
  return `<form method="post" action="/teams" onsubmit="const button = this.querySelector('button[type=submit]'); if (button) { button.disabled = true; button.textContent = 'Creating team…'; }">
    <label>Team name <input name="teamName" maxlength="80" required /></label>
    ${invitePicker('Create team', 'You can invite server members now, or create the team first and invite members later from the manage team page.')}
  </form>
  ${inviteSearchScript()}`;
}

function teamCreatedInviteMessage(inviteCount: number) {
  if (inviteCount === 0) return 'No invite DMs were queued. You can invite members from the manage team page when you are ready.';
  return `${inviteCount} invite DM${inviteCount === 1 ? '' : 's'} queued.`;
}

function invitePicker(submitLabel: string, description = 'Search by Discord username or server nickname. Only server members who are not already in a team can be invited.') {
  return `<h2>Invite server members</h2>
    <p><small>${escapeHtml(description)}</small></p>
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
  members: Array<{ userId: string; role: TeamMemberRole; displayName: string; username: string; avatarUrl: string; isOwner: boolean }>,
  invites: Array<TeamInvite & { displayName: string; username: string; avatarUrl: string }>,
  canManageAllTeams = false
) {
  return `<p><a href="${canManageAllTeams ? '/administrator' : '/'}">← Back to ${canManageAllTeams ? 'administrator' : 'dashboard'}</a></p>
    <section class="card">
      <h2>Team name</h2>
      <p><small>Rename the Discord role and private team channels for this team.</small></p>
      <form method="post" action="/teams/${encodeURIComponent(team.id)}/name" class="inline-form">
        <label>Team name <input name="teamName" maxlength="80" value="${escapeHtml(team.name)}" required /></label>
        <button type="submit">Change name</button>
      </form>
    </section>

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
      <h2>Pending invites</h2>
      ${pendingInvitesSection(invites)}
    </section>

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


function pendingInvitesSection(invites: Array<TeamInvite & { displayName: string; username: string; avatarUrl: string }>) {
  const pendingInvites = invites.filter((invite) => invite.status === 'pending');
  if (!pendingInvites.length) return '<p>No pending invites right now.</p>';

  return `<p><small>These Discord members have been sent an invite and have not responded yet.</small></p>
    <div class="management-list">
      ${pendingInvites.map((invite) => pendingInvite(invite)).join('')}
    </div>`;
}

function pendingInvite(invite: TeamInvite & { displayName: string; username: string; avatarUrl: string }) {
  return `<div class="managed-member">
    ${invite.avatarUrl ? `<img src="${escapeHtml(invite.avatarUrl)}" alt="" />` : '<span class="avatar-placeholder"></span>'}
    <div class="member-info">
      <strong>${escapeHtml(invite.displayName)}</strong> <span class="pill">pending</span><br />
      <small>@${escapeHtml(invite.username)} · invited ${escapeHtml(formatDateTime(invite.createdAt))}</small>
    </div>
  </div>`;
}

function managedMember(
  team: Team,
  member: { userId: string; role: TeamMemberRole; displayName: string; username: string; avatarUrl: string; isOwner: boolean }
) {
  return `<div class="managed-member">
    ${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="" />` : '<span class="avatar-placeholder"></span>'}
    <div class="member-info">
      <strong>${escapeHtml(member.displayName)}</strong> ${member.isOwner ? '<span class="pill">captain</span>' : ''}<br />
      <small>@${escapeHtml(member.username)}</small>
    </div>
    ${
      member.isOwner
        ? `<span class="role-label">${teamRoleLabel(member.role)}</span>`
        : `<form method="post" action="/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.userId)}/role" class="inline-form">
             <select name="role" aria-label="Team role for ${escapeHtml(member.displayName)}">
               ${teamRoleOptions(member.role)}
             </select>
             <button type="submit">Save role</button>
           </form>
           <form method="post" action="/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.userId)}/transfer-ownership" onsubmit="return confirm('Transfer captain ownership of ${escapeJsString(team.name)} to ${escapeJsString(member.displayName)}? This will make them the team owner.');">
             <button class="secondary" type="submit">Make captain</button>
           </form>
           <form method="post" action="/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.userId)}/kick" onsubmit="return confirm('Kick ${escapeJsString(member.displayName)} from ${escapeJsString(team.name)}?');">
             <button class="danger" type="submit">Kick</button>
           </form>`
    }
  </div>`;
}

function teamRoleOptions(selected: TeamMemberRole) {
  return (['sub', 'main', 'coach'] as TeamMemberRole[])
    .map((role) => `<option value="${role}"${role === selected ? ' selected' : ''}>${teamRoleLabel(role)}</option>`)
    .join('');
}

function teamRoleLabel(role: TeamMemberRole) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function parseTeamMemberRole(role: unknown): TeamMemberRole {
  if (role === 'sub' || role === 'main' || role === 'coach') return role;
  throw new Error('Invalid team member role.');
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function layout(title: string, body: string, options: LayoutOptions = {}) {
  const nav = navigation(options);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · 7th Circle Team Hub</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <style>
    :root { color-scheme: dark; --bg: #0b0c0f; --panel: #17191f; --panel-strong: #20232b; --muted: #a8b0bd; --text: #f4f6fb; --line: #30343d; --red: #c90820; --red-strong: #ef233c; --red-soft: rgba(201, 8, 32, .16); --shadow: 0 24px 70px rgba(0, 0, 0, .45); }
    * { box-sizing: border-box; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(201, 8, 32, .18), transparent 32rem), linear-gradient(135deg, #101116 0%, var(--bg) 52%, #050506 100%); color: var(--text); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px); background-size: 44px 44px; mask-image: linear-gradient(to bottom, rgba(0,0,0,.8), transparent 75%); }
    a { color: #ff6b7a; text-decoration: none; } a:hover { color: #ff8f9a; }
    .topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .85rem clamp(1rem, 4vw, 3rem); border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(11, 12, 15, .82); backdrop-filter: blur(18px); }
    .brand { display: inline-flex; align-items: center; gap: .75rem; color: var(--text); font-weight: 800; letter-spacing: .02em; }
    .brand-mark { width: 2.35rem; height: 2.35rem; border-radius: .8rem; box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 10px 30px rgba(201,8,32,.24); }
    .nav-shell { display: flex; align-items: center; gap: 1rem; flex: 1; justify-content: space-between; }
    .nav-groups { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex: 1; }
    .nav-links { display: flex; align-items: center; gap: .35rem; padding: .25rem; border: 1px solid rgba(255,255,255,.08); border-radius: 999px; background: rgba(255,255,255,.035); }
    .nav-links a { color: var(--muted); padding: .55rem .9rem; border-radius: 999px; font-size: .94rem; font-weight: 700; }
    .nav-links a.active, .nav-links a:hover { color: var(--text); background: var(--red-soft); box-shadow: inset 0 0 0 1px rgba(239,35,60,.28); }
    .account-link { display: inline-flex; align-items: center; gap: .6rem; color: var(--text); padding: .35rem .75rem .35rem .35rem; border: 1px solid rgba(255,255,255,.08); border-radius: 999px; background: rgba(255,255,255,.045); font-weight: 700; }
    .account-link.active, .account-link:hover { background: var(--red-soft); box-shadow: inset 0 0 0 1px rgba(239,35,60,.26); color: var(--text); }
    .account-link img { width: 2rem; height: 2rem; border-radius: 999px; border: 2px solid rgba(239,35,60,.65); object-fit: cover; }
    main { width: min(1060px, calc(100% - 2rem)); margin: 0 auto; padding: 3rem 0 4rem; }
    .page-header { margin-bottom: 1.5rem; } h1 { margin: 0; font-size: clamp(2rem, 5vw, 4.25rem); letter-spacing: -.06em; line-height: .95; } h2 { margin-top: 0; letter-spacing: -.03em; } .page-intro { color: var(--muted); }
    .hero-card { position: relative; overflow: hidden; padding: clamp(1.5rem, 5vw, 4rem); border: 1px solid rgba(239,35,60,.28); border-radius: 1.5rem; background: linear-gradient(145deg, rgba(32,35,43,.94), rgba(12,13,17,.96)); box-shadow: var(--shadow); }
    .hero-card::after { content: "7"; position: absolute; right: clamp(1rem, 7vw, 5rem); bottom: -2.5rem; color: rgba(201,8,32,.18); font-size: clamp(10rem, 28vw, 20rem); font-weight: 950; line-height: .8; }
    .hero-card h2 { max-width: 720px; margin: .25rem 0 1rem; font-size: clamp(2.25rem, 7vw, 5.5rem); line-height: .9; }
    .eyebrow { margin: 0 0 .75rem; color: var(--red-strong); text-transform: uppercase; letter-spacing: .16em; font-size: .78rem; font-weight: 900; }
    .button, button { background: linear-gradient(135deg, var(--red), #8f0617); color: white; border: 0; border-radius: .8rem; padding: .78rem 1rem; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .4rem; font-weight: 800; box-shadow: 0 12px 30px rgba(201,8,32,.22); }
    button:hover, .button:hover { transform: translateY(-1px); color: white; }
    .secondary { background: #2b2f38; box-shadow: none; } .danger { background: linear-gradient(135deg, #ef233c, #9f0719); } .danger-zone { border-color: rgba(239,35,60,.45); }
    input, select, textarea { border-radius: .7rem; border: 1px solid var(--line); padding: .68rem .78rem; margin-left: .5rem; background: #0f1116; color: var(--text); outline: none; }
    textarea { min-height: 8rem; resize: vertical; }
    input:focus, select:focus, textarea:focus { border-color: var(--red-strong); box-shadow: 0 0 0 3px rgba(239,35,60,.18); }
    input[type="color"] { width: 4rem; height: 2.6rem; padding: .2rem; vertical-align: middle; }
    .card { background: linear-gradient(180deg, rgba(32,35,43,.96), rgba(23,25,31,.96)); border: 1px solid rgba(255,255,255,.08); border-radius: 1.1rem; padding: 1.15rem; margin: 1rem 0; box-shadow: 0 18px 45px rgba(0,0,0,.24); }
    .member-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .member, .managed-member { display: flex; align-items: center; gap: .75rem; background: #12141a; border: 1px solid var(--line); border-radius: 1rem; padding: .8rem; }
    .member-result { width: 100%; text-align: left; color: var(--text); box-shadow: none; }
    .member-result:hover { border-color: var(--red-strong); }
    .invite-search { display: grid; gap: .4rem; margin: 1rem 0; }
    .invite-search input { margin-left: 0; max-width: 28rem; }
    .selected-members { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 1rem 0; }
    .selected-members h3 { flex-basis: 100%; margin: 0; }
    .selected-member { display: inline-flex; align-items: center; gap: .4rem; background: var(--red-soft); border: 1px solid rgba(239,35,60,.24); border-radius: 999px; padding: .35rem .45rem .35rem .75rem; }
    .selected-member button { border-radius: 999px; padding: .1rem .45rem; background: #3a1017; box-shadow: none; }
    .managed-member { flex-wrap: wrap; justify-content: space-between; }
    .management-list, .event-list { display: grid; gap: .75rem; }
    .event-card { border-color: rgba(239,35,60,.2); }
    .event-actions { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-top: 1rem; }
    .event-capacity { border: 1px solid rgba(239,35,60,.32); border-radius: 999px; padding: .35rem .7rem; background: var(--red-soft); color: #ffd4d9; font-weight: 900; }
    .event-meta-grid, .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .stacked-form { display: grid; gap: 1rem; }
    .stacked-form label { display: grid; gap: .35rem; font-weight: 800; }
    .stacked-form input, .stacked-form select, .stacked-form textarea { margin-left: 0; width: 100%; }
    fieldset { border: 1px solid var(--line); border-radius: 1rem; padding: 1rem; }
    legend { padding: 0 .35rem; font-weight: 900; }
    .checkbox-list { display: grid; gap: .5rem; }
    .checkbox-row { display: flex; align-items: center; gap: .6rem; background: #12141a; border: 1px solid var(--line); border-radius: .85rem; padding: .7rem; }
    .checkbox-row input { width: auto; margin: 0; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
    .stat-card { background: #12141a; border: 1px solid var(--line); border-radius: 1rem; padding: .9rem; }
    .stat-card strong { display: block; margin-top: .25rem; font-size: 1.25rem; }
    .section-heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .log-viewer { display: grid; gap: .5rem; max-height: 38rem; overflow: auto; border: 1px solid var(--line); border-radius: 1rem; padding: .75rem; background: #0f1116; }
    .log-row { display: grid; grid-template-columns: 12rem 4.5rem minmax(0, 1fr); gap: .75rem; align-items: start; border-bottom: 1px solid rgba(255,255,255,.06); padding-bottom: .5rem; }
    .log-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .log-row span { color: var(--muted); font-size: .78rem; font-weight: 800; }
    .log-row pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .log-error span:nth-child(2) { color: #ff8f9a; }
    .log-warn span:nth-child(2) { color: #ffd166; }
    .admin-team-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; background: #12141a; border: 1px solid var(--line); border-radius: 1rem; padding: .9rem; flex-wrap: wrap; }
    .admin-team-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .member-info { flex: 1 1 12rem; }
    .member img, .managed-member img, .avatar-placeholder { width: 38px; height: 38px; border-radius: 999px; background: #2b2f38; object-fit: cover; }
    .profile-card { display: flex; align-items: center; gap: 1.25rem; }
    .profile-avatar { width: 96px; height: 96px; border-radius: 1.25rem; border: 2px solid rgba(239,35,60,.7); object-fit: cover; }
    .inline-form { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .pill, .role-label { display: inline-block; margin-left: .35rem; padding: .16rem .5rem; border-radius: 999px; background: var(--red-soft); color: #ffb3bc; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
    small { color: var(--muted); } code { background: #0f1116; border: 1px solid var(--line); border-radius: .35rem; padding: .15rem .35rem; color: #ffd4d9; }
    @media (max-width: 720px) { .log-row { grid-template-columns: 1fr; } .topbar { align-items: stretch; flex-direction: column; } .nav-shell, .nav-groups { align-items: stretch; flex-direction: column; justify-content: space-between; } .nav-links { overflow-x: auto; border-radius: .9rem; } .account-link span { display: none; } main { padding-top: 2rem; } .profile-card { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>${nav}<main><header class="page-header"><h1>${escapeHtml(title)}</h1></header>${body}</main></body>
</html>`;
}

function navigation(options: LayoutOptions) {
  const activeClass = (key: LayoutOptions['active']) => options.active === key ? ' class="active"' : '';
  const eventManagementLink = options.user && options.isAdmin ? `<a href="/event-management"${activeClass('event-management')}>Event management</a>` : '';
  const adminLink = options.user && options.isAdmin ? `<a href="/administrator"${activeClass('administrator')}>Administrator</a>` : '';
  const developerLink = options.user && (options.isDeveloper || isDeveloperUser(options.user)) ? `<a href="/developer"${activeClass('developer')}>Developer</a>` : '';
  const userControls = options.user
    ? `<a class="account-link${options.active === 'settings' ? ' active' : ''}" href="/settings" title="Open account settings"><img src="${escapeHtml(discordAvatarUrl(options.user))}" alt="" /><span>${escapeHtml(displayUser(options.user))}</span></a>`
    : '<a class="button" href="/auth/discord">Log in</a>';

  return `<header class="topbar">
    <a class="brand" href="/"><img class="brand-mark" src="/favicon.svg" alt="" /><span>7th Circle Team Hub</span></a>
    <div class="nav-shell">
      <div class="nav-groups">
        <nav class="nav-links" aria-label="Primary navigation">
          <a href="/"${activeClass('dashboard')}>Dashboard</a>
          ${options.user ? `<a href="/events"${activeClass('events')}>Events</a>` : ''}
          ${options.user ? `<a href="/teams/new"${activeClass('teams')}>Create team</a>` : ''}
        </nav>
        ${(eventManagementLink || adminLink || developerLink) ? `<nav class="nav-links" aria-label="Administration navigation">${eventManagementLink}${adminLink}${developerLink}</nav>` : ''}
      </div>
      ${userControls}
    </div>
  </header>`;
}

function discordAvatarUrl(user: DiscordUser, size = 64) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png?size=${size}`;
  const fallbackIndex = Number(user.discriminator ?? '0') % 5;
  return `https://cdn.discordapp.com/embed/avatars/${fallbackIndex}.png`;
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
