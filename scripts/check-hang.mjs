import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("check-hang requires a PID output path");

const child = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
  { stdio: "ignore" },
);
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
writeFileSync(
  temporaryPath,
  JSON.stringify({ parent: process.pid, child: child.pid }),
);
renameSync(temporaryPath, outputPath);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
