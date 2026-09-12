import {
  chmodSync,
  closeSync,
  fsyncSync,
  readdirSync,
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
import { acquireProcessLock, type ProcessLockClaim } from "./lock.ts";
import { herdsmanDataRoot } from "./storage.ts";

export type LeadRole = "lead" | "chief";

export function sessionLeadRole(entries: unknown[]): LeadRole {
  const entry = [...entries]
    .reverse()
    .find(
      (candidate: any) =>
        candidate?.type === "custom" &&
        candidate.customType === "pi-herdsman-role",
    ) as any;
  if (!entry) return "lead";
  const data = entry.data;
  if (
    !data ||
    typeof data !== "object" ||
    Object.keys(data).length !== 1 ||
    (data.role !== "lead" && data.role !== "chief")
  )
    throw new Error("invalid pi-herdsman-role entry");
  return data.role;
}

export type ChiefDescriptor = {
  version: 1;
  leaseId: string;
  claim: ProcessLockClaim;
  piSessionId: string;
  paneId: string;
  tabId?: string;
  workspaceId: string;
  createdAt: number;
};

export type ChiefIdentity = Omit<
  ChiefDescriptor,
  "version" | "leaseId" | "claim" | "createdAt"
> & {
  createdAt?: number;
};

export type SupervisionRuntime = {
  root: string;
  lock: string;
  descriptor: string;
  inbox: string;
  leads: string;
};

export type ChiefLease = {
  descriptor: ChiefDescriptor;
  runtime: SupervisionRuntime;
  release: () => void;
};

export type ChiefMessageKind =
  "chief_message" | "lead_message" | "lead_ask" | "chief_reply";

export type ChiefMessageRecord = {
  version: 1;
  id: string;
  leaseId: string;
  kind: ChiefMessageKind;
  fromSessionId: string;
  toSessionId: string;
  leadSessionId: string;
  askId?: string;
  text: string;
  createdAt: number;
};

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

export const CHIEF_MESSAGE_MAX_BYTES = 8 * 1024;
export const CHIEF_INBOX_SCAN_LIMIT = 32;
const CHIEF_DESCRIPTOR_MAX_BYTES = 2048;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_KINDS = new Set<ChiefMessageKind>([
  "chief_message",
  "lead_message",
  "lead_ask",
  "chief_reply",
]);

function validSession(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
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
  const optional = ["askId"];
  if (
    Object.keys(record).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    ) ||
    Object.keys(record).length < keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    (Object.hasOwn(record, "askId") && !UUID.test(String(record.askId)))
  )
    return false;
  return (
    record.version === 1 &&
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
    Number.isInteger(record.createdAt) &&
    (record.createdAt as number) >= 0 &&
    (record.kind === "lead_ask" || record.kind === "chief_reply"
      ? typeof record.askId === "string" && UUID.test(record.askId)
      : !Object.hasOwn(record, "askId"))
  );
}

export function chiefMessageBytes(record: ChiefMessageRecord): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
}

function assertMessage(value: unknown): asserts value is ChiefMessageRecord {
  if (!validMessage(value)) throw new Error("Invalid Chief message record");
  if (chiefMessageBytes(value) > CHIEF_MESSAGE_MAX_BYTES)
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
  // only after its owner is proven dead. Live, ambiguous, and malformed locks
  // fail closed and are retried by the caller.
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
  assertMessage(record);
  return withChiefMessageLock(
    chiefMessagePath(runtime, record.toSessionId, record.id),
    () => writeChiefMessageUnlocked(record, runtime, clearQuarantine),
  );
}

/** Publish a lead ask without replacing a record owned by another writer. */
export function writeChiefAskMessage(
  record: ChiefMessageRecord,
  runtime = supervisionRuntime(),
): string {
  assertMessage(record);
  if (record.kind !== "lead_ask" || !record.askId)
    throw new Error("Invalid Chief ask message record");
  return withChiefMessageLock(
    chiefMessagePath(runtime, record.toSessionId, record.id),
    () => {
      const path = chiefMessagePath(runtime, record.toSessionId, record.id);
      if (chiefMessageQuarantined(runtime, record.toSessionId, record.id))
        throw new Error("Chief ask message is quarantined or ambiguous");
      try {
        statSync(path);
        const current = readChiefMessage(path);
        if (
          current.version === record.version &&
          current.id === record.id &&
          current.leaseId === record.leaseId &&
          current.kind === record.kind &&
          current.fromSessionId === record.fromSessionId &&
          current.toSessionId === record.toSessionId &&
          current.leadSessionId === record.leadSessionId &&
          current.askId === record.askId &&
          current.text === record.text
        )
          return path;
        throw new Error(
          "Chief ask message ID already has a conflicting record",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return writeChiefMessageUnlocked(record, runtime, false);
    },
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
    if (statSync(path).size > CHIEF_MESSAGE_MAX_BYTES) return true;
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
  if (size > CHIEF_MESSAGE_MAX_BYTES)
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

export function listChiefMessagePaths(
  runtime: SupervisionRuntime,
  toSessionId: string,
  limit = CHIEF_INBOX_SCAN_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("Invalid inbox limit");
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
    .slice(0, Math.min(limit, CHIEF_INBOX_SCAN_LIMIT))
    .map(({ path }) => path);
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

/** Derive the one queue filename shared by lead publication and Chief repair. */
export function chiefAskMessageId(
  leadSessionId: string,
  askId: string,
  leaseId: string,
): string {
  const hash = createHash("sha256")
    .update(`${leadSessionId}\0${askId}\0${leaseId}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(
    13,
    16,
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Return whether this exact lead-generation ask is already queued. */
export function chiefAskQueued(
  runtime: SupervisionRuntime,
  toSessionId: string,
  leadSessionId: string,
  askId: string,
  leaseId?: string,
): boolean {
  return listChiefMessagePaths(runtime, toSessionId).some((path) => {
    const id = basename(path, ".json");
    if (UUID.test(id) && chiefMessageQuarantined(runtime, toSessionId, id))
      return false;
    try {
      const record = readChiefMessage(path);
      return (
        record.kind === "lead_ask" &&
        record.askId === askId &&
        record.leadSessionId === leadSessionId &&
        record.fromSessionId === leadSessionId &&
        (leaseId === undefined || record.leaseId === leaseId)
      );
    } catch {
      return false;
    }
  });
}

function deliveredMessageContent(record: ChiefMessageRecord): string {
  const prefix =
    record.kind === "chief_message" || record.kind === "chief_reply"
      ? `From chief ${record.fromSessionId} to lead ${record.leadSessionId}: `
      : `From lead ${record.leadSessionId} to chief ${record.toSessionId}: `;
  return Buffer.from(`${prefix}${record.text}`, "utf8")
    .subarray(0, CHIEF_MESSAGE_MAX_BYTES)
    .toString("utf8");
}

/** Drain only this session's inbox. Files remain when Pi rejects delivery. */
export async function drainChiefInbox(
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
              leadSessionId: record.leadSessionId,
              ...(record.askId ? { askId: record.askId } : {}),
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
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

function socketPath(): string {
  const value = process.env.HERDR_SOCKET_PATH;
  if (!value) throw new Error("HERDR_SOCKET_PATH is required");
  return value;
}

export function supervisionRuntime(socket = socketPath()): SupervisionRuntime {
  if (!socket) throw new Error("HERDR_SOCKET_PATH is required");
  const runtimeHash = createHash("sha256").update(socket).digest("hex");
  const root = join(herdsmanDataRoot(), "runtime", "supervision", runtimeHash);
  return {
    root,
    lock: join(root, "chief.lock"),
    descriptor: join(root, "chief.json"),
    inbox: join(root, "inbox"),
    leads: join(root, "leads"),
  };
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
  const optional = ["tabId"];
  const claim =
    record.claim && typeof record.claim === "object"
      ? (record.claim as Record<string, unknown>)
      : undefined;
  return (
    Object.keys(record).every(
      (key) => keys.includes(key) || optional.includes(key),
    ) &&
    Object.keys(record).length >= keys.length &&
    keys.every((key) => Object.hasOwn(record, key)) &&
    record.version === 1 &&
    typeof record.leaseId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.leaseId,
    ) &&
    !!claim &&
    Object.keys(claim).length === 2 &&
    Number.isInteger(claim.pid) &&
    (claim.pid as number) > 0 &&
    typeof claim.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      claim.id,
    ) &&
    typeof record.piSessionId === "string" &&
    record.piSessionId.length > 0 &&
    record.piSessionId.length <= 512 &&
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
    const entries = readdirSync(runtime.lock);
    if (entries.length !== 1) return false;
    const owner = entries[0];
    const claim = JSON.parse(
      readFileSync(join(runtime.lock, owner), "utf8"),
    ) as {
      pid?: unknown;
      id?: unknown;
    };
    if (
      Object.keys(claim).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(claim, "pid") ||
      !Object.prototype.hasOwnProperty.call(claim, "id") ||
      !Number.isInteger(claim.pid) ||
      (claim.pid as number) <= 0 ||
      typeof claim.id !== "string" ||
      !claim.id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        claim.id,
      ) ||
      owner !== `${claim.pid}-${claim.id}`
    )
      return false;
    process.kill(claim.pid as number, 0);
    const descriptor = readChiefDescriptor(runtime.descriptor);
    return (
      descriptor.claim.pid === claim.pid && descriptor.claim.id === claim.id
    );
  } catch {
    return false;
  }
}

function writeDescriptor(path: string, descriptor: ChiefDescriptor): void {
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
    actual.claim.pid === expected.claim.pid &&
    actual.claim.id === expected.claim.id &&
    actual.piSessionId === expected.piSessionId &&
    actual.paneId === expected.paneId &&
    actual.tabId === expected.tabId &&
    actual.workspaceId === expected.workspaceId &&
    actual.createdAt === expected.createdAt
  );
}

export function claimChiefLease(identity: ChiefIdentity): ChiefLease {
  if (
    !identity ||
    typeof identity.piSessionId !== "string" ||
    !identity.piSessionId ||
    identity.piSessionId.length > 512 ||
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
    leaseId: randomUUID(),
    claim: lease.claim,
    piSessionId: identity.piSessionId,
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

export type LeadCoordinationState = {
  version: 1;
  instanceId: string;
  piSessionId: string;
  pendingAsk?: { askId: string; question: string; text: string };
  updatedAt: number;
};

export type SupervisedLead = {
  lead: string;
  instanceId?: string;
  displayName: string;
  workspaceId: string;
  workspaceLabel?: string;
  tabId: string;
  paneId: string;
  runtimeState: RuntimeState;
  needsYou: boolean;
  pendingAskId?: string;
  pendingAskQuestion?: string;
  agentCounts: { working: number; blocked: number; total: number };
  lastActivity?: number;
  availableActions: Array<"inspect" | "message" | "reply">;
  agents: Array<{ id: string; label: string; state: RuntimeState }>;
};
export type SupervisionSnapshot = {
  leads: SupervisedLead[];
  diagnostics?: string[];
};
export type RuntimeState = "idle" | "working" | "blocked" | "done" | "unknown";
export type LiveAgent = {
  sessionId: string;
  sessionKind: "id";
  workspaceId: string;
  paneId: string;
  tabId: string;
  workspaceCwd?: string;
  herdrName?: string;
  tabLabel?: string;
  sessionName?: string;
  tokens?: Readonly<Record<string, unknown>>;
  runtimeState?: RuntimeState;
  lastActivity?: number;
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

export const LEAD_STATE_MAX_BYTES = CHIEF_MESSAGE_MAX_BYTES * 2;
/** Fits the complete coordination record, including JSON and UTF-8 overhead. */
export const LEAD_STATE_MAX_QUESTION_CHARS = 1024;
export const LEAD_STATE_MAX_QUESTION_BYTES = 1024;
export function validLeadCoordinationQuestion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= LEAD_STATE_MAX_QUESTION_CHARS &&
    Buffer.byteLength(value, "utf8") <= LEAD_STATE_MAX_QUESTION_BYTES
  );
}
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
function validLeadState(value: unknown): value is LeadCoordinationState {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const keys = ["version", "instanceId", "piSessionId", "updatedAt"];
  if (
    Object.keys(r).some((k) => !keys.includes(k) && k !== "pendingAsk") ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return false;
  const ask = r.pendingAsk;
  return (
    r.version === 1 &&
    UUID.test(String(r.instanceId)) &&
    validSession(r.piSessionId) &&
    Number.isInteger(r.updatedAt) &&
    (r.updatedAt as number) >= 0 &&
    (ask === undefined ||
      (!!ask &&
        typeof ask === "object" &&
        Object.keys(ask).length === 3 &&
        UUID.test((ask as any).askId) &&
        validLeadCoordinationQuestion((ask as any).question) &&
        typeof (ask as any).text === "string" &&
        (ask as any).text.length > 0))
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
    const value = JSON.parse(text);
    if (!validLeadState(value) || value.piSessionId !== piSessionId)
      throw new Error("invalid lead state");
    return value;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read lead coordination state", { cause: e });
  }
}
export function writeLeadCoordinationState(
  runtime: SupervisionRuntime,
  state: LeadCoordinationState,
): string {
  if (!validLeadState(state))
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

export function normalizeHerdrLifecycleState(agent: any): RuntimeState {
  const state = agent?.agent_status;
  return state === "idle" ||
    state === "working" ||
    state === "blocked" ||
    state === "done"
    ? state
    : "unknown";
}

/** Projects caller-proven live leads and validated agent evidence; metadata is never authority. */
export function projectSupervision(options: {
  agents: LiveAgent[];
  managedAgents: ValidatedManagedAgentEvidence[];
  coordinationStates: LeadCoordinationState[];
  workspaceProvenance?: ReadonlyMap<string, WorkspaceProvenance>;
  chiefSessionId?: string;
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
      duplicateAgents.has(agent.sessionId) ||
      duplicateStates.has(agent.sessionId) ||
      agent.sessionId === options.chiefSessionId ||
      options.managedAgentSessionIds?.has(agent.sessionId) ||
      duplicatePhysical.has(
        `${agent.workspaceId}\0${agent.tabId}\0${agent.paneId}`,
      )
    )
      continue;
    const pending = state.pendingAsk;
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
    const sessionName =
      typeof agent.sessionName === "string" ? agent.sessionName.trim() : "";
    const herdrName = agent.herdrName?.trim();
    const tabLabel = agent.tabLabel?.trim();
    const name =
      tokensName ||
      sessionName ||
      (herdrName &&
      herdrName !== agent.sessionId &&
      !/_[0-9a-f]{16}$/iu.test(herdrName)
        ? herdrName
        : undefined) ||
      tabLabel ||
      `lead-${agent.sessionId.slice(0, 8)}`;
    leads.push({
      lead: agent.sessionId,
      instanceId: state.instanceId,
      displayName: `${workspaceLabel || agent.workspaceId}/${name}`,
      workspaceId: agent.workspaceId,
      ...(workspaceLabel ? { workspaceLabel } : {}),
      tabId: agent.tabId,
      paneId: agent.paneId,
      runtimeState,
      needsYou: !!pending,
      ...(pending ? { pendingAskId: pending.askId } : {}),
      ...(pending ? { pendingAskQuestion: pending.question } : {}),
      agentCounts: { working: 0, blocked: 0, total: 0 },
      ...(agent.lastActivity !== undefined
        ? { lastActivity: agent.lastActivity }
        : {}),
      availableActions: ["inspect"],
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
    if (managedAgent.runtimeState === "working") lead.agentCounts.working++;
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
    if (lead.pendingAskId) lead.availableActions.push("reply");
  }
  leads.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.lead.localeCompare(b.lead),
  );
  return { leads };
}

export function serializeSupervision(snapshot: SupervisionSnapshot) {
  return {
    ...(snapshot.diagnostics?.length
      ? { diagnostics: snapshot.diagnostics }
      : {}),
    leads: snapshot.leads.map((r) => ({
      lead: r.lead,
      display_name: r.displayName,
      workspace_id: r.workspaceId,
      ...(r.workspaceLabel ? { workspace_label: r.workspaceLabel } : {}),
      tab_id: r.tabId,
      pane_id: r.paneId,
      runtime_state: r.runtimeState,
      needs_you: r.needsYou,
      ...(r.pendingAskId ? { pending_ask_id: r.pendingAskId } : {}),
      ...(r.pendingAskQuestion
        ? { pending_ask_question: r.pendingAskQuestion }
        : {}),
      agent_counts: r.agentCounts,
      ...(r.lastActivity !== undefined
        ? { last_activity: r.lastActivity }
        : {}),
      available_actions: r.availableActions,
      agents: r.agents,
    })),
  };
}
