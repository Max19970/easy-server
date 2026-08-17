import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { TuiApp, TuiShell } from "../dist/tui.js";
import {
  openSettingsRoute,
  readSnapshot,
  tick,
} from "./tui-test-helpers.mjs";

test.afterEach(() => cleanup());

async function openAppearance(view) {
  await openSettingsRoute(view);
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
}

function memoryAppearanceStore(initial = { accent: "cyan", density: "comfortable" }) {
  let current = initial;
  const writes = [];
  let resets = 0;
  return {
    async read() {
      return current;
    },
    async write(preferences) {
      current = preferences;
      writes.push(preferences);
    },
    async reset() {
      current = { accent: "cyan", density: "comfortable" };
      resets += 1;
    },
    current: () => current,
    writes: () => writes,
    resets: () => resets,
  };
}

test("Settings exposes Appearance and applies accent, density and reset through arrows and Enter", async () => {
  const store = memoryAppearanceStore();
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => readSnapshot(),
      appearanceStore: store,
    }),
  );
  await tick();
  await tick();
  await openAppearance(view);

  assert.match(view.lastFrame(), /Home › Settings & Support › Appearance/);
  assert.match(view.lastFrame(), /> \[x\] Cyan \(default\)/);
  assert.match(view.lastFrame(), /\[x\] Comfortable \(default\)/);
  const comfortableLines = view.lastFrame().split("\n").length;

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(store.current(), { accent: "blue", density: "comfortable" });
  assert.deepEqual(store.writes().at(-1), { accent: "blue", density: "comfortable" });
  assert.match(view.lastFrame(), /\[x\] Blue/);

  for (let index = 0; index < 4; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(store.current(), { accent: "blue", density: "compact" });
  assert.match(view.lastFrame(), /> \[x\] Compact/);
  assert.ok(view.lastFrame().split("\n").length < comfortableLines);

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.equal(store.resets(), 1);
  assert.deepEqual(store.current(), { accent: "cyan", density: "comfortable" });
  assert.match(view.lastFrame(), /\[x\] Cyan \(default\)/);
  assert.match(view.lastFrame(), /\[x\] Comfortable \(default\)/);
});

test("persisted appearance is loaded on a clean TuiApp mount", async () => {
  const store = memoryAppearanceStore({ accent: "magenta", density: "compact" });
  const view = render(
    React.createElement(TuiApp, {
      colorEnabled: false,
      screenReader: false,
      readLoader: async () => readSnapshot(),
      appearanceStore: store,
    }),
  );
  await tick();
  await tick();
  await openAppearance(view);
  assert.match(view.lastFrame(), /\[x\] Magenta/);
  assert.match(view.lastFrame(), /\[x\] Compact/);
});

test("both density modes keep server focus and actions reachable at release terminal sizes", async (t) => {
  const snapshot = readSnapshot({
    instances: {
      status: "ready",
      complete: true,
      providerOutcomes: [{ providerId: "fixture", status: "fresh" }],
      items: [{
        id: "instance:appearance",
        name: "Appearance server",
        providerId: "fixture",
        providerExternalId: "remote-appearance",
        management: "managed",
        freshness: "fresh",
        state: "running",
        availableActions: ["instance.stop"],
      }],
    },
  });
  for (const density of ["comfortable", "compact"]) {
    for (const [width, height] of [[60, 20], [80, 24], [120, 40]]) {
      await t.test(`${density} ${width}x${height}`, async () => {
        const view = render(
          React.createElement(TuiShell, {
            width,
            height,
            colorEnabled: false,
            appearancePreferences: { accent: "blue", density },
            readSnapshot: snapshot,
            readStatus: "ready",
            onInstanceMutation() {},
          }),
        );
        for (let index = 0; index < 1; index += 1) {
          view.stdin.write("\u001b[B");
          await tick();
        }
        view.stdin.write("\r");
        await tick();
        let frame = view.lastFrame();
        assert.match(frame, /Appearance server\s+running/);
        assert.ok(frame.split("\n").length <= height, frame);
        view.stdin.write("\r");
        await tick();
        frame = view.lastFrame();
        assert.match(frame, /Stop server/);
        assert.ok(frame.split("\n").length <= height, frame);
        cleanup();
      });
    }
  }
});

test("screen-reader semantics are stable across appearance preferences", async () => {
  const renderHome = (preferences) => {
    const view = render(
      React.createElement(TuiShell, {
        colorEnabled: false,
        screenReader: true,
        appearancePreferences: preferences,
        readSnapshot: readSnapshot(),
        readStatus: "ready",
      }),
    );
    return view.lastFrame().replace(/\n+/gu, "\n").trim();
  };
  const comfortable = renderHome({ accent: "cyan", density: "comfortable" });
  cleanup();
  const compact = renderHome({ accent: "magenta", density: "compact" });
  assert.equal(compact, comfortable);
});
