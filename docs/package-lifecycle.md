# Upgrade, reinstall, or uninstall EasyServer

EasyServer keeps user state and provider resources separate from installed package files. Package-manager operations therefore change local code; they do not silently destroy remote servers or reset supported EasyServer state.

The compatibility rules behind these operations are defined in [Versioning and compatibility](versioning-and-compatibility.md).

## Upgrade or reinstall within `0.2.x`

A compatible `0.2.x` upgrade/reinstall preserves valid supported state from the same compatibility line. EasyServer `0.2.0` also accepts valid `0.1.x` Local State.

In normal configuration:

- Local State lives at `~/.easyserver/state.json` (or the configured `EASYSERVER_STATE_FILE`), outside the npm package directory;
- canonical EasyServer instance identities and configured provider registrations stay in Local State;
- credential values stay in the operating-system Secret Store;
- Local State keeps opaque Secret References rather than raw credential values;
- reinstalling the package is not a state reset.

Deleting Local State to make a compatible upgrade work is not an acceptable migration strategy.

Provider Plugins are separate packages. Updating the core CLI does not automatically install, upgrade, or remove them.

## If a configured Provider Plugin is missing or incompatible

A registered provider package can temporarily fail to load because it was removed, its module is broken, or its declared EasyServer/Plugin SDK compatibility does not accept the installed versions.

EasyServer treats this as provider availability failure, not as evidence that the user's provider resources or configuration disappeared.

- `easyserver plugins list` reports the configured plugin as failed with a privacy-safe load/compatibility reason.
- Other healthy providers remain independently usable.
- The plugin registration, credential Secret References, and canonical instance bindings remain persisted.
- Reinstalling a compatible plugin can restore the same configured relationship.

Do not delete state or recreate provider resources simply because the local plugin package is temporarily unavailable.

## Reinstall one provider package

For an npm-global installation, reinstall the matching compatible plugin in the same global package environment as EasyServer:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai@^0.2.0
# or
npm install --global @easyai101/easyserver-plugin-intelion@^0.2.0
```

For a portable ZIP installation, install the provider into that extracted prefix instead. See [Install from GitHub Releases](github-release-install.md#add-a-provider-plugin-later).

The provider remains configured in EasyServer Local State unless you explicitly remove its registration.

## Uninstalling packages does not clean up provider resources

Uninstalling `@easyai101/easyserver` or a Provider Plugin removes installed package code only.

EasyServer intentionally has no package-manager uninstall hook that destroys provider resources, removes Local State, or deletes Secret Store entries.

In particular:

- uninstalling the core CLI never issues provider stop/destroy/release operations;
- uninstalling a Provider Plugin never destroys that provider's servers;
- Local State remains available for a later compatible reinstall;
- credentials remain in the OS Secret Store unless you explicitly remove them.

Remote compute can continue to exist and incur charges after the local package is gone.

## Remove a credential before uninstalling

When you deliberately want the credential removed from EasyServer's Secret Store relationship, do it while the CLI is still installed:

```powershell
easyserver plugins credential remove @easyai101/easyserver-plugin-vastai api-key
easyserver plugins credential remove @easyai101/easyserver-plugin-intelion api-token
```

Removing a local credential still does not destroy a provider resource.

## Clean removal

If your goal is to stop using EasyServer completely:

1. Inspect the provider resources you still own.
2. Destroy/release every paid resource you no longer want, following the provider guide's billing semantics.
3. Verify provider convergence to the intended terminal/absent state.
4. Close/disable any background connections you no longer need.
5. Remove provider credentials from EasyServer if you want them deleted from the OS Secret Store relationship.
6. Uninstall Provider Plugin packages and the core CLI.
7. Delete `~/.easyserver` only when you no longer need its Local State, identities, trust data, or recovery information.

Provider-specific cleanup:

- [Vast.ai](providers/vastai.md#clean-up-the-rental)
- [Intelion.cloud](providers/intelion.md#clean-up-the-server)

Never use deletion of Local State as a substitute for provider cleanup. Deleting a local record cannot delete the remote resource it described.
