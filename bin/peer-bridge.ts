#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nodeOnlyAgentDir, herdsmanDataRoot } from "../extension/storage.ts";
import {
  listPeerLeadRecords,
  peerRuntime,
  chiefMessagePath,
  coordinationMessageDigest,
  hasPeerDeliveryReceipt,
  readCoordinationMessage,
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
  updatePeerRecipientGeneration,
  type PeerCorrespondence,
} from "../extension/peer-correspondence.ts";
import { PEER_TRANSPORT_FRAME_LIMIT_BYTES } from "../extension/peer-transport.ts";
import {
  afterDurablePeerAcceptanceStep,
  afterPendingMarkerTempWriteForTests,
  beforePendingMarkerPublishForTests,
  pendingMarkerWriteLimitForTests,
  afterAcceptedMarkerTempWriteForTests,
} from "./peer-bridge-fault-seam.ts";

let action = process.argv[2];
if (
  ![
    "probe",
    "accept",
    "poll",
    "ack",
    "finalize",
    "recover",
    "recover-recipient",
    "status",
  ].includes(action) ||
  process.argv.length !== 3
) {
  console.error(
    "usage: pi-herdsman-peer probe|accept|status|poll|ack|finalize|recover|recover-recipient",
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
let recoveringStatus = false;
const syncDirectory = (directory: string): void => {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
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
    if (bytes > PEER_TRANSPORT_FRAME_LIMIT_BYTES)
      throw new Error("peer transfer exceeds the size limit");
    chunks.push(buffer);
  }
  let envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    record?: Record<string, any>;
    recipientClaimId?: unknown;
    attachments?: Array<{
      name?: unknown;
      ref?: unknown;
      marker?: unknown;
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
    newRecipientGeneration?: string;
    replyId?: string;
    digest?: string;
  };
  if (action === "status") {
    const { id, originSession, recipientSession, digest, expectedDataRoot } =
      envelope;
    assertPeerDataRoot(herdsmanDataRoot(), expectedDataRoot ?? "");
    if (
      !process.env.SSH_CONNECTION ||
      typeof id !== "string" ||
      typeof originSession !== "string" ||
      typeof recipientSession !== "string" ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(digest)
    )
      throw new Error("invalid peer acceptance status request");
    const key = createHash("sha256")
      .update(`${originSession}\0${id}`)
      .digest("hex");
    const marker = join(runtime.root, "peer-acceptances", `${key}.json`);
    try {
      const prior = JSON.parse(readFileSync(marker, "utf8")) as {
        digest?: unknown;
        status?: unknown;
        recipientSession?: unknown;
        transfer?: typeof envelope;
      };
      const status =
        prior.digest !== digest || prior.recipientSession !== recipientSession
          ? "conflict"
          : prior.status === "accepted"
            ? "accepted"
            : prior.status === "pending"
              ? "pending"
              : "conflict";
      if (status === "pending" && prior.transfer) {
        envelope = prior.transfer;
        action = "accept";
        recoveringStatus = true;
      } else {
        console.log(
          JSON.stringify({ dataRoot: herdsmanDataRoot(), id, digest, status }),
        );
        process.exit(0);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      console.log(
        JSON.stringify({
          dataRoot: herdsmanDataRoot(),
          id,
          digest,
          status: "absent",
        }),
      );
    }
    if (action === "status") process.exit(0);
  }
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
    const liveRecipientGeneration =
      action === "recover-recipient"
        ? envelope.newRecipientGeneration
        : recipientGeneration;
    if (
      !listPeerLeadRecords(runtime).some(
        (peer) =>
          peer.role === "manager" &&
          peer.piSessionId === recipientSession &&
          peer.claim.id === liveRecipientGeneration,
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
    } else if (action === "recover-recipient") {
      if (typeof envelope.newRecipientGeneration !== "string")
        throw new Error("invalid peer recipient recovery");
      updatePeerRecipientGeneration(
        id,
        capability,
        recipientSession,
        recipientGeneration,
        envelope.newRecipientGeneration,
      );
      console.log(JSON.stringify({ recovered: true, id }));
    } else if (action === "poll") {
      let replies: ReturnType<typeof pollPeerReplies>;
      try {
        replies = pollPeerReplies(
          id,
          capability,
          originSession,
          originGeneration,
          recipientSession,
          recipientGeneration,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            action: "poll",
            correspondenceId: id,
            originSession,
            originGeneration,
            recipientSession,
            recipientGeneration,
            expectedDataRoot: envelope.expectedDataRoot,
            error: detail,
          }),
        );
        process.exit(1);
      }
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
  const connection = process.env.SSH_CONNECTION;
  if (!connection)
    throw new Error("authenticated SSH connection identity is unavailable");
  if (
    !envelope.correspondence ||
    envelope.correspondence.recipientSession !== record.toSessionId ||
    envelope.correspondence.recipientGeneration !== envelope.recipientClaimId ||
    envelope.correspondence.originSession !== record.fromSessionId ||
    envelope.correspondence.originGeneration !== record.leaseId
  )
    throw new Error("peer correspondence does not match message route");
  const digest = peerPayloadDigest({
    record,
    attachments: envelope.attachments,
  });
  const markerDir = join(runtime.root, "peer-acceptances");
  mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  syncDirectory(runtime.root);
  const key = createHash("sha256")
    .update(`${record.fromSessionId}\0${record.id}`)
    .digest("hex");
  const marker = join(markerDir, `${key}.json`);
  let acceptedRace = false;
  try {
    const prior = JSON.parse(readFileSync(marker, "utf8")) as {
      digest?: unknown;
      status?: unknown;
      recipientSession?: unknown;
      transfer?: typeof envelope;
    };
    if (
      prior.digest !== digest ||
      prior.recipientSession !== record.toSessionId
    )
      throw new Error("conflicting peer message identity");
    if (prior.status === "accepted") {
      console.log(JSON.stringify({ accepted: true, id: record.id }));
      process.exit(0);
    }
    if (prior.status !== "pending" || !prior.transfer)
      throw new Error("invalid pending peer message acceptance");
    if (
      prior.transfer.record?.id !== record.id ||
      prior.transfer.record?.fromSessionId !== record.fromSessionId ||
      prior.transfer.record?.toSessionId !== record.toSessionId ||
      peerPayloadDigest({
        record: prior.transfer.record,
        attachments: prior.transfer.attachments ?? [],
      }) !== prior.digest
    )
      throw new Error("invalid pending peer message transfer");
    envelope = prior.transfer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (
      !listPeerLeadRecords(runtime).some(
        (peer) =>
          peer.role === "manager" &&
          peer.piSessionId === record.toSessionId &&
          peer.claim.id === envelope.recipientClaimId,
      )
    )
      throw new Error("exact destination Manager is not live");
    const content = `${JSON.stringify({ connection, digest, status: "pending", recipientSession: record.toSessionId, transfer: envelope })}\n`;
    const temp = `${marker}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      const bytes = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const requested = bytes.length - offset;
        const length = pendingMarkerWriteLimitForTests(requested);
        if (!Number.isInteger(length) || length <= 0 || length > requested)
          throw new Error("invalid pending peer acceptance write length");
        const written = writeSync(fd, bytes, offset, length);
        if (
          !Number.isInteger(written) ||
          written <= 0 ||
          written > bytes.length - offset
        )
          throw new Error(
            "unable to write complete pending peer acceptance marker",
          );
        offset += written;
        afterPendingMarkerTempWriteForTests();
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      beforePendingMarkerPublishForTests(marker, content);
      let alreadyExists = false;
      try {
        linkSync(temp, marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        alreadyExists = true;
      }
      syncDirectory(markerDir);
      if (alreadyExists) {
        const prior = JSON.parse(readFileSync(marker, "utf8")) as {
          digest?: unknown;
          recipientSession?: unknown;
          status?: unknown;
          transfer?: typeof envelope;
        };
        if (
          prior.digest !== digest ||
          prior.recipientSession !== record.toSessionId
        )
          throw new Error("conflicting peer message identity");
        if (prior.status === "accepted") acceptedRace = true;
        else if (
          prior.status !== "pending" ||
          !prior.transfer ||
          prior.transfer.record?.id !== record.id ||
          prior.transfer.record?.fromSessionId !== record.fromSessionId ||
          prior.transfer.record?.toSessionId !== record.toSessionId ||
          peerPayloadDigest({
            record: prior.transfer.record,
            attachments: prior.transfer.attachments ?? [],
          }) !== prior.digest
        )
          throw new Error("invalid pending peer message acceptance");
        else envelope = prior.transfer;
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
    if (!acceptedRace) afterDurablePeerAcceptanceStep("pending-marker-durable");
  }
  acceptTransfer: {
    if (acceptedRace) {
      console.log(JSON.stringify({ accepted: true, id: record.id }));
      break acceptTransfer;
    }
    if (
      !envelope.correspondence ||
      envelope.correspondence.recipientSession !== record.toSessionId ||
      envelope.correspondence.recipientGeneration !==
        envelope.recipientClaimId ||
      envelope.correspondence.originSession !== record.fromSessionId ||
      envelope.correspondence.originGeneration !== record.leaseId
    )
      throw new Error("peer correspondence does not match message route");
    const receivedRefs: string[] = [];
    let receivedText = record.text as string;
    for (const attachment of envelope.attachments) {
      if (
        typeof attachment.name !== "string" ||
        typeof attachment.marker !== "string" ||
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
      const markerIndex = receivedText.indexOf(attachment.marker);
      if (
        markerIndex < 0 ||
        receivedText.indexOf(attachment.marker, markerIndex + 1) !== -1
      )
        throw new Error("peer attachment marker is missing or ambiguous");
      receivedText =
        receivedText.slice(0, markerIndex) +
        attachment.text +
        receivedText.slice(markerIndex + attachment.marker.length);
      const binding = record.resultBindings?.find(
        (item: { ref?: unknown }) => item.ref === attachment.ref,
      );
      const path = binding
        ? persistPeerResultArtifact(binding.canonicalRef, attachment.text)
        : persistPeerAttachment(attachment.name, attachment.text);
      receivedRefs.push(
        `${attachment.name}: ${binding ? `${binding.ref} (canonical ${binding.canonicalRef})` : path}`,
      );
    }
    const acceptedRecord = {
      ...record,
      ...(receivedRefs.length
        ? {
            text: `${receivedText}\n\nForwardable received files:\n${receivedRefs.join("\n")}`,
          }
        : { text: receivedText }),
    };
    const accepted = acceptedRecord as never;
    let published = false;
    try {
      const existing = readCoordinationMessage(
        chiefMessagePath(runtime, record.toSessionId, record.id),
      );
      if (!isDeepStrictEqual(existing, accepted))
        throw new Error("conflicting peer inbox message identity");
      published = true;
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT")
        throw error;
    }
    const acceptedDigest = coordinationMessageDigest(accepted);
    if (
      !published &&
      hasPeerDeliveryReceipt(
        runtime,
        record.toSessionId,
        record.id,
        acceptedDigest,
      )
    )
      published = true;
    if (!published) {
      const liveRecipient = listPeerLeadRecords(runtime).find(
        (peer) =>
          peer.role === "manager" && peer.piSessionId === record.toSessionId,
      );
      if (!liveRecipient)
        throw new Error("exact destination Manager is not live");
      if (liveRecipient.claim.id !== envelope.recipientClaimId) {
        envelope = {
          ...envelope,
          recipientClaimId: liveRecipient.claim.id,
          correspondence: {
            ...envelope.correspondence,
            recipientGeneration: liveRecipient.claim.id,
          },
        };
        const pendingTemp = `${marker}.${randomUUID()}.tmp`;
        try {
          writeFileSync(
            pendingTemp,
            `${JSON.stringify({ connection, digest, status: "pending", recipientSession: record.toSessionId, transfer: envelope })}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600, flush: true },
          );
          renameSync(pendingTemp, marker);
        } finally {
          rmSync(pendingTemp, { force: true });
        }
        syncDirectory(markerDir);
      }
    }
    storePeerCorrespondence(envelope.correspondence);
    if (!published) {
      if (
        !hasPeerDeliveryReceipt(
          runtime,
          record.toSessionId,
          record.id,
          acceptedDigest,
        )
      )
        writeCoordinationMessage(accepted, runtime);
      if (!published)
        afterDurablePeerAcceptanceStep("inbox-publication-durable");
    }
    const markerTemp = `${marker}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        markerTemp,
        `${JSON.stringify({ connection, digest, status: "accepted", recipientSession: record.toSessionId })}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
          flush: true,
        },
      );
      afterAcceptedMarkerTempWriteForTests(markerTemp, marker);
      renameSync(markerTemp, marker);
    } finally {
      rmSync(markerTemp, { force: true });
    }
    syncDirectory(markerDir);
    console.log(
      JSON.stringify(
        recoveringStatus
          ? {
              dataRoot: herdsmanDataRoot(),
              id: record.id,
              digest,
              status: "accepted",
            }
          : { accepted: true, id: record.id },
      ),
    );
  }
}
