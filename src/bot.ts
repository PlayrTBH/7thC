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
  type Guild,
  type GuildMember
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { JsonStore } from './store.js';
import type { Team, TeamInvite } from './types.js';

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
          await interaction.reply({ content: 'Invite accepted. Your team role has been added.', ephemeral: true });
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

  async listInvitableMembers(currentUserId: string) {
    const guild = await this.getGuild();
    const members = await guild.members.fetch();
    return members
      .filter((member) => !member.user.bot && member.id !== currentUserId)
      .map((member) => ({
        id: member.id,
        displayName: member.displayName,
        username: member.user.username,
        avatarUrl: member.displayAvatarURL({ size: 64 })
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async createTeam(ownerId: string, rawTeamName: string, inviteeIds: string[]) {
    const guild = await this.getGuild();
    const owner = await guild.members.fetch(ownerId);
    const teamName = normalizeTeamName(rawTeamName);
    const safeChannelName = toChannelName(teamName);

    await assertBotPermissions(guild);

    const role = await guild.roles.create({
      name: teamName,
      color: 'Random',
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

    const team: Team = {
      id: randomUUID(),
      name: teamName,
      ownerId,
      guildId: guild.id,
      roleId: role.id,
      categoryId: category.id,
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id,
      createdAt: new Date().toISOString()
    };
    await this.store.addTeam(team);

    const invites: TeamInvite[] = unique(inviteeIds)
      .filter((inviteeId) => inviteeId !== ownerId)
      .map((inviteeId) => ({
        id: randomUUID(),
        teamId: team.id,
        inviterId: ownerId,
        inviteeId,
        status: 'pending',
        createdAt: new Date().toISOString()
      }));

    await this.store.addInvites(invites);
    await Promise.all(invites.map((invite) => this.sendInviteDm(guild, owner, team, invite)));

    return { team, invites };
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

    const guild = await this.getGuild();
    const member = await guild.members.fetch(userId);
    await member.roles.add(team.roleId, `Accepted team invite ${invite.id}`);
    await this.store.updateInviteStatus(invite.id, 'accepted');
  }
}

function normalizeTeamName(teamName: string) {
  const normalized = teamName.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (normalized.length < 2) throw new Error('Team name must be at least 2 characters.');
  return normalized;
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
