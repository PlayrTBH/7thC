import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdministratorSettings, DeveloperSettings, Event, EventRegistration, PugAbandonLog, PugAbandonSettings, PugCaptainDraftState, PugEloChange, PugEloRating, PugEloSettings, PugMatchLog, PugRankDefinition, PugRankSettings, PugSeason, PugSeasonBadgeReward, PugSeasonLeaderboardEntry, PugSettings, PugUserBadge, PugUserBadgeSelection, StoreShape, Team, TeamInvite, TeamMember, TeamMemberRole } from './types.js';
import { withFileLock } from './file-lock.js';
import { DEVELOPER_DISCORD_USER_ID } from './config.js';

const initialStore: StoreShape = {
  teams: [],
  members: [],
  invites: [],
  events: [],
  eventRegistrations: [],
  pugMatchLogs: [],
  pugAbandonLogs: [],
  pugEloRatings: [],
  pugSeasonLeaderboards: [],
  pugUserBadges: [],
  pugUserBadgeSelections: [],
  settings: {}
};

export class JsonStore {
  private queue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await withFileLock(this.filePath, async () => {
      try {
        const data = await this.readUnlocked();
        data.pugAbandonLogs ??= [];
        await this.writeUnlocked(data);
      } catch {
        await this.writeUnlocked(initialStore);
      }
    });
  }

  async getTeamsByOwner(ownerId: string) {
    const data = await this.read();
    return data.teams.filter((team) => team.ownerId === ownerId);
  }

  async getTeams() {
    const data = await this.read();
    return [...data.teams].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getEvents() {
    const data = await this.read();
    return [...data.events].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title));
  }

  async getEvent(eventId: string) {
    const data = await this.read();
    return data.events.find((event) => event.id === eventId);
  }

  async getEventRegistrations(eventId: string) {
    const data = await this.read();
    return data.eventRegistrations
      .filter((registration) => registration.eventId === eventId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getEventRegistrationsForTeam(teamId: string) {
    const data = await this.read();
    return data.eventRegistrations
      .filter((registration) => registration.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getEventRegistration(eventId: string, teamId: string) {
    const data = await this.read();
    return data.eventRegistrations.find((registration) => registration.eventId === eventId && registration.teamId === teamId);
  }

  async getEventRegistrationCounts() {
    const data = await this.read();
    return data.eventRegistrations.reduce<Record<string, number>>((counts, registration) => {
      counts[registration.eventId] = (counts[registration.eventId] ?? 0) + 1;
      return counts;
    }, {});
  }

  async addEvent(event: Event) {
    await this.update((data) => {
      data.events.push(event);
      return data;
    });
  }

  async updateEvent(eventId: string, updates: Pick<Event, 'title' | 'description' | 'teamLimit' | 'requiredMainPlayers' | 'requiredSubstitutes' | 'startsAt' | 'endsAt' | 'registrationOpensAt' | 'registrationClosesAt' | 'backgroundImageDataUrl'>) {
    await this.update((data) => {
      const event = data.events.find((item) => item.id === eventId);
      if (!event) throw new Error('Event not found.');
      Object.assign(event, updates, { updatedAt: new Date().toISOString() });
      return data;
    });
  }

  async addEventRegistration(registration: EventRegistration) {
    await this.update((data) => {
      const event = data.events.find((item) => item.id === registration.eventId);
      if (!event) throw new Error('Event not found.');
      if (!data.teams.some((team) => team.id === registration.teamId)) throw new Error('Team not found.');
      if (data.eventRegistrations.some((item) => item.eventId === registration.eventId && item.teamId === registration.teamId)) {
        throw new Error('Your team is already registered for this event.');
      }
      const registrationCount = data.eventRegistrations.filter((item) => item.eventId === registration.eventId).length;
      if (registrationCount >= event.teamLimit) throw new Error('This event has reached its team registration limit.');
      data.eventRegistrations.push(registration);
      return data;
    });
  }

  async updateEventRegistration(eventId: string, teamId: string, updates: Pick<EventRegistration, 'captainId' | 'mainPlayerIds' | 'substitutePlayerIds'>) {
    await this.update((data) => {
      const registration = data.eventRegistrations.find((item) => item.eventId === eventId && item.teamId === teamId);
      if (!registration) throw new Error('Registration not found.');
      Object.assign(registration, updates, { updatedAt: new Date().toISOString() });
      return data;
    });
  }

  async removeEventRegistration(eventId: string, teamId: string) {
    await this.update((data) => {
      const before = data.eventRegistrations.length;
      data.eventRegistrations = data.eventRegistrations.filter((registration) => !(registration.eventId === eventId && registration.teamId === teamId));
      if (data.eventRegistrations.length === before) throw new Error('Registration not found.');
      return data;
    });
  }

  async removeEvent(eventId: string) {
    await this.update((data) => {
      const before = data.events.length;
      data.events = data.events.filter((event) => event.id !== eventId);
      if (data.events.length === before) throw new Error('Event not found.');
      data.eventRegistrations = data.eventRegistrations.filter((registration) => registration.eventId !== eventId);
      return data;
    });
  }


  async getPugMatchLogs() {
    const data = await this.read();
    return [...data.pugMatchLogs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPugMatchLog(matchId: string) {
    const data = await this.read();
    return data.pugMatchLogs.find((match) => match.id === matchId);
  }

  async upsertPugMatchLog(match: PugMatchLog) {
    await this.update((data) => {
      const index = data.pugMatchLogs.findIndex((item) => item.id === match.id);
      if (index >= 0) data.pugMatchLogs[index] = match;
      else data.pugMatchLogs.push(match);
      return data;
    });
  }

  async updatePugMatchLog(matchId: string, updates: Partial<PugMatchLog>) {
    await this.update((data) => {
      const match = data.pugMatchLogs.find((item) => item.id === matchId);
      if (!match) throw new Error('PUG match log not found.');
      Object.assign(match, updates, { updatedAt: updates.updatedAt ?? new Date().toISOString() });
      return data;
    });
  }

  async removePugMatchLog(matchId: string) {
    await this.update((data) => {
      const before = data.pugMatchLogs.length;
      data.pugMatchLogs = data.pugMatchLogs.filter((match) => match.id !== matchId);
      if (data.pugMatchLogs.length === before) throw new Error('PUG match log not found.');
      return data;
    });
  }


  async getPugEloSettings() {
    const data = await this.read();
    return normalizePugEloSettings(data.settings.pugs?.elo);
  }

  async getPugRankSettings() {
    const data = await this.read();
    return normalizePugRankSettings(data.settings.pugs?.ranks);
  }

  async getPugAbandonSettings() {
    const data = await this.read();
    return normalizePugAbandonSettings(data.settings.pugs?.abandons);
  }

  async getPugAbandonLogs() {
    const data = await this.read();
    return [...(data.pugAbandonLogs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPugActiveAbandonBlock(userId: string, at = new Date()) {
    const data = await this.read();
    const now = at.getTime();
    return (data.pugAbandonLogs ?? [])
      .filter((log) => log.userId === userId && log.blockedUntil && new Date(log.blockedUntil).getTime() > now)
      .sort((a, b) => String(b.blockedUntil).localeCompare(String(a.blockedUntil)))[0];
  }

  async recordPugAbandon(log: PugAbandonLog) {
    await this.update((data) => {
      data.pugAbandonLogs ??= [];
      const settings = normalizePugEloSettings(data.settings.pugs?.elo);
      const seasonId = getActivePugSeason(data).id;
      const now = log.createdAt;
      let finalLog = { ...log };
      if (log.eloPenalty > 0) {
        const existing = data.pugEloRatings.find((rating) => rating.userId === log.userId);
        const before = existing?.rating ?? settings.startingRating;
        const after = Math.max(0, Math.round(before - log.eloPenalty));
        finalLog = { ...finalLog, ratingBefore: before, ratingAfter: after };
        if (existing) {
          existing.rating = after;
          existing.seasonId = seasonId;
          if (log.username) existing.username = log.username;
          existing.updatedAt = now;
        } else {
          data.pugEloRatings.push({ userId: log.userId, username: log.username, rating: after, peakRating: before, seasonId, updatedAt: now });
        }
      }
      data.pugAbandonLogs.push(finalLog);
      return data;
    });
  }

  async getPugSeasons() {
    const data = await this.read();
    return [...(data.settings.pugs?.seasons ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async getActivePugSeason() {
    const data = await this.read();
    return getActivePugSeason(data);
  }

  async getPugSeasonLeaderboards() {
    const data = await this.read();
    return data.pugSeasonLeaderboards
      .filter((entry) => !isDeveloperAccount(entry.userId))
      .sort((a, b) => b.seasonLabel.localeCompare(a.seasonLabel) || a.placement - b.placement);
  }

  async getPugUserBadges(userId: string) {
    const data = await this.read();
    return data.pugUserBadges.filter((badge) => badge.userId === userId).sort((a, b) => b.awardedAt.localeCompare(a.awardedAt));
  }

  async getPugUserBadgeSelection(userId: string) {
    const data = await this.read();
    return data.pugUserBadgeSelections.find((selection) => selection.userId === userId)?.badgeIds ?? [];
  }

  async setPugUserBadgeSelection(userId: string, badgeIds: string[]) {
    await this.update((data) => {
      const owned = new Set(data.pugUserBadges.filter((badge) => badge.userId === userId).map((badge) => badge.id));
      const safeBadgeIds = [...new Set(badgeIds.filter((badgeId) => owned.has(badgeId)))].slice(0, 6);
      const now = new Date().toISOString();
      const existing = data.pugUserBadgeSelections.find((selection) => selection.userId === userId);
      if (existing) Object.assign(existing, { badgeIds: safeBadgeIds, updatedAt: now });
      else data.pugUserBadgeSelections.push({ userId, badgeIds: safeBadgeIds, updatedAt: now });
      return data;
    });
  }

  async updatePugSeason(seasonId: string, updates: Pick<PugSeason, 'label' | 'endsAt' | 'badgeRewards'>) {
    await this.update((data) => {
      const season = data.settings.pugs?.seasons?.find((item) => item.id === seasonId);
      if (!season) throw new Error('PUG season not found.');
      if (season.status !== 'active') throw new Error('Only the active season can be configured.');
      season.label = updates.label;
      season.endsAt = updates.endsAt;
      season.badgeRewards = updates.badgeRewards;
      return data;
    });
  }

  async endActivePugSeason(nextSeasonLabel?: string) {
    await this.update((data) => {
      finalizeActivePugSeason(data, new Date().toISOString(), nextSeasonLabel);
      return data;
    });
  }

  async getPugEloLeaderboard(limit = 10) {
    const data = await this.read();
    return [...data.pugEloRatings]
      .filter((rating) => !isDeveloperAccount(rating.userId))
      .sort((a, b) => b.rating - a.rating || (a.username ?? a.userId).localeCompare(b.username ?? b.userId))
      .slice(0, limit);
  }

  async getPugEloRatings() {
    const data = await this.read();
    return [...data.pugEloRatings].sort((a, b) => b.rating - a.rating || (a.username ?? a.userId).localeCompare(b.username ?? b.userId));
  }

  async getPugEloRating(userId: string) {
    const data = await this.read();
    const settings = normalizePugEloSettings(data.settings.pugs?.elo);
    return data.pugEloRatings.find((rating) => rating.userId === userId) ?? { userId, rating: settings.startingRating, updatedAt: new Date().toISOString() };
  }

  async setPugEloRating(userId: string, rating: number, username?: string) {
    await this.update((data) => {
      const now = new Date().toISOString();
      const safeRating = Math.max(0, Math.round(rating));
      const seasonId = getActivePugSeason(data).id;
      const existing = data.pugEloRatings.find((item) => item.userId === userId);
      if (existing) {
        existing.rating = safeRating;
        existing.peakRating = Math.max(existing.peakRating ?? safeRating, safeRating);
        existing.seasonId = seasonId;
        if (username) existing.username = username;
        existing.updatedAt = now;
      } else {
        data.pugEloRatings.push({ userId, username, rating: safeRating, peakRating: safeRating, seasonId, updatedAt: now });
      }
      return data;
    });
  }

  async resetPugEloRating(userId: string) {
    await this.update((data) => {
      const settings = normalizePugEloSettings(data.settings.pugs?.elo);
      const now = new Date().toISOString();
      const existing = data.pugEloRatings.find((item) => item.userId === userId);
      if (existing) {
        existing.rating = settings.startingRating;
        existing.peakRating = settings.startingRating;
        existing.seasonId = getActivePugSeason(data).id;
        existing.updatedAt = now;
      } else {
        data.pugEloRatings.push({ userId, rating: settings.startingRating, peakRating: settings.startingRating, seasonId: getActivePugSeason(data).id, updatedAt: now });
      }
      return data;
    });
  }

  async resetAllPugEloRatings() {
    await this.update((data) => {
      const settings = normalizePugEloSettings(data.settings.pugs?.elo);
      const now = new Date().toISOString();
      const seasonId = getActivePugSeason(data).id;
      data.pugEloRatings = data.pugEloRatings.map((rating) => ({ ...rating, rating: settings.startingRating, peakRating: settings.startingRating, seasonId, updatedAt: now }));
      return data;
    });
  }

  async applyPugEloChanges(changes: PugEloChange[]) {
    await this.update((data) => {
      const now = new Date().toISOString();
      for (const change of changes) {
        const existing = data.pugEloRatings.find((rating) => rating.userId === change.userId);
        if (existing) {
          existing.rating = change.after;
          existing.peakRating = Math.max(existing.peakRating ?? change.before, change.after);
          existing.seasonId = getActivePugSeason(data).id;
          if (change.username) existing.username = change.username;
          existing.updatedAt = now;
        } else {
          data.pugEloRatings.push({ userId: change.userId, username: change.username, rating: change.after, peakRating: Math.max(change.before, change.after), seasonId: getActivePugSeason(data).id, updatedAt: now });
        }
      }
      return data;
    });
  }

  async rollbackPugMatch(matchId: string) {
    await this.update((data) => {
      const match = data.pugMatchLogs.find((item) => item.id === matchId);
      if (!match) throw new Error('PUG match log not found.');
      if (match.status === 'rolledback') throw new Error('PUG match has already been rolled back.');
      if (match.status !== 'completed') throw new Error('Only completed PUG matches can be rolled back.');
      if (!match.eloChanges?.length) throw new Error('PUG match does not have ELO changes to roll back.');

      const now = new Date().toISOString();
      const settings = normalizePugEloSettings(data.settings.pugs?.elo);
      for (const change of match.eloChanges) {
        const existing = data.pugEloRatings.find((rating) => rating.userId === change.userId);
        const currentRating = existing?.rating ?? change.after ?? settings.startingRating;
        const rolledBackRating = Math.max(0, Math.round(currentRating - change.delta));
        if (existing) {
          existing.rating = rolledBackRating;
          if (change.username) existing.username = change.username;
          existing.updatedAt = now;
        } else {
          data.pugEloRatings.push({ userId: change.userId, username: change.username, rating: rolledBackRating, peakRating: rolledBackRating, seasonId: getActivePugSeason(data).id, updatedAt: now });
        }
      }

      match.status = 'rolledback';
      match.result = match.result ? `${match.result} (rolled back)` : 'Rolled back by administrator';
      match.updatedAt = now;
      return data;
    });
  }

  async getAdministratorSettings() {
    const data = await this.read();
    return data.settings;
  }

  async updateAdministratorSettings(settings: AdministratorSettings) {
    await this.update((data) => {
      data.settings = { ...data.settings, ...settings };
      return data;
    });
  }

  async updatePugSettings(pugs: PugSettings) {
    await this.update((data) => {
      data.settings = { ...data.settings, pugs };
      return data;
    });
  }

  async updateDiscordInviteUrl(discordInviteUrl: string) {
    await this.update((data) => {
      data.settings = { ...data.settings, discordInviteUrl };
      return data;
    });
  }

  async getDeveloperSettings() {
    const data = await this.read();
    return data.settings.developer ?? {};
  }

  async updateDeveloperSettings(settings: DeveloperSettings) {
    await this.update((data) => {
      data.settings = {
        ...data.settings,
        developer: {
          ...data.settings.developer,
          ...settings
        }
      };
      return data;
    });
  }

  async getTeam(teamId: string) {
    const data = await this.read();
    return data.teams.find((team) => team.id === teamId);
  }

  async getTeamForUser(userId: string) {
    const data = await this.read();
    const membership = data.members.find((member) => member.userId === userId);
    if (!membership) return undefined;
    return data.teams.find((team) => team.id === membership.teamId);
  }

  async getTeamMembers(teamId: string) {
    const data = await this.read();
    return data.members.filter((member) => member.teamId === teamId);
  }

  async getTeamMember(teamId: string, userId: string) {
    const data = await this.read();
    return data.members.find((member) => member.teamId === teamId && member.userId === userId);
  }

  async getTeamMemberUserIds() {
    const data = await this.read();
    return new Set(data.members.map((member) => member.userId));
  }

  async getInvite(inviteId: string) {
    const data = await this.read();
    return data.invites.find((invite) => invite.id === inviteId);
  }

  async getTeamInvites(teamId: string) {
    const data = await this.read();
    return data.invites
      .filter((invite) => invite.teamId === teamId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addTeam(team: Team, ownerRole: TeamMemberRole = 'captain') {
    await this.update((data) => {
      if (data.members.some((member) => member.userId === team.ownerId)) {
        throw new Error('You are already in a team. Leave or delete your current team before creating another one.');
      }

      data.teams.push(team);
      data.members.push({
        teamId: team.id,
        userId: team.ownerId,
        role: ownerRole,
        joinedAt: team.createdAt
      });
      return data;
    });
  }

  async updateTeamRoleColor(teamId: string, roleColor: string) {
    await this.update((data) => {
      const team = data.teams.find((item) => item.id === teamId);
      if (team) team.roleColor = roleColor;
      return data;
    });
  }

  async updateTeamName(teamId: string, name: string) {
    await this.update((data) => {
      const team = data.teams.find((item) => item.id === teamId);
      if (!team) throw new Error('Team not found.');
      team.name = name;
      return data;
    });
  }

  async removeTeam(teamId: string) {
    await this.update((data) => {
      data.teams = data.teams.filter((team) => team.id !== teamId);
      data.members = data.members.filter((member) => member.teamId !== teamId);
      data.invites = data.invites.filter((invite) => invite.teamId !== teamId);
      data.eventRegistrations = data.eventRegistrations.filter((registration) => registration.teamId !== teamId);
      return data;
    });
  }

  async addInvites(invites: TeamInvite[]) {
    let addedInvites: TeamInvite[] = [];
    await this.update((data) => {
      const unavailableUserIds = new Set(data.members.map((member) => member.userId));
      addedInvites = invites.filter((invite) => !unavailableUserIds.has(invite.inviteeId));
      data.invites.push(...addedInvites);
      return data;
    });
    return addedInvites;
  }

  async updateInviteStatus(inviteId: string, status: TeamInvite['status']) {
    await this.update((data) => {
      const invite = data.invites.find((item) => item.id === inviteId);
      if (invite) {
        invite.status = status;
        invite.respondedAt = new Date().toISOString();
      }
      return data;
    });
  }

  async acceptInvite(inviteId: string, userId: string, role: TeamMemberRole = 'main') {
    await this.update((data) => {
      const invite = data.invites.find((item) => item.id === inviteId);
      if (!invite || invite.inviteeId !== userId || invite.status !== 'pending') {
        throw new Error('Invite is not available.');
      }
      if (!data.teams.some((team) => team.id === invite.teamId)) {
        throw new Error('Team no longer exists.');
      }
      if (data.members.some((member) => member.userId === userId)) {
        throw new Error('You already own or belong to a team. Leave or delete your current team before accepting another invite.');
      }

      invite.status = 'accepted';
      invite.respondedAt = new Date().toISOString();
      data.members.push({
        teamId: invite.teamId,
        userId,
        role,
        joinedAt: invite.respondedAt
      });
      return data;
    });
  }

  async setTeamMemberRole(teamId: string, userId: string, role: TeamMemberRole) {
    await this.update((data) => {
      const team = data.teams.find((item) => item.id === teamId);
      if (team?.ownerId === userId) throw new Error('Transfer team ownership to change the captain.');

      const member = data.members.find((item) => item.teamId === teamId && item.userId === userId);
      if (!member) throw new Error('Team member not found.');
      member.role = role;
      return data;
    });
  }

  async transferTeamOwnership(teamId: string, newOwnerId: string) {
    await this.update((data) => {
      const team = data.teams.find((item) => item.id === teamId);
      if (!team) throw new Error('Team not found.');
      if (team.ownerId === newOwnerId) throw new Error('That member is already the team captain.');

      const previousOwner = data.members.find((member) => member.teamId === teamId && member.userId === team.ownerId);
      const nextOwner = data.members.find((member) => member.teamId === teamId && member.userId === newOwnerId);
      if (!nextOwner) throw new Error('New captain must already be a team member.');

      if (previousOwner) previousOwner.role = 'coach';
      nextOwner.role = 'captain';
      team.ownerId = newOwnerId;
      return data;
    });
  }

  async removeTeamMember(teamId: string, userId: string) {
    await this.update((data) => {
      const team = data.teams.find((item) => item.id === teamId);
      if (team?.ownerId === userId) throw new Error('Team owners must delete the team instead of leaving it.');
      data.members = data.members.filter((member) => !(member.teamId === teamId && member.userId === userId));
      data.invites = data.invites.map((invite) =>
        invite.teamId === teamId && invite.inviteeId === userId && invite.status === 'accepted'
          ? { ...invite, status: 'declined', respondedAt: new Date().toISOString() }
          : invite
      );
      return data;
    });
  }

  private async read(): Promise<StoreShape> {
    return withFileLock(this.filePath, () => this.readUnlocked());
  }

  private async readUnlocked(): Promise<StoreShape> {
    const raw = await readFile(this.filePath, 'utf8');
    return normalizeStore(JSON.parse(raw) as Partial<StoreShape>);
  }

  private async writeUnlocked(data: StoreShape) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }

  private async update(mutator: (data: StoreShape) => StoreShape) {
    const next = this.queue.then(async () =>
      withFileLock(this.filePath, async () => {
        const current = await this.readUnlocked();
        await this.writeUnlocked(mutator(current));
      })
    );
    this.queue = next.catch(() => undefined);
    await next;
  }
}

function normalizeStore(data: Partial<StoreShape>): StoreShape {
  const normalized: StoreShape = {
    teams: data.teams ?? [],
    members: data.members ?? [],
    invites: data.invites ?? [],
    events: data.events ?? [],
    eventRegistrations: data.eventRegistrations ?? [],
    pugMatchLogs: Array.isArray(data.pugMatchLogs) ? data.pugMatchLogs.map(normalizePugMatchLog) : [],
    pugAbandonLogs: Array.isArray(data.pugAbandonLogs) ? data.pugAbandonLogs.map(normalizePugAbandonLog).filter(Boolean) as PugAbandonLog[] : [],
    pugEloRatings: Array.isArray(data.pugEloRatings) ? data.pugEloRatings.map(normalizePugEloRating).filter(Boolean) as PugEloRating[] : [],
    pugSeasonLeaderboards: Array.isArray(data.pugSeasonLeaderboards) ? data.pugSeasonLeaderboards.map(normalizePugSeasonLeaderboardEntry).filter(Boolean) as PugSeasonLeaderboardEntry[] : [],
    pugUserBadges: Array.isArray(data.pugUserBadges) ? data.pugUserBadges.map(normalizePugUserBadge).filter(Boolean) as PugUserBadge[] : [],
    pugUserBadgeSelections: Array.isArray(data.pugUserBadgeSelections) ? data.pugUserBadgeSelections.map(normalizePugUserBadgeSelection).filter(Boolean) as PugUserBadgeSelection[] : [],
    settings: { ...data.settings, pugs: normalizePugSettings(data.settings?.pugs) }
  };

  for (const team of normalized.teams) {
    if (!normalized.members.some((member) => member.teamId === team.id && member.userId === team.ownerId)) {
      normalized.members.push({
        teamId: team.id,
        userId: team.ownerId,
        role: 'captain',
        joinedAt: team.createdAt
      });
    }
  }

  for (const invite of normalized.invites) {
    if (invite.status !== 'accepted') continue;
    if (!normalized.teams.some((team) => team.id === invite.teamId)) continue;
    if (normalized.members.some((member) => member.userId === invite.inviteeId)) continue;
    normalized.members.push({
      teamId: invite.teamId,
      userId: invite.inviteeId,
      role: 'main',
      joinedAt: invite.respondedAt ?? invite.createdAt
    });
  }

  const teamIds = new Set(normalized.teams.map((team) => team.id));
  const eventIds = new Set(normalized.events.map((event) => event.id));
  normalized.eventRegistrations = normalized.eventRegistrations.filter(
    (registration) => teamIds.has(registration.teamId) && eventIds.has(registration.eventId)
  );

  for (const team of normalized.teams) {
    const owner = normalized.members.find((member) => member.teamId === team.id && member.userId === team.ownerId);
    if (owner) owner.role = 'captain';
  }

  ensurePugSeasonState(normalized);

  return normalized;
}

function normalizePugAbandonLog(log: Partial<PugAbandonLog>) {
  if (typeof log.id !== 'string' || typeof log.matchId !== 'string' || typeof log.userId !== 'string') return undefined;
  const now = new Date().toISOString();
  return {
    id: log.id,
    matchId: log.matchId,
    size: log.size === 12 ? 12 : 6,
    userId: log.userId,
    username: typeof log.username === 'string' ? log.username : undefined,
    replacementUserId: typeof log.replacementUserId === 'string' ? log.replacementUserId : undefined,
    replacementUsername: typeof log.replacementUsername === 'string' ? log.replacementUsername : undefined,
    eloPenalty: typeof log.eloPenalty === 'number' && Number.isFinite(log.eloPenalty) ? Math.max(0, Math.round(log.eloPenalty)) : 0,
    ratingBefore: typeof log.ratingBefore === 'number' && Number.isFinite(log.ratingBefore) ? Math.max(0, Math.round(log.ratingBefore)) : undefined,
    ratingAfter: typeof log.ratingAfter === 'number' && Number.isFinite(log.ratingAfter) ? Math.max(0, Math.round(log.ratingAfter)) : undefined,
    blockedUntil: typeof log.blockedUntil === 'string' ? log.blockedUntil : undefined,
    createdAt: typeof log.createdAt === 'string' ? log.createdAt : now
  };
}

function normalizePugMatchLog(match: Partial<PugMatchLog>): PugMatchLog {
  const now = new Date().toISOString();
  return {
    id: typeof match.id === 'string' ? match.id : cryptoRandomFallback(),
    size: match.size === 12 ? 12 : 6,
    playerIds: Array.isArray(match.playerIds) ? match.playerIds.filter((id): id is string => typeof id === 'string') : [],
    playerUsernames: normalizeStringRecord(match.playerUsernames),
    categoryId: typeof match.categoryId === 'string' ? match.categoryId : undefined,
    queueVoiceChannelId: typeof match.queueVoiceChannelId === 'string' ? match.queueVoiceChannelId : undefined,
    textChannelId: typeof match.textChannelId === 'string' ? match.textChannelId : undefined,
    teamVoiceChannelIds: Array.isArray(match.teamVoiceChannelIds) ? match.teamVoiceChannelIds.filter((id): id is string => typeof id === 'string') : undefined,
    playerRankLabels: normalizeStringRecord(match.playerRankLabels),
    playerRankRoleIds: normalizeStringRecord(match.playerRankRoleIds),
    modeVotes: normalizePugModeVotes(match.modeVotes),
    modeVoteMessageId: typeof match.modeVoteMessageId === 'string' ? match.modeVoteMessageId : undefined,
    captainDraft: normalizePugCaptainDraft(match.captainDraft),
    voteMessageId: typeof match.voteMessageId === 'string' ? match.voteMessageId : undefined,
    voteStartedAt: typeof match.voteStartedAt === 'string' ? match.voteStartedAt : undefined,
    teams: Array.isArray(match.teams) ? match.teams.map((team) => Array.isArray(team) ? team.filter((id): id is string => typeof id === 'string') : []) : [],
    captainIds: Array.isArray(match.captainIds) ? match.captainIds.filter((id): id is string => typeof id === 'string') : [],
    mode: match.mode === 'captains' || match.mode === 'random' ? match.mode : undefined,
    map: typeof match.map === 'string' ? match.map : undefined,
    voteMode: match.voteMode === 'winner' || match.voteMode === 'placements' ? match.voteMode : undefined,
    votes: match.votes && typeof match.votes === 'object' && !Array.isArray(match.votes) ? Object.fromEntries(Object.entries(match.votes).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
    result: typeof match.result === 'string' ? match.result : undefined,
    teamEloTotals: Array.isArray(match.teamEloTotals) ? match.teamEloTotals.filter((rating): rating is number => typeof rating === 'number' && Number.isFinite(rating)).map(Math.round) : undefined,
    eloChanges: Array.isArray(match.eloChanges) ? match.eloChanges.map(normalizePugEloChange).filter(Boolean) as PugEloChange[] : undefined,
    status: match.status === 'completed' || match.status === 'reset' || match.status === 'deleted' || match.status === 'rolledback' ? match.status : 'ongoing',
    createdAt: typeof match.createdAt === 'string' ? match.createdAt : now,
    updatedAt: typeof match.updatedAt === 'string' ? match.updatedAt : now,
    endedAt: typeof match.endedAt === 'string' ? match.endedAt : undefined
  };
}


function normalizeStringRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
}

function normalizePugModeVotes(value: unknown): Record<string, 'random' | 'captains'> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, 'random' | 'captains'] => entry[1] === 'random' || entry[1] === 'captains'))
    : {};
}

function normalizePugCaptainDraft(value: unknown): PugCaptainDraftState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const draft = value as Partial<PugCaptainDraftState>;
  const captainIds = Array.isArray(draft.captainIds) ? draft.captainIds.filter((id): id is string => typeof id === 'string') : [];
  const teams = Array.isArray(draft.teams) ? draft.teams.map((team) => Array.isArray(team) ? team.filter((id): id is string => typeof id === 'string') : []) : [];
  const availablePlayerIds = Array.isArray(draft.availablePlayerIds) ? draft.availablePlayerIds.filter((id): id is string => typeof id === 'string') : [];
  if (!captainIds.length && !teams.length && !availablePlayerIds.length) return undefined;
  return {
    captainIds,
    teams,
    availablePlayerIds,
    currentCaptainIndex: typeof draft.currentCaptainIndex === 'number' && Number.isFinite(draft.currentCaptainIndex) ? Math.max(0, Math.round(draft.currentCaptainIndex)) : 0,
    picksThisTurn: typeof draft.picksThisTurn === 'number' && Number.isFinite(draft.picksThisTurn) ? Math.max(0, Math.round(draft.picksThisTurn)) : 0,
    messageId: typeof draft.messageId === 'string' ? draft.messageId : undefined
  };
}

function cryptoRandomFallback() {
  return `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePugSettings(settings: Partial<PugSettings> | undefined): PugSettings {
  return {
    queueChannelId: typeof settings?.queueChannelId === 'string' ? settings.queueChannelId : undefined,
    mapPool: Array.isArray(settings?.mapPool) ? settings.mapPool.filter((map): map is string => typeof map === 'string') : [],
    queueMessageId: typeof settings?.queueMessageId === 'string' ? settings.queueMessageId : undefined,
    elo: normalizePugEloSettings(settings?.elo),
    abandons: normalizePugAbandonSettings(settings?.abandons),
    ranks: normalizePugRankSettings(settings?.ranks),
    seasons: normalizePugSeasons(settings?.seasons)
  };
}


const defaultPugRanks: PugRankSettings = {
  ranks: [
    { id: 'bronze', label: 'Bronze', abbreviation: 'B', minRating: 0, maxRating: 14999 },
    { id: 'silver', label: 'Silver', abbreviation: 'S', minRating: 15000, maxRating: 19999 },
    { id: 'gold', label: 'Gold', abbreviation: 'G', minRating: 20000, maxRating: 24999 },
    { id: 'platinum', label: 'Platinum', abbreviation: 'P', minRating: 25000, maxRating: 29999 },
    { id: 'diamond', label: 'Diamond', abbreviation: 'D', minRating: 30000, maxRating: 34999 },
    { id: 'infernal', label: 'Infernal', abbreviation: 'I', minRating: 35000 }
  ]
};

function normalizePugAbandonSettings(settings: Partial<PugAbandonSettings> | undefined): PugAbandonSettings {
  return {
    eloPenalty: Math.max(0, Math.round(typeof settings?.eloPenalty === 'number' && Number.isFinite(settings.eloPenalty) ? settings.eloPenalty : 0)),
    blockMinutes: Math.max(0, Math.round(typeof settings?.blockMinutes === 'number' && Number.isFinite(settings.blockMinutes) ? settings.blockMinutes : 0))
  };
}

function normalizePugRankSettings(settings: Partial<PugRankSettings> | undefined): PugRankSettings {
  const ranks = Array.isArray(settings?.ranks) ? settings.ranks.map(normalizePugRankDefinition).filter(Boolean) as PugRankSettings['ranks'] : [];
  const safeRanks = (ranks.length ? ranks : defaultPugRanks.ranks).sort((a, b) => a.minRating - b.minRating || a.label.localeCompare(b.label));
  return {
    ranks: safeRanks,
    masterIconDataUrl: isImageDataUrl(settings?.masterIconDataUrl) ? settings.masterIconDataUrl : undefined
  };
}

function normalizePugRankDefinition(rank: Partial<PugRankSettings['ranks'][number]>) {
  if (typeof rank.id !== 'string' || !rank.id.trim()) return undefined;
  const minRating = typeof rank.minRating === 'number' && Number.isFinite(rank.minRating) ? Math.max(0, Math.round(rank.minRating)) : 0;
  const maxRating = typeof rank.maxRating === 'number' && Number.isFinite(rank.maxRating) ? Math.max(minRating, Math.round(rank.maxRating)) : undefined;
  return {
    id: rank.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48) || 'rank',
    label: typeof rank.label === 'string' && rank.label.trim() ? rank.label.trim().slice(0, 48) : 'Rank',
    abbreviation: typeof rank.abbreviation === 'string' && rank.abbreviation.trim() ? rank.abbreviation.trim().slice(0, 8) : '',
    minRating,
    maxRating,
    iconDataUrl: isImageDataUrl(rank.iconDataUrl) ? rank.iconDataUrl : undefined
  };
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 1_000_000;
}

function normalizePugEloSettings(settings: Partial<PugEloSettings> | undefined): PugEloSettings {
  const startingRating = typeof settings?.startingRating === 'number' && Number.isFinite(settings.startingRating) ? settings.startingRating : 20000;
  const baseChange = typeof settings?.baseChange === 'number' && Number.isFinite(settings.baseChange) ? settings.baseChange : 1000;
  const strength = typeof settings?.strength === 'number' && Number.isFinite(settings.strength) ? settings.strength : 1;
  const finalRoundMultiplier = typeof settings?.finalRoundMultiplier === 'number' && Number.isFinite(settings.finalRoundMultiplier) ? settings.finalRoundMultiplier : 1;
  const cashoutMultiplier = typeof settings?.cashoutMultiplier === 'number' && Number.isFinite(settings.cashoutMultiplier) ? settings.cashoutMultiplier : 1.25;
  return {
    startingRating: Math.max(1, Math.round(startingRating)),
    baseChange: Math.max(1, Math.round(baseChange)),
    strength: Math.min(5, Math.max(0.1, strength)),
    finalRoundMultiplier: Math.min(5, Math.max(0, finalRoundMultiplier)),
    cashoutMultiplier: Math.min(5, Math.max(0, cashoutMultiplier))
  };
}

function normalizePugEloRating(rating: Partial<PugEloRating>) {
  if (typeof rating.userId !== 'string') return undefined;
  return {
    userId: rating.userId,
    username: typeof rating.username === 'string' ? rating.username : undefined,
    rating: typeof rating.rating === 'number' && Number.isFinite(rating.rating) ? Math.max(0, Math.round(rating.rating)) : 20000,
    peakRating: typeof rating.peakRating === 'number' && Number.isFinite(rating.peakRating) ? Math.max(0, Math.round(rating.peakRating)) : (typeof rating.rating === 'number' && Number.isFinite(rating.rating) ? Math.max(0, Math.round(rating.rating)) : 20000),
    seasonId: typeof rating.seasonId === 'string' ? rating.seasonId : undefined,
    updatedAt: typeof rating.updatedAt === 'string' ? rating.updatedAt : new Date().toISOString()
  };
}

function normalizePugEloChange(change: Partial<PugEloChange>) {
  if (typeof change.userId !== 'string') return undefined;
  return {
    userId: change.userId,
    username: typeof change.username === 'string' ? change.username : undefined,
    teamIndex: typeof change.teamIndex === 'number' && Number.isInteger(change.teamIndex) ? change.teamIndex : 0,
    placement: typeof change.placement === 'number' && Number.isInteger(change.placement) ? change.placement : 0,
    before: typeof change.before === 'number' && Number.isFinite(change.before) ? Math.round(change.before) : 20000,
    after: typeof change.after === 'number' && Number.isFinite(change.after) ? Math.round(change.after) : 20000,
    delta: typeof change.delta === 'number' && Number.isFinite(change.delta) ? Math.round(change.delta) : 0
  };
}

function normalizePugSeasons(seasons: Partial<PugSeason>[] | undefined): PugSeason[] {
  const normalized = Array.isArray(seasons) ? seasons.map(normalizePugSeason).filter(Boolean) as PugSeason[] : [];
  if (!normalized.some((season) => season.status === 'active')) normalized.push(defaultPugSeason());
  let activeSeen = false;
  return normalized
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
    .map((season) => {
      if (season.status !== 'active') return season;
      if (!activeSeen) {
        activeSeen = true;
        return season;
      }
      return { ...season, status: 'completed', endedAt: season.endedAt ?? season.startsAt };
    });
}

function normalizePugSeason(season: Partial<PugSeason>) {
  if (typeof season.id !== 'string' || !season.id.trim()) return undefined;
  return {
    id: season.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 's1',
    label: typeof season.label === 'string' && season.label.trim() ? season.label.trim().slice(0, 32) : season.id.trim().toUpperCase(),
    status: season.status === 'completed' ? 'completed' as const : 'active' as const,
    startsAt: typeof season.startsAt === 'string' ? season.startsAt : new Date().toISOString(),
    endsAt: typeof season.endsAt === 'string' && season.endsAt ? season.endsAt : undefined,
    endedAt: typeof season.endedAt === 'string' && season.endedAt ? season.endedAt : undefined,
    badgeRewards: Array.isArray(season.badgeRewards) ? season.badgeRewards.map(normalizePugSeasonBadgeReward).filter(Boolean) as PugSeasonBadgeReward[] : []
  };
}

function normalizePugSeasonBadgeReward(reward: Partial<PugSeasonBadgeReward>) {
  if (typeof reward.rankId !== 'string' || !reward.rankId.trim()) return undefined;
  return {
    rankId: reward.rankId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    label: typeof reward.label === 'string' && reward.label.trim() ? reward.label.trim().slice(0, 64) : 'Season Badge',
    abbreviation: typeof reward.abbreviation === 'string' && reward.abbreviation.trim() ? reward.abbreviation.trim().slice(0, 12) : undefined,
    iconDataUrl: isImageDataUrl(reward.iconDataUrl) ? reward.iconDataUrl : undefined
  };
}

function normalizePugSeasonLeaderboardEntry(entry: Partial<PugSeasonLeaderboardEntry>) {
  if (typeof entry.seasonId !== 'string' || typeof entry.userId !== 'string') return undefined;
  return {
    seasonId: entry.seasonId,
    seasonLabel: typeof entry.seasonLabel === 'string' ? entry.seasonLabel : entry.seasonId.toUpperCase(),
    userId: entry.userId,
    username: typeof entry.username === 'string' ? entry.username : undefined,
    rating: typeof entry.rating === 'number' && Number.isFinite(entry.rating) ? Math.max(0, Math.round(entry.rating)) : 0,
    rankId: typeof entry.rankId === 'string' ? entry.rankId : 'unranked',
    rankLabel: typeof entry.rankLabel === 'string' ? entry.rankLabel : 'Unranked',
    placement: typeof entry.placement === 'number' && Number.isInteger(entry.placement) ? Math.max(1, entry.placement) : 1
  };
}

function normalizePugUserBadge(badge: Partial<PugUserBadge>) {
  if (typeof badge.userId !== 'string' || typeof badge.seasonId !== 'string' || typeof badge.rankId !== 'string') return undefined;
  return {
    id: typeof badge.id === 'string' && badge.id ? badge.id : `${badge.userId}-${badge.seasonId}-${badge.rankId}`,
    userId: badge.userId,
    seasonId: badge.seasonId,
    seasonLabel: typeof badge.seasonLabel === 'string' ? badge.seasonLabel : badge.seasonId.toUpperCase(),
    rankId: badge.rankId,
    rankLabel: typeof badge.rankLabel === 'string' ? badge.rankLabel : 'Unranked',
    label: typeof badge.label === 'string' ? badge.label : 'Season Badge',
    abbreviation: typeof badge.abbreviation === 'string' ? badge.abbreviation : undefined,
    iconDataUrl: isImageDataUrl(badge.iconDataUrl) ? badge.iconDataUrl : undefined,
    awardedAt: typeof badge.awardedAt === 'string' ? badge.awardedAt : new Date().toISOString()
  };
}

function normalizePugUserBadgeSelection(selection: Partial<PugUserBadgeSelection>) {
  if (typeof selection.userId !== 'string') return undefined;
  return {
    userId: selection.userId,
    badgeIds: Array.isArray(selection.badgeIds) ? selection.badgeIds.filter((id): id is string => typeof id === 'string').slice(0, 6) : [],
    updatedAt: typeof selection.updatedAt === 'string' ? selection.updatedAt : new Date().toISOString()
  };
}

function defaultPugSeason(): PugSeason {
  return { id: 's1', label: 'S1', status: 'active', startsAt: new Date().toISOString(), badgeRewards: [] };
}


function isDeveloperAccount(userId: string) {
  return userId === DEVELOPER_DISCORD_USER_ID;
}

function ensurePugSeasonState(data: StoreShape) {
  data.settings.pugs = normalizePugSettings(data.settings.pugs);
  const activeSeason = getActivePugSeason(data);
  const settings = normalizePugEloSettings(data.settings.pugs.elo);
  for (const rating of data.pugEloRatings) {
    rating.seasonId = rating.seasonId ?? activeSeason.id;
    rating.peakRating = Math.max(rating.peakRating ?? rating.rating ?? settings.startingRating, rating.rating ?? settings.startingRating);
  }
}

function getActivePugSeason(data: StoreShape): PugSeason {
  data.settings.pugs = normalizePugSettings(data.settings.pugs);
  return data.settings.pugs.seasons?.find((season) => season.status === 'active') ?? data.settings.pugs.seasons![0];
}

function finalizeActivePugSeason(data: StoreShape, endedAt: string, nextSeasonLabel?: string) {
  const activeSeason = getActivePugSeason(data);
  if (!activeSeason) throw new Error('No active PUG season found.');
  const rankSettings = normalizePugRankSettings(data.settings.pugs?.ranks);
  const eloSettings = normalizePugEloSettings(data.settings.pugs?.elo);
  const sortedRatings = [...data.pugEloRatings].sort((a, b) => b.rating - a.rating || (a.username ?? a.userId).localeCompare(b.username ?? b.userId));
  const publicSortedRatings = sortedRatings.filter((rating) => !isDeveloperAccount(rating.userId));
  const masterUserIds = new Set(publicSortedRatings.slice(0, 3).map((rating) => rating.userId));
  const rewards = completeSeasonBadgeRewards(activeSeason, rankSettings);

  data.pugSeasonLeaderboards = data.pugSeasonLeaderboards.filter((entry) => entry.seasonId !== activeSeason.id);
  data.pugSeasonLeaderboards.push(...publicSortedRatings.slice(0, 10).map((rating, index) => {
    const rank = resolveSeasonRank(rating.rating, rankSettings, masterUserIds.has(rating.userId));
    return { seasonId: activeSeason.id, seasonLabel: activeSeason.label, userId: rating.userId, username: rating.username, rating: rating.rating, rankId: rank.id, rankLabel: rank.label, placement: index + 1 };
  }));

  data.pugUserBadges = data.pugUserBadges.filter((badge) => badge.seasonId !== activeSeason.id);
  for (const rating of sortedRatings) {
    const finalIsMaster = masterUserIds.has(rating.userId);
    const badgeRank = finalIsMaster ? resolveSeasonRank(rating.rating, rankSettings, true) : resolveSeasonRank(rating.peakRating ?? rating.rating, rankSettings, false);
    const reward = rewards.find((item) => item.rankId === badgeRank.id) ?? defaultBadgeReward(activeSeason, badgeRank);
    data.pugUserBadges.push({
      id: `${rating.userId}-${activeSeason.id}-${badgeRank.id}`,
      userId: rating.userId,
      seasonId: activeSeason.id,
      seasonLabel: activeSeason.label,
      rankId: badgeRank.id,
      rankLabel: badgeRank.label,
      label: reward.label,
      abbreviation: reward.abbreviation,
      iconDataUrl: reward.iconDataUrl,
      awardedAt: endedAt
    });
  }

  activeSeason.status = 'completed';
  activeSeason.endedAt = endedAt;
  activeSeason.badgeRewards = rewards;
  const nextIndex = Math.max(1, ...data.settings.pugs!.seasons!.map((season) => Number(season.id.match(/s(\d+)/)?.[1] ?? 0))) + 1;
  const nextSeason: PugSeason = { id: `s${nextIndex}`, label: nextSeasonLabel?.trim().slice(0, 32) || `S${nextIndex}`, status: 'active', startsAt: endedAt, badgeRewards: completeSeasonBadgeRewards({ ...activeSeason, id: `s${nextIndex}`, label: nextSeasonLabel?.trim().slice(0, 32) || `S${nextIndex}`, badgeRewards: [] }, rankSettings) };
  data.settings.pugs!.seasons!.push(nextSeason);
  data.pugEloRatings = data.pugEloRatings.map((rating) => ({ ...rating, rating: eloSettings.startingRating, peakRating: eloSettings.startingRating, seasonId: nextSeason.id, updatedAt: endedAt }));
}

function completeSeasonBadgeRewards(season: PugSeason, rankSettings: PugRankSettings): PugSeasonBadgeReward[] {
  const existing = new Map(season.badgeRewards.map((reward) => [reward.rankId, reward]));
  const rankRewards = rankSettings.ranks.map((rank) => existing.get(rank.id) ?? defaultBadgeReward(season, rank));
  const masterRank = { id: 'master-infernal', label: 'Master Infernal', abbreviation: 'M1', iconDataUrl: rankSettings.masterIconDataUrl };
  return [...rankRewards, existing.get(masterRank.id) ?? defaultBadgeReward(season, masterRank)];
}

function defaultBadgeReward(season: Pick<PugSeason, 'label'>, rank: Pick<PugRankDefinition, 'id' | 'label' | 'abbreviation' | 'iconDataUrl'>): PugSeasonBadgeReward {
  return { rankId: rank.id, label: `${season.label} ${rank.label}`, abbreviation: rank.abbreviation, iconDataUrl: rank.iconDataUrl };
}

function resolveSeasonRank(rating: number, settings: PugRankSettings, isMaster: boolean) {
  if (isMaster) return { id: 'master-infernal', label: 'Master Infernal', abbreviation: 'M1', minRating: rating, iconDataUrl: settings.masterIconDataUrl };
  const ranks = settings.ranks.filter((rank) => rank.id !== 'master-infernal');
  return [...ranks].reverse().find((rank) => rating >= rank.minRating && (rank.maxRating === undefined || rating <= rank.maxRating)) ?? ranks[0] ?? { id: 'unranked', label: 'Unranked', abbreviation: 'UR', minRating: 0 };
}
