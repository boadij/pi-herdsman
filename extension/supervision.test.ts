import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireProcessLock } from "./lock.ts";
import { test } from "node:test";
import {
  chiefMessagePath,
  chiefMessageBytes,
  COORDINATION_INBOX_SCAN_LIMIT,
  COORDINATION_MESSAGE_MAX_BYTES,
  chiefMessageQuarantined,
  chiefAskQueued,
  chiefAskMessageId,
  chiefLeaseIsHeld,
  claimChiefLease,
  coordinationMessageBytes,
  coordinationMessagePath,
  drainCoordinationInbox,
  listCoordinationMessagePaths,
  listPeerLeadRecords,
  peerLeadLockPath,
  peerRuntime,
  readCoordinationMessage,
  readPeerLeadRecord,
  removePeerLeadRecord,
  removeCoordinationMessage,
  supervisionRuntime,
  invalidateLeadCoordinationState,
  LEAD_STATE_MAX_BYTES,
  listChiefMessagePaths,
  normalizeHerdrLifecycleState,
  projectSupervision,
  quarantineChiefMessage,
  readChiefMessage,
  readLeadCoordinationState,
  readChiefDescriptor,
  serializeSupervision,
  sessionLeadRoleState,
  writeChiefMessage,
  writeCoordinationMessage,
  writePeerLeadRecord,
  writeChiefAskMessage,
  removeChiefMessage,
  writeLeadCoordinationState,
  validLeadCoordinationQuestion,
  type ChiefMessageRecord,
  type LeadCoordinationState,
  type PeerLeadRecord,
} from "./supervision.ts";

const socket = () =>
  join(mkdtempSync(join(tmpdir(), "supervision-test-")), "sock");
const id = () => randomUUID();
const state = (
  piSessionId: string,
  extra: Partial<LeadCoordinationState> = {},
): LeadCoordinationState => ({
  version: 1,
  instanceId: id(),
  piSessionId,
  updatedAt: 1,
  ...extra,
});
const message = (
  extra: Partial<ChiefMessageRecord> = {},
): ChiefMessageRecord => ({
  version: 1,
  id: id(),
  leaseId: id(),
  kind: "lead_message",
  fromSessionId: "lead",
  toSessionId: "chief",
  leadSessionId: "lead",
  text: "hello",
  createdAt: 1,
  ...extra,
});

function assertPosixMode(path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777;
  if (process.platform !== "win32") assert.equal(actual, expected);
}

const askMessage = (
  extra: Partial<ChiefMessageRecord> = {},
): ChiefMessageRecord =>
  message({
    id: id(),
    kind: "lead_ask",
    askId: id(),
    text: "question",
    ...extra,
  });

function peerRecord(
  runtime: ReturnType<typeof peerRuntime>,
  piSessionId = `lead-${id()}`,
  extra: Partial<PeerLeadRecord> = {},
): { record: PeerLeadRecord; release: () => void } {
  const lease = acquireProcessLock(peerLeadLockPath(runtime, piSessionId), {
    name: "Lead peer presence",
  });
  return {
    record: {
      version: 1,
      piSessionId,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      claim: lease.claim,
      updatedAt: 1,
      ...extra,
    },
    release: lease.release,
  };
}

test("lead ask publication is idempotent and retains the first record", () => {
  const runtime = supervisionRuntime(socket());
  const first = askMessage();
  const duplicate = { ...first, createdAt: first.createdAt + 1 };
  assert.equal(
    writeChiefAskMessage(first, runtime),
    writeChiefAskMessage(duplicate, runtime),
  );
  assert.deepEqual(
    readChiefMessage(chiefMessagePath(runtime, first.toSessionId, first.id)),
    first,
  );
  assert.equal(listChiefMessagePaths(runtime, first.toSessionId).length, 1);
});

test("lead ask publication rejects a conflicting same-ID record", () => {
  const runtime = supervisionRuntime(socket());
  const first = askMessage();
  const conflict = { ...first, text: "different question" };
  writeChiefAskMessage(first, runtime);
  assert.throws(() => writeChiefAskMessage(conflict, runtime), /conflicting/);
  assert.equal(
    readChiefMessage(chiefMessagePath(runtime, first.toSessionId, first.id))
      .text,
    first.text,
  );
});

test("lead ask publication never replaces a quarantined same-ID record", () => {
  const runtime = supervisionRuntime(socket());
  const first = askMessage();
  const replacement = { ...first, text: "replacement" };
  writeChiefMessage(first, runtime);
  quarantineChiefMessage(runtime, first.toSessionId, first.id);
  assert.throws(
    () => writeChiefAskMessage(replacement, runtime),
    /quarantined/,
  );
  assert.equal(
    chiefMessageQuarantined(runtime, first.toSessionId, first.id),
    true,
  );
  assert.equal(
    readChiefMessage(chiefMessagePath(runtime, first.toSessionId, first.id))
      .text,
    first.text,
  );
});

test("message writes recover a stale crash-held lock", () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  const path = chiefMessagePath(runtime, record.toSessionId, record.id);
  const lock = `${path}.lock`;
  const staleId = id();
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lock, `2147483647-${staleId}`),
    JSON.stringify({ pid: 2147483647, id: staleId }),
  );

  writeChiefMessage(record, runtime);
  assert.deepEqual(readChiefMessage(path), record);
  assert.throws(() => statSync(lock), /ENOENT/);
});

test("message locks fail closed for live and malformed owners", () => {
  for (const owner of [`${process.pid}-${id()}`, "not-an-owner"]) {
    const runtime = supervisionRuntime(socket());
    const record = message();
    const lock = `${chiefMessagePath(runtime, record.toSessionId, record.id)}.lock`;
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lock, owner),
      owner === "not-an-owner"
        ? "not-json"
        : JSON.stringify({
            pid: process.pid,
            id: owner.slice(`${process.pid}-`.length),
          }),
    );

    assert.throws(
      () => writeChiefMessage(record, runtime),
      /in progress|verify/,
    );
    assert.deepEqual(readdirSync(lock), [owner]);
  }
});

test("chief message sizing is the exact serialized UTF-8 record size", () => {
  const record = message({ text: "héllo" });
  assert.equal(
    chiefMessageBytes(record),
    Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
  );
});

test("chief message admission accepts exactly 8 KiB and rejects the next byte", () => {
  const runtime = supervisionRuntime(socket());
  const prefix = "é\t".repeat(32);
  const recordFor = (suffix: string) => message({ text: prefix + suffix });
  let low = 0;
  let high = COORDINATION_MESSAGE_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      chiefMessageBytes(recordFor("x".repeat(middle))) <=
      COORDINATION_MESSAGE_MAX_BYTES
    )
      low = middle;
    else high = middle - 1;
  }
  const exact = recordFor("x".repeat(low));
  const over = recordFor("x".repeat(low + 1));
  assert.equal(chiefMessageBytes(exact), COORDINATION_MESSAGE_MAX_BYTES);
  assert.equal(chiefMessageBytes(over), COORDINATION_MESSAGE_MAX_BYTES + 1);
  writeChiefMessage(exact, runtime);
  assert.throws(
    () => writeChiefMessage(over, runtime),
    /Chief message record is too large/,
  );
});

test("peer lead presence requires a live generation and excludes corruption", () => {
  const runtime = peerRuntime(socket());
  const fixture = peerRecord(runtime, "lead-presence");
  const path = join(
    runtime.peers,
    `${createHash("sha256").update("lead-presence").digest("hex")}.json`,
  );
  try {
    assert.equal(writePeerLeadRecord(runtime, fixture.record), path);
    assert.deepEqual(
      readPeerLeadRecord(runtime, "lead-presence"),
      fixture.record,
    );
    assert.deepEqual(listPeerLeadRecords(runtime), [fixture.record]);
    assertPosixMode(path, 0o600);

    writeFileSync(path, "not-json", "utf8");
    assert.throws(
      () => readPeerLeadRecord(runtime, "lead-presence"),
      /Unable to read peer lead record/,
    );
    assert.deepEqual(listPeerLeadRecords(runtime), []);
  } finally {
    unlinkSync(path);
    fixture.release();
  }
});

test("peer lead presence rejects a changed or missing process-lock generation", () => {
  const runtime = peerRuntime(socket());
  const fixture = peerRecord(runtime, "lead-generation");
  writePeerLeadRecord(runtime, fixture.record);
  fixture.release();
  assert.throws(
    () => readPeerLeadRecord(runtime, "lead-generation"),
    /Unable to (read peer lead record|verify process lock)/,
  );
  assert.deepEqual(listPeerLeadRecords(runtime), []);
  unlinkSync(
    join(
      runtime.peers,
      `${createHash("sha256").update("lead-generation").digest("hex")}.json`,
    ),
  );
});

test("peer lead enumeration excludes arbitrary and duplicate JSON", () => {
  const runtime = peerRuntime(socket());
  const fixture = peerRecord(runtime, "lead-enumeration");
  const arbitraryPath = join(runtime.peers, "arbitrary.json");
  const duplicatePath = join(
    runtime.peers,
    `${createHash("sha256").update("duplicate-name").digest("hex")}.json`,
  );
  try {
    writePeerLeadRecord(runtime, fixture.record);
    writeFileSync(arbitraryPath, JSON.stringify(fixture.record));
    writeFileSync(duplicatePath, JSON.stringify(fixture.record));
    assert.deepEqual(listPeerLeadRecords(runtime), [fixture.record]);
  } finally {
    removePeerLeadRecord(runtime, fixture.record.piSessionId, fixture.record);
    fixture.release();
    unlinkSync(arbitraryPath);
    unlinkSync(duplicatePath);
  }
});

test("peer lead enumeration scans every canonical record before liveness filtering", () => {
  const runtime = peerRuntime(socket());
  const fixtures = Array.from(
    { length: COORDINATION_INBOX_SCAN_LIMIT + 1 },
    (_, index) => peerRecord(runtime, `lead-enumeration-${index}`),
  );
  const malformedPath = join(runtime.peers, `${"0".repeat(64)}.json`);
  const dead = peerRecord(runtime, "dead-0");
  const deadFilename = `${createHash("sha256")
    .update(dead.record.piSessionId)
    .digest("hex")}.json`;
  try {
    for (const fixture of fixtures)
      writePeerLeadRecord(runtime, fixture.record);
    writeFileSync(malformedPath, "not-json", "utf8");
    writePeerLeadRecord(runtime, dead.record);
    dead.release();

    const records = listPeerLeadRecords(runtime);
    const expected = fixtures
      .map((fixture) => ({
        filename: `${createHash("sha256")
          .update(fixture.record.piSessionId)
          .digest("hex")}.json`,
        record: fixture.record,
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map(({ record }) => record);
    assert.equal(records.length, fixtures.length);
    assert.deepEqual(records, expected);
    assert.ok(
      deadFilename <
        `${createHash("sha256")
          .update(expected[0]!.piSessionId)
          .digest("hex")}.json`,
    );
    assert.ok(
      records.some(
        (record) => record.piSessionId === fixtures.at(-1)!.record.piSessionId,
      ),
    );
  } finally {
    for (const fixture of fixtures) {
      removePeerLeadRecord(runtime, fixture.record.piSessionId, fixture.record);
      fixture.release();
    }
    removePeerLeadRecord(runtime, dead.record.piSessionId);
    unlinkSync(malformedPath);
  }
});

test("peer message records use strict validation and the shared UTF-8 bound", () => {
  const runtime = supervisionRuntime(socket());
  const record = message({
    kind: "peer_message",
    fromSessionId: "lead-a",
    toSessionId: "lead-b",
    leadSessionId: "lead-a",
    text: "peer update",
  });
  const path = writeCoordinationMessage(record, runtime);
  assert.deepEqual(readCoordinationMessage(path), record);
  assert.equal(
    coordinationMessagePath(runtime, record.toSessionId, record.id),
    path,
  );
  assert.equal(coordinationMessageBytes(record), chiefMessageBytes(record));
  assert.throws(
    () =>
      writeCoordinationMessage({ ...record, kind: "peer" } as never, runtime),
    /Invalid Chief message record/,
  );
  assert.throws(
    () => writeCoordinationMessage({ ...record, askId: id() }, runtime),
    /Invalid Chief message record/,
  );

  const prefix = "é\t".repeat(32);
  const recordFor = (suffix: string) =>
    message({ kind: "peer_message", text: prefix + suffix });
  let low = 0;
  let high = COORDINATION_MESSAGE_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      coordinationMessageBytes(recordFor("x".repeat(middle))) <=
      COORDINATION_MESSAGE_MAX_BYTES
    )
      low = middle;
    else high = middle - 1;
  }
  const exact = recordFor("x".repeat(low));
  const over = recordFor("x".repeat(low + 1));
  assert.equal(coordinationMessageBytes(exact), COORDINATION_MESSAGE_MAX_BYTES);
  assert.equal(
    coordinationMessageBytes(over),
    COORDINATION_MESSAGE_MAX_BYTES + 1,
  );
  writeCoordinationMessage(exact, runtime);
  assert.throws(
    () => writeCoordinationMessage(over, runtime),
    /Chief message record is too large/,
  );
});

test("generic coordination transport orders and renders peer messages", async () => {
  const runtime = supervisionRuntime(socket());
  const older = message({
    id: id(),
    kind: "peer_message",
    fromSessionId: "lead-a",
    toSessionId: "lead-b",
    leadSessionId: "lead-a",
    text: "older",
    createdAt: 1,
  });
  const newer = { ...older, id: id(), text: "newer", createdAt: 2 };
  writeCoordinationMessage(newer, runtime);
  writeCoordinationMessage(older, runtime);
  const sent: any[] = [];
  assert.equal(
    await drainCoordinationInbox({
      runtime,
      sessionId: "lead-b",
      isAuthorized: (candidate) => candidate.kind === "peer_message",
      isDelivered: () => false,
      sendMessage: (value) => sent.push(value),
    }),
    2,
  );
  assert.deepEqual(
    sent.map((value) => value.details.id),
    [older.id, newer.id],
  );
  assert.match(sent[0].content, /^Peer message from lead-a: older$/);
  assert.doesNotMatch(sent[0].content, /to lead lead-b/);
  assert.deepEqual(listCoordinationMessagePaths(runtime, "lead-b"), []);
  assert.equal(removeCoordinationMessage, removeChiefMessage);
});

test("peer presence and inbox transport are shared across socket runtimes", async () => {
  const socketA = socket();
  const socketB = socket();
  const runtimeA = supervisionRuntime(socketA);
  const runtimeB = supervisionRuntime(socketB);
  const peersA = peerRuntime(socketA);
  const peersB = peerRuntime(socketB);
  const peerA = peerRecord(peersA, "lead-a");
  const peerB = peerRecord(peersB, "lead-b");
  try {
    assert.notEqual(runtimeA.root, runtimeB.root);
    assert.equal(peersA.root, peersB.root);
    writePeerLeadRecord(peersA, peerA.record);
    writePeerLeadRecord(peersB, peerB.record);
    assert.deepEqual(
      listPeerLeadRecords(peersB)
        .map((record) => record.piSessionId)
        .sort(),
      ["lead-a", "lead-b"],
    );

    const chiefRecord = message({ toSessionId: "chief-b" });
    writeChiefMessage(chiefRecord, runtimeA);
    assert.deepEqual(listChiefMessagePaths(runtimeB, "chief-b"), []);
    assert.deepEqual(listChiefMessagePaths(runtimeA, "chief-b"), [
      chiefMessagePath(runtimeA, "chief-b", chiefRecord.id),
    ]);

    const record = message({
      kind: "peer_message",
      fromSessionId: "lead-a",
      toSessionId: "lead-b",
      leadSessionId: "lead-a",
      leaseId: peerA.record.claim.id,
      text: "shared peer inbox",
    });
    writeCoordinationMessage(record, peersA);
    const sent: any[] = [];
    assert.equal(
      await drainCoordinationInbox({
        runtime: peersB,
        sessionId: "lead-b",
        isAuthorized: (candidate) =>
          candidate.kind === "peer_message" &&
          candidate.fromSessionId === "lead-a" &&
          candidate.toSessionId === "lead-b",
        isDelivered: () => false,
        sendMessage: (value) => sent.push(value),
      }),
      1,
    );
    assert.equal(sent[0].details.id, record.id);
    assert.match(
      sent[0].content,
      /^Peer message from lead-a: shared peer inbox$/,
    );
    assert.doesNotMatch(sent[0].content, /to lead lead-b/);
    assert.deepEqual(listCoordinationMessagePaths(peersA, "lead-b"), []);
  } finally {
    removePeerLeadRecord(peersA, peerA.record.piSessionId, peerA.record);
    removePeerLeadRecord(peersB, peerB.record.piSessionId, peerB.record);
    peerA.release();
    peerB.release();
  }
});

test("peer receiver authorization rejects a self-addressed record", async () => {
  const runtime = peerRuntime(socket());
  const record = message({
    kind: "peer_message",
    fromSessionId: "lead-self",
    toSessionId: "lead-self",
    leadSessionId: "lead-self",
  });
  writeCoordinationMessage(record, runtime);
  const sent: any[] = [];
  assert.equal(
    await drainCoordinationInbox({
      runtime,
      sessionId: "lead-self",
      isAuthorized: (candidate) =>
        candidate.kind === "peer_message" &&
        candidate.toSessionId === "lead-self" &&
        candidate.fromSessionId !== candidate.toSessionId &&
        candidate.leadSessionId === candidate.fromSessionId,
      isDelivered: () => false,
      sendMessage: (value) => sent.push(value),
    }),
    0,
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(listCoordinationMessagePaths(runtime, "lead-self"), []);
});

test("lead coordination state is strict, private, bounded, and atomic", () => {
  const runtime = supervisionRuntime(socket());
  const value = state("lead");
  const path = writeLeadCoordinationState(runtime, value);
  assert.deepEqual(readLeadCoordinationState(runtime, "lead"), value);
  assert.match(path.split(sep).join("/"), /leads\/[0-9a-f]{64}\.json$/);
  assertPosixMode(path, 0o600);
  assertPosixMode(runtime.leads, 0o700);
  assert.throws(() =>
    writeLeadCoordinationState(runtime, { ...value, version: 2 } as never),
  );
  assert.throws(() =>
    writeLeadCoordinationState(runtime, {
      ...value,
      availability: "ready",
    } as never),
  );
  writeFileSync(path, JSON.stringify({ ...value, piSessionId: "other" }));
  assert.throws(
    () => readLeadCoordinationState(runtime, "lead"),
    /Unable to read/,
  );
});

test("lead coordination state admits the exact UTF-8 16 KiB boundary", () => {
  const runtime = supervisionRuntime(socket());
  const askId = id();
  const instanceId = id();
  const prefix = "é\t".repeat(32);
  const stateFor = (text: string): LeadCoordinationState =>
    state("lead", {
      instanceId,
      pendingAsk: { askId, question: "Q", text: prefix + text },
    });
  const serializedBytes = (value: LeadCoordinationState) =>
    Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
  let low = 0;
  let high = LEAD_STATE_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(stateFor("x".repeat(middle))) <= LEAD_STATE_MAX_BYTES)
      low = middle;
    else high = middle - 1;
  }
  const exact = stateFor("x".repeat(low));
  const over = stateFor("x".repeat(low + 1));
  assert.equal(serializedBytes(exact), LEAD_STATE_MAX_BYTES);
  assert.equal(serializedBytes(over), LEAD_STATE_MAX_BYTES + 1);
  writeLeadCoordinationState(runtime, exact);
  assert.deepEqual(readLeadCoordinationState(runtime, "lead"), exact);
  assert.throws(
    () => writeLeadCoordinationState(runtime, over),
    /Lead coordination state is too large/,
  );
});

test("Chief message records reject removed coordination fields", () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  const path = writeChiefMessage(record, runtime);
  writeFileSync(path, JSON.stringify({ ...record, availability: "ready" }));
  assert.throws(() => readChiefMessage(path), /Invalid Chief message record/);
});

test("queued traffic remains correlated to the exact lead session after restart", async () => {
  const runtime = supervisionRuntime(socket());
  const original = message({ leadSessionId: "lead", fromSessionId: "lead" });
  writeChiefMessage(original, runtime);
  let delivered = 0;
  await drainCoordinationInbox({
    runtime,
    sessionId: original.toSessionId,
    isAuthorized: (record) =>
      record.leadSessionId === "lead" && record.fromSessionId === "lead",
    isDelivered: () => false,
    sendMessage: () => {
      delivered++;
    },
  });
  assert.equal(delivered, 1);
  assert.deepEqual(listChiefMessagePaths(runtime, original.toSessionId), []);
});

test("lead questions use one UTF-8-safe coordination limit", () => {
  assert.equal(validLeadCoordinationQuestion("x".repeat(1024)), true);
  assert.equal(validLeadCoordinationQuestion("x".repeat(1025)), false);
  assert.equal(validLeadCoordinationQuestion("é".repeat(1024)), false);
  assert.equal(validLeadCoordinationQuestion(" ".repeat(1024)), false);
});

test("ask correlation ignores ephemeral lead instance IDs", () => {
  const askId = id();
  const leaseId = id();
  assert.equal(
    chiefAskMessageId("lead", askId, leaseId),
    chiefAskMessageId("lead", askId, leaseId),
  );
  assert.notEqual(
    chiefAskMessageId("other-lead", askId, leaseId),
    chiefAskMessageId("lead", askId, leaseId),
  );
});

test("lead role state requires a canonical durable tool baseline", () => {
  const valid = {
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "lead", leadTools: ["read", "bash", "agent", "chief"] },
  };
  assert.equal(sessionLeadRoleState([]), undefined);
  const parsed = sessionLeadRoleState([valid]);
  assert.deepEqual(parsed, valid.data);
  assert.notEqual(parsed?.leadTools, valid.data.leadTools);
  assert.deepEqual(
    sessionLeadRoleState([
      { ...valid, data: { role: "chief", leadTools: [] } },
    ]),
    { role: "chief", leadTools: [] },
  );
  for (const data of [
    undefined,
    [],
    { role: "lead" },
    { role: "invalid", leadTools: [] },
    { role: "lead", leadTools: "read" },
    { role: "lead", leadTools: ["read", "read"] },
    { role: "lead", leadTools: [""] },
    { role: "lead", leadTools: [1] },
    { ...valid.data, extra: true },
  ]) {
    const malformed = { ...valid, data };
    assert.throws(
      () => sessionLeadRoleState([valid, malformed]),
      /invalid pi-herdsman-role/,
    );
    assert.deepEqual(sessionLeadRoleState([malformed, valid]), valid.data);
  }
});

test("supervision authority is coordination state, not metadata", () => {
  const lead = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "api",
    paneId: "pane",
    tabId: "tab",
    displayName: "backend",
    runtimeState: "idle" as const,
  };
  const snapshot = projectSupervision({
    agents: [lead],
    managedAgents: [],
    coordinationStates: [
      state("lead", {
        pendingAsk: {
          askId: id(),
          question: "OAuth?",
          text: "Question: OAuth?",
        },
      }),
    ],
  });
  assert.equal(snapshot.leads[0].needsYou, true);
  assert.deepEqual(snapshot.leads[0].availableActions, [
    "inspect",
    "message",
    "reply",
  ]);
  assert.equal(snapshot.leads[0].displayName, "api/lead-lead");
  assert.equal("display_name" in snapshot.leads[0], false);
  assert.equal(serializeSupervision(snapshot).leads[0].runtime_state, "idle");
  assert.equal(
    serializeSupervision(snapshot).leads[0].display_name,
    "api/lead-lead",
  );
  assert.equal(
    serializeSupervision(snapshot).leads[0].pending_ask_question,
    "OAuth?",
  );
});

test("live lead actions advertise transcript for persisted session candidates", () => {
  const agent = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "workspace",
    paneId: "pane",
    tabId: "tab",
  };
  for (const piSessionFile of [undefined, "/tmp/lead.jsonl"]) {
    const snapshot = projectSupervision({
      agents: [{ ...agent, piSessionFile }],
      managedAgents: [],
      coordinationStates: [state("lead")],
    });
    assert.deepEqual(snapshot.leads[0]?.availableActions, [
      "inspect",
      ...(piSessionFile ? ["transcript"] : []),
      "message",
    ]);
    assert.equal(snapshot.leads[0]?.piSessionFile, piSessionFile);
    const serialized = JSON.stringify(serializeSupervision(snapshot));
    assert.equal(serialized.includes("piSessionFile"), false);
    assert.equal(serialized.includes("/tmp/lead.jsonl"), false);
  }
});

test("supervision presentation preserves provenance and naming fallbacks", () => {
  const namedSession = "11111111-1111-4111-8111-111111111111";
  const unnamedSessionA = "22222222-2222-4222-8222-222222222222";
  const unnamedSessionB = "33333333-3333-4333-8333-333333333333";
  const base = (sessionId: string) => ({
    sessionId,
    sessionKind: "id" as const,
    workspaceId: "workspace",
    paneId: `pane-${sessionId}`,
    tabId: `tab-${sessionId}`,
  });
  const snapshot = projectSupervision({
    agents: [
      {
        ...base(namedSession),
        herdrName: "opaque_0123456789abcdef",
        tabLabel: "tab label",
        tokens: { pi_herdsman_name: "pi-session" },
        display_agent: "mac-system-theme",
      },
      base(unnamedSessionA),
      base(unnamedSessionB),
    ] as any,
    managedAgents: [],
    coordinationStates: [
      state(namedSession),
      state(unnamedSessionA),
      state(unnamedSessionB),
    ],
    workspaceProvenance: new Map([
      [
        "workspace",
        {
          repoName: "pi-herdsman",
          branch: "feat/supervision",
          workspaceLabel: "wrong-workspace-label",
        },
      ],
    ]),
  });
  assert.equal(
    snapshot.leads.find((lead) => lead.lead === namedSession)!.displayName,
    "pi-herdsman/feat/supervision/pi-session",
  );
  assert.equal(
    snapshot.leads.some((lead) =>
      lead.displayName.includes("mac-system-theme"),
    ),
    false,
  );
  assert.deepEqual(
    snapshot.leads.map((lead) => lead.lead),
    [unnamedSessionA, unnamedSessionB, namedSession],
  );
  assert.deepEqual(
    snapshot.leads
      .filter((lead) => lead.lead !== namedSession)
      .map((lead) => lead.displayName),
    [
      "pi-herdsman/feat/supervision/lead-22222222",
      "pi-herdsman/feat/supervision/lead-33333333",
    ],
  );
  {
    const sessions = [
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
    ];
    const agents = sessions.map((sessionId) => ({
      sessionId,
      sessionKind: "id" as const,
      workspaceId: "workspace",
      paneId: `pane-${sessionId}`,
      tabId: `tab-${sessionId}`,
      sessionName: "persisted session",
      herdrName: "unstable-herdr-name",
      tabLabel: "unstable tab label",
    }));
    agents[1]!.tokens = { pi_herdsman_name: "none" };
    agents[2]!.tokens = { pi_herdsman_name: "meaningful token" };
    const snapshot = projectSupervision({
      agents,
      managedAgents: [],
      coordinationStates: sessions.map((sessionId) => state(sessionId)),
      workspaceProvenance: new Map([
        ["workspace", { workspaceLabel: "project" }],
      ]),
    });
    assert.deepEqual(
      snapshot.leads.map((lead) => lead.displayName),
      ["project/meaningful token", "project/none", "project/persisted session"],
    );
  }
  {
    const makeAgent = (sessionId: string, workspaceId: string) => ({
      sessionId,
      sessionKind: "id" as const,
      workspaceId,
      paneId: `${workspaceId}-pane`,
      tabId: `${workspaceId}-tab`,
    });
    const sessions = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ];
    const snapshot = projectSupervision({
      agents: [
        makeAgent(sessions[0]!, "explicit"),
        makeAgent(sessions[1]!, "cwd"),
        makeAgent(sessions[2]!, "id"),
      ],
      managedAgents: [],
      coordinationStates: sessions.map((sessionId) => state(sessionId)),
      workspaceProvenance: new Map([
        ["explicit", { workspaceLabel: "my-workspace" }],
        ["cwd", { workspaceCwd: "/tmp/project" }],
      ]),
    });
    assert.deepEqual(
      new Set(snapshot.leads.map((lead) => lead.displayName)),
      new Set([
        "my-workspace/lead-44444444",
        "project/lead-55555555",
        "id/lead-66666666",
      ]),
    );
  }
});

test("supervision fails closed on invalid live identities and coordination records", () => {
  const lead = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "w",
    paneId: "p",
    tabId: "t",
  };
  const valid = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "w",
    paneId: "p",
    tabId: "t",
  };
  assert.deepEqual(
    projectSupervision({
      agents: [lead, { ...lead, paneId: "other" }],
      coordinationStates: [state("lead"), state("lead")],
      managedAgents: [],
    }).leads,
    [],
  );
  assert.equal(
    projectSupervision({
      agents: [{ ...valid, paneId: "" }, valid],
      managedAgents: [],
      coordinationStates: [state("lead")],
    }).leads.length,
    1,
  );
  assert.deepEqual(
    projectSupervision({
      agents: [valid, { ...valid, sessionId: "other" }],
      managedAgents: [],
      coordinationStates: [state("lead"), state("other")],
    }).leads,
    [],
  );
});

test("lead session binds queued traffic and invalidation removes authority", () => {
  const runtime = supervisionRuntime(socket());
  const old = state("lead", { instanceId: id() });
  writeLeadCoordinationState(runtime, old);
  const record = message({ leadSessionId: "lead", fromSessionId: "lead" });
  writeChiefMessage(record, runtime);
  const current = state("lead", { instanceId: id() });
  writeLeadCoordinationState(runtime, current);
  let delivered = false;
  return drainCoordinationInbox({
    runtime,
    sessionId: "chief",
    isAuthorized: (candidate) => candidate.leadSessionId === "lead",
    isDelivered: () => false,
    sendMessage: () => {
      delivered = true;
    },
  }).then(() => {
    assert.equal(delivered, true);
    assert.equal(listChiefMessagePaths(runtime, "chief").length, 0);
    invalidateLeadCoordinationState(runtime, "lead");
    assert.equal(readLeadCoordinationState(runtime, "lead"), undefined);
  });
});

test("stale lead invalidation preserves a replacement generation", () => {
  const runtime = supervisionRuntime(socket());
  const generationA = state("lead", { instanceId: id() });
  const generationB = state("lead", { instanceId: id() });
  writeLeadCoordinationState(runtime, generationA);
  writeLeadCoordinationState(runtime, generationB);
  invalidateLeadCoordinationState(runtime, "lead", generationA.instanceId);
  assert.deepEqual(readLeadCoordinationState(runtime, "lead"), generationB);
});

test("validated agent evidence aggregates descendants without identity matching", () => {
  const lead = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "w",
    paneId: "p",
    tabId: "t",
  };
  const snapshot = projectSupervision({
    agents: [lead],
    coordinationStates: [state("lead")],
    managedAgents: [
      {
        piSessionId: "a",
        ownerSessionId: "lead",
        workspaceId: "w",
        paneId: "a",
        runtimeState: "working",
      },
      {
        piSessionId: "b",
        ownerSessionId: "a",
        workspaceId: "w",
        paneId: "b",
        runtimeState: "settling",
      },
      {
        piSessionId: "c",
        ownerSessionId: "b",
        workspaceId: "w",
        paneId: "c",
        runtimeState: "blocked",
      },
    ],
  });
  assert.deepEqual(snapshot.leads[0].agentCounts, {
    active: 2,
    blocked: 1,
    total: 3,
  });
  const serialized = serializeSupervision(snapshot).leads[0];
  assert.deepEqual(serialized.agent_counts, {
    active: 2,
    blocked: 1,
    total: 3,
  });
  assert.deepEqual(serialized.agents, [
    { id: "a", label: "a", state: "working" },
    { id: "b", label: "b", state: "settling" },
    { id: "c", label: "c", state: "blocked" },
  ]);
});

test("supervision preserves lifecycle evidence and counts only active states", () => {
  for (const runtimeState of [
    "idle",
    "working",
    "blocked",
    "settling",
    "starting",
    "done",
    "unknown",
    "lost",
  ] as const) {
    const snapshot = projectSupervision({
      agents: [
        {
          sessionId: "lead",
          sessionKind: "id",
          workspaceId: "w",
          paneId: "p",
          tabId: "t",
          runtimeState,
        },
      ],
      coordinationStates: [state("lead")],
      managedAgents: [
        {
          piSessionId: "child",
          ownerSessionId: "lead",
          workspaceId: "w",
          paneId: "child",
          runtimeState,
        },
      ],
    });
    const serialized = serializeSupervision(snapshot).leads[0];
    assert.equal(serialized.runtime_state, runtimeState);
    assert.equal(serialized.agents[0].state, runtimeState);
    assert.deepEqual(serialized.agent_counts, {
      active: Number(
        ["working", "settling", "starting"].includes(runtimeState),
      ),
      blocked: Number(runtimeState === "blocked"),
      total: 1,
    });
  }
});

test("supervision excludes descendants of ambiguous agent owners", () => {
  const lead = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "w",
    paneId: "p",
    tabId: "t",
  };
  const snapshot = projectSupervision({
    agents: [lead],
    coordinationStates: [state("lead")],
    managedAgents: [
      {
        piSessionId: "parent",
        ownerSessionId: "lead",
        workspaceId: "w",
        paneId: "a",
        runtimeState: "working",
      },
      {
        piSessionId: "parent",
        ownerSessionId: "other-lead",
        workspaceId: "w",
        paneId: "b",
        runtimeState: "working",
      },
      {
        piSessionId: "child",
        ownerSessionId: "parent",
        workspaceId: "w",
        paneId: "c",
        runtimeState: "working",
      },
    ],
  });
  assert.deepEqual(snapshot.leads[0].agentCounts, {
    active: 0,
    blocked: 0,
    total: 0,
  });
});

test("terminal malformed inbox files do not gate a later send", () => {
  const runtime = supervisionRuntime(socket());
  const malformedId = id();
  const malformedPath = chiefMessagePath(runtime, "lead", malformedId);
  mkdirSync(malformedPath.slice(0, malformedPath.lastIndexOf("/")), {
    recursive: true,
  });
  writeFileSync(malformedPath, "{ truncated", "utf8");
  assert.equal(readFileSync(malformedPath, "utf8"), "{ truncated");
  assert.equal(chiefMessageQuarantined(runtime, "lead", malformedId), false);
});

test("quarantined queued messages are excluded, non-blocking, and reconcilable", () => {
  for (const kind of ["excluded", "new-message", "lead-ask"] as const) {
    const runtime = supervisionRuntime(socket());
    if (kind === "excluded") {
      const record = message({ kind: "lead_message" });
      writeChiefMessage(record, runtime);
      quarantineChiefMessage(runtime, record.toSessionId, record.id);
      assert.equal(
        chiefMessageQuarantined(runtime, record.toSessionId, record.id),
        true,
      );
      assert.equal(
        listChiefMessagePaths(runtime, record.toSessionId).length,
        1,
      );
    } else if (kind === "new-message") {
      const first = message({ kind: "chief_message", toSessionId: "lead" });
      const second = message({ kind: "chief_message", toSessionId: "lead" });
      writeChiefMessage(first, runtime);
      quarantineChiefMessage(runtime, first.toSessionId, first.id);
      writeChiefMessage(second, runtime);
      assert.equal(listChiefMessagePaths(runtime, "lead").length, 2);
    } else {
      const record = message({
        kind: "lead_ask",
        askId: id(),
        fromSessionId: "lead",
        leadSessionId: "lead",
        toSessionId: "chief",
      });
      writeChiefMessage(record, runtime);
      quarantineChiefMessage(runtime, "chief", record.id);
      assert.equal(
        chiefAskQueued(runtime, "chief", "lead", record.askId!),
        false,
      );
      writeChiefMessage(record, runtime);
      assert.equal(
        chiefAskQueued(runtime, "chief", "lead", record.askId!),
        true,
      );
    }
  }
});

test("removing a chief message removes its quarantine marker", () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  writeChiefMessage(record, runtime);
  quarantineChiefMessage(runtime, record.toSessionId, record.id);
  removeChiefMessage(runtime, record.toSessionId, record.id);
  assert.throws(() =>
    readChiefMessage(chiefMessagePath(runtime, "chief", record.id)),
  );
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    false,
  );
  removeChiefMessage(runtime, record.toSessionId, record.id);
  quarantineChiefMessage(runtime, record.toSessionId, record.id);
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    true,
  );
  removeChiefMessage(runtime, record.toSessionId, record.id);
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    false,
  );
});

test("re-quarantining a message accepts an existing marker", () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  writeChiefMessage(record, runtime);
  quarantineChiefMessage(runtime, record.toSessionId, record.id);
  assert.doesNotThrow(() =>
    quarantineChiefMessage(runtime, record.toSessionId, record.id),
  );
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    true,
  );
});

test("inbox draining skips quarantined messages and retains the record", async () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  const path = writeChiefMessage(record, runtime);
  quarantineChiefMessage(runtime, record.toSessionId, record.id);
  let authorized = 0;
  let sent = false;
  await drainCoordinationInbox({
    runtime,
    sessionId: record.toSessionId,
    isAuthorized: () => {
      authorized += 1;
      return true;
    },
    isDelivered: () => false,
    sendMessage: () => {
      sent = true;
    },
  });
  assert.equal(sent, false);
  assert.equal(authorized, 0);
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    true,
  );
  assert.deepEqual(listChiefMessagePaths(runtime, record.toSessionId), [path]);
  assert.equal(readChiefMessage(path).id, record.id);
});

test("inbox rechecks quarantine immediately before delivery", async () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  writeChiefMessage(record, runtime);
  let sent = false;
  await drainCoordinationInbox({
    runtime,
    sessionId: record.toSessionId,
    isAuthorized: () => true,
    isDelivered: () => false,
    sendMessage: () => {
      sent = true;
    },
    transaction: {
      begin: () => ({}),
      revalidate: (_token, phase) => {
        if (phase === "before-send")
          quarantineChiefMessage(runtime, record.toSessionId, record.id);
      },
      clear: () => {},
    },
  });
  assert.equal(sent, false);
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    true,
  );
  assert.equal(
    readChiefMessage(chiefMessagePath(runtime, record.toSessionId, record.id))
      .id,
    record.id,
  );
});

test("inbox rechecks quarantine before accepting an already-delivered record", async () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  writeChiefMessage(record, runtime);
  let accepted = false;
  await drainCoordinationInbox({
    runtime,
    sessionId: record.toSessionId,
    isAuthorized: () => true,
    isDelivered: () => true,
    sendMessage: () => {},
    accepted: () => {
      accepted = true;
    },
    transaction: {
      begin: () => ({}),
      revalidate: (_token, phase) => {
        if (phase === "already-delivered")
          quarantineChiefMessage(runtime, record.toSessionId, record.id);
      },
      clear: () => {},
    },
  });
  assert.equal(accepted, false);
  assert.equal(
    chiefMessageQuarantined(runtime, record.toSessionId, record.id),
    true,
  );
});

test("inbox orders valid records by createdAt and retains transient failures", async () => {
  const runtime = supervisionRuntime(socket());
  const records = [
    message({ createdAt: 20, text: "twenty" }),
    message({ createdAt: 10, text: "ten" }),
    message({ createdAt: 30, text: "thirty" }),
  ];
  for (const record of records) writeChiefMessage(record, runtime);
  assert.equal(listChiefMessagePaths(runtime, "chief").length, 3);
  const seen: string[] = [];
  const cleared: string[] = [];
  await drainCoordinationInbox({
    runtime,
    sessionId: "chief",
    isAuthorized: () => {
      throw new Error("temporary");
    },
    isDelivered: () => false,
    sendMessage: () => {},
    transaction: {
      begin: (record) => record.id,
      revalidate: () => {},
      clear: (token) => cleared.push(token as string),
    },
  });
  assert.equal(listChiefMessagePaths(runtime, "chief").length, 3);
  assert.equal(cleared.length, 3);
  await drainCoordinationInbox({
    runtime,
    sessionId: "chief",
    isAuthorized: () => true,
    isDelivered: () => false,
    sendMessage: (payload) => {
      seen.push((payload as any).content);
    },
  });
  assert.deepEqual(seen, [
    "From lead lead to chief chief: ten",
    "From lead lead to chief chief: twenty",
    "From lead lead to chief chief: thirty",
  ]);
});

test("inbox ordering parses beyond the filename batch bound", () => {
  const runtime = supervisionRuntime(socket());
  for (let i = 0; i < 40; i++)
    writeChiefMessage(
      message({
        id: `00000000-0000-4000-8000-${String(40 - i).padStart(12, "0")}`,
        createdAt: i,
      }),
      runtime,
    );
  const paths = listChiefMessagePaths(runtime, "chief");
  assert.equal(paths.length, 32);
  assert.equal(readChiefMessage(paths[0]).createdAt, 0);
  assert.equal(readChiefMessage(paths[31]).createdAt, 31);
});

test("terminal authorization rejection deletes, and sender is model-visible", async () => {
  const runtime = supervisionRuntime(socket());
  const record = message({
    fromSessionId: "api/backend",
    leadSessionId: "api/backend",
  });
  writeChiefMessage(record, runtime);
  let content = "";
  await drainCoordinationInbox({
    runtime,
    sessionId: "chief",
    isAuthorized: () => true,
    isDelivered: () => false,
    sendMessage: (payload) => {
      content = (payload as any).content;
    },
  });
  assert.match(content, /^From lead api\/backend to chief chief: hello$/);
  const rejected = message();
  writeChiefMessage(rejected, runtime);
  await drainCoordinationInbox({
    runtime,
    sessionId: "chief",
    isAuthorized: () => false,
    isDelivered: () => false,
    sendMessage: () => {},
  });
  assert.equal(listChiefMessagePaths(runtime, "chief").length, 0);
});

test("in-flight authorization cleanup becomes a no-op after invalidation", async () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  writeChiefMessage(record, runtime);
  let rejected = false;
  await drainCoordinationInbox({
    runtime,
    sessionId: "chief",
    isAuthorized: () => false,
    isDelivered: () => false,
    sendMessage: () => {},
    rejected: () => {
      rejected = true;
    },
    transaction: {
      begin: () => ({ valid: true }),
      revalidate: (_token, phase) => {
        if (phase === "before-rejection") throw new Error("shutdown");
      },
      clear: () => {},
    },
  });
  assert.equal(rejected, false);
  assert.equal(listChiefMessagePaths(runtime, "chief").length, 1);
});

test("both directions identify the actual sender and target in bounded content", async () => {
  const runtime = supervisionRuntime(socket());
  const askId = id();
  const leadAsk = message({
    kind: "lead_ask",
    fromSessionId: "lead-session",
    toSessionId: "chief-session",
    leadSessionId: "lead-session",
    askId,
    text: "Which credential should I use?",
  });
  const chiefReply = message({
    kind: "chief_reply",
    fromSessionId: "chief-session",
    toSessionId: "lead-session",
    leadSessionId: "lead-session",
    askId,
    text: "Use the service account.",
  });
  writeChiefMessage(leadAsk, runtime);
  writeChiefMessage(chiefReply, runtime);
  const content: string[] = [];
  await drainCoordinationInbox({
    runtime,
    sessionId: "chief-session",
    isAuthorized: () => true,
    isDelivered: () => false,
    sendMessage: (payload) => content.push((payload as any).content),
  });
  await drainCoordinationInbox({
    runtime,
    sessionId: "lead-session",
    isAuthorized: () => true,
    isDelivered: () => false,
    sendMessage: (payload) => content.push((payload as any).content),
  });
  assert.deepEqual(content, [
    "From lead lead-session to chief chief-session: Which credential should I use?",
    "From chief chief-session to lead lead-session: Use the service account.",
  ]);
  assert.ok(
    content.every((value) => Buffer.byteLength(value, "utf8") <= 8 * 1024),
  );
});

test("lifecycle normalization uses current Herdr fields and fails closed", () => {
  for (const [fields, expected] of [
    [{ agent_status: "working", status: "idle" }, "working"],
    [{ status: "blocked" }, "unknown"],
    [{ state: "working" }, "unknown"],
  ] as const) {
    assert.equal(normalizeHerdrLifecycleState(fields), expected);
  }
});

const chiefIdentity = () => ({
  piSessionId: id(),
  paneId: "pane",
  workspaceId: "workspace",
});

test("Chief lease authority rejects strict malformed lock claims", () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socket();
  try {
    for (const malformed of ["id", "pid", "missing", "unexpected"] as const) {
      const lease = claimChiefLease(chiefIdentity());
      const descriptor = readChiefDescriptor(lease.runtime.descriptor);
      if (malformed === "unexpected") {
        const owner = readdirSync(lease.runtime.lock)[0]!;
        writeFileSync(
          join(lease.runtime.lock, owner),
          JSON.stringify({ ...descriptor.claim, unexpected: true }),
        );
      } else {
        writeFileSync(
          lease.runtime.descriptor,
          JSON.stringify({
            ...descriptor,
            claim:
              malformed === "id"
                ? { ...descriptor.claim, id: id() }
                : malformed === "pid"
                  ? { ...descriptor.claim, pid: descriptor.claim.pid + 1 }
                  : { pid: descriptor.claim.pid },
          }),
        );
      }
      assert.equal(chiefLeaseIsHeld(lease.runtime), false);
      if (malformed === "unexpected") {
        assert.throws(
          () => lease.release(),
          /Unable to verify Chief supervision lease ownership/,
        );
        rmSync(lease.runtime.lock, { recursive: true, force: true });
      } else {
        lease.release();
      }
      if (malformed === "missing") {
        assert.equal(
          readFileSync(lease.runtime.descriptor, "utf8").length > 0,
          true,
        );
      }
      rmSync(lease.runtime.descriptor, { force: true });
    }
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("Chief release does not remove a valid replacement retaining the lease ID", () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socket();
  try {
    const lease = claimChiefLease(chiefIdentity());
    const replacement = {
      ...lease.descriptor,
      piSessionId: id(),
      paneId: "replacement-pane",
    };
    writeFileSync(lease.runtime.descriptor, JSON.stringify(replacement));
    lease.release();
    assert.deepEqual(
      readChiefDescriptor(lease.runtime.descriptor),
      replacement,
    );
    rmSync(lease.runtime.descriptor, { force: true });
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("Chief lease fails closed on an empty canonical claim directory", () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socket();
  try {
    const runtime = supervisionRuntime();
    mkdirSync(runtime.root, { recursive: true });
    mkdirSync(runtime.lock, 0o700);
    assert.throws(() => claimChiefLease(chiefIdentity()), /Unable to verify/);
    assert.equal(readdirSync(runtime.lock).length, 0);
    rmSync(runtime.lock, { recursive: true, force: true });
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("Chief lease reclaims a stale claim and publishes a matching new pair", () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socket();
  try {
    const runtime = supervisionRuntime();
    mkdirSync(runtime.root, { recursive: true });
    mkdirSync(runtime.lock, 0o700);
    const staleId = id();
    writeFileSync(
      join(runtime.lock, `2147483647-${staleId}`),
      JSON.stringify({ pid: 2147483647, id: staleId }),
    );
    const lease = claimChiefLease(chiefIdentity());
    assert.equal(chiefLeaseIsHeld(runtime), true);
    assert.deepEqual(
      readChiefDescriptor(runtime.descriptor).claim,
      lease.descriptor.claim,
    );
    lease.release();
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("Chief descriptor write failure releases the lock for recovery", () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socket();
  try {
    const runtime = supervisionRuntime();
    mkdirSync(runtime.root, { recursive: true });
    mkdirSync(runtime.descriptor, 0o700);
    assert.throws(() => claimChiefLease(chiefIdentity()));
    rmSync(runtime.descriptor, { recursive: true, force: true });
    const lease = claimChiefLease(chiefIdentity());
    assert.equal(chiefLeaseIsHeld(runtime), true);
    lease.release();
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});
