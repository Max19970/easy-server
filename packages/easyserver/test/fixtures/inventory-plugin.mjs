export default {
  manifest: {
    id: "fixture.inventory",
    displayName: "Inventory Fixture Plugin",
    version: "1.0.0",
    compatibility: {
      easyserver: "^0.1.0",
      pluginSdk: "^0.1.0",
    },
    provider: {
      id: "inventory",
      displayName: "Inventory Fixture Provider",
      capabilities: ["instance.start", "instance.stop"],
    },
  },
  provider: {
    providerId: "inventory",
    async listInstances() {
      return [
        {
          providerExternalId: "remote-1",
          name: "Fixture GPU",
          state: "running",
          rawState: "READY",
          availableActions: ["instance.stop"],
        },
      ];
    },
    async getInstance(providerExternalId) {
      if (providerExternalId !== "remote-1") {
        return undefined;
      }

      return {
        providerExternalId,
        name: "Fixture GPU",
        state: "running",
        rawState: "READY",
        availableActions: ["instance.stop"],
      };
    },
    async performPowerAction(providerExternalId, action) {
      if (providerExternalId !== "remote-1" || action !== "instance.stop") {
        throw new Error("fixture action mismatch");
      }
    },
  },
};
