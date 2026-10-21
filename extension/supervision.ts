import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  fstatSync,
  readdirSync,
  rmSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  acquireProcessLock,
  isProcessLockClaim,
  readLiveProcessLock,
  readProcessLockStatus,
  type ProcessLockClaim,
} from "./lock.ts";
import {
  herdsmanDataRoot,
  isIncidentalMetadata,
  isResultBinding,
  isRequiredEvidence,
  upgradeAndVerifyRequiredEvidence,
  verifySemanticEvidenceReservation,
  type RequiredEvidence,
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

export type SessionKindEntry =
  | { version: 1; sessionId: string; kind: "ordinary" }
  | {
      version: 1;
      sessionId: string;
      kind: "managed";
      repoKey: string;
      branch: string;
    };

// Identity is session-wide, unlike branch-local role and execution preferences.
export function readSessionKind(
  entries: readonly unknown[],
  sessionId: string,
): SessionKindEntry | undefined {
  let identity: SessionKindEntry | undefined;
  for (const candidate of entries as readonly any[]) {
    if (
      candidate?.type !== "custom" ||
      candidate.customType !== "pi-herdsman-session-kind" ||
      candidate.data?.sessionId !== sessionId
    )
      continue;
    const data = candidate.data;
    if (
      !validSession(sessionId) ||
      Array.isArray(data) ||
      data.version !== 1 ||
      (data.kind !== "ordinary" && data.kind !== "managed") ||
      Object.keys(data).length !== (data.kind === "managed" ? 5 : 3) ||
      (data.kind === "managed" &&
        (typeof data.repoKey !== "string" ||
          !data.repoKey.trim() ||
          typeof data.branch !== "string" ||
          !data.branch.trim()))
    )
      throw new Error("invalid pi-herdsman-session-kind entry");
    if (identity && !isDeepStrictEqual(identity, data))
      throw new Error("conflicting pi-herdsman-session-kind entries");
    identity = data;
  }
  return identity;
}

export type LeadRoleState = Readonly<{
  role: LeadRole;
  leadTools: readonly string[];
}>;

export function sessionLeadRoleState(
  entries: readonly unknown[],
  sessionId: string,
): LeadRoleState | undefined {
  let state: LeadRoleState | undefined;
  for (const candidate of entries as readonly any[]) {
    if (
      candidate?.type !== "custom" ||
      candidate.customType !== "pi-herdsman-role" ||
      candidate.data?.sessionId !== sessionId
    )
      continue;
    const data = candidate.data;
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).length !== 3 ||
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
    state = { role: data.role, leadTools: [...data.leadTools] };
  }
  return state;
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
  peerSource?: PeerSource;
  createdAt: number;
};

type OverflowBodyRef = { bytes: number; sha256: string };
type StoredChiefMessage = Omit<
  ChiefMessageRecord,
  "text" | "resultBindings"
> & {
  text: string;
  resultBindings?: ResultBinding[];
  bodyRef?: OverflowBodyRef;
};

export type PeerGroup = Readonly<{
  repoKey: string;
  primaryWorkspaceId: string;
}>;
export type PeerSource =
  | { role: "manager" }
  | { role: "lead"; socket: string; group: PeerGroup | null; managed: boolean };
export type PeerContext = PeerSource;

export function canMessagePeer(a: PeerContext, b: PeerContext): boolean {
  if (a.role !== b.role) return false;
  if (a.role === "manager") return true;
  if (b.role !== "lead") return false;
  if (!a.managed && !b.managed) return true;
  return (
    !!a.group &&
    !!b.group &&
    a.socket === b.socket &&
    a.group.repoKey === b.group.repoKey &&
    a.group.primaryWorkspaceId === b.group.primaryWorkspaceId
  );
}

export type CoordinationMessageRecord = ChiefMessageRecord;

export type ChiefInboxDrainOptions = {
  runtime: SupervisionRuntime;
  sessionId: string;
  signal?: AbortSignal;
  isAuthorized: (record: ChiefMessageRecord) => boolean | Promise<boolean>;
  isDelivered: (id: string) => boolean;
  deliveryMode?: (
    record: ChiefMessageRecord,
  ) =>
    | "steer"
    | "followUp"
    | undefined
    | Promise<"steer" | "followUp" | undefined>;
  sendMessage: (
    message: unknown,
    options: {
      deliverAs?: "steer" | "followUp";
      triggerTurn: boolean;
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
const COORDINATION_BODY_MAX_BYTES = 1024 * 1024;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_KINDS = new Set<ChiefMessageKind>(COORDINATION_MESSAGE_KINDS);

function validOverflowBodyRef(value: unknown): value is OverflowBodyRef {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Number.isInteger((value as any).bytes) &&
    (value as any).bytes > 0 &&
    (value as any).bytes <= COORDINATION_BODY_MAX_BYTES &&
    /^[a-f0-9]{64}$/.test((value as any).sha256)
  );
}

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
  const optional = [
    "branch",
    "resultBindings",
    "build",
    "peerSource",
    "bodyRef",
  ];
  if (
    Object.keys(record).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    ) ||
    Object.keys(record).length < keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  )
    return false;
  const projectMessage = record.kind === "project_assignment";
  const peerMessage = record.kind === "peer_message";
  const source = record.peerSource as Record<string, unknown> | undefined;
  const validPeerSource =
    source &&
    typeof source === "object" &&
    (source.role === "manager"
      ? Object.keys(source).length === 1
      : source.role === "lead" &&
        Object.keys(source).length === 4 &&
        typeof source.socket === "string" &&
        source.socket.length > 0 &&
        source.socket.length <= 4096 &&
        typeof source.managed === "boolean" &&
        (source.group === null
          ? !source.managed
          : !!source.group &&
            typeof source.group === "object" &&
            Object.keys(source.group).length === 2 &&
            validNativeIdentity(
              (source.group as Record<string, unknown>).repoKey,
            ) &&
            validNativeIdentity(
              (source.group as Record<string, unknown>).primaryWorkspaceId,
            )));
  if (
    projectMessage
      ? !validNativeIdentity(record.branch)
      : record.branch !== undefined &&
        (record.kind !== "manager_message" ||
          !validNativeIdentity(record.branch))
  ) {
    return false;
  }
  return (
    record.version === 2 &&
    (peerMessage ? !!validPeerSource : record.peerSource === undefined) &&
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
    (record.bodyRef === undefined
      ? record.text.length > 0
      : record.text === "" &&
        record.resultBindings === undefined &&
        validOverflowBodyRef(record.bodyRef)) &&
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

function compactChiefMessage(
  record: ChiefMessageRecord,
  path: string,
): StoredChiefMessage {
  if (chiefMessageBytes(record) <= COORDINATION_MESSAGE_MAX_BYTES)
    return record;
  const bodyRef = writeOverflowBody(`${path}.body`, {
    text: record.text,
    ...(record.resultBindings ? { resultBindings: record.resultBindings } : {}),
  });
  const stored: StoredChiefMessage = { ...record, text: "", bodyRef };
  delete stored.resultBindings;
  if (
    chiefMessageBytes(stored as ChiefMessageRecord) >
    COORDINATION_MESSAGE_MAX_BYTES
  )
    throw new Error("Chief message routing metadata is too large");
  return stored;
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

function publishRecord(path: string, content: string): string {
  const directory = dirname(path);
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

function writeOverflowBody(
  path: string,
  body: {
    text: string;
    resultBindings?: ResultBinding[];
  },
): OverflowBodyRef {
  const content = `${JSON.stringify(body)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > COORDINATION_BODY_MAX_BYTES)
    throw new Error("Coordination message body is too large");
  const sha256 = createHash("sha256").update(content).digest("hex");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > COORDINATION_BODY_MAX_BYTES)
      throw new Error("Unsafe existing coordination message body");
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    let existing: Buffer;
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.size > COORDINATION_BODY_MAX_BYTES)
        throw new Error("Unsafe existing coordination message body");
      existing = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < existing.length) {
        const count = readSync(
          fd,
          existing,
          offset,
          existing.length - offset,
          offset,
        );
        if (!count)
          throw new Error("Existing coordination message body is truncated");
        offset += count;
      }
      if (fstatSync(fd).size !== current.size)
        throw new Error(
          "Existing coordination message body changed while reading",
        );
    } finally {
      closeSync(fd);
    }
    if (
      existing.length !== bytes ||
      createHash("sha256").update(existing).digest("hex") !== sha256
    )
      throw new Error("Coordination message ID already has a different body");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    publishRecord(path, content);
  }
  return { bytes, sha256 };
}

function readOverflowBody(
  path: string,
  ref: OverflowBodyRef,
): {
  text: string;
  resultBindings?: ResultBinding[];
} {
  if (
    !ref ||
    !Number.isInteger(ref.bytes) ||
    ref.bytes < 1 ||
    ref.bytes > COORDINATION_BODY_MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(ref.sha256)
  )
    throw new Error("Invalid coordination message body reference");
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== ref.bytes)
      throw new Error("Coordination message body size mismatch");
    const bytes = Buffer.alloc(ref.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Coordination message body is truncated");
      offset += count;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
      throw new Error("Coordination message body integrity check failed");
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some(
        (key) => !["text", "resultBindings"].includes(key),
      ) ||
      typeof (parsed as any).text !== "string" ||
      !(parsed as any).text.length ||
      ((parsed as any).resultBindings !== undefined &&
        (!Array.isArray((parsed as any).resultBindings) ||
          !(parsed as any).resultBindings.every(isResultBinding)))
    )
      throw new Error("Invalid coordination message body");
    return parsed as { text: string; resultBindings?: ResultBinding[] };
  } catch (error) {
    throw new Error("Unable to read coordination message body", {
      cause: error,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
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
  if (!validMessage(record) || record.bodyRef !== undefined)
    throw new Error("Invalid Chief message record");
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
  if (record.kind !== "project_assignment") {
    try {
      statSync(path);
      const existing = readChiefMessage(path);
      if (!isDeepStrictEqual(existing, record))
        throw new Error(
          "Chief message ID already exists with a different payload",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const stored = compactChiefMessage(record, path);
  const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(stored)}\n`;
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

function readStoredChiefMessage(path: string): StoredChiefMessage {
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
    return parsed as StoredChiefMessage;
  } catch (error) {
    if (error instanceof Error && /Chief message record/.test(error.message))
      throw error;
    throw new Error("Invalid Chief message record", { cause: error });
  }
}

export function readChiefMessage(path: string): ChiefMessageRecord {
  const parsed = readStoredChiefMessage(path);
  if (parsed.bodyRef) {
    const body = readOverflowBody(`${path}.body`, parsed.bodyRef);
    const logical = { ...parsed, ...body } as ChiefMessageRecord;
    delete (logical as any).bodyRef;
    if (!validMessage(logical)) throw new Error("Invalid Chief message body");
    return logical;
  }
  return parsed as ChiefMessageRecord;
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
        const record = readStoredChiefMessage(path);
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
      const stored = readStoredChiefMessage(path);
      if ((expected as StoredChiefMessage).bodyRef)
        return isDeepStrictEqual(stored, expected);
      return isDeepStrictEqual(readChiefMessage(path), expected);
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
    unlinkSync(`${path}.body`);
    fsyncDirectory(directory);
  } catch {}
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
  return content;
}

/** Drain only this session's inbox. Files remain when Pi rejects delivery. */
export async function drainCoordinationInbox(
  options: ChiefInboxDrainOptions,
): Promise<number> {
  let delivered = 0;
  let examined = 0;
  for (const path of allChiefMessagePaths(options.runtime, options.sessionId)) {
    if (examined >= COORDINATION_INBOX_SCAN_LIMIT) break;
    if (options.signal?.aborted) break;
    const id = basename(path, ".json");
    if (
      UUID.test(id) &&
      chiefMessageQuarantined(options.runtime, options.sessionId, id)
    )
      continue;
    let stored: StoredChiefMessage;
    let record: ChiefMessageRecord;
    try {
      stored = readStoredChiefMessage(path);
      record = stored as ChiefMessageRecord;
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
    examined++;
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
    let deliverAs: "steer" | "followUp" | undefined;
    try {
      deliverAs = options.deliveryMode
        ? await options.deliveryMode(record)
        : "followUp";
    } catch {
      await clearTransaction();
      continue;
    }
    const wasAlreadyDelivered = options.isDelivered(record.id);
    if (!deliverAs && !wasAlreadyDelivered) {
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
        // Authorization may have yielded while Pi persisted an earlier send.
        if (!options.isDelivered(record.id)) {
          if (stored.bodyRef) {
            try {
              const body = readOverflowBody(`${path}.body`, stored.bodyRef);
              record = { ...record, ...body } as ChiefMessageRecord;
            } catch {
              examined--;
              await options.cleanupError?.(
                new Error(
                  `Unable to read overflow body for Chief message ${id}`,
                ),
              );
              await clearTransaction();
              continue;
            }
          }
          await options.sendMessage(
            {
              customType: `pi-herdsman-${record.kind}`,
              content: deliveredMessageContent(record),
              display: true,
              details: {
                id: record.id,
                leaseId: record.leaseId,
                fromSessionId: record.fromSessionId,
                toSessionId: record.toSessionId,
                leadSessionId: record.leadSessionId,
                ...(record.branch ? { branch: record.branch } : {}),
              },
            },
            { deliverAs: deliverAs ?? "followUp", triggerTurn: true },
            record,
          );
          await options.transaction?.revalidate(token, "after-send");
        }
      } catch {
        await clearTransaction();
        continue;
      }
      if (!options.isDelivered(record.id)) {
        // Pi submission is not a persistence acknowledgement.
        await clearTransaction();
        continue;
      }
      if (!wasAlreadyDelivered) delivered += 1;
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
        if (!wasAlreadyDelivered) delivered += 1;
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

const projectAuthorityLock = join(
  herdsmanDataRoot(),
  "runtime",
  "project-assignment-authority.lock",
);

export function projectAssignmentAuthorityLockPath(): string {
  return projectAuthorityLock;
}

function withProjectAssignmentLock<T>(operation: () => T): T {
  const lease = acquireProcessLock(projectAuthorityLock, {
    name: "project assignment authority",
  });
  try {
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new Error(
        "Project assignment authority operation must be synchronous",
      );
    return result;
  } finally {
    lease.release();
  }
}

export type PeerRuntime = SupervisionRuntime & {
  peers: string;
};

export type PeerRecord = Readonly<{
  version: 2;
  build?: RuntimeBuild;
  role?: PeerRole;
  sessionKind: "ordinary" | "managed";
  piSessionId: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  socket: string;
  group?: PeerGroup | null;
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
        "sessionKind",
        "piSessionId",
        "paneId",
        "tabId",
        "workspaceId",
        "socket",
        "group",
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
      "socket",
      "claim",
      "updatedAt",
    ].every((key) => Object.hasOwn(record, key)) &&
    record.version === 2 &&
    (record.build === undefined || isRuntimeBuild(record.build)) &&
    (record.role === undefined ||
      record.role === "lead" ||
      record.role === "manager") &&
    (record.sessionKind === "ordinary" || record.sessionKind === "managed") &&
    validSession(record.piSessionId) &&
    validNativeIdentity(record.paneId) &&
    validNativeIdentity(record.tabId) &&
    validNativeIdentity(record.workspaceId) &&
    typeof record.socket === "string" &&
    record.socket.length > 0 &&
    record.socket.length <= 4096 &&
    (record.group === undefined ||
      record.group === null ||
      (!!record.group &&
        typeof record.group === "object" &&
        Object.keys(record.group).length === 2 &&
        validNativeIdentity(
          (record.group as Record<string, unknown>).repoKey,
        ) &&
        validNativeIdentity(
          (record.group as Record<string, unknown>).primaryWorkspaceId,
        ))) &&
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
    actual.sessionKind === expected.sessionKind &&
    (actual.role ?? "lead") === (expected.role ?? "lead") &&
    actual.piSessionId === expected.piSessionId &&
    actual.paneId === expected.paneId &&
    actual.tabId === expected.tabId &&
    actual.workspaceId === expected.workspaceId &&
    actual.socket === expected.socket &&
    JSON.stringify(actual.group) === JSON.stringify(expected.group) &&
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

/** Authorization provenance, excluding presentation metadata. */
export function samePeerLeadAuthority(
  actual: PeerLeadRecord,
  expected: PeerLeadRecord,
): boolean {
  return (
    samePeerLeadGeneration(actual, expected) &&
    actual.sessionKind === expected.sessionKind &&
    (actual.role ?? "lead") === (expected.role ?? "lead") &&
    actual.socket === expected.socket &&
    actual.workspaceId === expected.workspaceId &&
    isDeepStrictEqual(actual.group, expected.group)
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
  peerDirectory(runtime);
  const path = peerLeadRecordPath(runtime, record.piSessionId);
  const content = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(content, "utf8") > PEER_LEAD_RECORD_MAX_BYTES)
    throw new Error("Peer lead record is too large");
  return publishRecord(path, content);
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
  piSessionFile?: string;
  resultBindings?: ResultBinding[];
  requiredEvidence?: RequiredEvidence[];
  currentEvidenceIds?: string[];
}>;

export const PROJECT_ASSIGNMENT_MAX_BYTES = 1024 * 1024;
const PROJECT_ASSIGNMENT_FILE_MAX_BYTES = PROJECT_ASSIGNMENT_MAX_BYTES * 2;

export function projectAssignmentBytes(assignment: ProjectAssignment): number {
  const { piSessionFile: _, ...payload } = assignment;
  return Buffer.byteLength(`${JSON.stringify(payload)}\n`, "utf8");
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
  const optional = [
    "piSessionFile",
    "resultBindings",
    "requiredEvidence",
    "currentEvidenceIds",
  ];
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
    (r.piSessionFile === undefined ||
      (typeof r.piSessionFile === "string" && r.piSessionFile.length > 0)) &&
    (r.resultBindings === undefined ||
      (Array.isArray(r.resultBindings) &&
        r.resultBindings.every(isResultBinding))) &&
    (r.requiredEvidence === undefined ||
      (Array.isArray(r.requiredEvidence) &&
        r.requiredEvidence.every(isRequiredEvidence) &&
        r.requiredEvidence.every(
          (evidence) =>
            "result" in evidence || evidence.sourceAssignmentId === r.id,
        ) &&
        new Set(r.requiredEvidence.map((evidence) => evidence.id)).size ===
          r.requiredEvidence.length)) &&
    (r.currentEvidenceIds === undefined ||
      (Array.isArray(r.currentEvidenceIds) &&
        new Set(r.currentEvidenceIds).size === r.currentEvidenceIds.length &&
        r.currentEvidenceIds.every(
          (id) =>
            typeof id === "string" &&
            (r.requiredEvidence as RequiredEvidence[] | undefined)?.some(
              (evidence) => evidence.id === id,
            ),
        )))
  );
}

export function writeProjectAssignment(
  runtime: SupervisionRuntime,
  assignment: ProjectAssignment,
): void {
  withProjectAssignmentLock(() =>
    writeProjectAssignmentUnlocked(runtime, assignment),
  );
}

function writeProjectAssignmentUnlocked(
  runtime: SupervisionRuntime,
  assignment: ProjectAssignment,
): void {
  assignment = upgradeProjectAssignmentEvidence(assignment);
  if (!validProjectAssignment(assignment))
    throw new Error("Invalid project assignment");
  const content = `${JSON.stringify(assignment)}\n`;
  if (
    projectAssignmentBytes(assignment) > PROJECT_ASSIGNMENT_MAX_BYTES ||
    Buffer.byteLength(content, "utf8") > PROJECT_ASSIGNMENT_FILE_MAX_BYTES
  )
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

function upgradeProjectAssignmentEvidence(
  assignment: ProjectAssignment,
): ProjectAssignment {
  if (!assignment.requiredEvidence?.length) return assignment;
  const requiredEvidence = assignment.requiredEvidence.map(
    upgradeAndVerifyRequiredEvidence,
  );
  if (
    requiredEvidence.every(
      (evidence, index) => evidence === assignment.requiredEvidence![index],
    )
  )
    return assignment;
  return {
    ...assignment,
    requiredEvidence,
  };
}

/** Persist legacy snapshot refs under the assignment authority lock before a resume advertises them. */
export function migrateProjectAssignmentEvidence(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
  expectedAssignmentId?: string,
): ProjectAssignment | undefined {
  return withProjectAssignmentLock(() => {
    const current = readProjectAssignment(runtime, repoKey, branch);
    if (
      !current ||
      (expectedAssignmentId && current.id !== expectedAssignmentId)
    )
      return undefined;
    const upgraded = upgradeProjectAssignmentEvidence(current);
    if (upgraded !== current) writeProjectAssignmentUnlocked(runtime, upgraded);
    return upgraded;
  });
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
  repoKey: string | undefined,
  branch?: string,
  pending = false,
): ProjectAssignment | undefined {
  let value: unknown;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error("invalid file");
    if (file.size > PROJECT_ASSIGNMENT_FILE_MAX_BYTES)
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
  try {
    for (const evidence of value.requiredEvidence ?? [])
      if (!("result" in evidence) && evidence.ref)
        verifySemanticEvidenceReservation(evidence.id, evidence.ref);
  } catch {
    throw projectAssignmentReadError(path, "invalid evidence identity");
  }
  if (projectAssignmentBytes(value) > PROJECT_ASSIGNMENT_MAX_BYTES)
    throw projectAssignmentReadError(path, "assignment payload is too large");
  if (
    (repoKey !== undefined && value.repoKey !== repoKey) ||
    basename(dirname(path)) !==
      createHash("sha256").update(value.repoKey).digest("hex") ||
    (branch !== undefined && value.branch !== branch) ||
    basename(path) !==
      `${createHash("sha256").update(value.branch).digest("hex")}${pending ? `.${value.id}` : ""}.json`
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
  withProjectAssignmentLock(() =>
    removeProjectAssignmentUnlocked(runtime, repoKey, branch),
  );
}

// Caller holds the exact branch lock; the global lock serializes authority writers.
export function retireProjectAssignment(
  runtime: SupervisionRuntime,
  expected: ProjectAssignment,
): boolean {
  return withProjectAssignmentLock(() => {
    for (const directory of [
      herdsmanDataRoot(),
      dirname(dirname(runtime.root)),
      dirname(runtime.root),
      runtime.root,
      runtime.assignments,
      dirname(
        projectAssignmentPath(runtime, expected.repoKey, expected.branch),
      ),
    ])
      assignmentDirectory(directory);
    const current = readProjectAssignment(
      runtime,
      expected.repoKey,
      expected.branch,
    );
    if (!current || current.id !== expected.id) return false;
    const source = projectAssignmentPath(
      runtime,
      current.repoKey,
      current.branch,
    );
    const destination = pendingRetirementPath(runtime, current);
    const root = join(runtime.root, "retirements");
    for (const directory of [root, dirname(destination)]) {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      assignmentDirectory(directory);
    }
    if (lstatSync(destination, { throwIfNoEntry: false }))
      throw new Error("Pending retirement already exists");
    renameSync(source, destination);
    // A sync failure is indeterminate durability: never restore authority or retry the move.
    fsyncDirectory(dirname(source));
    fsyncDirectory(dirname(destination));
    fsyncDirectory(root);
    fsyncDirectory(runtime.root);
    return true;
  });
}

function pendingRetirementPath(
  runtime: SupervisionRuntime,
  expected: ProjectAssignment,
): string {
  if (!validProjectAssignment(expected))
    throw new Error("Invalid project assignment");
  const active = projectAssignmentPath(
    runtime,
    expected.repoKey,
    expected.branch,
  );
  return join(
    runtime.root,
    "retirements",
    basename(dirname(active)),
    `${basename(active, ".json")}.${expected.id}.json`,
  );
}

export function listPendingRetirements(
  runtime: SupervisionRuntime,
  repoKey: string,
  options: {
    after?: string;
    recordLimit?: number;
    onReadError?: (error: Error) => void;
    onScanned?: (entry: string) => void;
  } = {},
): ProjectAssignment[] {
  const repository = basename(
    dirname(projectAssignmentPath(runtime, repoKey, "lookup")),
  );
  const root = join(runtime.root, "retirements");
  const directory = join(root, repository);
  let entries: string[];
  try {
    for (const parent of [
      herdsmanDataRoot(),
      dirname(dirname(runtime.root)),
      dirname(runtime.root),
      runtime.root,
      root,
      directory,
    ])
      assignmentDirectory(parent);
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  entries.sort();
  const start = options.after
    ? Math.max(
        0,
        entries.findIndex((entry) => entry > options.after!),
      )
    : 0;
  const ordered = [...entries.slice(start), ...entries.slice(0, start)];
  const records: ProjectAssignment[] = [];
  const recordLimit = Math.min(
    options.recordLimit ?? COORDINATION_INBOX_SCAN_LIMIT,
    COORDINATION_INBOX_SCAN_LIMIT,
  );
  for (const entry of ordered.slice(0, COORDINATION_INBOX_SCAN_LIMIT)) {
    options.onScanned?.(entry);
    const path = join(directory, entry);
    try {
      const record = readProjectAssignmentFile(path, repoKey, undefined, true);
      if (!record)
        throw projectAssignmentReadError(
          path,
          "file disappeared while listing",
        );
      records.push(record);
      if (records.length >= recordLimit) break;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!options.onReadError) throw failure;
      options.onReadError(failure);
    }
  }
  return records.sort(
    (a, b) => a.branch.localeCompare(b.branch) || a.id.localeCompare(b.id),
  );
}

export function removePendingRetirement(
  runtime: SupervisionRuntime,
  expected: ProjectAssignment,
): void {
  withProjectAssignmentLock(() => {
    const path = pendingRetirementPath(runtime, expected);
    const root = join(runtime.root, "retirements");
    for (const directory of [
      herdsmanDataRoot(),
      dirname(dirname(runtime.root)),
      dirname(runtime.root),
      runtime.root,
      root,
      dirname(path),
    ])
      assignmentDirectory(directory);
    const record = readProjectAssignmentFile(
      path,
      expected.repoKey,
      expected.branch,
      true,
    );
    if (!record) return;
    if (record.id !== expected.id)
      throw new Error("Pending retirement identity mismatch");
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  });
}

function removeProjectAssignmentUnlocked(
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

export type GlobalProjectAssignment = Readonly<{
  socketHash: string;
  assignment: ProjectAssignment;
}>;

function assignmentDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Invalid project assignment authority directory ${path}`);
}

function scanGlobalProjectAssignments(): Map<
  string,
  GlobalProjectAssignment[]
> {
  const dataRoot = herdsmanDataRoot();
  const runtimeRoot = join(dataRoot, "runtime");
  const root = join(runtimeRoot, "supervision-v2");
  let sockets: import("node:fs").Dirent[];
  try {
    // lstat every authority path component: checking supervision-v2 alone
    // would still follow a symlinked runtime directory.
    assignmentDirectory(dataRoot);
    assignmentDirectory(runtimeRoot);
    assignmentDirectory(root);
    sockets = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const bySession = new Map<string, GlobalProjectAssignment[]>();
  for (const socket of sockets) {
    if (isIncidentalMetadata(socket)) continue;
    if (!/^[a-f0-9]{64}$/.test(socket.name))
      throw new Error(
        `Unexpected project assignment socket entry ${socket.name}`,
      );
    if (!socket.isDirectory() || socket.isSymbolicLink())
      throw new Error(
        `Invalid project assignment socket directory ${socket.name}`,
      );
    const socketRoot = join(root, socket.name);
    assignmentDirectory(socketRoot);
    const assignmentsRoot = join(socketRoot, "assignments");
    let repositories: import("node:fs").Dirent[];
    try {
      assignmentDirectory(assignmentsRoot);
      repositories = readdirSync(assignmentsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    assignmentDirectory(assignmentsRoot);
    for (const repository of repositories) {
      if (isIncidentalMetadata(repository)) continue;
      if (!/^[a-f0-9]{64}$/.test(repository.name))
        throw new Error(
          `Unexpected project assignment repository entry ${repository.name}`,
        );
      if (!repository.isDirectory() || repository.isSymbolicLink())
        throw new Error(
          `Invalid project assignment repository directory ${repository.name}`,
        );
      const directory = join(assignmentsRoot, repository.name);
      assignmentDirectory(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (isIncidentalMetadata(entry)) continue;
        if (/^[a-f0-9]{64}\.messages$/.test(entry.name)) {
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error(`Invalid project message directory ${entry.name}`);
          continue;
        }
        if (/^[a-f0-9]{64}\.json\.lock$/.test(entry.name)) {
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error(`Invalid project assignment lock ${entry.name}`);
          continue;
        }
        // Atomic writer temporaries are not committed authority records.
        if (/^\..+\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
          if (!entry.isFile() || entry.isSymbolicLink())
            throw new Error(
              `Invalid project assignment publication temporary ${entry.name}`,
            );
          continue;
        }
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name))
          throw new Error(`Unexpected project assignment record ${entry.name}`);
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error(`Invalid project assignment record ${entry.name}`);
        const path = join(directory, entry.name);
        const assignment = readProjectAssignmentFile(
          path,
          undefined,
          undefined,
        );
        if (
          !assignment ||
          createHash("sha256").update(assignment.repoKey).digest("hex") !==
            repository.name
        )
          throw projectAssignmentReadError(
            path,
            "assignment repository hash mismatch",
          );
        const matches = bySession.get(assignment.id) ?? [];
        matches.push({ socketHash: socket.name, assignment });
        bySession.set(assignment.id, matches);
      }
    }
  }
  return bySession;
}

/** The full O(N) scan and caller's final synchronous action share the authority lock. */
// ponytail: global lock + full assignment scan. Add session-keyed indexing only if measured contention warrants it.
export function withProjectAssignmentAuthority<T>(
  operation: (assignments: Map<string, GlobalProjectAssignment[]>) => T,
): T {
  return withProjectAssignmentLock(() =>
    operation(scanGlobalProjectAssignments()),
  );
}

export function globalProjectAssignmentSnapshot(): Map<
  string,
  GlobalProjectAssignment[]
> {
  return withProjectAssignmentAuthority((snapshot) => snapshot);
}

export type ProjectMessage = Readonly<{
  version: 2;
  id: string;
  repoKey: string;
  branch: string;
  fromSessionId: string;
  text: string;
  kind?: "execution_failure";
  resultBindings?: ResultBinding[];
  createdAt: number;
}>;

export type ProjectMessageHeader = Omit<
  ProjectMessage,
  "text" | "resultBindings"
> & {
  text: string;
  resultBindings?: ResultBinding[];
  bodyRef?: OverflowBodyRef;
};
type StoredProjectMessage = ProjectMessageHeader;

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
        "kind",
        "createdAt",
        "resultBindings",
        "bodyRef",
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
    (r.bodyRef === undefined
      ? r.text.length > 0
      : r.text === "" &&
        r.resultBindings === undefined &&
        validOverflowBodyRef(r.bodyRef)) &&
    (r.kind === undefined || r.kind === "execution_failure") &&
    (r.resultBindings === undefined ||
      (Array.isArray(r.resultBindings) &&
        r.resultBindings.every(isResultBinding))) &&
    Number.isInteger(r.createdAt) &&
    (r.createdAt as number) >= 0
  );
}

export function projectMessageBytes(record: ProjectMessage): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
}

export function writeProjectMessage(
  record: ProjectMessage,
  runtime: SupervisionRuntime,
): void {
  if (!validProjectMessage(record) || (record as any).bodyRef !== undefined)
    throw new Error("Invalid project message");
  const path = join(
    projectMessageDirectory(runtime, record.repoKey, record.branch),
    `${record.id}.json`,
  );
  withChiefMessageLock(path, () =>
    writeProjectMessageUnlocked(record, runtime),
  );
}

function writeProjectMessageUnlocked(
  record: ProjectMessage,
  runtime: SupervisionRuntime,
): void {
  if (!validProjectMessage(record) || (record as any).bodyRef !== undefined)
    throw new Error("Invalid project message");
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
  let stored: StoredProjectMessage = record;
  if (projectMessageBytes(record) > COORDINATION_MESSAGE_MAX_BYTES) {
    const bodyRef = writeOverflowBody(`${path}.body`, {
      text: record.text,
      ...(record.resultBindings
        ? { resultBindings: record.resultBindings }
        : {}),
    });
    stored = { ...record, text: "", bodyRef };
    delete (stored as any).resultBindings;
    if (
      projectMessageBytes(stored as ProjectMessage) >
      COORDINATION_MESSAGE_MAX_BYTES
    )
      throw new Error("Project message routing metadata is too large");
  }
  const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(stored)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    let existing: ProjectMessage | undefined;
    try {
      existing = readProjectMessageFile(path);
    } catch (error) {
      if (
        (error as any).cause?.code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw new Error(`Unable to verify existing project message ${path}`, {
          cause: error,
        });
    }
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record))
        throw new Error(
          "Project message identity conflicts with durable payload",
        );
    } else {
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      fsyncDirectory(directory);
    }
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
    .flatMap((entry) => {
      let value: ProjectMessage;
      try {
        value = readProjectMessageFile(join(directory, entry));
      } catch (error) {
        // Pending records may be consumed after directory enumeration.
        if (
          error instanceof Error &&
          (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
        )
          return [];
        throw error;
      }
      if (value.repoKey !== repoKey || value.branch !== branch)
        throw new Error(`Project message identity does not match ${directory}`);
      return [value];
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Lists compact pending records without opening or validating overflow bodies. */
export function listProjectMessageHeaders(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
): ProjectMessageHeader[] {
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
    .flatMap((entry) => {
      try {
        const value = readStoredProjectMessageFile(join(directory, entry));
        if (value.repoKey !== repoKey || value.branch !== branch)
          throw new Error(
            `Project message identity does not match ${directory}`,
          );
        return [value];
      } catch (error) {
        if (
          error instanceof Error &&
          (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
        )
          return [];
        throw error;
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Resolves one previously listed project message after its delivery is authorized. */
export function readProjectMessage(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
  id: string,
): ProjectMessage {
  if (!UUID.test(id)) throw new Error("Invalid project message ID");
  const record = readProjectMessageFile(
    join(projectMessageDirectory(runtime, repoKey, branch), `${id}.json`),
  );
  if (record.repoKey !== repoKey || record.branch !== branch)
    throw new Error("Project message identity does not match its directory");
  return record;
}

export function removeProjectMessage(
  runtime: SupervisionRuntime,
  repoKey: string,
  branch: string,
  id: string,
): void {
  if (!UUID.test(id)) throw new Error("Invalid project message ID");
  const directory = projectMessageDirectory(runtime, repoKey, branch);
  try {
    if (!statSync(directory).isDirectory())
      throw new Error("Invalid project message directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const path = join(directory, `${id}.json`);
  withChiefMessageLock(path, () => removeProjectMessageUnlocked(directory, id));
}

function removeProjectMessageUnlocked(directory: string, id: string): void {
  try {
    unlinkSync(join(directory, `${id}.json`));
    fsyncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    unlinkSync(join(directory, `${id}.json.body`));
    fsyncDirectory(directory);
  } catch {}
}

function readProjectMessageFile(path: string): ProjectMessage {
  try {
    const stored = readStoredProjectMessageFile(path);
    if ((stored as StoredProjectMessage).bodyRef) {
      const compact = stored as StoredProjectMessage;
      const body = readOverflowBody(`${path}.body`, compact.bodyRef!);
      const value = { ...compact, ...body } as ProjectMessage;
      delete (value as any).bodyRef;
      if (!validProjectMessage(value)) throw new Error("invalid body");
      return value;
    }
    return stored as ProjectMessage;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to read project message ")
    )
      throw error;
    throw new Error(`Unable to read project message ${path}`, { cause: error });
  }
}

function readStoredProjectMessageFile(path: string): StoredProjectMessage {
  try {
    if (statSync(path).size > COORDINATION_MESSAGE_MAX_BYTES)
      throw new Error("large");
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !validProjectMessage(stored) ||
      basename(path) !== `${(stored as ProjectMessage).id}.json`
    )
      throw new Error("invalid");
    return stored as StoredProjectMessage;
  } catch (error) {
    throw new Error(`Unable to read project message ${path}`, { cause: error });
  }
}

export function removeProjectMessagesForAssignment(
  runtime: SupervisionRuntime,
  assignment: ProjectAssignment,
): void {
  for (const message of listProjectMessageHeaders(
    runtime,
    assignment.repoKey,
    assignment.branch,
  )) {
    if (message.fromSessionId === assignment.id)
      removeProjectMessage(
        runtime,
        assignment.repoKey,
        assignment.branch,
        message.id,
      );
  }
}

export function recoverStaleProjectMessages(
  runtime: SupervisionRuntime,
  repoKey: string,
): void {
  withProjectAssignmentLock(() => {
    const directory = dirname(
      projectAssignmentPath(runtime, repoKey, "lookup"),
    );
    let entries: string[];
    try {
      const dataRoot = herdsmanDataRoot();
      for (const path of [
        dataRoot,
        join(dataRoot, "runtime"),
        join(dataRoot, "runtime", "supervision-v2"),
        runtime.root,
        runtime.assignments,
        directory,
      ])
        assignmentDirectory(path);
      entries = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.filter((entry) =>
      /^[a-f0-9]{64}\.messages$/.test(entry),
    )) {
      const messages = join(directory, entry);
      assignmentDirectory(messages);
      for (const file of readdirSync(messages).filter(
        (file) => UUID.test(file.slice(0, -5)) && file.endsWith(".json"),
      )) {
        const path = join(messages, file);
        let message: ProjectMessageHeader;
        try {
          message = readStoredProjectMessageFile(path);
        } catch (error) {
          if (
            error instanceof Error &&
            (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
          )
            continue;
          throw error;
        }
        if (
          message.repoKey !== repoKey ||
          projectMessageDirectory(runtime, message.repoKey, message.branch) !==
            messages
        )
          throw new Error(`Project message identity does not match ${path}`);
        const current = readProjectAssignment(runtime, repoKey, message.branch);
        if (!current || current.id !== message.fromSessionId)
          removeProjectMessage(runtime, repoKey, message.branch, message.id);
      }
    }
  });
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

export async function leadSupervisorState(
  ctx: ExtensionContext,
  host: {
    workspaceId(): string | undefined;
    resolveEffectiveSupervisor(
      ctx: ExtensionContext,
      sessionId: string,
      workspaceId: string,
    ): Promise<
      | { kind: "assigned" }
      | { kind: "manager" }
      | { kind: "chief" }
      | { kind: "none" }
    >;
    currentManager(ctx: ExtensionContext): Promise<unknown | undefined>;
  },
): Promise<string> {
  try {
    const workspaceId = host.workspaceId();
    if (!workspaceId) throw new Error("Lead workspace is unavailable");
    const supervisor = await host.resolveEffectiveSupervisor(
      ctx,
      ctx.sessionManager.getSessionId(),
      workspaceId,
    );
    if (supervisor.kind === "assigned") {
      try {
        if (await host.currentManager(ctx))
          return `<supervisor_state>\nsupervisor: manager\navailability: available\nproject_messages: retained across Manager turnover\n</supervisor_state>`;
      } catch {
        return `<supervisor_state>\nsupervisor: manager\navailability: unknown\nproject_messages: retained for the Manager role\n</supervisor_state>`;
      }
      return `<supervisor_state>\nsupervisor: manager\navailability: unavailable\nproject_messages: retained for the Manager role\n</supervisor_state>`;
    }
    if (supervisor.kind === "manager")
      return `<supervisor_state>\nsupervisor: manager\navailability: available\n</supervisor_state>`;
    if (supervisor.kind === "chief")
      return `<supervisor_state>\nsupervisor: chief\navailability: available\n</supervisor_state>`;
    return `<supervisor_state>\nsupervisor: none\navailability: unavailable\nguidance: continue independently; do not use message_supervisor until a supervisor is available\n</supervisor_state>`;
  } catch {
    return `<supervisor_state>\nsupervisor: unverified\navailability: unknown\nguidance: continue independently; do not use message_supervisor until a supervisor is verified\n</supervisor_state>`;
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
  relationship?: "assigned" | "supervised";
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

export function staffToolName(
  action: "inspect" | "transcript" | "message",
): string {
  switch (action) {
    case "inspect":
      return "inspect_staff";
    case "transcript":
      return "read_staff_transcript";
    case "message":
      return "message_staff";
  }
}
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
export function projectTaskSummary(text: string): string | undefined {
  const task = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (!task) return undefined;

  const characters = Array.from(task);
  return characters.length <= 160
    ? task
    : `${characters.slice(0, 159).join("")}…`;
}
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
      if (
        exact.length === 1 &&
        (!workspaceId || exact[0]!.workspaceId !== workspaceId)
      ) {
        status = "conflict";
        issue = "assigned Lead is running outside its branch worktree";
      } else if (exact.length === 1) {
        status = "active";
        runtimeState = exact[0]!.runtimeState;
      } else {
        status = "paused";
      }
    }
    const task = projectTaskSummary(assignment.text);
    return {
      branch: assignment.branch,
      session: assignment.id,
      status,
      ...(runtimeState ? { runtimeState } : {}),
      ...(task ? { task } : {}),
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
  leadStateDirectory(runtime);
  const path = leadCoordinationStatePath(runtime, state.piSessionId);
  const content = JSON.stringify(state) + "\n";
  if (Buffer.byteLength(content, "utf8") > LEAD_STATE_MAX_BYTES)
    throw new Error("Lead coordination state is too large");
  return publishRecord(path, content);
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
      available_tools: r.availableActions.map(staffToolName),
      agents: r.agents,
    })),
  };
}
