import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdministratorSettings, StoreShape, Team, TeamInvite, TeamMember, TeamMemberRole } from './types.js';

const initialStore: StoreShape = {
  teams: [],
  members: [],
  invites: [],
  settings: {}
};

export class JsonStore {
  private queue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const data = await this.read();
      await this.write(data);
    } catch {
      await this.write(initialStore);
    }
  }

  async getTeamsByOwner(ownerId: string) {
    const data = await this.read();
    return data.teams.filter((team) => team.ownerId === ownerId);
  }

  async getTeams() {
    const data = await this.read();
    return [...data.teams].sort((a, b) => a.name.localeCompare(b.name));
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
    const raw = await readFile(this.filePath, 'utf8');
    return normalizeStore(JSON.parse(raw) as Partial<StoreShape>);
  }

  private async write(data: StoreShape) {
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  private async update(mutator: (data: StoreShape) => StoreShape) {
    const next = this.queue.then(async () => {
      const current = await this.read();
      await this.write(mutator(current));
    });
    this.queue = next.catch(() => undefined);
    await next;
  }
}

function normalizeStore(data: Partial<StoreShape>): StoreShape {
  const normalized: StoreShape = {
    teams: data.teams ?? [],
    members: data.members ?? [],
    invites: data.invites ?? [],
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

  for (const team of normalized.teams) {
    const owner = normalized.members.find((member) => member.teamId === team.id && member.userId === team.ownerId);
    if (owner) owner.role = 'captain';
  }

  return normalized;
}
