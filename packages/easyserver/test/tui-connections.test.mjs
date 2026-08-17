import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render as renderInk } from "ink";
import { cleanup, render } from "ink-testing-library";
import {
  hostTrustRequiredError,
  normalizedError,
} from "@easyai101/easyserver-plugin-sdk";
import { normalizedConnectionError } from "../dist/connection-failure.js";
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

function storedConnectionFailure(code, connectionCause, message = "wording intentionally changed") {
  return {
    ...normalizedError(code, message),
    connectionCause,
  };
}

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
  assert.match(view.lastFrame(), /127\.0\.0\.1:40123\s+→ Server:8188\s+live/);
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
  assert.match(view.lastFrame(), /127\.0\.0\.1:40124\s+→ Server:8188\s+live/);
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
      failure: storedConnectionFailure(
        "authentication",
        "ssh-public-key-rejected",
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
  assert.match(view.lastFrame(), /40134\s+→ Server:8188\s+live/);
  assert.doesNotMatch(view.lastFrame(), /Local connection failed/);
});

test("typed trusted-host mismatch blocks Retry regardless of human wording", async () => {
  const view = render(
    shell({
      readSnapshot: foregroundConnectionSnapshot(),
      readStatus: "ready",
      foregroundConnections: [
        {
          id: "foreground:mismatch",
          instanceId: "instance:connect",
          remoteHost: "127.0.0.1",
          remotePort: 8188,
          endpoint: { host: "127.0.0.1", port: 40139 },
          accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
          state: "failed",
          failure: storedConnectionFailure(
            "authentication",
            "ssh-host-identity-mismatch",
            "completely unrelated display wording",
          ),
        },
      ],
      async onRetryForegroundConnection() {
        assert.fail("trusted-host mismatch must not expose Retry");
      },
      async onCloseForegroundConnection() {
        return true;
      },
      async onListForegroundAccessMethods() {
        return [];
      },
      async onOpenForegroundConnection() {},
    }),
  );

  await openConnectionsRoute(view);
  view.stdin.write("\r");
  await tick();
  assert.doesNotMatch(view.lastFrame(), /Retry connection/);
  assert.match(view.lastFrame(), /Dismiss failed connection/);
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
      failure: storedConnectionFailure(
        "authentication",
        "ssh-public-key-rejected",
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
  assert.match(view.lastFrame(), /40136\s+→ Server:8188\s+failed/);

  await chooseVisibleAction(view, "Retry connection");
  await tick();
  await tick();
  assert.equal(retryCalls, 1);
  assert.match(view.lastFrame(), /40137\s+→ Server:8188\s+live/);
  assert.doesNotMatch(view.lastFrame(), /40136\s+→ Server:8188\s+failed/);
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
      failure: storedConnectionFailure(
        "provider-unavailable",
        "remote-service-unavailable",
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
    failure: storedConnectionFailure(
      "authentication",
      "ssh-public-key-rejected",
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
  assert.doesNotMatch(frame, /Connections\n|40135\s+→ Server:8188/);
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
      failure: storedConnectionFailure(
        "authentication",
        "ssh-public-key-rejected",
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
      failure: storedConnectionFailure(
        "authentication",
        "ssh-public-key-rejected",
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
    normalizedConnectionError(
      "authentication",
      "wording intentionally changed",
      "ssh-host-identity-mismatch",
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
    normalizedConnectionError(
      "authentication",
      "wording intentionally changed",
      "ssh-host-identity-changed-before-confirmation",
    ),
  );
  assert.match(staleFirstUse.lastFrame(), /fingerprint for Server changed since you reviewed it/i);
  assert.match(staleFirstUse.lastFrame(), /Nothing was trusted/i);
  assert.doesNotMatch(staleFirstUse.lastFrame(), /remove the stale EasyServer host key/i);
  cleanup();

  const rejectedLogin = await renderFailure(
    normalizedConnectionError(
      "authentication",
      "wording intentionally changed",
      "ssh-authentication-rejected",
    ),
  );
  assert.match(rejectedLogin.lastFrame(), /Connection authentication for Server was rejected/);
  assert.match(rejectedLogin.lastFrame(), /Check the login or key expected/);
  assert.match(rejectedLogin.lastFrame(), /server and retry/);
  assert.doesNotMatch(rejectedLogin.lastFrame(), /Credentials need attention|Open Providers/i);
  cleanup();

  const keyscan = await renderFailure(
    normalizedConnectionError(
      "provider-unavailable",
      "wording intentionally changed",
      "ssh-fingerprint-unavailable",
    ),
  );
  assert.match(keyscan.lastFrame(), /could not obtain an SSH host fingerprint/i);
  assert.match(keyscan.lastFrame(), /cannot safely ask you/i);
  assert.match(keyscan.lastFrame(), /trust a key yet/i);
  assert.match(keyscan.lastFrame(), /OpenSSH Client|SSH tools/i);
  assert.doesNotMatch(keyscan.lastFrame(), /Open Providers|credentials/i);
  cleanup();

  const servicePort = await renderFailure(
    normalizedConnectionError(
      "provider-unavailable",
      "wording intentionally changed",
      "remote-service-unavailable",
    ),
  );
  assert.match(servicePort.lastFrame(), /SSH to Server works/);
  assert.match(servicePort.lastFrame(), /requested app\/service port could not be reached/);
  assert.match(servicePort.lastFrame(), /Start or wait/);
  assert.match(servicePort.lastFrame(), /for that service/);
  assert.match(servicePort.lastFrame(), /edit the service port/);
  assert.doesNotMatch(servicePort.lastFrame(), /Open Providers|credentials|SSH for Server is not ready/i);
  cleanup();

  const forwardingPolicy = await renderFailure(
    normalizedConnectionError(
      "unsupported-operation",
      "wording intentionally changed",
      "tcp-forwarding-forbidden",
    ),
  );
  assert.match(forwardingPolicy.lastFrame(), /SSH (?:to Server )?works/i);
  assert.match(forwardingPolicy.lastFrame(), /does not allow TCP forwarding/i);
  assert.doesNotMatch(forwardingPolicy.lastFrame(), /No supported connection method/i);
  cleanup();

  const targetTimeout = await renderFailure(
    normalizedConnectionError(
      "provider-unavailable",
      "wording intentionally changed",
      "remote-service-unavailable",
    ),
  );
  assert.match(targetTimeout.lastFrame(), /SSH to Server works/i);
  assert.match(targetTimeout.lastFrame(), /app\/service port could not be reached/i);
  assert.doesNotMatch(targetTimeout.lastFrame(), /SSH for Server is not ready/i);
  cleanup();

  const unknownSsh = await renderFailure(
    normalizedConnectionError(
      "plugin-failure",
      "wording intentionally changed",
      "unexpected-ssh-transport",
    ),
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
      throw normalizedConnectionError(
        "conflict",
        "wording intentionally changed",
        "local-bind-conflict",
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
  assert.match(view.lastFrame(), /requested local port on this computer is already in use/i);
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
  assert.match(view.lastFrame(), /127\.0\.0\.1:40222\s+→ Server:22\s+live/);
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
  assert.match(view.lastFrame(), /127\.0\.0\.1:41001\s+→ Server:8188\s+live/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:41002\s+→ Server:7860\s+live/);

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
  assert.match(view.lastFrame(), /127\.0\.0\.1:41001\s+→ Server:8188\s+closing/);
  assert.match(view.lastFrame(), /127\.0\.0\.1:41002\s+→ Server:7860\s+closing/);

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
  await chooseVisibleAction(view, "Show technical details");
  await chooseVisibleAction(view, "Advanced: new background connection");
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
  assert.match(view.lastFrame(), /> 127\.0\.0\.1:48188\s+→ Server:8188 · bg\s+live\/bg/);
  assert.match(view.lastFrame(), /Local port unavailable\s+→ Server:7860 · bg\s+failed\/bg/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Local port unavailable\s+→ Server:7860 · bg\s+failed\/bg/);
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
