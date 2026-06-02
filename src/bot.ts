import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  OverwriteType,
  Partials,
  PermissionsBitField,
  MessageFlags,
  type ColorResolvable,
  type Guild,
  type GuildInvitableChannelResolvable,
  type Role,
  GuildMember,
  ActivityType,
  type PresenceStatusData,
  type TextChannel,
  type VoiceChannel
} from 'discord.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { config, DEVELOPER_DISCORD_USER_ID } from './config.js';
import type { JsonStore } from './store.js';
import type { BotActivityType, BotStatus, DeveloperSettings, PugAbandonLog, PugCaptainDraftState, PugEloChange, PugEloRating, PugEloSettings, PugMatchLog, PugQueueSize, PugRankDefinition, PugRankSettings, PugTeamMode, PugVoteMode, Team, TeamInvite, TeamMemberRole } from './types.js';

const organizationRoleColor = '#6b7280';
const pugQueueSizes = [6, 12] as const satisfies readonly PugQueueSize[];
const PUG_QUEUE_COUNTDOWN_MS = 30 * 1000;
const PUG_ABANDON_GRACE_MS = 2 * 60 * 1000;
const PUG_VOTE_REPOST_MS = 12 * 1000;
const PUG_QUEUE_COUNTDOWN_REFRESH_MS = 1000;
const PUG_DEAD_MATCH_MS = 60 * 60 * 1000;
const PUG_LEADERBOARD_REFRESH_MS = 3 * 60 * 60 * 1000;
const pugCategoryName = 'Pugs';
const pugLeaderboardChannelName = 'leaderboard';
const pugLobbyChannelBaseName = 'PUG Lobby';
const pugLobbyChannelNamePattern = /^PUG Lobby(?: - \d+ in-match)?$/;
type PugQueuedPlayer = { userId: string; username: string; voiceChannelId?: string };
type PugQueueCountdown = { endsAt: number; timer: NodeJS.Timeout };
type PugCaptainDraft = PugCaptainDraftState;
type PugRankTransition = { before: PugRankDefinition; after: PugRankDefinition };
type PugEloResult = { changes: PugEloChange[]; teamTotals: number[]; rankTransitions: Map<string, PugRankTransition> };
type PugMatch = { id: string; size: PugQueueSize; playerIds: string[]; playerUsernames: Map<string, string>; playerRankLabels: Map<string, string>; playerRankRoleIds: Map<string, string>; categoryId: string; queueVoiceChannelId: string; textChannelId: string; teamVoiceChannelIds: string[]; modeVotes: Map<string, PugTeamMode>; selectedMode?: PugTeamMode; modeVoteMessageId?: string; modeVoteRefreshTimer?: NodeJS.Timeout; captainDraft?: PugCaptainDraft; teams?: string[][]; map?: string; voteMode?: PugVoteMode; voteMessageId?: string; voteRefreshTimer?: NodeJS.Timeout; deadMatchTimer?: NodeJS.Timeout; voteStartedAt?: string; votes: Map<string, string>; teamEloTotals?: number[]; eloChanges?: PugEloChange[]; createdAt: string; updatedAt: string };

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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel]
  });

  private readonly pugQueues = new Map<PugQueueSize, PugQueuedPlayer[]>();
  private readonly pugQueueCountdowns = new Map<PugQueueSize, PugQueueCountdown>();
  private readonly pugMatches = new Map<string, PugMatch>();
  private pugQueueOperation: Promise<void> = Promise.resolve();
  private readonly pugMatchEndLocks = new Map<string, Promise<void>>();
  private pugMapPickOperation: Promise<void> = Promise.resolve();
  private lastPickedPugMap?: string;
  private pugQueueMessageRefresh?: NodeJS.Timeout;
  private pugQueueCountdownRefresh?: NodeJS.Timeout;
  private pugQueueMessageRefreshInFlight?: Promise<void>;
  private pugQueueMessageRefreshAgain = false;
  private pugLobbyEnsureOperation?: Promise<VoiceChannel>;
  private pugLobbyReturnOperation: Promise<void> = Promise.resolve();
  private pugLeaderboardRefresh?: NodeJS.Timeout;
  private pugLeaderboardRefreshInFlight?: Promise<string>;
  private readonly teamCreationLocks = new Map<string, Promise<{ team: Team; invites: TeamInvite[] }>>();
  private restartOperation?: Promise<void>;

  constructor(private readonly store: JsonStore) {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'elo') {
          try {
            await this.handleEloCommand(interaction);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to look up your ELO.';
            if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message }).catch(() => undefined);
            else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
          }
        }
        return;
      }
      if (!interaction.isButton()) return;
      if (interaction.customId.startsWith('pug:')) {
        const isQueueMembershipAction = interaction.customId.startsWith('pug:join:') || interaction.customId.startsWith('pug:leave:');
        try {
          if (!interaction.deferred && !interaction.replied) {
            if (isQueueMembershipAction) await interaction.deferUpdate();
            else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          }
          await this.handlePugInteraction(interaction);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to process this PUG action.';
          const response = isQueueMembershipAction && (interaction.deferred || interaction.replied)
            ? interaction.followUp({ content: message, flags: MessageFlags.Ephemeral })
            : this.respondToPugInteraction(interaction, message);
          await response.catch((responseError) => {
            console.warn('Unable to send PUG interaction response:', responseError);
          });
        }
        return;
      }
      if (!interaction.customId.startsWith('team-invite:')) return;

      const [, action, inviteId] = interaction.customId.split(':');
      try {
        if (action === 'accept') {
          await this.acceptInvite(inviteId, interaction.user.id);
          await interaction.reply({ content: 'Invite accepted. Your team roles have been added.', flags: MessageFlags.Ephemeral });
          await interaction.message.delete().catch((deleteError) => {
            console.warn(`Unable to delete accepted invite DM ${inviteId}:`, deleteError);
          });
        }
        if (action === 'decline') {
          await this.declineInvite(inviteId, interaction.user.id);
          await interaction.reply({ content: 'Invite declined.', flags: MessageFlags.Ephemeral });
          await interaction.message.delete().catch((deleteError) => {
            console.warn(`Unable to delete declined invite DM ${inviteId}:`, deleteError);
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to process this invite.';
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
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
    await this.getGuildInviteUrl();
    await this.ensureTeamRolesDisplayed();
    await this.registerPugCommands();
    await this.restoreOngoingPugMatches();
    await this.applyDeveloperSettings(await this.store.getDeveloperSettings());
    await this.publishPugLeaderboardMessage().catch((error) => console.warn('Unable to publish PUG leaderboard message:', error));
    this.schedulePugLeaderboardRefresh(PUG_LEADERBOARD_REFRESH_MS);
    console.log(`Discord bot ready as ${this.client.user?.tag}`);
  }

  async getGuild() {
    const cached = this.client.guilds.cache.get(config.DISCORD_GUILD_ID);
    if (cached) return cached;
    const guild = await this.client.guilds.fetch(config.DISCORD_GUILD_ID);
    return guild.fetch();
  }

  private async registerPugCommands() {
    const guild = await this.getGuild();
    const definition = { name: 'elo', description: 'Show your persistent PUG ELO rating.' };
    const commands = await guild.commands.fetch().catch(() => null);
    const existing = commands?.find((command) => command.name === 'elo');
    if (existing) await existing.edit(definition).catch((error) => console.warn('Unable to update /elo command:', error));
    else await guild.commands.create(definition).catch((error) => console.warn('Unable to register /elo command:', error));
  }

  private async restoreOngoingPugMatches() {
    const guild = await this.getGuild();
    const logs = (await this.store.getPugMatchLogs()).filter((log) => log.status === 'ongoing' || log.status === 'reset');
    let lobbyCountNeedsRefresh = false;
    for (const log of logs.reverse()) {
      if (this.pugMatches.has(log.id)) continue;
      const channels = await this.resolvePugMatchChannels(guild, log);
      if (!channels) {
        const endedAt = new Date().toISOString();
        console.warn(`Unable to restore ongoing PUG match ${log.id}: match channels were not found. Marking it deleted so it is not restored again.`);
        await this.store.upsertPugMatchLog({
          ...log,
          status: 'deleted',
          result: 'Canceled during startup because match channels were missing',
          endedAt,
          updatedAt: endedAt
        });
        lobbyCountNeedsRefresh = true;
        continue;
      }

      const ranks = Object.keys(log.playerRankLabels ?? {}).length || Object.keys(log.playerRankRoleIds ?? {}).length
        ? { labels: new Map(Object.entries(log.playerRankLabels ?? {})), roleIds: new Map(Object.entries(log.playerRankRoleIds ?? {})) }
        : await this.buildPugPlayerRanks(guild, log.playerIds);
      const captainDraft = this.restorePugCaptainDraft(log);
      const teams = log.voteMode ? log.teams.map((team) => [...team]) : undefined;
      const match: PugMatch = {
        id: log.id,
        size: log.size,
        playerIds: [...log.playerIds],
        playerUsernames: new Map(Object.entries(log.playerUsernames)),
        playerRankLabels: ranks.labels,
        playerRankRoleIds: ranks.roleIds,
        categoryId: channels.categoryId,
        queueVoiceChannelId: channels.queueVoiceChannelId,
        textChannelId: channels.textChannelId,
        teamVoiceChannelIds: channels.teamVoiceChannelIds,
        modeVotes: new Map(Object.entries(log.modeVotes ?? {}) as [string, PugTeamMode][]),
        selectedMode: log.mode,
        modeVoteMessageId: log.modeVoteMessageId,
        captainDraft,
        teams,
        map: log.map,
        voteMode: log.voteMode,
        voteMessageId: log.voteMessageId,
        voteStartedAt: log.voteStartedAt,
        votes: new Map(Object.entries(log.votes)),
        teamEloTotals: log.teamEloTotals,
        eloChanges: log.eloChanges,
        createdAt: log.createdAt,
        updatedAt: log.updatedAt
      };
      this.pugMatches.set(match.id, match);
      await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
      this.resumePugMatch(guild, match).catch((error) => console.warn(`Unable to resume PUG match ${match.id}:`, error));
    }
    if (this.pugMatches.size || lobbyCountNeedsRefresh) {
      await this.updatePugLobbyChannelName(guild).catch((error) => console.warn('Unable to update PUG lobby in-match count after restoring matches:', error));
    }
  }

  private async resolvePugMatchChannels(guild: Guild, log: PugMatchLog) {
    const category = log.categoryId ? await guild.channels.fetch(log.categoryId).catch(() => null) : null;
    const text = log.textChannelId ? await guild.channels.fetch(log.textChannelId).catch(() => null) : null;
    const queueVoice = log.queueVoiceChannelId ? await guild.channels.fetch(log.queueVoiceChannelId).catch(() => null) : null;
    if (category?.type === ChannelType.GuildCategory && text?.type === ChannelType.GuildText && queueVoice?.type === ChannelType.GuildVoice) {
      const teamVoiceChannels = await Promise.all((log.teamVoiceChannelIds ?? []).map((channelId) => guild.channels.fetch(channelId).catch(() => null)));
      return {
        categoryId: category.id,
        textChannelId: text.id,
        queueVoiceChannelId: queueVoice.id,
        teamVoiceChannelIds: teamVoiceChannels.filter((channel): channel is VoiceChannel => channel?.type === ChannelType.GuildVoice).map((channel) => channel.id)
      };
    }

    const channels = await guild.channels.fetch();
    const fallbackText = text?.type === ChannelType.GuildText
      ? text
      : channels.find((channel) => channel?.type === ChannelType.GuildText && channel.topic?.includes(log.id));
    const fallbackCategory = category?.type === ChannelType.GuildCategory
      ? category
      : fallbackText?.parent ?? channels.find((channel) => channel?.type === ChannelType.GuildCategory && channel.name === `pug match ${formatPugMatchId(log.id)}`);
    if (!fallbackText || fallbackText.type !== ChannelType.GuildText || !fallbackCategory || fallbackCategory.type !== ChannelType.GuildCategory) return undefined;

    const childVoiceChannels = channels.filter((channel): channel is VoiceChannel => channel?.type === ChannelType.GuildVoice && channel.parentId === fallbackCategory.id);
    const fallbackQueueVoice = queueVoice?.type === ChannelType.GuildVoice ? queueVoice : childVoiceChannels.find((channel) => channel.name === 'queue');
    if (!fallbackQueueVoice) return undefined;
    return {
      categoryId: fallbackCategory.id,
      textChannelId: fallbackText.id,
      queueVoiceChannelId: fallbackQueueVoice.id,
      teamVoiceChannelIds: childVoiceChannels.filter((channel) => channel.id !== fallbackQueueVoice.id).sort((a, b) => a.name.localeCompare(b.name)).map((channel) => channel.id)
    };
  }

  private restorePugCaptainDraft(log: PugMatchLog): PugCaptainDraft | undefined {
    if (log.captainDraft) {
      return {
        captainIds: [...log.captainDraft.captainIds],
        teams: log.captainDraft.teams.map((team) => [...team]),
        availablePlayerIds: [...log.captainDraft.availablePlayerIds],
        currentCaptainIndex: log.captainDraft.currentCaptainIndex,
        picksThisTurn: log.captainDraft.picksThisTurn,
        messageId: log.captainDraft.messageId
      };
    }
    if (log.mode !== 'captains' || !log.captainIds.length || log.voteMode) return undefined;
    const teams = log.teams.length ? log.teams.map((team) => [...team]) : log.captainIds.map((captainId) => [captainId]);
    const draftedPlayerIds = new Set(teams.flat());
    return {
      captainIds: [...log.captainIds],
      teams,
      availablePlayerIds: log.playerIds.filter((playerId) => !draftedPlayerIds.has(playerId)),
      currentCaptainIndex: 0,
      picksThisTurn: 0
    };
  }

  private async resumePugMatch(guild: Guild, match: PugMatch) {
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) return;

    if (!match.selectedMode) {
      if (match.modeVoteMessageId) {
        this.startPugModeVoteReposter(match);
        return;
      }
      await this.waitForPugPlayersInQueue(guild, match);
      if (!this.pugMatches.has(match.id) || match.selectedMode || match.modeVoteMessageId) return;
      await this.sendPugModeVotePrompt(text, match, `${match.playerIds.map((id) => `<@${id}>`).join(' ')} everyone is in the queue voice channel. Vote on how teams should be created. A majority vote decides the team selection mode.`);
      return;
    }

    if (match.selectedMode === 'random' && !match.teams?.length) {
      const teams = createRandomTeams(match.playerIds, match.size);
      await this.finalizePugTeams(guild, text, match, teams, 'Random teams won the majority vote and teams have been created.', { reuseTeamVoiceChannels: Boolean(match.teamVoiceChannelIds.length), preserveMap: Boolean(match.map) });
      return;
    }

    if (match.selectedMode === 'captains' && !match.captainDraft && !match.teams?.length) {
      await this.startPugCaptainDraft(text, match);
      return;
    }

    if (match.captainDraft?.availablePlayerIds.length) return;
    if (match.captainDraft && !match.voteMode) {
      await this.finalizePugTeams(guild, text, match, match.captainDraft.teams, 'Captains drafted their teams.', { reuseTeamVoiceChannels: Boolean(match.teamVoiceChannelIds.length), preserveMap: Boolean(match.map) });
      return;
    }

    if (match.teams?.length && match.voteMode) this.startPugResultVoteReposter(match, this.getPugDeadMatchDelay(match));
  }

  private getPugDeadMatchDelay(match: PugMatch) {
    const startedAt = Date.parse(match.voteStartedAt ?? match.createdAt);
    if (!Number.isFinite(startedAt)) return PUG_DEAD_MATCH_MS;
    const remaining = PUG_DEAD_MATCH_MS - (Date.now() - startedAt);
    return Math.max(PUG_VOTE_REPOST_MS, remaining);
  }

  private async sendPugModeVotePrompt(text: import('discord.js').TextChannel, match: PugMatch, content: string) {
    const modeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pug:mode:${match.id}:random`).setLabel('Random teams').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pug:mode:${match.id}:captains`).setLabel('Captains').setStyle(ButtonStyle.Primary)
    );
    const message = await text.send({ content, embeds: [buildPugModeVoteEmbed(match)], components: [modeRow], allowedMentions: { users: match.playerIds } });
    match.modeVoteMessageId = message.id;
    match.updatedAt = new Date().toISOString();
    this.startPugModeVoteReposter(match);
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  private async handleEloCommand(interaction: import('discord.js').ChatInputCommandInteraction) {
    const rating = await this.store.getPugEloRating(interaction.user.id);
    await this.store.setPugEloRating(interaction.user.id, rating.rating, interaction.user.username);
    await this.syncPugRankRolesForUsers([interaction.user.id]).catch((error) => console.warn('Unable to sync PUG rank role after /elo:', error));
    await interaction.reply({ content: `Your PUG ELO is **${formatElo(rating.rating)}**.`, flags: MessageFlags.Ephemeral });
  }


  async getGuildInviteUrl() {
    const settings = await this.store.getAdministratorSettings();
    if (settings.discordInviteUrl) return settings.discordInviteUrl;

    const guild = await this.getGuild();
    const channel = await findInviteChannel(guild);
    const invite = await guild.invites.create(channel, {
      maxAge: 0,
      maxUses: 0,
      unique: false,
      reason: 'Permanent website invite created by 7th Circle Team Hub'
    });
    const inviteUrl = invite.url;
    await this.store.updateDiscordInviteUrl(inviteUrl);
    return inviteUrl;
  }

  async getGuildMember(userId: string) {
    const guild = await this.getGuild();
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    return { id: member.id, displayName: member.displayName, username: member.user.username };
  }

  private async fetchPugMemberVoiceState(guild: Guild, userId: string) {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    const cachedChannelId = member?.voice.channelId ?? null;
    const voiceState = await guild.voiceStates.fetch(userId, { force: true }).catch((error) => {
      if (isDiscordNotFoundError(error)) return null;
      console.warn(`Unable to fetch fresh voice state for PUG player ${userId}; falling back to cache:`, error);
      return undefined;
    });
    return { member, channelId: voiceState === undefined ? cachedChannelId : voiceState?.channelId ?? null };
  }

  async getGuildMemberProfiles(userIds: string[]) {
    const guild = await this.getGuild();
    const uniqueUserIds = [...new Set(userIds)];
    return Promise.all(
      uniqueUserIds.map(async (userId) => {
        const member = await guild.members.fetch(userId).catch(() => null);
        return {
          userId,
          displayName: member?.displayName,
          username: member?.user.username,
          avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? ''
        };
      })
    );
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

  async syncPugRankRoles() {
    const guild = await this.getGuild();
    await Promise.all([this.ensurePugRankRoles(guild), this.ensurePugRankEmojis(guild)]);
    await this.ensureTeamRolesDisplayed();
    await this.syncPugRankRolesForRatedMembers(guild);
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


  async publishPugQueueMessage() {
    const settings = await this.store.getAdministratorSettings();
    const pugs = settings.pugs;
    if (!pugs?.queueChannelId) throw new Error('Configure a PUG queue channel before publishing the queue message.');

    const guild = await this.getGuild();
    await assertBotPermissions(guild);
    const channel = await guild.channels.fetch(pugs.queueChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('The configured PUG queue channel must be a text channel.');

    const payload = this.buildPugQueueMessage();
    if (pugs.queueMessageId) {
      const existing = await channel.messages.fetch(pugs.queueMessageId).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return existing.id;
      }
    }

    const message = await channel.send(payload);
    await this.store.updatePugSettings({ ...pugs, queueMessageId: message.id });
    return message.id;
  }

  async publishPugLeaderboardMessage() {
    if (this.pugLeaderboardRefreshInFlight) return this.pugLeaderboardRefreshInFlight;
    this.pugLeaderboardRefreshInFlight = this.publishPugLeaderboardMessageUnlocked().finally(() => {
      this.pugLeaderboardRefreshInFlight = undefined;
    });
    return this.pugLeaderboardRefreshInFlight;
  }

  private async publishPugLeaderboardMessageUnlocked() {
    const guild = await this.getGuild();
    await assertBotPermissions(guild);
    const channel = await this.ensurePugLeaderboardChannel(guild);
    const settings = await this.store.getAdministratorSettings();
    const pugs = settings.pugs;
    const payload = await this.buildPugLeaderboardMessage(guild);

    if (pugs?.leaderboardMessageId) {
      const existing = await channel.messages.fetch(pugs.leaderboardMessageId).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return existing.id;
      }
    }

    const message = await channel.send(payload);
    await this.store.updatePugSettings({ ...(pugs ?? { mapPool: [] }), leaderboardChannelId: channel.id, leaderboardMessageId: message.id });
    return message.id;
  }

  private schedulePugLeaderboardRefresh(delayMs: number) {
    if (this.pugLeaderboardRefresh) clearTimeout(this.pugLeaderboardRefresh);
    this.pugLeaderboardRefresh = setTimeout(() => {
      this.pugLeaderboardRefresh = undefined;
      this.publishPugLeaderboardMessage()
        .catch((error) => console.warn('Unable to refresh PUG leaderboard message:', error))
        .finally(() => this.schedulePugLeaderboardRefresh(PUG_LEADERBOARD_REFRESH_MS));
    }, delayMs);
  }

  private async ensurePugLeaderboardChannel(guild: Guild): Promise<TextChannel> {
    const channels = await guild.channels.fetch();
    const me = await guild.members.fetchMe();
    const settings = await this.store.getAdministratorSettings();
    const pugs = settings.pugs;

    const category = channels.find((channel) => channel?.type === ChannelType.GuildCategory && channel.name.toLowerCase() === pugCategoryName.toLowerCase())
      ?? await guild.channels.create({ name: pugCategoryName, type: ChannelType.GuildCategory, reason: 'PUG category created for leaderboard channel' });

    const storedChannel = pugs?.leaderboardChannelId ? await guild.channels.fetch(pugs.leaderboardChannelId).catch(() => null) : null;
    if (storedChannel?.type === ChannelType.GuildText) {
      if (storedChannel.parentId !== category.id) {
        await storedChannel.setParent(category.id, { reason: 'PUG leaderboard channel belongs under the Pugs category' }).catch((error) => console.warn('Unable to move PUG leaderboard channel under Pugs category:', error));
      }
      await this.applyPugLeaderboardChannelPermissions(storedChannel, me.id);
      return storedChannel;
    }

    const existing = channels.find((channel) => channel?.type === ChannelType.GuildText && channel.parentId === category.id && channel.name === pugLeaderboardChannelName);
    const channel = existing?.type === ChannelType.GuildText
      ? existing
      : await guild.channels.create({ name: pugLeaderboardChannelName, type: ChannelType.GuildText, parent: category.id, reason: 'PUG leaderboard channel created by 7th Circle Team Hub' });

    await this.applyPugLeaderboardChannelPermissions(channel, me.id);
    await this.store.updatePugSettings({ ...(pugs ?? { mapPool: [] }), leaderboardChannelId: channel.id, leaderboardMessageId: pugs?.leaderboardMessageId });
    return channel;
  }

  private async applyPugLeaderboardChannelPermissions(channel: TextChannel, botUserId: string) {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false
    }, { type: OverwriteType.Role, reason: 'PUG leaderboard is visible to everyone but bot-only for posting' }).catch((error) => console.warn('Unable to update PUG leaderboard @everyone permissions:', error));
    await channel.permissionOverwrites.edit(botUserId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
      ManageMessages: true
    }, { type: OverwriteType.Member, reason: 'PUG leaderboard bot posting permissions' }).catch((error) => console.warn('Unable to update PUG leaderboard bot permissions:', error));
  }

  private async buildPugLeaderboardMessage(guild: Guild) {
    const [leaderboard, allRatings, rankSettings] = await Promise.all([
      this.store.getPugEloLeaderboard(10),
      this.store.getPugEloRatings(),
      this.store.getPugRankSettings()
    ]);
    const [profiles, rankEmojis] = await Promise.all([
      this.getGuildMemberProfiles(leaderboard.map((rating) => rating.userId)),
      this.ensurePugRankEmojis(guild)
    ]);
    const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
    const topMasterUserIds = getTopMasterUserIds(allRatings, rankSettings.masterPlayerCount);
    const updatedAt = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
      .setTitle('PUG ELO Leaderboard')
      .setColor(0xc90820)
      .setDescription(leaderboard.length ? 'Top 10 players by current PUG ELO.' : 'No PUG ELO ratings have been recorded yet.')
      .setFooter({ text: 'Updates automatically every few hours' })
      .setTimestamp(new Date());

    const topProfile = leaderboard[0] ? profilesByUserId.get(leaderboard[0].userId) : undefined;
    if (topProfile?.avatarUrl) embed.setThumbnail(topProfile.avatarUrl);

    embed.addFields(
      leaderboard.map((rating, index) => {
        const profile = profilesByUserId.get(rating.userId);
        const displayName = profile?.displayName ?? rating.username ?? rating.userId;
        const rank = resolvePugRank(rating, rankSettings, topMasterUserIds);
        const rankEmblem = rankEmojis.get(rank.id) ?? rank.abbreviation ?? rank.label;
        const avatar = profile?.avatarUrl ? ` • [Profile picture](${profile.avatarUrl})` : '';
        return {
          name: `#${index + 1} ${rankEmblem} ${displayName}`.slice(0, 256),
          value: `<@${rating.userId}>${avatar}\nRank: **${rank.label}** • ELO: **${formatElo(rating.rating)}**`,
          inline: false
        };
      })
    );
    embed.addFields({ name: 'Last updated', value: `<t:${updatedAt}:R>`, inline: false });

    return { embeds: [embed], allowedMentions: { parse: [] } };
  }

  private buildPugQueueMessage() {
    const embed = new EmbedBuilder()
      .setTitle('PUG Queue')
      .setDescription('Join a pickup-game queue. Once a queue reaches the game-mode size, a 30 second countdown starts. New players can still join during the countdown, and completed lobbies are grouped by similar ELO before matches start.')
      .setColor(0xc90820)
      .addFields(
        pugQueueSizes.map((size) => {
          const queued = this.pugQueues.get(size) ?? [];
          const countdown = this.pugQueueCountdowns.get(size);
          const countdownLabel = countdown
            ? `\nStarting ${Math.floor(queued.length / size)} match${Math.floor(queued.length / size) === 1 ? '' : 'es'} in ${Math.max(0, Math.ceil((countdown.endsAt - Date.now()) / 1000))}s. Extra players can still join.`
            : '';
          return {
            name: pugQueueLabel(size),
            value: queued.length ? `${queued.length}/${size}: ${queued.map((player) => `<@${player.userId}>`).join(', ')}${countdownLabel}` : `0/${size} players queued`,
            inline: false
          };
        })
      );

    const rows = pugQueueSizes.map((size) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`pug:join:${size}`).setLabel(`Join ${pugQueueLabel(size)}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pug:leave:${size}`).setLabel(`Leave ${pugQueueLabel(size)}`).setStyle(ButtonStyle.Secondary)
      )
    );

    return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
  }

  private schedulePugQueueMessageRefresh(delayMs = 0) {
    if (this.pugQueueMessageRefresh) {
      if (delayMs > 0) return;
      clearTimeout(this.pugQueueMessageRefresh);
      this.pugQueueMessageRefresh = undefined;
    }

    if (delayMs <= 0) {
      this.refreshPugQueueMessage().catch((error) => console.warn('Unable to refresh PUG queue message:', error));
      return;
    }

    this.pugQueueMessageRefresh = setTimeout(() => {
      this.pugQueueMessageRefresh = undefined;
      this.refreshPugQueueMessage().catch((error) => console.warn('Unable to refresh PUG queue message:', error));
    }, delayMs);
  }

  private syncPugQueueCountdownRefresh() {
    if (!this.pugQueueCountdowns.size) {
      if (this.pugQueueCountdownRefresh) {
        clearInterval(this.pugQueueCountdownRefresh);
        this.pugQueueCountdownRefresh = undefined;
      }
      return;
    }

    if (this.pugQueueCountdownRefresh) return;
    this.pugQueueCountdownRefresh = setInterval(() => {
      if (!this.pugQueueCountdowns.size) {
        this.syncPugQueueCountdownRefresh();
        return;
      }

      this.refreshPugQueueMessage().catch((error) => console.warn('Unable to refresh PUG queue countdown:', error));
    }, PUG_QUEUE_COUNTDOWN_REFRESH_MS);
  }

  private async refreshPugQueueMessage(message?: import('discord.js').Message) {
    if (this.pugQueueMessageRefreshInFlight) {
      this.pugQueueMessageRefreshAgain = true;
      await this.pugQueueMessageRefreshInFlight;
      return;
    }

    try {
      do {
        this.pugQueueMessageRefreshAgain = false;
        this.pugQueueMessageRefreshInFlight = message ? this.editProvidedPugQueueMessage(message) : this.editPugQueueMessage();
        await this.pugQueueMessageRefreshInFlight;
        message = undefined;
      } while (this.pugQueueMessageRefreshAgain);
    } finally {
      this.pugQueueMessageRefreshInFlight = undefined;
    }
  }

  private async editProvidedPugQueueMessage(message: import('discord.js').Message) {
    await message.edit(this.buildPugQueueMessage()).catch((error) => console.warn('Unable to refresh PUG queue message:', error));
  }

  private async editPugQueueMessage() {
    const settings = await this.store.getAdministratorSettings();
    const pugs = settings.pugs;
    if (!pugs?.queueChannelId || !pugs.queueMessageId) return;
    const guild = await this.getGuild();
    const channel = guild.channels.cache.get(pugs.queueChannelId) ?? (await guild.channels.fetch(pugs.queueChannelId).catch(() => null));
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const message = channel.messages.cache.get(pugs.queueMessageId) ?? (await channel.messages.fetch(pugs.queueMessageId).catch(() => null));
    await message?.edit(this.buildPugQueueMessage()).catch((error) => console.warn('Unable to refresh PUG queue message:', error));
  }

  private async withPugQueueLock<T>(operation: () => Promise<T>) {
    const run = this.pugQueueOperation.catch(() => undefined).then(operation);
    this.pugQueueOperation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async respondToPugInteraction(interaction: import('discord.js').ButtonInteraction, content: string) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  private async handlePugInteraction(interaction: import('discord.js').ButtonInteraction) {
    const [, action, first, second] = interaction.customId.split(':');
    if (action === 'join' || action === 'leave') {
      const size = Number(first) as PugQueueSize;
      if (!pugQueueSizes.includes(size)) throw new Error('Unknown PUG queue size.');
      if (action === 'join') await this.joinPugQueue(interaction, size);
      if (action === 'leave') await this.leavePugQueue(interaction, size);
      return;
    }

    if (action === 'mode') {
      await this.recordPugModeVote(interaction, first, second === 'captains' ? 'captains' : 'random');
      return;
    }

    if (action === 'draft') {
      await this.recordPugDraftPick(interaction, first, second);
      return;
    }

    if (action === 'vote' || action === 'vote2') {
      await this.recordPugVote(interaction, first, Number(second), action === 'vote2');
      return;
    }
  }

  private async joinPugQueue(interaction: import('discord.js').ButtonInteraction, size: PugQueueSize) {
    const guild = interaction.guild?.id === config.DISCORD_GUILD_ID ? interaction.guild : await this.getGuild();
    const member = interaction.member instanceof GuildMember
      ? interaction.member
      : guild.members.cache.get(interaction.user.id) ?? (await guild.members.fetch(interaction.user.id).catch(() => null));
    if (!member || member.user.bot) throw new Error('Only server members can join the PUG queue.');
    const activeBlock = await this.store.getPugActiveAbandonBlock(member.id);
    if (activeBlock?.blockedUntil) {
      throw new Error(`You are temporarily blocked from PUG queues until ${new Date(activeBlock.blockedUntil).toLocaleString('en-US', { timeZone: 'UTC' })} UTC because of a recent abandon.`);
    }

    await this.withPugQueueLock(async () => {
      for (const [queueSize, players] of this.pugQueues) {
        const existingIndex = players.findIndex((player) => player.userId === member.id);
        if (existingIndex >= 0) players.splice(existingIndex, 1);
        if (!players.length) this.pugQueues.delete(queueSize);
      }

      const { channelId } = await this.fetchPugMemberVoiceState(guild, member.id);
      const queue = this.pugQueues.get(size) ?? [];
      queue.push({ userId: member.id, username: member.user.username, voiceChannelId: channelId ?? undefined });
      this.pugQueues.set(size, queue);
      for (const queueSize of pugQueueSizes) this.updatePugQueueCountdown(queueSize);

    });

    await this.refreshPugQueueMessage(interaction.message);
  }

  private async leavePugQueue(interaction: import('discord.js').ButtonInteraction, size: PugQueueSize) {
    await this.withPugQueueLock(async () => {
      const queue = this.pugQueues.get(size) ?? [];
      const filtered = queue.filter((player) => player.userId !== interaction.user.id);
      if (filtered.length) this.pugQueues.set(size, filtered);
      else this.pugQueues.delete(size);
      this.updatePugQueueCountdown(size);
    });
    await this.refreshPugQueueMessage(interaction.message);
  }

  private updatePugQueueCountdown(size: PugQueueSize) {
    const queue = this.pugQueues.get(size) ?? [];
    const countdown = this.pugQueueCountdowns.get(size);
    if (queue.length >= size) {
      if (countdown) return;
      const endsAt = Date.now() + PUG_QUEUE_COUNTDOWN_MS;
      const timer = setTimeout(() => {
        this.finishPugQueueCountdown(size).catch((error) => console.warn(`Unable to finish ${pugQueueLabel(size)} PUG queue countdown:`, error));
      }, PUG_QUEUE_COUNTDOWN_MS);
      this.pugQueueCountdowns.set(size, { endsAt, timer });
      this.syncPugQueueCountdownRefresh();
      this.schedulePugQueueMessageRefresh(0);
      this.schedulePugQueueMessageRefresh(PUG_QUEUE_COUNTDOWN_MS);
      return;
    }

    if (!countdown) return;
    clearTimeout(countdown.timer);
    this.pugQueueCountdowns.delete(size);
    this.syncPugQueueCountdownRefresh();
    this.schedulePugQueueMessageRefresh(0);
  }

  private async finishPugQueueCountdown(size: PugQueueSize) {
    const guild = await this.getGuild();
    const matchesToStart = await this.withPugQueueLock(async () => {
      const countdown = this.pugQueueCountdowns.get(size);
      if (countdown) {
        clearTimeout(countdown.timer);
        this.pugQueueCountdowns.delete(size);
        this.syncPugQueueCountdownRefresh();
      }

      const queue = this.pugQueues.get(size) ?? [];
      const matchCount = Math.floor(queue.length / size);
      if (matchCount <= 0) {
        this.updatePugQueueCountdown(size);
        return [] as PugQueuedPlayer[][];
      }

      const playersForMatches = queue.splice(0, matchCount * size);
      if (queue.length) this.pugQueues.set(size, queue);
      else this.pugQueues.delete(size);
      const balancedMatches = await this.createEloBalancedPugMatches(playersForMatches, size, matchCount);
      this.updatePugQueueCountdown(size);
      return balancedMatches;
    });

    this.schedulePugQueueMessageRefresh(0);
    for (const players of matchesToStart) {
      this.startPugMatch(guild, size, players).catch((error) => console.warn(`Unable to start ${pugQueueLabel(size)} PUG match:`, error));
    }
  }

  private async createEloBalancedPugMatches(players: PugQueuedPlayer[], size: PugQueueSize, matchCount: number) {
    const settings = await this.store.getPugEloSettings();
    const ratings = await this.store.getPugEloRatings();
    const ratingsByUserId = new Map(ratings.map((rating) => [rating.userId, rating.rating]));
    const sortedPlayers = [...players].sort((a, b) => {
      const ratingDifference = (ratingsByUserId.get(b.userId) ?? settings.startingRating) - (ratingsByUserId.get(a.userId) ?? settings.startingRating);
      return ratingDifference || a.username.localeCompare(b.username) || a.userId.localeCompare(b.userId);
    });

    const matches: PugQueuedPlayer[][] = [];
    for (let index = 0; index < matchCount; index += 1) {
      matches.push(sortedPlayers.slice(index * size, (index + 1) * size));
    }
    return matches;
  }

  private async startPugMatch(guild: Guild, size: PugQueueSize, players: PugQueuedPlayer[]) {
    await assertBotPermissions(guild);
    const matchId = randomUUID();
    const playerIds = players.map((player) => player.userId);
    const overwrites = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      ...playerIds.map((userId) => ({ id: userId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }))
    ];

    await this.ensurePugLobbyChannel(guild);
    const matchDisplayId = formatPugMatchId(matchId);
    const category = await guild.channels.create({ name: `pug match ${matchDisplayId}`, type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: 'PUG match category created when queue filled' });
    const [queueVoice, text] = await Promise.all([
      guild.channels.create({ name: 'queue', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: overwrites, reason: 'PUG queue voice channel created when queue filled' }),
      guild.channels.create({ name: 'pug-match', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites, topic: `PUG match ${matchDisplayId} (${matchId})`, reason: 'PUG match text channel created when queue filled' })
    ]);

    const fetchedPlayers = await Promise.all(playerIds.map(async (playerId) => this.fetchPugMemberVoiceState(guild, playerId)));
    const playerUsernames = new Map(playerIds.map((playerId, index) => [playerId, fetchedPlayers[index].member?.user.username ?? players[index].username]));
    const playerRanks = await this.buildPugPlayerRanks(guild, playerIds);
    const now = new Date().toISOString();
    const match: PugMatch = { id: matchId, size, playerIds, playerUsernames, playerRankLabels: playerRanks.labels, playerRankRoleIds: playerRanks.roleIds, categoryId: category.id, queueVoiceChannelId: queueVoice.id, textChannelId: text.id, teamVoiceChannelIds: [], modeVotes: new Map(), votes: new Map(), createdAt: now, updatedAt: now };
    await this.applyPugRankRoles(guild, playerRanks.assignments);
    this.pugMatches.set(matchId, match);
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
    await this.updatePugLobbyChannelName(guild).catch((error) => console.warn('Unable to update PUG lobby in-match count after match start:', error));

    await Promise.all(players.map(async (player, index) => {
      const { member, channelId } = fetchedPlayers[index];
      if (!member) return;
      if (channelId) {
        const moved = await member.voice.setChannel(queueVoice, 'PUG queue filled').then(() => true, (error) => {
          console.warn(`Unable to move PUG player ${player.userId}:`, error);
          return false;
        });
        if (moved) return;
      }
      await member.send({ content: `Your PUG queue is ready in **${guild.name}**. Join ${queueVoice.toString()} so the match can begin.` }).catch((error) => console.warn(`Unable to DM PUG player ${player.userId}:`, error));
    }));

    await text.send({ content: `${playerIds.map((id) => `<@${id}>`).join(' ')} PUG queue is full. Waiting for everyone to join ${queueVoice.toString()} before team selection starts.`, allowedMentions: { users: playerIds } });
    await this.waitForPugPlayersInQueue(guild, match);
    if (!this.pugMatches.has(match.id)) return;
    await this.sendPugModeVotePrompt(text, match, `${match.playerIds.map((id) => `<@${id}>`).join(' ')} everyone is in the queue voice channel. Vote on how teams should be created. A majority vote decides the team selection mode.`);
  }

  private async buildPugPlayerRanks(guild: Guild, playerIds: string[]) {
    const [ratings, rankSettings, rankRoles, rankEmojis] = await Promise.all([this.store.getPugEloRatings(), this.store.getPugRankSettings(), this.ensurePugRankRoles(guild), this.ensurePugRankEmojis(guild)]);
    const topMasterUserIds = getTopMasterUserIds(ratings, rankSettings.masterPlayerCount);
    const ratingsByUserId = new Map(ratings.map((rating) => [rating.userId, rating]));
    const labels = new Map<string, string>();
    const roleIds = new Map<string, string>();
    const assignments = new Map<string, string>();
    await Promise.all(playerIds.map(async (userId) => {
      const rating = ratingsByUserId.get(userId);
      if (!rating) return;
      const rank = resolvePugRank(rating, rankSettings, topMasterUserIds);
      const role = rankRoles.get(rank.id);
      labels.set(userId, formatPugRankDisplay(rank, role, rankEmojis.get(rank.id)));
      if (role) {
        roleIds.set(userId, role.id);
        assignments.set(userId, role.id);
      }
    }));
    return { labels, roleIds, assignments };
  }

  private async waitForPugPlayersInQueue(guild: Guild, match: PugMatch) {
    const firstMissingAt = new Map<string, number>();
    const abandonedMissingPlayerIds = new Set<string>();

    while (this.pugMatches.has(match.id)) {
      const missingPlayerIds: string[] = [];
      for (const userId of match.playerIds) {
        const { channelId } = await this.fetchPugMemberVoiceState(guild, userId);
        if (channelId !== match.queueVoiceChannelId) missingPlayerIds.push(userId);
      }

      if (!missingPlayerIds.length) return;

      const now = Date.now();
      for (const userId of missingPlayerIds) {
        if (abandonedMissingPlayerIds.has(userId)) {
          const replacement = await this.pullPugReplacement(match);
          if (replacement) {
            abandonedMissingPlayerIds.delete(userId);
            await this.replacePugPlayer(guild, match, userId, replacement);
            firstMissingAt.set(replacement.userId, Date.now());
          }
          continue;
        }
        if (!firstMissingAt.has(userId)) firstMissingAt.set(userId, now);
        if (now - (firstMissingAt.get(userId) ?? now) < PUG_ABANDON_GRACE_MS) continue;

        const replacement = await this.pullPugReplacement(match);
        await this.recordPugAbandon(guild, match, userId, replacement);
        firstMissingAt.delete(userId);
        if (replacement) {
          await this.replacePugPlayer(guild, match, userId, replacement);
          firstMissingAt.set(replacement.userId, Date.now());
        } else {
          abandonedMissingPlayerIds.add(userId);
          const channel = await guild.channels.fetch(match.textChannelId).catch(() => null);
          if (channel?.type === ChannelType.GuildText) {
            await channel.send(`<@${userId}> did not join within 2 minutes and has been marked abandoned. Waiting for the next queued player to replace them.`).catch(() => undefined);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  private async pullPugReplacement(match: PugMatch) {
    return this.withPugQueueLock(async () => {
      const queue = this.pugQueues.get(match.size) ?? [];
      while (queue.length) {
        const candidate = queue.shift()!;
        if (!match.playerIds.includes(candidate.userId) && !(await this.store.getPugActiveAbandonBlock(candidate.userId))) {
          if (queue.length) this.pugQueues.set(match.size, queue);
          else this.pugQueues.delete(match.size);
          this.updatePugQueueCountdown(match.size);
          this.schedulePugQueueMessageRefresh(0);
          return candidate;
        }
      }
      this.pugQueues.delete(match.size);
      this.updatePugQueueCountdown(match.size);
      this.schedulePugQueueMessageRefresh(0);
      return undefined;
    });
  }

  private async recordPugAbandon(guild: Guild, match: PugMatch, userId: string, replacement?: PugQueuedPlayer) {
    const settings = await this.store.getPugAbandonSettings();
    const now = new Date();
    const blockedUntil = settings.blockMinutes > 0 ? new Date(now.getTime() + settings.blockMinutes * 60 * 1000).toISOString() : undefined;
    const log: PugAbandonLog = {
      id: randomUUID(),
      matchId: match.id,
      size: match.size,
      userId,
      username: match.playerUsernames.get(userId),
      replacementUserId: replacement?.userId,
      replacementUsername: replacement?.username,
      eloPenalty: settings.eloPenalty,
      blockedUntil,
      createdAt: now.toISOString()
    };
    await this.store.recordPugAbandon(log);
    await this.syncPugRankRolesForUsers([userId]).catch((error) => console.warn('Unable to sync PUG rank role after abandon:', error));
    const channel = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      const penaltyText = settings.eloPenalty > 0 ? ` They received a ${settings.eloPenalty} ELO abandon penalty.` : '';
      const blockText = blockedUntil ? ` They are blocked from queues until ${new Date(blockedUntil).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.` : '';
      await channel.send(`<@${userId}> did not join the queue voice channel in time and has been marked abandoned.${penaltyText}${blockText}`).catch(() => undefined);
    }
  }

  private async replacePugPlayer(guild: Guild, match: PugMatch, abandonedUserId: string, replacement: PugQueuedPlayer) {
    const index = match.playerIds.indexOf(abandonedUserId);
    if (index < 0) return;
    match.playerIds[index] = replacement.userId;
    match.playerUsernames.delete(abandonedUserId);
    match.playerUsernames.set(replacement.userId, replacement.username);
    match.playerRankLabels.delete(abandonedUserId);
    match.playerRankRoleIds.delete(abandonedUserId);
    const playerRanks = await this.buildPugPlayerRanks(guild, [replacement.userId]);
    const replacementRank = playerRanks.labels.get(replacement.userId);
    const replacementRoleId = playerRanks.roleIds.get(replacement.userId);
    if (replacementRank) match.playerRankLabels.set(replacement.userId, replacementRank);
    if (replacementRoleId) match.playerRankRoleIds.set(replacement.userId, replacementRoleId);
    await this.applyPugRankRoles(guild, playerRanks.assignments);
    match.modeVotes.delete(abandonedUserId);
    match.votes.delete(abandonedUserId);
    match.updatedAt = new Date().toISOString();

    await Promise.all([match.categoryId, match.queueVoiceChannelId, match.textChannelId].map(async (channelId) => {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !('permissionOverwrites' in channel)) return;
      await channel.permissionOverwrites.delete(abandonedUserId, 'PUG abandoned before joining').catch(() => undefined);
      await channel.permissionOverwrites.edit(replacement.userId, { ViewChannel: true, Connect: true, Speak: true, SendMessages: true, ReadMessageHistory: true }, { type: OverwriteType.Member, reason: 'PUG replacement added' }).catch(() => undefined);
    }));

    const { member, channelId } = await this.fetchPugMemberVoiceState(guild, replacement.userId);
    const queueVoice = await guild.channels.fetch(match.queueVoiceChannelId).catch(() => null);
    if (member && queueVoice?.type === ChannelType.GuildVoice) {
      const moved = channelId ? await member.voice.setChannel(queueVoice, 'PUG replacement added').then(() => true, () => false) : false;
      if (!moved) await member.send({ content: `You are replacing a player who did not join in time for a PUG match in **${guild.name}**. Join ${queueVoice.toString()} now.` }).catch(() => undefined);
    }
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (text?.type === ChannelType.GuildText) {
      await text.send({ content: `<@${replacement.userId}> you are replacing a player who did not join in time. Please join ${queueVoice?.toString() ?? 'the queue voice channel'} now.`, allowedMentions: { users: [replacement.userId] } }).catch(() => undefined);
      await this.refreshPugModeVoteMessage(match);
    }
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  private async recordPugModeVote(interaction: import('discord.js').ButtonInteraction, matchId: string, mode: PugTeamMode) {
    const match = this.pugMatches.get(matchId);
    if (!match) throw new Error('This PUG match is no longer active.');
    if (!match.playerIds.includes(interaction.user.id)) throw new Error('Only queued players can vote on the team mode.');
    if (match.selectedMode) throw new Error('The team mode has already been selected.');

    const previous = match.modeVotes.get(interaction.user.id);
    if (previous === mode) {
      match.modeVotes.delete(interaction.user.id);
      await this.respondToPugInteraction(interaction, 'Team mode vote canceled.');
    } else {
      match.modeVotes.set(interaction.user.id, mode);
      await this.respondToPugInteraction(interaction, 'Team mode vote recorded.');
    }
    await this.refreshPugModeVoteMessage(match);

    const selectedMode = majorityModeVote(match);
    if (!selectedMode) return;
    await this.choosePugMode(match, selectedMode);
  }

  private async refreshPugModeVoteMessage(match: PugMatch) {
    if (!match.modeVoteMessageId) return;
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) return;
    const message = await text.messages.fetch(match.modeVoteMessageId).catch(() => null);
    await message?.edit({ embeds: [buildPugModeVoteEmbed(match)] }).catch((error) => console.warn('Unable to refresh PUG mode vote message:', error));
  }

  private async choosePugMode(match: PugMatch, mode: PugTeamMode) {
    if (match.selectedMode) return;
    match.selectedMode = mode;
    match.updatedAt = new Date().toISOString();
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));

    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) throw new Error('PUG text channel no longer exists.');

    this.stopPugModeVoteReposter(match);
    if (match.modeVoteMessageId) {
      const message = await text.messages.fetch(match.modeVoteMessageId).catch(() => null);
      await message?.edit({ embeds: [buildPugModeVoteEmbed(match)], components: [] }).catch((error) => console.warn('Unable to finalize PUG mode vote message:', error));
    }

    if (mode === 'captains') {
      await this.startPugCaptainDraft(text, match);
      return;
    }

    const teams = createRandomTeams(match.playerIds, match.size);
    await this.finalizePugTeams(guild, text, match, teams, 'Random teams won the majority vote and teams have been created.');
  }

  private async startPugCaptainDraft(text: import('discord.js').TextChannel, match: PugMatch) {
    const captainIds = shuffle(match.playerIds).slice(0, getPugTeamCount(match.size));
    const captainSet = new Set(captainIds);
    const teams = captainIds.map((captainId) => [captainId]);
    match.captainDraft = {
      captainIds,
      teams,
      availablePlayerIds: match.playerIds.filter((playerId) => !captainSet.has(playerId)),
      currentCaptainIndex: 0,
      picksThisTurn: 0
    };

    const message = await text.send({
      content: `${captainIds.map((id) => `<@${id}>`).join(' ')} Captains won the majority vote. Captains will now draft one player per turn in order.`,
      embeds: [buildPugCaptainDraftEmbed(match)],
      components: buildPugCaptainDraftRows(match),
      allowedMentions: { users: captainIds }
    });
    match.captainDraft.messageId = message.id;
    match.updatedAt = new Date().toISOString();
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  private async recordPugDraftPick(interaction: import('discord.js').ButtonInteraction, matchId: string, playerId: string) {
    const match = this.pugMatches.get(matchId);
    if (!match?.captainDraft) throw new Error('This captain draft is no longer active.');
    const draft = match.captainDraft;
    const currentCaptainId = draft.captainIds[draft.currentCaptainIndex];
    if (interaction.user.id !== currentCaptainId) throw new Error(`It is <@${currentCaptainId}>'s turn to pick.`);
    if (!draft.availablePlayerIds.includes(playerId)) throw new Error('That player is no longer available to pick.');

    draft.teams[draft.currentCaptainIndex].push(playerId);
    draft.availablePlayerIds = draft.availablePlayerIds.filter((availableId) => availableId !== playerId);
    draft.picksThisTurn += 1;

    if (draft.availablePlayerIds.length && draft.picksThisTurn >= getPugCaptainPicksPerTurn(match.size)) {
      draft.currentCaptainIndex = (draft.currentCaptainIndex + 1) % draft.captainIds.length;
      draft.picksThisTurn = 0;
    }

    await this.respondToPugInteraction(interaction, `You picked <@${playerId}>.`);

    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) return;

    if (draft.availablePlayerIds.length) {
      await this.refreshPugCaptainDraftMessage(text, match);
      match.updatedAt = new Date().toISOString();
      await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
      return;
    }

    await this.refreshPugCaptainDraftMessage(text, match, true);
    await this.finalizePugTeams(guild, text, match, draft.teams, 'Captains drafted their teams.');
  }

  private async refreshPugCaptainDraftMessage(text: import('discord.js').TextChannel, match: PugMatch, completed = false) {
    const draft = match.captainDraft;
    if (!draft?.messageId) return;
    const message = await text.messages.fetch(draft.messageId).catch(() => null);
    await message?.edit({
      embeds: [buildPugCaptainDraftEmbed(match)],
      components: completed ? [] : buildPugCaptainDraftRows(match)
    }).catch((error) => console.warn('Unable to refresh PUG captain draft message:', error));
  }

  private async finalizePugTeams(guild: Guild, text: import('discord.js').TextChannel, match: PugMatch, teams: string[][], description: string, options: { reuseTeamVoiceChannels?: boolean; preserveMap?: boolean } = {}) {
    const map = options.preserveMap && match.map ? match.map : await this.pickPugMap(match.map);
    match.teams = teams.map((team) => [...team]);
    match.map = map;
    match.updatedAt = new Date().toISOString();
    await this.createPugTeamVoiceChannels(guild, match, teams, { reuseExisting: options.reuseTeamVoiceChannels });
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));

    await text.send({
      embeds: [new EmbedBuilder().setTitle('PUG Teams').setColor(0xc90820).setDescription(`${description}${map ? `\n\n**Map:** ${map}` : ''}`).addFields(teams.map((team, index) => ({ name: `Team ${index + 1}`, value: team.map((id, playerIndex) => `${playerIndex === 0 && match.selectedMode === 'captains' ? '⭐ ' : ''}${formatPugPlayerLabel(match, id)}`).join('\n') || 'No players', inline: true })))],
      allowedMentions: { users: match.playerIds }
    });
    await this.sendPugVotePrompt(text, match, teams.length);
  }

  private async createPugTeamVoiceChannels(guild: Guild, match: PugMatch, teams: string[][], options: { reuseExisting?: boolean } = {}) {
    const channels = await Promise.all(
      teams.map(async (_, index) => {
        const existingChannelId = options.reuseExisting ? match.teamVoiceChannelIds[index] : undefined;
        const existingChannel = existingChannelId ? await guild.channels.fetch(existingChannelId).catch(() => null) : null;
        if (existingChannel?.type === ChannelType.GuildVoice) return existingChannel;
        return guild.channels.create({ name: `Team ${index + 1}`, type: ChannelType.GuildVoice, parent: match.categoryId, reason: 'PUG team voice channel created' });
      })
    );
    match.teamVoiceChannelIds = channels.map((channel) => channel.id);

    await Promise.all(teams.flatMap((team, index) =>
      team.map(async (userId) => {
        const { member, channelId } = await this.fetchPugMemberVoiceState(guild, userId);
        if (member && channelId) await member.voice.setChannel(channels[index], 'PUG teams assigned').catch(() => undefined);
      })
    ));
  }

  private async pickPugMap(currentMap?: string) {
    const previousPick = this.pugMapPickOperation;
    let releasePickLock!: () => void;
    this.pugMapPickOperation = new Promise((resolve) => {
      releasePickLock = resolve;
    });

    await previousPick;
    try {
      const settings = await this.store.getAdministratorSettings();
      const maps = settings.pugs?.mapPool.map((map) => map.trim()).filter(Boolean) ?? [];
      if (!maps.length) return undefined;

      const previousMap = this.lastPickedPugMap ?? await this.getMostRecentPugMap() ?? currentMap;
      const eligibleMaps = previousMap && maps.some((map) => map !== previousMap) ? maps.filter((map) => map !== previousMap) : maps;
      const map = eligibleMaps[randomIndex(eligibleMaps.length)];
      this.lastPickedPugMap = map;
      return map;
    } finally {
      releasePickLock();
    }
  }

  private async getMostRecentPugMap() {
    const logs = await this.store.getPugMatchLogs();
    return logs.find((log) => log.map)?.map;
  }

  private async sendPugVotePrompt(text: import('discord.js').TextChannel, match: PugMatch, teamCount: number) {
    match.voteMode = teamCount === 2 ? 'winner' : 'placements';
    match.voteStartedAt = new Date().toISOString();
    const rows = buildPugVoteRows(match.id, teamCount, match.voteMode);
    const message = await text.send({ content: match.voteMode === 'winner' ? 'Vote for the winning team. A majority vote ends the match.' : 'Vote for the winner and second place. Separate majorities for winner and second place end the match.', embeds: [buildPugResultVoteEmbed(match, teamCount)], components: rows });
    match.voteMessageId = message.id;
    match.updatedAt = new Date().toISOString();
    this.startPugResultVoteReposter(match);
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  private async recordPugVote(interaction: import('discord.js').ButtonInteraction, matchId: string, teamIndex: number, secondPlace: boolean) {
    const match = this.pugMatches.get(matchId);
    if (!match) throw new Error('This PUG match is no longer active.');
    if (!match.playerIds.includes(interaction.user.id)) throw new Error('Only queued players can vote on this PUG match.');
    if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= getPugTeamCount(match.size)) throw new Error('Unknown team vote.');

    const previous = match.votes.get(interaction.user.id) ?? '';
    const parts = previous.split(',');
    parts[0] ??= '';
    parts[1] ??= '';
    let response = 'Vote recorded.';
    if (match.voteMode === 'winner') {
      if (previous === String(teamIndex)) {
        match.votes.delete(interaction.user.id);
        response = 'Vote canceled.';
      } else {
        match.votes.set(interaction.user.id, String(teamIndex));
      }
    } else {
      const partIndex = secondPlace ? 1 : 0;
      const otherIndex = secondPlace ? 0 : 1;
      if (parts[partIndex] === String(teamIndex)) {
        parts[partIndex] = '';
        response = 'Vote option canceled.';
      } else {
        parts[partIndex] = String(teamIndex);
        if (parts[otherIndex] === String(teamIndex)) parts[otherIndex] = '';
      }
      const nextVote = parts.join(',');
      if (nextVote === ',' || !nextVote) match.votes.delete(interaction.user.id);
      else match.votes.set(interaction.user.id, nextVote);
    }

    await this.respondToPugInteraction(interaction, response);
    match.updatedAt = new Date().toISOString();
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
    await this.refreshPugResultVoteMessage(match);
    const winningVote = majorityVote(match);
    if (!winningVote) return;
    await this.endPugMatch(match, winningVote);
  }

  private async refreshPugResultVoteMessage(match: PugMatch) {
    if (!match.voteMessageId || !match.voteMode) return;
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) return;
    const message = await text.messages.fetch(match.voteMessageId).catch(() => null);
    await message?.edit({ embeds: [buildPugResultVoteEmbed(match, getPugTeamCount(match.size))] }).catch((error) => console.warn('Unable to refresh PUG result vote message:', error));
  }

  private startPugModeVoteReposter(match: PugMatch) {
    this.stopPugModeVoteReposter(match);
    match.modeVoteRefreshTimer = setInterval(() => {
      this.repostPugModeVoteMessage(match).catch((error) => console.warn('Unable to repost PUG mode vote message:', error));
    }, PUG_VOTE_REPOST_MS);
  }

  private stopPugModeVoteReposter(match: PugMatch) {
    if (!match.modeVoteRefreshTimer) return;
    clearInterval(match.modeVoteRefreshTimer);
    match.modeVoteRefreshTimer = undefined;
  }

  private async repostPugModeVoteMessage(match: PugMatch) {
    if (match.selectedMode || !this.pugMatches.has(match.id)) return;
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) return;
    const oldMessage = match.modeVoteMessageId ? await text.messages.fetch(match.modeVoteMessageId).catch(() => null) : null;
    if (oldMessage && !(await this.hasNewerNonBotMessage(text, oldMessage.id))) return;
    await oldMessage?.delete().catch(() => undefined);
    const modeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pug:mode:${match.id}:random`).setLabel('Random teams').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pug:mode:${match.id}:captains`).setLabel('Captains').setStyle(ButtonStyle.Primary)
    );
    const message = await text.send({ content: `${match.playerIds.map((id) => `<@${id}>`).join(' ')} vote on how teams should be created.`, embeds: [buildPugModeVoteEmbed(match)], components: [modeRow], allowedMentions: { users: match.playerIds } });
    match.modeVoteMessageId = message.id;
    match.updatedAt = new Date().toISOString();
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  private startPugResultVoteReposter(match: PugMatch, deadMatchDelay = PUG_DEAD_MATCH_MS) {
    this.stopPugResultVoteReposter(match);
    match.voteRefreshTimer = setInterval(() => {
      this.repostPugResultVoteMessage(match).catch((error) => console.warn('Unable to repost PUG result vote message:', error));
    }, PUG_VOTE_REPOST_MS);
    match.deadMatchTimer = setTimeout(() => {
      this.cancelDeadPugMatch(match).catch((error) => console.warn('Unable to cancel dead PUG match:', error));
    }, deadMatchDelay);
  }

  private stopPugResultVoteReposter(match: PugMatch) {
    if (match.voteRefreshTimer) clearInterval(match.voteRefreshTimer);
    if (match.deadMatchTimer) clearTimeout(match.deadMatchTimer);
    match.voteRefreshTimer = undefined;
    match.deadMatchTimer = undefined;
  }

  private stopPugVoteTimers(match: PugMatch) {
    this.stopPugModeVoteReposter(match);
    this.stopPugResultVoteReposter(match);
  }

  private async repostPugResultVoteMessage(match: PugMatch) {
    if (!match.voteMode || !this.pugMatches.has(match.id)) return;
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) return;
    const oldMessage = match.voteMessageId ? await text.messages.fetch(match.voteMessageId).catch(() => null) : null;
    if (oldMessage && !(await this.hasNewerNonBotMessage(text, oldMessage.id))) return;
    await oldMessage?.delete().catch(() => undefined);
    const message = await text.send({ content: match.voteMode === 'winner' ? 'Vote for the winning team. A majority vote ends the match.' : 'Vote for the winner and second place. Separate majorities for winner and second place end the match.', embeds: [buildPugResultVoteEmbed(match, getPugTeamCount(match.size))], components: buildPugVoteRows(match.id, getPugTeamCount(match.size), match.voteMode) });
    match.voteMessageId = message.id;
    match.updatedAt = new Date().toISOString();
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }


  private async hasNewerNonBotMessage(text: import('discord.js').TextChannel, messageId: string) {
    const botUserId = this.client.user?.id;
    const newerMessages = await text.messages.fetch({ after: messageId, limit: 100 }).catch((error) => {
      console.warn('Unable to check for newer PUG vote messages:', error);
      return null;
    });
    if (!newerMessages) return false;
    return newerMessages.some((message) => message.author.id !== botUserId);
  }

  private async cancelDeadPugMatch(match: PugMatch) {
    if (!this.pugMatches.has(match.id)) return;
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (text?.type === ChannelType.GuildText) {
      await text.send('This PUG match has been open for more than 60 minutes without a completed vote. Canceling it as dead with no ELO changes or penalties.').catch(() => undefined);
    }
    this.stopPugVoteTimers(match);
    const endedAt = new Date().toISOString();
    match.updatedAt = endedAt;
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match, { status: 'deleted', result: 'Canceled as dead match with no ELO changes', endedAt }));
    this.pugMatches.delete(match.id);
    await this.updatePugLobbyChannelName(guild).catch((error) => console.warn('Unable to update PUG lobby in-match count after dead match cancellation:', error));
    await this.cleanupPugMatchChannels(match, 'PUG match canceled after 60 minutes without a result vote');
  }

  private async endPugMatch(match: PugMatch, result: string) {
    const existing = this.pugMatchEndLocks.get(match.id);
    if (existing) {
      await existing;
      return;
    }

    const operation = this.finishPugMatch(match, result).finally(() => {
      this.pugMatchEndLocks.delete(match.id);
    });
    this.pugMatchEndLocks.set(match.id, operation);
    await operation;
  }

  private async finishPugMatch(match: PugMatch, result: string) {
    if (!this.pugMatches.has(match.id)) return;
    this.stopPugVoteTimers(match);

    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    const eloResult = await this.applyPugEloResult(match, result);
    match.eloChanges = eloResult.changes;
    match.teamEloTotals = eloResult.teamTotals;
    if (text?.type === ChannelType.GuildText) {
      await this.refreshPugResultVoteMessage(match);
      await text.send(`PUG match ended. Result: ${result}. ${formatPugEloSummary(eloResult.changes)} Cleaning up channels now.`).catch(() => undefined);
    }
    const endedAt = new Date().toISOString();
    match.updatedAt = endedAt;
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match, { status: 'completed', result, endedAt, eloChanges: match.eloChanges, teamEloTotals: match.teamEloTotals }));
    this.pugMatches.delete(match.id);
    await this.updatePugLobbyChannelName(guild).catch((error) => console.warn('Unable to update PUG lobby in-match count after match end:', error));

    await this.sendPugEloResultDms(guild, match, result, eloResult);
    await this.movePugVoiceChannelMembersToLobby(guild, match, 'PUG match ended').catch((error) => console.warn('Unable to move PUG players back to lobby after match end:', error));

    for (const channelId of [...match.teamVoiceChannelIds, match.queueVoiceChannelId, match.textChannelId, match.categoryId]) {
      await guild.channels.delete(channelId, 'PUG match ended').catch(() => undefined);
    }
  }


  private async applyPugEloResult(match: PugMatch, result: string): Promise<PugEloResult> {
    if (match.eloChanges) {
      return { changes: match.eloChanges, teamTotals: match.teamEloTotals ?? [], rankTransitions: await this.buildPugRankTransitions(match.eloChanges) };
    }
    if (!match.teams?.length) throw new Error('PUG teams were not available for ELO calculation.');
    const [settings, allRatings] = await Promise.all([this.store.getPugEloSettings(), this.store.getPugEloRatings()]);
    const ratings = new Map(allRatings.map((rating) => [rating.userId, rating]));
    for (const userId of match.playerIds) {
      if (!ratings.has(userId)) ratings.set(userId, { userId, username: match.playerUsernames.get(userId), rating: settings.startingRating, updatedAt: new Date().toISOString() });
    }

    const placements = parsePugResultPlacements(result, match.teams.length);
    const teamTotals = match.teams.map((team) => team.reduce((sum, userId) => sum + (ratings.get(userId)?.rating ?? settings.startingRating), 0));
    const changes = calculatePugEloChanges(match.teams, placements, ratings, match.playerUsernames, settings, match.size);
    const rankTransitions = await this.buildPugRankTransitions(changes, [...ratings.values()]);
    await this.store.applyPugEloChanges(changes);
    await this.syncPugRankRolesForUsers(match.playerIds).catch((error) => console.warn('Unable to sync PUG rank roles after ELO changes:', error));
    return { changes, teamTotals, rankTransitions };
  }

  private async buildPugRankTransitions(changes: PugEloChange[], baseRatings?: PugEloRating[]) {
    const [ratings, rankSettings] = await Promise.all([baseRatings ? Promise.resolve(baseRatings) : this.store.getPugEloRatings(), this.store.getPugRankSettings()]);
    const beforeRatings = new Map(ratings.map((rating) => [rating.userId, { ...rating }]));
    const afterRatings = new Map(ratings.map((rating) => [rating.userId, { ...rating }]));
    for (const change of changes) {
      const username = change.username ?? beforeRatings.get(change.userId)?.username ?? afterRatings.get(change.userId)?.username;
      beforeRatings.set(change.userId, { ...beforeRatings.get(change.userId), userId: change.userId, username, rating: change.before, updatedAt: beforeRatings.get(change.userId)?.updatedAt ?? new Date().toISOString() });
      afterRatings.set(change.userId, { ...afterRatings.get(change.userId), userId: change.userId, username, rating: change.after, updatedAt: afterRatings.get(change.userId)?.updatedAt ?? new Date().toISOString() });
    }

    const beforeTopMasterUserIds = getTopMasterUserIds(sortPugRatingsForRankResolution([...beforeRatings.values()]), rankSettings.masterPlayerCount);
    const afterTopMasterUserIds = getTopMasterUserIds(sortPugRatingsForRankResolution([...afterRatings.values()]), rankSettings.masterPlayerCount);
    const transitions = new Map<string, PugRankTransition>();
    for (const change of changes) {
      transitions.set(change.userId, {
        before: resolvePugRank(beforeRatings.get(change.userId)!, rankSettings, beforeTopMasterUserIds),
        after: resolvePugRank(afterRatings.get(change.userId)!, rankSettings, afterTopMasterUserIds)
      });
    }
    return transitions;
  }

  private async sendPugEloResultDms(guild: Guild, match: PugMatch, result: string, eloResult: PugEloResult) {
    await Promise.all(eloResult.changes.map(async (change) => {
      const member = guild.members.cache.get(change.userId) ?? await guild.members.fetch(change.userId).catch(() => null);
      if (!member) return;
      const rankTransition = eloResult.rankTransitions.get(change.userId);
      const content = [
        `Your PUG match in **${guild.name}** has ended.`,
        `Result: ${result}${match.map ? ` on ${match.map}` : ''}.`,
        `You ${change.delta >= 0 ? 'gained' : 'lost'} **${formatElo(Math.abs(change.delta))} ELO** (${formatElo(change.before)} → ${formatElo(change.after)}).`,
        formatPugRankTransition(rankTransition)
      ].filter(Boolean).join('\n');
      await member.send({ content }).catch((error) => console.warn(`Unable to DM PUG ELO result to ${change.userId}:`, error));
    }));
  }

  async getPugAdminState() {
    const logs = await this.store.getPugMatchLogs();
    const activeIds = new Set(this.pugMatches.keys());
    return {
      activeMatches: [...this.pugMatches.values()].map((match) => this.toPugMatchLog(match)),
      history: logs.map((log) => activeIds.has(log.id) ? { ...log, status: 'ongoing' as const } : log)
    };
  }

  async deletePugMatch(matchId: string) {
    const match = this.pugMatches.get(matchId);
    if (match) {
      this.stopPugVoteTimers(match);
      const endedAt = new Date().toISOString();
      match.updatedAt = endedAt;
      await this.store.upsertPugMatchLog(this.toPugMatchLog(match, { status: 'deleted', result: 'Deleted by administrator', endedAt }));
      this.pugMatches.delete(matchId);
      await this.updatePugLobbyChannelName(await this.getGuild()).catch((error) => console.warn('Unable to update PUG lobby in-match count after match deletion:', error));
      await this.cleanupPugMatchChannels(match, 'PUG match deleted by administrator');
      return;
    }
    await this.store.removePugMatchLog(matchId);
  }

  async rollbackPugMatch(matchId: string) {
    if (this.pugMatches.has(matchId)) throw new Error('Only completed PUG matches can be rolled back.');
    await this.store.rollbackPugMatch(matchId);
  }

  async resetPugMatch(matchId: string) {
    const match = this.pugMatches.get(matchId);
    if (!match) throw new Error('PUG match is not currently active.');
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) throw new Error('PUG match text channel is not available.');

    this.stopPugVoteTimers(match);
    await this.deletePugTeamVoiceChannels(guild, match, 'PUG match reset by administrator');
    match.modeVotes.clear();
    match.selectedMode = undefined;
    match.captainDraft = undefined;
    match.teams = undefined;
    match.map = undefined;
    match.voteMode = undefined;
    match.voteMessageId = undefined;
    match.voteStartedAt = undefined;
    match.eloChanges = undefined;
    match.teamEloTotals = undefined;
    match.votes.clear();
    match.updatedAt = new Date().toISOString();

    const modeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pug:mode:${matchId}:random`).setLabel('Random teams').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pug:mode:${matchId}:captains`).setLabel('Captains').setStyle(ButtonStyle.Primary)
    );
    const message = await text.send({ content: 'This PUG match was reset by an administrator. Vote again on how teams should be created.', embeds: [buildPugModeVoteEmbed(match)], components: [modeRow], allowedMentions: { users: match.playerIds } });
    match.modeVoteMessageId = message.id;
    this.startPugModeVoteReposter(match);
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  async forcePugTeams(matchId: string, teams: string[][]) {
    const match = this.pugMatches.get(matchId);
    if (!match) throw new Error('PUG match is not currently active.');
    this.assertPugTeams(match, teams);
    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) throw new Error('PUG match text channel is not available.');

    this.stopPugResultVoteReposter(match);
    match.selectedMode = 'random';
    match.captainDraft = undefined;
    match.votes.clear();
    await this.finalizePugTeams(guild, text, match, teams, 'An administrator changed the PUG teams.', { reuseTeamVoiceChannels: true, preserveMap: true });
  }

  async forcePugCaptains(matchId: string, captainIds: string[]) {
    const match = this.pugMatches.get(matchId);
    if (!match) throw new Error('PUG match is not currently active.');
    const teamCount = getPugTeamCount(match.size);
    const uniqueCaptainIds = [...new Set(captainIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueCaptainIds.length !== teamCount) throw new Error(`Select exactly ${teamCount} captains for this PUG size.`);
    const playerSet = new Set(match.playerIds);
    if (uniqueCaptainIds.some((id) => !playerSet.has(id))) throw new Error('Captains must be players in the selected PUG match.');

    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) throw new Error('PUG match text channel is not available.');

    this.stopPugResultVoteReposter(match);
    await this.deletePugTeamVoiceChannels(guild, match, 'PUG captains changed by administrator');
    match.selectedMode = 'captains';
    match.teams = undefined;
    match.map = undefined;
    match.voteMode = undefined;
    match.voteMessageId = undefined;
    match.voteStartedAt = undefined;
    match.eloChanges = undefined;
    match.teamEloTotals = undefined;
    match.votes.clear();
    const captainSet = new Set(uniqueCaptainIds);
    match.captainDraft = {
      captainIds: uniqueCaptainIds,
      teams: uniqueCaptainIds.map((captainId) => [captainId]),
      availablePlayerIds: match.playerIds.filter((playerId) => !captainSet.has(playerId)),
      currentCaptainIndex: 0,
      picksThisTurn: 0
    };
    const message = await text.send({
      content: `${uniqueCaptainIds.map((id) => `<@${id}>`).join(' ')} An administrator changed the captains. Captains will now draft players.`,
      embeds: [buildPugCaptainDraftEmbed(match)],
      components: buildPugCaptainDraftRows(match),
      allowedMentions: { users: uniqueCaptainIds }
    });
    match.captainDraft.messageId = message.id;
    match.updatedAt = new Date().toISOString();
    await this.store.upsertPugMatchLog(this.toPugMatchLog(match));
  }

  private toPugMatchLog(match: PugMatch, overrides: Partial<PugMatchLog> = {}): PugMatchLog {
    const draft = match.captainDraft;
    const teams = match.teams ?? draft?.teams ?? [];
    const captainIds = draft?.captainIds ?? (match.selectedMode === 'captains' ? teams.map((team) => team[0]).filter(Boolean) : []);
    return {
      id: match.id,
      size: match.size,
      playerIds: [...match.playerIds],
      playerUsernames: Object.fromEntries(match.playerUsernames),
      categoryId: match.categoryId,
      queueVoiceChannelId: match.queueVoiceChannelId,
      textChannelId: match.textChannelId,
      teamVoiceChannelIds: [...match.teamVoiceChannelIds],
      playerRankLabels: Object.fromEntries(match.playerRankLabels),
      playerRankRoleIds: Object.fromEntries(match.playerRankRoleIds),
      modeVotes: Object.fromEntries(match.modeVotes),
      modeVoteMessageId: match.modeVoteMessageId,
      captainDraft: draft ? { ...draft, captainIds: [...draft.captainIds], teams: draft.teams.map((team) => [...team]), availablePlayerIds: [...draft.availablePlayerIds] } : undefined,
      voteMessageId: match.voteMessageId,
      voteStartedAt: match.voteStartedAt,
      teams: teams.map((team) => [...team]),
      captainIds,
      mode: match.selectedMode,
      map: match.map,
      voteMode: match.voteMode,
      votes: Object.fromEntries(match.votes),
      status: 'ongoing',
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
      ...overrides
    };
  }

  private async cleanupPugMatchChannels(match: PugMatch, reason: string) {
    const guild = await this.getGuild();
    await this.movePugVoiceChannelMembersToLobby(guild, match, reason);
    await this.deletePugTeamVoiceChannels(guild, match, reason);
    for (const channelId of [match.queueVoiceChannelId, match.textChannelId, match.categoryId]) {
      await guild.channels.delete(channelId, reason).catch(() => undefined);
    }
  }

  private async movePugVoiceChannelMembersToLobby(guild: Guild, match: PugMatch, reason: string) {
    const previousReturn = this.pugLobbyReturnOperation;
    let releaseReturnLock!: () => void;
    this.pugLobbyReturnOperation = new Promise((resolve) => {
      releaseReturnLock = resolve;
    });

    await previousReturn;
    try {
      const lobby = await this.selectPugReturnLobby(guild);
      const voiceChannelIds = [match.queueVoiceChannelId, ...match.teamVoiceChannelIds];
      await Promise.all(voiceChannelIds.map(async (channelId) => {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildVoice) return;
        await Promise.all(channel.members.map((member) => member.voice.setChannel(lobby, reason).catch(() => undefined)));
      }));
    } finally {
      releaseReturnLock();
    }
  }

  private async deletePugTeamVoiceChannels(guild: Guild, match: PugMatch, reason: string) {
    await Promise.all(match.teamVoiceChannelIds.map((channelId) => guild.channels.delete(channelId, reason).catch(() => undefined)));
    match.teamVoiceChannelIds = [];
  }

  private assertPugTeams(match: PugMatch, teams: string[][]) {
    const teamCount = getPugTeamCount(match.size);
    if (teams.length !== teamCount) throw new Error(`Provide exactly ${teamCount} teams for this PUG size.`);
    const playerSet = new Set(match.playerIds);
    const seen = new Set<string>();
    for (const team of teams) {
      if (!team.length) throw new Error('Each PUG team must include at least one player.');
      for (const playerId of team) {
        if (!playerSet.has(playerId)) throw new Error(`Player ${playerId} is not in this PUG match.`);
        if (seen.has(playerId)) throw new Error(`Player ${playerId} appears more than once.`);
        seen.add(playerId);
      }
    }
    if (seen.size !== match.playerIds.length) throw new Error('Forced teams must include every player in the PUG match exactly once.');
  }

  private async selectPugReturnLobby(guild: Guild) {
    return this.ensurePugLobbyChannel(guild);
  }

  private async ensurePugLobbyChannel(guild: Guild) {
    if (this.pugLobbyEnsureOperation) return this.pugLobbyEnsureOperation;
    this.pugLobbyEnsureOperation = this.ensurePugLobbyChannelUnlocked(guild).finally(() => {
      this.pugLobbyEnsureOperation = undefined;
    });
    return this.pugLobbyEnsureOperation;
  }

  private async ensurePugLobbyChannelUnlocked(guild: Guild) {
    const channels = await guild.channels.fetch();
    const existingVoiceChannels = channels.filter((channel): channel is VoiceChannel => channel?.type === ChannelType.GuildVoice);
    const existingLobby = existingVoiceChannels.find((channel) => pugLobbyChannelNamePattern.test(channel.name));
    if (existingLobby) return this.renamePugLobbyChannel(existingLobby, 'Persistent PUG lobby in-match count updated');

    const splitLobby = existingVoiceChannels.find((channel) => channel.name === 'PUG Lobby 1') ?? existingVoiceChannels.find((channel) => channel.name === 'PUG Lobby 2');
    if (splitLobby) return this.renamePugLobbyChannel(splitLobby, 'Persistent PUG lobby reverted to a single voice channel');

    return guild.channels.create({ name: this.formatPugLobbyChannelName(), type: ChannelType.GuildVoice, reason: 'Persistent PUG lobby channel created by queue system' });
  }

  private async updatePugLobbyChannelName(guild: Guild) {
    const lobby = await this.ensurePugLobbyChannel(guild);
    await this.renamePugLobbyChannel(lobby, 'PUG lobby in-match count updated');
  }

  private async renamePugLobbyChannel(channel: VoiceChannel, reason: string) {
    const name = this.formatPugLobbyChannelName();
    if (channel.name === name) return channel;
    return channel.setName(name, reason).catch(() => channel);
  }

  private formatPugLobbyChannelName() {
    return `${pugLobbyChannelBaseName} - ${this.countPugPlayersInActiveMatches()} in-match`;
  }

  private countPugPlayersInActiveMatches() {
    return [...this.pugMatches.values()].reduce((total, match) => total + match.playerIds.length, 0);
  }

  async ensureTeamRolesDisplayed() {
    const guild = await this.getGuild();
    const teams = await this.store.getTeams();
    const organizationRoleIds = await this.ensureOrganizationalRoles(guild);
    const rankRoleIds = await this.ensurePugRankRoles(guild);
    await this.ensurePugRankRolePlacement(guild, [...rankRoleIds.values()], teams.map((team) => team.roleId)).catch((error) => {
      console.warn('Unable to place PUG rank roles above team roles:', error);
    });
    for (const team of teams) {
      await this.ensureTeamRolePlacement(guild, team.roleId, organizationRoleIds, [...rankRoleIds.values()]).catch((error) => {
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
      const rankRoles = [...(await this.ensurePugRankRoles(guild)).values()];
      await this.ensurePugRankRolePlacement(guild, rankRoles, [role.id]).catch((error) => {
        console.warn('Unable to place PUG rank roles above newly created team role:', error);
      });
      await this.ensureTeamRolePlacement(guild, role, organizationRoleIds, rankRoles).catch((error) => {
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

  private async ensurePugRankRoles(guild: Guild) {
    const settings = await this.store.getPugRankSettings();
    const definitions = pugRankRoleDefinitions(settings);
    const existingRoles = await guild.roles.fetch();
    const rankRoles = new Map<string, Role>();

    for (const definition of definitions) {
      const name = pugRankRoleName(definition.rank);
      const existingRole = existingRoles.find((role) => role.name === name);
      const color = pugRankRoleColor(definition.rank);
      if (existingRole) {
        if (!existingRole.managed) {
          const needsStyleUpdate = existingRole.hexColor.toLowerCase() !== String(color).toLowerCase() || existingRole.hoist || existingRole.icon !== (definition.rank.iconDataUrl ? existingRole.icon : null);
          if (needsStyleUpdate || definition.rank.iconDataUrl) {
            await existingRole.edit({ colors: { primaryColor: color }, hoist: false, icon: definition.rank.iconDataUrl ?? null, reason: 'PUG rank role style synchronized by 7th Circle Team Hub' }).catch((error) => {
              console.warn(`Unable to update PUG rank role ${existingRole.id}:`, error);
            });
          }
        }
        rankRoles.set(definition.rank.id, existingRole);
        continue;
      }

      const createdRole = await guild.roles.create({
        name,
        colors: { primaryColor: color },
        hoist: false,
        icon: definition.rank.iconDataUrl,
        permissions: [],
        reason: 'PUG rank role created by 7th Circle Team Hub'
      }).catch(async (error) => {
        console.warn(`Unable to create PUG rank role with icon for ${definition.rank.id}; retrying without icon:`, error);
        return guild.roles.create({
          name,
          colors: { primaryColor: color },
          hoist: false,
          permissions: [],
          reason: 'PUG rank role created by 7th Circle Team Hub'
        });
      });
      rankRoles.set(definition.rank.id, createdRole);
    }

    return rankRoles;
  }

  private async ensurePugRankEmojis(guild: Guild) {
    const settings = await this.store.getPugRankSettings();
    const emojiByRankId = new Map<string, string>();
    const definitions = pugRankRoleDefinitions(settings).filter((definition) => definition.rank.iconDataUrl);
    if (!definitions.length) return emojiByRankId;

    const existingEmojis = await guild.emojis.fetch().catch((error) => {
      console.warn('Unable to fetch PUG rank emojis:', error);
      return null;
    });
    if (!existingEmojis) return emojiByRankId;

    for (const definition of definitions) {
      const iconDataUrl = definition.rank.iconDataUrl;
      if (!iconDataUrl) continue;
      const baseName = pugRankEmojiBaseName(definition.rank);
      const name = `${baseName}_${hashDataUrl(iconDataUrl).slice(0, 8)}`.slice(0, 32);
      const existing = existingEmojis.find((emoji) => emoji.name === name);
      if (existing) {
        emojiByRankId.set(definition.rank.id, existing.toString());
        continue;
      }

      const stale = existingEmojis.filter((emoji) => emoji.name?.startsWith(`${baseName}_`));
      const created = await guild.emojis.create({ attachment: iconDataUrl, name, reason: 'PUG rank emblem emoji synchronized by 7th Circle Team Hub' }).catch((error) => {
        console.warn(`Unable to create PUG rank emoji for ${definition.rank.id}:`, error);
        return null;
      });
      if (created) {
        emojiByRankId.set(definition.rank.id, created.toString());
        await Promise.all(stale.map((emoji) => emoji.delete('PUG rank emblem changed').catch(() => undefined)));
      } else {
        const fallback = stale.first();
        if (fallback) emojiByRankId.set(definition.rank.id, fallback.toString());
      }
    }

    return emojiByRankId;
  }

  private async ensurePugRankRolePlacement(guild: Guild, rankRoles: Role[], teamRoleIds: string[]) {
    if (!rankRoles.length) return;
    const roles = await guild.roles.fetch();
    const editableRankRoles = rankRoles.filter((role) => role.editable);
    if (!editableRankRoles.length) return;

    const me = await guild.members.fetchMe();
    const highestManageablePosition = me.roles.highest.position - 1;
    if (highestManageablePosition < 1) return;

    const teamRoles = teamRoleIds.map((roleId) => roles.get(roleId)).filter((role): role is Role => Boolean(role));
    const highestTeamRolePosition = teamRoles.length ? Math.max(...teamRoles.map((role) => role.position)) : 0;
    const lowestDesiredPosition = Math.max(1, highestTeamRolePosition + 1);
    const highestFittingStartPosition = Math.max(1, highestManageablePosition - editableRankRoles.length + 1);
    const startPosition = Math.min(lowestDesiredPosition, highestFittingStartPosition);

    await Promise.all(editableRankRoles.map((role) => role.hoist
      ? role.setHoist(false, 'PUG rank roles are not displayed separately by 7th Circle Team Hub')
      : Promise.resolve(role)));

    const rolePositions = editableRankRoles.map((role, index) => ({ role, position: startPosition + index }));
    if (rolePositions.some(({ role, position }) => role.position !== position)) {
      await guild.roles.setPositions(rolePositions);
    }
  }

  private async syncPugRankRolesForUsers(userIds: string[], pruneUnassignedMembers = false) {
    const guild = await this.getGuild();
    const rankRoles = await this.ensurePugRankRoles(guild);
    const [ratings, rankSettings] = await Promise.all([this.store.getPugEloRatings(), this.store.getPugRankSettings()]);
    const topMasterUserIds = getTopMasterUserIds(ratings, rankSettings.masterPlayerCount);
    const ratingsByUserId = new Map(ratings.map((rating) => [rating.userId, rating]));
    const assignments = new Map<string, string>();
    for (const userId of new Set(userIds)) {
      const rating = ratingsByUserId.get(userId);
      if (!rating) continue;
      const rank = resolvePugRank(rating, rankSettings, topMasterUserIds);
      const role = rankRoles.get(rank.id);
      if (role) assignments.set(userId, role.id);
    }
    await this.applyPugRankRoles(guild, assignments, [...rankRoles.values()].map((role) => role.id), pruneUnassignedMembers);
  }

  private async syncPugRankRolesForRatedMembers(guild: Guild) {
    const ratings = await this.store.getPugEloRatings();
    await this.syncPugRankRolesForUsers(ratings.map((rating) => rating.userId), true);
  }

  private async applyPugRankRoles(guild: Guild, assignments: Map<string, string>, knownRankRoleIds?: string[], pruneUnassignedMembers = false) {
    const rankRoleIds = knownRankRoleIds ?? [...(await this.ensurePugRankRoles(guild)).values()].map((role) => role.id);
    const membersByUserId = new Map<string, GuildMember>();
    if (pruneUnassignedMembers) {
      const members = await guild.members.fetch().catch((error) => {
        console.warn('Unable to fetch guild members while pruning PUG rank roles:', error);
        return null;
      });
      members?.forEach((member) => {
        if (assignments.has(member.id) || rankRoleIds.some((roleId) => member.roles.cache.has(roleId))) {
          membersByUserId.set(member.id, member);
        }
      });
    }

    const targetUserIds = new Set(pruneUnassignedMembers ? [...membersByUserId.keys(), ...assignments.keys()] : assignments.keys());
    await Promise.all([...targetUserIds].map(async (userId) => {
      const selectedRoleId = assignments.get(userId);
      const member = membersByUserId.get(userId) ?? guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member) return;
      const staleRoleIds = rankRoleIds.filter((roleId) => roleId !== selectedRoleId && member.roles.cache.has(roleId));
      if (staleRoleIds.length) await member.roles.remove(staleRoleIds, 'PUG rank role changed').catch((error) => console.warn(`Unable to remove stale PUG rank roles from ${userId}:`, error));
      if (selectedRoleId && !member.roles.cache.has(selectedRoleId)) await member.roles.add(selectedRoleId, 'PUG rank role changed').catch((error) => console.warn(`Unable to add PUG rank role to ${userId}:`, error));
    }));
  }

  private async ensureTeamRolePlacement(guild: Guild, roleOrId: Role | string, organizationRoleIds?: Map<TeamMemberRole, string>, rankRoles: Role[] = []) {
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
    const lowestRankRolePosition = rankRoles.length ? Math.min(...rankRoles.map((role) => role.position)) : undefined;
    if (!teamRole.hoist) {
      teamRole = await teamRole.setHoist(true, 'Team roles are displayed separately by 7th Circle Team Hub');
    }

    const rankCeiling = lowestRankRolePosition === undefined ? highestManageablePosition : Math.max(1, lowestRankRolePosition - 1);
    const desiredPosition = Math.min(highestOrganizationRolePosition + 1, rankCeiling, highestManageablePosition);
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
          await existingRole.edit({ colors: { primaryColor: settings.color }, hoist: false, reason: 'Team organization role style normalized by 7th Circle Team Hub' });
        }
        roleIds.set(role, existingRole.id);
        continue;
      }

      const createdRole = await guild.roles.create({
        name: settings.name,
        colors: { primaryColor: settings.color },
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

function calculatePugEloChanges(
  teams: string[][],
  placements: number[],
  ratings: Map<string, PugEloRating>,
  playerUsernames: Map<string, string>,
  settings: PugEloSettings,
  size: PugQueueSize
): PugEloChange[] {
  const teamTotals = teams.map((team) => team.reduce((sum, userId) => sum + (ratings.get(userId)?.rating ?? settings.startingRating), 0));
  return teams.flatMap((team, teamIndex) => {
    const teamAverage = teamTotals[teamIndex] / Math.max(1, team.length);
    const opponents = teams.flatMap((otherTeam, otherIndex) => otherIndex === teamIndex ? [] : otherTeam);
    const opponentAverage = opponents.reduce((sum, userId) => sum + (ratings.get(userId)?.rating ?? settings.startingRating), 0) / Math.max(1, opponents.length);
    const placement = placements[teamIndex] ?? teams.length;
    return team.map((userId) => {
      const before = ratings.get(userId)?.rating ?? settings.startingRating;
      const possibleGain = calculatePugEloGain(before, teamAverage, opponentAverage, settings);
      const baseDelta = placement === 1
        ? possibleGain
        : placement === 2 && teams.length > 2
          ? Math.max(MINIMUM_PUG_ELO_CHANGE, Math.round(possibleGain / 2))
          : -calculatePugEloLoss(before, teamAverage, opponentAverage, possibleGain, settings);
      const delta = Math.round(baseDelta * getPugEloValueMultiplier(settings, size, baseDelta));
      return {
        userId,
        username: playerUsernames.get(userId) ?? ratings.get(userId)?.username,
        teamIndex,
        placement,
        before,
        after: Math.max(0, before + delta),
        delta
      };
    });
  });
}

function getPugEloValueMultiplier(settings: PugEloSettings, size: PugQueueSize, delta: number) {
  if (size === 12 && delta <= 0) return 1;
  return size === 12 ? settings.cashoutMultiplier : settings.finalRoundMultiplier;
}

const MINIMUM_PUG_ELO_CHANGE = 200;
const MAXIMUM_PUG_ELO_GAIN = 2000;
const MAXIMUM_PUG_ELO_LOSS_MULTIPLIER = 2;

function calculatePugEloGain(playerRating: number, teamAverage: number, opponentAverage: number, settings: PugEloSettings) {
  const teamFactor = Math.exp(((opponentAverage - teamAverage) / settings.startingRating) * settings.strength);
  const playerFactor = Math.exp(((teamAverage - playerRating) / (settings.startingRating * 2)) * settings.strength);
  return Math.max(MINIMUM_PUG_ELO_CHANGE, Math.min(MAXIMUM_PUG_ELO_GAIN, Math.round(settings.baseChange * teamFactor * playerFactor)));
}

function calculatePugEloLoss(playerRating: number, _teamAverage: number, opponentAverage: number, possibleGain: number, settings: PugEloSettings) {
  const opponentRatio = opponentAverage > 0 ? playerRating / opponentAverage : MAXIMUM_PUG_ELO_LOSS_MULTIPLIER;
  const cappedRatio = Math.min(MAXIMUM_PUG_ELO_LOSS_MULTIPLIER, opponentRatio);
  const baseLoss = Math.max(MINIMUM_PUG_ELO_CHANGE, Math.round(possibleGain * cappedRatio));
  return Math.round(baseLoss * (settings.fairLossPercentage / 100));
}

function formatPugEloSummary(changes: PugEloChange[]) {
  if (!changes.length) return 'No ELO changes were applied.';
  return `ELO changes: ${changes.map((change) => `${change.username ?? change.userId} ${change.delta >= 0 ? '+' : ''}${change.delta}`).join(', ')}.`;
}

function formatElo(rating: number) {
  return Math.round(rating).toLocaleString('en-US');
}


function formatPugRankTransition(transition?: PugRankTransition) {
  if (!transition) return undefined;
  if (transition.before.id === transition.after.id) return `Rank: **${transition.after.label}** (no rank change).`;
  const direction = getPugRankSortValue(transition.after) > getPugRankSortValue(transition.before) ? 'ranked up' : 'ranked down';
  return `Rank: **${transition.before.label}** → **${transition.after.label}** (${direction}).`;
}

function getPugRankSortValue(rank: Pick<PugRankDefinition, 'id' | 'minRating'>) {
  return rank.id === 'master-infernal' ? Number.MAX_SAFE_INTEGER : rank.minRating;
}

function sortPugRatingsForRankResolution(ratings: PugEloRating[]) {
  return [...ratings].sort((a, b) => b.rating - a.rating || (a.username ?? a.userId).localeCompare(b.username ?? b.userId));
}

function getPugTeamCount(size: PugQueueSize) {
  return size === 6 ? 2 : 4;
}

function pugQueueLabel(size: PugQueueSize) {
  return size === 6 ? 'Final Round' : 'Cashout';
}

function formatPugMatchId(matchId: string) {
  return matchId.replace(/-/g, '').slice(0, 8);
}

function getPugCaptainPicksPerTurn(_size: PugQueueSize) {
  return 1;
}

function buildPugCaptainDraftEmbed(match: PugMatch) {
  const draft = match.captainDraft;
  if (!draft) return new EmbedBuilder().setTitle('Captain Draft').setColor(0xc90820).setDescription('Captain draft has not started.');

  const currentCaptainId = draft.captainIds[draft.currentCaptainIndex];
  const picksRemaining = Math.min(getPugCaptainPicksPerTurn(match.size) - draft.picksThisTurn, draft.availablePlayerIds.length);
  return new EmbedBuilder()
    .setTitle('Captain Draft')
    .setColor(0xc90820)
    .setDescription(draft.availablePlayerIds.length ? `${formatPugPlayerLabel(match, currentCaptainId)} is picking now. Pick ${picksRemaining} more player${picksRemaining === 1 ? '' : 's'} this turn.` : 'Draft complete.')
    .addFields(
      ...draft.teams.map((team, index) => ({
        name: `Team ${index + 1} Captain: ${formatPugPlayerLabel(match, draft.captainIds[index])}`,
        value: team.map((id, playerIndex) => `${playerIndex === 0 ? '⭐ ' : ''}${formatPugPlayerLabel(match, id)}`).join('\n'),
        inline: true
      })),
      { name: 'Available players', value: draft.availablePlayerIds.map((id) => formatPugPlayerLabel(match, id)).join('\n') || 'No players remaining', inline: false }
    );
}

function buildPugCaptainDraftRows(match: PugMatch) {
  const draft = match.captainDraft;
  if (!draft) return [];
  const buttons = draft.availablePlayerIds.map((playerId) =>
    new ButtonBuilder()
      .setCustomId(`pug:draft:${match.id}:${playerId}`)
      .setLabel(truncateButtonLabel(getPugPlayerUsername(match, playerId)))
      .setStyle(ButtonStyle.Primary)
  );
  const rows: Array<ActionRowBuilder<ButtonBuilder>> = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
  }
  return rows;
}

function formatPugPlayerLabel(match: PugMatch, playerId: string) {
  const rankLabel = match.playerRankLabels.get(playerId);
  return `${getPugPlayerUsername(match, playerId)}${rankLabel ? ` [${rankLabel}]` : ''}`;
}

function getPugPlayerUsername(match: PugMatch, playerId: string) {
  return match.playerUsernames.get(playerId) ?? 'Unknown player';
}


function isDeveloperAccount(userId: string) {
  return userId === DEVELOPER_DISCORD_USER_ID;
}

function getTopMasterUserIds(ratings: Pick<PugEloRating, 'userId'>[], count: number) {
  return new Set(ratings.filter((rating) => !isDeveloperAccount(rating.userId)).slice(0, Math.max(0, count)).map((rating) => rating.userId));
}

function resolvePugRank(rating: Pick<PugEloRating, 'userId' | 'rating'>, settings: PugRankSettings, topMasterUserIds: Set<string>): PugRankDefinition {
  if (!isDeveloperAccount(rating.userId) && topMasterUserIds.has(rating.userId)) return { id: 'master-infernal', label: 'Master Infernal', abbreviation: 'M1', minRating: 0, iconDataUrl: settings.masterIconDataUrl };
  const ranks = settings.ranks.length ? settings.ranks : [];
  return [...ranks].reverse().find((item) => rating.rating >= item.minRating && (item.maxRating === undefined || rating.rating <= item.maxRating)) ?? ranks[0] ?? { id: 'unranked', label: 'Unranked', abbreviation: 'UR', minRating: 0 };
}

function pugRankRoleDefinitions(settings: PugRankSettings) {
  return [
    ...settings.ranks.map((rank) => ({ rank })),
    { rank: { id: 'master-infernal', label: 'Master Infernal', abbreviation: 'M1', minRating: 0, iconDataUrl: settings.masterIconDataUrl } satisfies PugRankDefinition }
  ];
}

function pugRankRoleName(rank: Pick<PugRankDefinition, 'id' | 'label'>) {
  return `PUG Rank · ${rank.id}`.slice(0, 100);
}

function formatPugRankDisplay(rank: PugRankDefinition, role?: Role, emoji?: string) {
  if (rank.iconDataUrl && emoji) return emoji;
  if (rank.iconDataUrl && role) return `<@&${role.id}>`;
  return rank.abbreviation || rank.label;
}

function pugRankEmojiBaseName(rank: Pick<PugRankDefinition, 'id'>) {
  return `pug_${rank.id.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 19) || 'rank'}`.slice(0, 23);
}

function hashDataUrl(dataUrl: string) {
  return createHash('sha256').update(dataUrl).digest('hex');
}

function pugRankRoleColor(rank: Pick<PugRankDefinition, 'id' | 'label'>): ColorResolvable {
  const key = `${rank.id} ${rank.label}`.toLowerCase();
  if (key.includes('bronze')) return '#cd7f32';
  if (key.includes('silver')) return '#c0c0c0';
  if (key.includes('gold')) return '#facc15';
  if (key.includes('platinum')) return '#67e8f9';
  if (key.includes('diamond')) return '#60a5fa';
  if (key.includes('master')) return '#c2410c';
  if (key.includes('infernal')) return '#f97316';
  return '#f5d0fe';
}

function truncateButtonLabel(label: string) {
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}

function majorityModeVote(match: PugMatch) {
  const threshold = getMajorityThreshold(match.playerIds.length);
  const counts = countVotes([...match.modeVotes.values()]);
  for (const mode of ['random', 'captains'] as const) {
    if ((counts.get(mode) ?? 0) >= threshold) return mode;
  }
  if (match.modeVotes.size === match.playerIds.length && (counts.get('random') ?? 0) === (counts.get('captains') ?? 0)) return 'random';
  return undefined;
}

function buildPugModeVoteEmbed(match: PugMatch) {
  const totalVoters = match.playerIds.length;
  const counts = countVotes([...match.modeVotes.values()]);
  const lines = ([
    ['random', 'Random teams'],
    ['captains', 'Captains']
  ] as Array<[PugTeamMode, string]>).map(([mode, label]) => formatVotePercentageLine(label, counts.get(mode) ?? 0, totalVoters));

  return new EmbedBuilder()
    .setTitle('Team Selection Vote')
    .setColor(0xc90820)
    .setDescription(`${match.selectedMode ? `**${modeLabel(match.selectedMode)} selected by majority vote.**\n\n` : ''}${lines.join('\n')}`)
    .setFooter({ text: `Majority required: ${getMajorityThreshold(totalVoters)}/${totalVoters}` });
}

function buildPugResultVoteEmbed(match: PugMatch, teamCount: number) {
  const totalVoters = match.playerIds.length;
  const lines = match.voteMode === 'winner'
    ? buildWinnerVoteLines(match, teamCount, totalVoters)
    : buildPlacementVoteLines(match, teamCount, totalVoters);

  return new EmbedBuilder()
    .setTitle(match.voteMode === 'winner' ? 'Winning Team Vote' : 'Placement Vote')
    .setColor(0xc90820)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Majority required: ${getMajorityThreshold(totalVoters)}/${totalVoters}` });
}

function buildWinnerVoteLines(match: PugMatch, teamCount: number, totalVoters: number) {
  const counts = countVotes([...match.votes.values()].filter((vote) => isCompletePugResultVote(vote)));
  return Array.from({ length: teamCount }, (_, index) => formatVotePercentageLine(`Team ${index + 1}`, counts.get(String(index)) ?? 0, totalVoters));
}

function buildPlacementVoteLines(match: PugMatch, teamCount: number, totalVoters: number) {
  const { winnerCounts, secondCounts } = countPlacementVotes(match.votes.values());
  const winnerLines = Array.from({ length: teamCount }, (_, index) => formatVotePercentageLine(`Winner: Team ${index + 1}`, winnerCounts.get(String(index)) ?? 0, totalVoters));
  const secondLines = Array.from({ length: teamCount }, (_, index) => formatVotePercentageLine(`Second: Team ${index + 1}`, secondCounts.get(String(index)) ?? 0, totalVoters));
  return [...winnerLines, '', ...secondLines];
}

function countPlacementVotes(votes: Iterable<string>) {
  const winnerCounts = new Map<string, number>();
  const secondCounts = new Map<string, number>();
  for (const vote of votes) {
    const [winner, second] = vote.split(',');
    if (winner) winnerCounts.set(winner, (winnerCounts.get(winner) ?? 0) + 1);
    if (second) secondCounts.set(second, (secondCounts.get(second) ?? 0) + 1);
  }
  return { winnerCounts, secondCounts };
}

function isCompletePugResultVote(vote: string) {
  return Boolean(vote && !vote.endsWith(',') && !vote.startsWith(','));
}

function countVotes<T extends string>(votes: T[]) {
  const counts = new Map<T, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  return counts;
}

function formatVotePercentageLine(label: string, count: number, total: number) {
  return `**${label}:** ${count}/${total} (${formatPercentage(count, total)})`;
}

function formatPercentage(count: number, total: number) {
  if (!total) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

function getMajorityThreshold(totalVoters: number) {
  return Math.floor(totalVoters / 2) + 1;
}

function modeLabel(mode: PugTeamMode) {
  return mode === 'captains' ? 'Captains' : 'Random teams';
}

function createRandomTeams(playerIds: string[], size: PugQueueSize) {
  const shuffled = shuffle(playerIds);
  const teamCount = getPugTeamCount(size);
  const teams = Array.from({ length: teamCount }, () => [] as string[]);
  shuffled.forEach((playerId, index) => teams[index % teamCount].push(playerId));
  return teams;
}


function randomIndex(length: number) {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Random index length must be a positive integer.');
  return randomInt(length);
}

function shuffle(values: string[]) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function buildPugVoteRows(matchId: string, teamCount: number, voteMode: 'winner' | 'placements') {
  const winnerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    Array.from({ length: teamCount }, (_, index) => new ButtonBuilder().setCustomId(`pug:vote:${matchId}:${index}`).setLabel(`Winner: Team ${index + 1}`).setStyle(ButtonStyle.Primary))
  );
  if (voteMode === 'winner') return [winnerRow];
  return [
    winnerRow,
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      Array.from({ length: teamCount }, (_, index) => new ButtonBuilder().setCustomId(`pug:vote2:${matchId}:${index}`).setLabel(`Second: Team ${index + 1}`).setStyle(ButtonStyle.Secondary))
    )
  ];
}

function majorityVote(match: PugMatch) {
  const threshold = Math.floor(match.playerIds.length / 2) + 1;
  if (match.voteMode === 'placements') {
    const { winnerCounts, secondCounts } = countPlacementVotes(match.votes.values());
    const winningTeam = findMajorityTeam(winnerCounts, threshold);
    const secondPlaceTeam = findMajorityTeam(secondCounts, threshold);
    if (winningTeam && secondPlaceTeam) return `Team ${Number(winningTeam) + 1} wins, Team ${Number(secondPlaceTeam) + 1} second place`;
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const vote of match.votes.values()) {
    if (!vote || vote.endsWith(',') || vote.startsWith(',')) continue;
    counts.set(vote, (counts.get(vote) ?? 0) + 1);
  }
  const winningTeam = findMajorityTeam(counts, threshold);
  return winningTeam ? `Team ${Number(winningTeam) + 1} wins` : undefined;
}

function findMajorityTeam(counts: Map<string, number>, threshold: number) {
  for (const [team, count] of counts) {
    if (count >= threshold) return team;
  }
  return undefined;
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


async function findInviteChannel(guild: Guild): Promise<GuildInvitableChannelResolvable> {
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();
  const candidates = [
    guild.systemChannelId ? channels.get(guild.systemChannelId) : undefined,
    ...channels.values()
  ];

  const channel = candidates.find((item) => {
    if (!item) return false;
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia].includes(item.type)) return false;
    return item.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.CreateInstantInvite]) ?? false;
  });

  if (!channel) throw new Error('Bot needs Create Instant Invite permission in at least one server channel.');
  return channel as GuildInvitableChannelResolvable;
}

async function renameGuildChannel(guild: Guild, channelId: string, name: string, reason: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !('setName' in channel)) return;
  await channel.setName(name, reason);
}

async function assertBotPermissions(guild: Guild) {
  const me = await guild.members.fetchMe();
  const needed = [PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers, PermissionsBitField.Flags.CreateInstantInvite];
  if (!me.permissions.has(needed)) {
    throw new Error('Bot needs Manage Roles, Manage Channels, Move Members, and Create Instant Invite permissions.');
  }
}


function isDiscordNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; code?: number | string };
  return candidate.status === 404 || candidate.code === 10065 || candidate.code === '10065';
}

export type TeamBotApi = Pick<
  TeamBot,
  | 'getGuildInviteUrl'
  | 'getGuildMember'
  | 'getGuildMemberProfiles'
  | 'getAdministratorAccess'
  | 'getTeamMemberDetails'
  | 'getGuildRoles'
  | 'getDeveloperStats'
  | 'restart'
  | 'updateDeveloperSettings'
  | 'syncPugRankRoles'
  | 'publishPugQueueMessage'
  | 'getPugAdminState'
  | 'deletePugMatch'
  | 'rollbackPugMatch'
  | 'resetPugMatch'
  | 'forcePugTeams'
  | 'forcePugCaptains'
  | 'searchInvitableMembers'
  | 'createTeam'
  | 'getTeamInviteDetails'
  | 'inviteTeamMembers'
  | 'setTeamRoleColor'
  | 'renameTeam'
  | 'setTeamMemberRole'
  | 'kickTeamMember'
  | 'transferTeamOwnership'
  | 'deleteTeam'
  | 'leaveTeam'
>;
