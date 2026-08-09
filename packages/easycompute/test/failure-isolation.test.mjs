import assert from "node:assert/strict";
import test from "node:test";
import {
  createIntelionProviderPlugin,
  INTELION_API_TOKEN_CREDENTIAL,
} from "../../../plugins/intelion/dist/index.js";
import {
  createVastProviderPlugin,
  VAST_API_KEY_CREDENTIAL,
} from "../../../plugins/vastai/dist/index.js";
import { normalizedError } from "@easycompute/plugin-sdk";
import { PluginHost } from "../dist/plugin-host.js";
import { ProviderFeatureHost } from "../dist/provider-feature-host.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { assertNormalizedOperationError } from "./support/provider-plugin-contract-kit.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function context(credentialName, signal = new AbortController().signal) {
  return {
    signal,
    async resolveCredential(name) {
      assert.equal(name, credentialName);
      return "fixture-secret";
    },
  };
}

function acquisitionSubjects(fetch) {
  return [
    {
      name: "Vast",
      credential: VAST_API_KEY_CREDENTIAL,
      plugin: createVastProviderPlugin({
        baseUrl: "https://fixture.vast.test",
        fetch,
      }),
      invoke(plugin, operationContext) {
        return plugin.features[0].rentOffer(
          { offerId: "901", image: "ubuntu:22.04" },
          operationContext,
        );
      },
    },
    {
      name: "Intelion",
      credential: INTELION_API_TOKEN_CREDENTIAL,
      plugin: createIntelionProviderPlugin({
        baseUrl: "https://fixture.intelion.test",
        fetch,
      }),
      invoke(plugin, operationContext) {
        return plugin.features[0].createServer(
          {
            name: "worker",
            flavorId: 12,
            networkDiskGb: 64,
            osImageId: 7,
          },
          operationContext,
        );
      },
    },
  ];
}

function syntheticPlugin({ pluginId, providerId, feature }) {
  return {
    manifest: {
      id: pluginId,
      displayName: pluginId,
      version: "1.0.0",
      compatibility: { easycompute: "0.0.0", pluginSdk: "0.0.0" },
      provider: {
        id: providerId,
        displayName: providerId,
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
    features: [feature],
  };
}

test("first-party providers normalize rate limits without poisoning other plugins", async () => {
  const vast = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({ detail: "slow down" }, 429);
    },
  });
  const intelion = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ count: 0, next: null, previous: null, results: [] });
    },
  });

  await assertNormalizedOperationError(
    vast.provider.listInstances(context(VAST_API_KEY_CREDENTIAL)),
    "rate-limited",
  );
  assert.deepEqual(
    await intelion.provider.listInstances(context(INTELION_API_TOKEN_CREDENTIAL)),
    [],
  );
});

test("provider-specific acquisition distinguishes cancellation before and after dispatch", async () => {
  for (const createSubject of ["Vast", "Intelion"]) {
    let dispatches = 0;
    let markDispatched;
    let subject;
    const dispatched = new Promise((resolve) => {
      markDispatched = resolve;
    });
    const fetch = async (_input, init) => {
      dispatches += 1;
      markDispatched();
      await new Promise((_, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("fixture transport aborted")),
          { once: true },
        ),
      );
    };
    subject = acquisitionSubjects(fetch).find(
      (candidate) => candidate.name === createSubject,
    );

    const preCancelled = new AbortController();
    preCancelled.abort();
    await assertNormalizedOperationError(
      subject.invoke(
        subject.plugin,
        context(subject.credential, preCancelled.signal),
      ),
      "cancelled",
    );
    assert.equal(dispatches, 0);

    const controller = new AbortController();
    const operation = subject.invoke(
      subject.plugin,
      context(subject.credential, controller.signal),
    );
    await dispatched;
    controller.abort();
    await assertNormalizedOperationError(operation, "outcome-unknown");
    assert.equal(dispatches, 1);
  }
});

test("one Provider Feature invocation failure leaves another plugin usable", async () => {
  const broken = syntheticPlugin({
    pluginId: "broken.feature.plugin",
    providerId: "broken-feature",
    feature: {
      id: "action",
      displayName: "Broken Action",
      async run() {
        throw normalizedError("plugin-failure", "feature exploded");
      },
    },
  });
  const healthy = syntheticPlugin({
    pluginId: "healthy.feature.plugin",
    providerId: "healthy-feature",
    feature: {
      id: "action",
      displayName: "Healthy Action",
      async run() {
        return "healthy-result";
      },
    },
  });
  const providers = new ProviderRegistry();
  const features = new ProviderFeatureHost();
  const plugins = new Map([
    ["broken", broken],
    ["healthy", healthy],
  ]);
  const host = new PluginHost(
    providers,
    async (source) => plugins.get(source),
    features,
  );
  await host.load(["broken", "healthy"]);

  const brokenAdmission = features.acquire("broken-feature", "action");
  assert.ok(brokenAdmission);
  try {
    await assertNormalizedOperationError(
      brokenAdmission.feature.run(),
      "plugin-failure",
    );
  } finally {
    brokenAdmission.release();
  }

  const healthyAdmission = features.acquire("healthy-feature", "action");
  assert.ok(healthyAdmission);
  try {
    assert.equal(await healthyAdmission.feature.run(), "healthy-result");
  } finally {
    healthyAdmission.release();
  }
  assert.deepEqual(providers.listProviderIds(), ["broken-feature", "healthy-feature"]);
  assert.equal(host.listPlugins().every((status) => status.state === "loaded"), true);
});
