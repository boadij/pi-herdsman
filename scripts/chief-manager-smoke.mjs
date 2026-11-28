export function matchesChiefManagerHandoff(entry, requestId, childSessionId) {
  return (
    entry?.customType === "pi-herdsman-agent-result" &&
    entry.details?.requestId === requestId &&
    entry.details?.piSessionId === childSessionId &&
    entry.details?.status === "completed" &&
    typeof entry.content === "string" &&
    entry.content.includes("CHIEF_MANAGER_AGENT_COMPLETED")
  );
}

export function chiefManagerSuccessEvidence(progress = {}) {
  return {
    managerDefinition: "smoke-manager",
    agentDefinition: "smoke-agent",
    delegationToolCallObserved: progress.toolCallObserved === true,
    successfulCorrelatedDelegationResultObserved:
      progress.toolResultObserved === true &&
      progress.toolResultError === false &&
      typeof progress.requestId === "string" &&
      typeof progress.childSessionId === "string",
    completedAgentResultReceiptCorrelated:
      progress.handoffObserved === true &&
      progress.handoffStatus === "completed" &&
      progress.completionMarkerObserved === true,
  };
}

export function ownedAgentReadinessEvidence(progress = {}) {
  const statuses = (value, allowed) => (allowed.includes(value) ? value : "not_observed");
  return {
    assignmentAccepted: progress.assignmentAccepted === true,
    childSessionObserved: progress.childSessionObserved === true,
    exactMailboxObserved: progress.exactMailboxObserved === true,
    activeRequestMatched: progress.activeRequestMatched === true,
    herdrRegistrationObserved: progress.herdrRegistrationObserved === true,
    sessionStartObserved: progress.sessionStartObserved === true,
    providerRequestObserved: progress.providerRequestObserved === true,
    exactProcessObserved: progress.exactProcessObserved === true,
    waitingToolResult: statuses(progress.waitingToolResult, [
      "pending",
      "success",
      "rejected",
      "mismatch",
      "conflict",
      "not_applicable",
    ]),
    questionMismatch: statuses(progress.questionMismatch, [
      "result_status",
      "assignment_request",
      "ask_id_missing",
      "ask_id_conflict",
      "ask_version",
      "ask_identity",
      "ask_question",
      "ask_context",
    ]),
    pendingQuestionMatched: progress.pendingQuestionMatched === true,
    nestedAssignment: statuses(progress.nestedAssignment, [
      "not_applicable",
      "pending",
      "accepted",
    ]),
    terminalOutcome: statuses(progress.terminalOutcome, ["not_observed", "completed", "failed"]),
  };
}

export async function readOwnedAgentSnapshots(readSession, readMailbox) {
  // await_owner persists the question before returning the transcript result.
  const session = await readSession();
  const mailbox = session ? await readMailbox() : undefined;
  return { session, mailbox };
}

export function correlatedOwnedAgentQuestion(entries, identity, state, ask) {
  const calls = entries.flatMap((entry) =>
    entry.type === "message" && entry.message?.role === "assistant"
      ? (entry.message.content ?? []).filter(
          (part) =>
            part.type === "toolCall" &&
            part.name === "await_owner" &&
            part.arguments?.question === "CHIEF_MANAGER_SMOKE_AGENT_PENDING",
        )
      : [],
  );
  if (!calls.length) return { status: "not_observed" };
  const call = calls.at(-1);
  if (typeof call.id !== "string" || !call.id) return { status: "conflict" };
  const results = entries
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "await_owner" &&
        entry.message.toolCallId === call.id,
    )
    .map((entry) => entry.message);
  if (!results.length) return { status: "pending" };
  if (results.length !== 1) return { status: "conflict" };
  const result = results[0];
  if (result.isError === true) return { status: "rejected" };
  const askId = result.details?.askId;
  if (result.isError !== false) return { status: "mismatch", reason: "result_status" };
  if (result.details?.assignmentRequestId !== identity.requestId)
    return { status: "mismatch", reason: "assignment_request" };
  if (typeof askId !== "string") return { status: "mismatch", reason: "ask_id_missing" };
  if (state?.pendingAskId !== askId || ask?.askId !== askId)
    return { status: "mismatch", reason: "ask_id_conflict" };
  if (ask?.version !== 5) return { status: "mismatch", reason: "ask_version" };
  if (
    ask?.requestId !== identity.requestId ||
    ask?.ownerSessionId !== identity.ownerSessionId ||
    ask?.piSessionId !== identity.piSessionId
  )
    return { status: "mismatch", reason: "ask_identity" };
  if (ask?.question !== "CHIEF_MANAGER_SMOKE_AGENT_PENDING")
    return { status: "mismatch", reason: "ask_question" };
  if (
    ask?.runId !== state?.runId ||
    ask?.workspaceId !== state?.workspaceId ||
    ask?.agentLabel !== state?.agentLabel ||
    ask?.paneId !== state?.paneId
  )
    return { status: "mismatch", reason: "ask_context" };
  return { status: "success", askId };
}
