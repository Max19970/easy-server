import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_RETRY_MS = 25;

export class FilesystemLockTimeoutError extends Error {}
export class FilesystemLockCancelledError extends Error {}
export class FilesystemLockLostError extends Error {}

export interface FilesystemLockHooks {
  readonly staleOwnerObserved?: (ownerPath: string) => Promise<void> | void;
}

export interface FilesystemLockOptions {
  readonly timeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly heartbeatMs?: number;
  readonly retryMs?: number;
  readonly signal?: AbortSignal;
  readonly hooks?: FilesystemLockHooks;
}

export interface FilesystemLockLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export async function acquireFilesystemLock(
  lockPath: string,
  options: FilesystemLockOptions = {},
): Promise<FilesystemLockLease> {
  const timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const staleAfterMs = positiveFinite(
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    "staleAfterMs",
  );
  const heartbeatMs = positiveFinite(
    options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    "heartbeatMs",
  );
  const retryMs = positiveFinite(options.retryMs ?? DEFAULT_RETRY_MS, "retryMs");
  if (heartbeatMs >= staleAfterMs) {
    throw new TypeError("heartbeatMs must be less than staleAfterMs");
  }

  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    throwIfCancelled(options.signal);
    if (Date.now() >= deadline) {
      throw new FilesystemLockTimeoutError(`Timed out waiting for filesystem lock: ${lockPath}`);
    }

    const token = randomUUID();
    const ownerName = `${token}.owner`;
    const ownerPath = join(lockPath, ownerName);

    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(ownerPath, `${process.pid}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await removeEmptyDirectory(lockPath).catch(() => undefined);
        if (isErrno(error, "ENOENT")) {
          continue;
        }
        throw error;
      }

      let released = false;
      let heartbeatError: unknown;
      const heartbeat = setInterval(() => {
        if (released) {
          return;
        }
        const now = new Date();
        void utimes(ownerPath, now, now).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) {
            heartbeatError ??= error;
          }
        });
      }, heartbeatMs);

      return {
        async assertOwned() {
          if (heartbeatError !== undefined) {
            throw heartbeatError;
          }
          try {
            const now = new Date();
            await utimes(ownerPath, now, now);
          } catch (error) {
            if (isErrno(error, "ENOENT")) {
              throw new FilesystemLockLostError(`Filesystem lock ownership was lost: ${lockPath}`);
            }
            throw error;
          }
        },
        async release() {
          if (released) {
            return;
          }
          released = true;
          clearInterval(heartbeat);
          await releaseGeneration(lockPath, ownerName, retryMs, staleAfterMs);
        },
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
    }

    await recoverStaleLock(lockPath, staleAfterMs, options.hooks);
    throwIfCancelled(options.signal);
    if (Date.now() >= deadline) {
      throw new FilesystemLockTimeoutError(`Timed out waiting for filesystem lock: ${lockPath}`);
    }
    await delay(retryMs);
  }
}

async function recoverStaleLock(
  lockPath: string,
  staleAfterMs: number,
  hooks: FilesystemLockHooks | undefined,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (!metadata.isDirectory()) {
    await recoverLegacyLockFile(lockPath, metadata.mtimeMs, staleAfterMs);
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (entries.length === 0) {
    if (Date.now() - metadata.mtimeMs > staleAfterMs) {
      await removeEmptyDirectory(lockPath);
    }
    return;
  }

  for (const entry of entries) {
    if (entry.endsWith(".owner")) {
      await tryReclaimOwner(lockPath, entry, staleAfterMs, hooks);
      continue;
    }
    if (entry.includes(".owner.reclaim.")) {
      await tryRemoveAbandonedReclaim(lockPath, entry, staleAfterMs);
    }
  }
}

async function tryReclaimOwner(
  lockPath: string,
  ownerName: string,
  staleAfterMs: number,
  hooks: FilesystemLockHooks | undefined,
): Promise<void> {
  const ownerPath = join(lockPath, ownerName);
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(ownerPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (Date.now() - metadata.mtimeMs <= staleAfterMs) {
    return;
  }

  await hooks?.staleOwnerObserved?.(ownerPath);

  const reclaimPath = join(lockPath, `${ownerName}.reclaim.${randomUUID()}`);
  try {
    await rename(ownerPath, reclaimPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  let claimed: Awaited<ReturnType<typeof stat>>;
  try {
    claimed = await stat(reclaimPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (Date.now() - claimed.mtimeMs <= staleAfterMs) {
    try {
      await rename(reclaimPath, ownerPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
    }
    return;
  }

  await rm(reclaimPath, { force: true });
  await removeEmptyDirectory(lockPath);
}

async function tryRemoveAbandonedReclaim(
  lockPath: string,
  entry: string,
  staleAfterMs: number,
): Promise<void> {
  const path = join(lockPath, entry);
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs <= staleAfterMs) {
      return;
    }
    await rm(path, { force: true });
    await removeEmptyDirectory(lockPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

async function recoverLegacyLockFile(
  lockPath: string,
  mtimeMs: number,
  staleAfterMs: number,
): Promise<void> {
  if (Date.now() - mtimeMs <= staleAfterMs) {
    return;
  }

  let pid: number | undefined;
  try {
    const owner = await readFile(lockPath, "utf8");
    const parsed = Number.parseInt(owner.trim().split(/\s+/u)[0] ?? "", 10);
    pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
  }

  // Legacy locks had no renewable ownership generation. Age is authoritative so
  // PID reuse cannot preserve a dead pre-upgrade lock forever; the PID is kept
  // only as diagnostic-compatible content while upgrading from the old format.
  void pid;
  await rm(lockPath, { force: true });
}

async function releaseGeneration(
  lockPath: string,
  ownerName: string,
  retryMs: number,
  staleAfterMs: number,
): Promise<void> {
  const ownerPath = join(lockPath, ownerName);
  const reclaimPrefix = `${ownerName}.reclaim.`;
  const deadline = Date.now() + staleAfterMs;

  for (;;) {
    await rm(ownerPath, { force: true }).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
    });

    try {
      await rmdir(lockPath);
      return;
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      if (!isErrno(error, "ENOTEMPTY") && !isErrno(error, "EEXIST")) {
        throw error;
      }
    }

    let entries: string[];
    try {
      entries = await readdir(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (!entries.some((entry) => entry.startsWith(reclaimPrefix))) {
      return;
    }
    if (Date.now() >= deadline) {
      return;
    }
    await delay(retryMs);
  }
}

async function removeEmptyDirectory(lockPath: string): Promise<void> {
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (
      !isErrno(error, "ENOENT") &&
      !isErrno(error, "ENOTEMPTY") &&
      !isErrno(error, "EEXIST")
    ) {
      throw error;
    }
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FilesystemLockCancelledError("Filesystem lock acquisition was cancelled");
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
