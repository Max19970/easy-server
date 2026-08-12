import assert from "node:assert/strict";
import test from "node:test";
import {
  hostTrustRequiredError,
  normalizedError,
} from "@easyai101/easyserver-plugin-sdk";
import { TuiForegroundConnectionOperations } from "../dist/tui-foreground-connections.js";

const INSTANCE_ID = "instance:550e8400-e29b-41d4-a716-446655440000";
const METHOD = { id: "ssh", kind: "ssh", mode: "tcp-forward" };

function deferredSession() {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let closeCalls = 0;
  return {
    session: {
      closed,
      async close() {
        closeCalls += 1;
        resolveClosed();
      },
    },
    closeCalls: () => closeCalls,
  };
}

test("TUI foreground connection operations keep transport ownership outside React", async () => {
  const opened = [];
  const session = deferredSession();
  const operations = new TuiForegroundConnectionOperations({
    async listAccessMethods(instanceId) {
      assert.equal(instanceId, INSTANCE_ID);
      return [METHOD];
    },
    async openEndpoint(request) {
      opened.push(request);
      return {
        endpoint: { host: "127.0.0.1", port: 40123 },
        accessMethod: METHOD,
        session: session.session,
      };
    },
    async enrollHostKey() {
      assert.fail("host trust enrollment is not expected");
    },
  });

  assert.deepEqual(
    await operations.listAccessMethods(INSTANCE_ID, {
      signal: new AbortController().signal,
    }),
    [METHOD],
  );
  const connection = await operations.open(
    {
      instanceId: INSTANCE_ID,
      remotePort: 8188,
      localPort: 48188,
      accessMethodId: "ssh",
    },
    { signal: new AbortController().signal },
  );

  assert.deepEqual(opened, [
    {
      instanceId: INSTANCE_ID,
      remotePort: 8188,
      localPort: 48188,
      accessMethodId: "ssh",
    },
  ]);
  assert.equal(connection.remoteHost, "127.0.0.1");
  assert.deepEqual(connection.endpoint, { host: "127.0.0.1", port: 40123 });
  assert.equal(connection.requestedLocalPort, 48188);
  assert.equal(connection.state, "live");
  assert.equal(operations.list().length, 1);

  const closing = operations.close(connection.id);
  assert.equal(operations.list()[0]?.state, "closing");
  await closing;
  assert.equal(session.closeCalls(), 1);
  assert.deepEqual(operations.list(), []);
});

test("TUI foreground connection operations reuse first-use SSH trust enrollment exactly once", async () => {
  const trust = hostTrustRequiredError(
    "ssh.example.test",
    2222,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  const session = deferredSession();
  let opens = 0;
  let confirmed;
  let enrolled;
  const operations = new TuiForegroundConnectionOperations({
    async listAccessMethods() {
      return [METHOD];
    },
    async openEndpoint() {
      opens += 1;
      if (opens === 1) {
        throw trust;
      }
      return {
        endpoint: { host: "127.0.0.1", port: 40000 },
        accessMethod: METHOD,
        session: session.session,
      };
    },
    async enrollHostKey(value) {
      enrolled = value;
    },
  });

  const connection = await operations.open(
    {
      instanceId: INSTANCE_ID,
      remoteHost: "127.0.0.1",
      remotePort: 8188,
      accessMethodId: "ssh",
    },
    { signal: new AbortController().signal },
    {
      async confirmHostTrust(value) {
        confirmed = value;
        return true;
      },
    },
  );

  assert.equal(confirmed, trust);
  assert.equal(enrolled, trust);
  assert.equal(opens, 2);
  await operations.close(connection.id);
});

test("changed SSH host keys remain hard failures and never enter first-use trust confirmation", async () => {
  let confirmations = 0;
  let enrollments = 0;
  const changedKey = normalizedError("authentication", "SSH host key changed");
  const operations = new TuiForegroundConnectionOperations({
    async listAccessMethods() {
      return [METHOD];
    },
    async openEndpoint() {
      throw changedKey;
    },
    async enrollHostKey() {
      enrollments += 1;
    },
  });

  await assert.rejects(
    operations.open(
      {
        instanceId: INSTANCE_ID,
        remotePort: 8188,
        accessMethodId: "ssh",
      },
      { signal: new AbortController().signal },
      {
        async confirmHostTrust() {
          confirmations += 1;
          return true;
        },
      },
    ),
    (error) => error === changedKey,
  );
  assert.equal(confirmations, 0);
  assert.equal(enrollments, 0);
  assert.deepEqual(operations.list(), []);
});
