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
import { dirname, join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireProcessLock } from "./lock.ts";
import { test } from "node:test";
import {
  chiefMessagePath,
  chiefMessageBytes,
  COORDINATION_INBOX_SCAN_LIMIT,
  COORDINATION_MESSAGE_MAX_BYTES,
  COORDINATION_MESSAGE_KINDS,
  chiefMessageQuarantined,
  chiefLeaseIsHeld,
  claimChiefLease,
  claimManagerLease,
  managerDescriptorPath,
  readManagerDescriptor,
  readManagerDescriptorStatus,
  listManagerDescriptors,
  sameChiefDescriptor,
  sameManagerDescriptor,
  writeProjectAssignment,
  readProjectAssignment,
  listProjectAssignments,
  removeProjectAssignment,
  projectAssignmentPath,
  projectWorkSnapshot,
  projectMessageBytes,
  writeProjectMessage,
  listProjectMessages,
  removeProjectMessages,
  findProjectAssignmentBySession,
  PROJECT_ASSIGNMENT_MAX_BYTES,
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
  removeChiefMessage,
  writeLeadCoordinationState,
  type LeadCoordinationState,
  type OpenProjectWorkspace,
  type PeerLeadRecord,
  type ProjectMessage,
  type ChiefMessageRecord,
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
  version: 2,
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

test("coordination records require branch only for project message kinds", () => {
  const runtime = supervisionRuntime(socket());
  for (const kind of COORDINATION_MESSAGE_KINDS) {
    const projectMessage = kind === "project_assignment";
    const record = message({
      kind,
      ...(projectMessage ? { branch: "feat/bootstrap" } : {}),
    });
    const path = writeCoordinationMessage(record, runtime);
    assert.deepEqual(readCoordinationMessage(path), record, kind);
    for (const branch of projectMessage
      ? [undefined, "", " ", "x".repeat(513), 1, null]
      : ["feat/bootstrap", "", null]) {
      assert.throws(
        () => writeCoordinationMessage({ ...record, branch } as never, runtime),
        /Invalid Chief message record/,
        `${kind}: ${String(branch)}`,
      );
    }
    assert.throws(
      () =>
        writeCoordinationMessage(
          { ...record, unknown: true } as never,
          runtime,
        ),
      /Invalid Chief message record/,
    );
  }
  for (const kind of [
    "lead_ask",
    "chief_reply",
    "manager_ask",
    "manager_reply",
    "report_result",
  ])
    assert.throws(
      () => writeCoordinationMessage(message({ kind } as never), runtime),
      /Invalid Chief message record/,
      kind,
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
  assert.throws(
    () =>
      writeCoordinationMessage(
        {
          ...record,
          resultBindings: [
            { ref: "result:implementation#01", canonicalRef: `result:${id()}` },
          ],
        },
        runtime,
      ),
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
  assert.deepEqual(Object.keys(value).sort(), [
    "instanceId",
    "piSessionId",
    "updatedAt",
    "version",
  ]);
  assert.match(path.split(sep).join("/"), /coordinators\/[0-9a-f]{64}\.json$/);
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

test("lead coordination reader ignores only the retired pendingAsk field", () => {
  const runtime = supervisionRuntime(socket());
  const current = state("legacy-lead");
  const path = writeLeadCoordinationState(runtime, current);
  writeFileSync(
    path,
    JSON.stringify({ ...current, pendingAsk: { malformed: "ignored" } }),
  );

  const loaded = readLeadCoordinationState(runtime, current.piSessionId)!;
  assert.deepEqual(loaded, current);
  assert.equal("pendingAsk" in loaded, false);
  const projected = projectSupervision({
    agents: [
      {
        sessionId: current.piSessionId,
        sessionKind: "id",
        workspaceId: "workspace",
        paneId: "pane",
        tabId: "tab",
      },
    ],
    managedAgents: [],
    coordinationStates: [loaded],
  });
  assert.equal("pendingAsk" in projected.leads[0], false);

  for (const invalid of [
    { ...current, pendingAsk: {}, unexpected: true },
    { ...current, pendingAsk: {}, instanceId: "invalid" },
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    assert.throws(
      () => readLeadCoordinationState(runtime, current.piSessionId),
      /Unable to read/,
    );
  }
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

test("supervision authority is coordinator state, not metadata", () => {
  const piSessionId = "11111111-1111-4111-8111-111111111111";
  const lead = {
    sessionId: piSessionId,
    sessionKind: "id" as const,
    workspaceId: "api",
    paneId: "pane",
    tabId: "tab",
    displayName: "backend",
    runtimeState: "idle" as const,
    tokens: {
      pi_herdsman_name: "lead",
      pi_herdsman_herd_run_started_at: "1700000000000",
      pi_herdsman_context_percent: "61",
    },
  };
  const snapshot = projectSupervision({
    agents: [lead],
    managedAgents: [],
    supervisor: { piSessionId: "chief", leaseId: id(), role: "chief" },
    coordinationStates: [state(piSessionId)],
  });
  assert.deepEqual(snapshot.leads[0].availableActions, ["inspect", "message"]);
  const serialized = serializeSupervision(snapshot).leads[0];
  assert.equal(snapshot.leads[0].lead, piSessionId);
  assert.equal(serialized.session, piSessionId);
  assert.equal("lead" in serialized, false);
  assert.deepEqual(serialized.available_tools, [
    "staff_inspect",
    "staff_message",
  ]);
  assert.equal(snapshot.leads[0].displayName, "api/lead");
  assert.equal("display_name" in snapshot.leads[0], false);
  assert.equal(serialized.runtime_state, "idle");
  assert.equal(serialized.display_name, "api/lead");
  assert.equal(snapshot.leads[0]?.herdRunStartedAt, 1_700_000_000_000);
  assert.equal(snapshot.leads[0]?.contextPercent, 61);
  assert.equal("herdRunStartedAt" in serialized, false);
  assert.equal("contextPercent" in serialized, false);
  assert.equal("pending_ask_question" in serialized, false);
  assert.equal("needs_you" in serialized, false);

  const malformed = projectSupervision({
    agents: [
      {
        ...lead,
        tokens: {
          pi_herdsman_name: "lead",
          pi_herdsman_herd_run_started_at: "NaN",
          pi_herdsman_context_percent: "61%",
        },
      },
    ],
    managedAgents: [],
    coordinationStates: [state(piSessionId)],
  }).leads[0]!;
  assert.equal("herdRunStartedAt" in malformed, false);
  assert.equal("contextPercent" in malformed, false);
});

test("Manager supervision snapshot carries only its derived open workspaces", () => {
  const openWorkspaces: OpenProjectWorkspace[] = [
    {
      workspaceId: "root",
      branch: "feat/manager-supervision",
      path: "/repo",
      linked: false,
    },
    {
      workspaceId: "child",
      branch: "fix/manager-release-boundaries",
      path: "/repo-wt",
      linked: true,
    },
  ] as const;
  const snapshot = projectSupervision({
    agents: [],
    managedAgents: [],
    coordinationStates: [],
    openWorkspaces,
  });
  assert.deepEqual(snapshot.openWorkspaces, openWorkspaces);
  assert.deepEqual(
    snapshot.openWorkspaces?.map(({ workspaceId }) => workspaceId),
    ["root", "child"],
  );
  assert.equal(
    "openWorkspaces" in
      projectSupervision({
        agents: [],
        managedAgents: [],
        coordinationStates: [],
      }),
    false,
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
    const serializedLead = serializeSupervision(snapshot).leads[0];
    assert.equal(serializedLead.session, "lead");
    assert.equal("lead" in serializedLead, false);
    assert.deepEqual(serializedLead.available_tools, [
      "staff_inspect",
      ...(piSessionFile ? ["staff_transcript"] : []),
      "staff_message",
    ]);
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
  assert.equal(snapshot.leads[0]!.branch, "feat/supervision");
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

test("quarantined queued messages are excluded and non-blocking", () => {
  for (const kind of ["excluded", "new-message"] as const) {
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
    "From lead lead: ten",
    "From lead lead: twenty",
    "From lead lead: thirty",
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
  assert.match(content, /^From lead api\/backend: hello$/);
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

test("coordination envelopes identify senders without claiming recipient roles", async () => {
  const runtime = supervisionRuntime(socket());
  const routes = [
    {
      name: "Lead -> Chief",
      kind: "lead_message",
      senderRole: "lead",
      fromSessionId: "lead-session",
      recipientRole: "chief",
      toSessionId: "chief-from-lead",
      leadSessionId: "lead-session",
    },
    {
      name: "Lead -> Manager",
      kind: "lead_message",
      senderRole: "lead",
      fromSessionId: "lead-session",
      recipientRole: "manager",
      toSessionId: "manager-from-lead",
      leadSessionId: "lead-session",
    },
    {
      name: "Manager -> Chief",
      kind: "manager_message",
      senderRole: "manager",
      fromSessionId: "manager-session",
      recipientRole: "chief",
      toSessionId: "chief-from-manager",
      leadSessionId: "manager-session",
    },
    {
      name: "Chief -> Lead",
      kind: "chief_message",
      senderRole: "chief",
      fromSessionId: "chief-session",
      recipientRole: "lead",
      toSessionId: "lead-from-chief",
      leadSessionId: "lead-session",
    },
    {
      name: "Chief -> Manager",
      kind: "chief_message",
      senderRole: "chief",
      fromSessionId: "chief-session",
      recipientRole: "manager",
      toSessionId: "manager-from-chief",
      leadSessionId: "manager-session",
    },
  ];
  const traffic = routes.map((route) => {
    const record = message({
      kind: route.kind,
      fromSessionId: route.fromSessionId,
      toSessionId: route.toSessionId,
      leadSessionId: route.leadSessionId,
      text: "Which credential should I use?",
    });
    writeChiefMessage(record, runtime);
    return { route, record };
  });
  const delivered: { id: string; content: string }[] = [];
  for (const { route, record } of traffic) {
    assert.equal(
      await drainCoordinationInbox({
        runtime,
        sessionId: route.toSessionId,
        isAuthorized: (candidate) => candidate.id === record.id,
        isDelivered: () => false,
        sendMessage: (payload) =>
          delivered.push({
            id: (payload as any).details.id,
            content: (payload as any).content,
          }),
      }),
      1,
      route.name,
    );
  }
  for (const [index, { route, record }] of traffic.entries()) {
    assert.equal(delivered[index]!.id, record.id, route.name);
    assert.equal(
      delivered[index]!.content,
      `From ${route.senderRole} ${route.fromSessionId}: ${record.text}`,
      route.name,
    );
    assert.doesNotMatch(
      delivered[index]!.content,
      new RegExp(`\\bto ${route.recipientRole}\\b`),
      route.name,
    );
  }
  assert.ok(
    delivered.every(
      ({ content }) => Buffer.byteLength(content, "utf8") <= 8 * 1024,
    ),
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
    const lease = claimChiefLease({
      ...chiefIdentity(),
      piSessionFile: "/tmp/chief-session.jsonl",
    });
    assert.equal(chiefLeaseIsHeld(runtime), true);
    assert.deepEqual(readChiefDescriptor(runtime.descriptor), lease.descriptor);
    assert.equal(lease.descriptor.piSessionFile, "/tmp/chief-session.jsonl");
    assert.equal(
      sameChiefDescriptor(lease.descriptor, {
        ...lease.descriptor,
        piSessionFile: "/tmp/other-session.jsonl",
      }),
      false,
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

test("Chief lead projection supports fallback without dual-reporting Manager reports", () => {
  const makeLead = (sessionId: string) => ({
    sessionId,
    sessionKind: "id" as const,
    workspaceId: "workspace",
    paneId: `pane-${sessionId}`,
    tabId: `tab-${sessionId}`,
  });
  const agents = [makeLead("fallback-lead"), makeLead("manager-lead")];
  const coordinationStates = agents.map(({ sessionId }) => state(sessionId));
  const chiefFallback = projectSupervision({
    agents,
    managedAgents: [],
    coordinationStates,
    chiefSessionId: "chief",
  });
  assert.deepEqual(
    chiefFallback.leads.map(({ lead }) => lead),
    ["fallback-lead", "manager-lead"],
  );
  const managerHierarchy = projectSupervision({
    agents,
    managedAgents: [],
    coordinationStates,
    chiefSessionId: "chief",
    managerSupervisedLeadSessionIds: new Set(["manager-lead"]),
  });
  assert.deepEqual(
    managerHierarchy.leads.map(({ lead }) => lead),
    ["fallback-lead"],
  );
});

test("coordinator state and peer presence admit only Lead or Manager roles", () => {
  const runtime = supervisionRuntime(socket());
  for (const role of ["lead", "manager"] as const) {
    const value = state(`session-${role}`, { role });
    writeLeadCoordinationState(runtime, value);
    assert.deepEqual(
      readLeadCoordinationState(runtime, value.piSessionId),
      value,
    );
  }
  assert.throws(() =>
    writeLeadCoordinationState(
      runtime,
      state("chief", { role: "chief" as never }),
    ),
  );
  assert.throws(() =>
    writeLeadCoordinationState(
      runtime,
      state("bad", {
        unknown: true,
      }),
    ),
  );
  const peers = peerRuntime();
  const manager = peerRecord(peers, `manager-${id()}`, { role: "manager" });
  try {
    writePeerLeadRecord(peers, manager.record);
    assert.deepEqual(
      readPeerLeadRecord(peers, manager.record.piSessionId),
      manager.record,
    );
    assert.throws(() =>
      writePeerLeadRecord(peers, { ...manager.record, role: "chief" } as never),
    );
  } finally {
    manager.release();
  }
});

test("Manager leases are exclusive per root and fail closed on stale descriptor generations", () => {
  const runtime = supervisionRuntime(socket());
  const identity = {
    piSessionId: id(),
    piSessionFile: "/tmp/manager-session.jsonl",
    paneId: "pane",
    tabId: "tab",
    workspaceId: "root",
    repoKey: "repo",
  };
  const first = claimManagerLease(identity, runtime);
  const second = claimManagerLease(
    { ...identity, workspaceId: "other" },
    runtime,
  );
  try {
    assert.throws(() =>
      claimManagerLease({ ...identity, piSessionId: id() }, runtime),
    );
    assert.deepEqual(
      new Set(
        listManagerDescriptors(runtime).map((record) => record.workspaceId),
      ),
      new Set(["root", "other"]),
    );
    assert.deepEqual(readManagerDescriptor(runtime, "root"), first.descriptor);
    assert.equal(first.descriptor.piSessionFile, identity.piSessionFile);
    const path = join(
      runtime.managers,
      `${createHash("sha256").update("root").digest("hex")}.json`,
    );
    writeFileSync(
      path,
      JSON.stringify({
        ...first.descriptor,
        claim: { ...first.descriptor.claim, id: id() },
      }),
    );
    assert.throws(
      () => readManagerDescriptor(runtime, "root"),
      /generation changed/,
    );
    assert.equal(
      listManagerDescriptors(runtime).some(
        (record) => record.workspaceId === "root",
      ),
      false,
    );
    first.release();
    assert.equal(statSync(path).isFile(), true);
    assert.equal(
      sameManagerDescriptor(first.descriptor, {
        ...first.descriptor,
        leaseId: id(),
      }),
      false,
    );
    assert.equal(
      sameManagerDescriptor(first.descriptor, {
        ...first.descriptor,
        piSessionFile: "/tmp/other-session.jsonl",
      }),
      false,
    );
  } finally {
    first.release();
    second.release();
  }
});

test("Manager descriptor status distinguishes live, incomplete, and absent authority", () => {
  const runtime = supervisionRuntime(socket());
  const workspaceId = "root";
  assert.equal(readManagerDescriptorStatus(runtime, workspaceId), undefined);
  const lease = claimManagerLease(
    {
      piSessionId: id(),
      paneId: "pane",
      tabId: "tab",
      workspaceId,
      repoKey: "repo",
    },
    runtime,
  );
  try {
    assert.deepEqual(readManagerDescriptorStatus(runtime, workspaceId), {
      descriptor: lease.descriptor,
      live: true,
    });
    unlinkSync(managerDescriptorPath(runtime, workspaceId));
    assert.throws(
      () => readManagerDescriptorStatus(runtime, workspaceId),
      /Unable to verify Manager descriptor/,
    );
  } finally {
    lease.release();
  }
  assert.equal(readManagerDescriptorStatus(runtime, workspaceId), undefined);
});

test("project assignments are scoped by repository and branch, strict, and removable", () => {
  const runtime = supervisionRuntime(socket());
  const assignment = {
    version: 2 as const,
    id: id(),
    repoKey: "repo-A",
    branch: "herdsman/test",
    text: "task",
  };
  writeProjectAssignment(runtime, assignment);
  const path = projectAssignmentPath(
    runtime,
    assignment.repoKey,
    assignment.branch,
  );
  assert.equal(
    path,
    join(
      runtime.assignments,
      createHash("sha256").update(assignment.repoKey).digest("hex"),
      `${createHash("sha256").update(assignment.branch).digest("hex")}.json`,
    ),
  );
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort(),
    ["version", "id", "repoKey", "branch", "text"].sort(),
  );
  assertPosixMode(path, 0o600);
  assertPosixMode(dirname(path), 0o700);
  assert.deepEqual(listProjectAssignments(runtime, assignment.repoKey), [
    assignment,
  ]);
  assert.deepEqual(
    readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    assignment,
  );
  assert.equal(
    findProjectAssignmentBySession(
      runtime,
      assignment.repoKey,
      assignment.id,
    )[0]?.branch,
    assignment.branch,
  );
  assert.deepEqual(
    findProjectAssignmentBySession(runtime, assignment.repoKey, "elsewhere"),
    [],
  );
  for (const invalid of [
    { branch: undefined },
    {
      resultBindings: [
        { ref: "result:implementation#01", canonicalRef: `result:${id()}` },
      ],
    },
    ...["phase", "paneId", "tabId", "updatedAt", "base"].map((key) => ({
      [key]: "old",
    })),
  ])
    assert.throws(
      () =>
        writeProjectAssignment(runtime, {
          ...assignment,
          ...invalid,
        } as never),
      /Invalid project assignment/,
    );
  assert.throws(() =>
    writeProjectAssignment(runtime, {
      ...assignment,
      extra: true,
    } as never),
  );
  assert.throws(() =>
    writeProjectAssignment(runtime, {
      ...assignment,
      text: "é".repeat(PROJECT_ASSIGNMENT_MAX_BYTES),
    }),
  );
  assert.deepEqual(
    readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    assignment,
  );
  writeFileSync(
    path,
    JSON.stringify({ ...assignment, repoKey: "repo", unknown: 1 }),
  );
  assert.throws(
    () => listProjectAssignments(runtime, assignment.repoKey),
    (error) => {
      assert.ok(error.message.includes(`${path}: invalid assignment schema`));
      assert.doesNotMatch(error.message, /task/);
      return true;
    },
  );
  writeFileSync(path, JSON.stringify({ ...assignment, repoKey: "repo-B" }));
  assert.throws(
    () => readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    (error) => {
      assert.ok(
        error.message.includes(`${path}: assignment identity mismatch`),
      );
      return true;
    },
  );
  writeFileSync(path, JSON.stringify({ ...assignment, phase: "active" }));
  assert.throws(
    () => readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    /invalid assignment schema/,
  );
  writeFileSync(path, '{"text":"private task details"');
  assert.throws(
    () => readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    (error) => {
      assert.ok(error.message.includes(`${path}: invalid JSON`));
      assert.doesNotMatch(error.message, /private task details/);
      return true;
    },
  );
  writeFileSync(
    path,
    JSON.stringify({
      ...assignment,
      branch: "other",
      text: "private task details",
    }),
  );
  assert.throws(
    () => readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    (error) => {
      assert.ok(
        error.message.includes(`${path}: assignment identity mismatch`),
      );
      assert.doesNotMatch(error.message, /private task details/);
      return true;
    },
  );
  writeFileSync(path, "x".repeat(PROJECT_ASSIGNMENT_MAX_BYTES + 1));
  assert.throws(
    () => readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    (error) => {
      assert.ok(error.message.includes(`${path}: file is too large`));
      return true;
    },
  );
  writeProjectAssignment(runtime, assignment);
  const second = { ...assignment, branch: "herdsman/second" };
  writeProjectAssignment(runtime, second);
  assert.deepEqual(
    findProjectAssignmentBySession(runtime, assignment.repoKey, assignment.id),
    [second, assignment],
  );
  assert.deepEqual(listProjectAssignments(runtime, assignment.repoKey), [
    second,
    assignment,
  ]);
  writeFileSync(join(dirname(path), `${assignment.id}.json`), "draft");
  assert.deepEqual(listProjectAssignments(runtime, assignment.repoKey), [
    second,
    assignment,
  ]);
  writeFileSync(
    projectAssignmentPath(runtime, assignment.repoKey, "wrong"),
    JSON.stringify(assignment),
  );
  assert.throws(
    () => listProjectAssignments(runtime, assignment.repoKey),
    /assignment identity mismatch/,
  );
  removeProjectAssignment(runtime, assignment.repoKey, "wrong");
  removeProjectAssignment(runtime, assignment.repoKey, second.branch);
  removeProjectAssignment(runtime, assignment.repoKey, assignment.branch);
  assert.equal(
    readProjectAssignment(runtime, assignment.repoKey, assignment.branch),
    undefined,
  );

  const otherRepo = { ...assignment, repoKey: "repo-B" };
  writeProjectAssignment(runtime, assignment);
  writeProjectAssignment(runtime, otherRepo);
  assert.notEqual(
    projectAssignmentPath(runtime, assignment.repoKey, assignment.branch),
    projectAssignmentPath(runtime, otherRepo.repoKey, otherRepo.branch),
  );
  assert.deepEqual(listProjectAssignments(runtime, assignment.repoKey), [
    assignment,
  ]);
  assert.deepEqual(listProjectAssignments(runtime, otherRepo.repoKey), [
    otherRepo,
  ]);
  assert.deepEqual(
    readProjectAssignment(runtime, assignment.repoKey, "herdsman/unassigned"),
    undefined,
  );
  assert.deepEqual(
    readProjectAssignment(runtime, otherRepo.repoKey, otherRepo.branch),
    otherRepo,
  );
  assert.deepEqual(
    findProjectAssignmentBySession(runtime, otherRepo.repoKey, assignment.id),
    [otherRepo],
  );
  removeProjectAssignment(runtime, otherRepo.repoKey, otherRepo.branch);
  assert.deepEqual(listProjectAssignments(runtime, assignment.repoKey), [
    assignment,
  ]);
});

test("project work derives active, paused, or conflict from runtime placement", () => {
  const assignment = {
    version: 2 as const,
    id: id(),
    repoKey: "repo",
    branch: "feat/work",
    text: "  implement\nwork  ",
  };
  const worktree = { branch: assignment.branch, open_workspace_id: "child" };
  const lead = {
    lead: assignment.id,
    workspaceId: "child",
    runtimeState: "working" as const,
  };
  const cases = [
    {
      name: "exact live Lead",
      input: { worktrees: [worktree], leads: [lead] },
      status: "active",
      runtimeState: "working",
    },
    {
      name: "paused with its worktree retained",
      input: { worktrees: [worktree], leads: [] },
      status: "paused",
    },
    {
      name: "paused without worktree",
      input: { worktrees: [], leads: [] },
      status: "paused",
    },
    {
      name: "duplicate worktree topology",
      input: { worktrees: [worktree, worktree], leads: [] },
      status: "conflict",
      issue: "project runtime identity is ambiguous",
    },
    {
      name: "duplicate exact Lead inventory",
      input: { worktrees: [worktree], leads: [lead, lead] },
      status: "conflict",
      issue: "project runtime identity is ambiguous",
    },
    {
      name: "assigned Lead in wrong workspace",
      input: {
        worktrees: [worktree],
        leads: [{ ...lead, workspaceId: "other" }],
      },
      status: "conflict",
      issue: "assigned Lead is running outside its branch worktree",
    },
    {
      name: "different Lead in worktree",
      input: { worktrees: [worktree], leads: [{ ...lead, lead: "other" }] },
      status: "conflict",
      issue: "another Lead is active in this worktree",
    },
  ] as const;

  for (const scenario of cases) {
    const snapshot = projectWorkSnapshot({
      assignments: [assignment],
      worktrees: scenario.input.worktrees,
      leads: scenario.input.leads,
    });
    assert.equal(snapshot[0]!.status, scenario.status, scenario.name);
    assert.equal(snapshot[0]!.task, "implement work", scenario.name);
    assert.equal(Object.hasOwn(snapshot[0]!, "result"), false, scenario.name);
    assert.equal(
      snapshot[0]!.runtimeState,
      "runtimeState" in scenario ? scenario.runtimeState : undefined,
      scenario.name,
    );
    assert.equal(
      snapshot[0]!.issue,
      "issue" in scenario ? scenario.issue : undefined,
      scenario.name,
    );
  }
});

test("project messages are durable, assignment-scoped, bounded, and removable", () => {
  const runtime = supervisionRuntime(socket());
  const assignment = {
    version: 2 as const,
    id: id(),
    repoKey: "repo",
    branch: "feat/bootstrap",
    text: "task",
  };
  const record: ProjectMessage = {
    version: 2,
    id: id(),
    repoKey: assignment.repoKey,
    branch: assignment.branch,
    fromSessionId: assignment.id,
    text: "Review handoff",
    createdAt: 10,
  };
  writeProjectAssignment(runtime, assignment);
  writeProjectMessage(record, runtime);
  assert.deepEqual(
    listProjectMessages(runtime, assignment.repoKey, assignment.branch),
    [record],
  );
  assert.deepEqual(
    listProjectMessages(runtime, assignment.repoKey, assignment.branch),
    [record],
    "observation does not consume the retained message",
  );
  assert.equal(
    projectMessageBytes(record),
    Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
  );
  assert.deepEqual(
    listProjectMessages(runtime, "other-repo", assignment.branch),
    [],
  );
  assert.throws(
    () =>
      writeProjectMessage(
        { ...record, text: "x".repeat(COORDINATION_MESSAGE_MAX_BYTES) },
        runtime,
      ),
    /Invalid project message/,
  );
  assert.throws(
    () => writeProjectMessage({ ...record, fromSessionId: "" }, runtime),
    /Invalid project message/,
  );
  assert.throws(
    () =>
      writeProjectMessage(
        {
          ...record,
          resultBindings: [
            { ref: "result:implementation#01", canonicalRef: `result:${id()}` },
          ],
        },
        runtime,
      ),
    /Invalid project message/,
  );
  removeProjectMessages(runtime, assignment.repoKey, assignment.branch);
  assert.deepEqual(
    listProjectMessages(runtime, assignment.repoKey, assignment.branch),
    [],
  );
});

test("project assignment uses durable project transport, not Manager message framing", async () => {
  const runtime = supervisionRuntime(socket());
  const session = id();
  const instruction = "implement work";
  const record = message({
    kind: "project_assignment",
    fromSessionId: "former-manager",
    toSessionId: session,
    leadSessionId: session,
    branch: "feat/bootstrap",
    text: instruction,
  });
  writeChiefMessage(record, runtime);
  const delivered: any[] = [];
  assert.equal(
    await drainCoordinationInbox({
      runtime,
      sessionId: session,
      isAuthorized: (candidate) =>
        candidate.toSessionId === session && candidate.text === instruction,
      isDelivered: () => false,
      sendMessage: (payload) => {
        delivered.push(payload);
      },
    }),
    1,
  );
  assert.equal(delivered[0].customType, "pi-herdsman-project_assignment");
  assert.equal(
    delivered[0].content,
    `Project assignment for branch ${record.branch}:\n\n${instruction}`,
  );
  assert.doesNotMatch(delivered[0].content, new RegExp(session));
  assert.deepEqual(delivered[0].details, {
    id: record.id,
    leaseId: record.leaseId,
    fromSessionId: record.fromSessionId,
    leadSessionId: session,
    branch: record.branch,
  });
});
