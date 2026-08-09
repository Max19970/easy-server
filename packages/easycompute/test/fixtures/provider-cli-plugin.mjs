let created = false;

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
      return created
        ? [
            {
              providerExternalId: "created-1",
              state: "running",
              rawState: "READY",
              availableActions: [],
              name: "Created from feature",
            },
          ]
        : [];
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
          {
            name: "create",
            description: "Create a provider-owned resource",
            async run(_args, context) {
              created = true;
              context.write("created:created-1\n");
              return { refreshProviderInventory: true };
            },
          },
        ],
      },
    },
  ],
};
