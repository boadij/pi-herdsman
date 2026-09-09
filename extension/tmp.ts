import { tmpdir } from "node:os";
import { join } from "node:path";

export function herdsmanTempRoot(): string {
  return join(tmpdir(), `pi-herdsman-${process.getuid?.() ?? "user"}`);
}
