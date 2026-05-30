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
  type Role,
  type GuildMember,
  ActivityType,
  type PresenceStatusData
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { JsonStore } from './store.js';
import type { BotActivityType, BotStatus, DeveloperSettings, Team, TeamInvite, TeamMemberRole } from './types.js';

const organizationRoleColor = '#6b7280';

const activityTypeMap: Record<BotActivityType, ActivityType.Playing | ActivityType.Watching | ActivityType.Listening | ActivityType.Competing> = {
  Playing: ActivityType.Playing,
  Watching: ActivityType.Watching,
  Listening: ActivityType.Listening,
  Competing: ActivityType.Competing
};

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

  private readonly teamCreationLocks = new Map<string, Promise<{ team: Team; invites: TeamInvite[] }>>();
  private restartOperation?: Promise<void>;

  constructor(private readonly store: JsonStore) {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith('team-invite:')) return;

      const [, action, inviteId] = interaction.customId.split(':');
      try {
        if (action === 'accept') {
          await this.acceptInvite(inviteId, interaction.user.id);
          await interaction.reply({ content: 'Invite accepted. Your team roles have been added.', ephemeral: true });
          await interaction.message.delete().catch((deleteError) => {
            console.warn(`Unable to delete accepted invite DM ${inviteId}:`, deleteError);
          });
        }
        if (action === 'decline') {
          await this.declineInvite(inviteId, interaction.user.id);
          await interaction.reply({ content: 'Invite declined.', ephemeral: true });
          await interaction.message.delete().catch((deleteError) => {
            console.warn(`Unable to delete declined invite DM ${inviteId}:`, deleteError);
          });
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
    await this.ensureTeamRolesDisplayed();
    await this.applyDeveloperSettings(await this.store.getDeveloperSettings());
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

  async getDeveloperStats() {
    const guild = await this.getGuild();
    const [roles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    const memory = process.memoryUsage();

    return {
      bot: {
        tag: this.client.user?.tag ?? 'Unknown',
        id: this.client.user?.id ?? 'Unknown',
        ready: this.client.isReady(),
        uptimeMs: this.client.uptime ?? 0,
        websocketPingMs: this.client.ws.ping,
        status: this.client.user?.presence.status ?? 'unknown'
      },
      process: {
        uptimeMs: Math.round(process.uptime() * 1000),
        memoryRssBytes: memory.rss,
        memoryHeapUsedBytes: memory.heapUsed,
        nodeVersion: process.version
      },
      guild: {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        memberCount: guild.memberCount,
        roleCount: roles.size,
        channelCount: channels.size
      },
      cache: {
        guilds: this.client.guilds.cache.size,
        users: this.client.users.cache.size,
        channels: this.client.channels.cache.size
      }
    };
  }

  async updateDeveloperSettings(settings: DeveloperSettings) {
    await this.store.updateDeveloperSettings(settings);
    await this.applyDeveloperSettings(settings);
  }

  async restart() {
    if (!this.restartOperation) {
      this.restartOperation = (async () => {
        console.warn('Developer requested Discord bot restart.');
        this.client.destroy();
        await this.start();
      })().finally(() => {
        this.restartOperation = undefined;
      });
    }

    return this.restartOperation;
  }

  async applyDeveloperSettings(settings: DeveloperSettings) {
    if (!this.client.user) return;
    const activityName = settings.activityName?.trim();
    this.client.user.setPresence({
      status: (settings.botStatus ?? 'online') as PresenceStatusData,
      activities: activityName
        ? [
            {
              name: activityName.slice(0, 128),
              type: activityTypeMap[settings.activityType ?? 'Playing']
            }
          ]
        : []
    });
  }

  async ensureTeamRolesDisplayed() {
    const guild = await this.getGuild();
    const teams = await this.store.getTeams();
    const organizationRoleIds = await this.ensureOrganizationalRoles(guild);
    for (const team of teams) {
      await this.ensureTeamRolePlacement(guild, team.roleId, organizationRoleIds).catch((error) => {
        console.warn(`Unable to place team role ${team.roleId} above organization roles:`, error);
      });
    }
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

  async getTeamInviteDetails(teamId: string) {
    const guild = await this.getGuild();
    const invites = await this.store.getTeamInvites(teamId);
    return Promise.all(
      invites.map(async (invite) => {
        const member = await guild.members.fetch(invite.inviteeId).catch(() => null);
        return {
          ...invite,
          displayName: member?.displayName ?? invite.inviteeId,
          username: member?.user.username ?? invite.inviteeId,
          avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? ''
        };
      })
    );
  }

  async createTeam(ownerId: string, rawTeamName: string, inviteeIds: string[]) {
    const activeCreation = this.teamCreationLocks.get(ownerId);
    if (activeCreation) {
      await activeCreation.catch(() => undefined);
      if (await this.store.getTeamForUser(ownerId)) {
        throw new Error('You are already in a team. Leave or delete your current team before creating another one.');
      }
    }

    const creation = this.createTeamUnlocked(ownerId, rawTeamName, inviteeIds);
    this.teamCreationLocks.set(ownerId, creation);
    try {
      return await creation;
    } finally {
      if (this.teamCreationLocks.get(ownerId) === creation) {
        this.teamCreationLocks.delete(ownerId);
      }
    }
  }

  private async createTeamUnlocked(ownerId: string, rawTeamName: string, inviteeIds: string[]) {
    if (await this.store.getTeamForUser(ownerId)) {
      throw new Error('You are already in a team. Leave or delete your current team before creating another one.');
    }

    const guild = await this.getGuild();
    const owner = await guild.members.fetch(ownerId);
    const teamName = normalizeTeamName(rawTeamName);
    const safeChannelName = toChannelName(teamName);

    await assertBotPermissions(guild);
    const organizationRoleIds = await this.ensureOrganizationalRoles(guild);

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
    try {
      await this.ensureTeamRolePlacement(guild, role, organizationRoleIds).catch((error) => {
        console.warn(`Unable to place newly created team role ${role.id} above organization roles:`, error);
      });
      await owner.roles.add(role, 'Team owner role assignment');
      await this.applyOrganizationalRole(owner, 'captain');
      await this.store.addTeam(team, 'captain');
    } catch (error) {
      await guild.channels.delete(textChannel.id, 'Team creation rolled back').catch(() => undefined);
      await guild.channels.delete(voiceChannel.id, 'Team creation rolled back').catch(() => undefined);
      await guild.channels.delete(category.id, 'Team creation rolled back').catch(() => undefined);
      await guild.roles.delete(role.id, 'Team creation rolled back').catch(() => undefined);
      await owner.roles.remove(role.id, 'Team creation rolled back').catch(() => undefined);
      await this.removeOrganizationalRoles(owner).catch(() => undefined);
      throw error;
    }

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

  async kickTeamMember(teamId: string, userId: string, options: { notify?: boolean } = { notify: true }) {
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

    if (options.notify ?? true) {
      await this.sendTeamKickDm(userId, team);
    }
  }

  async leaveTeam(userId: string) {
    const team = await this.store.getTeamForUser(userId);
    if (!team) throw new Error('You are not currently in a team.');
    await this.kickTeamMember(team.id, userId, { notify: false });
  }

  async setTeamRoleColor(teamId: string, rawColor: string) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');

    const color = normalizeHexColor(rawColor);
    const guild = await this.getGuild();
    const role = await guild.roles.fetch(team.roleId);
    if (!role) throw new Error('Team role no longer exists in Discord.');

    await role.setColor(color, 'Team role color changed from 7th Circle Team Hub');
    await this.store.updateTeamRoleColor(teamId, color);
  }

  async renameTeam(teamId: string, rawTeamName: string) {
    const team = await this.store.getTeam(teamId);
    if (!team) throw new Error('Team not found.');

    const teamName = normalizeTeamName(rawTeamName);
    const safeChannelName = toChannelName(teamName);
    const guild = await this.getGuild();
    await assertBotPermissions(guild);

    const role = await guild.roles.fetch(team.roleId);
    if (!role) throw new Error('Team role no longer exists in Discord.');

    await role.setName(teamName, 'Team renamed from 7th Circle Team Hub');
    await renameGuildChannel(guild, team.categoryId, teamName, 'Team category renamed from 7th Circle Team Hub');
    await renameGuildChannel(guild, team.textChannelId, safeChannelName, 'Team text channel renamed from 7th Circle Team Hub');
    await renameGuildChannel(guild, team.voiceChannelId, `${teamName} Voice`, 'Team voice channel renamed from 7th Circle Team Hub');
    await this.store.updateTeamName(teamId, teamName);
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

  private async sendTeamKickDm(userId: string, team: Team) {
    const guild = await this.getGuild();
    const member = await guild.members.fetch(userId).catch(() => null);
    const recipient = member?.user ?? (await this.client.users.fetch(userId).catch(() => null));
    if (!recipient) return;

    await recipient
      .send({
        content: `You have been kicked from "${team.name}" team.`,
        allowedMentions: { parse: [] }
      })
      .catch((error) => {
        console.warn(`Unable to send team kick DM to ${userId} for team ${team.id}:`, error);
      });
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

  private async ensureTeamRolePlacement(guild: Guild, roleOrId: Role | string, organizationRoleIds?: Map<TeamMemberRole, string>) {
    const roleIds = organizationRoleIds ?? (await this.ensureOrganizationalRoles(guild));
    const roles = await guild.roles.fetch();
    let teamRole = typeof roleOrId === 'string' ? roles.get(roleOrId) ?? (await guild.roles.fetch(roleOrId)) : roleOrId;
    if (!teamRole) return;

    const organizationRoles = [...roleIds.values()]
      .map((roleId) => roles.get(roleId))
      .filter((role): role is Role => Boolean(role));
    if (!organizationRoles.length) return;

    if (!teamRole.editable) {
      console.warn(`Team role ${teamRole.id} is not editable by the bot; skipping role placement.`);
      return;
    }

    const me = await guild.members.fetchMe();
    const highestManageablePosition = me.roles.highest.position - 1;
    if (highestManageablePosition < 1) {
      console.warn('Bot role is not high enough to place team roles; skipping role placement.');
      return;
    }

    const highestOrganizationRolePosition = Math.max(...organizationRoles.map((role) => role.position));
    if (!teamRole.hoist) {
      teamRole = await teamRole.setHoist(true, 'Team roles are displayed separately by 7th Circle Team Hub');
    }

    const desiredPosition = Math.min(highestOrganizationRolePosition + 1, highestManageablePosition);
    if (highestOrganizationRolePosition >= highestManageablePosition) {
      console.warn(
        `Bot role is not high enough to place team role ${teamRole.id} above organization roles; placing it as high as the bot can manage.`
      );
    }

    if (teamRole.position < desiredPosition) {
      await teamRole.setPosition(desiredPosition, {
        reason: 'Team roles are placed above 7th Circle Team Hub organization roles when Discord role hierarchy allows it'
      });
    }
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
          await existingRole.edit({ color: settings.color, hoist: false, reason: 'Team organization role style normalized by 7th Circle Team Hub' });
        }
        roleIds.set(role, existingRole.id);
        continue;
      }

      const createdRole = await guild.roles.create({
        name: settings.name,
        color: settings.color,
        hoist: false,
        permissions: [],
        reason: 'Generic team organization role created by 7th Circle Team Hub'
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

async function renameGuildChannel(guild: Guild, channelId: string, name: string, reason: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !('setName' in channel)) return;
  await channel.setName(name, reason);
}

async function assertBotPermissions(guild: Guild) {
  const me = await guild.members.fetchMe();
  const needed = [PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels];
  if (!me.permissions.has(needed)) {
    throw new Error('Bot needs Manage Roles and Manage Channels permissions.');
  }
}
