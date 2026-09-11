import { fail, OperationError } from "./errors.ts";
import { MAILBOX_PROTOCOL_LIMIT_BYTES } from "./mailbox.ts";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { resolveResultRef } from "./storage.ts";

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
};

function failUnknownResultRef(input: string, operation: string): never {
  fail(
    "invalid_request",
    `Unknown result ref: ${input}. Result refs are opaque identifiers; copy the exact Result ref returned by the agent completion.`,
    operation,
  );
}

function resolveRegularFiles(
  inputs: readonly string[],
  cwd: string,
  operation: string,
  skipCanonicalPaths: Iterable<string> = [],
): RegularFile[] {
  const skipped = new Set(skipCanonicalPaths);
  const seen = new Set<string>();
  return inputs.flatMap((input) => {
    let path: string;
    let resolvedResultPath: string | undefined;
    let canonicalPath: string;
    try {
      resolvedResultPath = resolveResultRef(input);
      path = resolvedResultPath ?? resolve(cwd, input);
      canonicalPath = realpathSync(path);
      if (skipped.has(canonicalPath) || seen.has(canonicalPath)) return [];
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
        seen.add(canonicalPath);
        return [
          {
            input,
            path,
            canonicalPath,
            bytes: opened.size,
            dev: opened.dev,
            ino: opened.ino,
          },
        ];
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
  for (const { input, path, canonicalPath } of files) {
    let fd: number | undefined;
    try {
      fd = openSync(canonicalPath, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("not a regular file");
      if (stat.size + totalBytes >= maxBytes)
        fail(
          "invalid_request",
          "Request exceeds the mailbox size limit",
          operation,
        );
      const bytes = readFileSync(fd);
      if (bytes.length + totalBytes >= maxBytes)
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

export type PreparedMessageInput = {
  text: string;
  canonicalPaths: string[];
};

export type MessagePreparationOptions = {
  fits?: (text: string) => boolean;
  inlineLimitBytes?: number;
  mailboxLimitBytes?: number;
  serializedBytes?: (text: string) => number;
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
  const result = file.input.startsWith("result:");
  const name = escapeMessageFileName(result ? file.input : file.canonicalPath);
  const path = result
    ? ` path="${escapeMessageFileName(file.canonicalPath)}"`
    : "";
  if (content === undefined)
    return `<file name="${name}"${path} bytes="${file.bytes}" />`;
  return `<file name="${name}" bytes="${file.bytes}">\n${content}\n</file>`;
}

export function prepareMessageInput(
  text: string,
  files: readonly string[],
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
      (options.serializedBytes
        ? (value: string) =>
            options.serializedBytes!(value) <=
            (options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES)
        : (value: string) =>
            Buffer.byteLength(value, "utf8") <=
            (options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES));
    if (!fits(text))
      fail(
        "invalid_request",
        options.serializedBytes
          ? `Mailbox payload is ${options.serializedBytes(text)} bytes; configured limit is ${options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES} bytes`
          : "Request exceeds the mailbox size limit",
        operation,
      );
    return { text, canonicalPaths: [] };
  }
  const regular = resolveRegularFiles(files, cwd, operation);
  const sections = regular.map((file) => renderMessageFile(file));
  const rendered = () => [...sections, `${heading}:\n${text}`].join("\n\n");
  const fits =
    options.fits ??
    ((value: string) =>
      (options.serializedBytes
        ? options.serializedBytes(value)
        : Buffer.byteLength(value, "utf8")) <=
      (options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES));
  if (!fits(rendered()))
    fail(
      "invalid_request",
      options.serializedBytes
        ? `Mailbox payload is ${options.serializedBytes(rendered())} bytes; configured limit is ${options.mailboxLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES} bytes`
        : "Request exceeds the mailbox size limit",
      operation,
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
      resolvedResultPath = resolveResultRef(file.input);
      // O_NONBLOCK prevents a path replaced by a FIFO from blocking this
      // preparation step. The descriptor is also the one that gets read.
      fd = openSync(
        file.canonicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const current = fstatSync(fd);
      if (!current.isFile()) throw new Error("not a regular file");
      if (
        current.dev !== file.dev ||
        current.ino !== file.ino ||
        current.size !== file.bytes ||
        current.size >
          (options.inlineLimitBytes ?? MAILBOX_PROTOCOL_LIMIT_BYTES) ||
        ((options.fits !== undefined ||
          options.serializedBytes === undefined) &&
          !fits(
            sections
              .map((section, i) =>
                i === index
                  ? renderMessageFile(file, "x".repeat(current.size))
                  : section,
              )
              .concat(`${heading}:\n${text}`)
              .join("\n\n"),
          ))
      )
        continue;
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
      if (offset !== current.size || fstatSync(fd).size !== current.size)
        continue;
      bytes = bytes.subarray(0, offset);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (
        resolvedResultPath &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        failUnknownResultRef(file.input, operation);
      fail(
        "invalid_request",
        `Cannot read file ${file.input}: ${error instanceof Error ? error.message : String(error)}`,
        operation,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (bytes.includes(0)) continue;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    sections[index] = renderMessageFile(file, content);
    if (!fits(rendered())) sections[index] = prior;
  }
  return {
    text: rendered(),
    canonicalPaths: regular.map((file) => file.canonicalPath),
  };
}
export function displayIdentity(
  agentDefinition: string,
  label: string,
): string {
  return `${agentDefinition}:${label}`;
}
export type SpawnPlacement = "tab" | "subtree" | "split";
export function hasTaskText(task: string | undefined): boolean {
  return task !== undefined && !!task.trim();
}
export function isSpawnPlacement(value: unknown): value is SpawnPlacement {
  return value === "tab" || value === "subtree" || value === "split";
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
