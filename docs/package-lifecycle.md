# Package lifecycle: upgrades, reinstalls and uninstall

EasyServer keeps user state separate from the installed npm package. Ordinary package-manager operations must therefore change installed code without silently changing the remote resources or supported Local State that belong to the user.

This document defines the package-lifecycle contract for the current `0.2.x` compatibility line. The general compatibility rules remain defined in [Versioning and compatibility](versioning-and-compatibility.md).

## Compatible upgrades and reinstalls

A compatible `0.2.x` upgrade or reinstall must preserve valid state created by an earlier `0.2.x` release. The `0.2.0` transition also accepts valid `0.1.x` Local State; users do not need to delete or recreate state to adopt the new TUI entrypoint or Plugin SDK line.

- Local State remains in the configured `EASYSERVER_STATE_FILE` or, by default, `~/.easyserver/state.json`; it is not stored inside the npm package directory.
- Canonical `instance:<uuid>` identities, Provider Plugin registrations and opaque credential Secret References remain unchanged unless the user performs an operation that intentionally changes them.
- Secret values remain in the operating-system Secret Store. EasyServer stores only their opaque `secret:<uuid>` references in Local State, and the `0.2.x` line keeps the same EasyServer keyring service identity so those references continue to address the same credentials.
- A package reinstall must not be treated as a state reset. Deleting Local State to make an upgrade work is not an acceptable migration.
- State-format changes within `0.2.x` must be additive or transparently backward-compatible. Add a migration only when an actual format change requires one.

Provider Plugins are separately installed packages. Reinstalling or upgrading the core CLI does not implicitly install, upgrade or remove them.

## Missing, removed or incompatible Provider Plugins

A configured Provider Plugin may temporarily be unavailable because its package was removed, its module cannot be loaded, or its declared compatibility range does not accept the installed EasyServer/Plugin SDK version.

EasyServer treats that as a plugin availability failure, not as permission to rewrite user state:

- `easyserver plugins list` reports the configured plugin as `failed` with the load/compatibility reason when the plugin cannot be admitted.
- Other healthy configured plugins remain independently loadable.
- The persisted plugin registration, its credential Secret References and canonical instance bindings are retained.
- Removing and later reinstalling a compatible plugin therefore restores the same configured relationship instead of requiring the user to recreate it.
- EasyServer does not interpret an unavailable plugin as evidence that its provider resources disappeared.

When intentionally replacing a plugin with a version from a different compatibility line, follow that release's migration guidance rather than forcing the old plugin into the host.

## Uninstall

Uninstalling `@easyai101/easyserver` or a Provider Plugin removes installed package code only.

EasyServer has no package-manager uninstall hook that destroys provider resources, deletes Local State or removes OS-keyring credentials. In particular:

- uninstalling the CLI never issues provider `stop`, `destroy`, release or equivalent remote mutations;
- uninstalling a Provider Plugin never destroys resources belonging to that provider;
- Local State remains available for a later compatible reinstall;
- credentials remain in the OS Secret Store unless the user explicitly removes them through EasyServer before uninstalling or removes them through the operating system afterward.

Remote compute can continue to exist and incur provider charges after EasyServer is uninstalled. Users must explicitly destroy or otherwise release billable provider resources before uninstalling if that is their intent.

## Clean removal when desired

If the goal is to stop using EasyServer completely rather than merely uninstall its package:

1. Inspect and explicitly stop/destroy/release any remote resources that should no longer exist, following the provider's billing semantics.
2. Remove configured credentials that should be deleted from the OS Secret Store while EasyServer is still installed.
3. Uninstall separately installed Provider Plugin packages and the EasyServer CLI.
4. Delete `~/.easyserver` only when the remaining Local State, canonical identities and recovery information are no longer needed.

Never use deletion of Local State as a substitute for remote resource cleanup: deleting a local record does not delete the provider resource it describes.
