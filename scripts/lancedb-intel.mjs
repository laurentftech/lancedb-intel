#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCargoLockVersionBump } from "./cargo-lockfile.mjs";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(scriptDir, "..");
const repository = "https://github.com/lancedb/lancedb.git";
const targetTriple = "x86_64-apple-darwin";
const nativeFilename = "lancedb.darwin-x64.node";
const cacheRoot = path.resolve(
  process.env.LANCEDB_INTEL_HOME || path.join(homedir(), ".local", "share", "lancedb-intel"),
);

function fail(message, code = 1) {
  console.error(`lancedb-intel: ${message}`);
  process.exitCode = code;
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (["build", "force"].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Expected a value after ${item}`);
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

function runSync(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function runLogged(command, args, cwd, logPath, env = process.env) {
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await import("node:fs").then(({ createWriteStream }) => createWriteStream(logPath, { flags: "a" }));
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const write = (stream, data) => {
      stream.write(data);
      log.write(data);
    };
    child.stdout.on("data", (data) => write(process.stdout, data));
    child.stderr.on("data", (data) => write(process.stderr, data));
    child.once("error", (error) => {
      log.end();
      reject(error);
    });
    child.once("close", (code, signal) => {
      log.end();
      resolve({ code: code ?? 1, signal });
    });
  });
}

function packageJsonAt(root) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}

async function findOpenLoreRoot(explicitRoot) {
  if (explicitRoot || process.env.OPENLORE_ROOT) {
    const root = await realpath(explicitRoot || process.env.OPENLORE_ROOT);
    const pkg = packageJsonAt(root);
    if (pkg.name !== "openlore") throw new Error(`Not an OpenLore package root: ${root}`);
    return root;
  }

  const located = spawnSync("which", ["openlore"], { encoding: "utf8" });
  if (located.status !== 0 || !located.stdout.trim()) {
    throw new Error("Could not find the openlore executable. Set OPENLORE_ROOT to its npm package directory.");
  }
  let current = await realpath(located.stdout.trim());
  try {
    if (!(await stat(current)).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  while (true) {
    try {
      const pkg = packageJsonAt(current);
      if (pkg.name === "openlore") return current;
    } catch {
      // Keep walking parents until the package root is found.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not locate openlore/package.json from the openlore executable.");
}

function findPackageRoot(entry, expectedName) {
  let current = path.dirname(entry);
  while (true) {
    try {
      const pkg = packageJsonAt(current);
      if (pkg.name === expectedName) return { root: current, pkg };
    } catch {
      // Continue upward.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName}/package.json from ${entry}`);
}

async function inspectInstallation(openLoreRoot) {
  const openLorePkg = packageJsonAt(openLoreRoot);
  const declared = openLorePkg.optionalDependencies?.["@lancedb/lancedb"] ?? openLorePkg.dependencies?.["@lancedb/lancedb"];
  if (!declared) throw new Error("This OpenLore package does not declare @lancedb/lancedb.");

  const req = createRequire(path.join(openLoreRoot, "package.json"));
  const sdkEntry = req.resolve("@lancedb/lancedb");
  const { root: sdkRoot, pkg: sdkPkg } = findPackageRoot(sdkEntry, "@lancedb/lancedb");
  const nativePath = path.join(sdkRoot, "dist", nativeFilename);
  const markerPath = `${nativePath}.lancedb-intel.json`;
  return {
    openLoreRoot,
    openLoreVersion: openLorePkg.version,
    declared,
    sdkRoot,
    sdkVersion: sdkPkg.version,
    sdkPkg,
    nativePath,
    markerPath,
    compatible: declared === sdkPkg.version,
  };
}

function versionFrom(options, installation) {
  const version = options.version || installation?.declared;
  if (!version) throw new Error("Pass --version <exact npm-version> or provide OpenLore so its LanceDB version can be read.");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Expected an exact LanceDB npm version, got: ${version}`);
  }
  return version;
}

function buildDir(version) {
  return path.join(cacheRoot, "builds", version);
}

function buildPaths(version) {
  const dir = buildDir(version);
  return {
    dir,
    source: path.join(dir, "source"),
    binary: path.join(dir, nativeFilename),
    metadata: path.join(dir, "build-info.json"),
  };
}

function requireIntelMac() {
  if (process.platform !== "darwin" || process.arch !== "x64") {
    throw new Error(`This builder targets macOS Intel only; current runtime is ${process.platform}-${process.arch}.`);
  }
}

async function ensureBuildTools() {
  for (const [command, args] of [
    ["rustc", ["--version"]],
    ["cargo", ["--version"]],
    ["npm", ["--version"]],
    ["protoc", ["--version"]],
    ["xcode-select", ["-p"]],
  ]) {
    try {
      console.log(`${command}: ${runSync(command, args)}`);
    } catch {
      throw new Error(`Missing build prerequisite: ${command}. Install Xcode Command Line Tools, Rust stable, and protobuf (protoc).`);
    }
  }
}

async function atomicCopy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function validateNativeDependencies(binaryPath) {
  const format = runSync("file", [binaryPath]);
  if (!format.includes("Mach-O") || !format.includes("x86_64")) {
    throw new Error(`Unexpected native module format: ${format}`);
  }
  // otool prints the library's own install ID first; it is not a dependency.
  const linked = runSync("otool", ["-L", binaryPath]).split(/\r?\n/).slice(2);
  const unsupported = linked
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean)
    .filter((library) => !library.startsWith("/System/Library/") && !library.startsWith("/usr/lib/"));
  if (unsupported.length > 0) {
    throw new Error(`Native module has non-system dynamic dependencies: ${unsupported.join(", ")}`);
  }
  console.log(format);
  console.log(`Dynamic libraries: ${linked.map((line) => line.trim().split(" ")[0]).filter(Boolean).join(", ")}`);
}

async function smokeTest(sdkRoot, binaryPath, logPath) {
  const env = {
    ...process.env,
    LANCEDB_PACKAGE_ROOT: sdkRoot,
    NAPI_RS_NATIVE_LIBRARY_PATH: binaryPath,
  };
  const result = await runLogged(process.execPath, [path.join(toolRoot, "tests", "smoke-test.mjs")], toolRoot, logPath, env);
  if (result.code !== 0) throw new Error(`LanceDB smoke test failed; see ${logPath}`);
  return { status: "passed", completedAt: new Date().toISOString() };
}

async function prepareSmokeTestSdk(version) {
  const sdkRoot = path.join(buildDir(version), "smoke-test-sdk");
  const packagePath = path.join(sdkRoot, "package.json");
  await mkdir(sdkRoot, { recursive: true });
  try {
    const packageJson = packageJsonAt(sdkRoot);
    const req = createRequire(packagePath);
    const entry = req.resolve("@lancedb/lancedb");
    const installed = findPackageRoot(entry, "@lancedb/lancedb");
    if (packageJson.name === "lancedb-intel-smoke" && installed.pkg.version === version) {
      return installed.root;
    }
  } catch {
    // A missing or stale isolated SDK is installed below.
  }

  await writeJsonAtomic(packagePath, { name: "lancedb-intel-smoke", private: true });
  const logPath = path.join(cacheRoot, "logs", `npm-smoke-sdk-${version}.log`);
  const result = await runLogged("npm", [
    "install", "--prefix", sdkRoot, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund",
    `@lancedb/lancedb@${version}`,
  ], toolRoot, logPath);
  if (result.code !== 0) throw new Error(`Could not install isolated @lancedb/lancedb@${version} for smoke testing; see ${logPath}`);

  const req = createRequire(packagePath);
  const entry = req.resolve("@lancedb/lancedb");
  const installed = findPackageRoot(entry, "@lancedb/lancedb");
  if (installed.pkg.version !== version) {
    throw new Error(`Isolated smoke-test SDK resolved ${installed.pkg.version}; expected ${version}.`);
  }
  return installed.root;
}

async function build(version, options = {}) {
  requireIntelMac();
  const installation = options.installation;
  if (installation && (installation.declared !== version || !installation.compatible)) {
    throw new Error(`OpenLore requires ${installation.declared} and resolves ${installation.sdkVersion}; refusing to build/test ${version} against an inconsistent installation.`);
  }
  await ensureBuildTools();
  const paths = buildPaths(version);
  await mkdir(paths.dir, { recursive: true });
  let source = options.source ? path.resolve(options.source) : paths.source;

  try {
    await stat(source);
  } catch {
    if (options.source) throw new Error(`Source checkout does not exist: ${source}`);
    const cloneLog = path.join(cacheRoot, "logs", `clone-${version}.log`);
    const cloned = await runLogged("git", ["clone", "--depth", "1", "--filter=blob:none", "--branch", `v${version}`, repository, source], toolRoot, cloneLog);
    if (cloned.code !== 0) throw new Error(`Could not clone official tag v${version}; see ${cloneLog}`);
  }

  const tag = runSync("git", ["describe", "--tags", "--exact-match"], source);
  if (tag !== `v${version}`) throw new Error(`Source tag mismatch: expected v${version}, found ${tag}`);
  const commit = runSync("git", ["rev-parse", "HEAD"], source);
  const sourceLock = path.join(source, "Cargo.lock");
  const lockHashBefore = await sha256(sourceLock);
  const logPath = path.join(cacheRoot, "logs", `build-${version}.log`);
  const cargoArgs = ["build", "--locked", "--manifest-path", "nodejs/Cargo.toml", "--target", targetTriple, "--release", "-p", "lancedb-nodejs"];
  let actualCargoArgs = cargoArgs;
  let result = await runLogged("cargo", cargoArgs, source, logPath);
  if (result.code !== 0) {
    const log = await readFile(logPath, "utf8");
    if (!log.includes("cannot update the lock file") && !log.includes("cannot be updated because --locked")) {
      throw new Error(`Cargo build failed; full log: ${logPath}`);
    }
    console.warn("The official tag has stale workspace version entries in Cargo.lock; retrying without --locked.");
    actualCargoArgs = cargoArgs.filter((arg) => arg !== "--locked");
    result = await runLogged("cargo", actualCargoArgs, source, logPath);
    if (result.code !== 0) throw new Error(`Cargo build failed; full log: ${logPath}`);
  }

  const changedFiles = runSync("git", ["diff", "--name-only"], source).split(/\r?\n/).filter(Boolean);
  if (changedFiles.some((file) => file !== "Cargo.lock")) {
    throw new Error(`Unexpected source changes after build: ${changedFiles.join(", ")}`);
  }
  const lockDiff = runSync("git", ["diff", "--", "Cargo.lock"], source);
  if (lockDiff) {
    validateCargoLockVersionBump(lockDiff, version);
    await mkdir(path.join(cacheRoot, "patches"), { recursive: true });
    await writeFile(path.join(cacheRoot, "patches", `cargo-lock-${version}.patch`), lockDiff);
  }

  const output = path.join(source, "target", targetTriple, "release", "liblancedb_nodejs.dylib");
  try {
    await stat(output);
  } catch {
    throw new Error(`Cargo returned success but the expected binding was not found: ${output}`);
  }
  validateNativeDependencies(output);
  await atomicCopy(output, paths.binary);
  const smokeLog = path.join(cacheRoot, "logs", `test-${version}.log`);
  const sdkRoot = installation?.sdkRoot || await prepareSmokeTestSdk(version);
  const test = await smokeTest(sdkRoot, paths.binary, smokeLog);
  const metadata = {
    npmVersion: version,
    gitTag: tag,
    gitCommit: commit,
    cargoLockSha256BeforeBuild: lockHashBefore,
    cargoLockSha256AfterBuild: await sha256(sourceLock),
    lockfilePatch: lockDiff ? path.join(cacheRoot, "patches", `cargo-lock-${version}.patch`) : null,
    rustVersion: runSync("rustc", ["--version"]),
    cargoVersion: runSync("cargo", ["--version"]),
    nodeVersion: process.version,
    architecture: targetTriple,
    binarySha256: await sha256(paths.binary),
    buildCommand: `cargo ${actualCargoArgs.join(" ")}`,
    buildLog: logPath,
    smokeTest: test,
    smokeTestSdk: `@lancedb/lancedb@${version}`,
    builtAt: new Date().toISOString(),
    patches: [],
  };
  await writeJsonAtomic(paths.metadata, metadata);
  console.log(`Build cached at ${paths.binary}`);
  return metadata;
}

async function readBuild(version) {
  const paths = buildPaths(version);
  try {
    const metadata = JSON.parse(await readFile(paths.metadata, "utf8"));
    const checksum = await sha256(paths.binary);
    if (metadata.npmVersion !== version || metadata.architecture !== targetTriple || metadata.binarySha256 !== checksum) return null;
    return { paths, metadata };
  } catch {
    return null;
  }
}

async function testInstalled(installation, options = {}) {
  if (!installation.compatible) {
    throw new Error(`OpenLore declares LanceDB ${installation.declared} but resolves ${installation.sdkVersion}; reinstall OpenLore before repair.`);
  }
  let binaryPath = options.binary ? path.resolve(options.binary) : installation.nativePath;
  const env = { ...process.env, LANCEDB_PACKAGE_ROOT: installation.sdkRoot };
  if (options.binary) {
    env.NAPI_RS_NATIVE_LIBRARY_PATH = binaryPath;
  } else {
    const marker = JSON.parse(await readFile(installation.markerPath, "utf8")).npmVersion;
    if (marker !== installation.declared) throw new Error(`Installed module metadata is ${marker}, expected ${installation.declared}.`);
  }
  const logPath = path.join(cacheRoot, "logs", `test-${installation.declared}.log`);
  const result = await runLogged(process.execPath, [path.join(toolRoot, "tests", "smoke-test.mjs")], toolRoot, logPath, env);
  if (result.code !== 0) throw new Error(`LanceDB smoke test failed; see ${logPath}`);
  console.log("LanceDB test passed.");
}

async function install(installation) {
  requireIntelMac();
  if (!installation.compatible) {
    throw new Error(`OpenLore declares LanceDB ${installation.declared} but resolves ${installation.sdkVersion}; refusing to modify the installation.`);
  }
  const built = await readBuild(installation.declared);
  if (!built) throw new Error(`No validated build for LanceDB ${installation.declared}. Run lancedb-intel build first.`);
  const destination = installation.nativePath;
  let previous = null;
  let previousMarker = null;
  try {
    const currentHash = await sha256(destination);
    const currentMarker = JSON.parse(await readFile(installation.markerPath, "utf8"));
    if (currentHash === built.metadata.binarySha256 && currentMarker.npmVersion === installation.declared) {
      console.log(`Already installed: LanceDB ${installation.declared} (${currentHash.slice(0, 12)}).`);
      return false;
    }
  } catch {
    // Missing files or stale markers are handled below; an existing binary is backed up first.
  }
  try {
    await stat(destination);
    const backupDir = path.join(cacheRoot, "backups", installation.declared, new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
    await mkdir(backupDir, { recursive: true });
    const backupBinary = path.join(backupDir, nativeFilename);
    await copyFile(destination, backupBinary);
    try {
      previousMarker = path.join(backupDir, path.basename(installation.markerPath));
      await copyFile(installation.markerPath, previousMarker);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not back up the existing installation marker; refusing to replace it: ${error.message}`);
      previousMarker = null;
    }
    previous = backupBinary;
    console.log(`Backup saved: ${backupBinary}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not back up the existing native module; refusing to replace it: ${error.message}`);
  }
  validateNativeDependencies(built.paths.binary);
  const marker = {
    npmVersion: installation.declared,
    gitCommit: built.metadata.gitCommit,
    target: targetTriple,
    sha256: built.metadata.binarySha256,
    installedAt: new Date().toISOString(),
    previousBackup: previous,
    previousMarkerBackup: previousMarker,
  };
  try {
    await atomicCopy(built.paths.binary, destination);
    await writeJsonAtomic(installation.markerPath, marker);
  } catch (error) {
    if (previous) {
      await atomicCopy(previous, destination);
      if (previousMarker) await atomicCopy(previousMarker, installation.markerPath);
      else await rm(installation.markerPath, { force: true });
    } else {
      await rm(destination, { force: true });
      await rm(installation.markerPath, { force: true });
    }
    throw new Error(`Installation failed and was rolled back: ${error.message}`);
  }
  console.log(`Installed LanceDB ${installation.declared} in ${installation.sdkRoot}/dist.`);
  return true;
}

async function restore(installation) {
  let marker;
  try {
    marker = JSON.parse(await readFile(installation.markerPath, "utf8"));
  } catch {
    throw new Error("No lancedb-intel installation marker exists; nothing will be changed.");
  }
  if (await sha256(installation.nativePath) !== marker.sha256) {
    throw new Error("The installed native module has changed since repair; refusing to overwrite it during restore.");
  }
  if (marker.previousBackup) {
    await atomicCopy(marker.previousBackup, installation.nativePath);
    if (marker.previousMarkerBackup) {
      await atomicCopy(marker.previousMarkerBackup, installation.markerPath);
    } else {
      await rm(installation.markerPath, { force: true });
    }
    console.log(`Restored previous native module from ${marker.previousBackup}`);
  } else {
    await rm(installation.nativePath);
    await rm(installation.markerPath, { force: true });
    console.log("Removed the Intel module added by lancedb-intel; no earlier module existed.");
  }
}

async function status(installation) {
  const cached = await readBuild(installation.declared);
  let installed = "absent";
  try {
    const marker = JSON.parse(await readFile(installation.markerPath, "utf8"));
    const checksum = await sha256(installation.nativePath);
    installed = marker.npmVersion === installation.declared && marker.sha256 === checksum ? "valid" : "mismatch";
  } catch {
    try {
      await stat(installation.nativePath);
      installed = "unmanaged file present";
    } catch {
      // Leave absent.
    }
  }
  console.log(`OpenLore: ${installation.openLoreVersion} (${installation.openLoreRoot})`);
  console.log(`LanceDB declared: ${installation.declared}`);
  console.log(`LanceDB resolved: ${installation.sdkVersion}${installation.compatible ? "" : " (MISMATCH)"}`);
  console.log(`Platform: ${process.platform}-${process.arch}`);
  console.log(`Validated cached build: ${cached ? "yes" : "no"}`);
  console.log(`Installed Intel module: ${installed}`);
  if (!installation.compatible) process.exitCode = 2;
}

async function installAndTest(installation) {
  const changed = await install(installation);
  try {
    await testInstalled(installation);
  } catch (error) {
    if (changed) {
      await restore(installation);
      throw new Error(`${error.message}; the failed installation was rolled back.`);
    }
    throw error;
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!["status", "build", "install", "test", "repair", "restore"].includes(command)) {
    throw new Error("Usage: lancedb-intel <status|build|install|test|repair|restore> [--version X] [--build]");
  }
  let installation;
  const buildNeedsOpenLore = command === "build" && (!options.version || options["openlore-root"]);
  if (command !== "build" || buildNeedsOpenLore) {
    installation = await inspectInstallation(await findOpenLoreRoot(options["openlore-root"]));
  }
  if (command === "status") return status(installation);
  if (command === "build") return build(versionFrom(options, installation), { installation, openLoreRoot: options["openlore-root"], source: options.source });
  if (command === "test") return testInstalled(installation, { binary: options.binary });
  if (command === "install") return installAndTest(installation);
  if (command === "restore") return restore(installation);
  if (!installation.compatible) {
    throw new Error(`OpenLore declares LanceDB ${installation.declared} but resolves ${installation.sdkVersion}; reinstall OpenLore before repair.`);
  }
  let built = await readBuild(installation.declared);
  if (!built && options.build) {
    await build(installation.declared, { installation });
    built = await readBuild(installation.declared);
  }
  if (!built) {
    throw new Error(`No validated build for LanceDB ${installation.declared}. Run lancedb-intel build, then lancedb-intel repair.`);
  }
  return installAndTest(installation);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
