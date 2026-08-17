import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
import { render as renderInk } from "ink";
import { TuiShell } from "../dist/tui.js";

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const flushEscape = () => new Promise((resolve) => setTimeout(resolve, 30));

export async function typeText(view, text) {
  for (const character of text) {
    view.stdin.write(character);
    await tick();
  }
}

export async function chooseVisibleAction(view, label, { open = true } = {}) {
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

export function shell(props = {}) {
  return React.createElement(TuiShell, { colorEnabled: false, ...props });
}

export function readSnapshot(overrides = {}) {
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

export function foregroundConnectionSnapshot() {
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

export function persistentConnectionSnapshot(items = []) {
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

export async function returnHome(view) {
  for (let index = 0; index < 3; index += 1) {
    view.stdin.write("\u001b");
    await flushEscape();
  }
}

export async function moveHomeCursor(view, count) {
  for (let index = 0; index < count; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
}

export async function openHomeDestination(view, index) {
  await returnHome(view);
  await moveHomeCursor(view, index);
  view.stdin.write("\r");
  await tick();
}

export async function openRentRoute(view) {
  await openHomeDestination(view, 0);
}

export async function openServersRoute(view) {
  await openHomeDestination(view, 1);
}

export async function openConnectionsRoute(view) {
  await openHomeDestination(view, 2);
}

export async function openSettingsRoute(view) {
  await openHomeDestination(view, 3);
}

export async function openProvidersRoute(view) {
  await openSettingsRoute(view);
  view.stdin.write("\r");
  await tick();
}

export async function openDiagnosticsRoute(view) {
  await openSettingsRoute(view);
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
}

export class CaptureOutput extends EventEmitter {
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

export class TtyInput extends EventEmitter {
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

export function renderAtTerminal(tree, columns, rows) {
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
