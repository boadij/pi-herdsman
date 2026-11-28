import assert from "node:assert/strict";
import test from "node:test";
import {
  chiefManagerSuccessEvidence,
  matchesChiefManagerHandoff,
  ownedAgentReadinessEvidence,
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
  assert.equal(matchesChiefManagerHandoff(entry, "wrong-request", "child-1"), false);
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
  assert.doesNotMatch(JSON.stringify(evidence), /private|request-id|session-id/);
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

test("owned Agent readiness evidence contains only prerequisite booleans", () => {
  const evidence = ownedAgentReadinessEvidence({
    activeMailboxRequestPresent: true,
    positiveChildPidPresent: false,
    expectedAwaitOwnerPresent: true,
    pid: 421,
    mailboxId: "private-mailbox-id",
    sessionId: "private-session-id",
    content: "private session content",
    path: "/private/session/path",
  });

  assert.deepEqual(evidence, {
    activeMailboxRequestPresent: true,
    positiveChildPidPresent: false,
    expectedAwaitOwnerPresent: true,
  });
  assert.ok(Object.values(evidence).every((value) => typeof value === "boolean"));
  assert.doesNotMatch(JSON.stringify(evidence), /private|421|\//u);
});

test("non-leaf Agent readiness evidence contains only its two prerequisites", () => {
  const evidence = ownedAgentReadinessEvidence({
    activeMailboxRequestPresent: true,
    positiveChildPidPresent: false,
    pid: 421,
    mailboxId: "private-mailbox-id",
    sessionId: "private-session-id",
    content: "private session content",
    path: "/private/session/path",
  });

  assert.deepEqual(evidence, {
    activeMailboxRequestPresent: true,
    positiveChildPidPresent: false,
  });
  assert.ok(Object.values(evidence).every((value) => typeof value === "boolean"));
  assert.doesNotMatch(JSON.stringify(evidence), /private|421|\//u);
});
