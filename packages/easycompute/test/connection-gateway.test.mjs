import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, Server } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccessAdapterRegistry } from "../dist/access-adapter-registry.js";
import { ConnectionGateway } from "../dist/connection-gateway.js";
import { HostOperationRunner } from "../dist/host-operation.js";
import { PluginHost } from "../dist/plugin-host.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { JsonStateStore } from "../dist/state-store.js";

const INSTANCE_ID = "instance:550e8400-e29b-41d4-a716-446655440000";

function operationContext() {
  return { signal: new AbortController().signal };
}

async function withState(run) {
  const directory = await mkdtemp(join(tmpdir(), "easycompute-gateway-"));
  const store = new JsonStateStore(join(directory, "state.json"));

  try {
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

function registerProvider(
  registry,
  {
    getAccessMethods = async () => [
      { id: "loopback", kind: "loopback", mode: "tcp-forward" },
    ],
    accessAdapters = [],
    resolveAccessCredential,
    onRelease = () => {},
  } = {},
) {
  const provider = {
    providerId: "fake",
    async listInstances() {
      return [];
    },
    async getInstance() {
      return undefined;
    },
    getAccessMethods,
    ...(resolveAccessCredential === undefined ? {} : { resolveAccessCredential }),
  };

  registry.register("fake", "fake.plugin", () => ({
    pluginId: "fake.plugin",
    provider,
    capabilities: [],
    accessAdapters,
    release() {
      onRelease();
    },
  }));
}

function loopbackAdapter({
  failSetup = false,
  failChannel = false,
  failFirstChannelStream = false,
  failChannelClose = false,
  onSetupCleanup,
  onTransportClose = () => {},
} = {}) {
  let channelCount = 0;
  return {
    kind: "loopback",
    async openTcpForward(_method, _providerExternalId, target, setupContext) {
      if (onSetupCleanup !== undefined) {
        setupContext.registerCleanup(onSetupCleanup);
      }
      if (failSetup) {
        throw new Error("fixture setup failure");
      }

      return {
        async openChannel() {
          if (failChannel) {
            throw new Error("fixture upstream failure");
          }

          channelCount += 1;
          const stream = connect({ host: target.host, port: target.port });
          await once(stream, "connect");
          if (failFirstChannelStream && channelCount === 1) {
            stream.once("data", () => {
              setImmediate(() =>
                stream.destroy(new Error("fixture channel stream failure")),
              );
            });
          }
          return {
            stream,
            async close() {
              stream.destroy();
              if (failChannelClose) {
                throw new Error("fixture channel cleanup failure");
              }
            },
          };
        },
        async close() {
          onTransportClose();
        },
      };
    },
  };
}

async function startEchoServer() {
  const server = createServer((socket) => socket.pipe(socket));
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
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

async function settlesWithin(promise, timeoutMs = 100) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("local Endpoint forwards TCP bytes and close releases listener and admission", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(loopbackAdapter());

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );

    assert.equal(result.endpoint.host, "127.0.0.1");
    assert.equal(releases, 0);
    assert.equal(await roundTrip(result.endpoint, "hello"), "hello");
    assert.equal(releases, 0);

    await result.session.close();
    await result.session.closed;
    assert.equal(releases, 1);
    await expectConnectionRefused(result.endpoint);
    await echo.close();
  });
});

test("setup failure cleans setup-owned resources and provider admission", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    let setupCleanups = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(
      loopbackAdapter({
        failSetup: true,
        onSetupCleanup: () => {
          setupCleanups += 1;
        },
      }),
    );

    await assert.rejects(
      new ConnectionGateway(providers, access, store).openEndpoint(
        INSTANCE_ID,
        12345,
        operationContext(),
      ),
      /fixture setup failure/,
    );
    assert.equal(setupCleanups, 1);
    assert.equal(releases, 1);
  });
});

test("local listen collision before Endpoint publication cleans setup resources", async (t) => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    let setupCleanups = 0;
    let transportCloses = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(
      loopbackAdapter({
        onSetupCleanup: () => {
          setupCleanups += 1;
        },
        onTransportClose: () => {
          transportCloses += 1;
        },
      }),
    );

    t.mock.method(Server.prototype, "listen", function () {
      const error = Object.assign(new Error("fixture local port collision"), {
        code: "EADDRINUSE",
      });
      queueMicrotask(() => this.emit("error", error));
      return this;
    });

    await assert.rejects(
      new ConnectionGateway(providers, access, store).openEndpoint(
        INSTANCE_ID,
        12345,
        operationContext(),
      ),
      (error) => error?.code === "EADDRINUSE",
    );
    assert.equal(setupCleanups, 1);
    assert.equal(transportCloses, 1);
    assert.equal(releases, 1);
  });
});

test("host deadline cancels connection setup and releases setup-owned resources", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    let setupCleanups = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward(_method, _providerExternalId, _target, setupContext) {
        setupContext.registerCleanup(() => {
          setupCleanups += 1;
        });
        await new Promise(() => {});
      },
    });

    await assert.rejects(
      new ConnectionGateway(
        providers,
        access,
        store,
        undefined,
        new HostOperationRunner(20),
      ).openEndpoint(INSTANCE_ID, 12345, operationContext()),
      (error) => error?.code === "timeout",
    );
    assert.equal(setupCleanups, 1);
    assert.equal(releases, 1);
  });
});

test("late transport returned after setup timeout is closed when it eventually resolves", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    let setupCleanups = 0;
    let transportCloses = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward(_method, _providerExternalId, _target, setupContext) {
        setupContext.registerCleanup(() => {
          setupCleanups += 1;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          async openChannel() {
            throw new Error("late transport must never publish an Endpoint");
          },
          async close() {
            transportCloses += 1;
          },
        };
      },
    });

    await assert.rejects(
      new ConnectionGateway(
        providers,
        access,
        store,
        undefined,
        new HostOperationRunner(10),
      ).openEndpoint(INSTANCE_ID, 12345, operationContext()),
      (error) => error?.code === "timeout",
    );

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(setupCleanups, 1);
    assert.equal(transportCloses, 1);
    assert.equal(releases, 1);
  });
});

test("selected Access Method can resolve only its declared secret references", async () => {
  await withState(async (store) => {
    const declaredRef = "secret:550e8400-e29b-41d4-a716-446655440000";
    const otherRef = "secret:11111111-1111-4111-8111-111111111111";
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let secretReads = 0;
    registerProvider(providers, {
      getAccessMethods: async () => [
        {
          id: "guarded",
          kind: "guarded",
          mode: "tcp-forward",
          credentialSources: [{ kind: "secret-ref", secretRef: declaredRef }],
        },
      ],
    });
    access.registerBuiltIn({
      kind: "guarded",
      async openTcpForward(_method, _providerExternalId, _target, setupContext) {
        await assert.rejects(
          setupContext.resolveSecret(otherRef),
          (error) => error.code === "authentication" && /not declared/.test(error.message),
        );
        assert.equal(await setupContext.resolveSecret(declaredRef), "fixture-secret");
        return {
          async openChannel() {
            throw new Error("not used");
          },
          async close() {},
        };
      },
    });
    const secrets = {
      async get(ref) {
        secretReads += 1;
        assert.equal(ref, declaredRef);
        return "fixture-secret";
      },
    };

    const result = await new ConnectionGateway(
      providers,
      access,
      store,
      secrets,
    ).openEndpoint(INSTANCE_ID, 12345, operationContext());
    assert.equal(secretReads, 1);
    await result.session.close();
  });
});

test("selected Access Method resolves only its declared provider-deferred credentials", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let providerCredentialReads = 0;
    registerProvider(providers, {
      getAccessMethods: async () => [
        {
          id: "deferred",
          kind: "deferred",
          mode: "tcp-forward",
          credentialSources: [
            { kind: "provider-deferred", id: "session-password" },
          ],
        },
      ],
      async resolveAccessCredential(providerExternalId, id) {
        providerCredentialReads += 1;
        assert.equal(providerExternalId, "remote-1");
        assert.equal(id, "session-password");
        return "fixture-provider-password";
      },
    });
    access.registerBuiltIn({
      kind: "deferred",
      async openTcpForward(_method, _providerExternalId, _target, setupContext) {
        await assert.rejects(
          setupContext.resolveCredential("undeclared"),
          (error) =>
            error.code === "authentication" && /not declared/.test(error.message),
        );
        assert.equal(
          await setupContext.resolveCredential("session-password"),
          "fixture-provider-password",
        );
        return {
          async openChannel() {
            throw new Error("not used");
          },
          async close() {},
        };
      },
    });

    const result = await new ConnectionGateway(
      providers,
      access,
      store,
    ).openEndpoint(INSTANCE_ID, 12345, operationContext());
    assert.equal(providerCredentialReads, 1);
    await result.session.close();
  });
});

test("setup admitted before disable may finish, but new setup cannot start afterward", async () => {
  await withState(async (store) => {
    let enteredResolve;
    let continueResolve;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const continueSetup = new Promise((resolve) => (continueResolve = resolve));
    const pluginAdapter = { ...loopbackAdapter(), kind: "fake:loopback" };
    const plugin = {
      manifest: {
        id: "fake.plugin",
        displayName: "Fake Plugin",
        version: "1.0.0",
        compatibility: { easycompute: "^0.1.0", pluginSdk: "^0.1.0" },
        provider: {
          id: "fake",
          displayName: "Fake Provider",
          capabilities: [],
        },
      },
      provider: {
        providerId: "fake",
        async listInstances() {
          return [];
        },
        async getInstance() {
          return undefined;
        },
        async getAccessMethods() {
          enteredResolve();
          await continueSetup;
          return [
            { id: "loopback", kind: "fake:loopback", mode: "tcp-forward" },
          ];
        },
      },
      accessAdapters: [pluginAdapter],
    };
    const providers = new ProviderRegistry();
    const host = new PluginHost(providers, async () => plugin);
    await host.load(["fake"]);
    const gateway = new ConnectionGateway(
      providers,
      new AccessAdapterRegistry(),
      store,
    );
    const echo = await startEchoServer();

    const opening = gateway.openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );
    await entered;
    assert.equal(host.disable("fake.plugin"), true);
    continueResolve();

    const admitted = await opening;
    assert.equal(await roundTrip(admitted.endpoint, "admitted"), "admitted");
    await assert.rejects(
      gateway.openEndpoint(INSTANCE_ID, echo.port, operationContext()),
      (error) => error.code === "provider-unavailable",
    );

    await admitted.session.close();
    await echo.close();
  });
});

test("upstream channel failure tears down the published Endpoint", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);
    access.registerBuiltIn(loopbackAdapter({ failChannel: true }));
    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      12345,
      operationContext(),
    );

    const socket = connect(result.endpoint);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    await once(socket, "close");
    await result.session.closed;
    await expectConnectionRefused(result.endpoint);
  });
});

test("client channel stream failure does not tear down the persistent Endpoint", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);
    access.registerBuiltIn(loopbackAdapter({ failFirstChannelStream: true }));
    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );

    try {
      assert.equal(await roundTrip(result.endpoint, "first"), "first");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await roundTrip(result.endpoint, "second"), "second");
    } finally {
      await result.session.close().catch(() => undefined);
      await echo.close();
    }

    await expectConnectionRefused(result.endpoint);
  });
});

test("close does not wait forever for a pending channel open", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);

    let enteredResolve;
    let releaseChannel;
    let transportCloses = 0;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const channel = new Promise((resolve) => (releaseChannel = resolve));
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward() {
        return {
          async openChannel() {
            enteredResolve();
            return channel;
          },
          async close() {
            transportCloses += 1;
            releaseChannel({
              stream: new PassThrough(),
              async close() {},
            });
          },
        };
      },
    });

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      12345,
      operationContext(),
    );
    const socket = connect(result.endpoint);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    await entered;

    const closing = result.session.close();
    const settled = await settlesWithin(closing);
    if (!settled) {
      releaseChannel({
        stream: new PassThrough(),
        async close() {},
      });
    }
    await closing;
    socket.destroy();

    assert.equal(settled, true);
    assert.equal(transportCloses, 1);
  });
});

test("client disconnect aborts its pending channel open without closing the session", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);

    let openCalls = 0;
    let pendingOpens = 0;
    let abortedOpens = 0;
    let enteredResolve;
    let abortedResolve;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const aborted = new Promise((resolve) => (abortedResolve = resolve));
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward(_method, _providerExternalId, target) {
        return {
          async openChannel({ signal }) {
            openCalls += 1;
            if (openCalls === 1) {
              pendingOpens += 1;
              enteredResolve();
              return new Promise((resolve, reject) => {
                const onAbort = () => {
                  pendingOpens -= 1;
                  abortedOpens += 1;
                  abortedResolve();
                  reject(new Error("fixture client-local channel open aborted"));
                };
                if (signal.aborted) {
                  onAbort();
                } else {
                  signal.addEventListener("abort", onAbort, { once: true });
                }
              });
            }

            const stream = connect({ host: target.host, port: target.port });
            await once(stream, "connect");
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
    });

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );
    const first = connect(result.endpoint);
    first.on("error", () => undefined);

    try {
      await once(first, "connect");
      await entered;
      first.destroy();
      await once(first, "close");

      assert.equal(await settlesWithin(aborted), true);
      assert.equal(pendingOpens, 0);
      assert.equal(abortedOpens, 1);
      assert.equal(await roundTrip(result.endpoint, "second"), "second");
    } finally {
      first.destroy();
      await result.session.close().catch(() => undefined);
      await echo.close();
    }
  });
});

test("client disconnect during pending channel open closes the late channel", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);

    let enteredResolve;
    let releaseChannel;
    let channelCloses = 0;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const channel = new Promise((resolve) => (releaseChannel = resolve));
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward() {
        return {
          async openChannel() {
            enteredResolve();
            return channel;
          },
          async close() {},
        };
      },
    });

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      12345,
      operationContext(),
    );
    const socket = connect(result.endpoint);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    await entered;
    socket.destroy();
    await once(socket, "close");

    releaseChannel({
      stream: new PassThrough(),
      async close() {
        channelCloses += 1;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(channelCloses, 1);
    await result.session.close();
  });
});

test("late channel cleanup failure remains observable after bounded close settles", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);

    let enteredResolve;
    let releaseChannel;
    let channelCloses = 0;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const channel = new Promise((resolve) => (releaseChannel = resolve));
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward() {
        return {
          async openChannel() {
            enteredResolve();
            return channel;
          },
          async close() {},
        };
      },
    });

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      12345,
      operationContext(),
    );
    const socket = connect(result.endpoint);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    await entered;

    const closing = result.session.close();
    assert.equal(await settlesWithin(closing), true);
    await closing;

    releaseChannel({
      stream: new PassThrough(),
      close() {
        channelCloses += 1;
        throw new Error("fixture late channel cleanup failure");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(channelCloses, 1);
    await assert.rejects(
      result.session.close(),
      /fixture late channel cleanup failure/,
    );
    socket.destroy();
  });
});

test("public openEndpoint contract accepts default and third-argument remoteHost", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);
    access.registerBuiltIn(loopbackAdapter());
    const gateway = new ConnectionGateway(providers, access, store);

    const defaultResult = await gateway.openEndpoint(INSTANCE_ID, echo.port);
    assert.equal(
      await roundTrip(defaultResult.endpoint, "public-default"),
      "public-default",
    );
    await defaultResult.session.close();

    const hostResult = await gateway.openEndpoint(
      INSTANCE_ID,
      echo.port,
      "127.0.0.1",
    );
    assert.equal(await roundTrip(hostResult.endpoint, "public-host"), "public-host");
    await hostResult.session.close();
    await echo.close();
  });
});

test("trailing OperationContext keeps cooperative cancellation available", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    registerProvider(providers);
    access.registerBuiltIn(loopbackAdapter());
    const controller = new AbortController();

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      echo.port,
      "127.0.0.1",
      { signal: controller.signal },
    );
    controller.abort();
    await result.session.close();
    await expectConnectionRefused(result.endpoint);
    await echo.close();
  });
});

test("setup cleanup failure is observable alongside the primary setup failure", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(
      loopbackAdapter({
        failSetup: true,
        onSetupCleanup() {
          throw new Error("fixture setup cleanup failure");
        },
      }),
    );

    let thrown;
    try {
      await new ConnectionGateway(providers, access, store).openEndpoint(
        INSTANCE_ID,
        12345,
        operationContext(),
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AggregateError);
    assert.match(thrown.errors[0].message, /fixture setup failure/);
    assert.match(thrown.errors[1].message, /fixture setup cleanup failure/);
    assert.equal(releases, 1);
  });
});

test("session close surfaces channel cleanup failure while releasing other resources", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    let transportCloses = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(
      loopbackAdapter({
        failChannelClose: true,
        onTransportClose: () => (transportCloses += 1),
      }),
    );

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );
    const socket = connect(result.endpoint);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const received = new Promise((resolve) => socket.once("data", resolve));
    socket.write("active");
    assert.equal((await received).toString(), "active");

    await assert.rejects(result.session.close(), /fixture channel cleanup failure/);
    assert.equal(transportCloses, 1);
    assert.equal(releases, 1);
    await expectConnectionRefused(result.endpoint);
    socket.destroy();
    await echo.close();
  });
});

test("session close normalizes synchronous channel cleanup failure and still tears down scope", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    let transportCloses = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn({
      kind: "loopback",
      async openTcpForward(_method, _providerExternalId, target) {
        return {
          async openChannel() {
            const stream = connect({ host: target.host, port: target.port });
            await once(stream, "connect");
            return {
              stream,
              close() {
                stream.destroy();
                throw new Error("fixture synchronous channel cleanup failure");
              },
            };
          },
          async close() {
            transportCloses += 1;
          },
        };
      },
    });

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );
    const socket = connect(result.endpoint);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const received = new Promise((resolve) => socket.once("data", resolve));
    socket.write("active");
    assert.equal((await received).toString(), "active");

    await assert.rejects(
      result.session.close(),
      /fixture synchronous channel cleanup failure/,
    );
    assert.equal(transportCloses, 1);
    assert.equal(releases, 1);
    await expectConnectionRefused(result.endpoint);
    socket.destroy();
    await echo.close();
  });
});

test("AbortSignal auto-close consumes cleanup rejection while explicit close stays observable", async () => {
  await withState(async (store) => {
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    const controller = new AbortController();
    let releases = 0;
    let transportCloses = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(
      loopbackAdapter({
        onTransportClose() {
          transportCloses += 1;
          throw new Error("fixture transport cleanup failure");
        },
      }),
    );

    const result = await new ConnectionGateway(providers, access, store).openEndpoint(
      INSTANCE_ID,
      12345,
      { signal: controller.signal },
    );

    controller.abort();
    await expectConnectionRefused(result.endpoint);
    await new Promise((resolve) => setImmediate(resolve));

    const explicitClose = result.session.close();
    assert.equal(result.session.close(), explicitClose);
    await assert.rejects(explicitClose, /fixture transport cleanup failure/);
    assert.equal(transportCloses, 1);
    assert.equal(releases, 1);
  });
});

test("two Connection Sessions keep independent lifecycle state", async () => {
  await withState(async (store) => {
    const echo = await startEchoServer();
    const providers = new ProviderRegistry();
    const access = new AccessAdapterRegistry();
    let releases = 0;
    registerProvider(providers, { onRelease: () => (releases += 1) });
    access.registerBuiltIn(loopbackAdapter());
    const gateway = new ConnectionGateway(providers, access, store);

    const first = await gateway.openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );
    const second = await gateway.openEndpoint(
      INSTANCE_ID,
      echo.port,
      operationContext(),
    );
    assert.notEqual(first.endpoint.port, second.endpoint.port);

    await first.session.close();
    assert.equal(releases, 1);
    await expectConnectionRefused(first.endpoint);
    assert.equal(await roundTrip(second.endpoint, "still-alive"), "still-alive");

    await second.session.close();
    assert.equal(releases, 2);
    await echo.close();
  });
});
