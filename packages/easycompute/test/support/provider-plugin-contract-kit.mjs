import assert from "node:assert/strict";
import {
  isNormalizedError,
  parseProviderInstanceList,
  parseProviderInstanceSnapshot,
} from "@easycompute/plugin-sdk";
import { AccessAdapterRegistry } from "../../dist/access-adapter-registry.js";
import { PluginHost } from "../../dist/plugin-host.js";
import { ProviderFeatureHost } from "../../dist/provider-feature-host.js";
import { ProviderRegistry } from "../../dist/provider-registry.js";

export async function assertProviderAdapterContract(plugin, context) {
  const capabilities = plugin.manifest.provider.capabilities;
  const listed = parseProviderInstanceList(
    await plugin.provider.listInstances(context),
    capabilities,
  );

  for (const listedInstance of listed) {
    const fetched = await plugin.provider.getInstance(
      listedInstance.providerExternalId,
      context,
    );
    assert.ok(
      fetched,
      `getInstance(${listedInstance.providerExternalId}) must resolve an instance listed by listInstances() in a stable fixture`,
    );
    const parsed = parseProviderInstanceSnapshot(fetched, capabilities);
    assert.equal(parsed.providerExternalId, listedInstance.providerExternalId);
  }

  return listed;
}

export async function assertNormalizedOperationError(operation, expectedCode) {
  await assert.rejects(
    operation,
    (error) => isNormalizedError(error) && error.code === expectedCode,
  );
}

export async function assertProviderFeatureLifecycle(plugin, featureId) {
  const providers = new ProviderRegistry();
  const features = new ProviderFeatureHost();
  const host = new PluginHost(providers, async () => plugin, features);
  const source = `contract:${plugin.manifest.id}`;

  await host.load([source]);
  const admitted = features.acquire(plugin.manifest.provider.id, featureId);
  assert.ok(admitted, `Provider Feature must be admitted: ${featureId}`);
  assert.equal(admitted.feature.id, featureId);

  assert.equal(host.disable(plugin.manifest.id), true);
  assert.equal(
    features.acquire(plugin.manifest.provider.id, featureId),
    undefined,
    "disabled plugin must reject new Provider Feature admission",
  );
  assert.equal(
    admitted.feature.id,
    featureId,
    "an already admitted Provider Feature lease remains usable until release",
  );
  admitted.release();
}

export async function assertAccessAdapterRegistration(plugin, accessMethod) {
  const providers = new ProviderRegistry();
  const host = new PluginHost(providers, async () => plugin);
  await host.load([`contract:${plugin.manifest.id}`]);

  const admission = providers.acquire(plugin.manifest.provider.id);
  assert.ok(admission, "provider must be admitted before Access Adapter resolution");
  try {
    const resolved = new AccessAdapterRegistry().resolveTcpForward(
      accessMethod,
      admission,
    );
    assert.ok(resolved, `Access Adapter must resolve kind ${accessMethod.kind}`);
    assert.equal(resolved.kind, accessMethod.kind);
    assert.ok(
      admission.accessAdapters.includes(resolved),
      "provider-specific Access Adapter must come from the admitted plugin",
    );
  } finally {
    admission.release();
  }
}
