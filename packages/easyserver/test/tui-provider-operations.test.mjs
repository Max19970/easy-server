import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const credentialPlugin = fileURLToPath(
  new URL("./fixtures/credential-plugin.mjs", import.meta.url),
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

test("default TUI provider mutation runner configures and removes declared credentials through Secret Store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-tui-provider-secret-"));
  const stateFile = join(directory, "state.json");
  const store = new JsonStateStore(stateFile);
  const secrets = new InMemorySecretStore();
  const runner = createDefaultTuiProviderMutationRunner(
    { stateFile, daemonFile: join(directory, "daemon.json") },
    { stateStore: store, secretStore: secrets },
  );
  const secret = "top-secret-tui-marker";

  try {
    await runner({ kind: "add-plugin", source: credentialPlugin });
    await runner({
      kind: "set-credential",
      source: credentialPlugin,
      name: "api-key",
      secret,
    });

    const configured = await store.read();
    const binding = configured.plugins[0]?.credentials?.[0];
    assert.equal(binding?.name, "api-key");
    assert.match(binding?.secretRef ?? "", /^secret:/);
    assert.equal(await secrets.get(binding.secretRef), secret);
    assert.doesNotMatch(await readFile(stateFile, "utf8"), new RegExp(secret));

    await runner({
      kind: "remove-credential",
      source: credentialPlugin,
      name: "api-key",
    });
    assert.equal((await store.read()).plugins[0]?.credentials, undefined);
    assert.equal(await secrets.get(binding.secretRef), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default TUI provider mutation runner rejects undeclared credential names before secret creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-tui-provider-secret-name-"));
  const stateFile = join(directory, "state.json");
  const store = new JsonStateStore(stateFile);
  let createCalls = 0;
  const secrets = {
    async create() {
      createCalls += 1;
      throw new Error("secret creation must not be reached");
    },
    async get() {
      return undefined;
    },
    async delete() {
      return true;
    },
  };
  const runner = createDefaultTuiProviderMutationRunner(
    { stateFile, daemonFile: join(directory, "daemon.json") },
    { stateStore: store, secretStore: secrets },
  );

  try {
    await runner({ kind: "add-plugin", source: credentialPlugin });
    await assert.rejects(
      runner({
        kind: "set-credential",
        source: credentialPlugin,
        name: "api-kye",
        secret: "must-not-be-stored",
      }),
      /does not declare credential api-kye.*Allowed credentials: api-key, profile/,
    );
    assert.equal(createCalls, 0);
    assert.equal((await store.read()).plugins[0]?.credentials, undefined);
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
