#!/bin/sh
set -eu

home=/home/herdsman
host_keys=/var/lib/herdsman/ssh
authorized_keys="$home/.ssh/authorized_keys"

current_uid="$(id -u herdsman)"
current_gid="$(id -g herdsman)"
puid="${PUID:-$current_uid}"
pgid="${PGID:-$current_gid}"

validate_id() {
  name="$1"
  value="$2"

  case "$value" in
    ''|0*|*[!0-9]*)
      echo "$name must be a positive decimal integer" >&2
      exit 1
      ;;
  esac
}

validate_id PUID "$puid"
validate_id PGID "$pgid"

if [ "$pgid" != "$current_gid" ]; then
  if group="$(getent group "$pgid")"; then
    echo "PGID $pgid is already used by group ${group%%:*}" >&2
    exit 1
  fi

  groupmod -g "$pgid" herdsman
fi

if [ "$puid" != "$current_uid" ]; then
  if user="$(getent passwd "$puid")"; then
    echo "PUID $puid is already used by user ${user%%:*}" >&2
    exit 1
  fi

  # ponytail: remap account metadata only; mounted home ownership stays host-managed.
  usermod -d /nonexistent herdsman
  usermod -u "$puid" herdsman
  usermod -d "$home" herdsman
fi

home_uid="$(stat -c %u "$home")"
home_mode="$(stat -c %a "$home")"

# Match OpenSSH StrictModes for the home before starting sshd.
if { [ "$home_uid" -ne 0 ] && [ "$home_uid" -ne "$puid" ]; } ||
  [ $((0$home_mode & 022)) -ne 0 ]; then
  echo "$home must be owned by root or UID $puid and not writable by group or others for SSH public-key authentication (found UID $home_uid, mode $home_mode)" >&2
  exit 1
fi

if ! runuser -u herdsman -- test -w "$home"; then
  echo "$home must be writable by herdsman (UID $(id -u herdsman), GID $(id -g herdsman))" >&2
  exit 1
fi

install -d -m 0700 "$host_keys"

if [ ! -s "$host_keys/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_keys/ssh_host_ed25519_key"
fi

runuser -u herdsman -- install -d -m 0700 "$home/.ssh"

if ! runuser -u herdsman -- test -s "$authorized_keys"; then
  if [ -z "${SSH_AUTHORIZED_KEYS:-}" ]; then
    echo "SSH_AUTHORIZED_KEYS is required on first start" >&2
    exit 1
  fi

  printf '%s\n' "$SSH_AUTHORIZED_KEYS" |
    runuser -u herdsman -- sh -c 'umask 077; cat > "$1"' sh "$authorized_keys"
fi

runuser -u herdsman -- chmod 0600 "$authorized_keys"

runuser -u herdsman -- \
  env HOME="$home" PATH="$PATH" USER=herdsman LOGNAME=herdsman \
  node - "$home" <<'NODE'
const { spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const home = process.argv[2];
const legacySource = "/opt/pi-herdsman";
const npmSource = "npm:pi-herdsman";
const bundledPackage = "/opt/pi-herdsman";
const seedRoot = "/opt/pi-herdsman-npm-seed";
const seedPackage = path.join(seedRoot, "node_modules", "pi-herdsman");
const seedCache = "/opt/pi-herdsman-npm-cache";

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read valid JSON from ${file}: ${error.message}`);
  }
}

function agentDirectory() {
  let directory = process.env.PI_CODING_AGENT_DIR;
  if (!directory) return path.join(home, ".pi", "agent");
  if (directory === "~") return home;
  if (directory.startsWith("~/"))
    directory = path.join(home, directory.slice(2));
  if (directory.startsWith("file://"))
    return path.resolve(fileURLToPath(directory));
  return path.resolve(directory);
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry))
    return entry.source;
  return undefined;
}

function isNpmHerdsman(source) {
  return (
    source === npmSource ||
    (typeof source === "string" && source.startsWith(`${npmSource}@`))
  );
}

function validateManagedPackage(packageDirectory, npmDirectory) {
  for (const directory of [npmDirectory, path.dirname(packageDirectory), packageDirectory]) {
    try {
      if (!fs.lstatSync(directory).isDirectory()) throw new Error();
    } catch {
      fail(`npm:pi-herdsman installation is invalid: ${directory} must be a real directory`);
    }
  }
  for (const [relative, directory] of [["package.json", false], ["dist", true], ["dist/peer-bridge.js", false]]) {
    try {
      const stat = fs.lstatSync(path.join(packageDirectory, relative));
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error();
    } catch {
      fail(`npm:pi-herdsman installation is invalid: ${relative} must be a real ${directory ? "directory" : "file"}`);
    }
  }
  let packageManifest;
  try {
    packageManifest = readJson(path.join(packageDirectory, "package.json"));
  } catch (error) {
    fail(`npm:pi-herdsman installation is invalid: ${error.message}`);
  }
  if (
    packageManifest.name !== "pi-herdsman" ||
    typeof packageManifest.version !== "string" ||
    !packageManifest.version
  ) {
    fail(`npm:pi-herdsman installation is invalid: ${packageDirectory}/package.json has the wrong name or version`);
  }
  if (
    !Array.isArray(packageManifest.pi?.extensions) ||
    !packageManifest.pi.extensions.includes("./dist/index.js")
  )
    fail(`npm:pi-herdsman installation is invalid: ${packageDirectory}/package.json does not declare ./dist/index.js`);
  try {
    if (!fs.lstatSync(path.join(packageDirectory, "dist", "index.js")).isFile())
      throw new Error("not a regular file");
  } catch {
    fail(`npm:pi-herdsman installation is invalid: missing dist/index.js in ${packageDirectory}`);
  }
  const rootManifest = readJson(path.join(npmDirectory, "package.json"));
  if (typeof rootManifest.dependencies?.["pi-herdsman"] !== "string")
    fail(`npm:pi-herdsman installation is invalid: ${npmDirectory}/package.json has no pi-herdsman dependency`);
  const lock = readJson(path.join(npmDirectory, "package-lock.json"));
  const lockedVersion =
    lock.packages?.["node_modules/pi-herdsman"]?.version ??
    lock.dependencies?.["pi-herdsman"]?.version;
  if (lockedVersion !== packageManifest.version)
    fail(`npm:pi-herdsman installation is invalid: package-lock version ${lockedVersion ?? "is missing"} does not match installed version ${packageManifest.version}`);
  for (const dependency of Object.keys(packageManifest.dependencies ?? {})) {
    try {
      require.resolve(dependency, { paths: [packageDirectory] });
    } catch {
      fail(`npm:pi-herdsman installation is invalid: dependency ${dependency} is missing`);
    }
  }
  return packageManifest;
}

function preserveManagedState(original, staged) {
  const lockPath = path.join(original, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    if (fs.existsSync(path.join(original, "package.json")))
      fail("existing npm root has no lockfile; refusing an unverified seed");
    return;
  }
  const beforeManifest = readJson(path.join(original, "package.json"));
  const afterManifest = readJson(path.join(staged, "package.json"));
  for (const [group, values] of Object.entries(beforeManifest)) {
    if (group === "dependencies") {
      for (const [name, value] of Object.entries(values))
        if (afterManifest.dependencies?.[name] !== value) fail(`offline seed would change existing npm dependency ${name}`);
    } else if (JSON.stringify(values) !== JSON.stringify(afterManifest[group]))
      fail(`offline seed would change existing npm manifest field ${group}`);
  }
  const before = readJson(lockPath);
  const after = readJson(path.join(staged, "package-lock.json"));
  if (!before.packages || !after.packages)
    fail("existing npm lockfile has no package inventory; refusing an unverified seed");
  function sameTree(a, b) {
    const left = fs.lstatSync(a), right = fs.lstatSync(b);
    if (left.mode !== right.mode) return false;
    if (left.isSymbolicLink()) return right.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
    if (left.isFile()) return right.isFile() && fs.readFileSync(a).equals(fs.readFileSync(b));
    if (!left.isDirectory() || !right.isDirectory()) return false;
    const names = fs.readdirSync(a).sort();
    return JSON.stringify(names) === JSON.stringify(fs.readdirSync(b).sort()) && names.every((name) => sameTree(path.join(a, name), path.join(b, name)));
  }
  const oldRoot = { ...before.packages[""] };
  const newRoot = { ...after.packages[""] };
  if (newRoot.dependencies) {
    newRoot.dependencies = { ...newRoot.dependencies };
    delete newRoot.dependencies["pi-herdsman"];
    if (!Object.keys(newRoot.dependencies).length && !oldRoot.dependencies) delete newRoot.dependencies;
  }
  if (JSON.stringify(oldRoot) !== JSON.stringify(newRoot)) fail("offline seed would change existing npm lock root");
  for (const [name, entry] of Object.entries(before.packages)) {
    if (!name) continue;
    if (JSON.stringify(entry) !== JSON.stringify(after.packages[name]))
      fail(`offline seed would change existing npm lock entry ${name}`);
    if (name.startsWith("node_modules/")) {
      try {
        if (!sameTree(path.join(original, name), path.join(staged, name))) throw new Error("changed");
      } catch {
        fail(`offline seed would change existing npm package ${name}`);
      }
    }
  }
}

function writeSettingsAtomically(settingsPath, settings, previousStat) {
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const verified = JSON.parse(serialized);
  if (!verified || typeof verified !== "object" || Array.isArray(verified))
    fail(`refusing to write invalid Pi settings at ${settingsPath}`);

  const mode = previousStat ? previousStat.mode & 0o777 : 0o600;
  writeAtomically(settingsPath, serialized, mode);
}

function writeAtomically(filePath, contents, mode) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporaryPath, "wx", mode);
    created = true;
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
    }
    fail(`cannot atomically update ${filePath}: ${error.message}`);
  }
}


try {
  const agentDir = agentDirectory();
  const npmDirectory = path.join(agentDir, "npm");
  const packageDirectory = path.join(npmDirectory, "node_modules", "pi-herdsman");
  const settingsPath = path.join(agentDir, "settings.json");
  const seedAttemptPath = path.join(agentDir, ".pi-herdsman-seed-attempt.json");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  let settings = {};
  let settingsStat;
  try {
    settingsStat = fs.lstatSync(settingsPath);
    if (!settingsStat.isFile())
      fail(`Pi settings ${settingsPath} must be a regular file`);
    settings = readJson(settingsPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    fail(`Pi settings ${settingsPath} must contain a JSON object`);
  const currentPackages = settings.packages === undefined ? [] : settings.packages;
  if (!Array.isArray(currentPackages))
    fail(`Pi settings ${settingsPath} has a non-array packages value`);

  const sources = currentPackages.map(packageSource);
  const hasNpmSelection = sources.some(isNpmHerdsman);
  try {
    fs.lstatSync(seedAttemptPath);
    fail(`unfinished npm seed at ${seedAttemptPath}; inspect the saved npm directories before manual recovery`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let packageExists = false;
  try {
    fs.lstatSync(packageDirectory);
    packageExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (hasNpmSelection && !packageExists)
    fail(`npm:pi-herdsman is configured but missing at ${packageDirectory}; refusing to restore the image seed`);

  const seedManifest = validateManagedPackage(seedPackage, seedRoot);
  const bundledManifest = readJson(path.join(bundledPackage, "package.json"));
  if (bundledManifest.version !== seedManifest.version)
    fail("image Herdsman package and npm seed versions do not match");

  let activeManifest;
  let backupDirectory;
  if (packageExists) {
    activeManifest = validateManagedPackage(packageDirectory, npmDirectory);
  } else {
    const id = randomUUID();
    const stagingDirectory = path.join(agentDir, `.pi-herdsman-npm-stage-${id}`);
    backupDirectory = path.join(agentDir, `.pi-herdsman-npm-backup-${id}`);
    writeAtomically(seedAttemptPath, `${JSON.stringify({ stagingDirectory, backupDirectory })}\n`, 0o600);
    if (fs.existsSync(npmDirectory)) {
      if (!fs.lstatSync(npmDirectory).isDirectory() ||
          (fs.existsSync(path.join(npmDirectory, "node_modules")) && !fs.lstatSync(path.join(npmDirectory, "node_modules")).isDirectory()))
        fail("npm root and node_modules must be directories for safe seeding");
      fs.cpSync(npmDirectory, stagingDirectory, { recursive: true, verbatimSymlinks: true });
    }
    else fs.mkdirSync(stagingDirectory, { mode: 0o755 });
    const seedBytes = fs.readFileSync("/opt/pi-herdsman-seed.tgz");
    const seedDirectory = path.join(agentDir, ".pi-herdsman-seeds");
    fs.mkdirSync(seedDirectory, { mode: 0o700, recursive: true });
    if (!fs.lstatSync(seedDirectory).isDirectory()) fail("retained seed directory must be a real directory");
    const seedArtifact = path.join(seedDirectory, `${createHash("sha256").update(seedBytes).digest("hex")}.tgz`);
    try {
      fs.writeFileSync(seedArtifact, seedBytes, { flag: "wx", mode: 0o400 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.lstatSync(seedArtifact).isFile() || !fs.readFileSync(seedArtifact).equals(seedBytes))
        fail("existing retained seed is invalid; refusing to overwrite it");
    }
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdsman-npm-seed-"));
    const cacheDirectory = path.join(temporaryRoot, "cache");
    try {
      fs.cpSync(seedCache, cacheDirectory, { recursive: true });
      const result = spawnSync(
        "npm",
        ["install", "--prefix", stagingDirectory, "--cache", cacheDirectory,
          "--offline", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund",
          seedArtifact],
        { env: { ...process.env, npm_config_cache: cacheDirectory, npm_config_offline: "true" }, stdio: "inherit" },
      );
      if (result.error) fail(`offline npm seed install failed: ${result.error.message}`);
      if (result.status !== 0) fail(`offline npm seed install failed with code ${result.status ?? "unknown"}`);
      const manifestResult = spawnSync("npm", ["pkg", "set", "--prefix", stagingDirectory, "dependencies.pi-herdsman=*"], { stdio: "inherit" });
      if (manifestResult.error || manifestResult.status !== 0)
        fail("cannot set unpinned npm seed dependency");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    activeManifest = validateManagedPackage(path.join(stagingDirectory, "node_modules", "pi-herdsman"), stagingDirectory);
    if (activeManifest.version !== seedManifest.version)
      fail("offline npm seed installed a different Herdsman version");
    if (fs.existsSync(npmDirectory)) {
      preserveManagedState(npmDirectory, stagingDirectory);
      fs.renameSync(npmDirectory, backupDirectory);
    }
    fs.renameSync(stagingDirectory, npmDirectory);
  }

  const legacyIndexes = sources
    .map((source, index) => (source === legacySource ? index : -1))
    .filter((index) => index >= 0);
  const npmIndexes = sources
    .map((source, index) => (isNpmHerdsman(source) ? index : -1))
    .filter((index) => index >= 0);
  let nextPackages = currentPackages;
  if (legacyIndexes.length || !npmIndexes.length) {
    if (npmIndexes.length) {
      nextPackages = currentPackages.filter(
        (entry) => packageSource(entry) !== legacySource,
      );
    } else if (legacyIndexes.length) {
      const firstLegacy = legacyIndexes[0];
      nextPackages = currentPackages
        .map((entry, index) => {
          if (index !== firstLegacy) return entry;
          if (typeof entry === "string") return npmSource;
          return { ...entry, source: npmSource };
        })
        .filter((entry, index) => index === firstLegacy || packageSource(entry) !== legacySource);
    } else {
      nextPackages = [...currentPackages, npmSource];
    }
  }

  if (JSON.stringify(nextPackages) !== JSON.stringify(currentPackages)) {
    const nextSettings = { ...settings, packages: nextPackages };
    writeSettingsAtomically(settingsPath, nextSettings, settingsStat);
  }
  if (backupDirectory) {
    fs.unlinkSync(seedAttemptPath);
    fs.rmSync(backupDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`Pi Herdsman package initialization failed: ${error.message}`);
  process.exitCode = 1;
}
NODE

runuser -u herdsman -- \
  env HOME="$home" USER=herdsman LOGNAME=herdsman \
  /usr/local/bin/herdr integration install pi

/usr/sbin/sshd -t -f /etc/ssh/sshd_config

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
