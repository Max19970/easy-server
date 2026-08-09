import { once } from "node:events";
import { connect } from "node:net";

export default {
  manifest: {
    id: "fixture.daemon-plugin",
    displayName: "Daemon Fixture Plugin",
    version: "1.0.0",
    compatibility: {
      easycompute: "0.0.0",
      pluginSdk: "0.0.0",
    },
    provider: {
      id: "daemon-fixture",
      displayName: "Daemon Fixture Provider",
      capabilities: [],
    },
  },
  provider: {
    providerId: "daemon-fixture",
    async listInstances() {
      return [];
    },
    async getInstance() {
      return undefined;
    },
    async getAccessMethods() {
      return [
        {
          id: "fixture-loopback",
          kind: "daemon-fixture:loopback",
          mode: "tcp-forward",
        },
      ];
    },
  },
  accessAdapters: [
    {
      kind: "daemon-fixture:loopback",
      async openTcpForward(_method, _providerExternalId, target) {
        return {
          async openChannel() {
            const socket = connect(target);
            await once(socket, "connect");
            return {
              stream: socket,
              async close() {
                socket.destroy();
              },
            };
          },
          async close() {},
        };
      },
    },
  ],
};
