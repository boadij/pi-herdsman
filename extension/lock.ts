import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export class ProcessLockOccupiedError extends Error {
  readonly code = "PROCESS_LOCK_OCCUPIED";
}

export type ProcessLockClaim = { pid: number; id: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ProcessLockLease = { claim: ProcessLockClaim; release: () => void };

type ProcessLockOptions = {
  afterStaleOwnerRemoved?: () => void;
  name?: string;
  occupiedMessage?: string;
};

export function isProcessLockClaim(value: unknown): value is ProcessLockClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  if (
    Object.keys(claim).length !== 2 ||
    !Object.hasOwn(claim, "pid") ||
    !Object.hasOwn(claim, "id") ||
    !Number.isInteger(claim.pid) ||
    (claim.pid as number) <= 0 ||
    typeof claim.id !== "string" ||
    !UUID.test(claim.id)
  )
    return false;
  return true;
}

function readProcessLockClaim(path: string, owner: string): ProcessLockClaim {
  const claim: unknown = JSON.parse(fs.readFileSync(join(path, owner), "utf8"));
  if (!isProcessLockClaim(claim) || owner !== `${claim.pid}-${claim.id}`)
    throw new Error("invalid process lock claim");
  return claim;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function publishClaim(
  parent: string,
  claimDir: string,
  owner: string,
  payload: string,
): void {
  // Publish the owner record before the canonical rename so observers never
  // see an empty canonical lock.
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

export function readLiveProcessLock(
  path: string,
  name = "process lock",
): ProcessLockClaim {
  const verifyMessage = `Unable to verify ${name}`;
  let entries: string[];
  try {
    entries = fs.readdirSync(path);
  } catch (error) {
    throw new Error(verifyMessage, { cause: error });
  }
  if (entries.length !== 1) throw new Error(verifyMessage);

  const owner = entries[0];
  try {
    const claim = readProcessLockClaim(path, owner);
    if (!processExists(claim.pid)) throw new Error(verifyMessage);
    return claim;
  } catch (error) {
    throw new Error(verifyMessage, { cause: error });
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
  const claim: ProcessLockClaim = { pid: process.pid, id: randomUUID() };
  const owner = `${claim.pid}-${claim.id}`;
  const payload = JSON.stringify(claim);
  const ownerPath = join(claimDir, owner);

  // An empty canonical directory is ambiguous and must not be replaced.
  try {
    if (fs.readdirSync(claimDir).length === 0) throw new Error(verifyMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    // Publish the complete claim with one rename.  In particular, never
    // create the canonical directory before its owner record exists.
    publishClaim(parent, claimDir, owner, payload);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM")
      throw error;
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
    let staleClaim: ProcessLockClaim;
    try {
      staleClaim = readProcessLockClaim(claimDir, observedOwner);
    } catch {
      throw new Error(verifyMessage);
    }
    try {
      if (processExists(staleClaim.pid))
        throw new ProcessLockOccupiedError(occupiedMessage);
    } catch (error) {
      if (error instanceof ProcessLockOccupiedError) throw error;
      throw new Error(verifyMessage, { cause: error });
    }
    // Move the complete, verified stale claim out of the canonical name in one
    // operation. Never unlink the owner while leaving an empty canonical
    // directory behind.
    const quarantine = join(
      parent,
      `.${basename(claimDir)}.${randomUUID()}.stale`,
    );
    try {
      const currentEntries = fs.readdirSync(claimDir);
      if (currentEntries.length !== 1 || currentEntries[0] !== observedOwner)
        throw new ProcessLockOccupiedError(occupiedMessage);
      const currentClaim = readProcessLockClaim(claimDir, observedOwner);
      if (
        currentClaim.pid !== staleClaim.pid ||
        currentClaim.id !== staleClaim.id
      )
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
      const quarantinedClaim = readProcessLockClaim(quarantine, observedOwner);
      if (
        quarantinedClaim.pid !== staleClaim.pid ||
        quarantinedClaim.id !== staleClaim.id
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
      publishClaim(parent, claimDir, owner, payload);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM")
        throw new ProcessLockOccupiedError(occupiedMessage);
      throw error;
    }
  }
  return {
    claim,
    release: () => releaseProcessLock(claimDir, ownerPath, claim, name),
  };
}

export function claimProcessLock(
  path: string,
  options: ProcessLockOptions = {},
): () => void {
  return acquireProcessLock(path, options).release;
}

function releaseProcessLock(
  claimDir: string,
  ownerPath: string,
  claim: ProcessLockClaim,
  name: string,
): void {
  let current: ProcessLockClaim;
  try {
    current = readProcessLockClaim(claimDir, basename(ownerPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Unable to verify ${name} ownership`, { cause: error });
  }
  if (current.pid !== claim.pid || current.id !== claim.id)
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
