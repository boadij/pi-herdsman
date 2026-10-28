import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  assertOrdinaryLeadSendAcceptance,
  assertPeerInListPeersResult,
  classifyCurrentSendEvidence,
  currentSendDiagnostics,
  currentSendDiscoveryMatched,
  isLiveCorrespondenceRecipient,
  matchedManagedLeadDenial,
  matchedDelegateResult,
  parseDelegateResult,
  ordinaryLeadDeliveryReady,
} from "./peer-federation-result.mjs";

test("ordinary Lead send acceptance requires one fresh discovery, one send, and its exact receipt", () => {
  const diagnostics = {
    freshListPeersCalls: 1,
    freshDiscoveryMatched: true,
    messagePeerCalls: 1,
    messagePeerOutcome: "success",
    durableQueueReceipt: true,
  };
  assert.doesNotThrow(() => assertOrdinaryLeadSendAcceptance(diagnostics));
  for (const [field, value] of Object.entries({
    freshListPeersCalls: 0,
    freshDiscoveryMatched: false,
    messagePeerCalls: 2,
    messagePeerOutcome: "unknown",
    durableQueueReceipt: false,
  }))
    assert.throws(
      () =>
        assertOrdinaryLeadSendAcceptance({ ...diagnostics, [field]: value }),
      new RegExp(field),
    );
});

test("send-turn discovery requires exactly one correlated result containing the peer", () => {
  const calls = new Map([["list-call", {}]]);
  const results = new Map([
    ["list-call", { details: { peers: [{ session: "expected-peer" }] } }],
  ]);
  assert.equal(
    currentSendDiscoveryMatched(
      calls,
      results,
      new Map([["list-call", 1]]),
      "expected-peer",
    ),
    true,
  );
  assert.equal(
    currentSendDiscoveryMatched(calls, results, new Map(), "expected-peer"),
    false,
  );
  assert.equal(
    currentSendDiscoveryMatched(
      calls,
      results,
      new Map([["list-call", 2]]),
      "expected-peer",
    ),
    false,
  );
  assert.equal(
    currentSendDiscoveryMatched(
      calls,
      results,
      new Map([["list-call", 1]]),
      "other-peer",
    ),
    false,
  );
});

test("parent reconstruction classifies bounded expected-peer and receipt evidence", () => {
  const evidence = {
    freshListPeersCalls: 1,
    freshListCallIds: ["list-call"],
    freshListResults: [
      {
        toolCallId: "list-call",
        resultCount: 1,
        expectedPeerMatched: true,
      },
    ],
    messagePeerCalls: 1,
    sendCallIds: ["send-call"],
    sendResults: [
      {
        toolCallId: "send-call",
        resultCount: 1,
        isError: false,
        queued: true,
        receiptId: "receipt-1",
      },
    ],
  };
  const serializedEvidence = JSON.stringify({
    sendEvidence: evidence,
    receipt: { id: "receipt-1" },
  });
  assert.doesNotMatch(
    serializedEvidence,
    /expected-peer|fromSessionId|remoteSessionId/u,
  );
  const diagnostics = classifyCurrentSendEvidence(evidence, "expected-peer", {
    id: "receipt-1",
  });
  assert.deepEqual(diagnostics, {
    freshListPeersCalls: 1,
    freshDiscoveryMatched: true,
    messagePeerCalls: 1,
    messagePeerOutcome: "success",
    authorizationReason: "unknown",
    durableQueueReceipt: true,
  });
  for (const invalidEvidence of [
    {
      ...evidence,
      freshListCallIds: ["x".repeat(129)],
      freshListResults: [],
    },
    {
      ...evidence,
      freshListResults: [
        {
          toolCallId: "x".repeat(129),
          resultCount: 1,
          expectedPeerMatched: true,
        },
      ],
    },
  ])
    assert.equal(
      classifyCurrentSendEvidence(invalidEvidence, "expected-peer", {
        id: "receipt-1",
      }).freshDiscoveryMatched,
      false,
    );
  assert.equal(
    classifyCurrentSendEvidence(null, "expected-peer", null)
      .durableQueueReceipt,
    false,
  );
});

test("embedded reader returns only bounded delivery and binding projections", () => {
  const smokeSource = readFileSync(
    new URL("./peer-federation-smoke.mjs", import.meta.url),
    "utf8",
  );
  const readerPattern =
    /const readOrdinaryLeadSession = \([\s\S]*?\r?\n  \};\r?\n  const readBDecisionDiagnostics/u;
  for (const source of [smokeSource, smokeSource.replace(/\r?\n/gu, "\r\n")])
    assert.ok(source.match(readerPattern), "reader wrapper exists");
  const readerWrapper = smokeSource.match(readerPattern)?.[0];
  assert.ok(readerWrapper, "reader wrapper exists");
  assert.match(readerWrapper, /const output = exec\([\s\S]*?herdrEnv\(side\)/u);
  assert.match(
    smokeSource,
    /const herdrEnv = \(side\) => \[[\s\S]*?`PI_CODING_AGENT_DIR=\$\{fixturePath\(side\)\}\/\.pi\/agent`/u,
  );
  const embeddedSource = smokeSource.match(
    /const script = `([\s\S]*?)`;/u,
  )?.[1];
  assert.ok(embeddedSource, "embedded reader script exists");
  const embeddedScript = runInNewContext(`\`${embeddedSource}\``);
  const artifact = "EXPECTED_ARTIFACT_CONTENT\nsecond line";
  const messageId = "message-1";
  const ref = "result:source#1";
  const canonicalRef = "result:canonical";
  const fingerprint = (value) =>
    createHash("sha256").update(value).digest("hex");
  const tempDir = mkdtempSync(join(tmpdir(), "peer-reader-test-"));
  try {
    const transcript = join(tempDir, "session.jsonl");
    const agentDir = join(tempDir, "agent");
    const artifactPath = join(
      agentDir,
      "pi-herdsman",
      "results",
      canonicalRef.slice("result:".length),
    );
    mkdirSync(join(agentDir, "pi-herdsman", "results"), { recursive: true });
    writeFileSync(artifactPath, artifact);
    writeFileSync(
      transcript,
      [
        {
          type: "custom_message",
          customType: "pi-herdsman-peer_message",
          details: {
            id: messageId,
            toSessionId: "private-session-id",
            privateDetail: "raw-details-must-not-cross",
          },
          content: artifact,
        },
        {
          type: "custom",
          customType: "pi-herdsman-result-ref",
          data: {
            ref,
            canonicalRef,
            privateDetail: "raw-binding-details-must-not-cross",
          },
        },
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "PEER_E2E_A_LEAD_SEND ref" }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", name: "message_peer", id: "send-call" },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "message_peer",
            toolCallId: "send-call",
            details: { queued: true, id: "" },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        embeddedScript,
        transcript,
        "recipient",
        messageId,
        ref,
        fingerprint("expected-peer-session"),
        fingerprint("private-session-id"),
        canonicalRef,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.delivered, {
      type: "custom_message",
      customType: "pi-herdsman-peer_message",
      details: { id: messageId },
    });
    assert.equal(output.matchingDeliveryCount, 1);
    assert.equal(output.correctRecipient, true);
    assert.equal(output.artifactIncluded, true);
    assert.equal(output.bindingPresent, true);
    assert.equal(output.bindingMatches, true);
    assert.doesNotMatch(
      result.stdout,
      /EXPECTED_ARTIFACT_CONTENT|private-session-id|expected-peer-session|privateDetail|raw-details|raw-binding-details|canonicalRef|toSessionId/u,
    );
    const sendResult = spawnSync(
      process.execPath,
      [
        "-e",
        embeddedScript,
        transcript,
        "send",
        "",
        "",
        fingerprint("expected-peer-session"),
        "",
        "",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      },
    );
    assert.equal(sendResult.status, 0, sendResult.stderr);
    const sendOutput = JSON.parse(sendResult.stdout);
    assert.equal(sendOutput.receipt, null);
    assert.equal(
      classifyCurrentSendEvidence(
        sendOutput.sendEvidence,
        "expected-peer-session",
        sendOutput.receipt,
      ).durableQueueReceipt,
      false,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("current send diagnostics keep authorization and receipt tied to one exact result", () => {
  const earlierError = {
    isError: true,
    content: [{ type: "text", text: "denied [route_ambiguous]" }],
  };
  const laterSuccess = {
    isError: false,
    details: { queued: true, id: "receipt-2" },
  };
  const multipleCalls = new Map([
    ["call-1", {}],
    ["call-2", {}],
  ]);
  const multipleResults = new Map([
    ["call-1", earlierError],
    ["call-2", laterSuccess],
  ]);
  const counts = new Map([
    ["call-1", 1],
    ["call-2", 1],
  ]);
  assert.deepEqual(
    currentSendDiagnostics(multipleCalls, multipleResults, counts, {
      id: "receipt-2",
    }),
    {
      messagePeerOutcome: "unknown",
      authorizationReason: "unknown",
      durableQueueReceipt: false,
    },
  );

  const call = new Map([["call-2", {}]]);
  assert.deepEqual(
    currentSendDiagnostics(call, multipleResults, counts, { id: "receipt-2" }),
    {
      messagePeerOutcome: "success",
      authorizationReason: "unknown",
      durableQueueReceipt: true,
    },
  );
  assert.equal(
    currentSendDiagnostics(call, multipleResults, counts, {
      id: "other-receipt",
    }).durableQueueReceipt,
    false,
  );
  assert.equal(
    currentSendDiagnostics(
      call,
      new Map([
        ["call-2", { isError: false, details: { queued: true, id: "" } }],
      ]),
      counts,
      { id: "" },
    ).durableQueueReceipt,
    false,
  );
  assert.equal(
    currentSendDiagnostics(call, multipleResults, new Map([["call-2", 2]]), {
      id: "receipt-2",
    }).messagePeerOutcome,
    "unknown",
  );
  assert.equal(
    currentSendDiagnostics(
      new Map([["call-1", {}]]),
      multipleResults,
      counts,
      null,
    ).authorizationReason,
    "route_ambiguous",
  );
});

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

test("delegate_work error text is surfaced before JSON parsing", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "delegate_work", id: "call-exact" },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_work",
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
