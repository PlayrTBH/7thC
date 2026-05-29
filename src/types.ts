export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
};

export type Team = {
  id: string;
  name: string;
  ownerId: string;
  guildId: string;
  roleId: string;
  categoryId: string;
  textChannelId: string;
  voiceChannelId: string;
  createdAt: string;
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

export type StoreShape = {
  teams: Team[];
  invites: TeamInvite[];
};
