# LanceDB Node.js binding for macOS Intel

This repository provides a reusable recipe for compiling and distributing the official `@lancedb/lancedb` Node.js native binding for macOS Intel (`darwin-x64`). The Rust build and smoke test use an exact LanceDB npm version and do not require a particular JavaScript application. Applications can install the resulting module in their own LanceDB package; this repository's automated install and repair adapter is currently specific to OpenLore, shown below as an integration example.

The recipe was verified with LanceDB `0.40.0` on macOS `15.8`, Node `24.20.0` (`darwin-x64`), and Rust `1.98.1`. The first release build took **102 minutes** on this Intel Mac and produced a 192 MB `.node` module. Later builds with the same Cargo cache took under two seconds. `protoc` is required; Homebrew built it from source on this Intel host.

## Generic build recipe

### Prerequisites

- An Intel Mac running macOS, with Node.js and npm running as `darwin-x64`.
- Rust stable and Cargo.
- Xcode Command Line Tools.
- `protoc` (for example, `brew install protobuf`).
- Git and network access for the first source clone and Cargo crate downloads.

Check the active runtime and toolchain:

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

### Compile and smoke-test an exact version

Choose the exact LanceDB npm version required by the consuming project. From this repository, run:

```sh
VERSION=0.40.0
./lancedb-intel build --version "$VERSION"
```

The utility clones the official `lancedb/lancedb` tag `v<version>`, builds `lancedb-nodejs` for `x86_64-apple-darwin`, validates the Mach-O architecture and dynamic libraries, and runs a vector smoke test against an isolated installation of the exact `@lancedb/lancedb` npm version. This build path does not discover or require OpenLore.

The equivalent upstream Cargo command is:

```sh
cargo build --locked --manifest-path nodejs/Cargo.toml \
  --target x86_64-apple-darwin --release -p lancedb-nodejs
```

The build output is `target/x86_64-apple-darwin/release/liblancedb_nodejs.dylib`. Package it with the filename recognized by the official NAPI loader:

```sh
cp target/x86_64-apple-darwin/release/liblancedb_nodejs.dylib \
  lancedb.darwin-x64.node
file lancedb.darwin-x64.node
otool -L lancedb.darwin-x64.node
shasum -a 256 lancedb.darwin-x64.node
```

Confirm `file` reports `Mach-O 64-bit dynamically linked shared library x86_64` and `otool -L` lists only expected macOS system libraries. To try the module in another JavaScript project, install the same LanceDB version and place the binary at the loader-supported path:

```sh
PROJECT_ROOT=/path/to/project
npm --prefix "$PROJECT_ROOT" install "@lancedb/lancedb@$VERSION"
mkdir -p "$PROJECT_ROOT/node_modules/@lancedb/lancedb/dist"
cp lancedb.darwin-x64.node \
  "$PROJECT_ROOT/node_modules/@lancedb/lancedb/dist/lancedb.darwin-x64.node"
```

Run a project-appropriate integration check; at minimum, load the SDK, create a table, insert vectors, search, close, and reopen the database.

For LanceDB `0.40.0`, the upstream tag has three workspace package versions in `Cargo.lock` that do not match the tag. Cargo rejects `--locked`; the utility retries without it only when Cargo specifically reports that the lockfile needs updating, then verifies that only those three entries changed from `0.40.0-beta.12` to `0.40.0`.

The utility caches modules, metadata, logs, and any Cargo lockfile patch under `~/.local/share/lancedb-intel/` (or `LANCEDB_INTEL_HOME` if set). It also accepts an existing official checkout with `--source /path/to/lancedb-checkout`.

### Publish a versioned build

The repository's manually triggered GitHub Actions workflow builds and smoke-tests the requested version on a self-hosted macOS Intel runner, then publishes the module, build metadata, checksum, and build attestation in a GitHub Release. To publish a build, use Actions → **Publish macOS Intel LanceDB build** → Run workflow and enter the exact LanceDB npm version. The release tag is `v<version>`. Publication is a deliberate manual action; it is not triggered by pushes or tags.

The workflow needs a self-hosted runner with labels `self-hosted`, `macOS`, `X64`, and `lancedb-intel`, plus `contents: write`, `id-token: write`, and `attestations: write`. It does not use a GitHub-hosted runner. Restrict the runner to trusted maintainer workflows; do not run untrusted pull request code on it.

Consumers should download the artifact matching their exact LanceDB version, verify `SHA256SUMS`, and verify the GitHub attestation before installing it. Publishing a prebuilt binary in GitHub Releases is separate from publishing an npm package upstream.

## OpenLore integration example

The `lancedb-intel` utility also provides an OpenLore adapter. Its `status`, `install`, `test`, `repair`, and `restore` commands discover the LanceDB dependency in an npm-installed OpenLore package and manage the matching native module there. `OPENLORE_ROOT` can point to a specific OpenLore package directory for a nonstandard npm prefix.

Run the commands from this repository:

```sh
./lancedb-intel status
./lancedb-intel build
./lancedb-intel install
./lancedb-intel test
./lancedb-intel repair
./lancedb-intel restore
```

The OpenLore `build` command reads the required LanceDB version from OpenLore, then follows the same source build, binary validation, and smoke-test procedure above. `install` writes only `@lancedb/lancedb/dist/lancedb.darwin-x64.node` and a companion metadata file. It backs up any existing binary and marker, installs atomically, and runs a smoke test; on failure it restores the prior file or removes the new module. The official LanceDB loader checks this local filename before loading its platform package, so OpenLore source and published JavaScript files are not changed.

`repair` reuses a validated cache entry only when its npm version matches the resolved LanceDB version. Without a matching build it exits without changing the npm installation; pass `--build` to opt into compilation during repair. `test` creates a temporary LanceDB database, inserts and searches vectors, closes and reopens the database, then removes only its temporary directory.

To use a published Release with OpenLore, download the versioned assets into the cache, verify them, then run repair:

```sh
OPENLORE_ROOT="$(npm root -g)/openlore"
LANCEDB_VERSION="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.optionalDependencies?.["@lancedb/lancedb"] ?? p.dependencies?.["@lancedb/lancedb"] ?? "")' "$OPENLORE_ROOT/package.json")"
CACHE="$HOME/.local/share/lancedb-intel/builds/$LANCEDB_VERSION"
TAG="v$LANCEDB_VERSION"
mkdir -p "$CACHE"
BASE="https://github.com/laurentftech/lancedb-intel/releases/download/$TAG"
for asset in lancedb.darwin-x64.node build-info.json SHA256SUMS; do
  curl -fL "$BASE/$asset" -o "$CACHE/$asset"
done
(cd "$CACHE" && shasum -a 256 -c SHA256SUMS)
gh attestation verify "$CACHE/lancedb.darwin-x64.node" --repo laurentftech/lancedb-intel
export OPENLORE_ROOT
./lancedb-intel repair
```

If the matching Release is missing, `repair` stops without modifying OpenLore. After an OpenLore npm update, run `./lancedb-intel repair` again. When LanceDB's version changes, download or build the matching version first; a binary from another version is never reused. To undo the integration, run `./lancedb-intel restore`. The tool restores the saved binary if one existed before installation, or removes the Intel module it added, after checking that the installed file still matches its metadata.

## Limits and evidence

- The build utility supports macOS Intel only. It does not use Rosetta or cross compilation.
- Automated installation and repair currently support OpenLore; other JavaScript applications can use the generic build steps and add their own package integration.
- The first release build is resource intensive and can take a long time on older Intel Macs.
- A fresh npm install or OpenLore update removes injected files; run `repair` afterward.

See [build feasibility](docs/feasibility.md) and [integration notes](docs/integration.md) for the evidence and design details.
