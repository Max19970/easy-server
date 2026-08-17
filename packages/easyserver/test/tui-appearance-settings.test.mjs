import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_TUI_APPEARANCE,
  JsonTuiAppearanceStore,
  resolveTuiAppearancePath,
} from "../dist/tui-appearance-settings.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-appearance-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("appearance preferences persist across store instances and reset to defaults", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "appearance.json");
    const first = new JsonTuiAppearanceStore(path);
    await first.write({ accent: "magenta", density: "compact" });
    const second = new JsonTuiAppearanceStore(path);
    assert.deepEqual(await second.read(), { accent: "magenta", density: "compact" });
    await second.reset();
    assert.deepEqual(await new JsonTuiAppearanceStore(path).read(), DEFAULT_TUI_APPEARANCE);
  });
});

test("corrupt or invalid appearance settings fail safely to defaults", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "appearance.json");
    await writeFile(path, "{ definitely not json", "utf8");
    assert.deepEqual(await new JsonTuiAppearanceStore(path).read(), DEFAULT_TUI_APPEARANCE);
    await writeFile(path, JSON.stringify({ version: 1, accent: "red", density: "tiny" }), "utf8");
    assert.deepEqual(await new JsonTuiAppearanceStore(path).read(), DEFAULT_TUI_APPEARANCE);
  });
});

test("appearance path follows explicit override and isolated state-file runs", () => {
  assert.equal(
    resolveTuiAppearancePath({ EASYSERVER_APPEARANCE_FILE: "X:/custom.json" }, "X:/home"),
    "X:/custom.json",
  );
  assert.equal(
    resolveTuiAppearancePath({ EASYSERVER_STATE_FILE: "X:/state.json" }, "X:/home"),
    "X:/state.json.appearance.json",
  );
  assert.equal(resolveTuiAppearancePath({}, "X:/home"), join("X:/home", ".easyserver", "appearance.json"));
});
