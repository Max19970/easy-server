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
