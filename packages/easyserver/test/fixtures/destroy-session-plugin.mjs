import { existsSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { connect } from "node:net";

const destroyMarker = process.env.EASYSERVER_TEST_DESTROY_MARKER;
const closeFailFile = process.env.EASYSERVER_TEST_SESSION_CLOSE_FAIL_FILE;

function snapshot() {
  return {
    providerExternalId: "remote-1",
    state: "running",
    rawState: "READY",
    availableActions: ["instance.destroy"],
  };
}

export default {
  manifest: {
    id: "fixture.destroy-session",
    displayName: "Destroy Session Fixture",
    version: "1.0.0",
    compatibility: {
      easyserver: "^0.1.0",
      pluginSdk: "^0.1.0",
    },
    provider: {
      id: "destroy-session",
      displayName: "Destroy Session Provider",
      capabilities: ["instance.destroy"],
    },
  },
  provider: {
    providerId: "destroy-session",
    async listInstances() {
      return destroyMarker !== undefined && existsSync(destroyMarker)
        ? []
        : [snapshot()];
    },
    async getInstance(providerExternalId) {
      if (providerExternalId !== "remote-1") {
        return undefined;
      }
      return destroyMarker !== undefined && existsSync(destroyMarker)
        ? undefined
        : snapshot();
    },
    async destroy(providerExternalId, context) {
      if (providerExternalId !== "remote-1") {
        throw new Error("unexpected provider resource");
      }
      context.markMutationDispatched();
      if (destroyMarker !== undefined) {
        writeFileSync(destroyMarker, "destroyed", "utf8");
      }
    },
    async getAccessMethods() {
      return [
        {
          id: "fixture-loopback",
          kind: "destroy-session:loopback",
          mode: "tcp-forward",
        },
      ];
    },
  },
  accessAdapters: [
    {
      kind: "destroy-session:loopback",
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
          async close() {
            if (closeFailFile !== undefined && existsSync(closeFailFile)) {
              throw new Error("fixture session cleanup failure");
            }
          },
        };
      },
    },
  ],
};
