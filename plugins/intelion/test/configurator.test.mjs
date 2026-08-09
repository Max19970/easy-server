import test from "node:test";
import assert from "node:assert/strict";
import { createIntelionProviderPlugin } from "../dist/index.js";

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
