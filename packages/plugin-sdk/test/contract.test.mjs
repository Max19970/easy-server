import assert from "node:assert/strict";
import test from "node:test";

import {
  isNormalizedError,
  normalizedError,
  isSecretReference,
  parsePluginManifest,
  parseProviderInstanceList,
  parseProviderPlugin,
  parseSecretReference,
  PluginContractError,
} from "../dist/index.js";

const validManifest = {
  id: "vastai",
  displayName: "Vast.ai",
  version: "0.1.0",
  compatibility: {
    easycompute: ">=0.1.0 <1.0.0",
    pluginSdk: ">=0.1.0 <1.0.0",
  },
  provider: {
    id: "vastai",
    displayName: "Vast.ai",
    capabilities: ["instance.stop", "instance.destroy"],
  },
};

test("accepts a valid provider plugin", () => {
  const plugin = parseProviderPlugin({
    manifest: validManifest,
    provider: {
      providerId: "vastai",
      async listInstances() {
        return [];
      },
      async getInstance() {
        return undefined;
      },
    },
  });

  assert.equal(plugin.manifest.provider.id, "vastai");
  assert.deepEqual(plugin.manifest.provider.capabilities, [
    "instance.stop",
    "instance.destroy",
  ]);
});

test("rejects malformed manifests at the plugin boundary", () => {
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        version: "banana",
      }),
    PluginContractError,
  );

  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        provider: {
          ...validManifest.provider,
          capabilities: ["instance.stop", "instance.stop"],
        },
      }),
    PluginContractError,
  );

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: {
          providerId: "intelion",
          async listInstances() {
            return [];
          },
          async getInstance() {
            return undefined;
          },
        },
      }),
    PluginContractError,
  );
});

test("validates opaque secret references", () => {
  const ref = parseSecretReference("secret:550e8400-e29b-41d4-a716-446655440000");

  assert.equal(isSecretReference(ref), true);
  assert.equal(isSecretReference("not-a-secret-ref"), false);
  assert.throws(() => parseSecretReference("secret:banana"), PluginContractError);
});

test("validates normalized provider inventory and per-instance available actions", () => {
  const instances = parseProviderInstanceList(
    [
      {
        providerExternalId: "contract-1",
        name: "Training",
        state: "running",
        rawState: "RUNNING",
        availableActions: ["instance.stop"],
      },
      {
        providerExternalId: "contract-2",
        state: "unknown",
        rawState: 17,
        availableActions: [],
      },
    ],
    ["instance.stop"],
  );

  assert.equal(instances[1].state, "unknown");
  assert.equal(instances[1].rawState, 17);

  assert.throws(
    () =>
      parseProviderInstanceList(
        [
          {
            providerExternalId: "contract-1",
            state: "stopped",
            rawState: "stopped",
            availableActions: ["instance.start"],
          },
        ],
        ["instance.stop"],
      ),
    /not declared by the provider/,
  );

  assert.throws(
    () =>
      parseProviderInstanceList(
        [
          {
            providerExternalId: "duplicate",
            state: "running",
            rawState: "running",
            availableActions: [],
          },
          {
            providerExternalId: "duplicate",
            state: "stopped",
            rawState: "stopped",
            availableActions: [],
          },
        ],
        [],
      ),
    /duplicate providerExternalId/,
  );
});

test("a host-owned abort signal reaches a blocking plugin invocation", async () => {
  const controller = new AbortController();

  const blockingInvocation = ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });

  const result = blockingInvocation({ signal: controller.signal });
  controller.abort();

  assert.equal(await result, "cancelled");
});

test("distinguishes definite cancellation from unknown mutation outcome", () => {
  const cancelled = normalizedError("cancelled", "cancelled before dispatch");
  const unknown = normalizedError(
    "outcome-unknown",
    "remote mutation may have been dispatched",
  );

  assert.equal(cancelled.code, "cancelled");
  assert.equal(unknown.code, "outcome-unknown");
  assert.equal(isNormalizedError(cancelled), true);
  assert.equal(isNormalizedError(unknown), true);
  assert.equal(isNormalizedError({ code: "cancelled" }), false);
});
