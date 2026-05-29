import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoreShape, Team, TeamInvite } from './types.js';

const initialStore: StoreShape = {
  teams: [],
  invites: []
};

export class JsonStore {
  private queue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, 'utf8');
    } catch {
      await this.write(initialStore);
    }
  }

  async getTeamsByOwner(ownerId: string) {
    const data = await this.read();
    return data.teams.filter((team) => team.ownerId === ownerId);
  }

  async getTeam(teamId: string) {
    const data = await this.read();
    return data.teams.find((team) => team.id === teamId);
  }

  async getInvite(inviteId: string) {
    const data = await this.read();
    return data.invites.find((invite) => invite.id === inviteId);
  }

  async addTeam(team: Team) {
    await this.update((data) => {
      data.teams.push(team);
      return data;
    });
  }

  async addInvites(invites: TeamInvite[]) {
    await this.update((data) => {
      data.invites.push(...invites);
      return data;
    });
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

  private async read(): Promise<StoreShape> {
    const raw = await readFile(this.filePath, 'utf8');
    return JSON.parse(raw) as StoreShape;
  }

  private async write(data: StoreShape) {
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  private async update(mutator: (data: StoreShape) => StoreShape) {
    this.queue = this.queue.then(async () => {
      const current = await this.read();
      await this.write(mutator(current));
    });
    await this.queue;
  }
}
