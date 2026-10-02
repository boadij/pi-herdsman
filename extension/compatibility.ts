import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SHA256 = /^[0-9a-f]{64}$/;

export type RuntimeBuild = Readonly<{
  version: string;
  sha256: string;
}>;

export function runtimeBuild(version: string, path: string): RuntimeBuild {
  return Object.freeze({
    version,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  });
}

export function isRuntimeBuild(value: unknown): value is RuntimeBuild {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.version === "string" &&
    record.version.length > 0 &&
    record.version.length <= 128 &&
    typeof record.sha256 === "string" &&
    SHA256.test(record.sha256)
  );
}

export function sameRuntimeBuild(
  left: RuntimeBuild,
  right: RuntimeBuild,
): boolean {
  return left.version === right.version && left.sha256 === right.sha256;
}

export function formatRuntimeBuild(build: RuntimeBuild): string {
  return `v${build.version} · ${build.sha256.slice(0, 12)}`;
}
