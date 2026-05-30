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

export type BotActivityType = 'Playing' | 'Watching' | 'Listening' | 'Competing';
export type BotStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export type DeveloperSettings = {
  botStatus?: BotStatus;
  activityName?: string;
  activityType?: BotActivityType;
};

export type AdministratorSettings = {
  adminRoleId?: string;
  developer?: DeveloperSettings;
};

export type StoreShape = {
  teams: Team[];
  members: TeamMember[];
  invites: TeamInvite[];
  settings: AdministratorSettings;
};
