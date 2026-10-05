import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { OperationError } from "./errors.ts";
import { resultPath, resultRef } from "./storage.ts";
import {
  listProjectAssignments,
  listChiefMessagePaths,
  readChiefMessage,
  readChiefDescriptor,
  supervisionRuntime,
  peerRuntime,
  readPeerLeadRecord,
  peerLeadLockPath,
  writePeerLeadRecord,
  removePeerLeadRecord,
  claimChiefLease as claimChiefLeaseRaw,
  claimManagerLease as claimManagerLeaseRaw,
  managerDescriptorPath,
  readManagerDescriptor,
  writeProjectAssignment,
  listProjectMessages,
  writeProjectMessage,
  projectAssignmentPath,
  writeChiefMessage as writeChiefMessageRaw,
  chiefMessageBytes,
  COORDINATION_MESSAGE_MAX_BYTES,
  writeLeadCoordinationState as writeLeadCoordinationStateRaw,
  readLeadCoordinationState,
  drainCoordinationInbox,
} from "./supervision.ts";
import { acquireProcessLock, claimProcessLock } from "./lock.ts";
import support, {
  CHILD_SESSION_ID,
  HERDSMAN_BUILD,
  OTHER_HERDSMAN_BUILD,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  agentFromState,
  cascadeExecutor,
  controlMarker,
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  discoverAgent,
  fakeContext,
  fakePi,
  fakeAgentContext,
  herdrAlias,
  isApiSnapshot,
  isAgentList,
  isPaneList,
  managedState,
  nativeSessions,
  agentControllerExecutor,
  promptLaunchContents,
  promptLaunchPaths,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  recoveryIdentity,
  registerExtension,
  removeAsk,
  removeRequest,
  removeResult,
  resetAgentMailbox,
  resolveAssignmentSession,
  leadExec,
  setLeadEnvironment,
  setAgentEnvironment,
  startupExecutor,
  agentMailboxPath,
  writeAsk,
  writePromptDefinition,
  writeRequest,
  writeResult,
  writeAgentState,
  testTmpRoot,
} from "./support.ts";
const claimChiefLease = (identity: any) =>
  claimChiefLeaseRaw({ ...identity, build: identity.build ?? HERDSMAN_BUILD });
const claimManagerLease = (identity: any) =>
  claimManagerLeaseRaw({
    ...identity,
    build: identity.build ?? HERDSMAN_BUILD,
  });
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
function fakeChiefPi(options: Parameters<typeof fakePi>[0] = {}) {
  let fixture: ReturnType<typeof fakePi>;
  const initialTools = Array.isArray(options.activeTools)
    ? options.activeTools
    : [];
  fixture = fakePi({
    ...options,
    allTools: () =>
      [
        ...new Set([
          ...initialTools,
          "read",
          "bash",
          "agent",
          "supervisor",
          "peer",
          "staff",
          ...fixture.tools.map((tool) => tool.name),
        ]),
      ].map((name) => ({ name })),
  });
  return fixture;
}
const { updateConfig } = await import("./config.ts");
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) =>
  pi.tools.find((candidate) => candidate.name === `agent_${name}`)!;
const ownershipResult = (
  child: string,
  owner = LEAD_SESSION_ID,
  options: { path?: string; label?: string; definition?: string } = {},
) => ({
  type: "custom_message",
  customType: "pi-herdsman-agent-result",
  content: "",
  display: true,
  details: {
    piSessionId: child,
    ...(options.path ? { piSessionFile: options.path } : {}),
    ownerSessionId: owner,
    runId: randomUUID(),
    requestId: randomUUID(),
    agentLabel: options.label ?? "agent",
    agentDefinition: options.definition ?? "agent",
    status: "completed",
  },
});

test("assigned Lead saves supervisor messages durably with or without a Manager", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `manager-routing-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_WORKSPACE_ID = "linked-workspace";
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const chiefId = randomUUID();
  const managerId = randomUUID();
  const leadId = randomUUID();
  const runtime = supervisionRuntime();
  const chief = claimChiefLease({
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  const manager = claimManagerLease({
    piSessionId: managerId,
    paneId: "manager-pane",
    tabId: "manager-tab",
    workspaceId: WORKSPACE,
    repoKey: "repo-key",
  });
  const descriptorPath = managerDescriptorPath(runtime, WORKSPACE);
  const descriptor = readFileSync(descriptorPath, "utf8");
  let managerReleased = false;
  const agents = [
    [chiefId, "chief-pane", "chief-tab", WORKSPACE],
    [managerId, "manager-pane", "manager-tab", WORKSPACE],
    [leadId, "lead-pane", "lead-tab", "linked-workspace"],
  ].map(([id, pane_id, tab_id, workspace_id]) => ({
    agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: id },
    pane_id,
    tab_id,
    workspace_id,
  }));
  const exec = (_command: string, args: string[]) => {
    let result: unknown = {};
    if (isApiSnapshot(args)) result = { snapshot: { agents, panes: [] } };
    else if (isAgentList(args)) result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => agent.pane_id === args[2]) };
    else if (args[0] === "workspace" && args[1] === "get")
      result = {
        workspace: {
          worktree: { repo_key: "repo-key", is_linked_worktree: true },
        },
      };
    else if (args[0] === "worktree" && args[1] === "list")
      result = {
        source: {
          repo_key: "repo-key",
          repo_name: "project",
          source_workspace_id: WORKSPACE,
        },
        worktrees: [{ open_workspace_id: "linked-workspace" }],
      };
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    };
  };
  const pi = fakeChiefPi({ exec });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext() as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => leadId,
    getSessionFile: () => `/tmp/${leadId}.jsonl`,
  };
  try {
    writeProjectAssignment(runtime, {
      version: 2,
      id: leadId,
      repoKey: "repo-key",
      branch: "smoke/routing",
      text: "routing assignment",
    });
    writeLeadCoordinationState(runtime, {
      version: 1,
      role: "manager",
      instanceId: randomUUID(),
      piSessionId: managerId,
      updatedAt: Date.now(),
    });
    await pi.events.get("session_start")![0](undefined, ctx);
    const tool = pi.tools.find(
      (candidate) => candidate.name === "supervisor_message",
    )!;
    const send = (message: string) =>
      tool.execute("message", { message }, undefined, undefined, ctx);
    const records = (id: string) =>
      listChiefMessagePaths(runtime, id).map((path) => readChiefMessage(path));

    const saved = await send("SMOKE_READY_1");
    assert.match(JSON.stringify(saved), /Project message saved for Manager/);
    assert.equal(records(managerId).length, 0);
    assert.deepEqual(
      listProjectMessages(runtime, "repo-key", "smoke/routing").map(
        ({ repoKey, branch, fromSessionId, text }) => ({
          repoKey,
          branch,
          fromSessionId,
          text,
        }),
      ),
      [
        {
          repoKey: "repo-key",
          branch: "smoke/routing",
          fromSessionId: leadId,
          text: "SMOKE_READY_1",
        },
      ],
    );
    manager.release();
    managerReleased = true;
    const withoutManager = await send("MANAGER_ABSENT_OK");
    assert.match(
      JSON.stringify(withoutManager),
      /Project message saved for Manager/,
    );
    assert.deepEqual(
      listProjectMessages(runtime, "repo-key", "smoke/routing").map(
        (record) => record.text,
      ),
      ["SMOKE_READY_1", "MANAGER_ABSENT_OK"],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    if (!managerReleased) {
      if (!realFs.existsSync(descriptorPath))
        writeFileSync(descriptorPath, descriptor);
      manager.release();
    }
    chief.release();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("removed worktree retires its assignment and messages but preserves a newer assignment", async () => {
  setLeadEnvironment();
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pi-herdsman-${randomUUID()}`
      : join(tmpdir(), `ph-${randomUUID().slice(0, 8)}.sock`);
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_WORKSPACE_ID = "linked-workspace";
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const runtime = supervisionRuntime();
  const repoKey = "repo-key";
  const branch = "feat/retirement";
  const assignment = {
    version: 2 as const,
    id: randomUUID(),
    repoKey,
    branch,
    text: "project assignment",
  };
  const message = (id: string) => ({
    version: 2 as const,
    id,
    repoKey,
    branch,
    fromSessionId: assignment.id,
    text: "retained project message",
    createdAt: Date.now(),
  });
  writeProjectAssignment(runtime, assignment);
  writeProjectMessage(message(randomUUID()), runtime);

  const server = createServer();
  const sockets = new Set<Socket>();
  let notifyWorktreeList!: () => void;
  let subscribed!: () => void;
  let worktreeListRequested = new Promise<void>((resolve) => {
    notifyWorktreeList = resolve;
  });
  const subscriptionReady = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
      subscribed();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const exec = (_command: string, args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      notifyWorktreeList();
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            source: {
              repo_key: repoKey,
              repo_name: "project",
              source_workspace_id: WORKSPACE,
            },
            worktrees: [{ open_workspace_id: "linked-workspace" }],
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result: {} }),
      stderr: "",
      code: 0,
    };
  };
  const pi = fakeChiefPi({ exec });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext() as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => assignment.id,
    getSessionFile: () => `/tmp/${assignment.id}.jsonl`,
  };
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    await subscriptionReady;

    const publishRemoval = (removedBranch: string) =>
      [...sockets][0]!.write(
        `${JSON.stringify({
          event: "worktree_removed",
          data: {
            type: "worktree_removed",
            workspace_id: "linked-workspace",
            workspace: {
              workspace_id: "linked-workspace",
              worktree: {
                repo_key: repoKey,
                checkout_path: "/repo/worktree",
                is_linked_worktree: true,
              },
            },
            worktree: {
              path: "/repo/worktree",
              branch: removedBranch,
              is_linked_worktree: true,
            },
          },
        })}\n`,
      );
    publishRemoval(branch);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!listProjectAssignments(runtime, repoKey).length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(listProjectAssignments(runtime, repoKey), []);
    assert.deepEqual(listProjectMessages(runtime, repoKey, branch), []);

    const staleObserved = { ...assignment, id: randomUUID() };
    writeProjectAssignment(runtime, staleObserved);
    writeProjectMessage(message(randomUUID()), runtime);
    const releaseLock = claimProcessLock(
      `${projectAssignmentPath(runtime, repoKey, branch)}.lock`,
      { name: "test project assignment lock" },
    );
    const replacement = { ...assignment, id: randomUUID() };
    worktreeListRequested = new Promise<void>((resolve) => {
      notifyWorktreeList = resolve;
    });
    publishRemoval(branch);
    await worktreeListRequested;
    writeProjectAssignment(runtime, replacement);
    releaseLock();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(listProjectAssignments(runtime, repoKey), [replacement]);
    assert.equal(listProjectMessages(runtime, repoKey, branch).length, 1);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32")
      realFs.rmSync(socketPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("project Lead observes Manager availability across turnover without exposing identity", async () => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `project-supervisor-state-${randomUUID()}.sock`,
  );
  process.env.HERDR_WORKSPACE_ID = "linked-workspace";
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const runtime = supervisionRuntime();
  const leadId = randomUUID();
  const managerId = randomUUID();
  const assignment = {
    version: 2 as const,
    id: leadId,
    repoKey: "repo-key",
    branch: "smoke/supervisor-state",
    text: "project assignment",
  };
  writeProjectAssignment(runtime, assignment);
  const manager = claimManagerLease({
    piSessionId: managerId,
    paneId: "manager-pane",
    tabId: "manager-tab",
    workspaceId: WORKSPACE,
    repoKey: "repo-key",
  });
  let managerReleased = false;
  let replacement: ReturnType<typeof claimManagerLease> | undefined;
  writeLeadCoordinationState(runtime, {
    version: 1,
    role: "manager",
    instanceId: randomUUID(),
    piSessionId: managerId,
    updatedAt: Date.now(),
  });
  const agents: any[] = [
    {
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: leadId,
      },
      pane_id: "lead-pane",
      tab_id: "lead-tab",
      workspace_id: "linked-workspace",
    },
    {
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: managerId,
      },
      pane_id: "manager-pane",
      tab_id: "manager-tab",
      workspace_id: WORKSPACE,
    },
  ];
  const exec = (_command: string, args: string[]) => {
    let result: unknown = {};
    if (isApiSnapshot(args)) result = { snapshot: { agents, panes: [] } };
    else if (isAgentList(args)) result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => agent.pane_id === args[2]) };
    else if (args[0] === "workspace" && args[1] === "get")
      result = {
        workspace: {
          worktree: { repo_key: "repo-key", is_linked_worktree: true },
        },
      };
    else if (args[0] === "worktree" && args[1] === "list")
      result = {
        source: {
          repo_key: "repo-key",
          repo_name: "project",
          source_workspace_id: WORKSPACE,
        },
        worktrees: [
          { branch: assignment.branch, open_workspace_id: "linked-workspace" },
        ],
      };
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    };
  };
  const branch: any[] = [];
  let messageId = 0;
  const pi = fakeChiefPi({
    exec,
    sendMessage: (message: any) => {
      const id = `synthetic-${++messageId}`;
      branch.push({
        type: "custom_message",
        id,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        ...message,
      });
    },
  });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext([], branch) as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => leadId,
    getSessionFile: () => `/tmp/${leadId}.jsonl`,
  };
  const observe = () =>
    pi.events.get("before_agent_start")![0](
      { systemPrompt: "prompt", systemPromptOptions: {} },
      ctx,
    );
  const latestState = () =>
    branch.findLast(
      (entry) => entry.customType === "pi-herdsman-supervisor-state",
    );
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    const sentBefore = pi.sentMessageCalls.length;
    const availableResult = await observe();
    assert.equal(availableResult?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, sentBefore + 1);
    assert.deepEqual(pi.sentMessageCalls.at(-1)!.options, {
      triggerTurn: false,
    });
    const available = latestState();
    assert.equal(available.customType, "pi-herdsman-supervisor-state");
    assert.match(available.content, /supervisor: manager/);
    assert.match(available.content, /availability: available/);
    assert.doesNotMatch(available.content, new RegExp(managerId));
    const duplicateCount = pi.sentMessageCalls.length;
    assert.equal((await observe())?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, duplicateCount);

    writeLeadCoordinationState(runtime, {
      version: 1,
      role: undefined,
      instanceId: randomUUID(),
      piSessionId: managerId,
      updatedAt: Date.now(),
    });
    assert.equal((await observe())?.message, undefined);
    const unknown = latestState();
    assert.match(unknown.content, /supervisor: manager/);
    assert.match(unknown.content, /availability: unknown/);
    assert.match(
      unknown.content,
      /project_messages: retained for the Manager role/,
    );
    const savedWhileUnknown = await pi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute(
        "message",
        { message: "RETAINED_WITH_UNVERIFIED_MANAGER" },
        undefined,
        undefined,
        ctx,
      );
    assert.match(
      JSON.stringify(savedWhileUnknown),
      /Project message saved for Manager/,
    );
    assert.equal(
      listProjectMessages(runtime, "repo-key", assignment.branch)[0]?.text,
      "RETAINED_WITH_UNVERIFIED_MANAGER",
    );
    writeLeadCoordinationState(runtime, {
      version: 1,
      role: "manager",
      instanceId: randomUUID(),
      piSessionId: managerId,
      updatedAt: Date.now(),
    });

    manager.release();
    agents.splice(1, 1);
    assert.equal((await observe())?.message, undefined);
    const unavailable = latestState();
    assert.match(unavailable.content, /supervisor: manager/);
    assert.match(unavailable.content, /availability: unavailable/);
    assert.match(
      unavailable.content,
      /project_messages: retained for the Manager role/,
    );
    const saved = await pi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute(
        "message",
        { message: "RETAINED_WITHOUT_MANAGER" },
        undefined,
        undefined,
        ctx,
      );
    assert.match(JSON.stringify(saved), /Project message saved for Manager/);
    assert.equal(
      listProjectMessages(runtime, "repo-key", assignment.branch)[1]?.text,
      "RETAINED_WITHOUT_MANAGER",
    );

    const replacementId = randomUUID();
    replacement = claimManagerLease({
      piSessionId: replacementId,
      paneId: "manager-replacement-pane",
      tabId: "manager-replacement-tab",
      workspaceId: WORKSPACE,
      repoKey: "repo-key",
    });
    agents.push({
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: replacementId,
      },
      pane_id: "manager-replacement-pane",
      tab_id: "manager-replacement-tab",
      workspace_id: WORKSPACE,
    });
    writeLeadCoordinationState(runtime, {
      version: 1,
      role: "manager",
      instanceId: randomUUID(),
      piSessionId: replacementId,
      updatedAt: Date.now(),
    });
    assert.equal((await observe())?.message, undefined);
    const replacementState = latestState();
    assert.match(replacementState.content, /availability: available/);
    assert.doesNotMatch(replacementState.content, new RegExp(replacementId));
    replacement.release();
    replacement = undefined;
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    replacement?.release();
    if (!managerReleased) manager.release();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("unassigned Lead routes supervisor messages directly to Chief", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `unassigned-routing-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_WORKSPACE_ID = "linked-workspace";
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const chiefId = randomUUID();
  const leadId = randomUUID();
  const runtime = supervisionRuntime();
  let chief = claimChiefLease({
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  const agents = [
    [chiefId, "chief-pane", "chief-tab", WORKSPACE],
    [leadId, "lead-pane", "lead-tab", "linked-workspace"],
  ].map(([id, pane_id, tab_id, workspace_id]) => ({
    agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: id },
    pane_id,
    tab_id,
    workspace_id,
  }));
  let observationFailure = false;
  let chiefDiscoveryFailure = false;
  const exec = (_command: string, args: string[]) => {
    if (chiefDiscoveryFailure && isAgentList(args))
      return {
        stdout: "",
        stderr: "simulated Chief discovery failure",
        code: 1,
      };
    if (observationFailure)
      return { stdout: "", stderr: "simulated Herdr failure", code: 1 };
    let result: unknown = {};
    if (isApiSnapshot(args)) result = { snapshot: { agents, panes: [] } };
    else if (isAgentList(args)) result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => agent.pane_id === args[2]) };
    else if (args[0] === "workspace" && args[1] === "get")
      result = {
        workspace: {
          worktree: { repo_key: "repo-key", is_linked_worktree: true },
        },
      };
    else if (args[0] === "worktree" && args[1] === "list")
      result = {
        source: {
          repo_key: "repo-key",
          repo_name: "project",
          source_workspace_id: WORKSPACE,
        },
        worktrees: [{ open_workspace_id: "linked-workspace" }],
      };
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    };
  };
  const branch: any[] = [];
  let messageId = 0;
  const pi = fakeChiefPi({
    exec,
    sendMessage: (message: any) => {
      const id = `synthetic-${++messageId}`;
      branch.push({
        type: "custom_message",
        id,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        ...message,
      });
    },
  });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext([], branch) as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => leadId,
    getSessionFile: () => `/tmp/${leadId}.jsonl`,
  };
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    const beforeAgentStart = pi.events.get("before_agent_start")![0];
    const observe = () =>
      beforeAgentStart(
        { systemPrompt: "prompt", systemPromptOptions: {} },
        ctx,
      );
    const chiefStateResult = await observe();
    assert.equal(chiefStateResult?.message, undefined);
    const chiefState = branch.at(-1);
    assert.equal(
      (pi.sentMessageCalls.at(-1)!.message as any).customType,
      "pi-herdsman-supervisor-state",
    );
    assert.deepEqual(pi.sentMessageCalls.at(-1)!.options, {
      triggerTurn: false,
    });
    assert.match(chiefState.content, /supervisor: chief/);
    assert.match(chiefState.content, /availability: available/);
    const duplicateCount = pi.sentMessageCalls.length;
    assert.equal((await observe())?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, duplicateCount);
    chief.release();
    chief = claimChiefLease({
      piSessionId: chiefId,
      paneId: "chief-pane",
      tabId: "chief-tab",
      workspaceId: WORKSPACE,
      build: OTHER_HERDSMAN_BUILD,
    });
    const supervisorMessage = pi.tools.find(
      (tool) => tool.name === "supervisor_message",
    )!;
    await assert.rejects(
      supervisorMessage.execute(
        "message",
        { message: "MISMATCH_MUST_NOT_PUBLISH" },
        undefined,
        undefined,
        ctx,
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
    assert.deepEqual(listChiefMessagePaths(runtime, chiefId), []);
    chief.release();
    chief = claimChiefLease({
      piSessionId: chiefId,
      paneId: "chief-pane",
      tabId: "chief-tab",
      workspaceId: WORKSPACE,
    });
    const result = await pi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute(
        "message",
        { message: "UNASSIGNED_DIRECT_TO_CHIEF" },
        undefined,
        undefined,
        ctx,
      );
    assert.equal(result.details.chiefSessionId, chiefId);
    assert.ok(
      listChiefMessagePaths(runtime, chiefId).some((path) => {
        const record = readChiefMessage(path);
        return (
          record.kind === "lead_message" &&
          record.fromSessionId === leadId &&
          record.text === "UNASSIGNED_DIRECT_TO_CHIEF"
        );
      }),
    );
    chiefDiscoveryFailure = true;
    assert.equal((await observe())?.message, undefined);
    const unverifiedChief = branch.at(-1);
    assert.match(unverifiedChief.content, /supervisor: unverified/);
    assert.match(unverifiedChief.content, /availability: unknown/);
    await assert.rejects(
      pi.tools
        .find((tool) => tool.name === "supervisor_message")!
        .execute(
          "message",
          { message: "UNVERIFIED_CHIEF_MUST_REJECT" },
          undefined,
          undefined,
          ctx,
        ),
      /No active supervisor is available/,
    );
    chiefDiscoveryFailure = false;
    writeFileSync(runtime.descriptor, "invalid Chief descriptor");
    const unreadableCount = pi.sentMessageCalls.length;
    assert.equal((await observe())?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, unreadableCount);
    assert.equal(
      branch.filter(
        (message) =>
          message.customType === "pi-herdsman-supervisor-state" &&
          message.content.includes("supervisor: unverified"),
      ).length,
      1,
    );
    await assert.rejects(
      pi.tools
        .find((tool) => tool.name === "supervisor_message")!
        .execute(
          "message",
          { message: "UNVERIFIED_DESCRIPTOR_MUST_REJECT" },
          undefined,
          undefined,
          ctx,
        ),
      /No active supervisor is available/,
    );
    chief.release();
    assert.equal((await observe())?.message, undefined);
    const noSupervisor = branch.at(-1);
    assert.match(noSupervisor.content, /supervisor: none/);
    assert.match(noSupervisor.content, /availability: unavailable/);
    await assert.rejects(
      pi.tools
        .find((tool) => tool.name === "supervisor_message")!
        .execute(
          "message",
          { message: "NO_SUPERVISOR_MUST_REJECT" },
          undefined,
          undefined,
          ctx,
        ),
      /No active supervisor is available/,
    );
    observationFailure = true;
    assert.equal((await observe())?.message, undefined);
    const unverified = branch.at(-1);
    assert.match(unverified.content, /supervisor: unverified/);
    assert.match(unverified.content, /availability: unknown/);
    assert.deepEqual(
      listProjectMessages(runtime, "repo-key", "smoke/routing"),
      [],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    chief.release();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("legacy Lead pendingAsk state is normalized and does not block messaging", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `legacy-lead-state-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_WORKSPACE_ID = "linked-workspace";
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const chiefId = randomUUID();
  const leadId = randomUUID();
  const runtime = supervisionRuntime();
  const chief = claimChiefLease({
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  const agents = [
    [chiefId, "chief-pane", "chief-tab", WORKSPACE],
    [leadId, "lead-pane", "lead-tab", "linked-workspace"],
  ].map(([id, pane_id, tab_id, workspace_id]) => ({
    agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: id },
    pane_id,
    tab_id,
    workspace_id,
  }));
  const exec = (_command: string, args: string[]) => {
    let result: unknown = {};
    if (isApiSnapshot(args)) result = { snapshot: { agents, panes: [] } };
    else if (isAgentList(args)) result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => agent.pane_id === args[2]) };
    else if (args[0] === "workspace" && args[1] === "get")
      result = {
        workspace: {
          worktree: { repo_key: "repo-key", is_linked_worktree: true },
        },
      };
    else if (args[0] === "worktree" && args[1] === "list")
      result = {
        source: {
          repo_key: "repo-key",
          repo_name: "project",
          source_workspace_id: WORKSPACE,
        },
        worktrees: [{ open_workspace_id: "linked-workspace" }],
      };
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    };
  };
  const pi = fakeChiefPi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-lead-state",
        data: {
          instanceId: randomUUID(),
          pendingAsk: { question: "retired question", id: randomUUID() },
        },
      },
    ],
    exec,
  });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext(pi.entries) as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => leadId,
  };
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    const normalized = pi.entries
      .filter((entry: any) => entry?.customType === "pi-herdsman-lead-state")
      .at(-1) as any;
    assert.deepEqual(Object.keys(normalized.data).sort(), ["instanceId"]);
    assert.notEqual(
      normalized.data.instanceId,
      (pi.entries[0] as any).data.instanceId,
    );

    const result = await pi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute(
        "message",
        { message: "LEGACY_STATE_MESSAGE_OK" },
        undefined,
        undefined,
        ctx,
      );
    assert.equal(result.details.chiefSessionId, chiefId);
    assert.ok(
      listChiefMessagePaths(runtime, chiefId).some((path) => {
        const record = readChiefMessage(path);
        return (
          record.kind === "lead_message" &&
          record.fromSessionId === leadId &&
          record.text === "LEGACY_STATE_MESSAGE_OK"
        );
      }),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    chief.release();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("Chief preflight defers inbox delivery until agent_start", async (t) => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `chief-preflight-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  const sessionId = randomUUID();
  const senderId = randomUUID();
  const agents = [
    [sessionId, "chief-pane", "chief-tab", WORKSPACE],
    [senderId, "sender-pane", "sender-tab", WORKSPACE],
  ].map(([id, pane_id, tab_id, workspace_id]) => ({
    agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: id },
    pane_id,
    tab_id,
    workspace_id,
  }));
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: senderId,
    updatedAt: Date.now(),
  });
  const exec = (_command: string, args: string[]) => {
    let result: unknown = {};
    if (isApiSnapshot(args)) result = { snapshot: { agents, panes: [] } };
    else if (isAgentList(args)) result = { agents };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: agents.find((agent) => agent.pane_id === args[2]) };
    else if (args[0] === "workspace" && args[1] === "get")
      result = {
        workspace: {
          worktree: { repo_key: "repo-key", is_linked_worktree: true },
        },
      };
    else if (args[0] === "worktree" && args[1] === "list")
      result = {
        source: {
          repo_key: "repo-key",
          repo_name: "project",
          source_workspace_id: WORKSPACE,
        },
        worktrees: [{ open_workspace_id: WORKSPACE }],
      };
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    };
  };
  const pi = fakeChiefPi({ exec });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext() as any;
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionId: () => sessionId,
  };
  ctx.isIdle = () => true;
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    assert.equal(readPeerLeadRecord(peerRuntime(), senderId), undefined);
    await pi.commandOptions.get("chief").handler("", ctx);
    const descriptor = readChiefDescriptor(supervisionRuntime().descriptor);
    writeChiefMessage(
      {
        version: 2,
        id: randomUUID(),
        leaseId: descriptor.leaseId,
        kind: "lead_message",
        fromSessionId: senderId,
        toSessionId: sessionId,
        leadSessionId: senderId,
        text: "queued until the turn starts",
        createdAt: Date.now(),
      },
      supervisionRuntime(),
    );

    const beforeAgentStart = pi.events.get("before_agent_start")![0];
    const preflight = () =>
      beforeAgentStart(
        { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
        ctx,
      );
    await Promise.all([preflight(), preflight()]);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(
      pi.sent.some((message: any) =>
        String(message?.content ?? "").includes("queued until the turn starts"),
      ),
      false,
    );

    await pi.events.get("agent_start")![0](undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(
      pi.sent.some((message: any) =>
        String(message?.content ?? "").includes("queued until the turn starts"),
      ),
      false,
    );

    await pi.events.get("agent_start")![0](undefined, ctx);
    await t.waitFor(() =>
      assert.ok(
        pi.sent.some((message: any) =>
          String(message?.content ?? "").includes(
            "queued until the turn starts",
          ),
        ),
      ),
    );
    const delivered = pi.sent.find(
      (message: any) =>
        message.customType === "pi-herdsman-lead_message" &&
        String(message.content).includes("queued until the turn starts"),
    );
    assert.deepEqual(
      {
        fromSessionId: delivered.details.fromSessionId,
        toSessionId: delivered.details.toSessionId,
        toRole: delivered.details.toRole,
      },
      { fromSessionId: senderId, toSessionId: sessionId, toRole: "chief" },
    );

    const peers = peerRuntime();
    const senderLease = acquireProcessLock(peerLeadLockPath(peers, senderId), {
      name: "Lead peer presence",
    });
    try {
      writePeerLeadRecord(peers, {
        version: 1,
        build: HERDSMAN_BUILD,
        role: "lead",
        piSessionId: senderId,
        paneId: "sender-pane",
        tabId: "sender-tab",
        workspaceId: WORKSPACE,
        name: "feature-auth",
        workspaceLabel: "pi-herdsman/feat-auth",
        cwd: "/tmp/feat-auth",
        claim: senderLease.claim,
        updatedAt: Date.now(),
      });
      assert.equal(readPeerLeadRecord(peers, senderId)?.name, "feature-auth");
      writeChiefMessage(
        {
          version: 2,
          id: randomUUID(),
          leaseId: descriptor.leaseId,
          kind: "lead_message",
          fromSessionId: senderId,
          toSessionId: sessionId,
          leadSessionId: senderId,
          text: "semantic endpoint test",
          createdAt: Date.now(),
        },
        supervisionRuntime(),
      );
      await pi.events.get("agent_start")![0](undefined, ctx);
      await t.waitFor(() =>
        assert.ok(
          pi.sent.some((message: any) =>
            String(message?.content ?? "").includes("semantic endpoint test"),
          ),
        ),
      );
      const enriched = pi.sent.find(
        (message: any) =>
          message.customType === "pi-herdsman-lead_message" &&
          String(message.content).includes("semantic endpoint test"),
      ) as any;
      assert.equal(enriched.details.fromDisplayName, "feature-auth");
      assert.equal(enriched.details.toRole, "chief");
    } finally {
      removePeerLeadRecord(peers, senderId);
      senderLease.release();
    }
    assert.equal(
      listChiefMessagePaths(supervisionRuntime(), sessionId).length,
      0,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

for (const reachable of [true, false]) {
  test(`fresh Manager activation ${reachable ? "is immediately reachable without chat" : "rolls back unproven remote identity"}`, async (t) => {
    setLeadEnvironment();
    process.env.HERDR_PANE_ID = "root-pane";
    process.env.HERDR_TAB_ID = "root-tab";
    process.env.HERDR_SOCKET_PATH = join(
      tmpdir(),
      `manager-bootstrap-${randomUUID()}.sock`,
    );
    const runtime = supervisionRuntime();
    let managerSessionFile = join(
      tmpdir(),
      `pi-herdsman-manager-${randomUUID()}.jsonl`,
    );
    const managerAgent: any = {
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: reachable ? "path" : "id",
        value: reachable ? managerSessionFile : LEAD_SESSION_ID,
      },
      pane_id: "root-pane",
      tab_id: "root-tab",
      workspace_id: WORKSPACE,
    };
    const exec = async (_command: string, args: string[]) => {
      let result: unknown = {};
      if (args[0] === "worktree" && args[1] === "list")
        result = {
          source: {
            repo_key: "repo-key",
            repo_name: "project",
            source_workspace_id: WORKSPACE,
          },
          worktrees: [],
        };
      else if (isAgentList(args))
        result = { agents: reachable ? [managerAgent] : [] };
      else if (args[0] === "agent" && args[1] === "get")
        result = { agent: reachable ? managerAgent : undefined };
      else if (isApiSnapshot(args))
        result = {
          snapshot: { agents: reachable ? [managerAgent] : [], panes: [] },
        };
      return {
        stdout: JSON.stringify({ id: AGENT_ID, result }),
        stderr: "",
        code: 0,
      };
    };
    let managerHistory: unknown[] = [];
    let managerBranch: unknown[] = [];
    const pi = fakeChiefPi({
      activeTools: ["read"],
      exec,
      sendMessage: (message) => managerHistory.push(message),
    });
    registerExtension!(pi.pi as never);
    const ctx = fakeContext(pi.entries) as any;
    managerHistory = pi.entries;
    managerBranch = managerHistory;
    if (reachable)
      ctx.sessionManager = {
        ...ctx.sessionManager,
        getSessionFile: () => managerSessionFile,
        getEntries: () => managerHistory,
        getBranch: () => managerBranch,
      };
    const notices: string[] = [];
    ctx.ui.notify = (message: string) => notices.push(message);
    try {
      await pi.events.get("session_start")![0](undefined, ctx);
      // No before_agent_start or conversation turn precedes Manager activation.
      if (reachable) assert.equal(realFs.existsSync(managerSessionFile), false);
      await pi.commandOptions.get("manager").handler("", ctx);
      const state = readLeadCoordinationState(runtime, LEAD_SESSION_ID)!;
      if (reachable) {
        assert.ok(notices.includes("Manager mode active."));
        assert.equal(realFs.existsSync(managerSessionFile), false);
        assert.equal(state.role, "manager");
        assert.ok(realFs.existsSync(managerDescriptorPath(runtime, WORKSPACE)));
        const leadId = randomUUID();
        const branch = "smoke/manager-replay";
        const managerA = readManagerDescriptor(runtime, WORKSPACE)!;
        const liveRecord = {
          version: 2 as const,
          id: randomUUID(),
          repoKey: "repo-key",
          branch,
          fromSessionId: leadId,
          text: "live project review handoff",
          createdAt: managerA.createdAt + 1,
        };
        writeProjectAssignment(runtime, {
          version: 2,
          id: leadId,
          repoKey: "repo-key",
          branch,
          text: "project assignment",
        });
        writeProjectMessage(liveRecord, runtime);
        const projectDeliveries = (id: string) =>
          managerHistory.filter(
            (message: any) =>
              message?.customType === "pi-herdsman-project_message" &&
              message?.details?.id === id,
          );
        await t.waitFor(() =>
          assert.equal(projectDeliveries(liveRecord.id).length, 1),
        );
        const liveSend = pi.sentMessageCalls.find(
          ({ message }: any) => (message as any)?.details?.id === liveRecord.id,
        )!;
        assert.equal((liveSend.options as any).triggerTurn, true);
        assert.equal((liveSend.options as any).deliverAs, "followUp");
        const deliveredIndex = managerHistory.findIndex(
          (entry: any) =>
            entry?.customType === "pi-herdsman-project_message" &&
            entry?.details?.id === liveRecord.id,
        );
        assert.ok(deliveredIndex >= 0);
        managerBranch = managerHistory.slice(0, deliveredIndex);
        assert.equal(
          managerBranch.some(
            (entry: any) =>
              entry?.customType === "pi-herdsman-project_message" &&
              entry?.details?.id === liveRecord.id,
          ),
          false,
        );
        ctx.isIdle = () => true;
        await pi.events.get("before_agent_start")![0](
          {
            systemPrompt: "base",
            systemPromptOptions: { contextFiles: [] },
          },
          ctx,
        );
        await new Promise((resolve) => setTimeout(resolve, 650));
        assert.equal(projectDeliveries(liveRecord.id).length, 1);
        assert.deepEqual(listProjectMessages(runtime, "repo-key", branch), []);

        await pi.commandOptions.get("manager").handler("leave", ctx);
        const replacementId = randomUUID();
        managerSessionFile = join(tmpdir(), `${replacementId}.jsonl`);
        managerAgent.agent_session.value = managerSessionFile;
        managerHistory = [];
        managerBranch = managerHistory;
        ctx.sessionManager = {
          ...ctx.sessionManager,
          getSessionId: () => replacementId,
          getSessionFile: () => managerSessionFile,
          getEntries: () => managerHistory,
          getBranch: () => managerBranch,
        };
        const backlogRecord = {
          ...liveRecord,
          id: randomUUID(),
          text: "pending while Manager absent",
          createdAt: 0,
        };
        writeProjectMessage(backlogRecord, runtime);
        await pi.commandOptions.get("manager").handler("", ctx);
        await t.waitFor(() =>
          assert.equal(projectDeliveries(backlogRecord.id).length, 1),
        );
        assert.equal(projectDeliveries(liveRecord.id).length, 0);
        const backlogSend = pi.sentMessageCalls.find(
          ({ message }: any) =>
            (message as any)?.details?.id === backlogRecord.id,
        )!;
        assert.equal((backlogSend.options as any).triggerTurn, false);
        ctx.isIdle = () => true;
        await new Promise((resolve) => setTimeout(resolve, 650));
        assert.deepEqual(listProjectMessages(runtime, "repo-key", branch), []);

        await pi.commandOptions.get("manager").handler("leave", ctx);
        const managerCId = randomUUID();
        managerSessionFile = join(tmpdir(), `${managerCId}.jsonl`);
        managerAgent.agent_session.value = managerSessionFile;
        managerHistory = [];
        managerBranch = managerHistory;
        ctx.sessionManager = {
          ...ctx.sessionManager,
          getSessionId: () => managerCId,
          getSessionFile: () => managerSessionFile,
          getEntries: () => managerHistory,
          getBranch: () => managerBranch,
        };
        await pi.commandOptions.get("manager").handler("", ctx);
        await new Promise((resolve) => setTimeout(resolve, 650));
        assert.equal(projectDeliveries(liveRecord.id).length, 0);
        assert.equal(projectDeliveries(backlogRecord.id).length, 0);
        assert.equal(
          listProjectAssignments(runtime, "repo-key").some(
            (assignment) => assignment.branch === branch,
          ),
          true,
        );
        process.env.HERDR_PANE_ID = "lead-pane";
        process.env.HERDR_TAB_ID = "lead-tab";
        const lead = fakeChiefPi({ exec });
        registerExtension!(lead.pi as never);
        const leadCtx = fakeContext() as any;
        leadCtx.sessionManager = {
          ...leadCtx.sessionManager,
          getSessionId: () => leadId,
        };
        try {
          await lead.events.get("session_start")![0](undefined, leadCtx);
          const result = await lead.tools
            .find((tool) => tool.name === "supervisor_message")!
            .execute(
              "message",
              { message: "reachable before chat" },
              undefined,
              undefined,
              leadCtx,
            );
          assert.equal(result.details.branch, branch);
          assert.ok(typeof result.details.id === "string");
          const saved = listProjectMessages(runtime, "repo-key", branch).find(
            (message) => message.id === result.details.id,
          );
          assert.ok(saved);
          assert.equal(saved.id, result.details.id);
          assert.equal(saved.fromSessionId, leadId);
          assert.equal(saved.text, "reachable before chat");
        } finally {
          await lead.events.get("session_shutdown")?.[0]();
          process.env.HERDR_PANE_ID = "root-pane";
          process.env.HERDR_TAB_ID = "root-tab";
        }
      } else {
        assert.ok(
          notices.some((message) =>
            message.includes("Manager could not be verified in Herdr"),
          ),
        );
        assert.equal(state.role, "lead");
        assert.equal(
          realFs.existsSync(managerDescriptorPath(runtime, WORKSPACE)),
          false,
        );
        assert.equal(pi.pi.getActiveTools().includes("staff_delegate"), false);
      }
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      setLeadEnvironment();
    }
  });
}

for (const scenario of [
  {
    name: "accepts its branch worktree Lead",
    moved: false,
    mismatchedPath: false,
    prospectivePath: false,
  },
  {
    name: "accepts its prospective session path before the file exists",
    moved: false,
    mismatchedPath: false,
    prospectivePath: true,
  },
  {
    name: "denies an exact Lead moved to a sibling worktree",
    moved: true,
    mismatchedPath: false,
    prospectivePath: false,
  },
  {
    name: "denies a mismatched prospective session path",
    moved: false,
    mismatchedPath: true,
    prospectivePath: false,
  },
])
  test(`project assignment delivery ${scenario.name}`, async (t) => {
    setLeadEnvironment();
    process.env.HERDR_SOCKET_PATH = join(
      tmpdir(),
      `assignment-placement-${randomUUID()}.sock`,
    );
    process.env.HERDR_WORKSPACE_ID = "branch-workspace";
    process.env.HERDR_PANE_ID = "lead-pane";
    process.env.HERDR_TAB_ID = "lead-tab";
    const sessionId = randomUUID();
    const managerId = randomUUID();
    const sessionPath = join(tmpdir(), `${sessionId}.jsonl`);
    if (scenario.mismatchedPath) writeFileSync(sessionPath, "");
    if (scenario.prospectivePath)
      assert.equal(realFs.existsSync(sessionPath), false);
    const previousDiagnostics = process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS;
    const previousConsoleError = console.error;
    const diagnosticOutput: string[] = [];
    if (scenario.prospectivePath) {
      process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS = "1";
      console.error = (...values: unknown[]) => {
        diagnosticOutput.push(values.join(" "));
      };
    } else delete process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS;
    const runtime = supervisionRuntime();
    const expectedBinding = {
      ref: "result:researcher#1",
      canonicalRef: resultRef(randomUUID()),
    };
    const assignment = {
      version: 2 as const,
      id: sessionId,
      repoKey: "repo-key",
      branch: "smoke/delivery-placement",
      text: `deliver only in the assigned checkout\n${"evidence\n".repeat(4096)}`,
      resultBindings: [expectedBinding],
    };
    writeProjectAssignment(runtime, assignment);
    writeChiefMessage(
      {
        version: 2,
        id: sessionId,
        leaseId: randomUUID(),
        kind: "project_assignment",
        fromSessionId: managerId,
        toSessionId: sessionId,
        leadSessionId: sessionId,
        branch: assignment.branch,
        text: "Project assignment ready.",
        createdAt: Date.now(),
      },
      runtime,
    );
    const signal = listChiefMessagePaths(runtime, sessionId)
      .map((path) => readChiefMessage(path))
      .find((record) => record.kind === "project_assignment")!;
    assert.ok(Buffer.byteLength(assignment.text, "utf8") > 16 * 1024);
    assert.ok(chiefMessageBytes(signal) <= COORDINATION_MESSAGE_MAX_BYTES);
    assert.equal(signal.text, "Project assignment ready.");
    assert.equal(signal.resultBindings, undefined);
    assert.doesNotMatch(signal.text, /evidence/);
    const agent = {
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind:
          scenario.mismatchedPath || scenario.prospectivePath ? "path" : "id",
        value: scenario.mismatchedPath
          ? join(tmpdir(), `${sessionId}-other.jsonl`)
          : scenario.prospectivePath
            ? sessionPath
            : sessionId,
      },
      workspace_id: scenario.moved ? "sibling-workspace" : "branch-workspace",
      pane_id: "lead-pane",
      tab_id: "lead-tab",
    };
    const manager = {
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "path",
        value: join(tmpdir(), `${managerId}.jsonl`),
      },
      workspace_id: WORKSPACE,
      pane_id: "manager-pane",
      tab_id: "manager-tab",
    };
    const inventory = [manager, agent];
    const entries: unknown[] = [];
    const pi = fakeChiefPi({
      entries,
      exec: (_command, args) => {
        let result: unknown = {};
        if (isApiSnapshot(args))
          result = { snapshot: { agents: inventory, panes: [] } };
        else if (isAgentList(args)) result = { agents: inventory };
        else if (args[0] === "agent" && args[1] === "get") result = { agent };
        else if (args[0] === "workspace" && args[1] === "get")
          result = {
            workspace: {
              worktree: { repo_key: "repo-key", is_linked_worktree: true },
            },
          };
        else if (args[0] === "worktree" && args[1] === "list") {
          result = {
            source: {
              repo_key: "repo-key",
              repo_name: "project",
              source_workspace_id: WORKSPACE,
            },
            worktrees: [
              {
                branch: assignment.branch,
                open_workspace_id: "branch-workspace",
              },
              {
                branch: "smoke/sibling",
                open_workspace_id: "sibling-workspace",
              },
            ],
          };
        }
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result }),
          stderr: "",
          code: 0,
        };
      },
    });
    registerExtension!(pi.pi as never);
    const ctx = fakeContext() as any;
    ctx.sessionManager = {
      ...ctx.sessionManager,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionPath,
    };
    try {
      await pi.events.get("session_start")![0](undefined, ctx);
      await t.waitFor(() =>
        assert.equal(listChiefMessagePaths(runtime, sessionId).length, 0),
      );
      const delivered = pi.sent.filter(
        (message: any) =>
          message.customType === "pi-herdsman-project_assignment",
      );
      assert.equal(
        delivered.length,
        scenario.moved || scenario.mismatchedPath ? 0 : 1,
      );
      if (!scenario.moved && !scenario.mismatchedPath) {
        assert.equal(delivered[0].details.id, sessionId);
        assert.equal(delivered[0].details.branch, assignment.branch);
        assert.ok(delivered[0].content.includes(assignment.branch));
        assert.ok(delivered[0].content.includes(assignment.text));
        assert.ok(Buffer.byteLength(delivered[0].content, "utf8") > 8 * 1024);
        assert.ok(
          delivered[0].content.includes(`${"evidence\n".repeat(4096)}`),
        );
        assert.match(
          delivered[0].content,
          /automatically hands your\s+normal assignment response to the Manager role/,
        );
        assert.equal(delivered[0].content.includes(sessionId), false);
        assert.ok(
          entries.some(
            (entry: any) =>
              entry.customType === "pi-herdsman-result-ref" &&
              entry.data?.canonicalRef === expectedBinding.canonicalRef,
          ),
        );
      }
      if (scenario.prospectivePath) {
        assert.equal(realFs.existsSync(sessionPath), false);
        const diagnosticEvents = diagnosticOutput
          .filter((line) =>
            line.startsWith("[pi-herdsman-manager-diagnostic] "),
          )
          .map((line) =>
            JSON.parse(line.slice("[pi-herdsman-manager-diagnostic] ".length)),
          );
        assert.deepEqual(
          diagnosticEvents.map(({ event }) => event),
          [
            "session_start_reached",
            "initial_inbox_drain_start",
            "inbox_preflight",
            "inbox_preflight_recheck",
            "inbox_candidates",
            "project_assignment_scope_start",
            "project_assignment_scope_complete",
            "project_assignment_topology_start",
            "project_assignment_topology_complete",
            "project_assignment_live_lead_start",
            "project_assignment_live_lead_complete",
            "project_assignment_authorization",
            "project_assignment_send",
            "inbox_peer_presence",
            "inbox_drain_complete",
          ],
        );
        const authorization = diagnosticEvents.find(
          ({ event }) => event === "project_assignment_authorization",
        );
        const send = diagnosticEvents.find(
          ({ event }) => event === "project_assignment_send",
        );
        assert.equal(authorization.outcome, "authorized");
        assert.equal(authorization.reason, "matched");
        assert.equal(send.outcome, "resolved");
        assert.equal(send.triggerTurn, true);
        const diagnostics = diagnosticOutput
          .filter((line) =>
            line.startsWith("[pi-herdsman-manager-diagnostic] "),
          )
          .join("\n");
        assert.equal(diagnostics.includes(sessionId), false);
        assert.equal(diagnostics.includes(assignment.text), false);
        writeFileSync(
          sessionPath,
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/tmp",
          })}\n`,
        );
        assert.equal(realFs.existsSync(sessionPath), true);
      }
      const saved = await pi.tools
        .find((tool) => tool.name === "supervisor_message")!
        .execute(
          "message",
          { message: "Ready for review" },
          undefined,
          undefined,
          ctx,
        );
      assert.match(JSON.stringify(saved), /Project message saved for Manager/);
      assert.equal(
        listProjectMessages(runtime, "repo-key", assignment.branch).length,
        1,
      );
    } finally {
      if (scenario.mismatchedPath) realFs.rmSync(sessionPath, { force: true });
      if (scenario.prospectivePath) {
        realFs.rmSync(sessionPath, { force: true });
        console.error = previousConsoleError;
        if (previousDiagnostics === undefined)
          delete process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS;
        else process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS = previousDiagnostics;
      } else if (previousDiagnostics !== undefined)
        process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS = previousDiagnostics;
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      setLeadEnvironment();
    }
  });

test("Manager retry correlates an ambiguous worktree create by persisted branch", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `delegate-recovery-${randomUUID()}.sock`,
  );
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const childWorkspace = `child-${randomUUID()}`;
  let childSession = "";
  let topologyCreated = false;
  let createCalls = 0;
  let openCalls = 0;
  let started = false;
  let delayReadiness = false;
  let releaseReadiness!: () => void;
  let markReadinessStarted!: () => void;
  const readinessPending = new Promise<void>(
    (resolve) => (releaseReadiness = resolve),
  );
  const readinessStarted = new Promise<void>(
    (resolve) => (markReadinessStarted = resolve),
  );
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
    pane_id: "root-pane",
    tab_id: "root-tab",
  };
  const exec = async (command: string, args: string[]) => {
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          workspace_id: args[2],
          worktree: {
            repo_key: "repo-key",
            is_linked_worktree: args[2] === childWorkspace,
            checkout_path:
              args[2] === childWorkspace
                ? "/tmp/manager-child"
                : "/tmp/manager-root",
          },
        },
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: WORKSPACE,
          repo_key: "repo-key",
          repo_name: "project",
        },
        worktrees: topologyCreated
          ? listProjectAssignments(supervisionRuntime(), "repo-key").map(
              (assignment) => ({
                ...(openCalls || topologyCreated
                  ? { open_workspace_id: childWorkspace }
                  : {}),
                branch: assignment.branch,
                path: "/tmp/manager-child",
              }),
            )
          : [],
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "open") {
      openCalls++;
      assert.deepEqual(args.slice(2), [
        "--workspace",
        WORKSPACE,
        "--branch",
        args[args.indexOf("--branch") + 1],
        "--no-focus",
      ]);
      assert.ok(args.includes("--branch"));
      assert.ok(args.includes("--no-focus"));
      return respond({
        workspace: { workspace_id: childWorkspace },
        tab: { tab_id: "child-tab" },
        root_pane: { pane_id: "child-pane", tab_id: "child-tab" },
        worktree: {
          branch: args[args.indexOf("--branch") + 1],
          path: "/tmp/manager-child",
        },
        already_open: true,
      });
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
      createCalls++;
      topologyCreated = true; // Herdr succeeded, but the response was lost.
      return { stdout: "", stderr: "transport closed", code: 1 };
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "list")
      return respond({
        panes: [
          {
            pane_id: "child-pane",
            workspace_id: childWorkspace,
            tab_id: "child-tab",
            cwd: "/tmp/manager-child",
            terminal_id: "child-terminal",
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
          cwd: "/tmp/manager-child",
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
    if (command === "herdr" && args[0] === "pane" && args[1] === "run") {
      if (delayReadiness) markReadinessStarted();
      return respond({});
    }
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "wait-output"
    ) {
      if (delayReadiness) await readinessPending;
      return respond({});
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      started = true;
      const assignment = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      )[0]!;
      childSession = assignment.id;
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        role: "lead",
        instanceId: randomUUID(),
        piSessionId: childSession,
        updatedAt: Date.now(),
      });
      assert.equal(assignment.branch.length > 0, true);
      return respond({
        agent: {
          name: "lead",
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: childSession,
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
                    kind: "id",
                    value: childSession,
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                },
              ]
            : [],
        },
      });
    if (command === "herdr" && isAgentList(args))
      return respond({
        agents: [
          managerAgent,
          ...(started
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: childSession,
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                },
              ]
            : []),
        ],
      });
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
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const staff = pi.tools.find((tool) => tool.name === "staff_delegate")!;
    const staffResume = pi.tools.find((tool) => tool.name === "staff_resume")!;
    const staffListTool = pi.tools.find((tool) => tool.name === "staff_list")!;
    await assert.rejects(
      staff.execute(
        "delegate",
        {
          branch: "smoke/bootstrap-recovery",
          task: "persist through transport loss",
        },
        undefined,
        undefined,
        ctx,
      ),
      /transport closed/,
    );
    const pending = listProjectAssignments(
      supervisionRuntime(),
      "repo-key",
    )[0]!;
    assert.deepEqual(Object.keys(pending).sort(), [
      "branch",
      "id",
      "repoKey",
      "text",
      "version",
    ]);
    assert.equal(createCalls, 1);
    assert.ok(
      pi.calls.some(
        (args) =>
          args.includes("--base") &&
          args[args.indexOf("--base") + 1] === "HEAD",
      ),
      "creation must use the base persisted before the Herdr mutation",
    );
    const staffList = await staffListTool.execute(
      "list",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.equal(staffList.details.ok, true);
    assert.equal(staffList.details.work[0].branch, pending.branch);
    assert.equal(staffList.details.work[0].status, "paused");
    assert.equal("session" in staffList.details.work[0], false);
    assert.equal("result" in staffList.details.work[0], false);
    assert.equal("workspace_id" in staffList.details.work[0], false);
    assert.equal("pane_id" in staffList.details.work[0], false);
    assert.equal(createCalls, 1, "roster reads must not retry creation");
    assert.equal(
      listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
      pending.id,
    );
    await assert.rejects(
      staff.execute(
        "delegate",
        {
          task: "duplicate branch",
          branch: pending.branch,
        },
        undefined,
        undefined,
        ctx,
      ),
      /Work already exists/,
    );
    {
      await assert.rejects(
        staff.execute(
          "delegate",
          {
            task: "duplicate branch",
            branch: pending.branch,
          },
          undefined,
          undefined,
          ctx,
        ),
        /Work already exists/,
      );
    }
    await assert.rejects(
      staff.execute(
        "delegate",
        {
          task: "independent branch",
          branch: "smoke/manager2",
        },
        undefined,
        undefined,
        ctx,
      ),
      /transport closed/,
    );
    assert.equal(
      listProjectAssignments(supervisionRuntime(), "repo-key").length,
      2,
    );
    delayReadiness = true;
    for (const [field, value] of [
      ["task", "replacement task"],
      ["base", "main"],
    ] as const) {
      await assert.rejects(
        staff.execute(
          "delegate",
          { branch: pending.branch, [field]: value },
          undefined,
          undefined,
          ctx,
        ),
        /Work already exists/,
      );
    }
    const retryPromise = staffResume.execute(
      "resume",
      { branch: pending.branch },
      undefined,
      undefined,
      ctx,
    );
    await Promise.race([
      readinessStarted,
      retryPromise.then(
        () => {
          throw new Error("Startup completed before readiness");
        },
        (error) => {
          throw error;
        },
      ),
    ]);
    assert.equal(
      started,
      false,
      "Manager must wait for the exact pane shell readiness marker",
    );
    releaseReadiness();
    const retry = await retryPromise;
    assert.equal(retry.details.ok, true, JSON.stringify(retry.details));
    assert.equal(retry.details.action, "resume");
    assert.equal(retry.details.branch, pending.branch);
    assert.equal(retry.details.session, childSession);
    assert.equal(createCalls, 2);
    assert.equal(
      listProjectAssignments(supervisionRuntime(), "repo-key").find(
        (item) => item.id === pending.id,
      )?.id,
      pending.id,
    );
    await pi.commandOptions.get("manager").handler("leave", ctx);
    assert.equal(pi.pi.getActiveTools().includes("staff_delegate"), false);
    assert.equal(
      listProjectAssignments(supervisionRuntime(), "repo-key").find(
        (item) => item.id === pending.id,
      )?.id,
      pending.id,
      "Manager leave must retain assignment ownership until completion",
    );

    setLeadEnvironment();
    process.env.HERDR_PANE_ID = "child-pane";
    process.env.HERDR_WORKSPACE_ID = childWorkspace;
    process.env.HERDR_SOCKET_PATH = socketPath;
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      role: "lead",
      instanceId: randomUUID(),
      piSessionId: childSession,
      updatedAt: Date.now(),
    });
    const leadPi = fakeChiefPi({ activeTools: ["read"], exec });
    registerExtension!(leadPi.pi as never);
    const leadContext = fakeContext() as any;
    leadContext.sessionManager = {
      ...leadContext.sessionManager,
      getSessionId: () => childSession,
      getSessionFile: () => `/tmp/${childSession}.jsonl`,
    };
    await leadPi.events.get("session_start")![0](undefined, leadContext);
    const message = await leadPi.tools
      .find((tool) => tool.name === "supervisor_message")!
      .execute(
        "message",
        { message: "Ready for review without Manager" },
        undefined,
        undefined,
        leadContext,
      );
    assert.match(JSON.stringify(message), /Project message saved for Manager/);
    assert.equal(
      listProjectMessages(supervisionRuntime(), "repo-key", pending.branch)[0]
        ?.text,
      "Ready for review without Manager",
    );
    assert.ok(
      listProjectAssignments(supervisionRuntime(), "repo-key").some(
        (item) => item.id === pending.id,
      ),
    );
    await leadPi.events.get("session_shutdown")?.[0]();
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

async function runManagerStartupScenario(
  mode:
    | "success"
    | "missing-state"
    | "missing-herdr-session"
    | "incompatible-build"
    | "staff-message-mismatch"
    | "delayed-herdr-session"
    | "conflict"
    | "managed-agent"
    | "unmaterialized-path"
    | "identity-manager-lost-timeout"
    | "identity-manager-lost-success"
    | "identity-timeout"
    | "identity-zero-byte-timeout"
    | "identity-unproven"
    | "identity-mismatch"
    | "identity-cleanup-mismatch"
    | "identity-ambiguity"
    | "mismatched-session"
    | "recovery"
    | "preexisting"
    | "preexisting-closed"
    | "occupied"
    | "multiple"
    | "invalid-topology"
    | "concurrent"
    | "active-loss"
    | "active-live"
    | "active-live-mismatch"
    | "active-missing"
    | "active-missing-no-session"
    | "active-missing-legacy"
    | "active-missing-ambiguous"
    | "active-closed"
    | "close-resume"
    | "close-failure"
    | "unassigned-close",
  projectTrusted = false,
  t?: TestContext,
  missingPaneCode = "pane_not_found",
  largeEvidence = false,
  limits?: {
    inlineAttachmentLimitBytes?: number;
    mailboxPayloadLimitBytes?: number;
  },
): Promise<void> {
  setLeadEnvironment();
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  const previousConfig = realFs.existsSync(configPath)
    ? realFs.readFileSync(configPath, "utf8")
    : undefined;
  if (limits?.inlineAttachmentLimitBytes !== undefined)
    updateConfig(
      "inlineAttachmentLimitBytes",
      limits.inlineAttachmentLimitBytes,
    );
  if (limits?.mailboxPayloadLimitBytes !== undefined)
    updateConfig("mailboxPayloadLimitBytes", limits.mailboxPayloadLimitBytes);
  const prospective =
    mode === "unmaterialized-path" || mode.startsWith("identity-");
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `delegate-fresh-${randomUUID()}.sock`,
  );
  const childWorkspace = `child-${randomUUID()}`;
  const unrelatedSession = randomUUID();
  const secondSession = randomUUID();
  let childSession = "";
  const childSessionPath = join(tmpdir(), `lead-${randomUUID()}.jsonl`);
  const childPath = "/tmp/manager-fresh-child";
  const attachmentPath = join(tmpdir(), `assignment-${randomUUID()}.md`);
  if (largeEvidence) writeFileSync(attachmentPath, "evidence\n".repeat(4096));
  let recipientIdle = true;
  let created = false;
  let createdBranch = "";
  let shellReady = false;
  let started =
    mode === "recovery" ||
    mode === "active-live" ||
    ["close-resume", "close-failure"].includes(mode);
  let startupObservations = 0;
  let identityObservations = 0;
  let cleanupOwnershipObservations = 0;
  let emptySessionStat: ReturnType<typeof realFs.statSync> | undefined;
  let identityPolled: () => void = () => {};
  const identityPoll = new Promise<void>((resolve) => {
    identityPolled = resolve;
  });
  const originalNow = Date.now;
  const childIdentity = () => ({
    source: "herdr:pi",
    agent: "pi",
    kind: prospective ? "path" : "id",
    value: prospective ? childSessionPath : childSession,
  });
  let createCalls = 0;
  let openCalls = 0;
  let startCalls = 0;
  let worktreeListCalls = 0;
  let invalidTopologyCall = Number.POSITIVE_INFINITY;
  let duplicateWorktree = false;
  const respond = (result: any) => ({
    stdout: JSON.stringify({
      id: AGENT_ID,
      result:
        duplicateWorktree && Array.isArray(result?.worktrees)
          ? { ...result, worktrees: [...result.worktrees, result.worktrees[0]] }
          : result,
    }),
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
    pane_id: "root-pane",
    tab_id: "root-tab",
  };
  const exec = async (command: string, args: string[]) => {
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          workspace_id: args[2],
          worktree: {
            repo_key: "repo-key",
            is_linked_worktree: args[2] === childWorkspace,
            checkout_path:
              args[2] === childWorkspace ? childPath : "/tmp/manager-root",
          },
        },
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
      worktreeListCalls++;
      return respond({
        source:
          mode === "invalid-topology" &&
          worktreeListCalls === invalidTopologyCall
            ? {
                source_workspace_id: "wrong-workspace",
                repo_key: "repo-key",
                repo_name: "project",
              }
            : {
                source_workspace_id: WORKSPACE,
                repo_key: "repo-key",
                repo_name: "project",
              },
        worktrees: [
          "preexisting",
          "preexisting-closed",
          "occupied",
          "multiple",
        ].includes(mode)
          ? [
              {
                branch: "smoke/existing",
                path: childPath,
                ...(["occupied", "multiple"].includes(mode) ||
                (mode.startsWith("preexisting") && openCalls)
                  ? { open_workspace_id: childWorkspace }
                  : {}),
              },
            ]
          : created
            ? (mode === "unassigned-close"
                ? [{ branch: "smoke/unassigned" }]
                : listProjectAssignments(supervisionRuntime(), "repo-key")
              ).map((assignment) => ({
                branch: assignment.branch,
                path: childPath,
                ...(mode === "active-closed" && !openCalls
                  ? {}
                  : { open_workspace_id: childWorkspace }),
              }))
            : [],
      });
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
      createCalls++;
      created = true;
      const branch = args[args.indexOf("--branch") + 1];
      assert.ok(branch);
      if (mode === "active-missing")
        assert.deepEqual(args, [
          "worktree",
          "create",
          "--workspace",
          WORKSPACE,
          "--branch",
          branch,
          "--no-focus",
          "--base",
          branch,
          "--path",
          resolve("/old/exact/worktree"),
        ]);
      if (mode === "active-missing-no-session")
        assert.deepEqual(args, [
          "worktree",
          "create",
          "--workspace",
          WORKSPACE,
          "--branch",
          branch,
          "--no-focus",
          "--base",
          branch,
        ]);
      createdBranch = branch;
      return respond({
        workspace: { workspace_id: childWorkspace },
        tab: { tab_id: "child-tab" },
        root_pane: { pane_id: "child-pane", tab_id: "child-tab" },
        worktree: { branch, path: childPath },
      });
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "open") {
      openCalls++;
      if (
        mode !== "active-closed" &&
        mode !== "preexisting" &&
        mode !== "preexisting-closed" &&
        !["active-loss", "active-live", "recovery"].includes(mode)
      )
        throw new Error("fresh worktree must not be opened again");
      return respond({
        workspace: { workspace_id: childWorkspace },
        tab: { tab_id: "child-tab" },
        root_pane: { pane_id: "child-pane", tab_id: "child-tab" },
        worktree: {
          branch: args[args.indexOf("--branch") + 1],
          path: childPath,
        },
      });
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "list") {
      return respond({
        panes: [
          {
            pane_id: "child-pane",
            workspace_id: childWorkspace,
            tab_id: "child-tab",
            cwd: childPath,
            terminal_id: "child-terminal",
          },
        ],
      });
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "get")
      return respond({
        pane: {
          pane_id:
            mode === "identity-unproven" && identityObservations
              ? "replacement-pane"
              : "child-pane",
          workspace_id: childWorkspace,
          tab_id: "child-tab",
          terminal_id: "child-terminal",
          cwd: childPath,
          ...((["close-resume", "close-failure", "unassigned-close"].includes(
            mode,
          ) ||
            prospective) &&
          started
            ? {
                agent_session: childIdentity(),
              }
            : {}),
        },
      });
    if (command === "herdr" && args[0] === "tab" && args[1] === "list")
      return respond({
        tabs: [{ tab_id: "child-tab", workspace_id: childWorkspace }],
      });
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "process-info"
    ) {
      return respond({
        process_info: {
          pane_id: "child-pane",
          shell_pid: 33,
          foreground_process_group_id:
            started &&
            (["close-resume", "close-failure", "unassigned-close"].includes(
              mode,
            ) ||
              prospective)
              ? 44
              : 33,
          foreground_processes: [
            {
              pid: started ? 44 : 33,
              argv0: started ? "/usr/bin/pi" : "/bin/zsh",
              ...(mode === "missing-state" && started
                ? { cmdline: "x".repeat(10_000) }
                : {}),
            },
          ],
        },
      });
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "read") {
      assert.deepEqual(args, [
        "pane",
        "read",
        "child-pane",
        "--source",
        "recent-unwrapped",
        "--lines",
        "40",
        "--format",
        "text",
        "--raw",
      ]);
      return mode === "missing-state"
        ? { stdout: "", stderr: "read failed", code: 1 }
        : { stdout: "child bootstrap error", stderr: "", code: 0 };
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "run")
      return respond({});
    if (command === "herdr" && args[0] === "agent" && args[1] === "send-keys") {
      if (["close-resume", "close-failure", "unassigned-close"].includes(mode))
        assert.deepEqual(args, [
          "agent",
          "send-keys",
          "child-pane",
          "ctrl+c",
          "ctrl+d",
        ]);
      if (mode === "close-failure") throw new Error("stop refused");
      started = false;
      startupObservations = 0;
      return respond({});
    }
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "wait-output"
    ) {
      shellReady = true;
      return respond({});
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      startCalls++;
      assert.equal(shellReady, true, "agent starts only after shell readiness");
      assert.deepEqual(args.slice(0, 6), [
        "agent",
        "start",
        args[2],
        "--kind",
        "pi",
        "--pane",
      ]);
      assert.equal(args[6], "child-pane");
      const approvalFlag = projectTrusted ? "--approve" : "--no-approve";
      assert.ok(args.includes(approvalFlag));
      assert.equal(
        args.includes(projectTrusted ? "--no-approve" : "--approve"),
        false,
      );
      const starting = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      )[0]!;
      if (largeEvidence) {
        assert.match(starting.text, /<file name=.*>/);
        if (limits?.inlineAttachmentLimitBytes !== undefined) {
          assert.ok(Buffer.byteLength(starting.text, "utf8") < 16 * 1024);
          assert.match(starting.text, /<file name=.* bytes="\d+" \/>/);
          assert.doesNotMatch(starting.text, /evidence\n/);
        } else {
          assert.ok(Buffer.byteLength(starting.text, "utf8") > 16 * 1024);
          assert.match(starting.text, /evidence/);
        }
        assert.match(starting.text, /\nTask:\ndeliver the fresh assignment/);
      }
      childSession = starting.id;
      if (mode === "success") {
        writeFileSync(
          childSessionPath,
          JSON.stringify({ type: "session", id: childSession }),
        );
        nativeSessions.set(childSession, {
          id: childSession,
          path: childSessionPath,
          cwd: childPath,
          entries: [],
        });
      }
      assert.equal(args[args.indexOf("--session-id") + 1], starting.id);
      assert.deepEqual(
        args.slice(
          args.indexOf("--session-id"),
          args.indexOf("--session-id") + 3,
        ),
        ["--session-id", starting.id, approvalFlag],
      );
      assert.deepEqual(Object.keys(starting).sort(), [
        "branch",
        "id",
        ...(["active-missing", "active-missing-legacy"].includes(mode)
          ? ["piSessionFile"]
          : []),
        "repoKey",
        "text",
        "version",
      ]);
      started = true;
      return respond({
        agent: {
          name: "lead",
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: childSession,
          },
        },
      });
    }
    if (command === "herdr" && isApiSnapshot(args)) {
      const currentAssignment = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      )[0];
      if (!childSession && currentAssignment)
        childSession = currentAssignment.id;
      if (started) startupObservations++;
      if (
        started &&
        startupObservations === 3 &&
        !["missing-state", "managed-agent"].includes(mode)
      )
        writeLeadCoordinationState(supervisionRuntime(), {
          version: 1,
          role: mode === "conflict" ? "manager" : "lead",
          ...(mode === "incompatible-build"
            ? { build: OTHER_HERDSMAN_BUILD }
            : {}),
          instanceId: randomUUID(),
          piSessionId: childSession,
          updatedAt: Date.now(),
        });
      if (mode === "managed-agent" && started && startupObservations === 2) {
        const identity = {
          paneId: "child-pane",
          tabId: "child-tab",
          piSessionId: childSession,
          piSessionFile: `/tmp/${childSession}.jsonl`,
        };
        writeAgentState(
          agentMailboxPath(WORKSPACE, "managed-child"),
          managedState("managed-child", undefined, identity),
        );
      }
      if (
        ["missing-state", "missing-herdr-session"].includes(mode) &&
        started &&
        startupObservations === 2
      ) {
        const now = Date.now.bind(Date);
        Date.now = () => now() + 60_000;
      }
      return respond({
        snapshot: {
          panes: [],
          agents: ["occupied", "multiple"].includes(mode)
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: unrelatedSession,
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                },
                ...(mode === "multiple"
                  ? [
                      {
                        agent_session: {
                          source: "herdr:pi",
                          agent: "pi",
                          kind: "id",
                          value: secondSession,
                        },
                        workspace_id: childWorkspace,
                        pane_id: "child-pane",
                        tab_id: "child-tab",
                      },
                    ]
                  : []),
              ]
            : started &&
                startupObservations >= 2 &&
                mode !== "missing-herdr-session"
              ? [
                  {
                    agent_session:
                      mode === "delayed-herdr-session" &&
                      startupObservations === 2
                        ? undefined
                        : prospective
                          ? {
                              source: "herdr:pi",
                              agent: "pi",
                              kind: "path",
                              value: childSessionPath,
                            }
                          : {
                              source: "herdr:pi",
                              agent: "pi",
                              kind: "id",
                              value:
                                mode === "mismatched-session"
                                  ? randomUUID()
                                  : childSession,
                            },
                    workspace_id: childWorkspace,
                    pane_id: "child-pane",
                    tab_id: "child-tab",
                    cwd: childPath,
                  },
                ]
              : [],
        },
      });
    }
    if (command === "herdr" && isAgentList(args)) {
      const delivered =
        childSession &&
        listChiefMessagePaths(supervisionRuntime(), childSession).some(
          (path) => readChiefMessage(path).kind === "project_assignment",
        );
      if (prospective && delivered && started) {
        identityObservations++;
        if (
          mode.startsWith("identity-manager-lost-") &&
          identityObservations === 1
        ) {
          assert.equal(realFs.existsSync(childSessionPath), false);
          const descriptorPath = managerDescriptorPath(
            supervisionRuntime(),
            WORKSPACE,
          );
          realFs.unlinkSync(descriptorPath);
          realFs.rmSync(`${descriptorPath}.lock`, { recursive: true });
        }
        if (mode === "unmaterialized-path" && identityObservations === 2)
          identityPolled();
        if (
          mode === "identity-zero-byte-timeout" &&
          identityObservations === 1
        ) {
          assert.equal(realFs.existsSync(childSessionPath), false);
          realFs.writeFileSync(childSessionPath, "");
          emptySessionStat = realFs.statSync(childSessionPath);
        }
        if (
          [
            "identity-timeout",
            "identity-zero-byte-timeout",
            "identity-unproven",
            "identity-mismatch",
            "identity-cleanup-mismatch",
            "identity-manager-lost-timeout",
          ].includes(mode)
        )
          Date.now = () => originalNow() + 60_000;
        if (
          mode === "identity-mismatch" ||
          mode === "identity-ambiguity" ||
          (mode === "identity-manager-lost-success" &&
            identityObservations === 2)
        ) {
          realFs.writeFileSync(
            childSessionPath,
            JSON.stringify({
              type: "session",
              id:
                mode === "identity-mismatch" ? unrelatedSession : childSession,
            }),
          );
          nativeSessions.set(childSession, {
            id: mode === "identity-mismatch" ? unrelatedSession : childSession,
            path: childSessionPath,
            cwd: childPath,
            entries: [],
          });
        }
      }
      return respond({
        agents: [
          managerAgent,
          ...(["occupied", "multiple"].includes(mode)
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: unrelatedSession,
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                },
              ]
            : []),
          ...(mode === "multiple"
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: secondSession,
                  },
                  workspace_id: childWorkspace,
                  pane_id: "second-pane",
                  tab_id: "child-tab",
                },
              ]
            : []),
          ...(mode === "active-live" ||
          mode === "active-live-mismatch" ||
          (started && startupObservations >= 3) ||
          (["close-resume", "close-failure", "unassigned-close"].includes(
            mode,
          ) &&
            started)
            ? Array.from(
                { length: mode === "identity-ambiguity" && delivered ? 2 : 1 },
                () => ({
                  agent_session: childIdentity(),
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                  cwd: childPath,
                }),
              )
            : []),
        ],
      });
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
      if (
        mode === "identity-cleanup-mismatch" &&
        identityObservations &&
        ++cleanupOwnershipObservations === 1
      ) {
        assert.equal(realFs.existsSync(childSessionPath), false);
        realFs.writeFileSync(
          childSessionPath,
          JSON.stringify({
            type: "session",
            id: unrelatedSession,
          }),
        );
        nativeSessions.set(childSession, {
          id: unrelatedSession,
          path: childSessionPath,
          cwd: childPath,
          entries: [],
        });
      }
      return respond({
        agent:
          args[2] === "lead" || args[2] === "child-pane"
            ? {
                workspace_id: childWorkspace,
                pane_id: "child-pane",
                tab_id: "child-tab",
                cwd: childPath,
                agent_session: childIdentity(),
              }
            : managerAgent,
      });
    }
    return respond({});
  };
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec,
  });
  registerExtension!(pi.pi as never);
  try {
    const activeBranch: any[] = pi.entries;
    const ctx = fakeContext(pi.entries, activeBranch) as any;
    ctx.isIdle = () => recipientIdle;
    if (["occupied", "multiple"].includes(mode))
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        role: "lead",
        instanceId: randomUUID(),
        piSessionId: unrelatedSession,
        updatedAt: Date.now(),
      });
    if (mode === "multiple")
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        role: "lead",
        instanceId: randomUUID(),
        piSessionId: secondSession,
        updatedAt: Date.now(),
      });
    ctx.isProjectTrusted = () => projectTrusted;
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const staff = pi.tools.find((tool) => tool.name === "staff_delegate")!;
    const staffResume = pi.tools.find((tool) => tool.name === "staff_resume")!;
    const staleId = randomUUID();
    const activeMode = [
      "active-loss",
      "active-live",
      "active-live-mismatch",
      "active-missing",
      "active-missing-no-session",
      "active-missing-legacy",
      "active-missing-ambiguous",
      "active-closed",
      "close-resume",
      "close-failure",
    ].includes(mode);
    const resumeMode = activeMode || mode === "invalid-topology";
    if (activeMode) {
      childSession = staleId;
      created = ![
        "active-missing",
        "active-missing-no-session",
        "active-missing-legacy",
        "active-missing-ambiguous",
      ].includes(mode);
      if (created) createdBranch = "smoke/recover";
      writeProjectAssignment(supervisionRuntime(), {
        version: 2,
        id: staleId,
        repoKey: "repo-key",
        branch: "smoke/recover",
        text: "  recover\n exact Lead  ",
        ...(mode === "active-missing"
          ? { piSessionFile: `/tmp/${staleId}.jsonl` }
          : {}),
      });
      if (mode === "active-missing")
        nativeSessions.set(staleId, {
          id: staleId,
          path: `/tmp/${staleId}.jsonl`,
          cwd: "/old/exact/worktree",
          entries: [],
        });
      if (
        ["active-missing-legacy", "active-missing-ambiguous"].includes(mode)
      ) {
        writeFileSync(
          childSessionPath,
          JSON.stringify({ type: "session", id: staleId }),
        );
        nativeSessions.set(staleId, {
          id: staleId,
          path: childSessionPath,
          cwd: "/old/exact/worktree",
          entries: [],
        });
        if (mode === "active-missing-ambiguous") {
          const duplicatePath = `${childSessionPath}.duplicate`;
          writeFileSync(
            duplicatePath,
            JSON.stringify({ type: "session", id: staleId }),
          );
          nativeSessions.set(`${staleId}-duplicate`, {
            id: staleId,
            path: duplicatePath,
            cwd: "/old/exact/worktree",
            entries: [],
          });
        }
      }
      if (mode === "active-live") {
        writeFileSync(
          childSessionPath,
          JSON.stringify({ type: "session", id: staleId }),
        );
        nativeSessions.set(staleId, {
          id: staleId,
          path: childSessionPath,
          cwd: childPath,
          entries: [],
        });
      }
      if (mode === "active-live" || mode === "active-live-mismatch")
        writeLeadCoordinationState(supervisionRuntime(), {
          version: 1,
          role: "lead",
          instanceId: randomUUID(),
          piSessionId: staleId,
          ...(mode === "active-live-mismatch"
            ? { build: OTHER_HERDSMAN_BUILD }
            : {}),
          updatedAt: Date.now(),
        });
      if (["close-resume", "close-failure"].includes(mode))
        writeLeadCoordinationState(supervisionRuntime(), {
          version: 1,
          role: "lead",
          instanceId: randomUUID(),
          piSessionId: staleId,
          updatedAt: Date.now(),
        });
    }
    if (mode === "invalid-topology")
      writeProjectAssignment(supervisionRuntime(), {
        version: 2,
        id: staleId,
        repoKey: "repo-key",
        branch: "smoke/vanished",
        text: "recover vanished placement",
      });
    const execute = () => (
      (invalidTopologyCall = worktreeListCalls + 4),
      (resumeMode ? staffResume : staff).execute(
        resumeMode ? "resume" : "delegate",
        resumeMode
          ? {
              branch:
                mode === "invalid-topology"
                  ? "smoke/vanished"
                  : "smoke/recover",
            }
          : {
              ...(!["invalid-topology"].includes(mode) && !activeMode
                ? {
                    task:
                      limits?.mailboxPayloadLimitBytes !== undefined
                        ? "x".repeat(2048)
                        : "deliver the fresh assignment",
                    ...(largeEvidence ? { files: [attachmentPath] } : {}),
                  }
                : {}),
              ...([
                "preexisting",
                "preexisting-closed",
                "occupied",
                "multiple",
              ].includes(mode)
                ? { branch: "smoke/existing" }
                : {}),
              ...(mode === "concurrent" ? { branch: "smoke/concurrent" } : {}),
              ...(mode === "invalid-topology"
                ? { branch: "smoke/vanished" }
                : activeMode
                  ? { branch: "smoke/recover" }
                  : {}),
            },
        undefined,
        undefined,
        ctx,
      )
    );
    if (limits?.mailboxPayloadLimitBytes !== undefined) {
      await assert.rejects(execute(), /Mailbox payload is .* configured limit/);
      assert.equal(createCalls, 0);
      assert.equal(startCalls, 0);
      assert.deepEqual(
        listProjectAssignments(supervisionRuntime(), "repo-key"),
        [],
      );
      return;
    }
    if (mode === "unassigned-close") {
      childSession = staleId;
      created = true;
      started = true;
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        role: "lead",
        instanceId: randomUUID(),
        piSessionId: staleId,
        updatedAt: Date.now(),
      });
      assert.deepEqual(
        listProjectAssignments(supervisionRuntime(), "repo-key"),
        [],
      );
      const closed = await pi.tools
        .find((tool) => tool.name === "staff_stop")!
        .execute("close", { session: staleId }, undefined, undefined, ctx);
      assert.equal(closed.details.ok, true);
      assert.equal(closed.details.session, staleId);
      assert.equal("branch" in closed.details, false);
      assert.equal(started, false);
      const liveAgents = JSON.parse(
        (await exec("herdr", ["agent", "list"])).stdout,
      ).result.agents;
      assert.equal(
        liveAgents.some((agent: any) => agent.agent_session?.value === staleId),
        false,
      );
      assert.deepEqual(
        listProjectAssignments(supervisionRuntime(), "repo-key"),
        [],
      );
      const paneList = JSON.parse(
        (await exec("herdr", ["pane", "list"])).stdout,
      ).result.panes;
      assert.ok(paneList.some((pane: any) => pane.pane_id === "child-pane"));
      const worktreeList = JSON.parse(
        (await exec("herdr", ["worktree", "list"])).stdout,
      ).result.worktrees;
      assert.ok(
        worktreeList.some(
          (worktree: any) =>
            worktree.branch === "smoke/unassigned" &&
            worktree.path === childPath,
        ),
      );
      return;
    }
    if (activeMode) {
      if (mode === "active-live-mismatch") {
        await assert.rejects(execute(), (error: any) => {
          assert.equal(error.detail.category, "incompatible_build");
          assert.equal(error.detail.operation, "staff_resume");
          return true;
        });
        return;
      }
      if (mode === "active-live") {
        const running = await execute();
        assert.equal(running.details.action, "resume");
        assert.equal(running.details.already_running, true);
        assert.equal(running.details.session, staleId);
        assert.equal(running.details.presentation_task, "recover exact Lead");
        assert.doesNotMatch(
          (running.content[0] as { text: string }).text,
          /presentation_task/,
        );
        const messages = () =>
          listChiefMessagePaths(supervisionRuntime(), staleId)
            .map((path) => readChiefMessage(path))
            .filter((message) => message.kind === "project_assignment");
        assert.deepEqual(
          messages().map((message) => message.id),
          [staleId],
        );
        const delivered: any[] = [];
        const entries: any[] = [];
        const drain = () =>
          drainCoordinationInbox({
            runtime: supervisionRuntime(),
            sessionId: staleId,
            isAuthorized: (record) =>
              record.kind === "project_assignment" && record.id === staleId,
            isDelivered: (id) =>
              entries.some(
                (entry) =>
                  entry?.customType?.startsWith?.("pi-herdsman-") &&
                  entry?.details?.id === id,
              ),
            sendMessage: (message) => delivered.push(message),
          });
        assert.equal(await drain(), 1);
        assert.equal(delivered[0].customType, "pi-herdsman-project_assignment");
        assert.equal(delivered[0].details.id, staleId);
        entries.push(delivered[0]);
        const stillRunning = await execute();
        assert.equal(stillRunning.details.action, "resume");
        assert.equal(stillRunning.details.already_running, true);
        const assignment = listProjectAssignments(
          supervisionRuntime(),
          "repo-key",
        )[0]!;
        assert.equal(
          assignment.piSessionFile,
          realFs.realpathSync(childSessionPath),
        );
        assert.deepEqual(
          messages().map((message) => message.id),
          [staleId],
        );
        assert.equal(await drain(), 0);
        assert.equal(delivered.length, 1);
        const conflictingPath = join(tmpdir(), `conflicting-${staleId}.jsonl`);
        writeFileSync(conflictingPath, "");
        writeProjectAssignment(supervisionRuntime(), {
          ...assignment,
          piSessionFile: conflictingPath,
        });
        await assert.rejects(
          execute(),
          /conflicts with persisted project identity/,
        );
        realFs.rmSync(conflictingPath, { force: true });
      } else if (["close-resume", "close-failure"].includes(mode)) {
        const control = (name: string, value: unknown) =>
          pi.tools
            .find((tool) => tool.name === name)!
            .execute(name, value, undefined, undefined, ctx);
        if (mode === "close-failure") {
          await assert.rejects(control("staff_stop", { session: staleId }));
          assert.equal(
            listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
            staleId,
          );
        } else if (mode === "close-resume") {
          const closed = await control("staff_stop", { session: staleId });
          assert.equal(closed.details.branch, "smoke/recover");
          assert.equal(
            listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
            staleId,
          );
          assert.equal(started, false);
          assert.equal(created, true);
          assert.ok(
            JSON.parse(
              (await exec("herdr", ["pane", "list"])).stdout,
            ).result.panes.some((pane: any) => pane.pane_id === "child-pane"),
          );
          started = true;
          const resumed = await execute();
          assert.equal(resumed.details.action, "resume");
          assert.equal(resumed.details.session, staleId);
          assert.equal(
            listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
            staleId,
          );
        }
        return;
      } else if (mode === "active-missing-ambiguous") {
        await assert.rejects(execute(), /ambiguous/);
        assert.equal(createCalls, 0);
        assert.equal(startCalls, 0);
        assert.equal(
          listProjectAssignments(supervisionRuntime(), "repo-key")[0]
            ?.piSessionFile,
          undefined,
        );
        return;
      } else if (
        [
          "active-missing",
          "active-missing-no-session",
          "active-missing-legacy",
        ].includes(mode)
      ) {
        const { SessionManager } =
          await import("@earendil-works/pi-coding-agent");
        const originalListAll = SessionManager.listAll;
        let resumed: any;
        if (mode === "active-missing") {
          SessionManager.listAll = async () => {
            throw new Error(
              "global inventory must not be used for exact resume",
            );
          };
        }
        try {
          resumed = await execute();
        } finally {
          SessionManager.listAll = originalListAll;
        }
        assert.equal(resumed.details.action, "resume");
        assert.equal(resumed.details.session, staleId);
        assert.equal(resumed.details.branch, "smoke/recover");
        assert.equal(createCalls, 1);
        assert.equal(startCalls, 1);
        assert.equal(
          listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
          staleId,
        );
        if (["active-missing", "active-missing-legacy"].includes(mode))
          assert.equal(
            listProjectAssignments(supervisionRuntime(), "repo-key")[0]
              ?.piSessionFile,
            mode === "active-missing"
              ? `/tmp/${staleId}.jsonl`
              : realFs.realpathSync(childSessionPath),
          );
        if (mode === "active-missing-legacy") {
          created = false;
          started = false;
          startupObservations = 0;
          const originalListAll = SessionManager.listAll;
          SessionManager.listAll = async () => {
            throw new Error("self-healed resume must not use global inventory");
          };
          try {
            const resumedAgain = await execute();
            assert.equal(resumedAgain.details.action, "resume");
          } finally {
            SessionManager.listAll = originalListAll;
          }
          assert.equal(createCalls, 2);
          assert.equal(startCalls, 2);
        }
      } else {
        const recovered = await execute();
        assert.equal(recovered.details.action, "resume");
        assert.equal(recovered.details.session, staleId);
        assert.equal(recovered.details.branch, "smoke/recover");
        assert.equal(recovered.details.presentation_task, "recover exact Lead");
        assert.doesNotMatch(
          (recovered.content[0] as { text: string }).text,
          /presentation_task/,
        );
        const persisted = listProjectAssignments(
          supervisionRuntime(),
          "repo-key",
        )[0];
        assert.equal(persisted?.id, staleId);
      }
      assert.equal(
        createCalls,
        [
          "active-missing",
          "active-missing-no-session",
          "active-missing-legacy",
          "active-missing-ambiguous",
        ].includes(mode) && mode !== "active-missing-ambiguous"
          ? mode === "active-missing-legacy"
            ? 2
            : 1
          : 0,
      );
      assert.equal(
        startCalls,
        [
          "active-loss",
          "active-closed",
          "active-missing",
          "active-missing-no-session",
          "active-missing-legacy",
          "active-missing-ambiguous",
        ].includes(mode)
          ? mode === "active-missing-legacy"
            ? 2
            : 1
          : 0,
      );
      assert.equal(
        openCalls,
        ["active-closed", "active-loss"].includes(mode) ? 1 : 0,
      );
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key").length,
        1,
      );
      if (mode === "active-live") {
        const { SelectList } = await import("@earendil-works/pi-tui");
        let renderedList: any;
        t!.mock.method(SelectList.prototype, "render", function (this: any) {
          renderedList = this;
          return this.items.map((item: any) =>
            [item.label, item.description].filter(Boolean).join(" · "),
          );
        });
        const components: any[] = [];
        ctx.hasUI = true;
        ctx.ui.custom = async (factory: any) => {
          components.push(
            factory(
              { requestRender: () => undefined },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              () => undefined,
            ),
          );
        };
        await pi.events.get("before_agent_start")![0](
          { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
          ctx,
        );
        await pi.commandOptions.get("manager").handler("", ctx);
        const overview = components[0];
        const initial = overview.render(120).join("\n");
        assert.match(initial, /smoke\/recover · active · unknown/);
        duplicateWorktree = true;
        await pi.events.get("before_agent_start")![0](
          {
            systemPrompt: "base",
            systemPromptOptions: { contextFiles: [] },
          },
          ctx,
        );
        assert.match(
          overview.render(120).join("\n"),
          /conflict · project runtime identity is ambiguous/,
        );
        overview.handleInput("\r");
        await t!.waitFor(() => assert.equal(components.length, 2));
        assert.doesNotMatch(
          components[1].render(120).join("\n"),
          /Discard work|Complete work/,
        );
      }
      return;
    }
    if (mode === "concurrent") {
      const results = await Promise.allSettled([execute(), execute()]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter(
          (result) =>
            result.status === "rejected" &&
            /Work already exists/.test(String(result.reason)),
        ).length,
        1,
      );
      assert.equal(createCalls, 1);
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key").length,
        1,
      );
      return;
    }
    if (mode === "missing-state" || mode === "missing-herdr-session") {
      const now = Date.now.bind(Date);
      try {
        await assert.rejects(execute(), (error: Error) => {
          assert.match(
            error.message,
            /Timed out verifying the new Lead session/,
          );
          assert.match(
            error.message,
            mode === "missing-state"
              ? /Herdr session reported, but Herdsman Lead coordination state was never published/
              : /Pi process seen in the exact pane, but Herdr never reported a Pi session identity/,
          );
          if (mode === "missing-state")
            assert.match(error.message, /shell_pid/);
          else assert.match(error.message, /child bootstrap error/);
          assert.ok(error.message.length <= 4_096);
          return true;
        });
      } finally {
        Date.now = now;
      }
      const assignment = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      )[0]!;
      assert.equal(assignment.id, childSession);
      assert.equal(createCalls, 1);
      assert.equal(startCalls, 1);
      assert.equal(started, true);
      assert.equal(startupObservations, 2);
      return;
    }
    if (mode === "incompatible-build") {
      await assert.rejects(
        execute(),
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
      const assignment = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      )[0]!;
      assert.equal(assignment.id, childSession);
      assert.deepEqual(Object.keys(assignment).sort(), [
        "branch",
        "id",
        "repoKey",
        "text",
        "version",
      ]);
      assert.equal(
        listChiefMessagePaths(supervisionRuntime(), childSession)
          .map((path) => readChiefMessage(path))
          .some((message) => message.text === "Project assignment ready."),
        false,
      );
      return;
    }
    if (mode === "preexisting" || mode === "preexisting-closed") {
      await execute();
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key").length,
        1,
      );
      assert.equal(createCalls, 0);
      assert.equal(startCalls, 1);
      assert.equal(openCalls, 1);
      return;
    }
    if (mode === "occupied") {
      await assert.rejects(
        execute(),
        new RegExp(`already has live Lead session ${unrelatedSession}`),
      );
      assert.deepEqual(
        listProjectAssignments(supervisionRuntime(), "repo-key"),
        [],
      );
      assert.equal(startCalls, 0);
      return;
    }
    if (mode === "multiple") {
      await assert.rejects(execute(), /multiple live Leads/);
      assert.deepEqual(
        listProjectAssignments(supervisionRuntime(), "repo-key"),
        [],
      );
      return;
    }
    if (mode === "invalid-topology") {
      await assert.rejects(execute(), /topology is not authoritative/);
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key").length,
        1,
      );
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
        staleId,
      );
      assert.equal(createCalls, 0);
      assert.equal(startCalls, 0);
      return;
    }
    if (mode.startsWith("identity-")) {
      await assert.rejects(
        execute(),
        mode.startsWith("identity-manager-lost-")
          ? /Manager changed during project activation/
          : mode === "identity-ambiguity"
            ? /identity became ambiguous/
            : /identity did not materialize; assignment preserved/,
      );
      const assignment = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      )[0]!;
      assert.deepEqual(Object.keys(assignment).sort(), [
        "branch",
        "id",
        "repoKey",
        "text",
        "version",
      ]);
      if (mode.startsWith("identity-manager-lost-")) {
        assert.equal(assignment.id, childSession);
        assert.equal(created, true);
        assert.equal(
          realFs.existsSync(childSessionPath),
          mode === "identity-manager-lost-success",
        );
        if (mode === "identity-manager-lost-success")
          assert.equal(nativeSessions.get(childSession)?.id, childSession);
      }
      assert.equal(
        listChiefMessagePaths(supervisionRuntime(), childSession).length,
        1,
      );
      if (mode === "identity-cleanup-mismatch") {
        assert.equal(cleanupOwnershipObservations, 1);
        assert.equal(realFs.existsSync(childSessionPath), true);
        assert.equal(nativeSessions.get(childSession)?.id, unrelatedSession);
        assert.equal(assignment.id, childSession);
        assert.equal(created, true);
        assert.equal(createCalls, 1);
        assert.equal(startCalls, 1);
      }
      if (mode === "identity-zero-byte-timeout") {
        assert.deepEqual(
          realFs.readFileSync(childSessionPath),
          Buffer.alloc(0),
        );
        const stat = realFs.statSync(childSessionPath);
        assert.equal(stat.size, 0);
        assert.equal(stat.mtimeMs, emptySessionStat!.mtimeMs);
        assert.equal(stat.ino, emptySessionStat!.ino);
        assert.equal(assignment.id, childSession);
      }
      const stopped =
        mode === "identity-timeout" || mode === "identity-zero-byte-timeout";
      assert.equal(started, !stopped);
      assert.equal(
        pi.calls.some(
          (args) =>
            args[0] === "worktree" && ["delete", "remove"].includes(args[1]),
        ),
        false,
      );
      assert.equal(
        pi.calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
        stopped,
      );
      return;
    }
    if (
      mode === "conflict" ||
      mode === "managed-agent" ||
      mode === "mismatched-session"
    )
      await assert.rejects(
        execute(),
        mode === "mismatched-session"
          ? /Herdr session identity does not match the Manager assignment/
          : /conflicting role or identity/,
      );
    else {
      const delegation = execute();
      if (mode === "unmaterialized-path") {
        let settled = false;
        void delegation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.race([
          identityPoll,
          delegation.then(() => {
            throw new Error("Delegation returned before identity materialized");
          }),
        ]);
        assert.equal(settled, false);
        assert.equal(realFs.existsSync(childSessionPath), false);
        realFs.writeFileSync(
          childSessionPath,
          JSON.stringify({
            type: "session",
            id: childSession,
          }),
        );
        nativeSessions.set(childSession, {
          id: childSession,
          path: childSessionPath,
          cwd: childPath,
          entries: [],
        });
      }
      const result = await delegation;
      assert.equal(result.details.ok, true);
      assert.equal(result.details.action, "delegate");
      assert.equal(result.details.session, childSession);
    }
    const assignment = listProjectAssignments(
      supervisionRuntime(),
      "repo-key",
    )[0]!;
    assert.deepEqual(Object.keys(assignment).sort(), [
      "branch",
      "id",
      ...(["success", "unmaterialized-path"].includes(mode)
        ? ["piSessionFile"]
        : []),
      "repoKey",
      "text",
      "version",
    ]);
    if (["success", "unmaterialized-path"].includes(mode))
      assert.equal(
        assignment.piSessionFile,
        realFs.realpathSync(childSessionPath),
      );
    assert.equal(createCalls, 1);
    assert.equal(startCalls, mode === "recovery" ? 0 : 1);
    assert.equal(openCalls, 0);
    assert.equal(
      startupObservations,
      mode === "managed-agent" ? 2 : startupObservations,
    );
    assert.equal(started, true);
    if (mode === "staff-message-mismatch") {
      const state = readLeadCoordinationState(
        supervisionRuntime(),
        childSession,
      )!;
      writeLeadCoordinationState(supervisionRuntime(), {
        ...state,
        build: OTHER_HERDSMAN_BUILD,
        updatedAt: Date.now(),
      });
      const staffMessage = pi.tools.find(
        (tool) => tool.name === "staff_message",
      )!;
      await assert.rejects(
        staffMessage.execute(
          "message",
          { session: childSession, message: "MISMATCH_MUST_NOT_PUBLISH" },
          undefined,
          undefined,
          ctx,
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
      assert.equal(
        listChiefMessagePaths(supervisionRuntime(), childSession)
          .map((path) => readChiefMessage(path))
          .some((message) => message.text === "MISMATCH_MUST_NOT_PUBLISH"),
        false,
      );
      return;
    }
    if (mode === "success") {
      const createCallsBeforeDuplicate = createCalls;
      await assert.rejects(
        staff.execute(
          "delegate",
          {
            task: "duplicate active branch",
            branch: assignment.branch,
          },
          undefined,
          undefined,
          ctx,
        ),
        /Work already exists.*staff_resume/,
      );
      assert.equal(createCalls, createCallsBeforeDuplicate);
      const assignmentsBeforeMissingResume = listProjectAssignments(
        supervisionRuntime(),
        "repo-key",
      );
      const startsBeforeMissingResume = startCalls;
      const createsBeforeMissingResume = createCalls;
      await assert.rejects(
        staffResume.execute(
          "resume",
          { branch: "smoke/missing" },
          undefined,
          undefined,
          ctx,
        ),
        /No existing work.*staff_delegate/,
      );
      assert.deepEqual(
        listProjectAssignments(supervisionRuntime(), "repo-key"),
        assignmentsBeforeMissingResume,
      );
      assert.equal(createCalls, createsBeforeMissingResume);
      assert.equal(startCalls, startsBeforeMissingResume);
      await assert.rejects(
        staff.execute(
          "delegate",
          {
            task: "distinct branch but same Lead",
            branch: "smoke/other-lead",
          },
          undefined,
          undefined,
          ctx,
        ),
        /already has live Lead session/,
      );
      assert.equal(createCalls, 2);
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key").filter(
          (item) => item.id === childSession,
        ).length,
        1,
      );
      const messages = listChiefMessagePaths(
        supervisionRuntime(),
        childSession,
      ).map((path) => readChiefMessage(path));
      assert.ok(
        messages.some(
          (message) =>
            message.kind === "project_assignment" &&
            message.id === childSession &&
            message.leadSessionId === childSession &&
            message.branch === assignment.branch &&
            !message.text.includes(childSession) &&
            chiefMessageBytes(message) <= COORDINATION_MESSAGE_MAX_BYTES &&
            message.text === "Project assignment ready.",
        ),
      );
    }
    if (mode === "unmaterialized-path") {
      assert.equal(realFs.existsSync(childSessionPath), true);
      assert.equal(assignment.id, childSession);
      const closed = await pi.tools
        .find((tool) => tool.name === "staff_stop")!
        .execute("close", { session: childSession }, undefined, undefined, ctx);
      assert.equal(closed.details.ok, true);
      assert.equal(started, false);
      assert.equal(
        listProjectAssignments(supervisionRuntime(), "repo-key")[0]?.id,
        childSession,
      );
    }
  } finally {
    realFs.rmSync(attachmentPath, { force: true });
    if (previousConfig !== undefined)
      realFs.writeFileSync(configPath, previousConfig);
    else realFs.rmSync(configPath, { force: true });
    Date.now = originalNow;
    nativeSessions.delete(childSession);
    nativeSessions.delete(`${childSession}-duplicate`);
    realFs.rmSync(childSessionPath, { force: true });
    realFs.rmSync(`${childSessionPath}.duplicate`, { force: true });
    support.sessionOpenError = undefined;
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
}

test("Manager activates only after mocked Lead-state publication", () =>
  runManagerStartupScenario("success"));
test("Manager preserves project assignment and skips notification for incompatible Lead", () =>
  runManagerStartupScenario("incompatible-build"));
test("Manager staff message does not publish to incompatible Lead", () =>
  runManagerStartupScenario("staff-message-mismatch"));
test("Manager delegates large attachment evidence outside coordination limits", () =>
  runManagerStartupScenario(
    "success",
    false,
    undefined,
    "pane_not_found",
    true,
  ));
test("Manager keeps attachments above the inline limit as references", () =>
  runManagerStartupScenario(
    "success",
    false,
    undefined,
    "pane_not_found",
    true,
    {
      inlineAttachmentLimitBytes: 1024,
    },
  ));
test("Manager rejects over-limit assignments before creating work", () =>
  runManagerStartupScenario(
    "success",
    false,
    undefined,
    "pane_not_found",
    false,
    {
      mailboxPayloadLimitBytes: 1024,
    },
  ));
test("trusted Manager starts its Lead with approval and the assignment session ID", () =>
  runManagerStartupScenario("success", true));
test("untrusted Manager starts its Lead without approval and with the assignment session ID", () =>
  runManagerStartupScenario("success", false));
test("Manager distinguishes Herdr identity and Lead-state bootstrap timeouts", () =>
  runManagerStartupScenario("missing-state"));
test("Manager reports Pi process without a Herdr session identity", () =>
  runManagerStartupScenario("missing-herdr-session"));
test("Manager waits for a delayed Herdr session identity", () =>
  runManagerStartupScenario("delayed-herdr-session"));
test("Manager startup rejects conflicting role promptly", () =>
  runManagerStartupScenario("conflict"));
test("Manager startup rejects managed Agent identity without Lead state", () =>
  runManagerStartupScenario("managed-agent"));
test("Manager waits for prospective Lead identity to materialize before success and immediate close", () =>
  runManagerStartupScenario("unmaterialized-path"));
for (const mode of [
  "identity-manager-lost-timeout",
  "identity-manager-lost-success",
] as const)
  test(`Manager rechecks authority after assignment publication on ${mode}`, () =>
    runManagerStartupScenario(mode));
for (const mode of [
  "identity-timeout",
  "identity-zero-byte-timeout",
  "identity-unproven",
  "identity-mismatch",
  "identity-cleanup-mismatch",
  "identity-ambiguity",
] as const)
  test(`Manager preserves assignment and fails closed on ${mode}`, () =>
    runManagerStartupScenario(mode));
test("Manager rejects a resolvable Herdr session ID that differs from its assignment", () =>
  runManagerStartupScenario("mismatched-session"));
test("Manager recovery waits on existing exact Pi without restarting it", () =>
  runManagerStartupScenario("recovery"));
for (const [mode, label] of [
  ["active-loss", "relaunches the exact lost Lead"],
  ["active-live", "returns a live exact Lead idempotently"],
  [
    "active-missing",
    "resumes from the persisted exact session without global lookup",
  ],
  [
    "active-missing-legacy",
    "self-heals a pathless assignment from one legacy session",
  ],
  [
    "active-missing-ambiguous",
    "preserves a pathless assignment with ambiguous legacy sessions",
  ],
  [
    "active-missing-no-session",
    "reconstructs a vanished worktree without saved Pi cwd",
  ],
  ["active-closed", "reopens a closed worktree workspace"],
] as const)
  test(`Manager ${label}`, (t) => runManagerStartupScenario(mode, false, t));
test("Manager stop preserves the exact assignment and resumes its session", () =>
  runManagerStartupScenario("close-resume"));
test("Manager retains assignment when exact Lead stop fails", () =>
  runManagerStartupScenario("close-failure"));
test("Manager resume reports incompatible Lead builds as staff_resume", () =>
  runManagerStartupScenario("active-live-mismatch"));
test("Manager closes an unassigned direct Lead and preserves its worktree", () =>
  runManagerStartupScenario("unassigned-close"));
test("Manager adopts a preexisting branch worktree for fresh delegation", () =>
  runManagerStartupScenario("preexisting"));
test("Manager opens and adopts a closed preexisting branch worktree", () =>
  runManagerStartupScenario("preexisting-closed"));
test("Manager refuses an occupied worktree without reserving work", () =>
  runManagerStartupScenario("occupied"));
test("Manager refuses ambiguous multiple Leads in a worktree", () =>
  runManagerStartupScenario("multiple"));
test("Manager serializes simultaneous same-branch delegation", () =>
  runManagerStartupScenario("concurrent"));
test("Manager retains placement when recovery topology is not authoritative", () =>
  runManagerStartupScenario("invalid-topology"));

test("project agent discovery is gated by Pi project trust", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-gate-"),
  );
  let pi: ReturnType<typeof fakePi> | undefined;
  try {
    const agents = join(project, ".pi", "agents");
    realFs.mkdirSync(agents, { recursive: true });
    realFs.writeFileSync(
      join(agents, "project-only.md"),
      "---\nname: project-only\n---\nproject policy",
    );
    pi = fakePi();
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.cwd = project;
    context.hasUI = true;
    context.mode = "rpc";
    const selections: string[][] = [];
    context.ui.select = async (_title: string, options: string[]) => {
      selections.push(options);
      return undefined;
    };
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      true,
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "project-only.md"),
      "---\nname: project-only\nmodel: global/model\n---\nglobal policy",
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "standalone-global.md"),
      "---\nname: standalone-global\n---\nglobal",
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "scout.md"),
      "---\nname: scout\nmodel: global/model\n---\nglobal",
    );
    await command.handler("definitions", context);
    const options = selections.at(-1) ?? [];
    assert.ok(
      options.some(
        (value) =>
          value.includes("project-only") && value.includes("project + global"),
      ),
    );
    assert.ok(
      options.some(
        (value) =>
          value.includes("scout") && value.includes("bundled + global"),
      ),
    );
    assert.ok(options.some((value) => value.startsWith("standalone-global")));
    assert.equal(
      options.some((value) => value.startsWith("standalone-global *")),
      false,
    );
    realFs.rmSync(join(PI_AGENTS_DIR, "project-only.md"), { force: true });
    context.isProjectTrusted = () => false;
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      false,
    );
  } finally {
    pi?.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
    for (const name of ["project-only.md", "standalone-global.md", "scout.md"])
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
    setLeadEnvironment();
  }
});

test("semantic result refs attach persisted output and preserve canonical file refs", async () => {
  setLeadEnvironment();
  const requestId = randomUUID();
  const canonical = resultRef(requestId);
  const resultFile = resultPath(requestId);
  const resultText = [
    'Agent result source: {"agent":"implementation","definition":"agent","cwd":"/repo","piSessionId":"producer-session"}',
    "persisted implementation review",
  ].join("\n\n");
  realFs.mkdirSync(resolve(resultFile, ".."), { recursive: true });
  realFs.writeFileSync(resultFile, resultText, "utf8");
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId,
        resultRef: canonical,
        status: "completed",
      },
    },
  ];
  const label = "agent";
  let assignedText = "";
  let submittedRequest: RequestRecord | undefined;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text, request) => {
      assignedText = text;
      submittedRequest = request;
    },
  );
  const pi = fakePi({ entries, exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "Review supplied implementation.",
        files: ["result:implementation#1", canonical],
      },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.match(assignedText, /<file name="result:implementation#1"/);
    assert.doesNotMatch(assignedText, /<file name="result:[0-9a-f-]{36}"/);
    assert.match(
      assignedText,
      /Agent result source: \{"agent":"implementation","definition":"agent","cwd":"\/repo","piSessionId":"producer-session"\}/,
    );
    assert.match(assignedText, /persisted implementation review/);
    assert.equal(
      assignedText.match(/<file name="result:implementation#1"/g)?.length,
      1,
      "semantic and canonical refs supplied through files should deduplicate in the existing pipeline",
    );
    assert.deepEqual(submittedRequest?.resultBindings, [
      { ref: "result:implementation#1", canonicalRef: canonical },
    ]);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(resultFile, { force: true });
  }
});

test("semantic result refs resolve only on the active branch", async () => {
  setLeadEnvironment();
  const requestId = randomUUID();
  const resultEntry = {
    customType: "pi-herdsman-agent-result",
    details: {
      agentLabel: "implementation",
      resultIndex: 2,
      requestId,
      resultRef: resultRef(requestId),
      status: "completed",
    },
  };
  const entries: unknown[] = [resultEntry];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "must not start",
        files: ["result:implementation#2"],
      },
      undefined,
      undefined,
      fakeContext(entries, []),
    );
    assert.equal(result.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
    const malformed = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "must not start",
        files: ["result:implementation#01"],
      },
      undefined,
      undefined,
      fakeContext(entries, []),
    );
    assert.equal(malformed.details.error.category, "invalid_request");
    assert.equal(
      malformed.details.error.message,
      "Invalid result ref: result:implementation#01. Copy the exact result ref shown by the agent completion.",
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("conflicting duplicate result mappings fail closed", async () => {
  setLeadEnvironment();
  const firstRequestId = randomUUID();
  const secondRequestId = randomUUID();
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId: firstRequestId,
        resultRef: resultRef(firstRequestId),
        status: "completed",
      },
    },
    {
      customType: "pi-herdsman-agent-result",
      details: {
        agentLabel: "implementation",
        resultIndex: 1,
        requestId: secondRequestId,
        resultRef: resultRef(secondRequestId),
        status: "completed",
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-result-ref",
      data: {
        ref: "result:implementation#1",
        canonicalRef: resultRef(secondRequestId),
      },
    },
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "must not guess",
        files: ["result:implementation#1"],
      },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("managed agent validates project definitions before publishing state", async () => {
  const mailbox = setAgentEnvironment("project-validation-agent");
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-agent-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "agents", "broken.md"),
    '---\nname: broken-parent\nagents: ["missing-child"]\n---\nbroken',
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "project-parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "project-parent",
      },
    },
  ]) as any;
  context.cwd = project;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(project, { recursive: true, force: true });
  }
});

test("trusted same-cwd project assignment launches with native approval", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-assign-same-cwd-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-only.md"),
    "---\nname: project-only\n---\nproject",
  );
  const startArgs: string[][] = [];
  const startup = startupExecutor(
    "project-only",
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    (args) => startArgs.push(args),
    project,
    AGENT_ID,
    true,
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = project;
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "project-only",
        task: "same cwd",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      result.details.ok,
      true,
      JSON.stringify({ result: result.details, entries: pi.entries }),
    );
    assert.ok(startArgs[0]?.includes("--approve"));
    const tool = pi.tools.find((candidate) => candidate.name === "agent_steer");
    const rendered = tool.renderCall(
      { agent: result.details.agent, message: "Continue." },
      {
        fg: (_color: string, value: string) => value,
        bold: (text: string) => text,
      },
      { argsComplete: true },
    );
    assert.match(rendered.render(160).join("\n"), /agent steer\s+project-only/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(project, { recursive: true, force: true });
  }
  await (async () => {
    setLeadEnvironment();
    const project = realFs.mkdtempSync(
      join(tmpdir(), "pi-herdsman-assign-symlink-cwd-"),
    );
    const projectLink = `${project}-link`;
    realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    realFs.writeFileSync(
      join(project, ".pi", "agents", "project-only.md"),
      "---\nname: project-only\n---\nproject",
    );
    realFs.symlinkSync(project, projectLink);
    const startArgs: string[][] = [];
    const startup = startupExecutor(
      "project-only",
      () => DEFAULT_PI_SESSION_ID,
      undefined,
      undefined,
      false,
      (args) => startArgs.push(args),
      project,
      AGENT_ID,
      true,
    );
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    const context = fakeContext() as any;
    context.cwd = projectLink;
    try {
      const result = await agentTool(pi, "delegate").execute(
        "id",
        { definition: "project-only", task: "symlink cwd" },
        undefined,
        undefined,
        context,
      );
      assert.equal(
        result.details.ok,
        true,
        JSON.stringify({ result: result.details, entries: pi.entries }),
      );
      assert.ok(startArgs[0]?.includes("--approve"));
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
      realFs.rmSync(projectLink, { force: true });
      realFs.rmSync(project, { recursive: true, force: true });
    }
  })();
});

test("untrusted assignments omit project approval", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-approval-untrusted-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  const startArgs: string[][] = [];
  const startup = startupExecutor(
    "agent",
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    (args) => startArgs.push(args),
    project,
    AGENT_ID,
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = project;
  context.isProjectTrusted = () => false;
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "untrusted",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(startArgs[0]?.includes("--approve"), false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(project, { recursive: true, force: true });
  }
});

test("project-only Definitions edits create a global override", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-edit-"),
  );
  const projectPath = join(project, ".pi", "agents", "project-only.md");
  const original = "---\nname: project-only\n---\nproject policy\n";
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(projectPath, original);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.cwd = project;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "provider", id: "edited-model" }],
    getAvailable: () => [{ provider: "provider", id: "edited-model" }],
  };
  let selection = 0;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("project-only"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return "edited-model";
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    const globalPath = join(PI_AGENTS_DIR, "project-only.md");
    assert.equal(realFs.readFileSync(projectPath, "utf8"), original);
    assert.match(
      realFs.readFileSync(globalPath, "utf8"),
      /^model: provider\/edited-model$/m,
    );
    const effective = discoverAgent("project-only", { projectRoot: project });
    assert.equal(effective.frontmatter.model, "provider/edited-model");
    assert.equal(effective.projectSource, projectPath);
    assert.equal(effective.overrideSource, globalPath);
    realFs.rmSync(globalPath, { force: true });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
    realFs.rmSync(join(PI_AGENTS_DIR, "project-only.md"), { force: true });
  }
});

test("same-cwd managed parents resolve project children", async () => {
  setAgentEnvironment("project-parent", ["project-child"]);
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-parent-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-parent.md"),
    '---\nname: project-parent\nagents: ["project-child"]\n---\nparent',
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-child.md"),
    "---\nname: project-child\n---\nchild",
  );
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "project-parent";
  const parent = { ...managedState("project-parent"), cwd: project };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const lifecycle = delegatedLifecycleExecutor(parent, [], project);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "project-parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "project-parent",
      },
    },
  ]) as any;
  context.cwd = project;
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const started = await agentTool(pi, "delegate").execute(
      "start",
      {
        definition: "project-child",
        task: "delegate project child work",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(started.details.ok, true, JSON.stringify(started.details));
    const childState = readAgentState(
      agentMailboxPath(WORKSPACE, "project-child"),
    );
    assert.equal(childState?.ownerSessionId, parent.piSessionId);
    assert.equal(childState?.cwd, project);
    const child = discoverAgent("project-child", { projectRoot: project });
    assert.equal(
      child.projectSource,
      join(project, ".pi", "agents", "project-child.md"),
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "project-child"));
    realFs.rmSync(project, { recursive: true, force: true });
    setLeadEnvironment();
  }
});

test("parent controller readiness and allowlist fail closed", async () => {
  setAgentEnvironment("delegating-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("delegating-parent");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
    ["other.md", "---\nname: other\n---\nother\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ]);
  const pi = fakePi({ exec: agentControllerExecutor(parent) });
  registerExtension!(pi.pi as never);
  const tool = agentTool(pi, "delegate");
  try {
    const beforeInit = await tool.execute(
      "id",
      { definition: "child", task: "before init" },
      undefined,
      undefined,
      context,
    );
    assert.equal(beforeInit.details.error.category, "target_not_found");
    assert.equal(pi.calls.length, 0);

    const listBeforeInit = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listBeforeInit.details.error.category, "target_not_found");
    assert.equal(pi.calls.length, 0);

    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const unauthorized = await tool.execute(
      "id",
      { definition: "other", task: "not allowed" },
      undefined,
      undefined,
      context,
    );
    assert.equal(unauthorized.details.error.category, "invalid_request");
    assert.equal(
      unauthorized.details.error.message,
      "Agent definition other is not allowed for this delegating agent",
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }

  setAgentEnvironment("conflicting-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const conflict = managedState("conflicting-parent");
  const conflictMailbox = agentMailboxPath(WORKSPACE, conflict.agentLabel);
  resetAgentMailbox(conflictMailbox);
  writeAgentState(conflictMailbox, {
    ...conflict,
    runId: "11111111-1111-4111-8111-111111111111",
  });
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const failing = fakePi({ exec: agentControllerExecutor(conflict) });
  registerExtension!(failing.pi as never);
  const failingContext = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ]);
  try {
    for (const handler of failing.events.get("session_start") ?? [])
      await handler(undefined, failingContext);
    const rejected = await agentTool(failing, "delegate").execute(
      "id",
      { definition: "child", task: "conflicting state" },
      undefined,
      undefined,
      failingContext,
    );
    assert.equal(rejected.details.error.category, "target_not_found");
    assert.equal(
      failing.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    for (const handler of failing.events.get("session_shutdown") ?? [])
      handler();
    resetAgentMailbox(conflictMailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("parent list hides disabled allowed definitions", async () => {
  setAgentEnvironment("listing-parent", ["enabled-child", "disabled-child"]);
  const files = [
    ["enabled-child.md", "---\nname: enabled-child\n---\nchild\n"],
    [
      "disabled-child.md",
      "---\nname: disabled-child\nenabled: false\n---\nchild\n",
    ],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const pi = fakePi({
    exec: agentControllerExecutor(managedState("listing-parent")),
  });
  registerExtension!(pi.pi as never);
  const entries = pi.entries;
  const context = fakeAgentContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(
      (listed.details.agent_definitions as { name: string }[]).map(
        ({ name }) => name,
      ),
      ["enabled-child"],
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const [name] of files)
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
  }
});

test("parent list omits unrelated unknown mailbox diagnostics", async () => {
  setAgentEnvironment("recovery-parent-no-self-get", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("recovery-parent-no-self-get");
  const child = {
    ...managedState(
      "recovered-child",
      undefined,
      recoveryIdentity("recovered-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/recovered-child.jsonl",
  };
  const mailboxes = [parent, child].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  const unknownMailbox = agentMailboxPath(
    "unrelated-workspace",
    "unrelated-agent",
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  writeAgentState(mailboxes[0], parent);
  writeAgentState(mailboxes[1], child);
  realFs.mkdirSync(unknownMailbox, { recursive: true });
  realFs.writeFileSync(join(unknownMailbox, "state.json"), "{malformed");
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const getTargets: string[] = [];
  const base = agentControllerExecutor(parent, [child]);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = base(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        getTargets.push(args[2]!);
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ]);

  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    assert.deepEqual(getTargets, [child.paneId]);
    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      (listed.details.agents as { agent?: string }[])
        .map((agent) => agent.agent)
        .filter((agent): agent is string => agent !== undefined),
      [child.agentLabel],
    );
    assert.equal(
      (listed.details.agents as { state?: string }[]).some(
        (agent) => agent.state === "unknown",
      ),
      false,
    );
    assert.doesNotMatch(
      (listed.content[0] as { text: string }).text,
      /diagnostic:/,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    realFs.rmSync(unknownMailbox, { recursive: true, force: true });
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("foreign-workspace mailbox is ignored by recovery and list", async () => {
  setLeadEnvironment();
  const label = "cross-workspace-agent";
  const identity = recoveryIdentity(label);
  const current = managedState(label, undefined, identity);
  const foreign: ManagedAgentState = {
    ...current,
    workspaceId: "foreign-workspace",
    paneId: "foreign-pane",
    piSessionFile: "/tmp/foreign-workspace-agent.jsonl",
  };
  const currentMailbox = agentMailboxPath(WORKSPACE, label);
  const foreignMailbox = agentMailboxPath(foreign.workspaceId, label);
  resetAgentMailbox(currentMailbox);
  resetAgentMailbox(foreignMailbox);
  writeAgentState(currentMailbox, current);
  writeAgentState(foreignMailbox, foreign);
  const entries: unknown[] = [];
  const lifecycle = cascadeExecutor([current]);
  const pi = fakePi({ entries, exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);

  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      (listed.details.agents as { agent?: string }[])
        .map((agent) => agent.agent)
        .filter((agent): agent is string => agent !== undefined),
      [label],
    );
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_recovery_error",
      ),
      false,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(currentMailbox);
    resetAgentMailbox(foreignMailbox);
  }
});

test("parent controls only direct children and enforces session allowlists", async () => {
  setAgentEnvironment("ownership-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("ownership-parent");
  const child = {
    ...managedState(
      "ownership-child",
      undefined,
      recoveryIdentity("ownership-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(testTmpRoot, "ownership-child.jsonl"),
  };
  const activeRequestId = randomUUID();
  const workingChild = {
    ...managedState(
      "ownership-working-child",
      activeRequestId,
      recoveryIdentity("ownership-working-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(testTmpRoot, "ownership-working-child.jsonl"),
  };
  const sibling = {
    ...managedState(
      "ownership-sibling",
      undefined,
      recoveryIdentity("ownership-sibling"),
    ),
    ownerSessionId: LEAD_SESSION_ID,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: join(testTmpRoot, "ownership-sibling.jsonl"),
  };
  const mailboxes = [parent, child, workingChild, sibling].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  writeAgentState(mailboxes[0], parent);
  writeAgentState(mailboxes[1], child);
  writeAgentState(mailboxes[2], workingChild);
  writeAgentState(mailboxes[3], sibling);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
    ["other.md", "---\nname: other\n---\nother\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
    ownershipResult(
      "33333333-3333-4333-8333-333333333333",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      {
        path: join(testTmpRoot, "ownership-resume.jsonl"),
        definition: "other",
        label: "other",
      },
    ),
  ];
  const pi = fakePi({
    exec: agentControllerExecutor(parent, [child, workingChild, sibling]),
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries);
  const resumePath = join(testTmpRoot, "ownership-resume.jsonl");
  realFs.writeFileSync(resumePath, "{}", "utf8");
  nativeSessions.set("ownership-resume", {
    id: "33333333-3333-4333-8333-333333333333",
    path: resumePath,
    cwd: testTmpRoot,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "33333333-3333-4333-8333-333333333333",
          definition: "other",
          label: "other",
        },
      },
    ],
  });
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(
      (listed.details.agents as { agent: string }[])
        .map((agent) => agent.agent)
        .sort(),
      [child.agentLabel, workingChild.agentLabel],
    );

    const steered = await agentTool(pi, "steer").execute(
      "steer",
      {
        agent: workingChild.agentLabel,
        message: "steer direct child",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(steered.details.ok, true);
    const siblingResult = await agentTool(pi, "steer").execute(
      "sibling",
      { agent: sibling.agentLabel, message: "wrong owner" },
      undefined,
      undefined,
      context,
    );
    assert.equal(siblingResult.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "prompt" &&
          args[2] === sibling.paneId,
      ),
      false,
    );

    const resumed = await agentTool(pi, "continue").execute(
      "resume",
      {
        session: resumePath,
        task: "wrong definition",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(resumed.details.error.category, "invalid_request");
    assert.match(resumed.details.error.message, /not allowed/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    nativeSessions.delete("ownership-resume");
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
    realFs.rmSync(resumePath, { force: true });
  }
});

test("list retains durable agents whose physical identity is not exact", async () => {
  setLeadEnvironment();
  const validLabel = "valid-list-agent";
  const invalidLabel = "invalid-list-agent";
  const valid = recoveryIdentity(validLabel);
  const invalid = {
    ...recoveryIdentity(invalidLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const validMailbox = agentMailboxPath(WORKSPACE, validLabel);
  const invalidMailbox = agentMailboxPath(WORKSPACE, invalidLabel);
  resetAgentMailbox(validMailbox);
  resetAgentMailbox(invalidMailbox);
  writeAgentState(validMailbox, managedState(validLabel, undefined, valid));
  writeAgentState(
    invalidMailbox,
    managedState(invalidLabel, undefined, invalid),
  );
  nativeSessions.set(invalid.piSessionId, {
    id: invalid.piSessionId,
    path: invalid.piSessionFile,
    entries: [],
  });
  nativeSessions.set(valid.piSessionId, {
    id: valid.piSessionId,
    path: valid.piSessionFile,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: valid.piSessionId,
          definition: "agent",
          label: "agent",
        },
      },
    ],
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: [
                  {
                    name: "unmanaged-agent",
                    agent_status: "idle",
                    workspace_id: WORKSPACE,
                    pane_id: "unmanaged-pane",
                    cwd: "/tmp",
                  },
                  {
                    name: herdrAlias(invalidLabel),
                    agent_status: "idle",
                    workspace_id: WORKSPACE,
                    pane_id: invalid.paneId,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: DEFAULT_PI_SESSION_ID,
                    },
                  },
                  {
                    name: herdrAlias(validLabel),
                    agent_status: "idle",
                    workspace_id: WORKSPACE,
                    pane_id: valid.paneId,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: valid.piSessionId,
                    },
                    agent_definition: "wrong-herdr-definition",
                  },
                ],
                panes: [
                  {
                    pane_id: "unmanaged-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                  },
                  {
                    pane_id: invalid.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                  },
                  {
                    pane_id: valid.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
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
                  pane_id: "unmanaged-pane",
                  workspace_id: WORKSPACE,
                  agent: "unmanaged-agent",
                  agent_status: "unknown",
                },
                {
                  pane_id: invalid.paneId,
                  workspace_id: WORKSPACE,
                  agent: invalidLabel,
                  agent_status: "idle",
                },
                {
                  pane_id: valid.paneId,
                  workspace_id: WORKSPACE,
                  agent: validLabel,
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
  try {
    registerExtension!(pi.pi as never);
    const result = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const agents = (
      result.details as { agents: Array<Record<string, unknown>> }
    ).agents;
    assert.deepEqual(
      agents
        .filter((agent) => typeof agent.agent === "string")
        .map((agent) => agent.agent)
        .sort(),
      [invalidLabel, validLabel].sort(),
    );
    const invalidAgent = agents.find((agent) => agent.agent === invalidLabel);
    const validAgent = agents.find((agent) => agent.agent === validLabel);
    assert.ok(invalidAgent);
    assert.ok(validAgent);
    assert.equal(invalidAgent.state, "unknown");
    assert.deepEqual(invalidAgent.available_tools, []);
    assert.equal(validAgent.agent_definition, "agent");
    assert.equal(validAgent.managed, true);
  } finally {
    nativeSessions.delete(invalid.piSessionId);
    nativeSessions.delete(valid.piSessionId);
    resetAgentMailbox(validMailbox);
    resetAgentMailbox(invalidMailbox);
  }
});

test("list projects an unreadable current mailbox as non-actionable unknown", async () => {
  setLeadEnvironment();
  const mailbox = agentMailboxPath(WORKSPACE, "unreadable-list-agent");
  realFs.mkdirSync(mailbox, { recursive: true });
  realFs.writeFileSync(join(mailbox, "state.json"), "x".repeat(70 * 1024));
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args) || isApiSnapshot(args)
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
  try {
    const result = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.agents.length, 1);
    assert.deepEqual(
      { ...result.details.agents[0], diagnostic: undefined },
      {
        state: "unknown",
        available_tools: [],
        managed: true,
        diagnostic: undefined,
      },
    );
    assert.match(
      result.details.agents[0].diagnostic,
      /Mailbox state unavailable: .*Mailbox record is too large/,
    );
    assert.match(
      (result.content[0] as { text: string }).text,
      /diagnostic: Mailbox state unavailable: .*Mailbox record is too large/,
    );
    assert.doesNotMatch(
      (result.content[0] as { text: string }).text,
      /session:|pane:/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
  }
});

test("assignment session resolution accepts exact paths and UUIDs only", async () => {
  const name = `native-resume-${randomUUID()}.jsonl`;
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ab",
    path: join(homedir(), name),
    cwd: join(homedir(), "saved-agent"),
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "018f2f2e-7b13-7abc-8def-0123456789ab",
          definition: "reviewer",
          label: "review-fix",
        },
      },
    ],
  };
  nativeSessions.clear();
  nativeSessions.set(session.id, session);
  realFs.writeFileSync(session.path, "{}", "utf8");
  const context = fakeContext([
    ownershipResult(session.id, LEAD_SESSION_ID, {
      path: session.path,
      definition: "reviewer",
      label: "review-fix",
    }),
  ]) as any;
  context.cwd = homedir();
  const byPath = await resolveAssignmentSession(context, session.path);
  assert.deepEqual(byPath, {
    path: session.path,
    id: session.id,
    definition: "reviewer",
    label: "review-fix",
    cwd: session.cwd,
  });
  const byId = await resolveAssignmentSession(context, session.id);
  assert.deepEqual(byId, byPath);
  const byTilde = await resolveAssignmentSession(context, `~/${name}`);
  assert.deepEqual(byTilde, byPath);
  assert.deepEqual(resolveAssignmentSession(context, name), byPath);
  assert.throws(
    () => resolveAssignmentSession(context, "11111111"),
    /prefixes are not allowed/,
  );
  nativeSessions.set("duplicate", {
    ...session,
    path: join(testTmpRoot, "native-resume-2.jsonl"),
  });
  realFs.writeFileSync(
    join(testTmpRoot, "native-resume-2.jsonl"),
    "{}",
    "utf8",
  );
  assert.deepEqual(resolveAssignmentSession(context, session.id), byPath);
  const missing = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ab",
    path: join(testTmpRoot, `missing-identity-${randomUUID()}.jsonl`),
    cwd: homedir(),
    entries: [],
  };
  nativeSessions.clear();
  nativeSessions.set(missing.id, missing);
  realFs.writeFileSync(missing.path, "{}", "utf8");
  const missingContext = fakeContext([
    ownershipResult(missing.id, LEAD_SESSION_ID, {
      path: missing.path,
      definition: "reviewer",
      label: "review-fix",
    }),
  ]);
  assert.throws(
    () => resolveAssignmentSession(missingContext, missing.path),
    /ownership tree/,
  );
  nativeSessions.clear();
  realFs.rmSync(missing.path, { force: true });
  realFs.rmSync(session.path, { force: true });
});

test("owned continuation requires a matching persisted child edge", () => {
  const id = randomUUID();
  const path = join(testTmpRoot, `owned-validation-${id}.jsonl`);
  const identity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { sessionId: id, definition: "agent", label: "agent" },
  };
  const session = { id, path, cwd: testTmpRoot, entries: [identity] };
  nativeSessions.clear();
  nativeSessions.set(id, session);
  const proof = ownershipResult(id, LEAD_SESSION_ID, { path });
  const context = (entry: unknown) => fakeContext([entry]);
  try {
    realFs.writeFileSync(path, "{}", "utf8");
    assert.equal(resolveAssignmentSession(context(proof), id).id, id);
    assert.throws(
      () =>
        resolveAssignmentSession(
          context({
            type: "message",
            message: {
              role: "toolResult",
              toolName: "agent_delegate",
              details: {
                ok: true,
                owner_session_id: LEAD_SESSION_ID,
                session_id: id,
                session_path: path,
                agent: "agent",
                definition: "agent",
              },
            },
          }),
          id,
        ),
      /ownership tree/,
    );
    for (const details of [
      { ownerSessionId: randomUUID() },
      { piSessionId: randomUUID() },
      { piSessionFile: undefined },
      { piSessionFile: join(testTmpRoot, "absent.jsonl") },
      { agentDefinition: "other" },
      { agentLabel: "other" },
      { status: "unknown" },
      { requestId: "" },
    ]) {
      assert.throws(
        () =>
          resolveAssignmentSession(
            context({ ...proof, details: { ...proof.details, ...details } }),
            id,
          ),
        /ownership tree/,
      );
    }
    session.entries = [];
    assert.throws(
      () => resolveAssignmentSession(context(proof), id),
      /ownership tree/,
    );
  } finally {
    nativeSessions.clear();
    realFs.rmSync(path, { force: true });
  }
});

test("context retirement rejects managed session continuation only when enabled", async () => {
  const sessionId = "018f2f2e-7b13-7abc-8def-0123456789ae";
  const session = {
    id: sessionId,
    path: join(homedir(), "retired-managed.jsonl"),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId, definition: "agent", label: "retired-agent" },
      },
      {
        type: "custom",
        customType: "pi-herdsman-agent-context-retired",
        data: { sessionId },
      },
    ],
  };
  nativeSessions.clear();
  nativeSessions.set(sessionId, session);
  realFs.writeFileSync(session.path, "{}", "utf8");
  const context = fakeContext([
    ownershipResult(sessionId, LEAD_SESSION_ID, {
      path: session.path,
      label: "retired-agent",
    }),
  ]);
  try {
    updateConfig("contextRetirement", undefined);
    assert.throws(
      () => resolveAssignmentSession(context, session.path),
      /retired after context pressure/,
    );
    updateConfig("contextRetirement", false);
    assert.deepEqual(resolveAssignmentSession(context, session.path), {
      path: session.path,
      id: sessionId,
      definition: "agent",
      label: "retired-agent",
      cwd: resolve("/tmp"),
    });
  } finally {
    updateConfig("contextRetirement", undefined);
    nativeSessions.clear();
    realFs.rmSync(session.path, { force: true });
  }
});

test("session continuation inherits the saved label without an override", async () => {
  const label = "resume-stable";
  const run = async () => {
    setLeadEnvironment();
    nativeSessions.clear();
    const sourceId = randomUUID();
    const source = {
      id: sourceId,
      path: join(tmpdir(), `session-delegate-${randomUUID()}.jsonl`),
      cwd: "/tmp",
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { sessionId: sourceId, definition: "agent", label },
        },
      ],
    };
    realFs.writeFileSync(source.path, "{}", "utf8");
    nativeSessions.set(source.id, source);
    const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
    const pi = fakePi({ exec: startup.exec });
    const context = fakeContext([
      ownershipResult(source.id, LEAD_SESSION_ID, { path: source.path, label }),
    ]) as any;
    context.model = { provider: "continue-provider", id: "continue-model" };
    context.thinkingLevel = "high";
    registerExtension!(pi.pi as never);
    try {
      const result = await agentTool(pi, "continue").execute(
        "id",
        {
          session: source.path,
          task: "continue with the saved label",
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(result.details.agent, label);
      assert.equal(
        readAgentState(agentMailboxPath(WORKSPACE, label))?.agentLabel,
        label,
      );
      const start = pi.calls.find(
        (args) => args[0] === "agent" && args[1] === "start",
      )!;
      assert.ok(start);
      assert.equal(start.includes("--model"), false);
      assert.equal(start.includes("--thinking"), false);
      assert.equal(
        start[start.indexOf("--session") + 1],
        realFs.realpathSync(source.path),
      );
      assert.equal(start.includes("--fork"), false);
      return result;
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      nativeSessions.clear();
      resetAgentMailbox(startup.mailbox);
      realFs.rmSync(source.path, { force: true });
    }
  };

  const first = await run();
  assert.equal(first.details.agent, label);
  const reused = await run();
  assert.equal(reused.details.agent, label);
});

test("session continuation keeps explicit definition execution overrides", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const definition = `continue-override-${randomUUID().slice(0, 8)}`;
  const label = `${definition}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${definition}.md`);
  const sourceId = randomUUID();
  const sourcePath = join(
    tmpdir(),
    `session-continue-override-${sourceId}.jsonl`,
  );
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${definition}\nmodel: explicit/provider\nthinking: low\n---\ncontinue\n`,
  );
  realFs.writeFileSync(sourcePath, "{}", "utf8");
  nativeSessions.set(sourceId, {
    id: sourceId,
    path: sourcePath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: sourceId, definition, label },
      },
    ],
  });
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    ownershipResult(sourceId, LEAD_SESSION_ID, {
      path: sourcePath,
      label,
      definition,
    }),
  ]) as any;
  context.model = { provider: "controller-provider", id: "controller-model" };
  context.thinkingLevel = "high";
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      { session: sourcePath, task: "continue" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const start = pi.calls.find(
      (args) => args[0] === "agent" && args[1] === "start",
    )!;
    assert.equal(start[start.indexOf("--model") + 1], "explicit/provider");
    assert.equal(start[start.indexOf("--thinking") + 1], "low");
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sourcePath, { force: true });
  }
});

test("session continuation rejects label overrides and occupied inherited labels", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const invalidPi = fakePi();
  registerExtension!(invalidPi.pi as never);
  try {
    const invalidRequest = {
      session: "/tmp/session.jsonl",
      label: "Invalid_Label",
      task: "reject the label",
    } as const;
    assert.equal(
      Value.Check(agentTool(invalidPi, "continue").parameters, {
        session: invalidRequest.session,
        label: invalidRequest.label,
        task: invalidRequest.task,
      }),
      false,
    );
    const invalid = await agentTool(invalidPi, "continue").execute(
      "id",
      {
        session: invalidRequest.session,
        label: invalidRequest.label,
        task: invalidRequest.task,
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(invalid.details.error.category, "invalid_request");
    assert.equal(invalidPi.calls.length, 0);
  } finally {
    invalidPi.events.get("session_shutdown")?.[0]();
  }

  setLeadEnvironment();
  const label = "resume-occupied";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label));
  nativeSessions.set(DEFAULT_PI_SESSION_ID, {
    id: DEFAULT_PI_SESSION_ID,
    path: "/tmp/registered-agent.jsonl",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: "agent",
          label,
        },
      },
    ],
  });
  const source = {
    id: randomUUID(),
    path: join(tmpdir(), `session-occupied-${randomUUID()}.jsonl`),
    cwd: "/tmp",
  };
  realFs.writeFileSync(source.path, "{}", "utf8");
  nativeSessions.set(source.id, {
    ...source,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: source.id, definition: "agent", label },
      },
    ],
  });
  const baseExec = leadExec(label, "idle", DEFAULT_PI_SESSION_ID);
  const pi = fakePi({
    exec: (command, args, options) =>
      command === "herdr" && args[0] === "tab" && args[1] === "create"
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                tab: { tab_id: "occupied-test-tab" },
                root_pane: {
                  pane_id: "occupied-test-pane",
                  terminal_id: "occupied-test-terminal",
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : baseExec(command, args, options),
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      {
        session: source.path,
        task: "must not fall back to another label",
      },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(source.id, LEAD_SESSION_ID, {
          path: source.path,
          label,
        }),
      ]),
    );
    assert.equal(result.details.error.category, "agent_label_exists");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(mailbox);
    realFs.rmSync(source.path, { force: true });
  }
});

test("delegate schema rejects an empty task", () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const schema = pi.tools.find(
    (candidate) => candidate.name === "agent_delegate",
  )!.parameters;
  assert.equal(
    Value.Check(schema, { definition: "agent", task: "work" }),
    true,
  );
  assert.equal(Value.Check(schema, { definition: "agent", task: "" }), false);
  pi.events.get("session_shutdown")?.[0]();
});

test("public assignment normalizes invalid and unknown session sources", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const pi = fakePi({
    exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
  });
  registerExtension!(pi.pi as never);
  try {
    for (const [value, diagnostic] of [
      ["11111111", /prefixes are not allowed/],
      ["11111111-1111-4111-8111-111111111111", /ownership tree/],
    ] as const) {
      const result = await agentTool(pi, "continue").execute(
        "id",
        {
          task: "resolve the source",
          session: value,
        },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, false, JSON.stringify(result.details));
      assert.equal(result.details.error.category, "invalid_request");
      assert.equal(result.details.error.operation, "continue");
      assert.match(result.details.error.message, diagnostic);
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
  }
});

test("session assignment rejects the controller's active session", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const session = {
    id: LEAD_SESSION_ID,
    path: join(testTmpRoot, "lead.jsonl"),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: LEAD_SESSION_ID,
          definition: "agent",
          label: "agent",
        },
      },
    ],
  };
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const pi = fakePi({
    exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      { session: session.path, task: "same session" },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(session.id, LEAD_SESSION_ID, { path: session.path }),
      ]),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.operation, "continue");
    assert.match(result.details.error.message, /currently active Pi session/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    nativeSessions.clear();
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("public assignment preserves session source open failures", async () => {
  setLeadEnvironment();
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789af",
    path: join(homedir(), "assignment-open-failure.jsonl"),
    cwd: "/tmp",
    entries: [],
  };
  nativeSessions.set(session.id, session);
  realFs.writeFileSync(session.path, "{}", "utf8");
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    ownershipResult(session.id, LEAD_SESSION_ID, { path: session.path }),
  ]);
  const openOperationError = new OperationError({
    category: "internal_failure",
    message: "session dependency failed",
    operation: "session-open-test",
    rollbackOccurred: false,
    retryAttempted: false,
  });
  support.sessionOpenError = openOperationError;
  try {
    const structured = await agentTool(pi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "continue the saved session",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(structured.details.error, openOperationError.detail);

    const internalError = new Error("permission denied while opening session");
    support.sessionOpenError = internalError;
    await assert.rejects(
      agentTool(pi, "continue").execute(
        "id",
        {
          session: session.path,
          task: "continue the saved session",
        },
        undefined,
        undefined,
        context,
      ),
      (error) => error === internalError,
    );
  } finally {
    support.sessionOpenError = undefined;
    nativeSessions.clear();
    realFs.rmSync(session.path, { force: true });
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("assignment session rejects unusable saved cwd headers without mutation", async () => {
  setLeadEnvironment();
  for (const [name, cwd] of [
    ["missing", undefined],
    ["empty", ""],
  ] as const) {
    const id = randomUUID();
    const label = `assignment-session-cwd-${name}-${id}`;
    const path = join(testTmpRoot, `${id}.jsonl`);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    assert.equal(realFs.existsSync(mailbox), false);
    nativeSessions.clear();
    realFs.writeFileSync(path, "{}", "utf8");
    nativeSessions.set(id, { id, path, cwd });
    const pi = fakePi({
      exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext([
      ownershipResult(id, LEAD_SESSION_ID, { path }),
    ]);
    const result = await agentTool(pi, "continue").execute(
      "id",
      {
        session: path,
        task: "continue the saved session",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /no non-empty cwd/);
    assert.deepEqual(pi.calls, []);
    assert.equal(realFs.existsSync(mailbox), false);
    assert.deepEqual(pi.entries, []);
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(path, { force: true });
  }
  nativeSessions.clear();
});

test("managed historical sources require durable owner-side ancestry for continue", async () => {
  setLeadEnvironment();
  const parentId = randomUUID();
  const sourceId = randomUUID();
  const sourcePath = join(testTmpRoot, `owned-source-${sourceId}.jsonl`);
  const parentPath = join(testTmpRoot, `owner-${parentId}.jsonl`);
  realFs.writeFileSync(sourcePath, "{}", "utf8");
  realFs.writeFileSync(parentPath, "{}", "utf8");
  nativeSessions.clear();
  nativeSessions.set(parentId, {
    id: parentId,
    path: parentPath,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: parentId, definition: "agent", label: "parent" },
      },
      ownershipResult(sourceId, parentId, {
        path: sourcePath,
        label: "owned-source",
      }),
    ],
  });
  const sourceEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: sourceId, definition: "agent", label: "owned-source" },
    },
    ownershipResult(parentId, sourceId, { path: parentPath, label: "parent" }),
  ];
  nativeSessions.set(sourceId, {
    id: sourceId,
    path: sourcePath,
    cwd: "/tmp",
    entries: sourceEntries,
  });
  const parentProof = ownershipResult(parentId, LEAD_SESSION_ID, {
    path: parentPath,
    label: "parent",
  });
  const pi = fakePi({ exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }) });
  registerExtension!(pi.pi as never);
  const request = async (selector: string, entries: unknown[]) =>
    agentTool(pi, "continue").execute(
      "id",
      { session: selector, task: "follow up" },
      undefined,
      undefined,
      fakeContext(entries),
    );
  try {
    for (const selector of [sourceId, sourcePath]) {
      const recipient = await request(selector, [
        ownershipResult(randomUUID()),
      ]);
      assert.equal(recipient.details.error.category, "invalid_request");
      assert.match(recipient.details.error.message, /ownership tree/);
      const broken = await request(selector, [
        {
          ...parentProof,
          details: {
            ...parentProof.details,
            ownerSessionId: randomUUID(),
          },
        },
      ]);
      assert.equal(broken.details.error.category, "invalid_request");
    }
    sourceEntries.pop();
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }

  try {
    for (const proof of [
      [parentProof],
      [
        ownershipResult(sourceId, LEAD_SESSION_ID, {
          path: sourcePath,
          label: "owned-source",
        }),
      ],
    ]) {
      if (proof[0] !== parentProof) nativeSessions.delete(parentId);
      {
        const startup = startupExecutor(
          "owned-source",
          () => DEFAULT_PI_SESSION_ID,
        );
        const owner = fakePi({ exec: startup.exec });
        registerExtension!(owner.pi as never);
        try {
          const result = await agentTool(owner, "continue").execute(
            "id",
            { session: sourceId, task: "follow up" },
            undefined,
            undefined,
            fakeContext(proof),
          );
          assert.equal(result.details.ok, true, JSON.stringify(result.details));
        } finally {
          owner.events.get("session_shutdown")?.[0]();
          startup.stopMailboxConsumer();
          resetAgentMailbox(startup.mailbox);
        }
      }
    }
  } finally {
    nativeSessions.clear();
    realFs.rmSync(sourcePath, { force: true });
    realFs.rmSync(parentPath, { force: true });
  }
});

test("copied fork result history does not invalidate the original owner edge", async () => {
  setLeadEnvironment();
  const parentId = randomUUID();
  const childId = randomUUID();
  const forkId = randomUUID();
  const childPath = join(testTmpRoot, `fork-history-child-${childId}.jsonl`);
  const parentPath = join(testTmpRoot, `fork-history-parent-${parentId}.jsonl`);
  const parentEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: parentId, definition: "agent", label: "parent" },
    },
    ownershipResult(childId, parentId, { path: childPath, label: "child" }),
  ];
  realFs.writeFileSync(childPath, "{}", "utf8");
  realFs.writeFileSync(parentPath, "{}", "utf8");
  nativeSessions.clear();
  nativeSessions.set(parentId, {
    id: parentId,
    path: parentPath,
    entries: parentEntries,
  });
  nativeSessions.set(forkId, {
    id: forkId,
    path: join(testTmpRoot, `fork-history-fork-${forkId}.jsonl`),
    entries: [...parentEntries],
  });
  nativeSessions.set(childId, {
    id: childId,
    path: childPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: childId, definition: "agent", label: "child" },
      },
    ],
  });
  const startup = startupExecutor("child", () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      { session: childId, task: "follow up" },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(parentId, LEAD_SESSION_ID, {
          path: parentPath,
          label: "parent",
        }),
      ]),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    nativeSessions.clear();
    realFs.rmSync(childPath, { force: true });
    realFs.rmSync(parentPath, { force: true });
  }
});

test("historical continuation re-parenting preserves every valid ownership path", async () => {
  setLeadEnvironment();
  const parentId = randomUUID();
  const childId = DEFAULT_PI_SESSION_ID;
  const outsiderId = randomUUID();
  const childPath = join(testTmpRoot, `reparented-${childId}.jsonl`);
  const parentPath = join(testTmpRoot, `reparent-owner-${parentId}.jsonl`);
  realFs.writeFileSync(childPath, "{}", "utf8");
  realFs.writeFileSync(parentPath, "{}", "utf8");
  const parentEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: parentId, definition: "agent", label: "parent" },
    },
    ownershipResult(childId, parentId, { path: childPath, label: "child" }),
  ];
  const leadEntries = [
    ownershipResult(parentId, LEAD_SESSION_ID, {
      path: parentPath,
      label: "parent",
    }),
  ];
  nativeSessions.clear();
  nativeSessions.set(parentId, {
    id: parentId,
    path: parentPath,
    entries: parentEntries,
  });
  nativeSessions.set(childId, {
    id: childId,
    path: childPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: childId, definition: "agent", label: "child" },
      },
    ],
  });
  const request = async (entries: unknown[], callerId = LEAD_SESSION_ID) => {
    const startup = startupExecutor("child", () => childId);
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    try {
      const context = fakeContext(entries) as any;
      context.sessionManager.getSessionId = () => callerId;
      const result = await agentTool(pi, "continue").execute(
        "id",
        { session: childId, task: "continue child" },
        undefined,
        undefined,
        context,
      );
      if (result.details.ok) assert.equal(result.details.session_id, childId);
      return result;
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      startup.stopMailboxConsumer();
      resetAgentMailbox(startup.mailbox);
    }
  };
  try {
    const first = await request(leadEntries);
    assert.equal(first.details.ok, true, JSON.stringify(first.details));
    const fromParent = await request(parentEntries, parentId);
    assert.equal(
      fromParent.details.ok,
      true,
      JSON.stringify(fromParent.details),
    );
    // The completed continuation delivers a new result for the same Pi ID
    // directly to L, without erasing P's older child result.
    leadEntries.push(
      ownershipResult(childId, LEAD_SESSION_ID, {
        path: childPath,
        label: "child",
      }),
    );
    const repeated = await request(leadEntries);
    assert.equal(repeated.details.ok, true, JSON.stringify(repeated.details));
    const unrelated = await request([], outsiderId);
    assert.equal(unrelated.details.error.category, "invalid_request");
    const malformed = ownershipResult(childId, parentId, {
      path: childPath,
      label: "child",
    });
    (malformed.details as any).status = "unknown";
    parentEntries.push(malformed);
    assert.equal((await request(leadEntries)).details.ok, true);
    parentEntries.pop();
    const childEntries = nativeSessions.get(childId)!.entries;
    childEntries.push(
      ownershipResult(parentId, childId, { path: parentPath, label: "parent" }),
    );
    assert.equal((await request(leadEntries)).details.ok, true);
  } finally {
    nativeSessions.clear();
    realFs.rmSync(childPath, { force: true });
    realFs.rmSync(parentPath, { force: true });
  }
});

test("session assignment fails closed on duplicate live representations", async () => {
  setLeadEnvironment();
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ae",
    path: join(testTmpRoot, "duplicate-live-session.jsonl"),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "018f2f2e-7b13-7abc-8def-0123456789ae",
          definition: "agent",
          label: "session-conflict-label",
        },
      },
    ],
  };
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const first = managedState(
    "duplicate-live-one",
    undefined,
    recoveryIdentity("duplicate-live-one"),
  );
  const second = {
    ...managedState(
      "duplicate-live-two",
      undefined,
      recoveryIdentity("duplicate-live-two"),
    ),
    piSessionId: session.id,
    piSessionFile: session.path,
  };
  first.piSessionId = session.id;
  first.piSessionFile = session.path;
  const mailboxes = [first, second].map((state) => {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    return mailbox;
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && (isAgentList(args) || isApiSnapshot(args)))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agents: [agentFromState(first), agentFromState(second)],
              snapshot: {
                agents: [agentFromState(first), agentFromState(second)],
                panes: [first, second].map((state) => ({
                  pane_id: state.paneId,
                  workspace_id: state.workspaceId,
                  cwd: state.cwd,
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: state.piSessionId,
                  },
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "continue the ambiguous session",
      },
      undefined,
      undefined,
      fakeContext([
        ownershipResult(session.id, LEAD_SESSION_ID, {
          path: session.path,
          label: "session-conflict-label",
        }),
      ]),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    realFs.rmSync(session.path, { force: true });
  }
});

test("registered agent validates duplicate agents and selectors before lifecycle use", async () => {
  setLeadEnvironment();
  const label = "duplicate-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, undefined, identity));
  const duplicate = fakePi({
    exec: leadExec(
      label,
      "idle",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(duplicate.pi as never);
  await duplicate.events.get("session_start")![0](undefined, fakeContext());
  const tool = duplicate.tools.find(
    (candidate) => candidate.name === "agent_delegate",
  )!;
  assert.equal(tool.name, "agent_delegate");
  assert.equal(
    duplicate.tools.some((candidate) => candidate.name === "subagent"),
    false,
  );
  assert.equal(duplicate.commandOptions.has("agents"), true);
  assert.equal(duplicate.commandOptions.has("subagents"), false);
  const context = fakeContext();
  const duplicateResult = await tool.execute(
    "id",
    {
      definition: "agent",
      label,
      task: "duplicate task",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(duplicateResult.details.error.category, "agent_label_exists");
  assert.equal(
    duplicate.calls.some((args) => args.includes("--env")),
    false,
  );
  const missingAgentTask = await tool.execute(
    "id",
    { definition: "agent" },
    undefined,
    undefined,
    context,
  );
  assert.equal(missingAgentTask.details.error.category, "invalid_request");
  const continueTool = duplicate.tools.find(
    (candidate) => candidate.name === "agent_continue",
  )!;
  const substitutedResume = await continueTool.execute(
    "id",
    {
      session: "/tmp/missing-session.jsonl",
      task: "continue",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(substitutedResume.details.error.category, "invalid_request");
  duplicate.events.get("session_shutdown")?.[0]();
});

test("registered delegate protects a live mailbox owned by another owner", async () => {
  setLeadEnvironment();
  const label = "reviewer";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = {
    ...managedState(label, undefined, defaultFixtureIdentity),
    ownerSessionId: "owner-a",
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: state.paneId,
    kind: "task",
    text: "preserve me",
    createdAt: Date.now(),
  });
  writeResult(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: state.paneId,
    status: "completed",
    text: "preserve this result",
    completedAt: Date.now(),
  });
  const before = readFileSync(`${mailbox}/state.json`, "utf8");
  const requestBefore = readFileSync(
    `${mailbox}/request-${REQUEST_ID}.json`,
    "utf8",
  );
  const resultBefore = readFileSync(
    `${mailbox}/result-${REQUEST_ID}.json`,
    "utf8",
  );
  const startup = startupExecutor("agent-2", () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const tool = agentTool(pi, "delegate");
  const result = await tool.execute(
    "id",
    { definition: "agent", label, task: "preserve me" },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.error.category, "agent_label_exists");
  assert.equal(
    pi.calls.some((args) => args.includes("--placement")),
    false,
  );
  assert.equal(readFileSync(`${mailbox}/state.json`, "utf8"), before);
  assert.equal(
    readFileSync(`${mailbox}/request-${REQUEST_ID}.json`, "utf8"),
    requestBefore,
  );
  assert.equal(
    readFileSync(`${mailbox}/result-${REQUEST_ID}.json`, "utf8"),
    resultBefore,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startup.mailbox);
});

test("fresh assignments do not reset an unacknowledged stale mailbox", async () => {
  setLeadEnvironment();
  const automaticLabel = "agent";
  const automaticMailbox = agentMailboxPath(WORKSPACE, automaticLabel);
  const automaticState = managedState(automaticLabel);
  const automaticRequestId = randomUUID();
  writeAgentState(automaticMailbox, automaticState);
  writeRequest(automaticMailbox, {
    version: 5,
    runId: automaticState.runId,
    requestId: automaticRequestId,
    ownerSessionId: automaticState.ownerSessionId,
    workspaceId: automaticState.workspaceId,
    agentLabel: automaticState.agentLabel,
    paneId: automaticState.paneId,
    kind: "task",
    text: "preserve automatic handoff",
    createdAt: Date.now(),
  });
  const automaticStartup = startupExecutor(
    automaticLabel + "-2",
    () => DEFAULT_PI_SESSION_ID,
  );
  const automaticPi = fakePi({ exec: automaticStartup.exec });
  registerExtension!(automaticPi.pi as never);
  const automatic = await agentTool(automaticPi, "delegate").execute(
    "id",
    {
      definition: "agent",
      task: "use the next safe label",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(automatic.details.ok, true, JSON.stringify(automatic.details));
  assert.equal(automatic.details.agent, `${automaticLabel}-2`);
  assert.ok(readRequest(automaticMailbox, automaticRequestId));
  automaticPi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(automaticStartup.mailbox);
});

test("request-only mailbox remnants reserve their labels", async () => {
  setLeadEnvironment();
  const explicitLabel = "request-only-explicit";
  const explicitMailbox = agentMailboxPath(WORKSPACE, explicitLabel);
  const explicitRequestId = randomUUID();
  writeRequest(explicitMailbox, {
    version: 5,
    runId: AGENT_ID,
    requestId: explicitRequestId,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: explicitLabel,
    paneId: "request-only-pane",
    kind: "task",
    text: "retain this request-only remnant",
    createdAt: Date.now(),
  });
  resetAgentMailbox(explicitMailbox);

  setLeadEnvironment();
  const automaticLabel = "agent";
  const automaticMailbox = agentMailboxPath(WORKSPACE, automaticLabel);
  const automaticRequestId = randomUUID();
  writeRequest(automaticMailbox, {
    version: 5,
    runId: AGENT_ID,
    requestId: automaticRequestId,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: automaticLabel,
    paneId: "request-only-pane",
    kind: "task",
    text: "retain this request-only remnant",
    createdAt: Date.now(),
  });
  const automaticStartup = startupExecutor(
    `${automaticLabel}-2`,
    () => DEFAULT_PI_SESSION_ID,
  );
  const automaticPi = fakePi({ exec: automaticStartup.exec });
  registerExtension!(automaticPi.pi as never);
  const automatic = await agentTool(automaticPi, "delegate").execute(
    "id",
    {
      definition: "agent",
      task: "choose the next safe label",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(automatic.details.ok, true, JSON.stringify(automatic.details));
  assert.equal(automatic.details.agent, `${automaticLabel}-2`);
  assert.ok(readRequest(automaticMailbox, automaticRequestId));
  automaticPi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(automaticStartup.mailbox);
  resetAgentMailbox(automaticMailbox);
});

test("assignment retains its request when acknowledgement never arrives", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  startup.stopMailboxConsumer();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10).unref();
  const pi = fakePi({
    exec: startup.exec,
  });
  registerExtension!(pi.pi as never);
  const result = await agentTool(pi, "delegate").execute(
    "id",
    {
      definition: "agent",
      task: "retain on timeout",
    },
    controller.signal,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.ok, false);
  assert.equal(
    realFs
      .readdirSync(startup.mailbox)
      .filter((name) => name.startsWith("request-") && name.endsWith(".json"))
      .length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startup.mailbox);
});

test("registered lead exposes only explicit live controls", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const label = "action-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const steerFile = join(testTmpRoot, `${label}-update.md`);
  realFs.writeFileSync(steerFile, "steer evidence");
  let steerSubmitted: RequestRecord | undefined;
  const accepting = fakePi({
    activeTools: [],
    allTools: () => accepting.tools,
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
        steerSubmitted = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
      },
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(accepting.pi as never);
  assert.equal(
    accepting.tools.some((candidate) => candidate.name === "subagent"),
    false,
  );
  const tool = accepting.tools.find(
    (candidate) => candidate.name === "agent_list",
  )!;
  const context = fakeContext(accepting.entries);
  await accepting.events.get("session_start")![0](
    undefined,
    fakeContext(accepting.entries),
  );
  assert.deepEqual(accepting.pi.getActiveTools(), [
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
  const listed = await tool.execute("id", {}, undefined, undefined, context);
  assert.deepEqual(listed.details.agents[0].available_tools, [
    "agent_inspect",
    "agent_steer",
    "agent_interrupt",
    "agent_close",
  ]);
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    build: OTHER_HERDSMAN_BUILD,
  });
  const steerTool = accepting.tools.find(
    (candidate) => candidate.name === "agent_steer",
  )!;
  const rejectedSteer = await steerTool.execute(
    "id",
    { agent: label, message: "must not publish" },
    undefined,
    undefined,
    context,
  );
  assert.equal(rejectedSteer.details.error.category, "incompatible_build");
  assert.equal(steerSubmitted, undefined);
  assert.ok(
    accepting.tools.some((candidate) => candidate.name === "agent_close"),
  );
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    build: HERDSMAN_BUILD,
  });
  const steer = await steerTool.execute(
    "id",
    { agent: label, message: "continue", files: [steerFile] },
    undefined,
    undefined,
    context,
  );
  assert.equal(steer.details.ok, true);
  assert.equal(steer.details.action, "steer");
  assert.equal(steer.details.agent, label);
  assert.equal(steer.details.session_id, identity.piSessionId);
  assert.equal(steer.details.assignment_request_id, REQUEST_ID);
  assert.equal(steer.details.presentation_agent_definition, "agent");
  assert.equal(steer.details.truncated, false);
  assert.equal(steerSubmitted?.kind, "steer");
  assert.match(steerSubmitted?.text ?? "", /steer evidence/);
  assert.equal(steerSubmitted?.requestId, steer.details.request_id);
  assert.match(
    (steer.content[0] as { text: string }).text,
    new RegExp(`Session: ${identity.piSessionId}`),
  );
  assert.match(
    (steer.content[0] as { text: string }).text,
    /Assignment request: /,
  );
  const rendered = accepting.tools
    .find((candidate) => candidate.name === "agent_steer")!
    .renderResult(
      { content: steer.content, details: steer.details },
      { expanded: true, isPartial: false },
      { fg: (_color: string, text: string) => text },
      { args: { agent: label, message: "continue" } },
    );
  assert.match(rendered.text, new RegExp(`session: ${identity.piSessionId}`));
  assert.match(rendered.text, /assignment request: /);
  let interruptSubmitted: RequestRecord | undefined;
  const interruptPi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
        interruptSubmitted = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
      },
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(interruptPi.pi as never);
  const interruptContext = fakeContext(interruptPi.entries);
  await interruptPi.events.get("session_start")![0](
    undefined,
    interruptContext,
  );
  const interrupt = await agentTool(interruptPi, "interrupt").execute(
    "interrupt",
    {
      agent: label,
      message: "Stop and use the fallback.",
    },
    undefined,
    undefined,
    interruptContext,
  );
  assert.equal(interrupt.details.ok, true);
  assert.equal(interrupt.details.action, "interrupt");
  assert.equal(interrupt.details.assignment_request_id, REQUEST_ID);
  assert.equal(interruptSubmitted?.kind, "interrupt");
  assert.equal(interruptSubmitted?.text, "Stop and use the fallback.");
  interruptPi.events.get("session_shutdown")?.[0]();
  accepting.events.get("session_shutdown")?.[0]();
  realFs.rmSync(steerFile, { force: true });
});

test("successful controls persist their definition before runtime teardown", async () => {
  for (const action of ["steer", "reply", "inspect"] as const) {
    setLeadEnvironment();
    const label = `persisted-${action}`;
    const identity = recoveryIdentity(label);
    const requestId = randomUUID();
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const state = {
      ...managedState(
        label,
        action === "inspect" ? undefined : requestId,
        identity,
      ),
      agentDefinition: "agent",
    };
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    const askId = randomUUID();
    if (action === "reply") {
      writeAgentState(mailbox, { ...state, pendingAskId: askId });
      writeAsk(mailbox, {
        version: 5,
        askId,
        requestId,
        runId: state.runId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        piSessionId: state.piSessionId,
        question: "Which provider should I use?",
        createdAt: Date.now(),
      });
    }
    let pi: ReturnType<typeof fakePi>;
    let context = fakeContext();
    let tornDown = false;
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      for (const handler of pi.events.get("session_shutdown") ?? [])
        handler(undefined, context);
    };
    const acknowledgeAndTearDown = (requestMailbox: string, marker: string) => {
      const observedRequestId = marker.slice(
        "__PI_HERDSMAN_AGENT_V5__:".length,
      );
      const current = readAgentState(requestMailbox)!;
      writeAgentState(requestMailbox, {
        ...current,
        lastAck: {
          requestId: observedRequestId,
          accepted: true,
          acknowledgedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      teardown();
    };
    const baseExec = leadExec(
      label,
      "working",
      identity.piSessionId,
      action === "inspect" ? undefined : acknowledgeAndTearDown,
      identity.piSessionId,
      identity,
    );
    const exec = async (command: string, args: string[], options: any) => {
      const result = await baseExec(command, args, options);
      if (
        action === "inspect" &&
        command === "herdr" &&
        args[0] === "agent" &&
        args[1] === "get"
      )
        teardown();
      return result;
    };
    pi = fakePi({ exec });
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, context);
      const result = await agentTool(pi, action).execute(
        action,
        {
          agent: label,
          ...(action !== "inspect" ? { message: "Continue." } : {}),
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(result.details.presentation_agent_definition, "agent");
      assert.doesNotMatch(
        (result.content[0] as { text: string }).text,
        /presentation_agent_definition/,
      );
    } finally {
      teardown();
      resetAgentMailbox(mailbox);
    }
  }
});

test("lead steers a blocked parent waiting for direct-child work", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "steerable-parent",
      REQUEST_ID,
      recoveryIdentity("steerable-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/steerable-parent.jsonl",
  };
  const child = {
    ...managedState(
      "steerable-child",
      randomUUID(),
      recoveryIdentity("steerable-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/steerable-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  const foreignChildMailbox = agentMailboxPath(
    "foreign-steerable-workspace",
    "foreign-steerable-child",
  );
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  resetAgentMailbox(foreignChildMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const childBefore = readAgentState(childMailbox);
  const observedParent = { ...parent, activeRequestId: undefined };
  let parentStatus: "idle" | "working" = "idle";
  const base = agentControllerExecutor(observedParent, [child]);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && (isAgentList(args) || isApiSnapshot(args))) {
        const liveParent = readAgentState(parentMailbox) ?? observedParent;
        const liveChild = readAgentState(childMailbox) ?? child;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agents: [
                agentFromState(liveParent, parentStatus),
                agentFromState(
                  liveChild,
                  liveChild.activeRequestId ? "working" : "idle",
                ),
              ],
              snapshot: {
                agents: [
                  agentFromState(liveParent, parentStatus),
                  agentFromState(
                    liveChild,
                    liveChild.activeRequestId ? "working" : "idle",
                  ),
                ],
                panes: [liveParent, liveChild].map((state) => ({
                  pane_id: state.paneId,
                  workspace_id: state.workspaceId,
                  cwd: state.cwd,
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: state.piSessionId,
                  },
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (
        command === "herdr" &&
        args[0] === "agent" &&
        args[1] === "get" &&
        args[2] === parent.paneId
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agent: {
                ...agentFromState(observedParent, parentStatus),
                session_id: parent.piSessionId,
                session_path: parent.piSessionFile,
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return base(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const listed = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(
      listed.details.agents[0]?.state,
      "blocked",
      JSON.stringify(listed.details),
    );
    assert.ok(listed.details.agents[0].available_tools.includes("agent_steer"));
    const listedChild = (listed.details.agents as any[]).find(
      (agent) => agent.agent === child.agentLabel,
    );
    assert.deepEqual(listedChild?.available_tools, []);

    parentStatus = "working";
    const workingParent = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(workingParent.details.agents[0].state, "working");
    assert.ok(
      workingParent.details.agents[0].available_tools.includes("agent_steer"),
    );
    assert.ok(
      workingParent.details.agents[0].available_tools.includes(
        "agent_interrupt",
      ),
    );
    assert.equal(
      listed.details.agents[0].available_tools.includes("agent_interrupt"),
      false,
    );

    parentStatus = "idle";
    writeAgentState(childMailbox, {
      ...child,
      activeRequestId: undefined,
      completedRequestId: undefined,
    });
    const noChildWork = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(noChildWork.details.agents[0].state, "settling");
    assert.ok(
      !noChildWork.details.agents[0].available_tools.includes("agent_steer"),
    );

    writeAgentState(foreignChildMailbox, {
      ...child,
      workspaceId: "foreign-steerable-workspace",
      agentLabel: "foreign-steerable-child",
      activeRequestId: randomUUID(),
    });
    const foreignWorkspaceChild = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.ok(
      !foreignWorkspaceChild.details.agents[0].available_tools.includes(
        "agent_steer",
      ),
    );
    resetAgentMailbox(foreignChildMailbox);
    writeAgentState(childMailbox, child);

    writeAgentState(childMailbox, {
      ...child,
      ownerSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const otherOwnerChild = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.ok(
      !otherOwnerChild.details.agents[0].available_tools.includes(
        "agent_steer",
      ),
    );
    writeAgentState(childMailbox, child);

    writeAgentState(parentMailbox, {
      ...parent,
      activeRequestId: undefined,
    });
    const noParentAssignment = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.ok(
      !noParentAssignment.details.agents[0].available_tools.includes(
        "agent_steer",
      ),
    );
    writeAgentState(parentMailbox, parent);

    const handoffRequestId = randomUUID();
    writeRequest(parentMailbox, {
      version: 5,
      runId: parent.runId,
      requestId: handoffRequestId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      kind: "task",
      text: "pending handoff",
      createdAt: Date.now(),
    });
    const handoffPending = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(handoffPending.details.agents[0].state, "settling");
    assert.ok(
      !handoffPending.details.agents[0].available_tools.includes("agent_steer"),
    );
    removeRequest(parentMailbox, handoffRequestId);

    const steered = await agentTool(pi, "steer").execute(
      "steer",
      { agent: parent.agentLabel, message: "continue" },
      undefined,
      undefined,
      context,
    );
    assert.equal(steered.details.ok, true, JSON.stringify(steered.details));
    assert.equal(readAgentState(parentMailbox)?.activeRequestId, REQUEST_ID);
    assert.deepEqual(readAgentState(childMailbox), childBefore);

    writeAgentState(childMailbox, {
      ...child,
      activeRequestId: undefined,
      completedRequestId: child.activeRequestId,
    });
    writeResult(childMailbox, {
      version: 5,
      runId: child.runId,
      requestId: child.activeRequestId!,
      ownerSessionId: child.ownerSessionId,
      workspaceId: child.workspaceId,
      agentLabel: child.agentLabel,
      paneId: child.paneId,
      status: "completed",
      text: "child result",
      completedAt: Date.now(),
    });
    assert.ok(readResult(childMailbox, child.activeRequestId!));
    const completedChild = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(completedChild.details.agents[0].state, "blocked");
    assert.ok(
      completedChild.details.agents[0].available_tools.includes("agent_steer"),
    );
    assert.equal(
      readAgentState(childMailbox)?.completedRequestId,
      child.activeRequestId,
    );

    const ownerAskId = randomUUID();
    writeAsk(parentMailbox, {
      version: 5,
      askId: ownerAskId,
      requestId: REQUEST_ID,
      runId: parent.runId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      piSessionId: parent.piSessionId,
      question: "owner clarification",
      createdAt: Date.now(),
    });
    writeAgentState(parentMailbox, {
      ...parent,
      pendingAskId: ownerAskId,
    });
    const ownerAsk = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(ownerAsk.details.agents[0].state, "blocked");
    assert.deepEqual(ownerAsk.details.agents[0].available_tools, [
      "agent_inspect",
      "agent_reply",
    ]);
    removeAsk(parentMailbox, ownerAskId);
    writeAgentState(parentMailbox, parent);

    writeAgentState(parentMailbox, {
      ...parent,
      activeRequestId: undefined,
      completedRequestId: REQUEST_ID,
    });
    writeResult(parentMailbox, {
      version: 5,
      runId: parent.runId,
      requestId: REQUEST_ID,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      status: "completed",
      text: "parent result while child result is pending",
      completedAt: Date.now(),
    });
    const completionWithChild = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(completionWithChild.details.agents[0].state, "settling");
    assert.ok(
      !completionWithChild.details.agents[0].available_tools.includes(
        "agent_steer",
      ),
    );
    writeAgentState(parentMailbox, parent);

    removeResult(childMailbox, child.activeRequestId!);
    assert.equal(
      readAgentState(childMailbox)?.completedRequestId,
      child.activeRequestId,
    );
    const completedChildWithoutResult = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(
      completedChildWithoutResult.details.agents[0].available_tools.includes(
        "agent_steer",
      ),
      false,
    );

    writeAgentState(parentMailbox, {
      ...parent,
      activeRequestId: undefined,
      completedRequestId: REQUEST_ID,
    });
    writeResult(parentMailbox, {
      version: 5,
      runId: parent.runId,
      requestId: REQUEST_ID,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      status: "completed",
      text: "parent result",
      completedAt: Date.now(),
    });
    const ownCompletion = await agentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(ownCompletion.details.agents[0].state, "settling");
    assert.ok(
      !ownCompletion.details.agents[0].available_tools.includes("agent_steer"),
    );
    const rejected = await agentTool(pi, "steer").execute(
      "steer",
      { agent: parent.agentLabel, message: "late" },
      undefined,
      undefined,
      context,
    );
    assert.equal(rejected.details.error.category, "agent_busy");
    assert.match(
      rejected.details.error.message,
      /not currently accepting steering/,
    );

    pi.events.get("session_shutdown")?.[0]();
    const restarted = fakePi({
      exec: (command, args, options) => {
        if (
          command === "herdr" &&
          args[0] === "agent" &&
          args[1] === "get" &&
          args[2] === parent.paneId
        )
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                agent: {
                  ...agentFromState(observedParent, parentStatus),
                  session_id: parent.piSessionId,
                  session_path: parent.piSessionFile,
                },
              },
            }),
            stderr: "",
            code: 0,
          };
        return base(command, args, options);
      },
    });
    registerExtension!(restarted.pi as never);
    const restartedList = await agentTool(restarted, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.ok(
      !restartedList.details.agents[0].available_tools.includes("agent_steer"),
    );
    restarted.events.get("session_shutdown")?.[0]();

    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    const recoveredPositive = fakePi({ exec: base });
    registerExtension!(recoveredPositive.pi as never);
    const recoveredPositiveList = await agentTool(
      recoveredPositive,
      "list",
    ).execute("list", {}, undefined, undefined, fakeContext());
    assert.ok(
      recoveredPositiveList.details.agents[0].available_tools.includes(
        "agent_steer",
      ),
    );
    recoveredPositive.events.get("session_shutdown")?.[0]();
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    resetAgentMailbox(foreignChildMailbox);
  }
});

test("acknowledgement state-write failures retain requests for durable retry", () => {
  const cases = [
    {
      name: "busy rejection",
      kind: "task" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      expected: {
        accepted: false,
        code: "busy" as const,
        message: "Agent already has an active assignment",
      },
    },
    {
      name: "idle rejection",
      kind: "steer" as const,
      isIdle: true,
      expected: {
        accepted: false,
        code: "idle" as const,
        message: "Agent is not accepting steering",
      },
    },
    {
      name: "successful steer delivery",
      kind: "steer" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      expected: { accepted: true },
    },
    {
      name: "failed steer delivery",
      kind: "steer" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      deliveryFailure: true,
      expected: { accepted: true },
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const label = `ack-retry-${index}`;
    const mailbox = setAgentEnvironment(label);
    const activeRequestId = scenario.activeRequestId;
    writeAgentState(mailbox, managedState(label, activeRequestId));
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext();
    (context as any).isIdle = () => scenario.isIdle;
    agent.events.get("session_start")![0](undefined, context);
    if (scenario.deliveryFailure)
      agent.pi.sendUserMessage = () => {
        throw new Error("injected steer delivery failure");
      };

    const started = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 5,
      runId: started.runId,
      requestId: randomUUID(),
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: scenario.kind,
      text: scenario.name,
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    support.failNextMailboxWrite = true;
    const input = agent.events.get("input")![0];
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      { action: "handled" },
    );
    assert.equal(readAgentState(mailbox)?.lastAck, undefined);
    assert.ok(readRequest(mailbox, request.requestId));
    assert.equal(agent.sentUsers.length, 0);

    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      scenario.expected.accepted
        ? { action: "transform", text: request.text }
        : { action: "handled" },
    );
    const acknowledged = readAgentState(mailbox)?.lastAck;
    assert.equal(acknowledged?.requestId, request.requestId, scenario.name);
    assert.equal(acknowledged?.accepted, scenario.expected.accepted);
    assert.equal(acknowledged?.code, scenario.expected.code);
    assert.equal(acknowledged?.message, scenario.expected.message);
    if (scenario.expected.accepted)
      assert.ok(readRequest(mailbox, request.requestId));
    else assert.equal(readRequest(mailbox, request.requestId), undefined);
    assert.equal(agent.sentUsers.length, 0);
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("assignment status normalization fails closed safely", async () => {
  const cases = [
    {
      suffix: "available",
      status: "done" as const,
      result: false,
      expectedState: "settling",
    },
    {
      suffix: "working",
      status: "working" as const,
      result: false,
      expectedState: "unknown",
    },
    {
      suffix: "pending",
      status: "done" as const,
      result: true,
      expectedState: "settling",
    },
    {
      suffix: "null-status",
      status: "done" as const,
      agentStatus: null,
      result: false,
      expectedState: "unknown",
    },
    {
      suffix: "unsupported-status",
      status: "done" as const,
      agentStatus: "interactive",
      result: false,
      expectedState: "unknown",
    },
  ];
  for (const scenario of cases) {
    setLeadEnvironment();
    const label = `status-${scenario.suffix}`;
    const identity = recoveryIdentity(label);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    const state = managedState(label, undefined, identity);
    writeAgentState(mailbox, state);
    if (scenario.result) {
      state.completedRequestId = REQUEST_ID;
      writeAgentState(mailbox, state);
      writeResult(mailbox, {
        version: 5,
        runId: AGENT_ID,
        requestId: REQUEST_ID,
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: identity.paneId,
        status: "completed",
        text: "pending",
        completedAt: Date.now(),
      });
    }
    const pi = fakePi({
      exec: leadExec(
        label,
        scenario.status,
        identity.piSessionId,
        (requestMailbox, marker) => {
          const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
          const current = readAgentState(requestMailbox)!;
          writeAgentState(requestMailbox, {
            ...current,
            lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
            updatedAt: Date.now(),
          });
        },
        identity.piSessionId,
        identity,
        true,
        scenario.agentStatus,
      ),
    });
    try {
      registerExtension!(pi.pi as never);
      const context = fakeContext();
      const listed = await agentTool(pi, "list").execute(
        "list",
        {},
        undefined,
        undefined,
        context,
      );
      const agents = (listed.details as { agents: any[] }).agents;
      assert.equal(agents.length, 1);
      assert.equal(agents[0].state, scenario.expectedState);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
  await (async () => {
    setLeadEnvironment();
    const label = "mailbox-eligibility-agent";
    const identity = recoveryIdentity(label);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const state = managedState(label, undefined, identity);
    writeAgentState(mailbox, state);
    const pi = fakePi({
      exec: leadExec(
        label,
        "idle",
        identity.piSessionId,
        (requestMailbox, marker) => {
          const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
          const current = readAgentState(requestMailbox)!;
          writeAgentState(requestMailbox, {
            ...current,
            activeRequestId: requestId,
            completedRequestId: undefined,
            lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
            updatedAt: Date.now(),
          });
        },
        identity.piSessionId,
        identity,
      ),
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext();
    try {
      const handoffRequestId = randomUUID();
      writeRequest(mailbox, {
        version: 5,
        runId: state.runId,
        requestId: handoffRequestId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        kind: "task",
        text: "recover this handoff",
        createdAt: Date.now(),
      });
      await pi.events.get("session_start")![0](undefined, context);
      const handoffList = await agentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        context,
      );
      assert.equal(handoffList.details.agents[0].state, "settling");
      assert.equal(
        handoffList.details.agents[0].available_tools.includes(
          "agent_delegate",
        ),
        false,
      );
      removeRequest(mailbox, handoffRequestId);

      const requestA = randomUUID();
      writeAgentState(mailbox, {
        ...state,
        activeRequestId: requestA,
      });
      const activeList = await agentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        context,
      );
      assert.equal(activeList.details.agents[0].state, "settling");
      assert.equal(activeList.details.agents[0].active_request_id, requestA);
      assert.equal(
        activeList.details.agents[0].available_tools.includes("agent_delegate"),
        false,
      );

      writeAgentState(mailbox, {
        ...state,
        completedRequestId: requestA,
      });
      writeResult(mailbox, {
        version: 5,
        runId: state.runId,
        requestId: requestA,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        status: "completed",
        text: "done",
        completedAt: Date.now(),
      });
      const completedList = await agentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        context,
      );
      assert.equal(completedList.details.agents[0].state, "settling");
      assert.equal(
        completedList.details.agents[0].available_tools.includes(
          "agent_delegate",
        ),
        false,
      );

      removeResult(mailbox, requestA);
      const settledList = await agentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        context,
      );
      assert.equal(settledList.details.agents[0].state, "settling");
      assert.deepEqual(settledList.details.agents[0].available_tools, [
        "agent_inspect",
        "agent_close",
      ]);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  })();
});

test("agent list schema rejects unknown fields", () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const schema = agentTool(pi, "list").parameters;
  assert.equal(Value.Check(schema, {}), true);
  assert.equal(Value.Check(schema, { unknown: true }), false);
  pi.events.get("session_shutdown")?.[0]();
});

test("transcript projects persisted agent evidence without Herdr terminal reads", async () => {
  setLeadEnvironment();
  const label = "transcript-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}.jsonl`),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  realFs.rmSync(identity.piSessionFile, { force: true });
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const session = {
    id: identity.piSessionId,
    path: identity.piSessionFile,
    contextEntries: [
      {
        type: "custom_message",
        customType: "private-test",
        content: "INTERNAL CUSTOM MESSAGE",
        display: false,
      },
      {
        type: "message",
        message: { role: "system", content: "INTERNAL SYSTEM MESSAGE" },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Inspect the controller path." }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE REASONING" },
            { type: "text", text: "I will inspect the implementation." },
            {
              type: "toolCall",
              id: "call-running",
              name: "read",
              arguments: { path: "extension/index.ts", limit: 100 },
            },
          ],
          stopReason: "toolUse",
        },
      },
    ],
  };
  const writeSession = (): void => {
    const entries = session.contextEntries.map((entry, index) => ({
      ...entry,
      id: `entry-${index}`,
      ...(index ? { parentId: `entry-${index - 1}` } : {}),
      timestamp: new Date().toISOString(),
    }));
    realFs.writeFileSync(
      identity.piSessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: identity.piSessionId,
          timestamp: new Date().toISOString(),
          cwd: "/tmp",
        }),
        ...entries.map((entry) => JSON.stringify(entry)),
      ].join("\n") + "\n",
    );
  };
  nativeSessions.set(identity.piSessionId, session);
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  try {
    const before = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(
      before.details.agents[0].available_tools.includes("agent_transcript"),
      false,
    );
    const pending = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(pending.details.error.category, "agent_busy");
    assert.match(
      pending.details.error.message,
      /Pi has not persisted this agent's session file/,
    );
    assert.equal(realFs.existsSync(identity.piSessionFile), false);

    writeSession();
    const ready = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(
      ready.details.agents[0].available_tools.includes("agent_transcript"),
      true,
    );
    const result = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.ok, true);
    assert.equal(result.details.action, "transcript");
    assert.equal(result.details.agent, label);
    assert.equal(result.details.session_id, identity.piSessionId);
    assert.match(result.details.transcript, /Inspect the controller path/);
    assert.match(
      result.details.transcript,
      /I will inspect the implementation/,
    );
    assert.match(result.details.transcript, /tool read:/);
    assert.doesNotMatch(result.details.transcript, /PRIVATE REASONING/);
    assert.doesNotMatch(result.details.transcript, /INTERNAL CUSTOM MESSAGE/);
    assert.doesNotMatch(result.details.transcript, /INTERNAL SYSTEM MESSAGE/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "read"),
      false,
    );

    session.contextEntries = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "original user evidence" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "abandoned assistant evidence" }],
        },
      },
      {
        type: "context_edit",
        targetId: "entry-0",
        replacement: {
          content: [{ type: "text", text: "replacement user evidence" }],
        },
      },
      {
        type: "context_edit",
        targetId: "entry-1",
        replacement: null,
      },
    ];
    writeSession();
    const edited = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.match(edited.details.transcript, /replacement user evidence/);
    assert.doesNotMatch(edited.details.transcript, /original user evidence/);
    assert.doesNotMatch(
      edited.details.transcript,
      /abandoned assistant evidence/,
    );

    session.contextEntries = [
      ...session.contextEntries,
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "tool completed" }],
        },
      },
    ];
    writeSession();
    const completed = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.match(completed.details.transcript, /tool result read:/);

    const hugeToolResult =
      "TOOL-BEGIN\n" +
      "🙂".repeat(700) +
      "MIDDLE-SENTINEL" +
      "界".repeat(900) +
      "\nTOOL-END";
    session.contextEntries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "before large tool evidence" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: hugeToolResult }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "after large tool evidence" }],
        },
      },
    ];
    writeSession();
    const boundedTool = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(boundedTool.details.transcript_truncated, true);
    assert.match(boundedTool.details.transcript, /TOOL-BEGIN/);
    assert.match(boundedTool.details.transcript, /TOOL-END/);
    assert.match(
      boundedTool.details.transcript,
      /\[\.\.\. middle of tool result omitted \.\.\.\]/,
    );
    assert.doesNotMatch(boundedTool.details.transcript, /MIDDLE-SENTINEL/);
    assert.doesNotMatch(boundedTool.details.transcript, /�/);
    assert.match(boundedTool.details.transcript, /before large tool evidence/);
    assert.match(boundedTool.details.transcript, /after large tool evidence/);
    assert.ok(
      Buffer.byteLength(boundedTool.details.transcript, "utf8") <= 16 * 1024,
    );

    session.contextEntries = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "old evidence ".repeat(2000) }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "recent tail evidence" }],
        },
      },
    ];
    writeSession();
    const bounded = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(bounded.details.transcript_truncated, true);
    assert.ok(
      Buffer.byteLength(bounded.details.transcript, "utf8") <= 16 * 1024,
    );
    assert.match(bounded.details.transcript, /recent tail evidence/);
    assert.doesNotMatch(bounded.details.transcript, /old evidence/);

    realFs.writeFileSync(identity.piSessionFile, "");
    const emptyList = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(
      emptyList.details.agents[0].available_tools.includes("agent_transcript"),
      false,
    );
    const emptyBefore = readFileSync(identity.piSessionFile, "utf8");
    const emptyStatBefore = realFs.statSync(identity.piSessionFile);
    const rejected = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(rejected.details.ok, false);
    assert.equal(rejected.details.error.category, "agent_busy");
    assert.match(
      rejected.details.error.message,
      /Pi has not persisted this agent's session file/,
    );
    assert.equal(readFileSync(identity.piSessionFile, "utf8"), emptyBefore);
    const emptyStatAfter = realFs.statSync(identity.piSessionFile);
    assert.equal(emptyStatAfter.size, emptyStatBefore.size);
    assert.equal(emptyStatAfter.mtimeMs, emptyStatBefore.mtimeMs);
    realFs.writeFileSync(
      identity.piSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        timestamp: new Date().toISOString(),
        cwd: "/tmp",
      })}\n`,
    );
    const mismatched = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(mismatched.details.error.category, "target_not_found");
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(identity.piSessionId);
    realFs.rmSync(identity.piSessionFile, { force: true });
    resetAgentMailbox(mailbox);
  }
});
