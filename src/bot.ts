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
  type GuildMember,
  ActivityType,
  type PresenceStatusData
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { JsonStore } from './store.js';
import type { BotActivityType, BotStatus, DeveloperSettings, Team, TeamInvite, TeamMemberRole } from './types.js';

const organizationRoleColor = '#6b7280';
const pugQueueSizes = [6, 12] as const;
type PugQueueSize = (typeof pugQueueSizes)[number];
type PugQueuedPlayer = { userId: string; username: string; voiceChannelId?: string };
type PugTeamMode = 'random' | 'captains';
type PugVoteMode = 'winner' | 'placements';
type PugCaptainDraft = { captainIds: string[]; teams: string[][]; availablePlayerIds: string[]; currentCaptainIndex: number; picksThisTurn: number; messageId?: string };
type PugMatch = { id: string; size: PugQueueSize; playerIds: string[]; playerUsernames: Map<string, string>; categoryId: string; queueVoiceChannelId: string; textChannelId: string; teamVoiceChannelIds: string[]; modeVotes: Map<string, PugTeamMode>; selectedMode?: PugTeamMode; modeVoteMessageId?: string; captainDraft?: PugCaptainDraft; voteMode?: PugVoteMode; voteMessageId?: string; votes: Map<string, string> };

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
  private readonly pugMatches = new Map<string, PugMatch>();
  private readonly teamCreationLocks = new Map<string, Promise<{ team: Team; invites: TeamInvite[] }>>();
  private restartOperation?: Promise<void>;

  constructor(private readonly store: JsonStore) {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      if (interaction.customId.startsWith('pug:')) {
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          }
          await this.handlePugInteraction(interaction);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to process this PUG action.';
          await this.respondToPugInteraction(interaction, message).catch((responseError) => {
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
    await this.applyDeveloperSettings(await this.store.getDeveloperSettings());
    console.log(`Discord bot ready as ${this.client.user?.tag}`);
  }

  async getGuild() {
    const guild = await this.client.guilds.fetch(config.DISCORD_GUILD_ID);
    return guild.fetch();
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

  private buildPugQueueMessage() {
    const embed = new EmbedBuilder()
      .setTitle('PUG Queue')
      .setDescription('Join a pickup-game queue. If you are already in a voice channel when the queue fills, the bot will move you into the match queue channel automatically.')
      .setColor(0xc90820)
      .addFields(
        pugQueueSizes.map((size) => {
          const queued = this.pugQueues.get(size) ?? [];
          return {
            name: pugQueueLabel(size),
            value: queued.length ? `${queued.length}/${size}: ${queued.map((player) => `<@${player.userId}>`).join(', ')}` : `0/${size} players queued`,
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

  private async refreshPugQueueMessage() {
    const settings = await this.store.getAdministratorSettings();
    const pugs = settings.pugs;
    if (!pugs?.queueChannelId || !pugs.queueMessageId) return;
    const guild = await this.getGuild();
    const channel = await guild.channels.fetch(pugs.queueChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const message = await channel.messages.fetch(pugs.queueMessageId).catch(() => null);
    await message?.edit(this.buildPugQueueMessage()).catch((error) => console.warn('Unable to refresh PUG queue message:', error));
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
    const guild = await this.getGuild();
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || member.user.bot) throw new Error('Only server members can join the PUG queue.');

    for (const [queueSize, players] of this.pugQueues) {
      const existingIndex = players.findIndex((player) => player.userId === member.id);
      if (existingIndex >= 0) players.splice(existingIndex, 1);
      if (!players.length) this.pugQueues.delete(queueSize);
    }

    const queue = this.pugQueues.get(size) ?? [];
    queue.push({ userId: member.id, username: member.user.username, voiceChannelId: member.voice.channelId ?? undefined });
    this.pugQueues.set(size, queue);
    await this.refreshPugQueueMessage();
    await this.respondToPugInteraction(interaction, `You joined ${pugQueueLabel(size)} (${queue.length}/${size}).`);

    if (queue.length >= size) {
      const players = queue.splice(0, size);
      if (!queue.length) this.pugQueues.delete(size);
      await this.refreshPugQueueMessage();
      await this.startPugMatch(guild, size, players);
    }
  }

  private async leavePugQueue(interaction: import('discord.js').ButtonInteraction, size: PugQueueSize) {
    const queue = this.pugQueues.get(size) ?? [];
    const before = queue.length;
    const filtered = queue.filter((player) => player.userId !== interaction.user.id);
    if (filtered.length) this.pugQueues.set(size, filtered);
    else this.pugQueues.delete(size);
    await this.refreshPugQueueMessage();
    await this.respondToPugInteraction(interaction, before === filtered.length ? 'You were not in that PUG queue.' : `You left ${pugQueueLabel(size)}.`);
  }

  private async startPugMatch(guild: Guild, size: PugQueueSize, players: PugQueuedPlayer[]) {
    await assertBotPermissions(guild);
    const matchId = randomUUID();
    const playerIds = players.map((player) => player.userId);
    const overwrites = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      ...playerIds.map((userId) => ({ id: userId, type: OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }))
    ];

    const lobby = await this.ensurePugLobbyChannel(guild);
    const category = await guild.channels.create({ name: `PUG Match ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`, type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: 'PUG match category created when queue filled' });
    const queueVoice = await guild.channels.create({ name: 'queue', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: overwrites, reason: 'PUG queue voice channel created when queue filled' });
    const text = await guild.channels.create({ name: 'pug-match', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites, topic: `PUG match ${matchId}`, reason: 'PUG match text channel created when queue filled' });

    const fetchedPlayers = await Promise.all(playerIds.map(async (playerId) => guild.members.fetch(playerId).catch(() => null)));
    const playerUsernames = new Map(playerIds.map((playerId, index) => [playerId, fetchedPlayers[index]?.user.username ?? players[index].username]));
    const match: PugMatch = { id: matchId, size, playerIds, playerUsernames, categoryId: category.id, queueVoiceChannelId: queueVoice.id, textChannelId: text.id, teamVoiceChannelIds: [], modeVotes: new Map(), votes: new Map() };
    this.pugMatches.set(matchId, match);

    await Promise.all(players.map(async (player, index) => {
      const member = fetchedPlayers[index];
      if (!member) return;
      if (player.voiceChannelId && member.voice.channelId) {
        await member.voice.setChannel(queueVoice, 'PUG queue filled').catch((error) => console.warn(`Unable to move PUG player ${player.userId}:`, error));
        return;
      }
      await member.send({ content: `Your PUG queue is ready in **${guild.name}**. Join ${queueVoice.toString()} so the match can begin.` }).catch((error) => console.warn(`Unable to DM PUG player ${player.userId}:`, error));
    }));

    const modeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pug:mode:${matchId}:random`).setLabel('Random teams').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pug:mode:${matchId}:captains`).setLabel('Captains').setStyle(ButtonStyle.Primary)
    );
    await text.send({ content: `${playerIds.map((id) => `<@${id}>`).join(' ')} PUG queue is full. Waiting for everyone to join ${queueVoice.toString()} before team selection starts.`, allowedMentions: { users: playerIds } });
    await this.waitForPugPlayersInQueue(guild, match);
    const modeMessage = await text.send({ content: `${playerIds.map((id) => `<@${id}>`).join(' ')} everyone is in the queue voice channel. Vote on how teams should be created. A majority vote decides the team selection mode.`, embeds: [buildPugModeVoteEmbed(match)], components: [modeRow], allowedMentions: { users: playerIds } });
    match.modeVoteMessageId = modeMessage.id;
  }

  private async waitForPugPlayersInQueue(guild: Guild, match: PugMatch) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const members = await Promise.all(match.playerIds.map((userId) => guild.members.fetch(userId).catch(() => null)));
      if (members.every((member) => member?.voice.channelId === match.queueVoiceChannelId)) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const channel = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await channel.send('Not every queued player joined the queue voice channel within 10 minutes. Continuing with team selection for the queued match.').catch(() => undefined);
    }
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

    const guild = await this.getGuild();
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (!text || text.type !== ChannelType.GuildText) throw new Error('PUG text channel no longer exists.');

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

  private async finalizePugTeams(guild: Guild, text: import('discord.js').TextChannel, match: PugMatch, teams: string[][], description: string) {
    const map = await this.pickPugMap();
    await this.createPugTeamVoiceChannels(guild, match, teams);

    await text.send({
      embeds: [new EmbedBuilder().setTitle('PUG Teams').setColor(0xc90820).setDescription(`${description}${map ? `\n\n**Map:** ${map}` : ''}`).addFields(teams.map((team, index) => ({ name: `Team ${index + 1}`, value: team.map((id, playerIndex) => `${playerIndex === 0 && match.selectedMode === 'captains' ? '⭐ ' : ''}${formatPugPlayerLabel(match, id)}`).join('\n') || 'No players', inline: true })))],
      allowedMentions: { users: match.playerIds }
    });
    await this.sendPugVotePrompt(text, match, teams.length);
  }

  private async createPugTeamVoiceChannels(guild: Guild, match: PugMatch, teams: string[][]) {
    for (const [index, team] of teams.entries()) {
      const channel = await guild.channels.create({ name: `Team ${index + 1}`, type: ChannelType.GuildVoice, parent: match.categoryId, reason: 'PUG team voice channel created' });
      match.teamVoiceChannelIds.push(channel.id);
      await Promise.all(team.map(async (userId) => {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member?.voice.channelId) await member.voice.setChannel(channel, 'PUG teams assigned').catch(() => undefined);
      }));
    }
  }

  private async pickPugMap() {
    const settings = await this.store.getAdministratorSettings();
    const maps = settings.pugs?.mapPool.map((map) => map.trim()).filter(Boolean) ?? [];
    if (!maps.length) return undefined;
    return maps[Math.floor(Math.random() * maps.length)];
  }

  private async sendPugVotePrompt(text: import('discord.js').TextChannel, match: PugMatch, teamCount: number) {
    match.voteMode = teamCount === 2 ? 'winner' : 'placements';
    const rows = buildPugVoteRows(match.id, teamCount, match.voteMode);
    const message = await text.send({ content: match.voteMode === 'winner' ? 'Vote for the winning team. A majority vote ends the match.' : 'Vote for first and second place. A majority on matching placements ends the match.', embeds: [buildPugResultVoteEmbed(match, teamCount)], components: rows });
    match.voteMessageId = message.id;
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

  private async endPugMatch(match: PugMatch, result: string) {
    const guild = await this.getGuild();
    const lobby = await this.ensurePugLobbyChannel(guild);
    const text = await guild.channels.fetch(match.textChannelId).catch(() => null);
    if (text?.type === ChannelType.GuildText) {
      await this.refreshPugResultVoteMessage(match);
      await text.send(`PUG match ended. Result: ${result}. Cleaning up channels now.`).catch(() => undefined);
    }

    await Promise.all(match.playerIds.map(async (userId) => {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member?.voice.channelId) await member.voice.setChannel(lobby, 'PUG match ended').catch(() => undefined);
    }));

    for (const channelId of [...match.teamVoiceChannelIds, match.queueVoiceChannelId, match.textChannelId, match.categoryId]) {
      await guild.channels.delete(channelId, 'PUG match ended').catch(() => undefined);
    }
    this.pugMatches.delete(match.id);
  }

  private async ensurePugLobbyChannel(guild: Guild) {
    const channels = await guild.channels.fetch();
    const existing = channels.find((channel) => channel?.type === ChannelType.GuildVoice && channel.name === 'PUG Lobby');
    if (existing && existing.type === ChannelType.GuildVoice) return existing;
    return guild.channels.create({ name: 'PUG Lobby', type: ChannelType.GuildVoice, reason: 'Persistent PUG lobby channel created by queue system' });
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


function getPugTeamCount(size: PugQueueSize) {
  return size === 6 ? 2 : 4;
}

function pugQueueLabel(size: PugQueueSize) {
  return size === 6 ? 'Final Round' : 'Cashout';
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
  return getPugPlayerUsername(match, playerId);
}

function getPugPlayerUsername(match: PugMatch, playerId: string) {
  return match.playerUsernames.get(playerId) ?? 'Unknown player';
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
  const completeVotes = [...match.votes.values()].filter((vote) => isCompletePugResultVote(vote));
  const counts = countVotes(completeVotes);
  const lines = match.voteMode === 'winner'
    ? Array.from({ length: teamCount }, (_, index) => formatVotePercentageLine(`Team ${index + 1}`, counts.get(String(index)) ?? 0, totalVoters))
    : buildPlacementVoteOptions(teamCount).map((vote) => {
        const [first, second] = vote.split(',').map((value) => Number(value) + 1);
        return formatVotePercentageLine(`Team ${first} first, Team ${second} second`, counts.get(vote) ?? 0, totalVoters);
      });

  return new EmbedBuilder()
    .setTitle(match.voteMode === 'winner' ? 'Winning Team Vote' : 'Placement Vote')
    .setColor(0xc90820)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Majority required: ${getMajorityThreshold(totalVoters)}/${totalVoters}` });
}

function buildPlacementVoteOptions(teamCount: number) {
  const votes: string[] = [];
  for (let first = 0; first < teamCount; first += 1) {
    for (let second = 0; second < teamCount; second += 1) {
      if (second === first) continue;
      votes.push(`${first},${second}`);
    }
  }
  return votes;
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

function shuffle(values: string[]) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function buildPugVoteRows(matchId: string, teamCount: number, voteMode: 'winner' | 'placements') {
  const winnerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    Array.from({ length: teamCount }, (_, index) => new ButtonBuilder().setCustomId(`pug:vote:${matchId}:${index}`).setLabel(`${voteMode === 'winner' ? 'Winner' : 'First'}: Team ${index + 1}`).setStyle(ButtonStyle.Primary))
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
  const counts = new Map<string, number>();
  for (const vote of match.votes.values()) {
    if (!vote || vote.endsWith(',') || vote.startsWith(',')) continue;
    counts.set(vote, (counts.get(vote) ?? 0) + 1);
  }
  for (const [vote, count] of counts) {
    if (count < threshold) continue;
    if (match.voteMode === 'winner') return `Team ${Number(vote) + 1} wins`;
    const [first, second] = vote.split(',').map((value) => Number(value) + 1);
    return `Team ${first} first place, Team ${second} second place`;
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

export type TeamBotApi = Pick<
  TeamBot,
  | 'getGuildInviteUrl'
  | 'getGuildMember'
  | 'getAdministratorAccess'
  | 'getTeamMemberDetails'
  | 'getGuildRoles'
  | 'getDeveloperStats'
  | 'restart'
  | 'updateDeveloperSettings'
  | 'publishPugQueueMessage'
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
