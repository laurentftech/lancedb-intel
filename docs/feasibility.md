# Feasibility report

## Environment observed

| Item | Result |
| --- | --- |
| macOS | 15.8 (`24H23`) |
| Kernel architecture | `x86_64` |
| Node runtime | `darwin-x64`, Node `v24.20.0` |
| npm | `12.0.2` |
| Rust / Cargo | `1.98.1` |
| Xcode developer directory | `/Applications/Xcode.app/Contents/Developer` |
| `protoc` | `libprotoc 36.2` (installed with Homebrew) |
| OpenLore global package | `openlore@3.5.0` |
| OpenLore declared LanceDB | `0.40.0` |
| Global resolved LanceDB | Initially `0.22.4-beta.3` (invalid); after reinstalling OpenLore `3.5.0`, `0.40.0` |

The initial global install had no `package-lock.json` and contained an Intel native module for the old resolved version. The existing npm package tree was backed up before reinstalling the same OpenLore version. The package README documents global npm installation (`npm install -g openlore`); the CLI exposes no self-update command.

## Official source and native target

- Repository: <https://github.com/lancedb/lancedb>
- npm version: `@lancedb/lancedb@0.40.0`
- Matching official source tag: `v0.40.0`
- Tag commit: `b1b080b97c3edd2fd9f2aae8a3b71ff19487b1f8`
- Binding crate: `lancedb-nodejs` in `nodejs/Cargo.toml`
- Official Rust minimum: `1.91.0`
- Build target: `x86_64-apple-darwin`
- Official target list includes `aarch64-apple-darwin` but omits `x86_64-apple-darwin`.

The published NAPI loader still has a `darwin` / `x64` branch. It first looks for `dist/lancedb.darwin-x64.node`, then `@lancedb/lancedb-darwin-x64`. The package's `optionalDependencies` omit the Intel package. Thus the upstream omission is in the release matrix, not an explicit rejection in the JavaScript loader or Rust source.

## Build result

The exact v0.40.0 source compiled on the Intel Mac with:

```sh
cargo build --manifest-path nodejs/Cargo.toml \
  --target x86_64-apple-darwin --release -p lancedb-nodejs
```

The initial `--locked` attempt failed because the official tag's `Cargo.lock` still named three workspace crates `0.40.0-beta.12`; retrying without `--locked` changed only those three version strings to `0.40.0`. No Rust source patch was needed. `protoc` was the only missing build prerequisite. Homebrew had no Intel bottle and built protobuf from source in 11 minutes.

The first release build took 102 minutes 26 seconds and produced a 186 MB `liblancedb_nodejs.dylib`; the packaged `.node` file is 192 MB. `file` reported `Mach-O 64-bit dynamically linked shared library x86_64`. `otool -L` showed only macOS system frameworks and libraries (plus the binary's own install ID).

## Runtime proof

An isolated npm install of the official LanceDB 0.40.0 tarball failed to load on Intel before adding the module, with `Cannot find module '@lancedb/lancedb-darwin-x64'`. Copying the compiled module to the loader-supported `dist/lancedb.darwin-x64.node` path made `require('@lancedb/lancedb')` succeed.

`tests/smoke-test.mjs` passed: connect, create table, insert three vectors, perform vector search, close, reconnect, reopen the table, search again, close, and remove the temporary test database. An isolated install of OpenLore `3.5.0` resolved LanceDB `0.40.0`; `openlore init`, `analyze --no-embed`, and `orient` succeeded with the compiled module present. After reinstalling the global OpenLore `3.5.0` package, the CLI resolved `0.40.0`, `lancedb-intel repair` installed the module, and the smoke test passed against the global SDK. The OpenLore data directory was not used or modified.

## Conclusion

Native compilation and loading for macOS Intel are feasible for LanceDB `0.40.0` without changing upstream JavaScript or Rust. The first full release build is expensive on this hardware; subsequent builds with the Cargo cache are fast. The installer and repair mechanism were tested against an isolated npm installation and the repaired global OpenLore SDK.
