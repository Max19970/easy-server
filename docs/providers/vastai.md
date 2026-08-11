# Vast.ai quick start

The Vast.ai Provider Plugin keeps marketplace-specific search/rental behavior outside EasyServer core, then exposes rented instances through the shared EasyServer inventory, lifecycle and Endpoint surfaces.

## 1. Prepare the Vast.ai account

You need:

- a Vast.ai account able to rent instances;
- a Vast.ai API key with the permissions required for the operations you plan to use;
- an SSH public key registered at the **account** level before renting SSH-backed instances you want EasyServer to access.

Vast.ai account SSH keys are the normal one-time account preparation path for new instances. EasyServer does not require you to manually attach a key to every newly rented instance after that account-level key is prepared. Keep the corresponding private key only on the client machine; never paste it into repository files.

For Vast.ai in EasyServer `0.1.0`, that private key must also be discoverable by the system OpenSSH client through a standard identity file such as `~/.ssh/id_ed25519` or through `ssh-agent`. EasyServer's managed SSH path does not read your user `~/.ssh/config`, so an `IdentityFile` configured only there is not sufficient by itself.

If you add/change an account SSH key after an instance already exists, Vast.ai may require provider-side handling for that existing instance. The EasyServer workflow below assumes account preparation happens before rental.

## 2. Install and register the plugin

If EasyServer itself was installed globally from npm, install the Vast.ai plugin into that same global npm environment:

```sh
npm install --global @easyai101/easyserver-plugin-vastai
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

If you use the portable GitHub Release ZIP, install the plugin into the extracted EasyServer prefix instead. Follow the prefix-aware commands in [Install from GitHub Releases](../github-release-install.md#add-a-provider-plugin-later).

Configure the Provider API key through the OS-backed Secret Store:

```sh
export VAST_API_KEY='<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
unset VAST_API_KEY
```

PowerShell:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Confirm the plugin is loaded and credential-ready:

```sh
easyserver plugins list
```

The Vast.ai plugin declares `api-key` as its required credential name. Before configuration, the status reports `credentials=missing:api-key`; after the opaque Secret Reference is bound, it reports `credentials=ready` without reading or printing the API key.

## 3. Search the marketplace

Vast.ai acquisition is a Provider Feature named `marketplace`. Its command-specific arguments are discoverable directly from the CLI:

```sh
easyserver provider vastai marketplace search --help
easyserver provider vastai marketplace rent --help
```

For example, search the marketplace with:

```sh
easyserver provider vastai marketplace search \
  --gpu 'RTX 4090' \
  --min-gpus 1 \
  --max-hourly 0.50 \
  --min-reliability 0.95 \
  --verified \
  --limit 10
```

All filters are Vast-specific. Omit the ones you do not need. `--min-reliability` is a value from `0` to `1`; `--max-hourly` is the maximum total hourly price accepted by the plugin.

The command prints JSON offers. Select a returned offer ID; do not invent an ID from a different marketplace view because the rental mutation is intentionally tied to Vast.ai's own offer model.

## 4. Rent an offer

At minimum rental requires an offer ID and provider-compatible image:

```sh
easyserver provider vastai marketplace rent <offer-id> --image <image>
```

Optional rental arguments are:

```text
--disk <gb>
--runtype <ssh|jupyter|args|ssh_proxy|ssh_direct|jupyter_proxy|jupyter_direct>
--label <label>
```

Example SSH-oriented rental:

```sh
easyserver provider vastai marketplace rent <offer-id> \
  --image <image> \
  --disk 40 \
  --runtype ssh \
  --label easyserver-demo
```

The rental command is billable and therefore uses EasyServer's host-owned safety gate. In an interactive terminal confirm the displayed provider/consequence prompt. Non-interactive automation must put `--yes` immediately after `rent`, before the provider-owned arguments:

```sh
easyserver provider vastai marketplace rent --yes <offer-id> --image <image>
```

If transport/cancellation happens after the request may have been dispatched, EasyServer can report `outcome-unknown` rather than pretending the rental definitely failed. In that case **do not blindly retry**; refresh inventory first:

```sh
easyserver instances list
```

A successful rental is reconciled into the shared EasyServer inventory.

## 5. Inspect and manage the instance

```sh
easyserver instances list
easyserver instances inspect <instance-id>
```

Use only lifecycle actions shown as available for the current instance. Depending on the Vast.ai state, these may include:

```sh
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

A stopped allocation can still have provider billing/resource implications. Treat `destroy` as the cleanup operation when you intend to release the rented resource, and verify the resource disappears or reaches the provider's terminal state before assuming billing has ended.

## 6. Connect to a workload

For a workload listening on remote loopback port `8188`:

```sh
easyserver connect <instance-id> --port 8188
```

EasyServer prints a dynamically allocated local loopback Endpoint such as `127.0.0.1:54321`. Use that local address while the foreground command stays open.

On first SSH-backed access, review the exact host fingerprint EasyServer shows. Explicit confirmation enrolls it; decline leaves it untrusted; a later changed key fails closed.

For daemon-owned persistent forwarding, first establish host trust interactively if needed, then:

```sh
easyserver daemon run
# in another terminal:
easyserver sessions create <instance-id> --port 8188
easyserver sessions list
```

Close the session when finished:

```sh
easyserver sessions close <session-id>
```

## 7. Clean up paid resources

When the rental is no longer needed:

1. close EasyServer Connection Sessions using it;
2. destroy the Compute Instance if you intend to release the Vast.ai rental;
3. refresh `easyserver instances list` and verify the resource no longer appears as a live allocation;
4. only then remove/disable local plugin configuration if desired.

```sh
easyserver instances destroy <instance-id>
easyserver instances list
```

Removing the local API-key reference or disabling the plugin is **not** a substitute for provider-side resource destruction.
