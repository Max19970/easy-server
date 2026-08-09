import assert from "node:assert/strict";
import test from "node:test";

import {
  createVastProviderPlugin,
  VAST_API_KEY_CREDENTIAL,
} from "../dist/index.js";
import { isNormalizedError } from "@easycompute/plugin-sdk";

const DEFAULT_API_KEY = Symbol("default-api-key");

function context(apiKey = DEFAULT_API_KEY) {
  return {
    signal: new AbortController().signal,
    async resolveCredential(name) {
      assert.equal(name, VAST_API_KEY_CREDENTIAL);
      return apiKey === DEFAULT_API_KEY ? "fixture-key" : apiKey;
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("lists all Vast.ai instance pages with Bearer authentication", async () => {
  const calls = [];
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (url.searchParams.get("after_token") === null) {
        return json({
          instances: [
            { id: 101, actual_status: "running", label: "trainer" },
            { id: 102, actual_status: "frozen", label: "" },
          ],
          next_token: "page-2",
        });
      }
      return json({
        instances: [{ id: 103, actual_status: "stopped", label: null }],
        next_token: null,
      });
    },
  });

  const instances = await plugin.provider.listInstances(context());

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/v1/instances/");
  assert.equal(calls[0].url.searchParams.get("limit"), "25");
  assert.equal(calls[1].url.searchParams.get("after_token"), "page-2");
  assert.equal(calls[0].init.headers.Authorization, "Bearer fixture-key");
  assert.deepEqual(instances, [
    {
      providerExternalId: "101",
      name: "trainer",
      state: "running",
      rawState: "running",
      availableActions: [],
    },
    {
      providerExternalId: "102",
      state: "unknown",
      rawState: "frozen",
      availableActions: [],
    },
    {
      providerExternalId: "103",
      state: "stopped",
      rawState: "stopped",
      availableActions: [],
    },
  ]);
});

test("gets one instance and preserves unknown raw status", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init) {
      assert.equal(new URL(input).pathname, "/api/v0/instances/777/");
      assert.equal(init.headers.Authorization, "Bearer fixture-key");
      return json({
        instances: {
          id: 777,
          actual_status: "offline",
          label: "worker",
        },
      });
    },
  });

  assert.deepEqual(await plugin.provider.getInstance("777", context()), {
    providerExternalId: "777",
    name: "worker",
    state: "unknown",
    rawState: "offline",
    availableActions: [],
  });
});

test("missing and rejected API keys become normalized authentication errors", async () => {
  let requests = 0;
  const missingPlugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      requests += 1;
      return json({ instances: [], next_token: null });
    },
  });

  await assert.rejects(
    missingPlugin.provider.listInstances({
      signal: new AbortController().signal,
      async resolveCredential(name) {
        assert.equal(name, VAST_API_KEY_CREDENTIAL);
        return undefined;
      },
    }),
    (error) => isNormalizedError(error) && error.code === "authentication",
  );
  assert.equal(requests, 0);

  const rejectedPlugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({ detail: "unauthorized" }, 401);
    },
  });
  await assert.rejects(
    rejectedPlugin.provider.listInstances(context("bad-key")),
    (error) => isNormalizedError(error) && error.code === "authentication",
  );
});

test("404 instance lookup returns undefined without weakening other HTTP errors", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({ detail: "not found" }, 404);
    },
  });

  assert.equal(await plugin.provider.getInstance("404", context()), undefined);
});

test("marketplace feature searches Vast offers with plugin-owned filters", async () => {
  const calls = [];
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init) {
      calls.push({ url: new URL(input), init });
      return json({
        offers: [
          {
            id: 901,
            machine_id: 77,
            gpu_name: "RTX 4090",
            num_gpus: 2,
            gpu_ram: 24576,
            dph_total: 0.42,
            reliability: 0.997,
            geolocation: "DE",
          },
        ],
      });
    },
  });

  const marketplace = plugin.features.find((feature) => feature.id === "marketplace");
  assert.ok(marketplace);

  const offers = await marketplace.searchOffers(
    {
      gpuName: "RTX 4090",
      minGpuCount: 2,
      maxHourlyPrice: 0.5,
      minReliability: 0.99,
      verifiedOnly: true,
      limit: 7,
    },
    context(),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/v0/bundles/");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer fixture-key");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    gpu_name: { eq: "RTX 4090" },
    num_gpus: { gte: 2 },
    dph_total: { lte: 0.5 },
    reliability: { gte: 0.99 },
    verified: { eq: true },
    limit: 7,
  });
  assert.deepEqual(offers, [
    {
      id: "901",
      machineId: "77",
      gpuName: "RTX 4090",
      gpuCount: 2,
      gpuRamMb: 24576,
      hourlyPriceUsd: 0.42,
      reliability: 0.997,
      location: "DE",
    },
  ]);
});

test("marketplace feature exposes search through the provider-scoped CLI seam", async () => {
  let requestBody;
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(_input, init) {
      requestBody = JSON.parse(init.body);
      return json({ offers: [] });
    },
  });
  const marketplace = plugin.features[0];
  const search = marketplace.cli?.commands.find((command) => command.name === "search");
  assert.ok(search);

  let output = "";
  await search.run(
    ["--gpu", "RTX 5090", "--max-hourly", "1.25", "--verified"],
    {
      ...context(),
      write(text) {
        output += text;
      },
      writeError() {},
    },
  );

  assert.deepEqual(requestBody, {
    gpu_name: { eq: "RTX 5090" },
    dph_total: { lte: 1.25 },
    verified: { eq: true },
  });
  assert.equal(output, "[]\n");
});
