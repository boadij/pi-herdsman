#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { nodeOnlyAgentDir, herdsmanDataRoot } from "../extension/storage.ts";
import {
  listPeerLeadRecords,
  peerRuntime,
  writeCoordinationMessage,
} from "../extension/supervision.ts";
import {
  persistPeerAttachment,
  persistPeerResultArtifact,
} from "../extension/storage.ts";
import {
  assertPeerDataRoot,
  acknowledgePeerReply,
  finalizePeerCorrespondence,
  listPeerCorrespondences,
  peerPayloadDigest,
  pollPeerReplies,
  storePeerCorrespondence,
  updatePeerOriginGeneration,
  type PeerCorrespondence,
} from "../extension/peer-correspondence.ts";

const action = process.argv[2];
if (
  !["probe", "accept", "poll", "ack", "finalize", "recover"].includes(action) ||
  process.argv.length !== 3
) {
  console.error(
    "usage: pi-herdsman-peer probe|accept|poll|ack|finalize|recover",
  );
  process.exit(2);
}

const agentDir = nodeOnlyAgentDir();
if (!isAbsolute(agentDir)) {
  console.error(
    "PI_CODING_AGENT_DIR must resolve to an absolute path for remote probing",
  );
  process.exit(1);
}

const runtime = peerRuntime();
if (action === "probe") {
  console.log(
    JSON.stringify({
      dataRoot: herdsmanDataRoot(),
      peers: listPeerLeadRecords(runtime),
    }),
  );
} else {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024)
      throw new Error("peer transfer exceeds the size limit");
    chunks.push(buffer);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    record?: Record<string, any>;
    recipientClaimId?: unknown;
    attachments?: Array<{
      name?: unknown;
      ref?: unknown;
      text?: unknown;
      sha256?: unknown;
    }>;
    correspondence?: PeerCorrespondence;
    id?: string;
    expectedDataRoot?: string;
    capability?: string;
    originSession?: string;
    originGeneration?: string;
    recipientSession?: string;
    recipientGeneration?: string;
    previousOriginGeneration?: string;
    replyId?: string;
  };
  if (action !== "accept") {
    const {
      id,
      capability,
      originSession,
      originGeneration,
      recipientSession,
      recipientGeneration,
      previousOriginGeneration,
    } = envelope;
    if (
      typeof id !== "string" ||
      typeof capability !== "string" ||
      typeof originSession !== "string" ||
      typeof originGeneration !== "string" ||
      typeof recipientSession !== "string" ||
      typeof recipientGeneration !== "string"
    )
      throw new Error("invalid peer correspondence request");
    assertPeerDataRoot(herdsmanDataRoot(), envelope.expectedDataRoot ?? "");
    if (
      !listPeerLeadRecords(runtime).some(
        (peer) =>
          peer.role === "manager" &&
          peer.piSessionId === recipientSession &&
          peer.claim.id === recipientGeneration,
      )
    )
      throw new Error("exact destination Manager is not live");
    if (action === "recover") {
      if (typeof previousOriginGeneration !== "string")
        throw new Error("invalid peer correspondence recovery");
      updatePeerOriginGeneration(
        id,
        capability,
        originSession,
        previousOriginGeneration,
        originGeneration,
      );
      console.log(JSON.stringify({ recovered: true, id }));
    } else if (action === "poll") {
      const replies = pollPeerReplies(
        id,
        capability,
        originSession,
        originGeneration,
        recipientSession,
        recipientGeneration,
      );
      console.log(
        JSON.stringify({
          dataRoot: herdsmanDataRoot(),
          replies,
          hasReplies:
            (listPeerCorrespondences().find((item) => item.id === id)?.replies
              .length ?? 0) > 0,
        }),
      );
    } else if (action === "ack") {
      if (typeof envelope.replyId !== "string")
        throw new Error("invalid reply acknowledgement");
      acknowledgePeerReply(
        id,
        capability,
        envelope.replyId,
        originSession,
        originGeneration,
        recipientSession,
        recipientGeneration,
      );
      console.log(
        JSON.stringify({ acknowledged: true, replyId: envelope.replyId }),
      );
    } else {
      finalizePeerCorrespondence(
        id,
        capability,
        originSession,
        originGeneration,
        recipientSession,
        recipientGeneration,
      );
      console.log(JSON.stringify({ finalized: true, id }));
    }
    process.exit(0);
  }
  const record = envelope.record;
  assertPeerDataRoot(herdsmanDataRoot(), envelope.expectedDataRoot ?? "");
  if (
    !record ||
    record.kind !== "peer_message" ||
    record.peerSource?.role !== "manager" ||
    typeof record.id !== "string" ||
    typeof record.fromSessionId !== "string" ||
    typeof record.toSessionId !== "string"
  )
    throw new Error("invalid peer transfer");
  if (!Array.isArray(envelope.attachments) || envelope.attachments.length > 32)
    throw new Error("invalid peer transfer evidence");
  if (
    !listPeerLeadRecords(runtime).some(
      (peer) =>
        peer.role === "manager" &&
        peer.piSessionId === record.toSessionId &&
        peer.claim.id === envelope.recipientClaimId,
    )
  )
    throw new Error("exact destination Manager is not live");
  const connection = process.env.SSH_CONNECTION;
  if (!connection)
    throw new Error("authenticated SSH connection identity is unavailable");
  if (
    !envelope.correspondence ||
    envelope.correspondence.recipientSession !== record.toSessionId ||
    envelope.correspondence.recipientGeneration !== envelope.recipientClaimId ||
    envelope.correspondence.originSession !== record.fromSessionId ||
    envelope.correspondence.originGeneration !== record.leaseId ||
    envelope.correspondence.acceptanceId !== record.id
  )
    throw new Error("peer correspondence does not match message route");
  const digest = peerPayloadDigest(envelope);
  const markerDir = join(runtime.root, "peer-acceptances");
  mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256")
    .update(`${record.fromSessionId}\0${record.id}`)
    .digest("hex");
  const marker = join(markerDir, `${key}.json`);
  try {
    const prior = JSON.parse(readFileSync(marker, "utf8")) as {
      digest?: unknown;
      status?: unknown;
    };
    if (prior.digest !== digest)
      throw new Error("conflicting peer message identity");
    if (prior.status === "accepted") {
      console.log(JSON.stringify({ accepted: true, id: record.id }));
      process.exit(0);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeFileSync(
      marker,
      `${JSON.stringify({ connection, digest, status: "pending" })}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
      },
    );
  }
  const receivedRefs: string[] = [];
  for (const attachment of envelope.attachments) {
    if (
      typeof attachment.name !== "string" ||
      typeof attachment.text !== "string" ||
      typeof attachment.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(attachment.sha256)
    )
      throw new Error("invalid peer attachment metadata");
    const contentDigest = createHash("sha256")
      .update(attachment.text, "utf8")
      .digest("hex");
    if (contentDigest !== attachment.sha256)
      throw new Error("peer attachment integrity check failed");
    const binding = record.resultBindings?.find(
      (item: { ref?: unknown }) => item.ref === attachment.ref,
    );
    const path = binding
      ? persistPeerResultArtifact(binding.canonicalRef, attachment.text)
      : persistPeerAttachment(attachment.name, attachment.text);
    receivedRefs.push(`${attachment.name}: ${binding ? binding.ref : path}`);
  }
  const acceptedRecord = {
    ...record,
    ...(receivedRefs.length
      ? {
          text: `${record.text}\n\nForwardable received files:\n${receivedRefs.join("\n")}`,
        }
      : {}),
  };
  storePeerCorrespondence(envelope.correspondence);
  writeCoordinationMessage(acceptedRecord as never, runtime);
  const markerTemp = `${marker}.${randomUUID()}.tmp`;
  writeFileSync(
    markerTemp,
    `${JSON.stringify({ connection, digest, status: "accepted" })}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    },
  );
  renameSync(markerTemp, marker);
  console.log(JSON.stringify({ accepted: true, id: record.id }));
}
