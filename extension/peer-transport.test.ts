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
import { randomUUID } from "node:crypto";
import {
  acknowledgePeerReply,
  assertPeerDataRoot,
  createPeerCorrespondence,
  listPeerCorrespondences,
  pollPeerReplies,
  queuePeerReply,
  removePeerCorrespondence,
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
