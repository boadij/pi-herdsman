import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const dist = resolve(root, "dist");

rmSync(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    index: "extension/index.ts",
    "integrations/pi-codex-context-sharing":
      "extension/integrations/pi-codex-context-sharing.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@howaboua/pi-codex-conversion/context-sharing",
    "typebox",
  ],
});
cpSync(
  resolve(root, "extension/agent-definitions"),
  resolve(dist, "agent-definitions"),
  {
    recursive: true,
  },
);
