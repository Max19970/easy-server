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
} from "@easyai101/easyserver-plugin-sdk";
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

test("daemon preserves typed SSH host-trust-required results without enrolling trust", async () => {
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
      client.createSession({
        instanceId: "instance:fixture",
        remotePort: 8188,
      }),
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
