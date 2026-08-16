# EasyServer security model

EasyServer manages provider credentials, remote-compute identity, SSH access, local state, and loopback TCP listeners. This document describes the trust boundaries behind those surfaces for the current `0.2.x` line.

For vulnerability reporting, use [SECURITY.md](../SECURITY.md). Platform-specific guarantees below assume the currently qualified client environment from [Supported platforms](supported-platforms.md).

## Trust boundaries

```text
                          remote / untrusted input

 Provider API  <──── HTTPS ────>  Provider Plugin
      │                                  │
      │                                  │ trusted in-process extension
      ▼                                  ▼
 remote compute  <── provider / SSH ── EasyServer core
      │                                  │
      │                                  ├── OS Secret Store
      │                                  ├── Local State (no raw credentials)
      │                                  └── local daemon control channel
      │                                              │
      └──── remote TCP service ── connection path ───┴─> 127.0.0.1:<port>
                                                        local client process
```

EasyServer distinguishes:

- remote/provider-controlled data;
- trusted in-process Provider Plugin code;
- core-owned local state and credential references;
- the local OS-user boundary;
- local applications that consume EasyServer's loopback connections.

Some of these are validation/isolation boundaries; Provider Plugins are explicitly a **trust** boundary rather than a sandbox.

## Provider Plugins are trusted code

EasyServer core and installed Provider Plugins run with the privileges of the current OS user.

The Plugin SDK validates documented contracts and helps isolate normal plugin failures, but an in-process plugin can still use ordinary Node.js/OS capabilities available to that user. A malicious plugin could therefore do things outside the EasyServer contract.

Install Provider Plugins only from sources you trust. Compatibility validation is not authenticity verification or a malicious-code sandbox.

## Local OS-user boundary

EasyServer relies on the operating-system user boundary for local confidentiality.

On the supported Windows path:

- long-lived provider credentials are stored through Windows Credential Manager;
- temporary SSH credential material is ACL-restricted to the current user before secret bytes are written;
- EasyServer Local State and daemon/trust files live under the user's profile by default.

A different unprivileged OS user is outside the intended trust boundary. A hostile process already running as the **same** OS user is inside it: such a process may be able to inspect that user's files/credential facilities and can connect to EasyServer loopback Endpoints.

EasyServer does not try to sandbox mutually hostile processes owned by the same logged-in user.

## Provider credentials and Secret Store

Provider credentials are imported into the OS-backed Secret Store rather than stored as normal command arguments or plaintext Local State.

Example:

```powershell
$env:VAST_API_KEY = '<value>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

EasyServer persists an opaque reference such as `secret:<uuid>` in Local State. The secret value stays in the OS Secret Store.

Provider operation contexts receive a resolver for the plugin's configured credential names rather than unrestricted access to the Secret Store. Access setup can resolve only the credential references/sources declared by the selected connection method.

These boundaries reduce accidental secret exposure; they do not make a malicious Provider Plugin untrusted code.

## Secret-free access discovery

A provider describes how a server can be reached without returning resolved private credentials in normal discovery state.

An SSH Access Method can include public routing metadata and opaque/provider-deferred credential identifiers. Private-key/password material is resolved only inside selected connection setup.

For EasyServer's built-in SSH path, host trust is established before private identity/password material is resolved. Intelion's provider-deferred server password is likewise fetched only after host trust succeeds.

See [Provider Plugin contracts](plugin-reference.md#access-methods-adapters-and-endpoints) for the extension contract.

## SSH host trust

EasyServer maintains its own SSH trust store instead of relying on the user's ambient global `known_hosts` file.

The managed OpenSSH path is invoked with strict host-key checking against EasyServer's known-host file, global host trust disabled, host-key update disabled, and no host-IP substitution.

### First use

For an unknown host, EasyServer obtains public host-key evidence and presents the exact:

- host;
- port;
- key type;
- SHA-256 fingerprint.

Interactive approval is explicit and fail-safe. EasyServer re-observes the currently preferred key before enrollment and writes trust only when it still matches the reviewed evidence.

EasyServer normally obtains first-use evidence with `ssh-keyscan`. If all scanners fail but the configured OpenSSH client can still complete key exchange, EasyServer can use one bounded, commandless handshake with all authentication methods disabled and an isolated temporary `known_hosts` file. That temporary file is observation only and is deleted afterward; it never becomes permanent trust by itself.

### Background and automation flows

Daemon connection setup itself remains non-interactive and never silently trusts an unknown host. The trust decision is made by a caller that has the evidence:

- the TUI can review a saved background connection's typed host-trust evidence, approve it, and retry that same definition;
- JSON automation receives `hostTrust` evidence and can call `easyserver --json host-trust approve ...`, after which it retries the original Session/saved definition.

See [Connections](connections.md#first-use-ssh-host-trust) and [Machine-readable CLI output](cli-json.md#explicit-ssh-host-trust-for-automation).

### Changed trusted keys

If an already trusted host presents a different key, EasyServer fails closed. A changed key is not converted into a fresh first-use prompt and is never silently replaced.

Verify that the server was legitimately replaced/reinstalled before changing an existing trust entry.

## Temporary SSH credential material

OpenSSH sometimes needs credentials in filesystem/helper forms. When required, EasyServer materializes temporary private-key/password-helper data in a random per-setup directory below its sessions area.

On Windows, ACL hardening completes before secret bytes are written. Secret contents are not placed directly in the OpenSSH argument list: private-key arguments contain only a temporary file path, while password authentication uses a helper that reads protected material.

EasyServer keeps non-secret ownership metadata outside the recursively deleted credential directory. The ownership record includes process identity strong enough for the supported Windows path to distinguish a still-live matching process from a reused PID.

Cleanup marks the credential directory abandoned before recursive deletion, then removes secret material, then removes ownership metadata. Later startup/setup scavenging removes only directories whose ownership/death can be proved. If process identity cannot be verified, cleanup fails closed by leaving the directory rather than racing a live process.

Legacy pre-0.2.0 temporary directories without trustworthy ownership evidence are not auto-purged. Remove such residue only when older EasyServer processes are definitely stopped.

## Local daemon control channel

The EasyServer daemon owns background Sessions and saved connection realization.

Its control API:

- listens only on `127.0.0.1` on a dynamically allocated port;
- requires a fresh random bearer token;
- validates tokens with constant-time comparison after equal-length checking;
- bounds request bodies;
- accepts only loopback descriptor addresses;
- aborts pending setup and cleans owned live Sessions during shutdown.

The daemon descriptor is separate from ordinary Local State and contains the local endpoint/token needed to control that daemon instance.

The bearer token is a **local capability**, not an encryption key. Control traffic is plain HTTP over loopback. A same-user process able to read the descriptor is already inside EasyServer's local-user trust boundary.

If you override the daemon descriptor path, place it somewhere not readable by users outside the intended OS-user boundary.

## Local Endpoints

EasyServer's caller-facing TCP listeners are bound to IPv4 loopback:

```text
127.0.0.1:<port>
```

EasyServer does not expose an option to bind these Endpoints to `0.0.0.0`, a LAN interface, or a public address.

Endpoints have no separate EasyServer client-authentication layer. Any local process able to connect to that loopback port can send traffic through it.

Use the tunneled workload's own authentication when local applications/pages should not have unrestricted access, and close the EasyServer connection when it is no longer needed.

EasyServer forwards raw TCP and does not inspect/authorize application-layer traffic.

## Local State and recovery

Local State contains configuration and provider/resource identity, not raw credentials.

It may retain a minimal last-known normalized server observation so inventory remains useful when a provider is temporarily unavailable. Raw provider responses, raw secret material, and provider error payloads are not persisted as that observation.

Writes use temporary files and atomic replacement with coordinated ownership/generation locking. EasyServer also maintains a validated recovery generation. If the primary is missing/corrupt but the recovery generation is valid, it can recover without rotating canonical identities or Secret References.

If prior state is evident but neither primary nor recovery is valid, EasyServer fails closed instead of silently resetting the user to an empty installation.

Local State is **not encrypted**. Treat provider/resource names, IDs, plugin package specifiers, and other non-secret operational metadata as visible to the current OS user. Callers who override the state path own the security of that directory.

## Provider APIs and error data

First-party Provider Plugins put API credentials in request authorization headers rather than URLs.

Provider/API responses are untrusted input. When provider-originated detail crosses into a normal EasyServer error, plugins should accept only recognized/bounded fields and reject unsafe/raw bodies rather than rendering them.

Mutations that may have reached a provider without a trustworthy final result are reported as `outcome-unknown`. EasyServer asks callers to reconcile provider state rather than blindly replaying a potentially billable/destructive request.

See [Provider Plugin contracts](plugin-reference.md#normalized-errors).

## Diagnostics and public support data

EasyServer's normal Diagnostics surface is deliberately sanitized. It reports bounded product/runtime readiness rather than raw logs, credentials, provider payloads, or arbitrary exception bodies.

Review a Diagnostics payload before putting it in a public issue anyway, especially when third-party Provider Plugins are installed.

See [Support and maintenance](support-and-maintenance.md#use-privacy-safe-diagnostics).

## Package and extension boundary

The core CLI package does not bundle Provider Plugins. Providers are installed and added explicitly.

Published package shape limits what the supported package surface contains, but installing/registering a Provider Plugin still imports and executes trusted third-party code. Package separation is an ecosystem/ownership boundary, not process isolation.

## Explicit non-goals and residual risks

The `0.2.x` security model does **not** claim:

- malicious Provider Plugin sandboxing;
- isolation from hostile processes running as the same OS user;
- per-client authentication on local loopback Endpoints;
- application-layer TLS/authentication for the tunneled workload;
- automatic deletion of legacy temporary credential directories whose live ownership cannot be proved;
- release-level client support outside the platforms listed in [Supported platforms](supported-platforms.md).

## Reporting vulnerabilities

Follow [SECURITY.md](../SECURITY.md). Do not put suspected vulnerabilities, secrets, or private reproduction material in a public GitHub issue.
