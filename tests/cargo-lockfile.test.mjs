import assert from "node:assert/strict";
import test from "node:test";
import { validateCargoLockVersionBump } from "../scripts/cargo-lockfile.mjs";

function versionDiff(previousVersion, nextVersion, packageNames = ["lancedb", "lancedb-nodejs", "lancedb-python"]) {
  return packageNames.map((name) => [
    " [[package]]",
    ` name = "${name}"`,
    `-version = "${previousVersion}"`,
    `+version = "${nextVersion}"`,
  ].join("\n")).join("\n");
}

test("accepts the 0.40.0-beta.12 lockfile bump", () => {
  assert.doesNotThrow(() => validateCargoLockVersionBump(versionDiff("0.40.0-beta.12", "0.40.0"), "0.40.0"));
});

test("accepts the 0.41.0-beta.16 lockfile bump", () => {
  assert.doesNotThrow(() => validateCargoLockVersionBump(versionDiff("0.41.0-beta.16", "0.41.0"), "0.41.0"));
});

test("does not require a beta version before the release version", () => {
  assert.doesNotThrow(() => validateCargoLockVersionBump(versionDiff("0.40.0", "0.41.0"), "0.41.0"));
});

test("rejects changes to packages outside the LanceDB workspace", () => {
  assert.throws(
    () => validateCargoLockVersionBump(versionDiff("0.41.0-beta.16", "0.41.0", ["lancedb", "lancedb-nodejs", "arrow-array"]), "0.41.0"),
    /Cargo.lock changed beyond the three expected workspace version entries/,
  );
});

test("rejects unrelated Cargo.lock changes", () => {
  const diff = `${versionDiff("0.41.0-beta.16", "0.41.0")}\n+checksum = "changed"`;
  assert.throws(
    () => validateCargoLockVersionBump(diff, "0.41.0"),
    /Cargo.lock changed beyond the three expected workspace version entries/,
  );
});
