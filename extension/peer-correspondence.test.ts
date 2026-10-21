import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  acknowledgePeerReply,
  assertPeerDataRoot,
  createPeerCorrespondence,
  finalizePeerCorrespondence,
  listPeerCorrespondences,
  pollPeerReplies,
  peerPayloadDigest,
  queuePeerReply,
  removePeerCorrespondence,
  updatePeerOriginGeneration,
} from "./peer-correspondence.ts";

test("peer correspondence isolates capability, exact sessions and generations, and finalizes only acknowledged replies", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.equal(c.capability.length, 64);
  assert.equal(
    listPeerCorrespondences().some((item) => item.id === c.id),
    true,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        "0".repeat(64),
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        randomUUID(),
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        randomUUID(),
      ),
    /authorization/,
  );
  const replyId = randomUUID();
  assert.equal(queuePeerReply(c, replyId, "answer"), "queued");
  const recovered = listPeerCorrespondences().find((item) => item.id === c.id)!;
  assert.equal(queuePeerReply(recovered, replyId, "answer"), "duplicate");
  assert.throws(() => queuePeerReply(c, replyId, "changed"), /conflicting/);
  assert.throws(
    () =>
      finalizePeerCorrespondence(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /pending replies/,
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ).map((item) => item.text),
    ["answer"],
  );
  acknowledgePeerReply(
    c.id,
    c.capability,
    replyId,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  acknowledgePeerReply(
    c.id,
    c.capability,
    replyId,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ),
    [],
  );
  finalizePeerCorrespondence(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  finalizePeerCorrespondence(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.equal(
    listPeerCorrespondences().find((item) => item.id === c.id)?.finalized,
    true,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
});

test("same exact session may explicitly recover a changed generation, but mismatched generations cannot poll", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        randomUUID(),
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        randomUUID(),
      ),
    /authorization/,
  );
  const recovered = updatePeerOriginGeneration(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    randomUUID(),
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        "wrong-generation",
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.equal(recovered.originSession, c.originSession);
  removePeerCorrespondence(c.id);
});

test("peer endpoint state-root mismatch fails closed", () => {
  assert.doesNotThrow(() => assertPeerDataRoot("/same/root", "/same/root"));
  assert.throws(
    () => assertPeerDataRoot("/manager/root", "/endpoint/root"),
    /data root/,
  );
});

test("peer payload digests canonicalize object key order", () => {
  assert.equal(
    peerPayloadDigest({ a: 1, nested: { x: "v", y: true } }),
    peerPayloadDigest({ nested: { y: true, x: "v" }, a: 1 }),
  );
  assert.notEqual(peerPayloadDigest({ a: 1 }), peerPayloadDigest({ a: 2 }));
});
