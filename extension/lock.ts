import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export class ProcessLockOccupiedError extends Error {
  readonly code = "PROCESS_LOCK_OCCUPIED";
}

export type ProcessLockClaim = { pid: number; id: string };

type ProcessLockLease = { claim: ProcessLockClaim; release: () => void };

type ProcessLockOptions = {
  afterStaleOwnerRemoved?: () => void;
  name?: string;
  occupiedMessage?: string;
};

function publishClaim(
  parent: string,
  claimDir: string,
  owner: string,
  payload: string,
): void {
  // All callers retain the same claim/release contract; publishing the
  // owner record before the canonical rename also makes the shared lock safe
  // for chief descriptor consumers without event-loop waiting.
  const temporary = join(parent, `.${basename(claimDir)}.${randomUUID()}.tmp`);
  fs.mkdirSync(temporary, 0o700);
  const temporaryOwner = join(temporary, owner);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporaryOwner, "wx", 0o600);
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporaryOwner, 0o600);
    fs.renameSync(temporary, claimDir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporaryOwner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      fs.rmdirSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function acquireProcessLock(
  path: string,
  options: ProcessLockOptions = {},
): ProcessLockLease {
  const name = options.name ?? "process lock";
  const verifyMessage = `Unable to verify ${name}`;
  const occupiedMessage =
    options.occupiedMessage ??
    `${name[0].toUpperCase()}${name.slice(1)} is in progress`;
  const recoverMessage = `Unable to recover ${name}`;
  const parent = dirname(path);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const claimDir = path;
  const id = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, id });
  const ownerPath = join(claimDir, `${process.pid}-${id}`);

  // An empty canonical directory is ambiguous (it may be a crashed legacy
  // publication), and must not be replaced by rename.
  try {
    if (fs.readdirSync(claimDir).length === 0) throw new Error(verifyMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    // Publish the complete claim with one rename.  In particular, never
    // create the canonical directory before its owner record exists.
    publishClaim(parent, claimDir, `${process.pid}-${id}`, payload);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    let entries: string[];
    try {
      entries = fs.readdirSync(claimDir);
    } catch {
      throw new Error(verifyMessage);
    }
    if (entries.length === 0) {
      throw new Error(verifyMessage);
    }
    if (entries.length !== 1) throw new Error(verifyMessage);
    const observedOwner = entries[0];
    const observedPath = join(claimDir, observedOwner);
    let claim: { pid?: unknown; id?: unknown };
    try {
      claim = JSON.parse(fs.readFileSync(observedPath, "utf8")) as {
        pid?: unknown;
        id?: unknown;
      };
    } catch {
      throw new Error(verifyMessage);
    }
    if (
      !claim ||
      typeof claim.pid !== "number" ||
      !Number.isInteger(claim.pid) ||
      claim.pid <= 0 ||
      typeof claim.id !== "string" ||
      !claim.id ||
      observedOwner !== `${claim.pid}-${claim.id}`
    )
      throw new Error(verifyMessage);
    let alive = false;
    try {
      process.kill(claim.pid, 0);
      alive = true;
    } catch (probeError) {
      const code = (probeError as NodeJS.ErrnoException).code;
      if (code !== "ESRCH")
        throw new Error(verifyMessage, { cause: probeError });
    }
    if (alive) throw new ProcessLockOccupiedError(occupiedMessage);
    // Move the complete, verified stale claim out of the canonical name in one
    // operation.  In particular, never unlink the owner while leaving an
    // empty canonical directory behind: a crash at that point used to make
    // every later chief claimant fail closed forever.
    const quarantine = join(
      parent,
      `.${basename(claimDir)}.${randomUUID()}.stale`,
    );
    try {
      const currentEntries = fs.readdirSync(claimDir);
      if (currentEntries.length !== 1 || currentEntries[0] !== observedOwner)
        throw new ProcessLockOccupiedError(occupiedMessage);
      const currentClaim = JSON.parse(
        fs.readFileSync(join(claimDir, observedOwner), "utf8"),
      ) as { pid?: unknown; id?: unknown };
      if (currentClaim.pid !== claim.pid || currentClaim.id !== claim.id)
        throw new ProcessLockOccupiedError(occupiedMessage);
    } catch (error) {
      if (error instanceof ProcessLockOccupiedError) throw error;
      throw new Error(verifyMessage, { cause: error });
    }
    try {
      fs.renameSync(claimDir, quarantine);
    } catch (removeError) {
      const code = (removeError as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST")
        throw new ProcessLockOccupiedError(occupiedMessage);
      throw new Error(recoverMessage, { cause: removeError });
    }

    // A concurrent claimant may have won the canonical name while it was
    // absent. Never clean up a quarantined directory unless it is still the
    // exact stale claim that was verified above.
    let quarantinedEntries: string[];
    try {
      quarantinedEntries = fs.readdirSync(quarantine);
    } catch (error) {
      throw new Error(recoverMessage, { cause: error });
    }
    if (
      quarantinedEntries.length !== 1 ||
      quarantinedEntries[0] !== observedOwner
    )
      throw new ProcessLockOccupiedError(occupiedMessage);
    try {
      const quarantinedClaim = JSON.parse(
        fs.readFileSync(join(quarantine, observedOwner), "utf8"),
      ) as { pid?: unknown; id?: unknown };
      if (
        quarantinedClaim.pid !== claim.pid ||
        quarantinedClaim.id !== claim.id
      )
        throw new ProcessLockOccupiedError(occupiedMessage);
    } catch (error) {
      if (error instanceof ProcessLockOccupiedError) throw error;
      throw new Error(verifyMessage, { cause: error });
    }
    options.afterStaleOwnerRemoved?.();
    try {
      fs.unlinkSync(join(quarantine, observedOwner));
      fs.rmdirSync(quarantine);
    } catch (cleanupError) {
      throw new Error(recoverMessage, { cause: cleanupError });
    }
    try {
      publishClaim(parent, claimDir, `${process.pid}-${id}`, payload);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY")
        throw new ProcessLockOccupiedError(occupiedMessage);
      throw error;
    }
  }
  return {
    claim: { pid: process.pid, id },
    release: () =>
      releaseProcessLock(claimDir, ownerPath, process.pid, id, name),
  };
}

export function claimProcessLock(
  path: string,
  options: ProcessLockOptions = {},
): () => void {
  return acquireGenericProcessLock(path, options).release;
}

// Generic locks predate chief descriptors and intentionally retain their
// directory publication contract.  An observer that catches the brief empty
// directory fails closed; it must never guess that the lock is available.
function acquireGenericProcessLock(
  path: string,
  options: ProcessLockOptions,
): ProcessLockLease {
  const name = options.name ?? "process lock";
  const verifyMessage = `Unable to verify ${name}`;
  const occupiedMessage =
    options.occupiedMessage ??
    `${name[0].toUpperCase()}${name.slice(1)} is in progress`;
  const recoverMessage = `Unable to recover ${name}`;
  const parent = dirname(path);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const id = randomUUID();
  const owner = `${process.pid}-${id}`;
  const ownerPath = join(path, owner);
  try {
    fs.mkdirSync(path, 0o700);
    fs.chmodSync(path, 0o700);
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, id }), {
      flag: "wx",
      mode: 0o600,
    });
    return {
      claim: { pid: process.pid, id },
      release: () => releaseProcessLock(path, ownerPath, process.pid, id, name),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(path);
  } catch {
    throw new Error(verifyMessage);
  }
  if (entries.length !== 1) throw new Error(verifyMessage);
  const observedOwner = entries[0];
  const observedPath = join(path, observedOwner);
  let claim: { pid?: unknown; id?: unknown };
  try {
    claim = JSON.parse(fs.readFileSync(observedPath, "utf8")) as {
      pid?: unknown;
      id?: unknown;
    };
  } catch {
    throw new Error(verifyMessage);
  }
  if (
    !claim ||
    typeof claim.pid !== "number" ||
    !Number.isInteger(claim.pid) ||
    claim.pid <= 0 ||
    typeof claim.id !== "string" ||
    !claim.id ||
    observedOwner !== `${claim.pid}-${claim.id}`
  )
    throw new Error(verifyMessage);
  try {
    process.kill(claim.pid, 0);
    throw new ProcessLockOccupiedError(occupiedMessage);
  } catch (probeError) {
    const code = (probeError as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      if (probeError instanceof ProcessLockOccupiedError) throw probeError;
      throw new Error(verifyMessage, { cause: probeError });
    }
  }
  try {
    fs.unlinkSync(observedPath);
    options.afterStaleOwnerRemoved?.();
    fs.rmdirSync(path);
  } catch (removeError) {
    const code = (removeError as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST")
      throw new ProcessLockOccupiedError(occupiedMessage);
    throw new Error(recoverMessage, { cause: removeError });
  }
  return acquireGenericProcessLock(path, options);
}

function releaseProcessLock(
  claimDir: string,
  ownerPath: string,
  pid: number,
  id: string,
  name: string,
): void {
  let current: { pid?: unknown; id?: unknown };
  try {
    current = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as {
      pid?: unknown;
      id?: unknown;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Unable to verify ${name} ownership`);
  }
  if (current.pid !== pid || current.id !== id)
    throw new Error(
      `${name[0].toUpperCase()}${name.slice(1)} ownership changed`,
    );
  fs.unlinkSync(ownerPath);
  try {
    fs.rmdirSync(claimDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}
