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
  let claim: unknown;
  try {
    claim = JSON.parse(fs.readFileSync(join(path, owner), "utf8"));
  } catch (error) {
    throw new Error(verifyMessage, { cause: error });
  }
  if (!claim || typeof claim !== "object" || Array.isArray(claim))
    throw new Error(verifyMessage);
  const parsed = claim as { pid?: unknown; id?: unknown };
  if (
    Object.keys(parsed).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(parsed, "pid") ||
    !Object.prototype.hasOwnProperty.call(parsed, "id") ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.id !== "string" ||
    !parsed.id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      parsed.id,
    ) ||
    owner !== `${parsed.pid}-${parsed.id}`
  )
    throw new Error(verifyMessage);

  try {
    process.kill(parsed.pid, 0);
  } catch (error) {
    throw new Error(verifyMessage, { cause: error });
  }
  return { pid: parsed.pid, id: parsed.id };
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

  // An empty canonical directory is ambiguous and must not be replaced.
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
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM")
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
  return acquireProcessLock(path, options).release;
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
