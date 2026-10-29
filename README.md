# LanceDB Intel: macOS Native Build Recipes

Build the official `@lancedb/lancedb` Node binding for macOS Intel from upstream source. The compilation steps, binary checks, and vector smoke test are reusable by other JavaScript projects that use LanceDB. The included installation and repair adapter currently targets npm-installed OpenLore, the first end-to-end integration. All native builds target `darwin-x64`.

The tested combination is OpenLore `3.5.0`, LanceDB `0.40.0`, macOS `15.8`, Node `24.20.0`, and Rust `1.98.1`. The first upstream release build took **102 minutes** on this Intel Mac and produced a 192 MB `.node` module. Later builds with the same Cargo cache took under two seconds. `protoc` is required; Homebrew built it from source on this Intel host.

## Prerequisites

- macOS Intel, with Node.js and npm running as `darwin-x64`.
- Rust stable and Cargo.
- Xcode Command Line Tools.
- `protoc` (for example, `brew install protobuf`).
- Network access for the first clone and Cargo crate downloads.

Check the active runtime before building:

```sh
uname -m
node -p "process.platform + '-' + process.arch"
node --version
npm --version
rustc --version
protoc --version
```

## OpenLore integration adapter

The CLI currently discovers the LanceDB dependency through an OpenLore installation. Its `install` and `repair` commands inject the matching native module into that SDK package. Other projects can reuse the source-build and validation recipe, but need their own package discovery and install adapter; generic project-root support is not implemented yet.

## Commands

Run the utility from this folder or through the shell wrappers:

```sh
./lancedb-intel status
./lancedb-intel build
./lancedb-intel install
./lancedb-intel test
./lancedb-intel repair
./lancedb-intel restore
```

`build` reads the required LanceDB version from the installed OpenLore package. It clones the official `lancedb/lancedb` tag `v<version>`, builds `lancedb-nodejs` for `x86_64-apple-darwin`, checks the Mach-O architecture and dynamic libraries, then runs the isolated vector smoke test. It stores the module, metadata, logs, and any Cargo lockfile sync patch under:

```text
~/.local/share/lancedb-intel/
  builds/<version>/
  logs/
  patches/
  backups/<version>/
```

Set `LANCEDB_INTEL_HOME` to use another cache directory. `OPENLORE_ROOT` can point at a specific npm package directory for an isolated install or a nonstandard npm prefix. To build from an existing official checkout, pass `--source /path/to/lancedb-checkout`.

`install` writes only `@lancedb/lancedb/dist/lancedb.darwin-x64.node` and a companion metadata file. It first saves any existing binary and marker under the cache's `backups/` directory. The official LanceDB loader checks this local filename before loading its platform package, so no OpenLore source or published JavaScript file is changed. Installation is atomic and repeated runs are idempotent. A functional smoke test runs immediately after installation; if it fails, the tool automatically restores the previous file or removes the newly added module.

`repair` reuses a validated cache entry only when its npm version matches the currently resolved LanceDB version. If no matching build exists, it prints the exact build command and exits without changing the npm installation. To opt into building during repair, pass `--build`.

`test` runs `tests/smoke-test.mjs` against the installed module. The test uses a fresh temporary LanceDB database, creates a table, inserts vectors, searches, closes and reopens the database, then removes only its temporary directory.

## Get a published Intel binary (recommended)

Use the prebuilt binary from the GitHub Release for the exact LanceDB version required by your OpenLore installation. This is the normal path; it does not compile LanceDB. The private repository requires GitHub CLI authentication with read access:

~~~sh
OPENLORE_ROOT="$(npm root -g)/openlore"
LANCEDB_VERSION="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.optionalDependencies?.["@lancedb/lancedb"] ?? p.dependencies?.["@lancedb/lancedb"] ?? "")' "$OPENLORE_ROOT/package.json")"
CACHE="$HOME/.local/share/lancedb-intel/builds/$LANCEDB_VERSION"
TAG="lancedb-$LANCEDB_VERSION-darwin-x64"
mkdir -p "$CACHE"
gh release download "$TAG" --repo laurentftech/lancedb-intel --dir "$CACHE" \
  --pattern 'lancedb.darwin-x64.node' \
  --pattern 'build-info.json' \
  --pattern 'SHA256SUMS'
(cd "$CACHE" && shasum -a 256 -c SHA256SUMS)
./lancedb-intel repair
~~~

The download step can be repeated safely. The repair command installs only a build whose version and checksum match the resolved LanceDB package, then runs the smoke test. If the Release does not exist, stop here and ask an advanced user to build and publish that version; repair will not substitute a binary from another version.

## Build and publish a binary (advanced)

Builds are needed only when no matching binary has been published yet. The repository includes a manually triggered workflow at .github/workflows/publish-intel.yml. It runs only on the self-hosted Intel Mac runner with labels self-hosted, macOS, X64, and lancedb-intel, reads the exact LanceDB version declared by the runner account’s global OpenLore install, compiles it, runs the smoke test, and uploads the module, build metadata, and SHA-256 checksum to a GitHub Release. There is no GitHub-hosted runner in this workflow.

To publish a new version, register the Intel Mac as a repository-level runner in GitHub Settings → Actions → Runners, install/run it under the account that has OpenLore, Rust, Cargo, and protobuf, and assign the lancedb-intel label. Then choose Actions → “Publish macOS Intel LanceDB build” → Run workflow. The workflow uses its short-lived GITHUB_TOKEN with contents: write; it needs no personal access token or repository secret.

The release tag is lancedb-<version>-darwin-x64. Re-running the workflow for that version replaces its three assets. Publication is manual and does not run on pushes or tags. The initial cold build took 102 minutes; the existing Cargo cache makes later builds of the same version much faster.

## After updating OpenLore

OpenLore does not have a self-update command; this installation is managed by npm. Update OpenLore explicitly, then run repair:

```sh
npm install -g openlore@latest
./lancedb-intel repair
```

If LanceDB remains at the same exact version, `repair` reuses the cached module. If the required version changes, first download the matching published Release as described in “Get a published Intel binary”; then run `repair`. Only if no matching Release exists should an advanced user compile and publish it. The tool refuses to install when OpenLore's declared dependency and the resolved package version differ.

The initial audit found an inconsistent global OpenLore installation: OpenLore `3.5.0` declared LanceDB `0.40.0`, while npm resolved `0.22.4-beta.3`. Reinstalling the same OpenLore version corrected the dependency tree. `lancedb-intel repair` then installed the cached Intel binding, and its smoke test passed against the global SDK.

## Rollback

Run:

```sh
./lancedb-intel restore
```

The tool restores the saved binary if one existed before installation, or removes the Intel module it added. It checks that the installed file still matches its metadata before changing it. Backups remain in the cache for manual recovery.

## Limitations

- The utility supports macOS Intel only. It does not use Rosetta or cross compilation.
- The tested upstream Cargo lockfile needed three workspace package version entries updated from `0.40.0-beta.12` to `0.40.0`; the script records this small patch and fails if the build changes any other tracked source file.
- The first release build is resource intensive and can take a long time on older Intel Macs.
- A fresh npm install or OpenLore update removes injected files; run `repair` after each update.
- The original global OpenLore package tree is backed up under `~/.local/share/lancedb-intel/backups/`; its OpenLore data directory was not used or modified.

See [feasibility](docs/feasibility.md) and [integration design](docs/integration.md) for the evidence and decision details.
