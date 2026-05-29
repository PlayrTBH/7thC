import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  OverwriteType,
  Partials,
  PermissionsBitField,
  type ColorResolvable,
  type Guild,
  type GuildMember
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { JsonStore } from './store.js';
import type { Team, TeamInvite, TeamMemberRole } from './types.js';

const organizationRoleColor = '#6b7280';

const organizationalRoleConfig: Record<TeamMemberRole, { name: string; color: ColorResolvable }> = {
  sub: { name: 'Team Sub', color: organizationRoleColor },
  main: { name: 'Team Main', color: organizationRoleColor },
  coach: { name: 'Team Coach', color: organizationRoleColor },
  captain: { name: 'Team Captain', color: organizationRoleColor }
};

export class TeamBot {
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel]
  });

  constructor(private readonly store: JsonStore) {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith('team-invite:')) return;

      const [, action, inviteId] = interaction.customId.split(':');
      try {
        if (action === 'accept') {
          await this.acceptInvite(inviteId, interaction.user.id);
          await interaction.reply({ content: 'Invite accepted. Your team roles have been added.', ephemeral: true });
        }
        if (action === 'decline') {
          await this.declineInvite(inviteId, interaction.user.id);
          await interaction.reply({ content: 'Invite declined.', ephemeral: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to process this invite.';
        await interaction.reply({ content: message, ephemeral: true });
      }
    });
  }

  async start() {
    await this.client.login(config.DISCORD_BOT_TOKEN);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) {
        resolve();
        return;
      }
      this.client.once(Events.ClientReady, () => resolve());
    });
    await this.ensureTeamRolesHoisted();
    console.log(`Discord bot ready as ${this.client.user?.tag}`);
  }

  async getGuild() {
    const guild = await this.client.guilds.fetch(config.DISCORD_GUILD_ID);
    return guild.fetch();
  }

  async getGuildMember(userId: string) {
    const guild = await this.getGuild();
    return guild.members.fetch(userId).catch(() => null);
  }

  async getAdministratorAccess(userId: string) {
    const guild = await this.getGuild();
    if (guild.ownerId === userId) return { isOwner: true, isAdmin: true };

    const settings = await this.store.getAdministratorSettings();
    if (!settings.adminRoleId) return { isOwner: false, isAdmin: false };

    const member = await guild.members.fetch(userId).catch(() => null);
    return { isOwner: false, isAdmin: Boolean(member?.roles.cache.has(settings.adminRoleId)) };
  }

  async getGuildRoles() {
    const guild = await this.getGuild();
    const roles = await guild.roles.fetch();
    return roles
      .filter((role) => role.id !== guild.roles.everyone.id)
      .map((role) => ({ id: role.id, name: role.name, managed: role.managed, position: role.position }))
      .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
  }

  async ensureTeamRolesHoisted() {
    const guild = await this.getGuild();
    const teams = await this.store.getTeams();
    await Promise.all(
      teams.map(async (team) => {
        const role = await guild.roles.fetch(team.roleId).catch(() => null);
        if (!role || role.hoist) return;
        await role.edit({ hoist: true, reason: 'Team roles are displayed separately by Team Hub' }).catch((error) => {
          console.warn(`Unable to hoist team role ${team.roleId}:`, error);
        });
      })
    );
  }

  async searchInvitableMembers(currentUserId: string, rawQuery: string) {
    const query = rawQuery.trim();
    if (query.length < 2) return [];

    const guild = await this.getGuild();
    const members = await guild.members.search({ query, limit: 25 });
    const unavailableUserIds = await this.store.getTeamMemberUserIds();
    return members
      .filter((member) => !member.user.bot && member.id !== currentUserId && !unavailableUserIds.has(member.id))
      .map((member) => ({
        id: member.id,
        displayName: member.displayName,
        username: member.user.username,
        tag: member.user.tag,
        avatarUrl: member.displayAvatarURL({ size: 64 })
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getTeamMemberDetails(teamId: string) {
    const guild = await this.getGuild();
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');

    const members = await this.store.getTeamMembers(teamId);
    return Promise.all(
      members.map(async (membership) => {
        const member = await guild.members.fetch(membership.userId).catch(() => null);
        return {
          ...membership,
          displayName: member?.displayName ?? membership.userId,
          username: member?.user.username ?? membership.userId,
          avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? '',
          isOwner: membership.userId === team.ownerId
        };
      })
    );
  }

  async createTeam(ownerId: string, rawTeamName: string, inviteeIds: string[]) {
    if (await this.store.getTeamForUser(ownerId)) {
      throw new Error('You are already in a team. Leave or delete your current team before creating another one.');
    }

    const guild = await this.getGuild();
    const owner = await guild.members.fetch(ownerId);
    const teamName = normalizeTeamName(rawTeamName);
    const safeChannelName = toChannelName(teamName);

    await assertBotPermissions(guild);
    await this.ensureOrganizationalRoles(guild);

    const role = await guild.roles.create({
      name: teamName,
      color: 'Random',
      hoist: true,
      permissions: [],
      reason: `Team role created by ${owner.user.tag}`
    });

    const category = await guild.channels.create({
      name: teamName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          type: OverwriteType.Role,
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
        {
          id: role.id,
          type: OverwriteType.Role,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak
          ]
        }
      ],
      reason: `Team category created by ${owner.user.tag}`
    });

    const textChannel = await guild.channels.create({
      name: safeChannelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Private text channel for ${teamName}`,
      reason: `Team text channel created by ${owner.user.tag}`
    });

    const voiceChannel = await guild.channels.create({
      name: `${teamName} Voice`,
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: `Team voice channel created by ${owner.user.tag}`
    });

    await owner.roles.add(role, 'Team owner role assignment');
    await this.applyOrganizationalRole(owner, 'captain');

    const team: Team = {
      id: randomUUID(),
      name: teamName,
      ownerId,
      guildId: guild.id,
      roleId: role.id,
      roleColor: role.hexColor,
      categoryId: category.id,
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id,
      createdAt: new Date().toISOString()
    };
    await this.store.addTeam(team, 'captain');

    const invites = await this.createAndSendInvites(guild, owner, team, inviteeIds);

    return { team, invites };
  }

  async inviteTeamMembers(teamId: string, inviterId: string, inviteeIds: string[], allowNonOwner = false) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');
    if (!allowNonOwner && team.ownerId !== inviterId) throw new Error('Only the team owner can invite new members.');

    const guild = await this.getGuild();
    const inviter = await guild.members.fetch(inviterId);
    return this.createAndSendInvites(guild, inviter, team, inviteeIds);
  }

  async setTeamMemberRole(teamId: string, userId: string, role: TeamMemberRole) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');

    const memberRecord = await this.store.getTeamMember(teamId, userId);
    if (!memberRecord) throw new Error('Team member not found.');

    const guild = await this.getGuild();
    const member = await guild.members.fetch(userId);
    await this.applyOrganizationalRole(member, role);
    await this.store.setTeamMemberRole(teamId, userId, role);
  }

  async transferTeamOwnership(teamId: string, newOwnerId: string) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');
    if (team.ownerId === newOwnerId) throw new Error('That member is already the team captain.');

    const newOwnerRecord = await this.store.getTeamMember(teamId, newOwnerId);
    if (!newOwnerRecord) throw new Error('New captain must already be a team member.');

    const guild = await this.getGuild();
    const newOwner = await guild.members.fetch(newOwnerId);
    const previousOwner = await guild.members.fetch(team.ownerId).catch(() => null);

    await newOwner.roles.add(team.roleId, 'Team captain transfer');
    await this.applyOrganizationalRole(newOwner, 'captain');
    if (previousOwner) await this.applyOrganizationalRole(previousOwner, 'coach');
    await this.store.transferTeamOwnership(teamId, newOwnerId);
  }

  async kickTeamMember(teamId: string, userId: string) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');
    if (team.ownerId === userId) throw new Error('Team owners cannot be kicked. Delete the team instead.');

    const guild = await this.getGuild();
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await member.roles.remove(team.roleId, 'Removed from team');
      await this.removeOrganizationalRoles(member);
    }
    await this.store.removeTeamMember(teamId, userId);
  }

  async leaveTeam(userId: string) {
    const team = await this.store.getTeamForUser(userId);
    if (!team) throw new Error('You are not currently in a team.');
    await this.kickTeamMember(team.id, userId);
  }

  async setTeamRoleColor(teamId: string, rawColor: string) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');

    const color = normalizeHexColor(rawColor);
    const guild = await this.getGuild();
    const role = await guild.roles.fetch(team.roleId);
    if (!role) throw new Error('Team role no longer exists in Discord.');

    await role.setColor(color, 'Team role color changed from website');
    await this.store.updateTeamRoleColor(teamId, color);
  }

  async deleteTeam(teamId: string) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');

    const guild = await this.getGuild();
    const members = await this.store.getTeamMembers(teamId);

    await Promise.all(
      members.map(async (membership) => {
        const member = await guild.members.fetch(membership.userId).catch(() => null);
        if (!member) return;
        await member.roles.remove(team.roleId, 'Team deleted').catch(() => undefined);
        await this.removeOrganizationalRoles(member);
      })
    );

    await guild.channels.delete(team.textChannelId, 'Team deleted').catch(() => undefined);
    await guild.channels.delete(team.voiceChannelId, 'Team deleted').catch(() => undefined);
    await guild.channels.delete(team.categoryId, 'Team deleted').catch(() => undefined);
    await guild.roles.delete(team.roleId, 'Team deleted').catch(() => undefined);
    await this.store.removeTeam(teamId);
  }

  private async createAndSendInvites(guild: Guild, inviter: GuildMember, team: Team, inviteeIds: string[]) {
    const unavailableUserIds = await this.store.getTeamMemberUserIds();
    const now = new Date().toISOString();
    const inviteCandidates = await Promise.all(
      unique(inviteeIds)
        .filter((inviteeId) => inviteeId !== inviter.id && !unavailableUserIds.has(inviteeId))
        .map(async (inviteeId) => guild.members.fetch(inviteeId).catch(() => null))
    );

    const invites: TeamInvite[] = inviteCandidates
      .filter((member): member is GuildMember => Boolean(member && !member.user.bot))
      .map((member) => ({
        id: randomUUID(),
        teamId: team.id,
        inviterId: inviter.id,
        inviteeId: member.id,
        status: 'pending',
        createdAt: now
      }));

    const addedInvites = await this.store.addInvites(invites);
    await Promise.all(addedInvites.map((invite) => this.sendInviteDm(guild, inviter, team, invite)));
    return addedInvites;
  }

  private async sendInviteDm(guild: Guild, owner: GuildMember, team: Team, invite: TeamInvite) {
    const member = await guild.members.fetch(invite.inviteeId).catch(() => null);
    if (!member) {
      await this.store.updateInviteStatus(invite.id, 'failed_dm');
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`team-invite:accept:${invite.id}`)
        .setLabel('Accept invite')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`team-invite:decline:${invite.id}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Secondary)
    );

    try {
      await member.send({
        content: `${owner.displayName} invited you to join **${team.name}** in **${guild.name}**. Accepting adds the team role and unlocks the team's channels.`,
        components: [row]
      });
    } catch {
      await this.store.updateInviteStatus(invite.id, 'failed_dm');
    }
  }

  private async declineInvite(inviteId: string, userId: string) {
    const invite = await this.store.getInvite(inviteId);
    if (!invite || invite.inviteeId !== userId || invite.status !== 'pending') {
      throw new Error('Invite is not available.');
    }
    await this.store.updateInviteStatus(invite.id, 'declined');
  }

  private async acceptInvite(inviteId: string, userId: string) {
    const invite = await this.store.getInvite(inviteId);
    if (!invite || invite.inviteeId !== userId || invite.status !== 'pending') {
      throw new Error('Invite is not available.');
    }

    const team = await this.store.getTeam(invite.teamId);
    if (!team) throw new Error('Team no longer exists.');

    if (await this.store.getTeamForUser(userId)) {
      throw new Error('You already own or belong to a team. Leave or delete your current team before accepting another invite.');
    }

    const guild = await this.getGuild();
    const member = await guild.members.fetch(userId);
    await member.roles.add(team.roleId, `Accepted team invite ${invite.id}`);
    await this.applyOrganizationalRole(member, 'main');

    try {
      await this.store.acceptInvite(invite.id, userId, 'main');
    } catch (error) {
      await member.roles.remove(team.roleId, 'Team invite accept rolled back').catch(() => undefined);
      await this.removeOrganizationalRoles(member).catch(() => undefined);
      throw error;
    }
  }

  private async ensureOrganizationalRoles(guild: Guild) {
    const existingRoles = await guild.roles.fetch();
    const roleIds = new Map<TeamMemberRole, string>();

    for (const [role, settings] of Object.entries(organizationalRoleConfig) as Array<[TeamMemberRole, (typeof organizationalRoleConfig)[TeamMemberRole]]>) {
      const existingRole = existingRoles.find((item) => item.name === settings.name);
      if (existingRole) {
        if (!existingRole.managed && (existingRole.hexColor.toLowerCase() !== String(settings.color).toLowerCase() || existingRole.hoist)) {
          await existingRole.edit({ color: settings.color, hoist: false, reason: 'Team organization role style normalized by Team Hub' });
        }
        roleIds.set(role, existingRole.id);
        continue;
      }

      const createdRole = await guild.roles.create({
        name: settings.name,
        color: settings.color,
        hoist: false,
        permissions: [],
        reason: 'Generic team organization role created by Team Hub'
      });
      roleIds.set(role, createdRole.id);
    }

    return roleIds;
  }

  private async applyOrganizationalRole(member: GuildMember, selectedRole: TeamMemberRole) {
    const roleIds = await this.ensureOrganizationalRoles(member.guild);
    const selectedRoleId = roleIds.get(selectedRole);
    if (!selectedRoleId) throw new Error(`Unable to find ${selectedRole} role.`);

    await member.roles.remove([...roleIds.values()].filter((roleId) => roleId !== selectedRoleId), 'Team organization role changed');
    await member.roles.add(selectedRoleId, 'Team organization role changed');
  }

  private async removeOrganizationalRoles(member: GuildMember) {
    const roleIds = await this.ensureOrganizationalRoles(member.guild);
    await member.roles.remove([...roleIds.values()], 'Removed from team');
  }
}

function normalizeTeamName(teamName: string) {
  const normalized = teamName.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (normalized.length < 2) throw new Error('Team name must be at least 2 characters.');
  return normalized;
}

function normalizeHexColor(color: string) {
  const normalized = color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) throw new Error('Role color must be a hex color like #5865f2.');
  return normalized.toUpperCase() as `#${string}`;
}

function toChannelName(teamName: string) {
  return teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 90) || 'team';
}

function unique(values: string[]) {
  return [...new Set(values)];
}

async function assertBotPermissions(guild: Guild) {
  const me = await guild.members.fetchMe();
  const needed = [PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels];
  if (!me.permissions.has(needed)) {
    throw new Error('Bot needs Manage Roles and Manage Channels permissions.');
  }
}
