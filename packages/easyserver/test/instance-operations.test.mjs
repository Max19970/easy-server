import assert from "node:assert/strict";
import test from "node:test";
import { normalizedError } from "@easyai101/easyserver-plugin-sdk";
import { InstanceOperations } from "../dist/instance-operations.js";

function context() {
  return { signal: new AbortController().signal };
}

test("instance operations delegate adoption and ordinary provider-declared lifecycle actions", async () => {
  const calls = [];
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance(instanceId) {
        calls.push(["adopt", instanceId]);
      },
      async performAction(instanceId, action, operationContext) {
        calls.push(["action", instanceId, action, operationContext.signal.aborted]);
      },
    },
    async readBinding(instanceId) {
      assert.equal(instanceId, "instance:alpha");
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: "remote-alpha",
        management: "discovered",
      };
    },
    async acquireDestroyGuard() {
      throw new Error("destroy guard must not be acquired for ordinary actions");
    },
  });

  await operations.adopt("instance:alpha");
  await operations.perform({
    instanceId: "instance:alpha",
    action: "instance.stop",
    context: context(),
  });

  assert.deepEqual(calls, [
    ["adopt", "instance:alpha"],
    ["action", "instance:alpha", "instance.stop", false],
  ]);
});

test("destroy confirmation includes provider, provenance and exact connection impact before coordinated cleanup", async () => {
  const events = [];
  let releases = 0;
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction(instanceId, action) {
        events.push(["dispatch", instanceId, action]);
      },
    },
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: "remote-alpha",
        management: "managed",
      };
    },
    async acquireDestroyGuard(instanceId) {
      assert.equal(instanceId, "instance:alpha");
      events.push(["guard"]);
      return {
        sessionIds: ["session-a", "session-b"],
        endpointIntentNames: ["comfy"],
        pendingCleanupCount: 1,
        affectedCount: 4,
        async closeAffectedConnections() {
          events.push(["close-connections"]);
        },
        async release() {
          releases += 1;
        },
      };
    },
  });
  const confirmations = [];

  await operations.perform({
    instanceId: "instance:alpha",
    action: "instance.destroy",
    closeConnections: true,
    context: context(),
    interaction: {
      async confirm(prompt, details) {
        confirmations.push({ prompt, details });
        return true;
      },
    },
  });

  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0].prompt.risks, ["destructive"]);
  assert.match(confirmations[0].prompt.summary, /instance:alpha/);
  assert.match(confirmations[0].prompt.summary, /provider=nebula/);
  assert.match(confirmations[0].prompt.summary, /managed/);
  assert.match(confirmations[0].prompt.consequence, /2 active sessions/);
  assert.match(confirmations[0].prompt.consequence, /1 Endpoint intent/);
  assert.match(confirmations[0].prompt.consequence, /1 pending cleanup/);
  assert.deepEqual(confirmations[0].details, {
    instanceId: "instance:alpha",
    providerId: "nebula",
    management: "managed",
    impact: {
      sessionIds: ["session-a", "session-b"],
      endpointIntentNames: ["comfy"],
      pendingCleanupCount: 1,
      affectedCount: 4,
    },
  });
  assert.deepEqual(events, [
    ["guard"],
    ["close-connections"],
    ["dispatch", "instance:alpha", "instance.destroy"],
  ]);
  assert.equal(releases, 1);
});

test("destroy without coordinated cleanup refuses active connections before provider dispatch", async () => {
  let dispatched = 0;
  let released = 0;
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction() {
        dispatched += 1;
      },
    },
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: "remote-alpha",
        management: "managed",
      };
    },
    async acquireDestroyGuard() {
      return {
        sessionIds: ["session-a"],
        endpointIntentNames: [],
        pendingCleanupCount: 0,
        affectedCount: 1,
        async closeAffectedConnections() {},
        async release() {
          released += 1;
        },
      };
    },
  });

  await assert.rejects(
    operations.perform({
      instanceId: "instance:alpha",
      action: "instance.destroy",
      closeConnections: false,
      context: context(),
      interaction: { async confirm() { return true; } },
    }),
    (error) => error?.code === "conflict" && /has EasyServer connections/.test(error.message),
  );
  assert.equal(dispatched, 0);
  assert.equal(released, 1);
});

test("destroy release failure cannot turn confirmed provider success into a retryable failure", async () => {
  let dispatched = 0;
  const warnings = [];
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction() {
        dispatched += 1;
      },
    },
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: "remote-alpha",
        management: "managed",
      };
    },
    async acquireDestroyGuard() {
      return {
        sessionIds: [],
        endpointIntentNames: [],
        pendingCleanupCount: 0,
        affectedCount: 0,
        async closeAffectedConnections() {},
        async release() {
          throw new Error("fixture release failed");
        },
      };
    },
  });

  await operations.perform({
    instanceId: "instance:alpha",
    action: "instance.destroy",
    context: context(),
    interaction: {
      assumeYes: true,
      warning(message) {
        warnings.push(message);
      },
    },
  });

  assert.equal(dispatched, 1);
  assert.deepEqual(warnings, [
    "Failed to release the daemon connection-drain guard; restart the daemon before creating new connections for this instance.",
  ]);
});

test("destroy declines before cleanup or provider mutation and unmanaged resources fail closed", async () => {
  let closeCalls = 0;
  let dispatchCalls = 0;
  let releaseCalls = 0;
  const managed = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction() {
        dispatchCalls += 1;
      },
    },
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: "remote-alpha",
        management: "managed",
      };
    },
    async acquireDestroyGuard() {
      return {
        sessionIds: [],
        endpointIntentNames: ["comfy"],
        pendingCleanupCount: 0,
        affectedCount: 1,
        async closeAffectedConnections() {
          closeCalls += 1;
        },
        async release() {
          releaseCalls += 1;
        },
      };
    },
  });

  await assert.rejects(
    managed.perform({
      instanceId: "instance:alpha",
      action: "instance.destroy",
      closeConnections: true,
      context: context(),
      interaction: { async confirm() { return false; } },
    }),
    (error) => error?.code === "cancelled",
  );
  assert.equal(closeCalls, 0);
  assert.equal(dispatchCalls, 0);
  assert.equal(releaseCalls, 1);

  const unmanaged = new InstanceOperations({
    manager: managed.manager,
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: "remote-alpha",
        management: "discovered",
      };
    },
    async acquireDestroyGuard() {
      throw normalizedError("conflict", "guard should not be reached");
    },
  });
  await assert.rejects(
    unmanaged.perform({
      instanceId: "instance:alpha",
      action: "instance.destroy",
      closeConnections: true,
      context: context(),
    }),
    (error) => error?.code === "conflict" && /adopt/.test(error.message),
  );
});

test("bulk lifecycle bounds concurrency and preserves partial and outcome-unknown results", async () => {
  let active = 0;
  let maxActive = 0;
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction(instanceId) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (instanceId === "instance:unsupported") {
          throw normalizedError(
            "unsupported-operation",
            "provider does not support this lifecycle action",
          );
        }
        if (instanceId === "instance:uncertain") {
          throw normalizedError(
            "outcome-unknown",
            "provider mutation may have been dispatched",
          );
        }
      },
    },
    async readBinding() {
      throw new Error("ordinary bulk actions must not pre-read bindings");
    },
    async acquireDestroyGuard() {
      throw new Error("ordinary bulk actions must not acquire destroy guards");
    },
  });

  const result = await operations.performBulk({
    instanceIds: [
      "instance:alpha",
      "instance:unsupported",
      "instance:beta",
      "instance:uncertain",
    ],
    action: "instance.stop",
    concurrency: 2,
    context: context(),
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(result.summary, {
    requested: 4,
    completed: 2,
    failed: 1,
    outcomeUnknown: 1,
  });
  assert.deepEqual(result.results, [
    { instanceId: "instance:alpha", status: "completed" },
    {
      instanceId: "instance:unsupported",
      status: "failed",
      error: {
        code: "unsupported-operation",
        message: "provider does not support this lifecycle action",
      },
    },
    { instanceId: "instance:beta", status: "completed" },
    {
      instanceId: "instance:uncertain",
      status: "outcome-unknown",
      error: {
        code: "outcome-unknown",
        message: "provider mutation may have been dispatched",
      },
    },
  ]);
});

test("bulk destroy confirms the exact mixed-provider target set once before dispatch", async () => {
  const dispatched = [];
  const guarded = [];
  const confirmations = [];
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction(instanceId, action) {
        dispatched.push([instanceId, action]);
      },
    },
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: instanceId.endsWith("alpha") ? "nebula" : "quasar",
        providerExternalId: `remote-${instanceId.slice("instance:".length)}`,
        management: "managed",
      };
    },
    async acquireDestroyGuard(instanceId) {
      guarded.push(instanceId);
      return {
        sessionIds: [],
        endpointIntentNames: [],
        pendingCleanupCount: 0,
        affectedCount: 0,
        async closeAffectedConnections() {},
        async release() {},
      };
    },
  });

  const result = await operations.performBulk({
    instanceIds: ["instance:alpha", "instance:beta", "instance:alpha"],
    action: "instance.destroy",
    closeConnections: true,
    context: context(),
    interaction: {
      async confirm(prompt, details) {
        confirmations.push({ prompt, details });
        return true;
      },
    },
  });

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].prompt.summary, /instance:alpha \(provider=nebula\)/);
  assert.match(confirmations[0].prompt.summary, /instance:beta \(provider=quasar\)/);
  assert.deepEqual(confirmations[0].details, {
    targets: [
      {
        instanceId: "instance:alpha",
        providerId: "nebula",
        management: "managed",
      },
      {
        instanceId: "instance:beta",
        providerId: "quasar",
        management: "managed",
      },
    ],
    closeConnections: true,
  });
  assert.deepEqual(dispatched, [
    ["instance:alpha", "instance.destroy"],
    ["instance:beta", "instance.destroy"],
  ]);
  assert.deepEqual(guarded.sort(), ["instance:alpha", "instance:beta"]);
  assert.deepEqual(result.summary, {
    requested: 2,
    completed: 2,
    failed: 0,
    outcomeUnknown: 0,
  });
});

test("bulk destroy refusal stops the whole target set before any guard or provider dispatch", async () => {
  let guarded = 0;
  let dispatched = 0;
  const operations = new InstanceOperations({
    manager: {
      async adoptInstance() {},
      async performAction() {
        dispatched += 1;
      },
    },
    async readBinding(instanceId) {
      return {
        id: instanceId,
        providerId: "nebula",
        providerExternalId: instanceId,
        management: "managed",
      };
    },
    async acquireDestroyGuard() {
      guarded += 1;
      throw new Error("must not acquire guard before bulk confirmation");
    },
  });

  await assert.rejects(
    operations.performBulk({
      instanceIds: ["instance:alpha", "instance:beta"],
      action: "instance.destroy",
      context: context(),
      interaction: {
        async confirm() {
          return false;
        },
      },
    }),
    (error) => error?.code === "cancelled",
  );
  assert.equal(guarded, 0);
  assert.equal(dispatched, 0);
});
