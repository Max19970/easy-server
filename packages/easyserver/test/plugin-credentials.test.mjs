import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  removePluginCredential,
  setPluginCredential,
} from "../dist/plugin-credentials.js";
import { InMemorySecretStore } from "../dist/secret-store.js";
import { JsonStateStore } from "../dist/state-store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-credentials-"));
  const store = new JsonStateStore(join(directory, "state.json"));
  await store.write({
    version: 1,
    plugins: [{ source: "@easyai101/easyserver-plugin-vastai", enabled: true }],
  });
  return { store, secrets: new InMemorySecretStore() };
}

test("binds a plugin credential through an opaque secret reference only", async () => {
  const { store, secrets } = await fixture();

  const result = await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
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

test("declared credential names reject typos before creating a secret", async () => {
  const { store } = await fixture();
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

  await assert.rejects(
    setPluginCredential(
      store,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "api-kye",
      "top-secret-api-key",
      [
        {
          name: "api-key",
          required: true,
          description: "Vast.ai API key",
        },
      ],
    ),
    /does not declare credential api-kye.*Allowed credentials: api-key/,
  );
  assert.equal(createCalls, 0);
  assert.equal((await store.read()).plugins[0].credentials, undefined);
});

test("legacy plugins without credential metadata keep arbitrary credential names", async () => {
  const { store, secrets } = await fixture();

  await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "legacy-custom-name",
    "legacy-secret",
  );

  assert.equal(
    (await store.read()).plugins[0].credentials[0].name,
    "legacy-custom-name",
  );
});

test("declared credential validation also protects remove from unknown names", async () => {
  const { store, secrets } = await fixture();
  await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "legacy-custom-name",
    "legacy-secret",
  );

  await assert.rejects(
    removePluginCredential(
      store,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "legacy-custom-name",
      [{ name: "api-key", required: true }],
    ),
    /does not declare credential legacy-custom-name/,
  );
  assert.equal(
    (await store.read()).plugins[0].credentials[0].name,
    "legacy-custom-name",
  );
});

test("concurrent credential updates preserve every binding and secret", async () => {
  const { store, secrets } = await fixture();
  const secondStore = new JsonStateStore(store.path);

  await Promise.all([
    setPluginCredential(
      store,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "api-key",
      "first-secret",
    ),
    setPluginCredential(
      secondStore,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
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

test("a hung Secret Store create does not hold the Local State lock", async () => {
  const { store } = await fixture();
  const backing = new InMemorySecretStore();
  let createStartedResolve;
  const createStarted = new Promise((resolve) => {
    createStartedResolve = resolve;
  });
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const secrets = {
    async create(secret) {
      createStartedResolve();
      await createGate;
      return backing.create(secret);
    },
    get: (ref) => backing.get(ref),
    delete: (ref) => backing.delete(ref),
  };

  const credentialUpdate = setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "slow-secret",
  );
  await createStarted;

  await assert.rejects(
    access(`${store.path}.lock`),
    (error) => error?.code === "ENOENT",
    "Secret Store create must not hold the Local State lock",
  );
  await new JsonStateStore(store.path).update((state) => ({
    ...state,
    instances: [
      ...(state.instances ?? []),
      {
        id: "instance:f3e4bc3a-b59c-43db-b218-6bc77bb06acd",
        providerId: "fixture",
        providerExternalId: "remote-independent",
      },
    ],
  }));

  releaseCreate();
  await credentialUpdate;
  assert.equal((await store.read()).instances?.length, 1);
});

test("concurrent state change between preparation and commit cleans an unused secret", async () => {
  const { store } = await fixture();
  const backing = new InMemorySecretStore();
  let createStartedResolve;
  const createStarted = new Promise((resolve) => {
    createStartedResolve = resolve;
  });
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let createdRef;
  const secrets = {
    async create(secret) {
      createStartedResolve();
      await createGate;
      createdRef = await backing.create(secret);
      return createdRef;
    },
    get: (ref) => backing.get(ref),
    delete: (ref) => backing.delete(ref),
  };

  const pending = setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "prepared-secret",
  );
  await createStarted;
  await new JsonStateStore(store.path).update((state) => ({
    ...state,
    plugins: state.plugins.filter(
      (plugin) => plugin.source !== "@easyai101/easyserver-plugin-vastai",
    ),
  }));
  releaseCreate();

  await assert.rejects(pending, /Plugin source is not configured/);
  assert.ok(createdRef);
  assert.equal(await secrets.get(createdRef), undefined);
  assert.deepEqual((await store.read()).plugins, []);
});

test("pre-commit failure cleans the prepared secret and preserves the old binding", async () => {
  const { store } = await fixture();
  const backing = new InMemorySecretStore();
  let createdRef;
  const secrets = {
    async create(secret) {
      createdRef = await backing.create(secret);
      return createdRef;
    },
    get: (ref) => backing.get(ref),
    delete: (ref) => backing.delete(ref),
  };
  await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "first-key",
  );
  const oldRef = (await store.read()).plugins[0].credentials[0].secretRef;

  const failing = new JsonStateStore(store.path, async () => {
    throw new Error("fixture pre-commit failure");
  });
  await assert.rejects(
    setPluginCredential(
      failing,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "api-key",
      "second-key",
    ),
    /fixture pre-commit failure/,
  );

  assert.equal((await store.read()).plugins[0].credentials[0].secretRef, oldRef);
  assert.notEqual(createdRef, oldRef);
  assert.equal(await secrets.get(createdRef), undefined);
  assert.equal(await secrets.get(oldRef), "first-key");
});

test("post-commit failure preserves the newly referenced secret", async () => {
  const { store, secrets } = await fixture();
  await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "first-key",
  );
  const oldRef = (await store.read()).plugins[0].credentials[0].secretRef;
  const failing = new JsonStateStore(store.path, async (from, to) => {
    await rename(from, to);
    throw new Error("fixture post-commit failure");
  });

  await assert.rejects(
    setPluginCredential(
      failing,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "api-key",
      "second-key",
    ),
    /fixture post-commit failure/,
  );

  const freshState = await new JsonStateStore(store.path).read();
  const committedRef = freshState.plugins[0].credentials[0].secretRef;
  assert.notEqual(committedRef, oldRef);
  assert.equal(await secrets.get(committedRef), "second-key");
  assert.equal(await secrets.get(oldRef), "first-key");
});

test("old-secret cleanup failure cannot invalidate a committed replacement", async () => {
  const { store, secrets: backing } = await fixture();
  await setPluginCredential(
    store,
    backing,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "first-key",
  );
  const oldRef = (await store.read()).plugins[0].credentials[0].secretRef;
  const secrets = {
    create: (secret) => backing.create(secret),
    get: (ref) => backing.get(ref),
    async delete(ref) {
      if (ref === oldRef) {
        throw new Error("fixture cleanup failure");
      }
      return backing.delete(ref);
    },
  };

  const result = await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "second-key",
  );
  assert.equal(result.previousSecretRemoved, false);

  const committedRef = (await new JsonStateStore(store.path).read()).plugins[0]
    .credentials[0].secretRef;
  assert.notEqual(committedRef, oldRef);
  assert.equal(await secrets.get(committedRef), "second-key");
  assert.equal(await secrets.get(oldRef), "first-key");
});

test("concurrent replacement cleanup never deletes the winning committed secret", async () => {
  const { store, secrets } = await fixture();
  const secondStore = new JsonStateStore(store.path);

  await Promise.all([
    setPluginCredential(
      store,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "api-key",
      "first-contender",
    ),
    setPluginCredential(
      secondStore,
      secrets,
      "@easyai101/easyserver-plugin-vastai",
      "api-key",
      "second-contender",
    ),
  ]);

  const winner = (await store.read()).plugins[0].credentials[0].secretRef;
  assert.ok(
    ["first-contender", "second-contender"].includes(await secrets.get(winner)),
  );
});

test("replacing and removing a plugin credential cleans old secret references", async () => {
  const { store, secrets } = await fixture();
  await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "first-key",
  );
  const firstRef = (await store.read()).plugins[0].credentials[0].secretRef;

  const replacement = await setPluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "second-key",
  );
  assert.equal(replacement.previousSecretRemoved, true);
  assert.equal(await secrets.get(firstRef), undefined);

  const secondRef = (await store.read()).plugins[0].credentials[0].secretRef;
  const removal = await removePluginCredential(
    store,
    secrets,
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
  );
  assert.equal(removal.previousSecretRemoved, true);
  assert.equal(await secrets.get(secondRef), undefined);
  assert.equal((await store.read()).plugins[0].credentials, undefined);
});
