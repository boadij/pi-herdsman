import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fail } from "./errors.ts";

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

export function requireCompatibleBuild(
  local: RuntimeBuild,
  remote: RuntimeBuild | undefined,
  operation: string,
  target: string,
): asserts remote is RuntimeBuild {
  if (remote && sameRuntimeBuild(local, remote)) return;

  fail(
    "incompatible_build",
    remote
      ? `Pi Herdsman build mismatch for ${target}: local ${formatRuntimeBuild(local)}, target ${formatRuntimeBuild(remote)}.`
      : `Cannot establish Pi Herdsman build compatibility for ${target}; the target predates the current runtime identity contract.`,
    operation,
    {
      nextAction: remote
        ? "Restart the Pi session that remained running across the Herdsman update. If uncertain, restart this session and any still-running target session, then retry."
        : `Restart ${target} so it reloads the current Pi Herdsman build.`,
      details: { localBuild: local, remoteBuild: remote ?? null },
    },
  );
}
