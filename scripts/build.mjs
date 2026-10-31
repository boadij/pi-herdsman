import { build } from "esbuild";
import { nodeTarget } from "./node-target.mjs";
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
    "peer-bridge": "bin/peer-bridge.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: nodeTarget.buildTarget,
  sourcemap: true,
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@howaboua/pi-codex-conversion/context-sharing",
    "typebox",
  ],
});
for (const directory of ["agents", "roles"])
  cpSync(resolve(root, "extension", directory), resolve(dist, directory), {
    recursive: true,
  });
