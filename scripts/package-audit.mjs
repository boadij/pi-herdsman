import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const normalize = (path) => path.replace(/^package\//u, "");
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) throw new Error("package audit must run through npm");
const packed = JSON.parse(
  execFileSync(
    process.execPath,
    [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: root,
      encoding: "utf8",
    },
  ),
);
const files = packed[0]?.files ?? [];
const allowed =
  /^(?:package\.json|README\.md|SKILL\.md|LICENSE|docs\/|dist\/)/u;
const expectedRoot = new Set([
  "package.json",
  "README.md",
  "SKILL.md",
  "LICENSE",
]);
const expectedDefinitions = readdirSync(
  resolve(root, "extension/agent-definitions"),
).filter((name) => name.endsWith(".md"));
const expectedDist = new Set([
  "dist/index.js",
  ...expectedDefinitions.map((name) => `dist/agent-definitions/${name}`),
]);
for (const path of expectedRoot)
  if (!files.some((entry) => normalize(entry.path) === path)) {
    console.error(`missing package path: ${path}`);
    process.exitCode = 1;
  }
for (const path of files.map((entry) => normalize(entry.path)))
  if (path.startsWith("dist/") && !expectedDist.has(path)) {
    console.error(`unexpected package path: ${path}`);
    process.exitCode = 1;
  }
for (const path of expectedDist)
  if (!files.some((entry) => normalize(entry.path) === path)) {
    console.error(`missing package path: ${path}`);
    process.exitCode = 1;
  }
const rules = [
  ["home path", homedir()],
  ["repository path", root],
  ["private key", /-----BEGIN [^-]* PRIVATE KEY-----/u],
  ["npm token", /\bnpm_[A-Za-z0-9_-]{20,}\b/u],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["npm auth token", /_authToken\s*=/iu],
  [
    "authorization token",
    /Authorization:\s*Bearer\s+(?!<[^>]+>|placeholder\b|example\b)[A-Za-z0-9._~+/=-]{12,}/iu,
  ],
  ["API token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
];

for (const entry of files) {
  const path = normalize(entry.path);
  if (!allowed.test(path)) {
    console.error(`unexpected package path: ${path}`);
    process.exitCode = 1;
    continue;
  }
  const absolute = resolve(root, path);
  const data = readFileSync(absolute);
  if (data.includes(0)) continue;
  const text = data.toString("utf8");
  for (const [name, rule] of rules) {
    const matched =
      typeof rule === "string" ? text.includes(rule) : rule.test(text);
    if (matched) {
      console.error(`private material rule ${name} matched in ${path}`);
      process.exitCode = 1;
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`package audit passed: ${files.length} files`);
