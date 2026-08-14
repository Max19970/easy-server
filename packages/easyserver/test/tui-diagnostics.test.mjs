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
  const frame = view.lastFrame();
  assert.equal(diagnosticLoads, 1);
  assert.match(frame, /User-safe Diagnostics payload/);
  assert.match(frame, /shared sanitized diagnostics model/);
  assert.match(frame, /Press c to copy exactly the JSON shown below/);
  assert.match(frame, /Raw logs are not the same as this sanitized payload/);
  assert.match(frame, /Press P to open Providers/);
  assert.match(frame, /Press C to open Connections/);
  assert.match(frame, /"version": "0\.2\.0-test"/);
  assert.equal(copied, undefined);

  for (const sensitive of [
    "fixture-super-secret",
    "secret:private-reference",
    "private-provider-id",
    "instance:private-id",
    "BEGIN OPENSSH PRIVATE KEY",
    "C:\\Users\\private",
  ]) {
    assert.equal(frame.includes(sensitive), false, `TUI leaked ${sensitive}`);
  }

  view.stdin.write("c");
  await tick();
  await tick();
  assert.equal(copied, expected);
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
  assert.match(view.lastFrame(), /"version": "0\.2\.0-test"/);
  assert.match(view.lastFrame(), /g opens privacy-safe Diagnostics/);

  view.stdin.write("P");
  await tick();
  assert.match(view.lastFrame(), /Providers \[active\]/);

  await openDiagnostics(view);
  view.stdin.write("C");
  await tick();
  assert.match(view.lastFrame(), /Status: Opened Connections for remediation/);
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
  for (let index = 0; index < 4; index += 1) {
    view.stdin.write("\t");
    await tick();
  }
  view.stdin.write("\r");
  await tick();
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
  assert.match(view.lastFrame(), /press g to inspect privacy-safe Diagnostics/);
  assert.match(view.lastFrame(), /Port: 22/);

  view.stdin.write("g");
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /User-safe Diagnostics payload/);
  assert.match(view.lastFrame(), /Opened privacy-safe Diagnostics from the connection failure/);

  view.stdin.write("C");
  await tick();
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
  providerView.stdin.write("\t");
  await tick();
  providerView.stdin.write("\t");
  await tick();
  providerView.stdin.write("\r");
  await tick();
  assert.match(providerView.lastFrame(), /press g to inspect privacy-safe Diagnostics/);

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
  assert.match(failureView.lastFrame(), /press g to inspect privacy-safe Diagnostics before sharing raw logs/);
  failureView.stdin.write("g");
  await tick();
  assert.equal(diagnosticRoute, "diagnostics");
  assert.match(failureView.lastFrame(), /Diagnostics \[active\]|Diagnostics[\s\S]*\[active\]/);
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
