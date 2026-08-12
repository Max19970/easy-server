import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
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

function shell(props = {}) {
  return React.createElement(TuiShell, { colorEnabled: false, ...props });
}

function readSnapshot(overrides = {}) {
  return {
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

class CaptureOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  chunks = [];

  write = (chunk) => {
    this.chunks.push(String(chunk));
    return true;
  };

  text() {
    return this.chunks.join("");
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

test("screen-reader runtime stays linear and preserves route, focus, content and help semantics", async () => {
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
  assert.match(stdout.text(), /Overview, active, focused/);
  assert.match(stdout.text(), /EasyServer at a glance/);
  assert.match(stdout.text(), /Choose a section to inspect or manage/);
  assert.match(stdout.text(), /Commands: Tab or arrows move focus/);

  let offset = stdout.text().length;
  stdin.write("\t");
  await app.waitUntilRenderFlush();
  assert.match(stdout.text().slice(offset), /Instances, focused/);

  offset = stdout.text().length;
  stdin.write("\r");
  await app.waitUntilRenderFlush();
  const openedInstances = stdout.text().slice(offset);
  assert.match(openedInstances, /Instances, active, focused/);
  assert.match(openedInstances, /Instance inventory and lifecycle workflows/);

  offset = stdout.text().length;
  stdin.write("?");
  await app.waitUntilRenderFlush();
  const helpUpdate = stdout.text().slice(offset);
  assert.match(helpUpdate, /Keyboard help/);
  assert.match(helpUpdate, /Tab \/ Shift\+Tab — move focus/);
  assert.match(helpUpdate, /q \/ Ctrl\+C — quit EasyServer/);

  stdin.write("q");
  await app.waitUntilExit();
  app.cleanup();
  assert.doesNotMatch(stdout.text(), /\u001b\[\?1049l/);
  assert.equal(stderr.text(), "");
});

test("operation interaction drawer owns input without disturbing route selection", async () => {
  const actions = [];
  const view = render(
    shell({
      width: 100,
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
  assert.match(view.lastFrame(), /Affected EasyServer resources: Provider inventory/);

  view.stdin.write("\t");
  await tick();
  assert.match(view.lastFrame(), /> Overview \[active\]/);
  assert.doesNotMatch(view.lastFrame(), /> Instances/);

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
  assert.match(view.lastFrame(), /R Refresh/);

  view.stdin.write("R");
  await tick();
  view.stdin.write("o");
  await tick();
  assert.deepEqual(actions, ["refresh", "observe"]);
  assert.equal(actions.includes("retry"), false);

  view.stdin.write("\t");
  await tick();
  assert.match(view.lastFrame(), /> Instances/);
  assert.match(view.lastFrame(), /Rent GPU: outcome unknown/);
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

test("non-modal drawer shortcuts do not steal route refresh or Escape navigation", async () => {
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> Instances \[active\]/);

  view.stdin.write("?");
  await tick();
  assert.match(view.lastFrame(), /Keyboard help/);
  view.stdin.write("\u001b");
  await flushEscape();
  assert.doesNotMatch(view.lastFrame(), /Keyboard help/);
  assert.match(view.lastFrame(), /> Instances \[active\]/);
  assert.deepEqual(actions, []);

  view.stdin.write("r");
  await tick();
  assert.match(view.lastFrame(), /Refresh requested for Instances\./);
  assert.deepEqual(actions, []);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.match(view.lastFrame(), /> Overview \[active\]/);
  assert.deepEqual(actions, []);

  view.stdin.write("R");
  await tick();
  view.stdin.write("x");
  await tick();
  assert.deepEqual(actions, ["refresh", "dismiss"]);
});

test("read-only surfaces make zero-provider and zero-instance states actionable", async () => {
  const view = render(
    shell({ width: 100, readSnapshot: readSnapshot(), readStatus: "ready" }),
  );

  assert.match(view.lastFrame(), /No provider plugins configured/);
  assert.match(view.lastFrame(), /No compute instances yet/);
  assert.match(view.lastFrame(), /Open Providers/);

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Instances/);
  assert.match(view.lastFrame(), /No compute instances yet/);
  assert.match(view.lastFrame(), /Configure a provider first/);

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Providers/);
  assert.match(view.lastFrame(), /easyserver plugins add <module>/);
});

test("Providers can register an already-installed plugin module without leaving the TUI", async () => {
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Press a to register an already-installed provider/);

  view.stdin.write("a");
  await tick();
  assert.match(view.lastFrame(), /Register installed provider/);
  assert.match(view.lastFrame(), /Module or path:/);

  await typeText(view, "q-provider");
  assert.match(view.lastFrame(), /q-provider/);

  view.stdin.write("\r");
  await tick();
  assert.deepEqual(mutations, [
    { kind: "add-plugin", source: "q-provider" },
  ]);
  assert.doesNotMatch(view.lastFrame(), /Register installed provider/);
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("a");
  await tick();
  assert.match(view.lastFrame(), /Register installed provider/);
  await typeText(view, "@fixture/provider");
  view.stdin.write("\u001b");
  await flushEscape();

  assert.deepEqual(mutations, []);
  assert.doesNotMatch(view.lastFrame(), /Register installed provider/);
  assert.match(view.lastFrame(), /No provider plugins configured/);
});

test("TuiApp refreshes provider state after registration mutation succeeds", async () => {
  let registered = false;
  const mutations = [];
  const loader = async () =>
    readSnapshot({
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("a");
  await tick();
  await typeText(view, "@fixture/provider");
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(mutations, [
    { kind: "add-plugin", source: "@fixture/provider" },
  ]);
  assert.match(view.lastFrame(), /Fixture Provider/);
  assert.match(view.lastFrame(), /Source: @fixture\/provider/);
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

  assert.match(view.lastFrame(), /Provider issues/);
  assert.match(view.lastFrame(), /offline.*provider-unavailable/);
  assert.match(view.lastFrame(), /Instances: 1 total/);
  assert.match(view.lastFrame(), /Live sessions: 1/);

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Inventory is partial/);
  assert.match(view.lastFrame(), /offline.*provider-unavailable/);
  assert.match(view.lastFrame(), /Healthy GPU/);
  assert.match(view.lastFrame(), /Normalized state: running/);
  assert.match(view.lastFrame(), /Available actions: none/);

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Healthy Provider/);
  assert.match(view.lastFrame(), /broken-plugin\.mjs/);
  assert.match(view.lastFrame(), /failed · incompatible/);
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

  assert.match(view.lastFrame(), /provider inventory is\s+incomplete/i);
  assert.doesNotMatch(view.lastFrame(), /Configure a provider first/);

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Inventory is partial/);
  assert.match(view.lastFrame(), /Review the provider issue/);
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /EasyServer ID: instance:a/);
  assert.match(view.lastFrame(), /Available actions: none/);

  view.stdin.write("j");
  await tick();
  assert.match(view.lastFrame(), /EasyServer ID: instance:b/);
  assert.match(view.lastFrame(), /Available actions: instance\.stop, instance\.destroy/);
});

test("instance selection is preserved by canonical ID across reorder and narrow layout", async () => {
  const instanceA = {
    id: "instance:a",
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("j");
  await tick();
  assert.match(view.lastFrame(), /EasyServer ID: instance:b/);

  view.rerender(shell({ width: 60, readSnapshot: reordered, readStatus: "ready" }));
  await tick();
  assert.match(view.lastFrame(), /Control center · compact layout/);
  assert.match(view.lastFrame(), /EasyServer ID: instance:b/);
  assert.match(view.lastFrame(), /Provider: fixture/);
  assert.match(view.lastFrame(), /Management: discovered/);
  assert.match(view.lastFrame(), /Normalized state: stopped/);
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
  assert.match(view.lastFrame(), /Providers: 1 configured/);

  view.stdin.write("r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Refresh EasyServer status: failed/);
  assert.match(view.lastFrame(), /Showing the previous snapshot/);

  view.stdin.write("x");
  await tick();
  assert.doesNotMatch(view.lastFrame(), /Refresh EasyServer status: failed/);
  assert.match(view.lastFrame(), /Showing the previous snapshot/);
  assert.match(view.lastFrame(), /Providers: 1 configured/);
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
  assert.match(view.lastFrame(), /Providers: 1 configured/);

  view.stdin.write("r");
  await tick();
  await tick();
  assert.equal(calls, 2);
});

test("TUI shell exposes discoverable focus and keyboard navigation", async () => {
  const view = render(shell({ width: 100 }));

  assert.match(view.lastFrame(), /Control center · wide layout/);
  assert.match(view.lastFrame(), /> Overview \[active\]/);
  assert.match(view.lastFrame(), /Tab\/Shift\+Tab or arrows move/);

  view.stdin.write("\t");
  await tick();
  assert.match(view.lastFrame(), /> Instances/);
  assert.doesNotMatch(view.lastFrame(), /> Overview/);

  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> Instances \[active\]/);
  assert.match(view.lastFrame(), /Opened Instances\./);

  view.stdin.write("r");
  await tick();
  assert.match(view.lastFrame(), /Refresh requested for Instances\./);
});

test("TUI arrows and Shift+Tab share the focus-navigation path", async () => {
  const view = render(shell({ width: 100 }));

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Instances/);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Providers/);

  view.stdin.write("\u001b[Z");
  await tick();
  assert.match(view.lastFrame(), /> Instances/);
});

test("TUI help behaves like a modal and Escape returns to the active surface", async () => {
  const view = render(shell({ width: 100 }));

  view.stdin.write("?");
  await tick();
  assert.match(view.lastFrame(), /Keyboard help/);
  assert.match(view.lastFrame(), /q \/ Ctrl\+C — quit EasyServer/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.doesNotMatch(view.lastFrame(), /Keyboard help/);
  assert.match(view.lastFrame(), /EasyServer at a glance/);
});

test("TUI keeps route and focus state across wide-to-narrow resize", async () => {
  const view = render(shell({ width: 100 }));

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\t");
  await tick();
  assert.match(view.lastFrame(), /> Providers/);
  assert.match(view.lastFrame(), /Instances \[active\]/);

  view.rerender(shell({ width: 60 }));
  await tick();
  assert.match(view.lastFrame(), /Control center · compact layout/);
  assert.match(view.lastFrame(), /> Providers/);
  assert.match(view.lastFrame(), /Instances \[active\]/);
});

test("TUI screen-reader mode renders a calm linear command summary", () => {
  const view = render(shell({ width: 60, screenReader: true }));

  assert.match(view.lastFrame(), /Control center · compact layout/);
  assert.match(
    view.lastFrame(),
    /Commands: Tab or arrows move focus; Enter opens; Escape returns or closes help;/,
  );
  assert.match(view.lastFrame(), /> Overview \[active\]/);
});
