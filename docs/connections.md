# Connect to a remote service

EasyServer can expose a TCP service running on a managed server as a loopback address on your own machine.

```text
server:127.0.0.1:8188  →  EasyServer  →  127.0.0.1:54321
```

The ordinary TUI flow hides transport details until they matter. This guide explains the connection model, CLI equivalents, first-use SSH trust, and the main recovery paths.

## Open a foreground connection

In the TUI, open **Servers**, select a fresh server, and choose **Connect**. Enter the application/service port running on that server.

The CLI equivalent is:

```powershell
easyserver connect <instance-id> --port 8188
```

On success EasyServer prints a local address such as:

```text
127.0.0.1:54321
```

The foreground command owns that local connection until it exits. Press `Ctrl+C` when you are finished.

## Remote port vs local port

`--port` is the TCP port **on the remote target**. If your workload listens on the rented server at `127.0.0.1:8188`, use:

```powershell
easyserver connect <instance-id> --port 8188
```

The remote target host defaults to `127.0.0.1`. Advanced callers can change it:

```powershell
easyserver connect <instance-id> --host 127.0.0.1 --port 8188
```

The local listener is always loopback-only. By default EasyServer chooses an available local port dynamically.

Request a stable local port when another local tool needs a fixed address:

```powershell
easyserver connect <instance-id> --port 8188 --local-port 54321
```

If that local port is occupied, EasyServer reports a conflict rather than silently selecting another port.

## First-use SSH host trust

SSH-backed connection methods require explicit host trust.

When EasyServer sees a host for the first time, the interactive flow shows:

- SSH host and port;
- host-key type;
- SHA-256 fingerprint.

The trust screen defaults to **Decline**. Choosing **Trust** enrolls only the reviewed key after EasyServer revalidates that the same preferred key is still presented.

EasyServer keeps its own SSH trust store at `~/.easyserver/known_hosts`. Trust accepted by a separate `ssh` command is not imported automatically.

A changed key for an already trusted host fails closed. Do not treat it as a new first-use prompt: verify whether the server was legitimately replaced or reinstalled before removing an old trusted entry.

### When `ssh-keyscan` cannot obtain the fingerprint

EasyServer normally uses `ssh-keyscan` to observe a first-use host key. If every configured scanner fails but the configured OpenSSH client can still complete key exchange, EasyServer can perform a bounded, commandless OpenSSH handshake using an isolated temporary `known_hosts` file.

That fallback only obtains evidence for review. The temporary file is deleted and never becomes permanent trust. Explicit approval and fresh exact revalidation are still required before EasyServer writes its own trust store.

If neither path can obtain a fingerprint, EasyServer reports that it cannot safely offer a trust action. Retry if the server may still be starting and use Diagnostics to check local SSH tooling.

## SSH authentication is separate from provider API authentication

A provider API credential can be valid while the SSH login still fails.

For example, Vast.ai SSH access normally depends on an account-level public key plus a matching local private identity that OpenSSH can discover. Intelion.cloud can resolve a server-specific password through its API after host trust succeeds.

The TUI therefore distinguishes SSH authentication failures from provider credential failures instead of telling you to rotate a working provider API token/key.

See the provider-specific connection requirements:

- [Vast.ai](providers/vastai.md#connect-to-a-service)
- [Intelion.cloud](providers/intelion.md#connect-to-a-service)

## Connection methods

A provider can advertise more than one TCP-forward connection method. Ordinary TUI use chooses a supported method for you.

Inspect available methods from the CLI when you need control over the route:

```powershell
easyserver instances access-methods <instance-id>
```

Choose one explicitly with:

```powershell
easyserver connect <instance-id> --port 8188 --access-method <method-id>
```

If the requested method is unavailable, EasyServer fails instead of silently switching to another one.

The provider-facing connection method and the local address are different concepts: the method describes how EasyServer reaches the server; the local address is the loopback listener your application uses.

## Understand connection failures

EasyServer classifies the layer that failed whenever it can do so safely.

### Host fingerprint unavailable

EasyServer could not obtain SSH host-key evidence through either keyscan or its isolated handshake fallback. If the server was just created, wait briefly and retry. If direct SSH works consistently, open Diagnostics and check the local OpenSSH tools.

### Host key changed

The server presents a different key from the one EasyServer already trusts. This remains fail-closed. Verify server identity before changing trust state.

### SSH authentication rejected

The SSH route was reached, but the login credential was rejected. Check the provider-specific SSH credential path rather than assuming the provider API credential is wrong.

### TCP forwarding is not permitted

SSH login succeeded, but the SSH server refused the forwarding channel. Choose another supported connection method when one exists or change the server's SSH forwarding policy.

### Service port refused

SSH works, but nothing is accepting the requested application/service port. Start the workload, wait for it to become ready, or use **Edit service port**.

### Remote target unreachable or timed out

SSH works, but the requested target cannot be reached from the server. Verify the workload's bind address, port, firewall/network path, and selected remote host.

### Local port conflict

The requested `--local-port` is already in use on your machine. Choose another local port or let EasyServer allocate one dynamically.

Late failures remain visible in **Connections** instead of disappearing after the local listener was first published. Retry uses the retained request; editing the service/local port preserves the other fields.

## Diagnostics and privacy

**Settings & Support → Diagnostics** shows a sanitized support report about current EasyServer, provider, daemon, and SSH-tool readiness.

EasyServer does not keep arbitrary raw OpenSSH stderr as normal TUI state, and the Diagnostics report does not claim to contain raw output from a previous failed connection attempt. This avoids turning support surfaces into a secret or provider-response dump.

## Need the connection to survive this terminal?

Foreground `connect` is intentionally owned by the current process/TUI lifetime. For daemon-owned background connections and definitions that can be recreated after restart, continue with [Background connections](background-connections.md).
