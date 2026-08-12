import assert from "node:assert/strict";
import test from "node:test";
import {
  TuiReadOperations,
  collectDaemonReadSnapshot,
} from "../dist/tui-read-model.js";

function context(signal = new AbortController().signal) {
  return { signal };
}

test("read snapshot keeps healthy inventory beside degraded providers and plugin failures", async () => {
  const operations = new TuiReadOperations({
    async listProviders() {
      return [
        {
          source: "@fixture/healthy",
          state: "loaded",
          pluginId: "fixture.healthy",
          displayName: "Healthy Provider",
          version: "1.2.3",
          providerId: "healthy",
          credentials: [
            {
              name: "apiKey",
              description: "API key",
              required: true,
              configured: true,
            },
          ],
        },
        {
          source: "./broken-plugin.mjs",
          state: "failed",
          error: "requires EasyServer ^9.0.0\u001b[31m",
        },
      ];
    },
    async listInventory() {
      return {
        complete: false,
        providers: [
          { providerId: "healthy", status: "fresh" },
          {
            providerId: "offline",
            status: "failed",
            error: {
              code: "provider-unavailable",
              message: "Provider offline inventory refresh failed",
            },
          },
        ],
        instances: [
          {
            id: "instance:healthy-1",
            providerId: "healthy",
            providerExternalId: "remote-1",
            management: "managed",
            name: "GPU worker",
            state: "running",
            rawState: "READY\u001b[2J",
            availableActions: [],
            freshness: "fresh",
            observedAt: "2026-08-12T10:00:00.000Z",
          },
          {
            id: "instance:offline-1",
            providerId: "offline",
            providerExternalId: "remote-2",
            management: "discovered",
            state: "stopped",
            availableActions: [],
            freshness: "stale",
            observedAt: "2026-08-12T09:00:00.000Z",
          },
        ],
      };
    },
    async readDaemon() {
      return {
        status: "running",
        sessions: { status: "ready", total: 2, live: 1, closing: 0, failed: 1 },
        endpointIntents: {
          status: "ready",
          total: 2,
          live: 1,
          starting: 0,
          error: 0,
          disabled: 1,
        },
      };
    },
  });

  const snapshot = await operations.load(context());

  assert.equal(snapshot.providers.status, "ready");
  assert.deepEqual(
    snapshot.providers.items.map((provider) => [provider.state, provider.readiness]),
    [["loaded", "ready"], ["failed", "failed"]],
  );
  assert.equal(snapshot.providers.items[1].failure, "incompatible");
  assert.doesNotMatch(snapshot.providers.items[1].source, /\u001b/);

  assert.equal(snapshot.instances.status, "ready");
  assert.equal(snapshot.instances.complete, false);
  assert.equal(snapshot.instances.items.length, 2);
  assert.deepEqual(snapshot.instances.items[0].availableActions, []);
  assert.equal(snapshot.instances.items[0].state, "running");
  assert.equal(snapshot.instances.items[0].rawState, "READY\\u001b[2J");
  assert.equal(snapshot.instances.items[1].freshness, "stale");
  assert.equal(snapshot.instances.providerOutcomes[1].status, "failed");

  assert.equal(snapshot.daemon.status, "running");
  assert.equal(snapshot.daemon.sessions.live, 1);
  assert.equal(snapshot.daemon.endpointIntents.live, 1);
});

test("read snapshot isolates section failure instead of hiding healthy sections", async () => {
  const operations = new TuiReadOperations({
    async listProviders() {
      throw new Error("private plugin loader details");
    },
    async listInventory() {
      return { complete: true, providers: [], instances: [] };
    },
    async readDaemon() {
      return { status: "stopped" };
    },
  });

  const snapshot = await operations.load(context());
  assert.equal(snapshot.providers.status, "failed");
  assert.match(snapshot.providers.message, /provider configuration/i);
  assert.doesNotMatch(snapshot.providers.message, /private plugin loader details/);
  assert.equal(snapshot.instances.status, "ready");
  assert.deepEqual(snapshot.instances.items, []);
  assert.equal(snapshot.daemon.status, "stopped");
});

test("daemon read snapshot never exposes descriptor credentials and tolerates detail failure", async () => {
  const descriptor = {
    version: 1,
    address: { host: "127.0.0.1", port: 43210 },
    authToken: "must-never-escape",
  };
  const snapshot = await collectDaemonReadSnapshot("fixture-daemon.json", {
    async readDescriptor() {
      return descriptor;
    },
    createClient() {
      return {
        async ping() {},
        async listSessions() {
          return [
            { state: "live" },
            { state: "failed" },
          ];
        },
        async listEndpointIntents() {
          throw new Error("fixture detail failure");
        },
      };
    },
  });

  assert.deepEqual(snapshot, {
    status: "running",
    sessions: { status: "ready", total: 2, live: 1, closing: 0, failed: 1 },
    endpointIntents: { status: "unavailable" },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /must-never-escape/);
});
