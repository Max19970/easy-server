export default {
  manifest: {
    id: "fixture.provider-cli",
    displayName: "Provider CLI Fixture Plugin",
    version: "1.0.0",
    compatibility: {
      easycompute: "0.0.0",
      pluginSdk: "0.0.0",
    },
    provider: {
      id: "provider-cli",
      displayName: "Provider CLI Fixture",
      capabilities: [],
    },
  },
  provider: {
    providerId: "provider-cli",
    async listInstances() {
      return [];
    },
    async getInstance() {
      return undefined;
    },
  },
  features: [
    {
      id: "marketplace",
      displayName: "Fixture Marketplace",
      cli: {
        commands: [
          {
            name: "echo",
            description: "Echo provider-owned arguments",
            async run(args, context) {
              context.write(`provider-owned:${args.join("|")}\n`);
            },
          },
        ],
      },
    },
  ],
};
