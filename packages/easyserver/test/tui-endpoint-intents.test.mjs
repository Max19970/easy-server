import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TuiApp, TuiShell } from "../dist/tui.js";

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

function snapshot(items) {
  return {
    providerWorkflows: { status: "ready", items: [] },
    providers: { status: "ready", items: [] },
    instances: { status: "ready", items: [], providerOutcomes: [], complete: true },
    daemon: {
      status: "running",
      sessions: {
        status: "ready",
        total: 1,
        live: 1,
        closing: 0,
        failed: 0,
        items: [
          {
            id: "session:runtime-only",
            state: "live",
            instanceId: "instance:session",
            remoteHost: "127.0.0.1",
            remotePort: 9000,
            requestedLocalPort: 49000,
            accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
            endpoint: { host: "127.0.0.1", port: 49000 },
          },
        ],
      },
      endpointIntents: {
        status: "ready",
        total: items.length,
        live: items.filter((item) => item.state === "live").length,
        starting: items.filter((item) => item.state === "starting").length,
        error: items.filter((item) => item.state === "error").length,
        disabled: items.filter((item) => item.state === "disabled").length,
        items,
      },
    },
  };
}

const intents = [
  {
    name: "comfy",
    enabled: true,
    state: "live",
    instanceId: "instance:comfy",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    endpoint: { host: "127.0.0.1", port: 55123 },
    accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
  },
  {
    name: "api",
    enabled: true,
    state: "starting",
    instanceId: "instance:api",
    remoteHost: "127.0.0.1",
    remotePort: 8000,
    requestedLocalPort: 48000,
  },
  {
    name: "port-conflict",
    enabled: true,
    state: "error",
    instanceId: "instance:web",
    remoteHost: "127.0.0.1",
    remotePort: 7860,
    requestedLocalPort: 47860,
    failure: { code: "conflict", message: "Requested local port 47860 is occupied" },
  },
  {
    name: "trust",
    enabled: true,
    state: "error",
    instanceId: "instance:trust",
    remoteHost: "127.0.0.1",
    remotePort: 22,
    failure: {
      code: "host-trust-required",
      message: "SSH host trust required; fingerprint SHA256:fixture",
    },
  },
  {
    name: "credentials",
    enabled: true,
    state: "error",
    instanceId: "instance:credentials",
    remoteHost: "127.0.0.1",
    remotePort: 22,
    failure: { code: "authentication", message: "Provider credential rejected" },
  },
  {
    name: "provider",
    enabled: true,
    state: "error",
    instanceId: "instance:provider",
    remoteHost: "127.0.0.1",
    remotePort: 22,
    failure: { code: "provider-unavailable", message: "Provider is offline" },
  },
  {
    operationName: "disabled\u001b[2J",
    name: "disabled\\u001b[2J",
    enabled: false,
    state: "disabled",
    instanceId: "instance:disabled",
    remoteHost: "127.0.0.1",
    remotePort: 22,
  },
].map((intent) => ({ ...intent, operationName: intent.operationName ?? intent.name }));

async function openConnections(view) {
  for (let index = 0; index < 4; index += 1) {
    view.stdin.write("\t");
    await tick();
  }
  view.stdin.write("\r");
  await tick();
}

test("Connections keeps persisted Endpoint intents distinct from runtime Sessions and exposes recovery actions", async () => {
  const enabledCalls = [];
  const retryCalls = [];
  const removeCalls = [];
  const view = render(
    React.createElement(TuiShell, {
      colorEnabled: false,
      width: 120,
      readSnapshot: snapshot(intents),
      readStatus: "ready",
      foregroundConnections: [
        {
          id: "foreground:one",
          state: "live",
          instanceId: "instance:foreground",
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
          endpoint: { host: "127.0.0.1", port: 53000 },
        },
      ],
      async onSetEndpointIntentEnabled(name, enabled) {
        enabledCalls.push([name, enabled]);
        return true;
      },
      async onRetryEndpointIntent(name) {
        retryCalls.push(name);
        return true;
      },
      onRemoveEndpointIntent(intent) {
        removeCalls.push(intent.operationName);
      },
    }),
  );

  await openConnections(view);
  assert.match(view.lastFrame(), /Persisted Endpoint intents \(desired state\)/);
  assert.match(view.lastFrame(), /Daemon-owned Connection Sessions \(runtime state\)/);
  assert.match(view.lastFrame(), /comfy · enabled · live endpoint=127\.0\.0\.1:55123/);
  assert.doesNotMatch(view.lastFrame(), /Requested local port:/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:53000 · live · instance:foreground/);
  assert.match(view.lastFrame(), /session:runtime-only · live · 127\.0\.0\.1:49000/);
  assert.match(view.lastFrame(), /old dead transport is never treated as live/);

  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /Name: comfy/);
  assert.match(view.lastFrame(), /Desired state: enabled/);
  assert.match(view.lastFrame(), /Requested local port: dynamic/);

  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /Name: api/);
  assert.match(view.lastFrame(), /Realization state: starting/);
  assert.match(view.lastFrame(), /Requested local port: 48000/);

  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /Name: port-conflict/);
  assert.match(view.lastFrame(), /fixed local port is unavailable/);
  await chooseVisibleAction(view, "Retry selected saved Endpoint");
  assert.deepEqual(retryCalls, ["port-conflict"]);

  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /exact SSH host fingerprint/);
  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /configure or rotate the required provider credential/);
  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /restore provider or instance availability/);
  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Show connection details");
  assert.match(view.lastFrame(), /Desired state: disabled/);
  assert.match(view.lastFrame(), /disabled\\u001b\[2J/);
  await chooseVisibleAction(view, "Enable selected saved Endpoint");
  assert.deepEqual(enabledCalls, [["disabled\u001b[2J", true]]);
  await chooseVisibleAction(view, "Remove selected saved Endpoint");
  assert.deepEqual(removeCalls, ["disabled\u001b[2J"]);
});

test("TuiApp confirms live persisted intent removal and delegates cleanup to the daemon", async () => {
  let removed = false;
  let loaderCalls = 0;
  const liveIntent = intents[0];
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        loaderCalls += 1;
        return snapshot(removed ? [] : [liveIntent]);
      },
      daemonOperations: {
        async removeEndpointIntent(name) {
          assert.equal(name, "comfy");
          removed = true;
        },
        async setEndpointIntentEnabled() {
          assert.fail("remove flow must not toggle desired state first");
        },
        async retryEndpointIntent() {
          assert.fail("remove flow must not retry realization");
        },
      },
    }),
  );

  await tick();
  await tick();
  await openConnections(view);
  await chooseVisibleAction(view, "Remove selected saved Endpoint");

  assert.equal(removed, false);
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /Remove persisted Endpoint intent comfy/);
  assert.match(view.lastFrame(), /Consequence:/);
  assert.match(view.lastFrame(), /Current live Endpoint[\s\S]*127\.0\.0\.1:55123/);

  assert.match(view.lastFrame(), /> Cancel/);
  view.stdin.write("\u001b[A");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();

  assert.equal(removed, true);
  assert.equal(loaderCalls, 2);
  assert.match(view.lastFrame(), /Persisted Endpoint intent removed/);
  assert.match(view.lastFrame(), /will not be recovered on daemon restart/);
});

test("TuiApp retries cleanup by the original intent identity after desired state was already removed", async () => {
  let desiredStateRemoved = false;
  const removedNames = [];
  const liveIntent = intents[0];
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        return snapshot(desiredStateRemoved ? [] : [liveIntent]);
      },
      daemonOperations: {
        async removeEndpointIntent(name) {
          removedNames.push(name);
          desiredStateRemoved = true;
          if (removedNames.length === 1) {
            throw new Error("fixture cleanup failure");
          }
        },
        async setEndpointIntentEnabled() {
          assert.fail("cleanup retry must not toggle desired state");
        },
        async retryEndpointIntent() {
          assert.fail("cleanup retry must not recreate realization");
        },
      },
    }),
  );

  await tick();
  await tick();
  await openConnections(view);
  view.stdin.write("X");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(removedNames, ["comfy"]);
  assert.match(view.lastFrame(), /cleanup incomplete/);
  assert.match(view.lastFrame(), /Desired state may already be deleted/);
  assert.match(view.lastFrame(), /Retry/);

  view.stdin.write("R");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(removedNames, ["comfy", "comfy"]);
  assert.match(view.lastFrame(), /Persisted Endpoint intent removed/);
  assert.match(view.lastFrame(), /will not be recovered on daemon restart/);
});

test("an unrelated failed refresh cannot reuse a stale Endpoint intent cleanup Retry", async () => {
  let desiredStateRemoved = false;
  let failRefresh = false;
  let loaderCalls = 0;
  const removedNames = [];
  const liveIntent = intents[0];
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      async readLoader() {
        loaderCalls += 1;
        if (failRefresh) {
          throw new Error("fixture refresh failure");
        }
        return snapshot(desiredStateRemoved ? [] : [liveIntent]);
      },
      daemonOperations: {
        async removeEndpointIntent(name) {
          removedNames.push(name);
          desiredStateRemoved = true;
          throw new Error("fixture cleanup failure");
        },
        async setEndpointIntentEnabled() {
          assert.fail("refresh Retry must not toggle desired state");
        },
        async retryEndpointIntent() {
          assert.fail("refresh Retry must not recreate intent realization");
        },
      },
    }),
  );

  await tick();
  await tick();
  await openConnections(view);
  view.stdin.write("X");
  await tick();
  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(removedNames, ["comfy"]);
  assert.match(view.lastFrame(), /cleanup incomplete/);

  failRefresh = true;
  view.stdin.write("r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Refresh EasyServer status: failed/);

  failRefresh = false;
  view.stdin.write("R");
  await tick();
  await tick();
  await tick();

  assert.deepEqual(removedNames, ["comfy"]);
  assert.ok(loaderCalls >= 4);
  assert.doesNotMatch(view.lastFrame(), /cleanup incomplete/);
});
