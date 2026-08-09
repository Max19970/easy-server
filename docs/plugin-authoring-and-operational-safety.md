# Provider Plugin authoring and operational safety

This document is the practical v1 guide for writing, installing and operating an EasyCompute Provider Plugin.

EasyCompute deliberately normalizes only the parts that are genuinely shared across Providers: inventory identity, a small lifecycle vocabulary and caller-facing connectivity. Provider-specific acquisition, configuration and product concepts stay in Provider Features owned by the plugin.

## 1. Package shape

A Provider Plugin is an installable JavaScript/TypeScript module whose default export satisfies the public `@easycompute/plugin-sdk` `ProviderPlugin` contract.

A plugin contributes up to three independent things:

```text
provider          normalized inventory/lifecycle/access discovery
features[]        Provider-specific product functionality
accessAdapters[]  Provider-specific transport implementations
```

The plugin should depend on `@easycompute/plugin-sdk`, not on EasyCompute core internals.

A minimal plugin looks like this:

```ts
import type {
  ProviderAdapter,
  ProviderOperationContext,
  ProviderPlugin,
} from "@easycompute/plugin-sdk";

class ExampleProvider implements ProviderAdapter {
  readonly providerId = "example";

  async listInstances(context: ProviderOperationContext) {
    // Resolve configured provider credentials only when needed.
    const apiKey = await context.resolveCredential("api-key");
    if (apiKey === undefined) {
      throw new Error("api-key is not configured");
    }

    // Honor context.signal in all blocking work.
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
    version: "0.0.0",
    compatibility: {
      easycompute: "*",
      pluginSdk: "*",
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

The manifest Provider ID and `provider.providerId` must agree. IDs are stable API identity, not display text.

## 2. Installing, enabling and disabling

EasyCompute does not scan arbitrary installed packages. A plugin is configured explicitly by module/package specifier or local module path.

```powershell
# Add a package-based plugin.
easycompute plugins add @example/easycompute-provider

# Or add a built local module.
easycompute plugins add .\dist\index.js

# Inspect configured and explicitly requested plugins.
easycompute plugins list
easycompute plugins list --plugin @example/easycompute-provider

# Stop/start new work for the configured module.
easycompute plugins disable @example/easycompute-provider
easycompute plugins enable @example/easycompute-provider
```

Disabling is an admission boundary, not physical module unloading. Once disable linearizes:

- new Provider operations cannot acquire the plugin;
- new Provider Feature invocations cannot acquire it;
- new connection setup cannot acquire it;
- already-admitted work may finish;
- an already-published Connection Session may drain until it is closed.

This lets a plugin be disabled without invalidating objects already owned by in-flight work.

Plugins run in-process and are trusted extensions. Runtime validation and narrow interfaces isolate normal throws/rejections and accidental contract mistakes; they are **not** a security sandbox against malicious code, `process.exit()`, native crashes, process-global corruption or infinite synchronous loops.

## 3. Provider Capabilities and Available Actions

A Provider Capability says that the Provider Adapter implements a normalized operation class at all.

Current normalized Capabilities are:

```text
instance.start
instance.stop
instance.restart
instance.destroy
```

Declare only operations the adapter actually implements. For example, declaring `instance.destroy` requires a `destroy()` adapter method.

A Compute Instance snapshot separately reports `availableActions`. These are the operations that are admissible **for that particular snapshot right now** and must be a subset of manifest Capabilities.

Example:

```ts
{
  providerExternalId: "instance-123",
  state: "running",
  rawState: "ACTIVE",
  availableActions: [
    "instance.stop",
    "instance.restart",
    "instance.destroy",
  ],
}
```

Do not derive per-instance actions in EasyCompute core from the normalized state. The Provider Plugin owns that decision because Providers differ in transitional states, policy and allowed operations.

Always preserve the Provider's raw state next to the normalized state. If the Provider introduces a state the current plugin does not understand, report normalized `state: "unknown"` and preserve the raw value rather than inventing a mapping.

## 4. Provider-specific functionality belongs in Provider Features

Do not create a universal `Offer`, `ProvisionRequest`, server profile or form schema merely because several Providers can create compute.

Examples already exercised by first-party plugins:

- Vast.ai owns marketplace filters, offer search and rental;
- Intelion.cloud owns server configuration validation and creation.

Both acquisition flows converge on the same normalized result: after the remote resource exists, `provider.listInstances()` exposes it as a Compute Instance.

A feature may expose a CLI surface:

```ts
const feature = {
  id: "marketplace",
  displayName: "Marketplace",
  cli: {
    commands: [
      {
        name: "search",
        description: "Search provider offers",
        operation: "read",
        async run(args, context) {
          // Parse Provider-specific args here, not in EasyCompute core.
          context.write("[]\n");
        },
      },
      {
        name: "rent",
        description: "Rent one provider offer",
        operation: "mutation",
        async run(args, context) {
          // Return this when the mutation changes provider inventory.
          return { refreshProviderInventory: true };
        },
      },
    ],
  },
};
```

The shell mounts it as:

```text
easycompute provider <provider-id> <feature-id> <command> [args...]
```

The CLI command must declare `operation: "read" | "mutation"` so the host can apply correct cancellation and uncertainty semantics.

## 5. Operation cancellation, deadlines and uncertain mutations

Every potentially blocking host-invoked Provider, Provider Feature and connection-setup operation receives a host-owned `AbortSignal`.

Plugins must propagate that signal into network/process work and stop cooperatively when possible.

EasyCompute applies a host deadline to blocking operations. A timeout means only that the host stopped waiting; it does **not** prove that a remote mutation rolled back.

Use the normalized distinction:

- `cancelled`: the operation was definitely cancelled before mutation dispatch, or a read was cancelled;
- `timeout`: a read/setup exceeded the host deadline;
- `outcome-unknown`: a mutation may already have been dispatched and the final remote result is unknown.

For a mutation, once dispatch may have happened, transport loss, caller cancellation or host timeout must not be reported as a definite failure unless the Provider supplies proof.

Do not blindly retry `outcome-unknown` mutations. Reconcile by refreshing Provider inventory/state, or use a Provider-specific idempotency mechanism only when the Provider actually supplies one.

For HTTP-style adapters the safe pattern is:

```ts
if (context.signal.aborted) {
  // Before dispatch: definite cancellation.
}

try {
  await fetch(url, { method: "POST", signal: context.signal });
} catch (error) {
  // If the request may have been dispatched, mutation outcome is unknown.
}
```

The same rule applies to Provider Feature acquisition mutations.

## 6. Normalized errors

Provider-facing failures should cross the SDK boundary as normalized EasyCompute errors where a stable category exists.

Current categories include:

```text
authentication
not-found
unsupported-operation
conflict
rate-limited
provider-unavailable
cancelled
timeout
outcome-unknown
plugin-failure
host-trust-required
unknown-provider-error
```

Use a definite code only when the Provider response makes that conclusion definite. A 5xx or post-dispatch transport failure for a mutation is commonly `outcome-unknown`, while the same transport failure for a read is normally `provider-unavailable`.

A failure from one plugin must remain local to that operation. Do not mutate process-global registries, other Providers or another plugin's state as error recovery.

## 7. Credentials and Secret References

Ordinary EasyCompute state must never contain API keys, passwords, private keys or bearer tokens.

Configure a named provider credential by importing it from an environment variable into the OS-backed Secret Store:

```powershell
$env:EXAMPLE_API_KEY = "..."
easycompute plugins credential set @example/easycompute-provider api-key --env EXAMPLE_API_KEY
Remove-Item Env:EXAMPLE_API_KEY
```

EasyCompute persists only an opaque `secret:<uuid>` reference. The plugin resolves the configured credential by its plugin-owned stable name:

```ts
const apiKey = await context.resolveCredential("api-key");
```

To remove it:

```powershell
easycompute plugins credential remove @example/easycompute-provider api-key
```

Do not place secret material in:

- plugin manifests;
- Compute Instance snapshots;
- Access Method discovery results;
- Local State;
- ordinary logs/errors/diagnostics;
- command-line arguments when a safer credential channel exists.

## 8. Access Method is not Endpoint

`getAccessMethods()` describes how EasyCompute *could* reach one Provider resource. It is discovery metadata and must be secret-free.

An Access Method can contain:

- routing metadata such as host/port/username;
- opaque Secret References;
- a Provider-deferred credential source identifier.

It must not contain the resolved password/private key/token itself.

Example SSH descriptor:

```ts
{
  id: "ssh",
  kind: "ssh",
  mode: "tcp-forward",
  credentialSources: [
    { kind: "provider-deferred", id: "ssh-password" },
  ],
  ssh: {
    host: "203.0.113.42",
    port: 22,
    username: "root",
    passwordCredentialId: "ssh-password",
  },
}
```

If a Provider must retrieve a short-lived password only after an Access Method has been selected, implement `resolveAccessCredential()`. EasyCompute calls it inside the connection setup scope, after access discovery.

An Access Adapter turns one supported Access Method kind into transport. Generic transports such as SSH are EasyCompute-owned; a Provider-specific tunnel kind should be contributed by that Provider Plugin in `accessAdapters[]`.

The caller does not consume the Access Method directly. The Connection Gateway publishes an EasyCompute-owned loopback Endpoint:

```text
openEndpoint(instanceId, remotePort, remoteHost = "127.0.0.1")
  -> Endpoint + ConnectionSession
```

The Endpoint is the caller-facing local address. The Connection Session owns the live transport and its cleanup.

Foreground use:

```powershell
easycompute connect <instance-id> --port 8188
```

Persistent local-daemon use:

```powershell
easycompute daemon run
easycompute sessions create <instance-id> --port 8188
easycompute sessions list
easycompute sessions close <session-id>
```

The daemon control channel binds to loopback and uses a separate local authentication token. Live Connection Sessions are daemon-owned in memory; a daemon restart does not pretend dead sessions are still live.

## 9. Access Adapter cleanup

Connection setup creates a session-owned cleanup scope before selected-path credentials or child processes are materialized.

An Access Adapter must register temporary setup-owned material with `context.registerCleanup()` as soon as it is created. That includes temporary private-key/password files, helper processes and Provider-specific tunnel resources.

Cleanup must work for all paths:

- setup failure before Endpoint publication;
- cancellation/deadline during setup;
- local listener publication failure;
- abrupt channel/child-process exit;
- explicit Connection Session close;
- daemon shutdown.

After Endpoint publication, the live Connection Session owns transport/channel lifetime. A setup deadline must not accidentally become a fixed lifetime limit for an already-published Endpoint.

## 10. SSH trust is explicit and fails closed

EasyCompute uses the production OpenSSH client rather than implementing SSH itself.

For a previously unknown host key:

- an interactive foreground `connect` may display the exact fingerprint and ask for explicit confirmation;
- only an explicit confirmation enrolls that exact key and allows one retry;
- declining does not enroll anything;
- daemon/non-interactive connection setup never auto-trusts; it returns typed `host-trust-required` data so an interactive caller can make the decision.

If a previously trusted host presents a different key, connection fails closed as an authentication/trust mismatch. Never silently replace the trusted key.

Passwords and private identities are resolved only after host trust has been established, so first-use trust probing cannot leak them to an untrusted endpoint.

## 11. Lifecycle state is not billing state

Do not infer billing semantics from normalized lifecycle state.

In particular:

```text
stopped != not billed
```

A Provider may continue charging for reserved GPU, disk, IP addresses or the resource itself while compute is stopped. Conversely, a Provider-specific destroy/termination workflow may have asynchronous billing implications.

Keep billing/storage/pricing concepts Provider-owned unless a real cross-provider consumer proves that a shared model is needed.

## 12. Compatibility policy

A plugin manifest declares compatibility independently for EasyCompute and the plugin SDK:

```ts
compatibility: {
  easycompute: "0.0.0",
  pluginSdk: "0.0.0",
}
```

During the private `0.0.0` development phase the host intentionally accepts only an exact current version or `"*"`. This avoids pretending to implement full SemVer ranges before packages are actually versioned and published.

For a published release, use the compatibility range policy documented by that release. Do not depend on undocumented core internals even when the plugin currently runs in-process.

## 13. Author checklist

Before considering a Provider Plugin usable:

1. The manifest and provider adapter pass SDK runtime validation.
2. `providerId` is stable and matches the manifest Provider ID.
3. Every listed `providerExternalId` is stable for the remote resource lifetime.
4. Unknown Provider states map to normalized `unknown` while preserving `rawState`.
5. `availableActions` is a subset of manifest Capabilities and is computed by the plugin.
6. Blocking operations honor the host `AbortSignal`.
7. Post-dispatch mutation uncertainty is reported as `outcome-unknown`, never blindly retried.
8. Provider-specific acquisition/configuration stays in Provider Features.
9. Access discovery is secret-free.
10. Any short-lived access credential is resolved only in session-owned setup scope.
11. Access Adapter temporary resources register cleanup immediately.
12. Plugin disable stops new admission without requiring physical module unloading.
13. Failures remain isolated to the owning operation/plugin.
14. The plugin does not require provider-specific branches or fields in EasyCompute core.
