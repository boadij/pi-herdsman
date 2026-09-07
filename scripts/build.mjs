import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const dist = resolve(root, "dist");

rmSync(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["extension/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
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
