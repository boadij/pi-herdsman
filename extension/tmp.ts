import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

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
