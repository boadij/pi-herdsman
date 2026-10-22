import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { herdsmanDataRoot } from "./storage.ts";
import { isResultBinding, type ResultBinding } from "./storage.ts";
import { PEER_TRANSPORT_FRAME_LIMIT_BYTES } from "./peer-transport.ts";

export type PeerPortableAttachment = Readonly<{
  name: string;
  ref?: string;
  marker: string;
  text: string;
  sha256: string;
}>;
export type PeerEvidence = Readonly<{
  attachments: PeerPortableAttachment[];
  resultBindings?: ResultBinding[];
}>;

export function resolvePeerResultBindings(
  bindings: readonly ResultBinding[],
  existingRefs: (semanticRef: string) => ReadonlySet<string>,
): { bindings: ResultBinding[]; conflicts: ResultBinding[] } {
  const accepted: ResultBinding[] = [];
  const conflicts: ResultBinding[] = [];
  for (const binding of bindings) {
    const existing = existingRefs(binding.ref);
    if (
      existing.size > 1 ||
      (existing.size === 1 && !existing.has(binding.canonicalRef))
    )
      conflicts.push(binding);
    else accepted.push(binding);
  }
  return { bindings: accepted, conflicts };
}

export type PeerCorrespondence = {
  id: string;
  capability: string;
  originSession: string;
  originGeneration: string;
  recipientSession: string;
  recipientGeneration: string;
  acceptanceId: string;
  finalized?: boolean;
  replies: Array<{
    id: string;
    digest: string;
    text: string;
    attachments?: PeerPortableAttachment[];
    resultBindings?: ResultBinding[];
    createdAt: number;
    acknowledged: boolean;
  }>;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function assertPeerDataRoot(actual: string, expected: string): void {
  if (!actual || !expected || actual !== expected)
    throw new Error("peer endpoint data root does not match the active route");
}
export function peerPayloadDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== "object") {
      const scalar = JSON.stringify(item);
      if (scalar === undefined) throw new Error("invalid peer digest payload");
      return scalar;
    }
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    const object = item as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function directory(): string {
  const path = join(herdsmanDataRoot(), "runtime", "peer-correspondences");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
function valid(value: unknown): value is PeerCorrespondence {
  if (!value || typeof value !== "object") return false;
  const c = value as PeerCorrespondence;
  return (
    ID.test(c.id) &&
    /^[0-9a-f]{64}$/u.test(c.capability) &&
    [
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
      c.acceptanceId,
    ].every((s) => typeof s === "string" && s.length > 0 && s.length <= 512) &&
    (c.finalized === undefined || typeof c.finalized === "boolean") &&
    Array.isArray(c.replies) &&
    c.replies.every(
      (reply) =>
        !!reply &&
        ID.test(reply.id) &&
        /^[0-9a-f]{64}$/u.test(reply.digest) &&
        typeof reply.text === "string" &&
        (reply.attachments === undefined ||
          (Array.isArray(reply.attachments) &&
            reply.attachments.every(
              (attachment) =>
                typeof attachment.name === "string" &&
                typeof attachment.marker === "string" &&
                typeof attachment.text === "string" &&
                /^[0-9a-f]{64}$/u.test(attachment.sha256) &&
                createHash("sha256")
                  .update(attachment.text, "utf8")
                  .digest("hex") === attachment.sha256,
            ))) &&
        (reply.resultBindings === undefined ||
          (Array.isArray(reply.resultBindings) &&
            reply.resultBindings.every(isResultBinding))) &&
        Number.isFinite(reply.createdAt) &&
        typeof reply.acknowledged === "boolean",
    )
  );
}
function save(c: PeerCorrespondence): void {
  const path = join(directory(), `${c.id}.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c)}\n`, {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
  renameSync(tmp, path);
}
export function createPeerCorrespondence(
  input: Omit<PeerCorrespondence, "id" | "capability" | "replies">,
): PeerCorrespondence {
  const c: PeerCorrespondence = {
    ...input,
    id: randomUUID(),
    capability: randomBytes(32).toString("hex"),
    replies: [],
  };
  save(c);
  return c;
}
export function storePeerCorrespondence(c: PeerCorrespondence): void {
  if (!valid(c)) throw new Error("invalid peer correspondence");
  const existing = listPeerCorrespondences().find((item) => item.id === c.id);
  if (existing) {
    if (existing.finalized)
      throw new Error("peer correspondence is already finalized");
    if (
      [
        "capability",
        "originSession",
        "originGeneration",
        "recipientSession",
      ].some(
        (key) =>
          existing[key as keyof PeerCorrespondence] !==
          c[key as keyof PeerCorrespondence],
      )
    )
      throw new Error("conflicting peer correspondence");
    if (existing.recipientGeneration !== c.recipientGeneration) {
      existing.recipientGeneration = c.recipientGeneration;
      save(existing);
    }
    return;
  }
  save(c);
}
export function updatePeerOriginGeneration(
  id: string,
  capability: string,
  originSession: string,
  oldGeneration: string,
  newGeneration: string,
): PeerCorrespondence {
  const c = listPeerCorrespondences().find((item) => item.id === id);
  if (
    !c ||
    c.finalized ||
    !matchesCapability(c.capability, capability) ||
    c.originSession !== originSession ||
    c.originGeneration !== oldGeneration ||
    !newGeneration
  )
    throw new Error("peer correspondence recovery rejected");
  c.originGeneration = newGeneration;
  save(c);
  return c;
}
export function updatePeerRecipientGeneration(
  id: string,
  capability: string,
  recipientSession: string,
  oldGeneration: string,
  newGeneration: string,
): PeerCorrespondence {
  const c = listPeerCorrespondences().find((item) => item.id === id);
  if (
    !c ||
    c.finalized ||
    !matchesCapability(c.capability, capability) ||
    c.recipientSession !== recipientSession ||
    !newGeneration
  )
    throw new Error("peer correspondence recipient recovery rejected");
  if (c.recipientGeneration === newGeneration) return c;
  if (c.recipientGeneration !== oldGeneration)
    throw new Error("peer correspondence recipient recovery rejected");
  c.recipientGeneration = newGeneration;
  save(c);
  return c;
}
export function removePeerCorrespondence(id: string): void {
  if (!ID.test(id)) return;
  try {
    unlinkSync(join(directory(), `${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export function listPeerCorrespondences(): PeerCorrespondence[] {
  return readdirSync(directory()).flatMap((name) => {
    if (!ID.test(name.replace(/\.json$/u, "")) || !name.endsWith(".json"))
      return [];
    try {
      const c: unknown = JSON.parse(
        readFileSync(join(directory(), name), "utf8"),
      );
      return valid(c) ? [c] : [];
    } catch {
      return [];
    }
  });
}
function matchesCapability(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(expected) || !/^[0-9a-f]{64}$/u.test(actual))
    return false;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (timingSafeEqual(actualBytes, expectedBytes)) return true;
  return timingSafeEqual(
    Buffer.from(
      createHash("sha256").update(expectedBytes).digest("hex"),
      "hex",
    ),
    actualBytes,
  );
}
export function queuePeerReply(
  c: PeerCorrespondence,
  replyId: string,
  text: string,
  evidence: PeerEvidence = { attachments: [] },
): "queued" | "duplicate" {
  if (c.finalized) throw new Error("peer correspondence is finalized");
  const payload = {
    text,
    ...(evidence.attachments.length
      ? { attachments: evidence.attachments }
      : {}),
    ...(evidence.resultBindings?.length
      ? { resultBindings: evidence.resultBindings }
      : {}),
  };
  if (
    !ID.test(replyId) ||
    !text ||
    Buffer.byteLength(JSON.stringify(payload), "utf8") >
      PEER_TRANSPORT_FRAME_LIMIT_BYTES
  )
    throw new Error("invalid peer reply");
  const digest = peerPayloadDigest(payload);
  const prior = c.replies.find((r) => r.id === replyId);
  if (prior) {
    if (prior.digest !== digest)
      throw new Error("conflicting peer reply identity");
    return "duplicate";
  }
  c.replies.push({
    id: replyId,
    digest,
    text,
    attachments: [...evidence.attachments],
    ...(evidence.resultBindings?.length
      ? { resultBindings: [...evidence.resultBindings] }
      : {}),
    createdAt: Date.now(),
    acknowledged: false,
  });
  save(c);
  return "queued";
}
export function pollPeerReplies(
  id: string,
  capability: string,
  originSession: string,
  originGeneration: string,
  recipientSession: string,
  recipientGeneration: string,
): PeerCorrespondence["replies"] {
  const c = listPeerCorrespondences().find((item) => item.id === id);
  if (
    !c ||
    c.finalized ||
    !matchesCapability(c.capability, capability) ||
    c.originSession !== originSession ||
    c.originGeneration !== originGeneration ||
    c.recipientSession !== recipientSession ||
    c.recipientGeneration !== recipientGeneration
  )
    throw new Error("peer correspondence authorization failed");
  return c.replies.filter((reply) => !reply.acknowledged);
}
export function acknowledgePeerReply(
  id: string,
  capability: string,
  replyId: string,
  originSession: string,
  originGeneration: string,
  recipientSession: string,
  recipientGeneration: string,
): void {
  const replies = pollPeerReplies(
    id,
    capability,
    originSession,
    originGeneration,
    recipientSession,
    recipientGeneration,
  );
  const c = listPeerCorrespondences().find((item) => item.id === id)!;
  const reply = c.replies.find((item) => item.id === replyId);
  if (!reply) {
    if (c.replies.some((item) => item.id === replyId && item.acknowledged))
      return;
    throw new Error("unknown peer reply");
  }
  if (!replies.some((item) => item.id === replyId)) return;
  reply.acknowledged = true;
  save(c);
}
export function finalizePeerCorrespondence(
  id: string,
  capability: string,
  originSession: string,
  originGeneration: string,
  recipientSession: string,
  recipientGeneration: string,
): void {
  const c = listPeerCorrespondences().find((item) => item.id === id);
  if (
    !c ||
    !matchesCapability(c.capability, capability) ||
    c.originSession !== originSession ||
    c.originGeneration !== originGeneration ||
    c.recipientSession !== recipientSession ||
    c.recipientGeneration !== recipientGeneration
  )
    throw new Error("peer correspondence authorization failed");
  if (c.replies.some((reply) => !reply.acknowledged))
    throw new Error("cannot finalize peer correspondence with pending replies");
  if (c.finalized) return;
  c.capability = createHash("sha256")
    .update(Buffer.from(capability, "hex"))
    .digest("hex");
  c.replies = [];
  c.finalized = true;
  save(c);
}
