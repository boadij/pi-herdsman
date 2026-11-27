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
  return {
    activeMailboxRequestPresent: progress.activeMailboxRequestPresent === true,
    positiveChildPidPresent: progress.positiveChildPidPresent === true,
    ...(typeof progress.expectedAwaitOwnerPresent === "boolean"
      ? { expectedAwaitOwnerPresent: progress.expectedAwaitOwnerPresent }
      : {}),
  };
}
