# Getting started with EasyCompute

EasyCompute is a provider-independent CLI for acquiring, managing and locally accessing rented compute. Provider-specific acquisition stays in separately installed Provider Plugins; after a resource exists, EasyCompute exposes a shared inventory/lifecycle/connectivity surface.

## Requirements

EasyCompute `0.1.x` is released for Node.js `24.18.1` with npm `11.16.0`. See [Supported platforms](supported-platforms.md) for the operating systems and OS integrations qualified for the release.

EasyCompute's built-in SSH access uses the system OpenSSH client. If you plan to connect to SSH-backed resources, `ssh` and `ssh-keyscan` must be available on `PATH`.

## Install the CLI

```sh
npm install --global @easycompute/cli
```

A default CLI installation contains **no Provider Plugins**:

```sh
easycompute plugins list
```

The expected initial result is `No provider plugins configured.` Install only the providers you want to use. For example:

```sh
npm install --global @easycompute/plugin-vastai
easycompute plugins add @easycompute/plugin-vastai
```

or:

```sh
npm install --global @easycompute/plugin-intelion
easycompute plugins add @easycompute/plugin-intelion
```

Inspect plugin state at any time:

```sh
easycompute plugins list
```

`plugins disable` stops new work from being admitted to a configured plugin; `plugins enable` admits new work again. Disabling a plugin is not the same as destroying provider resources.

## Configure a provider credential

EasyCompute imports credentials from an environment variable into the OS-backed Secret Store. The environment variable is only the transfer channel; normal EasyCompute Local State stores an opaque `secret:<uuid>` reference rather than the credential value.

Vast.ai example in a POSIX shell:

```sh
export VAST_API_KEY='<your-api-key>'
easycompute plugins credential set @easycompute/plugin-vastai api-key --env VAST_API_KEY
unset VAST_API_KEY
```

PowerShell equivalent:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easycompute plugins credential set @easycompute/plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Intelion.cloud uses credential name `api-token`:

```sh
export INTELION_API_TOKEN='<your-api-token>'
easycompute plugins credential set @easycompute/plugin-intelion api-token --env INTELION_API_TOKEN
unset INTELION_API_TOKEN
```

Do not pass provider credentials as ordinary CLI arguments or save them in repository files.

## Acquire compute

Acquisition is intentionally provider-specific. Vast.ai exposes marketplace search/rental; Intelion.cloud exposes its own server catalog/configurator. EasyCompute does not force both providers into a lossy universal `create` request.

Follow one of the provider guides:

- [Vast.ai quick start](providers/vastai.md)
- [Intelion.cloud quick start](providers/intelion.md)

After acquisition converges into provider inventory, the resource appears as an EasyCompute Compute Instance:

```sh
easycompute instances list
easycompute instances inspect <instance-id>
```

Use the EasyCompute `instance-id` shown by these commands for lifecycle and connectivity commands. Provider-specific external IDs remain plugin-owned reconciliation identity.

## Lifecycle

A provider advertises which normalized lifecycle operations it supports, and each instance snapshot reports which of those operations are currently available.

```sh
easycompute instances start <instance-id>
easycompute instances stop <instance-id>
easycompute instances restart <instance-id>
easycompute instances destroy <instance-id>
```

An unavailable action is rejected rather than guessed from generic state. Also, `stopped` does **not** universally mean `not billed`; provider billing/storage/reservation semantics remain provider-specific. When a rented resource is no longer needed, follow the provider guide and verify the destructive cleanup required by that provider.

## Expose a remote TCP service locally

`connect` exposes one remote TCP target as an EasyCompute-owned local loopback Endpoint:

```sh
easycompute connect <instance-id> --port 8188
```

`--port` is the port **on the remote target**. `--host` is the remote target host as reached from the compute resource and defaults to `127.0.0.1`:

```sh
easycompute connect <instance-id> --host 127.0.0.1 --port 8188
```

On success EasyCompute prints a local address such as:

```text
127.0.0.1:54321
```

The local port is allocated dynamically. If a remote application such as ComfyUI is listening on `127.0.0.1:8188`, open `http://127.0.0.1:54321` locally. EasyCompute `0.1.0` provides raw TCP forwarding; it does not add HTTP path routing such as `/comfyui`.

The foreground command owns the Endpoint until it is cancelled. Press Ctrl+C when finished.

### First SSH connection and host trust

If the selected access path uses SSH and the host key is unknown, foreground `connect` displays the exact host-key fingerprint and asks for explicit confirmation. Only explicit confirmation enrolls that key, then EasyCompute retries once. Declining leaves it untrusted. A changed key fails closed rather than being silently replaced.

Passwords/private identities are resolved only after host trust succeeds.

## Persistent Endpoints with the local daemon

Run the daemon in one terminal:

```sh
easycompute daemon run
```

Then create a daemon-owned Connection Session from another terminal:

```sh
easycompute sessions create <instance-id> --port 8188
```

The command prints a session ID and its local Endpoint. Inspect and close sessions with:

```sh
easycompute sessions list
easycompute sessions close <session-id>
```

The daemon's connection setup is non-interactive and never auto-trusts an unknown SSH host. For a new SSH host, first use foreground `easycompute connect ...` to review/enroll the fingerprint, stop that foreground connection, then create the persistent session.

Connection Sessions are live daemon-owned resources. Restarting the daemon does not pretend old dead sessions are still active.

## SSH and SCP through an EasyCompute Endpoint

An Endpoint can forward any TCP port, including an SSH service. First establish host trust for the provider access path if needed, then create a persistent Endpoint to the compute resource's SSH port:

```sh
easycompute sessions create <instance-id> --host 127.0.0.1 --port 22
```

Suppose EasyCompute reports `127.0.0.1:54322`. You can then make a second SSH connection through that local Endpoint:

```sh
ssh -p 54322 root@127.0.0.1
```

or copy a file through it:

```sh
scp -P 54322 ./model.safetensors root@127.0.0.1:/root/
```

The credentials and host trust for this *inner* SSH connection are handled by your `ssh`/`scp` command; EasyCompute is forwarding raw TCP bytes to the remote SSH service.

## Remove a configured credential

```sh
easycompute plugins credential remove @easycompute/plugin-vastai api-key
easycompute plugins credential remove @easycompute/plugin-intelion api-token
```

Removing a local credential does not destroy any paid provider resource. Clean up provider resources first when appropriate.
