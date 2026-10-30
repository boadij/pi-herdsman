import {
  createLeadProjectRuntime,
  gitPathStatus,
  parseGitWorktreeInventory,
  type LeadProjectHost,
} from "./lead/project.ts";
import {
  createLeadCommandRuntime,
  type LeadCommandBaseHost,
} from "./lead/commands.ts";
import { readSessionKind, type SessionKindEntry } from "./supervision.ts";
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import type {
  ChiefLease,
  ChiefDescriptor,
  ManagerDescriptor,
  ManagerLease,
  ProjectAssignment,
  ProjectMessage,
  ChiefMessageRecord,
  ChiefInboxDrainOptions,
  PeerLeadRecord,
  WorkspaceProvenance,
  SessionRole,
  PeerRuntime,
  SupervisionSnapshot,
} from "./supervision.ts";
import {
  listPendingRetirements,
  removeProjectMessagesForAssignment,
  listProjectAssignments,
  listManagerDescriptors,
  readChiefMessage,
  removeChiefMessage,
  migrateProjectAssignmentEvidenceAfter,
  readProjectAssignment,
  readManagerDescriptor,
  listProjectMessageHeaders,
  readProjectMessage,
  supervisionRuntime,
  globalProjectAssignmentSnapshot,
  withProjectAssignmentAuthorityWait,
  withProjectAssignmentAuthority,
  readPeerLeadRecord,
  samePeerLeadAuthority,
  canMessagePeer,
  isRemoteOrdinaryLead,
  supervisorStateMessage,
  coordinationMessageDelivered,
  verifyManagerCoordinationAuthority,
  verifyRemoteChiefAuthority,
  writePeerDeliveryReceipt,
} from "./supervision.ts";

import { OperationError } from "./errors.ts";
import {
  localRepositoryScope,
  sameDirectory,
  sameObservedSessionPath,
  verifiedHerdrAgent,
} from "./herdr.ts";
import { ProcessLockOccupiedError } from "./lock.ts";
import { readConfig } from "./config.ts";
import { contentText } from "@earendil-works/pi-ai";
import { isLeadExecutionMode, type LeadExecutionMode } from "./core.ts";
import {
  createAgentController,
  buildAgentStatusSnapshot,
  createAgentStatusRuntime,
  type AgentControllerOptions,
  type AgentStatusSnapshotHost,
  type PendingStart,
  type Runtime,
  type ControllerScope,
  type RootDelegationPolicy,
  type RootDelegationGeneration,
  type ManagedAgentSnapshotCollection,
} from "./agent-controller.ts";
import type {
  ExpectedSession,
  HerdrRecord,
  HerdrSessionSnapshot,
  RemovedHerdrWorktree,
  WorktreeGroupScope,
} from "./herdr.ts";
import {
  formatRuntimeBuild,
  isRuntimeBuild,
  sameRuntimeBuild,
  type RuntimeBuild,
} from "./compatibility.ts";
import {
  coordinatorTarget,
  rememberCoordinatorTarget,
} from "./coordinator-target.ts";
import {
  AGENT_COORDINATION_TOOLS,
  configuredToolPolicy,
  discoverRoleDefinition,
  discoverRoleDefinitions,
  discoverAgentDefinitions,
  validateSupervisorAgentDefinitionReferences,
  matchesToolPattern,
  expandAgentBodyFiles,
  FLEXIBLE_LEAD_DEFINITION_NAME,
  ORCHESTRATOR_LEAD_DEFINITION_NAME,
  MANAGER_DEFINITION_NAME,
  CHIEF_DEFINITION_NAME,
  type AgentDefinition,
} from "./agent-definitions.ts";
import type { MessageFileInput } from "./core.ts";
import type { ManagedAgentState, ResultBinding } from "./mailbox.ts";
import {
  populateMenuFrame,
  nameSessionIfUnset,
  buildStatusRows,
  renderRunningOptions,
  formatStatusCounts,
  createSupervisionWidget,
  type FocusIntent,
  type BreadcrumbSegment,
  type StatusSnapshot,
} from "./presentation.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  toNamespacedPath,
} from "node:path";
import { persistedTranscriptReady as controllerPersistedTranscriptReady } from "./agent-controller.ts";
import { herdsmanTempRoot } from "./storage.ts";

import {
  createLeadCoordinationRuntime,
  type LeadCoordinationBaseHost,
} from "./lead/coordination.ts";

type LeadIdentityHost = {
  expectedSession(id: string, path?: string): ExpectedSession;
  listAgents(ctx: ExtensionContext): Promise<{ agents: HerdrRecord[] }>;
  isPiAgent(agent: HerdrRecord): boolean;
  matchesExpectedSession(session: unknown, expected: ExpectedSession): boolean;
  getAgent(
    ctx: ExtensionContext,
    paneId: string,
  ): Promise<{ agent?: HerdrRecord }>;
  hasLeadCoordination(sessionId: string): boolean;
  leadController: Pick<
    ReturnType<typeof createAgentController>,
    "managedAgentSnapshots"
  >;
};

type LeadTransitionHost = {
  runHerdr: typeof import("./herdr.ts").runHerdr;
  SessionManager: Pick<
    typeof import("@earendil-works/pi-coding-agent").SessionManager,
    "open"
  >;
  processRole: string;
  paneId(): string | undefined;
  getSessionName(): string;
  identity: { paneId?: string; tabId?: string; workspaceId?: string };
  statSync: typeof statSync;
  readChiefDescriptor: typeof import("./supervision.ts").readChiefDescriptor;
  chiefLeaseIsHeld: typeof import("./supervision.ts").chiefLeaseIsHeld;
  sameChiefDescriptor: typeof import("./supervision.ts").sameChiefDescriptor;
  claimChiefLease: typeof import("./supervision.ts").claimChiefLease;
  chiefTools: readonly string[];
  managerTools: readonly string[];
  executionTools?(): string[];
  restoreLeadExecution?(ctx: ExtensionContext): Promise<void>;
  invalidateLeadCoordinationState: typeof import("./supervision.ts").invalidateLeadCoordinationState;
  enterChief(
    ctx: ExtensionContext,
    lease: ChiefLease,
    generation: number,
  ): void;
  enterLead(ctx?: ExtensionContext, persist?: boolean): void;
  enterSuspended(ctx?: ExtensionContext): void;
  resetSupervisionSnapshot(): void;
  unlinkLeadCoordinationState(
    runtime: ReturnType<typeof import("./supervision.ts").supervisionRuntime>,
    sessionId: string,
  ): void;
  ownedTools(): ReadonlySet<string>;
  claimManagerLease: typeof import("./supervision.ts").claimManagerLease;
  activationGuard(sessionId: string, role: "Chief" | "Manager"): void;
  reportLeadMetadata: typeof import("./herdr.ts").reportLeadMetadata;
  delay: typeof import("node:timers/promises").setTimeout;
  retireProjectAssignment: typeof import("./supervision.ts").retireProjectAssignment;
  removeProjectMessagesForAssignment: typeof import("./supervision.ts").removeProjectMessagesForAssignment;
  recoverStaleProjectMessages: typeof import("./supervision.ts").recoverStaleProjectMessages;
  sameManagerDescriptor: typeof import("./supervision.ts").sameManagerDescriptor;
  workspaceId(): string | undefined;
  worktreeGroupScope(
    ctx: ExtensionContext,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorktreeGroupScope | undefined>;
  supervisionRuntime: typeof import("./supervision.ts").supervisionRuntime;
  findProjectAssignmentBySession: typeof import("./supervision.ts").findProjectAssignmentBySession;
  acquireProcessLock: typeof import("./lock.ts").acquireProcessLock;
  afterProjectAssignmentLockAcquired?(
    repoKey: string,
    branch: string,
  ): Promise<void>;
  afterProjectAssignmentLockOccupied?(
    repoKey: string,
    branch: string,
  ): Promise<void>;
  onProjectAssignmentAuthorityWaitOccupied?(): void;
  projectAssignmentPath: typeof import("./supervision.ts").projectAssignmentPath;
  readProjectAssignment: typeof import("./supervision.ts").readProjectAssignment;
  readManagerDescriptorStatus: typeof import("./supervision.ts").readManagerDescriptorStatus;
  readLeadCoordinationState: typeof import("./supervision.ts").readLeadCoordinationState;
  requireCompatibleBuild: typeof import("./compatibility.ts").requireCompatibleBuild;
  build: RuntimeBuild;
  currentManager: LeadRoleTransitionRuntime["currentManager"];
  setLeadInstanceId(value: string): void;
  setCoordinationHealthy(value: boolean): void;
  markLeadCoordinationUnhealthy(ctx: ExtensionContext): void;
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
  pi: ExtensionAPI;
  remoteChiefAgent: LeadIdentityRuntime["remoteChiefAgent"];
  persistCoordinatorState(): boolean;
  persistLeadCoordination(): boolean;
  assertCurrentLeadCoordination(ctx: ExtensionContext): void;
  prepareCoordinationInput: ReturnType<
    typeof createLeadCoordinationRuntime
  >["prepareCoordinationInput"];
  projectMessageBytes: typeof import("./supervision.ts").projectMessageBytes;
  writeProjectMessage: typeof import("./supervision.ts").writeProjectMessage;
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
};

type LeadRoleTransitionHost = LeadTransitionHost & {
  invalidateManagerRemovalRequests?(ctx: ExtensionContext): void;
  captureInheritedTools?(): void;
  inheritedProjection?():
    { mode: LeadExecutionMode; excluded: readonly string[] } | undefined;
  setInheritedProjection?(
    projection:
      { mode: LeadExecutionMode; excluded: readonly string[] } | undefined,
  ): void;
  ownedAgentManagementTools(ctx: ExtensionContext): string[];
  supervisoryTools(
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): string[] | undefined;
  prepareSupervisoryProfile(
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): SupervisoryProfile;
  commitSupervisoryProfile(profile: SupervisoryProfile | undefined): void;
  currentSupervisoryProfile(
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): SupervisoryProfile | undefined;
  fallbackSupervisoryProfile(
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): SupervisoryProfile;
};

type SupervisoryProfile = {
  role: "manager" | "chief";
  definition: AgentDefinition;
  tools: string[];
  sessionId: string;
  valid: boolean;
};

type LeadRuntimeOptions = {
  leadRuntime?: LeadRuntimeState;
  leadToolState?: ReturnType<typeof createLeadToolState>;
  ownedToolNames: readonly string[];
  leadCoordinationToolNames: readonly string[];
  onLeadRuntimeReady?(
    runtime: LeadRuntimeState,
    tools: ReturnType<typeof createLeadToolState>,
  ): void;
  controllerServices: Omit<
    AgentControllerOptions,
    "scope" | "build" | "onWorkChanged" | "onWorktreeRemoved"
  >;
  identityHost: LeadIdentityHost;
  roleTransitionHost: LeadTransitionHost;
  coordinationHost: LeadCoordinationBaseHost;
  projectHost: Omit<
    LeadProjectHost,
    | "activeRole"
    | "leadRuntime"
    | "currentManager"
    | "liveLead"
    | "managerLease"
    | "pi"
    | "SessionManager"
    | "stopOwnedAgentsForSession"
    | "withProjectWorkLock"
    | "supervisedSessionFile"
    | "sameObservedSessionPath"
    | "withProjectAssignmentLock"
  > & {
    extensionPath: string;
    SessionManager: Pick<
      typeof import("@earendil-works/pi-coding-agent").SessionManager,
      "open" | "listAll"
    >;
  };
  commandHost: LeadCommandBaseHost;
  supervisionHost: Omit<
    LeadSupervisionHost,
    | "activeRole"
    | "currentChief"
    | "currentChiefAuthority"
    | "currentManager"
    | "isCurrentChief"
    | "latestMessageText"
    | "pi"
    | "state"
  >;
  build: RuntimeBuild;
  herdRunEntryName: string;
  herdRunServices: Pick<LeadHerdRunHost, "appendDurableError">;
  statusSnapshotHost: Omit<
    AgentStatusSnapshotHost,
    "scope" | "listedAgentRecord" | "runtimeForLabel" | "herdStartedAt"
  >;
  inboxHost: LeadInboxBaseHost;
  agentEventOptions: Omit<
    Parameters<typeof createLeadAgentEventRuntime>[0],
    | "controller"
    | "herdRun"
    | "leadInboxRuntime"
    | "consumeChiefStartPreflight"
    | "executionPrompt"
  >;
  sessionStartOptions: Omit<
    Parameters<typeof createLeadSessionStartRuntime>[0],
    | "controller"
    | "herdRun"
    | "leadInboxRuntime"
    | "leadStatusRuntime"
    | "roleTransitions"
    | "prepareLeadExecution"
    | "discoverSessionDefinitions"
    | "hasLeadExecutionState"
  >;
  sessionTreeOptions: Omit<
    Parameters<typeof createLeadSessionTreeRuntime>[0],
    "controller" | "roleTransitions"
  >;
  shutdownOptions: Omit<
    Parameters<typeof createLeadShutdownRuntime>[0],
    | "controller"
    | "herdRun"
    | "leadInboxRuntime"
    | "leadStatusRuntime"
    | "roleTransitions"
    | "clearSupervisionUI"
  >;
  hasPane(): boolean;
  sessionName(): string;
  queueLeadPresentation(ctx: ExtensionContext, name: string): void;
};

type LeadHerdRunHost = {
  activeRole(): "lead" | "manager" | "chief";
  isVerifiedActiveLead(): boolean;
  isManagedLead(): boolean;
  pi: ExtensionAPI;
  entryName: string;
  hasPendingStarts(): boolean;
  listAgentStates(): ReturnType<LeadController["listAgentStates"]>;
  currentProjectAssignment(
    ctx: ExtensionContext,
  ): Promise<ProjectAssignment | undefined>;
  publishProjectMessage(
    ctx: ExtensionContext,
    assignment: ProjectAssignment,
    message: string,
    files?: readonly string[],
    operation?: string,
    reportId?: string,
    kind?: ProjectMessage["kind"],
    signal?: AbortSignal,
  ): Promise<ProjectMessage | undefined>;
  publishChiefFailure(
    ctx: ExtensionContext,
    message: string,
    reportId: string,
    role: "lead" | "manager",
    createdAt: number,
  ): Promise<boolean>;
  requestStatusRefresh(): void;
  queueLeadPresentation(ctx: ExtensionContext, name: string): void;
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
};

type LeadInboxBaseHost = {
  supervisionRuntime: typeof import("./supervision.ts").supervisionRuntime;
  peerRuntime: PeerRuntime;
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
  listManagerDescriptors: typeof import("./supervision.ts").listManagerDescriptors;
  remoteChiefAgent: ReturnType<
    typeof createLeadIdentityRuntime
  >["remoteChiefAgent"];
  liveLead: ReturnType<typeof createLeadIdentityRuntime>["liveLead"];
  livePeerLead: ReturnType<
    typeof createLeadCoordinationRuntime
  >["livePeerLead"];
  readLeadCoordinationState: typeof import("./supervision.ts").readLeadCoordinationState;
  runHerdr: typeof import("./herdr.ts").runHerdr;
  sameRuntimeBuild: typeof import("./compatibility.ts").sameRuntimeBuild;
  worktreeGroupScope: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<WorktreeGroupScope>;
  readProjectAssignment: typeof import("./supervision.ts").readProjectAssignment;
  importResultBindings: typeof import("./agent-controller.ts").importResultBindings;
  resolvePeerResultBindings(
    ctx: ExtensionContext,
    bindings: readonly ResultBinding[],
  ): { bindings: ResultBinding[]; conflicts: ResultBinding[] };
  describePeerResultConflicts(conflicts: readonly ResultBinding[]): string;
  HERDSMAN_BUILD: RuntimeBuild;
  formatRuntimeBuild: typeof import("./compatibility.ts").formatRuntimeBuild;
  listChiefMessagePaths: typeof import("./supervision.ts").listChiefMessagePaths;
  chiefMessageQuarantined: typeof import("./supervision.ts").chiefMessageQuarantined;
  drainCoordinationInbox: typeof import("./supervision.ts").drainCoordinationInbox;
  basename: typeof import("node:path").basename;
};

type LeadInboxHost = LeadInboxBaseHost & {
  projectAssignmentInstruction(
    assignment: Pick<ProjectAssignment, "text">,
  ): string;
  leadRuntime: LeadRuntimeState;
  leadInstanceId(): string;
  controllerScope: ControllerScope;
  activeRole(): SessionRole;
  pi: ExtensionAPI;
  coordinationHealthy(): boolean;
  managerDiagnostic(event: string, details?: Record<string, unknown>): void;
  managerDiagnosticEvents: ReadonlySet<string>;
  assignmentDelivered?(ctx: ExtensionContext): void;
  isCurrentChief(ctx: ExtensionContext): boolean;
  prepareSupervisionMessage(
    ctx: ExtensionContext,
  ): Promise<
    { customType: string; content: string; display: boolean } | undefined
  >;
  authorizePeerRecord(
    record: PeerLeadRecord,
    ctx: ExtensionContext,
  ): Promise<boolean>;
  peerContext(
    record: PeerLeadRecord,
    ctx: ExtensionContext,
    assignmentSnapshot?: Map<
      string,
      import("./supervision.ts").GlobalProjectAssignment[]
    >,
    requireFreshGroup?: boolean,
  ): Promise<import("./supervision.ts").PeerContext | undefined>;
  assertCurrentLeadCoordination(ctx: ExtensionContext): void;
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
  currentManager: LeadRoleTransitionRuntime["currentManager"];
  workspaceId(): string | undefined;
  managerForScope: LeadRoleTransitionRuntime["managerForScope"];
  currentWorktreeScope: LeadRoleTransitionRuntime["currentWorktreeScope"];
  projectAssignmentForScope: LeadRoleTransitionRuntime["projectAssignmentForScope"];
  resolveEffectiveSupervisor: LeadRoleTransitionRuntime["resolveEffectiveSupervisor"];
  currentPeerPresenceValid(ctx: ExtensionContext): Promise<boolean>;
  drainProjectMessages(ctx: ExtensionContext): Promise<number>;
  reconcileRemotePeers?(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<void>;
};

type LeadSupervisionHost = {
  activeRole(): SessionRole;
  build: RuntimeBuild;
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
  contextType: string;
  currentChief: LeadRoleTransitionRuntime["currentChief"];
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
  currentManager: LeadRoleTransitionRuntime["currentManager"];
  resolveEffectiveSupervisor: LeadRoleTransitionRuntime["resolveEffectiveSupervisor"];
  formatContext: typeof import("./presentation.ts").formatSupervisionContext;
  formatSupervisionNotification: typeof import("./presentation.ts").formatSupervisionNotification;
  herdrSessionId: typeof import("./herdr.ts").herdrSessionId;
  herdrSessionSnapshot: typeof import("./herdr.ts").herdrSessionSnapshot;
  isCurrentChief(ctx: ExtensionContext): boolean;
  isPiAgent(agent: HerdrRecord): boolean;
  latestMessageText(ctx: ExtensionContext): Promise<string | undefined>;
  listAllHerdrAgents: typeof import("./herdr.ts").listAllHerdrAgents;
  listManagerDescriptors: typeof import("./supervision.ts").listManagerDescriptors;
  listProjectAssignments: typeof import("./supervision.ts").listProjectAssignments;
  loadSnapshot?(
    ctx: ExtensionContext,
    inventory?: HerdrSessionSnapshot,
    agents?: ManagedAgentSnapshotCollection,
    includeAll?: boolean,
  ): Promise<SupervisionSnapshot>;
  managedAgentSnapshots(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    proveLead?: boolean,
    allWorkspaces?: boolean,
    inventory?: HerdrSessionSnapshot,
    allowTranscriptDefinitionFallback?: boolean,
  ): Promise<ManagedAgentSnapshotCollection>;
  managerSupervisionItems: typeof import("./presentation.ts").managerSupervisionItems;
  normalizeHerdrLifecycleState: typeof import("./supervision.ts").normalizeHerdrLifecycleState;
  orderedSupervisionLeads: typeof import("./presentation.ts").orderedSupervisionLeads;
  persistedTranscriptReady(state: ManagedAgentState): boolean;
  pi: ExtensionAPI;
  presentationReports: typeof import("./presentation.ts").supervisionPresentationReports;
  projectSupervision: typeof import("./supervision.ts").projectSupervision;
  projectWorkSnapshot: typeof import("./supervision.ts").projectWorkSnapshot;
  reconcileProjectAssignments?(
    ctx: ExtensionContext,
    repoKey: string,
    primaryWorkspaceId: string,
    sourceCheckoutPath: string,
    alreadyLocked?: boolean,
    onlyBranch?: string,
    retryLockContention?: boolean,
  ): Promise<void>;
  readChiefDescriptor: typeof import("./supervision.ts").readChiefDescriptor;
  readLeadCoordinationState: typeof import("./supervision.ts").readLeadCoordinationState;
  remoteChiefAgent: LeadIdentityRuntime["remoteChiefAgent"];
  runHerdr: typeof runHerdr;
  sameChiefDescriptor: typeof import("./supervision.ts").sameChiefDescriptor;
  sameManagerDescriptor: typeof import("./supervision.ts").sameManagerDescriptor;
  state: LeadRuntimeState;
  supervisedSessionFile(
    agent: HerdrRecord,
    sessionId: string,
  ): string | undefined;
  supervisionRuntime: typeof import("./supervision.ts").supervisionRuntime;
  statSync: typeof statSync;
  tui: {
    Container: typeof import("@earendil-works/pi-tui").Container;
    Key: typeof import("@earendil-works/pi-tui").Key;
    matchesKey: typeof import("@earendil-works/pi-tui").matchesKey;
    SelectList: typeof import("@earendil-works/pi-tui").SelectList;
    Text: typeof import("@earendil-works/pi-tui").Text;
  };
  workspacePresentationProvenance(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workspaceIds: readonly string[],
    workspaceCwds: ReadonlyMap<string, string>,
    signal?: AbortSignal,
    workspaces?: readonly HerdrRecord[],
  ): Promise<ReadonlyMap<string, WorkspaceProvenance>>;
  worktreeGroupScope: typeof import("./herdr.ts").worktreeGroupScope;
};
const LEAD_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LeadRuntimeState = {
  instanceId: string;
  chiefMode: "inactive" | "active" | "suspended";
  controllerRole: "lead" | "manager";
  roleSuspended: boolean;
  managerLease: ManagerLease | undefined;
  chiefLease: ChiefLease | undefined;
  leadContext: ExtensionContext | undefined;
  chiefModeGeneration: number;
  sessionGeneration: number;
  chiefActivationRollback: boolean;
};

export function createLeadRuntimeState(): LeadRuntimeState {
  return {
    instanceId: randomUUID(),
    chiefMode: "inactive",
    controllerRole: "lead",
    roleSuspended: false,
    managerLease: undefined,
    chiefLease: undefined,
    leadContext: undefined,
    chiefModeGeneration: 0,
    sessionGeneration: 0,
    chiefActivationRollback: false,
  };
}

export function createLeadToolState(
  getAllTools: () => readonly { name: string }[],
  ownedNames: readonly string[],
  leadCoordinationNames: readonly string[],
) {
  const ownedTools = new Set(ownedNames);
  let leadTools: string[] | undefined;
  const registeredToolNames = () =>
    new Set(getAllTools().map((tool) => tool.name));
  const normalizeBaseTools = (tools: readonly string[]) => {
    const registered = registeredToolNames();
    return tools.filter(
      (name, index) =>
        !ownedTools.has(name) &&
        registered.has(name) &&
        tools.indexOf(name) === index,
    );
  };
  const appendRegisteredTools = (
    tools: readonly string[],
    names: readonly string[],
  ) => {
    const registered = registeredToolNames();
    const next = [...tools];
    for (const name of names)
      if (registered.has(name) && !next.includes(name)) next.push(name);
    return next;
  };
  const projectRoleTools = (
    baseline: readonly string[],
    definition: AgentDefinition,
    requiredTools: readonly string[],
  ) => {
    const policy = configuredToolPolicy(definition, requiredTools);
    const selected = policy.explicit
      ? policy.tools.flatMap((pattern) =>
          [...registeredToolNames()].filter((name) =>
            matchesToolPattern(pattern, name),
          ),
        )
      : [...baseline];
    const excluded = (name: string) =>
      policy.excluded.some((pattern) => matchesToolPattern(pattern, name));
    return appendRegisteredTools(
      normalizeBaseTools(selected.filter((name) => !excluded(name))),
      requiredTools,
    );
  };
  return {
    ownedTools,
    normalizeBaseTools,
    appendRegisteredTools,
    normalizeLeadTools: (tools: readonly string[]) =>
      appendRegisteredTools(normalizeBaseTools(tools), leadCoordinationNames),
    projectRoleTools,
    projectLeadTools: (
      baseline: readonly string[],
      definition: AgentDefinition,
    ) => projectRoleTools(baseline, definition, leadCoordinationNames),
    getLeadTools: () => leadTools,
    setLeadTools: (tools: string[] | undefined) => {
      leadTools = tools ? normalizeBaseTools(tools) : undefined;
    },
  };
}

const sameToolSelection = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((name, i) => name === right[i]);

export type LeadExecutionSessionState = Readonly<{
  mode: LeadExecutionMode;
  leadTools: readonly string[];
}>;

export function sessionLeadExecutionState(
  entries: readonly unknown[],
  sessionId: string,
): LeadExecutionSessionState | undefined {
  let state: LeadExecutionSessionState | undefined;
  for (const candidate of entries as readonly any[]) {
    if (
      candidate?.type !== "custom" ||
      candidate.customType !== "pi-herdsman-lead-execution" ||
      candidate.data?.sessionId !== sessionId
    )
      continue;
    const data = candidate.data;
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).length !== 3 ||
      !Object.hasOwn(data, "mode") ||
      !Object.hasOwn(data, "leadTools") ||
      !isLeadExecutionMode(data.mode) ||
      !Array.isArray(data.leadTools) ||
      data.leadTools.some(
        (name: unknown) => typeof name !== "string" || !name.trim(),
      ) ||
      new Set(data.leadTools).size !== data.leadTools.length
    )
      throw new Error("invalid pi-herdsman-lead-execution entry");
    state = { mode: data.mode, leadTools: [...data.leadTools] };
  }
  return state;
}

type LeadController = ReturnType<typeof createAgentController>;
type LeadRoleTransitionRuntime = ReturnType<typeof createLeadRoleTransitions>;
type LeadInboxRuntime = ReturnType<typeof createLeadInboxRuntime>;
type LeadStatusRuntime = ReturnType<typeof createAgentStatusRuntime>;
type LeadHerdRunRuntime = ReturnType<typeof createLeadHerdRunRuntime>;
type LeadProjectRuntime = ReturnType<typeof createLeadProjectRuntime>;
type LeadSupervisionRuntime = ReturnType<typeof createLeadSupervisionRuntime>;

export function createLeadShutdownRuntime(host: {
  roleTransitions: Pick<
    LeadRoleTransitionRuntime,
    "beginShutdownRole" | "shutdownRole" | "clearLeadContext"
  >;
  clearStartupDefinitionRoster(): void;
  leadInboxRuntime: Pick<LeadInboxRuntime, "beginShutdown" | "shutdown">;
  drainLeadMetadata(): Promise<void>;
  controller: Pick<
    LeadController,
    | "abortSession"
    | "clearPendingStarts"
    | "clearSession"
    | "markSessionInactive"
    | "stopHealthScanner"
    | "shutdown"
  >;
  leadStatusRuntime: Pick<LeadStatusRuntime, "shutdown">;
  clearSupervisionUI(): void;
  isRoot(): boolean;
  herdRun: Pick<LeadHerdRunRuntime, "shutdown">;
}) {
  const isRoot = () => host.isRoot();
  let shutDown = false;
  return {
    async shutdown(_ctx: ExtensionContext): Promise<void> {
      if (shutDown) return;
      shutDown = true;
      host.roleTransitions.beginShutdownRole();
      host.clearStartupDefinitionRoster();
      host.leadInboxRuntime.beginShutdown();
      host.controller.abortSession();
      host.roleTransitions.shutdownRole();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          host.drainLeadMetadata(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      host.leadInboxRuntime.shutdown();
      host.controller.clearPendingStarts();
      host.controller.clearSession();
      host.leadStatusRuntime.shutdown();
      host.controller.markSessionInactive();
      host.controller.stopHealthScanner();
      host.clearSupervisionUI();
      host.roleTransitions.clearLeadContext();
      if (isRoot()) host.herdRun.shutdown();
      host.controller.shutdown();
    },
  };
}

export function createLeadSessionTreeRuntime(host: {
  controller: Pick<
    LeadController,
    "sessionActive" | "sessionTreeChanged" | "sessionSignal"
  >;
  roleTransitions: Pick<
    LeadRoleTransitionRuntime,
    "branchRoleObservation" | "reconcileBranchRole"
  >;
  reconcileBranchExecution(ctx: ExtensionContext): Promise<void>;
  failClosedBranchExecution(ctx: ExtensionContext): void;
  isRoot(): boolean;
  appendRoleError(ctx: ExtensionContext, error: unknown): void;
}) {
  const isRoot = () => host.isRoot();
  return {
    async sessionTree(ctx: ExtensionContext): Promise<void> {
      if (!host.controller.sessionActive()) return;
      const watchActiveAsks = (): void => {
        host.controller.sessionTreeChanged(
          ctx,
          host.controller.sessionSignal(),
        );
      };
      // Ordinary Lead tree changes need synchronous ask watching before reconciliation.
      const roleAtTreeChange = host.roleTransitions.branchRoleObservation();
      if (roleAtTreeChange.watchBeforeReconcile) watchActiveAsks();
      if (isRoot()) {
        try {
          await host.reconcileBranchExecution(ctx);
        } catch (error) {
          host.appendRoleError(ctx, error);
          try {
            await host.roleTransitions.reconcileBranchRole(ctx);
          } catch (roleError) {
            host.appendRoleError(ctx, roleError);
          }
          host.failClosedBranchExecution(ctx);
          if (roleAtTreeChange.wasChief) watchActiveAsks();
          return;
        }
        try {
          await host.roleTransitions.reconcileBranchRole(ctx);
        } catch (error) {
          host.appendRoleError(ctx, error);
        }
      }
      if (roleAtTreeChange.wasChief) watchActiveAsks();
    },
  };
}

export function createLeadSessionStartRuntime(host: {
  prepareLeadExecution(
    ctx: ExtensionContext,
    signal: AbortSignal,
    skipProfileResolution?: boolean,
    skipAssignmentLookup?: boolean,
    roleDefinitions?: readonly AgentDefinition[],
  ): Promise<void>;
  discoverSessionDefinitions(ctx: ExtensionContext): Promise<{
    definitions: AgentDefinition[];
    roleDefinitions: AgentDefinition[];
    projectTrusted: boolean;
  }>;
  setLeadExecutionPending(pending: boolean): void;
  clearLeadExecution(): void;
  hasLeadExecutionState(ctx: ExtensionContext): boolean;
  diagnostic(): void;
  autoActivateManager(ctx: ExtensionContext): boolean;
  clearDefinitionRoster(): void;
  clearChiefStartPreflight(): void;
  roleTransitions: LeadRoleTransitionRuntime;
  isRoot(): boolean;
  isManagedAgent(): boolean;
  appendRoleError(ctx: ExtensionContext, error: unknown): void;
  initializeSessionKind?(
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<void>;
  sessionLeadRoleState(
    entries: readonly any[],
    sessionId: string,
  ): { role: SessionRole; leadTools: string[] } | undefined;
  normalizeBaseTools(tools: readonly string[]): string[];
  normalizeLeadTools(tools: readonly string[]): string[];
  setLeadTools(tools: string[] | undefined): void;
  activeTools(): string[];
  failClosedRole(ctx: ExtensionContext, error: unknown): Promise<void>;
  publishLeadRole(
    ctx: ExtensionContext,
    mode: "inactive" | "active" | "suspended",
    generation: number,
  ): void;
  activateChief(ctx: ExtensionContext, resumed: boolean): Promise<void>;
  restoreLeadExecution(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<void>;
  enterSuspended(ctx: ExtensionContext): void;
  enterLead(ctx: ExtensionContext): void;
  schedulePeerPresence(ctx: ExtensionContext): Promise<void>;
  controller: LeadController;
  leadInboxRuntime: LeadInboxRuntime;
  herdRun: Pick<LeadHerdRunRuntime, "restoreSession" | "finishIfIdle">;
  leadStatusRuntime: Pick<
    LeadStatusRuntime,
    "prepareSession" | "setSnapshot" | "start" | "requestRefresh" | "prime"
  >;
  clearSupervisionUI(reset?: boolean): void;
  queueLeadPresentation(ctx: ExtensionContext): void;
  setOwnTools(tools: string[] | undefined): void;
  initialStatusBreadcrumb(): BreadcrumbSegment[];
  ownToolsSnapshot(): { ownTools?: string[] };
  startSupervisionUI(ctx: ExtensionContext): void;
  setDefinitionRoster(roster: {
    sessionId: string;
    definitions: Record<string, unknown>[];
  }): void;
  visibleAgentCapabilities(
    ctx: ExtensionContext,
    definitions?: AgentDefinition[],
    rootPolicy?: RootDelegationPolicy,
  ): Promise<Record<string, unknown>[]>;
  rootDelegationPolicy?(): RootDelegationPolicy;
  appendDefinitionError(ctx: ExtensionContext, error: unknown): void;
}) {
  const isRoot = () => host.isRoot();
  return {
    async sessionStart(ctx: ExtensionContext): Promise<void> {
      host.diagnostic();
      host.controller.abortSession();
      host.leadInboxRuntime.beginSession();
      host.controller.clearPendingStarts();
      host.leadStatusRuntime.prepareSession(ctx);
      if (isRoot()) {
        host.clearLeadExecution();
        host.setLeadExecutionPending(true);
        // Start the first inventory read before delegation can race it.
        host.leadStatusRuntime.prime(ctx);
      }
      const sessionSignal = host.controller.beginSession();
      host.controller.sessionStart();
      host.clearDefinitionRoster();
      host.clearChiefStartPreflight();
      const resetRole = host.roleTransitions.beginSessionRole(ctx);
      const { previousChiefMode, previousControllerRole, lifecycleError } =
        resetRole instanceof Promise ? await resetRole : resetRole;
      if (sessionSignal.aborted) return;
      if (
        previousChiefMode === "active" ||
        previousControllerRole === "manager"
      )
        host.clearSupervisionUI(true);
      if (lifecycleError) host.appendRoleError(ctx, lifecycleError);
      let skipLeadExecutionProfileResolution = false;
      let malformedRole = false;
      if (isRoot()) {
        const sessionId = ctx.sessionManager.getSessionId();
        try {
          await host.initializeSessionKind?.(ctx, sessionSignal);
        } catch (error) {
          malformedRole = true;
          await host.failClosedRole(ctx, error);
        }
        if (sessionSignal.aborted) return;
        host.herdRun.restoreSession(ctx.sessionManager.getEntries(), sessionId);
        let persistedRole: SessionRole = "lead";
        let hasPersistedRole = false;
        try {
          const persisted = host.sessionLeadRoleState(
            ctx.sessionManager.getBranch(),
            sessionId,
          );
          if (persisted) {
            hasPersistedRole = true;
            persistedRole = persisted.role;
            if (!host.hasLeadExecutionState(ctx)) {
              const activeBaseline = host.normalizeBaseTools(
                host.activeTools(),
              );
              host.setLeadTools(
                persisted.role === "lead" &&
                  activeBaseline.some(
                    (name: string) => !host.ownedTools().has(name),
                  )
                  ? activeBaseline
                  : [...persisted.leadTools],
              );
            }
          } else if (!host.hasLeadExecutionState(ctx)) {
            host.setLeadTools(host.normalizeBaseTools(host.activeTools()));
          }
        } catch (error) {
          malformedRole = true;
          await host.failClosedRole(ctx, error);
          if (sessionSignal.aborted) return;
        }
        skipLeadExecutionProfileResolution = persistedRole === "chief";
        host.roleTransitions.reconcileRoleTools();
        let optionalManager = false;
        if (!hasPersistedRole && !malformedRole) {
          try {
            optionalManager = host.autoActivateManager(ctx);
          } catch (error) {
            host.appendRoleError(ctx, error);
          }
        }
        let leadStateRestored = false;
        let leadStateValid = !optionalManager;
        if (optionalManager && host.roleTransitions.canRestoreChiefState()) {
          leadStateValid = host.roleTransitions.restoreChiefState(ctx);
          leadStateRestored = true;
          if (!leadStateValid) malformedRole = true;
        }
        try {
          await host.roleTransitions.resolveControllerRole(
            ctx,
            persistedRole,
            optionalManager && leadStateValid,
          );
        } catch (error) {
          if (sessionSignal.aborted) return;
          host.appendRoleError(ctx, error);
        }
        if (sessionSignal.aborted) return;
        if (optionalManager && leadStateValid)
          host.roleTransitions.finalizeOptionalManagerStartup(ctx);
        if (
          !leadStateRestored &&
          !malformedRole &&
          host.roleTransitions.canRestoreChiefState() &&
          !host.roleTransitions.restoreChiefState(ctx)
        )
          malformedRole = true;
        if (malformedRole) host.roleTransitions.suspendMalformedRole(ctx);
        if (host.roleTransitions.shouldRestoreChief(persistedRole)) {
          try {
            await host.activateChief(ctx, true);
            if (sessionSignal.aborted) return;
            const generation = host.roleTransitions.activeChiefGeneration();
            if (generation !== undefined)
              host.publishLeadRole(ctx, "active", generation);
          } catch (error) {
            if (sessionSignal.aborted) return;
            if (error instanceof ProcessLockOccupiedError) {
              host.enterSuspended(ctx);
            } else {
              host.appendRoleError(ctx, error);
              if (!host.roleTransitions.consumeChiefActivationRollback()) {
                await host.restoreLeadExecution(ctx, sessionSignal);
                if (sessionSignal.aborted) return;
                host.enterLead(ctx);
              }
            }
          }
        } else if (!malformedRole) {
          try {
            host.roleTransitions.reconcileRoleTools();
          } catch (error) {
            host.appendRoleError(ctx, error);
          }
        }
        if (
          !sessionSignal.aborted &&
          !malformedRole &&
          host.roleTransitions.mayPublishLeadPresence()
        )
          await host.schedulePeerPresence(ctx);
        if (sessionSignal.aborted) return;
      }
      if (
        isRoot() &&
        process.env.HERDR_SOCKET_PATH &&
        host.roleTransitions.canStartChiefInbox()
      )
        host.leadInboxRuntime.start(ctx);
      if (
        isRoot() &&
        process.env.HERDR_PANE_ID &&
        host.roleTransitions.chiefModeInactive()
      )
        host.queueLeadPresentation(ctx);
      host.setOwnTools(host.isManagedAgent() ? host.activeTools() : undefined);
      host.leadStatusRuntime.setSnapshot({
        agents: [],
        stale: false,
        unavailable: true,
        breadcrumb: host.initialStatusBreadcrumb(),
        ...host.ownToolsSnapshot(),
      });
      const activeManager = isRoot() && host.roleTransitions.activeManager();
      if (activeManager && !sessionSignal.aborted) {
        try {
          await host.roleTransitions.reconcileCurrentManagerAssignments(ctx);
        } catch (error) {
          host.appendRoleError(ctx, error);
        }
      }
      if (
        isRoot() &&
        (host.roleTransitions.chiefModeActive() || activeManager)
      ) {
        host.startSupervisionUI(ctx);
      } else host.leadStatusRuntime.start(ctx);
      let definitionSnapshot:
        | {
            definitions: AgentDefinition[];
            roleDefinitions: AgentDefinition[];
          }
        | undefined;
      const needsLeadRoster = !(
        isRoot() &&
        (host.roleTransitions.chiefModeActive() || activeManager)
      );
      if (isRoot() && needsLeadRoster && !skipLeadExecutionProfileResolution) {
        try {
          definitionSnapshot = await host.discoverSessionDefinitions(ctx);
        } catch (error) {
          if (sessionSignal.aborted) return;
          host.appendDefinitionError(ctx, error);
          definitionSnapshot = { definitions: [], roleDefinitions: [] };
        }
      }
      if (sessionSignal.aborted) return;
      if (isRoot()) {
        try {
          await host.prepareLeadExecution(
            ctx,
            sessionSignal,
            skipLeadExecutionProfileResolution,
            malformedRole,
            definitionSnapshot?.roleDefinitions,
          );
        } finally {
          if (!sessionSignal.aborted) {
            host.setLeadExecutionPending(false);
            try {
              host.roleTransitions.reconcileRoleTools();
            } catch (error) {
              host.appendRoleError(ctx, error);
            }
            if (needsLeadRoster) host.leadStatusRuntime.requestRefresh();
          }
        }
      }
      if (sessionSignal.aborted) return;
      await host.leadInboxRuntime.cleanupManagedPeerInbox?.(ctx);
      if (sessionSignal.aborted) return;
      if (isRoot() && host.roleTransitions.chiefModeInactive())
        await host.publishLeadRole(
          ctx,
          "inactive",
          host.roleTransitions.currentRoleGeneration(),
        );
      if (needsLeadRoster) {
        try {
          const definitions = await host.visibleAgentCapabilities(
            ctx,
            definitionSnapshot?.definitions,
            isRoot()
              ? (host.rootDelegationPolicy?.() ?? new Set<string>())
              : "all",
          );
          if (sessionSignal.aborted) return;
          host.setDefinitionRoster({
            sessionId: ctx.sessionManager.getSessionId(),
            definitions,
          });
        } catch (error) {
          if (sessionSignal.aborted) return;
          host.clearDefinitionRoster();
          host.appendDefinitionError(ctx, error);
        }
      }
      if (host.isManagedAgent()) {
        host.leadStatusRuntime.requestRefresh();
        return;
      }
      if (sessionSignal.aborted) return;
      await host.controller.recoverRuntimes(ctx, sessionSignal);
      if (sessionSignal.aborted) return;
      if (isRoot()) host.herdRun.finishIfIdle(ctx);
      host.controller.startHealthScanner(ctx, sessionSignal);
    },
  };
}

export function createLeadAgentEventRuntime(host: {
  drainRetirementNotices(
    ctx: ExtensionContext,
    preflight: boolean,
  ): Promise<number>;
  isCurrentChief(ctx: ExtensionContext): boolean;
  setActiveTools(tools: readonly string[]): void;
  chiefTools: readonly string[];
  leadInboxRuntime: Pick<
    LeadInboxRuntime,
    "holdStartPreflight" | "agentSettled"
  >;
  prepareSupervisionMessage(
    ctx: ExtensionContext,
  ): Promise<
    { customType: string; content: string; display: boolean } | undefined
  >;
  sendMessage(message: {
    customType: string;
    content: string;
    display: boolean;
  }): void;
  chiefSystemPrompt(options: BuildSystemPromptOptions, body: string): string;
  isActiveManager(): boolean;
  roleCharter(ctx: ExtensionContext): string;
  currentChiefAllowedTools(
    ctx: ExtensionContext,
  ): readonly string[] | undefined;
  supervisoryProfileBody(
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): string;
  isActiveLead(): boolean;
  executionPrompt(): string | undefined;
  prepareLeadSupervisorStateMessage(
    ctx: ExtensionContext,
  ): Promise<
    { customType: string; content: string; display: boolean } | undefined
  >;
  definitionRoster():
    { sessionId: string; definitions: Record<string, unknown>[] } | undefined;
  isRoleSuspended(): boolean;
  consumeChiefStartPreflight(ctx: ExtensionContext): void;
  herdRun: Pick<
    LeadHerdRunRuntime,
    | "agentStarted"
    | "agentSettled"
    | "turnEnd"
    | "beforeSettle"
    | "hasActiveTurn"
  >;
  controller: Pick<
    LeadController,
    "settleAsks" | "sessionSignal" | "settleResults"
  >;
}) {
  return {
    async beforeAgentStart(
      event: any,
      ctx: ExtensionContext,
    ): Promise<{ systemPrompt: string } | undefined> {
      if (host.isCurrentChief(ctx)) {
        host.setActiveTools(
          host.currentChiefAllowedTools(ctx) ?? host.chiefTools,
        );
        host.leadInboxRuntime.holdStartPreflight(ctx);
        const message = await host.prepareSupervisionMessage(ctx);
        if (message) host.sendMessage(message);
        return {
          systemPrompt: host.chiefSystemPrompt(
            event.systemPromptOptions,
            host.supervisoryProfileBody(ctx, "chief"),
          ),
        };
      }
      event.systemPromptOptions ??= {};
      const sections = (event.systemPromptOptions.sections ??= {});
      sections.pi_herdsman_role = host.roleCharter(ctx);
      if (host.isActiveManager()) {
        delete sections.pi_herdsman_lead_execution;
        delete sections.agent_definitions;
        const message = await host.prepareSupervisionMessage(ctx);
        if (message) host.sendMessage(message);
        await host.drainRetirementNotices(ctx, true);
        return;
      }
      const activeLead = host.isActiveLead() && !host.isRoleSuspended();
      const supervisorStateMessage = activeLead
        ? await host.prepareLeadSupervisorStateMessage(ctx)
        : undefined;
      if (supervisorStateMessage) host.sendMessage(supervisorStateMessage);
      const roster = activeLead ? host.definitionRoster() : undefined;
      const prompt = activeLead ? host.executionPrompt() : undefined;
      if (prompt) sections.pi_herdsman_lead_execution = prompt;
      else delete sections.pi_herdsman_lead_execution;
      if (roster && roster.sessionId === ctx.sessionManager.getSessionId())
        sections.agent_definitions =
          `${JSON.stringify(roster.definitions)}\n\n` +
          `This is the session-start definition snapshot. ` +
          `Use list_agents for live Agent state or to refresh Agent definitions after configuration changes.`;
      else delete sections.agent_definitions;
      return;
    },
    agentStart(ctx: ExtensionContext): void {
      host.consumeChiefStartPreflight(ctx);
      if (host.isActiveLead()) host.herdRun.agentStarted();
    },
    async agentSettled(ctx: ExtensionContext, aborted: boolean): Promise<void> {
      host.leadInboxRuntime.agentSettled();
      host.controller.settleAsks(ctx, host.controller.sessionSignal());
      try {
        if (host.isActiveLead() || host.herdRun.hasActiveTurn())
          await host.herdRun.agentSettled(ctx, aborted);
      } finally {
        await host.controller
          .settleResults(ctx, host.controller.sessionSignal())
          .catch(() => {});
      }
    },
    toolCall(
      event: any,
      ctx: ExtensionContext,
    ): { block: true; reason: string } | undefined {
      if (
        !host.isCurrentChief(ctx) ||
        (host.currentChiefAllowedTools(ctx) ?? host.chiefTools).includes(
          event.toolName,
        )
      )
        return undefined;
      return {
        block: true,
        reason: "Tool is unavailable in the active Chief profile.",
      };
    },
  };
}

export function registerLeadRuntime(
  pi: ExtensionAPI,
  options: LeadRuntimeOptions,
) {
  const statusRuntime = createAgentStatusRuntime();
  const leadRuntime = options.leadRuntime ?? createLeadRuntimeState();
  const leadToolState =
    options.leadToolState ??
    createLeadToolState(
      () => pi.getAllTools(),
      options.ownedToolNames,
      options.leadCoordinationToolNames,
    );
  options.leadRuntime = leadRuntime;
  options.leadToolState = leadToolState;
  options.onLeadRuntimeReady?.(leadRuntime, leadToolState);
  let leadExecution:
    | {
        mode: LeadExecutionMode;
        definition: AgentDefinition;
        valid: true;
        managed: boolean;
      }
    | { mode: LeadExecutionMode; valid: false; managed: boolean }
    | undefined;
  let sessionKind: SessionKindEntry | undefined;
  let managedLifecycle: "assigned" | "unavailable" | "retired" = "unavailable";
  let assignmentVerificationGeneration = 0;
  let leadExecutionPending = false;
  let startupTools: string[] = [];
  let startupWasManaged = false;
  let supervisoryProfile: SupervisoryProfile | undefined;
  let inheritedProjection:
    { mode: LeadExecutionMode; excluded: readonly string[] } | undefined;
  const prepareSupervisoryProfile = (
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): SupervisoryProfile => {
    const name =
      role === "manager" ? MANAGER_DEFINITION_NAME : CHIEF_DEFINITION_NAME;
    const definition = options.commandHost.discoverRoleDefinition(
      name,
      ctx.isProjectTrusted() ? { projectRoot: ctx.cwd } : {},
    );
    const prepared = {
      ...definition,
      body: expandAgentBodyFiles(definition.body, [], `${role} role profile`),
    };
    const baseline =
      role === "manager"
        ? (leadToolState.getLeadTools() ??
          leadToolState.normalizeBaseTools(pi.getActiveTools()))
        : [];
    return {
      role,
      definition: prepared,
      tools: leadToolState.projectRoleTools(baseline, prepared, [
        ...(role === "manager"
          ? options.roleTransitionHost.managerTools
          : options.roleTransitionHost.chiefTools),
        ...supervisoryAgentTools(ctx, prepared),
      ]),
      sessionId: ctx.sessionManager.getSessionId(),
      valid: true,
    };
  };
  const fallbackSupervisoryProfile = (
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): SupervisoryProfile => ({
    role,
    definition: {
      name:
        role === "manager" ? MANAGER_DEFINITION_NAME : CHIEF_DEFINITION_NAME,
      path: "",
      frontmatter: {},
      body: "",
    },
    tools: leadToolState.appendRegisteredTools(
      [],
      role === "manager"
        ? options.roleTransitionHost.managerTools
        : options.roleTransitionHost.chiefTools,
    ),
    sessionId: ctx.sessionManager.getSessionId(),
    valid: false,
  });
  const commitSupervisoryProfile = (
    profile: SupervisoryProfile | undefined,
  ) => {
    supervisoryProfile = profile;
  };
  const currentSupervisoryProfile = (
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ) =>
    supervisoryProfile?.role === role &&
    supervisoryProfile.sessionId === ctx.sessionManager.getSessionId()
      ? supervisoryProfile
      : undefined;
  const hasOwnedRootAgents = (ctx: ExtensionContext): boolean => {
    try {
      const { states } = roleHost.scanAgentStates();
      return states.some(
        ({ state }) =>
          state.ownerSessionId === ctx.sessionManager.getSessionId(),
      );
    } catch {
      return false;
    }
  };
  const verifiedActiveRootRole = (role?: SessionRole) => {
    const state = options.leadRuntime!;
    const currentRole = activeLeadRole(state);
    if (
      state.roleSuspended ||
      !state.leadContext ||
      (role !== undefined && role !== currentRole)
    )
      return undefined;
    const sessionId = state.leadContext.sessionManager.getSessionId();
    if (currentRole === "lead" && state.controllerRole === "lead")
      return "lead" as const;
    if (currentRole === "manager" && state.managerLease) {
      try {
        const descriptor = roleHost.readManagerDescriptor(
          roleHost.supervisionRuntime(),
          state.managerLease.descriptor.workspaceId,
        );
        if (
          roleHost.sameManagerDescriptor(
            descriptor,
            state.managerLease.descriptor,
          ) &&
          descriptor.piSessionId === sessionId
        ) {
          const profile = currentSupervisoryProfile(
            state.leadContext,
            "manager",
          );
          if (profile?.valid) return "manager" as const;
        }
      } catch {}
    }
    if (
      currentRole === "chief" &&
      state.chiefMode === "active" &&
      state.chiefLease
    ) {
      try {
        const descriptor = roleHost.readChiefDescriptor(
          roleHost.supervisionRuntime().descriptor,
        );
        if (
          roleHost.sameChiefDescriptor(
            descriptor,
            state.chiefLease.descriptor,
          ) &&
          roleHost.chiefLeaseIsHeld(roleHost.supervisionRuntime()) &&
          descriptor.piSessionId === sessionId
        ) {
          const profile = currentSupervisoryProfile(state.leadContext, "chief");
          if (profile?.valid) return "chief" as const;
        }
      } catch {}
    }
    return undefined;
  };
  const activeRootRoleForPresentation = () =>
    verifiedActiveRootRole() as "lead" | "manager" | "chief" | undefined;
  const rootDelegationPolicy = (): RootDelegationPolicy => {
    const role = verifiedActiveRootRole();
    if (
      !sessionKind ||
      (sessionKind.kind === "managed" && managedLifecycle !== "assigned")
    )
      return new Set<string>();
    if (role === "lead") return "all";
    if (role === "manager" || role === "chief") {
      const profile = currentSupervisoryProfile(
        options.leadRuntime!.leadContext!,
        role,
      );
      if (profile?.valid) {
        try {
          validateSupervisorAgentDefinitionReferences(
            profile.definition,
            discoverAgentDefinitions(
              options.leadRuntime!.leadContext!.isProjectTrusted()
                ? { projectRoot: options.leadRuntime!.leadContext!.cwd }
                : {},
            ),
          );
          return new Set(profile.definition.frontmatter.agents ?? []);
        } catch (error) {
          options.sessionStartOptions.appendDefinitionError(
            options.leadRuntime!.leadContext!,
            error,
          );
        }
      }
    }
    return new Set<string>();
  };
  const rootDelegationGeneration = (): RootDelegationGeneration => {
    const state = options.leadRuntime!;
    const ctx = state.leadContext;
    const role = verifiedActiveRootRole();
    return {
      sessionId: ctx?.sessionManager.getSessionId() ?? "",
      roleGeneration: state.chiefModeGeneration,
      role,
      authority:
        role === "manager"
          ? state.managerLease
          : role === "chief"
            ? state.chiefLease
            : undefined,
      profile:
        role === "manager" || role === "chief"
          ? currentSupervisoryProfile(ctx!, role)
          : undefined,
    };
  };
  const ownedAgentManagementTools = (ctx: ExtensionContext): string[] =>
    hasOwnedRootAgents(ctx)
      ? AGENT_COORDINATION_TOOLS.filter(
          (name) => name !== "delegate_agent" && name !== "continue_agent",
        )
      : [];
  const supervisoryAgentTools = (
    ctx: ExtensionContext,
    definition: AgentDefinition,
  ): string[] => {
    const discovery = definition.frontmatter.agents?.length
      ? ["list_agents", "delegate_agent", "continue_agent"]
      : [];
    const management = ownedAgentManagementTools(ctx);
    return [...new Set([...discovery, ...management])];
  };
  const supervisoryTools = (
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): string[] | undefined => {
    const profile = currentSupervisoryProfile(ctx, role);
    if (!profile) return undefined;
    const permitted = new Set(
      supervisoryAgentTools(ctx, profile.definition).filter((name) => {
        if (name !== "delegate_agent" && name !== "continue_agent") return true;
        const policy = rootDelegationPolicy();
        return policy === "all" || policy.size > 0;
      }),
    );
    const tools = profile.tools.filter(
      (name) =>
        !(AGENT_COORDINATION_TOOLS as readonly string[]).includes(name) ||
        permitted.has(name),
    );
    for (const name of permitted) if (!tools.includes(name)) tools.push(name);
    return tools;
  };
  const persistLeadExecution = (
    mode: LeadExecutionMode,
    tools: readonly string[],
  ): void => {
    pi.appendEntry("pi-herdsman-lead-execution", {
      sessionId: sessionKind?.sessionId,
      mode,
      leadTools: [...tools],
    });
  };
  const captureInheritedTools = (): void => {
    const projection = inheritedProjection;
    if (!projection) return;
    if (sessionKind?.kind !== "ordinary") {
      inheritedProjection = undefined;
      return;
    }

    const saved = leadToolState.getLeadTools() ?? [];
    const excluded = (name: string) =>
      projection.excluded.some((pattern) => matchesToolPattern(pattern, name));
    const active = leadToolState
      .normalizeBaseTools(pi.getActiveTools())
      .filter((name) => !excluded(name));
    const next = leadToolState.normalizeBaseTools([
      ...active,
      ...saved.filter(excluded),
    ]);
    if (sameToolSelection(saved, next)) {
      inheritedProjection = undefined;
      return;
    }

    persistLeadExecution(projection.mode, next);
    leadToolState.setLeadTools(next);
    inheritedProjection = undefined;
  };
  let roleTransitions!: ReturnType<typeof createLeadRoleTransitions>;
  let identityRuntime!: ReturnType<typeof createLeadIdentityRuntime>;
  const liveAgent: typeof identityRuntime.liveAgent = (...args) =>
    identityRuntime.liveAgent(...args);
  const remoteChiefAgent: typeof identityRuntime.remoteChiefAgent = (...args) =>
    identityRuntime.remoteChiefAgent(...args);
  const liveLead: typeof identityRuntime.liveLead = (...args) =>
    identityRuntime.liveLead(...args);
  const coordinationServices = {
    withProjectAssignmentLock: <T>(
      repoKey: string,
      branch: string,
      operation: () => Promise<T> | T,
      signal?: AbortSignal,
    ) =>
      roleTransitions.withProjectAssignmentLock(
        repoKey,
        branch,
        operation,
        signal,
      ),
    ...options.coordinationHost,
    workspaceId: () => options.roleTransitionHost.workspaceId(),
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    currentWorktreeScope: (ctx: ExtensionContext) =>
      roleTransitions.currentWorktreeScope(ctx),
    currentProjectAssignment: (ctx: ExtensionContext) =>
      currentProjectAssignment(ctx),
    projectAssignmentForScope: (
      ...args: Parameters<typeof roleTransitions.projectAssignmentForScope>
    ) => roleTransitions.projectAssignmentForScope(...args),
    resolveEffectiveSupervisor: (
      ...args: Parameters<typeof roleTransitions.resolveEffectiveSupervisor>
    ) => roleTransitions.resolveEffectiveSupervisor(...args),
    publishProjectMessage: (
      ...args: Parameters<typeof roleTransitions.publishProjectMessage>
    ) => roleTransitions.publishProjectMessage(...args),
    currentChiefAuthority: (
      ...args: Parameters<typeof roleTransitions.currentChiefAuthority>
    ) => roleTransitions.currentChiefAuthority(...args),
    currentSupervisor: (
      ...args: Parameters<typeof roleTransitions.currentSupervisor>
    ) => roleTransitions.currentSupervisor(...args),
  };
  const coordinationRuntime = createLeadCoordinationRuntime({
    ...coordinationServices,
    pi,
    leadRuntime: options.leadRuntime,
    processRole: "lead",
    controllerScope: { kind: "root" },
    activeRole: () => activeLeadRole(options.leadRuntime),
    HERDSMAN_BUILD: options.build,
    leadInstanceId: () => options.leadRuntime.instanceId,
  });
  const supervisionUiRuntime = createLeadSupervisionRuntime({
    ...options.supervisionHost,
    build: options.build,
    state: options.leadRuntime,
    activeRole: () => activeLeadRole(options.leadRuntime),
    pi,
    isCurrentChief: (ctx: ExtensionContext) =>
      options.leadRuntime.chiefMode === "active" &&
      !!options.leadRuntime.chiefLease &&
      options.leadRuntime.chiefLease.descriptor.piSessionId ===
        ctx.sessionManager.getSessionId(),
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    resolveEffectiveSupervisor: (
      ...args: Parameters<typeof roleTransitions.resolveEffectiveSupervisor>
    ) => roleTransitions.resolveEffectiveSupervisor(...args),
    reconcileProjectAssignments: (
      ...args: Parameters<typeof roleTransitions.reconcileProjectAssignments>
    ) => roleTransitions.reconcileProjectAssignments(...args),
    currentChief: (...args: Parameters<typeof roleTransitions.currentChief>) =>
      roleTransitions.currentChief(...args),
    currentChiefAuthority: (
      ...args: Parameters<typeof roleTransitions.currentChiefAuthority>
    ) => roleTransitions.currentChiefAuthority(...args),
    latestMessageText: (ctx: ExtensionContext) =>
      coordinationRuntime.latestCustomMessageText(
        ctx,
        options.supervisionHost.contextType,
      ),
    persistedTranscriptReady: (target: ManagedAgentState) =>
      controllerPersistedTranscriptReady(target, (path) => {
        const file = (options.supervisionHost.statSync ?? statSync)(path, {
          throwIfNoEntry: false,
        });
        return !!file?.isFile() && file.size > 0;
      }),
  });
  const writeProjectAssignment = (
    ...args: Parameters<typeof options.projectHost.writeProjectAssignment>
  ) => {
    options.projectHost.writeProjectAssignment(...args);
    supervisionUiRuntime.requestRefresh();
  };
  const retireProjectAssignment = (
    ...args: Parameters<
      typeof options.roleTransitionHost.retireProjectAssignment
    >
  ) => {
    const retired = options.roleTransitionHost.retireProjectAssignment(...args);
    supervisionUiRuntime.requestRefresh();
    return retired;
  };
  const clearSupervisionUI = (removeWidget = true): void => {
    supervisionUiRuntime.stopPeriodic();
    if (removeWidget && leadRuntime.leadContext)
      supervisionUiRuntime.removeWidget(leadRuntime.leadContext);
  };
  const startSupervisionUI = (ctx: ExtensionContext): void => {
    statusRuntime.clear();
    clearSupervisionUI();
    supervisionUiRuntime.startPeriodic(ctx);
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      supervisionUiRuntime.registerWidget(
        ctx,
        activeLeadRole(leadRuntime) === "manager" ? "manager" : "chief",
      );
    } catch {
      return;
    }
    void supervisionUiRuntime.refresh(ctx);
  };
  let inboxRuntime: ReturnType<typeof createLeadInboxRuntime>;
  const managerDiagnosticEvents = new Set<string>();
  const managerDiagnosticAllowlist = new Set([
    "session_start_reached",
    "initial_inbox_drain_start",
    "project_assignment_authorization",
    "project_assignment_send",
    "project_assignment_scope_start",
    "project_assignment_scope_complete",
    "project_assignment_topology_start",
    "project_assignment_topology_complete",
    "project_assignment_live_lead_start",
    "project_assignment_live_lead_complete",
    "inbox_preflight",
    "inbox_preflight_recheck",
    "inbox_peer_presence",
    "inbox_candidates",
    "inbox_drain_complete",
    "inbox_catch",
  ]);
  const managerDiagnostic = (
    event: string,
    details: Record<string, boolean | string | number> = {},
  ): void => {
    if (
      process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS !== "1" ||
      !managerDiagnosticAllowlist.has(event) ||
      managerDiagnosticEvents.has(event) ||
      managerDiagnosticEvents.size >= 16
    )
      return;
    managerDiagnosticEvents.add(event);
    console.error(
      `[pi-herdsman-manager-diagnostic] ${JSON.stringify({ event, ...details })}`,
    );
  };
  const roleHost = options.roleTransitionHost;
  const effectiveLeadRole = () =>
    leadRuntime.chiefMode === "active"
      ? "chief"
      : leadRuntime.controllerRole === "manager" && !leadRuntime.roleSuspended
        ? "manager"
        : leadRuntime.roleSuspended
          ? undefined
          : "lead";
  let leadMetadataQueue = Promise.resolve();
  let tabRenameQueue = Promise.resolve();
  let tabRenameRevision = 0;
  let ownedTab: { tabId: string; label: string } | undefined;
  let reportedTabRenameFailure: string | undefined;
  let reportedRoleMetadataFailure: string | undefined;
  const presentationCurrent = (generation: number) =>
    controller.sessionActive() && generation === leadRuntime.sessionGeneration;
  const publishLeadRole = (
    ctx: ExtensionContext,
    _mode: "inactive" | "active" | "suspended",
    generation: number,
  ): Promise<void> => {
    if (!controller.sessionActive()) return Promise.resolve();
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionGeneration = leadRuntime.sessionGeneration;
    const failureKey = `${sessionId}:${sessionGeneration}:${generation}`;
    const current = () =>
      presentationCurrent(sessionGeneration) &&
      generation === leadRuntime.chiefModeGeneration;
    leadMetadataQueue = leadMetadataQueue
      .catch(() => {})
      .then(async () => {
        if (!current()) return;
        const paneId = roleHost.paneId();
        if (!paneId) return;
        const role = effectiveLeadRole();
        const leadName =
          role === "lead" ? roleHost.getSessionName()?.trim() : undefined;
        const args = [
          "pane",
          "report-metadata",
          paneId,
          "--source",
          "pi-herdsman:lead",
          "--title",
          role === "chief"
            ? "chief"
            : role === "manager"
              ? "Pi Herdsman manager"
              : leadName || "Pi Herdsman lead",
          ...(role
            ? ["--token", `pi_herdsman_role=${role}`]
            : ["--clear-token", "pi_herdsman_role"]),
        ];
        if (role === "lead")
          args.push(
            leadName ? "--token" : "--clear-token",
            leadName ? `pi_herdsman_name=${leadName}` : "pi_herdsman_name",
          );
        else
          args.push(
            "--clear-token",
            "pi_herdsman_name",
            "--clear-token",
            "pi_herdsman_ask",
          );
        if (role !== "lead")
          args.push(
            "--clear-token",
            "pi_herdsman_herd_run_started_at",
            "--clear-token",
            "pi_herdsman_context_percent",
          );
        await roleHost.runHerdr(pi, ctx, args, {
          noResult: true,
          timeout: 10_000,
        });
        if (!current()) return;
        reportedRoleMetadataFailure = undefined;
      })
      .catch((error) => {
        if (!current()) return;
        if (reportedRoleMetadataFailure === failureKey) return;
        reportedRoleMetadataFailure = failureKey;
        try {
          roleHost.appendDurableError(
            pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          );
        } catch {
          // Presentation diagnostics cannot change authority.
        }
      });
    scheduleTabRename(ctx, leadMetadataQueue);
    return leadMetadataQueue;
  };
  const scheduleTabRename = (
    ctx: ExtensionContext,
    afterMetadata: Promise<void>,
  ): void => {
    const revision = ++tabRenameRevision;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionGeneration = leadRuntime.sessionGeneration;
    const current = () =>
      revision === tabRenameRevision && presentationCurrent(sessionGeneration);
    tabRenameQueue = tabRenameQueue
      .catch(() => {})
      .then(async () => {
        await afterMetadata.catch(() => {});
        if (!current()) return;
        const role = effectiveLeadRole();
        if (!role) return;
        let label: string;
        if (role === "chief") label = "Chief";
        else if (role === "manager") label = "Manager";
        else {
          try {
            await currentProjectAssignment(ctx);
            label = sessionKind?.kind === "managed" ? "Managed Lead" : "Lead";
          } catch (error) {
            // A verified assignment is required to claim Managed Lead.
            if (!current()) return;
            options.sessionStartOptions.appendRoleError(ctx, error);
            label = sessionKind?.kind === "managed" ? "Managed Lead" : "Lead";
          }
        }
        if (!current()) return;
        const paneId = roleHost.paneId();
        if (!paneId) return;
        const paneResult = await roleHost.runHerdr(pi, ctx, [
          "pane",
          "get",
          paneId,
        ]);
        if (!current()) return;
        const pane = paneResult?.pane;
        if (
          !pane ||
          pane.pane_id !== paneId ||
          typeof pane.workspace_id !== "string" ||
          !pane.workspace_id ||
          typeof pane.tab_id !== "string" ||
          !pane.tab_id
        )
          return;
        const tabResult = await roleHost.runHerdr(pi, ctx, [
          "tab",
          "list",
          "--workspace",
          pane.workspace_id,
        ]);
        if (!current()) return;
        const tabs = tabResult?.tabs;
        if (!Array.isArray(tabs)) return;
        const tabIds = new Set<string>();
        if (
          tabs.some((entry: any) => {
            if (
              !entry ||
              typeof entry !== "object" ||
              typeof entry.tab_id !== "string" ||
              !entry.tab_id ||
              typeof entry.label !== "string" ||
              !entry.label ||
              tabIds.has(entry.tab_id)
            )
              return true;
            tabIds.add(entry.tab_id);
            return false;
          })
        )
          return;
        const index = tabs.findIndex((tab: any) => tab.tab_id === pane.tab_id);
        if (index < 0) return;
        const tab = tabs[index];
        if (typeof tab.label !== "string") return;
        if (tab.label === label) return;
        const previousLabel =
          ownedTab?.tabId === tab.tab_id ? ownedTab.label : undefined;
        // Herdr has no name provenance; canonical role labels may be reclaimed after restart.
        if (
          previousLabel !== undefined
            ? tab.label !== previousLabel
            : tab.label !== String(index + 1) &&
              !["Lead", "Managed Lead", "Manager", "Chief"].includes(tab.label)
        )
          return;
        if (!current()) return;
        await roleHost.runHerdr(pi, ctx, ["tab", "rename", tab.tab_id, label], {
          noResult: true,
          timeout: 10_000,
        });
        if (!presentationCurrent(sessionGeneration)) return;
        ownedTab = { tabId: tab.tab_id, label };
        if (current()) reportedTabRenameFailure = undefined;
      })
      .catch((error) => {
        if (!current()) return;
        const key = `${sessionId}:${sessionGeneration}`;
        if (reportedTabRenameFailure === key) return;
        reportedTabRenameFailure = key;
        try {
          roleHost.appendDurableError(
            pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          );
        } catch {
          // Tab presentation diagnostics cannot affect role transitions.
        }
      });
  };
  const queueLeadMetadata = (
    ctx: ExtensionContext,
    metadata: {
      paneId: string;
      name: string;
      herdRunStartedAt?: number;
      contextPercent?: number;
    },
  ): void => {
    if (!controller.sessionActive()) return;
    if (leadRuntime.controllerRole === "manager") {
      void publishLeadRole(
        ctx,
        leadRuntime.roleSuspended ? "suspended" : "inactive",
        leadRuntime.chiefModeGeneration,
      );
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionGeneration = leadRuntime.sessionGeneration;
    const current = () => presentationCurrent(sessionGeneration);
    leadMetadataQueue = leadMetadataQueue
      .catch(() => {})
      .then(() => {
        if (
          !current() ||
          leadRuntime.controllerRole !== "lead" ||
          leadRuntime.roleSuspended
        )
          return;
        return roleHost.reportLeadMetadata(pi, ctx, metadata).then(() => {
          if (!current()) return;
          reportedRoleMetadataFailure = undefined;
        });
      })
      .catch((error) => {
        if (!current()) return;
        const failureKey = `${sessionId}:${sessionGeneration}:${leadRuntime.chiefModeGeneration}`;
        if (reportedRoleMetadataFailure === failureKey) return;
        reportedRoleMetadataFailure = failureKey;
        try {
          roleHost.appendDurableError(
            pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          );
        } catch {
          // Presentation diagnostics cannot change authority.
        }
      });
  };
  const persistRole = (role: SessionRole): void => {
    captureInheritedTools();
    const tools = leadToolState.getLeadTools();
    if (!tools) throw new Error("Lead tool baseline is unavailable");
    if (!sessionKind) throw new Error("Session identity is unavailable");
    pi.appendEntry("pi-herdsman-role", {
      sessionId: sessionKind.sessionId,
      role,
      leadTools: [...tools],
    });
  };
  const leadEntryEffects: LeadEntryEffects = {
    advancePresenceGeneration: () =>
      coordinationRuntime.advancePresenceGeneration(),
    clearChiefStartPreflight: () => inboxRuntime.clearStartPreflight(),
    resetSupervisionSnapshot: () => supervisionUiRuntime.reset(),
    removePeerPresence: () => coordinationRuntime.removePeerPresence(),
    reconcileRoleTools: () => roleTransitions.reconcileRoleTools(),
    restoreLeadTools: () => pi.setActiveTools(executionTools()),
    persistRole,
    persistCoordinatorState: () =>
      coordinationRuntime.persistCoordinatorState(),
    coordinationHealthy: () => coordinationRuntime.coordinationHealthy(),
    schedulePeerPresence: (ctx) => {
      void coordinationRuntime.schedulePeerPresence(ctx);
    },
    publishLeadRole: (ctx, mode, generation) => {
      void publishLeadRole(ctx, mode, generation);
    },
    appendRoleError: (ctx, error) =>
      roleHost.appendDurableError(pi, ctx, "pi_herdsman_role_error", error),
  };
  const enterLead = (ctx?: ExtensionContext, persist = true): void =>
    enterLeadRole(leadRuntime, leadEntryEffects, ctx, persist);
  const enterChief = (
    ctx: ExtensionContext,
    lease: ChiefLease,
    generation: number,
  ): void =>
    enterChiefRole(leadRuntime, leadEntryEffects, ctx, lease, generation);
  const enterSuspended = (ctx?: ExtensionContext): void =>
    enterSuspendedRole(leadRuntime, leadEntryEffects, ctx);
  const executionTools = (): string[] => {
    const baseline = leadToolState.getLeadTools() ?? [];
    if (!sessionKind) return [];
    if (sessionKind.kind === "managed" && managedLifecycle !== "assigned")
      return options.leadRuntime?.leadContext
        ? ownedAgentManagementTools(options.leadRuntime.leadContext)
        : [];
    if (leadExecutionPending) return leadToolState.normalizeLeadTools([]);
    if (sessionKind.kind === "managed")
      return leadToolState.appendRegisteredTools(
        leadToolState.normalizeLeadTools(baseline),
        ["read_evidence"],
      );
    if (!leadExecution) return leadToolState.normalizeLeadTools(baseline);
    if (!leadExecution.valid) return leadToolState.normalizeLeadTools([]);
    return leadToolState.projectLeadTools(baseline, leadExecution.definition);
  };
  const activationGuard = (
    _sessionId: string,
    _role: "Chief" | "Manager",
  ): void => {
    if (
      !sessionKind ||
      sessionKind.sessionId !== _sessionId ||
      sessionKind.kind === "managed"
    )
      throw new Error(
        "Dedicated Managed Lead sessions cannot activate Manager or Chief.",
      );
    if (!coordinationRuntime.coordinationHealthy())
      throw new Error("Lead coordination state is unavailable");
  };
  const roleTransitionServices = {
    ...roleHost,
    prepareSupervisoryProfile,
    commitSupervisoryProfile,
    currentSupervisoryProfile,
    supervisoryTools,
    fallbackSupervisoryProfile,
    retireProjectAssignment,
    controllerScope: { kind: "root" },
    activationGuard,
    advancePeerPresenceGeneration: () =>
      coordinationRuntime.advancePresenceGeneration(),
    setCoordinationHealthy: (healthy: boolean) =>
      coordinationRuntime.setCoordinationHealthy(healthy),
    normalizeBaseTools: leadToolState.normalizeBaseTools,
    captureInheritedTools,
    inheritedProjection: () =>
      sessionKind?.kind === "ordinary" &&
      !leadExecutionPending &&
      leadExecution?.valid &&
      !leadExecution.managed &&
      leadExecution.definition.frontmatter.tools === undefined
        ? {
            mode: leadExecution.mode,
            excluded: configuredToolPolicy(leadExecution.definition, [])
              .excluded,
          }
        : undefined,
    setInheritedProjection: (projection) => {
      inheritedProjection = projection;
    },
    appendRegisteredTools: leadToolState.appendRegisteredTools,
    normalizeLeadTools: leadToolState.normalizeLeadTools,
    executionTools,
    restoreLeadExecution: (ctx: ExtensionContext) => restoreLeadExecution(ctx),
    ownedTools: () => leadToolState.ownedTools,
    getLeadTools: () => leadToolState.getLeadTools(),
    setLeadTools: (tools: string[] | undefined) =>
      leadToolState.setLeadTools(tools),
    currentChiefAuthority: (
      ...args: Parameters<typeof roleTransitions.currentChiefAuthority>
    ) => roleTransitions.currentChiefAuthority(...args),
    persistCoordinatorState: () =>
      coordinationRuntime.persistCoordinatorState(),
    persistRole,
    persistLeadCoordination: () =>
      coordinationRuntime.persistLeadCoordination(),
    assertCurrentLeadCoordination: (ctx: ExtensionContext) =>
      coordinationRuntime.assertCurrentLeadCoordination(ctx),
    coordinationHealthy: () => coordinationRuntime.coordinationHealthy(),
    schedulePeerPresence: (ctx: ExtensionContext) =>
      coordinationRuntime.schedulePeerPresence(ctx),
    removePeerPresence: () => coordinationRuntime.removePeerPresence(),
    clearNormalUI: () => statusRuntime.clear(),
    startNormalUI: (ctx: ExtensionContext) => statusRuntime.start(ctx),
    startSupervisionUI,
    clearSupervisionUI,
    publishLeadRole,
    activateChief: roleHost.activation.activateChief,
    enterLead,
    enterChief,
    waitForPeerPresence: () => coordinationRuntime.waitForPeerPresence(),
    markLeadCoordinationUnhealthy: (ctx?: ExtensionContext) =>
      coordinationRuntime.markLeadCoordinationUnhealthy(ctx),
    reconcileRoleTools: () => roleTransitions.reconcileRoleTools(),
    enterSuspended,
    resetSupervisionSnapshot: () => supervisionUiRuntime.reset(),
    focusExistingChief: (ctx: ExtensionContext) =>
      supervisionUiRuntime.focusChief(ctx),
  };
  roleTransitions = createLeadRoleTransitions(options.leadRuntime, {
    ...roleTransitionServices,
    invalidateManagerRemovalRequests: (ctx: ExtensionContext) =>
      projectRuntime.invalidatePendingRemovals(ctx),
    ownedAgentManagementTools,
    pi,
    leadInstanceId: () => options.leadRuntime.instanceId,
    setLeadInstanceId: (id: string) => {
      options.leadRuntime.instanceId = id;
    },
    clearChiefStartPreflight: () => inboxRuntime.clearStartPreflight(),
    advanceChiefInboxGeneration: () => inboxRuntime.advanceGeneration(),
    clearChiefInboxTimer: () => inboxRuntime.clearTimer(),
    startChiefInbox: (ctx: ExtensionContext) => inboxRuntime.start(ctx),
  });
  const inboxServices = {
    ...options.inboxHost,
    projectAssignmentInstruction,
    leadRuntime: options.leadRuntime,
    leadInstanceId: () => options.leadRuntime.instanceId,
    controllerScope: { kind: "root" },
    activeRole: () => activeLeadRole(options.leadRuntime),
    pi,
    coordinationHealthy: () => coordinationRuntime.coordinationHealthy(),
    managerDiagnostic,
    managerDiagnosticEvents,
    assignmentDelivered: (ctx: ExtensionContext) =>
      void publishLeadRole(ctx, "inactive", leadRuntime.chiefModeGeneration),
    isCurrentChief: (ctx: ExtensionContext) =>
      options.leadRuntime.chiefMode === "active" &&
      !!options.leadRuntime.chiefLease &&
      options.leadRuntime.chiefLease.descriptor.piSessionId ===
        ctx.sessionManager.getSessionId(),
    prepareSupervisionMessage: (ctx: ExtensionContext) =>
      supervisionUiRuntime.prepareMessage(ctx),
    livePeerLead: (...args) => coordinationRuntime.livePeerLead(...args),
    authorizePeerRecord: (record: ChiefMessageRecord, ctx: ExtensionContext) =>
      coordinationRuntime.authorizePeerRecord(record, ctx),
    peerContext: (
      record: PeerLeadRecord,
      ctx: ExtensionContext,
      assignmentSnapshot?: Map<
        string,
        import("./supervision.ts").GlobalProjectAssignment[]
      >,
      requireFreshGroup = false,
    ) =>
      coordinationRuntime.peerContext(
        record,
        ctx,
        assignmentSnapshot,
        requireFreshGroup,
      ),
    resolvePeerResultBindings: (
      ctx: ExtensionContext,
      bindings: readonly ResultBinding[],
    ) => coordinationRuntime.resolvePeerResultBindings(ctx, bindings),
    describePeerResultConflicts: (conflicts: readonly ResultBinding[]) =>
      coordinationRuntime.describePeerResultConflicts(conflicts),
    assertCurrentLeadCoordination: (ctx: ExtensionContext) =>
      coordinationRuntime.assertCurrentLeadCoordination(ctx),
    currentChiefAuthority: (
      ctx: ExtensionContext,
      failOnVerificationError = false,
    ) => roleTransitions.currentChiefAuthority(ctx, failOnVerificationError),
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    workspaceId: () => options.roleTransitionHost.workspaceId(),
    managerForScope: (
      ...args: Parameters<typeof roleTransitions.managerForScope>
    ) => roleTransitions.managerForScope(...args),
    currentWorktreeScope: (ctx: ExtensionContext) =>
      roleTransitions.currentWorktreeScope(ctx),
    projectAssignmentForScope: (
      ...args: Parameters<typeof roleTransitions.projectAssignmentForScope>
    ) => roleTransitions.projectAssignmentForScope(...args),
    resolveEffectiveSupervisor: (
      ...args: Parameters<typeof roleTransitions.resolveEffectiveSupervisor>
    ) => roleTransitions.resolveEffectiveSupervisor(...args),
    currentPeerPresenceValid: async (ctx: ExtensionContext) =>
      (sessionKind?.kind !== "managed" || managedLifecycle === "assigned") &&
      (await coordinationRuntime.currentPeerPresenceValid(ctx)),
    drainProjectMessages: (ctx: ExtensionContext) =>
      coordinationRuntime
        .drainRetirementNotices(ctx)
        .then(
          async (count) =>
            count + (await coordinationRuntime.drainProjectMessages(ctx)),
        ),
    reconcileRemotePeers: (ctx: ExtensionContext, signal?: AbortSignal) => {
      return activeLeadRole(options.leadRuntime) === "manager" ||
        activeLeadRole(options.leadRuntime) === "lead"
        ? coordinationRuntime.peerMessage(
            "remote-reconciliation",
            { action: "list", internal: true },
            signal,
            undefined,
            ctx,
          )
        : Promise.resolve();
    },
  };
  inboxRuntime = createLeadInboxRuntime(inboxServices);
  let herdRunRuntime: ReturnType<typeof createLeadHerdRunRuntime> | undefined;
  let statusWorktreeScope:
    | {
        sessionId: string;
        workspaceId: string;
        scope?: WorktreeGroupScope;
      }
    | undefined;
  let statusWorktreeScopeRequest:
    { sessionId: string; workspaceId: string } | undefined;
  const controller = createAgentController(pi, {
    ...options.controllerServices,
    scope: { kind: "root" },
    persistClosedDescendants: async (ctx, closures, selected) => {
      const persisted = await projectRuntime.persistNestedStopClosures(ctx, [
        ...closures,
        { state: selected, definition: "" },
      ]);
      return persisted === closures.length
        ? []
        : ["Some closed descendants lack safely persisted continuation proof"];
    },
    projectEvidence: async (ctx, signal) => {
      const operationSignal = signal ?? ctx.signal;
      if (
        activeLeadRole(options.leadRuntime) !== "lead" ||
        !leadExecution?.managed
      )
        return undefined;
      const assignment = await currentProjectAssignment(ctx);
      if (!assignment)
        throw new Error(
          "Managed project execution requires a current exact assignment",
        );
      const needsMigration = assignment.requiredEvidence?.some(
        (evidence) => !("result" in evidence) && !evidence.ref,
      );
      const migrated = needsMigration
        ? await migrateProjectAssignmentEvidenceAfter(
            options.coordinationHost.supervisionRuntime(),
            assignment,
            operationSignal,
          )
        : assignment;
      if (!migrated || migrated.id !== assignment.id)
        throw new Error(
          "Managed project execution requires a current exact assignment",
        );
      return {
        assignment: migrated,
        publishIfCurrent: (operation) =>
          withProjectAssignmentAuthorityWait(
            () =>
              operation(
                readProjectAssignment(
                  options.coordinationHost.supervisionRuntime(),
                  assignment.repoKey,
                  assignment.branch,
                ),
              ),
            operationSignal,
          ),
        revalidate: (operation: () => Promise<void> | void) =>
          roleTransitions.withProjectAssignmentLock(
            assignment.repoKey,
            assignment.branch,
            async () => {
              const current = await currentProjectAssignment(ctx);
              if (!current || current.id !== assignment.id)
                throw new Error(
                  "Project assignment changed during Agent startup; retry delegation",
                );
              await operation();
            },
            operationSignal,
          ),
      };
    },
    managedProjectEvidence: async (ctx, workspaceId, projectAssignmentId) => {
      return roleTransitions.projectEvidenceForWorkspace(
        ctx,
        workspaceId,
        projectAssignmentId,
      );
    },
    rootDelegationPolicy,
    rootDelegationGeneration,
    build: options.build,
    onChanged: () => {
      statusRuntime.requestRefresh();
      supervisionUiRuntime.requestRefresh();
      roleTransitions?.reconcileRoleTools();
    },
    onWorkChanged: (ctx: ExtensionContext) => herdRunRuntime?.maybeFinish(ctx),
    onWorktreeRemoved: (
      removed: RemovedHerdrWorktree,
      ctx: ExtensionContext,
      signal: AbortSignal,
    ) => {
      void roleTransitions
        .retireRemovedProjectWork(removed, ctx, signal)
        .then(async () => {
          await restoreLeadExecution(ctx, signal);
          if (!signal.aborted) roleTransitions.reconcileRoleTools();
        })
        .catch((error) =>
          options.controllerServices.appendError(
            ctx,
            "pi_herdsman_state_error",
            error,
          ),
        );
    },
  });
  identityRuntime = createLeadIdentityRuntime({
    ...options.identityHost,
    leadController: controller,
    hasLeadCoordination: options.identityHost.hasLeadCoordination,
  });
  const loadStatusSnapshot = async (
    ctx: ExtensionContext,
    signal = controller.sessionSignal(),
    allowTranscriptDefinitionFallback = true,
    runtimeForLabel: (label: string) => Runtime | undefined = (label) =>
      controller.runtimeForLabel(label),
  ): Promise<StatusSnapshot> => {
    let assignment: ProjectAssignment | undefined;
    const isLead =
      roleTransitions && activeLeadRole(options.leadRuntime) === "lead";
    let assignmentVerified = false;
    if (isLead) {
      const sessionId = ctx.sessionManager.getSessionId();
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      assignmentVerified = !workspaceId && !leadExecution?.managed;
      if (workspaceId) {
        if (
          statusWorktreeScope?.sessionId === sessionId &&
          statusWorktreeScope.workspaceId === workspaceId
        ) {
          assignmentVerified = true;
        } else if (
          statusWorktreeScopeRequest?.sessionId !== sessionId ||
          statusWorktreeScopeRequest.workspaceId !== workspaceId
        ) {
          // Scope lookup is deliberately outside the status refresh path: a
          // slow or unavailable Herdr topology must not stall agent status.
          statusWorktreeScopeRequest = { sessionId, workspaceId };
          void roleTransitions.currentWorktreeScope(ctx).then(
            (scope) => {
              if (
                statusWorktreeScopeRequest?.sessionId !== sessionId ||
                statusWorktreeScopeRequest.workspaceId !== workspaceId
              )
                return;
              statusWorktreeScope = { sessionId, workspaceId, scope };
              statusWorktreeScopeRequest = undefined;
              statusRuntime.requestRefresh();
            },
            () => {
              if (
                statusWorktreeScopeRequest?.sessionId === sessionId &&
                statusWorktreeScopeRequest.workspaceId === workspaceId
              )
                statusWorktreeScopeRequest = undefined;
            },
          );
        }
      }
    }
    const view = await controller.agentSnapshotView(
      ctx,
      { kind: "lead" },
      signal,
      true,
      allowTranscriptDefinitionFallback,
    );
    if (
      isLead &&
      process.env.HERDR_WORKSPACE_ID &&
      statusWorktreeScope?.sessionId === ctx.sessionManager.getSessionId() &&
      statusWorktreeScope.workspaceId === process.env.HERDR_WORKSPACE_ID
    ) {
      if (statusWorktreeScope.scope) {
        try {
          assignment = roleTransitions.projectAssignmentForScope(
            statusWorktreeScope.scope,
            ctx.sessionManager.getSessionId(),
          );
          assignmentVerified = true;
        } catch {
          assignmentVerified = false;
          // Ambiguous assignment evidence must not claim Manager control.
        }
      } else {
        assignmentVerified = true;
      }
    }
    if (isLead && sessionKind?.kind === "managed") {
      const previous = managedLifecycle;
      try {
        await currentProjectAssignment(ctx);
      } catch {}
      if (previous !== managedLifecycle) roleTransitions.reconcileRoleTools();
    }
    const snapshot = buildAgentStatusSnapshot(view, ctx, {
      ...options.statusSnapshotHost,
      scope: { kind: "root" },
      activeRootRoleForPresentation,
      listedAgentRecord: controller.listedAgentRecord,
      runtimeForLabel,
      herdStartedAt: () => herdRunRuntime?.startedAt(),
    });
    const execution =
      isLead && sessionKind?.kind === "managed"
        ? { kind: "managed" as const, lifecycle: managedLifecycle }
        : isLead && assignmentVerified && leadExecution?.valid
          ? { kind: "ordinary" as const, mode: leadExecution.mode }
          : undefined;
    return { ...snapshot, ...(execution ? { execution } : {}) };
  };
  const focusTarget = async (
    ctx: ExtensionContext,
    intent: FocusIntent,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const signal = controller.sessionSignal();
    const current = () =>
      !!signal &&
      !signal.aborted &&
      isCurrent() &&
      ctx.sessionManager.getSessionId() === sessionId &&
      activeLeadRole(options.leadRuntime) === "lead" &&
      !options.leadRuntime.roleSuspended;
    if (!current()) throw new Error("Navigation is no longer available.");
    if (intent.kind === "assigned-manager") {
      const scope = await roleTransitions.currentWorktreeScope(ctx);
      if (!current() || !scope)
        throw new Error("Managed project assignment changed.");
      const assignment = roleTransitions.projectAssignmentForScope(
        scope,
        sessionId,
      );
      const manager = await roleTransitions.currentManager(ctx);
      if (
        !current() ||
        !assignment ||
        !manager ||
        manager.repoKey !== assignment.repoKey
      )
        throw new Error("Managed project Manager is unavailable.");
      const target = await verifiedHerdrAgent(manager, {
        listAgents: async () =>
          (await options.identityHost.listAgents(ctx)).agents,
        getAgent: async (paneId) =>
          (await options.identityHost.getAgent(ctx, paneId))?.agent,
        expectedSession: options.identityHost.expectedSession,
        isPiAgent: options.identityHost.isPiAgent,
        matchesExpectedSession: options.identityHost.matchesExpectedSession,
      });
      const currentManager = await roleTransitions.currentManager(ctx);
      const currentScope = await roleTransitions.currentWorktreeScope(ctx);
      const currentAssignment = currentScope
        ? roleTransitions.projectAssignmentForScope(currentScope, sessionId)
        : undefined;
      if (
        !current() ||
        !target ||
        !currentAssignment ||
        currentAssignment.id !== assignment.id ||
        currentAssignment.repoKey !== assignment.repoKey ||
        currentAssignment.branch !== assignment.branch ||
        !currentManager ||
        currentManager.repoKey !== assignment.repoKey ||
        !options.projectHost.sameManagerDescriptor(currentManager, manager)
      )
        throw new Error("Managed project Manager changed.");
      await options.commandHost.runHerdr(
        pi,
        ctx,
        ["agent", "focus", target.pane_id],
        {
          signal,
        },
      );
      return;
    }
    const fresh = await loadStatusSnapshot(ctx, signal, false);
    const matches = fresh.agents.filter(
      (agent) =>
        agent.sessionId === intent.sessionId &&
        agent.state !== "lost" &&
        agent.state !== "unknown" &&
        agent.state !== "starting" &&
        !!agent.paneId,
    );
    if (!current() || fresh.stale || fresh.unavailable || matches.length !== 1)
      throw new Error("Agent changed; reopen Running.");
    const target = matches[0]!;
    const live = await identityRuntime.liveAgent(ctx, target.sessionId!);
    if (!current() || live.length !== 1 || live[0]!.pane_id !== target.paneId)
      throw new Error("Agent changed; reopen Running.");
    const verified = await verifiedHerdrAgent(
      {
        piSessionId: target.sessionId!,
        paneId: target.paneId!,
        tabId: live[0]!.tab_id,
        workspaceId: live[0]!.workspace_id,
      },
      {
        listAgents: async () =>
          (await options.identityHost.listAgents(ctx)).agents,
        getAgent: async (paneId) =>
          (await options.identityHost.getAgent(ctx, paneId))?.agent,
        expectedSession: options.identityHost.expectedSession,
        isPiAgent: options.identityHost.isPiAgent,
        matchesExpectedSession: options.identityHost.matchesExpectedSession,
      },
    );
    if (!current() || !verified)
      throw new Error("Agent changed; reopen Running.");
    await options.commandHost.runHerdr(
      pi,
      ctx,
      ["agent", "focus", verified.pane_id],
      {
        signal,
      },
    );
  };
  statusRuntime.configure({
    ...options.statusSnapshotHost,
    activeRootRoleForPresentation,
    pendingStartEntries: () => controller.pendingStartEntries(),
    hasPendingStart: (label: string) => controller.hasPendingStart(label),
    clearPendingStart: (label: string, expected: PendingStart) =>
      controller.clearPendingStart(label, expected),
    loadSnapshot: (ctx: ExtensionContext) =>
      loadStatusSnapshot(ctx, controller.sessionSignal(), false),
    runtimeForLabel: (label: string) => controller.runtimeForLabel(label),
    focusTarget,
  });
  let projectRuntime: ReturnType<typeof createLeadProjectRuntime>;
  const projectHost = options.projectHost;
  const projectServices = {
    ...projectHost,
    retireProjectAssignment: options.roleTransitionHost.retireProjectAssignment,
    removeProjectMessagesForAssignment:
      options.roleTransitionHost.removeProjectMessagesForAssignment,
    appendDurableError: options.herdRunServices.appendDurableError,
    writeProjectAssignment,
    liveAgent,
    liveLead,
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    reconcileProjectAssignments: (
      ...args: Parameters<typeof roleTransitions.reconcileProjectAssignments>
    ) => roleTransitions.reconcileProjectAssignments(...args),
    sameManagerDescriptor: projectHost.sameManagerDescriptor,
    withProjectWorkLock: (
      ...args: Parameters<typeof roleTransitions.withProjectWorkLock>
    ) => roleTransitions.withProjectWorkLock(...args),
    withProjectAssignmentLock: (
      ...args: Parameters<typeof roleTransitions.withProjectAssignmentLock>
    ) => roleTransitions.withProjectAssignmentLock(...args),
    supervisedSessionFile: (agent: HerdrRecord, sessionId: string) =>
      options.supervisionHost.supervisedSessionFile(agent, sessionId),
    sameObservedSessionPath,
    activeRole: () => activeLeadRole(options.leadRuntime),
    managerLease: () => options.leadRuntime.managerLease,
    currentChiefAuthority: (
      ...args: Parameters<typeof roleTransitions.currentChiefAuthority>
    ) => roleTransitions.currentChiefAuthority(...args),
    directReports: (
      ...args: Parameters<typeof supervisionUiRuntime.directReports>
    ) => supervisionUiRuntime.directReports(...args),
    loadSupervisionSnapshot: (
      ...args: Parameters<typeof supervisionUiRuntime.loadSnapshot>
    ) => supervisionUiRuntime.loadSnapshot(...args),
    prepareCoordinationInput: (
      ...args: Parameters<typeof coordinationRuntime.prepareCoordinationInput>
    ) => coordinationRuntime.prepareCoordinationInput(...args),
  };
  projectRuntime = createLeadProjectRuntime({
    ...projectServices,
    currentProjectAssignment: (ctx: ExtensionContext) =>
      roleTransitions.currentProjectAssignment(ctx),
    stopOwnedAgentsForSession: (
      ...args: Parameters<typeof controller.stopOwnedAgentsForSession>
    ) => controller.stopOwnedAgentsForSession(...args),
    pi,
    leadRuntime: options.leadRuntime,
    HERDSMAN_BUILD: options.build,
    HERDSMAN_EXTENSION_PATH: projectHost.extensionPath,
    SessionManager: projectHost.SessionManager,
    leadCoordinationTools: options.leadCoordinationToolNames,
    stopProjectLead: (...args: Parameters<typeof projectRuntime.stop>) =>
      projectRuntime.stop(...args),
  });
  herdRunRuntime = createLeadHerdRunRuntime({
    pi,
    entryName: options.herdRunEntryName,
    activeRole: () => activeLeadRole(options.leadRuntime),
    isVerifiedActiveLead: () => verifiedActiveRootRole("lead") === "lead",
    isManagedLead: () =>
      sessionKind?.kind === "managed" &&
      sessionKind.sessionId ===
        leadRuntime.leadContext?.sessionManager.getSessionId(),
    hasPendingStarts: () => controller.hasPendingStarts(),
    listAgentStates: () => controller.listAgentStates(),
    currentProjectAssignment: (ctx: ExtensionContext) =>
      currentProjectAssignment(ctx),
    publishProjectMessage: (
      ...args: Parameters<typeof roleTransitions.publishProjectMessage>
    ) => roleTransitions.publishProjectMessage(...args),
    publishChiefFailure: async (ctx, message, reportId, role, createdAt) => {
      const chief = await roleTransitions.currentChiefAuthority(ctx);
      if (!chief) return false;
      await coordinationRuntime.queueChiefRecord(
        role === "manager" ? "manager_message" : "lead_message",
        message,
        ctx,
        reportId,
        createdAt,
        undefined,
        { piSessionId: chief.piSessionId, leaseId: chief.leaseId },
      );
      return true;
    },
    requestStatusRefresh: () => statusRuntime.requestRefresh(),
    queueLeadPresentation: options.queueLeadPresentation,
    appendDurableError: options.herdRunServices.appendDurableError,
  });
  const commandRuntime = createLeadCommandRuntime({
    ...options.commandHost,
    persistStopClosures: (ctx, closures) =>
      projectRuntime.persistStopClosures(ctx, closures),
    getRemovalPreauthorization: (ctx: ExtensionContext) =>
      projectRuntime.getRemovalPreauthorization(ctx),
    setRemovalPreauthorization: (enabled: boolean, ctx: ExtensionContext) =>
      projectRuntime.setRemovalPreauthorization(enabled, ctx),
    collectOwnedSessionUsage: (ctx) => {
      const managerActive =
        activeLeadRole(options.leadRuntime) === "manager" &&
        !options.leadRuntime.roleSuspended;
      if (!managerActive)
        return options.commandHost.collectOwnedSessionUsage(ctx);
      const lease = options.leadRuntime.managerLease;
      if (!lease) throw new Error("Manager authority is unavailable");
      const assignments = options.coordinationHost.listProjectAssignments(
        options.coordinationHost.supervisionRuntime(),
        lease.descriptor.repoKey,
      );
      return options.commandHost.collectOwnedSessionUsage(
        ctx,
        assignments.map(({ id, piSessionFile }) => ({ id, piSessionFile })),
      );
    },
    isLead: () => activeLeadRole(options.leadRuntime) === "lead",
    buildStatusRows,
    renderRunningOptions,
    formatStatusCounts,
    openSupervisionOverview: (ctx: ExtensionCommandContext) =>
      supervisionUiRuntime.openOverview(ctx, {
        focusLead: (
          ...args: Parameters<typeof supervisionUiRuntime.focusLead>
        ) => supervisionUiRuntime.focusLead(...args),
        stopProjectLead: (...args: Parameters<typeof projectRuntime.stop>) =>
          projectRuntime.stop(...args),
        activateProjectLead: (
          ...args: Parameters<typeof projectRuntime.activateProjectLead>
        ) => projectRuntime.activateProjectLead(...args),
        removeWorktree: (
          ...args: Parameters<typeof projectRuntime.removeWorktree>
        ) => projectRuntime.removeWorktree(...args),
        forgetLegacyProjectAssignment: (
          ...args: Parameters<
            typeof projectRuntime.forgetLegacyProjectAssignment
          >
        ) => projectRuntime.forgetLegacyProjectAssignment(...args),
        inspectRequiredEvidence: (branch, ctx) =>
          projectRuntime.inspectRequiredEvidence(branch, ctx),
        removeRequiredEvidence: (branch, id, assignment, ctx) =>
          projectRuntime.removeRequiredEvidence(branch, id, assignment, ctx),
        selectMenu: options.commandHost.selectMenu,
      }),
    controller,
    loadStatusSnapshot: (ctx: ExtensionContext) =>
      loadStatusSnapshot(ctx, controller.sessionSignal(), true),
    roleActive: (role: "manager" | "chief") =>
      role === "manager"
        ? activeLeadRole(options.leadRuntime) === "manager" &&
          !options.leadRuntime.roleSuspended
        : options.leadRuntime.chiefMode === "active",
    transitionRole: (
      role: "manager" | "chief",
      leave: boolean,
      ctx: ExtensionCommandContext,
    ) =>
      role === "manager"
        ? leave
          ? roleTransitions.leaveManager(ctx)
          : roleTransitions.activateManager(ctx)
        : leave
          ? roleTransitions.leaveChief(ctx)
          : roleTransitions.activateChief(ctx),
    runHerdr: (
      ctx: ExtensionContext,
      args: string[],
      runOptions: Parameters<typeof runHerdr>[3],
    ) => options.commandHost.runHerdr(pi, ctx, args, runOptions),
    maybeFinishHerdRun: (ctx: ExtensionContext) =>
      herdRunRuntime!.maybeFinish(ctx),
    getThinkingLevel: () => pi.getThinkingLevel(),
  });
  const initializeSessionKind = async (
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    assignmentVerificationGeneration++;
    const identity = readSessionKind(
      ctx.sessionManager.getEntries(),
      sessionId,
    );
    // Keep the runtime unavailable until assignment evidence agrees with identity.
    sessionKind = undefined;
    const exactAssignments = globalProjectAssignmentSnapshot();
    const socket = process.env.HERDR_SOCKET_PATH;
    const matches = exactAssignments.get(sessionId) ?? [];
    if (matches.length > 1)
      throw new Error("Multiple project assignments match the Lead session");
    if (
      matches.length === 1 &&
      (!socket ||
        matches[0]!.socketHash !==
          createHash("sha256").update(socket).digest("hex"))
    )
      throw new Error(
        "Project assignment session identity conflicts with current process",
      );
    let assignment: ProjectAssignment | undefined;
    if (matches.length || identity?.kind === "managed") {
      let scope: WorktreeScope | undefined;
      try {
        scope = await roleTransitions.currentWorktreeScope(ctx);
        if (signal.aborted) return;
      } catch (error) {
        if (identity?.kind !== "managed") throw error;
        // Keep a validated permanent identity visible, but without scope evidence
        // it grants no project, profile, role, or fresh-delegation authority.
        sessionKind = identity;
        managedLifecycle = "unavailable";
        options.sessionStartOptions.appendRoleError(ctx, error);
        return;
      }
      assignment = scope
        ? roleTransitions.projectAssignmentForScope(scope, sessionId)
        : undefined;
      if (matches.length && !assignment)
        throw new Error("Cannot verify exact project assignment scope");
    }
    if (signal.aborted) return;
    if (
      identity &&
      assignment &&
      (identity.kind !== "managed" ||
        identity.repoKey !== assignment.repoKey ||
        identity.branch !== assignment.branch)
    )
      throw new Error("Session identity conflicts with project assignment");
    const resolved: SessionKindEntry =
      identity ??
      (assignment
        ? {
            version: 1,
            sessionId,
            kind: "managed",
            repoKey: assignment.repoKey,
            branch: assignment.branch,
          }
        : { version: 1, sessionId, kind: "ordinary" });
    if (!identity) pi.appendEntry("pi-herdsman-session-kind", resolved);
    sessionKind = resolved;
    if (
      !identity &&
      !assignment &&
      (startupWasManaged ||
        ctx.sessionManager
          .getEntries()
          .some(
            (entry: any) =>
              entry?.type === "custom" &&
              entry.customType === "pi-herdsman-session-kind" &&
              entry.data?.kind === "managed" &&
              entry.data?.sessionId !== sessionId,
          ))
    ) {
      // Native forks retain process tools; a managed projection is not an ordinary baseline.
      leadToolState.setLeadTools([]);
      const mode = options.commandHost.readConfig().defaultLeadExecution;
      leadExecution = { mode, valid: false, managed: false };
      persistLeadExecution(mode, []);
    }
    managedLifecycle = assignment ? "assigned" : "unavailable";
  };
  const currentProjectAssignment = async (
    ctx: ExtensionContext,
  ): Promise<ProjectAssignment | undefined> => {
    if (
      !sessionKind ||
      sessionKind.sessionId !== ctx.sessionManager.getSessionId()
    )
      throw new Error("Session identity is unavailable");
    const identity = sessionKind;
    if (identity.kind === "ordinary") return undefined;
    const generation = ++assignmentVerificationGeneration;
    const publish = (lifecycle: "assigned" | "unavailable" | "retired") => {
      if (
        sessionKind === identity &&
        ctx.sessionManager.getSessionId() === identity.sessionId &&
        generation === assignmentVerificationGeneration
      )
        managedLifecycle = lifecycle;
    };
    try {
      const replacement = roleHost.readProjectAssignment(
        roleHost.supervisionRuntime(),
        identity.repoKey,
        identity.branch,
      );
      if (replacement && replacement.id !== identity.sessionId) {
        publish("retired");
        return undefined;
      }
      const scope = await roleTransitions.currentWorktreeScope(ctx);
      if (
        sessionKind !== identity ||
        ctx.sessionManager.getSessionId() !== identity.sessionId
      )
        throw new Error("Session changed while resolving assignment");
      const assignment = scope
        ? roleTransitions.projectAssignmentForScope(scope, identity.sessionId)
        : undefined;
      const validScope = scope?.repoKey === identity.repoKey;
      if (validScope && assignment) {
        if (
          assignment.repoKey !== identity.repoKey ||
          assignment.branch !== identity.branch
        )
          throw new Error(
            "Project assignment conflicts with permanent session identity",
          );
        publish("assigned");
        roleTransitions.reconcileRoleTools();
        return assignment;
      }
      const pendingRetirement =
        !replacement &&
        listPendingRetirements(
          roleHost.supervisionRuntime(),
          identity.repoKey,
        ).some(
          (retired) =>
            retired.id === identity.sessionId &&
            retired.branch === identity.branch,
        );
      let retirementVerified = false;
      if (pendingRetirement) {
        // The retirement commit is durable; verify checkout absence again before presenting it.
        const workspaceId =
          (validScope ? scope.primaryWorkspaceId : undefined) ??
          process.env.HERDR_WORKSPACE_ID;
        if (workspaceId) {
          const topology = await roleHost.runHerdr(
            pi,
            ctx,
            ["worktree", "list", "--workspace", workspaceId],
            { signal: ctx.signal },
          );
          if (
            sessionKind !== identity ||
            ctx.sessionManager.getSessionId() !== identity.sessionId
          )
            throw new Error("Session changed while verifying retirement");
          if (
            topology?.source?.repo_key === identity.repoKey &&
            typeof topology.source.source_checkout_path === "string" &&
            Array.isArray(topology.worktrees) &&
            !topology.worktrees.some(
              (worktree: any) => worktree.branch === identity.branch,
            )
          ) {
            const inventory = await pi.exec(
              "git",
              ["worktree", "list", "--porcelain", "-z"],
              {
                cwd: topology.source.source_checkout_path,
                signal: ctx.signal,
                timeout: 10_000,
              },
            );
            const worktrees =
              inventory.code === 0 &&
              !inventory.killed &&
              !inventory.stderr?.trim()
                ? parseGitWorktreeInventory(inventory.stdout)
                : undefined;
            if (
              sessionKind !== identity ||
              ctx.sessionManager.getSessionId() !== identity.sessionId
            )
              throw new Error("Session changed while verifying retirement");
            if (
              worktrees &&
              !worktrees.some((worktree) => worktree.branch === identity.branch)
            ) {
              publish("retired");
              retirementVerified = true;
            }
          }
        }
      }
      if (!validScope && !retirementVerified)
        throw new Error(
          pendingRetirement && !process.env.HERDR_WORKSPACE_ID
            ? "Cannot verify retired managed project checkout"
            : "Cannot verify the original managed project scope",
        );
      publish(retirementVerified ? "retired" : "unavailable");
      return undefined;
    } catch (error) {
      publish("unavailable");
      throw error;
    }
  };
  const resolveExecutionDefinition = (
    ctx: ExtensionContext,
    mode: LeadExecutionMode,
    definitions?: readonly AgentDefinition[],
  ): AgentDefinition => {
    const name =
      mode === "flexible"
        ? FLEXIBLE_LEAD_DEFINITION_NAME
        : ORCHESTRATOR_LEAD_DEFINITION_NAME;
    const definition = definitions
      ? definitions.find((candidate) => candidate.name === name)
      : options.commandHost.discoverRoleDefinition(
          name,
          ctx.isProjectTrusted() ? { projectRoot: ctx.cwd } : {},
        );
    if (!definition) throw new Error(`Lead definition ${name} not found`);
    return {
      ...definition,
      body: expandAgentBodyFiles(
        definition.body,
        [],
        `${definition.name} execution profile`,
      ),
    };
  };
  const prepareLeadExecution = async (
    ctx: ExtensionContext,
    signal: AbortSignal,
    skipProfileResolution = false,
    skipAssignmentLookup = false,
    roleDefinitions?: readonly AgentDefinition[],
  ): Promise<void> => {
    if (signal.aborted) return;
    const currentBaseline = () =>
      leadToolState.getLeadTools() ??
      leadToolState.normalizeBaseTools(pi.getActiveTools());
    let assignment: ProjectAssignment | undefined;
    if (skipAssignmentLookup) {
      leadExecution = {
        mode: options.commandHost.readConfig().defaultLeadExecution,
        valid: false,
        managed: sessionKind?.kind === "managed",
      };
      return;
    }
    try {
      assignment = await currentProjectAssignment(ctx);
    } catch (error) {
      if (signal.aborted) return;
      leadToolState.setLeadTools(currentBaseline());
      leadExecution = {
        mode: options.commandHost.readConfig().defaultLeadExecution,
        valid: false,
        managed: sessionKind?.kind === "managed",
      };
      if (skipProfileResolution)
        options.sessionStartOptions.appendRoleError(ctx, error);
      else options.sessionStartOptions.appendDefinitionError(ctx, error);
      return;
    }
    if (signal.aborted) return;
    if (assignment) nameSessionIfUnset(pi, ctx, `Lead · ${assignment.branch}`);
    let saved: LeadExecutionSessionState | undefined;
    try {
      saved = sessionLeadExecutionState(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionId(),
      );
    } catch (error) {
      if (signal.aborted) return;
      leadToolState.setLeadTools(currentBaseline());
      leadExecution = {
        mode: options.commandHost.readConfig().defaultLeadExecution,
        valid: false,
        managed: sessionKind?.kind === "managed",
      };
      options.sessionStartOptions.appendDefinitionError(ctx, error);
      return;
    }
    if (signal.aborted) return;
    const baseline = saved ? [...saved.leadTools] : currentBaseline();
    const mode = assignment
      ? "orchestrate"
      : (saved?.mode ?? options.commandHost.readConfig().defaultLeadExecution);
    leadToolState.setLeadTools(baseline);
    if (!saved && sessionKind?.kind === "ordinary")
      persistLeadExecution(mode, baseline);
    if (sessionKind?.kind === "managed") {
      leadExecution = { mode, valid: false, managed: true };
      return;
    }
    if (skipProfileResolution) {
      leadExecution = { mode, valid: false, managed: false };
      return;
    }
    try {
      if (signal.aborted) return;
      const definition = resolveExecutionDefinition(ctx, mode, roleDefinitions);
      if (signal.aborted) return;
      leadExecution = {
        mode,
        definition,
        valid: true,
        managed: sessionKind?.kind === "managed",
      };
    } catch (error) {
      leadExecution = { mode, valid: false, managed: false };
      options.sessionStartOptions.appendDefinitionError(ctx, error);
    }
  };
  const restoreLeadExecution = async (
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (signal?.aborted) return;
    const mode = leadExecution?.mode;
    if (!mode) return;
    try {
      const assignment = await currentProjectAssignment(ctx);
      if (signal?.aborted) return;
      if (sessionKind?.kind === "managed") {
        leadExecution = { mode, valid: false, managed: true };
        statusRuntime.requestRefresh();
        publishLeadRole(ctx, "inactive", leadRuntime.chiefModeGeneration);
        return;
      }
      publishLeadRole(ctx, "inactive", leadRuntime.chiefModeGeneration);
    } catch (error) {
      if (signal?.aborted) return;
      leadExecution = {
        mode,
        valid: false,
        managed: !!leadExecution?.managed,
      };
      statusRuntime.requestRefresh();
      options.sessionStartOptions.appendRoleError(ctx, error);
      publishLeadRole(ctx, "inactive", leadRuntime.chiefModeGeneration);
      return;
    }
    try {
      if (signal?.aborted) return;
      const definition = resolveExecutionDefinition(ctx, mode);
      if (signal?.aborted) return;
      leadExecution = {
        mode,
        definition,
        valid: true,
        managed: sessionKind?.kind === "managed",
      };
      statusRuntime.requestRefresh();
    } catch (error) {
      if (signal?.aborted) return;
      leadExecution = { mode, valid: false, managed: false };
      statusRuntime.requestRefresh();
      options.sessionStartOptions.appendDefinitionError(ctx, error);
    }
  };
  const setLeadExecutionMode = async (
    ctx: ExtensionCommandContext,
    mode: LeadExecutionMode,
  ): Promise<void> => {
    if (!sessionKind || sessionKind.kind === "managed")
      throw new Error(
        "Managed Leads use managed-lead; use Pi /fork or /clone to continue independently (same Git checkout).",
      );
    if (leadExecution?.managed) await restoreLeadExecution(ctx);
    const identity = sessionKind;
    await ctx.waitForIdle();
    if (
      sessionKind !== identity ||
      identity.sessionId !== ctx.sessionManager.getSessionId()
    )
      throw new Error("Session changed during execution-profile selection");
    const definition = resolveExecutionDefinition(ctx, mode);
    captureInheritedTools();
    const saved =
      leadToolState.getLeadTools() ??
      leadToolState.normalizeBaseTools(pi.getActiveTools());
    const baseline = [...saved];
    const targetTools = leadToolState.projectLeadTools(baseline, definition);
    const previousExecution = leadExecution;
    const previousTools = pi.getActiveTools();
    const shouldActivate =
      activeLeadRole(leadRuntime) === "lead" && !leadRuntime.roleSuspended;
    try {
      if (shouldActivate) pi.setActiveTools(targetTools);
      persistLeadExecution(mode, baseline);
      leadToolState.setLeadTools(baseline);
      leadExecution = { mode, definition, valid: true, managed: false };
      inheritedProjection =
        shouldActivate &&
        definition.frontmatter.tools === undefined &&
        sameToolSelection(pi.getActiveTools(), targetTools)
          ? {
              mode,
              excluded: configuredToolPolicy(definition, []).excluded,
            }
          : undefined;
      statusRuntime.requestRefresh();
    } catch (error) {
      leadExecution = previousExecution;
      try {
        if (shouldActivate) pi.setActiveTools(previousTools);
        inheritedProjection =
          shouldActivate &&
          previousExecution?.valid &&
          !previousExecution.managed &&
          previousExecution.definition.frontmatter.tools === undefined &&
          sameToolSelection(pi.getActiveTools(), previousTools)
            ? {
                mode: previousExecution.mode,
                excluded: configuredToolPolicy(previousExecution.definition, [])
                  .excluded,
              }
            : undefined;
      } catch {
        inheritedProjection = undefined;
        leadExecution = { mode, valid: false, managed: false };
        try {
          pi.setActiveTools(leadToolState.normalizeLeadTools([]));
        } catch {
          // Preserve the original transition failure.
        }
      }
      try {
        options.sessionStartOptions.appendDefinitionError(ctx, error);
      } catch {
        // Preserve the original transition failure.
      }
      throw error;
    }
  };
  const reconcileBranchExecution = async (ctx: ExtensionContext) => {
    inheritedProjection = undefined;
    if (sessionKind?.kind === "managed") {
      await restoreLeadExecution(ctx);
      pi.setActiveTools(executionTools());
      return;
    }
    let saved: LeadExecutionSessionState | undefined;
    try {
      saved = sessionLeadExecutionState(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionId(),
      );
    } catch (error) {
      leadExecution = {
        mode:
          leadExecution?.mode ??
          options.commandHost.readConfig().defaultLeadExecution,
        valid: false,
        managed: !!leadExecution?.managed,
      };
      throw error;
    }
    const baseline = saved
      ? [...saved.leadTools]
      : leadToolState.normalizeBaseTools(pi.getActiveTools());
    const mode =
      saved?.mode ?? options.commandHost.readConfig().defaultLeadExecution;
    leadToolState.setLeadTools(baseline);
    leadExecution = { mode, valid: false, managed: !!leadExecution?.managed };
    await restoreLeadExecution(ctx);
    if (leadExecution && !leadExecution.managed && leadExecution.valid)
      pi.setActiveTools(
        leadToolState.projectLeadTools(baseline, leadExecution.definition),
      );
  };
  const agentEvents = createLeadAgentEventRuntime({
    ...options.agentEventOptions,
    executionPrompt: () =>
      leadExecution && !leadExecution.managed && leadExecution.valid
        ? leadExecution.definition.body
        : undefined,
    leadInboxRuntime: inboxRuntime,
    herdRun: herdRunRuntime,
    controller,
    consumeChiefStartPreflight: (ctx: ExtensionContext) =>
      inboxRuntime.consumeStartPreflight(ctx),
  });
  const sessionStart = createLeadSessionStartRuntime({
    ...options.sessionStartOptions,
    rootDelegationPolicy,
    isRoot: () => options.roleTransitionHost.processRole === "lead",
    initialStatusBreadcrumb: () => [
      { text: activeRootRoleForPresentation() ?? "controller" },
    ],
    diagnostic: () => managerDiagnostic("session_start_reached"),
    clearSupervisionUI,
    startSupervisionUI,
    roleTransitions,
    normalizeBaseTools: leadToolState.normalizeBaseTools,
    prepareLeadExecution,
    discoverSessionDefinitions: async (ctx: ExtensionContext) => {
      let roleDefinitions: AgentDefinition[] = [];
      try {
        roleDefinitions = discoverRoleDefinitions(
          ctx.isProjectTrusted() ? { projectRoot: ctx.cwd } : {},
        );
      } catch (error) {
        options.sessionStartOptions.appendDefinitionError(ctx, error);
      }
      let definitions: AgentDefinition[] = [];
      try {
        definitions = (await options.commandHost.contextAgentDefinitions(ctx))
          .definitions;
      } catch (error) {
        options.sessionStartOptions.appendDefinitionError(ctx, error);
      }
      return {
        definitions,
        roleDefinitions,
        projectTrusted: ctx.isProjectTrusted(),
      };
    },
    initializeSessionKind,
    activeTools: () =>
      leadExecutionPending ? startupTools : pi.getActiveTools(),
    clearLeadExecution: () => {
      startupTools = pi.getActiveTools();
      startupWasManaged = sessionKind?.kind === "managed";
      assignmentVerificationGeneration++;
      sessionKind = undefined;
      managedLifecycle = "unavailable";
      leadExecution = undefined;
    },
    setLeadExecutionPending: (pending: boolean) => {
      leadExecutionPending = pending;
    },
    restoreLeadExecution,
    hasLeadExecutionState: () => leadExecution !== undefined,
    leadStatusRuntime: statusRuntime,
    leadInboxRuntime: inboxRuntime,
    clearChiefStartPreflight: () => inboxRuntime.clearStartPreflight(),
    herdRun: herdRunRuntime,
    controller,
  });
  const sessionTree = createLeadSessionTreeRuntime({
    ...options.sessionTreeOptions,
    isRoot: () => options.roleTransitionHost.processRole === "lead",
    roleTransitions,
    reconcileBranchExecution,
    failClosedBranchExecution: () => {
      leadExecution = {
        mode:
          leadExecution?.mode ??
          options.commandHost.readConfig().defaultLeadExecution,
        valid: false,
        managed: !!leadExecution?.managed,
      };
      roleTransitions.reconcileRoleTools();
    },
    controller,
  });
  const shutdown = createLeadShutdownRuntime({
    ...options.shutdownOptions,
    isRoot: () => options.roleTransitionHost.processRole === "lead",
    clearSupervisionUI: () => clearSupervisionUI(),
    roleTransitions,
    controller,
    leadStatusRuntime: statusRuntime,
    leadInboxRuntime: inboxRuntime,
    drainLeadMetadata: () => leadMetadataQueue,
    herdRun: herdRunRuntime,
  });
  pi.on("turn_start", () => controller.resetAssignmentGuidance());
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) =>
    agentEvents.beforeAgentStart(event, ctx),
  );
  pi.on("agent_start", (_event: unknown, ctx: ExtensionContext) =>
    agentEvents.agentStart(ctx),
  );
  pi.on("agent_before_settle", (event: any) => {
    if (
      activeLeadRole(leadRuntime) === "lead" ||
      herdRunRuntime!.hasActiveTurn()
    )
      herdRunRuntime!.beforeSettle(event);
  });
  pi.on(
    "agent_settled",
    (event: { aborted: boolean }, ctx: ExtensionContext) => {
      const result = agentEvents.agentSettled(ctx, event.aborted);
      projectRuntime.updateRemovalStatus(ctx);
      return result;
    },
  );
  pi.on("tool_call", (event: any, ctx: ExtensionContext) =>
    agentEvents.toolCall(event, ctx),
  );
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    inheritedProjection = undefined;
    await sessionStart.sessionStart(ctx);
    projectRuntime.updateRemovalStatus(ctx);
  });
  pi.on("session_info_changed", (event: any, ctx: ExtensionContext) => {
    if (!roleTransitions.chiefModeInactive()) return;
    if (!options.hasPane()) return;
    options.queueLeadPresentation(ctx, event?.name ?? options.sessionName());
  });
  pi.on("turn_end", (event: any, ctx: ExtensionContext) => {
    if (
      activeLeadRole(leadRuntime) === "lead" ||
      herdRunRuntime!.hasActiveTurn()
    )
      herdRunRuntime!.turnEnd(event);
    options.queueLeadPresentation(ctx);
  });
  pi.on("session_compact", (_event: unknown, ctx: ExtensionContext) =>
    options.queueLeadPresentation(ctx),
  );
  pi.on("session_tree", (_event: unknown, ctx: ExtensionContext) => {
    inheritedProjection = undefined;
    projectRuntime.updateRemovalStatus(ctx);
    return sessionTree.sessionTree(ctx);
  });
  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
    inheritedProjection = undefined;
    return shutdown.shutdown(ctx);
  });
  return {
    roleTransitions,
    publishLeadRole,
    queueLeadMetadata,
    enterLead,
    enterChief,
    enterSuspended,
    controller,
    commandRuntime,
    statusRuntime,
    supervisionUiRuntime,
    coordinationRuntime,
    inboxRuntime,
    projectRuntime,
    herdRunRuntime,
    liveAgent,
    remoteChiefAgent,
    liveLead,
    setLeadExecutionMode,
    sessionKindForPrompt: (ctx: ExtensionContext) =>
      sessionKind?.sessionId === ctx.sessionManager.getSessionId()
        ? sessionKind.kind
        : undefined,
    leadExecutionPresentation: () =>
      sessionKind?.kind === "managed"
        ? {
            managed: true,
            mode: leadExecution?.mode ?? "orchestrate",
            lifecycle: managedLifecycle,
          }
        : { managed: false, mode: leadExecution?.mode ?? "flexible" },
    supervisoryProfileBody: (
      ctx: ExtensionContext,
      role: "manager" | "chief",
    ) =>
      currentSupervisoryProfile(ctx, role)?.valid
        ? currentSupervisoryProfile(ctx, role)!.definition.body
        : "",
    currentChiefAllowedTools: (ctx: ExtensionContext) =>
      supervisoryTools(ctx, "chief"),
  };
}

export function createLeadIdentityRuntime(host: LeadIdentityHost) {
  const liveAgent = async (
    ctx: ExtensionContext,
    sessionId: string,
    sessionPath?: string,
  ) => {
    const expected = host.expectedSession(sessionId, sessionPath);
    return (await host.listAgents(ctx)).agents.filter(
      (agent: HerdrRecord) =>
        host.isPiAgent(agent) &&
        host.matchesExpectedSession(agent.agent_session, expected) &&
        typeof agent.pane_id === "string" &&
        typeof agent.tab_id === "string" &&
        typeof agent.workspace_id === "string",
    );
  };
  const remoteChiefAgent = async (
    ctx: ExtensionContext,
    descriptor: Pick<
      ChiefDescriptor,
      "piSessionId" | "piSessionFile" | "paneId" | "tabId" | "workspaceId"
    >,
  ): Promise<HerdrRecord | undefined> =>
    verifiedHerdrAgent(descriptor, {
      listAgents: async () => (await host.listAgents(ctx)).agents,
      getAgent: async (paneId) => (await host.getAgent(ctx, paneId))?.agent,
      expectedSession: host.expectedSession,
      isPiAgent: host.isPiAgent,
      matchesExpectedSession: host.matchesExpectedSession,
    });
  const liveLead = async (
    ctx: ExtensionContext,
    sessionId: string,
    sessionPath?: string,
  ) => {
    const expected = host.expectedSession(sessionId, sessionPath);
    const matches = await liveAgent(ctx, sessionId, sessionPath);
    const snapshot = await host.leadController.managedAgentSnapshots(
      ctx,
      ctx.signal,
      false,
      true,
    );
    const hasManagedAgent = snapshot.agents.some(
      ({ state }) => state.piSessionId === sessionId,
    );
    return matches.filter(
      (agent: HerdrRecord) =>
        !hasManagedAgent &&
        host.matchesExpectedSession(agent.agent_session, expected) &&
        host.hasLeadCoordination(sessionId),
    );
  };
  return { liveAgent, remoteChiefAgent, liveLead };
}

export function createLeadSupervisionRuntime(host: LeadSupervisionHost) {
  const loadSupervisionSnapshot = async (
    ctx: ExtensionContext,
    suppliedInventory?: HerdrSessionSnapshot,
    suppliedAgents?: ManagedAgentSnapshotCollection,
    includeAll = false,
    classifyBuilds = false,
  ) => {
    if (host.activeRole() === "chief" && !includeAll) {
      const incompatible: import("./supervision.ts").IncompatibleStaff[] = [];
      const reports = await directReports(
        ctx,
        suppliedInventory,
        suppliedAgents,
        incompatible,
      );
      const managers = reports.filter(
        (report: any) => report.role === "manager",
      );
      return {
        managers,
        leads: reports.filter((report: any) => report.role === "lead"),
        ...(incompatible.length ? { incompatible } : {}),
      };
    }
    if (host.activeRole() === "manager" && !includeAll) {
      const manager = await host.currentManager(ctx);
      if (!manager) throw new Error("Manager lease is no longer active");
      const group = await host.worktreeGroupScope(
        host.pi,
        ctx,
        manager.workspaceId,
        ctx.signal,
      );
      if (group.repoKey !== manager.repoKey)
        throw new Error("Manager workspace is not the assigned project");
      const incompatible: import("./supervision.ts").IncompatibleStaff[] = [];
      const [leads, topology] = await Promise.all([
        directReports(ctx, suppliedInventory, suppliedAgents, incompatible),
        host.runHerdr(
          host.pi,
          ctx,
          ["worktree", "list", "--workspace", group.primaryWorkspaceId],
          { signal: ctx.signal },
        ),
      ]);
      if (
        topology?.source?.repo_key !== group.repoKey ||
        topology?.source?.source_workspace_id !== group.primaryWorkspaceId ||
        !Array.isArray(topology?.worktrees)
      )
        throw new Error("Herdr worktree topology is not authoritative");
      if (typeof topology.source.source_checkout_path === "string")
        await host.reconcileProjectAssignments?.(
          ctx,
          group.repoKey,
          manager.workspaceId,
          topology.source.source_checkout_path,
        );
      const assignments = host.listProjectAssignments(
        host.supervisionRuntime(),
        group.repoKey,
      );
      const openWorkspaces = topology.worktrees.flatMap((worktree: any) =>
        typeof worktree?.open_workspace_id === "string" &&
        worktree.open_workspace_id
          ? [
              {
                workspaceId: worktree.open_workspace_id,
                ...(typeof worktree.branch === "string" && worktree.branch
                  ? { branch: worktree.branch }
                  : {}),
                path: String(worktree.path ?? ""),
                linked: worktree.is_linked_worktree === true,
              },
            ]
          : [],
      );
      return {
        project: group.repoName,
        work: host.projectWorkSnapshot({
          assignments,
          worktrees: topology.worktrees,
          leads: [
            ...leads,
            ...incompatible
              .filter((report) => report.role === "lead")
              .map((report) => ({
                lead: report.session,
                workspaceId: report.workspaceId,
                runtimeState: report.runtimeState,
              })),
          ],
        }),
        openWorkspaces,
        leads: leads.flatMap((lead: any) => {
          const assignment = assignments.find((item) => item.id === lead.lead);
          if (lead.relationship === "assigned" && !assignment) return [];
          return [
            assignment
              ? {
                  ...lead,
                  relationship: "assigned" as const,
                  branch: assignment.branch,
                }
              : { ...lead, relationship: "supervised" as const },
          ];
        }),
        ...(incompatible.length ? { incompatible } : {}),
      };
    }
    const inventory =
      suppliedInventory ??
      (await host.herdrSessionSnapshot(host.pi, ctx, ctx.signal));
    const live = inventory.agents;
    const agentSnapshot =
      suppliedAgents ??
      (await host.managedAgentSnapshots(
        host.pi,
        ctx,
        ctx.signal,
        false,
        true,
        inventory,
      ));
    const agentEvidence = agentSnapshot.agents.map(({ state, listed }) => ({
      piSessionId: state.piSessionId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      paneId: state.paneId,
      runtimeState: listed.state,
      agentLabel: state.agentLabel,
    }));
    const managedAgentSessionIds = new Set(
      agentEvidence.map((agent) => agent.piSessionId),
    );
    const agents = live.flatMap((agent: any) => {
      const sessionId = host.herdrSessionId(agent);
      if (!host.isPiAgent(agent) || !sessionId) return [];
      const candidateSessionFile = host.supervisedSessionFile(agent, sessionId);
      const piSessionFile =
        candidateSessionFile &&
        host.persistedTranscriptReady({
          piSessionId: sessionId,
          piSessionFile: candidateSessionFile,
        })
          ? candidateSessionFile
          : undefined;
      return [
        {
          sessionId,
          sessionKind: "id" as const,
          workspaceId: agent.workspace_id,
          paneId: agent.pane_id,
          tabId: agent.tab_id,
          workspaceCwd: agent.cwd,
          herdrName: agent.name,
          ...(piSessionFile ? { piSessionFile } : {}),
          tokens: agent.tokens,
          runtimeState: host.normalizeHerdrLifecycleState(agent),
        },
      ];
    });
    const workspaceCwds = new Map<string, string>();
    for (const agent of agents)
      if (!workspaceCwds.has(agent.workspaceId) && agent.workspaceCwd)
        workspaceCwds.set(agent.workspaceId, agent.workspaceCwd);
    const workspaceProvenance = await host.workspacePresentationProvenance(
      host.pi,
      ctx,
      [...new Set(agents.map((agent) => agent.workspaceId))],
      workspaceCwds,
      ctx.signal,
      inventory.workspaces,
    );
    const diagnostics = live.some(
      (agent: any) =>
        (agent?.agent === "pi" || agent?.agent_session?.agent === "pi") &&
        !host.isPiAgent(agent),
    )
      ? [
          "Live Pi agents are present but their session identities are unresolvable",
        ]
      : undefined;
    const coordinationStates = agents.flatMap((agent) => {
      try {
        const state = host.readLeadCoordinationState(
          host.supervisionRuntime(),
          agent.sessionId,
        );
        return state ? [state] : [];
      } catch (error) {
        // Missing state is a normal pre-publication condition. Any other
        // failure is an ambiguous lead and must remain observable.
        host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
        throw error;
      }
    });
    const snapshot = host.projectSupervision({
      agents,
      managedAgents: agentEvidence,
      coordinationStates,
      ...(classifyBuilds ? { localBuild: host.build } : {}),
      workspaceProvenance,
      excludedSessionIds: new Set([
        ...host
          .listManagerDescriptors(host.supervisionRuntime())
          .map((manager) => manager.piSessionId),
        ...(host.currentChief() ? [host.currentChief()!.piSessionId] : []),
      ]),
      managedAgentSessionIds,
    });
    return { ...snapshot, ...(diagnostics ? { diagnostics } : {}) };
  };
  const directReports = async (
    ctx: ExtensionContext,
    suppliedInventory?: HerdrSessionSnapshot,
    suppliedAgents?: ManagedAgentSnapshotCollection,
    incompatible?: import("./supervision.ts").IncompatibleStaff[],
  ) => {
    if (host.activeRole() === "manager" && !host.state.roleSuspended) {
      const manager = await host.currentManager(ctx);
      if (
        !manager ||
        !host.state.managerLease ||
        !host.sameManagerDescriptor(manager, host.state.managerLease.descriptor)
      )
        throw new Error("Manager lease is no longer active");
      const scope = await host.worktreeGroupScope(
        host.pi,
        ctx,
        manager.workspaceId,
        ctx.signal,
      );
      const snapshot = await loadSupervisionSnapshot(
        ctx,
        suppliedInventory,
        suppliedAgents,
        true,
        true,
      );
      for (const report of snapshot.incompatible ?? [])
        if (
          report.role === "lead" &&
          scope.workspaceIds.includes(report.workspaceId)
        )
          incompatible?.push(report);
      const assignments = host.listProjectAssignments(
        host.supervisionRuntime(),
        manager.repoKey,
      );
      const sessions = new Set(assignments.map((assignment) => assignment.id));
      if (sessions.size !== assignments.length)
        throw new Error("Multiple project assignments match a Lead session");
      const repoManagers = host
        .listManagerDescriptors(host.supervisionRuntime())
        .filter((candidate) => candidate.repoKey === manager.repoKey);
      const ordinarySupervisionAvailable =
        repoManagers.length === 1 &&
        host.sameManagerDescriptor(repoManagers[0], manager);
      const leads = await Promise.all(
        snapshot.leads.map(async (lead) => {
          try {
            const descriptor = {
              piSessionId: lead.lead,
              piSessionFile: lead.piSessionFile,
              paneId: lead.paneId,
              tabId: lead.tabId,
              workspaceId: lead.workspaceId,
            };
            const agent = await host.remoteChiefAgent(ctx, descriptor);
            if (typeof agent?.cwd !== "string" || !agent.cwd) return undefined;
            const repository = await localRepositoryScope(
              host.pi,
              { ...ctx, cwd: agent.cwd },
              lead.workspaceId,
              ctx.signal,
            );
            if (repository.repoKey !== manager.repoKey) return undefined;
            const current = await host.remoteChiefAgent(ctx, descriptor);
            if (!current || current.cwd !== agent.cwd) return undefined;
            return lead;
          } catch (error) {
            if (ctx.signal?.aborted) throw ctx.signal.reason;
            if (error instanceof Error && error.name === "AbortError")
              throw error;
            return undefined;
          }
        }),
      );
      return leads
        .filter((lead): lead is NonNullable<typeof lead> => lead !== undefined)
        .filter(
          (lead) => sessions.has(lead.lead) || ordinarySupervisionAvailable,
        )
        .map((lead) => ({
          ...lead,
          ...(sessions.has(lead.lead)
            ? {
                branch: assignments.find(
                  (assignment) => assignment.id === lead.lead,
                )!.branch,
              }
            : {}),
          relationship: sessions.has(lead.lead)
            ? ("assigned" as const)
            : ("supervised" as const),
        }));
    }
    if (host.activeRole() !== "chief")
      throw new Error("Staff is available only to an active supervisor");
    const chiefAuthority = await host.currentChiefAuthority(ctx);
    if (!chiefAuthority)
      throw new Error("Staff is available only to an active supervisor");
    const managers = [];
    const allLeadSnapshot = await loadSupervisionSnapshot(
      ctx,
      suppliedInventory,
      suppliedAgents,
      true,
      true,
    );
    const allLeads = allLeadSnapshot.leads;
    const incompatibleLeadParents = new Map<string, string>();
    const managedAgents = (
      suppliedAgents ??
      (await host.managedAgentSnapshots(
        host.pi,
        ctx,
        ctx.signal,
        false,
        true,
        suppliedInventory,
      ))
    ).agents;
    const managerLeadSessions = new Set<string>();
    const descriptors = host.listManagerDescriptors(host.supervisionRuntime());
    for (const lead of allLeads) {
      try {
        const scope = await host.worktreeGroupScope(
          host.pi,
          ctx,
          lead.workspaceId,
          ctx.signal,
        );
        const supervisor = await host.resolveEffectiveSupervisor(
          ctx,
          lead.lead,
          lead.workspaceId,
          scope,
        );
        if (supervisor.kind !== "chief") managerLeadSessions.add(lead.lead);
      } catch {
        // Unverifiable worktree scope cannot produce Chief direct authority.
        managerLeadSessions.add(lead.lead);
      }
    }
    for (const lead of allLeadSnapshot.incompatible ?? []) {
      if (lead.role !== "lead") continue;
      try {
        const scope = await host.worktreeGroupScope(
          host.pi,
          ctx,
          lead.workspaceId,
          ctx.signal,
        );
        const supervisor = await host.resolveEffectiveSupervisor(
          ctx,
          lead.session,
          lead.workspaceId,
          scope,
        );
        if (supervisor.kind === "manager") {
          managerLeadSessions.add(lead.session);
          incompatibleLeadParents.set(
            lead.session,
            supervisor.manager.piSessionId,
          );
        } else if (supervisor.kind !== "chief")
          managerLeadSessions.add(lead.session);
      } catch {
        managerLeadSessions.add(lead.session);
      }
    }
    for (const descriptor of descriptors) {
      const assignedSessions = new Set(
        host
          .listProjectAssignments(host.supervisionRuntime(), descriptor.repoKey)
          .map((assignment) => assignment.id),
      );
      for (const session of assignedSessions) managerLeadSessions.add(session);
      if (
        descriptors.filter(
          (candidate) => candidate.piSessionId === descriptor.piSessionId,
        ).length !== 1
      )
        continue;
      const live = await host.remoteChiefAgent(ctx, descriptor);
      if (!live) continue;
      const state = host.readLeadCoordinationState(
        host.supervisionRuntime(),
        descriptor.piSessionId,
      );
      if (!state || state.role !== "manager") continue;
      let scope;
      try {
        scope = await host.worktreeGroupScope(
          host.pi,
          ctx,
          descriptor.workspaceId,
          ctx.signal,
        );
      } catch {
        continue;
      }
      if (
        scope.repoKey !== descriptor.repoKey ||
        scope.primaryWorkspaceId !== descriptor.workspaceId
      )
        continue;
      let effectiveManager: ManagerDescriptor | undefined;
      try {
        effectiveManager = await host.currentManager(ctx, scope);
      } catch (error) {
        const remoteBuild = descriptor.build;
        const stateBuild = state.build;
        if (
          error instanceof OperationError &&
          error.detail.category === "incompatible_build" &&
          state.piSessionId === descriptor.piSessionId &&
          state.role === "manager" &&
          scope.repoKey === descriptor.repoKey &&
          scope.primaryWorkspaceId === descriptor.workspaceId &&
          isRuntimeBuild(remoteBuild) &&
          isRuntimeBuild(stateBuild) &&
          sameRuntimeBuild(remoteBuild, stateBuild) &&
          !sameRuntimeBuild(remoteBuild, host.build)
        ) {
          incompatible?.push({
            role: "manager",
            session: descriptor.piSessionId,
            displayName: scope.repoName,
            workspaceId: descriptor.workspaceId,
            runtimeState: host.normalizeHerdrLifecycleState(live),
            build: remoteBuild,
            reason: "incompatible_build",
          });
          continue;
        }
        throw error;
      }
      if (
        !effectiveManager ||
        !host.sameManagerDescriptor(effectiveManager, descriptor)
      )
        continue;
      const leads = allLeads.filter((lead) =>
        scope.workspaceIds.includes(lead.workspaceId),
      );
      const incompatibleLeads = (allLeadSnapshot.incompatible ?? []).filter(
        (lead) =>
          lead.role === "lead" &&
          incompatibleLeadParents.get(lead.session) ===
            descriptor.piSessionId &&
          scope.workspaceIds.includes(lead.workspaceId),
      );
      for (const lead of leads) managerLeadSessions.add(lead.lead);
      const ownerSessions = new Set([descriptor.piSessionId]);
      const ownedAgents = [] as typeof managedAgents;
      for (let changed = true; changed;) {
        changed = false;
        for (const agent of managedAgents) {
          if (
            ownerSessions.has(agent.state.ownerSessionId) &&
            !ownerSessions.has(agent.state.piSessionId)
          ) {
            ownerSessions.add(agent.state.piSessionId);
            ownedAgents.push(agent);
            changed = true;
          }
        }
      }
      managers.push({
        session: descriptor.piSessionId,
        instanceId: state.instanceId,
        displayName: scope.repoName,
        project: scope.repoName,
        workspaceId: descriptor.workspaceId,
        paneId: descriptor.paneId,
        tabId: descriptor.tabId,
        runtimeState: host.normalizeHerdrLifecycleState(live),
        ...(host.supervisedSessionFile(live, descriptor.piSessionId) &&
        host.persistedTranscriptReady({
          piSessionId: descriptor.piSessionId,
          piSessionFile: host.supervisedSessionFile(
            live,
            descriptor.piSessionId,
          )!,
        })
          ? {
              piSessionFile: host.supervisedSessionFile(
                live,
                descriptor.piSessionId,
              ),
            }
          : {}),
        agentCounts: {
          active:
            ownedAgents.filter(({ listed }) => listed.state === "working")
              .length +
            leads.reduce((n, lead) => n + lead.agentCounts.active, 0),
          blocked:
            ownedAgents.filter(({ listed }) => listed.state === "blocked")
              .length +
            leads.reduce((n, lead) => n + lead.agentCounts.blocked, 0),
          total:
            ownedAgents.length +
            leads.reduce((n, lead) => n + lead.agentCounts.total, 0),
        },
        leadCounts: {
          active: leads.filter((lead) =>
            ["working", "starting", "settling"].includes(lead.runtimeState),
          ).length,
          blocked: leads.filter((lead) => lead.runtimeState === "blocked")
            .length,
          total: leads.length,
        },
        incompatibleLeadCount: incompatibleLeads.length,
        leads: [
          ...leads.map((lead) => ({
            session: lead.lead,
            displayName: lead.displayName,
            ...(lead.branch ? { branch: lead.branch } : {}),
            runtimeState: lead.runtimeState,
            agentCounts: lead.agentCounts,
          })),
          ...incompatibleLeads.map((lead) => ({
            session: lead.session,
            displayName: lead.displayName,
            runtimeState: lead.runtimeState,
            compatibility: "incompatible" as const,
            build: lead.build,
          })),
        ],
        availableActions: [
          "inspect",
          "message",
          ...(host.supervisedSessionFile(live, descriptor.piSessionId) &&
          host.persistedTranscriptReady({
            piSessionId: descriptor.piSessionId,
            piSessionFile: host.supervisedSessionFile(
              live,
              descriptor.piSessionId,
            )!,
          })
            ? ["transcript" as const]
            : []),
        ],
      });
    }
    const unclaimedLeads = allLeads.filter(
      (lead) => !managerLeadSessions.has(lead.lead),
    );
    for (const report of allLeadSnapshot.incompatible ?? [])
      if (report.role === "lead" && !managerLeadSessions.has(report.session))
        incompatible?.push(report);
    return [
      ...managers.map((manager: any) => ({
        ...manager,
        role: "manager" as const,
      })),
      ...unclaimedLeads.map((lead) => ({ ...lead, role: "lead" as const })),
    ];
  };

  let loadSnapshot = host.loadSnapshot ?? loadSupervisionSnapshot;
  let snapshot: any = { leads: [] };
  let known = false;
  let generationId: string | undefined;
  let stale = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let redrawTimer: ReturnType<typeof setInterval> | undefined;
  let uiContext: ExtensionContext | undefined;
  let inFlight: Promise<void> | undefined;
  let pending: ExtensionContext | undefined;
  let overviewGeneration = 0;
  let renderOverview: (() => void) | undefined;
  let renderWidget: (() => void) | undefined;
  let widgetFocusInFlight = false;
  let supervisionWidgetGeneration = 0;

  const generation = (ctx?: ExtensionContext): string =>
    [
      host.state.chiefModeGeneration,
      host.state.sessionGeneration,
      host.state.chiefLease?.descriptor.leaseId ?? "",
      host.state.managerLease?.descriptor.leaseId ?? "",
      host.activeRole(),
      ctx?.sessionManager.getSessionId() ??
        host.state.leadContext?.sessionManager.getSessionId() ??
        "",
    ].join(":");
  const snapshotKnown = (ctx?: ExtensionContext): boolean =>
    known && generationId === generation(ctx);
  const status = (ctx?: ExtensionContext): "fresh" | "stale" | "unavailable" =>
    !snapshotKnown(ctx) ? "unavailable" : stale ? "stale" : "fresh";
  const supervisionStatus = status;
  const reset = (): void => {
    snapshot = host.activeRole() === "chief" ? { managers: [] } : { leads: [] };
    known = false;
    generationId = undefined;
    stale = false;
  };
  const refreshOnce = async (ctx: ExtensionContext): Promise<void> => {
    if (
      host.state.chiefMode !== "active" &&
      !(host.activeRole() === "manager" && !host.state.roleSuspended)
    )
      return;
    const currentGeneration = generation(ctx);
    const current = (): boolean => generation(ctx) === currentGeneration;
    try {
      const inventory = await host.herdrSessionSnapshot(
        host.pi,
        ctx,
        ctx.signal,
      );
      const agents = await host.managedAgentSnapshots(
        host.pi,
        ctx,
        ctx.signal,
        false,
        true,
        inventory,
        false,
      );
      const value = await loadSnapshot(ctx, inventory, agents);
      if (!current()) return;
      snapshot = value;
      known = true;
      generationId = currentGeneration;
      stale = false;
      renderOverview?.();
    } catch {
      if (current()) stale = snapshotKnown(ctx);
    }
    if (
      current() &&
      (host.state.chiefMode === "active" || host.activeRole() === "manager") &&
      ctx.mode === "tui"
    ) {
      try {
        renderWidget?.();
      } catch {
        /* A failed redraw must not reject observation. */
      }
    }
  };
  const refresh = (ctx: ExtensionContext): Promise<void> => {
    pending = ctx;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (pending) {
        const next = pending;
        pending = undefined;
        await refreshOnce(next);
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  const focusLead = async (
    ctx: ExtensionContext,
    leadId: string,
    parentManagerSessionId?: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    const currentGeneration = generation(ctx);
    const fresh = await loadSnapshot(ctx);
    if (!isCurrent() || currentGeneration !== generation(ctx))
      throw new Error("Lead changed; reopen staff.");
    if (
      host.activeRole() === "manager" &&
      host
        .managerSupervisionItems(fresh)
        .filter((item) =>
          item.kind === "lead"
            ? item.lead.lead === leadId &&
              item.lead.compatibility !== "incompatible"
            : item.work.status === "active" &&
              item.lead?.lead === leadId &&
              item.lead.compatibility !== "incompatible",
        ).length !== 1
    )
      throw new Error("Lead is no longer available.");
    const managers = host.listManagerDescriptors(host.supervisionRuntime());
    const verifyManager = async (sessionId: string, report?: any) => {
      const candidates = managers.filter(
        (candidate) => candidate.piSessionId === sessionId,
      );
      if (candidates.length !== 1) return undefined;
      const descriptor = candidates[0]!;
      const agents = await host.listAllHerdrAgents(host.pi, ctx, ctx.signal);
      const placements = agents.agents.filter(
        (candidate: any) =>
          host.isPiAgent(candidate) &&
          host.herdrSessionId(candidate) === sessionId &&
          candidate.pane_id === descriptor.paneId &&
          candidate.tab_id === descriptor.tabId &&
          candidate.workspace_id === descriptor.workspaceId &&
          (!report ||
            (report.paneId === descriptor.paneId &&
              report.tabId === descriptor.tabId &&
              report.workspaceId === descriptor.workspaceId)),
      );
      return placements.length === 1
        ? { descriptor, paneId: descriptor.paneId }
        : undefined;
    };
    let lead: any;
    let parent: any;
    let verifiedParent: any;
    if (parentManagerSessionId) {
      parent = host
        .presentationReports(fresh)
        .find(
          (candidate: any) =>
            candidate.role === "manager" &&
            candidate.lead === parentManagerSessionId,
        );
      const children = parent?.leads?.filter(
        (candidate: any) => candidate.session === leadId,
      );
      const child = children?.length === 1 ? children[0] : undefined;
      if (
        !parent ||
        parent.compatibility === "incompatible" ||
        !child ||
        child.compatibility === "incompatible"
      )
        throw new Error("Lead changed or is incompatible; reopen staff.");
      lead = { lead: leadId };
    } else {
      const matches = host
        .presentationReports(fresh)
        .filter((candidate: any) => candidate.lead === leadId);
      if (matches.length !== 1) throw new Error("Lead changed; reopen staff.");
      lead = matches[0];
    }
    if (lead.compatibility === "incompatible")
      throw new Error(
        "Lead is incompatible; reload the matching Herdsman build.",
      );
    if (parent || lead.role === "manager") {
      const managerSessionId = parent?.lead ?? lead.lead;
      const report = parent ?? lead;
      const manager = await verifyManager(managerSessionId, report);
      if (!manager || !isCurrent() || currentGeneration !== generation(ctx))
        throw new Error("Manager changed; reopen staff.");
      verifiedParent = manager.descriptor;
      if (!parent) {
        const currentManagers = host
          .listManagerDescriptors(host.supervisionRuntime())
          .filter((descriptor) => descriptor.piSessionId === managerSessionId);
        if (
          !isCurrent() ||
          currentManagers.length !== 1 ||
          !host.sameManagerDescriptor(currentManagers[0]!, manager.descriptor)
        )
          throw new Error("Manager changed; reopen staff.");
        const currentAgent = await host.runHerdr(
          host.pi,
          ctx,
          ["agent", "get", manager.paneId],
          { signal: ctx.signal },
        );
        if (
          !isCurrent() ||
          host.herdrSessionId(currentAgent?.agent) !== managerSessionId ||
          currentAgent?.agent?.pane_id !== manager.paneId ||
          currentAgent?.agent?.tab_id !== manager.descriptor.tabId ||
          currentAgent?.agent?.workspace_id !== manager.descriptor.workspaceId
        )
          throw new Error("Manager changed; reopen staff.");
        const finalManagers = host
          .listManagerDescriptors(host.supervisionRuntime())
          .filter((descriptor) => descriptor.piSessionId === managerSessionId);
        if (
          !isCurrent() ||
          finalManagers.length !== 1 ||
          !host.sameManagerDescriptor(finalManagers[0]!, manager.descriptor)
        )
          throw new Error("Manager changed; reopen staff.");
        await host.runHerdr(host.pi, ctx, ["agent", "focus", manager.paneId], {
          signal: ctx.signal,
        });
        return;
      }
    }
    const coordination = host.readLeadCoordinationState(
      host.supervisionRuntime(),
      leadId,
    );
    if (
      !coordination ||
      coordination.piSessionId !== leadId ||
      (lead.instanceId !== undefined &&
        coordination.instanceId !== lead.instanceId)
    )
      throw new Error("Lead changed; reopen staff.");
    const verified = await host.listAllHerdrAgents(host.pi, ctx, ctx.signal);
    if (!isCurrent() || currentGeneration !== generation(ctx))
      throw new Error("Lead changed; reopen staff.");
    const matches = verified.agents.filter(
      (candidate: any) =>
        host.isPiAgent(candidate) &&
        host.herdrSessionId(candidate) === leadId &&
        typeof candidate?.pane_id === "string" &&
        (parentManagerSessionId ||
          (candidate?.pane_id === lead.paneId &&
            candidate?.tab_id === lead.tabId &&
            candidate?.workspace_id === lead.workspaceId)),
    );
    if (matches.length !== 1) throw new Error("Lead changed; reopen staff.");
    if (
      currentGeneration !== generation(ctx) ||
      !isCurrent() ||
      (verifiedParent &&
        !host
          .listManagerDescriptors(host.supervisionRuntime())
          .some((descriptor) =>
            host.sameManagerDescriptor(descriptor, verifiedParent),
          ))
    )
      throw new Error("Manager changed; reopen staff.");
    const currentAgent = await host.runHerdr(
      host.pi,
      ctx,
      ["agent", "get", matches[0]!.pane_id],
      { signal: ctx.signal },
    );
    if (
      !isCurrent() ||
      host.herdrSessionId(currentAgent?.agent) !== leadId ||
      currentAgent?.agent?.pane_id !== matches[0]!.pane_id ||
      currentAgent?.agent?.workspace_id !== matches[0]!.workspace_id ||
      currentAgent?.agent?.tab_id !== matches[0]!.tab_id
    )
      throw new Error("Lead changed; reopen staff.");
    await host.runHerdr(
      host.pi,
      ctx,
      ["agent", "focus", currentAgent.agent.pane_id],
      {
        signal: ctx.signal,
      },
    );
  };

  const nextOverviewGeneration = (): number => ++overviewGeneration;
  const openOverview = async (
    ctx: ExtensionCommandContext,
    uiActions: {
      focusLead(ctx: ExtensionContext, leadId: string): Promise<void>;
      stopProjectLead(
        ...args: Parameters<LeadProjectRuntime["stop"]>
      ): ReturnType<LeadProjectRuntime["stop"]>;
      activateProjectLead(
        ...args: Parameters<LeadProjectRuntime["activateProjectLead"]>
      ): ReturnType<LeadProjectRuntime["activateProjectLead"]>;
      removeWorktree(
        ...args: Parameters<LeadProjectRuntime["removeWorktree"]>
      ): ReturnType<LeadProjectRuntime["removeWorktree"]>;
      forgetLegacyProjectAssignment(
        ...args: Parameters<LeadProjectRuntime["forgetLegacyProjectAssignment"]>
      ): ReturnType<LeadProjectRuntime["forgetLegacyProjectAssignment"]>;
      inspectRequiredEvidence(
        branch: string,
        ctx: ExtensionContext,
      ): Promise<ProjectAssignment>;
      removeRequiredEvidence(
        branch: string,
        id: string,
        expectedAssignment: ProjectAssignment,
        ctx: ExtensionContext,
      ): Promise<unknown>;
      selectMenu(
        ctx: ExtensionContext,
        title: string,
        items: readonly SelectItem[],
        selectedValue?: string,
      ): Promise<string | undefined>;
    },
  ): Promise<void> => {
    if (ctx.mode !== "tui") {
      await refresh(ctx);
      ctx.ui.notify(host.formatSupervisionNotification(snapshot, status(ctx)));
      return;
    }
    type Selection =
      | {
          kind: "project";
          branch: string;
          session: string;
          status: string;
          liveLead: boolean;
        }
      | {
          kind: "lead";
          session: string;
          label: string;
          relationship?: "assigned" | "supervised";
        };
    let selected: string | undefined;
    while (true) {
      const expectedGeneration = generation(ctx);
      const selection = await ctx.ui.custom<Selection | undefined>(
        (tui: any, theme: any, _keys: any, done: (v: unknown) => void) => {
          const viewGeneration = nextOverviewGeneration();
          const supervisionGeneration = generation(ctx);
          const sessionId = ctx.sessionManager.getSessionId();
          let mode: "overview" | "peek" = "overview";
          let peekRequest = 0;
          let peekLead:
            ReturnType<typeof host.presentationReports>[number] | undefined;
          let peekEvidence: any;
          let list: SelectList | undefined;
          let renderedLeads = "";
          const container = new host.tui.Container();
          const selectTheme = getSelectListTheme();
          const isCurrentOverview = (): boolean =>
            viewGeneration === overviewGeneration &&
            generation(ctx) === supervisionGeneration &&
            ctx.sessionManager.getSessionId() === sessionId &&
            (host.state.chiefMode === "active" ||
              (host.activeRole() === "manager" && !host.state.roleSuspended));
          const finish = (result?: Selection): void => {
            if (viewGeneration === overviewGeneration) nextOverviewGeneration();
            renderOverview = undefined;
            done(result);
          };
          const showOverview = (): void => {
            const status = supervisionStatus(ctx);
            const leads =
              status === "unavailable"
                ? []
                : host.orderedSupervisionLeads(
                    host.presentationReports(snapshot),
                  );
            const work =
              host.activeRole() === "manager" &&
              status !== "unavailable" &&
              "work" in snapshot
                ? (snapshot.work ?? [])
                : [];
            const items: SelectItem[] =
              host.activeRole() === "manager" && status !== "unavailable"
                ? host.managerSupervisionItems(snapshot).map((entry) =>
                    entry.kind === "work"
                      ? {
                          value: `work:${entry.work.branch}`,
                          label: entry.work.branch,
                          description: [
                            entry.work.status,
                            entry.work.runtimeState,
                            entry.work.issue,
                            entry.lead?.compatibility === "incompatible"
                              ? "build mismatch · reload Pi session"
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · "),
                        }
                      : {
                          value: `lead:${entry.lead.lead}`,
                          label:
                            entry.lead.relationship === "supervised"
                              ? entry.lead.displayName
                              : (entry.lead.branch ?? entry.lead.displayName),
                          description: [
                            entry.lead.relationship === "supervised"
                              ? `${entry.lead.runtimeState} · supervised`
                              : entry.lead.runtimeState,
                            entry.lead.compatibility === "incompatible"
                              ? "build mismatch · reload Pi session"
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · "),
                        },
                  )
                : leads.map((lead) => ({
                    value: lead.lead,
                    label: lead.displayName,
                    description: `${lead.runtimeState}${lead.compatibility === "incompatible" ? " · build mismatch" : (lead.agentCounts?.total ?? 0) ? ` · ${lead.agentCounts!.total} agent${lead.agentCounts!.total === 1 ? "" : "s"}` : ""}`,
                  }));
            if (!items.some((item) => item.value === selected))
              selected = items[0]?.value;
            const maxPrimaryColumnWidth = Math.max(
              12,
              ...items.map((item) => visibleWidth(item.label) + 2),
            );
            list = new host.tui.SelectList(items, 8, selectTheme, {
              minPrimaryColumnWidth: 12,
              maxPrimaryColumnWidth,
            });
            const index = items.findIndex((item) => item.value === selected);
            if (index >= 0) list.setSelectedIndex(index);
            list.onSelectionChange = (item) => {
              if (item) selected = item.value;
            };
            list.onSelect = (item) => {
              if (!item || !isCurrentOverview()) return;
              if (
                host
                  .presentationReports(snapshot)
                  .find(
                    (candidate) =>
                      candidate.lead ===
                      (item.value.startsWith("lead:")
                        ? item.value.slice("lead:".length)
                        : item.value),
                  )?.compatibility === "incompatible"
              )
                return;
              if (item.value.startsWith("work:")) {
                const branch = item.value.slice("work:".length);
                const entry = work.find(
                  (candidate) => candidate.branch === branch,
                );
                const workItem = host
                  .managerSupervisionItems(snapshot)
                  .find(
                    (candidate) =>
                      candidate.kind === "work" &&
                      candidate.work.branch === branch,
                  );
                if (
                  !entry ||
                  workItem?.kind !== "work" ||
                  workItem.lead?.compatibility === "incompatible"
                )
                  return;
                const liveLead = !!workItem.lead;
                finish({
                  kind: "project",
                  branch,
                  session: entry.session,
                  status: entry.status,
                  liveLead,
                });
                return;
              }
              const leadSession = item.value.startsWith("lead:")
                ? item.value.slice("lead:".length)
                : item.value;
              const report = host
                .presentationReports(snapshot)
                .find((candidate) => candidate.lead === leadSession);
              finish({
                kind: "lead",
                session: leadSession,
                label: item.label,
                ...(report?.relationship
                  ? { relationship: report.relationship }
                  : {}),
              });
            };
            list.onCancel = finish;
            const title =
              status === "unavailable"
                ? "Pi Herdsman · unavailable"
                : host.activeRole() === "manager" && "project" in snapshot
                  ? `Pi Herdsman · ${snapshot.project}`
                  : `Pi Herdsman · ${leads.length} herd${leads.length === 1 ? "" : "s"}${status === "stale" ? " · stale" : ""}`;
            populateMenuFrame(
              container,
              theme,
              title,
              list,
              host.activeRole() === "manager"
                ? "Enter actions · Esc close"
                : "Space peek · Enter focus · Esc close",
            );
            renderedLeads = [
              status,
              ...work.map(
                (item) =>
                  `${item.branch}:${item.status}:${item.runtimeState ?? ""}:${item.issue ?? ""}`,
              ),
              ...leads.map(
                (lead) =>
                  `${lead.lead}:${lead.runtimeState}:${lead.agentCounts?.total ?? ""}:${lead.compatibility ?? ""}`,
              ),
            ].join("\0");
          };
          const showPeek = (): void => {
            if (!peekLead) return;
            const body = new host.tui.Text(
              host
                .renderSupervisionPeek(peekLead, peekEvidence, 10_000)
                .join("\n"),
              1,
              0,
            );
            populateMenuFrame(
              container,
              theme,
              `Peek · ${peekLead.displayName}`,
              body,
              "Esc back · Enter focus · Ctrl+C close",
            );
          };
          const component = {
            render(width: number): string[] {
              const status = supervisionStatus(ctx);
              const leads =
                status === "unavailable"
                  ? []
                  : host.orderedSupervisionLeads(
                      host.presentationReports(snapshot),
                    );
              if (mode === "peek" && peekLead) return container.render(width);
              const key = [
                status,
                ...("work" in snapshot
                  ? (snapshot.work?.map(
                      (item) =>
                        `${item.branch}:${item.status}:${item.runtimeState ?? ""}:${item.issue ?? ""}`,
                    ) ?? [])
                  : []),
                ...leads.map(
                  (lead) =>
                    `${lead.lead}:${lead.runtimeState}:${lead.agentCounts?.total ?? ""}:${lead.compatibility ?? ""}`,
                ),
              ].join("\0");
              if (!list || key !== renderedLeads) showOverview();
              return container.render(width);
            },
            invalidate() {
              tui.requestRender();
            },
            handleInput(data: string) {
              if (host.tui.matchesKey(data, host.tui.Key.ctrl("c")))
                return finish();
              if (mode === "peek") {
                if (
                  host.tui.matchesKey(data, host.tui.Key.escape) ||
                  host.tui.matchesKey(data, host.tui.Key.space)
                ) {
                  peekRequest++;
                  mode = "overview";
                  showOverview();
                  tui.requestRender();
                } else if (
                  host.tui.matchesKey(data, host.tui.Key.enter) &&
                  peekLead
                )
                  finish({
                    kind: "lead",
                    session: peekLead.lead,
                    label: peekLead.displayName,
                  });
                return;
              }
              if (host.tui.matchesKey(data, host.tui.Key.space)) {
                const leadId = selected?.startsWith("lead:")
                  ? selected.slice("lead:".length)
                  : selected;
                const lead = host
                  .presentationReports(snapshot)
                  .find((item) => item.lead === leadId);
                if (!lead || lead.compatibility === "incompatible") return;
                const request = ++peekRequest;
                peekLead = lead;
                peekEvidence = {
                  agents: (lead.agents ?? []).map(
                    (agent) => `${agent.label} · ${agent.state}`,
                  ),
                };
                mode = "peek";
                showPeek();
                tui.requestRender();
                void host
                  .inspectHerdrAgent(
                    host.pi,
                    ctx,
                    {
                      workspaceId: lead.workspaceId,
                      paneId: lead.paneId,
                      piSessionId: lead.lead,
                    },
                    ctx.signal,
                    async (agent: any) => {
                      if (
                        !isCurrentOverview() ||
                        !host.isPiAgent(agent) ||
                        agent?.pane_id !== lead.paneId ||
                        agent?.tab_id !== lead.tabId ||
                        host.herdrSessionId(agent) !== lead.lead ||
                        host.readLeadCoordinationState(
                          host.supervisionRuntime(),
                          lead.lead,
                        )?.piSessionId !== lead.lead ||
                        !lead.availableActions.includes("inspect")
                      )
                        return false;
                      const current = (await directReports(ctx)).find(
                        (candidate) =>
                          candidate.lead === lead.lead &&
                          candidate.instanceId === lead.instanceId &&
                          candidate.workspaceId === lead.workspaceId &&
                          candidate.paneId === lead.paneId &&
                          candidate.tabId === lead.tabId &&
                          candidate.availableActions.includes("inspect"),
                      );
                      return isCurrentOverview() && !!current;
                    },
                  )
                  .then((inspection) => {
                    if (
                      !isCurrentOverview() ||
                      mode !== "peek" ||
                      request !== peekRequest
                    )
                      return;
                    peekEvidence = {
                      recentOutput: inspection.recentOutput,
                      process: inspection.process,
                      agents: lead.agents.map(
                        (agent) => `${agent.label} · ${agent.state}`,
                      ),
                    };
                    mode = "peek";
                    showPeek();
                    tui.requestRender();
                  })
                  .catch(() => undefined);
                return;
              }
              list?.handleInput(data);
            },
          };
          showOverview();
          renderOverview = () => tui.requestRender();
          void refresh(ctx)
            .then(() => tui.requestRender())
            .catch(() => undefined);
          void theme;
          return component;
        },
      );
      if (!selection || generation(ctx) !== expectedGeneration) return;
      if (selection.kind === "lead") {
        if (host.activeRole() === "manager") {
          const action = await uiActions.selectMenu(ctx, selection.label, [
            { value: "focus", label: "Focus" },
            ...(selection.relationship === "supervised"
              ? []
              : [{ value: "stop", label: "Stop Lead" }]),
          ]);
          if (generation(ctx) !== expectedGeneration) return;
          if (!action) continue;
          try {
            if (action === "focus") {
              await uiActions.focusLead(ctx, selection.session);
              return;
            }
            await uiActions.stopProjectLead(selection.session, ctx, ctx.signal);
          } catch (error) {
            ctx.ui.notify(String(error).replace(/^Error: /u, ""), "error");
          }
        } else {
          try {
            await uiActions.focusLead(ctx, selection.session);
            return;
          } catch (error) {
            ctx.ui.notify(String(error).replace(/^Error: /u, ""), "error");
          }
        }
        await refresh(ctx);
        if (generation(ctx) !== expectedGeneration) return;
        continue;
      }
      const actions = [
        ...(selection.status === "paused"
          ? [{ value: "resume", label: "Resume" }]
          : selection.liveLead
            ? [
                { value: "focus", label: "Focus Lead" },
                { value: "stop", label: "Stop Lead" },
              ]
            : []),
        { value: "remove", label: "Remove worktree…" },
        ...(host.activeRole() === "manager" && selection.status === "paused"
          ? [{ value: "forget", label: "Forget orphaned assignment…" }]
          : []),
        ...(host.activeRole() === "manager"
          ? [{ value: "required-evidence", label: "Retained evidence" }]
          : []),
      ];
      const action = await uiActions.selectMenu(ctx, selection.branch, actions);
      if (generation(ctx) !== expectedGeneration) return;
      if (!action) continue;
      try {
        if (action === "focus") {
          await uiActions.focusLead(ctx, selection.session);
          return;
        }
        if (action === "stop")
          await uiActions.stopProjectLead(selection.session, ctx, ctx.signal);
        else if (action === "resume")
          await uiActions.activateProjectLead(
            { action: "resume", branch: selection.branch },
            ctx,
            ctx.signal,
          );
        else if (action === "remove") {
          const result = await uiActions.removeWorktree(
            selection.branch,
            ctx,
            ctx.signal,
          );
          ctx.ui.notify(
            result.content[0]?.text ?? "Removal finished.",
            result.details.ok
              ? "info"
              : result.details.cancelled
                ? "info"
                : "warning",
          );
        } else if (action === "forget") {
          const result = await uiActions.forgetLegacyProjectAssignment(
            selection.branch,
            ctx,
            ctx.signal,
          );
          ctx.ui.notify(
            result.content[0]?.text ??
              `Forget of ${selection.branch} finished.`,
            result.details.ok || result.details.cancelled ? "info" : "warning",
          );
        } else if (action === "required-evidence") {
          const assignment = await uiActions.inspectRequiredEvidence(
            selection.branch,
            ctx,
          );
          const entries = assignment.requiredEvidence ?? [];
          if (!entries.length) {
            ctx.ui.notify("This assignment has no required evidence.", "info");
          } else {
            const selectedEvidence = await uiActions.selectMenu(
              ctx,
              `Retained evidence · ${selection.branch}`,
              entries.map((entry) => ({
                value: entry.id,
                label: `${entry.id} · ${entry.name} · ${"sourceAssignmentId" in entry ? `project ${entry.sourceAssignmentId}` : `result ${entry.result.ref}`}`,
              })),
            );
            if (selectedEvidence) {
              const entry = entries.find(({ id }) => id === selectedEvidence);
              if (!entry)
                throw new Error("Required evidence selection is invalid");
              const detail = `${entry.id}\n${entry.name}\nOrigin: ${"sourceAssignmentId" in entry ? `project assignment ${entry.sourceAssignmentId}` : `Agent result ${entry.result.ref}`}`;
              const inherited =
                "sourceAssignmentId" in entry &&
                entry.sourceAssignmentId !== assignment.id;
              const remove = await uiActions.selectMenu(ctx, detail, [
                ...(!inherited
                  ? [{ value: "remove", label: "Remove requirement…" }]
                  : []),
                {
                  value: "cancel",
                  label: inherited
                    ? "Inherited requirement · protected"
                    : "Cancel",
                },
              ]);
              if (remove === "remove") {
                const confirmation = await uiActions.selectMenu(
                  ctx,
                  `Remove required evidence ${entry.id}?`,
                  [
                    { value: "confirm", label: "Remove requirement" },
                    { value: "cancel", label: "Cancel" },
                  ],
                );
                if (confirmation === "confirm") {
                  await uiActions.removeRequiredEvidence(
                    selection.branch,
                    entry.id,
                    assignment,
                    ctx,
                  );
                  ctx.ui.notify(
                    "Required evidence removed. Existing Agent assignments and snapshots are unchanged.",
                    "info",
                  );
                }
              }
            }
          }
        }
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /u, ""), "error");
      }
      await refresh(ctx);
      if (generation(ctx) !== expectedGeneration) return;
    }
  };

  return {
    get snapshot() {
      return snapshot;
    },
    status,
    generation,
    reset,
    refresh,
    openOverview,
    loadSnapshot: loadSupervisionSnapshot,
    directReports,
    focusLead,
    focusChief: async (ctx: ExtensionCommandContext): Promise<void> => {
      const confirmed = await ctx.ui.confirm(
        "Focus Chief?",
        "Focus the currently active Chief pane?",
      );
      if (!confirmed) return;
      const descriptor = host.readChiefDescriptor(
        host.supervisionRuntime().descriptor,
      );
      const candidate = await host.remoteChiefAgent(ctx, descriptor);
      const current = host.readChiefDescriptor(
        host.supervisionRuntime().descriptor,
      );
      if (!candidate || !host.sameChiefDescriptor(current, descriptor))
        throw new Error("Chief changed; reopen the command.");
      await host.runHerdr(host.pi, ctx, ["agent", "focus", candidate.pane_id], {
        signal: ctx.signal,
      });
    },
    prepareMessage: async (
      ctx: ExtensionContext,
    ): Promise<
      { customType: string; content: string; display: boolean } | undefined
    > => {
      if (!host.isCurrentChief(ctx) && host.activeRole() !== "manager") return;
      const currentGeneration = generation(ctx);
      const isCurrent = (): boolean =>
        (host.isCurrentChief(ctx) || host.activeRole() === "manager") &&
        generation(ctx) === currentGeneration;
      try {
        await refresh(ctx);
        if (!isCurrent()) return;
        const contextStatus = status(ctx);
        const targets = new Map<string, string>();
        const candidates: {
          role: "lead" | "manager";
          session: string;
          target: string;
        }[] = [];
        if (contextStatus !== "unavailable" && snapshot) {
          for (const report of host.presentationReports(snapshot)) {
            if (
              report.compatibility === "incompatible" ||
              !report.availableActions?.length ||
              report.relationship === "assigned" ||
              (report.role !== "lead" && report.role !== "manager")
            )
              continue;
            const target = coordinatorTarget(report.role, report.lead);
            targets.set(report.lead, target);
            candidates.push({
              role: report.role,
              session: report.lead,
              target,
            });
          }
        }
        const content = host.formatContext(
          contextStatus === "unavailable" ? undefined : snapshot,
          {
            status: contextStatus,
            role: host.activeRole() === "manager" ? "manager" : "chief",
            targets,
          },
        );
        for (const candidate of candidates)
          if (content.split("\n").includes(`  target: ${candidate.target}`))
            rememberCoordinatorTarget(
              host.pi,
              ctx,
              candidate.role,
              candidate.session,
            );
        if (host.latestMessageText(ctx) === content) return;
        return { customType: host.contextType, content, display: false };
      } catch {
        // Automatic observation must not prevent a Chief or Manager run.
      }
    },
    setWidgetRender: (render: (() => void) | undefined) => {
      renderWidget = render;
    },
    registerWidget: (ctx: ExtensionContext, role: "chief" | "manager") => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      try {
        const widgetGeneration = ++supervisionWidgetGeneration;
        ctx.ui.setWidget("pi-herdsman-staff", (tui: any, theme: any) => {
          renderWidget = () => tui.requestRender();
          return createSupervisionWidget(
            () => snapshot,
            () => status(ctx),
            role,
            theme,
            (intent) => {
              if (
                widgetFocusInFlight ||
                widgetGeneration !== supervisionWidgetGeneration ||
                generation(ctx) !== generationId ||
                status(ctx) !== "fresh"
              )
                return;
              if (intent.kind !== "session") return;
              widgetFocusInFlight = true;
              const isCurrent = () =>
                widgetGeneration === supervisionWidgetGeneration &&
                uiContext === ctx &&
                generation(ctx) === generationId;
              void focusLead(
                ctx,
                intent.sessionId,
                intent.parentSessionId,
                isCurrent,
              )
                .catch((error) => {
                  if (isCurrent())
                    ctx.ui.notify(
                      String(error).replace(/^Error: /u, ""),
                      "warning",
                    );
                })
                .finally(() => {
                  widgetFocusInFlight = false;
                });
            },
          );
        });
      } catch {
        renderWidget = undefined;
        throw new Error("Unable to register the supervision widget");
      }
    },
    removeWidget: (ctx: ExtensionContext) => {
      supervisionWidgetGeneration++;
      widgetFocusInFlight = false;
      try {
        ctx.ui.setWidget("pi-herdsman-staff", undefined);
      } catch {
        // Widget teardown is best-effort during UI failure or shutdown.
      }
    },
    startPeriodic: (ctx: ExtensionContext) => {
      if (timer) clearInterval(timer);
      if (redrawTimer) clearInterval(redrawTimer);
      timer = undefined;
      redrawTimer = undefined;
      uiContext = undefined;
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      uiContext = ctx;
      timer = setInterval(() => {
        if (uiContext === ctx) void refresh(ctx);
      }, 10_000);
      timer.unref?.();
      if (host.activeRole() === "manager") {
        redrawTimer = setInterval(() => {
          if (uiContext === ctx) renderWidget?.();
        }, 2000);
        redrawTimer.unref?.();
      }
    },
    requestRefresh: () => {
      if (uiContext) void refresh(uiContext);
    },
    stopPeriodic: () => {
      pending = undefined;
      uiContext = undefined;
      renderOverview = undefined;
      renderWidget = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (redrawTimer) clearInterval(redrawTimer);
      redrawTimer = undefined;
    },
  };
}

export function createLeadHerdRunRuntime(host: LeadHerdRunHost) {
  let leadAgentStartedAt: number | undefined;
  let leadReportId: string | undefined;
  let herdRunStartedAt: number | undefined;
  let herdReportId: string | undefined;
  let leadSettled = true;
  let observation:
    | { outcome?: string; responseEntryId?: string; responseText?: string }
    | undefined;
  let lastSettledRun:
    { aborted: boolean; outcome?: string; summary?: string } | undefined;
  const publishProjectHandoff = async (
    ctx: ExtensionContext,
    message: string,
    reportId = herdReportId,
    kind?: ProjectMessage["kind"],
    createdAt = Date.now(),
    target?: "project" | "chief",
  ): Promise<boolean> => {
    const role = host.activeRole();
    if (kind === "execution_failure" && !reportId) return false;
    if (target === "project") {
      if (role !== "lead") return false;
      const assignment = await host.currentProjectAssignment(ctx);
      if (!assignment) return false;
      return !!(await host.publishProjectMessage(
        ctx,
        assignment,
        message,
        [],
        "herd_run",
        reportId,
        kind,
      ));
    }
    if (target === "chief") {
      if (kind !== "execution_failure" || role === "chief") return false;
      if (role === "lead" && (await host.currentProjectAssignment(ctx)))
        return false;
      return host.publishChiefFailure(ctx, message, reportId!, role, createdAt);
    }
    // A legacy report without a saved destination cannot be safely rerouted.
    return false;
  };
  let finishing: Promise<void> | undefined;
  let idleFinishing: Promise<void> | undefined;
  const maybeFinish = (ctx: ExtensionContext): Promise<void> => {
    if (finishing) return finishing;
    if (herdRunStartedAt === undefined || !leadSettled)
      return Promise.resolve();
    const sessionId = ctx.sessionManager.getSessionId();
    if (
      host.hasPendingStarts() ||
      host
        .listAgentStates()
        .some(
          ({ state }: { state: ManagedAgentState }) =>
            state.ownerSessionId === sessionId,
        )
    )
      return Promise.resolve();
    const startedAt = herdRunStartedAt;
    const completedAt = Date.now();
    finishing = (async () => {
      try {
        const outcome = lastSettledRun;
        // Failed/cancelled herd runs are reported at settlement, before children
        // finish. Assigned projects require a completion handoff.
        if (outcome?.outcome === "completed") {
          const message = outcome.summary
            ? `Herd run settled.\n\n${outcome.summary}`
            : "Herd run settled without a verified Lead integration summary.";
          let reportMessage = message;
          let pending: any;
          const managed = host.isManagedLead();
          if (managed) {
            const entries = ctx.sessionManager.getEntries() as any[];
            pending = entries.find(
              (entry) =>
                entry?.type === "custom" &&
                entry.customType === host.entryName &&
                entry.data?.sessionId === sessionId &&
                entry.data?.phase === "report_pending" &&
                entry.data?.reportId === herdReportId,
            )?.data;
            reportMessage = pending?.message ?? message;
            if (!pending)
              host.pi.appendEntry(host.entryName, {
                phase: "report_pending",
                sessionId,
                startedAt,
                reportId: herdReportId,
                message: reportMessage,
                target: "project",
              });
          }
          const assignment = managed
            ? pending
              ? pending.target === "project"
                ? await host.currentProjectAssignment(ctx)
                : undefined
              : await host.currentProjectAssignment(ctx)
            : undefined;
          if (managed && !assignment) return;
          if (assignment) {
            if (
              !(await host.publishProjectMessage(
                ctx,
                assignment,
                reportMessage,
                [],
                "herd_run",
                herdReportId,
              ))
            )
              return;
            host.pi.appendEntry(host.entryName, {
              phase: "report_sent",
              sessionId,
              startedAt,
              reportId: herdReportId,
            });
          }
        } else if (outcome) {
          const entries = ctx.sessionManager.getEntries() as any[];
          const pending = entries.find(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === host.entryName &&
              entry.data?.sessionId === sessionId &&
              entry.data?.phase === "report_pending" &&
              entry.data?.runReportId === herdReportId,
          )?.data;
          if (pending) {
            const sent = entries.some(
              (entry) =>
                entry?.type === "custom" &&
                entry.customType === host.entryName &&
                entry.data?.sessionId === sessionId &&
                entry.data?.phase === "report_sent" &&
                entry.data?.reportId === pending.reportId,
            );
            if (!sent) {
              if (
                !(await publishProjectHandoff(
                  ctx,
                  pending.message,
                  pending.reportId,
                  pending.kind,
                  pending.createdAt,
                  pending.target,
                ))
              )
                return;
              host.pi.appendEntry(host.entryName, {
                phase: "report_sent",
                sessionId,
                startedAt: pending.startedAt,
                reportId: pending.reportId,
                runReportId: herdReportId,
              });
            }
          }
        } else if (!outcome) {
          const pending = (ctx.sessionManager.getEntries() as any[]).find(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === host.entryName &&
              entry.data?.sessionId === sessionId &&
              entry.data?.phase === "report_pending" &&
              entry.data?.reportId === herdReportId,
          )?.data;
          const message =
            pending?.message ??
            "Lead execution outcome was not preserved across restoration; work remains unresolved.";
          const reportCreatedAt =
            typeof pending?.createdAt === "number" &&
            Number.isFinite(pending.createdAt)
              ? pending.createdAt
              : Date.now();
          const target = pending
            ? pending.target
            : host.isManagedLead()
              ? "project"
              : "chief";
          if (!pending)
            host.pi.appendEntry(host.entryName, {
              phase: "report_pending",
              sessionId,
              startedAt,
              reportId: herdReportId,
              message,
              kind: "execution_failure",
              createdAt: reportCreatedAt,
              target,
            });
          if (
            !(await publishProjectHandoff(
              ctx,
              message,
              herdReportId,
              "execution_failure",
              reportCreatedAt,
              target,
            ))
          )
            return;
          host.pi.appendEntry(host.entryName, {
            phase: "report_sent",
            sessionId,
            startedAt,
            reportId: herdReportId,
          });
        }
        host.pi.appendEntry(host.entryName, {
          phase: "finished",
          sessionId,
          startedAt,
          completedAt,
          reportId: herdReportId,
        });
        lastSettledRun = undefined;
        herdRunStartedAt = undefined;
        herdReportId = undefined;
        host.requestStatusRefresh();
        host.queueLeadPresentation(ctx);
      } catch (error) {
        host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
      }
    })().finally(() => {
      finishing = undefined;
    });
    return finishing;
  };
  const begin = (ctx: ExtensionContext): void => {
    // Root ownership is structural; only Lead-origin assignments start tracking.
    if (!host.isVerifiedActiveLead() || herdRunStartedAt !== undefined) return;
    const startedAt = leadAgentStartedAt ?? Date.now();
    herdRunStartedAt = startedAt;
    herdReportId = randomUUID();
    host.queueLeadPresentation(ctx);
    try {
      host.pi.appendEntry(host.entryName, {
        phase: "started",
        sessionId: ctx.sessionManager.getSessionId(),
        startedAt,
        reportId: herdReportId,
      });
    } catch (error) {
      host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
    }
    host.requestStatusRefresh();
  };
  const restorePendingReports = async (
    ctx: ExtensionContext,
    entries: unknown[],
  ) => {
    const pending = new Map<
      string,
      {
        startedAt: number;
        message: string;
        kind?: ProjectMessage["kind"];
        createdAt: number;
        runReportId?: string;
        target?: "project" | "chief";
      }
    >();
    for (const entry of entries as any[]) {
      if (entry?.type !== "custom" || entry.customType !== host.entryName)
        continue;
      const data = entry.data;
      if (
        data?.sessionId !== ctx.sessionManager.getSessionId() ||
        typeof data.reportId !== "string"
      )
        continue;
      if (data.phase === "report_pending" && typeof data.message === "string") {
        const previous = pending.get(data.reportId);
        const createdAt =
          typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
            ? data.createdAt
            : data.startedAt;
        if (
          previous &&
          (previous.message !== data.message ||
            previous.kind !== data.kind ||
            previous.createdAt !== createdAt ||
            previous.runReportId !== data.runReportId ||
            previous.target !== data.target)
        )
          throw new Error(
            "Lead report identity conflicts with durable payload",
          );
        pending.set(data.reportId, {
          startedAt: data.startedAt,
          message: data.message,
          kind: data.kind,
          createdAt,
          runReportId: data.runReportId,
          target:
            data.target === "project" || data.target === "chief"
              ? data.target
              : undefined,
        });
      }
      if (data.phase === "report_sent") pending.delete(data.reportId);
    }
    for (const [reportId, report] of pending) {
      if (
        await publishProjectHandoff(
          ctx,
          report.message,
          reportId,
          report.kind,
          report.createdAt,
          report.target,
        )
      )
        host.pi.appendEntry(host.entryName, {
          phase: "report_sent",
          sessionId: ctx.sessionManager.getSessionId(),
          startedAt: report.startedAt,
          reportId,
          ...(report.runReportId ? { runReportId: report.runReportId } : {}),
        });
    }
  };
  return {
    begin,
    maybeFinish,
    hasActiveTurn: () => leadAgentStartedAt !== undefined,
    agentStarted: () => {
      leadAgentStartedAt = Date.now();
      leadReportId = randomUUID();
      observation = {};
      leadSettled = false;
    },
    turnEnd: (event: any) => {
      if (!observation || event?.message?.role !== "assistant") return;
      observation = {
        outcome: event.outcome,
        responseEntryId: event.messageEntryId,
        responseText: contentText(event.message.content, "").trim(),
      };
    },
    beforeSettle: (event: any) => {
      if (observation) observation.outcome = event?.outcome;
    },
    agentSettled: async (ctx: ExtensionContext, aborted: boolean) => {
      const turnStartedAt = leadAgentStartedAt;
      leadAgentStartedAt = undefined;
      const herdOwnsHandoff = herdRunStartedAt !== undefined;
      const current = observation;
      observation = undefined;
      const successful =
        !aborted &&
        current?.outcome === "completed" &&
        current.responseEntryId !== undefined;
      const summary = successful ? current.responseText : undefined;
      if (herdOwnsHandoff)
        lastSettledRun = { aborted, outcome: current?.outcome, summary };
      leadSettled = true;
      if (!successful && !aborted && turnStartedAt !== undefined) {
        const reportCreatedAt = Date.now();
        const partial = current?.responseText?.slice(0, 1000);
        const detail = partial
          ? `\n\nPartial response (not completed):\n${partial}`
          : "";
        const message = `${current?.outcome === "error" ? "Lead model execution failed before completion." : "Lead execution settled without verified completion."}${detail}`;
        try {
          const target =
            host.activeRole() === "lead" && host.isManagedLead()
              ? "project"
              : "chief";
          host.pi.appendEntry(host.entryName, {
            phase: "report_pending",
            sessionId: ctx.sessionManager.getSessionId(),
            startedAt: turnStartedAt,
            reportId: leadReportId,
            ...(herdOwnsHandoff ? { runReportId: herdReportId } : {}),
            message,
            kind: "execution_failure",
            createdAt: reportCreatedAt,
            target,
          });
          const published = await publishProjectHandoff(
            ctx,
            message,
            leadReportId,
            "execution_failure",
            reportCreatedAt,
            target,
          );
          if (published)
            host.pi.appendEntry(host.entryName, {
              phase: "report_sent",
              sessionId: ctx.sessionManager.getSessionId(),
              startedAt: turnStartedAt,
              reportId: leadReportId,
              ...(herdOwnsHandoff ? { runReportId: herdReportId } : {}),
            });
        } catch (error) {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          );
        }
      } else if (aborted && turnStartedAt !== undefined) {
        const reportCreatedAt = Date.now();
        const message =
          "Lead execution was cancelled before a completed response.";
        try {
          host.pi.appendEntry(host.entryName, {
            phase: "report_pending",
            sessionId: ctx.sessionManager.getSessionId(),
            startedAt: turnStartedAt,
            reportId: leadReportId,
            createdAt: reportCreatedAt,
            ...(herdOwnsHandoff ? { runReportId: herdReportId } : {}),
            message,
            target: "project",
          });
          if (
            await publishProjectHandoff(
              ctx,
              message,
              leadReportId,
              undefined,
              reportCreatedAt,
              "project",
            )
          )
            host.pi.appendEntry(host.entryName, {
              phase: "report_sent",
              sessionId: ctx.sessionManager.getSessionId(),
              startedAt: turnStartedAt,
              reportId: leadReportId,
              ...(herdOwnsHandoff ? { runReportId: herdReportId } : {}),
            });
        } catch (error) {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          );
        }
      } else if (
        !herdOwnsHandoff &&
        successful &&
        summary &&
        turnStartedAt !== undefined &&
        leadReportId
      ) {
        try {
          if (host.isManagedLead()) {
            const sessionId = ctx.sessionManager.getSessionId();
            const pending = (ctx.sessionManager.getEntries() as any[]).some(
              (entry) =>
                entry?.type === "custom" &&
                entry.customType === host.entryName &&
                entry.data?.sessionId === sessionId &&
                entry.data?.phase === "report_pending" &&
                entry.data?.reportId === leadReportId,
            );
            if (!pending)
              host.pi.appendEntry(host.entryName, {
                phase: "report_pending",
                sessionId,
                startedAt: turnStartedAt,
                reportId: leadReportId,
                message: summary,
                target: "project",
              });
          }
          const assignment =
            !host.isManagedLead() ||
            (ctx.sessionManager.getEntries() as any[]).some(
              (entry) =>
                entry?.type === "custom" &&
                entry.customType === host.entryName &&
                entry.data?.sessionId === ctx.sessionManager.getSessionId() &&
                entry.data?.phase === "report_pending" &&
                entry.data?.reportId === leadReportId &&
                entry.data?.target !== "project",
            )
              ? undefined
              : await host.currentProjectAssignment(ctx);
          if (assignment) {
            if (
              await host.publishProjectMessage(
                ctx,
                assignment,
                summary,
                [],
                "herd_run",
                leadReportId,
              )
            )
              host.pi.appendEntry(host.entryName, {
                phase: "report_sent",
                sessionId: ctx.sessionManager.getSessionId(),
                startedAt: turnStartedAt,
                reportId: leadReportId,
              });
          }
        } catch (error) {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          );
        }
      }
      await maybeFinish(ctx);
      if (!herdOwnsHandoff && turnStartedAt !== undefined) {
        leadReportId = undefined;
      }
    },
    restoreSession: (entries: unknown[], sessionId: string) => {
      leadAgentStartedAt = undefined;
      herdRunStartedAt = restoreHerdRunStartedAt(
        entries,
        sessionId,
        host.entryName,
      );
      herdReportId = restoreHerdRunReportId(entries, sessionId, host.entryName);
      if (herdRunStartedAt !== undefined && !herdReportId) {
        herdReportId = randomUUID();
        host.pi.appendEntry(host.entryName, {
          phase: "started",
          sessionId,
          startedAt: herdRunStartedAt,
          reportId: herdReportId,
        });
      }
      const hasReportIntent = (entries as any[]).some(
        (entry) =>
          entry?.type === "custom" &&
          entry.customType === host.entryName &&
          entry.data?.sessionId === sessionId &&
          !!herdReportId &&
          (entry.data?.reportId === herdReportId ||
            entry.data?.runReportId === herdReportId) &&
          entry.data?.phase === "report_sent",
      );
      const hasUnsentHerdIntent = (entries as any[]).some((entry) => {
        const data = entry?.data;
        return (
          entry?.type === "custom" &&
          entry.customType === host.entryName &&
          data?.sessionId === sessionId &&
          data?.phase === "report_pending" &&
          !!herdReportId &&
          (data.reportId === herdReportId ||
            data.runReportId === herdReportId) &&
          !(entries as any[]).some(
            (sent) =>
              sent?.type === "custom" &&
              sent.customType === host.entryName &&
              sent.data?.sessionId === sessionId &&
              sent.data?.phase === "report_sent" &&
              sent.data?.reportId === data.reportId,
          )
        );
      });
      lastSettledRun =
        hasReportIntent && !hasUnsentHerdIntent
          ? { aborted: false, outcome: "reported" }
          : undefined;
      leadSettled = herdRunStartedAt === undefined;
    },
    finishIfIdle: (ctx: ExtensionContext) => {
      if (!ctx.isIdle()) return;
      if (idleFinishing) return;
      idleFinishing = (async () => {
        await restorePendingReports(ctx, ctx.sessionManager.getEntries());
        const currentEntries = ctx.sessionManager.getEntries() as any[];
        const hasUnsentHerdIntent = currentEntries.some((entry) => {
          const data = entry?.data;
          return (
            entry?.type === "custom" &&
            entry.customType === host.entryName &&
            data?.sessionId === ctx.sessionManager.getSessionId() &&
            data?.phase === "report_pending" &&
            !!herdReportId &&
            (data.reportId === herdReportId ||
              data.runReportId === herdReportId) &&
            !currentEntries.some(
              (sent) =>
                sent?.type === "custom" &&
                sent.customType === host.entryName &&
                sent.data?.sessionId === ctx.sessionManager.getSessionId() &&
                sent.data?.phase === "report_sent" &&
                sent.data?.reportId === data.reportId,
            )
          );
        });
        if (hasUnsentHerdIntent) return;
        if (
          herdReportId &&
          currentEntries.some(
            (entry) =>
              entry?.type === "custom" &&
              entry.customType === host.entryName &&
              entry.data?.sessionId === ctx.sessionManager.getSessionId() &&
              entry.data?.phase === "report_sent" &&
              (entry.data?.reportId === herdReportId ||
                entry.data?.runReportId === herdReportId),
          )
        )
          lastSettledRun = { aborted: false, outcome: "reported" };
        if (herdRunStartedAt !== undefined) {
          leadSettled = true;
          if (!lastSettledRun) {
            const pending = (ctx.sessionManager.getEntries() as any[]).find(
              (entry) =>
                entry?.type === "custom" &&
                entry.customType === host.entryName &&
                entry.data?.sessionId === ctx.sessionManager.getSessionId() &&
                entry.data?.phase === "report_pending" &&
                entry.data?.reportId === herdReportId,
            )?.data;
            const message =
              pending?.message ??
              "Lead execution outcome was not preserved across restoration; work remains unresolved.";
            const reportCreatedAt =
              typeof pending?.createdAt === "number" &&
              Number.isFinite(pending.createdAt)
                ? pending.createdAt
                : Date.now();
            const target = pending
              ? pending.target
              : host.isManagedLead()
                ? "project"
                : "chief";
            if (!pending)
              host.pi.appendEntry(host.entryName, {
                phase: "report_pending",
                sessionId: ctx.sessionManager.getSessionId(),
                startedAt: herdRunStartedAt,
                reportId: herdReportId,
                message,
                kind: "execution_failure",
                createdAt: reportCreatedAt,
                target,
              });
            const published = await publishProjectHandoff(
              ctx,
              message,
              herdReportId,
              "execution_failure",
              reportCreatedAt,
              target,
            );
            if (published)
              host.pi.appendEntry(host.entryName, {
                phase: "report_sent",
                sessionId: ctx.sessionManager.getSessionId(),
                startedAt: herdRunStartedAt,
                reportId: herdReportId,
              });
            if (published)
              lastSettledRun = { aborted: false, outcome: "reported" };
          }
          await maybeFinish(ctx);
        }
      })()
        .catch((error) =>
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_state_error",
            error,
          ),
        )
        .finally(() => {
          idleFinishing = undefined;
        });
    },
    startedAt: () => herdRunStartedAt,
    shutdown: () => {
      leadAgentStartedAt = undefined;
      herdRunStartedAt = undefined;
      herdReportId = undefined;
      leadReportId = undefined;
      observation = undefined;
      lastSettledRun = undefined;
      leadSettled = true;
    },
  };
}

function restoreHerdRunStartedAt(
  entries: readonly unknown[],
  sessionId: string,
  entryName: string,
): number | undefined {
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  let active: number | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (record.type !== "custom" || record.customType !== entryName) continue;
    if (
      !record.data ||
      typeof record.data !== "object" ||
      Array.isArray(record.data)
    )
      continue;
    const value = record.data as Record<string, unknown>;
    if (value.sessionId !== sessionId) continue;
    if (value.phase === "started" && valid(value.startedAt)) {
      if (active === undefined) active = value.startedAt;
      continue;
    }
    if (
      value.phase === "finished" &&
      valid(value.startedAt) &&
      valid(value.completedAt) &&
      value.completedAt >= value.startedAt &&
      active === value.startedAt
    )
      active = undefined;
  }
  return active;
}

function restoreHerdRunReportId(
  entries: readonly unknown[],
  sessionId: string,
  entryName: string,
): string | undefined {
  let reportId: string | undefined;
  for (const entry of entries as any[]) {
    if (entry?.type !== "custom" || entry.customType !== entryName) continue;
    const data = entry.data;
    if (data?.sessionId !== sessionId) continue;
    if (data.phase === "started" && typeof data.reportId === "string")
      reportId = data.reportId;
    if (data.phase === "finished") reportId = undefined;
  }
  return reportId;
}

export const activeLeadRole = (state: LeadRuntimeState): SessionRole =>
  state.chiefMode === "inactive" ? state.controllerRole : "chief";

function projectAssignmentInstruction(
  assignment: Pick<ProjectAssignment, "text">,
): string {
  return `${assignment.text}

Manager supervises project scope and assignment boundaries; you own technical
decisions and orchestration of execution. Herdsman automatically hands every completed
direct-work response to the Manager role while this assignment remains active. If no Manager is available,
the handoff remains pending until a Manager can receive it. After successfully
delegating or continuing managed Agent work, the herd run owns that handoff
until it settles; summarize outcome, validation, and important unresolved
points in your response.

Use message_supervisor when the Manager needs timely coordination
before the normal result handoff, or when relevant files require
explicit transfer.

Report completion and review readiness in your normal response.
Herdsman delivers it automatically. Do not send a separate completion
announcement through message_supervisor.
Undelivered project handoffs survive Manager absence. Once delivered, they
are not automatically replayed to later Managers. Settlement is nonterminal; do not infer project closure from runtime state.`;
}

export function createLeadInboxRuntime(host: LeadInboxHost) {
  let chiefInboxTimer: ReturnType<typeof setTimeout> | undefined;
  let chiefInboxGeneration = 0;
  let chiefInboxAbortController: AbortController | undefined;
  const REMOTE_POLL_MS = 10_000;
  let nextRemoteReconciliation = 0;
  let remoteReconciliationInFlight = false;
  let currentSubmittedAt: Map<string, number> | undefined;
  let settledSubmissions = new Set<string>();
  type ChiefStartPreflight = {
    sessionId: string;
    sessionGeneration: number;
    chiefModeGeneration: number;
  };
  const chiefStartPreflights: ChiefStartPreflight[] = [];
  const {
    leadRuntime,
    leadInstanceId: getLeadInstanceId,
    controllerScope,
    activeRole,
    supervisionRuntime,
    peerRuntime,
    pi,
    coordinationHealthy,
    appendDurableError,
    managerDiagnostic,
    authorizePeerRecord,
    peerContext,
    assertCurrentLeadCoordination,
    currentChiefAuthority,
    currentManager,
    worktreeGroupScope,
    readProjectAssignment,
    managerForScope,
    listManagerDescriptors,
    remoteChiefAgent,
    liveLead,
    livePeerLead,
    readLeadCoordinationState,
    runHerdr,
    sameRuntimeBuild,
    projectAssignmentInstruction,
    importResultBindings,
    resolvePeerResultBindings,
    describePeerResultConflicts,
    HERDSMAN_BUILD,
    formatRuntimeBuild,
    listChiefMessagePaths,
    chiefMessageQuarantined,
    prepareSupervisionMessage,
    isCurrentChief,
    drainCoordinationInbox,
    currentPeerPresenceValid,
    drainProjectMessages,
    basename,
    managerDiagnosticEvents,
  } = host;
  const chiefStartPreflightHeld = (ctx: ExtensionContext): boolean => {
    if (leadRuntime.chiefMode !== "active") return false;
    const sessionId = ctx.sessionManager.getSessionId();
    return chiefStartPreflights.some(
      (preflight) =>
        preflight.sessionId === sessionId &&
        preflight.sessionGeneration === leadRuntime.sessionGeneration &&
        preflight.chiefModeGeneration === leadRuntime.chiefModeGeneration,
    );
  };
  const clearStartPreflight = (): void => {
    chiefStartPreflights.length = 0;
  };
  const consumeStartPreflight = (ctx: ExtensionContext): void => {
    if (!chiefStartPreflightHeld(ctx)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const index = chiefStartPreflights.findIndex(
      (preflight) =>
        preflight.sessionId === sessionId &&
        preflight.sessionGeneration === leadRuntime.sessionGeneration &&
        preflight.chiefModeGeneration === leadRuntime.chiefModeGeneration,
    );
    if (index >= 0) chiefStartPreflights.splice(index, 1);
  };
  const messageDelivered = (
    ctx: ExtensionContext,
    record: ChiefMessageRecord,
  ): boolean =>
    coordinationMessageDelivered(
      record,
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getEntries(),
    );
  const projectAssignmentAuthorized = (
    authorized: boolean,
    reason: string,
  ): boolean => {
    managerDiagnostic("project_assignment_authorization", {
      outcome: authorized ? "authorized" : "rejected",
      reason,
    });
    return authorized;
  };
  const recordedManagerSender = (
    record: ChiefMessageRecord,
  ): ReturnType<typeof listManagerDescriptors>[number] | undefined => {
    const senders = listManagerDescriptors(supervisionRuntime()).filter(
      (manager) => manager.piSessionId === record.fromSessionId,
    );
    if (senders.length === 1) return senders[0];
    if (senders.length > 1) return undefined;
    // With no valid match, malformed descriptors make absence inconclusive.
    try {
      listManagerDescriptors(supervisionRuntime(), true);
    } catch (error) {
      throw new Error(
        "Manager descriptor verification is temporarily unavailable",
        { cause: error },
      );
    }
    return undefined;
  };
  const authorizeChiefRecord = async (
    record: ChiefMessageRecord,
    ctx: ExtensionContext,
    verifyLiveChief = true,
  ): Promise<boolean> => {
    const sameLiveLead = (current: HerdrRecord, original: HerdrRecord) =>
      current.workspace_id === original.workspace_id &&
      current.pane_id === original.pane_id &&
      current.tab_id === original.tab_id &&
      current.cwd === original.cwd;
    const sessionId = ctx.sessionManager.getSessionId();
    if (record.toSessionId !== sessionId) return false;
    if (!record.build || !sameRuntimeBuild(record.build, HERDSMAN_BUILD))
      return false;
    if (record.kind === "project_assignment") {
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (
        !workspaceId ||
        record.toSessionId !== sessionId ||
        record.leadSessionId !== sessionId
      )
        return projectAssignmentAuthorized(
          false,
          "target_or_workspace_mismatch",
        );
      managerDiagnostic("project_assignment_scope_start");
      const scope = await worktreeGroupScope(pi, ctx, workspaceId, ctx.signal);
      managerDiagnostic("project_assignment_scope_complete");
      if (!scope.workspaceIds.includes(workspaceId))
        return projectAssignmentAuthorized(false, "workspace_scope_mismatch");
      const assignment = record.branch
        ? readProjectAssignment(
            supervisionRuntime(),
            scope.repoKey,
            record.branch,
          )
        : undefined;
      if (
        !assignment ||
        assignment.id !== sessionId ||
        record.id !== assignment.id
      )
        return projectAssignmentAuthorized(
          false,
          "assignment_evidence_mismatch",
        );
      managerDiagnostic("project_assignment_topology_start");
      const topology = await runHerdr(
        pi,
        ctx,
        ["worktree", "list", "--workspace", scope.primaryWorkspaceId],
        { signal: ctx.signal },
      );
      managerDiagnostic("project_assignment_topology_complete");
      if (
        topology?.source?.source_workspace_id !== scope.primaryWorkspaceId ||
        topology?.source?.repo_key !== scope.repoKey ||
        !Array.isArray(topology?.worktrees)
      )
        return projectAssignmentAuthorized(false, "worktree_topology_mismatch");
      const worktrees = topology.worktrees.filter(
        (worktree: any) => worktree.branch === assignment.branch,
      );
      if (worktrees.length !== 1)
        return projectAssignmentAuthorized(false, "branch_placement_mismatch");
      managerDiagnostic("project_assignment_live_lead_start");
      const live = await liveLead(
        ctx,
        sessionId,
        ctx.sessionManager.getSessionFile(),
      );
      managerDiagnostic("project_assignment_live_lead_complete");
      if (live.length !== 1)
        return projectAssignmentAuthorized(false, "live_lead_mismatch");
      if (
        !scope.workspaceIds.includes(live[0].workspace_id) ||
        worktrees[0].open_workspace_id !== live[0].workspace_id
      )
        return projectAssignmentAuthorized(
          false,
          "workspace_placement_mismatch",
        );
      return projectAssignmentAuthorized(true, "matched");
    }
    if (leadRuntime.chiefMode === "active") {
      const chief = await currentChiefAuthority(ctx, true);
      if (
        !chief ||
        (record.kind !== "manager_message" &&
          record.leaseId !== chief.leaseId) ||
        record.leadSessionId !== record.fromSessionId
      )
        return false;
      if (record.kind === "lead_message") {
        const leads = await liveLead(ctx, record.fromSessionId);
        if (leads.length !== 1) return false;
        let scope: Awaited<ReturnType<typeof worktreeGroupScope>> | undefined;
        try {
          scope = await worktreeGroupScope(
            pi,
            ctx,
            leads[0].workspace_id,
            ctx.signal,
          );
        } catch (error) {
          if (!(
            error instanceof OperationError &&
            error.detail.details?.herdrCode === "not_git_worktree"
          ))
            throw error;
        }
        const state = readLeadCoordinationState(
          supervisionRuntime(),
          record.leadSessionId,
        );
        const supervisor = await host.resolveEffectiveSupervisor(
          ctx,
          record.fromSessionId,
          leads[0].workspace_id,
          scope,
        );
        return (
          !!state &&
          (state.role ?? "lead") === "lead" &&
          supervisor.kind === "chief" &&
          supervisor.chief.piSessionId === chief.piSessionId &&
          supervisor.chief.leaseId === chief.leaseId
        );
      }
      if (record.kind !== "manager_message") return false;
      const manager = recordedManagerSender(record);
      if (!manager) return false;
      if (record.leaseId !== manager.leaseId) return false;
      const managerState = readLeadCoordinationState(
        supervisionRuntime(),
        manager.piSessionId,
      );
      if (!managerState)
        throw new Error(
          "Manager coordination state is temporarily unavailable",
        );
      if (
        managerState.role !== "manager" ||
        managerState.piSessionId !== manager.piSessionId ||
        !sameRuntimeBuild(manager.build, HERDSMAN_BUILD) ||
        !sameRuntimeBuild(managerState.build, HERDSMAN_BUILD)
      )
        return false;
      if (!(await remoteChiefAgent(ctx, manager)))
        throw new Error("Manager live identity is temporarily unavailable");
      const scope = await worktreeGroupScope(
        pi,
        ctx,
        manager.workspaceId,
        ctx.signal,
      );
      return scope.repoKey === manager.repoKey;
    }
    if (activeRole() === "manager" && !leadRuntime.roleSuspended) {
      if (record.kind === "chief_message") {
        const chief = await currentChiefAuthority(ctx);
        return (
          !!chief &&
          chief.piSessionId === record.fromSessionId &&
          chief.leaseId === record.leaseId &&
          record.leadSessionId === sessionId
        );
      }
      const manager = await currentManager(ctx);
      if (
        !manager ||
        record.leaseId !== manager.leaseId ||
        record.kind !== "lead_message" ||
        record.leadSessionId !== record.fromSessionId
      )
        return false;
      const leads = await liveLead(ctx, record.fromSessionId);
      if (leads.length !== 1 || typeof leads[0].cwd !== "string") return false;
      const lead = leads[0];
      const scope = await localRepositoryScope(
        pi,
        { ...ctx, cwd: lead.cwd },
        lead.workspace_id,
        ctx.signal,
      );
      const supervisor = await host.resolveEffectiveSupervisor(
        ctx,
        record.fromSessionId,
        lead.workspace_id,
        scope,
      );
      const [refreshedManager, currentLeads] = await Promise.all([
        host.currentManager(ctx),
        liveLead(ctx, record.fromSessionId),
      ]);
      const state = readLeadCoordinationState(
        supervisionRuntime(),
        record.leadSessionId,
      );
      return (
        !!refreshedManager &&
        refreshedManager.piSessionId === manager.piSessionId &&
        refreshedManager.leaseId === manager.leaseId &&
        refreshedManager.repoKey === manager.repoKey &&
        currentLeads.length === 1 &&
        sameLiveLead(currentLeads[0], lead) &&
        supervisor.kind === "manager" &&
        supervisor.manager.piSessionId === manager.piSessionId &&
        supervisor.manager.leaseId === manager.leaseId &&
        scope.repoKey === manager.repoKey &&
        !!state &&
        (state.role ?? "lead") === "lead"
      );
    }
    if (activeRole() !== "lead" || leadRuntime.roleSuspended) return false;
    if (record.kind === "chief_message") {
      const chief = await currentChiefAuthority(ctx);
      const workspaceId = host.workspaceId();
      if (!workspaceId) return false;
      let localScope:
        Awaited<ReturnType<typeof localRepositoryScope>> | undefined;
      try {
        localScope = await localRepositoryScope(
          pi,
          ctx,
          workspaceId,
          ctx.signal,
        );
      } catch (error) {
        if (!(
          error instanceof OperationError &&
          error.detail.details?.herdrCode === "not_git_worktree"
        ))
          throw error;
      }
      const supervisor = await host.resolveEffectiveSupervisor(
        ctx,
        sessionId,
        workspaceId,
        localScope,
      );
      let currentLocalScope = localScope;
      if (localScope) {
        currentLocalScope = await localRepositoryScope(
          pi,
          ctx,
          workspaceId,
          ctx.signal,
        );
        if (
          currentLocalScope.repoKey !== localScope.repoKey ||
          currentLocalScope.checkoutPath !== localScope.checkoutPath
        )
          return false;
      }
      const currentChief = await currentChiefAuthority(ctx);
      if (
        host.workspaceId() !== workspaceId ||
        ctx.sessionManager.getSessionId() !== sessionId
      )
        return false;
      const state = readLeadCoordinationState(supervisionRuntime(), sessionId);
      return (
        !!chief &&
        !!currentChief &&
        currentChief.piSessionId === chief.piSessionId &&
        currentChief.leaseId === chief.leaseId &&
        (!localScope || !!currentLocalScope) &&
        supervisor.kind === "chief" &&
        supervisor.chief.piSessionId === chief.piSessionId &&
        supervisor.chief.leaseId === chief.leaseId &&
        !!state &&
        chief.piSessionId === record.fromSessionId &&
        chief.leaseId === record.leaseId &&
        record.leadSessionId === sessionId
      );
    }
    if (record.kind !== "manager_message") return false;
    const manager = recordedManagerSender(record);
    if (!manager) return false;
    if (
      record.leaseId !== manager.leaseId ||
      record.leadSessionId !== sessionId
    )
      return false;
    const managerState = readLeadCoordinationState(
      supervisionRuntime(),
      manager.piSessionId,
    );
    if (!managerState)
      throw new Error("Manager coordination state is temporarily unavailable");
    if (
      managerState.role !== "manager" ||
      managerState.piSessionId !== manager.piSessionId ||
      !sameRuntimeBuild(manager.build, HERDSMAN_BUILD) ||
      !sameRuntimeBuild(managerState.build, HERDSMAN_BUILD)
    )
      return false;
    if (!(await remoteChiefAgent(ctx, manager)))
      throw new Error("Manager live identity is temporarily unavailable");
    const workspaceId = host.workspaceId();
    if (!workspaceId) throw new Error("Project scope cannot be verified");
    const localScope = await localRepositoryScope(
      pi,
      ctx,
      workspaceId,
      ctx.signal,
    );
    if (localScope.repoKey !== manager.repoKey) return false;
    const assignment = host.projectAssignmentForScope(localScope, sessionId);
    if (assignment) {
      if (assignment.branch !== record.branch) return false;
    } else {
      const supervisor = host.managerForScope(localScope);
      if (
        !supervisor ||
        supervisor.piSessionId !== manager.piSessionId ||
        supervisor.leaseId !== manager.leaseId ||
        record.branch !== undefined
      )
        return false;
    }
    let state: ReturnType<typeof readLeadCoordinationState>;
    try {
      state = readLeadCoordinationState(supervisionRuntime(), sessionId);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (
        cause instanceof SyntaxError ||
        (cause instanceof Error &&
          ["invalid lead state", "lead state too large"].includes(
            cause.message,
          ))
      )
        return false;
      throw error;
    }
    if (!state)
      throw new Error("Lead coordination state is temporarily unavailable");
    return (
      (state.role ?? "lead") === "lead" &&
      record.leaseId === manager.leaseId &&
      record.fromSessionId === manager.piSessionId &&
      record.leadSessionId === sessionId &&
      record.kind === "manager_message"
    );
  };
  const cleanupManagedPeerInbox = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = readSessionKind(
      ctx.sessionManager.getEntries(),
      sessionId,
    );
    if (!identity || identity.kind !== "managed") return;
    try {
      const scope = await currentWorktreeScope(ctx);
      if (
        sessionId !== ctx.sessionManager.getSessionId() ||
        !scope ||
        scope.repoKey === identity.repoKey
      )
        return;
      for (const path of listChiefMessagePaths(peerRuntime(), sessionId)) {
        let record: ChiefMessageRecord;
        try {
          record = readChiefMessage(path);
        } catch {
          continue;
        }
        if (
          record.kind === "peer_message" &&
          record.toSessionId === sessionId &&
          sessionId === ctx.sessionManager.getSessionId()
        )
          removeChiefMessage(peerRuntime(), sessionId, record.id, record);
      }
    } catch {
      // Incomplete topology or inbox evidence must leave durable messages queued.
    }
  };
  const startChiefInbox = (ctx: ExtensionContext): void => {
    const generation = ++chiefInboxGeneration;
    const socket = process.env.HERDR_SOCKET_PATH;
    if (!socket) return;
    const runtime = supervisionRuntime(socket);
    const peerInboxRuntime = peerRuntime();
    const isCurrent = (): boolean =>
      generation === chiefInboxGeneration &&
      !chiefInboxAbortController?.signal.aborted;
    if (chiefInboxTimer) clearTimeout(chiefInboxTimer);
    const transactions = new Map<
      string,
      {
        id: string;
        record: ChiefMessageRecord;
        generation: number;
        sessionId: string;
        instanceId: string;
        role: typeof leadRuntime.chiefMode;
        signal: AbortSignal | undefined;
      }
    >();
    const submittedAt = new Map<string, number>();
    currentSubmittedAt = submittedAt;
    settledSubmissions = new Set();
    // ponytail: process-local duplicate suppression; a crash before Pi
    // persists the receipt may replay once. Durable exactly-once
    // delivery would require a Pi-owned transactional acknowledgment.
    const revalidateTransaction = (token: unknown, phase: string): void => {
      const transaction = token as {
        generation?: number;
        sessionId?: string;
        instanceId?: string;
      };
      if (
        transaction?.generation !== chiefInboxGeneration ||
        transaction.sessionId !== ctx.sessionManager.getSessionId() ||
        transaction.instanceId !== getLeadInstanceId() ||
        chiefInboxAbortController?.signal.aborted ||
        chiefInboxAbortController?.signal !== transaction.signal ||
        leadRuntime.chiefMode !== transaction.role ||
        (transaction.role === "active" && chiefStartPreflightHeld(ctx)) ||
        (transaction.role === "inactive" &&
          (!coordinationHealthy() ||
            (leadRuntime.roleSuspended && activeRole() !== "manager")))
      ) {
        throw new Error(`Stale inbox transaction (${phase})`);
      }
      if (transaction.role === "inactive" && activeRole() !== "manager")
        assertCurrentLeadCoordination(ctx);
    };
    const inboxOptions = (
      verifyLease: boolean,
      verifyLiveChief = true,
      inboxRuntime = runtime,
    ) => {
      if (!isCurrent()) throw new Error("Stale inbox transaction (options)");
      return {
        runtime: inboxRuntime,
        sessionId: ctx.sessionManager.getSessionId(),
        signal: chiefInboxAbortController?.signal,
        cleanupError: (error: unknown) => {
          managerDiagnostic("inbox_catch", { category: "cleanup" });
          appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
        },
        deliveryMode: async (record: ChiefMessageRecord) => {
          const attempted = submittedAt.get(record.id);
          if (attempted !== undefined && !messageDelivered(ctx, record)) {
            const elapsed = Date.now() - attempted;
            const settled = settledSubmissions.has(record.id);
            // Pi may fail before agent_settled; wait 30s before a quiet retry.
            if (
              !ctx.isIdle() ||
              ctx.hasPendingMessages() ||
              elapsed < (settled ? 1_000 : 30_000)
            )
              return undefined;
          }
          const role = activeRole();
          if (role === "lead" && record.kind === "manager_message") {
            let authorized: boolean;
            try {
              authorized = await authorizeChiefRecord(
                record,
                ctx,
                verifyLiveChief,
              );
            } catch {
              return undefined;
            }
            if (!authorized) return "followUp";
            return "steer";
          }
          const supervisorDownlink =
            (role === "lead" && record.kind === "chief_message") ||
            (role === "manager" && record.kind === "chief_message");

          if (supervisorDownlink) return "steer";
          return ctx.isIdle() ? "followUp" : undefined;
        },
        senderTarget: (record: ChiefMessageRecord) => {
          if (record.kind === "peer_message") {
            const role = record.peerSource?.role;
            if (
              (role !== "lead" && role !== "manager") ||
              role !== activeRole()
            )
              throw new Error("Peer sender role is unavailable for delivery");
            return rememberCoordinatorTarget(
              pi,
              ctx,
              role,
              record.fromSessionId,
            );
          }
          if (record.kind === "manager_message" && activeRole() === "chief")
            return rememberCoordinatorTarget(
              pi,
              ctx,
              "manager",
              record.fromSessionId,
            );
          if (
            record.kind === "lead_message" &&
            (activeRole() === "chief" || activeRole() === "manager")
          )
            return rememberCoordinatorTarget(
              pi,
              ctx,
              "lead",
              record.fromSessionId,
            );
          return undefined;
        },
        isDelivered: (id: string) => {
          const record = transactions.get(id)?.record;
          return record ? messageDelivered(ctx, record) : false;
        },
        isAuthorized: async (record: ChiefMessageRecord) => {
          if (record.kind === "peer_message")
            return authorizePeerRecord(record, ctx);
          try {
            if (
              verifyLease &&
              !(
                record.kind === "manager_message" &&
                (activeRole() === "lead" || activeRole() === "chief")
              )
            ) {
              const chief =
                activeRole() === "chief" ||
                (activeRole() === "manager" && record.kind === "chief_message")
                  ? await currentChiefAuthority(ctx)
                  : await currentManager(ctx);
              if (!chief)
                throw new Error("Supervisor lease could not be verified");
              if (record.toSessionId !== ctx.sessionManager.getSessionId())
                return record.kind === "project_assignment"
                  ? projectAssignmentAuthorized(
                      false,
                      "target_or_workspace_mismatch",
                    )
                  : false;
              if (record.leaseId !== chief.leaseId)
                return record.kind === "project_assignment"
                  ? projectAssignmentAuthorized(false, "lease_mismatch")
                  : false;
            }
            return await authorizeChiefRecord(record, ctx, verifyLiveChief);
          } catch (error) {
            managerDiagnostic("inbox_catch", { category: "authorization" });
            if (record.kind === "project_assignment")
              managerDiagnostic("project_assignment_authorization", {
                outcome: "error",
                reason: "authorization_exception",
              });
            throw error;
          }
        },
        sendMessage: async (
          message: unknown,
          options: Parameters<ChiefInboxDrainOptions["sendMessage"]>[1],
          record: ChiefMessageRecord,
        ) => {
          const projectAssignment =
            typeof message === "object" &&
            message !== null &&
            "customType" in message &&
            message.customType === "pi-herdsman-project_assignment";
          try {
            let payload = message;
            let resultBindings = record.resultBindings;
            if (record.kind === "project_assignment") {
              const workspaceId = process.env.HERDR_WORKSPACE_ID;
              if (!workspaceId || !record.branch)
                throw new Error("Project assignment changed before delivery");
              const scope = await worktreeGroupScope(
                pi,
                ctx,
                workspaceId,
                ctx.signal,
              );
              const assignment = readProjectAssignment(
                supervisionRuntime(),
                scope.repoKey,
                record.branch,
              );
              if (
                !assignment ||
                assignment.id !== ctx.sessionManager.getSessionId() ||
                record.id !== assignment.id
              )
                throw new Error("Project assignment changed before delivery");
              nameSessionIfUnset(pi, ctx, `Lead · ${assignment.branch}`);
              resultBindings = assignment.resultBindings;
              payload = {
                ...(message as object),
                content:
                  `Project assignment for branch ${assignment.branch}:\n\n` +
                  projectAssignmentInstruction(assignment),
              };
            }
            if (
              typeof message === "object" &&
              message !== null &&
              (record.kind === "chief_message" ||
                record.kind === "manager_message" ||
                record.kind === "lead_message")
            ) {
              const toRole = activeRole();
              let sender: PeerLeadRecord | undefined;
              let recipient: PeerLeadRecord | undefined;
              try {
                [sender, recipient] = await Promise.all([
                  livePeerLead(ctx, record.fromSessionId),
                  livePeerLead(ctx, record.toSessionId),
                ]);
              } catch {
                // Presentation metadata is best-effort; delivery remains authoritative.
              }
              const peerDisplayName = (
                peer: PeerLeadRecord | undefined,
              ): string | undefined =>
                peer?.name?.trim() ||
                peer?.workspaceLabel?.trim() ||
                peer?.repo?.trim() ||
                peer?.branch?.trim();
              const fromDisplayName = peerDisplayName(sender);
              let toDisplayName = peerDisplayName(recipient);
              if (!toDisplayName && toRole !== "chief") {
                try {
                  toDisplayName =
                    pi.getSessionName()?.trim() ||
                    ctx.sessionManager.getSessionName()?.trim();
                } catch {
                  // Session names are optional presentation metadata.
                }
              }
              const current = message as {
                details?: Record<string, unknown>;
              };
              payload = {
                ...(message as object),
                details: {
                  ...current.details,
                  toRole,
                  ...(fromDisplayName ? { fromDisplayName } : {}),
                  ...(toDisplayName ? { toDisplayName } : {}),
                },
              };
            }
            if (
              record.kind === "chief_message" ||
              record.kind === "manager_message" ||
              record.kind === "lead_message"
            ) {
              // Presentation lookups above may yield; authorize again at the
              // submission boundary so changed relationships cannot deliver.
              if (!(await authorizeChiefRecord(record, ctx, verifyLiveChief)))
                throw new Error(
                  "Coordination authority changed before delivery",
                );
            }
            if (messageDelivered(ctx, record)) return;
            if (
              record.kind === "peer_message" &&
              !(await authorizePeerRecord(record, ctx))
            )
              throw new Error("Peer eligibility changed before delivery");
            let result: void | Promise<void>;
            try {
              if (record.kind === "peer_message") {
                const recipient = await livePeerLead(ctx, record.toSessionId);
                const source = record.peerSource;
                if (!recipient || !source)
                  throw new Error("Peer eligibility changed before delivery");
                const remoteOrdinarySource =
                  source.role === "lead" &&
                  "remoteOrdinary" in source &&
                  source.remoteOrdinary === true;
                const assignmentSnapshot =
                  source.role === "lead"
                    ? globalProjectAssignmentSnapshot()
                    : undefined;
                const recipientManaged =
                  (assignmentSnapshot?.get(recipient.piSessionId)?.length ??
                    0) > 0;
                const recipientContext = await peerContext(
                  recipient,
                  ctx,
                  assignmentSnapshot,
                  source.role === "lead" &&
                    (source.managed || recipientManaged),
                );
                if (
                  !recipientContext ||
                  (remoteOrdinarySource
                    ? recipientContext.role !== "lead" ||
                      !isRemoteOrdinaryLead(recipient, assignmentSnapshot!)
                    : !canMessagePeer(source, recipientContext))
                )
                  throw new Error("Peer eligibility changed before delivery");
                const peerBindings = resolvePeerResultBindings(
                  ctx,
                  resultBindings ?? [],
                );
                resultBindings = peerBindings.bindings;
                if (
                  peerBindings.conflicts.length &&
                  typeof payload === "string"
                )
                  payload += describePeerResultConflicts(
                    peerBindings.conflicts,
                  );
                else if (
                  peerBindings.conflicts.length &&
                  typeof payload === "object" &&
                  payload !== null &&
                  "content" in payload &&
                  typeof payload.content === "string"
                )
                  payload = {
                    ...payload,
                    content:
                      payload.content +
                      describePeerResultConflicts(peerBindings.conflicts),
                  };
                let submitted: void | Promise<void>;
                const submit = (
                  snapshot?: Map<
                    string,
                    import("./supervision.ts").GlobalProjectAssignment[]
                  >,
                ) => {
                  const current = readPeerLeadRecord(
                    peerRuntime(),
                    recipient.piSessionId,
                  );
                  const matches = snapshot?.get(recipient.piSessionId) ?? [];
                  const assignment = matches[0];
                  const contextCurrent =
                    recipientContext.role === "manager"
                      ? !snapshot
                      : !!snapshot &&
                        matches.length <= 1 &&
                        !!matches.length === recipientContext.managed &&
                        (!assignment ||
                          (!!recipientContext.group &&
                            assignment.assignment.repoKey ===
                              recipientContext.group.repoKey &&
                            assignment.socketHash ===
                              createHash("sha256")
                                .update(recipient.socket)
                                .digest("hex")));
                  if (
                    !current ||
                    !samePeerLeadAuthority(current, recipient) ||
                    current.group?.repoKey !== recipient.group?.repoKey ||
                    current.group?.primaryWorkspaceId !==
                      recipient.group?.primaryWorkspaceId ||
                    !contextCurrent ||
                    (remoteOrdinarySource
                      ? recipientContext.role !== "lead" ||
                        !snapshot ||
                        !isRemoteOrdinaryLead(current, snapshot)
                      : !canMessagePeer(source, recipientContext))
                  )
                    throw new Error("Peer eligibility changed before delivery");
                  importResultBindings(pi, ctx, resultBindings, record.kind);
                  submitted = pi.sendMessage(payload, options);
                };
                if (
                  source.role === "manager" &&
                  recipientContext.role === "manager"
                )
                  submit();
                else withProjectAssignmentAuthority(submit);
                result = submitted;
              } else {
                importResultBindings(pi, ctx, resultBindings, record.kind);
                result = pi.sendMessage(payload, options);
              }
            } catch (error) {
              submittedAt.delete(record.id);
              settledSubmissions.delete(record.id);
              throw error;
            }
            submittedAt.set(record.id, Date.now());
            settledSubmissions.delete(record.id);
            if (projectAssignment)
              managerDiagnostic("project_assignment_send", {
                outcome: "resolved",
                triggerTurn: options?.triggerTurn === true,
              });
            await result;
            if (projectAssignment) {
              try {
                host.assignmentDelivered?.(ctx);
              } catch (error) {
                try {
                  appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
                } catch {
                  // Presentation and diagnostic failures cannot undo delivery.
                }
              }
            }
            return;
          } catch (error) {
            managerDiagnostic("inbox_catch", { category: "send" });
            if (projectAssignment)
              managerDiagnostic("project_assignment_send", {
                outcome: "rejected",
                triggerTurn: options?.triggerTurn === true,
              });
            throw error;
          }
        },
        transaction: {
          begin: (record: ChiefMessageRecord) => {
            const token = {
              id: record.id,
              record,
              generation,
              sessionId: ctx.sessionManager.getSessionId(),
              instanceId: getLeadInstanceId(),
              role: leadRuntime.chiefMode,
              signal: chiefInboxAbortController?.signal,
            };
            transactions.set(record.id, token);
            return token;
          },
          revalidate: (token: unknown, phase: string) => {
            try {
              revalidateTransaction(token, phase);
            } catch (error) {
              managerDiagnostic("inbox_catch", { category: "transaction" });
              throw error;
            }
          },
          clear: (token: unknown) => {
            for (const [id, value] of transactions)
              if (value === token) {
                transactions.delete(id);
              }
          },
        },
        accepted: async (record: ChiefMessageRecord) => {
          if (record.kind === "peer_message")
            writePeerDeliveryReceipt(peerInboxRuntime, record);
          submittedAt.delete(record.id);
          settledSubmissions.delete(record.id);
        },
        rejected: (record: ChiefMessageRecord) => {
          submittedAt.delete(record.id);
          settledSubmissions.delete(record.id);
          if (!record.build || !sameRuntimeBuild(record.build, HERDSMAN_BUILD))
            ctx.ui.notify(
              record.build
                ? `Rejected Pi Herdsman coordination from ${formatRuntimeBuild(record.build)}; local build is ${formatRuntimeBuild(HERDSMAN_BUILD)}. Restart the stale Pi session.`
                : "Rejected coordination from a Pi Herdsman runtime without build identity. Restart the stale Pi session.",
              "error",
            );
          void record;
        },
      };
    };
    const drainInbox = async (initial = false): Promise<number> => {
      if (initial) managerDiagnostic("initial_inbox_drain_start");
      const sessionId = ctx.sessionManager.getSessionId();
      const complete = (count: number): number => {
        managerDiagnostic("inbox_drain_complete", {
          count: Math.min(count, 1000),
          sessionStable: sessionId === ctx.sessionManager.getSessionId(),
        });
        return count;
      };
      const held = chiefStartPreflightHeld(ctx);
      managerDiagnostic("inbox_preflight", { reason: held ? "held" : "pass" });
      if (held) return complete(0);
      if (
        (leadRuntime.chiefMode === "active" || activeRole() === "manager") &&
        ctx.isIdle() &&
        listChiefMessagePaths(runtime, sessionId).some(
          (path) =>
            !chiefMessageQuarantined(
              runtime,
              sessionId,
              basename(path, ".json"),
            ),
        )
      ) {
        const message = await prepareSupervisionMessage(ctx);
        if (
          message &&
          isCurrent() &&
          isCurrentChief(ctx) &&
          !chiefStartPreflightHeld(ctx) &&
          ctx.isIdle()
        )
          pi.sendMessage(message, { triggerTurn: false });
      }

      const current = isCurrent();
      const recheckHeld = current && chiefStartPreflightHeld(ctx);
      managerDiagnostic("inbox_preflight_recheck", {
        reason: !current ? "stale" : recheckHeld ? "held" : "pass",
      });
      if (!current || recheckHeld) return complete(0);
      if (
        controllerScope?.kind === "root" &&
        process.env.PI_HERDSMAN_MANAGER_DIAGNOSTICS === "1" &&
        !managerDiagnosticEvents.has("inbox_candidates")
      ) {
        try {
          managerDiagnostic("inbox_candidates", {
            count: Math.min(
              listChiefMessagePaths(runtime, sessionId).length,
              1000,
            ),
          });
        } catch {
          managerDiagnostic("inbox_catch", { category: "candidate_scan" });
        }
      }
      if (initial) {
        const chief = await drainCoordinationInbox(inboxOptions(false));
        const peerPresent = currentPeerPresenceValid(ctx);
        managerDiagnostic("inbox_peer_presence", {
          reason: peerPresent ? "pass" : "missing",
        });
        if (!peerPresent)
          return complete(chief + (await drainProjectMessages(ctx)));
        const peer = await drainCoordinationInbox(
          inboxOptions(false, true, peerInboxRuntime),
        );
        return complete(chief + peer + (await drainProjectMessages(ctx)));
      }
      const active =
        leadRuntime.chiefMode === "active" || activeRole() === "manager";
      const chief = await drainCoordinationInbox(inboxOptions(active, active));
      const peerPresent = currentPeerPresenceValid(ctx);
      managerDiagnostic("inbox_peer_presence", {
        reason: peerPresent ? "pass" : "missing",
      });
      if (!peerPresent)
        return complete(chief + (await drainProjectMessages(ctx)));
      const peer = await drainCoordinationInbox(
        inboxOptions(active, active, peerInboxRuntime),
      );
      return complete(chief + peer + (await drainProjectMessages(ctx)));
    };
    const schedule = (): void => {
      if (
        generation !== chiefInboxGeneration ||
        chiefInboxAbortController?.signal.aborted
      )
        return;
      chiefInboxTimer = setTimeout(() => {
        chiefInboxTimer = undefined;
        // Recurring lead work is inbox-only. Global inventory and Chief
        // coordination repair run once above at session_start or from refresh.
        void Promise.resolve()
          .then(() => {
            if (!isCurrent()) return;
            if (
              (activeRole() === "manager" || activeRole() === "lead") &&
              Date.now() >= nextRemoteReconciliation &&
              !remoteReconciliationInFlight
            ) {
              remoteReconciliationInFlight = true;
              const reconciliationGeneration = generation;
              const reconciliationAbortController = chiefInboxAbortController;
              void Promise.resolve()
                .then(() =>
                  host.reconcileRemotePeers?.(
                    ctx,
                    reconciliationAbortController?.signal,
                  ),
                )
                .catch(() => {
                  managerDiagnostic("inbox_catch", {
                    category: "remote_reconciliation",
                  });
                })
                .finally(() => {
                  if (
                    reconciliationGeneration === chiefInboxGeneration &&
                    reconciliationAbortController ===
                      chiefInboxAbortController &&
                    !chiefInboxAbortController?.signal.aborted
                  )
                    nextRemoteReconciliation = Date.now() + REMOTE_POLL_MS;
                  remoteReconciliationInFlight = false;
                });
            }
            return drainInbox();
          })
          .catch(() => {
            managerDiagnostic("inbox_catch", { category: "drain" });
          })
          .finally(schedule);
      }, 500);
      chiefInboxTimer.unref?.();
    };
    void drainInbox(true)
      .catch(() => {
        managerDiagnostic("inbox_catch", { category: "drain" });
      })
      .finally(schedule);
  };
  const clearTimer = (): void => {
    if (chiefInboxTimer) clearTimeout(chiefInboxTimer);
    chiefInboxTimer = undefined;
  };
  return {
    start: startChiefInbox,
    cleanupManagedPeerInbox,
    isStartPreflightHeld: chiefStartPreflightHeld,
    clearStartPreflight,
    consumeStartPreflight,
    holdStartPreflight: (ctx: ExtensionContext) =>
      chiefStartPreflights.push({
        sessionId: ctx.sessionManager.getSessionId(),
        sessionGeneration: leadRuntime.sessionGeneration,
        chiefModeGeneration: leadRuntime.chiefModeGeneration,
      }),
    advanceGeneration: () => {
      chiefInboxGeneration++;
    },
    clearTimer,
    beginSession: () => {
      currentSubmittedAt?.clear();
      settledSubmissions.clear();
      chiefInboxAbortController?.abort();
      chiefInboxAbortController = new AbortController();
      nextRemoteReconciliation = 0;
    },
    agentSettled: () => {
      for (const id of currentSubmittedAt?.keys() ?? [])
        settledSubmissions.add(id);
    },
    beginShutdown: () => {
      chiefInboxGeneration++;
      clearTimer();
    },
    shutdown: () => {
      chiefInboxAbortController?.abort();
      chiefInboxAbortController = undefined;
    },
  };
}

export type LeadEntryEffects = {
  advancePresenceGeneration(): void;
  clearChiefStartPreflight(): void;
  resetSupervisionSnapshot(): void;
  removePeerPresence(): void;
  reconcileRoleTools(): void;
  restoreLeadTools(): void;
  persistRole(role: SessionRole): void;
  persistCoordinatorState(): void;
  coordinationHealthy(): boolean;
  schedulePeerPresence(ctx: ExtensionContext): void;
  publishLeadRole(
    ctx: ExtensionContext,
    role: "inactive" | "active" | "suspended",
    generation: number,
  ): void;
  appendRoleError(ctx: ExtensionContext, error: unknown): void;
};

function captureLifecycleError(operation: () => void, prior: unknown): unknown {
  try {
    operation();
  } catch (error) {
    return prior ?? error;
  }
  return prior;
}

export function enterLeadRole(
  state: LeadRuntimeState,
  effects: LeadEntryEffects,
  ctx?: ExtensionContext,
  persist = true,
): void {
  effects.advancePresenceGeneration();
  let lifecycleError: unknown;
  const chief = state.chiefLease;
  state.chiefLease = undefined;
  const manager = state.managerLease;
  state.managerLease = undefined;
  effects.clearChiefStartPreflight();
  lifecycleError = captureLifecycleError(
    () => chief?.release(),
    lifecycleError,
  );
  lifecycleError = captureLifecycleError(
    () => manager?.release(),
    lifecycleError,
  );
  effects.resetSupervisionSnapshot();
  state.chiefMode = "inactive";
  state.roleSuspended = false;
  if (ctx && effects.coordinationHealthy()) effects.schedulePeerPresence(ctx);
  try {
    effects.reconcileRoleTools();
  } catch (error) {
    lifecycleError ??= error;
    lifecycleError = captureLifecycleError(
      effects.restoreLeadTools,
      lifecycleError,
    );
  }
  if (persist)
    lifecycleError = captureLifecycleError(
      () => effects.persistRole("lead"),
      lifecycleError,
    );
  if (effects.coordinationHealthy())
    lifecycleError = captureLifecycleError(
      effects.persistCoordinatorState,
      lifecycleError,
    );
  if (lifecycleError && ctx) effects.appendRoleError(ctx, lifecycleError);
  if (ctx) effects.publishLeadRole(ctx, "inactive", state.chiefModeGeneration);
}

export function enterChiefRole(
  state: LeadRuntimeState,
  effects: LeadEntryEffects,
  ctx: ExtensionContext,
  lease: ChiefLease,
  generation: number,
): void {
  effects.advancePresenceGeneration();
  effects.removePeerPresence();
  state.chiefLease = lease;
  state.roleSuspended = false;
  effects.resetSupervisionSnapshot();
  state.chiefMode = "active";
  try {
    effects.persistRole("chief");
    effects.reconcileRoleTools();
  } catch (error) {
    state.chiefMode = "inactive";
    state.chiefLease = undefined;
    effects.resetSupervisionSnapshot();
    throw error;
  }
  effects.publishLeadRole(ctx, "active", generation);
}

export function enterSuspendedRole(
  state: LeadRuntimeState,
  effects: LeadEntryEffects,
  ctx?: ExtensionContext,
): void {
  effects.advancePresenceGeneration();
  let lifecycleError: unknown;
  const chief = state.chiefLease;
  state.chiefLease = undefined;
  effects.clearChiefStartPreflight();
  effects.resetSupervisionSnapshot();
  state.chiefMode = "suspended";
  state.roleSuspended = true;
  effects.removePeerPresence();
  lifecycleError = captureLifecycleError(
    () => chief?.release(),
    lifecycleError,
  );
  lifecycleError = captureLifecycleError(
    effects.reconcileRoleTools,
    lifecycleError,
  );
  lifecycleError = captureLifecycleError(
    () => effects.persistRole("chief"),
    lifecycleError,
  );
  if (lifecycleError && ctx) effects.appendRoleError(ctx, lifecycleError);
  if (ctx) effects.publishLeadRole(ctx, "suspended", state.chiefModeGeneration);
}

export function restoreLeadChiefState(
  ctx: ExtensionContext,
  host: LeadTransitionHost,
): boolean {
  host.setLeadInstanceId(randomUUID());
  host.setCoordinationHealthy(true);
  const entry = [...ctx.sessionManager.getEntries()]
    .reverse()
    .find(
      (candidate: any) =>
        candidate?.type === "custom" &&
        candidate.customType === "pi-herdsman-lead-state",
    ) as any;
  let malformed = false;
  let hasRetiredPendingAsk = false;
  if (entry) {
    const data = entry.data;
    if (
      !data ||
      typeof data !== "object" ||
      Object.keys(data).some(
        (key) => key !== "instanceId" && key !== "pendingAsk",
      ) ||
      (data.instanceId !== undefined &&
        (typeof data.instanceId !== "string" ||
          !LEAD_INSTANCE_ID.test(data.instanceId)))
    ) {
      malformed = true;
    } else {
      hasRetiredPendingAsk = Object.hasOwn(data, "pendingAsk");
    }
  }
  if (malformed) {
    host.markLeadCoordinationUnhealthy(ctx);
    host.appendDurableError(
      host.pi,
      ctx,
      "pi_herdsman_state_error",
      new Error("invalid pi-herdsman-lead-state entry"),
    );
    return false;
  }
  if (hasRetiredPendingAsk) host.persistCoordinatorState();
  else host.persistLeadCoordination();
  return true;
}

export async function resolveLeadControllerRole(
  state: LeadRuntimeState,
  ctx: ExtensionContext,
  requestedRole: SessionRole,
  deps: {
    identity: { paneId?: string; tabId?: string; workspaceId?: string };
    build: Parameters<
      typeof import("./supervision.ts").claimManagerLease
    >[0]["build"];
    localRepositoryScope: (
      workspaceId: string,
      signal: AbortSignal,
    ) => Promise<{ isPrimary: boolean; repoKey: string }>;
    claimManagerLease: typeof import("./supervision.ts").claimManagerLease;
    coordinationHealthy(): boolean;
    verifyManagerIdentity(
      descriptor: import("./supervision.ts").ManagerDescriptor,
    ): Promise<unknown>;
    verifyCurrentIdentity(): Promise<unknown>;
    unresolvedManagerLease(): void;
    activationGuard(sessionId: string, role: "Chief" | "Manager"): void;
    persistLeadRole: () => void;
    isCurrent(): boolean;
  },
  optional = false,
): Promise<void> {
  state.controllerRole = "lead";
  state.roleSuspended = false;
  const { paneId, tabId, workspaceId } = deps.identity;
  if (
    (requestedRole !== "manager" && !optional) ||
    !paneId ||
    !tabId ||
    !workspaceId
  )
    return;
  const sessionId = ctx.sessionManager.getSessionId();
  deps.activationGuard(sessionId, "Manager");
  let scope;
  try {
    scope = await deps.localRepositoryScope(workspaceId, ctx.signal);
  } catch (error) {
    if (!deps.isCurrent()) return;
    if (
      error instanceof OperationError &&
      error.detail.details?.herdrCode === "not_git_worktree"
    ) {
      if (!optional) deps.persistLeadRole();
      return;
    }
    if (!optional) state.roleSuspended = true;
    throw error;
  }
  if (!deps.isCurrent() || ctx.sessionManager.getSessionId() !== sessionId)
    return;
  if (!scope.isPrimary) {
    if (!optional) deps.persistLeadRole();
    return;
  }
  if (
    !(await deps.verifyCurrentIdentity()) ||
    !deps.isCurrent() ||
    ctx.sessionManager.getSessionId() !== sessionId
  )
    return;
  deps.activationGuard(sessionId, "Manager");
  try {
    const lease = deps.claimManagerLease({
      build: deps.build,
      piSessionId: sessionId,
      piSessionFile: ctx.sessionManager.getSessionFile(),
      paneId,
      tabId,
      workspaceId,
      repoKey: scope.repoKey,
    });
    {
      let verified: unknown;
      try {
        verified = await deps.verifyManagerIdentity(lease.descriptor);
        const currentScope = await deps.localRepositoryScope(
          workspaceId,
          ctx.signal,
        );
        if (
          !currentScope.isPrimary ||
          currentScope.repoKey !== scope.repoKey ||
          !(await deps.verifyCurrentIdentity()) ||
          ctx.sessionManager.getSessionId() !== sessionId
        )
          throw new Error("Manager identity changed during restoration");
      } catch (error) {
        if (!deps.isCurrent()) {
          lease.release();
          return;
        }
        try {
          lease.release();
        } catch (releaseError) {
          state.managerLease = lease;
          state.controllerRole = "manager";
          state.roleSuspended = true;
          deps.unresolvedManagerLease();
          throw releaseError;
        }
        throw error;
      }
      if (!deps.isCurrent()) {
        lease.release();
        return;
      }
      if (!verified) {
        try {
          lease.release();
        } catch (error) {
          state.managerLease = lease;
          state.controllerRole = "manager";
          state.roleSuspended = true;
          deps.unresolvedManagerLease();
          throw error;
        }
        return;
      }
      if (!deps.coordinationHealthy()) {
        try {
          lease.release();
        } catch (error) {
          state.managerLease = lease;
          state.controllerRole = "manager";
          state.roleSuspended = true;
          deps.unresolvedManagerLease();
          throw error;
        }
        return;
      }
    }
    state.managerLease = lease;
    state.controllerRole = "manager";
  } catch (error) {
    if (!deps.isCurrent()) throw error;
    if (!state.roleSuspended) state.managerLease = undefined;
    if (!(error instanceof ProcessLockOccupiedError)) throw error;
    if (optional) {
      ctx.ui.notify(
        "Manager auto-start skipped: this project already has an active Manager.",
        "warning",
      );
      return;
    }
    state.controllerRole = "manager";
    state.roleSuspended = true;
    ctx.ui.notify(
      "Manager unavailable: this project already has an active Manager. Manager mode is suspended.",
      "warning",
    );
  }
}

export function createLeadRoleTransitions(
  state: LeadRuntimeState,
  host: LeadRoleTransitionHost,
) {
  const projectWorkLocks = new Map<string, Promise<void>>();
  const withProjectWorkLock = async <T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = projectWorkLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    projectWorkLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (projectWorkLocks.get(key) === current) projectWorkLocks.delete(key);
    }
  };
  const currentWorktreeScope = async (ctx: ExtensionContext) => {
    const workspaceId = host.workspaceId();
    if (!workspaceId) return undefined;
    try {
      return await host.worktreeGroupScope(ctx, workspaceId, ctx.signal);
    } catch (error) {
      if (
        error instanceof OperationError &&
        error.detail.details?.herdrCode === "not_git_worktree"
      )
        return undefined;
      throw error;
    }
  };
  const currentLocalRepositoryScope = async (ctx: ExtensionContext) => {
    const workspaceId = host.workspaceId();
    if (!workspaceId) return undefined;
    try {
      return await localRepositoryScope(host.pi, ctx, workspaceId, ctx.signal);
    } catch (error) {
      if (
        error instanceof OperationError &&
        error.detail.details?.herdrCode === "not_git_worktree"
      )
        return undefined;
      throw error;
    }
  };
  const projectAssignmentForScope = (
    scope: Pick<WorktreeGroupScope, "repoKey">,
    sessionId: string,
  ): ProjectAssignment | undefined => {
    const assignments = host.findProjectAssignmentBySession(
      host.supervisionRuntime(),
      scope.repoKey,
      sessionId,
    );
    if (assignments.length > 1)
      throw new Error("Multiple project assignments match the Lead session");
    return assignments[0];
  };
  const projectEvidenceForWorkspace = async (
    ctx: ExtensionContext,
    workspaceId: string,
    projectAssignmentId: string,
  ) => {
    const scope = await host.worktreeGroupScope(ctx, workspaceId, ctx.signal);
    const assignment = projectAssignmentForScope(scope, projectAssignmentId);
    if (!assignment) return undefined;
    return {
      assignment,
      revalidate: (operation: () => Promise<void> | void) =>
        withProjectAssignmentLock(
          assignment.repoKey,
          assignment.branch,
          async () => {
            const currentScope = await host.worktreeGroupScope(
              ctx,
              workspaceId,
              ctx.signal,
            );
            const current = projectAssignmentForScope(
              currentScope,
              projectAssignmentId,
            );
            if (!current || current.id !== assignment.id)
              throw new Error(
                "Project assignment changed during Agent startup; retry delegation",
              );
            await operation();
          },
          ctx.signal,
        ),
    };
  };
  const withProjectAssignmentLock = async <T>(
    repoKey: string,
    branch: string,
    operation: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> => {
    const path = `${host.projectAssignmentPath(host.supervisionRuntime(), repoKey, branch)}.lock`;
    const deadline = Date.now() + 2_000;
    let lease: ReturnType<typeof host.acquireProcessLock>;
    while (true) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        throw new ProcessLockOccupiedError(
          "Project assignment lock is in progress",
        );
      try {
        lease = host.acquireProcessLock(path, {
          name: "project assignment lock",
        });
        break;
      } catch (error) {
        if (
          !(error instanceof ProcessLockOccupiedError) ||
          Date.now() >= deadline
        )
          throw error;
        await host.afterProjectAssignmentLockOccupied?.(repoKey, branch);
        await host.delay(Math.min(25, deadline - Date.now()), undefined, {
          signal,
        });
      }
    }
    try {
      if (host.afterProjectAssignmentLockAcquired)
        await host.afterProjectAssignmentLockAcquired(repoKey, branch);
      return await operation();
    } finally {
      lease.release();
    }
  };
  const publishProjectMessage = async (
    ctx: ExtensionContext,
    assignment: ProjectAssignment,
    message: string,
    files: readonly MessageFileInput[] = [],
    operation = "message_supervisor",
    reportId?: string,
    kind?: ProjectMessage["kind"],
    signal?: AbortSignal,
  ): Promise<ProjectMessage | undefined> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtime = host.supervisionRuntime();
    const current = host.readProjectAssignment(
      runtime,
      assignment.repoKey,
      assignment.branch,
    );
    if (!current || current.id !== sessionId) return undefined;
    const id = reportId ?? randomUUID();
    const createdAt = Date.now();
    const prepared = await host.prepareCoordinationInput(
      ctx,
      message,
      files,
      operation,
      "Message",
      (candidate: string, resultBindings: readonly ResultBinding[]) =>
        host.projectMessageBytes({
          version: 2,
          id,
          repoKey: assignment.repoKey,
          branch: assignment.branch,
          fromSessionId: sessionId,
          text: candidate,
          ...(kind ? { kind } : {}),
          ...(resultBindings.length
            ? { resultBindings: [...resultBindings] }
            : {}),
          createdAt,
        }),
    );
    const record: ProjectMessage = {
      version: 2,
      id,
      repoKey: assignment.repoKey,
      branch: assignment.branch,
      fromSessionId: sessionId,
      text: prepared.text,
      ...(kind ? { kind } : {}),
      ...(prepared.resultBindings.length
        ? { resultBindings: prepared.resultBindings }
        : {}),
      createdAt,
    };
    return withProjectAssignmentLock(
      assignment.repoKey,
      assignment.branch,
      () => {
        const latest = host.readProjectAssignment(
          runtime,
          assignment.repoKey,
          assignment.branch,
        );
        if (!latest || latest.id !== sessionId) return undefined;
        const existingHeader = listProjectMessageHeaders(
          runtime,
          assignment.repoKey,
          assignment.branch,
        ).find((candidate) => candidate.id === id);
        const existing = existingHeader
          ? readProjectMessage(
              runtime,
              assignment.repoKey,
              assignment.branch,
              existingHeader.id,
            )
          : undefined;
        if (existing) {
          if (
            existing.fromSessionId !== sessionId ||
            existing.text !== record.text ||
            existing.kind !== record.kind ||
            JSON.stringify(existing.resultBindings ?? []) !==
              JSON.stringify(record.resultBindings ?? [])
          )
            throw new Error(
              "Project message identity conflicts with durable payload",
            );
          return existing;
        }
        host.writeProjectMessage(record, runtime);
        return record;
      },
      signal ?? ctx.signal,
    );
  };
  const managerForScope = (
    scope: Pick<WorktreeGroupScope, "repoKey"> | undefined,
  ): ManagerDescriptor | undefined => {
    if (!scope) return undefined;
    const managers = listManagerDescriptors(host.supervisionRuntime()).filter(
      (manager) => manager.repoKey === scope.repoKey,
    );
    if (managers.length > 1)
      throw new Error("Manager supervisor is ambiguous for this repository");
    return managers[0];
  };
  const currentManager = async (
    ctx: ExtensionContext,
    scope?: Pick<WorktreeGroupScope, "repoKey"> | null,
  ): Promise<ManagerDescriptor | undefined> => {
    const ownLease =
      activeLeadRole(state) === "manager" && !state.roleSuspended
        ? state.managerLease
        : undefined;
    const ownStatus =
      ownLease &&
      host.readManagerDescriptorStatus(
        host.supervisionRuntime(),
        ownLease.descriptor.workspaceId,
      );
    const descriptor = ownLease
      ? ownStatus?.live &&
        host.sameManagerDescriptor(ownStatus.descriptor, ownLease.descriptor)
        ? ownStatus.descriptor
        : undefined
      : managerForScope(
          scope === null || scope === undefined
            ? await currentWorktreeScope(ctx)
            : scope,
        );
    if (!descriptor) return undefined;
    verifyManagerCoordinationAuthority(
      descriptor,
      host.readLeadCoordinationState(
        host.supervisionRuntime(),
        descriptor.piSessionId,
      ),
      host.build,
      host.requireCompatibleBuild,
    );
    if (activeLeadRole(state) === "manager" && !state.roleSuspended) {
      return state.managerLease &&
        host.sameManagerDescriptor(descriptor, state.managerLease.descriptor) &&
        descriptor.piSessionId === ctx.sessionManager.getSessionId() &&
        descriptor.workspaceId === state.managerLease.descriptor.workspaceId
        ? descriptor
        : undefined;
    }
    if (!(await host.remoteChiefAgent(ctx, descriptor)))
      throw new Error(
        "Manager authority exists but live discovery is inconclusive",
      );
    return descriptor;
  };
  const chiefLeaseMayExist = (): boolean => {
    try {
      host.statSync(host.supervisionRuntime().lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const currentChief = (
    failOnVerificationError = false,
  ): ChiefDescriptor | undefined => {
    if (state.chiefMode === "active") return state.chiefLease?.descriptor;
    if (state.chiefMode !== "inactive") return undefined;
    try {
      return host.readChiefDescriptor(host.supervisionRuntime().descriptor);
    } catch (error) {
      if (failOnVerificationError && chiefLeaseMayExist()) throw error;
      return undefined;
    }
  };
  const currentChiefAuthority = async (
    ctx: ExtensionContext,
    failOnVerificationError = false,
  ): Promise<ChiefDescriptor | undefined> => {
    const descriptor = currentChief(failOnVerificationError);
    if (!descriptor) return undefined;
    host.requireCompatibleBuild(
      host.build,
      descriptor.build,
      "supervision",
      `Chief ${descriptor.piSessionId}`,
    );
    const runtime = host.supervisionRuntime();
    if (state.chiefMode === "active") {
      let onDisk: ChiefDescriptor;
      try {
        onDisk = host.readChiefDescriptor(runtime.descriptor);
      } catch (error) {
        if (failOnVerificationError) throw error;
        return undefined;
      }
      if (
        !state.chiefLease ||
        !host.sameChiefDescriptor(onDisk, state.chiefLease.descriptor)
      )
        return undefined;
      if (!host.chiefLeaseIsHeld(runtime)) {
        if (failOnVerificationError && chiefLeaseMayExist())
          throw new Error("Unable to verify Chief supervision lease");
        return undefined;
      }
      if (
        descriptor.claim.pid !== process.pid ||
        descriptor.piSessionId !== ctx.sessionManager.getSessionId() ||
        descriptor.paneId !== host.identity.paneId ||
        descriptor.tabId !== host.identity.tabId ||
        descriptor.workspaceId !== host.identity.workspaceId
      )
        return undefined;
      host.requireCompatibleBuild(
        host.build,
        descriptor.build,
        "supervision",
        `Chief ${descriptor.piSessionId}`,
      );
      return descriptor;
    }
    if (
      (activeLeadRole(state) !== "lead" &&
        activeLeadRole(state) !== "manager") ||
      state.chiefMode !== "inactive"
    )
      return undefined;
    if (!host.chiefLeaseIsHeld(runtime)) {
      if (failOnVerificationError && chiefLeaseMayExist())
        throw new Error("Unable to verify Chief supervision lease");
      return undefined;
    }
    try {
      const verified = await verifyRemoteChiefAuthority(descriptor, {
        remoteIdentity: () => host.remoteChiefAgent(ctx, descriptor),
        requireCompatibleBuild: host.requireCompatibleBuild,
        build: host.build,
      });
      if (!verified) return undefined;
      return descriptor;
    } catch (error) {
      if (
        error instanceof OperationError &&
        error.detail.category === "incompatible_build"
      )
        throw error;
      if (failOnVerificationError) throw error;
      return undefined;
    }
  };
  const resolveEffectiveSupervisor = async (
    ctx: ExtensionContext,
    sessionId: string,
    workspaceId: string,
    verifiedScope?: Pick<WorktreeGroupScope, "repoKey">,
  ) => {
    let scope: Pick<WorktreeGroupScope, "repoKey"> | undefined = verifiedScope;
    if (!scope) {
      try {
        scope = await host.worktreeGroupScope(ctx, workspaceId, ctx.signal);
      } catch (error) {
        if (!(
          error instanceof OperationError &&
          error.detail.details?.herdrCode === "not_git_worktree"
        ))
          throw error;
        const chief = await currentChiefAuthority(ctx, true);
        return chief
          ? { kind: "chief" as const, chief, scope: undefined }
          : { kind: "none" as const, scope: undefined };
      }
    }
    const assignment = projectAssignmentForScope(scope, sessionId);
    if (assignment) return { kind: "assigned" as const, assignment, scope };
    const manager = await currentManager(ctx, scope);
    if (manager) return { kind: "manager" as const, manager, scope };
    const chief = await currentChiefAuthority(ctx, true);
    return chief
      ? { kind: "chief" as const, chief, scope }
      : { kind: "none" as const, scope };
  };
  const currentSupervisor = async (ctx: ExtensionContext) => {
    if (activeLeadRole(state) === "manager")
      return host.currentChiefAuthority(ctx);
    if (activeLeadRole(state) !== "lead") return undefined;
    const identity = readSessionKind(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getSessionId(),
    );
    if (identity?.kind === "managed") {
      const scope = await currentLocalRepositoryScope(ctx);
      if (!scope || scope.repoKey !== identity.repoKey) return undefined;
      const assignment = projectAssignmentForScope(scope, identity.sessionId);
      return assignment && assignment.branch === identity.branch
        ? currentManager(ctx, scope)
        : undefined;
    }
    const scope = await currentLocalRepositoryScope(ctx);
    if (!scope) return host.currentChiefAuthority(ctx);
    const workspaceId = host.workspaceId();
    if (!workspaceId) return host.currentChiefAuthority(ctx);
    const supervisor = await resolveEffectiveSupervisor(
      ctx,
      ctx.sessionManager.getSessionId(),
      workspaceId,
      scope,
    );
    if (supervisor.kind === "assigned")
      return currentManager(ctx, supervisor.scope);
    if (supervisor.kind === "manager") return supervisor.manager;
    return supervisor.kind === "chief" ? supervisor.chief : undefined;
  };
  const removeProjectAssignmentState = (
    assignment: ProjectAssignment,
    ctx: ExtensionContext,
  ): boolean => {
    const runtime = host.supervisionRuntime();
    if (!host.retireProjectAssignment(runtime, assignment)) return false;
    try {
      host.removeProjectMessagesForAssignment(runtime, assignment);
    } catch (error) {
      host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
    }
    return true;
  };
  const gitWorktreeInventory = async (
    ctx: ExtensionContext,
    repoKey: string,
    primaryWorkspaceId: string,
    sourceCheckoutPath: string,
  ) => {
    if (!isAbsolute(sourceCheckoutPath)) return undefined;
    try {
      const scope = await host.worktreeGroupScope(
        ctx,
        primaryWorkspaceId,
        ctx.signal,
      );
      if (scope.repoKey !== repoKey) return undefined;
      const rootResult = await host.pi.exec(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: sourceCheckoutPath, signal: ctx.signal, timeout: 10_000 },
      );
      if (
        rootResult.code !== 0 ||
        rootResult.killed ||
        rootResult.stderr?.trim()
      )
        return undefined;
      const commonDir = String(rootResult.stdout ?? "").trim();
      if (!commonDir || !isAbsolute(commonDir)) return undefined;
      const result = await host.pi.exec(
        "git",
        ["worktree", "list", "--porcelain", "-z"],
        { cwd: sourceCheckoutPath, signal: ctx.signal, timeout: 10_000 },
      );
      if (result.code !== 0 || result.killed || result.stderr?.trim())
        return undefined;
      const inventory = parseGitWorktreeInventory(String(result.stdout ?? ""));
      if (
        !inventory ||
        !sameDirectory(commonDir, repoKey) ||
        gitPathStatus(sourceCheckoutPath) !== "present"
      )
        return undefined;
      return inventory;
    } catch {
      return undefined;
    }
  };
  const reconcileProjectAssignments = async (
    ctx: ExtensionContext,
    repoKey: string,
    primaryWorkspaceId: string,
    sourceCheckoutPath: string,
    projectWorkLocked = false,
    onlyBranch?: string,
    retryLockContention = false,
    expectedAssignmentId?: string,
  ): Promise<void> => {
    const manager = await currentManager(ctx);
    if (
      !manager ||
      manager.repoKey !== repoKey ||
      manager.workspaceId !== primaryWorkspaceId
    )
      return;
    const assignments = listProjectAssignments(
      host.supervisionRuntime(),
      repoKey,
    );
    const initialInventory = await gitWorktreeInventory(
      ctx,
      repoKey,
      primaryWorkspaceId,
      sourceCheckoutPath,
    );
    if (!initialInventory) return;
    const knownSessionCheckoutPath = (
      assignment: ProjectAssignment,
    ): string | undefined => {
      if (!assignment.piSessionFile) return undefined;
      try {
        const session = host.SessionManager.open(assignment.piSessionFile);
        if (session.getSessionId() !== assignment.id) return undefined;
        return resolve(session.getCwd());
      } catch {
        return undefined;
      }
    };
    const checkoutProvenance = (assignment: ProjectAssignment) => {
      const recorded = assignment.checkoutPath
        ? resolve(assignment.checkoutPath)
        : undefined;
      const session = knownSessionCheckoutPath(assignment);
      return {
        path: recorded ?? session,
        conflicting:
          !!recorded &&
          !!session &&
          recorded !== session &&
          !(
            process.platform === "win32" &&
            toNamespacedPath(recorded) === toNamespacedPath(session)
          ) &&
          !sameDirectory(recorded, session),
      };
    };
    const checkoutMaySurvive = (
      assignment: ProjectAssignment,
      inventory: NonNullable<typeof initialInventory>,
      checkoutPath = checkoutProvenance(assignment).path,
    ): boolean => {
      if (checkoutPath)
        return (
          gitPathStatus(checkoutPath) !== "absent" ||
          inventory.some(
            (worktree) =>
              resolve(worktree.path) === checkoutPath &&
              (worktree.locked ||
                !worktree.prunable ||
                gitPathStatus(worktree.path) !== "absent"),
          )
        );
      // Without checkout provenance, any linked checkout could be the assigned one.
      return inventory.some(
        (worktree) =>
          resolve(worktree.path) !== resolve(sourceCheckoutPath) &&
          gitPathStatus(worktree.path) !== "absent",
      );
    };
    for (const observed of assignments) {
      if (
        (onlyBranch && observed.branch !== onlyBranch) ||
        (expectedAssignmentId && observed.id !== expectedAssignmentId)
      )
        continue;
      const observedProvenance = checkoutProvenance(observed);
      if (observedProvenance.conflicting) {
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_state_error",
          new Error("Project assignment has conflicting checkout provenance"),
        );
        continue;
      }
      if (
        checkoutMaySurvive(observed, initialInventory, observedProvenance.path)
      )
        continue;
      const initialMatches = initialInventory.filter(
        (worktree) => worktree.branch === observed.branch,
      );
      if (
        initialMatches.length > 1 ||
        initialMatches.some(
          (worktree) =>
            worktree.locked ||
            !worktree.prunable ||
            gitPathStatus(worktree.path) !== "absent",
        )
      )
        continue;
      const retireIfAbsent = async () => {
        const latestManager = await currentManager(ctx);
        if (
          !latestManager ||
          !host.sameManagerDescriptor(latestManager, manager)
        )
          return;
        const retireUnderAssignmentLock = async () => {
          const latestManager = await currentManager(ctx);
          if (
            !latestManager ||
            !host.sameManagerDescriptor(latestManager, manager)
          )
            return;
          const current = host.readProjectAssignment(
            host.supervisionRuntime(),
            repoKey,
            observed.branch,
          );
          if (
            !current ||
            current.repoKey !== repoKey ||
            current.branch !== observed.branch ||
            current.id !== observed.id
          )
            return;
          const inventory = await gitWorktreeInventory(
            ctx,
            repoKey,
            primaryWorkspaceId,
            sourceCheckoutPath,
          );
          if (!inventory) return;
          const currentProvenance = checkoutProvenance(current);
          if (
            currentProvenance.conflicting ||
            checkoutMaySurvive(current, inventory, currentProvenance.path)
          )
            return;
          const matches = inventory.filter(
            (worktree) => worktree.branch === observed.branch,
          );
          if (
            matches.length > 1 ||
            matches.some(
              (worktree) =>
                worktree.locked ||
                !worktree.prunable ||
                gitPathStatus(worktree.path) !== "absent",
            )
          )
            return;
          removeProjectAssignmentState(current, ctx);
        };
        const deadline = retryLockContention ? Date.now() + 30_000 : 0;
        for (;;) {
          try {
            await withProjectAssignmentLock(
              repoKey,
              observed.branch,
              retireUnderAssignmentLock,
              ctx.signal,
            );
            return;
          } catch (error) {
            if (!(error instanceof ProcessLockOccupiedError)) throw error;
            if (!retryLockContention) return;
            if (ctx.signal.aborted) throw ctx.signal.reason;
            if (Date.now() >= deadline) throw error;
            await host.delay(50, undefined, { signal: ctx.signal });
          }
        }
      };
      if (projectWorkLocked) await retireIfAbsent();
      else
        await withProjectWorkLock(
          `${repoKey}\0${observed.branch}`,
          retireIfAbsent,
        );
    }
  };
  const reconcileCurrentManagerAssignments = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    const lease = state.managerLease?.descriptor;
    if (
      activeLeadRole(state) !== "manager" ||
      state.roleSuspended ||
      !lease ||
      lease.piSessionId !== ctx.sessionManager.getSessionId() ||
      lease.workspaceId !== host.workspaceId()
    )
      return;
    const manager = await currentManager(ctx, {
      repoKey: lease.repoKey,
      primaryWorkspaceId: lease.workspaceId,
    });
    if (!manager) return;
    try {
      host.recoverStaleProjectMessages(
        host.supervisionRuntime(),
        manager.repoKey,
      );
    } catch (error) {
      host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
    }
    const topology = await host.runHerdr(
      host.pi,
      ctx,
      ["worktree", "list", "--workspace", manager.workspaceId],
      { signal: ctx.signal },
    );
    if (
      topology?.source?.repo_key !== manager.repoKey ||
      typeof topology?.source?.source_checkout_path !== "string"
    )
      throw new Error("Manager worktree topology is not authoritative");
    await reconcileProjectAssignments(
      ctx,
      manager.repoKey,
      manager.workspaceId,
      topology.source.source_checkout_path,
    );
  };
  const retireRemovedProjectWork = async (
    removed: { repoKey: string; branch: string },
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<void> => {
    let scope: WorktreeGroupScope | undefined;
    try {
      scope = await currentWorktreeScope(ctx);
    } catch (error) {
      if (
        error instanceof OperationError &&
        error.detail.details?.herdrCode === "workspace_not_found"
      )
        return;
      throw error;
    }
    if (!scope || scope.repoKey !== removed.repoKey) return;
    const topology = await host.runHerdr(
      host.pi,
      ctx,
      ["worktree", "list", "--workspace", scope.primaryWorkspaceId],
      { signal },
    );
    if (
      topology?.source?.repo_key !== removed.repoKey ||
      topology?.source?.source_workspace_id !== scope.primaryWorkspaceId ||
      typeof topology?.source?.source_checkout_path !== "string"
    )
      return;
    await reconcileProjectAssignments(
      ctx,
      removed.repoKey,
      scope.primaryWorkspaceId,
      topology.source.source_checkout_path,
      false,
      removed.branch,
      true,
    );
  };
  const beginShutdownRole = (): void => {
    state.sessionGeneration++;
    host.advancePeerPresenceGeneration();
    host.clearChiefStartPreflight();
  };
  const shutdownRole = (): void => {
    state.chiefModeGeneration++;
    if (host.controllerScope?.kind !== "root") return;
    if (state.chiefMode === "active") {
      host.enterSuspended(state.leadContext);
    } else if (state.controllerRole === "manager") {
      host.removePeerPresence();
      try {
        const sessionId = state.leadContext?.sessionManager.getSessionId();
        if (sessionId)
          host.invalidateLeadCoordinationState(
            host.supervisionRuntime(),
            sessionId,
            host.leadInstanceId(),
          );
        state.managerLease?.release();
      } catch (error) {
        if (state.leadContext)
          host.appendDurableError(
            host.pi,
            state.leadContext,
            "pi_herdsman_role_error",
            error,
          );
      }
      state.managerLease = undefined;
      state.roleSuspended = true;
    } else {
      host.removePeerPresence();
      try {
        const sessionId = state.leadContext?.sessionManager.getSessionId();
        if (sessionId)
          host.invalidateLeadCoordinationState(
            host.supervisionRuntime(),
            sessionId,
            host.leadInstanceId(),
          );
      } catch (error) {
        if (state.leadContext)
          host.appendDurableError(
            host.pi,
            state.leadContext,
            "pi_herdsman_state_error",
            error,
          );
      }
      host.enterLead(undefined, false);
    }
  };
  const beginSessionRole = (ctx: ExtensionContext) => {
    state.sessionGeneration++;
    host.advancePeerPresenceGeneration();
    const previousChiefMode = state.chiefMode;
    const previousControllerRole = state.controllerRole;
    const previousLeadContext = state.leadContext;
    state.chiefModeGeneration++;
    const finish = () => {
      state.leadContext = ctx;
      state.chiefMode = "inactive";
      state.controllerRole = "lead";
      state.roleSuspended = false;
      let lifecycleError: unknown;
      try {
        state.chiefLease?.release();
      } catch (error) {
        lifecycleError = error;
      }
      state.chiefLease = undefined;
      try {
        state.managerLease?.release();
      } catch (error) {
        lifecycleError ??= error;
      }
      state.managerLease = undefined;
      host.commitSupervisoryProfile(undefined);
      host.setLeadTools(undefined);
      host.resetSupervisionSnapshot();
      return { previousChiefMode, previousControllerRole, lifecycleError };
    };
    if (previousChiefMode === "active" && previousLeadContext)
      return Promise.resolve(
        host.publishLeadRole(
          previousLeadContext,
          "suspended",
          state.chiefModeGeneration,
        ),
      ).then(finish);
    return finish();
  };
  const activateChief = async (
    ctx: ExtensionCommandContext,
    resumed = false,
  ): Promise<string> => {
    if (host.processRole !== "lead")
      throw new Error("Only a lead can activate chief");
    if (!resumed && state.chiefMode === "active" && host.isCurrentChief(ctx)) {
      const sessionId = ctx.sessionManager.getSessionId();
      const lease = state.chiefLease;
      const generation = state.chiefModeGeneration;
      await ctx.waitForIdle();
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        state.chiefMode !== "active" ||
        state.roleSuspended ||
        !lease ||
        state.chiefLease !== lease ||
        state.chiefModeGeneration !== generation ||
        !host.isCurrentChief(ctx)
      )
        throw new Error("Chief mode changed during profile refresh");
      const replacement = host.prepareSupervisoryProfile(ctx, "chief");
      const previous = host.currentSupervisoryProfile(ctx, "chief");
      const previousTools = host.pi.getActiveTools();
      const stillCurrent = () =>
        ctx.sessionManager.getSessionId() === sessionId &&
        state.chiefMode === "active" &&
        !state.roleSuspended &&
        state.chiefLease === lease &&
        state.chiefModeGeneration === generation &&
        host.isCurrentChief(ctx);
      try {
        host.commitSupervisoryProfile(replacement);
        host.reconcileRoleTools();
      } catch (error) {
        if (stillCurrent()) {
          host.commitSupervisoryProfile(previous);
          try {
            host.pi.setActiveTools(previousTools);
          } catch {}
        }
        throw error;
      }
      return "Chief profile refreshed.";
    }
    if (state.controllerRole !== "lead" || state.roleSuspended)
      throw new Error("Chief mode is unavailable to a project Manager");
    const sessionId = ctx.sessionManager.getSessionId();
    host.activationGuard(sessionId, "Chief");
    let profile: SupervisoryProfile;
    try {
      profile = host.prepareSupervisoryProfile(ctx, "chief");
    } catch (error) {
      if (!resumed) throw error;
      profile = host.fallbackSupervisoryProfile(ctx, "chief");
      host.appendDurableError(
        host.pi,
        ctx,
        "pi_herdsman_definition_error",
        error,
      );
    }
    state.chiefActivationRollback = false;
    const generation = ++state.chiefModeGeneration;
    const { paneId, workspaceId, tabId } = host.identity;
    if (!paneId || !tabId || !workspaceId)
      throw new Error("staff requires a herdr lead identity");
    let lease: ChiefLease;
    try {
      lease = host.claimChiefLease({
        build: host.build,
        piSessionId: sessionId,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        paneId,
        tabId,
        workspaceId,
      });
    } catch (error) {
      if (error instanceof ProcessLockOccupiedError) {
        if (resumed) {
          try {
            host.invalidateLeadCoordinationState(
              host.supervisionRuntime(),
              sessionId,
              host.leadInstanceId(),
            );
          } catch (invalidationError) {
            host.appendDurableError(
              host.pi,
              ctx,
              "pi_herdsman_state_error",
              invalidationError,
            );
          }
          host.enterSuspended(ctx);
        } else if (ctx.mode === "tui" && ctx.hasUI)
          await host.focusExistingChief(ctx);
        return "A chief is already active in this herdr runtime.";
      }
      throw error;
    }
    if (generation !== state.chiefModeGeneration) {
      try {
        lease.release();
      } catch (error) {
        host.appendDurableError(host.pi, ctx, "pi_herdsman_role_error", error);
      }
      return "Chief activation cancelled.";
    }
    let enteredChief = false;
    try {
      if (!resumed && !host.getLeadTools())
        host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
      try {
        host.unlinkLeadCoordinationState(host.supervisionRuntime(), sessionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      host.commitSupervisoryProfile(profile);
      host.enterChief(ctx, lease, generation);
      enteredChief = true;
      host.clearNormalUI();
      host.clearSupervisionUI();
      host.startSupervisionUI(ctx);
    } catch (error) {
      state.chiefActivationRollback = true;
      try {
        host.clearSupervisionUI();
      } catch {}
      if (enteredChief) {
        try {
          host.startNormalUI(ctx);
        } catch {}
      }
      host.resetSupervisionSnapshot();
      state.chiefMode = "inactive";
      state.chiefLease = undefined;
      host.commitSupervisoryProfile(undefined);
      host.clearChiefStartPreflight();
      try {
        host.reconcileRoleTools();
      } catch {
        try {
          host.pi.setActiveTools(
            host.executionTools?.() ??
              host.normalizeLeadTools(host.getLeadTools() ?? []),
          );
        } catch (restoreError) {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_role_error",
            restoreError,
          );
          try {
            host.pi.setActiveTools(host.normalizeLeadTools([]));
          } catch (failClosedError) {
            host.appendDurableError(
              host.pi,
              ctx,
              "pi_herdsman_role_error",
              failClosedError,
            );
          }
        }
      }
      try {
        lease.release();
      } catch (releaseError) {
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_role_error",
          releaseError,
        );
      }
      try {
        host.persistRole("lead");
        if (host.coordinationHealthy()) host.persistCoordinatorState();
        if (host.coordinationHealthy()) void host.schedulePeerPresence(ctx);
      } catch {}
      throw error;
    }
    return "Chief mode active.";
  };
  const activateManager = async (
    ctx: ExtensionCommandContext,
  ): Promise<string> => {
    if (state.controllerRole === "manager" && !state.roleSuspended) {
      const sessionId = ctx.sessionManager.getSessionId();
      const lease = state.managerLease;
      await ctx.waitForIdle();
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        state.controllerRole !== "manager" ||
        state.roleSuspended ||
        !lease ||
        state.managerLease !== lease
      )
        throw new Error("Manager mode changed during profile refresh");
      const replacement = host.prepareSupervisoryProfile(ctx, "manager");
      const previous = host.currentSupervisoryProfile(ctx, "manager");
      const previousTools = host.pi.getActiveTools();
      const stillCurrent = () =>
        ctx.sessionManager.getSessionId() === sessionId &&
        state.controllerRole === "manager" &&
        !state.roleSuspended &&
        state.managerLease === lease;
      try {
        host.commitSupervisoryProfile(replacement);
        host.reconcileRoleTools();
      } catch (error) {
        if (stillCurrent()) {
          host.commitSupervisoryProfile(previous);
          try {
            host.pi.setActiveTools(previousTools);
          } catch {}
        }
        throw error;
      }
      return "Manager profile refreshed.";
    }
    if (
      host.processRole !== "lead" ||
      host.controllerScope?.kind !== "root" ||
      state.chiefMode !== "inactive" ||
      state.controllerRole !== "lead" ||
      state.roleSuspended
    )
      throw new Error("/manager requires an ordinary Lead");
    host.activationGuard(ctx.sessionManager.getSessionId(), "Manager");
    const { paneId, tabId, workspaceId } = host.identity;
    if (!paneId || !tabId || !workspaceId)
      throw new Error("/manager requires a Herdr Lead identity");
    const sessionId = ctx.sessionManager.getSessionId();
    let scope: Awaited<ReturnType<typeof localRepositoryScope>> | undefined;
    try {
      scope = await localRepositoryScope(host.pi, ctx, workspaceId, ctx.signal);
    } catch (error) {
      if (
        !(error instanceof OperationError) ||
        error.detail.details?.herdrCode !== "not_git_worktree"
      )
        throw error;
      const skipConfirmation =
        readConfig().managerGitBootstrapWithoutConfirmation;
      if (!ctx.hasUI && !skipConfirmation)
        throw new Error(
          "/manager requires interactive confirmation to initialize Git",
        );
      const target = realpathSync(resolve(ctx.cwd));
      const targetStat = statSync(target, { bigint: true });
      if (
        !targetStat.isDirectory() ||
        targetStat.dev === 0n ||
        targetStat.ino === 0n
      )
        throw new Error("Manager Git target is not a directory");
      const verifyHerdrTarget = async () => {
        const pane = (
          await host.runHerdr(host.pi, ctx, ["pane", "get", paneId], {
            signal: ctx.signal,
          })
        )?.pane;
        const workspace = (
          await host.runHerdr(host.pi, ctx, ["workspace", "get", workspaceId], {
            signal: ctx.signal,
          })
        )?.workspace;
        const paneCwd = pane?.cwd;
        if (
          pane?.pane_id !== paneId ||
          pane?.tab_id !== tabId ||
          pane?.workspace_id !== workspaceId ||
          workspace?.workspace_id !== workspaceId ||
          typeof paneCwd !== "string" ||
          !isAbsolute(paneCwd) ||
          !sameDirectory(paneCwd, target)
        )
          throw new Error(
            "Manager activation cancelled because Herdr workspace identity does not match the approved directory",
          );
      };
      await verifyHerdrTarget();
      if (
        [
          "GIT_DIR",
          "GIT_WORK_TREE",
          "GIT_INDEX_FILE",
          "GIT_COMMON_DIR",
          "GIT_OBJECT_DIRECTORY",
          "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          "GIT_CEILING_DIRECTORIES",
          "GIT_PREFIX",
        ].some((key) => process.env[key])
      )
        throw new Error(
          "Cannot initialize Git while repository-redirection environment variables are set",
        );
      if (
        !skipConfirmation &&
        !(await ctx.ui.confirm(
          "Initialize Git repository?",
          `Initialize ${target} with an empty initial commit, then start Manager mode? Existing files will not be committed.`,
        ))
      )
        throw new Error("Manager activation cancelled.");
      await verifyHerdrTarget();
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        host.identity.workspaceId !== workspaceId ||
        host.identity.paneId !== paneId ||
        host.identity.tabId !== tabId ||
        !sameDirectory(resolve(ctx.cwd), target) ||
        (() => {
          const current = statSync(target, { bigint: true });
          return (
            current.dev !== targetStat.dev || current.ino !== targetStat.ino
          );
        })()
      )
        throw new Error(
          "Manager activation cancelled because the workspace changed",
        );
      const runGit = async (args: string[]) => {
        const result = await host.pi.exec("git", args, {
          cwd: target,
          signal: ctx.signal,
          timeout: 30_000,
        });
        if (result.code !== 0 || result.killed)
          throw new Error(
            `Git ${args[0]} failed: ${result.stderr?.trim() || "process unsuccessful"}`,
          );
        return result.stdout.trim();
      };
      const probeRoot = async (): Promise<string | undefined> => {
        const result = await host.pi.exec(
          "git",
          ["rev-parse", "--show-toplevel"],
          { cwd: target, signal: ctx.signal, timeout: 30_000 },
        );
        if (result.code === 0 && !result.killed)
          return String(result.stdout ?? "").trim();
        if (result.killed) throw new Error("Git repository inspection failed");
        return undefined;
      };
      const bootstrapLock = host.acquireProcessLock(
        join(
          herdsmanTempRoot(),
          "locks",
          `manager-bootstrap-${createHash("sha256").update(target).digest("hex")}`,
        ),
        { name: "Manager Git bootstrap" },
      );
      try {
        const hasRepositoryMetadata = () => {
          let directory = target;
          while (true) {
            try {
              lstatSync(resolve(directory, ".git"));
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            const parent = dirname(directory);
            if (parent === directory) return false;
            directory = parent;
          }
        };
        let root = await probeRoot();
        if (!root) {
          const bare = await host.pi.exec(
            "git",
            ["rev-parse", "--is-bare-repository"],
            { cwd: target, signal: ctx.signal, timeout: 30_000 },
          );
          if (bare.killed)
            throw new Error("Git repository type inspection failed");
          const bareStatus = String(bare.stdout ?? "").trim();
          if (bare.code === 0 && bareStatus === "true")
            throw new Error(
              "Cannot initialize Manager Git inside an existing bare repository",
            );
          if (bare.code === 0 && bareStatus !== "false")
            throw new Error("Git repository type inspection failed");
          if (hasRepositoryMetadata())
            throw new Error(
              "Refusing to initialize: existing Git metadata is invalid or conflicting",
            );
          await runGit(["init", "--initial-branch=main"]);
          root = await probeRoot();
        }
        if (root && !sameDirectory(root, target))
          throw new Error(
            "Refusing to initialize inside an enclosing Git repository",
          );
        if (!root)
          throw new Error(
            "Git initialization could not verify its working-tree root",
          );
        const actualRoot = await runGit(["rev-parse", "--show-toplevel"]);
        if (!sameDirectory(actualRoot, target))
          throw new Error(
            "Git repository root does not match the approved directory",
          );
        const inspectHead = async (): Promise<string | undefined> => {
          const result = await host.pi.exec(
            "git",
            ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            { cwd: target, signal: ctx.signal, timeout: 30_000 },
          );
          if (result.code === 0 && !result.killed)
            return String(result.stdout ?? "").trim();
          if (result.killed || result.code !== 1)
            throw new Error(
              `Git HEAD inspection failed: ${String(result.stderr ?? "").trim() || "process unsuccessful"}`,
            );
          return undefined;
        };
        let head = await inspectHead();
        let createdInitialCommit = false;
        if (!head) {
          const staged = await host.pi.exec(
            "git",
            ["diff", "--cached", "--quiet"],
            { cwd: target, signal: ctx.signal, timeout: 30_000 },
          );
          const index = await runGit(["ls-files", "--stage"]);
          if (
            staged.killed ||
            (staged.code !== 0 && staged.code !== 1) ||
            index
          )
            throw new Error(
              "Refusing to complete an unborn repository with an existing or unreadable index",
            );
          await runGit([
            "commit",
            "--only",
            "--allow-empty",
            "-m",
            "chore: initialize repository",
          ]);
          createdInitialCommit = true;
          head = await inspectHead();
        }
        if (!head) throw new Error("Git did not create an initial commit");
        if (createdInitialCommit) {
          const parents = await runGit([
            "rev-list",
            "--parents",
            "-n",
            "1",
            "HEAD",
          ]);
          if (parents.trim().split(/\s+/).length !== 1)
            throw new Error("Initial Git commit is not a root commit");
          const tree = await runGit(["rev-parse", "HEAD^{tree}"]);
          if (tree !== (await runGit(["mktree"])))
            throw new Error("Initial Git commit is not empty");
        }
        await verifyHerdrTarget();
        const gitCommonDir = await runGit([
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        scope = await localRepositoryScope(
          host.pi,
          ctx,
          workspaceId,
          ctx.signal,
        );
        if (
          !scope ||
          !scope.isPrimary ||
          !sameDirectory(scope.repoKey, gitCommonDir)
        )
          throw new Error(
            "Manager activation could not verify the initialized repository in Herdr",
          );
      } finally {
        bootstrapLock.release();
      }
    }
    if (!scope)
      throw new Error("Manager workspace could not be verified in Herdr");
    if (!scope.isPrimary)
      throw new Error("/manager is available only in the primary workspace");
    if (
      !(await host.remoteChiefAgent(ctx, {
        piSessionId: sessionId,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        paneId,
        tabId,
        workspaceId,
      }))
    )
      throw new Error("Manager identity changed during activation");
    if (ctx.sessionManager.getSessionId() !== sessionId)
      throw new Error(
        "Manager activation cancelled because the session changed",
      );
    host.activationGuard(sessionId, "Manager");
    const profile = host.prepareSupervisoryProfile(ctx, "manager");
    host.captureInheritedTools?.();
    const previousTools =
      host.getLeadTools() ?? host.normalizeLeadTools(host.pi.getActiveTools());
    let lease: ManagerLease;
    try {
      lease = host.claimManagerLease({
        build: host.build,
        piSessionId: sessionId,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        paneId,
        tabId,
        workspaceId,
        repoKey: scope.repoKey,
      });
    } catch (error) {
      if (error instanceof ProcessLockOccupiedError)
        throw new Error("This project already has an active Manager");
      throw error;
    }
    try {
      state.managerLease = lease;
      state.controllerRole = "manager";
      host.commitSupervisoryProfile(profile);
      if (!host.getLeadTools())
        host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
      host.persistRole("manager");
      if (!host.persistCoordinatorState())
        throw new Error("Manager coordination state could not be persisted");
      if (!(await host.remoteChiefAgent(ctx, lease.descriptor)))
        throw new Error("Manager could not be verified in Herdr");
      const currentScope = await localRepositoryScope(
        host.pi,
        ctx,
        workspaceId,
        ctx.signal,
      );
      if (
        !currentScope.isPrimary ||
        !sameDirectory(currentScope.repoKey, scope.repoKey) ||
        !(await host.remoteChiefAgent(ctx, lease.descriptor)) ||
        ctx.sessionManager.getSessionId() !== sessionId
      )
        throw new Error("Manager identity changed during activation");
      host.reconcileRoleTools();
      host.clearNormalUI();
      host.startSupervisionUI(ctx);
      host.advancePeerPresenceGeneration();
      if (host.coordinationHealthy()) await host.schedulePeerPresence(ctx);
      await host.publishLeadRole(ctx, "inactive", state.chiefModeGeneration);
      try {
        await reconcileCurrentManagerAssignments(ctx);
      } catch (error) {
        host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
      }
      return "Manager mode active.";
    } catch (error) {
      state.controllerRole = "lead";
      state.managerLease = undefined;
      host.commitSupervisoryProfile(undefined);
      host.setLeadTools(previousTools);
      try {
        lease.release();
      } catch {}
      try {
        host.persistRole("lead");
      } catch {}
      host.persistLeadCoordination();
      host.reconcileRoleTools();
      host.clearSupervisionUI();
      host.startNormalUI(ctx);
      throw error;
    }
  };
  const leaveManager = async (
    ctx: ExtensionCommandContext,
  ): Promise<string> => {
    if (state.controllerRole !== "manager" || !state.managerLease)
      throw new Error("Manager mode is not active");
    host.invalidateManagerRemovalRequests?.(ctx);
    state.controllerRole = "lead";
    try {
      host.persistRole("lead");
      if (!host.persistCoordinatorState())
        throw new Error("Lead coordination state could not be persisted");
    } catch (error) {
      state.controllerRole = "manager";
      try {
        host.persistRole("manager");
        if (!host.persistCoordinatorState())
          throw new Error("Manager coordination state could not be restored");
      } catch (rollbackError) {
        state.roleSuspended = true;
        host.markLeadCoordinationUnhealthy(ctx);
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_role_error",
          rollbackError,
        );
        host.reconcileRoleTools();
      }
      throw error;
    }
    host.advancePeerPresenceGeneration();
    host.removePeerPresence();
    try {
      state.managerLease.release();
    } catch (error) {
      state.managerLease = undefined;
      state.roleSuspended = true;
      host.markLeadCoordinationUnhealthy(ctx);
      host.reconcileRoleTools();
      throw error;
    }
    state.managerLease = undefined;
    host.commitSupervisoryProfile(undefined);
    host.reconcileRoleTools();
    host.clearSupervisionUI();
    host.startNormalUI(ctx);
    if (host.coordinationHealthy()) await host.schedulePeerPresence(ctx);
    await host.publishLeadRole(ctx, "inactive", state.chiefModeGeneration);
    return "Manager mode left.";
  };
  const deactivateChief = async (ctx: ExtensionContext): Promise<void> => {
    state.chiefModeGeneration++;
    host.advanceChiefInboxGeneration();
    host.clearChiefInboxTimer();
    host.clearSupervisionUI?.();
    host.commitSupervisoryProfile(undefined);
    if (state.leadContext)
      await host.publishLeadRole(
        state.leadContext,
        "suspended",
        state.chiefModeGeneration,
      );
    await host.restoreLeadExecution?.(ctx);
    host.enterLead(ctx);
    await host.waitForPeerPresence();
    if (process.env.HERDR_SOCKET_PATH) host.startChiefInbox(ctx);
    host.startNormalUI?.(ctx);
  };
  const leaveChief = async (ctx?: ExtensionCommandContext): Promise<string> => {
    if (ctx?.hasUI) {
      if (
        !(await ctx.ui.confirm(
          "Leave chief mode?",
          "Supervised leads will not be changed.",
        ))
      )
        return "Chief leave cancelled.";
    }
    if (ctx) await deactivateChief(ctx);
    return "Chief mode left.";
  };
  const failClosedRole = async (
    ctx: ExtensionContext,
    error: unknown,
  ): Promise<void> => {
    host.appendDurableError(host.pi, ctx, "pi_herdsman_role_error", error);
    if (!host.getLeadTools())
      host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
    try {
      host.persistRole("lead");
    } catch (persistError) {
      host.appendDurableError(
        host.pi,
        ctx,
        "pi_herdsman_role_error",
        persistError,
      );
    }
    host.markLeadCoordinationUnhealthy(ctx);
    if (state.chiefMode !== "inactive") {
      try {
        await deactivateChief(ctx);
      } catch (transitionError) {
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_role_error",
          transitionError,
        );
        host.enterLead(ctx, false);
      }
    } else host.enterLead(ctx, false);
    host.pi.setActiveTools(
      host.pi
        .getActiveTools()
        .filter((name: string) => !host.supervisorTools.includes(name)),
    );
  };
  const reconcileBranchRole = async (ctx: ExtensionContext): Promise<void> => {
    let branchRole;
    try {
      branchRole = host.sessionLeadRoleState(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionId(),
      );
    } catch (error) {
      await failClosedRole(ctx, error);
      return;
    }
    if (branchRole?.role === "chief") {
      if (!host.getLeadTools()) host.setLeadTools([...branchRole.leadTools]);
      if (state.chiefMode === "active" && host.isCurrentChief(ctx)) {
        host.reconcileRoleTools();
        return;
      }
      if (state.chiefMode === "active") await deactivateChief(ctx);
      try {
        await host.activateChief(ctx, true);
      } catch (error) {
        if (error instanceof ProcessLockOccupiedError) host.enterSuspended(ctx);
        else {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_role_error",
            error,
          );
          if (state.chiefActivationRollback)
            state.chiefActivationRollback = false;
          else host.enterLead(ctx);
        }
      }
      return;
    }
    if (!host.getLeadTools())
      host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
    if (state.chiefMode !== "inactive") await deactivateChief(ctx);
    else host.reconcileRoleTools();
  };
  const reconcileRoleTools = (): void => {
    if (host.controllerScope?.kind !== "root") return;
    try {
      host.captureInheritedTools?.();
    } catch (error) {
      if (state.leadContext)
        host.appendDurableError(
          host.pi,
          state.leadContext,
          "pi_herdsman_state_error",
          error,
        );
      // Retry only while the current execution still authorizes inheritance;
      // restoration can invalidate it without clearing the previous marker.
      const inheritingExecution = host.inheritedProjection?.();
      const canRetryCapture =
        !state.roleSuspended &&
        state.chiefMode === "inactive" &&
        activeLeadRole(state) === "lead" &&
        inheritingExecution !== undefined;
      if (canRetryCapture) {
        const current = host.pi.getActiveTools();
        const permitted = host.normalizeLeadTools(
          current.filter(
            (name) =>
              !inheritingExecution.excluded.some((pattern) =>
                matchesToolPattern(pattern, name),
              ),
          ),
        );
        if (!sameToolSelection(current, permitted))
          host.pi.setActiveTools(permitted);
        return;
      }
      host.setInheritedProjection?.(undefined);
    }
    if (state.controllerRole === "manager" && !state.roleSuspended) {
      let held = false;
      try {
        const descriptor =
          state.managerLease &&
          host.readManagerDescriptor(
            host.supervisionRuntime(),
            state.managerLease.descriptor.workspaceId,
          );
        held =
          !!descriptor &&
          !!state.managerLease &&
          host.sameManagerDescriptor(descriptor, state.managerLease.descriptor);
      } catch {}
      if (!held) {
        state.roleSuspended = true;
        host.advancePeerPresenceGeneration();
        host.removePeerPresence();
        if (state.leadContext)
          void host.publishLeadRole(
            state.leadContext,
            "suspended",
            state.chiefModeGeneration,
          );
      }
    }
    if (state.roleSuspended || state.chiefMode === "suspended") {
      host.setInheritedProjection?.(undefined);
      const baseline = host.normalizeBaseTools(
        host.getLeadTools() ?? host.pi.getActiveTools(),
      );
      const management = state.leadContext
        ? host.ownedAgentManagementTools(state.leadContext)
        : [];
      host.pi.setActiveTools([...new Set([...baseline, ...management])]);
      return;
    }
    if (activeLeadRole(state) === "chief") {
      host.setInheritedProjection?.(undefined);
      host.pi.setActiveTools(
        (state.leadContext &&
          host.supervisoryTools(state.leadContext, "chief")) ?? [
          ...host.chiefTools,
        ],
      );
      return;
    }
    if (activeLeadRole(state) === "manager") {
      host.setInheritedProjection?.(undefined);
      const managerTools = (state.leadContext &&
        host.supervisoryTools(state.leadContext, "manager")) ?? [
        ...host.managerTools,
      ];
      if (!sameToolSelection(host.pi.getActiveTools(), managerTools))
        host.pi.setActiveTools(managerTools);
      return;
    }
    const current = host.pi.getActiveTools();
    const source = host.getLeadTools()
      ? [...host.getLeadTools()!]
      : host.normalizeBaseTools(current);
    const next = host.executionTools?.() ?? host.normalizeLeadTools(source);
    if (!sameToolSelection(current, next)) host.pi.setActiveTools(next);
    const projection = host.inheritedProjection?.();
    host.setInheritedProjection?.(
      !state.roleSuspended &&
        projection !== undefined &&
        sameToolSelection(host.pi.getActiveTools(), next)
        ? projection
        : undefined,
    );
  };
  const resolveControllerRole = (
    ctx: ExtensionContext,
    requestedRole: SessionRole,
    optional = false,
  ): Promise<void> => {
    const generation = state.sessionGeneration;
    const resolve = (profile?: SupervisoryProfile, commit = true) => {
      const pending = resolveLeadControllerRole(
        state,
        ctx,
        requestedRole,
        {
          identity: host.identity,
          build: host.build,
          localRepositoryScope: (workspaceId, signal) =>
            localRepositoryScope(host.pi, ctx, workspaceId, signal),
          claimManagerLease: host.claimManagerLease,
          coordinationHealthy: host.coordinationHealthy,
          verifyManagerIdentity: (descriptor) =>
            host.remoteChiefAgent(ctx, descriptor),
          verifyCurrentIdentity: () =>
            host.remoteChiefAgent(ctx, {
              piSessionId: ctx.sessionManager.getSessionId(),
              piSessionFile: ctx.sessionManager.getSessionFile(),
              ...host.identity,
            } as Pick<
              ChiefDescriptor,
              | "piSessionId"
              | "piSessionFile"
              | "paneId"
              | "tabId"
              | "workspaceId"
            >),
          unresolvedManagerLease: () => {
            host.markLeadCoordinationUnhealthy(ctx);
            reconcileRoleTools();
          },
          activationGuard: host.activationGuard,
          persistLeadRole: () => host.persistRole("lead"),
          isCurrent: () => state.sessionGeneration === generation,
        },
        optional,
      );
      if (!commit) return pending;
      return pending.then(() => {
        if (state.sessionGeneration !== generation) return;
        host.commitSupervisoryProfile(
          state.controllerRole === "manager" && !state.roleSuspended
            ? profile
            : undefined,
        );
      });
    };
    if (requestedRole !== "manager" && !optional)
      return resolve(undefined, false);
    let profile: SupervisoryProfile | undefined;
    if (requestedRole === "manager" || optional) {
      try {
        profile = host.prepareSupervisoryProfile(ctx, "manager");
      } catch (error) {
        if (optional) throw error;
        profile = host.fallbackSupervisoryProfile(ctx, "manager");
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_definition_error",
          error,
        );
      }
    }
    return resolve(profile);
  };
  const finalizeOptionalManagerStartup = (ctx: ExtensionContext): void => {
    if (state.controllerRole !== "manager" || !state.managerLease) return;
    try {
      if (!host.persistLeadCoordination())
        throw new Error("Manager coordination state could not be published");
      host.assertCurrentLeadCoordination(ctx);
      return;
    } catch (error) {
      const lease = state.managerLease;
      state.managerLease = undefined;
      state.controllerRole = "lead";
      try {
        lease.release();
      } catch (releaseError) {
        state.managerLease = lease;
        state.controllerRole = "manager";
        state.roleSuspended = true;
        host.markLeadCoordinationUnhealthy(ctx);
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_role_error",
          releaseError,
        );
        try {
          reconcileRoleTools();
        } catch (toolsError) {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_role_error",
            toolsError,
          );
        }
        host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
        return;
      }
      try {
        reconcileRoleTools();
      } catch (toolsError) {
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_role_error",
          toolsError,
        );
      }
      host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
      if (!host.persistLeadCoordination()) return;
      try {
        host.assertCurrentLeadCoordination(ctx);
      } catch (leadError) {
        host.appendDurableError(
          host.pi,
          ctx,
          "pi_herdsman_state_error",
          leadError,
        );
      }
    }
  };
  const suspendMalformedRole = (ctx: ExtensionContext): void => {
    state.roleSuspended = true;
    try {
      state.managerLease?.release();
    } catch (error) {
      host.appendDurableError(host.pi, ctx, "pi_herdsman_role_error", error);
    }
    state.managerLease = undefined;
    reconcileRoleTools();
  };
  return {
    beginShutdownRole,
    shutdownRole,
    branchRoleObservation: () => ({
      watchBeforeReconcile: state.chiefMode === "inactive",
      wasChief: state.chiefMode !== "inactive",
    }),
    beginSessionRole,
    activateChief,
    activateManager,
    leaveManager,
    deactivateChief,
    leaveChief,
    failClosedRole,
    reconcileBranchRole,
    reconcileRoleTools,
    resolveControllerRole,
    finalizeOptionalManagerStartup,
    restoreChiefState: (ctx: ExtensionContext) =>
      restoreLeadChiefState(ctx, host),
    suspendMalformedRole,
    shouldRestoreChief: (persistedRole: SessionRole) =>
      persistedRole === "chief" &&
      state.controllerRole === "lead" &&
      !state.roleSuspended,
    activeChiefGeneration: () =>
      state.chiefMode === "active" ? state.chiefModeGeneration : undefined,
    currentRoleGeneration: () => state.chiefModeGeneration,
    mayPublishLeadPresence: () =>
      state.chiefMode === "inactive" &&
      !state.roleSuspended &&
      host.coordinationHealthy(),
    canStartChiefInbox: () =>
      !state.roleSuspended &&
      (state.chiefMode === "inactive" || state.chiefMode === "active") &&
      (state.chiefMode === "active" || host.coordinationHealthy()),
    activeManager: () =>
      state.controllerRole === "manager" && !state.roleSuspended,
    canRestoreChiefState: () => !state.roleSuspended,
    chiefModeInactive: () => state.chiefMode === "inactive",
    chiefModeActive: () => state.chiefMode === "active",
    leadPresentationAllowed: () =>
      activeLeadRole(state) === "lead" && !state.roleSuspended,
    consumeChiefActivationRollback: () => {
      const rollback = state.chiefActivationRollback;
      state.chiefActivationRollback = false;
      return rollback;
    },
    currentWorktreeScope,
    projectAssignmentForScope,
    projectEvidenceForWorkspace,
    managerForScope,
    withProjectWorkLock,
    withProjectAssignmentLock,
    publishProjectMessage,
    currentManager,
    reconcileCurrentManagerAssignments,
    currentChief,
    currentChiefAuthority,
    currentSupervisor,
    resolveEffectiveSupervisor,
    retireRemovedProjectWork,
    reconcileProjectAssignments,
    clearLeadContext: () => {
      state.leadContext = undefined;
    },
  };
}
