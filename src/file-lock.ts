import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

type LockMetadata = {
  pid: number;
  createdAt: number;
};

export async function withFileLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireLock(lockPath: string) {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies LockMetadata), 'utf8');
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for file lock ${lockPath}`);
      }

      await removeStaleLock(lockPath).catch(() => undefined);
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function removeStaleLock(lockPath: string) {
  const raw = await readFile(`${lockPath}/owner.json`, 'utf8');
  const metadata = JSON.parse(raw) as Partial<LockMetadata>;
  if (typeof metadata.createdAt === 'number' && Date.now() - metadata.createdAt > LOCK_STALE_MS) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
