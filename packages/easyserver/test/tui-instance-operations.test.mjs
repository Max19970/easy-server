import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultTuiInstanceMutationRunner } from "../dist/tui-instance-operations.js";

function runtimeFixture({ observedState = "running" } = {}) {
  const calls = [];
  const runtime = {
    instanceOperations: {
      async adopt(instanceId) {
        calls.push(["adopt", instanceId]);
      },
      async perform(request) {
        calls.push(["perform", request]);
        if (request.action === "instance.destroy") {
          const accepted = await request.interaction?.confirm?.(
            {
              summary: `Destroy Compute Instance ${request.instanceId}`,
              risks: ["destructive"],
              consequence: "destroys the provider resource; will close 1 active session before provider destroy",
            },
            {
              instanceId: request.instanceId,
              providerId: "fixture",
              management: "managed",
              impact: {
                sessionIds: ["session:1"],
                endpointIntentNames: ["comfy"],
                pendingCleanupCount: 0,
                affectedCount: 2,
              },
            },
            request.context,
          );
          assert.equal(accepted, true);
        }
      },
    },
    computeManager: {
      async inspectInstance(instanceId) {
        calls.push(["inspect", instanceId]);
        return {
          id: instanceId,
          providerId: "fixture",
          providerExternalId: "remote-1",
          management: "managed",
          state: observedState,
          rawState: observedState,
          availableActions: [],
        };
      },
      async waitForInstance(instanceId, target, options) {
        calls.push(["wait", instanceId, target, options.timeoutMs]);
        return { instanceId, target, observedState: target };
      },
    },
  };
  return { runtime, calls };
}

test("TUI lifecycle runner dispatches through InstanceOperations and observes convergence through ComputeManager", async () => {
  for (const [action, target] of [
    ["instance.start", "running"],
    ["instance.stop", "stopped"],
    ["instance.restart", "running"],
  ]) {
    const { runtime, calls } = runtimeFixture();
    const progress = [];
    const runner = createDefaultTuiInstanceMutationRunner(undefined, {
      waitTimeoutMs: 1234,
      async createRuntime() {
        return runtime;
      },
    });

    const result = await runner(
      { kind: "action", instanceId: "instance:1", action },
      { progress: (phase) => progress.push(phase) },
    );

    assert.deepEqual(progress, ["dispatching", "observing"]);
    assert.equal(calls[0][0], "perform");
    assert.equal(calls[0][1].action, action);
    assert.deepEqual(calls[1], ["wait", "instance:1", target, 1234]);
    assert.equal(result.observedState, target);
  }
});

test("TUI destroy runner enables coordinated connection close and forwards host confirmation details", async () => {
  const { runtime, calls } = runtimeFixture();
  const confirmations = [];
  const runner = createDefaultTuiInstanceMutationRunner(undefined, {
    async createRuntime() {
      return runtime;
    },
  });

  const result = await runner(
    {
      kind: "action",
      instanceId: "instance:destroy-me",
      action: "instance.destroy",
    },
    {
      async confirm(prompt, details) {
        confirmations.push({ prompt, details });
        return true;
      },
    },
  );

  const perform = calls.find(([kind]) => kind === "perform")[1];
  assert.equal(perform.closeConnections, true);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].details.providerId, "fixture");
  assert.equal(confirmations[0].details.management, "managed");
  assert.deepEqual(confirmations[0].details.impact.sessionIds, ["session:1"]);
  assert.deepEqual(confirmations[0].details.impact.endpointIntentNames, ["comfy"]);
  assert.deepEqual(calls.at(-1), ["wait", "instance:destroy-me", "absent", 60000]);
  assert.equal(result.observedState, "absent");
});

test("TUI adoption uses the host adoption operation and verifies the same canonical instance afterward", async () => {
  const { runtime, calls } = runtimeFixture({ observedState: "stopped" });
  const runner = createDefaultTuiInstanceMutationRunner(undefined, {
    async createRuntime() {
      return runtime;
    },
  });

  const result = await runner({ kind: "adopt", instanceId: "instance:adopt-me" });

  assert.deepEqual(calls, [
    ["adopt", "instance:adopt-me"],
    ["inspect", "instance:adopt-me"],
  ]);
  assert.equal(result.observedState, "stopped");
});
