# Getting started with EasyServer

EasyServer is a provider-independent control surface for acquiring, managing and locally accessing rented compute. The interactive TUI is the preferred human-facing entrypoint, while the CLI remains the explicit automation and advanced-command surface. Provider-specific acquisition stays in separately installed Provider Plugins; after a resource exists, EasyServer exposes a shared inventory/lifecycle/connectivity surface.

## Requirements

EasyServer `0.2.x` is released for Node.js `24.18.1` with npm `11.16.0`. See [Supported platforms](supported-platforms.md) for the operating systems and OS integrations qualified for the release.

EasyServer's built-in SSH access uses the system OpenSSH client. If you plan to connect to SSH-backed resources, `ssh` and `ssh-keyscan` must be available on `PATH`.

## Install the CLI

The primary package-based installation is:

```sh
npm install --global @easyai101/easyserver
```

Windows 11 x64 users can instead download the versioned portable ZIP from GitHub Releases. That path requires Node.js `24.18.1` on `PATH` but does not require installing the core CLI package from npm. Verify the published SHA-256 checksum and follow [Install from GitHub Releases](github-release-install.md).

A default CLI installation from either path contains **no Provider Plugins**:

```sh
easyserver plugins list
```

The expected initial result is `No provider plugins configured.`

## Choose interactive or command mode

On an interactive terminal, plain `easyserver` opens the TUI. Use `easyserver --help` when you deliberately want the command-mode interface for scripts, automation or advanced workflows. Nested help is available at the same path as the command it documents:

```sh
easyserver plugins --help
easyserver plugins credential set --help
easyserver instances destroy --help
easyserver connect --help
easyserver sessions intents --help
```

Usage errors point back to the nearest relevant `--help` page instead of dumping unrelated global usage.

See [Interactive TUI](tui.md) for keyboard navigation, compact terminals, `NO_COLOR`, screen-reader mode, connection lifetime, privacy-safe Diagnostics and recovery behavior. Plain `easyserver` requires an interactive terminal; in a pipe, CI job or other non-TTY context use the explicit CLI command you intend instead.

Provider-specific commands remain Provider Plugin owned. Package-based plugins can publish a dedicated side-effect-free `./easyserver-help` contribution, which allows discovery without loading the normal plugin runtime, resolving credentials or contacting provider APIs:

```sh
easyserver provider vastai --help
easyserver provider vastai marketplace --help
easyserver provider vastai marketplace rent --help
```

A legacy or local-file plugin without that dedicated help-only contribution still remains executable, but provider-specific `--help` degrades explicitly instead of evaluating its normal entrypoint just to obtain metadata.

For an npm-installed CLI, install selected providers into the same global npm environment. For example:

```sh
npm install --global @easyai101/easyserver-plugin-vastai
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

or:

```sh
npm install --global @easyai101/easyserver-plugin-intelion
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

For the portable GitHub Release ZIP, install Provider Plugins into the extracted EasyServer prefix using the prefix-aware commands in [Install from GitHub Releases](github-release-install.md#add-a-provider-plugin-later). Do not install them into an unrelated global npm prefix and expect the portable CLI to discover them.

Inspect plugin state at any time:

```sh
easyserver plugins list
```

`plugins disable` stops new work from being admitted to a configured plugin; `plugins enable` admits new work again. Disabling a plugin is not the same as destroying provider resources.

## Configure a provider credential

EasyServer imports credentials from an environment variable into the OS-backed Secret Store. The environment variable is only the transfer channel; normal EasyServer Local State stores an opaque `secret:<uuid>` reference rather than the credential value.

Vast.ai example in a POSIX shell:

```sh
export VAST_API_KEY='<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
unset VAST_API_KEY
```

PowerShell equivalent:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Intelion.cloud uses credential name `api-token`:

```sh
export INTELION_API_TOKEN='<your-api-token>'
easyserver plugins credential set @easyai101/easyserver-plugin-intelion api-token --env INTELION_API_TOKEN
unset INTELION_API_TOKEN
```

Do not pass provider credentials as ordinary CLI arguments or save them in repository files.

## Acquire compute

Acquisition is intentionally provider-specific. Vast.ai exposes marketplace search/rental; Intelion.cloud exposes its own server catalog/configurator. EasyServer does not force both providers into a lossy universal `create` request.

Follow one of the provider guides:

- [Vast.ai quick start](providers/vastai.md)
- [Intelion.cloud quick start](providers/intelion.md)

After acquisition converges into provider inventory, the resource appears as an EasyServer Compute Instance:

```sh
easyserver instances list
easyserver instances inspect <instance-id>
```

Use the EasyServer `instance-id` shown by these commands for lifecycle and connectivity commands. Provider-specific external IDs remain plugin-owned reconciliation identity.

`instances list` refreshes Providers independently. If one Provider is unavailable while another succeeds, EasyServer still prints the useful inventory and marks each entry as `fresh`, `stale` or `unobserved`. `stale` means the last privacy-safe normalized observation is being shown; `unobserved` means EasyServer knows the canonical identity but has no prior usable observation. Stale/unobserved entries never advertise lifecycle actions. In the default human mode, a useful partial listing exits with status `2`; a complete listing exits with `0`, while a total failure with nothing useful to show exits with `1`. In `--json` mode, any `ok: true` envelope exits `0`; partial state remains explicit in `data.inventory.complete` and the per-provider outcomes.

Each instance also has provider-independent management state:

- `management=managed` means EasyServer has explicit management intent for the resource. Resources acquired through an EasyServer Provider Feature become managed automatically once they reconcile into inventory, including when the first post-acquisition refresh failed and a later refresh observes them.
- `management=discovered` means the resource was merely visible through the configured provider account (or came from older Local State that predates provenance tracking). Discovery alone never grants destructive ownership.

To intentionally bring a pre-existing provider resource under EasyServer management without changing its canonical identity:

```sh
easyserver instances adopt <instance-id>
```

Adoption is local management intent; it does not recreate, restart or otherwise mutate the provider resource.

## Lifecycle

A provider advertises which normalized lifecycle operations it supports, and each instance snapshot reports which of those operations are currently available.

```sh
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

An unavailable action is rejected rather than guessed from generic state. Reversible power actions remain governed by the Provider snapshot, but `instances destroy` additionally requires `management=managed`; a discovered resource must be explicitly adopted before EasyServer will dispatch that destructive mutation.

Risky mutations have a host-owned safety gate. In an interactive terminal EasyServer shows the target/provider identity and consequence and requires typing `yes`. Non-interactive automation never waits for input: it must opt in explicitly with `--yes`.

`instances destroy` also coordinates with EasyServer-owned daemon connections. If the target has daemon Connection Sessions or enabled persisted Endpoint intents, destroy refuses by default and reports the affected session IDs / intent names. To explicitly close those local connections first and only then dispatch the provider destroy:

```sh
easyserver instances destroy <instance-id> --close-sessions --yes
```

During coordinated destroy EasyServer drains that canonical instance so no new daemon session or intent can be published between the check and the remote mutation. Enabled Endpoint intents are disabled first so they cannot restore against a deleted resource, then daemon sessions are closed, and only after successful local teardown is the provider `destroy` dispatched. If any local cleanup fails, remote destroy is **not** dispatched. Closing these local connections never destroys the provider resource by itself; the destructive provider operation remains the explicit `instances destroy` step.

If the daemon descriptor is stale/unreachable, destroy fails closed because EasyServer cannot safely prove which daemon connections exist. Foreground `easyserver connect` processes are intentionally not daemon-owned and cannot be reliably discovered cross-process; close any foreground connection manually before destroying its instance.

Also, `stopped` does **not** universally mean `not billed`; provider billing/storage/reservation semantics remain provider-specific. When a rented resource is no longer needed, follow the provider guide and verify the destructive cleanup required by that provider.

### Wait for provider convergence

Lifecycle mutations report that the request was dispatched; provider state may converge later. Use the host-owned observation primitive instead of writing provider-specific polling loops or repeating a mutation:

```sh
easyserver instances wait <instance-id> --state running
easyserver instances wait <instance-id> --state stopped --timeout 300
easyserver instances wait <instance-id> --state absent --timeout 300
```

`--state` accepts normalized EasyServer instance states plus the special `absent` target for provider-confirmed disappearance. `--timeout` is in seconds and defaults to 120. Waiting uses only repeated `getInstance()` observation with bounded backoff; it never dispatches start/stop/restart/destroy. This makes it safe as a recovery step after `outcome-unknown`: observe the existing operation rather than blindly repeating it. Timeout and cancellation are reported separately and include the last normalized state EasyServer observed.

## Expose a remote TCP service locally

`connect` exposes one remote TCP target as an EasyServer-owned local loopback Endpoint:

```sh
easyserver connect <instance-id> --port 8188
```

`--port` is the port **on the remote target**. `--host` is the remote target host as reached from the compute resource and defaults to `127.0.0.1`:

```sh
easyserver connect <instance-id> --host 127.0.0.1 --port 8188
```

On success EasyServer prints a local address such as:

```text
127.0.0.1:54321
```

By default the local port is allocated dynamically. For a stable localhost address, request one explicitly with `--local-port`, for example `easyserver connect <instance-id> --port 8188 --local-port 54321`. If that local port is occupied, EasyServer reports a conflict instead of choosing another port. Without `--local-port`, dynamic allocation is unchanged. EasyServer provides raw TCP forwarding and keeps the local bind on `127.0.0.1`.

A Provider may expose more than one TCP-forward Access Method. Discover the applicable methods without exposing their credential sources:

```sh
easyserver instances access-methods <instance-id>
```

When no method is requested, EasyServer deterministically selects the supported method with the lexicographically smallest stable ID. To choose a specific path, use `--access-method`; an unavailable requested ID fails instead of silently falling back:

```sh
easyserver connect <instance-id> --port 8188 --access-method direct-ssh
```

The foreground output includes the selected Access Method ID and kind. The foreground command owns the Endpoint until it is cancelled. Press Ctrl+C when finished.

### First SSH connection and host trust

If the selected access path uses SSH and the host key is unknown, foreground `connect` displays the exact host-key fingerprint and asks for explicit confirmation. Only explicit confirmation enrolls that key, then EasyServer retries once. Declining leaves it untrusted. A changed key fails closed rather than being silently replaced.

Passwords/private identities are resolved only after host trust succeeds.

## Persistent Endpoints with the local daemon

For normal desktop/automation use, start the daemon without dedicating the invoking terminal:

```sh
easyserver daemon start
```

Inspect authenticated daemon health with:

```sh
easyserver daemon status
```

`status` prints `running`, `stopped` or `stale`. Its exit status is `0` for a healthy authenticated daemon, `1` when stopped and `2` when a descriptor exists but is invalid/unreachable. `daemon start` is idempotent when the daemon is already healthy and recovers stale descriptors before starting a fresh daemon.

The running daemon reloads Provider Plugin enablement and credential bindings for **new** connection setup. `plugins add`, `plugins enable`, `plugins disable`, and credential set/rotation/removal therefore do not require a daemon restart. A connection that was already established keeps its admitted runtime and is not torn down merely because configuration changed afterward. If the current configuration cannot load the Provider needed by a new setup, that setup fails explicitly while existing healthy sessions remain alive.

Use foreground mode when debugging or when an external process manager should own the process directly:

```sh
easyserver daemon run
```

Graceful managed shutdown is authenticated through the daemon control channel:

```sh
easyserver daemon stop
```

Before waiting for shutdown, `stop` reports how many live ephemeral Connection Sessions and active persisted Endpoint intents will have their local transports closed. Persisted Endpoint definitions remain in Local State and will be realized again on the next start; shutting down the daemon never destroys the underlying compute resources. Repeated stop while already stopped is a successful no-op. If only a stale/unreachable descriptor remains, `stop` reports that condition without pretending it authenticated a remote shutdown.

Then create a daemon-owned Connection Session:

```sh
easyserver sessions create <instance-id> --port 8188
```

Persistent sessions accept the same optional stable local port and explicit Access Method selection:

```sh
easyserver sessions create <instance-id> --port 8188 --local-port 54321 --access-method direct-ssh
```

The command reports whether the requested local port was dynamic or fixed, the actual loopback Endpoint, and the selected Access Method ID/kind. `sessions list` preserves both the requested local port and selected method alongside that realized Endpoint.

For reliable automation, give a create intent a stable idempotency key:

```sh
easyserver sessions create <instance-id> --port 8188 --idempotency-key comfyui-main
```

Retrying the same key with the same instance, remote target, requested local port and Access Method reuses the same live session instead of opening another tunnel. Reusing that key with different settings fails with `conflict`. Different keys may intentionally create multiple sessions to the same target. A successful `sessions close` releases the key for later reuse; idempotency state is daemon-local and does not survive a daemon restart.

Inspect and close sessions with:

```sh
easyserver sessions list
easyserver sessions close <session-id>
```

The daemon's connection setup is non-interactive and never auto-trusts an unknown SSH host. For a new SSH host, first use foreground `easyserver connect ...` to review/enroll the fingerprint, stop that foreground connection, then create the persistent session.

Connection Sessions are daemon-owned resources with explicit `live`, `closing` and `failed` states. A failed terminal record keeps the same Session ID and a normalized cleanup reason, but no longer advertises its old Endpoint as reachable. Running `easyserver sessions close <session-id>` again retries cleanup and removes the record on success. Failed records are intentionally ephemeral and bounded to the 100 most recent failures; older failures are pruned with one final best-effort cleanup attempt. Restarting the daemon does not pretend old dead sessions are still active.

### Persisted Endpoint intents

For a tunnel that should be recreated after daemon or machine restart, persist the **desired Endpoint intent** instead of the live Connection Session:

```sh
easyserver sessions intents create comfyui-main <instance-id> \
  --port 8188 \
  --local-port 54321 \
  --access-method direct-ssh
```

Inspect desired/runtime state separately from ephemeral sessions:

```sh
easyserver sessions intents list
```

An intent has a stable user-visible name and runtime state `starting`, `live`, `error` or `disabled`. Local State stores only its desired instance/target/local-port/Access-Method settings and `enabled` flag; it never stores an old session ID, actual live transport, resolved Endpoint or stale `live` claim. On daemon startup every enabled intent is realized again from current provider state. A failed intent becomes `error` without blocking healthy sibling intents or daemon startup.

After fixing a recoverable cause such as credentials, host trust, provider availability or a local-port conflict, retry only that intent:

```sh
easyserver sessions intents retry comfyui-main
```

Disable or re-enable desired restoration without deleting the definition:

```sh
easyserver sessions intents disable comfyui-main
easyserver sessions intents enable comfyui-main
```

Remove the desired intent entirely with:

```sh
easyserver sessions intents remove comfyui-main
```

Disable/remove closes only that intent's local transport and does not mutate or destroy the underlying compute resource. Ordinary `sessions create` remains purely ephemeral and receives no persistence overhead.

## SSH and SCP through an EasyServer Endpoint

An Endpoint can forward any TCP port, including an SSH service. First establish host trust for the provider access path if needed, then create a persistent Endpoint to the compute resource's SSH port:

```sh
easyserver sessions create <instance-id> --host 127.0.0.1 --port 22
```

Suppose EasyServer reports `127.0.0.1:54322`. You can then make a second SSH connection through that local Endpoint:

```sh
ssh -p 54322 root@127.0.0.1
```

or copy a file through it:

```sh
scp -P 54322 ./model.safetensors root@127.0.0.1:/root/
```

The credentials and host trust for this *inner* SSH connection are handled by your `ssh`/`scp` command; EasyServer is forwarding raw TCP bytes to the remote SSH service.

## Remove a configured credential

```sh
easyserver plugins credential remove @easyai101/easyserver-plugin-vastai api-key
easyserver plugins credential remove @easyai101/easyserver-plugin-intelion api-token
```

Removing a local credential does not destroy any paid provider resource. Clean up provider resources first when appropriate.
