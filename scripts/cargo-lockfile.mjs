export function validateCargoLockVersionBump(lockDiff, version) {
  const expectedPackages = new Set(["lancedb", "lancedb-nodejs", "lancedb-python"]);
  const packageChanges = new Map();
  let packageName;
  let unexpectedChange = false;

  for (const line of lockDiff.split(/\r?\n/)) {
    if (line === " [[package]]") packageName = undefined;
    const name = line.match(/^ name = "([^"]+)"$/);
    if (name) packageName = name[1];

    if (!((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))) continue;
    const versionChange = line.match(/^([-+])version = "([^"]+)"$/);
    if (!versionChange) {
      unexpectedChange = true;
      continue;
    }
    if (!packageName) {
      unexpectedChange = true;
      continue;
    }
    const changes = packageChanges.get(packageName) || { previous: [], next: [] };
    changes[versionChange[1] === "-" ? "previous" : "next"].push(versionChange[2]);
    packageChanges.set(packageName, changes);
  }

  if (
    unexpectedChange ||
    packageChanges.size !== expectedPackages.size ||
    [...packageChanges.keys()].some((name) => !expectedPackages.has(name)) ||
    [...packageChanges.values()].some((changes) => changes.previous.length !== 1 || changes.next.length !== 1 || changes.next[0] !== version)
  ) {
    throw new Error(`Cargo.lock changed beyond the three expected workspace version entries; refusing an unreviewed dependency update. Diff: ${lockDiff}`);
  }
}
