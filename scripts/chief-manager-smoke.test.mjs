import assert from "node:assert/strict";
import test from "node:test";
import {
  chiefManagerSuccessEvidence,
  matchesChiefManagerHandoff,
} from "./chief-manager-smoke.mjs";

test("Manager smoke accepts only the completed correlated persisted handoff", () => {
  const entry = {
    customType: "pi-herdsman-agent-result",
    details: {
      requestId: "request-1",
      piSessionId: "child-1",
      status: "completed",
    },
    content: "Agent result CHIEF_MANAGER_AGENT_COMPLETED",
  };
  assert.equal(matchesChiefManagerHandoff(entry, "request-1", "child-1"), true);
  assert.equal(
    matchesChiefManagerHandoff(entry, "wrong-request", "child-1"),
    false,
  );
});

test("Manager success evidence is bounded and excludes correlation identifiers", () => {
  const evidence = chiefManagerSuccessEvidence({
    toolCallObserved: true,
    toolResultObserved: true,
    toolResultError: false,
    requestId: "private-request-id",
    childSessionId: "private-child-session-id",
    handoffObserved: true,
    handoffStatus: "completed",
    completionMarkerObserved: true,
  });

  assert.deepEqual(evidence, {
    managerDefinition: "smoke-manager",
    agentDefinition: "smoke-agent",
    delegationToolCallObserved: true,
    successfulCorrelatedDelegationResultObserved: true,
    completedAgentResultReceiptCorrelated: true,
  });
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /private|request-id|session-id/,
  );
  assert.equal(
    chiefManagerSuccessEvidence({
      toolCallObserved: true,
      toolResultObserved: true,
      toolResultError: false,
      requestId: "request",
      childSessionId: "child",
      handoffObserved: true,
      handoffStatus: "failed",
      completionMarkerObserved: false,
    }).completedAgentResultReceiptCorrelated,
    false,
  );
});
