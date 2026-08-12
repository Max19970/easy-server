import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { normalizedError } from "@easyai101/easyserver-plugin-sdk";
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> Enabled Provider/);

  view.stdin.write("e");
  await tick();
  assert.deepEqual(mutations, [
    { kind: "set-enabled", source: "@fixture/enabled", enabled: false },
  ]);

  view.stdin.write("j");
  await tick();
  assert.match(view.lastFrame(), /> Disabled Provider/);
  view.stdin.write("e");
  await tick();
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("c");
  await tick();

  assert.match(view.lastFrame(), /Credentials for Credential Provider/);
  assert.match(view.lastFrame(), /> api-key · required · missing/);
  assert.match(view.lastFrame(), /profile · optional · configured/);
  assert.doesNotMatch(view.lastFrame(), /Credential name:/);

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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("c");
  await tick();
  assert.match(view.lastFrame(), /> api-key · required · configured/);

  view.stdin.write("x");
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("c");
  await tick();
  view.stdin.write("x");
  await tick();

  assert.deepEqual(mutations, []);
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(view.lastFrame(), /Remove credential api-key/);
  assert.match(view.lastFrame(), /Target: @fixture\/credentials/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.deepEqual(mutations, []);
  assert.doesNotMatch(view.lastFrame(), /Confirmation required/);

  view.stdin.write("c");
  await tick();
  view.stdin.write("x");
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Credential metadata unavailable while disabled/);

  view.stdin.write("c");
  await tick();
  assert.match(view.lastFrame(), /Enable the selected provider before managing credentials/);
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("c");
  await tick();
  view.stdin.write("\r");
  await tick();
  await typeText(view, "q-cancelled-secret");
  assert.doesNotMatch(view.lastFrame(), /q-cancelled-secret/);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.deepEqual(mutations, []);
  assert.match(view.lastFrame(), /Credentials for Credential Provider/);
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("c");
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
  assert.match(view.lastFrame(), /loaded · ready/);
  assert.match(view.lastFrame(), /Credentials: 1\/1 configured/);
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("c");
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("j");
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /New instance/);
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

  view.stdin.write("\r");
  await tick();
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /Instances/);
  assert.match(view.lastFrame(), /EasyServer ID: instance:nebula-42/);
  assert.equal(closeCalls, 0);

  view.stdin.write("\u001b");
  await flushEscape();
  assert.match(view.lastFrame(), /> Overview \[active\]/);
  view.stdin.write("r");
  await tick();
  await tick();
  await tick();
  assert.match(view.lastFrame(), /> Overview \[active\]/);
  assert.doesNotMatch(view.lastFrame(), /EasyServer ID: instance:nebula-42/);
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
  assert.match(view.lastFrame(), /Remediation: verify the installed module and compatibility/);
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();

  assert.match(view.lastFrame(), /Management: discovered/);
  assert.match(view.lastFrame(), /Available actions: instance\.stop/);
  assert.doesNotMatch(view.lastFrame(), /Available actions:.*instance\.destroy/);
  assert.match(view.lastFrame(), /a Adopt for EasyServer management/);
  assert.match(view.lastFrame(), /Destroy is unavailable until this resource is explicitly adopted/);
  assert.match(view.lastFrame(), /Actions: 1 stop/);

  view.stdin.write("2");
  await tick();
  assert.deepEqual(mutations, []);

  view.stdin.write("1");
  await tick();
  view.stdin.write("a");
  await tick();
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

  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("j");
  await tick();
  assert.match(view.lastFrame(), /EasyServer ID: instance:b/);

  view.rerender(
    shell({
      width: 100,
      readSnapshot: second,
      readStatus: "ready",
      onInstanceMutation,
    }),
  );
  await tick();
  assert.match(view.lastFrame(), /Selected instance is no longer visible/);
  assert.match(view.lastFrame(), /instance:b disappeared from the refreshed inventory/);
  assert.match(view.lastFrame(), /No action target has\s+been changed/);

  view.stdin.write("1");
  await tick();
  assert.deepEqual(mutations, []);

  view.stdin.write("j");
  await tick();
  assert.match(view.lastFrame(), /EasyServer ID: instance:a/);
  view.stdin.write("1");
  await tick();
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("1");
  await tick();

  assert.equal(runnerCalls, 1);
  assert.match(view.lastFrame(), /Confirmation required/);
  assert.match(
    view.lastFrame(),
    /Target: instance:managed · provider=fixture · management=managed/,
  );
  assert.match(view.lastFrame(), /Session session:active/);
  assert.match(view.lastFrame(), /Endpoint intent comfy/);
  assert.match(view.lastFrame(), /will close 1 active session and 1 Endpoint intent/);

  view.stdin.write("\r");
  await tick();
  await tick();
  assert.match(view.lastFrame(), /observing/);
  assert.match(view.lastFrame(), /Observing instance:managed until provider state converges/);

  finishObservation();
  await tick();
  await tick();
  await tick();
  assert.equal(loaderCalls, 2);
  assert.match(view.lastFrame(), /Destroy instance completed/);
  assert.match(view.lastFrame(), /observed state=absent/);
  assert.match(view.lastFrame(), /No compute instances yet/);
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
  view.stdin.write("\t");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("1");
  await tick();

  assert.equal(runnerCalls, 1);
  assert.match(view.lastFrame(), /Start instance: outcome unknown/);
  assert.match(view.lastFrame(), /Observe state/);
  assert.match(view.lastFrame(), /Refresh/);
  assert.doesNotMatch(view.lastFrame(), /Retry/);

  view.stdin.write("o");
  await tick();
  await tick();
  assert.equal(loaderCalls, 2);
  assert.equal(runnerCalls, 1);
  assert.doesNotMatch(view.lastFrame(), /outcome unknown/);
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
