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
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  chiefMessagePath,
  chiefMessageBytes,
  CHIEF_MESSAGE_MAX_BYTES,
  chiefMessageQuarantined,
  chiefAskQueued,
  chiefAskMessageId,
  chiefLeaseIsHeld,
  claimChiefLease,
  drainChiefInbox,
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
  sessionLeadRole,
  writeChiefMessage,
  writeChiefAskMessage,
  removeChiefMessage,
  writeLeadCoordinationState,
  validLeadCoordinationQuestion,
  type ChiefMessageRecord,
  type LeadCoordinationState,
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
  let high = CHIEF_MESSAGE_MAX_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      chiefMessageBytes(recordFor("x".repeat(middle))) <=
      CHIEF_MESSAGE_MAX_BYTES
    )
      low = middle;
    else high = middle - 1;
  }
  const exact = recordFor("x".repeat(low));
  const over = recordFor("x".repeat(low + 1));
  assert.equal(chiefMessageBytes(exact), CHIEF_MESSAGE_MAX_BYTES);
  assert.equal(chiefMessageBytes(over), CHIEF_MESSAGE_MAX_BYTES + 1);
  writeChiefMessage(exact, runtime);
  assert.throws(
    () => writeChiefMessage(over, runtime),
    /Chief message record is too large/,
  );
});

test("lead coordination state is strict, private, bounded, and atomic", () => {
  const runtime = supervisionRuntime(socket());
  const value = state("lead");
  const path = writeLeadCoordinationState(runtime, value);
  assert.deepEqual(readLeadCoordinationState(runtime, "lead"), value);
  assert.match(path, /leads\/[0-9a-f]{64}\.json$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(runtime.leads).mode & 0o777, 0o700);
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
  await drainChiefInbox({
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

test("append-only lead role recovery parses only the latest matching entry", () => {
  const malformed = {
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "invalid" },
  };
  const valid = {
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "lead" },
  };
  assert.throws(() => sessionLeadRole([valid, malformed]), /invalid/);
  assert.equal(sessionLeadRole([malformed, valid]), "lead");
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

test("every observed live lead state exposes inspect and message", () => {
  const agent = {
    sessionId: "lead",
    sessionKind: "id" as const,
    workspaceId: "workspace",
    paneId: "pane",
    tabId: "tab",
  };
  for (const runtimeState of ["idle", "working", "blocked"] as const) {
    const snapshot = projectSupervision({
      agents: [{ ...agent, runtimeState }],
      managedAgents: [],
      coordinationStates: [state("lead")],
    });
    assert.deepEqual(snapshot.leads[0]?.availableActions, [
      "inspect",
      "message",
    ]);
    assert.equal(snapshot.leads[0]?.runtimeState, runtimeState);
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
  return drainChiefInbox({
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
        runtimeState: "blocked",
      },
    ],
  });
  assert.deepEqual(snapshot.leads[0].agentCounts, {
    working: 1,
    blocked: 1,
    total: 2,
  });
  const serialized = serializeSupervision(snapshot).leads[0];
  assert.deepEqual(serialized.agent_counts, {
    working: 1,
    blocked: 1,
    total: 2,
  });
  assert.deepEqual(serialized.agents, [
    { id: "a", label: "a", state: "working" },
    { id: "b", label: "b", state: "blocked" },
  ]);
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
    working: 0,
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

test("inbox draining skips quarantined messages and retains the record", async () => {
  const runtime = supervisionRuntime(socket());
  const record = message();
  const path = writeChiefMessage(record, runtime);
  quarantineChiefMessage(runtime, record.toSessionId, record.id);
  let authorized = 0;
  let sent = false;
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
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
  await drainChiefInbox({
    runtime,
    sessionId: "chief-session",
    isAuthorized: () => true,
    isDelivered: () => false,
    sendMessage: (payload) => content.push((payload as any).content),
  });
  await drainChiefInbox({
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
    [{ status: "blocked" }, "blocked"],
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
      lease.release();
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
