import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import {
  hostTrustRequiredError,
  normalizedError,
} from "@easyai101/easyserver-plugin-sdk";
import { renderTui, TuiApp, TuiShell } from "../dist/tui.js";
import {
  presentMutationConfirmation,
  presentOperationError,
  presentProviderExecution,
} from "../dist/tui-operation-model.js";
import {
  CaptureOutput,
  TtyInput,
  chooseVisibleAction,
  flushEscape,
  foregroundConnectionSnapshot,
  moveHomeCursor,
  openConnectionsRoute,
  openDiagnosticsRoute,
  openProvidersRoute,
  openRentRoute,
  openServersRoute,
  persistentConnectionSnapshot,
  readSnapshot,
  renderAtTerminal,
  returnHome,
  shell,
  tick,
  typeText,
} from "./tui-test-helpers.mjs";

test.afterEach(() => cleanup());

test("degraded provider state remains visible while healthy instance inventory stays usable", async () => {
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/healthy",
          state: "loaded",
          readiness: "ready",
          pluginId: "fixture.healthy",
          displayName: "Healthy Provider",
          providerId: "healthy",
          version: "1.0.0",
          credentials: { configured: 1, declared: 1, missingRequired: 0 },
        },
        {
          source: "./broken-plugin.mjs",
          state: "failed",
          readiness: "failed",
          credentials: { configured: 0, declared: 0, missingRequired: 0 },
          failure: "incompatible",
        },
      ],
    },
    instances: {
      status: "ready",
      complete: false,
      providerOutcomes: [
        { providerId: "healthy", status: "fresh" },
        {
          providerId: "offline",
          status: "failed",
          error: {
            code: "provider-unavailable",
            message: "Provider offline inventory refresh failed",
          },
        },
      ],
      items: [
        {
          id: "instance:healthy-1",
          providerId: "healthy",
          providerExternalId: "remote-1",
          management: "managed",
          name: "Healthy GPU",
          freshness: "fresh",
          state: "running",
          rawState: "READY",
          observedAt: "2026-08-12T10:00:00.000Z",
          availableActions: [],
        },
      ],
    },
    daemon: {
      status: "running",
      sessions: { status: "ready", total: 1, live: 1, closing: 0, failed: 0 },
      endpointIntents: {
        status: "ready",
        total: 1,
        live: 1,
        starting: 0,
        error: 0,
        disabled: 0,
      },
    },
  });
  const view = render(shell({ width: 100, readSnapshot: snapshot, readStatus: "ready" }));

  assert.match(view.lastFrame(), /What do you want to do/);
  assert.match(view.lastFrame(), /My servers/);
  assert.doesNotMatch(view.lastFrame(), /Provider issues/);
  assert.doesNotMatch(view.lastFrame(), /Daemon:/);

  await openServersRoute(view);
  assert.match(view.lastFrame(), /Some providers are unavailable/);
  assert.match(view.lastFrame(), /offline.*provider-unavailable/);
  assert.match(view.lastFrame(), /> Healthy GPU · running/);
  assert.doesNotMatch(view.lastFrame(), /Normalized state: running/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Normalized state: running/);
  assert.match(view.lastFrame(), /Available lifecycle actions: none/);

  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /Healthy Provider · ready/);
  assert.match(view.lastFrame(), /broken-plugin\.mjs · failed/);
});

test("stale retained instance state is visibly distinct from a fresh provider observation", async () => {
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: false,
      providerOutcomes: [
        {
          providerId: "offline",
          status: "failed",
          error: {
            code: "provider-unavailable",
            message: "Provider offline inventory refresh failed",
          },
        },
      ],
      items: [
        {
          id: "instance:retained",
          providerId: "offline",
          providerExternalId: "remote-retained",
          management: "managed",
          name: "Retained GPU",
          freshness: "stale",
          state: "running",
          observedAt: "2026-08-12T10:00:00.000Z",
          availableActions: ["instance.stop"],
        },
      ],
    },
  });
  const view = render(shell({
    width: 100,
    readSnapshot: snapshot,
    readStatus: "ready",
    onInstanceMutation() {},
  }));

  await openServersRoute(view);

  assert.match(view.lastFrame(), /> Retained GPU · running · needs refresh/);
  assert.doesNotMatch(view.lastFrame(), /Last observed:/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Freshness: stale/);
  assert.match(view.lastFrame(), /Last observed: 2026-08-12T10:00:00\.000Z/);
  assert.match(view.lastFrame(), /retained last-known state/);
  assert.match(view.lastFrame(), /Available lifecycle actions: none/);
  assert.match(view.lastFrame(), /stale or unobserved state is\s+read-only/);
});

test("empty instance guidance reflects configured but degraded providers", async () => {
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/provider",
          state: "loaded",
          readiness: "ready",
          providerId: "fixture",
          credentials: { configured: 0, declared: 0, missingRequired: 0 },
        },
      ],
    },
    instances: {
      status: "ready",
      complete: false,
      items: [],
      providerOutcomes: [
        { providerId: "healthy", status: "fresh" },
        {
          providerId: "fixture",
          status: "failed",
          error: {
            code: "provider-unavailable",
            message: "Provider fixture inventory refresh failed",
          },
        },
      ],
    },
  });
  const view = render(shell({ width: 100, readSnapshot: snapshot, readStatus: "ready" }));

  await openServersRoute(view);
  assert.match(view.lastFrame(), /No servers were reported by available providers/i);
  assert.match(view.lastFrame(), /unavailable providers may have\s+additional servers/i);
  assert.doesNotMatch(view.lastFrame(), /because provider inventory is incomplete/i);
  assert.doesNotMatch(view.lastFrame(), /Configure a provider first/);

  assert.match(view.lastFrame(), /Some providers are unavailable/);
  assert.match(view.lastFrame(), /Available provider results remain usable/);
  assert.match(view.lastFrame(), /Open Providers or Diagnostics/);
  assert.doesNotMatch(view.lastFrame(), /Review the provider issue/);
  assert.doesNotMatch(view.lastFrame(), /Configure a provider first/);
});

test("instance actions come only from provider-declared availableActions", async () => {
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [
        {
          id: "instance:a",
          providerId: "fixture",
          providerExternalId: "remote-a",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: [],
        },
        {
          id: "instance:b",
          providerId: "fixture",
          providerExternalId: "remote-b",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: ["instance.stop", "instance.destroy"],
        },
      ],
    },
  });
  const view = render(shell({ width: 100, readSnapshot: snapshot, readStatus: "ready" }));

  await openServersRoute(view);
  assert.match(view.lastFrame(), /> Server #1 · running/);
  assert.doesNotMatch(view.lastFrame(), /Available lifecycle actions:/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Available lifecycle actions: none/);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Server #2 · running/);
  assert.doesNotMatch(view.lastFrame(), /Available lifecycle actions:/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Available lifecycle actions: Stop server, Destroy server/);
});

test("Instances multi-select preserves the exact target set and uses host bulk action semantics", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
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
          availableActions: ["instance.stop"],
        },
        {
          id: "instance:b",
          providerId: "beta",
          providerExternalId: "remote-b",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: ["instance.restart"],
        },
      ],
    },
  });
  const view = render(shell({
    width: 100,
    readSnapshot: snapshot,
    readStatus: "ready",
    onBulkInstanceMutation(mutation) {
      mutations.push(mutation);
    },
  }));

  await openServersRoute(view);
  await chooseVisibleAction(view, "Add to bulk selection");
  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Add to bulk selection");

  assert.match(view.lastFrame(), /Selected servers \(2\)/);
  assert.match(view.lastFrame(), /Server #1 · running/);
  assert.match(view.lastFrame(), /Server #2 · running/);
  assert.doesNotMatch(view.lastFrame(), /instance:a|instance:b|provider=alpha|provider=beta|remote-a|remote-b/);
  await chooseVisibleAction(view, "stop 2 selected servers");
  assert.deepEqual(mutations, [
    {
      instanceIds: ["instance:a", "instance:b"],
      action: "instance.stop",
    },
  ]);

  await chooseVisibleAction(view, "Clear bulk selection");
  assert.doesNotMatch(view.lastFrame(), /Selected servers \(2\)/);
});

test("bulk mutation failure drawer hides canonical and provider identity", async () => {
  let received;
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () =>
        readSnapshot({
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
                name: "Alpha server",
                providerId: "alpha",
                providerExternalId: "remote-a",
                management: "managed",
                freshness: "fresh",
                state: "running",
                availableActions: ["instance.stop"],
              },
              {
                id: "instance:b",
                name: "Beta server",
                providerId: "beta",
                providerExternalId: "remote-b",
                management: "managed",
                freshness: "fresh",
                state: "running",
                availableActions: ["instance.stop"],
              },
            ],
          },
        }),
      async bulkInstanceMutationRunner(mutation) {
        received = mutation;
        throw normalizedError(
          "provider-unavailable",
          "alpha / remote-a / instance:a / beta / remote-b / instance:b",
        );
      },
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Add to bulk selection");
  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Add to bulk selection");
  await chooseVisibleAction(view, "stop 2 selected servers");
  await tick();
  await tick();

  assert.deepEqual(received, {
    instanceIds: ["instance:a", "instance:b"],
    action: "instance.stop",
  });
  assert.match(view.lastFrame(), /Could not reach one or more selected servers/);
  assert.doesNotMatch(view.lastFrame(), /instance:a|instance:b|remote-a|remote-b|alpha \/|beta \/|provider=alpha|provider=beta/);
});

test("instance selection is preserved by canonical ID across reorder and narrow layout", async () => {
  const instanceA = {
    id: "instance:a",
    name: "Server A",
    providerId: "fixture",
    providerExternalId: "remote-a",
    management: "managed",
    freshness: "fresh",
    state: "running",
    rawState: "RUNNING",
    availableActions: [],
  };
  const instanceB = {
    id: "instance:b",
    name: "Server B",
    providerId: "fixture",
    providerExternalId: "remote-b",
    management: "discovered",
    freshness: "fresh",
    state: "stopped",
    rawState: "STOPPED",
    availableActions: ["instance.start"],
  };
  const first = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [instanceA, instanceB],
    },
  });
  const reordered = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [instanceB, instanceA],
    },
  });
  const view = render(shell({ width: 100, readSnapshot: first, readStatus: "ready" }));

  await openServersRoute(view);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Server B · stopped/);

  view.rerender(shell({ width: 60, readSnapshot: reordered, readStatus: "ready" }));
  await tick();
  assert.match(view.lastFrame(), /Home › Servers/);
  assert.match(view.lastFrame(), /> Server B · stopped/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Provider: fixture/);
  assert.match(view.lastFrame(), /Management: discovered/);
  assert.match(view.lastFrame(), /Normalized state: stopped/);
});

test("discovered instances expose adoption and reversible provider actions but never destroy", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [
        {
          id: "instance:discovered",
          name: "Imported server",
          providerId: "fixture",
          providerExternalId: "remote-discovered",
          management: "discovered",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: ["instance.stop", "instance.destroy"],
        },
      ],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: snapshot,
      readStatus: "ready",
      onInstanceMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openServersRoute(view);

  assert.match(view.lastFrame(), /> Imported server · running/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Adopt for EasyServer management/);
  assert.match(view.lastFrame(), /Stop server/);
  assert.doesNotMatch(view.lastFrame(), /Destroy server/);
  view.stdin.write("\u001b");
  await flushEscape();

  await chooseVisibleAction(view, "Stop server");
  await chooseVisibleAction(view, "Adopt for EasyServer management");
  assert.deepEqual(mutations, [
    {
      kind: "action",
      instanceId: "instance:discovered",
      action: "instance.stop",
    },
    { kind: "adopt", instanceId: "instance:discovered" },
  ]);
});

test("disappearing selected instance never silently retargets lifecycle input", async () => {
  const mutations = [];
  const onInstanceMutation = (mutation) => mutations.push(mutation);
  const instanceA = {
    id: "instance:a",
    name: "Server A",
    providerId: "fixture",
    providerExternalId: "remote-a",
    management: "managed",
    freshness: "fresh",
    state: "stopped",
    rawState: "STOPPED",
    availableActions: ["instance.start"],
  };
  const instanceB = {
    ...instanceA,
    id: "instance:b",
    name: "Server B",
    providerExternalId: "remote-b",
  };
  const first = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [instanceA, instanceB],
    },
  });
  const second = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [instanceA],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: first,
      readStatus: "ready",
      onInstanceMutation,
    }),
  );

  await openServersRoute(view);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Server B · stopped/);

  view.rerender(
    shell({
      width: 100,
      readSnapshot: second,
      readStatus: "ready",
      onInstanceMutation,
    }),
  );
  await tick();
  assert.match(view.lastFrame(), /Selected server is no longer visible/);
  assert.match(view.lastFrame(), /previously selected server disappeared from the refreshed inventory/);
  assert.match(view.lastFrame(), /No action target was\s+changed/);

  view.stdin.write("1");
  await tick();
  assert.deepEqual(mutations, []);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Server A · stopped/);
  await chooseVisibleAction(view, "Start server");
  assert.deepEqual(mutations, [
    { kind: "action", instanceId: "instance:a", action: "instance.start" },
  ]);
});

test("TuiApp destroy review shows provenance and connection consequences before observing completion", async () => {
  let destroyed = false;
  let loaderCalls = 0;
  let runnerCalls = 0;
  let finishObservation;
  const observationGate = new Promise((resolve) => {
    finishObservation = resolve;
  });
  const loader = async () => {
    loaderCalls += 1;
    return readSnapshot({
      instances: {
        status: "ready",
        complete: true,
        providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
        items: destroyed
          ? []
          : [
              {
                id: "instance:managed",
                providerId: "fixture",
                providerExternalId: "remote-managed",
                management: "managed",
                freshness: "fresh",
                state: "running",
                rawState: "RUNNING",
                availableActions: ["instance.destroy"],
              },
            ],
      },
    });
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async instanceMutationRunner(mutation, interaction) {
        runnerCalls += 1;
        assert.deepEqual(mutation, {
          kind: "action",
          instanceId: "instance:managed",
          action: "instance.destroy",
        });
        interaction.progress?.("dispatching");
        const accepted = await interaction.confirm?.(
          {
            summary: "Destroy Compute Instance instance:managed",
            risks: ["destructive"],
            consequence:
              "destroys the provider resource; will close 1 active session and 1 Endpoint intent before provider destroy",
          },
          {
            instanceId: "instance:managed",
            providerId: "fixture",
            management: "managed",
            impact: {
              sessionIds: ["session:active"],
              endpointIntentNames: ["comfy"],
              pendingCleanupCount: 0,
              affectedCount: 2,
            },
          },
          { signal: new AbortController().signal },
        );
        assert.equal(accepted, true);
        interaction.progress?.("observing");
        await observationGate;
        destroyed = true;
        return { observedState: "absent" };
      },
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Destroy server");

  assert.equal(runnerCalls, 1);
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /Target: Server/);
  assert.match(view.lastFrame(), /1 background connection/);
  assert.match(view.lastFrame(), /1 saved background connection definition/);
  assert.match(view.lastFrame(), /permanently destroys the selected server/);
  assert.doesNotMatch(
    view.lastFrame(),
    /instance:managed|provider=fixture|Session session:active|Endpoint intent comfy|Access Method|daemon/i,
  );

  assert.match(view.lastFrame(), /> Cancel/);
  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /observing/);
  assert.match(view.lastFrame(), /Observing Server until its state converges/);

  finishObservation();
  await tick();
  await tick();
  await tick();
  assert.equal(loaderCalls, 2);
  assert.match(view.lastFrame(), /Destroy server completed/);
  assert.match(view.lastFrame(), /observed state=absent/);
  assert.match(view.lastFrame(), /No servers yet/);
});

test("TuiApp outcome-unknown offers observation refresh without redispatching the instance mutation", async () => {
  let loaderCalls = 0;
  let runnerCalls = 0;
  const loader = async () => {
    loaderCalls += 1;
    return readSnapshot({
      instances: {
        status: "ready",
        complete: true,
        providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
        items: [
          {
            id: "instance:uncertain",
            providerId: "fixture",
            providerExternalId: "remote-uncertain",
            management: "managed",
            freshness: "fresh",
            state: "stopped",
            rawState: "STOPPED",
            availableActions: ["instance.start"],
          },
        ],
      },
    });
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async instanceMutationRunner(_mutation, interaction) {
        runnerCalls += 1;
        interaction.progress?.("dispatching");
        throw normalizedError(
          "outcome-unknown",
          "Provider response was lost after dispatch",
        );
      },
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Start server");
  await tick();
  await tick();

  assert.equal(runnerCalls, 1);
  assert.match(view.lastFrame(), /Start server: outcome unknown/);
  assert.match(view.lastFrame(), /Observe state/);
  assert.match(view.lastFrame(), /Refresh/);
  assert.doesNotMatch(view.lastFrame(), /Retry/);

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.equal(loaderCalls, 2);
  assert.equal(runnerCalls, 1);
  assert.doesNotMatch(view.lastFrame(), /outcome unknown/);
});
