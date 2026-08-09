import test from "node:test";
import assert from "node:assert/strict";
import {
  createIntelionProviderPlugin,
  INTELION_API_TOKEN_CREDENTIAL,
} from "../dist/index.js";

function context() {
  return {
    signal: new AbortController().signal,
    async resolveCredential(name) {
      assert.equal(name, INTELION_API_TOKEN_CREDENTIAL);
      return "fixture-token";
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Intelion access discovery is secret-free and password retrieval is deferred", async () => {
  const calls = [];
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (url.pathname.endsWith("/password/")) {
        return json({ password: "fixture-server-password" });
      }
      return json({
        id: 42,
        name: "server",
        status: 2,
        ip_to_connect: "203.0.113.42",
        domain_to_connect: "server-42.intelion.test",
        login: "root",
      });
    },
  });

  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), [
    {
      id: "ssh",
      kind: "ssh",
      mode: "tcp-forward",
      credentialSources: [
        { kind: "provider-deferred", id: "ssh-password" },
      ],
      ssh: {
        host: "203.0.113.42",
        port: 22,
        username: "root",
        passwordCredentialId: "ssh-password",
      },
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/v2/cloud-servers/42/");

  assert.equal(
    await plugin.provider.resolveAccessCredential(
      "42",
      "ssh-password",
      context(),
    ),
    "fixture-server-password",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, "/api/v2/cloud-servers/42/password/");
});

test("Intelion exposes no SSH method before an active server has connection metadata", async () => {
  let body = {
    id: 42,
    name: "server",
    status: -2,
    ip_to_connect: "203.0.113.42",
    login: "root",
  };
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json(body);
    },
  });

  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), []);
  body = { id: 42, name: "server", status: 2, ip_to_connect: null, login: "root" };
  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), []);
});
