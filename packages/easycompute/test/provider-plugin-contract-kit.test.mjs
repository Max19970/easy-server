import assert from "node:assert/strict";
import test from "node:test";
import {
  createIntelionProviderPlugin,
  INTELION_API_TOKEN_CREDENTIAL,
} from "../../../plugins/intelion/dist/index.js";
import {
  createVastProviderPlugin,
  VAST_API_KEY_CREDENTIAL,
} from "../../../plugins/vastai/dist/index.js";
import daemonPlugin from "./fixtures/daemon-plugin.mjs";
import {
  assertAccessAdapterRegistration,
  assertNormalizedOperationError,
  assertProviderAdapterContract,
  assertProviderFeatureLifecycle,
} from "./support/provider-plugin-contract-kit.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function providerContext(credentialName, signal = new AbortController().signal) {
  return {
    signal,
    async resolveCredential(name) {
      assert.equal(name, credentialName);
      return "fixture-secret";
    },
  };
}

test("contract kit accepts Vast normalized provider adapter through public SDK operations", async () => {
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input) {
      const path = new URL(input).pathname;
      if (path === "/api/v1/instances/") {
        return json({
          instances: [{ id: 101, actual_status: "running", label: "trainer" }],
          next_token: null,
        });
      }
      assert.equal(path, "/api/v0/instances/101/");
      return json({
        instances: { id: 101, actual_status: "running", label: "trainer" },
      });
    },
  });

  const listed = await assertProviderAdapterContract(
    plugin,
    providerContext(VAST_API_KEY_CREDENTIAL),
  );
  assert.equal(listed.length, 1);
});

test("contract kit accepts Intelion normalized provider adapter through public SDK operations", async () => {
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input) {
      const path = new URL(input).pathname;
      if (path === "/api/v2/cloud-servers/") {
        return json({
          count: 1,
          next: null,
          previous: null,
          results: [{ id: 202, name: "trainer", status: 2 }],
        });
      }
      assert.equal(path, "/api/v2/cloud-servers/202/");
      return json({ id: 202, name: "trainer", status: 2 });
    },
  });

  const listed = await assertProviderAdapterContract(
    plugin,
    providerContext(INTELION_API_TOKEN_CREDENTIAL),
  );
  assert.equal(listed.length, 1);
});

test("contract kit exercises host-owned cancellation through first-party provider public operations", async () => {
  for (const subject of [
    {
      name: "Vast",
      credential: VAST_API_KEY_CREDENTIAL,
      create(fetch) {
        return createVastProviderPlugin({
          baseUrl: "https://fixture.vast.test",
          fetch,
        });
      },
    },
    {
      name: "Intelion",
      credential: INTELION_API_TOKEN_CREDENTIAL,
      create(fetch) {
        return createIntelionProviderPlugin({
          baseUrl: "https://fixture.intelion.test",
          fetch,
        });
      },
    },
  ]) {
    let markDispatched;
    const dispatched = new Promise((resolve) => {
      markDispatched = resolve;
    });
    const plugin = subject.create(async (_input, init) => {
      markDispatched();
      await new Promise((_, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(new Error(`${subject.name} fetch aborted`)),
          { once: true },
        ),
      );
    });
    const controller = new AbortController();
    const operation = plugin.provider.listInstances(
      providerContext(subject.credential, controller.signal),
    );

    await dispatched;
    controller.abort();
    await assertNormalizedOperationError(operation, "cancelled");
  }
});

test("contract kit keeps uncertain first-party mutations outcome-unknown without retry", async () => {
  for (const subject of [
    {
      credential: VAST_API_KEY_CREDENTIAL,
      create(fetch) {
        return createVastProviderPlugin({
          baseUrl: "https://fixture.vast.test",
          fetch,
        });
      },
    },
    {
      credential: INTELION_API_TOKEN_CREDENTIAL,
      create(fetch) {
        return createIntelionProviderPlugin({
          baseUrl: "https://fixture.intelion.test",
          fetch,
        });
      },
    },
  ]) {
    let dispatches = 0;
    const plugin = subject.create(async () => {
      dispatches += 1;
      return json({ detail: "uncertain" }, 503);
    });

    await assertNormalizedOperationError(
      plugin.provider.destroy(
        "42",
        providerContext(subject.credential),
      ),
      "outcome-unknown",
    );
    assert.equal(dispatches, 1);
  }
});

test("contract kit proves Provider Feature leases survive disable while new admission stops", async () => {
  await assertProviderFeatureLifecycle(
    createVastProviderPlugin({
      baseUrl: "https://fixture.vast.test",
      async fetch() {
        throw new Error("feature lifecycle contract must not call provider transport");
      },
    }),
    "marketplace",
  );
  await assertProviderFeatureLifecycle(
    createIntelionProviderPlugin({
      baseUrl: "https://fixture.intelion.test",
      async fetch() {
        throw new Error("feature lifecycle contract must not call provider transport");
      },
    }),
    "server-configurator",
  );
});

test("contract kit resolves a plugin-contributed Access Adapter without core provider knowledge", async () => {
  await assertAccessAdapterRegistration(daemonPlugin, {
    id: "fixture-loopback",
    kind: "daemon-fixture:loopback",
    mode: "tcp-forward",
  });
});
