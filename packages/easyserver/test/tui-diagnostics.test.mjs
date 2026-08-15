import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";

import { createDiagnosticsReport } from "../dist/diagnostics.js";
import {
  copyTextToClipboard,
  serializeTuiDiagnostics,
} from "../dist/tui-diagnostics.js";
import { TuiApp, TuiShell } from "../dist/tui.js";
import { presentOperationError } from "../dist/tui-operation-model.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

async function openConnections(view) {
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
}

async function openProviders(view) {
  for (let index = 0; index < 3; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
}

test.afterEach(() => cleanup());

function readSnapshot() {
  return {
    providerWorkflows: { status: "ready", items: [] },
    providers: { status: "ready", items: [] },
    instances: {
      status: "ready",
      items: [],
      providerOutcomes: [],
      complete: true,
    },
    daemon: { status: "stopped" },
  };
}

function diagnosticsView(report) {
  return {
    status: "ready",
    text: serializeTuiDiagnostics(report),
    summary: {
      version: report.easyserver.version,
      stateStatus: report.state.status,
      configuredPlugins: report.state.configuredPlugins,
      failedPlugins: report.plugins.filter((plugin) => plugin.state === "failed").length,
      daemonStatus: report.daemon.status,
      ssh: report.access.ssh,
      sshKeyscan: report.access.sshKeyscan,
    },
  };
}

function safeReport() {
  return createDiagnosticsReport({
    easyserverVersion: "0.2.0-test",
    nodeVersion: "v24.0.0",
    platform: "win32",
    arch: "x64",
    stateStatus: "ok",
    state: {
      version: 1,
      plugins: [
        {
          source: "C:\\Users\\private\\provider.mjs",
          enabled: true,
          credentials: [
            { name: "api-key", secretRef: "secret:private-reference" },
          ],
        },
      ],
      instances: [
        {
          id: "instance:private-id",
          providerId: "fixture",
          providerExternalId: "private-provider-id",
        },
      ],
    },
    pluginStatuses: [
      {
        source: "C:\\Users\\private\\provider.mjs",
        state: "failed",
        error: "failed with fixture-super-secret and -----BEGIN OPENSSH PRIVATE KEY-----",
      },
    ],
    daemonStatus: { status: "unreachable" },
    sshAvailable: false,
    sshKeyscanAvailable: false,
  });
}

function longSafeReport() {
  const base = safeReport();
  return {
    ...base,
    state: {
      ...base.state,
      configuredPlugins: 70,
    },
    plugins: Array.from({ length: 70 }, (_, index) => ({
      identity: `fixture-plugin-${String(index + 1).padStart(2, "0")}`,
      state: index % 11 === 0 ? "failed" : "loaded",
      version: `1.${index}.0`,
      providerId: `provider-${index + 1}`,
      ...(index % 11 === 0 ? { failure: "load-failed" } : {}),
    })),
  };
}

async function openDiagnostics(view) {
  view.stdin.write("g");
  await tick();
  await tick();
  await tick();
}

test("TUI reviews the shared sanitized Diagnostics payload before copying the exact same JSON", async () => {
  const report = safeReport();
  const expected = serializeTuiDiagnostics(report);
  let copied;
  let diagnosticLoads = 0;
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        return readSnapshot();
      },
      diagnosticsOperations: {
        async load() {
          diagnosticLoads += 1;
          return report;
        },
        async copy(text) {
          copied = text;
        },
      },
    }),
  );

  await tick();
  await tick();
  assert.equal(diagnosticLoads, 0);
  assert.equal(copied, undefined);

  await openDiagnostics(view);
  const summaryFrame = view.lastFrame();
  assert.equal(diagnosticLoads, 1);
  assert.match(summaryFrame, /Support summary/);
  assert.match(summaryFrame, /EasyServer: v0\.2\.0-test/);
  assert.match(summaryFrame, /Local state: ready/);
  assert.match(summaryFrame, /Providers: 1 configured · 1 need attention/);
  assert.match(summaryFrame, /Connection service: unreachable/);
  assert.match(summaryFrame, /View report before sharing/);
  assert.doesNotMatch(summaryFrame, /"schemaVersion"/);
  assert.equal(copied, undefined);

  await chooseVisibleAction(view, "View report");
  let reportFrame = view.lastFrame();
  assert.match(reportFrame, /Privacy-safe diagnostics report/);
  assert.match(reportFrame, /Lines 1–\d+ of \d+/);
  assert.match(reportFrame, /"version": "0\.2\.0-test"/);

  for (const sensitive of [
    "fixture-super-secret",
    "secret:private-reference",
    "private-provider-id",
    "instance:private-id",
    "BEGIN OPENSSH PRIVATE KEY",
    "C:\\Users\\private",
  ]) {
    assert.equal(reportFrame.includes(sensitive), false, `TUI leaked ${sensitive}`);
  }

  for (let index = 0; index < 100; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  reportFrame = view.lastFrame();
  assert.match(reportFrame, /Lines \d+–\d+ of \d+/);
  assert.match(reportFrame, /Enter Copy report/);
  view.stdin.write("\r");
  await tick();
  assert.equal(copied, expected);
});

test("visual Diagnostics report remains bounded and reaches the last line at release terminal sizes", async () => {
  const report = longSafeReport();
  const diagnostics = diagnosticsView(report);
  let copied;
  const view = render(
    React.createElement(TuiShell, {
      colorEnabled: false,
      width: 60,
      height: 20,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      diagnostics,
      async onCopyDiagnostics() {
        copied = diagnostics.text;
        return true;
      },
    }),
  );

  await openDiagnostics(view);
  await chooseVisibleAction(view, "View report");
  assert.ok(view.lastFrame().split("\n").length <= 20);
  assert.match(view.lastFrame(), /Lines 1–\d+ of \d+/);

  for (let index = 0; index < 500; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  let position = view.lastFrame().match(/Lines (\d+)–(\d+) of (\d+)/);
  assert.ok(position);
  assert.equal(position[2], position[3], "60×20 viewer must reach the last visual line");
  assert.ok(view.lastFrame().split("\n").length <= 20);

  view.rerender(
    React.createElement(TuiShell, {
      colorEnabled: false,
      width: 80,
      height: 24,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      diagnostics,
      async onCopyDiagnostics() {
        copied = diagnostics.text;
        return true;
      },
    }),
  );
  await tick();
  position = view.lastFrame().match(/Lines (\d+)–(\d+) of (\d+)/);
  assert.ok(position);
  assert.equal(position[2], position[3], "80×24 viewer must preserve reachable end position");
  assert.ok(view.lastFrame().split("\n").length <= 24);

  view.rerender(
    React.createElement(TuiShell, {
      colorEnabled: false,
      width: 120,
      height: 40,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      diagnostics,
      async onCopyDiagnostics() {
        copied = diagnostics.text;
        return true;
      },
    }),
  );
  await tick();
  position = view.lastFrame().match(/Lines (\d+)–(\d+) of (\d+)/);
  assert.ok(position);
  assert.equal(position[2], position[3], "120×40 viewer must preserve reachable end position");
  assert.ok(view.lastFrame().split("\n").length <= 40);

  view.stdin.write("\r");
  await tick();
  assert.equal(copied, diagnostics.text, "copy must preserve the exact reviewed payload at any scroll position");
});

test("screen-reader mode exposes the same Diagnostics payload and remediation navigation", async () => {
  const report = safeReport();
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: true,
      async readLoader() {
        return readSnapshot();
      },
      diagnosticsOperations: {
        async load() {
          return report;
        },
        async copy() {},
      },
    }),
  );

  await tick();
  await tick();
  await openDiagnostics(view);
  assert.match(view.lastFrame(), /Support summary/);
  await chooseVisibleAction(view, "View report");
  assert.match(view.lastFrame(), /Full privacy-safe diagnostics report/);
  assert.match(view.lastFrame(), /"version": "0\.2\.0-test"/);
  assert.match(view.lastFrame(), /"ssh": "unavailable"/);
  assert.match(view.lastFrame(), /Commands: Up and Down move; Enter selects; Escape goes back/);

  view.stdin.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await chooseVisibleAction(view, "Open Providers");
  assert.match(view.lastFrame(), /Home › Settings & Support › Providers/);

  await openDiagnostics(view);
  await chooseVisibleAction(view, "Open Connections");
  assert.match(view.lastFrame(), /Opened Connections/);
});

test("Diagnostics collection failures stay generic and never echo the raw error", async () => {
  const secret = "fixture-secret-from-diagnostics-error";
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        return readSnapshot();
      },
      diagnosticsOperations: {
        async load() {
          throw new Error(secret);
        },
        async copy() {
          assert.fail("failed Diagnostics cannot be copied");
        },
      },
    }),
  );

  await tick();
  await tick();
  await openDiagnostics(view);
  assert.match(view.lastFrame(), /Privacy-safe Diagnostics could not be generated/);
  assert.match(view.lastFrame(), /Do not substitute raw logs/);
  assert.doesNotMatch(view.lastFrame(), new RegExp(secret));
});

test("connection-flow failures can open Diagnostics without discarding the guided form", async () => {
  const report = safeReport();
  const connectionSnapshot = {
    ...readSnapshot(),
    instances: {
      status: "ready",
      items: [
        {
          id: "instance:diagnostics",
          providerId: "fixture",
          providerExternalId: "remote-diagnostics",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "RUNNING",
          availableActions: [],
        },
      ],
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      complete: true,
    },
  };
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        return connectionSnapshot;
      },
      diagnosticsOperations: {
        async load() {
          return report;
        },
        async copy() {},
      },
      foregroundConnectionOperations: {
        list() {
          return [];
        },
        async listAccessMethods() {
          throw new Error("fixture access discovery failure");
        },
        async open() {
          assert.fail("failed discovery must not open a connection");
        },
        async close() {},
        async closeAll() {},
      },
    }),
  );

  await tick();
  await tick();
  await openConnections(view);
  view.stdin.write("n");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("2");
  await tick();
  view.stdin.write("2");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();

  assert.match(view.lastFrame(), /Discover Access Methods: failed/);
  assert.match(view.lastFrame(), /after closing this result, open Diagnostics/);
  assert.match(view.lastFrame(), /Port: 22/);

  view.stdin.write("g");
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Support summary/);
  assert.match(view.lastFrame(), /Opened privacy-safe Diagnostics from the connection failure/);

  view.stdin.write("\r");
  await tick();
  await tick();
  await chooseVisibleAction(view, "Open Connections");
  assert.match(view.lastFrame(), /Remote TCP port/);
  assert.match(view.lastFrame(), /Port: 22/);
});

test("provider readiness and operation failures expose a direct privacy-safe Diagnostics entry point", async () => {
  const providerSnapshot = {
    ...readSnapshot(),
    providers: {
      status: "ready",
      items: [
        {
          source: "fixture-provider",
          state: "loaded",
          readiness: "credentials-missing",
          credentials: {
            configured: 0,
            declared: 1,
            missingRequired: 1,
            items: [
              {
                name: "api-key",
                required: true,
                configured: false,
              },
            ],
          },
        },
      ],
    },
  };
  const providerView = render(
    React.createElement(TuiShell, {
      colorEnabled: false,
      readSnapshot: providerSnapshot,
      readStatus: "ready",
    }),
  );
  await openProviders(providerView);
  assert.match(providerView.lastFrame(), /fixture-provider · credentials-missing/);

  cleanup();
  let diagnosticRoute;
  const failureView = render(
    React.createElement(TuiShell, {
      colorEnabled: false,
      readSnapshot: readSnapshot(),
      readStatus: "ready",
      operation: presentOperationError({
        title: "Open connection",
        operation: "read",
        error: new Error("fixture connection failure"),
      }),
      onRefresh(routeId) {
        diagnosticRoute = routeId;
      },
    }),
  );
  assert.match(failureView.lastFrame(), /after closing this result, open Diagnostics before sharing raw logs/);
  failureView.stdin.write("g");
  await tick();
  assert.equal(diagnosticRoute, "diagnostics");
  assert.match(failureView.lastFrame(), /Home › Settings & Support › Diagnostics/);
});

test("clipboard integration passes the reviewed text unchanged and uses native platform commands", () => {
  const text = "{\n  \"safe\": true\n}";
  const windowsCalls = [];
  copyTextToClipboard(text, "win32", (command, args, options) => {
    windowsCalls.push({ command, args, input: options.input });
    return { status: 0 };
  });
  assert.deepEqual(windowsCalls, [
    { command: "clip.exe", args: [], input: text },
  ]);

  const linuxCalls = [];
  copyTextToClipboard(text, "linux", (command, args, options) => {
    linuxCalls.push({ command, args, input: options.input });
    return command === "xclip"
      ? { status: 0 }
      : { status: 1 };
  });
  assert.deepEqual(linuxCalls, [
    { command: "wl-copy", args: [], input: text },
    { command: "xclip", args: ["-selection", "clipboard"], input: text },
  ]);
});
