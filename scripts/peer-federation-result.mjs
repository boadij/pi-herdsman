const MAX_EVIDENCE_LENGTH = 500;

function isBoundedId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128
  );
}

export function ordinaryLeadDeliveryReady(entries, messageId, inbox) {
  return (
    !inbox.trim() &&
    entries.filter(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-herdsman-peer_message" &&
        entry.details?.id === messageId,
    ).length === 1
  );
}

export function currentSendDiagnostics(calls, results, resultCounts, receipt) {
  const callIds = [...calls.keys()];
  const callId = callIds.length === 1 ? callIds[0] : undefined;
  const resultCount = callId ? (resultCounts.get(callId) ?? 0) : 0;
  const result = resultCount === 1 ? results.get(callId) : undefined;
  let outcome = "unknown";
  if (callId && resultCount === 0) outcome = "pending";
  else if (result) outcome = result.isError === true ? "error" : "success";
  const text = (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const authorizationReason =
    outcome === "error"
      ? (text.match(
          /\[(sender_unavailable|sender_role_changed|route_role_mismatch|route_ambiguous|no_authorized_target)\]/,
        )?.[1] ?? "unknown")
      : "unknown";
  const resultReceipt = result?.details;
  const durableQueueReceipt = Boolean(
    resultReceipt?.queued === true &&
    isBoundedId(resultReceipt.id) &&
    isBoundedId(receipt?.id) &&
    receipt.id === resultReceipt.id,
  );
  return {
    messagePeerOutcome: outcome,
    authorizationReason,
    durableQueueReceipt,
  };
}

export function assertOrdinaryLeadSendAcceptance(diagnostics) {
  const failed = [
    diagnostics.freshListPeersCalls !== 1 && "freshListPeersCalls",
    diagnostics.freshDiscoveryMatched !== true && "freshDiscoveryMatched",
    diagnostics.messagePeerCalls !== 1 && "messagePeerCalls",
    diagnostics.messagePeerOutcome !== "success" && "messagePeerOutcome",
    diagnostics.durableQueueReceipt !== true && "durableQueueReceipt",
  ].filter(Boolean);
  if (failed.length)
    throw new Error(
      `A ordinary Lead send phase failed exact correlated acceptance checks: ${failed.join(", ")}`,
    );
}

export function currentSendDiscoveryMatched(
  calls,
  results,
  resultCounts,
  peerTarget,
) {
  if (calls.size !== 1) return false;
  const [callId] = calls.keys();
  const result = results.get(callId);
  return (
    resultCounts.get(callId) === 1 &&
    (result?.details?.expectedPeerMatched === true ||
      result?.details?.peers?.some((peer) => peer.target === peerTarget) ===
        true)
  );
}

export function classifyCurrentSendEvidence(evidence, peerSession, receipt) {
  const boundedResults = (results, validate) =>
    Array.isArray(results) &&
    results.length <= 64 &&
    results.every(
      (result) =>
        isBoundedId(result?.toolCallId) &&
        Number.isSafeInteger(result.resultCount) &&
        result.resultCount >= 0 &&
        validate(result),
    );
  if (
    !evidence ||
    !Array.isArray(evidence.freshListCallIds) ||
    evidence.freshListCallIds.length > 64 ||
    !evidence.freshListCallIds.every(isBoundedId) ||
    !Array.isArray(evidence.freshListResults) ||
    !boundedResults(
      evidence.freshListResults,
      (result) => typeof result.expectedPeerMatched === "boolean",
    ) ||
    !Array.isArray(evidence.sendCallIds) ||
    evidence.sendCallIds.length > 64 ||
    !evidence.sendCallIds.every(isBoundedId) ||
    !boundedResults(
      evidence.sendResults,
      (result) =>
        typeof result.isError === "boolean" &&
        typeof result.queued === "boolean" &&
        (result.reasonCode === undefined ||
          [
            "sender_unavailable",
            "sender_role_changed",
            "route_role_mismatch",
            "route_ambiguous",
            "no_authorized_target",
          ].includes(result.reasonCode)) &&
        (result.receiptId === undefined || isBoundedId(result.receiptId)),
    ) ||
    !Number.isSafeInteger(evidence.freshListPeersCalls) ||
    !Number.isSafeInteger(evidence.messagePeerCalls) ||
    Buffer.byteLength(JSON.stringify(evidence), "utf8") > 16384
  )
    return {
      freshListPeersCalls: 0,
      freshDiscoveryMatched: false,
      messagePeerCalls: 0,
      messagePeerOutcome: "unknown",
      authorizationReason: "unknown",
      durableQueueReceipt: false,
    };

  const listCalls = new Map(evidence.freshListCallIds.map((id) => [id, {}]));
  const listResults = new Map();
  const listResultCounts = new Map();
  for (const result of evidence.freshListResults) {
    listResults.set(result.toolCallId, {
      details: { expectedPeerMatched: result.expectedPeerMatched === true },
    });
    listResultCounts.set(result.toolCallId, result.resultCount);
  }

  const sendCalls = new Map(evidence.sendCallIds.map((id) => [id, {}]));
  const sendResults = new Map();
  const sendResultCounts = new Map();
  for (const result of evidence.sendResults) {
    sendResults.set(result.toolCallId, {
      isError: result.isError,
      content: result.reasonCode
        ? [{ type: "text", text: `[${result.reasonCode}]` }]
        : [],
      details: { queued: result.queued, id: result.receiptId },
    });
    sendResultCounts.set(result.toolCallId, result.resultCount);
  }

  return {
    freshListPeersCalls: evidence.freshListPeersCalls,
    freshDiscoveryMatched:
      evidence.freshListPeersCalls === 1 &&
      currentSendDiscoveryMatched(
        listCalls,
        listResults,
        listResultCounts,
        peerSession,
      ),
    messagePeerCalls: evidence.messagePeerCalls,
    ...currentSendDiagnostics(
      sendCalls,
      sendResults,
      sendResultCounts,
      receipt,
    ),
  };
}

export function isLiveCorrespondenceRecipient(probe, correspondence) {
  const role = correspondence.role ?? "manager";
  return (
    (role === "manager" ||
      (role === "lead" && probe.ordinaryLeadsComplete === true)) &&
    probe.peers.some(
      (peer) =>
        peer.role === role &&
        (role !== "lead" || peer.sessionKind === "ordinary") &&
        peer.piSessionId === correspondence.recipientSession &&
        peer.claim?.id === correspondence.recipientGeneration,
    )
  );
}

function sanitize(value) {
  return String(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "[session-id]")
    .replace(/(?:\/[^\s"'<>]+)+/gu, "[path]")
    .replace(
      /\b(token|password|secret|credential|private[_ -]?key|api[_ -]?key)\s*"?\s*[:=]\s*"?[^"\s,;}]+/giu,
      "$1=[redacted]",
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .slice(0, MAX_EVIDENCE_LENGTH);
}

export function matchedDelegateResult(entries) {
  const calls = entries
    .filter(
      (entry) =>
        entry.type === "message" && entry.message?.role === "assistant",
    )
    .flatMap((entry) => entry.message.content ?? [])
    .filter(
      (part) =>
        part.type === "toolCall" &&
        part.name === "delegate_work" &&
        typeof part.id === "string",
    );
  if (calls.length !== 1)
    throw new Error(
      "Manager omitted or duplicated exact delegate_work tool call",
    );
  const [call] = calls;
  const results = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "delegate_work" &&
      entry.message.toolCallId === call.id,
  );
  if (results.length !== 1)
    throw new Error(
      "Manager omitted or duplicated exact delegate_work tool result",
    );
  return { toolCallId: call.id, message: results[0].message };
}

export function matchedUnboundTargetRejection(entries, assignedLeadTarget) {
  const calls = entries
    .filter(
      (entry) =>
        entry.type === "message" && entry.message?.role === "assistant",
    )
    .flatMap((entry) => entry.message.content ?? [])
    .filter(
      (part) =>
        part.type === "toolCall" &&
        part.name === "message_peer" &&
        part.arguments?.target === assignedLeadTarget &&
        typeof part.id === "string",
    );
  if (calls.length !== 1)
    throw new Error(
      "Lead omitted or duplicated exact managed message_peer call",
    );
  const [call] = calls;
  const results = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "message_peer" &&
      entry.message.toolCallId === call.id,
  );
  if (results.length !== 1)
    throw new Error(
      "Lead omitted or duplicated exact managed message_peer result",
    );
  const message = results[0].message;
  const text = (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (
    message.isError !== true ||
    !/Unknown coordinator target; rediscover it/u.test(text)
  )
    throw new Error(`Unbound target did not match expected rejection: ${text}`);
  return { toolCallId: call.id, message, text };
}

export function assertPeerInListPeersResult(entries, peerTarget) {
  const calls = entries
    .filter(
      (entry) =>
        entry.type === "message" && entry.message?.role === "assistant",
    )
    .flatMap((entry) => entry.message.content ?? [])
    .filter(
      (part) =>
        part.type === "toolCall" &&
        part.name === "list_peers" &&
        typeof part.id === "string",
    );
  if (calls.length !== 1)
    throw new Error("Lead omitted or duplicated exact list_peers tool call");
  const [call] = calls;
  const results = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "list_peers" &&
      entry.message.toolCallId === call.id,
  );
  if (results.length !== 1)
    throw new Error("Lead omitted or duplicated exact list_peers tool result");
  if (
    !results[0].message.details?.peers?.some(
      (peer) => peer.target === peerTarget,
    )
  )
    throw new Error("exact list_peers result omitted the remote ordinary Lead");
}

export function delegateResultEvidence(toolCallId, message) {
  return {
    toolCallId,
    isError: message.isError === true,
    content: sanitize(
      (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ),
    details:
      message.details === undefined
        ? undefined
        : sanitize(JSON.stringify(message.details)),
  };
}

export function parseDelegateResult(message) {
  const firstText = Array.isArray(message.content)
    ? message.content.find((part) => part.type === "text")?.text
    : undefined;
  if (message.isError)
    throw new Error(
      typeof firstText === "string"
        ? firstText
        : "Manager delegate_work returned an error",
    );
  if (typeof firstText !== "string")
    throw new Error("missing single JSON text result");
  return JSON.parse(firstText);
}
