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
import { acquireProcessLock, ProcessLockOccupiedError } from "./lock.ts";
import { herdsmanDataRoot } from "./storage.ts";
import { isResultBinding, type ResultBinding } from "./storage.ts";
import {
  PEER_TRANSPORT_FRAME_LIMIT_BYTES,
  peerPayloadDigest,
} from "./peer-transport.ts";
export { peerPayloadDigest } from "./peer-transport.ts";

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
  originDisplay?: PeerOriginDisplay;
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

export type PeerOriginDisplay = {
  name?: string;
  workspaceLabel?: string;
};

export function validPeerDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(
      value,
    )
  );
}

function validOriginDisplay(value: unknown): value is PeerOriginDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.entries(value);
  return (
    fields.length > 0 &&
    fields.every(
      ([key, text]) =>
        (key === "name" || key === "workspaceLabel") &&
        validPeerDisplayText(text),
    )
  );
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function assertPeerDataRoot(actual: string, expected: string): void {
  if (!actual || !expected || actual !== expected)
    throw new Error("peer endpoint data root does not match the active route");
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
    (c.originDisplay === undefined || validOriginDisplay(c.originDisplay)) &&
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
function mutate<T>(id: string, action: (c: PeerCorrespondence) => T): T {
  let lock: ReturnType<typeof acquireProcessLock> | undefined;
  const deadline = Date.now() + 15_000;
  while (!lock) {
    try {
      lock = acquireProcessLock(join(directory(), `${id}.lock`), {
        name: "peer correspondence mutation",
      });
    } catch (error) {
      if (
        !(error instanceof ProcessLockOccupiedError) ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const c = listPeerCorrespondences().find((item) => item.id === id);
    if (!c) throw new Error("peer correspondence not found");
    const result = action(c);
    save(c);
    return result;
  } finally {
    lock.release();
  }
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
  if (!valid(c)) throw new Error("invalid peer correspondence");
  save(c);
  return c;
}
export function storePeerCorrespondence(c: PeerCorrespondence): void {
  if (!valid(c)) throw new Error("invalid peer correspondence");
  const existing = listPeerCorrespondences().find((item) => item.id === c.id);
  if (existing) {
    mutate(c.id, (current) => {
      if (current.finalized)
        throw new Error("peer correspondence is already finalized");
      if (
        [
          "capability",
          "originSession",
          "originGeneration",
          "recipientSession",
        ].some(
          (key) =>
            current[key as keyof PeerCorrespondence] !==
            c[key as keyof PeerCorrespondence],
        )
      )
        throw new Error("conflicting peer correspondence");
      current.recipientGeneration = c.recipientGeneration;
      if (c.originDisplay) {
        current.originDisplay = {
          ...current.originDisplay,
          ...c.originDisplay,
        };
      }
    });
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
  if (!newGeneration) throw new Error("peer correspondence recovery rejected");
  return mutate(id, (c) => {
    if (
      c.finalized ||
      !matchesCapability(c.capability, capability) ||
      c.originSession !== originSession
    )
      throw new Error("peer correspondence recovery rejected");
    if (c.originGeneration === newGeneration) return c;
    if (c.originGeneration !== oldGeneration)
      throw new Error("peer correspondence recovery rejected");
    c.originGeneration = newGeneration;
    return c;
  });
}
export function updatePeerRecipientGeneration(
  id: string,
  capability: string,
  recipientSession: string,
  oldGeneration: string,
  newGeneration: string,
): PeerCorrespondence {
  if (!newGeneration)
    throw new Error("peer correspondence recipient recovery rejected");
  return mutate(id, (c) => {
    if (
      c.finalized ||
      !matchesCapability(c.capability, capability) ||
      c.recipientSession !== recipientSession
    )
      throw new Error("peer correspondence recipient recovery rejected");
    if (c.recipientGeneration === newGeneration) return c;
    if (c.recipientGeneration !== oldGeneration)
      throw new Error("peer correspondence recipient recovery rejected");
    c.recipientGeneration = newGeneration;
    return c;
  });
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
  return mutate(c.id, (current) => {
    if (current.finalized) throw new Error("peer correspondence is finalized");
    const prior = current.replies.find((r) => r.id === replyId);
    if (prior) {
      if (prior.digest !== digest)
        throw new Error("conflicting peer reply identity");
      return "duplicate";
    }
    const reply = {
      id: replyId,
      digest,
      text,
      ...(evidence.attachments.length
        ? { attachments: [...evidence.attachments] }
        : {}),
      ...(evidence.resultBindings?.length
        ? { resultBindings: [...evidence.resultBindings] }
        : {}),
      createdAt: Date.now(),
      acknowledged: false,
    };
    const envelope = (replies: typeof current.replies) =>
      JSON.stringify({
        dataRoot: herdsmanDataRoot(),
        replies,
        hasReplies: true,
      });
    const single = Buffer.byteLength(envelope([reply]), "utf8") + 1;
    if (single > PEER_TRANSPORT_FRAME_LIMIT_BYTES)
      throw new Error("peer reply exceeds response limit");
    current.replies.push(reply);
    return "queued";
  });
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
  const batch: PeerCorrespondence["replies"] = [];
  for (const reply of c.replies.filter((item) => !item.acknowledged)) {
    const candidate = [...batch, reply];
    if (
      Buffer.byteLength(
        JSON.stringify({
          dataRoot: herdsmanDataRoot(),
          replies: candidate,
          hasReplies: c.replies.length > 0,
        }),
        "utf8",
      ) +
        1 >
      PEER_TRANSPORT_FRAME_LIMIT_BYTES
    )
      break;
    batch.push(reply);
  }
  return batch;
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
  pollPeerReplies(
    id,
    capability,
    originSession,
    originGeneration,
    recipientSession,
    recipientGeneration,
  );
  mutate(id, (c) => {
    if (
      c.finalized ||
      !matchesCapability(c.capability, capability) ||
      c.originSession !== originSession ||
      c.originGeneration !== originGeneration ||
      c.recipientSession !== recipientSession ||
      c.recipientGeneration !== recipientGeneration
    )
      throw new Error("peer correspondence authorization failed");
    const reply = c.replies.find((item) => item.id === replyId);
    if (!reply) throw new Error("unknown peer reply");
    reply.acknowledged = true;
    reply.text = "";
    delete reply.attachments;
    delete reply.resultBindings;
  });
}
export function finalizePeerCorrespondence(
  id: string,
  capability: string,
  originSession: string,
  originGeneration: string,
  recipientSession: string,
  recipientGeneration: string,
): void {
  mutate(id, (c) => {
    if (
      !matchesCapability(c.capability, capability) ||
      c.originSession !== originSession ||
      c.originGeneration !== originGeneration ||
      c.recipientSession !== recipientSession ||
      c.recipientGeneration !== recipientGeneration
    )
      throw new Error("peer correspondence authorization failed");
    if (c.replies.some((reply) => !reply.acknowledged))
      throw new Error(
        "cannot finalize peer correspondence with pending replies",
      );
    if (c.finalized) return;
    c.capability = createHash("sha256")
      .update(Buffer.from(capability, "hex"))
      .digest("hex");
    c.replies = [];
    c.finalized = true;
  });
}
