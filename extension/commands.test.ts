import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mock, test, type TestContext } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { acquireProcessLock, claimProcessLock } from "./lock.ts";
import {
  claimChiefLease as claimChiefLeaseRaw,
  listProjectAssignments,
  projectAssignmentPath,
  listCoordinationMessagePaths,
  managerDescriptorPath,
  removeChiefMessage,
  readChiefMessage,
  readManagerDescriptor,
  listPeerLeadRecords,
  peerLeadLockPath,
  peerRuntime,
  readPeerLeadRecord,
  removePeerLeadRecord,
  supervisionRuntime,
  readLeadCoordinationState,
  sessionLeadRoleState,
  writeLeadCoordinationState as writeLeadCoordinationStateRaw,
  writeProjectAssignment,
  writeChiefMessage as writeChiefMessageRaw,
  writeCoordinationMessage as writeCoordinationMessageRaw,
  writePeerLeadRecord as writePeerLeadRecordRaw,
} from "./supervision.ts";
import { OperationError } from "./errors.ts";
import { resultPath } from "./storage.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  NON_PI_AGENT,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  StatusWidget,
  AGENT_ID,
  HERDSMAN_BUILD,
  OTHER_HERDSMAN_BUILD,
  WORKSPACE,
  agentFromState,
  buildStatusRows,
  cascadeExecutor,
  defaultFixtureIdentity,
  discoverAgent,
  discoverAgentDefinitions,
  fakeContext,
  fakePi,
  fakeAgentContext,
  herdrAlias,
  isApiSnapshot,
  isAgentList,
  isPaneList,
  isTabList,
  listResponse,
  managedState,
  nativeSessions,
  projectContextCwds,
  readAgentState,
  readResult,
  realFs,
  recoveryIdentity,
  registerExtension,
  renderRunningOptions,
  resetAgentMailbox,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setAgentEnvironment,
  startupExecutor,
  stopSummary,
  testGate,
  visibleWidth,
  agentMailboxPath,
  writeResult,
  writeAgentState,
} from "./support.ts";
const claimChiefLease = (identity: any) =>
  claimChiefLeaseRaw({ ...identity, build: identity.build ?? HERDSMAN_BUILD });
const writeLeadCoordinationState = (runtime: any, state: any) =>
  writeLeadCoordinationStateRaw(runtime, {
    ...state,
    build: state.build ?? HERDSMAN_BUILD,
  });
const writeChiefMessage = (record: any, runtime?: any) =>
  writeChiefMessageRaw(
    { ...record, build: record.build ?? HERDSMAN_BUILD },
    runtime,
  );
const writeCoordinationMessage = (record: any, runtime?: any) =>
  writeCoordinationMessageRaw(
    { ...record, build: record.build ?? HERDSMAN_BUILD },
    runtime,
  );
const writePeerLeadRecord = (runtime: any, record: any) =>
  writePeerLeadRecordRaw(runtime, {
    ...record,
    build: record.build ?? HERDSMAN_BUILD,
  });
const { readConfig, updateConfig } = await import("./config.ts");
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) =>
  pi.tools.find((candidate) => candidate.name === `agent_${name}`)!;
test("session stats sums Pi usage entries and proven nested sessions once", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const dir = mkdtempSync(join(tmpdir(), "herdsman-usage-"));
  const childPath = join(dir, "child.jsonl");
  const nestedPath = join(dir, "nested.jsonl");
  writeFileSync(childPath, "");
  writeFileSync(nestedPath, "");
  const childId = "22222222-2222-4222-8222-222222222222";
  const nestedId = "33333333-3333-4333-8333-333333333333";
  const usage = (
    input: number,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    total = 0,
  ) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  const edge = (owner: string, id: string, path: string, label: string) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "agent_delegate",
      details: {
        ok: true,
        owner_session_id: owner,
        session_id: id,
        session_path: path,
        agent: label,
        definition: "scout",
      },
    },
  });
  const identity = (id: string, label: string) => ({
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { sessionId: id, label, definition: "scout" },
  });
  nativeSessions.set(childPath, {
    id: childId,
    path: childPath,
    entries: [
      identity(childId, "child"),
      {
        type: "usage",
        provider: "openai",
        model: "child-model",
        usage: usage(7),
      },
      edge(childId, nestedId, nestedPath, "nested"),
    ],
  });
  nativeSessions.set(nestedPath, {
    id: nestedId,
    path: nestedPath,
    entries: [
      identity(nestedId, "nested"),
      {
        type: "usage",
        provider: "openai",
        model: "child-model",
        usage: usage(9),
      },
    ],
  });
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai",
        model: "requested",
        responseModel: "actual",
        usage: usage(10, 2, 20, 3, 0.1),
      },
    },
    {
      type: "message",
      message: { role: "toolResult", usage: usage(4, 1, 0, 0, 0.02) },
    },
    {
      type: "usage",
      provider: "anthropic",
      model: "warm",
      usage: usage(1, 0, 5, 0, 0.01),
    },
    { type: "compaction", usage: usage(3, 1, 0, 0, 0.03) },
    { type: "branch_summary", usage: usage(2, 1, 0, 0, 0.02) },
    edge(LEAD_SESSION_ID, childId, childPath, "child"),
    edge(LEAD_SESSION_ID, childId, childPath, "child"),
    edge("other-owner", nestedId, nestedPath, "nested"),
  ];
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("stats", context);
    assert.match(
      notices[0]!,
      /Current session[\s\S]*Input\s+48[\s\S]*Total\s+53[\s\S]*Cost\s+\$0\.180/,
    );
    assert.match(notices[0]!, /Managed agents · 2 sessions[\s\S]*Input\s+16/);
    assert.match(
      notices[0]!,
      /Models\n  openai\/actual  35  \$0\.100\n  Tools\/summaries  12  \$0\.070\n  anthropic\/warm  6  \$0\.010\n  openai\/child-model  16  \$0\.000/,
    );
    assert.doesNotMatch(notices[0]!, /openai\/requested/);
    assert.doesNotMatch(notices[0]!, /Coverage incomplete/);
    nativeSessions.get(nestedPath)!.entries = [
      identity(nestedId, "wrong"),
      {
        type: "usage",
        provider: "openai",
        model: "child-model",
        usage: usage(9),
      },
    ];
    await pi.commandOptions.get("herdsman").handler("stats", context);
    assert.match(notices[1]!, /Managed agents · 1 session/);
    assert.match(notices[1]!, /Coverage incomplete/);
  } finally {
    nativeSessions.delete(childPath);
    nativeSessions.delete(nestedPath);
    rmSync(dir, { recursive: true, force: true });
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("active Manager stats aggregates unique assigned Lead trees and omits unavailable Leads", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "stats-manager-pane";
  process.env.HERDR_TAB_ID = "stats-manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `stats-manager-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const exec = (_command: string, args: string[]) => {
    if (args[0] === "workspace" && args[1] === "get")
      return respond({ workspace: { worktree: { repo_key: "repo-key" } } });
    if (args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: WORKSPACE,
          repo_key: "repo-key",
          repo_name: "project",
        },
        worktrees: [],
      });
    if (isAgentList(args)) return respond({ agents: [managerAgentIdentity()] });
    if (args[0] === "agent" && args[1] === "get")
      return respond({ agent: managerAgentIdentity() });
    if (isApiSnapshot(args))
      return respond({ snapshot: { agents: [], panes: [] } });
    return respond({});
  };
  const currentUsage = (amount: number) => ({
    input: amount,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: amount,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const manager = fakeChiefPi({ activeTools: ["read"], exec });
  const context = fakeContext([
    {
      type: "usage",
      provider: "test",
      model: "manager",
      usage: currentUsage(2),
    },
  ]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  const dir = mkdtempSync(join(tmpdir(), "herdsman-manager-usage-"));
  let restoreListAll: (() => void) | undefined;
  const leadA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const leadB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const agentX = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const agentY = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const paths = Object.fromEntries(
    [leadA, leadB, agentX, agentY].map((id) => [id, join(dir, `${id}.jsonl`)]),
  ) as Record<string, string>;
  for (const path of Object.values(paths)) writeFileSync(path, "");
  const usage = (amount: number) => ({
    input: amount,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: amount,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: amount },
  });
  const identity = (id: string, label: string) => ({
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { sessionId: id, label, definition: "scout" },
  });
  const receipt = (owner: string, id: string, label: string) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "agent_delegate",
      details: {
        ok: true,
        owner_session_id: owner,
        session_id: id,
        session_path: paths[id],
        agent: label,
        definition: "scout",
      },
    },
  });
  nativeSessions.set(paths[leadA]!, {
    id: leadA,
    path: paths[leadA]!,
    entries: [
      { type: "usage", provider: "test", model: "lead", usage: usage(5) },
      receipt(leadA, agentX, "x"),
      receipt(leadA, agentX, "x"),
    ],
  });
  nativeSessions.set(paths[leadB]!, {
    id: leadB,
    path: paths[leadB]!,
    entries: [
      { type: "usage", provider: "test", model: "lead", usage: usage(11) },
      receipt(leadB, agentY, "y"),
    ],
  });
  nativeSessions.set(paths[agentX]!, {
    id: agentX,
    path: paths[agentX]!,
    entries: [
      identity(agentX, "x"),
      { type: "usage", provider: "test", model: "agent", usage: usage(7) },
    ],
  });
  nativeSessions.set(paths[agentY]!, {
    id: agentY,
    path: paths[agentY]!,
    entries: [
      identity(agentY, "y"),
      { type: "usage", provider: "test", model: "agent", usage: usage(13) },
    ],
  });
  try {
    registerExtension!(manager.pi as never);
    await manager.events.get("session_start")![0](undefined, context);
    await manager.commandOptions.get("manager").handler("", context);
    for (const [branch, id] of [
      ["branch-a", leadA],
      ["branch-a-alias", leadA],
      ["branch-b", leadB],
    ])
      writeProjectAssignment(supervisionRuntime(), {
        version: 2,
        id,
        repoKey: "repo-key",
        branch,
        text: branch,
        ...(branch !== "branch-a-alias" ? { piSessionFile: paths[id]! } : {}),
      });
    assert.deepEqual(
      listProjectAssignments(supervisionRuntime(), "repo-key").map(
        (item) => item.id,
      ),
      [leadA, leadA, leadB],
    );
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const originalListAll = SessionManager.listAll;
    restoreListAll = () => (SessionManager.listAll = originalListAll);
    SessionManager.listAll = async () => {
      throw new Error("global inventory must not be touched by Manager stats");
    };
    await manager.commandOptions.get("agents").handler("stats", context);
    assert.match(notices[1]!, /Managed Leads · 2 sessions[\s\S]*Input\s+16/);
    assert.match(notices[1]!, /Managed agents · 2 sessions[\s\S]*Input\s+20/);
    assert.match(notices[1]!, /Total\s+38/);
    assert.match(
      notices[1]!,
      /test\/agent\s+20\s+\$20\.000[\s\S]*test\/lead\s+16\s+\$16\.000[\s\S]*test\/manager\s+2\s+\$0\.000/,
    );
    assert.doesNotMatch(notices[1]!, /Coverage incomplete/);

    const conflictPath = join(dir, "conflict.jsonl");
    writeFileSync(conflictPath, "");
    nativeSessions.set(conflictPath, {
      id: leadA,
      path: conflictPath,
      entries: [
        { type: "usage", provider: "test", model: "lead", usage: usage(99) },
      ],
    });
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadA,
      repoKey: "repo-key",
      branch: "branch-a-alias",
      text: "branch-a-alias",
      piSessionFile: conflictPath,
    });
    await manager.commandOptions.get("agents").handler("stats", context);
    assert.match(notices.at(-1)!, /Coverage incomplete/);
    assert.doesNotMatch(notices.at(-1)!, /Input\s+99/);
    nativeSessions.delete(conflictPath);
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadA,
      repoKey: "repo-key",
      branch: "branch-a-alias",
      text: "branch-a-alias",
      piSessionFile: paths[leadA]!,
    });

    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadB,
      repoKey: "repo-key",
      branch: "branch-b",
      text: "branch-b",
    });
    await manager.commandOptions.get("agents").handler("stats", context);
    assert.match(notices.at(-1)!, /Managed Leads · 1 session[\s\S]*Input\s+5/);
    assert.match(notices.at(-1)!, /Managed agents · 1 session[\s\S]*Input\s+7/);
    assert.match(
      notices.at(-1)!,
      /Coverage incomplete: some managed project session usage is unavailable\./,
    );
    assert.doesNotMatch(notices.at(-1)!, /Input\s+16/);

    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadB,
      repoKey: "repo-key",
      branch: "branch-b",
      text: "branch-b",
      piSessionFile: paths[leadB]!,
    });
    nativeSessions.set(paths[leadB]!, {
      id: leadA,
      path: paths[leadB]!,
      entries: [
        { type: "usage", provider: "test", model: "lead", usage: usage(11) },
        receipt(leadB, agentY, "y"),
      ],
    });
    await manager.commandOptions.get("agents").handler("stats", context);
    assert.match(notices.at(-1)!, /Coverage incomplete/);
    assert.doesNotMatch(notices.at(-1)!, /Managed Leads · 2 sessions/);

    SessionManager.listAll = originalListAll;
    restoreListAll = undefined;
  } finally {
    restoreListAll?.();
    for (const path of Object.values(paths)) nativeSessions.delete(path);
    rmSync(dir, { recursive: true, force: true });
    await manager.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
});

test("session stats marks malformed owned assignment receipts incomplete", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "agent_delegate",
        details: {
          ok: true,
          owner_session_id: LEAD_SESSION_ID,
          session_id: CHILD_SESSION_ID,
          session_path: 42,
          agent: "child",
          definition: "scout",
        },
      },
    },
  ]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("stats", context);
    assert.match(notices[0]!, /Managed agents · 0 sessions/);
    assert.match(notices[0]!, /Coverage incomplete/);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("session stats marks malformed owned completed results incomplete", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    {
      type: "custom_message",
      customType: "pi-herdsman-agent-result",
      details: {
        ownerSessionId: LEAD_SESSION_ID,
        piSessionId: CHILD_SESSION_ID,
        agentLabel: "child",
        agentDefinition: "scout",
        runId: "run",
        requestId: REQUEST_ID,
        status: "completed",
      },
    },
  ]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("stats", context);
    assert.match(notices[0]!, /Managed agents · 0 sessions/);
    assert.match(notices[0]!, /Coverage incomplete/);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});
const leadTools = [
  "agent_list",
  "agent_delegate",
  "agent_continue",
  "agent_steer",
  "agent_interrupt",
  "agent_reply",
  "agent_close",
  "agent_inspect",
  "agent_transcript",
  "supervisor_message",
  "peer_list",
  "peer_message",
];
const managerTools = [
  "supervisor_message",
  "peer_list",
  "peer_message",
  "staff_list",
  "staff_inspect",
  "staff_transcript",
  "staff_message",
  "staff_delegate",
  "staff_resume",
  "staff_stop",
];
const chiefTools = [
  "staff_list",
  "staff_inspect",
  "staff_transcript",
  "staff_message",
];
function managerAgentIdentity() {
  return {
    pane_id: process.env.HERDR_PANE_ID,
    tab_id: process.env.HERDR_TAB_ID,
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
  };
}

test("active Manager supervision refreshes serialize and coalesce concurrent requests", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "coalesced-manager-pane";
  process.env.HERDR_TAB_ID = "coalesced-manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-coalescing-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const release = Promise.withResolvers<void>();
  const gatedSnapshotStarted = Promise.withResolvers<void>();
  let snapshots = 0;
  let active = 0;
  let maxActive = 0;
  let gateRefresh = false;
  let refreshSnapshotBase = 0;
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "repo-key", is_linked_worktree: false },
          },
        });
      if (args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "repo-key",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (isAgentList(args))
        return respond({ agents: [managerAgentIdentity()] });
      if (args[0] === "agent" && args[1] === "get")
        return respond({ agent: managerAgentIdentity() });
      if (isApiSnapshot(args)) {
        snapshots++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (gateRefresh && snapshots === refreshSnapshotBase + 1) {
          gatedSnapshotStarted.resolve();
          await release.promise;
        }
        active--;
        return respond({ snapshot: { agents: [], panes: [] } });
      }
      return respond({});
    },
  });
  const context = fakeContext() as any;
  context.mode = "rpc";
  registerExtension!(pi.pi as never);
  t.after(async () => {
    release.resolve();
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });

  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("manager").handler("", context);
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
  refreshSnapshotBase = snapshots;
  maxActive = 0;
  gateRefresh = true;
  const beforeStart = pi.events.get("before_agent_start")![0];
  const firstCaller = beforeStart(
    { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
    context,
  );
  await gatedSnapshotStarted.promise;
  const callers = Array.from({ length: 4 }, () =>
    beforeStart(
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      context,
    ),
  );
  release.resolve();
  const results = await Promise.all([firstCaller, ...callers]);
  assert.ok(
    results.every((result) => /Manager role/.test(result?.systemPrompt ?? "")),
  );
  assert.equal(maxActive, 1);
  assert.equal(snapshots - refreshSnapshotBase, 2);
});

function nonGitWorkspaceResponse() {
  return {
    stdout: JSON.stringify({
      id: AGENT_ID,
      error: {
        code: "not_git_worktree",
        message: "Workspace is not a Git worktree",
      },
    }),
    stderr: "",
    code: 1,
  };
}
function fakeChiefPi(options: Parameters<typeof fakePi>[0] = {}) {
  let fixture: ReturnType<typeof fakePi>;
  const initialTools = Array.isArray(options.activeTools)
    ? options.activeTools
    : [];
  fixture = fakePi({
    ...options,
    exec: async (command: string, args: string[], extra: any) => {
      const provided = await options.exec?.(command, args, extra);
      if (
        command === "herdr" &&
        args[0] === "worktree" &&
        args[1] === "list" &&
        (!provided || provided.stdout === "{}")
      )
        return nonGitWorkspaceResponse();
      if (
        provided &&
        !(
          command === "herdr" &&
          args[0] === "workspace" &&
          args[1] === "get" &&
          provided.stdout === "{}"
        )
      )
        return provided;
      return {
        stdout:
          command === "herdr" && args[0] === "workspace" && args[1] === "get"
            ? JSON.stringify({ id: AGENT_ID, result: { workspace: {} } })
            : command === "herdr" && isAgentList(args)
              ? JSON.stringify({ id: AGENT_ID, result: { agents: [] } })
              : command === "herdr" && isApiSnapshot(args)
                ? JSON.stringify({
                    id: AGENT_ID,
                    result: { snapshot: { agents: [], panes: [] } },
                  })
                : "{}",
        stderr: "",
        code: 0,
      };
    },
    allTools: () =>
      [
        ...new Set([
          ...initialTools,
          "read",
          "bash",
          "grep",
          "foreign_tool",
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "supervisor_message",
          "peer_list",
          "peer_message",
          "staff_list",
          "staff_inspect",
          "staff_transcript",
          "staff_message",
          ...fixture.tools.map((tool) => tool.name),
        ]),
      ].map((name) => ({ name })),
  });
  return fixture;
}

test("root Lead explicitly enters Manager; a competing root session stays Lead", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `structural-manager-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const metadataReports: string[][] = [];
  const exec = (command: string, args: string[]) => {
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "report-metadata"
    )
      metadataReports.push(args);
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          worktree: { repo_key: "repo-key", is_linked_worktree: false },
        },
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: WORKSPACE,
          repo_key: "repo-key",
          repo_name: "project",
        },
        worktrees: [],
      });
    if (command === "herdr" && isAgentList(args))
      return respond({ agents: [managerAgentIdentity()] });
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({ agent: managerAgentIdentity() });
    if (command === "herdr" && isApiSnapshot(args))
      return respond({ snapshot: { agents: [], panes: [] } });
    return respond({});
  };
  const first = fakeChiefPi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { role: "lead", leadTools: ["read"] },
      },
    ],
    activeTools: ["read"],
    exec,
    sessionName: "current lead name",
  });
  const second = fakeChiefPi({ activeTools: ["read"], exec });
  const ctx1 = fakeContext(first.entries) as any;
  const managerNotices: string[] = [];
  ctx1.ui.notify = (message: string, level?: string) => {
    if (level === "error") managerNotices.push(message);
  };
  const ctx2 = fakeContext() as any;
  ctx2.sessionManager.getSessionId = () => `lead-${randomUUID()}`;
  registerExtension!(first.pi as never);
  registerExtension!(second.pi as never);
  try {
    assert.equal(first.commands.includes("manager"), true);
    const supervisionToolNames = [
      "staff_list",
      "staff_inspect",
      "staff_transcript",
      "staff_message",
      "staff_delegate",
      "staff_resume",
      "staff_stop",
    ];
    const staffMessage = first.tools.find(
      (tool) => tool.name === "staff_message",
    )!;
    assert.ok(staffMessage);
    assert.equal(staffMessage.defaultActive, false);
    for (const name of supervisionToolNames) {
      const tool = first.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is registered during extension setup`);
      assert.equal(typeof tool.renderCall, "function");
      assert.equal(typeof tool.renderResult, "function");
      assert.equal(tool.defaultActive, false);
    }
    const historicalArgs = {
      session: "lead-historical-session",
      message: "Please continue the prior assignment",
    };
    const historical = staffMessage.renderCall(
      historicalArgs,
      {
        fg: (_color: string, value: string) => value,
        bold: (value: string) => value,
      },
      { args: historicalArgs, argsComplete: true },
    );
    assert.match(historical.render(160).join("\n"), /^staff message  lead-his/);
    await first.events.get("session_start")![0](undefined, ctx1);
    assert.deepEqual(first.pi.getActiveTools(), ["read", ...leadTools]);
    assert.equal(first.pi.getActiveTools().includes("staff_message"), false);
    assert.equal(
      first.pi.getAllTools().some((tool) => tool.name === "staff_delegate"),
      true,
    );
    const leadPrompt = await first.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      ctx1,
    );
    assert.match(
      leadPrompt.systemPrompt,
      /Own architecture, approved scope, acceptance of Agent outputs, integration, conflict resolution/,
    );
    await first.commandOptions.get("manager").handler("", ctx1);
    assert.deepEqual(first.pi.getActiveTools(), ["read", ...managerTools]);
    assert.equal(
      first.tools.find((tool) => tool.name === "staff_message"),
      staffMessage,
    );
    assert.equal(
      first.pi.getAllTools().some((tool) => tool.name === "staff_delegate"),
      true,
    );
    assert.equal(first.pi.getActiveTools().includes("agent_delegate"), false);
    const managerPrompt = await first.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      ctx1,
    );
    assert.match(
      managerPrompt.systemPrompt,
      /Manager role[\s\S]*Manage project work by branch[\s\S]*staff_delegate with a task and optional branch\s+to start new project work\. Use staff_resume with its branch to resume existing\s+project work\.[\s\S]*Project execution belongs to project Leads and their Agent trees[\s\S]*Lead messages are\s+coordination and review handoffs, not project completion\. Escalate to Chief with\s+supervisor_message/i,
    );
    assert.doesNotMatch(
      managerPrompt.systemPrompt,
      /Lead role[\s\S]*## Manager role/,
    );
    assert.doesNotMatch(
      managerPrompt.systemPrompt,
      /Available agent definitions/,
    );
    assert.equal(managerPrompt.message, undefined);
    const managerContext = first.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    );
    assert.ok(managerContext);
    assert.deepEqual(managerContext.options, { triggerTurn: false });
    assert.equal(
      await first.events.get("tool_call")![0](
        { toolName: "agent_list", input: {} },
        ctx1,
      ),
      undefined,
    );
    const staff = first.tools.find((tool) => tool.name === "staff_delegate");
    const resume = first.tools.find((tool) => tool.name === "staff_resume");
    assert.ok(staff);
    assert.ok(resume);
    assert.equal(staff.parameters.properties.assignment, undefined);
    assert.match(staff.description, /start new project work/i);
    assert.equal(
      Value.Check(staff.parameters, { branch: "feat/existing" }),
      false,
    );
    assert.equal(
      Value.Check(resume.parameters, { branch: "feat/existing" }),
      true,
    );
    assert.equal(
      Value.Check(resume.parameters, { branch: "feat/existing", task: "x" }),
      false,
    );
    assert.ok(
      Value.Check(staff.parameters, {
        task: "Build feature",
      }),
    );
    assert.equal(
      Value.Check(staff.parameters, {
        lead: LEAD_SESSION_ID,
        message: "old selector",
      }),
      false,
    );
    const roster = await first.tools
      .find((tool) => tool.name === "staff_list")!
      .execute("list", {}, undefined, undefined, ctx1);
    assert.equal(roster.details.self.role, "manager");
    assert.deepEqual(roster.details.reports, []);
    const leadPeerSession = `lead-${randomUUID()}`;
    const peerLease = acquireProcessLock(
      peerLeadLockPath(peerRuntime(), leadPeerSession),
    );
    const leadPeer = {
      version: 1 as const,
      role: "lead" as const,
      piSessionId: leadPeerSession,
      workspaceId: "unrelated",
      paneId: "lead-pane",
      tabId: "lead-tab",
      claim: peerLease.claim,
      updatedAt: Date.now(),
    };
    try {
      writePeerLeadRecord(peerRuntime(), leadPeer);
      const peer = first.tools.find((tool) => tool.name === "peer_message")!;
      const visible = await first.tools
        .find((tool) => tool.name === "peer_list")!
        .execute("list", {}, undefined, undefined, ctx1);
      assert.deepEqual(visible.details.peers, []);
      await assert.rejects(
        peer.execute(
          "message",
          {
            session: leadPeerSession,
            message: "Wrong role",
          },
          undefined,
          undefined,
          ctx1,
        ),
        /no longer a live same-role peer/,
      );
    } finally {
      removePeerLeadRecord(peerRuntime(), leadPeerSession, leadPeer);
      peerLease.release();
    }
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "manager",
    );
    assert.ok(readManagerDescriptor(supervisionRuntime(), WORKSPACE));
    await first.commandOptions.get("chief").handler("", ctx1);
    assert.ok(
      managerNotices.some((message) =>
        /Chief mode is unavailable to a project Manager/.test(message),
      ),
    );
    assert.deepEqual(first.pi.getActiveTools(), ["read", ...managerTools]);
    const collisionNotices: string[] = [];
    ctx2.ui.notify = (message: string) => collisionNotices.push(message);
    await second.events.get("session_start")![0](undefined, ctx2);
    assert.deepEqual(second.pi.getActiveTools(), ["read", ...leadTools]);
    assert.ok(
      collisionNotices.some((message) =>
        message.includes(
          "Manager auto-start skipped: this project already has an active Manager.",
        ),
      ),
      JSON.stringify(collisionNotices),
    );
    assert.equal(
      sessionLeadRoleState(ctx2.sessionManager.getEntries()),
      undefined,
    );
    await second.commandOptions.get("manager").handler("", ctx2);
    assert.deepEqual(second.pi.getActiveTools(), ["read", ...leadTools]);
    assert.ok(
      collisionNotices.some((message) =>
        /already has an active Manager/.test(message),
      ),
    );

    const persistedManager = fakeChiefPi({
      activeTools: ["read"],
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-role",
          data: { role: "manager", leadTools: ["read"] },
        },
      ],
      exec,
    });
    registerExtension!(persistedManager.pi as never);
    const persistedManagerContext = fakeContext(
      persistedManager.entries,
    ) as any;
    persistedManagerContext.sessionManager.getSessionId = () =>
      `restored-manager-${randomUUID()}`;
    const restorationNotices: string[] = [];
    persistedManagerContext.ui.notify = (message: string) =>
      restorationNotices.push(message);
    await persistedManager.events.get("session_start")![0](
      undefined,
      persistedManagerContext,
    );
    assert.equal(
      persistedManager.pi.getActiveTools().includes("staff_delegate"),
      false,
    );
    assert.equal(
      sessionLeadRoleState(persistedManagerContext.sessionManager.getEntries())
        ?.role,
      "manager",
    );
    assert.ok(
      restorationNotices.some((message) =>
        /Manager unavailable: this project already has an active Manager\. Manager mode is suspended\./.test(
          message,
        ),
      ),
    );
    await persistedManager.events.get("session_shutdown")?.[0]();
    updateConfig("autoActivateManager", undefined);
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "manager",
    );
    const managerLeaseId = readManagerDescriptor(
      supervisionRuntime(),
      WORKSPACE,
    )?.leaseId;
    const activeManagerTools = first.pi.getActiveTools();
    let overviewOpened = false;
    ctx1.mode = "tui";
    ctx1.ui.custom = async (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, value: string) => value,
            bold: (value: string) => value,
          },
          {},
          resolve,
        );
        overviewOpened = true;
        assert.match(component.render(120).join("\n"), /Pi Herdsman/);
        component.handleInput("\u001b");
      });
    await first.commandOptions.get("manager").handler("", ctx1);
    assert.equal(overviewOpened, true);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.leaseId,
      managerLeaseId,
    );
    assert.deepEqual(first.pi.getActiveTools(), activeManagerTools);
    await first.commandOptions.get("manager").handler("leave", ctx1);
    const leadMetadata = metadataReports.findLast((args) =>
      args.includes("pi_herdsman_name=current lead name"),
    );
    const titleIndex = leadMetadata?.indexOf("--title") ?? -1;
    const nameTokenIndex =
      leadMetadata?.indexOf("pi_herdsman_name=current lead name") ?? -1;
    assert.ok(
      leadMetadata &&
        leadMetadata[titleIndex + 1] === "current lead name" &&
        leadMetadata[nameTokenIndex - 1] === "--token",
      JSON.stringify(leadMetadata),
    );
    assert.deepEqual(first.pi.getActiveTools(), ["read", ...leadTools]);
    assert.equal(first.pi.getActiveTools().includes("staff_message"), false);
    assert.equal(
      first.tools.find((tool) => tool.name === "staff_message"),
      staffMessage,
    );
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "lead",
    );
    await first.events.get("session_shutdown")![0]();
    const replacement = fakeChiefPi({ activeTools: ["read"], exec });
    registerExtension!(replacement.pi as never);
    try {
      const replacementContext = fakeContext() as any;
      replacementContext.sessionManager.getSessionId = () =>
        `lead-${randomUUID()}`;
      await replacement.events.get("session_start")![0](
        undefined,
        replacementContext,
      );
      assert.deepEqual(replacement.pi.getActiveTools(), ["read", ...leadTools]);
    } finally {
      await replacement.events.get("session_shutdown")![0]();
    }
  } finally {
    updateConfig("autoActivateManager", undefined);
    await second.events.get("session_shutdown")?.[0]();
    await first.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager leave retains its lease and role when persistence fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "manager-pane";
  process.env.HERDR_TAB_ID = "manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-leave-failure-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "repo-key" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({ agents: [managerAgentIdentity()] })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerAgentIdentity() })
              : isApiSnapshot(args)
                ? respond({ snapshot: { agents: [], panes: [] } })
                : respond({}),
  });
  const ctx = fakeContext() as any;
  const notices: string[] = [];
  ctx.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const leaseId = readManagerDescriptor(
      supervisionRuntime(),
      WORKSPACE,
    )?.leaseId;
    assert.ok(leaseId);
    const originalAppend = pi.pi.appendEntry;
    for (const failedType of ["pi-herdsman-role", "pi-herdsman-lead-state"]) {
      let failed = false;
      pi.pi.appendEntry = (type: string, data: unknown) => {
        if (type === failedType && !failed) {
          failed = true;
          throw new Error(`injected ${type} failure`);
        }
        originalAppend(type, data);
      };
      await pi.commandOptions.get("manager").handler("leave", ctx);
      pi.pi.appendEntry = originalAppend;
      assert.equal(failed, true, notices.join("; "));
      assert.ok(
        notices.some(
          (message) =>
            message.includes(`injected ${failedType} failure`) ||
            message.includes("Lead coordination state could not be persisted"),
        ),
      );
      assert.equal(
        readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.leaseId,
        leaseId,
      );
      assert.equal(
        readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
        "manager",
      );
      assert.deepEqual(pi.pi.getActiveTools(), ["read", ...managerTools]);
    }
    await pi.commandOptions.get("manager").handler("leave", ctx);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE),
      undefined,
    );
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "lead",
    );
    await pi.commandOptions.get("manager").handler("", ctx);
    const suspendedLease = readManagerDescriptor(
      supervisionRuntime(),
      WORKSPACE,
    )?.leaseId;
    assert.ok(suspendedLease);
    pi.pi.appendEntry = (type: string, data: unknown) => {
      if (type === "pi-herdsman-role")
        throw new Error("role storage unavailable");
      originalAppend(type, data);
    };
    await pi.commandOptions.get("manager").handler("leave", ctx);
    pi.pi.appendEntry = originalAppend;
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.leaseId,
      suspendedLease,
    );
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID),
      undefined,
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager leave suspends authority when lease release fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "manager-pane";
  process.env.HERDR_TAB_ID = "manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-release-failure-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "repo-key" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({ agents: [managerAgentIdentity()] })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerAgentIdentity() })
              : isApiSnapshot(args)
                ? respond({ snapshot: { agents: [], panes: [] } })
                : respond({}),
  });
  const ctx = fakeContext() as any;
  const notices: string[] = [];
  ctx.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  const runtime = supervisionRuntime();
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const lock = `${managerDescriptorPath(runtime, WORKSPACE)}.lock`;
    const owner = realFs.readdirSync(lock)[0];
    assert.ok(owner);
    const originalAppend = pi.pi.appendEntry;
    pi.pi.appendEntry = (type: string, data: unknown) => {
      originalAppend(type, data);
      if (type === "pi-herdsman-lead-state")
        realFs.writeFileSync(join(lock, owner), "{}");
    };

    await pi.commandOptions.get("manager").handler("leave", ctx);

    assert.ok(
      notices.some((message) =>
        message.includes(
          "Unable to verify Manager supervision lease ownership",
        ),
      ),
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
    assert.equal(
      readLeadCoordinationState(runtime, LEAD_SESSION_ID),
      undefined,
    );
    await pi.commandOptions.get("manager").handler("", ctx);
    assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(runtime.root, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("restored Manager registers supervision tools and restores Manager tools", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  process.env.HERDR_PANE_ID = "manager-pane";
  process.env.HERDR_TAB_ID = "manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `restored-manager-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeChiefPi({
    activeTools: ["read"],
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { role: "manager", leadTools: ["read"] },
      },
    ],
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "repo-key", is_linked_worktree: false },
          },
        });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "repo-key",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (command === "herdr" && isAgentList(args))
        return respond({ agents: [] });
      if (command === "herdr" && isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext(pi.entries) as any;
    context.sessionManager.getSessionId = () => `manager-${randomUUID()}`;
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...managerTools]);
    assert.ok(pi.tools.some((tool) => tool.name === "staff_delegate"));
    assert.equal(pi.pi.getActiveTools().includes("agent_delegate"), false);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "list"),
      false,
    );
    assert.equal(
      pi.entries
        .filter((entry: any) => entry.customType === "pi-herdsman-role")
        .at(-1).data.role,
      "manager",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    updateConfig("autoActivateManager", undefined);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start activates after identity and coordination verification without persisting role intent", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  process.env.HERDR_PANE_ID = "verified-auto-manager-pane";
  process.env.HERDR_TAB_ID = "verified-auto-manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `verified-auto-manager-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const sessionId = `verified-auto-manager-${randomUUID()}`;
  const agent = {
    ...managerAgentIdentity(),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: sessionId,
    },
  };
  let healthyLeadCoordinationBeforeIdentityCheck = false;
  const pi = fakeChiefPi({
    activeTools: ["read"],
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-lead-state",
        data: { pendingAsk: {} },
      },
    ],
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "repo-key", is_linked_worktree: false },
          },
        });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "repo-key",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (command === "herdr" && isAgentList(args)) {
        healthyLeadCoordinationBeforeIdentityCheck =
          pi.entries.some(
            (entry: any) =>
              entry.customType === "pi-herdsman-lead-state" &&
              typeof entry.data?.instanceId === "string",
          ) &&
          readLeadCoordinationState(supervisionRuntime(), sessionId)?.role ===
            "lead";
        return respond({ agents: [agent] });
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return respond({ agent });
      if (command === "herdr" && isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext(pi.entries) as any;
    context.sessionManager.getSessionId = () => sessionId;
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(healthyLeadCoordinationBeforeIdentityCheck, true);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...managerTools]);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.workspaceId,
      WORKSPACE,
    );
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), sessionId)?.role,
      "manager",
    );
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-role" &&
          entry.data?.role === "manager",
      ),
      false,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    updateConfig("autoActivateManager", undefined);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start rejects mismatched Herdr identity and releases its lease", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  process.env.HERDR_PANE_ID = "auto-manager-pane";
  process.env.HERDR_TAB_ID = "auto-manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `auto-manager-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const sessionId = `auto-manager-${randomUUID()}`;
  const agent = {
    ...managerAgentIdentity(),
    pane_id: "different-pane",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: sessionId,
    },
  };
  let coordinationRestoredBeforeIdentityCheck = false;
  const pi = fakeChiefPi({
    activeTools: ["read"],
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-lead-state",
        data: { pendingAsk: {} },
      },
    ],
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "repo-key", is_linked_worktree: false },
          },
        });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "repo-key",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (command === "herdr" && isAgentList(args)) {
        coordinationRestoredBeforeIdentityCheck = pi.entries.some(
          (entry: any) =>
            entry.customType === "pi-herdsman-lead-state" &&
            typeof entry.data?.instanceId === "string",
        );
        return respond({ agents: [agent] });
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return respond({ agent });
      if (command === "herdr" && isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext(pi.entries) as any;
    context.sessionManager.getSessionId = () => sessionId;
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(coordinationRestoredBeforeIdentityCheck, true);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE),
      undefined,
    );
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-role" &&
          entry.data?.role === "manager",
      ),
      false,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    updateConfig("autoActivateManager", undefined);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start suspends and invalidates Lead when identity cleanup release fails", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  process.env.HERDR_PANE_ID = "manager-pane";
  process.env.HERDR_TAB_ID = "manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `auto-manager-release-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const sessionId = `auto-manager-release-${randomUUID()}`;
  const agent = {
    ...managerAgentIdentity(),
    pane_id: "different-pane",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: sessionId,
    },
  };
  const pi = fakeChiefPi({
    activeTools: ["read"],
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-lead-state",
        data: { pendingAsk: {} },
      },
    ],
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return respond({ workspace: { worktree: { repo_key: "repo-key" } } });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "repo-key",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (command === "herdr" && isAgentList(args)) {
        const lock = `${managerDescriptorPath(supervisionRuntime(), WORKSPACE)}.lock`;
        const owner = realFs.readdirSync(lock)[0];
        assert.ok(owner);
        realFs.writeFileSync(join(lock, owner), "{}");
        return respond({ agents: [agent] });
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        return respond({ agent });
      }
      if (command === "herdr" && isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  const runtime = supervisionRuntime();
  try {
    const context = fakeContext(pi.entries) as any;
    context.sessionManager.getSessionId = () => sessionId;
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
    assert.equal(readLeadCoordinationState(runtime, sessionId), undefined);
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-role" &&
          entry.data?.role === "manager",
      ),
      false,
    );
    assert.ok(
      pi.entries.some((entry: any) =>
        String(entry.customType).includes("error"),
      ),
      JSON.stringify(pi.entries.map((entry: any) => entry.customType)),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(runtime.root, { recursive: true, force: true });
    updateConfig("autoActivateManager", undefined);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start finalization suspends and invalidates Lead when rollback release fails", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  const pi = fakePi({ activeTools: ["read", "agent_list"] });
  const releaseError = new Error("lease release failed");
  const state: any = {
    controllerRole: "manager",
    managerLease: {
      release: () => {
        throw releaseError;
      },
    },
    roleSuspended: false,
    chiefMode: "inactive",
    chiefModeGeneration: 0,
  };
  let invalidated = false;
  const host: any = {
    controllerScope: { kind: "lead" },
    pi: pi.pi,
    persistLeadCoordination: () => false,
    markLeadCoordinationUnhealthy: () => {
      invalidated = true;
    },
    appendDurableError: () => {},
    getLeadTools: () => ["read", "agent_list"],
    normalizeBaseTools: (tools: string[]) =>
      tools.filter((tool) => tool === "read"),
  };
  const transitions = createLeadRoleTransitions(state, host);
  transitions.finalizeOptionalManagerStartup(fakeContext() as any);

  assert.equal(state.controllerRole, "manager");
  assert.ok(state.managerLease);
  assert.equal(state.roleSuspended, true);
  assert.equal(invalidated, true);
  assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
});

test("malformed Lead coordination blocks Manager auto-start", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  process.env.HERDR_PANE_ID = "malformed-auto-pane";
  process.env.HERDR_TAB_ID = "malformed-auto-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `malformed-auto-${randomUUID()}.sock`,
  );
  let topologyLookups = 0;
  const pi = fakeChiefPi({
    activeTools: ["read"],
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-lead-state",
        data: { instanceId: "invalid" },
      },
    ],
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        topologyLookups++;
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { workspace: { worktree: { repo_key: "repo-key" } } },
          }),
          stderr: "",
          code: 0,
        };
      return undefined;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries) as any,
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
    assert.equal(topologyLookups, 0);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE),
      undefined,
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-lead-state" &&
          entry.data?.instanceId === "invalid",
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    updateConfig("autoActivateManager", undefined);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("linked and non-project sessions derive ordinary Lead tools", async () => {
  for (const membership of ["linked", "non-project"] as const) {
    setLeadEnvironment();
    process.env.HERDR_PANE_ID = `pane-${membership}`;
    process.env.HERDR_TAB_ID = `tab-${membership}`;
    process.env.HERDR_SOCKET_PATH = join(
      tmpdir(),
      `structural-${membership}-${randomUUID()}.sock`,
    );
    const respond = (result: unknown) => ({
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    });
    const pi = fakeChiefPi({
      activeTools: ["read"],
      exec: (command, args) => {
        if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
          return respond({
            workspace:
              membership === "linked"
                ? {
                    worktree: {
                      repo_key: "repo-key",
                      is_linked_worktree: true,
                    },
                  }
                : {},
          });
        if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
          return respond({
            source: {
              source_workspace_id: "root-workspace",
              repo_key: "repo-key",
              repo_name: "project",
            },
            worktrees: [{ open_workspace_id: WORKSPACE }],
          });
        if (command === "herdr" && isAgentList(args))
          return respond({ agents: [] });
        if (command === "herdr" && isApiSnapshot(args))
          return respond({ snapshot: { agents: [], panes: [] } });
        return respond({});
      },
    });
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, fakeContext());
      assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
      assert.equal(
        readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
        "lead",
      );
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_TAB_ID;
      delete process.env.HERDR_PANE_ID;
      setLeadEnvironment();
    }
  }
});

async function managerDelegateAssignmentTest(
  t: TestContext,
  projectTrusted: boolean,
) {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `delegate-project-${randomUUID()}.sock`,
  );
  const childWorkspace = `child-${randomUUID()}`;
  const childCwd = mkdtempSync(join(tmpdir(), "pi-herdsman-manager-child-"));
  t.after(() => rmSync(childCwd, { recursive: true, force: true }));
  const managedLeadDir = join(childCwd, ".pi", "agents");
  mkdirSync(managedLeadDir, { recursive: true });
  writeFileSync(
    join(managedLeadDir, "managed-lead.md"),
    "---\nname: managed-lead\nthinking: low\nbodyMode: append\n---\n\nTARGET_WORKTREE_MANAGED_LEAD",
  );
  let childSession = `lead-${randomUUID()}`;
  let primaryWorkspace = WORKSPACE;
  const childSessionPath = () => join(tmpdir(), `${childSession}.jsonl`);
  let created = false;
  let started = false;
  let manager1Shutdown = false;
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  let managerAgent: any = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
    workspace_id: WORKSPACE,
    pane_id: "root-pane",
    tab_id: "root-tab",
  };
  const exec = (command: string, args: string[]) => {
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          workspace_id: args[2],
          worktree: {
            repo_key: "repo-key",
            is_linked_worktree: args[2] === childWorkspace,
            checkout_path:
              args[2] === childWorkspace ? childCwd : "/tmp/manager-root",
          },
        },
        ...(args[2] === childWorkspace
          ? { root_pane: { pane_id: "child-pane", tab_id: "child-tab" } }
          : {}),
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: primaryWorkspace,
          repo_key: "repo-key",
          repo_name: "project",
        },
        worktrees: created
          ? [
              {
                open_workspace_id: primaryWorkspace,
                branch: "main",
                path: "/tmp/manager-root",
                is_linked_worktree: false,
              },
              {
                open_workspace_id: childWorkspace,
                branch: listProjectAssignments(
                  supervisionRuntime(),
                  "repo-key",
                )[0]?.branch,
                path: childCwd,
                is_linked_worktree: true,
              },
              {
                branch: "closed-worktree",
                path: "/tmp/manager-closed",
                is_linked_worktree: true,
              },
            ]
          : [],
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
      const branchIndex = args.indexOf("--branch");
      const [assignment] = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      );
      assert.ok(assignment);
      assert.equal(args[branchIndex + 1], assignment.branch);
      assert.equal(assignment.branch, args[branchIndex + 1]);
      created = true;
      return respond({
        workspace: { workspace_id: childWorkspace },
        tab: { tab_id: "child-tab" },
        root_pane: { pane_id: "child-pane", tab_id: "child-tab" },
        worktree: { branch: assignment.branch, path: childCwd },
      });
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "list")
      return respond({
        panes: [
          {
            pane_id: "child-pane",
            workspace_id: childWorkspace,
            tab_id: "child-tab",
            terminal_id: "child-terminal",
            cwd: childCwd,
          },
        ],
      });
    if (command === "herdr" && args[0] === "pane" && args[1] === "get")
      return respond({
        pane: {
          pane_id: "child-pane",
          workspace_id: childWorkspace,
          tab_id: "child-tab",
          terminal_id: "child-terminal",
          cwd: childCwd,
        },
      });
    if (command === "herdr" && args[0] === "pane" && args[1] === "process-info")
      return respond({
        process_info: {
          pane_id: "child-pane",
          shell_pid: 33,
          foreground_process_group_id: 33,
          foreground_processes: [{ pid: 33, argv0: "/bin/zsh" }],
        },
      });
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      (args[1] === "run" || args[1] === "wait-output")
    )
      return respond({});
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      started = true;
      const [assignment] = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      );
      assert.ok(assignment);
      const sessionIdIndex = args.indexOf("--session-id");
      assert.notEqual(sessionIdIndex, -1);
      childSession = args[sessionIdIndex + 1]!;
      assert.equal(childSession, assignment.id);
      const toolsIndex = args.indexOf("--tools");
      assert.notEqual(toolsIndex, -1);
      assert.deepEqual(args[toolsIndex + 1]!.split(","), [
        "read",
        "ls",
        "find",
        "grep",
        ...leadTools,
        "mcp__",
      ]);
      const excludedIndex = args.indexOf("--exclude-tools");
      assert.notEqual(excludedIndex, -1);
      assert.equal(args[excludedIndex + 1], "mcp__");
      for (const tool of ["bash", "powershell", "edit", "write"])
        assert.equal(args[toolsIndex + 1]!.split(",").includes(tool), false);
      assert.equal(args.includes("--no-skills"), true);
      assert.equal(args.includes("--no-extensions"), true);
      const thinkingIndex = args.indexOf("--thinking");
      assert.notEqual(thinkingIndex, -1);
      assert.equal(args[thinkingIndex + 1] === "low", projectTrusted);
      assert.equal(args.includes("--approve"), projectTrusted);
      assert.equal(args.includes("--no-approve"), !projectTrusted);
      const promptIndex = args.indexOf("--append-system-prompt");
      if (projectTrusted) {
        assert.notEqual(promptIndex, -1);
        const childPrompt = readFileSync(args[promptIndex + 1]!, "utf8");
        assert.match(childPrompt, /TARGET_WORKTREE_MANAGED_LEAD/);
      } else {
        assert.equal(promptIndex, -1);
      }
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        role: "lead",
        instanceId: randomUUID(),
        piSessionId: childSession,
        updatedAt: Date.now(),
      });
      return respond({
        agent: {
          name: "lead",
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "path",
            value: childSessionPath(),
          },
        },
      });
    }
    if (command === "herdr" && isApiSnapshot(args))
      return respond({
        snapshot: {
          panes: [],
          agents: started
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "path",
                    value: childSessionPath(),
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                },
              ]
            : [],
        },
      });
    if (command === "herdr" && isAgentList(args)) {
      if (
        started &&
        !realFs.existsSync(childSessionPath()) &&
        listCoordinationMessagePaths(supervisionRuntime(), childSession).length
      ) {
        realFs.writeFileSync(
          childSessionPath(),
          JSON.stringify({
            type: "session",
            id: childSession,
          }),
        );
        nativeSessions.set(childSessionPath(), {
          id: childSession,
          path: childSessionPath(),
          cwd: childCwd,
          entries: [],
        });
      }
      return respond({
        agents: [
          ...(managerAgent ? [managerAgent] : []),
          ...(started
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "path",
                    value: childSessionPath(),
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                },
              ]
            : []),
        ],
      });
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({ agent: managerAgent });
    return respond({});
  };
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec,
    persistMessages: true,
  });
  registerExtension!(pi.pi as never);
  try {
    const ctx = fakeContext(pi.entries) as any;
    ctx.isProjectTrusted = () => projectTrusted;
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const staff = pi.tools.find((tool) => tool.name === "staff_delegate")!;
    assert.equal(
      Value.Check(staff.parameters, {
        task: "Do it",
        unexpected: childSession,
      }),
      false,
    );
    const outcome = await staff.execute(
      "delegate",
      { task: "Implement focused change" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(outcome.details.ok, true);
    const assignment = listProjectAssignments(
      supervisionRuntime(),
      "repo-key",
    )[0];
    assert.ok(assignment);
    const staffListTool = pi.tools.find((tool) => tool.name === "staff_list")!;
    const staffList = await staffListTool.execute(
      "list",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(staffList.details.open_workspaces, [
      {
        workspace: WORKSPACE,
        branch: "main",
        path: "/tmp/manager-root",
        linked: false,
      },
      {
        workspace: childWorkspace,
        branch: assignment!.branch,
        path: childCwd,
        linked: true,
      },
    ]);
    const contextProjection = await pi.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      ctx,
    );
    assert.equal(contextProjection?.message, undefined);
    const contextMessage = pi.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    );
    assert.match(
      String((contextMessage?.message as any)?.content),
      new RegExp(
        `open_workspaces:[\\s\\S]*main · workspace=${WORKSPACE} · primary[\\s\\S]*${assignment!.branch} · workspace=${childWorkspace} · linked`,
      ),
    );
    assert.equal(assignment?.id, childSession);
    assert.match(assignment!.branch, /^herdsman\/work-[0-9a-f]{8}$/);
    assert.equal(assignment!.branch.includes(assignment!.id), false);
    assert.equal(
      assignment!.piSessionFile,
      realFs.realpathSync(childSessionPath()),
    );
    const assignmentBytes = readFileSync(
      projectAssignmentPath(
        supervisionRuntime(),
        "repo-key",
        assignment.branch,
      ),
      "utf8",
    );
    assert.deepEqual(Object.keys(JSON.parse(assignmentBytes)).sort(), [
      "branch",
      "id",
      "piSessionFile",
      "repoKey",
      "text",
      "version",
    ]);
    assert.equal(outcome.details.workspace_id, childWorkspace);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "start" &&
          args.includes("--pane") &&
          args.includes("child-pane") &&
          args.includes("--session-id") &&
          args.includes(childSession),
      ),
    );
    const paths = listCoordinationMessagePaths(
      supervisionRuntime(),
      childSession,
    );
    assert.equal(paths.length, 1);
    const delivery = readChiefMessage(paths[0]!);
    assert.equal(delivery.kind, "project_assignment");
    assert.equal(delivery.text, "Project assignment ready.");
    assert.equal(delivery.resultBindings, undefined);
    assert.ok(
      pi.calls.some(
        (args) => args.includes("--no-focus") && args.includes("--branch"),
      ),
    );
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && args[1] === "start" && args.includes("--pane"),
      ),
    );
    await pi.commandOptions.get("manager").handler("leave", ctx);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE),
      undefined,
    );
    assert.equal(
      listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
      childSession,
    );
    await pi.events.get("session_shutdown")?.[0]();
    manager1Shutdown = true;
    managerAgent = undefined;
    process.env.HERDR_WORKSPACE_ID = childWorkspace;
    process.env.HERDR_PANE_ID = "child-pane";
    process.env.HERDR_TAB_ID = "child-tab";
    const lead = fakeChiefPi({ activeTools: ["read"], exec });
    registerExtension!(lead.pi as never);
    const leadCtx = fakeContext() as any;
    leadCtx.sessionManager.getSessionId = () => childSession;
    leadCtx.sessionManager.getSessionFile = childSessionPath;
    try {
      await lead.events.get("session_start")![0](undefined, leadCtx);
      await t.waitFor(() =>
        assert.ok(
          lead.sent.some(
            (message: any) =>
              message.customType === "pi-herdsman-project_assignment",
          ),
        ),
      );
      const assignmentDelivery = lead.sent.find(
        (message: any) =>
          message.customType === "pi-herdsman-project_assignment",
      ) as { content?: string } | undefined;
      assert.ok(assignmentDelivery);
      assert.match(assignmentDelivery.content!, /Implement focused change/);
      assert.doesNotMatch(
        assignmentDelivery.content!,
        /Be orchestration-first|Work directly when the work is trivial|acceptance of Agent outputs/,
      );
      assert.match(
        assignmentDelivery.content!,
        /Settlement is\s+nonterminal; do not infer project closure from runtime state\./,
      );
      assert.match(
        assignmentDelivery.content!,
        /Herdsman automatically hands your\s+normal assignment response to the Manager role\.\s+If no Manager is available,\s+the handoff remains pending until a Manager can receive it\./,
      );
      const message = await lead.tools
        .find((tool) => tool.name === "supervisor_message")!
        .execute(
          "message",
          { message: "Ready for review" },
          undefined,
          undefined,
          leadCtx,
        );
      assert.match(
        JSON.stringify(message),
        /Project message saved for Manager/,
      );
      const { listProjectMessages } = await import("./supervision.ts");
      const retained = listProjectMessages(
        supervisionRuntime(),
        "repo-key",
        assignment!.branch,
      );
      assert.equal(retained.length, 1);
      assert.equal(retained[0]!.fromSessionId, childSession);
      assert.equal(retained[0]!.text, "Ready for review");
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
        childSession,
      );
    } finally {
      await lead.events.get("session_shutdown")?.[0]();
    }
  } finally {
    if (!manager1Shutdown) await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
}

for (const projectTrusted of [true, false])
  test(`Manager delegate persists an exact worktree Lead assignment (${projectTrusted ? "trusted" : "untrusted"})`, (t) =>
    managerDelegateAssignmentTest(t, projectTrusted));

test("Chief staff and ambient supervision include Managers and unclaimed Leads", async () => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-managers-${randomUUID()}.sock`,
  );
  process.env.HERDR_PANE_ID = "manager-pane";
  process.env.HERDR_TAB_ID = "manager-tab";
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const managerAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
    workspace_id: WORKSPACE,
    pane_id: "manager-pane",
    tab_id: "manager-tab",
  };
  const independentLeadSession = `lead-${randomUUID()}`;
  const independentWorkspace = `workspace-${randomUUID()}`;
  const independentLead = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: independentLeadSession,
    },
    workspace_id: independentWorkspace,
    pane_id: "independent-pane",
    tab_id: "independent-tab",
    cwd: "/tmp/independent-project",
  };
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: independentLeadSession,
    updatedAt: Date.now(),
  });
  const exec = (command: string, args: string[]) => {
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace:
          args[2] === WORKSPACE
            ? { worktree: { repo_key: "repo-key", is_linked_worktree: false } }
            : args[2] === independentWorkspace
              ? {
                  worktree: {
                    repo_key: "other-repo",
                    is_linked_worktree: false,
                  },
                }
              : {},
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      if (args[args.indexOf("--workspace") + 1] === independentWorkspace)
        return respond({
          source: {
            source_workspace_id: independentWorkspace,
            repo_key: "other-repo",
            repo_name: "other",
          },
          worktrees: [],
        });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: WORKSPACE,
          repo_key: "repo-key",
          repo_name: "project",
        },
        worktrees: [],
      });
    if (command === "herdr" && isAgentList(args))
      return respond({ agents: [managerAgent, independentLead] });
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({ agent: managerAgent });
    if (command === "herdr" && isApiSnapshot(args))
      return respond({
        snapshot: { agents: [managerAgent, independentLead], panes: [] },
      });
    return respond({});
  };
  const manager = fakeChiefPi({ activeTools: ["read"], exec });
  registerExtension!(manager.pi as never);
  try {
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    await manager.events.get("session_start")![0](undefined, fakeContext());
    await manager.commandOptions.get("manager").handler("", fakeContext());
    process.env.HERDR_WORKSPACE_ID = "chief-workspace";
    process.env.HERDR_PANE_ID = "chief-pane";
    process.env.HERDR_TAB_ID = "chief-tab";
    const chief = fakeChiefPi({ activeTools: ["read"], exec });
    const chiefCtx = fakeContext() as any;
    chiefCtx.sessionManager.getSessionId = () => `chief-${randomUUID()}`;
    const chiefSession = chiefCtx.sessionManager.getSessionId();
    chiefCtx.sessionManager.getSessionId = () => chiefSession;
    registerExtension!(chief.pi as never);
    const mailboxLabel = `chief-missing-definition-${randomUUID()}`;
    try {
      await chief.events.get("session_start")![0](undefined, chiefCtx);
      await chief.commandOptions.get("chief").handler("", chiefCtx);
      assert.deepEqual(chief.pi.getActiveTools(), chiefTools);
      const mailbox = agentMailboxPath(WORKSPACE, mailboxLabel);
      const state = managedState(
        mailboxLabel,
        undefined,
        recoveryIdentity(mailboxLabel),
      );
      assert.equal(state.agentDefinition, undefined);
      writeAgentState(mailbox, state);
      const { SessionManager } =
        await import("@earendil-works/pi-coding-agent");
      const sessionManager = SessionManager as any;
      const originalOpen = sessionManager.open;
      let openCalls = 0;
      sessionManager.open = (...args: any[]) => {
        openCalls++;
        return originalOpen.apply(sessionManager, args);
      };
      let chiefPrompt;
      try {
        chiefPrompt = await chief.events.get("before_agent_start")![0](
          { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
          chiefCtx,
        );
      } finally {
        sessionManager.open = originalOpen;
      }
      assert.equal(openCalls, 0);
      assert.equal(chiefPrompt?.message, undefined);
      const contextMessage = chief.sentMessageCalls.findLast(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-supervision-context",
      );
      assert.ok(
        JSON.stringify(contextMessage?.message).includes(
          independentLeadSession,
        ),
      );
      const staff = chief.tools.find((tool) => tool.name === "staff_list")!;
      const listed = await staff.execute(
        "list",
        {},
        undefined,
        undefined,
        chiefCtx,
      );
      assert.equal(listed.details.self.role, "chief");
      assert.equal(listed.details.reports.length, 2);
      assert.equal(listed.details.reports[0].role, "manager");
      assert.equal(listed.details.reports[0].session, LEAD_SESSION_ID);
      assert.equal(listed.details.reports[0].leads.length, 0);
      assert.equal(listed.details.reports[1].role, "lead");
      assert.equal(listed.details.reports[1].session, independentLeadSession);
      await assert.rejects(
        chief.tools
          .find((tool) => tool.name === "staff_message")!
          .execute(
            "message",
            {
              session: "unrelated-lead",
              message: "Not a direct report",
            },
            undefined,
            undefined,
            chiefCtx,
          ),
        /not a current direct report|Lead target was not found or is no longer eligible/,
      );
    } finally {
      resetAgentMailbox(agentMailboxPath(WORKSPACE, mailboxLabel));
      await chief.events.get("session_shutdown")![0]();
    }
  } finally {
    await manager.events.get("session_shutdown")![0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("a Lead without a Manager routes upward to Chief and keeps peer presence", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presence-health-${randomUUID()}.sock`,
  );
  const chiefId = `chief-${randomUUID()}`;
  const descriptorIdentity = {
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: descriptorIdentity.paneId,
    tab_id: descriptorIdentity.tabId,
    workspace_id: descriptorIdentity.workspaceId,
    cwd: "/tmp",
  };
  const lease = claimChiefLease(descriptorIdentity);
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    entries,
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: "root-workspace",
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [{ open_workspace_id: WORKSPACE }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [chiefAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: chiefAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(
    [],
    [
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "supervisor_message" }],
        },
      },
    ],
  ) as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);

    const sessionId = context.sessionManager.getSessionId();
    const initial = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(initial);

    const chief = pi.tools.find((tool) => tool.name === "supervisor_message");
    assert.ok(chief);
    const result = await chief.execute(
      "message",
      { message: "Which path?" },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /Message sent to supervisor/);
    assert.equal(
      listCoordinationMessagePaths(supervisionRuntime(), chiefId).length,
      1,
    );
    assert.equal(
      readPeerLeadRecord(peerRuntime(), sessionId)?.claim.id,
      initial.claim.id,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("ordinary Lead peer presence disappears in Chief mode and on shutdown", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presence-lifecycle-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ entries, activeTools: ["read", "bash"] });
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const first = readPeerLeadRecord(
      peerRuntime(),
      context.sessionManager.getSessionId(),
    );
    assert.ok(first);
    assert.equal(listPeerLeadRecords(peerRuntime()).length, 1);

    await pi.commandOptions.get("chief").handler("", context);
    assert.equal(
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
      undefined,
    );
    assert.deepEqual(listPeerLeadRecords(peerRuntime()), []);

    await pi.commandOptions.get("chief").handler("leave", context);
    const restored = readPeerLeadRecord(
      peerRuntime(),
      context.sessionManager.getSessionId(),
    );
    assert.ok(restored);
    assert.notEqual(restored.claim.id, first.claim.id);

    await pi.events.get("session_shutdown")![0]();
    assert.deepEqual(listPeerLeadRecords(peerRuntime()), []);
  } finally {
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Chief message persistence failure can recover without withdrawing peer presence", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presence-health-${randomUUID()}.sock`,
  );
  const chiefId = `chief-${randomUUID()}`;
  const descriptorIdentity = {
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: descriptorIdentity.paneId,
    tab_id: descriptorIdentity.tabId,
    workspace_id: descriptorIdentity.workspaceId,
    cwd: "/tmp",
  };
  const lease = claimChiefLease(descriptorIdentity);
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    entries,
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: "root-workspace",
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [{ open_workspace_id: WORKSPACE }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [chiefAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: chiefAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(
    [],
    [
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "supervisor_message" }],
        },
      },
    ],
  ) as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  let obstruction: string | undefined;
  try {
    await pi.events.get("session_start")![0](undefined, context);

    const sessionId = context.sessionManager.getSessionId();
    const initial = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(initial);

    const runtime = supervisionRuntime();
    mkdirSync(runtime.inbox, { recursive: true });
    obstruction = join(
      runtime.inbox,
      createHash("sha256").update(chiefId).digest("hex"),
    );
    writeFileSync(obstruction, "block Chief inbox creation");

    const chief = pi.tools.find((tool) => tool.name === "supervisor_message");
    assert.ok(chief);
    await assert.rejects(
      chief.execute(
        "message",
        { message: "Which path?" },
        undefined,
        undefined,
        context,
      ),
      /EEXIST|not a directory/i,
    );
    assert.equal(
      readPeerLeadRecord(peerRuntime(), sessionId)?.claim.id,
      initial.claim.id,
    );
    rmSync(obstruction, { force: true });
    const result = await chief.execute(
      "message",
      { message: "Retry after inbox recovery" },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /Message sent to supervisor/);
    assert.equal(listCoordinationMessagePaths(runtime, chiefId).length, 1);
    assert.equal(
      readPeerLeadRecord(peerRuntime(), sessionId)?.claim.id,
      initial.claim.id,
    );
  } finally {
    // A failed assertion before the retry must not leave the temporary obstacle.
    if (obstruction) rmSync(obstruction, { recursive: true, force: true });
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Chief leave restores minimal peer presence before provenance resolves", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-chief-leave-provenance-${randomUUID()}.sock`,
  );
  const sessionId = randomUUID();
  const runtime = peerRuntime();
  const startupProvenance = testGate<void>();
  const leaveProvenance = testGate<void>();
  const releaseProvenance = testGate<void>();
  let provenanceCalls = 0;
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    entries,
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get") {
        const call = ++provenanceCalls;
        if (call === 1) startupProvenance.resolve();
        if (call === 2) leaveProvenance.resolve();
        await releaseProvenance.promise;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: {
                label: call === 1 ? "stale-generation" : "fresh-generation",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  registerExtension!(pi.pi as never);
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  try {
    const starting = sessionStart(undefined, context);
    await startupProvenance.promise;
    await starting;

    const initial = readPeerLeadRecord(runtime, sessionId);
    assert.ok(initial);
    assert.equal(initial.repo, undefined);
    assert.equal(initial.branch, undefined);
    assert.equal(initial.workspaceLabel, undefined);

    await pi.commandOptions.get("chief").handler("", context);
    const leaving = pi.commandOptions.get("chief").handler("leave", context);
    await leaveProvenance.promise;
    await leaving;

    const restored = readPeerLeadRecord(runtime, sessionId);
    assert.ok(restored);
    assert.notEqual(restored.claim.id, initial.claim.id);
    assert.equal(restored.cwd, context.cwd);
    assert.equal(restored.repo, undefined);
    assert.equal(restored.branch, undefined);
    assert.equal(restored.workspaceLabel, undefined);

    releaseProvenance.resolve();
    await t.waitFor(() => {
      const current = readPeerLeadRecord(runtime, sessionId);
      assert.equal(current?.claim.id, restored.claim.id);
      assert.equal(current?.workspaceLabel, "fresh-generation");
    });
    assert.equal(
      readPeerLeadRecord(runtime, sessionId)?.workspaceLabel,
      "fresh-generation",
    );
  } finally {
    releaseProvenance.resolve();
    await sessionShutdown();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("queued peer traffic stays durable through Chief mode and drains after leave", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `peer-chief-backpressure-${randomUUID()}.sock`);
  const receiverId = `receiver-${randomUUID()}`;
  const senderId = `sender-${randomUUID()}`;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "receiver-pane";
  process.env.HERDR_TAB_ID = "receiver-tab";
  const delivered = testGate<void>();
  const receiver = fakeChiefPi({
    sendMessage: (message) => {
      if (String((message as any)?.content ?? "").includes("queued peer")) {
        const waitForRemoval = () =>
          listCoordinationMessagePaths(runtime, receiverId).length === 0
            ? delivered.resolve()
            : queueMicrotask(waitForRemoval);
        queueMicrotask(waitForRemoval);
      }
    },
    activeTools: ["read", "bash"],
  });
  const receiverContext = fakeContext() as any;
  receiverContext.sessionManager = {
    ...receiverContext.sessionManager,
    getSessionId: () => receiverId,
  };
  const runtime = peerRuntime();
  const senderLease = acquireProcessLock(peerLeadLockPath(runtime, senderId), {
    name: "Lead peer presence",
  });
  const senderRecord = {
    version: 1 as const,
    piSessionId: senderId,
    paneId: "sender-pane",
    tabId: "sender-tab",
    workspaceId: WORKSPACE,
    claim: senderLease.claim,
    updatedAt: Date.now(),
  };
  writePeerLeadRecord(runtime, senderRecord);
  registerExtension!(receiver.pi as never);
  try {
    await receiver.events.get("session_start")![0](undefined, receiverContext);
    assert.ok(readPeerLeadRecord(runtime, receiverId));
    const record = {
      version: 2 as const,
      id: randomUUID(),
      leaseId: senderRecord.claim.id,
      kind: "peer_message" as const,
      fromSessionId: senderId,
      toSessionId: receiverId,
      leadSessionId: senderId,
      text: "queued peer",
      createdAt: Date.now(),
    };
    writeCoordinationMessage(record, runtime);

    await receiver.commandOptions.get("chief").handler("", receiverContext);
    assert.equal(
      receiver.sentMessageCalls.filter((call) =>
        String((call.message as any)?.content ?? "").includes("queued peer"),
      ).length,
      0,
    );
    assert.equal(listCoordinationMessagePaths(runtime, receiverId).length, 1);

    await receiver.commandOptions
      .get("chief")
      .handler("leave", receiverContext);
    await delivered.promise;
    await Promise.resolve();
    const peerDeliveries = receiver.sentMessageCalls.filter((call) =>
      String((call.message as any)?.content ?? "").includes("queued peer"),
    );
    assert.equal(peerDeliveries.length, 1);
    assert.deepEqual(listCoordinationMessagePaths(runtime, receiverId), []);
  } finally {
    await receiver.events.get("session_shutdown")?.[0]();
    removePeerLeadRecord(runtime, senderId);
    senderLease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("peer delivery survives sender shutdown and is accepted exactly once", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `peer-sender-shutdown-${randomUUID()}.sock`);
  const senderId = `sender-${randomUUID()}`;
  const targetId = `target-${randomUUID()}`;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "sender-pane";
  process.env.HERDR_TAB_ID = "sender-tab";
  const sender = fakeChiefPi({ activeTools: ["read", "bash"] });
  const senderContext = fakeContext() as any;
  senderContext.sessionManager = {
    ...senderContext.sessionManager,
    getSessionId: () => senderId,
  };
  registerExtension!(sender.pi as never);
  const runtime = peerRuntime();
  const targetLease = acquireProcessLock(peerLeadLockPath(runtime, targetId), {
    name: "Lead peer presence",
  });
  const targetRecord = {
    version: 1 as const,
    build: OTHER_HERDSMAN_BUILD,
    piSessionId: targetId,
    paneId: "target-pane",
    tabId: "target-tab",
    workspaceId: WORKSPACE,
    claim: targetLease.claim,
    updatedAt: Date.now(),
  };
  writePeerLeadRecord(runtime, targetRecord);
  try {
    await sender.events.get("session_start")![0](undefined, senderContext);
    const peer = sender.tools.find((tool) => tool.name === "peer_message");
    assert.ok(peer);
    await assert.rejects(
      peer.execute(
        "message",
        { session: targetId, message: "mismatch must not publish" },
        undefined,
        undefined,
        senderContext,
      ),
      (
        error: Error & { category?: string; detail?: { category?: string } },
      ) => {
        assert.equal(
          error.category ?? error.detail?.category,
          "incompatible_build",
        );
        return true;
      },
    );
    assert.deepEqual(listCoordinationMessagePaths(runtime, targetId), []);
    writePeerLeadRecord(runtime, {
      ...targetRecord,
      build: HERDSMAN_BUILD,
    });
    const queued = await peer.execute(
      "message",
      { session: targetId, message: "sender survived" },
      undefined,
      undefined,
      senderContext,
    );
    assert.equal(queued.details?.session, targetId);
    await sender.events.get("session_shutdown")![0]();
    assert.equal(readPeerLeadRecord(runtime, senderId), undefined);

    targetLease.release();
    process.env.HERDR_PANE_ID = "target-pane";
    process.env.HERDR_TAB_ID = "target-tab";
    const delivered = testGate<void>();
    const receiver = fakeChiefPi({
      sendMessage: (message) => {
        if (
          String((message as any)?.content ?? "").includes("sender survived")
        ) {
          const waitForRemoval = () =>
            listCoordinationMessagePaths(runtime, targetId).length === 0
              ? delivered.resolve()
              : queueMicrotask(waitForRemoval);
          queueMicrotask(waitForRemoval);
        }
      },
      activeTools: ["read", "bash"],
    });
    const receiverContext = fakeContext() as any;
    receiverContext.sessionManager = {
      ...receiverContext.sessionManager,
      getSessionId: () => targetId,
    };
    registerExtension!(receiver.pi as never);
    try {
      await receiver.events.get("session_start")![0](
        undefined,
        receiverContext,
      );
      await delivered.promise;
      await Promise.resolve();
      const deliveries = receiver.sentMessageCalls.filter((call) =>
        String((call.message as any)?.content ?? "").includes(
          "sender survived",
        ),
      );
      assert.equal(deliveries.length, 1);
      assert.deepEqual(listCoordinationMessagePaths(runtime, targetId), []);
    } finally {
      await receiver.events.get("session_shutdown")?.[0]();
    }
  } finally {
    removePeerLeadRecord(runtime, senderId);
    removePeerLeadRecord(runtime, targetId);
    try {
      targetLease.release();
    } catch {}
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("competing Lead focuses Chief with an absent prospective session path", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-focus-${randomUUID()}.sock`,
  );
  const descriptor = {
    piSessionId: randomUUID(),
    piSessionFile: join(tmpdir(), `prospective-chief-${randomUUID()}.jsonl`),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const chiefAgent = {
    pane_id: descriptor.paneId,
    tab_id: descriptor.tabId,
    workspace_id: descriptor.workspaceId,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: descriptor.piSessionFile,
    },
  };
  const lease = claimChiefLease(descriptor);
  const pi = fakeChiefPi({
    exec: (command, args) => {
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [chiefAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: chiefAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext() as any;
  context.hasUI = true;
  const confirmations: string[][] = [];
  context.ui.confirm = async (title: string, message: string) => {
    confirmations.push([title, message]);
    return true;
  };
  registerExtension!(pi.pi as never);
  try {
    assert.equal(realFs.existsSync(descriptor.piSessionFile), false);
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    assert.deepEqual(confirmations, [
      ["Focus Chief?", "Focus the currently active Chief pane?"],
    ]);
    assert.deepEqual(
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "focus"),
      [["agent", "focus", descriptor.paneId]],
    );
    assert.equal(realFs.existsSync(descriptor.piSessionFile), false);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Chief shutdown releases its lease when ordinary tool restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-suspend-failure-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.includes("read")) {
      failRestore = false;
      throw new Error("tool restoration failed");
    }
    setActiveTools(next);
  };

  await pi.events.get("session_shutdown")![0]();

  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-role" && entry.data.role === "chief",
    ),
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief activation keeps its durable baseline when rollback restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-activation-rollback-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  const setActiveTools = pi.pi.setActiveTools;
  let activationAttempted = false;
  let failures = 1;
  pi.pi.setActiveTools = (next: string[]) => {
    if (next.includes("staff_list")) {
      activationAttempted = true;
      throw new Error("Chief activation failed");
    }
    if (
      activationAttempted &&
      failures > 0 &&
      next.join("|") === baseline.join("|")
    ) {
      failures--;
      throw new Error("Chief baseline restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("", context);

  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  assert.deepEqual(notices, ["Chief activation failed"]);
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief leave cancellation preserves Chief tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  const pi = fakeChiefPi({ activeTools: ["read", "bash"] });
  const context = fakeContext() as any;
  context.hasUI = true;
  const confirmations: string[][] = [];
  context.ui.confirm = async (title: string, message: string) => {
    confirmations.push([title, message]);
    return false;
  };
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    const chiefToolsNow = pi.pi.getActiveTools();

    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    await pi.commandOptions.get("chief").handler("leave", context);
    assert.deepEqual(confirmations, [
      ["Leave chief mode?", "Supervised leads will not be changed."],
    ]);
    assert.deepEqual(notices, ["Chief leave cancelled."]);
    assert.deepEqual(pi.pi.getActiveTools(), chiefToolsNow);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Chief tool activation failure restores ordinary Lead tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-tool-activation-failure-${randomUUID()}.sock`,
  );
  const pi = fakeChiefPi({
    activeTools: ["read", "bash"],
    exec: (command, args) =>
      command === "herdr" && args[0] === "worktree" && args[1] === "list"
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                source: {
                  source_workspace_id: "root-workspace",
                  repo_key: "repo-key",
                  repo_name: "project",
                },
                worktrees: [{ open_workspace_id: WORKSPACE }],
              },
            }),
            stderr: "",
            code: 0,
          }
        : undefined,
  });
  const context = fakeContext() as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const ordinaryTools = pi.pi.getActiveTools();
    const setActiveTools = pi.pi.setActiveTools;
    pi.pi.setActiveTools = (next: string[]) => {
      if (next.includes("staff_list"))
        throw new Error("Chief tool activation failed");
      setActiveTools(next);
    };

    await pi.commandOptions.get("chief").handler("", context);

    assert.deepEqual(pi.pi.getActiveTools(), ordinaryTools);
    assert.deepEqual(notices, ["Chief tool activation failed"]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("selecting a pre-Chief branch restores the Lead lifecycle", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-start-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  const preChiefBranch = [...entries];
  assert.equal(sessionLeadRoleState(preChiefBranch), undefined);
  await pi.commandOptions.get("chief").handler("", context);
  assert.equal(
    readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
    undefined,
  );
  context.sessionManager.getBranch = () => preChiefBranch;
  const appendEntry = pi.pi.appendEntry;
  pi.pi.appendEntry = (type: string, data: unknown) => {
    appendEntry(type, data);
    preChiefBranch.push({ type: "custom", customType: type, data });
  };
  pi.pi.setActiveTools(baseline);
  await pi.events.get("session_tree")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  const replacement = claimChiefLease({
    piSessionId: "replacement-session",
    paneId: "replacement-pane",
    tabId: "replacement-tab",
    workspaceId: WORKSPACE,
  });
  replacement.release();
  assert.equal(
    sessionLeadRoleState(context.sessionManager.getBranch())?.role,
    "lead",
  );
  assert.ok(
    readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
  );
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
});

test("selecting a historical Chief branch activates its lease and staff tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-branch-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const baseline = pi.pi.getActiveTools();
    const chiefBranch = [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { role: "chief", leadTools: baseline },
      },
    ];
    context.sessionManager.getBranch = () => chiefBranch;
    await pi.events.get("session_tree")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), [
      "staff_list",
      "staff_inspect",
      "staff_transcript",
      "staff_message",
    ]);
    assert.equal(
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
      undefined,
    );
    assert.throws(() =>
      claimChiefLease({
        piSessionId: "replacement-session",
        paneId: "replacement-pane",
        tabId: "replacement-tab",
        workspaceId: WORKSPACE,
      }),
    );
    assert.equal(sessionLeadRoleState(entries)?.role, "chief");
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
});

test("malformed selected branch withdraws stale Chief authority", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `malformed-branch-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    context.sessionManager.getBranch = () => [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { role: "chief" },
      },
    ];
    pi.pi.setActiveTools(["read", "bash"]);
    await pi.events.get("session_tree")![0](undefined, context);
    assert.equal(pi.pi.getActiveTools().includes("staff_list"), false);
    assert.ok(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_role_error",
      ),
    );
    const replacement = claimChiefLease({
      piSessionId: "replacement-session",
      paneId: "replacement-pane",
      tabId: "replacement-tab",
      workspaceId: WORKSPACE,
    });
    replacement.release();
    assert.equal(
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
      undefined,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
});

test("manual chief leave completes lead cleanup when tool restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-leave-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("manual leave restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("leave", context);

  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  assert.deepEqual(
    entries
      .filter((entry: any) => entry.customType === "pi-herdsman-role")
      .at(-1)?.data,
    { role: "lead", leadTools: baseline },
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("lead session-start retries an exact baseline after restoration fails", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-lead-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const baseline = [
    "read",
    "bash",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ];
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "lead", leadTools: baseline },
  });
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("lead session-start restoration failed");
    }
    setActiveTools(next);
  };

  await start(undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("lead session-start restoration failed"),
    ),
  );
  await start(undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
});

test("lead session-start continues when chief lease release fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-release-failure-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: {
      role: "lead",
      leadTools: [
        "read",
        "bash",
        "agent_list",
        "agent_delegate",
        "agent_continue",
        "agent_steer",
        "agent_interrupt",
        "agent_reply",
        "agent_close",
        "agent_inspect",
        "agent_transcript",
        "supervisor_message",
        "peer_list",
        "peer_message",
      ],
    },
  });
  const runtime = supervisionRuntime();
  const owner = realFs.readdirSync(runtime.lock)[0];
  assert.ok(owner);
  realFs.writeFileSync(join(runtime.lock, owner), "{}");

  await start(undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), [
    "read",
    "bash",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes(
          "Unable to verify Chief supervision lease ownership",
        ),
    ),
  );
  await pi.events.get("session_shutdown")?.[0]();
  realFs.rmSync(runtime.root, { recursive: true, force: true });
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
});

test("Chief activation rejects owned work outside the current workspace", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const foreignWorkspace = `foreign-${randomUUID()}`;
  const mailbox = agentMailboxPath(foreignWorkspace, "foreign-agent");
  writeAgentState(mailbox, {
    ...managedState("foreign-agent"),
    workspaceId: foreignWorkspace,
    ownerSessionId: LEAD_SESSION_ID,
  });
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args)
        ? {
            stdout: JSON.stringify({ id: AGENT_ID, result: { agents: [] } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeContext() as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  assert.ok(notices.some((message) => /owned agent work exists/.test(message)));
  realFs.rmSync(mailbox, { recursive: true, force: true });
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("lead agents command uses native completion and exact human grammar", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  assert.deepEqual(
    pi.entryRenderers.map((entry) => entry.customType),
    ["pi-herdsman-agent-definitions", "pi-herdsman-herd-run"],
  );
  assert.ok(
    pi.messageRenderers.some(
      (message) => message.customType === "pi-herdsman-stop-summary",
    ),
  );
  const command = pi.commandOptions.get("agents");
  assert.ok(command);
  const alias = pi.commandOptions.get("herdsman");
  assert.ok(alias);
  assert.equal(alias.description, "Alias for /agents");
  assert.equal(alias.handler, command.handler);
  assert.equal(alias.getArgumentCompletions, command.getArgumentCompletions);
  assert.deepEqual(command.getArgumentCompletions(""), [
    { value: "stats", label: "stats" },
    { value: "definitions", label: "definitions" },
    { value: "placement", label: "placement" },
    { value: "stop", label: "stop" },
  ]);
  assert.deepEqual(
    alias.getArgumentCompletions(""),
    command.getArgumentCompletions(""),
  );
  assert.deepEqual(command.getArgumentCompletions("placement "), [
    { value: "placement tab", label: "tab" },
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  assert.deepEqual(command.getArgumentCompletions("placement s"), [
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  const context = fakeContext([]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.select = async () => undefined;
  context.ui.notify = (message: string) => notices.push(message);
  await command.handler("", context);
  await command.handler("agents extra", context);
  await command.handler("placement invalid", context);
  assert.deepEqual(notices, [
    "Usage: /agents stats | definitions | placement [tab|subtree|split] | stop",
    "Usage: /agents placement [tab|subtree|split]",
  ]);
});

test("/agents placement subtree writes flat config outside project settings", async () => {
  setLeadEnvironment();
  const projectRoot = join(PI_AGENT_ROOT, "placement-project");
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  realFs.mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = projectRoot;
  context.hasUI = true;
  try {
    await pi.commandOptions.get("agents").handler("placement subtree", context);
    assert.equal(
      JSON.parse(realFs.readFileSync(configPath, "utf8")).spawnPlacement,
      "subtree",
    );
    assert.equal(
      realFs.existsSync(join(projectRoot, ".pi", "settings.json")),
      false,
    );
  } finally {
    realFs.rmSync(projectRoot, { recursive: true, force: true });
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman"), {
      recursive: true,
      force: true,
    });
  }
});

test("Chief activation replaces the lead widget and overview selection is interactive", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const lead = {
    agent: "pi",
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: PARENT_SESSION_ID,
    },
    tokens: { pi_herdsman_role: "lead" },
  };
  const leads = [lead];
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    activeTools: ["agent", "chief", "read"],
    autoActivateRegisteredTools: true,
    entries,
    exec: (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list")
        return nonGitWorkspaceResponse();
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: leads, panes: leads } },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agents: leads } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agent: lead } }),
          stderr: "",
          code: 0,
        };
      return {
        stdout: JSON.stringify({ id: AGENT_ID, result: {} }),
        stderr: "",
        code: 0,
      };
    },
  });
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  const widgetKeys: string[] = [];
  const notices: string[] = [];
  let overview: any;
  let overviewDone = 0;
  let customCalls = 0;
  context.ui = {
    setWidget: (key: string) => widgetKeys.push(key),
    notify: (message: string) => notices.push(message),
    confirm: async () => false,
    select: async () => undefined,
    custom: async (factory: any) => {
      customCalls++;
      overview = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        () => overviewDone++,
      );
    },
  };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => ({ unref: () => undefined })) as any;
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    globalThis.setInterval = originalSetInterval;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
  assert.ok(widgetKeys.includes("pi-herdsman"));
  assert.ok(widgetKeys.includes("pi-herdsman-staff"));
  assert.equal(
    pi.commandOptions.get("chief").description,
    "Activate chief mode, or open its overview when already active",
  );
  assert.equal(customCalls, 0);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
  assert.equal(customCalls, 1);
  assert.ok(overview);
  assert.match(overview.render(120).join("\n"), /Pi Herdsman ·/);
  assert.doesNotMatch(overview.render(120).join("\n"), /Pi Chief/);
  assert.doesNotMatch(overview.render(120).join("\n"), /├─|└─/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(overview.render(120).every((line: string) => line.length <= 120));
  const customCallsBeforePeek = customCalls;
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(customCalls, customCallsBeforePeek);
  overview.handleInput("\u001b");
  assert.equal(overviewDone, 1);
  await pi.commandOptions.get("chief").handler("", context);
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  overview.handleInput(" ");
  assert.equal(overviewDone, 1);
  await pi.commandOptions.get("chief").handler("", context);
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  overview.handleInput("\u0003");
  assert.equal(overviewDone, 2);
  await pi.commandOptions.get("chief").handler("", context);
  overview.handleInput("\u001b[B");
  overview.handleInput("\r");
  await t.waitFor(() => assert.equal(overviewDone, 2, notices.join(" | ")));
});

test("Lead resume repairs stale staff from its durable displaced loadout", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-reload-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const ordinaryTools = [
    "read",
    "bash",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ];
  const pi = fakeChiefPi({
    activeTools: ordinaryTools,
    entries,
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);

  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), ordinaryTools);
  const role = entries
    .filter((entry: any) => entry.customType === "pi-herdsman-role")
    .at(-1) as any;
  assert.deepEqual(role.data, { role: "lead", leadTools: ordinaryTools });

  const reloaded = fakeChiefPi({
    activeTools: [
      "staff_list",
      "staff_inspect",
      "staff_transcript",
      "staff_message",
    ],
    entries: [...entries],
  });
  const reloadedContext = fakeContext(reloaded.entries) as any;
  reloadedContext.mode = "rpc";
  reloadedContext.ui.notify = () => undefined;
  registerExtension!(reloaded.pi as never);
  await reloaded.events.get("session_start")![0](undefined, reloadedContext);
  assert.deepEqual(reloaded.pi.getActiveTools(), ordinaryTools);

  await reloaded.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("ordinary branch tool state wins over an older lead checkpoint", async () => {
  setLeadEnvironment();
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        role: "lead",
        leadTools: [
          "read",
          "bash",
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "supervisor_message",
          "peer_list",
          "peer_message",
        ],
      },
    },
  ];
  const branchTools = [
    "read",
    "grep",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ];
  const pi = fakeChiefPi({ entries, activeTools: branchTools });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), branchTools);
  await pi.events.get("session_shutdown")?.[0]();
});

async function openChiefOverview(
  populated: boolean,
  options: {
    failSetWidget?: boolean;
    failRender?: boolean;
    failRefresh?: boolean;
    openOverview?: boolean;
  } = {},
) {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-tui-${randomUUID()}.sock`,
  );
  let failRefresh = options.failRefresh ?? false;
  const agents = populated
    ? [
        {
          agent: "pi",
          pane_id: "lead-pane",
          tab_id: "lead-tab",
          workspace_id: WORKSPACE,
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: PARENT_SESSION_ID,
          },
          tokens: { pi_herdsman_role: "lead" },
        },
      ]
    : [];
  const pi = fakeChiefPi({
    activeTools: ["agent", "chief", "read"],
    entries: [],
    exec: (_command, args) => {
      if (failRefresh && isApiSnapshot(args))
        throw new Error("supervision unavailable");
      return isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: { agents, panes: agents },
              },
            }),
            stderr: "",
            code: 0,
          }
        : isAgentList(args)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: { agents },
              }),
              stderr: "",
              code: 0,
            }
          : { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext([]) as any;
  context.hasUI = true;
  let component: any;
  let customCalls = 0;
  let doneCalls = 0;
  let renderRequests = 0;
  const widgetRegistrations: Array<{ key: string; content: unknown }> = [];
  context.ui = {
    setWidget: (key: string, content: unknown) => {
      if (options.failSetWidget && key === "pi-herdsman-staff")
        throw new Error("widget registration failed");
      widgetRegistrations.push({ key, content });
      if (content !== undefined) assert.equal(typeof content, "function");
      if (typeof content === "function")
        component = content(
          {
            requestRender: () => {
              if (options.failRender) throw new Error("render failed");
              renderRequests++;
            },
          },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    confirm: async () => false,
    select: async () => undefined,
    custom: async (factory: any) => {
      customCalls++;
      component = factory(
        { requestRender: () => renderRequests++ },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        () => doneCalls++,
      );
    },
  };
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (populated)
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      instanceId: randomUUID(),
      piSessionId: PARENT_SESSION_ID,
      updatedAt: Date.now(),
    });
  if (options.openOverview !== false)
    await pi.commandOptions.get("chief").handler("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    pi,
    context,
    component,
    get customCalls() {
      return customCalls;
    },
    get doneCalls() {
      return doneCalls;
    },
    get renderRequests() {
      return renderRequests;
    },
    setFailRefresh(value: boolean) {
      failRefresh = value;
    },
    widgetRegistrations,
    async cleanup() {
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_TAB_ID;
      setLeadEnvironment();
    },
  };
}

test("registered chief widget obeys registration, refresh, and teardown contracts", async () => {
  const originalSetInterval = globalThis.setInterval;
  const callbacks: TimerHandler[] = [];
  globalThis.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback);
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  try {
    const harness = await openChiefOverview(false, {
      openOverview: false,
    });
    const registrations = harness.widgetRegistrations.filter(
      ({ key, content }) =>
        key === "pi-herdsman-staff" && content !== undefined,
    );
    assert.equal(registrations.length, 1);
    assert.equal(typeof registrations[0].content, "function");
    assert.equal(typeof harness.component.render, "function");
    assert.equal(typeof harness.component.invalidate, "function");
    const before = harness.renderRequests;
    (callbacks.at(-1) as () => void)();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.renderRequests > before);
    assert.equal(
      harness.widgetRegistrations.filter(
        ({ key, content }) =>
          key === "pi-herdsman-staff" && content !== undefined,
      ).length,
      1,
    );
    await harness.cleanup();
    const teardown = harness.widgetRegistrations.filter(
      ({ key, content }) =>
        key === "pi-herdsman-staff" && content === undefined,
    );
    assert.ok(teardown.length > 0);
    assert.equal(teardown.at(-1)?.content, undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("Chief overview closes on native Escape and Ctrl+C with no herds", async () => {
  for (const key of ["\u001b", "\u0003"]) {
    const harness = await openChiefOverview(false);
    harness.component.handleInput(key);
    assert.equal(harness.doneCalls, 1);
    await harness.cleanup();
  }
});

test("Chief overview reports unavailable when its first refresh fails", async () => {
  const harness = await openChiefOverview(false, {
    failRefresh: true,
  });
  try {
    const output = harness.component.render(120).join("\n");
    assert.match(output, /Pi Herdsman · unavailable/);
    assert.doesNotMatch(output, /0 herds/);
  } finally {
    await harness.cleanup();
  }
});

test("Chief overview redraws identical herds when freshness changes", async () => {
  const originalSetInterval = globalThis.setInterval;
  const callbacks: TimerHandler[] = [];
  globalThis.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback);
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  try {
    const harness = await openChiefOverview(true);
    try {
      assert.match(harness.component.render(120).join("\n"), /1 herd/);
      assert.doesNotMatch(
        harness.component.render(120).join("\n"),
        /stale|unavailable/,
      );

      harness.setFailRefresh(true);
      (callbacks.at(-1) as () => void)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(harness.component.render(120).join("\n"), /1 herd · stale/);

      harness.setFailRefresh(false);
      (callbacks.at(-1) as () => void)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(harness.component.render(120).join("\n"), /1 herd/);
      assert.doesNotMatch(
        harness.component.render(120).join("\n"),
        /stale|unavailable/,
      );
    } finally {
      await harness.cleanup();
    }
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("Chief overview redraws after a background refresh", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<object>();
  let intervalCalls = 0;
  let refresh: (() => void) | undefined;
  globalThis.setInterval = ((callback: TimerHandler) => {
    refresh = callback as () => void;
    intervalCalls++;
    const timer = { unref: () => undefined };
    activeTimers.add(timer);
    return timer as any;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: any) => {
    activeTimers.delete(timer);
  }) as typeof clearInterval;
  try {
    const harness = await openChiefOverview(true);
    assert.equal(intervalCalls, 2);
    assert.equal(activeTimers.size, 1);
    const before = harness.renderRequests;
    refresh!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.renderRequests > before);
    await harness.cleanup();
    assert.equal(activeTimers.size, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("active chief shutdown clears its role before releasing the lease", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const pi = fakeChiefPi({
    exec: (_command, args) =>
      isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [], snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeContext() as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const activationCallCount = pi.calls.length;
  await pi.events.get("session_shutdown")?.[0]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const shutdownMetadata = pi.calls
    .slice(activationCallCount)
    .filter((args) => args[0] === "pane" && args[1] === "report-metadata");
  assert.ok(shutdownMetadata.some((args) => args.includes("--clear-token")));
  assert.ok(
    shutdownMetadata.every((args) => !args.includes("pi_herdsman_role=lead")),
  );
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("persisted chief resume isolates tools and restores its ordinary baseline", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-resume-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        role: "chief",
        leadTools: [
          "read",
          "bash",
          "foreign_tool",
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "supervisor_message",
          "peer_list",
          "peer_message",
        ],
      },
    },
  ];
  const pi = fakeChiefPi({
    entries,
    activeTools: ["read", "bash", "foreign_tool"],
    exec: (_command, args) =>
      isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [], snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "read",
    "bash",
    "foreign_tool",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ]);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  setLeadEnvironment();
});

test("persisted chief collision is suspended and has no lead authority", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        role: "chief",
        leadTools: [
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "supervisor_message",
        ],
      },
    },
  ];
  const incumbent = claimChiefLease({
    piSessionId: "incumbent-session",
    paneId: "incumbent-pane",
    tabId: "incumbent-tab",
    workspaceId: "incumbent-workspace",
  });
  try {
    const pi = fakeChiefPi({
      entries,
      activeTools: [
        "agent_list",
        "agent_delegate",
        "agent_continue",
        "agent_steer",
        "agent_interrupt",
        "agent_reply",
        "agent_close",
        "agent_inspect",
        "agent_transcript",
        "supervisor_message",
      ],
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext(entries) as any;
    context.ui.notify = () => undefined;
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), []);
    assert.equal(
      readLeadCoordinationState(
        supervisionRuntime(),
        context.sessionManager.getSessionId(),
      ),
      undefined,
    );
    await pi.events.get("session_shutdown")?.[0]();
  } finally {
    incumbent.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("plain agents opens the native management menu", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { workspace_id: WORKSPACE, agents: [] },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { panes: [] } }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const { contextAgentDefinitions } = await import("./agent-definitions.ts");
  const selectableDefinitions = await contextAgentDefinitions(context);
  assert.equal(
    selectableDefinitions.definitions.some(
      ({ name }) => name === "managed-lead",
    ),
    false,
  );
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1)
      return options.find((option) => option === "Settings");
    return undefined;
  };
  await command.handler("", context);
  assert.equal(prompts[0]?.label, `Pi Herdsman · v${packageMetadata.version}`);
  assert.deepEqual(
    prompts[0]?.options.map((option) =>
      /^(Running|Definitions)\s/u.test(option)
        ? option.replace(/\s+.*/u, "")
        : option,
    ),
    ["Running", "Session stats", "Definitions", "Settings", "Stop all…"],
  );
  assert.equal(prompts[0]?.options[0], "Running  0");
  assert.equal(
    prompts[0]?.options[2],
    `Definitions  ${selectableDefinitions.definitions.length + 1}`,
  );
  assert.equal(prompts[1]?.label, "Settings");
  assert.deepEqual(prompts[1]?.options, [
    "Manager auto-start  off",
    "Layout  subtree",
    "Context retirement  on",
    "Message limits",
  ]);
  await pi.events.get("session_shutdown")?.[0]();
});

test("agents TUI selectors use stable values and current preselection", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const renders: string[][] = [];
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      renders.push(component.render(200));
      switch (customCalls++) {
        case 0:
          for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 1:
          component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 2: {
          component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        }
        case 3:
          component.handleInput("\u001b");
          break;
        default:
          component.handleInput("\u001b");
      }
    });
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.ok(
      renders[0]?.some((line) =>
        line.includes(`Pi Herdsman · v${packageMetadata.version}`),
      ),
    );
    assert.ok(
      renders[2]?.some((line) => /^→ Subtree tabs\s+current/u.test(line)),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("agents root contextual help follows the selected row", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const observed: string[][] = [];
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      const snapshot = () => component.render(200);
      observed.push(snapshot());
      for (let i = 0; i < 3; i++) {
        component.handleInput("\u001b[B");
        observed.push(snapshot());
      }
      component.handleInput("\u001b");
    });
  try {
    await pi.commandOptions.get("agents").handler("", context);
    const help = (index: number) =>
      observed[index]?.find((line) =>
        /Focus a live managed Agent|Show Pi-native token usage|Inspect effective Agent and managed Lead definitions and edit global overrides|Configure Manager startup, Agent placement, context retirement, and message limits/u.test(
          line,
        ),
      ) ?? "";
    assert.match(help(0), /Focus a live managed Agent\./u);
    assert.match(
      help(1),
      /Show Pi-native token usage and cost for this session and owned Agents\./u,
    );
    assert.match(
      help(1),
      /Manager mode also includes current assigned Leads and their owned Agent trees\./u,
    );
    assert.doesNotMatch(help(1), /Focus a live managed Agent/u);
    assert.match(
      help(2),
      /Inspect effective Agent and managed Lead definitions and edit global overrides\./u,
    );
    assert.match(
      help(3),
      /Configure Manager startup, Agent placement, context retirement, and message limits\./u,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions contextual help uses the selected definition description", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "help-agent.md");
  const description = "Existing definition description for contextual help.";
  realFs.writeFileSync(
    definitionPath,
    `---\nname: help-agent\ndescription: ${description}\n---\nInstructions.\n`,
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const { contextAgentDefinitions } = await import("./agent-definitions.ts");
  const definitions = await contextAgentDefinitions(context);
  const expectedHelp = definitions.definitions.find(
    ({ name }) => name === "help-agent",
  )?.frontmatter.description;
  assert.equal(expectedHelp, description);

  const observed: string[][] = [];
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      const call = customCalls++;
      if (call === 0) {
        component.handleInput("\u001b[B");
        component.handleInput("\u001b[B");
        component.handleInput("\r");
        return;
      }
      if (call > 1) {
        component.handleInput("\u001b");
        return;
      }
      for (let attempts = 0; attempts < 100; attempts++) {
        const rendered = component.render(200);
        observed.push(rendered);
        const selected = rendered.find((line: string) =>
          line.trimStart().startsWith("→"),
        );
        if (selected?.includes("help-agent")) {
          component.handleInput("\u001b");
          return;
        }
        component.handleInput("\u001b[B");
      }
      throw new Error("TUI item was not selected: help-agent");
    });
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.equal(typeof expectedHelp, "string");
    assert.ok(
      observed.some((rendered) => rendered.includes(expectedHelp as string)),
      `Expected Definitions help to render ${JSON.stringify(expectedHelp)}`,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

const selectTuiItem = (component: any, target: string): void => {
  for (let attempts = 0; attempts < 100; attempts++) {
    const selected = component
      .render(200)
      .find((line: string) => line.trimStart().startsWith("→"));
    if (selected?.includes(target)) {
      component.handleInput("\r");
      return;
    }
    component.handleInput("\u001b[B");
  }
  throw new Error(`TUI item was not selected: ${target}`);
};

test("definition pickers preselect configured values and honor cancellation", async () => {
  for (const scenario of [
    {
      field: "Model",
      picker: "Inherit current session",
      property: "model",
      source: "---\nname: preselect-agent\n---\n",
      expected: undefined,
    },
    {
      field: "Model",
      picker: "model",
      property: "model",
      source: "---\nname: preselect-agent\nmodel: provider/model\n---\n",
      expected: "provider/model",
    },
    {
      field: "Model",
      picker: "model",
      filter: " ",
      property: "model",
      source: "---\nname: preselect-agent\nmodel: provider/model\n---\n",
      expected: "provider/model",
    },
    {
      field: "Thinking",
      picker: "Inherit current session",
      property: "thinking",
      source: "---\nname: preselect-agent\n---\n",
      expected: undefined,
    },
    {
      field: "Thinking",
      picker: "high",
      property: "thinking",
      source: "---\nname: preselect-agent\nthinking: high\n---\n",
      expected: "high",
    },
    {
      field: "Model",
      picker: undefined,
      property: "model",
      source: "---\nname: preselect-agent\n---\n",
      expected: undefined,
    },
  ] as const) {
    setLeadEnvironment();
    const definitionPath = join(PI_AGENTS_DIR, "preselect-agent.md");
    realFs.writeFileSync(definitionPath, scenario.source);
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "tui";
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => [{ provider: "provider", id: "model", reasoning: true }],
      getAvailable: () => [
        { provider: "provider", id: "model", reasoning: true },
      ],
    };
    let customCalls = 0;
    const keybindings = {
      matches: (data: string, key: string) =>
        ({
          "tui.select.up": "\u001b[A",
          "tui.select.down": "\u001b[B",
          "tui.select.confirm": "\r",
          "tui.select.cancel": "\u001b",
        })[key] === data,
    };
    context.ui.custom = async (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          keybindings,
          resolve,
        );
        const call = customCalls++;
        if (call === 0) {
          selectTuiItem(component, "preselect-agent");
        } else if (call === 1) {
          selectTuiItem(component, scenario.field);
        } else if (call === 2 && scenario.picker !== undefined) {
          if ("filter" in scenario && scenario.filter !== undefined)
            for (const character of scenario.filter)
              component.handleInput(character);
          const line = component
            .render(200)
            .find((candidate: string) => candidate.includes(scenario.picker));
          assert.match(line ?? "", /^→/u);
          component.handleInput("\r");
        } else component.handleInput("\u001b");
      });
    try {
      await pi.commandOptions.get("agents").handler("definitions", context);
      assert.equal(customCalls, 5, JSON.stringify(scenario));
      assert.equal(
        discoverAgent("preselect-agent").frontmatter[scenario.property],
        scenario.expected,
      );
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("TUI Model picker fuzzy-filters models and cancels in place", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "search-agent.md");
  realFs.writeFileSync(
    definitionPath,
    "---\nname: search-agent\nmodel: alpha/original\n---\n",
  );
  const models = [
    ...Array.from({ length: 15 }, (_, index) => ({
      provider: `provider-${index}`,
      id: `model-${index}`,
      name: `Model ${index}`,
      reasoning: true,
    })),
    {
      provider: "zulu",
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      reasoning: true,
    },
    {
      provider: "alpha",
      id: "original",
      name: "Original",
      reasoning: true,
    },
  ];
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => models,
    getAvailable: () => models,
  };
  context.scopedModels = [{ model: models[models.length - 1] }];
  const keybindings = {
    matches: (data: string, key: string) =>
      ({
        "tui.select.up": "\u001b[A",
        "tui.select.down": "\u001b[B",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\u001b",
      })[key] === data,
  };
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        keybindings,
        resolve,
      );
      switch (customCalls++) {
        case 0:
          selectTuiItem(component, "search-agent");
          break;
        case 1:
          selectTuiItem(component, "Model");
          break;
        case 2:
          for (const character of "zulu 46") component.handleInput(character);
          {
            const rendered = component.render(200);
            const selected = rendered.find((line: string) =>
              line.trimStart().startsWith("→"),
            );
            assert.match(selected ?? "", /claude-sonnet-4-6/u);
            assert.ok(
              rendered.some((line: string) => line.includes("zulu 46")),
            );
          }
          component.handleInput("\r");
          break;
        case 3:
          selectTuiItem(component, "Model");
          break;
        case 4:
        case 5:
        case 6:
          component.handleInput("\u001b");
          break;
      }
    });
  try {
    await pi.commandOptions.get("agents").handler("definitions", context);
    assert.equal(customCalls, 7);
    assert.equal(
      discoverAgent("search-agent").frontmatter.model,
      "zulu/claude-sonnet-4-6",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("settings navigation exposes message limits and one rough token formatter", async () => {
  setLeadEnvironment();
  const previousPlacement = readConfig().spawnPlacement;
  updateConfig("spawnPlacement", "subtree");
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1)
      return options.find((option) => option === "Settings");
    if (prompts.length === 2)
      return options.find((option) => option.startsWith("Message limits"));
    if (prompts.length === 3) return options[0];
    if (prompts.length === 4) return options[1];
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.equal(prompts[1]?.label, "Settings");
    assert.deepEqual(prompts[1]?.options, [
      "Manager auto-start  off",
      "Layout  subtree",
      "Context retirement  on",
      "Message limits",
    ]);
    assert.equal(prompts[2]?.label, "Message limits");
    assert.match(prompts[2]?.options[0] ?? "", /≈32,768 tokens/);
    assert.match(prompts[2]?.options[1] ?? "", /≈32,768 tokens/);
    assert.ok(prompts.every(({ label }) => label !== "Scope"));
    assert.deepEqual(
      prompts[2]?.options.map((option) => option.split("  ")[0]),
      ["Inline attachments", "Mailbox payload"],
    );
    assert.match(
      prompts[2]?.options[0] ?? "",
      /Inline attachments  128 KiB · ≈32,768 tokens/u,
    );
    assert.match(
      prompts[2]?.options[1] ?? "",
      /Mailbox payload  128 KiB · ≈32,768 tokens/u,
    );
    assert.match(notices.at(-1) ?? "", /4 KiB · ≈1,024 tokens/);
  } finally {
    updateConfig("spawnPlacement", previousPlacement);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("settings toggles context retirement and retains its updated value", async () => {
  setLeadEnvironment();
  updateConfig("contextRetirement", undefined);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const menus: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  let rootSelections = 0;
  context.ui.select = async (label: string, options: string[]) => {
    menus.push({ label, options });
    if (label.startsWith("Pi Herdsman"))
      return rootSelections++ % 2 === 0 ? "Settings" : undefined;
    return readConfig().contextRetirement !== false
      ? options.find((option) => option.includes("Context retirement"))
      : undefined;
  };
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.match(
      menus[1]?.options.find((option) =>
        option.includes("Context retirement"),
      ) ?? "",
      /Context retirement\s+on/,
    );
    assert.equal(readConfig().contextRetirement, false);
    assert.deepEqual(notices, ["Context retirement: off"]);
    await pi.commandOptions.get("agents").handler("", context);
    assert.match(
      menus
        .filter(({ label }) => label === "Settings")
        .at(-1)
        ?.options.find((option) => option.includes("Context retirement")) ?? "",
      /Context retirement\s+off/,
    );
  } finally {
    updateConfig("contextRetirement", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Manager auto-start menu toggle does not change the running role", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", undefined);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const activeTools = pi.pi.getActiveTools();
  const notices: string[] = [];
  let selection = 0;
  context.ui.select = async (_title: string, options: string[]) => {
    if (selection++ === 0) return "Settings";
    return selection === 2
      ? options.find((option) => option.includes("Manager auto-start"))
      : undefined;
  };
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.equal(readConfig().autoActivateManager, true);
    assert.deepEqual(pi.pi.getActiveTools(), activeTools);
    assert.deepEqual(notices, ["Manager auto-start: on"]);
  } finally {
    updateConfig("autoActivateManager", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("message limit edits stay in the submenu with the edited field selected", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const renders: string[][] = [];
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      renders.push(component.render(200));
      switch (customCalls++) {
        case 0:
          for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 1:
          for (let i = 0; i < 2; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 2:
          component.handleInput("\r");
          break;
        case 3:
          component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 4:
          component.handleInput("\u001b");
          break;
        default:
          component.handleInput("\u001b");
      }
    });
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.ok(renders[4]?.some((line) => line.includes("Inline attachments")));
    assert.match(
      renders[4]?.find((line) => line.includes("Inline attachments")) ?? "",
      /^→/u,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Running uses compact native options and focuses the freshly verified pane", async () => {
  setLeadEnvironment();
  const label = "running-menu-agent";
  const identity = defaultFixtureIdentity;
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const pi = fakePi({
    exec: leadExec(label, "working", DEFAULT_PI_SESSION_ID),
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (prompt: string, options: string[]) => {
    prompts.push({ label: prompt, options });
    if (prompts.length === 1) {
      assert.equal(options[0], "Running  1 working");
      return options.find((option) => option.startsWith("Running"));
    }
    if (prompts.length === 2) {
      const expected = renderRunningOptions(
        buildStatusRows(
          [
            {
              label,
              definition: "agent",
              state: "working",
              paneId: identity.paneId,
              sessionId: identity.piSessionId,
            },
          ],
          { now: Date.now() },
        ),
      )[0];
      assert.equal(prompts[1]?.label, "Running");
      assert.equal(options[0], expected);
      assert.match(options[0]!, /└─ agent\s+running-menu-agent\s+● working/);
      assert.doesNotMatch(options[0]!, /⠋|gpt|high|0s|Implement/);
      return options[0];
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "focus" &&
          args[2] === identity.paneId,
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("Running explains how to delegate when no agents are running", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  let selection = 0;
  context.ui.select = async (_prompt: string, options: string[]) =>
    selection++ === 0
      ? options.find((option) => option.startsWith("Running"))
      : undefined;

  await command.handler("", context);

  assert.ok(
    notices.some(
      (message) =>
        message.includes("No running agents") &&
        message.includes("Use scout to inspect this repository"),
    ),
  );
});

test("Running rejects duplicate rendered labels before focus", async (t) => {
  setLeadEnvironment();
  const presentation = await import("./presentation.ts");
  const duplicateOptions = ["same running option", "same running option"];
  let renderedRunningOptions = 0;
  t.mock.module("./presentation.ts", {
    namedExports: {
      ...presentation,
      renderRunningOptions: () => {
        renderedRunningOptions++;
        return duplicateOptions;
      },
    },
  });
  const runtimeId = randomUUID();
  const leadRuntime = await import(
    `./lead-runtime.ts?duplicate-test=${runtimeId}`
  );
  t.mock.module("./lead-runtime.ts", { namedExports: leadRuntime });
  const { default: registerDuplicateTestExtension } = await import(
    `./index.ts?duplicate-test=${runtimeId}`
  );
  const label = "duplicate-running-agent";
  const identity = defaultFixtureIdentity;
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const agent = JSON.parse(
    listResponse(label, "working", identity.piSessionId, identity),
  ).agents[0];
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [agent],
                  panes: [
                    {
                      pane_id: identity.paneId,
                      workspace_id: WORKSPACE,
                      cwd: "/tmp",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: identity.piSessionId,
                      },
                    },
                  ],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerDuplicateTestExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const notices: string[] = [];
  let rootSelections = 0;
  const runningSelections: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (prompt: string, options: string[]) => {
    if (prompt === "Running") {
      runningSelections.push(prompt);
      return options[0];
    }
    rootSelections++;
    return rootSelections === 1
      ? options.find((option) => option.startsWith("Running"))
      : undefined;
  };
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.equal(rootSelections, 2);
    assert.equal(renderedRunningOptions, 1);
    assert.deepEqual(runningSelections, []);
    assert.equal(
      notices.includes("Running list is ambiguous; reopen Running."),
      true,
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "focus"),
      false,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("Running excludes lost and unknown durable generations", async () => {
  setLeadEnvironment();
  const lostLabel = "lost-running-menu-agent";
  const unknownLabel = "unknown-running-menu-agent";
  const lostIdentity = {
    paneId: "lost-running-menu-pane",
    tabId: "lost-running-menu-tab",
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/lost-running-menu-agent.jsonl",
  };
  const unknownIdentity = {
    paneId: "unknown-running-menu-pane",
    tabId: "unknown-running-menu-tab",
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/unknown-running-menu-agent.jsonl",
  };
  const mailboxes = [
    agentMailboxPath(WORKSPACE, lostLabel),
    agentMailboxPath(WORKSPACE, unknownLabel),
  ];
  writeAgentState(
    mailboxes[0]!,
    managedState(lostLabel, REQUEST_ID, lostIdentity),
  );
  writeAgentState(
    mailboxes[1]!,
    managedState(unknownLabel, REQUEST_ID, unknownIdentity),
  );
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [],
                  panes: [
                    {
                      pane_id: unknownIdentity.paneId,
                      workspace_id: WORKSPACE,
                      cwd: "/tmp",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: unknownIdentity.piSessionId,
                      },
                    },
                  ],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    assert.equal(label, `Pi Herdsman · v${packageMetadata.version}`);
    assert.ok(options.includes("Running  1 unknown · 1 lost"));
    return prompts.length === 1
      ? options.find((option) => option.startsWith("Running"))
      : undefined;
  };
  try {
    await command.handler("", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        `Pi Herdsman · v${packageMetadata.version}`,
        `Pi Herdsman · v${packageMetadata.version}`,
      ],
    );
    assert.ok(notices.some((message) => message.includes("No running agents")));
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "focus"),
      false,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("Running warns when the selected agent is replaced before focus", async () => {
  setLeadEnvironment();
  const label = "running-menu-replaced-agent";
  const identity = defaultFixtureIdentity;
  const replacementIdentity: FixtureIdentity = {
    paneId: "replacement-pane",
    tabId: "replacement-tab",
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/replacement-agent.jsonl",
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  let currentIdentity = identity;
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              ...JSON.parse(
                listResponse(
                  label,
                  "working",
                  currentIdentity.piSessionId,
                  currentIdentity,
                ),
              ),
              snapshot: {
                agents: JSON.parse(
                  listResponse(
                    label,
                    "working",
                    currentIdentity.piSessionId,
                    currentIdentity,
                  ),
                ).agents,
                panes: [
                  {
                    pane_id: currentIdentity.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: currentIdentity.piSessionId,
                    },
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                {
                  pane_id: currentIdentity.paneId,
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  agent: label,
                  agent_status: "working",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: { message: string; level?: string }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string, level?: string) =>
    notices.push({ message, level });
  let selection = 0;
  context.ui.select = async (_prompt: string, options: string[]) => {
    if (selection === 0) {
      selection++;
      return options.find((option) => option.startsWith("Running"));
    }
    if (selection === 1) {
      selection++;
      currentIdentity = replacementIdentity;
      writeAgentState(
        mailbox,
        managedState(label, REQUEST_ID, replacementIdentity),
      );
      return options[0];
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "focus"),
      false,
    );
    assert.ok(
      notices.some(
        ({ message, level }) =>
          level === "warning" && message.includes("Agent changed"),
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("Running selects duplicate TUI labels by stable value and revalidates identity", async (t) => {
  setLeadEnvironment();
  const presentation = await import("./presentation.ts");
  t.mock.module("./presentation.ts", {
    namedExports: {
      ...presentation,
      renderRunningOptions: (rows: readonly unknown[]) =>
        rows.map(() => "same running option"),
    },
  });
  const runtimeId = randomUUID();
  const leadRuntime = await import(
    `./lead-runtime.ts?duplicate-tui=${runtimeId}`
  );
  t.mock.module("./lead-runtime.ts", { namedExports: leadRuntime });
  const { default: registerTuiDuplicateExtension } = await import(
    `./index.ts?duplicate-tui=${runtimeId}`
  );
  const states = [
    {
      label: "reviewer:task",
      definition: "reviewer",
      identity: {
        paneId: "reviewer-task-pane",
        tabId: "reviewer-task-tab",
        piSessionId: "22222222-2222-4222-8222-222222222222",
        piSessionFile: "/tmp/reviewer-task-agent.jsonl",
      },
    },
    {
      label: "scout:task",
      definition: "scout",
      identity: {
        paneId: "scout-task-pane",
        tabId: "scout-task-tab",
        piSessionId: "33333333-3333-4333-8333-333333333333",
        piSessionFile: "/tmp/scout-task-agent.jsonl",
      },
    },
  ] as const;
  const agentStates = states.map(({ label, identity }) => ({
    ...managedState(label, REQUEST_ID, identity),
  }));
  const mailboxes = agentStates.map((state, index) => {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    writeAgentState(mailbox, state);
    nativeSessions.set(state.piSessionFile!, {
      id: state.piSessionId!,
      path: state.piSessionFile!,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: states[index]!.identity.piSessionId,
            definition: states[index]!.definition,
            label: states[index]!.label,
          },
        },
      ],
    });
    return mailbox;
  });
  let statusSnapshots = 0;
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args)) {
        statusSnapshots++;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              action: "list",
              workspace_id: WORKSPACE,
              tab: "",
              tabs: [],
              agents: states.map(({ label, identity }) => ({
                herdr_agent: herdrAlias(label),
                agent_status: "working",
                cwd: "/tmp",
                workspace_id: WORKSPACE,
                pane_id: identity.paneId,
                tab_id: identity.tabId,
                tab_label: "agents",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: identity.piSessionId,
                },
                session_id: identity.piSessionId,
                session_path: identity.piSessionFile,
              })),
              available_panes: [],
              agent_definitions: [],
              snapshot: {
                agents: states.map(({ label, identity }) => ({
                  ...JSON.parse(
                    listResponse(
                      label,
                      "working",
                      identity.piSessionId,
                      identity,
                    ),
                  ).agents[0],
                  name: herdrAlias(label),
                })),
                panes: states.map(({ identity }) => ({
                  pane_id: identity.paneId,
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: identity.piSessionId,
                  },
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: states.map(({ label, identity }) => ({
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent: label,
                agent_status: "working",
              })),
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerTuiDuplicateExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  let customCall = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      const lines = () => component.render(200);
      const call = customCall++;
      if (call === 0 || call === 2) {
        selectTuiItem(component, "Running");
        component.handleInput("\r");
        return;
      }
      const duplicateRows = lines()
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^(?:→ |  )same running option$/u.test(line));
      assert.equal(duplicateRows.length, 2);
      const stableValue = call === 1 ? "0" : "1";
      const targetIndex = duplicateRows[Number(stableValue)]!.index;
      while (
        lines().findIndex((line) => /^→ same running option$/u.test(line)) !==
        targetIndex
      )
        component.handleInput("\u001b[B");
      component.handleInput("\r");
    });
  try {
    await command.handler("", context);
    await command.handler("", context);
    assert.equal(
      notices.includes("Running list is ambiguous; reopen Running."),
      false,
    );
    const focusedPanes = pi.calls
      .filter((args) => args[0] === "agent" && args[1] === "focus")
      .map((args) => args[2]);
    assert.deepEqual(focusedPanes, ["reviewer-task-pane", "scout-task-pane"]);
    assert.equal(customCall, 4);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "focus" &&
          args[2] === "scout-task-pane",
      ),
    );
    assert.ok(statusSnapshots >= 4, "each selection is freshly revalidated");
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const [index, mailbox] of mailboxes.entries()) {
      resetAgentMailbox(mailbox);
      nativeSessions.delete(states[index]!.identity.piSessionFile);
    }
  }
});

test("Definitions edits standalone definitions through the shared override writer", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "docs-reviewer.md");
  const original =
    '---\nname: docs-reviewer\ndescription: Docs review\nmodel: old/model\nthinking: medium\ntools: ["read"]\n---\n\nKeep this body exactly.\n';
  realFs.writeFileSync(definitionPath, original);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "new", id: "model" }],
    getAvailable: () => [{ provider: "new", id: "model" }],
  };
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (selection++ === 0)
      return options.find((option) => option.includes("docs-reviewer"));
    if (selection === 2)
      return options.find((option) => option.startsWith("Model"));
    if (selection === 3)
      return options.find((option) =>
        option.startsWith("Inherit current session"),
      );
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    assert.ok(
      prompts.some(
        ({ label, options }) =>
          label === "Definitions" &&
          options.some((option) => /docs-reviewer.*global/iu.test(option)),
      ),
    );
    assert.equal(
      realFs.readFileSync(definitionPath, "utf8"),
      original.replace("model: old/model\n", ""),
    );
    assert.ok(
      prompts[0]?.options.some((option) => option.includes("docs-reviewer")),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions exposes managed Lead settings without Agent discovery", async () => {
  setLeadEnvironment();
  const overridePath = join(PI_AGENTS_DIR, "managed-lead.md");
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "new", id: "model", reasoning: true }],
    getAvailable: () => [{ provider: "new", id: "model", reasoning: true }],
  };
  const visits = new Map<string, number>();
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    const visit = visits.get(label) ?? 0;
    visits.set(label, visit + 1);
    if (label === "Definitions")
      return visit === 0
        ? options.find((option) => option.includes("managed-lead"))
        : undefined;
    if (label === "managed-lead")
      return visit < 2
        ? options.find((option) =>
            option.startsWith(visit === 0 ? "Model" : "Thinking"),
          )
        : undefined;
    if (label === "Model")
      return options.find((option) => option.startsWith("model"));
    if (label === "Thinking")
      return options.find((option) => option === "high");
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    const definitionMenu = prompts.find(({ label }) => label === "Definitions");
    assert.ok(
      definitionMenu?.options.some((option) =>
        /managed-lead.*bundled/iu.test(option),
      ),
      JSON.stringify(definitionMenu),
    );
    assert.ok(
      prompts
        .filter(({ label }) => label === "managed-lead")
        .every(
          ({ options }) =>
            !options.some((option) => option.startsWith("Enabled")),
        ),
    );
    assert.match(
      realFs.readFileSync(overridePath, "utf8"),
      /model: new\/model/u,
    );
    assert.match(realFs.readFileSync(overridePath, "utf8"), /thinking: high/u);
    assert.doesNotMatch(realFs.readFileSync(overridePath, "utf8"), /enabled:/u);
    assert.ok(
      !discoverAgentDefinitions().some(
        (definition) => definition.name === "managed-lead",
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(overridePath, { force: true });
  }
});

test("Definitions contextual help distinguishes managed Lead and Agent launches", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  let customCall = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      const lines = () => component.render(200);
      const moveTo = (target: string) => {
        for (let attempts = 0; attempts < 20; attempts++) {
          if (
            lines().some(
              (line) =>
                line.trimStart().startsWith("→") && line.includes(target),
            )
          )
            return;
          component.handleInput("\u001b[B");
        }
        throw new Error(`TUI item was not selected: ${target}`);
      };
      if (customCall === 0) {
        customCall++;
        selectTuiItem(component, "managed-lead");
      } else if (customCall === 1) {
        customCall++;
        assert.ok(
          lines().some((line) =>
            line.includes(
              "Model for future managed Lead launches. Changes do not affect a running Lead.",
            ),
          ),
        );
        moveTo("Thinking");
        assert.ok(
          lines().some((line) =>
            line.includes(
              "Thinking level for future managed Lead launches. Changes do not affect a running Lead.",
            ),
          ),
        );
        component.handleInput("\u001b");
      } else if (customCall === 2) {
        customCall++;
        selectTuiItem(component, "generalist");
      } else if (customCall === 3) {
        customCall++;
        assert.ok(
          lines().some((line) =>
            line.includes(
              "Model for future Agent generations. When unset, fresh delegation inherits the spawning controller and continuation restores the saved session model.",
            ),
          ),
        );
        moveTo("Thinking");
        assert.ok(
          lines().some((line) =>
            line.includes(
              "Thinking level for future Agent generations. When unset, fresh delegation inherits the spawning controller and continuation restores the saved session level.",
            ),
          ),
        );
        component.handleInput("\u001b");
      } else {
        component.handleInput("\u001b");
      }
    });
  try {
    await command.handler("definitions", context);
    assert.equal(customCall, 4);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions Details snapshots effective append and replace instructions", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "scout.md");
  const customDefinitionPath = join(PI_AGENTS_DIR, "details-scout.md");
  const bodyPath = join(PI_AGENT_ROOT, "scout-details-body.md");
  const baseBody = discoverAgent("scout").body;

  const selectDetails = async (
    selectedName: string,
    beforeDetails?: () => void,
  ) => {
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const initialEntryCount = pi.entries.length;
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "tui";
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    let customCalls = 0;
    context.ui.custom = async (factory: any) => {
      const result = new Promise<unknown>((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
        const call = customCalls++;
        if (call >= 2) {
          component.handleInput("\u001b");
          return;
        }
        const target = call === 0 ? selectedName : "Details…";
        if (call === 1) beforeDetails?.();
        selectTuiItem(component, target);
      });
      return result;
    };
    let error: unknown;
    try {
      await command.handler("definitions", context);
    } catch (caught) {
      error = caught;
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
    }
    return {
      entry: [...pi.entries.slice(initialEntryCount)]
        .reverse()
        .find(
          (entry: any) => entry?.customType === "pi-herdsman-agent-definitions",
        ) as
        | {
            customType: string;
            data: {
              definitions: Array<Record<string, unknown>>;
              instructions: string;
            };
          }
        | undefined,
      notices,
      error,
    };
  };

  try {
    realFs.writeFileSync(bodyPath, "file instructions");
    realFs.writeFileSync(
      definitionPath,
      `---\nname: scout\ndescription: before\nbodyMode: append\n---\nAdditional instructions\n@${bodyPath}\n`,
    );
    const appended = discoverAgent("scout");
    assert.equal(
      appended.body,
      `${baseBody}\n\nAdditional instructions\n@${bodyPath}`,
    );
    const appendedResult = await selectDetails("scout", () => {
      realFs.writeFileSync(bodyPath, "mutated after selection");
      realFs.writeFileSync(
        definitionPath,
        `---\nname: scout\ndescription: after\nbodyMode: append\n---\nAdditional instructions\n@${bodyPath}\n`,
      );
    });
    const appendedEntry = appendedResult.entry!;
    assert.equal(
      appendedEntry.data.instructions,
      `${baseBody}\n\nAdditional instructions\nmutated after selection`,
    );
    assert.equal(appendedEntry.data.definitions[0]?.description, "after");

    realFs.writeFileSync(
      definitionPath,
      `---\nname: scout\nbodyMode: replace\n---\nReplacement instructions\n@${bodyPath}\n`,
    );
    const replacedResult = await selectDetails("scout", () => {
      realFs.writeFileSync(bodyPath, "changed file instructions");
    });
    const replacedEntry = replacedResult.entry!;
    assert.equal(
      replacedEntry.data.instructions,
      "Replacement instructions\nchanged file instructions",
    );
    assert.equal(
      appendedEntry.data.instructions,
      `${baseBody}\n\nAdditional instructions\nmutated after selection`,
    );

    realFs.writeFileSync(
      customDefinitionPath,
      `---\nname: details-scout\ndescription: Still available\n---\nStill available\n`,
    );
    const deletedResult = await selectDetails("details-scout", () => {
      realFs.rmSync(customDefinitionPath, { force: true });
    });
    assert.equal(deletedResult.entry, undefined);
    assert.ok(
      deletedResult.notices.some((notice) =>
        notice.includes("Definition details-scout is no longer available."),
      ),
    );

    realFs.writeFileSync(
      customDefinitionPath,
      `---\nname: details-scout\ndescription: Still available\n---\nStill available\n`,
    );
    const invalidResult = await selectDetails("details-scout", () => {
      realFs.writeFileSync(
        customDefinitionPath,
        `---\nname: details-scout\nunknownField: true\n---\nInvalid\n`,
      );
    });
    assert.ok(
      invalidResult.notices.some((notice) =>
        /unknownField|Malformed|invalid/i.test(notice),
      ),
    );
  } finally {
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(customDefinitionPath, { force: true });
    realFs.rmSync(bodyPath, { force: true });
  }
});

test("Definitions Details in RPC reports metadata without expanding instructions", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "details-rpc.md");
  realFs.writeFileSync(
    definitionPath,
    "---\nname: details-rpc\ndescription: RPC details\n---\nRPC_PRIVATE_INSTRUCTIONS_SENTINEL\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  let selection = 0;
  context.ui.select = async (label: string, options: string[]) => {
    const currentSelection = selection++;
    if (currentSelection === 0)
      return options.find((option) => option.includes("details-rpc"));
    if (label === "details-rpc" && currentSelection === 1)
      return options.find((option) => option.startsWith("Details"));
    return undefined;
  };
  try {
    await pi.commandOptions.get("agents").handler("definitions", context);
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /details-rpc/u);
    assert.doesNotMatch(notices[0] ?? "", /RPC_PRIVATE_INSTRUCTIONS_SENTINEL/u);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions cancellation navigates one menu level at a time", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "provider", id: "model", reasoning: true }],
    getAvailable: () => [
      { provider: "provider", id: "model", reasoning: true },
    ],
  };
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return undefined;
      case 3:
        return options.find((option) => option.startsWith("Thinking"));
      case 4:
        return undefined;
      case 5:
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        "Definitions",
        "implementer",
        "Model",
        "implementer",
        "Thinking",
        "implementer",
        "Definitions",
      ],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions applies model and thinking overrides independently", async () => {
  for (const scenario of [
    { field: "Model", selected: "new-model", property: "model" },
    { field: "Thinking", selected: "medium", property: "thinking" },
  ] as const) {
    setLeadEnvironment();
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
    const prompts: { label: string; options: string[] }[] = [];
    let selection = 0;
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "rpc";
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => [
        { provider: "provider", id: "new-model", reasoning: true },
      ],
      getAvailable: () => [
        { provider: "provider", id: "new-model", reasoning: true },
      ],
    };
    context.ui.select = async (label: string, options: string[]) => {
      prompts.push({ label, options });
      switch (selection++) {
        case 0:
          return options.find((option) => option.includes("implementer"));
        case 1:
          return options.find((option) => option.startsWith(scenario.field));
        case 2:
          return options.find((option) => option.startsWith(scenario.selected));
        case 3:
          assert.equal(
            discoverAgent("implementer").frontmatter[scenario.property],
            scenario.property === "model" ? "provider/new-model" : "medium",
          );
          return options.find((option) => option.startsWith(scenario.field));
        case 4:
          return options.find((option) =>
            option.startsWith("Inherit current session"),
          );
        default:
          return undefined;
      }
    };
    try {
      await command.handler("definitions", context);
      const content = realFs.readFileSync(definitionPath, "utf8");
      assert.doesNotMatch(content, new RegExp(`^${scenario.property}:`, "m"));
      assert.equal(
        discoverAgent("implementer").frontmatter[scenario.property],
        undefined,
      );
      assert.ok(prompts.some(({ label }) => label === scenario.field));
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("Definitions toggles enabled state for bundled definitions", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        assert.equal(label, "implementer");
        assert.ok(options.some((option) => /^Enabled\s+on\b/u.test(option)));
        return options.find((option) => option.startsWith("Enabled"));
      case 2:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, false);
        assert.ok(options.some((option) => /^Enabled\s+off\b/u.test(option)));
        return options.find((option) => option.startsWith("Enabled"));
      case 3:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, true);
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.match(
      realFs.readFileSync(definitionPath, "utf8"),
      /^enabled: true$/m,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions refreshes the model registry before post-model thinking choices", async () => {
  setLeadEnvironment();
  const pi = fakePi({ thinkingLevel: "high" });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
  const refreshedModel = {
    provider: "refresh-provider",
    id: "refresh-model",
    reasoning: true,
  };
  let registryModels: (typeof refreshedModel)[] = [];
  const registry = {
    refreshes: 0,
    async refresh() {
      this.refreshes++;
      registryModels = [refreshedModel];
    },
    getAll: () => registryModels,
    getAvailable: () => registryModels,
  };
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.model = { provider: "current-provider", id: "current-model" };
  context.thinkingLevel = "high";
  context.modelRegistry = registry;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        assert.ok(
          options.some((option) => option.includes("inherit · current-model")),
        );
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return options.find((option) => option.startsWith("refresh-model"));
      case 3:
        assert.ok(options.some((option) => option.startsWith("Thinking")));
        return options.find((option) => option.startsWith("Thinking"));
      case 4:
        assert.equal(registry.refreshes, 2);
        assert.ok(options.some((option) => option.startsWith("medium")));
        assert.equal(options.includes("xhigh"), false);
        return options.find((option) => option.startsWith("medium"));
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.equal(
      discoverAgent("implementer").frontmatter.model,
      "refresh-provider/refresh-model",
    );
    assert.equal(discoverAgent("implementer").frontmatter.thinking, "medium");
    assert.equal(registry.refreshes, 2);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions uses the current model for inherited thinking choices", async () => {
  setLeadEnvironment();
  const pi = fakePi({ thinkingLevel: "medium" });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.hasUI = true;
  context.model = {
    provider: "current-provider",
    id: "current-model",
    reasoning: true,
  };
  context.thinkingLevel = "medium";
  const registry = {
    refreshes: 0,
    async refresh() {
      this.refreshes++;
    },
    getAll: () => [],
    getAvailable: () => [],
  };
  context.modelRegistry = registry;
  let selection = 0;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        assert.ok(
          options.some((option) => option.includes("inherit · current-model")),
        );
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Thinking"));
      case 2:
        assert.equal(registry.refreshes, 1);
        assert.ok(options.some((option) => option.startsWith("medium")));
        assert.equal(options.includes("xhigh"), false);
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions resolves explicit compact model IDs for thinking choices", async () => {
  for (const scenario of [
    {
      model: "compact-model",
      models: [{ provider: "provider", id: "compact-model", reasoning: false }],
      levels: ["off"],
    },
    {
      model: "ambiguous-model",
      models: [
        { provider: "one", id: "ambiguous-model", reasoning: false },
        { provider: "two", id: "ambiguous-model", reasoning: false },
      ],
      levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
  ] as const) {
    setLeadEnvironment();
    const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
    realFs.writeFileSync(
      definitionPath,
      `---\nname: implementer\nmodel: ${scenario.model}\n---\n`,
    );
    const pi = fakePi({ thinkingLevel: "high" });
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "rpc";
    context.model = {
      provider: "current-provider",
      id: "current-model",
      reasoning: true,
    };
    context.thinkingLevel = "high";
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => scenario.models,
      getAvailable: () => scenario.models,
    };
    let selection = 0;
    context.ui.select = async (_label: string, options: string[]) => {
      switch (selection++) {
        case 0:
          assert.ok(options.some((option) => option.includes(scenario.model)));
          return options.find((option) => option.includes("implementer"));
        case 1:
          return options.find((option) => option.startsWith("Thinking"));
        case 2:
          assert.deepEqual(options, [
            "Inherit current session",
            ...scenario.levels,
          ]);
          return undefined;
        default:
          return undefined;
      }
    };
    try {
      await command.handler("definitions", context);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("Definitions preserves Unicode names and model/thinking metadata", async () => {
  setLeadEnvironment();
  const definitionPaths = [
    join(PI_AGENTS_DIR, "unicode-reviewer-a.md"),
    join(PI_AGENTS_DIR, "unicode-reviewer-b.md"),
  ];
  realFs.writeFileSync(
    definitionPaths[0],
    "---\nname: 審査\nmodel: provider/模型\nthinking: high\n---\nreview\n",
  );
  realFs.writeFileSync(
    definitionPaths[1],
    "---\nname: 設計確認\nmodel: provider/長い名前\nthinking: high\n---\nreview\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: string[][] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (_label: string, options: string[]) => {
    prompts.push(options);
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    const options = prompts[0] ?? [];
    const rowA = options.find((option) => option.includes("模型"));
    const rowB = options.find((option) => option.includes("長い名前"));
    assert.ok(rowA);
    assert.ok(rowB);
    assert.match(rowA, /審査/u);
    assert.match(rowA, /模型/u);
    assert.match(rowA, /high/u);
    assert.match(rowB, /設計確認/u);
    assert.match(rowB, /長い名前/u);
    assert.match(rowB, /high/u);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const definitionPath of definitionPaths)
      realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions is a flat provenance list and selection reopens the list", async () => {
  setLeadEnvironment();
  const definitionPaths = [
    join(PI_AGENTS_DIR, "group-custom.md"),
    join(PI_AGENTS_DIR, "implementer.md"),
  ];
  realFs.writeFileSync(
    definitionPaths[0]!,
    "---\nname: group:Custom\n---\nCustom instructions\n",
  );
  realFs.writeFileSync(
    definitionPaths[1]!,
    "---\nname: implementer\nthinking: high\n---\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selections = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    return selections++ === 0
      ? options.find((option) => option.includes("group:Custom"))
      : undefined;
  };
  try {
    await command.handler("definitions", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      ["Definitions", "group:Custom", "Definitions"],
    );
    const definitions = prompts[0]!.options;
    assert.match(definitions[0] ?? "", /^managed-lead\b.*bundled/iu);
    assert.ok(
      definitions.some((option) => /group:Custom.*global/u.test(option)),
    );
    assert.ok(
      definitions.some((option) =>
        /implementer.*bundled \+ global/u.test(option),
      ),
    );
    assert.ok(definitions.every((option) => !/^---/u.test(option)));
    assert.ok(definitions.every((option) => !/\[project\]|\*/u.test(option)));
    assert.deepEqual(prompts[0], prompts[2]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const definitionPath of definitionPaths)
      realFs.rmSync(definitionPath, { force: true });
  }
});

test("lead agents stop reports an empty owned inventory safely", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  await command.handler("stop", context);
  await command.handler("stop", context);
  assert.equal(
    pi.sentMessageCalls.filter(
      (call: any) => call.message.customType === "pi-herdsman-stop-summary",
    ).length,
    2,
  );
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi-herdsman-stop-summary",
    ),
    false,
  );
  assert.equal(stopSummary(pi), "No owned agents running.");
});

test("lead agents stop closes a direct subtree agents-first", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "pi-herdsman-parent",
      undefined,
      recoveryIdentity("pi-herdsman-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/pi-herdsman-parent.jsonl",
  };
  const agents = {
    ...managedState(
      "pi-herdsman-agents",
      undefined,
      recoveryIdentity("pi-herdsman-agents"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/pi-herdsman-agents.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, agents.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  for (const state of [parent, agents])
    nativeSessions.set(state.piSessionFile!, {
      id: state.piSessionId!,
      path: state.piSessionFile!,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: state.piSessionId,
            definition: "agent",
            label: state.agentLabel,
          },
        },
      ],
    });
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, agents);
  const lifecycle = cascadeExecutor([parent, agents]);
  const pi = fakePi({ exec: lifecycle.exec, persistMessages: true });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await command.handler("stop", context);
    assert.deepEqual(lifecycle.closeOrder, [
      agents.agentLabel,
      parent.agentLabel,
    ]);
    assert.match(stopSummary(pi), /Stopped 2 agents/);
    assert.match(stopSummary(pi), /✓ pi-herdsman-agents/);
    assert.match(stopSummary(pi), /✓ pi-herdsman-parent/);
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.deepEqual(pi.sentMessageCalls[0]?.options, { triggerTurn: false });
    assert.equal(pi.sentMessageCalls[0]?.message.display, true);
    assert.equal(
      pi.sentMessageCalls[0]?.message.content,
      `[Pi Herdsman] Stop all result:\n${stopSummary(pi)}`,
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-stop-summary" &&
          entry.details.summary === stopSummary(pi),
      ),
    );
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    for (const state of [parent, agents])
      nativeSessions.delete(state.piSessionFile!);
  }
});

test("lead agents stop refuses an agent whose identity changes after inventory", async () => {
  setLeadEnvironment();
  const agent = managedState(
    "pi-herdsman-identity-race",
    undefined,
    recoveryIdentity("pi-herdsman-identity-race"),
  );
  const mailbox = agentMailboxPath(WORKSPACE, agent.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, agent);
  const lifecycle = cascadeExecutor([agent]);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (command === "herdr" && (isApiSnapshot(args) || isAgentList(args))) {
        const value = JSON.parse(result.stdout);
        const agents = isApiSnapshot(args)
          ? value.result.snapshot.agents
          : value.result.agents;
        agents[0].agent_session = {
          kind: "id",
          value: "22222222-2222-4222-8222-222222222222",
        };
        return { ...result, stdout: JSON.stringify(value) };
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = () => undefined;
  try {
    await command.handler("stop", context);
    assert.equal(lifecycle.closeOrder.length, 0);
    assert.match(stopSummary(pi), /No owned agents running|not closed/);
    assert.ok(readAgentState(mailbox));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("lead agents stop reports cleanup failures and preserves accurate discarded-work summary", async () => {
  setLeadEnvironment();
  const failed = managedState(
    "stop-failed-agent",
    undefined,
    recoveryIdentity("stop-failed-agent"),
  );
  const pending = managedState(
    "stop-pending-agent",
    REQUEST_ID,
    recoveryIdentity("stop-pending-agent"),
  );
  pending.piSessionId = "11111111-1111-4111-8111-111111111111";
  pending.piSessionFile = "/tmp/stop-pending-agent-unique.jsonl";
  pending.completedRequestId = randomUUID();
  const mailboxes = [failed, pending].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  mailboxes.forEach(resetAgentMailbox);
  writeAgentState(mailboxes[0]!, failed);
  writeAgentState(mailboxes[1]!, pending);
  writeResult(mailboxes[1]!, {
    version: 5,
    runId: pending.runId,
    requestId: pending.completedRequestId,
    ownerSessionId: pending.ownerSessionId,
    workspaceId: pending.workspaceId,
    agentLabel: pending.agentLabel,
    paneId: pending.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([failed, pending], {
    failCloseLabel: failed.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    const summary = stopSummary(pi);
    assert.match(summary, /Stopped 0 of 2 agents/);
    assert.match(summary, /✗ stop-failed-agent/);
    assert.match(summary, /Discarded:/);
    assert.match(summary, /stop-pending-agent: active assignment/);
    assert.match(summary, /stop-pending-agent: pending result/);
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(mailboxes[1]!));
    assert.ok(readResult(mailboxes[1]!, pending.completedRequestId!));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("lead agents stop continues independent leads after a partial cascade failure", async () => {
  setLeadEnvironment();
  const states = ["stop-partial-failure", "stop-independent"].map((label) =>
    managedState(label, undefined, recoveryIdentity(label)),
  );
  states[1]!.piSessionId = "11111111-1111-4111-8111-111111111111";
  states[1]!.piSessionFile = "/tmp/stop-independent-unique.jsonl";
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  states.forEach((state, index) => writeAgentState(mailboxes[index]!, state));
  const lifecycle = cascadeExecutor(states, {
    failCloseLabel: states[0]!.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    assert.deepEqual(lifecycle.closeOrder, [states[1]!.agentLabel]);
    assert.match(stopSummary(pi), /Stopped 1 of 2 agents/);
    assert.match(stopSummary(pi), /✓ stop-independent/);
    assert.match(stopSummary(pi), /✗ stop-partial-failure/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("lead agents stop scopes its summary to the current lead subtree", async () => {
  setLeadEnvironment();
  const owned = managedState(
    "scoped-owned-agent",
    undefined,
    recoveryIdentity("scoped-owned-agent"),
  );
  const foreign = {
    ...managedState(
      "scoped-foreign-agent",
      undefined,
      recoveryIdentity("scoped-foreign-agent"),
    ),
    ownerSessionId: "foreign-lead-session",
  };
  foreign.piSessionId = "11111111-1111-4111-8111-111111111111";
  foreign.piSessionFile = "/tmp/scoped-foreign-agent-unique.jsonl";
  const states = [owned, foreign];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  states.forEach((state, index) => writeAgentState(mailboxes[index]!, state));
  const lifecycle = cascadeExecutor(states);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    assert.deepEqual(lifecycle.closeOrder, [owned.agentLabel]);
    assert.match(stopSummary(pi), /Stopped 1 agents/);
    assert.match(stopSummary(pi), /✓ scoped-owned-agent/);
    assert.doesNotMatch(stopSummary(pi), /scoped-foreign-agent/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("valid managed leaf agents receive identity-only TUI presentation", async () => {
  const mailbox = setAgentEnvironment("leaf-agent");
  let sessionRuntimeInitialized = false;
  let activeToolsCalls = 0;
  const state: ManagedAgentState = {
    ...managedState("leaf-agent"),
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const pi = fakePi({
    activeTools: () => {
      activeToolsCalls++;
      assert.equal(sessionRuntimeInitialized, true);
      return ["read", "bash", "ask_owner"];
    },
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [
                    agentFromState(state),
                    {
                      agent: "pi",
                      workspace_id: WORKSPACE,
                      pane_id: "lead-pane",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: LEAD_SESSION_ID,
                      },
                    },
                  ],
                  panes: [
                    {
                      pane_id: state.paneId,
                      workspace_id: WORKSPACE,
                      cwd: state.cwd,
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: state.piSessionId,
                      },
                    },
                    {
                      pane_id: "lead-pane",
                      workspace_id: WORKSPACE,
                      cwd: "/tmp",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: LEAD_SESSION_ID,
                      },
                    },
                  ],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : command === "herdr" && isAgentList(args)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: {
                  agents: [
                    agentFromState(state),
                    {
                      agent: "pi",
                      workspace_id: WORKSPACE,
                      pane_id: "lead-pane",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: LEAD_SESSION_ID,
                      },
                    },
                  ],
                },
              }),
              stderr: "",
              code: 0,
            }
          : command === "herdr" && isPaneList(args)
            ? {
                stdout: JSON.stringify({
                  id: AGENT_ID,
                  result: {
                    panes: [
                      {
                        pane_id: "lead-pane",
                        workspace_id: WORKSPACE,
                        agent: NON_PI_AGENT,
                      },
                    ],
                  },
                }),
                stderr: "",
                code: 0,
              }
            : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeAgentContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    select: async () => "tab",
  };
  registerExtension!(pi.pi as never);
  assert.equal(activeToolsCalls, 0);
  sessionRuntimeInitialized = true;
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.deepEqual(widget!.render(160), [
    "● ? → agent:leaf-agent  [read, bash, ask_owner]",
  ]);
  assert.equal(pi.tools.filter((tool) => tool.name === "ask_owner").length, 1);
  assert.ok(activeToolsCalls > 0);
  await pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("status session preparation drops the previous session snapshot", async (t) => {
  const { createAgentStatusRuntime } = await import("./agent-controller.ts");
  const runtime = createAgentStatusRuntime();
  const pending: {
    resolve(snapshot: any): void;
    reject(error: Error): void;
  }[] = [];
  runtime.configure({
    loadSnapshot: () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject })),
    pendingStartEntries: () => [],
    hasPendingStart: () => false,
    clearPendingStart: () => false,
    runtimeForLabel: () => undefined,
    ownToolsSnapshot: () => ({}),
  });
  const widgets: StatusWidget[] = [];
  const context = () => {
    const ctx = fakeContext() as any;
    ctx.mode = "tui";
    ctx.hasUI = true;
    ctx.ui = {
      setWidget: (_key: string, content: any) => {
        if (typeof content !== "function") return;
        widgets.push(
          content(
            { requestRender: () => undefined },
            {
              fg: (_color: string, value: string) => value,
              bold: (value: string) => value,
            },
          ),
        );
      },
    };
    return ctx;
  };
  t.after(() => runtime.shutdown());

  const firstContext = context();
  runtime.prepareSession(firstContext);
  runtime.start(firstContext);
  pending[0]!.resolve({
    agents: [{ label: "old-agent", definition: "scout", state: "working" }],
    stale: false,
    unavailable: false,
    breadcrumb: ["lead", "scout:old-agent"],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(widgets[0]!.render(160).join("\n"), /lead → scout:old-agent/);

  runtime.requestRefresh();
  assert.equal(pending.length, 2, "an older refresh remains in flight");

  const nextContext = context();
  runtime.prepareSession(nextContext);
  runtime.start(nextContext);
  assert.deepEqual(widgets[1]!.render(160), ["● ?  unavailable"]);
  pending[1]!.resolve({
    agents: [{ label: "stale-agent", definition: "scout", state: "working" }],
    stale: false,
    unavailable: false,
    breadcrumb: ["lead", "scout:stale-agent"],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(widgets[1]!.render(160), ["● ?  unavailable"]);

  pending[2]!.reject(new Error("new session refresh failed"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(widgets[1]!.render(160), ["● ?  unavailable"]);
  assert.equal(
    pending.length,
    3,
    "the new session refresh stayed pending until failed",
  );
});

test("TUI status widget is registered as a Pi component factory", async (t) => {
  setLeadEnvironment();
  let factory: unknown;
  let renderRequests = 0;
  const pi = fakePi();
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      factory = content;
    },
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);

  assert.equal(typeof factory, "function");
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = (factory as (tui: unknown, theme: unknown) => unknown)(
    { requestRender: () => renderRequests++ },
    theme,
  );
  assert.ok(component instanceof StatusWidget);
  (component as StatusWidget).setSnapshot({
    agents: [{ label: "agent", definition: "agent", state: "working" }],
    stale: false,
    unavailable: false,
  });
  assert.equal(renderRequests, 2);
  assert.notEqual(factory, component);
  const leadSignal = pi.execOptions.find((options) => options.signal)?.signal;
  assert.ok(leadSignal);
  (component as StatusWidget).dispose();
  await pi.events.get("session_shutdown")?.[0]();
  assert.equal(leadSignal.aborted, true);
});

test("repeated lead starts replace the widget and ignore old refreshes", async (t) => {
  setLeadEnvironment();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<ReturnType<typeof setInterval>>();
  const pendingLists: {
    resolve: (value: { stdout: string; stderr: string; code: number }) => void;
  }[] = [];
  const widgets: StatusWidget[] = [];
  const factories: ((tui: any, theme: any) => StatusWidget)[] = [];
  const originalDispose = StatusWidget.prototype.dispose;
  let disposeCalls = 0;
  let registrations = 0;
  StatusWidget.prototype.dispose = function () {
    disposeCalls++;
    originalDispose.call(this);
  };
  globalThis.setInterval = ((callback: TimerHandler) => {
    const timer = originalSetInterval(callback, 60_000);
    activeTimers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer) => {
    activeTimers.delete(timer);
    originalClearInterval(timer);
  }) as typeof clearInterval;
  try {
    const pi = fakePi({
      exec: (command, args) => {
        if (command === "herdr" && isApiSnapshot(args))
          return new Promise((resolve) =>
            pendingLists.push({ resolve }),
          ) as any;
        if (command === "herdr" && isPaneList(args))
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    agent: "agent",
                    agent_status: "idle",
                  },
                ],
              },
            }),
            stderr: "",
            code: 0,
          };
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    const makeContext = () => {
      const context = fakeContext() as any;
      context.mode = "tui";
      context.hasUI = true;
      context.ui = {
        setWidget: (_key: string, content: unknown) => {
          registrations++;
          if (typeof content === "function")
            (factories.push(content as (tui: any, theme: any) => StatusWidget),
              widgets.push(
                (content as (tui: any, theme: any) => StatusWidget)(
                  { requestRender: () => undefined },
                  {
                    fg: (_color: string, text: string) => text,
                    bold: (text: string) => text,
                  },
                ),
              ));
        },
      };
      return context;
    };
    registerExtension!(pi.pi as never);
    t.after(async () => {
      await pi.events.get("session_shutdown")?.[0]();
    });
    const start = pi.events.get("session_start")![0];
    const firstStart = start(undefined, makeContext());
    await Promise.resolve();
    const secondStart = start(undefined, makeContext());
    await Promise.resolve();

    assert.equal(widgets.length, 2);
    assert.equal(widgets[1].render(120)[0], "● lead  unavailable");
    assert.equal(
      registrations,
      3,
      "two registrations and one old-widget removal",
    );
    assert.equal(disposeCalls, 1, "the old widget is disposed on replacement");
    const staleWidget = factories[0](
      { requestRender: () => undefined },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    );
    assert.ok(staleWidget);
    assert.equal(
      disposeCalls,
      2,
      "a stale factory widget is disposed immediately",
    );
    assert.equal(activeTimers.size, 1);
    for (const pending of pendingLists.splice(0, 2))
      pending.resolve({
        stdout: JSON.stringify({
          id: 1,
          result: {
            snapshot: { agents: [], panes: [] },
          },
        }),
        stderr: "",
        code: 0,
      });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(widgets[1].render(120)[0], "● lead  unavailable");
    for (const pending of pendingLists.splice(0))
      pending.resolve({
        stdout: JSON.stringify({
          id: 1,
          result: {
            snapshot: { agents: [], panes: [] },
          },
        }),
        stderr: "",
        code: 0,
      });
    await Promise.all([firstStart, secondStart]);
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.doesNotMatch(widgets[1].render(120)[0], /unavailable/);
    await pi.events.get("session_shutdown")?.[0]();
    assert.equal(activeTimers.size, 0);
    assert.equal(disposeCalls, 3, "the current widget is disposed on shutdown");
    assert.equal(widgets[0].render(120)[0], "● lead  unavailable");
  } finally {
    StatusWidget.prototype.dispose = originalDispose;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("TUI status refresh consumes the coherent Herdr session snapshot", async (t) => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", false);
  t.after(() => updateConfig("autoActivateManager", undefined));
  const label = "sleep-smoke-a";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(tmpdir(), `pi-herdsman-${label}-${randomUUID()}.jsonl`),
  };
  realFs.writeFileSync(
    identity.piSessionFile,
    JSON.stringify({
      type: "session",
      id: identity.piSessionId,
    }),
    "utf8",
  );
  t.after(() => realFs.rmSync(identity.piSessionFile, { force: true }));
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const calls: string[][] = [];
  const definitionReadsBeforeStatus = support.agentDefinitionReadCount;
  let refreshTimer: TimerHandler | undefined;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler) => {
    refreshTimer = callback;
    return {} as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const herdrAgent = {
    agent: "pi",
    name: herdrAlias("sleep-smoke-a"),
    agent_session: {
      agent: "pi",
      kind: "path",
      source: "herdr:pi",
      value: identity.piSessionFile,
    },
    agent_status: "working",
    cwd: "/tmp",
    pane_id: identity.paneId,
    tab_id: identity.tabId,
    workspace_id: WORKSPACE,
    display_agent: "agent",
    tokens: {
      task: "live task",
      started: "123",
      model: "live-model",
      thinking: "high",
      ctx: "42",
    },
  };
  const pi = fakePi({
    activeTools: ["read", "bash", "ask_owner"],
    exec: (command, args) => {
      calls.push(args);
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: [
                  herdrAgent,
                  {
                    agent: "pi",
                    workspace_id: WORKSPACE,
                    pane_id: "unmanaged-lead-pane",
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: LEAD_SESSION_ID,
                    },
                  },
                ],
                panes: [
                  {
                    pane_id: identity.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: herdrAgent.agent_session,
                  },
                  {
                    pane_id: "unmanaged-lead-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: LEAD_SESSION_ID,
                    },
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                {
                  pane_id: identity.paneId,
                  workspace_id: WORKSPACE,
                  agent: label,
                  agent_status: "working",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agent: {
                name: herdrAlias("sleep-smoke-a"),
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  kind: "path",
                  value: identity.piSessionFile,
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = (content as any)(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);
  await Promise.resolve();
  await Promise.resolve();
  (refreshTimer as () => void)();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.setInterval = originalSetInterval;

  assert.ok(widget);
  assert.ok(calls.some((args) => args[0] === "api" && args[1] === "snapshot"));
  assert.ok(
    pi.execOptions.some((options) => options.timeout === 30_000),
    "direct Herdr status polling must have a finite timeout",
  );
  const rendered = widget.render(160).join("\n");
  assert.match(rendered, /1 working/);
  assert.match(rendered, /sleep-smoke-a/);
  assert.doesNotMatch(rendered, /\[read, bash, ask_owner\]/);
  assert.ok(
    support.agentDefinitionReadCount > definitionReadsBeforeStatus,
    "session-start roster should discover agent definitions once",
  );
  const listed = await agentTool(pi, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    context,
  );
  assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
  assert.ok(
    support.agentDefinitionReadCount > definitionReadsBeforeStatus,
    "agent list should continue to discover agent definitions",
  );
  await pi.events.get("session_shutdown")?.[0]();
});

test("zero-runtime reconciliation requests one status refresh", async (t) => {
  setLeadEnvironment();
  const label = "fresh-widget-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(tmpdir(), `pi-herdsman-${label}-${randomUUID()}.jsonl`),
  };
  realFs.writeFileSync(identity.piSessionFile, "{}", "utf8");
  t.after(() => realFs.rmSync(identity.piSessionFile, { force: true }));
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, undefined, identity));

  const herdrAgent = {
    agent: "pi",
    name: herdrAlias(label),
    agent_session: {
      agent: "pi",
      kind: "path",
      source: "herdr:pi",
      value: identity.piSessionFile,
    },
    agent_status: "working",
    cwd: "/tmp",
    pane_id: identity.paneId,
    workspace_id: WORKSPACE,
    display_agent: "agent",
    tokens: { task: "fresh task" },
  };
  const envelope = () =>
    JSON.stringify({
      id: 1,
      result: {
        snapshot: {
          agents: [herdrAgent],
          panes: [
            {
              pane_id: identity.paneId,
              workspace_id: WORKSPACE,
              cwd: "/tmp",
              agent_session: herdrAgent.agent_session,
            },
          ],
        },
      },
    });
  let listCount = 0;
  let resolveInitial: ((value: ExecResult) => void) | undefined;
  let resolveReconciliation: ((value: ExecResult) => void) | undefined;
  let resolveAfterRegistration: ((value: ExecResult) => void) | undefined;
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args)) {
        listCount++;
        if (listCount === 1)
          return new Promise<ExecResult>((resolve) => {
            resolveInitial = resolve;
          });
        if (listCount === 2)
          return new Promise<ExecResult>((resolve) => {
            resolveReconciliation = resolve;
          });
        return new Promise<ExecResult>((resolve) => {
          resolveAfterRegistration = resolve;
        });
      }
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: herdrAgent },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };

  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  const starting = pi.events.get("session_start")![0](undefined, context);
  await Promise.resolve();
  resolveInitial!({ stdout: envelope(), stderr: "", code: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.match(widget.render(160).join("\n"), /1 unknown/);

  resolveReconciliation!({
    stdout: JSON.stringify({
      id: 1,
      result: { snapshot: { agents: [], panes: [] } },
    }),
    stderr: "",
    code: 0,
  });
  for (let attempt = 0; attempt < 20 && listCount < 3; attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(listCount >= 3, JSON.stringify(pi.calls));
  resolveAfterRegistration!({ stdout: envelope(), stderr: "", code: 0 });
  await starting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rendered = widget.render(160).join("\n");
  assert.match(rendered, /1 unknown/);
  assert.match(rendered, /fresh-widget-agent/);
  await pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("fresh assignment refreshes the widget after validation", async (t) => {
  setLeadEnvironment();
  const previousPlacement = readConfig().spawnPlacement;
  updateConfig("spawnPlacement", "subtree");
  const label = "fresh-start-widget-agent";
  const sessionPath = join(
    tmpdir(),
    `pi-herdsman-${label}-${randomUUID()}.jsonl`,
  );
  realFs.writeFileSync(
    sessionPath,
    JSON.stringify({
      type: "session",
      id: DEFAULT_PI_SESSION_ID,
    }),
    "utf8",
  );
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const agentsDir = PI_AGENTS_DIR;
  const definitionPath = `${agentsDir}/agent.md`;
  const hadAgentsDir = realFs.existsSync(agentsDir);
  const hadDefinition = realFs.existsSync(definitionPath);
  const previousDefinition = hadDefinition
    ? realFs.readFileSync(definitionPath, "utf8")
    : undefined;
  realFs.mkdirSync(agentsDir, { recursive: true });
  realFs.writeFileSync(
    definitionPath,
    "---\nname: agent\ninheritProjectContext: true\ninheritGlobalContext: false\n---\nagent instructions\n",
  );
  projectContextCwds.length = 0;
  const requestedCwd = PI_AGENT_ROOT;
  resetAgentMailbox(mailbox);
  let live = false;
  let listCount = 0;
  let resolveInitialStatus: ((value: ExecResult) => void) | undefined;
  let resolveIntegration: ((value: ExecResult) => void) | undefined;
  let releaseInitialHandoff: (() => void) | undefined;
  const initialHandoff = testGate<void>();
  let holdInitialHandoff = true;
  let integrationGetCount = 0;
  let failValidation = false;
  const herdrAgent = {
    agent: "pi",
    name: herdrAlias(label),
    agent_session: {
      agent: "pi",
      kind: "path",
      source: "herdr:pi",
      value: sessionPath,
    },
    agent_status: "working",
    cwd: requestedCwd,
    pane_id: "startup-pane",
    workspace_id: WORKSPACE,
    display_agent: "agent",
    tokens: { task: "fresh task" },
  };
  const snapshot = (live: boolean) =>
    JSON.stringify({
      id: 1,
      result: {
        snapshot: {
          agents: live ? [herdrAgent] : [],
          panes: live
            ? [
                {
                  pane_id: herdrAgent.pane_id,
                  workspace_id: WORKSPACE,
                  cwd: requestedCwd,
                  agent_session: herdrAgent.agent_session,
                },
              ]
            : [],
        },
      },
    });
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    async () => {
      if (!holdInitialHandoff) return;
      holdInitialHandoff = false;
      const state = readAgentState(mailbox);
      if (state)
        writeAgentState(mailbox, {
          ...state,
          activeRequestId: undefined,
          updatedAt: Date.now(),
        });
      releaseInitialHandoff = () => initialHandoff.resolve();
      await initialHandoff.promise;
    },
  );
  const processInfo = {
    pane_id: "startup-pane",
    shell_pid: 123,
    foreground_process_group_id: 123,
    foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
  };
  let startedRunId = AGENT_ID;
  let startedOwnerSessionId = LEAD_SESSION_ID;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args)) {
        listCount++;
        if (listCount === 1)
          return new Promise<ExecResult>((resolve) => {
            resolveInitialStatus = resolve;
          });
        return {
          stdout: snapshot(live),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && isTabList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tabs: [
                {
                  tab_id: "startup-tab",
                  label: "agents",
                  workspace_id: WORKSPACE,
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
        const value = (key: string) =>
          args
            .slice(0, -1)
            .find((arg) => arg.startsWith(`${key}=`))
            ?.slice(key.length + 1);
        startedRunId = value("PI_HERDSMAN_RUN_ID") ?? startedRunId;
        startedOwnerSessionId =
          value("PI_HERDSMAN_OWNER_SESSION_ID") ?? startedOwnerSessionId;
        herdrAgent.name = runScopedHerdrAlias(WORKSPACE, label, startedRunId);
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tab: { tab_id: "startup-tab" },
              root_pane: {
                pane_id: "startup-pane",
                terminal_id: "startup-terminal",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                {
                  pane_id: "startup-pane",
                  tab_id: "startup-tab",
                  workspace_id: WORKSPACE,
                  terminal_id: "startup-terminal",
                  cwd: requestedCwd,
                  foreground_cwd: requestedCwd,
                  agent_status: "unknown",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { process_info: processInfo },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        const value = (key: string) =>
          args
            .slice(0, -1)
            .find((arg) => arg.startsWith(`${key}=`))
            ?.slice(key.length + 1);
        startedRunId = value("PI_HERDSMAN_RUN_ID") ?? startedRunId;
        startedOwnerSessionId =
          value("PI_HERDSMAN_OWNER_SESSION_ID") ?? startedOwnerSessionId;
        herdrAgent.name = runScopedHerdrAlias(WORKSPACE, label, startedRunId);
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              pane: {
                pane_id: "startup-pane",
                terminal_id: "startup-terminal",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        (args[1] === "run" || args[1] === "wait-output")
      ) {
        if (args[1] === "run") {
          const value = (key: string) =>
            new RegExp(`${key}='([^']*)'`).exec(args.at(-1) ?? "")?.[1];
          startedRunId = value("PI_HERDSMAN_RUN_ID") ?? startedRunId;
          startedOwnerSessionId =
            value("PI_HERDSMAN_OWNER_SESSION_ID") ?? startedOwnerSessionId;
          herdrAgent.name = runScopedHerdrAlias(WORKSPACE, label, startedRunId);
        }
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        integrationGetCount++;
        if (failValidation) {
          live = false;
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                agent: {
                  ...herdrAgent,
                  agent_session: {
                    ...herdrAgent.agent_session,
                    value: "/tmp/validation-mismatch.jsonl",
                  },
                },
              },
            }),
            stderr: "",
            code: 0,
          };
        }
        const response = {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: herdrAgent },
          }),
          stderr: "",
          code: 0,
        };
        if (integrationGetCount === 1)
          return new Promise<ExecResult>((resolve) => {
            resolveIntegration = () => resolve(response);
          });
        return response;
      }
      if (
        command === "herdr" &&
        args[0] === "agent" &&
        args[1] === "send-keys"
      ) {
        live = false;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              pane: {
                pane_id: "startup-pane",
                tab_id: "startup-tab",
                workspace_id: WORKSPACE,
                terminal_id: "startup-terminal",
                cwd: requestedCwd,
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        live = true;
        writeAgentState(mailbox, {
          version: 5,
          build: HERDSMAN_BUILD,
          runId: startedRunId,
          ownerSessionId: startedOwnerSessionId,
          workspaceId: WORKSPACE,
          agentLabel: label,
          paneId: "startup-pane",
          piSessionId: DEFAULT_PI_SESSION_ID,
          piSessionFile: sessionPath,
          cwd: requestedCwd,
          updatedAt: Date.now(),
        });
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tab_id: "startup-tab",
              tab_label: "agents",
              pane_id: "startup-pane",
              cwd: requestedCwd,
              herdr_agent: herdrAlias(label),
              created_tab: false,
              created_pane: false,
              agent: herdrAgent,
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      return startup.exec(command, args, options);
    },
  });
  const context = fakeContext() as any;
  context.cwd = requestedCwd;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, context);
    const starting = agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label,
        task: "fresh task",
      },
      undefined,
      undefined,
      context,
    );
    await t.waitFor(() =>
      assert.ok(
        resolveInitialStatus,
        "assignment did not request initial status",
      ),
    );
    resolveInitialStatus!({ stdout: snapshot(true), stderr: "", code: 0 });
    await t.waitFor(() =>
      assert.ok(
        resolveIntegration,
        "assignment did not reach integration validation",
      ),
    );
    assert.match(widget!.render(160).join("\n"), /lead/);
    resolveIntegration!({
      stdout: JSON.stringify({ id: AGENT_ID, result: { agent: herdrAgent } }),
      stderr: "",
      code: 0,
    });
    await t.waitFor(() =>
      assert.ok(
        releaseInitialHandoff,
        "assignment did not reach initial request handoff",
      ),
    );
    const pendingList = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(pendingList.details.agents[0].state, "settling");
    releaseInitialHandoff!();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.deepEqual(
      {
        discoveryCwds: projectContextCwds,
        splitForMismatchedCwd: pi.calls.some(
          (args) => args[0] === "pane" && args[1] === "split",
        ),
      },
      { discoveryCwds: [requestedCwd], splitForMismatchedCwd: false },
    );
    const getIndexes = pi.calls.flatMap((args, index) =>
      args[0] === "agent" && args[1] === "get" ? [index] : [],
    );
    const firstStatusAfterValidation = pi.calls.findIndex(
      (args, index) =>
        index > getIndexes[0] && index < getIndexes[1] && isApiSnapshot(args),
    );
    assert.ok(
      firstStatusAfterValidation >= 0,
      "fresh runtime refresh must occur after validation and before submit validation",
    );
    await t.waitFor(() =>
      assert.match(widget!.render(160).join("\n"), /1 working/),
    );
    const rendered = widget!.render(160).join("\n");
    assert.match(rendered, /1 working/);
    assert.match(rendered, /fresh-start-widget-agent/);

    live = false;
    resetAgentMailbox(mailbox);
    const failed = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label,
        task: "fail this task",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(failed.details.ok, true, JSON.stringify(failed.details));
    assert.equal(pi.sentMessageCalls.length, 1);
    await t.waitFor(() => assert.match(widget!.render(160).join("\n"), /lead/));
    assert.match(widget!.render(160).join("\n"), /lead/);

    failValidation = true;
    live = false;
    resetAgentMailbox(mailbox);
    const invalid = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label,
        task: "invalid identity",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(invalid.details.ok, false);
    await t.waitFor(() => assert.match(widget!.render(160).join("\n"), /lead/));
    assert.match(widget!.render(160).join("\n"), /lead/);
  } finally {
    updateConfig("spawnPlacement", previousPlacement);
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(sessionPath, { force: true });
    if (hadDefinition)
      realFs.writeFileSync(definitionPath, previousDefinition!);
    else if (!hadAgentsDir) {
      realFs.unlinkSync(definitionPath);
      realFs.rmdirSync(agentsDir);
    } else realFs.unlinkSync(definitionPath);
  }
});
