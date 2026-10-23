import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { herdsmanTempRoot, isIncidentalMetadata } from "./storage.ts";

export class ProcessLockOccupiedError extends Error {
  readonly code = "PROCESS_LOCK_OCCUPIED";
}

export type ProcessLockClaim = { pid: number; id: string };

export function assignmentLockPath(mailbox: string): string {
  return join(
    herdsmanTempRoot(),
    "locks",
    `assignment-${createHash("sha256").update(mailbox).digest("hex")}`,
  );
}

export function sessionActivationLockPath(
  canonicalSessionPath: string,
): string {
  return join(
    herdsmanTempRoot(),
    "locks",
    `session-${createHash("sha256").update(canonicalSessionPath).digest("hex")}`,
  );
}

export function claimAssignmentLock(mailbox: string): () => void {
  return claimProcessLock(assignmentLockPath(mailbox), {
    name: "managed assignment",
    occupiedMessage: "Managed assignment is already changing",
  });
}

export function tryClaimAssignmentLock(
  mailbox: string,
): (() => void) | undefined {
  try {
    return claimAssignmentLock(mailbox);
  } catch (error) {
    if (error instanceof ProcessLockOccupiedError) return undefined;
    throw error;
  }
}

export function claimSessionActivationLock(
  canonicalSessionPath: string,
): () => void {
  return claimProcessLock(sessionActivationLockPath(canonicalSessionPath), {
    name: "session activation",
    occupiedMessage: "The exact Pi session is already being activated",
  });
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ProcessLockLease = { claim: ProcessLockClaim; release: () => void };
type LockOwner = ProcessLockClaim & {
  linuxBirth?: { bootId: string; startTicks: string };
};

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

function readProcessLockOwner(path: string, owner: string): LockOwner {
  const value: unknown = JSON.parse(fs.readFileSync(join(path, owner), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid process lock claim");
  const record = value as Record<string, unknown>;
  const claim = { pid: record.pid, id: record.id };
  if (
    !isProcessLockClaim(claim) ||
    owner !== `${claim.pid}-${claim.id}` ||
    (Object.keys(record).length !== 2 && Object.keys(record).length !== 3) ||
    (Object.keys(record).length === 3 && !Object.hasOwn(record, "linuxBirth"))
  )
    throw new Error("invalid process lock claim");
  if (Object.hasOwn(record, "linuxBirth")) {
    const birth = record.linuxBirth;
    if (
      !birth ||
      typeof birth !== "object" ||
      Array.isArray(birth) ||
      Object.keys(birth).length !== 2 ||
      typeof (birth as Record<string, unknown>).bootId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        (birth as Record<string, string>).bootId,
      ) ||
      typeof (birth as Record<string, unknown>).startTicks !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test((birth as Record<string, string>).startTicks)
    )
      throw new Error("invalid process lock identity");
    return { ...claim, linuxBirth: birth as LockOwner["linuxBirth"] };
  }
  return claim;
}

function readLinuxBirth(
  pid: number,
): NonNullable<LockOwner["linuxBirth"]> | undefined {
  const bootId = fs
    .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
    .trim();
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !processExists(pid)
    )
      return undefined;
    throw error;
  }
  const end = stat.lastIndexOf(") ");
  if (end < 0 || !stat.startsWith(`${pid} (`))
    throw new Error("Invalid Linux process stat");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId) ||
    fields.length < 20 ||
    !startTicks ||
    !/^(0|[1-9][0-9]*)$/.test(startTicks)
  )
    throw new Error("Invalid Linux process identity");
  return { bootId, startTicks };
}

function processOwnerExists(owner: LockOwner): boolean {
  if (!processExists(owner.pid)) return false;
  if (process.platform !== "linux") return true;
  if (!owner.linuxBirth)
    throw new Error("Linux lock owner identity is unverifiable");
  const current = readLinuxBirth(owner.pid);
  if (!current) return false;
  return (
    current.bootId === owner.linuxBirth.bootId &&
    current.startTicks === owner.linuxBirth.startTicks
  );
}

function publicClaim(owner: LockOwner): ProcessLockClaim {
  return { pid: owner.pid, id: owner.id };
}

function ownerMissing(path: string): boolean {
  try {
    fs.lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function lockOwnerEntry(path: string): { owner: string; metadata: string[] } {
  const entries = fs.readdirSync(path, { withFileTypes: true });
  const owners = entries.filter((entry) => !isIncidentalMetadata(entry));
  if (owners.length !== 1 || !owners[0]!.isFile())
    throw new Error("Invalid process lock owner");
  return {
    owner: owners[0]!.name,
    metadata: entries.filter(isIncidentalMetadata).map((entry) => entry.name),
  };
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
  const { claim, live } = readProcessLockStatus(path, name);
  if (!live) throw new Error(`Unable to verify ${name}`);
  return claim;
}

export function readProcessLockStatus(
  path: string,
  name = "process lock",
): { claim: ProcessLockClaim; live: boolean } {
  const verifyMessage = `Unable to verify ${name}`;
  let owner: string;
  try {
    ({ owner } = lockOwnerEntry(path));
  } catch (error) {
    throw new Error(verifyMessage, { cause: error });
  }
  try {
    const record = readProcessLockOwner(path, owner);
    return { claim: publicClaim(record), live: processOwnerExists(record) };
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
  const lockOwner: LockOwner =
    process.platform === "linux"
      ? { ...claim, linuxBirth: readLinuxBirth(process.pid)! }
      : claim;
  const owner = `${claim.pid}-${claim.id}`;
  const payload = JSON.stringify(lockOwner);
  const ownerPath = join(claimDir, owner);

  // An empty canonical directory is ambiguous and must not be replaced.
  try {
    lockOwnerEntry(claimDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(verifyMessage, { cause: error });
  }

  try {
    // Publish the complete claim with one rename.  In particular, never
    // create the canonical directory before its owner record exists.
    publishClaim(parent, claimDir, owner, payload);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM")
      throw error;
    let observedOwner: string;
    try {
      ({ owner: observedOwner } = lockOwnerEntry(claimDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ProcessLockOccupiedError(occupiedMessage);
      throw new Error(verifyMessage, { cause: error });
    }
    let staleOwner: LockOwner;
    try {
      staleOwner = readProcessLockOwner(claimDir, observedOwner);
    } catch {
      throw new Error(verifyMessage);
    }
    try {
      if (processOwnerExists(staleOwner))
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
      const { owner: currentOwner } = lockOwnerEntry(claimDir);
      if (currentOwner !== observedOwner)
        throw new ProcessLockOccupiedError(occupiedMessage);
      const currentClaim = readProcessLockOwner(claimDir, observedOwner);
      if (JSON.stringify(currentClaim) !== JSON.stringify(staleOwner))
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
    let quarantinedOwner: string;
    let metadata: string[];
    try {
      ({ owner: quarantinedOwner, metadata } = lockOwnerEntry(quarantine));
    } catch (error) {
      throw new Error(recoverMessage, { cause: error });
    }
    if (quarantinedOwner !== observedOwner)
      throw new ProcessLockOccupiedError(occupiedMessage);
    try {
      const quarantinedClaim = readProcessLockOwner(quarantine, observedOwner);
      if (JSON.stringify(quarantinedClaim) !== JSON.stringify(staleOwner))
        throw new ProcessLockOccupiedError(occupiedMessage);
    } catch (error) {
      if (error instanceof ProcessLockOccupiedError) throw error;
      throw new Error(verifyMessage, { cause: error });
    }
    options.afterStaleOwnerRemoved?.();
    try {
      unlinkMetadata(quarantine, metadata);
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
  let owner: string;
  try {
    ({ owner } = lockOwnerEntry(claimDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A lease whose owner has already disappeared or been replaced must not
    // affect the current lock generation.
    try {
      if (ownerMissing(ownerPath)) return;
    } catch (missing) {
      throw new Error(`Unable to verify ${name} ownership`, { cause: missing });
    }
    throw new Error(`Unable to verify ${name} ownership`, { cause: error });
  }
  if (owner !== basename(ownerPath)) {
    try {
      if (ownerMissing(ownerPath)) return;
    } catch (error) {
      throw new Error(`Unable to verify ${name} ownership`, { cause: error });
    }
    throw new Error(
      `${name[0].toUpperCase()}${name.slice(1)} ownership changed`,
    );
  }
  let current: LockOwner;
  try {
    current = readProcessLockOwner(claimDir, basename(ownerPath));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      ownerMissing(ownerPath)
    )
      return;
    throw new Error(`Unable to verify ${name} ownership`, { cause: error });
  }
  if (current.pid !== claim.pid || current.id !== claim.id)
    throw new Error(
      `${name[0].toUpperCase()}${name.slice(1)} ownership changed`,
    );
  // Retire the complete claim before cleanup; a new canonical owner may follow.
  const retired = join(
    dirname(claimDir),
    `.${basename(claimDir)}.${randomUUID()}.released`,
  );
  fs.renameSync(claimDir, retired);
  let retiredOwner: string;
  let metadata: string[];
  try {
    ({ owner: retiredOwner, metadata } = lockOwnerEntry(retired));
    if (retiredOwner !== basename(ownerPath))
      throw new Error("Process lock owner changed");
    const relocated = readProcessLockOwner(retired, retiredOwner);
    if (relocated.pid !== claim.pid || relocated.id !== claim.id)
      throw new Error("Process lock generation changed");
  } catch (error) {
    throw new Error(`Unable to verify ${name} ownership`, { cause: error });
  }
  unlinkMetadata(retired, metadata);
  fs.unlinkSync(join(retired, retiredOwner));
  try {
    fs.rmdirSync(retired);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

function unlinkMetadata(path: string, entries: string[]): void {
  for (const entry of entries) {
    try {
      fs.unlinkSync(join(path, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
