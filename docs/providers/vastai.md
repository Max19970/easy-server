# Use EasyServer with Vast.ai

The Vast.ai Provider Plugin keeps marketplace-specific search and rental inside the provider, then exposes rented machines through EasyServer's shared server lifecycle and local connection workflows.

This guide owns Vast.ai-specific account preparation, rental options, SSH requirements, and cleanup semantics.

## Prepare your Vast.ai account

You need:

- a Vast.ai account that can rent instances;
- a Vast.ai API key with the permissions required for the operations you plan to use;
- an SSH public key registered at the **account level** before renting SSH-backed instances that EasyServer should access.

Account-level SSH key setup is the normal one-time preparation path. You should not need to manually attach the same key to every new instance after rental.

Keep the corresponding private key on your client machine. EasyServer's Vast.ai SSH route relies on the system OpenSSH client finding that identity through a standard identity file (for example `~/.ssh/id_ed25519`) or `ssh-agent`.

EasyServer's managed SSH path does not read your user `~/.ssh/config`, so an `IdentityFile` configured only there is not sufficient by itself.

If you change the account SSH key after an instance already exists, provider-side handling may be needed for that existing instance. The normal EasyServer flow assumes account preparation happens before rental.

## Install and add the plugin

For a global npm installation:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
easyserver
```

Then open **Settings & Support → Providers → Add installed provider** and choose **Vast.ai**.

If you use the portable GitHub Release ZIP, install the plugin into that extracted EasyServer prefix instead. Follow [Install from GitHub Releases](../github-release-install.md#add-a-provider-plugin-later).

For CLI/automation setup, register the installed package explicitly:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

## Configure the API key

The TUI exposes the provider's declared `api-key` credential under its Actions menu and stores the value through EasyServer's OS-backed Secret Store.

For automation, import the key from an environment variable instead of placing it in ordinary command arguments:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Check readiness with:

```powershell
easyserver plugins list
```

Before configuration the provider reports `credentials=missing:api-key`; afterward it reports `credentials=ready` without printing the secret value.

## Rent from the marketplace

In the TUI, choose **Rent a server** and select Vast.ai.

The guided marketplace flow supports:

- GPU model;
- minimum GPU count;
- maximum total hourly price;
- minimum reliability;
- verified-only hosts;
- result limit.

**Choose GPU model** can load current rentable GPU names so ordinary use does not depend on memorized spelling. Manual entry remains available if the live suggestions are unavailable or do not include the model you want.

After you choose an offer, the rental flow exposes image, disk size, runtype, and label. The TUI uses `ubuntu:22.04` as a practical default image; change it when your workload needs another Docker/OCI image.

Billable rental always goes through EasyServer's host-owned confirmation screen.

### CLI marketplace search

Discover the current command contract with:

```powershell
easyserver provider vastai marketplace search --help
easyserver provider vastai marketplace rent --help
```

Example search:

```powershell
easyserver provider vastai marketplace search `
  --gpu 'RTX 4090' `
  --min-gpus 1 `
  --max-hourly 0.50 `
  --min-reliability 0.95 `
  --verified `
  --limit 10
```

All of these filters are Vast.ai-specific. `--min-reliability` uses a value from `0` to `1`; `--max-hourly` is the maximum total hourly price accepted by the plugin.

### CLI rental

Rent an offer returned by the Vast.ai marketplace:

```powershell
easyserver provider vastai marketplace rent <offer-id> `
  --image ubuntu:22.04 `
  --disk 40 `
  --runtype ssh `
  --label easyserver-demo
```

Supported runtype values in the `0.2.x` plugin include:

```text
ssh
jupyter
args
ssh_proxy
ssh_direct
jupyter_proxy
jupyter_direct
```

Interactive command mode asks for confirmation. Non-interactive automation must opt in explicitly:

```powershell
easyserver provider vastai marketplace rent --yes <offer-id> --image ubuntu:22.04
```

If EasyServer reports `outcome-unknown`, the request may have reached Vast.ai even though the final response was lost. Do **not** blindly repeat the billable rental; refresh inventory first:

```powershell
easyserver instances list
```

## Manage the rented server

After the provider refresh observes the rental, it appears in **Servers** and in the shared CLI inventory:

```powershell
easyserver instances list
easyserver instances inspect <instance-id>
```

Only use lifecycle actions that the current server snapshot exposes. Depending on provider state, these can include:

```powershell
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

A stopped Vast.ai allocation can still have billing/resource implications. Treat provider state and billing state as separate concepts.

## Connect to a service

When your workload is listening on the rented machine, choose **Connect** from the server in the TUI and enter the workload's application/service port.

CLI example for remote port `8188`:

```powershell
easyserver connect <instance-id> --port 8188
```

EasyServer publishes a local loopback address such as `127.0.0.1:54321` while the connection is active.

### Vast.ai SSH identity requirement

A successful Vast.ai API key does not prove the SSH login identity is available locally. The account-level public key must correspond to a private key that the system OpenSSH client can actually use through a standard identity location or `ssh-agent`.

On first use EasyServer shows the provider route's exact SSH host-key fingerprint and requires explicit trust. EasyServer's trust store is separate from a fingerprint accepted in an independent `ssh` command.

If SSH works but the application port does not, EasyServer reports the service-layer failure separately and lets you edit the service port or retry the retained request.

See [Connect to a remote service](../connections.md) for the full connection model and [Background connections](../background-connections.md) for daemon-managed access.

## Clean up the rental

When you no longer need the paid resource:

1. Close any EasyServer foreground/background connections you no longer need.
2. Destroy the server if your intent is to release the Vast.ai rental.
3. Refresh inventory and verify that the provider has converged to the expected terminal/absent state.
4. Only then remove or disable local provider configuration if desired.

```powershell
easyserver instances destroy <instance-id>
easyserver instances list
```

Disabling the plugin, removing the API-key reference, stopping the EasyServer daemon, or merely closing the TUI does **not** destroy the Vast.ai rental.
