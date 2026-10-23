import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPeerInListPeersResult,
  isLiveCorrespondenceRecipient,
  matchedManagedLeadDenial,
  matchedDelegateResult,
  parseDelegateResult,
  ordinaryLeadDeliveryReady,
} from "./peer-federation-result.mjs";

test("ordinary Lead delivery wait does not accept an initially empty inbox", () => {
  const messageId = "expected-message";
  const delivered = {
    type: "custom_message",
    customType: "pi-herdsman-peer_message",
    details: { id: messageId },
  };
  assert.equal(ordinaryLeadDeliveryReady([], messageId, ""), false);
  assert.equal(ordinaryLeadDeliveryReady([delivered], messageId, ""), true);
  assert.equal(
    ordinaryLeadDeliveryReady([delivered, delivered], messageId, ""),
    false,
  );
  assert.equal(
    ordinaryLeadDeliveryReady([delivered], messageId, "pending"),
    false,
  );
});

test("ordinary Lead artifact matching uses delivered content with multiline text", () => {
  const artifact = "first line\nsecond line";
  const delivered = { content: `<file>\n${artifact}\n</file>` };
  assert.equal(delivered.content.includes(artifact), true);
  assert.equal(JSON.stringify(delivered).includes(artifact), false);
});

test("live correspondence recipient matches role, session, generation, and Lead eligibility", () => {
  const correspondence = {
    recipientSession: "recipient",
    recipientGeneration: "generation",
  };
  const manager = {
    peers: [
      {
        role: "manager",
        piSessionId: "recipient",
        claim: { id: "generation" },
      },
    ],
  };
  assert.equal(isLiveCorrespondenceRecipient(manager, correspondence), true);

  const lead = {
    ordinaryLeadsComplete: true,
    peers: [
      {
        role: "lead",
        sessionKind: "ordinary",
        piSessionId: "recipient",
        claim: { id: "generation" },
      },
    ],
  };
  assert.equal(
    isLiveCorrespondenceRecipient(lead, { ...correspondence, role: "lead" }),
    true,
  );
  assert.equal(
    isLiveCorrespondenceRecipient(
      { ...lead, ordinaryLeadsComplete: false },
      { ...correspondence, role: "lead" },
    ),
    false,
  );
  assert.equal(
    isLiveCorrespondenceRecipient(
      { ...lead, peers: [{ ...lead.peers[0], piSessionId: "other" }] },
      { ...correspondence, role: "lead" },
    ),
    false,
  );
  assert.equal(
    isLiveCorrespondenceRecipient(
      { ...lead, peers: [{ ...lead.peers[0], claim: { id: "other" } }] },
      { ...correspondence, role: "lead" },
    ),
    false,
  );
});

test("managed Lead denial requires exact nested call and correlated error result", () => {
  const call = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "message_peer",
          id: "peer-call",
          arguments: { session: "assigned-session" },
        },
      ],
    },
  };
  const result = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "message_peer",
      toolCallId: "peer-call",
      isError: true,
      content: [
        {
          type: "text",
          text: "Peer target was not found or is no longer a live same-role peer",
        },
      ],
    },
  };
  assert.equal(
    matchedManagedLeadDenial([call, result], "assigned-session").text,
    "Peer target was not found or is no longer a live same-role peer",
  );
  assert.throws(() =>
    matchedManagedLeadDenial([call, result], "wrong-session"),
  );
  assert.throws(() => matchedManagedLeadDenial([call], "assigned-session"));
  assert.throws(
    () =>
      matchedManagedLeadDenial(
        [
          call,
          {
            ...result,
            message: {
              ...result.message,
              content: [{ type: "text", text: "unrelated failure" }],
            },
          },
        ],
        "assigned-session",
      ),
    /expected rejection/u,
  );
});

test("delegate_project error text is surfaced before JSON parsing", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "delegate_project", id: "call-exact" },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_project",
        toolCallId: "call-exact",
        isError: true,
        content: [
          {
            type: "text",
            text: "Lead started but its exact Pi session identity did not materialize",
          },
        ],
      },
    },
  ];
  const { toolCallId, message } = matchedDelegateResult(entries);
  assert.equal(toolCallId, "call-exact");
  assert.throws(
    () => parseDelegateResult(message),
    (error) =>
      error.message ===
        "Lead started but its exact Pi session identity did not materialize" &&
      !(error instanceof SyntaxError),
  );
});

test("list_peers discovery requires the exact result to contain the peer", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "remote-session" },
          { type: "toolCall", name: "list_peers", id: "list-exact" },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "list_peers",
        toolCallId: "list-exact",
        details: { peers: [{ piSessionId: "another-session" }] },
      },
    },
  ];
  assert.throws(
    () => assertPeerInListPeersResult(entries, "remote-session"),
    /exact list_peers result omitted/u,
  );
});

test("list_peers accepts the exact public peer session in its correlated result", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "list_peers", id: "list-exact" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "list_peers",
        toolCallId: "list-exact",
        details: { peers: [{ session: "remote-session" }] },
      },
    },
  ];
  assert.doesNotThrow(() =>
    assertPeerInListPeersResult(entries, "remote-session"),
  );
  assert.throws(
    () => assertPeerInListPeersResult(entries, "absent-session"),
    /exact list_peers result omitted/u,
  );
});
