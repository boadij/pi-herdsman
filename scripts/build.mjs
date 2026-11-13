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
    "typebox",
  ],
});
for (const directory of ["agents", "coordinators"])
  cpSync(resolve(root, "extension", directory), resolve(dist, directory), {
    recursive: true,
  });
