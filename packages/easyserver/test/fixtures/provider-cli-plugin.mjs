import { normalizedError } from "@easyai101/easyserver-plugin-sdk";

let created = false;

export default {
  manifest: {
    id: "fixture.provider-cli",
    displayName: "Provider CLI Fixture Plugin",
    version: "1.0.0",
    compatibility: {
      easyserver: "^0.1.0",
      pluginSdk: "^0.1.0",
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
            operation: "read",
            async run(args, context) {
              context.write(`provider-owned:${args.join("|")}\n`);
            },
          },
          {
            name: "create",
            description: "Create a provider-owned resource",
            operation: "mutation",
            help: {
              arguments: [
                {
                  name: "resource-name",
                  description: "Provider-owned resource name",
                  required: true,
                },
              ],
              options: [
                {
                  name: "--tag",
                  valueName: "value",
                  description: "Provider-owned tag",
                  required: false,
                  repeatable: true,
                },
              ],
              examples: ["gpu-box --tag team --tag demo"],
            },
            async run(_args, context) {
              created = true;
              context.write("created:created-1\n");
              return {
                refreshProviderInventory: true,
                affectedProviderExternalIds: ["created-1"],
              };
            },
          },
          {
            name: "uncertain-create",
            description: "Create a resource with an uncertain response",
            operation: "mutation",
            async run() {
              created = true;
              throw normalizedError(
                "outcome-unknown",
                "fixture mutation outcome is unknown",
              );
            },
          },
        ],
      },
    },
  ],
};
