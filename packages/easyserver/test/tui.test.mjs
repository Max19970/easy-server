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

test("interactive TUI enters alternate screen and restores it when quitting", async () => {
  const stdin = new TtyInput();
  const stdout = new CaptureOutput();
  const stderr = new CaptureOutput();
  const app = renderTui({ stdin, stdout, stderr, env: {} });

  await app.waitUntilRenderFlush();
  assert.match(stdout.text(), /\u001b\[\?1049h/);
  assert.match(stdout.text(), /EasyServer/);

  stdin.write("q");
  await app.waitUntilExit();
  app.cleanup();
  assert.match(stdout.text(), /\u001b\[\?1049l/);
  assert.equal(stderr.text(), "");
});

test("interactive TUI restores alternate screen on Ctrl+C", async () => {
  const stdin = new TtyInput();
  const stdout = new CaptureOutput();
  const stderr = new CaptureOutput();
  const app = renderTui({ stdin, stdout, stderr, env: {} });

  await app.waitUntilRenderFlush();
  stdin.write("\u0003");
  await app.waitUntilExit();
  app.cleanup();

  assert.match(stdout.text(), /\u001b\[\?1049h/);
  assert.match(stdout.text(), /\u001b\[\?1049l/);
  assert.equal(stderr.text(), "");
});

test("screen-reader runtime stays linear and preserves task navigation and help semantics", async () => {
  const stdin = new TtyInput();
  const stdout = new CaptureOutput();
  const stderr = new CaptureOutput();
  const app = renderTui({
    stdin,
    stdout,
    stderr,
    env: { INK_SCREEN_READER: "true", NO_COLOR: "1" },
  });

  await app.waitUntilRenderFlush();
  assert.doesNotMatch(stdout.text(), /\u001b\[\?1049h/);
  assert.doesNotMatch(stdout.text(), /\u001b\[(?:3[0-9]|9[0-7])m/);
  assert.match(stdout.text(), /What do you want to do/);
  assert.match(stdout.text(), /Rent a server/);
  assert.match(stdout.text(), /My servers/);
  assert.match(stdout.text(), /Settings & Support/);
  assert.match(stdout.text(), /Commands: Up and Down move; Enter opens; question mark opens help; Ctrl\+C quits/);

  let offset = stdout.text().length;
  stdin.write("\u001b[B");
  await app.waitUntilRenderFlush();
  assert.match(stdout.text().slice(offset), /My servers/);

  offset = stdout.text().length;
  stdin.write("\r");
  await app.waitUntilRenderFlush();
  const openedServers = stdout.text().slice(offset);
  assert.match(openedServers, /Home › Servers/);
  assert.match(openedServers, /Servers/);

  offset = stdout.text().length;
  stdin.write("?");
  await app.waitUntilRenderFlush();
  const helpUpdate = stdout.text().slice(offset);
  assert.match(helpUpdate, /Keyboard help/);
  assert.match(helpUpdate, /Arrow keys — move through visible choices, items and actions/);
  assert.match(helpUpdate, /Ctrl\+C — quit safely/);
  assert.match(helpUpdate, /Local connections close safely with this TUI; background connections can remain available/);
  assert.doesNotMatch(helpUpdate, /Endpoint|Session|Access Method|daemon/i);

  stdin.write("q");
  await app.waitUntilExit();
  app.cleanup();
  assert.doesNotMatch(stdout.text(), /\u001b\[\?1049l/);
  assert.equal(stderr.text(), "");
});

test("risky confirmation owns the viewport and defaults focus to cancellation", async () => {
  const actions = [];
  const view = render(
    shell({
      width: 100,
      height: 24,
      operation: presentMutationConfirmation(
        {
          summary: "Rent one GPU",
          risks: ["billable"],
          consequence: "may create or increase provider charges",
        },
        {
          target: "Vast.ai marketplace",
          affectedResources: ["Provider inventory"],
        },
      ),
      onOperationAction(action) {
        actions.push(action);
      },
    }),
  );

  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /Target: Vast\.ai marketplace/);
  assert.match(view.lastFrame(), /Consequence: may create or increase provider charges/);
  assert.match(view.lastFrame(), /Affected resources \(1\)/);
  assert.match(view.lastFrame(), /Provider inventory/);
  assert.match(view.lastFrame(), /> Cancel/);
  assert.doesNotMatch(view.lastFrame(), /Overview \[active\]/);

  view.stdin.write("	");
  await tick();
  assert.match(view.lastFrame(), /> Cancel/);
  assert.doesNotMatch(view.lastFrame(), /Overview \[active\]/);

  view.stdin.write("\r");
  await tick();
  assert.deepEqual(actions, ["decline"]);
});

test("50-target destructive confirmation keeps Cancel visible and every target reviewable at 60x20", async (t) => {
  const operation = presentMutationConfirmation(
    {
      summary: "Destroy selected servers?",
      risks: ["destructive"],
      consequence: "Permanently destroys the selected servers and closes their managed connections.",
    },
    {
      target: "50 selected servers",
      affectedResources: Array.from({ length: 50 }, (_, index) => `Server ${String(index + 1).padStart(2, "0")}`),
    },
  );
  const view = renderAtTerminal(
    shell({ operation, onOperationAction() {} }),
    60,
    20,
  );
  t.after(() => view.cleanup());
  await view.flush();

  assert.match(view.lastFrame(), /Consequence: Permanently destroys/);
  assert.match(view.lastFrame(), /> Cancel/);
  assert.match(view.lastFrame(), /Affected resources \(50\)/);
  assert.match(view.lastFrame(), /Server 01/);
  assert.match(view.lastFrame(), /Showing 1–2 of 50 · PageUp\/PageDown review/);
  assert.ok(view.lastFrame().split("\n").length <= 20);

  for (let index = 0; index < 24; index += 1) {
    view.stdin.write("\u001b[6~");
    await tick();
    assert.match(view.lastFrame(), /> Cancel/);
    assert.ok(view.lastFrame().split("\n").length <= 20);
  }
  assert.match(view.lastFrame(), /Server 49/);
  assert.match(view.lastFrame(), /Server 50/);
  assert.match(view.lastFrame(), /Showing 49–50 of 50/);
});

test("risky confirmation requires an explicit focus move before approval", async () => {
  const actions = [];
  const view = render(
    shell({
      width: 100,
      height: 24,
      operation: presentMutationConfirmation(
        {
          summary: "Rent one GPU",
          risks: ["billable"],
          consequence: "may create or increase provider charges",
        },
        { target: "Vast.ai marketplace", affectedResources: [] },
      ),
      onOperationAction(action) {
        actions.push(action);
      },
    }),
  );

  view.stdin.write("\u001b[A");
  await tick();
  assert.match(view.lastFrame(), /> Confirm/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(actions, ["confirm"]);
});

test("outcome-unknown drawer maps the shared R shortcut to Refresh, never Retry", async () => {
  const actions = [];
  const view = render(
    shell({
      width: 100,
      operation: presentOperationError({
        title: "Rent GPU",
        operation: "mutation",
        error: {
          kind: "easyserver-error",
          code: "outcome-unknown",
          message: "The remote mutation may have been dispatched",
        },
      }),
      onOperationAction(action) {
        actions.push(action);
      },
    }),
  );

  assert.doesNotMatch(view.lastFrame(), /Retry/);
  assert.match(view.lastFrame(), /> Observe state/);
  assert.match(view.lastFrame(), /Refresh/);

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(actions, ["refresh", "observe"]);
  assert.equal(actions.includes("retry"), false);

});

test("untrusted structural operation presentations fail closed at the shell seam", async () => {
  const actions = [];
  const view = render(
    shell({
      width: 100,
      operation: {
        phase: "outcome-unknown",
        tone: "warning",
        title: "forged",
        actions: [{ kind: "retry", label: "\u001b[31mRetry" }],
        providerOutput: [
          { stream: "error", text: "\u001b[31mforged provider output" },
        ],
      },
      onOperationAction(action) {
        actions.push(action);
      },
    }),
  );

  await tick();
  assert.equal(view.lastFrame()?.trim(), "");
  view.stdin.write("R");
  await tick();
  assert.deepEqual(actions, []);
});

test("operation result actions use the same arrow, Enter and Escape vocabulary", async () => {
  const actions = [];
  const operation = presentProviderExecution("Rent GPU", {
    operation: "mutation",
    mutationOutcome: "succeeded",
    handoff: {
      status: "failed",
      failure: "inventory-refresh-failed",
      affectedProviderExternalIds: ["remote-1"],
      canonicalInstances: [],
      unresolvedProviderExternalIds: ["remote-1"],
    },
  });
  const view = render(
    shell({
      width: 100,
      operation,
      onOperationAction(action) {
        actions.push(action);
      },
    }),
  );

  assert.match(view.lastFrame(), /> Observe state/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Refresh/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(actions, ["refresh"]);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.deepEqual(actions, ["refresh", "dismiss"]);
});

test("read-only surfaces make zero-provider and zero-instance states actionable", async () => {
  const view = render(
    shell({ width: 100, readSnapshot: readSnapshot(), readStatus: "ready" }),
  );

  assert.match(view.lastFrame(), /What do you want to do/);
  assert.match(view.lastFrame(), /Rent a server/);
  assert.match(view.lastFrame(), /My servers/);

  await openServersRoute(view);
  assert.match(view.lastFrame(), /Home › Servers/);
  assert.match(view.lastFrame(), /No servers yet/);
  assert.match(view.lastFrame(), /Configure a provider first/);

  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /Providers/);
  assert.match(view.lastFrame(), /No providers added yet/);
  assert.doesNotMatch(view.lastFrame(), /easyserver plugins add/);
});

test("empty dependency states expose only truthful next actions at 60x20", async () => {
  const commonProps = {
    width: 60,
    height: 20,
    readSnapshot: readSnapshot(),
    readStatus: "ready",
    onProviderMutation() {},
    async onOpenForegroundConnection() {},
    async onListForegroundAccessMethods() {
      return [];
    },
  };

  const providersView = render(shell(commonProps));
  await openProvidersRoute(providersView);
  assert.match(providersView.lastFrame(), /No providers added yet/);
  assert.match(providersView.lastFrame(), /No installed provider packages were discovered/);
  assert.doesNotMatch(providersView.lastFrame(), /choose Add installed provider/i);
  providersView.stdin.write("\r");
  await tick();
  assert.doesNotMatch(providersView.lastFrame(), /Add installed provider/);
  assert.match(providersView.lastFrame(), /Advanced: add module or path/);
  assert.match(providersView.lastFrame(), /Refresh providers/);

  const rentView = render(shell(commonProps));
  await openRentRoute(rentView);
  assert.match(rentView.lastFrame(), /No provider acquisition workflows are available/);
  assert.match(rentView.lastFrame(), /Open Providers from Actions/);
  await chooseVisibleAction(rentView, "Open Providers");
  assert.match(rentView.lastFrame(), /Home › Settings & Support › Providers/);

  const connectionsView = render(shell(commonProps));
  await openConnectionsRoute(connectionsView);
  assert.match(connectionsView.lastFrame(), /Use Actions to rent a server first/);
  connectionsView.stdin.write("\r");
  await tick();
  assert.match(connectionsView.lastFrame(), /> Rent a server/);
  assert.doesNotMatch(connectionsView.lastFrame(), /New local connection/);
  connectionsView.stdin.write("\r");
  await tick();
  assert.match(connectionsView.lastFrame(), /Home › Servers › Rent server/);
});

test("screen-reader empty dependency guidance matches available actions", async () => {
  const commonProps = {
    width: 60,
    height: 20,
    screenReader: true,
    readSnapshot: readSnapshot(),
    readStatus: "ready",
    onProviderMutation() {},
    async onOpenForegroundConnection() {},
    async onListForegroundAccessMethods() {
      return [];
    },
  };

  const providersView = render(shell(commonProps));
  await openProvidersRoute(providersView);
  assert.match(providersView.lastFrame(), /No installed provider packages were discovered/);
  assert.doesNotMatch(providersView.lastFrame(), /choose Add installed provider/i);

  const connectionsView = render(shell(commonProps));
  await openConnectionsRoute(connectionsView);
  assert.match(connectionsView.lastFrame(), /Use Actions to rent a server first/);
  connectionsView.stdin.write("\r");
  await tick();
  assert.match(connectionsView.lastFrame(), /Rent a server/);
  assert.doesNotMatch(connectionsView.lastFrame(), /New local connection/);
});


test("TuiApp cancellation clears loading immediately even when loader never settles", async () => {
  const loader = () => new Promise(() => {});
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
    }),
  );

  await tick();
  assert.match(view.lastFrame(), /Refresh EasyServer status/);
  assert.match(view.lastFrame(), /loading/);

  view.stdin.write("c");
  await tick();
  assert.doesNotMatch(view.lastFrame(), /Refresh EasyServer status/);
  assert.doesNotMatch(view.lastFrame(), /loading/);
});

test("failed refresh keeps prior snapshot visibly stale after error drawer dismissal", async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    if (calls === 1) {
      return readSnapshot({
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
      });
    }
    throw new Error("refresh failed");
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
    }),
  );

  await tick();
  await tick();
  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /> fixture\s+ready/);

  await chooseVisibleAction(view, "Refresh providers");
  await tick();
  assert.match(view.lastFrame(), /Refresh EasyServer status: failed/);
  assert.match(view.lastFrame(), /Showing the previous snapshot/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.doesNotMatch(view.lastFrame(), /Refresh EasyServer status: failed/);
  assert.match(view.lastFrame(), /Showing the previous snapshot/);
  assert.match(view.lastFrame(), /> fixture\s+ready/);
});

test("TuiApp loads and refreshes read data through an injected loader", async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return readSnapshot({
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
    });
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
    }),
  );

  await tick();
  await tick();
  assert.equal(calls, 1);
  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /> fixture\s+ready/);

  await chooseVisibleAction(view, "Refresh providers");
  await tick();
  assert.equal(calls, 2);
  assert.match(view.lastFrame(), /> fixture\s+ready/);
});

test("routine TUI navigation stays quiet and uses one contextual hint across release terminal sizes", async (t) => {
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [
        {
          id: "instance:quiet-a",
          name: "Quiet A",
          providerId: "fixture",
          providerExternalId: "remote-a",
          management: "managed",
          freshness: "fresh",
          state: "running",
          availableActions: [],
        },
        {
          id: "instance:quiet-b",
          name: "Quiet B",
          providerId: "fixture",
          providerExternalId: "remote-b",
          management: "managed",
          freshness: "fresh",
          state: "stopped",
          availableActions: [],
        },
      ],
    },
  });

  for (const [width, height] of [[60, 20], [80, 24], [120, 40]]) {
    await t.test(`${width}x${height}`, async () => {
      const view = render(shell({ width, height, readSnapshot: snapshot, readStatus: "ready" }));
      await openServersRoute(view);
      let frame = view.lastFrame();
      assert.doesNotMatch(frame, /Opened Servers|Selected Quiet|Choose an action|Closed actions/);
      assert.equal((frame.match(/Enter actions/g) ?? []).length, 1);
      assert.match(frame, /> Quiet A\s+running/);
      assert.match(frame, /Quiet B\s+stopped/);
      assert.ok(frame.split("\n").length <= height);

      view.stdin.write("\u001b[B");
      await tick();
      frame = view.lastFrame();
      assert.match(frame, /> Quiet B\s+stopped/);
      assert.doesNotMatch(frame, /Selected Quiet B/);

      view.stdin.write("\r");
      await tick();
      frame = view.lastFrame();
      assert.match(frame, /Actions/);
      assert.doesNotMatch(frame, /Choose an action/);
      view.stdin.write("\u001b");
      await flushEscape();
      frame = view.lastFrame();
      assert.doesNotMatch(frame, /Closed actions/);
      assert.equal((frame.match(/Enter actions/g) ?? []).length, 1);
    });
  }
});

test("screen-reader keeps material stale-state notice while routine narration stays absent", async () => {
  const view = render(
    shell({
      width: 60,
      height: 20,
      screenReader: true,
      readSnapshot: readSnapshot(),
      readStatus: "stale",
    }),
  );

  await openServersRoute(view);
  const frame = view.lastFrame();
  assert.match(frame, /Some information could not be refreshed/);
  assert.match(frame, /Showing the previous snapshot/);
  assert.match(frame, /Enter opens Actions/);
  assert.doesNotMatch(frame, /Opened Servers|Choose an action|Closed actions/);
});

test("TUI v2 Home exposes task-first navigation without a permanent sidebar", async () => {
  const view = render(shell({ width: 100 }));

  assert.match(view.lastFrame(), /What do you want to do/);
  assert.match(view.lastFrame(), /> Rent a server/);
  assert.match(view.lastFrame(), /My servers/);
  assert.match(view.lastFrame(), /Connections/);
  assert.match(view.lastFrame(), /Settings & Support/);
  assert.doesNotMatch(view.lastFrame(), /Control center/);
  assert.doesNotMatch(view.lastFrame(), /\[active\]/);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> My servers/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Home › Servers/);
  assert.doesNotMatch(view.lastFrame(), /Settings & Support[\s\S]*Providers, credentials and diagnostics/);

  await chooseVisibleAction(view, "Refresh servers");
  assert.match(view.lastFrame(), /Refresh requested for Servers\./);
});

test("retained refresh shortcut uses the same semantic availability as visible Actions", async () => {
  const refreshes = [];
  const view = render(
    shell({
      width: 100,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      onRefresh(routeId) {
        refreshes.push(routeId);
      },
    }),
  );

  view.stdin.write("r");
  await tick();
  assert.deepEqual(refreshes, [], "Home has no Refresh action, so r must be inert");

  await openServersRoute(view);
  await chooseVisibleAction(view, "Refresh servers");
  assert.deepEqual(refreshes, ["instances"]);

  view.stdin.write("r");
  await tick();
  assert.deepEqual(refreshes, ["instances", "instances"]);
});

test("removed route shortcuts cannot bypass visible server action availability", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [
        {
          id: "instance:shortcut-guard",
          name: "Guarded server",
          providerId: "fixture",
          providerExternalId: "remote-guard",
          management: "managed",
          freshness: "fresh",
          state: "stopped",
          availableActions: ["instance.start"],
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
  view.stdin.write("1");
  await tick();
  assert.deepEqual(mutations, []);

  await chooseVisibleAction(view, "Start server");
  assert.deepEqual(mutations, [
    {
      kind: "action",
      instanceId: "instance:shortcut-guard",
      action: "instance.start",
    },
  ]);
});

test("TUI v2 arrows clamp task focus and Escape follows the page hierarchy", async () => {
  const view = render(shell({ width: 100 }));

  view.stdin.write("\u001b[A");
  await tick();
  assert.match(view.lastFrame(), /> Rent a server/);

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Connections/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Home › Connections/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.match(view.lastFrame(), /What do you want to do/);
  assert.match(view.lastFrame(), /> Connections/);
});

test("TUI help behaves like a modal and Escape returns to the current task surface", async () => {
  const view = render(shell({ width: 100 }));

  view.stdin.write("?");
  await tick();
  assert.match(view.lastFrame(), /Keyboard help/);
  assert.match(view.lastFrame(), /Arrow keys — move through visible choices, items and actions/);
  assert.doesNotMatch(view.lastFrame(), /Tab —/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.doesNotMatch(view.lastFrame(), /Keyboard help/);
  assert.match(view.lastFrame(), /What do you want to do/);
});

test("TUI keeps the focused working page across wide-to-narrow resize", async () => {
  const view = render(shell({ width: 100 }));

  await openServersRoute(view);
  assert.match(view.lastFrame(), /Home › Servers/);
  assert.doesNotMatch(view.lastFrame(), /Control center/);

  view.rerender(shell({ width: 60 }));
  await tick();
  assert.match(view.lastFrame(), /Home › Servers/);
  assert.doesNotMatch(view.lastFrame(), /Control center/);
});

test("TUI screen-reader mode renders the task-first Home as a calm linear summary", () => {
  const view = render(shell({ width: 60, screenReader: true }));

  assert.match(view.lastFrame(), /What do you want to do/);
  assert.match(view.lastFrame(), /> Rent a server/);
  assert.match(view.lastFrame(), /My servers/);
  assert.match(view.lastFrame(), /Settings & Support/);
  assert.match(
    view.lastFrame(),
    /Commands: Up and Down move; Enter opens; question mark opens help; Ctrl\+C\s+quits\./,
  );
});
