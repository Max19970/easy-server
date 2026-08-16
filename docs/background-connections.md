# Background connections

Use the EasyServer daemon when a local connection should outlive the terminal/TUI that created it or be managed as background state.

There are two related concepts:

- a **Session** is one live daemon-owned connection for the current daemon lifetime;
- a **saved connection** (Endpoint intent in CLI terminology) is desired state that the daemon can realize again after restart.

If you only need a connection while one command is running, use [foreground `connect`](connections.md) instead.

## Start the managed daemon

For normal desktop and automation use:

```powershell
easyserver daemon start
```

Check health with:

```powershell
easyserver daemon status
```

`daemon start` is idempotent when the authenticated daemon is already healthy. It also handles a stale descriptor before launching a replacement managed process.

Use foreground mode only when debugging or when another process manager should own the daemon process:

```powershell
easyserver daemon run
```

That command stays in the current terminal. It is not the preferred ordinary desktop path.

Stop the managed daemon with:

```powershell
easyserver daemon stop
```

Stopping the daemon closes live local transports. It does **not** destroy compute resources. Saved connection definitions remain in Local State and can be realized again on the next daemon start.

## Create a background Session

With the daemon running:

```powershell
easyserver sessions create <instance-id> --port 8188
```

The same connection options used by foreground `connect` are available when relevant:

```powershell
easyserver sessions create <instance-id> \
  --port 8188 \
  --local-port 54321 \
  --access-method <method-id>
```

List current Sessions:

```powershell
easyserver sessions list
```

Close one explicitly:

```powershell
easyserver sessions close <session-id>
```

A failed Session keeps a bounded failure record so cleanup/recovery remains visible. Closing that failed Session retries cleanup and removes the record when cleanup succeeds.

## Make Session creation idempotent

Automation can attach a stable idempotency key:

```powershell
easyserver sessions create <instance-id> \
  --port 8188 \
  --idempotency-key comfyui-main
```

Retrying the same key with the same connection request reuses the same live Session instead of opening a duplicate. Reusing the key with different settings fails with a conflict.

Session idempotency is daemon-local. Closing the Session releases the key, and daemon restart does not preserve live Session identity.

## Save a connection across daemon restarts

Persist desired connection state with a named Endpoint intent:

```powershell
easyserver sessions intents create comfyui-main <instance-id> \
  --port 8188 \
  --local-port 54321
```

List saved definitions and their current realization state:

```powershell
easyserver sessions intents list
```

A saved definition can be `starting`, `live`, `error`, or `disabled`. Local State stores the desired instance/target/local-port/method settings and whether the definition is enabled; it does not persist an old live Session or pretend an old transport survived restart.

On daemon startup, enabled definitions are realized again from current provider state. One failing definition does not prevent healthy siblings from starting.

## Recover one failed saved connection

After fixing the cause — for example credentials, SSH trust, provider availability, service readiness, or a local-port conflict — retry only that saved definition:

```powershell
easyserver sessions intents retry comfyui-main
```

If first-use SSH trust is blocking it, the TUI can show **Review SSH fingerprint** for that saved connection, enroll the reviewed key through the same hardened trust path, and retry the same definition.

For non-interactive automation, `--json` exposes structured host-trust evidence. See [Machine-readable CLI output](cli-json.md#explicit-ssh-host-trust-for-automation).

## Disable, enable, or remove saved state

Temporarily stop realization without deleting the definition:

```powershell
easyserver sessions intents disable comfyui-main
easyserver sessions intents enable comfyui-main
```

Remove the desired definition entirely:

```powershell
easyserver sessions intents remove comfyui-main
```

Disable/remove closes only that definition's local transport. It does not stop or destroy the provider server.

## Configuration changes while the daemon is running

The running daemon reloads provider plugin enablement and credential bindings for **new** connection setup. Adding/enabling/disabling a plugin or rotating/removing a credential therefore does not require a daemon restart merely to affect future setup.

A connection that was already admitted keeps its runtime and is not torn down only because configuration later changed. If current provider configuration cannot support a new setup, that new setup fails explicitly while existing healthy Sessions can continue.

## Use SSH or SCP through a local Endpoint

EasyServer forwards raw TCP. You can therefore expose a server's own SSH service and then run a separate SSH/SCP client through the local listener.

Create a background connection to remote port 22:

```powershell
easyserver sessions create <instance-id> --host 127.0.0.1 --port 22
```

Suppose EasyServer reports `127.0.0.1:54322`. A second SSH client can use:

```powershell
ssh -p 54322 root@127.0.0.1
```

or:

```powershell
scp -P 54322 .\model.safetensors root@127.0.0.1:/root/
```

That *inner* SSH/SCP command owns its own authentication and host trust. EasyServer is only forwarding TCP bytes through its already established provider connection path.

## Destroying a server with background connections

Provider resource destruction and local connection cleanup are separate operations.

`instances destroy` refuses by default when the target still has daemon Sessions or enabled saved connection definitions. When you deliberately want EasyServer to close those local connections first and only then dispatch provider destruction, use the host-owned coordinated option documented by the command:

```powershell
easyserver instances destroy <instance-id> --close-sessions --yes
```

EasyServer disables relevant saved definitions and closes daemon Sessions before dispatching the remote destroy. If local cleanup fails, it does not proceed with the provider destroy.

Always follow the provider guide's cleanup rules when the goal is to stop paying for a resource:

- [Vast.ai](providers/vastai.md)
- [Intelion.cloud](providers/intelion.md)
