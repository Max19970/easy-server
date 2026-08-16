# Provider Plugin contracts and operational safety

This is the dense reference for EasyServer Provider Plugin behavior in the `0.2.x` compatibility line. Start with [Build a Provider Plugin](plugin-authoring.md) if you are writing your first provider.

The public TypeScript/runtime contracts come from [`@easyai101/easyserver-plugin-sdk`](../packages/plugin-sdk/README.md). The broader compatibility policy is [Versioning and compatibility](versioning-and-compatibility.md).

EasyServer normalizes only the concepts that are genuinely shared across providers: stable server identity, a small lifecycle vocabulary, and caller-facing connectivity. Provider-specific marketplace/configuration/product semantics stay inside Provider Features.

## Package and manifest identity

A provider package normally exposes a default `ProviderPlugin` export and declares TUI discovery metadata in `package.json`:

```json
{
  "easyserver": {
    "kind": "provider-plugin",
    "displayName": "Example Provider"
  }
}
```

Package metadata is discovery-only. EasyServer can show an installed package in **Add installed provider** without importing the executable runtime. Actual registration still goes through the normal validation/import path after the user chooses the package.

A plugin manifest declares stable identity and compatibility:

```ts
{
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
}
```

`manifest.provider.id` and `provider.providerId` must match. IDs are stable machine identity; display names are not.

Plugins run in-process with the current OS user's privileges. Contract validation is not a malicious-code sandbox. Installing/registering an untrusted plugin is equivalent to running untrusted Node.js code as that user.

## Provider inventory and lifecycle

### Stable provider identity

Each provider snapshot uses `providerExternalId` as the provider's stable identity for the same remote resource across repeated reads. Do not derive it from list position, display name, transient IP, or mutable metadata.

EasyServer reconciles that provider identity into its own canonical `instance:<uuid>` identity.

### `getInstance()` deletion boundary

`ProviderAdapter.getInstance()` returns `undefined` only when the provider can authoritatively confirm that the requested remote resource no longer exists.

Do not return `undefined` for:

- authentication failure;
- rate limiting;
- provider outage;
- network/transport failure;
- timeout;
- eventual-consistency gap;
- an unknown provider response.

Those cases must reject with an appropriate normalized failure. Inconclusive reads must not silently delete canonical EasyServer identity.

### Capabilities vs available actions

Manifest capabilities say which normalized operation classes the provider implements at all:

```text
instance.start
instance.stop
instance.restart
instance.destroy
```

A particular server snapshot separately declares `availableActions` for what is valid **right now**. The plugin owns this decision, and `availableActions` must be a subset of manifest capabilities.

Do not derive actions centrally from normalized state. Providers differ in transition rules and policy.

Preserve the provider's raw state next to the normalized state. When a provider introduces an unknown value, use normalized `unknown` and keep the raw value instead of inventing a mapping.

### Inventory refresh ordering

EasyServer serializes complete inventory refresh/reconciliation for the same provider so an older in-flight observation cannot commit after a newer same-provider observation. Different providers remain independent.

A complete authoritative refresh may remove a truly absent binding. Partial/failed observation must not be treated as proof of absence.

## Management intent and destructive ownership

Provider visibility is not destructive ownership.

A resource that merely appears in provider inventory is `management=discovered` unless it matches explicit EasyServer acquisition/adoption intent. Provider snapshots do not declare an EasyServer-managed flag.

Successful EasyServer acquisition records management intent for the affected provider identities. Users can also explicitly adopt a discovered canonical instance without recreating it.

EasyServer blocks destructive `instance.destroy` for discovered resources until host-owned management intent exists. Reversible provider-declared actions remain governed by the current snapshot.

## Provider Features and acquisition handoff

Provider-specific product concepts belong in Provider Features, not in EasyServer core.

A feature CLI command declares:

- stable command name/description;
- `operation: "read" | "mutation"`;
- optional host-owned risk metadata (`billable`, `destructive`) for mutations;
- optional declarative help metadata;
- executable `run(args, context)` logic owned by the provider.

The host mounts commands under:

```text
easyserver provider <provider-id> <feature-id> <command> [args...]
```

EasyServer owns confirmation policy for risky mutations. The plugin only classifies the risk truthfully.

### CLI usage errors

When provider-specific CLI arguments are malformed, throw the SDK's `providerCliUsageError(message)`. Use it only for command-usage problems, not authentication/provider outages/remote API failures/mutation outcomes.

### Side-effect-free provider help

Package-based providers can expose `ProviderCliHelpContribution` from `./easyserver-help`:

```ts
import type { ProviderCliHelpContribution } from "@easyai101/easyserver-plugin-sdk";

export const easyserverCliHelp: ProviderCliHelpContribution = {
  pluginId: "example.provider-plugin",
  providerId: "example",
  displayName: "Example Provider",
  features: [
    {
      id: "marketplace",
      displayName: "Marketplace",
      commands: [
        {
          name: "rent",
          description: "Rent one provider offer",
          operation: "mutation",
          risks: ["billable"],
        },
      ],
    },
  ],
};
```

Expose it independently of the executable entry point:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./easyserver-help": "./dist/easyserver-help.js"
  }
}
```

Evaluating this help-only module must not resolve credentials, read secrets, contact provider APIs, mutate EasyServer Local State, or dispatch provider work. Help command objects are declarative; executable `run` functions are rejected at this boundary.

### Acquisition handoff

When a confirmed Provider Feature mutation creates/rents/affects compute that should enter shared inventory, return stable provider identities:

```ts
return {
  refreshProviderInventory: true,
  affectedProviderExternalIds: [result.providerExternalId],
};
```

`affectedProviderExternalIds` is intentionally narrow. Do not put provider pricing, image, region, flavor, or other product schema into it.

Once the provider mutation itself resolves successfully, EasyServer treats that mutation as confirmed. It records management intent for the affected provider IDs and can refresh inventory to reconcile them into canonical EasyServer identities.

Mutation outcome and handoff outcome remain separate:

- mutation uncertain after dispatch → `outcome-unknown`;
- mutation confirmed, refresh fails → mutation stays successful; handoff remains pending/failed;
- refresh succeeds but an affected resource is not visible yet → partial handoff;
- a later inventory refresh can complete reconciliation without repeating the mutation.

For multiple affected resources, preserve provider-returned order. Empty/duplicate IDs are invalid results.

## Cancellation, deadlines, and uncertain mutations

Every potentially blocking host-invoked provider, feature, and connection-setup operation receives a host-owned `AbortSignal`. Propagate it into network/process work and stop cooperatively where possible.

A mutation context additionally exposes `markMutationDispatched()`.

Call that marker idempotently **immediately before** the first remote side-effecting request may be sent, after credential resolution and local preflight. Read operations must not call it.

The host uses this boundary to distinguish:

- `cancelled` — read cancelled or mutation definitely stopped before dispatch;
- `timeout` — read/setup exceeded its deadline;
- `outcome-unknown` — mutation may already have been dispatched but the final remote result is not trustworthy.

A timeout/cancellation after dispatch does not prove the provider rolled back. Transport loss after dispatch should not be reported as definite mutation failure unless the provider supplies proof.

Never blindly retry an `outcome-unknown` billable/destructive mutation. Reconcile provider state or use a real provider idempotency mechanism when one exists.

## Normalized errors

Use a normalized EasyServer error category when the provider evidence justifies one:

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

Provider-specific HTTP/payload parsing stays in the provider plugin.

When including provider-originated detail in a public error:

- inspect only bounded payloads;
- accept only explicitly recognized shapes/fields;
- bound the final message separately;
- reject HTML, malformed payloads, secret-like data, or echoed configured credentials;
- do not attach raw response bodies/headers/secret-bearing causes for normal rendering.

A stable generic message is better than leaking an unsafe provider response.

## Credentials and Secret References

Declare provider-owned credential names in `manifest.credentials` when possible:

```ts
credentials: [
  {
    name: "api-key",
    required: true,
    description: "Example Provider API key",
  },
]
```

EasyServer can then validate names and report readiness from configured **Secret References** without resolving the values.

A plugin resolves the named credential only inside an operation:

```ts
const apiKey = await context.resolveCredential("api-key");
```

Ordinary EasyServer state must never contain raw:

- API keys/tokens;
- passwords;
- private keys;
- bearer tokens.

Do not put secret material in manifests, instance snapshots, Access Methods, Local State, normal logs/errors/Diagnostics, or provider command arguments when a safer credential channel exists.

## Access Methods, adapters, and Endpoints

`getAccessMethods()` describes how EasyServer **could reach** a provider resource. Discovery must stay secret-free.

An Access Method may contain routing metadata, opaque Secret References, or provider-deferred credential IDs, but not the resolved secret itself.

Example:

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

If a provider needs to fetch a short-lived credential only after a method is selected, implement `resolveAccessCredential()`.

An Access Adapter turns one supported method kind into transport. Generic SSH is EasyServer-owned; contribute a custom adapter only for a genuinely provider-specific tunnel kind.

Caller-facing method discovery is sanitized. Credential sources and Secret References stay inside the connection boundary.

If no method ID is requested, EasyServer deterministically chooses the supported method with the lexicographically smallest stable ID. An explicitly requested unavailable ID fails instead of silently falling back.

The local Endpoint is separate runtime state:

```text
Provider Access Method → Access Adapter → 127.0.0.1:<local-port>
```

Provider identity must not depend on that local port.

## Access Adapter cleanup

Connection setup creates a cleanup scope before selected-path credentials or child processes are materialized.

Custom adapters must register setup-owned resources with `context.registerCleanup()` as soon as they are created, including temporary credential files, helpers, child processes, and provider-specific tunnel resources.

Cleanup must cover:

- setup failure before local Endpoint publication;
- cancellation/deadline during setup;
- local listener publication failure;
- abrupt channel/process exit;
- explicit Session close;
- daemon shutdown.

Once the local Endpoint is published, the live Session owns transport/channel lifetime. A setup deadline must not accidentally become a hard maximum lifetime for the already-published connection.

## SSH trust

EasyServer's built-in SSH path uses the system OpenSSH client and its own trust store.

First-use host trust is explicit:

- EasyServer observes the preferred host key and exposes exact host/port/key type/SHA-256 fingerprint evidence;
- interactive callers can review/approve that evidence;
- approval revalidates the same preferred key before enrollment;
- a saved background connection can expose the same typed trust evidence for TUI approval/retry;
- JSON automation can approve the exact evidence through `host-trust approve` and then retry the original Session/intent;
- a changed key for an already trusted host remains a fail-closed authentication/trust mismatch.

Private identity/password material is resolved only after host trust succeeds.

Do not implement provider-side “trust on first use” shortcuts that bypass the host trust boundary.

## Lifecycle state is not billing state

Never infer provider billing semantics from normalized lifecycle state.

```text
stopped != not billed
```

Providers may charge for reserved GPU, disk, IP addresses, or the server itself while compute is stopped. Pricing/billing/storage policy stays provider-owned unless a proven cross-provider contract is added deliberately.

## Compatibility

A plugin declares host and SDK compatibility independently:

```ts
compatibility: {
  easyserver: "^0.2.0",
  pluginSdk: "^0.2.0",
}
```

For pre-1.0 versions, `^0.2.0` intentionally accepts `0.2.x` and rejects `0.3.0`.

Use only package-root SDK exports. EasyServer source paths and package `dist/` deep imports are not supported plugin APIs.

Widen compatibility only after validating against that host/SDK line.

## Disable semantics

Disabling a configured plugin stops **new admission** after the disable operation linearizes:

- new provider operations cannot acquire it;
- new feature invocations cannot acquire it;
- new connection setup cannot acquire it.

Already-admitted work may finish, and an already-published connection may drain until closed. Disable is not physical JavaScript module unloading.

A plugin load/import is bounded by host deadline for asynchronous completion, but EasyServer cannot preempt malicious/synchronously-blocking in-process code.

## Validate the packaged plugin

Validate the package layout users will consume:

```powershell
npm pack
npm install --global .\your-plugin-0.2.0.tgz
easyserver plugins add @example/easyserver-provider
easyserver plugins list
```

The plugin should work without any EasyServer source checkout present.

Use SDK runtime validators and public seams rather than importing host internals.

## Author checklist

Before treating a provider as usable:

1. Manifest and adapter pass SDK validation.
2. Manifest provider ID and `providerId` agree.
3. Every `providerExternalId` is stable for the remote resource lifetime.
4. Unknown provider states map to normalized `unknown` while preserving raw state.
5. `availableActions` is a plugin-owned subset of declared capabilities.
6. `getInstance()` returns `undefined` only for authoritative absence.
7. Blocking work honors the host `AbortSignal`.
8. Mutation dispatch is marked immediately before the first side-effecting remote request.
9. Post-dispatch uncertainty becomes `outcome-unknown`, not a blind retry.
10. Provider-specific acquisition/configuration stays in Provider Features.
11. Confirmed acquisition returns stable affected provider IDs for handoff when appropriate.
12. Credentials are declared/resolved through the Secret Reference boundary.
13. Access discovery contains no resolved secrets.
14. Provider-deferred access credentials are resolved only inside connection setup.
15. Custom Access Adapter resources register cleanup immediately.
16. First-use SSH trust is left to EasyServer's explicit host boundary.
17. Disable stops new admission without pretending to unload already-admitted code.
18. The packed plugin loads without provider-specific branches or source/deep imports from EasyServer core.
