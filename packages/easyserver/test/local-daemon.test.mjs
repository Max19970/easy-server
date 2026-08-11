import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  hostTrustRequiredError,
  isHostTrustRequiredError,
  normalizedError,
} from "@easyai101/easyserver-plugin-sdk";
import { retryWithHostTrust } from "../dist/connect-command.js";
import {
  claimLocalDaemonDescriptor,
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  removeLocalDaemonDescriptor,
  startLocalConnectionDaemon,
} from "../dist/local-daemon.js";

async function createFakeGateway() {
  const sessions = new Set();

  return {
    sessions,
    async openEndpoint() {
      const server = createServer((socket) => socket.pipe(socket));
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");

      let resolveClosed;
      const closed = new Promise((resolve) => {
        resolveClosed = resolve;
      });
      let closePromise;
      const session = {
        closed,
        close() {
          closePromise ??= new Promise((resolve, reject) => {
            server.close((error) => {
              sessions.delete(session);
              resolveClosed();
              if (error === undefined) {
                resolve();
              } else {
                reject(error);
              }
            });
          });
          return closePromise;
        },
      };
      sessions.add(session);

      return {
        endpoint: { host: "127.0.0.1", port: address.port },
        session,
      };
    },
  };
}

async function roundTrip(endpoint, payload) {
  const socket = connect(endpoint);
  await once(socket, "connect");
  const received = new Promise((resolve) => socket.once("data", resolve));
  socket.write(payload);
  const data = await received;
  socket.destroy();
  return data.toString();
}

async function expectConnectionRefused(endpoint) {
  const socket = connect(endpoint);
  const outcome = await new Promise((resolve) => {
    socket.once("connect", () => resolve("connected"));
    socket.once("error", () => resolve("error"));
  });
  socket.destroy();
  assert.equal(outcome, "error");
}

test("daemon preserves typed SSH host-trust-required results without non-interactive enrollment", async () => {
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        throw hostTrustRequiredError(
          "gpu.example",
          22,
          "ssh-ed25519",
          "SHA256:fixture",
        );
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await assert.rejects(
      retryWithHostTrust(
        () =>
          client.createSession({
            instanceId: "instance:fixture",
            remotePort: 8188,
          }),
        {
          sshAdapter: {
            async enrollHostKey() {
              assert.fail("non-interactive session creation must not enroll trust");
            },
          },
        },
      ),
      (error) =>
        isHostTrustRequiredError(error) &&
        error.host === "gpu.example" &&
        error.port === 22 &&
        error.keyType === "ssh-ed25519" &&
        error.fingerprint === "SHA256:fixture",
    );
  } finally {
    await daemon.close();
  }
});

test("caller-side SSH trust enrollment retries daemon session creation once", async () => {
  const trust = hostTrustRequiredError(
    "gpu.example",
    22,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  let attempts = 0;
  let enrolled;
  let confirmed;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        attempts += 1;
        if (attempts === 1) {
          throw trust;
        }
        return {
          endpoint: { host: "127.0.0.1", port: 41000 },
          session: {
            closed,
            async close() {
              resolveClosed();
            },
          },
        };
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const session = await retryWithHostTrust(
      () =>
        client.createSession({
          instanceId: "instance:fixture",
          remotePort: 8188,
        }),
      {
        sshAdapter: {
          async enrollHostKey(value) {
            enrolled = value;
          },
        },
        async confirmHostTrust(value) {
          confirmed = value;
          return true;
        },
      },
    );

    assert.equal(session.state, "live");
    assert.deepEqual(session.endpoint, { host: "127.0.0.1", port: 41000 });
    assert.equal(attempts, 2);
    assert.ok(isHostTrustRequiredError(confirmed));
    assert.equal(confirmed.fingerprint, trust.fingerprint);
    assert.equal(enrolled, confirmed);
    await client.closeSession(session.id);
  } finally {
    await daemon.close();
  }
});

test("declining daemon-session SSH trust does not enroll or retry", async () => {
  let attempts = 0;
  let enrollments = 0;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        attempts += 1;
        throw hostTrustRequiredError(
          "gpu.example",
          22,
          "ssh-ed25519",
          "SHA256:fixture",
        );
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await assert.rejects(
      retryWithHostTrust(
        () =>
          client.createSession({
            instanceId: "instance:fixture",
            remotePort: 8188,
          }),
        {
          sshAdapter: {
            async enrollHostKey() {
              enrollments += 1;
            },
          },
          async confirmHostTrust() {
            return false;
          },
        },
      ),
      (error) => error?.code === "cancelled" && /trust was declined/.test(error.message),
    );
    assert.equal(attempts, 1);
    assert.equal(enrollments, 0);
  } finally {
    await daemon.close();
  }
});

test("changed SSH host keys are not reinterpreted as first-use trust", async () => {
  let attempts = 0;
  let confirmations = 0;
  let enrollments = 0;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        attempts += 1;
        throw normalizedError("authentication", "SSH host key mismatch for gpu.example:22");
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await assert.rejects(
      retryWithHostTrust(
        () =>
          client.createSession({
            instanceId: "instance:fixture",
            remotePort: 8188,
          }),
        {
          sshAdapter: {
            async enrollHostKey() {
              enrollments += 1;
            },
          },
          async confirmHostTrust() {
            confirmations += 1;
            return true;
          },
        },
      ),
      (error) => error?.code === "authentication" && /host key mismatch/.test(error.message),
    );
    assert.equal(attempts, 1);
    assert.equal(confirmations, 0);
    assert.equal(enrollments, 0);
  } finally {
    await daemon.close();
  }
});

test("daemon shutdown aborts pending session setup", async () => {
  let setupStarted;
  const started = new Promise((resolve) => {
    setupStarted = resolve;
  });
  let releaseSetup;
  let sawAbort = false;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(_instanceId, _remotePort, _remoteHost, context) {
        setupStarted();
        return new Promise((resolve, reject) => {
          releaseSetup = () =>
            resolve({
              endpoint: { host: "127.0.0.1", port: 1 },
              session: {
                closed: Promise.resolve(),
                async close() {},
              },
            });
          context.signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("setup aborted"));
            },
            { once: true },
          );
        });
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");
  const creating = client
    .createSession({ instanceId: "instance:fixture", remotePort: 8188 })
    .catch(() => undefined);

  await started;
  const closing = daemon.close();
  let timedOut = false;
  try {
    await Promise.race([
      closing,
      delay(200).then(() => {
        timedOut = true;
        throw new Error("daemon.close() did not abort pending setup");
      }),
    ]);
    assert.equal(sawAbort, true);
  } finally {
    if (timedOut) {
      releaseSetup?.();
    }
    await creating;
    await closing;
  }
});

test("daemon health probe is bounded against a silent stale descriptor target", async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new LocalDaemonClient(
    { host: "127.0.0.1", port: address.port },
    "stale-token",
  );
  const ping = client.ping(20);

  try {
    const outcome = await Promise.race([
      ping.then(
        () => "settled",
        () => "settled",
      ),
      delay(100).then(() => "pending"),
    ]);
    assert.equal(outcome, "settled");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await ping.catch(() => undefined);
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("descriptor release does not delete a successor daemon descriptor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-daemon-"));
  const path = join(directory, "daemon.json");
  const first = {
    version: 1,
    address: { host: "127.0.0.1", port: 30_001 },
    authToken: "first-token",
  };
  const second = {
    version: 1,
    address: { host: "127.0.0.1", port: 30_002 },
    authToken: "second-token",
  };

  try {
    const releaseFirst = await claimLocalDaemonDescriptor(path, first);
    await removeLocalDaemonDescriptor(path);
    const releaseSecond = await claimLocalDaemonDescriptor(path, second);

    await releaseFirst();
    assert.deepEqual(await readLocalDaemonDescriptor(path), second);

    await releaseSecond();
    assert.equal(await readLocalDaemonDescriptor(path), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon retains cleanup-failed sessions without affecting healthy sessions", async () => {
  const baseGateway = await createFakeGateway();
  let openedCount = 0;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        const opened = await baseGateway.openEndpoint(...args);
        openedCount += 1;
        if (openedCount === 1) {
          const close = opened.session.close.bind(opened.session);
          opened.session.close = async () => {
            await close();
            throw new Error("fixture cleanup leaked-token=secret");
          };
        }
        return opened;
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  const failed = await client.createSession({
    instanceId: "instance:failed",
    remotePort: 8188,
  });
  const healthy = await client.createSession({
    instanceId: "instance:healthy",
    remotePort: 8188,
  });

  assert.equal(await roundTrip(healthy.endpoint, "before-failure"), "before-failure");
  await assert.rejects(
    client.closeSession(failed.id),
    (error) =>
      error?.code === "plugin-failure" &&
      error?.message === "Connection Session cleanup failed",
  );

  const sessions = await client.listSessions();
  const failedRecord = sessions.find((session) => session.id === failed.id);
  const healthyRecord = sessions.find((session) => session.id === healthy.id);
  assert.deepEqual(failedRecord, {
    id: failed.id,
    state: "failed",
    instanceId: "instance:failed",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    failure: {
      code: "plugin-failure",
      message: "Connection Session cleanup failed",
    },
  });
  assert.equal(healthyRecord?.state, "live");
  assert.deepEqual(healthyRecord?.endpoint, healthy.endpoint);
  assert.equal(await roundTrip(healthy.endpoint, "after-failure"), "after-failure");

  await assert.rejects(daemon.close(), new RegExp(failed.id));
  assert.equal(baseGateway.sessions.size, 0);
  await expectConnectionRefused(healthy.endpoint);
});

test("unexpected session closure failure remains observable and can be retried", async () => {
  let rejectClosed;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        return {
          endpoint: { host: "127.0.0.1", port: 1 },
          session: {
            closed: new Promise((_, reject) => {
              rejectClosed = reject;
            }),
            async close() {},
          },
        };
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const created = await client.createSession({
      instanceId: "instance:fixture",
      remotePort: 8188,
    });
    rejectClosed(
      normalizedError("plugin-failure", "provider-private-payload=secret"),
    );
    await delay(0);

    assert.deepEqual(await client.listSessions(), [
      {
        id: created.id,
        state: "failed",
        instanceId: "instance:fixture",
        remoteHost: "127.0.0.1",
        remotePort: 8188,
        failure: {
          code: "plugin-failure",
          message: "Connection Session cleanup failed",
        },
      },
    ]);

    await client.closeSession(created.id);
    assert.deepEqual(await client.listSessions(), []);
  } finally {
    await daemon.close().catch(() => undefined);
  }
});

test("failed session retention is bounded", async () => {
  const rejectors = [];
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        return {
          endpoint: { host: "127.0.0.1", port: 1 },
          session: {
            closed: new Promise((_, reject) => rejectors.push(reject)),
            async close() {},
          },
        };
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const created = [];
    for (let index = 0; index < 101; index += 1) {
      created.push(
        await client.createSession({
          instanceId: `instance:${index}`,
          remotePort: 8188,
        }),
      );
    }
    for (const reject of rejectors) {
      reject(new Error("fixture private failure"));
    }
    await delay(0);

    const retained = await client.listSessions();
    assert.equal(retained.length, 100);
    assert.equal(retained.some((session) => session.id === created[0].id), false);
    assert.equal(retained.every((session) => session.state === "failed"), true);
  } finally {
    await daemon.close().catch(() => undefined);
  }
});

test("authenticated daemon control owns sessions beyond one client call", async () => {
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await assert.rejects(
      new LocalDaemonClient(daemon.address, "wrong-token").listSessions(),
      /401/,
    );

    const created = await client.createSession({
      instanceId: "instance:fixture",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
    });

    assert.equal(await roundTrip(created.endpoint, "hello"), "hello");
    assert.deepEqual(await client.listSessions(), [created]);

    await client.closeSession(created.id);
    assert.deepEqual(await client.listSessions(), []);
    await expectConnectionRefused(created.endpoint);

    const second = await client.createSession({
      instanceId: "instance:fixture",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
    });
    assert.equal(await roundTrip(second.endpoint, "still-alive"), "still-alive");

    await daemon.close();
    assert.equal(gateway.sessions.size, 0);
    await expectConnectionRefused(second.endpoint);
  } finally {
    await daemon.close().catch(() => undefined);
  }
});
