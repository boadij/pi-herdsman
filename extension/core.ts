import { fail, OperationError } from "./errors.ts";
import { MAILBOX_PROTOCOL_LIMIT_BYTES } from "./mailbox.ts";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import type { RequiredEvidence, ResultBinding } from "./storage.ts";
import {
  persistRequiredEvidenceSnapshot,
  resolveResultRef,
} from "./storage.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function currentTurnIsSoleToolCall(
  ctx: ExtensionContext,
  name: string,
): boolean {
  const turn = (
    ctx.sessionManager.getBranch().at(-1) as { message?: any } | undefined
  )?.message;
  if (turn?.role !== "assistant" || !Array.isArray(turn.content)) return false;
  const calls = turn.content.filter((part: any) => part?.type === "toolCall");
  return calls.length === 1 && calls[0]?.name === name;
}

export const MANAGED_AGENT_BOOTSTRAP_EVENT =
  "pi-herdsman:managed-agent-bootstrap";

export const FILE_HANDOFF_GUIDANCE =
  "Pass user-supplied or already-available artifacts relevant to the " +
  "recipient's assignment, decisions, integration, validation, or onward " +
  "handoff through `files`, unless the recipient already inherits the same " +
  "evidence version as required evidence. Forward changed versions " +
  "explicitly. Do not assume the recipient " +
  "inherits the sender's conversation or arbitrary attachments. Preserve " +
  "exact supplied result refs when forwarding them and omit unrelated " +
  "evidence. `files` carries evidence, not runtime capability.";

export type TextFileSnapshot = {
  input: string;
  path: string;
  canonicalPath: string;
  text: string;
  bytes: number;
};

export interface SnapshotTextFilesOptions {
  maxBytes?: number;
  skipCanonicalPaths?: Iterable<string>;
}

type RegularFile = {
  input: string;
  path: string;
  canonicalPath: string;
  bytes: number;
  dev: number;
  ino: number;
  binding?: ResultBinding;
  retainedEvidence?: RetainedEvidenceFileInput;
};

export type RetainedEvidenceFileInput = Readonly<{
  kind: "retainedEvidence";
  ref: string;
  name: string;
  path: string;
  sha256: string;
}>;

export type MessageFileInput =
  string | ResultBinding | RetainedEvidenceFileInput;

function failUnknownResultRef(input: string, operation: string): never {
  fail(
    "invalid_request",
    `Unknown result ref: ${input}. Canonical result references are opaque; use only exact references already supplied as file evidence.`,
    operation,
  );
}

function resolveRegularFiles(
  inputs: readonly MessageFileInput[],
  cwd: string,
  operation: string,
  skipCanonicalPaths: Iterable<string> = [],
): RegularFile[] {
  const skipped = new Set(skipCanonicalPaths);
  const seen = new Map<string, RegularFile>();
  return inputs.flatMap((value) => {
    const retained = typeof value !== "string" && "kind" in value;
    const input = typeof value === "string" ? value : value.ref;
    const target =
      typeof value === "string"
        ? value
        : retained
          ? value.path
          : value.canonicalRef;
    let path: string;
    let resolvedResultPath: string | undefined;
    let canonicalPath: string;
    try {
      resolvedResultPath = resolveResultRef(target);
      path = resolvedResultPath ?? resolve(cwd, target);
      canonicalPath = realpathSync(path);
      if (skipped.has(canonicalPath)) return [];
      const existing = seen.get(canonicalPath);
      if (existing) {
        if (retained) {
          existing.input = value.ref;
          existing.retainedEvidence = value;
        }
        return [];
      }
      const beforeOpen = statSync(canonicalPath);
      if (!beforeOpen.isFile()) throw new Error("not a regular file");
      const fd = openSync(
        canonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile()) throw new Error("not a regular file");
        if (opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino)
          throw new Error("file changed during validation");
        const file: RegularFile = {
          input,
          path,
          canonicalPath,
          bytes: opened.size,
          dev: opened.dev,
          ino: opened.ino,
          ...(typeof value === "string"
            ? {}
            : retained
              ? { retainedEvidence: value }
              : { binding: value }),
        };
        seen.set(canonicalPath, file);
        return [file];
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (
        resolvedResultPath &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        failUnknownResultRef(input, operation);
      fail(
        "invalid_request",
        `Cannot read file ${input}: ${error instanceof Error ? error.message : String(error)}`,
        operation,
      );
    }
  });
}

export function validateMessageFiles(
  inputs: readonly MessageFileInput[],
  cwd: string,
  operation: string,
): void {
  resolveRegularFiles(inputs, cwd, operation);
}

export function snapshotTextFiles(
  inputs: readonly string[],
  cwd: string,
  operation: string,
  options: SnapshotTextFilesOptions = {},
): TextFileSnapshot[] {
  const maxBytes = options.maxBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES;
  const files = resolveRegularFiles(
    inputs,
    cwd,
    operation,
    options.skipCanonicalPaths,
  );
  const snapshots: TextFileSnapshot[] = [];
  let totalBytes = 0;
  for (const { input, path, canonicalPath, dev, ino } of files) {
    let fd: number | undefined;
    try {
      fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("not a regular file");
      if (stat.dev !== dev || stat.ino !== ino)
        throw new Error("file changed during validation");
      if (stat.size + totalBytes > maxBytes)
        fail(
          "invalid_request",
          "Request exceeds the mailbox size limit",
          operation,
        );
      const buffer = Buffer.allocUnsafe(maxBytes - totalBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = readSync(
          fd,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (count === 0) break;
        bytesRead += count;
      }
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.length + totalBytes > maxBytes)
        fail(
          "invalid_request",
          "Request exceeds the mailbox size limit",
          operation,
        );
      if (bytes.includes(0)) throw new Error("binary content");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      snapshots.push({
        input,
        path,
        canonicalPath,
        text,
        bytes: bytes.length,
      });
      totalBytes += bytes.length;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      fail(
        "invalid_request",
        `Cannot read text file ${input}: ${error instanceof Error ? error.message : String(error)}`,
        operation,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return snapshots;
}

/** Snapshot validated source files into immutable assignment-scoped storage. */
export function persistRequiredTextFiles(
  assignmentId: string,
  inputs: readonly string[],
  cwd: string,
  operation: string,
): RequiredEvidence[] {
  const snapshots: TextFileSnapshot[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const [snapshot] = snapshotTextFiles([input], cwd, operation, {
      maxBytes: 1024 * 1024,
      skipCanonicalPaths: seen,
    });
    if (snapshot) {
      snapshots.push(snapshot);
      seen.add(snapshot.canonicalPath);
    }
  }
  return snapshots.map((snapshot) =>
    persistRequiredEvidenceSnapshot(
      assignmentId,
      snapshot.input,
      snapshot.text,
    ),
  );
}

export type PreparedAttachment = {
  name: string;
  inline: boolean;
  ref?: string;
};

export type PreparedMessageInput = {
  text: string;
  canonicalPaths: string[];
  resultBindings: ResultBinding[];
  attachments: PreparedAttachment[];
};

export type MessagePreparationOptions = {
  fits?: (text: string, resultBindings: readonly ResultBinding[]) => boolean;
  inlineLimitBytes?: number;
  mailboxLimitBytes?: number;
  serializedBytes?: (
    text: string,
    resultBindings: readonly ResultBinding[],
  ) => number;
  verifiedEvidence?: readonly Pick<RequiredEvidence, "path" | "sha256">[];
  requireInline?: boolean;
  fileOrder?: "filesFirst" | "textFirst";
};

function escapeMessageFileName(path: string): string {
  return path.replace(/[&"<>\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === '"') return "&quot;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return `&#x${character.charCodeAt(0).toString(16)};`;
  });
}

function renderMessageFile(file: RegularFile, content?: string): string {
  const semantic =
    file.binding || file.retainedEvidence || file.input.startsWith("result:");
  const name = escapeMessageFileName(
    semantic ? file.input : file.canonicalPath,
  );
  const label = file.retainedEvidence
    ? ` label="${escapeMessageFileName(file.retainedEvidence.name)}"`
    : "";
  if (content === undefined)
    return `<file name="${name}"${label} bytes="${file.bytes}" />`;
  return `<file name="${name}"${label} bytes="${file.bytes}">\n${content}\n</file>`;
}

export function prepareMessageInput(
  text: string,
  files: readonly MessageFileInput[],
  cwd: string,
  operation: string,
  heading: "Task" | "Steer" | "Reply" | "Question" | "Message",
  options: MessagePreparationOptions = {},
): PreparedMessageInput {
  if (!text.trim())
    fail("invalid_request", "Message must not be empty", operation);
  if (!files.length) {
    const fits =
      options.fits ??
      ((value: string, bindings: readonly ResultBinding[]) =>
        (options.serializedBytes
          ? options.serializedBytes(value, bindings)
          : Buffer.byteLength(value, "utf8")) <=
        (options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES));
    if (!fits(text, []))
      fail(
        "invalid_request",
        options.serializedBytes
          ? `Mailbox payload is ${options.serializedBytes(text, [])} bytes; configured limit is ${options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES} bytes`
          : "Request exceeds the mailbox size limit",
        operation,
        { details: { capacity: true } },
      );
    return { text, canonicalPaths: [], resultBindings: [], attachments: [] };
  }
  const regular = resolveRegularFiles(files, cwd, operation);
  const resultBindings = regular.flatMap((file) =>
    file.binding ? [file.binding] : [],
  );
  const sections = regular.map((file) => renderMessageFile(file));
  const rendered = () =>
    (options.fileOrder === "textFirst"
      ? [`${heading}:\n${text}`, ...sections]
      : [...sections, `${heading}:\n${text}`]
    ).join("\n\n");
  const fits =
    options.fits ??
    ((value: string, bindings: readonly ResultBinding[]) =>
      (options.serializedBytes
        ? options.serializedBytes(value, bindings)
        : Buffer.byteLength(value, "utf8")) <=
      (options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES));
  if (!fits(rendered(), resultBindings))
    fail(
      "invalid_request",
      options.serializedBytes
        ? `Mailbox payload is ${options.serializedBytes(rendered(), resultBindings)} bytes; configured limit is ${options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES} bytes`
        : "Request exceeds the mailbox size limit",
      operation,
      { details: { capacity: true } },
    );
  for (const file of regular) {
    const index = regular.indexOf(file);
    const prior = sections[index];
    // Probe with the minimum possible content representation. Every accepted
    // byte must occupy at least one UTF-8 byte, so this lower-bound probe can
    // skip only candidates that cannot fit; the exact decoded content decides
    // whether a candidate is actually embedded.
    let fd: number | undefined;
    let resolvedResultPath: string | undefined;
    let bytes: Buffer;
    try {
      resolvedResultPath = resolveResultRef(
        file.retainedEvidence?.path ?? file.binding?.canonicalRef ?? file.input,
      );
      // O_NONBLOCK prevents a path replaced by a FIFO from blocking this
      // preparation step. The descriptor is also the one that gets read.
      fd = openSync(
        file.canonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const current = fstatSync(fd);
      const readVersion = fstatSync(fd, { bigint: true });
      if (!current.isFile()) throw new Error("not a regular file");
      const verified = file.retainedEvidence
        ? {
            path: file.retainedEvidence.path,
            sha256: file.retainedEvidence.sha256,
          }
        : options.verifiedEvidence?.find(
            (entry) => realpathSync(entry.path) === file.canonicalPath,
          );
      if (
        current.dev !== file.dev ||
        current.ino !== file.ino ||
        current.size !== file.bytes
      ) {
        if (verified)
          fail(
            "invalid_request",
            `Required evidence identity check failed: ${file.input}`,
            operation,
          );
        if (options.requireInline)
          fail(
            "invalid_request",
            `Attachment could not be fully embedded within the configured limits: ${file.input}`,
            operation,
          );
        continue;
      }
      const cannotInline =
        current.size >
          (options.inlineLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES) ||
        ((options.fits !== undefined ||
          options.serializedBytes === undefined) &&
          !fits(
            (options.fileOrder === "textFirst"
              ? [
                  `${heading}:\n${text}`,
                  ...sections.map((section, i) =>
                    i === index
                      ? renderMessageFile(file, "x".repeat(current.size))
                      : section,
                  ),
                ]
              : [
                  ...sections.map((section, i) =>
                    i === index
                      ? renderMessageFile(file, "x".repeat(current.size))
                      : section,
                  ),
                  `${heading}:\n${text}`,
                ]
            ).join("\n\n"),
            resultBindings,
          ));
      if (cannotInline && !verified) {
        if (options.requireInline)
          fail(
            "invalid_request",
            `Attachment could not be fully embedded within the configured limits: ${file.input}`,
            operation,
            { details: { capacity: true } },
          );
        continue;
      }
      bytes = Buffer.allocUnsafe(current.size);
      let offset = 0;
      while (offset < current.size) {
        const count = readSync(
          fd,
          bytes,
          offset,
          current.size - offset,
          offset,
        );
        if (!count) break;
        offset += count;
      }
      const afterRead = fstatSync(fd, { bigint: true });
      if (
        offset !== current.size ||
        afterRead.size !== readVersion.size ||
        afterRead.dev !== readVersion.dev ||
        afterRead.ino !== readVersion.ino ||
        afterRead.mtimeNs !== readVersion.mtimeNs ||
        afterRead.ctimeNs !== readVersion.ctimeNs
      ) {
        if (options.requireInline)
          fail(
            "invalid_request",
            `Attachment changed while being read: ${file.input}`,
            operation,
          );
        continue;
      }
      bytes = bytes.subarray(0, offset);
      if (
        verified &&
        createHash("sha256").update(bytes).digest("hex") !== verified.sha256
      )
        fail(
          "invalid_request",
          `Required evidence integrity check failed: ${file.input}`,
          operation,
        );
      if (cannotInline) {
        if (options.requireInline)
          fail(
            "invalid_request",
            `Attachment could not be fully embedded within the configured limits: ${file.input}`,
            operation,
            { details: { capacity: true } },
          );
        continue;
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (
        resolvedResultPath &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        failUnknownResultRef(file.input, operation);
      if (options.requireInline)
        fail(
          "invalid_request",
          `Attachment could not be fully embedded: ${file.input}`,
          operation,
        );
      fail(
        "invalid_request",
        `Cannot read file ${file.input}: ${error instanceof Error ? error.message : String(error)}`,
        operation,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (bytes.includes(0)) {
      if (options.requireInline)
        fail(
          "invalid_request",
          `Attachment is not supported UTF-8 text: ${file.input}`,
          operation,
        );
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      if (options.requireInline)
        fail(
          "invalid_request",
          `Attachment is not supported UTF-8 text: ${file.input}`,
          operation,
        );
      continue;
    }
    sections[index] = renderMessageFile(file, content);
    if (!fits(rendered(), resultBindings)) {
      sections[index] = prior;
      if (options.requireInline)
        fail(
          "invalid_request",
          `Attachment could not be fully embedded within the configured limits: ${file.input}`,
          operation,
          { details: { capacity: true } },
        );
    }
  }
  return {
    text: rendered(),
    canonicalPaths: regular.map((file) => file.canonicalPath),
    resultBindings,
    attachments: regular.map((file, index) => ({
      name:
        file.retainedEvidence || file.binding
          ? file.input
          : escapeMessageFileName(basename(file.canonicalPath)),
      inline: sections[index] !== renderMessageFile(file),
      ...(file.retainedEvidence || file.binding ? { ref: file.input } : {}),
    })),
  };
}
export function displayIdentity(
  agentDefinition: string,
  label: string,
): string {
  return `${agentDefinition}:${label}`;
}
export type SpawnPlacement = "tab" | "subtree" | "split";
export type LeadExecutionMode = "flexible" | "orchestrate";
export function hasTaskText(task: string | undefined): boolean {
  return task !== undefined && !!task.trim();
}
export function isSpawnPlacement(value: unknown): value is SpawnPlacement {
  return value === "tab" || value === "subtree" || value === "split";
}
export function isLeadExecutionMode(
  value: unknown,
): value is LeadExecutionMode {
  return value === "flexible" || value === "orchestrate";
}
export function spawnPlacementMenuOptions(
  current: SpawnPlacement,
): Array<{ label: string; value: SpawnPlacement }> {
  const options: Array<{ label: string; value: SpawnPlacement }> = [
    { label: "Lead agents tab", value: "tab" },
    { label: "Subtree tabs", value: "subtree" },
    { label: "Split from caller", value: "split" },
  ];
  return options.map((x) => ({
    ...x,
    label: x.value === current ? `${x.label} (current)` : x.label,
  }));
}
export function spawnPlacementFromMenuSelection(
  value: unknown,
): SpawnPlacement | undefined {
  return isSpawnPlacement(value) ? value : undefined;
}
export function chooseLabel(base: string, labels: Set<string>): string {
  if (!labels.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!labels.has(candidate)) return candidate;
  }
  throw new Error("Unable to choose agent label");
}
export type ManagedAgentControlState =
  "working" | "blocked" | "settling" | "unknown";
export function agentControlState(
  lifecycle: "idle" | "working" | "blocked" | "done" | "unknown",
  activeRequestId: string | undefined,
  completionPending: boolean,
  handoffPending = false,
  waitingForOwner = false,
  recoveryPending = false,
): ManagedAgentControlState {
  if (completionPending || handoffPending || recoveryPending) return "settling";
  if (activeRequestId) {
    if (lifecycle === "working") return "working";
    if (waitingForOwner) {
      if (lifecycle === "unknown") return "unknown";
      return "blocked";
    }
    if (lifecycle === "blocked") return "blocked";
    if (lifecycle === "idle" || lifecycle === "done") return "settling";
    return "unknown";
  }
  if (lifecycle === "idle" || lifecycle === "done") return "settling";
  return "unknown";
}
export function taskAcceptanceAllowed(
  isIdle: boolean,
  activeRequestId: string | undefined,
  completionPending: boolean,
): boolean {
  return isIdle && !activeRequestId && !completionPending;
}
export function steerAcceptanceAllowed(
  isIdle: boolean,
  activeRequestId: string | undefined,
  completionPending: boolean,
  idleContinuationAllowed = false,
): boolean {
  return (
    !!activeRequestId &&
    !completionPending &&
    (!isIdle || idleContinuationAllowed)
  );
}
export function resultStillPending(
  activeRequestId: string | undefined,
  completedRequestId: string | undefined,
  resultExists: boolean,
): boolean {
  return !!activeRequestId || (!!completedRequestId && resultExists);
}
