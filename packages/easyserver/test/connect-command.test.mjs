import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { hostTrustRequiredError } from "@easyai101/easyserver-plugin-sdk";
import { AccessAdapterRegistry } from "../dist/access-adapter-registry.js";
import { runForegroundConnect } from "../dist/connect-command.js";
import { ConnectionGateway } from "../dist/connection-gateway.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { JsonStateStore } from "../dist/state-store.js";

const INSTANCE_ID = "instance:550e8400-e29b-41d4-a716-446655440000";

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-connect-"));
  try {
    const store = new JsonStateStore(join(directory, "state.json"));
    await store.write({
      version: 1,
      plugins: [],
      instances: [
        {
          id: INSTANCE_ID,
          providerId: "fake",
          providerExternalId: "remote-1",
        },
      ],
    });
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

function endpointDeferred() {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });
  return { promise, resolve };
}

test("foreground connect exposes a reachable EasyServer endpoint until cancellation", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    let releases = 0;
    const echoAdapter = {
      kind: "fake:echo",
      async openTcpForward() {
        return {
          async openChannel() {
            const stream = new PassThrough();
            return {
              stream,
              async close() {
                stream.destroy();
              },
            };
          },
          async close() {},
        };
      },
    };
    const provider = {
      providerId: "fake",
      async listInstances() {
        return [];
      },
      async getInstance() {
        return undefined;
      },
      async getAccessMethods() {
        return [
          {
            id: "echo",
            kind: "fake:echo",
            mode: "tcp-forward",
          },
        ];
      },
    };
    registry.register("fake", "fake.plugin", () => ({
      pluginId: "fake.plugin",
      provider,
      capabilities: [],
      accessAdapters: [echoAdapter],
      release() {
        releases += 1;
      },
    }));

    const controller = new AbortController();
    const endpoint = endpointDeferred();
    const requestedLocalPort = await findFreePort();
    const running = runForegroundConnect({
      gateway: new ConnectionGateway(
        registry,
        new AccessAdapterRegistry([]),
        store,
      ),
      sshAdapter: {
        async enrollHostKey() {
          assert.fail("SSH trust should not be used for provider-specific echo");
        },
      },
      instanceId: INSTANCE_ID,
      remotePort: 8080,
      localPort: requestedLocalPort,
      context: { signal: controller.signal },
      onEndpoint: endpoint.resolve,
    });

    const published = await endpoint.promise;
    assert.deepEqual(published, {
      host: "127.0.0.1",
      port: requestedLocalPort,
    });
    const socket = connect(published);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const received = new Promise((resolve) => socket.once("data", resolve));
    socket.write("through-easyserver");
    assert.equal((await received).toString(), "through-easyserver");
    socket.destroy();

    controller.abort();
    await running;
    assert.equal(releases, 1);
  });
});

test("first-use SSH trust is never enrolled without explicit confirmation", async () => {
  const trust = hostTrustRequiredError(
    "ssh.example.test",
    2222,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  let opens = 0;
  let enrollments = 0;
  const gateway = {
    async openEndpoint() {
      opens += 1;
      throw trust;
    },
  };
  const sshAdapter = {
    async enrollHostKey() {
      enrollments += 1;
    },
  };

  await assert.rejects(
    runForegroundConnect({
      gateway,
      sshAdapter,
      instanceId: INSTANCE_ID,
      remotePort: 8080,
      context: { signal: new AbortController().signal },
      onEndpoint() {},
    }),
    (error) => error === trust,
  );
  assert.equal(opens, 1);
  assert.equal(enrollments, 0);
});

test("declined SSH trust never enrolls the host key", async () => {
  const trust = hostTrustRequiredError(
    "ssh.example.test",
    2222,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  let enrollments = 0;

  await assert.rejects(
    runForegroundConnect({
      gateway: {
        async openEndpoint() {
          throw trust;
        },
      },
      sshAdapter: {
        async enrollHostKey() {
          enrollments += 1;
        },
      },
      instanceId: INSTANCE_ID,
      remotePort: 8080,
      context: { signal: new AbortController().signal },
      async confirmHostTrust() {
        return false;
      },
      onEndpoint() {},
    }),
    (error) => error?.code === "cancelled" && /trust was declined/.test(error.message),
  );
  assert.equal(enrollments, 0);
});

test("explicit SSH trust confirmation enrolls the exact fingerprint and retries once", async () => {
  const trust = hostTrustRequiredError(
    "ssh.example.test",
    2222,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  let opens = 0;
  let enrolled;
  let confirmed;
  const gateway = {
    async openEndpoint() {
      opens += 1;
      if (opens === 1) {
        throw trust;
      }
      return {
        endpoint: { host: "127.0.0.1", port: 40000 },
        session: {
          closed: Promise.resolve(),
          async close() {},
        },
      };
    },
  };
  const sshAdapter = {
    async enrollHostKey(value) {
      enrolled = value;
    },
  };

  await runForegroundConnect({
    gateway,
    sshAdapter,
    instanceId: INSTANCE_ID,
    remotePort: 8080,
    context: { signal: new AbortController().signal },
    async confirmHostTrust(value) {
      confirmed = value;
      return true;
    },
    onEndpoint(endpoint) {
      assert.deepEqual(endpoint, { host: "127.0.0.1", port: 40000 });
    },
  });

  assert.equal(confirmed, trust);
  assert.equal(enrolled, trust);
  assert.equal(opens, 2);
});
