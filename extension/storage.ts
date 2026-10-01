import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const RESULT_PREFIX = "result:";
const RESULT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEMANTIC_RESULT_REF = /^result:([a-z][a-z0-9_-]{0,31})#([1-9][0-9]*)$/;

export type ResultBinding = Readonly<{
  ref: string;
  canonicalRef: string;
}>;

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

export function resolveResultRef(input: string): string | undefined {
  if (!input.startsWith(RESULT_PREFIX)) return undefined;
  return resultPath(input.slice(RESULT_PREFIX.length));
}
