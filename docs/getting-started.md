# Getting started with EasyServer

EasyServer is a provider-independent CLI for acquiring, managing and locally accessing rented compute. Provider-specific acquisition stays in separately installed Provider Plugins; after a resource exists, EasyServer exposes a shared inventory/lifecycle/connectivity surface.

## Requirements

EasyServer `0.1.x` is released for Node.js `24.18.1` with npm `11.16.0`. See [Supported platforms](supported-platforms.md) for the operating systems and OS integrations qualified for the release.

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

`instances list` refreshes Providers independently. If one Provider is unavailable while another succeeds, EasyServer still prints the useful inventory and marks each entry as `fresh`, `stale` or `unobserved`. `stale` means the last privacy-safe normalized observation is being shown; `unobserved` means EasyServer knows the canonical identity but has no prior usable observation. Stale/unobserved entries never advertise lifecycle actions. A useful partial listing exits with status `2`; a complete listing exits with `0`, while a total failure with nothing useful to show exits with `1`.

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

Risky mutations have a host-owned safety gate. In an interactive terminal EasyServer shows the target/provider identity and consequence and requires typing `yes`. Non-interactive automation never waits for input: it must opt in explicitly with `--yes`, for example:

```sh
easyserver instances destroy <instance-id> --yes
```

Also, `stopped` does **not** universally mean `not billed`; provider billing/storage/reservation semantics remain provider-specific. When a rented resource is no longer needed, follow the provider guide and verify the destructive cleanup required by that provider.

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

The foreground command owns the Endpoint until it is cancelled. Press Ctrl+C when finished.

### First SSH connection and host trust

If the selected access path uses SSH and the host key is unknown, foreground `connect` displays the exact host-key fingerprint and asks for explicit confirmation. Only explicit confirmation enrolls that key, then EasyServer retries once. Declining leaves it untrusted. A changed key fails closed rather than being silently replaced.

Passwords/private identities are resolved only after host trust succeeds.

## Persistent Endpoints with the local daemon

Run the daemon in one terminal:

```sh
easyserver daemon run
```

Then create a daemon-owned Connection Session from another terminal:

```sh
easyserver sessions create <instance-id> --port 8188
```

Persistent sessions accept the same optional stable local port:

```sh
easyserver sessions create <instance-id> --port 8188 --local-port 54321
```

The command reports whether the requested local port was dynamic or fixed and prints the actual loopback Endpoint. `sessions list` preserves the requested local port alongside that realized Endpoint. Inspect and close sessions with:

```sh
easyserver sessions list
easyserver sessions close <session-id>
```

The daemon's connection setup is non-interactive and never auto-trusts an unknown SSH host. For a new SSH host, first use foreground `easyserver connect ...` to review/enroll the fingerprint, stop that foreground connection, then create the persistent session.

Connection Sessions are daemon-owned resources with explicit `live`, `closing` and `failed` states. A failed terminal record keeps the same Session ID and a normalized cleanup reason, but no longer advertises its old Endpoint as reachable. Running `easyserver sessions close <session-id>` again retries cleanup and removes the record on success. Failed records are intentionally ephemeral and bounded to the 100 most recent failures; older failures are pruned with one final best-effort cleanup attempt. Restarting the daemon does not pretend old dead sessions are still active.

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
