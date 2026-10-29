# LanceDB Intel for macOS Intel

Use a prebuilt LanceDB native module with npm-installed OpenLore on an Intel Mac. The normal path downloads the published binary; compiling from source is for maintainers when a matching release is unavailable.

## Install the published binary

Requirements: macOS Intel, Node.js/npm, Git, curl, and GitHub CLI (`gh`) for provenance verification. The repository and Releases are public; no GitHub login is needed to download the assets.

Clone this repository, then run:

```sh
git clone https://github.com/laurentftech/lancedb-intel.git
cd lancedb-intel
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

Checksum verification detects file corruption; the attestation verifies that the binary was produced by this repository’s GitHub Actions workflow. `repair` checks the exact LanceDB version, installs the module, and runs a smoke test. If the matching Release is missing, it stops without modifying the OpenLore installation.

## After updating OpenLore

Update OpenLore as usual, then run `./lancedb-intel repair`. If LanceDB is unchanged and its binary is cached, repair reuses it. If the LanceDB version changed, download the matching Release using the steps above, then run repair. A binary built for another version is never reused.

To undo the integration, run `./lancedb-intel restore` from this repository.

## Limits

- Supports macOS Intel (`darwin-x64`) only.
- The installer currently supports OpenLore; other LanceDB projects need their own install adapter.
- If no published binary exists, a maintainer must build and publish one. See [build feasibility](docs/feasibility.md) and [integration notes](docs/integration.md).

## Maintainers

Build and publish a missing version from the repository’s **Actions → Publish macOS Intel LanceDB build** workflow. Enter the exact `@lancedb/lancedb` npm version to build; the build and smoke test use that SDK version directly and do not inspect or require OpenLore. The workflow runs on the maintainer’s self-hosted Intel Mac and publishes a versioned Release with an attested binary. Keep that runner limited to trusted maintainers and manual publication runs; do not run untrusted pull request code on it.
