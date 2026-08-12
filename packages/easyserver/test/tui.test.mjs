import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { renderTui, TuiShell } from "../dist/tui.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flushEscape = () => new Promise((resolve) => setTimeout(resolve, 30));

function shell(props = {}) {
  return React.createElement(TuiShell, { colorEnabled: false, ...props });
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
