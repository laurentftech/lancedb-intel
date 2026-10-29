# LanceDB for macOS Intel

This repository provides prebuilt macOS Intel (`darwin-x64`) native binaries for the official `@lancedb/lancedb` Node.js package, along with the build and publication process for maintainers. If a GitHub Release exists for the LanceDB version your project uses, install that binary; compiling from source is only needed when preparing a new release.

## Install a published binary

Use a Release whose version exactly matches your project's `@lancedb/lancedb` npm dependency. The steps below download the binary and its metadata, check its checksum and GitHub attestation, then install it in a JavaScript project.

Requirements: macOS Intel, Node.js/npm, `curl`, `shasum`, and GitHub CLI (`gh`) for attestation verification.

```sh
VERSION=0.40.0
PROJECT_ROOT=/path/to/project
CACHE="$(mktemp -d)"
TAG="v$VERSION"
BASE="https://github.com/laurentftech/lancedb-intel/releases/download/$TAG"

for asset in lancedb.darwin-x64.node build-info.json SHA256SUMS; do
  curl -fL "$BASE/$asset" -o "$CACHE/$asset"
done
(cd "$CACHE" && shasum -a 256 -c SHA256SUMS)
gh attestation verify "$CACHE/lancedb.darwin-x64.node" --repo laurentftech/lancedb-intel

# Ensure the project has this exact SDK version; use the equivalent command
# for your package manager if the project does not use npm.
npm --prefix "$PROJECT_ROOT" install --save-exact "@lancedb/lancedb@$VERSION"
mkdir -p "$PROJECT_ROOT/node_modules/@lancedb/lancedb/dist"
cp "$CACHE/lancedb.darwin-x64.node" \
  "$PROJECT_ROOT/node_modules/@lancedb/lancedb/dist/lancedb.darwin-x64.node"
```

The official loader checks `dist/lancedb.darwin-x64.node` before loading a platform package. Run your application's LanceDB checks after installation. If the matching Release does not exist, ask a maintainer to publish that exact version; users do not need to compile it themselves.

The binary is installed inside `node_modules`, so reinstalling or updating `@lancedb/lancedb` removes it. Download and copy the matching Release again after such an update.

## Maintainers: build and publish a version

Build a binary only when a matching Release is missing or needs to be refreshed. The recipe was verified with LanceDB `0.40.0` on macOS `15.8`, Node `24.20.0` (`darwin-x64`), and Rust `1.98.1`. The first release build took **102 minutes** on this Intel Mac and produced a 192 MB `.node` module. Later builds with the same Cargo cache took under two seconds. `protoc` is required; Homebrew built it from source on this Intel host.

### Build requirements

- An Intel Mac running macOS, with Node.js and npm running as `darwin-x64`.
- Rust stable and Cargo.
- Xcode Command Line Tools.
- `protoc` (for example, `brew install protobuf`).
- Git and network access for the first source clone and Cargo crate downloads.

Check the runner's environment:

```sh
uname -m
node -p "process.platform + '-' + process.arch"
node --version
npm --version
rustc --version
cargo --version
protoc --version
xcode-select -p
```

### Compile and validate

Choose the exact npm version to publish. From this repository, the utility builds the official `lancedb/lancedb` tag `v<version>`, validates the Mach-O architecture and dynamic libraries, and smoke-tests that exact SDK in an isolated npm installation. This path does not require OpenLore:

```sh
VERSION=0.40.0
./lancedb-intel build --version "$VERSION"
```

The equivalent Cargo command, run from an official LanceDB source checkout at `v<version>`, is:

```sh
cargo build --locked --manifest-path nodejs/Cargo.toml \
  --target x86_64-apple-darwin --release -p lancedb-nodejs
```

Cargo writes `target/x86_64-apple-darwin/release/liblancedb_nodejs.dylib`. The Node loader expects the packaged name `lancedb.darwin-x64.node`. Confirm the architecture and dynamic dependencies with `file` and `otool -L`. The utility caches the module, build metadata, logs, and any Cargo lockfile patch under `~/.local/share/lancedb-intel/` (override with `LANCEDB_INTEL_HOME`). To use an existing official checkout, pass `--source /path/to/lancedb-checkout`.

For LanceDB `0.40.0`, the upstream tag has three workspace package versions in `Cargo.lock` that do not match the tag. The utility retries without `--locked` only when Cargo specifically reports that the lockfile needs updating, then verifies that only those three entries changed from `0.40.0-beta.12` to `0.40.0`.

### Publish the Release

The manually triggered GitHub Actions workflow builds and smoke-tests the requested version on a self-hosted macOS Intel runner, then publishes the binary, build metadata, checksum, and build attestation in a GitHub Release. Use Actions → **Publish macOS Intel LanceDB build** → Run workflow and enter the exact LanceDB npm version. The release tag is `v<version>`. Publication is manual; pushes and tags do not trigger it.

The runner needs labels `self-hosted`, `macOS`, `X64`, and `lancedb-intel`. The workflow uses `contents: write`, `id-token: write`, and `attestations: write`, and does not use a GitHub-hosted runner. Restrict the runner to trusted maintainer workflows; do not run untrusted pull request code on it.

## OpenLore integration example

The repository's `lancedb-intel` utility includes an adapter for npm-installed OpenLore. It can discover OpenLore's exact LanceDB version and install a matching cached binary with backup and rollback support. Other applications can install the published binary using the general steps above; their package lifecycle may need its own adapter.

To use a published Release with OpenLore, download its assets into the utility's versioned cache, verify them, and run `repair`:

```sh
OPENLORE_ROOT="$(npm root -g)/openlore"
LANCEDB_VERSION="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.optionalDependencies?.["@lancedb/lancedb"] ?? p.dependencies?.["@lancedb/lancedb"] ?? "")' "$OPENLORE_ROOT/package.json")"
CACHE="$HOME/.local/share/lancedb-intel/builds/$LANCEDB_VERSION"
TAG="v$LANCEDB_VERSION"
BASE="https://github.com/laurentftech/lancedb-intel/releases/download/$TAG"
mkdir -p "$CACHE"
for asset in lancedb.darwin-x64.node build-info.json SHA256SUMS; do
  curl -fL "$BASE/$asset" -o "$CACHE/$asset"
done
(cd "$CACHE" && shasum -a 256 -c SHA256SUMS)
gh attestation verify "$CACHE/lancedb.darwin-x64.node" --repo laurentftech/lancedb-intel
export OPENLORE_ROOT
./lancedb-intel repair
```

`repair` checks the cached version and metadata, installs the module, and runs a vector smoke test. If the matching Release is unavailable, it stops without changing the OpenLore installation. After an OpenLore update, run `./lancedb-intel repair` again. To undo the integration, run `./lancedb-intel restore`; it restores the previous binary if one existed, or removes the module managed by this utility.

## Scope and evidence

- The build supports macOS Intel only. It does not use Rosetta or cross compilation.
- Automated package discovery, install, repair, and rollback currently support OpenLore; the prebuilt binary itself can be installed in other projects that use the matching LanceDB SDK version.
- The first release build is resource intensive and can take a long time on older Intel Macs.

See [build feasibility](docs/feasibility.md) and [integration notes](docs/integration.md) for build results and adapter design.
