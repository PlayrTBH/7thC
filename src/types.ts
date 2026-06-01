export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
};

export type TeamMemberRole = 'sub' | 'main' | 'coach' | 'captain';

export type Team = {
  id: string;
  name: string;
  ownerId: string;
  guildId: string;
  roleId: string;
  roleColor?: string;
  categoryId: string;
  textChannelId: string;
  voiceChannelId: string;
  createdAt: string;
};

export type TeamMember = {
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  joinedAt: string;
};

export type TeamInvite = {
  id: string;
  teamId: string;
  inviterId: string;
  inviteeId: string;
  status: 'pending' | 'accepted' | 'declined' | 'failed_dm';
  createdAt: string;
  respondedAt?: string;
};

export type Event = {
  id: string;
  title: string;
  description: string;
  teamLimit: number;
  requiredMainPlayers: number;
  requiredSubstitutes: number;
  startsAt: string;
  endsAt: string;
  registrationOpensAt: string;
  registrationClosesAt: string;
  backgroundImageDataUrl?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type EventRegistration = {
  id: string;
  eventId: string;
  teamId: string;
  captainId: string;
  mainPlayerIds: string[];
  substitutePlayerIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type BotActivityType = 'Playing' | 'Watching' | 'Listening' | 'Competing';
export type BotStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export type DeveloperSettings = {
  botStatus?: BotStatus;
  activityName?: string;
  activityType?: BotActivityType;
};

export type PugEloSettings = {
  startingRating: number;
  baseChange: number;
  strength: number;
  finalRoundMultiplier: number;
  cashoutMultiplier: number;
};

export type PugRankDefinition = {
  id: string;
  label: string;
  abbreviation: string;
  minRating: number;
  maxRating?: number;
  iconDataUrl?: string;
};

export type PugRankSettings = {
  ranks: PugRankDefinition[];
  masterIconDataUrl?: string;
};

export type PugSettings = {
  queueChannelId?: string;
  mapPool: string[];
  queueMessageId?: string;
  elo?: PugEloSettings;
  ranks?: PugRankSettings;
  seasons?: PugSeason[];
};

export type PugTeamMode = 'random' | 'captains';
export type PugVoteMode = 'winner' | 'placements';
export type PugQueueSize = 6 | 12;

export type PugEloRating = {
  userId: string;
  username?: string;
  rating: number;
  peakRating?: number;
  seasonId?: string;
  updatedAt: string;
};

export type PugSeasonStatus = 'active' | 'completed';

export type PugSeasonBadgeReward = {
  rankId: string;
  label: string;
  abbreviation?: string;
  iconDataUrl?: string;
};

export type PugSeason = {
  id: string;
  label: string;
  status: PugSeasonStatus;
  startsAt: string;
  endsAt?: string;
  endedAt?: string;
  badgeRewards: PugSeasonBadgeReward[];
};

export type PugSeasonLeaderboardEntry = {
  seasonId: string;
  seasonLabel: string;
  userId: string;
  username?: string;
  rating: number;
  rankId: string;
  rankLabel: string;
  placement: number;
};

export type PugUserBadge = {
  id: string;
  userId: string;
  seasonId: string;
  seasonLabel: string;
  rankId: string;
  rankLabel: string;
  label: string;
  abbreviation?: string;
  iconDataUrl?: string;
  awardedAt: string;
};

export type PugUserBadgeSelection = {
  userId: string;
  badgeIds: string[];
  updatedAt: string;
};

export type PugEloChange = {
  userId: string;
  username?: string;
  teamIndex: number;
  placement: number;
  before: number;
  after: number;
  delta: number;
};

export type PugMatchLog = {
  id: string;
  size: PugQueueSize;
  playerIds: string[];
  playerUsernames: Record<string, string>;
  teams: string[][];
  captainIds: string[];
  mode?: PugTeamMode;
  map?: string;
  voteMode?: PugVoteMode;
  votes: Record<string, string>;
  result?: string;
  teamEloTotals?: number[];
  eloChanges?: PugEloChange[];
  status: 'ongoing' | 'completed' | 'reset' | 'deleted' | 'rolledback';
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type AdministratorSettings = {
  adminRoleId?: string;
  discordInviteUrl?: string;
  developer?: DeveloperSettings;
  pugs?: PugSettings;
};

export type StoreShape = {
  teams: Team[];
  members: TeamMember[];
  invites: TeamInvite[];
  events: Event[];
  eventRegistrations: EventRegistration[];
  pugMatchLogs: PugMatchLog[];
  pugEloRatings: PugEloRating[];
  pugSeasonLeaderboards: PugSeasonLeaderboardEntry[];
  pugUserBadges: PugUserBadge[];
  pugUserBadgeSelections: PugUserBadgeSelection[];
  settings: AdministratorSettings;
};
