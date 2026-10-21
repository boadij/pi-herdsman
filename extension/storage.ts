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
const SEMANTIC_EVIDENCE_REF =
  /^evidence:([a-z][a-z0-9_-]{0,31})#([1-9][0-9]*)$/;
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
      ref?: string;
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
  const keys = Object.keys(r).sort();
  const legacyKeys = ["id", "name", "path", "sha256", "sourceAssignmentId"];
  const semanticKeys = [...legacyKeys, "ref"].sort();
  return (
    (keys.join("\0") === legacyKeys.join("\0") ||
      keys.join("\0") === semanticKeys.join("\0")) &&
    (!Object.hasOwn(r, "ref") || isCanonicalSemanticEvidenceRef(r.ref)) &&
    typeof r.sourceAssignmentId === "string" &&
    EVIDENCE_ID.test(r.sourceAssignmentId) &&
    typeof r.path === "string" &&
    r.path.length > 0 &&
    typeof r.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(r.sha256)
  );
}

export function isCanonicalSemanticEvidenceRef(
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const match = SEMANTIC_EVIDENCE_REF.exec(value);
  return !!match && Number.isSafeInteger(Number(match[2]));
}

/** Existing result identities remain unchanged; legacy snapshots must be upgraded before display. */
export function semanticEvidenceRef(evidence: RequiredEvidence): string {
  if ("result" in evidence) return evidence.result.ref;
  if (!evidence.ref)
    throw new Error("required evidence has no semantic reference");
  return evidence.ref;
}

/** Lazily gives pre-reference snapshots one durable identity without changing snapshot provenance. */
export function upgradeRequiredEvidence(value: unknown): RequiredEvidence {
  if (!isRequiredEvidence(value)) throw new Error("invalid required evidence");
  if ("result" in value || value.ref) return value;
  const ref = reserveSemanticEvidenceRef(value.id, value.name);
  return { ...value, ref };
}

/** Checks an existing snapshot identity without allocating or repairing it. */
export function verifySemanticEvidenceReservation(
  evidenceId: string,
  ref: string,
): void {
  if (!EVIDENCE_ID.test(evidenceId) || !isCanonicalSemanticEvidenceRef(ref))
    throw new Error("invalid semantic evidence reservation");
  const match = SEMANTIC_EVIDENCE_REF.exec(ref)!;
  const root = join(herdsmanDataRoot(), "evidence-ref-reservations");
  const paths = [
    join(root, "by-id", evidenceId),
    join(root, "refs", match[1]!, match[2]!),
  ];
  const contents = paths.map((path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("invalid semantic evidence reservation");
    return readFileSync(path, "utf8");
  });
  const [byId, byRef] = contents;
  if (byId !== `${ref}\n` || byRef !== `${evidenceId}\n`)
    throw new Error("invalid semantic evidence reservation");
}

/** Upgrades legacy snapshots first, then verifies the durable identity. */
export function upgradeAndVerifyRequiredEvidence(
  value: unknown,
): RequiredEvidence {
  const evidence = upgradeRequiredEvidence(value);
  if (!("result" in evidence))
    verifySemanticEvidenceReservation(evidence.id, evidence.ref!);
  return evidence;
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
      ref: reserveSemanticEvidenceRef(id, name),
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

export function reserveSemanticEvidenceRef(
  evidenceId: string,
  name: string,
): string {
  if (!EVIDENCE_ID.test(evidenceId)) throw new Error("invalid evidence id");
  const root = join(herdsmanDataRoot(), "evidence-ref-reservations");
  const byId = join(root, "by-id");
  mkdirSync(byId, { recursive: true, mode: 0o700 });
  chmodSync(byId, 0o700);
  const mapping = join(byId, evidenceId);
  try {
    const existing = readFileSync(mapping, "utf8").trim();
    if (isCanonicalSemanticEvidenceRef(existing)) return existing;
    throw new Error("invalid semantic evidence reservation");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const label =
    safeEvidenceName(name)
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .slice(0, 32) || "evidence";
  const directory = join(root, "refs", label);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let index = 1;
  for (const entry of readdirSync(directory)) {
    if (/^[1-9][0-9]*$/.test(entry)) index = Math.max(index, Number(entry) + 1);
  }
  for (;;) {
    if (!Number.isSafeInteger(index))
      throw new Error("Semantic evidence index exhausted");
    const ref = `evidence:${label}#${index}`;
    try {
      writeFileSync(join(directory, String(index)), `${evidenceId}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      try {
        writeFileSync(mapping, `${ref}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return reserveSemanticEvidenceRef(evidenceId, name);
      }
      return ref;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        index++;
        continue;
      }
      throw error;
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
