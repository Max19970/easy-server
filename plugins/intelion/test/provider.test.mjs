import test from "node:test";
import assert from "node:assert/strict";
import { isNormalizedError } from "@easycompute/plugin-sdk";
import {
  createIntelionProviderPlugin,
  INTELION_API_TOKEN_CREDENTIAL,
} from "../dist/index.js";

function context(token = "fixture-token") {
  return {
    signal: new AbortController().signal,
    async resolveCredential(name) {
      assert.equal(name, INTELION_API_TOKEN_CREDENTIAL);
      return token;
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("lists all Intelion cloud-server pages with Token authentication", async () => {
  const calls = [];
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (calls.length === 1) {
        return json({
          count: 3,
          next: "https://fixture.intelion.test/api/v2/cloud-servers/?page=2",
          previous: null,
          results: [
            { id: 101, name: "training", status: 2 },
            { id: 102, name: "waiting", status: -2 },
          ],
        });
      }
      return json({
        count: 3,
        next: null,
        previous: "https://fixture.intelion.test/api/v2/cloud-servers/",
        results: [{ id: 103, name: "parked", status: -1 }],
      });
    },
  });

  assert.deepEqual(await plugin.provider.listInstances(context()), [
    {
      providerExternalId: "101",
      name: "training",
      state: "running",
      rawState: 2,
      availableActions: [],
    },
    {
      providerExternalId: "102",
      name: "waiting",
      state: "provisioning",
      rawState: -2,
      availableActions: [],
    },
    {
      providerExternalId: "103",
      name: "parked",
      state: "stopped",
      rawState: -1,
      availableActions: [],
    },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/v2/cloud-servers/");
  assert.equal(calls[1].url.searchParams.get("page"), "2");
  assert.equal(calls[0].init.headers.Authorization, "Token fixture-token");
});

test("gets one Intelion cloud server and preserves unknown status", async () => {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input) {
      assert.equal(new URL(input).pathname, "/api/v2/cloud-servers/777/");
      return json({ id: 777, name: "mystery", status: 999 });
    },
  });

  assert.deepEqual(await plugin.provider.getInstance("777", context()), {
    providerExternalId: "777",
    name: "mystery",
    state: "unknown",
    rawState: 999,
    availableActions: [],
  });
});

test("Intelion maps current documented lifecycle status codes", async () => {
  const cases = [
    [-4, "error"],
    [-3, "terminated"],
    [-2, "provisioning"],
    [-1, "stopped"],
    [0, "stopping"],
    [1, "starting"],
    [2, "running"],
    [3, "starting"],
  ];
  let status = -4;
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ id: 42, name: "server", status });
    },
  });

  for (const [rawState, state] of cases) {
    status = rawState;
    assert.equal((await plugin.provider.getInstance("42", context())).state, state);
  }
});

test("missing and rejected Intelion API tokens become authentication errors", async () => {
  let requests = 0;
  const missingPlugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      requests += 1;
      return json({ results: [], next: null });
    },
  });

  await assert.rejects(
    missingPlugin.provider.listInstances({
      signal: new AbortController().signal,
      async resolveCredential() {
        return undefined;
      },
    }),
    (error) => isNormalizedError(error) && error.code === "authentication",
  );
  assert.equal(requests, 0);

  const rejectedPlugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ detail: "Invalid token." }, 401);
    },
  });
  await assert.rejects(
    rejectedPlugin.provider.listInstances(context("rejected")),
    (error) => isNormalizedError(error) && error.code === "authentication",
  );
});

test("404 Intelion cloud-server lookup returns undefined", async () => {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ detail: "Not found." }, 404);
    },
  });

  assert.equal(await plugin.provider.getInstance("404", context()), undefined);
});
