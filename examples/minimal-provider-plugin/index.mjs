import { PLUGIN_SDK_VERSION } from "@easycompute/plugin-sdk";

class ExampleProvider {
  providerId = "example";

  async listInstances(context) {
    // A real provider would resolve credentials and use context.signal here.
    void context;
    return [];
  }

  async getInstance(providerExternalId, context) {
    void providerExternalId;
    void context;
    return undefined;
  }
}

export default {
  manifest: {
    id: "example.provider-plugin",
    displayName: "Example Provider",
    version: "0.1.0",
    compatibility: {
      easycompute: "^0.1.0",
      pluginSdk: `^${PLUGIN_SDK_VERSION}`,
    },
    provider: {
      id: "example",
      displayName: "Example Provider",
      capabilities: [],
    },
  },
  provider: new ExampleProvider(),
};
