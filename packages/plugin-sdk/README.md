# @easyai101/easyserver-plugin-sdk

Public TypeScript/runtime contracts for building EasyServer Provider Plugins.

This is the supported reusable EasyServer programmatic dependency in `0.2.x`. The `@easyai101/easyserver` package itself is a CLI/TUI product, not a general-purpose library API.

## Install

```powershell
npm install @easyai101/easyserver-plugin-sdk
```

Import only from the package root:

```ts
import type {
  ProviderAdapter,
  ProviderOperationContext,
  ProviderPlugin,
} from "@easyai101/easyserver-plugin-sdk";
```

A minimal provider can be as small as:

```ts
class ExampleProvider implements ProviderAdapter {
  readonly providerId = "example";

  async listInstances(_context: ProviderOperationContext) {
    return [];
  }

  async getInstance(_providerExternalId: string, _context: ProviderOperationContext) {
    return undefined;
  }
}

const plugin: ProviderPlugin = {
  manifest: {
    id: "example.provider-plugin",
    displayName: "Example Provider",
    version: "0.2.0",
    compatibility: {
      easyserver: "^0.2.0",
      pluginSdk: "^0.2.0",
    },
    provider: {
      id: "example",
      displayName: "Example Provider",
      capabilities: [],
    },
  },
  provider: new ExampleProvider(),
};

export default plugin;
```

For TypeScript 6 Node projects, include Node ambient types in the consumer `tsconfig.json` when required (for example `"types": ["node"]`). The SDK's public access-channel contract uses Node's exact `node:stream.Duplex` type.

Provider Plugins declare separate EasyServer and Plugin SDK SemVer compatibility ranges. Source-file paths and `dist/` deep imports are not supported public APIs.

Read next:

- [Build a Provider Plugin](https://github.com/Max19970/easy-server/blob/main/docs/plugin-authoring.md)
- [Создание плагина провайдера — русский перевод](https://github.com/Max19970/easy-server/blob/main/docs/ru/plugin-authoring.md)
- [Provider Plugin contracts and operational safety](https://github.com/Max19970/easy-server/blob/main/docs/plugin-reference.md)
- [Minimal Provider Plugin example](https://github.com/Max19970/easy-server/tree/main/examples/minimal-provider-plugin)
