import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { PluginHost, formatPluginStatuses } from "../dist/plugin-host.js";
import { ProviderFeatureHost } from "../dist/provider-feature-host.js";
import { ProviderRegistry } from "../dist/provider-registry.js";

const execFileAsync = promisify(execFile);

function plugin({
  pluginId = "fake.plugin",
  providerId = "fake",
  features = [],
} = {}) {
  return {
    manifest: {
      id: pluginId,
      displayName: "Fake Plugin",
      version: "1.0.0",
      compatibility: {
        easyserver: "^0.1.0",
        pluginSdk: "^0.1.0",
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
    features,
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

test("registers zero or more provider features with provider-scoped identity", async () => {
  const registry = new ProviderRegistry();
  const features = new ProviderFeatureHost();
  const plugins = new Map([
    [
      "alpha",
      plugin({
        pluginId: "alpha.plugin",
        providerId: "alpha",
        features: [{ id: "marketplace", displayName: "Alpha Marketplace" }],
      }),
    ],
    [
      "beta",
      plugin({
        pluginId: "beta.plugin",
        providerId: "beta",
        features: [{ id: "marketplace", displayName: "Beta Marketplace" }],
      }),
    ],
    [
      "empty",
      plugin({ pluginId: "empty.plugin", providerId: "empty" }),
    ],
  ]);
  const host = new PluginHost(
    registry,
    async (source) => plugins.get(source),
    features,
  );

  await host.load(["alpha", "beta", "empty"]);

  assert.deepEqual(features.listFeatures(), [
    {
      pluginId: "alpha.plugin",
      providerId: "alpha",
      featureId: "marketplace",
      displayName: "Alpha Marketplace",
    },
    {
      pluginId: "beta.plugin",
      providerId: "beta",
      featureId: "marketplace",
      displayName: "Beta Marketplace",
    },
  ]);
  assert.equal(features.acquire("empty", "marketplace"), undefined);
});

test("feature admission linearizes with plugin disable while admitted work may finish", async () => {
  const registry = new ProviderRegistry();
  const features = new ProviderFeatureHost();
  const feature = {
    id: "marketplace",
    displayName: "Marketplace",
    async run() {
      return "finished";
    },
  };
  const host = new PluginHost(
    registry,
    async () => plugin({ features: [feature] }),
    features,
  );
  await host.load(["fake"]);

  const admitted = features.acquire("fake", "marketplace");
  assert.ok(admitted);
  assert.equal(host.disable("fake.plugin"), true);
  assert.equal(features.acquire("fake", "marketplace"), undefined);
  assert.equal(await admitted.feature.run(), "finished");
  admitted.release();
});

test("failed plugins do not remove healthy provider features", async () => {
  const registry = new ProviderRegistry();
  const features = new ProviderFeatureHost();
  const host = new PluginHost(
    registry,
    async (source) => {
      if (source === "broken") {
        throw new Error("feature plugin exploded");
      }

      return plugin({
        features: [{ id: "configurator", displayName: "Configurator" }],
      });
    },
    features,
  );

  await host.load(["broken", "healthy"]);

  assert.equal(host.listPlugins()[0].state, "failed");
  assert.deepEqual(features.listFeatures().map((feature) => feature.featureId), [
    "configurator",
  ]);
});

test("times out a hung plugin load and continues with healthy plugins", async () => {
  const registry = new ProviderRegistry();
  const host = new PluginHost(
    registry,
    async (source) => {
      if (source === "hung") {
        return new Promise(() => {});
      }
      return plugin();
    },
    new ProviderFeatureHost(),
    20,
  );

  const outcome = await Promise.race([
    host.load(["hung", "healthy"]).then(() => "settled"),
    delay(200).then(() => "hung"),
  ]);

  assert.equal(outcome, "settled");
  assert.equal(host.listPlugins()[0].state, "failed");
  assert.match(host.listPlugins()[0].error, /timed out/i);
  assert.equal(host.listPlugins()[1].state, "loaded");
  assert.deepEqual(registry.listProviderIds(), ["fake"]);
});

test("plugin load deadline keeps a standalone process alive until it fires", async () => {
  const pluginHostUrl = new URL("../dist/plugin-host.js", import.meta.url).href;
  const registryUrl = new URL("../dist/provider-registry.js", import.meta.url).href;
  const script = `
    import { PluginHost } from ${JSON.stringify(pluginHostUrl)};
    import { ProviderRegistry } from ${JSON.stringify(registryUrl)};

    const registry = new ProviderRegistry();
    const healthy = {
      manifest: {
        id: "fake.plugin",
        displayName: "Fake Plugin",
        version: "1.0.0",
        compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
        provider: {
          id: "fake",
          displayName: "Fake Provider",
          capabilities: [],
        },
      },
      provider: {
        providerId: "fake",
        async listInstances() { return []; },
        async getInstance() { return undefined; },
      },
    };
    const host = new PluginHost(
      registry,
      async (source) => source === "hung" ? new Promise(() => {}) : healthy,
      undefined,
      20,
    );

    host.load(["hung", "healthy"]).then(() => {
      if (registry.listProviderIds().join(",") === "fake") {
        console.log("loaded");
      }
    });
  `;

  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ]);

  assert.equal(stdout.trim(), "loaded");
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

test("provider and feature admissions resolve only configured credential names", async () => {
  const registry = new ProviderRegistry();
  const features = new ProviderFeatureHost();
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  const secretStore = {
    async get(ref) {
      assert.equal(ref, secretRef);
      return "fixture-token";
    },
  };
  const host = new PluginHost(
    registry,
    async () =>
      plugin({
        features: [{ id: "marketplace", displayName: "Marketplace" }],
      }),
    features,
  );

  await host.load(
    [
      {
        source: "fake-module",
        credentials: [{ name: "api-key", secretRef }],
      },
    ],
    secretStore,
  );

  const providerAdmission = registry.acquire("fake");
  const featureAdmission = features.acquire("fake", "marketplace");
  assert.ok(providerAdmission);
  assert.ok(featureAdmission);
  assert.equal(
    await providerAdmission.resolveCredential("api-key"),
    "fixture-token",
  );
  assert.equal(await providerAdmission.resolveCredential("missing"), undefined);
  assert.equal(
    await featureAdmission.resolveCredential("api-key"),
    "fixture-token",
  );
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

test("accepts release-compatible SemVer ranges and rejects the next incompatible minor", async () => {
  const registry = new ProviderRegistry();
  const candidate = plugin();
  candidate.manifest.compatibility.easyserver = "^0.1.0";
  candidate.manifest.compatibility.pluginSdk = ">=0.1.0 <0.2.0";
  const host = new PluginHost(registry, async () => candidate);

  await host.load(["compatible-release-plugin"]);

  assert.equal(host.listPlugins()[0].state, "loaded");
  assert.deepEqual(registry.listProviderIds(), ["fake"]);

  const futureRegistry = new ProviderRegistry();
  const futureCandidate = plugin({
    pluginId: "future.plugin",
    providerId: "future",
  });
  futureCandidate.manifest.compatibility.easyserver = "^0.2.0";
  futureCandidate.manifest.compatibility.pluginSdk = "^0.1.0";
  const futureHost = new PluginHost(futureRegistry, async () => futureCandidate);

  await futureHost.load(["future-release-plugin"]);

  assert.equal(futureHost.listPlugins()[0].state, "failed");
  assert.match(futureHost.listPlugins()[0].error, /requires EasyServer \^0\.2\.0/);
  assert.deepEqual(futureRegistry.listProviderIds(), []);
});

test("rejects an incompatible plugin before provider registration", async () => {
  const registry = new ProviderRegistry();
  const candidate = plugin();
  candidate.manifest.compatibility.easyserver = "9.0.0";
  const host = new PluginHost(registry, async () => candidate);

  await host.load(["future-plugin"]);

  assert.equal(host.listPlugins()[0].state, "failed");
  assert.match(host.listPlugins()[0].error, /requires EasyServer 9\.0\.0/);
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

  const escaped = formatPluginStatuses([
    {
      source: "broken\nrecord\u001b[2J",
      state: "failed",
      error: "bad\rmessage\u001b[31m",
    },
  ]);
  assert.ok(escaped.includes("broken\\nrecord\\u001b[2J"));
  assert.ok(escaped.includes("error=bad\\rmessage\\u001b[31m"));
  assert.equal(escaped.includes("\u001b"), false);
  assert.equal(escaped.split("\n").length, 2);
});
