import { readFileSync } from "node:fs";

export function resolveNodeTarget({ engines, devDependencies }) {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines?.node);
  if (!match)
    throw new Error("engines.node must specify a >=major.minor.patch minimum");
  const types = /^(\d+)\.\d+\.\d+$/.exec(devDependencies?.["@types/node"]);
  if (!types || types[1] !== match[1])
    throw new Error("@types/node major must match the minimum Node major");
  return { version: match.slice(1).join("."), buildTarget: `node${match[1]}` };
}

export const nodeTarget = resolveNodeTarget(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url))),
);
