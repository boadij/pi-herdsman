import {
  chmodSync,
  closeSync,
  fsyncSync,
  readdirSync,
  rmSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  acquireProcessLock,
  isProcessLockClaim,
  readLiveProcessLock,
  readProcessLockStatus,
  type ProcessLockClaim,
} from "./lock.ts";
import {
  herdsmanDataRoot,
  isResultBinding,
  type ResultBinding,
} from "./storage.ts";
import { isRuntimeBuild, type RuntimeBuild } from "./compatibility.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Authority edges are deliberately asymmetric: Chief -> Manager -> Lead -> Agent.
// Staff and supervisor cross one edge; only Lead/Manager sessions may be peers.
export type SessionRole = "lead" | "manager" | "chief";
export type CoordinatorRole = "lead" | "manager";
export type PeerRole = CoordinatorRole;
export type LeadRole = SessionRole;

export type LeadRoleState = Readonly<{
  role: LeadRole;
  leadTools: readonly string[];
}>;

export function sessionLeadRoleState(
  entries: unknown[],
): LeadRoleState | undefined {
  const entry = [...entries]
    .reverse()
    .find(
      (candidate: any) =>
        candidate?.type === "custom" &&
        candidate.customType === "pi-herdsman-role",
    ) as any;
  if (!entry) return undefined;
  const data = entry.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length !== 2 ||
    !Object.hasOwn(data, "role") ||
    !Object.hasOwn(data, "leadTools") ||
    (data.role !== "lead" &&
      data.role !== "manager" &&
      data.role !== "chief") ||
    !Array.isArray(data.leadTools) ||
    data.leadTools.some(
      (name: unknown) => typeof name !== "string" || name.length === 0,
    ) ||
    new Set(data.leadTools).size !== data.leadTools.length
  )
    throw new Error("invalid pi-herdsman-role entry");
  return { role: data.role, leadTools: [...data.leadTools] };
}

export type ChiefDescriptor = {
  version: 1;
  build?: RuntimeBuild;
  leaseId: string;
  claim: ProcessLockClaim;
  piSessionId: string;
  piSessionFile?: string;
  paneId: string;
  tabId?: string;
  workspaceId: string;
  createdAt: number;
};

export type ChiefIdentity = Omit<
  ChiefDescriptor,
  "version" | "leaseId" | "claim" | "createdAt"
> & {
  build: RuntimeBuild;
  createdAt?: number;
};

export type SupervisionRuntime = {
  root: string;
  lock: string;
  descriptor: string;
  inbox: string;
  coordinators: string;
  managers: string;
  assignments: string;
  /** Old caller spelling until the integration lane switches to coordinators. */
  leads: string;
};

export type ChiefLease = {
  descriptor: ChiefDescriptor;
  runtime: SupervisionRuntime;
  release: () => void;
};

export const COORDINATION_MESSAGE_KINDS = [
  "chief_message",
  "lead_message",
  "manager_message",
  "project_assignment",
  "peer_message",
] as const;

export type ChiefMessageKind = (typeof COORDINATION_MESSAGE_KINDS)[number];

/** Shared durable transport record used by Chief and Lead peer traffic. */
export type CoordinationMessageKind = ChiefMessageKind;

export type ChiefMessageRecord = {
  version: 2;
  build?: RuntimeBuild;
  id: string;
  leaseId: string;
  kind: ChiefMessageKind;
  fromSessionId: string;
  toSessionId: string;
  leadSessionId: string;
  branch?: string;
  text: string;
  resultBindings?: ResultBinding[];
  createdAt: number;
};

export type CoordinationMessageRecord = ChiefMessageRecord;

export type ChiefInboxDrainOptions = {
  runtime: SupervisionRuntime;
  sessionId: string;
  signal?: AbortSignal;
  isAuthorized: (record: ChiefMessageRecord) => boolean | Promise<boolean>;
  isDelivered: (id: string) => boolean;
  sendMessage: (
    message: unknown,
    options: {
      deliverAs: "followUp";
      triggerTurn: true;
    },
    record: ChiefMessageRecord,
  ) => void | Promise<void>;
  accepted?: (record: ChiefMessageRecord) => void | Promise<void>;
  rejected?: (record: ChiefMessageRecord) => void | Promise<void>;
  cleanupError?: (error: unknown) => void | Promise<void>;
  /** Guards state belonging to one lead session/generation transaction. */
  transaction?: {
    begin: (record: ChiefMessageRecord) => unknown | Promise<unknown>;
    revalidate: (token: unknown, phase: string) => void | Promise<void>;
    clear: (token: unknown) => void | Promise<void>;
  };
};

export type CoordinationInboxDrainOptions = ChiefInboxDrainOptions;

export const COORDINATION_MESSAGE_MAX_BYTES = 8 * 1024;
export const COORDINATION_INBOX_SCAN_LIMIT = 32;
const CHIEF_DESCRIPTOR_MAX_BYTES = 2048;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_KINDS = new Set<ChiefMessageKind>(COORDINATION_MESSAGE_KINDS);

function validSession(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function sameRuntimeBuildEvidence(
  left: RuntimeBuild | undefined,
  right: RuntimeBuild | undefined,
): boolean {
  return left?.version === right?.version && left?.sha256 === right?.sha256;
}

function validNativeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 512
  );
}

function validMessage(value: unknown): value is ChiefMessageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = [
    "version",
    "id",
    "leaseId",
    "kind",
    "fromSessionId",
    "toSessionId",
    "leadSessionId",
    "text",
    "createdAt",
  ];
  const optional = ["branch", "resultBindings", "build"];
  if (
    Object.keys(record).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    ) ||
    Object.keys(record).length < keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  )
    return false;
  const projectMessage = record.kind === "project_assignment";
  if (
    projectMessage
      ? !validNativeIdentity(record.branch)
      : record.branch !== undefined
  ) {
    return false;
  }
  return (
    record.version === 2 &&
    (record.build === undefined || isRuntimeBuild(record.build)) &&
    typeof record.id === "string" &&
    UUID.test(record.id) &&
    typeof record.leaseId === "string" &&
    UUID.test(record.leaseId) &&
    typeof record.kind === "string" &&
    MESSAGE_KINDS.has(record.kind as ChiefMessageKind) &&
    validSession(record.fromSessionId) &&
    validSession(record.toSessionId) &&
    validSession(record.leadSessionId) &&
    typeof record.text === "string" &&
    record.text.length > 0 &&
    (record.resultBindings === undefined ||
      (Array.isArray(record.resultBindings) &&
        record.resultBindings.every(isResultBinding))) &&
    Number.isInteger(record.createdAt) &&
    (record.createdAt as number) >= 0
  );
}

export function chiefMessageBytes(record: ChiefMessageRecord): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
}

function assertMessage(value: unknown): asserts value is ChiefMessageRecord {
  if (!validMessage(value)) throw new Error("Invalid Chief message record");
  if (chiefMessageBytes(value) > COORDINATION_MESSAGE_MAX_BYTES)
    throw new Error("Chief message record is too large");
}

function inboxFor(runtime: SupervisionRuntime, toSessionId: string): string {
  if (!validSession(toSessionId))
    throw new Error("Invalid Chief message target");
  return join(
    runtime.inbox,
    createHash("sha256").update(toSessionId).digest("hex"),
  );
}

export function chiefMessagePath(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): string {
  if (!UUID.test(id)) throw new Error("Invalid Chief message ID");
  return join(inboxFor(runtime, toSessionId), `${id}.json`);
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function withChiefMessageLock<T>(path: string, operation: () => T): T {
  const lock = `${path}.lock`;
  // Publish a verified PID/UUID owner so a crash-held lock can be reclaimed
  // only after its recorded PID no longer exists. Live, ambiguous, and
  // malformed locks fail closed and are retried by the caller.
  const lease = acquireProcessLock(lock, { name: "Chief message lock" });
  try {
    return operation();
  } finally {
    lease.release();
  }
}

function removeMalformedChiefMessage(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): Error[] {
  const path = chiefMessagePath(runtime, toSessionId, id);
  try {
    return withChiefMessageLock(path, () =>
      removeMalformedChiefMessageUnlocked(runtime, toSessionId, id),
    );
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error))];
  }
}

function removeMalformedChiefMessageUnlocked(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): Error[] {
  const path = chiefMessagePath(runtime, toSessionId, id);
  const errors: Error[] = [];
  try {
    // Establish the recovery marker before making the malformed record
    // disappear. If this cannot be made durable, retain the JSON record.
    quarantineChiefMessageUnlocked(runtime, toSessionId, id);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
    return errors;
  }
  try {
    const claimed = join(
      dirname(path),
      `.${basename(path, ".json")}.${randomUUID()}.cleanup`,
    );
    renameSync(path, claimed);
    fsyncDirectory(dirname(path));
    try {
      unlinkSync(claimed);
      fsyncDirectory(dirname(path));
    } catch (error) {
      try {
        renameSync(claimed, path);
        fsyncDirectory(dirname(path));
      } catch {}
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // An unlink race is safe only after confirming that the JSON is gone.
      // The marker still applies back-pressure until its removal is durable.
      try {
        statSync(path);
        errors.push(
          new Error("Unable to confirm malformed Chief message removal"),
        );
        return errors;
      } catch (confirmationError) {
        if ((confirmationError as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(
            confirmationError instanceof Error
              ? confirmationError
              : new Error(String(confirmationError)),
          );
          return errors;
        }
      }
      try {
        removeChiefMessageQuarantineUnlocked(runtime, toSessionId, id);
      } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code !== "ENOENT")
          errors.push(
            markerError instanceof Error
              ? markerError
              : new Error(String(markerError)),
          );
      }
      return errors;
    }
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (errors.length === 0) {
    try {
      removeChiefMessageQuarantineUnlocked(runtime, toSessionId, id);
    } catch (markerError) {
      if ((markerError as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(
          markerError instanceof Error
            ? markerError
            : new Error(String(markerError)),
        );
    }
  }
  return errors;
}

function removeChiefMessageQuarantineUnlocked(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): void {
  const path = chiefMessagePath(runtime, toSessionId, id);
  try {
    unlinkSync(`${path}.quarantine`);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    try {
      // The marker was removed before durability was established. Restore it
      // and only report success if the replacement is durable.
      quarantineChiefMessageUnlocked(runtime, toSessionId, id);
    } catch (recoveryError) {
      throw new Error("Unable to restore Chief message quarantine", {
        cause: recoveryError,
      });
    }
    throw new Error("Unable to remove Chief message quarantine", {
      cause: error,
    });
  }
}

export function writeChiefMessage(
  record: ChiefMessageRecord,
  runtime = supervisionRuntime(),
  clearQuarantine = true,
): string {
  if (!record.build)
    throw new Error("Coordination message build identity is required");
  assertMessage(record);
  return withChiefMessageLock(
    chiefMessagePath(runtime, record.toSessionId, record.id),
    () => writeChiefMessageUnlocked(record, runtime, clearQuarantine),
  );
}

function writeChiefMessageUnlocked(
  record: ChiefMessageRecord,
  runtime: SupervisionRuntime,
  clearQuarantine: boolean,
): string {
  const directory = inboxFor(runtime, record.toSessionId);
  mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
  chmodSync(runtime.root, 0o700);
  mkdirSync(runtime.inbox, { recursive: true, mode: 0o700 });
  chmodSync(runtime.inbox, 0o700);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = chiefMessagePath(runtime, record.toSessionId, record.id);
  const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(record)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
    // Replacing a quarantined ID is an explicit retry/reconciliation. Keep
    // the marker fail-closed until the replacement is durable, then release it.
    if (clearQuarantine) {
      const hadQuarantine = chiefMessageQuarantined(
        runtime,
        record.toSessionId,
        record.id,
      );
      try {
        unlinkSync(`${path}.quarantine`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        fsyncDirectory(directory);
      } catch (error) {
        if (hadQuarantine) {
          try {
            quarantineChiefMessageUnlocked(
              runtime,
              record.toSessionId,
              record.id,
            );
          } catch (recoveryError) {
            throw new Error("Unable to restore Chief message quarantine", {
              cause: recoveryError,
            });
          }
        }
        throw error;
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

function conclusivelyMalformedChiefMessage(path: string): boolean {
  let content: string;
  try {
    if (statSync(path).size > COORDINATION_MESSAGE_MAX_BYTES) return true;
    content = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  try {
    return !validMessage(JSON.parse(content));
  } catch {
    return true;
  }
}

function assertChiefMessageNotQuarantined(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): void {
  if (chiefMessageQuarantined(runtime, toSessionId, id))
    throw new Error("Chief message is quarantined");
}

export function readChiefMessage(path: string): ChiefMessageRecord {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    throw new Error("Unable to read Chief message", { cause: error });
  }
  if (size > COORDINATION_MESSAGE_MAX_BYTES)
    throw new Error("Chief message record is too large");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    assertMessage(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /Chief message record/.test(error.message))
      throw error;
    throw new Error("Invalid Chief message record", { cause: error });
  }
}

function allChiefMessagePaths(
  runtime: SupervisionRuntime,
  toSessionId: string,
): string[] {
  const directory = inboxFor(runtime, toSessionId);
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Unable to scan Chief inbox", { cause: error });
  }
  const paths = entries
    .filter((entry) => UUID.test(entry.slice(0, -5)) && entry.endsWith(".json"))
    .map((entry) => join(directory, entry));
  // The directory scan parses all candidates; only the delivery batch is
  // bounded. Malformed UUID-named files are best-effort cleanup candidates
  // and may be deferred behind a full valid delivery batch.
  return paths
    .flatMap((path) => {
      try {
        const record = readChiefMessage(path);
        return [{ path, record }];
      } catch {
        return [{ path, record: undefined }];
      }
    })
    .sort((a, b) => {
      if (!a.record || !b.record) return a.record ? -1 : b.record ? 1 : 0;
      return (
        a.record.createdAt - b.record.createdAt ||
        a.record.id.localeCompare(b.record.id)
      );
    })
    .map(({ path }) => path);
}

export function listChiefMessagePaths(
  runtime: SupervisionRuntime,
  toSessionId: string,
  limit = COORDINATION_INBOX_SCAN_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("Invalid inbox limit");
  return allChiefMessagePaths(runtime, toSessionId).slice(
    0,
    Math.min(limit, COORDINATION_INBOX_SCAN_LIMIT),
  );
}

export function removeChiefMessage(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
  expected?: ChiefMessageRecord,
): void {
  const path = chiefMessagePath(runtime, toSessionId, id);
  withChiefMessageLock(path, () =>
    removeChiefMessageUnlocked(runtime, toSessionId, id, expected),
  );
}

function removeChiefMessageUnlocked(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
  expected?: ChiefMessageRecord,
): void {
  const path = chiefMessagePath(runtime, toSessionId, id);
  const directory = dirname(path);
  const matchesExpected = (): boolean => {
    if (!expected) return true;
    try {
      return (
        JSON.stringify(readChiefMessage(path)) === JSON.stringify(expected)
      );
    } catch {
      return false;
    }
  };
  if (!matchesExpected())
    throw new Error("Chief message changed during removal");
  // Establish recovery before making any record disappear. This also covers
  // direct callers, not only the inbox drain fallback.
  quarantineChiefMessageUnlocked(runtime, toSessionId, id);
  if (!matchesExpected())
    throw new Error("Chief message changed during removal");
  try {
    const claimed = join(
      directory,
      `.${basename(path, ".json")}.${randomUUID()}.cleanup`,
    );
    // Detach the exact path atomically. All same-ID writers use the same
    // narrow lock, so a replacement cannot become the object we delete.
    renameSync(path, claimed);
    fsyncDirectory(directory);
    try {
      unlinkSync(claimed);
      fsyncDirectory(directory);
    } catch (error) {
      try {
        renameSync(claimed, path);
        fsyncDirectory(directory);
      } catch {}
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Unable to remove Chief message", { cause: error });
  }
  try {
    removeChiefMessageQuarantineUnlocked(runtime, toSessionId, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Persist an exclusion when a queued message cannot be removed safely. */
export function quarantineChiefMessage(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): void {
  const path = chiefMessagePath(runtime, toSessionId, id);
  withChiefMessageLock(path, () =>
    quarantineChiefMessageUnlocked(runtime, toSessionId, id),
  );
}

function quarantineChiefMessageUnlocked(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): void {
  const path = chiefMessagePath(runtime, toSessionId, id);
  const quarantine = `${path}.quarantine`;
  // This sidecar is separate from the JSON removal, so a crash between those
  // operations can leave the marker until a retry or explicit recovery;
  // all marker checks fail closed.
  let fd: number | undefined;
  try {
    try {
      fd = openSync(quarantine, "wx", 0o600);
      writeFileSync(fd, "quarantined\n", "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(quarantine, process.platform === "win32" ? "r+" : "r");
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Re-fsync the directory even for an existing marker so this call only
    // succeeds after the marker's presence is durably established.
    fsyncDirectory(dirname(quarantine));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function chiefMessageQuarantined(
  runtime: SupervisionRuntime,
  toSessionId: string,
  id: string,
): boolean {
  try {
    statSync(`${chiefMessagePath(runtime, toSessionId, id)}.quarantine`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

function deliveredMessageContent(record: CoordinationMessageRecord): string {
  const prefix =
    record.kind === "chief_message"
      ? `From chief ${record.fromSessionId}: `
      : record.kind === "manager_message"
        ? `From manager ${record.fromSessionId}: `
        : record.kind === "lead_message"
          ? `From lead ${record.fromSessionId}: `
          : `Peer message from ${record.fromSessionId}: `;
  const content =
    record.kind === "project_assignment"
      ? `Project assignment for branch ${record.branch}:\n\n${record.text}`
      : `${prefix}${record.text}`;
  return Buffer.from(content, "utf8")
    .subarray(0, COORDINATION_MESSAGE_MAX_BYTES)
    .toString("utf8");
}

/** Drain only this session's inbox. Files remain when Pi rejects delivery. */
export async function drainCoordinationInbox(
  options: ChiefInboxDrainOptions,
): Promise<number> {
  let delivered = 0;
  for (const path of listChiefMessagePaths(
    options.runtime,
    options.sessionId,
  )) {
    if (options.signal?.aborted) break;
    const id = basename(path, ".json");
    if (
      UUID.test(id) &&
      chiefMessageQuarantined(options.runtime, options.sessionId, id)
    )
      continue;
    let record: ChiefMessageRecord;
    try {
      record = readChiefMessage(path);
    } catch {
      if (UUID.test(id) && conclusivelyMalformedChiefMessage(path)) {
        for (const cleanupError of removeMalformedChiefMessage(
          options.runtime,
          options.sessionId,
          id,
        ))
          try {
            await options.cleanupError?.(cleanupError);
          } catch {}
      }
      continue;
    }
    let token: unknown;
    const clearTransaction = async (): Promise<void> => {
      if (token === undefined) return;
      try {
        await options.transaction?.clear(token);
      } catch {
        // Clearing bookkeeping is best effort; the inbox record remains the
        // durable retry marker.
      }
    };
    try {
      token = await options.transaction?.begin(record);
      await options.transaction?.revalidate(token, "before-authorization");
    } catch {
      await clearTransaction();
      continue;
    }
    let authorized: boolean;
    try {
      authorized = await options.isAuthorized(record);
    } catch {
      await clearTransaction();
      continue;
    }
    if (!authorized) {
      try {
        await options.transaction?.revalidate(token, "before-rejection");
        await options.rejected?.(record);
        assertChiefMessageNotQuarantined(
          options.runtime,
          options.sessionId,
          record.id,
        );
        await options.transaction?.revalidate(token, "before-rejected-remove");
      } catch {
        // A shutdown or replacement wins over cleanup of this old record.
        await clearTransaction();
        continue;
      }
      try {
        quarantineChiefMessage(options.runtime, options.sessionId, record.id);
        removeChiefMessage(
          options.runtime,
          options.sessionId,
          record.id,
          record,
        );
        await options.transaction?.clear(token);
      } catch (cleanupError) {
        try {
          await options.cleanupError?.(cleanupError);
        } catch {}
      }
      await clearTransaction();
      continue;
    }
    if (!options.isDelivered(record.id)) {
      try {
        await options.transaction?.revalidate(token, "before-send");
        assertChiefMessageNotQuarantined(
          options.runtime,
          options.sessionId,
          record.id,
        );
        await options.sendMessage(
          {
            customType: `pi-herdsman-${record.kind}`,
            content: deliveredMessageContent(record),
            display: true,
            details: {
              id: record.id,
              leaseId: record.leaseId,
              fromSessionId: record.fromSessionId,
              leadSessionId: record.leadSessionId,
              ...(record.branch ? { branch: record.branch } : {}),
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
          record,
        );
        await options.transaction?.revalidate(token, "after-send");
      } catch {
        await clearTransaction();
        continue;
      }
      delivered += 1;
      try {
        await options.transaction?.revalidate(token, "before-accepted");
        assertChiefMessageNotQuarantined(
          options.runtime,
          options.sessionId,
          record.id,
        );
        await options.accepted?.(record);
        await options.transaction?.revalidate(token, "after-accepted");
      } catch {
        await clearTransaction();
        continue;
      }
    } else {
      try {
        await options.transaction?.revalidate(token, "already-delivered");
        assertChiefMessageNotQuarantined(
          options.runtime,
          options.sessionId,
          record.id,
        );
        await options.accepted?.(record);
      } catch {
        await clearTransaction();
        continue;
      }
    }
    try {
      assertChiefMessageNotQuarantined(
        options.runtime,
        options.sessionId,
        record.id,
      );
      await options.transaction?.revalidate(token, "before-remove");
    } catch {
      await clearTransaction();
      continue;
    }
    try {
      removeChiefMessage(options.runtime, options.sessionId, record.id, record);
    } catch (removalError) {
      try {
        await options.cleanupError?.(removalError);
      } catch {}
      await clearTransaction();
      continue;
    }
    try {
      await options.transaction?.revalidate(token, "after-remove");
      await options.transaction?.clear(token);
    } catch {
      // A shutdown or replacement wins over bookkeeping after removal.
      await clearTransaction();
    }
  }
  return delivered;
}

export const coordinationMessagePath = chiefMessagePath;
export const readCoordinationMessage = readChiefMessage;
export const listCoordinationMessagePaths = listChiefMessagePaths;
export const writeCoordinationMessage = writeChiefMessage;
export const removeCoordinationMessage = removeChiefMessage;
export const coordinationMessageBytes = chiefMessageBytes;

function socketPath(): string {
  const value = process.env.HERDR_SOCKET_PATH;
  if (!value) throw new Error("HERDR_SOCKET_PATH is required");
  return value;
}

export function supervisionRuntime(socket = socketPath()): SupervisionRuntime {
  if (!socket) throw new Error("HERDR_SOCKET_PATH is required");
  const runtimeHash = createHash("sha256").update(socket).digest("hex");
  const root = join(
    herdsmanDataRoot(),
    "runtime",
    "supervision-v2",
    runtimeHash,
  );
  return {
    root,
    lock: join(root, "chief.lock"),
    descriptor: join(root, "chief.json"),
    inbox: join(root, "inbox"),
    coordinators: join(root, "coordinators"),
    leads: join(root, "coordinators"),
    managers: join(root, "managers"),
    assignments: join(root, "assignments"),
  };
}

export type PeerRuntime = SupervisionRuntime & {
  peers: string;
};

export type PeerRecord = Readonly<{
  version: 1;
  build?: RuntimeBuild;
  role?: PeerRole;
  piSessionId: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  name?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  workspaceLabel?: string;
  claim: ProcessLockClaim;
  updatedAt: number;
}>;
export type PeerLeadRecord = PeerRecord;

const PEER_LEAD_RECORD_MAX_BYTES = 4096;

export function peerRuntime(_socket?: string): PeerRuntime {
  const root = join(herdsmanDataRoot(), "runtime", "peers-v2");
  return {
    root,
    lock: join(root, "chief.lock"),
    descriptor: join(root, "chief.json"),
    inbox: join(root, "inbox"),
    coordinators: join(root, "coordinators"),
    leads: join(root, "coordinators"),
    managers: join(root, "managers"),
    assignments: join(root, "assignments"),
    peers: join(root, "peers"),
  };
}

function peerDirectory(runtime: PeerRuntime): string {
  mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
  chmodSync(runtime.root, 0o700);
  mkdirSync(runtime.peers, { recursive: true, mode: 0o700 });
  chmodSync(runtime.peers, 0o700);
  return runtime.peers;
}

export function peerLeadRecordPath(
  runtime: PeerRuntime,
  piSessionId: string,
): string {
  if (!validSession(piSessionId)) throw new Error("Invalid peer session ID");
  return join(runtime.peers, peerLeadRecordFilename(piSessionId));
}

function peerLeadRecordFilename(piSessionId: string): string {
  if (!validSession(piSessionId)) throw new Error("Invalid peer session ID");
  return `${createHash("sha256").update(piSessionId).digest("hex")}.json`;
}

export function peerLeadLockPath(
  runtime: PeerRuntime,
  piSessionId: string,
): string {
  return `${peerLeadRecordPath(runtime, piSessionId)}.lock`;
}

function validPeerLeadRecord(value: unknown): value is PeerLeadRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const metadata = ["name", "cwd", "repo", "branch", "workspaceLabel"];
  return (
    Object.keys(record).every((key) =>
      [
        "version",
        "build",
        "role",
        "piSessionId",
        "paneId",
        "tabId",
        "workspaceId",
        "claim",
        "updatedAt",
        ...metadata,
      ].includes(key),
    ) &&
    [
      "version",
      "piSessionId",
      "paneId",
      "tabId",
      "workspaceId",
      "claim",
      "updatedAt",
    ].every((key) => Object.hasOwn(record, key)) &&
    record.version === 1 &&
    (record.build === undefined || isRuntimeBuild(record.build)) &&
    (record.role === undefined ||
      record.role === "lead" ||
      record.role === "manager") &&
    validSession(record.piSessionId) &&
    validNativeIdentity(record.paneId) &&
    validNativeIdentity(record.tabId) &&
    validNativeIdentity(record.workspaceId) &&
    metadata.every(
      (key) => !Object.hasOwn(record, key) || validNativeIdentity(record[key]),
    ) &&
    isProcessLockClaim(record.claim) &&
    Number.isInteger(record.updatedAt) &&
    (record.updatedAt as number) >= 0
  );
}

function livePeerClaim(
  runtime: PeerRuntime,
  piSessionId: string,
): ProcessLockClaim {
  return readLiveProcessLock(peerLeadLockPath(runtime, piSessionId));
}

export function samePeerLeadRecord(
  actual: PeerLeadRecord,
  expected: PeerLeadRecord,
): boolean {
  return (
    actual.version === expected.version &&
    sameRuntimeBuildEvidence(actual.build, expected.build) &&
    (actual.role ?? "lead") === (expected.role ?? "lead") &&
    actual.piSessionId === expected.piSessionId &&
    actual.paneId === expected.paneId &&
    actual.tabId === expected.tabId &&
    actual.workspaceId === expected.workspaceId &&
    actual.name === expected.name &&
    actual.cwd === expected.cwd &&
    actual.repo === expected.repo &&
    actual.branch === expected.branch &&
    actual.workspaceLabel === expected.workspaceLabel &&
    actual.claim.pid === expected.claim.pid &&
    actual.claim.id === expected.claim.id &&
    actual.updatedAt === expected.updatedAt
  );
}

export function samePeerLeadGeneration(
  actual: PeerLeadRecord,
  expected: PeerLeadRecord,
): boolean {
  return (
    actual.piSessionId === expected.piSessionId &&
    sameRuntimeBuildEvidence(actual.build, expected.build) &&
    actual.claim.pid === expected.claim.pid &&
    actual.claim.id === expected.claim.id
  );
}

export function readPeerLeadRecord(
  runtime: PeerRuntime,
  piSessionId: string,
): PeerLeadRecord | undefined {
  const path = peerLeadRecordPath(runtime, piSessionId);
  let value: unknown;
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > PEER_LEAD_RECORD_MAX_BYTES)
      throw new Error("peer lead record too large");
    value = JSON.parse(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read peer lead record", { cause: error });
  }
  if (!validPeerLeadRecord(value) || value.piSessionId !== piSessionId)
    throw new Error("Unable to read peer lead record");
  const claim = livePeerClaim(runtime, piSessionId);
  if (claim.pid !== value.claim.pid || claim.id !== value.claim.id)
    throw new Error("Peer lead process-lock generation changed");
  return value;
}

export function writePeerLeadRecord(
  runtime: PeerRuntime,
  record: PeerLeadRecord,
): string {
  if (!record.build) throw new Error("Peer lead build identity is required");
  if (!validPeerLeadRecord(record)) throw new Error("Invalid peer lead record");
  const live = livePeerClaim(runtime, record.piSessionId);
  if (live.pid !== record.claim.pid || live.id !== record.claim.id)
    throw new Error("Peer lead process-lock generation changed");
  const directory = peerDirectory(runtime);
  const path = peerLeadRecordPath(runtime, record.piSessionId);
  const content = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(content, "utf8") > PEER_LEAD_RECORD_MAX_BYTES)
    throw new Error("Peer lead record is too large");
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
    return path;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function removePeerLeadRecord(
  runtime: PeerRuntime,
  piSessionId: string,
  expected?: PeerLeadRecord,
): void {
  const path = peerLeadRecordPath(runtime, piSessionId);
  try {
    if (expected) {
      const current = readPeerLeadRecord(runtime, piSessionId);
      if (!current || !samePeerLeadRecord(current, expected)) return;
    }
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function listPeerLeadRecords(
  runtime: PeerRuntime = peerRuntime(),
): PeerLeadRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(runtime.peers);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Unable to scan peer lead records", { cause: error });
  }
  return entries
    .filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))
    .sort()
    .flatMap((entry) => {
      try {
        const path = join(runtime.peers, entry);
        if (statSync(path).size > PEER_LEAD_RECORD_MAX_BYTES) return [];
        const text = readFileSync(path, "utf8");
        const value = JSON.parse(text);
        if (
          !validPeerLeadRecord(value) ||
          peerLeadRecordFilename(value.piSessionId) !== entry
        )
          return [];
        const record = readPeerLeadRecord(runtime, value.piSessionId);
        return record ? [record] : [];
      } catch {
        return [];
      }
    });
}

function validDescriptor(value: unknown): value is ChiefDescriptor {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = [
    "version",
    "leaseId",
    "claim",
    "piSessionId",
    "paneId",
    "workspaceId",
    "createdAt",
  ];
  const optional = ["tabId", "piSessionFile", "build"];
  return (
    Object.keys(record).every(
      (key) => keys.includes(key) || optional.includes(key),
    ) &&
    Object.keys(record).length >= keys.length &&
    keys.every((key) => Object.hasOwn(record, key)) &&
    record.version === 1 &&
    (record.build === undefined || isRuntimeBuild(record.build)) &&
    typeof record.leaseId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.leaseId,
    ) &&
    isProcessLockClaim(record.claim) &&
    typeof record.piSessionId === "string" &&
    record.piSessionId.length > 0 &&
    record.piSessionId.length <= 512 &&
    (record.piSessionFile === undefined ||
      (typeof record.piSessionFile === "string" &&
        record.piSessionFile.length > 0)) &&
    typeof record.paneId === "string" &&
    record.paneId.length > 0 &&
    record.paneId.length <= 512 &&
    (record.tabId === undefined ||
      (typeof record.tabId === "string" &&
        record.tabId.length > 0 &&
        record.tabId.length <= 512)) &&
    typeof record.workspaceId === "string" &&
    record.workspaceId.length > 0 &&
    record.workspaceId.length <= 512 &&
    typeof record.createdAt === "number" &&
    Number.isInteger(record.createdAt) &&
    record.createdAt >= 0
  );
}

export function readChiefDescriptor(
  path = supervisionRuntime().descriptor,
): ChiefDescriptor {
  let parsed: unknown;
  try {
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > CHIEF_DESCRIPTOR_MAX_BYTES)
      throw new Error("descriptor too large");
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error("Unable to verify Chief descriptor", { cause: error });
  }
  if (!validDescriptor(parsed))
    throw new Error("Unable to verify Chief descriptor");
  return parsed;
}

export function chiefLeaseIsHeld(runtime: SupervisionRuntime): boolean {
  try {
    const claim = readLiveProcessLock(runtime.lock, "Chief supervision lease");
    const descriptor = readChiefDescriptor(runtime.descriptor);
    return (
      descriptor.claim.pid === claim.pid && descriptor.claim.id === claim.id
    );
  } catch {
    return false;
  }
}

function writeDescriptor(
  path: string,
  descriptor: ChiefDescriptor | ManagerDescriptor,
): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const content = `${JSON.stringify(descriptor)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function sameChiefDescriptor(
  actual: ChiefDescriptor,
  expected: ChiefDescriptor,
): boolean {
  return (
    actual.leaseId === expected.leaseId &&
    sameRuntimeBuildEvidence(actual.build, expected.build) &&
    actual.claim.pid === expected.claim.pid &&
    actual.claim.id === expected.claim.id &&
    actual.piSessionId === expected.piSessionId &&
    actual.piSessionFile === expected.piSessionFile &&
    actual.paneId === expected.paneId &&
    actual.tabId === expected.tabId &&
    actual.workspaceId === expected.workspaceId &&
    actual.createdAt === expected.createdAt
  );
}

export function claimChiefLease(identity: ChiefIdentity): ChiefLease {
  if (
    !identity ||
    !isRuntimeBuild(identity.build) ||
    typeof identity.piSessionId !== "string" ||
    !identity.piSessionId ||
    identity.piSessionId.length > 512 ||
    (identity.piSessionFile !== undefined &&
      (typeof identity.piSessionFile !== "string" ||
        !identity.piSessionFile)) ||
    typeof identity.paneId !== "string" ||
    !identity.paneId ||
    identity.paneId.length > 512 ||
    (identity.tabId !== undefined &&
      (typeof identity.tabId !== "string" ||
        !identity.tabId ||
        identity.tabId.length > 512)) ||
    typeof identity.workspaceId !== "string" ||
    !identity.workspaceId ||
    identity.workspaceId.length > 512 ||
    (identity.createdAt !== undefined &&
      (typeof identity.createdAt !== "number" ||
        !Number.isInteger(identity.createdAt) ||
        identity.createdAt < 0))
  )
    throw new Error("Invalid Chief identity");
  const runtime = supervisionRuntime();
  mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
  chmodSync(runtime.root, 0o700);
  mkdirSync(runtime.inbox, { recursive: true, mode: 0o700 });
  chmodSync(runtime.inbox, 0o700);
  const lease = acquireProcessLock(runtime.lock, {
    name: "Chief supervision lease",
  });
  const descriptor: ChiefDescriptor = {
    version: 1,
    build: identity.build,
    leaseId: randomUUID(),
    claim: lease.claim,
    piSessionId: identity.piSessionId,
    ...(identity.piSessionFile !== undefined
      ? { piSessionFile: identity.piSessionFile }
      : {}),
    paneId: identity.paneId,
    ...(identity.tabId ? { tabId: identity.tabId } : {}),
    workspaceId: identity.workspaceId,
    createdAt: identity.createdAt ?? Date.now(),
  };
  try {
    writeDescriptor(runtime.descriptor, descriptor);
  } catch (error) {
    lease.release();
    throw error;
  }
  let released = false;
  return {
    descriptor,
    runtime,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (
          sameChiefDescriptor(
            readChiefDescriptor(runtime.descriptor),
            descriptor,
          )
        )
          unlinkSync(runtime.descriptor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // A malformed or replaced descriptor is not ours to remove.
        }
      } finally {
        lease.release();
      }
    },
  };
}

export type ManagerDescriptor = {
  version: 1;
  build?: RuntimeBuild;
  leaseId: string;
  claim: ProcessLockClaim;
  piSessionId: string;
  piSessionFile?: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  repoKey: string;
  createdAt: number;
};
export type ManagerIdentity = Pick<
  ManagerDescriptor,
  | "piSessionId"
  | "piSessionFile"
  | "paneId"
  | "tabId"
  | "workspaceId"
  | "repoKey"
> & { build: RuntimeBuild; createdAt?: number };
export type ManagerLease = {
  descriptor: ManagerDescriptor;
  runtime: SupervisionRuntime;
  release: () => void;
};
export type ManagerDescriptorStatus = Readonly<{
  descriptor: ManagerDescriptor;
  live: boolean;
}>;

export function managerDescriptorPath(
  runtime: SupervisionRuntime,
  workspaceId: string,
): string {
  if (!validNativeIdentity(workspaceId))
    throw new Error("Invalid Manager workspace ID");
  return join(
    runtime.managers,
    `${createHash("sha256").update(workspaceId).digest("hex")}.json`,
  );
}

function validManagerDescriptor(value: unknown): value is ManagerDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = [
    "version",
    "leaseId",
    "claim",
    "piSessionId",
    "paneId",
    "tabId",
    "workspaceId",
    "repoKey",
    "createdAt",
  ];
  return (
    Object.keys(r).every(
      (key) => keys.includes(key) || key === "piSessionFile" || key === "build",
    ) &&
    keys.every((key) => Object.hasOwn(r, key)) &&
    r.version === 1 &&
    (r.build === undefined || isRuntimeBuild(r.build)) &&
    UUID.test(String(r.leaseId)) &&
    isProcessLockClaim(r.claim) &&
    validSession(r.piSessionId) &&
    (r.piSessionFile === undefined ||
      (typeof r.piSessionFile === "string" && r.piSessionFile.length > 0)) &&
    validNativeIdentity(r.paneId) &&
    validNativeIdentity(r.tabId) &&
    validNativeIdentity(r.workspaceId) &&
    validNativeIdentity(r.repoKey) &&
    Number.isInteger(r.createdAt) &&
    (r.createdAt as number) >= 0
  );
}

export function sameManagerDescriptor(
  actual: ManagerDescriptor,
  expected: ManagerDescriptor,
): boolean {
  return (
    actual.version === expected.version &&
    actual.leaseId === expected.leaseId &&
    sameRuntimeBuildEvidence(actual.build, expected.build) &&
    actual.claim.pid === expected.claim.pid &&
    actual.claim.id === expected.claim.id &&
    actual.piSessionId === expected.piSessionId &&
    actual.piSessionFile === expected.piSessionFile &&
    actual.paneId === expected.paneId &&
    actual.tabId === expected.tabId &&
    actual.workspaceId === expected.workspaceId &&
    actual.repoKey === expected.repoKey &&
    actual.createdAt === expected.createdAt
  );
}

export function readManagerDescriptorStatus(
  runtime: SupervisionRuntime,
  workspaceId: string,
): ManagerDescriptorStatus | undefined {
  const path = managerDescriptorPath(runtime, workspaceId);
  const lockPath = `${path}.lock`;
  let content: string;
  try {
    if (statSync(path).size > CHIEF_DESCRIPTOR_MAX_BYTES)
      throw new Error("descriptor too large");
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        if (!statSync(lockPath, { throwIfNoEntry: false })) return undefined;
      } catch (lockError) {
        throw new Error("Unable to verify Manager descriptor", {
          cause: lockError,
        });
      }
    }
    throw new Error("Unable to verify Manager descriptor", { cause: error });
  }
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(content);
  } catch (error) {
    throw new Error("Unable to verify Manager descriptor", { cause: error });
  }
  if (
    !validManagerDescriptor(descriptor) ||
    descriptor.workspaceId !== workspaceId
  )
    throw new Error("Unable to verify Manager descriptor");
  let status: ReturnType<typeof readProcessLockStatus>;
  try {
    status = readProcessLockStatus(lockPath, "Manager supervision lease");
  } catch (error) {
    throw new Error("Unable to verify Manager descriptor", { cause: error });
  }
  if (
    status.claim.pid !== descriptor.claim.pid ||
    status.claim.id !== descriptor.claim.id
  )
    throw new Error("Manager process-lock generation changed");
  return { descriptor, live: status.live };
}

export function readManagerDescriptor(
  runtime: SupervisionRuntime,
  workspaceId: string,
): ManagerDescriptor | undefined {
  const status = readManagerDescriptorStatus(runtime, workspaceId);
  if (!status) return undefined;
  if (!status.live)
    throw new Error("Unable to verify Manager supervision lease");
  return status.descriptor;
}

export function listManagerDescriptors(
  runtime = supervisionRuntime(),
): ManagerDescriptor[] {
  let entries: string[];
  try {
    entries = readdirSync(runtime.managers);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))
    .sort()
    .flatMap((entry) => {
      try {
        const path = join(runtime.managers, entry);
        if (statSync(path).size > CHIEF_DESCRIPTOR_MAX_BYTES) return [];
        const candidate: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          !validManagerDescriptor(candidate) ||
          basename(managerDescriptorPath(runtime, candidate.workspaceId)) !==
            entry
        )
          return [];
        const verified = readManagerDescriptor(runtime, candidate.workspaceId);
        return verified ? [verified] : [];
      } catch {
        return [];
      }
    });
}

export function claimManagerLease(
  identity: ManagerIdentity,
  runtime = supervisionRuntime(),
): ManagerLease {
  if (
    !identity ||
    !isRuntimeBuild(identity.build) ||
    !validSession(identity.piSessionId) ||
    (identity.piSessionFile !== undefined &&
      (typeof identity.piSessionFile !== "string" ||
        !identity.piSessionFile)) ||
    !validNativeIdentity(identity.paneId) ||
    !validNativeIdentity(identity.tabId) ||
    !validNativeIdentity(identity.workspaceId) ||
    !validNativeIdentity(identity.repoKey) ||
    (identity.createdAt !== undefined &&
      (!Number.isInteger(identity.createdAt) || identity.createdAt < 0))
  )
    throw new Error("Invalid Manager identity");
  mkdirSync(runtime.managers, { recursive: true, mode: 0o700 });
  chmodSync(runtime.managers, 0o700);
  const path = managerDescriptorPath(runtime, identity.workspaceId);
  const lease = acquireProcessLock(`${path}.lock`, {
    name: "Manager supervision lease",
  });
  const descriptor: ManagerDescriptor = {
    version: 1,
    build: identity.build,
    leaseId: randomUUID(),
    claim: lease.claim,
    piSessionId: identity.piSessionId,
    ...(identity.piSessionFile !== undefined
      ? { piSessionFile: identity.piSessionFile }
      : {}),
    paneId: identity.paneId,
    tabId: identity.tabId,
    workspaceId: identity.workspaceId,
    repoKey: identity.repoKey,
    createdAt: identity.createdAt ?? Date.now(),
  };
  try {
    writeDescriptor(path, descriptor);
  } catch (error) {
    lease.release();
    throw error;
  }
  let released = false;
  return {
    descriptor,
    runtime,
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = readManagerDescriptor(runtime, identity.workspaceId);
        if (current && sameManagerDescriptor(current, descriptor)) {
          unlinkSync(path);
          fsyncDirectory(runtime.managers);
        }
      } catch {
        /* A replaced or malformed descriptor is not ours to remove. */
      } finally {
        lease.release();
      }
    },
  };
}

export type ProjectAssignment = Readonly<{
  version: 2;
  id: string;
  repoKey: string;
  branch: string;
  text: string;
  resultBindings?: ResultBinding[];
}>;
export const PROJECT_ASSIGNMENT_MAX_BYTES = 1024 * 1024;

export function projectAssignmentBytes(assignment: ProjectAssignment): number {
  return Buffer.byteLength(`${JSON.stringify(assignment)}\n`, "utf8");
}

export function projectAssignmentPath(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): string {
  if (!validNativeIdentity(repoKey) || !validNativeIdentity(branch))
    throw new Error("Invalid project assignment identity");
  return join(
    runtime.assignments,
    createHash("sha256").update(repoKey).digest("hex"),
    `${createHash("sha256").update(branch).digest("hex")}.json`,
  );
}

function validProjectAssignment(value: unknown): value is ProjectAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const required = ["version", "id", "repoKey", "branch", "text"];
  const optional = ["resultBindings"];
  return (
    required.every((key) => Object.hasOwn(r, key)) &&
    Object.keys(r).every(
      (key) => required.includes(key) || optional.includes(key),
    ) &&
    Object.keys(r).length >= required.length &&
    r.version === 2 &&
    UUID.test(String(r.id)) &&
    validNativeIdentity(r.repoKey) &&
    validNativeIdentity(r.branch) &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    (r.resultBindings === undefined ||
      (Array.isArray(r.resultBindings) &&
        r.resultBindings.every(isResultBinding)))
  );
}

export function writeProjectAssignment(
  runtime: SupervisionRuntime,
  assignment: ProjectAssignment,
): void {
  if (!validProjectAssignment(assignment))
    throw new Error("Invalid project assignment");
  const content = `${JSON.stringify(assignment)}\n`;
  if (projectAssignmentBytes(assignment) > PROJECT_ASSIGNMENT_MAX_BYTES)
    throw new Error("Project assignment is too large");
  const path = projectAssignmentPath(
    runtime,
    assignment.repoKey,
    assignment.branch,
  );
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(runtime.root, 0o700);
  chmodSync(runtime.assignments, 0o700);
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.${assignment.id}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function readProjectAssignment(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): ProjectAssignment | undefined {
  const path = projectAssignmentPath(runtime, repoKey, branch);
  return readProjectAssignmentFile(path, repoKey, branch);
}

function readProjectAssignmentFile(
  path: string,
  repoKey: string,
  branch?: string,
): ProjectAssignment | undefined {
  let value: unknown;
  try {
    if (statSync(path).size > PROJECT_ASSIGNMENT_MAX_BYTES)
      throw new Error("file is too large");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const reason =
      error instanceof SyntaxError
        ? "invalid JSON"
        : error instanceof Error && error.message === "file is too large"
          ? error.message
          : `read failed${safeFilesystemCode(error)}`;
    throw projectAssignmentReadError(path, reason);
  }
  if (!validProjectAssignment(value))
    throw projectAssignmentReadError(path, "invalid assignment schema");
  if (
    value.repoKey !== repoKey ||
    basename(dirname(path)) !==
      createHash("sha256").update(repoKey).digest("hex") ||
    (branch !== undefined && value.branch !== branch) ||
    basename(path) !==
      `${createHash("sha256").update(value.branch).digest("hex")}.json`
  )
    throw projectAssignmentReadError(path, "assignment identity mismatch");
  return value;
}

function safeFilesystemCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
    ? ` (${code})`
    : "";
}

function projectAssignmentReadError(path: string, reason: string): Error {
  return new Error(`Unable to read project assignment ${path}: ${reason}`);
}

export function listProjectAssignments(
  runtime: SupervisionRuntime,
  repoKey: string,
): ProjectAssignment[] {
  const directory = dirname(projectAssignmentPath(runtime, repoKey, "lookup"));
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
    .map((entry) => {
      const assignment = readProjectAssignmentFile(
        join(directory, entry),
        repoKey,
      );
      if (!assignment)
        throw projectAssignmentReadError(
          join(directory, entry),
          "file disappeared while listing",
        );
      return assignment;
    })
    .sort((a, b) => a.branch.localeCompare(b.branch));
}

export function findProjectAssignmentBySession(
  runtime: SupervisionRuntime,
  repoKey: string,
  sessionId: string,
): ProjectAssignment[] {
  return listProjectAssignments(runtime, repoKey).filter(
    (assignment) => assignment.id === sessionId,
  );
}

export function removeProjectAssignment(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): void {
  const path = projectAssignmentPath(runtime, repoKey, branch);
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export type ProjectMessage = Readonly<{
  version: 2;
  id: string;
  repoKey: string;
  branch: string;
  fromSessionId: string;
  text: string;
  resultBindings?: ResultBinding[];
  createdAt: number;
}>;

function projectMessageDirectory(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): string {
  const assignment = projectAssignmentPath(runtime, repoKey, branch);
  return join(dirname(assignment), `${basename(assignment, ".json")}.messages`);
}

function validProjectMessage(value: unknown): value is ProjectMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).every((key) =>
      [
        "version",
        "id",
        "repoKey",
        "branch",
        "fromSessionId",
        "text",
        "createdAt",
        "resultBindings",
      ].includes(key),
    ) &&
    Object.keys(r).length >= 7 &&
    [
      "version",
      "id",
      "repoKey",
      "branch",
      "fromSessionId",
      "text",
      "createdAt",
    ].every((key) => Object.hasOwn(r, key)) &&
    r.version === 2 &&
    UUID.test(String(r.id)) &&
    validNativeIdentity(r.repoKey) &&
    validNativeIdentity(r.branch) &&
    validSession(r.fromSessionId) &&
    typeof r.text === "string" &&
    r.text.length > 0 &&
    (r.resultBindings === undefined ||
      (Array.isArray(r.resultBindings) &&
        r.resultBindings.every(isResultBinding))) &&
    Number.isInteger(r.createdAt) &&
    (r.createdAt as number) >= 0 &&
    Buffer.byteLength(`${JSON.stringify(r)}\n`, "utf8") <=
      COORDINATION_MESSAGE_MAX_BYTES
  );
}

export function projectMessageBytes(record: ProjectMessage): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
}

export function writeProjectMessage(
  record: ProjectMessage,
  runtime: SupervisionRuntime,
): void {
  if (!validProjectMessage(record)) throw new Error("Invalid project message");
  const directory = projectMessageDirectory(
    runtime,
    record.repoKey,
    record.branch,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(runtime.root, 0o700);
  chmodSync(runtime.assignments, 0o700);
  chmodSync(dirname(directory), 0o700);
  chmodSync(directory, 0o700);
  const path = join(directory, `${record.id}.json`);
  const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function listProjectMessages(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): ProjectMessage[] {
  const directory = projectMessageDirectory(runtime, repoKey, branch);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => UUID.test(entry.slice(0, -5)) && entry.endsWith(".json"))
    .map((entry) => {
      const path = join(directory, entry);
      try {
        if (statSync(path).size > COORDINATION_MESSAGE_MAX_BYTES)
          throw new Error("large");
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          !validProjectMessage(value) ||
          value.repoKey !== repoKey ||
          value.branch !== branch ||
          entry !== `${value.id}.json`
        )
          throw new Error("invalid");
        return value;
      } catch (error) {
        throw new Error(`Unable to read project message ${path}`, {
          cause: error,
        });
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function removeProjectMessages(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): void {
  rmSync(projectMessageDirectory(runtime, repoKey, branch), {
    recursive: true,
    force: true,
  });
  fsyncDirectory(dirname(projectAssignmentPath(runtime, repoKey, branch)));
}

export type CoordinatorState = {
  version: 1;
  build?: RuntimeBuild;
  role?: CoordinatorRole;
  instanceId: string;
  piSessionId: string;
  updatedAt: number;
};
export type LeadCoordinationState = CoordinatorState;

export function verifyManagerCoordinationAuthority(
  descriptor: ManagerDescriptor,
  coordinator: LeadCoordinationState | undefined,
  build: RuntimeBuild,
  requireCompatibleBuild: typeof import("./compatibility.ts").requireCompatibleBuild,
): void {
  if (
    !coordinator ||
    coordinator.role !== "manager" ||
    coordinator.piSessionId !== descriptor.piSessionId
  )
    throw new Error(
      "Manager authority exists but its coordination state could not be verified",
    );
  requireCompatibleBuild(
    build,
    descriptor.build,
    "supervision",
    `Manager ${descriptor.piSessionId}`,
  );
  requireCompatibleBuild(
    build,
    coordinator.build,
    "supervision",
    `Manager ${descriptor.piSessionId}`,
  );
}

export async function verifyRemoteChiefAuthority(
  descriptor: ChiefDescriptor,
  options: {
    remoteIdentity(): Promise<unknown | undefined>;
    requireCompatibleBuild: typeof import("./compatibility.ts").requireCompatibleBuild;
    build: RuntimeBuild;
  },
): Promise<boolean> {
  if (!(await options.remoteIdentity())) return false;
  options.requireCompatibleBuild(
    options.build,
    descriptor.build,
    "supervision",
    `Chief ${descriptor.piSessionId}`,
  );
  return true;
}

export async function leadSupervisorState<S, A>(
  ctx: ExtensionContext,
  host: {
    currentWorktreeScope(ctx: ExtensionContext): Promise<S | undefined>;
    projectAssignmentForScope(scope: S, sessionId: string): A | undefined;
    currentManager(
      ctx: ExtensionContext,
      scope?: S | null,
    ): Promise<unknown | undefined>;
    currentChiefAuthority(
      ctx: ExtensionContext,
      failOnVerificationError?: boolean,
    ): Promise<unknown | undefined>;
  },
): Promise<string> {
  try {
    const scope = await host.currentWorktreeScope(ctx);
    const assignment = scope
      ? host.projectAssignmentForScope(scope, ctx.sessionManager.getSessionId())
      : undefined;
    if (assignment) {
      try {
        if (await host.currentManager(ctx, scope))
          return `<supervisor_state>\nsupervisor: manager\navailability: available\nproject_messages: retained across Manager turnover\n</supervisor_state>`;
      } catch {
        return `<supervisor_state>\nsupervisor: manager\navailability: unknown\nproject_messages: retained for the Manager role\n</supervisor_state>`;
      }
      return `<supervisor_state>\nsupervisor: manager\navailability: unavailable\nproject_messages: retained for the Manager role\n</supervisor_state>`;
    }
    const manager = await host.currentManager(ctx, scope);
    if (manager)
      return `<supervisor_state>\nsupervisor: manager\navailability: available\n</supervisor_state>`;
    const chief = await host.currentChiefAuthority(ctx, true);
    if (chief)
      return `<supervisor_state>\nsupervisor: chief\navailability: available\n</supervisor_state>`;
    return `<supervisor_state>\nsupervisor: none\navailability: unavailable\nguidance: continue independently; do not use supervisor_message until a supervisor is available\n</supervisor_state>`;
  } catch {
    return `<supervisor_state>\nsupervisor: unverified\navailability: unknown\nguidance: continue independently; do not use supervisor_message until a supervisor is verified\n</supervisor_state>`;
  }
}

export function supervisorStateMessage(
  customType: string,
  content: string,
  latestContent: string | undefined,
): { customType: string; content: string; display: false } | undefined {
  return latestContent === content
    ? undefined
    : { customType, content, display: false };
}

export type SupervisedLead = {
  lead: string;
  branch?: string;
  herdRunStartedAt?: number;
  contextPercent?: number;
  /** Internal: path to a non-empty persisted session candidate. */
  piSessionFile?: string;
  instanceId?: string;
  displayName: string;
  workspaceId: string;
  workspaceLabel?: string;
  tabId: string;
  paneId: string;
  runtimeState: RuntimeState;
  agentCounts: { active: number; blocked: number; total: number };
  availableActions: Array<"inspect" | "transcript" | "message">;
  agents: Array<{ id: string; label: string; state: RuntimeState }>;
};
/** Chief can act on these Managers only; nested Leads are observational. */
export type SupervisedManager = {
  session: string;
  instanceId?: string;
  displayName: string;
  project: string;
  workspaceId: string;
  paneId: string;
  tabId: string;
  runtimeState: RuntimeState;
  agentCounts: { active: number; blocked: number; total: number };
  leadCounts: { active: number; blocked: number; total: number };
  leads: Array<{
    session: string;
    displayName: string;
    runtimeState: RuntimeState;
    agentCounts: { active: number; blocked: number; total: number };
  }>;
  availableActions: Array<"inspect" | "transcript" | "message">;
};
/** A Chief snapshot has Managers as its only actionable reports. */
export type ChiefManagerReportSnapshot = {
  managers: SupervisedManager[];
  diagnostics?: string[];
};
export type SupervisionSnapshot = {
  leads: SupervisedLead[];
  project?: string;
  work?: ProjectWorkSnapshot[];
  openWorkspaces?: readonly OpenProjectWorkspace[];
  diagnostics?: string[];
};
export type OpenProjectWorkspace = Readonly<{
  workspaceId: string;
  branch?: string;
  path: string;
  linked: boolean;
}>;
export type ProjectWorkStatus = "active" | "paused" | "conflict";
export type ProjectWorkSnapshot = Readonly<{
  branch: string;
  session: string;
  status: ProjectWorkStatus;
  runtimeState?: RuntimeState;
  task?: string;
  issue?: string;
}>;
/** Derive work from one caller-validated Lead inventory and one Herdr worktree list. */
export function projectWorkSnapshot(options: {
  assignments: readonly ProjectAssignment[];
  worktrees: readonly Readonly<{
    branch: string;
    open_workspace_id?: string | null;
  }>[];
  leads: readonly Pick<
    SupervisedLead,
    "lead" | "workspaceId" | "runtimeState"
  >[];
}): ProjectWorkSnapshot[] {
  return options.assignments.map((assignment) => {
    const worktrees = options.worktrees.filter(
      (item) => item.branch === assignment.branch,
    );
    const exact = options.leads.filter((lead) => lead.lead === assignment.id);
    let status: ProjectWorkStatus;
    let runtimeState: RuntimeState | undefined;
    let issue: string | undefined;
    if (worktrees.length > 1 || exact.length > 1) {
      status = "conflict";
      issue = "project runtime identity is ambiguous";
    } else {
      const workspaceId = worktrees[0]?.open_workspace_id ?? undefined;
      const occupants = workspaceId
        ? options.leads.filter((lead) => lead.workspaceId === workspaceId)
        : [];
      if (
        exact.length === 1 &&
        (!workspaceId || exact[0]!.workspaceId !== workspaceId)
      ) {
        status = "conflict";
        issue = "assigned Lead is running outside its branch worktree";
      } else if (occupants.some((lead) => lead.lead !== assignment.id)) {
        status = "conflict";
        issue = "another Lead is active in this worktree";
      } else if (exact.length === 1) {
        status = "active";
        runtimeState = exact[0]!.runtimeState;
      } else {
        status = "paused";
      }
    }
    const task = assignment.text
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const characters = Array.from(task);
    return {
      branch: assignment.branch,
      session: assignment.id,
      status,
      ...(runtimeState ? { runtimeState } : {}),
      ...(task
        ? {
            task:
              characters.length <= 160
                ? task
                : `${characters.slice(0, 159).join("")}…`,
          }
        : {}),
      ...(issue ? { issue } : {}),
    };
  });
}
export type SupervisionPresentationSnapshot =
  SupervisionSnapshot | ChiefManagerReportSnapshot;
export type RuntimeState =
  | "idle"
  | "working"
  | "blocked"
  | "settling"
  | "starting"
  | "done"
  | "unknown"
  | "lost";
export type LiveAgent = {
  sessionId: string;
  /** Internal: path to a non-empty persisted session candidate. */
  piSessionFile?: string;
  sessionKind: "id";
  workspaceId: string;
  paneId: string;
  tabId: string;
  workspaceCwd?: string;
  herdrName?: string;
  tabLabel?: string;
  tokens?: Readonly<Record<string, unknown>>;
  runtimeState?: RuntimeState;
};
export type WorkspaceProvenance = Readonly<{
  workspaceLabel?: string;
  workspaceCwd?: string;
  repoName?: string;
  branch?: string;
}>;
export type ValidatedManagedAgentEvidence = {
  piSessionId: string;
  ownerSessionId: string;
  workspaceId: string;
  paneId: string;
  runtimeState: RuntimeState;
  agentLabel?: string;
};

export const LEAD_STATE_MAX_BYTES = COORDINATION_MESSAGE_MAX_BYTES * 2;
/** Fits the complete coordination record, including JSON and UTF-8 overhead. */
function leadStateDirectory(runtime: SupervisionRuntime): string {
  mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
  chmodSync(runtime.root, 0o700);
  mkdirSync(runtime.leads, { recursive: true, mode: 0o700 });
  chmodSync(runtime.leads, 0o700);
  return runtime.leads;
}
export function leadCoordinationStatePath(
  runtime: SupervisionRuntime,
  piSessionId: string,
): string {
  if (!validSession(piSessionId)) throw new Error("Invalid lead session ID");
  return join(
    runtime.leads,
    createHash("sha256").update(piSessionId).digest("hex") + ".json",
  );
}
function validLeadState(value: unknown): value is CoordinatorState {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const keys = ["version", "instanceId", "piSessionId", "updatedAt"];
  if (
    Object.keys(r).some(
      (k) => !keys.includes(k) && k !== "role" && k !== "build",
    ) ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return false;
  return (
    r.version === 1 &&
    (r.build === undefined || isRuntimeBuild(r.build)) &&
    (r.role === undefined || r.role === "lead" || r.role === "manager") &&
    UUID.test(String(r.instanceId)) &&
    validSession(r.piSessionId) &&
    Number.isInteger(r.updatedAt) &&
    (r.updatedAt as number) >= 0
  );
}
export function readLeadCoordinationState(
  runtime: SupervisionRuntime,
  piSessionId: string,
): LeadCoordinationState | undefined {
  const path = leadCoordinationStatePath(runtime, piSessionId);
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > LEAD_STATE_MAX_BYTES)
      throw new Error("lead state too large");
    const value: unknown = JSON.parse(text);
    const currentState =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "pendingAsk"),
          )
        : value;
    if (
      !validLeadState(currentState) ||
      currentState.piSessionId !== piSessionId
    )
      throw new Error("invalid lead state");
    return currentState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read lead coordination state", { cause: e });
  }
}
export function writeLeadCoordinationState(
  runtime: SupervisionRuntime,
  state: LeadCoordinationState,
): string {
  if (!state.build || !validLeadState(state))
    throw new Error("Invalid lead coordination state");
  const directory = leadStateDirectory(runtime);
  const path = leadCoordinationStatePath(runtime, state.piSessionId);
  const content = JSON.stringify(state) + "\n";
  if (Buffer.byteLength(content, "utf8") > LEAD_STATE_MAX_BYTES)
    throw new Error("Lead coordination state is too large");
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
    return path;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/** Remove a failed publication so an older generation cannot remain authority. */
export function invalidateLeadCoordinationState(
  runtime: SupervisionRuntime,
  piSessionId: string,
  expectedInstanceId?: string,
): void {
  const path = leadCoordinationStatePath(runtime, piSessionId);
  if (expectedInstanceId !== undefined) {
    const current = readLeadCoordinationState(runtime, piSessionId);
    if (!current || current.instanceId !== expectedInstanceId) return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  fsyncDirectory(dirname(path));
}

export const coordinatorStatePath = leadCoordinationStatePath;
export const readCoordinatorState = readLeadCoordinationState;
export const writeCoordinatorState = writeLeadCoordinationState;
export const invalidateCoordinatorState = invalidateLeadCoordinationState;
export const COORDINATOR_STATE_MAX_BYTES = LEAD_STATE_MAX_BYTES;
export const peerRecordPath = peerLeadRecordPath;
export const peerLockPath = peerLeadLockPath;
export const readPeerRecord = readPeerLeadRecord;
export const writePeerRecord = writePeerLeadRecord;
export const listPeerRecords = listPeerLeadRecords;
export const removePeerRecord = removePeerLeadRecord;
export const samePeerRecord = samePeerLeadRecord;
export const samePeerGeneration = samePeerLeadGeneration;

export function normalizeHerdrLifecycleState(agent: any): RuntimeState {
  const state = agent?.agent_status;
  return state === "idle" ||
    state === "working" ||
    state === "blocked" ||
    state === "done"
    ? state
    : "unknown";
}

function metadataInteger(
  tokens: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const raw = tokens?.[key];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Projects caller-proven live leads and validated agent evidence; metadata is never authority. */
export function projectSupervision(options: {
  agents: LiveAgent[];
  managedAgents: ValidatedManagedAgentEvidence[];
  coordinationStates: LeadCoordinationState[];
  openWorkspaces?: readonly OpenProjectWorkspace[];
  workspaceProvenance?: ReadonlyMap<string, WorkspaceProvenance>;
  chiefSessionId?: string;
  excludedSessionIds?: ReadonlySet<string>;
  /** Leads already reported to an active Manager must not also report to Chief. */
  managerSupervisedLeadSessionIds?: ReadonlySet<string>;
  managedAgentSessionIds?: Set<string>;
}): SupervisionSnapshot {
  const states = new Map<string, LeadCoordinationState>();
  const duplicateStates = new Set<string>();
  for (const state of options.coordinationStates) {
    if (states.has(state.piSessionId)) duplicateStates.add(state.piSessionId);
    else states.set(state.piSessionId, state);
  }
  const leads: SupervisedLead[] = [];
  const validAgents = options.agents.filter(
    (agent) =>
      agent.sessionKind === "id" &&
      validSession(agent.sessionId) &&
      validNativeIdentity(agent.workspaceId) &&
      validNativeIdentity(agent.tabId) &&
      validNativeIdentity(agent.paneId),
  );
  const duplicatePhysical = new Set<string>();
  const physical = new Map<string, string>();
  for (const agent of validAgents) {
    const key = `${agent.workspaceId}\0${agent.tabId}\0${agent.paneId}`;
    const previous = physical.get(key);
    if (previous && previous !== agent.sessionId) duplicatePhysical.add(key);
    else physical.set(key, agent.sessionId);
  }
  const seenLeads = new Set<string>();
  const duplicateAgents = new Set<string>();
  for (const agent of validAgents) {
    if (seenLeads.has(agent.sessionId)) duplicateAgents.add(agent.sessionId);
    else seenLeads.add(agent.sessionId);
  }
  seenLeads.clear();
  for (const agent of validAgents) {
    if (seenLeads.has(agent.sessionId)) continue;
    seenLeads.add(agent.sessionId);
    const state = states.get(agent.sessionId);
    if (
      !state ||
      (state.role ?? "lead") !== "lead" ||
      duplicateAgents.has(agent.sessionId) ||
      duplicateStates.has(agent.sessionId) ||
      agent.sessionId === options.chiefSessionId ||
      options.excludedSessionIds?.has(agent.sessionId) ||
      options.managerSupervisedLeadSessionIds?.has(agent.sessionId) ||
      options.managedAgentSessionIds?.has(agent.sessionId) ||
      duplicatePhysical.has(
        `${agent.workspaceId}\0${agent.tabId}\0${agent.paneId}`,
      )
    )
      continue;
    const runtimeState = agent.runtimeState ?? "unknown";
    const provenance =
      options.workspaceProvenance?.get(agent.workspaceId) ??
      (agent.workspaceCwd ? { workspaceCwd: agent.workspaceCwd } : undefined);
    const workspaceLabel =
      provenance?.repoName && provenance.branch
        ? `${provenance.repoName}/${provenance.branch}`
        : provenance?.workspaceLabel ||
          (provenance?.workspaceCwd
            ? basename(provenance.workspaceCwd)
            : undefined) ||
          agent.workspaceId;
    const tokensName =
      typeof agent.tokens?.pi_herdsman_name === "string"
        ? agent.tokens.pi_herdsman_name.trim()
        : "";
    const herdrName = agent.herdrName?.trim();
    const tabLabel = agent.tabLabel?.trim();
    const name =
      tokensName ||
      (herdrName &&
      herdrName !== agent.sessionId &&
      !/_[0-9a-f]{16}$/iu.test(herdrName)
        ? herdrName
        : undefined) ||
      tabLabel ||
      `lead-${agent.sessionId.slice(0, 8)}`;
    const herdRunStartedAt = metadataInteger(
      agent.tokens,
      "pi_herdsman_herd_run_started_at",
    );
    const contextPercent = metadataInteger(
      agent.tokens,
      "pi_herdsman_context_percent",
    );
    leads.push({
      lead: agent.sessionId,
      ...(herdRunStartedAt !== undefined ? { herdRunStartedAt } : {}),
      ...(contextPercent !== undefined ? { contextPercent } : {}),
      instanceId: state.instanceId,
      displayName: `${workspaceLabel || agent.workspaceId}/${name}`,
      ...(provenance?.branch ? { branch: provenance.branch } : {}),
      workspaceId: agent.workspaceId,
      ...(workspaceLabel ? { workspaceLabel } : {}),
      tabId: agent.tabId,
      paneId: agent.paneId,
      runtimeState,
      agentCounts: { active: 0, blocked: 0, total: 0 },
      ...(agent.piSessionFile ? { piSessionFile: agent.piSessionFile } : {}),
      availableActions: [
        "inspect",
        ...(agent.piSessionFile ? ["transcript" as const] : []),
      ],
      agents: [],
    });
  }
  const leadIds = new Set(leads.map((r) => r.lead));
  const ambiguousAgents = new Set<string>();
  const byId = new Map<string, ValidatedManagedAgentEvidence>();
  for (const managedAgent of options.managedAgents) {
    if (byId.has(managedAgent.piSessionId))
      ambiguousAgents.add(managedAgent.piSessionId);
    else byId.set(managedAgent.piSessionId, managedAgent);
  }
  for (const managedAgent of options.managedAgents) {
    if (ambiguousAgents.has(managedAgent.piSessionId)) continue;
    let owner = managedAgent.ownerSessionId;
    const seen = new Set<string>();
    while (!leadIds.has(owner)) {
      if (ambiguousAgents.has(owner) || seen.has(owner)) {
        owner = "";
        break;
      }
      seen.add(owner);
      owner = byId.get(owner)?.ownerSessionId ?? "";
    }
    const lead = leads.find((r) => r.lead === owner);
    if (!lead) continue;
    lead.agentCounts.total++;
    if (
      managedAgent.runtimeState === "working" ||
      managedAgent.runtimeState === "settling" ||
      managedAgent.runtimeState === "starting"
    )
      lead.agentCounts.active++;
    if (managedAgent.runtimeState === "blocked") lead.agentCounts.blocked++;
    if (lead.agents.length < 32)
      lead.agents.push({
        id: managedAgent.piSessionId,
        label: managedAgent.agentLabel ?? managedAgent.piSessionId,
        state: managedAgent.runtimeState,
      });
  }
  for (const lead of leads) {
    lead.availableActions.push("message");
  }
  leads.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.lead.localeCompare(b.lead),
  );
  return {
    leads,
    ...(options.openWorkspaces
      ? { openWorkspaces: options.openWorkspaces }
      : {}),
  };
}

export function serializeSupervision(snapshot: SupervisionSnapshot) {
  return {
    ...(snapshot.diagnostics?.length
      ? { diagnostics: snapshot.diagnostics }
      : {}),
    leads: snapshot.leads.map((r) => ({
      session: r.lead,
      display_name: r.displayName,
      workspace_id: r.workspaceId,
      ...(r.workspaceLabel ? { workspace_label: r.workspaceLabel } : {}),
      tab_id: r.tabId,
      pane_id: r.paneId,
      runtime_state: r.runtimeState,
      agent_counts: r.agentCounts,
      available_tools: r.availableActions.map((action) => `staff_${action}`),
      agents: r.agents,
    })),
  };
}
