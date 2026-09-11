import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const RESULT_PREFIX = "result:";
const RESULT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
