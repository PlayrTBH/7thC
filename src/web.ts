import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { config, DEVELOPER_DISCORD_USER_ID, discordRedirectUri } from './config.js';
import type { TeamBotApi } from './bot.js';
import type { JsonStore } from './store.js';
import { clearLogs, getRecentLogs, type CapturedLog } from './logger.js';
import { JsonSessionStore } from './session-store.js';
import type { BotActivityType, BotStatus, DiscordUser, Event, EventRegistration, Team, TeamInvite, TeamMember, TeamMemberRole, PugEloRating, PugEloSettings, PugMatchLog, PugRankDefinition, PugRankSettings, PugSeason, PugSeasonBadgeReward, PugSeasonLeaderboardEntry, PugSettings, PugUserBadge } from './types.js';

declare module 'express-session' {
  interface SessionData {
    discordUser?: DiscordUser;
    oauthState?: string;
  }
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const requestLayoutContext = new AsyncLocalStorage<{ currentTeam?: Team }>();

type AdminPugEloPreviewPlayer = { userId: string; username?: string; rating: number; first: number; second?: number; loss: number };
type AdminPugEloPreviewTeam = { teamIndex: number; total: number; average: number; players: AdminPugEloPreviewPlayer[] };
type AdminPugMatchLog = PugMatchLog & { eloPreview?: AdminPugEloPreviewTeam[] };
type PugPlayerSearchEntry = { userId: string; username?: string; rating: number; updatedAt?: string };
type PugPlayerModeStats = { mode: PugMatchLog['size'] | 'unknown' | 'all'; label: string; wins: number; seconds: number; losses: number; total: number; winRate: number };
type PugPlayerRank = PugRankDefinition & { isMaster?: boolean };
type PugPlayerStats = { player: PugPlayerSearchEntry; modes: PugPlayerModeStats[]; totals: PugPlayerModeStats; rank: PugPlayerRank };
type PugPlayerSearchState = { query: string; selectedPlayerId?: string; players: PugPlayerSearchEntry[]; matches: PugPlayerSearchEntry[]; selected?: PugPlayerStats };
type LeaderboardPlayerSearchState = { query: string; players: PugPlayerSearchEntry[]; matches: PugPlayerSearchEntry[] };

export function createWebApp(bot: TeamBotApi, store: JsonStore) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false, limit: '6mb' }));
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

  app.use(async (req, _res, next) => {
    try {
      const currentTeam = req.session.discordUser ? await store.getTeamForUser(req.session.discordUser.id) : undefined;
      requestLayoutContext.run({ currentTeam }, () => next());
    } catch (error) {
      next(error);
    }
  });

  app.get('/', async (req, res, next) => {
    try {
      const user = req.session.discordUser;
      if (!user) {
        const inviteUrl = await bot.getGuildInviteUrl();
        res.send(layout('7th Circle', homePage(inviteUrl)));
        return;
      }

      res.redirect('/leaderboard');
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
      req.session.discordUser = user;
      delete req.session.oauthState;
      res.redirect(member ? '/leaderboard' : '/join-discord');
    } catch (error) {
      next(error);
    }
  });


  app.get('/join-discord', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [inviteUrl, member, administratorAccess] = await Promise.all([
        bot.getGuildInviteUrl(),
        bot.getGuildMember(user.id),
        bot.getAdministratorAccess(user.id),
        store.getPugSeasons(),
        store.getPugRankSettings()
      ]);
      if (member) {
        res.redirect('/leaderboard');
        return;
      }
      res.status(403).send(layout('Join the Discord', joinDiscordPage(inviteUrl), { user, isAdmin: administratorAccess.isAdmin }));
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
      const [administratorAccess, badges, selectedBadgeIds] = await Promise.all([
        bot.getAdministratorAccess(user.id),
        store.getPugUserBadges(user.id),
        store.getPugUserBadgeSelection(user.id)
      ]);
      res.send(layout('Account settings', settingsPage(user, badges, selectedBadgeIds), { user, isAdmin: administratorAccess.isAdmin, active: 'settings' }));
    } catch (error) {
      next(error);
    }
  });


  app.post('/settings/badges', requireAuth, async (req, res, next) => {
    try {
      await store.setPugUserBadgeSelection(req.session.discordUser!.id, formArray(req.body.badgeIds));
      res.redirect('/settings#badges');
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
        bot.getAdministratorAccess(user.id),
        store.getPugSeasons(),
        store.getPugRankSettings()
      ]);
      const userRegisteredEventIds = new Set(
        currentTeam
          ? (await Promise.all(events.map((event) => store.getEventRegistration(event.id, currentTeam.id)))).filter(Boolean).map((registration) => registration!.eventId)
          : []
      );
      res.send(layout('Events', eventsPage(events, counts, currentTeam, user.id, userRegisteredEventIds), { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
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
      const existingRegistration = await store.getEventRegistration(event.id, team.id);
      const registrationCount = (await store.getEventRegistrations(event.id)).length;
      validateEventRegistration(event, members, mainPlayerIds, substitutePlayerIds, registrationCount, Boolean(existingRegistration));

      const now = new Date().toISOString();
      if (existingRegistration) {
        await store.updateEventRegistration(event.id, team.id, { captainId: user.id, mainPlayerIds, substitutePlayerIds });
      } else {
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
      }
      res.redirect(`/events/${encodeURIComponent(event.id)}/registrations`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/events/:eventId/register/delete', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [event, team] = await Promise.all([store.getEvent(req.params.eventId), store.getTeamForUser(user.id)]);
      if (!event) throw new Error('Event not found.');
      if (!team || team.ownerId !== user.id) throw new Error('Only a team captain can remove a team registration.');
      if (!isRegistrationWindowOpen(event)) throw new Error('Registration changes are closed for this event.');
      await store.removeEventRegistration(event.id, team.id);
      res.redirect('/events');
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
      res.send(layout(`${event.title} registrations`, eventRegistrationsPage(event, details, administratorAccess.isAdmin), { user, isAdmin: administratorAccess.isAdmin, active: 'events' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/events/:eventId/registrations/:teamId/delete', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const event = await store.getEvent(req.params.eventId);
      if (!event) throw new Error('Event not found.');
      await store.removeEventRegistration(event.id, req.params.teamId);
      res.redirect(`/events/${encodeURIComponent(event.id)}/registrations`);
    } catch (error) {
      next(error);
    }
  });

  app.get('/leaderboard', requireAuth, async (req, res, next) => {
    try {
      const [leaderboard, ownRating, administratorAccess, rankSettings, allRatings, history, eloSettings, activeSeason, seasonLeaderboards] = await Promise.all([
        store.getPugEloLeaderboard(10),
        store.getPugEloRating(req.session.discordUser!.id),
        bot.getAdministratorAccess(req.session.discordUser!.id),
        store.getPugRankSettings(),
        store.getPugEloRatings(),
        store.getPugMatchLogs(),
        store.getPugEloSettings(),
        store.getActivePugSeason(),
        store.getPugSeasonLeaderboards()
      ]);
      const topMasterUserIds = new Set(allRatings.slice(0, 3).map((rating) => rating.userId));
      const memberProfiles = await bot.getGuildMemberProfiles(leaderboard.map((rating) => rating.userId));
      const profilesByUserId = new Map(memberProfiles.map((profile) => [profile.userId, profile]));
      const decoratedLeaderboard = leaderboard.map((rating) => {
        const profile = profilesByUserId.get(rating.userId);
        const displayName = profile?.displayName ?? rating.username ?? 'Unknown Discord user';
        const username = profile?.username ?? (rating.username && rating.username !== displayName ? rating.username : undefined);
        return { ...rating, displayName, username, avatarUrl: profile?.avatarUrl ?? '', rank: resolvePugRank(rating, rankSettings, topMasterUserIds) };
      });
      const playerSearch = buildLeaderboardPlayerSearchState(history, allRatings, eloSettings, leaderboard.map((rating) => rating.userId), String(req.query.q ?? ''));
      res.send(layout('7th Circle Leaderboard', leaderboardPage(decoratedLeaderboard, ownRating, resolvePugRank(ownRating, rankSettings, topMasterUserIds), playerSearch, activeSeason, seasonLeaderboards), { user: req.session.discordUser, isAdmin: administratorAccess.isAdmin, active: 'leaderboard' }));
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

  app.post('/event-management/events/:eventId/delete', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      await store.removeEvent(req.params.eventId);
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
      res.send(layout('Administrator', administratorPage(teamSummaries, access, roles, settings.adminRoleId, settings.pugs), { user: req.session.discordUser, isAdmin: true, active: 'administrator' }));
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

  app.post('/administrator/pugs', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const existing = (await store.getAdministratorSettings()).pugs;
      const existingElo = await store.getPugEloSettings();
      const pugs: PugSettings = {
        queueChannelId: String(req.body.queueChannelId ?? '').trim() || undefined,
        queueMessageId: existing?.queueMessageId,
        mapPool: String(req.body.mapPool ?? '')
          .split(/\r?\n|,/)
          .map((map) => map.trim())
          .filter(Boolean),
        elo: {
          ...existingElo,
          finalRoundMultiplier: parseDecimalInRange(req.body.finalRoundMultiplier, 'Final Round ELO value', 0, 5),
          cashoutMultiplier: parseDecimalInRange(req.body.cashoutMultiplier, 'Cashout ELO value', 0, 5)
        },
        ranks: existing?.ranks,
        seasons: existing?.seasons
      };
      await store.updatePugSettings(pugs);
      res.redirect('/administrator#pugs');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/publish', requireAuth, requireGuildAdministrator(bot), async (_req, res, next) => {
    try {
      await bot.publishPugQueueMessage();
      res.redirect('/administrator#pugs');
    } catch (error) {
      next(error);
    }
  });

  app.get('/administrator/pugs', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const [state, ratings, eloSettings] = await Promise.all([bot.getPugAdminState(), store.getPugEloRatings(), store.getPugEloSettings()]);
      const activeMatches = state.activeMatches.map((match) => addAdminPugEloPreview(match, ratings, eloSettings));
      const playerSearch = buildPugPlayerSearchState(state.history, ratings, eloSettings, String(req.query.q ?? ''), String(req.query.playerId ?? ''));
      res.send(layout('PUG administration', administratorPugsPage(activeMatches, state.history, ratings, eloSettings, playerSearch), { user: req.session.discordUser, isAdmin: true, active: 'administrator' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/:matchId/delete', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      await bot.deletePugMatch(req.params.matchId);
      res.redirect('/administrator/pugs');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/:matchId/rollback', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      await bot.rollbackPugMatch(req.params.matchId);
      res.redirect('/administrator/pugs');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/:matchId/reset', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      await bot.resetPugMatch(req.params.matchId);
      res.redirect('/administrator/pugs');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/:matchId/teams', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      await bot.forcePugTeams(req.params.matchId, parsePugTeams(String(req.body.teams ?? '')));
      res.redirect('/administrator/pugs');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/:matchId/captains', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      await bot.forcePugCaptains(req.params.matchId, parseDiscordIds(String(req.body.captainIds ?? '')));
      res.redirect('/administrator/pugs');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/elo/settings', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const existing = (await store.getAdministratorSettings()).pugs;
      const elo = parsePugEloSettings(req.body);
      await store.updatePugSettings({ queueChannelId: existing?.queueChannelId, queueMessageId: existing?.queueMessageId, mapPool: existing?.mapPool ?? [], elo, ranks: existing?.ranks, seasons: existing?.seasons });
      res.redirect('/administrator/pugs#elo');
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/elo/player', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const userId = parseRequiredDiscordId(String(req.body.userId ?? ''));
      await store.setPugEloRating(userId, parsePositiveInteger(req.body.rating, 'ELO rating', 0), String(req.body.username ?? '').trim() || undefined);
      res.redirect(`/administrator/pugs?playerId=${encodeURIComponent(userId)}#elo`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/elo/player/reset', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const userId = parseRequiredDiscordId(String(req.body.userId ?? ''));
      await store.resetPugEloRating(userId);
      res.redirect(`/administrator/pugs?playerId=${encodeURIComponent(userId)}#elo`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/pugs/elo/reset-all', requireAuth, requireGuildAdministrator(bot), async (_req, res, next) => {
    try {
      await store.resetAllPugEloRatings();
      res.redirect('/administrator/pugs#elo');
    } catch (error) {
      next(error);
    }
  });

  app.get('/administrator/ranks', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const settings = await store.getPugRankSettings();
      res.send(layout('Rank administration', administratorRanksPage(settings), { user: req.session.discordUser, isAdmin: true, active: 'administrator' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/administrator/ranks', requireAuth, requireGuildAdministrator(bot), async (req, res, next) => {
    try {
      const existing = (await store.getAdministratorSettings()).pugs;
      const ranks = parsePugRankSettings(req.body);
      await store.updatePugSettings({ queueChannelId: existing?.queueChannelId, queueMessageId: existing?.queueMessageId, mapPool: existing?.mapPool ?? [], elo: existing?.elo, ranks, seasons: existing?.seasons });
      res.redirect('/administrator/ranks');
    } catch (error) {
      next(error);
    }
  });

  app.get('/leaderboard/players/:userId', requireAuth, async (req, res, next) => {
    try {
      const userId = parseRequiredDiscordId(req.params.userId);
      const [history, ratings, eloSettings, rankSettings, profiles, administratorAccess, badges, selectedBadgeIds] = await Promise.all([
        store.getPugMatchLogs(),
        store.getPugEloRatings(),
        store.getPugEloSettings(),
        store.getPugRankSettings(),
        bot.getGuildMemberProfiles([userId]),
        bot.getAdministratorAccess(req.session.discordUser!.id),
        store.getPugUserBadges(userId),
        store.getPugUserBadgeSelection(userId)
      ]);
      const players = buildPugPlayerSearchEntries(history, ratings, eloSettings);
      const stats = buildPugPlayerStats(userId, players, history, ratings, eloSettings, rankSettings, new Set(ratings.slice(0, 3).map((rating) => rating.userId)));
      const profile = profiles[0];
      res.send(layout(`${profile?.displayName ?? stats.player.username ?? 'Player'} profile`, leaderboardPlayerProfilePage(stats, profile, badges, selectedBadgeIds), { user: req.session.discordUser, isAdmin: administratorAccess.isAdmin, active: 'leaderboard' }));
    } catch (error) {
      next(error);
    }
  });


  app.get('/developer', requireAuth, requireDeveloper, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [stats, teams, settings, administratorAccess, seasons, rankSettings] = await Promise.all([
        bot.getDeveloperStats(),
        store.getTeams(),
        store.getDeveloperSettings(),
        bot.getAdministratorAccess(user.id),
        store.getPugSeasons(),
        store.getPugRankSettings()
      ]);
      const logs = getRecentLogs(250);
      res.send(layout('Developer panel', developerPage(stats, teams.length, settings, logs, seasons, rankSettings), { user, isAdmin: administratorAccess.isAdmin, isDeveloper: true, active: 'developer' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/developer/seasons/config', requireAuth, requireDeveloper, async (req, res, next) => {
    try {
      const seasonId = String(req.body.seasonId ?? '').trim();
      const label = String(req.body.label ?? '').trim().slice(0, 32) || seasonId.toUpperCase();
      const endsAt = parseOptionalDateTime(req.body.endsAt);
      const badgeRewards = parsePugSeasonBadgeRewards(req.body);
      await store.updatePugSeason(seasonId, { label, endsAt, badgeRewards });
      res.redirect('/developer#seasons');
    } catch (error) {
      next(error);
    }
  });

  app.post('/developer/seasons/end', requireAuth, requireDeveloper, async (req, res, next) => {
    try {
      await store.endActivePugSeason(String(req.body.nextSeasonLabel ?? '').trim() || undefined);
      res.redirect('/developer#seasons');
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

  app.get('/members/search', requireAuth, requireGuildMembership(bot), async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const members = await bot.searchInvitableMembers(user.id, query);
      res.json({ members });
    } catch (error) {
      next(error);
    }
  });

  app.get('/team', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [currentTeam, administratorAccess] = await Promise.all([
        store.getTeamForUser(user.id),
        bot.getAdministratorAccess(user.id)
      ]);
      if (!currentTeam) {
        res.redirect('/teams/new');
        return;
      }

      const [members, teamRegistrations, events] = await Promise.all([
        bot.getTeamMemberDetails(currentTeam.id),
        store.getEventRegistrationsForTeam(currentTeam.id),
        store.getEvents()
      ]);
      const eventsById = new Map(events.map((event) => [event.id, event]));
      const registrationDetails = teamRegistrations
        .map((registration) => ({ registration, event: eventsById.get(registration.eventId) }))
        .filter((detail): detail is TeamPageRegistrationDetail => Boolean(detail.event))
        .sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt) || a.event.title.localeCompare(b.event.title));

      res.send(layout('Team', teamPageSection(currentTeam, user.id, members, registrationDetails), { user, isAdmin: administratorAccess.isAdmin, currentTeam, active: 'teams' }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/teams/new', requireAuth, requireGuildMembership(bot), async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      const [currentTeam, administratorAccess] = await Promise.all([
        store.getTeamForUser(user.id),
        bot.getAdministratorAccess(user.id)
      ]);
      if (currentTeam) {
        res.status(400).send(layout('Already in a team', `<p>You are already in <strong>${escapeHtml(currentTeam.name)}</strong>. Leave or delete your current team before creating another one.</p><p><a class="button" href="/events">Back to events</a></p>`, { user, isAdmin: administratorAccess.isAdmin, currentTeam, active: 'teams' }));
        return;
      }

      res.send(layout('Create Team', teamForm(), { user, isAdmin: administratorAccess.isAdmin, active: 'teams' }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams', requireAuth, requireGuildMembership(bot), async (req, res, next) => {
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
           <p><a class="button" href="/teams/${encodeURIComponent(team.id)}">Manage Team</a> <a class="button secondary" href="/events">Back to events</a></p>`,
          { user, isAdmin: administratorAccess.isAdmin, currentTeam: team, active: 'teams' }
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
      res.redirect(res.locals.canManageAllTeams ? '/administrator' : '/events');
    } catch (error) {
      next(error);
    }
  });

  app.post('/teams/leave', requireAuth, async (req, res, next) => {
    try {
      const user = req.session.discordUser!;
      await bot.leaveTeam(user.id);
      res.redirect('/events');
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
type LayoutOptions = { user?: DiscordUser; isAdmin?: boolean; isDeveloper?: boolean; currentTeam?: Team; active?: 'events' | 'teams' | 'leaderboard' | 'event-management' | 'administrator' | 'settings' | 'developer' };

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

function requireGuildAdministrator(bot: TeamBotApi) {
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

function requireGuildOwner(bot: TeamBotApi) {
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


function requireGuildMembership(bot: TeamBotApi) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.discordUser!;
      const member = await bot.getGuildMember(user.id);
      if (!member) {
        const [inviteUrl, administratorAccess] = await Promise.all([
          bot.getGuildInviteUrl(),
          bot.getAdministratorAccess(user.id)
        ]);
        res.status(403).send(layout('Join the Discord', joinDiscordPage(inviteUrl), { user, isAdmin: administratorAccess.isAdmin }));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireTeamManager(bot: TeamBotApi, store: JsonStore) {
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


function homePage(inviteUrl: string) {
  return `<section class="hero-card home-hero">
      <div>
        <p class="eyebrow">7th Circle</p>
        <h2>Team hub for the 7th Circle Discord</h2>
        <p>Join the server, log in with Discord, create your team, invite teammates, and register for events from one place.</p>
        <div class="hero-actions">
          <a class="button discord-button" href="${escapeHtml(inviteUrl)}" target="_blank" rel="noopener noreferrer">Join Discord</a>
          <a class="button secondary" href="/auth/discord">Log in with Discord</a>
        </div>
      </div>
      <div class="discord-panel" aria-hidden="true">
        <span class="discord-icon">☾</span>
        <strong>Discord required</strong>
        <small>Membership unlocks team creation and private channels.</small>
      </div>
    </section>`;
}

function joinDiscordPage(inviteUrl: string) {
  return `<section class="hero-card join-card">
      <p class="eyebrow">Discord membership required</p>
      <h2>Join the 7th Circle Discord to continue</h2>
      <p>Your website login is connected, but this Discord account is not in the server yet. Join the server, then return here to refresh your access before creating a team.</p>
      <div class="hero-actions">
        <a class="button discord-button" href="${escapeHtml(inviteUrl)}" target="_blank" rel="noopener noreferrer">Join Discord</a>
        <a class="button secondary" href="/join-discord">I joined — check again</a>
      </div>
    </section>`;
}

function settingsPage(user: DiscordUser, badges: PugUserBadge[], selectedBadgeIds: string[]) {
  return `<section class="card profile-card">
    <img class="profile-avatar" src="${escapeHtml(discordAvatarUrl(user, 160))}" alt="" />
    <div>
      <p class="eyebrow">Account</p>
      <h2>${escapeHtml(displayUser(user))}</h2>
      <p><small>@${escapeHtml(user.username)} · Discord ID <code>${escapeHtml(user.id)}</code></small></p>
      <p>Use this page to confirm which Discord account is connected to 7th Circle.</p>
      <p><a class="button danger" href="/logout">Log out</a></p>
    </div>
  </section>
  <section class="card" id="badges">
    <h2>Profile badges</h2>
    <p><small>Select up to 6 season badges to show on your public player profile.</small></p>
    ${badgeSelectionForm(badges, selectedBadgeIds)}
  </section>`;
}


type EventFormFields = Pick<Event, 'title' | 'description' | 'teamLimit' | 'requiredMainPlayers' | 'requiredSubstitutes' | 'startsAt' | 'endsAt' | 'registrationOpensAt' | 'registrationClosesAt' | 'backgroundImageDataUrl'>;

type EventRegistrationDetail = {
  registration: EventRegistration;
  team?: Team;
  members: Awaited<ReturnType<TeamBotApi['getTeamMemberDetails']>>;
};

type TeamPageRegistrationDetail = {
  registration: EventRegistration;
  event: Event;
};

type TeamMemberDetail = Awaited<ReturnType<TeamBotApi['getTeamMemberDetails']>>[number];

function eventsPage(events: Event[], counts: Record<string, number>, currentTeam: Team | undefined, currentUserId: string, userRegisteredEventIds: Set<string>) {
  const visibleEvents = events.filter((event) => eventState(event) !== 'ended');
  return `<p class="page-intro">Upcoming and live events are listed in chronological order. Team captains can register once their roster meets the event requirements.</p>
    ${
      visibleEvents.length
        ? `<div class="event-list">${visibleEvents.map((event) => eventCard(event, counts[event.id] ?? 0, currentTeam, currentUserId, userRegisteredEventIds.has(event.id))).join('')}</div>`
        : '<section class="card"><h2>No upcoming or live events</h2><p>Check back after administrators create the next event.</p></section>'
    }`;
}

function eventCard(event: Event, registrationCount: number, currentTeam: Team | undefined, currentUserId: string, isRegistered: boolean) {
  const state = eventState(event);
  const registrationState = eventRegistrationState(event, registrationCount);
  const canRegister = currentTeam?.ownerId === currentUserId && registrationState === 'open';
  const canEditRegistration = currentTeam?.ownerId === currentUserId && isRegistered && isRegistrationWindowOpen(event);
  return `<section class="card event-card${event.backgroundImageDataUrl ? ' event-card-with-photo' : ''}"${event.backgroundImageDataUrl ? ` style="--event-photo: url('${escapeCssUrl(event.backgroundImageDataUrl)}');"` : ''}>
    <div class="section-heading-row">
      <div>
        <p class="eyebrow">${eventStateLabel(state)}</p>
        <h2>${escapeHtml(event.title)}</h2>
      </div>
      <span class="event-capacity">${registrationCount}/${event.teamLimit} teams</span>
    </div>
    <p>${escapeHtml(event.description)}</p>
    <p class="timezone-note">adjusted for your timezone</p>
    <div class="event-meta-grid">
      ${eventMeta('Event starts', formatDateTime(event.startsAt))}
      ${eventMeta('Event ends', formatDateTime(event.endsAt))}
      ${eventMeta('Registration', eventRegistrationDateSummary(event))}
      ${eventMeta('Roster required', `${event.requiredMainPlayers} main, ${event.requiredSubstitutes} sub${event.requiredSubstitutes === 1 ? '' : 's'}`)}
    </div>
    <div class="event-actions">
      <a class="button secondary" href="/events/${encodeURIComponent(event.id)}/registrations">Registered teams</a>
      ${registrationState === 'full' ? '<span class="pill">Full</span>' : ''}
      ${registrationState === 'not-open' ? '<span class="pill">Registration not open</span>' : ''}
      ${registrationState === 'closed' ? '<span class="pill">Registration closed</span>' : ''}
      ${canRegister ? `<a class="button" href="/events/${encodeURIComponent(event.id)}/register">${isRegistered ? 'Edit registration' : 'Register'}</a>` : ''}
      ${!canRegister && canEditRegistration ? `<a class="button" href="/events/${encodeURIComponent(event.id)}/register">Edit registration</a>` : ''}
      ${!currentTeam ? '<small>Create a team as captain to register.</small>' : ''}
      ${currentTeam && currentTeam.ownerId !== currentUserId ? '<small>Only your team captain can register.</small>' : ''}
    </div>
  </section>`;
}

function eventRegistrationPage(
  event: Event,
  team: Team,
  members: Awaited<ReturnType<TeamBotApi['getTeamMemberDetails']>>,
  registrationCount: number,
  existingRegistration?: EventRegistration
) {
  const mainMembers = members.filter((member) => member.role === 'main' || member.role === 'captain');
  const subMembers = members.filter((member) => member.role === 'sub');
  const registrationState = eventRegistrationState(event, registrationCount);
  if (registrationState !== 'open' && !(existingRegistration && isRegistrationWindowOpen(event))) {
    return `<p><a href="/events">← Back to events</a></p><section class="card"><h2>Registration is ${eventRegistrationStateLabel(registrationState)}</h2><p>This event cannot accept new registrations right now.</p></section>`;
  }

  return `<p><a href="/events">← Back to events</a></p>
    <section class="card">
      <p class="eyebrow">${escapeHtml(team.name)}</p>
      <h2>${existingRegistration ? 'Edit roster for' : 'Select roster for'} ${escapeHtml(event.title)}</h2>
      <p>Choose the players who will compete from your <strong>Main</strong> role or the team captain, and any substitute players from your <strong>Sub</strong> role. You can return here later to update or remove this registration while registration is open.</p>
      <div class="event-meta-grid">
        ${eventMeta('Required main players', String(event.requiredMainPlayers))}
        ${eventMeta('Required substitutes', String(event.requiredSubstitutes))}
        ${eventMeta('Teams registered', `${registrationCount}/${event.teamLimit}`)}
        ${eventMeta('Registration closes', formatDateTime(event.registrationClosesAt))}
      </div>
      <form method="post" action="/events/${encodeURIComponent(event.id)}/register" class="stacked-form">
        <fieldset>
          <legend>Main players</legend>
          ${memberCheckboxList('mainPlayerIds', mainMembers, event.requiredMainPlayers, 'No team members currently have the Main role or Captain role.', existingRegistration?.mainPlayerIds)}
        </fieldset>
        <fieldset>
          <legend>Substitute players</legend>
          ${memberCheckboxList('substitutePlayerIds', subMembers, event.requiredSubstitutes, 'No team members currently have the Sub role.', existingRegistration?.substitutePlayerIds)}
        </fieldset>
        <div class="event-actions">
          <button type="submit">${existingRegistration ? 'Save registration' : 'Register team'}</button>
        </div>
      </form>
      ${existingRegistration ? `<form method="post" action="/events/${encodeURIComponent(event.id)}/register/delete" onsubmit="return confirm('Remove ${escapeJsString(team.name)} from ${escapeJsString(event.title)}?');"><button class="danger" type="submit">Remove registration</button></form>` : ''}
    </section>`;
}

function eventRegistrationsPage(event: Event, details: EventRegistrationDetail[], isAdmin: boolean) {
  return `<p><a href="/events">← Back to events</a></p>
    <section class="card">
      <div class="section-heading-row">
        <div><p class="eyebrow">Registered teams</p><h2>${escapeHtml(event.title)}</h2></div>
        <span class="event-capacity">${details.length}/${event.teamLimit} teams</span>
      </div>
      ${
        details.length
          ? `<div class="management-list">${details.map((detail, index) => eventRegistrationCard(detail, index + 1, event, isAdmin)).join('')}</div>`
          : '<p>No teams have registered yet.</p>'
      }
    </section>`;
}

function eventRegistrationCard(detail: EventRegistrationDetail, index: number, event: Event, isAdmin: boolean) {
  const memberNames = new Map(detail.members.map((member) => [member.userId, member.displayName]));
  const listNames = (ids: string[]) => ids.map((id) => escapeHtml(memberNames.get(id) ?? id)).join(', ') || 'None selected';
  return `<div class="admin-team-row">
    <div>
      <strong>${index}. ${escapeHtml(detail.team?.name ?? detail.registration.teamId)}</strong><br />
      <small>Registered ${formatDateTime(detail.registration.createdAt)}</small><br />
      <small>Main: ${listNames(detail.registration.mainPlayerIds)}</small><br />
      <small>Subs: ${listNames(detail.registration.substitutePlayerIds)}</small>
    </div>
    ${isAdmin ? `<form method="post" action="/events/${encodeURIComponent(event.id)}/registrations/${encodeURIComponent(detail.registration.teamId)}/delete" onsubmit="return confirm('Force un-register ${escapeJsString(detail.team?.name ?? detail.registration.teamId)} from ${escapeJsString(event.title)}?');"><button class="danger" type="submit">Force un-register</button></form>` : ''}
  </div>`;
}

function eventManagementPage(events: Event[], counts: Record<string, number>) {
  return `<p><a href="/events">← Back to events</a></p>
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
      <small>${formatDateTime(event.startsAt)} · ${registrationCount}/${event.teamLimit} teams · registration ${escapeHtml(eventRegistrationStateLabel(eventRegistrationState(event, registrationCount)))}</small>
    </div>
    <div class="admin-team-actions">
      <a class="button secondary" href="/events/${encodeURIComponent(event.id)}/registrations">Teams</a>
      <a class="button" href="/event-management/events/${encodeURIComponent(event.id)}/edit">Edit</a>
      <form method="post" action="/event-management/events/${encodeURIComponent(event.id)}/delete" onsubmit="return confirm('Delete ${escapeJsString(event.title)} and all registrations? This cannot be undone.');"><button class="danger" type="submit">Delete</button></form>
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
    ${eventPhotoField(event)}
    <button type="submit">${event ? 'Save event' : 'Create event'}</button>
  </form>`;
}

function eventPhotoField(event?: Event) {
  const hasPhoto = Boolean(event?.backgroundImageDataUrl);
  return `<div class="event-photo-field" data-event-photo-field>
      <div>
        <label>Event background photo
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-event-photo-input />
        </label>
        <small>Upload a PNG, JPEG, WebP, or GIF up to 2 MB. The photo appears behind the event card.</small>
        <input type="hidden" name="backgroundImageDataUrl" value="${escapeHtml(event?.backgroundImageDataUrl ?? '')}" data-event-photo-data />
      </div>
      <div class="event-photo-preview${hasPhoto ? '' : ' is-empty'}" data-event-photo-preview${hasPhoto ? ` style="background-image: url('${escapeCssUrl(event!.backgroundImageDataUrl!)}');"` : ''}>${hasPhoto ? '' : 'No photo'}</div>
      <button class="secondary" type="button" data-event-photo-clear${hasPhoto ? '' : ' disabled'}>Clear photo</button>
    </div>`;
}

function memberCheckboxList(name: string, members: Awaited<ReturnType<TeamBotApi['getTeamMemberDetails']>>, requiredCount: number, emptyMessage: string, selectedIds: string[] = []) {
  if (!members.length) return `<p><small>${emptyMessage}</small></p>`;
  const selected = new Set(selectedIds);
  return `<p><small>Select at least ${requiredCount}.</small></p><div class="checkbox-list modern-checkbox-list">${members.map((member) => {
    const checked = selected.has(member.userId) ? ' checked' : '';
    return `<label class="checkbox-row modern-checkbox-row"><input type="checkbox" name="${name}" value="${escapeHtml(member.userId)}"${checked} /> <span class="checkbox-control" aria-hidden="true"></span><span class="checkbox-user"><strong>${escapeHtml(member.displayName)}</strong><small>@${escapeHtml(member.username)}</small></span></label>`;
  }).join('')}</div>`;
}

function eventMeta(label: string, value: string) {
  return `<div class="stat-card"><small>${escapeHtml(label)}</small><strong>${value}</strong></div>`;
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
  const backgroundImageDataUrl = parseEventPhotoDataUrl(body.backgroundImageDataUrl);

  if (!title) throw new Error('Event title is required.');
  if (!description) throw new Error('Event description is required.');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error('Event end date must be after the start date.');
  if (new Date(registrationClosesAt).getTime() <= new Date(registrationOpensAt).getTime()) throw new Error('Registration close date must be after the open date.');

  return { title, description, teamLimit, requiredMainPlayers, requiredSubstitutes, startsAt, endsAt, registrationOpensAt, registrationClosesAt, backgroundImageDataUrl };
}

function parseEventPhotoDataUrl(value: unknown) {
  const dataUrl = String(value ?? '').trim();
  if (!dataUrl) return undefined;
  if (dataUrl.length > 2_800_000) throw new Error('Event background photo must be 2 MB or smaller.');
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new Error('Event background photo must be a PNG, JPEG, WebP, or GIF image.');
  }
  return dataUrl;
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

function validateEventRegistration(event: Event, members: TeamMember[], mainPlayerIds: string[], substitutePlayerIds: string[], registrationCount: number, isExistingRegistration = false) {
  const registrationState = eventRegistrationState(event, registrationCount);
  if (registrationState === 'full' && !isExistingRegistration) throw new Error('This event has reached its team registration limit.');
  if (registrationState === 'not-open') throw new Error('Registration is not open yet for this event.');
  if (registrationState === 'closed') throw new Error('Registration has closed for this event.');
  if (isExistingRegistration && !isRegistrationWindowOpen(event)) throw new Error('Registration changes are closed for this event.');

  const mainMemberIds = new Set(members.filter((member) => member.role === 'main' || member.role === 'captain').map((member) => member.userId));
  const subMemberIds = new Set(members.filter((member) => member.role === 'sub').map((member) => member.userId));
  const duplicateIds = mainPlayerIds.filter((id) => substitutePlayerIds.includes(id));
  if (duplicateIds.length) throw new Error('A player cannot be selected as both a main player and a substitute.');
  if (mainPlayerIds.length < event.requiredMainPlayers) throw new Error(`This event requires at least ${event.requiredMainPlayers} main player${event.requiredMainPlayers === 1 ? '' : 's'}.`);
  if (substitutePlayerIds.length < event.requiredSubstitutes) throw new Error(`This event requires at least ${event.requiredSubstitutes} substitute${event.requiredSubstitutes === 1 ? '' : 's'}.`);
  if (mainPlayerIds.some((id) => !mainMemberIds.has(id))) throw new Error('Main player selections must come from team members with the Main role or the team captain.');
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

function eventRegistrationDateSummary(event: Event) {
  return Date.now() < new Date(event.registrationOpensAt).getTime()
    ? `Registration opening ${formatDateTime(event.registrationOpensAt)}`
    : `Registration closes on ${formatDateTime(event.registrationClosesAt)}`;
}

function isRegistrationWindowOpen(event: Event) {
  const now = Date.now();
  return now >= new Date(event.registrationOpensAt).getTime() && now <= new Date(event.registrationClosesAt).getTime();
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
  adminRoleId?: string,
  pugSettings?: PugSettings
) {
  return `<p><a href="/events">← Back to events</a></p>
    <section class="card">
      <h2>All teams</h2>
      ${
        teamSummaries.length
          ? `<div class="management-list">${teamSummaries.map(({ team, memberCount }) => administratorTeamCard(team, memberCount)).join('')}</div>`
          : '<p>No teams have been created yet.</p>'
      }
    </section>
    <section class="card" id="pugs">
      <h2>PUG administration</h2>
      <p><small>Review full PUG match history, inspect ongoing matches, delete or reset live matches, and force teams or captains from the dedicated administrator-only PUG section.</small></p>
      <div class="admin-team-actions"><a class="button" href="/administrator/pugs">Open PUG administration</a><a class="button secondary" href="/administrator/ranks">Edit ranks and icons</a></div>
      ${administratorPugSettingsForm(pugSettings)}
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


function administratorPugSettingsForm(settings?: PugSettings) {
  return `<div class="subsection">
    <h3>PUG queue settings</h3>
    <p><small>Configure the Discord text channel where the bot posts the interactive PUG queue message and maintain the map pool used for completed lobbies.</small></p>
    <form method="post" action="/administrator/pugs" class="stack-form">
      <label>PUG queue text channel ID
        <input name="queueChannelId" value="${escapeHtml(settings?.queueChannelId ?? '')}" placeholder="Discord text channel ID" />
      </label>
      <label>Map pool
        <textarea name="mapPool" rows="8" placeholder="One map per line">${escapeHtml((settings?.mapPool ?? []).join('\n'))}</textarea>
      </label>
      <div class="inline-form">
        <label>Final Round ELO value
          <input name="finalRoundMultiplier" type="number" min="0" max="5" step="0.05" value="${formatMultiplierInput(settings?.elo?.finalRoundMultiplier ?? 1)}" />
        </label>
        <label>Cashout ELO value
          <input name="cashoutMultiplier" type="number" min="0" max="5" step="0.05" value="${formatMultiplierInput(settings?.elo?.cashoutMultiplier ?? 1.25)}" />
        </label>
      </div>
      <p><small>These multipliers scale every ELO gain and loss by mode. Use <code>1</code> for normal value; Cashout defaults to <code>1.25</code> so those games are 25% more valuable.</small></p>
      <button type="submit">Save PUG settings</button>
    </form>
    <form method="post" action="/administrator/pugs/publish" onsubmit="return confirm('Publish or refresh the PUG queue message in the configured channel?');">
      <button type="submit">Publish queue message</button>
    </form>
    ${settings?.queueMessageId ? `<p><small>Current queue message ID: <code>${escapeHtml(settings.queueMessageId)}</code></small></p>` : ''}
  </div>`;
}


function administratorPugsPage(activeMatches: AdminPugMatchLog[], history: PugMatchLog[], ratings: PugEloRating[], eloSettings: PugEloSettings, playerSearch: PugPlayerSearchState) {
  return `<p><a href="/administrator">← Back to administrator</a></p>
    <section class="card">
      <h2>Ongoing PUG matches</h2>
      ${activeMatches.length ? `<div class="management-list">${activeMatches.map(pugActiveMatchCard).join('')}</div>` : '<p>No PUG matches are currently running.</p>'}
    </section>
    <section class="card" id="elo">
      <h2>PUG ELO administration</h2>
      ${pugEloAdminPanel(ratings, eloSettings, playerSearch)}
    </section>
    <section class="card">
      <h2>Full PUG match history</h2>
      ${history.length ? `<div class="pug-history">${history.map(pugHistoryCard).join('')}</div>` : '<p>No PUG matches have been logged yet.</p>'}
    </section>`;
}

function pugActiveMatchCard(match: AdminPugMatchLog) {
  const teamText = formatPugTeamsForInput(match);
  const captainsText = match.captainIds.length ? match.captainIds.join('\n') : '';
  return `<div class="pug-admin-match">
    ${pugMatchSummary(match)}
    <div class="admin-team-actions">
      <form method="post" action="/administrator/pugs/${encodeURIComponent(match.id)}/reset" onsubmit="return confirm('Reset this PUG match back to team selection?');"><button type="submit">Reset match</button></form>
      <form method="post" action="/administrator/pugs/${encodeURIComponent(match.id)}/delete" onsubmit="return confirm('Delete this live PUG match and its Discord channels?');"><button class="danger" type="submit">Delete match</button></form>
    </div>
    <details>
      <summary>Force change teams</summary>
      <form method="post" action="/administrator/pugs/${encodeURIComponent(match.id)}/teams" class="stack-form">
        <label>Teams <small>One team per line. Use Discord user IDs separated by spaces, commas, or mentions. Every player must appear exactly once.</small>
          <textarea name="teams" rows="6" placeholder="123 456 789&#10;987 654 321">${escapeHtml(teamText)}</textarea>
        </label>
        <button type="submit">Force teams</button>
      </form>
    </details>
    <details>
      <summary>Force change captains</summary>
      <form method="post" action="/administrator/pugs/${encodeURIComponent(match.id)}/captains" class="stack-form">
        <label>Captain user IDs <small>One captain per line or separated by commas/spaces.</small>
          <textarea name="captainIds" rows="4" placeholder="123456789&#10;987654321">${escapeHtml(captainsText)}</textarea>
        </label>
        <button type="submit">Force captains</button>
      </form>
    </details>
  </div>`;
}

function pugHistoryCard(match: PugMatchLog) {
  const rollbackForm = match.status === 'completed' && Boolean(match.eloChanges?.length)
    ? `<form method="post" action="/administrator/pugs/${encodeURIComponent(match.id)}/rollback" onsubmit="return confirm('Roll back this PUG match? This negates its ELO and removes it from player win/loss stats.');"><button type="submit">Rollback match</button></form>`
    : '';
  return `<div class="pug-admin-match">
    ${pugMatchSummary(match)}
    <div class="admin-team-actions">
      ${rollbackForm}
      <form method="post" action="/administrator/pugs/${encodeURIComponent(match.id)}/delete" onsubmit="return confirm('Delete this PUG match log?');"><button class="danger" type="submit">Delete log</button></form>
    </div>
  </div>`;
}

function pugMatchSummary(match: AdminPugMatchLog | PugMatchLog) {
  const eloPreview = 'eloPreview' in match ? pugEloPreviewSummary(match.eloPreview) : '';
  return `<div class="admin-team-row">
    <div>
      <strong>${escapeHtml(pugQueueLabel(match.size))}</strong> <span class="pill">${escapeHtml(match.status)}</span><br />
      <small>ID <code>${escapeHtml(match.id)}</code> · Created ${formatDateTime(match.createdAt)}${match.endedAt ? ` · Ended ${formatDateTime(match.endedAt)}` : ''}</small>
    </div>
    <div><small>${match.playerIds.length} players · ${match.mode ? escapeHtml(modeLabel(match.mode)) : 'mode pending'}${match.map ? ` · Map ${escapeHtml(match.map)}` : ''}</small></div>
  </div>
  <div class="pug-admin-grid">
    <div><h3>Players</h3>${pugPlayerList(match, match.playerIds)}</div>
    <div><h3>Teams</h3>${match.teams.length ? match.teams.map((team, index) => `<p><strong>Team ${index + 1}</strong><br />${pugPlayerList(match, team)}</p>`).join('') : '<p><small>Teams have not been created yet.</small></p>'}${eloPreview}</div>
    <div><h3>Results</h3><p>${match.result ? escapeHtml(match.result) : 'No result yet.'}</p>${pugVoteSummary(match)}${pugEloChangeSummary(match)}</div>
  </div>`;
}


function addAdminPugEloPreview(match: PugMatchLog, ratings: PugEloRating[], settings: PugEloSettings): AdminPugMatchLog {
  if (!match.teams.length) return match;
  return { ...match, eloPreview: buildAdminPugEloPreview(match, ratings, settings) };
}

function buildAdminPugEloPreview(match: PugMatchLog, ratings: PugEloRating[], settings: PugEloSettings): AdminPugEloPreviewTeam[] {
  const ratingMap = new Map(ratings.map((rating) => [rating.userId, rating]));
  const teamTotals = match.teams.map((team) => team.reduce((sum, userId) => sum + getAdminPugRating(userId, ratingMap, settings).rating, 0));
  return match.teams.map((team, teamIndex) => {
    const teamAverage = teamTotals[teamIndex] / Math.max(1, team.length);
    const opponents = match.teams.flatMap((otherTeam, otherIndex) => otherIndex === teamIndex ? [] : otherTeam);
    const opponentAverage = opponents.reduce((sum, userId) => sum + getAdminPugRating(userId, ratingMap, settings).rating, 0) / Math.max(1, opponents.length);
    return {
      teamIndex,
      total: teamTotals[teamIndex],
      average: teamAverage,
      players: team.map((userId) => {
        const rating = getAdminPugRating(userId, ratingMap, settings);
        const first = calculateAdminPugEloGain(rating.rating, teamAverage, opponentAverage, settings);
        return {
          userId,
          username: match.playerUsernames[userId] ?? rating.username,
          rating: rating.rating,
          first: applyAdminPugEloValueMultiplier(first, match.size, settings),
          second: match.teams.length > 2 ? applyAdminPugEloValueMultiplier(Math.max(MINIMUM_PUG_ELO_CHANGE, Math.round(first / 2)), match.size, settings) : undefined,
          loss: -applyAdminPugEloValueMultiplier(calculateAdminPugEloLoss(rating.rating, teamAverage, opponentAverage, first, settings), match.size, settings)
        };
      })
    };
  });
}

function getAdminPugRating(userId: string, ratings: Map<string, PugEloRating>, settings: PugEloSettings) {
  return ratings.get(userId) ?? { userId, rating: settings.startingRating, updatedAt: '' };
}

function applyAdminPugEloValueMultiplier(delta: number, size: PugMatchLog['size'], settings: PugEloSettings) {
  const multiplier = size === 12 ? settings.cashoutMultiplier : settings.finalRoundMultiplier;
  return Math.round(delta * multiplier);
}

const MINIMUM_PUG_ELO_CHANGE = 200;
const MAXIMUM_PUG_ELO_GAIN = 2000;
const MAXIMUM_PUG_ELO_LOSS_MULTIPLIER = 2;

function calculateAdminPugEloGain(playerRating: number, teamAverage: number, opponentAverage: number, settings: PugEloSettings) {
  const teamFactor = Math.exp(((opponentAverage - teamAverage) / settings.startingRating) * settings.strength);
  const playerFactor = Math.exp(((teamAverage - playerRating) / (settings.startingRating * 2)) * settings.strength);
  return Math.max(MINIMUM_PUG_ELO_CHANGE, Math.min(MAXIMUM_PUG_ELO_GAIN, Math.round(settings.baseChange * teamFactor * playerFactor)));
}

function calculateAdminPugEloLoss(playerRating: number, _teamAverage: number, opponentAverage: number, possibleGain: number, _settings: PugEloSettings) {
  const opponentRatio = opponentAverage > 0 ? playerRating / opponentAverage : MAXIMUM_PUG_ELO_LOSS_MULTIPLIER;
  const cappedRatio = Math.min(MAXIMUM_PUG_ELO_LOSS_MULTIPLIER, opponentRatio);
  return Math.max(MINIMUM_PUG_ELO_CHANGE, Math.round(possibleGain * cappedRatio));
}

function pugEloPreviewSummary(preview?: AdminPugEloPreviewTeam[]) {
  if (!preview?.length) return '';
  const playerRows = (team: AdminPugEloPreviewTeam) => team.players.map((player) => `
    <span>${escapeHtml(player.username ?? player.userId)}</span>
    <span>${formatElo(player.rating)}</span>
    <span class="elo-gain">+${formatElo(player.first)}</span>
    <span${player.second === undefined ? '' : ' class="elo-gain"'}>${player.second === undefined ? '—' : `+${formatElo(player.second)}`}</span>
    <span class="elo-loss">${formatElo(player.loss)}</span>`).join('');
  return `<div class="pug-elo-preview"><h3>ELO preview</h3><p><small>Administrator-only estimate. Values show each player’s current ELO and potential change for First, Second, or Loss.</small></p>${preview.map((team) => `<div class="pug-elo-preview-team"><strong>Team ${team.teamIndex + 1}: ${formatElo(team.total)} total ELO</strong><br /><small>${formatElo(team.average)} average ELO</small><div class="pug-elo-preview-table"><span>Player</span><span>ELO</span><span>First</span><span>Second</span><span>Loss</span>${playerRows(team)}</div></div>`).join('')}</div>`;
}

function pugPlayerList(match: PugMatchLog, ids: string[]) {
  return ids.map((id) => `<span class="pug-player">${escapeHtml(match.playerUsernames[id] ?? id)} <code>${escapeHtml(id)}</code></span>`).join('') || '<small>None</small>';
}

function pugVoteSummary(match: PugMatchLog) {
  const entries = Object.entries(match.votes);
  if (!entries.length) return '<p><small>No result votes have been cast.</small></p>';
  return `<p><small>${entries.length} vote${entries.length === 1 ? '' : 's'} cast:</small></p><ul>${entries.map(([userId, vote]) => `<li>${escapeHtml(match.playerUsernames[userId] ?? userId)}: ${escapeHtml(formatPugVote(match, vote))}</li>`).join('')}</ul>`;
}

function formatPugVote(match: PugMatchLog, vote: string) {
  if (match.voteMode !== 'placements') return `Team ${Number(vote) + 1}`;
  const [first, second] = vote.split(',');
  return `Winner: ${first ? `Team ${Number(first) + 1}` : '—'}, Second: ${second ? `Team ${Number(second) + 1}` : '—'}`;
}

function formatPugTeamsForInput(match: PugMatchLog) {
  const teams = match.teams.length ? match.teams : [];
  return teams.map((team) => team.join(' ')).join('\n');
}

function parsePugTeams(value: string) {
  return value.split(/\r?\n/).map((line) => parseDiscordIds(line)).filter((team) => team.length);
}

function parseDiscordIds(value: string) {
  return [...value.matchAll(/\d{5,}/g)].map((match) => match[0]);
}

type LeaderboardRating = PugEloRating & { displayName: string; username?: string; avatarUrl: string; rank: PugPlayerRank };

function leaderboardPage(leaderboard: LeaderboardRating[], ownRating: PugEloRating, ownRank: PugPlayerRank, playerSearch: LeaderboardPlayerSearchState, activeSeason: PugSeason, seasonLeaderboards: PugSeasonLeaderboardEntry[]) {
  return `<section class="card">
    <h2>Top 10 7th Circle players</h2>
    <p><small>Active season: ${escapeHtml(activeSeason.label)}${activeSeason.endsAt ? ` · scheduled end ${formatDateTime(activeSeason.endsAt)}` : ' · no scheduled end date'}</small></p>
    ${leaderboard.length ? `<ol class="leaderboard-list">${leaderboard.map((rating) => leaderboardEntry(rating)).join('')}</ol>` : '<p>No PUG ELO ratings have been recorded yet.</p>'}
    ${leaderboardPlayerSearchPanel(playerSearch)}
  </section>
  ${previousSeasonLeaderboardsSection(seasonLeaderboards)}
  <section class="card">
    <h2>Your PUG ELO</h2>
    <div class="stat-grid"><div class="stat-card"><small>Current rating</small><strong>${formatElo(ownRating.rating)}</strong></div><div class="stat-card"><small>Current rank</small><strong>${rankBadge(ownRank)}</strong></div></div>
    <p><small>You can also use the Discord <code>/elo</code> command to see this rating privately.</small></p>
  </section>`;
}

function leaderboardPlayerSearchPanel(search: LeaderboardPlayerSearchState) {
  return `<div class="leaderboard-player-search">
    <h3>Find another player</h3>
    <p><small>Search for PUG players who are not currently in the top 10.</small></p>
    <form method="get" action="/leaderboard" class="inline-form leaderboard-player-search-form">
      <label>Search players <input name="q" value="${escapeHtml(search.query)}" placeholder="Username or Discord user ID" list="leaderboard-player-options" /></label>
      <button type="submit">Search</button>
      ${search.query ? '<a class="button secondary" href="/leaderboard">Clear</a>' : ''}
      <datalist id="leaderboard-player-options">${search.players.map((player) => `<option value="${escapeHtml(player.username ?? player.userId)}" label="${escapeHtml(player.userId)}"></option>`).join('')}</datalist>
    </form>
    ${leaderboardPlayerSearchResults(search)}
  </div>`;
}

function leaderboardPlayerSearchResults(search: LeaderboardPlayerSearchState) {
  if (!search.query) return '<p><small>Enter a name or Discord user ID to look up players outside the top 10.</small></p>';
  if (!search.players.length) return '<p><small>No players outside the top 10 have been tracked yet.</small></p>';
  if (!search.matches.length) return '<p><small>No non-top-10 players matched that search.</small></p>';
  return `<div class="pug-player-search-results">${search.matches.map((player) => `<a class="pug-player-result" href="/leaderboard/players/${encodeURIComponent(player.userId)}"><strong>${escapeHtml(player.username ?? player.userId)}</strong><small><code>${escapeHtml(player.userId)}</code> · ${formatElo(player.rating)} ELO</small></a>`).join('')}</div>`;
}

function leaderboardEntry(rating: LeaderboardRating) {
  const rankClass = ` leaderboard-${rankClassId(rating.rank.id)}`;
  const masterClass = rating.rank.isMaster ? ' leaderboard-master' : '';
  return `<li class="leaderboard-entry${rankClass}${masterClass}">
    <a class="leaderboard-player" href="/leaderboard/players/${encodeURIComponent(rating.userId)}">
      ${rating.avatarUrl ? `<img src="${escapeHtml(rating.avatarUrl)}" alt="" />` : '<span class="avatar-placeholder"></span>'}
      <span><strong>${escapeHtml(rating.displayName)}</strong>${rating.username ? `<small>@${escapeHtml(rating.username)}</small>` : ''}</span>
    </a>
    <span class="leaderboard-rank">${rankBadge(rating.rank)}</span>
    <span>${formatElo(rating.rating)} ELO</span>
  </li>`;
}

function leaderboardPlayerProfilePage(stats: PugPlayerStats, profile: { displayName?: string; username?: string; avatarUrl?: string } | undefined, badges: PugUserBadge[], selectedBadgeIds: string[]) {
  const displayName = profile?.displayName ?? stats.player.username ?? stats.player.userId;
  const profileClasses = ['card', 'leaderboard-profile-section', `profile-${rankClassId(stats.rank.id)}`];
  if (stats.rank.isMaster) profileClasses.push('profile-master');
  return `<p><a href="/leaderboard">← Back to leaderboard</a></p>
  <section class="${profileClasses.map(escapeHtml).join(' ')}">
    <div class="profile-card leaderboard-profile-card">
      ${profile?.avatarUrl ? `<img class="profile-avatar" src="${escapeHtml(profile.avatarUrl)}" alt="" />` : '<span class="profile-avatar avatar-placeholder"></span>'}
      <div>
        <h2>${escapeHtml(displayName)} ${rankBadge(stats.rank)}</h2>
        <p><small>${profile?.username ? `@${escapeHtml(profile.username)} · ` : ''}<code>${escapeHtml(stats.player.userId)}</code>${stats.player.updatedAt ? ` · ELO updated ${formatDateTime(stats.player.updatedAt)}` : ''}</small></p>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><small>Current ELO</small><strong>${formatElo(stats.player.rating)}</strong></div>
      <div class="stat-card"><small>Current rank</small><strong>${rankBadge(stats.rank)}</strong></div>
      <div class="stat-card"><small>Total matches</small><strong>${stats.totals.total}</strong></div>
      <div class="stat-card"><small>Wins</small><strong>${stats.totals.wins}</strong></div>
      <div class="stat-card"><small>Seconds</small><strong>${stats.totals.seconds}</strong></div>
      <div class="stat-card"><small>Losses</small><strong>${stats.totals.losses}</strong></div>
      <div class="stat-card"><small>Win/loss</small><strong>${stats.totals.wins}/${stats.totals.losses}</strong></div>
      <div class="stat-card"><small>Winrate</small><strong>${formatPercent(stats.totals.winRate)}</strong></div>
    </div>
    ${displayedBadgesPanel(badges, selectedBadgeIds)}
    ${pugPlayerStatsTables(stats)}
  </section>`;
}

function pugPlayerStatsTables(stats: PugPlayerStats) {
  const finalRoundModes = stats.modes.filter((mode) => mode.mode === 6);
  const cashoutModes = stats.modes.filter((mode) => mode.mode === 12);
  const finalRoundTable = finalRoundModes.length
    ? `<div class="pug-player-stats-table pug-player-stats-table-no-seconds"><span>Mode</span><span>Wins</span><span>Losses</span><span>Winrate</span>${finalRoundModes.map((mode) => `<span>${escapeHtml(mode.label)}</span><span>${mode.wins}</span><span>${mode.losses}</span><span>${formatPercent(mode.winRate)}</span>`).join('')}</div>`
    : '';
  const cashoutTable = cashoutModes.length
    ? `<div class="pug-player-stats-table pug-player-stats-table-with-seconds"><span>Mode</span><span>Wins</span><span>Seconds</span><span>Losses</span><span>Winrate</span>${cashoutModes.map((mode) => `<span>${escapeHtml(mode.label)}</span><span>${mode.wins}</span><span>${mode.seconds}</span><span>${mode.losses}</span><span>${formatPercent(mode.winRate)}</span>`).join('')}</div>`
    : '';
  return `<div class="pug-player-stats-tables">${finalRoundTable}${cashoutTable}</div>`;
}


function badgeSelectionForm(badges: PugUserBadge[], selectedBadgeIds: string[]) {
  if (!badges.length) return '<p>No season badges have been earned yet. Badges are awarded when a PUG season ends.</p>';
  const selected = new Set(selectedBadgeIds);
  return `<form method="post" action="/settings/badges" class="badge-selection-form">
    <div class="badge-grid">${badges.map((badge) => `<label class="badge-option">
      <input type="checkbox" name="badgeIds" value="${escapeHtml(badge.id)}"${selected.has(badge.id) ? ' checked' : ''} />
      ${seasonBadge(badge)}
      <small>${escapeHtml(badge.rankLabel)} · awarded ${formatDateTime(badge.awardedAt)}</small>
    </label>`).join('')}</div>
    <button type="submit">Save shown badges</button>
  </form>`;
}

function displayedBadgesPanel(badges: PugUserBadge[], selectedBadgeIds: string[]) {
  const selected = selectedBadgeIds.length ? selectedBadgeIds : badges.slice(0, 6).map((badge) => badge.id);
  const selectedSet = new Set(selected);
  const shown = badges.filter((badge) => selectedSet.has(badge.id)).slice(0, 6);
  if (!shown.length) return '<div class="profile-badges"><h3>Badges</h3><p><small>No badges are shown on this profile yet.</small></p></div>';
  return `<div class="profile-badges"><h3>Badges</h3><div class="badge-grid badge-grid-compact">${shown.map(seasonBadge).join('')}</div></div>`;
}

function seasonBadge(badge: PugUserBadge) {
  const icon = badge.iconDataUrl ? `<img class="rank-icon" src="${escapeHtml(badge.iconDataUrl)}" alt="" />` : '<span class="rank-icon rank-icon-empty"></span>';
  return `<span class="season-badge rank-${rankClassId(badge.rankId)}">${icon}<span><strong>${escapeHtml(badge.label)}</strong><small>${escapeHtml(badge.seasonLabel)} · ${escapeHtml(badge.abbreviation ?? badge.rankLabel)}</small></span></span>`;
}

function previousSeasonLeaderboardsSection(entries: PugSeasonLeaderboardEntry[]) {
  const bySeason = new Map<string, PugSeasonLeaderboardEntry[]>();
  for (const entry of entries) {
    if (!bySeason.has(entry.seasonId)) bySeason.set(entry.seasonId, []);
    bySeason.get(entry.seasonId)!.push(entry);
  }
  const seasons = [...bySeason.entries()].slice(0, 5);
  if (!seasons.length) return '';
  return `<section class="card"><h2>Prior season top 10</h2><div class="season-leaderboards">${seasons.map(([, seasonEntries]) => {
    const sorted = [...seasonEntries].sort((a, b) => a.placement - b.placement).slice(0, 10);
    return `<div class="season-leaderboard"><h3>${escapeHtml(sorted[0]?.seasonLabel ?? 'Season')}</h3><ol class="leaderboard-list compact-leaderboard">${sorted.map((entry) => `<li class="leaderboard-entry"><span>#${entry.placement} ${escapeHtml(entry.username ?? entry.userId)}</span><span>${escapeHtml(entry.rankLabel)}</span><span>${formatElo(entry.rating)} ELO</span></li>`).join('')}</ol></div>`;
  }).join('')}</div></section>`;
}

function rankBadge(rank: PugPlayerRank) {
  const icon = rank.iconDataUrl ? `<img class="rank-icon" src="${escapeHtml(rank.iconDataUrl)}" alt="" />` : '<span class="rank-icon rank-icon-empty"></span>';
  const label = rank.isMaster ? (rank.abbreviation || rank.label) : rank.label;
  const classes = ['rank-badge', `rank-${rankClassId(rank.id)}`];
  if (rank.isMaster) classes.push('master-rank');
  return `<span class="${classes.map(escapeHtml).join(' ')}">${icon}<span>${escapeHtml(label)}</span></span>`;
}

function rankClassId(id: string) {
  return id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function resolvePugRank(rating: Pick<PugEloRating, 'userId' | 'rating'>, settings: PugRankSettings, topMasterUserIds: Set<string>): PugPlayerRank {
  if (topMasterUserIds.has(rating.userId)) {
    return { id: 'master-infernal', label: 'Master Infernal', abbreviation: 'M1', minRating: rating.rating, iconDataUrl: settings.masterIconDataUrl, isMaster: true };
  }
  const ranks = settings.ranks.length ? settings.ranks : [];
  return [...ranks].reverse().find((rank) => rating.rating >= rank.minRating && (rank.maxRating === undefined || rating.rating <= rank.maxRating)) ?? ranks[0] ?? { id: 'unranked', label: 'Unranked', abbreviation: 'UR', minRating: 0 };
}

function pugEloAdminPanel(_ratings: PugEloRating[], settings: PugEloSettings, playerSearch: PugPlayerSearchState) {
  return `<div class="subsection">
    <h3>ELO formula settings</h3>
    <p><small>Base gain controls the fair-match win reward; strength controls how quickly rewards shrink for favorites and grow for underdogs. Mode values then scale every gain/loss, letting admins make Final Round or Cashout worth more or less. Cashout defaults to 1.25 (25% more valuable).</small></p>
    <form method="post" action="/administrator/pugs/elo/settings" class="inline-form">
      <label>Starting ELO <input name="startingRating" type="number" min="1" value="${settings.startingRating}" /></label>
      <label>Fair-win base <input name="baseChange" type="number" min="1" value="${settings.baseChange}" /></label>
      <label>Strength <input name="strength" type="number" min="0.1" max="5" step="0.1" value="${settings.strength}" /></label>
      <label>Final Round value <input name="finalRoundMultiplier" type="number" min="0" max="5" step="0.05" value="${formatMultiplierInput(settings.finalRoundMultiplier)}" /></label>
      <label>Cashout value <input name="cashoutMultiplier" type="number" min="0" max="5" step="0.05" value="${formatMultiplierInput(settings.cashoutMultiplier)}" /></label>
      <button type="submit">Save ELO settings</button>
    </form>
  </div>
  <div class="subsection">
    <h3>Player search</h3>
    <p><small>Search tracked PUG players, select one, review their current results by PUG mode, and adjust their ELO from the selected player card. First-place and second-place finishes are based on completed match placements. Cashout seconds are listed separately and count toward winrate.</small></p>
    ${pugPlayerSearchPanel(playerSearch, settings)}
    <form method="post" action="/administrator/pugs/elo/reset-all" onsubmit="return confirm('Reset every tracked player to the current starting ELO?');">
      <button class="danger" type="submit">Reset all player ELO</button>
    </form>
  </div>`;
}


function buildLeaderboardPlayerSearchState(history: PugMatchLog[], ratings: PugEloRating[], settings: PugEloSettings, topLeaderboardUserIds: string[], rawQuery: string): LeaderboardPlayerSearchState {
  const query = rawQuery.trim();
  const topLeaderboardUserIdSet = new Set(topLeaderboardUserIds);
  const players = buildPugPlayerSearchEntries(history, ratings, settings).filter((player) => !topLeaderboardUserIdSet.has(player.userId));
  const normalizedQuery = query.toLowerCase();
  const matches = normalizedQuery
    ? players.filter((player) => player.userId.includes(normalizedQuery) || (player.username ?? '').toLowerCase().includes(normalizedQuery)).slice(0, 25)
    : [];
  return { query, players, matches };
}

function buildPugPlayerSearchState(history: PugMatchLog[], ratings: PugEloRating[], settings: PugEloSettings, rawQuery: string, rawSelectedPlayerId: string): PugPlayerSearchState {
  const query = rawQuery.trim();
  const selectedPlayerId = parseDiscordIds(rawSelectedPlayerId)[0];
  const players = buildPugPlayerSearchEntries(history, ratings, settings);
  const normalizedQuery = query.toLowerCase();
  const matches = normalizedQuery
    ? players.filter((player) => player.userId.includes(normalizedQuery) || (player.username ?? '').toLowerCase().includes(normalizedQuery)).slice(0, 25)
    : players.slice(0, 25);
  const selected = selectedPlayerId ? buildPugPlayerStats(selectedPlayerId, players, history, ratings, settings) : undefined;
  return { query, selectedPlayerId, players, matches, selected };
}

function buildPugPlayerSearchEntries(history: PugMatchLog[], ratings: PugEloRating[], settings: PugEloSettings): PugPlayerSearchEntry[] {
  const players = new Map<string, PugPlayerSearchEntry>();
  for (const rating of ratings) {
    players.set(rating.userId, { userId: rating.userId, username: rating.username, rating: rating.rating, updatedAt: rating.updatedAt });
  }
  for (const match of history) {
    for (const userId of match.playerIds) {
      const existing = players.get(userId);
      players.set(userId, {
        userId,
        username: existing?.username ?? match.playerUsernames[userId],
        rating: existing?.rating ?? settings.startingRating,
        updatedAt: existing?.updatedAt
      });
    }
    for (const change of match.eloChanges ?? []) {
      const existing = players.get(change.userId);
      players.set(change.userId, {
        userId: change.userId,
        username: existing?.username ?? change.username ?? match.playerUsernames[change.userId],
        rating: existing?.rating ?? change.after,
        updatedAt: existing?.updatedAt ?? match.updatedAt
      });
    }
  }
  return [...players.values()].sort((a, b) => (a.username ?? a.userId).localeCompare(b.username ?? b.userId));
}

function buildPugPlayerStats(userId: string, players: PugPlayerSearchEntry[], history: PugMatchLog[], ratings: PugEloRating[], settings: PugEloSettings, rankSettings?: PugRankSettings, topMasterUserIds = new Set<string>()): PugPlayerStats {
  const rating = ratings.find((item) => item.userId === userId);
  const knownPlayer = players.find((player) => player.userId === userId);
  const player: PugPlayerSearchEntry = {
    userId,
    username: rating?.username ?? knownPlayer?.username,
    rating: rating?.rating ?? knownPlayer?.rating ?? settings.startingRating,
    updatedAt: rating?.updatedAt ?? knownPlayer?.updatedAt
  };
  const buckets = new Map<PugMatchLog['size'] | 'unknown', PugPlayerModeStats>([
    [6, emptyPugPlayerModeStats(6, pugQueueLabel(6))],
    [12, emptyPugPlayerModeStats(12, pugQueueLabel(12))]
  ]);

  for (const match of history) {
    if (match.status !== 'completed') continue;
    const change = match.eloChanges?.find((item) => item.userId === userId);
    if (!change) continue;
    const mode = match.size === 6 || match.size === 12 ? match.size : 'unknown';
    const stats = buckets.get(mode);
    if (!stats) continue;
    if (isCashoutSecondPlace(match, change.placement)) stats.seconds += 1;
    else if (change.placement === 1 || change.delta > 0) stats.wins += 1;
    else stats.losses += 1;
    stats.total += 1;
  }

  const modes = [...buckets.values()].map(finalizePugPlayerModeStats);
  const totals = finalizePugPlayerModeStats({
    mode: 'all',
    label: 'All modes',
    wins: modes.reduce((sum, mode) => sum + mode.wins, 0),
    seconds: modes.reduce((sum, mode) => sum + mode.seconds, 0),
    losses: modes.reduce((sum, mode) => sum + mode.losses, 0),
    total: modes.reduce((sum, mode) => sum + mode.total, 0),
    winRate: 0
  });
  const fallbackRanks: PugRankSettings = { ranks: [{ id: 'unranked', label: 'Unranked', abbreviation: 'UR', minRating: 0 }] };
  return { player, modes, totals, rank: resolvePugRank(player, rankSettings ?? fallbackRanks, topMasterUserIds) };
}

function emptyPugPlayerModeStats(mode: PugPlayerModeStats['mode'], label: string): PugPlayerModeStats {
  return { mode, label, wins: 0, seconds: 0, losses: 0, total: 0, winRate: 0 };
}

function finalizePugPlayerModeStats(stats: PugPlayerModeStats): PugPlayerModeStats {
  const winningFinishes = stats.wins + stats.seconds;
  return { ...stats, winRate: stats.total ? (winningFinishes / stats.total) * 100 : 0 };
}

function isCashoutSecondPlace(match: PugMatchLog, placement: number) {
  return placement === 2 && getPugTeamCount(match.size) > 2;
}

function getPugTeamCount(size: number) {
  return size === 12 ? 4 : 2;
}

function getPugPlayerPlacementFromResult(match: PugMatchLog, userId: string) {
  const teamIndex = match.teams.findIndex((team) => team.includes(userId));
  if (teamIndex < 0 || !match.result) return undefined;
  const placements = parsePugResultPlacements(match.result, match.teams.length);
  return placements[teamIndex];
}

function parsePugResultPlacements(result: string, teamCount: number) {
  const placements = Array.from({ length: teamCount }, () => teamCount);
  const indexes = [...result.matchAll(/Team\s+(\d+)/gi)].map((match) => Number(match[1]) - 1).filter((index) => Number.isInteger(index) && index >= 0 && index < teamCount);
  if (indexes[0] !== undefined) placements[indexes[0]] = 1;
  if (teamCount > 2 && indexes[1] !== undefined && indexes[1] !== indexes[0]) placements[indexes[1]] = 2;
  for (let index = 0; index < teamCount; index += 1) {
    if (placements[index] === teamCount) placements[index] = teamCount === 2 ? 2 : 3;
  }
  return placements;
}

function pugPlayerSearchPanel(search: PugPlayerSearchState, settings: PugEloSettings) {
  const selected = search.selected;
  return `<div class="pug-player-search">
    <form method="get" action="/administrator/pugs" class="inline-form pug-player-search-form">
      <label>Search players <input name="q" value="${escapeHtml(search.query)}" placeholder="Username or Discord user ID" list="pug-player-options" /></label>
      <button type="submit">Search</button>
      ${search.selectedPlayerId ? `<a class="button secondary" href="/administrator/pugs#elo">Clear selection</a>` : ''}
      <datalist id="pug-player-options">${search.players.map((player) => `<option value="${escapeHtml(player.username ?? player.userId)}" label="${escapeHtml(player.userId)}"></option>`).join('')}</datalist>
    </form>
    ${pugPlayerSearchResults(search)}
    ${selected ? pugSelectedPlayerCard(selected, settings) : '<p><small>Select a player from the search results to view stats and edit their ELO.</small></p>'}
  </div>`;
}

function pugPlayerSearchResults(search: PugPlayerSearchState) {
  if (!search.players.length) return '<p>No PUG players have been tracked yet.</p>';
  if (!search.matches.length) return '<p>No players matched that search.</p>';
  return `<div class="pug-player-search-results">${search.matches.map((player) => {
    const params = new URLSearchParams();
    if (search.query) params.set('q', search.query);
    params.set('playerId', player.userId);
    const selectedClass = search.selectedPlayerId === player.userId ? ' selected' : '';
    return `<a class="pug-player-result${selectedClass}" href="/administrator/pugs?${params.toString()}#elo"><strong>${escapeHtml(player.username ?? player.userId)}</strong><small><code>${escapeHtml(player.userId)}</code> · ${formatElo(player.rating)} ELO</small></a>`;
  }).join('')}</div>`;
}

function pugSelectedPlayerCard(stats: PugPlayerStats, settings: PugEloSettings) {
  const player = stats.player;
  return `<div class="pug-selected-player">
    <div class="section-heading-row">
      <div>
        <h3>${escapeHtml(player.username ?? player.userId)}</h3>
        <p><small><code>${escapeHtml(player.userId)}</code>${player.updatedAt ? ` · ELO updated ${formatDateTime(player.updatedAt)}` : ''}</small></p>
      </div>
      <div class="stat-card"><small>Current ELO</small><strong>${formatElo(player.rating)}</strong></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><small>Total matches</small><strong>${stats.totals.total}</strong></div>
      <div class="stat-card"><small>Wins</small><strong>${stats.totals.wins}</strong></div>
      <div class="stat-card"><small>Seconds</small><strong>${stats.totals.seconds}</strong></div>
      <div class="stat-card"><small>Losses</small><strong>${stats.totals.losses}</strong></div>
      <div class="stat-card"><small>Winrate</small><strong>${formatPercent(stats.totals.winRate)}</strong></div>
    </div>
    ${pugPlayerStatsTables(stats)}
    <div class="admin-team-actions">
      <form method="post" action="/administrator/pugs/elo/player" class="inline-form">
        <input type="hidden" name="userId" value="${escapeHtml(player.userId)}" />
        <input type="hidden" name="username" value="${escapeHtml(player.username ?? '')}" />
        <label>Set ELO <input name="rating" type="number" min="0" required value="${player.rating}" /></label>
        <button type="submit">Save ELO</button>
      </form>
      <form method="post" action="/administrator/pugs/elo/player/reset" class="inline-form">
        <input type="hidden" name="userId" value="${escapeHtml(player.userId)}" />
        <button type="submit">Reset to ${formatElo(settings.startingRating)}</button>
      </form>
    </div>
  </div>`;
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function pugEloChangeSummary(match: PugMatchLog) {
  if (!match.eloChanges?.length) return '';
  const teamTotals = match.teamEloTotals?.length ? `<p><small>Starting team ELO totals: ${match.teamEloTotals.map((total, index) => `Team ${index + 1}: ${formatElo(total)}`).join(' · ')}</small></p>` : '';
  return `${teamTotals}<p><small>ELO changes:</small></p><ul>${match.eloChanges.map((change) => `<li>${escapeHtml(change.username ?? match.playerUsernames[change.userId] ?? change.userId)}: ${change.delta >= 0 ? '+' : ''}${formatElo(change.delta)} (${formatElo(change.before)} → ${formatElo(change.after)})</li>`).join('')}</ul>`;
}

function formatElo(value: number) {
  return Math.round(value).toLocaleString('en-US');
}


function parseRequiredDiscordId(value: string) {
  const [id] = parseDiscordIds(value);
  if (!id) throw new Error('A Discord user ID is required.');
  return id;
}


function administratorRanksPage(settings: PugRankSettings) {
  return `<p><a href="/administrator">← Back to administrator</a></p>
  <section class="card">
    <h2>Rank values and icons</h2>
    <p><small>Adjust ELO ranges and upload optional rank icons. Leave an icon blank to show an empty placeholder. Master Infernal (M1) is always assigned dynamically to the current top three leaderboard players.</small></p>
    <form method="post" action="/administrator/ranks" class="rank-admin-form">
      <div class="rank-admin-list">
        ${settings.ranks.map((rank, index) => rankEditorRow(rank, index)).join('')}
      </div>
      <div class="rank-editor-row master-rank-editor" data-rank-icon-field>
        <div>
          <h3>Master Infernal <span class="pill">M1</span></h3>
          <p><small>Dynamic rank for the top 3 players on the leaderboard. Its ELO range is not editable.</small></p>
        </div>
        <div class="rank-icon-editor">
          <input type="hidden" name="masterIconDataUrl" value="${escapeHtml(settings.masterIconDataUrl ?? '')}" data-rank-icon-data />
          <span class="rank-icon-preview${settings.masterIconDataUrl ? '' : ' is-empty'}" style="${settings.masterIconDataUrl ? `background-image: url('${escapeCssUrl(settings.masterIconDataUrl)}')` : ''}" data-rank-icon-preview>${settings.masterIconDataUrl ? '' : 'No icon'}</span>
          <label class="button secondary">Upload icon <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-rank-icon-input hidden /></label>
          <button type="button" class="secondary" data-rank-icon-clear${settings.masterIconDataUrl ? '' : ' disabled'}>Clear</button>
        </div>
      </div>
      <button type="submit">Save ranks</button>
    </form>
  </section>`;
}

function rankEditorRow(rank: PugRankDefinition, index: number) {
  return `<div class="rank-editor-row" data-rank-icon-field>
    <input type="hidden" name="rankId" value="${escapeHtml(rank.id)}" />
    <label>Name <input name="rankLabel" required maxlength="48" value="${escapeHtml(rank.label)}" /></label>
    <label>Abbrev. <input name="rankAbbreviation" maxlength="8" value="${escapeHtml(rank.abbreviation)}" /></label>
    <label>Minimum ELO <input name="rankMinRating" type="number" min="0" required value="${rank.minRating}" /></label>
    <label>Maximum ELO <input name="rankMaxRating" type="number" min="0" value="${rank.maxRating ?? ''}" placeholder="No maximum" /></label>
    <div class="rank-icon-editor">
      <input type="hidden" name="rankIconDataUrl" value="${escapeHtml(rank.iconDataUrl ?? '')}" data-rank-icon-data />
      <span class="rank-icon-preview${rank.iconDataUrl ? '' : ' is-empty'}" style="${rank.iconDataUrl ? `background-image: url('${escapeCssUrl(rank.iconDataUrl)}')` : ''}" data-rank-icon-preview>${rank.iconDataUrl ? '' : 'No icon'}</span>
      <label class="button secondary">Upload icon <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-rank-icon-input hidden /></label>
      <button type="button" class="secondary" data-rank-icon-clear${rank.iconDataUrl ? '' : ' disabled'}>Clear</button>
    </div>
    <small>Rank ${index + 1}</small>
  </div>`;
}

function parsePugRankSettings(body: Record<string, unknown>): PugRankSettings {
  const ids = formArray(body.rankId);
  const labels = formArray(body.rankLabel);
  const abbreviations = formArray(body.rankAbbreviation);
  const minimums = formArray(body.rankMinRating);
  const maximums = formArray(body.rankMaxRating);
  const icons = formArray(body.rankIconDataUrl);
  const ranks = ids.map((id, index) => {
    const label = labels[index]?.trim() || id;
    const minRating = parsePositiveInteger(minimums[index], `${label} minimum ELO`, 0);
    const maxRaw = maximums[index]?.trim();
    return {
      id: id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48) || `rank-${index + 1}`,
      label: label.slice(0, 48),
      abbreviation: (abbreviations[index]?.trim() ?? '').slice(0, 8),
      minRating,
      maxRating: maxRaw ? parsePositiveInteger(maxRaw, `${label} maximum ELO`, minRating) : undefined,
      iconDataUrl: parseOptionalRankIcon(icons[index])
    };
  });
  if (!ranks.length) throw new Error('At least one rank is required.');
  const masterIconDataUrl = parseOptionalRankIcon(String(body.masterIconDataUrl ?? ''));
  return { ranks, masterIconDataUrl };
}

function formArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? ''));
  return value === undefined ? [] : [String(value)];
}

function parseOptionalRankIcon(value: unknown) {
  const dataUrl = String(value ?? '').trim();
  if (!dataUrl) return undefined;
  if (dataUrl.length > 1_000_000) throw new Error('Rank icons must be 1 MB or smaller.');
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('Rank icons must be PNG, JPEG, WebP, or GIF images.');
  return dataUrl;
}

function parsePugEloSettings(body: Record<string, unknown>): PugEloSettings {
  return {
    startingRating: parsePositiveInteger(body.startingRating, 'Starting ELO', 1),
    baseChange: parsePositiveInteger(body.baseChange, 'Base ELO gain', 1),
    strength: parseDecimalInRange(body.strength, 'ELO strength', 0.1, 5),
    finalRoundMultiplier: parseDecimalInRange(body.finalRoundMultiplier, 'Final Round ELO value', 0, 5),
    cashoutMultiplier: parseDecimalInRange(body.cashoutMultiplier, 'Cashout ELO value', 0, 5)
  };
}

function formatMultiplierInput(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function parseDecimalInRange(value: unknown, label: string, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  return number;
}

function pugQueueLabel(size: number) {
  return size === 12 ? 'Cashout' : 'Final Round';
}

function modeLabel(mode: string) {
  return mode === 'captains' ? 'Captains' : 'Random teams';
}

function developerPage(
  stats: Awaited<ReturnType<TeamBotApi['getDeveloperStats']>>,
  teamCount: number,
  settings: { botStatus?: BotStatus; activityName?: string; activityType?: BotActivityType },
  logs: CapturedLog[],
  seasons: PugSeason[],
  rankSettings: PugRankSettings
) {
  return `<p><a href="/events">← Back to events</a></p>
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

    ${developerSeasonsPanel(seasons, rankSettings)}

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


function developerSeasonsPanel(seasons: PugSeason[], rankSettings: PugRankSettings) {
  const active = seasons.find((season) => season.status === 'active') ?? seasons[seasons.length - 1];
  if (!active) return '';
  const rewards = completeWebSeasonRewards(active, rankSettings);
  return `<section class="card" id="seasons">
    <h2>PUG seasons</h2>
    <p><small>Only the configured developer can change seasons. Seasons do not end unless you end them here; the optional end date is a planning label for staff.</small></p>
    <div class="stat-grid">
      <div class="stat-card"><small>Active season</small><strong>${escapeHtml(active.label)}</strong></div>
      <div class="stat-card"><small>Started</small><strong>${formatDateTime(active.startsAt)}</strong></div>
      <div class="stat-card"><small>Scheduled end</small><strong>${active.endsAt ? formatDateTime(active.endsAt) : 'No end date'}</strong></div>
    </div>
    <form method="post" action="/developer/seasons/config" class="rank-admin-form">
      <input type="hidden" name="seasonId" value="${escapeHtml(active.id)}" />
      <div class="rank-editor-row">
        <label>Season label <input name="label" maxlength="32" value="${escapeHtml(active.label)}" required /></label>
        <label>End date <input name="endsAt" type="datetime-local" value="${escapeHtml(toDateTimeLocal(active.endsAt))}" /></label>
      </div>
      <h3>Badge rewards</h3>
      <p><small>Labels and icons are awarded at season end by season and rank. Master Infernal is awarded only to players who finish in Master Infernal.</small></p>
      <div class="rank-admin-list">${rewards.map((reward) => seasonRewardEditorRow(reward)).join('')}</div>
      <button type="submit">Save season configuration</button>
    </form>
    <form method="post" action="/developer/seasons/end" class="inline-form danger-zone" onsubmit="return confirm('End the active season, award badges, snapshot top 10, reset ELO, and start the next season?');">
      <label>Next season label <input name="nextSeasonLabel" placeholder="S${nextSeasonNumber(seasons)}" /></label>
      <button class="danger" type="submit">End season and start next</button>
    </form>
    ${seasons.filter((season) => season.status === 'completed').length ? `<h3>Completed seasons</h3><ul>${seasons.filter((season) => season.status === 'completed').map((season) => `<li>${escapeHtml(season.label)} ended ${season.endedAt ? formatDateTime(season.endedAt) : 'unknown'}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function seasonRewardEditorRow(reward: PugSeasonBadgeReward) {
  return `<div class="rank-editor-row" data-rank-icon-field>
    <input type="hidden" name="rewardRankId" value="${escapeHtml(reward.rankId)}" />
    <label>Rank <input value="${escapeHtml(reward.rankId)}" disabled /></label>
    <label>Badge label <input name="rewardLabel" maxlength="64" value="${escapeHtml(reward.label)}" required /></label>
    <label>Abbrev. <input name="rewardAbbreviation" maxlength="12" value="${escapeHtml(reward.abbreviation ?? '')}" /></label>
    <div class="rank-icon-editor">
      <input type="hidden" name="rewardIconDataUrl" value="${escapeHtml(reward.iconDataUrl ?? '')}" data-rank-icon-data />
      <span class="rank-icon-preview${reward.iconDataUrl ? '' : ' is-empty'}" style="${reward.iconDataUrl ? `background-image: url('${escapeCssUrl(reward.iconDataUrl)}')` : ''}" data-rank-icon-preview>${reward.iconDataUrl ? '' : 'No icon'}</span>
      <label class="button secondary">Upload icon <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-rank-icon-input hidden /></label>
      <button type="button" class="secondary" data-rank-icon-clear${reward.iconDataUrl ? '' : ' disabled'}>Clear</button>
    </div>
  </div>`;
}

function completeWebSeasonRewards(season: PugSeason, rankSettings: PugRankSettings): PugSeasonBadgeReward[] {
  const existing = new Map(season.badgeRewards.map((reward) => [reward.rankId, reward]));
  const normalRewards = rankSettings.ranks.map((rank) => existing.get(rank.id) ?? { rankId: rank.id, label: `${season.label} ${rank.label}`, abbreviation: rank.abbreviation, iconDataUrl: rank.iconDataUrl });
  return [...normalRewards, existing.get('master-infernal') ?? { rankId: 'master-infernal', label: `${season.label} Master Infernal`, abbreviation: 'M1', iconDataUrl: rankSettings.masterIconDataUrl }];
}

function nextSeasonNumber(seasons: PugSeason[]) {
  return Math.max(1, ...seasons.map((season) => Number(season.id.match(/s(\d+)/)?.[1] ?? 0))) + 1;
}

function toDateTimeLocal(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

function parseOptionalDateTime(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error('Season end date is invalid.');
  return date.toISOString();
}

function parsePugSeasonBadgeRewards(body: Record<string, unknown>): PugSeasonBadgeReward[] {
  const rankIds = formArray(body.rewardRankId);
  const labels = formArray(body.rewardLabel);
  const abbreviations = formArray(body.rewardAbbreviation);
  const icons = formArray(body.rewardIconDataUrl);
  return rankIds.map((rankId, index) => ({
    rankId: rankId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    label: (labels[index]?.trim() || rankId).slice(0, 64),
    abbreviation: abbreviations[index]?.trim().slice(0, 12) || undefined,
    iconDataUrl: parseOptionalRankIcon(icons[index])
  })).filter((reward) => reward.rankId && reward.label);
}

function statCard(label: string, value: string) {
  return `<div class="stat-card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function logRow(log: CapturedLog) {
  return `<div class="log-row log-${log.level}"><span>${formatDateTime(log.createdAt)}</span><span>${escapeHtml(log.level.toUpperCase())}</span><pre>${escapeHtml(log.message)}</pre></div>`;
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

function teamPageSection(
  team: Team | undefined,
  userId: string,
  members: TeamMemberDetail[] = [],
  registrations: TeamPageRegistrationDetail[] = []
) {
  if (!team) {
    return `<p>You are not currently in a team.</p><p><a class="button" href="/teams/new">Create Team</a></p>`;
  }

  const isCaptain = team.ownerId === userId;
  const currentMember = members.find((member) => member.userId === userId);
  return `<section class="card">
      <div class="section-heading-row">
        <div>
          <p class="eyebrow">${isCaptain ? 'Team captain' : 'Team member'}</p>
          <h2>${escapeHtml(team.name)}</h2>
          <p><small>Your role: <strong>${escapeHtml(teamRoleLabel(currentMember?.role ?? (isCaptain ? 'captain' : 'main')))}</strong> · Discord role <code>${escapeHtml(team.roleId)}</code></small></p>
        </div>
        ${isCaptain ? `<a class="button" href="/teams/${encodeURIComponent(team.id)}">Manage Team</a>` : ''}
      </div>
      ${
        isCaptain
          ? '<p>Use the manage page to invite members, update roles, edit team settings, or delete the team.</p>'
          : `<form method="post" action="/teams/leave" onsubmit="return confirm('Leave ${escapeJsString(team.name)}? You will lose access to its private channels.');">
              <button class="danger" type="submit">Leave team</button>
            </form>`
      }
    </section>

    <section class="card">
      <div class="section-heading-row">
        <div>
          <p class="eyebrow">Roster</p>
          <h2>Team members and roles</h2>
        </div>
        <span class="event-capacity">${members.length} member${members.length === 1 ? '' : 's'}</span>
      </div>
      ${teamRosterSection(members)}
    </section>

    <section class="card">
      <div class="section-heading-row">
        <div>
          <p class="eyebrow">Registrations</p>
          <h2>Registered events</h2>
        </div>
        <span class="event-capacity">${registrations.length} event${registrations.length === 1 ? '' : 's'}</span>
      </div>
      ${teamRegisteredEventsSection(registrations, members)}
    </section>`;
}

function teamRosterSection(members: TeamMemberDetail[]) {
  if (!members.length) return '<p>No team members were found.</p>';

  return `<div class="management-list">
    ${members.map((member) => teamRosterMember(member)).join('')}
  </div>`;
}

function teamRosterMember(member: TeamMemberDetail) {
  return `<div class="managed-member">
    ${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="" />` : '<span class="avatar-placeholder"></span>'}
    <div class="member-info">
      <strong>${escapeHtml(member.displayName)}</strong> ${member.isOwner ? '<span class="pill">captain</span>' : ''}<br />
      <small>@${escapeHtml(member.username)}</small>
    </div>
    <span class="role-label">${escapeHtml(teamRoleLabel(member.role))}</span>
  </div>`;
}

function teamRegisteredEventsSection(registrations: TeamPageRegistrationDetail[], members: TeamMemberDetail[]) {
  if (!registrations.length) return '<p>This team is not registered for any events yet.</p>';

  return `<div class="management-list">
    ${registrations.map((detail) => teamRegisteredEvent(detail, members)).join('')}
  </div>`;
}

function teamRegisteredEvent(detail: TeamPageRegistrationDetail, members: TeamMemberDetail[]) {
  const memberNames = new Map(members.map((member) => [member.userId, member.displayName]));
  const listNames = (ids: string[]) => ids.map((id) => escapeHtml(memberNames.get(id) ?? id)).join(', ') || 'None selected';
  return `<div class="admin-team-row">
    <div>
      <strong>${escapeHtml(detail.event.title)}</strong> <span class="pill">${escapeHtml(eventStateLabel(eventState(detail.event)))}</span><br />
      <small>${formatDateTime(detail.event.startsAt)} – ${formatDateTime(detail.event.endsAt)}</small><br />
      <small>Main: ${listNames(detail.registration.mainPlayerIds)}</small><br />
      <small>Subs: ${listNames(detail.registration.substitutePlayerIds)}</small>
    </div>
    <a class="button secondary" href="/events/${encodeURIComponent(detail.event.id)}/registrations">View event teams</a>
  </div>`;
}

function teamForm() {
  return `<form method="post" action="/teams" onsubmit="const button = this.querySelector('button[type=submit]'); if (button) { button.disabled = true; button.textContent = 'Creating team…'; }">
    <label>Team name <input name="teamName" maxlength="80" required /></label>
    ${invitePicker('Create Team', 'You can invite server members now, or create the team first and invite members later from the manage team page.')}
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
  return `<p><a href="${canManageAllTeams ? '/administrator' : '/team'}">← Back to ${canManageAllTeams ? 'administrator' : 'team'}</a></p>
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
      <small>@${escapeHtml(invite.username)} · invited ${formatDateTime(invite.createdAt)}</small>
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
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return `<time datetime="${escapeHtml(date.toISOString())}" data-local-date-time>${escapeHtml(date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }))}</time>`;
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return `<time datetime="${escapeHtml(date.toISOString())}" data-local-date>${escapeHtml(date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', timeZone: 'UTC' }))}</time>`;
}

function layout(title: string, body: string, options: LayoutOptions = {}) {
  const nav = navigation(options);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · 7th Circle</title>
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
    .hero-card p:not(.eyebrow) { color: var(--muted); max-width: 42rem; font-size: 1.05rem; line-height: 1.6; }
    .home-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(13rem, 18rem); gap: clamp(1rem, 5vw, 3rem); align-items: center; }
    .hero-actions { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.4rem; }
    .discord-panel { position: relative; z-index: 1; display: grid; gap: .45rem; padding: 1.2rem; border: 1px solid rgba(88,101,242,.38); border-radius: 1.15rem; background: linear-gradient(145deg, rgba(88,101,242,.22), rgba(18,20,26,.86)); box-shadow: 0 20px 45px rgba(88,101,242,.12); }
    .discord-icon { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: 1rem; background: #5865f2; color: #fff; font-size: 1.5rem; font-weight: 900; }
    .discord-button { background: linear-gradient(135deg, #5865f2, #3843c7); box-shadow: 0 12px 30px rgba(88,101,242,.25); }
    .join-card { max-width: 820px; margin: 0 auto; }
    .eyebrow { margin: 0 0 .75rem; color: var(--red-strong); text-transform: uppercase; letter-spacing: .16em; font-size: .78rem; font-weight: 900; }
    .button, button { background: linear-gradient(135deg, var(--red), #8f0617); color: white; border: 0; border-radius: .8rem; padding: .78rem 1rem; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .4rem; font-weight: 800; box-shadow: 0 12px 30px rgba(201,8,32,.22); }
    button:hover, .button:hover { transform: translateY(-1px); color: white; }
    .secondary { background: #2b2f38; box-shadow: none; } .danger { background: linear-gradient(135deg, #ef233c, #9f0719); } .danger-zone { border-color: rgba(239,35,60,.45); }
    input, select, textarea { border-radius: .7rem; border: 1px solid var(--line); padding: .68rem .78rem; margin-left: .5rem; background: #0f1116; color: var(--text); outline: none; }
    textarea { min-height: 8rem; resize: vertical; }
    input:focus, select:focus, textarea:focus { border-color: var(--red-strong); box-shadow: 0 0 0 3px rgba(239,35,60,.18); }
    input[type="color"] { width: 4rem; height: 2.6rem; padding: .2rem; vertical-align: middle; }
    .card { background: linear-gradient(180deg, rgba(32,35,43,.96), rgba(23,25,31,.96)); border: 1px solid rgba(255,255,255,.08); border-radius: 1.1rem; padding: 1.15rem; margin: 1rem 0; box-shadow: 0 18px 45px rgba(0,0,0,.24); }
    .subsection { margin-top: 1.2rem; padding-top: 1.2rem; border-top: 1px solid rgba(255,255,255,.08); }
    .subsection h3 { margin-top: 0; letter-spacing: -.02em; }
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
    .event-card { position: relative; overflow: hidden; border-color: rgba(239,35,60,.2); }
    .event-card > * { position: relative; z-index: 1; }
    .event-card-with-photo::before { content: ""; position: absolute; inset: 0; z-index: 0; background-image: linear-gradient(90deg, rgba(23,25,31,.95), rgba(23,25,31,.78)), var(--event-photo); background-size: cover; background-position: center; filter: saturate(.9); }
    .timezone-note { margin: .85rem 0 -.35rem; color: var(--muted); font-size: .82rem; font-weight: 800; }
    .event-actions { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-top: 1rem; }
    .event-capacity { border: 1px solid rgba(239,35,60,.32); border-radius: 999px; padding: .35rem .7rem; background: var(--red-soft); color: #ffd4d9; font-weight: 900; }
    .event-meta-grid, .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .event-photo-field { display: grid; grid-template-columns: minmax(0, 1fr) 12rem auto; gap: .75rem; align-items: end; padding: .85rem; border: 1px solid var(--line); border-radius: 1rem; background: #12141a; }
    .event-photo-preview { min-height: 6.5rem; border: 1px solid rgba(255,255,255,.12); border-radius: .8rem; background-color: #0f1116; background-size: cover; background-position: center; display: grid; place-items: center; color: var(--muted); font-size: .82rem; font-weight: 800; }
    .event-photo-preview.is-empty { border-style: dashed; }
    .stacked-form { display: grid; gap: 1rem; }
    .stacked-form label { display: grid; gap: .35rem; font-weight: 800; }
    .stacked-form input, .stacked-form select, .stacked-form textarea { margin-left: 0; width: 100%; }
    fieldset { border: 1px solid var(--line); border-radius: 1rem; padding: 1rem; }
    legend { padding: 0 .35rem; font-weight: 900; }
    .checkbox-list { display: grid; gap: .5rem; }
    .checkbox-row { display: flex; align-items: center; gap: .6rem; background: #12141a; border: 1px solid var(--line); border-radius: .85rem; padding: .7rem; }
    .checkbox-row input { width: auto; margin: 0; }
    .modern-checkbox-list { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .modern-checkbox-row { position: relative; align-items: stretch; gap: .75rem; padding: .85rem; cursor: pointer; transition: border-color .18s ease, background .18s ease, transform .18s ease; }
    .modern-checkbox-row:hover { border-color: rgba(239,35,60,.6); background: #171a22; transform: translateY(-1px); }
    .modern-checkbox-row input { position: absolute; opacity: 0; pointer-events: none; }
    .checkbox-control { display: grid; place-items: center; flex: 0 0 1.35rem; width: 1.35rem; height: 1.35rem; border: 1px solid rgba(255,255,255,.24); border-radius: .45rem; background: #0f1116; box-shadow: inset 0 0 0 2px rgba(0,0,0,.18); }
    .checkbox-control::after { content: "✓"; opacity: 0; transform: scale(.65); color: white; font-weight: 950; transition: opacity .18s ease, transform .18s ease; }
    .modern-checkbox-row input:checked + .checkbox-control { border-color: rgba(239,35,60,.95); background: linear-gradient(135deg, var(--red), #8f0617); box-shadow: 0 0 0 3px rgba(239,35,60,.18); }
    .modern-checkbox-row input:checked + .checkbox-control::after { opacity: 1; transform: scale(1); }
    .modern-checkbox-row:has(input:checked) { border-color: rgba(239,35,60,.72); background: linear-gradient(135deg, rgba(239,35,60,.16), rgba(18,20,26,.96)); }
    .checkbox-user { display: grid; gap: .18rem; min-width: 0; }
    .checkbox-user strong, .checkbox-user small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
    .leaderboard-list { position: relative; counter-reset: leaderboard-rank; display: grid; gap: .65rem; padding: .7rem; list-style: none; border: 1px solid rgba(251, 146, 60, .42); border-radius: 1.25rem; background: linear-gradient(#0f1116, #0f1116) padding-box, linear-gradient(120deg, #ef4444, #f97316, #facc15, #f97316, #ef4444) border-box; box-shadow: 0 0 18px rgba(239, 68, 68, .24), 0 0 28px rgba(249, 115, 22, .18), 0 0 38px rgba(250, 204, 21, .12), inset 0 0 24px rgba(249, 115, 22, .06); animation: leaderboard-outline-glow 3.6s ease-in-out infinite, leaderboard-outline-flow 8s linear infinite; background-size: 100% 100%, 300% 300%; }
    .leaderboard-list li, .leaderboard-player { display: flex; align-items: center; gap: .75rem; }
    .leaderboard-list li { position: relative; z-index: 1; counter-increment: leaderboard-rank; justify-content: space-between; border: 1px solid var(--line); border-radius: 1rem; background: #12141a; padding: .75rem .85rem; }
    .leaderboard-list li::before { content: counter(leaderboard-rank); display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: 999px; background: var(--red-soft); color: var(--red-strong); font-weight: 900; flex: 0 0 auto; }
    .leaderboard-player { min-width: 0; color: var(--text); text-decoration: none; flex: 1 1 auto; }
    .leaderboard-player span { display: grid; min-width: 0; }
    .leaderboard-player strong, .leaderboard-player small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .leaderboard-entry.leaderboard-infernal:not(.leaderboard-master) { position: relative; border-color: rgba(250, 204, 21, .42); background: radial-gradient(ellipse at 18% 50%, rgba(250, 204, 21, .2), rgba(234, 179, 8, .07) 42%, transparent 72%), linear-gradient(135deg, rgba(113, 63, 18, .24), #12141a 62%); box-shadow: 0 0 18px rgba(250, 204, 21, .14), inset 0 0 26px rgba(250, 204, 21, .07); }
    .leaderboard-infernal:not(.leaderboard-master) .leaderboard-player strong { display: inline-block; color: #fde047; background: linear-gradient(105deg, #facc15 0%, #fef08a 18%, #fff7ad 32%, #eab308 48%, #fde047 64%, #fef9c3 78%, #facc15 100%); background-size: 240% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; text-shadow: 0 0 10px rgba(250, 204, 21, .68), 0 0 22px rgba(234, 179, 8, .34); animation: leaderboard-yellow-shimmer 2.6s linear infinite; }
    .leaderboard-entry.leaderboard-master { position: relative; border-color: rgba(239, 68, 68, .8); background: radial-gradient(ellipse at 18% 50%, rgba(251, 146, 60, .28), rgba(239, 68, 68, .1) 38%, transparent 72%), linear-gradient(135deg, rgba(124, 45, 18, .38), #12141a 60%); box-shadow: 0 0 18px rgba(251, 146, 60, .18), 0 0 24px rgba(239, 68, 68, .2), inset 0 0 28px rgba(251, 146, 60, .1); }
    .leaderboard-entry.leaderboard-master::after { content: ''; position: absolute; inset: -.8rem auto -.8rem 2.2rem; width: min(18rem, 58%); pointer-events: none; background: radial-gradient(ellipse, rgba(251, 146, 60, .22), transparent 70%); filter: blur(12px); }
    .leaderboard-master .leaderboard-player, .leaderboard-master .leaderboard-rank, .leaderboard-master > span:not(.leaderboard-rank) { position: relative; z-index: 1; }
    .leaderboard-master .leaderboard-player span, .leaderboard-master .leaderboard-player strong { overflow: visible; }
    .leaderboard-master .leaderboard-player strong { display: inline-block; color: #fb923c; background: linear-gradient(105deg, #ea580c 0%, #fb923c 18%, #fed7aa 32%, #f97316 48%, #c2410c 64%, #fdba74 78%, #ea580c 100%); background-size: 240% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; text-shadow: 0 0 10px rgba(251, 146, 60, .72), 0 0 22px rgba(239, 68, 68, .42); animation: leaderboard-orange-shimmer 2.4s linear infinite; }
    .leaderboard-master .leaderboard-player strong::before, .leaderboard-master .leaderboard-player strong::after { content: '🔥'; margin: 0 .2rem; filter: drop-shadow(0 0 6px rgba(251, 146, 60, .7)); -webkit-text-fill-color: initial; }
    .leaderboard-rank { flex: 0 0 auto; }
    .rank-badge { display: inline-flex; align-items: center; gap: .4rem; color: #f5d0fe; font-weight: 900; white-space: nowrap; }
    .rank-badge.rank-bronze { color: #cd7f32; }
    .rank-badge.rank-silver { color: #c0c0c0; }
    .rank-badge.rank-gold { color: #facc15; }
    .rank-badge.rank-platinum { color: #67e8f9; }
    .rank-badge.rank-diamond { color: #60a5fa; }
    .rank-badge.rank-infernal { color: #f97316; text-shadow: 0 0 10px rgba(249, 115, 22, .35); }
    .rank-badge.master-rank { color: #c2410c; text-shadow: 0 0 12px rgba(251, 146, 60, .72); }
    @keyframes leaderboard-outline-glow { 0%, 100% { box-shadow: 0 0 16px rgba(239, 68, 68, .2), 0 0 28px rgba(249, 115, 22, .16), 0 0 38px rgba(250, 204, 21, .1), inset 0 0 22px rgba(249, 115, 22, .05); } 50% { box-shadow: 0 0 24px rgba(239, 68, 68, .36), 0 0 42px rgba(249, 115, 22, .32), 0 0 58px rgba(250, 204, 21, .22), inset 0 0 34px rgba(250, 204, 21, .1); } }
    @keyframes leaderboard-outline-flow { 0% { background-position: 0 0, 0% 50%; } 100% { background-position: 0 0, 300% 50%; } }
    @keyframes leaderboard-yellow-shimmer { 0% { background-position: 140% 50%; filter: drop-shadow(0 0 2px rgba(250, 204, 21, .35)); } 50% { filter: drop-shadow(0 0 8px rgba(250, 204, 21, .72)); } 100% { background-position: -100% 50%; filter: drop-shadow(0 0 2px rgba(250, 204, 21, .35)); } }
    @keyframes leaderboard-orange-shimmer { 0% { background-position: 140% 50%; filter: drop-shadow(0 0 2px rgba(251, 146, 60, .38)); } 50% { filter: drop-shadow(0 0 9px rgba(251, 146, 60, .76)); } 100% { background-position: -100% 50%; filter: drop-shadow(0 0 2px rgba(251, 146, 60, .38)); } }
    @media (prefers-reduced-motion: reduce) { .leaderboard-list, .leaderboard-infernal:not(.leaderboard-master) .leaderboard-player strong, .leaderboard-master .leaderboard-player strong { animation: none; } }
    .rank-icon { width: 1.6rem; height: 1.6rem; border-radius: .4rem; object-fit: cover; background: #0f1116; border: 1px solid var(--line); flex: 0 0 auto; }
    .rank-icon-empty { display: inline-block; }
    .rank-admin-form, .rank-admin-list { display: grid; gap: 1rem; }

    .badge-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .75rem; }
    .badge-grid-compact { grid-template-columns: repeat(auto-fit, minmax(11rem, max-content)); }
    .badge-option { display: grid; gap: .45rem; border: 1px solid var(--line); border-radius: 1rem; padding: .8rem; background: rgba(255,255,255,.025); }
    .season-badge { display: inline-flex; align-items: center; gap: .55rem; border: 1px solid var(--line); border-radius: 999px; padding: .35rem .7rem; background: #12141a; }
    .season-badge > span:last-child { display: grid; line-height: 1.1; }
    .season-badge small { color: var(--muted); }
    .profile-badges { margin: 1rem 0; display: grid; gap: .75rem; }
    .season-leaderboards { display: grid; gap: 1rem; }
    .compact-leaderboard .leaderboard-entry { grid-template-columns: minmax(10rem, 1fr) auto auto; }
    .rank-editor-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .75rem; align-items: end; padding: 1rem; border: 1px solid var(--line); border-radius: 1rem; background: #12141a; }
    .master-rank-editor { grid-template-columns: minmax(14rem, 1fr) auto; }
    .rank-icon-editor { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .rank-icon-preview { display: grid; place-items: center; width: 3rem; height: 3rem; border: 1px dashed rgba(255,255,255,.24); border-radius: .75rem; background-color: #0f1116; background-size: cover; background-position: center; color: var(--muted); font-size: .65rem; text-align: center; }
    .rank-icon-preview.is-empty { background-image: none !important; }
    .leaderboard-profile-section { position: relative; overflow: hidden; }
    .leaderboard-profile-section > * { position: relative; z-index: 1; }
    .leaderboard-profile-section.profile-infernal:not(.profile-master) { border-color: rgba(250, 204, 21, .48); background: radial-gradient(ellipse at 20% 14%, rgba(250, 204, 21, .24), rgba(234, 179, 8, .08) 42%, transparent 72%), #12141a; box-shadow: 0 0 24px rgba(250, 204, 21, .18), inset 0 0 36px rgba(250, 204, 21, .07); }
    .leaderboard-profile-section.profile-infernal:not(.profile-master) h2 { color: #fde047; text-shadow: 0 0 12px rgba(250, 204, 21, .72), 0 0 24px rgba(234, 179, 8, .36); }
    .leaderboard-profile-section.profile-master { border-color: rgba(239, 68, 68, .86); background: radial-gradient(ellipse at 20% 14%, rgba(251, 146, 60, .3), rgba(239, 68, 68, .1) 42%, transparent 74%), #12141a; box-shadow: 0 0 22px rgba(251, 146, 60, .2), 0 0 30px rgba(239, 68, 68, .24), inset 0 0 38px rgba(251, 146, 60, .1); }
    .leaderboard-profile-section.profile-master h2 { color: #fb923c; text-shadow: 0 0 12px rgba(251, 146, 60, .72), 0 0 24px rgba(239, 68, 68, .44); }
    .leaderboard-profile-card { margin-bottom: 1rem; }
    .leaderboard-player-search { display: grid; gap: .75rem; margin-top: 1.25rem; padding-top: 1.25rem; border-top: 1px solid var(--line); }
    .leaderboard-player-search h3, .leaderboard-player-search p { margin: 0; }
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
    .pug-admin-match { display: grid; gap: .85rem; background: rgba(255,255,255,.025); border: 1px solid var(--line); border-radius: 1rem; padding: 1rem; }
    .pug-admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
    .pug-admin-grid h3 { margin: 0 0 .45rem; }
    .pug-elo-preview { margin-top: 1rem; display: grid; gap: .75rem; }
    .pug-elo-preview-team { border-top: 1px solid var(--line); padding-top: .75rem; }
    .pug-elo-preview-table { display: grid; grid-template-columns: minmax(7rem, 1fr) repeat(4, auto); gap: .35rem .7rem; align-items: center; margin-top: .5rem; font-size: .84rem; }
    .pug-elo-preview-table > span:nth-child(-n+5), .pug-player-stats-table-with-seconds > span:nth-child(-n+5), .pug-player-stats-table-no-seconds > span:nth-child(-n+4) { color: var(--muted); font-weight: 700; }
    .pug-player-search { display: grid; gap: 1rem; }
    .pug-player-search-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .5rem; }
    .pug-player-result { display: grid; gap: .2rem; border: 1px solid var(--line); border-radius: .85rem; padding: .7rem .8rem; background: #12141a; color: var(--text); text-decoration: none; }
    .pug-player-result:hover, .pug-player-result.selected { border-color: rgba(239,35,60,.72); background: linear-gradient(135deg, rgba(239,35,60,.16), rgba(18,20,26,.96)); }
    .pug-selected-player { display: grid; gap: 1rem; border: 1px solid var(--line); border-radius: 1rem; padding: 1rem; background: rgba(255,255,255,.025); }
    .pug-player-stats-tables { display: grid; gap: .75rem; }
    .pug-player-stats-table { display: grid; gap: .45rem .8rem; align-items: center; }
    .pug-player-stats-table-with-seconds { grid-template-columns: minmax(9rem, 1fr) repeat(4, auto); }
    .pug-player-stats-table-no-seconds { grid-template-columns: minmax(9rem, 1fr) repeat(3, auto); }
    .elo-gain { color: #86efac; }
    .elo-loss { color: #fca5a5; }
    .pug-player { display: block; margin: .2rem 0; }
    .pug-history { display: grid; gap: 1rem; }
    .member-info { flex: 1 1 12rem; }
    .member img, .managed-member img, .leaderboard-player img, .avatar-placeholder { width: 38px; height: 38px; border-radius: 999px; background: #2b2f38; object-fit: cover; flex: 0 0 auto; }
    .profile-card { display: flex; align-items: center; gap: 1.25rem; }
    .profile-avatar { width: 96px; height: 96px; border-radius: 1.25rem; border: 2px solid rgba(239,35,60,.7); object-fit: cover; }
    .inline-form { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .pill, .role-label { display: inline-block; margin-left: .35rem; padding: .16rem .5rem; border-radius: 999px; background: var(--red-soft); color: #ffb3bc; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
    small { color: var(--muted); } code { background: #0f1116; border: 1px solid var(--line); border-radius: .35rem; padding: .15rem .35rem; color: #ffd4d9; }
    @media (max-width: 720px) { .home-hero { grid-template-columns: 1fr; } .discord-panel { display: none; } .event-photo-field { grid-template-columns: 1fr; align-items: stretch; } .log-row { grid-template-columns: 1fr; } .topbar { align-items: stretch; flex-direction: column; } .nav-shell, .nav-groups { align-items: stretch; flex-direction: column; justify-content: space-between; } .nav-links { overflow-x: auto; border-radius: .9rem; } .account-link span { display: none; } main { padding-top: 2rem; } .profile-card { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>${nav}<main><header class="page-header"><h1>${escapeHtml(title)}</h1></header>${body}</main><script>
  (() => {
    const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const dateFormatter = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', year: '2-digit' });
    document.querySelectorAll('[data-local-date-time]').forEach((element) => {
      const value = element.getAttribute('datetime');
      const date = value ? new Date(value) : undefined;
      if (date && !Number.isNaN(date.getTime())) element.textContent = dateTimeFormatter.format(date);
    });
    document.querySelectorAll('[data-local-date]').forEach((element) => {
      const value = element.getAttribute('datetime');
      const date = value ? new Date(value) : undefined;
      if (date && !Number.isNaN(date.getTime())) element.textContent = dateFormatter.format(date);
    });

    document.querySelectorAll('[data-event-photo-field]').forEach((field) => {
      const input = field.querySelector('[data-event-photo-input]');
      const hidden = field.querySelector('[data-event-photo-data]');
      const preview = field.querySelector('[data-event-photo-preview]');
      const clear = field.querySelector('[data-event-photo-clear]');
      if (!(input instanceof HTMLInputElement) || !(hidden instanceof HTMLInputElement) || !(preview instanceof HTMLElement) || !(clear instanceof HTMLButtonElement)) return;

      const renderPreview = (dataUrl) => {
        hidden.value = dataUrl;
        preview.style.backgroundImage = dataUrl ? "url('" + dataUrl + "')" : '';
        preview.textContent = dataUrl ? '' : 'No photo';
        preview.classList.toggle('is-empty', !dataUrl);
        clear.disabled = !dataUrl;
      };

      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
          alert('Please choose a PNG, JPEG, WebP, or GIF image.');
          input.value = '';
          return;
        }
        if (file.size > 2 * 1024 * 1024) {
          alert('Please choose an image that is 2 MB or smaller.');
          input.value = '';
          return;
        }
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          if (typeof reader.result === 'string') renderPreview(reader.result);
        });
        reader.readAsDataURL(file);
      });

      clear.addEventListener('click', () => {
        input.value = '';
        renderPreview('');
      });
    });

    document.querySelectorAll('[data-rank-icon-field]').forEach((field) => {
      const input = field.querySelector('[data-rank-icon-input]');
      const hidden = field.querySelector('[data-rank-icon-data]');
      const preview = field.querySelector('[data-rank-icon-preview]');
      const clear = field.querySelector('[data-rank-icon-clear]');
      if (!(input instanceof HTMLInputElement) || !(hidden instanceof HTMLInputElement) || !(preview instanceof HTMLElement) || !(clear instanceof HTMLButtonElement)) return;

      const renderPreview = (dataUrl) => {
        hidden.value = dataUrl;
        preview.style.backgroundImage = dataUrl ? "url('" + dataUrl + "')" : '';
        preview.textContent = dataUrl ? '' : 'No icon';
        preview.classList.toggle('is-empty', !dataUrl);
        clear.disabled = !dataUrl;
      };

      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
          alert('Please choose a PNG, JPEG, WebP, or GIF image.');
          input.value = '';
          return;
        }
        if (file.size > 700 * 1024) {
          alert('Please choose an icon that is 700 KB or smaller.');
          input.value = '';
          return;
        }
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          if (typeof reader.result === 'string') renderPreview(reader.result);
        });
        reader.readAsDataURL(file);
      });

      clear.addEventListener('click', () => {
        input.value = '';
        renderPreview('');
      });
    });
  })();
</script></body>
</html>`;
}

function navigation(options: LayoutOptions) {
  const currentTeam = options.currentTeam ?? requestLayoutContext.getStore()?.currentTeam;
  const activeClass = (key: LayoutOptions['active']) => options.active === key ? ' class="active"' : '';
  const eventManagementLink = options.user && options.isAdmin ? `<a href="/event-management"${activeClass('event-management')}>Event management</a>` : '';
  const adminLink = options.user && options.isAdmin ? `<a href="/administrator"${activeClass('administrator')}>Administrator</a>` : '';
  const developerLink = options.user && (options.isDeveloper || isDeveloperUser(options.user)) ? `<a href="/developer"${activeClass('developer')}>Developer</a>` : '';
  const userControls = options.user
    ? `<a class="account-link${options.active === 'settings' ? ' active' : ''}" href="/settings" title="Open account settings"><img src="${escapeHtml(discordAvatarUrl(options.user))}" alt="" /><span>${escapeHtml(displayUser(options.user))}</span></a>`
    : '<a class="button" href="/auth/discord">Log in</a>';

  return `<header class="topbar">
    <a class="brand" href="${options.user ? '/leaderboard' : '/'}"><img class="brand-mark" src="/favicon.svg" alt="" /><span>7th Circle</span></a>
    <div class="nav-shell">
      <div class="nav-groups">
        <nav class="nav-links" aria-label="Primary navigation">
          ${options.user ? `<a href="/leaderboard"${activeClass('leaderboard')}>Leaderboard</a>` : ''}
          ${options.user ? `<a href="/events"${activeClass('events')}>Events</a>` : ''}
          ${options.user && currentTeam ? `<a href="/team"${activeClass('teams')}>Team</a>` : ''}
          ${options.user && !currentTeam ? `<a href="/teams/new"${activeClass('teams')}>Create Team</a>` : ''}
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

function escapeCssUrl(value: string) {
  return value.replace(/[\\'"()\n\r\f]/g, (character) => `\\${character}`);
}

function escapeJsString(value: string) {
  return escapeHtml(value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}
