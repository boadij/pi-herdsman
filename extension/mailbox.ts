import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { claimProcessLock, ProcessLockOccupiedError } from "./lock.ts";

export interface ManagedAgentState {
  version: 4;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  piSessionId: string;
  piSessionFile?: string;
  cwd: string;
  activeRequestId?: string;
  pendingAskId?: string;
  lastActivityAt?: number;
  completedRequestId?: string;
  resultError?: ResultPersistenceError;
  lastAck?: {
    requestId: string;
    accepted: boolean;
    code?: "busy" | "idle" | "invalid" | "identity" | "delivery";
    message?: string;
    acknowledgedAt: number;
  };
  updatedAt: number;
}
export interface ResultPersistenceError {
  code: "write_failure";
  message: string;
  requestId: string;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  originalStatus: "completed" | "failed";
  attempts: number;
  failedAt: number;
  retrySafe: false;
  cleanupSafe: true;
  nextAction: string;
}
export interface RequestRecord {
  version: 4;
  runId: string;
  requestId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  kind: "task" | "steer" | "reply";
  askId?: string;
  text: string;
  createdAt: number;
}
export interface AskRecord {
  version: 4;
  askId: string;
  requestId: string;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  piSessionId: string;
  question: string;
  createdAt: number;
}
export interface ResultRecord {
  version: 4;
  runId: string;
  requestId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  status: "completed" | "failed";
  text?: string;
  error?: {
    code: "empty_result" | "result_too_large" | "write_failure";
    message: string;
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  completedAt: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = "__PI_HERDSMAN_AGENT_V4__:";
/** Fixed protocol safety ceiling; configuration only limits new submissions. */
export const MAILBOX_PROTOCOL_LIMIT_BYTES = 1024 * 1024;
export function mailboxRecordBytes(record: RequestRecord | AskRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}
export class MailboxClaimOccupiedError extends Error {
  readonly code = "MAILBOX_CLAIM_OCCUPIED";
}
const LIMITS = {
  state: 64 * 1024,
  request: MAILBOX_PROTOCOL_LIMIT_BYTES,
  ask: MAILBOX_PROTOCOL_LIMIT_BYTES,
  result: 4 * 1024 * 1024,
};
const root = join(
  tmpdir(),
  "pi-herdsman",
  typeof process.getuid === "function" ? String(process.getuid()) : "user",
  "mailboxes-v4",
);

export function agentMailboxPath(
  workspaceId: string,
  agentLabel: string,
): string {
  return join(
    root,
    createHash("sha256")
      .update(`${workspaceId}\0${agentLabel}`)
      .digest("hex")
      .slice(0, 32),
  );
}
export type ManagedAgentStateIssue = {
  path: string;
  diagnostic: string;
};

const MAILBOX_DIRECTORY = /^[0-9a-f]{32}$/;
const DIAGNOSTIC_LIMIT = 256;
const ISSUE_LIMIT = 64;

function boundedDiagnostic(error: unknown): string {
  const text = String(error).replace(/\s+/g, " ").trim();
  return text.length > DIAGNOSTIC_LIMIT
    ? `${text.slice(0, DIAGNOSTIC_LIMIT - 1)}…`
    : text;
}

function scanAgentStates(): {
  states: Array<{ path: string; state: ManagedAgentState }>;
  issues: ManagedAgentStateIssue[];
} {
  if (!existsSync(root)) return { states: [], issues: [] };
  const states: Array<{ path: string; state: ManagedAgentState }> = [];
  const issues: ManagedAgentStateIssue[] = [];
  const entries: Array<{
    name: string;
    path: string;
    directory: boolean;
    mtimeMs: number;
    statError?: unknown;
  }> = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    try {
      const info = statSync(path);
      entries.push({
        name,
        path,
        directory: info.isDirectory(),
        mtimeMs: info.mtimeMs,
      });
    } catch (error) {
      entries.push({
        name,
        path,
        directory: false,
        mtimeMs: Number.NEGATIVE_INFINITY,
        statError: error,
      });
    }
  }
  // Prefer recently touched mailboxes so the bounded issue list reports
  // current failures instead of hiding them behind stale diagnostics.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { name, path, directory, statError } of entries) {
    try {
      if (statError !== undefined) throw statError;
      if (!directory) continue;
      const state = readAgentState(path);
      if (state) states.push({ path, state });
    } catch (error) {
      // Only hash-named directories can be current mailbox paths. Other
      // disposable directories are omitted without projecting an identity.
      if (MAILBOX_DIRECTORY.test(name) && issues.length < ISSUE_LIMIT)
        issues.push({
          path,
          diagnostic: `Mailbox state unavailable: ${boundedDiagnostic(error)}`,
        });
    }
  }
  return { states, issues };
}

export function listAgentStates(): Array<{
  path: string;
  state: ManagedAgentState;
}> {
  return scanAgentStates().states;
}

export function listAgentStateIssues(): ManagedAgentStateIssue[] {
  return scanAgentStates().issues;
}
function ensure(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function validate(
  value: unknown,
  kind: keyof typeof LIMITS,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 4
  )
    throw new Error("Invalid mailbox protocol version or record");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > LIMITS[kind])
    throw new Error("Mailbox record is too large");
  const v = value as Record<string, any>;
  const allowed =
    kind === "state"
      ? [
          "version",
          "runId",
          "ownerSessionId",
          "workspaceId",
          "agentLabel",
          "paneId",
          "piSessionId",
          "piSessionFile",
          "cwd",
          "activeRequestId",
          "pendingAskId",
          "lastActivityAt",
          "completedRequestId",
          "resultError",
          "lastAck",
          "updatedAt",
        ]
      : kind === "request"
        ? [
            "version",
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
            "kind",
            "askId",
            "text",
            "createdAt",
          ]
        : kind === "ask"
          ? [
              "version",
              "askId",
              "requestId",
              "runId",
              "ownerSessionId",
              "workspaceId",
              "agentLabel",
              "paneId",
              "piSessionId",
              "question",
              "createdAt",
            ]
          : [
              "version",
              "runId",
              "requestId",
              "ownerSessionId",
              "workspaceId",
              "agentLabel",
              "paneId",
              "status",
              "text",
              "error",
              "contextUsage",
              "completedAt",
            ];
  if (Object.keys(v).some((key) => !allowed.includes(key)))
    throw new Error("Unknown mailbox field");
  const required =
    kind === "state"
      ? [
          "runId",
          "ownerSessionId",
          "workspaceId",
          "agentLabel",
          "paneId",
          "piSessionId",
          "cwd",
        ]
      : kind === "ask"
        ? [
            "askId",
            "requestId",
            "runId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
            "piSessionId",
          ]
        : [
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
          ];
  for (const field of required)
    if (typeof v[field] !== "string" || !(v[field] as string).trim())
      throw new Error(`Invalid mailbox field: ${field}`);
  if (
    !UUID.test(v.runId) ||
    (kind !== "state" && !UUID.test(v.requestId)) ||
    (kind === "ask" && !UUID.test(v.askId))
  )
    throw new Error("Invalid mailbox UUID");
  const finite = (field: string) => {
    if (
      typeof v[field] !== "number" ||
      !Number.isFinite(v[field]) ||
      v[field] < 0
    )
      throw new Error(`Invalid mailbox timestamp: ${field}`);
  };
  if (kind === "state") {
    finite("updatedAt");
    if (
      v.lastActivityAt !== undefined &&
      (typeof v.lastActivityAt !== "number" ||
        !Number.isInteger(v.lastActivityAt) ||
        !Number.isFinite(v.lastActivityAt) ||
        v.lastActivityAt < 0)
    )
      throw new Error("Invalid mailbox timestamp: lastActivityAt");
    for (const field of ["activeRequestId", "completedRequestId"])
      if (
        v[field] !== undefined &&
        (!UUID.test(v[field]) || typeof v[field] !== "string")
      )
        throw new Error(`Invalid ${field}`);
    if (v.pendingAskId !== undefined && !UUID.test(v.pendingAskId as string))
      throw new Error("Invalid pendingAskId");
    if (v.pendingAskId !== undefined && !v.activeRequestId)
      throw new Error("pendingAskId requires activeRequestId");
    if (v.pendingAskId !== undefined && v.completedRequestId !== undefined)
      throw new Error("pendingAskId cannot coexist with completedRequestId");
    if (
      v.activeRequestId &&
      v.completedRequestId &&
      v.activeRequestId === v.completedRequestId
    )
      throw new Error("Active and completed request IDs must differ");
    if (v.resultError !== undefined) {
      if (v.activeRequestId !== undefined || v.completedRequestId !== undefined)
        throw new Error(
          "Result persistence error cannot coexist with an assignment",
        );
      const error = v.resultError as Record<string, unknown>;
      const errorKeys = [
        "code",
        "message",
        "requestId",
        "runId",
        "ownerSessionId",
        "workspaceId",
        "agentLabel",
        "paneId",
        "originalStatus",
        "attempts",
        "failedAt",
        "retrySafe",
        "cleanupSafe",
        "nextAction",
      ];
      if (
        Object.keys(error).some((key) => !errorKeys.includes(key)) ||
        error.code !== "write_failure" ||
        typeof error.message !== "string" ||
        !error.message.trim() ||
        !UUID.test(error.requestId as string) ||
        error.runId !== v.runId ||
        error.ownerSessionId !== v.ownerSessionId ||
        error.workspaceId !== v.workspaceId ||
        error.agentLabel !== v.agentLabel ||
        error.paneId !== v.paneId ||
        (error.originalStatus !== "completed" &&
          error.originalStatus !== "failed") ||
        typeof error.attempts !== "number" ||
        !Number.isInteger(error.attempts) ||
        error.attempts < 1 ||
        error.retrySafe !== false ||
        error.cleanupSafe !== true ||
        typeof error.nextAction !== "string" ||
        !error.nextAction.trim()
      )
        throw new Error("Invalid result persistence error");
      if (
        typeof error.failedAt !== "number" ||
        !Number.isFinite(error.failedAt) ||
        error.failedAt < 0
      )
        throw new Error("Invalid result persistence error timestamp");
    }
    if (
      v.piSessionFile !== undefined &&
      (typeof v.piSessionFile !== "string" || !v.piSessionFile.trim())
    )
      throw new Error("Invalid piSessionFile");
    if (v.lastAck !== undefined) {
      const ack = v.lastAck as Record<string, unknown>;
      const ackKeys = [
        "requestId",
        "accepted",
        "code",
        "message",
        "acknowledgedAt",
      ];
      if (
        Object.keys(ack).some((key) => !ackKeys.includes(key)) ||
        !UUID.test(ack.requestId as string) ||
        typeof ack.accepted !== "boolean" ||
        typeof ack.acknowledgedAt !== "number" ||
        !Number.isFinite(ack.acknowledgedAt) ||
        ack.acknowledgedAt < 0
      )
        throw new Error("Invalid acknowledgement");
      const codes = ["busy", "idle", "invalid", "identity", "delivery"];
      if (ack.accepted && ack.code !== undefined)
        throw new Error("Accepted acknowledgement cannot have an error code");
      if (!ack.accepted && !codes.includes(ack.code as string))
        throw new Error("Rejected acknowledgement requires an error code");
      if (
        ack.message !== undefined &&
        (typeof ack.message !== "string" || !ack.message.trim())
      )
        throw new Error("Invalid acknowledgement message");
    }
  } else if (kind === "request") {
    if (v.kind !== "task" && v.kind !== "steer" && v.kind !== "reply")
      throw new Error("Invalid request kind");
    if (
      (v.kind === "reply" &&
        (typeof v.askId !== "string" || !UUID.test(v.askId))) ||
      (v.kind !== "reply" && v.askId !== undefined)
    )
      throw new Error("Invalid reply ask ID");
    if (typeof v.text !== "string" || !v.text.trim())
      throw new Error("Invalid request text");
    finite("createdAt");
  } else if (kind === "ask") {
    if (typeof v.question !== "string" || !v.question.trim())
      throw new Error("Invalid ask question");
    finite("createdAt");
  } else {
    if (v.status !== "completed" && v.status !== "failed")
      throw new Error("Invalid result status");
    finite("completedAt");
    if (
      v.status === "completed" &&
      (typeof v.text !== "string" || !v.text.trim() || v.error !== undefined)
    )
      throw new Error("Invalid completed result");
    if (v.status === "failed") {
      const error = v.error as Record<string, unknown> | undefined;
      const codes = ["empty_result", "result_too_large", "write_failure"];
      if (
        !error ||
        Object.keys(error).some((key) => !["code", "message"].includes(key)) ||
        !codes.includes(error.code as string) ||
        typeof error.message !== "string" ||
        !error.message.trim()
      )
        throw new Error("Invalid failed result");
      if (v.text !== undefined)
        throw new Error("Failed result cannot contain text");
    }
    if (v.contextUsage !== undefined) {
      const usage = v.contextUsage as Record<string, unknown>;
      if (
        Object.keys(usage).length !== 3 ||
        Object.keys(usage).some(
          (key) => !["tokens", "contextWindow", "percent"].includes(key),
        ) ||
        (usage.tokens !== null &&
          (typeof usage.tokens !== "number" ||
            !Number.isFinite(usage.tokens) ||
            usage.tokens < 0)) ||
        typeof usage.contextWindow !== "number" ||
        !Number.isFinite(usage.contextWindow) ||
        usage.contextWindow <= 0 ||
        (usage.percent !== null &&
          (typeof usage.percent !== "number" ||
            !Number.isFinite(usage.percent) ||
            usage.percent < 0 ||
            usage.percent > 100))
      )
        throw new Error("Invalid context usage");
    }
  }
}
function atomic(path: string, value: unknown, kind: keyof typeof LIMITS): void {
  validate(value, kind);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function read<T>(path: string, kind: keyof typeof LIMITS): T | undefined {
  try {
    if (statSync(path).size > LIMITS[kind])
      throw new Error("Mailbox record is too large");
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function file(path: string, name: string): string {
  return join(path, name);
}
function assertFileId(requestId: string): void {
  if (!UUID.test(requestId) || requestId.length !== 36)
    throw new Error("Invalid request ID");
}
export function claimAgentMailbox(
  path: string,
  hooks: { afterStaleOwnerRemoved?: () => void } = {},
): () => void {
  ensure(root);
  ensure(path);
  try {
    return claimProcessLock(file(path, ".starting"), {
      name: "mailbox startup claim",
      occupiedMessage: "Mailbox startup is in progress",
      afterStaleOwnerRemoved: hooks.afterStaleOwnerRemoved,
    });
  } catch (error) {
    if (error instanceof ProcessLockOccupiedError)
      throw new MailboxClaimOccupiedError(error.message);
    throw error;
  }
}
export function resetAgentMailbox(path: string): void {
  ensure(root);
  ensure(path);
  for (const name of [
    "state.json",
    "ask.json",
    ...readdirSync(path).filter((x: string) =>
      /^(request|result)-.*\.json$/.test(x),
    ),
  ]) {
    try {
      unlinkSync(file(path, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export function removeAgentMailbox(path: string): void {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (name === ".starting") continue;
    try {
      unlinkSync(file(path, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    rmdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
      throw error;
  }
}
export function writeAgentState(path: string, state: ManagedAgentState): void {
  atomic(file(path, "state.json"), state, "state");
}
export function agentStatePath(path: string): string {
  return file(path, "state.json");
}
export function readAgentState(path: string): ManagedAgentState | undefined {
  const v = read<ManagedAgentState>(file(path, "state.json"), "state");
  if (v) validate(v, "state");
  return v;
}
export function writeRequest(path: string, request: RequestRecord): void {
  assertFileId(request.requestId);
  atomic(file(path, `request-${request.requestId}.json`), request, "request");
}
export function readRequest(
  path: string,
  requestId: string,
): RequestRecord | undefined {
  assertFileId(requestId);
  const v = read<RequestRecord>(
    file(path, `request-${requestId}.json`),
    "request",
  );
  if (v) validate(v, "request");
  if (v && v.requestId !== requestId)
    throw new Error("Request filename identity mismatch");
  return v;
}
export function unacknowledgedRequestExists(
  path: string,
  state?: Pick<
    ManagedAgentState,
    | "runId"
    | "ownerSessionId"
    | "workspaceId"
    | "agentLabel"
    | "paneId"
    | "lastAck"
  >,
): boolean {
  // This is mailbox-owned durable settlement truth; it does not change the mailbox schema or protocol.
  let names: string[];
  try {
    names = readdirSync(path).filter((name) => /^request-.+\.json$/.test(name));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : true;
  }
  for (const name of names) {
    const requestId = name.slice("request-".length, -".json".length);
    try {
      const request = readRequest(path, requestId);
      if (!request) continue;
      if (
        state &&
        (request.runId !== state.runId ||
          request.ownerSessionId !== state.ownerSessionId ||
          request.workspaceId !== state.workspaceId ||
          request.agentLabel !== state.agentLabel ||
          request.paneId !== state.paneId)
      )
        return true;
      if (state?.lastAck?.requestId === request.requestId) continue;
      return true;
    } catch {
      return true;
    }
  }
  return false;
}
export function removeRequest(path: string, requestId: string): void {
  assertFileId(requestId);
  try {
    unlinkSync(file(path, `request-${requestId}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function writeAsk(path: string, ask: AskRecord): void {
  assertFileId(ask.askId);
  atomic(file(path, "ask.json"), ask, "ask");
}
export function readAsk(path: string): AskRecord | undefined {
  const v = read<AskRecord>(file(path, "ask.json"), "ask");
  if (v) validate(v, "ask");
  return v;
}
export function readPendingAsk(
  path: string,
  state: ManagedAgentState,
): AskRecord | undefined {
  if (!state.pendingAskId) return undefined;
  const ask = readAsk(path);
  if (!ask) throw new Error("Pending owner ask artifact is missing");
  if (
    ask.askId !== state.pendingAskId ||
    !state.activeRequestId ||
    ask.requestId !== state.activeRequestId ||
    ask.runId !== state.runId ||
    ask.ownerSessionId !== state.ownerSessionId ||
    ask.workspaceId !== state.workspaceId ||
    ask.agentLabel !== state.agentLabel ||
    ask.paneId !== state.paneId ||
    ask.piSessionId !== state.piSessionId
  )
    throw new Error("Pending owner ask identity did not match agent state");
  return ask;
}
export function removeAsk(path: string): void {
  try {
    unlinkSync(file(path, "ask.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function writeResult(path: string, result: ResultRecord): void {
  assertFileId(result.requestId);
  atomic(file(path, `result-${result.requestId}.json`), result, "result");
}
export function readResult(
  path: string,
  requestId: string,
): ResultRecord | undefined {
  assertFileId(requestId);
  const v = read<ResultRecord>(
    file(path, `result-${requestId}.json`),
    "result",
  );
  if (v) validate(v, "result");
  if (v && v.requestId !== requestId)
    throw new Error("Result filename identity mismatch");
  return v;
}
export function removeResult(path: string, requestId: string): void {
  assertFileId(requestId);
  try {
    unlinkSync(file(path, `result-${requestId}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function controlMarker(requestId: string): string {
  if (!UUID.test(requestId)) throw new Error("Invalid request ID");
  return `${PREFIX}${requestId}`;
}
export function parseControlMarker(text: string): string | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  const id = text.slice(PREFIX.length);
  return UUID.test(id) && id.length === 36 ? id : undefined;
}
export function waitForState(
  path: string,
  predicate: (state: ManagedAgentState) => boolean,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ManagedAgentState> {
  return new Promise((resolve, reject) => {
    let done = false;
    let abortListener: (() => void) | undefined;
    const finish = (error?: Error, state?: ManagedAgentState) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(interval);
      if (abortListener && options.signal)
        options.signal.removeEventListener("abort", abortListener);
      error ? reject(error) : resolve(state!);
    };
    const check = () => {
      try {
        const state = readAgentState(path);
        if (state && predicate(state)) finish(undefined, state);
      } catch (e) {
        finish(e as Error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for agent state")),
      options.timeoutMs,
    );
    const interval = setInterval(check, 250);
    if (options.signal?.aborted) {
      finish(new Error("Aborted"));
      return;
    }
    abortListener = () => finish(new Error("Aborted"));
    options.signal?.addEventListener("abort", abortListener, { once: true });
    check();
  });
}
