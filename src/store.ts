import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdministratorSettings, DeveloperSettings, Event, EventRegistration, StoreShape, Team, TeamInvite, TeamMember, TeamMemberRole } from './types.js';
import { withFileLock } from './file-lock.js';

const initialStore: StoreShape = {
  teams: [],
  members: [],
  invites: [],
  events: [],
  eventRegistrations: [],
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

  async updateEvent(eventId: string, updates: Pick<Event, 'title' | 'description' | 'teamLimit' | 'requiredMainPlayers' | 'requiredSubstitutes' | 'startsAt' | 'endsAt' | 'registrationOpensAt' | 'registrationClosesAt'>) {
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
    settings: data.settings ?? {}
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

  return normalized;
}
