import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OsKeyringSecretStore } from "../packages/easycompute/dist/secret-store.js";

const service = `EasyCompute platform smoke ${randomUUID()}`;
const secret = `easycompute-platform-smoke-${randomUUID()}`;
const store = new OsKeyringSecretStore(service);
let reference;

try {
  reference = await store.create(secret);
  assert.equal(
    await store.get(reference),
    secret,
    "OS keyring must return the exact secret that was stored",
  );
  assert.equal(
    await store.delete(reference),
    true,
    "OS keyring must delete the temporary credential",
  );
  reference = undefined;
  process.stdout.write(`OS keyring verification passed on ${process.platform}.\n`);
} finally {
  if (reference !== undefined) {
    await store.delete(reference).catch(() => false);
  }
}
