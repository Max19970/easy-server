# Build a Provider Plugin

EasyServer Provider Plugins add provider-specific compute acquisition and inventory while reusing EasyServer's shared lifecycle, credential, safety, and connection boundaries.

The supported reusable dependency is [`@easyai101/easyserver-plugin-sdk`](../packages/plugin-sdk/README.md). Do not import EasyServer source files or deep `dist/` paths.

This guide gets a small plugin loading. The precise contracts for identity, mutations, cancellation, credentials, access methods, custom transports, cleanup, trust, and compatibility live in [Provider Plugin contracts and operational safety](plugin-reference.md).

## What a plugin can contribute

A plugin can provide three independent extension surfaces:

```text
provider          normalized inventory, lifecycle, and access discovery
features[]        provider-specific product functionality
accessAdapters[]  provider-specific connection transports
```

Only implement the surfaces your provider actually needs. Generic SSH transport, for example, is already built into EasyServer.

## Create the package

A minimal package should be a normal npm package with the SDK as a runtime dependency:

```json
{
  "name": "@example/easyserver-provider",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "easyserver": {
    "kind": "provider-plugin",
    "displayName": "Example Provider"
  },
  "dependencies": {
    "@easyai101/easyserver-plugin-sdk": "^0.2.0"
  }
}
```

The `easyserver` package metadata lets the TUI discover an installed provider by human name without importing the provider runtime just to populate the picker.

The repository also includes a small third-party-style scaffold at [`examples/minimal-provider-plugin`](../examples/minimal-provider-plugin).

## Export a `ProviderPlugin`

A plugin's default export satisfies the public `ProviderPlugin` contract:

```ts
import type {
  ProviderAdapter,
  ProviderOperationContext,
  ProviderPlugin,
} from "@easyai101/easyserver-plugin-sdk";

class ExampleProvider implements ProviderAdapter {
  readonly providerId = "example";

  async listInstances(context: ProviderOperationContext) {
    const apiKey = await context.resolveCredential("api-key");
    if (apiKey === undefined) {
      throw new Error("api-key is not configured");
    }

    // Fetch provider inventory and honor context.signal.
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
    credentials: [
      {
        name: "api-key",
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
};

export default plugin;
```

The manifest provider ID and `provider.providerId` must match. Treat provider/plugin/resource IDs as stable machine identity, not display text.

## Model inventory conservatively

EasyServer normalizes a small shared lifecycle vocabulary, but the plugin owns the mapping from provider state.

Important rules:

- `providerExternalId` must stay stable for the lifetime of the same remote resource;
- preserve the provider's raw state next to the normalized state;
- map unknown provider states to normalized `unknown` instead of guessing;
- `availableActions` is provider-owned and must be a subset of declared capabilities;
- `getInstance()` returns `undefined` only when the provider authoritatively confirms the resource no longer exists.

Authentication failures, rate limits, provider outages, transport failures, or eventual-consistency gaps are not authoritative deletion evidence.

## Keep provider-specific product concepts in Provider Features

Do not invent a universal Offer, flavor, image, price, or provisioning request in EasyServer core.

Provider Features own product-specific functionality such as:

- Vast.ai marketplace search/rental;
- Intelion.cloud server configuration/creation;
- catalog, pricing, image, region, or queue operations unique to another provider.

A feature command declares whether it is a read or mutation, and risky mutations can truthfully declare `billable` or `destructive` risk. EasyServer owns the confirmation UI and non-interactive authorization policy.

When a confirmed feature mutation creates or affects compute, return stable provider resource IDs in `affectedProviderExternalIds` so EasyServer can reconcile them into canonical server identity without teaching core the provider's product schema.

See [Provider Features and acquisition handoff](plugin-reference.md#provider-features-and-acquisition-handoff).

## Declare credentials; resolve them only when needed

Declare plugin-owned credential names in `manifest.credentials` so EasyServer can validate setup and show readiness without reading the secret.

Resolve a configured value through the operation context:

```ts
const apiKey = await context.resolveCredential("api-key");
```

Never place raw API keys, passwords, private keys, bearer tokens, or equivalent secrets in manifests, snapshots, access discovery, ordinary errors, or Local State.

See [Credentials and Secret References](plugin-reference.md#credentials-and-secret-references).

## Reuse EasyServer connection transports when possible

If the provider can be reached through generic SSH, return a secret-free SSH Access Method from the provider and let EasyServer's built-in adapter own the transport.

Only contribute `accessAdapters[]` when the provider genuinely needs a provider-specific tunnel kind.

Access discovery describes **how a server may be reached**. The final local `127.0.0.1:<port>` Endpoint is EasyServer-owned runtime state and is not part of provider inventory identity.

See [Access Methods, adapters, and Endpoints](plugin-reference.md#access-methods-adapters-and-endpoints).

## Respect cancellation and mutation uncertainty

Blocking provider/feature/access work receives a host-owned `AbortSignal`; propagate it into network/process operations.

Before the first remote side-effecting request can leave the process, a mutation must call `context.markMutationDispatched()`.

This lets EasyServer distinguish:

- cancellation before dispatch;
- read/setup timeout;
- a mutation whose final remote outcome is unknown after dispatch.

Never turn a post-dispatch transport loss into a definite failure unless the provider proves the result. Do not blindly retry `outcome-unknown` billable or destructive operations; observe/reconcile instead.

See [Cancellation, deadlines, and uncertain mutations](plugin-reference.md#cancellation-deadlines-and-uncertain-mutations).

## Add side-effect-free CLI help

Package-based providers can expose declarative provider help from the dedicated `./easyserver-help` subpath. That module must remain side-effect-free: it must not resolve credentials, contact provider APIs, mutate EasyServer state, or execute provider commands.

This lets users inspect:

```text
easyserver provider <provider-id> --help
easyserver provider <provider-id> <feature-id> --help
easyserver provider <provider-id> <feature-id> <command> --help
```

without importing the executable provider runtime only to render help.

The exact `ProviderCliHelpContribution` contract and export example are in [Provider Plugin contracts and operational safety](plugin-reference.md#provider-features-and-acquisition-handoff).

## Install and test the packed plugin

Test the artifact users will install:

```powershell
npm pack
npm install --global .\your-plugin-0.2.0.tgz
easyserver plugins add @example/easyserver-provider
easyserver plugins list
```

A plugin should work from an installed package layout that contains no EasyServer source checkout.

Before publishing, also verify:

- compatibility ranges match the host/SDK lines you tested;
- malformed/unknown provider states fail conservatively;
- read and mutation cancellation behave correctly;
- secrets do not enter public state/errors;
- provider-specific behavior stays out of EasyServer core;
- temporary transport material is cleaned on every exit path.

Use the full [author checklist](plugin-reference.md#author-checklist) before treating a provider as production-ready.
