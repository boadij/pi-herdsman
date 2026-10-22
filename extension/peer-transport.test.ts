import assert from "node:assert/strict";
import test from "node:test";
import {
  listRemotePeerOutbounds,
  parsePeerSshTarget,
  peerRecoveryRequest,
  persistRemotePeerOutbound,
  removeRemotePeerOutbound,
  tryPollPeerReplies,
} from "./peer-transport.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  acknowledgePeerReply,
  assertPeerDataRoot,
  createPeerCorrespondence,
  listPeerCorrespondences,
  pollPeerReplies,
  peerPayloadDigest,
  queuePeerReply,
  resolvePeerResultBindings,
  removePeerCorrespondence,
  updatePeerRecipientGeneration,
} from "./peer-correspondence.ts";

test("saved SSH targets preserve URI ports and SSH config aliases", () => {
  assert.deepEqual(parsePeerSshTarget("ssh://buildbox:2222"), {
    host: "buildbox",
    port: "2222",
  });
  assert.deepEqual(parsePeerSshTarget("ssh://user@buildbox:2222"), {
    host: "user@buildbox",
    port: "2222",
  });
  assert.deepEqual(parsePeerSshTarget("herdsman@buildbox"), {
    host: "herdsman@buildbox",
  });
  assert.deepEqual(parsePeerSshTarget("buildbox"), { host: "buildbox" });
});

test("remote peer outbox survives until acknowledged delivery", () => {
  const id = randomUUID();
  const outbound = {
    id,
    machine: {
      id: "test-machine",
      label: "test-machine",
      target: "ssh://test-machine:2222",
      reachable: true,
    },
    dataRoot: "/test/agent/pi-herdsman",
    session: randomUUID(),
    claimId: randomUUID(),
    envelope: JSON.stringify({ record: { id } }),
  };
  persistRemotePeerOutbound(outbound);
  assert.deepEqual(
    listRemotePeerOutbounds().find((item) => item.id === id),
    outbound,
  );
  removeRemotePeerOutbound(id);
  assert.equal(
    listRemotePeerOutbounds().some((item) => item.id === id),
    false,
  );
});

test("saved SSH targets reject URI paths and option-shaped aliases", () => {
  for (const target of [
    "ssh://buildbox/path",
    "ssh://buildbox?option=value",
    "ssh://buildbox#fragment",
    "ssh://user%20name@buildbox",
    "ssh://-oProxyCommand=evil@buildbox",
    "ssh://%2DoProxyCommand%3Devil@buildbox",
    "-oProxyCommand=evil",
    "buildbox with args",
  ])
    assert.throws(
      () => parsePeerSshTarget(target),
      /Unsupported saved SSH target/,
    );
});

test("peer recovery carries the verified endpoint root and rejects mismatches", () => {
  const expectedDataRoot = "/test/agent/pi-herdsman";
  const request = JSON.parse(
    peerRecoveryRequest(
      {
        id: randomUUID(),
        capability: "a".repeat(64),
        originSession: randomUUID(),
        originGeneration: randomUUID(),
        previousOriginGeneration: randomUUID(),
        recipientSession: randomUUID(),
        recipientGeneration: randomUUID(),
      },
      expectedDataRoot,
    ),
  );
  assert.equal(request.expectedDataRoot, expectedDataRoot);
  assert.doesNotThrow(() =>
    assertPeerDataRoot(expectedDataRoot, request.expectedDataRoot),
  );
  assert.throws(
    () => assertPeerDataRoot("/different/root", request.expectedDataRoot),
    /data root/,
  );
});

test("failed reply polls retain correspondence for a later exactly-once reply", async () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const actions: string[] = [];
  assert.equal(
    await tryPollPeerReplies(async () => {
      actions.push("poll");
      throw new Error("transient endpoint failure");
    }),
    undefined,
  );
  assert.deepEqual(actions, ["poll"]);
  assert.equal(
    listPeerCorrespondences().find((item) => item.id === c.id)?.finalized,
    undefined,
  );

  const replyId = randomUUID();
  assert.equal(queuePeerReply(c, replyId, "reply after the outage"), "queued");
  const laterPoll = await tryPollPeerReplies(async () => {
    actions.push("poll");
    return JSON.stringify(
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    );
  });
  const replies = JSON.parse(laterPoll!) as Array<{ id: string; text: string }>;
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.id, replyId);
  assert.equal(replies[0]?.text, "reply after the outage");
  actions.push("ack");
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
  assert.deepEqual(actions, ["poll", "poll", "ack"]);
  removePeerCorrespondence(c.id);
});

test("one Manager-pair route supports multiple requests and progress/final replies", () => {
  const originSession = randomUUID();
  const recipientSession = randomUUID();
  const c = createPeerCorrespondence({
    originSession,
    originGeneration: randomUUID(),
    recipientSession,
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const secondRequestId = randomUUID();
  assert.notEqual(c.acceptanceId, secondRequestId);
  const progressId = randomUUID();
  const completionId = randomUUID();
  assert.equal(queuePeerReply(c, progressId, "progress"), "queued");
  acknowledgePeerReply(
    c.id,
    c.capability,
    progressId,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.equal(
    queuePeerReply(
      listPeerCorrespondences().find((item) => item.id === c.id)!,
      completionId,
      "complete",
    ),
    "queued",
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ).map((reply) => reply.id),
    [completionId],
  );
  assert.equal(
    listPeerCorrespondences().find((item) => item.id === c.id)?.finalized,
    undefined,
  );
  removePeerCorrespondence(c.id);
});

test("replies retain portable attachments and semantic result bindings", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const text = "reply body with a marker";
  const fileText = "portable reply artifact";
  const evidence = {
    attachments: [
      {
        name: "result:researcher#1",
        ref: "result:researcher#1",
        marker: "pi-herdsman-peer-test-marker",
        text: fileText,
        sha256: createHash("sha256").update(fileText).digest("hex"),
      },
    ],
    resultBindings: [
      {
        ref: "result:researcher#1",
        canonicalRef: `result:${randomUUID()}`,
      },
    ],
  };
  const replyId = randomUUID();
  assert.equal(queuePeerReply(c, replyId, text, evidence), "queued");
  const [reply] = pollPeerReplies(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.equal(reply?.text, text);
  assert.deepEqual(reply?.attachments, evidence.attachments);
  assert.deepEqual(reply?.resultBindings, evidence.resultBindings);
  assert.equal(reply?.digest, peerPayloadDigest({ text, ...evidence }));
  removePeerCorrespondence(c.id);
});

test("recipient generation recovers only for the exact same session and route", () => {
  const recipientSession = randomUUID();
  const oldGeneration = randomUUID();
  const nextGeneration = randomUUID();
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession,
    recipientGeneration: oldGeneration,
    acceptanceId: randomUUID(),
  });
  updatePeerRecipientGeneration(
    c.id,
    c.capability,
    recipientSession,
    oldGeneration,
    nextGeneration,
  );
  assert.equal(
    listPeerCorrespondences().find((item) => item.id === c.id)
      ?.recipientGeneration,
    nextGeneration,
  );
  assert.throws(
    () =>
      updatePeerRecipientGeneration(
        c.id,
        c.capability,
        randomUUID(),
        nextGeneration,
        randomUUID(),
      ),
    /recipient recovery rejected/,
  );
  removePeerCorrespondence(c.id);
});

test("semantic collisions retain a canonical fallback instead of importing a misbinding", () => {
  const conflicting = {
    ref: "result:researcher#1",
    canonicalRef: `result:${randomUUID()}`,
  };
  const unambiguous = {
    ref: "result:researcher#2",
    canonicalRef: `result:${randomUUID()}`,
  };
  const resolution = resolvePeerResultBindings(
    [conflicting, unambiguous],
    (ref) => new Set(ref === conflicting.ref ? [`result:${randomUUID()}`] : []),
  );
  assert.deepEqual(resolution.bindings, [unambiguous]);
  assert.deepEqual(resolution.conflicts, [conflicting]);
  assert.match(conflicting.canonicalRef, /^result:[0-9a-f-]{36}$/u);
});
