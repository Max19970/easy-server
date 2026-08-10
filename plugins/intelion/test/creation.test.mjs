import test from "node:test";
import assert from "node:assert/strict";
import { isNormalizedError } from "@easycompute/plugin-sdk";
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
    markMutationDispatched() {},
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validConfiguration() {
  return {
    name: "training-box",
    flavorId: 12,
    networkDiskGb: 100,
    osImageId: 7,
    pricePlan: 1,
    promotionCodeId: 3,
    queueWhenUnavailable: true,
    addonIds: [9, 4],
    sshKeyIds: [246, 247],
  };
}

test("server configurator creates REQUESTED resources that converge on inventory", async () => {
  const calls = [];
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method === "POST") {
        return json({ id: 501, name: "training-box", status: -2 });
      }
      return json({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 501, name: "training-box", status: -2 }],
      });
    },
  });
  const configurator = plugin.features[0];

  assert.deepEqual(
    await configurator.createServer(validConfiguration(), context()),
    { providerExternalId: "501" },
  );
  assert.equal(calls[0].url.pathname, "/api/v2/cloud-servers/");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Token fixture-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: "training-box",
    flavor_id: 12,
    ssd_count: 100,
    os_id: 7,
    price_plan: 1,
    promocode_id: 3,
    is_in_queue: true,
    addon_ids: [9, 4],
    ssh_key_ids: [246, 247],
  });

  assert.deepEqual(await plugin.provider.listInstances(context()), [
    {
      providerExternalId: "501",
      name: "training-box",
      state: "provisioning",
      rawState: -2,
      availableActions: ["instance.start", "instance.destroy"],
    },
  ]);
});

test("server creation reports outcome-unknown after dispatch transport failure", async () => {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      throw new Error("connection reset");
    },
  });

  await assert.rejects(
    plugin.features[0].createServer(validConfiguration(), context()),
    (error) => isNormalizedError(error) && error.code === "outcome-unknown",
  );
});

test("server creation CLI requests provider inventory reconciliation", async () => {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch() {
      return json({ id: 502, name: "cli-box", status: -2 });
    },
  });
  const create = plugin.features[0].cli?.commands.find(
    (command) => command.name === "create",
  );
  assert.ok(create);

  let output = "";
  const result = await create.run(
    [
      "--name",
      "cli-box",
      "--flavor",
      "12",
      "--disk",
      "64",
      "--os",
      "7",
    ],
    {
      ...context(),
      write(text) {
        output += text;
      },
      writeError() {},
    },
  );

  assert.equal(output, '{"providerExternalId":"502"}\n');
  assert.deepEqual(result, { refreshProviderInventory: true });
});
