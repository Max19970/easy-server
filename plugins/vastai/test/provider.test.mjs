import assert from "node:assert/strict";
import test from "node:test";

import {
  createVastProviderPlugin,
  VAST_API_KEY_CREDENTIAL,
} from "../dist/index.js";
import { isNormalizedError } from "@easyai101/easyserver-plugin-sdk";

const DEFAULT_API_KEY = Symbol("default-api-key");

function context(apiKey = DEFAULT_API_KEY) {
  return {
    signal: new AbortController().signal,
    async resolveCredential(name) {
      assert.equal(name, VAST_API_KEY_CREDENTIAL);
      return apiKey === DEFAULT_API_KEY ? "fixture-key" : apiKey;
    },
    markMutationDispatched() {},
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("declares the required Vast.ai API credential", () => {
  assert.deepEqual(createVastProviderPlugin().manifest.credentials, [
    {
      name: VAST_API_KEY_CREDENTIAL,
      required: true,
      description: "Vast.ai API key",
    },
  ]);
});

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
      availableActions: [
        "instance.stop",
        "instance.restart",
        "instance.destroy",
      ],
    },
    {
      providerExternalId: "102",
      state: "unknown",
      rawState: "frozen",
      availableActions: ["instance.destroy"],
    },
    {
      providerExternalId: "103",
      state: "stopped",
      rawState: "stopped",
      availableActions: ["instance.start", "instance.destroy"],
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
    availableActions: ["instance.destroy"],
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
      markMutationDispatched() {},
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

test("Vast preserves documented safe provider rejection reasons", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json(
        {
          success: false,
          error: "invalid_args",
          msg: "Requested image is unavailable on this offer",
        },
        400,
      );
    },
  });
  const marketplace = plugin.features.find((feature) => feature.id === "marketplace");
  assert.ok(marketplace);

  await assert.rejects(
    marketplace.rentOffer(
      { offerId: "901", image: "missing:image" },
      context(),
    ),
    (error) =>
      isNormalizedError(error) &&
      error.code === "unknown-provider-error" &&
      error.message ===
        "Vast.ai returned HTTP 400: Requested image is unavailable on this offer",
  );
});

test("Vast provider diagnostics never render configured credentials or unsafe bodies", async () => {
  const unsafeBodies = [
    {
      body: {
        msg: "Authorization: Bearer fixture-key",
      },
      contentType: "application/json",
    },
    {
      body: {
        message: "<html><body>proxy error</body></html>",
      },
      contentType: "application/json",
    },
    {
      body: "<html><body>gateway error</body></html>",
      contentType: "text/html",
    },
    {
      body: { msg: "x".repeat(5000) },
      contentType: "application/json",
    },
    {
      body: "not-json",
      contentType: "application/json",
    },
  ];

  for (const fixture of unsafeBodies) {
    const plugin = createVastProviderPlugin({
      baseUrl: "https://fixture.vast.test",
      async fetch() {
        return new Response(
          typeof fixture.body === "string"
            ? fixture.body
            : JSON.stringify(fixture.body),
          {
            status: 400,
            headers: { "Content-Type": fixture.contentType },
          },
        );
      },
    });
    const marketplace = plugin.features.find(
      (feature) => feature.id === "marketplace",
    );
    assert.ok(marketplace);

    await assert.rejects(
      marketplace.searchOffers({}, context()),
      (error) =>
        isNormalizedError(error) &&
        error.code === "unknown-provider-error" &&
        error.message === "Vast.ai returned HTTP 400" &&
        !error.message.includes("fixture-key"),
    );
  }
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

test("Vast lifecycle actions follow provider raw-state semantics", async () => {
  const statuses = ["running", "stopped", "loading", "frozen", "offline"];
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input) {
      const id = Number(new URL(input).pathname.split("/").filter(Boolean).at(-1));
      return json({
        instances: {
          id,
          actual_status: statuses[id - 1],
          label: null,
        },
      });
    },
  });

  assert.deepEqual(plugin.manifest.provider.capabilities, [
    "instance.start",
    "instance.stop",
    "instance.restart",
    "instance.destroy",
  ]);
  assert.deepEqual(
    (await plugin.provider.getInstance("1", context())).availableActions,
    ["instance.stop", "instance.restart", "instance.destroy"],
  );
  assert.deepEqual(
    (await plugin.provider.getInstance("2", context())).availableActions,
    ["instance.start", "instance.destroy"],
  );
  for (const id of ["3", "4", "5"]) {
    assert.deepEqual(
      (await plugin.provider.getInstance(id, context())).availableActions,
      ["instance.destroy"],
    );
  }
});

test("Vast treats provider-confirmed stopped allocation as restartable after container exit", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({
        instances: {
          id: 42,
          actual_status: "exited",
          intended_status: "stopped",
          cur_state: "stopped",
          label: null,
        },
      });
    },
  });

  assert.deepEqual(await plugin.provider.getInstance("42", context()), {
    providerExternalId: "42",
    state: "stopped",
    rawState: "exited",
    availableActions: ["instance.start", "instance.destroy"],
  });
});

test("Vast exposes a generic SSH access method only when the instance is ready", async () => {
  let status = "running";
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({
        instances: {
          id: 42,
          actual_status: status,
          label: null,
          ssh_host: "ssh42.vast.test",
          ssh_port: 10422,
        },
      });
    },
  });

  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), [
    {
      id: "ssh",
      kind: "ssh",
      mode: "tcp-forward",
      ssh: {
        host: "ssh42.vast.test",
        port: 10422,
        username: "root",
      },
    },
  ]);

  status = "loading";
  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), []);
});

test("Vast does not expose SSH after provider lifecycle is already stopped", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({
        instances: {
          id: 42,
          actual_status: "running",
          intended_status: "stopped",
          cur_state: "stopped",
          label: null,
          ssh_host: "ssh42.vast.test",
          ssh_port: 10422,
        },
      });
    },
  });

  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), []);
});

test("Vast treats absent SSH routing as unavailable without inventing credentials", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({
        instances: {
          id: 42,
          actual_status: "running",
          label: null,
          ssh_host: null,
          ssh_port: null,
        },
      });
    },
  });

  assert.deepEqual(await plugin.provider.getAccessMethods("42", context()), []);
});

test("Vast lifecycle mutations use documented endpoints", async () => {
  const calls = [];
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init) {
      calls.push({ url: new URL(input), init });
      return json({ success: true });
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
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })),
    [
      {
        path: "/api/v0/instances/42/",
        method: "PUT",
        body: { state: "running" },
      },
      {
        path: "/api/v0/instances/42/",
        method: "PUT",
        body: { state: "stopped" },
      },
      {
        path: "/api/v0/instances/reboot/42/",
        method: "PUT",
        body: undefined,
      },
      {
        path: "/api/v0/instances/42/",
        method: "DELETE",
        body: undefined,
      },
    ],
  );
});

test("Vast lifecycle definite rejections and uncertain failures stay distinct", async () => {
  let status = 404;
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({ detail: "failure" }, status);
    },
  });

  await assert.rejects(
    plugin.provider.performPowerAction("42", "instance.start", context()),
    (error) => isNormalizedError(error) && error.code === "not-found",
  );
  status = 400;
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

test("Vast mutation with an unreadable success response remains outcome-unknown", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return new Response("", { status: 200 });
    },
  });

  await assert.rejects(
    plugin.provider.performPowerAction("42", "instance.start", context()),
    (error) => isNormalizedError(error) && error.code === "outcome-unknown",
  );
});

test("Vast lifecycle mutation with an ambiguous success payload remains outcome-unknown", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({ accepted: true });
    },
  });

  await assert.rejects(
    plugin.provider.performPowerAction("42", "instance.start", context()),
    (error) => isNormalizedError(error) && error.code === "outcome-unknown",
  );
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
            rentable: true,
          },
          {
            id: 902,
            machine_id: 78,
            gpu_name: "RTX 4090",
            num_gpus: 2,
            gpu_ram: 24576,
            dph_total: 0.39,
            reliability: 0.999,
            geolocation: "FI",
            rentable: false,
          },
          {
            id: 903,
            machine_id: 79,
            gpu_name: "RTX 4090",
            num_gpus: 2,
            gpu_ram: 24576,
            dph_total: 0.51,
            reliability: 0.998,
            geolocation: "US",
            rentable: true,
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
    rentable: { eq: true },
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

test("marketplace accepts rentable offers without geolocation", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({
        offers: [
          {
            id: 901,
            machine_id: 77,
            gpu_name: "RTX 4090",
            num_gpus: 1,
            gpu_ram: 24576,
            dph_total: 0.21,
            reliability: 0.997,
            geolocation: "DE",
            rentable: true,
          },
          {
            id: 902,
            machine_id: 78,
            gpu_name: "RTX 4090",
            num_gpus: 1,
            gpu_ram: 24576,
            dph_total: 0.22,
            reliability: 0.996,
            geolocation: null,
            rentable: true,
          },
        ],
      });
    },
  });

  const marketplace = plugin.features.find((feature) => feature.id === "marketplace");
  assert.ok(marketplace);

  const offers = await marketplace.searchOffers({ limit: 2 }, context());
  assert.equal(offers.length, 2);
  assert.equal(offers[0].location, "DE");
  assert.equal("location" in offers[1], false);
});

test("marketplace rental can select an offer returned by the rentable search contract", async () => {
  const calls = [];
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "POST") {
        return json({
          offers: [
            {
              id: 901,
              machine_id: 77,
              gpu_name: "RTX 4090",
              num_gpus: 1,
              gpu_ram: 24576,
              dph_total: 0.21,
              reliability: 0.997,
              geolocation: "DE",
              rentable: true,
            },
          ],
        });
      }
      return json({ success: true, new_contract: 777 });
    },
  });
  const marketplace = plugin.features.find((feature) => feature.id === "marketplace");
  assert.ok(marketplace);

  const [offer] = await marketplace.searchOffers({ limit: 1 }, context());
  assert.ok(offer);
  const rental = await marketplace.rentOffer(
    {
      offerId: offer.id,
      image: "ubuntu:22.04",
      runtype: "ssh_direct",
    },
    context(),
  );

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    rentable: { eq: true },
    limit: 1,
  });
  assert.equal(calls[1].url.pathname, "/api/v0/asks/901/");
  assert.deepEqual(rental, { providerExternalId: "777" });
});

test("marketplace feature rents an offer and the new instance converges on inventory", async () => {
  const calls = [];
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "PUT") {
        return json({ success: true, new_contract: 777 });
      }
      return json({
        instances: [
          { id: 777, actual_status: "loading", label: "rented-worker" },
        ],
        next_token: null,
      });
    },
  });
  const marketplace = plugin.features[0];

  const rental = await marketplace.rentOffer(
    {
      offerId: "901",
      image: "ubuntu:22.04",
      diskGb: 16,
      runtype: "ssh_direct",
      label: "rented-worker",
    },
    context(),
  );

  assert.deepEqual(rental, { providerExternalId: "777" });
  assert.equal(calls[0].url.pathname, "/api/v0/asks/901/");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    image: "ubuntu:22.04",
    disk: 16,
    runtype: "ssh_direct",
    label: "rented-worker",
  });

  assert.deepEqual(await plugin.provider.listInstances(context()), [
    {
      providerExternalId: "777",
      name: "rented-worker",
      state: "starting",
      rawState: "loading",
      availableActions: ["instance.destroy"],
    },
  ]);
});

test("marketplace rental with an ambiguous success payload remains outcome-unknown", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      return json({ success: true });
    },
  });

  await assert.rejects(
    plugin.features[0].rentOffer(
      { offerId: "901", image: "ubuntu:22.04" },
      context(),
    ),
    (error) => isNormalizedError(error) && error.code === "outcome-unknown",
  );
});

test("marketplace rental reports outcome-unknown after dispatch transport failure", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch() {
      throw new Error("connection reset");
    },
  });

  await assert.rejects(
    plugin.features[0].rentOffer(
      { offerId: "901", image: "ubuntu:22.04" },
      context(),
    ),
    (error) => isNormalizedError(error) && error.code === "outcome-unknown",
  );
});

test("marketplace feature exposes rental through the provider-scoped CLI seam", async () => {
  let requestBody;
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(_input, init) {
      requestBody = JSON.parse(init.body);
      return json({ success: true, new_contract: 778 });
    },
  });
  const marketplace = plugin.features[0];
  const rent = marketplace.cli?.commands.find((command) => command.name === "rent");
  assert.ok(rent);
  assert.deepEqual(rent.help?.arguments, [
    {
      name: "offer-id",
      description: "Vast.ai marketplace offer ID",
      required: true,
    },
  ]);
  assert.deepEqual(
    rent.help?.options?.map(({ name, required, repeatable }) => ({
      name,
      required,
      repeatable: repeatable ?? false,
    })),
    [
      { name: "--image", required: true, repeatable: false },
      { name: "--disk", required: false, repeatable: false },
      { name: "--runtype", required: false, repeatable: false },
      { name: "--label", required: false, repeatable: false },
    ],
  );

  let output = "";
  const commandResult = await rent.run(
    [
      "901",
      "--image",
      "ubuntu:22.04",
      "--disk",
      "20",
      "--runtype",
      "ssh_direct",
      "--label",
      "cli-worker",
    ],
    {
      ...context(),
      write(text) {
        output += text;
      },
      writeError() {},
    },
  );

  assert.deepEqual(requestBody, {
    image: "ubuntu:22.04",
    disk: 20,
    runtype: "ssh_direct",
    label: "cli-worker",
  });
  assert.equal(output, '{"providerExternalId":"778"}\n');
  assert.deepEqual(commandResult, {
    refreshProviderInventory: true,
    affectedProviderExternalIds: ["778"],
  });
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
  assert.deepEqual(
    search.help?.options?.map(({ name, valueName }) => ({ name, valueName })),
    [
      { name: "--gpu", valueName: "gpu-name" },
      { name: "--min-gpus", valueName: "count" },
      { name: "--max-hourly", valueName: "usd" },
      { name: "--min-reliability", valueName: "ratio" },
      { name: "--verified", valueName: undefined },
      { name: "--limit", valueName: "count" },
    ],
  );

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
    rentable: { eq: true },
    gpu_name: { eq: "RTX 5090" },
    dph_total: { lte: 1.25 },
    verified: { eq: true },
  });
  assert.equal(output, "[]\n");
});
