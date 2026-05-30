import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import session from 'express-session';
import { withFileLock } from './file-lock.js';

type SessionRecord = {
  session: session.SessionData;
  expiresAt?: string;
};

type SessionFile = Record<string, SessionRecord>;

export class JsonSessionStore extends session.Store {
  private queue = Promise.resolve();

  constructor(private readonly filePath: string) {
    super();
  }

  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void) {
    this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const data = await this.read();
        const { pruned, removed } = pruneExpiredSessions(data);
        if (removed > 0) await this.write(pruned);

        const record = pruned[sid];
        return record?.session ?? null;
      })
    )
      .then((storedSession) => callback(null, storedSession))
      .catch((error: unknown) => callback(error));
  }

  set(sid: string, storedSession: session.SessionData, callback?: (err?: unknown) => void) {
    this.update((data) => {
      data[sid] = {
        session: storedSession,
        expiresAt: getSessionExpiration(storedSession)
      };
      return data;
    })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  destroy(sid: string, callback?: (err?: unknown) => void) {
    this.update((data) => {
      delete data[sid];
      return data;
    })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  touch(sid: string, storedSession: session.SessionData, callback?: (err?: unknown) => void) {
    this.update((data) => {
      if (data[sid]) {
        data[sid] = {
          session: {
            ...data[sid].session,
            cookie: storedSession.cookie
          },
          expiresAt: getSessionExpiration(storedSession)
        };
      }
      return data;
    })
      .then(() => callback?.())
      .catch((error: unknown) => {
        this.emit('error', error);
        callback?.(error);
      });
  }

  private async read(): Promise<SessionFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      if (!raw.trim()) return {};
      return JSON.parse(raw) as SessionFile;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return {};
      throw error;
    }
  }

  private async write(data: SessionFile) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  private async update(mutator: (data: SessionFile) => SessionFile) {
    await this.enqueue(() =>
      withFileLock(this.filePath, async () => {
        const data = await this.read();
        const { pruned } = pruneExpiredSessions(data);
        await this.write(mutator(pruned));
      })
    );
  }

  private async enqueue<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function getSessionExpiration(storedSession: session.SessionData) {
  const expires = storedSession.cookie.expires;
  if (!expires) return undefined;
  return new Date(expires).toISOString();
}

function pruneExpiredSessions(data: SessionFile) {
  const now = Date.now();
  let removed = 0;
  const pruned: SessionFile = {};

  for (const [sid, record] of Object.entries(data)) {
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
      removed += 1;
      continue;
    }

    pruned[sid] = record;
  }

  return { pruned, removed };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
