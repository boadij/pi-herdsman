#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const action = process.argv[2];
if ((action !== "probe" && action !== "accept") || process.argv.length !== 3) {
  console.error("usage: pi-herdsman-peer probe|accept");
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
  };
  const record = envelope.record;
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
  const digest = createHash("sha256")
    .update(JSON.stringify(envelope))
    .digest("hex");
  const markerDir = join(runtime.root, "peer-acceptances");
  mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256")
    .update(`${record.fromSessionId}\0${record.id}`)
    .digest("hex");
  const marker = join(markerDir, `${key}.json`);
  try {
    const prior = JSON.parse(readFileSync(marker, "utf8")) as {
      digest?: unknown;
    };
    if (prior.digest !== digest)
      throw new Error("conflicting peer message identity");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeFileSync(marker, `${JSON.stringify({ connection, digest })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
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
  writeCoordinationMessage(acceptedRecord as never, runtime);
  console.log(JSON.stringify({ accepted: true, id: record.id }));
}
