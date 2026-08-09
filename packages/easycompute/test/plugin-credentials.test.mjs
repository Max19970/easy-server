import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  removePluginCredential,
  setPluginCredential,
} from "../dist/plugin-credentials.js";
import { InMemorySecretStore } from "../dist/secret-store.js";
import { JsonStateStore } from "../dist/state-store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "easycompute-credentials-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({
    version: 1,
    plugins: [{ source: "@easycompute/plugin-vastai", enabled: true }],
  });
  return { store, secrets: new InMemorySecretStore() };
}

test("binds a plugin credential through an opaque secret reference only", async () => {
  const { store, secrets } = await fixture();

  const result = await setPluginCredential(
    store,
    secrets,
    "@easycompute/plugin-vastai",
    "api-key",
    "top-secret-api-key",
  );

  assert.equal(result.previousSecretRemoved, true);
  const state = await store.read();
  const binding = state.plugins[0].credentials[0];
  assert.equal(binding.name, "api-key");
  assert.equal(await secrets.get(binding.secretRef), "top-secret-api-key");
  assert.equal(
    (await readFile(store.path, "utf8")).includes("top-secret-api-key"),
    false,
  );
});

test("concurrent credential updates preserve every binding and secret", async () => {
  const { store, secrets } = await fixture();
  const secondStore = new JsonStateStore(store.path);

  await Promise.all([
    setPluginCredential(
      store,
      secrets,
      "@easycompute/plugin-vastai",
      "api-key",
      "first-secret",
    ),
    setPluginCredential(
      secondStore,
      secrets,
      "@easycompute/plugin-vastai",
      "secondary-key",
      "second-secret",
    ),
  ]);

  const credentials = (await store.read()).plugins[0].credentials;
  assert.equal(credentials.length, 2);
  const byName = new Map(credentials.map((credential) => [credential.name, credential]));
  assert.equal(await secrets.get(byName.get("api-key").secretRef), "first-secret");
  assert.equal(
    await secrets.get(byName.get("secondary-key").secretRef),
    "second-secret",
  );
});

test("replacing and removing a plugin credential cleans old secret references", async () => {
  const { store, secrets } = await fixture();
  await setPluginCredential(
    store,
    secrets,
    "@easycompute/plugin-vastai",
    "api-key",
    "first-key",
  );
  const firstRef = (await store.read()).plugins[0].credentials[0].secretRef;

  const replacement = await setPluginCredential(
    store,
    secrets,
    "@easycompute/plugin-vastai",
    "api-key",
    "second-key",
  );
  assert.equal(replacement.previousSecretRemoved, true);
  assert.equal(await secrets.get(firstRef), undefined);

  const secondRef = (await store.read()).plugins[0].credentials[0].secretRef;
  const removal = await removePluginCredential(
    store,
    secrets,
    "@easycompute/plugin-vastai",
    "api-key",
  );
  assert.equal(removal.previousSecretRemoved, true);
  assert.equal(await secrets.get(secondRef), undefined);
  assert.equal((await store.read()).plugins[0].credentials, undefined);
});
