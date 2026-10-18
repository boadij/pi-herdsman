import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";

const RESULT_PREFIX = "result:";
const RESULT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEMANTIC_RESULT_REF = /^result:([a-z][a-z0-9_-]{0,31})#([1-9][0-9]*)$/;
const INCIDENTAL_METADATA = new Set([
  ".ds_store",
  "desktop.ini",
  "thumbs.db",
  ".directory",
]);

export function isIncidentalMetadata(entry: Dirent): boolean {
  return entry.isFile() && INCIDENTAL_METADATA.has(entry.name.toLowerCase());
}

export type ResultBinding = Readonly<{
  ref: string;
  canonicalRef: string;
}>;

export type RequiredEvidence = Readonly<
  | {
      id: string;
      name: string;
      sourceAssignmentId: string;
      path: string;
      sha256: string;
    }
  | { id: string; name: string; result: ResultBinding }
>;

const EVIDENCE_ID = RESULT_ID;
const EVIDENCE_SNAPSHOT_MAX_BYTES = 1024 * 1024;

export function isRequiredEvidence(value: unknown): value is RequiredEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    !EVIDENCE_ID.test(r.id) ||
    typeof r.name !== "string" ||
    !r.name ||
    r.name.length > 255
  )
    return false;
  if (Object.hasOwn(r, "result"))
    return Object.keys(r).length === 3 && isResultBinding(r.result);
  return (
    Object.keys(r).length === 5 &&
    typeof r.sourceAssignmentId === "string" &&
    EVIDENCE_ID.test(r.sourceAssignmentId) &&
    typeof r.path === "string" &&
    r.path.length > 0 &&
    typeof r.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(r.sha256)
  );
}

export function requiredEvidenceDirectory(assignmentId: string): string {
  if (!EVIDENCE_ID.test(assignmentId))
    throw new Error("invalid evidence assignment id");
  return join(herdsmanDataRoot(), "evidence", assignmentId);
}

function assertEvidenceDirectory(
  assignmentId: string,
  create: boolean,
): string {
  const directory = requiredEvidenceDirectory(assignmentId);
  const paths = [
    herdsmanDataRoot(),
    join(herdsmanDataRoot(), "evidence"),
    directory,
  ];
  for (const path of paths) {
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("required evidence directory is unsafe");
  }
  return directory;
}

function safeEvidenceName(name: string): string {
  const base = basename(name)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 100);
  return base || "evidence.txt";
}

/** Persist validated UTF-8 text under private storage; returns its immutable identity. */
export function persistRequiredEvidenceSnapshot(
  assignmentId: string,
  name: string,
  text: string,
): RequiredEvidence {
  const bytes = Buffer.from(text, "utf8");
  if (
    bytes.length > EVIDENCE_SNAPSHOT_MAX_BYTES ||
    bytes.includes(0) ||
    new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== text
  )
    throw new Error(
      "Required evidence must be supported UTF-8 text no larger than 1 MiB",
    );
  const directory = assertEvidenceDirectory(assignmentId, true);
  chmodSync(directory, 0o700);
  const id = randomUUID();
  const path = join(directory, `${id}-${safeEvidenceName(name)}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertEvidenceDirectory(assignmentId, false);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    if (process.platform !== "win32") {
      const dirFd = openSync(directory, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
    return {
      id,
      name: safeEvidenceName(name),
      sourceAssignmentId: assignmentId,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Read only the exact regular snapshot for this assignment and verify its digest. */
export function readRequiredEvidenceSnapshot(
  assignmentId: string,
  evidence: RequiredEvidence,
): string {
  if (!isRequiredEvidence(evidence) || "result" in evidence)
    throw new Error("invalid required evidence snapshot");
  if (evidence.sourceAssignmentId !== assignmentId)
    throw new Error("required evidence source assignment mismatch");
  const directory = requiredEvidenceDirectory(evidence.sourceAssignmentId);
  if (
    evidence.path !==
    join(directory, `${evidence.id}-${safeEvidenceName(evidence.name)}`)
  )
    throw new Error("required evidence path mismatch");
  assertEvidenceDirectory(evidence.sourceAssignmentId, false);
  const before = lstatSync(evidence.path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > EVIDENCE_SNAPSHOT_MAX_BYTES
  )
    throw new Error(
      "required evidence snapshot is missing, unsafe, or oversized",
    );
  const fd = openSync(
    evidence.path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("required evidence snapshot changed during read");
    const bytes = readFileSync(fd);
    if (
      bytes.length > EVIDENCE_SNAPSHOT_MAX_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== evidence.sha256
    )
      throw new Error("required evidence snapshot integrity check failed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}

export function parseSemanticResultRef(
  input: string,
): { agent: string; index: number } | undefined {
  const match = SEMANTIC_RESULT_REF.exec(input);
  if (!match) return undefined;

  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) return undefined;

  return { agent: match[1], index };
}

export function isCanonicalResultRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(RESULT_PREFIX) &&
    RESULT_ID.test(value.slice(RESULT_PREFIX.length))
  );
}

export function isResultBinding(value: unknown): value is ResultBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.ref === "string" &&
    !!parseSemanticResultRef(record.ref) &&
    isCanonicalResultRef(record.canonicalRef)
  );
}

export function herdsmanDataRoot(): string {
  return join(getAgentDir(), "pi-herdsman");
}

export function herdsmanConfigPath(): string {
  return join(herdsmanDataRoot(), "config.json");
}

export function herdsmanTempRoot(): string {
  return join(tmpdir(), `pi-herdsman-${process.getuid?.() ?? "user"}`);
}

function validateResultId(requestId: string): void {
  if (!RESULT_ID.test(requestId)) throw new Error("invalid result request id");
}

export function resultPath(requestId: string): string {
  validateResultId(requestId);
  return join(herdsmanDataRoot(), "results", requestId);
}

export function resultRef(requestId: string): string {
  validateResultId(requestId);
  return `${RESULT_PREFIX}${requestId}`;
}

export function reserveSemanticResultRef(
  agentLabel: string,
  minimumIndex = 1,
): Readonly<{ ref: string; index: number }> {
  if (!parseSemanticResultRef(`result:${agentLabel}#${minimumIndex}`))
    throw new Error("Invalid semantic result identity");

  const directory = join(
    herdsmanDataRoot(),
    "result-ref-reservations",
    agentLabel,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  let index = minimumIndex;
  // ponytail: immutable reservation scan; replace with a counter only if
  // allocation volume makes this measurably expensive.
  for (const name of readdirSync(directory)) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const reserved = Number(name);
    if (Number.isSafeInteger(reserved)) index = Math.max(index, reserved + 1);
  }

  for (;;) {
    if (!Number.isSafeInteger(index))
      throw new Error("Semantic result index exhausted");
    try {
      writeFileSync(join(directory, String(index)), "reserved\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      if (process.platform !== "win32") {
        const fd = openSync(directory, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      return { index, ref: `result:${agentLabel}#${index}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        index++;
        continue;
      }
      throw error;
    }
  }
}

export function resolveResultRef(input: string): string | undefined {
  if (!input.startsWith(RESULT_PREFIX)) return undefined;
  return resultPath(input.slice(RESULT_PREFIX.length));
}
