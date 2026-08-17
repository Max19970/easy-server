# Machine-readable CLI output

EasyServer keeps human-oriented CLI output as the default. Automation can opt into a stable machine-readable contract by placing the host-owned `--json` flag **before** the command:

```powershell
easyserver --json instances list
easyserver --json plugins list
easyserver --json sessions list
```

`--json` is intentionally a prefix rather than a provider-command argument. EasyServer consumes it before command dispatch, so a Provider Plugin remains free to define its own provider-specific arguments without the host stealing an argument named `--json` later in the command line.

Bare `easyserver --json` is command mode, not TUI mode, and fails with a structured usage error because no command was supplied.

## Envelope version 1

Every successful JSON-mode command writes exactly one compact JSON document to stdout:

```json
{"schemaVersion":1,"ok":true,"data":{"version":"0.2.1"}}
```

Every terminal command error writes exactly one compact JSON document to stderr and leaves stdout empty:

```json
{"schemaVersion":1,"ok":false,"error":{"code":"not-found","message":"Compute Instance not found: instance:..."}}
```

Usage errors use the stable host code `usage-error` and include `helpCommand` when EasyServer knows the relevant contextual help path:

```json
{"schemaVersion":1,"ok":false,"error":{"code":"usage-error","message":"Unknown instances command: wat","helpCommand":"easyserver instances --help"}}
```

Unexpected non-normalized command failures use `command-failed`. Normalized EasyServer/provider failures preserve their public normalized error code, such as `authentication`, `not-found`, `conflict`, `rate-limited`, `provider-unavailable`, `cancelled`, `timeout`, `outcome-unknown`, `plugin-failure`, `host-trust-required` or `unknown-provider-error`.

The raw internal `cause` of a normalized error is not serialized into the JSON error envelope. Automation should branch on `error.code`, not parse `error.message`.

A first-use SSH trust requirement additionally exposes only the public verification evidence needed for an explicit decision:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "host-trust-required",
    "message": "SSH host trust is required for ssh.example.test:22",
    "hostTrust": {
      "target": { "host": "ssh.example.test", "port": 22 },
      "key": { "type": "ssh-ed25519", "fingerprint": "SHA256:..." }
    }
  }
}
```

`hostTrust.target` is the exact SSH host/port identity used by the selected Access Method. `hostTrust.key.type` plus the SHA256 `fingerprint` identify the observed public host-key material without exposing private credentials or raw SSH diagnostics.

## Command data

The outer envelope is uniform; `data` remains command-specific so EasyServer does not invent one lossy universal model for unrelated concepts.

Common core shapes include:

- `plugins list` → `data.plugins`;
- `instances list` → `data.inventory`, including per-provider completeness/failure state. Each `data.inventory.instances[]` entry exposes stable recovery identity fields: canonical `id`, `providerId`, `providerExternalId`, `management`, and `freshness`; `name` is present when the provider supplied a normalized display name. Fresh entries additionally expose their current normalized `state`, `observedAt`, and `availableActions`. Stale entries preserve only last-known normalized observation data and have no available actions; unobserved entries carry identity/management only. Automation that uses a provider-side ownership marker must require an exactly-one **fresh** `providerId` + `name` match. A stale/unobserved match or `data.inventory.complete: false` is not authoritative evidence that a resource is absent;
- `instances inspect` → `data.instance`;
- single lifecycle mutations → `data.action`, `data.instanceId`, `data.status` and any host warnings;
- bulk lifecycle mutations → `data.result` plus any host warnings, preserving every per-target result and summary;
- `sessions list` → `data.sessions`;
- Endpoint-intent commands → `data.endpointIntents` or `data.endpointIntent`. Each persisted intent status exposes stable definition fields `name`, `enabled`, `instanceId`, `remoteHost`, and `remotePort`, plus requested `localPort` / `accessMethodId` when supplied. `state` is one of `starting`, `live`, `error`, or `disabled`. Only `live` carries a usable `endpoint` (`host`, `port`) and selected `accessMethod` (`id`, `kind`, `mode`); `error` instead carries `failure.code` and `failure.message`. When `failure.code` is `host-trust-required`, `failure.hostTrust` carries the same structured target/key evidence as the terminal error shape above, so automation can approve the exact key and call `sessions intents retry` without parsing prose. `starting` and `disabled` carry neither a live endpoint nor access-method realization. `sessions intents remove` returns `data.endpointIntent` with the removed `name` and `removed: true`. Automation may locate an intent by stable `name` and verify `instanceId`, but must treat the realized localhost endpoint as runtime state: when no fixed `localPort` was requested it may change after daemon restart;
- provider-feature discovery → `data.features` or provider/feature command descriptors;
- daemon commands → `data.daemon`;
- `connect` → the published `data.endpoint` and selected `data.accessMethod` once the foreground Endpoint is ready.

JSON mode has one success channel: an `ok: true` envelope exits with status `0`, while an `ok: false` terminal command failure exits non-zero. Degraded-but-successful state stays explicit in `data` instead of conflicting with the envelope through a non-zero exit code. For example, partial inventory keeps `data.inventory.complete: false` and per-provider failures; partial bulk results keep every per-target result; daemon status keeps `stopped` or `stale` in `data.daemon.status`.

When running the repository through an npm development script, npm may append its own lifecycle diagnostics after a non-zero EasyServer command. Those lines are not part of the EasyServer JSON contract. Installed `easyserver` owns only its JSON document and process exit status.

## Provider-specific commands

Provider Plugins own provider-specific command semantics. EasyServer therefore does not parse arbitrary provider text into fake normalized fields.

In JSON mode, an executed provider command returns its host-owned execution/handoff result plus a namespaced raw transcript:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "provider": {
      "providerId": "example",
      "featureId": "marketplace",
      "commandName": "search",
      "stdout": "provider-owned output\n",
      "stderr": ""
    },
    "execution": {
      "operation": "read",
      "mutationOutcome": "not-applicable",
      "handoff": {
        "status": "not-requested",
        "affectedProviderExternalIds": [],
        "canonicalInstances": [],
        "unresolvedProviderExternalIds": []
      }
    }
  }
}
```

The `provider.stdout` and `provider.stderr` strings are **provider-owned raw command output**. Their contents are not a stable EasyServer schema and may change with that Provider Plugin. Host-owned fields such as provider/feature/command identity and `execution` retain EasyServer's documented compatibility rules.

## Explicit SSH host trust for automation

JSON mode never emits interactive confirmation/trust prompts into the machine-readable stream. When a first connection fails with `error.code: "host-trust-required"`, automation can present or record `error.hostTrust` for an external decision and then authorize exactly that evidence with a separate action:

```powershell
easyserver --json host-trust approve `
  --host ssh.example.test `
  --port 22 `
  --key-type ssh-ed25519 `
  --fingerprint SHA256:...
```

Success returns the same `data.hostTrust` evidence plus `data.approved: true`. The approval command itself is the explicit authorization; it has no `--yes` shortcut and EasyServer never performs trust-on-first-use automatically. Before writing `known_hosts`, EasyServer freshly scans the target, deterministically selects the same preferred host key used for first-use observation, and requires exact host, port, key type and fingerprint agreement. Replaying approval for the same still-current key is idempotent. Stale evidence, another currently advertised non-preferred key, or an already-trusted different key is rejected without replacing trust.

After approval, retry the original daemon-owned Session request, or call `sessions intents retry <name>` for an Endpoint intent whose structured `failure.hostTrust` reported the same first-use requirement. A changed key for a host that already has trust is an `authentication` failure, not a new first-use approval opportunity.

Other operations that require explicit non-interactive authorization still require their existing command inputs, such as `--yes` for risky mutations.

Human CLI output remains unchanged when the global prefix is absent:

```powershell
easyserver instances list
easyserver provider vastai marketplace search --gpu "RTX 4090"
```

Do not parse spacing, `key=value` display text or prose from human mode for automation.

## Compatibility contract

For the `0.2.x` line:

- `schemaVersion` is `1`;
- the envelope fields `schemaVersion`, `ok`, `data` and `error` have the meanings documented above;
- documented core `data` fields and stable error codes are part of the public CLI compatibility contract;
- for `host-trust-required`, `error.hostTrust` and Endpoint-intent `failure.hostTrust` use the stable `{ target: { host, port }, key: { type, fingerprint } }` shape; `host-trust approve` accepts those four exact values and successful approval returns the same shape in `data.hostTrust` with `data.approved: true`;
- patch releases may add fields without changing the meaning of existing fields, so consumers should ignore unknown fields;
- removing, renaming or repurposing a documented field is a compatibility-breaking change and requires a later pre-1.0 minor line under EasyServer's versioning policy;
- provider-owned raw transcript contents are outside the core schema compatibility promise.

`easyserver doctor` remains the privacy-safe support/diagnostic payload described by the support documentation. JSON command mode does not turn ordinary raw logs or arbitrary provider text into a privacy-safe diagnostic bundle.
