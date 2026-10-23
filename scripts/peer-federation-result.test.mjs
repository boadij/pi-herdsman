import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPeerInListPeersResult,
  matchedDelegateResult,
  parseDelegateResult,
} from "./peer-federation-result.mjs";

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
