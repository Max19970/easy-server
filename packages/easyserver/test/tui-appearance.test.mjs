import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  tuiAppearance,
  tuiFocusColor,
  tuiResourceColor,
  tuiResourceTone,
  tuiToneColor,
} from "../dist/tui-appearance.js";

const root = resolve(import.meta.dirname, "..");

test("semantic TUI appearance maps focus and state through one restrained palette", () => {
  const appearance = tuiAppearance(true);
  assert.equal(appearance.accent, "cyan");
  assert.equal(appearance.muted, "gray");
  assert.equal(tuiFocusColor(appearance, true), appearance.accent);
  assert.equal(tuiFocusColor(appearance, false), undefined);
  assert.equal(tuiToneColor(appearance, "success"), "green");
  assert.equal(tuiToneColor(appearance, "warning"), "yellow");
  assert.equal(tuiToneColor(appearance, "danger"), "red");
  assert.equal(tuiResourceTone("running"), "success");
  assert.equal(tuiResourceTone("stale"), "warning");
  assert.equal(tuiResourceTone("failed"), "danger");
  assert.equal(tuiResourceTone("disabled"), "info");
  assert.equal(tuiResourceColor(appearance, "running"), "green");
});

test("NO_COLOR appearance removes every semantic foreground while preserving roles", () => {
  const appearance = tuiAppearance(false);
  for (const role of [
    "accent",
    "muted",
    "info",
    "success",
    "warning",
    "danger",
    "border",
  ]) {
    assert.equal(appearance[role], undefined, role);
  }
  assert.equal(tuiFocusColor(appearance, true), undefined);
  assert.equal(tuiResourceTone("failed"), "danger");
  assert.equal(tuiResourceColor(appearance, "failed"), undefined);
});

test("core and provider TUI surfaces consume the shared visual contract", async () => {
  const files = [
    "src/tui.tsx",
    "src/tui-operation-drawer.tsx",
    "src/tui-provider-interactive.tsx",
    "src/tui-servers-surface.tsx",
    "src/tui-connections-surface.tsx",
    "src/tui-providers-surface.tsx",
    "src/tui-diagnostics-surface.tsx",
  ];
  const contents = await Promise.all(
    files.map((file) => readFile(resolve(root, file), "utf8")),
  );
  for (const [index, source] of contents.entries()) {
    assert.equal(
      /colorEnabled\s*\?\s*["'](?:cyan|gray|green|yellow|red|blue)["']/u.test(source),
      false,
      `${files[index]} must not define its own semantic palette`,
    );
  }
  assert.equal(contents[0].includes("colorEnabled={false}"), false);
  assert.equal(contents[0].includes("colorEnabled={colorEnabled}"), true);
  assert.match(contents[2], /validation\?\.state === "invalid" \? appearance\.danger/u);
});
