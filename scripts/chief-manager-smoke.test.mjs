import assert from "node:assert/strict";
import test from "node:test";
import {
  correlatedOwnedAgentQuestion,
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

test("owned Agent readiness evidence is bounded and omits private identity", () => {
  const evidence = ownedAgentReadinessEvidence({
    assignmentAccepted: true,
    exactMailboxObserved: true,
    waitingToolResult: "rejected",
    terminalOutcome: "failed",
    pid: 421,
    mailboxId: "private-mailbox-id",
    sessionId: "private-session-id",
    content: "private session content",
    path: "/private/session/path",
  });

  assert.equal(evidence.assignmentAccepted, true);
  assert.equal(evidence.exactMailboxObserved, true);
  assert.equal(evidence.waitingToolResult, "rejected");
  assert.equal(evidence.terminalOutcome, "failed");
  assert.ok(
    Object.values(evidence).every(
      (value) => typeof value === "boolean" || typeof value === "string",
    ),
  );
  assert.doesNotMatch(JSON.stringify(evidence), /private|421|\//u);
});

test("non-leaf Agent readiness evidence projects nested assignment state", () => {
  const evidence = ownedAgentReadinessEvidence({
    assignmentAccepted: true,
    nestedAssignment: "accepted",
    pid: 421,
    mailboxId: "private-mailbox-id",
    sessionId: "private-session-id",
    content: "private session content",
    path: "/private/session/path",
  });

  assert.equal(evidence.assignmentAccepted, true);
  assert.equal(evidence.nestedAssignment, "accepted");
  assert.doesNotMatch(JSON.stringify(evidence), /private|421|\//u);
});

test("owned Agent waiting requires correlated successful question, state, and ask evidence", () => {
  const identity = {
    ownerSessionId: "owner",
    piSessionId: "child",
    requestId: "request-current",
  };
  const state = {
    runId: "run",
    pendingAskId: "ask-current",
    workspaceId: "workspace",
    agentLabel: "smoke-chief-agent",
    paneId: "pane",
  };
  const ask = {
    version: 5,
    askId: "ask-current",
    requestId: "request-current",
    runId: "run",
    ownerSessionId: "owner",
    piSessionId: "child",
    workspaceId: "workspace",
    agentLabel: "smoke-chief-agent",
    paneId: "pane",
    question: "CHIEF_MANAGER_SMOKE_AGENT_PENDING",
  };
  const call = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "await_owner",
          arguments: { question: ask.question },
        },
      ],
    },
  };
  const result = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "await_owner",
      toolCallId: "call-1",
      isError: false,
      details: { askId: "ask-current", assignmentRequestId: "request-current" },
    },
  };
  assert.equal(correlatedOwnedAgentQuestion([call], identity, state, ask).status, "pending");
  assert.equal(
    correlatedOwnedAgentQuestion(
      [call, { ...result, message: { ...result.message, isError: true } }],
      identity,
      state,
      ask,
    ).status,
    "rejected",
  );
  assert.equal(
    correlatedOwnedAgentQuestion(
      [call, result],
      identity,
      { ...state, pendingAskId: undefined },
      ask,
    ).status,
    "mismatch",
  );
  assert.equal(
    correlatedOwnedAgentQuestion(
      [
        call,
        {
          ...result,
          message: {
            ...result.message,
            details: { ...result.message.details, assignmentRequestId: "old" },
          },
        },
      ],
      identity,
      state,
      ask,
    ).status,
    "mismatch",
  );
  assert.equal(
    correlatedOwnedAgentQuestion([call, result], identity, state, ask).status,
    "success",
  );
  const historical = [
    call,
    result,
    { type: "message", message: { role: "assistant", stopReason: "stop" } },
  ];
  assert.equal(
    correlatedOwnedAgentQuestion(
      historical,
      identity,
      { ...state, activeRequestId: undefined, pendingAskId: undefined },
      ask,
    ).status,
    "mismatch",
  );
});
