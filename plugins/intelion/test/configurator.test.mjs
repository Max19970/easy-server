import test from "node:test";
import assert from "node:assert/strict";
import {
  createIntelionProviderPlugin,
  INTELION_API_TOKEN_CREDENTIAL,
} from "../dist/index.js";

function configurator() {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      throw new Error("config validation must not call Intelion");
    },
  });
  const feature = plugin.features.find(
    (candidate) => candidate.id === "server-configurator",
  );
  assert.ok(feature);
  return feature;
}

test("server configurator validates Intelion-owned creation choices", () => {
  assert.deepEqual(
    configurator().validateConfiguration({
      name: "  training-box  ",
      flavorId: 12,
      networkDiskGb: 100,
      osImageId: 7,
      promotionCodeId: 3,
      queueWhenUnavailable: true,
      addonIds: [9, 4],
    }),
    {
      name: "training-box",
      flavorId: 12,
      networkDiskGb: 100,
      osImageId: 7,
      pricePlan: 0,
      promotionCodeId: 3,
      queueWhenUnavailable: true,
      addonIds: [9, 4],
    },
  );
});

test("server configurator rejects invalid provider-specific creation values", () => {
  const feature = configurator();
  const valid = {
    name: "training-box",
    flavorId: 12,
    networkDiskGb: 30,
    osImageId: 7,
  };

  assert.throws(
    () => feature.validateConfiguration({ ...valid, networkDiskGb: 29 }),
    /networkDiskGb must be an integer >= 30/,
  );
  assert.throws(
    () => feature.validateConfiguration({ ...valid, flavorId: 0 }),
    /flavorId must be a positive integer/,
  );
  assert.throws(
    () => feature.validateConfiguration({ ...valid, name: "   " }),
    /name must be non-empty/,
  );
  assert.throws(
    () => feature.validateConfiguration({ ...valid, addonIds: [4, 4] }),
    /addonIds must not contain duplicates/,
  );
});

test("server configurator lists Intelion OS images through the provider-scoped CLI seam", async () => {
  const calls = [];
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (url.searchParams.get("page") === "2") {
        return new Response(
          JSON.stringify({
            count: 2,
            next: null,
            previous: "https://fixture.intelion.test/api/v2/os-images/?flavor_id=12",
            results: [
              {
                id: 8,
                name: "Windows Server 2022",
                type: "windows",
                description: "Windows image",
                ssh_enabled: false,
                rdp_enabled: true,
                compatible_flavor_ids: [12],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          count: 2,
          next: "https://fixture.intelion.test/api/v2/os-images/?flavor_id=12&page=2",
          previous: null,
          results: [
            {
              id: 7,
              name: "Ubuntu 24.04 LTS",
              type: "linux",
              description: "CUDA-ready Ubuntu",
              ssh_enabled: true,
              rdp_enabled: false,
              compatible_flavor_ids: [12, 13],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const feature = plugin.features.find(
    (candidate) => candidate.id === "server-configurator",
  );
  assert.ok(feature);
  const command = feature.cli?.commands.find(
    (candidate) => candidate.name === "os-images",
  );
  assert.ok(command);

  let output = "";
  await command.run(["--flavor", "12"], {
    signal: new AbortController().signal,
    async resolveCredential(name) {
      assert.equal(name, INTELION_API_TOKEN_CREDENTIAL);
      return "fixture-token";
    },
    markMutationDispatched() {},
    write(text) {
      output += text;
    },
    writeError() {},
  });

  assert.deepEqual(JSON.parse(output), [
    {
      id: 7,
      name: "Ubuntu 24.04 LTS",
      type: "linux",
      description: "CUDA-ready Ubuntu",
      sshEnabled: true,
      rdpEnabled: false,
      compatibleFlavorIds: [12, 13],
    },
    {
      id: 8,
      name: "Windows Server 2022",
      type: "windows",
      description: "Windows image",
      sshEnabled: false,
      rdpEnabled: true,
      compatibleFlavorIds: [12],
    },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/v2/os-images/");
  assert.equal(calls[0].url.searchParams.get("flavor_id"), "12");
  assert.equal(calls[1].url.searchParams.get("page"), "2");
});

test("server configurator rejects malformed Intelion OS-image catalog payloads", async () => {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return new Response(
        JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [{ id: "7", name: "Ubuntu 24.04 LTS" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const feature = plugin.features.find(
    (candidate) => candidate.id === "server-configurator",
  );
  assert.ok(feature);
  const command = feature.cli?.commands.find(
    (candidate) => candidate.name === "os-images",
  );
  assert.ok(command);

  await assert.rejects(
    () =>
      command.run([], {
        signal: new AbortController().signal,
        async resolveCredential() {
          return "fixture-token";
        },
        markMutationDispatched() {},
        write() {},
        writeError() {},
      }),
    (error) => error?.code === "plugin-failure",
  );
});

test("server configurator is usable through the provider-scoped CLI seam", async () => {
  const feature = configurator();
  const validate = feature.cli?.commands.find(
    (command) => command.name === "validate",
  );
  assert.ok(validate);

  let output = "";
  await validate.run(
    [
      "--name",
      "cli-box",
      "--flavor",
      "12",
      "--disk",
      "64",
      "--os",
      "7",
      "--price-plan",
      "1",
      "--queue",
      "--addon",
      "9",
      "--addon",
      "4",
    ],
    {
      signal: new AbortController().signal,
      async resolveCredential() {
        return undefined;
      },
      markMutationDispatched() {},
      write(text) {
        output += text;
      },
      writeError() {},
    },
  );

  assert.deepEqual(JSON.parse(output), {
    name: "cli-box",
    flavorId: 12,
    networkDiskGb: 64,
    osImageId: 7,
    pricePlan: 1,
    queueWhenUnavailable: true,
    addonIds: [9, 4],
  });
});
