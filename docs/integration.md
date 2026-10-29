# Integration and update behavior

The source-build procedure and native validation checks are reusable across JavaScript projects that depend on `@lancedb/lancedb`. This repository's automated package discovery and repair commands currently implement the OpenLore adapter only. Supporting another host application requires adding a package-root adapter; the LanceDB Rust build itself does not depend on OpenLore.

## Options compared

| Option | Compatibility | Update resilience | Maintenance | Decision |
| --- | --- | --- | --- | --- |
| Publish a new `@lancedb/lancedb-darwin-x64` package | The loader supports the name, but publication and dependency resolution add a package-management step | The package is extraneous because upstream `optionalDependencies` omit it; npm updates may remove it | Medium | Not selected |
| Inject `dist/lancedb.darwin-x64.node` with a versioned repair tool | Uses an explicit first-choice path in the official v0.40.0 loader | Reapplied after npm updates; exact SDK version and checksum are checked | Low | Selected |
| npm alias, override, tarball dependency, or local registry | Depends on npm dependency resolution from OpenLore's global install | Not guaranteed to survive a global OpenLore update | High | Not selected |

The selected direct injection changes one generated native file under the installed SDK. It does not edit OpenLore JavaScript or package metadata. The installer keeps a sidecar marker with npm version, source commit, target triple, and SHA-256, and backs up a pre-existing module before replacement.

## Commands and state transitions

- `status`: compares OpenLore's declared dependency, resolved SDK, cache metadata, and installed module marker.
- `build`: selects the exact `v<version>` tag and creates a validated cache entry.
- `test`: runs a temporary vector database smoke test.
- `install`: backs up and atomically injects the matching binary, then tests it.
- `repair`: installs a matching cache entry, then tests. With no entry it exits without changes and prints the build command; `repair --build` opts into compilation.
- `restore`: restores the pre-install file or removes only the module managed by this tool.

An OpenLore update is an explicit npm operation followed by `repair`. The utility reads the dependency version after the update, so it never uses a build from another LanceDB version. The current global installation's `0.40.0` declaration / `0.22.4-beta.3` resolution mismatch makes `status` fail closed; reinstall a coherent OpenLore package before repairing that installation.

## Update simulations executed

1. **LanceDB unchanged after an npm reinstall:** an isolated OpenLore fixture was changed from `3.5.0` to `3.5.1`, kept the `0.40.0` dependency, and had the injected module removed. `repair` reused the already validated cache, installed the module, and passed the smoke test.
2. **LanceDB version changed / inconsistent install:** an isolated fixture declared `0.41.0` but resolved `0.40.0`. `repair` exited with a version mismatch, and the Intel module remained absent.
3. **No compatible build:** with an empty cache and no installed module, `repair` exited with `No validated build for LanceDB 0.40.0` and made no npm tree changes.
4. **Compilation failure:** `RUSTC_WRAPPER=/usr/bin/false` forced Cargo to fail in a clean target directory. The full error was written to the versioned build log, and no module was copied into the build cache.
5. **Repeated repair:** after a successful install, repeated `repair` reports the matching checksum and performs no additional backup; it reruns the smoke test.

The successful end-to-end integration was performed only in `/private/tmp/lancedb-intel-openlore`; the user's global OpenLore install and existing LanceDB data were left unchanged.
