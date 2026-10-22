import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { PEER_TRANSPORT_FRAME_LIMIT_BYTES } from "./peer-transport.ts";
import { herdsmanDataRoot } from "./storage.ts";
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
  assert.deepEqual(
    updatePeerOriginGeneration(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      recovered.originGeneration,
    ),
    recovered,
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      recovered.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ),
    [],
  );
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        c.capability,
        randomUUID(),
        c.originGeneration,
        recovered.originGeneration,
      ),
    /rejected/,
  );
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        c.capability,
        c.originSession,
        randomUUID(),
        randomUUID(),
      ),
    /rejected/,
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
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        "0".repeat(64),
        c.originSession,
        recovered.originGeneration,
        randomUUID(),
      ),
    /rejected/,
  );
  finalizePeerCorrespondence(
    c.id,
    c.capability,
    c.originSession,
    recovered.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        c.capability,
        c.originSession,
        recovered.originGeneration,
        randomUUID(),
      ),
    /rejected/,
  );
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

test("acknowledgment compacts evidence while preserving reply duplicate protection", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const payloads = Array.from({ length: 2 }, (_, index) => {
    const text = `reply ${index}`;
    const attachmentText = `evidence ${index}`;
    const attachments = [
      {
        name: `evidence-${index}.txt`,
        marker: `marker-${index}`,
        text: attachmentText,
        sha256: createHash("sha256").update(attachmentText).digest("hex"),
      },
    ];
    const resultBindings = [
      {
        ref: `result:reviewer#${index + 1}`,
        canonicalRef: `result:${randomUUID()}`,
      },
    ];
    return { id: randomUUID(), text, attachments, resultBindings };
  });
  for (const payload of payloads)
    queuePeerReply(c, payload.id, payload.text, payload);
  const digests = payloads.map((payload) =>
    peerPayloadDigest({
      text: payload.text,
      attachments: payload.attachments,
      resultBindings: payload.resultBindings,
    }),
  );
  for (const payload of payloads)
    acknowledgePeerReply(
      c.id,
      c.capability,
      payload.id,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    );

  const compacted = listPeerCorrespondences().find((item) => item.id === c.id)!;
  assert.deepEqual(
    compacted.replies.map(
      ({ id, digest, text, acknowledged, attachments, resultBindings }) => ({
        id,
        digest,
        text,
        acknowledged,
        attachments,
        resultBindings,
      }),
    ),
    payloads.map((payload, index) => ({
      id: payload.id,
      digest: digests[index],
      text: "",
      acknowledged: true,
      attachments: undefined,
      resultBindings: undefined,
    })),
  );
  for (const payload of payloads) {
    assert.equal(
      queuePeerReply(compacted, payload.id, payload.text, payload),
      "duplicate",
    );
    assert.throws(
      () =>
        queuePeerReply(
          compacted,
          payload.id,
          `${payload.text} changed`,
          payload,
        ),
      /conflicting peer reply identity/,
    );
  }
  removePeerCorrespondence(c.id);
});

test("reply polling bounds full serialized envelopes and drains replies in order", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.throws(
    () =>
      queuePeerReply(
        c,
        randomUUID(),
        "x".repeat(PEER_TRANSPORT_FRAME_LIMIT_BYTES - 100),
      ),
    /response limit/,
  );
  const ids = Array.from({ length: 20 }, () => randomUUID());
  for (const id of ids) queuePeerReply(c, id, '"'.repeat(120 * 1024));
  let drained: string[] = [];
  while (drained.length < ids.length) {
    const batch = pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    );
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          dataRoot: herdsmanDataRoot(),
          replies: batch,
          hasReplies: true,
        }),
      ) <=
        2 * 1024 * 1024,
    );
    assert.ok(batch.length > 0);
    for (const reply of batch) {
      drained.push(reply.id);
      acknowledgePeerReply(
        c.id,
        c.capability,
        reply.id,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      );
    }
  }
  assert.deepEqual(drained, ids);
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
  removePeerCorrespondence(c.id);
});

test("independent processes preserve concurrent reply acknowledgment and enqueue", async () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const acknowledgedId = randomUUID();
  const queuedId = randomUUID();
  queuePeerReply(c, acknowledgedId, "existing");
  const args = JSON.stringify([
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  ]);
  const scripts = [
    `const [{acknowledgePeerReply}, ...a] = [await import('./extension/peer-correspondence.ts')]; const [id,cap,os,og,rs,rg] = ${args}; acknowledgePeerReply(id,cap,${JSON.stringify(acknowledgedId)},os,og,rs,rg);`,
    `const {queuePeerReply} = await import('./extension/peer-correspondence.ts'); const [id] = ${args}; queuePeerReply({id},${JSON.stringify(queuedId)},'concurrent');`,
  ];
  const run = (source: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        { stdio: "ignore", env: process.env },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`mutation worker exited ${code}`)),
      );
    });
  await Promise.all(scripts.map(run));
  const current = listPeerCorrespondences().find((item) => item.id === c.id)!;
  assert.equal(
    current.replies.find((reply) => reply.id === acknowledgedId)?.acknowledged,
    true,
  );
  assert.equal(
    current.replies.find((reply) => reply.id === queuedId)?.text,
    "concurrent",
  );
  removePeerCorrespondence(c.id);
});
