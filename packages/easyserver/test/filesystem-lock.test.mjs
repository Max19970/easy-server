import assert from "node:assert/strict";
import { mkdir, readdir, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFilesystemLock } from "../dist/filesystem-lock.js";

async function withTempDirectory(run) {
  const path = join(tmpdir(), `easyserver-lock-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function createStaleGeneration(lockPath, generation = "stale-generation") {
  await mkdir(lockPath, { recursive: true });
  const ownerPath = join(lockPath, `${generation}.owner`);
  await writeFile(ownerPath, `${process.pid}\n`, "utf8");
  const stale = new Date(Date.now() - 60_000);
  await utimes(ownerPath, stale, stale);
  return ownerPath;
}

test("two stale-lock reclaimers serialize and cannot delete a successor generation", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "state.lock");
    await createStaleGeneration(lockPath);

    let bothObservedResolve;
    const bothObserved = new Promise((resolve) => {
      bothObservedResolve = resolve;
    });
    let observations = 0;
    let releaseObservers;
    const observerGate = new Promise((resolve) => {
      releaseObservers = resolve;
    });
    const hooks = {
      async staleOwnerObserved() {
        observations += 1;
        if (observations === 2) {
          bothObservedResolve();
        }
        await observerGate;
      },
    };

    let active = 0;
    let maxActive = 0;
    const enter = async () => {
      const lease = await acquireFilesystemLock(lockPath, {
        timeoutMs: 3_000,
        staleAfterMs: 1_000,
        heartbeatMs: 50,
        retryMs: 1,
        hooks,
      });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      await lease.release();
    };

    const first = enter();
    const second = enter();
    await bothObserved;
    releaseObservers();
    await Promise.all([first, second]);

    assert.equal(maxActive, 1);
  });
});

test("a delayed stale observation cannot remove a live successor generation", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "state.lock");
    await createStaleGeneration(lockPath);

    let observedResolve;
    const observed = new Promise((resolve) => {
      observedResolve = resolve;
    });
    let resumeObserver;
    const observerGate = new Promise((resolve) => {
      resumeObserver = resolve;
    });
    const delayed = acquireFilesystemLock(lockPath, {
      timeoutMs: 3_000,
      staleAfterMs: 1_000,
      heartbeatMs: 50,
      retryMs: 1,
      hooks: {
        async staleOwnerObserved() {
          observedResolve();
          await observerGate;
        },
      },
    });

    await observed;
    const successor = await acquireFilesystemLock(lockPath, {
      timeoutMs: 3_000,
      staleAfterMs: 1_000,
      heartbeatMs: 50,
      retryMs: 1,
    });
    resumeObserver();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await successor.assertOwned();

    await successor.release();
    const delayedLease = await delayed;
    await delayedLease.release();
  });
});

test("an old owner release cannot remove a successor generation", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "state.lock");
    const oldOwner = await acquireFilesystemLock(lockPath, {
      timeoutMs: 500,
      staleAfterMs: 200,
      heartbeatMs: 50,
      retryMs: 1,
    });
    const [ownerName] = await readdir(lockPath);
    await rm(join(lockPath, ownerName), { force: true });
    await rmdir(lockPath);

    const successor = await acquireFilesystemLock(lockPath, {
      timeoutMs: 500,
      staleAfterMs: 200,
      heartbeatMs: 50,
      retryMs: 1,
    });
    await oldOwner.release();
    await successor.assertOwned();
    await successor.release();
  });
});

test("a stale lease is recoverable even when its recorded PID is currently alive", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "state.lock");
    await createStaleGeneration(lockPath, "reused-pid-generation");

    const lease = await acquireFilesystemLock(lockPath, {
      timeoutMs: 500,
      staleAfterMs: 20,
      heartbeatMs: 5,
      retryMs: 1,
    });
    await lease.release();
  });
});

test("a crashed owner generation is reclaimed automatically", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "state.lock");
    await createStaleGeneration(lockPath, "crashed-generation");

    const lease = await acquireFilesystemLock(lockPath, {
      timeoutMs: 500,
      staleAfterMs: 20,
      heartbeatMs: 5,
      retryMs: 1,
    });
    await lease.release();
  });
});
