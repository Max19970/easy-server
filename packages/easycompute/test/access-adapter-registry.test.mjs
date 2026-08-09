import assert from "node:assert/strict";
import test from "node:test";
import { AccessAdapterRegistry } from "../dist/access-adapter-registry.js";

function adapter(kind) {
  return {
    kind,
    async openTcpForward() {
      throw new Error("not used in registry tests");
    },
  };
}

function admission(accessAdapters = []) {
  return {
    pluginId: "fake.plugin",
    provider: {
      providerId: "fake",
      async listInstances() {
        return [];
      },
      async getInstance() {
        return undefined;
      },
    },
    capabilities: [],
    accessAdapters,
    release() {},
  };
}

test("resolves a provider-specific TCP adapter without provider branches", () => {
  const registry = new AccessAdapterRegistry();
  const pluginAdapter = adapter("fake:proxy");
  const method = {
    id: "proxy",
    kind: "fake:proxy",
    mode: "tcp-forward",
  };

  assert.equal(
    registry.resolveTcpForward(method, admission([pluginAdapter])),
    pluginAdapter,
  );
});

test("registers OpenSSH as a production built-in", () => {
  const registry = new AccessAdapterRegistry();
  const resolved = registry.resolveTcpForward(
    {
      id: "direct-ssh",
      kind: "ssh",
      mode: "tcp-forward",
      ssh: { host: "ssh.example.test", port: 22, username: "ubuntu" },
    },
    admission(),
  );

  assert.equal(resolved?.kind, "ssh");
});

test("resolves built-in adapters and rejects interactive-only access", () => {
  const registry = new AccessAdapterRegistry();
  const builtIn = adapter("loopback");
  registry.registerBuiltIn(builtIn);

  assert.equal(
    registry.resolveTcpForward(
      { id: "tcp", kind: "loopback", mode: "tcp-forward" },
      admission(),
    ),
    builtIn,
  );
  assert.equal(
    registry.resolveTcpForward(
      { id: "shell", kind: "loopback", mode: "interactive" },
      admission(),
    ),
    undefined,
  );
});
