import assert from "node:assert/strict";
import test from "node:test";
import { normalizedError } from "@easyai101/easyserver-plugin-sdk";
import {
  createDefaultTuiBulkInstanceMutationRunner,
  createDefaultTuiInstanceMutationRunner,
} from "../dist/tui-instance-operations.js";

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

test("TUI bulk lifecycle delegates one host bulk mutation and observes only confirmed successes through ComputeManager", async () => {
  const calls = [];
  const context = { signal: new AbortController().signal };
  const runtime = {
    instanceOperations: {
      async performBulk(request) {
        calls.push(["bulk", request]);
        return {
          action: request.action,
          results: [
            { instanceId: "instance:a", status: "completed" },
            {
              instanceId: "instance:b",
              status: "failed",
              error: {
                code: "unsupported-operation",
                message: "stop unsupported",
              },
            },
            {
              instanceId: "instance:c",
              status: "outcome-unknown",
              error: {
                code: "outcome-unknown",
                message: "provider response lost after dispatch",
              },
            },
          ],
          summary: { requested: 3, completed: 1, failed: 1, outcomeUnknown: 1 },
        };
      },
    },
    computeManager: {
      async waitForInstance(instanceId, target, options, operationContext) {
        calls.push(["wait", instanceId, target, options.timeoutMs, operationContext]);
        return { instanceId, target, observedState: "stopped" };
      },
    },
  };
  const progress = [];
  const runner = createDefaultTuiBulkInstanceMutationRunner(undefined, {
    waitTimeoutMs: 2345,
    async createRuntime() {
      return runtime;
    },
  });

  const result = await runner(
    {
      instanceIds: ["instance:a", "instance:b", "instance:c"],
      action: "instance.stop",
    },
    context,
    { progress: (phase) => progress.push(phase) },
  );

  assert.deepEqual(progress, ["dispatching", "observing"]);
  assert.equal(calls.filter(([kind]) => kind === "bulk").length, 1);
  const bulkRequest = calls[0][1];
  assert.deepEqual(bulkRequest.instanceIds, ["instance:a", "instance:b", "instance:c"]);
  assert.equal(bulkRequest.action, "instance.stop");
  assert.equal(bulkRequest.context, context);
  assert.deepEqual(calls.slice(1), [
    ["wait", "instance:a", "stopped", 2345, context],
  ]);
  assert.deepEqual(result.summary, {
    requested: 3,
    completed: 1,
    failed: 1,
    outcomeUnknown: 1,
  });
  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].observedState, "stopped");
  assert.equal(result.results[1].status, "failed");
  assert.equal(result.results[2].status, "outcome-unknown");
});

test("TUI bulk destroy forwards the exact host confirmation set and coordinated connection close", async () => {
  const confirmations = [];
  const context = { signal: new AbortController().signal };
  let requestSeen;
  const runtime = {
    instanceOperations: {
      async performBulk(request) {
        requestSeen = request;
        const accepted = await request.interaction.confirm(
          {
            summary: "Destroy 2 Compute Instances: instance:a (provider=alpha), instance:b (provider=beta)",
            risks: ["destructive"],
            consequence: "permanently deletes the selected provider resources",
          },
          {
            targets: [
              { instanceId: "instance:a", providerId: "alpha", management: "managed" },
              { instanceId: "instance:b", providerId: "beta", management: "managed" },
            ],
            closeConnections: true,
          },
          context,
        );
        assert.equal(accepted, true);
        return {
          action: request.action,
          results: [
            { instanceId: "instance:a", status: "completed" },
            { instanceId: "instance:b", status: "completed" },
          ],
          summary: { requested: 2, completed: 2, failed: 0, outcomeUnknown: 0 },
        };
      },
    },
    computeManager: {
      async waitForInstance(instanceId) {
        return { instanceId, observedState: "absent" };
      },
    },
  };
  const runner = createDefaultTuiBulkInstanceMutationRunner(undefined, {
    async createRuntime() {
      return runtime;
    },
  });

  const result = await runner(
    {
      instanceIds: ["instance:a", "instance:b"],
      action: "instance.destroy",
    },
    context,
    {
      async confirm(prompt, details) {
        confirmations.push({ prompt, details });
        return true;
      },
    },
  );

  assert.equal(requestSeen.closeConnections, true);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0].details.targets.map((target) => target.instanceId), [
    "instance:a",
    "instance:b",
  ]);
  assert.equal(confirmations[0].details.closeConnections, true);
  assert.deepEqual(result.results.map((item) => item.observedState), ["absent", "absent"]);
});

test("TUI bulk runner preserves confirmed mutation success when post-dispatch convergence is cancelled", async () => {
  const controller = new AbortController();
  const runtime = {
    instanceOperations: {
      async performBulk(request) {
        controller.abort();
        return {
          action: request.action,
          results: [{ instanceId: "instance:a", status: "completed" }],
          summary: { requested: 1, completed: 1, failed: 0, outcomeUnknown: 0 },
        };
      },
    },
    computeManager: {
      async waitForInstance() {
        throw normalizedError("cancelled", "Observation cancelled after dispatch");
      },
    },
  };
  const runner = createDefaultTuiBulkInstanceMutationRunner(undefined, {
    async createRuntime() {
      return runtime;
    },
  });

  const result = await runner(
    { instanceIds: ["instance:a"], action: "instance.restart" },
    { signal: controller.signal },
  );

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].observationError.code, "cancelled");
  assert.match(result.results[0].observationError.message, /after dispatch/);
});

test("TUI bulk runner preserves host pre-dispatch cancellation results without starting observation", async () => {
  const controller = new AbortController();
  controller.abort();
  let waits = 0;
  const runtime = {
    instanceOperations: {
      async performBulk(request) {
        assert.equal(request.context.signal.aborted, true);
        return {
          action: request.action,
          results: [
            {
              instanceId: "instance:a",
              status: "failed",
              error: { code: "cancelled", message: "cancelled before dispatch" },
            },
          ],
          summary: { requested: 1, completed: 0, failed: 1, outcomeUnknown: 0 },
        };
      },
    },
    computeManager: {
      async waitForInstance() {
        waits += 1;
      },
    },
  };
  const runner = createDefaultTuiBulkInstanceMutationRunner(undefined, {
    async createRuntime() {
      return runtime;
    },
  });

  const result = await runner(
    { instanceIds: ["instance:a"], action: "instance.start" },
    { signal: controller.signal },
  );

  assert.equal(waits, 0);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].error.code, "cancelled");
});
