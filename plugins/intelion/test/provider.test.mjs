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
      availableActions: [
        "instance.stop",
        "instance.restart",
        "instance.destroy",
      ],
    },
    {
      providerExternalId: "102",
      name: "waiting",
      state: "provisioning",
      rawState: -2,
      availableActions: ["instance.start", "instance.destroy"],
    },
    {
      providerExternalId: "103",
      name: "parked",
      state: "stopped",
      rawState: -1,
      availableActions: ["instance.start", "instance.destroy"],
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
    availableActions: ["instance.destroy"],
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

test("Intelion lifecycle actions follow provider status semantics", async () => {
  let status = -2;
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ id: 42, name: "server", status });
    },
  });

  assert.deepEqual(plugin.manifest.provider.capabilities, [
    "instance.start",
    "instance.stop",
    "instance.restart",
    "instance.destroy",
  ]);

  for (const [rawState, actions] of [
    [-2, ["instance.start", "instance.destroy"]],
    [-1, ["instance.start", "instance.destroy"]],
    [2, ["instance.stop", "instance.restart", "instance.destroy"]],
    [-3, []],
    [-4, ["instance.destroy"]],
    [0, ["instance.destroy"]],
    [1, ["instance.destroy"]],
    [3, ["instance.destroy"]],
    [999, ["instance.destroy"]],
  ]) {
    status = rawState;
    assert.deepEqual(
      (await plugin.provider.getInstance("42", context())).availableActions,
      actions,
    );
  }
});

test("Intelion lifecycle mutations use the documented actions endpoint", async () => {
  const calls = [];
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input, init) {
      calls.push({ url: new URL(input), init });
      return json({ id: 42, name: "server", status: 2 });
    },
  });

  await plugin.provider.performPowerAction("42", "instance.start", context());
  await plugin.provider.performPowerAction("42", "instance.stop", context());
  await plugin.provider.performPowerAction("42", "instance.restart", context());
  await plugin.provider.destroy("42", context());

  assert.deepEqual(
    calls.map(({ url, init }) => ({
      path: url.pathname,
      method: init.method,
      body: JSON.parse(init.body),
    })),
    [
      {
        path: "/api/v2/cloud-servers/42/actions/",
        method: "POST",
        body: { status: 2 },
      },
      {
        path: "/api/v2/cloud-servers/42/actions/",
        method: "POST",
        body: { status: -1 },
      },
      {
        path: "/api/v2/cloud-servers/42/actions/",
        method: "POST",
        body: { status: "REBOOT" },
      },
      {
        path: "/api/v2/cloud-servers/42/actions/",
        method: "POST",
        body: { status: -3 },
      },
    ],
  );
});

test("Intelion lifecycle keeps definite conflicts separate from unknown outcomes", async () => {
  let status = 404;
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ detail: "failure" }, status);
    },
  });

  await assert.rejects(
    plugin.provider.performPowerAction("42", "instance.start", context()),
    (error) => isNormalizedError(error) && error.code === "not-found",
  );
  status = 409;
  await assert.rejects(
    plugin.provider.performPowerAction("42", "instance.stop", context()),
    (error) => isNormalizedError(error) && error.code === "conflict",
  );
  status = 503;
  await assert.rejects(
    plugin.provider.destroy("42", context()),
    (error) => isNormalizedError(error) && error.code === "outcome-unknown",
  );
});
