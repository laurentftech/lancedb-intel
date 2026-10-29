import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const packageRoot = process.env.LANCEDB_PACKAGE_ROOT;
if (!packageRoot) {
  throw new Error("Set LANCEDB_PACKAGE_ROOT to the installed @lancedb/lancedb package directory.");
}

const require = createRequire(path.join(packageRoot, "package.json"));
const lancedb = require("@lancedb/lancedb");
const databasePath = await mkdtemp(path.join(tmpdir(), "lancedb-intel-smoke-"));
let db;
let table;

try {
  db = await lancedb.connect(databasePath);
  table = await db.createTable("intel_smoke", [
    { id: "near", vector: [1, 0], text: "nearest" },
    { id: "middle", vector: [0.7, 0.7], text: "middle" },
    { id: "far", vector: [0, 1], text: "far" },
  ]);

  const results = await table.vectorSearch([1, 0]).limit(3).toArray();
  assert.equal(results.length, 3);
  assert.equal(results[0].id, "near");
  assert.equal(results[0].text, "nearest");

  table.close();
  table = undefined;
  db.close();
  db = undefined;

  db = await lancedb.connect(databasePath);
  table = await db.openTable("intel_smoke");
  const reopened = await table.vectorSearch([0.7, 0.7]).limit(1).toArray();
  assert.equal(reopened[0].id, "middle");

  console.log("LanceDB smoke test passed: native load, create, insert, vector search, close, and reopen.");
} finally {
  table?.close();
  db?.close();
  await rm(databasePath, { recursive: true, force: true });
}
