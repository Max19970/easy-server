import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, formatPluginStatuses } from "../dist/plugin-host.js";
import { ProviderRegistry } from "../dist/provider-registry.js";

function plugin({ pluginId = "fake.plugin", providerId = "fake" } = {}) {
  return {
    manifest: {
      id: pluginId,
      displayName: "Fake Plugin",
      version: "1.0.0",
      compatibility: {
        easycompute: "0.0.0",
        pluginSdk: "0.0.0",
      },
      provider: {
        id: providerId,
        displayName: "Fake Provider",
        capabilities: [],
      },
    },
    provider: {
      providerId,
      async listInstances() {
        return [];
      },
      async getInstance() {
        return undefined;
      },
    },
  };
}

test("loads an explicitly requested plugin into the provider registry", async () => {
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry, async () => plugin());

  await host.load(["fake-module"]);

  assert.deepEqual(host.listPlugins(), [
    {
      source: "fake-module",
      state: "loaded",
      pluginId: "fake.plugin",
      displayName: "Fake Plugin",
      providerId: "fake",
    },
  ]);
  assert.deepEqual(registry.listProviderIds(), ["fake"]);
  assert.equal(registry.acquire("fake")?.provider.providerId, "fake");
});

test("isolates catchable import and manifest failures", async () => {
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry, async (source) => {
    if (source === "broken") {
      throw new Error("module exploded");
    }
    if (source === "invalid") {
      return { manifest: {} };
    }

    return plugin();
  });

  await host.load(["broken", "invalid", "healthy"]);

  assert.equal(host.listPlugins()[0].state, "failed");
  assert.match(host.listPlugins()[0].error, /module exploded/);
  assert.equal(host.listPlugins()[1].state, "failed");
  assert.match(host.listPlugins()[1].error, /plugin manifest\.compatibility/);
  assert.equal(host.listPlugins()[2].state, "loaded");
  assert.deepEqual(registry.listProviderIds(), ["fake"]);
});

test("disable stops new admission while an existing lease keeps its adapter", async () => {
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry, async () => plugin());
  await host.load(["fake-module"]);

  const admitted = registry.acquire("fake");
  assert.ok(admitted);

  assert.equal(host.disable("fake.plugin"), true);
  assert.equal(registry.acquire("fake"), undefined);
  assert.equal(admitted.provider.providerId, "fake");
  assert.equal(host.listPlugins()[0].state, "disabled");

  admitted.release();
  assert.equal(host.disable("fake.plugin"), false);
});

test("rejects an incompatible plugin before provider registration", async () => {
  const registry = new ProviderRegistry();
  const candidate = plugin();
  candidate.manifest.compatibility.easycompute = "9.0.0";
  const host = new PluginHost(registry, async () => candidate);

  await host.load(["future-plugin"]);

  assert.equal(host.listPlugins()[0].state, "failed");
  assert.match(host.listPlugins()[0].error, /requires EasyCompute 9\.0\.0/);
  assert.deepEqual(registry.listProviderIds(), []);
});

test("provider collisions fail without replacing the healthy registration", async () => {
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry, async (source) =>
    source === "one"
      ? plugin({ pluginId: "plugin.one" })
      : plugin({ pluginId: "plugin.two" }),
  );

  await host.load(["one", "two"]);

  assert.equal(host.listPlugins()[0].state, "loaded");
  assert.equal(host.listPlugins()[1].state, "failed");
  assert.match(host.listPlugins()[1].error, /Provider already registered/);
  assert.equal(registry.acquire("fake")?.pluginId, "plugin.one");
});

test("formats loaded, disabled, and failed diagnostics distinctly", async () => {
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry, async (source) => {
    if (source === "broken") {
      throw new Error("bad plugin");
    }
    return plugin();
  });

  await host.load(["healthy", "broken"]);
  host.disable("fake.plugin");

  const output = formatPluginStatuses(host.listPlugins());
  assert.match(output, /^disabled\s+fake\.plugin provider=fake/m);
  assert.match(output, /^failed\s+broken error=bad plugin/m);
});
