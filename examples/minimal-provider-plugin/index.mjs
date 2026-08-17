import { PLUGIN_SDK_VERSION } from "@easyai101/easyserver-plugin-sdk";

const EXAMPLE_EXTERNAL_ID = "example-instance";
const API_KEY_CREDENTIAL = "api-key";

class ExampleProvider {
  providerId = "example";

  async listInstances(context) {
    // Real providers normally authenticate inside the operation that needs it.
    // EasyServer returns undefined when this named credential is not configured.
    const apiKey = await context.resolveCredential(API_KEY_CREDENTIAL);
    void apiKey;
    return [exampleInstance()];
  }

  async getInstance(providerExternalId, context) {
    void context;
    return providerExternalId === EXAMPLE_EXTERNAL_ID
      ? exampleInstance()
      : undefined;
  }

  async getAccessMethods(providerExternalId, context) {
    void context;
    if (providerExternalId !== EXAMPLE_EXTERNAL_ID) {
      return [];
    }

    // Generic SSH transport is host-owned, so this plugin contributes the
    // secret-free Access Method and does not reimplement an SSH Access Adapter.
    return [
      {
        id: "ssh",
        kind: "ssh",
        mode: "tcp-forward",
        ssh: {
          host: "127.0.0.1",
          port: 22,
          username: "example",
        },
      },
    ];
  }
}

function exampleInstance() {
  return {
    providerExternalId: EXAMPLE_EXTERNAL_ID,
    name: "Example instance",
    state: "running",
    rawState: "READY",
    availableActions: [],
  };
}

export default {
  manifest: {
    id: "example.provider-plugin",
    displayName: "Example Provider",
    version: "0.2.1",
    compatibility: {
      easyserver: "^0.2.0",
      pluginSdk: `^${PLUGIN_SDK_VERSION}`,
    },
    credentials: [
      {
        name: API_KEY_CREDENTIAL,
        required: true,
        description: "Example Provider API key",
      },
    ],
    provider: {
      id: "example",
      displayName: "Example Provider",
      capabilities: [],
    },
  },
  provider: new ExampleProvider(),
  features: [
    {
      id: "catalog",
      displayName: "Example Catalog",
      cli: {
        commands: [
          {
            name: "show",
            description: "Show one provider-owned example offer",
            operation: "read",
            async run(_args, context) {
              context.write("example-offer gpu=ExampleGPU price=0.00\n");
            },
          },
        ],
      },
    },
  ],
};
