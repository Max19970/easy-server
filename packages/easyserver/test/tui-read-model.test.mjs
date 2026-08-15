import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TuiReadOperations,
  collectDaemonReadSnapshot,
  loadDefaultTuiReadSnapshot,
} from "../dist/tui-read-model.js";

function context(signal = new AbortController().signal) {
  return { signal };
}

test("default TUI read path recovers a validated Local State generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-tui-state-recovery-"));
  const stateFile = join(directory, "state.json");
  const daemonFile = join(directory, "daemon.json");
  const recoveryState = {
    version: 1,
    plugins: [{ source: "@fixture/recovered-provider", enabled: false }],
  };

  try {
    await writeFile(stateFile, "corrupt primary state", "utf8");
    await writeFile(`${stateFile}.recovery`, `${JSON.stringify(recoveryState)}\n`, "utf8");

    const snapshot = await loadDefaultTuiReadSnapshot(context(), {
      stateFile,
      daemonFile,
    });

    assert.equal(snapshot.providers.status, "ready");
    assert.equal(snapshot.providers.items.length, 1);
    assert.equal(snapshot.providers.items[0].source, "@fixture/recovered-provider");
    assert.equal(snapshot.providers.items[0].state, "disabled");
    assert.equal(snapshot.providers.items[0].readiness, "disabled");
    assert.equal(snapshot.instances.status, "ready");
    assert.deepEqual(snapshot.instances.items, []);
    assert.equal(snapshot.daemon.status, "stopped");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default TUI read path fails closed when primary and recovery Local State are corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-tui-state-corrupt-"));
  const stateFile = join(directory, "state.json");
  const daemonFile = join(directory, "daemon.json");
  const primary = "corrupt primary state";
  const recovery = "corrupt recovery state";

  try {
    await writeFile(stateFile, primary, "utf8");
    await writeFile(`${stateFile}.recovery`, recovery, "utf8");

    await assert.rejects(
      loadDefaultTuiReadSnapshot(context(), { stateFile, daemonFile }),
      /Unable to recover EasyServer state/,
    );
    assert.equal(await readFile(stateFile, "utf8"), primary);
    assert.equal(await readFile(`${stateFile}.recovery`, "utf8"), recovery);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read snapshot keeps healthy inventory beside degraded providers and plugin failures", async () => {
  const operations = new TuiReadOperations({
    async listProviderCandidates() {
      return [
        {
          source: "@fixture/installed",
          displayName: "Installed Provider\u001b[31m",
          description: "Ready to add\u001b[2J",
        },
      ];
    },
    async listProviderWorkflows() {
      return [
        {
          providerId: "nebula",
          featureId: "allocation",
          featureDisplayName: "Allocation\u001b[31m",
          command: {
            name: "provision",
            description: "Provision resource\u001b[2J",
            operation: "mutation",
            risks: ["billable"],
            presentation: {
              kind: "interactive-flow",
              flowId: "provision-wizard",
            },
          },
        },
        {
          providerId: "legacy",
          featureId: "catalog",
          featureDisplayName: "Catalog",
          command: {
            name: "create",
            description: "Create from CLI",
            operation: "mutation",
            risks: [],
            presentation: { kind: "cli-fallback" },
          },
        },
      ];
    },
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
            {
              name: "profile",
              description: "Optional profile\u001b[31m",
              required: false,
              configured: false,
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
        sessions: { status: "ready", total: 2, live: 1, closing: 0, failed: 1, items: [] },
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

  assert.equal(snapshot.providerCandidates.status, "ready");
  assert.deepEqual(snapshot.providerCandidates.items, [
    {
      source: "@fixture/installed",
      displayName: "Installed Provider\\u001b[31m",
      description: "Ready to add\\u001b[2J",
    },
  ]);

  assert.equal(snapshot.providerWorkflows.status, "ready");
  assert.deepEqual(snapshot.providerWorkflows.items, [
    {
      providerId: "nebula",
      featureId: "allocation",
      featureDisplayName: "Allocation\\u001b[31m",
      commandName: "provision",
      description: "Provision resource\\u001b[2J",
      operation: "mutation",
      risks: ["billable"],
      presentation: {
        kind: "interactive-flow",
        flowId: "provision-wizard",
      },
    },
    {
      providerId: "legacy",
      featureId: "catalog",
      featureDisplayName: "Catalog",
      commandName: "create",
      description: "Create from CLI",
      operation: "mutation",
      risks: [],
      presentation: { kind: "cli-fallback" },
    },
  ]);

  assert.equal(snapshot.providers.status, "ready");
  assert.deepEqual(
    snapshot.providers.items.map((provider) => [provider.state, provider.readiness]),
    [["loaded", "ready"], ["failed", "failed"]],
  );
  assert.equal(snapshot.providers.items[1].failure, "incompatible");
  assert.doesNotMatch(snapshot.providers.items[1].source, /\u001b/);
  assert.deepEqual(snapshot.providers.items[0].credentials.items, [
    {
      name: "apiKey",
      description: "API key",
      required: true,
      configured: true,
    },
    {
      name: "profile",
      description: "Optional profile\\u001b[31m",
      required: false,
      configured: false,
    },
  ]);

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
    async listProviderCandidates() {
      throw new Error("private filesystem details");
    },
    async listProviderWorkflows() {
      throw new Error("private feature details");
    },
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
  assert.equal(snapshot.providerCandidates.status, "failed");
  assert.match(snapshot.providerCandidates.message, /installed provider packages/i);
  assert.doesNotMatch(snapshot.providerCandidates.message, /private filesystem details/);
  assert.equal(snapshot.providerWorkflows.status, "failed");
  assert.match(snapshot.providerWorkflows.message, /provider workflows/i);
  assert.doesNotMatch(snapshot.providerWorkflows.message, /private feature details/);
  assert.equal(snapshot.providers.status, "failed");
  assert.match(snapshot.providers.message, /provider configuration/i);
  assert.doesNotMatch(snapshot.providers.message, /private plugin loader details/);
  assert.equal(snapshot.instances.status, "ready");
  assert.deepEqual(snapshot.instances.items, []);
  assert.equal(snapshot.daemon.status, "stopped");
});

test("invalid daemon descriptor is projected as stale rather than healthy or stopped", async () => {
  const snapshot = await collectDaemonReadSnapshot("fixture-daemon.json", {
    async readDescriptor() {
      throw new TypeError("invalid descriptor");
    },
  });

  assert.deepEqual(snapshot, { status: "stale" });
});

test("daemon read snapshot projects durable Endpoint intents separately from live sessions", async () => {
  const snapshot = await collectDaemonReadSnapshot("fixture-daemon.json", {
    async readDescriptor() {
      return {
        version: 1,
        address: { host: "127.0.0.1", port: 43210 },
        authToken: "private-token",
      };
    },
    createClient() {
      return {
        async ping() {},
        async listSessions() {
          return [];
        },
        async listEndpointIntents() {
          return [
            {
              name: "comfy\u001b[2J",
              enabled: true,
              state: "live",
              instanceId: "instance:one",
              remoteHost: "127.0.0.1",
              remotePort: 8188,
              localPort: 48188,
              accessMethodId: "ssh",
              endpoint: { host: "127.0.0.1", port: 48188 },
              accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
            },
            {
              name: "web",
              enabled: true,
              state: "error",
              instanceId: "instance:two",
              remoteHost: "127.0.0.1",
              remotePort: 7860,
              failure: {
                code: "conflict",
                message: "Requested local port is occupied\u001b[31m",
              },
            },
          ];
        },
      };
    },
  });

  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.sessions.total, 0);
  assert.deepEqual(snapshot.endpointIntents.items, [
    {
      operationName: "comfy\u001b[2J",
      name: "comfy\\u001b[2J",
      enabled: true,
      state: "live",
      instanceId: "instance:one",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      requestedLocalPort: 48188,
      requestedAccessMethodId: "ssh",
      endpoint: { host: "127.0.0.1", port: 48188 },
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
    },
    {
      operationName: "web",
      name: "web",
      enabled: true,
      state: "error",
      instanceId: "instance:two",
      remoteHost: "127.0.0.1",
      remotePort: 7860,
      failure: {
        code: "conflict",
        message: "Requested local port is occupied\\u001b[31m",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-token/);
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
            {
              id: "session:live",
              state: "live",
              instanceId: "instance:one",
              remoteHost: "127.0.0.1",
              remotePort: 8188,
              requestedLocalPort: 48188,
              requestedAccessMethodId: "ssh",
              idempotencyKey: "fixture-live",
              accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
              endpoint: { host: "127.0.0.1", port: 48188 },
            },
            {
              id: "session:failed",
              state: "failed",
              instanceId: "instance:two",
              remoteHost: "127.0.0.1",
              remotePort: 7860,
              accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
              failure: {
                code: "plugin-failure",
                message: "Connection Session cleanup failed",
              },
            },
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
    sessions: {
      status: "ready",
      total: 2,
      live: 1,
      closing: 0,
      failed: 1,
      items: [
        {
          id: "session:live",
          state: "live",
          instanceId: "instance:one",
          remoteHost: "127.0.0.1",
          remotePort: 8188,
          requestedLocalPort: 48188,
          requestedAccessMethodId: "ssh",
          idempotencyKey: "fixture-live",
          accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
          endpoint: { host: "127.0.0.1", port: 48188 },
        },
        {
          id: "session:failed",
          state: "failed",
          instanceId: "instance:two",
          remoteHost: "127.0.0.1",
          remotePort: 7860,
          accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
          failure: {
            code: "plugin-failure",
            message: "Connection Session cleanup failed",
          },
        },
      ],
    },
    endpointIntents: { status: "unavailable" },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /must-never-escape/);
});
