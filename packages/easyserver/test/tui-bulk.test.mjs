import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TuiApp } from "../dist/tui.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function snapshot(action) {
  return {
    providerWorkflows: { status: "ready", items: [] },
    providers: { status: "ready", items: [] },
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [
        { providerId: "alpha", status: "fresh" },
        { providerId: "beta", status: "fresh" },
      ],
      items: [
        {
          id: "instance:a",
          providerId: "alpha",
          providerExternalId: "remote-a",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: [action],
        },
        {
          id: "instance:b",
          providerId: "beta",
          providerExternalId: "remote-b",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: [action],
        },
      ],
    },
    daemon: { status: "stopped" },
  };
}

async function openInstancesAndMarkBoth(view) {
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write(" ");
  await tick();
  view.stdin.write("j");
  await tick();
  view.stdin.write(" ");
  await tick();
}

test("TuiApp bulk destroy reviews exact targets and preserves mixed outcomes", async () => {
  let loaderCalls = 0;
  let runnerCalls = 0;
  const current = snapshot("instance.destroy");
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        loaderCalls += 1;
        return current;
      },
      async bulkInstanceMutationRunner(mutation, context, interaction) {
        runnerCalls += 1;
        assert.deepEqual(mutation, {
          instanceIds: ["instance:a", "instance:b"],
          action: "instance.destroy",
        });
        interaction.progress?.("dispatching");
        const accepted = await interaction.confirm?.(
          {
            summary: "Destroy selected instances",
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
        interaction.progress?.("observing");
        return {
          action: mutation.action,
          results: [
            { instanceId: "instance:a", status: "completed", observedState: "absent" },
            {
              instanceId: "instance:b",
              status: "outcome-unknown",
              error: {
                code: "outcome-unknown",
                message: "provider response lost after dispatch",
              },
            },
          ],
          summary: { requested: 2, completed: 1, failed: 0, outcomeUnknown: 1 },
        };
      },
    }),
  );

  await tick();
  await tick();
  await openInstancesAndMarkBoth(view);
  view.stdin.write("1");
  await tick();

  assert.equal(runnerCalls, 1);
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /Target: 2 selected Compute Instances/);
  assert.match(view.lastFrame(), /instance:a · provider=alpha · management=managed/);
  assert.match(view.lastFrame(), /provider=beta · management=managed/);
  assert.match(view.lastFrame(), /Risk: destructive/);

  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();
  await tick();

  assert.equal(loaderCalls, 2);
  assert.match(view.lastFrame(), /requested=2 completed=1 failed=0 outcome-unknown=1/);
  assert.match(view.lastFrame(), /instance:a · completed · observed=absent/);
  assert.match(view.lastFrame(), /instance:b · outcome-unknown/);
  assert.doesNotMatch(view.lastFrame(), /Retry/);

  view.stdin.write("1");
  await tick();
  assert.equal(runnerCalls, 1);

  view.stdin.write("R");
  await tick();
  await tick();
  assert.equal(loaderCalls, 3);
  assert.equal(runnerCalls, 1);
});

test("TuiApp bulk cancellation keeps cancelled and outcome-unknown targets distinct", async () => {
  let runnerCalls = 0;
  let aborted = false;
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        return snapshot("instance.destroy");
      },
      async bulkInstanceMutationRunner(mutation, context, interaction) {
        runnerCalls += 1;
        interaction.progress?.("dispatching");
        const accepted = await interaction.confirm?.(
          {
            summary: "Destroy selected instances",
            risks: ["destructive"],
            consequence: "deletes the selected provider resources",
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
        await new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return {
          action: mutation.action,
          results: [
            {
              instanceId: "instance:a",
              status: "outcome-unknown",
              error: {
                code: "outcome-unknown",
                message: "cancelled after provider dispatch",
              },
            },
            {
              instanceId: "instance:b",
              status: "failed",
              error: { code: "cancelled", message: "cancelled before dispatch" },
            },
          ],
          summary: { requested: 2, completed: 0, failed: 1, outcomeUnknown: 1 },
        };
      },
    }),
  );

  await tick();
  await tick();
  await openInstancesAndMarkBoth(view);
  view.stdin.write("1");
  await tick();
  assert.match(view.lastFrame(), /Confirmation required/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /dispatching/);
  assert.match(view.lastFrame(), /Cancel/);

  view.stdin.write("c");
  await tick();
  assert.equal(aborted, true);
  await tick();
  await tick();

  assert.equal(runnerCalls, 1);
  assert.match(view.lastFrame(), /instance:a · outcome-unknown/);
  assert.match(view.lastFrame(), /instance:b · failed · cancelled · cancelled before dispatch/);
  assert.doesNotMatch(view.lastFrame(), /Retry/);
});
