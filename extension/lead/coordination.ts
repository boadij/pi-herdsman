import { readSessionKind } from "../supervision.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  ManagerDescriptor,
  ProjectAssignment,
  ProjectMessage,
  ProjectMessageHeader,
  ProjectMessageHeaderIssue,
  ChiefMessageRecord,
  ChiefMessageKind,
  PeerLeadRecord,
  WorkspaceProvenance,
  SessionRole,
  PeerRuntime,
} from "../supervision.ts";
import {
  projectMessageEnvelope,
  leadSupervisorState as resolveLeadSupervisorState,
  COORDINATOR_MESSAGE_PROTOCOL,
  COORDINATION_INBOX_SCAN_LIMIT,
  listPendingRetirements,
  removePendingRetirement,
  removeProjectMessagesForAssignment,
  mightHaveProjectMessages,
  listProjectAssignments,
  removeChiefMessage,
  readProjectAssignment,
  listProjectMessageHeaders,
  readProjectMessage,
  supervisionRuntime,
  globalProjectAssignmentSnapshot,
  findProjectAssignmentBySession,
  readLeadCoordinationStateForObservation,
  withProjectAssignmentAuthority,
  readPeerLeadRecord,
  samePeerLeadGeneration,
  samePeerLeadAuthority,
  canMessagePeer,
  isRemoteOrdinaryLead,
  supportsCoordinatorMessaging,
  reportProtocolDiagnostic,
  takeProtocolDiagnostics,
  supervisorStateMessage,
} from "../supervision.ts";

import { OperationError } from "../errors.ts";

import { contentText } from "@earendil-works/pi-ai";
import { prepareMessageInput } from "../core.ts";
import {
  persistPeerAttachment,
  persistPeerResultArtifact,
  isResultBinding,
} from "../storage.ts";
import { canonicalRefsForSemanticResult } from "../agent-controller.ts";
import {
  sameDirectory,
  type HerdrRecord,
  type HerdrSessionSnapshot,
} from "../herdr.ts";
import {
  isRuntimeBuild,
  sameRuntimeBuild,
  type RuntimeBuild,
} from "../compatibility.ts";
import type { PeerCorrespondence } from "../peer-correspondence.ts";
import {
  rememberCoordinatorTarget,
  resolveCoordinatorTarget,
} from "../coordinator-target.ts";

import type { MessageFileInput } from "../core.ts";
import type { ResultBinding } from "../mailbox.ts";

import { createHash, randomUUID } from "node:crypto";

import { join, resolve } from "node:path";

import {
  listSavedPeerMachines,
  peerRecoveryRequest,
  listRemotePeerOutbounds,
  readRemotePeerOutbound,
  persistRemotePeerOutbound,
  probePeerEndpoint,
  removeRemotePeerOutbound,
  retargetRemotePeerOutbound,
  resolveRemotePeerOutboundRetry,
  tryClaimRemotePeerOutbound,
  runPeerEndpoint,
  tryPollPeerReplies,
  type SavedPeerMachine,
} from "../peer-transport.ts";
import {
  createPeerCorrespondence,
  assertPeerDataRoot,
  listPeerCorrespondences,
  readPeerCorrespondence,
  queuePeerReply,
  storePeerCorrespondence,
  peerPayloadDigest,
  resolvePeerResultBindings as splitPeerResultBindings,
  updatePeerOriginGeneration,
  updatePeerRecipientGeneration,
  validPeerDisplayText,
} from "../peer-correspondence.ts";

import type {
  LeadRuntimeState,
  createLeadRoleTransitions,
} from "../lead-runtime.ts";

type LeadRoleTransitionRuntime = ReturnType<typeof createLeadRoleTransitions>;

export type LeadCoordinationBaseHost = {
  supervisionRuntime: typeof import("../supervision.ts").supervisionRuntime;
  writeLeadCoordinationState: typeof import("../supervision.ts").writeLeadCoordinationState;
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
  peerRuntime: PeerRuntime;
  listPeerLeadRecordsForDiscovery: typeof import("../supervision.ts").listPeerLeadRecordsForDiscovery;
  removePeerLeadRecord: typeof import("../supervision.ts").removePeerLeadRecord;
  acquireProcessLock: typeof import("../lock.ts").acquireProcessLock;
  peerLeadLockPath: typeof import("../supervision.ts").peerLeadLockPath;
  workspacePresentationProvenance(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workspaceIds: readonly string[],
    workspaceCwds: ReadonlyMap<string, string>,
    signal?: AbortSignal,
    workspaces?: readonly HerdrRecord[],
  ): Promise<ReadonlyMap<string, WorkspaceProvenance>>;
  liveAgent(
    ctx: ExtensionContext,
    sessionId: string,
    sessionPath?: string,
  ): Promise<HerdrRecord[]>;
  liveAgent(
    ctx: ExtensionContext,
    sessionId: string,
    sessionPath?: string,
  ): Promise<HerdrRecord[]>;
  basename: typeof import("node:path").basename;
  readPeerLeadRecord: typeof import("../supervision.ts").readPeerLeadRecord;
  samePeerLeadRecord: typeof import("../supervision.ts").samePeerLeadRecord;
  writePeerLeadRecord: typeof import("../supervision.ts").writePeerLeadRecord;
  invalidateLeadCoordinationState: typeof import("../supervision.ts").invalidateLeadCoordinationState;
  runHerdr: typeof import("../herdr.ts").runHerdr;
  resolveMessageFiles: typeof import("../agent-controller.ts").resolveMessageFiles;
  messageLimits(
    ctx: ExtensionContext,
  ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
  chiefMessageBytes: typeof import("../supervision.ts").chiefMessageBytes;
  coordinationMessageMaxBytes: number;
  buildSessionProjection: typeof import("@earendil-works/pi-coding-agent").buildSessionProjection;
  contentText: typeof import("@earendil-works/pi-ai").contentText;
  supervisorStateType: string;
  sameManagerDescriptor: typeof import("../supervision.ts").sameManagerDescriptor;
  sameRuntimeBuild: typeof import("../compatibility.ts").sameRuntimeBuild;
  samePeerLeadGeneration: typeof import("../supervision.ts").samePeerLeadGeneration;
  writeCoordinationMessage: typeof import("../supervision.ts").writeCoordinationMessage;
  writeChiefMessage: typeof import("../supervision.ts").writeChiefMessage;
  removeChiefMessage: typeof import("../supervision.ts").removeChiefMessage;
  quarantineChiefMessage: typeof import("../supervision.ts").quarantineChiefMessage;
  readLeadCoordinationState: typeof import("../supervision.ts").readLeadCoordinationState;
  matchesExpectedSession: typeof import("../herdr.ts").matchesExpectedSession;
  isPiAgent(agent: HerdrRecord): boolean;
  listProjectAssignments: typeof import("../supervision.ts").listProjectAssignments;
  listProjectMessageHeaders: typeof import("../supervision.ts").listProjectMessageHeaders;
  readProjectMessage: typeof import("../supervision.ts").readProjectMessage;
  removeProjectMessage: typeof import("../supervision.ts").removeProjectMessage;
  readProjectAssignment: typeof import("../supervision.ts").readProjectAssignment;
  importResultBindings: typeof import("../agent-controller.ts").importResultBindings;
  worktreeGroupScope: typeof import("../herdr.ts").worktreeGroupScope;
};

type LeadCoordinationHost = LeadCoordinationBaseHost & {
  withProjectAssignmentLock: LeadRoleTransitionRuntime["withProjectAssignmentLock"];
  pi: ExtensionAPI;
  leadRuntime: LeadRuntimeState;
  processRole: "lead";
  controllerScope: { kind: "root" };
  activeRole(): SessionRole;
  HERDSMAN_BUILD: RuntimeBuild;
  leadInstanceId(): string;
  workspaceId(): string | undefined;
  currentManager: LeadRoleTransitionRuntime["currentManager"];
  currentProjectAssignment: LeadRoleTransitionRuntime["currentProjectAssignment"];
  currentWorktreeScope: LeadRoleTransitionRuntime["currentWorktreeScope"];
  projectAssignmentForScope: LeadRoleTransitionRuntime["projectAssignmentForScope"];
  resolveEffectiveSupervisor: LeadRoleTransitionRuntime["resolveEffectiveSupervisor"];
  publishProjectMessage: LeadRoleTransitionRuntime["publishProjectMessage"];
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
  currentSupervisor: LeadRoleTransitionRuntime["currentSupervisor"];
};

export function readLeadSessionIds(
  inventory: HerdrSessionSnapshot,
  mailboxes: ReturnType<typeof import("../mailbox.ts").listAgentStates>,
  workspaceId: string,
  dependencies: {
    matchesExpectedSession: (
      session: unknown,
      expected: { id: string },
    ) => boolean;
    isPiAgent: (agent: HerdrRecord) => boolean;
    supervisionRuntime: () => unknown;
    readLeadCoordinationState: typeof import("../supervision.ts").readLeadCoordinationState;
  },
): string[] {
  const panes = inventory.panes;
  if (!Array.isArray(panes)) return [];
  const leadSessionIds: string[] = [];
  const ownerSessionIds = new Set(
    mailboxes.map(({ state }) => state.ownerSessionId),
  );
  for (const ownerSessionId of ownerSessionIds) {
    const ownerAgents = inventory.agents.filter((agent: HerdrRecord) => {
      try {
        return dependencies.matchesExpectedSession(agent?.agent_session, {
          id: ownerSessionId,
        });
      } catch {
        return false;
      }
    });
    if (ownerAgents.length !== 1) continue;
    const ownerAgent = ownerAgents[0];
    if (typeof ownerAgent.pane_id !== "string" || !ownerAgent.pane_id.trim())
      continue;
    const ownerPanes = panes.filter(
      (pane: HerdrRecord) =>
        pane?.workspace_id === workspaceId &&
        pane?.pane_id === ownerAgent.pane_id,
    );
    if (
      ownerPanes.length !== 1 ||
      !dependencies.isPiAgent(ownerAgent) ||
      ownerPanes[0]?.agent !== "pi"
    )
      continue;
    try {
      const state = dependencies.readLeadCoordinationState(
        dependencies.supervisionRuntime(),
        ownerSessionId,
      );
      if (state && (state.role ?? "lead") === "lead")
        leadSessionIds.push(ownerSessionId);
    } catch {
      // Missing or invalid Lead authority stays unknown.
    }
  }
  return leadSessionIds;
}

export function createLeadCoordinationRuntime(host: LeadCoordinationHost) {
  let leadCoordinationHealthy = true;
  let peerPresenceLease: ReturnType<typeof host.acquireProcessLock> | undefined;
  let peerPresenceRecord: PeerLeadRecord | undefined;
  let peerPresenceGeneration = 0;
  let peerPresencePublication = Promise.resolve();
  let coordinationPublication = Promise.resolve();
  const {
    pi,
    leadRuntime,
    processRole,
    controllerScope,
    activeRole,
    HERDSMAN_BUILD,
    supervisionRuntime,
    writeLeadCoordinationState,
    appendDurableError,
    peerRuntime,
    removePeerLeadRecord,
    acquireProcessLock,
    peerLeadLockPath,
    listPeerLeadRecordsForDiscovery,
    publishProjectMessage,
    resolveMessageFiles,
    buildSessionProjection,
    contentText,
    supervisorStateType,
    workspacePresentationProvenance,
    basename,
    readPeerLeadRecord,
    samePeerLeadRecord,
    writePeerLeadRecord,
    invalidateLeadCoordinationState,
    runHerdr,
    leadInstanceId,
    currentManager,
    currentProjectAssignment,
    workspaceId,
    currentWorktreeScope,
    projectAssignmentForScope,
    resolveEffectiveSupervisor,
    currentChiefAuthority,
    currentSupervisor,
    sameManagerDescriptor,
    sameRuntimeBuild,
    samePeerLeadGeneration,
    writeCoordinationMessage,
    writeChiefMessage,
    readLeadCoordinationState,
    removeChiefMessage,
    quarantineChiefMessage,
    listProjectAssignments,
    listProjectMessageHeaders,
    readProjectMessage,
    removeProjectMessage,
    readProjectAssignment,
    importResultBindings,
  } = host;
  const reportedProjectMessageCleanupErrors = new Set<string>();
  const reportedProjectMessageReadErrors = new Set<string>();
  const reportedProjectMessageHeaderErrors = new Set<string>();
  const reportedRetirementErrors = new Set<string>();
  const retirementCursors = new Map<string, string>();
  const readLeadSessionIdsFromHost = (
    inventory: HerdrSessionSnapshot,
    mailboxes: ReturnType<typeof import("../mailbox.ts").listAgentStates>,
    workspaceId: string,
  ): string[] => readLeadSessionIds(inventory, mailboxes, workspaceId, host);
  const prepareCoordinationInput = async (
    ctx: ExtensionContext,
    text: string,
    files: readonly MessageFileInput[],
    operation: string,
    heading: "Message" | "Reply" | "Question",
    recordForInput: (
      text: string,
      resultBindings: readonly ResultBinding[],
    ) =>
      | number
      | import("../supervision.ts").ChiefMessageRecord
      | import("../supervision.ts").ProjectMessage,
  ) => {
    const limits = await host.messageLimits(ctx);
    return prepareMessageInput(text, files, ctx.cwd, operation, heading, {
      inlineLimitBytes: limits.inline.bytes,
      mailboxLimitBytes: limits.mailbox.bytes,
      requireInline: true,
      serializedBytes: (
        candidate: string,
        resultBindings: readonly ResultBinding[],
      ) => {
        const record = recordForInput(candidate, resultBindings);
        return typeof record === "number"
          ? record
          : host.chiefMessageBytes(record);
      },
    });
  };
  const persistCoordinatorState = (): boolean => {
    try {
      pi.appendEntry("pi-herdsman-lead-state", {
        instanceId: host.leadInstanceId(),
      });
      return persistLeadCoordination();
    } catch (error) {
      markLeadCoordinationUnhealthy();
      if (leadRuntime.leadContext)
        appendDurableError(
          pi,
          leadRuntime.leadContext,
          "pi_herdsman_state_error",
          error,
        );
      return false;
    }
  };
  const persistLeadCoordination = (): boolean => {
    if (
      controllerScope?.kind !== "root" ||
      leadRuntime.chiefMode !== "inactive" ||
      leadRuntime.roleSuspended
    )
      return true;
    const wasHealthy = leadCoordinationHealthy;
    try {
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        build: HERDSMAN_BUILD,
        messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
        role: activeRole() === "manager" ? "manager" : "lead",
        instanceId: host.leadInstanceId(),
        piSessionId:
          leadRuntime.leadContext?.sessionManager.getSessionId() ?? "",
        updatedAt: Date.now(),
      });
      leadCoordinationHealthy = true;
      if (!wasHealthy && leadRuntime.leadContext)
        void schedulePeerPresence(leadRuntime.leadContext);
      return true;
    } catch (error) {
      markLeadCoordinationUnhealthy();
      if (leadRuntime.leadContext)
        appendDurableError(
          pi,
          leadRuntime.leadContext,
          "pi_herdsman_state_error",
          error,
        );
      return false;
    }
  };
  const removePeerPresence = (): void => {
    const record = peerPresenceRecord;
    peerPresenceRecord = undefined;
    if (!record) {
      peerPresenceLease?.release();
      peerPresenceLease = undefined;
      return;
    }
    try {
      removePeerLeadRecord(peerRuntime(), record.piSessionId, record);
    } catch (error) {
      if (leadRuntime.leadContext)
        appendDurableError(
          pi,
          leadRuntime.leadContext,
          "pi_herdsman_state_error",
          error,
        );
    }
    try {
      peerPresenceLease?.release();
    } catch (error) {
      if (leadRuntime.leadContext)
        appendDurableError(
          pi,
          leadRuntime.leadContext,
          "pi_herdsman_state_error",
          error,
        );
    }
    peerPresenceLease = undefined;
  };
  const markLeadCoordinationUnhealthy = (
    ctx: ExtensionContext | undefined = leadRuntime.leadContext,
  ): void => {
    leadCoordinationHealthy = false;

    // Invalidate queued publication/enrichment before health can recover.
    ++peerPresenceGeneration;
    removePeerPresence();

    const sessionId = ctx?.sessionManager.getSessionId();
    if (!sessionId) return;

    try {
      invalidateLeadCoordinationState(
        supervisionRuntime(),
        sessionId,
        host.leadInstanceId(),
      );
    } catch (error) {
      appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
    }
  };
  const publishPeerPresence = async (
    ctx: ExtensionContext,
    expectedGeneration: number,
  ): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const kind = readSessionKind(
      ctx.sessionManager.getEntries(),
      sessionId,
    )?.kind;
    if (!kind) return;
    const isCurrent = (): boolean =>
      expectedGeneration === peerPresenceGeneration &&
      !ctx.signal?.aborted &&
      processRole === "lead" &&
      leadRuntime.chiefMode === "inactive" &&
      !leadRuntime.roleSuspended &&
      leadCoordinationHealthy &&
      ctx.sessionManager.getSessionId() === sessionId;
    if (!isCurrent()) return;
    const paneId = process.env.HERDR_PANE_ID;
    const tabId = process.env.HERDR_TAB_ID;
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!paneId || !tabId || !workspaceId) return;
    removePeerPresence();
    const name =
      pi.getSessionName()?.trim() ||
      ctx.sessionManager.getSessionName()?.trim();
    let lease: ReturnType<typeof acquireProcessLock> | undefined;
    try {
      const runtime = peerRuntime();
      if (!isCurrent()) return;
      lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
        name: "Lead peer presence",
      });
      if (!isCurrent()) {
        lease.release();
        return;
      }
      const record: PeerLeadRecord = {
        version: 2,
        build: HERDSMAN_BUILD,
        messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
        role: activeRole() === "manager" ? "manager" : "lead",
        sessionKind: kind,
        piSessionId: sessionId,
        paneId,
        tabId,
        workspaceId,
        socket: process.env.HERDR_SOCKET_PATH ?? "unknown-socket",
        ...(name ? { name } : {}),
        cwd: ctx.cwd,
        claim: lease.claim,
        updatedAt: Date.now(),
      };
      if (!isCurrent()) {
        lease.release();
        return;
      }
      writePeerLeadRecord(runtime, record);
      peerPresenceLease = lease;
      peerPresenceRecord = record;
      void (async () => {
        let group: PeerLeadRecord["group"];
        try {
          const scope = await currentWorktreeScope(ctx);
          if (!isCurrent() || peerPresenceRecord !== record) return;
          if (scope) {
            const assignments = findProjectAssignmentBySession(
              supervisionRuntime(record.socket),
              scope.repoKey,
              sessionId,
            );
            if (assignments.length > 1) return;
            group = {
              repoKey: scope.repoKey,
              primaryWorkspaceId: scope.primaryWorkspaceId,
            };
          } else {
            group = null;
          }
        } catch {
          group = undefined;
        }
        if (!isCurrent() || peerPresenceRecord !== record) return;
        const verified: PeerLeadRecord =
          group === undefined ? record : { ...record, group };
        if (group !== undefined) {
          try {
            const current = readPeerLeadRecord(peerRuntime(), sessionId);
            if (!current || !samePeerLeadGeneration(current, record)) return;
            writePeerLeadRecord(peerRuntime(), verified);
            peerPresenceRecord = verified;
          } catch {
            return;
          }
        }
        let provenance: WorkspaceProvenance;
        try {
          provenance =
            (
              await workspacePresentationProvenance(
                pi,
                ctx,
                [workspaceId],
                new Map([[workspaceId, ctx.cwd]]),
                ctx.signal,
              )
            ).get(workspaceId) ?? {};
        } catch {
          return;
        }
        if (!isCurrent() || peerPresenceRecord !== verified) return;
        const workspaceLabel =
          provenance.repoName && provenance.branch
            ? `${provenance.repoName}/${provenance.branch}`
            : (provenance.workspaceLabel ??
              (provenance.workspaceCwd
                ? basename(provenance.workspaceCwd)
                : workspaceId));
        const enriched: PeerLeadRecord = {
          ...verified,
          ...(provenance.repoName ? { repo: provenance.repoName } : {}),
          ...(provenance.branch ? { branch: provenance.branch } : {}),
          workspaceLabel,
          updatedAt: Date.now(),
        };
        if (!isCurrent() || peerPresenceRecord !== verified) return;
        try {
          const current = readPeerLeadRecord(peerRuntime(), sessionId);
          if (!current || !samePeerLeadRecord(current, verified)) return;
          if (!isCurrent() || peerPresenceRecord !== verified) return;
          writePeerLeadRecord(peerRuntime(), enriched);
          peerPresenceRecord = enriched;
        } catch (error) {
          if (isCurrent() && peerPresenceRecord === verified)
            appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
        }
      })();
    } catch (error) {
      try {
        lease?.release();
      } catch {}
      peerPresenceLease = undefined;
      appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
    }
  };
  const schedulePeerPresence = (ctx: ExtensionContext): Promise<void> => {
    const expectedGeneration = peerPresenceGeneration;
    peerPresencePublication = peerPresencePublication
      .catch(() => {})
      .then(() => publishPeerPresence(ctx, expectedGeneration));
    return peerPresencePublication;
  };

  const assertCurrentLeadCoordination = (ctx: ExtensionContext) => {
    if (!leadCoordinationHealthy) {
      throw new Error("Lead coordination state is unavailable");
    }
    const state = readLeadCoordinationState(
      supervisionRuntime(),
      ctx.sessionManager.getSessionId(),
    );
    if (
      !state ||
      state.instanceId !== host.leadInstanceId() ||
      state.piSessionId !== ctx.sessionManager.getSessionId() ||
      !state.build ||
      !sameRuntimeBuild(state.build, HERDSMAN_BUILD) ||
      (state.role ?? "lead") !==
        (activeRole() === "manager" ? "manager" : "lead")
    )
      throw new Error("Lead coordination state changed; retry the action");
    return state;
  };
  const assertCurrentPeerCoordination = (
    ctx: ExtensionContext,
    sender: PeerLeadRecord,
  ): void => {
    if (!sender.build || !sameRuntimeBuild(sender.build, HERDSMAN_BUILD))
      throw new Error("Local peer build identity changed; retry the action");
    const state = assertCurrentLeadCoordination(ctx);
    if (
      state.messageProtocol !== sender.messageProtocol ||
      !supportsCoordinatorMessaging(state.messageProtocol) ||
      !supportsCoordinatorMessaging(sender.messageProtocol)
    )
      throw new Error(
        "Local peer messaging protocol changed; retry the action",
      );
  };

  const leadSupervisorState = (ctx: ExtensionContext): Promise<string> =>
    resolveLeadSupervisorState(ctx, {
      workspaceId,
      resolveEffectiveSupervisor,
      currentManager,
    });

  const livePeerLead = async (
    _ctx: ExtensionContext,
    sessionId: string,
  ): Promise<PeerLeadRecord | undefined> => {
    try {
      return readPeerLeadRecord(peerRuntime(), sessionId);
    } catch {
      return undefined;
    }
  };
  const currentPeerPresenceValid = (ctx: ExtensionContext): boolean => {
    if (
      leadRuntime.chiefMode !== "inactive" ||
      (leadRuntime.roleSuspended && activeRole() !== "manager") ||
      !leadCoordinationHealthy ||
      !peerPresenceLease ||
      !peerPresenceRecord ||
      peerPresenceRecord.piSessionId !== ctx.sessionManager.getSessionId()
    )
      return false;
    try {
      const current = readPeerLeadRecord(
        peerRuntime(),
        peerPresenceRecord.piSessionId,
      );
      return !!current && samePeerLeadRecord(current, peerPresenceRecord);
    } catch {
      return false;
    }
  };
  const peerContext = async (
    record: PeerLeadRecord,
    ctx: ExtensionContext,
    assignmentSnapshot?: Map<
      string,
      import("../supervision.ts").GlobalProjectAssignment[]
    >,
    requireFreshGroup = false,
  ): Promise<import("../supervision.ts").PeerContext | undefined> => {
    const role = record.role ?? "lead";
    if (record.sessionKind !== "ordinary" && record.sessionKind !== "managed")
      return undefined;
    const socket = record.socket;
    const assignments =
      (assignmentSnapshot ?? globalProjectAssignmentSnapshot()).get(
        record.piSessionId,
      ) ?? [];
    if (assignments.length > 1) return undefined;
    if (role === "manager")
      return record.sessionKind === "ordinary" && assignments.length === 0
        ? { role: "manager" }
        : undefined;
    if (record.sessionKind === "managed" && assignments.length !== 1)
      return undefined;
    if (record.sessionKind === "ordinary" && assignments.length !== 0)
      return undefined;
    if (assignments.length === 0 && !requireFreshGroup) {
      return {
        role: "lead",
        socket,
        group: record.group ?? null,
        managed: false,
      };
    }
    const localSession =
      record.piSessionId === ctx.sessionManager.getSessionId();
    const localSocket =
      socket === (process.env.HERDR_SOCKET_PATH ?? "unknown-socket");
    const scope = localSession
      ? await currentWorktreeScope(ctx)
      : localSocket && (record.group || requireFreshGroup)
        ? await host.worktreeGroupScope(pi, ctx, record.workspaceId, ctx.signal)
        : undefined;
    // Same-socket peers are checked against live Herdr topology. For another
    // socket, only its generation-bound published group and socket-scoped
    // assignment store are available; Pi has no socket override primitive.
    const group = scope
      ? {
          repoKey: scope.repoKey,
          primaryWorkspaceId: scope.primaryWorkspaceId,
        }
      : !localSession && !localSocket && !requireFreshGroup
        ? record.group
        : undefined;
    if (group === undefined) return undefined;
    if (scope && !scope.workspaceIds.includes(record.workspaceId))
      return undefined;
    if (
      record.group &&
      (!group ||
        group.repoKey !== record.group.repoKey ||
        group.primaryWorkspaceId !== record.group.primaryWorkspaceId)
    )
      return undefined;
    const assignment = assignments[0];
    if (
      assignment &&
      (!group ||
        assignment.assignment.repoKey !== group.repoKey ||
        assignment.socketHash !==
          createHash("sha256").update(socket).digest("hex"))
    )
      return undefined;
    return {
      role: "lead",
      socket,
      group,
      managed: !!assignment,
    };
  };
  const authorizePeerRecord = async (
    record: ChiefMessageRecord,
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    if (
      leadRuntime.chiefMode !== "inactive" ||
      record.kind !== "peer_message" ||
      record.toSessionId !== ctx.sessionManager.getSessionId() ||
      record.fromSessionId === record.toSessionId ||
      record.leadSessionId !== record.fromSessionId
    )
      return false;
    if (
      leadRuntime.controllerRole === "manager" &&
      (!leadRuntime.managerLease ||
        (await currentManager(ctx))?.leaseId !==
          leadRuntime.managerLease.descriptor.leaseId)
    )
      return false;
    const target = await livePeerLead(ctx, record.toSessionId);
    if (
      !target ||
      (target.role ?? "lead") !== activeRole() ||
      !supportsCoordinatorMessaging(target.messageProtocol) ||
      target.piSessionId !== record.toSessionId
    )
      return false;
    const source = record.peerSource;
    if (
      source?.role === "lead" &&
      "remoteOrdinary" in source &&
      source.remoteOrdinary === true
    ) {
      if (activeRole() !== "lead") return false;
      const assignments = globalProjectAssignmentSnapshot();
      return (
        isRemoteOrdinaryLead(target, assignments) &&
        target.piSessionId === ctx.sessionManager.getSessionId()
      );
    }
    const assignmentSnapshot =
      source?.role === "lead" ? globalProjectAssignmentSnapshot() : undefined;
    const sourceAssignments =
      assignmentSnapshot?.get(record.fromSessionId) ?? [];
    if (
      source?.role === "lead" &&
      (source.managed
        ? sourceAssignments.length !== 1 ||
          sourceAssignments[0].assignment.repoKey !== source.group?.repoKey ||
          sourceAssignments[0].socketHash !==
            createHash("sha256").update(source.socket).digest("hex")
        : sourceAssignments.length !== 0)
    )
      return false;
    const targetAssignments = assignmentSnapshot?.get(target.piSessionId) ?? [];
    const recipientContext = await peerContext(
      target,
      ctx,
      assignmentSnapshot,
      source?.role === "lead" &&
        (source.managed || targetAssignments.length > 0),
    );
    if (!recipientContext || !source) return false;
    return canMessagePeer(source, recipientContext);
  };
  const queuePeerRecord = async (
    text: string,
    targetSessionId: string,
    ctx: ExtensionContext,
    expectedSender: PeerLeadRecord,
    expectedTarget: PeerLeadRecord,
    recordId = randomUUID(),
    createdAt = Date.now(),
    resultBindings: readonly ResultBinding[] = [],
  ): Promise<ChiefMessageRecord> => {
    if (
      controllerScope?.kind !== "root" ||
      leadRuntime.chiefMode !== "inactive" ||
      leadRuntime.roleSuspended
    )
      throw new Error("Peer is unavailable in this role");
    assertCurrentPeerCoordination(ctx, expectedSender);
    if (
      leadRuntime.controllerRole === "manager" &&
      (!leadRuntime.managerLease ||
        (await currentManager(ctx))?.leaseId !==
          leadRuntime.managerLease.descriptor.leaseId)
    )
      throw new Error("Manager lease is no longer active");
    if (
      expectedSender.piSessionId !== ctx.sessionManager.getSessionId() ||
      expectedTarget.piSessionId !== targetSessionId ||
      expectedSender.piSessionId === expectedTarget.piSessionId
    )
      throw new Error("Peer sender or target is invalid");
    let sender: PeerLeadRecord | undefined;
    let target: PeerLeadRecord | undefined;
    try {
      sender = readPeerLeadRecord(peerRuntime(), expectedSender.piSessionId);
      target = readPeerLeadRecord(peerRuntime(), expectedTarget.piSessionId);
    } catch {
      throw new Error(
        "Peer target was not found or is no longer a live same-role peer",
      );
    }
    if (
      !sender ||
      !target ||
      !samePeerLeadGeneration(sender, expectedSender) ||
      !samePeerLeadGeneration(target, expectedTarget) ||
      (sender.role ?? "lead") !== activeRole() ||
      (target.role ?? "lead") !== activeRole()
    )
      throw new Error(
        "Peer sender or target changed before the message was queued",
      );
    if (
      !supportsCoordinatorMessaging(sender.messageProtocol) ||
      !supportsCoordinatorMessaging(target.messageProtocol)
    )
      throw new Error(
        "Peer messaging protocol 1 is required for both participants",
      );
    const contextSnapshot =
      (sender.role ?? "lead") === "manager" &&
      (target.role ?? "lead") === "manager"
        ? undefined
        : globalProjectAssignmentSnapshot();
    const senderAssignments = contextSnapshot?.get(sender.piSessionId) ?? [];
    const targetAssignments = contextSnapshot?.get(target.piSessionId) ?? [];
    const requireFreshGroup =
      senderAssignments.length > 0 || targetAssignments.length > 0;
    let senderContext = await peerContext(
      sender,
      ctx,
      contextSnapshot,
      requireFreshGroup,
    );
    let targetContext = await peerContext(
      target,
      ctx,
      contextSnapshot,
      requireFreshGroup,
    );
    if (
      !senderContext ||
      !targetContext ||
      !canMessagePeer(senderContext, targetContext)
    )
      throw new Error(
        "Peer is unavailable or outside the permitted project scope. Run `list_peers` again.",
      );
    const record: ChiefMessageRecord = {
      version: 2,
      build: HERDSMAN_BUILD,
      messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
      id: recordId,
      leaseId: sender.claim.id,
      kind: "peer_message",
      fromSessionId: sender.piSessionId,
      toSessionId: target.piSessionId,
      leadSessionId: sender.piSessionId,
      peerSource: senderContext,
      text,
      ...(resultBindings.length ? { resultBindings: [...resultBindings] } : {}),
      createdAt,
    };
    const publish = (
      snapshot?: Map<
        string,
        import("../supervision.ts").GlobalProjectAssignment[]
      >,
    ) => {
      const currentSender = readPeerLeadRecord(
        peerRuntime(),
        sender.piSessionId,
      );
      const currentTarget = readPeerLeadRecord(
        peerRuntime(),
        target.piSessionId,
      );
      const stillCurrent = (
        peer: PeerLeadRecord,
        context: typeof senderContext,
      ) => {
        // Managers are globally eligible peers; ProjectAssignment only
        // classifies Lead scope and is not a Manager authorization gate.
        if (context.role === "manager") return true;
        if (!snapshot) return false;
        const matches = snapshot.get(peer.piSessionId) ?? [];
        if (matches.length > 1 || !!matches.length !== context.managed)
          return false;
        if (!matches.length) return true;
        return (
          !!context.group &&
          matches[0].assignment.repoKey === context.group.repoKey &&
          matches[0].socketHash ===
            createHash("sha256").update(peer.socket).digest("hex")
        );
      };
      if (!currentSender || !currentTarget)
        throw new Error(
          "Peer sender or target changed before the message was queued",
        );
      assertCurrentPeerCoordination(ctx, currentSender);
      if (
        !supportsCoordinatorMessaging(currentSender.messageProtocol) ||
        !supportsCoordinatorMessaging(currentTarget.messageProtocol) ||
        !samePeerLeadAuthority(currentSender, sender) ||
        !samePeerLeadAuthority(currentTarget, target) ||
        !stillCurrent(sender, senderContext) ||
        !stillCurrent(target, targetContext) ||
        !canMessagePeer(senderContext, targetContext)
      )
        throw new Error(
          "Peer assignment changed before the message was queued",
        );
      writeCoordinationMessage(record, peerRuntime());
      return record;
    };
    return senderContext.role === "manager" && targetContext.role === "manager"
      ? publish()
      : withProjectAssignmentAuthority(publish);
  };

  const queueChiefRecord = async (
    kind: ChiefMessageKind,
    text: string,
    ctx: ExtensionContext,
    recordId?: string,
    createdAt = Date.now(),
    runtimeOverride?: ReturnType<typeof supervisionRuntime>,
    expectedSupervisor?: { piSessionId: string; leaseId: string },
    resultBindings: readonly ResultBinding[] = [],
    messageProtocol?: number,
  ): ChiefMessageRecord => {
    assertCurrentLeadCoordination(ctx);
    if (
      leadRuntime.controllerRole === "manager" &&
      (!leadRuntime.managerLease ||
        (await currentManager(ctx))?.leaseId !==
          leadRuntime.managerLease.descriptor.leaseId)
    )
      throw new Error("Manager lease is no longer active");
    const messaging = supportsCoordinatorMessaging(messageProtocol);
    const chief = await currentSupervisor(
      ctx,
      messaging ? "identity-only" : undefined,
    );
    if (!chief) throw new Error("No active supervisor is available");
    if (messaging && !supportsCoordinatorMessaging(chief.messageProtocol))
      throw new Error("Supervisor does not advertise messaging protocol 1");
    if (
      expectedSupervisor &&
      (chief.piSessionId !== expectedSupervisor.piSessionId ||
        chief.leaseId !== expectedSupervisor.leaseId)
    )
      throw new Error("Supervisor authority is no longer active");
    const leadSessionId = ctx.sessionManager.getSessionId();
    if (chief.piSessionId === leadSessionId)
      throw new Error("Supervisor target is invalid");
    const record: ChiefMessageRecord = {
      version: 2,
      build: HERDSMAN_BUILD,
      ...(messaging ? { messageProtocol: COORDINATOR_MESSAGE_PROTOCOL } : {}),
      id: recordId ?? randomUUID(),
      leaseId: chief.leaseId,
      kind,
      fromSessionId: leadSessionId,
      toSessionId: chief.piSessionId,
      leadSessionId,
      text,
      ...(resultBindings.length ? { resultBindings: [...resultBindings] } : {}),
      createdAt,
    };
    // Revalidate the descriptor and its live pane immediately before the
    // filesystem write. The earlier check only discovered a target.
    const freshChief = await currentSupervisor(
      ctx,
      messaging ? "identity-only" : undefined,
    );
    assertCurrentLeadCoordination(ctx);
    if (
      leadRuntime.controllerRole === "manager" &&
      (!leadRuntime.managerLease ||
        (await currentManager(ctx))?.leaseId !==
          leadRuntime.managerLease.descriptor.leaseId)
    )
      throw new Error("Manager lease is no longer active");
    if (
      !freshChief ||
      freshChief.leaseId !== chief.leaseId ||
      (messaging &&
        (!supportsCoordinatorMessaging(freshChief.messageProtocol) ||
          freshChief.piSessionId !== chief.piSessionId)) ||
      (expectedSupervisor &&
        (freshChief.piSessionId !== expectedSupervisor.piSessionId ||
          freshChief.leaseId !== expectedSupervisor.leaseId)) ||
      record.toSessionId !== freshChief.piSessionId
    )
      throw new Error(
        "Supervisor target changed before the message was queued",
      );
    const runtime = runtimeOverride ?? supervisionRuntime();
    writeChiefMessage(record, runtime);
    try {
      assertCurrentLeadCoordination(ctx);
    } catch (error) {
      // The post-write coordination check failed. Do not leave a stranded
      // message that can be delivered under a state it was not queued for.
      try {
        removeChiefMessage(runtime, record.toSessionId, record.id, record);
      } catch (cleanupError) {
        // The coordination state is already invalid, so quarantine before
        // surfacing the failure. This prevents retry from using the failed
        // write as a stranded intent.
        markLeadCoordinationUnhealthy(ctx);
        appendDurableError(pi, ctx, "pi_herdsman_state_error", cleanupError);
        try {
          quarantineChiefMessage(runtime, record.toSessionId, record.id);
        } catch (quarantineError) {
          appendDurableError(
            pi,
            ctx,
            "pi_herdsman_state_error",
            quarantineError,
          );
        }
      }
      throw error;
    }
    return record;
  };
  const enterCoordinationPublication = async (): Promise<() => void> => {
    const previous = coordinationPublication;
    let release!: () => void;
    coordinationPublication = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };
  const latestCustomMessageText = (
    ctx: ExtensionContext,
    customType: string,
  ): string | undefined => {
    const entry = [
      ...buildSessionProjection(ctx.sessionManager.getBranch()).entries,
    ]
      .reverse()
      .find(
        (candidate: any) =>
          candidate.sourceEntry.type === "custom_message" &&
          candidate.sourceEntry.customType === customType &&
          candidate.messages.length > 0,
      );
    const message = entry?.messages[0];
    return message ? contentText(message.content, "") : undefined;
  };
  const prepareLeadSupervisorStateMessage = async (ctx: ExtensionContext) => {
    const stateContent = await leadSupervisorState(ctx);
    const diagnostics = takeProtocolDiagnostics(
      ctx.sessionManager.getSessionId(),
    );
    const content = [
      stateContent,
      ...diagnostics.map((item) => `Coordination diagnostic: ${item}`),
    ]
      .filter(Boolean)
      .join("\n");
    return supervisorStateMessage(
      supervisorStateType,
      content,
      latestCustomMessageText(ctx, supervisorStateType),
    );
  };
  type PeerOperation =
    | { action: "list"; internal?: boolean }
    | { action: "message"; target: string; message: string; files?: string[] };
  type RemoteDiagnostic = {
    machine?: string;
    reason:
      | "machine_list_failed"
      | "herdr_not_reachable"
      | "probe_failed"
      | "protocol_mismatch"
      | "protocol_unverified"
      | "eligibility_unverified";
    peer?: string;
  };
  const maxRemoteDiagnostics = 20;
  const remotePeerRoutes = new Map<
    string,
    {
      machine: SavedPeerMachine;
      dataRoot: string;
      claimId: string;
      role: "manager" | "lead";
    }
  >();
  const ambiguousRemoteSessions = new Set<string>();
  const lastPeerCorrespondenceErrors = new Map<string, string>();
  const matchesReturnRecipient = (
    correspondence: PeerCorrespondence,
    recipient: PeerLeadRecord,
  ) =>
    !correspondence.finalized &&
    correspondence.recipientSession === recipient.piSessionId &&
    correspondence.recipientGeneration === recipient.claim.id;
  let latestPeerDiscovery = 0;
  const deliverRemoteOutbound = async (
    machine: SavedPeerMachine,
    id: string,
    envelope: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    try {
      const receipt = JSON.parse(
        await runPeerEndpoint(machine, "accept", envelope, signal),
      ) as { accepted?: unknown; id?: unknown };
      if (receipt.accepted !== true || receipt.id !== id) return false;
      removeRemotePeerOutbound(id);
      return true;
    } catch {
      return false;
    }
  };
  const executeSupervisorMessage = async (
    _id: string,
    raw: unknown,
    signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    const structuredError = (
      category: "invalid_request" | "target_not_found" | "internal_failure",
      message: string,
    ) =>
      new OperationError({
        category,
        message,
        operation: "message_supervisor",
        rollbackOccurred: false,
        retryAttempted: false,
      });
    const boundaryError = (error: unknown): OperationError => {
      if (error instanceof OperationError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = structuredError("internal_failure", message);
      Object.defineProperty(wrapped, "cause", { value: error });
      return wrapped;
    };
    if (controllerScope.kind !== "root" || leadRuntime.chiefMode !== "inactive")
      throw structuredError(
        "invalid_request",
        "Chief is available only to ordinary leads",
      );
    const params = raw as { message: string; files?: readonly string[] };
    if (typeof params.message !== "string" || !params.message.trim())
      throw structuredError(
        "invalid_request",
        "Message must contain non-whitespace text",
      );
    if (!leadCoordinationHealthy)
      throw structuredError(
        "internal_failure",
        "Lead coordination state is unavailable",
      );
    let record: ChiefMessageRecord | undefined;
    const releaseCoordinationPublication = await enterCoordinationPublication();
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const identity = readSessionKind(
        ctx.sessionManager.getEntries(),
        sessionId,
      );
      if (!identity)
        throw structuredError(
          "internal_failure",
          "Session identity is unavailable",
        );
      if (identity.kind === "managed" && activeRole() !== "lead")
        throw structuredError(
          "internal_failure",
          "Managed Lead cannot use ordinary supervisor routing",
        );
      let assignment: ProjectAssignment | undefined;
      if (identity.kind === "managed" && activeRole() === "lead") {
        try {
          assignment = await currentProjectAssignment(ctx);
        } catch (error) {
          throw boundaryError(error);
        }
        if (!assignment)
          throw structuredError(
            "internal_failure",
            "Managed project assignment is unavailable",
          );
      }
      if (assignment) {
        const files = resolveMessageFiles(
          ctx,
          params.files,
          "message_supervisor",
        );
        let published: ProjectMessage | undefined;
        try {
          published = await publishProjectMessage(
            ctx,
            assignment,
            params.message,
            files,
            "message_supervisor",
            undefined,
            "supervisor_message",
            signal,
          );
        } catch (error) {
          throw boundaryError(error);
        }
        if (!published)
          throw structuredError(
            "invalid_request",
            "Project assignment changed before message publication",
          );
        return {
          content: [
            {
              type: "text",
              text: `Project message saved for Manager (${published.id}).`,
            },
          ],
          details: { id: published.id, branch: assignment.branch },
        };
      }
      const chief = await currentSupervisor(ctx, "identity-only");
      if (!chief)
        throw structuredError(
          "target_not_found",
          "No active supervisor is available",
        );
      if (!supportsCoordinatorMessaging(chief.messageProtocol))
        throw structuredError(
          "target_not_found",
          "Supervisor does not advertise messaging protocol 1",
        );
      const recordId = randomUUID();
      const createdAt = Date.now();
      const prepared = await prepareCoordinationInput(
        ctx,
        params.message,
        resolveMessageFiles(ctx, params.files, "message_supervisor"),
        "message_supervisor",
        "Message",
        (candidate, resultBindings) => ({
          version: 2,
          build: HERDSMAN_BUILD,
          messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
          id: recordId,
          leaseId: chief.leaseId,
          kind: activeRole() === "manager" ? "manager_message" : "lead_message",
          fromSessionId: ctx.sessionManager.getSessionId(),
          toSessionId: chief.piSessionId,
          leadSessionId: ctx.sessionManager.getSessionId(),
          text: candidate,
          ...(resultBindings.length
            ? { resultBindings: [...resultBindings] }
            : {}),
          createdAt,
        }),
      );
      record = await queueChiefRecord(
        activeRole() === "manager" ? "manager_message" : "lead_message",
        prepared.text,
        ctx,
        recordId,
        createdAt,
        undefined,
        undefined,
        prepared.resultBindings,
        COORDINATOR_MESSAGE_PROTOCOL,
      );
    } catch (error) {
      try {
        if (record)
          try {
            removeChiefMessage(
              supervisionRuntime(),
              record.toSessionId,
              record.id,
              record,
            );
          } catch (cleanupError) {
            markLeadCoordinationUnhealthy(ctx);
            try {
              quarantineChiefMessage(
                supervisionRuntime(),
                record.toSessionId,
                record.id,
              );
            } catch (quarantineError) {
              appendDurableError(
                pi,
                ctx,
                "pi_herdsman_state_error",
                quarantineError,
              );
            }
            appendDurableError(
              pi,
              ctx,
              "pi_herdsman_state_error",
              cleanupError,
            );
          }
      } catch (cleanupError) {
        appendDurableError(pi, ctx, "pi_herdsman_state_error", cleanupError);
      }
      throw error;
    } finally {
      releaseCoordinationPublication();
    }
    if (!record) throw new Error("Supervisor message was not queued");
    return {
      content: [
        {
          type: "text",
          text: `Message sent to supervisor (${record.id}).`,
        },
      ],
      details: { id: record.id },
    };
  };
  const resolvePeerResultBindings = (
    ctx: ExtensionContext,
    bindings: readonly ResultBinding[],
  ): { bindings: ResultBinding[]; conflicts: ResultBinding[] } => {
    return splitPeerResultBindings(bindings, (ref) =>
      canonicalRefsForSemanticResult(
        ctx.sessionManager.getBranch(),
        ref,
        "peer_message",
      ),
    );
  };
  const describePeerResultConflicts = (
    conflicts: readonly ResultBinding[],
  ): string =>
    conflicts.length
      ? `\n\nSemantic result reference conflict; use the immutable local artifact reference instead:\n${conflicts
          .map((binding) => `${binding.ref} → ${binding.canonicalRef}`)
          .join("\n")}`
      : "";

  const executePeerMessage = async (
    _id: string,
    raw: unknown,
    signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    if (
      controllerScope.kind !== "root" ||
      leadRuntime.chiefMode !== "inactive" ||
      leadRuntime.roleSuspended
    )
      throw new Error("Peer is unavailable in this role");
    if (
      leadRuntime.controllerRole === "manager" &&
      (!leadRuntime.managerLease ||
        (await currentManager(ctx))?.leaseId !==
          leadRuntime.managerLease.descriptor.leaseId)
    )
      throw new Error("Manager lease is no longer active");
    const params = raw as PeerOperation;
    if (params.action === "list") {
      const discovery = ++latestPeerDiscovery;
      const self = ctx.sessionManager.getSessionId();
      const assignmentSnapshot =
        activeRole() === "manager"
          ? undefined
          : globalProjectAssignmentSnapshot();
      const own = await livePeerLead(ctx, self);
      const ownContext =
        own &&
        (await peerContext(
          own,
          ctx,
          assignmentSnapshot,
          (assignmentSnapshot?.get(self)?.length ?? 0) > 0,
        ));
      if (!supportsCoordinatorMessaging(own?.messageProtocol))
        throw new Error("Local peer messaging protocol 1 is not advertised");
      if (!ownContext)
        throw new Error(
          "Peer eligibility could not be verified; retry list_peers.",
        );
      const remoteDiscoveryEligible =
        activeRole() === "manager" ||
        (activeRole() === "lead" &&
          !!own &&
          assignmentSnapshot !== undefined &&
          isRemoteOrdinaryLead(own, assignmentSnapshot));
      const correspondences =
        (activeRole() === "manager" || activeRole() === "lead") &&
        own.role === activeRole()
          ? listPeerCorrespondences().filter(
              (correspondence) =>
                (correspondence.role ?? "manager") === activeRole(),
            )
          : [];
      for (const correspondence of correspondences) {
        if (
          !correspondence.finalized &&
          correspondence.recipientSession === self &&
          correspondence.recipientGeneration !== own.claim.id
        ) {
          updatePeerRecipientGeneration(
            correspondence.id,
            correspondence.capability,
            self,
            correspondence.recipientGeneration,
            own.claim.id,
          );
          correspondence.recipientGeneration = own.claim.id;
        }
      }
      const peers = [];
      const localDiagnostics: {
        reason: "protocol_mismatch" | "protocol_unverified";
        required_protocol: 1;
      }[] = [];
      for (const record of listPeerLeadRecordsForDiscovery(peerRuntime())) {
        if (
          (record.role ?? "lead") !== activeRole() ||
          record.piSessionId === self
        )
          continue;
        const candidateManaged =
          (assignmentSnapshot?.get(record.piSessionId)?.length ?? 0) > 0;
        const requireFreshGroup =
          ownContext.role === "lead" &&
          (ownContext.managed || candidateManaged);
        const currentOwnContext = requireFreshGroup
          ? await peerContext(own!, ctx, assignmentSnapshot, true)
          : ownContext;
        const context = await peerContext(
          record,
          ctx,
          assignmentSnapshot,
          requireFreshGroup,
        ).catch(() => undefined);
        if (
          !context ||
          !currentOwnContext ||
          !canMessagePeer(currentOwnContext, context)
        )
          continue;
        if (!supportsCoordinatorMessaging(record.messageProtocol)) {
          if (localDiagnostics.length < 20)
            localDiagnostics.push({
              reason:
                record.messageProtocol === undefined
                  ? "protocol_unverified"
                  : "protocol_mismatch",
              required_protocol: COORDINATOR_MESSAGE_PROTOCOL,
            });
          continue;
        }
        peers.push({
          session: record.piSessionId,
          name:
            record.name ??
            (activeRole() === "manager" ? "Manager peer" : "Lead peer"),
          cwd: record.cwd ?? "",
          repo: record.repo ?? "",
          branch: record.branch ?? "",
          workspace_label: record.workspaceLabel ?? "",
        });
      }
      const remoteDiagnostics: RemoteDiagnostic[] = [];
      let remoteDiagnosticsOmitted = 0;
      const addRemoteDiagnostic = (diagnostic: RemoteDiagnostic) => {
        if (remoteDiagnostics.length < maxRemoteDiagnostics)
          remoteDiagnostics.push(diagnostic);
        else remoteDiagnosticsOmitted++;
      };
      const diagnosticLabel = (value: unknown, fallback: string): string => {
        const text =
          typeof value === "string"
            ? value
                .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
                .replace(/\s+/gu, " ")
                .trim()
            : "";
        if (!text) return fallback;
        const characters = Array.from(text);
        return characters.length > 80
          ? `${characters.slice(0, 79).join("")}…`
          : text;
      };
      const localPeerSessions = new Set(peers.map((peer) => peer.session));
      const discoveredRemotePeerRoutes = new Map(remotePeerRoutes);
      const previousAmbiguousSessions = new Set(ambiguousRemoteSessions);
      const discoveredAmbiguousSessions = new Set<string>();
      let machineListingFailed = false;
      let machineDiscoveryIncomplete = false;
      let pendingOutbounds:
        ReturnType<typeof listRemotePeerOutbounds> | undefined;
      let pendingCorrespondences:
        ReturnType<typeof listPeerCorrespondences> | undefined;
      if (remoteDiscoveryEligible) {
        let machines: SavedPeerMachine[];
        let machineListingSucceeded = false;
        try {
          machines = await listSavedPeerMachines(signal);
          machineListingSucceeded = true;
        } catch {
          machines = [];
          machineListingFailed = true;
          machineDiscoveryIncomplete = true;
          addRemoteDiagnostic({ reason: "machine_list_failed" });
        }
        if (machineListingSucceeded) {
          const listedMachines = new Map(
            machines.map((machine) => [machine.id, machine]),
          );
          for (const [session, route] of discoveredRemotePeerRoutes) {
            const listed = listedMachines.get(route.machine.id);
            if (!listed || listed.reachable)
              discoveredRemotePeerRoutes.delete(session);
          }
          for (const [session, route] of remotePeerRoutes) {
            const listed = listedMachines.get(route.machine.id);
            if (listed && !listed.reachable)
              discoveredRemotePeerRoutes.set(session, route);
          }
        }
        for (const machine of machines) {
          if (signal?.aborted) break;
          if (!machine.reachable) {
            machineDiscoveryIncomplete = true;
            addRemoteDiagnostic({
              machine: diagnosticLabel(machine.label, "machine"),
              reason: "herdr_not_reachable",
            });
            continue;
          }
          let identityEstablished = false;
          try {
            const snapshot = await probePeerEndpoint(machine, signal);
            if (signal?.aborted) break;
            identityEstablished = true;
            const bridgeProtocolSupported = supportsCoordinatorMessaging(
              snapshot.messageProtocol,
            );
            if (!bridgeProtocolSupported)
              addRemoteDiagnostic({
                machine: diagnosticLabel(machine.label, "machine"),
                reason:
                  snapshot.messageProtocol === undefined
                    ? "protocol_unverified"
                    : "protocol_mismatch",
              });
            const ordinaryLeadScanIncomplete =
              activeRole() === "lead" &&
              snapshot.ordinaryLeadsComplete !== true;
            if (ordinaryLeadScanIncomplete) {
              machineDiscoveryIncomplete = true;
              addRemoteDiagnostic({
                machine: diagnosticLabel(machine.label, "machine"),
                reason: "eligibility_unverified",
              });
            }
            for (const [session, route] of discoveredRemotePeerRoutes)
              if (
                route.machine.id === machine.id &&
                (!ordinaryLeadScanIncomplete || route.role !== "lead")
              )
                discoveredRemotePeerRoutes.delete(session);
            if (ordinaryLeadScanIncomplete && bridgeProtocolSupported)
              for (const [session, route] of remotePeerRoutes) {
                if (route.machine.id !== machine.id || route.role !== "lead")
                  continue;
                if (discoveredRemotePeerRoutes.has(session)) {
                  discoveredAmbiguousSessions.add(session);
                  discoveredRemotePeerRoutes.delete(session);
                } else discoveredRemotePeerRoutes.set(session, route);
              }
            for (const remote of snapshot.peers) {
              const remoteRole = activeRole();
              if (
                !bridgeProtocolSupported ||
                remote.role !== remoteRole ||
                (remoteRole === "lead" &&
                  (snapshot.ordinaryLeadsComplete !== true ||
                    remote.sessionKind !== "ordinary")) ||
                remote.piSessionId === self ||
                localPeerSessions.has(remote.piSessionId) ||
                !remote.claim?.id ||
                discoveredAmbiguousSessions.has(remote.piSessionId)
              )
                continue;
              const peerHint = diagnosticLabel(
                remote.name,
                remoteRole === "lead" ? "Lead peer" : "Manager peer",
              );
              if (!supportsCoordinatorMessaging(remote.messageProtocol)) {
                addRemoteDiagnostic({
                  machine: diagnosticLabel(machine.label, "machine"),
                  reason:
                    remote.messageProtocol === undefined
                      ? "protocol_unverified"
                      : "protocol_mismatch",
                  peer: peerHint,
                });
                continue;
              }
              const route = discoveredRemotePeerRoutes.get(remote.piSessionId);
              if (route) {
                discoveredAmbiguousSessions.add(remote.piSessionId);
                discoveredRemotePeerRoutes.delete(remote.piSessionId);
                continue;
              }
              discoveredRemotePeerRoutes.set(remote.piSessionId, {
                machine,
                dataRoot: snapshot.dataRoot,
                claimId: remote.claim.id,
                role: remoteRole,
              });
              peers.push({
                session: remote.piSessionId,
                name:
                  remote.name ??
                  (remoteRole === "lead" ? "Lead peer" : "Manager peer"),
                machine: machine.label,
                cwd: remote.cwd ?? "",
                repo: remote.repo ?? "",
                branch: remote.branch ?? "",
                workspace_label: remote.workspaceLabel ?? "",
              });
            }
            if (activeRole() === "manager" || activeRole() === "lead") {
              for (const candidate of (pendingOutbounds ??=
                listRemotePeerOutbounds())) {
                if (
                  candidate.machine.id !== machine.id ||
                  candidate.session !== self ||
                  candidate.dataRoot !== snapshot.dataRoot
                )
                  continue;
                const releaseOutbound = tryClaimRemotePeerOutbound(
                  candidate.id,
                );
                if (!releaseOutbound) {
                  continue;
                }
                try {
                  const outbound = readRemotePeerOutbound(candidate.id);
                  if (
                    !outbound ||
                    outbound.machine.id !== machine.id ||
                    outbound.session !== self ||
                    outbound.claimId !== candidate.claimId ||
                    outbound.recipientSession !== candidate.recipientSession ||
                    outbound.digest !== candidate.digest ||
                    outbound.dataRoot !== candidate.dataRoot ||
                    outbound.dataRoot !== snapshot.dataRoot
                  )
                    continue;
                  let envelope = outbound.envelope;
                  const status = JSON.parse(
                    await runPeerEndpoint(
                      machine,
                      "status",
                      JSON.stringify({
                        id: outbound.id,
                        originSession: outbound.session,
                        recipientSession: outbound.recipientSession,
                        digest: outbound.digest,
                        expectedDataRoot: outbound.dataRoot,
                      }),
                      signal,
                    ),
                  ) as {
                    dataRoot?: unknown;
                    id?: unknown;
                    digest?: unknown;
                    status?: unknown;
                  };
                  const retry = resolveRemotePeerOutboundRetry(
                    outbound,
                    status,
                    snapshot,
                  );
                  if (retry.kind === "accepted") {
                    removeRemotePeerOutbound(outbound.id);
                    continue;
                  }
                  const correspondenceRole = (
                    JSON.parse(outbound.envelope) as {
                      correspondence?: { role?: unknown };
                    }
                  ).correspondence?.role;
                  const retryRecipient = snapshot.peers.find(
                    (peer) =>
                      peer.role ===
                        (correspondenceRole === undefined
                          ? "manager"
                          : correspondenceRole) &&
                      peer.piSessionId === outbound.recipientSession,
                  );
                  if (
                    !supportsCoordinatorMessaging(snapshot.messageProtocol) ||
                    !supportsCoordinatorMessaging(
                      retryRecipient?.messageProtocol,
                    )
                  )
                    continue;
                  if (retry.kind !== "retry") continue;
                  if (retry.envelope !== envelope) {
                    envelope = retry.envelope;
                    retargetRemotePeerOutbound(
                      outbound.id,
                      outbound.digest,
                      outbound.recipientSession,
                      envelope,
                    );
                  }
                  await deliverRemoteOutbound(
                    machine,
                    outbound.id,
                    envelope,
                    signal,
                  );
                } catch (error) {
                  // Keep ambiguous acceptance durable; retry status on a later reconciliation.
                } finally {
                  releaseOutbound();
                }
              }
              for (const candidate of (pendingCorrespondences ??=
                listPeerCorrespondences())) {
                if (
                  candidate.originSession !== self ||
                  (candidate.role ?? "manager") !== activeRole()
                )
                  continue;
                const remote = snapshot.peers.find(
                  (peer) =>
                    peer.role === (candidate.role ?? "manager") &&
                    ((candidate.role ?? "manager") !== "lead" ||
                      (snapshot.ordinaryLeadsComplete === true &&
                        peer.sessionKind === "ordinary")) &&
                    supportsCoordinatorMessaging(peer.messageProtocol) &&
                    peer.piSessionId === candidate.recipientSession,
                );
                if (!remote) continue;
                let correspondence: PeerCorrespondence | undefined;
                try {
                  try {
                    correspondence = readPeerCorrespondence(candidate.id);
                  } catch {
                    continue;
                  }
                  if (
                    !correspondence ||
                    correspondence.finalized ||
                    correspondence.capability !== candidate.capability ||
                    correspondence.acceptanceId !== candidate.acceptanceId ||
                    correspondence.originSession !== candidate.originSession ||
                    correspondence.recipientSession !==
                      candidate.recipientSession ||
                    (correspondence.role ?? "manager") !==
                      (candidate.role ?? "manager")
                  )
                    continue;
                  if (
                    !supportsCoordinatorMessaging(snapshot.messageProtocol) ||
                    !supportsCoordinatorMessaging(remote.messageProtocol)
                  )
                    continue;
                  if (remote.claim.id !== correspondence.recipientGeneration) {
                    const recovery = JSON.parse(
                      await runPeerEndpoint(
                        machine,
                        "recover-recipient",
                        JSON.stringify({
                          id: correspondence.id,
                          expectedDataRoot: snapshot.dataRoot,
                          capability: correspondence.capability,
                          originSession: correspondence.originSession,
                          originGeneration: correspondence.originGeneration,
                          recipientSession: correspondence.recipientSession,
                          recipientGeneration:
                            correspondence.recipientGeneration,
                          newRecipientGeneration: remote.claim.id,
                        }),
                        signal,
                      ),
                    ) as { recovered?: unknown };
                    if (recovery.recovered !== true) continue;
                    updatePeerRecipientGeneration(
                      correspondence.id,
                      correspondence.capability,
                      correspondence.recipientSession,
                      correspondence.recipientGeneration,
                      remote.claim.id,
                    );
                    correspondence.recipientGeneration = remote.claim.id;
                  }
                  if (correspondence.originGeneration !== own.claim.id) {
                    const recovery = JSON.parse(
                      await runPeerEndpoint(
                        machine,
                        "recover",
                        peerRecoveryRequest(
                          {
                            id: correspondence.id,
                            capability: correspondence.capability,
                            originSession: correspondence.originSession,
                            originGeneration: own.claim.id,
                            previousOriginGeneration:
                              correspondence.originGeneration,
                            recipientSession: correspondence.recipientSession,
                            recipientGeneration:
                              correspondence.recipientGeneration,
                          },
                          snapshot.dataRoot,
                        ),
                        signal,
                      ),
                    ) as { recovered?: unknown };
                    if (recovery.recovered !== true) continue;
                    updatePeerOriginGeneration(
                      correspondence.id,
                      correspondence.capability,
                      self,
                      correspondence.originGeneration,
                      own.claim.id,
                    );
                    correspondence.originGeneration = own.claim.id;
                  }
                  const request = JSON.stringify({
                    id: correspondence.id,
                    expectedDataRoot: snapshot.dataRoot,
                    capability: correspondence.capability,
                    originSession: correspondence.originSession,
                    originGeneration: correspondence.originGeneration,
                    recipientSession: correspondence.recipientSession,
                    recipientGeneration: correspondence.recipientGeneration,
                  });
                  const polled = await tryPollPeerReplies(() =>
                    runPeerEndpoint(machine, "poll", request, signal),
                  );
                  if (polled === undefined) continue;
                  const response = JSON.parse(polled) as {
                    dataRoot?: unknown;
                    hasReplies?: unknown;
                    replies?: Array<{
                      id?: unknown;
                      digest?: unknown;
                      text?: unknown;
                      attachments?: unknown;
                      resultBindings?: unknown;
                      createdAt?: unknown;
                      acknowledged?: unknown;
                    }>;
                  };
                  if (!Array.isArray(response.replies))
                    throw new Error("invalid remote peer reply batch");
                  if (typeof response.dataRoot !== "string")
                    throw new Error(
                      "peer reply endpoint omitted its data root",
                    );
                  assertPeerDataRoot(response.dataRoot, snapshot.dataRoot);
                  for (const reply of response.replies) {
                    if (
                      typeof reply.id !== "string" ||
                      typeof reply.text !== "string" ||
                      typeof reply.digest !== "string" ||
                      typeof reply.createdAt !== "number" ||
                      !Number.isFinite(reply.createdAt) ||
                      (reply.attachments !== undefined &&
                        !Array.isArray(reply.attachments)) ||
                      (reply.resultBindings !== undefined &&
                        (!Array.isArray(reply.resultBindings) ||
                          !reply.resultBindings.every(isResultBinding))) ||
                      peerPayloadDigest({
                        text: reply.text,
                        ...(reply.attachments?.length
                          ? { attachments: reply.attachments }
                          : {}),
                        ...(Array.isArray(reply.resultBindings)
                          ? { resultBindings: reply.resultBindings }
                          : {}),
                      }) !== reply.digest
                    )
                      throw new Error("invalid remote peer reply");
                    let replyText = reply.text;
                    const receivedRefs: string[] = [];
                    for (const rawAttachment of (reply.attachments ??
                      []) as Array<{
                      name?: unknown;
                      ref?: unknown;
                      marker?: unknown;
                      text?: unknown;
                      sha256?: unknown;
                    }>) {
                      if (
                        typeof rawAttachment.name !== "string" ||
                        typeof rawAttachment.marker !== "string" ||
                        typeof rawAttachment.text !== "string" ||
                        typeof rawAttachment.sha256 !== "string" ||
                        createHash("sha256")
                          .update(rawAttachment.text, "utf8")
                          .digest("hex") !== rawAttachment.sha256
                      )
                        throw new Error("invalid remote reply attachment");
                      const markerIndex = replyText.indexOf(
                        rawAttachment.marker,
                      );
                      if (
                        markerIndex < 0 ||
                        replyText.indexOf(
                          rawAttachment.marker,
                          markerIndex + 1,
                        ) !== -1
                      )
                        throw new Error("reply attachment marker is ambiguous");
                      replyText =
                        replyText.slice(0, markerIndex) +
                        rawAttachment.text +
                        replyText.slice(
                          markerIndex + rawAttachment.marker.length,
                        );
                      const binding = Array.isArray(reply.resultBindings)
                        ? (reply.resultBindings as ResultBinding[]).find(
                            (item) => item.ref === rawAttachment.ref,
                          )
                        : undefined;
                      const localPath = binding
                        ? persistPeerResultArtifact(
                            binding.canonicalRef,
                            rawAttachment.text,
                          )
                        : persistPeerAttachment(
                            rawAttachment.name,
                            rawAttachment.text,
                          );
                      receivedRefs.push(
                        `${rawAttachment.name}: ${binding ? `${binding.ref} (canonical ${binding.canonicalRef})` : localPath}`,
                      );
                    }
                    const resultBindings = Array.isArray(reply.resultBindings)
                      ? (reply.resultBindings as ResultBinding[])
                      : [];
                    const resolution = resolvePeerResultBindings(
                      ctx,
                      resultBindings,
                    );
                    replyText += describePeerResultConflicts(
                      resolution.conflicts,
                    );
                    const record: ChiefMessageRecord = {
                      version: 2,
                      build: HERDSMAN_BUILD,
                      messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
                      id: reply.id,
                      leaseId: correspondence.recipientGeneration,
                      kind: "peer_message",
                      fromSessionId: correspondence.recipientSession,
                      toSessionId: self,
                      leadSessionId: correspondence.recipientSession,
                      peerSource:
                        (correspondence.role ?? "manager") === "lead"
                          ? { role: "lead", remoteOrdinary: true }
                          : { role: "manager" },
                      text: `${replyText}${receivedRefs.length ? `\n\nForwardable received files:\n${receivedRefs.join("\n")}` : ""}`,
                      ...(resolution.bindings.length
                        ? { resultBindings: resolution.bindings }
                        : {}),
                      createdAt: reply.createdAt,
                    };
                    writeCoordinationMessage(record, peerRuntime());
                    importResultBindings(
                      pi,
                      ctx,
                      resolution.bindings,
                      "peer.reply",
                    );
                    const ack = JSON.parse(
                      await runPeerEndpoint(
                        machine,
                        "ack",
                        JSON.stringify({
                          ...JSON.parse(request),
                          replyId: reply.id,
                        }),
                        signal,
                      ),
                    ) as { acknowledged?: unknown };
                    if (ack.acknowledged !== true)
                      throw new Error(
                        "remote peer reply acknowledgement failed",
                      );
                  }
                  // A reply is progress, not route retirement. Keep the verified
                  // Manager-pair correspondence until explicit retirement.
                  lastPeerCorrespondenceErrors.delete(correspondence.id);
                } catch (error) {
                  if (signal?.aborted) break;
                  const message =
                    error instanceof Error ? error.message : String(error);
                  if (
                    lastPeerCorrespondenceErrors.get(correspondence.id) !==
                    message
                  ) {
                    try {
                      appendDurableError(
                        pi,
                        ctx,
                        "pi_herdsman_state_error",
                        error,
                      );
                      lastPeerCorrespondenceErrors.set(
                        correspondence.id,
                        message,
                      );
                    } catch {
                      // One diagnostic failure must not block other correspondences.
                    }
                  }
                }
              }
            }
          } catch (error) {
            if (identityEstablished) {
              appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
            } else {
              const protocolUnverified =
                error instanceof Error &&
                error.message ===
                  "Peer endpoint omitted coordinator message protocol";
              machineDiscoveryIncomplete = true;
              addRemoteDiagnostic({
                machine: diagnosticLabel(machine.label, "machine"),
                reason: protocolUnverified
                  ? "protocol_unverified"
                  : "probe_failed",
              });
              for (const [session, route] of discoveredRemotePeerRoutes)
                if (route.machine.id === machine.id)
                  discoveredRemotePeerRoutes.delete(session);
              for (const [session, route] of remotePeerRoutes) {
                if (protocolUnverified) break;
                if (route.machine.id !== machine.id) continue;
                const current = discoveredRemotePeerRoutes.get(session);
                if (current) {
                  discoveredAmbiguousSessions.add(session);
                  discoveredRemotePeerRoutes.delete(session);
                } else {
                  discoveredRemotePeerRoutes.set(session, route);
                }
              }
            }
          }
        }
        if (machineDiscoveryIncomplete) {
          for (const session of previousAmbiguousSessions)
            discoveredAmbiguousSessions.add(session);
        }
        for (const session of discoveredAmbiguousSessions)
          discoveredRemotePeerRoutes.delete(session);
        for (const session of discoveredAmbiguousSessions) {
          const index = peers.findIndex(
            (peer) => peer.session === session && "machine" in peer,
          );
          if (index >= 0) peers.splice(index, 1);
        }
      }
      if (
        (activeRole() === "manager" || activeRole() === "lead") &&
        discovery === latestPeerDiscovery &&
        !signal?.aborted &&
        !machineListingFailed
      ) {
        remotePeerRoutes.clear();
        for (const [session, route] of discoveredRemotePeerRoutes)
          remotePeerRoutes.set(session, route);
        ambiguousRemoteSessions.clear();
        for (const session of discoveredAmbiguousSessions)
          ambiguousRemoteSessions.add(session);
      }
      if (activeRole() === "lead" && !remoteDiscoveryEligible) {
        for (const [session, route] of remotePeerRoutes)
          if (route.role === "lead") remotePeerRoutes.delete(session);
        ambiguousRemoteSessions.clear();
      }
      const discovered = new Set(peers.map((peer) => peer.session));
      const replyCorrespondences = new Map<string, PeerCorrespondence | null>();
      if (
        (activeRole() === "manager" || activeRole() === "lead") &&
        own.role === activeRole()
      )
        for (const correspondence of correspondences) {
          if (!matchesReturnRecipient(correspondence, own)) continue;
          replyCorrespondences.set(
            correspondence.originSession,
            replyCorrespondences.has(correspondence.originSession)
              ? null
              : correspondence,
          );
        }
      const replyOnly = [...replyCorrespondences]
        .filter(
          ([session, correspondence]) =>
            correspondence !== null &&
            (activeRole() !== "lead" ||
              (!!own &&
                assignmentSnapshot !== undefined &&
                isRemoteOrdinaryLead(own, assignmentSnapshot))) &&
            session !== self &&
            !discovered.has(session) &&
            !remotePeerRoutes.has(session) &&
            !ambiguousRemoteSessions.has(session),
        )
        .map(([session, correspondence]) => ({
          session,
          ...(correspondence!.originDisplay?.name
            ? { name: correspondence.originDisplay.name }
            : {}),
          ...(correspondence!.originDisplay?.workspaceLabel
            ? { workspace_label: correspondence.originDisplay.workspaceLabel }
            : {}),
        }));
      const discoveryPayload = {
        self,
        peers,
        ...(localDiagnostics.length
          ? { local_diagnostics: localDiagnostics }
          : {}),
        ...(replyOnly.length ? { reply_only: replyOnly } : {}),
        ...(remoteDiagnostics.length
          ? {
              remote_diagnostics: remoteDiagnostics,
              ...(remoteDiagnosticsOmitted
                ? { remote_diagnostics_omitted: remoteDiagnosticsOmitted }
                : {}),
            }
          : {}),
      };
      const presentedPayload = params.internal
        ? discoveryPayload
        : {
            ...discoveryPayload,
            self: { role: activeRole() },
            peers: peers.map(({ session, ...peer }) => ({
              target: rememberCoordinatorTarget(
                pi,
                ctx,
                activeRole() as "lead" | "manager",
                session,
              ),
              ...peer,
            })),
            ...(replyOnly.length
              ? {
                  reply_only: replyOnly.map(({ session, ...peer }) => ({
                    target: rememberCoordinatorTarget(
                      pi,
                      ctx,
                      activeRole() as "lead" | "manager",
                      session,
                    ),
                    ...peer,
                  })),
                }
              : {}),
          };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(presentedPayload),
          },
        ],
        details: {
          ok: true,
          action: "list",
          ...presentedPayload,
        },
      };
    }
    const resolvedTarget = resolveCoordinatorTarget(ctx, params.target);
    if (resolvedTarget.role !== activeRole())
      throw new Error(
        "Peer target role does not match the current role; run `list_peers` again.",
      );
    const recipientSession = resolvedTarget.sessionId;
    const sender = await livePeerLead(ctx, ctx.sessionManager.getSessionId());
    if (sender && !supportsCoordinatorMessaging(sender.messageProtocol))
      throw new Error("Local peer does not advertise messaging protocol 1");
    const remoteRoute = remotePeerRoutes.get(recipientSession);
    const returnCorrespondences =
      sender &&
      (activeRole() === "manager" || activeRole() === "lead") &&
      !remoteRoute
        ? listPeerCorrespondences().filter(
            (item) =>
              (item.role ?? "manager") === activeRole() &&
              matchesReturnRecipient(item, sender) &&
              item.originSession === recipientSession,
          )
        : [];
    const target = remoteRoute
      ? undefined
      : await livePeerLead(ctx, recipientSession);
    const noAuthorizedLocalTarget =
      (!target || (target.role ?? "lead") !== activeRole()) &&
      returnCorrespondences.length !== 1;
    const rejection = !sender
      ? "sender_unavailable"
      : (sender.role ?? "lead") !== activeRole()
        ? "sender_role_changed"
        : remoteRoute
          ? remoteRoute.role !== activeRole()
            ? "route_role_mismatch"
            : ambiguousRemoteSessions.has(recipientSession)
              ? "route_ambiguous"
              : undefined
          : noAuthorizedLocalTarget
            ? ambiguousRemoteSessions.has(recipientSession)
              ? "route_ambiguous"
              : "no_authorized_target"
            : undefined;
    if (rejection)
      throw new Error(
        `Peer target was not found or is no longer a live same-role peer [${rejection}]`,
      );
    const recordId = randomUUID();
    const createdAt = Date.now();
    const submissionSource = await peerContext(sender, ctx);
    if (!submissionSource)
      throw new Error(
        "Peer is unavailable or outside the permitted project scope. Run `list_peers` again.",
      );
    const prepared = await prepareCoordinationInput(
      ctx,
      params.message,
      resolveMessageFiles(ctx, params.files, "peer.message"),
      "peer.message",
      "Message",
      (candidate, resultBindings) => ({
        version: 2,
        build: HERDSMAN_BUILD,
        messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
        id: recordId,
        leaseId: sender.claim.id,
        kind: "peer_message",
        fromSessionId: sender.piSessionId,
        toSessionId: target?.piSessionId ?? recipientSession,
        leadSessionId: sender.piSessionId,
        peerSource:
          remoteRoute && activeRole() === "lead"
            ? { role: "lead", remoteOrdinary: true }
            : submissionSource,
        text: candidate,
        ...(resultBindings.length
          ? { resultBindings: [...resultBindings] }
          : {}),
        createdAt,
      }),
    );
    if (returnCorrespondences.length === 1) {
      const correspondence = returnCorrespondences[0]!;
      const replyId = randomUUID();
      const replyAttachments = prepared.attachments.map((attachment) => {
        if (attachment.text === undefined || attachment.marker === undefined)
          throw new Error(
            `Peer reply attachment was not captured completely: ${attachment.name}`,
          );
        return {
          name: attachment.name,
          ...(attachment.ref ? { ref: attachment.ref } : {}),
          marker: attachment.marker,
          text: attachment.text,
          sha256: createHash("sha256")
            .update(attachment.text, "utf8")
            .digest("hex"),
        };
      });
      const enqueueReply = (
        assignments?: Map<
          string,
          import("../supervision.ts").GlobalProjectAssignment[]
        >,
      ) => {
        const currentSender = readPeerLeadRecord(
          peerRuntime(),
          sender.piSessionId,
        );
        const currentCorrespondence = listPeerCorrespondences().filter(
          (item) =>
            item.id === correspondence.id &&
            !item.finalized &&
            (item.role ?? "manager") === activeRole() &&
            item.originSession === correspondence.originSession &&
            item.originGeneration === correspondence.originGeneration &&
            item.recipientSession === correspondence.recipientSession &&
            item.recipientGeneration === correspondence.recipientGeneration,
        );
        if (
          !currentSender ||
          !samePeerLeadAuthority(currentSender, sender) ||
          (activeRole() === "lead" &&
            (!assignments ||
              !isRemoteOrdinaryLead(currentSender, assignments) ||
              currentCorrespondence.length !== 1)) ||
          (activeRole() !== "lead" && currentCorrespondence.length !== 1)
        )
          throw new Error("Peer correspondence authority changed");
        queuePeerReply(
          correspondence,
          replyId,
          prepared.transportText ?? prepared.text,
          {
            attachments: replyAttachments,
            ...(prepared.resultBindings.length
              ? { resultBindings: prepared.resultBindings }
              : {}),
          },
        );
      };
      if (activeRole() === "lead") withProjectAssignmentAuthority(enqueueReply);
      else enqueueReply();
      const recipientRole = correspondence.role ?? "manager";
      return {
        content: [
          {
            type: "text",
            text: `Reply queued for originating ${recipientRole === "lead" ? "Lead" : "Manager"} ${params.target} (${replyId}).`,
          },
        ],
        details: { id: replyId, target: params.target, queued: true },
      };
    }
    if (remoteRoute) {
      const current = await probePeerEndpoint(remoteRoute.machine, signal);
      if (!supportsCoordinatorMessaging(current.messageProtocol))
        throw new Error(
          "Remote peer endpoint does not support messaging protocol 1",
        );
      const currentTarget = current.peers.find(
        (peer) =>
          peer.role === remoteRoute.role &&
          peer.piSessionId === recipientSession &&
          peer.claim.id === remoteRoute.claimId &&
          (remoteRoute.role !== "lead" ||
            (current.ordinaryLeadsComplete === true &&
              peer.sessionKind === "ordinary")),
      );
      if (!currentTarget || current.dataRoot !== remoteRoute.dataRoot)
        throw new Error("Remote Manager changed; run `list_peers` again.");
      if (!supportsCoordinatorMessaging(currentTarget.messageProtocol))
        throw new Error("Remote peer does not advertise messaging protocol 1");
      const record: ChiefMessageRecord = {
        version: 2,
        build: HERDSMAN_BUILD,
        messageProtocol: COORDINATOR_MESSAGE_PROTOCOL,
        id: recordId,
        leaseId: sender.claim.id,
        kind: "peer_message",
        fromSessionId: sender.piSessionId,
        toSessionId: recipientSession,
        leadSessionId: sender.piSessionId,
        peerSource:
          remoteRoute.role === "lead"
            ? { role: "lead", remoteOrdinary: true }
            : { role: "manager" },
        text: prepared.transportText ?? prepared.text,
        ...(prepared.resultBindings.length
          ? { resultBindings: [...prepared.resultBindings] }
          : {}),
        createdAt,
      };
      const attachments = prepared.attachments.map((attachment) => {
        if (attachment.text === undefined || attachment.marker === undefined)
          throw new Error(
            `Peer attachment was not captured completely: ${attachment.name}`,
          );
        return {
          name: attachment.name,
          ...(attachment.ref ? { ref: attachment.ref } : {}),
          marker: attachment.marker,
          text: attachment.text,
          sha256: createHash("sha256")
            .update(attachment.text, "utf8")
            .digest("hex"),
        };
      });
      const originDisplay = {
        ...(validPeerDisplayText(sender.name) ? { name: sender.name } : {}),
        ...(validPeerDisplayText(sender.workspaceLabel)
          ? { workspaceLabel: sender.workspaceLabel }
          : {}),
      };
      const commitOutbound = (
        assignments?: Map<
          string,
          import("../supervision.ts").GlobalProjectAssignment[]
        >,
      ) => {
        assertCurrentPeerCoordination(ctx, sender);
        const currentSender = readPeerLeadRecord(
          peerRuntime(),
          sender.piSessionId,
        );
        if (
          !currentSender ||
          !supportsCoordinatorMessaging(currentSender.messageProtocol) ||
          !samePeerLeadAuthority(currentSender, sender)
        )
          throw new Error("Peer sender authority changed");
        if (remoteRoute.role === "lead") {
          if (!assignments || !isRemoteOrdinaryLead(currentSender, assignments))
            throw new Error("Remote Lead sender authority changed");
        }
        const correspondence =
          listPeerCorrespondences().find(
            (item) =>
              !item.finalized &&
              (item.role ?? "manager") === remoteRoute.role &&
              item.originSession === sender.piSessionId &&
              item.recipientSession === recipientSession,
          ) ??
          createPeerCorrespondence({
            originSession: sender.piSessionId,
            originGeneration: sender.claim.id,
            recipientSession,
            recipientGeneration: remoteRoute.claimId,
            acceptanceId: recordId,
            role: remoteRoute.role,
            ...(Object.keys(originDisplay).length ? { originDisplay } : {}),
          });
        correspondence.recipientGeneration = remoteRoute.claimId;
        if (Object.keys(originDisplay).length)
          correspondence.originDisplay = {
            ...correspondence.originDisplay,
            ...originDisplay,
          };
        storePeerCorrespondence(correspondence);
        const envelope = JSON.stringify({
          record,
          expectedDataRoot: remoteRoute.dataRoot,
          recipientClaimId: remoteRoute.claimId,
          attachments,
          correspondence,
        });
        const transferDigest = peerPayloadDigest({ record, attachments });
        persistRemotePeerOutbound({
          id: recordId,
          machine: remoteRoute.machine,
          dataRoot: remoteRoute.dataRoot,
          session: sender.piSessionId,
          claimId: sender.claim.id,
          recipientSession,
          digest: transferDigest,
          envelope,
        });
        return envelope;
      };
      const envelope =
        remoteRoute.role === "lead"
          ? withProjectAssignmentAuthority(commitOutbound)
          : commitOutbound();
      const releaseOutbound = tryClaimRemotePeerOutbound(recordId);
      let accepted = false;
      if (releaseOutbound) {
        try {
          accepted = await deliverRemoteOutbound(
            remoteRoute.machine,
            recordId,
            envelope,
            signal,
          );
        } finally {
          releaseOutbound();
        }
      }
      return {
        content: [
          {
            type: "text",
            text: accepted
              ? `Message accepted by remote ${remoteRoute.role} ${params.target} (${recordId}).`
              : `Message queued locally for remote ${remoteRoute.role} ${params.target} (${recordId}); remote acceptance is still pending.`,
          },
        ],
        details: {
          id: recordId,
          target: params.target,
          machine: remoteRoute.machine.label,
          accepted,
          queued: true,
        },
      };
    }
    const record = await queuePeerRecord(
      prepared.text,
      target.piSessionId,
      ctx,
      sender,
      target,
      recordId,
      createdAt,
      prepared.resultBindings,
    );
    return {
      content: [
        {
          type: "text",
          text: `Peer message queued for ${params.target}.`,
        },
      ],
      details: {
        ok: true,
        action: "message",
        target: params.target,
        id: record.id,
      },
    };
  };

  const processRetirementNotices = async (
    ctx: ExtensionContext,
    preflight: boolean,
  ): Promise<number> => {
    const eligible = () =>
      activeRole() === "manager" &&
      !leadRuntime.roleSuspended &&
      (preflight || ctx.isIdle());
    if (!eligible()) return 0;
    const manager = await currentManager(ctx);
    const verified = (current: ManagerDescriptor | undefined) =>
      eligible() &&
      !!current &&
      !!manager &&
      !!leadRuntime.managerLease &&
      sameManagerDescriptor(current, manager) &&
      sameManagerDescriptor(current, leadRuntime.managerLease.descriptor) &&
      ctx.sessionManager.getSessionId() === current.piSessionId;
    if (!verified(manager)) return 0;
    const runtime = supervisionRuntime();
    let errorKey = manager!.repoKey;
    try {
      // Bound filesystem work and resume after the last examined directory entry.
      let processed = 0;
      for (const retired of listPendingRetirements(runtime, manager!.repoKey, {
        after: retirementCursors.get(manager!.repoKey),
        recordLimit: preflight ? COORDINATION_INBOX_SCAN_LIMIT : 1,
        onScanned: (entry) => retirementCursors.set(manager!.repoKey, entry),
        onReadError: (error) => {
          const key = `${manager!.repoKey}:${error.message}`;
          if (reportedRetirementErrors.has(key)) return;
          reportedRetirementErrors.add(key);
          appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
        },
      })) {
        errorKey = retired.id;
        try {
          processed += await host.withProjectAssignmentLock(
            retired.repoKey,
            retired.branch,
            async () => {
              if (!verified(await currentManager(ctx))) return 0;
              if (
                readProjectAssignment(runtime, retired.repoKey, retired.branch)
                  ?.id === retired.id
              )
                throw new Error(
                  "Pending retirement still grants assignment authority",
                );
              removeProjectMessagesForAssignment(runtime, retired);
              const received = () =>
                ctx.sessionManager.getEntries().some((entry: any) => {
                  if (
                    entry?.type === "custom_message" &&
                    entry.customType === "pi-herdsman-project_retired"
                  )
                    return (
                      entry.details?.repoKey === retired.repoKey &&
                      entry.details?.branch === retired.branch &&
                      entry.details?.assignmentId === retired.id
                    );
                  const message = entry?.message;
                  const details = message?.details;
                  return (
                    entry?.type === "message" &&
                    message?.role === "toolResult" &&
                    !message.isError &&
                    (message.toolName === "staff" ||
                      message.toolName === "remove_worktree") &&
                    details?.ok === true &&
                    details?.action === "remove" &&
                    details?.checkout_removed === true &&
                    details?.assignment_retired === true &&
                    details?.repo_key === retired.repoKey &&
                    details?.assignment_id === retired.id
                  );
                });
              if (!received()) {
                pi.sendMessage(
                  {
                    customType: "pi-herdsman-project_retired",
                    content: [
                      "[Pi Herdsman lifecycle notice]",
                      `The worktree for project branch ${JSON.stringify(retired.branch)} was verified removed.`,
                      `The assignment for Lead session ${retired.id} was retired.`,
                      "Manager authority for that assignment has ended.",
                      "This does not establish task completion, acceptance, merge, or discard.",
                      "Retiring this assignment does not itself delete the Git branch or Pi session history.",
                    ].join("\n"),
                    display: false,
                    details: {
                      repoKey: retired.repoKey,
                      branch: retired.branch,
                      assignmentId: retired.id,
                    },
                  },
                  { triggerTurn: false },
                );
              }
              if (received()) removePendingRetirement(runtime, retired);
              reportedRetirementErrors.delete(errorKey);
              return 1;
            },
            ctx.signal,
          );
        } catch (error) {
          if (!reportedRetirementErrors.has(retired.id)) {
            reportedRetirementErrors.add(retired.id);
            appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
          }
        }
      }
      return processed;
    } catch (error) {
      if (!reportedRetirementErrors.has(errorKey)) {
        reportedRetirementErrors.add(errorKey);
        appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
      }
      return 0;
    }
  };
  let retirementDrain = Promise.resolve();
  const drainRetirementNotices = (
    ctx: ExtensionContext,
    preflight = false,
  ): Promise<number> => {
    // Preflight must retry after an idle pass declines delivery because the run started.
    const pass = retirementDrain.then(() =>
      processRetirementNotices(ctx, preflight),
    );
    retirementDrain = pass.then(
      () => undefined,
      () => undefined,
    );
    return pass;
  };
  const drainProjectMessages = async (
    ctx: ExtensionContext,
  ): Promise<number> => {
    if (
      activeRole() !== "manager" ||
      leadRuntime.roleSuspended ||
      !ctx.isIdle()
    )
      return 0;
    const lease = leadRuntime.managerLease;
    if (!lease) return 0;
    const runtime = supervisionRuntime();
    if (!mightHaveProjectMessages(runtime, lease.descriptor.repoKey)) return 0;
    const manager = await currentManager(ctx);
    if (!manager || !sameManagerDescriptor(manager, lease.descriptor)) return 0;
    const hasProjectMessageReceipt = (record: ProjectMessage): boolean =>
      ctx.sessionManager
        .getEntries()
        .some(
          (entry: any) =>
            entry?.customType === "pi-herdsman-project_message" &&
            entry?.details?.id === record.id &&
            entry?.details?.repoKey === record.repoKey &&
            entry?.details?.branch === record.branch &&
            entry?.details?.fromSessionId === record.fromSessionId,
        );
    const consumeProjectMessage = (record: ProjectMessage): void => {
      try {
        removeProjectMessage(runtime, record.repoKey, record.branch, record.id);
        reportedProjectMessageCleanupErrors.delete(record.id);
        reportedProjectMessageReadErrors.delete(record.id);
      } catch (error) {
        if (!reportedProjectMessageCleanupErrors.has(record.id)) {
          reportedProjectMessageCleanupErrors.add(record.id);
          appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
        }
      }
    };
    const verifiedProjectMessageSource = async (
      candidate: Pick<
        ProjectMessageHeaderIssue,
        "sourceSessionId" | "repoKey" | "branch" | "messageProtocol"
      >,
      assignment: ProjectAssignment,
    ): Promise<boolean> => {
      const sourceSessionId = candidate.sourceSessionId;
      if (
        !sourceSessionId ||
        sourceSessionId !== assignment.id ||
        candidate.repoKey !== assignment.repoKey ||
        candidate.branch !== assignment.branch ||
        candidate.repoKey !== manager.repoKey
      )
        return false;
      try {
        const sources = findProjectAssignmentBySession(
          runtime,
          manager.repoKey,
          sourceSessionId,
        );
        const currentAssignment = readProjectAssignment(
          runtime,
          manager.repoKey,
          assignment.branch,
        );
        const sourceState = readLeadCoordinationStateForObservation(
          runtime,
          sourceSessionId,
        );
        const live = await host.liveAgent(
          ctx,
          sourceSessionId,
          currentAssignment?.piSessionFile,
        );
        const peers = listPeerLeadRecordsForDiscovery(peerRuntime()).filter(
          (peer) => peer.piSessionId === sourceSessionId,
        );
        const liveAgent = live[0];
        const peer = peers[0];
        if (
          !sourceState ||
          !liveAgent ||
          !peer ||
          !currentAssignment?.piSessionFile ||
          !currentAssignment.checkoutPath ||
          typeof liveAgent.cwd !== "string" ||
          !sameDirectory(liveAgent.cwd, currentAssignment.checkoutPath)
        )
          return false;
        const currentLive = await host.liveAgent(
          ctx,
          sourceSessionId,
          currentAssignment.piSessionFile,
        );
        const currentPeerRecords = listPeerLeadRecordsForDiscovery(
          peerRuntime(),
        ).filter((record) => record.piSessionId === sourceSessionId);
        const currentSourceState = readLeadCoordinationStateForObservation(
          runtime,
          sourceSessionId,
        );
        const latestAssignment = readProjectAssignment(
          runtime,
          manager.repoKey,
          assignment.branch,
        );
        const currentLiveAgent = currentLive[0];
        const currentPeer = currentPeerRecords[0];
        return (
          sources.length === 1 &&
          sources[0]?.id === assignment.id &&
          sources[0]?.branch === assignment.branch &&
          currentAssignment?.id === assignment.id &&
          currentAssignment?.branch === assignment.branch &&
          sourceState !== undefined &&
          sourceState.piSessionId === sourceSessionId &&
          (sourceState.role ?? "lead") === "lead" &&
          sourceState.messageProtocol === candidate.messageProtocol &&
          live.length === 1 &&
          !!liveAgent &&
          !!currentAssignment?.piSessionFile &&
          !!currentAssignment.checkoutPath &&
          typeof liveAgent.cwd === "string" &&
          sameDirectory(liveAgent.cwd, currentAssignment.checkoutPath) &&
          peers.length === 1 &&
          !!peer &&
          isRuntimeBuild(peer.build) &&
          isRuntimeBuild(sourceState.build) &&
          sameRuntimeBuild(peer.build, sourceState.build) &&
          (peer.role ?? "lead") === "lead" &&
          peer.sessionKind === "managed" &&
          peer.group?.repoKey === assignment.repoKey &&
          peer.messageProtocol === candidate.messageProtocol &&
          peer.paneId === liveAgent.pane_id &&
          peer.tabId === liveAgent.tab_id &&
          peer.workspaceId === liveAgent.workspace_id &&
          currentLive.length === 1 &&
          !!currentLiveAgent &&
          currentLiveAgent.pane_id === liveAgent.pane_id &&
          currentLiveAgent.tab_id === liveAgent.tab_id &&
          currentLiveAgent.workspace_id === liveAgent.workspace_id &&
          currentLiveAgent.cwd === liveAgent.cwd &&
          currentPeerRecords.length === 1 &&
          !!currentPeer &&
          currentPeer.claim.id === peer.claim.id &&
          currentPeer.messageProtocol === peer.messageProtocol &&
          currentPeer.group?.repoKey === peer.group?.repoKey &&
          currentPeer.paneId === peer.paneId &&
          currentPeer.tabId === peer.tabId &&
          currentPeer.workspaceId === peer.workspaceId &&
          latestAssignment?.id === assignment.id &&
          latestAssignment.checkoutPath === assignment.checkoutPath &&
          currentSourceState?.instanceId === sourceState.instanceId &&
          currentSourceState !== undefined &&
          currentSourceState.piSessionId === sourceSessionId &&
          (currentSourceState.role ?? "lead") === "lead" &&
          currentSourceState.messageProtocol === sourceState.messageProtocol &&
          isRuntimeBuild(currentSourceState.build) &&
          isRuntimeBuild(sourceState.build) &&
          sameRuntimeBuild(currentSourceState.build, sourceState.build)
        );
      } catch {
        return false;
      }
    };
    const reportProjectMessageHeaderIssue = (
      id: string,
      reason: ProjectMessageHeaderIssue["reason"],
      verifiedProtocolSource = false,
    ): void => {
      if (reportedProjectMessageHeaderErrors.has(id)) return;
      try {
        const verifiedProtocolIssue =
          verifiedProtocolSource &&
          (reason === "protocol_mismatch" || reason === "protocol_unverified");
        if (verifiedProtocolIssue)
          reportProtocolDiagnostic(
            ctx.sessionManager.getSessionId(),
            id,
            reason,
            "assigned project message",
          );
        appendDurableError(
          pi,
          ctx,
          "pi_herdsman_state_error",
          new Error(
            verifiedProtocolIssue
              ? "Explicit project message is pending because messaging protocol 1 is missing or unsupported"
              : reason === "oversized"
                ? "Oversized project message is pending and was not delivered"
                : "Malformed explicit project message is pending and was not delivered",
          ),
        );
        reportedProjectMessageHeaderErrors.add(id);
      } catch {
        // Keep the message pending if the diagnostic cannot be persisted.
      }
    };
    for (const assignment of listProjectAssignments(runtime, manager.repoKey)) {
      let pending: ProjectMessageHeader[];
      const invalidHeaders: ProjectMessageHeaderIssue[] = [];
      try {
        pending = listProjectMessageHeaders(
          runtime,
          manager.repoKey,
          assignment.branch,
          (issue) => invalidHeaders.push(issue),
        );
      } catch (error) {
        appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
        return 0;
      }
      for (const issue of invalidHeaders)
        reportProjectMessageHeaderIssue(
          issue.id,
          issue.reason,
          await verifiedProjectMessageSource(issue, assignment),
        );
      for (const record of pending) {
        if (record.fromSessionId !== assignment.id) continue;
        const isSupervisorMessage =
          (record as unknown as { kind?: string }).kind ===
          "supervisor_message";
        const reportUnsupportedProtocol = async () =>
          reportProjectMessageHeaderIssue(
            record.id,
            record.messageProtocol === undefined
              ? "protocol_unverified"
              : "protocol_mismatch",
            await verifiedProjectMessageSource(
              {
                sourceSessionId: record.fromSessionId,
                repoKey: record.repoKey,
                branch: record.branch,
                messageProtocol: record.messageProtocol,
              },
              assignment,
            ),
          );
        if (
          isSupervisorMessage &&
          !supportsCoordinatorMessaging(record.messageProtocol)
        ) {
          await reportUnsupportedProtocol();
          continue;
        }
        if (isSupervisorMessage)
          reportedProjectMessageHeaderErrors.delete(record.id);
        if (hasProjectMessageReceipt(record)) {
          consumeProjectMessage(record);
          continue;
        }
        const current = await currentManager(ctx);
        const stillAssigned = readProjectAssignment(
          runtime,
          manager.repoKey,
          assignment.branch,
        );
        if (
          !ctx.isIdle() ||
          !current ||
          !sameManagerDescriptor(current, manager) ||
          !stillAssigned ||
          stillAssigned.id !== assignment.id
        )
          return 0;
        let message: ProjectMessage;
        try {
          message = readProjectMessage(
            runtime,
            record.repoKey,
            record.branch,
            record.id,
          );
          reportedProjectMessageReadErrors.delete(record.id);
        } catch (error) {
          if (!reportedProjectMessageReadErrors.has(record.id)) {
            reportedProjectMessageReadErrors.add(record.id);
            appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
          }
          continue;
        }
        const messageIsExplicitSupervisor =
          (message as unknown as { kind?: string }).kind ===
          "supervisor_message";
        if (
          messageIsExplicitSupervisor &&
          (message.fromSessionId !== assignment.id ||
            message.repoKey !== manager.repoKey ||
            message.branch !== assignment.branch)
        )
          continue;
        if (
          messageIsExplicitSupervisor &&
          !supportsCoordinatorMessaging(message.messageProtocol)
        ) {
          reportUnsupportedProtocol();
          continue;
        }
        if (messageIsExplicitSupervisor)
          reportedProjectMessageHeaderErrors.delete(record.id);
        importResultBindings(
          pi,
          ctx,
          message.resultBindings,
          "project_message",
        );
        const backlog = message.createdAt < manager.createdAt;
        const actionableFailure =
          backlog && message.kind === "execution_failure";
        pi.sendMessage(
          {
            customType: "pi-herdsman-project_message",
            content:
              projectMessageEnvelope(
                message.kind,
                message.branch,
                message.fromSessionId,
              ) + message.text,
            display: true,
            details: {
              id: message.id,
              repoKey: message.repoKey,
              branch: message.branch,
              fromSessionId: message.fromSessionId,
              kind: message.kind,
            },
          },
          backlog && !actionableFailure
            ? { triggerTurn: false }
            : { deliverAs: "followUp", triggerTurn: true },
        );
        if (hasProjectMessageReceipt(message)) consumeProjectMessage(message);
        return 1;
      }
    }
    return 0;
  };
  return {
    persistCoordinatorState,
    persistLeadCoordination,
    removePeerPresence,
    markLeadCoordinationUnhealthy,
    schedulePeerPresence,
    advancePresenceGeneration: () => peerPresenceGeneration++,
    waitForPeerPresence: () => peerPresencePublication,
    coordinationHealthy: () => leadCoordinationHealthy,
    setCoordinationHealthy: (value: boolean) => {
      leadCoordinationHealthy = value;
    },
    assertCurrentLeadCoordination,
    leadSupervisorState,
    livePeerLead,
    currentPeerPresenceValid,
    currentWorktreeScope,
    authorizePeerRecord,
    peerContext,
    resolvePeerResultBindings,
    describePeerResultConflicts,
    queuePeerRecord,
    queueChiefRecord,
    enterCoordinationPublication,
    drainRetirementNotices,
    drainProjectMessages,
    readLeadSessionIds: readLeadSessionIdsFromHost,
    supervisorMessage: executeSupervisorMessage,
    peerMessage: executePeerMessage,
    latestCustomMessageText,
    prepareLeadSupervisorStateMessage,
    prepareCoordinationInput,
  };
}
