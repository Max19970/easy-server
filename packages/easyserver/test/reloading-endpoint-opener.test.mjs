import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReloadingEndpointOpener } from "../dist/reloading-endpoint-opener.js";
import { InMemorySecretStore } from "../dist/secret-store.js";
import { JsonStateStore } from "../dist/state-store.js";

const pluginSource = `data:text/javascript,${encodeURIComponent(`
export default {
  manifest: {
    id: "fixture.reloading-credential",
    displayName: "Reloading Credential Fixture",
    version: "1.0.0",
    compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
    credentials: [{ name: "api-key", required: true }],
    provider: {
      id: "reload-credential",
      displayName: "Reload Credential Provider",
      capabilities: [],
    },
  },
  provider: {
    providerId: "reload-credential",
    async listInstances() { return []; },
    async getInstance() { return undefined; },
    async getAccessMethods(_providerExternalId, context) {
      const credential = await context.resolveCredential("api-key");
      if (credential === undefined) throw new Error("credential missing");
      return [{ id: "fixture", kind: "reload-credential:loopback", mode: "tcp-forward" }];
    },
  },
  accessAdapters: [{
    kind: "reload-credential:loopback",
    async openTcpForward() {
      return {
        async openChannel() { throw new Error("channel not used by this test"); },
        async close() {},
      };
    },
  }],
};
`)}`;

class RecordingSecretStore {
  requested = [];

  constructor(inner) {
    this.inner = inner;
  }

  create(...args) {
    return this.inner.create(...args);
  }

  async get(ref, ...args) {
    this.requested.push(ref);
    return this.inner.get(ref, ...args);
  }

  delete(...args) {
    return this.inner.delete(...args);
  }
}

class InterleavingStateStore {
  afterNextRead;

  constructor(inner) {
    this.inner = inner;
  }

  async read() {
    const state = await this.inner.read();
    const afterRead = this.afterNextRead;
    this.afterNextRead = undefined;
    if (afterRead !== undefined) {
      await afterRead();
    }
    return state;
  }

  update(...args) {
    return this.inner.update(...args);
  }
}

test("completed plugin disable invalidates a stale cached generation before admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-runtime-reload-race-"));
  const realStore = new JsonStateStore(join(directory, "state.json"));
  const store = new InterleavingStateStore(realStore);
  const innerSecrets = new InMemorySecretStore();
  const secrets = new RecordingSecretStore(innerSecrets);
  const ref = await secrets.create("credential");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await realStore.write({
    version: 1,
    plugins: [
      {
        source: pluginSource,
        enabled: true,
        credentials: [{ name: "api-key", secretRef: ref }],
      },
    ],
    instances: [
      {
        id: instanceId,
        providerId: "reload-credential",
        providerExternalId: "remote-1",
        management: "managed",
      },
    ],
  });

  const opener = new ReloadingEndpointOpener(store, secrets);
  const existing = await opener.openEndpoint(
    instanceId,
    8188,
    "127.0.0.1",
    { signal: new AbortController().signal },
  );
  let existingClosed = false;
  void existing.session.closed.then(() => {
    existingClosed = true;
  });

  store.afterNextRead = () =>
    realStore.update((state) => ({
      ...state,
      plugins: state.plugins.map((plugin) => ({ ...plugin, enabled: false })),
    }));

  await assert.rejects(
    opener.openEndpoint(
      instanceId,
      8188,
      "127.0.0.1",
      { signal: new AbortController().signal },
    ),
    (error) => error?.code === "provider-unavailable",
  );
  assert.equal(existingClosed, false);

  await existing.session.close();
  await rm(directory, { recursive: true, force: true });
});

test("new endpoint setup reloads rotated credential references without closing an existing session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-runtime-reload-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  const innerSecrets = new InMemorySecretStore();
  const secrets = new RecordingSecretStore(innerSecrets);
  const oldRef = await secrets.create("old-secret");
  const newRef = await secrets.create("new-secret");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  const binding = {
    id: instanceId,
    providerId: "reload-credential",
    providerExternalId: "remote-1",
    management: "managed",
  };

  await store.write({
    version: 1,
    plugins: [
      {
        source: pluginSource,
        enabled: true,
        credentials: [{ name: "api-key", secretRef: oldRef }],
      },
    ],
    instances: [binding],
  });

  const opener = new ReloadingEndpointOpener(store, secrets);
  const first = await opener.openEndpoint(
    instanceId,
    8188,
    "127.0.0.1",
    { signal: new AbortController().signal },
  );
  let firstClosed = false;
  void first.session.closed.then(() => {
    firstClosed = true;
  });
  assert.equal(secrets.requested.at(-1), oldRef);

  await store.update((state) => ({
    ...state,
    plugins: state.plugins.map((plugin) => ({
      ...plugin,
      credentials: [{ name: "api-key", secretRef: newRef }],
    })),
  }));
  await secrets.delete(oldRef);

  const second = await opener.openEndpoint(
    instanceId,
    8188,
    "127.0.0.1",
    { signal: new AbortController().signal },
  );
  assert.equal(secrets.requested.at(-1), newRef);
  assert.equal(firstClosed, false);

  await store.update((state) => ({
    ...state,
    plugins: state.plugins.map((plugin) => ({ ...plugin, credentials: undefined })),
  }));
  await assert.rejects(
    opener.openEndpoint(
      instanceId,
      8188,
      "127.0.0.1",
      { signal: new AbortController().signal },
    ),
    /credential missing/,
  );
  assert.notEqual(secrets.requested.at(-1), oldRef);
  assert.equal(firstClosed, false);

  await store.update((state) => ({
    ...state,
    plugins: state.plugins.map((plugin) => ({
      ...plugin,
      source: "data:text/javascript,throw new Error('fixture reload failure')",
    })),
  }));
  await assert.rejects(
    opener.openEndpoint(
      instanceId,
      8188,
      "127.0.0.1",
      { signal: new AbortController().signal },
    ),
    (error) =>
      error?.code === "plugin-failure" &&
      /current plugin configuration failed to reload/.test(error.message),
  );
  assert.equal(firstClosed, false);

  await second.session.close();
  await first.session.close();
  await rm(directory, { recursive: true, force: true });
});
