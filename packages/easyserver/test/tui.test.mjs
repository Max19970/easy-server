import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { render as renderInk } from "ink";
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

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flushEscape = () => new Promise((resolve) => setTimeout(resolve, 30));

async function typeText(view, text) {
  for (const character of text) {
    view.stdin.write(character);
    await tick();
  }
}

async function chooseVisibleAction(view, label, { open = true } = {}) {
  if (open) {
    view.stdin.write("\r");
    await tick();
  }
  for (let index = 0; index < 20; index += 1) {
    if (view.lastFrame()?.includes(`> ${label}`)) {
      view.stdin.write("\r");
      await tick();
      return;
    }
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.fail(`Visible action not found: ${label}\n${view.lastFrame()}`);
}

function shell(props = {}) {
  return React.createElement(TuiShell, { colorEnabled: false, ...props });
}

function readSnapshot(overrides = {}) {
  return {
    providerCandidates: { status: "ready", items: [] },
    providerWorkflows: { status: "ready", items: [] },
    providers: { status: "ready", items: [] },
    instances: {
      status: "ready",
      items: [],
      providerOutcomes: [],
      complete: true,
    },
    daemon: { status: "stopped" },
    ...overrides,
  };
}

function foregroundConnectionSnapshot() {
  return readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [
        {
          id: "instance:connect",
          providerId: "fixture",
          providerExternalId: "remote-connect",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: [],
        },
      ],
    },
  });
}

function persistentConnectionSnapshot(items = []) {
  return readSnapshot({
    ...foregroundConnectionSnapshot(),
    daemon: {
      status: "running",
      sessions: {
        status: "ready",
        total: items.length,
        live: items.filter((session) => session.state === "live").length,
        closing: items.filter((session) => session.state === "closing").length,
        failed: items.filter((session) => session.state === "failed").length,
        items,
      },
      endpointIntents: {
        status: "ready",
        total: 0,
        live: 0,
        starting: 0,
        error: 0,
        disabled: 0,
      },
    },
  });
}

async function returnHome(view) {
  for (let index = 0; index < 3; index += 1) {
    view.stdin.write("\u001b");
    await flushEscape();
  }
}

async function moveHomeCursor(view, count) {
  for (let index = 0; index < count; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
}

async function openHomeDestination(view, index) {
  await returnHome(view);
  await moveHomeCursor(view, index);
  view.stdin.write("\r");
  await tick();
}

async function openRentRoute(view) {
  await openHomeDestination(view, 0);
}

async function openServersRoute(view) {
  await openHomeDestination(view, 1);
}

async function openConnectionsRoute(view) {
  await openHomeDestination(view, 2);
}

async function openSettingsRoute(view) {
  await openHomeDestination(view, 3);
}

async function openProvidersRoute(view) {
  await openSettingsRoute(view);
  view.stdin.write("\r");
  await tick();
}

async function openDiagnosticsRoute(view) {
  await openSettingsRoute(view);
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
}

class CaptureOutput extends EventEmitter {
  isTTY = true;
  columns;
  rows;
  chunks = [];

  constructor(columns = 100, rows = 30) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (chunk) => {
    this.chunks.push(String(chunk));
    return true;
  };

  text() {
    return this.chunks.join("");
  }

  lastFrame() {
    return this.chunks.at(-1) ?? "";
  }

  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

class TtyInput extends EventEmitter {
  isTTY = true;
  data = null;

  write(data) {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }

  read = () => {
    const data = this.data;
    this.data = null;
    return data;
  };

  setEncoding() {}
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
  ref() { return this; }
  unref() { return this; }
}

function renderAtTerminal(tree, columns, rows) {
  const stdin = new TtyInput();
  const stdout = new CaptureOutput(columns, rows);
  const stderr = new CaptureOutput(columns, rows);
  const app = renderInk(tree, {
    stdin,
    stdout,
    stderr,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin,
    stdout,
    stderr,
    rerender: app.rerender,
    lastFrame: () => stdout.lastFrame(),
    async flush() {
      await app.waitUntilRenderFlush();
    },
    cleanup() {
      app.unmount();
      app.cleanup();
    },
  };
}

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

test("Providers adds a discoverable installed plugin by human display identity", async () => {
  const mutations = [];
  const view = render(
    shell({
      width: 100,
      readSnapshot: readSnapshot({
        providerCandidates: {
          status: "ready",
          items: [
            {
              source: "@fixture/provider",
              displayName: "Fixture Cloud",
              description: "Rent fixture compute",
            },
          ],
        },
      }),
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /Open Actions and choose Add installed provider/);
  await chooseVisibleAction(view, "Add installed provider");
  assert.match(view.lastFrame(), /Add an installed provider/);
  assert.match(view.lastFrame(), /> Fixture Cloud/);
  assert.match(view.lastFrame(), /Rent fixture compute/);
  assert.doesNotMatch(view.lastFrame(), /@fixture\/provider/);

  view.stdin.write("\r");
  await tick();
  assert.deepEqual(mutations, [
    { kind: "add-plugin", source: "@fixture/provider" },
  ]);
  assert.doesNotMatch(view.lastFrame(), /Add an installed provider/);
});

test("installed provider picker keeps focus visible inside a narrow bounded viewport", async () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    source: `@fixture/provider-${index + 1}`,
    displayName: `Provider ${String(index + 1).padStart(2, "0")}`,
    description: `Provider ${index + 1} description`,
  }));
  const view = render(
    shell({
      width: 60,
      height: 16,
      readSnapshot: readSnapshot({
        providerCandidates: { status: "ready", items: candidates },
      }),
      readStatus: "ready",
      onProviderMutation() {},
    }),
  );

  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Add installed provider");
  assert.match(view.lastFrame(), /> Provider 01/);
  assert.match(view.lastFrame(), /↓ \d+ more/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 0; index < 15; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> Provider 16/);
  assert.match(view.lastFrame(), /↑ \d+ more/);
  assert.match(view.lastFrame(), /↓ \d+ more/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 15; index < 29; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> Provider 30/);
  assert.match(view.lastFrame(), /↑ \d+ more/);
  assert.doesNotMatch(view.lastFrame(), /↓ \d+ more/);
  assert.ok(view.lastFrame().split("\n").length <= 16);
});

test("50-server inventory stays focused and actionable across real release terminal widths", async (t) => {
  const servers = Array.from({ length: 50 }, (_, index) => ({
    id: `instance:viewport-${index + 1}`,
    name: `Server ${String(index + 1).padStart(2, "0")}`,
    providerId: "fixture",
    providerExternalId: `remote-${index + 1}`,
    management: "managed",
    freshness: "fresh",
    state: index % 2 === 0 ? "running" : "stopped",
    availableActions: ["instance.stop", "instance.destroy"],
  }));
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: servers,
    },
  });
  const view = renderAtTerminal(
    shell({
      readSnapshot: snapshot,
      readStatus: "ready",
      onInstanceMutation() {},
      onBulkInstanceMutation() {},
    }),
    60,
    20,
  );
  t.after(() => view.cleanup());
  await view.flush();

  await openServersRoute(view);
  assert.match(view.lastFrame(), /> \[ \] Server 01 · running/);
  assert.match(view.lastFrame(), /↓ \d+ more servers/);
  assert.ok(
    view.lastFrame().split("\n").length <= 20,
    `60x20 server frame overflowed:\n${view.lastFrame()}`,
  );

  view.stdin.write(" ");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write(" ");
  await tick();
  assert.match(view.lastFrame(), /Selected servers \(2\)/);
  assert.ok(view.lastFrame().split("\n").length <= 20);

  view.stdin.write("\r");
  await tick();
  for (let index = 0; index < 10 && !view.lastFrame().includes("> stop 2 selected servers"); index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
    assert.ok(
      view.lastFrame().split("\n").length <= 20,
      `60x20 server action frame overflowed:\n${view.lastFrame()}`,
    );
  }
  assert.match(view.lastFrame(), /> stop 2 selected servers/);
  view.stdin.write("\u001b");
  await flushEscape();

  for (let index = 1; index < 24; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] Server 25 · running/);
  assert.match(view.lastFrame(), /↑ \d+ more servers/);
  assert.match(view.lastFrame(), /↓ \d+ more servers/);
  assert.ok(view.lastFrame().split("\n").length <= 20);

  view.stdout.resize(80, 24);
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Server 25 · running/);
  assert.ok(view.lastFrame().split("\n").length <= 24);
  view.stdin.write("\r");
  await tick();
  assert.ok(view.lastFrame().split("\n").length <= 24);
  view.stdin.write("\u001b");
  await flushEscape();

  for (let index = 24; index < 49; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] Server 50 · stopped/);
  assert.match(view.lastFrame(), /↑ \d+ more servers/);
  assert.doesNotMatch(view.lastFrame(), /↓ \d+ more servers/);
  assert.ok(view.lastFrame().split("\n").length <= 24);

  view.stdout.resize(120, 40);
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Server 50 · stopped/);
  assert.ok(view.lastFrame().split("\n").length <= 40);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> Show technical details/);
  assert.ok(view.lastFrame().split("\n").length <= 40);
});

test("50-offer third-party table stays focused and actionable across real release terminal widths", async (t) => {
  const events = [];
  const screen = {
    kind: "table",
    id: "qualification-offers",
    title: "Nebula qualification offers",
    columns: [
      { id: "name", label: "Name" },
      { id: "price", label: "Price" },
    ],
    rows: Array.from({ length: 50 }, (_, index) => ({
      id: `offer-${index + 1}`,
      cells: {
        name: `Offer ${String(index + 1).padStart(2, "0")}`,
        price: (index + 1) / 10,
      },
    })),
    selection: "single",
    selectedRowIds: [],
    actions: [{ id: "continue", label: "Continue", kind: "primary" }],
  };
  const snapshot = readSnapshot();
  const baseProps = {
    readSnapshot: snapshot,
    readStatus: "ready",
    providerInteractiveDisabled: false,
    onProviderInteractiveEvent(event) {
      events.push(event);
    },
    onProviderInteractiveClose() {},
  };
  const interactiveProps = { ...baseProps, providerInteractiveScreen: screen };
  const view = renderAtTerminal(shell(baseProps), 60, 20);
  t.after(() => view.cleanup());
  await view.flush();

  view.stdin.write("\r");
  await tick();
  view.rerender(shell(interactiveProps));
  await tick();
  assert.match(view.lastFrame(), /Nebula qualification offers/);
  assert.match(view.lastFrame(), /> \[ \] Offer 01/);
  assert.match(view.lastFrame(), /↓ \d+ more offers/);
  assert.ok(view.lastFrame().split("\n").length <= 20);

  for (let index = 0; index < 24; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] Offer 25/);
  assert.match(view.lastFrame(), /↑ \d+ more offers/);
  assert.match(view.lastFrame(), /↓ \d+ more offers/);
  assert.ok(view.lastFrame().split("\n").length <= 20);

  view.stdout.resize(80, 24);
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Offer 25/);
  assert.ok(view.lastFrame().split("\n").length <= 24);

  for (let index = 24; index < 49; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] Offer 50/);
  assert.match(view.lastFrame(), /↑ \d+ more offers/);
  assert.ok(view.lastFrame().split("\n").length <= 24);

  view.stdout.resize(120, 40);
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Offer 50/);
  assert.ok(view.lastFrame().split("\n").length <= 40);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Continue/);
  assert.ok(view.lastFrame().split("\n").length <= 40);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), { kind: "action", actionId: "continue" });
});

test("degraded server notice stays secondary without overflowing the narrow server viewport", async () => {
  const servers = Array.from({ length: 30 }, (_, index) => ({
    id: `instance:degraded-${index + 1}`,
    name: `Degraded ${String(index + 1).padStart(2, "0")}`,
    providerId: "healthy",
    providerExternalId: `remote-degraded-${index + 1}`,
    management: "managed",
    freshness: "fresh",
    state: "running",
    availableActions: [],
  }));
  const view = render(
    shell({
      width: 60,
      height: 16,
      readSnapshot: readSnapshot({
        instances: {
          status: "ready",
          complete: false,
          providerOutcomes: [
            { providerId: "healthy", status: "fresh" },
            {
              providerId: "offline-provider",
              status: "failed",
              error: {
                code: "provider-unavailable",
                message: "Provider offline inventory refresh failed with deliberately long detail",
              },
            },
          ],
          items: servers,
        },
      }),
      readStatus: "ready",
    }),
  );

  await openServersRoute(view);
  assert.match(view.lastFrame(), /Some providers are unavailable/);
  assert.match(view.lastFrame(), /offline-provider · provider-unavailable/);
  assert.match(view.lastFrame(), /> Degraded 01 · running/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 0; index < 15; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> Degraded 16 · running/);
  assert.ok(view.lastFrame().split("\n").length <= 16);
});

test("new local connection server picker stays bounded with a large inventory", async () => {
  const servers = Array.from({ length: 30 }, (_, index) => ({
    id: `instance:picker-${index + 1}`,
    name: `Picker ${String(index + 1).padStart(2, "0")}`,
    providerId: "fixture",
    providerExternalId: `remote-picker-${index + 1}`,
    management: "managed",
    freshness: "fresh",
    state: "running",
    availableActions: [],
  }));
  const view = render(
    shell({
      width: 60,
      height: 16,
      readSnapshot: readSnapshot({
        instances: {
          status: "ready",
          complete: true,
          providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
          items: servers,
        },
      }),
      readStatus: "ready",
      async onListForegroundAccessMethods() {
        return [{ id: "ssh", kind: "ssh", mode: "tcp-forward" }];
      },
      async onOpenForegroundConnection() {
        assert.fail("connection should not open while choosing a server");
      },
    }),
  );

  await openConnectionsRoute(view);
  await chooseVisibleAction(view, "New local connection");
  assert.match(view.lastFrame(), /Choose server/);
  assert.match(view.lastFrame(), /> Picker 01 · running/);
  assert.match(view.lastFrame(), /↓ \d+ more servers/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 0; index < 15; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> Picker 16 · running/);
  assert.match(view.lastFrame(), /↑ \d+ more servers/);
  assert.match(view.lastFrame(), /↓ \d+ more servers/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 15; index < 29; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> Picker 30 · running/);
  assert.match(view.lastFrame(), /↑ \d+ more servers/);
  assert.doesNotMatch(view.lastFrame(), /↓ \d+ more servers/);
  assert.ok(view.lastFrame().split("\n").length <= 16);
});

test("local connection list keeps focus visible inside a narrow bounded viewport", async () => {
  const server = {
    id: "instance:viewport-server",
    name: "Viewport server",
    providerId: "fixture",
    providerExternalId: "remote-viewport",
    management: "managed",
    freshness: "fresh",
    state: "running",
    availableActions: [],
  };
  const connections = Array.from({ length: 30 }, (_, index) => ({
    id: `foreground:viewport-${index + 1}`,
    instanceId: server.id,
    remoteHost: "127.0.0.1",
    remotePort: 8000 + index,
    endpoint: { host: "127.0.0.1", port: 40000 + index },
    accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
    state: "live",
  }));
  const view = render(
    shell({
      width: 60,
      height: 16,
      readSnapshot: readSnapshot({
        instances: {
          status: "ready",
          complete: true,
          providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
          items: [server],
        },
      }),
      readStatus: "ready",
      foregroundConnections: connections,
    }),
  );

  await openConnectionsRoute(view);
  assert.match(view.lastFrame(), /> 127\.0\.0\.1:40000 → Viewport server:8000/);
  assert.match(view.lastFrame(), /↓ \d+ more connections/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 0; index < 15; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> 127\.0\.0\.1:40015 → Viewport server:8015/);
  assert.match(view.lastFrame(), /↑ \d+ more connections/);
  assert.match(view.lastFrame(), /↓ \d+ more connections/);
  assert.ok(view.lastFrame().split("\n").length <= 16);

  for (let index = 15; index < 29; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> 127\.0\.0\.1:40029 → Viewport server:8029/);
  assert.match(view.lastFrame(), /↑ \d+ more connections/);
  assert.doesNotMatch(view.lastFrame(), /↓ \d+ more connections/);
  assert.ok(view.lastFrame().split("\n").length <= 16);
});

test("Providers keeps literal module or path registration behind Advanced", async () => {
  const mutations = [];
  const view = render(
    shell({
      width: 100,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Advanced: add module or path");
  assert.match(view.lastFrame(), /Advanced provider registration/);
  assert.match(view.lastFrame(), /Module or path:/);

  await typeText(view, "q-provider");
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(mutations, [
    { kind: "add-plugin", source: "q-provider" },
  ]);
});

test("provider registration prompt can be cancelled without mutation", async () => {
  const mutations = [];
  const view = render(
    shell({
      width: 100,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Advanced: add module or path");
  assert.match(view.lastFrame(), /Advanced provider registration/);
  await typeText(view, "@fixture/provider");
  view.stdin.write("\u001b");
  await flushEscape();

  assert.deepEqual(mutations, []);
  assert.doesNotMatch(view.lastFrame(), /Module or path:/);
  assert.match(view.lastFrame(), /No providers added yet/);
});

test("TuiApp refreshes provider state after registration mutation succeeds", async () => {
  let registered = false;
  const mutations = [];
  const loader = async () =>
    readSnapshot({
      providerCandidates: registered
        ? { status: "ready", items: [] }
        : {
            status: "ready",
            items: [
              {
                source: "@fixture/provider",
                displayName: "Fixture Provider",
                description: "Fixture provider package",
              },
            ],
          },
      providers: registered
        ? {
            status: "ready",
            items: [
              {
                source: "@fixture/provider",
                state: "loaded",
                readiness: "ready",
                pluginId: "fixture.provider",
                displayName: "Fixture Provider",
                providerId: "fixture",
                version: "1.0.0",
                credentials: { configured: 0, declared: 0, missingRequired: 0 },
              },
            ],
          }
        : { status: "ready", items: [] },
    });
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async providerMutationRunner(mutation) {
        mutations.push(mutation);
        registered = true;
      },
    }),
  );

  await tick();
  await tick();
  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Add installed provider");
  assert.match(view.lastFrame(), /> Fixture Provider/);
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(mutations, [
    { kind: "add-plugin", source: "@fixture/provider" },
  ]);
  assert.match(view.lastFrame(), /> Fixture Provider · ready/);
});

test("Providers enable and disable the selected configured plugin by source", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/enabled",
          state: "loaded",
          readiness: "ready",
          displayName: "Enabled Provider",
          providerId: "enabled",
          credentials: { configured: 0, declared: 0, missingRequired: 0 },
        },
        {
          source: "@fixture/disabled",
          state: "disabled",
          readiness: "disabled",
          displayName: "Disabled Provider",
          credentials: { configured: 0, declared: 0, missingRequired: 0 },
        },
      ],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: snapshot,
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /> Enabled Provider/);

  await chooseVisibleAction(view, "Disable provider");
  assert.deepEqual(mutations, [
    { kind: "set-enabled", source: "@fixture/enabled", enabled: false },
  ]);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Disabled Provider/);
  await chooseVisibleAction(view, "Enable provider");
  assert.deepEqual(mutations, [
    { kind: "set-enabled", source: "@fixture/enabled", enabled: false },
    { kind: "set-enabled", source: "@fixture/disabled", enabled: true },
  ]);
});

test("Providers configure only declared credentials through masked input", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/credentials",
          state: "loaded",
          readiness: "credentials-missing",
          displayName: "Credential Provider",
          providerId: "credential-fixture",
          credentials: {
            configured: 1,
            declared: 2,
            missingRequired: 1,
            items: [
              {
                name: "api-key",
                required: true,
                configured: false,
                description: "Fixture API key",
              },
              {
                name: "profile",
                required: false,
                configured: true,
                description: "Optional fixture profile",
              },
            ],
          },
        },
      ],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: snapshot,
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Manage credentials");

  assert.match(view.lastFrame(), /Credentials for Credential Provider/);
  assert.match(view.lastFrame(), /> api-key · required · missing/);
  assert.match(view.lastFrame(), /profile · optional · configured/);
  assert.doesNotMatch(view.lastFrame(), /Credential name:/);

  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Actions/);
  assert.match(view.lastFrame(), /> Set or rotate/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Configure credential api-key/);

  const secret = "q-super-secret-marker";
  await typeText(view, secret);
  assert.doesNotMatch(view.lastFrame(), new RegExp(secret));
  assert.match(view.lastFrame(), /Secret: \*{8}/);
  assert.match(view.lastFrame(), /Input status: value entered/);

  view.stdin.write("\r");
  await tick();
  assert.deepEqual(mutations, [
    {
      kind: "set-credential",
      source: "@fixture/credentials",
      name: "api-key",
      secret,
    },
  ]);
});

test("Providers remove a configured declared credential without reading its value", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/credentials",
          state: "loaded",
          readiness: "ready",
          displayName: "Credential Provider",
          providerId: "credential-fixture",
          credentials: {
            configured: 1,
            declared: 1,
            missingRequired: 0,
            items: [
              {
                name: "api-key",
                required: true,
                configured: true,
                description: "Fixture API key",
              },
            ],
          },
        },
      ],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: snapshot,
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Manage credentials");
  assert.match(view.lastFrame(), /> api-key · required · configured/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> Set or rotate/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Remove credential/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(mutations, [
    {
      kind: "remove-credential",
      source: "@fixture/credentials",
      name: "api-key",
    },
  ]);
});

test("TuiApp confirms credential removal before deleting the stored value", async () => {
  let configured = true;
  const mutations = [];
  const loader = async () =>
    readSnapshot({
      providers: {
        status: "ready",
        items: [
          {
            source: "@fixture/credentials",
            state: "loaded",
            readiness: configured ? "ready" : "credentials-missing",
            displayName: "Credential Provider",
            credentials: {
              configured: configured ? 1 : 0,
              declared: 1,
              missingRequired: configured ? 0 : 1,
              items: [
                { name: "api-key", required: true, configured },
              ],
            },
          },
        ],
      },
    });
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async providerMutationRunner(mutation) {
        mutations.push(mutation);
        configured = false;
      },
    }),
  );

  await tick();
  await tick();
  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Manage credentials");
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();

  assert.deepEqual(mutations, []);
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /Remove credential api-key/);
  assert.match(view.lastFrame(), /Target: @fixture\/credentials/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.deepEqual(mutations, []);
  assert.doesNotMatch(view.lastFrame(), /Confirmation required/);

  await chooseVisibleAction(view, "Manage credentials");
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> Cancel/);
  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(mutations, [
    {
      kind: "remove-credential",
      source: "@fixture/credentials",
      name: "api-key",
    },
  ]);
});

test("Providers explain credential eligibility for providers without usable descriptors", async () => {
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/disabled",
          state: "disabled",
          readiness: "disabled",
          displayName: "Disabled Provider",
          credentials: {
            configured: 0,
            declared: 0,
            missingRequired: 0,
            items: [],
          },
        },
      ],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: snapshot,
      readStatus: "ready",
      onProviderMutation() {},
    }),
  );

  await openProvidersRoute(view);
  assert.match(view.lastFrame(), /> Disabled Provider · disabled/);

  view.stdin.write("\r");
  await tick();
  assert.doesNotMatch(view.lastFrame(), /Manage credentials/);
  assert.match(view.lastFrame(), /Enable provider/);
});

test("credential secret input cancels without emitting or revealing secret", async () => {
  const mutations = [];
  const snapshot = readSnapshot({
    providers: {
      status: "ready",
      items: [
        {
          source: "@fixture/credentials",
          state: "loaded",
          readiness: "credentials-missing",
          displayName: "Credential Provider",
          credentials: {
            configured: 0,
            declared: 1,
            missingRequired: 1,
            items: [
              { name: "api-key", required: true, configured: false },
            ],
          },
        },
      ],
    },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: snapshot,
      readStatus: "ready",
      onProviderMutation(mutation) {
        mutations.push(mutation);
      },
    }),
  );

  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Manage credentials");
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  await typeText(view, "q-cancelled-secret");
  assert.doesNotMatch(view.lastFrame(), /q-cancelled-secret/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.deepEqual(mutations, []);
  assert.match(view.lastFrame(), /Actions/);
  assert.match(view.lastFrame(), /> Set or rotate/);
});

test("TuiApp never exposes credential values while mutating and refreshes readiness after success", async () => {
  let configured = false;
  let releaseMutation;
  const mutationGate = new Promise((resolve) => {
    releaseMutation = resolve;
  });
  const loader = async () =>
    readSnapshot({
      providers: {
        status: "ready",
        items: [
          {
            source: "@fixture/credentials",
            state: "loaded",
            readiness: configured ? "ready" : "credentials-missing",
            displayName: "Credential Provider",
            providerId: "credential-fixture",
            credentials: {
              configured: configured ? 1 : 0,
              declared: 1,
              missingRequired: configured ? 0 : 1,
              items: [
                {
                  name: "api-key",
                  required: true,
                  configured,
                  description: "Fixture API key",
                },
              ],
            },
          },
        ],
      },
    });
  const mutations = [];
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async providerMutationRunner(mutation) {
        mutations.push(mutation);
        await mutationGate;
        configured = true;
      },
    }),
  );

  await tick();
  await tick();
  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Manage credentials");
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();

  const secret = "q-operation-secret-marker";
  await typeText(view, secret);
  view.stdin.write("\r");
  await tick();

  assert.match(view.lastFrame(), /Configure provider credential/);
  assert.doesNotMatch(view.lastFrame(), new RegExp(secret));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].secret, secret);

  releaseMutation();
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /> Credential Provider · ready/);
  assert.doesNotMatch(view.lastFrame(), new RegExp(secret));
});

test("credential mutation failures cannot echo the submitted secret into the operation drawer", async () => {
  const secret = "q-secret-error-marker";
  const loader = async () =>
    readSnapshot({
      providers: {
        status: "ready",
        items: [
          {
            source: "@fixture/credentials",
            state: "loaded",
            readiness: "credentials-missing",
            displayName: "Credential Provider",
            credentials: {
              configured: 0,
              declared: 1,
              missingRequired: 1,
              items: [
                { name: "api-key", required: true, configured: false },
              ],
            },
          },
        ],
      },
    });
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async providerMutationRunner() {
        throw new Error(`keyring rejected ${secret}`);
      },
    }),
  );

  await tick();
  await tick();
  await openProvidersRoute(view);
  await chooseVisibleAction(view, "Manage credentials");
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  await typeText(view, secret);
  view.stdin.write("\r");
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Configure provider credential: failed/);
  assert.doesNotMatch(view.lastFrame(), new RegExp(secret));
  assert.match(view.lastFrame(), /Credential update failed/);
});

test("provider selection is preserved by source across refreshed ordering", async () => {
  const providerA = {
    source: "@fixture/a",
    state: "loaded",
    readiness: "ready",
    displayName: "Provider A",
    providerId: "a",
    credentials: { configured: 0, declared: 0, missingRequired: 0 },
  };
  const providerB = {
    source: "@fixture/b",
    state: "loaded",
    readiness: "ready",
    displayName: "Provider B",
    providerId: "b",
    credentials: { configured: 0, declared: 0, missingRequired: 0 },
  };
  const first = readSnapshot({
    providers: { status: "ready", items: [providerA, providerB] },
  });
  const reordered = readSnapshot({
    providers: { status: "ready", items: [providerB, providerA] },
  });
  const view = render(
    shell({
      width: 100,
      readSnapshot: first,
      readStatus: "ready",
      onProviderMutation() {},
    }),
  );

  await openProvidersRoute(view);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Provider B/);

  view.rerender(
    shell({
      width: 60,
      readSnapshot: reordered,
      readStatus: "ready",
      onProviderMutation() {},
    }),
  );
  await tick();
  assert.match(view.lastFrame(), /> Provider B/);
});

test("TuiApp runs a generic provider workflow through host confirmation and navigates to canonical handoff", async () => {
  const workflow = {
    providerId: "nebula",
    featureId: "allocation",
    featureDisplayName: "Allocation",
    commandName: "provision",
    description: "Provision a Nebula allocation",
    operation: "mutation",
    risks: ["billable"],
    presentation: {
      kind: "interactive-flow",
      flowId: "provision-wizard",
    },
  };
  let created = false;
  let openerCalls = 0;
  let dispatchCalls = 0;
  let closeCalls = 0;
  const loader = async () =>
    readSnapshot({
      providerWorkflows: { status: "ready", items: [workflow] },
      instances: {
        status: "ready",
        complete: true,
        providerOutcomes: [{ providerId: "nebula", status: "fresh" }],
        items: created
          ? [
              {
                id: "instance:nebula-42",
                providerId: "nebula",
                providerExternalId: "nebula-42",
                management: "managed",
                freshness: "fresh",
                state: "running",
                rawState: "READY",
                availableActions: [],
              },
            ]
          : [],
      },
    });
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      async providerFlowOpener(flow) {
        openerCalls += 1;
        assert.deepEqual(flow, {
          providerId: "nebula",
          featureId: "allocation",
          flowId: "provision-wizard",
        });
        let closed = false;
        return {
          descriptor: {
            id: "provision-wizard",
            commandName: "provision",
            command: {
              name: "provision",
              description: "Provision a Nebula allocation",
              operation: "mutation",
              risks: ["billable"],
              presentation: {
                kind: "interactive-flow",
                flowId: "provision-wizard",
              },
            },
          },
          screen: {
            kind: "review",
            id: "review",
            title: "Review Nebula allocation",
            items: [{ label: "Region", value: "EU North" }],
            actions: [
              { id: "submit", label: "Provision", kind: "submit" },
            ],
          },
          async dispatch(event, context, interaction) {
            dispatchCalls += 1;
            assert.deepEqual(event, { kind: "action", actionId: "submit" });
            const accepted = await interaction.confirm(
              {
                summary: "Provision Nebula allocation",
                risks: ["billable"],
                consequence: "may create or increase provider charges",
              },
              context,
            );
            assert.equal(accepted, true);
            created = true;
            closed = true;
            return {
              kind: "executed",
              execution: {
                operation: "mutation",
                mutationOutcome: "succeeded",
                providerResult: {
                  refreshProviderInventory: true,
                  affectedProviderExternalIds: ["nebula-42"],
                },
                handoff: {
                  status: "complete",
                  affectedProviderExternalIds: ["nebula-42"],
                  canonicalInstances: [
                    {
                      providerExternalId: "nebula-42",
                      instanceId: "instance:nebula-42",
                    },
                  ],
                  unresolvedProviderExternalIds: [],
                },
              },
            };
          },
          close() {
            if (!closed) {
              closed = true;
              closeCalls += 1;
            }
          },
        };
      },
    }),
  );

  await tick();
  await tick();
  await openRentRoute(view);
  assert.match(view.lastFrame(), /Home › Servers › Rent server/);
  assert.match(view.lastFrame(), /nebula · Allocation · provision · interactive/);

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.equal(openerCalls, 1);
  assert.match(view.lastFrame(), /Review Nebula allocation/);

  view.stdin.write("\r");
  view.stdin.write("\r");
  await tick();
  assert.equal(dispatchCalls, 1, "a single provider session transition may be in flight");
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /billable/);

  assert.match(view.lastFrame(), /> Cancel/);

  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Home › Servers/);
  assert.match(view.lastFrame(), /> Server · running/);
  assert.doesNotMatch(view.lastFrame(), /EasyServer ID: instance:nebula-42/);
  assert.equal(closeCalls, 0);

  view.stdin.write("\u001b");
  await flushEscape();
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /EasyServer ID: instance:nebula-42/);
});

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
  view.stdin.write(" ");
  await tick();
  view.stdin.write("j");
  await tick();
  view.stdin.write(" ");
  await tick();

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
  view.stdin.write(" ");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write(" ");
  await tick();
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

test("a server-scoped Connect flow opens and closes a local connection without internal connection vocabulary", async () => {
  let connections = [];
  let openedRequest;
  let closedId;
  const method = { id: "ssh-default", kind: "ssh", mode: "tcp-forward" };
  const operations = {
    list() {
      return connections;
    },
    async listAccessMethods(instanceId) {
      assert.equal(instanceId, "instance:connect");
      return [method, { id: "ssh-secondary", kind: "ssh", mode: "tcp-forward" }];
    },
    async open(request) {
      openedRequest = request;
      const connection = {
        id: "foreground:fixture",
        instanceId: request.instanceId,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        endpoint: { host: "127.0.0.1", port: 40123 },
        accessMethod: method,
        state: "live",
      };
      connections = [connection];
      return connection;
    },
    async close(id) {
      closedId = id;
      connections = [];
    },
    async closeAll() {
      connections = [];
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  assert.match(view.lastFrame(), /Home › Connections/);
  assert.match(view.lastFrame(), /Connect to server/);
  assert.match(view.lastFrame(), /App\/service port on the server/);
  assert.match(view.lastFrame(), /not the SSH port/i);
  assert.match(view.lastFrame(), /8188 for ComfyUI/);
  assert.doesNotMatch(view.lastFrame(), /Access Method|Endpoint|daemon|Session/);

  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Local port on this computer/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:automatic/);
  assert.doesNotMatch(view.lastFrame(), /ssh-default|Access Method/);

  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Review local connection/);
  assert.match(view.lastFrame(), /App\/service port: 8188/);
  assert.match(view.lastFrame(), /Lifetime: available while this TUI is open/);
  assert.doesNotMatch(view.lastFrame(), /instance:connect|fixture|ssh-default|Access Method|Endpoint|daemon|Session/);

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.deepEqual(openedRequest, {
    instanceId: "instance:connect",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    accessMethodId: "ssh-default",
  });
  assert.match(view.lastFrame(), /127\.0\.0\.1:40123 → Server:8188/);
  assert.doesNotMatch(view.lastFrame(), /Access Method|Endpoint|daemon|Session/);

  await chooseVisibleAction(view, "Close local connection");
  await tick();
  assert.equal(closedId, "foreground:fixture");
  assert.match(view.lastFrame(), /None open/);
});

test("ordinary Connect failure offers a truthful in-place retry with the preserved request", async () => {
  const method = { id: "ssh-default", kind: "ssh", mode: "tcp-forward" };
  const requests = [];
  let connections = [];
  const operations = {
    list() {
      return connections;
    },
    async listAccessMethods() {
      return [method];
    },
    async open(request) {
      requests.push(request);
      if (requests.length === 1) {
        throw normalizedError(
          "authentication",
          "SSH public-key authentication was rejected by the server.",
        );
      }
      const connection = {
        id: "foreground:retried",
        instanceId: request.instanceId,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        endpoint: { host: "127.0.0.1", port: 40124 },
        accessMethod: method,
        state: "live",
      };
      connections = [connection];
      return connection;
    },
    async close() {},
    async closeAll() {
      connections = [];
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Open local connection: failed/);
  assert.match(view.lastFrame(), /Retry connection/);
  assert.match(view.lastFrame(), /Open Diagnostics/);
  assert.equal(requests.length, 1);

  await chooseVisibleAction(view, "Retry connection", { open: false });
  await tick();
  await tick();

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.match(view.lastFrame(), /127\.0\.0\.1:40124 → Server:8188/);
  assert.doesNotMatch(view.lastFrame(), /Open local connection: failed|Retry connection/);
});

test("non-local connection conflicts never masquerade as an occupied local port", async () => {
  const method = { id: "ssh-default", kind: "ssh", mode: "tcp-forward" };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: {
        list() {
          return [];
        },
        async listAccessMethods() {
          return [method];
        },
        async open() {
          throw normalizedError(
            "conflict",
            "Intelion rejected the operation as conflicting",
          );
        },
        async close() {},
        async closeAll() {},
      },
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Open local connection: failed/);
  assert.match(view.lastFrame(), /Retry connection/);
  assert.match(view.lastFrame(), /Open Diagnostics/);
  assert.doesNotMatch(view.lastFrame(), /Edit local port|Local connection port is already in use/);
});

test("connection failure owns the qualified 60x20 viewport with recovery actions reachable", async () => {
  const method = { id: "ssh-default", kind: "ssh", mode: "tcp-forward" };
  const props = {
    width: 60,
    height: 20,
    readSnapshot: foregroundConnectionSnapshot(),
    readStatus: "ready",
    async onListForegroundAccessMethods() {
      return [method];
    },
    async onOpenForegroundConnection() {
      return undefined;
    },
    async onCloseForegroundConnection() {
      return true;
    },
  };
  const view = render(shell(props));

  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Review local connection/);

  view.rerender(
    shell({
      ...props,
      operation: presentOperationError({
        title: "Open local connection",
        operation: "read",
        error: normalizedError(
          "authentication",
          "SSH public-key authentication was rejected by the server.",
        ),
        retryLabel: "Retry connection",
        allowDiagnostics: true,
      }),
    }),
  );
  await tick();

  const frame = view.lastFrame();
  assert.ok(frame.split("\n").length <= 20, frame);
  assert.match(frame, /Open local connection: failed/);
  assert.match(frame, /Retry connection/);
  assert.match(frame, /Open Diagnostics/);
  assert.doesNotMatch(frame, /Review local connection|App\/service port: 8188/);
});

test("delayed ordinary Connect working drawers keep canonical identity hidden", async () => {
  let resolveMethods;
  let resolveOpen;
  const method = { id: "ssh-default", kind: "ssh", mode: "tcp-forward" };
  const methodsGate = new Promise((resolve) => {
    resolveMethods = resolve;
  });
  const openGate = new Promise((resolve) => {
    resolveOpen = resolve;
  });
  const operations = {
    list() {
      return [];
    },
    async listAccessMethods() {
      return methodsGate;
    },
    async open(request) {
      await openGate;
      return {
        id: "foreground:delayed",
        instanceId: request.instanceId,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        endpoint: { host: "127.0.0.1", port: 40125 },
        accessMethod: method,
        state: "live",
      };
    },
    async close() {},
    async closeAll() {},
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Check connection method/);
  assert.match(view.lastFrame(), /Checking supported local access for Server/);
  assert.doesNotMatch(view.lastFrame(), /instance:connect|fixture|ssh-default|Access Method|Endpoint|daemon|Session/);

  resolveMethods([method]);
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Local port on this computer/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Review local connection/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Open local connection/);
  assert.match(view.lastFrame(), /Server · app\/service port 8188/);
  assert.doesNotMatch(view.lastFrame(), /instance:connect|fixture|ssh-default|Access Method|Endpoint|daemon|Session/);

  resolveOpen();
  await tick();
  await tick();
});

test("ordinary connection and lifecycle failure drawers hide canonical server identity", async () => {
  const connectionOperations = {
    list() {
      return [];
    },
    async listAccessMethods() {
      throw normalizedError(
        "provider-unavailable",
        "Provider is not available: fixture / remote-connect / instance:connect",
      );
    },
    async open() {
      assert.fail("open is not expected after connection-method discovery fails");
    },
    async close() {},
    async closeAll() {},
  };
  const connectionView = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: connectionOperations,
    }),
  );

  await tick();
  await tick();
  await openServersRoute(connectionView);
  await chooseVisibleAction(connectionView, "Connect");
  await typeText(connectionView, "8188");
  connectionView.stdin.write("\r");
  await tick();
  await tick();
  assert.match(connectionView.lastFrame(), /Could not prepare a connection to Server/);
  assert.doesNotMatch(connectionView.lastFrame(), /instance:connect|remote-connect|fixture|Compute Instance|Access Method|Endpoint|daemon|Session/);

  const lifecycleView = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () =>
        readSnapshot({
          instances: {
            status: "ready",
            complete: true,
            providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
            items: [
              {
                id: "instance:secret-123",
                providerId: "fixture",
                providerExternalId: "provider-secret-456",
                management: "managed",
                freshness: "fresh",
                state: "stopped",
                availableActions: ["instance.start"],
              },
            ],
          },
        }),
      async instanceMutationRunner() {
        throw normalizedError(
          "not-found",
          "Compute Instance not found: instance:secret-123",
        );
      },
    }),
  );

  await tick();
  await tick();
  await openServersRoute(lifecycleView);
  await chooseVisibleAction(lifecycleView, "Start server");
  await tick();
  await tick();
  assert.match(lifecycleView.lastFrame(), /Server is no longer available/);
  assert.doesNotMatch(lifecycleView.lastFrame(), /instance:secret-123|provider-secret-456|Compute Instance/);
});

test("late foreground SSH public-key failure stays visible and retries the retained connection", async () => {
  let listener;
  let retryCalls = 0;
  let connections = [
    {
      id: "foreground:late-secret",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      endpoint: { host: "127.0.0.1", port: 40131 },
      accessMethod: { id: "ssh-secret", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
  ];
  const operations = {
    list() {
      return connections;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async listAccessMethods() {
      return [];
    },
    async open() {
      assert.fail("open is not expected");
    },
    async retry(id) {
      assert.equal(id, "foreground:late-secret");
      retryCalls += 1;
      const replacement = {
        ...connections[0],
        id: "foreground:late-retry",
        endpoint: { host: "127.0.0.1", port: 40134 },
        state: "live",
        failure: undefined,
      };
      connections = [replacement];
      listener?.();
      return replacement;
    },
    async close(id) {
      assert.equal(id, "foreground:late-secret");
      connections = [];
      listener?.();
    },
    async closeAll() {
      connections = [];
      listener?.();
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  connections = [
    {
      ...connections[0],
      state: "failed",
      failure: normalizedError(
        "authentication",
        "SSH public-key authentication was rejected by the server.",
      ),
    },
  ];
  listener?.();
  await tick();
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Local connection failed/);
  assert.match(view.lastFrame(), /SSH public-key authentication to Server was rejected/);
  assert.match(view.lastFrame(), /matching SSH private key/);
  assert.match(view.lastFrame(), /Retry connection/);
  assert.doesNotMatch(
    view.lastFrame(),
    /Credentials need attention|Open Providers|Permission denied|foreground:late-secret|instance:connect|ssh-secret/,
  );

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.equal(retryCalls, 1);
  assert.match(view.lastFrame(), /40134 → Server:8188/);
  assert.doesNotMatch(view.lastFrame(), /Local connection failed/);
});

test("dismissed late failure remains retryable from the selected failed connection", async () => {
  let listener;
  let retryCalls = 0;
  let connections = [
    {
      id: "foreground:retained-recovery",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      endpoint: { host: "127.0.0.1", port: 40136 },
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
  ];
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: {
        list() {
          return connections;
        },
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        async listAccessMethods() {
          return [];
        },
        async open() {
          assert.fail("open is not expected");
        },
        async retry(id) {
          assert.equal(id, "foreground:retained-recovery");
          retryCalls += 1;
          const replacement = {
            ...connections[0],
            id: "foreground:retained-replacement",
            endpoint: { host: "127.0.0.1", port: 40137 },
            state: "live",
            failure: undefined,
          };
          connections = [replacement];
          listener?.();
          return replacement;
        },
        async close() {},
        async closeAll() {},
      },
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  connections = [
    {
      ...connections[0],
      state: "failed",
      failure: normalizedError(
        "authentication",
        "SSH public-key authentication was rejected by the server.",
      ),
    },
  ];
  listener?.();
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Local connection failed/);

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Dismiss/);
  view.stdin.write("\r");
  await tick();
  assert.doesNotMatch(view.lastFrame(), /Local connection failed/);
  assert.match(view.lastFrame(), /40136 → Server:8188 · failed/);

  await chooseVisibleAction(view, "Retry connection");
  await tick();
  await tick();
  assert.equal(retryCalls, 1);
  assert.match(view.lastFrame(), /40137 → Server:8188/);
  assert.doesNotMatch(view.lastFrame(), /40136 → Server:8188 · failed/);
});

test("late service-port failure is edit-first and returns to the retained service port", async () => {
  let listener;
  let connections = [
    {
      id: "foreground:late-service",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      requestedLocalPort: 48188,
      endpoint: { host: "127.0.0.1", port: 48188 },
      accessMethod: { id: "ssh-secret", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
  ];
  const operations = {
    list() {
      return connections;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async listAccessMethods() {
      return [];
    },
    async open() {
      assert.fail("open is not expected while editing");
    },
    async close(id) {
      assert.equal(id, "foreground:late-service");
      connections = [];
      listener?.();
    },
    async closeAll() {
      connections = [];
      listener?.();
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  connections = [
    {
      ...connections[0],
      state: "failed",
      failure: normalizedError(
        "provider-unavailable",
        "SSH connected, but the requested service port is not accepting connections yet.",
      ),
    },
  ];
  listener?.();
  await tick();
  await tick();
  await tick();

  assert.match(view.lastFrame(), /SSH to Server works/);
  assert.match(view.lastFrame(), /Edit service port/);
  assert.match(view.lastFrame(), /Retry connection/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /App\/service port on the server/);
  assert.match(view.lastFrame(), /Port: 8188/);
  assert.doesNotMatch(view.lastFrame(), /Local connection failed/);
});

test("late foreground recovery owns the qualified 60x20 viewport", async () => {
  const failed = {
    id: "foreground:late-viewport",
    instanceId: "instance:connect",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    endpoint: { host: "127.0.0.1", port: 40135 },
    accessMethod: { id: "ssh-secret", kind: "ssh", mode: "tcp-forward" },
    state: "failed",
    failure: normalizedError(
      "authentication",
      "SSH public-key authentication was rejected by the server.",
    ),
  };
  const view = render(
    shell({
      width: 60,
      height: 20,
      readSnapshot: foregroundConnectionSnapshot(),
      readStatus: "ready",
      foregroundConnections: [failed],
      foregroundConnectionRecoveryId: failed.id,
      operation: presentOperationError({
        title: "Local connection failed",
        operation: "read",
        error: normalizedError(
          "authentication",
          "SSH public-key authentication to Server was rejected. Add the matching SSH private key on this computer or authorize its public key on the server, then retry.",
        ),
        retryLabel: "Retry connection",
        allowDiagnostics: true,
        ownsViewport: true,
      }),
    }),
  );
  await tick();

  const frame = view.lastFrame();
  assert.ok(frame.split("\n").length <= 20, frame);
  assert.match(frame, /Retry connection/);
  assert.match(frame, /Open Diagnostics/);
  assert.doesNotMatch(frame, /Connections\n|40135 → Server:8188/);
});

test("late foreground failure waits for an active operation drawer instead of replacing it", async () => {
  let listener;
  let resolveMethods;
  let connections = [
    {
      id: "foreground:queued-failure",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      endpoint: { host: "127.0.0.1", port: 40133 },
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
  ];
  const methodsGate = new Promise((resolve) => {
    resolveMethods = resolve;
  });
  const method = { id: "ssh", kind: "ssh", mode: "tcp-forward" };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: {
        list() {
          return connections;
        },
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        async listAccessMethods() {
          return methodsGate;
        },
        async open() {
          assert.fail("open is not expected");
        },
        async close() {},
        async closeAll() {},
      },
    }),
  );

  await tick();
  await tick();
  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Check connection method/);

  connections = [
    {
      ...connections[0],
      state: "failed",
      failure: normalizedError(
        "authentication",
        "SSH public-key authentication was rejected by the server.",
      ),
    },
  ];
  listener?.();
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Check connection method/);
  assert.doesNotMatch(view.lastFrame(), /Local connection failed/);

  resolveMethods([method]);
  await tick();
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Local connection failed/);
  assert.match(view.lastFrame(), /SSH public-key authentication to Server was rejected/);
});

test("screen-reader mode exposes late foreground SSH failure linearly without internal identity", async () => {
  let listener;
  let connections = [
    {
      id: "foreground:screen-reader-secret",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      endpoint: { host: "127.0.0.1", port: 40132 },
      accessMethod: { id: "ssh-screen-reader-secret", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
  ];
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: true,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: {
        list() {
          return connections;
        },
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        async listAccessMethods() {
          return [];
        },
        async open() {
          assert.fail("open is not expected");
        },
        async close() {},
        async closeAll() {},
      },
    }),
  );
  await tick();
  await tick();

  connections = [
    {
      ...connections[0],
      state: "failed",
      failure: normalizedError(
        "authentication",
        "SSH public-key authentication was rejected by the server.",
      ),
    },
  ];
  listener?.();
  await tick();
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Local connection failed/);
  assert.match(view.lastFrame(), /SSH public-key authentication to Server was rejected/);
  assert.match(view.lastFrame(), /Open Diagnostics/);
  assert.doesNotMatch(
    view.lastFrame(),
    /foreground:screen-reader-secret|instance:connect|ssh-screen-reader-secret|Credentials need attention|Open Providers/,
  );
});

test("connection host-key and keyscan failures give SSH-specific remediation", async () => {
  const renderFailure = async (error) => {
    const view = render(
      React.createElement(TuiApp, {
        colorEnabled: false,
        screenReader: false,
        readLoader: async () => foregroundConnectionSnapshot(),
        foregroundConnectionOperations: {
          list() {
            return [];
          },
          async listAccessMethods() {
            throw error;
          },
          async open() {
            assert.fail("open is not expected");
          },
          async close() {},
          async closeAll() {},
        },
      }),
    );
    await tick();
    await tick();
    await openServersRoute(view);
    await chooseVisibleAction(view, "Connect");
    await typeText(view, "22");
    view.stdin.write("\r");
    await tick();
    await tick();
    return view;
  };

  const changedHost = await renderFailure(
    normalizedError(
      "authentication",
      "SSH host key mismatch for secret-host.example:2222",
    ),
  );
  assert.match(changedHost.lastFrame(), /SSH host identity for Server changed/);
  assert.match(changedHost.lastFrame(), /Verify the server was/);
  assert.match(changedHost.lastFrame(), /replaced or reinstalled/);
  assert.doesNotMatch(
    changedHost.lastFrame(),
    /Credentials need attention|Open Providers|secret-host\.example/,
  );
  cleanup();

  const staleFirstUse = await renderFailure(
    normalizedError(
      "authentication",
      "SSH host key changed before trust confirmation for secret-host.example:2222",
    ),
  );
  assert.match(staleFirstUse.lastFrame(), /fingerprint for Server changed since you reviewed it/i);
  assert.match(staleFirstUse.lastFrame(), /Nothing was trusted/i);
  assert.doesNotMatch(staleFirstUse.lastFrame(), /remove the stale EasyServer host key/i);
  cleanup();

  const rejectedLogin = await renderFailure(
    normalizedError(
      "authentication",
      "SSH authentication was rejected by the server.",
    ),
  );
  assert.match(rejectedLogin.lastFrame(), /Connection authentication for Server was rejected/);
  assert.match(rejectedLogin.lastFrame(), /Check the login or key expected/);
  assert.match(rejectedLogin.lastFrame(), /server and retry/);
  assert.doesNotMatch(rejectedLogin.lastFrame(), /Credentials need attention|Open Providers/i);
  cleanup();

  const keyscan = await renderFailure(
    normalizedError(
      "provider-unavailable",
      "EasyServer could not obtain the SSH host fingerprint. The SSH endpoint may not be ready, or the local SSH tools could not complete host-key discovery.",
    ),
  );
  assert.match(keyscan.lastFrame(), /could not obtain an SSH host fingerprint/i);
  assert.match(keyscan.lastFrame(), /cannot safely ask you/i);
  assert.match(keyscan.lastFrame(), /trust a key yet/i);
  assert.match(keyscan.lastFrame(), /OpenSSH Client|SSH tools/i);
  assert.doesNotMatch(keyscan.lastFrame(), /Open Providers|credentials/i);
  cleanup();

  const servicePort = await renderFailure(
    normalizedError(
      "provider-unavailable",
      "SSH connected, but the requested service port is not accepting connections yet.",
    ),
  );
  assert.match(servicePort.lastFrame(), /SSH to Server works/);
  assert.match(servicePort.lastFrame(), /requested app\/service port is not accepting connections yet/);
  assert.match(servicePort.lastFrame(), /Start or/);
  assert.match(servicePort.lastFrame(), /wait for that service/);
  assert.match(servicePort.lastFrame(), /edit the service port/);
  assert.doesNotMatch(servicePort.lastFrame(), /Open Providers|credentials|SSH for Server is not ready/i);
  cleanup();

  const forwardingPolicy = await renderFailure(
    normalizedError(
      "unsupported-operation",
      "SSH connected, but this server does not permit TCP forwarding.",
    ),
  );
  assert.match(forwardingPolicy.lastFrame(), /SSH (?:to Server )?works/i);
  assert.match(forwardingPolicy.lastFrame(), /does not allow TCP forwarding/i);
  assert.doesNotMatch(forwardingPolicy.lastFrame(), /No supported connection method/i);
  cleanup();

  const targetTimeout = await renderFailure(
    normalizedError(
      "provider-unavailable",
      "SSH connected, but the requested service could not be reached from the server.",
    ),
  );
  assert.match(targetTimeout.lastFrame(), /SSH to Server works/i);
  assert.match(targetTimeout.lastFrame(), /app\/service port could not be reached/i);
  assert.doesNotMatch(targetTimeout.lastFrame(), /SSH for Server is not ready/i);
  cleanup();

  const unknownSsh = await renderFailure(
    normalizedError("plugin-failure", "OpenSSH connection failed unexpectedly."),
  );
  assert.match(unknownSsh.lastFrame(), /SSH transport to Server ended unexpectedly/i);
  assert.doesNotMatch(unknownSsh.lastFrame(), /Open Diagnostics for details/i);
});

test("closing ordinary local and background connections keeps internal identity out of drawers", async () => {
  const foregroundConnection = {
    id: "foreground:internal-secret",
    instanceId: "instance:close-secret",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    endpoint: { host: "127.0.0.1", port: 40130 },
    accessMethod: { id: "ssh-secret", kind: "ssh", mode: "tcp-forward" },
    state: "live",
  };
  const foregroundView = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () =>
        readSnapshot({
          instances: {
            status: "ready",
            complete: true,
            providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
            items: [
              {
                id: "instance:close-secret",
                name: "Close target",
                providerId: "fixture",
                providerExternalId: "provider-secret",
                management: "managed",
                freshness: "fresh",
                state: "running",
                availableActions: [],
              },
            ],
          },
        }),
      foregroundConnectionOperations: {
        list() {
          return [foregroundConnection];
        },
        async listAccessMethods() {
          return [];
        },
        async open() {
          assert.fail("open is not expected");
        },
        async close() {
          throw normalizedError(
            "provider-unavailable",
            "fixture / provider-secret / instance:close-secret / ssh-secret",
          );
        },
        async closeAll() {},
      },
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(foregroundView);
  await chooseVisibleAction(foregroundView, "Close local connection");
  await tick();
  await tick();
  assert.match(foregroundView.lastFrame(), /Could not prepare a connection to Close target/);
  assert.doesNotMatch(
    foregroundView.lastFrame(),
    /foreground:internal-secret|instance:close-secret|provider-secret|ssh-secret|fixture/,
  );

  let finishBackgroundClose;
  const closeGate = new Promise((resolve) => {
    finishBackgroundClose = resolve;
  });
  const backgroundSession = {
    id: "session:internal-secret",
    state: "live",
    instanceId: "instance:background-secret",
    remoteHost: "127.0.0.1",
    remotePort: 9000,
    accessMethod: { id: "ssh-background-secret", kind: "ssh", mode: "tcp-forward" },
    endpoint: { host: "127.0.0.1", port: 49000 },
  };
  const backgroundView = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () =>
        readSnapshot({
          instances: {
            status: "ready",
            complete: true,
            providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
            items: [
              {
                id: "instance:background-secret",
                name: "Background target",
                providerId: "fixture",
                providerExternalId: "background-provider-secret",
                management: "managed",
                freshness: "fresh",
                state: "running",
                availableActions: [],
              },
            ],
          },
          daemon: {
            status: "running",
            sessions: {
              status: "ready",
              total: 1,
              live: 1,
              closing: 0,
              failed: 0,
              items: [backgroundSession],
            },
            endpointIntents: {
              status: "ready",
              total: 0,
              live: 0,
              starting: 0,
              error: 0,
              disabled: 0,
              items: [],
            },
          },
        }),
      daemonOperations: {
        async closeSession() {
          await closeGate;
        },
      },
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(backgroundView);
  await chooseVisibleAction(backgroundView, "Close local connection");
  await tick();
  assert.match(backgroundView.lastFrame(), /Closing the background connection for Background target/);
  assert.doesNotMatch(
    backgroundView.lastFrame(),
    /session:internal-secret|instance:background-secret|background-provider-secret|ssh-background-secret/,
  );
  finishBackgroundClose();
  await tick();
  await tick();
});

test("screen-reader server Connect stays linear without exposing internal connection identity", async () => {
  const method = { id: "ssh-default", kind: "ssh", mode: "tcp-forward" };
  const view = render(
    shell({
      width: 60,
      height: 20,
      screenReader: true,
      readSnapshot: foregroundConnectionSnapshot(),
      readStatus: "ready",
      async onListForegroundAccessMethods(instanceId) {
        assert.equal(instanceId, "instance:connect");
        return [method];
      },
      async onOpenForegroundConnection(request) {
        assert.equal(request.accessMethodId, "ssh-default");
        return {
          id: "foreground:screen-reader",
          instanceId: request.instanceId,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort,
          endpoint: { host: "127.0.0.1", port: 40124 },
          accessMethod: method,
          state: "live",
        };
      },
      async onCloseForegroundConnection() {
        return true;
      },
    }),
  );

  await openServersRoute(view);
  await chooseVisibleAction(view, "Connect");
  assert.match(view.lastFrame(), /App\/service port on the server/);
  assert.match(view.lastFrame(), /not the SSH port/i);
  assert.match(view.lastFrame(), /Enter continue · Backspace edit · Esc back/);
  assert.doesNotMatch(view.lastFrame(), /Commands: Up and Down move/);
  assert.doesNotMatch(view.lastFrame(), /instance:connect|fixture|ssh-default|Access Method|Endpoint|daemon|Session/);

  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Local port on this computer/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Review local connection/);
  assert.match(view.lastFrame(), /Server: Server/);
  assert.doesNotMatch(view.lastFrame(), /instance:connect|fixture|ssh-default|Access Method|Endpoint|daemon|Session/);
});

test("local connection port conflicts preserve the guided values for correction", async () => {
  const method = { id: "ssh", kind: "ssh", mode: "tcp-forward" };
  const operations = {
    list() {
      return [];
    },
    async listAccessMethods() {
      return [method];
    },
    async open() {
      throw normalizedError(
        "conflict",
        "Local Endpoint port is already in use: 48188",
      );
    },
    async close() {},
    async closeAll() {},
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  await chooseVisibleAction(view, "New local connection");
  assert.match(view.lastFrame(), /Choose server/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /App\/service port on the server/);
  assert.match(view.lastFrame(), /not the SSH port/i);
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Local port on this computer/);
  await typeText(view, "48188");
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Local address: 127\.0\.0\.1:48188/);

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Open local connection: failed/);
  assert.match(view.lastFrame(), /Local connection port is already in use: 48188/);
  assert.doesNotMatch(view.lastFrame(), /Endpoint|Access Method|Connection Session/);
  assert.match(view.lastFrame(), /Edit local port/);
  assert.doesNotMatch(view.lastFrame(), /Retry|Open Diagnostics|Review local connection/);

  view.stdin.write("\r");
  await tick();
  assert.doesNotMatch(view.lastFrame(), /Open local connection: failed/);
  assert.match(view.lastFrame(), /Local port on this computer/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:48188/);
});

test("first-use SSH trust is reviewed and accepted inside the local connection flow", async () => {
  const trust = hostTrustRequiredError(
    "ssh.example.test",
    2222,
    "ssh-ed25519",
    "SHA256:tui-fixture",
  );
  const method = { id: "ssh", kind: "ssh", mode: "tcp-forward" };
  let connections = [];
  let accepted;
  const operations = {
    list() {
      return connections;
    },
    async listAccessMethods() {
      return [method];
    },
    async open(request, _context, interaction) {
      accepted = await interaction.confirmHostTrust(
        trust,
        new AbortController().signal,
      );
      assert.equal(accepted, true);
      const connection = {
        id: "foreground:ssh",
        instanceId: request.instanceId,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        endpoint: { host: "127.0.0.1", port: 40222 },
        accessMethod: method,
        state: "live",
      };
      connections = [connection];
      return connection;
    },
    async close() {},
    async closeAll() {
      connections = [];
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  await chooseVisibleAction(view, "New local connection");
  view.stdin.write("\r");
  await tick();
  await typeText(view, "22");
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Local port on this computer/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Review local connection/);
  view.stdin.write("\r");
  await tick();

  assert.match(view.lastFrame(), /SSH host trust required/);
  assert.match(view.lastFrame(), /Host: ssh\.example\.test:2222/);
  assert.match(view.lastFrame(), /Fingerprint: SHA256:tui-fixture/);
  assert.match(view.lastFrame(), /Trust this fingerprint/);

  assert.match(view.lastFrame(), /> Decline/);

  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.equal(accepted, true);
  assert.match(view.lastFrame(), /127\.0\.0\.1:40222 → Server:22/);
});

test("quitting with live local connections states the count and renders closing before exit", async () => {
  let connections = [
    {
      id: "foreground:a",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      endpoint: { host: "127.0.0.1", port: 41001 },
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
    {
      id: "foreground:b",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 7860,
      endpoint: { host: "127.0.0.1", port: 41002 },
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
      state: "live",
    },
  ];
  let closeAllCalls = 0;
  let finishCloseAll;
  const closeGate = new Promise((resolve) => {
    finishCloseAll = resolve;
  });
  const operations = {
    list() {
      return connections;
    },
    async listAccessMethods() {
      return [];
    },
    async open() {
      assert.fail("open is not expected");
    },
    async close() {},
    async closeAll() {
      closeAllCalls += 1;
      connections = connections.map((connection) => ({
        ...connection,
        state: "closing",
      }));
      await closeGate;
      connections = [];
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => foregroundConnectionSnapshot(),
      foregroundConnectionOperations: operations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  assert.match(view.lastFrame(), /127\.0\.0\.1:41001 → Server:8188/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:41002 → Server:7860/);

  view.stdin.write("q");
  await tick();
  assert.equal(closeAllCalls, 0);
  assert.match(view.lastFrame(), /2 local connections are still open in this TUI/);
  assert.match(view.lastFrame(), /Press q or Ctrl\+C again to close them and quit/);

  view.stdin.write("q");
  await tick();
  await tick();
  assert.equal(closeAllCalls, 1);
  assert.match(view.lastFrame(), /Closing 2 local connections/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:41001 → Server:8188 · closing/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:41002 → Server:7860 · closing/);

  finishCloseAll();
  await tick();
  await tick();
});

test("failed foreground records do not require cleanup confirmation before quitting", async () => {
  const stdin = new TtyInput();
  const stdout = new CaptureOutput();
  const stderr = new CaptureOutput();
  let cleanupCalls = 0;
  const app = renderInk(
    shell({
      foregroundConnections: [
        {
          id: "foreground:failed",
          instanceId: "instance:connect",
          remoteHost: "127.0.0.1",
          remotePort: 8188,
          endpoint: { host: "127.0.0.1", port: 41001 },
          accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
          state: "failed",
          failure: normalizedError(
            "authentication",
            "SSH public-key authentication was rejected by the server.",
          ),
        },
      ],
      async onQuitWithForegroundConnections() {
        cleanupCalls += 1;
        return true;
      },
    }),
    {
      stdin,
      stdout,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await app.waitUntilRenderFlush();
  stdin.write("q");
  await app.waitUntilExit();
  app.cleanup();

  assert.equal(cleanupCalls, 0);
  assert.doesNotMatch(stdout.text(), /still open in this TUI/);
  assert.equal(stderr.text(), "");
});

test("advanced background connection retry preserves one idempotency key across the guided TUI flow", async () => {
  const method = { id: "ssh", kind: "ssh", mode: "tcp-forward" };
  const requests = [];
  let attempts = 0;
  const foregroundOperations = {
    list() {
      return [];
    },
    async listAccessMethods() {
      return [method];
    },
    async open() {
      assert.fail("foreground open is not expected");
    },
    async close() {},
    async closeAll() {},
  };
  const daemonOperations = {
    async createSession(request) {
      requests.push(request);
      attempts += 1;
      if (attempts === 1) {
        throw normalizedError("provider-unavailable", "fixture response lost");
      }
      return {
        id: "session:persistent",
        state: "live",
        instanceId: request.instanceId,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        requestedAccessMethodId: request.accessMethodId,
        idempotencyKey: request.idempotencyKey,
        accessMethod: method,
        endpoint: { host: "127.0.0.1", port: 48188 },
      };
    },
    async start() {
      assert.fail("daemon start is not expected");
    },
    async stop() {
      assert.fail("daemon stop is not expected");
    },
    async shutdownImpact() {
      return { liveSessions: 0, activeEndpointIntents: 0 };
    },
    async closeSession() {},
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => persistentConnectionSnapshot(),
      foregroundConnectionOperations: foregroundOperations,
      daemonOperations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  view.stdin.write("p");
  await tick();
  assert.match(view.lastFrame(), /Advanced background connection/);
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  await typeText(view, "8188");
  view.stdin.write("\r");
  await tick();
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Review background connection/);
  assert.match(view.lastFrame(), /kept available in the background after TUI exit/);

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.equal(requests.length, 1);
  assert.match(requests[0].idempotencyKey, /^tui:/);
  assert.match(view.lastFrame(), /Create background local connection: failed/);
  assert.match(view.lastFrame(), /values are preserved for a safe retry/);

  view.stdin.write("x");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].idempotencyKey, requests[0].idempotencyKey);
  assert.deepEqual(
    { ...requests[1], idempotencyKey: undefined },
    { ...requests[0], idempotencyKey: undefined },
  );
});

test("daemon Stop reviews live persistent impact before shutdown dispatch", async () => {
  let stopped = false;
  let stopCalls = 0;
  const loader = async () =>
    stopped ? readSnapshot({ daemon: { status: "stopped" } }) : persistentConnectionSnapshot([
      {
        id: "session:one",
        state: "live",
        instanceId: "instance:connect",
        remoteHost: "127.0.0.1",
        remotePort: 8188,
        accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
        endpoint: { host: "127.0.0.1", port: 48188 },
      },
      {
        id: "session:two",
        state: "live",
        instanceId: "instance:connect",
        remoteHost: "127.0.0.1",
        remotePort: 7860,
        accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
        endpoint: { host: "127.0.0.1", port: 47860 },
      },
    ]);
  const daemonOperations = {
    async shutdownImpact() {
      return { liveSessions: 2, activeEndpointIntents: 1 };
    },
    async stop() {
      stopCalls += 1;
      stopped = true;
      return {
        status: "stopped",
        summary: { liveSessions: 2, activeEndpointIntents: 1 },
      };
    },
    async start() {
      assert.fail("start is not expected");
    },
    async createSession() {
      assert.fail("create is not expected");
    },
    async closeSession() {},
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: loader,
      daemonOperations,
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  await chooseVisibleAction(view, "Show technical details");
  await chooseVisibleAction(view, "Advanced: stop background connection service");
  await tick();
  assert.equal(stopCalls, 0);
  assert.match(view.lastFrame(), /Stop EasyServer daemon/);
  assert.match(view.lastFrame(), /closes 2 live persistent sessions and 1 active Endpoint intent/);
  assert.match(view.lastFrame(), /2 live persistent session\(s\)/);

  assert.match(view.lastFrame(), /> Cancel/);
  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();
  assert.equal(stopCalls, 1);
  assert.match(view.lastFrame(), /EasyServer daemon stopped/);
});

test("stopped daemon starts from Connections and refreshes to authenticated running state", async () => {
  let running = false;
  let startCalls = 0;
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () =>
        running ? persistentConnectionSnapshot() : readSnapshot({ daemon: { status: "stopped" } }),
      daemonOperations: {
        async start() {
          startCalls += 1;
          running = true;
          return {
            alreadyRunning: false,
            descriptor: {
              version: 1,
              address: { host: "127.0.0.1", port: 43210 },
              authToken: "not-rendered",
            },
          };
        },
        async shutdownImpact() {
          return { liveSessions: 0, activeEndpointIntents: 0 };
        },
        async stop() {
          assert.fail("stop is not expected");
        },
        async createSession() {
          assert.fail("create is not expected");
        },
        async closeSession() {},
      },
    }),
  );

  await tick();
  await tick();
  await openConnectionsRoute(view);
  assert.doesNotMatch(view.lastFrame(), /Background service:/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Background service: stopped/);
  await chooseVisibleAction(view, "Advanced: start background connection service");
  await tick();
  await tick();
  await tick();
  assert.equal(startCalls, 1);
  assert.match(view.lastFrame(), /Background service: running/);
  assert.doesNotMatch(view.lastFrame(), /not-rendered/);
});

test("unreachable daemon is distinct from stopped and blocks persistent mutations", async () => {
  let createCalls = 0;
  const view = render(
    shell({
      width: 110,
      readSnapshot: readSnapshot({ daemon: { status: "unreachable" } }),
      readStatus: "ready",
      async onListForegroundAccessMethods() {
        return [];
      },
      async onCreatePersistentSession() {
        createCalls += 1;
        return true;
      },
      async onClosePersistentSession() {
        return true;
      },
      async onStartDaemon() {
        return true;
      },
      async onStopDaemon() {
        return true;
      },
    }),
  );

  await openConnectionsRoute(view);
  assert.match(view.lastFrame(), /background connections need attention/);
  assert.doesNotMatch(view.lastFrame(), /Background service:/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Background service: unreachable/);
  await chooseVisibleAction(view, "Advanced: new background connection");
  await tick();
  assert.equal(createCalls, 0);
  assert.match(view.lastFrame(), /Background connections are unavailable/);

  view.rerender(
    shell({
      width: 110,
      readSnapshot: readSnapshot({ daemon: { status: "stale" } }),
      readStatus: "ready",
      async onListForegroundAccessMethods() {
        return [];
      },
      async onCreatePersistentSession() {
        createCalls += 1;
        return true;
      },
      async onClosePersistentSession() {
        return true;
      },
      async onStartDaemon() {
        return true;
      },
      async onStopDaemon() {
        return true;
      },
    }),
  );
  await tick();
  assert.match(view.lastFrame(), /Background service: stale/);
});

test("cleanup-failed background connection remains visible beside healthy connections and exposes its stable ID in technical details", async () => {
  const closed = [];
  const snapshot = persistentConnectionSnapshot([
    {
      id: "session:healthy",
      state: "live",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
      endpoint: { host: "127.0.0.1", port: 48188 },
    },
    {
      id: "session:cleanup-failed",
      state: "failed",
      instanceId: "instance:connect",
      remoteHost: "127.0.0.1",
      remotePort: 7860,
      accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
      failure: {
        code: "plugin-failure",
        message: "Connection Session cleanup failed",
      },
    },
  ]);
  const view = render(
    shell({
      width: 110,
      readSnapshot: snapshot,
      readStatus: "ready",
      async onClosePersistentSession(id) {
        closed.push(id);
        return true;
      },
      async onCreatePersistentSession() {
        return true;
      },
      async onStartDaemon() {
        return true;
      },
      async onStopDaemon() {
        return true;
      },
    }),
  );

  await openConnectionsRoute(view);
  assert.match(view.lastFrame(), /> 127\.0\.0\.1:48188 → Server:8188 · background/);
  assert.match(view.lastFrame(), /Local port unavailable → Server:7860 · background · failed/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Local port unavailable → Server:7860 · background · failed/);
  await chooseVisibleAction(view, "Show technical details");
  assert.match(view.lastFrame(), /Session ID: session:cleanup-failed/);
  assert.match(view.lastFrame(), /Cleanup failure: plugin-failure: Connection Session cleanup failed/);

  await chooseVisibleAction(view, "Close local connection");
  await tick();
  assert.deepEqual(closed, ["session:cleanup-failed"]);
});

test("TUI cleanup closes foreground Endpoints but leaves daemon-owned Sessions untouched", async () => {
  let foregroundCloseAll = 0;
  let daemonClose = 0;
  let daemonStop = 0;
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => persistentConnectionSnapshot([
        {
          id: "session:survives",
          state: "live",
          instanceId: "instance:connect",
          remoteHost: "127.0.0.1",
          remotePort: 8188,
          accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
          endpoint: { host: "127.0.0.1", port: 48188 },
        },
      ]),
      foregroundConnectionOperations: {
        list() {
          return [];
        },
        async listAccessMethods() {
          return [];
        },
        async open() {
          assert.fail("open is not expected");
        },
        async close() {},
        async closeAll() {
          foregroundCloseAll += 1;
        },
      },
      daemonOperations: {
        async start() {
          assert.fail("start is not expected");
        },
        async shutdownImpact() {
          return { liveSessions: 1, activeEndpointIntents: 0 };
        },
        async stop() {
          daemonStop += 1;
          return { status: "stopped", summary: { liveSessions: 1, activeEndpointIntents: 0 } };
        },
        async createSession() {
          assert.fail("create is not expected");
        },
        async closeSession() {
          daemonClose += 1;
        },
      },
    }),
  );

  await tick();
  await tick();
  cleanup();
  await tick();
  assert.equal(foregroundCloseAll, 1);
  assert.equal(daemonClose, 0);
  assert.equal(daemonStop, 0);
  void view;
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
  assert.match(view.lastFrame(), /> fixture · ready/);

  await chooseVisibleAction(view, "Refresh providers");
  await tick();
  assert.match(view.lastFrame(), /Refresh EasyServer status: failed/);
  assert.match(view.lastFrame(), /Showing the previous snapshot/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.doesNotMatch(view.lastFrame(), /Refresh EasyServer status: failed/);
  assert.match(view.lastFrame(), /Showing the previous snapshot/);
  assert.match(view.lastFrame(), /> fixture · ready/);
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
  assert.match(view.lastFrame(), /> fixture · ready/);

  await chooseVisibleAction(view, "Refresh providers");
  await tick();
  assert.equal(calls, 2);
  assert.match(view.lastFrame(), /> fixture · ready/);
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
      assert.match(frame, /> Quiet A · running/);
      assert.match(frame, /Quiet B · stopped/);
      assert.ok(frame.split("\n").length <= height);

      view.stdin.write("\u001b[B");
      await tick();
      frame = view.lastFrame();
      assert.match(frame, /> Quiet B · stopped/);
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
