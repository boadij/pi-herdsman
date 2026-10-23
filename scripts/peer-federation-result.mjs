const MAX_EVIDENCE_LENGTH = 500;

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
        part.name === "delegate_project" &&
        typeof part.id === "string",
    );
  if (calls.length !== 1)
    throw new Error(
      "Manager omitted or duplicated exact delegate_project tool call",
    );
  const [call] = calls;
  const results = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "delegate_project" &&
      entry.message.toolCallId === call.id,
  );
  if (results.length !== 1)
    throw new Error(
      "Manager omitted or duplicated exact delegate_project tool result",
    );
  return { toolCallId: call.id, message: results[0].message };
}

export function assertPeerInListPeersResult(entries, peerId) {
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
      (peer) => peer.piSessionId === peerId,
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
        : "Manager delegate_project returned an error",
    );
  if (typeof firstText !== "string")
    throw new Error("missing single JSON text result");
  return JSON.parse(firstText);
}
