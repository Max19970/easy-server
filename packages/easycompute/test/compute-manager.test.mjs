import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputeManager } from "../dist/compute-manager.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { JsonStateStore } from "../dist/state-store.js";

const context = { signal: new AbortController().signal };

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "easycompute-compute-manager-"));

  try {
    const store = new JsonStateStore(join(directory, "state.json"));
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function registerProvider(registry, { providerId, capabilities, list, get }) {
  const provider = {
    providerId,
    async listInstances(operationContext) {
      return list(operationContext);
    },
    async getInstance(providerExternalId, operationContext) {
      return get(providerExternalId, operationContext);
    },
  };

  registry.register(providerId, `${providerId}.plugin`, () => ({
    pluginId: `${providerId}.plugin`,
    provider,
    capabilities,
    release() {},
  }));
}

test("zero providers returns an empty inventory", async () => {
  await withStore(async (store) => {
    const manager = new ComputeManager(new ProviderRegistry(), store);
    assert.deepEqual(await manager.listInstances(context), []);
  });
});

test("keeps providers distinct, preserves raw states, and keeps plugin-computed actions", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    registerProvider(registry, {
      providerId: "alpha",
      capabilities: ["instance.start", "instance.stop"],
      list: async () => [
        {
          providerExternalId: "shared-id",
          name: "Alpha running",
          state: "running",
          rawState: "READY",
          availableActions: ["instance.stop"],
        },
        {
          providerExternalId: "alpha-unknown",
          state: "unknown",
          rawState: 73,
          availableActions: [],
        },
      ],
      get: async () => undefined,
    });
    registerProvider(registry, {
      providerId: "beta",
      capabilities: ["instance.start"],
      list: async () => [
        {
          providerExternalId: "shared-id",
          state: "stopped",
          rawState: false,
          availableActions: ["instance.start"],
        },
      ],
      get: async () => undefined,
    });

    const instances = await new ComputeManager(registry, store).listInstances(context);

    assert.equal(instances.length, 3);
    assert.notEqual(instances[0].id, instances[2].id);
    assert.equal(instances[0].providerId, "alpha");
    assert.equal(instances[2].providerId, "beta");
    assert.equal(instances[1].state, "unknown");
    assert.equal(instances[1].rawState, 73);
    assert.deepEqual(instances[0].availableActions, ["instance.stop"]);
    assert.deepEqual(instances[2].availableActions, ["instance.start"]);
  });
});

test("local instance IDs survive a fresh manager and successful inventory refresh", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshots = [
      {
        providerExternalId: "remote-1",
        state: "running",
        rawState: "running",
        availableActions: ["instance.stop"],
      },
    ];
    registerProvider(registry, {
      providerId: "stable",
      capabilities: ["instance.stop"],
      list: async () => snapshots,
      get: async () => snapshots[0],
    });

    const first = await new ComputeManager(registry, store).listInstances(context);
    const second = await new ComputeManager(registry, store).listInstances(context);
    const inspected = await new ComputeManager(registry, store).inspectInstance(
      first[0].id,
      context,
    );

    assert.match(first[0].id, /^instance:/);
    assert.equal(second[0].id, first[0].id);
    assert.equal(inspected?.id, first[0].id);
    assert.equal(inspected?.providerExternalId, "remote-1");
  });
});

test("a complete provider refresh removes stale bindings without touching other providers", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    let alphaSnapshots = [
      {
        providerExternalId: "gone-later",
        state: "running",
        rawState: "running",
        availableActions: [],
      },
    ];
    const betaSnapshot = {
      providerExternalId: "keep",
      state: "running",
      rawState: "running",
      availableActions: [],
    };

    registerProvider(registry, {
      providerId: "alpha",
      capabilities: [],
      list: async () => alphaSnapshots,
      get: async () => undefined,
    });
    registerProvider(registry, {
      providerId: "beta",
      capabilities: [],
      list: async () => [betaSnapshot],
      get: async () => betaSnapshot,
    });

    const manager = new ComputeManager(registry, store);
    const first = await manager.listInstances(context);
    const staleId = first.find((instance) => instance.providerId === "alpha").id;
    const keptId = first.find((instance) => instance.providerId === "beta").id;

    alphaSnapshots = [];
    const second = await manager.listInstances(context);

    assert.equal(second.some((instance) => instance.id === staleId), false);
    assert.equal(second.find((instance) => instance.providerId === "beta").id, keptId);
    assert.equal(await manager.inspectInstance(staleId, context), undefined);
  });
});
