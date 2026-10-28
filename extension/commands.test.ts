import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mock, test, type TestContext } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import {
  acquireProcessLock,
  claimProcessLock,
  ProcessLockOccupiedError,
  readLiveProcessLock,
} from "./lock.ts";
import {
  claimChiefLease as claimChiefLeaseRaw,
  globalProjectAssignmentSnapshot,
  listPendingRetirements,
  listProjectAssignments,
  listProjectMessages,
  projectAssignmentPath,
  listCoordinationMessagePaths,
  managerDescriptorPath,
  claimManagerLease,
  removeChiefMessage,
  readChiefMessage,
  readProjectAssignment,
  readManagerDescriptor,
  peerLeadLockPath,
  peerRuntime,
  readPeerLeadRecord,
  removePeerLeadRecord,
  supervisionRuntime,
  readLeadCoordinationState,
  sessionLeadRoleState as readLeadRoleState,
  readSessionKind,
  writeLeadCoordinationState as writeLeadCoordinationStateRaw,
  writeProjectAssignment,
  removeProjectAssignment,
  removeProjectMessagesForAssignment,
  writeChiefMessage as writeChiefMessageRaw,
  writeCoordinationMessage as writeCoordinationMessageRaw,
  writePeerLeadRecord as writePeerLeadRecordRaw,
} from "./supervision.ts";
import { OperationError } from "./errors.ts";
import { AGENT_COORDINATION_TOOLS } from "./agent-definitions.ts";
import {
  herdsmanTempRoot,
  readRequiredEvidenceSnapshot,
  resultPath,
} from "./storage.ts";
import { claimDelegationLock } from "./agent-controller.ts";
import {
  createLeadCommandRuntime,
  createLeadProjectRuntime,
} from "./lead-runtime.ts";

test("Manager required-evidence removal is exact, assignment-scoped, and fail-closed", async () => {
  const manager = {
    piSessionId: "evidence-manager",
    repoKey: "evidence-repo",
    workspaceId: "evidence-workspace",
    leaseId: "lease-1",
  } as any;
  const assignment = {
    version: 2 as const,
    id: "assignment-current",
    repoKey: manager.repoKey,
    branch: "feature/evidence",
    text: "work",
    requiredEvidence: [
      {
        id: "local-a",
        name: "same-name.md",
        sourceAssignmentId: "assignment-current",
        path: "/immutable/a",
        sha256: "a".repeat(64),
      },
      {
        id: "local-b",
        name: "same-name.md",
        sourceAssignmentId: "assignment-current",
        path: "/immutable/b",
        sha256: "b".repeat(64),
      },
      {
        id: "inherited",
        name: "baseline.md",
        sourceAssignmentId: "parent-assignment",
        path: "/immutable/baseline",
        sha256: "c".repeat(64),
      },
    ],
  };
  let current = assignment;
  let leaseId = "lease-1";
  let role = "manager";
  let changeRoleUnderLock = false;
  const storedSnapshots = new Set([
    "/immutable/a",
    "/immutable/b",
    "/immutable/baseline",
  ]);
  const acceptedEvidence = [...assignment.requiredEvidence];
  const runtime = createLeadProjectRuntime({
    leadRuntime: { roleSuspended: false } as any,
    activeRole: () => role,
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: { ...manager, leaseId } }),
    sameManagerDescriptor: (left: any, right: any) =>
      left.piSessionId === right.piSessionId && left.leaseId === right.leaseId,
    worktreeGroupScope: async () => ({
      repoKey: manager.repoKey,
      primaryWorkspaceId: "unrelated-repository-workspace",
    }),
    supervisionRuntime: () => ({}),
    readProjectAssignment: () => current,
    listProjectAssignments: () => [current],
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => Promise<unknown>,
    ) => {
      if (changeRoleUnderLock) role = "lead";
      return operation();
    },
    writeProjectAssignment: (_runtime: unknown, next: any) => {
      current = next;
    },
    resolveMessageFiles: () => [],
    persistRequiredTextFiles: () => [],
  } as any);
  const ctx = fakeContext() as any;
  for (const unauthorizedRole of ["lead", "chief"]) {
    role = unauthorizedRole;
    await assert.rejects(
      runtime.updateAssignmentEvidence(
        "unauthorized",
        { branch: assignment.branch, remove: ["local-a"] },
        undefined,
        undefined,
        ctx,
      ),
      /Only the Manager can update assignment required evidence/,
    );
    assert.deepEqual(current, assignment);
  }
  role = "manager";
  changeRoleUnderLock = true;
  await assert.rejects(
    runtime.updateAssignmentEvidence(
      "role-changed",
      { branch: assignment.branch, remove: ["local-a"] },
      undefined,
      undefined,
      ctx,
    ),
    /Manager authority changed/,
  );
  assert.deepEqual(current, assignment);
  changeRoleUnderLock = false;
  role = "manager";
  const before = await runtime.inspectRequiredEvidence(assignment.branch, ctx);
  assert.equal(
    before.requiredEvidence?.find((item) => item.id === "inherited")
      ?.sourceAssignmentId,
    "parent-assignment",
  );

  // Cancel means the UI does not invoke the removal callback.
  const confirmation = "cancel";
  if (confirmation === "confirm")
    await runtime.removeRequiredEvidence(assignment.branch, "local-a", ctx);
  assert.deepEqual(
    current.requiredEvidence?.map((item) => item.id),
    ["local-a", "local-b", "inherited"],
  );

  // IDs, not duplicate display names, identify the selected requirement.
  await runtime.removeRequiredEvidence(
    assignment.branch,
    "local-b",
    before,
    ctx,
  );
  assert.deepEqual(
    current.requiredEvidence?.map((item) => item.id),
    ["local-a", "inherited"],
  );
  assert.deepEqual(
    [...storedSnapshots],
    ["/immutable/a", "/immutable/b", "/immutable/baseline"],
  );
  const afterRemoval = await runtime.inspectRequiredEvidence(
    assignment.branch,
    ctx,
  );
  await assert.rejects(
    runtime.removeRequiredEvidence(
      assignment.branch,
      "inherited",
      afterRemoval,
      ctx,
    ),
    /Inherited required evidence cannot be removed/,
  );

  const inspected = await runtime.inspectRequiredEvidence(
    assignment.branch,
    ctx,
  );
  current = {
    ...inspected,
    id: "replacement-assignment",
    requiredEvidence: inspected.requiredEvidence?.map((entry) =>
      entry.id === "local-a"
        ? { ...entry, sourceAssignmentId: "replacement-assignment" }
        : entry,
    ),
  };
  // A confirmation applies to the exact assignment shown, not a replacement
  // that happens to reuse the same branch and evidence ID.
  await assert.rejects(
    runtime.removeRequiredEvidence(
      assignment.branch,
      "local-a",
      inspected,
      ctx,
    ),
    /Project assignment changed/,
  );
  assert.deepEqual(
    current.requiredEvidence?.map(({ id }) => id),
    ["local-a", "inherited"],
  );
  current = assignment;
  await runtime.inspectRequiredEvidence(assignment.branch, ctx);
  leaseId = "lease-replaced";
  await assert.rejects(
    runtime.removeRequiredEvidence(
      assignment.branch,
      "local-a",
      assignment,
      ctx,
    ),
    /Manager (?:authority changed|lease is no longer active)/,
  );
  assert.deepEqual(
    [...storedSnapshots],
    ["/immutable/a", "/immutable/b", "/immutable/baseline"],
  );
  assert.deepEqual(
    acceptedEvidence.map(({ id }) => id),
    ["local-a", "local-b", "inherited"],
  );
});

test("Manager Required evidence route removes persisted evidence and cancellation preserves it", async (t) => {
  const { createLeadSupervisionRuntime } = await import("./lead-runtime.ts");
  setLeadEnvironment();
  const socket = join(tmpdir(), `manager-evidence-ui-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtimeStorage = supervisionRuntime(socket);
  t.after(() => {
    rmSync(runtimeStorage.root, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  class Container {
    addChild() {}
    clear() {}
    render() {
      return [];
    }
  }
  class SelectList {
    selectedIndex = 0;
    onSelect?: (item: any) => void;
    readonly items: any[];
    constructor(items: any[]) {
      this.items = items;
    }
    setSelectedIndex(index: number) {
      this.selectedIndex = index;
    }
    handleInput(data: string) {
      if (data === "\r") this.onSelect?.(this.items[this.selectedIndex]);
    }
  }
  class Text {
    constructor(..._args: any[]) {}
  }
  class DynamicBorder {
    constructor(..._args: any[]) {}
  }
  const fixtureDir = mkdtempSync(join(tmpdir(), "manager-evidence-route-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const baselineSnapshotPath = join(fixtureDir, "baseline-review.md");
  const snapshotPath = join(fixtureDir, "required-review.md");
  const assignmentId = randomUUID();
  const evidenceId1 = randomUUID();
  const evidenceId2 = randomUUID();
  const snapshotBytes = "immutable evidence snapshot\n";
  writeFileSync(baselineSnapshotPath, "baseline snapshot\n");
  writeFileSync(snapshotPath, snapshotBytes);
  const acceptedAgentStatePath = join(fixtureDir, "accepted-agent.jsonl");
  const acceptedAgentStateBytes = `${JSON.stringify({ assignment: assignmentId, acceptedEvidence: [evidenceId2] })}\n`;
  writeFileSync(acceptedAgentStatePath, acceptedAgentStateBytes);
  const assignment = {
    version: 2 as const,
    id: assignmentId,
    repoKey: "repo-ui",
    branch: "feature/ui-evidence",
    text: "work",
    requiredEvidence: [
      {
        id: evidenceId1,
        name: "shared.md",
        sourceAssignmentId: assignmentId,
        path: baselineSnapshotPath,
        sha256: createHash("sha256")
          .update("baseline snapshot\n")
          .digest("hex"),
      },
      {
        id: evidenceId2,
        name: "shared.md",
        sourceAssignmentId: assignmentId,
        path: snapshotPath,
        sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
      },
    ],
  };
  writeProjectAssignment(runtimeStorage, assignment);
  const managerLease = claimManagerLease(
    {
      build: HERDSMAN_BUILD,
      piSessionId: "manager-ui",
      paneId: "manager-ui-pane",
      tabId: "manager-ui-tab",
      repoKey: assignment.repoKey,
      workspaceId: WORKSPACE,
    },
    runtimeStorage,
  );
  t.after(() => managerLease.release());
  const manager = managerLease.descriptor;
  const projectRuntime = createLeadProjectRuntime({
    leadRuntime: { roleSuspended: false } as any,
    activeRole: () => "manager",
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: (left: any, right: any) =>
      left.piSessionId === right.piSessionId && left.leaseId === right.leaseId,
    worktreeGroupScope: async () => ({
      repoKey: manager.repoKey,
      primaryWorkspaceId: manager.workspaceId,
    }),
    supervisionRuntime: () => runtimeStorage,
    readProjectAssignment,
    listProjectAssignments,
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => Promise<unknown>,
    ) => operation(),
    writeProjectAssignment,
    resolveMessageFiles: () => [],
  } as any);
  const snapshot = {
    workspaces: [],
    project: "ui-project",
    work: [{ branch: assignment.branch, session: "lead-ui", status: "active" }],
    leads: [],
  };
  const state = {
    chiefMode: "inactive",
    controllerRole: "manager",
    roleSuspended: false,
    managerLease: undefined,
    chiefLease: undefined,
    leadContext: undefined,
    chiefModeGeneration: 0,
    sessionGeneration: 0,
    chiefActivationRollback: false,
    instanceId: "ui-test",
  };
  const runtime = createLeadSupervisionRuntime({
    activeRole: () => "manager",
    state,
    pi: {},
    herdrSessionSnapshot: async () => ({
      agents: [],
      panes: [],
      workspaces: [],
    }),
    managedAgentSnapshots: async () => ({ agents: [] }),
    loadSnapshot: async () => snapshot,
    managerSupervisionItems: (value: any) =>
      value.work.map((work: any) => ({ kind: "work", work })),
    presentationReports: () => [],
    orderedSupervisionLeads: () => [],
    formatSupervisionNotification: () => "",
    tui: {
      Container,
      SelectList,
      Text,
      DynamicBorder,
      matchesKey: () => false,
      Key: { ctrl: () => "" },
    },
  } as any);
  const ctx = fakeContext() as any;
  ctx.mode = "tui";
  const notices: string[] = [];
  ctx.ui.notify = (message: string) => notices.push(message);
  let component: any;
  let customCalls = 0;
  const menuTitles: string[] = [];
  const removals: Array<{ branch: string; id: string; assignment: unknown }> =
    [];
  const runRoute = async (confirmation: "confirm" | "cancel") => {
    customCalls = 0;
    await runtime.refresh(ctx);
    ctx.ui.custom = (factory: any) => {
      customCalls++;
      if (customCalls > 1) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
        setImmediate(() => component.handleInput("\r"));
      });
    };
    const menuChoices = [
      "required-evidence",
      evidenceId2,
      "remove",
      confirmation,
    ];
    let choice = 0;
    await runtime.openOverview(ctx, {
      focusLead: async () => undefined,
      stopProjectLead: async () => undefined,
      activateProjectLead: async () => undefined,
      removeWorktree: async () => {
        throw new Error("unexpected worktree removal");
      },
      inspectRequiredEvidence: (branch: string, context: any) =>
        projectRuntime.inspectRequiredEvidence(branch, context),
      removeRequiredEvidence: async (
        branch: string,
        id: string,
        selected: unknown,
      ) => {
        removals.push({ branch, id, assignment: selected });
        await projectRuntime.removeRequiredEvidence(
          branch,
          id,
          selected as any,
          ctx,
        );
      },
      selectMenu: async (
        _ctx: unknown,
        title: string,
        items: readonly any[],
      ) => {
        menuTitles.push(title);
        if (title.startsWith("Retained evidence ·")) {
          assert.deepEqual(
            items.map((item) => item.value),
            [evidenceId1, evidenceId2],
          );
          assert.ok(
            items[1].label.includes(
              `${evidenceId2} · shared.md · project ${assignmentId}`,
            ),
          );
        }
        if (
          title ===
          `${evidenceId2}\nshared.md\nOrigin: project assignment ${assignmentId}`
        )
          assert.ok(items.some((item) => item.value === "remove"));
        return menuChoices[choice++];
      },
    } as any);
  };

  const beforeCancel = readProjectAssignment(
    runtimeStorage,
    assignment.repoKey,
    assignment.branch,
  );
  await runRoute("cancel");
  assert.deepEqual(
    readProjectAssignment(
      runtimeStorage,
      assignment.repoKey,
      assignment.branch,
    ),
    beforeCancel,
    "cancel preserves the persisted ProjectAssignment",
  );
  assert.deepEqual(
    readFileSync(baselineSnapshotPath, "utf8"),
    "baseline snapshot\n",
  );
  assert.deepEqual(readFileSync(snapshotPath, "utf8"), snapshotBytes);
  assert.deepEqual(
    readFileSync(acceptedAgentStatePath, "utf8"),
    acceptedAgentStateBytes,
  );
  assert.deepEqual(notices, []);
  assert.deepEqual(removals, []);

  menuTitles.length = 0;
  await runRoute("confirm");
  assert.deepEqual(notices, [
    "Required evidence removed. Existing Agent assignments and snapshots are unchanged.",
  ]);
  assert.deepEqual(menuTitles, [
    "feature/ui-evidence",
    "Retained evidence · feature/ui-evidence",
    `${evidenceId2}\nshared.md\nOrigin: project assignment ${assignmentId}`,
    `Remove required evidence ${evidenceId2}?`,
  ]);
  assert.deepEqual(removals, [
    { branch: assignment.branch, id: evidenceId2, assignment: beforeCancel },
  ]);
  const afterConfirm = readProjectAssignment(
    runtimeStorage,
    assignment.repoKey,
    assignment.branch,
  );
  assert.equal(afterConfirm?.id, beforeCancel?.id);
  assert.equal(afterConfirm?.branch, beforeCancel?.branch);
  assert.deepEqual(
    afterConfirm?.requiredEvidence?.map(({ id }) => id),
    [evidenceId1],
  );
  assert.deepEqual(
    readFileSync(baselineSnapshotPath, "utf8"),
    "baseline snapshot\n",
  );
  assert.deepEqual(readFileSync(snapshotPath, "utf8"), snapshotBytes);
  assert.deepEqual(
    readFileSync(acceptedAgentStatePath, "utf8"),
    acceptedAgentStateBytes,
  );
  assert.ok(
    menuTitles.some((title) =>
      title.startsWith(`Remove required evidence ${evidenceId2}?`),
    ),
  );
});

test("registered Manager command removes persisted required evidence through the production bridge", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "evidence-manager-pane";
  process.env.HERDR_TAB_ID = "evidence-manager-tab";
  const socket = join(tmpdir(), `manager-evidence-bridge-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const storage = supervisionRuntime(socket);
  const assignmentId = randomUUID();
  const evidenceId = randomUUID();
  const fixtureDir = mkdtempSync(join(tmpdir(), "manager-evidence-bridge-"));
  const repoKey = fixtureDir;
  const snapshotPath = join(fixtureDir, "required.md");
  writeFileSync(snapshotPath, "required evidence\n");
  writeProjectAssignment(storage, {
    version: 2,
    id: assignmentId,
    repoKey,
    branch: "feature/evidence-bridge",
    text: "work",
    requiredEvidence: [
      {
        id: evidenceId,
        name: "required.md",
        sourceAssignmentId: assignmentId,
        path: snapshotPath,
        sha256: createHash("sha256")
          .update("required evidence\n")
          .digest("hex"),
      },
    ],
  });
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: async (command, args) => {
      if (command === "git" && args[0] === "rev-parse")
        return { stdout: fixtureDir, stderr: "", code: 0 };
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            workspace_id: WORKSPACE,
            worktree: null,
          },
        });
      if (args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: repoKey,
            repo_name: "project",
          },
          worktrees: [],
        });
      if (args[0] === "pane" && args[1] === "get")
        return respond({
          pane: {
            pane_id: args[2],
            workspace_id: WORKSPACE,
            tab_id: process.env.HERDR_TAB_ID,
          },
        });
      if (args[0] === "tab" && args[1] === "list")
        return respond({
          tabs: [
            { tab_id: process.env.HERDR_TAB_ID, number: 1, label: "Manager" },
          ],
        });
      if (isAgentList(args))
        return respond({ agents: [managerAgentIdentity()] });
      if (args[0] === "agent" && args[1] === "get")
        return respond({ agent: managerAgentIdentity() });
      if (isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
      return respond({});
    },
  });
  const context = fakeContext() as any;
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.mode = "rpc";
  context.hasUI = true;
  const selected: string[] = [];
  context.ui.custom = async (factory: any) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return new Promise((resolve, reject) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, value: string) => value,
          bold: (value: string) => value,
        },
        {},
        resolve,
      );
      const rendered = component.render(120).join("\n");
      if (
        notices?.includes(
          "Required evidence removed. Existing Agent assignments and snapshots are unchanged.",
        ) &&
        (rendered.includes("Pi Herdsman · project") ||
          rendered.includes("Pi Herdsman · unavailable"))
      ) {
        setImmediate(() => component.handleInput("\u001b"));
        return;
      }
      const choice = rendered.includes("Pi Herdsman · project")
        ? "feature/evidence-bridge"
        : rendered.includes("Remove requirement")
          ? "Remove requirement"
          : rendered.includes(evidenceId)
            ? evidenceId
            : rendered.includes("Retained evidence")
              ? "Retained evidence"
              : undefined;
      assert.ok(choice, `unexpected menu:\n${rendered}`);
      assert.ok(
        rendered.includes(choice),
        `expected ${choice} in menu:\n${rendered}`,
      );
      selected.push(choice);
      setImmediate(() => {
        try {
          selectTuiItem(component, choice);
        } catch (error) {
          reject(error);
        }
      });
    });
  };
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    rmSync(storage.root, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("manager").handler("", context);
  assert.equal(
    readLeadCoordinationState(storage, LEAD_SESSION_ID)?.role,
    "manager",
    notices.join("\n"),
  );
  context.mode = "tui";
  await pi.commandOptions.get("manager").handler("", context);
  assert.deepEqual(selected.slice(0, 5), [
    "feature/evidence-bridge",
    "Retained evidence",
    evidenceId,
    "Remove requirement",
    "Remove requirement",
  ]);
  assert.ok(
    notices.includes(
      "Required evidence removed. Existing Agent assignments and snapshots are unchanged.",
    ),
  );
  assert.deepEqual(
    readProjectAssignment(storage, "evidence-repo", "feature/evidence-bridge")
      ?.requiredEvidence,
    undefined,
  );
});

const peerTopologyExec = (_command: string, args: string[]) =>
  args[0] === "worktree" && args[1] === "list"
    ? {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            source: {
              repo_key: "peer-test-repo",
              repo_name: "peer-test-repo",
              source_workspace_id: WORKSPACE,
            },
            worktrees: [],
          },
        }),
        stderr: "",
        code: 0,
      }
    : { stdout: "{}", stderr: "", code: 0 };
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
  agentControllerExecutor,
  cascadeExecutor,
  delegatedLifecycleExecutor,
  defaultFixtureIdentity,
  discoverAgent,
  discoverAgentDefinitions,
  fakeContext,
  fakePi,
  fakeAgentContext,
  herdrAlias,
  isApiSnapshot,
  isAgentList,
  isPreservePaneStop,
  isPaneList,
  isTabList,
  listResponse,
  managedState,
  nativeSessions,
  readAgentState,
  readResult,
  realFs,
  recoveryIdentity,
  registerExtension,
  registerExtensionForTest,
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
import {
  createLeadToolState,
  sessionLeadExecutionState as readLeadExecutionState,
} from "./lead-runtime.ts";

const leadTools = [
  "list_agents",
  "delegate_agent",
  "continue_agent",
  "steer_agent",
  "interrupt_agent",
  "reply_agent",
  "close_agent",
  "inspect_agent",
  "read_agent_transcript",
  "message_supervisor",
  "list_peers",
  "message_peer",
];
const managerTools = [
  "message_supervisor",
  "list_peers",
  "message_peer",
  "list_staff",
  "inspect_staff",
  "read_staff_transcript",
  "message_staff",
  "delegate_work",
  "resume_work",
  "stop_lead",
  "remove_worktree",
  "integrate_branch",
];
const chiefTools = [
  "list_staff",
  "inspect_staff",
  "read_staff_transcript",
  "message_staff",
];

const sessionLeadExecutionState = (
  entries: readonly unknown[],
  sessionId = LEAD_SESSION_ID,
) => readLeadExecutionState(entries, sessionId);
const sessionLeadRoleState = (
  entries: readonly unknown[],
  sessionId = LEAD_SESSION_ID,
) => readLeadRoleState(entries, sessionId);

test("Lead execution state is strict and profile tools preserve only Lead capabilities", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-lead-execution",
      data: {
        sessionId: LEAD_SESSION_ID,
        mode: "orchestrate",
        leadTools: ["read", "bash"],
      },
    },
  ];
  assert.deepEqual(sessionLeadExecutionState(entries), {
    mode: "orchestrate",
    leadTools: ["read", "bash"],
  });
  assert.throws(
    () =>
      sessionLeadExecutionState([
        {
          ...entries[0],
          data: { sessionId: LEAD_SESSION_ID, mode: "invalid", leadTools: [] },
        },
      ]),
    /invalid pi-herdsman-lead-execution entry/,
  );
  assert.throws(
    () =>
      sessionLeadExecutionState([
        {
          ...entries[0],
          data: { sessionId: LEAD_SESSION_ID, mode: "invalid", leadTools: [] },
        },
        entries[0],
      ]),
    /invalid pi-herdsman-lead-execution entry/,
    "a later valid preference cannot hide malformed same-session history",
  );
  const state = createLeadToolState(
    () =>
      [
        "read",
        "bash",
        "grep",
        "delegate_agent",
        "message_supervisor",
        "list_staff",
      ].map((name) => ({ name })),
    ["delegate_agent", "list_staff"],
    ["delegate_agent", "message_supervisor"],
  );
  const baseline = ["read", "bash", "grep"];
  const projection = state.projectLeadTools(baseline, {
    name: "orchestrator-lead",
    path: "orchestrator-lead.md",
    frontmatter: {
      name: "orchestrator-lead",
      tools: ["read", "list_staff", "delegate_agent", "missing"],
      excludeTools: ["read"],
    },
    body: "",
  });
  assert.deepEqual(projection, ["delegate_agent", "message_supervisor"]);
  assert.deepEqual(
    state.projectLeadTools(baseline, {
      name: "orchestrator-lead",
      path: "orchestrator-lead.md",
      frontmatter: { name: "orchestrator-lead", tools: [] },
      body: "",
    }),
    ["delegate_agent", "message_supervisor"],
  );
  assert.deepEqual(
    state.projectLeadTools(baseline, {
      name: "orchestrator-lead",
      path: "orchestrator-lead.md",
      frontmatter: {
        name: "orchestrator-lead",
        tools: ["b*", "gr*"],
        excludeTools: ["gr*"],
      },
      body: "",
    }),
    ["bash", "delegate_agent", "message_supervisor"],
  );
  assert.deepEqual(
    state.projectLeadTools(baseline, {
      name: "flexible-lead",
      path: "flexible-lead.md",
      frontmatter: { name: "flexible-lead" },
      body: "",
    }),
    [...baseline, "delegate_agent", "message_supervisor"],
  );
});

test("managed identity survives tree and assignment loss while native new-session history is isolated", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `immutable-lead-${randomUUID()}.sock`,
  );
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "peer-test-repo",
    branch: "immutable-project",
    text: "project",
  };
  writeProjectAssignment(supervisionRuntime(), assignment);
  let entries: any[] = [];
  const pi = fakeChiefPi({
    entries,
    activeTools: ["read"],
    exec: peerTopologyExec,
  });
  pi.pi.appendEntry = (customType: string, data: unknown) =>
    entries.push({ type: "custom", customType, data });
  const context = fakeContext(entries) as any;
  let sessionId = LEAD_SESSION_ID;
  let branch = entries;
  context.sessionManager.getSessionId = () => sessionId;
  context.sessionManager.getEntries = () => entries;
  context.sessionManager.getBranch = () => branch;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    removeProjectAssignment(
      supervisionRuntime(),
      assignment.repoKey,
      assignment.branch,
    );
    removeProjectAssignment(
      supervisionRuntime(),
      assignment.repoKey,
      "forbidden-promotion",
    );
    setLeadEnvironment();
  });
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(readSessionKind(entries, sessionId), {
    version: 1,
    sessionId,
    kind: "managed",
    repoKey: assignment.repoKey,
    branch: assignment.branch,
  });
  assert.equal(
    entries.filter((entry) => entry.customType === "pi-herdsman-session-kind")
      .length,
    1,
  );
  branch = [];
  await pi.events.get("session_tree")![0](undefined, context);
  assert.equal(readSessionKind(entries, sessionId)?.kind, "managed");
  await pi.commandOptions.get("lead").handler("flexible", context);
  assert.ok(notices.some((message) => message.includes("Managed Leads")));
  removeProjectAssignment(
    supervisionRuntime(),
    assignment.repoKey,
    assignment.branch,
  );
  await pi.events.get("session_tree")![0](undefined, context);
  assert.equal(readSessionKind(entries, sessionId)?.kind, "managed");
  for (const tool of [
    "read",
    "delegate_agent",
    "continue_agent",
    "delegate_work",
    "list_staff",
  ])
    assert.equal(pi.pi.getActiveTools().includes(tool), false, tool);
  assert.equal(pi.pi.getActiveTools().includes("inspect_agent"), false);
  assert.equal(pi.pi.getActiveTools().includes("close_agent"), false);
  const result = await pi.tools
    .find((tool) => tool.name === "delegate_agent")!
    .execute(
      "inactive",
      { definition: "agent", task: "must not start" },
      undefined,
      undefined,
      context,
    );
  assert.equal(result.details.ok, false);
  const managedEntries = entries;
  entries = [
    ...entries,
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { sessionId, role: "chief", leadTools: ["bash"] },
    },
    {
      type: "custom",
      customType: "pi-herdsman-lead-execution",
      data: { sessionId, mode: "orchestrate", leadTools: ["bash"] },
    },
  ];
  sessionId = randomUUID();
  branch = entries;
  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(readSessionKind(entries, sessionId)?.kind, "ordinary");
  assert.equal(
    readSessionKind(managedEntries, LEAD_SESSION_ID)?.kind,
    "managed",
  );
  assert.equal(pi.pi.getActiveTools().includes("list_staff"), false);
  assert.equal(pi.pi.getActiveTools().includes("bash"), false);
  await pi.commandOptions.get("lead").handler("flexible", context);
  assert.equal(sessionLeadExecutionState(entries, sessionId)?.mode, "flexible");
  const ordinaryId = sessionId;
  writeProjectAssignment(supervisionRuntime(), {
    ...assignment,
    id: ordinaryId,
    branch: "forbidden-promotion",
  });
  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(readSessionKind(entries, sessionId)?.kind, "ordinary");
  assert.ok(
    entries.some((entry) =>
      String(entry.data?.error).includes("Session identity conflicts"),
    ),
  );
  assert.equal(pi.pi.getActiveTools().includes("delegate_agent"), false);
  const rejected = await pi.tools
    .find((tool) => tool.name === "delegate_agent")!
    .execute(
      "contradictory",
      { definition: "agent", task: "must not start" },
      undefined,
      undefined,
      context,
    );
  assert.equal(
    rejected.details.ok,
    false,
    "contradictory assignment leaves ordinary delegation policy unavailable",
  );
});

test("unverifiable exact assignment initialization never persists ordinary identity", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `unknown-identity-${randomUUID()}.sock`,
  );
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "peer-test-repo",
    branch: "unknown-project",
    text: "project",
  };
  writeProjectAssignment(supervisionRuntime(), assignment);
  let herdrAvailable = false;
  let releaseSnapshot!: (result: ExecResult) => void;
  let snapshotRequested!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    snapshotRequested = resolve;
  });
  const pi = fakeChiefPi({
    exec: (_command, args) =>
      herdrAvailable
        ? args[0] === "worktree" && args[1] === "list"
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: {
                  source: {
                    repo_key: assignment.repoKey,
                    repo_name: "project",
                    source_workspace_id: WORKSPACE,
                  },
                  worktrees: [
                    {
                      open_workspace_id: WORKSPACE,
                      branch: assignment.branch,
                      path: process.cwd(),
                      is_linked_worktree: true,
                    },
                  ],
                },
              }),
              stderr: "",
              code: 0,
            }
          : { stdout: "{}", stderr: "", code: 0 }
        : isApiSnapshot(args)
          ? new Promise<ExecResult>((resolve) => {
              releaseSnapshot = resolve;
              snapshotRequested();
            })
          : { stdout: "", stderr: "Herdr disconnected", code: 1 },
  });
  const context = fakeContext(pi.entries) as any;
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    removeProjectAssignment(
      supervisionRuntime(),
      assignment.repoKey,
      assignment.branch,
    );
    setLeadEnvironment();
  });
  const starting = pi.events.get("session_start")![0](undefined, context);
  await snapshotStarted;
  assert.equal(readSessionKind(pi.entries, LEAD_SESSION_ID), undefined);
  assert.deepEqual(
    pi.pi.getActiveTools(),
    [],
    "unknown identity exposes no tools while startup evidence is pending",
  );
  releaseSnapshot({ stdout: "", stderr: "Herdr disconnected", code: 1 });
  await starting;
  assert.equal(
    pi.pi
      .getActiveTools()
      .some((name) => AGENT_COORDINATION_TOOLS.includes(name as never)),
    false,
    "unknown identity exposes no coordination tools during pending execution",
  );
  assert.ok(
    pi.entries.some((entry: any) =>
      String(entry.data?.error).includes("Herdr disconnected"),
    ),
  );
  herdrAvailable = true;
  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(readSessionKind(pi.entries, LEAD_SESSION_ID)?.kind, "managed");
  assert.equal(
    pi.pi.getActiveTools().includes("delegate_agent"),
    true,
    "an exact assigned Managed Lead receives its managed coordination tools",
  );
});

test("known managed identity remains unavailable and recovery-only when startup scope is unverifiable", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-scope-${randomUUID()}.sock`,
  );
  const identity = {
    version: 1 as const,
    sessionId: LEAD_SESSION_ID,
    kind: "managed" as const,
    repoKey: "peer-test-repo",
    branch: "known-project",
  };
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: identity.repoKey,
    branch: identity.branch,
    text: "project",
  };
  writeProjectAssignment(supervisionRuntime(), assignment);
  const pi = fakeChiefPi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-session-kind",
        data: identity,
      },
    ],
    exec: () => ({ stdout: "", stderr: "Herdr disconnected", code: 1 }),
  });
  const context = fakeContext(pi.entries) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    removeProjectAssignment(
      supervisionRuntime(),
      assignment.repoKey,
      assignment.branch,
    );
    setLeadEnvironment();
  });

  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(readSessionKind(pi.entries, LEAD_SESSION_ID)?.kind, "managed");
  assert.deepEqual(
    pi.pi.getActiveTools(),
    [],
    "uncertain scope grants neither fresh work nor global peer/supervisor tools",
  );
  await pi.commandOptions.get("lead")!.handler("flexible", context);
  assert.ok(
    notices.some((message) => message.includes("Managed Leads")),
    "managed sessions cannot select an ordinary execution profile",
  );
  assert.equal(
    pi.pi
      .getActiveTools()
      .some((tool) =>
        [
          "list_staff",
          "message_peer",
          "message_supervisor",
          "delegate_agent",
          "continue_agent",
        ].includes(tool),
      ),
    false,
  );

  let presentation: string[] = [];
  context.mode = "rpc";
  context.ui.select = async (_title: string, items: string[]) => {
    presentation = items;
    return undefined;
  };
  await pi.commandOptions.get("herdsman")!.handler("", context);
  assert.ok(
    presentation.some((item) =>
      /^Execution\s+managed · unavailable$/u.test(item),
    ),
  );
  assert.ok(
    pi.entries.some((entry: any) =>
      String(entry.data?.error).includes("Herdr disconnected"),
    ),
  );
});

test("managed pending execution projects only exact-owner recovery tools", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-pending-tools-${randomUUID()}.sock`,
  );
  const sessionId = LEAD_SESSION_ID;
  const identity = {
    version: 1 as const,
    sessionId,
    kind: "managed" as const,
    repoKey: "peer-test-repo",
    branch: "pending-project",
  };
  const mailbox = agentMailboxPath(WORKSPACE, "pending-owned-agent");
  writeAgentState(mailbox, managedState("pending-owned-agent"));
  let releaseSnapshot!: (result: ExecResult) => void;
  let snapshotRequested!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    snapshotRequested = resolve;
  });
  const pi = fakeChiefPi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-session-kind",
        data: identity,
      },
    ],
    exec: (_command, args) =>
      isApiSnapshot(args)
        ? new Promise<ExecResult>((resolve) => {
            releaseSnapshot = resolve;
            snapshotRequested();
          })
        : { stdout: "", stderr: "Herdr disconnected", code: 1 },
  });
  const context = fakeContext(pi.entries) as any;
  context.sessionManager.getSessionId = () => sessionId;
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    rmSync(mailbox, { recursive: true, force: true });
    setLeadEnvironment();
  });

  const starting = pi.events.get("session_start")![0](undefined, context);
  await snapshotStarted;
  const recoveryTools = AGENT_COORDINATION_TOOLS.filter(
    (name) => name !== "delegate_agent" && name !== "continue_agent",
  );
  assert.deepEqual(pi.pi.getActiveTools(), recoveryTools);
  releaseSnapshot({ stdout: "", stderr: "Herdr disconnected", code: 1 });
  await starting;
  assert.equal(
    pi.pi
      .getActiveTools()
      .some((name) =>
        [
          "delegate_agent",
          "continue_agent",
          "message_supervisor",
          "list_peers",
          "message_peer",
        ].includes(name),
      ),
    false,
  );
});

test("managed pending startup without owned Agents exposes no coordination tools", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-pending-no-agents-${randomUUID()}.sock`,
  );
  const sessionId = LEAD_SESSION_ID;
  const pi = fakeChiefPi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-session-kind",
        data: {
          version: 1,
          sessionId,
          kind: "managed",
          repoKey: "peer-test-repo",
          branch: "pending-project",
        },
      },
    ],
    exec: (_command, args) =>
      isApiSnapshot(args)
        ? new Promise<ExecResult>((resolve) => {
            releaseSnapshot = resolve;
            snapshotRequested();
          })
        : { stdout: "", stderr: "Herdr disconnected", code: 1 },
  });
  let releaseSnapshot!: (result: ExecResult) => void;
  let snapshotRequested!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    snapshotRequested = resolve;
  });
  const context = fakeContext(pi.entries) as any;
  context.sessionManager.getSessionId = () => sessionId;
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  });

  const starting = pi.events.get("session_start")![0](undefined, context);
  await snapshotStarted;
  assert.deepEqual(pi.pi.getActiveTools(), []);
  releaseSnapshot({ stdout: "", stderr: "Herdr disconnected", code: 1 });
  await starting;
});

test("incomplete global assignment inventory never initializes an ordinary identity", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `inventory-failure-${randomUUID()}.sock`,
  );
  const assignment = {
    version: 2 as const,
    id: randomUUID(),
    repoKey: "inventory-failure",
    branch: "broken",
    text: "fixture",
  };
  writeProjectAssignment(supervisionRuntime(), assignment);
  const path = projectAssignmentPath(
    supervisionRuntime(),
    assignment.repoKey,
    assignment.branch,
  );
  writeFileSync(path, "{", "utf8");
  const pi = fakeChiefPi();
  const context = fakeContext(pi.entries) as any;
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    unlinkSync(path);
    setLeadEnvironment();
  });
  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(readSessionKind(pi.entries, LEAD_SESSION_ID), undefined);
  assert.equal(pi.pi.getActiveTools().includes("delegate_agent"), false);
  assert.ok(
    pi.entries.some((entry: any) =>
      String(entry.data?.error).includes("Unable to read project assignment"),
    ),
  );
});

test("ordinary Lead profile switches retain the saved tool baseline", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const baseline = ["read", "bash", "edit", "write"];
  const pi = fakeChiefPi({ activeTools: baseline, entries });
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), [...baseline, ...leadTools]);
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    assert.deepEqual(pi.pi.getActiveTools(), leadTools);
    const persisted = sessionLeadExecutionState(entries);
    assert.equal(persisted?.mode, "orchestrate");
    assert.deepEqual(persisted?.leadTools, [...baseline]);
    await pi.commandOptions.get("lead").handler("flexible", context);
    assert.deepEqual(pi.pi.getActiveTools(), [...baseline, ...leadTools]);
    assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
      ...baseline,
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("ordinary mode activation rolls back state and tools when projection fails", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const baseline = ["read", "bash"];
  const pi = fakeChiefPi({ activeTools: baseline, entries });
  const context = fakeContext(entries) as any;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const priorState = sessionLeadExecutionState(entries);
    const priorTools = pi.pi.getActiveTools();
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    const setActiveTools = pi.pi.setActiveTools.bind(pi.pi);
    pi.pi.setActiveTools = (tools: string[]) => {
      if (!tools.includes("read")) throw new Error("target projection failed");
      setActiveTools(tools);
    };
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    assert.ok(
      notices.some((message) => message.includes("target projection failed")),
    );
    assert.deepEqual(pi.pi.getActiveTools(), priorTools);
    assert.deepEqual(sessionLeadExecutionState(entries), priorState);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("ordinary mode persistence rollback restores inherited tool tracking", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const pi = fakeChiefPi({
    activeTools: ["read", "bash"],
    allTools: [{ name: "history" }],
    entries,
  });
  const context = fakeContext(entries) as any;
  const appendEntry = pi.pi.appendEntry;
  pi.pi.appendEntry = (type: string, data: any) => {
    if (type === "pi-herdsman-lead-execution" && data?.mode === "orchestrate")
      throw new Error("mode persistence failed");
    appendEntry(type, data);
  };
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", "bash", ...leadTools]);
    pi.pi.setActiveTools(["read", "history"]);
    await agentTool(pi, "delegate").execute(
      "rollback-inherited-tools",
      {
        definition: "agent",
        task: "verify inherited tool tracking after rollback",
      },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read", "history", ...leadTools]);
    assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
      "read",
      "history",
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("failed ordinary mode rollback invalidates execution and fails closed", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    let calls = 0;
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    const setActiveTools = pi.pi.setActiveTools.bind(pi.pi);
    pi.pi.setActiveTools = (tools: string[]) => {
      calls++;
      if (calls <= 2) throw new Error("projection failed");
      setActiveTools(tools);
    };
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    assert.ok(notices.some((message) => message.includes("projection failed")));
    assert.deepEqual(pi.pi.getActiveTools(), leadTools);
    assert.deepEqual(sessionLeadExecutionState(entries)?.mode, "flexible");
    const prompt: any = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](prompt, context);
    assert.equal(
      prompt.systemPromptOptions.sections.pi_herdsman_lead_execution,
      undefined,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("a restricted Flexible definition cannot replace the ordinary tool baseline", async (t) => {
  setLeadEnvironment();
  const cwd = mkdtempSync(join(tmpdir(), "herdsman-flexible-profile-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "flexible-lead.md"),
    "---\nname: flexible-lead\ntools: [read]\n---\nrestricted flexible\n",
  );
  const baseline = ["read", "bash", "edit", "write"];
  const pi = fakeChiefPi({ activeTools: baseline });
  const context = fakeContext(pi.entries) as any;
  context.cwd = cwd;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    await pi.commandOptions.get("lead").handler("flexible", context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
    assert.deepEqual(
      sessionLeadExecutionState(pi.entries)?.leadTools,
      baseline,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("live Flexible tool changes are inherited while exclusions stay saved", async (t) => {
  setLeadEnvironment();
  const cwd = mkdtempSync(join(tmpdir(), "herdsman-inherited-tools-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "flexible-lead.md"),
    "---\nname: flexible-lead\nexcludeTools: [bash]\n---\nflexible\n",
  );
  const entries: any[] = [];
  const pi = fakeChiefPi({
    activeTools: ["read", "bash"],
    allTools: [{ name: "history" }, { name: "notes" }],
    entries,
  });
  const context = fakeContext(entries) as any;
  context.cwd = cwd;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    pi.pi.setActiveTools(["read", "history", "notes"]);
    await agentTool(pi, "delegate").execute(
      "late-tool-change",
      {
        definition: "agent",
        task: "verify inherited tools survive reconciliation",
      },
      undefined,
      undefined,
      context,
    );

    assert.deepEqual(pi.pi.getActiveTools(), [
      "read",
      "history",
      "notes",
      ...leadTools,
    ]);
    assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
      "read",
      "history",
      "notes",
      "bash",
    ]);
    pi.pi.setActiveTools(["read", "history", ...leadTools]);
    await agentTool(pi, "delegate").execute(
      "removed-tool-change",
      { definition: "agent", task: "verify removed tools stay removed" },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read", "history", ...leadTools]);
    assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
      "read",
      "history",
      "bash",
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("failed inherited-tool persistence enforces policy and retries", async (t) => {
  setLeadEnvironment();
  const cwd = mkdtempSync(join(tmpdir(), "herdsman-inherited-tools-failure-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", "flexible-lead.md"),
    "---\nname: flexible-lead\nexcludeTools: [bash]\n---\nflexible\n",
  );
  const entries: any[] = [];
  const pi = fakeChiefPi({
    activeTools: ["read", "bash"],
    allTools: [{ name: "history" }, { name: "notes" }],
    entries,
  });
  const context = fakeContext(entries) as any;
  context.cwd = cwd;
  const appendEntry = pi.pi.appendEntry;
  let failPersistence = false;
  let persistenceAttempts = 0;
  pi.pi.appendEntry = (type: string, data: unknown) => {
    if (type === "pi-herdsman-lead-execution" && failPersistence) {
      persistenceAttempts++;
      throw new Error("simulated baseline persistence failure");
    }
    appendEntry(type, data);
  };
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    pi.pi.setActiveTools(["read", "bash", "history", "notes"]);

    failPersistence = true;
    await agentTool(pi, "delegate").execute(
      "failed-tool-capture",
      {
        definition: "agent",
        task: "exercise failed inherited-tool persistence",
      },
      undefined,
      undefined,
      context,
    );

    assert.ok(persistenceAttempts > 0);
    assert.deepEqual(pi.pi.getActiveTools(), [
      "read",
      "history",
      "notes",
      ...leadTools,
    ]);
    assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
      "read",
      "bash",
    ]);

    failPersistence = false;
    await agentTool(pi, "delegate").execute(
      "retry-tool-capture",
      { definition: "agent", task: "retry inherited-tool persistence" },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(pi.pi.getActiveTools(), [
      "read",
      "history",
      "notes",
      ...leadTools,
    ]);
    assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
      "read",
      "history",
      "notes",
      "bash",
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("failed inherited capture still enforces invalid-profile fail-closed tools", async (t) => {
  setLeadEnvironment();
  const cwd = mkdtempSync(join(tmpdir(), "herdsman-invalid-inherited-tools-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  const definition = join(cwd, ".pi", "agents", "flexible-lead.md");
  writeFileSync(definition, "---\nname: flexible-lead\n---\nflexible\n");
  const entries: any[] = [];
  const pi = fakeChiefPi({
    activeTools: ["read", "bash"],
    allTools: [{ name: "history" }],
    entries,
  });
  const context = fakeContext(entries) as any;
  context.cwd = cwd;
  const appendEntry = pi.pi.appendEntry;
  let failPersistence = false;
  pi.pi.appendEntry = (type: string, data: unknown) => {
    if (type === "pi-herdsman-lead-execution" && failPersistence)
      throw new Error("baseline write failed");
    appendEntry(type, data);
  };
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    writeFileSync(definition, "---\nname: [malformed\n---\nbad\n");
    pi.pi.setActiveTools(["read", "history"]);
    failPersistence = true;
    await pi.events.get("session_tree")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), leadTools);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("failed capture cannot preserve tools after inherited execution becomes invalid", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  const pi = fakePi({ activeTools: ["read", "history"] });
  let executionValid = true;
  let marker: any = { mode: "flexible", excluded: [] };
  const state: any = {
    controllerRole: "lead",
    roleSuspended: false,
    chiefMode: "inactive",
    chiefModeGeneration: 0,
  };
  const transitions = createLeadRoleTransitions(state, {
    controllerScope: { kind: "root" },
    pi: pi.pi,
    captureInheritedTools: () => {
      assert.ok(marker);
      throw new Error("baseline persistence failed");
    },
    inheritedProjection: () => (executionValid ? marker : undefined),
    setInheritedProjection: (projection: any) => {
      marker = projection;
    },
    appendDurableError: () => {},
    getLeadTools: () => ["read", "bash"],
    executionTools: () => (executionValid ? ["read", "bash"] : []),
    normalizeLeadTools: (tools: string[]) => tools,
    normalizeBaseTools: (tools: string[]) => tools,
  } as any);

  executionValid = false;
  transitions.reconcileRoleTools();

  assert.deepEqual(pi.pi.getActiveTools(), []);
  assert.equal(marker, undefined);
});

test("session tree navigation restores each branch's execution mode, baseline, and guidance", async () => {
  setLeadEnvironment();
  const branchEntry = (mode: string, leadTools: string[]) => [
    {
      type: "custom",
      customType: "pi-herdsman-lead-execution",
      data: { sessionId: LEAD_SESSION_ID, mode, leadTools },
    },
  ];
  let branch = branchEntry("flexible", ["read", "bash"]);
  const pi = fakeChiefPi({ activeTools: ["read", "bash"] });
  const context = fakeContext(pi.entries, branch) as any;
  context.sessionManager.getBranch = () => branch;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    branch = branchEntry("flexible", ["read", "bash"]);
    await pi.events.get("session_tree")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", "bash", ...leadTools]);
    let event: any = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](event, context);
    assert.match(
      event.systemPromptOptions.sections.pi_herdsman_lead_execution,
      /Delegate bounded execution work when an Agent/u,
    );

    branch = branchEntry("orchestrate", ["read", "edit"]);
    await pi.events.get("session_tree")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), leadTools);
    event = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](event, context);
    assert.match(
      event.systemPromptOptions.sections.pi_herdsman_lead_execution,
      /Do not keep otherwise delegable execution local/u,
    );
    assert.deepEqual(sessionLeadExecutionState(branch)?.leadTools, [
      "read",
      "edit",
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("session startup restores execution from the selected branch only", async () => {
  setLeadEnvironment();
  const branchEntry = (mode: string, tools: string[]) => [
    {
      type: "custom",
      customType: "pi-herdsman-lead-execution",
      data: { sessionId: LEAD_SESSION_ID, mode, leadTools: tools },
    },
  ];
  const selected = branchEntry("flexible", ["read", "bash"]);
  const sibling = branchEntry("orchestrate", ["read", "edit"]);
  const entries = [...selected, ...sibling];
  const pi = fakeChiefPi({ activeTools: ["read", "edit"], entries });
  const context = fakeContext(entries) as any;
  context.sessionManager.getBranch = () => selected;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", "bash", ...leadTools]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Manager transitions and mode changes preserve the ordinary Lead baseline", async () => {
  setLeadEnvironment();
  const managerOverride = join(PI_AGENTS_DIR, "manager.md");
  process.env.HERDR_PANE_ID = "manager-baseline-pane";
  process.env.HERDR_TAB_ID = "manager-baseline-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-baseline-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const baseline = ["read", "bash"];
  const pi = fakeRepositoryChiefPi({
    activeTools: baseline,
    allTools: [{ name: "history" }, { name: "notes" }],
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "/tmp" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "/tmp",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({ agents: [managerAgentIdentity()] })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerAgentIdentity() })
              : isApiSnapshot(args)
                ? respond({
                    snapshot: { agents: [], panes: [], workspaces: [] },
                  })
                : respond({}),
  });
  const context = fakeContext(pi.entries) as any;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    assert.deepEqual(pi.pi.getActiveTools(), leadTools);
    await pi.commandOptions.get("manager").handler("", context);
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
    const targetId = `manager-peer-${randomUUID()}`;
    const targetLease = acquireProcessLock(
      peerLeadLockPath(peerRuntime(), targetId),
      { name: "Lead peer presence" },
    );
    writePeerLeadRecordRaw(peerRuntime(), {
      version: 2,
      build: HERDSMAN_BUILD,
      sessionKind: "ordinary",
      piSessionId: targetId,
      paneId: "other-manager-pane",
      tabId: "other-manager-tab",
      workspaceId: WORKSPACE,
      socket: join(tmpdir(), `other-manager-${randomUUID()}.sock`),
      role: "manager",
      claim: targetLease.claim,
      updatedAt: Date.now(),
    });
    try {
      const peers = pi.tools.find((tool) => tool.name === "list_peers")!;
      const message = pi.tools.find((tool) => tool.name === "message_peer")!;
      assert.equal(
        JSON.parse(
          (await peers.execute("list", {}, undefined, undefined, context))
            .content[0].text,
        ).peers.some((peer: { session: string }) => peer.session === targetId),
        true,
      );
      await message.execute(
        "message",
        { session: targetId, message: "Manager peer" },
        undefined,
        undefined,
        context,
      );
      const queued = listCoordinationMessagePaths(peerRuntime(), targetId);
      assert.equal(queued.length, 1);
      assert.equal(readChiefMessage(queued[0]).peerSource?.role, "manager");
      removeChiefMessage(
        peerRuntime(),
        targetId,
        readChiefMessage(queued[0]).id,
      );
    } finally {
      targetLease.release();
      removePeerLeadRecord(peerRuntime(), targetId);
    }
    await pi.commandOptions.get("lead").handler("flexible", context);
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
    assert.deepEqual(sessionLeadExecutionState(pi.entries), {
      mode: "flexible",
      leadTools: [...baseline],
    });
    await pi.commandOptions.get("manager").handler("leave", context);
    assert.deepEqual(pi.pi.getActiveTools(), [...baseline, ...leadTools]);
    assert.deepEqual(sessionLeadExecutionState(pi.entries)?.leadTools, [
      ...baseline,
    ]);
    pi.pi.setActiveTools([...baseline, "history", "notes", ...leadTools]);
    await pi.commandOptions.get("manager").handler("", context);
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
    assert.deepEqual(sessionLeadExecutionState(pi.entries)?.leadTools, [
      ...baseline,
      "history",
      "notes",
    ]);
    await pi.commandOptions.get("manager").handler("leave", context);
    assert.deepEqual(pi.pi.getActiveTools(), [
      ...baseline,
      "history",
      "notes",
      ...leadTools,
    ]);
    writeFileSync(managerOverride, "---\nname: manager\ntools: [read]\n---\n");
    await pi.commandOptions.get("manager").handler("", context);
    assert.deepEqual(pi.pi.getActiveTools(), ["read", ...managerTools]);
    writeFileSync(managerOverride, "---\nname: manager\ntools: []\n---\n");
    await pi.commandOptions.get("manager").handler("", context);
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
    let releaseIdle!: () => void;
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => (markWaiting = resolve));
    const idle = new Promise<void>((resolve) => (releaseIdle = resolve));
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    context.waitForIdle = async () => {
      markWaiting();
      await idle;
    };
    const refresh = pi.commandOptions.get("manager").handler("", context);
    await waiting;
    await pi.commandOptions.get("manager").handler("leave", context);
    assert.deepEqual(pi.pi.getActiveTools(), [
      ...baseline,
      "history",
      "notes",
      ...leadTools,
    ]);
    releaseIdle();
    await refresh;
    assert.ok(notices.some((message) => message.includes("mode changed")));
    assert.deepEqual(pi.pi.getActiveTools(), [
      ...baseline,
      "history",
      "notes",
      ...leadTools,
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    rmSync(managerOverride, { force: true });
  }
});

test("ordinary Leads deliver peer messages across non-Git sockets", async (t) => {
  setLeadEnvironment();
  const runtime = peerRuntime();
  const leads = ["sender", "recipient"].map((name) => ({
    sessionId: `${name}-${randomUUID()}`,
    paneId: `${name}-pane-${randomUUID()}`,
    tabId: `${name}-tab-${randomUUID()}`,
    workspaceId: `${name}-workspace-${randomUUID()}`,
    socket: join(tmpdir(), `${name}-${randomUUID()}.sock`),
  }));
  const recipientEntries: unknown[] = [];
  const fixtures = leads.map((lead, index) => {
    const pi = fakeChiefPi({
      activeTools: ["read", "bash"],
      ...(index === 1
        ? {
            entries: recipientEntries,
            sendMessage: (message: unknown) => recipientEntries.push(message),
          }
        : {}),
    });
    const context = fakeContext(pi.entries) as any;
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    context.sessionManager = {
      ...context.sessionManager,
      getSessionId: () => lead.sessionId,
    };
    return { pi, context };
  });
  const setEnvironment = (lead: (typeof leads)[number]) => {
    process.env.HERDR_PANE_ID = lead.paneId;
    process.env.HERDR_TAB_ID = lead.tabId;
    process.env.HERDR_SOCKET_PATH = lead.socket;
    process.env.HERDR_WORKSPACE_ID = lead.workspaceId;
  };
  try {
    for (let index = 0; index < leads.length; index++) {
      setEnvironment(leads[index]!);
      registerExtension!(fixtures[index]!.pi.pi as never);
      await fixtures[index]!.pi.events.get("session_start")![0](
        undefined,
        fixtures[index]!.context,
      );
      await fixtures[index]!.pi.commandOptions.get("lead").handler(
        "orchestrate",
        fixtures[index]!.context,
      );
    }

    for (const lead of leads) {
      assert.equal(readPeerLeadRecord(runtime, lead.sessionId)?.group, null);
    }
    const assignmentSnapshot = globalProjectAssignmentSnapshot();
    for (const lead of leads) {
      assert.equal(assignmentSnapshot.get(lead.sessionId)?.length ?? 0, 0);
    }
    const sender = fixtures[0]!;
    await sender.pi.tools
      .find((tool) => tool.name === "message_peer")!
      .execute(
        "message",
        { session: leads[1]!.sessionId, message: "ordinary non-Git message" },
        undefined,
        undefined,
        sender.context,
      );
    assert.equal(
      listCoordinationMessagePaths(runtime, leads[1]!.sessionId).length,
      1,
    );

    setEnvironment(leads[1]!);
    await t.waitFor(
      () => {
        assert.deepEqual(
          listCoordinationMessagePaths(runtime, leads[1]!.sessionId),
          [],
        );
        assert.equal(
          fixtures[1]!.pi.sentMessageCalls.filter((call) =>
            String((call.message as any)?.content ?? "").includes(
              "ordinary non-Git message",
            ),
          ).length,
          1,
        );
      },
      { timeout: 5000 },
    );
  } finally {
    for (let index = leads.length - 1; index >= 0; index--) {
      setEnvironment(leads[index]!);
      await fixtures[index]!.pi.events.get("session_shutdown")?.[0]();
    }
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_WORKSPACE_ID;
  }
});

test("Manager peer messages deliver to a live Manager without changing its role", async (t) => {
  setLeadEnvironment();
  const runtime = peerRuntime();
  const managers = [
    {
      sessionId: `manager-sender-${randomUUID()}`,
      paneId: `manager-sender-pane-${randomUUID()}`,
      tabId: `manager-sender-tab-${randomUUID()}`,
      workspaceId: `manager-sender-workspace-${randomUUID()}`,
      socket: join(tmpdir(), `manager-sender-${randomUUID()}.sock`),
    },
    {
      sessionId: `manager-recipient-${randomUUID()}`,
      paneId: `manager-recipient-pane-${randomUUID()}`,
      tabId: `manager-recipient-tab-${randomUUID()}`,
      workspaceId: `manager-recipient-workspace-${randomUUID()}`,
      socket: join(tmpdir(), `manager-recipient-${randomUUID()}.sock`),
    },
  ];
  const recipientEntries: unknown[] = [];
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const makeFixture = (
    manager: (typeof managers)[number],
    recipient: boolean,
  ) => {
    const identity = {
      pane_id: manager.paneId,
      tab_id: manager.tabId,
      workspace_id: manager.workspaceId,
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: manager.sessionId,
      },
    };
    const pi = fakeRepositoryChiefPi({
      entries: recipient ? recipientEntries : undefined,
      activeTools: ["read", "bash"],
      exec: (_command, args) =>
        args[0] === "workspace" && args[1] === "get"
          ? respond({
              workspace: { worktree: { repo_key: "/tmp" } },
            })
          : args[0] === "worktree" && args[1] === "list"
            ? respond({
                source: {
                  source_workspace_id: manager.workspaceId,
                  repo_key: "/tmp",
                  repo_name: manager.workspaceId,
                  source_checkout_path: manager.workspaceId,
                },
                worktrees: [],
              })
            : isAgentList(args)
              ? respond({ agents: [identity] })
              : args[0] === "agent" && args[1] === "get"
                ? respond({ agent: identity })
                : isApiSnapshot(args)
                  ? respond({
                      snapshot: { agents: [], panes: [], workspaces: [] },
                    })
                  : respond({}),
      ...(recipient
        ? {
            sendMessage: (message: unknown) => recipientEntries.push(message),
          }
        : {}),
    });
    const context = fakeContext(pi.entries) as any;
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    context.sessionManager = {
      ...context.sessionManager,
      getSessionId: () => manager.sessionId,
    };
    pi.entries.push({
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: { version: 1, sessionId: manager.sessionId, kind: "ordinary" },
    });
    return { pi, context, notices };
  };
  const [senderManager, recipientManager] = managers;
  const recipient = makeFixture(recipientManager!, true);
  const sender = makeFixture(senderManager!, false);
  process.env.HERDR_PANE_ID = recipientManager!.paneId;
  process.env.HERDR_TAB_ID = recipientManager!.tabId;
  process.env.HERDR_SOCKET_PATH = recipientManager!.socket;
  process.env.HERDR_WORKSPACE_ID = recipientManager!.workspaceId;
  registerExtension!(recipient.pi.pi as never);
  process.env.HERDR_PANE_ID = senderManager!.paneId;
  process.env.HERDR_TAB_ID = senderManager!.tabId;
  process.env.HERDR_SOCKET_PATH = senderManager!.socket;
  process.env.HERDR_WORKSPACE_ID = senderManager!.workspaceId;
  registerExtension!(sender.pi.pi as never);
  const enterManager = async (
    manager: (typeof managers)[number],
    fixture: ReturnType<typeof makeFixture>,
  ) => {
    process.env.HERDR_PANE_ID = manager.paneId;
    process.env.HERDR_TAB_ID = manager.tabId;
    process.env.HERDR_SOCKET_PATH = manager.socket;
    process.env.HERDR_WORKSPACE_ID = manager.workspaceId;
    await fixture.pi.events.get("session_start")![0](
      undefined,
      fixture.context,
    );
    await fixture.pi.commandOptions
      .get("lead")
      .handler("orchestrate", fixture.context);
    await fixture.pi.commandOptions.get("manager").handler("", fixture.context);
    assert.ok(
      fixture.pi.pi.getActiveTools().includes("list_staff"),
      `${manager.sessionId} did not enter Manager: ${fixture.notices.join("; ")}`,
    );
  };
  try {
    await enterManager(recipientManager!, recipient);
    await enterManager(senderManager!, sender);

    const peers = sender.pi.tools.find((tool) => tool.name === "list_peers")!;
    const listed = JSON.parse(
      (await peers.execute("list", {}, undefined, undefined, sender.context))
        .content[0].text,
    );
    assert.ok(
      listed.peers.some(
        (peer: { session: string }) =>
          peer.session === recipientManager!.sessionId,
      ),
      JSON.stringify(listed),
    );
    assert.equal(
      readPeerLeadRecord(runtime, recipientManager!.sessionId)?.role,
      "manager",
    );
    await sender.pi.tools
      .find((tool) => tool.name === "message_peer")!
      .execute(
        "message",
        { session: recipientManager!.sessionId, message: "manager queued" },
        undefined,
        undefined,
        sender.context,
      );
    assert.equal(
      listCoordinationMessagePaths(runtime, recipientManager!.sessionId).length,
      1,
    );

    process.env.HERDR_PANE_ID = recipientManager!.paneId;
    process.env.HERDR_TAB_ID = recipientManager!.tabId;
    process.env.HERDR_SOCKET_PATH = recipientManager!.socket;
    process.env.HERDR_WORKSPACE_ID = recipientManager!.workspaceId;
    await t.waitFor(
      () => {
        assert.equal(
          recipient.pi.sentMessageCalls.filter((call) =>
            String((call.message as any)?.content ?? "").includes(
              "manager queued",
            ),
          ).length,
          1,
        );
        assert.deepEqual(
          listCoordinationMessagePaths(runtime, recipientManager!.sessionId),
          [],
        );
      },
      { timeout: 5000 },
    );
    assert.ok(recipient.pi.pi.getActiveTools().includes("list_staff"));
    assert.deepEqual(
      listCoordinationMessagePaths(runtime, recipientManager!.sessionId),
      [],
    );
  } finally {
    for (const [manager, fixture] of [
      [senderManager!, sender],
      [recipientManager!, recipient],
    ] as const) {
      process.env.HERDR_PANE_ID = manager.paneId;
      process.env.HERDR_TAB_ID = manager.tabId;
      process.env.HERDR_SOCKET_PATH = manager.socket;
      process.env.HERDR_WORKSPACE_ID = manager.workspaceId;
      await fixture.pi.events.get("session_shutdown")?.[0]();
    }
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Manager restoration does not claim a lease when identity changes during discovery", async () => {
  const { createLeadRuntimeState, resolveLeadControllerRole } =
    await import("./lead-runtime.ts");
  const state = createLeadRuntimeState();
  let identityCurrent = true;
  let claims = 0;
  await resolveLeadControllerRole(state, fakeContext() as any, "manager", {
    identity: { paneId: "pane", tabId: "tab", workspaceId: "workspace" },
    build: "test",
    localRepositoryScope: async () => {
      identityCurrent = false;
      return { isPrimary: true, repoKey: "repo" };
    },
    claimManagerLease: (() => {
      claims++;
      throw new Error("unexpected claim");
    }) as any,
    coordinationHealthy: () => true,
    verifyManagerIdentity: async () => true,
    verifyCurrentIdentity: async () => identityCurrent,
    unresolvedManagerLease() {},
    activationGuard() {},
    persistLeadRole() {},
    isCurrent: () => true,
  });
  assert.equal(claims, 0);
  assert.equal(state.controllerRole, "lead");
});

test("superseded Manager restoration releases its lease without replacing current state", async () => {
  const { createLeadRuntimeState, resolveLeadControllerRole } =
    await import("./lead-runtime.ts");
  const state = createLeadRuntimeState();
  let generation = 1;
  let releaseOldVerification!: (value: unknown) => void;
  const oldVerification = new Promise((resolve) => {
    releaseOldVerification = resolve;
  });
  let oldVerificationStarted!: () => void;
  const oldVerificationReady = new Promise<void>((resolve) => {
    oldVerificationStarted = resolve;
  });
  const released = new Set<string>();
  let profileOwner: string | undefined;
  const resolve = (
    sessionId: string,
    verifyManagerIdentity: () => Promise<unknown>,
  ) => {
    const startGeneration = generation;
    const context = fakeContext() as any;
    context.sessionManager = {
      ...context.sessionManager,
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    };
    return resolveLeadControllerRole(
      state,
      context,
      "lead",
      {
        identity: { paneId: "pane", tabId: "tab", workspaceId: "workspace" },
        build: "test",
        localRepositoryScope: async () => ({
          isPrimary: true,
          repoKey: "repo",
        }),
        claimManagerLease: (() => ({
          descriptor: { piSessionId: sessionId },
          release: () => released.add(sessionId),
        })) as any,
        coordinationHealthy: () => true,
        verifyManagerIdentity,
        verifyCurrentIdentity: async () => true,
        unresolvedManagerLease() {},
        activationGuard() {},
        persistLeadRole() {},
        isCurrent: () => generation === startGeneration,
      },
      true,
    ).then(() => {
      if (generation === startGeneration)
        profileOwner =
          state.controllerRole === "manager" ? sessionId : undefined;
    });
  };

  const old = resolve("old-session", () => {
    oldVerificationStarted();
    return oldVerification;
  });
  await oldVerificationReady;
  generation++;
  const current = resolve("current-session", async () => true);
  await current;
  const currentLease = state.managerLease;
  releaseOldVerification(true);
  await old;

  assert.equal(state.controllerRole, "manager");
  assert.equal(state.managerLease, currentLease);
  assert.equal(profileOwner, "current-session");
  assert.ok(released.has("old-session"));
  assert.ok(!released.has("current-session"));
});

test("Chief transitions and mode changes preserve the ordinary Lead baseline", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-baseline-pane";
  process.env.HERDR_TAB_ID = "chief-baseline-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-baseline-${randomUUID()}.sock`,
  );
  const baseline = ["read", "bash"];
  const tabRenames: string[] = [];
  const renameArgs: string[][] = [];
  let tabLabel = "1";
  const pi = fakeChiefPi({ activeTools: baseline });
  const originalExec = pi.pi.exec.bind(pi.pi);
  (pi.pi as any).exec = async (
    command: string,
    args: string[],
    options: any,
  ) => {
    if (command !== "herdr" || !["pane", "tab"].includes(args[0]!))
      return originalExec(command, args, options);
    const respond = (result: unknown) => ({
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    });
    if (args[0] === "pane" && args[1] === "get")
      return respond({
        pane: {
          pane_id: "chief-baseline-pane",
          workspace_id: WORKSPACE,
          tab_id: "chief-baseline-tab",
        },
      });
    if (args[0] === "tab" && args[1] === "list")
      return respond({
        tabs: [{ tab_id: "chief-baseline-tab", number: 38, label: tabLabel }],
      });
    if (args[0] === "tab" && args[1] === "rename") {
      tabLabel = args[3]!;
      tabRenames.push(args[3]!);
      renameArgs.push(args);
      return respond({});
    }
    return originalExec(command, args, options);
  };
  const context = fakeContext(pi.entries) as any;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await t.waitFor(() => assert.equal(tabLabel, "Lead"));
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    await pi.commandOptions.get("chief").handler("", context);
    await t.waitFor(() => assert.equal(tabLabel, "Chief"));
    assert.deepEqual(tabRenames, ["Lead", "Chief"]);
    assert.deepEqual(renameArgs, [
      ["tab", "rename", "chief-baseline-tab", "Lead"],
      ["tab", "rename", "chief-baseline-tab", "Chief"],
    ]);
    assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
    await pi.commandOptions.get("lead").handler("flexible", context);
    assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
    assert.deepEqual(sessionLeadExecutionState(pi.entries), {
      mode: "flexible",
      leadTools: [...baseline],
    });
    await pi.commandOptions.get("chief").handler("leave", context);
    await t.waitFor(() => assert.equal(tabLabel, "Lead"));
    assert.deepEqual(tabRenames, ["Lead", "Chief", "Lead"]);
    assert.deepEqual(renameArgs.at(-1), [
      "tab",
      "rename",
      "chief-baseline-tab",
      "Lead",
    ]);
    assert.deepEqual(pi.pi.getActiveTools(), [...baseline, ...leadTools]);
    assert.deepEqual(sessionLeadExecutionState(pi.entries)?.leadTools, [
      ...baseline,
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("persisted Chief restores the saved ordinary execution profile on exit", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "persisted-chief-profile-pane";
  process.env.HERDR_TAB_ID = "persisted-chief-profile-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `persisted-chief-profile-${randomUUID()}.sock`,
  );
  const baseline = ["read", "bash"];
  const entries: any[] = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { sessionId: LEAD_SESSION_ID, role: "chief", leadTools: baseline },
    },
    {
      type: "custom",
      customType: "pi-herdsman-lead-execution",
      data: {
        sessionId: LEAD_SESSION_ID,
        mode: "orchestrate",
        leadTools: baseline,
      },
    },
  ];
  const pi = fakeChiefPi({ activeTools: chiefTools, entries });
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
    assert.equal(
      entries.some(
        (entry) => entry.customType === "pi_herdsman_definition_error",
      ),
      false,
    );

    const restoredTools = leadTools;
    const setActiveTools = pi.pi.setActiveTools;
    let failRestore = true;
    pi.pi.setActiveTools = (next: string[]) => {
      if (failRestore && next.join("|") === restoredTools.join("|")) {
        failRestore = false;
        throw new Error("ordinary profile restoration failed");
      }
      setActiveTools(next);
    };

    await pi.commandOptions.get("chief").handler("leave", context);

    assert.deepEqual(pi.pi.getActiveTools(), restoredTools);
    assert.deepEqual(sessionLeadExecutionState(entries), {
      mode: "orchestrate",
      leadTools: baseline,
    });
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_role_error" &&
          entry.data.error.includes("ordinary profile restoration failed"),
      ),
    );
    const promptEvent = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {} },
    };
    await pi.events.get("before_agent_start")![0](promptEvent, context);
    assert.match(
      promptEvent.systemPromptOptions.sections.pi_herdsman_lead_execution,
      /Do not keep otherwise delegable execution local/,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});
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
    {
      ...record,
      build: record.build ?? HERDSMAN_BUILD,
      ...(record.kind === "peer_message"
        ? {
            peerSource: record.peerSource ?? {
              role: "lead",
              socket: "/test-socket",
              group: { repoKey: "test-repo", primaryWorkspaceId: "workspace" },
              managed: false,
            },
          }
        : {}),
    },
    runtime,
  );
const writePeerLeadRecord = (runtime: any, record: any) =>
  writePeerLeadRecordRaw(runtime, {
    ...record,
    version: 2,
    sessionKind: record.sessionKind ?? "ordinary",
    socket: record.socket ?? "/test-socket",
    group: record.group ?? null,
    build: record.build ?? HERDSMAN_BUILD,
  });
const {
  readConfig,
  setWorktreeRemovalPreapproved,
  readEffectiveConfig,
  readProjectOverrides,
  updateConfig,
  updateProjectOverride,
} = await import("./config.ts");
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) =>
  pi.tools.find(
    (candidate) =>
      candidate.name ===
      (
        {
          list: "list_agents",
          delegate: "delegate_agent",
          continue: "continue_agent",
          steer: "steer_agent",
          interrupt: "interrupt_agent",
          reply: "reply_agent",
          close: "close_agent",
          inspect: "inspect_agent",
          transcript: "read_agent_transcript",
        } as Record<string, string>
      )[name],
  )!;
test("session stats sums Pi usage entries and proven nested sessions once", async (t) => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const dir = mkdtempSync(join(PI_AGENT_ROOT, "herdsman-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
      toolName: "delegate_agent",
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
  const writeSession = (id: string, path: string, sessionEntries: unknown[]) =>
    writeFileSync(
      path,
      [{ type: "session", id }, ...sessionEntries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
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
  for (const session of nativeSessions.values())
    if (session.path === childPath || session.path === nestedPath)
      writeSession(session.id, session.path, session.entries ?? []);
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
    writeSession(
      nestedId,
      nestedPath,
      nativeSessions.get(nestedPath)!.entries!,
    );
    await pi.commandOptions.get("agents").handler("stats", context);
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
      return respond({ workspace: { worktree: { repo_key: "/tmp" } } });
    if (args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: WORKSPACE,
          repo_key: "/tmp",
          repo_name: "project",
        },
        worktrees: [],
      });
    if (isAgentList(args)) return respond({ agents: [managerAgentIdentity()] });
    if (args[0] === "agent" && args[1] === "get")
      return respond({ agent: managerAgentIdentity() });
    if (isApiSnapshot(args))
      return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
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
  const manager = fakeRepositoryChiefPi({ activeTools: ["read"], exec });
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
  const dir = realFs.mkdtempSync(join("/tmp", "herdsman-manager-usage-"));
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
      toolName: "delegate_agent",
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
  const writeSession = (id: string, path: string, sessionEntries: unknown[]) =>
    writeFileSync(
      path,
      [{ type: "session", id }, ...sessionEntries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
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
  for (const id of [leadA, leadB, agentX, agentY]) {
    const session = nativeSessions.get(paths[id]!)!;
    writeSession(session.id, session.path, session.entries ?? []);
  }
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
        repoKey: "/tmp",
        branch,
        text: branch,
        ...(branch !== "branch-a-alias" ? { piSessionFile: paths[id]! } : {}),
      });
    assert.deepEqual(
      listProjectAssignments(supervisionRuntime(), "/tmp").map(
        ({ id, piSessionFile }) => [id, piSessionFile],
      ),
      [
        [leadA, paths[leadA]],
        [leadA, undefined],
        [leadB, paths[leadB]],
      ],
    );
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    assert.deepEqual(
      [leadA, leadB].map((id) =>
        SessionManager.open(paths[id]!).getSessionId(),
      ),
      [leadA, leadB],
    );
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
    writeSession(
      leadA,
      conflictPath,
      nativeSessions.get(conflictPath)!.entries ?? [],
    );
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadA,
      repoKey: "/tmp",
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
      repoKey: "/tmp",
      branch: "branch-a-alias",
      text: "branch-a-alias",
      piSessionFile: paths[leadA]!,
    });

    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadB,
      repoKey: "/tmp",
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
      repoKey: "/tmp",
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
    writeSession(
      leadA,
      paths[leadB]!,
      nativeSessions.get(paths[leadB]!)!.entries ?? [],
    );
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
        toolName: "delegate_agent",
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
  const pi = fakeRepositoryChiefPi({
    activeTools: ["read"],
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "/tmp", is_linked_worktree: false },
          },
        });
      if (args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
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
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
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
  const promptEvents: any[] = [];
  const firstEvent = {
    systemPrompt: "base",
    systemPromptOptions: { sections: {}, contextFiles: [] },
  };
  promptEvents.push(firstEvent);
  const firstCaller = beforeStart(firstEvent, context);
  await gatedSnapshotStarted.promise;
  const callers = Array.from({ length: 4 }, () => {
    const event = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    promptEvents.push(event);
    return beforeStart(event, context);
  });
  release.resolve();
  const results = await Promise.all([firstCaller, ...callers]);
  assert.ok(
    results.every((result, index) => {
      assert.equal(result, undefined);
      return /Manager role/.test(
        promptEvents[index].systemPromptOptions.sections.pi_herdsman_role,
      );
    }),
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
function fakeRepositoryChiefPi(options: Parameters<typeof fakePi>[0] = {}) {
  return fakeChiefPi({
    ...options,
    exec: async (command, args, extra) => {
      if (command === "git" && args[0] === "rev-parse")
        return {
          stdout: args.includes("--show-toplevel") ? extra.cwd : "/tmp",
          stderr: "",
          code: 0,
        };
      const response = await options.exec?.(command, args, extra);
      if (
        command === "herdr" &&
        args[0] === "workspace" &&
        args[1] === "get" &&
        response
      ) {
        const parsed = JSON.parse(response.stdout);
        if (parsed.result?.workspace) {
          parsed.result.workspace.workspace_id = args[2];
          if (args[2] === process.env.HERDR_WORKSPACE_ID)
            parsed.result.workspace.worktree = null;
          return { ...response, stdout: JSON.stringify(parsed) };
        }
      }
      return response;
    },
  });
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
                    result: {
                      snapshot: { agents: [], panes: [], workspaces: [] },
                    },
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
          ...(Array.isArray(options.allTools)
            ? options.allTools.map((tool: any) => tool.name)
            : []),
          "read",
          "bash",
          "ls",
          "find",
          "grep",
          "foreign_tool",
          "list_agents",
          "delegate_agent",
          "continue_agent",
          "steer_agent",
          "interrupt_agent",
          "reply_agent",
          "close_agent",
          "inspect_agent",
          "read_agent_transcript",
          "message_supervisor",
          "list_peers",
          "message_peer",
          "list_staff",
          "inspect_staff",
          "read_staff_transcript",
          "message_staff",
          ...fixture.tools.map((tool) => tool.name),
        ]),
      ].map((name) => ({ name })),
  });
  return fixture;
}

test("root Lead explicitly enters Manager; a competing root session stays Lead", async (t) => {
  setLeadEnvironment();
  const managerOverride = join(PI_AGENTS_DIR, "manager.md");
  const outsideDefinition = join(PI_AGENTS_DIR, "generalist.md");
  const previousManagerOverride = realFs.existsSync(managerOverride)
    ? readFileSync(managerOverride, "utf8")
    : undefined;
  let persistedManager: ReturnType<typeof fakeChiefPi> | undefined;
  let persistedManagerContext: any;
  let persistedManagerSessionId = "";
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
  const tabRenames: string[] = [];
  const tabCommands: string[][] = [];
  let currentTabLabel = "1";
  let managerRenameCount = 0;
  let failManagerRename = false;
  let tabListCalls = 0;
  let deferNextLeadRename = false;
  let deferredLeadRenameDidStart = false;
  let releaseDeferredLeadRename!: () => void;
  const deferredLeadRename = new Promise<void>(
    (resolve) => (releaseDeferredLeadRename = resolve),
  );
  let deferNextPaneGet = false;
  let deferredPaneGetDidStart = false;
  let releaseDeferredPaneGet!: () => void;
  const deferredPaneGet = new Promise<void>(
    (resolve) => (releaseDeferredPaneGet = resolve),
  );
  let failManagerMetadata = false;
  let identitySessionId = LEAD_SESSION_ID;
  const exec = (command: string, args: string[]) => {
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "report-metadata" &&
      failManagerMetadata &&
      args.includes("pi_herdsman_role=manager")
    ) {
      failManagerMetadata = false;
      return { stdout: "", stderr: "injected metadata failure", code: 1 };
    }
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "report-metadata"
    )
      metadataReports.push(args);
    if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
      if (deferNextPaneGet) {
        deferNextPaneGet = false;
        deferredPaneGetDidStart = true;
        return deferredPaneGet.then(() =>
          respond({
            pane: {
              pane_id: args[2],
              workspace_id: WORKSPACE,
              tab_id: "root-tab",
            },
          }),
        );
      }
      return respond({
        pane: {
          pane_id: args[2],
          workspace_id: WORKSPACE,
          tab_id: "root-tab",
        },
      });
    }
    if (command === "herdr" && args[0] === "tab" && args[1] === "list") {
      tabListCalls++;
      return respond({
        tabs: [{ tab_id: "root-tab", number: 27, label: currentTabLabel }],
      });
    }
    if (command === "herdr" && args[0] === "tab" && args[1] === "rename") {
      tabCommands.push(args);
      const label = args[3]!;
      if (label === "Manager" && failManagerRename) {
        failManagerRename = false;
        return { stdout: "", stderr: "injected tab rename failure", code: 1 };
      }
      if (label === "Lead" && deferNextLeadRename) {
        deferNextLeadRename = false;
        deferredLeadRenameDidStart = true;
        return deferredLeadRename.then(() => {
          currentTabLabel = label;
          tabRenames.push(label);
          return respond({});
        });
      }
      currentTabLabel = label;
      tabRenames.push(label);
      if (label === "Manager") {
        managerRenameCount++;
      }
      return respond({});
    }
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          worktree: { repo_key: "/tmp", is_linked_worktree: false },
        },
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id: WORKSPACE,
          repo_key: "/tmp",
          repo_name: "project",
        },
        worktrees: [],
      });
    if (command === "herdr" && isAgentList(args))
      return respond({
        agents: [
          {
            ...managerAgentIdentity(),
            agent_session: {
              ...managerAgentIdentity().agent_session,
              value: identitySessionId,
            },
          },
        ],
      });
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({
        agent: {
          ...managerAgentIdentity(),
          agent_session: {
            ...managerAgentIdentity().agent_session,
            value: identitySessionId,
          },
        },
      });
    if (command === "herdr" && isApiSnapshot(args))
      return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
    return respond({});
  };
  const first = fakeRepositoryChiefPi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { sessionId: LEAD_SESSION_ID, role: "lead", leadTools: ["read"] },
      },
    ],
    activeTools: ["read"],
    exec,
    sessionName: "current lead name",
  });
  const second = fakeRepositoryChiefPi({ activeTools: ["read"], exec });
  const projectCwd = realFs.mkdtempSync(
    join(tmpdir(), "herdsman-root-manager-project-"),
  );
  const ctx1 = fakeContext(first.entries) as any;
  ctx1.cwd = projectCwd;
  const managerNotices: string[] = [];
  ctx1.ui.notify = (message: string, level?: string) => {
    if (level === "error") managerNotices.push(message);
  };
  const ctx2 = fakeContext() as any;
  ctx2.cwd = projectCwd;
  const secondSessionId = `lead-${randomUUID()}`;
  ctx2.sessionManager.getSessionId = () => secondSessionId;
  registerExtension!(first.pi as never);
  registerExtension!(second.pi as never);
  try {
    assert.equal(first.commands.includes("manager"), true);
    const supervisionToolNames = [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
      "delegate_work",
      "resume_work",
      "stop_lead",
    ];
    const staffMessage = first.tools.find(
      (tool) => tool.name === "message_staff",
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
    assert.match(historical.render(160).join("\n"), /^message staff  lead-his/);
    await first.events.get("session_start")![0](undefined, ctx1);
    assert.deepEqual(first.pi.getActiveTools(), ["read", ...leadTools]);
    assert.equal(first.pi.getActiveTools().includes("message_staff"), false);
    assert.equal(
      first.pi.getAllTools().some((tool) => tool.name === "delegate_work"),
      true,
    );
    const leadPromptEvent = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    const leadPrompt = await first.events.get("before_agent_start")![0](
      leadPromptEvent,
      ctx1,
    );
    assert.equal(leadPrompt, undefined);
    assert.match(
      leadPromptEvent.systemPromptOptions.sections.pi_herdsman_role,
      /Own architecture, approved scope, acceptance of Agent outputs, integration, conflict resolution/,
    );
    assert.match(
      leadPromptEvent.systemPromptOptions.sections.pi_herdsman_lead_execution,
      /Delegate bounded execution work when an Agent can reasonably own it/,
    );
    failManagerMetadata = true;
    failManagerRename = true;
    await first.commandOptions.get("manager").handler("", ctx1);
    assert.deepEqual(first.pi.getActiveTools(), managerTools);
    await t.waitFor(() =>
      assert.deepEqual(
        tabCommands.find((args) => args[3] === "Manager"),
        ["tab", "rename", "root-tab", "Manager"],
        "the attempted Herdr rename fails during the committed Manager transition",
      ),
    );
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.piSessionId,
      ctx1.sessionManager.getSessionId(),
    );
    assert.equal(
      first.tools.find((tool) => tool.name === "message_staff"),
      staffMessage,
    );
    assert.equal(
      first.pi.getAllTools().some((tool) => tool.name === "delegate_work"),
      true,
    );
    assert.equal(first.pi.getActiveTools().includes("delegate_agent"), false);
    assert.ok(
      first.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_state_error",
      ),
    );
    await first.events.get("session_start")![0](undefined, ctx1);
    await t.waitFor(() =>
      assert.ok(tabRenames.includes("Manager"), JSON.stringify(first.calls)),
    );
    assert.ok(
      metadataReports.some((args) => args.includes("pi_herdsman_role=manager")),
      "a later publication succeeds after the failed report",
    );
    deferNextLeadRename = true;
    const leaveWithDelayedRename = first.commandOptions
      .get("manager")
      .handler("leave", ctx1);
    await t.waitFor(() => assert.equal(deferredLeadRenameDidStart, true));
    await leaveWithDelayedRename;
    const reenterManager = first.commandOptions
      .get("manager")
      .handler("", ctx1);
    await reenterManager;
    releaseDeferredLeadRename();
    await t.waitFor(() => assert.equal(managerRenameCount, 2));
    assert.deepEqual(tabRenames.slice(-2), ["Lead", "Manager"]);
    const tabListsBeforeStaleRead = tabListCalls;
    deferNextPaneGet = true;
    const leaveWithDelayedRead = first.commandOptions
      .get("manager")
      .handler("leave", ctx1);
    await t.waitFor(() => assert.equal(deferredPaneGetDidStart, true));
    await leaveWithDelayedRead;
    const reenterAfterStaleRead = first.commandOptions
      .get("manager")
      .handler("", ctx1);
    await reenterAfterStaleRead;
    releaseDeferredPaneGet();
    await t.waitFor(() =>
      assert.equal(tabListCalls, tabListsBeforeStaleRead + 1),
    );
    assert.equal(
      tabListCalls,
      tabListsBeforeStaleRead + 1,
      "the superseded pane read stops before listing tabs",
    );
    const managerPromptEvent = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    const managerPrompt = await first.events.get("before_agent_start")![0](
      managerPromptEvent,
      ctx1,
    );
    assert.equal(managerPrompt, undefined);
    assert.match(
      managerPromptEvent.systemPromptOptions.sections.pi_herdsman_role,
      /You are the verified Manager[\s\S]*Project execution belongs to assigned Leads and their Agent trees[\s\S]*Supervision is event-driven[\s\S]*Coordinate assigned project work through Leads[\s\S]*Leave technical investigation, implementation, review, validation, and\s+integration to that Lead and its Agents rather than doing or delegating\s+the work yourself/i,
    );
    assert.match(
      managerPromptEvent.systemPromptOptions.sections.pi_herdsman_role,
      /When assigned Leads need to exchange technical information,[\s\S]*coordinate directly when eligible/,
    );
    assert.doesNotMatch(
      managerPromptEvent.systemPromptOptions.sections.pi_herdsman_role,
      /Lead role[\s\S]*## Manager role/,
    );
    assert.doesNotMatch(
      managerPromptEvent.systemPromptOptions.sections.pi_herdsman_role,
      /Available agent definitions/,
    );
    assert.equal(
      managerPromptEvent.systemPromptOptions.sections
        .pi_herdsman_lead_execution,
      undefined,
    );
    assert.equal(managerPrompt?.message, undefined);
    const managerContext = first.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    );
    assert.ok(managerContext);
    assert.deepEqual(managerContext.options, { triggerTurn: false });
    assert.equal(
      await first.events.get("tool_call")![0](
        { toolName: "list_agents", input: {} },
        ctx1,
      ),
      undefined,
    );
    const staff = first.tools.find((tool) => tool.name === "delegate_work");
    const resume = first.tools.find((tool) => tool.name === "resume_work");
    assert.ok(staff);
    assert.ok(resume);
    assert.equal(staff.parameters.properties.assignment, undefined);
    assert.match(staff.description, /start a new work assignment/i);
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
      .find((tool) => tool.name === "list_staff")!
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
      const peer = first.tools.find((tool) => tool.name === "message_peer")!;
      const visible = await first.tools
        .find((tool) => tool.name === "list_peers")!
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
    assert.deepEqual(first.pi.getActiveTools(), managerTools);
    const collisionNotices: string[] = [];
    ctx2.ui.notify = (message: string) => collisionNotices.push(message);
    identitySessionId = secondSessionId;
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
      sessionLeadRoleState(ctx2.sessionManager.getEntries(), secondSessionId),
      undefined,
    );
    await second.commandOptions.get("manager").handler("", ctx2);
    assert.deepEqual(second.pi.getActiveTools(), ["read", ...leadTools]);
    assert.ok(
      collisionNotices.some((message) =>
        /already has an active Manager/.test(message),
      ),
    );
    identitySessionId = LEAD_SESSION_ID;

    persistedManager = fakeRepositoryChiefPi({
      activeTools: ["read"],
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-role",
          data: {
            sessionId: LEAD_SESSION_ID,
            role: "manager",
            leadTools: ["read"],
          },
        },
      ],
      exec: (command, args) => {
        if (
          command === "herdr" &&
          (isAgentList(args) || (args[0] === "agent" && args[1] === "get"))
        ) {
          const agent = {
            ...managerAgentIdentity(),
            agent_session: {
              ...managerAgentIdentity().agent_session,
              value: persistedManagerSessionId,
            },
          };
          return respond(isAgentList(args) ? { agents: [agent] } : { agent });
        }
        return exec(command, args);
      },
    });
    registerExtension!(persistedManager.pi as never);
    persistedManagerContext = fakeContext(persistedManager.entries) as any;
    persistedManagerSessionId = `restored-manager-${randomUUID()}`;
    persistedManagerContext.sessionManager.getSessionId = () =>
      persistedManagerSessionId;
    (persistedManager.entries[0] as any).data.sessionId =
      persistedManagerSessionId;
    const restorationNotices: string[] = [];
    persistedManagerContext.ui.notify = (message: string) =>
      restorationNotices.push(message);
    await persistedManager.events.get("session_start")![0](
      undefined,
      persistedManagerContext,
    );
    await persistedManager.commandOptions
      .get("manager")
      .handler("", persistedManagerContext);
    assert.equal(
      persistedManager.pi.getActiveTools().includes("delegate_work"),
      false,
    );
    assert.equal(
      sessionLeadRoleState(
        persistedManagerContext.sessionManager.getEntries(),
        persistedManagerSessionId,
      )?.role,
      "manager",
    );
    assert.ok(
      restorationNotices.some((message) =>
        /Manager unavailable: this project already has an active Manager\. Manager mode is suspended\./.test(
          message,
        ),
      ),
    );
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
    assert.equal(first.pi.getActiveTools().includes("message_staff"), false);
    assert.equal(
      first.tools.find((tool) => tool.name === "message_staff"),
      staffMessage,
    );
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "lead",
    );
    writeFileSync(
      managerOverride,
      "---\nname: manager\ntools: [read]\nagents: [agent]\n---\n",
    );
    writeFileSync(
      outsideDefinition,
      "---\nname: generalist\n---\ngeneralist\n",
    );
    await persistedManager.events.get("session_shutdown")?.[0]();
    persistedManagerContext = fakeContext(persistedManager.entries) as any;
    persistedManagerSessionId = `restored-manager-${randomUUID()}`;
    persistedManagerContext.sessionManager.getSessionId = () =>
      persistedManagerSessionId;
    (persistedManager.entries[0] as any).data.sessionId =
      persistedManagerSessionId;
    await persistedManager.events.get("session_start")![0](
      undefined,
      persistedManagerContext,
    );
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.piSessionId,
      persistedManagerSessionId,
      "the restored Manager holds the verified workspace lease",
    );
    assert.equal(
      sessionLeadRoleState(
        persistedManagerContext.sessionManager.getEntries(),
        persistedManagerSessionId,
      )?.role,
      "manager",
    );
    for (const name of managerTools)
      assert.ok(persistedManager.pi.getActiveTools().includes(name), name);
    assert.ok(persistedManager.pi.getActiveTools().includes("delegate_agent"));
    const createTabsBeforeAllowed = persistedManager.calls.filter(
      (args) => args[0] === "tab" && args[1] === "create",
    ).length;
    const firstAllowedAssignment = await agentTool(
      persistedManager,
      "delegate",
    ).execute(
      "restored-manager-allowed",
      { definition: "agent", task: "allowed by the restored Manager profile" },
      undefined,
      undefined,
      persistedManagerContext,
    );
    assert.notEqual(
      firstAllowedAssignment.details.error?.category,
      "invalid_request",
      JSON.stringify(firstAllowedAssignment.details),
    );
    assert.ok(
      persistedManager.calls.filter(
        (args) => args[0] === "tab" && args[1] === "create",
      ).length > createTabsBeforeAllowed,
      "the restored agents: [agent] policy passes authorization to Herdr",
    );
    const createTabsBeforeDenied = persistedManager.calls.filter(
      (args) => args[0] === "tab" && args[1] === "create",
    ).length;
    const deniedAssignment = await agentTool(
      persistedManager,
      "delegate",
    ).execute(
      "restored-manager-denied",
      { definition: "generalist", task: "outside the restored allowlist" },
      undefined,
      undefined,
      persistedManagerContext,
    );
    assert.equal(deniedAssignment.details.error.category, "invalid_request");
    assert.equal(
      persistedManager.calls.filter(
        (args) => args[0] === "tab" && args[1] === "create",
      ).length,
      createTabsBeforeDenied,
      "a definition outside agents: [agent] is denied before Herdr launch",
    );
    await persistedManager?.events.get("session_shutdown")?.[0]();
    await first.events.get("session_shutdown")![0]();
    const replacement = fakeRepositoryChiefPi({ activeTools: ["read"], exec });
    registerExtension!(replacement.pi as never);
    try {
      const replacementContext = fakeContext() as any;
      const replacementSessionId = `lead-${randomUUID()}`;
      replacementContext.sessionManager.getSessionId = () =>
        replacementSessionId;
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
    realFs.rmSync(projectCwd, { recursive: true, force: true });
    await second.events.get("session_shutdown")?.[0]();
    await first.events.get("session_shutdown")?.[0]();
    await persistedManager?.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
    if (previousManagerOverride === undefined)
      rmSync(managerOverride, { force: true });
    else writeFileSync(managerOverride, previousManagerOverride);
    rmSync(outsideDefinition, { force: true });
  }
});

test("failed Manager activation preserves late inherited tools through rollback", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "manager-inherited-pane";
  process.env.HERDR_TAB_ID = "manager-inherited-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-inherited-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  let verifyManager = true;
  let activationIdentityChecks = 0;
  const baseline = ["read", "bash"];
  const pi = fakeRepositoryChiefPi({
    activeTools: baseline,
    allTools: [{ name: "history" }, { name: "notes" }],
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "/tmp" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "/tmp",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({
                agents:
                  verifyManager || ++activationIdentityChecks === 1
                    ? [managerAgentIdentity()]
                    : [],
              })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerAgentIdentity() })
              : isApiSnapshot(args)
                ? respond({
                    snapshot: { agents: [], panes: [], workspaces: [] },
                  })
                : respond({}),
  });
  const context = fakeContext(pi.entries) as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    pi.pi.setActiveTools(["read", "bash", "history", "notes"]);
    verifyManager = false;
    await pi.commandOptions.get("manager").handler("", context);

    assert.ok(
      notices.some((message) => message.includes("could not be verified")),
    );
    assert.equal(sessionLeadRoleState(pi.entries)?.role, "lead");
    assert.deepEqual(sessionLeadExecutionState(pi.entries)?.leadTools, [
      "read",
      "bash",
      "history",
      "notes",
    ]);
    assert.deepEqual(pi.pi.getActiveTools(), [
      "read",
      "bash",
      "history",
      "notes",
      ...leadTools,
    ]);

    await agentTool(pi, "delegate").execute(
      "manager-rollback-reconcile",
      { definition: "agent", task: "verify ordinary tools remain available" },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(pi.pi.getActiveTools(), [
      "read",
      "bash",
      "history",
      "notes",
      ...leadTools,
    ]);
    assert.deepEqual(sessionLeadExecutionState(pi.entries)?.leadTools, [
      "read",
      "bash",
      "history",
      "notes",
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
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
  const pi = fakeRepositoryChiefPi({
    activeTools: ["read"],
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "/tmp" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "/tmp",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({ agents: [managerAgentIdentity()] })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerAgentIdentity() })
              : isApiSnapshot(args)
                ? respond({
                    snapshot: { agents: [], panes: [], workspaces: [] },
                  })
                : respond({}),
  });
  const ctx = fakeContext(pi.entries) as any;
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
    const pendingRequest = {
      version: 1,
      action: "request",
      id: randomUUID(),
      sessionId: LEAD_SESSION_ID,
      branch: "fix/pending-removal",
      repoKey: "/tmp",
      assignmentId: "assignment-id",
      checkoutPath: "/tmp/fix-pending-removal",
    };
    pi.pi.appendEntry("pi-herdsman-pending-removal", pendingRequest);
    const originalAppendForRemoval = pi.pi.appendEntry;
    pi.pi.appendEntry = (type: string, data: unknown) => {
      if (type === "pi-herdsman-pending-removal")
        throw new Error("injected pending removal invalidation failure");
      originalAppendForRemoval(type, data);
    };
    await pi.commandOptions.get("manager").handler("leave", ctx);
    pi.pi.appendEntry = originalAppendForRemoval;
    assert.ok(
      notices.some((message) =>
        message.includes("injected pending removal invalidation failure"),
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
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
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
      assert.deepEqual(pi.pi.getActiveTools(), managerTools);
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
  const pi = fakeRepositoryChiefPi({
    activeTools: ["read"],
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "/tmp" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "/tmp",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({ agents: [managerAgentIdentity()] })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerAgentIdentity() })
              : isApiSnapshot(args)
                ? respond({
                    snapshot: { agents: [], panes: [], workspaces: [] },
                  })
                : respond({}),
  });
  const ctx = fakeContext() as any;
  const notices: string[] = [];
  ctx.ui.notify = (message: string) => notices.push(message);
  const ownerMailbox = agentMailboxPath(WORKSPACE, "manager-owned-agent");
  resetAgentMailbox(ownerMailbox);
  writeAgentState(ownerMailbox, {
    ...managedState("manager-owned-agent"),
    ownerSessionId: ctx.sessionManager.getSessionId(),
  });
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
    for (const name of ["list_agents", "reply_agent", "close_agent"])
      assert.ok(pi.pi.getActiveTools().includes(name), name);
    assert.ok(!pi.pi.getActiveTools().includes("delegate_agent"));
    assert.ok(!pi.pi.getActiveTools().includes("continue_agent"));
    const blocked = await agentTool(pi, "delegate").execute(
      "suspended-manager",
      { definition: "agent", task: "must not start" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(blocked.details.error.category, "invalid_request");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
    assert.equal(
      readLeadCoordinationState(runtime, LEAD_SESSION_ID),
      undefined,
    );
    await pi.commandOptions.get("manager").handler("", ctx);
    for (const name of ["list_agents", "reply_agent", "close_agent"])
      assert.ok(pi.pi.getActiveTools().includes(name), name);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(ownerMailbox);
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
  const sessionId = `manager-${randomUUID()}`;
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
        data: {
          sessionId: LEAD_SESSION_ID,
          role: "manager",
          leadTools: ["read"],
        },
      },
    ],
    exec: (command, args) => {
      if (command === "git" && args[0] === "rev-parse")
        return { stdout: "/tmp", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            workspace_id: WORKSPACE,
            worktree: null,
          },
        });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
            repo_name: "project",
          },
          worktrees: [],
        });
      const agent = {
        ...managerAgentIdentity(),
        agent_session: {
          ...managerAgentIdentity().agent_session,
          value: sessionId,
        },
      };
      if (command === "herdr" && isAgentList(args))
        return respond({ agents: [agent] });
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return respond({ agent });
      if (command === "herdr" && isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext(pi.entries) as any;
    context.sessionManager.getSessionId = () => sessionId;
    for (const entry of pi.entries as any[])
      if (entry.customType === "pi-herdsman-role")
        entry.data.sessionId = sessionId;
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
    assert.ok(pi.tools.some((tool) => tool.name === "delegate_work"));
    assert.equal(pi.pi.getActiveTools().includes("delegate_agent"), false);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "list"),
      true,
    );
    assert.equal(
      pi.entries
        .filter((entry: any) => entry.customType === "pi-herdsman-role")
        .at(-1).data.role,
      "manager",
    );
    const managerMetadata = pi.calls.findLast(
      (args) =>
        args[0] === "pane" &&
        args[1] === "report-metadata" &&
        args.includes("pi_herdsman_role=manager"),
    );
    assert.ok(managerMetadata);
    for (const token of [
      "pi_herdsman_name",
      "pi_herdsman_ask",
      "pi_herdsman_herd_run_started_at",
      "pi_herdsman_context_percent",
    ])
      assert.ok(
        managerMetadata.includes(token),
        `Manager metadata clears ${token}`,
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

test("Manager's lightweight redraw requests rendering without refreshing supervision", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "manager-redraw-pane";
  process.env.HERDR_TAB_ID = "manager-redraw-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-redraw-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const intervals: { callback: TimerHandler; delay?: number }[] = [];
  const originalSetInterval = globalThis.setInterval;
  let snapshotCalls = 0;
  let renderRequests = 0;
  let component: any;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    intervals.push({ callback, delay });
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  const pi = fakeRepositoryChiefPi({
    activeTools: ["read"],
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: {
          sessionId: LEAD_SESSION_ID,
          role: "manager",
          leadTools: ["read"],
        },
      },
    ],
    exec: (_command, args) => {
      if (isApiSnapshot(args)) {
        snapshotCalls++;
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
      }
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "/tmp", is_linked_worktree: false },
          },
        });
      if (args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (isAgentList(args))
        return respond({ agents: [managerAgentIdentity()] });
      if (args[0] === "agent" && args[1] === "get")
        return respond({ agent: managerAgentIdentity() });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries) as any;
  context.mode = "tui";
  context.hasUI = true;
  context.ui.setWidget = (_key: string, factory: unknown) => {
    if (typeof factory === "function")
      component = (factory as Function)(
        { requestRender: () => renderRequests++ },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      );
  };
  t.after(async () => {
    globalThis.setInterval = originalSetInterval;
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });

  await pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const redraw = intervals.find(({ delay }) => delay === 2000);
  assert.ok(redraw, "Manager schedules a 2s redraw interval");
  assert.equal(typeof component?.render, "function");
  const snapshotsBeforeRedraw = snapshotCalls;
  const rendersBeforeRedraw = renderRequests;
  (redraw.callback as () => void)();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshotCalls, snapshotsBeforeRedraw);
  assert.ok(renderRequests > rendersBeforeRedraw);
});

test("Manager auto-start activates after identity and coordination verification without persisting role intent", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", false);
  const projectCwd = realFs.mkdtempSync(
    join(tmpdir(), "herdsman-manager-override-"),
  );
  realFs.mkdirSync(join(projectCwd, ".pi"));
  realFs.writeFileSync(
    join(projectCwd, ".pi", "settings.json"),
    JSON.stringify({ piHerdsman: { autoActivateManager: true } }),
  );
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
  const pi = fakeRepositoryChiefPi({
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
            worktree: { repo_key: "/tmp", is_linked_worktree: false },
          },
        });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
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
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext(pi.entries) as any;
    context.cwd = projectCwd;
    context.sessionManager.getSessionId = () => sessionId;
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(healthyLeadCoordinationBeforeIdentityCheck, true);
    assert.deepEqual(pi.pi.getActiveTools(), managerTools);
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
    realFs.rmSync(projectCwd, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start does not bootstrap a non-Git workspace", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", true);
  updateConfig("managerGitBootstrapWithoutConfirmation", true);
  const projectCwd = realFs.mkdtempSync(
    join(tmpdir(), "herdsman-manager-no-git-autostart-"),
  );
  process.env.HERDR_PANE_ID = "no-git-auto-manager-pane";
  process.env.HERDR_TAB_ID = "no-git-auto-manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `no-git-auto-manager-${randomUUID()}.sock`,
  );
  const gitCalls: string[][] = [];
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: (command, args) => {
      if (command === "git") gitCalls.push(args);
      return undefined;
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries) as any;
  context.cwd = projectCwd;
  let confirmations = 0;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.confirm = async () => {
    confirmations++;
    return true;
  };
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(gitCalls, []);
    assert.equal(confirmations, 0);
    assert.equal(realFs.existsSync(join(projectCwd, ".git")), false);
    assert.equal(pi.pi.getActiveTools().includes("delegate_work"), false);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    updateConfig("autoActivateManager", undefined);
    updateConfig("managerGitBootstrapWithoutConfirmation", undefined);
    realFs.rmSync(projectCwd, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

type ManagerBootstrapGitRun = {
  args: string[];
  cwd?: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  spawnError?: { code?: string; message: string };
  stdout: string;
  stderr: string;
};

function managerBootstrapHarness(
  cwd: string,
  options: {
    unexpectedHerdr?: boolean;
    failCommitOnce?: boolean;
    stageAfterInit?: string;
    paneCwd?: unknown;
    omitPaneCwd?: boolean;
    assertLockDuringFinalScope?: boolean;
    onFinalHerdrVerification?: () => void;
    onCommittedWorktreeList?: () => void;
    workspaceWorktree?: unknown;
    sourceWorkspace?: string;
    initializeBeforeProbe?: boolean;
    failRootRediscovery?: boolean;
  } = {},
) {
  setLeadEnvironment();
  const names = [
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_SOCKET_PATH",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ];
  const previous = Object.fromEntries(
    names.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    HERDR_PANE_ID: "manager-bootstrap-pane",
    HERDR_TAB_ID: "manager-bootstrap-tab",
    HERDR_SOCKET_PATH: join(tmpdir(), `manager-bootstrap-${randomUUID()}.sock`),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
  let failCommit = options.failCommitOnce ?? false;
  let evidencePaneId = process.env.HERDR_PANE_ID!;
  let evidenceWorkspaceId = WORKSPACE;
  let evidencePaneCwd: unknown = Object.hasOwn(options, "paneCwd")
    ? options.paneCwd
    : cwd;
  let omitPaneCwd = options.omitPaneCwd ?? false;
  let finalScopeLockVerified = false;
  let committedWorktreeListResponses = 0;
  const gitRuns: ManagerBootstrapGitRun[] = [];
  let initializedBeforeProbe = false;
  let initCount = 0;
  const invocations: Array<{ command: string; args: string[]; cwd?: string }> =
    [];
  const runGit = (args: string[], gitCwd: string = cwd) => {
    const result = spawnSync("git", args, {
      cwd: gitCwd,
      encoding: "utf8",
    });
    gitRuns.push({
      args: [...args],
      cwd: gitCwd,
      status: result.status,
      signal: result.signal,
      killed: result.signal !== null,
      ...(result.error
        ? {
            spawnError: {
              code: result.error.code,
              message: result.error.message,
            },
          }
        : {}),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
    return result;
  };
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: (command, args, execOptions) => {
      invocations.push({ command, args, cwd: execOptions?.cwd });
      if (command === "git") {
        if (
          options.failRootRediscovery &&
          args[0] === "rev-parse" &&
          args.includes("--show-toplevel") &&
          initCount > 0
        )
          return { stdout: "", stderr: "", code: 1 };
        if (
          options.initializeBeforeProbe &&
          args[0] === "rev-parse" &&
          args.includes("--show-toplevel") &&
          !initializedBeforeProbe
        ) {
          initializedBeforeProbe = true;
          assert.equal(runGit(["init"]).status, 0);
          assert.equal(runGit(["config", "user.name", "Test"]).status, 0);
          assert.equal(
            runGit(["config", "user.email", "test@example.invalid"]).status,
            0,
          );
          realFs.writeFileSync(
            join(cwd, "concurrent.txt"),
            "already committed\n",
          );
          assert.equal(runGit(["add", "concurrent.txt"]).status, 0);
          assert.equal(
            runGit(["commit", "--allow-empty", "-m", "concurrent"]).status,
            0,
          );
        }
        if (args[0] === "commit" && failCommit) {
          failCommit = false;
          gitRuns.push({
            args: [...args],
            cwd: execOptions?.cwd ?? cwd,
            status: 1,
            signal: null,
            killed: false,
            stdout: "",
            stderr: "simulated commit failure",
          });
          return { stdout: "", stderr: "simulated commit failure", code: 1 };
        }
        const result = runGit(args, execOptions?.cwd ?? cwd);
        if (args[0] === "init") initCount++;
        if (args[0] === "init" && options.stageAfterInit) {
          const staged = runGit(
            ["add", options.stageAfterInit],
            execOptions?.cwd ?? cwd,
          );
          assert.equal(staged.status, 0, "Git command failed");
        }
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          code: result.status ?? 1,
        };
      }
      if (command !== "herdr") return undefined;
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            workspace_id: evidenceWorkspaceId,
            worktree: options.workspaceWorktree,
          },
        });
      if (args[0] === "pane" && args[1] === "get") {
        const pane = {
          pane_id: evidencePaneId,
          tab_id: process.env.HERDR_TAB_ID,
          workspace_id: WORKSPACE,
        } as Record<string, unknown>;
        if (!omitPaneCwd) pane.cwd = evidencePaneCwd;
        return respond({ pane });
      }
      if (args[0] === "worktree" && args[1] === "list") {
        if (options.unexpectedHerdr && !realFs.existsSync(join(cwd, ".git")))
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              error: { code: "unavailable", message: "Herdr unavailable" },
            }),
            stderr: "",
            code: 1,
          };
        const hasCommittedHead =
          realFs.existsSync(join(cwd, ".git")) &&
          spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd,
            encoding: "utf8",
          }).status === 0;
        if (hasCommittedHead && ++committedWorktreeListResponses === 1)
          options.onFinalHerdrVerification?.();
        if (hasCommittedHead) options.onCommittedWorktreeList?.();
        if (
          hasCommittedHead &&
          committedWorktreeListResponses === 1 &&
          options.assertLockDuringFinalScope
        ) {
          assert.equal(
            readLiveProcessLock(managerBootstrapLockPath(cwd)).pid,
            process.pid,
          );
          finalScopeLockVerified = true;
        }
        return hasCommittedHead
          ? respond({
              source: {
                source_workspace_id: options.sourceWorkspace ?? WORKSPACE,
                repo_key: join(cwd, ".git"),
                repo_name: "project",
              },
              worktrees: [],
            })
          : {
              stdout: JSON.stringify({
                id: AGENT_ID,
                error: {
                  code: "not_git_worktree",
                  message: "not a Git worktree",
                },
              }),
              stderr: "",
              code: 1,
            };
      }
      const agent = {
        ...managerAgentIdentity(),
        pane_id: evidencePaneId,
        workspace_id: evidenceWorkspaceId,
      };
      if (isAgentList(args)) return respond({ agents: [agent] });
      if (args[0] === "agent" && args[1] === "get") return respond({ agent });
      if (isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries) as any;
  context.cwd = cwd;
  context.mode = "rpc";
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  let confirmations = 0;
  context.ui.confirm = async () => {
    confirmations++;
    return true;
  };
  return {
    pi,
    context,
    notices,
    invocations,
    git: (args: string[], gitCwd: string = cwd) => runGit(args, gitCwd),
    gitDiagnostic: () => {
      const allowed = new Set([
        "rev-parse",
        "--show-toplevel",
        "--is-bare-repository",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
        "HEAD",
        "--git-common-dir",
        "--path-format=absolute",
        "init",
        "diff",
        "--cached",
        "--quiet",
        "ls-files",
        "--stage",
        "commit",
        "--only",
        "--allow-empty",
        "-m",
        "chore: initialize repository",
        "rev-list",
        "--parents",
        "-n",
        "1",
        "mktree",
        "HEAD^{tree}",
        "add",
      ]);
      return JSON.stringify(
        gitRuns.map(({ args, status, signal, killed, spawnError }) => ({
          args:
            args[0] === "config"
              ? ["config", "<args redacted>"]
              : args.map((arg) => (allowed.has(arg) ? arg : "<omitted>")),
          status,
          ...(signal ? { signal } : {}),
          killed,
          ...(spawnError ? { spawnError: spawnError.code } : {}),
        })),
      );
    },
    get finalScopeLockVerified() {
      return finalScopeLockVerified;
    },
    get confirmations() {
      return confirmations;
    },
    confirm: (answer: boolean) => {
      context.ui.confirm = async () => {
        confirmations++;
        return answer;
      };
    },
    setConfirm: (handler: () => Promise<boolean>) => {
      context.ui.confirm = async () => {
        confirmations++;
        return handler();
      };
    },
    setHerdrIdentity: (
      paneId: string,
      workspaceId: string,
      paneCwd: unknown = cwd,
    ) => {
      evidencePaneId = paneId;
      evidenceWorkspaceId = workspaceId;
      evidencePaneCwd = paneCwd;
      omitPaneCwd = false;
    },
    omitHerdrPaneCwd: () => {
      omitPaneCwd = true;
    },
    cleanup: async () => {
      await pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(cwd, { recursive: true, force: true });
      for (const key of names)
        previous[key] === undefined
          ? delete process.env[key]
          : (process.env[key] = previous[key]!);
      setLeadEnvironment();
    },
  };
}

function managerBootstrapLockPath(cwd: string): string {
  return join(
    herdsmanTempRoot(),
    "locks",
    `manager-bootstrap-${createHash("sha256").update(realFs.realpathSync(cwd)).digest("hex")}`,
  );
}

test("Manager bootstrap Git diagnostics redact config arguments but retain failed operation status", (t) => {
  const cwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-diagnostic-"),
  );
  const harness = managerBootstrapHarness(cwd);
  t.after(harness.cleanup);
  assert.equal(harness.git(["init"]).status, 0);
  assert.equal(
    harness.git(["config", "user.name", "Synthetic User"]).status,
    0,
  );
  assert.equal(
    harness.git(["config", "user.email", "synthetic@example.invalid"]).status,
    0,
  );
  assert.notEqual(
    harness.git(["rev-parse", "--verify", "missing-ref"]).status,
    0,
  );

  const diagnostic = harness.gitDiagnostic();
  assert.match(diagnostic, /\["config","<args redacted>"\]/);
  assert.doesNotMatch(
    diagnostic,
    /user\.name|user\.email|Synthetic User|synthetic@example\.invalid/,
  );
  assert.match(
    diagnostic,
    /"args":\["rev-parse","--verify","<omitted>"\],"status":128/,
  );
});

test("Manager explicit bootstrap confirms, checks Herdr through Pi, and creates one empty commit", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-bootstrap-"));
  realFs.writeFileSync(join(cwd, "preexisting.txt"), "existing data\n");
  realFs.writeFileSync(join(cwd, "untracked.txt"), "untracked data\n");
  const harness = managerBootstrapHarness(cwd);
  const git = (args: string[]) => {
    const result = harness.git(args);
    assert.equal(
      result.status,
      0,
      result.status === 0
        ? undefined
        : `git ${args[0]} exited ${result.status}: ${harness.gitDiagnostic()}`,
    );
    return result.stdout.trim();
  };
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  const activationStart = harness.invocations.length;
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  const activationCalls = harness.invocations.slice(activationStart);
  assert.equal(harness.confirmations, 1, harness.notices.join("\n"));
  assert.equal(git(["rev-list", "--count", "HEAD"]), "1");
  assert.equal(git(["symbolic-ref", "--short", "HEAD"]), "main");
  assert.equal(
    git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).length,
    1,
  );
  assert.equal(git(["ls-tree", "-r", "--name-only", "HEAD"]), "");
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), git(["mktree"]));
  assert.equal(git(["diff", "--cached", "--name-only"]), "");
  assert.equal(
    realFs.readFileSync(join(cwd, "preexisting.txt"), "utf8"),
    "existing data\n",
  );
  assert.equal(
    realFs.readFileSync(join(cwd, "untracked.txt"), "utf8"),
    "untracked data\n",
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
  assert.equal(
    harness.invocations.filter(
      ({ command, args }) => command === "git" && args[0] === "commit",
    ).length,
    1,
  );
  assert.ok(
    activationCalls.filter(
      ({ command, args }) =>
        command === "herdr" && args[0] === "pane" && args[1] === "get",
    ).length >= 2,
  );
  assert.ok(
    activationCalls.filter(
      ({ command, args }) =>
        command === "herdr" && args[0] === "workspace" && args[1] === "get",
    ).length >= 2,
  );
  assert.equal(
    realFs.existsSync(join(cwd, ".git", "herdsman-manager-bootstrap.lock")),
    false,
  );
  assert.equal(realFs.existsSync(managerBootstrapLockPath(cwd)), false);
});

test("Manager explicit bootstrap cancellation and unexpected Herdr failure do not run Git", async (t) => {
  for (const scenario of ["cancel", "herdr"] as const) {
    const cwd = realFs.mkdtempSync(
      join(tmpdir(), `manager-bootstrap-${scenario}-`),
    );
    const harness = managerBootstrapHarness(cwd, {
      unexpectedHerdr: scenario === "herdr",
    });
    t.after(harness.cleanup);
    if (scenario === "cancel") harness.confirm(false);
    await harness.pi.events.get("session_start")![0](
      undefined,
      harness.context,
    );
    await harness.pi.commandOptions
      .get("manager")!
      .handler("", harness.context);
    assert.equal(
      harness.invocations.some(({ command }) => command === "git"),
      false,
      scenario,
    );
    assert.equal(realFs.existsSync(join(cwd, ".git")), false, scenario);
    assert.equal(
      harness.confirmations,
      scenario === "cancel" ? 1 : 0,
      scenario,
    );
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "lead",
      scenario,
    );
  }
});

test("Manager activation of an existing Git primary does not initialize Git", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-existing-repo-"));
  const harness = managerBootstrapHarness(cwd);
  const git = (args: string[]) => {
    const result = harness.git(args);
    assert.equal(result.status, 0, `git ${args[0]} exited ${result.status}`);
  };
  git(["init"]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(harness.confirmations, 0);
  assert.equal(
    harness.invocations.some(
      ({ command, args }) => command === "git" && args[0] === "init",
    ),
    false,
  );
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
    harness.notices.join("\n"),
  );
});

test("Manager activation rejects identity changes during repository discovery", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-discovery-identity-"));
  let harness: ReturnType<typeof managerBootstrapHarness>;
  let armed = false;
  harness = managerBootstrapHarness(cwd, {
    onCommittedWorktreeList: () => {
      if (armed) harness.setHerdrIdentity("replacement-pane", WORKSPACE);
    },
  });
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  assert.equal(harness.git(["init"]).status, 0);
  assert.equal(
    harness.git(["commit", "--allow-empty", "-m", "initial"]).status,
    0,
  );
  armed = true;
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.notEqual(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
  assert.ok(harness.notices.some((notice) => /identity/i.test(notice)));
});

test("Manager activation ignores inherited workspace source but rejects explicit cross-repository association", async (t) => {
  for (const conflicting of [false, true]) {
    const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-cross-repo-"));
    const association = {
      repo_key: "/different-repository/.git",
      checkout_path: "/different-repository",
      is_linked_worktree: false,
    };
    const harness = managerBootstrapHarness(cwd, {
      sourceWorkspace: "inherited-from-another-repository",
      ...(conflicting ? { workspaceWorktree: association } : {}),
    });
    try {
      await harness.pi.events.get("session_start")![0](
        undefined,
        harness.context,
      );
      assert.equal(harness.git(["init"]).status, 0);
      assert.equal(
        harness.git(["commit", "--allow-empty", "-m", "initial"]).status,
        0,
      );
      await harness.pi.commandOptions
        .get("manager")!
        .handler("", harness.context);
      assert.equal(
        readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)
          ?.role === "manager",
        !conflicting,
      );
      assert.deepEqual(association, {
        repo_key: "/different-repository/.git",
        checkout_path: "/different-repository",
        is_linked_worktree: false,
      });
      assert.equal(
        harness.invocations.some(
          ({ command, args }) =>
            command === "herdr" &&
            ["close", "remove", "stop"].includes(args[1]),
        ),
        false,
      );
    } finally {
      await harness.cleanup();
    }
  }
});

test("Manager activation from an unassociated workspace inherited from a linked checkout uses the current repository", async (t) => {
  const root = realFs.mkdtempSync(join(tmpdir(), "manager-linked-origin-"));
  const origin = join(root, "origin");
  const linked = join(root, "linked");
  const current = join(root, "current");
  realFs.mkdirSync(origin);
  realFs.mkdirSync(current);
  const harness = managerBootstrapHarness(current, {
    sourceWorkspace: "linked-origin-workspace",
  });
  t.after(async () => {
    await harness.cleanup();
    realFs.rmSync(root, { recursive: true, force: true });
  });
  for (const [cwd, args] of [
    [origin, ["init"]],
    [origin, ["commit", "--allow-empty", "-m", "origin"]],
    [origin, ["worktree", "add", "-b", "linked", linked]],
    [current, ["init"]],
    [current, ["commit", "--allow-empty", "-m", "current"]],
  ] as const)
    assert.equal(harness.git([...args], cwd).status, 0);
  const originHead = harness.git(["rev-parse", "HEAD"], origin).stdout;
  const linkedHead = harness.git(["rev-parse", "HEAD"], linked).stdout;
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
  assert.equal(
    readManagerDescriptor(supervisionRuntime(), WORKSPACE)?.repoKey,
    join(current, ".git"),
  );
  assert.equal(harness.git(["rev-parse", "HEAD"], origin).stdout, originHead);
  assert.equal(harness.git(["rev-parse", "HEAD"], linked).stdout, linkedHead);
});

test("Manager bootstrap rejects a changed target and leaves no repository", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-bootstrap-target-"));
  const changedCwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-changed-"),
  );
  const harness = managerBootstrapHarness(cwd);
  t.after(async () => {
    await harness.cleanup();
    realFs.rmSync(changedCwd, { recursive: true, force: true });
  });
  harness.setConfirm(async () => {
    harness.context.cwd = changedCwd;
    return true;
  });
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(
    harness.invocations.some(({ command }) => command === "git"),
    false,
  );
  assert.equal(realFs.existsSync(join(cwd, ".git")), false);
  assert.ok(harness.notices.some((notice) => /workspace changed/.test(notice)));
});

test("Manager bootstrap rejects changed Herdr pane and workspace evidence after confirmation", async (t) => {
  for (const changed of ["pane", "workspace", "cwd"] as const) {
    const cwd = realFs.mkdtempSync(
      join(tmpdir(), `manager-bootstrap-${changed}-`),
    );
    const other = realFs.mkdtempSync(
      join(tmpdir(), `manager-bootstrap-${changed}-other-`),
    );
    const harness = managerBootstrapHarness(cwd);
    t.after(async () => {
      await harness.cleanup();
      realFs.rmSync(other, { recursive: true, force: true });
    });
    harness.setConfirm(async () => {
      harness.setHerdrIdentity(
        changed === "pane" ? "replacement-pane" : process.env.HERDR_PANE_ID!,
        changed === "workspace" ? "replacement-workspace" : WORKSPACE,
        changed === "cwd" ? other : cwd,
      );
      return true;
    });
    await harness.pi.events.get("session_start")![0](
      undefined,
      harness.context,
    );
    await harness.pi.commandOptions
      .get("manager")!
      .handler("", harness.context);
    assert.equal(harness.confirmations, 1, changed);
    assert.equal(
      harness.invocations.some(({ command }) => command === "git"),
      false,
      changed,
    );
    assert.equal(realFs.existsSync(join(cwd, ".git")), false, changed);
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "lead",
      changed,
    );
    assert.ok(
      harness.notices.some((notice) => /identity/.test(notice)),
      changed,
    );
  }
});

test("Project Manager menu Start uses the composed bootstrap transition", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-menu-bootstrap-"));
  const harness = managerBootstrapHarness(cwd);
  updateConfig("managerGitBootstrapWithoutConfirmation", true);
  const selected: Array<{ title: string; options: string[] }> = [];
  const choices: Array<string | undefined> = [
    "Project manager",
    "Start Manager mode",
    undefined,
  ];
  harness.context.ui.select = async (title: string, options: string[]) => {
    selected.push({ title, options });
    const choice = choices.shift();
    return options.find((option) => option === choice);
  };
  t.after(() => {
    updateConfig("managerGitBootstrapWithoutConfirmation", undefined);
    return harness.cleanup();
  });
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("herdsman")!.handler("", harness.context);
  assert.deepEqual(
    selected.map(({ title }) => (title === "Project manager" ? title : "root")),
    ["root", "Project manager", "root"],
  );
  assert.equal(harness.confirmations, 0);
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
  assert.equal(
    harness.git(["rev-parse", "HEAD^{tree}"]).stdout.trim(),
    harness.git(["mktree"]).stdout.trim(),
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
});

test("enabled explicit /manager skips confirmation and bootstraps", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-command-bootstrap-"));
  updateConfig("autoActivateManager", false);
  updateConfig("managerGitBootstrapWithoutConfirmation", true);
  const harness = managerBootstrapHarness(cwd);
  t.after(() => {
    updateConfig("managerGitBootstrapWithoutConfirmation", undefined);
    updateConfig("autoActivateManager", undefined);
    return harness.cleanup();
  });
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  updateConfig("managerGitBootstrapWithoutConfirmation", true);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(harness.confirmations, 0);
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
});

test("explicit /manager bootstraps without UI only when confirmation is opted out", async (t) => {
  t.after(() =>
    updateConfig("managerGitBootstrapWithoutConfirmation", undefined),
  );
  const enabledCwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-command-bootstrap-no-ui-enabled-"),
  );
  updateConfig("managerGitBootstrapWithoutConfirmation", true);
  const enabled = managerBootstrapHarness(enabledCwd);
  enabled.context.hasUI = false;
  t.after(() => enabled.cleanup());
  await enabled.pi.events.get("session_start")![0](undefined, enabled.context);
  await enabled.pi.commandOptions.get("manager")!.handler("", enabled.context);
  assert.equal(enabled.confirmations, 0);
  assert.equal(
    enabled.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    enabled.gitDiagnostic(),
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );

  const disabledCwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-command-bootstrap-no-ui-disabled-"),
  );
  updateConfig("managerGitBootstrapWithoutConfirmation", false);
  const disabled = managerBootstrapHarness(disabledCwd);
  disabled.context.hasUI = false;
  t.after(() => disabled.cleanup());
  await disabled.pi.events.get("session_start")![0](
    undefined,
    disabled.context,
  );
  await disabled.pi.commandOptions
    .get("manager")!
    .handler("", disabled.context);
  assert.equal(disabled.confirmations, 0);
  assert.equal(
    disabled.invocations.some(({ command }) => command === "git"),
    false,
  );
  assert.equal(realFs.existsSync(join(disabledCwd, ".git")), false);
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "lead",
  );
});

test("Manager bootstrap rejects absent, null, malformed, and mismatched PaneInfo.cwd", async (t) => {
  const other = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-pane-other-"),
  );
  t.after(() => realFs.rmSync(other, { recursive: true, force: true }));
  const cases = [
    { label: "missing", options: { omitPaneCwd: true } },
    { label: "null", options: { paneCwd: null } },
    { label: "malformed", options: { paneCwd: 42 } },
    { label: "mismatched", options: { paneCwd: other } },
  ] as const;
  for (const { label, options } of cases) {
    const cwd = realFs.mkdtempSync(
      join(tmpdir(), `manager-bootstrap-pane-${label}-`),
    );
    const harness = managerBootstrapHarness(cwd, options);
    t.after(harness.cleanup);
    await harness.pi.events.get("session_start")![0](
      undefined,
      harness.context,
    );
    await harness.pi.commandOptions
      .get("manager")!
      .handler("", harness.context);
    assert.equal(harness.confirmations, 0, label);
    assert.equal(
      harness.invocations.some(({ command }) => command === "git"),
      false,
      label,
    );
    assert.equal(realFs.existsSync(join(cwd, ".git")), false, label);
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
      "lead",
      label,
    );
  }
});

test("Manager bootstrap accepts a valid repository committed before its locked inspection", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-bootstrap-race-"));
  const harness = managerBootstrapHarness(cwd);
  t.after(harness.cleanup);
  harness.setConfirm(async () => {
    assert.equal(harness.git(["init"]).status, 0);
    assert.equal(harness.git(["config", "user.name", "Test"]).status, 0);
    assert.equal(
      harness.git(["config", "user.email", "test@example.invalid"]).status,
      0,
    );
    realFs.writeFileSync(join(cwd, "concurrent.txt"), "already committed\n");
    assert.equal(harness.git(["add", "concurrent.txt"]).status, 0);
    assert.equal(harness.git(["commit", "-m", "concurrent"]).status, 0);
    return true;
  });
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(harness.confirmations, 1);
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
  assert.equal(
    harness.git(["ls-tree", "-r", "--name-only", "HEAD"]).stdout.trim(),
    "concurrent.txt",
  );
  assert.equal(
    harness.invocations.filter(
      ({ command, args }) => command === "git" && args[0] === "commit",
    ).length,
    0,
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
});

test("Manager bootstrap rejects corrupt, bare, and enclosing repository metadata", async (t) => {
  const corruptCwd = realFs.mkdtempSync(join(tmpdir(), "manager-corrupt-git-"));
  realFs.writeFileSync(join(corruptCwd, ".git"), "not git metadata");
  const corrupt = managerBootstrapHarness(corruptCwd);
  t.after(corrupt.cleanup);
  await corrupt.pi.events.get("session_start")![0](undefined, corrupt.context);
  await corrupt.pi.commandOptions.get("manager")!.handler("", corrupt.context);
  assert.equal(
    corrupt.invocations.some(
      ({ command, args }) => command === "git" && args[0] === "init",
    ),
    false,
  );

  const bareCwd = realFs.mkdtempSync(join(tmpdir(), "manager-bare-git-"));
  assert.equal(
    spawnSync("git", ["init", "--bare"], { cwd: bareCwd }).status,
    0,
  );
  const bare = managerBootstrapHarness(bareCwd);
  t.after(bare.cleanup);
  await bare.pi.events.get("session_start")![0](undefined, bare.context);
  await bare.pi.commandOptions.get("manager")!.handler("", bare.context);
  assert.equal(
    bare.invocations.some(
      ({ command, args }) => command === "git" && args[0] === "init",
    ),
    false,
  );
  assert.equal(realFs.existsSync(join(bareCwd, ".git")), false);

  const parent = realFs.mkdtempSync(join(tmpdir(), "manager-enclosing-git-"));
  assert.equal(spawnSync("git", ["init"], { cwd: parent }).status, 0);
  const child = join(parent, "child");
  realFs.mkdirSync(child);
  const enclosing = managerBootstrapHarness(child);
  t.after(enclosing.cleanup);
  await enclosing.pi.events.get("session_start")![0](
    undefined,
    enclosing.context,
  );
  await enclosing.pi.commandOptions
    .get("manager")!
    .handler("", enclosing.context);
  assert.equal(
    enclosing.invocations.some(
      ({ command, args }) => command === "git" && args[0] === "init",
    ),
    false,
  );
  realFs.rmSync(parent, { recursive: true, force: true });
});

test("Manager bootstrap does not repeat init when root rediscovery fails", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-root-rediscovery-"));
  const harness = managerBootstrapHarness(cwd, { failRootRediscovery: true });
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(
    harness.invocations.filter(
      ({ command, args }) => command === "git" && args[0] === "init",
    ).length,
    1,
    harness.gitDiagnostic(),
  );
  assert.equal(realFs.existsSync(join(cwd, ".git")), true);
  assert.ok(
    harness.notices.some((notice) =>
      /verify its working-tree root/.test(notice),
    ),
  );
});

test("Manager bootstrap releases its lock after Git failure and retries once", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-bootstrap-retry-"));
  const lockPath = managerBootstrapLockPath(cwd);
  realFs.writeFileSync(join(cwd, "keep.txt"), "not committed\n");
  const harness = managerBootstrapHarness(cwd, { failCommitOnce: true });
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(realFs.existsSync(join(cwd, ".git")), true);
  assert.equal(
    realFs.existsSync(join(cwd, ".git", "herdsman-manager-bootstrap.lock")),
    false,
  );
  assert.equal(realFs.existsSync(lockPath), false);
  assert.equal(harness.git(["rev-parse", "--verify", "HEAD"]).status, 128);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
  assert.equal(
    harness.git(["ls-tree", "-r", "--name-only", "HEAD"]).stdout,
    "",
  );
  assert.equal(
    realFs.readFileSync(join(cwd, "keep.txt"), "utf8"),
    "not committed\n",
  );
  assert.equal(
    harness.invocations.filter(
      ({ command, args }) => command === "git" && args[0] === "commit",
    ).length,
    2,
  );
  assert.equal(
    realFs.existsSync(join(cwd, ".git", "herdsman-manager-bootstrap.lock")),
    false,
  );
  assert.equal(realFs.existsSync(lockPath), false);
});

test("Manager bootstrap acquires its shared target lock before running Git", async (t) => {
  const cwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-contended-"),
  );
  const harness = managerBootstrapHarness(cwd);
  const heldLock = acquireProcessLock(managerBootstrapLockPath(cwd));
  t.after(async () => {
    heldLock.release();
    await harness.cleanup();
  });
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  const start = harness.invocations.length;
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(
    harness.invocations.slice(start).some(({ command }) => command === "git"),
    false,
    harness.notices.join("\n"),
  );
  assert.equal(realFs.existsSync(join(cwd, ".git")), false);

  heldLock.release();
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.ok(
    harness.invocations.some(
      ({ command, args }) => command === "git" && args[0] === "init",
    ),
  );
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
});

test("Manager bootstrap safely recovers a dead shared-lock owner on retry", async (t) => {
  const cwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-crash-retry-"),
  );
  const lockPath = managerBootstrapLockPath(cwd);
  const lockModule = new URL("./lock.ts", import.meta.url).href;
  const crashedOwner = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireProcessLock } from ${JSON.stringify(lockModule)}; acquireProcessLock(process.argv[1]); process.exit(0);`,
      lockPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(crashedOwner.status, 0, crashedOwner.stderr);
  assert.equal(realFs.existsSync(lockPath), true);
  const harness = managerBootstrapHarness(cwd);
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(realFs.existsSync(join(cwd, ".git")), true);
  assert.equal(realFs.existsSync(lockPath), false, harness.notices.join("\n"));
  assert.equal(
    harness.git(["rev-list", "--count", "HEAD"]).stdout.trim(),
    "1",
    harness.gitDiagnostic(),
  );
});

test("Manager bootstrap holds its lock through final Herdr repository verification", async (t) => {
  const cwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-final-scope-"),
  );
  const harness = managerBootstrapHarness(cwd, {
    assertLockDuringFinalScope: true,
  });
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(harness.finalScopeLockVerified, true);
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "manager",
  );
});

test("Manager bootstrap rejects a session change during final Herdr verification", async (t) => {
  const cwd = realFs.mkdtempSync(
    join(tmpdir(), "manager-bootstrap-session-change-"),
  );
  const replacementSessionId = randomUUID();
  let sessionChangedDuringFinalHerdrResponse = false;
  let harness: ReturnType<typeof managerBootstrapHarness>;
  harness = managerBootstrapHarness(cwd, {
    onFinalHerdrVerification: () => {
      sessionChangedDuringFinalHerdrResponse = true;
      harness.context.sessionManager.getSessionId = () => replacementSessionId;
    },
  });
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(sessionChangedDuringFinalHerdrResponse, true);
  assert.ok(harness.notices.some((notice) => /session changed/.test(notice)));
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
    "lead",
  );
  assert.equal(
    readLeadCoordinationState(supervisionRuntime(), replacementSessionId),
    undefined,
  );
  assert.equal(harness.pi.pi.getActiveTools().includes("delegate_work"), false);
});

test("Manager bootstrap rejects and preserves a concurrent staged index", async (t) => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "manager-bootstrap-staged-"));
  realFs.writeFileSync(join(cwd, "staged.txt"), "preserve staged file\n");
  const harness = managerBootstrapHarness(cwd, {
    stageAfterInit: "staged.txt",
  });
  t.after(harness.cleanup);
  await harness.pi.events.get("session_start")![0](undefined, harness.context);
  await harness.pi.commandOptions.get("manager")!.handler("", harness.context);
  assert.equal(harness.git(["rev-parse", "--verify", "HEAD"]).status, 128);
  assert.equal(
    harness.git(["diff", "--cached", "--name-only"]).stdout.trim(),
    "staged.txt",
  );
  assert.equal(
    realFs.readFileSync(join(cwd, "staged.txt"), "utf8"),
    "preserve staged file\n",
  );
  assert.equal(
    harness.invocations.filter(
      ({ command, args }) => command === "git" && args[0] === "commit",
    ).length,
    0,
  );
  assert.equal(
    realFs.existsSync(join(cwd, ".git", "herdsman-manager-bootstrap.lock")),
    false,
  );
  assert.ok(harness.notices.some((notice) => /index/.test(notice)));
});

test("Manager auto-start rejects mismatched Herdr identity and releases its lease", async () => {
  setLeadEnvironment();
  const projectCwd = realFs.mkdtempSync(
    join(tmpdir(), "herdsman-manager-identity-project-"),
  );
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
  const pi = fakeRepositoryChiefPi({
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
            worktree: { repo_key: "/tmp", is_linked_worktree: false },
          },
        });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
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
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext(pi.entries) as any;
    context.cwd = projectCwd;
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
    realFs.rmSync(projectCwd, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start suspends and invalidates Lead when identity cleanup release fails", async () => {
  setLeadEnvironment();
  const projectCwd = realFs.mkdtempSync(
    join(tmpdir(), "herdsman-manager-cleanup-project-"),
  );
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
  const pi = fakeRepositoryChiefPi({
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
        return respond({ workspace: { worktree: { repo_key: "/tmp" } } });
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
            repo_name: "project",
          },
          worktrees: [],
        });
      if (command === "herdr" && isAgentList(args)) {
        const lock = `${managerDescriptorPath(supervisionRuntime(), WORKSPACE)}.lock`;
        if (!realFs.existsSync(lock))
          return respond({ agents: [{ ...agent, pane_id: "manager-pane" }] });
        const owner = realFs.readdirSync(lock)[0];
        assert.ok(owner);
        realFs.writeFileSync(join(lock, owner), "{}");
        return respond({ agents: [agent] });
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        return respond({ agent: { ...agent, pane_id: "manager-pane" } });
      }
      if (command === "herdr" && isApiSnapshot(args))
        return respond({ snapshot: { agents: [], panes: [], workspaces: [] } });
      return respond({});
    },
  });
  registerExtension!(pi.pi as never);
  const runtime = supervisionRuntime();
  try {
    const context = fakeContext(pi.entries) as any;
    context.cwd = projectCwd;
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
    realFs.rmSync(projectCwd, { recursive: true, force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Manager auto-start finalization suspends and invalidates Lead when rollback release fails", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  const pi = fakePi({ activeTools: ["read", "list_agents"] });
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
    controllerScope: { kind: "root" },
    pi: pi.pi,
    persistLeadCoordination: () => false,
    markLeadCoordinationUnhealthy: () => {
      invalidated = true;
    },
    appendDurableError: () => {},
    getLeadTools: () => ["read", "list_agents"],
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
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
        topologyLookups++;
      }
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get") {
        topologyLookups++;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { workspace: { worktree: { repo_key: "repo-key" } } },
          }),
          stderr: "",
          code: 0,
        };
      }
      return undefined;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries) as any,
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
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

test("malformed Lead coordination skips fallback topology restoration when auto-start is disabled", async () => {
  setLeadEnvironment();
  updateConfig("autoActivateManager", false);
  process.env.HERDR_PANE_ID = "malformed-fallback-pane";
  process.env.HERDR_TAB_ID = "malformed-fallback-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `malformed-fallback-${randomUUID()}.sock`,
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
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
        topologyLookups++;
      }
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get") {
        topologyLookups++;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { workspace: { worktree: { repo_key: "repo-key" } } },
          }),
          stderr: "",
          code: 0,
        };
      }
      return undefined;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries) as any,
    );
    assert.deepEqual(pi.pi.getActiveTools(), ["read"]);
    assert.equal(topologyLookups, 0);
    assert.equal(
      readManagerDescriptor(supervisionRuntime(), WORKSPACE),
      undefined,
    );
    assert.equal(readPeerLeadRecord(peerRuntime(), LEAD_SESSION_ID), undefined);
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
          return respond({
            snapshot: { agents: [], panes: [], workspaces: [] },
          });
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

async function managerRemovalFixture(
  t: TestContext,
  options: {
    runningLead?: boolean;
    closedWorkspace?: boolean;
    reopenedWorkspaceId?: string | null;
    reconcileError?: boolean;
    removeError?: boolean;
    snapshotErrorAfterStop?: boolean;
    changeAssignmentAfterConfirmation?: boolean;
    persistedCheckoutPath?: string;
    persistedSessionId?: string;
    missingSessionProvenance?: boolean;
    primaryWorkspaceInitially?: boolean;
    primaryWorkspaceAfterConfirmation?: boolean;
    replaceManagerAfterConfirmation?: boolean;
    interruptedRemove?: boolean;
    replacePendingOnRemoval?: boolean;
    replacementRequestId?: string;
    failPendingResolution?: boolean;
    integratedHeadSequence?: string[];
    targetBranchSequence?: string[];
    integratedTargetCodes?: number[];
    replaceAssignmentAfterRemoval?: boolean;
    mergeEnabled?: boolean;
    sourceHead?: string;
    targetHead?: string;
    revokeMergeAfterMutation?: boolean;
    replaceAssignmentOnMerge?: boolean;
    targetOccupants?: any[];
    targetAdvanceAtWorkLock?: string;
    branchRefHead?: string;
    absentCheckout?: boolean;
    revokeRemovalPreapprovalAfterPreflight?: boolean;
    replaceManagerBeforeFinalReconcile?: boolean;
    replaceAssignmentBeforeFinalReconcile?: boolean;
    unrelatedCheckout?: boolean;
    unrelatedDetachedCheckout?: boolean;
    preserveAssignmentDuringReconciliation?: boolean;
    confirmationResponse?: string;
    agentStateIssues?: boolean;
    extraAgentStates?: any[];
  } = {},
) {
  const repoKey = realFs.mkdtempSync(join(PI_AGENT_ROOT, "remove-repo-"));
  const checkoutPath = realFs.mkdtempSync(join(PI_AGENT_ROOT, "remove-child-"));
  const unrelatedPath = realFs.mkdtempSync(
    join(PI_AGENT_ROOT, "remove-unrelated-"),
  );
  if (options.absentCheckout) rmSync(checkoutPath, { recursive: true });
  const persistedCheckoutPath = options.persistedCheckoutPath
    ? realFs.mkdtempSync(join(PI_AGENT_ROOT, "remove-original-"))
    : undefined;
  t.after(() => rmSync(repoKey, { recursive: true, force: true }));
  t.after(() => rmSync(checkoutPath, { recursive: true, force: true }));
  t.after(() => rmSync(unrelatedPath, { recursive: true, force: true }));
  if (persistedCheckoutPath)
    t.after(() =>
      rmSync(persistedCheckoutPath, { recursive: true, force: true }),
    );
  const branch = "feat/remove-test";
  const manager = {
    repoKey,
    workspaceId: "manager-workspace",
    paneId: "manager-pane",
    tabId: "manager-tab",
    leaseId: "manager-lease",
    piSessionId: "manager-session",
  };
  let assignment: any = {
    version: 2,
    id: "assigned-lead",
    repoKey,
    branch,
    text: "test assignment",
    ...(!options.missingSessionProvenance
      ? { piSessionFile: "persisted-session.jsonl" }
      : {}),
  };
  let checkoutPresent = !options.absentCheckout;
  let checkoutDirty = false;
  let mergeEnabled = options.mergeEnabled ?? true;
  let currentTargetHead = options.targetHead;
  let integratedHeadReads = 0;
  let targetBranchReads = 0;
  let leadRunning = options.runningLead ?? false;
  let stoppedLeadCount = 0;
  let workspaceId = options.closedWorkspace ? undefined : "child-workspace";
  let topologyWorkspaceId = options.primaryWorkspaceInitially
    ? manager.workspaceId
    : workspaceId;
  let assignmentLockHeld = false;
  let lockCount = 0;
  let managerReplaced = false;
  let confirmationCount = 0;
  const statusUpdates: Array<[string, string | undefined]> = [];
  const sessionEntries: any[] = [];
  let activeBranch: any[] = sessionEntries;
  const removals: string[] = [];
  const removalOptions: any[] = [];
  const calls: string[][] = [];
  const gitMutations: string[][] = [];
  let reconciliationAssignmentId: string | undefined;
  let reconciliationProjectWorkLocked: boolean | undefined;
  let liveLeadChecks = 0;
  const inventoryOutput = () => {
    const worktrees = [
      `worktree ${repoKey}`,
      `HEAD ${"0".repeat(40)}`,
      "branch refs/heads/main",
      "",
      ...(checkoutPresent
        ? [
            `worktree ${checkoutPath}`,
            `HEAD ${"1".repeat(40)}`,
            `branch refs/heads/${branch}`,
            "",
          ]
        : []),
      ...(options.unrelatedCheckout
        ? [
            `worktree ${unrelatedPath}`,
            `HEAD ${"3".repeat(40)}`,
            "branch refs/heads/feat/unrelated",
            "",
          ]
        : []),
      ...(options.unrelatedDetachedCheckout
        ? [
            `worktree ${unrelatedPath}`,
            `HEAD ${"3".repeat(40)}`,
            "detached",
            "",
          ]
        : []),
      "",
    ];
    return worktrees.join("\0");
  };
  const runtime = createLeadProjectRuntime({
    pi: {
      appendEntry: (customType: string, data: unknown) => {
        if (
          options.failPendingResolution &&
          customType === "pi-herdsman-pending-removal" &&
          (data as { action?: string }).action === "resolve"
        )
          throw new Error("session append failed during resolution");
        sessionEntries.push({ type: "custom", customType, data });
      },
      exec: async (command: string, args: string[], runOptions: any) => {
        if (command === "herdr") {
          const result =
            args[0] === "workspace"
              ? { workspace: { workspace_id: manager.workspaceId } }
              : {
                  source: { repo_key: repoKey, repo_name: "project" },
                  worktrees: [],
                };
          return {
            code: 0,
            stdout: JSON.stringify({ id: AGENT_ID, result }),
            stderr: "",
          };
        }
        assert.equal(command, "git");
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
          return {
            code: 0,
            stdout: `${runOptions.cwd === repoKey ? repoKey : checkoutPath}\n`,
            stderr: "",
          };
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute")
          return { code: 0, stdout: `${repoKey}\n`, stderr: "" };
        if (
          args[0] === "worktree" &&
          args[1] === "list" &&
          args[2] === "--porcelain"
        )
          return { code: 0, stdout: inventoryOutput(), stderr: "" };
        if (args[0] === "worktree" && args[1] === "list")
          return { code: 0, stdout: inventoryOutput(), stderr: "" };
        if (args[0] === "show-ref" && args[1] === "--verify")
          return {
            code: 0,
            stdout: `${options.branchRefHead ?? "2".repeat(40)}\n`,
            stderr: "",
          };
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          if (options.sourceHead && runOptions.cwd === checkoutPath)
            return { code: 0, stdout: `${options.sourceHead}\n`, stderr: "" };
          if (currentTargetHead && runOptions.cwd === repoKey)
            return { code: 0, stdout: `${currentTargetHead}\n`, stderr: "" };
          const sequence = options.integratedHeadSequence ?? ["2".repeat(40)];
          const value =
            sequence[Math.min(integratedHeadReads++, sequence.length - 1)];
          return { code: 0, stdout: `${value}\n`, stderr: "" };
        }
        if (args[0] === "symbolic-ref") {
          if (options.replaceManagerBeforeFinalReconcile)
            managerReplaced = true;
          if (options.replaceAssignmentBeforeFinalReconcile)
            assignment = { ...assignment, id: "replacement-assignment" };
          const branches = options.targetBranchSequence ?? ["main"];
          const branch =
            branches[Math.min(targetBranchReads++, branches.length - 1)];
          return { code: 0, stdout: `${branch}\n`, stderr: "" };
        }
        if (args[0] === "merge") {
          gitMutations.push(args);
          currentTargetHead = args.at(-1);
          if (options.revokeMergeAfterMutation) mergeEnabled = false;
          if (options.replaceAssignmentOnMerge)
            assignment = { ...assignment, id: "replacement-assignment" };
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path")
          return {
            code: 0,
            stdout: `${join(repoKey, args[2]!)}\n`,
            stderr: "",
          };
        if (args[0] === "ls-files" && args[1] === "--unmerged")
          return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "merge-base" && args[1] === "--is-ancestor")
          return {
            code: options.integratedTargetCodes?.shift() ?? 0,
            stdout: "",
            stderr: "",
          };
        if (args[0] === "status")
          return {
            code: 0,
            stdout: checkoutDirty ? "?? dirty-file\n" : "",
            stderr: "",
          };
        throw new Error(
          `Unexpected Git command: ${args.join(" ")} (${runOptions.cwd})`,
        );
      },
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } } as any,
    managerLease: () => ({ descriptor: manager }),
    activeRole: () => "manager",
    readConfig: () => ({
      managerMergeEnabled: mergeEnabled,
      managerMergeOverrides: {},
    }),
    currentManager: async () =>
      managerReplaced ? { ...manager, leaseId: "replacement-lease" } : manager,
    sameManagerDescriptor: (left: any, right: any) => left === right,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: manager.workspaceId,
    }),
    supervisionRuntime: () => ({}),
    projectAssignmentPath: (_runtime: unknown, _repo: string, name: string) =>
      join(repoKey, `${name}.assignment`),
    acquireProcessLock: () => ({ release: () => {} }),
    listProjectAssignments: () => (assignment ? [assignment] : []),
    readProjectAssignment: (_runtime: unknown, _repo: string, name: string) =>
      assignment?.branch === name ? assignment : undefined,
    SessionManager: {
      open: () => ({
        getSessionId: () => options.persistedSessionId ?? assignment?.id,
        getCwd: () => persistedCheckoutPath ?? checkoutPath,
      }),
    },
    liveLead: async () => {
      liveLeadChecks++;
      if (
        options.revokeRemovalPreapprovalAfterPreflight &&
        liveLeadChecks === 2
      )
        setWorktreeRemovalPreapproved(repoKey, false);
      return leadRunning
        ? [
            {
              workspace_id: "child-workspace",
              pane_id: "child-pane",
              tab_id: "child-tab",
              cwd: checkoutPath,
            },
          ]
        : [];
    },
    readLeadCoordinationState: () => ({
      role: "lead",
      piSessionId: assignment?.id,
    }),
    requireCompatibleBuild: () => {},
    runHerdr: async (_pi: any, _ctx: any, args: string[], runOptions: any) => {
      calls.push(args);
      if (args[1] === "list")
        return {
          source: {
            source_workspace_id: manager.workspaceId,
            repo_key: repoKey,
            source_checkout_path: repoKey,
          },
          worktrees: [
            ...(checkoutPresent
              ? [
                  {
                    open_workspace_id: topologyWorkspaceId,
                    branch,
                    path: checkoutPath,
                    is_linked_worktree: true,
                  },
                ]
              : []),
            ...(options.unrelatedCheckout
              ? [
                  {
                    branch: "feat/unrelated",
                    path: unrelatedPath,
                    is_linked_worktree: true,
                  },
                ]
              : []),
            ...(options.unrelatedDetachedCheckout
              ? [{ path: unrelatedPath, is_linked_worktree: true }]
              : []),
          ],
        };
      if (args[1] === "open") {
        workspaceId =
          options.reopenedWorkspaceId === null
            ? undefined
            : (options.reopenedWorkspaceId ?? "new-child-workspace");
        topologyWorkspaceId = workspaceId;
        return {
          workspace: { workspace_id: "new-child-workspace" },
          worktree: { branch, path: checkoutPath },
        };
      }
      if (args[1] === "remove") {
        removalOptions.push(runOptions);
        if (options.replacePendingOnRemoval)
          sessionEntries.push({
            type: "custom",
            customType: "pi-herdsman-pending-removal",
            data: {
              version: 1,
              action: "request",
              id: options.replacementRequestId,
              sessionId: "manager-session",
              branch,
              repoKey,
              assignmentId: assignment.id,
              checkoutPath,
            },
          });
        if (options.interruptedRemove)
          throw new OperationError({
            category: "internal_failure",
            operation: "herdr worktree remove",
            message: "Herdr command was killed",
            rollbackOccurred: false,
            retryAttempted: false,
            details: { killed: true },
          });
        if (options.removeError) throw new Error("Herdr remove failed");
        removals.push(args[args.indexOf("--workspace") + 1]!);
        checkoutPresent = false;
        rmSync(checkoutPath, { recursive: true });
        if (options.replaceAssignmentAfterRemoval)
          assignment = { ...assignment, id: "replacement-assignment" };
        return { worktree_removed: true, forced: false };
      }
      throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    },
    herdrSessionSnapshot: async () => {
      if (options.snapshotErrorAfterStop && !leadRunning)
        throw new Error("snapshot failed after stop");
      return {
        agents: options.targetOccupants ?? [
          {
            workspace_id: "manager-workspace",
            pane_id: "manager-pane",
            tab_id: "manager-tab",
            pi_session_id: "manager-session",
          },
        ],
        panes: [],
        workspaces: [],
      };
    },
    isPiAgent: () => true,
    herdrSessionId: (agent: any) => agent.pi_session_id ?? "assigned-lead",
    scanAgentStates: () => ({
      states: (options.extraAgentStates ?? []).map((state, index) => ({
        path: `state-${index}`,
        state,
      })),
      issues: options.agentStateIssues
        ? [{ path: "unavailable", diagnostic: "test" }]
        : [],
    }),
    stopOwnedAgentsForSession: async () => ({ complete: true, summary: "" }),
    stopProjectLeadPane: async () => {
      stoppedLeadCount++;
      leadRunning = false;
    },
    withProjectWorkLock: async (_key: string, operation: () => unknown) => {
      lockCount++;
      if (options.targetAdvanceAtWorkLock) {
        currentTargetHead = options.targetAdvanceAtWorkLock;
        options.targetAdvanceAtWorkLock = undefined;
      }
      return operation();
    },
    withProjectAssignmentLock: async (
      _repoKey: string,
      _branch: string,
      operation: () => unknown,
    ) => {
      assignmentLockHeld = true;
      try {
        return await operation();
      } finally {
        assignmentLockHeld = false;
      }
    },
    reconcileProjectAssignments: async (...args: any[]) => {
      assert.equal(assignmentLockHeld, false);
      reconciliationAssignmentId = args[7];
      reconciliationProjectWorkLocked = args[4];
      if (options.reconcileError) throw new Error("reconcile uncertain");
      if (
        !options.preserveAssignmentDuringReconciliation &&
        !checkoutPresent &&
        (!args[7] || assignment?.id === args[7])
      )
        assignment = undefined;
    },
    retireProjectAssignment: (_runtime: unknown, current: any) => {
      if (assignment?.id !== current.id) return false;
      assignment = undefined;
      return true;
    },
    removeProjectMessagesForAssignment: () => {},
    appendDurableError: () => {},
    HERDSMAN_BUILD: {} as any,
  } as any);
  const ctx = fakeContext([]) as any;
  ctx.cwd = repoKey;
  ctx.sessionManager.getSessionId = () => "manager-session";
  ctx.sessionManager.getBranch = () => activeBranch;
  ctx.hasUI = true;
  ctx.ui.setStatus = (key: string, value: string | undefined) =>
    statusUpdates.push([key, value]);
  ctx.ui.input = async () => {
    assert.equal(lockCount, 0, "no operation lock may span human confirmation");
    confirmationCount++;
    if (options.replaceManagerAfterConfirmation) managerReplaced = true;
    if (options.changeAssignmentAfterConfirmation)
      assignment = { ...assignment, id: "replacement-assignment" };
    if (options.primaryWorkspaceAfterConfirmation)
      topologyWorkspaceId = "manager-workspace";
    return options.confirmationResponse ?? "remove";
  };
  return {
    runtime,
    ctx,
    sessionEntries,
    statusUpdates,
    setCheckoutDirty: (dirty: boolean) => {
      checkoutDirty = dirty;
    },
    replaceAssignment: () => {
      assignment = { ...assignment, id: "replacement-assignment" };
    },
    assignment: () => assignment,
    checkoutPath,
    repoKey,
    calls,
    gitMutations,
    removals,
    removalOptions,
    confirmationCount: () => confirmationCount,
    stoppedLeadCount: () => stoppedLeadCount,
    lockCount: () => lockCount,
    reconciliationAssignmentId: () => reconciliationAssignmentId,
    reconciliationProjectWorkLocked: () => reconciliationProjectWorkLocked,
  };
}

test("Manager explicitly releases a legacy assignment without touching an unrelated checkout", async (t) => {
  const branch = "feat/remove-test";
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedDetachedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    confirmationResponse: `forget ${branch}`,
  });
  const result = await fixture.runtime.forgetLegacyProjectAssignment(
    branch,
    fixture.ctx,
  );
  assert.equal(result.details.ok, true);
  assert.equal(fixture.assignment(), undefined);
  assert.deepEqual(fixture.removals, []);
  assert.equal(fixture.confirmationCount(), 1);
  assert.equal(fixture.reconciliationAssignmentId(), "assigned-lead");
});

test("Manager refuses to forget a branch with no durable assignment", async (t) => {
  const fixture = await managerRemovalFixture(t);
  await assert.rejects(
    fixture.runtime.forgetLegacyProjectAssignment("feat/unknown", fixture.ctx),
    /No project assignment exists on this branch/u,
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.confirmationCount(), 0);
  assert.equal(fixture.reconciliationAssignmentId(), undefined);
  assert.deepEqual(fixture.calls, []);
});

test("legacy assignment release refuses a branch checkout and preserves authority", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    missingSessionProvenance: true,
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    fixture.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      fixture.ctx,
    ),
    /Checkout provenance exists|checkout still uses this branch/u,
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.confirmationCount(), 0);
  assert.deepEqual(fixture.removals, []);
});

test("legacy assignment release cancellation and stale Manager leave authority intact", async (t) => {
  const cancelled = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    confirmationResponse: "cancel",
  });
  const result = await cancelled.runtime.forgetLegacyProjectAssignment(
    "feat/remove-test",
    cancelled.ctx,
  );
  assert.equal(result.details.cancelled, true);
  assert.ok(cancelled.assignment());

  const stale = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    confirmationResponse: "forget feat/remove-test",
    replaceManagerAfterConfirmation: true,
  });
  await assert.rejects(
    stale.runtime.forgetLegacyProjectAssignment("feat/remove-test", stale.ctx),
    /Manager authority changed/u,
  );
  assert.ok(stale.assignment());
});

test("legacy assignment release refuses known live execution before confirmation", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    runningLead: true,
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    fixture.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      fixture.ctx,
    ),
    /Live or potentially active execution is known/u,
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.confirmationCount(), 0);
});

test("legacy assignment release refuses the exact live Pi session without Lead coordination", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    targetOccupants: [{ pi_session_id: "assigned-lead" }],
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    fixture.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      fixture.ctx,
    ),
    /Live or potentially active execution is known/u,
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.confirmationCount(), 0);
});

test("legacy assignment release refuses incomplete durable Agent ownership inventory", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    agentStateIssues: true,
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    fixture.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      fixture.ctx,
    ),
    /Agent ownership inventory is incomplete/u,
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.confirmationCount(), 0);
});

test("legacy assignment release refuses a nested Agent retained by project assignment identity", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    extraAgentStates: [
      {
        ownerSessionId: "intermediate-agent",
        piSessionId: "nested-agent",
        projectAssignmentId: "assigned-lead",
      },
    ],
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    fixture.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      fixture.ctx,
    ),
    /Live or potentially active execution is known/u,
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.confirmationCount(), 0);
});

test("legacy assignment release preserves authority on unavailable observations or replaced assignment", async (t) => {
  const unavailable = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    snapshotErrorAfterStop: true,
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    unavailable.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      unavailable.ctx,
    ),
    /snapshot failed/u,
  );
  assert.ok(unavailable.assignment());
  assert.equal(unavailable.confirmationCount(), 0);

  const replaced = await managerRemovalFixture(t, {
    absentCheckout: true,
    missingSessionProvenance: true,
    unrelatedCheckout: true,
    preserveAssignmentDuringReconciliation: true,
    changeAssignmentAfterConfirmation: true,
    confirmationResponse: "forget feat/remove-test",
  });
  await assert.rejects(
    replaced.runtime.forgetLegacyProjectAssignment(
      "feat/remove-test",
      replaced.ctx,
    ),
    /Project assignment changed/u,
  );
  assert.equal(replaced.assignment()?.id, "replacement-assignment");
});

test("Manager merge runtime rejects disabled permission and stale accepted HEAD before mutation", async (t) => {
  const disabled = await managerRemovalFixture(t, { mergeEnabled: false });
  await assert.rejects(
    disabled.runtime.executeStaff(
      "merge",
      {
        action: "merge",
        branch: "feat/remove-test",
        expected_head: "2".repeat(40),
      },
      undefined,
      undefined,
      disabled.ctx,
    ),
    /not enabled/,
  );
  assert.deepEqual(disabled.gitMutations, []);
  assert.deepEqual(disabled.removals, []);

  const stale = await managerRemovalFixture(t, { sourceHead: "3".repeat(40) });
  await assert.rejects(
    stale.runtime.executeStaff(
      "merge",
      {
        action: "merge",
        branch: "feat/remove-test",
        expected_head: "2".repeat(40),
      },
      undefined,
      undefined,
      stale.ctx,
    ),
    /stale/,
  );
  assert.deepEqual(stale.gitMutations, []);
  assert.deepEqual(stale.removals, []);
});

test("Manager merge runtime reports target divergence without checkout mutation", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    integratedTargetCodes: [1, 1],
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: "2".repeat(40),
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "needs_update");
  assert.equal(result.details.integrated, false);
  assert.deepEqual(fixture.gitMutations, []);
  assert.deepEqual(fixture.removals, []);
});

test("Manager merge permits exactly its verified target occupant", async (t) => {
  const managerOccupant = {
    workspace_id: "manager-workspace",
    pane_id: "manager-pane",
    tab_id: "manager-tab",
    pi_session_id: "manager-session",
  };
  for (const targetOccupants of [
    [
      managerOccupant,
      {
        ...managerOccupant,
        pane_id: "other-pane",
        pi_session_id: "other-session",
      },
    ],
    [managerOccupant, managerOccupant],
  ]) {
    const fixture = await managerRemovalFixture(t, { targetOccupants });
    await assert.rejects(
      fixture.runtime.executeStaff(
        "merge",
        {
          action: "merge",
          branch: "feat/remove-test",
          expected_head: "2".repeat(40),
        },
        undefined,
        undefined,
        fixture.ctx,
      ),
      /occupies the primary target/,
    );
    assert.deepEqual(fixture.gitMutations, []);
    assert.deepEqual(fixture.removals, []);
  }
});

test("already-integrated retry cleans up after the target advances", async (t) => {
  const acceptedHead = "2".repeat(40);
  const advancedTarget = "4".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    sourceHead: acceptedHead,
    targetHead: advancedTarget,
    integratedTargetCodes: [0, 0, 0, 0],
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: acceptedHead,
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "complete");
  assert.equal(result.details.integrated, true);
  assert.deepEqual(fixture.gitMutations, []);
  assert.equal(fixture.removals.length, 1);
});

test("target divergence discovered under integration lock returns needs_update without stopping or cleanup", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    runningLead: true,
    targetHead: "0".repeat(40),
    targetAdvanceAtWorkLock: "4".repeat(40),
    integratedTargetCodes: [1, 0, 1, 1],
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: acceptedHead,
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "needs_update");
  assert.equal(result.details.integrated, false);
  assert.equal(fixture.stoppedLeadCount(), 0);
  assert.deepEqual(fixture.gitMutations, []);
  assert.deepEqual(fixture.removals, []);
});

test("absent checkout recovery rejects a source branch advanced past the accepted SHA", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    branchRefHead: "3".repeat(40),
  });
  await assert.rejects(
    fixture.runtime.executeStaff(
      "merge",
      {
        action: "merge",
        branch: "feat/remove-test",
        expected_head: acceptedHead,
      },
      undefined,
      undefined,
      fixture.ctx,
    ),
  );
  assert.ok(fixture.assignment());
  assert.deepEqual(fixture.removals, []);
  assert.equal(fixture.reconciliationAssignmentId(), undefined);
});

test("absent checkout recovery reconciles an exact accepted source revision without claiming a work lock", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    branchRefHead: acceptedHead,
    targetHead: acceptedHead,
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: acceptedHead,
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "complete");
  assert.equal(result.details.integrated, true);
  assert.equal(result.details.checkout_removed, true);
  assert.equal(result.details.assignment_retired, true);
  assert.equal(fixture.reconciliationAssignmentId(), "assigned-lead");
  assert.equal(fixture.reconciliationProjectWorkLocked(), false);
  assert.deepEqual(fixture.removals, []);
  assert.equal(fixture.assignment(), undefined);
});

test("absent checkout recovery refuses reconciliation after Manager identity changes", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    branchRefHead: acceptedHead,
    targetHead: acceptedHead,
    replaceManagerBeforeFinalReconcile: true,
  });
  await assert.rejects(
    fixture.runtime.executeStaff(
      "merge",
      {
        action: "merge",
        branch: "feat/remove-test",
        expected_head: acceptedHead,
      },
      undefined,
      undefined,
      fixture.ctx,
    ),
  );
  assert.ok(fixture.assignment());
  assert.equal(fixture.reconciliationAssignmentId(), undefined);
  assert.deepEqual(fixture.removals, []);
});

test("absent checkout recovery refuses reconciliation after assignment identity changes", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    absentCheckout: true,
    branchRefHead: acceptedHead,
    targetHead: acceptedHead,
    replaceAssignmentBeforeFinalReconcile: true,
  });
  await assert.rejects(
    fixture.runtime.executeStaff(
      "merge",
      {
        action: "merge",
        branch: "feat/remove-test",
        expected_head: acceptedHead,
      },
      undefined,
      undefined,
      fixture.ctx,
    ),
  );
  assert.equal(fixture.assignment()?.id, "replacement-assignment");
  assert.equal(fixture.reconciliationAssignmentId(), undefined);
  assert.deepEqual(fixture.removals, []);
});

test("ordinary preapproved removal aborts if repository approval is revoked before Herdr removal", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    revokeRemovalPreapprovalAfterPreflight: true,
  });
  setWorktreeRemovalPreapproved(fixture.repoKey, true);
  t.after(() => setWorktreeRemovalPreapproved(fixture.repoKey, false));
  await assert.rejects(
    fixture.runtime.removeWorktree("feat/remove-test", fixture.ctx),
    /preauthorization was revoked/,
  );
  assert.deepEqual(fixture.removals, []);
  assert.ok(fixture.assignment());
});

test("Manager merge runtime keeps integrated cleanup failure pending", async (t) => {
  const fixture = await managerRemovalFixture(t, { removeError: true });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: "2".repeat(40),
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "cleanup_pending");
  assert.equal(result.details.integrated, true);
  assert.equal(result.details.checkout_removed, false);
  assert.equal(result.details.assignment_retired, false);
});

test("Manager merge preserves the source if the primary branch changes after integration", async (t) => {
  const acceptedHead = "2".repeat(40);
  for (const [targetBranchSequence, status] of [
    [["main", "main", "other"], "blocked"],
    [["main", "main", "main", "other"], "cleanup_pending"],
    [["main", "main", "main", "main", "other"], "cleanup_pending"],
  ] as const) {
    const fixture = await managerRemovalFixture(t, {
      sourceHead: acceptedHead,
      targetHead: "0".repeat(40),
      integratedTargetCodes: [1, 0, 1, 0, 1, 0, 0],
      targetBranchSequence: [...targetBranchSequence],
    });
    const result = await fixture.runtime.executeStaff(
      "merge",
      {
        action: "merge",
        branch: "feat/remove-test",
        expected_head: acceptedHead,
      },
      undefined,
      undefined,
      fixture.ctx,
    );

    assert.equal(result.details.status, status);
    assert.equal(result.details.checkout_removed, false);
    assert.equal(fixture.removals.length, 0);
    assert.ok(existsSync(fixture.checkoutPath));
    if (status === "blocked") assert.equal(result.details.integrated, false);
    else assert.equal(result.details.integrated, true);
  }
});

test("Manager merge runtime fast-forwards and verifies cleanup against the exact accepted SHA", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    sourceHead: acceptedHead,
    targetHead: "0".repeat(40),
    integratedTargetCodes: [1, 0, 1, 0, 1, 0, 0],
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: acceptedHead,
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "complete");
  assert.equal(result.details.integrated, true);
  assert.equal(result.details.target_head, acceptedHead);
  assert.equal(result.details.checkout_removed, true);
  assert.equal(result.details.assignment_retired, true);
  assert.deepEqual(fixture.gitMutations, [
    [
      "merge",
      "--ff-only",
      "--no-autostash",
      "--no-overwrite-ignore",
      acceptedHead,
    ],
  ]);
  assert.equal(fixture.removals.length, 1);
  assert.equal(fixture.assignment(), undefined);
});

test("Manager merge runtime leaves verified integration pending when permission is revoked before cleanup", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    sourceHead: acceptedHead,
    targetHead: "0".repeat(40),
    integratedTargetCodes: [1, 0, 1, 0, 1, 0, 0],
    revokeMergeAfterMutation: true,
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: acceptedHead,
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "cleanup_pending");
  assert.equal(result.details.integrated, true);
  assert.equal(result.details.target_head, acceptedHead);
  assert.equal(result.details.checkout_removed, false);
  assert.equal(result.details.assignment_retired, false);
  assert.equal(fixture.gitMutations.length, 1);
  assert.deepEqual(fixture.removals, []);
  assert.ok(fixture.assignment());
});

test("Manager merge runtime does not clean up a replacement assignment after integration", async (t) => {
  const acceptedHead = "2".repeat(40);
  const fixture = await managerRemovalFixture(t, {
    sourceHead: acceptedHead,
    targetHead: "0".repeat(40),
    integratedTargetCodes: [1, 0, 1, 0, 1, 0, 0],
    replaceAssignmentOnMerge: true,
  });
  const result = await fixture.runtime.executeStaff(
    "merge",
    {
      action: "merge",
      branch: "feat/remove-test",
      expected_head: acceptedHead,
    },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.status, "cleanup_pending");
  assert.equal(result.details.integrated, true);
  assert.equal(result.details.checkout_removed, false);
  assert.equal(result.details.assignment_retired, false);
  assert.equal(fixture.assignment()?.id, "replacement-assignment");
  assert.deepEqual(fixture.removals, []);
});

test("Manager removal requests leave running and closed worktrees untouched", async (t) => {
  for (const options of [{ runningLead: true }, { closedWorkspace: true }]) {
    const fixture = await managerRemovalFixture(t, options);
    fixture.ctx.ui.input = async () => {
      throw new Error("Model removal must not prompt");
    };
    for (let request = 0; request < 2; request++) {
      const result = await fixture.runtime.executeStaff(
        "request",
        { action: "remove", branch: "feat/remove-test" },
        undefined,
        undefined,
        fixture.ctx,
      );
      assert.equal(result.details.confirmation_required, true);
      assert.equal(result.details.ok, false);
      assert.equal(result.details.checkout_removed, undefined);
      assert.equal(result.details.checkout_state, undefined);
      assert.equal(result.details.assignment_retired, undefined);
    }
    assert.equal(fixture.stoppedLeadCount(), 0);
    assert.equal(fixture.lockCount(), 0);
    assert.equal(fixture.confirmationCount(), 0);
    assert.ok(fixture.assignment());
    assert.ok(existsSync(fixture.checkoutPath));
    assert.ok(fixture.calls.every((args) => args[1] === "list"));
  }
});

test("Manager removal requests are actionable, nonblocking, and consumed once", async (t) => {
  const fixture = await managerRemovalFixture(t);
  fixture.ctx.ui.input = async () => {
    throw new Error("request must not prompt");
  };
  const request = () =>
    fixture.runtime.executeStaff(
      "request",
      { action: "remove", branch: "feat/remove-test" },
      undefined,
      undefined,
      fixture.ctx,
    );
  const first = await request();
  const duplicate = await request();
  assert.equal(first.details.pending, true);
  assert.equal(duplicate.details.pending, true);
  assert.equal(first.details.request_id, duplicate.details.request_id);
  assert.equal(fixture.sessionEntries.length, 1);
  assert.equal(fixture.runtime.listPendingRemovals(fixture.ctx).length, 1);
  assert.equal(fixture.confirmationCount(), 0);
  const selected = fixture.runtime.listPendingRemovals(fixture.ctx)[0];
  fixture.ctx.ui.input = async () => "remove";
  const approved = await fixture.runtime.approvePendingRemoval(
    selected,
    fixture.ctx,
  );
  assert.equal(approved.details.checkout_removed, true);
  assert.equal(fixture.runtime.listPendingRemovals(fixture.ctx).length, 0);
  await assert.rejects(
    fixture.runtime.approvePendingRemoval(selected, fixture.ctx),
    /Pending removal (?:is no longer available|changed)/,
  );
  assert.deepEqual(fixture.removals, ["child-workspace"]);
});

test("successful direct Manager removal clears matching pending approval", async (t) => {
  const fixture = await managerRemovalFixture(t);
  await fixture.runtime.executeStaff(
    "request",
    { action: "remove", branch: "feat/remove-test" },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(fixture.runtime.listPendingRemovals(fixture.ctx).length, 1);
  assert.match(
    String(fixture.statusUpdates.at(-1)?.[1]),
    /1 worktree removal approval pending/,
  );

  const result = await fixture.runtime.removeWorktree(
    "feat/remove-test",
    fixture.ctx,
  );

  assert.equal(result.details.checkout_removed, true);
  assert.deepEqual(fixture.runtime.listPendingRemovals(fixture.ctx), []);
  assert.equal(fixture.statusUpdates.at(-1)?.[1], undefined);
});

test("integrated cleanup rechecks exact source HEAD and target ancestry immediately before removal", async (t) => {
  for (const options of [
    { integratedHeadSequence: ["2".repeat(40), "3".repeat(40)] },
    { integratedHeadSequence: ["2".repeat(40)], integratedTargetCodes: [0, 1] },
  ]) {
    const fixture = await managerRemovalFixture(t, options);
    const result = await fixture.runtime.removeWorktree(
      "feat/remove-test",
      fixture.ctx,
      undefined,
      {
        integration: {
          assignmentId: "assigned-lead",
          sourceHead: "2".repeat(40),
          targetPath: fixture.repoKey,
          targetBranch: "main",
        },
      },
    );
    assert.equal(result.details.checkout_removed, false);
    assert.match(result.content[0].text, /changed before removal/);
    assert.deepEqual(fixture.removals, []);
  }
});

test("integrated cleanup does not reconcile a same-branch replacement assignment", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    replaceAssignmentAfterRemoval: true,
  });
  const result = await fixture.runtime.removeWorktree(
    "feat/remove-test",
    fixture.ctx,
    undefined,
    {
      integration: {
        assignmentId: "assigned-lead",
        sourceHead: "2".repeat(40),
        targetPath: fixture.repoKey,
        targetBranch: "main",
      },
    },
  );

  assert.equal(fixture.reconciliationAssignmentId(), "assigned-lead");
  assert.equal(fixture.assignment()?.id, "replacement-assignment");
  assert.equal(result.details.checkout_removed, true);
  assert.equal(result.details.assignment_retired, false);
});

test("successful direct Manager removal preserves a newer pending replacement", async (t) => {
  const replacementId = randomUUID();
  const fixture = await managerRemovalFixture(t, {
    replacePendingOnRemoval: true,
    replacementRequestId: replacementId,
  });
  await fixture.runtime.executeStaff(
    "request",
    { action: "remove", branch: "feat/remove-test" },
    undefined,
    undefined,
    fixture.ctx,
  );

  const result = await fixture.runtime.removeWorktree(
    "feat/remove-test",
    fixture.ctx,
  );

  assert.equal(result.details.checkout_removed, true);
  assert.equal(
    fixture.runtime.listPendingRemovals(fixture.ctx)[0]?.id,
    replacementId,
  );
  assert.match(
    String(fixture.statusUpdates.at(-1)?.[1]),
    /1 worktree removal approval pending/,
  );
});

test("Manager removal retires assignment when pending approval resolution persistence fails", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    failPendingResolution: true,
  });
  await fixture.runtime.executeStaff(
    "request",
    { action: "remove", branch: "feat/remove-test" },
    undefined,
    undefined,
    fixture.ctx,
  );

  const result = await fixture.runtime.removeWorktree(
    "feat/remove-test",
    fixture.ctx,
  );

  assert.equal(result.details.checkout_removed, true);
  assert.equal(result.details.assignment_retired, true);
  assert.equal(fixture.assignment(), undefined);
  assert.equal(existsSync(fixture.checkoutPath), false);
  assert.match(
    result.details.pendingResolutionError,
    /session append failed during resolution/,
  );
  assert.match(
    result.content[0].text,
    /Warning: pending removal approval could not be resolved: session append failed during resolution/,
  );
});

test("pending removal intent restores from the active session branch and rejects malformed or foreign entries", async (t) => {
  const fixture = await managerRemovalFixture(t);
  await fixture.runtime.executeStaff(
    "request",
    { action: "remove", branch: "feat/remove-test" },
    undefined,
    undefined,
    fixture.ctx,
  );
  const request = fixture.runtime.listPendingRemovals(fixture.ctx)[0]!;
  assert.ok(request.id);
  assert.equal(
    fixture.runtime.listPendingRemovals(fixture.ctx)[0]?.id,
    request.id,
  );
  assert.match(
    String(fixture.statusUpdates.at(-1)?.[1]),
    /1 worktree removal approval pending.*\/manager remove/,
  );
  fixture.sessionEntries.push(
    {
      type: "custom",
      customType: "pi-herdsman-pending-removal",
      data: { version: 1, action: "request", id: "malformed" },
    },
    {
      type: "custom",
      customType: "pi-herdsman-pending-removal",
      data: {
        version: 1,
        action: "request",
        id: randomUUID(),
        sessionId: "another-session",
        branch: "feat/other",
        repoKey: "repo",
        assignmentId: "assignment",
        checkoutPath: "/tmp/other",
      },
    },
  );
  assert.deepEqual(
    fixture.runtime.listPendingRemovals(fixture.ctx).map(({ id }) => id),
    [request.id],
  );
  fixture.ctx.sessionManager.getSessionId = () => "another-session";
  fixture.ctx.sessionManager.getBranch = () => [];
  assert.deepEqual(fixture.runtime.listPendingRemovals(fixture.ctx), []);
  fixture.ctx.sessionManager.getSessionId = () => "manager-session";
  fixture.ctx.sessionManager.getBranch = () => fixture.sessionEntries;
  fixture.runtime.invalidatePendingRemovals(fixture.ctx);
  assert.deepEqual(fixture.runtime.listPendingRemovals(fixture.ctx), []);
  assert.equal(fixture.removals.length, 0);
  assert.equal(fixture.statusUpdates.at(-1)?.[1], undefined);
});

test("Manager pending selection cannot approve or dismiss its replacement", async (t) => {
  const fixture = await managerRemovalFixture(t);
  const request = () =>
    fixture.runtime.executeStaff(
      "request",
      { action: "remove", branch: "feat/remove-test" },
      undefined,
      undefined,
      fixture.ctx,
    );
  await request();
  const selected = fixture.runtime.listPendingRemovals(fixture.ctx)[0];
  fixture.replaceAssignment();
  await request();
  const replacement = fixture.runtime.listPendingRemovals(fixture.ctx)[0];
  assert.notEqual(replacement, selected);
  assert.notEqual(replacement.id, selected.id);

  await assert.rejects(
    fixture.runtime.approvePendingRemoval(selected, fixture.ctx),
    /Pending removal changed/,
  );
  assert.equal(
    fixture.runtime.cancelPendingRemoval(selected, fixture.ctx),
    false,
  );
  assert.equal(
    fixture.runtime.listPendingRemovals(fixture.ctx)[0].id,
    replacement.id,
  );
  assert.deepEqual(fixture.removals, []);
  assert.ok(fixture.assignment());
  assert.ok(existsSync(fixture.checkoutPath));
});

test("cancelling an approved request preserves a newer pending request", async (t) => {
  const fixture = await managerRemovalFixture(t);
  const request = () =>
    fixture.runtime.executeStaff(
      "request",
      { action: "remove", branch: "feat/remove-test" },
      undefined,
      undefined,
      fixture.ctx,
    );
  await request();
  const selected = fixture.runtime.listPendingRemovals(fixture.ctx)[0];

  fixture.ctx.ui.input = async () => {
    fixture.replaceAssignment();
    await request();
    return undefined;
  };

  const result = await fixture.runtime.approvePendingRemoval(
    selected,
    fixture.ctx,
  );
  assert.equal(result.details.cancelled, true);
  assert.equal(
    fixture.runtime.listPendingRemovals(fixture.ctx)[0].assignmentId,
    "replacement-assignment",
  );
  assert.deepEqual(fixture.removals, []);
});

test("human-approved dirty Manager removal refuses before Herdr remove", async (t) => {
  const fixture = await managerRemovalFixture(t);
  const requested = await fixture.runtime.executeStaff(
    "request",
    { action: "remove", branch: "feat/remove-test" },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(requested.details.pending, true);
  let humanDialogCount = 0;
  fixture.ctx.ui.input = async () => {
    humanDialogCount++;
    fixture.setCheckoutDirty(true);
    return "remove";
  };

  await assert.rejects(
    fixture.runtime.approvePendingRemoval(
      fixture.runtime.listPendingRemovals(fixture.ctx)[0],
      fixture.ctx,
    ),
    /Checkout is dirty or could not be verified; worktree preserved/,
  );
  assert.equal(humanDialogCount, 1);
  assert.deepEqual(fixture.removals, []);
  assert.equal(
    fixture.calls.some((args) => args[1] === "remove"),
    false,
    "dirty approval must not invoke Herdr worktree remove",
  );
  assert.ok(fixture.assignment());
  assert.ok(existsSync(fixture.checkoutPath));
});

test("Manager preauthorization lets explicit model requests use the guarded remover", async (t) => {
  const fixture = await managerRemovalFixture(t);
  const repoKey = fixture.assignment().repoKey;
  setWorktreeRemovalPreapproved(repoKey, true);
  t.after(() => setWorktreeRemovalPreapproved(repoKey, false));
  fixture.ctx.ui.input = async () => {
    throw new Error("preauthorized removal must not prompt");
  };
  const result = await fixture.runtime.executeStaff(
    "request",
    { action: "remove", branch: "feat/remove-test" },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.details.checkout_removed, true);
  assert.equal(result.details.forced, false);
  assert.equal(fixture.confirmationCount(), 0);
  assert.deepEqual(fixture.removals, ["child-workspace"]);
});

test("Manager removal rejects a replaced Manager after confirmation", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    replaceManagerAfterConfirmation: true,
  });
  await assert.rejects(
    fixture.runtime.removeWorktree("feat/remove-test", fixture.ctx),
    /Manager lease is no longer active/,
  );
  assert.equal(fixture.confirmationCount(), 1);
  assert.deepEqual(fixture.removals, []);
  assert.ok(fixture.assignment());
});

test("Manager removal requires the exact confirmation word", async (t) => {
  const fixture = await managerRemovalFixture(t, { runningLead: true });
  let confirmation = "";
  for (const answer of [
    undefined,
    "",
    "Remove",
    " remove",
    "remove ",
    "cancel",
  ]) {
    fixture.ctx.ui.input = async (message: string) => {
      confirmation = message;
      return answer;
    };
    const result = await fixture.runtime.removeWorktree(
      "feat/remove-test",
      fixture.ctx,
    );
    assert.equal(result.details.cancelled, true);
    assert.equal(fixture.stoppedLeadCount(), 0);
    assert.deepEqual(fixture.removals, []);
    assert.ok(fixture.assignment());
    assert.ok(existsSync(fixture.checkoutPath));
  }
  assert.match(
    confirmation,
    /automatically stops its running Managed Lead and owned Agents first/,
  );
  assert.match(confirmation, /Removes this checkout and Herdr workspace/);
  assert.match(confirmation, /not automatically restarted/);
  assert.match(confirmation, /Git branch and Pi conversation are preserved/);
  assert.match(confirmation, /retired only after verified checkout removal/);
});

test("Manager removal covers paused, running, and reopened checkout lifecycles", async (t) => {
  for (const scenario of [
    { name: "paused", runningLead: false, closedWorkspace: false },
    { name: "running", runningLead: true, closedWorkspace: false },
    { name: "closed", runningLead: false, closedWorkspace: true },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await managerRemovalFixture(subtest, scenario);
      const result = await fixture.runtime.removeWorktree(
        "feat/remove-test",
        fixture.ctx,
      );
      assert.equal(result.details.checkout_removed, true);
      assert.equal(result.details.assignment_retired, true);
      assert.equal(result.details.forced, false);
      assert.equal(fixture.assignment(), undefined);
      if (scenario.runningLead) assert.equal(result.details.lead_stopped, true);
      else assert.equal(result.details.lead_stopped, false);
      if (scenario.closedWorkspace) {
        assert.ok(
          fixture.calls.some(
            (args) =>
              args[1] === "open" &&
              args.includes("--branch") &&
              args.includes("feat/remove-test"),
          ),
        );
        assert.deepEqual(fixture.removals, ["new-child-workspace"]);
      } else {
        assert.deepEqual(fixture.removals, ["child-workspace"]);
      }
    });
  }
});

test("Manager removal reports native failure and uncertain assignment reconciliation truthfully", async (t) => {
  const failed = await managerRemovalFixture(t, {
    runningLead: true,
    removeError: true,
  });
  const failure = await failed.runtime.removeWorktree(
    "feat/remove-test",
    failed.ctx,
  );
  assert.equal(failure.details.lead_stopped, true);
  assert.equal(failure.details.checkout_removed, false);
  assert.equal(failure.details.assignment_retired, false);
  assert.match(failure.details.removal_error, /Herdr remove failed/);
  assert.ok(failed.assignment());

  const uncertain = await managerRemovalFixture(t, { reconcileError: true });
  const outcome = await uncertain.runtime.removeWorktree(
    "feat/remove-test",
    uncertain.ctx,
  );
  assert.equal(outcome.details.checkout_removed, true);
  assert.equal(outcome.details.assignment_retired, false);
  assert.equal(uncertain.assignment()?.id, "assigned-lead");
  assert.match(outcome.details.retirement_error, /reconcile uncertain/);

  const stopped = await managerRemovalFixture(t, {
    runningLead: true,
    snapshotErrorAfterStop: true,
  });
  await assert.rejects(
    stopped.runtime.removeWorktree("feat/remove-test", stopped.ctx),
    /Assigned Lead stopped; worktree removal did not complete: snapshot failed after stop/,
  );
  assert.deepEqual(stopped.removals, []);
  assert.ok(stopped.assignment());
});

test("Manager removal reports interrupted CLI as unconfirmed and preserves assignment", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    runningLead: true,
    interruptedRemove: true,
  });
  const result = await fixture.runtime.removeWorktree(
    "feat/remove-test",
    fixture.ctx,
  );
  const text = result.content[0].text;

  assert.equal(fixture.removalOptions.length, 1);
  assert.equal(fixture.removalOptions[0].timeout, 180_000);
  assert.equal(fixture.removalOptions[0].signal, fixture.ctx.signal);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.checkout_removed, false);
  assert.equal(result.details.checkout_state, "present");
  assert.equal(result.details.assignment_retired, false);
  assert.match(text, /checkout was present at the last check/);
  assert.match(text, /assignment remains recorded/);
  assert.match(text, /Herdr may still complete removal after the CLI stopped/);
  assert.match(result.details.removal_error, /Herdr command was killed/);
  assert.equal(fixture.assignment()?.id, "assigned-lead");
  assert.ok(existsSync(fixture.checkoutPath));
  assert.deepEqual(fixture.removals, []);
  assert.equal(fixture.stoppedLeadCount(), 1);
});

test("closed Manager removal refuses absent or mismatched reopened workspace identity", async (t) => {
  for (const reopenedWorkspaceId of [null, "unexpected-workspace"]) {
    await t.test(String(reopenedWorkspaceId), async (subtest) => {
      const fixture = await managerRemovalFixture(subtest, {
        closedWorkspace: true,
        reopenedWorkspaceId,
      });
      await assert.rejects(
        fixture.runtime.removeWorktree("feat/remove-test", fixture.ctx),
        /Removal target changed before native removal/,
      );
      assert.deepEqual(fixture.removals, []);
      assert.equal(fixture.assignment()?.id, "assigned-lead");
    });
  }
});

test("Manager removal revalidates exact assignment identity after confirmation", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    changeAssignmentAfterConfirmation: true,
  });
  await assert.rejects(
    fixture.runtime.removeWorktree("feat/remove-test", fixture.ctx),
    /Removal target changed during confirmation/,
  );
  assert.deepEqual(fixture.removals, []);
  assert.equal(fixture.assignment()?.id, "replacement-assignment");
});

test("Manager removal requires persisted session checkout provenance", async (t) => {
  const stale = await managerRemovalFixture(t, {
    persistedCheckoutPath: join(PI_AGENT_ROOT, "other-checkout-a"),
  });
  await assert.rejects(
    stale.runtime.removeWorktree("feat/remove-test", stale.ctx),
    /Persisted project session provenance does not match the checkout/,
  );
  assert.equal(stale.confirmationCount(), 0);
  assert.deepEqual(stale.removals, []);

  const wrongSession = await managerRemovalFixture(t, {
    persistedSessionId: "different-lead-session",
  });
  await assert.rejects(
    wrongSession.runtime.removeWorktree("feat/remove-test", wrongSession.ctx),
    /Persisted project session provenance does not match the checkout/,
  );
  assert.equal(wrongSession.confirmationCount(), 0);
  assert.deepEqual(wrongSession.removals, []);
});

test("Manager removal refuses a same-branch replacement without persisted checkout provenance", async (t) => {
  const fixture = await managerRemovalFixture(t, {
    runningLead: true,
    missingSessionProvenance: true,
  });
  await assert.rejects(
    fixture.runtime.removeWorktree("feat/remove-test", fixture.ctx),
    /Project checkout provenance is unavailable; worktree preserved/,
  );
  assert.equal(fixture.confirmationCount(), 0);
  assert.equal(fixture.stoppedLeadCount(), 0);
  assert.deepEqual(fixture.removals, []);
  assert.ok(fixture.assignment());
});

test("Manager removal rejects primary workspace identity before and after confirmation", async (t) => {
  const initial = await managerRemovalFixture(t, {
    primaryWorkspaceInitially: true,
  });
  await assert.rejects(
    initial.runtime.removeWorktree("feat/remove-test", initial.ctx),
    /primary workspace cannot be removed/,
  );
  assert.equal(initial.confirmationCount(), 0);

  const changed = await managerRemovalFixture(t, {
    primaryWorkspaceAfterConfirmation: true,
  });
  await assert.rejects(
    changed.runtime.removeWorktree("feat/remove-test", changed.ctx),
    /primary workspace cannot be removed/,
  );
  assert.equal(changed.confirmationCount(), 1);
  assert.deepEqual(changed.removals, []);
});

test("Manager removal confirmation is dismissed by an aborted tool/context signal", async (t) => {
  const fixture = await managerRemovalFixture(t);
  const controller = new AbortController();
  fixture.ctx.signal = controller.signal;
  fixture.ctx.ui.input = async (
    _prompt: string,
    _placeholder: undefined,
    options: any,
  ) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    return "remove";
  };
  await assert.rejects(
    fixture.runtime.removeWorktree("feat/remove-test", fixture.ctx),
    /abort/i,
  );
  assert.deepEqual(fixture.removals, []);
});

async function managerDelegateAssignmentTest(
  t: TestContext,
  projectTrusted: boolean,
  lockOrder?: "manager-first" | "lead-first",
) {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdr-${randomUUID()}`
      : `/tmp/herdr-${randomUUID()}.sock`;
  const lifecycleSocketPath = process.env.HERDR_SOCKET_PATH;
  const repoKey = join(
    PI_AGENT_ROOT,
    `herdsman-command-repo-key-${randomUUID()}`,
  );
  realFs.mkdirSync(repoKey);
  t.after(() => rmSync(repoKey, { recursive: true, force: true }));
  const childWorkspace = `child-${randomUUID()}`;
  const childCwd = realFs.mkdtempSync(join(PI_AGENT_ROOT, "manager-child-"));
  t.after(() => rmSync(childCwd, { recursive: true, force: true }));
  const managedLeadDir = join(childCwd, ".pi", "agents");
  realFs.mkdirSync(managedLeadDir, { recursive: true });
  realFs.writeFileSync(
    join(managedLeadDir, "managed-lead.md"),
    "---\nname: managed-lead\nthinking: low\nbodyMode: append\n---\n\nTARGET_WORKTREE_MANAGED_LEAD",
  );
  let childSession = `lead-${randomUUID()}`;
  let lead: any;
  let leadCtx: any;
  let leadStarted = false;
  let initializeLeadRuntime!: () => Promise<void>;
  let lockPhase = "";
  let leadToolError: unknown;
  let leadToolResult: unknown;
  let leadPublication: Promise<void> | undefined;
  let managerLockClaim: ReturnType<typeof readLiveProcessLock> | undefined;
  let leadLockClaim: ReturnType<typeof readLiveProcessLock> | undefined;
  let lockedAssignmentSnapshot: unknown;
  let releaseLeadLock!: () => void;
  const leadLockRelease = new Promise<void>((resolve) => {
    releaseLeadLock = resolve;
  });
  let signalLeadLock!: () => void;
  const leadLockHeld = new Promise<void>((resolve) => {
    signalLeadLock = resolve;
  });
  let signalManagerWait!: () => void;
  const managerWaitStarted = new Promise<void>((resolve) => {
    signalManagerWait = resolve;
  });
  let signalLeadWait!: () => void;
  const leadWaitStarted = new Promise<void>((resolve) => {
    signalLeadWait = resolve;
  });
  let primaryWorkspace = WORKSPACE;
  const childSessionPath = () => join(tmpdir(), `${childSession}.jsonl`);
  let created = false;
  let createdBranch = "";
  let reportCheckoutAbsent = false;
  let gitStatusOutput = "";
  let started = false;
  let manager1Shutdown = false;
  let failScopeLookup = false;
  let unavailableScope = false;
  let topologyRequests = 0;
  let lifecycleServer: ReturnType<typeof createServer> | undefined;
  const lifecycleClients = new Set<any>();
  const subscribedLifecycleClients = new Set<any>();
  let lifecycleSubscriptions = 0;
  const tabLabels = new Map([
    ["root-tab", "1"],
    ["child-tab", "1"],
  ]);
  const tabCommands: string[][] = [];
  let managerUsesRootPane = false;
  let holdChildPaneGet = false;
  let childPaneGetDidStart = false;
  let releaseChildPaneGet!: () => void;
  const heldChildPaneGet = new Promise<void>(
    (resolve) => (releaseChildPaneGet = resolve),
  );
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
  const exec = (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    if (command === "herdr" && args[0] === "tab" && args[1] === "list") {
      tabCommands.push(args);
      const tabId = args[3] === childWorkspace ? "child-tab" : "root-tab";
      return respond({
        tabs: [
          {
            tab_id: tabId,
            number: tabId === "child-tab" ? 41 : 27,
            label: tabLabels.get(tabId),
          },
        ],
      });
    }
    if (command === "herdr" && args[0] === "tab" && args[1] === "rename") {
      tabCommands.push(args);
      tabLabels.set(args[2]!, args[3]!);
      return respond({});
    }
    if (command === "git") {
      if (args[0] === "status")
        return { stdout: gitStatusOutput, stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { stdout: `${childCwd}\n`, stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute")
        return {
          stdout: `${options?.cwd === childCwd && (args.includes("--show-toplevel") || args.includes("--git-dir")) ? childCwd : repoKey}\n`,
          stderr: "",
          code: 0,
        };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: [
            `worktree ${repoKey}`,
            `HEAD ${"0".repeat(40)}`,
            "branch refs/heads/main",
            "",
            ...(!reportCheckoutAbsent
              ? [
                  `worktree ${realFs.realpathSync(childCwd)}`,
                  `HEAD ${"1".repeat(40)}`,
                  `branch refs/heads/${createdBranch}`,
                  "",
                ]
              : []),
            "",
          ].join("\0"),
          stderr: "",
          code: 0,
        };
      if (args[0] === "symbolic-ref")
        return { stdout: `${createdBranch}\n`, stderr: "", code: 0 };
    }
    if (
      (failScopeLookup || unavailableScope) &&
      command === "herdr" &&
      args[0] === "worktree" &&
      args[1] === "list"
    )
      return unavailableScope
        ? nonGitWorkspaceResponse()
        : {
            stdout: JSON.stringify({
              id: AGENT_ID,
              error: { code: "unavailable", message: "scope lookup failure" },
            }),
            stderr: "",
            code: 1,
          };
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          workspace_id: args[2],
          worktree: {
            repo_key: repoKey,
            is_linked_worktree: args[2] === childWorkspace,
            checkout_path: args[2] === childWorkspace ? childCwd : repoKey,
          },
        },
        ...(args[2] === childWorkspace
          ? { root_pane: { pane_id: "child-pane", tab_id: "child-tab" } }
          : {}),
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
      topologyRequests++;
      return respond({
        source: {
          source_workspace_id: primaryWorkspace,
          repo_key: repoKey,
          repo_name: "project",
          source_checkout_path: reportCheckoutAbsent ? repoKey : repoKey,
        },
        worktrees: created
          ? [
              {
                open_workspace_id: primaryWorkspace,
                branch: "main",
                path: repoKey,
                is_linked_worktree: false,
              },
              ...(!reportCheckoutAbsent
                ? [
                    {
                      open_workspace_id: childWorkspace,
                      branch: listProjectAssignments(
                        supervisionRuntime(),
                        repoKey,
                      )[0]?.branch,
                      path: realFs.realpathSync(childCwd),
                      is_linked_worktree: true,
                    },
                  ]
                : []),
              {
                branch: "closed-worktree",
                path: "/tmp/manager-closed",
                is_linked_worktree: true,
              },
            ]
          : [],
      });
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
      const branchIndex = args.indexOf("--branch");
      createdBranch = args[branchIndex + 1]!;
      assert.ok(createdBranch);
      created = true;
      return respond({
        workspace: { workspace_id: childWorkspace },
        tab: { tab_id: "child-tab" },
        root_pane: { pane_id: "child-pane", tab_id: "child-tab" },
        worktree: { branch: createdBranch, path: childCwd },
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
    if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
      if (args[2] === "child-pane") tabCommands.push(args);
      const paneResult = () =>
        respond({
          pane: {
            pane_id: "child-pane",
            workspace_id: childWorkspace,
            tab_id: "child-tab",
            terminal_id: "child-terminal",
            cwd: childCwd,
          },
        });
      if (args[2] === "child-pane" && holdChildPaneGet) {
        holdChildPaneGet = false;
        childPaneGetDidStart = true;
        return heldChildPaneGet.then(paneResult);
      }
      return paneResult();
    }
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
    if (args[0] === "agent" && args[1] === "start") {
      started = true;
      const [assignment] = listProjectAssignments(
        supervisionRuntime(),
        repoKey,
      );
      assert.ok(assignment);
      const assignmentLease = claimProcessLock(
        `${projectAssignmentPath(supervisionRuntime(), repoKey, assignment.branch)}.lock`,
        { name: "test startup assignment lock release" },
      );
      assignmentLease();
      const sessionIdIndex = args.indexOf("--session-id");
      assert.notEqual(sessionIdIndex, -1);
      childSession = args[sessionIdIndex + 1]!;
      assert.equal(childSession, assignment.id);
      const toolsIndex = args.indexOf("--tools");
      assert.notEqual(toolsIndex, -1);
      assert.equal(args.includes("--no-tools"), true);
      assert.deepEqual(args[toolsIndex + 1]!.split(","), [
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
      assert.notEqual(promptIndex, -1);
      const childPrompt = readFileSync(args[promptIndex + 1]!, "utf8");
      if (projectTrusted) {
        assert.match(childPrompt, /TARGET_WORKTREE_MANAGED_LEAD/);
      } else {
        assert.doesNotMatch(childPrompt, /TARGET_WORKTREE_MANAGED_LEAD/);
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
          workspaces: [],
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
                  cwd: childCwd,
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
          cwd: realFs.realpathSync(childCwd),
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
                  cwd: childCwd,
                },
              ]
            : []),
        ],
      });
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({
        agent:
          args[2] === "child-pane"
            ? {
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "path",
                  value: childSessionPath(),
                },
                workspace_id: childWorkspace,
                pane_id: "child-pane",
                tab_id: "child-tab",
                cwd: childCwd,
              }
            : managerAgent,
      });
    return respond({});
  };
  let mutateRetainedSource: (() => void) | undefined;
  const managerExec = async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    mutateRetainedSource?.();
    if (
      managerUsesRootPane &&
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "get"
    )
      return respond({
        pane: {
          pane_id: "root-pane",
          workspace_id: WORKSPACE,
          tab_id: "root-tab",
          terminal_id: "root-terminal",
          cwd: "/tmp/manager-root",
        },
      });
    const result = await exec(command, args, options);
    if (
      lockOrder === "lead-first" &&
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "start"
    ) {
      await initializeLeadRuntime();
      lockPhase = "lead-publish";
      const messageTool = lead.tools.find(
        (tool: any) => tool.name === "message_supervisor",
      )!;
      leadPublication = messageTool
        .execute(
          "contention-ready",
          { message: "ready under assignment contention" },
          undefined,
          undefined,
          leadCtx,
        )
        .then((value: unknown) => {
          leadToolResult = value;
        })
        .catch((error: unknown) => {
          leadToolError = error;
        });
      await leadLockHeld;
      lockPhase = "manager-bind";
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      process.env.HERDR_PANE_ID = "root-pane";
      process.env.HERDR_TAB_ID = "root-tab";
    } else if (
      lockOrder &&
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "start"
    ) {
      lockPhase = "manager-bind";
    }
    return result;
  };
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: managerExec,
    persistMessages: true,
  });
  const managerLockHooks = {
    afterOccupied: async (lockedRepo: string) => {
      if (lockedRepo === repoKey && lockOrder === "lead-first")
        signalManagerWait();
    },
    afterAcquired: async (lockedRepo: string, branch: string) => {
      if (
        lockedRepo !== repoKey ||
        !lockOrder ||
        !listProjectAssignments(supervisionRuntime(), repoKey).some(
          (assignment) => assignment.branch === branch,
        )
      )
        return;
      if (lockOrder === "manager-first" && lockPhase === "manager-bind") {
        lockPhase = "manager-held";
        managerLockClaim = readLiveProcessLock(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, branch)}.lock`,
        );
        lockedAssignmentSnapshot = readProjectAssignment(
          supervisionRuntime(),
          repoKey,
          branch,
        );
        try {
          await initializeLeadRuntime();
          const messageTool = lead.tools.find(
            (tool: any) => tool.name === "message_supervisor",
          )!;
          leadPublication = messageTool
            .execute(
              "contention-ready",
              { message: "ready under assignment contention" },
              undefined,
              undefined,
              leadCtx,
            )
            .then((value: unknown) => {
              leadToolResult = value;
            })
            .catch((error: unknown) => {
              leadToolError = error;
            });
          await leadWaitStarted;
        } finally {
          process.env.HERDR_WORKSPACE_ID = WORKSPACE;
          process.env.HERDR_PANE_ID = "root-pane";
          process.env.HERDR_TAB_ID = "root-tab";
        }
        return;
      }
    },
  };
  if (lockOrder) registerExtensionForTest(pi.pi as never, managerLockHooks);
  else registerExtension!(pi.pi as never);
  initializeLeadRuntime = async () => {
    process.env.HERDR_WORKSPACE_ID = childWorkspace;
    process.env.HERDR_PANE_ID = "child-pane";
    process.env.HERDR_TAB_ID = "child-tab";
    managerUsesRootPane = true;
    if (lead) return;
    lifecycleServer = createServer((socket) => {
      lifecycleClients.add(socket);
      socket.once("close", () => {
        lifecycleClients.delete(socket);
        subscribedLifecycleClients.delete(socket);
      });
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        lifecycleSubscriptions++;
        subscribedLifecycleClients.add(socket);
        socket.write(
          `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      lifecycleServer!.once("error", reject);
      lifecycleServer!.listen(process.env.HERDR_SOCKET_PATH!, resolve);
    });
    lead = fakeChiefPi({
      activeTools: ["read"],
      exec,
      sessionName: "Existing session name",
      entries: [{ type: "session_info", name: "Existing session name" }],
    });
    const leadLockHooks = {
      afterOccupied: async (lockedRepo: string) => {
        if (lockOrder === "manager-first" && lockedRepo === repoKey)
          signalLeadWait();
      },
      afterAcquired: async (lockedRepo: string, branch: string) => {
        if (
          lockOrder !== "lead-first" ||
          lockPhase !== "lead-publish" ||
          lockedRepo !== repoKey ||
          !listProjectAssignments(supervisionRuntime(), repoKey).some(
            (assignment) => assignment.branch === branch,
          )
        )
          return;
        leadLockClaim = readLiveProcessLock(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, branch)}.lock`,
        );
        lockedAssignmentSnapshot = readProjectAssignment(
          supervisionRuntime(),
          repoKey,
          branch,
        );
        signalLeadLock();
        await leadLockRelease;
      },
    };
    if (lockOrder) registerExtensionForTest(lead.pi as never, leadLockHooks);
    else registerExtension!(lead.pi as never);
    leadCtx = fakeContext(lead.entries) as any;
    leadCtx.hasUI = true;
    leadCtx.sessionManager.getSessionId = () => childSession;
    leadCtx.sessionManager.getSessionFile = childSessionPath;
    if (lockOrder && !leadStarted) {
      await lead.events.get("session_start")![0](undefined, leadCtx);
      leadStarted = true;
    }
  };
  try {
    const ctx = fakeContext(pi.entries) as any;
    ctx.isProjectTrusted = () => projectTrusted;
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const staff = pi.tools.find((tool) => tool.name === "delegate_work")!;
    assert.equal(
      Value.Check(staff.parameters, {
        task: "Do it",
        unexpected: childSession,
      }),
      false,
    );
    let outcome: any;
    let delegationError: unknown;
    const delegate = staff.execute(
      "delegate",
      { task: "Implement focused change" },
      undefined,
      undefined,
      ctx,
    );
    if (lockOrder === "lead-first") {
      const settled = delegate.then(
        (value: unknown) => {
          outcome = value;
        },
        (error: unknown) => {
          delegationError = error;
        },
      );
      await managerWaitStarted;
      releaseLeadLock();
      await settled;
    } else {
      try {
        outcome = await delegate;
      } catch (error) {
        delegationError = error;
      }
    }
    if (lockOrder === "lead-first") {
      assert.equal(delegationError, undefined);
      assert.equal(outcome.details.ok, true);
      await leadPublication;
      const assignment = listProjectAssignments(supervisionRuntime(), repoKey);
      assert.equal(assignment.length, 1);
      const boundAssignment = readProjectAssignment(
        supervisionRuntime(),
        repoKey,
        assignment[0]!.branch,
      );
      const { piSessionFile: _piSessionFile, ...assignmentIdentity } =
        boundAssignment!;
      assert.deepEqual(
        assignmentIdentity,
        lockedAssignmentSnapshot,
        "Manager preserves assignment identity while binding the session",
      );
      assert.equal(assignment[0]!.id, childSession);
      assert.equal(
        assignment[0]!.piSessionFile,
        realFs.realpathSync(childSessionPath()),
      );
      const assignmentNotifications = listCoordinationMessagePaths(
        supervisionRuntime(),
        childSession,
      )
        .map((path) => readChiefMessage(path))
        .filter((message) => message.kind === "project_assignment");
      assert.equal(assignmentNotifications.length, 1);
      for (const notification of assignmentNotifications) {
        assert.equal(notification.id, childSession);
        assert.equal(notification.branch, assignment[0]!.branch);
        assert.equal(notification.text, "Project assignment ready.");
      }
      assert.equal(leadLockClaim?.pid, process.pid);
      assert.ok(leadLockClaim?.id);
      assert.equal(leadToolError, undefined);
      assert.match(
        JSON.stringify(leadToolResult),
        /Project message saved for Manager/,
      );
      assert.equal(created, true);
      assert.equal(
        pi.calls.filter(
          (args) => args[0] === "worktree" && args[1] === "create",
        ).length,
        1,
      );
      const messages = listProjectMessages(
        supervisionRuntime(),
        repoKey,
        assignment[0]!.branch,
      );
      assert.ok(
        messages.length <= 1,
        "handoff is not published more than once",
      );
      if (messages.length) {
        assert.equal(messages[0]!.fromSessionId, childSession);
        assert.equal(messages[0]!.repoKey, repoKey);
        assert.equal(messages[0]!.branch, assignment[0]!.branch);
        assert.equal(messages[0]!.text, "ready under assignment contention");
      }
      assert.match(
        JSON.stringify(leadToolResult),
        /Project message saved for Manager/,
      );
      assert.equal(leadToolError, undefined);
      assert.equal(lockPhase, "manager-bind");
      removeProjectMessagesForAssignment(supervisionRuntime(), assignment[0]!);
      removeProjectAssignment(
        supervisionRuntime(),
        repoKey,
        assignment[0]!.branch,
      );
      assert.equal(
        existsSync(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, assignment[0]!.branch)}.lock`,
        ),
        false,
      );
      return;
    }
    assert.equal(delegationError, undefined);
    assert.equal(outcome.details.ok, true);
    const assignment = listProjectAssignments(supervisionRuntime(), repoKey)[0];
    assert.equal(
      listProjectAssignments(supervisionRuntime(), repoKey).length,
      1,
    );
    assert.ok(assignment);
    if (lockOrder === "manager-first") {
      await leadPublication;
      assert.equal(leadToolError, undefined);
      assert.equal(assignment.id, childSession);
      assert.ok(assignment.piSessionFile);
      assert.equal(
        assignment.piSessionFile,
        realFs.realpathSync(childSessionPath()),
      );
      assert.equal(managerLockClaim?.pid, process.pid);
      assert.ok(managerLockClaim?.id);
      const messages = listProjectMessages(
        supervisionRuntime(),
        repoKey,
        assignment.branch,
      );
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.fromSessionId, childSession);
      assert.equal(messages[0]!.text, "ready under assignment contention");
      const readyMessages = listCoordinationMessagePaths(
        supervisionRuntime(),
        childSession,
      )
        .map((path) => readChiefMessage(path))
        .filter((message) => message.kind === "project_assignment");
      assert.equal(readyMessages.length, 1);
      assert.equal(readyMessages[0]!.id, childSession);
      assert.equal(readyMessages[0]!.branch, assignment.branch);
      assert.equal(created, true);
      assert.equal(
        pi.calls.filter(
          (args) => args[0] === "worktree" && args[1] === "create",
        ).length,
        1,
      );
      assert.equal(
        existsSync(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, assignment.branch)}.lock`,
        ),
        false,
      );
      removeProjectAssignment(supervisionRuntime(), repoKey, assignment.branch);
      for (const path of listCoordinationMessagePaths(
        supervisionRuntime(),
        childSession,
      )) {
        const message = readChiefMessage(path);
        removeChiefMessage(supervisionRuntime(), childSession, message.id);
      }
      return;
    }
    assert.equal(assignment.text.match(/Implement focused change/g)?.length, 1);
    const brief = assignment.requiredEvidence?.find(
      (entry) => entry.name === "project-brief.md",
    );
    assert.ok(brief && "path" in brief);
    assert.equal(
      readRequiredEvidenceSnapshot(assignment.id, brief),
      "Implement focused change",
    );
    const reviewFile = join(tmpdir(), `manager-review-${randomUUID()}.md`);
    t.after(() => rmSync(reviewFile, { force: true }));
    realFs.writeFileSync(reviewFile, "external review finding");
    const staffMessage = pi.tools.find(
      (tool) => tool.name === "message_staff",
    )!;
    let changedSource = false;
    mutateRetainedSource = () => {
      if (changedSource) return;
      const current = listProjectAssignments(
        supervisionRuntime(),
        repoKey,
      ).find((item) => item.branch === assignment.branch);
      if (
        current?.requiredEvidence?.some(
          (entry) => entry.name === basename(reviewFile),
        )
      ) {
        changedSource = true;
        realFs.writeFileSync(reviewFile, "changed review bytes");
      }
    };
    const retainedOutcome = await staffMessage.execute(
      "retain-review",
      {
        session: childSession,
        message: "Address the external review",
        files: [reviewFile],
        retain: true,
      },
      undefined,
      undefined,
      ctx,
    );
    mutateRetainedSource = undefined;
    assert.equal(
      retainedOutcome.details.ok,
      true,
      JSON.stringify(retainedOutcome.details),
    );
    assert.equal(
      changedSource,
      true,
      "source must change after retention and before delivery completes",
    );
    const reviewMessages = listCoordinationMessagePaths(
      supervisionRuntime(),
      childSession,
    )
      .map((path) => readChiefMessage(path))
      .filter((message) =>
        message.text.includes("Address the external review"),
      );
    assert.equal(reviewMessages.length, 1);
    assert.match(reviewMessages[0].text, /external review finding/);
    assert.doesNotMatch(reviewMessages[0].text, /changed review bytes/);
    const retained = listProjectAssignments(supervisionRuntime(), repoKey).find(
      (item) => item.branch === assignment.branch,
    )!;
    assert.equal(retained.requiredEvidence?.[2].name, "assignment-note.md");
    assert.deepEqual(
      retained.currentEvidenceIds?.map(
        (id) =>
          retained.requiredEvidence?.find((entry) => entry.id === id)?.name,
      ),
      ["assignment-note.md", basename(reviewFile)],
    );
    assert.deepEqual(
      retained.requiredEvidence?.map((entry) =>
        readRequiredEvidenceSnapshot(retained.id, entry),
      ),
      [
        "Implement focused change",
        "external review finding",
        "Address the external review",
      ],
    );
    assert.ok(
      retained.requiredEvidence?.some(
        (entry) => entry.name === "project-brief.md",
      ),
    );
    assert.ok(
      !retained.requiredEvidence?.some(
        (entry) => entry.name === "project-brief.txt",
      ),
    );
    realFs.rmSync(reviewFile, { force: true });
    const staffListTool = pi.tools.find((tool) => tool.name === "list_staff")!;
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
        path: repoKey,
        linked: false,
      },
      {
        workspace: childWorkspace,
        branch: assignment!.branch,
        path: realFs.realpathSync(childCwd),
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
    const managerCommand = pi.commandOptions.get("manager")!;
    assert.deepEqual(managerCommand.getArgumentCompletions(""), [
      { value: "leave", label: "leave" },
      { value: "remove", label: "remove" },
      { value: "forget", label: "forget" },
      { value: "remove-preapproval", label: "remove-preapproval" },
    ]);
    assert.deepEqual(managerCommand.getArgumentCompletions("rem"), [
      { value: "remove", label: "remove" },
      { value: "remove-preapproval", label: "remove-preapproval" },
    ]);
    assert.deepEqual(
      managerCommand.getArgumentCompletions("remove-preapproval o"),
      [
        { value: "remove-preapproval on", label: "on" },
        { value: "remove-preapproval off", label: "off" },
      ],
    );
    assert.deepEqual(managerCommand.getArgumentCompletions("remove herds"), [
      { value: `remove ${assignment.branch}`, label: assignment.branch },
    ]);
    assert.deepEqual(managerCommand.getArgumentCompletions("forget herds"), [
      { value: `forget ${assignment.branch}`, label: assignment.branch },
    ]);
    assert.deepEqual(managerCommand.getArgumentCompletions("forget "), [
      { value: `forget ${assignment.branch}`, label: assignment.branch },
    ]);
    assert.deepEqual(managerCommand.getArgumentCompletions("remove"), []);
    assert.deepEqual(managerCommand.getArgumentCompletions("remove "), [
      { value: `remove ${assignment.branch}`, label: assignment.branch },
    ]);
    let confirmationPrompts = 0;
    ctx.hasUI = true;
    ctx.ui.input = async () => {
      confirmationPrompts++;
      return "cancel";
    };
    const removeTool = pi.tools.find(
      (tool) => tool.name === "remove_worktree",
    )!;
    gitStatusOutput = "?? dirty-file\n";
    await assert.rejects(
      removeTool.execute(
        "remove-dirty",
        { branch: assignment.branch },
        undefined,
        undefined,
        ctx,
      ),
      /dirty or could not be verified/,
    );
    assert.equal(confirmationPrompts, 0);
    gitStatusOutput = "";
    const requestedTool = await removeTool.execute(
      "remove",
      { branch: assignment.branch },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(requestedTool.details.ok, false);
    assert.equal(requestedTool.details.action, "remove");
    assert.equal(requestedTool.details.branch, assignment.branch);
    assert.equal(requestedTool.details.confirmation_required, true);
    assert.equal(requestedTool.details.pending, true);
    assert.match(requestedTool.details.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(confirmationPrompts, 0);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "stop"),
      false,
    );
    assert.ok(
      readProjectAssignment(supervisionRuntime(), repoKey, assignment.branch),
    );
    const afterRequest = await pi.tools
      .find((tool) => tool.name === "list_staff")!
      .execute("after-removal-request", {}, undefined, undefined, ctx);
    assert.equal(afterRequest.details.ok, true);
    await managerCommand.handler(`remove ${assignment.branch}`, ctx);
    assert.equal(confirmationPrompts, 1);
    assert.equal(
      pi.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
      false,
      "the model request and human cancellation have no destructive effect",
    );
    assert.match(assignment!.branch, /^herdsman\/work-[0-9a-f]{8}$/);
    assert.equal(assignment!.branch.includes(assignment!.id), false);
    assert.equal(
      assignment!.piSessionFile,
      realFs.realpathSync(childSessionPath()),
    );
    const assignmentBytes = readFileSync(
      projectAssignmentPath(supervisionRuntime(), repoKey, assignment.branch),
      "utf8",
    );
    assert.deepEqual(Object.keys(JSON.parse(assignmentBytes)).sort(), [
      "branch",
      "checkoutPath",
      "currentEvidenceIds",
      "id",
      "piSessionFile",
      "repoKey",
      "requiredEvidence",
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
    assert.equal(paths.length, 2);
    const assignmentFile = projectAssignmentPath(
      supervisionRuntime(),
      repoKey,
      assignment!.branch,
    );
    const assignmentDeliveryPath = paths.find(
      (path) => readChiefMessage(path).kind === "project_assignment",
    )!;
    const deliverySnapshot = readFileSync(assignmentDeliveryPath);
    const delivery = readChiefMessage(assignmentDeliveryPath);
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
    const managerIsIdle = ctx.isIdle;
    // Keep the Manager's lifecycle subscription for retirement coverage, but
    // prevent it from draining the retained-message assertion below.
    ctx.isIdle = () => false;
    await initializeLeadRuntime();
    const waitForStage = async (stage: string, assertion: () => void) => {
      try {
        await t.waitFor(assertion);
      } catch (error) {
        console.error(
          `[managerDelegateAssignmentTest:${projectTrusted ? "trusted" : "untrusted"}] failed: ${JSON.stringify(
            {
              stage,
              tabCommands,
              tabLabels: Object.fromEntries(tabLabels),
              failedScopeCalls: lead.callResults
                .filter(
                  ({
                    args,
                    succeeded,
                  }: {
                    args: string[];
                    succeeded: boolean;
                  }) =>
                    args[0] === "worktree" && args[1] === "list" && !succeeded,
                )
                .map(({ args }: { args: string[] }) => args),
              lifecycleSubscriptions,
            },
          )}`,
        );
        throw error;
      }
    };
    try {
      // Keep assignment delivery unavailable until after startup while the
      // persisted assignment establishes immutable Managed Lead identity.
      unlinkSync(assignmentDeliveryPath);
      if (!leadStarted) {
        await lead.events.get("session_start")![0](undefined, leadCtx);
        leadStarted = true;
      }
      await waitForStage("initial Managed Lead tab rename", () =>
        assert.ok(
          tabCommands.some(
            (args) =>
              args[0] === "tab" &&
              args[1] === "rename" &&
              args[2] === "child-tab" &&
              args[3] === "Managed Lead",
          ),
        ),
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      assert.equal(lead.pi.getSessionName(), "Existing session name");

      writeFileSync(assignmentDeliveryPath, deliverySnapshot);
      await waitForStage("assignment delivery", () =>
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
        /Herdsman automatically hands every completed\s+direct-work response to the Manager role while this assignment remains active\./,
      );
      assert.match(
        assignmentDelivery.content!,
        /Use message_supervisor when the Manager needs timely coordination[\s\S]*or when relevant files require\s+explicit transfer\./,
      );
      assert.match(
        assignmentDelivery.content!,
        /Report completion and review readiness in your normal response\.[\s\S]*Do not send a separate completion\s+announcement through message_supervisor\./,
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      assert.equal(
        tabCommands.some(
          (args) =>
            args[0] === "tab" && args[1] === "rename" && args[3] === "Lead",
        ),
        false,
        "assignment delivery must not promote an ordinary Lead session",
      );
      assert.equal(lead.pi.getSessionName(), "Existing session name");
      tabCommands.length = 0;
      holdChildPaneGet = true;
      const heldManagedRefresh = lead.events.get("session_tree")![0](
        undefined,
        leadCtx,
      );
      await waitForStage("held pane lookup started", () =>
        assert.equal(childPaneGetDidStart, true),
      );
      await heldManagedRefresh;
      failScopeLookup = true;
      const ambiguousReconciliation = lead.events.get("session_tree")![0](
        undefined,
        leadCtx,
      );
      await waitForStage("failed scope lookup recorded", () =>
        assert.ok(
          lead.callResults.some(
            ({ args, succeeded }) =>
              args[0] === "worktree" && args[1] === "list" && !succeeded,
          ),
        ),
      );
      releaseChildPaneGet();
      await ambiguousReconciliation;
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      leadCtx.mode = "rpc";
      let lifecyclePresentation: string[] = [];
      leadCtx.ui.select = async (title: string, items: string[]) => {
        if (title.startsWith("Pi Herdsman")) lifecyclePresentation = items;
        return undefined;
      };
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.ok(
        lifecyclePresentation.some((item) =>
          /^Execution\s+managed · unavailable$/u.test(item),
        ),
        "ambiguous worktree evidence keeps the permanent Managed identity unavailable",
      );
      const childTabCommands = tabCommands.filter(
        (args) =>
          (args[0] === "pane" &&
            args[1] === "get" &&
            args[2] === "child-pane") ||
          (args[0] === "tab" &&
            args[1] === "list" &&
            args[3] === childWorkspace) ||
          (args[0] === "tab" &&
            args[1] === "rename" &&
            args[2] === "child-tab"),
      );
      assert.ok(
        childTabCommands.every(
          (args) => args[0] !== "tab" || args[1] !== "rename",
        ),
      );
      failScopeLookup = false;
      await lead.events.get("session_tree")![0](undefined, leadCtx);
      await waitForStage("managed label restored after scope recovery", () =>
        assert.equal(tabLabels.get("child-tab"), "Managed Lead"),
      );
      const message = await lead.tools
        .find((tool) => tool.name === "message_supervisor")!
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
        repoKey,
        assignment!.branch,
      );
      assert.equal(retained.length, 1);
      assert.equal(retained[0]!.fromSessionId, childSession);
      assert.equal(retained[0]!.text, "Ready for review");
      ctx.isIdle = managerIsIdle;
      assert.equal(
        listProjectAssignments(supervisionRuntime(), repoKey)[0]?.id,
        childSession,
      );
      const publishRetirement = () => {
        const event = `${JSON.stringify({
          event: "worktree_removed",
          data: {
            type: "worktree_removed",
            workspace_id: childWorkspace,
            workspace: {
              workspace_id: childWorkspace,
              worktree: {
                repo_key: repoKey,
                checkout_path: childCwd,
                is_linked_worktree: true,
              },
            },
            worktree: {
              path: childCwd,
              branch: assignment!.branch,
              is_linked_worktree: true,
            },
            forced: false,
          },
        })}\n`;
        for (const client of subscribedLifecycleClients)
          if (!client.destroyed) client.write(event);
      };
      await waitForStage("lifecycle subscriptions ready", () =>
        assert.ok(subscribedLifecycleClients.size >= 2),
      );
      failScopeLookup = true;
      publishRetirement();
      await waitForStage("first retirement processed", () =>
        assert.ok(
          lead.entries.some((entry: any) =>
            String(entry.data?.error).includes("scope lookup failure"),
          ) || !listProjectAssignments(supervisionRuntime(), repoKey).length,
          JSON.stringify(lead.entries),
        ),
      );
      assert.equal(
        listProjectAssignments(supervisionRuntime(), repoKey).length,
        1,
      );
      const lookupNotices: string[] = [];
      leadCtx.ui.notify = (message: string) => lookupNotices.push(message);
      await lead.commandOptions.get("lead").handler("orchestrate", leadCtx);
      assert.ok(
        lookupNotices.some(
          (message) =>
            message.includes("Dedicated") || message.includes("Managed Leads"),
        ),
      );
      assert.deepEqual(lead.pi.getActiveTools(), [
        "read",
        ...leadTools,
        "read_evidence",
      ]);
      unavailableScope = true;
      const unavailableNotices: string[] = [];
      leadCtx.ui.notify = (message: string) => unavailableNotices.push(message);
      await lead.commandOptions.get("lead").handler("flexible", leadCtx);
      assert.ok(
        unavailableNotices.some((message) => message.includes("Managed Leads")),
      );
      assert.deepEqual(lead.pi.getActiveTools(), [
        "read",
        ...leadTools,
        "read_evidence",
      ]);
      unavailableScope = false;
      leadCtx.mode = "rpc";
      let managedPresentation: string[] = [];
      leadCtx.ui.select = async (title: string, items: string[]) => {
        if (title.startsWith("Pi Herdsman")) managedPresentation = items;
        return undefined;
      };
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.ok(
        managedPresentation.some((item) => /^Execution\s+managed$/u.test(item)),
      );

      failScopeLookup = false;
      const requestsBeforeRemoval = topologyRequests;
      tabCommands.length = 0;
      publishRetirement();
      await waitForStage("retirement topology refresh", () =>
        assert.ok(topologyRequests > requestsBeforeRemoval),
      );
      assert.equal(
        listProjectAssignments(supervisionRuntime(), repoKey).length,
        1,
      );
      assert.equal(
        tabCommands.some(
          (args) =>
            args[0] === "tab" &&
            args[1] === "rename" &&
            args[2] === "child-tab" &&
            args[3] === "Managed Lead",
        ),
        false,
        "retained checkout keeps both the assignment and Managed Lead tab label",
      );
      assert.deepEqual(lead.pi.getActiveTools(), [
        "read",
        ...leadTools,
        "read_evidence",
      ]);
      await lead.commandOptions.get("lead").handler("orchestrate", leadCtx);
      assert.deepEqual(lead.pi.getActiveTools(), [
        "read",
        ...leadTools,
        "read_evidence",
      ]);
      managedPresentation = [];
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.ok(
        managedPresentation.some((item) => /^Execution\s+managed$/u.test(item)),
      );

      reportCheckoutAbsent = true;
      rmSync(childCwd, { recursive: true, force: true });
      tabCommands.length = 0;
      // The Manager and Lead contexts share process.env in this test harness.
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      publishRetirement();
      await waitForStage("removed assignment", () =>
        assert.equal(
          listProjectAssignments(supervisionRuntime(), repoKey).length,
          0,
        ),
      );
      await lead.events.get("session_tree")![0](undefined, leadCtx);
      lifecyclePresentation = [];
      leadCtx.ui.select = async (title: string, items: string[]) => {
        if (title.startsWith("Pi Herdsman")) lifecyclePresentation = items;
        return undefined;
      };
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.ok(
        lifecyclePresentation.some((item) =>
          /^Execution\s+managed · retired$/u.test(item),
        ),
        `committed retirement, Herdr branch absence, and Git worktree absence establish Retired: ${JSON.stringify(lifecyclePresentation)}; records=${JSON.stringify(listPendingRetirements(supervisionRuntime(), repoKey))}`,
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      assert.equal(lead.pi.getActiveTools().includes("delegate_agent"), false);
      assert.equal(lead.pi.getActiveTools().includes("continue_agent"), false);
      const retiredLeadNotices: string[] = [];
      leadCtx.ui.notify = (message: string) => retiredLeadNotices.push(message);
      await lead.commandOptions.get("lead").handler("orchestrate", leadCtx);
      assert.ok(
        retiredLeadNotices.some((message) => message.includes("Managed Leads")),
        "retired Managed Lead cannot fall back to ordinary execution",
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      await pi.commandOptions.get("manager").handler("leave", ctx);
      assert.equal(
        readManagerDescriptor(supervisionRuntime(), WORKSPACE),
        undefined,
      );
      assert.equal(
        listProjectAssignments(supervisionRuntime(), repoKey).length,
        0,
      );
      const retirement = listPendingRetirements(
        supervisionRuntime(),
        repoKey,
      ).find(
        (record) =>
          record.id === childSession && record.branch === assignment!.branch,
      );
      assert.ok(
        retirement,
        "the exact committed retirement record remains authoritative",
      );
      assert.equal(retirement.repoKey, assignment!.repoKey);
      process.env.HERDR_WORKSPACE_ID = childWorkspace;
      await lead.events.get("session_shutdown")?.[0]();
    } finally {
      await lead.events.get("session_shutdown")?.[0]();
    }
  } finally {
    releaseLeadLock();
    if (leadPublication) await leadPublication;
    if (lockOrder) await lead?.events.get("session_shutdown")?.[0]();
    if (!manager1Shutdown) await pi.events.get("session_shutdown")?.[0]();
    for (const client of lifecycleClients) client.destroy();
    if (lifecycleServer?.listening)
      await new Promise<void>((resolve) =>
        lifecycleServer!.close(() => resolve()),
      );
    if (process.platform !== "win32") {
      try {
        realFs.unlinkSync(lifecycleSocketPath!);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
}

for (const projectTrusted of [true, false])
  test(`Manager delegate persists an exact worktree Lead assignment (${projectTrusted ? "trusted" : "untrusted"})`, (t) =>
    managerDelegateAssignmentTest(t, projectTrusted));

test("Manager session binding holds the assignment lock before Lead publication", (t) =>
  managerDelegateAssignmentTest(t, false, "manager-first"));

test("Lead publication holds the assignment lock before Manager session binding", (t) =>
  managerDelegateAssignmentTest(t, false, "lead-first"));

test("Manager supervises project Leads while Chief keeps only unclaimed Leads in scope", async () => {
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
    cwd: "/tmp",
  };
  const incompatibleManagerSession = randomUUID();
  const incompatibleWorkspace = `workspace-${randomUUID()}`;
  const incompatibleManager = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: incompatibleManagerSession,
    },
    workspace_id: incompatibleWorkspace,
    pane_id: "incompatible-manager-pane",
    tab_id: "incompatible-manager-tab",
  };
  const incompatibleManagerLease = claimManagerLease({
    build: OTHER_HERDSMAN_BUILD,
    piSessionId: incompatibleManagerSession,
    paneId: incompatibleManager.pane_id,
    tabId: incompatibleManager.tab_id,
    workspaceId: incompatibleWorkspace,
    repoKey: "/var",
  });
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    build: OTHER_HERDSMAN_BUILD,
    role: "manager",
    instanceId: randomUUID(),
    piSessionId: incompatibleManagerSession,
    updatedAt: Date.now(),
  });
  const nestedLeadSession = randomUUID();
  const nestedLead = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: nestedLeadSession,
    },
    workspace_id: incompatibleWorkspace,
    pane_id: "nested-incompatible-manager-lead-pane",
    tab_id: "nested-incompatible-manager-lead-tab",
  };
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: nestedLeadSession,
    updatedAt: Date.now(),
  });
  const incompatibleChildSession = randomUUID();
  const incompatibleChild = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: incompatibleChildSession,
    },
    workspace_id: WORKSPACE,
    pane_id: "incompatible-compatible-manager-child-pane",
    tab_id: "incompatible-compatible-manager-child-tab",
  };
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    build: OTHER_HERDSMAN_BUILD,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: incompatibleChildSession,
    updatedAt: Date.now(),
  });
  const assignedLeadSession = randomUUID();
  const assignedWorkspace = `workspace-${randomUUID()}`;
  const assignedLead = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: assignedLeadSession,
    },
    workspace_id: assignedWorkspace,
    pane_id: "assigned-pane",
    tab_id: "assigned-tab",
    cwd: "/tmp",
  };
  const ordinaryLeadSession = randomUUID();
  const ordinaryWorkspace = `workspace-${randomUUID()}`;
  const ordinarySessionPath = join(
    PI_AGENT_ROOT,
    `manager-supervised-${randomUUID()}.jsonl`,
  );
  realFs.writeFileSync(
    ordinarySessionPath,
    [
      {
        type: "session",
        version: 3,
        id: ordinaryLeadSession,
        timestamp: new Date().toISOString(),
        cwd: "/tmp",
      },
      {
        type: "message",
        id: "ordinary-user",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "ordinary transcript content" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8",
  );
  nativeSessions.set(ordinarySessionPath, {
    id: ordinaryLeadSession,
    path: ordinarySessionPath,
    cwd: "/tmp",
    entries: [],
  });
  const ordinaryLead = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: ordinarySessionPath,
    },
    workspace_id: ordinaryWorkspace,
    pane_id: "ordinary-pane",
    tab_id: "ordinary-tab",
    cwd: "/tmp",
    tokens: { pi_herdsman_role: "lead" },
  };
  const { herdrSessionId, readPiSessionHeaderId } = await import("./herdr.ts");
  assert.equal(
    JSON.parse(realFs.readFileSync(ordinarySessionPath, "utf8").split("\n")[0])
      .id,
    ordinaryLeadSession,
  );
  assert.equal(readPiSessionHeaderId(ordinarySessionPath), ordinaryLeadSession);
  assert.equal(herdrSessionId(ordinaryLead), ordinaryLeadSession);
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: assignedLeadSession,
    updatedAt: Date.now(),
  });
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: ordinaryLeadSession,
    updatedAt: Date.now(),
  });
  writeProjectAssignment(supervisionRuntime(), {
    version: 2,
    id: assignedLeadSession,
    repoKey: "/tmp",
    branch: "assigned-branch",
    text: "assigned work",
  });
  const liveAgents = [managerAgent, assignedLead, ordinaryLead];
  const manyCompatibleLeads = Array.from({ length: 33 }, (_, index) => {
    const session = randomUUID();
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      role: "lead",
      instanceId: randomUUID(),
      piSessionId: session,
      updatedAt: Date.now(),
    });
    return {
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: session,
      },
      workspace_id: WORKSPACE,
      pane_id: `many-compatible-${index}`,
      tab_id: `many-compatible-${index}`,
    };
  });
  let revokeOrdinaryDuringRead = false;
  let delayOrdinaryRead = false;
  let finishDelayedRead: (() => void) | undefined;
  const focusCalls: string[] = [];
  const exec = (command: string, args: string[]) => {
    if (command === "herdr" && args[0] === "agent" && args[1] === "focus")
      focusCalls.push(args[2]!);
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace:
          args[2] === WORKSPACE
            ? { worktree: { repo_key: "/tmp", is_linked_worktree: false } }
            : args[2] === incompatibleWorkspace
              ? {
                  worktree: { repo_key: "/var", is_linked_worktree: false },
                }
              : args[2] === assignedWorkspace || args[2] === ordinaryWorkspace
                ? { worktree: null }
                : {},
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
      return respond({
        source: {
          source_workspace_id:
            args.includes("--workspace") &&
            args[args.indexOf("--workspace") + 1] === incompatibleWorkspace
              ? incompatibleWorkspace
              : WORKSPACE,
          repo_key:
            args.includes("--workspace") &&
            args[args.indexOf("--workspace") + 1] === incompatibleWorkspace
              ? "/var"
              : "/tmp",
          repo_name: "project",
        },
        worktrees: [
          { open_workspace_id: assignedWorkspace },
          { open_workspace_id: ordinaryWorkspace },
        ],
      });
    if (command === "herdr" && isAgentList(args))
      return respond({ agents: liveAgents });
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({
        agent:
          [incompatibleManager, nestedLead, assignedLead, ordinaryLead].find(
            (agent) => agent.pane_id === args[2],
          ) ?? managerAgent,
      });
    if (command === "herdr" && args[0] === "agent" && args[1] === "read") {
      if (delayOrdinaryRead)
        return new Promise<{ stdout: string; stderr: string; code: number }>(
          (resolve) => {
            finishDelayedRead = () =>
              resolve({ stdout: "stale ordinary output", stderr: "", code: 0 });
          },
        );
      if (revokeOrdinaryDuringRead)
        liveAgents.splice(liveAgents.indexOf(ordinaryLead), 1);
      return { stdout: "bounded ordinary live output", stderr: "", code: 0 };
    }
    if (command === "herdr" && isApiSnapshot(args))
      return respond({
        snapshot: { agents: liveAgents, panes: [], workspaces: [] },
      });
    return respond({});
  };
  let overview: any;
  const manager = fakeRepositoryChiefPi({ activeTools: ["read"], exec });
  const managerCtx = fakeContext() as any;
  managerCtx.hasUI = true;
  managerCtx.ui.custom = async (factory: any) => {
    overview = factory(
      { requestRender: () => undefined },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      {},
      () => undefined,
    );
  };
  registerExtension!(manager.pi as never);
  try {
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    await manager.events.get("session_start")![0](undefined, managerCtx);
    await manager.commandOptions.get("manager").handler("", managerCtx);
    const managerStaff = manager.tools.find(
      (tool) => tool.name === "list_staff",
    )!;
    const managerListing = await managerStaff.execute(
      "list",
      {},
      undefined,
      undefined,
      managerCtx,
    );
    assert.deepEqual(
      managerListing.details.reports
        .map((report: any) => report.session)
        .sort(),
      [assignedLeadSession, ordinaryLeadSession].sort(),
      "all eligible Leads in the verified project group are Manager reports",
    );
    const assignedReport = managerListing.details.reports.find(
      (report: any) => report.session === assignedLeadSession,
    );
    const ordinaryReport = managerListing.details.reports.find(
      (report: any) => report.session === ordinaryLeadSession,
    );
    assert.equal(assignedReport.relationship, "assigned");
    assert.deepEqual(assignedReport.available_tools, [
      "inspect_staff",
      "message_staff",
    ]);
    assert.equal(ordinaryReport.relationship, "supervised");
    assert.deepEqual(ordinaryReport.available_tools, [
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
    ]);
    const inspection = await manager.tools
      .find((tool) => tool.name === "inspect_staff")!
      .execute(
        "inspect",
        { action: "inspect", session: ordinaryLeadSession },
        undefined,
        undefined,
        managerCtx,
      );
    assert.equal(inspection.details.session, ordinaryLeadSession);
    assert.equal(
      inspection.details.identity.pi_session_id,
      ordinaryLeadSession,
    );
    assert.equal(
      inspection.details.recent_output,
      "bounded ordinary live output",
    );
    const transcript = await manager.tools
      .find((tool) => tool.name === "read_staff_transcript")!
      .execute(
        "transcript",
        { session: ordinaryLeadSession },
        undefined,
        undefined,
        managerCtx,
      );
    assert.match(JSON.stringify(transcript), /ordinary transcript content/);
    assert.equal(
      JSON.stringify(transcript).includes(
        JSON.stringify(ordinarySessionPath).slice(1, -1),
      ),
      false,
    );
    await manager.commandOptions.get("manager").handler("", managerCtx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(overview, "Manager overview opens for supervised Leads");
    overview.handleInput("\u001b[B");
    overview.handleInput(" ");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const peekLines = overview.render(120);
    assert.match(peekLines[1], /^ Peek ·/u);
    assert.equal(peekLines[2].trim(), "");
    const peekFooter = peekLines.findIndex((line: string) =>
      line.includes("Esc back · Enter focus"),
    );
    assert.equal(peekLines[peekFooter - 1].trim(), "");
    assert.match(peekLines[peekFooter], /^ Esc back/u);
    assert.match(
      overview.render(120).join("\n"),
      /bounded ordinary live output/,
    );
    overview.handleInput("\u001b");
    revokeOrdinaryDuringRead = true;
    overview.handleInput(" ");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.doesNotMatch(
      overview.render(120).join("\n"),
      /bounded ordinary live output/,
      "inspection evidence is not rendered after direct-report revocation",
    );
    liveAgents.push(ordinaryLead);
    delayOrdinaryRead = true;
    overview.handleInput("\u001b");
    overview.handleInput(" ");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(finishDelayedRead, "inspection is still pending");
    overview.handleInput("\u001b");
    finishDelayedRead!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.doesNotMatch(
      overview.render(120).join("\n"),
      /stale ordinary output/,
      "a completed inspection does not reopen a dismissed peek",
    );
    delayOrdinaryRead = false;
    nativeSessions.delete(ordinarySessionPath);
    ordinaryLead.agent_session = {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: ordinaryLeadSession,
    };
    const withoutTranscript = await managerStaff.execute(
      "list",
      {},
      undefined,
      undefined,
      managerCtx,
    );
    assert.deepEqual(
      withoutTranscript.details.reports[1].available_tools,
      ["inspect_staff", "message_staff"],
      "ordinary supervision does not advertise unavailable persisted evidence",
    );
    ordinaryLead.agent_session = {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: ordinarySessionPath,
    };
    const duplicatePath = projectAssignmentPath(
      supervisionRuntime(),
      "/tmp",
      "duplicate-assignment",
    );
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: assignedLeadSession,
      repoKey: "/tmp",
      branch: "duplicate-assignment",
      text: "ambiguous duplicate",
    });
    await assert.rejects(
      managerStaff.execute("list", {}, undefined, undefined, fakeContext()),
      /Multiple project assignments match a Lead session/,
    );
    rmSync(duplicatePath, { force: true });
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      build: OTHER_HERDSMAN_BUILD,
      role: "lead",
      instanceId: randomUUID(),
      piSessionId: assignedLeadSession,
      updatedAt: Date.now(),
    });
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      build: OTHER_HERDSMAN_BUILD,
      role: "lead",
      instanceId: randomUUID(),
      piSessionId: ordinaryLeadSession,
      updatedAt: Date.now(),
    });
    await manager.commandOptions.get("manager").handler("", managerCtx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const overviewLines = overview.render(120).join("\n");
    assert.match(overviewLines, /build mismatch · reload Pi session/);
    assert.match(
      overviewLines,
      /assigned-branch.*build mismatch · reload Pi session/,
    );
    assert.match(overviewLines, /unknown · build mismatch · reload Pi session/);
    overview.handleInput("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      focusCalls,
      [],
      "incompatible overview selection sends no focus",
    );
    overview.handleInput("\u001b[B");
    overview.handleInput("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      focusCalls,
      [],
      "incompatible standalone selection sends no focus",
    );
    overview.handleInput("\u001b");
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      role: "lead",
      instanceId: randomUUID(),
      piSessionId: assignedLeadSession,
      updatedAt: Date.now(),
    });
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      role: "lead",
      instanceId: randomUUID(),
      piSessionId: ordinaryLeadSession,
      updatedAt: Date.now(),
    });
    process.env.HERDR_WORKSPACE_ID = "chief-workspace";
    process.env.HERDR_PANE_ID = "chief-pane";
    process.env.HERDR_TAB_ID = "chief-tab";
    const chief = fakeRepositoryChiefPi({ activeTools: ["read"], exec });
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
      assert.match(
        chiefPrompt?.systemPrompt ?? "",
        /When eligible same-role direct reports need technical coordination,[\s\S]*communicate directly rather than relaying their messages/,
      );
      const contextMessage = chief.sentMessageCalls.findLast(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-supervision-context",
      );
      assert.ok(
        JSON.stringify(contextMessage?.message).includes(ordinaryLeadSession),
        JSON.stringify(contextMessage?.message),
      );
      liveAgents.push(
        ...manyCompatibleLeads,
        incompatibleManager,
        nestedLead,
        incompatibleChild,
      );
      const staff = chief.tools.find((tool) => tool.name === "list_staff")!;
      const listed = await staff.execute(
        "list",
        {},
        undefined,
        undefined,
        chiefCtx,
      );
      assert.equal(
        listed.details.ok,
        true,
        "the partial observation is a successful fresh list result",
      );
      assert.equal(listed.details.self.role, "chief");
      assert.equal(listed.details.reports.length, 2);
      assert.equal(listed.details.reports[0].role, "manager");
      assert.equal(listed.details.reports[0].session, LEAD_SESSION_ID);
      assert.ok(
        listed.details.reports[0].available_tools.includes("inspect_staff"),
      );
      assert.ok(
        listed.details.reports[0].available_tools.includes("message_staff"),
      );
      const nestedSessions = listed.details.reports[0].leads.map(
        (lead: any) => lead.session,
      );
      assert.equal(nestedSessions.length, 36);
      assert.ok(nestedSessions.includes(incompatibleChildSession));
      const nestedIncompatible = listed.details.reports[0].leads.find(
        (lead: any) => lead.session === incompatibleChildSession,
      );
      assert.equal(nestedIncompatible.compatibility, "incompatible");
      assert.deepEqual(nestedIncompatible.available_tools, []);
      assert.equal("agentCounts" in nestedIncompatible, false);
      assert.deepEqual(listed.details.reports[0].lead_counts, {
        active: 0,
        blocked: 0,
        total: 35,
      });
      const incompatibleEntry = listed.details.reports.find(
        (report: any) => report.session === incompatibleManagerSession,
      );
      assert.equal(incompatibleEntry.compatibility, "incompatible");
      assert.equal(incompatibleEntry.build.sha256, OTHER_HERDSMAN_BUILD.sha256);
      assert.deepEqual(incompatibleEntry.available_tools, []);
      assert.equal(
        listed.details.reports.some(
          (report: any) => report.session === nestedLeadSession,
        ),
        false,
        "a Lead under an incompatible Manager is not elevated to Chief direct staff",
      );
      assert.match(listed.details.warning, /reload those Pi sessions/);
      for (const [toolName, params] of [
        [
          "inspect_staff",
          { action: "inspect", session: incompatibleManagerSession },
        ],
        [
          "message_staff",
          { session: incompatibleManagerSession, message: "unauthorized" },
        ],
        ["read_staff_transcript", { session: incompatibleManagerSession }],
      ] as const) {
        await assert.rejects(
          chief.tools
            .find((tool) => tool.name === toolName)!
            .execute(
              toolName === "inspect_staff" ? "inspect" : "action",
              params,
              undefined,
              undefined,
              chiefCtx,
            ),
          /not found|not eligible|not a current direct report|build mismatch/iu,
        );
      }
      const descriptorPath = managerDescriptorPath(
        supervisionRuntime(),
        incompatibleWorkspace,
      );
      const converged = readManagerDescriptor(
        supervisionRuntime(),
        incompatibleWorkspace,
      )!;
      writeFileSync(
        descriptorPath,
        JSON.stringify({ ...converged, build: HERDSMAN_BUILD }),
      );
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        build: HERDSMAN_BUILD,
        role: "manager",
        instanceId: randomUUID(),
        piSessionId: incompatibleManagerSession,
        updatedAt: Date.now(),
      });
      const convergedList = await staff.execute(
        "list",
        {},
        undefined,
        undefined,
        chiefCtx,
      );
      assert.equal(
        convergedList.details.reports.some(
          (report: any) =>
            report.session === incompatibleManagerSession &&
            report.compatibility === "incompatible",
        ),
        false,
        "a fresh matching-build observation clears the warning",
      );
      const nestedOnlyList = await staff.execute(
        "list",
        {},
        undefined,
        undefined,
        chiefCtx,
      );
      assert.equal(
        nestedOnlyList.details.reports.some(
          (report: any) => report.compatibility === "incompatible",
        ),
        false,
        "the compatible Manager leaves no top-level incompatible report",
      );
      assert.match(
        nestedOnlyList.details.warning,
        /incompatible Herdsman build.*reload those Pi sessions/,
        "a nested-only mismatch still provides reload guidance",
      );
      await chief.events.get("before_agent_start")![0](
        { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
        chiefCtx,
      );
      const nestedOnlyContext = chief.sentMessageCalls.findLast(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-supervision-context",
      );
      assert.match(
        JSON.stringify(nestedOnlyContext?.message),
        /incompatible_staff_observations: 1/,
        "the model-facing aggregate includes the nested incompatible Lead",
      );
      await assert.rejects(
        chief.tools
          .find((tool) => tool.name === "message_staff")!
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
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        build: OTHER_HERDSMAN_BUILD,
        role: "manager",
        instanceId: randomUUID(),
        piSessionId: incompatibleManagerSession,
        updatedAt: Date.now(),
      });
      await assert.rejects(
        staff.execute("list", {}, undefined, undefined, chiefCtx),
        /mismatch|authority|coordination/iu,
        "conflicting descriptor and coordination builds fail closed",
      );
    } finally {
      resetAgentMailbox(agentMailboxPath(WORKSPACE, mailboxLabel));
      await chief.events.get("session_shutdown")![0]();
      rmSync(
        projectAssignmentPath(supervisionRuntime(), "/tmp", "assigned-branch"),
        { force: true },
      );
    }
  } finally {
    nativeSessions.delete(ordinarySessionPath);
    realFs.rmSync(ordinarySessionPath, { force: true });
    incompatibleManagerLease.release();
    await manager.events.get("session_shutdown")![0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("ordinary Lead uplink reaches its Manager despite incomplete workspace topology", async (t) => {
  setLeadEnvironment();
  const socketPath = join(tmpdir(), `manager-lead-inbox-${randomUUID()}.sock`);
  const repoA = realFs.mkdtempSync(
    join(tmpdir(), "manager-lead-repository-a-"),
  );
  const leadSession = randomUUID();
  const leadWorkspace = `workspace-${randomUUID()}`;
  const managerAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
    workspace_id: WORKSPACE,
    pane_id: "manager-inbox-pane",
    tab_id: "manager-inbox-tab",
    cwd: "/tmp/project-root",
  };
  const leadAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadSession,
    },
    workspace_id: leadWorkspace,
    pane_id: "ordinary-inbox-pane",
    tab_id: "ordinary-inbox-tab",
    cwd: "/tmp",
  };
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  let omitLeadFromManagerTopology = false;
  let leadWorkspaceTopologyQueries = 0;
  let repoALocalScopeQueries = 0;
  let changeLeadCwdAfterLocalScope = false;
  let leadCwdMutationQueries = 0;
  const exec = (_command: string, args: string[]) => {
    if (args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace:
          args[2] === WORKSPACE
            ? { worktree: { repo_key: "/tmp", is_linked_worktree: false } }
            : args[2] === leadWorkspace
              ? { worktree: null }
              : {},
      });
    if (args[0] === "worktree" && args[1] === "list") {
      const targetWorkspace = args.includes("--workspace")
        ? args[3]
        : undefined;
      const cwdIndex = args.indexOf("--cwd");
      const targetCwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
      const localRepositoryA = targetCwd === repoA;
      if (localRepositoryA) repoALocalScopeQueries++;
      if (targetCwd === "/tmp" && changeLeadCwdAfterLocalScope) {
        changeLeadCwdAfterLocalScope = false;
        leadCwdMutationQueries++;
        leadAgent.cwd = repoA;
      }
      const inheritedLeadTopology = targetWorkspace === leadWorkspace;
      const managerTopology =
        targetWorkspace === WORKSPACE && omitLeadFromManagerTopology;
      if (inheritedLeadTopology) leadWorkspaceTopologyQueries++;
      return respond({
        source: {
          source_workspace_id:
            inheritedLeadTopology || managerTopology
              ? "other-primary-workspace"
              : WORKSPACE,
          repo_key: localRepositoryA
            ? repoA
            : inheritedLeadTopology
              ? "/inherited/repository-a/.git"
              : "/tmp",
          repo_name:
            localRepositoryA || inheritedLeadTopology
              ? "repository-a"
              : "project-b",
          source_checkout_path: "/tmp/project-root",
        },
        worktrees: inheritedLeadTopology
          ? []
          : managerTopology
            ? [{ open_workspace_id: WORKSPACE }]
            : [{ open_workspace_id: leadWorkspace }],
      });
    }
    if (isAgentList(args))
      return respond({ agents: [managerAgent, leadAgent] });
    if (args[0] === "agent" && args[1] === "get")
      return respond({
        agent: args[2] === leadAgent.pane_id ? leadAgent : managerAgent,
      });
    if (isApiSnapshot(args))
      return respond({
        snapshot: {
          agents: [managerAgent, leadAgent],
          panes: [],
          workspaces: [],
        },
      });
    return respond({});
  };
  const managerExec = (command: string, args: string[]) => exec(command, args);
  const leadExec = (command: string, args: string[]) => exec(command, args);
  const useManagerIdentity = () => {
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    process.env.HERDR_PANE_ID = managerAgent.pane_id;
    process.env.HERDR_TAB_ID = managerAgent.tab_id;
    process.env.HERDR_SOCKET_PATH = socketPath;
  };
  const useLeadIdentity = () => {
    process.env.HERDR_WORKSPACE_ID = leadWorkspace;
    process.env.HERDR_PANE_ID = leadAgent.pane_id;
    process.env.HERDR_TAB_ID = leadAgent.tab_id;
    process.env.HERDR_SOCKET_PATH = socketPath;
  };
  let manager: ReturnType<typeof fakeChiefPi> | undefined;
  let lead: ReturnType<typeof fakeChiefPi> | undefined;
  let competingLease: ReturnType<typeof claimManagerLease> | undefined;
  try {
    useManagerIdentity();
    manager = fakeRepositoryChiefPi({
      activeTools: ["read"],
      exec: managerExec,
      persistMessages: true,
    });
    registerExtension!(manager.pi as never);
    const managerCtx = fakeContext(manager.entries) as any;
    managerCtx.isIdle = () => false;
    await manager.events.get("session_start")![0](undefined, managerCtx);
    await manager.commandOptions.get("manager").handler("", managerCtx);
    const originalManagerExec = manager.pi.exec.bind(manager.pi);
    (manager.pi as any).exec = async (
      command: string,
      args: string[],
      options: { cwd?: string } | undefined,
    ) =>
      command === "git" && args[0] === "rev-parse" && options?.cwd === repoA
        ? { stdout: repoA, stderr: "", code: 0 }
        : originalManagerExec(command, args, options);

    useLeadIdentity();
    lead = fakeRepositoryChiefPi({
      activeTools: ["read"],
      exec: leadExec,
      persistMessages: true,
    });
    registerExtension!(lead.pi as never);
    const leadCtx = fakeContext(lead.entries) as any;
    leadCtx.sessionManager.getSessionId = () => leadSession;
    let leadIsIdle = false;
    leadCtx.isIdle = () => leadIsIdle;
    await lead.events.get("session_start")![0](undefined, leadCtx);
    const { worktreeGroupScope } = await import("./herdr.ts");
    await assert.rejects(
      worktreeGroupScope(lead.pi, leadCtx, leadWorkspace),
      /Herdr project topology changed/,
      "the inherited workspace's topology points at repository A and omits this workspace",
    );

    useManagerIdentity();
    const reports = await manager.tools
      .find((tool) => tool.name === "list_staff")!
      .execute("list", {}, undefined, undefined, managerCtx);
    assert.equal(
      reports.details.reports.find(
        (report: any) => report.session === leadSession,
      )?.relationship,
      "supervised",
    );
    omitLeadFromManagerTopology = true;
    const managerScope = await worktreeGroupScope(
      manager.pi,
      managerCtx,
      WORKSPACE,
    );
    assert.equal(managerScope.workspaceIds.includes(leadWorkspace), false);
    const staleTopologyQueriesBeforeUplink = leadWorkspaceTopologyQueries;
    useLeadIdentity();
    const uplink = await lead.tools
      .find((tool) => tool.name === "message_supervisor")!
      .execute(
        "message",
        { message: "Ordinary Lead to Manager" },
        undefined,
        undefined,
        leadCtx,
      );
    assert.equal(uplink.details.chiefSessionId, LEAD_SESSION_ID);
    useManagerIdentity();
    managerCtx.isIdle = () => true;
    await t.waitFor(() =>
      assert.ok(
        manager!.sentMessageCalls.some(
          ({ message }: any) =>
            message?.customType === "pi-herdsman-lead_message" &&
            message?.details?.id === uplink.details.id &&
            message?.details?.fromSessionId === leadSession &&
            message?.details?.toSessionId === LEAD_SESSION_ID,
        ),
      ),
    );
    assert.equal(
      leadWorkspaceTopologyQueries,
      staleTopologyQueriesBeforeUplink,
      "delivery does not query the stale Lead workspace topology",
    );
    useLeadIdentity();
    await assert.rejects(
      worktreeGroupScope(lead.pi, leadCtx, leadWorkspace),
      /Herdr project topology changed/,
      "the inherited Lead workspace still reports repository A after delivery",
    );
    assert.deepEqual(
      listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID),
      [],
    );
    omitLeadFromManagerTopology = false;

    await manager.tools
      .find((tool) => tool.name === "message_staff")!
      .execute(
        "message",
        {
          session: leadSession,
          message: "Manager to ordinary Lead",
        },
        undefined,
        undefined,
        managerCtx,
      );
    useLeadIdentity();
    await t.waitFor(() =>
      assert.ok(
        lead!.sent.some(
          (message: any) =>
            message?.customType === "pi-herdsman-manager_message" &&
            message?.details?.fromSessionId === LEAD_SESSION_ID &&
            message?.details?.toSessionId === leadSession,
        ),
      ),
    );
    assert.deepEqual(
      lead.sentMessageCalls.find(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-manager_message",
      )?.options,
      { deliverAs: "steer", triggerTurn: true },
    );
    assert.deepEqual(
      listCoordinationMessagePaths(supervisionRuntime(), leadSession),
      [],
    );

    leadIsIdle = true;
    const managerMessagesBeforeIdleDelivery = lead.sentMessageCalls.filter(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-manager_message" &&
        message?.details?.toSessionId === leadSession,
    ).length;
    await manager.tools
      .find((tool) => tool.name === "message_staff")!
      .execute(
        "message",
        {
          session: leadSession,
          message: "Manager message while ordinary Lead is idle",
        },
        undefined,
        undefined,
        managerCtx,
      );
    useLeadIdentity();
    await t.waitFor(() =>
      assert.equal(
        lead.sentMessageCalls.filter(
          ({ message }: any) =>
            message?.customType === "pi-herdsman-manager_message" &&
            message?.details?.toSessionId === leadSession,
        ).length,
        managerMessagesBeforeIdleDelivery + 1,
      ),
    );
    assert.deepEqual(
      lead.sentMessageCalls.findLast(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-manager_message" &&
          message?.details?.toSessionId === leadSession,
      )?.options,
      { deliverAs: "steer", triggerTurn: true },
      "an idle ordinary Lead receives a Manager message that starts a turn",
    );
    assert.deepEqual(
      listCoordinationMessagePaths(supervisionRuntime(), leadSession),
      [],
    );

    const sentBefore = lead.sentMessageCalls.length;
    let imports = 0;
    const appendEntry = lead.pi.appendEntry;
    lead.pi.appendEntry = (type: string, data: unknown) => {
      imports++;
      appendEntry(type, data);
    };
    leadCtx.isIdle = () => false;
    writeChiefMessage(
      {
        version: 2,
        id: randomUUID(),
        leaseId: randomUUID(),
        kind: "manager_message",
        fromSessionId: LEAD_SESSION_ID,
        toSessionId: leadSession,
        leadSessionId: leadSession,
        text: "Do not import this unauthorized message",
        resultBindings: [
          {
            ref: "result:researcher#1",
            canonicalRef: `result:${randomUUID()}`,
          },
        ],
        build: HERDSMAN_BUILD,
        createdAt: Date.now(),
      },
      supervisionRuntime(),
    );
    await t.waitFor(() =>
      assert.deepEqual(
        listCoordinationMessagePaths(supervisionRuntime(), leadSession),
        [],
      ),
    );
    assert.equal(lead.sentMessageCalls.length, sentBefore);
    assert.equal(imports, 0);

    useManagerIdentity();
    managerCtx.isIdle = () => false;
    leadAgent.cwd = repoA;
    const managerDescriptor = readManagerDescriptor(
      supervisionRuntime(),
      WORKSPACE,
    );
    assert.ok(managerDescriptor);
    const crossRepositoryUplink = {
      version: 2 as const,
      id: randomUUID(),
      leaseId: managerDescriptor.leaseId,
      kind: "lead_message" as const,
      fromSessionId: leadSession,
      toSessionId: LEAD_SESSION_ID,
      leadSessionId: leadSession,
      text: "Repository A must not use Repository B supervision",
      createdAt: Date.now(),
    };
    writeCoordinationMessage(crossRepositoryUplink, supervisionRuntime());
    assert.ok(
      listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID).some(
        (path) => readChiefMessage(path).id === crossRepositoryUplink.id,
      ),
      "cross-repository uplink is queued before Manager authorization",
    );
    managerCtx.isIdle = () => true;
    await t.waitFor(() => assert.ok(repoALocalScopeQueries > 0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      manager.sentMessageCalls.some(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-lead_message" &&
          message?.details?.id === crossRepositoryUplink.id,
      ),
      false,
      "a Lead verified in repository A is not authorized by the repository B Manager",
    );
    assert.equal(
      listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID).some(
        (path) => readChiefMessage(path).id === crossRepositoryUplink.id,
      ),
      false,
      "cross-repository uplink is rejected without delivery",
    );
    leadAgent.cwd = "/tmp";

    managerCtx.isIdle = () => false;
    useLeadIdentity();
    const changedIdentityUplink = await lead.tools
      .find((tool) => tool.name === "message_supervisor")!
      .execute(
        "message",
        { message: "Reject if the live Lead identity changes during lookup" },
        undefined,
        undefined,
        leadCtx,
      );
    useManagerIdentity();
    changeLeadCwdAfterLocalScope = true;
    managerCtx.isIdle = () => true;
    await t.waitFor(() => assert.ok(leadCwdMutationQueries > 0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(leadAgent.cwd, repoA);
    assert.equal(
      manager.sentMessageCalls.some(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-lead_message" &&
          message?.details?.id === changedIdentityUplink.details.id,
      ),
      false,
      "Manager revalidates the Lead pane/workspace/cwd after asynchronous scope discovery",
    );
    assert.equal(
      listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID).some(
        (path) =>
          readChiefMessage(path).id === changedIdentityUplink.details.id,
      ),
      false,
      "the changed-identity uplink is rejected",
    );
    leadAgent.cwd = "/tmp";

    const competingSession = randomUUID();
    competingLease = claimManagerLease({
      build: HERDSMAN_BUILD,
      piSessionId: competingSession,
      paneId: "competing-manager-pane",
      tabId: "competing-manager-tab",
      workspaceId: `competing-${randomUUID()}`,
      repoKey: "/tmp",
    });
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      role: "manager",
      instanceId: randomUUID(),
      piSessionId: competingSession,
      updatedAt: Date.now(),
    });
    useManagerIdentity();
    const ambiguousReports = await manager.tools
      .find((tool) => tool.name === "list_staff")!
      .execute("list", {}, undefined, undefined, managerCtx);
    assert.equal(
      ambiguousReports.details.reports.some(
        (report: any) => report.session === leadSession,
      ),
      false,
      "ordinary Leads are not advertised when two Managers share their repository",
    );
    const queuedBefore = listCoordinationMessagePaths(
      supervisionRuntime(),
      leadSession,
    );
    await assert.rejects(
      manager.tools
        .find((tool) => tool.name === "message_staff")!
        .execute(
          "message",
          {
            session: leadSession,
            message: "Do not enqueue ambiguous supervision",
          },
          undefined,
          undefined,
          managerCtx,
        ),
      /Lead target was not found or is no longer eligible/,
    );
    assert.deepEqual(
      listCoordinationMessagePaths(supervisionRuntime(), leadSession),
      queuedBefore,
    );
    useLeadIdentity();
    await assert.rejects(
      lead.tools
        .find((tool) => tool.name === "message_supervisor")!
        .execute(
          "message",
          { message: "Do not guess between Managers" },
          undefined,
          undefined,
          leadCtx,
        ),
      /Manager supervisor is ambiguous/,
    );
    assert.equal(
      listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID)
        .length,
      0,
    );
    const assignedBranch = `assigned-${randomUUID()}`;
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: leadSession,
      repoKey: "/tmp",
      branch: assignedBranch,
      text: "assigned project work",
    });
    try {
      useManagerIdentity();
      const assignedReports = await manager.tools
        .find((tool) => tool.name === "list_staff")!
        .execute("list", {}, undefined, undefined, managerCtx);
      assert.equal(
        assignedReports.details.reports.find(
          (report: any) => report.session === leadSession,
        )?.relationship,
        "assigned",
        "project assignment authority remains available despite multiple Managers",
      );
      await manager.tools
        .find((tool) => tool.name === "message_staff")!
        .execute(
          "message",
          { session: leadSession, message: "Assigned Lead remains actionable" },
          undefined,
          undefined,
          managerCtx,
        );
      useLeadIdentity();
      await t.waitFor(() =>
        assert.ok(
          lead!.sentMessageCalls.some(
            ({ message }: any) =>
              message?.customType === "pi-herdsman-manager_message" &&
              message?.details?.toSessionId === leadSession &&
              message?.details?.branch === assignedBranch,
          ),
        ),
      );
    } finally {
      removeProjectAssignment(supervisionRuntime(), "/tmp", assignedBranch);
    }
  } finally {
    competingLease?.release();
    if (lead) {
      useLeadIdentity();
      await lead.events.get("session_shutdown")?.[0]();
    }
    if (manager) {
      useManagerIdentity();
      await manager.events.get("session_shutdown")?.[0]();
    }
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
    realFs.rmSync(repoA, { recursive: true, force: true });
  }
});

test("ordinary Lead receives Chief messages using its verified local repository despite stale workspace topology", async (t) => {
  setLeadEnvironment();
  const workspaceId = `lead-${randomUUID()}`;
  const leadSession = randomUUID();
  const chiefId = randomUUID();
  const socketPath = join(tmpdir(), `chief-local-scope-${randomUUID()}.sock`);
  process.env.HERDR_WORKSPACE_ID = workspaceId;
  process.env.HERDR_PANE_ID = "local-scope-lead-pane";
  process.env.HERDR_TAB_ID = "local-scope-lead-tab";
  process.env.HERDR_SOCKET_PATH = socketPath;
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    workspace_id: `chief-${randomUUID()}`,
    pane_id: "local-scope-chief-pane",
    tab_id: "local-scope-chief-tab",
    cwd: "/tmp",
  };
  const leadAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadSession,
    },
    workspace_id: workspaceId,
    pane_id: process.env.HERDR_PANE_ID,
    tab_id: process.env.HERDR_TAB_ID,
    cwd: "/tmp",
  };
  const chiefLease = claimChiefLease({
    piSessionId: chiefId,
    paneId: chiefAgent.pane_id,
    tabId: chiefAgent.tab_id,
    workspaceId: chiefAgent.workspace_id,
  });
  const incoming = {
    version: 2 as const,
    id: randomUUID(),
    leaseId: chiefLease.descriptor.leaseId,
    kind: "chief_message" as const,
    fromSessionId: chiefId,
    toSessionId: leadSession,
    leadSessionId: leadSession,
    text: "Chief message should use the Lead's local repository identity",
    createdAt: Date.now(),
  };
  writeChiefMessage(incoming, supervisionRuntime());
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeRepositoryChiefPi({
    activeTools: ["read"],
    persistMessages: true,
    exec: (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: { workspace_id: args[2], worktree: null },
        });
      if (args[0] === "worktree" && args[1] === "list") {
        const workspaceIndex = args.indexOf("--workspace");
        const staleWorkspace =
          workspaceIndex >= 0 && args[workspaceIndex + 1] === workspaceId;
        return respond({
          source: {
            source_workspace_id: staleWorkspace ? "repository-a" : workspaceId,
            repo_key: staleWorkspace ? "/inherited/repository-a/.git" : "/tmp",
            repo_name: staleWorkspace ? "repository-a" : "project-b",
          },
          worktrees: staleWorkspace ? [] : [{ open_workspace_id: workspaceId }],
        });
      }
      if (isAgentList(args))
        return respond({ agents: [chiefAgent, leadAgent] });
      if (args[0] === "agent" && args[1] === "get")
        return respond({
          agent: args[2] === chiefAgent.pane_id ? chiefAgent : leadAgent,
        });
      if (isApiSnapshot(args))
        return respond({
          snapshot: {
            agents: [chiefAgent, leadAgent],
            panes: [],
            workspaces: [],
          },
        });
      return respond({});
    },
  });
  const context = fakeContext(pi.entries) as any;
  context.sessionManager.getSessionId = () => leadSession;
  context.isIdle = () => true;
  registerExtension!(pi.pi as never);
  try {
    const { worktreeGroupScope } = await import("./herdr.ts");
    await assert.rejects(
      worktreeGroupScope(pi.pi, context, workspaceId),
      /Herdr project topology changed/,
      "the Lead workspace continues to report stale repository A topology",
    );
    await pi.events.get("session_start")![0](undefined, context);
    await t.waitFor(() =>
      assert.ok(
        pi.sentMessageCalls.some(
          ({ message }: any) =>
            message?.customType === "pi-herdsman-chief_message" &&
            message?.details?.id === incoming.id,
        ),
      ),
    );
    await t.waitFor(() =>
      assert.deepEqual(
        listCoordinationMessagePaths(supervisionRuntime(), leadSession),
        [],
      ),
    );
    await assert.rejects(
      worktreeGroupScope(pi.pi, context, workspaceId),
      /Herdr project topology changed/,
      "Chief delivery did not repair or rely on the stale workspace topology",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    chiefLease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Manager-to-ordinary-Lead inbox rechecks authority before importing result refs", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_PANE_ID = "ordinary-lead-pane";
  process.env.HERDR_TAB_ID = "ordinary-lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-inbox-authority-${randomUUID()}.sock`,
  );
  const leadSession = randomUUID();
  const managerSession = randomUUID();
  const managerPane = "manager-inbox-pane";
  const managerTab = "manager-inbox-tab";
  const managerLease = claimManagerLease({
    build: HERDSMAN_BUILD,
    piSessionId: managerSession,
    paneId: managerPane,
    tabId: managerTab,
    workspaceId: WORKSPACE,
    repoKey: "/tmp",
  });
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "manager",
    instanceId: randomUUID(),
    piSessionId: managerSession,
    updatedAt: Date.now(),
  });
  const managerPeerLease = acquireProcessLock(
    peerLeadLockPath(peerRuntime(), managerSession),
    { name: "Manager peer presence" },
  );
  writePeerLeadRecord(peerRuntime(), {
    version: 1,
    role: "manager",
    piSessionId: managerSession,
    paneId: managerPane,
    tabId: managerTab,
    workspaceId: WORKSPACE,
    claim: managerPeerLease.claim,
    updatedAt: Date.now(),
  });
  const managerAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: managerSession,
    },
    workspace_id: WORKSPACE,
    pane_id: managerPane,
    tab_id: managerTab,
    cwd: "/tmp",
  };
  const leadAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadSession,
    },
    workspace_id: WORKSPACE,
    pane_id: "ordinary-lead-pane",
    tab_id: "ordinary-lead-tab",
    cwd: "/tmp",
  };
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeRepositoryChiefPi({
    activeTools: ["read"],
    exec: (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get")
        return respond({
          workspace: {
            worktree: { repo_key: "/tmp", is_linked_worktree: false },
          },
        });
      if (args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: WORKSPACE,
            repo_key: "/tmp",
            repo_name: "project",
            source_checkout_path: "/tmp/project-root",
          },
          worktrees: [{ open_workspace_id: WORKSPACE }],
        });
      if (isAgentList(args))
        return respond({ agents: [managerAgent, leadAgent] });
      if (args[0] === "agent" && args[1] === "get")
        return respond({ agent: managerAgent });
      if (isApiSnapshot(args))
        return respond({
          snapshot: {
            agents: [managerAgent, leadAgent],
            panes: [],
            workspaces: [],
          },
        });
      return respond({});
    },
  });
  const context = fakeContext(pi.entries) as any;
  context.sessionManager.getSessionId = () => leadSession;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const incoming = {
      version: 2 as const,
      id: randomUUID(),
      leaseId: managerLease.descriptor.leaseId,
      kind: "manager_message" as const,
      fromSessionId: managerSession,
      toSessionId: leadSession,
      leadSessionId: leadSession,
      text: "Do not import this after authority changes",
      resultBindings: [
        {
          ref: "result:researcher#1",
          canonicalRef: `result:${randomUUID()}`,
        },
      ],
      createdAt: Date.now(),
    };
    writeChiefMessage(incoming, supervisionRuntime());
    removePeerLeadRecord(peerRuntime(), leadSession);
    const originalGetSessionName = pi.pi.getSessionName;
    let revoked = false;
    pi.pi.getSessionName = () => {
      if (!revoked) {
        revoked = true;
        managerLease.release();
      }
      return originalGetSessionName();
    };
    let appendCalls = 0;
    const originalAppendEntry = pi.pi.appendEntry;
    pi.pi.appendEntry = (type: string, data: unknown) => {
      appendCalls++;
      originalAppendEntry(type, data);
    };
    const sentBefore = pi.sentMessageCalls.length;
    await t.waitFor(() => assert.equal(revoked, true));
    assert.equal(pi.sentMessageCalls.length, sentBefore);
    assert.equal(appendCalls, 0);
    assert.ok(
      listCoordinationMessagePaths(supervisionRuntime(), leadSession).some(
        (path) => readChiefMessage(path).id === incoming.id,
      ),
      "rejected Manager message remains pending for retry",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    managerPeerLease.release();
    managerLease.release();
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
  const managerLease = claimManagerLease({
    build: HERDSMAN_BUILD,
    piSessionId: `dead-manager-${randomUUID()}`,
    paneId: "dead-manager-pane",
    tabId: "dead-manager-tab",
    workspaceId: "root-workspace",
    repoKey: "repo-key",
  });
  const managerDescriptor = managerDescriptorPath(
    supervisionRuntime(),
    "root-workspace",
  );
  const managerLock = `${managerDescriptor}.lock`;
  const deadPid = 2147483647;
  const deadClaim = { ...managerLease.descriptor.claim, pid: deadPid };
  writeFileSync(
    managerDescriptor,
    JSON.stringify({ ...managerLease.descriptor, claim: deadClaim }),
  );
  rmSync(managerLock, { recursive: true, force: true });
  mkdirSync(managerLock, { mode: 0o700 });
  writeFileSync(
    join(managerLock, `${deadPid}-${deadClaim.id}`),
    JSON.stringify(deadClaim),
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    entries,
    exec: (command, args) => {
      if (command === "git" && args[0] === "rev-parse")
        return {
          stdout: realFs.realpathSync(tmpdir()),
          stderr: "",
          code: 0,
        };
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: { workspace_id: args[2], worktree: null },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: "root-workspace",
                repo_key: realFs.realpathSync(tmpdir()),
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
  const context = fakeContext(entries, [
    {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "message_supervisor" }],
      },
    },
  ]) as any;
  entries.push({
    type: "custom",
    customType: "pi-herdsman-session-kind",
    data: {
      version: 1,
      sessionId: context.sessionManager.getSessionId(),
      kind: "ordinary",
    },
  });
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);

    const sessionId = context.sessionManager.getSessionId();
    const initial = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(initial);

    const chief = pi.tools.find((tool) => tool.name === "message_supervisor");
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
    managerLease.release();
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
  const sessionId = `peer-presence-${randomUUID()}`;
  context.sessionManager.getSessionId = () => sessionId;
  entries.push({
    type: "custom",
    customType: "pi-herdsman-session-kind",
    data: { version: 1, sessionId, kind: "ordinary" },
  });
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const first = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(first);

    await pi.commandOptions.get("chief").handler("", context);
    assert.equal(readPeerLeadRecord(peerRuntime(), sessionId), undefined);

    await pi.commandOptions.get("chief").handler("leave", context);
    const restored = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(restored);
    assert.notEqual(restored.claim.id, first.claim.id);

    await pi.events.get("session_shutdown")![0]();
    assert.equal(readPeerLeadRecord(peerRuntime(), sessionId), undefined);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    removePeerLeadRecord(peerRuntime(), sessionId);
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
      if (command === "git" && args[0] === "rev-parse")
        return {
          stdout: realFs.realpathSync(tmpdir()),
          stderr: "",
          code: 0,
        };
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: { workspace_id: args[2], worktree: null },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: "root-workspace",
                repo_key: realFs.realpathSync(tmpdir()),
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
  const context = fakeContext(entries, [
    {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "message_supervisor" }],
      },
    },
  ]) as any;
  entries.push({
    type: "custom",
    customType: "pi-herdsman-session-kind",
    data: {
      version: 1,
      sessionId: context.sessionManager.getSessionId(),
      kind: "ordinary",
    },
  });
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

    const chief = pi.tools.find((tool) => tool.name === "message_supervisor");
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
  const entries: unknown[] = [];
  const delivered = testGate<void>();
  const receiver = fakeChiefPi({
    exec: peerTopologyExec,
    entries,
    sendMessage: (message) => {
      if (String((message as any)?.content ?? "").includes("queued peer")) {
        entries.push(message);
        const waitForRemoval = () =>
          listCoordinationMessagePaths(runtime, receiverId).length === 0
            ? delivered.resolve()
            : queueMicrotask(waitForRemoval);
        queueMicrotask(waitForRemoval);
      }
    },
    activeTools: ["read", "bash"],
  });
  const receiverContext = fakeContext(entries) as any;
  receiverContext.sessionManager = {
    ...receiverContext.sessionManager,
    getSessionId: () => receiverId,
  };
  const runtime = peerRuntime();
  const senderLease = acquireProcessLock(peerLeadLockPath(runtime, senderId), {
    name: "Lead peer presence",
  });
  const senderRecord = {
    version: 2 as const,
    build: HERDSMAN_BUILD,
    role: "lead" as const,
    piSessionId: senderId,
    paneId: "sender-pane",
    tabId: "sender-tab",
    workspaceId: WORKSPACE,
    socket,
    group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
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
      peerSource: {
        role: "lead" as const,
        socket,
        group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
        managed: false,
      },
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
  const sender = fakeChiefPi({
    activeTools: ["read", "bash"],
    exec: peerTopologyExec,
  });
  const senderContext = fakeContext(sender.entries) as any;
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
    version: 2 as const,
    build: OTHER_HERDSMAN_BUILD,
    sessionKind: "ordinary" as const,
    piSessionId: targetId,
    paneId: "target-pane",
    tabId: "target-tab",
    workspaceId: WORKSPACE,
    socket,
    group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
    claim: targetLease.claim,
    updatedAt: Date.now(),
  };
  writePeerLeadRecord(runtime, targetRecord);
  try {
    await sender.events.get("session_start")![0](undefined, senderContext);
    const peer = sender.tools.find((tool) => tool.name === "message_peer");
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
    const entries: unknown[] = [];
    const delivered = testGate<void>();
    const receiver = fakeChiefPi({
      entries,
      exec: peerTopologyExec,
      sendMessage: (message) => {
        if (
          String((message as any)?.content ?? "").includes("sender survived")
        ) {
          entries.push(message);
          const waitForRemoval = () =>
            listCoordinationMessagePaths(runtime, targetId).length === 0
              ? delivered.resolve()
              : queueMicrotask(waitForRemoval);
          queueMicrotask(waitForRemoval);
        }
      },
      activeTools: ["read", "bash"],
    });
    const receiverContext = fakeContext(entries) as any;
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

test("peer delivery revalidates queued sender assignment context", async (t) => {
  for (const scenario of [
    {
      name: "managed sender retirement",
      queuedManaged: true,
      assignSender: false,
    },
    {
      name: "ordinary sender assigned later",
      queuedManaged: false,
      assignSender: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      setLeadEnvironment();
      const socket = join(tmpdir(), `peer-sender-context-${randomUUID()}.sock`);
      const receiverId = randomUUID();
      const senderId = randomUUID();
      const group = {
        repoKey: "peer-test-repo",
        primaryWorkspaceId: WORKSPACE,
      };
      process.env.HERDR_SOCKET_PATH = socket;
      process.env.HERDR_PANE_ID = "receiver-pane";
      process.env.HERDR_TAB_ID = "receiver-tab";
      const runtime = peerRuntime();
      const branch = `peer-${randomUUID()}`;
      const senderLease = acquireProcessLock(
        peerLeadLockPath(runtime, senderId),
        {
          name: "Lead peer presence",
        },
      );
      writePeerLeadRecord(runtime, {
        version: 2,
        build: HERDSMAN_BUILD,
        role: "lead",
        piSessionId: senderId,
        paneId: "sender-pane",
        tabId: "sender-tab",
        workspaceId: WORKSPACE,
        socket,
        group,
        claim: senderLease.claim,
        updatedAt: Date.now(),
      });
      writeProjectAssignment(supervisionRuntime(), {
        version: 2,
        id: receiverId,
        repoKey: group.repoKey,
        branch: `receiver-${branch}`,
        text: "managed peer receiver",
      });
      if (scenario.queuedManaged)
        writeProjectAssignment(supervisionRuntime(), {
          version: 2,
          id: senderId,
          repoKey: group.repoKey,
          branch,
          text: "sender before retirement",
        });

      const entries: unknown[] = [];
      const receiver = fakeChiefPi({
        entries,
        exec: peerTopologyExec,
        sendMessage: (message) => entries.push(message),
        activeTools: ["read", "bash"],
      });
      const context = fakeContext(entries) as any;
      context.sessionManager = {
        ...context.sessionManager,
        getSessionId: () => receiverId,
      };
      registerExtension!(receiver.pi as never);
      let stage = "receiver_presence";
      try {
        await receiver.events.get("session_start")![0](undefined, context);
        await t.waitFor(
          () => assert.ok(readPeerLeadRecord(runtime, receiverId)),
          { timeout: 3_000 },
        );
        const record = {
          version: 2 as const,
          build: HERDSMAN_BUILD,
          id: randomUUID(),
          leaseId: senderLease.claim.id,
          kind: "peer_message" as const,
          fromSessionId: senderId,
          toSessionId: receiverId,
          leadSessionId: senderId,
          peerSource: {
            role: "lead" as const,
            socket,
            group,
            managed: scenario.queuedManaged,
          },
          text: `sender context ${scenario.name}`,
          createdAt: Date.now(),
        };
        writeCoordinationMessage(record, runtime);
        assert.equal(
          listCoordinationMessagePaths(runtime, receiverId).length,
          1,
        );
        stage = "inbox_rejection";
        if (scenario.assignSender)
          writeProjectAssignment(supervisionRuntime(), {
            version: 2,
            id: senderId,
            repoKey: group.repoKey,
            branch,
            text: "sender assigned after queueing",
          });
        else
          removeProjectAssignment(supervisionRuntime(), group.repoKey, branch);
        await t.waitFor(
          () =>
            assert.equal(
              listCoordinationMessagePaths(runtime, receiverId).length,
              0,
            ),
          { timeout: 4_000 },
        );
        assert.equal(
          receiver.sentMessageCalls.filter((call) =>
            String((call.message as any)?.content ?? "").includes(record.text),
          ).length,
          0,
        );
      } catch (error) {
        t.diagnostic(
          `stage=${stage} ` +
            `queued=${listCoordinationMessagePaths(runtime, receiverId).length} ` +
            `peerPresent=${Boolean(readPeerLeadRecord(runtime, receiverId))} ` +
            `sendCalls=${receiver.sentMessageCalls.length}`,
        );
        throw error;
      } finally {
        await receiver.events.get("session_shutdown")?.[0]();
        removeProjectAssignment(supervisionRuntime(), group.repoKey, branch);
        removeProjectAssignment(
          supervisionRuntime(),
          group.repoKey,
          `receiver-${branch}`,
        );
        removePeerLeadRecord(runtime, senderId);
        senderLease.release();
        delete process.env.HERDR_SOCKET_PATH;
        delete process.env.HERDR_PANE_ID;
        delete process.env.HERDR_TAB_ID;
        setLeadEnvironment();
      }
    });
  }
});

test("remote ordinary-Lead inbox delivery is role-authorized and still requires an ordinary recipient", async (t) => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `remote-lead-inbox-${randomUUID()}.sock`);
  const recipientId = randomUUID();
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "remote-lead-recipient-pane";
  process.env.HERDR_TAB_ID = "remote-lead-recipient-tab";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  const runtime = peerRuntime();
  const branch = `remote-recipient-${randomUUID()}`;
  const entries: unknown[] = [];
  const receiver = fakeChiefPi({
    entries,
    exec: peerTopologyExec,
    activeTools: ["read", "bash"],
  });
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => recipientId,
  };
  const makeRecord = (text: string) => ({
    version: 2 as const,
    build: HERDSMAN_BUILD,
    id: randomUUID(),
    leaseId: randomUUID(),
    kind: "peer_message" as const,
    fromSessionId: randomUUID(),
    toSessionId: recipientId,
    leadSessionId: "",
    peerSource: { role: "lead" as const, remoteOrdinary: true as const },
    text,
    createdAt: Date.now(),
  });
  registerExtension!(receiver.pi as never);
  try {
    await receiver.events.get("session_start")![0](undefined, context);
    await t.waitFor(() => assert.ok(readPeerLeadRecord(runtime, recipientId)));
    const allowed = makeRecord("remote ordinary Lead delivery");
    allowed.leadSessionId = allowed.fromSessionId;
    writeCoordinationMessageRaw(allowed, runtime);
    await t.waitFor(() =>
      assert.equal(
        receiver.sentMessageCalls.filter((call) =>
          String((call.message as any)?.content ?? "").includes(
            "remote ordinary Lead delivery",
          ),
        ).length,
        1,
      ),
    );

    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: recipientId,
      repoKey: "peer-test-repo",
      branch,
      text: "recipient is now assigned",
    });
    const denied = makeRecord(
      "remote ordinary Lead must not reach assigned recipient",
    );
    denied.leadSessionId = denied.fromSessionId;
    writeCoordinationMessageRaw(denied, runtime);
    await t.waitFor(() =>
      assert.equal(
        listCoordinationMessagePaths(runtime, recipientId).length,
        1,
      ),
    );
    assert.equal(
      receiver.sentMessageCalls.some((call) =>
        String((call.message as any)?.content ?? "").includes(
          "must not reach assigned recipient",
        ),
      ),
      false,
      "remote source authorization must not bypass local recipient eligibility",
    );
  } finally {
    removeProjectAssignment(supervisionRuntime(), recipientId, branch);
    await receiver.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    setLeadEnvironment();
  }
});

test("peer delivery rejects same-generation recipient provenance changes before send", async (t) => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `peer-authority-delivery-${randomUUID()}.sock`);
  const targetId = randomUUID();
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "target-pane";
  process.env.HERDR_TAB_ID = "target-tab";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  const runtime = peerRuntime();
  const entries: unknown[] = [];
  const releaseTopology = testGate<void>();
  let topologyCalls = 0;
  let gateSecondTopology = false;
  let secondTopologyStarted = false;
  const receiver = fakeChiefPi({
    entries,
    exec: async (command, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        topologyCalls++;
        if (gateSecondTopology && topologyCalls === 2) {
          secondTopologyStarted = true;
          await releaseTopology.promise;
        }
        return peerTopologyExec(command, args);
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
    activeTools: ["read", "bash"],
  });
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => targetId,
  };
  const senderId = randomUUID();
  const group = { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE };
  const message = {
    version: 2 as const,
    build: HERDSMAN_BUILD,
    id: randomUUID(),
    leaseId: randomUUID(),
    kind: "peer_message" as const,
    fromSessionId: senderId,
    toSessionId: targetId,
    leadSessionId: senderId,
    peerSource: { role: "lead" as const, socket, group, managed: true },
    text: "must not deliver after recipient authority changes",
    createdAt: Date.now(),
  };
  registerExtension!(receiver.pi as never);
  try {
    await receiver.events.get("session_start")![0](undefined, context);
    await t.waitFor(() => {
      assert.ok(readPeerLeadRecord(runtime, targetId));
    });
    topologyCalls = 0;
    gateSecondTopology = true;
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: message.fromSessionId,
      repoKey: "peer-test-repo",
      branch: "source-peer",
      text: "source authority",
    });
    writeCoordinationMessageRaw(message, runtime);
    await t.waitFor(() => assert.equal(secondTopologyStarted, true), {
      timeout: 5000,
    });
    const before = readPeerLeadRecord(runtime, targetId);
    assert.ok(before);
    const beforeClaim = before.claim;
    writePeerLeadRecordRaw(runtime, {
      ...before,
      group: { repoKey: "peer-other-repo", primaryWorkspaceId: "other" },
      updatedAt: Date.now(),
    });
    assert.deepEqual(readPeerLeadRecord(runtime, targetId)?.claim, beforeClaim);
    releaseTopology.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(listCoordinationMessagePaths(runtime, targetId).length, 1);
    assert.equal(
      receiver.sentMessageCalls.some((call) =>
        String((call.message as any)?.content ?? "").includes(
          "must not deliver after recipient authority changes",
        ),
      ),
      false,
    );
  } finally {
    releaseTopology.resolve();
    await receiver.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    setLeadEnvironment();
  }
});

test("managed peer scope loss rejects stale local group and defers transient failure", async (t) => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `peer-current-group-${randomUUID()}.sock`);
  const receiverId = randomUUID();
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "receiver-pane";
  process.env.HERDR_TAB_ID = "receiver-tab";
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId: receiverId,
        kind: "managed",
        repoKey: "peer-test-repo",
        branch: "original-project",
      },
    },
  ];
  let topology: "available" | "not-git" | "unavailable" | "moved" = "available";
  let unavailableLookups = 0;
  const receiver = fakeChiefPi({
    entries,
    exec: (_command, args) => {
      if (
        args[0] === "worktree" &&
        args[1] === "list" &&
        topology === "unavailable"
      )
        unavailableLookups++;
      return args[0] === "worktree" &&
        args[1] === "list" &&
        topology === "not-git"
        ? nonGitWorkspaceResponse()
        : args[0] === "worktree" &&
            args[1] === "list" &&
            topology === "unavailable"
          ? { stdout: "", stderr: "temporary Herdr outage", code: 1 }
          : args[0] === "worktree" && args[1] === "list" && topology === "moved"
            ? {
                stdout: JSON.stringify({
                  id: AGENT_ID,
                  result: {
                    source: {
                      repo_key: "peer-other-repo",
                      repo_name: "peer-other-repo",
                      source_workspace_id: "other-primary",
                    },
                    worktrees: [{ open_workspace_id: WORKSPACE }],
                  },
                }),
                stderr: "",
                code: 0,
              }
            : args[0] === "worktree" && args[1] === "list"
              ? {
                  stdout: JSON.stringify({
                    id: AGENT_ID,
                    result: {
                      source: {
                        repo_key: "peer-test-repo",
                        repo_name: "peer-test-repo",
                        source_workspace_id: "new-primary",
                      },
                      worktrees: [{ open_workspace_id: WORKSPACE }],
                    },
                  }),
                  stderr: "",
                  code: 0,
                }
              : { stdout: "{}", stderr: "", code: 0 };
    },
    activeTools: ["read", "bash"],
  });
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => receiverId,
  };
  const runtime = peerRuntime();
  const senderTargetId = `target-${randomUUID()}`;
  const senderTargetLease = acquireProcessLock(
    peerLeadLockPath(runtime, senderTargetId),
    { name: "Lead peer presence" },
  );
  writePeerLeadRecordRaw(runtime, {
    version: 2,
    build: HERDSMAN_BUILD,
    sessionKind: "ordinary",
    piSessionId: senderTargetId,
    paneId: "target-pane",
    tabId: "target-tab",
    workspaceId: WORKSPACE,
    socket,
    group: { repoKey: "peer-test-repo", primaryWorkspaceId: "new-primary" },
    claim: senderTargetLease.claim,
    updatedAt: Date.now(),
  });
  const managedBranch = `peer-${randomUUID()}`;
  writeProjectAssignment(supervisionRuntime(), {
    version: 2,
    id: receiverId,
    repoKey: "peer-test-repo",
    branch: managedBranch,
    text: "managed peer scope test",
  });
  const record = {
    version: 2 as const,
    build: HERDSMAN_BUILD,
    id: randomUUID(),
    leaseId: randomUUID(),
    kind: "peer_message" as const,
    fromSessionId: randomUUID(),
    toSessionId: receiverId,
    leadSessionId: "",
    peerSource: {
      role: "lead" as const,
      socket,
      group: { repoKey: "peer-test-repo", primaryWorkspaceId: "new-primary" },
      managed: true,
    },
    resultBindings: [
      { ref: "result:peer-review#1", canonicalRef: `result:${randomUUID()}` },
    ],
    text: "must not cross the changed worktree group",
    createdAt: Date.now(),
  };
  record.leadSessionId = record.fromSessionId;
  writeProjectAssignment(supervisionRuntime(), {
    version: 2,
    id: record.fromSessionId,
    repoKey: "peer-test-repo",
    branch: "source-peer",
    text: "source authority",
  });
  writeCoordinationMessageRaw(record, runtime);
  registerExtension!(receiver.pi as never);
  try {
    topology = "not-git";
    await receiver.events.get("session_start")![0](undefined, context);
    await assert.rejects(
      receiver.tools
        .find((tool) => tool.name === "list_peers")!
        .execute("list", {}, undefined, undefined, context),
      /Peer eligibility could not be verified|Peer is unavailable in this role/,
    );
    await assert.rejects(
      receiver.tools
        .find((tool) => tool.name === "message_peer")!
        .execute(
          "message",
          { session: senderTargetId, message: "must not queue" },
          undefined,
          undefined,
          context,
        ),
      /outside the permitted project scope|Peer is unavailable in this role/,
    );
    assert.equal(
      listCoordinationMessagePaths(runtime, receiverId).length,
      1,
      "missing worktree evidence keeps the queued peer message for retry",
    );
    assert.equal(
      receiver.sentMessageCalls.some((call) =>
        String((call.message as any)?.content ?? "").includes(
          "must not cross the changed worktree group",
        ),
      ),
      false,
    );

    topology = "moved";
    removeProjectAssignment(
      supervisionRuntime(),
      "peer-test-repo",
      managedBranch,
    );
    writeCoordinationMessageRaw(
      {
        ...record,
        id: randomUUID(),
        text: "ordinary recipient moved to another group",
        createdAt: Date.now(),
      },
      runtime,
    );
    await receiver.events.get("session_start")![0](undefined, context);
    await t.waitFor(
      () =>
        assert.deepEqual(listCoordinationMessagePaths(runtime, receiverId), []),
      { timeout: 5000 },
    );
    assert.equal(
      receiver.sentMessageCalls.some((call) =>
        String((call.message as any)?.content ?? "").includes(
          "ordinary recipient moved to another group",
        ),
      ),
      false,
    );
    assert.equal(
      (receiver.pi as any).getActiveTools().includes("message_peer"),
      false,
    );
    assert.equal(
      (receiver.pi as any).getActiveTools().includes("list_peers"),
      false,
    );
    assert.equal(
      entries.some(
        (entry: any) =>
          entry?.customType === "pi-herdsman-result-ref" &&
          entry?.data?.ref === "result:peer-review#1",
      ),
      false,
    );
    topology = "unavailable";
    writeCoordinationMessageRaw(
      {
        ...record,
        id: randomUUID(),
        text: "defer while current scope is unavailable",
        createdAt: Date.now(),
      },
      runtime,
    );
    delete process.env.HERDR_SOCKET_PATH;
    await receiver.events.get("session_start")![0](undefined, context);
    assert.equal(listCoordinationMessagePaths(runtime, receiverId).length, 1);
    assert.equal(
      receiver.sentMessageCalls.some((call) =>
        String((call.message as any)?.content ?? "").includes(
          "defer while current scope is unavailable",
        ),
      ),
      false,
    );
  } finally {
    await receiver.events.get("session_shutdown")?.[0]();
    removePeerLeadRecord(runtime, senderTargetId);
    senderTargetLease.release();
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

test("Chief accepts a recorded Manager sender independently of source workspace", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-manager-inbox-${randomUUID()}.sock`,
  );
  const senderId = randomUUID();
  const sender = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: senderId,
    },
    pane_id: "sender-pane",
    tab_id: "sender-tab",
    workspace_id: "sender-workspace",
  };
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const pi = fakeChiefPi({
    exec: (_command, args) => {
      if (isAgentList(args)) return respond({ agents: [sender] });
      if (args[0] === "agent" && args[1] === "get")
        return respond({ agent: sender });
      if (args[0] === "worktree" && args[1] === "list")
        return respond({
          source: {
            source_workspace_id: "other-workspace",
            repo_key: "/tmp",
            repo_name: "project",
          },
          worktrees: [{ open_workspace_id: sender.workspace_id }],
        });
      return undefined;
    },
  });
  const context = fakeContext(pi.entries) as any;
  context.mode = "rpc";
  registerExtension!(pi.pi as never);
  const lease = claimManagerLease({
    build: HERDSMAN_BUILD,
    piSessionId: senderId,
    paneId: sender.pane_id,
    tabId: sender.tab_id,
    workspaceId: sender.workspace_id,
    repoKey: "/tmp",
  });
  const managerRuntime = supervisionRuntime();
  const selectedDescriptorPath = managerDescriptorPath(
    managerRuntime,
    sender.workspace_id,
  );
  const unrelatedMalformedPath = managerDescriptorPath(
    managerRuntime,
    "unrelated-malformed-manager",
  );
  try {
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      role: "manager",
      instanceId: randomUUID(),
      piSessionId: senderId,
      updatedAt: Date.now(),
    });
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    const record = {
      version: 2,
      id: randomUUID(),
      leaseId: lease.descriptor.leaseId,
      kind: "manager_message",
      fromSessionId: senderId,
      toSessionId: LEAD_SESSION_ID,
      leadSessionId: senderId,
      text: "recorded sender",
      createdAt: Date.now(),
    };
    writeFileSync(unrelatedMalformedPath, "{", "utf8");
    writeChiefMessage(record, supervisionRuntime());
    await t.waitFor(
      () =>
        assert.ok(
          pi.sentMessageCalls.some(
            ({ message }: any) => message?.details?.id === record.id,
          ),
        ),
      { timeout: 5000 },
    );
    assert.equal(
      listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID)
        .length,
      1,
    );
    const receipt = pi.sentMessageCalls.find(
      ({ message }: any) => message?.details?.id === record.id,
    )!.message as any;
    pi.entries.push({ type: "custom", ...receipt });
    await t.waitFor(
      () =>
        assert.equal(
          listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID)
            .length,
          0,
        ),
      { timeout: 5000 },
    );
    const stale = { ...record, id: randomUUID(), leaseId: randomUUID() };
    writeChiefMessage(stale, supervisionRuntime());
    await t.waitFor(
      () =>
        assert.equal(
          listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID)
            .length,
          0,
        ),
      { timeout: 5000 },
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }: any) => message?.details?.id === stale.id,
      ),
      false,
    );
    const selectedDescriptor = readFileSync(selectedDescriptorPath, "utf8");
    writeFileSync(selectedDescriptorPath, "{", "utf8");
    const malformedSender = {
      ...record,
      id: randomUUID(),
      text: "malformed selected descriptor cannot authorize",
    };
    const malformedSenderPath = writeChiefMessage(
      malformedSender,
      supervisionRuntime(),
    );
    await t.waitFor(
      () =>
        assert.deepEqual(
          listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID),
          [malformedSenderPath],
        ),
      { timeout: 5000 },
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }: any) => message?.details?.id === malformedSender.id,
      ),
      false,
    );
    writeFileSync(selectedDescriptorPath, selectedDescriptor, "utf8");
    await t.waitFor(() =>
      assert.ok(
        pi.sentMessageCalls.some(
          ({ message }: any) => message?.details?.id === malformedSender.id,
        ),
      ),
    );
    const malformedSenderReceipt = pi.sentMessageCalls.find(
      ({ message }: any) => message?.details?.id === malformedSender.id,
    )!.message as any;
    pi.entries.push({ type: "custom", ...malformedSenderReceipt });
    await t.waitFor(() =>
      assert.deepEqual(
        listCoordinationMessagePaths(supervisionRuntime(), LEAD_SESSION_ID),
        [],
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    for (const path of [selectedDescriptorPath, unrelatedMalformedPath])
      if (existsSync(path)) unlinkSync(path);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
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
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
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

test("Chief activation rollback fails closed when its restrictive projection fails", async () => {
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
  await pi.commandOptions.get("lead").handler("orchestrate", context);
  const projected = pi.pi.getActiveTools();
  assert.deepEqual(projected, leadTools);
  assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
    "read",
    "bash",
  ]);
  const setActiveTools = pi.pi.setActiveTools;
  let activationAttempted = false;
  let projectionFailures = 2;
  pi.pi.setActiveTools = (next: string[]) => {
    if (next.includes("list_staff")) {
      activationAttempted = true;
      setActiveTools(next);
      throw new Error("Chief activation failed");
    }
    if (
      activationAttempted &&
      projectionFailures > 0 &&
      next.includes("delegate_agent")
    ) {
      projectionFailures--;
      throw new Error("Lead profile restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("", context);

  assert.deepEqual(pi.pi.getActiveTools(), leadTools);
  assert.deepEqual(sessionLeadExecutionState(entries)?.leadTools, [
    "read",
    "bash",
  ]);
  const savedRole = [...entries]
    .reverse()
    .find((entry: any) => entry.customType === "pi-herdsman-role");
  assert.equal(savedRole?.data.role, "lead");
  assert.deepEqual(savedRole?.data.leadTools, ["read", "bash"]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("Lead profile restoration failed"),
    ),
  );
  assert.deepEqual(notices, [
    "Lead execution: orchestrate",
    "Chief activation failed",
  ]);
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), leadTools);
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
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    const ordinaryTools = pi.pi.getActiveTools();
    const setActiveTools = pi.pi.setActiveTools;
    pi.pi.setActiveTools = (next: string[]) => {
      if (next.includes("list_staff"))
        throw new Error("Chief tool activation failed");
      setActiveTools(next);
    };

    await pi.commandOptions.get("chief").handler("", context);

    assert.deepEqual(pi.pi.getActiveTools(), ordinaryTools);
    assert.deepEqual(notices, [
      "Lead execution: orchestrate",
      "Chief tool activation failed",
    ]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
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
  const sessionId = `pre-chief-${randomUUID()}`;
  context.sessionManager.getSessionId = () => sessionId;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const baseline = pi.pi.getActiveTools();
    const preChiefBranch = [...entries];
    assert.equal(sessionLeadRoleState(preChiefBranch), undefined);
    await pi.commandOptions.get("chief").handler("", context);
    assert.equal(readPeerLeadRecord(peerRuntime(), sessionId), undefined);
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
      sessionLeadRoleState(
        context.sessionManager.getBranch(),
        context.sessionManager.getSessionId(),
      )?.role,
      "lead",
    );
    assert.ok(readPeerLeadRecord(peerRuntime(), sessionId));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    removePeerLeadRecord(peerRuntime(), sessionId);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
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
  const sessionId = `chief-branch-${randomUUID()}`;
  context.sessionManager.getSessionId = () => sessionId;
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
        data: { sessionId, role: "chief", leadTools: baseline },
      },
    ];
    context.sessionManager.getBranch = () => chiefBranch;
    await pi.events.get("session_tree")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
    ]);
    assert.equal(readPeerLeadRecord(peerRuntime(), sessionId), undefined);
    assert.throws(() =>
      claimChiefLease({
        piSessionId: "replacement-session",
        paneId: "replacement-pane",
        tabId: "replacement-tab",
        workspaceId: WORKSPACE,
      }),
    );
    assert.equal(
      sessionLeadRoleState(
        entries,
        (entries as any[]).findLast(
          (entry: any) => entry.customType === "pi-herdsman-role",
        )?.data.sessionId ?? LEAD_SESSION_ID,
      )?.role,
      "chief",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    removePeerLeadRecord(peerRuntime(), sessionId);
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
        customType: "pi-herdsman-lead-execution",
        data: {
          sessionId: LEAD_SESSION_ID,
          mode: "broken",
          leadTools: ["read"],
        },
      },
    ];
    pi.pi.setActiveTools(["read", "bash"]);
    await pi.events.get("session_tree")![0](undefined, context);
    assert.equal(pi.pi.getActiveTools().includes("list_staff"), false);
    assert.deepEqual(pi.pi.getActiveTools(), leadTools);
    const ordinaryPrompt: any = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](ordinaryPrompt, context);
    assert.equal(
      ordinaryPrompt.systemPromptOptions.sections.pi_herdsman_lead_execution,
      undefined,
    );
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
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId())
        ?.role,
      "lead",
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
    if (failRestore && next.join("|") === [...baseline].join("|")) {
      failRestore = false;
      throw new Error("manual leave restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("leave", context);

  const restoredLeadTools = [...new Set([...baseline, ...leadTools])];
  assert.deepEqual(pi.pi.getActiveTools(), restoredLeadTools);
  assert.ok(leadTools.every((name) => restoredLeadTools.includes(name)));
  assert.equal(
    chiefTools.some((name) => restoredLeadTools.includes(name)),
    false,
  );
  assert.deepEqual(
    entries
      .filter((entry: any) => entry.customType === "pi-herdsman-role")
      .at(-1)?.data,
    { sessionId: LEAD_SESSION_ID, role: "lead", leadTools: ["read", "bash"] },
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), restoredLeadTools);
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
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const ordinaryBaseline = ["read", "bash"];
  const baseline = [
    ...ordinaryBaseline,
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
    "message_supervisor",
    "list_peers",
    "message_peer",
  ];
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: {
      sessionId: LEAD_SESSION_ID,
      role: "lead",
      leadTools: ordinaryBaseline,
    },
  });
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === [...baseline].join("|")) {
      failRestore = false;
      const activeToolsBeforeFailure = [...pi.pi.getActiveTools()];
      try {
        throw new Error("lead session-start restoration failed");
      } catch (error) {
        assert.deepEqual(pi.pi.getActiveTools(), activeToolsBeforeFailure);
        throw error;
      }
    }
    setActiveTools(next);
  };

  await start(undefined, context);

  assert.equal(
    chiefTools.some((name) => pi.pi.getActiveTools().includes(name)),
    false,
  );
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("lead session-start restoration failed"),
    ),
  );
  await start(undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), [...baseline]);
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
      sessionId: LEAD_SESSION_ID,
      role: "lead",
      leadTools: [
        "read",
        "bash",
        "list_agents",
        "delegate_agent",
        "continue_agent",
        "steer_agent",
        "interrupt_agent",
        "reply_agent",
        "close_agent",
        "inspect_agent",
        "read_agent_transcript",
        "message_supervisor",
        "list_peers",
        "message_peer",
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
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
    "message_supervisor",
    "list_peers",
    "message_peer",
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

test("Chief activation preserves access to previously owned work", async () => {
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
  assert.ok(
    !notices.some((message) => /owned agent work exists/.test(message)),
  );
  realFs.rmSync(mailbox, { recursive: true, force: true });
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("Herdsman and agents share command handling and grammar", async () => {
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
  const herdsman = pi.commandOptions.get("herdsman");
  const lead = pi.commandOptions.get("lead");
  assert.ok(herdsman);
  assert.ok(lead);
  assert.deepEqual(lead.getArgumentCompletions(""), [
    { value: "flexible", label: "flexible" },
    { value: "orchestrate", label: "orchestrate" },
  ]);
  assert.equal(command.description, "Alias for /herdsman");
  assert.equal(herdsman.description, "Open Pi Herdsman");
  assert.equal(command.handler, herdsman.handler);
  assert.equal(command.getArgumentCompletions, herdsman.getArgumentCompletions);
  assert.deepEqual(herdsman.getArgumentCompletions(""), [
    { value: "stats", label: "stats" },
    { value: "definitions", label: "definitions" },
    { value: "placement", label: "placement" },
    { value: "stop", label: "stop" },
  ]);
  assert.deepEqual(herdsman.getArgumentCompletions("placement "), [
    { value: "placement tab", label: "tab" },
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  assert.deepEqual(herdsman.getArgumentCompletions("placement s"), [
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
  await herdsman.handler("placement invalid", context);
  await herdsman.handler("anything", context);
  assert.deepEqual(notices, [
    "Usage: /herdsman [stats | definitions | placement [tab|subtree|split] | stop]",
    "Usage: /herdsman placement [tab|subtree|split]",
    "Usage: /herdsman [stats | definitions | placement [tab|subtree|split] | stop]",
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

test("Chief profile drives the turn-start tools, prompt, and tool-call guard", async (t) => {
  setLeadEnvironment();
  const overridePath = join(PI_AGENTS_DIR, "chief.md");
  const previousOverride = realFs.existsSync(overridePath)
    ? readFileSync(overridePath, "utf8")
    : undefined;
  const previousEnvironment = new Map(
    [
      "HERDR_PANE_ID",
      "HERDR_TAB_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_SOCKET_PATH",
    ].map((key) => [key, process.env[key]]),
  );
  writeFileSync(
    overridePath,
    "---\nname: chief\ntools: [read]\n---\nConfigured chief body",
  );
  process.env.HERDR_PANE_ID = "chief-profile-pane";
  process.env.HERDR_TAB_ID = "chief-profile-tab";
  process.env.HERDR_WORKSPACE_ID = "chief-profile-workspace";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-profile-${randomUUID()}.sock`,
  );
  const ownerMailbox = agentMailboxPath(WORKSPACE, "chief-owned-agent");
  resetAgentMailbox(ownerMailbox);
  try {
    const pi = fakeChiefPi({ activeTools: ["read"] });
    const ctx = fakeContext() as any;
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, ctx);
    writeAgentState(ownerMailbox, {
      ...managedState("chief-owned-agent"),
      ownerSessionId: ctx.sessionManager.getSessionId(),
    });
    await pi.commandOptions.get("chief").handler("", ctx);
    const event = {
      systemPrompt: "base",
      systemPromptOptions: { contextFiles: [] },
    };
    const prompt = await pi.events.get("before_agent_start")![0](event, ctx);
    assert.match(
      prompt?.systemPrompt ?? "",
      /verified workspace-neutral Chief/,
    );
    assert.match(
      prompt?.systemPrompt ?? "",
      /Each unresolved unit of work has one executor/,
    );
    assert.match(
      prompt?.systemPrompt ?? "",
      /A proven lost Agent remains unresolved/,
    );
    assert.match(prompt?.systemPrompt ?? "", /Configured chief body/);
    assert.ok(pi.pi.getActiveTools().includes("read"));
    assert.ok(pi.pi.getActiveTools().includes("list_staff"));
    for (const name of ["list_agents", "reply_agent", "close_agent"])
      assert.ok(pi.pi.getActiveTools().includes(name), name);
    for (const name of ["message_supervisor", "list_peers", "message_peer"])
      assert.ok(!pi.pi.getActiveTools().includes(name), name);
    assert.ok(!pi.pi.getActiveTools().includes("delegate_work"));
    assert.equal(
      await pi.events.get("tool_call")![0](
        { toolName: "read", input: {} },
        ctx,
      ),
      undefined,
    );
    assert.deepEqual(
      await pi.events.get("tool_call")![0](
        { toolName: "delegate_work", input: {} },
        ctx,
      ),
      {
        block: true,
        reason: "Tool is unavailable in the active Chief profile.",
      },
    );
    assert.deepEqual(
      await pi.events.get("tool_call")![0](
        { toolName: "bash", input: {} },
        ctx,
      ),
      {
        block: true,
        reason: "Tool is unavailable in the active Chief profile.",
      },
    );
    for (const name of ["message_supervisor", "list_peers", "message_peer"])
      assert.deepEqual(
        await pi.events.get("tool_call")![0](
          { toolName: name, input: {} },
          ctx,
        ),
        {
          block: true,
          reason: "Tool is unavailable in the active Chief profile.",
        },
      );
    resetAgentMailbox(ownerMailbox);
    await pi.events.get("session_shutdown")?.[0](undefined, ctx);
  } finally {
    resetAgentMailbox(ownerMailbox);
    if (previousOverride === undefined) rmSync(overridePath, { force: true });
    else writeFileSync(overridePath, previousOverride);
    for (const [key, value] of previousEnvironment)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("root assignment rejects a role generation changed during preflight", async () => {
  setLeadEnvironment();
  const previousEnvironment = new Map(
    [
      "HERDR_PANE_ID",
      "HERDR_TAB_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_SOCKET_PATH",
    ].map((key) => [key, process.env[key]]),
  );
  const chiefPath = join(PI_AGENTS_DIR, "chief.md");
  const previousChief = realFs.existsSync(chiefPath)
    ? readFileSync(chiefPath, "utf8")
    : undefined;
  writeFileSync(chiefPath, "---\nname: chief\nagents: []\n---\n");
  process.env.HERDR_PANE_ID = "role-race-pane";
  process.env.HERDR_TAB_ID = "role-race-tab";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `role-race-${randomUUID()}.sock`,
  );

  let enteredPreflight!: () => void;
  let releasePreflight!: () => void;
  const preflightEntered = new Promise<void>(
    (resolve) => (enteredPreflight = resolve),
  );
  const preflightRelease = new Promise<void>(
    (resolve) => (releasePreflight = resolve),
  );
  let held = false;
  let assignmentStarted = false;
  const pi = fakeChiefPi({
    exec: async (command, args) => {
      if (command === "herdr" && assignmentStarted && !held) {
        held = true;
        enteredPreflight();
        await preflightRelease;
        return undefined;
      }
      return undefined;
    },
  });
  const context = fakeContext() as any;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const sessionId = context.sessionManager.getSessionId();
    assignmentStarted = true;
    const pending = pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "role-race",
        { definition: "agent", task: "must not launch" },
        undefined,
        undefined,
        context,
      );
    await preflightEntered;
    await pi.commandOptions.get("chief").handler("", context);
    assert.equal(context.sessionManager.getSessionId(), sessionId);
    releasePreflight();
    const result = await pending;
    assert.equal(
      result.details.error.category,
      "invalid_request",
      JSON.stringify(result.details),
    );
    assert.match(result.details.error.message, /role or authority changed/i);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    releasePreflight();
    await pi.events.get("session_shutdown")?.[0](undefined, context);
    if (previousChief === undefined) rmSync(chiefPath, { force: true });
    else writeFileSync(chiefPath, previousChief);
    for (const [key, value] of previousEnvironment)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("root assignment rechecks changed authority after Agent startup and rolls back", async () => {
  setLeadEnvironment();
  const previousEnvironment = new Map(
    [
      "HERDR_PANE_ID",
      "HERDR_TAB_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_SOCKET_PATH",
    ].map((key) => [key, process.env[key]]),
  );
  const chiefPath = join(PI_AGENTS_DIR, "chief.md");
  const previousChief = realFs.existsSync(chiefPath)
    ? readFileSync(chiefPath, "utf8")
    : undefined;
  writeFileSync(chiefPath, "---\nname: chief\nagents: []\n---\n");
  process.env.HERDR_PANE_ID = "role-start-race-pane";
  process.env.HERDR_TAB_ID = "role-start-race-tab";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `role-start-race-${randomUUID()}.sock`,
  );

  const label = `role-start-race-${randomUUID().slice(0, 8)}`;
  let taskAccepted = false;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    () => {
      taskAccepted = true;
    },
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  let enteredStart!: () => void;
  let releaseStart!: () => void;
  const startEntered = new Promise<void>((resolve) => (enteredStart = resolve));
  const startRelease = new Promise<void>((resolve) => (releaseStart = resolve));
  let paused = false;
  let started = false;
  let stopped = false;
  const pi = fakeChiefPi({
    exec: async (command, args, options) => {
      if (command === "herdr" && isPreservePaneStop(args)) stopped = true;
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              process_info: {
                pane_id: "startup-pane",
                shell_pid: 123,
                foreground_process_group_id: started && !stopped ? 999 : 123,
                foreground_processes:
                  started && !stopped
                    ? [
                        { pid: 123, argv0: "/bin/zsh" },
                        { pid: 999, argv0: "/usr/local/bin/pi" },
                      ]
                    : [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      const result = await startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        started = true;
        paused = true;
        enteredStart();
        await startRelease;
      }
      return result;
    },
  });
  const context = fakeContext() as any;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const pending = pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "role-start-race",
        { definition: "agent", label, task: "must not be published" },
        undefined,
        undefined,
        context,
      );
    await startEntered;
    assert.equal(paused, true);
    await pi.commandOptions.get("chief").handler("", context);
    releaseStart();

    const result = await pending;
    assert.equal(
      result.details.error.category,
      "invalid_request",
      JSON.stringify(result.details.error),
    );
    assert.match(result.details.error.message, /role or authority changed/i);
    assert.equal(taskAccepted, false);
    assert.equal(
      stopped,
      true,
      "the unauthorized started Agent must be stopped",
    );
    assert.equal(
      readAgentState(agentMailboxPath(WORKSPACE, label)),
      undefined,
      "rollback must leave no unresolved live Agent generation",
    );
    assert.equal(
      realFs.existsSync(startup.mailbox) &&
        realFs
          .readdirSync(startup.mailbox)
          .some((entry) => entry.startsWith("request-")),
      false,
      "no task request may remain committed",
    );
  } finally {
    releaseStart();
    startup.stopMailboxConsumer();
    await pi.events.get("session_shutdown")?.[0](undefined, context);
    resetAgentMailbox(startup.mailbox);
    if (previousChief === undefined) rmSync(chiefPath, { force: true });
    else writeFileSync(chiefPath, previousChief);
    for (const [key, value] of previousEnvironment)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("Chief activation replaces the lead widget and overview selection is interactive", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = `chief-tab-${randomUUID()}`;
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
            result: {
              snapshot: { agents: leads, panes: leads, workspaces: [] },
            },
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
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
  assert.equal(pi.pi.getActiveTools().includes("read_evidence"), false);
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
  const overviewLines = overview.render(120);
  assert.match(overviewLines[1], /^ Pi Herdsman/u);
  assert.equal(overviewLines[2].trim(), "");
  const overviewFooter = overviewLines.findIndex((line: string) =>
    line.includes("Space peek"),
  );
  assert.equal(overviewLines[overviewFooter - 1].trim(), "");
  assert.match(overviewLines[overviewFooter], /^ Space peek/u);
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

test("Manager direct reports preserve assigned Leads when ordinary supervision is ambiguous", async (t) => {
  const { createLeadSupervisionRuntime } = await import("./lead-runtime.ts");
  const root = mkdtempSync(join(tmpdir(), "manager-reports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(other, ".git"), { recursive: true });
  const manager = { repoKey: join(repo, ".git"), workspaceId: "manager" };
  const leads = ["same", "ordinary", "other", "missing", "changed"].map(
    (id) => ({
      lead: id,
      workspaceId: id,
      paneId: id,
      tabId: id,
    }),
  );
  const calls = new Map<string, number>();
  let abort: AbortController | undefined;
  const runtime = createLeadSupervisionRuntime({
    activeRole: () => "manager",
    state: { managerLease: { descriptor: manager } },
    currentManager: async () => manager,
    sameManagerDescriptor: (left: any, right: any) =>
      left.workspaceId === right.workspaceId,
    worktreeGroupScope: async () => ({ workspaceIds: ["manager"] }),
    herdrSessionSnapshot: async () => ({ agents: [], workspaces: [] }),
    managedAgentSnapshots: async () => ({ agents: [] }),
    workspacePresentationProvenance: async () => ({}),
    projectSupervision: () => ({ leads }),
    listManagerDescriptors: () => [
      manager,
      { ...manager, workspaceId: "manager-two" },
    ],
    currentChief: () => undefined,
    supervisionRuntime: () => ({}),
    listProjectAssignments: () => [{ id: "same" }],
    remoteChiefAgent: async (_ctx: unknown, descriptor: any) => {
      if (abort) {
        abort.abort(new Error("verification cancelled"));
        throw abort.signal.reason;
      }
      const id = descriptor.piSessionId;
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === "missing") return undefined;
      return {
        cwd:
          id === "other" || (id === "changed" && calls.get(id)! > 1)
            ? other
            : repo,
      };
    },
    pi: {
      exec: async (command: string, args: string[], options: any) => {
        const cwd = options.cwd;
        if (command === "git")
          return {
            code: 0,
            stdout: args.includes("--show-toplevel") ? cwd : join(cwd, ".git"),
            stderr: "",
          };
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result:
              args[0] === "workspace"
                ? { workspace: { workspace_id: args[2] } }
                : {
                    source: { repo_key: join(cwd, ".git"), repo_name: "repo" },
                    worktrees: [],
                  },
          }),
        };
      },
    },
  } as any);
  const reports = await runtime.directReports(fakeContext() as any);
  assert.deepEqual(
    reports.map((lead: any) => [lead.lead, lead.relationship]),
    [["same", "assigned"]],
  );
  abort = new AbortController();
  await assert.rejects(
    runtime.directReports({ ...fakeContext(), signal: abort.signal } as any),
    /verification cancelled/,
  );
});

test("supervision clicks verify standalone Manager Leads with fresh evidence despite stale cached status", async () => {
  const { createLeadSupervisionRuntime } = await import("./lead-runtime.ts");
  const { managerSupervisionItems, supervisionPresentationReports } =
    await import("./presentation.ts");
  const leadId = "standalone-click-lead";
  const paneId = "standalone-click-pane";
  const assignedLeadId = "assigned-click-lead";
  const assignedPaneId = "assigned-click-pane";
  const managerId = "click-manager-session";
  const managerPaneId = "click-manager-pane";
  let currentRole: "manager" | "chief" = "manager";
  let currentSnapshot: any = {
    project: "project",
    work: [
      {
        branch: "feat/assigned",
        session: assignedLeadId,
        status: "active" as const,
      },
    ],
    leads: [
      {
        lead: assignedLeadId,
        displayName: "assigned",
        branch: "feat/assigned",
        runtimeState: "working" as const,
        paneId: assignedPaneId,
        tabId: "tab",
        workspaceId: WORKSPACE,
        availableActions: [],
      },
      {
        lead: leadId,
        displayName: "standalone",
        branch: "feat/standalone",
        runtimeState: "working" as const,
        paneId,
        tabId: "tab",
        workspaceId: WORKSPACE,
        availableActions: [],
      },
    ],
  };
  const focused: string[] = [];
  let mismatch = false;
  let deferNextLookup = false;
  let loadCount = 0;
  let markFocusLookupStarted!: () => void;
  const focusLookupStarted = new Promise<void>(
    (resolve) => (markFocusLookupStarted = resolve),
  );
  let resolveFocusLookup!: (value: typeof currentSnapshot) => void;
  let runtime: ReturnType<typeof createLeadSupervisionRuntime>;
  const currentState = {
    chiefMode: "inactive" as "inactive" | "active",
    controllerRole: "manager" as const,
    roleSuspended: false,
    managerLease: undefined,
    chiefLease: undefined,
    leadContext: undefined,
    chiefModeGeneration: 0,
    sessionGeneration: 0,
    chiefActivationRollback: false,
    instanceId: "test",
  };
  const host: any = {
    activeRole: () => currentRole,
    state: currentState,
    pi: {},
    isCurrentChief: () => currentRole === "chief",
    herdrSessionSnapshot: async () => ({ agents: [] }),
    managedAgentSnapshots: async () => ({ agents: [] }),
    loadSnapshot: async () => {
      loadCount++;
      if (loadCount === 2 || deferNextLookup) {
        deferNextLookup = false;
        markFocusLookupStarted();
        return await new Promise<typeof currentSnapshot>(
          (resolve) => (resolveFocusLookup = resolve),
        );
      }
      if (loadCount === 3) throw new Error("transient refresh failure");
      return currentSnapshot;
    },
    managerSupervisionItems,
    presentationReports: supervisionPresentationReports,
    listManagerDescriptors: () =>
      currentRole === "chief"
        ? [
            {
              piSessionId: managerId,
              paneId: managerPaneId,
              tabId: "manager-tab",
              workspaceId: WORKSPACE,
            },
          ]
        : [],
    sameManagerDescriptor: (left: any, right: any) =>
      left.piSessionId === right.piSessionId && left.paneId === right.paneId,
    supervisionRuntime: () => ({}),
    readLeadCoordinationState: (_runtime: unknown, id: string) =>
      [leadId, assignedLeadId].includes(id) ? { piSessionId: id } : undefined,
    listAllHerdrAgents: async () => ({
      agents: [
        {
          sessionId: managerId,
          pane_id: managerPaneId,
          tab_id: "manager-tab",
          workspace_id: WORKSPACE,
        },
        {
          sessionId: assignedLeadId,
          pane_id: assignedPaneId,
          tab_id: "tab",
          workspace_id: WORKSPACE,
        },
        {
          sessionId: leadId,
          pane_id: paneId,
          tab_id: "tab",
          workspace_id: WORKSPACE,
        },
      ],
    }),
    isPiAgent: () => true,
    herdrSessionId: (agent: any) => agent.sessionId,
    runHerdr: async (_pi: unknown, _ctx: unknown, args: string[]) => {
      if (args[0] === "agent" && args[1] === "get") {
        const agent = [
          [managerPaneId, managerId, "manager-tab"],
          [assignedPaneId, assignedLeadId, "tab"],
          [paneId, leadId, "tab"],
        ].find(([pane]) => pane === args[2]);
        return {
          agent: {
            sessionId: mismatch ? "replacement-session" : agent?.[1],
            pane_id: args[2],
            tab_id: agent?.[2],
            workspace_id: WORKSPACE,
          },
        };
      }
      if (args[0] === "agent" && args[1] === "focus") focused.push(args[2]!);
      return {};
    },
  };
  runtime = createLeadSupervisionRuntime(host);
  let widget: any;
  const focusNotices: string[] = [];
  const ctx = fakeContext() as any;
  ctx.mode = "tui";
  ctx.hasUI = true;
  ctx.ui = {
    ...ctx.ui,
    notify: (message: string) => focusNotices.push(message),
    setWidget: (_key: string, content: any) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          { fg: (_color: string, text: string) => text },
        );
    },
  };
  runtime.registerWidget(ctx, "manager");
  runtime.startPeriodic(ctx);
  await runtime.refresh(ctx);
  assert.match(widget.render(120).join("\n"), /feat\/standalone · Lead/);
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 2, width: 120 });
  await focusLookupStarted;
  await runtime.refresh(ctx);
  resolveFocusLookup(currentSnapshot);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, [paneId]);
  await runtime.refresh(ctx);
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 1, width: 120 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, [paneId, assignedPaneId]);
  await runtime.refresh(ctx);
  mismatch = true;
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 1, width: 120 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, [paneId, assignedPaneId]);
  await runtime.refresh(ctx);
  mismatch = false;
  deferNextLookup = true;
  const replacementLookupStarted = new Promise<void>((resolve) => {
    markFocusLookupStarted = resolve;
  });
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 1, width: 120 });
  await replacementLookupStarted;
  currentState.sessionGeneration++;
  resolveFocusLookup(currentSnapshot);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    focused,
    [paneId, assignedPaneId],
    "generation replacement during fresh lookup must not focus",
  );

  currentRole = "chief";
  currentState.chiefMode = "active";
  currentState.sessionGeneration++;
  currentSnapshot = {
    managers: [
      {
        session: managerId,
        displayName: "project-manager",
        project: "project",
        workspaceId: WORKSPACE,
        paneId: managerPaneId,
        tabId: "manager-tab",
        runtimeState: "working",
        agentCounts: { active: 0, blocked: 0, total: 0 },
        leadCounts: { active: 0, blocked: 0, total: 1 },
        availableActions: ["inspect"],
        leads: [
          {
            session: leadId,
            displayName: "nested-lead",
            branch: "feat/nested",
            runtimeState: "working",
            agentCounts: { active: 0, blocked: 0, total: 0 },
          },
        ],
      },
    ],
    leads: [],
  };
  runtime.registerWidget(ctx, "chief");
  await runtime.refresh(ctx);
  assert.deepEqual(widget.render(120), [
    "● chief · 1 manager",
    "└─ ● project-manager · 1 compatible lead",
    "   └─ feat/nested · ● working",
  ]);
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 1, width: 120 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 2, width: 120 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    focused,
    [paneId, assignedPaneId, managerPaneId, paneId],
    focusNotices.join(" | "),
  );
  currentSnapshot.managers[0].leads[0].compatibility = "incompatible";
  widget.handleMouse({ type: "click", button: "left", x: 5, y: 2, width: 120 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    focused,
    [paneId, assignedPaneId, managerPaneId, paneId],
    "a stale clickable nested Lead row must not focus after fresh discovery finds a build mismatch",
  );
  assert.equal(currentRole, "chief", "nested navigation remains observational");
  runtime.stopPeriodic();
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
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
    "message_supervisor",
    "list_peers",
    "message_peer",
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
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
  ]);

  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "read",
    "bash",
    ...ordinaryTools.filter((name) => !["read", "bash"].includes(name)),
  ]);
  const role = entries
    .filter((entry: any) => entry.customType === "pi-herdsman-role")
    .at(-1) as any;
  assert.deepEqual(role.data, {
    sessionId: LEAD_SESSION_ID,
    role: "lead",
    leadTools: ["read", "bash"],
  });

  const reloaded = fakeChiefPi({
    activeTools: [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
    ],
    entries: [...entries],
  });
  const reloadedContext = fakeContext(reloaded.entries) as any;
  reloadedContext.mode = "rpc";
  reloadedContext.ui.notify = () => undefined;
  registerExtension!(reloaded.pi as never);
  await reloaded.events.get("session_start")![0](undefined, reloadedContext);
  assert.deepEqual(reloaded.pi.getActiveTools(), [
    "read",
    "bash",
    ...ordinaryTools.filter((name) => !["read", "bash"].includes(name)),
  ]);

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
        sessionId: LEAD_SESSION_ID,
        role: "lead",
        leadTools: [
          "read",
          "bash",
          "list_agents",
          "delegate_agent",
          "continue_agent",
          "steer_agent",
          "interrupt_agent",
          "reply_agent",
          "close_agent",
          "inspect_agent",
          "read_agent_transcript",
          "message_supervisor",
          "list_peers",
          "message_peer",
        ],
      },
    },
  ];
  const branchTools = [
    "read",
    "grep",
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
    "message_supervisor",
    "list_peers",
    "message_peer",
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
    incompatibleBuild?: { version: string; sha256: string };
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
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [],
            },
          }),
          stderr: "",
          code: 0,
        };
      return isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: { agents, panes: agents, workspaces: [] },
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
      ...(options.incompatibleBuild
        ? { build: options.incompatibleBuild }
        : {}),
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

test("Chief overview renders incompatible staff without counts or selection actions", async () => {
  const harness = await openChiefOverview(true, {
    incompatibleBuild: { version: "older", sha256: "a".repeat(64) },
  });
  try {
    const output = harness.component.render(120).join("\n");
    assert.match(output, /1 herd/);
    assert.match(output, /build mismatch/);
    assert.doesNotMatch(output, /0 agents/);
    harness.component.handleInput(" ");
    harness.component.handleInput("\r");
    assert.equal(harness.doneCalls, 0);
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
              result: {
                agents: [],
                snapshot: { agents: [], panes: [], workspaces: [] },
              },
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
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: [
          "read",
          "bash",
          "foreign_tool",
          "list_agents",
          "delegate_agent",
          "continue_agent",
          "steer_agent",
          "interrupt_agent",
          "reply_agent",
          "close_agent",
          "inspect_agent",
          "read_agent_transcript",
          "message_supervisor",
          "list_peers",
          "message_peer",
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
              result: {
                agents: [],
                snapshot: { agents: [], panes: [], workspaces: [] },
              },
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
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
  ]);
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "read",
    "bash",
    "foreign_tool",
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
    "message_supervisor",
    "list_peers",
    "message_peer",
  ]);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  setLeadEnvironment();
});

test("persisted chief collision is suspended and has no lead authority", async () => {
  setLeadEnvironment();
  const chiefOverride = join(PI_AGENTS_DIR, "chief.md");
  const scoutDefinition = join(PI_AGENTS_DIR, "scout.md");
  const outsideDefinition = join(PI_AGENTS_DIR, "generalist.md");
  const previousChiefOverride = realFs.existsSync(chiefOverride)
    ? readFileSync(chiefOverride, "utf8")
    : undefined;
  writeFileSync(
    chiefOverride,
    "---\nname: chief\ntools: [read]\nagents: [scout]\n---\n",
  );
  writeFileSync(scoutDefinition, "---\nname: scout\n---\nscout\n");
  writeFileSync(outsideDefinition, "---\nname: generalist\n---\ngeneralist\n");
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
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: [
          "list_agents",
          "delegate_agent",
          "continue_agent",
          "steer_agent",
          "interrupt_agent",
          "reply_agent",
          "close_agent",
          "inspect_agent",
          "read_agent_transcript",
          "message_supervisor",
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
  const ownedMailbox = agentMailboxPath(
    WORKSPACE,
    "suspended-chief-owned-agent",
  );
  resetAgentMailbox(ownedMailbox);
  try {
    const pi = fakeChiefPi({
      entries,
      activeTools: [
        "list_agents",
        "delegate_agent",
        "continue_agent",
        "steer_agent",
        "interrupt_agent",
        "reply_agent",
        "close_agent",
        "inspect_agent",
        "read_agent_transcript",
        "message_supervisor",
      ],
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext(entries) as any;
    writeAgentState(ownedMailbox, {
      ...managedState("suspended-chief-owned-agent"),
      ownerSessionId: context.sessionManager.getSessionId(),
    });
    context.ui.notify = () => undefined;
    await pi.events.get("session_start")![0](undefined, context);
    for (const name of ["list_agents", "reply_agent", "close_agent"])
      assert.ok(pi.pi.getActiveTools().includes(name), name);
    assert.ok(!pi.pi.getActiveTools().includes("delegate_agent"));
    assert.ok(!pi.pi.getActiveTools().includes("continue_agent"));
    const denied = await agentTool(pi, "delegate").execute(
      "suspended-chief",
      { definition: "agent", task: "must not start" },
      undefined,
      undefined,
      context,
    );
    assert.equal(denied.details.error.category, "invalid_request");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
    assert.equal(
      readLeadCoordinationState(
        supervisionRuntime(),
        context.sessionManager.getSessionId(),
      ),
      undefined,
    );

    // Removing the verified incumbent allows normal startup to restore the
    // persisted Chief role against the current profile and delegation policy.
    incumbent.release();
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(
      sessionLeadRoleState(context.sessionManager.getEntries())?.role,
      "chief",
    );
    for (const name of chiefTools)
      assert.ok(pi.pi.getActiveTools().includes(name));
    assert.ok(pi.pi.getActiveTools().includes("read"));
    for (const name of ["list_agents", "reply_agent", "close_agent"])
      assert.ok(pi.pi.getActiveTools().includes(name), name);
    for (const name of ["message_supervisor", "list_peers", "message_peer"])
      assert.ok(!pi.pi.getActiveTools().includes(name), name);
    assert.ok(pi.pi.getActiveTools().includes("delegate_agent"));
    const restoredAssignment = await agentTool(pi, "delegate").execute(
      "restored-chief-current-policy",
      { definition: "scout", task: "exercise the restored current profile" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      restoredAssignment.details.error.category,
      "internal_failure",
      "the allowed assignment reaches Herdr; the fixture stops at tab creation",
    );
    assert.equal(
      restoredAssignment.details.error.operation,
      "herdr tab create",
    );
    assert.ok(
      pi.calls.some((args) => args[0] === "tab" && args[1] === "create"),
      "agents: [scout] allows the fresh assignment past authorization",
    );
    const tabCreatesBeforeDenied = pi.calls.filter(
      (args) => args[0] === "tab" && args[1] === "create",
    ).length;
    const outsideAllowlist = await agentTool(pi, "delegate").execute(
      "restored-chief-outside-allowlist",
      { definition: "generalist", task: "outside the restored allowlist" },
      undefined,
      undefined,
      context,
    );
    assert.equal(outsideAllowlist.details.error.category, "invalid_request");
    assert.match(outsideAllowlist.details.error.message, /is not allowed/);
    assert.equal(
      pi.calls.filter((args) => args[0] === "tab" && args[1] === "create")
        .length,
      tabCreatesBeforeDenied,
      "agents: [scout] denies another valid definition before Herdr launch",
    );
    await pi.events.get("session_shutdown")?.[0]();
  } finally {
    incumbent.release();
    resetAgentMailbox(ownedMailbox);
    if (previousChiefOverride === undefined)
      rmSync(chiefOverride, { force: true });
    else writeFileSync(chiefOverride, previousChiefOverride);
    rmSync(scoutDefinition, { force: true });
    rmSync(outsideDefinition, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Herdsman menu opens the progressive discovery menu", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("herdsman");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.isProjectTrusted = () => false;
  context.hasUI = true;
  context.mode = "rpc";
  context.isProjectTrusted = () => false;
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1)
      return options.find((option) => option === "Settings");
    if (prompts.length === 3)
      return options.find((option) => option === "Settings");
    return undefined;
  };
  await command.handler("", context);
  await pi.commandOptions.get("agents").handler("", context);
  assert.equal(prompts[0]?.label, `Pi Herdsman · v${packageMetadata.version}`);
  assert.deepEqual(prompts[0]?.options, [
    "Execution  flexible",
    "Agents",
    "Project manager",
    "Session stats",
    "Definitions",
    "Settings",
    "Advanced…",
  ]);
  assert.equal(prompts[1]?.label, "Settings");
  assert.deepEqual(prompts[1]?.options, [
    "Default Lead execution  flexible",
    "Manager auto-start  Global off · Effective off (global; untrusted project)",
    "Skip Manager Git setup confirmation  Global off",
    "Context retirement  Global on · Effective on (global; untrusted project)",
    "Manager local merge  Global off",
    "Message limits",
    "Project overrides…",
  ]);
  assert.equal(prompts[2]?.label, prompts[0]?.label);
  assert.deepEqual(prompts[2]?.options, prompts[0]?.options);
  assert.equal(prompts[3]?.label, "Settings");
  await pi.events.get("session_shutdown")?.[0]();
});

test("Herdsman root renders when status and definition metadata fail", async () => {
  const { createLeadCommandRuntime } = await import("./lead-runtime.ts");
  let rootLabels: string[] = [];
  const notices: string[] = [];
  const runtime = createLeadCommandRuntime({
    version: packageMetadata.version,
    loadStatusSnapshot: async () => {
      throw new Error("status unavailable");
    },
    contextAgentDefinitions: async () => {
      throw new Error("definitions unavailable");
    },
    leadExecutionPresentation: () => ({ managed: false, mode: "flexible" }),
    roleActive: () => false,
    selectMenu: async (_ctx: unknown, _title: string, items: any[]) => {
      rootLabels = items.map(({ label }) => label);
      return undefined;
    },
  } as any);
  await runtime.runHerdsmanCommand("", {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as any);
  assert.deepEqual(rootLabels, [
    "Execution",
    "Agents",
    "Project manager",
    "Session stats",
    "Definitions",
    "Settings",
    "Advanced…",
  ]);
  assert.deepEqual(notices, []);
});

test("Herdsman Agents row opens the focused Running, Layout, Stop all menu", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const menus: { label: string; options: string[] }[] = [];
  let openedAgents = false;
  context.ui.select = async (label: string, options: string[]) => {
    menus.push({ label, options });
    if (label.startsWith("Pi Herdsman") && !openedAgents) {
      openedAgents = true;
      return "Agents";
    }
    return undefined;
  };
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    const menu = menus.find(({ label }) => label === "Agents");
    assert.deepEqual(
      menu?.options.map((option) => option.replace(/\s{2,}.*/u, "")),
      ["Running", "Layout", "Stop all…"],
    );
    assert.equal(menu?.options[0], "Running  0");
    assert.equal(menu?.options[1], "Layout  subtree");
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Herdsman role menus dispatch through the shared role transition", async () => {
  const { createLeadCommandRuntime } = await import("./lead-runtime.ts");
  for (const role of ["manager", "chief"] as const) {
    for (const scenario of [
      {
        active: false,
        action: "start",
        labels: [`Start ${role === "manager" ? "Manager" : "Chief"} mode`],
      },
      {
        active: true,
        action: "overview",
        labels: [
          "Overview",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
      {
        active: true,
        action: "leave",
        labels: [
          "Overview",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
    ]) {
      const dispatched: [string, boolean][] = [];
      const menus: { title: string; labels: string[] }[] = [];
      const overviews: string[] = [];
      let rootSelection = true;
      const host = {
        version: packageMetadata.version,
        leadExecutionPresentation: () => ({
          managed: false,
          mode: "flexible",
        }),
        roleActive: (selectedRole: string) =>
          selectedRole === role && scenario.active,
        transitionRole: async (selectedRole: string, leave: boolean) => {
          dispatched.push([selectedRole, leave]);
          return "transition requested";
        },
        openSupervisionOverview: async () => {
          overviews.push(role);
        },
        selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
          menus.push({ title, labels: items.map(({ label }) => label) });
          if (title.startsWith("Pi Herdsman")) {
            if (!rootSelection) return undefined;
            rootSelection = false;
            return role === "manager" ? "manager" : "advanced";
          }
          if (title === "Advanced") return "chief";
          return scenario.action;
        },
      } as any;
      const runtime = createLeadCommandRuntime(host);
      const notices: string[] = [];
      await runtime.runHerdsmanCommand("", {
        hasUI: true,
        ui: { notify: (message: string) => notices.push(message) },
      } as any);
      const title = role === "manager" ? "Project manager" : "Chief mode";
      assert.ok(
        menus.some(
          (menu) =>
            menu.title === title &&
            scenario.labels.every((label) => menu.labels.includes(label)),
        ),
      );
      assert.deepEqual(
        dispatched,
        scenario.action === "start"
          ? [[role, false]]
          : scenario.action === "leave"
            ? [[role, true]]
            : [[role, false]],
      );
      assert.deepEqual(overviews, scenario.action === "overview" ? [role] : []);
      assert.deepEqual(notices, ["transition requested"]);
    }
  }
});

test("Herdsman TUI selectors use stable values and current preselection", async () => {
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
          component.handleInput("\r");
          break;
        case 1:
          component.handleInput("\u001b[B");
          renders.push(component.render(200));
          component.handleInput("\u001b");
          break;
        case 2:
          component.handleInput("\u001b");
          break;
      }
    });
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.ok(
      renders[0]?.some((line) =>
        line.includes(`Pi Herdsman · v${packageMetadata.version}`),
      ),
    );
    for (const lines of renders) {
      assert.equal(lines[2].trim(), "");
      const footer = lines.findIndex((line) => line.includes("↑↓ navigate"));
      assert.equal(lines[footer - 1].trim(), "");
    }
    // Execution has no help region: exactly one blank row after its last option.
    const executionFooter = renders[1].findIndex((line) =>
      line.includes("↑↓ navigate"),
    );
    assert.match(renders[1][executionFooter - 2], /orchestrate/u);
    assert.ok(renders[1]?.some((line) => /^→ flexible\s+current/u.test(line)));
    assert.ok(renders[2]?.some((line) => /^→ orchestrate/u.test(line)));
    assert.ok(
      renders[3]?.some((line) => /^→ Execution\s+flexible/u.test(line)),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Herdsman root contextual help follows the selected row", async () => {
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
      for (let i = 0; i < 6; i++) {
        component.handleInput("\u001b[B");
        observed.push(snapshot());
      }
      component.handleInput("\u001b");
    });
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    const footerRows = observed.map((lines) =>
      lines.findIndex((line) => line.includes("↑↓ navigate")),
    );
    assert.ok(footerRows.every((row) => row === footerRows[0]));
    for (const lines of observed) {
      assert.equal(lines[2].trim(), "");
      const footer = lines.findIndex((line) => line.includes("↑↓ navigate"));
      assert.equal(lines[footer - 1].trim(), "");
      assert.equal(lines[footer - 3].trim(), "");
    }
    const help = (index: number) =>
      observed[index]?.find((line) =>
        /Choose whether this session works directly|View and manage background Agents|Coordinate independent project work|View token usage and model costs|Inspect available Agents/u.test(
          line,
        ),
      ) ?? "";
    assert.match(
      help(0),
      /Choose whether this session works directly or primarily delegates tasks\./u,
    );
    assert.match(help(1), /View and manage background Agents\./u);
    assert.match(
      help(2),
      /Coordinate independent project work across Git branches\./u,
    );
    assert.match(
      help(3),
      /View token usage and model costs for this session and its managed work\./u,
    );
    assert.match(
      help(4),
      /Inspect available Agents and their configuration\./u,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions contextual help uses the selected definition description", async () => {
  setLeadEnvironment();
  const noHelpPath = join(PI_AGENTS_DIR, "aaa-no-help.md");
  realFs.writeFileSync(noHelpPath, "---\nname: aaa-no-help\n---\n");
  const selectedName = "generalist";
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const { contextAgentDefinitions } = await import("./agent-definitions.ts");
  const definitions = await contextAgentDefinitions(context);
  const expectedHelp = definitions.definitions.find(
    ({ name }) => name === selectedName,
  )?.frontmatter.description;
  assert.equal(typeof expectedHelp, "string");

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
        for (let attempts = 0; attempts < 20; attempts++) {
          const selected = component
            .render(200)
            .find((line: string) => line.trimStart().startsWith("→"));
          if (selected?.includes("Definitions")) {
            component.handleInput("\r");
            return;
          }
          component.handleInput("\u001b[B");
        }
        throw new Error("TUI item was not selected: Definitions");
      }
      if (call === 1) {
        selectTuiItem(component, "Agent definitions");
        return;
      }
      if (call > 2) {
        component.handleInput("\u001b");
        return;
      }
      for (let attempts = 0; attempts < 100; attempts++) {
        const rendered = component.render(200);
        observed.push(rendered);
        const selected = rendered.find((line: string) =>
          line.trimStart().startsWith("→"),
        );
        if (selected?.includes(selectedName)) {
          component.handleInput("\u001b");
          return;
        }
        component.handleInput("\u001b[B");
      }
      throw new Error(`TUI item was not selected: ${selectedName}`);
    });
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    const withoutHelp = observed.find((lines) =>
      lines.some((line) => /^→ aaa-no-help/u.test(line)),
    );
    assert.ok(
      withoutHelp,
      "mixed-help picker visits the definition without help",
    );
    const footerRow = withoutHelp.findIndex((line) =>
      line.includes("↑↓ navigate"),
    );
    assert.equal(withoutHelp[footerRow - 2].trim(), "");
    assert.ok(
      observed.every(
        (lines) =>
          lines.findIndex((line) => line.includes("↑↓ navigate")) === footerRow,
      ),
    );
    assert.equal(typeof expectedHelp, "string");
    assert.ok(
      observed.some((rendered) => rendered.includes(expectedHelp as string)),
      `Expected Definitions help to render ${JSON.stringify(expectedHelp)}`,
    );
  } finally {
    realFs.rmSync(noHelpPath, { force: true });
    await pi.events.get("session_shutdown")?.[0]();
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
    let finishInteractions!: () => void;
    let failInteractions!: (error: Error) => void;
    const interactionsComplete = new Promise<void>((resolve, reject) => {
      finishInteractions = resolve;
      failInteractions = reject;
    });
    context.ui.notify = (message: string) => {
      if (message.startsWith("Error:")) failInteractions(new Error(message));
    };
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
          selectTuiItem(component, "Agent definitions");
        } else if (call === 1) {
          selectTuiItem(component, "preselect-agent");
        } else if (call === 2) {
          selectTuiItem(component, scenario.field);
        } else if (call === 3 && scenario.picker !== undefined) {
          if ("filter" in scenario && scenario.filter !== undefined)
            for (const character of scenario.filter)
              component.handleInput(character);
          const line = component
            .render(200)
            .find((candidate: string) => candidate.includes(scenario.picker));
          assert.match(line ?? "", /^→/u);
          component.handleInput("\r");
        } else component.handleInput("\u001b");
        if (call === 6) finishInteractions();
      });
    let interactionTimeout!: ReturnType<typeof setTimeout>;
    const interactionTimeoutExpired = new Promise<never>((_resolve, reject) => {
      interactionTimeout = setTimeout(
        () => reject(new Error("TUI definition picker interaction timed out")),
        5000,
      );
    });
    try {
      const handlerCompletion = pi.commandOptions
        .get("agents")
        .handler("definitions", context);
      await Promise.race([
        Promise.all([handlerCompletion, interactionsComplete]),
        interactionTimeoutExpired,
      ]);
      assert.equal(customCalls, 7, JSON.stringify(scenario));
      assert.equal(
        discoverAgent("preselect-agent").frontmatter[scenario.property],
        scenario.expected,
      );
    } finally {
      clearTimeout(interactionTimeout);
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
          selectTuiItem(component, "Agent definitions");
          break;
        case 1:
          selectTuiItem(component, "search-agent");
          break;
        case 2:
          selectTuiItem(component, "Model");
          break;
        case 3:
          for (const character of "zulu 46") component.handleInput(character);
          {
            component.focused = true;
            assert.equal(component.focused, true);
            const rendered = component.render(200);
            assert.equal(rendered[2].trim(), "");
            const footer = rendered.findIndex((line: string) =>
              line.includes("Type to filter"),
            );
            assert.equal(rendered[footer - 1].trim(), "");
            assert.match(rendered[footer - 2], /claude-sonnet-4-6/u);
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
        case 4:
          selectTuiItem(component, "Model");
          break;
        case 5:
        case 6:
        case 7:
        case 8:
          component.handleInput("\u001b");
          break;
      }
    });
  try {
    await pi.commandOptions.get("agents").handler("definitions", context);
    assert.equal(customCalls, 9);
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
  const command = pi.commandOptions.get("herdsman");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.isProjectTrusted = () => false;
  context.hasUI = true;
  context.mode = "rpc";
  context.isProjectTrusted = () => false;
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
      "Default Lead execution  flexible",
      "Manager auto-start  Global off · Effective off (global; untrusted project)",
      "Skip Manager Git setup confirmation  Global off",
      "Context retirement  Global on · Effective on (global; untrusted project)",
      "Manager local merge  Global off",
      "Message limits",
      "Project overrides…",
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
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.match(
      menus[1]?.options.find((option) =>
        option.includes("Context retirement"),
      ) ?? "",
      /Context retirement\s+Global on · Effective on/,
    );
    assert.equal(readConfig().contextRetirement, false);
    assert.deepEqual(notices, ["Global context retirement: off"]);
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.match(
      menus
        .filter(({ label }) => label === "Settings")
        .at(-1)
        ?.options.find((option) => option.includes("Context retirement")) ?? "",
      /Context retirement\s+Global off · Effective off/,
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
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.equal(readConfig().autoActivateManager, true);
    assert.deepEqual(pi.pi.getActiveTools(), activeTools);
    assert.deepEqual(notices, ["Global Manager auto-start: on"]);
  } finally {
    updateConfig("autoActivateManager", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Manager Git confirmation Settings toggle updates global config without changing role", async () => {
  setLeadEnvironment();
  updateConfig("managerGitBootstrapWithoutConfirmation", undefined);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = process.cwd();
  context.hasUI = true;
  context.mode = "rpc";
  const activeTools = pi.pi.getActiveTools();
  const notices: string[] = [];
  let selection = 0;
  context.ui.select = async (_title: string, options: string[]) => {
    if (selection++ === 0) return "Settings";
    return selection === 2
      ? options.find((option) =>
          option.includes("Skip Manager Git setup confirmation"),
        )
      : undefined;
  };
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.equal(readConfig().managerGitBootstrapWithoutConfirmation, true);
    assert.deepEqual(pi.pi.getActiveTools(), activeTools);
    assert.deepEqual(notices, [
      "Global Manager Git setup confirmation skip: on",
    ]);
  } finally {
    updateConfig("managerGitBootstrapWithoutConfirmation", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Project override menu edits Off then Inherit without changing global Manager auto-start", async () => {
  const { createLeadCommandRuntime } = await import("./lead-runtime.ts");
  const menus: { title: string; selected?: string }[] = [];
  const values: string[] = [];
  const overrides: { autoActivateManager?: boolean } = {};
  const global = { ...readConfig(), autoActivateManager: true };
  const answers = [
    "project-overrides",
    "autoActivateManager",
    "off",
    undefined,
    "project-overrides",
    "autoActivateManager",
    "inherit",
    undefined,
    undefined,
  ];
  const runtime = createLeadCommandRuntime({
    readConfig: () => global,
    readProjectOverrides: () => ({ ...overrides }),
    updateProjectOverride: (
      _ctx: unknown,
      _key: string,
      value: boolean | undefined,
    ) => {
      if (value === undefined) delete overrides.autoActivateManager;
      else overrides.autoActivateManager = value;
      values.push(value === undefined ? "inherit" : value ? "on" : "off");
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      const answer = answers.shift();
      menus.push({
        title,
        selected: items.find(({ value }) => value === answer)?.value,
      });
      return answer;
    },
  } as any);
  await runtime.openSettingsMenu({
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(values, ["off", "inherit"]);
  assert.equal(Object.hasOwn(overrides, "autoActivateManager"), false);
  assert.equal(global.autoActivateManager, true);
  assert.deepEqual(
    menus.map(({ title }) => title),
    [
      "Settings",
      "Project overrides",
      "Manager auto-start",
      "Project overrides",
      "Settings",
      "Project overrides",
      "Manager auto-start",
      "Project overrides",
      "Settings",
    ],
  );
});

test("Project Overrides exposes verified removal policy independently of project trust and storage", async () => {
  const { createLeadCommandRuntime } = await import("./lead-runtime.ts");
  const menuCalls: { title: string; items: any[] }[] = [];
  const notices: string[] = [];
  let stored: boolean | undefined;
  const answers = ["removal-confirmation", "skip", undefined];
  const runtime = createLeadCommandRuntime({
    readProjectOverrides: () => {
      throw new Error("untrusted project settings");
    },
    getRemovalPreauthorization: async () => ({
      repoKey: "/verified/repository",
      enabled: false,
    }),
    setRemovalPreauthorization: async (enabled: boolean) => {
      stored = enabled;
      return true;
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      menuCalls.push({ title, items });
      return answers.shift();
    },
  } as any);
  await runtime.openProjectOverridesMenu({
    isProjectTrusted: () => false,
    ui: { notify: (message: string) => notices.push(message) },
  } as any);
  assert.equal(menuCalls[0]?.title, "Project overrides");
  assert.deepEqual(
    menuCalls[0]?.items.map(({ value }) => value),
    ["removal-confirmation"],
  );
  assert.match(menuCalls[0]?.items[0]?.help, /\/verified\/repository/);
  assert.match(menuCalls[0]?.items[0]?.help, /not \.pi\/settings\.json/);
  assert.equal(menuCalls[1]?.title, "Worktree removal · /verified/repository");
  assert.equal(stored, true);
  assert.deepEqual(notices, [
    "Worktree removal confirmation skipped for /verified/repository.",
  ]);
});

test("registered RPC command edits project Manager auto-start Off then Inherit", async () => {
  setLeadEnvironment();
  const previousGlobal = readConfig().autoActivateManager;
  const cwd = mkdtempSync(join(tmpdir(), "herdsman-project-menu-rpc-"));
  updateConfig("autoActivateManager", true);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = cwd;
  context.hasUI = true;
  context.mode = "rpc";
  let selections = [
    "Settings",
    "Project overrides…",
    "Manager auto-start",
    "Off for this project",
    undefined,
    undefined,
    undefined,
  ];
  const prompts: { label: string; options: string[] }[] = [];
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    const selection = selections.shift();
    return options.find((option) => option === selection);
  };
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.deepEqual(prompts[3]?.options, [
      "Inherit global (on)",
      "On for this project",
      "Off for this project",
    ]);
    assert.equal(readProjectOverrides(context).autoActivateManager, false);
    assert.equal(readConfig().autoActivateManager, true);
    assert.equal(readEffectiveConfig(context).autoActivateManager, false);

    selections = [
      "Settings",
      "Project overrides…",
      "Manager auto-start",
      "Inherit global (on)",
      undefined,
      undefined,
      undefined,
    ];
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.equal(
      Object.hasOwn(readProjectOverrides(context), "autoActivateManager"),
      false,
    );
    assert.equal(readConfig().autoActivateManager, true);
    assert.equal(readEffectiveConfig(context).autoActivateManager, true);
    assert.deepEqual(
      prompts.filter(({ label }) => label === "Manager auto-start").length,
      2,
    );
  } finally {
    updateConfig("autoActivateManager", previousGlobal);
    await pi.events.get("session_shutdown")?.[0]();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Settings isolates malformed project settings and untrusted projects inherit global values", async () => {
  const { createLeadCommandRuntime } = await import("./lead-runtime.ts");
  const menus: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const updates: boolean[] = [];
  let trusted = true;
  let reads = 0;
  let settingSelection = 0;
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({ ...readConfig(), autoActivateManager: true }),
    readProjectOverrides: () => {
      reads++;
      throw new Error("malformed project settings");
    },
    updateConfig: (_key: string, value: boolean) => updates.push(value),
    selectMenu: async (_ctx: unknown, label: string, items: any[]) => {
      menus.push({
        label,
        options: items.map(({ label, description }) =>
          description ? `${label}  ${description}` : label,
        ),
      });
      if (label === "Settings")
        return settingSelection++ === 0
          ? trusted
            ? "auto-activate-manager"
            : "project-overrides"
          : undefined;
      return undefined;
    },
  } as any);
  const context = {
    isProjectTrusted: () => trusted,
    ui: { notify: (message: string) => notices.push(message) },
  } as any;
  await runtime.openSettingsMenu(context);
  assert.match(
    menus[0]?.options[1] ?? "",
    /Global on · Project value unavailable/u,
  );
  assert.deepEqual(updates, [false], "global settings remain editable");
  assert.equal(
    reads,
    2,
    "the trusted settings menu reloads its project snapshot after edits",
  );

  trusted = false;
  settingSelection = 0;
  menus.length = 0;
  await runtime.openSettingsMenu(context);
  assert.match(
    menus[0]?.options[1] ?? "",
    /Effective on \(global; untrusted project\)/u,
  );
  assert.equal(reads, 2, "untrusted projects do not read project settings");
  assert.deepEqual(notices, [
    "Global Manager auto-start: off",
    "Project overrides are unavailable because this project is not trusted.",
  ]);
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
          for (let i = 0; i < 5; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 1:
          for (let i = 0; i < 4; i++) component.handleInput("\u001b[B");
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
    await pi.commandOptions.get("herdsman").handler("", context);
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
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    agentDefinition: "agent",
  });
  const pi = fakePi({
    exec: leadExec(label, "working", DEFAULT_PI_SESSION_ID),
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("herdsman");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  let rootSelection = true;
  let agentsSelection = true;
  context.ui.select = async (prompt: string, options: string[]) => {
    prompts.push({ label: prompt, options });
    if (prompt.startsWith("Pi Herdsman")) {
      if (!rootSelection) return undefined;
      rootSelection = false;
      return "Agents";
    }
    if (prompt === "Agents") {
      if (!agentsSelection) return undefined;
      agentsSelection = false;
      assert.equal(options[0], "Running  1 working");
      return options.find((option) => option.startsWith("Running"));
    }
    if (prompt === "Running") {
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
      assert.equal(prompts[2]?.label, "Running");
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
      JSON.stringify({ prompts, notices }),
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
  const command = pi.commandOptions.get("herdsman");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  let rootSelection = true;
  let agentsSelection = true;
  context.ui.select = async (prompt: string, options: string[]) => {
    if (prompt.startsWith("Pi Herdsman")) {
      if (!rootSelection) return undefined;
      rootSelection = false;
      return "Agents";
    }
    if (prompt === "Agents") {
      if (!agentsSelection) return undefined;
      agentsSelection = false;
      return options.find((option) => option.startsWith("Running"));
    }
    return undefined;
  };

  await command.handler("", context);

  assert.ok(
    notices.some(
      (message) =>
        message.includes("No running Agents") &&
        message.includes("available definition") &&
        !message.includes("scout"),
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
                  workspaces: [],
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
  let agentsSelections = 0;
  const runningSelections: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (prompt: string, options: string[]) => {
    if (prompt === "Running") {
      runningSelections.push(prompt);
      return options[0];
    }
    if (prompt.startsWith("Pi Herdsman")) {
      rootSelections++;
      return rootSelections === 1 ? "Agents" : undefined;
    }
    if (prompt === "Agents") {
      agentsSelections++;
      return agentsSelections === 1
        ? options.find((option) => option.startsWith("Running"))
        : undefined;
    }
    return undefined;
  };
  try {
    await pi.commandOptions.get("herdsman").handler("", context);
    assert.equal(rootSelections, 2);
    assert.equal(agentsSelections, 2);
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
                  workspaces: [],
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
  const command = pi.commandOptions.get("herdsman");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  let rootSelections = 0;
  let agentsSelections = 0;
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (label.startsWith("Pi Herdsman")) {
      rootSelections++;
      return rootSelections === 1 ? "Agents" : undefined;
    }
    assert.equal(label, "Agents");
    assert.ok(options.includes("Running  1 unknown · 1 lost"));
    agentsSelections++;
    return agentsSelections === 1
      ? options.find((option) => option.startsWith("Running"))
      : undefined;
  };
  try {
    await command.handler("", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        `Pi Herdsman · v${packageMetadata.version}`,
        "Agents",
        "Agents",
        `Pi Herdsman · v${packageMetadata.version}`,
      ],
    );
    assert.ok(notices.some((message) => message.includes("No running Agents")));
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
                workspaces: [],
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
  const command = pi.commandOptions.get("herdsman");
  const notices: { message: string; level?: string }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string, level?: string) =>
    notices.push({ message, level });
  let rootSelection = true;
  let agentsSelection = true;
  context.ui.select = async (prompt: string, options: string[]) => {
    if (prompt.startsWith("Pi Herdsman")) {
      if (!rootSelection) return undefined;
      rootSelection = false;
      return "Agents";
    }
    if (prompt === "Agents") {
      if (!agentsSelection) return undefined;
      agentsSelection = false;
      return options.find((option) => option.startsWith("Running"));
    }
    if (prompt === "Running") {
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
              workspaces: [],
              agent_definitions: [],
              snapshot: {
                workspaces: [],
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
  const command = pi.commandOptions.get("herdsman");
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
      if (call === 0 || call === 3) {
        selectTuiItem(component, "Agents");
        component.handleInput("\r");
        return;
      }
      if (call === 1 || call === 4) {
        selectTuiItem(component, "Running");
        component.handleInput("\r");
        return;
      }
      const duplicateRows = lines()
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^(?:→ |  )same running option$/u.test(line));
      assert.equal(duplicateRows.length, 2);
      const stableValue = call === 2 ? "0" : "1";
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
    assert.equal(customCall, 6);
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
    if (selection++ === 0) return "Agent definitions";
    if (selection === 2)
      return options.find((option) => option.includes("docs-reviewer"));
    if (selection === 3)
      return options.find((option) => option.startsWith("Model"));
    if (selection === 4)
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
          label === "Agent definitions" &&
          options.some((option) => /docs-reviewer.*global/iu.test(option)),
      ),
    );
    assert.equal(
      realFs.readFileSync(definitionPath, "utf8"),
      original.replace("model: old/model\n", ""),
    );
    assert.ok(
      prompts[1]?.options.some((option) => option.includes("docs-reviewer")),
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
      return visit === 0 ? "Role profiles" : undefined;
    if (label === "Role profiles")
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
    const categoryMenu = prompts.find(({ label }) => label === "Definitions");
    const definitionMenu = prompts.find(
      ({ label }) => label === "Role profiles",
    );
    assert.deepEqual(categoryMenu?.options, [
      "Agent definitions",
      "Role profiles",
    ]);
    assert.deepEqual(
      definitionMenu?.options
        .slice(0, 5)
        .map((option) => option.split(/\s/u)[0]),
      [
        "flexible-lead",
        "orchestrator-lead",
        "managed-lead",
        "manager",
        "chief",
      ],
    );
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

test("Definitions contextual help distinguishes managed Lead and Agent launches across visits", async () => {
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
        selectTuiItem(component, "Role profiles");
      } else if (customCall === 1) {
        customCall++;
        selectTuiItem(component, "managed-lead");
      } else if (customCall === 2) {
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
      } else if (customCall === 3) {
        customCall++;
        component.handleInput("\u001b");
      } else if (customCall === 4) {
        customCall++;
        component.handleInput("\u001b");
      } else if (customCall === 5) {
        customCall++;
        selectTuiItem(component, "Agent definitions");
      } else if (customCall === 6) {
        customCall++;
        selectTuiItem(component, "generalist");
      } else if (customCall === 7) {
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
    // The TUI Escape key closes this command's menu; reopen it for the Agent case.
    await command.handler("definitions", context);
    await command.handler("definitions", context);
    assert.equal(customCall, 8);
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
        if (call >= 3) {
          component.handleInput("\u001b");
          return;
        }
        const target =
          call === 0
            ? "Agent definitions"
            : call === 1
              ? selectedName
              : "Details…";
        if (call === 2) beforeDetails?.();
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
    if (currentSelection === 0) return "Agent definitions";
    if (currentSelection === 1)
      return options.find((option) => option.includes("details-rpc"));
    if (label === "details-rpc" && currentSelection === 2)
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

test("Agent Definition details toggle independently on click", () => {
  setLeadEnvironment();

  const pi = fakePi();
  registerExtension!(pi.pi as never);

  const renderer = pi.entryRenderers.find(
    ({ customType }) => customType === "pi-herdsman-agent-definitions",
  )!.renderer as any;
  const entry = {
    data: {
      definitions: [
        {
          name: "scout",
          description: "Example definition",
          extensions: ["example-extension"],
        },
      ],
      instructions: "AGENT_DEFINITION_INSTRUCTIONS_SENTINEL",
    },
  };
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  const click = {
    type: "click",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 4,
    shift: false,
    alt: false,
    ctrl: false,
  };
  const first = renderer(entry, { expanded: false }, theme);
  const second = renderer(entry, { expanded: false }, theme);
  const rendered = (component: any) => component.render(120).join("\n");

  assert.doesNotMatch(
    rendered(first),
    /AGENT_DEFINITION_INSTRUCTIONS_SENTINEL/u,
  );
  assert.doesNotMatch(
    rendered(second),
    /AGENT_DEFINITION_INSTRUCTIONS_SENTINEL/u,
  );
  assert.equal(first.handleMouse(click)?.handled, true);
  assert.match(rendered(first), /AGENT_DEFINITION_INSTRUCTIONS_SENTINEL/u);
  assert.doesNotMatch(
    rendered(second),
    /AGENT_DEFINITION_INSTRUCTIONS_SENTINEL/u,
  );
  assert.equal(first.handleMouse(click)?.handled, true);
  assert.doesNotMatch(
    rendered(first),
    /AGENT_DEFINITION_INSTRUCTIONS_SENTINEL/u,
  );

  const globallyExpanded = renderer(entry, { expanded: true }, theme);
  assert.match(
    rendered(globallyExpanded),
    /AGENT_DEFINITION_INSTRUCTIONS_SENTINEL/u,
  );
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
        return "Agent definitions";
      case 1:
        return options.find((option) => option.includes("implementer"));
      case 2:
        return options.find((option) => option.startsWith("Model"));
      case 3:
        return undefined;
      case 4:
        return options.find((option) => option.startsWith("Thinking"));
      case 5:
        return undefined;
      case 6:
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
        "Agent definitions",
        "implementer",
        "Model",
        "implementer",
        "Thinking",
        "implementer",
        "Agent definitions",
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
          return "Agent definitions";
        case 1:
          return options.find((option) => option.includes("implementer"));
        case 2:
          return options.find((option) => option.startsWith(scenario.field));
        case 3:
          return options.find((option) => option.startsWith(scenario.selected));
        case 4:
          assert.equal(
            discoverAgent("implementer").frontmatter[scenario.property],
            scenario.property === "model" ? "provider/new-model" : "medium",
          );
          return options.find((option) => option.startsWith(scenario.field));
        case 5:
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
        return "Agent definitions";
      case 1:
        return options.find((option) => option.includes("implementer"));
      case 2:
        assert.equal(label, "implementer");
        assert.ok(options.some((option) => /^Enabled\s+on\b/u.test(option)));
        return options.find((option) => option.startsWith("Enabled"));
      case 3:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, false);
        assert.ok(options.some((option) => /^Enabled\s+off\b/u.test(option)));
        return options.find((option) => option.startsWith("Enabled"));
      case 4:
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
        return "Agent definitions";
      case 1:
        assert.ok(
          options.some((option) => option.includes("inherit · current-model")),
        );
        return options.find((option) => option.includes("implementer"));
      case 2:
        return options.find((option) => option.startsWith("Model"));
      case 3:
        return options.find((option) => option.startsWith("refresh-model"));
      case 4:
        assert.ok(options.some((option) => option.startsWith("Thinking")));
        return options.find((option) => option.startsWith("Thinking"));
      case 5:
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
        return "Agent definitions";
      case 1:
        assert.ok(
          options.some((option) => option.includes("inherit · current-model")),
        );
        return options.find((option) => option.includes("implementer"));
      case 2:
        return options.find((option) => option.startsWith("Thinking"));
      case 3:
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
          return "Agent definitions";
        case 1:
          assert.ok(options.some((option) => option.includes(scenario.model)));
          return options.find((option) => option.includes("implementer"));
        case 2:
          return options.find((option) => option.startsWith("Thinking"));
        case 3:
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
  let categorySelections = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push(options);
    if (label === "Definitions" && categorySelections++ === 0)
      return "Agent definitions";
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    const options = prompts[1] ?? [];
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

test("Definitions separates Agent definitions and preserves provenance", async () => {
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
    if (selections++ === 0) return "Agent definitions";
    if (selections === 2)
      return options.find((option) => option.includes("group:Custom"));
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        "Definitions",
        "Agent definitions",
        "group:Custom",
        "Agent definitions",
        "Definitions",
      ],
    );
    const definitions = prompts[1]!.options;
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
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const definitionPath of definitionPaths)
      realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions retains the last selected Agent when returning to its list", async () => {
  const { createLeadCommandRuntime } = await import("./lead-runtime.ts");
  const { RESERVED_ROLE_DEFINITION_NAMES } =
    await import("./agent-definitions.ts");
  const second = { name: "second", frontmatter: { name: "second" } } as any;
  const first = { name: "first", frontmatter: { name: "first" } } as any;
  const roleDefinitions = RESERVED_ROLE_DEFINITION_NAMES.map((name) => ({
    name,
    frontmatter: { name },
  })) as any[];
  const selections: { title: string; selected?: string }[] = [];
  const results = ["agents", "second", undefined, undefined, undefined];
  const runtime = createLeadCommandRuntime({
    contextAgentDefinitions: async () => ({
      definitions: [first, second],
      roleDefinitions,
      projectTrusted: true,
    }),
    selectMenu: async (
      _ctx: unknown,
      title: string,
      _items: any[],
      selected?: string,
    ) => {
      selections.push({ title, selected });
      return results.shift();
    },
    agentDefinitionEnabled: () => true,
    getThinkingLevel: () => "high",
  } as any);
  await runtime.openDefinitionsMenu({
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(
    selections
      .filter(({ title }) => title === "Agent definitions")
      .map(({ selected }) => selected),
    [undefined, "second"],
  );
});

test("lead agents stop reports an empty owned inventory safely", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { snapshot: { agents: [], panes: [], workspaces: [] } },
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

test("lead stop-all does not report an empty inventory while delegation is locked", async () => {
  const summaries: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  const release = claimDelegationLock(
    WORKSPACE,
    context.sessionManager.getSessionId(),
  );
  const runtime = createLeadCommandRuntime({
    loadStatusSnapshot: async () => ({ agents: [] }),
    controller: {
      workspaceId: () => WORKSPACE,
      sessionSignal: () => new AbortController().signal,
    },
    presentStopSummary: (summary: string) => summaries.push(summary),
  } as any);
  try {
    await assert.rejects(
      runtime.confirmAndStopAll(context),
      /already in progress/,
    );
    assert.deepEqual(summaries, []);
  } finally {
    release();
  }
});

test("lead stop-all rejects an empty inventory with unresolved mailbox state", async () => {
  const summaries: string[] = [];
  let cleanupStarted = false;
  const context = fakeContext() as any;
  context.hasUI = true;
  const runtime = createLeadCommandRuntime({
    loadStatusSnapshot: async () => ({ agents: [] }),
    controller: {
      workspaceId: () => WORKSPACE,
      sessionSignal: () => new AbortController().signal,
      agentSnapshotView: async () => ({
        stateIssues: [{ diagnostic: "unreadable mailbox" }],
        visible: [],
      }),
      stopOwnedAgentsForSession: async () => {
        cleanupStarted = true;
      },
    },
    presentStopSummary: (summary: string) => summaries.push(summary),
  } as any);

  await assert.rejects(
    runtime.confirmAndStopAll(context),
    /Owned Agent mailbox state is unresolved; stop not verified/u,
  );
  assert.deepEqual(summaries, []);
  assert.equal(cleanupStarted, false);
});

test("Lead stop does not let the Lead continue a nested descendant directly", async () => {
  setLeadEnvironment();
  const sessionRoot = mkdtempSync(join(tmpdir(), "herdsman-stop-proof-"));
  const parentRequestId = randomUUID();
  const childRequestId = randomUUID();
  const parent = {
    ...managedState(
      "pi-herdsman-parent",
      parentRequestId,
      recoveryIdentity("pi-herdsman-parent"),
    ),
    agentDefinition: "agent",
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: join(sessionRoot, "parent.jsonl"),
  };
  const agents = {
    ...managedState(
      "pi-herdsman-agents",
      childRequestId,
      recoveryIdentity("pi-herdsman-agents"),
    ),
    agentDefinition: "agent",
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(sessionRoot, "agents.jsonl"),
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
        ...(state === parent
          ? [
              {
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: "delegate_agent",
                  isError: false,
                  details: {
                    ok: true,
                    owner_session_id: parent.piSessionId,
                    session_id: agents.piSessionId,
                    session_path: agents.piSessionFile,
                    request_id: childRequestId,
                    agent: agents.agentLabel,
                    definition: "agent",
                  },
                },
              },
            ]
          : []),
      ],
    });
  for (const state of [parent, agents]) {
    const entries = nativeSessions.get(state.piSessionFile!)!.entries ?? [];
    writeFileSync(
      state.piSessionFile!,
      [{ type: "session", id: state.piSessionId, cwd: state.cwd }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, agents);
  const lifecycle = cascadeExecutor([parent, agents]);
  const pi = fakePi({ exec: lifecycle.exec });
  pi.entries.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "delegate_agent",
      isError: false,
      details: {
        ok: true,
        owner_session_id: LEAD_SESSION_ID,
        session_id: parent.piSessionId,
        session_path: parent.piSessionFile,
        request_id: parentRequestId,
        agent: parent.agentLabel,
        definition: "agent",
      },
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext(pi.entries) as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.events.get("session_start")?.[0](undefined, context);
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
          entry.customType === "pi-herdsman-agent-closed-assignment" &&
          entry.data?.version === 1 &&
          JSON.stringify(entry.data.proof) ===
            JSON.stringify({
              owner_session_id: LEAD_SESSION_ID,
              session_id: parent.piSessionId,
              session_path: parent.piSessionFile,
              run_id: parent.runId,
              request_id: parentRequestId,
              agent: parent.agentLabel,
              definition: "agent",
              pane_id: parent.paneId,
              workspace_id: parent.workspaceId,
            }),
      ),
    );
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
    const denied = await agentTool(pi, "continue").execute(
      "continue-stopped-nested-child",
      { session: agents.piSessionId, task: "continue the prior assignment" },
      undefined,
      undefined,
      context,
    );
    assert.equal(denied.details.ok, false);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    for (const state of [parent, agents])
      nativeSessions.delete(state.piSessionFile!);
    rmSync(sessionRoot, { recursive: true, force: true });
  }
});

for (const acceptedChild of [true, false]) {
  test(`close cascade ${acceptedChild ? "preserves" : "rejects"} nested continuation`, async (t) => {
    setLeadEnvironment();
    const sessionRoot = mkdtempSync(join(tmpdir(), "herdsman-close-cascade-"));
    const leadPath = join(sessionRoot, "lead.jsonl");
    const parentRequestId = randomUUID();
    const childRequestId = randomUUID();
    const parent = {
      ...managedState(
        "close-cascade-parent",
        parentRequestId,
        recoveryIdentity("close-cascade-parent"),
      ),
      agentDefinition: "agent",
      ownerSessionId: LEAD_SESSION_ID,
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: join(sessionRoot, "parent.jsonl"),
    };
    const child = {
      ...managedState(
        "close-cascade-child",
        childRequestId,
        recoveryIdentity("close-cascade-child"),
      ),
      agentDefinition: "agent",
      ownerSessionId: parent.piSessionId,
      piSessionId: CHILD_SESSION_ID,
      piSessionFile: join(sessionRoot, "child.jsonl"),
    };
    const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    const acceptance = (
      ownerSessionId: string,
      state: ManagedAgentState,
      requestId: string,
    ) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_agent",
        isError: false,
        details: {
          ok: true,
          owner_session_id: ownerSessionId,
          session_id: state.piSessionId,
          session_path: state.piSessionFile,
          request_id: requestId,
          agent: state.agentLabel,
          definition: state.agentDefinition,
          run_id: state.runId,
          pane_id: state.paneId,
          workspace_id: state.workspaceId,
        },
      },
    });
    const parentEntries = [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: parent.piSessionId,
          definition: "agent",
          label: parent.agentLabel,
        },
      },
      ...(acceptedChild
        ? [acceptance(parent.piSessionId, child, childRequestId)]
        : []),
    ];
    for (const [state, entries] of [
      [parent, parentEntries],
      [
        child,
        [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: child.piSessionId,
              definition: "agent",
              label: child.agentLabel,
            },
          },
        ],
      ],
    ] as const) {
      nativeSessions.set(state.piSessionFile!, {
        id: state.piSessionId!,
        path: state.piSessionFile!,
        entries: [...entries],
      });
      writeFileSync(
        state.piSessionFile!,
        [{ type: "session", id: state.piSessionId, cwd: state.cwd }, ...entries]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    }
    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    const lifecycle = delegatedLifecycleExecutor(parent, [child]);
    const pi = fakePi({ exec: lifecycle.exec });
    const leadAcceptance = acceptance(LEAD_SESSION_ID, parent, parentRequestId);
    pi.entries.push(leadAcceptance);
    registerExtension!(pi.pi as never);
    const context = fakeContext(pi.entries) as any;
    context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
    context.hasUI = true;
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    t.after(async () => {
      await pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
      nativeSessions.delete(parent.piSessionFile!);
      nativeSessions.delete(child.piSessionFile!);
      rmSync(sessionRoot, { recursive: true, force: true });
    });

    const result = await agentTool(pi, "close").execute(
      "close-cascade-parent",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.action, "close");
    assert.equal(result.details.agent, parent.agentLabel);
    assert.equal(result.details.cleanup_error, undefined);
    assert.equal(result.details.cleanup_errors, undefined);
    if (acceptedChild) {
      assert.equal(result.details.descendant_continuation_warning, undefined);
    } else {
      assert.match(
        result.details.descendant_continuation_warning,
        /continuation proof/i,
      );
    }
    assert.equal(
      result.details.closed_assignment.session_id,
      parent.piSessionId,
    );
    assert.deepEqual(lifecycle.closeOrder, [
      child.agentLabel,
      parent.agentLabel,
    ]);
    // Pi persists native tool results as message entries. Preserve the actual
    // close result here so continuation is authorized by the recorded call.
    pi.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "close_agent",
        isError: false,
        content: result.content,
        details: result.details,
      },
    });
    writeFileSync(
      leadPath,
      [{ type: "session", id: LEAD_SESSION_ID, cwd: "/tmp" }, ...pi.entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const leadDiskEntries = readFileSync(leadPath, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line));
    nativeSessions.set(leadPath, {
      id: LEAD_SESSION_ID,
      path: leadPath,
      cwd: "/tmp",
      entries: leadDiskEntries,
    });
    const reopenedLead = (SessionManager as any).open(leadPath);
    assert.equal(reopenedLead.getSessionId(), LEAD_SESSION_ID);
    assert.equal(reopenedLead.getSessionFile(), leadPath);
    const resumedLeadEntries = reopenedLead.getEntries() as any[];
    const openedParent = (SessionManager as any).open(parent.piSessionFile);
    assert.equal(openedParent.getSessionId(), parent.piSessionId);
    const parentHistory = openedParent.getEntries() as any[];
    assert.equal(
      parentHistory.some(
        (entry) =>
          entry.customType === "pi-herdsman-agent-closed-assignment" &&
          entry.data?.version === 1 &&
          entry.data?.proof?.owner_session_id === parent.piSessionId &&
          entry.data?.proof?.session_id === child.piSessionId &&
          entry.data?.proof?.session_path === child.piSessionFile,
      ),
      acceptedChild,
      acceptedChild
        ? "B's closure proof is persisted in A's history"
        : "B's proof is absent when A's accepted assignment cannot be verified",
    );
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-agent-closed-assignment" &&
          entry.data?.proof?.session_id === child.piSessionId,
      ),
      false,
      "descendant proof is not granted to the unrelated Lead history",
    );
    const continuationLaunches: string[][] = [];
    const exec = (command: string, args: string[], options?: any) => {
      const response = lifecycle.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        continuationLaunches.push(args);
        const sessionIndex = args.indexOf("--session");
        const continuedState = lifecycle.live.get(parent.agentLabel);
        if (continuedState && sessionIndex >= 0) {
          const reopenedAgent = (SessionManager as any).open(
            args[sessionIndex + 1],
          );
          continuedState.piSessionId = reopenedAgent.getSessionId();
          continuedState.piSessionFile = reopenedAgent.getSessionFile();
          writeAgentState(parentMailbox, continuedState);
        }
      }
      return response;
    };
    const resumedLeadPi = fakePi({ exec, entries: resumedLeadEntries });
    registerExtension!(resumedLeadPi.pi as never);
    const resumedLeadContext = fakeContext(resumedLeadEntries) as any;
    resumedLeadContext.sessionManager.getSessionId = () =>
      reopenedLead.getSessionId();
    resumedLeadContext.sessionManager.getSessionFile = () =>
      reopenedLead.getSessionFile();
    await resumedLeadPi.events.get("session_start")?.[0](
      undefined,
      resumedLeadContext,
    );
    const continuedParent = await agentTool(resumedLeadPi, "continue").execute(
      "continue-cascade-parent",
      { session: parent.piSessionId, task: "continue A after close cascade" },
      undefined,
      undefined,
      resumedLeadContext,
    );
    assert.equal(
      continuedParent.details.ok,
      true,
      JSON.stringify(continuedParent.details),
    );
    assert.equal(continuedParent.details.session_id, parent.piSessionId);
    assert.equal(continuedParent.details.session_path, parent.piSessionFile);
    assert.ok(
      continuationLaunches[0]?.includes("--session") &&
        continuationLaunches[0]?.includes(
          realFs.realpathSync(parent.piSessionFile!),
        ),
      JSON.stringify(continuationLaunches[0]),
    );
    assert.notEqual(lifecycle.live.get(parent.agentLabel)?.runId, parent.runId);

    // Continue B only from A's reopened saved owner history; Lead never receives B's proof.
    const reopenedParent = (SessionManager as any).open(parent.piSessionFile);
    assert.equal(reopenedParent.getSessionId(), parent.piSessionId);
    assert.equal(reopenedParent.getSessionFile(), parent.piSessionFile);
    const resumedParentEntries = reopenedParent.getEntries() as any[];
    const resumedParentPi = fakePi({ exec, entries: resumedParentEntries });
    registerExtension!(resumedParentPi.pi as never);
    const resumedParentContext = fakeContext(resumedParentEntries) as any;
    resumedParentContext.sessionManager.getSessionId = () =>
      reopenedParent.getSessionId();
    resumedParentContext.sessionManager.getSessionFile = () =>
      reopenedParent.getSessionFile();
    await resumedParentPi.events.get("session_start")?.[0](
      undefined,
      resumedParentContext,
    );
    const continuedChild = await agentTool(resumedParentPi, "continue").execute(
      "continue-cascade-child",
      {
        session: child.piSessionId,
        task: "continue B from A's durable history",
      },
      undefined,
      undefined,
      resumedParentContext,
    );
    assert.equal(
      continuedChild.details.ok,
      acceptedChild,
      JSON.stringify(continuedChild.details),
    );
    assert.equal(
      continuationLaunches.length,
      acceptedChild ? 2 : 1,
      acceptedChild ? "A and B are resumed" : "B is not resumed without proof",
    );
    assert.equal(
      resumedLeadEntries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-agent-closed-assignment" &&
          entry.data?.proof?.session_id === child.piSessionId,
      ),
      false,
    );
    await resumedLeadPi.events.get("session_shutdown")?.[0]();
    await resumedParentPi.events.get("session_shutdown")?.[0]();
  });
}

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
    assert.match(stopSummary(pi), /presence could not be verified/);
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-agent-closed-assignment",
      ),
      false,
    );
    assert.ok(readAgentState(mailbox));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("lead can continue an active Agent after registered stop and reopening owner history", async (t) => {
  setLeadEnvironment();
  const sessionRoot = mkdtempSync(
    join(tmpdir(), "herdsman-active-stop-reopen-"),
  );
  const requestId = randomUUID();
  const state = {
    ...managedState(
      "active-stop-continuation",
      requestId,
      recoveryIdentity("active-stop-continuation"),
    ),
    agentDefinition: "agent",
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(sessionRoot, "agent.jsonl"),
  };
  const ownerPath = join(sessionRoot, "lead.jsonl");
  const acceptance = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "delegate_agent",
      isError: false,
      details: {
        ok: true,
        owner_session_id: LEAD_SESSION_ID,
        session_id: state.piSessionId,
        session_path: state.piSessionFile,
        request_id: requestId,
        agent: state.agentLabel,
        definition: "agent",
      },
    },
  };
  const ownerEntries: any[] = [acceptance];
  const ownerSession = {
    id: LEAD_SESSION_ID,
    path: ownerPath,
    cwd: "/tmp",
    entries: ownerEntries,
  };
  nativeSessions.set(ownerPath, ownerSession);
  writeFileSync(
    ownerPath,
    [{ type: "session", id: LEAD_SESSION_ID, cwd: "/tmp" }, ...ownerEntries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const agentPath = state.piSessionFile!;
  nativeSessions.set(agentPath, {
    id: state.piSessionId!,
    path: agentPath,
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
  writeFileSync(
    agentPath,
    [
      { type: "session", id: state.piSessionId, cwd: state.cwd },
      ...nativeSessions.get(agentPath)!.entries!,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  const lifecycle = delegatedLifecycleExecutor(state);
  let continuationLaunch: string[] = [];
  const exec = (command: string, args: string[], options?: any) => {
    const result = lifecycle.exec(command, args, options);
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      continuationLaunch = args;
      const sessionIndex = args.indexOf("--session");
      const continuedState = lifecycle.live.get(state.agentLabel);
      if (continuedState && sessionIndex >= 0) {
        const reopenedAgent = (SessionManager as any).open(
          args[sessionIndex + 1],
        );
        continuedState.piSessionId = reopenedAgent.getSessionId();
        continuedState.piSessionFile = reopenedAgent.getSessionFile();
        writeAgentState(
          agentMailboxPath(
            continuedState.workspaceId,
            continuedState.agentLabel,
          ),
          continuedState,
        );
      }
    }
    return result;
  };
  const pi = fakePi({ exec, entries: ownerEntries });
  registerExtension!(pi.pi as never);
  const stop = pi.commandOptions.get("agents");
  const stopContext = fakeContext(ownerEntries) as any;
  stopContext.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  stopContext.sessionManager.getSessionFile = () => ownerPath;
  stopContext.hasUI = true;
  stopContext.ui.notify = () => undefined;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    nativeSessions.delete(ownerPath);
    nativeSessions.delete(agentPath);
    for (const agent of lifecycle.live.values())
      resetAgentMailbox(agentMailboxPath(agent.workspaceId, agent.agentLabel));
    rmSync(sessionRoot, { recursive: true, force: true });
    setLeadEnvironment();
  });

  assert.equal(readResult(mailbox, requestId), undefined);
  assert.ok(ownerEntries.includes(acceptance));
  await stop.handler("stop", stopContext);
  assert.deepEqual(lifecycle.closeOrder, [state.agentLabel]);
  assert.equal(readAgentState(mailbox), undefined);
  assert.ok(existsSync(agentPath), "the saved Agent session remains available");
  assert.ok(
    ownerEntries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-agent-closed-assignment" &&
        entry.data?.proof?.session_id === state.piSessionId,
    ),
    "verified closure is persisted in the original Lead history",
  );

  // Persist the owner's append-only entries, then reopen that exact session.
  writeFileSync(
    ownerPath,
    [{ type: "session", id: LEAD_SESSION_ID, cwd: "/tmp" }, ...ownerEntries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const diskEntries = readFileSync(ownerPath, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));
  nativeSessions.set(ownerPath, { ...ownerSession, entries: diskEntries });
  const reopened = (SessionManager as any).open(ownerPath);
  assert.equal(reopened.getSessionId(), LEAD_SESSION_ID);
  assert.equal(reopened.getSessionFile(), ownerPath);
  const reopenedEntries = reopened.getEntries() as any[];
  assert.ok(
    reopenedEntries.some(
      (entry) =>
        entry.message?.toolName === "delegate_agent" &&
        entry.message?.isError === false &&
        entry.message?.details?.request_id === requestId &&
        entry.message?.details?.session_id === state.piSessionId,
    ),
    "the accepted assignment is present in the reopened owner history",
  );
  assert.ok(
    reopenedEntries.some(
      (entry) =>
        entry.customType === "pi-herdsman-agent-closed-assignment" &&
        entry.data?.proof?.session_id === state.piSessionId,
    ),
  );
  const resumedPi = fakePi({ exec, entries: reopenedEntries });
  registerExtension!(resumedPi.pi as never);
  const resumedContext = fakeContext(reopenedEntries) as any;
  resumedContext.sessionManager.getSessionId = () => reopened.getSessionId();
  resumedContext.sessionManager.getSessionFile = () =>
    reopened.getSessionFile();
  await resumedPi.events.get("session_start")?.[0](undefined, resumedContext);
  const continued = await agentTool(resumedPi, "continue").execute(
    "continue-after-active-stop",
    { session: state.piSessionId, task: "continue the accepted assignment" },
    undefined,
    undefined,
    resumedContext,
  );
  assert.equal(continued.details.ok, true, JSON.stringify(continued.details));
  assert.ok(
    continuationLaunch.includes("--session") &&
      continuationLaunch.includes(realFs.realpathSync(agentPath)),
    JSON.stringify(continuationLaunch),
  );
  assert.equal(continued.details.session_id, state.piSessionId);
  assert.equal(continued.details.session_path, agentPath);
  const continuedState = lifecycle.live.get(state.agentLabel);
  assert.ok(continuedState);
  assert.notEqual(continuedState.runId, state.runId);
  assert.equal(continuedState.piSessionId, state.piSessionId);
  assert.equal(continuedState.piSessionFile, agentPath);
  await resumedPi.events.get("session_shutdown")?.[0]();
});

test("lead agents stop does not record closure proof when mailbox cleanup warns", async () => {
  setLeadEnvironment();
  const sessionRoot = mkdtempSync(
    join(tmpdir(), "herdsman-stop-cleanup-warning-"),
  );
  const requestId = randomUUID();
  const state = {
    ...managedState(
      "stop-mailbox-warning",
      undefined,
      recoveryIdentity("stop-mailbox-warning"),
    ),
    agentDefinition: "agent",
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(sessionRoot, "agent.jsonl"),
  };
  const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
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
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "close" &&
        result.code === 0
      )
        mkdirSync(join(mailbox, "cleanup-blocker"));
      return result;
    },
  });
  pi.entries.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "delegate_agent",
      isError: false,
      details: {
        ok: true,
        owner_session_id: LEAD_SESSION_ID,
        session_id: state.piSessionId,
        session_path: state.piSessionFile,
        request_id: requestId,
        agent: state.agentLabel,
        definition: "agent",
      },
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext(pi.entries) as any;
  context.hasUI = true;
  try {
    await command.handler("stop", context);
    assert.deepEqual(lifecycle.closeOrder, [state.agentLabel]);
    assert.match(stopSummary(pi), /mailbox cleanup failed/);
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-agent-closed-assignment",
      ),
      false,
    );
    assert.ok(readAgentState(mailbox));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    nativeSessions.delete(state.piSessionFile!);
    rmSync(sessionRoot, { recursive: true, force: true });
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
    assert.equal(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-agent-closed-assignment",
      ),
      false,
    );
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

test("delegating managed Agents focus only fresh owned child-row identities", async (t) => {
  const parentMailbox = setAgentEnvironment("delegating-parent", ["child"]);
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = LEAD_SESSION_ID;
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-child-navigation-${randomUUID()}.sock`,
  );
  const parentState: ManagedAgentState = {
    ...managedState("delegating-parent"),
    paneId: "registered-pane",
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const childState: ManagedAgentState = {
    ...managedState("owned-child"),
    ownerSessionId: DEFAULT_PI_SESSION_ID,
    paneId: "owned-child-pane",
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/owned-child-agent.jsonl",
  };
  nativeSessions.set(parentState.piSessionFile!, {
    id: parentState.piSessionId!,
    path: parentState.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: parentState.piSessionId,
          definition: "agent",
          label: parentState.agentLabel,
        },
      },
    ],
  });
  nativeSessions.set(childState.piSessionFile!, {
    id: childState.piSessionId!,
    path: childState.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: childState.piSessionId,
          definition: "child",
          label: childState.agentLabel,
        },
      },
    ],
  });
  const childMailbox = agentMailboxPath(WORKSPACE, childState.agentLabel);
  writeAgentState(parentMailbox, parentState);
  writeAgentState(childMailbox, childState);
  const focused: string[] = [];
  const executor = agentControllerExecutor(parentState, [childState]);
  const pi = fakePi({
    activeTools: () => ["read", "bash", "delegate_agent"],
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "focus") {
        focused.push(args[2]!);
        return { stdout: "{}", stderr: "", code: 0 };
      }
      return executor(command, args, options);
    },
  });
  const ctx = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: DEFAULT_PI_SESSION_ID,
        definition: "agent",
        label: "delegating-parent",
      },
    },
  ]) as any;
  ctx.mode = "tui";
  ctx.hasUI = true;
  let widget: StatusWidget | undefined;
  const notices: string[] = [];
  ctx.ui = {
    ...ctx.ui,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, value: string) => value,
            bold: (value: string) => value,
          },
        );
    },
    notify: (message: string) => notices.push(message),
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    nativeSessions.delete(parentState.piSessionFile!);
    nativeSessions.delete(childState.piSessionFile!);
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  await pi.events.get("session_start")![0](undefined, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.match(
    widget!.render(120).join("\n"),
    /owned-child/,
    notices.join(" | "),
  );
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 1,
    width: 120,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, ["owned-child-pane"]);

  childState.ownerSessionId = "replacement-owner-session";
  writeAgentState(childMailbox, childState);
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 1,
    width: 120,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, ["owned-child-pane"]);
  assert.ok(notices.some((message) => /Agent changed/u.test(message)));
});

test("Lead status child-row focus rechecks the exact Herdr session identity", async (t) => {
  setLeadEnvironment();
  const childState: ManagedAgentState = {
    ...managedState("lead-owned-child"),
    ownerSessionId: LEAD_SESSION_ID,
    paneId: "lead-owned-child-pane",
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/lead-owned-child.jsonl",
  };
  const mailbox = agentMailboxPath(WORKSPACE, childState.agentLabel);
  writeAgentState(mailbox, childState);
  nativeSessions.set(childState.piSessionFile!, {
    id: childState.piSessionId!,
    path: childState.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: childState.piSessionId,
          definition: "agent",
          label: childState.agentLabel,
        },
      },
    ],
  });
  let replaceIdentity = false;
  const focused: string[] = [];
  const herdrCalls: string[][] = [];
  const executor = agentControllerExecutor(childState);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr") herdrCalls.push(args);
      if (command === "herdr" && args[0] === "agent" && args[1] === "focus") {
        focused.push(args[2]!);
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const agent = agentFromState(childState) as any;
        if (replaceIdentity)
          agent.agent_session.value = "replacement-child-session";
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agent } }),
          stderr: "",
          code: 0,
        };
      }
      return executor(command, args, options);
    },
  });
  const ctx = fakeContext() as any;
  ctx.mode = "tui";
  ctx.hasUI = true;
  let widget: StatusWidget | undefined;
  const notices: string[] = [];
  ctx.ui = {
    ...ctx.ui,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, value: string) => value,
            bold: (value: string) => value,
          },
        );
    },
    notify: (message: string) => notices.push(message),
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    nativeSessions.delete(childState.piSessionFile!);
    setLeadEnvironment();
  });
  await pi.events.get("session_start")![0](undefined, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.match(widget!.render(120).join("\n"), /lead-owned-child/);
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 1,
    width: 120,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    focused,
    ["lead-owned-child-pane"],
    `${notices.join(" | ")} ${JSON.stringify(herdrCalls)}`,
  );

  replaceIdentity = true;
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: 1,
    width: 120,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, ["lead-owned-child-pane"]);
  assert.ok(notices.some((message) => /Agent changed/u.test(message)));
});

test("managed Lead marker focuses its verified Manager pane", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-marker-navigation-${randomUUID()}.sock`,
  );
  const assignedWorkspace = `assigned-${randomUUID()}`;
  const repoKey = `repo-${randomUUID()}`;
  const branch = `branch-${randomUUID()}`;
  process.env.HERDR_WORKSPACE_ID = assignedWorkspace;
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey,
    branch,
    text: "assigned work",
  };
  writeProjectAssignment(supervisionRuntime(), assignment);
  const managerId = randomUUID();
  const managerPaneId = "managed-marker-manager-pane";
  const managerTabId = "managed-marker-manager-tab";
  const managerLease = claimManagerLease({
    build: HERDSMAN_BUILD,
    piSessionId: managerId,
    paneId: managerPaneId,
    tabId: managerTabId,
    workspaceId: WORKSPACE,
    repoKey,
  });
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "manager",
    instanceId: randomUUID(),
    piSessionId: managerId,
    updatedAt: Date.now(),
  });
  const managerAgent = {
    agent: "pi",
    pane_id: managerPaneId,
    tab_id: managerTabId,
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: managerId,
    },
  };
  const focused: string[] = [];
  const executor = leadExec(
    "managed-marker-agent",
    "idle",
    DEFAULT_PI_SESSION_ID,
  );
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: repoKey,
                repo_name: "project",
              },
              worktrees: [{ open_workspace_id: assignedWorkspace }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [managerAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: managerAgent },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "focus") {
        focused.push(args[2]!);
        return { stdout: "{}", stderr: "", code: 0 };
      }
      return executor(command, args, options);
    },
  });
  const ctx = fakeContext() as any;
  ctx.mode = "tui";
  ctx.hasUI = true;
  let widget: StatusWidget | undefined;
  const notices: string[] = [];
  ctx.ui = {
    ...ctx.ui,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, value: string) => value,
            bold: (value: string) => value,
          },
        );
    },
    notify: (message: string) => notices.push(message),
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    managerLease.release();
    rmSync(projectAssignmentPath(supervisionRuntime(), repoKey, branch), {
      force: true,
    });
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  await pi.events.get("session_start")![0](undefined, ctx);
  await t.waitFor(() =>
    assert.match(widget?.render(120).join("\n") ?? "", /managed/u),
  );
  assert.ok(widget);
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: visibleWidth("● lead · "),
    y: 0,
    width: 120,
  });
  await t.waitFor(() =>
    assert.deepEqual(focused, [managerPaneId], notices.join(" | ")),
  );
});

test("valid managed leaf agents receive identity-only TUI presentation", async (t) => {
  const mailbox = setAgentEnvironment("leaf-agent");
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = LEAD_SESSION_ID;
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-leaf-navigation-${randomUUID()}.sock`,
  );
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: LEAD_SESSION_ID,
    updatedAt: Date.now(),
  });
  let sessionRuntimeInitialized = false;
  let activeToolsCalls = 0;
  let replaceLeadIdentity = false;
  const focused: string[] = [];
  const state: ManagedAgentState = {
    ...managedState("leaf-agent"),
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  writeAgentState(mailbox, state);
  let currentSessionId = DEFAULT_PI_SESSION_ID;
  let changeSessionOnNextSnapshot = false;
  const pi = fakePi({
    activeTools: () => {
      activeToolsCalls++;
      assert.equal(sessionRuntimeInitialized, true);
      return ["read", "bash", "ask_owner"];
    },
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? (changeSessionOnNextSnapshot &&
            (currentSessionId = "replacement-agent-session"),
          {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  workspaces: [],
                  agents: [
                    agentFromState(state),
                    {
                      agent: "pi",
                      workspace_id: WORKSPACE,
                      pane_id: "lead-pane",
                      tab_id: "lead-tab",
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
                      agent: "pi",
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
          })
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
                      tab_id: "lead-tab",
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
            : command === "herdr" && args[0] === "agent" && args[1] === "get"
              ? {
                  stdout: JSON.stringify({
                    id: AGENT_ID,
                    result: {
                      agent: {
                        agent: "pi",
                        pane_id: "lead-pane",
                        workspace_id: WORKSPACE,
                        tab_id: "lead-tab",
                        agent_session: {
                          source: "herdr:pi",
                          agent: "pi",
                          kind: "id",
                          value: replaceLeadIdentity
                            ? "replacement-session"
                            : LEAD_SESSION_ID,
                        },
                      },
                    },
                  }),
                  stderr: "",
                  code: 0,
                }
              : command === "herdr" &&
                  args[0] === "agent" &&
                  args[1] === "focus"
                ? (focused.push(args[2]!),
                  { stdout: "{}", stderr: "", code: 0 })
                : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeAgentContext() as any;
  context.sessionManager.getSessionId = () => currentSessionId;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  const notices: string[] = [];
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
    notify: (message: string) => notices.push(message),
    select: async () => "tab",
  };
  registerExtension!(pi.pi as never);
  assert.equal(activeToolsCalls, 0);
  sessionRuntimeInitialized = true;
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.deepEqual(widget!.render(160), [
    "● lead → agent:leaf-agent  [read, bash, ask_owner]",
  ]);
  assert.equal(
    widget!.handleMouse({
      type: "click",
      button: "left",
      x: 3,
      y: 0,
      width: 160,
    })?.handled,
    true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, ["lead-pane"], notices.join(" | "));
  replaceLeadIdentity = true;
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 3,
    y: 0,
    width: 160,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, ["lead-pane"]);
  replaceLeadIdentity = false;
  state.ownerSessionId = "replacement-owner-session";
  writeAgentState(mailbox, state);
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 3,
    y: 0,
    width: 160,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(focused, ["lead-pane"]);
  state.ownerSessionId = LEAD_SESSION_ID;
  writeAgentState(mailbox, state);
  changeSessionOnNextSnapshot = true;
  widget!.handleMouse({
    type: "click",
    button: "left",
    x: 3,
    y: 0,
    width: 160,
  });
  changeSessionOnNextSnapshot = false;
  currentSessionId = "replacement-agent-session";
  await new Promise<void>((resolve) => setImmediate(resolve));
  currentSessionId = DEFAULT_PI_SESSION_ID;
  assert.deepEqual(focused, ["lead-pane"]);
  assert.equal(pi.tools.filter((tool) => tool.name === "ask_owner").length, 1);
  assert.ok(activeToolsCalls > 0);
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
  runtime.prime(firstContext);
  assert.equal(pending.length, 1, "priming starts the initial snapshot");
  runtime.start(firstContext);
  assert.equal(
    pending.length,
    1,
    "starting the widget preserves the primed request without overlap",
  );
  pending[0]!.resolve({
    agents: [{ label: "old-agent", definition: "scout", state: "working" }],
    stale: false,
    unavailable: false,
    breadcrumb: [{ text: "lead" }, { text: "scout:old-agent" }],
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
    breadcrumb: [{ text: "lead" }, { text: "scout:stale-agent" }],
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

test("restarting status runtime replaces and unreferences its timer", async (t) => {
  const { createAgentStatusRuntime } = await import("./agent-controller.ts");
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers = new Set<ReturnType<typeof setInterval>>();
  let unrefCalls = 0;
  globalThis.setInterval = ((callback: TimerHandler) => {
    const timer = originalSetInterval(callback, 60_000);
    const unref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefCalls++;
      return unref();
    };
    timers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer) => {
    timers.delete(timer);
    originalClearInterval(timer);
  }) as typeof clearInterval;
  const runtime = createAgentStatusRuntime();
  runtime.configure({
    loadSnapshot: async () => ({
      agents: [],
      stale: false,
      unavailable: false,
    }),
    pendingStartEntries: () => [],
    hasPendingStart: () => false,
    clearPendingStart: () => false,
    runtimeForLabel: () => undefined,
    ownToolsSnapshot: () => ({}),
  });
  const ctx = fakeContext() as any;
  ctx.mode = "tui";
  ctx.hasUI = true;
  ctx.ui = { setWidget: () => undefined };
  t.after(() => {
    runtime.shutdown();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  runtime.start(ctx);
  const previous = [...timers][0]!;
  runtime.start(ctx);
  assert.equal(timers.size, 1);
  assert.equal(timers.has(previous), false);
  assert.equal(unrefCalls, 2);
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
    signal?: AbortSignal;
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
      exec: (command, args, options) => {
        if (command === "herdr" && isApiSnapshot(args)) {
          return new Promise((resolve) =>
            pendingLists.push({ resolve, signal: options?.signal }),
          ) as any;
        }
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
    const makeContext = (sessionId: string) => {
      const context = fakeContext() as any;
      context.sessionManager = {
        ...context.sessionManager,
        getSessionId: () => sessionId,
        getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      };
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
    const firstSessionId = "first-lead-session";
    const currentSessionId = "current-lead-session";
    const firstStart = start(undefined, makeContext(firstSessionId));
    await t.waitFor(() => assert.equal(widgets.length, 1));
    const secondStart = start(undefined, makeContext(currentSessionId));
    await t.waitFor(() => assert.equal(widgets.length, 2));

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
    const resolveInventory = (pending: (typeof pendingLists)[number]) =>
      pending.resolve(
        pending.signal?.aborted
          ? {
              stdout: "",
              stderr: "superseded inventory failed",
              code: 1,
            }
          : {
              stdout: JSON.stringify({
                id: 1,
                result: {
                  snapshot: { agents: [], panes: [], workspaces: [] },
                },
              }),
              stderr: "",
              code: 0,
            },
      );
    for (const pending of pendingLists.splice(0, 2)) resolveInventory(pending);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(widgets[1].render(120)[0], "● lead  unavailable");
    const resolvePendingLists = () => {
      for (const pending of pendingLists.splice(0)) resolveInventory(pending);
    };
    // Session startup also performs a recovery inventory after definitions resolve.
    for (let index = 0; index < 5; index++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      resolvePendingLists();
    }
    await Promise.all([firstStart, secondStart]);
    assert.ok(
      !pi.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_recovery_error",
      ),
      "a rejected superseded inventory is ignored rather than recorded as a recovery error",
    );
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

test("session-start roster uses current delegation policy and ignores superseded startup", async () => {
  const { createLeadSessionStartRuntime } = await import("./lead-runtime.ts");
  const { visibleAgentCapabilities } = await import("./agent-controller.ts");
  const rosterDefinitions: AgentDefinition[] = ["allowed", "other"].map(
    (name) => ({ name, path: `/${name}.md`, frontmatter: {}, body: "" }),
  );
  let resolveOldDefinitions!: (value: {
    definitions: AgentDefinition[];
    roleDefinitions: AgentDefinition[];
    projectTrusted: boolean;
  }) => void;
  const oldDefinitions = new Promise<{
    definitions: AgentDefinition[];
    roleDefinitions: AgentDefinition[];
    projectTrusted: boolean;
  }>((resolve) => (resolveOldDefinitions = resolve));
  let currentAbortController: AbortController | undefined;
  const recovered: string[] = [];
  const prepared: string[] = [];
  const published: string[] = [];
  const publishedRosters: string[][] = [];
  const pendingTransitions: boolean[] = [];
  const projectedPolicies: unknown[] = [];
  let managerActive = false;
  let delegationPolicy: "all" | ReadonlySet<string> = "all";
  const host = {
    diagnostic() {},
    controller: {
      abortSession() {
        currentAbortController?.abort();
      },
      clearPendingStarts() {},
      beginSession() {
        currentAbortController = new AbortController();
        return currentAbortController.signal;
      },
      sessionStart() {},
      recoverRuntimes(ctx: any, signal: AbortSignal) {
        assert.equal(signal.aborted, false);
        recovered.push(ctx.sessionManager.getSessionId());
      },
      startHealthScanner() {},
    },
    leadInboxRuntime: { beginSession() {}, start() {} },
    leadStatusRuntime: {
      prepareSession() {},
      prime() {},
      setSnapshot() {},
      start() {},
      requestRefresh() {},
    },
    isRoot: () => true,
    rootDelegationPolicy: () => delegationPolicy,
    isManagedAgent: () => false,
    clearLeadExecution() {},
    setLeadExecutionPending(pending: boolean) {
      pendingTransitions.push(pending);
    },
    hasLeadExecutionState: () => false,
    clearDefinitionRoster() {},
    clearChiefStartPreflight() {},
    roleTransitions: {
      beginSessionRole: () => ({
        previousChiefMode: "inactive",
        previousControllerRole: "lead",
      }),
      reconcileRoleTools() {},
      activeManager: () => managerActive,
      canRestoreChiefState: () => false,
      resolveControllerRole: async () => undefined,
      finalizeOptionalManagerStartup() {},
      suspendMalformedRole() {},
      shouldRestoreChief: () => false,
      chiefModeActive: () => false,
      chiefModeInactive: () => true,
      canStartChiefInbox: () => false,
      mayPublishLeadPresence: () => false,
      currentRoleGeneration: () => 0,
    },
    sessionLeadRoleState: () => undefined,
    normalizeBaseTools: (tools: string[]) => tools,
    normalizeLeadTools: (tools: string[]) => tools,
    setLeadTools() {},
    activeTools: () => [],
    failClosedRole: async () => undefined,
    publishLeadRole() {},
    activateChief: async () => undefined,
    restoreLeadExecution: async () => undefined,
    enterSuspended() {},
    enterLead() {},
    schedulePeerPresence: async () => undefined,
    herdRun: { restoreSession() {}, finishIfIdle() {} },
    queueLeadPresentation() {},
    setOwnTools() {},
    initialStatusBreadcrumb: () => [],
    ownToolsSnapshot: () => ({}),
    startSupervisionUI() {},
    discoverSessionDefinitions(ctx: any) {
      return ctx.sessionManager.getSessionId() === "old-session"
        ? oldDefinitions
        : Promise.resolve({
            definitions: rosterDefinitions,
            roleDefinitions: [],
            projectTrusted: true,
          });
    },
    prepareLeadExecution: async (ctx: any, signal: AbortSignal) => {
      assert.equal(signal.aborted, false);
      prepared.push(ctx.sessionManager.getSessionId());
    },
    visibleAgentCapabilities: async (
      ctx: any,
      definitions: AgentDefinition[] = [],
      policy: any,
    ) => {
      projectedPolicies.push(policy);
      return visibleAgentCapabilities(definitions, { kind: "root" }, policy);
    },
    setDefinitionRoster(roster: { sessionId: string; definitions: any[] }) {
      published.push(roster.sessionId);
      publishedRosters.push(roster.definitions.map(({ name }) => name));
    },
    appendRoleError() {},
    appendDefinitionError() {},
    autoActivateManager: () => false,
  } as any;
  const runtime = createLeadSessionStartRuntime(host);
  const contextFor = (sessionId: string) => {
    const ctx = fakeContext() as any;
    ctx.sessionManager = {
      ...ctx.sessionManager,
      getSessionId: () => sessionId,
    };
    return ctx;
  };
  const oldStart = runtime.sessionStart(contextFor("old-session"));
  const currentStart = runtime.sessionStart(contextFor("current-session"));
  await currentStart;
  resolveOldDefinitions({
    definitions: [],
    roleDefinitions: [],
    projectTrusted: true,
  });
  await oldStart;
  assert.deepEqual(recovered, ["current-session"]);
  assert.deepEqual(prepared, ["current-session"]);
  assert.deepEqual(published, ["current-session"]);
  assert.deepEqual(pendingTransitions, [true, true, false]);
  assert.deepEqual(projectedPolicies, ["all"]);
  assert.deepEqual(publishedRosters, [["allowed", "other"]]);

  delegationPolicy = new Set(["allowed"]);
  await runtime.sessionStart(contextFor("supervisor-root"));
  delegationPolicy = new Set();
  await runtime.sessionStart(contextFor("unverified-root"));
  assert.deepEqual(projectedPolicies, ["all", new Set(["allowed"]), new Set()]);
  assert.deepEqual(publishedRosters, [["allowed", "other"], ["allowed"], []]);

  managerActive = true;
  await runtime.sessionStart(contextFor("restored-manager-session"));
  assert.deepEqual(recovered, [
    "current-session",
    "supervisor-root",
    "unverified-root",
    "restored-manager-session",
  ]);
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
  let refreshTimer: TimerHandler | undefined;
  const intervalDelays: number[] = [];
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    refreshTimer = callback;
    if (delay !== undefined) intervalDelays.push(delay);
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
                workspaces: [],
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
  assert.ok(
    intervalDelays.includes(10_000),
    "status reconciles every 10 seconds",
  );
  assert.ok(calls.some((args) => args[0] === "api" && args[1] === "snapshot"));
  assert.ok(
    pi.execOptions.some((options) => options.timeout === 30_000),
    "direct Herdr status polling must have a finite timeout",
  );
  const rendered = widget.render(160).join("\n");
  assert.match(rendered, /1 working/);
  assert.match(rendered, /sleep-smoke-a/);
  assert.doesNotMatch(rendered, /\[read, bash, ask_owner\]/);
  const promptEvent = {
    systemPrompt: "base",
    systemPromptOptions: { sections: {}, contextFiles: [] },
  };
  await pi.events.get("before_agent_start")![0](promptEvent, context);
  assert.match(
    promptEvent.systemPromptOptions.sections.agent_definitions,
    /"name":\s*"agent"/,
    "session-start roster should be available to the Lead prompt",
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
    listed.details.agent_definitions.some(
      (definition: any) => definition.name === "agent",
    ),
    "list agents should continue to expose discovered definitions",
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
          workspaces: [],
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
      result: { snapshot: { agents: [], panes: [], workspaces: [] } },
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
  const previousPlacement = readConfig().spawnPlacement;
  const label = "fresh-start-widget-agent";
  let sessionPath = "";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const agentsDir = PI_AGENTS_DIR;
  const definitionPath = `${agentsDir}/agent.md`;
  let hadAgentsDir = false;
  let hadDefinition = false;
  let previousDefinition: string | undefined;
  let requestedCwd = "";
  let pi: ReturnType<typeof fakePi> | undefined;
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
          workspaces: [],
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
  let widget: StatusWidget | undefined;
  try {
    setLeadEnvironment();
    resetAgentMailbox(mailbox);
    updateConfig("spawnPlacement", "subtree");
    sessionPath = join(tmpdir(), `pi-herdsman-${label}-${randomUUID()}.jsonl`);
    realFs.writeFileSync(
      sessionPath,
      JSON.stringify({
        type: "session",
        id: DEFAULT_PI_SESSION_ID,
      }),
      "utf8",
    );
    hadAgentsDir = realFs.existsSync(agentsDir);
    hadDefinition = realFs.existsSync(definitionPath);
    previousDefinition = hadDefinition
      ? realFs.readFileSync(definitionPath, "utf8")
      : undefined;
    realFs.mkdirSync(agentsDir, { recursive: true });
    realFs.writeFileSync(
      definitionPath,
      "---\nname: agent\ninheritProjectContext: true\ninheritGlobalContext: false\n---\nagent instructions\n",
    );
    assert.equal(
      discoverAgent("agent").frontmatter.inheritProjectContext,
      true,
    );
    assert.equal(
      discoverAgent("agent").frontmatter.inheritGlobalContext,
      false,
    );
    requestedCwd = realFs.mkdtempSync(
      join(tmpdir(), "pi-herdsman-requested-cwd-"),
    );
    const projectContextPath = join(requestedCwd, "AGENTS.md");
    realFs.writeFileSync(projectContextPath, "requested-CWD project context\n");
    const { agentLaunchArgs } = await import("./agent-definitions.ts");
    const discoveredCwds: string[] = [];
    const contextArgs = agentLaunchArgs(discoverAgent("agent"), {
      bodyPromptPath: "/tmp/agent-prompt.md",
      cwd: requestedCwd,
      loadProjectContextFiles: ({ cwd }) => {
        discoveredCwds.push(cwd);
        return [
          {
            path: projectContextPath,
            content: "requested-CWD project context",
          },
        ];
      },
    });
    assert.deepEqual(discoveredCwds, [requestedCwd]);
    assert.ok(
      contextArgs.includes(projectContextPath),
      "project context discovered at requestedCwd should be appended to launch args",
    );
    herdrAgent.agent_session.value = sessionPath;
    herdrAgent.cwd = requestedCwd;
    pi = fakePi({
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
            herdrAgent.name = runScopedHerdrAlias(
              WORKSPACE,
              label,
              startedRunId,
            );
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
    const launch = pi.calls.find(
      (args) => args[0] === "agent" && args[1] === "start",
    );
    assert.ok(launch, JSON.stringify(pi.calls));
    assert.ok(launch.includes("--approve"), "trusted cwd should be approved");
    assert.equal(
      pi.calls.some((args) => args[0] === "pane" && args[1] === "split"),
      false,
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
    await pi?.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    if (sessionPath) realFs.rmSync(sessionPath, { force: true });
    if (requestedCwd)
      realFs.rmSync(requestedCwd, { recursive: true, force: true });
    if (hadDefinition && previousDefinition !== undefined)
      realFs.writeFileSync(definitionPath, previousDefinition!);
    else if (hadAgentsDir) realFs.rmSync(definitionPath, { force: true });
    else realFs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test("Manager initialization recovers messages before topology and reports recovery failures without skipping reconciliation", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  for (const recoveryFails of [false, true]) {
    const sessionId = randomUUID();
    const descriptor = {
      piSessionId: sessionId,
      repoKey: "repo-key",
      workspaceId: WORKSPACE,
    };
    const events: string[] = [];
    const host: any = {
      pi: fakePi().pi,
      workspaceId: () => WORKSPACE,
      worktreeGroupScope: async () => {
        events.push("scope topology");
        throw new Error("first topology unavailable");
      },
      supervisionRuntime: () => ({}),
      readManagerDescriptorStatus: () => ({ live: true, descriptor }),
      readLeadCoordinationState: () => ({
        role: "manager",
        piSessionId: sessionId,
      }),
      requireCompatibleBuild: () => {},
      sameManagerDescriptor: () => true,
      recoverStaleProjectMessages: (_runtime: unknown, repoKey: string) => {
        assert.equal(repoKey, "repo-key");
        events.push("recovery");
        if (recoveryFails) throw new Error("uncertain message storage");
      },
      appendDurableError: (
        _pi: unknown,
        _ctx: unknown,
        type: string,
        error: Error,
      ) => {
        assert.equal(type, "pi_herdsman_state_error");
        assert.match(error.message, /uncertain message storage/);
        events.push("error");
      },
      runHerdr: async () => {
        events.push("topology");
        throw new Error("topology unavailable");
      },
    };
    const transitions = createLeadRoleTransitions(
      {
        controllerRole: "manager",
        chiefMode: "inactive",
        roleSuspended: false,
        managerLease: { descriptor },
      } as any,
      host,
    );
    const ctx: any = fakeContext();
    ctx.sessionManager.getSessionId = () => sessionId;
    await assert.rejects(
      () => transitions.reconcileCurrentManagerAssignments(ctx),
      /topology unavailable/,
    );
    assert.deepEqual(
      events,
      recoveryFails
        ? ["recovery", "error", "topology"]
        : ["recovery", "topology"],
    );
  }
});

test("Manager initialization cannot recover messages under stale or invalid local authority", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  for (const scenario of [
    "role",
    "suspended",
    "missing lease",
    "session",
    "workspace",
    "missing descriptor",
    "dead descriptor",
    "replacement",
    "repository",
    "coordinator",
    "build",
  ] as const) {
    const sessionId = randomUUID();
    const descriptor = {
      piSessionId: sessionId,
      repoKey: "repo-key",
      workspaceId: WORKSPACE,
    };
    let recovered = false;
    const host: any = {
      workspaceId: () =>
        scenario === "workspace" ? "other-workspace" : WORKSPACE,
      supervisionRuntime: () => ({}),
      readManagerDescriptorStatus: () =>
        scenario === "missing descriptor"
          ? undefined
          : {
              live: scenario !== "dead descriptor",
              descriptor:
                scenario === "repository"
                  ? { ...descriptor, repoKey: "other-repo" }
                  : descriptor,
            },
      readLeadCoordinationState: () =>
        scenario === "coordinator"
          ? undefined
          : { role: "manager", piSessionId: sessionId },
      requireCompatibleBuild: () => {
        if (scenario === "build") throw new Error("incompatible build");
      },
      sameManagerDescriptor: () =>
        scenario !== "replacement" && scenario !== "repository",
      recoverStaleProjectMessages: () => {
        recovered = true;
      },
      appendDurableError: () =>
        assert.fail("unauthorized recovery must not start"),
      worktreeGroupScope: () =>
        assert.fail("authorization must not query topology"),
      runHerdr: () =>
        assert.fail("invalid authority must not reconcile topology"),
    };
    const transitions = createLeadRoleTransitions(
      {
        controllerRole: scenario === "role" ? "lead" : "manager",
        chiefMode: "inactive",
        roleSuspended: scenario === "suspended",
        managerLease: scenario === "missing lease" ? undefined : { descriptor },
      } as any,
      host,
    );
    const ctx: any = fakeContext();
    ctx.sessionManager.getSessionId = () =>
      scenario === "session" ? randomUUID() : sessionId;
    if (["coordinator", "build"].includes(scenario))
      await assert.rejects(() =>
        transitions.reconcileCurrentManagerAssignments(ctx),
      );
    else await transitions.reconcileCurrentManagerAssignments(ctx);
    assert.equal(recovered, false, scenario);
  }
});

test("project assignment lock waits are bounded, cancellable, and revalidate after acquisition", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  const runtime = supervisionRuntime(
    `/tmp/assignment-wait-${randomUUID()}.sock`,
  );
  const repoKey = "wait-test";
  const branch = "feature";
  const assignmentPath = projectAssignmentPath(runtime, repoKey, branch);
  const lockPath = `${assignmentPath}.lock`;
  const makeTransitions = (extra: Record<string, unknown> = {}) =>
    createLeadRoleTransitions(
      { controllerRole: "lead" } as any,
      {
        supervisionRuntime: () => runtime,
        projectAssignmentPath,
        acquireProcessLock,
        delay: (
          ms: number,
          value: unknown,
          options: { signal?: AbortSignal },
        ) =>
          import("node:timers/promises").then(({ setTimeout }) =>
            setTimeout(ms, value, options),
          ),
        ...extra,
      } as any,
    );

  const timeoutLease = acquireProcessLock(lockPath, {
    name: "project assignment lock",
  });
  let mutated = false;
  const timeoutTransitions = makeTransitions();
  try {
    await assert.rejects(
      timeoutTransitions.withProjectAssignmentLock(repoKey, branch, () => {
        mutated = true;
      }),
      (error: unknown) =>
        error instanceof ProcessLockOccupiedError &&
        error.code === "PROCESS_LOCK_OCCUPIED",
    );
    assert.equal(mutated, false);
    assert.equal(readLiveProcessLock(lockPath).id, timeoutLease.claim.id);
  } finally {
    timeoutLease.release();
  }
  assert.equal(existsSync(lockPath), false);

  let delayedLease = acquireProcessLock(lockPath, {
    name: "project assignment lock",
  });
  let delayedMutation = false;
  const delayedTransitions = makeTransitions({
    delay: async (
      _ms: number,
      value: unknown,
      options: { signal?: AbortSignal },
    ) => {
      setTimeout(() => delayedLease.release(), 10);
      const { setTimeout: wait } = await import("node:timers/promises");
      return wait(2_050, value, options);
    },
  });
  await assert.rejects(
    delayedTransitions.withProjectAssignmentLock(repoKey, branch, () => {
      delayedMutation = true;
    }),
    (error: unknown) =>
      error instanceof ProcessLockOccupiedError &&
      error.code === "PROCESS_LOCK_OCCUPIED",
  );
  assert.equal(delayedMutation, false);
  assert.equal(existsSync(lockPath), false);

  const cancelLease = acquireProcessLock(lockPath, {
    name: "project assignment lock",
  });
  const controller = new AbortController();
  let cancelBlocked!: () => void;
  let releaseCancelBlock!: () => void;
  const blockedOnLock = new Promise<void>((resolve) => {
    cancelBlocked = resolve;
  });
  const cancelBlock = new Promise<void>((resolve) => {
    releaseCancelBlock = resolve;
  });
  const cancelTransitions = makeTransitions({
    afterProjectAssignmentLockOccupied: async () => {
      cancelBlocked();
      await cancelBlock;
    },
  });
  mutated = false;
  const cancellation = assert.rejects(
    cancelTransitions.withProjectAssignmentLock(
      repoKey,
      branch,
      () => {
        mutated = true;
      },
      controller.signal,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  try {
    await blockedOnLock;
    controller.abort();
    releaseCancelBlock();
    await cancellation;
    assert.equal(mutated, false);
    assert.equal(readLiveProcessLock(lockPath).id, cancelLease.claim.id);
  } finally {
    releaseCancelBlock();
    cancelLease.release();
  }
  assert.equal(existsSync(lockPath), false);

  const heldLease = acquireProcessLock(lockPath, {
    name: "project assignment lock",
  });
  let signalWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    signalWaiting = resolve;
  });
  let authority = {
    id: "original",
    piSessionFile: undefined as string | undefined,
  };
  const authorityTransitions = makeTransitions({
    afterProjectAssignmentLockOccupied: async () => signalWaiting(),
  });
  const operation = authorityTransitions.withProjectAssignmentLock(
    repoKey,
    branch,
    () => {
      if (authority.id !== "original")
        throw new Error("Project assignment changed during Lead activation");
      authority = { ...authority, piSessionFile: "/should-not-bind" };
    },
  );
  try {
    await waiting;
    authority = { id: "replacement", piSessionFile: undefined };
  } finally {
    heldLease.release();
  }
  await assert.rejects(operation, /assignment changed/);
  assert.deepEqual(authority, { id: "replacement", piSessionFile: undefined });
  assert.equal(existsSync(lockPath), false);
});

test("current project handoff publishes despite unrelated global authority contention and survives recovery", async () => {
  const { createLeadRoleTransitions } = await import("./lead-runtime.ts");
  const {
    writeProjectMessage,
    readProjectAssignment,
    listProjectMessageHeaders,
    readProjectMessage,
    projectAssignmentAuthorityLockPath,
    writeProjectAssignment,
  } = await import("./supervision.ts");
  const runtime = supervisionRuntime(`/tmp/publication-${randomUUID()}.sock`);
  const assignment = {
    version: 2 as const,
    id: randomUUID(),
    repoKey: "publication",
    branch: "feature",
    text: "task",
  };
  writeProjectAssignment(runtime, assignment);
  const stale = {
    version: 2 as const,
    id: randomUUID(),
    repoKey: assignment.repoKey,
    branch: assignment.branch,
    fromSessionId: randomUUID(),
    text: "retired handoff ".repeat(1_000),
    createdAt: 1,
  };
  writeProjectMessage(stale, runtime);
  const assignmentPath = projectAssignmentPath(
    runtime,
    assignment.repoKey,
    assignment.branch,
  );
  writeFileSync(
    join(
      dirname(assignmentPath),
      `${basename(assignmentPath, ".json")}.messages`,
      `${stale.id}.json.body`,
    ),
    "corrupt",
  );
  let branchLocks = 0;
  let cancelSignal: AbortController | undefined;
  const transitions = createLeadRoleTransitions(
    { controllerRole: "lead" } as any,
    {
      supervisionRuntime: () => runtime,
      readProjectAssignment,
      projectAssignmentPath,
      acquireProcessLock: (...args: Parameters<typeof acquireProcessLock>) => {
        branchLocks++;
        return acquireProcessLock(...args);
      },
      delay: (ms: number, value: unknown, options: { signal?: AbortSignal }) =>
        import("node:timers/promises").then(({ setTimeout }) =>
          setTimeout(ms, value, options),
        ),
      afterProjectAssignmentLockOccupied: async () => cancelSignal?.abort(),
      prepareCoordinationInput: async (_ctx: unknown, text: string) => ({
        text,
        resultBindings: [],
      }),
      writeProjectMessage,
      listProjectMessageHeaders,
      readProjectMessage,
    } as any,
  );
  const ctx: any = fakeContext();
  ctx.sessionManager.getSessionId = () => assignment.id;
  const global = acquireProcessLock(projectAssignmentAuthorityLockPath(), {
    name: "unrelated authority operation",
  });
  let published;
  try {
    published = await transitions.publishProjectMessage(
      ctx,
      assignment,
      "handoff",
    );
    assert.ok(published);
    assert.deepEqual(
      listProjectMessageHeaders(
        runtime,
        assignment.repoKey,
        assignment.branch,
      ).map(({ id }) => id),
      [stale.id, published.id],
    );
    assert.equal(branchLocks, 1);
  } finally {
    global.release();
  }
  assert.deepEqual(
    listProjectMessageHeaders(
      runtime,
      assignment.repoKey,
      assignment.branch,
    ).map(({ id }) => id),
    [stale.id, published.id],
    "publishing does not consume unrelated pending records",
  );
  assert.equal(
    published.fromSessionId,
    assignment.id,
    "the existing exact-assignment delivery predicate accepts the handoff",
  );

  const cancelledAssignment = {
    ...assignment,
    id: randomUUID(),
    branch: "cancelled-message",
  };
  writeProjectAssignment(runtime, cancelledAssignment);
  const cancelledLockPath = `${projectAssignmentPath(
    runtime,
    cancelledAssignment.repoKey,
    cancelledAssignment.branch,
  )}.lock`;
  const cancelledLock = acquireProcessLock(cancelledLockPath, {
    name: "project assignment lock",
  });
  const controller = new AbortController();
  cancelSignal = controller;
  ctx.sessionManager.getSessionId = () => cancelledAssignment.id;
  try {
    await assert.rejects(
      transitions.publishProjectMessage(
        ctx,
        cancelledAssignment,
        "must not publish after cancellation",
        [],
        undefined,
        undefined,
        undefined,
        controller.signal,
      ),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.deepEqual(
      listProjectMessageHeaders(
        runtime,
        cancelledAssignment.repoKey,
        cancelledAssignment.branch,
      ),
      [],
    );
    assert.equal(
      readLiveProcessLock(cancelledLockPath).id,
      cancelledLock.claim.id,
    );
  } finally {
    cancelledLock.release();
    cancelSignal = undefined;
  }
  assert.equal(existsSync(cancelledLockPath), false);
});
