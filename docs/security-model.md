# EasyServer security model

This document describes the security boundaries of EasyServer `0.1.0`. The supported client platform for this release is Windows 11 x64; platform-specific statements below refer to that qualified environment unless stated otherwise.

## Trust boundaries

```text
                          untrusted / remote

 Provider API  <──── HTTPS ────>  first-party Provider Plugin
      │                                  │
      │                                  │ trusted in-process code
      ▼                                  ▼
 remote compute  <── SSH / provider access ── EasyServer core/CLI
      │                                  │
      │                                  ├── OS Secret Store
      │                                  ├── Local State (no raw credentials)
      │                                  └── local daemon control API
      │                                              │
      └──── remote TCP service ── Access Adapter ────┴─> 127.0.0.1:<endpoint>
                                                        local client process
```

EasyServer separates **remote/provider input**, **trusted Provider Plugin code**, **core-owned local state/secrets**, and **local Endpoint consumers**. Some boundaries are isolation boundaries; others are explicitly trust boundaries rather than sandboxes.

### Trusted code

EasyServer core/CLI and installed Provider Plugins execute with the privileges of the current OS user. Provider Plugins are **trusted in-process code** in `0.1.0`. Installing/registering a malicious Provider Plugin is equivalent to running other malicious Node.js code as the current user.

The Plugin SDK and host restrict ordinary plugin operations to declared contracts and credential resolvers, but those APIs are not a malicious-code sandbox. An in-process plugin can use Node.js/OS capabilities available to the user. Install plugins only from sources you trust.

### Local OS user boundary

EasyServer relies on the operating system account boundary for local confidentiality. The supported Windows Secret Store uses Windows Credential Manager, and temporary SSH credential files are restricted to the current user.

A different unprivileged OS user is outside the intended trust boundary. **Another process already running as the same OS user is inside it**: such a process may be able to inspect that user's files/environment/credential facilities and can connect to EasyServer loopback Endpoints. EasyServer does not attempt to sandbox mutually hostile processes belonging to the same logged-in user.

## Provider credentials and Secret Store

Long-lived Provider Plugin credentials are imported from an environment variable into the OS-backed Secret Store:

```powershell
$env:VAST_API_KEY = '<value>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

The secret value is not a normal CLI argument. EasyServer stores only an opaque `secret:<uuid>` reference in Local State; state validation rejects a raw credential value where a Secret Reference is required.

The OS keyring account identifier is the opaque reference, not the secret. The release platform check performs a real create/read/delete round trip through the Windows keyring adapter.

Provider code receives a resolver for configured credential names instead of the Secret Store itself. Access Adapters can resolve only Secret References or provider-deferred credential IDs declared by the selected Access Method. These restrictions reduce accidental secret reachability, but do not turn a malicious in-process Provider Plugin into untrusted code.

## Secret-free access discovery

Provider Access Method discovery is designed to be secret-free. A provider describes how an instance can be reached using identifiers/references and public connection metadata. Secret material is resolved only when the selected Access Adapter actually sets up access.

For the built-in OpenSSH path:

- an unknown SSH host key is discovered before private identity/password material is resolved;
- foreground access requires explicit fingerprint confirmation before enrollment;
- daemon-owned non-interactive setup never auto-trusts an unknown host;
- a changed trusted key fails closed.

Intelion's provider-deferred SSH password is fetched only after host trust succeeds.

## Temporary SSH credential material

OpenSSH requires some credentials in forms it can consume. EasyServer therefore materializes private-key or password-helper data in a random per-setup directory below `.easyserver/sessions` when necessary.

On Windows, EasyServer removes inherited ACLs from that temporary directory and grants full access to the current user through `icacls`. Secret contents are never placed in the OpenSSH argument list: a private key argument contains only the temporary file path, and password authentication uses an askpass helper whose environment contains only the path to the protected password file.

The setup cleanup scope recursively removes this directory on normal teardown, including failure paths. Focused tests verify that password/private-key files are gone after cleanup.

A hard process or machine crash can bypass in-process cleanup and leave user-private temporary credential material on disk. This does not cross the qualified Windows OS-user trust boundary when its ACL remains intact, but it extends at-rest lifetime beyond the intended session scope. Crash-safe multi-process cleanup is tracked as [#42](https://github.com/Max19970/easy-server/issues/42) for post-`0.1.0` hardening.

## SSH host trust

EasyServer does not use the ambient global known-hosts database for its managed SSH path. It maintains its own known-hosts file and invokes OpenSSH with:

- `StrictHostKeyChecking=yes`;
- the EasyServer `UserKnownHostsFile`;
- the global known-hosts file disabled;
- `UpdateHostKeys=no`;
- no host-IP substitution (`CheckHostIP=no`).

Enrollment is two-phase: EasyServer scans a key/fingerprint, presents the fingerprint for explicit confirmation, then re-scans/revalidates that exact key before writing trust. Concurrent enrollments are serialized and conflicting keys cannot both become trusted.

If a later scan does not match the enrolled key, access fails with an authentication error rather than silently replacing trust.

## Local daemon control channel

The local daemon owns persistent Connection Sessions. Its control API:

- listens only on `127.0.0.1` on a dynamically allocated port;
- requires a fresh 32-byte random bearer token;
- compares bearer tokens with a constant-time equality check after equal-length validation;
- limits request bodies to 64 KiB;
- never accepts a host/address from the descriptor other than `127.0.0.1`;
- cleans owned sessions and aborts pending setup on shutdown.

The daemon address and bearer token are stored in `.easyserver/daemon.json`, separate from Local State. The file is created exclusively (`wx`) and, on POSIX-style filesystems, requests mode `0600`; its parent requests `0700`. On the supported Windows default path it inherits the user's profile security boundary.

The bearer token is a **local capability**, not an encryption key. Control traffic is plain HTTP over loopback. A same-user process that can read the descriptor is considered inside the local-user trust boundary and can control the daemon. If `EASYSERVER_DAEMON_FILE` is overridden, the caller must not place the descriptor in a directory readable by untrusted users.

Daemon session setup never enrolls SSH trust interactively. Unknown-host trust must be established through foreground `connect` first.

## Local Endpoints

Every EasyServer Endpoint in `0.1.0` is hard-bound to IPv4 loopback:

```text
127.0.0.1:<dynamic-port>
```

There is no option to publish an Endpoint on `0.0.0.0`, a LAN interface or a public address. Closing its Connection Session releases the listener.

**Endpoints do not have EasyServer client authentication.** Any local process able to connect to the loopback port can send traffic through that Endpoint. This is intentional raw-TCP behavior, not a per-client authorization system. Use authentication provided by the tunneled workload when local applications/pages should not have unrestricted access, and close the Endpoint when it is no longer needed.

The remote target host/port is chosen by the user and is reached through the selected Provider Access Method. EasyServer does not inspect or authorize application-layer traffic passing through the tunnel.

## Local State

Local State persists configuration and provider/resource identities, not raw credentials. Writes use a temporary file, explicit file creation, fsync and atomic replacement; concurrent writers coordinate through an exclusive lock. Corrupt state is reported rather than silently discarded.

Local State is not an encrypted database. Treat provider/resource names, IDs, plugin package specifiers and other non-secret operational metadata as visible to the current OS user. Environment overrides that relocate state are responsible for choosing an appropriate local path.

## Provider APIs and diagnostics

First-party Provider Plugins place API credentials in request authorization headers, not URLs. Their error handling distinguishes safe provider rejection reasons from unsafe/unstructured response bodies, and focused tests ensure configured credentials/unsafe bodies are not rendered in diagnostics.

Mutations that may have reached a provider but lack a trustworthy final result are reported as `outcome-unknown`; EasyServer asks callers to reconcile inventory instead of blindly replaying a potentially chargeable/destructive operation.

Provider/API response data remains untrusted input and is normalized/validated at the plugin/core boundary where applicable.

## Package and extension boundary

The CLI package does not bundle Provider Plugins. Provider packages are installed and registered explicitly. The release gate installs packed artifacts outside the monorepo and verifies that unrelated Provider Plugins are absent.

Published EasyServer tarballs are allowlisted to `LICENSE`, `README.md`, `package.json` and `dist/**`. The `0.1.0` production dependency/supply-chain audit is documented separately.

Registering a Provider Plugin imports and executes that package. EasyServer checks manifest/runtime compatibility before admission, but compatibility validation is not package authenticity verification or sandboxing.

## Residual risks and non-goals in 0.1.0

The following are explicit limitations rather than hidden security claims:

- third-party Provider Plugins are trusted code, not sandboxed;
- same-OS-user hostile-process isolation is not provided;
- local Endpoints are unauthenticated loopback TCP listeners;
- EasyServer is not an application-layer TLS/authentication proxy for the tunneled workload;
- abrupt termination can leave ACL-protected temporary SSH credential material until separately cleaned;
- only Windows 11 x64 has the complete `0.1.0` platform/security integration qualification.

## Release security verification

Focused security behavior is exercised by the Secret Store, plugin-credential, Local State, daemon, Connection Gateway, SSH Access Adapter and first-party provider diagnostic/access tests. Run:

```sh
npm run verify:security
npm run verify:os-keyring
npm run release:check
```

Immediately before publication, also rerun the registry-dependent production advisory/signature checks documented in the dependency audit.

## Reporting vulnerabilities

Follow [`../SECURITY.md`](../SECURITY.md). Do not put suspected vulnerabilities or secret material in a public issue.
