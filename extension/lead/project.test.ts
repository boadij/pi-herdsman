import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AGENT_ID,
  HERDSMAN_BUILD,
  PI_AGENT_ROOT,
  WORKSPACE,
  fakeContext,
  nativeSessions,
  realFs,
} from "../support.ts";
import { rememberCoordinatorTarget } from "../coordinator-target.ts";
import { coordinatorAdmissionClaimIsCurrent } from "../lock.ts";
import { OperationError } from "../errors.ts";
import {
  herdsmanDataRoot,
  persistRequiredEvidenceSnapshot,
  readRequiredEvidenceSnapshot,
} from "../storage.ts";

const {
  createLeadProjectRuntime,
  isFreshLeadStartupAttestation,
  parseGitWorktreeInventory,
  captureSenderEnvironment,
} = await import("./project.ts");
const {
  COORDINATOR_DEFINITION_ENTRY,
  EXPECTED_ASSIGNED_LEAD_DEFINITION_ENV,
  consumeCoordinatorStartIntent,
  getCoordinatorStartIntent,
  listCoordinatorStartIntents,
  readProjectAssignment,
  writeProjectAssignment,
} = await import("../supervision.ts");
const { claimManagerLease, supervisionRuntime } =
  await import("../supervision.ts");
const { getAgentDir, ProjectTrustStore, SessionManager, SettingsManager } =
  await import("@earendil-works/pi-coding-agent");
const {
  HerdrStartFailure,
  herdrAgentAlias,
  herdrSessionId,
  sameObservedSessionPath,
  sessionIdentity,
  startHerdrCoordinatorInPane,
} = await import("../herdr.ts");

const lifecycleStop = "stop after assignment publication";

test.before(() => {
  process.env.HERDR_SOCKET_PATH = join(PI_AGENT_ROOT, "test-herdr.sock");
});

function removeHerdrIntegrationForTest(t: TestContext) {
  const integrationPath = join(
    resolve(getAgentDir()),
    "extensions",
    "herdr-agent-state.ts",
  );
  const savedPath = `${integrationPath}.disabled`;
  realFs.renameSync(integrationPath, savedPath);
  t.after(() => realFs.renameSync(savedPath, integrationPath));
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.detail.category, "invalid_request");
    assert.equal(error.detail.operation, "preflight");
    assert.ok(error.message.includes(integrationPath));
    assert.match(error.detail.nextAction ?? "", /herdr integration install pi/);
    assert.match(error.message, /herdr integration install pi/);
    return true;
  };
}

test("Lead startup attestation requires the exact session and a fresh generation", () => {
  const priorGeneration = randomUUID();
  const fresh = {
    instanceId: randomUUID(),
    piSessionId: "assigned-session",
    updatedAt: 101,
    startupAttestation: {
      kind: "model_restore",
      assignmentId: "assigned-session",
      generation: "",
      result: "verified",
    },
  };
  fresh.startupAttestation.generation = fresh.instanceId;
  assert.equal(
    isFreshLeadStartupAttestation(
      fresh,
      "assigned-session",
      priorGeneration,
      100,
    ),
    true,
  );
  assert.equal(
    isFreshLeadStartupAttestation(
      {
        instanceId: fresh.instanceId,
        piSessionId: fresh.piSessionId,
        updatedAt: fresh.updatedAt,
      },
      "assigned-session",
      priorGeneration,
      100,
    ),
    false,
  );
  assert.equal(
    isFreshLeadStartupAttestation(
      { ...fresh, piSessionId: "other-session" },
      "assigned-session",
      priorGeneration,
      100,
    ),
    false,
  );
  assert.equal(
    isFreshLeadStartupAttestation(
      {
        ...fresh,
        startupAttestation: {
          ...fresh.startupAttestation,
          assignmentId: "other-session",
        },
      },
      "assigned-session",
      priorGeneration,
      100,
    ),
    false,
  );
  assert.equal(
    isFreshLeadStartupAttestation(
      { ...fresh, instanceId: priorGeneration },
      "assigned-session",
      priorGeneration,
      100,
    ),
    false,
  );
  assert.equal(
    isFreshLeadStartupAttestation(
      { ...fresh, updatedAt: 99 },
      "assigned-session",
      priorGeneration,
      100,
    ),
    false,
  );
  assert.equal(
    isFreshLeadStartupAttestation(
      {
        ...fresh,
        startupAttestation: {
          ...fresh.startupAttestation,
          generation: priorGeneration,
        },
      },
      "assigned-session",
      priorGeneration,
      100,
    ),
    false,
  );
});

function settingsSessionProof(ctx: any) {
  let agent: any = {
    pane_id: "pane",
    tab_id: "tab",
    workspace_id: "workspace",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: ctx.sessionManager.getSessionId(),
    },
  };
  let extraAgents: any[] = [];
  return {
    setAgent(value: any) {
      agent = value;
    },
    setExtraAgents(value: any[]) {
      extraAgents = value;
    },
    host: {
      listAgents: async () => ({
        agents: [...(agent ? [agent] : []), ...extraAgents],
      }),
      runHerdr: async () => ({ agent }),
      isPiAgent: (value: any) => value?.agent_session?.source === "herdr:pi",
      expectedSession: (id: string, path?: string) => ({ id, path }),
    },
  };
}

test("repository settings work without Manager and revalidate identity and policy", async () => {
  const { isWorktreeRemovalPreapproved, setWorktreeRemovalPreapproved } =
    await import("../config.ts");
  const repoKey = `/verified-${randomUUID()}`;
  const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
  const previousPane = process.env.HERDR_PANE_ID;
  const previousTab = process.env.HERDR_TAB_ID;
  process.env.HERDR_WORKSPACE_ID = "workspace";
  process.env.HERDR_PANE_ID = "pane";
  process.env.HERDR_TAB_ID = "tab";
  const ctx = fakeContext() as any;
  const proof = settingsSessionProof(ctx);
  ctx.hasUI = true;
  let checkoutPath = "/checkout";
  let confirm = async () => true;
  let confirmations = 0;
  ctx.ui.confirm = async (_title: string, message: string) => {
    assert.ok(message.includes(repoKey));
    confirmations++;
    return confirm();
  };
  const runtime = createLeadProjectRuntime({
    pi: {},
    leadRuntime: {},
    activeRole: () => "lead",
    ...proof.host,
    localRepositoryScope: async () => ({
      repoKey,
      repoName: "repo",
      checkoutPath,
      isPrimary: true,
    }),
  } as any);
  try {
    const policy = await runtime.getRemovalPreauthorization(ctx);
    assert.equal(policy.enabled, false);
    const matchingAgent = {
      pane_id: "pane",
      tab_id: "tab",
      workspace_id: "workspace",
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: ctx.sessionManager.getSessionId(),
      },
    };
    for (const conflicting of [
      { ...matchingAgent, workspace_id: "other" },
      { ...matchingAgent, pane_id: "other" },
      { ...matchingAgent, tab_id: "other" },
      {
        ...matchingAgent,
        agent_session: { ...matchingAgent.agent_session, value: "other" },
      },
      undefined,
    ]) {
      proof.setAgent(conflicting);
      await assert.rejects(
        runtime.getRemovalPreauthorization(ctx),
        /identity.*(conflicting|unavailable)/,
      );
    }
    proof.setAgent(matchingAgent);
    for (const field of ["pane_id", "tab_id", "workspace_id"] as const) {
      const malformed = { ...matchingAgent, [field]: undefined };
      proof.setExtraAgents([malformed]);
      await assert.rejects(
        runtime.getRemovalPreauthorization(ctx),
        /identity.*conflicting/,
      );
      await assert.rejects(
        runtime.setRemovalPreauthorization(true, ctx, policy.identity),
        /identity.*conflicting/,
      );
      assert.equal(isWorktreeRemovalPreapproved(repoKey), false);
    }
    proof.setExtraAgents([]);
    ctx.hasUI = false;
    await assert.rejects(
      runtime.setRemovalPreauthorization(true, ctx),
      /interactive/,
    );
    ctx.hasUI = true;
    confirm = async () => false;
    assert.equal(
      await runtime.setRemovalPreauthorization(true, ctx, policy.identity),
      false,
    );
    assert.equal(isWorktreeRemovalPreapproved(repoKey), false);
    confirm = async () => {
      checkoutPath = "/changed";
      return true;
    };
    await assert.rejects(
      runtime.setRemovalPreauthorization(true, ctx, policy.identity),
      /changed/,
    );
    assert.equal(isWorktreeRemovalPreapproved(repoKey), false);
    checkoutPath = "/checkout";
    confirm = async () => {
      proof.setExtraAgents([{ ...matchingAgent, pane_id: undefined }]);
      return true;
    };
    await assert.rejects(
      runtime.setRemovalPreauthorization(true, ctx, policy.identity),
      /identity.*conflicting/,
    );
    assert.equal(isWorktreeRemovalPreapproved(repoKey), false);
    proof.setExtraAgents([]);
    confirm = async () => {
      proof.setAgent(undefined);
      return true;
    };
    await assert.rejects(
      runtime.setRemovalPreauthorization(true, ctx, policy.identity),
      /identity.*unavailable/,
    );
    assert.equal(isWorktreeRemovalPreapproved(repoKey), false);
    proof.setAgent(matchingAgent);
    confirm = async () => true;
    assert.equal(
      await runtime.setRemovalPreauthorization(true, ctx, policy.identity),
      true,
    );
    const count = confirmations;
    assert.equal(
      await runtime.setRemovalPreauthorization(true, ctx, policy.identity),
      true,
    );
    assert.equal(confirmations, count);
    assert.equal(
      await runtime.setRemovalPreauthorization(false, ctx, policy.identity),
      true,
    );
    assert.equal(isWorktreeRemovalPreapproved(repoKey), false);
  } finally {
    if (isWorktreeRemovalPreapproved(repoKey))
      setWorktreeRemovalPreapproved(repoKey, false);
    if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousTab === undefined) delete process.env.HERDR_TAB_ID;
    else process.env.HERDR_TAB_ID = previousTab;
  }
});

test("repository integration grants require confirmation and reject stale policy or identity", async () => {
  const { readConfig, setManagerMergeOverride } = await import("../config.ts");
  const repoKey = `/verified-${randomUUID()}`;
  const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
  const previousPane = process.env.HERDR_PANE_ID;
  const previousTab = process.env.HERDR_TAB_ID;
  process.env.HERDR_WORKSPACE_ID = "workspace";
  process.env.HERDR_PANE_ID = "pane";
  process.env.HERDR_TAB_ID = "tab";
  const ctx = fakeContext() as any;
  const proof = settingsSessionProof(ctx);
  ctx.hasUI = true;
  let checkoutPath = "/checkout";
  let confirm = async () => false;
  ctx.ui.confirm = async (title: string) => {
    assert.ok(title.includes(repoKey));
    return confirm();
  };
  const runtime = createLeadProjectRuntime({
    pi: {},
    leadRuntime: {},
    activeRole: () => "lead",
    ...proof.host,
    localRepositoryScope: async () => ({
      repoKey,
      repoName: "repo",
      checkoutPath,
      isPrimary: true,
    }),
  } as any);
  try {
    const { identity } = await runtime.getRemovalPreauthorization(ctx);
    const global = readConfig().managerMergeEnabled;
    setManagerMergeOverride(repoKey, false);
    const expected = { global, override: false as const };
    assert.equal(
      await runtime.setRepositoryMergeOverride(true, ctx, identity, expected),
      false,
    );
    assert.equal(readConfig().managerMergeOverrides[repoKey], false);
    confirm = async () => {
      checkoutPath = "/other";
      return true;
    };
    await assert.rejects(
      runtime.setRepositoryMergeOverride(true, ctx, identity, expected),
      /changed/,
    );
    checkoutPath = "/checkout";
    confirm = async () => {
      proof.setExtraAgents([
        {
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: ctx.sessionManager.getSessionId(),
          },
        },
      ]);
      return true;
    };
    await assert.rejects(
      runtime.setRepositoryMergeOverride(true, ctx, identity, expected),
      /identity.*conflicting/,
    );
    assert.equal(readConfig().managerMergeOverrides[repoKey], false);
    proof.setExtraAgents([]);
    confirm = async () => {
      proof.setAgent(undefined);
      return true;
    };
    await assert.rejects(
      runtime.setRepositoryMergeOverride(true, ctx, identity, expected),
      /identity.*unavailable/,
    );
    assert.equal(readConfig().managerMergeOverrides[repoKey], false);
    proof.setAgent({
      pane_id: "pane",
      tab_id: "tab",
      workspace_id: "workspace",
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: ctx.sessionManager.getSessionId(),
      },
    });
    confirm = async () => {
      setManagerMergeOverride(repoKey, "divergent");
      return true;
    };
    await assert.rejects(
      runtime.setRepositoryMergeOverride(true, ctx, identity, expected),
      /policy changed/,
    );
    assert.equal(readConfig().managerMergeOverrides[repoKey], "divergent");
    ctx.hasUI = false;
    await assert.rejects(
      runtime.setRepositoryMergeOverride(true, ctx, identity, expected),
      /interactive/,
    );
  } finally {
    setManagerMergeOverride(repoKey, undefined);
    if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
    if (previousTab === undefined) delete process.env.HERDR_TAB_ID;
    else process.env.HERDR_TAB_ID = previousTab;
  }
});

test("stop Lead observes liveness after waiting for project-work serialization", async () => {
  const ctx = fakeContext() as any;
  const manager = {
    repoKey: "/verified-repo",
    workspaceId: "manager-workspace",
    piSessionId: "manager-session",
    leaseId: "lease",
  };
  const assignment = {
    version: 2 as const,
    id: "lead-session",
    repoKey: manager.repoKey,
    branch: "feature/stop",
    text: "work",
  };
  const lead = {
    workspace_id: "lead-workspace",
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    agent_session: { value: assignment.id },
  } as any;
  let queued!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (queued = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let waitingForProjectWork = false;
  let liveCalls = 0;
  let quiescedWorkspace: string | undefined;
  let runtime: ReturnType<typeof createLeadProjectRuntime>;
  runtime = createLeadProjectRuntime({
    activeRole: () => "manager",
    leadRuntime: { roleSuspended: false },
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: () => true,
    supervisionRuntime: () => ({}),
    findProjectAssignmentBySession: () => [assignment],
    readProjectAssignment: () => assignment,
    loadSupervisionSnapshot: async () => ({
      work: [
        {
          branch: assignment.branch,
          session: assignment.id,
          status: "active",
        },
      ],
      incompatible: [],
      leads: [
        {
          session: assignment.id,
          paneId: lead.pane_id,
          workspaceId: lead.workspace_id,
          tabId: lead.tab_id,
          instanceId: "lead-instance",
          relationship: "assigned",
          branch: assignment.branch,
        },
      ],
    }),
    directReports: async () => [
      {
        lead: assignment.id,
        paneId: lead.pane_id,
        workspaceId: lead.workspace_id,
        tabId: lead.tab_id,
        instanceId: "lead-instance",
        relationship: "assigned",
        branch: assignment.branch,
        availableActions: ["stop"],
      },
    ],
    worktreeGroupScope: async () => ({
      repoKey: manager.repoKey,
      workspaceIds: [lead.workspace_id],
    }),
    liveLead: async () => {
      liveCalls++;
      return waitingForProjectWork ? [] : liveCalls <= 2 ? [lead] : [];
    },
    readLeadCoordinationState: () => ({
      instanceId: "lead-instance",
      build: HERDSMAN_BUILD,
    }),
    requireCompatibleBuild: () => {},
    withProjectWorkLock: async (
      _key: string,
      operation: () => Promise<any>,
    ) => {
      waitingForProjectWork = true;
      queued();
      await gate;
      waitingForProjectWork = false;
      return operation();
    },
    withQuiescedTree: async (
      _ctx: unknown,
      _session: string,
      workspaceId: string,
      operation: (held: ReadonlySet<string>) => Promise<unknown>,
    ) => {
      quiescedWorkspace = workspaceId;
      return operation(new Set());
    },
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => Promise<unknown>,
    ) => operation(),
    stopOwnedAgentsForSession: async () => ({ complete: true, closures: [] }),
    stopProjectLeadPane: async () => {},
    stopProjectLead: (...args: Parameters<typeof runtime.stop>) =>
      runtime.stop(...args),
  } as any);

  const stopping = runtime.executeStaff(
    "stop",
    { action: "stop", branch: assignment.branch },
    undefined,
    undefined,
    ctx,
  );
  await waiting;
  assert.equal(liveCalls, 0, "liveness preflight must wait in the work queue");
  release();
  const result = await stopping;
  assert.equal(result.details.ok, true);
  assert.equal(quiescedWorkspace, lead.workspace_id);
  assert.equal(liveCalls, 3);
});

test("staff message rejects an identity change during attachment preparation", async () => {
  const entries: SessionEntry[] = [];
  const ctx = fakeContext(entries) as any;
  const pi = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({
        type: "custom",
        id: randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      } satisfies SessionEntry),
  };
  const session = randomUUID();
  const target = rememberCoordinatorTarget(pi as any, ctx, "lead", session);
  const authority = {
    leaseId: "lease",
    repoKey: "/repo",
    piSessionId: randomUUID(),
  };
  let paneId = "original";
  let release!: () => void;
  let started!: () => void;
  const preparing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const runtime = createLeadProjectRuntime({
    pi,
    leadRuntime: {},
    activeRole: () => "manager",
    currentManager: async () => authority,
    managerLease: () => ({ descriptor: authority }),
    supervisionRuntime: () => ({}),
    directReports: async () => [
      {
        lead: session,
        paneId,
        workspaceId: "workspace",
        tabId: "tab",
        instanceId: "instance",
        relationship: "supervised",
        availableActions: ["message"],
      },
    ],
    findProjectAssignmentBySession: () => [],
    resolveMessageFiles: () => ["attachment"],
    prepareCoordinationInput: async () => {
      started();
      await resume;
      return { text: "message", resultBindings: [] };
    },
    writeChiefMessage: () => {
      writes++;
    },
  } as any);
  const operation = runtime.executeStaff(
    "message",
    { action: "message", target, message: "message", files: ["attachment"] },
    undefined,
    undefined,
    ctx,
  );
  await preparing;
  paneId = "changed";
  release();
  await assert.rejects(operation, /changed before the message was queued/);
  assert.equal(writes, 0);
});

test("staff handoff reports failure after required evidence retention commits", async () => {
  const entries: SessionEntry[] = [];
  const ctx = fakeContext(entries) as any;
  const pi = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({
        type: "custom",
        id: randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      } satisfies SessionEntry),
  };
  const session = randomUUID();
  const manager = {
    leaseId: "lease",
    repoKey: "/repo",
    workspaceId: "workspace",
    piSessionId: randomUUID(),
  };
  const assignment = {
    version: 2 as const,
    id: session,
    repoKey: manager.repoKey,
    branch: "feature/assigned",
    text: "task",
  };
  const retained = persistRequiredEvidenceSnapshot(
    assignment.id,
    "proof.md",
    "retained proof",
  );
  let currentAssignment: import("../supervision.ts").ProjectAssignment =
    assignment;
  let evidenceCalls = 0;
  const runtime = createLeadProjectRuntime({
    pi,
    leadRuntime: { roleSuspended: false },
    activeRole: () => "manager",
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: () => true,
    supervisionRuntime: () => ({}),
    loadSupervisionSnapshot: async () => ({
      work: [
        { branch: assignment.branch, session: assignment.id, status: "active" },
      ],
      incompatible: [],
      leads: [
        {
          session,
          paneId: "pane",
          workspaceId: "workspace",
          tabId: "tab",
          instanceId: "instance",
          relationship: "assigned",
          branch: assignment.branch,
          availableActions: ["message"],
        },
      ],
    }),
    directReports: async () => [
      {
        lead: session,
        paneId: "pane",
        workspaceId: "workspace",
        tabId: "tab",
        instanceId: "instance",
        relationship: "assigned",
        availableActions: ["message"],
      },
    ],
    findProjectAssignmentBySession: () => [assignment],
    readProjectAssignment: () => currentAssignment,
    writeProjectAssignment: (_runtime: unknown, next: any) => {
      currentAssignment = next;
    },
    worktreeGroupScope: async () => ({ repoKey: manager.repoKey }),
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => Promise<unknown>,
    ) => operation(),
    managerEvidence: async () => {
      if (++evidenceCalls > 1) throw new Error("Manager authorization changed");
      return {
        roots: new Set([assignment.id]),
        retained: [retained],
        verify: () => {},
        verifyProvenance: () => {},
        revalidate: async (operation: () => unknown) => operation(),
      };
    },
    resolveMessageFiles: () => [
      {
        kind: "retainedEvidence",
        ref: retained.ref,
        name: retained.name,
        path: retained.path,
        sha256: retained.sha256,
      },
    ],
    prepareCoordinationInput: async () => {
      throw new Error("handoff preparation should not run");
    },
    writeChiefMessage: () => {
      throw new Error("handoff should not be written");
    },
  } as any);

  await assert.rejects(
    runtime.executeStaff(
      "message",
      {
        action: "message",
        branch: assignment.branch,
        message: "Please review",
        files: [retained.ref],
        retain: true,
      },
      undefined,
      undefined,
      ctx,
    ),
    /Required evidence was retained, but the staff handoff failed: Manager authorization changed/,
  );
  assert.equal(evidenceCalls, 2);
  assert.ok(
    currentAssignment.requiredEvidence?.some(
      (item: any) =>
        item.name === retained.name &&
        item.sourceAssignmentId === assignment.id,
    ),
  );
});

function projectLifecycle(options: {
  retained?: ReturnType<typeof persistRequiredEvidenceSnapshot>;
  rejectEvidence?: boolean;
  rejectAtPublication?: boolean;
  launch?: (options: any) => never;
  completeLaunch?: boolean;
  switchBranchOnTabCreate?: boolean;
  inheritedModel?: { provider: string; id: string };
  base?: string;
  existingBranch?: boolean;
  existingComparison?: string;
  failComparisonWrite?: boolean;
  baseLookupFailure?: "killed" | "truncated";
  pinnedBaseRefs?: string[];
  pinnedBaseLookupFailure?: "killed" | "truncated" | "nonzero";
  definition?: string;
  managerTrusted?: boolean;
  trustTarget?: boolean;
}) {
  const repoKey = realFs.realpathSync(process.cwd());
  const managerCheckout = repoKey;
  const worktreePath = join(tmpdir(), `project worktree-${randomUUID()}`);
  mkdirSync(worktreePath);
  if (options.trustTarget)
    new ProjectTrustStore(getAgentDir()).set(worktreePath, true);
  const workspaceId = `workspace-${randomUUID()}`;
  const assignments = join(tmpdir(), `assignments-${randomUUID()}`);
  const assignmentRoot = join(assignments, "root");
  mkdirSync(assignmentRoot, { recursive: true });
  const branch = "feature/baseline";
  let checkoutBranch = branch;
  let worktreeCreates = 0;
  let createdBase: string | undefined;
  const gitCommands: string[][] = [];
  let comparisonValues = options.existingComparison;
  let lead: Record<string, unknown> | undefined;
  let leadState: Record<string, unknown> | undefined;
  const simulateLaunch = options.launch || options.completeLaunch;
  const supervision = {
    ...supervisionRuntime(WORKSPACE),
    root: assignmentRoot,
    assignments,
  };
  const managerLease = claimManagerLease(
    {
      build: HERDSMAN_BUILD,
      repoKey,
      canonicalRepoKey: join(tmpdir(), "mock-manager-repo"),
      workspaceId: WORKSPACE,
      paneId: "manager-pane",
      tabId: "manager-tab",
      piSessionId: randomUUID(),
    },
    supervision as any,
  );
  const manager = managerLease.descriptor;
  const topology = {
    source: {
      repo_key: repoKey,
      repo_name: "project",
      source_workspace_id: WORKSPACE,
      source_checkout_path: managerCheckout,
    },
    worktrees: [],
  };
  const runtime = createLeadProjectRuntime({
    activeRole: () => "manager",
    pi: {
      getThinkingLevel: () => "low",
      exec: async (command: string, args: string[]) => {
        if (command === "herdr") {
          const result =
            args[0] === "worktree" && args[1] === "list"
              ? topology
              : args[0] === "workspace" && args[1] === "get"
                ? { workspace: { workspace_id: WORKSPACE } }
                : {};
          return {
            stdout: JSON.stringify({ id: AGENT_ID, result }),
            stderr: "",
            code: 0,
          };
        }
        gitCommands.push(args);
        if (
          args[0] === "for-each-ref" &&
          args.some((arg) => arg.startsWith("--points-at="))
        ) {
          assert.equal(worktreeCreates, 0);
          const refs = options.pinnedBaseRefs ?? [];
          const failure = options.pinnedBaseLookupFailure;
          return {
            stdout: refs.length ? `${refs.join("\n")}\n` : "",
            stderr: "",
            code: failure === "nonzero" ? 1 : 0,
            ...(failure === "killed" ? { killed: true } : {}),
            ...(failure === "truncated" ? { truncated: true } : {}),
          };
        }
        if (args[0] === "for-each-ref")
          return {
            stdout: options.existingBranch ? `refs/heads/${branch}\n` : "",
            stderr: "",
            code: 0,
          };
        if (args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
          const input = args.at(-1);
          const ref = input?.startsWith("refs/")
            ? input
            : input === "HEAD" || /^[0-9a-f]{7,64}$/iu.test(input ?? "")
              ? ""
              : `refs/heads/${input}`;
          return {
            stdout: ref ? `${ref}\n` : "",
            stderr: "",
            code:
              ref ||
              /^[0-9a-f]{40}$/iu.test(input ?? "") ||
              /^[0-9a-f]{64}$/iu.test(input ?? "")
                ? 0
                : 1,
            ...(options.baseLookupFailure
              ? { [options.baseLookupFailure]: true }
              : {}),
          };
        }
        if (args[0] === "rev-parse" && args.includes("--verify"))
          return {
            stdout: `${options.base?.toLowerCase()}\n`,
            stderr: "",
            code: 0,
          };
        if (args[0] === "config" && args.includes("--get-all"))
          return comparisonValues
            ? { stdout: `${comparisonValues}\0`, stderr: "", code: 0 }
            : { stdout: "", stderr: "", code: 1 };
        if (args[0] === "config" && args.includes("--add")) {
          if (options.failComparisonWrite)
            return { stdout: "", stderr: "write denied", code: 1 };
          comparisonValues = args.at(-1);
          return { stdout: "", stderr: "", code: 0 };
        }
        let stdout = "";
        if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
          stdout = managerCheckout;
        else if (args[0] === "rev-parse" && args.includes("--git-dir"))
          stdout = repoKey;
        else if (args[0] === "rev-parse" && args.includes("--git-common-dir"))
          stdout = repoKey;
        else if (args[0] === "symbolic-ref") stdout = `${checkoutBranch}\n`;
        return { stdout, stderr: "", code: 0 };
      },
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } } as any,
    managerLease: () => ({ descriptor: manager }),
    currentManager: async () => manager,
    sameManagerDescriptor: (a: any, b: any) =>
      a.piSessionId === b.piSessionId && a.leaseId === b.leaseId,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: topology.worktrees,
    }),
    supervisionRuntime: () => supervision as any,
    readProjectAssignment: () =>
      readProjectAssignment(supervision as any, repoKey, branch),
    listProjectAssignments: () => [],
    reconcileProjectAssignments: async () => {},
    runHerdr: async (_pi: any, _ctx: any, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return topology;
      if (args[0] === "workspace" && args[1] === "get")
        return { workspace: { workspace_id: WORKSPACE } };
      if (args[0] === "worktree" && args[1] === "create") {
        worktreeCreates++;
        createdBase = args[args.indexOf("--base") + 1];
        return {
          workspace: { workspace_id: workspaceId },
          root_pane: { pane_id: "pane" },
          tab: { tab_id: "tab" },
          worktree: { path: worktreePath, branch },
        };
      }
      if (args[0] === "worktree" && args[1] === "open")
        return {
          workspace: { workspace_id: workspaceId },
          root_pane: { pane_id: "pane" },
          tab: { tab_id: "tab" },
          worktree: { path: worktreePath, branch },
        };
      if (simulateLaunch && args[0] === "pane" && args[1] === "process-info")
        return { process_info: { foreground_processes: [] } };
      if (simulateLaunch && args[0] === "tab" && args[1] === "create") {
        if (options.switchBranchOnTabCreate) checkoutBranch = "feature/other";
        const id = readProjectAssignment(
          supervision as any,
          repoKey,
          branch,
        )?.id;
        assert.ok(id);
        assert.deepEqual(args, [
          "tab",
          "create",
          "--workspace",
          workspaceId,
          "--cwd",
          worktreePath,
          "--label",
          `lead-${id.slice(0, 8)}`,
          "--env",
          `PI_CODING_AGENT_DIR=${resolve(getAgentDir())}`,
          "--env",
          `${EXPECTED_ASSIGNED_LEAD_DEFINITION_ENV}=${JSON.stringify({
            sessionId: id,
            name: options.definition ?? "managed-lead",
            projectTrusted: options.managerTrusted === true,
          })}`,
          ...(options.inheritedModel
            ? [
                "--env",
                `PI_HERDSMAN_EXPECTED_STARTUP_MODEL=${JSON.stringify({ ...options.inheritedModel, requireCatalog: true })}`,
              ]
            : []),
          "--no-focus",
        ]);
        return {
          tab: { workspace_id: workspaceId, tab_id: "lead-tab" },
          root_pane: {
            workspace_id: workspaceId,
            tab_id: "lead-tab",
            pane_id: "lead-pane",
            terminal_id: "lead-terminal",
          },
        };
      }
      throw new Error(`Unexpected Herdr request: ${args.join(" ")}`);
    },
    herdrSessionSnapshot: async () => {
      if (simulateLaunch) return { agents: lead ? [lead] : [] };
      throw new Error(lifecycleStop);
    },
    scanAgentStates: () => ({ states: [] }),
    readLeadCoordinationState: (_runtime: unknown, id: string) =>
      leadState?.piSessionId === id ? leadState : undefined,
    prepareHerdrCoordinatorPane: async (
      _pi: unknown,
      _ctx: unknown,
      preparation: any,
    ) => {
      if (options.switchBranchOnTabCreate) checkoutBranch = "feature/other";
      return {
        workspaceId: preparation.workspaceId,
        tabId: "lead-tab",
        paneId: "lead-pane",
        terminalId: "lead-terminal",
        cwd: preparation.cwd,
        createdWorkspace: false,
        createdTab: true,
      };
    },
    startHerdrCoordinatorInPane: async (
      _pi: unknown,
      _ctx: unknown,
      launch: any,
    ) => {
      options.launch?.(launch);
      const id = launch.session.id;
      const instanceId = randomUUID();
      lead = {
        workspace_id: launch.workspaceId,
        tab_id: launch.tabId,
        pane_id: launch.paneId,
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: id,
        },
      };
      leadState = {
        role: "lead",
        piSessionId: id,
        build: HERDSMAN_BUILD,
        instanceId,
        updatedAt: Date.now(),
        startupAttestation: {
          kind: "model_restore",
          assignmentId: id,
          generation: instanceId,
          result: "verified",
        },
      };
    },
    isPiAgent: (candidate: any) => Boolean(candidate.agent_session),
    sessionIdentity,
    herdrSessionId,
    liveLead: async () => (lead ? [lead] : []),
    requireCompatibleBuild: () => {},
    supervisedSessionFile: () => undefined,
    writeChiefMessage: () => {},
    liveAgent: async () => [],
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareMessageInput: (text: string) => ({ text, resultBindings: [] }),
    managerEvidence: options.retained
      ? async () => ({
          roots: new Set(["source"]),
          retained: [options.retained],
          verify: () => {
            if (options.rejectAtPublication)
              throw new Error("evidence authority changed at publication");
          },
          verifyProvenance: () => {},
          revalidate: async (operation: () => unknown) => {
            if (options.rejectEvidence)
              throw new Error("evidence authority changed");
            await operation();
          },
        })
      : undefined,
    resolveMessageFiles: () =>
      options.retained
        ? [
            {
              kind: "retainedEvidence",
              ref: options.retained.ref,
              name: options.retained.name,
              path: options.retained.path,
              sha256: options.retained.sha256,
            },
          ]
        : [],
    persistRequiredEvidenceSnapshot: () => ({
      id: "brief",
      name: "project-brief.md",
      sourceAssignmentId: "assignment",
      path: "/brief",
      sha256: "a".repeat(64),
    }),
    persistRequiredTextFiles: () => [],
    withProjectWorkLock: (_key: string, operation: () => unknown) =>
      operation(),
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => unknown,
    ) => operation(),
    writeProjectAssignment: (
      _runtime: unknown,
      assignment: any,
      verify?: () => void,
    ) => {
      verify?.();
    },
    appendDurableError: () => {},
  } as any);
  const ctx = fakeContext() as any;
  ctx.cwd = managerCheckout;
  ctx.isProjectTrusted = () => options.managerTrusted === true;
  if (options.inheritedModel) {
    const model = options.inheritedModel;
    ctx.model = model;
    ctx.modelRegistry = {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    };
  }
  ctx.sessionManager.getSessionId = () => manager.piSessionId;
  return {
    branch,
    manager,
    supervision,
    managerCheckout,
    worktreePath,
    workspaceId,
    get worktreeCreates() {
      return worktreeCreates;
    },
    get createdBase() {
      return createdBase;
    },
    gitCommands,
    get comparisonValues() {
      return comparisonValues;
    },
    get published() {
      return readProjectAssignment(supervision as any, repoKey, branch);
    },
    runtime,
    ctx,
    activate: async (signal = new AbortController().signal) => {
      try {
        return await runtime.activateProjectLead(
          {
            action: "delegate",
            task: "work",
            branch,
            ...(options.base ? { base: options.base } : {}),
            definition: options.definition,
            ...(options.retained ? { files: [options.retained.ref!] } : {}),
          },
          ctx,
          signal,
        );
      } finally {
        managerLease.release();
      }
    },
  };
}

test("fresh delegation launches the named profile in a Manager-trusted undecided worktree", async (t) => {
  const definition = "delivery-launch";
  const lifecycle = projectLifecycle({
    definition,
    managerTrusted: true,
    launch: (options) => {
      assert.equal(lifecycle.published?.definition, definition);
      const intent = getCoordinatorStartIntent(
        lifecycle.supervision,
        lifecycle.published!.id,
      );
      assert.equal(intent?.role, "assigned-lead");
      assert.equal(intent?.assignmentRepoKey, lifecycle.manager.repoKey);
      assert.equal(intent?.branch, lifecycle.branch);
      assert.deepEqual(intent?.admission, {
        pid: process.pid,
        id: intent?.admission?.id,
      });
      assert.equal(
        coordinatorAdmissionClaimIsCurrent(intent!.admission!),
        true,
      );
      assert.ok(options.agentArgs.includes("--approve"));
      assert.equal(options.agentArgs.includes("--no-approve"), false);
      assert.equal(
        options.agentArgs[options.agentArgs.indexOf("--thinking") + 1],
        "high",
      );
      throw new Error("named launch observed");
    },
  });
  const profileDir = join(
    lifecycle.worktreePath,
    ".pi",
    "coordinators",
    "leads",
  );
  realFs.mkdirSync(profileDir, { recursive: true });
  realFs.writeFileSync(
    join(profileDir, `${definition}.md`),
    `---\nname: ${definition}\nthinking: high\n---\n`,
  );
  t.after(() =>
    new ProjectTrustStore(getAgentDir()).set(lifecycle.worktreePath, null),
  );
  await assert.rejects(lifecycle.activate(), /named launch observed/);
});

test("fresh delegation launches in the profile-aware worktree tab", async () => {
  const model = { provider: "extension/provider", id: "model" };
  const lifecycle = projectLifecycle({
    inheritedModel: model,
    launch: (options) => {
      assert.equal(options.agentDir, resolve(getAgentDir()));
      assert.equal(options.workspaceId, lifecycle.workspaceId);
      assert.equal(options.cwd, lifecycle.worktreePath);
      assert.equal(options.tabId, "lead-tab");
      assert.equal(options.paneId, "lead-pane");
      assert.equal(options.agentArgs.includes("--no-extensions"), true);
      assert.ok(options.agentArgs.includes("--no-approve"));
      assert.equal(
        options.agentArgs[options.agentArgs.indexOf("--provider") + 1],
        model.provider,
      );
      assert.equal(
        options.agentArgs[options.agentArgs.indexOf("--model") + 1],
        `${model.provider}/${model.id}`,
      );
      assert.deepEqual(options.agentArgs.slice(-2), [
        "--session-id",
        lifecycle.published?.id,
      ]);
      throw new Error("launch observed");
    },
  });
  await assert.rejects(lifecycle.activate(), /launch observed/);
  assert.ok(lifecycle.published);
});

test("fresh assigned Lead launch does not reserve startup if session directory preparation throws", async (t) => {
  t.mock.method(SettingsManager.prototype, "getSessionDir", () => undefined);
  const launch = t.mock.fn(() => {
    throw new Error("unexpected launch");
  });
  const lifecycle = projectLifecycle({ launch });
  const preparationError = new Error("cannot create Pi session directory");
  const create = t.mock.method(SessionManager, "create", () => {
    throw preparationError;
  });

  await assert.rejects(lifecycle.activate(), preparationError);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(launch.mock.callCount(), 0);
  assert.ok(lifecycle.published);
  assert.deepEqual(
    listCoordinatorStartIntents(lifecycle.supervision).intents,
    [],
  );
});

test("fresh delegation initializes comparison metadata from an unambiguous creation base", async () => {
  const launch = () => {
    throw new Error("launch observed");
  };
  const created = projectLifecycle({ base: "feature/parent", launch });
  await assert.rejects(created.activate(), /launch observed/);
  assert.equal(created.comparisonValues, "refs/heads/feature/parent");
  const writeIndex = created.gitCommands.findIndex(
    (args) => args[0] === "config" && args.includes("--add"),
  );
  const checkoutCheckIndex = created.gitCommands.findIndex(
    (args) => args[0] === "symbolic-ref",
  );
  assert.ok(
    writeIndex > checkoutCheckIndex,
    "write follows checkout verification",
  );

  const existingBranch = projectLifecycle({
    base: "feature/parent",
    existingBranch: true,
    launch,
  });
  await assert.rejects(existingBranch.activate(), /launch observed/);
  assert.equal(existingBranch.comparisonValues, undefined);
  assert.equal(
    existingBranch.gitCommands.some((args) => args.includes("--add")),
    false,
  );

  const existingValue = projectLifecycle({
    base: "feature/parent",
    existingComparison: "refs/heads/other-parent",
    launch,
  });
  await assert.rejects(existingValue.activate(), /launch observed/);
  assert.equal(existingValue.comparisonValues, "refs/heads/other-parent");

  const implicitBase = projectLifecycle({ launch });
  await assert.rejects(implicitBase.activate(), /launch observed/);
  assert.equal(implicitBase.comparisonValues, undefined);

  const pinnedBase = "a".repeat(40);
  const pinnedScenarios: {
    refs: string[];
    expected: string | undefined;
    existingComparison?: string;
    existingBranch?: boolean;
    pinnedBaseLookupFailure?: "killed" | "truncated" | "nonzero";
    warning?: string;
  }[] = [
    {
      refs: ["refs/heads/feature/parent"],
      expected: "refs/heads/feature/parent",
    },
    { refs: [], expected: undefined },
    {
      refs: ["refs/heads/feature/parent", "refs/heads/feature/other"],
      expected: undefined,
    },
    {
      refs: ["refs/heads/feature/parent"],
      existingComparison: "refs/heads/other-parent",
      expected: "refs/heads/other-parent",
    },
    {
      refs: ["refs/heads/feature/parent"],
      existingBranch: true,
      expected: undefined,
    },
    ...(["killed", "truncated", "nonzero"] as const).map((failure) => ({
      refs: ["refs/heads/feature/parent"],
      pinnedBaseLookupFailure: failure,
      expected: undefined,
      warning: "Could not initialize the branch comparison target.",
    })),
  ];
  for (const scenario of pinnedScenarios) {
    const lifecycle = projectLifecycle({
      base: pinnedBase,
      pinnedBaseRefs: scenario.refs,
      ...(scenario.existingComparison
        ? { existingComparison: scenario.existingComparison }
        : {}),
      ...(scenario.existingBranch ? { existingBranch: true } : {}),
      ...(scenario.pinnedBaseLookupFailure
        ? { pinnedBaseLookupFailure: scenario.pinnedBaseLookupFailure }
        : {}),
      completeLaunch: true,
    });
    const result = await lifecycle.activate();
    assert.equal(result.details.ok, true);
    assert.equal(lifecycle.comparisonValues, scenario.expected);
    assert.equal(lifecycle.createdBase, pinnedBase);
    const rendered = JSON.parse(result.content[0].text);
    for (const response of [result.details, rendered]) {
      assert.equal(response.ok, true);
      assert.equal(response.comparison_warning, scenario.warning);
    }
  }

  for (const scenario of [
    { base: "a1b2c3d" },
    { base: "feature/parent", failComparisonWrite: true },
    { base: "feature/parent", baseLookupFailure: "killed" },
    { base: "feature/parent", baseLookupFailure: "truncated" },
  ] as const) {
    const lifecycle = projectLifecycle({ ...scenario, completeLaunch: true });
    const result = await lifecycle.activate();
    assert.equal(lifecycle.comparisonValues, undefined);
    assert.equal(
      lifecycle.gitCommands.some((args) => args.includes("--add")),
      "failComparisonWrite" in scenario,
    );
    const warning =
      scenario.base === "feature/parent"
        ? "Could not initialize the branch comparison target."
        : undefined;
    const rendered = JSON.parse(result.content[0].text);
    for (const response of [result.details, rendered]) {
      assert.equal(response.ok, true);
      assert.equal(
        response.comparison_warning,
        warning,
        JSON.stringify(scenario),
      );
    }
  }
});

test("fresh delegation rejects missing Herdr integration before creating worktree or evidence", async (t) => {
  const missingIntegration = removeHerdrIntegrationForTest(t);
  const lifecycle = projectLifecycle({});
  const evidenceDir = join(herdsmanDataRoot(), "evidence");
  const evidenceEntries = () =>
    realFs.existsSync(evidenceDir)
      ? realFs.readdirSync(evidenceDir).sort()
      : [];
  const priorEvidence = evidenceEntries();

  await assert.rejects(lifecycle.activate(), missingIntegration);
  assert.equal(lifecycle.worktreeCreates, 0);
  assert.equal(lifecycle.published, undefined);
  assert.deepEqual(evidenceEntries(), priorEvidence);
});

test("fresh delegation refuses to launch after the checkout branch changes during tab creation", async () => {
  const lifecycle = projectLifecycle({
    switchBranchOnTabCreate: true,
    launch: () => assert.fail("must not launch on a different branch"),
  });
  await assert.rejects(
    lifecycle.activate(),
    /checkout does not match the assigned repository and branch/,
  );
  assert.equal(lifecycle.published?.branch, lifecycle.branch);
});

test("delegation copies retained evidence under the destination and rejects stale authority", async () => {
  const source = persistRequiredEvidenceSnapshot(
    randomUUID(),
    "source.md",
    "selected content",
  );
  const accepted = projectLifecycle({
    retained: source,
  });
  await assert.rejects(accepted.activate(), new RegExp(lifecycleStop));
  const published = accepted.published;
  assert.ok(published?.requiredEvidence);
  const copy = published.requiredEvidence.find(
    (entry: any) => entry.name === source.name,
  );
  assert.ok(copy);
  assert.ok(!("result" in copy));
  assert.equal(copy.sourceAssignmentId, published.id);
  assert.notEqual(copy.ref, source.ref);
  assert.equal(
    readRequiredEvidenceSnapshot(copy.sourceAssignmentId, copy),
    "selected content",
  );
  assert.equal(
    readRequiredEvidenceSnapshot(source.sourceAssignmentId, source),
    "selected content",
  );
  const denied = projectLifecycle({
    retained: source,
    rejectEvidence: true,
  });
  await assert.rejects(denied.activate(), /evidence authority changed/);
  assert.equal(denied.published, undefined);
  const stale = projectLifecycle({
    retained: source,
    rejectAtPublication: true,
  });
  await assert.rejects(
    stale.activate(),
    /evidence authority changed at publication/,
  );
  assert.equal(stale.published, undefined);
});

test("nested retained provenance is rechecked at the synchronous assignment publication guard", async () => {
  const repoKey = realFs.realpathSync(process.cwd());
  const assignments = join(tmpdir(), `provenance-assignments-${randomUUID()}`);
  const root = join(assignments, "root");
  mkdirSync(root, { recursive: true });
  const assignment = {
    version: 2 as const,
    id: randomUUID(),
    repoKey,
    branch: "feature/provenance",
    text: "work",
  };
  const runtimeDir = { root, assignments } as any;
  writeProjectAssignment(runtimeDir, assignment);
  const manager = {
    piSessionId: randomUUID(),
    repoKey,
    workspaceId: WORKSPACE,
    leaseId: randomUUID(),
  } as any;
  const retained = persistRequiredEvidenceSnapshot(
    randomUUID(),
    "source.md",
    "selected content",
  );
  let current = assignment;
  let nestedProvenance = "nested-parent-original";
  const runtime = createLeadProjectRuntime({
    leadRuntime: { roleSuspended: false } as any,
    activeRole: () => "manager",
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: (left: any, right: any) =>
      left.piSessionId === right.piSessionId && left.leaseId === right.leaseId,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
    }),
    supervisionRuntime: () => runtimeDir,
    readProjectAssignment: () => current,
    listProjectAssignments: () => [current],
    managerEvidence: async () => ({
      roots: new Set([assignment.id]),
      retained: [retained],
      verify: () => {},
      verifyProvenance: () => {
        if (nestedProvenance !== "nested-parent-original")
          throw new Error("Manager evidence provenance changed");
      },
      revalidate: async (operation: () => unknown) => {
        await operation();
        nestedProvenance = "nested-parent-replaced";
      },
    }),
    resolveMessageFiles: () => [
      {
        kind: "retainedEvidence",
        ref: retained.ref,
        name: retained.name,
        path: retained.path,
        sha256: retained.sha256,
      },
    ],
    persistRequiredTextFiles: () => [],
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => unknown,
    ) => operation(),
    writeProjectAssignment: (_runtime: unknown, next: any) => {
      current = next;
    },
  } as any);

  await assert.rejects(
    runtime.updateAssignmentEvidence(
      "update",
      { branch: assignment.branch, add: [retained.ref] },
      undefined,
      undefined,
      fakeContext() as any,
    ),
    /Manager evidence provenance changed/,
  );
  assert.deepEqual(current, assignment);
  assert.deepEqual(
    readProjectAssignment(runtimeDir, repoKey, assignment.branch),
    assignment,
  );
});

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
  let current: import("../supervision.ts").ProjectAssignment = assignment;
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
  const inheritedEvidence = before.requiredEvidence?.find(
    (item) => item.id === "inherited",
  );
  assert.ok(inheritedEvidence && !("result" in inheritedEvidence));
  assert.equal(inheritedEvidence.sourceAssignmentId, "parent-assignment");

  // Cancel means the UI does not invoke the removal callback.
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
    ...(inspected.requiredEvidence
      ? {
          requiredEvidence: inspected.requiredEvidence.map((entry) =>
            entry.id === "local-a"
              ? { ...entry, sourceAssignmentId: "replacement-assignment" }
              : entry,
          ),
        }
      : {}),
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

test("new project worktree creation gets an extended Herdr timeout", async () => {
  const repoKey = realFs.realpathSync(process.cwd());
  const manager = {
    repoKey,
    canonicalRepoKey: repoKey,
    workspaceId: WORKSPACE,
    socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
    group: null,
    leaseId: randomUUID(),
    piSessionId: randomUUID(),
  };
  const calls: {
    args: string[];
    options: Parameters<typeof import("../herdr.ts").runHerdr>[3];
  }[] = [];
  const observedCalls = () => calls;
  const lockKeys: string[] = [];
  const signal = new AbortController().signal;
  const runtime = createLeadProjectRuntime({
    pi: {
      exec: async (command: string, args: string[]) => ({
        stdout:
          command === "git"
            ? repoKey
            : JSON.stringify({
                id: AGENT_ID,
                result:
                  args[0] === "workspace"
                    ? { workspace: { workspace_id: WORKSPACE } }
                    : {
                        source: { repo_key: repoKey, repo_name: "project" },
                        worktrees: [],
                      },
              }),
        stderr: "",
        code: 0,
      }),
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } } as any,
    managerLease: () => ({ descriptor: manager }),
    currentManager: async () => manager,
    sameManagerDescriptor: () => true,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: [],
    }),
    runHerdr: async (_pi: any, _ctx: any, args: string[], options: any) => {
      calls.push({ args, options });
      if (args[1] === "list")
        return {
          source: { source_workspace_id: WORKSPACE, repo_key: repoKey },
          worktrees: [],
        } as any;
      throw new Error("stop after observing create options");
    },
    supervisionRuntime: () => ({}),
    readProjectAssignment: () => undefined,
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareMessageInput: (text: string) => ({ text, resultBindings: [] }),
    resolveMessageFiles: () => [],
    withProjectWorkLock: (key: string, operation: () => unknown) => {
      lockKeys.push(key);
      return operation();
    },
    appendDurableError: () => {},
  } as any);

  for (const [params, expected] of [
    [
      { action: "delegate", task: "work", branch: " \t" },
      /Project branch must not be empty/,
    ],
    [{ action: "resume", branch: " \n" }, /Project branch must not be empty/],
    [
      { action: "resume", branch: "feature/existing", message: " \t\n" },
      /Resume instruction must not be empty/,
    ],
    [
      { action: "resume", branch: "feature/existing" },
      /Resume instruction must not be empty/,
    ],
    [
      { action: "delegate", task: "work", base: " \t" },
      /Base ref must not be empty/,
    ],
  ] as const) {
    await assert.rejects(
      Reflect.apply(runtime.activateProjectLead, runtime, [params, {}, signal]),
      expected,
    );
  }
  assert.deepEqual(lockKeys, []);
  assert.deepEqual(calls, []);

  await assert.rejects(
    runtime.activateProjectLead(
      { action: "delegate", task: "test" },
      { cwd: repoKey } as any,
      signal,
    ),
    /stop after observing create options/,
  );
  assert.deepEqual(
    observedCalls().map(({ args }) => args.slice(0, 2)),
    [
      ["worktree", "list"],
      ["worktree", "create"],
    ],
  );
  assert.deepEqual(observedCalls()[0]?.options, { signal });
  assert.deepEqual(observedCalls()[1]?.options, { signal, timeout: 180_000 });
});

test("resume revalidates checkout placement after async preparation", async () => {
  const repoKey = realFs.realpathSync(process.cwd());
  const checkout = realFs.realpathSync.native(
    realFs.mkdtempSync(join(tmpdir(), "resume-")),
  );
  const movedCheckout = join(tmpdir(), `resume-moved-${randomUUID()}`);
  mkdirSync(movedCheckout);
  const assignmentRoot = join(tmpdir(), `resume-assignments-${randomUUID()}`);
  mkdirSync(assignmentRoot);
  const id = randomUUID();
  const managerLease = claimManagerLease(
    {
      build: HERDSMAN_BUILD,
      piSessionId: randomUUID(),
      paneId: "manager-pane",
      tabId: "manager-tab",
      workspaceId: WORKSPACE,
      repoKey,
      canonicalRepoKey: join(tmpdir(), "mock-manager-repo"),
    },
    { ...supervisionRuntime(WORKSPACE), root: assignmentRoot },
  );
  const manager = managerLease.descriptor;
  const assignment = {
    version: 2,
    id,
    repoKey,
    branch: "feature/resume",
    text: "original",
    checkoutPath: checkout,
  };
  writeProjectAssignment(
    { root: assignmentRoot, assignments: assignmentRoot } as any,
    assignment as any,
  );
  const supervision = {
    ...supervisionRuntime(WORKSPACE),
    root: assignmentRoot,
    assignments: assignmentRoot,
  };
  let writes = 0;
  let launches = 0;
  let preparedFiles: unknown[] = [];
  let changePlacementDuringPreparation = false;
  let placementRaceRequested = false;
  let failPreparation = false;
  let failPostPrepareManagerRevalidation = false;
  let liveLead = false;
  let reconciliations = 0;
  const ctx = fakeContext() as any;
  ctx.cwd = repoKey;
  const runtime = createLeadProjectRuntime({
    pi: {
      exec: async (command: string) => ({
        stdout:
          command === "herdr"
            ? JSON.stringify({
                id: AGENT_ID,
                result: {
                  source: {
                    repo_key: repoKey,
                    repo_name: "project",
                    source_checkout_path: repoKey,
                  },
                  worktrees: [],
                  workspace: { workspace_id: WORKSPACE },
                },
              })
            : repoKey,
        stderr: "",
        code: 0,
      }),
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } },
    SessionManager,
    activeRole: () => "manager",
    currentManager: async () => {
      if (failPostPrepareManagerRevalidation) {
        failPostPrepareManagerRevalidation = false;
        throw new Error("Manager changed after evidence retention");
      }
      return manager;
    },
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: () => true,
    supervisionRuntime: () => supervision,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: [],
    }),
    runHerdr: async (_pi: any, _ctx: any, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list")
        return {
          source: { repo_key: repoKey, source_checkout_path: repoKey },
          worktrees: [
            {
              path: changePlacementDuringPreparation ? movedCheckout : checkout,
              branch: assignment.branch,
              is_linked_worktree: true,
              open_workspace_id: "resume-workspace",
            },
          ],
        };
      if (args[0] === "workspace" && args[1] === "get")
        return { workspace: { workspace_id: WORKSPACE } };
      if (args[0] === "worktree" && args[1] === "open")
        return {
          workspace: { workspace_id: "resume-workspace" },
          root_pane: { pane_id: "pane" },
          tab: { tab_id: "tab" },
          worktree: { path: checkout, branch: assignment.branch },
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return { process_info: { foreground_processes: [] } };
      throw new Error(`Unexpected Herdr request: ${args.join(" ")}`);
    },
    readProjectAssignment: () =>
      readProjectAssignment(supervision as any, repoKey, assignment.branch),
    listProjectAssignments: () => [assignment],
    reconcileProjectAssignments: async () => {
      reconciliations++;
    },
    withProjectWorkLock: (_key: string, op: () => unknown) => op(),
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      op: () => unknown,
    ) => op(),
    herdrSessionSnapshot: async () => ({ agents: [] }),
    liveAgent: async () =>
      liveLead ? [{ workspace_id: "resume-workspace" }] : [],
    readLeadCoordinationState: () => ({ role: "lead", piSessionId: id }),
    requireCompatibleBuild: () => {},
    supervisedSessionFile: () => undefined,
    scanAgentStates: () => ({ states: [] }),
    resolveMessageFiles: (_ctx: unknown, files: string[] = []) => files,
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareCoordinationInput: async (
      _ctx: unknown,
      message: string,
      files: unknown[],
    ) => {
      preparedFiles = files;
      if (failPreparation) throw new Error("resume preparation failed");
      if (message === "retain then fail revalidation")
        failPostPrepareManagerRevalidation = true;
      if (message === "placement race") placementRaceRequested = true;
      return {
        text: `${message} ${files.join(" ")}`,
        resultBindings: [],
      };
    },
    managerEvidence: async () => ({
      roots: new Set(),
      retained: [],
      verify: () => {},
      verifyProvenance: () => {},
      revalidate: async (operation: () => unknown) => {
        if (placementRaceRequested) {
          placementRaceRequested = false;
          changePlacementDuringPreparation = true;
        }
        await operation();
      },
    }),
    writeChiefMessage: () => {
      if (++writes === 1) throw new Error("disk write failed");
    },
    prepareHerdrCoordinatorPane: async (
      _pi: unknown,
      _ctx: unknown,
      options: any,
    ) => ({
      workspaceId: options.workspaceId,
      tabId: "lead-tab",
      paneId: "lead-pane",
      terminalId: "lead-terminal",
      cwd: options.cwd,
      createdWorkspace: false,
      createdTab: true,
    }),
    startHerdrCoordinatorInPane: async () => {
      launches++;
    },
    appendDurableError: () => {},
  } as any);
  await assert.rejects(
    runtime.activateProjectLead(
      {
        action: "resume",
        branch: assignment.branch,
        definition: "different-profile",
        message: "do not reconcile",
        retain: true,
      },
      ctx,
    ),
    /Assigned Lead uses definition managed-lead/,
  );
  assert.equal(reconciliations, 0);
  const nativePath = join(checkout, "native-only.jsonl");
  nativeSessions.set(id, {
    id,
    cwd: checkout,
    path: nativePath,
    entries: [
      {
        type: "custom",
        customType: COORDINATOR_DEFINITION_ENTRY,
        data: {
          version: 1,
          sessionId: id,
          category: "lead",
          name: "different-profile",
        },
      },
    ],
  });
  try {
    await assert.rejects(
      runtime.activateProjectLead(
        {
          action: "resume",
          branch: assignment.branch,
          message: "do not retain or enqueue",
          retain: true,
        },
        ctx,
      ),
      /conflicts with assignment definition managed-lead/,
    );
    assert.deepEqual(preparedFiles, []);
    assert.equal(writes, 0);
    assert.equal(launches, 0);
    assert.deepEqual(
      readProjectAssignment(supervision as any, repoKey, assignment.branch),
      assignment,
    );
  } finally {
    nativeSessions.delete(id);
  }
  const result = (await runtime.activateProjectLead(
    {
      action: "resume",
      branch: assignment.branch,
      message: "continue",
      files: ["startup.log"],
    },
    ctx,
    new AbortController().signal,
  )) as any;
  assert.equal(result.details.enqueue_uncertain, true);
  assert.equal(result.details.status, "enqueue_unconfirmed");
  assert.deepEqual(preparedFiles, ["startup.log"]);
  assert.equal(writes, 1);
  assert.equal(launches, 0);

  failPreparation = true;
  const retainedResult = (await runtime.activateProjectLead(
    {
      action: "resume",
      branch: assignment.branch,
      message: "retain this requirement",
      retain: true,
    },
    ctx,
    new AbortController().signal,
  )) as any;
  assert.equal(retainedResult.details.evidence_retained, true);
  assert.equal(retainedResult.details.message_queued, false);
  assert.equal(retainedResult.details.recovery_verified, false);
  assert.equal(retainedResult.details.status, "handoff_incomplete");
  assert.match(
    retainedResult.content[0].text,
    /not prepared, queued, or recovered/,
  );
  const retainedAssignment = readProjectAssignment(
    supervision as any,
    repoKey,
    assignment.branch,
  )!;
  assert.equal(retainedAssignment.id, assignment.id);
  assert.equal(retainedAssignment.text, assignment.text);
  assert.ok(
    retainedAssignment.requiredEvidence?.some(
      (evidence: any) => evidence.name === "assignment-note.md",
    ),
  );
  assert.equal(writes, 1);
  assert.equal(launches, 0);

  liveLead = true;
  const revalidationResult = (await runtime.activateProjectLead(
    {
      action: "resume",
      branch: assignment.branch,
      message: "retain then fail revalidation",
      retain: true,
    },
    ctx,
    new AbortController().signal,
  )) as any;
  assert.equal(revalidationResult.details.evidence_retained, true);
  assert.equal(revalidationResult.details.message_queued, false);
  assert.equal(revalidationResult.details.status, "handoff_incomplete");
  assert.equal(revalidationResult.details.session, id);
  assert.equal(writes, 1);
  assert.equal(launches, 0);

  failPreparation = false;
  await assert.rejects(
    runtime.activateProjectLead(
      {
        action: "resume",
        branch: assignment.branch,
        message: "placement race",
        files: ["evidence:placement"],
      },
      ctx,
      new AbortController().signal,
    ),
    /placement changed during resume handoff/,
  );
  assert.equal(writes, 1);
  assert.equal(launches, 0);
  managerLease.release();
});

test("exact assigned Lead resume settles definite refusal and retains uncertain dispatch", async (t) => {
  const repoKey = realFs.realpathSync(process.cwd());
  const checkout = realFs.realpathSync.native(
    realFs.mkdtempSync(join(tmpdir(), "resume-")),
  );
  const trustStore = new ProjectTrustStore(getAgentDir());
  trustStore.set(checkout, null);
  assert.equal(trustStore.get(checkout), null);
  t.after(() => trustStore.set(checkout, null));
  const previousSessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = "custom-sessions";
  t.after(() => {
    if (previousSessionDirectory === undefined)
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDirectory;
  });
  const customSessionDirectory = join(checkout, "custom-sessions");
  const assignmentRoot = join(tmpdir(), `resume-assignments-${randomUUID()}`);
  mkdirSync(assignmentRoot);
  const intentRuntime = {
    root: assignmentRoot,
    assignments: assignmentRoot,
  } as any;
  const id = randomUUID();
  const manager = {
    repoKey,
    canonicalRepoKey: repoKey,
    workspaceId: WORKSPACE,
    leaseId: randomUUID(),
    piSessionId: randomUUID(),
  };
  const assignment = {
    version: 2,
    id,
    repoKey,
    branch: "feature/resume",
    text: "original",
    checkoutPath: checkout,
    piSessionFile: join(customSessionDirectory, `saved-lead-${id}.jsonl`),
    definition: "exact-recovery-lead",
  };
  writeProjectAssignment(
    { root: assignmentRoot, assignments: assignmentRoot } as any,
    assignment as any,
  );
  const binding = {
    type: "custom",
    customType: COORDINATOR_DEFINITION_ENTRY,
    data: {
      version: 1,
      sessionId: id,
      category: "lead",
      name: assignment.definition,
    },
  };
  const conversation = { type: "message", message: { role: "user" } };
  let savedEntries: unknown[] = [binding, conversation];
  nativeSessions.set(id, {
    id,
    path: assignment.piSessionFile,
    cwd: checkout,
    sessionDir: customSessionDirectory,
  });
  const profileDir = join(getAgentDir(), "coordinators", "leads");
  realFs.mkdirSync(profileDir, { recursive: true });
  const profilePath = join(profileDir, `${assignment.definition}.md`);
  realFs.writeFileSync(
    profilePath,
    `---\nname: ${assignment.definition}\nnoExtensions: true\n---\n`,
  );
  const targetProfilePath = join(
    checkout,
    ".pi",
    "coordinators",
    "leads",
    `${assignment.definition}.md`,
  );
  realFs.mkdirSync(join(checkout, ".pi", "coordinators", "leads"), {
    recursive: true,
  });
  realFs.writeFileSync(
    targetProfilePath,
    `---\nname: ${assignment.definition}\nthinking: high\nbodyMode: append\n---\nRECOVERY_TARGET_OVERLAY`,
  );
  t.after(() => {
    nativeSessions.delete(id);
    realFs.unlinkSync(profilePath);
    realFs.unlinkSync(targetProfilePath);
  });
  const events: any[] = [];
  const topologyCalls: string[][] = [];
  const unrelatedRepo = join(tmpdir(), `unrelated-${randomUUID()}`);
  let launches = 0;
  let launchOutcome: "refused" | "ready" | "uncertain" = "refused";
  let dispatched = 0;
  let startedState: ReturnType<typeof verifiedStartupState> | undefined;
  function verifiedStartupState() {
    const instanceId = randomUUID();
    return {
      role: "lead" as const,
      piSessionId: id,
      instanceId,
      updatedAt: Date.now(),
      startupAttestation: {
        kind: "model_restore" as const,
        assignmentId: id,
        generation: instanceId,
        result: "verified" as const,
      },
    };
  }
  const tabCreates: string[][] = [];
  let tabFailure:
    | "create"
    | "topology"
    | "manager"
    | "competing-start"
    | "foreground-start"
    | undefined;
  let launchPlacement: unknown;
  let alreadyRunning = false;
  let startingUnverifiedPi = false;
  let snapshotCalls = 0;
  let preparations = 0;
  let sessionOpenError: Error | undefined;
  let openedSessionId = id;
  const ctx = fakeContext() as any;
  ctx.cwd = repoKey;
  ctx.isProjectTrusted = () => true;
  ctx.modelRegistry = {
    find: () => undefined,
  };
  let launchedArgs: string[] | undefined;
  const runtime = createLeadProjectRuntime({
    pi: {
      exec: async (command: string) => ({
        stdout:
          command === "herdr"
            ? JSON.stringify({
                id: AGENT_ID,
                result: {
                  source: {
                    repo_key: repoKey,
                    repo_name: "project",
                    source_checkout_path: repoKey,
                  },
                  worktrees: [],
                  workspace: { workspace_id: WORKSPACE },
                },
              })
            : repoKey,
        stderr: "",
        code: 0,
      }),
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } },
    SessionManager: {
      open: () => {
        if (sessionOpenError) throw sessionOpenError;
        return {
          getSessionId: () => openedSessionId,
          getCwd: () => checkout,
          getEntries: () => savedEntries,
          getBranch: () => [],
          buildSessionContext: () => ({
            model: { provider: "mistral-native", modelId: "zai-glm-5-3" },
          }),
        };
      },
    } as any,
    sameObservedSessionPath,
    activeRole: () => "manager",
    currentManager: async () =>
      tabFailure === "manager" && tabCreates.length ? undefined : manager,
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: () => true,
    supervisionRuntime: () => ({
      root: assignmentRoot,
      assignments: assignmentRoot,
    }),
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: [],
    }),
    runHerdr: async (_pi: any, _ctx: any, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        topologyCalls.push(args);
        return {
          source: {
            repo_key:
              args[2] === "--cwd" && args[3] === repoKey
                ? repoKey
                : unrelatedRepo,
            source_checkout_path: repoKey,
          },
          worktrees: [
            {
              path: checkout,
              branch: assignment.branch,
              is_linked_worktree: true,
              open_workspace_id: "resume-workspace",
            },
          ],
        };
      }
      if (args[0] === "workspace" && args[1] === "get")
        return { workspace: { workspace_id: WORKSPACE } };
      if (args[0] === "worktree" && args[1] === "open")
        return {
          workspace: { workspace_id: "resume-workspace" },
          root_pane: { pane_id: "pane" },
          tab: { tab_id: "tab" },
          worktree: { path: checkout, branch: assignment.branch },
        };
      if (args[0] === "tab" && args[1] === "create") {
        tabCreates.push(args);
        if (tabFailure === "create") throw new Error("controlled tab failure");
        return {
          tab: { workspace_id: "resume-workspace", tab_id: "lead-tab" },
          root_pane: {
            workspace_id: "resume-workspace",
            tab_id: "lead-tab",
            pane_id: "lead-pane",
            terminal_id:
              tabFailure === "topology" ? undefined : "lead-terminal",
          },
        };
      }
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          process_info: {
            foreground_processes:
              startingUnverifiedPi ||
              (tabFailure === "foreground-start" &&
                tabCreates.length &&
                args[3] === "pane")
                ? [{ argv0: "pi" }]
                : [],
          },
        };
      throw new Error(`Unexpected Herdr request: ${args.join(" ")}`);
    },
    readProjectAssignment: () => assignment,
    listProjectAssignments: () => [assignment],
    reconcileProjectAssignments: async () => {},
    withProjectWorkLock: (_key: string, op: () => unknown) => op(),
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      op: () => unknown,
    ) => op(),
    herdrSessionSnapshot: async () => {
      snapshotCalls++;
      return {
        agents:
          startedState ||
          startingUnverifiedPi ||
          (tabFailure === "competing-start" && tabCreates.length)
            ? [
                {
                  workspace_id: "resume-workspace",
                  name: herdrAgentAlias(
                    "resume-workspace",
                    `lead-${id.slice(0, 8)}`,
                    id,
                  ),
                  pane_id: "lead-pane",
                  tab_id: "lead-tab",
                  ...(snapshotCalls > 2
                    ? { agent_session: { value: id } }
                    : {}),
                },
              ]
            : [],
      };
    },
    isPiAgent: (candidate: any) => Boolean(candidate.agent_session),
    sessionIdentity: (session: any) => session?.value,
    herdrSessionId: (candidate: any) => candidate?.agent_session?.value,
    liveAgent: async () =>
      alreadyRunning ? [{ workspace_id: "resume-workspace" }] : [],
    liveLead: async () =>
      startedState || startingUnverifiedPi
        ? [
            {
              workspace_id: "resume-workspace",
              pane_id: "lead-pane",
              tab_id: "lead-tab",
              agent_session: { value: id },
            },
          ]
        : [],
    readLeadCoordinationState: () =>
      startedState ??
      (startingUnverifiedPi && snapshotCalls <= 3
        ? undefined
        : { role: "lead", piSessionId: id }),
    requireCompatibleBuild: () => {},
    supervisedSessionFile: () => assignment.piSessionFile,
    scanAgentStates: () => ({ states: [] }),
    resolveMessageFiles: () => [],
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareCoordinationInput: async (message: string) => {
      preparations++;
      return { text: message, resultBindings: [] };
    },
    writeChiefMessage: (message: any) => events.push(message),
    prepareHerdrCoordinatorPane: async (
      _pi: unknown,
      _ctx: unknown,
      options: any,
    ) => {
      tabCreates.push([
        "tab",
        "create",
        "--workspace",
        options.workspaceId,
        "--cwd",
        options.cwd,
        "--label",
        options.label,
        "--env",
        `PI_CODING_AGENT_DIR=${options.agentDir}`,
        ...options.env.flatMap((env: string) => ["--env", env]),
        "--no-focus",
      ]);
      if (tabFailure === "create") throw new Error("controlled tab failure");
      if (tabFailure === "topology")
        throw new Error("Herdr did not return exact Lead tab identities");
      await options.assertCurrentAuthority();
      return {
        workspaceId: options.workspaceId,
        tabId: "lead-tab",
        paneId: "lead-pane",
        terminalId: "lead-terminal",
        cwd: options.cwd,
        createdWorkspace: false,
        createdTab: true,
      };
    },
    startHerdrCoordinatorInPane: async (
      _pi: unknown,
      _ctx: unknown,
      options: any,
    ) => {
      assert.equal(options.agentDir, resolve(getAgentDir()));
      launches++;
      launchedArgs = options.agentArgs;
      if (launches === 1) {
        const launchPrompts = launchedArgs!.flatMap((arg, index) =>
          arg === "--append-system-prompt" && launchedArgs![index + 1]
            ? [readFileSync(launchedArgs![index + 1]!, "utf8")]
            : [],
        );
        assert.ok(
          launchPrompts.some((prompt) =>
            prompt.includes("RECOVERY_TARGET_OVERLAY"),
          ),
        );
      }
      launchPlacement = [
        options.workspaceId,
        options.tabId,
        options.paneId,
        options.cwd,
      ];
      events.push("launch");
      assert.equal(options.session.id, id);
      const intent = getCoordinatorStartIntent(intentRuntime, id);
      assert.ok(intent, "launch must publish its exact intent first");
      if (launchOutcome === "refused")
        return startHerdrCoordinatorInPane(
          {
            exec: async (_command: string, args: string[]) => {
              assert.deepEqual(args.slice(0, 2), ["api", "snapshot"]);
              return {
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  id: 1,
                  result: {
                    snapshot: {
                      agents: [],
                      panes: [],
                      workspaces: [
                        {
                          workspace_id: options.workspaceId,
                          worktree: { checkout_path: repoKey },
                        },
                      ],
                    },
                  },
                }),
              };
            },
          } as any,
          ctx,
          options,
        );
      dispatched++;
      if (launchOutcome === "uncertain")
        throw new HerdrStartFailure("controlled launch failed", "agent_start", {
          ...options,
          herdrAgent: "lead",
          createdTab: true,
          launchMayHaveStarted: true,
        });
      // Simulate the verified child consuming its own attempt and publishing readiness.
      consumeCoordinatorStartIntent(intentRuntime, intent);
      startedState = verifiedStartupState();
    },
    appendDurableError: () => {},
  } as any);
  for (const [failure, expected] of [
    [
      new Error("ENOENT: saved session missing"),
      /history is unavailable or unreadable/,
    ],
    [undefined, /mismatched session ID/],
  ] as const) {
    sessionOpenError = failure;
    openedSessionId = failure ? id : randomUUID();
    await assert.rejects(
      runtime.activateProjectLead(
        { action: "resume", branch: assignment.branch, message: "continue" },
        ctx,
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.match((error as Error).message, expected);
        return true;
      },
    );
    assert.equal(launches, 0);
    assert.deepEqual(events, []);
    assert.equal(
      readProjectAssignment(
        { root: assignmentRoot, assignments: assignmentRoot } as any,
        repoKey,
        assignment.branch,
      )?.id,
      id,
    );
    assert.equal(realFs.existsSync(checkout), true);
  }
  sessionOpenError = undefined;
  openedSessionId = id;
  for (const [entries, asserted, diagnostic] of [
    [[binding], "different-profile", /Assigned Lead uses definition/],
    [[], undefined, /has no binding/],
    [
      [{ ...binding, data: { ...binding.data, name: "different-profile" } }],
      undefined,
      /conflicts with assignment definition/,
    ],
  ] as const) {
    savedEntries = [...entries];
    await assert.rejects(
      runtime.activateProjectLead(
        {
          action: "resume",
          branch: assignment.branch,
          message: "continue",
          definition: asserted,
          retain: true,
        },
        ctx,
      ),
      diagnostic,
    );
    assert.equal(preparations, 0);
    assert.deepEqual(events, []);
  }
  savedEntries = [binding, conversation];
  const result = (await runtime.activateProjectLead(
    { action: "resume", branch: assignment.branch, message: "continue" },
    ctx,
    new AbortController().signal,
  )) as any;
  assert.equal(launches, 1);
  assert.deepEqual(tabCreates, [
    [
      "tab",
      "create",
      "--workspace",
      "resume-workspace",
      "--cwd",
      checkout,
      "--label",
      `lead-${id.slice(0, 8)}`,
      "--env",
      `PI_CODING_AGENT_DIR=${resolve(getAgentDir())}`,
      "--env",
      `${EXPECTED_ASSIGNED_LEAD_DEFINITION_ENV}=${JSON.stringify({
        sessionId: id,
        name: assignment.definition,
        projectTrusted: true,
      })}`,
      "--no-focus",
    ],
  ]);
  assert.deepEqual(launchPlacement, [
    "resume-workspace",
    "lead-tab",
    "lead-pane",
    checkout,
  ]);
  assert.ok(launchedArgs);
  assert.equal(launchedArgs!.includes("--model"), false);
  assert.equal(launchedArgs!.includes("--no-extensions"), true);
  assert.equal(launchedArgs!.includes("--approve"), true);
  assert.equal(launchedArgs!.includes("--no-approve"), false);
  const thinkingIndex = launchedArgs!.indexOf("--thinking");
  assert.notEqual(thinkingIndex, -1);
  assert.equal(launchedArgs![thinkingIndex + 1], "high");
  assert.deepEqual(launchedArgs!.slice(-2), ["--session-id", id]);
  assert.deepEqual(launchedArgs!.slice(-4, -2), [
    "--session-dir",
    customSessionDirectory,
  ]);
  assert.equal(result.details.status, "recovery_unverified");
  assert.equal(result.details.message_queued, true);
  assert.equal(result.details.recovery_verified, false);
  assert.match(
    result.content[0].text,
    /workspace checkout changed before launch/,
  );
  assert.equal(dispatched, 0);
  assert.equal(getCoordinatorStartIntent(intentRuntime, id), undefined);
  assert.equal(
    readProjectAssignment(
      { root: assignmentRoot, assignments: assignmentRoot } as any,
      repoKey,
      assignment.branch,
    )?.id,
    id,
  );
  assert.equal(realFs.existsSync(checkout), true);
  assert.deepEqual(
    events.map((event) => (typeof event === "string" ? event : event.kind)),
    ["manager_message", "project_assignment", "launch"],
  );
  assert.equal(events[1].createdAt + 1, events[0].createdAt);

  for (const [failure, diagnostic] of [
    ["create", /controlled tab failure/],
    ["topology", /exact Lead tab identities/],
    ["manager", /Manager changed during project activation/],
    ["competing-start", /A Lead appeared during tab creation/],
    ["foreground-start", /A Lead appeared during tab creation/],
  ] as const) {
    tabFailure = failure;
    tabCreates.length = 0;
    events.length = 0;
    const failed = (await runtime.activateProjectLead(
      { action: "resume", branch: assignment.branch, message: "continue" },
      ctx,
      new AbortController().signal,
    )) as any;
    assert.equal(failed.details.status, "recovery_unverified");
    assert.match(failed.content[0].text, diagnostic);
    assert.equal(tabCreates.length, 1);
    assert.equal(launches, 1, `must not launch after tab ${failure} failure`);
  }
  tabFailure = undefined;
  tabCreates.length = 0;
  events.length = 0;
  await t.test(
    "missing integration leaves the saved assignment untouched",
    async (t) => {
      const missingIntegration = removeHerdrIntegrationForTest(t);
      const priorPreparations = preparations;
      const readAssignment = () =>
        readProjectAssignment(intentRuntime, repoKey, assignment.branch);
      const priorAssignment = readAssignment();
      await assert.rejects(
        runtime.activateProjectLead(
          { action: "resume", branch: assignment.branch, message: "continue" },
          ctx,
          new AbortController().signal,
        ),
        missingIntegration,
      );
      assert.deepEqual(readAssignment(), priorAssignment);
      assert.equal(preparations, priorPreparations);
      assert.equal(events.length, 0);
      assert.deepEqual(tabCreates, []);
      assert.equal(launches, 1);
    },
  );

  alreadyRunning = true;
  const runningResult = (await runtime.activateProjectLead(
    { action: "resume", branch: assignment.branch, message: "continue" },
    ctx,
    new AbortController().signal,
  )) as any;
  assert.equal(runningResult.details.already_running, true);
  assert.equal(tabCreates.length, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["manager_message"],
  );
  assert.ok(topologyCalls.length >= 2);
  assert.ok(
    topologyCalls.every(
      (args) => args.length === 4 && args[2] === "--cwd" && args[3] === repoKey,
    ),
  );

  alreadyRunning = false;
  startingUnverifiedPi = true;
  snapshotCalls = 0;
  events.length = 0;
  const recovered = (await runtime.activateProjectLead(
    {
      action: "resume",
      branch: assignment.branch,
      message: "continue startup",
    },
    ctx,
    new AbortController().signal,
  )) as any;
  assert.equal(launches, 1, "an existing Pi process is not relaunched");
  assert.equal(tabCreates.length, 0);
  assert.ok(snapshotCalls >= 4, "waits for coordination state");
  assert.equal(recovered.details.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.details.message_queued, true);
  assert.ok(recovered.details.message_id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["manager_message"],
  );
  assert.equal(events[0].id, recovered.details.message_id);

  startingUnverifiedPi = false;
  launchOutcome = "ready";
  const resume = () =>
    runtime.activateProjectLead(
      {
        action: "resume",
        branch: assignment.branch,
        message: "continue exact session",
      },
      ctx,
    );
  const exact = await resume();
  assert.equal(exact.details.ok, true, JSON.stringify(exact));
  assert.equal(exact.details.session, id);
  assert.equal(dispatched, 1);
  assert.equal(getCoordinatorStartIntent(intentRuntime, id), undefined);

  startedState = undefined;
  launchOutcome = "uncertain";
  const uncertain = await resume();
  assert.ok("status" in uncertain.details);
  assert.equal(uncertain.details.status, "recovery_unverified");
  const unsettled = getCoordinatorStartIntent(intentRuntime, id);
  assert.ok(unsettled);
  assert.deepEqual(listCoordinatorStartIntents(intentRuntime).intents, [
    unsettled,
  ]);
  const blocked = await resume();
  assert.match(blocked.content[0].text, /startup intent already exists/);
  assert.equal(dispatched, 2, "the unsettled attempt blocks another dispatch");
  assert.deepEqual(getCoordinatorStartIntent(intentRuntime, id), unsettled);
});

test("Git worktree porcelain inventory rejects incomplete or ambiguous records", () => {
  const hash = "a".repeat(40);
  const root = join(tmpdir(), "work-repo");
  const linked = join(tmpdir(), "work-branch");
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${root}\0HEAD ${hash}\0branch refs/heads/main\0\0worktree ${linked}\0HEAD ${hash}\0branch refs/heads/topic\0\0`,
    ),
    [
      { path: root, head: hash, branch: "main" },
      { path: linked, head: hash, branch: "topic" },
    ],
  );
  assert.equal(
    parseGitWorktreeInventory(`worktree ${root}\0HEAD ${hash}\0`),
    undefined,
  );
  assert.equal(
    parseGitWorktreeInventory(
      `worktree ${root}\0HEAD ${hash}\0branch refs/heads/topic\0\0junk\0\0`,
    ),
    undefined,
  );
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0future-attribute value\0branch refs/heads/topic\0locked active\0\0`,
    ),
    [{ path: linked, head: hash, branch: "topic", locked: true }],
  );
  assert.equal(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0HEAD ${hash}\0branch refs/heads/topic\0\0`,
    ),
    undefined,
  );
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0branch refs/heads/topic\0prunable missing\0\0`,
    ),
    [{ path: linked, head: hash, branch: "topic", prunable: true }],
  );
  assert.deepEqual(
    parseGitWorktreeInventory(`worktree ${linked}\0HEAD ${hash}\0detached\0\0`),
    [{ path: linked, head: hash, detached: true }],
  );
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0detached\0prunable gitdir file points to non-existent location\0\0`,
    ),
    [{ path: linked, head: hash, detached: true, prunable: true }],
  );
});

test("sender environment capture keeps cwd on Git failures and accepts only a unique worktree", async () => {
  const root = join(tmpdir(), `capture-${randomUUID()}`);
  const cwd = join(root, "nested");
  mkdirSync(cwd, { recursive: true });
  const hash = "a".repeat(40);
  const ctx = { cwd, signal: undefined } as any;
  const calls: string[] = [];
  const pi = {
    exec: async (_bin: string, args: string[]) => {
      calls.push(args.join(" "));
      return args[0] === "rev-parse"
        ? { code: 0, stdout: `${root}\n`, stderr: "" }
        : {
            code: 0,
            stdout: `worktree ${root}\0HEAD ${hash}\0branch refs/heads/topic\0\0`,
            stderr: "",
          };
    },
  } as any;
  assert.deepEqual(await captureSenderEnvironment(pi, ctx), {
    cwd,
    git: { worktreeRoot: root, branch: "topic", head: hash },
  });
  assert.deepEqual(calls, [
    "rev-parse --show-toplevel",
    "worktree list --porcelain -z",
  ]);
  assert.deepEqual(
    await captureSenderEnvironment(
      { exec: async () => ({ code: 1, stderr: "not git" }) } as any,
      ctx,
    ),
    { cwd },
  );
  assert.equal(
    await captureSenderEnvironment(pi, { ...ctx, cwd: "x" }),
    undefined,
  );
});
