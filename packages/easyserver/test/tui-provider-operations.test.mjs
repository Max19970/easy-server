import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemorySecretStore } from "../dist/secret-store.js";
import { JsonStateStore } from "../dist/state-store.js";
import { createDefaultTuiProviderMutationRunner } from "../dist/tui-provider-operations.js";

const validPlugin = fileURLToPath(
  new URL("./fixtures/valid-plugin.mjs", import.meta.url),
);

test("default TUI provider mutation runner registers installed plugins through PluginOperations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-tui-provider-"));
  const stateFile = join(directory, "state.json");
  const store = new JsonStateStore(stateFile);
  const runner = createDefaultTuiProviderMutationRunner(
    { stateFile, daemonFile: join(directory, "daemon.json") },
    {
      stateStore: store,
      secretStore: new InMemorySecretStore(),
    },
  );

  try {
    await runner({ kind: "add-plugin", source: validPlugin });

    const state = await store.read();
    assert.deepEqual(state.plugins, [
      {
        source: validPlugin,
        enabled: true,
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default TUI provider mutation runner enables and disables configured plugins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-tui-provider-toggle-"));
  const stateFile = join(directory, "state.json");
  const store = new JsonStateStore(stateFile);
  const runner = createDefaultTuiProviderMutationRunner(
    { stateFile, daemonFile: join(directory, "daemon.json") },
    {
      stateStore: store,
      secretStore: new InMemorySecretStore(),
    },
  );

  try {
    await runner({ kind: "add-plugin", source: validPlugin });
    await runner({ kind: "set-enabled", source: validPlugin, enabled: false });
    assert.equal((await store.read()).plugins[0]?.enabled, false);

    await runner({ kind: "set-enabled", source: validPlugin, enabled: true });
    assert.equal((await store.read()).plugins[0]?.enabled, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
