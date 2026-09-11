import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const RESULT_PREFIX = "result:";
const RESULT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith(`~${sep}`))
    return join(homedir(), configured.slice(2));
  return configured;
}

export function herdsmanDataRoot(): string {
  return join(piAgentDir(), "pi-herdsman");
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
