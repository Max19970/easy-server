export default {
  manifest: {
    id: "fixture.plugin",
    displayName: "Fixture Plugin",
    version: "1.0.0",
    compatibility: {
      easycompute: "0.0.0",
      pluginSdk: "0.0.0",
    },
    provider: {
      id: "fixture",
      displayName: "Fixture Provider",
      capabilities: [],
    },
  },
  provider: {
    providerId: "fixture",
  },
};
