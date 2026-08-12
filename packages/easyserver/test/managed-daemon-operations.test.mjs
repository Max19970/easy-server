import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedDaemonOperations } from "../dist/managed-daemon-operations.js";

test("daemon inspection does not validate start-only timeout configuration", async () => {
  const operations = new ManagedDaemonOperations({
    daemonFile: join(tmpdir(), `easyserver-missing-${randomUUID()}.json`),
    env: { EASYSERVER_DAEMON_START_TIMEOUT_MS: "invalid" },
  });

  assert.deepEqual(await operations.inspect(), { status: "stopped" });
});
