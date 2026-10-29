# LanceDB Node.js binding for macOS Intel

This repository documents a reusable recipe for compiling the official `@lancedb/lancedb` Node.js native binding for macOS Intel (`darwin-x64`), validating it, and attaching the resulting binary to a versioned GitHub Release. The Rust build is independent of the JavaScript application that will consume the binding. Each application must install the binary into its own LanceDB package or adapt its package loader as needed.

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

### Compile the official release

Choose the exact LanceDB npm version required by the consuming project. The corresponding official source tag is `v<version>`:

```sh
VERSION=0.40.0
git clone --depth 1 --branch "v$VERSION" https://github.com/lancedb/lancedb.git "lancedb-$VERSION"
cd "lancedb-$VERSION"
cargo build --locked --manifest-path nodejs/Cargo.toml \
  --target x86_64-apple-darwin --release -p lancedb-nodejs
```

The upstream `0.40.0` tag has three workspace package versions in `Cargo.lock` that do not match its tag. For that release, Cargo rejects `--locked`; retry without `--locked` only if the failure specifically says that the lockfile needs updating, then inspect the diff and confirm it contains only those three version entries (`0.40.0-beta.12` to `0.40.0`). The build output is:

```text
target/x86_64-apple-darwin/release/liblancedb_nodejs.dylib
```

Package it with the filename recognized by the official NAPI loader:

```sh
cp target/x86_64-apple-darwin/release/liblancedb_nodejs.dylib \
  lancedb.darwin-x64.node
file lancedb.darwin-x64.node
otool -L lancedb.darwin-x64.node
shasum -a 256 lancedb.darwin-x64.node
```

Confirm `file` reports `Mach-O 64-bit dynamically linked shared library x86_64` and `otool -L` lists only expected macOS system libraries. To try the build in any JavaScript project, install the exact package version and place the binary at the loader-supported path:

```sh
PROJECT_ROOT=/path/to/project
npm --prefix "$PROJECT_ROOT" install "@lancedb/lancedb@$VERSION"
mkdir -p "$PROJECT_ROOT/node_modules/@lancedb/lancedb/dist"
cp lancedb.darwin-x64.node \
  "$PROJECT_ROOT/node_modules/@lancedb/lancedb/dist/lancedb.darwin-x64.node"
```

Then run a project-appropriate integration check; a minimal check should load the SDK, create a table, insert vectors, search, close, and reopen the database.

### Publish a versioned build artifact

For distribution, include the native module, build metadata (source tag and commit, toolchain, target, and checksum), and a SHA-256 checksum file in a versioned GitHub Release. For example, after reviewing and testing the local artifacts:

```sh
VERSION=0.40.0
TAG="lancedb-$VERSION-darwin-x64"
cat > build-info.json <<EOF
{
  "npmVersion": "$VERSION",
  "gitTag": "$(git describe --tags --exact-match)",
  "gitCommit": "$(git rev-parse HEAD)",
  "architecture": "x86_64-apple-darwin",
  "nodeVersion": "$(node --version)",
  "rustVersion": "$(rustc --version)",
  "binarySha256": "$(shasum -a 256 lancedb.darwin-x64.node | awk '{print $1}')"
}
EOF
shasum -a 256 lancedb.darwin-x64.node > SHA256SUMS
gh release create "$TAG" \
  --repo OWNER/REPOSITORY \
  --title "LanceDB $VERSION · macOS Intel" \
  --notes "Official LanceDB source build for x86_64-apple-darwin." \
  lancedb.darwin-x64.node build-info.json SHA256SUMS
```

Consumers should download the artifact matching their exact LanceDB version and verify `SHA256SUMS` before installing it. Publishing upstream to npm is a separate release process; this recipe distributes a prebuilt binary through GitHub Releases.

## Repository utility and current scope

The included `lancedb-intel` utility automates the build, cache, validation, install, and rollback steps. Its current package discovery, version consistency checks, smoke-test setup, install, and repair commands are implemented for OpenLore. The generic commands above describe the reusable upstream build and artifact process; using the utility with another JavaScript application requires adding an adapter for that application's LanceDB package root and installation lifecycle.

The utility stores built modules, metadata, logs, and any Cargo lockfile sync patch under:

```text
~/.local/share/lancedb-intel/
  builds/<version>/
  logs/
  patches/
  backups/<version>/
```

Set `LANCEDB_INTEL_HOME` to use another cache directory. To build from an existing official checkout, pass `--source /path/to/lancedb-checkout`.

## OpenLore integration example

OpenLore is one integration example for the generic build. Its adapter discovers the LanceDB dependency through an npm-installed OpenLore package and installs the matching native module into that SDK package. `OPENLORE_ROOT` can point to a specific OpenLore package directory for a nonstandard npm prefix.

Run these commands from this repository:

```sh
./lancedb-intel status
./lancedb-intel build
./lancedb-intel install
./lancedb-intel test
./lancedb-intel repair
./lancedb-intel restore
```

`build` reads the required LanceDB version from OpenLore, clones the official `lancedb/lancedb` tag `v<version>`, builds `lancedb-nodejs` for `x86_64-apple-darwin`, checks the Mach-O architecture and dynamic libraries, then runs the isolated vector smoke test. `install` writes only `@lancedb/lancedb/dist/lancedb.darwin-x64.node` and a companion metadata file. It backs up any existing binary and marker, installs atomically, and runs a smoke test; on failure it restores the prior file or removes the new module. The official LanceDB loader checks this local filename before loading its platform package, so OpenLore source and published JavaScript files are not changed.

`repair` reuses a validated cache entry only when its npm version matches the resolved LanceDB version. Without a matching build, it prints the build command and exits without changing the npm installation. Pass `--build` to opt into compilation during repair. `test` runs `tests/smoke-test.mjs` against the installed module. It creates a temporary LanceDB database, creates a table, inserts and searches vectors, closes and reopens the database, then removes only its temporary directory.

### OpenLore release workflow

The manually triggered workflow at `.github/workflows/publish-intel.yml` is currently an OpenLore-specific example. It runs only on a self-hosted macOS Intel runner (`self-hosted`, `macOS`, `X64`), reads the exact LanceDB version declared by the runner account's global OpenLore install, compiles and smoke-tests that version, then uploads the native module, build metadata, and SHA-256 checksum to a GitHub Release. No GitHub-hosted runner is configured, so the build uses the Mac's CPU and Cargo cache rather than GitHub Actions compute minutes.

To enable this workflow, register the Intel Mac as a repository-level self-hosted runner in GitHub Settings → Actions → Runners, install its service under the same account that owns the global OpenLore and Rust toolchain, and add the `lancedb-intel` custom label. Then use Actions → “Publish macOS Intel LanceDB build” → Run workflow. The workflow requires `contents: write` for its short-lived `GITHUB_TOKEN`; it does not need a personal access token or repository secret.

The release tag is `lancedb-<version>-darwin-x64`. Re-running the workflow for the same version replaces the three assets in that Release. The repository must be checked out on the runner with the workflow file available. Triggering the workflow is an explicit publication action; it is not triggered by pushes or tags.

### Reuse a published binary after an OpenLore update

After updating OpenLore, check the LanceDB version it declares. If a matching Release exists, download its binary and build metadata into the local cache, verify the checksum, then repair the OpenLore install:

```sh
OPENLORE_ROOT="$(npm root -g)/openlore"
LANCEDB_VERSION="$(node -p 'const p=require(process.env.OPENLORE_ROOT + "/package.json"); p.optionalDependencies?.["@lancedb/lancedb"] ?? p.dependencies?.["@lancedb/lancedb"]' OPENLORE_ROOT="$OPENLORE_ROOT")"
CACHE="$HOME/.local/share/lancedb-intel/builds/$LANCEDB_VERSION"
TAG="lancedb-$LANCEDB_VERSION-darwin-x64"
mkdir -p "$CACHE"
gh release download "$TAG" --repo laurentftech/lancedb-intel --dir "$CACHE" \
  --pattern 'lancedb.darwin-x64.node' \
  --pattern 'build-info.json' \
  --pattern 'SHA256SUMS'
(cd "$CACHE" && shasum -a 256 -c SHA256SUMS)
./lancedb-intel repair
```

This downloads the exact-version artifact; `repair` checks the metadata and binary checksum before installing it, then runs the smoke test. If the Release is missing, the download fails without changing OpenLore; build and publish that LanceDB version on the Intel runner first. A private repository requires `gh auth login` with access to the repository.

### Update and rollback

OpenLore does not have a self-update command; this installation is managed by npm. Update OpenLore explicitly, then run repair:

```sh
npm install -g openlore@latest
./lancedb-intel repair
```

If LanceDB remains at the same exact version, `repair` reuses the cached module. If the required version changes, the old build is never reused; run `./lancedb-intel build`, review its result, then run `./lancedb-intel repair`. The tool refuses to install when OpenLore's declared dependency and the resolved package version differ.

Run this command to roll back the injected binary:

```sh
./lancedb-intel restore
```

The tool restores the saved binary if one existed before installation, or removes the Intel module it added. It checks that the installed file still matches its metadata before changing it. Backups remain in the cache for manual recovery.

The initial audit found an inconsistent global OpenLore installation: OpenLore `3.5.0` declared LanceDB `0.40.0`, while npm resolved `0.22.4-beta.3`. Reinstalling the same OpenLore version corrected the dependency tree. `lancedb-intel repair` then installed the cached Intel binding, and its smoke test passed against the global SDK.

## Limitations and evidence

- The utility supports macOS Intel only. It does not use Rosetta or cross compilation.
- The tested upstream Cargo lockfile needed three workspace package version entries updated from `0.40.0-beta.12` to `0.40.0`; the script records this small patch and fails if the build changes any other tracked source file.
- The first release build is resource intensive and can take a long time on older Intel Macs.
- A fresh npm install or OpenLore update removes injected files; run `repair` after each update.
- The original global OpenLore package tree is backed up under `~/.local/share/lancedb-intel/backups/`; its OpenLore data directory was not used or modified.

See [feasibility](docs/feasibility.md) and [integration design](docs/integration.md) for the evidence and decision details.
