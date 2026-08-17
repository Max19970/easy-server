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

  await chooseVisibleAction(view, "Add to bulk selection");
  view.stdin.write("\u001b[B");
  await tick();
  await chooseVisibleAction(view, "Add to bulk selection");
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
