import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemorySecretStore,
  OsKeyringSecretStore,
} from "../dist/secret-store.js";

test("in-memory secret store returns opaque references and never embeds the secret", async () => {
  const store = new InMemorySecretStore();
  const secret = "fixture-super-secret";
  const ref = await store.create(secret);

  assert.match(ref, /^secret:/);
  assert.equal(ref.includes(secret), false);
  assert.equal(await store.get(ref), secret);
  assert.equal(await store.delete(ref), true);
  assert.equal(await store.get(ref), undefined);
  assert.equal(await store.delete(ref), false);
});

test("secret stores reject empty values", async () => {
  const store = new InMemorySecretStore();
  await assert.rejects(store.create(""), /non-empty string/);
});

test("OS keyring adapter cleans a partially written credential when create fails", async () => {
  let stored = false;
  let deleted = false;
  const store = new OsKeyringSecretStore("EasyServer.Test", () => ({
    async setPassword() {
      stored = true;
      throw new Error("fixture keyring failure");
    },
    async getPassword() {
      return stored ? "fixture-secret" : null;
    },
    async deleteCredential() {
      deleted = stored;
      stored = false;
      return deleted;
    },
  }));

  await assert.rejects(store.create("fixture-secret"), /fixture keyring failure/);
  assert.equal(deleted, true);
  assert.equal(stored, false);
});

test("OS keyring adapter delegates only the opaque reference as the account", async () => {
  const entries = new Map();
  const calls = [];
  const entryFactory = (service, account) => ({
    async setPassword(secret) {
      calls.push({ operation: "set", service, account });
      entries.set(`${service}\0${account}`, secret);
    },
    async getPassword() {
      calls.push({ operation: "get", service, account });
      return entries.get(`${service}\0${account}`) ?? null;
    },
    async deleteCredential() {
      calls.push({ operation: "delete", service, account });
      return entries.delete(`${service}\0${account}`);
    },
  });
  const store = new OsKeyringSecretStore("EasyServer.Test", entryFactory);
  const secret = "fixture-keyring-secret";

  const ref = await store.create(secret);
  assert.equal(await store.get(ref), secret);
  assert.equal(await store.delete(ref), true);
  assert.equal(await store.get(ref), undefined);

  assert.equal(ref.includes(secret), false);
  assert.deepEqual(
    new Set(calls.map((call) => call.service)),
    new Set(["EasyServer.Test"]),
  );
  assert.deepEqual(
    new Set(calls.map((call) => call.account)),
    new Set([ref]),
  );
});
