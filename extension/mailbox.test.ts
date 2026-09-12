import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  controlMarker,
  claimAgentMailbox,
  MailboxClaimOccupiedError,
  parseControlMarker,
  readRequest,
  readUnacknowledgedRequest,
  readAsk,
  readPendingAsk,
  readResult,
  readAgentState,
  listAgentStates,
  listAgentStateIssues,
  removeAgentMailbox,
  removeResult,
  removeAsk,
  resetAgentMailbox,
  unacknowledgedRequestExists,
  writeResult,
  waitForState,
  writeRequest,
  writeAsk,
  writeAgentState,
  agentMailboxPath,
  type RequestRecord,
  type AskRecord,
  type ManagedAgentState,
} from "./mailbox.ts";
import { chooseLabel } from "./core.ts";

function assertPosixMode(path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777;
  if (process.platform !== "win32") assert.equal(actual, expected);
}

const state: ManagedAgentState = {
  version: 4,
  runId: "11111111-1111-4111-8111-111111111111",
  ownerSessionId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "w",
  agentLabel: "agent",
  paneId: "p",
  piSessionId: "33333333-3333-4333-8333-333333333333",
  cwd: "/tmp",
  updatedAt: Date.now(),
};
test("V4 markers require canonical UUIDs and never contain task text", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  assert.equal(controlMarker(id), `__PI_HERDSMAN_AGENT_V4__:${id}`);
  assert.equal(parseControlMarker(controlMarker(id)), id);
  assert.equal(parseControlMarker(`${controlMarker(id)} task`), undefined);
  assert.equal(parseControlMarker("__PI_HERDSMAN_AGENT_V4__:bad"), undefined);
  assert.equal(parseControlMarker("__PI_HERDSMAN_AGENT_V4__:"), undefined);
});
test("Pi UUIDv7 session and run identities are valid mailbox fields", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const v7State: ManagedAgentState = {
    ...state,
    runId: "018f2f2e-7b11-7abc-8def-0123456789ab",
    ownerSessionId: "018f2f2e-7b12-7abc-8def-0123456789ab",
    piSessionId: "018f2f2e-7b13-7abc-8def-0123456789ab",
  };
  writeAgentState(path, v7State);
  assert.deepEqual(readAgentState(path), v7State);
  const requestId = "018f2f2e-7b14-7abc-8def-0123456789ab";
  writeRequest(path, {
    version: 4,
    runId: v7State.runId,
    requestId,
    ownerSessionId: v7State.ownerSessionId,
    workspaceId: v7State.workspaceId,
    agentLabel: v7State.agentLabel,
    paneId: v7State.paneId,
    kind: "task",
    text: "work",
    createdAt: Date.now(),
  });
  assert.equal(readRequest(path, requestId)?.requestId, requestId);
});
test("asks and reply requests round-trip with strict correlation", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const ask: AskRecord = {
    version: 4,
    askId: "44444444-4444-4444-8444-444444444444",
    requestId: state.runId,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    piSessionId: state.piSessionId,
    question: "Choose A or B",
    createdAt: Date.now(),
  };
  writeAsk(path, ask);
  assert.deepEqual(readAsk(path), ask);
  const request: RequestRecord = {
    version: 4,
    runId: state.runId,
    requestId: "55555555-5555-4555-8555-555555555555",
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "reply",
    askId: ask.askId,
    text: "Use B",
    createdAt: Date.now(),
  };
  writeRequest(path, request);
  assert.deepEqual(readRequest(path, request.requestId), request);
  removeAsk(path);
  assert.equal(readAsk(path), undefined);
});
test("reply ask IDs are required and non-reply requests cannot carry one", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const base = {
    version: 4 as const,
    runId: state.runId,
    requestId: "55555555-5555-4555-8555-555555555555",
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    text: "reply",
    createdAt: Date.now(),
  };
  assert.throws(
    () => writeRequest(path, { ...base, kind: "reply" } as never),
    /reply ask ID/,
  );
  assert.throws(
    () =>
      writeRequest(path, {
        ...base,
        kind: "task",
        askId: state.runId,
      } as never),
    /reply ask ID/,
  );
  assert.throws(
    () => writeAgentState(path, { ...state, pendingAskId: "not-a-uuid" }),
    /pendingAskId/,
  );
  assert.throws(
    () =>
      writeAgentState(path, {
        ...state,
        pendingAskId: state.runId,
      }),
    /requires activeRequestId/,
  );
  assert.throws(
    () =>
      writeAgentState(path, {
        ...state,
        activeRequestId: state.runId,
        completedRequestId: "88888888-8888-4888-8888-888888888888",
        pendingAskId: state.runId,
      } as never),
    /cannot coexist with completedRequestId/,
  );
});
test("readPendingAsk fails closed for a missing or mismatched artifact", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const waiting = {
    ...state,
    activeRequestId: state.runId,
    pendingAskId: state.runId,
  };
  writeAgentState(path, waiting);
  assert.equal(readPendingAsk(path, state), undefined);
  assert.throws(() => readPendingAsk(path, waiting), /artifact is missing/);
  writeAsk(path, {
    version: 4,
    askId: state.runId,
    requestId: state.runId,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    piSessionId: state.piSessionId,
    question: "Choose",
    createdAt: Date.now(),
  });
  assert.equal(readPendingAsk(path, waiting)?.askId, state.runId);
  writeAsk(path, {
    version: 4,
    askId: state.runId,
    requestId: "77777777-7777-4777-8777-777777777777",
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    piSessionId: state.piSessionId,
    question: "Choose",
    createdAt: Date.now(),
  });
  assert.throws(() => readPendingAsk(path, waiting), /identity did not match/);
});
test("rejects malformed state records", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({ ...state, extra: true }),
  );
  assert.throws(() => readAgentState(path), /Unknown mailbox field/);
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({
      ...state,
      lastAck: {
        requestId: state.runId,
        accepted: true,
        code: "busy",
        acknowledgedAt: Date.now(),
      },
    }),
  );
  assert.throws(() => readAgentState(path), /Accepted acknowledgement/);
  writeFileSync(join(path, "state.json"), "x".repeat(65 * 1024));
  assert.throws(() => readAgentState(path), /too large/);
  for (const value of ["1", 1.5, -1, Infinity, NaN]) {
    writeFileSync(
      join(path, "state.json"),
      JSON.stringify({ ...state, lastActivityAt: value }),
    );
    assert.throws(() => readAgentState(path), /lastActivityAt/);
  }
  for (const value of ["", "   ", 1, null]) {
    writeFileSync(
      join(path, "state.json"),
      JSON.stringify({ ...state, agentDefinition: value }),
    );
    assert.throws(() => readAgentState(path), /agentDefinition/);
  }
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({ ...state, workerLabel: "legacy" }),
  );
  assert.throws(() => readAgentState(path), /Unknown mailbox field/);
});
test("waits on the exact state path and resolves after an update", async () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const waiting = waitForState(
    path,
    (value) => value.completedRequestId === state.runId,
    { timeoutMs: 1000 },
  );
  setTimeout(
    () => writeAgentState(path, { ...state, completedRequestId: state.runId }),
    20,
  );
  assert.equal((await waiting).completedRequestId, state.runId);
});
test("state waiter observes a write made during its initial check", async () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  writeAgentState(path, state);
  let written = false;
  const waiting = waitForState(
    path,
    (value) => {
      if (!written) {
        written = true;
        writeAgentState(path, { ...state, completedRequestId: state.runId });
      }
      return value.completedRequestId === state.runId;
    },
    { timeoutMs: 1000 },
  );
  assert.equal((await waiting).completedRequestId, state.runId);
});
test("rejects unsafe IDs and invalid conditional results", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  assert.throws(
    () =>
      writeRequest(path, {
        version: 4,
        runId: state.runId,
        requestId: "../escape",
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        kind: "task",
        text: "x",
        createdAt: Date.now(),
      } as never),
    /Invalid request ID/,
  );
  assert.throws(
    () =>
      writeResult(path, {
        version: 4,
        runId: state.runId,
        requestId: state.runId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        status: "completed",
        text: "   ",
        completedAt: Date.now(),
      } as never),
    /completed result/,
  );
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({
      ...state,
      lastAck: {
        requestId: state.runId,
        accepted: false,
        code: "invalid",
        acknowledgedAt: -1,
      },
    }),
  );
  assert.throws(() => readAgentState(path), /acknowledgement/);
  assert.throws(
    () =>
      writeResult(path, {
        version: 4,
        runId: state.runId,
        requestId: state.runId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        status: "completed",
        text: "ok",
        contextUsage: { tokens: 2, contextWindow: 10, percent: 101 },
        completedAt: Date.now(),
      } as never),
    /context usage/,
  );
});
test("aborted state waits reject immediately", async () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForState(path, () => true, {
      timeoutMs: 1000,
      signal: controller.signal,
    }),
    /Aborted/,
  );
});
test("mailbox records are atomic JSON files with strict identity fields", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  writeAgentState(path, state);
  assert.deepEqual(readAgentState(path), state);
  const request: RequestRecord = {
    version: 4,
    runId: state.runId,
    requestId: "55555555-5555-4555-8555-555555555555",
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "do the work",
    createdAt: Date.now(),
  };
  writeRequest(path, request);
  assert.deepEqual(readRequest(path, request.requestId), request);
});
test("acknowledgement identity determines whether a handoff remains pending", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  writeAgentState(path, state);
  const requestId = "66666666-6666-4666-8666-666666666666";
  writeRequest(path, {
    version: 4,
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "handoff",
    createdAt: Date.now(),
  });
  assert.equal(unacknowledgedRequestExists(path, state), true);
  assert.equal(
    unacknowledgedRequestExists(path, {
      ...state,
      lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
    }),
    false,
  );
  assert.equal(
    unacknowledgedRequestExists(path, {
      ...state,
      lastAck: {
        requestId,
        accepted: false,
        code: "busy",
        acknowledgedAt: Date.now(),
      },
    }),
    false,
  );
  const otherRequestId = "88888888-8888-4888-8888-888888888888";
  assert.equal(
    unacknowledgedRequestExists(path, {
      ...state,
      lastAck: {
        requestId: otherRequestId,
        accepted: false,
        code: "identity",
        acknowledgedAt: Date.now(),
      },
    }),
    true,
  );
  assert.equal(unacknowledgedRequestExists(path, state), true);
});
test("malformed request handoff fails closed", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  writeAgentState(path, state);
  writeFileSync(join(path, "request-bad.json"), "not json");
  assert.equal(unacknowledgedRequestExists(path, state), true);
});
test("ambiguous unacknowledged requests are rejected", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  writeAgentState(path, state);
  for (const requestId of [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ])
    writeRequest(path, {
      version: 4,
      runId: state.runId,
      requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: requestId,
      createdAt: Date.now(),
    });
  assert.throws(
    () => readUnacknowledgedRequest(path, state),
    /Multiple unacknowledged requests/,
  );
  assert.equal(unacknowledgedRequestExists(path, state), true);
});
test("mailbox paths separate workspace and label and use private directories", () => {
  const first = agentMailboxPath("workspace-a", "agent");
  assert.equal(basename(dirname(first)), "mailboxes-v4");
  assert.equal(first, agentMailboxPath("workspace-a", "agent"));
  assert.notEqual(first, agentMailboxPath("workspace-b", "agent"));
  assert.notEqual(first, agentMailboxPath("workspace-a", "agent-2"));
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  assertPosixMode(path, 0o700);
});
test("mailbox scans stay inside the current protocol namespace", () => {
  const path = agentMailboxPath("namespace-test", `agent-${process.pid}`);
  const outside = join(dirname(dirname(path)), basename(path));
  writeAgentState(path, state);
  mkdirSync(outside, { recursive: true });
  try {
    writeFileSync(join(outside, "state.json"), "not json");
    assert.ok(listAgentStates().some((entry) => entry.path === path));
    assert.ok(!listAgentStateIssues().some((entry) => entry.path === outside));
    writeAgentState(outside, state);
    assert.ok(!listAgentStates().some((entry) => entry.path === outside));
  } finally {
    removeAgentMailbox(path);
    removeAgentMailbox(outside);
  }
});
test("startup claims serialize access and reset preserves the claim", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  writeAgentState(path, state);
  const requestId = "88888888-8888-4888-8888-888888888888";
  writeRequest(path, {
    version: 4,
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "preserve",
    createdAt: Date.now(),
  });
  const resultBefore = JSON.stringify({ ...state, activeRequestId: requestId });
  writeAgentState(path, { ...state, activeRequestId: requestId });
  writeResult(path, {
    version: 4,
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "preserve",
    completedAt: Date.now(),
  });
  const stateBefore = readFileSync(join(path, "state.json"), "utf8");
  const requestBefore = readFileSync(
    join(path, `request-${requestId}.json`),
    "utf8",
  );
  const resultFileBefore = readFileSync(
    join(path, `result-${requestId}.json`),
    "utf8",
  );
  const release = claimAgentMailbox(path);
  assert.throws(() => claimAgentMailbox(path), MailboxClaimOccupiedError);
  assert.equal(readFileSync(join(path, "state.json"), "utf8"), stateBefore);
  assert.equal(
    readFileSync(join(path, `request-${requestId}.json`), "utf8"),
    requestBefore,
  );
  assert.equal(
    readFileSync(join(path, `result-${requestId}.json`), "utf8"),
    resultFileBefore,
  );
  resetAgentMailbox(path);
  const claimDir = join(path, ".starting");
  assertPosixMode(claimDir, 0o700);
  const owners = readdirSync(claimDir);
  assert.equal(owners.length, 1);
  assertPosixMode(join(claimDir, owners[0]), 0o600);
  assert.equal(readAgentState(path), undefined);
  assert.equal(readRequest(path, requestId), undefined);
  assert.equal(readResult(path, requestId), undefined);
  assert.equal(
    JSON.stringify({ ...state, activeRequestId: requestId }),
    resultBefore,
  );
  assert.equal(chooseLabel("reviewer", new Set(["reviewer"])), "reviewer-2");
  release();
  assert.equal(readdirSync(path).includes(".starting"), false);
});
test("startup claims recover one valid dead PID and reject malformed claims", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  mkdirSync(join(path, ".starting"));
  writeFileSync(
    join(path, ".starting", "999999-dead"),
    JSON.stringify({ pid: 999999, id: "dead" }),
  );
  const release = claimAgentMailbox(path);
  release();
  mkdirSync(join(path, ".starting"));
  writeFileSync(join(path, ".starting", "999999-malformed"), "not json");
  assert.throws(() => claimAgentMailbox(path), /Unable to verify/);
  unlinkSync(join(path, ".starting", "999999-malformed"));
});
test("stale recovery cannot remove a replacement owner", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const claimDir = join(path, ".starting");
  resetAgentMailbox(path);
  mkdirSync(claimDir);
  writeFileSync(
    join(claimDir, "999999-stale"),
    JSON.stringify({ pid: 999999, id: "stale" }),
  );
  const freshOwner = `${process.pid}-fresh`;
  const freshPayload = { pid: process.pid, id: "fresh" };
  let staleObserved = false;
  assert.throws(
    () =>
      claimAgentMailbox(path, {
        afterStaleOwnerRemoved: () => {
          assert.equal(existsSync(claimDir), false);
          staleObserved = true;
          mkdirSync(claimDir);
          writeFileSync(
            join(claimDir, freshOwner),
            JSON.stringify(freshPayload),
          );
        },
      }),
    MailboxClaimOccupiedError,
  );
  assert.equal(staleObserved, true);
  assert.deepEqual(readdirSync(claimDir), [freshOwner]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(claimDir, freshOwner))),
    freshPayload,
  );
  assert.throws(() => claimAgentMailbox(path), MailboxClaimOccupiedError);
  assert.deepEqual(readdirSync(claimDir), [freshOwner]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(claimDir, freshOwner))),
    freshPayload,
  );
});
test("empty startup claim directories fail closed", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  mkdirSync(join(path, ".starting"));
  assert.throws(() => claimAgentMailbox(path), /Unable to verify/);
});
test("mailbox cleanup preserves the owning startup claim until release", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  resetAgentMailbox(path);
  writeAgentState(path, state);
  const release = claimAgentMailbox(path);
  removeAgentMailbox(path);
  assert.equal(readAgentState(path), undefined);
  assert.equal(readdirSync(path).includes(".starting"), true);
  assert.throws(() => claimAgentMailbox(path), MailboxClaimOccupiedError);
  release();
  assert.equal(readdirSync(path).includes(".starting"), false);
  removeAgentMailbox(path);
});
test("malformed JSON and legacy protocol records are rejected", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  writeFileSync(join(path, "state.json"), "not json");
  assert.throws(() => readAgentState(path), /Unexpected token|JSON/);
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({ ...state, version: 3 }),
  );
  assert.throws(() => readAgentState(path), /protocol version/);
  const requestId = "66666666-6666-4666-8666-666666666666";
  writeFileSync(
    join(path, `request-${requestId}.json`),
    JSON.stringify({
      version: 3,
      runId: state.runId,
      requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "work",
      createdAt: Date.now(),
    }),
  );
  assert.throws(() => readRequest(path, requestId), /protocol version/);
  writeFileSync(
    join(path, "ask.json"),
    JSON.stringify({
      version: 3,
      askId: state.runId,
      requestId: state.runId,
      runId: state.runId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      piSessionId: state.piSessionId,
      question: "Choose",
      createdAt: Date.now(),
    }),
  );
  assert.throws(() => readAsk(path), /protocol version/);
  writeFileSync(
    join(path, `result-${requestId}.json`),
    JSON.stringify({
      version: 3,
      runId: state.runId,
      requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text: "done",
      completedAt: Date.now(),
    }),
  );
  assert.throws(() => readResult(path, requestId), /protocol version/);
});
test("lists malformed current mailbox state as bounded diagnostics", () => {
  const path = agentMailboxPath("unknown-workspace", "unknown-agent");
  mkdirSync(path, { recursive: true });
  try {
    for (const [kind, setup, expected] of [
      [
        "malformed JSON",
        () => writeFileSync(join(path, "state.json"), "not json"),
        /Unexpected token|JSON/,
      ],
      [
        "invalid shape",
        () =>
          writeFileSync(
            join(path, "state.json"),
            JSON.stringify({ ...state, extra: true }),
          ),
        /Unknown mailbox field/,
      ],
      [
        "oversized state",
        () => writeFileSync(join(path, "state.json"), "x".repeat(65 * 1024)),
        /Mailbox record is too large/,
      ],
      [
        "state read failure",
        () => mkdirSync(join(path, "state.json")),
        /EISDIR|directory/,
      ],
    ] as const) {
      setup();
      const issue = listAgentStateIssues().find(
        (candidate) => candidate.path === path,
      );
      assert.ok(issue, kind);
      assert.match(issue.diagnostic, expected);
      assert.match(issue.diagnostic, /^Mailbox state unavailable:/);
      assert.ok(
        issue.diagnostic.length <= 256 + "Mailbox state unavailable: ".length,
      );
      if (kind === "state read failure") rmdirSync(join(path, "state.json"));
      else unlinkSync(join(path, "state.json"));
    }
  } finally {
    try {
      if (statSync(join(path, "state.json")).isDirectory())
        rmdirSync(join(path, "state.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    removeAgentMailbox(path);
  }
});
test("valid results round-trip and atomic temporary files are removed", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const result = {
    version: 4 as const,
    runId: state.runId,
    requestId: "66666666-6666-4666-8666-666666666666",
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed" as const,
    text: "completed",
    contextUsage: { tokens: 5, contextWindow: 10, percent: 50 },
    completedAt: Date.now(),
  };
  writeResult(path, result);
  assert.deepEqual(readResult(path, result.requestId), result);
  assert.equal(
    readdirSync(path).some((name) => name.endsWith(".tmp")),
    false,
  );
  removeResult(path, result.requestId);
  assert.equal(readResult(path, result.requestId), undefined);
});
test("request and result size limits remain independent", () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const request = {
    version: 4 as const,
    runId: state.runId,
    requestId: "77777777-7777-4777-8777-777777777777",
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task" as const,
    text: "x".repeat(1024 * 1024),
    createdAt: Date.now(),
  };
  assert.throws(() => writeRequest(path, request), /too large/);
  const result = {
    version: 4 as const,
    runId: state.runId,
    requestId: "88888888-8888-4888-8888-888888888888",
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed" as const,
    text: "x".repeat(4 * 1024 * 1024),
    completedAt: Date.now(),
  };
  assert.throws(() => writeResult(path, result), /too large/);
});
test("state waiter removes its abort listener after resolution", async () => {
  const path = mkdtempSync(join(tmpdir(), "pi-herdsman-mailbox-test-"));
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_name: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_name: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  const waiting = waitForState(path, () => true, {
    timeoutMs: 1000,
    signal,
  });
  writeAgentState(path, state);
  await waiting;
  assert.equal(listeners.size, 0);
});
