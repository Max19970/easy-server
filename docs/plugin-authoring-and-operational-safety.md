# Provider Plugin authoring and operational safety

This document is the practical guide for writing, installing and operating an EasyServer Provider Plugin. Version and compatibility promises are defined in [`versioning-and-compatibility.md`](versioning-and-compatibility.md).

EasyServer deliberately normalizes only the parts that are genuinely shared across Providers: inventory identity, a small lifecycle vocabulary and caller-facing connectivity. Provider-specific acquisition, configuration and product concepts stay in Provider Features owned by the plugin.

## 1. Package shape

A Provider Plugin is an installable JavaScript/TypeScript module whose default export satisfies the public `@easyai101/easyserver-plugin-sdk` `ProviderPlugin` contract.

A plugin contributes up to three independent things:

```text
provider          normalized inventory/lifecycle/access discovery
features[]        Provider-specific product functionality
accessAdapters[]  Provider-specific transport implementations
```

The plugin should depend on `@easyai101/easyserver-plugin-sdk`, not on EasyServer core internals. A minimal npm package starts with the SDK as a normal runtime dependency:

```json
{
  "name": "@example/easyserver-provider",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "dependencies": {
    "@easyai101/easyserver-plugin-sdk": "^0.1.0"
  }
}
```

The repository includes a tested third-party-style scaffold at [`examples/minimal-provider-plugin`](../examples/minimal-provider-plugin). Its package is deliberately marked `private` only to prevent accidental publication of the example name; choose your own package name and remove that flag when publishing a real plugin.

A minimal plugin looks like this:

```ts
import type {
  ProviderAdapter,
  ProviderOperationContext,
  ProviderPlugin,
} from "@easyai101/easyserver-plugin-sdk";

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
    version: "0.1.0",
    compatibility: {
      easyserver: "^0.1.0",
      pluginSdk: "^0.1.0",
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

The manifest Provider ID and `provider.providerId` must agree. IDs are stable API identity, not display text.

`manifest.credentials` is optional for backward compatibility, but new plugins should declare every plugin-owned name that may be passed to `context.resolveCredential(name)`. Names are stable machine identity; `required` describes setup readiness, and `description` is secret-free user guidance. Do not put example secret values, account-specific identifiers or transport/auth payloads in these descriptors.

`ProviderAdapter.getInstance()` has one deletion boundary: return `undefined` only when the provider can authoritatively confirm that the requested resource no longer exists. Authentication failures, rate limits, transport failures, provider outages, eventual-consistency gaps and other inconclusive lookups must reject with an appropriate normalized error instead. EasyServer preserves the canonical `instance:<uuid>` binding across those uncertain failures; a definitive `undefined` may remove it. The same rule applies to inspect, lifecycle preflight and post-mutation reconciliation.

## 2. Installing, enabling and disabling

EasyServer does not scan arbitrary installed packages. Installing a package and registering it with EasyServer are intentionally separate actions: installation puts the module in the CLI's module-resolution environment; `plugins add` validates and persists the plugin registration.

For a global CLI installation, install the plugin globally as well:

```powershell
npm install --global @example/easyserver-provider

# Register the installed package with EasyServer.
easyserver plugins add @example/easyserver-provider

# Or add a built local module.
easyserver plugins add .\dist\index.js

# Inspect configured and explicitly requested plugins.
easyserver plugins list
easyserver plugins list --plugin @example/easyserver-provider

# Stop/start new work for the configured module.
easyserver plugins disable @example/easyserver-provider
easyserver plugins enable @example/easyserver-provider
```

Disabling is an admission boundary, not physical module unloading. Once disable linearizes:

- new Provider operations cannot acquire the plugin;
- new Provider Feature invocations cannot acquire it;
- new connection setup cannot acquire it;
- already-admitted work may finish;
- an already-published Connection Session may drain until it is closed.

This lets a plugin be disabled without invalidating objects already owned by in-flight work.

Plugins run in-process and are trusted extensions. Runtime validation and narrow interfaces isolate normal throws/rejections and accidental contract mistakes. Async plugin loading is bounded by a host-owned deadline so a never-settling import cannot block later configured plugins, but this does **not** preempt plugin code that synchronously blocks the Node.js thread. EasyServer is **not** a security sandbox against malicious code, `process.exit()`, native crashes, process-global corruption or infinite synchronous loops.

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

Do not derive per-instance actions in EasyServer core from the normalized state. The Provider Plugin owns that decision because Providers differ in transitional states, policy and allowed operations.

Always preserve the Provider's raw state next to the normalized state. If the Provider introduces a state the current plugin does not understand, report normalized `state: "unknown"` and preserve the raw value rather than inventing a mapping.

`providerExternalId` must be the Provider's stable identity for the same remote resource across repeated inventory reads. Do not derive it from display names, list positions or mutable metadata. EasyServer reconciles refreshed Provider inventory against that identity so local instance identity can survive state changes and process restarts. A complete successful provider refresh may remove a binding that is genuinely absent; an uncertain mutation should instead be followed by reconciliation rather than inventing a new identity or assuming deletion.

EasyServer serializes full inventory refreshes for the same Provider from the remote `listInstances()` observation through Local State reconciliation. A later same-Provider refresh waits rather than overtaking an older in-flight observation, so snapshots cannot commit out of order across processes. Different Providers use independent refresh locks and are free to observe concurrently.

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
          // Parse Provider-specific args here, not in EasyServer core.
          context.write("[]\n");
        },
      },
      {
        name: "rent",
        description: "Rent one provider offer",
        operation: "mutation",
        risks: ["billable"],
        help: {
          arguments: [
            {
              name: "offer-id",
              description: "Provider marketplace offer ID",
              required: true,
            },
          ],
          options: [
            {
              name: "--image",
              valueName: "image",
              description: "Provider-compatible image",
              required: true,
            },
          ],
          examples: ["123 --image example/image:latest"],
        },
        async run(args, context) {
          const rental = await rentProviderOffer(args, context);
          return {
            refreshProviderInventory: true,
            affectedProviderExternalIds: [rental.providerExternalId],
          };
        },
      },
    ],
  },
};
```

The shell mounts it as:

```text
easyserver provider <provider-id> <feature-id> <command> [args...]
```

The CLI command must declare `operation: "read" | "mutation"` so the host can apply correct cancellation and uncertainty semantics.

Risky mutations may additionally declare host-owned `risks: ["billable" | "destructive", ...]`. Do this only when explicit user consent is warranted; ordinary reversible mutations should not gain confirmation prompts merely because they mutate state. EasyServer owns the confirmation policy and non-interactive `--yes` opt-in, while the plugin owns only the truthful risk classification. Risk metadata is valid only on mutation commands.

Commands may also declare lightweight `help` metadata for positional arguments, options and examples. This metadata is descriptive only: Provider Plugins still own argument parsing and semantics, and EasyServer does not reinterpret it as a universal provisioning schema. When metadata exists, users can run:

```text
easyserver provider <provider-id> <feature-id> <command> --help
```

The host renders that help without calling the command's `run()` function, so asking for help never dispatches Provider work or a mutation. Plugins without `help` metadata remain compatible; EasyServer shows the command description plus a `[provider-args...]` fallback instead of inventing argument details.

### Acquisition handoff to canonical EasyServer identity

When a successful Provider Feature mutation creates, rents or otherwise affects one or more compute resources that should enter normalized EasyServer inventory, return their stable Provider identities in `affectedProviderExternalIds`.

```ts
return {
  refreshProviderInventory: true,
  affectedProviderExternalIds: [result.providerExternalId],
};
```

This field is deliberately narrow. It identifies affected Provider resources for host reconciliation; it is **not** a universal provisioning result and must not grow provider-specific pricing, image, region or configuration fields. Keep those details in the Provider-owned feature result/output.

After the command itself resolves successfully, EasyServer treats the remote mutation as confirmed successful. It durably records management intent for the returned affected Provider identities, then may refresh that Provider's inventory and match each affected Provider ID to the canonical `instance:<uuid>` produced by normal reconciliation. A successful handoff can therefore be used immediately with `instances inspect`, lifecycle commands or `connect` without making the caller rediscover which local identity belongs to the newly acquired resource. If the first refresh fails, the pending management intent survives so a later observation still classifies that acquired resource as `managed` rather than merely `discovered`.

Mutation outcome and handoff outcome are separate:

- if the mutation itself is uncertain after dispatch, it remains `outcome-unknown`; the host may observe inventory, but it does not claim the mutation succeeded;
- if the mutation resolves successfully and the follow-up inventory refresh fails, the mutation **remains successful** and the handoff is reported as failed/pending rather than `outcome-unknown`;
- if refresh succeeds but one affected Provider ID is not yet visible, the handoff is partial and that ID remains unresolved until a later observation;
- a later `instances list`/refresh may complete reconciliation without redispatching the acquisition mutation.

For multiple affected resources, preserve Provider-returned order. Each ID is reconciled independently; duplicate or empty IDs are invalid command results. Do not tell users or calling code to repeat a confirmed rent/create merely to obtain a canonical ID. Recovery is **Observe / Refresh / Wait**, because blindly repeating a billable mutation can create duplicate paid resources.

Provider inventory itself does not decide ownership. A resource that merely appears in `listInstances()` without matching explicit EasyServer acquisition/adoption intent is normalized as `management=discovered`. Provider Plugins must not fabricate an EasyServer-managed flag in snapshots. Users may explicitly adopt such a canonical instance through the host; adoption preserves its `instance:<uuid>` identity. EasyServer blocks destructive `instance.destroy` for discovered resources until that host-owned management intent exists, while provider-declared reversible power availability remains snapshot-owned.

## 5. Operation cancellation, deadlines and uncertain mutations

Every potentially blocking host-invoked Provider, Provider Feature and connection-setup operation receives a host-owned `AbortSignal`.

Plugins must propagate that signal into network/process work and stop cooperatively when possible. Provider operation contexts also expose `markMutationDispatched()`. A mutation transport **must** call this idempotent marker synchronously immediately before the first remote side-effecting request may be sent, after credential resolution and other preflight work. Read operations must not call it.

EasyServer applies a host deadline to blocking operations. A timeout means only that the host stopped waiting; it does **not** prove that a remote mutation rolled back. The dispatch marker is how the host distinguishes a cancellation/deadline that happened during local preflight from one that happened after a remote mutation may have escaped.

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
  context.markMutationDispatched();
  await fetch(url, { method: "POST", signal: context.signal });
} catch (error) {
  // If the request may have been dispatched, mutation outcome is unknown.
}
```

The same rule applies to Provider Feature acquisition mutations.

## 6. Normalized errors

Provider-facing failures should cross the SDK boundary as normalized EasyServer errors where a stable category exists.

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

The normalized `message` may retain a concise provider-originated reason when the plugin can recognize and sanitize it safely. First-party HTTP plugins establish the intended boundary:

- inspect only bounded error payloads, not arbitrary unbounded bodies;
- accept only explicitly recognized JSON reason fields/shapes;
- bound the final user-facing detail independently of the input-body bound;
- reject HTML, malformed payloads and credential-like material rather than trying to render it;
- compare against the credential resolved for the request so echoed API keys/tokens cannot enter the message;
- keep the normalized EasyServer error code primary and retain the stable generic message when safe detail is unavailable;
- never attach raw response bodies, HTTP headers or resolved secret-bearing causes for normal CLI rendering.

Provider-specific payload parsing remains inside the provider plugin. Do not add provider branches to the CLI simply to interpret a provider's error schema.

A failure from one plugin must remain local to that operation. Do not mutate process-global registries, other Providers or another plugin's state as error recovery.

## 7. Credentials and Secret References

Ordinary EasyServer state must never contain API keys, passwords, private keys or bearer tokens.

Configure a named provider credential by importing it from an environment variable into the OS-backed Secret Store:

```powershell
$env:EXAMPLE_API_KEY = "..."
easyserver plugins credential set @example/easyserver-provider api-key --env EXAMPLE_API_KEY
Remove-Item Env:EXAMPLE_API_KEY
```

EasyServer persists only an opaque `secret:<uuid>` reference. When a plugin declares `manifest.credentials`, `plugins credential set/remove` rejects unknown names before changing the Secret Store; this catches spelling mistakes such as `api-kye` before the first provider request. Plugins that omit credential metadata retain the `0.1.x` legacy behavior and may still use arbitrary non-empty names.

`easyserver plugins list` derives readiness from configured **Secret References only**. A missing required binding appears as `credentials=missing:<name>`; when every required descriptor has a configured reference it appears as `credentials=ready`. Readiness does not resolve or display the secret value, and optional credentials do not make an otherwise configured plugin unready.

The plugin resolves the configured credential by its plugin-owned stable name:

```ts
const apiKey = await context.resolveCredential("api-key");
```

To remove it:

```powershell
easyserver plugins credential remove @example/easyserver-provider api-key
```

Do not place secret material in:

- plugin manifests;
- Compute Instance snapshots;
- Access Method discovery results;
- Local State;
- ordinary logs/errors/diagnostics;
- command-line arguments when a safer credential channel exists.

## 8. Access Method is not Endpoint

`getAccessMethods()` describes how EasyServer *could* reach one Provider resource. It is discovery metadata and must be secret-free.

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

If a Provider must retrieve a short-lived password only after an Access Method has been selected, implement `resolveAccessCredential()`. EasyServer calls it inside the connection setup scope, after access discovery.

An Access Adapter turns one supported Access Method kind into transport. Generic transports such as SSH are EasyServer-owned; a Provider-specific tunnel kind should be contributed by that Provider Plugin in `accessAdapters[]`.

Callers may discover a sanitized Access Method descriptor containing only `id`, `kind` and `mode`; credential sources and Secret References remain inside the connection boundary. Only methods with a resolvable TCP-forward Access Adapter are advertised. If no ID is requested, the Connection Gateway deterministically selects the lexicographically smallest supported Access Method ID rather than depending on provider array order. An explicitly requested unavailable ID fails without fallback.

The Connection Gateway then publishes an EasyServer-owned loopback Endpoint and records the selected descriptor:

```text
openEndpoint(instanceId, remotePort, remoteHost = "127.0.0.1", ..., accessMethodId?)
  -> Endpoint + selected Access Method + ConnectionSession
```

The Endpoint is the caller-facing local address. The Connection Session owns the live transport and its cleanup. Provider Plugins continue to own the actual Access Method semantics and adapter contributions; core only performs generic discovery/selection.

Foreground use:

```powershell
easyserver connect <instance-id> --port 8188
```

Persistent local-daemon use:

```powershell
easyserver daemon run
easyserver sessions create <instance-id> --port 8188
easyserver sessions list
easyserver sessions close <session-id>
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

EasyServer uses the production OpenSSH client rather than implementing SSH itself.

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

A plugin manifest declares compatibility independently for EasyServer and the plugin SDK:

```ts
compatibility: {
  easyserver: "^0.1.0",
  pluginSdk: "^0.1.0",
}
```

From the first `0.1.0` release onward, compatibility strings are standard SemVer ranges. The host checks the running EasyServer and plugin-SDK versions with SemVer range semantics before registering the plugin. Invalid ranges and ranges that exclude the running version fail plugin loading without replacing healthy registrations.

For the `0.x` line, remember that caret ranges are intentionally narrow: `^0.1.0` accepts compatible `0.1.x` releases but not `0.2.0`. Widen a range only after testing the plugin against that SDK/host line. `"*"` remains syntactically valid but should be reserved for development fixtures rather than published plugins.

Do not depend on undocumented core internals even when the plugin currently runs in-process.

## 13. Validate the packaged plugin

Validate the same artifact users will install, not only a source-tree import. At minimum:

```powershell
npm pack
npm install --global .\your-plugin-0.1.0.tgz
easyserver plugins add @example/easyserver-provider
easyserver plugins list
```

The EasyServer release gate performs this style of external-layout verification for the repository's minimal example: it packs the SDK, CLI and [`examples/minimal-provider-plugin`](../examples/minimal-provider-plugin), installs them into an isolated global npm prefix outside the monorepo, then proves the example loads through `plugins add` without any core/internal import. Use that example as an executable reference for the package/manifest shape described above.

For richer Provider behavior, adapt the same public seams and use the SDK's runtime validators/contract tests rather than importing host internals. A plugin should remain loadable when developed in a repository that contains no EasyServer source tree at all.

## 14. Author checklist

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
14. The plugin does not require provider-specific branches or fields in EasyServer core.
