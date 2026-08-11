# Intelion.cloud quick start

The Intelion.cloud Provider Plugin keeps Intelion's catalog/configurator model provider-specific, then exposes created cloud servers through the shared EasyServer inventory, lifecycle and Endpoint surfaces.

## 1. Prepare the Intelion.cloud account

You need:

- an Intelion.cloud account with permission/quota to create the cloud-server configuration you select;
- an Intelion API token;
- a registered Intelion SSH public key if you want the created image to be reachable through SSH.

EasyServer imports the API token into its OS-backed Secret Store. It does not require the token in ordinary command arguments or Local State.

## 2. Install and register the plugin

If EasyServer itself was installed globally from npm, install the Intelion.cloud plugin into that same global npm environment:

```sh
npm install --global @easyai101/easyserver-plugin-intelion
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

If you use the portable GitHub Release ZIP, install the plugin into the extracted EasyServer prefix instead. Follow the prefix-aware commands in [Install from GitHub Releases](../github-release-install.md#add-a-provider-plugin-later).

Configure the API token:

```sh
export INTELION_API_TOKEN='<your-api-token>'
easyserver plugins credential set @easyai101/easyserver-plugin-intelion api-token --env INTELION_API_TOKEN
unset INTELION_API_TOKEN
```

PowerShell:

```powershell
$env:INTELION_API_TOKEN = '<your-api-token>'
easyserver plugins credential set @easyai101/easyserver-plugin-intelion api-token --env INTELION_API_TOKEN
Remove-Item Env:INTELION_API_TOKEN
```

Confirm the plugin is loaded and credential-ready:

```sh
easyserver plugins list
```

The Intelion.cloud plugin declares `api-token` as its required credential name. Before configuration, the status reports `credentials=missing:api-token`; after the opaque Secret Reference is bound, it reports `credentials=ready` without reading or printing the API token.

## 3. Discover the provider catalog

Intelion acquisition is exposed as the `server-configurator` Provider Feature.

Every first-party configurator command publishes its own argument help. For example:

```sh
easyserver provider intelion server-configurator os-images --help
easyserver provider intelion server-configurator create --help
```

List available flavors:

```sh
easyserver provider intelion server-configurator flavors
```

List OS images:

```sh
easyserver provider intelion server-configurator os-images
```

Limit images to one flavor when useful:

```sh
easyserver provider intelion server-configurator os-images --flavor <flavor-id>
```

List SSH keys already registered with Intelion:

```sh
easyserver provider intelion server-configurator ssh-keys
```

These commands print provider-owned JSON records. Use IDs returned by the same provider catalog when validating/creating a server.

## 4. Validate a server configuration

Required configuration fields are:

```text
--name <name>
--flavor <id>
--disk <gb>
--os <id>
```

Optional fields are:

```text
--price-plan <id>
--promocode <id>
--queue
--addon <id>       # repeatable
--ssh-key <id>     # repeatable
```

Network disk size must be at least 30 GB in the `0.1.0` plugin contract.

Validate before creating:

```sh
easyserver provider intelion server-configurator validate \
  --name easyserver-demo \
  --flavor <flavor-id> \
  --disk 30 \
  --os <os-image-id> \
  --ssh-key <ssh-key-id>
```

Validation is local/provider-contract validation and does not create a paid server.

## 5. Create the server

Use the same configuration with `create`:

```sh
easyserver provider intelion server-configurator create \
  --name easyserver-demo \
  --flavor <flavor-id> \
  --disk 30 \
  --os <os-image-id> \
  --ssh-key <ssh-key-id>
```

The create command is a mutation. If the request may have reached Intelion but the final response becomes uncertain, EasyServer reports `outcome-unknown`. Do not blindly issue another create; reconcile first:

```sh
easyserver instances list
```

A successful create is refreshed into the shared EasyServer inventory. Some provider-side transitions are asynchronous, so use the inventory rather than assuming the server is immediately ready for every action/access path.

## 6. Inspect and manage the server

```sh
easyserver instances list
easyserver instances inspect <instance-id>
```

Use lifecycle operations only when the current snapshot lists them as available:

```sh
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

Provider lifecycle state and billing state are deliberately separate concepts. Do not assume `stopped` means the resource has no remaining charges.

## 7. Connect to a workload

When an SSH-enabled image has active connection metadata, EasyServer can expose remote TCP services through its generic SSH Access Adapter.

For a workload on the server's `127.0.0.1:8188`:

```sh
easyserver connect <instance-id> --port 8188
```

EasyServer prints a dynamically allocated local loopback Endpoint such as `127.0.0.1:54321`. Use that local address while the foreground command remains open.

On first access, inspect and explicitly confirm the SSH host fingerprint. EasyServer never silently replaces a changed trusted key.

For a persistent daemon-owned Endpoint, first establish trust interactively if needed, then:

```sh
easyserver daemon run
# in another terminal:
easyserver sessions create <instance-id> --port 8188
easyserver sessions list
```

Close it with:

```sh
easyserver sessions close <session-id>
```

## 8. Clean up paid resources

When the server is no longer needed:

1. close EasyServer Connection Sessions using it;
2. destroy the Compute Instance if you intend to remove the Intelion cloud server;
3. refresh inventory and verify the provider has converged to the expected terminal/absent state;
4. only then remove/disable local plugin configuration if desired.

```sh
easyserver instances destroy <instance-id>
easyserver instances list
```

Removing the local API-token reference or disabling the plugin does **not** destroy a paid Intelion resource.
