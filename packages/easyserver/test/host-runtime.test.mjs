import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHostRuntime,
  resolveHostRuntimePaths,
} from "../dist/host-runtime.js";
import { ProviderFeatureHost } from "../dist/provider-feature-host.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { InMemorySecretStore } from "../dist/secret-store.js";
import { OpenSshAccessAdapter } from "../dist/ssh-access-adapter.js";
import { JsonStateStore } from "../dist/state-store.js";

test("host runtime centralizes paths and preserves injected host dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-host-runtime-"));
  const statePath = join(directory, "custom-state.json");
  const daemonPath = join(directory, "custom-daemon.json");
  const store = new JsonStateStore(statePath);
  const secrets = new InMemorySecretStore();
  const registry = new ProviderRegistry();
  const featureHost = new ProviderFeatureHost();
  const sshAdapter = new OpenSshAccessAdapter({
    knownHostsPath: join(directory, "known_hosts"),
  });

  await store.write({ version: 1, plugins: [] });
  registry.register("injected", "fixture.injected", () => ({
    pluginId: "fixture.injected",
    provider: {
      providerId: "injected",
      async listInstances() {
        return [
          {
            providerExternalId: "remote-1",
            state: "running",
            rawState: "READY",
            availableActions: [],
          },
        ];
      },
      async getInstance(providerExternalId) {
        return providerExternalId === "remote-1"
          ? {
              providerExternalId,
              state: "running",
              rawState: "READY",
              availableActions: [],
            }
          : undefined;
      },
      async getAccessMethods() {
        return [];
      },
    },
    capabilities: [],
    accessAdapters: [],
    async resolveCredential() {
      return undefined;
    },
    release() {},
  }));

  const runtime = await createHostRuntime({
    paths: { stateFile: statePath, daemonFile: daemonPath },
    stateStore: store,
    secretStore: secrets,
    providerRegistry: registry,
    providerFeatureHost: featureHost,
    sshAdapter,
  });

  assert.deepEqual(runtime.paths, {
    stateFile: statePath,
    daemonFile: daemonPath,
  });
  assert.equal(runtime.stateStore, store);
  assert.equal(runtime.secretStore, secrets);
  assert.equal(runtime.providerRegistry, registry);
  assert.equal(runtime.providerFeatureHost, featureHost);
  assert.ok(runtime.pluginHost);
  assert.ok(runtime.accessAdapters);
  assert.equal(runtime.sshAdapter, sshAdapter);
  const admission = runtime.providerRegistry.acquire("injected");
  assert.ok(admission);
  assert.equal(
    runtime.accessAdapters.resolveTcpForward(
      { id: "fixture-ssh", kind: "ssh", mode: "tcp-forward" },
      admission,
    ),
    runtime.sshAdapter,
  );
  admission.release();
  assert.ok(runtime.computeManager);
  assert.ok(runtime.connectionGateway);

  const inventory = await runtime.computeManager.listInventory({
    signal: new AbortController().signal,
  });
  assert.equal(inventory.instances.length, 1);
  assert.equal(inventory.instances[0].providerId, "injected");

  const methods = await runtime.connectionGateway.listAccessMethods(
    inventory.instances[0].id,
    { signal: new AbortController().signal },
  );
  assert.deepEqual(methods, []);

  await rm(directory, { recursive: true, force: true });
});

test("host runtime path resolver owns default state and daemon path policy", () => {
  assert.deepEqual(
    resolveHostRuntimePaths(
      {
        EASYSERVER_STATE_FILE: "X:/state.json",
        EASYSERVER_DAEMON_FILE: "X:/daemon.json",
      },
      "X:/home",
    ),
    {
      stateFile: "X:/state.json",
      daemonFile: "X:/daemon.json",
    },
  );

  assert.deepEqual(resolveHostRuntimePaths({}, "X:/home"), {
    stateFile: join("X:/home", ".easyserver", "state.json"),
    daemonFile: join("X:/home", ".easyserver", "daemon.json"),
  });
});
