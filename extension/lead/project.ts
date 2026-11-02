import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type {
  ManagerDescriptor,
  ManagerLease,
  ProjectAssignment,
  ChiefMessageRecord,
  SessionRole,
  UnverifiedLead,
} from "../supervision.ts";
import {
  projectTaskSummary,
  migrateProjectAssignmentEvidence,
  readManagerDescriptor,
  writeProjectAssignmentAfter,
  withProjectAssignmentAuthority,
  staffToolName,
} from "../supervision.ts";
import { OperationError } from "../errors.ts";
import {
  localRepositoryScope,
  sameDirectory,
  sameObservedSessionPath,
  resolveAssignmentCheckout,
} from "../herdr.ts";
import { claimSessionActivationLock } from "../lock.ts";
import {
  isWorktreeRemovalPreapproved,
  effectiveMergePolicy,
  setWorktreeRemovalPreapproved,
} from "../config.ts";
import { persistRequiredTextFiles } from "../core.ts";
import {
  persistRequiredEvidenceSnapshot,
  readRequiredEvidenceSnapshot,
  type RequiredEvidence,
} from "../storage.ts";
import {
  acceptedCloseProof,
  claimDelegationLock,
} from "../agent-controller.ts";
import type { ExpectedSession, HerdrRecord } from "../herdr.ts";
import type { RuntimeBuild } from "../compatibility.ts";
import {
  rememberCoordinatorTarget,
  resolveCoordinatorTarget,
} from "../coordinator-target.ts";
import {
  agentLaunchArgs,
  configuredModel,
  discoverRoleDefinition,
  expandAgentBodyFiles,
  MANAGED_LEAD_DEFINITION_NAME,
  resolveChildModel,
  writePrivatePromptSnapshots,
} from "../agent-definitions.ts";
import type { MessageFileInput } from "../core.ts";
import type { ManagedAgentState } from "../mailbox.ts";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type ManagerEvidence = (
  ctx: ExtensionContext,
  refs: readonly string[],
) => Promise<
  | {
      roots: ReadonlySet<string>;
      retained: RequiredEvidence[];
      revalidate(operation: () => Promise<void> | void): Promise<void>;
      verify(): void;
      verifyProvenance(): void;
    }
  | undefined
>;

export function hasManagerEvidenceSelectors(refs: readonly string[]): boolean {
  return refs.some(
    (ref) => ref.startsWith("result:") || ref.startsWith("evidence:"),
  );
}

function requiredFiles(
  id: string,
  files: MessageFileInput[],
  retained: readonly RequiredEvidence[],
  cwd: string,
  operation: string,
): RequiredEvidence[] {
  return files.flatMap<RequiredEvidence>((file) => {
    if (typeof file === "string")
      return persistRequiredTextFiles(id, [file], cwd, operation);
    if ("kind" in file && file.kind === "retainedEvidence") {
      const source = retained.find(
        (entry) => !("result" in entry) && entry.ref === file.ref,
      );
      if (!source || "result" in source)
        throw new Error("Retained evidence source is unavailable");
      return [
        persistRequiredEvidenceSnapshot(
          id,
          source.name,
          readRequiredEvidenceSnapshot(source.sourceAssignmentId, source),
        ),
      ];
    }
    return [
      {
        id: randomUUID(),
        name: file.ref,
        result: file as import("../storage.ts").ResultBinding,
      },
    ];
  });
}

export type LeadProjectHost = {
  managerEvidence?: ManagerEvidence;
  activeRole(): SessionRole;
  HERDSMAN_EXTENSION_PATH: string;
  leadRuntime: {
    roleSuspended: boolean;
    managerLease: ManagerLease | undefined;
  };
  resolveMessageFiles: typeof import("../agent-controller.ts").resolveMessageFiles;
  onProjectAssignmentAuthorityWaitOccupied?(): void;
  readConfig: typeof import("../config.ts").readConfig;
  projectAssignmentPath: typeof import("../supervision.ts").projectAssignmentPath;
  acquireProcessLock: typeof import("../lock.ts").acquireProcessLock;
  currentManager(ctx: ExtensionContext): Promise<ManagerDescriptor | undefined>;
  managerLease(): ManagerLease | undefined;
  sameManagerDescriptor(
    left: ManagerDescriptor,
    right: ManagerDescriptor,
  ): boolean;
  worktreeGroupScope: typeof import("../herdr.ts").worktreeGroupScope;
  reconcileProjectAssignments(
    ctx: ExtensionContext,
    repoKey: string,
    primaryWorkspaceId: string,
    sourceCheckoutPath: string,
    alreadyLocked?: boolean,
    onlyBranch?: string,
    retryLockContention?: boolean,
    expectedAssignmentId?: string,
  ): Promise<void>;
  findProjectAssignmentBySession: typeof import("../supervision.ts").findProjectAssignmentBySession;
  supervisionRuntime: typeof import("../supervision.ts").supervisionRuntime;
  readProjectAssignment: typeof import("../supervision.ts").readProjectAssignment;
  retireProjectAssignment: typeof import("../supervision.ts").retireProjectAssignment;
  removeProjectMessagesForAssignment: typeof import("../supervision.ts").removeProjectMessagesForAssignment;
  writeChiefMessage: typeof import("../supervision.ts").writeChiefMessage;
  currentChiefAuthority(
    ctx: ExtensionContext,
    failOnVerificationError?: boolean,
  ): Promise<import("../supervision.ts").ChiefDescriptor | undefined>;
  directReports: ReturnType<
    typeof import("../lead-runtime.ts").createLeadSupervisionRuntime
  >["directReports"];
  loadSupervisionSnapshot: ReturnType<
    typeof import("../lead-runtime.ts").createLeadSupervisionRuntime
  >["loadSnapshot"];
  prepareCoordinationInput: ReturnType<
    typeof import("./coordination.ts").createLeadCoordinationRuntime
  >["prepareCoordinationInput"];
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
  currentProjectAssignment(
    ctx: ExtensionContext,
  ): Promise<ProjectAssignment | undefined>;
  writeProjectAssignment: typeof import("../supervision.ts").writeProjectAssignment;
  liveLead(ctx: ExtensionContext, sessionId: string): Promise<HerdrRecord[]>;
  liveAgent(
    ctx: ExtensionContext,
    sessionId: string,
    sessionPath?: string,
  ): Promise<HerdrRecord[]>;
  runHerdr: typeof import("../herdr.ts").runHerdr;
  listProjectAssignments: typeof import("../supervision.ts").listProjectAssignments;
  messageLimits(
    ctx: ExtensionContext,
  ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
  prepareMessageInput: typeof import("../core.ts").prepareMessageInput;
  projectAssignmentBytes: typeof import("../supervision.ts").projectAssignmentBytes;
  delay: typeof import("node:timers/promises").setTimeout;
  startHerdrAgentInPane: typeof import("../herdr.ts").startHerdrAgentInPane;
  sessionIdentity: typeof import("../herdr.ts").sessionIdentity;
  captureStartupDiagnostic: typeof import("../herdr.ts").captureStartupDiagnostic;
  truncateModelText: typeof import("../presentation.ts").truncateModelText;
  inspectHerdrAgent: typeof import("../herdr.ts").inspectHerdrAgent;
  readPersistedTranscript: typeof import("../agent-controller.ts").readPersistedTranscript;
  stopHerdrAgentPreservingPane: typeof import("../herdr.ts").stopHerdrAgentPreservingPane;
  expectedSession(id: string, path?: string): ExpectedSession;
  herdrSessionSnapshot: typeof import("../herdr.ts").herdrSessionSnapshot;
  herdrSessionId: typeof import("../herdr.ts").herdrSessionId;
  isPiAgent(agent: HerdrRecord): boolean;
  scanAgentStates: typeof import("../mailbox.ts").scanAgentStates;
  readLeadCoordinationState: typeof import("../supervision.ts").readLeadCoordinationState;
  requireCompatibleBuild: typeof import("../compatibility.ts").requireCompatibleBuild;
  HERDSMAN_BUILD: RuntimeBuild;
  supervisedSessionFile(
    agent: HerdrRecord,
    sessionId: string,
  ): string | undefined;
  sameObservedSessionPath: typeof sameObservedSessionPath;
  withProjectAssignmentLock<T>(
    repoKey: string,
    branch: string,
    operation: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T>;
  stopOwnedAgentsForSession(
    ctx: ExtensionContext,
    sessionId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<import("../agent-controller.ts").StopOwnedAgentsResult>;
  stopProjectLeadPane(
    ctx: ExtensionContext,
    target: HerdrRecord,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  stopProjectLead(
    sessionId: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    assignment?: ProjectAssignment,
    lead?: {
      workspaceId: string;
      paneId: string;
      tabId: string;
      instanceId: string;
    },
  ): Promise<unknown>;
  withProjectWorkLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  leadCoordinationTools: readonly string[];
  pi: ExtensionAPI;
  SessionManager: Pick<
    typeof import("@earendil-works/pi-coding-agent").SessionManager,
    "open" | "listAll"
  >;
};

export function createLeadProjectRuntime(host: LeadProjectHost) {
  const stopClosureEntry = "pi-herdsman-agent-closed-assignment";
  const stopClosureProof = (
    branch: readonly any[],
    ownerSessionId: string,
    closed: {
      state: import("../mailbox.ts").ManagedAgentState;
      definition: string;
    },
  ) => {
    return acceptedCloseProof(branch, ownerSessionId, closed);
  };
  const persistActiveStopClosures = async (
    ctx: ExtensionContext,
    closures: NonNullable<
      import("../agent-controller.ts").StopOwnedAgentsResult["closures"]
    >,
  ) => {
    let persisted = 0;
    const owner = ctx.sessionManager.getSessionId();
    for (const closed of closures) {
      if (closed.state.ownerSessionId !== owner) continue;
      const proof = stopClosureProof(
        ctx.sessionManager.getBranch(),
        owner,
        closed,
      );
      if (proof) {
        await host.pi.appendEntry(stopClosureEntry, { version: 1, proof });
        const entries = ctx.sessionManager.getEntries() as readonly any[];
        const branch = ctx.sessionManager.getBranch() as readonly any[];
        const saved = (entry: any) =>
          entry?.type === "custom" &&
          entry.customType === stopClosureEntry &&
          entry.data?.version === 1 &&
          JSON.stringify(entry.data.proof) === JSON.stringify(proof);
        if (
          entries.filter(saved).length === 1 &&
          branch.filter(saved).length === 1 &&
          stopClosureProof(branch, owner, closed) &&
          JSON.stringify(stopClosureProof(branch, owner, closed)) ===
            JSON.stringify(proof)
        )
          persisted++;
      }
    }
    return persisted;
  };
  const persistNestedStopClosures = async (
    ctx: ExtensionContext,
    closures: NonNullable<
      import("../agent-controller.ts").StopOwnedAgentsResult["closures"]
    >,
  ): Promise<number> => {
    let persisted = 0;
    const root = ctx.sessionManager.getSessionId();
    const owners = new Map(
      closures.flatMap(({ state }) =>
        state.piSessionId && state.piSessionFile
          ? [[state.piSessionId, state.piSessionFile] as const]
          : [],
      ),
    );
    for (const closed of closures) {
      const owner = closed.state.ownerSessionId;
      const path = owners.get(owner);
      if (owner === root || !path) continue;
      let release: (() => void) | undefined;
      try {
        const canonical = realpathSync(path);
        release = claimSessionActivationLock(canonical);
        if (
          !(await stoppedClosureOwner(ctx, owner, root, closures, ctx.signal))
        )
          continue;
        const manager = host.SessionManager.open(canonical);
        if (
          manager.getSessionId() !== owner ||
          !manager.getSessionFile() ||
          !host.sameObservedSessionPath(manager.getSessionFile()!, canonical)
        )
          continue;
        const proof = stopClosureProof(manager.getBranch(), owner, closed);
        if (!proof) continue;
        manager.appendCustomEntry(stopClosureEntry, { version: 1, proof });
        if (
          (manager.getEntries() as readonly any[]).filter(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === stopClosureEntry &&
              entry.data?.version === 1 &&
              JSON.stringify(entry.data.proof) === JSON.stringify(proof),
          ).length === 1 &&
          (manager.getBranch() as readonly any[]).some(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === stopClosureEntry &&
              JSON.stringify(entry.data?.proof) === JSON.stringify(proof),
          ) &&
          (await stoppedClosureOwner(ctx, owner, root, closures, ctx.signal))
        )
          persisted++;
      } catch {
        // A closed descendant can remain stopped without continuation proof.
      } finally {
        release?.();
      }
    }
    return persisted;
  };
  const stoppedClosureOwner = async (
    ctx: ExtensionContext,
    owner: string,
    leadSessionId: string,
    closures: NonNullable<
      import("../agent-controller.ts").StopOwnedAgentsResult["closures"]
    >,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (owner === leadSessionId)
      return (await host.liveLead(ctx, leadSessionId)).length === 0;
    const parent = closures.find(({ state }) => state.piSessionId === owner);
    if (!parent) return false;
    const snapshot = await host.herdrSessionSnapshot(host.pi, ctx, signal);
    if (!Array.isArray(snapshot?.agents)) return false;
    return !snapshot.agents.some(
      (agent: HerdrRecord) => host.herdrSessionId(agent) === owner,
    );
  };
  const persistForeignStopClosures = async (
    ctx: ExtensionContext,
    target: HerdrRecord,
    ownerSessionId: string,
    closures: NonNullable<
      import("../agent-controller.ts").StopOwnedAgentsResult["closures"]
    >,
    signal?: AbortSignal,
  ): Promise<number> => {
    if (!closures.length) return 0;
    const ownerFiles = new Map<string, string>();
    // The Lead path is obtained only from the verified supervised Lead record.
    const leadPath = host.supervisedSessionFile(target, ownerSessionId);
    if (leadPath) ownerFiles.set(ownerSessionId, leadPath);
    for (const closed of closures)
      if (closed.state.piSessionId && closed.state.piSessionFile)
        ownerFiles.set(closed.state.piSessionId, closed.state.piSessionFile);
    let persisted = 0;
    for (const closed of closures) {
      const owner = closed.state.ownerSessionId;
      const ownerFile = ownerFiles.get(owner);
      if (!ownerFile) continue;
      let release: (() => void) | undefined;
      try {
        const canonical = realpathSync(ownerFile);
        release = claimSessionActivationLock(canonical);
        if (
          !(await stoppedClosureOwner(
            ctx,
            owner,
            ownerSessionId,
            closures,
            signal,
          ))
        )
          continue;
        const manager = host.SessionManager.open(canonical);
        if (
          manager.getSessionId() !== owner ||
          !manager.getSessionFile() ||
          !host.sameObservedSessionPath(manager.getSessionFile()!, canonical)
        )
          continue;
        const proof = stopClosureProof(manager.getBranch(), owner, closed);
        if (!proof) continue;
        // Recheck exact owner absence while activation is excluded, before the write.
        if (
          !(await stoppedClosureOwner(
            ctx,
            owner,
            ownerSessionId,
            closures,
            signal,
          ))
        )
          continue;
        manager.appendCustomEntry(stopClosureEntry, { version: 1, proof });
        const entries = manager.getEntries() as readonly any[];
        const branch = manager.getBranch() as readonly any[];
        if (
          entries.filter(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === stopClosureEntry &&
              entry.data?.version === 1 &&
              JSON.stringify(entry.data.proof) === JSON.stringify(proof),
          ).length === 1 &&
          branch.some(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === stopClosureEntry &&
              entry.data?.version === 1 &&
              JSON.stringify(entry.data.proof) === JSON.stringify(proof),
          ) &&
          (await stoppedClosureOwner(
            ctx,
            owner,
            ownerSessionId,
            closures,
            signal,
          ))
        )
          persisted++;
      } catch {
        // Physical stop remains successful; continuity proof is optional and fail-closed.
      } finally {
        release?.();
      }
    }
    return persisted;
  };
  const stopExecution = async (
    session: string,
    target: HerdrRecord,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const release = claimDelegationLock(target.workspace_id, session);
    try {
      const result = await host.stopOwnedAgentsForSession(
        ctx,
        session,
        target.workspace_id,
        signal,
      );
      if (!result.complete)
        throw new Error(`Agent-tree cleanup failed: ${result.summary}`);
      await host.stopProjectLeadPane(ctx, target, session, signal);
      if ((await host.liveLead(ctx, session)).length)
        throw new Error("Lead remains live after stop; work was preserved");
      const persisted = await persistForeignStopClosures(
        ctx,
        target,
        session,
        result.closures ?? [],
        signal,
      );
      return { result, persisted };
    } finally {
      release();
    }
  };
  const stop = async (
    session: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    expected?: ProjectAssignment,
    expectedLead?: {
      workspaceId: string;
      paneId: string;
      tabId: string;
      instanceId: string;
    },
  ) => {
    const manager = await host.currentManager(ctx);
    const lease = host.managerLease();
    if (
      !manager ||
      !lease ||
      !host.sameManagerDescriptor(manager, lease.descriptor)
    )
      throw new Error("Manager lease is no longer active");
    const scope = await host.worktreeGroupScope(
      host.pi,
      ctx,
      manager.workspaceId,
      signal,
    );
    const assignments = host.findProjectAssignmentBySession(
      host.supervisionRuntime(),
      manager.repoKey,
      session,
    );
    if (assignments.length !== 1)
      throw new Error("Lead is not an exact current project assignment");
    const assignment = assignments[0];
    if (
      expected &&
      (assignment.branch !== expected.branch ||
        assignment.id !== expected.id ||
        assignment.repoKey !== expected.repoKey)
    )
      throw new Error("Project assignment changed before stop");
    const close = async () => {
      if (
        host.readProjectAssignment(
          host.supervisionRuntime(),
          manager.repoKey,
          assignment.branch,
        )?.id !== assignment.id
      )
        throw new Error("Project assignment changed before close");
      const live = (await host.liveLead(ctx, session)).filter((agent: any) =>
        scope.workspaceIds.includes(agent.workspace_id),
      );
      if (live.length !== 1)
        throw new Error("Exact live Lead was not found or is ambiguous");
      if (expectedLead) {
        const state = host.readLeadCoordinationState(
          host.supervisionRuntime(),
          session,
        );
        if (
          live[0].workspace_id !== expectedLead.workspaceId ||
          live[0].pane_id !== expectedLead.paneId ||
          live[0].tab_id !== expectedLead.tabId ||
          state?.instanceId !== expectedLead.instanceId
        )
          throw new Error("Lead changed before stop");
        host.requireCompatibleBuild(
          host.HERDSMAN_BUILD,
          state?.build,
          "stop_lead",
          `Lead ${session}`,
        );
      }
      const currentManager = await host.currentManager(ctx);
      if (
        !currentManager ||
        !host.sameManagerDescriptor(currentManager, manager) ||
        host.readProjectAssignment(
          host.supervisionRuntime(),
          manager.repoKey,
          assignment.branch,
        )?.id !== assignment.id
      )
        throw new Error("Manager or project assignment changed before stop");
      const stopped = await stopExecution(session, live[0], ctx, signal);
      return {
        content: [
          {
            type: "text" as const,
            text: `Lead ${session} stopped; project work preserved.${stopped.persisted ? ` Continuation proof saved for ${stopped.persisted} Agent${stopped.persisted === 1 ? "" : "s"}.` : " Continuation proof could not be safely preserved; stopped Agents may not be continuable."}`,
          },
        ],
        details: {
          ok: true,
          action: "stop",
          session,
          ...(assignment ? { branch: assignment.branch } : {}),
        },
      };
    };
    return host.withProjectWorkLock(
      `${manager.repoKey}\0${assignment.branch}`,
      () =>
        host.withProjectAssignmentLock(
          manager.repoKey,
          assignment.branch,
          close,
          signal,
        ),
    );
  };
  const inspectRemovalTarget = async (
    branch: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const manager = await host.currentManager(ctx);
    const lease = host.managerLease();
    if (
      !manager ||
      !lease ||
      !host.sameManagerDescriptor(manager, lease.descriptor)
    )
      throw new Error("Manager lease is no longer active");
    const group = await host.worktreeGroupScope(
      host.pi,
      ctx,
      manager.workspaceId,
      signal,
    );
    if (group.repoKey !== manager.repoKey)
      throw new Error("Manager worktree group is not authoritative");
    const localScope = await localRepositoryScope(
      host.pi,
      ctx,
      manager.workspaceId,
      signal,
    );
    if (!localScope.isPrimary || localScope.repoKey !== manager.repoKey)
      throw new Error("Manager checkout is not the verified primary checkout");
    const topology = await host.runHerdr(
      host.pi,
      ctx,
      ["worktree", "list", "--workspace", manager.workspaceId],
      { signal },
    );
    if (
      topology?.source?.repo_key !== manager.repoKey ||
      typeof topology?.source?.source_checkout_path !== "string" ||
      !sameDirectory(
        topology.source.source_checkout_path,
        localScope.checkoutPath,
      ) ||
      !Array.isArray(topology?.worktrees)
    )
      throw new Error("Herdr worktree topology is not authoritative");
    const assignments = host
      .listProjectAssignments(host.supervisionRuntime(), manager.repoKey)
      .filter((assignment) => assignment.branch === branch);
    if (assignments.length !== 1)
      throw new Error("Branch is not one exact current project assignment");
    const assignment = assignments[0]!;
    const current = host.readProjectAssignment(
      host.supervisionRuntime(),
      manager.repoKey,
      branch,
    );
    if (
      !current ||
      current.id !== assignment.id ||
      current.repoKey !== manager.repoKey
    )
      throw new Error("Project assignment changed during removal");
    let sessionCwd: string | undefined;
    if (assignment.piSessionFile) {
      try {
        const session = host.SessionManager.open(assignment.piSessionFile);
        if (session.getSessionId() !== assignment.id) throw new Error();
        sessionCwd = session.getCwd();
      } catch {
        throw new Error(
          "Persisted project session provenance is unavailable; worktree preserved",
        );
      }
    }
    const placement = resolveAssignmentCheckout(
      assignment,
      topology.worktrees,
      sessionCwd,
    );
    if (placement.status !== "matched")
      throw new Error(
        `Assigned checkout is not verified (${placement.reason}); worktree preserved`,
      );
    const worktree = placement.worktree;
    if (
      typeof worktree.path !== "string" ||
      !worktree.path ||
      !isAbsolute(worktree.path) ||
      worktree.is_linked_worktree !== true
    )
      throw new Error("Herdr worktree checkout path is unavailable");
    const checkoutPath = resolve(worktree.path);
    if (sameDirectory(checkoutPath, topology.source.source_checkout_path))
      throw new Error("The Manager's primary checkout cannot be removed");
    if (worktree.open_workspace_id === manager.workspaceId)
      throw new Error("The Manager's primary workspace cannot be removed");
    if (!assignment.piSessionFile)
      throw new Error(
        "Project checkout provenance is unavailable; worktree preserved",
      );
    if (assignment.piSessionFile) {
      try {
        const session = host.SessionManager.open(assignment.piSessionFile);
        if (
          session.getSessionId() !== assignment.id ||
          !sameDirectory(session.getCwd(), checkoutPath)
        )
          throw new Error();
      } catch {
        throw new Error(
          "Persisted project session provenance does not match the checkout; worktree preserved",
        );
      }
    }
    const [gitRoot, gitCommonDir, gitInventory] = await Promise.all([
      host.pi.exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: checkoutPath,
        signal,
        timeout: 10_000,
      }),
      host.pi.exec(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: checkoutPath, signal, timeout: 10_000 },
      ),
      host.pi.exec("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: topology.source.source_checkout_path,
        signal,
        timeout: 10_000,
      }),
    ]);
    let gitWorktrees: ReturnType<typeof parseGitWorktreeInventory>;
    try {
      gitWorktrees = parseGitWorktreeInventory(
        String(gitInventory.stdout ?? ""),
      );
      if (
        gitRoot.code !== 0 ||
        gitRoot.killed ||
        gitRoot.stderr?.trim() ||
        gitCommonDir.code !== 0 ||
        gitCommonDir.killed ||
        gitCommonDir.stderr?.trim() ||
        gitInventory.code !== 0 ||
        gitInventory.killed ||
        gitInventory.stderr?.trim() ||
        !sameDirectory(String(gitRoot.stdout ?? "").trim(), checkoutPath) ||
        !sameDirectory(
          String(gitCommonDir.stdout ?? "").trim(),
          manager.repoKey,
        ) ||
        !gitWorktrees ||
        gitWorktrees.filter((entry) => sameDirectory(entry.path, checkoutPath))
          .length !== 1
      )
        throw new Error();
    } catch {
      throw new Error(
        "Git could not verify the exact linked checkout and repository; worktree preserved",
      );
    }
    const git = await host.pi.exec(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: checkoutPath, signal, timeout: 10_000 },
    );
    if (
      git.code !== 0 ||
      git.killed ||
      git.stderr?.trim() ||
      git.stdout?.trim()
    )
      throw new Error(
        "Checkout is dirty or could not be verified; worktree preserved",
      );
    const leads = await host.liveLead(ctx, assignment.id);
    if (leads.length > 1)
      throw new Error(
        "Assigned Lead identity is ambiguous; worktree preserved",
      );
    if (leads.length === 1) {
      const lead = leads[0]!;
      const state = host.readLeadCoordinationState(
        host.supervisionRuntime(),
        assignment.id,
      );
      host.requireCompatibleBuild(
        host.HERDSMAN_BUILD,
        state?.build,
        "remove_worktree",
        `Lead ${assignment.id}`,
      );
      if (
        !worktree.open_workspace_id ||
        lead.workspace_id !== worktree.open_workspace_id ||
        !state ||
        (state.role ?? "lead") !== "lead" ||
        state.piSessionId !== assignment.id
      )
        throw new Error(
          "Assigned Lead placement is ambiguous; worktree preserved",
        );
    }
    return {
      manager,
      assignment,
      worktree,
      checkoutPath,
      checkedOutBranch:
        typeof worktree.branch === "string" ? worktree.branch : undefined,
      sourceCheckoutPath: topology.source.source_checkout_path,
      liveLead: leads[0],
    };
  };
  const assertNoUnrelatedPiExecution = async (
    target: Awaited<ReturnType<typeof inspectRemovalTarget>>,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    if (!target.worktree.open_workspace_id) return;
    const inventory = await host.herdrSessionSnapshot(host.pi, ctx, signal);
    const owned = new Set([target.assignment.id]);
    const states = host.scanAgentStates().states.map(({ state }) => state);
    let changed = true;
    while (changed) {
      changed = false;
      for (const state of states) {
        if (
          state.workspaceId === target.worktree.open_workspace_id &&
          owned.has(state.ownerSessionId) &&
          !owned.has(state.piSessionId)
        ) {
          owned.add(state.piSessionId);
          changed = true;
        }
      }
    }
    if (
      inventory.agents.some(
        (agent) =>
          agent.workspace_id === target.worktree.open_workspace_id &&
          host.isPiAgent(agent) &&
          !owned.has(host.herdrSessionId(agent) ?? ""),
      )
    )
      throw new Error(
        "Unrelated or ambiguously identified Pi execution occupies the worktree; worktree preserved",
      );
  };
  const REMOVAL_ENTRY = "pi-herdsman-pending-removal";
  type PendingRemoval = {
    id: string;
    branch: string;
    repoKey: string;
    assignmentId: string;
    checkoutPath: string;
    checkedOutBranch?: string;
    sessionId: string;
  };
  const parseRemovalEntry = (
    data: unknown,
  ):
    | ({ action: "request" } & PendingRemoval)
    | { action: "resolve"; id: string; sessionId: string }
    | undefined => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const value = data as Record<string, unknown>;
    const valid = (key: string, max: number) =>
      typeof value[key] === "string" &&
      value[key].length > 0 &&
      value[key].length <= max;
    if (
      value.version !== 1 ||
      !valid("id", 128) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.id as string,
      ) ||
      !valid("sessionId", 256)
    )
      return;
    if (value.action === "resolve") {
      if (
        Object.keys(value).some(
          (key) => !["version", "action", "id", "sessionId"].includes(key),
        )
      )
        return;
      return {
        action: "resolve",
        id: value.id as string,
        sessionId: value.sessionId as string,
      };
    }
    if (
      value.action !== "request" ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "action",
            "id",
            "sessionId",
            "branch",
            "repoKey",
            "assignmentId",
            "checkoutPath",
            "checkedOutBranch",
          ].includes(key),
      ) ||
      !valid("branch", 256) ||
      !valid("repoKey", 4096) ||
      !valid("assignmentId", 256) ||
      !valid("checkoutPath", 4096)
    )
      return;
    return {
      action: "request",
      id: value.id as string,
      sessionId: value.sessionId as string,
      branch: value.branch as string,
      repoKey: value.repoKey as string,
      assignmentId: value.assignmentId as string,
      checkoutPath: value.checkoutPath as string,
      ...(typeof value.checkedOutBranch === "string"
        ? { checkedOutBranch: value.checkedOutBranch }
        : {}),
    };
  };
  const pendingRemovals = (ctx: ExtensionContext) => {
    const pending = new Map<string, PendingRemoval>();
    const sessionId = ctx.sessionManager.getSessionId();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== REMOVAL_ENTRY)
        continue;
      const event = parseRemovalEntry(entry.data);
      if (!event || event.sessionId !== sessionId) continue;
      if (event.action === "request") pending.set(event.branch, event);
      else
        for (const [branch, request] of pending)
          if (request.id === event.id) pending.delete(branch);
    }
    return pending;
  };
  const updateRemovalStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || typeof ctx.ui.setStatus !== "function") return;
    const count =
      activeRole() === "manager" && host.managerLease()
        ? pendingRemovals(ctx).size
        : 0;
    ctx.ui.setStatus(
      "pi-herdsman-removal",
      count
        ? `${count} worktree removal approval${count === 1 ? "" : "s"} pending · /manager remove`
        : undefined,
    );
  };
  const resolvePendingRemoval = (
    request: PendingRemoval,
    ctx: ExtensionContext,
  ) => {
    host.pi.appendEntry(REMOVAL_ENTRY, {
      version: 1,
      action: "resolve",
      id: request.id,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    updateRemovalStatus(ctx);
  };
  const removeWorktree = async (
    branch: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    options: {
      expected?: PendingRemoval;
      preauthorized?: boolean;
      integration?: {
        assignmentId: string;
        sourceHead: string;
        targetPath: string;
        targetBranch: string;
      };
    } = {},
  ) => {
    const pendingAtStart = pendingRemovals(ctx).get(branch);
    if (activeRole() !== "manager")
      throw new Error("Only Managers can remove project worktrees");
    const operationSignal = signal ?? ctx.signal;
    operationSignal?.throwIfAborted();
    const candidate = await inspectRemovalTarget(branch, ctx, operationSignal);
    if (
      options.expected &&
      (options.expected.repoKey !== candidate.manager.repoKey ||
        options.expected.assignmentId !== candidate.assignment.id ||
        options.expected.checkoutPath !== candidate.checkoutPath ||
        !options.expected.checkedOutBranch ||
        options.expected.checkedOutBranch !== candidate.checkedOutBranch ||
        options.expected.sessionId !== ctx.sessionManager.getSessionId())
    )
      throw new Error("Pending removal target changed; worktree preserved");
    await assertNoUnrelatedPiExecution(candidate, ctx, operationSignal);
    const preauthorized = isWorktreeRemovalPreapproved(
      candidate.manager.repoKey,
    );
    const integrated = options.integration;
    const usedRemovalPreapproval = preauthorized && !integrated;
    const mergeAuthorized = () =>
      !!integrated &&
      effectiveMergePolicy(host.readConfig(), candidate.manager.repoKey)
        .enabled;
    if (integrated) {
      if (
        !mergeAuthorized() ||
        integrated.assignmentId !== candidate.assignment.id ||
        integrated.targetPath !== candidate.sourceCheckoutPath ||
        !integrated.targetBranch
      )
        throw new Error(
          "Verified integration authorization is stale; worktree preserved",
        );
      const [source, target] = await Promise.all([
        host.pi.exec("git", ["rev-parse", "HEAD"], {
          cwd: candidate.checkoutPath,
          signal: operationSignal,
          timeout: 10_000,
        }),
        host.pi.exec(
          "git",
          ["merge-base", "--is-ancestor", integrated.sourceHead, "HEAD"],
          {
            cwd: candidate.sourceCheckoutPath,
            signal: operationSignal,
            timeout: 10_000,
          },
        ),
      ]);
      const branch = await host.pi.exec(
        "git",
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        {
          cwd: candidate.sourceCheckoutPath,
          signal: operationSignal,
          timeout: 10_000,
        },
      );
      if (
        source.code !== 0 ||
        String(source.stdout ?? "").trim() !== integrated.sourceHead ||
        target.code !== 0 ||
        target.killed ||
        branch.code !== 0 ||
        branch.killed ||
        branch.stderr?.trim() ||
        String(branch.stdout ?? "").trim() !== integrated.targetBranch
      )
        throw new Error(
          "Integrated source or target could not be reverified; worktree preserved",
        );
    }
    if (
      usedRemovalPreapproval &&
      !isWorktreeRemovalPreapproved(candidate.manager.repoKey)
    )
      throw new Error("Project removal preauthorization was revoked");
    const bypass = preauthorized || !!integrated;
    if (!bypass && !ctx.hasUI)
      throw new Error("Worktree removal requires interactive confirmation");
    const answer = bypass
      ? "remove"
      : await ctx.ui.input(
          [
            "Remove worktree",
            "",
            `Branch: ${branch}`,
            ...(candidate.checkedOutBranch &&
            candidate.checkedOutBranch !== branch
              ? [`Checked-out branch: ${candidate.checkedOutBranch}`]
              : []),
            `Checkout: ${candidate.checkoutPath}`,
            "",
            "Removes this checkout and Herdr workspace.",
            "Removing this worktree automatically stops its running Managed Lead and owned Agents first.",
            "If a later removal step fails, they are not automatically restarted.",
            "The Git branch and Pi conversation are preserved.",
            "The project assignment is retired only after verified checkout removal.",
            "",
            "Type remove to confirm.",
          ].join("\n"),
          undefined,
          { signal: operationSignal },
        );
    operationSignal?.throwIfAborted();
    if (answer !== "remove")
      return {
        content: [
          {
            type: "text" as const,
            text: `Removal of ${branch} cancelled; no changes made.`,
          },
        ],
        details: { ok: false, action: "remove", branch, cancelled: true },
      };
    return host.withProjectWorkLock(
      `${candidate.manager.repoKey}\0${branch}`,
      async () => {
        let reopened = false;
        let leadStopped = false;
        const removed = await host
          .withProjectAssignmentLock(
            candidate.manager.repoKey,
            branch,
            async () => {
              operationSignal?.throwIfAborted();
              const current = await inspectRemovalTarget(
                branch,
                ctx,
                operationSignal,
              );
              if (
                current.assignment.id !== candidate.assignment.id ||
                !sameDirectory(current.checkoutPath, candidate.checkoutPath) ||
                !host.sameManagerDescriptor(current.manager, candidate.manager)
              )
                throw new Error(
                  "Removal target changed during confirmation; worktree preserved",
                );
              if (
                (usedRemovalPreapproval &&
                  !isWorktreeRemovalPreapproved(current.manager.repoKey)) ||
                (integrated &&
                  (!mergeAuthorized() ||
                    integrated.assignmentId !== current.assignment.id))
              )
                throw new Error("Project removal preauthorization was revoked");
              await assertNoUnrelatedPiExecution(current, ctx, operationSignal);
              if (current.liveLead) {
                try {
                  if (
                    (usedRemovalPreapproval &&
                      !isWorktreeRemovalPreapproved(current.manager.repoKey)) ||
                    (integrated && !mergeAuthorized())
                  )
                    throw new Error(
                      "Project removal preauthorization was revoked",
                    );
                  await stopExecution(
                    current.assignment.id,
                    current.liveLead,
                    ctx,
                    operationSignal,
                  );
                  leadStopped = true;
                } catch (error) {
                  throw new Error(
                    `Managed execution could not be stopped; worktree was preserved: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              const inventory = await host.herdrSessionSnapshot(
                host.pi,
                ctx,
                operationSignal,
              );
              const occupants = inventory.agents.filter(
                (agent) =>
                  agent.workspace_id === current.worktree.open_workspace_id &&
                  host.isPiAgent(agent),
              );
              if (occupants.length)
                throw new Error(
                  `${leadStopped ? "Assigned Lead stopped; " : ""}unrelated or remaining Pi execution occupies the worktree; removal was not attempted`,
                );
              let workspaceId = current.worktree.open_workspace_id;
              if (!workspaceId) {
                const opened = await host.runHerdr(
                  host.pi,
                  ctx,
                  [
                    "worktree",
                    "open",
                    "--workspace",
                    current.manager.workspaceId,
                    "--path",
                    current.checkoutPath,
                    "--no-focus",
                  ],
                  { signal: operationSignal },
                );
                workspaceId = opened?.workspace?.workspace_id;
                if (
                  !workspaceId ||
                  workspaceId === current.manager.workspaceId ||
                  !sameDirectory(
                    opened?.worktree?.path ?? "",
                    current.checkoutPath,
                  )
                )
                  throw new Error(
                    "Herdr reopened a different or ambiguous worktree; checkout preserved",
                  );
                reopened = true;
              }
              let final: Awaited<ReturnType<typeof inspectRemovalTarget>>;
              try {
                final = await inspectRemovalTarget(
                  branch,
                  ctx,
                  operationSignal,
                );
              } catch (error) {
                if (!leadStopped) throw error;
                throw new Error(
                  `Assigned Lead stopped; checkout was preserved because final verification failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              if (
                final.assignment.id !== current.assignment.id ||
                final.worktree.open_workspace_id !== workspaceId ||
                !sameDirectory(final.checkoutPath, current.checkoutPath)
              )
                throw new Error(
                  "Removal target changed before native removal; worktree preserved",
                );
              try {
                operationSignal?.throwIfAborted();
                if (
                  (usedRemovalPreapproval &&
                    !isWorktreeRemovalPreapproved(final.manager.repoKey)) ||
                  (integrated &&
                    (!mergeAuthorized() ||
                      final.assignment.id !== integrated.assignmentId))
                )
                  throw new Error(
                    "Project removal preauthorization was revoked",
                  );
                if (integrated) {
                  const [source, target, targetBranch] = await Promise.all([
                    host.pi.exec("git", ["rev-parse", "HEAD"], {
                      cwd: final.checkoutPath,
                      signal: operationSignal,
                      timeout: 10_000,
                    }),
                    host.pi.exec(
                      "git",
                      [
                        "merge-base",
                        "--is-ancestor",
                        integrated.sourceHead,
                        "HEAD",
                      ],
                      {
                        cwd: final.sourceCheckoutPath,
                        signal: operationSignal,
                        timeout: 10_000,
                      },
                    ),
                    host.pi.exec(
                      "git",
                      ["symbolic-ref", "--quiet", "--short", "HEAD"],
                      {
                        cwd: final.sourceCheckoutPath,
                        signal: operationSignal,
                        timeout: 10_000,
                      },
                    ),
                  ]);
                  if (
                    source.code !== 0 ||
                    source.killed ||
                    String(source.stdout ?? "").trim() !==
                      integrated.sourceHead ||
                    target.code !== 0 ||
                    target.killed ||
                    targetBranch.code !== 0 ||
                    targetBranch.killed ||
                    targetBranch.stderr?.trim() ||
                    String(targetBranch.stdout ?? "").trim() !==
                      integrated.targetBranch
                  )
                    throw new Error(
                      "Integrated source or target changed before removal; worktree preserved",
                    );
                }
                return {
                  result: await host.runHerdr(
                    host.pi,
                    ctx,
                    ["worktree", "remove", "--workspace", workspaceId],
                    { signal: operationSignal, timeout: 180_000 },
                  ),
                };
              } catch (error) {
                return {
                  error: error instanceof Error ? error.message : String(error),
                  commandInterrupted:
                    error instanceof OperationError &&
                    error.detail.details?.killed === true,
                  reopened,
                };
              }
            },
            operationSignal,
          )
          .catch((error) => {
            if (!leadStopped && !reopened) throw error;
            throw new Error(
              `${leadStopped ? "Assigned Lead stopped; " : ""}${reopened ? "Herdr workspace reopened; " : ""}worktree removal did not complete: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        let assignmentRetired = false;
        let retirementError: string | undefined;
        const checkoutState = gitPathStatus(candidate.checkoutPath);
        const checkoutRemoved = checkoutState === "absent";
        try {
          await host.reconcileProjectAssignments(
            ctx,
            candidate.manager.repoKey,
            candidate.manager.workspaceId,
            candidate.sourceCheckoutPath,
            true,
            branch,
            false,
            integrated?.assignmentId,
          );
          assignmentRetired = !host.readProjectAssignment(
            host.supervisionRuntime(),
            candidate.manager.repoKey,
            branch,
          );
        } catch (error) {
          assignmentRetired = !host.readProjectAssignment(
            host.supervisionRuntime(),
            candidate.manager.repoKey,
            branch,
          );
          retirementError =
            error instanceof Error ? error.message : String(error);
        }
        let pendingResolutionError: string | undefined;
        const currentPending = pendingRemovals(ctx).get(branch);
        if (
          checkoutRemoved &&
          pendingAtStart &&
          pendingAtStart.repoKey === candidate.manager.repoKey &&
          pendingAtStart.assignmentId === candidate.assignment.id &&
          pendingAtStart.checkoutPath === candidate.checkoutPath &&
          currentPending?.id === pendingAtStart.id &&
          currentPending.repoKey === pendingAtStart.repoKey &&
          currentPending.assignmentId === pendingAtStart.assignmentId &&
          currentPending.checkoutPath === pendingAtStart.checkoutPath
        ) {
          try {
            resolvePendingRemoval(pendingAtStart, ctx);
          } catch (error) {
            pendingResolutionError =
              error instanceof Error ? error.message : String(error);
          }
        }
        const mayFinishLater =
          "error" in removed && removed.commandInterrupted
            ? " Herdr may still complete removal after the CLI stopped."
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: checkoutRemoved
                ? assignmentRetired
                  ? `${leadStopped ? "Assigned Lead stopped; " : ""}removed checkout for ${branch}; assignment retired. Git branch and Pi conversation preserved.${pendingResolutionError ? ` Warning: pending removal approval could not be resolved: ${pendingResolutionError}` : ""}`
                  : `${leadStopped ? "Assigned Lead stopped; " : ""}checkout removed for ${branch}; assignment retirement is unconfirmed${retirementError ? `: ${retirementError}` : "."}${pendingResolutionError ? ` Warning: pending removal approval could not be resolved: ${pendingResolutionError}` : ""}`
                : checkoutState === "present"
                  ? `${leadStopped ? "Assigned Lead stopped; " : ""}worktree removal is unconfirmed for ${branch}; checkout was present at the last check; assignment ${assignmentRetired ? "was retired" : "remains recorded"}${"error" in removed ? `: ${removed.error}` : "."}${mayFinishLater}`
                  : `${leadStopped ? "Assigned Lead stopped; " : ""}worktree removal result is unknown for ${branch}; assignment ${assignmentRetired ? "was retired" : "retirement is unconfirmed"}${"error" in removed ? `: ${removed.error}` : "."}${mayFinishLater}`,
            },
          ],
          details: {
            ok: checkoutRemoved && assignmentRetired,
            action: "remove",
            branch,
            checkout_path: candidate.checkoutPath,
            lead_stopped: leadStopped,
            checkout_removed: checkoutRemoved,
            assignment_retired: assignmentRetired,
            repo_key: candidate.manager.repoKey,
            assignment_id: candidate.assignment.id,
            forced: false,
            checkout_state: checkoutRemoved ? "removed" : checkoutState,
            ...("error" in removed ? { removal_error: removed.error } : {}),
            ...("error" in removed && removed.reopened
              ? { workspace_reopened: true }
              : {}),
            ...(retirementError ? { retirement_error: retirementError } : {}),
            ...(pendingResolutionError ? { pendingResolutionError } : {}),
          },
        };
      },
    );
  };
  const listPendingRemovals = (ctx: ExtensionContext) => {
    const requests = [...pendingRemovals(ctx).values()];
    if (activeRole() !== "manager" || !host.managerLease()) return [];
    return requests;
  };
  const approvePendingRemoval = async (
    selected: PendingRemoval,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const current = pendingRemovals(ctx).get(selected.branch);
    if (current?.id !== selected.id)
      throw new Error("Pending removal changed; review the new request");
    if (activeRole() !== "manager" || !host.managerLease())
      throw new Error("Manager authority is no longer active");
    resolvePendingRemoval(selected, ctx);
    return removeWorktree(selected.branch, ctx, signal ?? ctx.signal, {
      expected: selected,
    });
  };
  const cancelPendingRemoval = (
    selected: PendingRemoval,
    ctx: ExtensionContext,
  ) => {
    if (pendingRemovals(ctx).get(selected.branch)?.id !== selected.id)
      return false;
    resolvePendingRemoval(selected, ctx);
    return true;
  };
  const forgetLegacyProjectAssignment = async (
    branch: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const operationSignal = signal ?? ctx.signal;
    const initialManager = await host.currentManager(ctx);
    const lease = host.managerLease();
    if (
      host.activeRole() !== "manager" ||
      !initialManager ||
      !lease ||
      host.leadRuntime.roleSuspended ||
      !host.sameManagerDescriptor(initialManager, lease.descriptor)
    )
      throw new Error(
        "Only the active, lease-verified Manager can forget an assignment",
      );
    const before = host.readProjectAssignment(
      host.supervisionRuntime(),
      initialManager.repoKey,
      branch,
    );
    if (!before) throw new Error("No project assignment exists on this branch");
    const localScope = await localRepositoryScope(
      host.pi,
      ctx,
      initialManager.workspaceId,
      operationSignal,
    );
    if (!localScope.isPrimary || localScope.repoKey !== initialManager.repoKey)
      throw new Error("Manager checkout is not the verified primary checkout");
    const initialTopology = await host.runHerdr(
      host.pi,
      ctx,
      ["worktree", "list", "--workspace", initialManager.workspaceId],
      { signal: operationSignal },
    );
    if (
      initialTopology?.source?.repo_key !== initialManager.repoKey ||
      typeof initialTopology?.source?.source_checkout_path !== "string" ||
      !sameDirectory(
        initialTopology.source.source_checkout_path,
        localScope.checkoutPath,
      )
    )
      throw new Error("Herdr worktree topology is unavailable or inconsistent");
    await host.reconcileProjectAssignments(
      ctx,
      initialManager.repoKey,
      initialManager.workspaceId,
      initialTopology.source.source_checkout_path,
      false,
      branch,
      false,
      before.id,
    );
    const afterReconciliation = host.readProjectAssignment(
      host.supervisionRuntime(),
      initialManager.repoKey,
      branch,
    );
    if (!afterReconciliation)
      return {
        content: [
          {
            type: "text" as const,
            text: `Automatically retired verified absent assignment ${branch}; no manual release was needed.`,
          },
        ],
        details: { ok: true, branch, automatic: true },
      };
    if (afterReconciliation.id !== before.id)
      throw new Error("Project assignment changed during reconciliation");
    const verify = async (expectedId: string) => {
      const manager = await host.currentManager(ctx);
      if (
        host.activeRole() !== "manager" ||
        host.leadRuntime.roleSuspended ||
        !manager ||
        !host.sameManagerDescriptor(manager, initialManager) ||
        !host.managerLease() ||
        !host.sameManagerDescriptor(
          host.managerLease()!.descriptor,
          initialManager,
        )
      )
        throw new Error(
          "Manager authority changed; assignment was not retired",
        );
      const group = await host.worktreeGroupScope(
        host.pi,
        ctx,
        manager.workspaceId,
        operationSignal,
      );
      if (group.repoKey !== manager.repoKey)
        throw new Error("Manager worktree group is not authoritative");
      const localScope = await localRepositoryScope(
        host.pi,
        ctx,
        manager.workspaceId,
        operationSignal,
      );
      if (!localScope.isPrimary || localScope.repoKey !== manager.repoKey)
        throw new Error(
          "Manager checkout is not the verified primary checkout",
        );
      const topology = await host.runHerdr(
        host.pi,
        ctx,
        ["worktree", "list", "--workspace", manager.workspaceId],
        { signal: operationSignal },
      );
      if (
        topology?.source?.repo_key !== manager.repoKey ||
        typeof topology?.source?.source_checkout_path !== "string" ||
        !sameDirectory(
          topology.source.source_checkout_path,
          localScope.checkoutPath,
        ) ||
        !Array.isArray(topology.worktrees) ||
        topology.worktrees.some(
          (worktree: any) =>
            typeof worktree?.path !== "string" ||
            !worktree.path ||
            (worktree.branch !== undefined &&
              typeof worktree.branch !== "string"),
        )
      )
        throw new Error(
          "Herdr worktree topology is unavailable or inconsistent",
        );
      const current = host.readProjectAssignment(
        host.supervisionRuntime(),
        manager.repoKey,
        branch,
      );
      if (!current || current.id !== expectedId || current.branch !== branch)
        throw new Error("Project assignment changed; nothing was retired");
      if (current.checkoutPath)
        throw new Error(
          "Checkout provenance exists; automatic reconciliation owns this assignment",
        );
      if (current.piSessionFile) {
        try {
          const session = host.SessionManager.open(current.piSessionFile);
          if (session.getSessionId() !== current.id)
            throw new Error("Assignment session identity conflicts");
          throw new Error("Checkout provenance exists; assignment preserved");
        } catch (error) {
          if (
            error instanceof Error &&
            /Checkout provenance|identity conflicts/u.test(error.message)
          )
            throw error;
          throw new Error(
            "Assignment session provenance is unavailable or conflicting",
          );
        }
      }
      const [git, common, root] = await Promise.all([
        host.pi.exec("git", ["worktree", "list", "--porcelain", "-z"], {
          cwd: topology.source.source_checkout_path,
          signal: operationSignal,
          timeout: 10_000,
        }),
        host.pi.exec(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          {
            cwd: topology.source.source_checkout_path,
            signal: operationSignal,
            timeout: 10_000,
          },
        ),
        host.pi.exec("git", ["rev-parse", "--show-toplevel"], {
          cwd: topology.source.source_checkout_path,
          signal: operationSignal,
          timeout: 10_000,
        }),
      ]);
      const inventory = parseGitWorktreeInventory(String(git.stdout ?? ""));
      if (
        git.code !== 0 ||
        git.killed ||
        git.stderr?.trim() ||
        !inventory ||
        common.code !== 0 ||
        common.killed ||
        common.stderr?.trim() ||
        root.code !== 0 ||
        root.killed ||
        root.stderr?.trim() ||
        !sameDirectory(String(common.stdout ?? "").trim(), manager.repoKey) ||
        !sameDirectory(
          String(root.stdout ?? "").trim(),
          topology.source.source_checkout_path,
        ) ||
        !inventory.some((worktree) =>
          sameDirectory(worktree.path, topology.source.source_checkout_path),
        )
      )
        throw new Error(
          "Git worktree inventory is unavailable or inconsistent",
        );
      if (
        inventory.some((worktree) => worktree.branch === branch) ||
        topology.worktrees.some((worktree: any) => worktree?.branch === branch)
      )
        throw new Error(
          "A checkout still uses this branch; assignment preserved",
        );
      const [leads, snapshot] = await Promise.all([
        host.liveLead(ctx, current.id),
        host.herdrSessionSnapshot(host.pi, ctx, operationSignal),
      ]);
      const agentStates = host.scanAgentStates();
      if (agentStates.issues.length)
        throw new Error(
          "Agent ownership inventory is incomplete; assignment preserved",
        );
      if (
        leads.length ||
        snapshot.agents.some(
          (agent) => host.herdrSessionId(agent) === current.id,
        ) ||
        agentStates.states.some(
          ({ state }) =>
            state.ownerSessionId === current.id ||
            state.piSessionId === current.id ||
            state.projectAssignmentId === current.id,
        )
      )
        throw new Error(
          "Live or potentially active execution is known; assignment preserved",
        );
      return { manager, current };
    };
    const assignments = host
      .listProjectAssignments(host.supervisionRuntime(), initialManager.repoKey)
      .filter((assignment) => assignment.branch === branch);
    if (assignments.length !== 1)
      throw new Error(
        "Branch does not identify exactly one current assignment",
      );
    const expectedId = assignments[0]!.id;
    await verify(expectedId);
    if (!ctx.hasUI)
      throw new Error(
        "Legacy assignment release requires interactive confirmation",
      );
    const answer = await ctx.ui.input(
      `Release Manager authority for ${branch}?\n\nThis removes the durable project assignment and retires its pending project messages. Git checkouts, branches, Pi conversations, processes, and Agent ownership are not changed.\n\nNo live target execution or matching branch checkout was found, but unobserved execution cannot be ruled out.\n\nType forget ${branch} to confirm.`,
      undefined,
      { signal: operationSignal },
    );
    if (answer !== `forget ${branch}`)
      return {
        content: [
          {
            type: "text" as const,
            text: `Forget of ${branch} cancelled; assignment unchanged.`,
          },
        ],
        details: { ok: false, cancelled: true, branch },
      };
    return host.withProjectWorkLock(
      `${initialManager.repoKey}\0${branch}`,
      () =>
        host.withProjectAssignmentLock(
          initialManager.repoKey,
          branch,
          async () => {
            const { current } = await verify(expectedId);
            if (
              !host.retireProjectAssignment(host.supervisionRuntime(), current)
            )
              throw new Error("Assignment changed; nothing was retired");
            try {
              host.removeProjectMessagesForAssignment(
                host.supervisionRuntime(),
                current,
              );
            } catch (error) {
              host.appendDurableError(
                host.pi,
                ctx,
                "pi_herdsman_state_error",
                error,
              );
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Released Manager authority for ${branch}; Git and Pi history preserved.`,
                },
              ],
              details: { ok: true, branch, assignment_id: expectedId },
            };
          },
          operationSignal,
        ),
    );
  };
  const setRemovalPreauthorization = async (
    enabled: boolean,
    ctx: ExtensionContext,
  ) => {
    const manager = await host.currentManager(ctx);
    if (host.activeRole() !== "manager" || !manager || !ctx.hasUI)
      throw new Error(
        "Only an interactive active Manager can change this setting",
      );
    const group = await host.worktreeGroupScope(
      host.pi,
      ctx,
      manager.workspaceId,
      ctx.signal,
    );
    if (group.repoKey !== manager.repoKey)
      throw new Error("Manager worktree group is not authoritative");
    if (enabled) {
      const answer = await ctx.ui.input(
        `Skip worktree removal confirmation for this verified repository?\n\n${manager.repoKey}\n\nSubsequent explicitly requested removals here can proceed without a per-removal prompt. All safety checks remain active. Type enable to confirm.`,
        undefined,
        { signal: ctx.signal },
      );
      if (answer !== "enable") return false;
    }
    const current = await host.currentManager(ctx);
    if (!current || !host.sameManagerDescriptor(current, manager))
      throw new Error("Manager authority changed before saving the setting");
    setWorktreeRemovalPreapproved(manager.repoKey, enabled);
    return isWorktreeRemovalPreapproved(manager.repoKey) === enabled;
  };
  const getRemovalPreauthorization = async (ctx: ExtensionContext) => {
    const manager = await host.currentManager(ctx);
    if (host.activeRole() !== "manager" || !manager)
      throw new Error("Only the active Manager can inspect this setting");
    const group = await host.worktreeGroupScope(
      host.pi,
      ctx,
      manager.workspaceId,
      ctx.signal,
    );
    if (group.repoKey !== manager.repoKey)
      throw new Error("Manager worktree group is not authoritative");
    const current = await host.currentManager(ctx);
    if (!current || !host.sameManagerDescriptor(current, manager))
      throw new Error("Manager authority changed while reading this setting");
    return {
      repoKey: manager.repoKey,
      enabled: isWorktreeRemovalPreapproved(manager.repoKey),
    };
  };
  const {
    pi,
    leadRuntime,
    HERDSMAN_BUILD,
    HERDSMAN_EXTENSION_PATH,
    SessionManager,
    supervisedSessionFile,
    sameObservedSessionPath,
    currentManager,
    currentProjectAssignment,
    sameManagerDescriptor,
    worktreeGroupScope,
    supervisionRuntime,
    readProjectAssignment,
    runHerdr,
    liveAgent,
    readLeadCoordinationState,
    scanAgentStates,
    writeChiefMessage,
    herdrSessionSnapshot,
    isPiAgent,
    herdrSessionId,
    messageLimits,
    prepareMessageInput,
    resolveMessageFiles,
    projectAssignmentBytes,
    writeProjectAssignment,
    delay,
    startHerdrAgentInPane,
    sessionIdentity,
    captureStartupDiagnostic,
    appendDurableError,
    stopHerdrAgentPreservingPane,
    expectedSession,
    liveLead,
    withProjectWorkLock,
    withProjectAssignmentLock,
  } = host;
  const requireCompatibleBuild: LeadProjectHost["requireCompatibleBuild"] =
    host.requireCompatibleBuild;
  const {
    activeRole,
    currentChiefAuthority,
    directReports,
    truncateModelText,
    loadSupervisionSnapshot,
    inspectHerdrAgent,
    readPersistedTranscript,
    prepareCoordinationInput,
    stopProjectLead: projectStop,
  } = host;
  const persistLeadSessionFile = async (
    assignment: ProjectAssignment,
    piSessionFile: string,
    signal?: AbortSignal,
  ): Promise<ProjectAssignment> =>
    host.withProjectAssignmentLock(
      assignment.repoKey,
      assignment.branch,
      () => {
        const current = host.readProjectAssignment(
          host.supervisionRuntime(),
          assignment.repoKey,
          assignment.branch,
        );
        if (!current || current.id !== assignment.id)
          throw new Error("Project assignment changed during Lead activation");
        if (current.piSessionFile) {
          if (!sameObservedSessionPath(current.piSessionFile, piSessionFile))
            throw new Error(
              "Lead session path conflicts with persisted project identity",
            );
          return current;
        }
        const bound = { ...current, piSessionFile };
        host.writeProjectAssignment(host.supervisionRuntime(), bound);
        return bound;
      },
      signal,
    );
  const bindLeadSessionFile = async (
    assignment: ProjectAssignment,
    lead: HerdrRecord,
    signal?: AbortSignal,
  ): Promise<ProjectAssignment> => {
    const piSessionFile = supervisedSessionFile(lead, assignment.id);
    return piSessionFile
      ? persistLeadSessionFile(assignment, piSessionFile, signal)
      : assignment;
  };
  type ProjectLeadActivation =
    | {
        action: "delegate";
        id: string;
        branch: string;
        task: string;
        base?: string;
        files?: string[];
      }
    | { action: "resume"; branch: string };
  type StaffOperation =
    | { action: "list" }
    | {
        action: "delegate";
        task: string;
        branch?: string;
        base?: string;
        files?: string[];
      }
    | { action: "resume"; branch: string }
    | { action: "remove"; branch: string }
    | { action: "merge"; branch: string; expected_head: string }
    | { action: "stop"; branch: string }
    | { action: "inspect"; target?: string; branch?: string }
    | { action: "transcript"; target?: string; branch?: string }
    | {
        action: "message";
        target?: string;
        branch?: string;
        message: string;
        files?: string[];
        retain?: boolean;
      };
  const activateProjectLead = async (
    params:
      | {
          action: "delegate";
          task: string;
          branch?: string;
          base?: string;
          files?: string[];
        }
      | { action: "resume"; branch: string },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const repoKey = leadRuntime.managerLease?.descriptor.repoKey;
    if (!repoKey) throw new Error("Manager lease is no longer active");
    const operation: ProjectLeadActivation =
      params.action === "delegate"
        ? {
            ...params,
            id: randomUUID(),
            branch:
              params.branch ?? `herdsman/work-${randomUUID().slice(0, 8)}`,
          }
        : params;
    if (!operation.branch.trim())
      throw new Error("Project branch must not be empty");
    if (
      operation.action === "delegate" &&
      operation.base !== undefined &&
      !operation.base.trim()
    )
      throw new Error("Base ref must not be empty");
    return withProjectWorkLock(`${repoKey}\0${operation.branch}`, () =>
      activateProjectLeadLocked(operation, ctx, signal),
    );
  };
  const mergeProject = async (
    branch: string,
    expectedHead: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const operationSignal = signal ?? ctx.signal;
    operationSignal?.throwIfAborted();
    if (!/^[0-9a-f]{40,64}$/i.test(expectedHead))
      throw new Error("expected_head must be a full commit SHA");
    let candidate: Awaited<ReturnType<typeof inspectRemovalTarget>>;
    try {
      candidate = await inspectRemovalTarget(branch, ctx, operationSignal);
    } catch (sourceError) {
      // Reconcile a vanished source only when Git independently proves its accepted SHA is integrated.
      const manager = await host.currentManager(ctx);
      const assignment =
        manager &&
        host.readProjectAssignment(
          host.supervisionRuntime(),
          manager.repoKey,
          branch,
        );
      if (
        !manager ||
        !assignment ||
        !effectiveMergePolicy(host.readConfig(), manager.repoKey).enabled
      )
        throw sourceError;
      const activeManager = await host.currentManager(ctx);
      if (
        !activeManager ||
        !host.sameManagerDescriptor(activeManager, manager) ||
        !leadRuntime.managerLease ||
        !host.sameManagerDescriptor(
          leadRuntime.managerLease.descriptor,
          manager,
        )
      )
        throw sourceError;
      const localScope = await localRepositoryScope(
        host.pi,
        ctx,
        manager.workspaceId,
        operationSignal,
      );
      if (!localScope.isPrimary || localScope.repoKey !== manager.repoKey)
        throw new Error(
          "Manager checkout is not the verified primary checkout",
        );
      const topology = await host.runHerdr(
        host.pi,
        ctx,
        ["worktree", "list", "--workspace", manager.workspaceId],
        { signal: operationSignal },
      );
      if (
        topology?.source?.repo_key !== manager.repoKey ||
        typeof topology?.source?.source_checkout_path !== "string" ||
        !sameDirectory(
          topology.source.source_checkout_path,
          localScope.checkoutPath,
        )
      )
        throw sourceError;
      const targetPath = topology.source.source_checkout_path;
      const sourceRef = await host.pi.exec(
        "git",
        ["show-ref", "--verify", "--hash", `refs/heads/${branch}`],
        { cwd: targetPath, signal: operationSignal, timeout: 10_000 },
      );
      if (
        sourceRef.code !== 0 ||
        sourceRef.killed ||
        String(sourceRef.stdout ?? "").trim() !== expectedHead
      )
        throw sourceError;
      const [branchResult, targetResult, ancestryResult] = await Promise.all([
        host.pi.exec("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: targetPath,
          signal: operationSignal,
          timeout: 10_000,
        }),
        host.pi.exec("git", ["rev-parse", "HEAD"], {
          cwd: targetPath,
          signal: operationSignal,
          timeout: 10_000,
        }),
        host.pi.exec(
          "git",
          ["merge-base", "--is-ancestor", expectedHead, "HEAD"],
          { cwd: targetPath, signal: operationSignal, timeout: 10_000 },
        ),
      ]);
      if (
        branchResult.code !== 0 ||
        targetResult.code !== 0 ||
        ancestryResult.code !== 0 ||
        ancestryResult.killed
      )
        throw sourceError;
      const targetBranch = String(branchResult.stdout ?? "").trim();
      const targetHead = String(targetResult.stdout ?? "").trim();
      if (!targetBranch || !targetHead) throw sourceError;
      if (!assignment.piSessionFile || !Array.isArray(topology.worktrees))
        throw sourceError;
      let sourcePath: string;
      try {
        const session = host.SessionManager.open(assignment.piSessionFile);
        if (session.getSessionId() !== assignment.id) throw new Error();
        sourcePath = resolve(session.getCwd());
      } catch {
        throw sourceError;
      }
      if (
        gitPathStatus(sourcePath) !== "absent" ||
        topology.worktrees.some(
          (worktree: any) =>
            worktree?.branch === branch ||
            (typeof worktree?.path === "string" &&
              resolve(worktree.path) === sourcePath),
        )
      )
        throw sourceError;
      const inventory = await host.pi.exec(
        "git",
        ["worktree", "list", "--porcelain", "-z"],
        { cwd: targetPath, signal: operationSignal, timeout: 10_000 },
      );
      const parsedInventory = parseGitWorktreeInventory(
        String(inventory.stdout ?? ""),
      );
      if (
        inventory.code !== 0 ||
        inventory.killed ||
        !parsedInventory ||
        parsedInventory.some(
          (worktree) =>
            worktree.branch === branch || resolve(worktree.path) === sourcePath,
        )
      )
        throw sourceError;
      const finalManager = await host.currentManager(ctx);
      const finalAssignment = host.readProjectAssignment(
        host.supervisionRuntime(),
        manager.repoKey,
        branch,
      );
      if (
        !finalManager ||
        !host.sameManagerDescriptor(finalManager, manager) ||
        !leadRuntime.managerLease ||
        !host.sameManagerDescriptor(
          leadRuntime.managerLease.descriptor,
          manager,
        ) ||
        finalAssignment?.id !== assignment.id ||
        finalAssignment.branch !== branch ||
        finalAssignment.repoKey !== manager.repoKey
      )
        throw sourceError;
      await host.reconcileProjectAssignments(
        ctx,
        manager.repoKey,
        manager.workspaceId,
        targetPath,
        false,
        branch,
        false,
        assignment.id,
      );
      const retired = !host.readProjectAssignment(
        host.supervisionRuntime(),
        manager.repoKey,
        branch,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: retired
              ? `Integrated ${branch} at ${expectedHead}; absent checkout reconciled and assignment retired.`
              : `Integrated ${branch} at ${expectedHead}; absent checkout reconciliation is pending.`,
          },
        ],
        details: {
          ok: retired,
          action: "merge",
          branch,
          target_branch: targetBranch,
          source_head: expectedHead,
          target_head: targetHead,
          status: retired ? "complete" : "cleanup_pending",
          integrated: true,
          checkout_removed: true,
          assignment_retired: retired,
          ...(!retired ? { reason: "absence_reconciliation_pending" } : {}),
        },
      };
    }
    const permission = () =>
      effectiveMergePolicy(host.readConfig(), candidate.manager.repoKey);
    if (!permission().enabled)
      throw new Error("Manager local merge is not enabled for this repository");
    const runGit = async (cwd: string, args: string[]) => {
      operationSignal?.throwIfAborted();
      const result = await host.pi.exec("git", args, {
        cwd,
        signal: operationSignal,
        timeout: 30_000,
      });
      return result;
    };
    const output = async (cwd: string, args: string[]) => {
      const result = await runGit(cwd, args);
      if (result.code !== 0 || result.killed || result.stderr?.trim())
        throw new Error(`Git verification failed: ${result.stderr || args[0]}`);
      return String(result.stdout ?? "").trim();
    };
    const sourceHead = await output(candidate.checkoutPath, [
      "rev-parse",
      "HEAD",
    ]);
    if (sourceHead !== expectedHead)
      throw new Error("Accepted source SHA is stale; worktree preserved");
    const sourceBranch = await output(candidate.checkoutPath, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]).catch(() => "");
    if (!sourceBranch || sourceBranch !== candidate.checkedOutBranch)
      throw new Error(
        "Assigned checkout must be on its verified named branch; worktree preserved",
      );
    if (
      (await output(candidate.checkoutPath, [
        "show-ref",
        "--verify",
        "--hash",
        `refs/heads/${sourceBranch}`,
      ])) !== expectedHead
    )
      throw new Error(
        "Accepted source branch ref is stale; worktree preserved",
      );
    const targetPath = candidate.sourceCheckoutPath;
    const targetBranch = await output(targetPath, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    const targetHead = await output(targetPath, ["rev-parse", "HEAD"]);
    const clean = async (path: string) => {
      const status = await runGit(path, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (
        status.code !== 0 ||
        status.killed ||
        status.stderr?.trim() ||
        status.stdout?.trim()
      )
        throw new Error(
          "Source and target worktrees must be clean; no changes were discarded",
        );
      for (const state of [
        "MERGE_HEAD",
        "REBASE_HEAD",
        "CHERRY_PICK_HEAD",
        "rebase-merge",
        "rebase-apply",
      ]) {
        const probe = await runGit(path, ["rev-parse", "--git-path", state]);
        if (probe.code !== 0 || probe.killed || probe.stderr?.trim())
          throw new Error("Git operation state is unverifiable");
        try {
          statSync(resolve(path, String(probe.stdout ?? "").trim()));
          throw new Error(`Git operation ${state} is in progress`);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            !(
              error instanceof Error &&
              error.message.startsWith("Git operation ")
            )
          )
            throw new Error("Git operation state is unverifiable");
          if (
            error instanceof Error &&
            error.message.startsWith("Git operation ")
          )
            throw error;
        }
      }
    };
    await clean(targetPath);
    await clean(candidate.checkoutPath);
    const targetOccupants = await host.herdrSessionSnapshot(
      host.pi,
      ctx,
      operationSignal,
    );
    const managerOccupants = targetOccupants.agents.filter(
      (agent) =>
        agent.workspace_id === candidate.manager.workspaceId &&
        host.isPiAgent(agent),
    );
    const isCurrentManager = (agent: (typeof managerOccupants)[number]) =>
      agent.workspace_id === candidate.manager.workspaceId &&
      agent.pane_id === candidate.manager.paneId &&
      agent.tab_id === candidate.manager.tabId &&
      host.herdrSessionId(agent) === candidate.manager.piSessionId;
    if (
      managerOccupants.filter(isCurrentManager).length !== 1 ||
      managerOccupants.some((agent) => !isCurrentManager(agent))
    )
      throw new Error(
        "An active execution occupies the primary target; no integration was attempted",
      );
    const ancestry = async (ancestor: string, descendant: string) => {
      const result = await runGit(targetPath, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
      if (result.code === 0 && !result.killed && !result.stderr?.trim())
        return true;
      if (result.code === 1 && !result.killed && !result.stderr?.trim())
        return false;
      throw new Error("Git ancestry could not be verified");
    };
    const initiallyIntegrated = await ancestry(expectedHead, targetHead);
    if (!initiallyIntegrated && !(await ancestry(targetHead, expectedHead)))
      return {
        content: [
          {
            type: "text" as const,
            text: `Branch ${branch} needs to incorporate target ${targetBranch} at ${targetHead}.`,
          },
        ],
        details: {
          ok: false,
          action: "merge",
          branch,
          target_branch: targetBranch,
          source_head: expectedHead,
          target_head: targetHead,
          status: "needs_update",
          integrated: false,
          checkout_removed: false,
          assignment_retired: false,
        },
      };
    await assertNoUnrelatedPiExecution(candidate, ctx, operationSignal);
    const integration = await host.withProjectWorkLock(
      `${candidate.manager.repoKey}\0${branch}`,
      () =>
        host.withProjectAssignmentLock(
          candidate.manager.repoKey,
          branch,
          async () => {
            const lockPath = `${host.projectAssignmentPath(host.supervisionRuntime(), candidate.manager.repoKey, "__integration__")}.lock`;
            const lease = host.acquireProcessLock(lockPath, {
              name: "repository integration lock",
            });
            try {
              const current = await inspectRemovalTarget(
                branch,
                ctx,
                operationSignal,
              );
              if (
                current.assignment.id !== candidate.assignment.id ||
                current.checkoutPath !== candidate.checkoutPath ||
                current.checkedOutBranch !== sourceBranch ||
                current.sourceCheckoutPath !== targetPath
              )
                throw new Error(
                  "Merge target changed; no integration performed",
                );
              if (!permission().enabled)
                throw new Error("Manager local merge permission was revoked");
              await assertNoUnrelatedPiExecution(current, ctx, operationSignal);
              await clean(targetPath);
              await clean(current.checkoutPath);
              const preStopTarget = await output(targetPath, [
                "rev-parse",
                "HEAD",
              ]);
              if (
                !(await ancestry(expectedHead, preStopTarget)) &&
                !(await ancestry(preStopTarget, expectedHead))
              )
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Branch ${branch} needs to incorporate target ${targetBranch} at ${preStopTarget}.`,
                    },
                  ],
                  details: {
                    ok: false,
                    action: "merge",
                    branch,
                    target_branch: targetBranch,
                    source_head: expectedHead,
                    target_head: preStopTarget,
                    status: "needs_update",
                    integrated: false,
                    checkout_removed: false,
                    assignment_retired: false,
                  },
                };
              if (current.liveLead)
                await stopExecution(
                  current.assignment.id,
                  current.liveLead,
                  ctx,
                  operationSignal,
                );
              const targetOccupantsNow = await host.herdrSessionSnapshot(
                host.pi,
                ctx,
                operationSignal,
              );
              const currentTargetOccupants = targetOccupantsNow.agents.filter(
                (agent) =>
                  agent.workspace_id === current.manager.workspaceId &&
                  host.isPiAgent(agent),
              );
              if (
                currentTargetOccupants.filter(isCurrentManager).length !== 1 ||
                currentTargetOccupants.some((agent) => !isCurrentManager(agent))
              )
                throw new Error(
                  "An active execution occupies the primary target; no integration was attempted",
                );
              await clean(targetPath);
              await clean(current.checkoutPath);
              const currentSource = await output(current.checkoutPath, [
                "rev-parse",
                "HEAD",
              ]);
              const currentSourceBranch = await output(current.checkoutPath, [
                "symbolic-ref",
                "--short",
                "HEAD",
              ]).catch(() => "");
              const currentTargetBranch = await output(targetPath, [
                "symbolic-ref",
                "--short",
                "HEAD",
              ]);
              const currentTarget = await output(targetPath, [
                "rev-parse",
                "HEAD",
              ]);
              if (
                currentSource !== expectedHead ||
                currentSourceBranch !== sourceBranch ||
                (await output(current.checkoutPath, [
                  "show-ref",
                  "--verify",
                  "--hash",
                  `refs/heads/${sourceBranch}`,
                ])) !== expectedHead
              )
                throw new Error(
                  "Accepted source branch or SHA changed before integration",
                );
              if (currentTargetBranch !== targetBranch)
                throw new Error(
                  "Primary target branch changed before integration",
                );
              if (await ancestry(expectedHead, currentTarget))
                return {
                  targetHead: currentTarget,
                  targetBranch,
                  alreadyIntegrated: true as const,
                };
              if (!(await ancestry(currentTarget, expectedHead)))
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Branch ${branch} needs to incorporate target ${targetBranch} at ${currentTarget}.`,
                    },
                  ],
                  details: {
                    ok: false,
                    action: "merge",
                    branch,
                    target_branch: targetBranch,
                    source_head: expectedHead,
                    target_head: currentTarget,
                    status: "needs_update",
                    integrated: false,
                    checkout_removed: false,
                    assignment_retired: false,
                  },
                };
              if (!permission().enabled)
                throw new Error("Manager local merge permission was revoked");
              let mergeError: string | undefined;
              const merged = await runGit(targetPath, [
                "merge",
                "--ff-only",
                "--no-autostash",
                "--no-overwrite-ignore",
                expectedHead,
              ]).catch((error) => {
                mergeError =
                  error instanceof Error ? error.message : String(error);
                return {
                  code: -1,
                  killed: true,
                  stdout: "",
                  stderr: mergeError,
                };
              });
              const interrupted =
                merged.killed === true || operationSignal?.aborted === true;
              const observed = await host.pi.exec(
                "git",
                ["rev-parse", "HEAD"],
                { cwd: targetPath, timeout: 10_000 },
              );
              const index = await host.pi.exec(
                "git",
                ["ls-files", "--unmerged"],
                { cwd: targetPath, timeout: 10_000 },
              );
              const status = await host.pi.exec(
                "git",
                ["status", "--porcelain=v1", "--untracked-files=all"],
                { cwd: targetPath, timeout: 10_000 },
              );
              const containsAccepted = await host.pi.exec(
                "git",
                ["merge-base", "--is-ancestor", expectedHead, "HEAD"],
                { cwd: targetPath, timeout: 10_000 },
              );
              const observedBranch = await host.pi.exec(
                "git",
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
                { cwd: targetPath, timeout: 10_000 },
              );
              const operationStates: string[] = [];
              let stateUnknown = false;
              for (const state of [
                "MERGE_HEAD",
                "REBASE_HEAD",
                "CHERRY_PICK_HEAD",
                "rebase-merge",
                "rebase-apply",
              ]) {
                const path = await host.pi.exec(
                  "git",
                  ["rev-parse", "--git-path", state],
                  { cwd: targetPath, timeout: 10_000 },
                );
                if (path.code !== 0 || path.killed) {
                  stateUnknown = true;
                  continue;
                }
                try {
                  statSync(
                    resolve(targetPath, String(path.stdout ?? "").trim()),
                  );
                  operationStates.push(state);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    stateUnknown = true;
                }
              }
              const observedHead =
                observed.code === 0 && !observed.killed
                  ? String(observed.stdout ?? "").trim()
                  : "";
              const integrationVerified =
                !!observedHead &&
                containsAccepted.code === 0 &&
                !containsAccepted.killed &&
                observedBranch.code === 0 &&
                !observedBranch.killed &&
                !observedBranch.stderr?.trim() &&
                String(observedBranch.stdout ?? "").trim() === targetBranch;
              const gitStateClean =
                status.code === 0 &&
                !status.killed &&
                !status.stderr?.trim() &&
                !status.stdout?.trim() &&
                index.code === 0 &&
                !index.killed &&
                !index.stdout?.trim() &&
                !stateUnknown &&
                operationStates.length === 0;
              if (
                !integrationVerified ||
                !gitStateClean ||
                (merged.code !== 0 && !interrupted)
              )
                return {
                  blocked: true as const,
                  targetHead: observedHead || currentTarget,
                  targetBranch,
                  integrated: integrationVerified,
                  reason: !integrationVerified
                    ? "accepted_revision_not_verified_after_merge"
                    : `git_state_after_merge:${stateUnknown ? "unknown" : operationStates.join(",") || (index.stdout?.trim() ? "unmerged_index" : status.stdout?.trim() ? "dirty_worktree" : mergeError || merged.stderr || "merge_failed")}`,
                };
              return {
                targetHead: observedHead,
                targetBranch,
                alreadyIntegrated: false as const,
              };
            } finally {
              lease.release();
            }
          },
          operationSignal,
        ),
    );
    if ("blocked" in integration)
      return {
        content: [
          {
            type: "text" as const,
            text: "Git integration did not reach a verified clean state; inspect the primary checkout before retrying.",
          },
        ],
        details: {
          ok: false,
          action: "merge",
          branch,
          target_branch: integration.targetBranch,
          source_head: expectedHead,
          target_head: integration.targetHead,
          status: "blocked",
          integrated: integration.integrated,
          checkout_removed: false,
          assignment_retired: false,
          reason: integration.reason,
        },
      };
    if ("details" in integration) return integration;
    if (!permission().enabled)
      return {
        content: [
          {
            type: "text" as const,
            text: `Integrated ${branch} at ${expectedHead}; cleanup is pending because permission was revoked.`,
          },
        ],
        details: {
          ok: false,
          action: "merge",
          branch,
          target_branch: integration.targetBranch,
          source_head: expectedHead,
          source_branch: sourceBranch,
          target_head: integration.targetHead,
          status: "cleanup_pending",
          integrated: true,
          checkout_removed: false,
          assignment_retired: false,
          reason: "merge_permission_revoked_before_cleanup",
        },
      };
    try {
      const removed = await removeWorktree(branch, ctx, operationSignal, {
        integration: {
          assignmentId: candidate.assignment.id,
          sourceHead: expectedHead,
          targetPath,
          targetBranch: integration.targetBranch,
        },
      });
      const d = removed.details as Record<string, unknown>;
      const complete =
        d.checkout_removed === true && d.assignment_retired === true;
      return {
        content: [
          {
            type: "text" as const,
            text: complete
              ? `Integrated ${branch} at ${expectedHead}; checkout removed and assignment retired.`
              : `Integrated ${branch} at ${expectedHead}; automatic cleanup remains pending.`,
          },
        ],
        details: {
          ok: complete,
          action: "merge",
          branch,
          target_branch: integration.targetBranch,
          source_head: expectedHead,
          source_branch: sourceBranch,
          target_head: integration.targetHead,
          status: complete ? "complete" : "cleanup_pending",
          integrated: true,
          checkout_removed: d.checkout_removed === true,
          assignment_retired: d.assignment_retired === true,
          ...(!complete ? { reason: "guarded_cleanup_incomplete" } : {}),
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Integrated ${branch} at ${expectedHead}; automatic cleanup remains pending: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        details: {
          ok: false,
          action: "merge",
          branch,
          target_branch: integration.targetBranch,
          source_head: expectedHead,
          source_branch: sourceBranch,
          target_head: integration.targetHead,
          status: "cleanup_pending",
          integrated: true,
          checkout_removed: false,
          assignment_retired: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  const activateProjectLeadLocked = async (
    operation: ProjectLeadActivation,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const operationName =
      operation.action === "resume" ? "resume_work" : "delegate_work";
    const manager = await currentManager(ctx);
    if (
      !manager ||
      !leadRuntime.managerLease ||
      !sameManagerDescriptor(manager, leadRuntime.managerLease.descriptor)
    )
      throw new Error("Manager lease is no longer active");
    const localScope = await localRepositoryScope(
      pi,
      ctx,
      manager.workspaceId,
      signal,
    );
    if (!localScope.isPrimary || localScope.repoKey !== manager.repoKey)
      throw new Error("Manager checkout is not the verified primary checkout");
    const primaryWorkspaceId = manager.workspaceId;
    const runtime = supervisionRuntime();
    const branch = operation.branch;
    const topology = await runHerdr(
      pi,
      ctx,
      ["worktree", "list", "--cwd", localScope.checkoutPath],
      { signal },
    );
    if (
      topology?.source?.repo_key !== manager.repoKey ||
      !Array.isArray(topology?.worktrees)
    )
      throw new Error("Herdr worktree topology is not authoritative");
    if (operation.action === "resume")
      await host.reconcileProjectAssignments(
        ctx,
        manager.repoKey,
        primaryWorkspaceId,
        typeof topology.source.source_checkout_path === "string"
          ? topology.source.source_checkout_path
          : "",
        true,
        branch,
      );
    const existing =
      operation.action === "resume"
        ? migrateProjectAssignmentEvidence(runtime, manager.repoKey, branch)
        : readProjectAssignment(runtime, manager.repoKey, branch);
    if (operation.action === "delegate" && existing) {
      await host.reconcileProjectAssignments(
        ctx,
        manager.repoKey,
        primaryWorkspaceId,
        typeof topology.source.source_checkout_path === "string"
          ? topology.source.source_checkout_path
          : "",
        true,
        branch,
      );
    }
    const currentAssignment =
      operation.action === "delegate" && existing
        ? readProjectAssignment(runtime, manager.repoKey, branch)
        : existing;
    if (currentAssignment && currentAssignment.repoKey !== manager.repoKey)
      throw new Error("Project assignment belongs to another repository");
    if (operation.action === "delegate" && currentAssignment)
      throw new Error(
        `Work already exists on ${branch}; resume it with resume_work.`,
      );
    if (operation.action === "resume" && !currentAssignment)
      throw new Error(
        `No existing work was found on ${branch}; start it with delegate_work and a task.`,
      );
    const presentationTask =
      operation.action === "resume"
        ? projectTaskSummary(currentAssignment!.text)
        : undefined;
    const id =
      operation.action === "resume" ? currentAssignment!.id : operation.id;
    let savedSessionCwd: string | undefined;
    if (operation.action === "resume" && currentAssignment!.piSessionFile) {
      try {
        const saved = host.SessionManager.open(
          currentAssignment!.piSessionFile!,
        );
        if (saved.getSessionId() === currentAssignment!.id)
          savedSessionCwd = saved.getCwd();
      } catch {
        // Keep unavailable exact-session provenance fail-closed.
      }
    }
    const placement =
      operation.action === "resume"
        ? resolveAssignmentCheckout(
            currentAssignment!,
            topology.worktrees,
            savedSessionCwd,
          )
        : undefined;
    if (placement && placement.status !== "matched")
      throw new Error(
        `Assigned checkout could not be verified: ${placement.reason}; existing work was preserved.`,
      );
    const branchWorktrees =
      operation.action === "resume"
        ? [placement!.worktree]
        : topology.worktrees.filter(
            (worktree: any) => worktree?.branch === branch,
          );
    if (branchWorktrees.length > 1)
      throw new Error(`Multiple Herdr worktrees match branch ${branch}`);
    const live =
      operation.action === "resume"
        ? await liveAgent(ctx, currentAssignment!.id)
        : [];
    if (live.length > 1)
      throw new Error(`Assignment ${id} has ambiguous live Lead identity`);
    if (live.length === 1) {
      const state = readLeadCoordinationState(runtime, id);
      requireCompatibleBuild(
        HERDSMAN_BUILD,
        state?.build,
        operationName,
        `Lead ${id}`,
      );
      if (
        !branchWorktrees[0]?.open_workspace_id ||
        live[0].workspace_id !== branchWorktrees[0].open_workspace_id ||
        !state ||
        (state.role ?? "lead") !== "lead" ||
        state.piSessionId !== id ||
        scanAgentStates().states.some(({ state }) => state.piSessionId === id)
      )
        throw new Error(
          `Lead session ${id} has conflicting placement or role; work was preserved.`,
        );
      const fresh = await currentManager(ctx);
      if (!fresh || !sameManagerDescriptor(fresh, manager))
        throw new Error("Manager changed during project activation");
      const latestState = readLeadCoordinationState(runtime, id);
      requireCompatibleBuild(
        HERDSMAN_BUILD,
        latestState?.build,
        operationName,
        `Lead ${id}`,
      );
      await bindLeadSessionFile(currentAssignment!, live[0]);
      writeChiefMessage({
        version: 2,
        build: HERDSMAN_BUILD,
        id,
        leaseId: manager.leaseId,
        kind: "project_assignment",
        fromSessionId: manager.piSessionId,
        toSessionId: id,
        leadSessionId: id,
        branch: currentAssignment!.branch,
        text: "Project assignment ready.",
        createdAt: Date.now(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Work on ${branch} is already running in Lead ${id}.`,
          },
        ],
        details: {
          ok: true,
          action: "resume",
          branch,
          session: id,
          status: "active",
          already_running: true,
          ...(presentationTask ? { presentation_task: presentationTask } : {}),
        },
      };
    }
    if (
      operation.action === "delegate" &&
      branchWorktrees.length &&
      operation.base
    )
      throw new Error("base applies only when Herdsman creates a new worktree");
    const assertUnoccupied = async (workspaceId: string) => {
      const inventory = await herdrSessionSnapshot(pi, ctx, signal);
      const managed = new Set(
        scanAgentStates().states.map(({ state }) => state.piSessionId),
      );
      const leads = inventory.agents.filter((agent: any) => {
        const session = herdrSessionId(agent);
        if (
          !session ||
          !isPiAgent(agent) ||
          agent.workspace_id !== workspaceId ||
          managed.has(session) ||
          session === id
        )
          return false;
        const state = readLeadCoordinationState(supervisionRuntime(), session);
        return state && (state.role ?? "lead") === "lead";
      });
      if (leads.length > 1)
        throw new Error(
          `Branch ${branch} has multiple live Leads; project activation is ambiguous.`,
        );
      if (leads.length)
        throw new Error(
          `Branch ${branch} already has live Lead session ${herdrSessionId(leads[0])}. Coordinate with that Lead or close it before starting managed work on this branch.`,
        );
    };
    if (branchWorktrees[0]?.open_workspace_id)
      await assertUnoccupied(branchWorktrees[0].open_workspace_id);
    let assignment: ProjectAssignment;
    const evidenceScope =
      operation.action === "resume"
        ? undefined
        : hasManagerEvidenceSelectors(operation.files ?? [])
          ? await host.managerEvidence?.(ctx, operation.files ?? [])
          : undefined;
    if (operation.action === "resume") assignment = currentAssignment!;
    else {
      const limits = await messageLimits(ctx);
      const suppliedFiles = resolveMessageFiles(
        ctx,
        operation.files,
        "delegate_work",
        evidenceScope?.retained,
        evidenceScope?.roots,
      );
      const projectBrief = persistRequiredEvidenceSnapshot(
        id,
        "project-brief.md",
        operation.task,
      );
      const attachedEvidence = requiredFiles(
        id,
        suppliedFiles,
        evidenceScope?.retained ?? [],
        ctx.cwd,
        "delegate_work",
      );
      const requiredEvidence = [projectBrief, ...attachedEvidence];
      const prepared = prepareMessageInput(
        operation.task,
        attachedEvidence.flatMap((evidence) =>
          "path" in evidence ? [evidence.path] : [evidence.result],
        ),
        ctx.cwd,
        "delegate_work",
        "Task",
        {
          inlineLimitBytes: limits.inline.bytes,
          mailboxLimitBytes: limits.mailbox.bytes,
          serializedBytes: (candidate, resultBindings) =>
            projectAssignmentBytes({
              version: 2,
              id,
              repoKey: manager.repoKey,
              branch,
              text: candidate,
              gitBaselineSha: "f".repeat(64),
              ...(resultBindings.length
                ? { resultBindings: [...resultBindings] }
                : {}),
            }),
        },
      );
      const preCreationManager = await currentManager(ctx);
      if (
        !preCreationManager ||
        !sameManagerDescriptor(preCreationManager, manager)
      )
        throw new Error("Manager changed before project activation");
      assignment = {
        version: 2,
        id,
        repoKey: manager.repoKey,
        branch,
        text: prepared.text,
        ...(requiredEvidence.length ? { requiredEvidence } : {}),
        currentEvidenceIds: requiredEvidence.map((evidence) => evidence.id),
        ...(prepared.resultBindings.length
          ? { resultBindings: prepared.resultBindings }
          : {}),
      };
    }
    const promptPaths: string[] = [];
    try {
      const currentScope = await localRepositoryScope(
        pi,
        ctx,
        manager.workspaceId,
        signal,
      );
      const current = await currentManager(ctx);
      if (
        !currentScope.isPrimary ||
        currentScope.repoKey !== manager.repoKey ||
        currentScope.checkoutPath !== localScope.checkoutPath ||
        !current ||
        !sameManagerDescriptor(current, manager)
      )
        throw new Error("Manager identity changed before project activation");
      let workspaceId: string | undefined;
      let paneId: string | undefined;
      let tabId: string | undefined;
      let cwd: string | undefined;
      const assignedPlacement =
        operation.action === "resume"
          ? resolveAssignmentCheckout(
              assignment,
              topology.worktrees,
              savedSessionCwd,
            )
          : undefined;
      const matchingWorktrees =
        operation.action === "resume"
          ? assignedPlacement?.status === "matched"
            ? [assignedPlacement.worktree]
            : []
          : topology.worktrees.filter(
              (worktree: any) => worktree?.branch === assignment.branch,
            );
      if (matchingWorktrees.length > 1)
        throw new Error(
          `Multiple Herdr worktrees match assignment branch ${assignment.branch}`,
        );
      if (matchingWorktrees.length === 1) {
        const worktree = matchingWorktrees[0];
        cwd = worktree?.path;
        if (typeof cwd !== "string" || !cwd)
          throw new Error(
            `Herdr worktree for branch ${assignment.branch} has no exact path`,
          );
        {
          const opened = await runHerdr(
            pi,
            ctx,
            [
              "worktree",
              "open",
              "--cwd",
              localScope.checkoutPath,
              ...(assignedPlacement?.status === "matched"
                ? ["--path", assignedPlacement.path]
                : ["--branch", assignment.branch]),
              "--no-focus",
            ],
            { signal },
          );
          workspaceId = opened?.workspace?.workspace_id;
          paneId = opened?.root_pane?.pane_id;
          tabId = opened?.tab?.tab_id ?? opened?.root_pane?.tab_id;
          cwd = opened?.worktree?.path;
          if (
            assignedPlacement?.status === "matched" &&
            (!opened?.worktree?.path ||
              !sameDirectory(opened.worktree.path, assignedPlacement.path))
          )
            throw new Error(
              "Herdr opened a different checkout than the persisted assignment",
            );
        }
      } else {
        if (operation.action === "resume")
          throw new Error("The existing project checkout is unavailable");
        const args = [
          "worktree",
          "create",
          "--cwd",
          localScope.checkoutPath,
          "--branch",
          assignment.branch,
          "--no-focus",
        ];
        args.push("--base", operation.base ?? "HEAD");
        const created = await runHerdr(pi, ctx, args, {
          signal,
          timeout: 180_000,
        });
        workspaceId = created?.workspace?.workspace_id;
        paneId = created?.root_pane?.pane_id;
        tabId = created?.tab?.tab_id;
        cwd = created?.worktree?.path;
        if (
          created?.worktree?.branch &&
          created.worktree.branch !== assignment.branch
        )
          throw new Error(
            "Herdr created a worktree on a different branch than the persisted assignment",
          );
      }
      if (
        ![workspaceId, paneId, tabId, cwd].every(
          (value) => typeof value === "string" && value,
        )
      )
        throw new Error("Herdr did not return exact worktree identities");
      if (operation.action === "delegate") {
        const [common, branchResult] = await Promise.all([
          pi.exec(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            { cwd: cwd!, signal, timeout: 10_000 },
          ),
          pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
            cwd: cwd!,
            signal,
            timeout: 10_000,
          }),
        ]);
        if (
          common.code !== 0 ||
          common.killed ||
          common.stderr?.trim() ||
          branchResult.code !== 0 ||
          branchResult.killed ||
          branchResult.stderr?.trim() ||
          !isAbsolute(String(common.stdout ?? "").trim()) ||
          !sameDirectory(String(common.stdout).trim(), manager.repoKey) ||
          String(branchResult.stdout ?? "").trim() !== assignment.branch
        )
          throw new Error(
            "Herdr checkout does not match the assigned repository and branch",
          );
        if (
          !isAbsolute(cwd!) ||
          workspaceId === primaryWorkspaceId ||
          !sameDirectory(
            topology.source.source_checkout_path,
            localScope.checkoutPath,
          ) ||
          sameDirectory(cwd!, topology.source.source_checkout_path) ||
          (matchingWorktrees.length === 1 &&
            !sameDirectory(cwd!, matchingWorktrees[0]!.path))
        )
          throw new Error(
            "Herdr checkout is not the verified linked project worktree",
          );
        try {
          const commit = async (
            directory: string,
          ): Promise<string | undefined> => {
            const result = await pi.exec(
              "git",
              ["rev-parse", "--verify", "HEAD^{commit}"],
              { cwd: directory, signal, timeout: 10_000 },
            );
            const sha = String(result.stdout ?? "").trim();
            return result.code === 0 &&
              !result.killed &&
              !result.stderr?.trim() &&
              /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)
              ? sha
              : undefined;
          };
          const worktreeHead = await commit(cwd!);
          let baseline = worktreeHead;
          if (worktreeHead && matchingWorktrees.length === 1) {
            try {
              const managerHead = await commit(localScope.checkoutPath);
              if (managerHead) {
                const result = await pi.exec(
                  "git",
                  ["merge-base", "--all", managerHead, worktreeHead],
                  { cwd: cwd!, signal, timeout: 10_000 },
                );
                const bases = String(result.stdout ?? "")
                  .trim()
                  .split(/\s+/u);
                if (
                  result.code === 0 &&
                  !result.killed &&
                  !result.stderr?.trim() &&
                  bases.length === 1 &&
                  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(bases[0]!)
                )
                  baseline = bases[0];
              }
            } catch {
              // Keep the verified worktree HEAD when merge-base probing fails.
            }
          }
          if (baseline)
            assignment = { ...assignment, gitBaselineSha: baseline };
        } catch {
          // Baseline telemetry is optional; checkout verification remains authoritative.
        }
        assignment = { ...assignment, checkoutPath: realpathSync.native(cwd!) };
        const fresh = await currentManager(ctx);
        if (!fresh || !sameManagerDescriptor(fresh, manager))
          throw new Error(
            "Manager changed before project assignment was published",
          );
        await withProjectAssignmentLock(
          manager.repoKey,
          assignment.branch,
          () => {
            if (
              readProjectAssignment(runtime, manager.repoKey, assignment.branch)
            )
              throw new Error(
                `Work already exists on ${assignment.branch}; resume it with resume_work.`,
              );
            const competingClaim = host
              .listProjectAssignments(runtime, manager.repoKey)
              .find((existing) => {
                if (existing.id === assignment.id) return false;
                let claimedPath = existing.checkoutPath;
                if (!claimedPath && existing.piSessionFile) {
                  try {
                    const saved = host.SessionManager.open(
                      existing.piSessionFile,
                    );
                    if (saved.getSessionId() === existing.id)
                      claimedPath = saved.getCwd();
                  } catch {
                    // Unverifiable legacy records do not establish a checkout claim.
                  }
                }
                return (
                  !!claimedPath &&
                  sameDirectory(claimedPath, assignment.checkoutPath!)
                );
              });
            if (competingClaim)
              throw new Error(
                `Checkout is already claimed by managed assignment ${competingClaim.branch}; resume that work instead.`,
              );
            if (evidenceScope)
              return evidenceScope.revalidate(() =>
                writeProjectAssignment(
                  runtime,
                  assignment,
                  evidenceScope.verify,
                ),
              );
            writeProjectAssignment(runtime, assignment);
          },
          signal,
        );
      }
      await assertUnoccupied(workspaceId!);
      let lead: any;
      let startedLead = false;
      const verifyLeadCandidate = (candidate: any): boolean => {
        const reported = sessionIdentity(candidate?.agent_session);
        if (!reported) return false;
        const resolvedSessionId = herdrSessionId(candidate);
        if (resolvedSessionId && resolvedSessionId !== assignment.id)
          throw new Error(
            "Herdr session identity does not match the Manager assignment",
          );
        const state = readLeadCoordinationState(
          supervisionRuntime(),
          assignment.id,
        );
        if (state)
          requireCompatibleBuild(
            HERDSMAN_BUILD,
            state.build,
            operationName,
            `Lead ${assignment.id}`,
          );
        const managed = scanAgentStates().states.some(
          ({ state }) => state.piSessionId === assignment.id,
        );
        if (
          managed ||
          (state &&
            ((state.role ?? "lead") !== "lead" ||
              state.piSessionId !== assignment.id))
        )
          throw new Error(
            "Existing session in new worktree has a conflicting role or identity",
          );
        return state?.role === "lead" && state.piSessionId === assignment.id;
      };
      const currentInventory = await herdrSessionSnapshot(pi, ctx, signal);
      const currentCandidates = currentInventory.agents.filter(
        (agent: any) =>
          isPiAgent(agent) &&
          agent.workspace_id === workspaceId &&
          agent.pane_id === paneId &&
          agent.tab_id === tabId,
      );
      if (currentCandidates.length > 1)
        throw new Error("Ambiguous Lead session in new worktree");
      if (currentCandidates.length === 1) {
        if (verifyLeadCandidate(currentCandidates[0]))
          lead = currentCandidates[0];
      }
      if (!lead) {
        const processInfo = await runHerdr(
          pi,
          ctx,
          ["pane", "process-info", "--pane", paneId],
          { signal },
        );
        const foreground = processInfo?.process_info?.foreground_processes;
        const piAlreadyRunning =
          currentCandidates.length === 1 ||
          (Array.isArray(foreground) &&
            foreground.some((process: any) => {
              const executable = `${process?.argv0 ?? ""} ${process?.cmdline ?? ""}`;
              return /(^|[\\/\s])pi(?:\s|$)/i.test(executable);
            }));
        if (!piAlreadyRunning) {
          await assertUnoccupied(workspaceId!);
          const projectTrusted =
            new ProjectTrustStore(getAgentDir()).get(cwd!) === true;
          const definition = discoverRoleDefinition(
            MANAGED_LEAD_DEFINITION_NAME,
            projectTrusted ? { projectRoot: cwd! } : {},
          );
          const body = expandAgentBodyFiles(definition.body, [], operationName);
          const effectiveDefinition =
            body === definition.body ? definition : { ...definition, body };
          if (body) promptPaths.push(...writePrivatePromptSnapshots([body]));
          const registeredProviderIds = new Set(
            ctx.modelRegistry?.getRegisteredProviderIds?.() ?? [],
          );
          const modelDecision = resolveChildModel({
            configured: configuredModel(effectiveDefinition.frontmatter),
            inherited:
              operation.action === "delegate" && ctx.model
                ? {
                    provider: ctx.model.provider,
                    token: `${ctx.model.provider}/${ctx.model.id}`,
                  }
                : undefined,
            isForeignProvider: (providerId) =>
              registeredProviderIds.has(providerId),
          });
          const launchArgs = agentLaunchArgs(effectiveDefinition, {
            ...(body ? { bodyPromptPath: promptPaths.at(-1)! } : {}),
            cwd: cwd!,
            requiredTools: host.leadCoordinationTools,
            ...(operation.action === "delegate"
              ? { inheritedThinking: pi.getThinkingLevel() }
              : {}),
            modelDecision,
          });
          await startHerdrAgentInPane(pi, ctx, {
            primaryWorkspaceId,
            workspaceId,
            tabId,
            paneId,
            cwd,
            label: `lead-${id.slice(0, 8)}`,
            runId: id,
            extensionPath: HERDSMAN_EXTENSION_PATH,
            agentArgs: [
              ...launchArgs,
              "--session-id",
              assignment.id,
              projectTrusted ? "--approve" : "--no-approve",
            ],
            signal,
          });
          startedLead = true;
        }
      }
      const deadline = Date.now() + 30_000;
      let piProcessSeen = false;
      let herdrSessionReported = false;
      let sessionIdResolved = false;
      let leadStateObserved = false;
      while (!lead && Date.now() < deadline) {
        const inventory = await herdrSessionSnapshot(pi, ctx, signal);
        const candidates = inventory.agents.filter(
          (agent: any) =>
            isPiAgent(agent) &&
            agent.workspace_id === workspaceId &&
            agent.pane_id === paneId &&
            agent.tab_id === tabId,
        );
        if (candidates.length > 1)
          throw new Error("Ambiguous Lead session in new worktree");
        if (candidates.length === 1) {
          piProcessSeen = true;
          herdrSessionReported = Boolean(candidates[0]?.agent_session);
          const sessionId = herdrSessionId(candidates[0]);
          sessionIdResolved = Boolean(sessionId);
          const candidateState = readLeadCoordinationState(
            supervisionRuntime(),
            assignment.id,
          );
          leadStateObserved = Boolean(candidateState);
          if (candidateState)
            requireCompatibleBuild(
              HERDSMAN_BUILD,
              candidateState.build,
              operationName,
              `Lead ${assignment.id}`,
            );
          if (verifyLeadCandidate(candidates[0])) {
            lead = candidates[0];
            break;
          }
        }
        try {
          const process = await runHerdr(
            pi,
            ctx,
            ["pane", "process-info", "--pane", paneId],
            { signal },
          );
          const foreground = process?.process_info?.foreground_processes;
          piProcessSeen ||=
            Array.isArray(foreground) &&
            foreground.some((entry: any) => {
              const executable = `${entry?.argv0 ?? ""} ${entry?.cmdline ?? ""}`;
              return /(^|[\\/\s])pi(?:\s|$)/i.test(executable);
            });
        } catch {
          // Process evidence is diagnostic only; keep polling the authoritative session API.
        }
        await delay(250, undefined, { signal });
      }
      const leadSessionId = lead && assignment.id;
      if (!leadSessionId) {
        const readiness = !piProcessSeen
          ? "No Pi process or exact-pane Herdr session was observed"
          : !herdrSessionReported
            ? "Pi process seen in the exact pane, but Herdr never reported a Pi session identity"
            : !leadStateObserved
              ? "Herdr session reported, but Herdsman Lead coordination state was never published"
              : !sessionIdResolved
                ? "Lead state was present but Herdr's session path is not yet materialized"
                : "Lead coordination state was present but not a valid Lead identity";
        let processInfo = "unavailable";
        try {
          const process = await runHerdr(
            pi,
            ctx,
            ["pane", "process-info", "--pane", paneId],
            { signal },
          );
          processInfo = JSON.stringify(process?.process_info).slice(0, 1024);
        } catch {
          processInfo = "unavailable";
        }
        const pane = await captureStartupDiagnostic(
          pi,
          ctx,
          paneId,
          Date.now() + 2_000,
          signal,
        );
        const diagnostic = JSON.stringify({
          readiness,
          paneId,
          processInfo,
          pane: pane.status === "captured" ? pane.snapshot : pane.status,
        });
        throw new Error(
          `Timed out verifying the new Lead session in pane ${paneId}; ${diagnostic}`.slice(
            0,
            4096,
          ),
        );
      }
      const assertManagerCurrent = async () => {
        const fresh = await currentManager(ctx);
        if (!fresh || !sameManagerDescriptor(fresh, manager))
          throw new Error("Manager changed during project activation");
      };
      await assertManagerCurrent();
      const latestState = readLeadCoordinationState(
        supervisionRuntime(),
        assignment.id,
      );
      requireCompatibleBuild(
        HERDSMAN_BUILD,
        latestState?.build,
        operationName,
        `Lead ${assignment.id}`,
      );
      assignment = await bindLeadSessionFile(assignment, lead, signal);
      writeChiefMessage({
        version: 2,
        build: HERDSMAN_BUILD,
        id: assignment.id,
        leaseId: manager.leaseId,
        kind: "project_assignment",
        fromSessionId: manager.piSessionId,
        toSessionId: leadSessionId,
        leadSessionId,
        branch: assignment.branch,
        text: "Project assignment ready.",
        createdAt: Date.now(),
      });
      let rediscovered: any;
      while (Date.now() < deadline) {
        const exact = (await liveLead(ctx, assignment.id)).filter(
          (candidate: any) =>
            candidate.workspace_id === workspaceId &&
            candidate.pane_id === paneId &&
            candidate.tab_id === tabId,
        );
        if (exact.length > 1)
          throw new Error(
            "Lead identity became ambiguous during project activation",
          );
        if (exact.length === 1) {
          rediscovered = exact[0];
          break;
        }
        await delay(100, undefined, { signal });
      }
      if (!rediscovered) {
        await assertManagerCurrent();
        const observed = sessionIdentity(lead.agent_session);
        const resolvedSessionId = herdrSessionId(lead);
        if (
          startedLead &&
          observed?.kind === "path" &&
          (!resolvedSessionId || resolvedSessionId === assignment.id)
        ) {
          try {
            await stopHerdrAgentPreservingPane(
              pi,
              ctx,
              paneId!,
              {
                paneId,
                tabId,
                workspaceId,
                cwd,
                session: expectedSession(assignment.id, observed.value),
              },
              signal,
            );
          } catch (error) {
            appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
          }
        }
        throw new Error(
          "Lead started but its exact Pi session identity did not materialize; assignment preserved",
        );
      }
      await assertManagerCurrent();
      await bindLeadSessionFile(assignment, rediscovered, signal);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              action: operation.action,
              session: leadSessionId,
              workspace_id: workspaceId,
              branch: assignment.branch,
              ...(operation.action === "resume" ? { recovered: true } : {}),
            }),
          },
        ],
        details: {
          ok: true,
          action: operation.action,
          session: leadSessionId,
          workspace_id: workspaceId,
          branch: assignment.branch,
          ...(operation.action === "resume" ? { recovered: true } : {}),
          ...(presentationTask ? { presentation_task: presentationTask } : {}),
        },
      };
    } catch (error) {
      appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
      throw error;
    } finally {
      for (const promptPath of promptPaths)
        if (statSync(promptPath, { throwIfNoEntry: false }))
          unlinkSync(promptPath);
    }
  };
  const executeStaff = async (
    _id: string,
    raw: unknown,
    signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    if (activeRole() !== "chief" && activeRole() !== "manager")
      throw new Error("Staff is available only to active supervisors");
    const authority =
      activeRole() === "chief"
        ? await currentChiefAuthority(ctx)
        : await currentManager(ctx);
    if (!authority || leadRuntime.roleSuspended)
      throw new Error("Supervisor lease is no longer active");
    const params = raw as StaffOperation;
    const resolveActiveAssignedBranch = async (branch: string) => {
      const manager = await currentManager(ctx);
      const assignment =
        manager &&
        host.readProjectAssignment(
          host.supervisionRuntime(),
          manager.repoKey,
          branch,
        );
      if (!assignment) throw new Error("Project assignment was not found");
      const snapshot = await loadSupervisionSnapshot(ctx);
      const matches = snapshot.work?.filter(
        (work: any) =>
          work.branch === assignment.branch && work.session === assignment.id,
      );
      const incompatible = snapshot.incompatible?.find(
        (report) => report.role === "lead" && report.session === assignment.id,
      );
      if (incompatible)
        requireCompatibleBuild(
          HERDSMAN_BUILD,
          incompatible.build,
          "staff action",
          `lead on branch ${branch}`,
        );
      if (matches?.length === 1 && matches[0]?.status === "unknown")
        throw new Error(
          "Assigned Lead verification is unavailable; no staff action was taken",
        );
      if (matches?.length !== 1 || matches[0]?.status !== "active") {
        throw new Error("Assigned work is not uniquely active");
      }
      const leads = snapshot.leads.filter(
        (lead: any) =>
          (lead.session ?? lead.lead) === assignment.id &&
          lead.relationship === "assigned" &&
          lead.branch === assignment.branch,
      );
      if (leads.length !== 1)
        throw new Error("Assigned Lead is not eligible for staff action");
      return { assignment, lead: leads[0] };
    };
    if (params.action === "delegate" || params.action === "resume") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can control project work");
      return activateProjectLead(params, ctx, signal);
    }
    if (params.action === "merge") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can integrate project branches");
      return mergeProject(params.branch, params.expected_head, ctx, signal);
    }
    if (params.action === "remove") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can remove project worktrees");
      const operationSignal = signal ?? ctx.signal;
      operationSignal?.throwIfAborted();
      const target = await inspectRemovalTarget(
        params.branch,
        ctx,
        operationSignal,
      );
      await assertNoUnrelatedPiExecution(target, ctx, operationSignal);
      if (isWorktreeRemovalPreapproved(target.manager.repoKey))
        return removeWorktree(params.branch, ctx, operationSignal, {
          preauthorized: true,
        });
      if (!ctx.hasUI)
        throw new Error("Worktree removal approval requires an interactive UI");
      const pending: PendingRemoval = {
        id: randomUUID(),
        branch: params.branch,
        repoKey: target.manager.repoKey,
        assignmentId: target.assignment.id,
        checkoutPath: target.checkoutPath,
        checkedOutBranch: target.checkedOutBranch,
        sessionId: ctx.sessionManager.getSessionId(),
      };
      const verifiedAgain = await inspectRemovalTarget(
        params.branch,
        ctx,
        operationSignal,
      );
      if (
        host.activeRole() !== "manager" ||
        pending.sessionId !== ctx.sessionManager.getSessionId() ||
        !host.sameManagerDescriptor(
          await host.currentManager(ctx),
          target.manager,
        ) ||
        verifiedAgain.assignment.id !== pending.assignmentId ||
        verifiedAgain.checkoutPath !== pending.checkoutPath ||
        verifiedAgain.checkedOutBranch !== pending.checkedOutBranch ||
        verifiedAgain.manager.repoKey !== pending.repoKey
      )
        throw new Error("Manager authority changed while preparing approval");
      const existing = pendingRemovals(ctx).get(params.branch);
      const request =
        existing?.repoKey === pending.repoKey &&
        existing.assignmentId === pending.assignmentId &&
        existing.checkoutPath === pending.checkoutPath &&
        existing.checkedOutBranch === pending.checkedOutBranch
          ? existing
          : pending;
      if (request === pending)
        host.pi.appendEntry(REMOVAL_ENTRY, {
          version: 1,
          action: "request",
          ...pending,
        });
      updateRemovalStatus(ctx);
      if (request === pending)
        ctx.ui.notify(
          `Worktree removal of ${pending.branch} awaits approval. Review with /manager remove.`,
          "info",
        );
      return {
        content: [
          {
            type: "text" as const,
            text: `Removal of ${params.branch} awaits human approval (request ${request.id}). Review it with /manager remove.`,
          },
        ],
        details: {
          ok: false,
          action: "remove",
          branch: params.branch,
          confirmation_required: true,
          pending: true,
          request_id: request.id,
        },
      };
    }
    if (params.action === "stop") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can control project work");
      if (!params.branch?.trim())
        throw new Error("Provide the exact assigned branch");
      const selected = await resolveActiveAssignedBranch(params.branch);
      const current = (
        await directReports(ctx, undefined, undefined, undefined, {
          exactSession: selected.assignment.id,
        })
      ).filter(
        (lead) =>
          (lead.session ?? lead.lead) === selected.assignment.id &&
          lead.relationship === "assigned" &&
          lead.branch === selected.assignment.branch,
      );
      if (current.length !== 1)
        throw new Error("Assigned Lead is no longer eligible for stop");
      return projectStop(
        selected.assignment.id,
        ctx,
        signal,
        selected.assignment,
        selected.lead,
      );
    }
    if (
      params.action !== "list" &&
      Number(params.branch !== undefined) +
        Number(params.target !== undefined) !==
        1
    )
      throw new Error("Provide exactly one of branch or target");
    let selectedAssignment: ProjectAssignment | undefined;
    let selectedLead: any;
    if (params.action !== "list" && params.branch !== undefined) {
      if (activeRole() !== "manager" || !params.branch.trim())
        throw new Error("Only Managers can target an exact assigned branch");
      const selected = await resolveActiveAssignedBranch(params.branch);
      selectedAssignment = selected.assignment;
      selectedLead = selected.lead;
    }
    const result = (value: Record<string, unknown>) => {
      const bounded = truncateModelText(JSON.stringify(value, null, 2), {
        keep: "head",
        sessionId: ctx.sessionManager.getSessionId(),
        key: _id,
      });
      return {
        content: [{ type: "text" as const, text: bounded.content }],
        details: {
          ...value,
          truncated: bounded.truncated,
          ...(bounded.fullOutputPath
            ? { full_output_path: bounded.fullOutputPath }
            : {}),
        },
      };
    };
    let reports: any[] = [];
    let incompatibleReports: import("../supervision.ts").IncompatibleStaff[] =
      [];
    let discoveryWarning: string | undefined;
    let managerSnapshot:
      Awaited<ReturnType<typeof loadSupervisionSnapshot>> | undefined;
    if (params.action === "list") {
      const current = await loadSupervisionSnapshot(ctx);
      if (activeRole() === "manager") managerSnapshot = current;
      reports = [
        ...(current.managers ?? []).map((item: any) => ({
          ...item,
          role: "manager",
        })),
        ...current.leads.map((item: any) => ({ ...item, role: "lead" })),
      ];
      incompatibleReports = current.incompatible ?? [];
      if (
        incompatibleReports.length ||
        (current.managers ?? []).some(
          (manager: any) => manager.incompatibleLeadCount > 0,
        )
      )
        discoveryWarning =
          "Some staff sessions run an incompatible Herdsman build and are observation-only; reload those Pi sessions with a matching Herdsman build.";
    }
    const reportSession = (report: any): string =>
      report.session ?? report.lead;
    if (params.action === "list") {
      if (
        !(activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx))
      )
        throw new Error("Supervisor lease is no longer active");
      return result({
        ok: true,
        action: "list",
        self: {
          role: activeRole(),
        },
        ...(managerSnapshot
          ? {
              work: managerSnapshot.work?.map((item) => ({
                branch: item.branch,
                status: item.status,
                ...(item.runtimeState
                  ? { runtime_state: item.runtimeState }
                  : {}),
                ...(item.task ? { task: item.task } : {}),
                ...(item.issue ? { issue: item.issue } : {}),
              })),
              open_workspaces:
                managerSnapshot.openWorkspaces?.map((workspace) => ({
                  workspace: workspace.workspaceId,
                  ...(workspace.branch ? { branch: workspace.branch } : {}),
                  path: workspace.path,
                  linked: workspace.linked,
                })) ?? [],
            }
          : {}),
        reports: reports
          .map((report: any) => {
            const role = activeRole() === "chief" ? report.role : "lead";
            const relationship = report.relationship ?? "assigned";
            const actionable =
              report.compatibility !== "incompatible" &&
              report.availableActions?.length > 0 &&
              !(activeRole() === "manager" && relationship === "assigned");
            const target =
              actionable && (role === "lead" || role === "manager")
                ? rememberCoordinatorTarget(
                    pi,
                    ctx,
                    role,
                    reportSession(report),
                  )
                : undefined;
            return {
              role,
              ...(target ? { target } : {}),
              ...(activeRole() === "manager"
                ? {
                    relationship,
                    ...(relationship === "assigned" && report.branch
                      ? { branch: report.branch }
                      : {}),
                  }
                : {}),
              display_name: report.displayName,
              runtime_state: report.runtimeState,
              agent_counts: report.agentCounts,
              ...(activeRole() === "chief"
                ? {
                    project: "project" in report ? report.project : "",
                    lead_counts:
                      "leadCounts" in report ? report.leadCounts : undefined,
                    leads:
                      "leads" in report
                        ? report.leads.map((lead: any) => ({
                            display_name: lead.display_name,
                            runtime_state: lead.runtime_state,
                            ...(lead.agent_counts
                              ? { agent_counts: lead.agent_counts }
                              : {}),
                            ...(lead.compatibility === "incompatible"
                              ? {
                                  compatibility: "incompatible",
                                  available_tools: [],
                                }
                              : {}),
                          }))
                        : [],
                  }
                : {}),
              available_tools: report.availableActions.map(staffToolName),
            };
          })
          .concat(
            incompatibleReports.map((report) => ({
              role: report.role,
              display_name: report.displayName,
              compatibility: "incompatible",
              build: report.build,
              available_tools: [],
            })),
          ),
        ...(discoveryWarning ? { warning: discoveryWarning } : {}),
      });
    }
    const resolvedTarget =
      params.target !== undefined
        ? resolveCoordinatorTarget(ctx, params.target)
        : undefined;
    const targetSession = selectedAssignment?.id ?? resolvedTarget?.sessionId;
    const unverified: UnverifiedLead[] = [];
    const incompatible: import("../supervision.ts").IncompatibleStaff[] = [];
    reports = selectedLead
      ? [selectedLead]
      : await directReports(
          ctx,
          undefined,
          undefined,
          incompatible,
          activeRole() === "manager"
            ? { exactSession: targetSession, unverified }
            : undefined,
        );
    const verificationFailure = (
      failures: UnverifiedLead[],
      incompatibleReports: import("../supervision.ts").IncompatibleStaff[],
    ) => {
      const incompatibleTarget = incompatibleReports.find(
        (report) => report.session === targetSession,
      );
      if (incompatibleTarget)
        host.requireCompatibleBuild(
          host.HERDSMAN_BUILD,
          incompatibleTarget.build,
          "staff action",
          `${incompatibleTarget.role} ${params.target ?? selectedAssignment?.branch ?? "target"}`,
        );
      const failure = failures.find((item) => item.lead === targetSession);
      if (failure)
        throw new Error(`Staff target verification failed: ${failure.issue}`);
    };
    const revalidateTarget = async () => {
      const failures: UnverifiedLead[] = [];
      const incompatibleReports: import("../supervision.ts").IncompatibleStaff[] =
        [];
      const current = await directReports(
        ctx,
        undefined,
        undefined,
        incompatibleReports,
        activeRole() === "manager"
          ? { exactSession: targetSession, unverified: failures }
          : undefined,
      );
      const matches = current.filter(
        (candidate: any) => reportSession(candidate) === targetSession,
      );
      if (matches.length !== 1) {
        verificationFailure(failures, incompatibleReports);
        return undefined;
      }
      return matches[0];
    };
    const targets = reports.filter(
      (candidate: any) => reportSession(candidate) === targetSession,
    );
    const lead = targets.length === 1 ? targets[0] : undefined;
    if (!lead) {
      if (activeRole() === "manager") {
        verificationFailure(unverified, incompatible);
      } else {
        const observation = await loadSupervisionSnapshot(ctx);
        verificationFailure([], observation.incompatible ?? []);
      }
      throw new Error(
        "Staff target was not found or is no longer eligible. Rediscover current staff with list_staff and use its target or assigned branch; never use display_name.",
      );
    }
    if (resolvedTarget && resolvedTarget.role !== (lead.role ?? "lead"))
      throw new Error(
        "Staff target role no longer matches the direct report. Rediscover with list_staff.",
      );
    if (
      (selectedAssignment && lead.relationship !== "assigned") ||
      (!selectedAssignment &&
        activeRole() === "manager" &&
        lead.relationship === "assigned")
    )
      throw new Error(
        "Assigned Leads require branch targeting; target selectors are for ordinary direct reports",
      );
    const assignmentStillCurrent = () => {
      if (!selectedAssignment) return true;
      const current = host.readProjectAssignment(
        host.supervisionRuntime(),
        selectedAssignment.repoKey,
        selectedAssignment.branch,
      );
      return (
        !!current &&
        current.id === selectedAssignment.id &&
        current.repoKey === selectedAssignment.repoKey &&
        current.branch === selectedAssignment.branch
      );
    };
    if (!assignmentStillCurrent())
      throw new Error("Project assignment changed during target resolution");
    const sameLeadIdentity = (
      candidate: typeof lead,
      expected: typeof lead,
    ): boolean =>
      reportSession(candidate) === reportSession(expected) &&
      candidate.paneId === expected.paneId &&
      candidate.workspaceId === expected.workspaceId &&
      candidate.tabId === expected.tabId &&
      candidate.instanceId === expected.instanceId;
    const sameLeadTarget = (
      candidate: typeof lead,
      expected: typeof lead,
    ): boolean => sameLeadIdentity(candidate, expected);
    if (!lead.availableActions.includes(params.action))
      throw new Error(`Lead does not currently allow ${params.action}`);
    if (params.action === "inspect") {
      const evidence = await inspectHerdrAgent(
        pi,
        ctx,
        {
          workspaceId: lead.workspaceId,
          paneId: lead.paneId,
          piSessionId: reportSession(lead),
        },
        signal,
        (agent) => {
          return (
            isPiAgent(agent) &&
            herdrSessionId(agent) === reportSession(lead) &&
            agent.pane_id === lead.paneId &&
            agent.tab_id === lead.tabId &&
            (() => {
              const state = readLeadCoordinationState(
                supervisionRuntime(),
                reportSession(lead),
              );
              return (
                state?.piSessionId === reportSession(lead) &&
                state.instanceId === lead.instanceId
              );
            })()
          );
        },
      );
      const currentAuthority =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      const currentLead = await revalidateTarget();
      const finalAuthority =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      if (
        !currentAuthority ||
        currentAuthority.leaseId !== authority.leaseId ||
        !finalAuthority ||
        finalAuthority.leaseId !== authority.leaseId ||
        !currentLead ||
        !sameLeadIdentity(currentLead, lead) ||
        currentLead.relationship !== lead.relationship ||
        !currentLead.availableActions.includes("inspect") ||
        !assignmentStillCurrent()
      )
        throw new Error("Lead changed during inspection");
      return result({
        ok: true,
        action: "inspect",
        ...(params.target ? { target: params.target } : {}),
        ...(selectedAssignment ? { branch: selectedAssignment.branch } : {}),
        display_name: lead.displayName,
        captured_at: evidence.capturedAt,
        recent_output_truncated: evidence.recentOutputTruncated,
        ...(evidence.recentOutput
          ? { recent_output: evidence.recentOutput }
          : {}),
        ...(evidence.process ? { process: evidence.process } : {}),
        agents: lead.agents ?? [],
      });
    }
    if (params.action === "transcript") {
      const sessionFile = lead.piSessionFile;
      if (!sessionFile)
        throw new Error("Lead transcript is not currently available");
      const transcript = readPersistedTranscript({
        piSessionId: reportSession(lead),
        piSessionFile: sessionFile,
      });
      const currentChief =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      const currentLead = await revalidateTarget();
      const finalAuthority =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      if (
        !currentChief ||
        currentChief.leaseId !== authority.leaseId ||
        !finalAuthority ||
        finalAuthority.leaseId !== authority.leaseId ||
        !currentLead ||
        !sameLeadIdentity(currentLead, lead) ||
        currentLead.piSessionFile !== sessionFile ||
        currentLead.relationship !== lead.relationship ||
        !currentLead.availableActions.includes("transcript") ||
        !assignmentStillCurrent()
      )
        throw new Error("Lead changed during transcript read");
      return result({
        ok: true,
        action: "transcript",
        ...(params.target ? { target: params.target } : {}),
        ...(selectedAssignment ? { branch: selectedAssignment.branch } : {}),
        display_name: lead.displayName,
        transcript: transcript.transcript,
        transcript_truncated: transcript.truncated,
      });
    }
    // Projection is only a discovery snapshot. Re-read every identity
    // and authority field immediately before creating a transport file.
    const currentChief =
      activeRole() === "chief"
        ? await currentChiefAuthority(ctx)
        : await currentManager(ctx);
    if (!currentChief || currentChief.leaseId !== authority.leaseId)
      throw new Error("Chief lease is no longer active");
    const currentLead = await revalidateTarget();
    if (
      !currentLead ||
      !sameLeadTarget(currentLead, lead) ||
      currentLead.relationship !== lead.relationship ||
      !currentLead.availableActions.includes(params.action) ||
      !assignmentStillCurrent()
    )
      throw new Error("Lead target changed before the message was queued");
    // The supervision snapshot load is awaited and can observe a lease replacement.
    const finalChief =
      activeRole() === "chief"
        ? await currentChiefAuthority(ctx)
        : await currentManager(ctx);
    if (!finalChief || finalChief.leaseId !== authority.leaseId)
      throw new Error("Chief lease is no longer active");
    const recordId = randomUUID();
    const createdAt = Date.now();
    const assignmentMatches = (candidate: typeof lead) => {
      if (activeRole() !== "manager") return undefined;
      const assignments = host.findProjectAssignmentBySession(
        supervisionRuntime(),
        host.managerLease()!.descriptor.repoKey,
        reportSession(candidate),
      );
      if (assignments.length > 1)
        throw new Error("Multiple project assignments match a Lead session");
      return assignments[0];
    };
    const initialAssignment = assignmentMatches(lead);
    if (
      activeRole() === "manager" &&
      (lead.relationship === "assigned") !== !!initialAssignment
    )
      throw new Error("Lead assignment changed before the message was queued");
    let retainedFiles: RequiredEvidence[] = [];
    let evidenceScope = hasManagerEvidenceSelectors(params.files ?? [])
      ? await host.managerEvidence?.(ctx, params.files ?? [])
      : undefined;
    if (params.retain === true) {
      if (activeRole() !== "manager" || !initialAssignment)
        throw new Error(
          "Required evidence can be retained only by a Manager forwarding to an assigned project Lead",
        );
      const supplied = resolveMessageFiles(
        ctx,
        params.files,
        `staff.${params.action}`,
        evidenceScope?.retained,
        evidenceScope?.roots,
      );
      await updateAssignmentEvidence(
        _id,
        {
          branch: initialAssignment.branch,
          add: params.files,
          resolvedAdd: supplied,
          evidenceScope,
          text: params.message,
          expectedAssignment: selectedAssignment,
        },
        undefined,
        undefined,
        ctx,
        (files) => {
          retainedFiles = files;
        },
      );
    }
    try {
      if (params.retain === true)
        evidenceScope = hasManagerEvidenceSelectors(params.files ?? [])
          ? await host.managerEvidence?.(ctx, params.files ?? [])
          : undefined;
      const prepared = await prepareCoordinationInput(
        ctx,
        params.message,
        params.retain === true
          ? retainedFiles.flatMap((file) =>
              "result" in file ? [file.result] : [file.path],
            )
          : resolveMessageFiles(
              ctx,
              params.files,
              `staff.${params.action}`,
              evidenceScope?.retained,
              evidenceScope?.roots,
            ),
        `staff.${params.action}`,
        "Message",
        (candidate, resultBindings) => ({
          version: 2,
          build: HERDSMAN_BUILD,
          id: recordId,
          leaseId: finalChief.leaseId,
          kind: activeRole() === "chief" ? "chief_message" : "manager_message",
          fromSessionId: finalChief.piSessionId,
          toSessionId: reportSession(lead),
          leadSessionId: reportSession(lead),
          ...(initialAssignment ? { branch: initialAssignment.branch } : {}),
          text: candidate,
          ...(resultBindings.length
            ? { resultBindings: [...resultBindings] }
            : {}),
          createdAt,
        }),
      );
      // Attachment preparation can reread Herdsman configuration and files. Recheck
      // every identity and authority field immediately before transport.
      const writeChief =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      const writeLead = await revalidateTarget();
      const finalAuthority =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      const writeAssignment = writeLead
        ? assignmentMatches(writeLead)
        : undefined;
      if (
        !writeChief ||
        writeChief.leaseId !== finalChief.leaseId ||
        !finalAuthority ||
        finalAuthority.leaseId !== finalChief.leaseId ||
        !writeLead ||
        !sameLeadTarget(writeLead, currentLead) ||
        writeLead.relationship !== lead.relationship ||
        !writeLead.availableActions.includes(params.action) ||
        !assignmentStillCurrent()
      )
        throw new Error("Lead or Chief changed before the message was queued");
      if (
        (writeLead.relationship === "assigned") !== !!writeAssignment ||
        writeAssignment?.branch !== initialAssignment?.branch ||
        writeAssignment?.id !== initialAssignment?.id
      )
        throw new Error(
          "Lead assignment changed before the message was queued",
        );
      const targetState = readLeadCoordinationState(
        supervisionRuntime(),
        reportSession(writeLead),
      );
      requireCompatibleBuild(
        HERDSMAN_BUILD,
        targetState?.build,
        "message_staff",
        `${targetState?.role ?? "Lead"} ${params.target ?? selectedAssignment?.branch ?? "target"}`,
      );
      const record: ChiefMessageRecord = {
        version: 2,
        build: HERDSMAN_BUILD,
        id: recordId,
        leaseId: finalChief.leaseId,
        kind: activeRole() === "chief" ? "chief_message" : "manager_message",
        fromSessionId: finalChief.piSessionId,
        toSessionId: reportSession(lead),
        leadSessionId: reportSession(lead),
        ...(initialAssignment ? { branch: initialAssignment.branch } : {}),
        text: prepared.text,
        ...(prepared.resultBindings.length
          ? { resultBindings: prepared.resultBindings }
          : {}),
        createdAt,
      };
      const runtime = supervisionRuntime();
      if (evidenceScope)
        await evidenceScope.revalidate(() =>
          withProjectAssignmentAuthority(() => {
            evidenceScope.verify();
            writeChiefMessage(record, runtime);
          }),
        );
      else writeChiefMessage(record, runtime);
      return result({
        ok: true,
        action: params.action,
        id: record.id,
        ...(params.target ? { target: params.target } : {}),
        ...(selectedAssignment ? { branch: selectedAssignment.branch } : {}),
        display_name: lead.displayName,
        next_action:
          "Report activity returns asynchronously; continue only independent work, otherwise end the turn. Do not poll.",
      });
    } catch (error) {
      if (params.retain === true)
        throw new Error(
          `Required evidence was retained, but the staff handoff failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    }
  };
  const updateAssignmentEvidence = async (
    _id: string,
    params: {
      branch: string;
      add?: string[];
      resolvedAdd?: MessageFileInput[];
      evidenceScope?: Awaited<ReturnType<ManagerEvidence>>;
      text?: string;
      remove?: string[];
      localOnly?: boolean;
      expectedAssignment?: ProjectAssignment;
    },
    _signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
    onPersisted?: (files: RequiredEvidence[]) => void,
  ) => {
    if (host.activeRole() !== "manager")
      throw new Error(
        "Only the Manager can update assignment required evidence",
      );
    if (!params.branch?.trim())
      throw new Error("Manager must provide the exact assigned project branch");
    const manager = await host.currentManager(ctx);
    const lease = host.managerLease();
    if (
      !manager ||
      !lease ||
      !host.sameManagerDescriptor(manager, lease.descriptor) ||
      host.leadRuntime.roleSuspended
    )
      throw new Error("Manager lease is no longer active");
    const managerAuthority = manager;
    const managerLeaseId = lease.descriptor.leaseId;
    const scope = await host.worktreeGroupScope(
      host.pi,
      ctx,
      manager.workspaceId,
      ctx.signal,
    );
    if (scope.repoKey !== manager.repoKey)
      throw new Error("Manager workspace authority could not be verified");
    const assignment = host.readProjectAssignment(
      host.supervisionRuntime(),
      manager.repoKey,
      params.branch,
    );
    if (!assignment)
      throw new Error(
        `No current project assignment exists on ${params.branch}`,
      );

    const operation = "required_evidence";
    const evidenceScope =
      params.evidenceScope ??
      (hasManagerEvidenceSelectors(params.add ?? [])
        ? await host.managerEvidence?.(ctx, params.add ?? [])
        : undefined);
    const resolved =
      params.resolvedAdd ??
      host.resolveMessageFiles(
        ctx,
        params.add,
        operation,
        evidenceScope?.retained,
        evidenceScope?.roots,
      );
    const additions = requiredFiles(
      assignment.id,
      resolved,
      evidenceScope?.retained ?? [],
      ctx.cwd,
      operation,
    );
    const suppliedAdditions = [...additions];
    if (params.text !== undefined) {
      if (!params.text.trim())
        throw new Error("Evidence text must not be empty");
      additions.push(
        persistRequiredEvidenceSnapshot(
          assignment.id,
          "assignment-note.md",
          params.text,
        ),
      );
    }

    const runtime = host.supervisionRuntime();
    const updated = await host.withProjectAssignmentLock(
      assignment.repoKey,
      assignment.branch,
      async () => {
        const currentManager = await host.currentManager(ctx);
        const currentLease = host.managerLease();
        if (
          host.activeRole() !== "manager" ||
          !currentManager ||
          !currentLease ||
          host.leadRuntime.roleSuspended ||
          !host.sameManagerDescriptor(currentManager, managerAuthority) ||
          currentManager.repoKey !== assignment.repoKey ||
          currentLease.descriptor.leaseId !== managerLeaseId
        )
          throw new Error(
            "Manager authority changed before required evidence was updated",
          );
        const currentScope = await host.worktreeGroupScope(
          host.pi,
          ctx,
          currentManager.workspaceId,
          ctx.signal,
        );
        if (currentScope.repoKey !== assignment.repoKey)
          throw new Error(
            "Manager workspace authority changed before required evidence was updated",
          );
        const current = host.readProjectAssignment(
          runtime,
          assignment.repoKey,
          assignment.branch,
        );
        if (!current || current.id !== assignment.id)
          throw new Error(
            "Project assignment changed before required evidence was updated",
          );
        if (
          params.expectedAssignment &&
          JSON.stringify(current) !== JSON.stringify(params.expectedAssignment)
        )
          throw new Error(
            "Project assignment changed after required evidence was selected",
          );
        const resultBindings = [...(current.resultBindings ?? [])];
        for (const evidence of additions)
          if ("result" in evidence) {
            const existing = resultBindings.find(
              (binding) => binding.ref === evidence.result.ref,
            );
            if (
              existing &&
              existing.canonicalRef !== evidence.result.canonicalRef
            )
              throw new Error(
                `Result ref ${evidence.result.ref} conflicts with the assignment's existing binding`,
              );
            if (!existing) resultBindings.push(evidence.result);
          }
        const evidence = [...(current.requiredEvidence ?? [])];
        const removals = new Set(params.remove ?? []);
        const unknown = [...removals].filter(
          (id) => !evidence.some((entry) => entry.id === id),
        );
        if (unknown.length)
          throw new Error(
            `Unknown required evidence ID: ${unknown.join(", ")}`,
          );
        if (
          params.localOnly &&
          evidence.some(
            (entry) =>
              removals.has(entry.id) &&
              "sourceAssignmentId" in entry &&
              entry.sourceAssignmentId !== current.id,
          )
        )
          throw new Error("Inherited required evidence cannot be removed");
        const next = evidence.filter((entry) => !removals.has(entry.id));
        for (const addition of additions) {
          const duplicate = next.some((entry) =>
            "result" in entry && "result" in addition
              ? entry.result.ref === addition.result.ref
              : "path" in entry && "path" in addition
                ? entry.sourceAssignmentId === addition.sourceAssignmentId &&
                  entry.name === addition.name &&
                  entry.sha256 === addition.sha256
                : false,
          );
          if (!duplicate) next.push(addition);
        }
        const selectedCurrent: string[] = [];
        if (params.text !== undefined) {
          const note = additions.at(-1)!;
          const accepted = next.find(
            (entry) =>
              "path" in entry &&
              "path" in note &&
              entry.name === note.name &&
              entry.sha256 === note.sha256 &&
              entry.sourceAssignmentId === note.sourceAssignmentId,
          );
          if (accepted) selectedCurrent.push(accepted.id);
        }
        for (const addition of suppliedAdditions) {
          const accepted = next.find((entry) =>
            "result" in entry && "result" in addition
              ? entry.result.ref === addition.result.ref
              : "path" in entry &&
                "path" in addition &&
                entry.name === addition.name &&
                entry.sha256 === addition.sha256 &&
                entry.sourceAssignmentId === addition.sourceAssignmentId,
          );
          if (accepted && !selectedCurrent.includes(accepted.id))
            selectedCurrent.push(accepted.id);
        }
        const currentEvidenceIds =
          params.text !== undefined || suppliedAdditions.length
            ? selectedCurrent
            : (current.currentEvidenceIds ?? []).filter((id) =>
                next.some((entry) => entry.id === id),
              );
        const written = {
          ...current,
          ...(next.length
            ? { requiredEvidence: next }
            : { requiredEvidence: undefined }),
          ...(resultBindings.length ? { resultBindings } : {}),
          ...(currentEvidenceIds.length
            ? { currentEvidenceIds }
            : { currentEvidenceIds: undefined }),
        };
        if (evidenceScope) await evidenceScope.revalidate(() => {});
        if (runtime?.assignments)
          await writeProjectAssignmentAfter(
            runtime,
            current,
            written,
            ctx.signal,
            () => {
              evidenceScope?.verify();
              evidenceScope?.verifyProvenance();
              const currentLease = host.managerLease();
              const liveManager = readManagerDescriptor(
                runtime,
                managerAuthority.workspaceId,
              );
              if (
                host.activeRole() !== "manager" ||
                host.leadRuntime.roleSuspended ||
                !currentLease ||
                !host.sameManagerDescriptor(
                  currentLease.descriptor,
                  managerAuthority,
                ) ||
                currentLease.descriptor.leaseId !== managerLeaseId ||
                !liveManager ||
                !host.sameManagerDescriptor(liveManager, managerAuthority) ||
                liveManager.repoKey !== assignment.repoKey ||
                liveManager.workspaceId !== managerAuthority.workspaceId
              )
                throw new Error(
                  "Manager authority changed before required evidence was updated",
                );
            },
            host.onProjectAssignmentAuthorityWaitOccupied,
          );
        else host.writeProjectAssignment(runtime, written);
        return written;
      },
      ctx.signal,
    );
    onPersisted?.(suppliedAdditions);
    return {
      content: [
        {
          type: "text" as const,
          text: `Retained evidence updated. Current assignment evidence:\n${(updated.requiredEvidence ?? []).map((entry) => `- ${entry.id}: ${entry.name}`).join("\n") || "- none"}`,
        },
      ],
      details: {
        ok: true,
        assignment: updated.id,
        branch: updated.branch,
        evidence: (updated.requiredEvidence ?? []).map(({ id, name }) => ({
          id,
          name,
        })),
      },
    };
  };
  const inspectRequiredEvidence = async (
    branch: string,
    ctx: ExtensionContext,
  ): Promise<ProjectAssignment> => {
    if (host.activeRole() !== "manager")
      throw new Error("Only the Manager can inspect assignment requirements");
    const manager = await host.currentManager(ctx);
    const lease = host.managerLease();
    if (
      !manager ||
      !lease ||
      host.leadRuntime.roleSuspended ||
      !host.sameManagerDescriptor(manager, lease.descriptor)
    )
      throw new Error("Manager lease is no longer active");
    const assignment = host.readProjectAssignment(
      host.supervisionRuntime(),
      manager.repoKey,
      branch,
    );
    if (!assignment) throw new Error("Project assignment is no longer current");
    return assignment;
  };
  const removeRequiredEvidence = async (
    branch: string,
    id: string,
    expectedAssignment: ProjectAssignment,
    ctx: ExtensionContext,
  ) => {
    if (host.activeRole() !== "manager")
      throw new Error("Only the Manager can remove assignment requirements");
    await updateAssignmentEvidence(
      "manager-required-evidence",
      {
        branch,
        remove: [id],
        localOnly: true,
        expectedAssignment,
      },
      ctx.signal,
      undefined,
      ctx,
    );
  };
  const invalidatePendingRemovals = (ctx: ExtensionContext) => {
    for (const request of pendingRemovals(ctx).values())
      resolvePendingRemoval(request, ctx);
  };
  return {
    stopExecution,
    persistStopClosures: async (
      ctx: ExtensionContext,
      closures: NonNullable<
        import("../agent-controller.ts").StopOwnedAgentsResult["closures"]
      >,
    ) => {
      return (
        (await persistActiveStopClosures(ctx, closures)) +
        (await persistNestedStopClosures(ctx, closures))
      );
    },
    persistNestedStopClosures,
    stop,
    activateProjectLead,
    removeWorktree,
    listPendingRemovals,
    updateRemovalStatus,
    invalidatePendingRemovals,
    approvePendingRemoval,
    cancelPendingRemoval,
    setRemovalPreauthorization,
    getRemovalPreauthorization,
    forgetLegacyProjectAssignment,
    executeStaff,
    updateAssignmentEvidence,
    inspectRequiredEvidence,
    removeRequiredEvidence,
  };
}

export function gitPathStatus(path: string): "present" | "absent" | "unknown" {
  try {
    return statSync(path).isDirectory() ? "present" : "unknown";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

export function parseGitWorktreeInventory(output: string):
  | {
      path: string;
      branch?: string;
      detached?: boolean;
      locked?: boolean;
      prunable?: boolean;
    }[]
  | undefined {
  if (!output.endsWith("\0\0")) return undefined;
  const fields = output.split("\0");
  if (fields.pop() !== "") return undefined;
  const records: string[][] = [];
  let record: string[] = [];
  for (const field of fields) {
    if (field) record.push(field);
    else if (record.length) {
      records.push(record);
      record = [];
    }
  }
  if (record.length) records.push(record);
  if (!records.length) return undefined;
  const worktrees: {
    path: string;
    branch?: string;
    detached?: boolean;
    locked?: boolean;
    prunable?: boolean;
  }[] = [];
  for (const values of records) {
    if (!values[0]?.startsWith("worktree ")) return undefined;
    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let bare = false;
    let detached = false;
    let locked = false;
    let prunable = false;
    const seen = new Set<string>();
    for (const value of values) {
      const key = value.startsWith("worktree ")
        ? "worktree"
        : value.startsWith("HEAD ")
          ? "HEAD"
          : value.startsWith("branch refs/heads/")
            ? "branch"
            : value === "detached" || value === "bare"
              ? value
              : /^locked(?: |$)/.test(value)
                ? "locked"
                : /^prunable(?: |$)/.test(value)
                  ? "prunable"
                  : undefined;
      if (key && seen.has(key)) return undefined;
      if (key) seen.add(key);
      if (value.startsWith("worktree ") && !path) path = value.slice(9);
      else if (value.startsWith("HEAD ") && !head) head = value.slice(5);
      else if (value.startsWith("branch refs/heads/") && !branch)
        branch = value.slice("branch refs/heads/".length);
      else if (value === "detached" || value === "bare") {
        if (value === "bare") bare = true;
        else detached = true;
      } else if (/^locked(?: .*)?$/.test(value)) locked = true;
      else if (/^prunable(?: .*)?$/.test(value)) prunable = true;
      else if (!/^[^\s]+(?: .*)?$/.test(value)) return undefined;
    }
    if (
      !path ||
      !isAbsolute(path) ||
      (bare
        ? !!branch || detached
        : !head ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ||
          (!branch && !detached)) ||
      (branch !== undefined && !branch)
    )
      return undefined;
    worktrees.push({
      path,
      ...(branch ? { branch } : {}),
      ...(detached ? { detached: true } : {}),
      ...(locked ? { locked: true } : {}),
      ...(prunable ? { prunable: true } : {}),
    });
  }
  if (
    new Set(worktrees.map((worktree) => worktree.path)).size !==
    worktrees.length
  )
    return undefined;
  return worktrees;
}
