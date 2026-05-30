import type { TeamBotApi } from './bot.js';

type RpcRequest = {
  type: 'bot-rpc-request';
  id: string;
  method: keyof TeamBotApi;
  args: unknown[];
};

type RpcResponse = {
  type: 'bot-rpc-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { name?: string; message: string; stack?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const botMethods = [
  'getGuildInviteUrl',
  'getGuildMember',
  'getAdministratorAccess',
  'getTeamMemberDetails',
  'getGuildRoles',
  'getDeveloperStats',
  'restart',
  'updateDeveloperSettings',
  'searchInvitableMembers',
  'createTeam',
  'getTeamInviteDetails',
  'inviteTeamMembers',
  'setTeamRoleColor',
  'renameTeam',
  'setTeamMemberRole',
  'kickTeamMember',
  'transferTeamOwnership',
  'deleteTeam',
  'leaveTeam'
] as const satisfies readonly (keyof TeamBotApi)[];

export function createBotProxy(): TeamBotApi {
  if (!process.send) throw new Error('Bot proxy requires an IPC channel to the primary process.');

  const pending = new Map<string, PendingRequest>();
  process.on('message', (message: unknown) => {
    if (!isRpcResponse(message)) return;

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);

    if (message.ok) {
      request.resolve(message.result);
      return;
    }

    const error = new Error(message.error?.message ?? 'Bot RPC request failed.');
    error.name = message.error?.name ?? 'BotRpcError';
    error.stack = message.error?.stack;
    request.reject(error);
  });

  return Object.fromEntries(botMethods.map((method) => [method, (...args: unknown[]) => callBot(method, args, pending)])) as TeamBotApi;
}

export async function handleBotRpcRequest(bot: TeamBotApi, request: RpcRequest) {
  try {
    const method = bot[request.method] as (...args: unknown[]) => Promise<unknown>;
    const result = await method.apply(bot, request.args);
    return { type: 'bot-rpc-response', id: request.id, ok: true, result } satisfies RpcResponse;
  } catch (error) {
    return { type: 'bot-rpc-response', id: request.id, ok: false, error: serializeError(error) } satisfies RpcResponse;
  }
}

export function isRpcRequest(message: unknown): message is RpcRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Partial<RpcRequest>).type === 'bot-rpc-request' &&
    typeof (message as Partial<RpcRequest>).id === 'string' &&
    botMethods.includes((message as Partial<RpcRequest>).method as keyof TeamBotApi) &&
    Array.isArray((message as Partial<RpcRequest>).args)
  );
}

function callBot(method: keyof TeamBotApi, args: unknown[], pending: Map<string, PendingRequest>) {
  return new Promise<unknown>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('Bot proxy IPC channel is not available.'));
      return;
    }

    const id = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    pending.set(id, { resolve, reject });
    process.send({ type: 'bot-rpc-request', id, method, args } satisfies RpcRequest, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  });
}

function isRpcResponse(message: unknown): message is RpcResponse {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Partial<RpcResponse>).type === 'bot-rpc-response' &&
    typeof (message as Partial<RpcResponse>).id === 'string' &&
    typeof (message as Partial<RpcResponse>).ok === 'boolean'
  );
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { message: String(error) };
}
