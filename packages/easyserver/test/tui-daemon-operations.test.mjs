import assert from "node:assert/strict";
import test from "node:test";
import {
  hostTrustRequiredError,
  normalizedError,
} from "@easyai101/easyserver-plugin-sdk";
import {
  createTuiDaemonOperations,
  newTuiPersistentSessionIdempotencyKey,
} from "../dist/tui-daemon-operations.js";

const request = {
  instanceId: "instance:fixture",
  remoteHost: "127.0.0.1",
  remotePort: 8188,
  localPort: 48188,
  accessMethodId: "ssh",
  idempotencyKey: "tui:stable-retry-key",
};

function liveSession() {
  return {
    id: "session:fixture",
    state: "live",
    instanceId: request.instanceId,
    remoteHost: request.remoteHost,
    remotePort: request.remotePort,
    requestedLocalPort: request.localPort,
    requestedAccessMethodId: request.accessMethodId,
    idempotencyKey: request.idempotencyKey,
    accessMethod: { id: "ssh", kind: "ssh", mode: "tcp-forward" },
    endpoint: { host: "127.0.0.1", port: request.localPort },
  };
}

test("TUI persistent session retries first-use SSH trust with the exact same idempotency request", async () => {
  const trust = hostTrustRequiredError(
    "ssh.example.test",
    22,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  const seen = [];
  let enrolled;
  const managed = {
    async requireClient() {
      return {
        async createSession(value) {
          seen.push(value);
          if (seen.length === 1) {
            throw trust;
          }
          return liveSession();
        },
        async closeSession() {},
      };
    },
  };
  const operations = createTuiDaemonOperations(managed, {
    async enrollHostKey(value) {
      enrolled = value;
    },
  });

  const result = await operations.createSession(request, {
    async confirmHostTrust(value) {
      assert.equal(value, trust);
      return true;
    },
  });

  assert.equal(result.id, "session:fixture");
  assert.deepEqual(seen, [request, request]);
  assert.equal(enrolled, trust);
});

test("changed SSH host keys stay fail-closed and never enter first-use trust", async () => {
  let confirmations = 0;
  const changed = normalizedError("authentication", "SSH host key changed");
  const operations = createTuiDaemonOperations(
    {
      async requireClient() {
        return {
          async createSession() {
            throw changed;
          },
        };
      },
    },
    {
      async enrollHostKey() {
        assert.fail("changed key must never be enrolled");
      },
    },
  );

  await assert.rejects(
    operations.createSession(request, {
      async confirmHostTrust() {
        confirmations += 1;
        return true;
      },
    }),
    (error) => error === changed,
  );
  assert.equal(confirmations, 0);
});

test("TUI persistent session close delegates to the daemon client by stable Session ID", async () => {
  const closed = [];
  const operations = createTuiDaemonOperations(
    {
      async requireClient() {
        return {
          async closeSession(id) {
            closed.push(id);
          },
        };
      },
    },
    { async enrollHostKey() {} },
  );

  await operations.closeSession("session:cleanup-failed");
  assert.deepEqual(closed, ["session:cleanup-failed"]);
});

test("TUI Endpoint intent mutations delegate to the authenticated daemon client by stable intent name", async () => {
  const calls = [];
  const operations = createTuiDaemonOperations(
    {
      async requireClient() {
        return {
          async setEndpointIntentEnabled(name, enabled) {
            calls.push(["enabled", name, enabled]);
            return {
              name,
              enabled,
              state: enabled ? "starting" : "disabled",
              instanceId: "instance:fixture",
              remoteHost: "127.0.0.1",
              remotePort: 8188,
            };
          },
          async retryEndpointIntent(name) {
            calls.push(["retry", name]);
            return {
              name,
              enabled: true,
              state: "starting",
              instanceId: "instance:fixture",
              remoteHost: "127.0.0.1",
              remotePort: 8188,
            };
          },
          async removeEndpointIntent(name) {
            calls.push(["remove", name]);
          },
        };
      },
    },
    { async enrollHostKey() {} },
  );

  assert.equal((await operations.setEndpointIntentEnabled("comfy", false)).state, "disabled");
  assert.equal((await operations.setEndpointIntentEnabled("comfy", true)).state, "starting");
  assert.equal((await operations.retryEndpointIntent("comfy")).state, "starting");
  await operations.removeEndpointIntent("comfy");

  assert.deepEqual(calls, [
    ["enabled", "comfy", false],
    ["enabled", "comfy", true],
    ["retry", "comfy"],
    ["remove", "comfy"],
  ]);
});

test("TUI persistent session idempotency keys are non-empty and distinct", () => {
  const first = newTuiPersistentSessionIdempotencyKey();
  const second = newTuiPersistentSessionIdempotencyKey();
  assert.match(first, /^tui:/);
  assert.match(second, /^tui:/);
  assert.notEqual(first, second);
});
