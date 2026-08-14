export default {
  manifest: {
    id: "fixture.credentials",
    displayName: "Credential Fixture Plugin",
    version: "1.0.0",
    compatibility: {
      easyserver: "^0.2.0",
      pluginSdk: "^0.2.0",
    },
    credentials: [
      {
        name: "api-key",
        required: true,
        description: "Fixture API key",
      },
      {
        name: "profile",
        required: false,
        description: "Optional fixture profile",
      },
    ],
    provider: {
      id: "credential-fixture",
      displayName: "Credential Fixture Provider",
      capabilities: [],
    },
  },
  provider: {
    providerId: "credential-fixture",
    async listInstances() {
      return [];
    },
    async getInstance() {
      return undefined;
    },
  },
};
