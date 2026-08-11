import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { normalizedError } from "@easyai101/easyserver-plugin-sdk";
import { ComputeManager } from "../dist/compute-manager.js";
import { HostOperationRunner } from "../dist/host-operation.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { JsonStateStore } from "../dist/state-store.js";

const context = { signal: new AbortController().signal };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-compute-manager-"));

  try {
    const store = new JsonStateStore(join(directory, "state.json"));
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function registerProvider(
  registry,
  { providerId, capabilities, list, get, powerAction, destroy },
) {
  const provider = {
    providerId,
    async listInstances(operationContext) {
      return list(operationContext);
    },
    async getInstance(providerExternalId, operationContext) {
      return get(providerExternalId, operationContext);
    },
    ...(powerAction === undefined
      ? {}
      : {
          async performPowerAction(providerExternalId, action, operationContext) {
            return powerAction(providerExternalId, action, operationContext);
          },
        }),
    ...(destroy === undefined
      ? {}
      : {
          async destroy(providerExternalId, operationContext) {
            return destroy(providerExternalId, operationContext);
          },
        }),
  };

  registry.register(providerId, `${providerId}.plugin`, () => ({
    pluginId: `${providerId}.plugin`,
    provider,
    capabilities,
    accessAdapters: [],
    release() {},
  }));
}

test("zero providers returns an empty inventory", async () => {
  await withStore(async (store) => {
    const manager = new ComputeManager(new ProviderRegistry(), store);
    assert.deepEqual(await manager.listInstances(context), []);
  });
});

test("global inventory keeps healthy providers and stale last-known state during a partial outage", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const alpha = {
      providerExternalId: "alpha-live",
      state: "running",
      rawState: "READY",
      availableActions: ["instance.stop"],
    };
    const beta = {
      providerExternalId: "beta-last-known",
      state: "stopped",
      rawState: "OFFLINE",
      availableActions: ["instance.start"],
    };
    let betaUnavailable = false;
    registerProvider(registry, {
      providerId: "alpha-partial",
      capabilities: ["instance.stop"],
      list: async () => [alpha],
      get: async () => alpha,
    });
    registerProvider(registry, {
      providerId: "beta-partial",
      capabilities: ["instance.start"],
      list: async () => {
        if (betaUnavailable) {
          throw normalizedError("provider-unavailable", "fixture beta outage");
        }
        return [beta];
      },
      get: async () => beta,
    });

    const manager = new ComputeManager(registry, store);
    const initial = await manager.listInventory(context);
    assert.equal(initial.complete, true);
    const betaBefore = initial.instances.find(
      (instance) => instance.providerId === "beta-partial",
    );
    assert.equal(betaBefore.freshness, "fresh");

    betaUnavailable = true;
    const degraded = await new ComputeManager(
      registry,
      new JsonStateStore(store.path),
    ).listInventory(context);

    assert.equal(degraded.complete, false);
    assert.equal(
      degraded.providers.find((provider) => provider.providerId === "beta-partial")
        .status,
      "failed",
    );
    assert.equal(
      degraded.instances.find((instance) => instance.providerId === "alpha-partial")
        .freshness,
      "fresh",
    );
    const betaAfter = degraded.instances.find(
      (instance) => instance.providerId === "beta-partial",
    );
    assert.equal(betaAfter.id, betaBefore.id);
    assert.equal(betaAfter.freshness, "stale");
    assert.equal(betaAfter.state, beta.state);
    assert.deepEqual(betaAfter.availableActions, []);
    assert.equal("rawState" in betaAfter, false);

    betaUnavailable = false;
    const recovered = await new ComputeManager(
      registry,
      new JsonStateStore(store.path),
    ).listInventory(context);
    const betaRecovered = recovered.instances.find(
      (instance) => instance.providerId === "beta-partial",
    );
    assert.equal(betaRecovered.id, betaBefore.id);
    assert.equal(betaRecovered.freshness, "fresh");
    assert.deepEqual(betaRecovered.availableActions, ["instance.start"]);
  });
});

test("global inventory exposes a known identity without prior observation as unobserved", async () => {
  await withStore(async (store) => {
    const binding = {
      id: "instance:550e8400-e29b-41d4-a716-446655440000",
      providerId: "legacy-provider",
      providerExternalId: "legacy-remote",
    };
    await store.write({ version: 1, plugins: [], instances: [binding] });

    const registry = new ProviderRegistry();
    registerProvider(registry, {
      providerId: "legacy-provider",
      capabilities: [],
      list: async () => {
        throw normalizedError("provider-unavailable", "fixture provider outage");
      },
      get: async () => undefined,
    });

    const result = await new ComputeManager(registry, store).listInventory(context);
    assert.equal(result.complete, false);
    assert.deepEqual(result.instances, [
      {
        ...binding,
        management: "discovered",
        freshness: "unobserved",
        availableActions: [],
      },
    ]);
  });
});

test("global inventory fans out provider reads while preserving provider order", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const alphaStarted = deferred();
    const betaStarted = deferred();
    const alphaResult = deferred();
    const betaResult = deferred();
    const alpha = {
      providerExternalId: "alpha-global",
      state: "running",
      rawState: "alpha-raw",
      availableActions: [],
    };
    const beta = {
      providerExternalId: "beta-global",
      state: "stopped",
      rawState: "beta-raw",
      availableActions: [],
    };

    registerProvider(registry, {
      providerId: "alpha-global-provider",
      capabilities: [],
      list: async () => {
        alphaStarted.resolve();
        return alphaResult.promise;
      },
      get: async () => alpha,
    });
    registerProvider(registry, {
      providerId: "beta-global-provider",
      capabilities: [],
      list: async () => {
        betaStarted.resolve();
        return betaResult.promise;
      },
      get: async () => beta,
    });

    const listing = new ComputeManager(registry, store).listInventory(context);
    await Promise.all([alphaStarted.promise, betaStarted.promise]);
    betaResult.resolve([beta]);
    alphaResult.resolve([alpha]);

    const result = await listing;
    assert.deepEqual(
      result.providers.map((provider) => provider.providerId),
      ["alpha-global-provider", "beta-global-provider"],
    );
    assert.deepEqual(
      result.instances.map((instance) => instance.providerExternalId),
      ["alpha-global", "beta-global"],
    );
  });
});

test("global inventory preserves root cancellation instead of returning partial failure", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const alphaStarted = deferred();
    const betaStarted = deferred();
    for (const [providerId, started] of [
      ["alpha-cancelled", alphaStarted],
      ["beta-cancelled", betaStarted],
    ]) {
      registerProvider(registry, {
        providerId,
        capabilities: [],
        list: async () => {
          started.resolve();
          return new Promise(() => {});
        },
        get: async () => undefined,
      });
    }

    const controller = new AbortController();
    const listing = new ComputeManager(registry, store).listInventory({
      signal: controller.signal,
    });
    await Promise.all([alphaStarted.promise, betaStarted.promise]);
    controller.abort();

    await assert.rejects(listing, (error) => error?.code === "cancelled");
  });
});

test("host deadline bounds a non-cooperative provider inventory read", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    registerProvider(registry, {
      providerId: "slow",
      capabilities: [],
      list: async () => new Promise(() => {}),
      get: async () => undefined,
    });

    await assert.rejects(
      new ComputeManager(
        registry,
        store,
        new HostOperationRunner(20),
      ).listInstances(context),
      (error) => error?.code === "timeout",
    );
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

test("wait converges on a normalized provider state by observation only", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const starting = {
      providerExternalId: "wait-remote",
      state: "starting",
      rawState: "BOOTING",
      availableActions: [],
    };
    const running = {
      ...starting,
      state: "running",
      rawState: "READY",
      availableActions: ["instance.stop"],
    };
    let getCalls = 0;
    let mutationCalls = 0;
    registerProvider(registry, {
      providerId: "wait-provider",
      capabilities: ["instance.stop"],
      list: async () => [starting],
      get: async () => (++getCalls < 2 ? starting : running),
      powerAction: async () => {
        mutationCalls += 1;
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);
    const result = await manager.waitForInstance(
      instance.id,
      "running",
      { timeoutMs: 250, initialPollMs: 5 },
      context,
    );

    assert.equal(result.instanceId, instance.id);
    assert.equal(result.observedState, "running");
    assert.equal(result.instance?.state, "running");
    assert.equal(getCalls, 2);
    assert.equal(mutationCalls, 0);
  });
});

test("wait reports timeout with the last observed normalized state", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "wait-timeout",
      state: "starting",
      rawState: "BOOTING",
      availableActions: [],
    };
    registerProvider(registry, {
      providerId: "wait-timeout-provider",
      capabilities: [],
      list: async () => [snapshot],
      get: async () => snapshot,
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);
    await assert.rejects(
      manager.waitForInstance(
        instance.id,
        "running",
        { timeoutMs: 30, initialPollMs: 5 },
        context,
      ),
      (error) =>
        error?.code === "timeout" &&
        /last observed state=starting/.test(error.message),
    );
  });
});

test("wait cancellation is explicit and does not dispatch a mutation", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "wait-cancel",
      state: "stopping",
      rawState: "STOPPING",
      availableActions: [],
    };
    let mutationCalls = 0;
    registerProvider(registry, {
      providerId: "wait-cancel-provider",
      capabilities: ["instance.start"],
      list: async () => [snapshot],
      get: async () => snapshot,
      powerAction: async () => {
        mutationCalls += 1;
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);
    const controller = new AbortController();
    const waiting = manager.waitForInstance(
      instance.id,
      "stopped",
      { timeoutMs: 500, initialPollMs: 50 },
      { signal: controller.signal },
    );
    await delay(10);
    controller.abort();

    await assert.rejects(
      waiting,
      (error) =>
        error?.code === "cancelled" &&
        /last observed state=stopping/.test(error.message),
    );
    assert.equal(mutationCalls, 0);
  });
});

test("wait can converge on confirmed absence without repeating destroy", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "wait-absent",
      state: "terminating",
      rawState: "DELETING",
      availableActions: [],
    };
    let getCalls = 0;
    let destroyCalls = 0;
    registerProvider(registry, {
      providerId: "wait-absent-provider",
      capabilities: ["instance.destroy"],
      list: async () => [snapshot],
      get: async () => (++getCalls === 1 ? snapshot : undefined),
      destroy: async () => {
        destroyCalls += 1;
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);
    const result = await manager.waitForInstance(
      instance.id,
      "absent",
      { timeoutMs: 250, initialPollMs: 5 },
      context,
    );

    assert.deepEqual(result, {
      instanceId: instance.id,
      target: "absent",
      observedState: "absent",
    });
    assert.equal(getCalls, 2);
    assert.equal(destroyCalls, 0);
    assert.equal(
      (await store.read()).instances?.some((binding) => binding.id === instance.id) ?? false,
      false,
    );
  });
});

test("per-instance available actions gate lifecycle mutations without a core state table", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const calls = [];
    const snapshots = new Map([
      [
        "can-stop",
        {
          providerExternalId: "can-stop",
          state: "running",
          rawState: "running",
          availableActions: ["instance.stop"],
        },
      ],
      [
        "cannot-stop",
        {
          providerExternalId: "cannot-stop",
          state: "running",
          rawState: "running",
          availableActions: [],
        },
      ],
    ]);

    registerProvider(registry, {
      providerId: "actions",
      capabilities: ["instance.stop"],
      list: async () => [...snapshots.values()],
      get: async (providerExternalId) => snapshots.get(providerExternalId),
      powerAction: async (providerExternalId, action) => {
        calls.push([providerExternalId, action]);
      },
    });

    const manager = new ComputeManager(registry, store);
    const instances = await manager.listInstances(context);
    const allowed = instances.find(
      (instance) => instance.providerExternalId === "can-stop",
    );
    const blocked = instances.find(
      (instance) => instance.providerExternalId === "cannot-stop",
    );

    await assert.rejects(
      manager.performAction(blocked.id, "instance.stop", context),
      (error) => error.code === "conflict",
    );
    assert.deepEqual(calls, []);

    await manager.performAction(allowed.id, "instance.stop", context);
    assert.deepEqual(calls, [["can-stop", "instance.stop"]]);
  });
});

test("provider capabilities reject unsupported actions before provider lookup", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    let getCalls = 0;
    const snapshot = {
      providerExternalId: "remote",
      state: "running",
      rawState: "running",
      availableActions: [],
    };
    registerProvider(registry, {
      providerId: "limited",
      capabilities: [],
      list: async () => [snapshot],
      get: async () => {
        getCalls += 1;
        return snapshot;
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);

    await assert.rejects(
      manager.performAction(instance.id, "instance.stop", context),
      (error) => error.code === "unsupported-operation",
    );
    assert.equal(getCalls, 0);
  });
});

test("discovered resources require explicit adoption before destroy", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    let getCalls = 0;
    let destroyCalls = 0;
    const snapshot = {
      providerExternalId: "manual-resource",
      state: "stopped",
      rawState: "stopped",
      availableActions: ["instance.destroy"],
    };
    registerProvider(registry, {
      providerId: "manual",
      capabilities: ["instance.destroy"],
      list: async () => [snapshot],
      get: async () => {
        getCalls += 1;
        return snapshot;
      },
      destroy: async () => {
        destroyCalls += 1;
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);
    assert.equal(instance.management, "discovered");

    await assert.rejects(
      manager.performAction(instance.id, "instance.destroy", context),
      (error) => error?.code === "conflict" && /adopt/.test(error.message),
    );
    assert.equal(getCalls, 0);
    assert.equal(destroyCalls, 0);

    await manager.adoptInstance(instance.id);
    const adopted = await manager.inspectInstance(instance.id, context);
    assert.equal(adopted.management, "managed");
    assert.equal(adopted.id, instance.id);
    await manager.performAction(instance.id, "instance.destroy", context);
    assert.equal(destroyCalls, 1);
  });
});

test("destroy uses its distinct destructive provider operation", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    let destroyCall;
    let powerCalls = 0;
    const snapshot = {
      providerExternalId: "destroy-me",
      state: "stopped",
      rawState: "stopped",
      availableActions: ["instance.destroy"],
    };
    registerProvider(registry, {
      providerId: "destructive",
      capabilities: ["instance.destroy"],
      list: async () => [snapshot],
      get: async () => snapshot,
      powerAction: async () => {
        powerCalls += 1;
      },
      destroy: async (providerExternalId) => {
        destroyCall = providerExternalId;
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);
    await manager.adoptInstance(instance.id);
    await manager.performAction(instance.id, "instance.destroy", context);

    assert.equal(destroyCall, "destroy-me");
    assert.equal(powerCalls, 0);
  });
});

test("a provider conflict triggers reconciliation without blind retry", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    let getCalls = 0;
    let mutationCalls = 0;
    const before = {
      providerExternalId: "racy",
      state: "running",
      rawState: "running",
      availableActions: ["instance.stop"],
    };
    const after = {
      providerExternalId: "racy",
      state: "stopped",
      rawState: "stopped",
      availableActions: ["instance.start"],
    };
    registerProvider(registry, {
      providerId: "racy-provider",
      capabilities: ["instance.start", "instance.stop"],
      list: async () => [before],
      get: async () => {
        getCalls += 1;
        return getCalls === 1 ? before : after;
      },
      powerAction: async () => {
        mutationCalls += 1;
        throw normalizedError("conflict", "remote state changed");
      },
    });

    const manager = new ComputeManager(registry, store);
    const [instance] = await manager.listInstances(context);

    await assert.rejects(
      manager.performAction(instance.id, "instance.stop", context),
      (error) => error.code === "conflict",
    );
    assert.equal(mutationCalls, 1);
    assert.equal(getCalls, 2);
  });
});

test("a failed provider action does not corrupt another provider binding", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const failing = {
      providerExternalId: "fails",
      state: "running",
      rawState: "running",
      availableActions: ["instance.stop"],
    };
    const healthy = {
      providerExternalId: "healthy",
      state: "running",
      rawState: "running",
      availableActions: [],
    };
    registerProvider(registry, {
      providerId: "failing",
      capabilities: ["instance.stop"],
      list: async () => [failing],
      get: async () => failing,
      powerAction: async () => {
        throw normalizedError("provider-unavailable", "provider outage");
      },
    });
    registerProvider(registry, {
      providerId: "healthy",
      capabilities: [],
      list: async () => [healthy],
      get: async () => healthy,
    });

    const manager = new ComputeManager(registry, store);
    const instances = await manager.listInstances(context);
    const failingInstance = instances.find(
      (instance) => instance.providerId === "failing",
    );
    const healthyInstance = instances.find(
      (instance) => instance.providerId === "healthy",
    );

    await assert.rejects(
      manager.performAction(failingInstance.id, "instance.stop", context),
      (error) => error.code === "provider-unavailable",
    );

    const persisted = await store.read();
    assert.equal(
      persisted.instances.some((binding) => binding.id === healthyInstance.id),
      true,
    );
  });
});

test("cancelled lifecycle mutation after dispatch reports outcome unknown, is not retried, and reconciles", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "remote",
      state: "running",
      rawState: "running",
      availableActions: ["instance.stop"],
    };
    let powerCalls = 0;
    let getCalls = 0;
    let markDispatched;
    const dispatched = new Promise((resolve) => {
      markDispatched = resolve;
    });

    registerProvider(registry, {
      providerId: "bounded",
      capabilities: ["instance.stop"],
      list: async () => [snapshot],
      get: async () => {
        getCalls += 1;
        return snapshot;
      },
      powerAction: async (_providerExternalId, _action, operationContext) => {
        powerCalls += 1;
        operationContext.markMutationDispatched();
        markDispatched();
        await new Promise((resolve) =>
          operationContext.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
    });

    const manager = new ComputeManager(
      registry,
      store,
      new HostOperationRunner(500),
    );
    const [instance] = await manager.listInstances(context);
    const controller = new AbortController();
    const action = manager.performAction(instance.id, "instance.stop", {
      signal: controller.signal,
    });

    await dispatched;
    controller.abort();

    await assert.rejects(action, (error) => error?.code === "outcome-unknown");
    assert.equal(powerCalls, 1);
    assert.equal(getCalls, 2);
  });
});

test("uncertain mutation does not discard stable local identity when reconciliation is unavailable", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "remote",
      state: "running",
      rawState: "running",
      availableActions: ["instance.destroy"],
    };
    let getCalls = 0;

    registerProvider(registry, {
      providerId: "uncertain",
      capabilities: ["instance.destroy"],
      list: async () => [snapshot],
      get: async () => {
        getCalls += 1;
        if (getCalls === 1) {
          return snapshot;
        }
        throw normalizedError("provider-unavailable", "fixture lookup is unavailable");
      },
      destroy: async () => {
        throw normalizedError("outcome-unknown", "fixture destroy is uncertain");
      },
    });

    const manager = new ComputeManager(registry, store);
    const [before] = await manager.listInstances(context);
    await manager.adoptInstance(before.id);

    await assert.rejects(
      manager.performAction(before.id, "instance.destroy", context),
      (error) => error?.code === "outcome-unknown",
    );
    assert.equal(getCalls, 2);

    const [after] = await manager.listInstances(context);
    assert.equal(after.providerExternalId, before.providerExternalId);
    assert.equal(after.id, before.id);
  });
});

test("outcome-unknown reconciliation honors definitive absence", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "remote-destroyed",
      state: "running",
      rawState: "running",
      availableActions: ["instance.destroy"],
    };
    let getCalls = 0;

    registerProvider(registry, {
      providerId: "definitive-after-mutation",
      capabilities: ["instance.destroy"],
      list: async () => [snapshot],
      get: async () => {
        getCalls += 1;
        return getCalls === 1 ? snapshot : undefined;
      },
      destroy: async () => {
        throw normalizedError("outcome-unknown", "fixture destroy result was lost");
      },
    });

    const manager = new ComputeManager(registry, store);
    const [before] = await manager.listInstances(context);
    await manager.adoptInstance(before.id);
    await assert.rejects(
      manager.performAction(before.id, "instance.destroy", context),
      (error) => error?.code === "outcome-unknown",
    );

    assert.equal(
      (await store.read()).instances?.some((binding) => binding.id === before.id) ?? false,
      false,
    );
  });
});

test("transient inspect and lifecycle lookup failures preserve canonical identity", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "remote-transient",
      state: "running",
      rawState: "running",
      availableActions: ["instance.stop"],
    };
    let unavailable = false;

    registerProvider(registry, {
      providerId: "transient",
      capabilities: ["instance.stop"],
      list: async () => [snapshot],
      get: async () => {
        if (unavailable) {
          throw normalizedError("provider-unavailable", "fixture provider is unavailable");
        }
        return snapshot;
      },
      powerAction: async () => assert.fail("mutation must not dispatch"),
    });

    const manager = new ComputeManager(registry, store);
    const [before] = await manager.listInstances(context);
    unavailable = true;

    await assert.rejects(
      manager.inspectInstance(before.id, context),
      (error) => error?.code === "provider-unavailable",
    );
    await assert.rejects(
      manager.performAction(before.id, "instance.stop", context),
      (error) => error?.code === "provider-unavailable",
    );

    unavailable = false;
    const [after] = await new ComputeManager(registry, store).listInstances(context);
    assert.equal(after.id, before.id);
  });
});

test("definitive getInstance absence removes the canonical binding", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const snapshot = {
      providerExternalId: "remote-gone",
      state: "running",
      rawState: "running",
      availableActions: [],
    };
    let absent = false;

    registerProvider(registry, {
      providerId: "definitive",
      capabilities: [],
      list: async () => [snapshot],
      get: async () => (absent ? undefined : snapshot),
    });

    const manager = new ComputeManager(registry, store);
    const [before] = await manager.listInstances(context);
    absent = true;
    assert.equal(await manager.inspectInstance(before.id, context), undefined);

    absent = false;
    const [after] = await new ComputeManager(registry, store).listInstances(context);
    assert.notEqual(after.id, before.id);
  });
});

test("same-provider refreshes serialize from remote observation through commit", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const initial = {
      providerExternalId: "remote-stale",
      state: "running",
      rawState: "running",
      availableActions: [],
    };
    const olderStarted = deferred();
    const newerStarted = deferred();
    const olderResult = deferred();
    const newerResult = deferred();
    let call = 0;

    registerProvider(registry, {
      providerId: "ordered",
      capabilities: [],
      list: async () => {
        call += 1;
        if (call === 1) {
          return [initial];
        }
        if (call === 2) {
          olderStarted.resolve();
          return olderResult.promise;
        }
        newerStarted.resolve();
        return newerResult.promise;
      },
      get: async () => undefined,
    });

    const firstManager = new ComputeManager(
      registry,
      new JsonStateStore(store.path),
    );
    const secondManager = new ComputeManager(
      registry,
      new JsonStateStore(store.path),
    );
    const [before] = await firstManager.refreshProvider("ordered", context);

    const older = firstManager.refreshProvider("ordered", context);
    await olderStarted.promise;
    const newer = secondManager.refreshProvider("ordered", context);
    assert.equal(
      await Promise.race([
        newerStarted.promise.then(() => "started"),
        delay(50).then(() => "blocked"),
      ]),
      "blocked",
    );

    olderResult.resolve([initial]);
    const [olderInstance] = await older;
    assert.equal(olderInstance.id, before.id);

    await newerStarted.promise;
    newerResult.resolve([]);
    assert.deepEqual(await newer, []);

    const state = await new JsonStateStore(store.path).read();
    assert.equal(
      state.instances?.some(
        (binding) => binding.providerExternalId === initial.providerExternalId,
      ) ?? false,
      false,
    );
  });
});

test("independent provider refreshes observe concurrently and merge", async () => {
  await withStore(async (store) => {
    const registry = new ProviderRegistry();
    const alpha = {
      providerExternalId: "alpha-remote",
      state: "running",
      rawState: "running",
      availableActions: [],
    };
    const beta = {
      providerExternalId: "beta-remote",
      state: "stopped",
      rawState: "stopped",
      availableActions: [],
    };
    const alphaStarted = deferred();
    const betaStarted = deferred();
    const alphaResult = deferred();
    const betaResult = deferred();
    registerProvider(registry, {
      providerId: "alpha-independent",
      capabilities: [],
      list: async () => {
        alphaStarted.resolve();
        return alphaResult.promise;
      },
      get: async () => alpha,
    });
    registerProvider(registry, {
      providerId: "beta-independent",
      capabilities: [],
      list: async () => {
        betaStarted.resolve();
        return betaResult.promise;
      },
      get: async () => beta,
    });

    const first = new ComputeManager(registry, new JsonStateStore(store.path));
    const second = new ComputeManager(registry, new JsonStateStore(store.path));
    const alphaRefresh = first.refreshProvider("alpha-independent", context);
    const betaRefresh = second.refreshProvider("beta-independent", context);
    await Promise.all([alphaStarted.promise, betaStarted.promise]);

    alphaResult.resolve([alpha]);
    betaResult.resolve([beta]);
    const [alphaInstances, betaInstances] = await Promise.all([
      alphaRefresh,
      betaRefresh,
    ]);

    assert.equal(alphaInstances[0].providerExternalId, alpha.providerExternalId);
    assert.equal(betaInstances[0].providerExternalId, beta.providerExternalId);
    const state = await new JsonStateStore(store.path).read();
    assert.deepEqual(
      new Set(state.instances?.map((binding) => binding.providerExternalId)),
      new Set([alpha.providerExternalId, beta.providerExternalId]),
    );
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
