import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type CoordinatorRole = "lead" | "manager";

export const COORDINATOR_TARGET_PATTERN =
  "^(?:lead|manager):[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{10}$";

const TARGET_ENTRY = "pi-herdsman-coordinator-target-v1";
const TARGET_PATTERN = new RegExp(COORDINATOR_TARGET_PATTERN);
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

type TargetBinding = {
  version: 1;
  ownerSessionId: string;
  target: string;
  role: CoordinatorRole;
  sessionId: string;
};

function isCoordinatorRole(role: unknown): role is CoordinatorRole {
  return role === "lead" || role === "manager";
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string")
    throw new Error("Invalid canonical Pi session ID");

  try {
    // Pi keeps its canonical session-ID validation in SessionManager.
    SessionManager.inMemory(undefined, { id: sessionId });
  } catch {
    throw new Error("Invalid canonical Pi session ID");
  }
}

export function coordinatorTarget(
  role: CoordinatorRole,
  sessionId: string,
): string {
  if (!isCoordinatorRole(role)) throw new Error("Invalid coordinator role");
  assertSessionId(sessionId);

  const digest = createHash("sha256")
    .update("pi-herdsman:coordinator-target:v1\0")
    .update(role)
    .update("\0")
    .update(sessionId)
    .digest();
  let bits = BigInt(`0x${digest.subarray(0, 7).toString("hex")}`) >> 6n;
  let suffix = "";

  for (let i = 0; i < 10; i++) {
    suffix = ALPHABET[Number(bits & 31n)]! + suffix;
    bits >>= 5n;
  }

  return `${role}:${suffix}`;
}

function normalizeTarget(target: unknown): string {
  if (typeof target !== "string" || !TARGET_PATTERN.test(target))
    throw new Error("Invalid coordinator target");
  return target.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBinding(data: unknown, ownerSessionId: string): TargetBinding {
  if (!isRecord(data)) throw new Error("Malformed coordinator target binding");
  const keys = Object.keys(data).sort();
  if (
    keys.length !== 5 ||
    keys.join(",") !== "ownerSessionId,role,sessionId,target,version" ||
    data.version !== 1 ||
    typeof data.ownerSessionId !== "string" ||
    typeof data.target !== "string" ||
    !isCoordinatorRole(data.role) ||
    typeof data.sessionId !== "string"
  )
    throw new Error("Malformed coordinator target binding");

  assertSessionId(data.ownerSessionId);
  assertSessionId(data.sessionId);
  const target = normalizeTarget(data.target);
  if (
    data.ownerSessionId !== ownerSessionId ||
    target !== data.target ||
    target !== coordinatorTarget(data.role, data.sessionId)
  )
    throw new Error("Inconsistent coordinator target binding");

  return {
    version: 1,
    ownerSessionId: data.ownerSessionId,
    target,
    role: data.role,
    sessionId: data.sessionId,
  };
}

function readBindings(
  ctx: ExtensionContext,
  entries: readonly unknown[] = ctx.sessionManager.getEntries(),
): TargetBinding[] {
  const ownerSessionId = ctx.sessionManager.getSessionId();
  assertSessionId(ownerSessionId);

  const bindings: TargetBinding[] = [];
  const byTarget = new Map<string, TargetBinding>();
  const byIdentity = new Map<string, TargetBinding>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.customType !== TARGET_ENTRY) continue;
    if (entry.type !== "custom")
      throw new Error("Malformed coordinator target entry");

    const binding = parseBinding(entry.data, ownerSessionId);
    const identity = `${binding.role}\0${binding.sessionId}`;
    const targetBinding = byTarget.get(binding.target);
    const identityBinding = byIdentity.get(identity);
    if (
      (targetBinding &&
        (targetBinding.role !== binding.role ||
          targetBinding.sessionId !== binding.sessionId)) ||
      (identityBinding && identityBinding.target !== binding.target)
    )
      throw new Error("Conflicting coordinator target bindings");

    byTarget.set(binding.target, binding);
    byIdentity.set(identity, binding);
    bindings.push(binding);
  }
  return bindings;
}

export function rememberCoordinatorTarget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  role: CoordinatorRole,
  sessionId: string,
): string {
  const target = coordinatorTarget(role, sessionId);
  const ownerSessionId = ctx.sessionManager.getSessionId();
  assertSessionId(ownerSessionId);
  const binding: TargetBinding = {
    version: 1,
    ownerSessionId,
    target,
    role,
    sessionId,
  };
  const existing = readBindings(ctx);
  if (
    existing.some(
      (candidate) =>
        (candidate.target === target &&
          (candidate.role !== role || candidate.sessionId !== sessionId)) ||
        (candidate.role === role &&
          candidate.sessionId === sessionId &&
          candidate.target !== target),
    )
  )
    throw new Error("Conflicting coordinator target binding");

  const activeBranch = readBindings(ctx, ctx.sessionManager.getBranch());

  if (
    !activeBranch.some(
      (candidate) =>
        candidate.ownerSessionId === ownerSessionId &&
        candidate.target === target &&
        candidate.role === role &&
        candidate.sessionId === sessionId,
    )
  ) {
    pi.appendEntry(TARGET_ENTRY, binding);
    if (
      !readBindings(ctx, ctx.sessionManager.getBranch()).some(
        (candidate) =>
          candidate.ownerSessionId === ownerSessionId &&
          candidate.target === target &&
          candidate.role === role &&
          candidate.sessionId === sessionId,
      )
    )
      throw new Error("Coordinator target binding was not persisted");
  }

  return target;
}

export function resolveCoordinatorTarget(
  ctx: ExtensionContext,
  target: string,
): { role: CoordinatorRole; sessionId: string } {
  const normalizedTarget = normalizeTarget(target);
  const binding = readBindings(ctx, ctx.sessionManager.getBranch()).find(
    (candidate) => candidate.target === normalizedTarget,
  );
  if (!binding) throw new Error("Unknown coordinator target; rediscover it");
  return { role: binding.role, sessionId: binding.sessionId };
}
