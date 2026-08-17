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
import { normalizedConnectionError } from "../dist/connection-failure.js";
import { acquireFilesystemLock } from "../dist/filesystem-lock.js";
import { JsonStateStore } from "../dist/state-store.js";
import {
  claimLocalDaemonDescriptor,
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  removeLocalDaemonDescriptor,
  startLocalConnectionDaemon,
} from "../dist/local-daemon.js";

const DEFAULT_ACCESS_METHOD = {
  id: "fixture-default",
  kind: "fixture:direct",
  mode: "tcp-forward",
};

async function createFakeGateway() {
  const sessions = new Set();

  return {
    sessions,
    async openEndpoint(
      _instanceId,
      _remotePort,
      _remoteHost,
      _context,
      localPort,
      accessMethodId,
    ) {
      const server = createServer((socket) => socket.pipe(socket));
      server.listen({
        host: "127.0.0.1",
        port: localPort ?? 0,
        exclusive: true,
      });
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
        accessMethod: {
          id: accessMethodId ?? "fixture-default",
          kind: accessMethodId === "fixture-bastion" ? "fixture:bastion" : "fixture:direct",
          mode: "tcp-forward",
        },
        session,
      };
    },
  };
}

async function findFreePort() {
  const server = createServer();
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForIntentState(client, name, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (await client.listEndpointIntents()).find(
      (intent) => intent.name === name,
    );
    if (status?.state === expected) {
      return status;
    }
    await delay(10);
  }
  assert.fail(`Endpoint intent ${name} did not reach ${expected}`);
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
          accessMethod: DEFAULT_ACCESS_METHOD,
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
              accessMethod: DEFAULT_ACCESS_METHOD,
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
    accessMethod: DEFAULT_ACCESS_METHOD,
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
          accessMethod: DEFAULT_ACCESS_METHOD,
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
        accessMethod: DEFAULT_ACCESS_METHOD,
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
          accessMethod: DEFAULT_ACCESS_METHOD,
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

test("daemon session creation preserves requested and actual local ports", async () => {
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const requestedLocalPort = await findFreePort();
    const fixed = await client.createSession({
      instanceId: "instance:fixed",
      remotePort: 8188,
      localPort: requestedLocalPort,
      accessMethodId: "fixture-bastion",
    });
    assert.equal(fixed.requestedLocalPort, requestedLocalPort);
    assert.equal(fixed.endpoint.port, requestedLocalPort);
    assert.equal(fixed.endpoint.host, "127.0.0.1");
    assert.deepEqual(fixed.accessMethod, {
      id: "fixture-bastion",
      kind: "fixture:bastion",
      mode: "tcp-forward",
    });

    const dynamic = await client.createSession({
      instanceId: "instance:dynamic",
      remotePort: 8188,
    });
    assert.equal(dynamic.requestedLocalPort, undefined);
    assert.deepEqual(dynamic.accessMethod, {
      id: "fixture-default",
      kind: "fixture:direct",
      mode: "tcp-forward",
    });
    assert.ok(dynamic.endpoint.port > 0);
    assert.deepEqual(await client.listSessions(), [fixed, dynamic]);
  } finally {
    await daemon.close().catch(() => undefined);
  }
});

test("concurrent retries with one idempotency key share a single session setup", async () => {
  const baseGateway = await createFakeGateway();
  let openCalls = 0;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let releaseOpen;
  const openGate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        openCalls += 1;
        markStarted();
        await openGate;
        return baseGateway.openEndpoint(...args);
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");
  const request = {
    instanceId: "instance:idempotent",
    remotePort: 8188,
    idempotencyKey: "retry-key",
  };

  try {
    const firstPromise = client.createSession(request);
    await started;
    const secondPromise = client.createSession(request);
    await delay(10);
    assert.equal(openCalls, 1);

    releaseOpen();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(first.id, second.id);
    assert.deepEqual(first.endpoint, second.endpoint);
    assert.equal(first.idempotencyKey, "retry-key");
    assert.deepEqual(await client.listSessions(), [first]);
    assert.equal(baseGateway.sessions.size, 1);
  } finally {
    releaseOpen();
    await daemon.close().catch(() => undefined);
  }
});

test("idempotency key conflicts on a different specification", async () => {
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const created = await client.createSession({
      instanceId: "instance:idempotent",
      remotePort: 8188,
      idempotencyKey: "stable-key",
    });

    await assert.rejects(
      client.createSession({
        instanceId: "instance:idempotent",
        remotePort: 22,
        idempotencyKey: "stable-key",
      }),
      (error) => error?.code === "conflict",
    );
    assert.deepEqual(await client.listSessions(), [created]);
    assert.equal(gateway.sessions.size, 1);
  } finally {
    await daemon.close().catch(() => undefined);
  }
});

test("distinct idempotency keys allow duplicate targets and closed keys can be reused", async () => {
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");
  const target = { instanceId: "instance:same-target", remotePort: 8188 };

  try {
    const first = await client.createSession({
      ...target,
      idempotencyKey: "first-key",
    });
    const second = await client.createSession({
      ...target,
      idempotencyKey: "second-key",
    });
    assert.notEqual(first.id, second.id);
    assert.notDeepEqual(first.endpoint, second.endpoint);
    assert.equal(gateway.sessions.size, 2);

    await client.closeSession(first.id);
    const reused = await client.createSession({
      instanceId: "instance:changed-after-close",
      remotePort: 22,
      idempotencyKey: "first-key",
    });
    assert.notEqual(reused.id, first.id);
    assert.equal(reused.idempotencyKey, "first-key");
    assert.equal(gateway.sessions.size, 2);
  } finally {
    await daemon.close().catch(() => undefined);
  }
});

test("persisted Endpoint intent is rebuilt after daemon restart without reviving the old transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-restart-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  const localPort = await findFreePort();
  const intent = {
    name: "persisted",
    enabled: true,
    instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    localPort,
    accessMethodId: "fixture-bastion",
  };
  await store.write({ version: 1, plugins: [], endpointIntents: [intent] });

  const firstGateway = await createFakeGateway();
  const firstDaemon = await startLocalConnectionDaemon({
    gateway: firstGateway,
    authToken: "first-token",
    stateStore: store,
  });
  const firstClient = new LocalDaemonClient(firstDaemon.address, "first-token");
  let secondDaemon;

  try {
    const first = await waitForIntentState(firstClient, "persisted", "live");
    assert.equal(first.endpoint.port, localPort);
    assert.equal(firstGateway.sessions.size, 1);
    assert.deepEqual(await firstClient.listSessions(), []);

    await firstDaemon.close();
    await expectConnectionRefused(first.endpoint);
    assert.equal(firstGateway.sessions.size, 0);
    assert.deepEqual((await store.read()).endpointIntents, [intent]);

    const secondGateway = await createFakeGateway();
    secondDaemon = await startLocalConnectionDaemon({
      gateway: secondGateway,
      authToken: "second-token",
      stateStore: store,
    });
    const secondClient = new LocalDaemonClient(secondDaemon.address, "second-token");
    const restored = await waitForIntentState(secondClient, "persisted", "live");
    assert.equal(restored.endpoint.port, localPort);
    assert.equal(secondGateway.sessions.size, 1);
    assert.deepEqual(await secondClient.listSessions(), []);
  } finally {
    await secondDaemon?.close().catch(() => undefined);
    await firstDaemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed Endpoint intent restoration is actionable and can recover on retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-retry-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({
    version: 1,
    plugins: [],
    endpointIntents: [
      {
        name: "recoverable",
        enabled: true,
        instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
        remoteHost: "127.0.0.1",
        remotePort: 8188,
        accessMethodId: "blocked-method",
      },
      {
        name: "healthy-sibling",
        enabled: true,
        instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
        remoteHost: "127.0.0.1",
        remotePort: 8188,
      },
    ],
  });
  const baseGateway = await createFakeGateway();
  let blocked = true;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        if (blocked && args[5] === "blocked-method") {
          throw normalizedConnectionError(
            "conflict",
            "wording intentionally changed",
            "local-bind-conflict",
          );
        }
        return baseGateway.openEndpoint(...args);
      },
    },
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const failed = await waitForIntentState(client, "recoverable", "error");
    assert.deepEqual(failed.failure, {
      code: "conflict",
      message: "wording intentionally changed",
      connectionCause: "local-bind-conflict",
    });
    assert.equal("endpoint" in failed, false);
    const sibling = await waitForIntentState(client, "healthy-sibling", "live");
    assert.ok(sibling.endpoint.port > 0);
    assert.equal(baseGateway.sessions.size, 1);

    blocked = false;
    const retrying = await client.retryEndpointIntent("recoverable");
    assert.equal(retrying.state, "starting");
    const recovered = await waitForIntentState(client, "recoverable", "live");
    assert.equal(baseGateway.sessions.size, 2);
    assert.ok(recovered.endpoint.port > 0);
  } finally {
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Endpoint intent host-trust failure preserves structured evidence and recovers on retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-host-trust-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  const baseGateway = await createFakeGateway();
  let trusted = false;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        if (!trusted) {
          throw hostTrustRequiredError(
            "ssh.example.test",
            2222,
            "ssh-ed25519",
            "SHA256:fixture",
          );
        }
        return baseGateway.openEndpoint(...args);
      },
    },
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await client.createEndpointIntent({
      name: "ssh-trust",
      instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
      remotePort: 8188,
    });
    const failed = await waitForIntentState(client, "ssh-trust", "error");
    assert.deepEqual(failed.failure, {
      code: "host-trust-required",
      message:
        "SSH host trust required for ssh.example.test:2222; fingerprint SHA256:fixture",
      hostTrust: {
        target: { host: "ssh.example.test", port: 2222 },
        key: { type: "ssh-ed25519", fingerprint: "SHA256:fixture" },
      },
    });

    trusted = true;
    const retrying = await client.retryEndpointIntent("ssh-trust");
    assert.equal(retrying.state, "starting");
    const recovered = await waitForIntentState(client, "ssh-trust", "live");
    assert.ok(recovered.endpoint.port > 0);
  } finally {
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabling and removing an Endpoint intent changes desired state without touching unrelated state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-remove-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({
    version: 1,
    plugins: [{ source: "unrelated", enabled: false }],
  });
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await client.createEndpointIntent({
      name: "toggle",
      instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
      remotePort: 8188,
    });
    const live = await waitForIntentState(client, "toggle", "live");
    const endpoint = live.endpoint;
    const alreadyEnabled = await client.setEndpointIntentEnabled("toggle", true);
    assert.equal(alreadyEnabled.state, "live");
    assert.equal(gateway.sessions.size, 1);

    const disabled = await client.setEndpointIntentEnabled("toggle", false);
    assert.equal(disabled.state, "disabled");
    await expectConnectionRefused(endpoint);
    assert.equal((await store.read()).endpointIntents[0].enabled, false);

    await client.setEndpointIntentEnabled("toggle", true);
    const restored = await waitForIntentState(client, "toggle", "live");
    await client.removeEndpointIntent("toggle");
    await expectConnectionRefused(restored.endpoint);

    const state = await store.read();
    assert.deepEqual(state.plugins, [{ source: "unrelated", enabled: false }]);
    assert.equal(state.endpointIntents, undefined);
    assert.deepEqual(await client.listEndpointIntents(), []);
  } finally {
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabling an intent while realization is pending closes a late transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-late-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({ version: 1, plugins: [] });
  const baseGateway = await createFakeGateway();
  let releaseOpen;
  const gate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  let openStarted;
  const started = new Promise((resolve) => {
    openStarted = resolve;
  });
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        openStarted();
        await gate;
        return baseGateway.openEndpoint(...args);
      },
    },
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const created = await client.createEndpointIntent({
      name: "late",
      instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
      remotePort: 8188,
    });
    assert.equal(created.state, "starting");
    await started;
    let disableSettled = false;
    const disabling = client.setEndpointIntentEnabled("late", false).then((status) => {
      disableSettled = true;
      return status;
    });
    await delay(50);
    assert.equal(disableSettled, false);

    releaseOpen();
    const disabled = await disabling;
    assert.equal(disabled.state, "disabled");
    assert.equal(baseGateway.sessions.size, 0);
    assert.equal((await client.listEndpointIntents())[0].state, "disabled");
  } finally {
    releaseOpen();
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("removed intent cleanup can be retried after a close failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-remove-retry-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({ version: 1, plugins: [] });
  const baseGateway = await createFakeGateway();
  let failClose = true;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        const opened = await baseGateway.openEndpoint(...args);
        const close = opened.session.close.bind(opened.session);
        opened.session.close = async () => {
          if (failClose) {
            failClose = false;
            throw new Error("fixture cleanup failure");
          }
          return close();
        };
        return opened;
      },
    },
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await client.createEndpointIntent({
      name: "cleanup",
      instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
      remotePort: 8188,
    });
    const live = await waitForIntentState(client, "cleanup", "live");

    await assert.rejects(client.removeEndpointIntent("cleanup"), /fixture cleanup failure/);
    assert.equal((await store.read()).endpointIntents, undefined);
    assert.deepEqual(await client.listEndpointIntents(), []);
    assert.equal(baseGateway.sessions.size, 1);

    await assert.rejects(
      client.createEndpointIntent({
        name: "cleanup",
        instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
        remotePort: 22,
      }),
      (error) => error?.code === "conflict" && /awaiting cleanup/.test(error.message),
    );

    await client.removeEndpointIntent("cleanup");
    assert.equal(baseGateway.sessions.size, 0);
    await expectConnectionRefused(live.endpoint);

    const reused = await client.createEndpointIntent({
      name: "cleanup",
      instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
      remotePort: 22,
    });
    assert.equal(reused.state, "starting");
    await waitForIntentState(client, "cleanup", "live");
  } finally {
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon close waits for late intent realization cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-close-wait-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({ version: 1, plugins: [] });
  const baseGateway = await createFakeGateway();
  let releaseOpen;
  const gate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  let openStarted;
  const started = new Promise((resolve) => {
    openStarted = resolve;
  });
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        openStarted();
        await gate;
        return baseGateway.openEndpoint(...args);
      },
    },
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await client.createEndpointIntent({
      name: "late-close",
      instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
      remotePort: 8188,
    });
    await started;

    let settled = false;
    const closing = daemon.close().then(() => {
      settled = true;
    });
    await delay(50);
    assert.equal(settled, false);

    releaseOpen();
    await closing;
    assert.equal(baseGateway.sessions.size, 0);
  } finally {
    releaseOpen();
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("instance connection drain blocks new target connections and preserves unrelated instances", async () => {
  const targetInstance = "instance:550e8400-e29b-41d4-a716-446655440000";
  const siblingInstance = "instance:550e8400-e29b-41d4-a716-446655440001";
  const directory = await mkdtemp(join(tmpdir(), "easyserver-instance-drain-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({ version: 1, plugins: [] });
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const targetSession = await client.createSession({
      instanceId: targetInstance,
      remotePort: 8188,
    });
    const sibling = await client.createSession({
      instanceId: siblingInstance,
      remotePort: 8188,
    });
    await client.createEndpointIntent({
      name: "target-intent",
      instanceId: targetInstance,
      remotePort: 8188,
    });
    await waitForIntentState(client, "target-intent", "live");

    const drain = await client.beginInstanceConnectionDrain(targetInstance);
    assert.deepEqual(drain.sessionIds, [targetSession.id]);
    assert.deepEqual(drain.endpointIntentNames, ["target-intent"]);
    assert.equal(drain.pendingCleanupCount, 0);

    await assert.rejects(
      client.createSession({ instanceId: targetInstance, remotePort: 22 }),
      (error) => error?.code === "conflict" && /being drained/.test(error.message),
    );
    await assert.rejects(
      client.createEndpointIntent({
        name: "blocked-intent",
        instanceId: targetInstance,
        remotePort: 22,
      }),
      (error) => error?.code === "conflict" && /being drained/.test(error.message),
    );

    const unrelated = await client.createSession({
      instanceId: siblingInstance,
      remotePort: 22,
    });
    assert.notEqual(unrelated.id, sibling.id);

    await client.releaseInstanceConnectionDrain(drain.token);
    const allowedAgain = await client.createSession({
      instanceId: targetInstance,
      remotePort: 22,
    });
    assert.equal(allowedAgain.instanceId, targetInstance);
  } finally {
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("instance connection drain closes a late setup before publication", async () => {
  const baseGateway = await createFakeGateway();
  let releaseOpen;
  const gate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  let openStarted;
  const started = new Promise((resolve) => {
    openStarted = resolve;
  });
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint(...args) {
        if (args[0] === "instance:target") {
          openStarted();
          await gate;
        }
        return baseGateway.openEndpoint(...args);
      },
    },
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const creating = client.createSession({
      instanceId: "instance:target",
      remotePort: 8188,
    });
    const creatingRejected = assert.rejects(
      creating,
      (error) => error?.code === "conflict" && /began draining/.test(error.message),
    );
    await started;
    const draining = client.beginInstanceConnectionDrain("instance:target");
    await delay(50);
    releaseOpen();
    const drain = await draining;
    assert.equal(drain.pendingCleanupCount, 0);

    await creatingRejected;
    assert.equal(
      (await client.listSessions()).some(
        (session) => session.instanceId === "instance:target",
      ),
      false,
    );
    assert.equal(baseGateway.sessions.size, 0);
    await client.releaseInstanceConnectionDrain(drain.token);
  } finally {
    releaseOpen();
    await daemon.close().catch(() => undefined);
  }
});

test("connection drain retains failed cleanup from an intent create racing the drain", async () => {
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-drain-race-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({ version: 1, plugins: [] });

  let releaseUpdate;
  const updateGate = new Promise((resolve) => {
    releaseUpdate = resolve;
  });
  let updateStarted;
  const updateStartedPromise = new Promise((resolve) => {
    updateStarted = resolve;
  });
  let blockFirstUpdate = true;
  const gatedStore = {
    read: (...args) => store.read(...args),
    update: async (...args) => {
      if (blockFirstUpdate) {
        blockFirstUpdate = false;
        updateStarted();
        await updateGate;
      }
      return store.update(...args);
    },
  };

  let closeCalls = 0;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        return {
          endpoint: { host: "127.0.0.1", port: 54321 },
          accessMethod: DEFAULT_ACCESS_METHOD,
          session: {
            closed: new Promise(() => {}),
            async close() {
              closeCalls += 1;
              throw new Error("fixture cleanup failure");
            },
          },
        };
      },
    },
    authToken: "fixture-token",
    stateStore: gatedStore,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    const creating = client.createEndpointIntent({
      name: "racy-intent",
      instanceId,
      remotePort: 8188,
    });
    const creatingRejected = assert.rejects(creating);
    await updateStartedPromise;

    const draining = client.beginInstanceConnectionDrain(instanceId);
    releaseUpdate();
    const drain = await draining;

    await creatingRejected;
    assert.deepEqual(drain.endpointIntentNames, ["racy-intent"]);
    assert.ok(closeCalls >= 1);
    await assert.rejects(
      client.closeInstanceConnectionsForDrain(drain.token),
      (error) =>
        error?.code === "conflict" && /cleanup remains/.test(error.message),
    );
    assert.ok(closeCalls >= 2);
    await client.releaseInstanceConnectionDrain(drain.token);
  } finally {
    releaseUpdate();
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection drain waits for an in-flight intent removal and retains failed cleanup", async () => {
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  const directory = await mkdtemp(join(tmpdir(), "easyserver-intent-remove-drain-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({ version: 1, plugins: [] });

  let closeStarted;
  const closeStartedPromise = new Promise((resolve) => {
    closeStarted = resolve;
  });
  let releaseFirstClose;
  const firstCloseGate = new Promise((resolve) => {
    releaseFirstClose = resolve;
  });
  let closeCalls = 0;
  const daemon = await startLocalConnectionDaemon({
    gateway: {
      async openEndpoint() {
        return {
          endpoint: { host: "127.0.0.1", port: 54321 },
          accessMethod: DEFAULT_ACCESS_METHOD,
          session: {
            closed: new Promise(() => {}),
            async close() {
              closeCalls += 1;
              if (closeCalls === 1) {
                closeStarted();
                await firstCloseGate;
                throw new Error("fixture first cleanup failure");
              }
            },
          },
        };
      },
    },
    authToken: "fixture-token",
    stateStore: store,
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await client.createEndpointIntent({
      name: "remove-race",
      instanceId,
      remotePort: 8188,
    });
    await waitForIntentState(client, "remove-race", "live");

    const removing = client.removeEndpointIntent("remove-race");
    const removingRejected = assert.rejects(removing);
    await closeStartedPromise;

    let drainSettled = false;
    const draining = client.beginInstanceConnectionDrain(instanceId).then((drain) => {
      drainSettled = true;
      return drain;
    });
    await delay(50);
    assert.equal(drainSettled, false);

    releaseFirstClose();
    await removingRejected;
    const drain = await draining;
    assert.deepEqual(drain.endpointIntentNames, ["remove-race"]);

    await client.closeInstanceConnectionsForDrain(drain.token);
    assert.equal(closeCalls, 2);
    await client.releaseInstanceConnectionDrain(drain.token);
  } finally {
    releaseFirstClose();
    await daemon.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated daemon shutdown reports affected live sessions to its owner", async () => {
  const gateway = await createFakeGateway();
  const daemon = await startLocalConnectionDaemon({
    gateway,
    authToken: "fixture-token",
  });
  const client = new LocalDaemonClient(daemon.address, "fixture-token");

  try {
    await client.createSession({
      instanceId: "instance:fixture",
      remotePort: 8188,
    });
    const summary = await client.requestShutdown();
    assert.deepEqual(summary, {
      liveSessions: 1,
      activeEndpointIntents: 0,
    });
    assert.deepEqual(await daemon.shutdownRequested, summary);

    await daemon.close();
    assert.equal(gateway.sessions.size, 0);
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
