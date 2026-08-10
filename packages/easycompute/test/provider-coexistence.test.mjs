import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createIntelionProviderPlugin,
  INTELION_API_TOKEN_CREDENTIAL,
} from "../../../plugins/intelion/dist/index.js";
import {
  createVastProviderPlugin,
  VAST_API_KEY_CREDENTIAL,
} from "../../../plugins/vastai/dist/index.js";
import { AccessAdapterRegistry } from "../dist/access-adapter-registry.js";
import { ComputeManager } from "../dist/compute-manager.js";
import { ConnectionGateway } from "../dist/connection-gateway.js";
import { PluginHost } from "../dist/plugin-host.js";
import { ProviderFeatureHost } from "../dist/provider-feature-host.js";
import { ProviderRegistry } from "../dist/provider-registry.js";
import { JsonStateStore } from "../dist/state-store.js";

const VAST_SECRET_REF = "secret:550e8400-e29b-41d4-a716-446655440001";
const INTELION_SECRET_REF = "secret:550e8400-e29b-41d4-a716-446655440002";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function operationContext() {
  return { signal: new AbortController().signal };
}

function featureContext(admission) {
  const signal = new AbortController().signal;
  return {
    signal,
    resolveCredential: (name) => admission.resolveCredential(name, signal),
    markMutationDispatched() {},
  };
}

async function roundTrip(endpoint, payload) {
  const socket = connect(endpoint);
  await once(socket, "connect");
  const received = new Promise((resolve) => socket.once("data", resolve));
  socket.write(payload);
  const data = await received;
  socket.destroy();
  return data.toString();
}

function createVastFixture() {
  let instance;
  let restarts = 0;
  const plugin = createVastProviderPlugin({
    baseUrl: "https://fixture.vast.test",
    async fetch(input, init = {}) {
      const url = new URL(input);
      const method = init.method ?? "GET";

      if (url.pathname === "/api/v0/bundles/" && method === "POST") {
        return json({
          offers: [
            {
              id: 901,
              machine_id: 77,
              gpu_name: "RTX 4090",
              num_gpus: 1,
              gpu_ram: 24576,
              dph_total: 0.42,
              reliability: 0.997,
              geolocation: "DE",
            },
          ],
        });
      }
      if (url.pathname === "/api/v0/asks/901/" && method === "PUT") {
        instance = {
          id: 777,
          actual_status: "running",
          label: "vast-worker",
          ssh_host: "ssh777.vast.test",
          ssh_port: 10422,
        };
        return json({ success: true, new_contract: 777 });
      }
      if (url.pathname === "/api/v1/instances/" && method === "GET") {
        return json({ instances: instance === undefined ? [] : [instance], next_token: null });
      }
      if (url.pathname === "/api/v0/instances/777/" && method === "GET") {
        return json({ instances: instance });
      }
      if (url.pathname === "/api/v0/instances/reboot/777/" && method === "PUT") {
        restarts += 1;
        return json({ success: true });
      }

      throw new Error(`Unexpected Vast fixture request: ${method} ${url.pathname}`);
    },
  });

  return { plugin, restartCount: () => restarts };
}

function createIntelionFixture() {
  let server;
  let restarts = 0;
  let passwordReads = 0;
  const plugin = createIntelionProviderPlugin({
    baseUrl: "https://fixture.intelion.test",
    async fetch(input, init = {}) {
      const url = new URL(input);
      const method = init.method ?? "GET";

      if (url.pathname === "/api/v2/cloud-servers/" && method === "POST") {
        server = {
          id: 501,
          name: "intelion-worker",
          status: 2,
          ip_to_connect: "203.0.113.51",
          domain_to_connect: "server-501.intelion.test",
          login: null,
          os: {
            id: 7,
            name: "Ubuntu 24.04 LTS",
            type: "lin",
            ssh_enabled: true,
            rdp_enabled: false,
          },
        };
        return json(server);
      }
      if (url.pathname === "/api/v2/cloud-servers/" && method === "GET") {
        return json({
          count: server === undefined ? 0 : 1,
          next: null,
          previous: null,
          results: server === undefined ? [] : [server],
        });
      }
      if (url.pathname === "/api/v2/cloud-servers/501/" && method === "GET") {
        return json(server);
      }
      if (
        url.pathname === "/api/v2/cloud-servers/501/actions/" &&
        method === "POST"
      ) {
        assert.deepEqual(JSON.parse(init.body), { status: "REBOOT" });
        restarts += 1;
        return json(server);
      }
      if (
        url.pathname === "/api/v2/cloud-servers/501/password/" &&
        method === "GET"
      ) {
        passwordReads += 1;
        return json({ password: "intelion-session-password" });
      }

      throw new Error(`Unexpected Intelion fixture request: ${method} ${url.pathname}`);
    },
  });

  return {
    plugin,
    restartCount: () => restarts,
    passwordReadCount: () => passwordReads,
  };
}

test("Vast and Intelion coexist through shared lifecycle and connection paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easycompute-coexistence-"));
  try {
    const vast = createVastFixture();
    const intelion = createIntelionFixture();
    const plugins = new Map([
      ["fixture:vast", vast.plugin],
      ["fixture:intelion", intelion.plugin],
    ]);
    const secrets = new Map([
      [VAST_SECRET_REF, "vast-fixture-key"],
      [INTELION_SECRET_REF, "intelion-fixture-token"],
    ]);
    const secretStore = {
      async get(ref) {
        return secrets.get(ref);
      },
    };
    const providers = new ProviderRegistry();
    const features = new ProviderFeatureHost();
    const host = new PluginHost(
      providers,
      async (source) => plugins.get(source),
      features,
    );
    await host.load(
      [
        {
          source: "fixture:vast",
          credentials: [{ name: VAST_API_KEY_CREDENTIAL, secretRef: VAST_SECRET_REF }],
        },
        {
          source: "fixture:intelion",
          credentials: [
            { name: INTELION_API_TOKEN_CREDENTIAL, secretRef: INTELION_SECRET_REF },
          ],
        },
      ],
      secretStore,
    );

    assert.deepEqual(providers.listProviderIds(), ["vastai", "intelion"]);
    assert.deepEqual(
      features.listFeatures().map(({ providerId, featureId }) => [providerId, featureId]),
      [
        ["vastai", "marketplace"],
        ["intelion", "server-configurator"],
      ],
    );

    const vastFeature = features.acquire("vastai", "marketplace");
    const intelionFeature = features.acquire("intelion", "server-configurator");
    assert.ok(vastFeature);
    assert.ok(intelionFeature);
    try {
      const offers = await vastFeature.feature.searchOffers(
        { gpuName: "RTX 4090", verifiedOnly: true },
        featureContext(vastFeature),
      );
      assert.equal(offers[0].id, "901");
      assert.deepEqual(
        await vastFeature.feature.rentOffer(
          { offerId: offers[0].id, image: "ubuntu:22.04", runtype: "ssh_direct" },
          featureContext(vastFeature),
        ),
        { providerExternalId: "777" },
      );

      const configuration = intelionFeature.feature.validateConfiguration({
        name: "intelion-worker",
        flavorId: 12,
        networkDiskGb: 64,
        osImageId: 7,
      });
      assert.deepEqual(
        await intelionFeature.feature.createServer(
          configuration,
          featureContext(intelionFeature),
        ),
        { providerExternalId: "501" },
      );
    } finally {
      vastFeature.release();
      intelionFeature.release();
    }

    const store = new JsonStateStore(join(directory, "state.json"));
    const manager = new ComputeManager(providers, store);
    const instances = await manager.listInstances(operationContext());
    assert.equal(instances.length, 2);
    const vastInstance = instances.find((instance) => instance.providerId === "vastai");
    const intelionInstance = instances.find(
      (instance) => instance.providerId === "intelion",
    );
    assert.ok(vastInstance);
    assert.ok(intelionInstance);

    await manager.performAction(
      vastInstance.id,
      "instance.restart",
      operationContext(),
    );
    await manager.performAction(
      intelionInstance.id,
      "instance.restart",
      operationContext(),
    );
    assert.equal(vast.restartCount(), 1);
    assert.equal(intelion.restartCount(), 1);

    const connectionSetups = [];
    const sshAdapter = {
      kind: "ssh",
      async openTcpForward(method, providerExternalId, target, context) {
        const password = method.credentialSources?.some(
          (source) => source.kind === "provider-deferred",
        )
          ? await context.resolveCredential("ssh-password")
          : undefined;
        connectionSetups.push({
          providerExternalId,
          host: method.ssh.host,
          username: method.ssh.username,
          target,
          password,
        });
        return {
          async openChannel() {
            const stream = new PassThrough();
            return {
              stream,
              async close() {
                stream.destroy();
              },
            };
          },
          async close() {},
        };
      },
    };
    const gateway = new ConnectionGateway(
      providers,
      new AccessAdapterRegistry([sshAdapter]),
      store,
      secretStore,
    );
    const vastConnection = await gateway.openEndpoint(
      vastInstance.id,
      8188,
      operationContext(),
    );
    const intelionConnection = await gateway.openEndpoint(
      intelionInstance.id,
      8188,
      operationContext(),
    );
    try {
      assert.equal(await roundTrip(vastConnection.endpoint, "vast"), "vast");
      assert.equal(
        await roundTrip(intelionConnection.endpoint, "intelion"),
        "intelion",
      );
    } finally {
      await vastConnection.session.close();
      await intelionConnection.session.close();
    }
    assert.deepEqual(
      connectionSetups.map(({ providerExternalId, target }) => ({
        providerExternalId,
        target,
      })),
      [
        { providerExternalId: "777", target: { host: "127.0.0.1", port: 8188 } },
        { providerExternalId: "501", target: { host: "127.0.0.1", port: 8188 } },
      ],
    );
    assert.equal(connectionSetups[0].password, undefined);
    assert.equal(connectionSetups[1].username, "root");
    assert.equal(connectionSetups[1].password, "intelion-session-password");
    assert.equal(intelion.passwordReadCount(), 1);

    assert.equal(host.disable("vastai"), true);
    assert.equal(providers.acquire("vastai"), undefined);
    assert.equal(features.acquire("vastai", "marketplace"), undefined);
    assert.ok(providers.acquire("intelion"));
    assert.ok(features.acquire("intelion", "server-configurator"));
    assert.deepEqual(
      (await manager.listInstances(operationContext())).map(
        (instance) => instance.providerId,
      ),
      ["intelion"],
    );

    assert.equal(host.disable("intelion"), true);
    assert.equal(providers.acquire("intelion"), undefined);
    assert.equal(features.acquire("intelion", "server-configurator"), undefined);
    assert.deepEqual(await manager.listInstances(operationContext()), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
