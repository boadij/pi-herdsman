import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { SelectItem } from "@earendil-works/pi-tui";
import type {
  ChiefLease,
  ChiefDescriptor,
  ManagerDescriptor,
  ManagerLease,
  ProjectAssignment,
  ProjectMessage,
  ChiefMessageRecord,
  ChiefInboxDrainOptions,
  ChiefMessageKind,
  PeerLeadRecord,
  WorkspaceProvenance,
  SessionRole,
  PeerRuntime,
  SupervisionSnapshot,
} from "./supervision.ts";
import {
  leadSupervisorState as resolveLeadSupervisorState,
  supervisorStateMessage,
  verifyManagerCoordinationAuthority,
  verifyRemoteChiefAuthority,
} from "./supervision.ts";
import { OperationError } from "./errors.ts";
import { verifiedHerdrAgent } from "./herdr.ts";
import { ProcessLockOccupiedError } from "./lock.ts";
import { contentText, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { prepareMessageInput } from "./core.ts";
import {
  createAgentController,
  buildAgentStatusSnapshot,
  createAgentStatusRuntime,
  type AgentControllerOptions,
  type AgentStatusSnapshotHost,
  type PendingStart,
  type Runtime,
  type ControllerScope,
  type ManagedAgentSnapshotCollection,
  type ManagedAgentSnapshotView,
} from "./agent-controller.ts";
import type {
  ExpectedSession,
  HerdrRecord,
  HerdrSessionSnapshot,
  RemovedHerdrWorktree,
  WorktreeGroupScope,
} from "./herdr.ts";
import type { RuntimeBuild } from "./compatibility.ts";
import type { AgentDefinition } from "./agent-definitions.ts";
import type { MessageFileInput } from "./core.ts";
import type { ManagedAgentState, ResultBinding } from "./mailbox.ts";
import {
  compactModelToken,
  buildStatusRows,
  renderRunningOptions,
  formatStatusCounts,
  createSupervisionWidget,
  padVisible,
  type StatusSnapshot,
  visibleWidth,
} from "./presentation.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { persistedTranscriptReady as controllerPersistedTranscriptReady } from "./agent-controller.ts";

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
  reportLeadMetadata: typeof import("./herdr.ts").reportLeadMetadata;
  delay: typeof import("node:timers/promises").setTimeout;
  removeProjectAssignment: typeof import("./supervision.ts").removeProjectAssignment;
  removeProjectMessages: typeof import("./supervision.ts").removeProjectMessages;
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
  prepareCoordinationInput: ReturnType<
    typeof createLeadCoordinationRuntime
  >["prepareCoordinationInput"];
  projectMessageBytes: typeof import("./supervision.ts").projectMessageBytes;
  writeProjectMessage: typeof import("./supervision.ts").writeProjectMessage;
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
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
    | "currentManager"
    | "liveLead"
    | "managerLease"
    | "pi"
    | "stopOwnedAgentsForSession"
    | "withProjectWorkLock"
  > & { extensionPath: string; SessionManager: object };
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
    "controller" | "herdRun" | "leadInboxRuntime" | "consumeChiefStartPreflight"
  >;
  sessionStartOptions: Omit<
    Parameters<typeof createLeadSessionStartRuntime>[0],
    | "controller"
    | "herdRun"
    | "leadInboxRuntime"
    | "leadStatusRuntime"
    | "roleTransitions"
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

type LeadCommandHost = {
  runHerdr: typeof runHerdr;
  presentStopSummary(summary: string): void;
  version: string;
  selectMenu(
    ctx: ExtensionContext,
    title: string,
    items: readonly SelectItem[],
    selectedValue?: string,
  ): Promise<string | undefined>;
  selectModelMenu(
    ctx: ExtensionContext,
    items: readonly { value: string; label: string; searchText?: string }[],
    selectedValue?: string,
  ): Promise<string | undefined>;
  readConfig: typeof import("./config.ts").readConfig;
  contextAgentDefinitions(
    ctx: ExtensionContext,
  ): Promise<{ definitions: AgentDefinition[] }>;
  agentDefinitionEnabled(definition: AgentDefinition): boolean;
  agentDefinitionMetadata(definition: AgentDefinition): Record<string, unknown>;
  expandAgentBodyFiles(
    body: string,
    files: readonly string[],
    operation: string,
  ): string;
  appendDefinitionsEntry(data: unknown): void;
  formatAgentDefinitions(
    definitions: readonly Record<string, unknown>[],
  ): string[];
  validThinkingLevels: readonly string[];
  updateAgentOverride(
    definition: AgentDefinition,
    field: string,
    value: unknown,
  ): { changed: boolean; path?: string };
  discoverAgent(
    name: string,
    options?: { projectRoot?: string },
  ): AgentDefinition | undefined;
  placementSettings(ctx: ExtensionContext): Promise<{ effective: string }>;
  updateSpawnPlacement(placement: string): void;
  messageLimits(
    ctx: ExtensionContext,
  ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
  formatMessageLimit(bytes: number): string;
  validByteLimit(bytes: number): boolean;
  input(
    ctx: ExtensionCommandContext,
    label: string,
  ): Promise<string | undefined>;
  updateMessageLimit(key: string, value: number | undefined): void;
  isSpawnPlacement(value: string): boolean;
  isLead(): boolean;
  buildStatusRows: typeof buildStatusRows;
  renderRunningOptions: typeof renderRunningOptions;
  formatStatusCounts: typeof formatStatusCounts;
  openSupervisionOverview(ctx: ExtensionCommandContext): Promise<void>;
  controller: LeadController;
  loadStatusSnapshot(ctx: ExtensionContext): Promise<StatusSnapshot>;
  roleActive(role: "manager" | "chief"): boolean;
  transitionRole(
    role: "manager" | "chief",
    leave: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<unknown>;
  maybeFinishHerdRun(ctx: ExtensionContext): Promise<void>;
  getThinkingLevel(): string;
};
type LeadCommandBaseHost = Omit<
  LeadCommandHost,
  | "isLead"
  | "buildStatusRows"
  | "renderRunningOptions"
  | "formatStatusCounts"
  | "openSupervisionOverview"
  | "controller"
  | "loadStatusSnapshot"
  | "roleActive"
  | "transitionRole"
  | "maybeFinishHerdRun"
  | "getThinkingLevel"
>;

type LeadHerdRunHost = {
  pi: ExtensionAPI;
  entryName: string;
  hasPendingStarts(): boolean;
  listAgentStates(): ReturnType<LeadController["listAgentStates"]>;
  currentWorktreeScope(
    ctx: ExtensionContext,
  ): Promise<WorktreeGroupScope | undefined>;
  projectAssignmentForScope(
    scope: WorktreeGroupScope,
    sessionId: string,
  ): ProjectAssignment | undefined;
  publishProjectMessage(
    ctx: ExtensionContext,
    assignment: ProjectAssignment,
    message: string,
    files?: readonly string[],
    operation?: string,
  ): Promise<ProjectMessage | undefined>;
  requestStatusRefresh(): void;
  queueLeadPresentation(ctx: ExtensionContext, name: string): void;
  appendDurableError(ctx: ExtensionContext, kind: string, error: unknown): void;
};

type LeadProjectHost = {
  currentManager(ctx: ExtensionContext): Promise<ManagerDescriptor | undefined>;
  managerLease(): ManagerLease | undefined;
  sameManagerDescriptor(
    left: ManagerDescriptor,
    right: ManagerDescriptor,
  ): boolean;
  worktreeGroupScope: typeof import("./herdr.ts").worktreeGroupScope;
  findProjectAssignmentBySession: typeof import("./supervision.ts").findProjectAssignmentBySession;
  supervisionRuntime: typeof import("./supervision.ts").supervisionRuntime;
  readProjectAssignment: typeof import("./supervision.ts").readProjectAssignment;
  liveLead(ctx: ExtensionContext, sessionId: string): Promise<HerdrRecord[]>;
  stopOwnedAgentsForSession(
    ctx: ExtensionContext,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string>;
  stopProjectLeadPane(
    ctx: ExtensionContext,
    target: HerdrRecord,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  withProjectWorkLock: LeadRoleTransitionRuntime["withProjectWorkLock"];
  pi: ExtensionAPI;
};

type LeadCoordinationBaseHost = {
  supervisionRuntime: typeof import("./supervision.ts").supervisionRuntime;
  writeLeadCoordinationState: typeof import("./supervision.ts").writeLeadCoordinationState;
  appendDurableError(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    kind: string,
    error: unknown,
  ): void;
  peerRuntime: PeerRuntime;
  listPeerLeadRecords: typeof import("./supervision.ts").listPeerLeadRecords;
  removePeerLeadRecord: typeof import("./supervision.ts").removePeerLeadRecord;
  acquireProcessLock: typeof import("./lock.ts").acquireProcessLock;
  peerLeadLockPath: typeof import("./supervision.ts").peerLeadLockPath;
  workspacePresentationProvenance(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workspaceIds: readonly string[],
    workspaceCwds: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, WorkspaceProvenance>>;
  basename: typeof import("node:path").basename;
  readPeerLeadRecord: typeof import("./supervision.ts").readPeerLeadRecord;
  samePeerLeadRecord: typeof import("./supervision.ts").samePeerLeadRecord;
  writePeerLeadRecord: typeof import("./supervision.ts").writePeerLeadRecord;
  invalidateLeadCoordinationState: typeof import("./supervision.ts").invalidateLeadCoordinationState;
  runHerdr: typeof import("./herdr.ts").runHerdr;
  resolveMessageFiles: typeof import("./agent-controller.ts").resolveMessageFiles;
  messageLimits(
    ctx: ExtensionContext,
  ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
  chiefMessageBytes: typeof import("./supervision.ts").chiefMessageBytes;
  coordinationMessageMaxBytes: number;
  buildSessionProjection: typeof import("@earendil-works/pi-coding-agent").buildSessionProjection;
  contentText: typeof import("@earendil-works/pi-ai").contentText;
  supervisorStateType: string;
  sameManagerDescriptor: typeof import("./supervision.ts").sameManagerDescriptor;
  requireCompatibleBuild: typeof import("./compatibility.ts").requireCompatibleBuild;
  sameRuntimeBuild: typeof import("./compatibility.ts").sameRuntimeBuild;
  samePeerLeadGeneration: typeof import("./supervision.ts").samePeerLeadGeneration;
  writeCoordinationMessage: typeof import("./supervision.ts").writeCoordinationMessage;
  writeChiefMessage: typeof import("./supervision.ts").writeChiefMessage;
  removeChiefMessage: typeof import("./supervision.ts").removeChiefMessage;
  quarantineChiefMessage: typeof import("./supervision.ts").quarantineChiefMessage;
  readLeadCoordinationState: typeof import("./supervision.ts").readLeadCoordinationState;
  matchesExpectedSession: typeof import("./herdr.ts").matchesExpectedSession;
  isPiAgent(agent: HerdrRecord): boolean;
  listProjectAssignments: typeof import("./supervision.ts").listProjectAssignments;
  listProjectMessages: typeof import("./supervision.ts").listProjectMessages;
  readProjectAssignment: typeof import("./supervision.ts").readProjectAssignment;
  importResultBindings: typeof import("./agent-controller.ts").importResultBindings;
};

type LeadCoordinationHost = LeadCoordinationBaseHost & {
  pi: ExtensionAPI;
  leadRuntime: LeadRuntimeState;
  processRole: "lead";
  controllerScope: { kind: "lead" };
  activeRole(): SessionRole;
  HERDSMAN_BUILD: RuntimeBuild;
  leadInstanceId(): string;
  currentManager: LeadRoleTransitionRuntime["currentManager"];
  currentWorktreeScope: LeadRoleTransitionRuntime["currentWorktreeScope"];
  projectAssignmentForScope: LeadRoleTransitionRuntime["projectAssignmentForScope"];
  publishProjectMessage: LeadRoleTransitionRuntime["publishProjectMessage"];
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
  currentSupervisor: LeadRoleTransitionRuntime["currentSupervisor"];
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
  assertCurrentLeadCoordination(ctx: ExtensionContext): void;
  currentChiefAuthority: LeadRoleTransitionRuntime["currentChiefAuthority"];
  currentManager: LeadRoleTransitionRuntime["currentManager"];
  managerForScope: LeadRoleTransitionRuntime["managerForScope"];
  currentPeerPresenceValid(ctx: ExtensionContext): Promise<boolean>;
  drainProjectMessages(ctx: ExtensionContext): Promise<number>;
};

type LeadSupervisionHost = {
  activeRole(): SessionRole;
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
    DynamicBorder: typeof import("@earendil-works/pi-tui").DynamicBorder;
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
  return {
    ownedTools,
    normalizeBaseTools,
    appendRegisteredTools,
    normalizeLeadTools: (tools: readonly string[]) =>
      appendRegisteredTools(normalizeBaseTools(tools), leadCoordinationNames),
    getLeadTools: () => leadTools,
    setLeadTools: (tools: string[] | undefined) => {
      leadTools = tools;
    },
  };
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
  isLead(): boolean;
  herdRun: Pick<LeadHerdRunRuntime, "shutdown">;
}) {
  let shutDown = false;
  return {
    shutdown(_ctx: ExtensionContext): void {
      if (shutDown) return;
      shutDown = true;
      host.roleTransitions.beginShutdownRole();
      host.clearStartupDefinitionRoster();
      host.leadInboxRuntime.beginShutdown();
      host.roleTransitions.shutdownRole();
      host.controller.abortSession();
      host.leadInboxRuntime.shutdown();
      host.controller.clearPendingStarts();
      host.controller.clearSession();
      host.leadStatusRuntime.shutdown();
      host.controller.markSessionInactive();
      host.controller.stopHealthScanner();
      host.clearSupervisionUI();
      host.roleTransitions.clearLeadContext();
      if (host.isLead()) host.herdRun.shutdown();
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
  isLead(): boolean;
  appendRoleError(ctx: ExtensionContext, error: unknown): void;
}) {
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
      if (host.isLead()) {
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
  diagnostic(): void;
  clearDefinitionRoster(): void;
  clearChiefStartPreflight(): void;
  roleTransitions: LeadRoleTransitionRuntime;
  isLead(): boolean;
  isManagedAgent(): boolean;
  appendRoleError(ctx: ExtensionContext, error: unknown): void;
  sessionLeadRoleState(
    entries: readonly any[],
  ): { role: SessionRole; leadTools: string[] } | undefined;
  normalizeLeadTools(tools: readonly string[]): string[];
  setLeadTools(tools: string[] | undefined): void;
  activeTools(): string[];
  failClosedRole(ctx: ExtensionContext, error: unknown): Promise<void>;
  publishLeadRole(
    ctx: ExtensionContext,
    mode: "active",
    generation: number,
  ): void;
  activateChief(ctx: ExtensionContext, resumed: boolean): Promise<void>;
  enterSuspended(ctx: ExtensionContext): void;
  enterLead(ctx: ExtensionContext): void;
  schedulePeerPresence(ctx: ExtensionContext): Promise<void>;
  controller: LeadController;
  leadInboxRuntime: LeadInboxRuntime;
  herdRun: Pick<LeadHerdRunRuntime, "restoreSession" | "finishIfIdle">;
  leadStatusRuntime: Pick<
    LeadStatusRuntime,
    "prepareSession" | "setSnapshot" | "start" | "requestRefresh"
  >;
  clearSupervisionUI(reset?: boolean): void;
  queueLeadPresentation(ctx: ExtensionContext): void;
  setOwnTools(tools: string[] | undefined): void;
  initialStatusBreadcrumb(): string[];
  ownToolsSnapshot(): { ownTools?: string[] };
  startSupervisionUI(ctx: ExtensionContext): void;
  setDefinitionRoster(roster: {
    sessionId: string;
    definitions: Record<string, unknown>[];
  }): void;
  visibleAgentDefinitionMetadata(
    ctx: ExtensionContext,
  ): Promise<Record<string, unknown>[]>;
  appendDefinitionError(ctx: ExtensionContext, error: unknown): void;
}) {
  return {
    async sessionStart(ctx: ExtensionContext): Promise<void> {
      host.diagnostic();
      host.clearDefinitionRoster();
      host.clearChiefStartPreflight();
      const resetRole = host.roleTransitions.beginSessionRole(ctx);
      const { previousChiefMode, previousControllerRole, lifecycleError } =
        resetRole instanceof Promise ? await resetRole : resetRole;
      if (lifecycleError) host.appendRoleError(ctx, lifecycleError);
      if (host.isLead()) {
        const sessionId = ctx.sessionManager.getSessionId();
        host.herdRun.restoreSession(ctx.sessionManager.getEntries(), sessionId);
        let persistedRole: SessionRole = "lead";
        let malformedRole = false;
        try {
          const persisted = host.sessionLeadRoleState(
            ctx.sessionManager.getEntries(),
          );
          if (persisted) {
            persistedRole = persisted.role;
            const activeBaseline = host.normalizeLeadTools(host.activeTools());
            host.setLeadTools(
              persisted.role === "lead" &&
                activeBaseline.some(
                  (name: string) => !host.ownedTools().has(name),
                )
                ? activeBaseline
                : [...persisted.leadTools],
            );
          } else {
            host.setLeadTools(host.normalizeLeadTools(host.activeTools()));
          }
        } catch (error) {
          malformedRole = true;
          await host.failClosedRole(ctx, error);
        }
        try {
          await host.roleTransitions.resolveControllerRole(ctx, persistedRole);
        } catch (error) {
          host.appendRoleError(ctx, error);
        }
        if (malformedRole) host.roleTransitions.suspendMalformedRole(ctx);
        if (host.roleTransitions.canRestoreChiefState())
          host.roleTransitions.restoreChiefState(ctx);
        if (host.roleTransitions.shouldRestoreChief(persistedRole)) {
          try {
            await host.activateChief(ctx, true);
            const generation = host.roleTransitions.activeChiefGeneration();
            if (generation !== undefined)
              host.publishLeadRole(ctx, "active", generation);
          } catch (error) {
            if (error instanceof ProcessLockOccupiedError) {
              host.enterSuspended(ctx);
            } else {
              host.appendRoleError(ctx, error);
              if (!host.roleTransitions.consumeChiefActivationRollback())
                host.enterLead(ctx);
            }
          }
        } else if (!malformedRole) {
          try {
            host.roleTransitions.reconcileRoleTools();
          } catch (error) {
            host.appendRoleError(ctx, error);
          }
        }
        if (host.roleTransitions.mayPublishLeadPresence())
          await host.schedulePeerPresence(ctx);
      }
      host.controller.abortSession();
      host.leadInboxRuntime.beginSession();
      host.controller.clearPendingStarts();
      const sessionSignal = host.controller.beginSession();
      host.controller.sessionStart();
      if (
        host.isLead() &&
        process.env.HERDR_SOCKET_PATH &&
        host.roleTransitions.canStartChiefInbox()
      )
        host.leadInboxRuntime.start(ctx);
      host.leadStatusRuntime.prepareSession(ctx, () =>
        host.clearSupervisionUI(
          previousChiefMode === "active" ||
            previousControllerRole === "manager",
        ),
      );
      if (
        host.isLead() &&
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
      const activeManager =
        host.isLead() && host.roleTransitions.activeManager();
      if (
        host.isLead() &&
        (host.roleTransitions.chiefModeActive() || activeManager)
      )
        host.startSupervisionUI(ctx);
      else host.leadStatusRuntime.start(ctx);
      if (!(
        host.isLead() &&
        (host.roleTransitions.chiefModeActive() || activeManager)
      )) {
        try {
          host.setDefinitionRoster({
            sessionId: ctx.sessionManager.getSessionId(),
            definitions: await host.visibleAgentDefinitionMetadata(ctx),
          });
        } catch (error) {
          host.clearDefinitionRoster();
          host.appendDefinitionError(ctx, error);
        }
      }
      if (host.isManagedAgent()) {
        host.leadStatusRuntime.requestRefresh();
        return;
      }
      if (!activeManager)
        await host.controller.recoverRuntimes(ctx, sessionSignal);
      if (host.isLead()) host.herdRun.finishIfIdle(ctx);
      host.controller.startHealthScanner(ctx, sessionSignal);
    },
  };
}

export function createLeadAgentEventRuntime(host: {
  isCurrentChief(ctx: ExtensionContext): boolean;
  setActiveTools(tools: readonly string[]): void;
  chiefTools: readonly string[];
  leadInboxRuntime: Pick<LeadInboxRuntime, "holdStartPreflight">;
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
  chiefSystemPrompt(options: BuildSystemPromptOptions): string;
  isActiveManager(): boolean;
  roleCharter(): string;
  isActiveLead(): boolean;
  prepareLeadSupervisorStateMessage(
    ctx: ExtensionContext,
  ): Promise<
    { customType: string; content: string; display: boolean } | undefined
  >;
  definitionRoster():
    { sessionId: string; definitions: Record<string, unknown>[] } | undefined;
  consumeChiefStartPreflight(ctx: ExtensionContext): void;
  herdRun: Pick<LeadHerdRunRuntime, "agentStarted" | "agentSettled">;
  controller: Pick<
    LeadController,
    "settleAsks" | "sessionSignal" | "settleResults"
  >;
  isStaffTool(name: string): boolean;
}) {
  return {
    async beforeAgentStart(
      event: any,
      ctx: ExtensionContext,
    ): Promise<{ systemPrompt: string } | undefined> {
      if (host.isCurrentChief(ctx)) {
        host.setActiveTools(host.chiefTools);
        host.leadInboxRuntime.holdStartPreflight(ctx);
        const message = await host.prepareSupervisionMessage(ctx);
        if (message) host.sendMessage(message);
        return {
          systemPrompt: host.chiefSystemPrompt(event.systemPromptOptions),
        };
      }
      const roleCharter = host.roleCharter();
      if (host.isActiveManager()) {
        const message = await host.prepareSupervisionMessage(ctx);
        if (message) host.sendMessage(message);
        return { systemPrompt: `${event.systemPrompt}\n\n${roleCharter}` };
      }
      const supervisorStateMessage = host.isActiveLead()
        ? await host.prepareLeadSupervisorStateMessage(ctx)
        : undefined;
      if (supervisorStateMessage) host.sendMessage(supervisorStateMessage);
      const roster = host.definitionRoster();
      if (!roster || roster.sessionId !== ctx.sessionManager.getSessionId())
        return { systemPrompt: `${event.systemPrompt}\n\n${roleCharter}` };
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n${roleCharter}\n\n` +
          `## Available agent definitions\n\n` +
          `<agent_definitions>\n${JSON.stringify(roster.definitions, null, 2)}\n</agent_definitions>\n\n` +
          `This is the session-start definition snapshot. ` +
          `Use agent_list for live Agent state or to refresh ` +
          `Agent definitions after configuration changes.`,
      };
    },
    agentStart(ctx: ExtensionContext): void {
      host.consumeChiefStartPreflight(ctx);
      host.herdRun.agentStarted();
    },
    async agentSettled(ctx: ExtensionContext): Promise<void> {
      host.controller.settleAsks(ctx, host.controller.sessionSignal());
      host.herdRun.agentSettled(ctx);
      await host.controller
        .settleResults(ctx, host.controller.sessionSignal())
        .catch(() => {});
    },
    toolCall(
      event: any,
      ctx: ExtensionContext,
    ): { block: true; reason: string } | undefined {
      if (host.isStaffTool(event.toolName) || !host.isCurrentChief(ctx))
        return undefined;
      return { block: true, reason: "Chief mode may only use staff tools." };
    },
  };
}

export function createLeadCommandRuntime(host: LeadCommandHost) {
  const modelToken = (model: { provider: string; id: string }): string =>
    `${model.provider}/${model.id}`;
  return {
    async openPlacementMenu(ctx: ExtensionCommandContext): Promise<void> {
      const current = await host.placementSettings(ctx);
      const selected = await host.selectMenu(
        ctx,
        "Layout",
        [
          {
            value: "tab",
            label:
              current.effective === "tab"
                ? "Lead agents tab (current)"
                : "Lead agents tab",
          },
          {
            value: "subtree",
            label:
              current.effective === "subtree"
                ? "Subtree tabs (current)"
                : "Subtree tabs",
          },
          {
            value: "split",
            label:
              current.effective === "split"
                ? "Split from caller (current)"
                : "Split from caller",
          },
        ],
        current.effective,
      );
      if (!selected) return;
      host.updateSpawnPlacement(selected);
      const verified = await host.placementSettings(ctx);
      if (verified.effective !== selected)
        throw new Error(
          `Agent placement did not become effective: ${verified.effective}`,
        );
      ctx.ui.notify(`placement: ${verified.effective}`);
    },
    async openMessageLimitsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedLimit = "inlineAttachmentLimitBytes";
      const presets = [1, 4, 16, 64, 128].map((kib) => ({
        label: host.formatMessageLimit(kib * 1024),
        bytes: kib * 1024,
      }));
      while (true) {
        const limits = await host.messageLimits(ctx);
        const setting = await host.selectMenu(
          ctx,
          "Message limits",
          [
            {
              value: "inlineAttachmentLimitBytes",
              label: `Inline attachments   ${host.formatMessageLimit(limits.inline.bytes)}`,
            },
            {
              value: "mailboxPayloadLimitBytes",
              label: `Mailbox payload      ${host.formatMessageLimit(limits.mailbox.bytes)}`,
            },
          ],
          selectedLimit,
        );
        if (!setting) return;
        selectedLimit = setting;
        const choice = await host.selectMenu(ctx, "Limit", [
          ...presets.map(({ label, bytes }: any) => ({
            value: String(bytes),
            label,
          })),
          { value: "custom", label: "Custom…" },
          { value: "reset", label: "Reset" },
        ]);
        if (!choice) continue;
        let value: number | undefined;
        if (choice === "reset") value = undefined;
        else if (choice === "custom") {
          const input = await host.input(ctx, "Custom limit in KiB (1–1024)");
          if (input === undefined) continue;
          const kib = Number(input);
          if (
            !/^\d+$/u.test(input.trim()) ||
            !host.validByteLimit(kib * 1024)
          ) {
            ctx.ui.notify("Enter an integer from 1 through 1024 KiB", "error");
            continue;
          }
          value = kib * 1024;
        } else value = Number(choice);
        host.updateMessageLimit(selectedLimit, value);
        ctx.ui.notify(
          `${selectedLimit}: ${value === undefined ? "reset" : host.formatMessageLimit(value)}`,
        );
      }
    },
    executionSettings(
      ctx: ExtensionContext,
      definition: AgentDefinition,
    ): { model: string; thinking: string } {
      return {
        model:
          typeof definition.frontmatter.model === "string"
            ? compactModelToken(definition.frontmatter.model)
            : ctx.model
              ? `inherit · ${compactModelToken(modelToken(ctx.model))}`
              : "inherit",
        thinking:
          definition.frontmatter.thinking === false
            ? "off"
            : typeof definition.frontmatter.thinking === "string"
              ? definition.frontmatter.thinking
              : `inherit · ${host.getThinkingLevel()}`,
      };
    },
    resolveConfiguredModel(
      ctx: ExtensionContext,
      configured: string,
    ): Model | undefined {
      const models = ctx.modelRegistry.getAll();
      const canonical = models.find(
        (candidate: Model) => modelToken(candidate) === configured,
      );
      if (canonical) return canonical;
      const compactMatches = models.filter(
        (candidate: Model) =>
          compactModelToken(modelToken(candidate)) === configured,
      );
      return compactMatches.length === 1 ? compactMatches[0] : undefined;
    },
    async openDefinitionsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedDefinition: string | undefined;
      while (true) {
        const definitions = (await host.contextAgentDefinitions(ctx))
          .definitions;
        const bundled = definitions.filter(
          (definition: AgentDefinition) => definition.extensionSource,
        );
        const custom = definitions.filter(
          (definition: AgentDefinition) => !definition.extensionSource,
        );
        const format = (definition: AgentDefinition) => {
          const { model, thinking } = this.executionSettings(ctx, definition);
          const name = `${definition.name}${definition.projectSource ? " [project]" : ""}${definition.overrideSource && (definition.extensionSource || definition.projectSource) ? " *" : ""}`;
          return { name, model, thinking, definition };
        };
        const entries = [...bundled, ...custom].map(format);
        const nameWidth = Math.max(
          0,
          ...entries.map(({ name }) => visibleWidth(name)),
        );
        const modelWidth = Math.max(
          0,
          ...entries.map(({ model }) => visibleWidth(model)),
        );
        const options: { value: string; label: string }[] = [];
        const addGroup = (title: string, group: typeof entries) => {
          if (!group.length) return;
          options.push({ value: "", label: `--- ${title} ---` });
          options.push(
            ...group.map(({ name, model, thinking, definition }) => ({
              value: definition.name,
              label: `${padVisible(name, nameWidth)}  ${padVisible(model, modelWidth)}  ${thinking}`,
            })),
          );
        };
        addGroup("Bundled (* overridden)", bundled.map(format));
        addGroup("Custom", custom.map(format));
        const selected = await host.selectMenu(
          ctx,
          "Definitions",
          options,
          selectedDefinition,
        );
        if (selected === undefined) return;
        if (!selected) continue;
        const selectedEntry = entries.find(
          ({ definition }) => definition.name === selected,
        );
        if (!selectedEntry) continue;
        selectedDefinition = selectedEntry.definition.name;
        let definition = selectedEntry.definition;
        const selectedName = definition.name;
        let selectedAction = "model";
        while (true) {
          const { model, thinking } = this.executionSettings(ctx, definition);
          const action = await host.selectMenu(
            ctx,
            definition.name,
            [
              { value: "model", label: `Model       ${model}` },
              { value: "thinking", label: `Thinking    ${thinking}` },
              {
                value: "enabled",
                label: `Enabled     ${host.agentDefinitionEnabled(definition) ? "yes" : "no"}`,
              },
              { value: "details", label: "Details…" },
            ],
            selectedAction,
          );
          if (!action) break;
          selectedAction = action;
          if (action === "details") {
            let current;
            try {
              current = (
                await host.contextAgentDefinitions(ctx)
              ).definitions.find(
                (candidate: AgentDefinition) => candidate.name === selectedName,
              );
            } catch (error) {
              ctx.ui.notify(String(error), "error");
              break;
            }
            if (!current) {
              ctx.ui.notify(
                `Definition ${selectedName} is no longer available.`,
                "warning",
              );
              break;
            }
            definition = current;
            const metadata = host.agentDefinitionMetadata(current);
            if (ctx.mode === "tui") {
              const instructions = host.expandAgentBodyFiles(
                current.body,
                [],
                "definition details",
              );
              host.appendDefinitionsEntry({
                definitions: [metadata],
                instructions,
              });
            } else
              ctx.ui.notify(host.formatAgentDefinitions([metadata]).join("\n"));
            continue;
          }
          let field: "model" | "thinking" | "enabled";
          let value: string | boolean | undefined;
          if (action === "model") {
            field = "model";
            await ctx.modelRegistry.refresh();
            const models = ctx.modelRegistry.getAvailable();
            const tokens = [
              ...new Set(models.map((item: Model) => modelToken(item))),
            ].sort();
            const configured =
              typeof definition.frontmatter.model === "string"
                ? definition.frontmatter.model
                : undefined;
            if (configured && !tokens.includes(configured)) {
              const resolved = this.resolveConfiguredModel(ctx, configured);
              const resolvedToken = resolved
                ? modelToken(resolved)
                : configured;
              if (!tokens.includes(resolvedToken)) tokens.push(resolvedToken);
            }
            const idCounts = new Map<string, number>();
            for (const token of tokens) {
              const id = compactModelToken(token);
              idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
            }
            const resolvedConfigured = configured
              ? this.resolveConfiguredModel(ctx, configured)
              : undefined;
            const modelsByToken = new Map(
              models.map((item: Model) => [modelToken(item), item]),
            );
            if (resolvedConfigured)
              modelsByToken.set(
                modelToken(resolvedConfigured),
                resolvedConfigured,
              );
            const modelItems = tokens.map((token) => {
              const id = compactModelToken(token);
              return {
                value: token,
                label: idCounts.get(id) === 1 ? id : token,
                searchText: `${id} ${token} ${modelsByToken.get(token)?.name ?? ""}`,
              };
            });
            const selectedModel = await host.selectModelMenu(
              ctx,
              [
                {
                  value: "inherit",
                  label: "Inherit current session",
                  searchText: "Inherit current session inherit",
                },
                ...modelItems,
              ],
              configured
                ? resolvedConfigured
                  ? modelToken(resolvedConfigured)
                  : configured
                : "inherit",
            );
            if (!selectedModel) continue;
            value = selectedModel === "inherit" ? undefined : selectedModel;
          } else if (action === "thinking") {
            field = "thinking";
            await ctx.modelRegistry.refresh();
            const configured =
              typeof definition.frontmatter.model === "string"
                ? definition.frontmatter.model
                : undefined;
            const model = configured
              ? this.resolveConfiguredModel(ctx, configured)
              : ctx.model;
            const levels = model
              ? getSupportedThinkingLevels(model)
              : [...host.validThinkingLevels];
            const configuredThinking =
              definition.frontmatter.thinking === false
                ? "off"
                : typeof definition.frontmatter.thinking === "string"
                  ? definition.frontmatter.thinking
                  : undefined;
            const thinkingItems = [
              { value: "inherit", label: "Inherit current session" },
              ...levels.map((level: string) => ({
                value: level,
                label: level,
              })),
            ];
            if (configuredThinking && !levels.includes(configuredThinking))
              thinkingItems.push({
                value: configuredThinking,
                label: configuredThinking,
              });
            const selectedThinking = await host.selectMenu(
              ctx,
              "Thinking",
              thinkingItems,
              configuredThinking ?? "inherit",
            );
            if (!selectedThinking) continue;
            value =
              selectedThinking === "inherit" ? undefined : selectedThinking;
          } else if (action === "enabled") {
            field = "enabled";
            value = !host.agentDefinitionEnabled(definition);
          } else continue;
          const result = host.updateAgentOverride(definition, field, value);
          const verified = host.discoverAgent(
            definition.name,
            definition.projectSource ? { projectRoot: ctx.cwd } : {},
          );
          if (result.changed && verified.overrideSource !== result.path)
            throw new Error(
              `agent ${definition.name} override verification failed`,
            );
          ctx.ui.notify(
            result.changed
              ? field === "enabled"
                ? `${definition.name} ${value ? "enabled" : "disabled"}.`
                : `${definition.name} ${field} ${value === undefined ? "inherited" : `set to ${value}`}.`
              : `${definition.name} ${field} is already inherited; no change made.`,
          );
          definition = verified;
        }
      }
    },
    async openRunningAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
      const signal = host.controller.sessionSignal();
      const snapshot = await host.loadStatusSnapshot(ctx, signal);
      const rows = host.buildStatusRows(
        snapshot.agents.filter(
          (agent) => agent.state !== "lost" && agent.state !== "unknown",
        ),
        { now: Date.now() },
      );
      if (!rows.length) {
        ctx.ui.notify(
          'No running agents. Ask Pi normally, for example: "Use scout to inspect this repository."',
        );
        return;
      }
      const options = host.renderRunningOptions(rows);
      const optionRows = new Map<string, number>();
      for (const [index, option] of options.entries()) {
        if (optionRows.has(option)) {
          ctx.ui.notify(
            "Running list is ambiguous; reopen Running.",
            "warning",
          );
          return;
        }
        optionRows.set(option, index);
      }
      const selected = await ctx.ui.select("Running", options);
      if (selected === undefined) return;
      const selectedIndex = optionRows.get(selected);
      const selectedRow =
        selectedIndex === undefined || selectedIndex < 0
          ? undefined
          : rows[selectedIndex];
      if (!selectedRow) return;
      const fresh = await host.loadStatusSnapshot(
        ctx,
        host.controller.sessionSignal(),
      );
      const target = fresh.agents.find(
        (agent) =>
          agent.label === selectedRow.label &&
          agent.paneId === selectedRow.paneId &&
          agent.sessionId === selectedRow.sessionId,
      );
      if (!target?.paneId) {
        ctx.ui.notify("Agent changed; reopen Running.", "warning");
        return;
      }
      await host.runHerdr(ctx, ["agent", "focus", target.paneId], {
        signal: host.controller.sessionSignal(),
      });
    },
    showSessionStats(ctx: ExtensionCommandContext): void {
      const stats = host.collectOwnedSessionUsage(ctx);
      ctx.ui.notify(
        host.formatSessionUsage(
          stats.current,
          stats.agents,
          stats.agentSessions,
          stats.complete,
          stats.breakdown,
        ),
      );
    },
    async confirmAndStopAll(ctx: ExtensionCommandContext): Promise<void> {
      const snapshot = await host.loadStatusSnapshot(
        ctx,
        host.controller.sessionSignal(),
      );
      if (!snapshot.agents.length) {
        host.presentStopSummary("No owned agents running.");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Stop all agents?",
        `${host.formatStatusCounts(snapshot.agents)}\n\nActive work or pending results may be discarded.`,
      );
      if (!confirmed) return;
      ctx.abort();
      const summary = await host.controller.stopOwnedAgentsForSession(
        ctx,
        ctx.sessionManager.getSessionId(),
        host.controller.sessionSignal(),
      );
      host.presentStopSummary(summary);
      if (host.isLead()) host.maybeFinishHerdRun(ctx);
    },
    async openAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "running";
      while (true) {
        const snapshot = await host.loadStatusSnapshot(
          ctx,
          host.controller.sessionSignal(),
        );
        const running = host.formatStatusCounts(snapshot.agents) || "0";
        const definitions = (await host.contextAgentDefinitions(ctx))
          .definitions;
        const selected = await host.selectMenu(
          ctx,
          `Pi Herdsman · v${host.version}`,
          [
            { value: "running", label: `Running        ${running}` },
            { value: "stats", label: "Session stats" },
            {
              value: "definitions",
              label: `Definitions    ${definitions.length}`,
            },
            {
              value: "layout",
              label: `Layout         ${(await host.placementSettings(ctx)).effective}`,
            },
            {
              value: "context-retirement",
              label: `Context retirement  ${host.readConfig().contextRetirement ? "on" : "off"}`,
            },
            { value: "message-limits", label: "Message limits" },
            { value: "stop-all", label: "Stop all…" },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "running") await this.openRunningAgentsMenu(ctx);
        else if (selected === "stats") this.showSessionStats(ctx);
        else if (selected === "definitions")
          await this.openDefinitionsMenu(ctx);
        else if (selected === "layout") await this.openPlacementMenu(ctx);
        else if (selected === "context-retirement") {
          const enabled = !host.readConfig().contextRetirement;
          host.updateConfig("contextRetirement", enabled);
          ctx.ui.notify(`context retirement: ${enabled ? "on" : "off"}`);
        } else if (selected === "message-limits")
          await this.openMessageLimitsMenu(ctx);
        else if (selected === "stop-all") await this.confirmAndStopAll(ctx);
      }
    },
    async runRoleCommand(
      role: "manager" | "chief",
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
      const usage = `Usage: /${role} [leave]`;
      if (args.length > 1 || (args[0] && args[0] !== "leave")) {
        ctx.ui.notify(usage, "error");
        return;
      }
      try {
        if (!args.length && host.roleActive(role)) {
          await host.openSupervisionOverview(ctx);
          return;
        }
        ctx.ui.notify(
          await host.transitionRole(role, args[0] === "leave", ctx),
        );
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
      }
    },
    async runAgentsCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      if (!ctx.hasUI) return;
      const usage =
        "Usage: /agents stats | definitions | placement [tab|subtree|split] | stop";
      const placementUsage = "Usage: /agents placement [tab|subtree|split]";
      const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/u) : [];
      try {
        if (!args.length) return void (await this.openAgentsMenu(ctx));
        if (args[0] === "stats" && args.length === 1)
          return void this.showSessionStats(ctx);
        if (args[0] === "definitions" && args.length === 1)
          return void (await this.openDefinitionsMenu(ctx));
        if (args[0] === "placement") {
          if (args.length > 2 || (args[1] && !host.isSpawnPlacement(args[1])))
            return void ctx.ui.notify(placementUsage, "error");
          if (args.length === 1)
            return void (await this.openPlacementMenu(ctx));
          host.updateConfig("spawnPlacement", args[1]);
          const verified = await host.placementSettings(ctx);
          if (verified.effective !== args[1])
            throw new Error(
              `Agent placement did not become effective: ${verified.effective}`,
            );
          return void ctx.ui.notify(`placement: ${verified.effective}`);
        }
        if (args[0] === "stop" && args.length === 1)
          return void (await this.confirmAndStopAll(ctx));
        ctx.ui.notify(usage, "error");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
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
  let roleTransitions!: ReturnType<typeof createLeadRoleTransitions>;
  let identityRuntime!: ReturnType<typeof createLeadIdentityRuntime>;
  const liveAgent: typeof identityRuntime.liveAgent = (...args) =>
    identityRuntime.liveAgent(...args);
  const remoteChiefAgent: typeof identityRuntime.remoteChiefAgent = (...args) =>
    identityRuntime.remoteChiefAgent(...args);
  const liveLead: typeof identityRuntime.liveLead = (...args) =>
    identityRuntime.liveLead(...args);
  const coordinationServices = {
    ...options.coordinationHost,
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    currentWorktreeScope: (ctx: ExtensionContext) =>
      roleTransitions.currentWorktreeScope(ctx),
    projectAssignmentForScope: (
      ...args: Parameters<typeof roleTransitions.projectAssignmentForScope>
    ) => roleTransitions.projectAssignmentForScope(...args),
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
    controllerScope: { kind: "lead" },
    activeRole: () => activeLeadRole(options.leadRuntime),
    HERDSMAN_BUILD: options.build,
    leadInstanceId: () => options.leadRuntime.instanceId,
  });
  const supervisionUiRuntime = createLeadSupervisionRuntime({
    ...options.supervisionHost,
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
  let leadMetadataQueue = Promise.resolve();
  const publishLeadRole = (
    ctx: ExtensionContext,
    mode: "inactive" | "active" | "suspended",
    generation: number,
  ): Promise<void> => {
    const paneId = roleHost.paneId();
    if (!paneId) return Promise.resolve();
    const activeRole = () => activeLeadRole(leadRuntime);
    const leadName =
      mode === "inactive" && activeRole() === "lead"
        ? roleHost.getSessionName()?.trim()
        : undefined;
    const args = [
      "pane",
      "report-metadata",
      paneId,
      "--source",
      "pi-herdsman:lead",
      "--title",
      mode === "active"
        ? "chief"
        : activeRole() === "manager"
          ? "Pi Herdsman manager"
          : leadName || "Pi Herdsman lead",
      ...(mode === "active"
        ? ["--token", "pi_herdsman_role=chief"]
        : mode === "inactive"
          ? ["--token", `pi_herdsman_role=${activeRole()}`]
          : ["--clear-token", "pi_herdsman_role"]),
    ];
    if (mode === "inactive" && activeRole() === "lead")
      args.push(
        leadName ? "--token" : "--clear-token",
        leadName ? `pi_herdsman_name=${leadName}` : "pi_herdsman_name",
      );
    if (mode !== "inactive" || activeRole() !== "lead")
      args.push(
        "--clear-token",
        "pi_herdsman_herd_run_started_at",
        "--clear-token",
        "pi_herdsman_context_percent",
      );
    leadMetadataQueue = leadMetadataQueue
      .catch(() => {})
      .then(async () => {
        if (generation !== leadRuntime.chiefModeGeneration) return;
        await roleHost.runHerdr(pi, ctx, args, {
          noResult: true,
          timeout: 10_000,
        });
      })
      .catch(() => {});
    return leadMetadataQueue;
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
    if (leadRuntime.controllerRole === "manager") {
      void publishLeadRole(
        ctx,
        leadRuntime.roleSuspended ? "suspended" : "inactive",
        leadRuntime.chiefModeGeneration,
      );
      return;
    }
    leadMetadataQueue = leadMetadataQueue
      .catch(() => {})
      .then(() => roleHost.reportLeadMetadata(pi, ctx, metadata))
      .catch(() => {});
  };
  const persistRole = (role: SessionRole): void => {
    const tools = leadToolState.getLeadTools();
    if (!tools) throw new Error("Lead tool baseline is unavailable");
    pi.appendEntry("pi-herdsman-role", { role, leadTools: [...tools] });
  };
  const leadEntryEffects: LeadEntryEffects = {
    advancePresenceGeneration: () =>
      coordinationRuntime.advancePresenceGeneration(),
    clearChiefStartPreflight: () => inboxRuntime.clearStartPreflight(),
    resetSupervisionSnapshot: () => supervisionUiRuntime.reset(),
    removePeerPresence: () => coordinationRuntime.removePeerPresence(),
    reconcileRoleTools: () => roleTransitions.reconcileRoleTools(),
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
  const activationGuard = (
    sessionId: string,
    role: "Chief" | "Manager",
  ): void => {
    if (!coordinationRuntime.coordinationHealthy())
      throw new Error("Lead coordination state is unavailable");
    const { states, issues } = roleHost.scanAgentStates();
    if (issues.length)
      throw new Error(
        `Cannot activate ${role} while managed mailbox state is unresolved`,
      );
    if (states.some(({ state }) => state.ownerSessionId === sessionId))
      throw new Error(`Cannot activate ${role} while owned agent work exists`);
  };
  const roleTransitionServices = {
    ...roleHost,
    controllerScope: { kind: "lead" },
    activationGuard,
    advancePeerPresenceGeneration: () =>
      coordinationRuntime.advancePresenceGeneration(),
    setCoordinationHealthy: (healthy: boolean) =>
      coordinationRuntime.setCoordinationHealthy(healthy),
    normalizeBaseTools: leadToolState.normalizeBaseTools,
    appendRegisteredTools: leadToolState.appendRegisteredTools,
    normalizeLeadTools: leadToolState.normalizeLeadTools,
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
    controllerScope: { kind: "lead" },
    activeRole: () => activeLeadRole(options.leadRuntime),
    pi,
    coordinationHealthy: () => coordinationRuntime.coordinationHealthy(),
    managerDiagnostic,
    managerDiagnosticEvents,
    isCurrentChief: (ctx: ExtensionContext) =>
      options.leadRuntime.chiefMode === "active" &&
      !!options.leadRuntime.chiefLease &&
      options.leadRuntime.chiefLease.descriptor.piSessionId ===
        ctx.sessionManager.getSessionId(),
    prepareSupervisionMessage: (ctx: ExtensionContext) =>
      supervisionUiRuntime.prepareMessage(ctx),
    authorizePeerRecord: (record: ChiefMessageRecord, ctx: ExtensionContext) =>
      coordinationRuntime.authorizePeerRecord(record, ctx),
    assertCurrentLeadCoordination: (ctx: ExtensionContext) =>
      coordinationRuntime.assertCurrentLeadCoordination(ctx),
    currentChiefAuthority: (
      ctx: ExtensionContext,
      failOnVerificationError = false,
    ) => roleTransitions.currentChiefAuthority(ctx, failOnVerificationError),
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    managerForScope: (
      ...args: Parameters<typeof roleTransitions.managerForScope>
    ) => roleTransitions.managerForScope(...args),
    currentPeerPresenceValid: (ctx: ExtensionContext) =>
      coordinationRuntime.currentPeerPresenceValid(ctx),
    drainProjectMessages: (ctx: ExtensionContext) =>
      coordinationRuntime.drainProjectMessages(ctx),
  };
  inboxRuntime = createLeadInboxRuntime(inboxServices);
  let herdRunRuntime: ReturnType<typeof createLeadHerdRunRuntime> | undefined;
  const controller = createAgentController(pi, {
    ...options.controllerServices,
    scope: { kind: "lead" },
    build: options.build,
    onChanged: () => statusRuntime.requestRefresh(),
    onWorkChanged: (ctx: ExtensionContext) => herdRunRuntime?.maybeFinish(ctx),
    onWorktreeRemoved: (
      removed: RemovedHerdrWorktree,
      ctx: ExtensionContext,
      signal: AbortSignal,
    ) => {
      void roleTransitions
        .retireRemovedProjectWork(removed, ctx, signal)
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
    const view = await controller.agentSnapshotView(
      ctx,
      { kind: "lead" },
      signal,
      true,
      allowTranscriptDefinitionFallback,
    );
    return buildAgentStatusSnapshot(view, ctx, {
      ...options.statusSnapshotHost,
      scope: { kind: "lead" },
      listedAgentRecord: controller.listedAgentRecord,
      runtimeForLabel,
      herdStartedAt: () => herdRunRuntime?.startedAt(),
    });
  };
  statusRuntime.configure({
    ...options.statusSnapshotHost,
    pendingStartEntries: () => controller.pendingStartEntries(),
    hasPendingStart: (label: string) => controller.hasPendingStart(label),
    clearPendingStart: (label: string, expected: PendingStart) =>
      controller.clearPendingStart(label, expected),
    loadSnapshot: (ctx: ExtensionContext) =>
      loadStatusSnapshot(ctx, controller.sessionSignal(), false),
    runtimeForLabel: (label: string) => controller.runtimeForLabel(label),
  });
  let projectRuntime: ReturnType<typeof createLeadProjectRuntime>;
  const projectHost = options.projectHost;
  const projectServices = {
    ...projectHost,
    liveAgent,
    liveLead,
    currentManager: (
      ...args: Parameters<typeof roleTransitions.currentManager>
    ) => roleTransitions.currentManager(...args),
    sameManagerDescriptor: projectHost.sameManagerDescriptor,
    withProjectWorkLock: (
      ...args: Parameters<typeof roleTransitions.withProjectWorkLock>
    ) => roleTransitions.withProjectWorkLock(...args),
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
    stopOwnedAgentsForSession: (
      ...args: Parameters<typeof controller.stopOwnedAgentsForSession>
    ) => controller.stopOwnedAgentsForSession(...args),
    pi,
    leadRuntime: options.leadRuntime,
    HERDSMAN_BUILD: options.build,
    HERDSMAN_EXTENSION_PATH: projectHost.extensionPath,
    SessionManager: projectHost.SessionManager,
    stopProjectLead: (...args: Parameters<typeof projectRuntime.stop>) =>
      projectRuntime.stop(...args),
  });
  herdRunRuntime = createLeadHerdRunRuntime({
    pi,
    entryName: options.herdRunEntryName,
    hasPendingStarts: () => controller.hasPendingStarts(),
    listAgentStates: () => controller.listAgentStates(),
    currentWorktreeScope: (ctx: ExtensionContext) =>
      roleTransitions.currentWorktreeScope(ctx),
    projectAssignmentForScope: (
      ...args: Parameters<typeof roleTransitions.projectAssignmentForScope>
    ) => roleTransitions.projectAssignmentForScope(...args),
    publishProjectMessage: (
      ...args: Parameters<typeof roleTransitions.publishProjectMessage>
    ) => roleTransitions.publishProjectMessage(...args),
    requestStatusRefresh: () => statusRuntime.requestRefresh(),
    queueLeadPresentation: options.queueLeadPresentation,
    appendDurableError: options.herdRunServices.appendDurableError,
  });
  const commandRuntime = createLeadCommandRuntime({
    ...options.commandHost,
    isLead: () => true,
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
  const agentEvents = createLeadAgentEventRuntime({
    ...options.agentEventOptions,
    leadInboxRuntime: inboxRuntime,
    herdRun: herdRunRuntime,
    controller,
    consumeChiefStartPreflight: (ctx: ExtensionContext) =>
      inboxRuntime.consumeStartPreflight(ctx),
  });
  const sessionStart = createLeadSessionStartRuntime({
    ...options.sessionStartOptions,
    diagnostic: () => managerDiagnostic("session_start_reached"),
    clearSupervisionUI,
    startSupervisionUI,
    roleTransitions,
    leadStatusRuntime: statusRuntime,
    leadInboxRuntime: inboxRuntime,
    clearChiefStartPreflight: () => inboxRuntime.clearStartPreflight(),
    herdRun: herdRunRuntime,
    controller,
  });
  const sessionTree = createLeadSessionTreeRuntime({
    ...options.sessionTreeOptions,
    roleTransitions,
    controller,
  });
  const shutdown = createLeadShutdownRuntime({
    ...options.shutdownOptions,
    clearSupervisionUI: () => clearSupervisionUI(),
    roleTransitions,
    controller,
    leadStatusRuntime: statusRuntime,
    leadInboxRuntime: inboxRuntime,
    herdRun: herdRunRuntime,
  });
  pi.on("turn_start", () => controller.resetAssignmentGuidance());
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) =>
    agentEvents.beforeAgentStart(event, ctx),
  );
  pi.on("agent_start", (_event: unknown, ctx: ExtensionContext) =>
    agentEvents.agentStart(ctx),
  );
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) =>
    agentEvents.agentSettled(ctx),
  );
  pi.on("tool_call", (event: any, ctx: ExtensionContext) =>
    agentEvents.toolCall(event, ctx),
  );
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) =>
    sessionStart.sessionStart(ctx),
  );
  pi.on("session_info_changed", (event: any, ctx: ExtensionContext) => {
    if (!roleTransitions.chiefModeInactive()) return;
    if (!options.hasPane()) return;
    options.queueLeadPresentation(ctx, event?.name ?? options.sessionName());
  });
  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) =>
    options.queueLeadPresentation(ctx),
  );
  pi.on("session_compact", (_event: unknown, ctx: ExtensionContext) =>
    options.queueLeadPresentation(ctx),
  );
  pi.on("session_tree", (_event: unknown, ctx: ExtensionContext) =>
    sessionTree.sessionTree(ctx),
  );
  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) =>
    shutdown.shutdown(ctx),
  );
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
    descriptor: ChiefDescriptor,
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
  ) => {
    if (host.activeRole() === "chief" && !includeAll) {
      const reports = await directReports(
        ctx,
        suppliedInventory,
        suppliedAgents,
      );
      const managers = reports.filter(
        (report: any) => report.role === "manager",
      );
      return {
        managers,
        leads: reports.filter((report: any) => report.role === "lead"),
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
      const [leads, topology] = await Promise.all([
        directReports(ctx, suppliedInventory, suppliedAgents),
        host.runHerdr(
          host.pi,
          ctx,
          ["worktree", "list", "--workspace", group.primaryWorkspaceId],
          { signal: ctx.signal },
        ),
      ]);
      if (
        topology?.source?.repo_key !== group.repoKey ||
        !Array.isArray(topology?.worktrees)
      )
        throw new Error("Herdr worktree topology is not authoritative");
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
          leads,
        }),
        openWorkspaces,
        leads,
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
    return {
      ...host.projectSupervision({
        agents,
        managedAgents: agentEvidence,
        coordinationStates,
        workspaceProvenance,
        excludedSessionIds: new Set([
          ...host
            .listManagerDescriptors(host.supervisionRuntime())
            .map((manager) => manager.piSessionId),
          ...(host.currentChief() ? [host.currentChief()!.piSessionId] : []),
        ]),
        managedAgentSessionIds,
      }),
      ...(diagnostics ? { diagnostics } : {}),
    };
  };
  const directReports = async (
    ctx: ExtensionContext,
    suppliedInventory?: HerdrSessionSnapshot,
    suppliedAgents?: ManagedAgentSnapshotCollection,
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
      );
      return snapshot.leads.filter((lead) =>
        scope.workspaceIds.includes(lead.workspaceId),
      );
    }
    if (host.activeRole() !== "chief")
      throw new Error("Staff is available only to an active supervisor");
    const chiefAuthority = await host.currentChiefAuthority(ctx);
    if (!chiefAuthority)
      throw new Error("Staff is available only to an active supervisor");
    const managers = [];
    const allLeads = (
      await loadSupervisionSnapshot(
        ctx,
        suppliedInventory,
        suppliedAgents,
        true,
      )
    ).leads;
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
    for (const descriptor of descriptors) {
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
      const leads = allLeads.filter((lead) =>
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
        leads: leads.slice(0, 32).map((lead) => ({
          session: lead.lead,
          displayName: lead.displayName,
          ...(lead.branch ? { branch: lead.branch } : {}),
          runtimeState: lead.runtimeState,
          agentCounts: lead.agentCounts,
        })),
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
  let inFlight: Promise<void> | undefined;
  let pending: ExtensionContext | undefined;
  let overviewGeneration = 0;
  let renderOverview: (() => void) | undefined;
  let renderWidget: (() => void) | undefined;

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
    await ctx.ui.custom(
      (tui: any, theme: any, _keys: any, done: (v: unknown) => void) => {
        const viewGeneration = nextOverviewGeneration();
        const supervisionGeneration = generation(ctx);
        const sessionId = ctx.sessionManager.getSessionId();
        let selected: string | undefined;
        let mode: "overview" | "peek" = "overview";
        let peekLead:
          ReturnType<typeof host.presentationReports>[number] | undefined;
        let peekEvidence: any;
        let list: SelectList | undefined;
        let renderedLeads = "";
        const container = new host.tui.Container();
        const selectTheme = {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("muted", text),
          noMatch: (text: string) => theme.fg("warning", text),
        };
        const isCurrentOverview = (): boolean =>
          viewGeneration === overviewGeneration &&
          generation(ctx) === supervisionGeneration &&
          ctx.sessionManager.getSessionId() === sessionId &&
          (host.state.chiefMode === "active" ||
            (host.activeRole() === "manager" && !host.state.roleSuspended));
        const finish = (): void => {
          if (viewGeneration === overviewGeneration) nextOverviewGeneration();
          renderOverview = undefined;
          done(undefined);
        };
        const focusSelected = (leadId: string): void => {
          void uiActions
            .focusLead(ctx, leadId)
            .then(finish)
            .catch((error) =>
              ctx.ui.notify(String(error).replace(/^Error: /u, ""), "error"),
            );
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
                        value: entry.work.branch,
                        label: entry.work.branch,
                        description: [
                          entry.work.status,
                          entry.work.runtimeState,
                          entry.work.issue,
                        ]
                          .filter(Boolean)
                          .join(" · "),
                      }
                    : {
                        value: entry.lead.lead,
                        label: entry.lead.branch ?? entry.lead.displayName,
                        description: entry.lead.runtimeState,
                      },
                )
              : leads.map((lead) => ({
                  value: lead.lead,
                  label: lead.displayName,
                  description: `${lead.runtimeState}${lead.agentCounts.total ? ` · ${lead.agentCounts.total} agent${lead.agentCounts.total === 1 ? "" : "s"}` : ""}`,
                }));
          if (!items.some((item) => item.value === selected))
            selected = items[0]?.value;
          list = new host.tui.SelectList(items, 8, selectTheme);
          const index = items.findIndex((item) => item.value === selected);
          if (index >= 0) list.setSelectedIndex(index);
          list.onSelectionChange = (item) => {
            if (item) selected = item.value;
          };
          list.onSelect = (item) => {
            if (!item) return;
            if (!work.some((entry) => entry.branch === item.value)) {
              if (host.activeRole() !== "manager")
                return focusSelected(item.value);
              void (async () => {
                const action = await uiActions.selectMenu(
                  ctx,
                  items.find((entry) => entry.value === item.value)?.label ??
                    "Lead",
                  [
                    { value: "focus", label: "Focus" },
                    { value: "stop", label: "Stop Lead" },
                  ],
                );
                if (!action || !isCurrentOverview()) return;
                if (action === "focus") return focusSelected(item.value);
                await uiActions.stopProjectLead(item.value, ctx, ctx.signal);
                await refresh(ctx);
                showOverview();
                tui.requestRender();
              })().catch((error) =>
                ctx.ui.notify(String(error).replace(/^Error: /u, ""), "error"),
              );
              return;
            }
            const branch = item.value;
            const entry = work.find((item) => item.branch === branch);
            if (!entry) return;
            const liveLead = host
              .managerSupervisionItems(snapshot)
              .some(
                (item) =>
                  item.kind === "work" &&
                  item.work.branch === branch &&
                  !!item.lead,
              );
            void (async () => {
              const actions =
                entry.status === "paused"
                  ? [{ value: "resume", label: "Resume" }]
                  : liveLead
                    ? [
                        { value: "focus", label: "Focus Lead" },
                        { value: "stop", label: "Stop Lead" },
                      ]
                    : [];
              if (!actions.length) return;
              const action = await uiActions.selectMenu(ctx, branch, actions);
              if (!action || !isCurrentOverview()) return;
              if (action === "focus") return focusSelected(entry.session);
              if (action === "stop")
                await uiActions.stopProjectLead(entry.session, ctx, ctx.signal);
              else if (action === "resume")
                await uiActions.activateProjectLead(
                  { action: "resume", branch },
                  ctx,
                  ctx.signal,
                );
              await refresh(ctx);
              showOverview();
              tui.requestRender();
            })().catch((error) =>
              ctx.ui.notify(String(error).replace(/^Error: /u, ""), "error"),
            );
          };
          list.onCancel = finish;
          container.clear();
          container.addChild(
            new host.tui.DynamicBorder((line: string) =>
              theme.fg("border", line),
            ),
          );
          container.addChild(
            new host.tui.Text(
              theme.bold(
                theme.fg(
                  "accent",
                  status === "unavailable"
                    ? "Pi Herdsman · unavailable"
                    : host.activeRole() === "manager" && "project" in snapshot
                      ? `Pi Herdsman · ${snapshot.project}`
                      : `Pi Herdsman · ${leads.length} herd${leads.length === 1 ? "" : "s"}${status === "stale" ? " · stale" : ""}`,
                ),
              ),
              0,
              0,
            ),
          );
          container.addChild(list);
          container.addChild(
            new host.tui.Text(
              theme.fg(
                "muted",
                host.activeRole() === "manager"
                  ? "Enter actions · Esc close"
                  : "Space peek · Enter focus · Esc close",
              ),
              0,
              0,
            ),
          );
          container.addChild(
            new host.tui.DynamicBorder((line: string) =>
              theme.fg("border", line),
            ),
          );
          renderedLeads = [
            status,
            ...work.map(
              (item) =>
                `${item.branch}:${item.status}:${item.runtimeState ?? ""}:${item.issue ?? ""}`,
            ),
            ...leads.map(
              (lead) =>
                `${lead.lead}:${lead.runtimeState}:${lead.agentCounts.total}`,
            ),
          ].join("\0");
        };
        const showPeek = (): void => {
          container.clear();
          container.addChild(
            new host.tui.DynamicBorder((line: string) =>
              theme.fg("border", line),
            ),
          );
          if (peekLead)
            container.addChild(
              new host.tui.Text(
                theme.bold(
                  theme.fg("accent", `Peek · ${peekLead.displayName}`),
                ),
                0,
                0,
              ),
            );
          if (peekLead)
            container.addChild(
              new host.tui.Text(
                host
                  .renderSupervisionPeek(peekLead, peekEvidence, 10_000)
                  .join("\n"),
                0,
                0,
              ),
            );
          container.addChild(
            new host.tui.Text(
              theme.fg("muted", "Esc back · Enter focus · Ctrl+C close"),
              0,
              0,
            ),
          );
          container.addChild(
            new host.tui.DynamicBorder((line: string) =>
              theme.fg("border", line),
            ),
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
                  `${lead.lead}:${lead.runtimeState}:${lead.agentCounts.total}`,
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
                mode = "overview";
                showOverview();
                tui.requestRender();
              } else if (
                host.tui.matchesKey(data, host.tui.Key.enter) &&
                peekLead
              )
                focusSelected(peekLead.lead);
              return;
            }
            if (host.tui.matchesKey(data, host.tui.Key.space)) {
              const lead = host
                .presentationReports(snapshot)
                .find((item) => item.lead === selected);
              if (!lead) return;
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
                  (agent: any) =>
                    host.isPiAgent(agent) &&
                    agent?.pane_id === lead.paneId &&
                    agent?.tab_id === lead.tabId &&
                    host.herdrSessionId(agent) === lead.lead &&
                    host.readLeadCoordinationState(
                      host.supervisionRuntime(),
                      lead.lead,
                    )?.piSessionId === lead.lead &&
                    lead.availableActions.includes("inspect"),
                )
                .then((inspection) => {
                  if (!isCurrentOverview()) return;
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
    focusLead: async (ctx: ExtensionContext, leadId: string): Promise<void> => {
      const fresh = await loadSnapshot(ctx);
      const lead = host
        .presentationReports(fresh)
        .find((candidate: any) => candidate.lead === leadId);
      if (!lead) throw new Error("Lead changed; reopen staff.");
      const coordination = host.readLeadCoordinationState(
        host.supervisionRuntime(),
        lead.lead,
      );
      if (
        !coordination ||
        coordination.piSessionId !== lead.lead ||
        (lead.instanceId !== undefined &&
          coordination.instanceId !== lead.instanceId)
      )
        throw new Error("Lead changed; reopen staff.");
      const verified = await host.listAllHerdrAgents(host.pi, ctx, ctx.signal);
      const matches = verified.agents.filter(
        (candidate: any) =>
          candidate?.pane_id === lead.paneId &&
          candidate?.tab_id === lead.tabId &&
          candidate?.workspace_id === lead.workspaceId &&
          host.isPiAgent(candidate) &&
          host.herdrSessionId(candidate) === lead.lead,
      );
      if (matches.length !== 1) throw new Error("Lead changed; reopen staff.");
      await host.runHerdr(host.pi, ctx, ["agent", "focus", lead.paneId], {
        signal: ctx.signal,
      });
    },
    focusChief: async (ctx: ExtensionCommandContext): Promise<void> => {
      const choice = await ctx.ui.select("chief", ["Focus chief", "Cancel"]);
      if (choice !== "Focus chief") return;
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
        const content = host.formatContext(
          contextStatus === "unavailable" ? undefined : snapshot,
          {
            status: contextStatus,
            role: host.activeRole() === "manager" ? "manager" : "chief",
          },
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
        ctx.ui.setWidget("pi-herdsman-staff", (tui: any, theme: any) => {
          renderWidget = () => tui.requestRender();
          return createSupervisionWidget(
            () => snapshot,
            () => status(ctx),
            role,
            theme,
          );
        });
      } catch {
        renderWidget = undefined;
        throw new Error("Unable to register the supervision widget");
      }
    },
    removeWidget: (ctx: ExtensionContext) => {
      try {
        ctx.ui.setWidget("pi-herdsman-staff", undefined);
      } catch {
        // Widget teardown is best-effort during UI failure or shutdown.
      }
    },
    startPeriodic: (ctx: ExtensionContext) => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void refresh(ctx), 2000);
      timer.unref?.();
    },
    stopPeriodic: () => {
      pending = undefined;
      renderOverview = undefined;
      renderWidget = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export function createLeadHerdRunRuntime(host: LeadHerdRunHost) {
  let leadAgentStartedAt: number | undefined;
  let herdRunStartedAt: number | undefined;
  let leadSettled = true;
  const publishSettledProjectHandoff = async (
    ctx: ExtensionContext,
    startedAt: number,
  ): Promise<void> => {
    const scope = await host.currentWorktreeScope(ctx);
    if (!scope) return;
    const assignment = host.projectAssignmentForScope(
      scope,
      ctx.sessionManager.getSessionId(),
    );
    if (!assignment) return;
    const entries = ctx.sessionManager.getBranch();
    let summary: string | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as any;
      if (entry.type !== "message" || entry.message.role !== "assistant")
        continue;
      if ((entry.message.timestamp ?? 0) < startedAt) continue;
      const text = contentText(entry.message.content, "").trim();
      if (text) {
        summary = text;
        break;
      }
    }
    await host.publishProjectMessage(
      ctx,
      assignment,
      summary ? `Herd run settled.\n\n${summary}` : "Herd run settled.",
      [],
      "herd_run",
    );
  };
  const maybeFinish = (ctx: ExtensionContext): void => {
    if (herdRunStartedAt === undefined || !leadSettled) return;
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
      return;
    const startedAt = herdRunStartedAt;
    const completedAt = Date.now();
    try {
      host.pi.appendEntry(host.entryName, {
        phase: "finished",
        sessionId,
        startedAt,
        completedAt,
      });
      herdRunStartedAt = undefined;
      host.requestStatusRefresh();
      host.queueLeadPresentation(ctx);
      void publishSettledProjectHandoff(ctx, startedAt).catch((error) =>
        host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error),
      );
    } catch (error) {
      host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
    }
  };
  const begin = (ctx: ExtensionContext): void => {
    if (herdRunStartedAt !== undefined) return;
    const startedAt = leadAgentStartedAt ?? Date.now();
    herdRunStartedAt = startedAt;
    host.queueLeadPresentation(ctx);
    try {
      host.pi.appendEntry(host.entryName, {
        phase: "started",
        sessionId: ctx.sessionManager.getSessionId(),
        startedAt,
      });
    } catch (error) {
      host.appendDurableError(host.pi, ctx, "pi_herdsman_state_error", error);
    }
    host.requestStatusRefresh();
  };
  return {
    begin,
    maybeFinish,
    agentStarted: () => {
      leadAgentStartedAt = Date.now();
      leadSettled = false;
    },
    agentSettled: (ctx: ExtensionContext) => {
      leadSettled = true;
      maybeFinish(ctx);
    },
    restoreSession: (entries: unknown[], sessionId: string) => {
      leadAgentStartedAt = undefined;
      herdRunStartedAt = restoreHerdRunStartedAt(
        entries,
        sessionId,
        host.entryName,
      );
      leadSettled = herdRunStartedAt === undefined;
    },
    finishIfIdle: (ctx: ExtensionContext) => {
      if (herdRunStartedAt !== undefined && ctx.isIdle()) {
        leadSettled = true;
        maybeFinish(ctx);
      }
    },
    startedAt: () => herdRunStartedAt,
    shutdown: () => {
      leadAgentStartedAt = undefined;
      herdRunStartedAt = undefined;
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

export function createLeadProjectRuntime(host: LeadProjectHost) {
  const stopExecution = async (
    session: string,
    target: HerdrRecord,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const summary = await host.stopOwnedAgentsForSession(ctx, session, signal);
    if (summary.includes("✗") || summary.includes("not closed"))
      throw new Error(`Agent-tree cleanup failed: ${summary}`);
    await host.stopProjectLeadPane(ctx, target, session, signal);
    if ((await host.liveLead(ctx, session)).length)
      throw new Error("Lead remains live after stop; work was preserved");
  };
  const stop = async (
    session: string,
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
    if (assignments.length > 1)
      throw new Error("Multiple project assignments match the Lead session");
    const assignment = assignments[0];
    const close = async () => {
      if (
        assignment &&
        host.readProjectAssignment(
          host.supervisionRuntime(),
          manager.repoKey,
          assignment.branch,
        )?.branch !== assignment.branch
      )
        throw new Error("Project assignment changed before close");
      const live = (await host.liveLead(ctx, session)).filter((agent: any) =>
        scope.workspaceIds.includes(agent.workspace_id),
      );
      if (live.length !== 1)
        throw new Error("Exact live Lead was not found or is ambiguous");
      await stopExecution(session, live[0], ctx, signal);
      return {
        content: [
          {
            type: "text" as const,
            text: `Lead ${session} stopped; project work preserved.`,
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
    return assignment
      ? host.withProjectWorkLock(
          `${manager.repoKey}\0${assignment.branch}`,
          close,
        )
      : close();
  };
  const {
    pi,
    leadRuntime,
    HERDSMAN_BUILD,
    HERDSMAN_EXTENSION_PATH,
    SessionManager,
    currentManager,
    sameManagerDescriptor,
    worktreeGroupScope,
    supervisionRuntime,
    readProjectAssignment,
    runHerdr,
    liveAgent,
    readLeadCoordinationState,
    requireCompatibleBuild,
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
  } = host;
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
    | { action: "stop"; session: string }
    | { action: "inspect" | "transcript"; session: string }
    | { action: "message"; session: string; message: string; files?: string[] };
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
    return withProjectWorkLock(`${repoKey}\0${operation.branch}`, () =>
      activateProjectLeadLocked(operation, ctx, signal),
    );
  };
  const activateProjectLeadLocked = async (
    operation: ProjectLeadActivation,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const operationName =
      operation.action === "resume" ? "staff_resume" : "staff_delegate";
    const manager = await currentManager(ctx);
    if (
      !manager ||
      !leadRuntime.managerLease ||
      !sameManagerDescriptor(manager, leadRuntime.managerLease.descriptor)
    )
      throw new Error("Manager lease is no longer active");
    const group = await worktreeGroupScope(
      pi,
      ctx,
      manager.workspaceId,
      signal,
    );
    if (
      group.repoKey !== manager.repoKey ||
      group.primaryWorkspaceId !== manager.workspaceId
    )
      throw new Error(
        "Manager workspace is not the primary workspace of its Herdr worktree group",
      );
    const primaryWorkspaceId = group.primaryWorkspaceId;
    const runtime = supervisionRuntime();
    const existing = readProjectAssignment(
      runtime,
      manager.repoKey,
      operation.branch,
    );
    if (existing && existing.repoKey !== manager.repoKey)
      throw new Error("Project assignment belongs to another repository");
    if (operation.action === "delegate" && existing)
      throw new Error(
        `Work already exists on ${operation.branch}; resume it with staff_resume.`,
      );
    if (operation.action === "resume" && !existing)
      throw new Error(
        `No existing work was found on ${operation.branch}; start it with staff_delegate and a task.`,
      );
    const id = operation.action === "resume" ? existing!.id : operation.id;
    const branch = operation.branch;
    const topology = await runHerdr(
      pi,
      ctx,
      ["worktree", "list", "--workspace", primaryWorkspaceId],
      { signal },
    );
    if (
      topology?.source?.source_workspace_id !== primaryWorkspaceId ||
      topology?.source?.repo_key !== manager.repoKey ||
      !Array.isArray(topology?.worktrees)
    )
      throw new Error("Herdr worktree topology is not authoritative");
    const branchWorktrees = topology.worktrees.filter(
      (worktree: any) => worktree?.branch === branch,
    );
    if (branchWorktrees.length > 1)
      throw new Error(`Multiple Herdr worktrees match branch ${branch}`);
    const live =
      operation.action === "resume" ? await liveAgent(ctx, existing!.id) : [];
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
      writeChiefMessage({
        version: 2,
        build: HERDSMAN_BUILD,
        id,
        leaseId: manager.leaseId,
        kind: "project_assignment",
        fromSessionId: manager.piSessionId,
        toSessionId: id,
        leadSessionId: id,
        branch: existing!.branch,
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
    if (operation.action === "resume") assignment = existing!;
    else {
      const limits = await messageLimits(ctx);
      const prepared = prepareMessageInput(
        operation.task,
        resolveMessageFiles(ctx, operation.files, "staff_delegate"),
        ctx.cwd,
        "staff_delegate",
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
        ...(prepared.resultBindings.length
          ? { resultBindings: prepared.resultBindings }
          : {}),
      };
      writeProjectAssignment(runtime, assignment);
    }
    try {
      let workspaceId: string | undefined;
      let paneId: string | undefined;
      let tabId: string | undefined;
      let cwd: string | undefined;
      const matchingWorktrees = topology.worktrees.filter(
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
              "--workspace",
              primaryWorkspaceId,
              "--branch",
              assignment.branch,
              "--no-focus",
            ],
            { signal },
          );
          workspaceId = opened?.workspace?.workspace_id;
          paneId = opened?.root_pane?.pane_id;
          tabId = opened?.tab?.tab_id ?? opened?.root_pane?.tab_id;
          cwd = opened?.worktree?.path;
          if (
            opened?.worktree?.branch &&
            opened.worktree.branch !== assignment.branch
          )
            throw new Error(
              "Herdr opened a worktree on a different branch than the persisted assignment",
            );
        }
      } else {
        const args = [
          "worktree",
          "create",
          "--workspace",
          primaryWorkspaceId,
          "--branch",
          assignment.branch,
          "--no-focus",
        ];
        if (operation.action === "resume") {
          const saved = (await SessionManager.listAll()).filter(
            (session) => session.id === assignment.id,
          );
          if (saved.length > 1)
            throw new Error(
              `Pi session ${assignment.id} is ambiguous; project work was preserved.`,
            );
          args.push("--base", assignment.branch);
          if (saved[0]?.cwd) args.push("--path", saved[0].cwd);
        } else args.push("--base", operation.base ?? "HEAD");
        const created = await runHerdr(pi, ctx, args, { signal });
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
              "--session-id",
              assignment.id,
              ctx.isProjectTrusted() ? "--approve" : "--no-approve",
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
        },
      };
    } catch (error) {
      appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
      throw error;
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
    if (params.action === "delegate" || params.action === "resume") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can control project work");
      return activateProjectLead(params, ctx, signal);
    }
    if (params.action === "stop") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can control project work");
      return projectStop(params.session, ctx, signal);
    }
    const refresh = async () => directReports(ctx);
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
    const reports = await refresh();
    const reportSession = (report: any): string =>
      report.session ?? report.lead;
    if (params.action === "list") {
      if (
        !(activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx))
      )
        throw new Error("Supervisor lease is no longer active");
      const managerSnapshot =
        leadRuntime.controllerRole === "manager" && leadRuntime.managerLease
          ? await loadSupervisionSnapshot(ctx)
          : undefined;
      return result({
        ok: true,
        action: "list",
        self: {
          role: activeRole(),
          session: ctx.sessionManager.getSessionId(),
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
        reports: reports.map((report: any) => ({
          role: activeRole() === "chief" ? report.role : "lead",
          session: reportSession(report),
          display_name: report.displayName,
          runtime_state: report.runtimeState,
          agent_counts: report.agentCounts,
          ...(activeRole() === "chief"
            ? {
                project: "project" in report ? report.project : "",
                lead_counts:
                  "leadCounts" in report ? report.leadCounts : undefined,
                leads: "leads" in report ? report.leads : [],
              }
            : {}),
          available_actions: report.availableActions,
        })),
      });
    }
    const lead = reports.find(
      (candidate: any) => reportSession(candidate) === params.session,
    );
    if (!lead)
      throw new Error(
        "Lead target was not found or is no longer eligible. Retry with session set to the exact full Pi session ID shown as session in a fresh automatic supervision snapshot or returned by staff_list; never use display_name.",
      );
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
      return result({
        ok: true,
        action: "inspect",
        session: lead.lead,
        display_name: lead.displayName,
        identity: {
          workspace_id: lead.workspaceId,
          pane_id: lead.paneId,
          tab_id: lead.tabId,
          pi_session_id: reportSession(lead),
        },
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
      const currentLead = (await directReports(ctx)).find(
        (candidate: any) => reportSession(candidate) === params.session,
      );
      if (
        !currentChief ||
        currentChief.leaseId !== authority.leaseId ||
        !currentLead ||
        !sameLeadIdentity(currentLead, lead) ||
        currentLead.piSessionFile !== sessionFile ||
        !currentLead.availableActions.includes("transcript")
      )
        throw new Error("Lead changed during transcript read");
      return result({
        ok: true,
        action: "transcript",
        session: lead.lead,
        display_name: lead.displayName,
        session_id: reportSession(lead),
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
    const currentLead = (await directReports(ctx)).find(
      (candidate: any) => reportSession(candidate) === params.session,
    );
    if (
      !currentLead ||
      !sameLeadTarget(currentLead, lead) ||
      !currentLead.availableActions.includes(params.action)
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
    const prepared = await prepareCoordinationInput(
      ctx,
      params.message,
      resolveMessageFiles(ctx, params.files, `staff.${params.action}`),
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
    const writeLead = (await directReports(ctx)).find(
      (candidate: any) => reportSession(candidate) === params.session,
    );
    if (
      !writeChief ||
      writeChief.leaseId !== finalChief.leaseId ||
      !writeLead ||
      !sameLeadTarget(writeLead, currentLead) ||
      !writeLead.availableActions.includes(params.action)
    )
      throw new Error("Lead or Chief changed before the message was queued");
    const targetState = readLeadCoordinationState(
      supervisionRuntime(),
      reportSession(writeLead),
    );
    requireCompatibleBuild(
      HERDSMAN_BUILD,
      targetState?.build,
      "staff_message",
      `${targetState?.role ?? "Lead"} ${reportSession(writeLead)}`,
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
      text: prepared.text,
      ...(prepared.resultBindings.length
        ? { resultBindings: prepared.resultBindings }
        : {}),
      createdAt,
    };
    const runtime = supervisionRuntime();
    writeChiefMessage(record, runtime);
    return result({
      ok: true,
      action: params.action,
      id: record.id,
      session: lead.lead,
      display_name: lead.displayName,
      next_action:
        "Report activity returns asynchronously; continue only independent work, otherwise end the turn. Do not poll.",
    });
  };
  return { stopExecution, stop, activateProjectLead, executeStaff };
}

export function readLeadSessionIds(
  inventory: HerdrSessionSnapshot,
  mailboxes: ReturnType<typeof import("./mailbox.ts").listAgentStates>,
  workspaceId: string,
  dependencies: {
    matchesExpectedSession: (
      session: unknown,
      expected: { id: string },
    ) => boolean;
    isPiAgent: (agent: HerdrRecord) => boolean;
    supervisionRuntime: () => unknown;
    readLeadCoordinationState: typeof import("./supervision.ts").readLeadCoordinationState;
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
    listPeerLeadRecords,
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
    currentWorktreeScope,
    projectAssignmentForScope,
    currentChiefAuthority,
    currentSupervisor,
    sameManagerDescriptor,
    requireCompatibleBuild,
    sameRuntimeBuild,
    samePeerLeadGeneration,
    writeCoordinationMessage,
    writeChiefMessage,
    readLeadCoordinationState,
    removeChiefMessage,
    quarantineChiefMessage,
    listProjectAssignments,
    listProjectMessages,
    readProjectAssignment,
    importResultBindings,
  } = host;
  const readLeadSessionIdsFromHost = (
    inventory: HerdrSessionSnapshot,
    mailboxes: ReturnType<typeof import("./mailbox.ts").listAgentStates>,
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
      | import("./supervision.ts").ChiefMessageRecord
      | import("./supervision.ts").ProjectMessage,
  ) => {
    const limits = await host.messageLimits(ctx);
    return prepareMessageInput(text, files, ctx.cwd, operation, heading, {
      inlineLimitBytes: limits.inline.bytes,
      mailboxLimitBytes: Math.min(
        limits.mailbox.bytes,
        host.coordinationMessageMaxBytes,
      ),
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
      controllerScope?.kind !== "lead" ||
      leadRuntime.chiefMode !== "inactive" ||
      leadRuntime.roleSuspended
    )
      return true;
    const wasHealthy = leadCoordinationHealthy;
    try {
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        build: HERDSMAN_BUILD,
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
        version: 1,
        build: HERDSMAN_BUILD,
        role: activeRole() === "manager" ? "manager" : "lead",
        piSessionId: sessionId,
        paneId,
        tabId,
        workspaceId,
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
        if (!isCurrent() || peerPresenceRecord !== record) return;
        const workspaceLabel =
          provenance.repoName && provenance.branch
            ? `${provenance.repoName}/${provenance.branch}`
            : (provenance.workspaceLabel ??
              (provenance.workspaceCwd
                ? basename(provenance.workspaceCwd)
                : workspaceId));
        const enriched: PeerLeadRecord = {
          ...record,
          ...(provenance.repoName ? { repo: provenance.repoName } : {}),
          ...(provenance.branch ? { branch: provenance.branch } : {}),
          workspaceLabel,
          updatedAt: Date.now(),
        };
        if (!isCurrent() || peerPresenceRecord !== record) return;
        try {
          const current = readPeerLeadRecord(peerRuntime(), sessionId);
          if (!current || !samePeerLeadRecord(current, record)) return;
          if (!isCurrent() || peerPresenceRecord !== record) return;
          writePeerLeadRecord(peerRuntime(), enriched);
          peerPresenceRecord = enriched;
        } catch (error) {
          if (isCurrent() && peerPresenceRecord === record)
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

  const assertCurrentLeadCoordination = (ctx: ExtensionContext): void => {
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
  };

  const leadSupervisorState = (ctx: ExtensionContext): Promise<string> =>
    resolveLeadSupervisorState(ctx, {
      currentWorktreeScope,
      projectAssignmentForScope,
      currentManager,
      currentChiefAuthority,
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
      leadRuntime.roleSuspended ||
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
  const authorizePeerRecord = async (
    record: ChiefMessageRecord,
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    if (
      leadRuntime.chiefMode !== "inactive" ||
      record.kind !== "peer_message" ||
      !record.build ||
      !sameRuntimeBuild(record.build, HERDSMAN_BUILD) ||
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
    return (
      !!target &&
      (target.role ?? "lead") === activeRole() &&
      target.piSessionId === record.toSessionId
    );
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
      controllerScope?.kind !== "lead" ||
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
    requireCompatibleBuild(
      HERDSMAN_BUILD,
      sender.build,
      "peer_message",
      `local peer presence ${sender.piSessionId}`,
    );
    requireCompatibleBuild(
      HERDSMAN_BUILD,
      target.build,
      "peer_message",
      `peer ${target.piSessionId}`,
    );
    // Best effort only: the target's held presence lock and the inbox
    // message lock are independent process locks, so replacement can race
    // after this reread and before durable publication.
    const record: ChiefMessageRecord = {
      version: 2,
      build: HERDSMAN_BUILD,
      id: recordId,
      leaseId: sender.claim.id,
      kind: "peer_message",
      fromSessionId: sender.piSessionId,
      toSessionId: target.piSessionId,
      leadSessionId: sender.piSessionId,
      text,
      ...(resultBindings.length ? { resultBindings: [...resultBindings] } : {}),
      createdAt,
    };
    writeCoordinationMessage(record, peerRuntime());
    return record;
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
  ): ChiefMessageRecord => {
    assertCurrentLeadCoordination(ctx);
    if (
      leadRuntime.controllerRole === "manager" &&
      (!leadRuntime.managerLease ||
        (await currentManager(ctx))?.leaseId !==
          leadRuntime.managerLease.descriptor.leaseId)
    )
      throw new Error("Manager lease is no longer active");
    const chief = await currentSupervisor(ctx);
    if (!chief) throw new Error("No active supervisor is available");
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
    const freshChief = await currentSupervisor(ctx);
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
    const content = await leadSupervisorState(ctx);
    return supervisorStateMessage(
      supervisorStateType,
      content,
      latestCustomMessageText(ctx, supervisorStateType),
    );
  };
  type PeerOperation =
    | { action: "list" }
    | { action: "message"; session: string; message: string; files?: string[] };
  const executeSupervisorMessage = async (
    _id: string,
    raw: unknown,
    _signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    if (controllerScope.kind !== "lead" || leadRuntime.chiefMode !== "inactive")
      throw new Error("Chief is available only to ordinary leads");
    const params = raw as { message: string; files?: readonly string[] };
    if (typeof params.message !== "string" || !params.message.trim())
      throw new Error("Message must contain non-whitespace text");
    if (!leadCoordinationHealthy)
      throw new Error("Lead coordination state is unavailable");
    let record: ChiefMessageRecord | undefined;
    const releaseCoordinationPublication = await enterCoordinationPublication();
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const scope =
        activeRole() === "lead" ? await currentWorktreeScope(ctx) : undefined;
      const assignment = scope && projectAssignmentForScope(scope, sessionId);
      if (assignment) {
        const published = await publishProjectMessage(
          ctx,
          assignment,
          params.message,
          resolveMessageFiles(ctx, params.files, "supervisor_message"),
        );
        if (!published)
          throw new Error(
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
      const chief =
        activeRole() === "lead"
          ? ((await currentManager(ctx, scope)) ??
            (await currentChiefAuthority(ctx)))
          : await currentSupervisor(ctx);
      if (!chief) throw new Error("No active supervisor is available");
      const recordId = randomUUID();
      const createdAt = Date.now();
      const prepared = await prepareCoordinationInput(
        ctx,
        params.message,
        resolveMessageFiles(ctx, params.files, "supervisor_message"),
        "supervisor_message",
        "Message",
        (candidate, resultBindings) => ({
          version: 2,
          build: HERDSMAN_BUILD,
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
      details: { id: record.id, chiefSessionId: record.toSessionId },
    };
  };
  const executePeerMessage = async (
    _id: string,
    raw: unknown,
    _signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    if (
      controllerScope.kind !== "lead" ||
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
      const self = ctx.sessionManager.getSessionId();
      const peers = listPeerLeadRecords(peerRuntime())
        .filter(
          (record) =>
            (record.role ?? "lead") === activeRole() &&
            record.piSessionId !== self,
        )
        .map((record) => ({
          session: record.piSessionId,
          name: record.name ?? `lead-${record.piSessionId.slice(0, 8)}`,
          cwd: record.cwd ?? "",
          repo: record.repo ?? "",
          branch: record.branch ?? "",
          workspace_label: record.workspaceLabel ?? "",
        }));
      return {
        content: [{ type: "text", text: JSON.stringify({ self, peers }) }],
        details: { ok: true, action: "list", self, peers },
      };
    }
    const sender = await livePeerLead(ctx, ctx.sessionManager.getSessionId());
    const target = await livePeerLead(ctx, params.session);
    if (
      !sender ||
      !target ||
      (sender.role ?? "lead") !== activeRole() ||
      (target.role ?? "lead") !== activeRole()
    )
      throw new Error(
        "Peer target was not found or is no longer a live same-role peer",
      );
    const recordId = randomUUID();
    const createdAt = Date.now();
    const prepared = await prepareCoordinationInput(
      ctx,
      params.message,
      resolveMessageFiles(ctx, params.files, "peer.message"),
      "peer.message",
      "Message",
      (candidate, resultBindings) => ({
        version: 2,
        build: HERDSMAN_BUILD,
        id: recordId,
        leaseId: sender.claim.id,
        kind: "peer_message",
        fromSessionId: sender.piSessionId,
        toSessionId: target.piSessionId,
        leadSessionId: sender.piSessionId,
        text: candidate,
        ...(resultBindings.length
          ? { resultBindings: [...resultBindings] }
          : {}),
        createdAt,
      }),
    );
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
          text: `Peer message queued for ${record.toSessionId}.`,
        },
      ],
      details: {
        ok: true,
        action: "message",
        session: record.toSessionId,
        id: record.id,
      },
    };
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
    const manager = await currentManager(ctx);
    if (
      !manager ||
      !leadRuntime.managerLease ||
      !sameManagerDescriptor(manager, leadRuntime.managerLease.descriptor)
    )
      return 0;
    for (const assignment of listProjectAssignments(
      supervisionRuntime(),
      manager.repoKey,
    )) {
      for (const record of listProjectMessages(
        supervisionRuntime(),
        manager.repoKey,
        assignment.branch,
      )) {
        if (record.fromSessionId !== assignment.id) continue;
        const delivered = ctx.sessionManager
          .getBranch()
          .some(
            (entry: any) =>
              entry?.customType === "pi-herdsman-project_message" &&
              entry?.details?.id === record.id &&
              entry?.details?.repoKey === record.repoKey &&
              entry?.details?.branch === record.branch &&
              entry?.details?.fromSessionId === record.fromSessionId,
          );
        if (delivered) continue;
        const current = await currentManager(ctx);
        const stillAssigned = readProjectAssignment(
          supervisionRuntime(),
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
        importResultBindings(pi, ctx, record.resultBindings, "project_message");
        await pi.sendMessage(
          {
            customType: "pi-herdsman-project_message",
            content: `Project ${record.branch} from lead ${record.fromSessionId}:\n\n${record.text}`,
            display: true,
            details: {
              id: record.id,
              repoKey: record.repoKey,
              branch: record.branch,
              fromSessionId: record.fromSessionId,
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
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
    authorizePeerRecord,
    queuePeerRecord,
    queueChiefRecord,
    enterCoordinationPublication,
    drainProjectMessages,
    readLeadSessionIds: readLeadSessionIdsFromHost,
    supervisorMessage: executeSupervisorMessage,
    peerMessage: executePeerMessage,
    latestCustomMessageText,
    prepareLeadSupervisorStateMessage,
    prepareCoordinationInput,
  };
}
export const activeLeadRole = (state: LeadRuntimeState): SessionRole =>
  state.chiefMode === "inactive" ? state.controllerRole : "chief";

function projectAssignmentInstruction(
  assignment: Pick<ProjectAssignment, "text">,
): string {
  return `${assignment.text}

You are the project Lead for this branch. Be orchestration-first: delegate
substantial bounded execution work to the narrowest capable managed Agent when
it can reasonably own that work. This includes investigation, implementation,
debugging, test and validation execution, review, documentation, and similar
execution work.

Work directly when the work is trivial, inseparable from your branch-level
coordination or integration responsibility, otherwise unsuitable for an Agent,
or delegation would add more coordination than value.

Retain decomposition, architecture, approved scope, technical direction,
integration, conflict resolution, acceptance of Agent outputs, and final
technical decisions within the assignment.

When a delegated herd run settles, summarize its outcome, validation, and
important unresolved points in your normal response. Herdsman handles the
normal Manager handoff automatically.

Use supervisor_message when the Manager must decide or act before normal
settlement, or when material scope, assumptions, risks, or evidence need
attention. Routine status and acknowledgements stay local. Settling your herd is
nonterminal; do not infer project closure from runtime state.`;
}

export function createLeadInboxRuntime(host: LeadInboxHost) {
  let chiefInboxTimer: ReturnType<typeof setTimeout> | undefined;
  let chiefInboxGeneration = 0;
  let chiefInboxAbortController: AbortController | undefined;
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
    assertCurrentLeadCoordination,
    currentChiefAuthority,
    currentManager,
    worktreeGroupScope,
    readProjectAssignment,
    managerForScope,
    listManagerDescriptors,
    remoteChiefAgent,
    liveLead,
    readLeadCoordinationState,
    runHerdr,
    sameRuntimeBuild,
    projectAssignmentInstruction,
    importResultBindings,
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
    record.toSessionId === ctx.sessionManager.getSessionId() &&
    ctx.sessionManager
      .getBranch()
      .some(
        (entry: any) =>
          entry?.customType === `pi-herdsman-${record.kind}` &&
          entry?.details?.id === record.id &&
          entry?.details?.leaseId === record.leaseId &&
          entry?.details?.fromSessionId === record.fromSessionId &&
          entry?.details?.leadSessionId === record.leadSessionId &&
          entry?.details?.askId === record.askId &&
          entry?.details?.branch === record.branch,
      );
  const managerClaimsScope = (
    scope: Awaited<ReturnType<typeof worktreeGroupScope>> | undefined,
  ): boolean => !!managerForScope(scope);
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
  const authorizeChiefRecord = async (
    record: ChiefMessageRecord,
    ctx: ExtensionContext,
    verifyLiveChief = true,
  ): Promise<boolean> => {
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
        record.leaseId !== chief.leaseId ||
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
        return (
          !!state &&
          (state.role ?? "lead") === "lead" &&
          !managerClaimsScope(scope)
        );
      }
      if (record.kind !== "manager_message") return false;
      const manager = listManagerDescriptors(supervisionRuntime()).find(
        (x) => x.piSessionId === record.fromSessionId,
      );
      if (
        !manager ||
        listManagerDescriptors(supervisionRuntime()).filter(
          (x) => x.piSessionId === manager.piSessionId,
        ).length !== 1 ||
        !(await remoteChiefAgent(ctx, manager))
      )
        return false;
      const scope = await worktreeGroupScope(
        pi,
        ctx,
        manager.workspaceId,
        ctx.signal,
      );
      return (
        scope.primaryWorkspaceId === manager.workspaceId &&
        scope.repoKey === manager.repoKey
      );
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
      const scope = await worktreeGroupScope(
        pi,
        ctx,
        manager.workspaceId,
        ctx.signal,
      );
      const state = readLeadCoordinationState(
        supervisionRuntime(),
        record.leadSessionId,
      );
      return (
        leads.filter((item: any) =>
          scope.workspaceIds.includes(item.workspace_id),
        ).length === 1 &&
        !!state &&
        (state.role ?? "lead") === "lead"
      );
    }
    if (activeRole() !== "lead" || leadRuntime.roleSuspended) return false;
    if (record.kind === "chief_message") {
      const chief = await currentChiefAuthority(ctx);
      const state = readLeadCoordinationState(supervisionRuntime(), sessionId);
      return (
        !!chief &&
        !!state &&
        chief.piSessionId === record.fromSessionId &&
        chief.leaseId === record.leaseId &&
        record.leadSessionId === sessionId
      );
    }
    const manager = await currentManager(ctx);
    const state = readLeadCoordinationState(supervisionRuntime(), sessionId);
    return (
      !!manager &&
      !!state &&
      record.leaseId === manager.leaseId &&
      record.fromSessionId === manager.piSessionId &&
      record.leadSessionId === sessionId &&
      record.kind === "manager_message"
    );
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
          (!coordinationHealthy() || leadRuntime.roleSuspended))
      ) {
        throw new Error(`Stale inbox transaction (${phase})`);
      }
      if (transaction.role === "inactive") assertCurrentLeadCoordination(ctx);
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
        isDelivered: (id: string) => {
          const record = transactions.get(id)?.record;
          return record ? messageDelivered(ctx, record) : false;
        },
        isAuthorized: async (record: ChiefMessageRecord) => {
          if (record.kind === "peer_message")
            return authorizePeerRecord(record, ctx);
          try {
            if (verifyLease) {
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
            if (!ctx.isIdle())
              throw new Error(
                "Coordination delivery deferred while recipient is active",
              );
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
              resultBindings = assignment.resultBindings;
              payload = {
                ...(message as object),
                content:
                  `Project assignment for branch ${assignment.branch}:\n\n` +
                  projectAssignmentInstruction(assignment),
              };
            }
            importResultBindings(pi, ctx, resultBindings, record.kind);
            const result = await pi.sendMessage(payload, options);
            if (projectAssignment)
              managerDiagnostic("project_assignment_send", {
                outcome: "resolved",
                triggerTurn: options?.triggerTurn === true,
              });
            return result;
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
        accepted: async (_record: ChiefMessageRecord) => {},
        rejected: (record: ChiefMessageRecord) => {
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
      if (!ctx.isIdle()) return complete(0);
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
        controllerScope?.kind === "lead" &&
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
      chiefInboxAbortController?.abort();
      chiefInboxAbortController = new AbortController();
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
  lifecycleError = captureLifecycleError(
    effects.reconcileRoleTools,
    lifecycleError,
  );
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
): void {
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
    return;
  }
  if (hasRetiredPendingAsk) host.persistCoordinatorState();
  else host.persistLeadCoordination();
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
    worktreeGroupScope: (
      workspaceId: string,
      signal: AbortSignal,
    ) => Promise<{ primaryWorkspaceId: string; repoKey: string }>;
    claimManagerLease: typeof import("./supervision.ts").claimManagerLease;
    persistLeadRole: () => void;
  },
): Promise<void> {
  state.controllerRole = "lead";
  state.roleSuspended = false;
  const { paneId, tabId, workspaceId } = deps.identity;
  if (requestedRole !== "manager" || !paneId || !tabId || !workspaceId) return;
  let scope;
  try {
    scope = await deps.worktreeGroupScope(workspaceId, ctx.signal);
  } catch (error) {
    if (
      error instanceof OperationError &&
      error.detail.details?.herdrCode === "not_git_worktree"
    ) {
      deps.persistLeadRole();
      return;
    }
    state.roleSuspended = true;
    throw error;
  }
  if (scope.primaryWorkspaceId !== workspaceId) {
    deps.persistLeadRole();
    return;
  }
  state.controllerRole = "manager";
  try {
    state.managerLease = deps.claimManagerLease({
      build: deps.build,
      piSessionId: ctx.sessionManager.getSessionId(),
      piSessionFile: ctx.sessionManager.getSessionFile(),
      paneId,
      tabId,
      workspaceId,
      repoKey: scope.repoKey,
    });
  } catch (error) {
    state.managerLease = undefined;
    if (!(error instanceof ProcessLockOccupiedError)) throw error;
    state.roleSuspended = true;
    ctx.ui.notify(
      "Manager unavailable: this project already has an active Manager. Manager mode is suspended.",
      "warning",
    );
  }
}

export function createLeadRoleTransitions(
  state: LeadRuntimeState,
  host: LeadTransitionHost,
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
  const projectAssignmentForScope = (
    scope: WorktreeGroupScope,
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
  const withProjectAssignmentLock = async <T>(
    repoKey: string,
    branch: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const lease = host.acquireProcessLock(
      `${host.projectAssignmentPath(host.supervisionRuntime(), repoKey, branch)}.lock`,
      { name: "project assignment lock" },
    );
    try {
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
    operation = "supervisor_message",
  ): Promise<ProjectMessage | undefined> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtime = host.supervisionRuntime();
    const current = host.readProjectAssignment(
      runtime,
      assignment.repoKey,
      assignment.branch,
    );
    if (!current || current.id !== sessionId) return undefined;
    const id = randomUUID();
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
        host.writeProjectMessage(record, runtime);
        return record;
      },
    );
  };
  const managerForScope = (
    scope: WorktreeGroupScope | undefined,
  ): ManagerDescriptor | undefined => {
    if (!scope) return undefined;
    const status = host.readManagerDescriptorStatus(
      host.supervisionRuntime(),
      scope.primaryWorkspaceId,
    );
    if (!status || !status.live) return undefined;
    if (status.descriptor.repoKey !== scope.repoKey)
      throw new Error("Manager authority does not match project");
    return status.descriptor;
  };
  const currentManager = async (
    ctx: ExtensionContext,
    scope?: WorktreeGroupScope | null,
  ): Promise<ManagerDescriptor | undefined> => {
    const descriptor = managerForScope(
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
  const currentSupervisor = async (ctx: ExtensionContext) =>
    activeLeadRole(state) === "lead"
      ? ((await currentManager(ctx)) ?? (await host.currentChiefAuthority(ctx)))
      : activeLeadRole(state) === "manager"
        ? await host.currentChiefAuthority(ctx)
        : undefined;
  const retireRemovedProjectWork = async (
    removed: { repoKey: string; branch: string },
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const runtime = host.supervisionRuntime();
    const observed = host.readProjectAssignment(
      runtime,
      removed.repoKey,
      removed.branch,
    );
    if (!observed) return;
    const expectedId = observed.id;
    const scope = await currentWorktreeScope(ctx);
    if (!scope || scope.repoKey !== removed.repoKey) return;
    await withProjectWorkLock(
      `${removed.repoKey}\0${removed.branch}`,
      async () => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          if (signal.aborted)
            throw signal.reason ?? new Error("operation aborted");
          try {
            await withProjectAssignmentLock(
              removed.repoKey,
              removed.branch,
              async () => {
                const current = host.readProjectAssignment(
                  runtime,
                  removed.repoKey,
                  removed.branch,
                );
                if (!current || current.id !== expectedId) return;
                host.removeProjectAssignment(
                  runtime,
                  removed.repoKey,
                  removed.branch,
                );
                try {
                  host.removeProjectMessages(
                    runtime,
                    removed.repoKey,
                    removed.branch,
                  );
                } catch (error) {
                  host.appendDurableError(
                    host.pi,
                    ctx,
                    "pi_herdsman_state_error",
                    error,
                  );
                }
              },
            );
            return;
          } catch (error) {
            if (
              !(error instanceof ProcessLockOccupiedError) ||
              Date.now() >= deadline
            )
              throw error;
            await host.delay(50, undefined, { signal });
          }
        }
      },
    );
  };
  const beginShutdownRole = (): void => {
    state.sessionGeneration++;
    host.advancePeerPresenceGeneration();
    host.clearChiefStartPreflight();
  };
  const shutdownRole = (): void => {
    state.chiefModeGeneration++;
    if (host.controllerScope?.kind !== "lead") return;
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
    if (state.controllerRole !== "lead" || state.roleSuspended)
      throw new Error("Chief mode is unavailable to a project Manager");
    const sessionId = ctx.sessionManager.getSessionId();
    host.activationGuard(sessionId, "Chief");
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
      if (!resumed)
        host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
      try {
        host.unlinkLeadCoordinationState(host.supervisionRuntime(), sessionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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
      host.clearChiefStartPreflight();
      try {
        host.reconcileRoleTools();
      } catch {
        try {
          host.pi.setActiveTools(host.getLeadTools() ?? []);
        } catch (restoreError) {
          host.appendDurableError(
            host.pi,
            ctx,
            "pi_herdsman_role_error",
            restoreError,
          );
          try {
            host.pi.setActiveTools(
              (host.getLeadTools() ?? []).filter(
                (name: string) => !host.ownedTools().has(name),
              ),
            );
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
    if (
      host.processRole !== "lead" ||
      host.controllerScope?.kind !== "lead" ||
      state.chiefMode !== "inactive" ||
      state.controllerRole !== "lead" ||
      state.roleSuspended
    )
      throw new Error("/manager requires an ordinary Lead");
    host.activationGuard(ctx.sessionManager.getSessionId(), "Manager");
    const { paneId, tabId, workspaceId } = host.identity;
    if (!paneId || !tabId || !workspaceId)
      throw new Error("/manager requires a Herdr Lead identity");
    const scope = await host.worktreeGroupScope(ctx, workspaceId);
    if (scope.primaryWorkspaceId !== workspaceId)
      throw new Error("/manager is available only in the primary workspace");
    let lease: ManagerLease;
    try {
      lease = host.claimManagerLease({
        build: host.build,
        piSessionId: ctx.sessionManager.getSessionId(),
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
    const previousTools = host.getLeadTools();
    try {
      state.managerLease = lease;
      state.controllerRole = "manager";
      host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
      host.persistRole("manager");
      if (!host.persistCoordinatorState())
        throw new Error("Manager coordination state could not be persisted");
      if (!(await host.remoteChiefAgent(ctx, lease.descriptor)))
        throw new Error("Manager could not be verified in Herdr");
      host.reconcileRoleTools();
      host.clearNormalUI();
      host.startSupervisionUI(ctx);
      host.advancePeerPresenceGeneration();
      if (host.coordinationHealthy()) await host.schedulePeerPresence(ctx);
      await host.publishLeadRole(ctx, "inactive", state.chiefModeGeneration);
      return "Manager mode active.";
    } catch (error) {
      state.controllerRole = "lead";
      state.managerLease = undefined;
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
    if (state.leadContext)
      await host.publishLeadRole(
        state.leadContext,
        "suspended",
        state.chiefModeGeneration,
      );
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
      branchRole = host.sessionLeadRoleState(ctx.sessionManager.getBranch());
    } catch (error) {
      await failClosedRole(ctx, error);
      return;
    }
    if (branchRole?.role === "chief") {
      host.setLeadTools([...branchRole.leadTools]);
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
    host.setLeadTools(host.normalizeLeadTools(host.pi.getActiveTools()));
    if (state.chiefMode !== "inactive") await deactivateChief(ctx);
    else host.reconcileRoleTools();
  };
  const reconcileRoleTools = (): void => {
    if (host.controllerScope?.kind !== "lead") return;
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
      host.pi.setActiveTools(
        host.normalizeBaseTools(
          host.getLeadTools() ?? host.pi.getActiveTools(),
        ),
      );
      return;
    }
    if (activeLeadRole(state) === "chief") {
      host.pi.setActiveTools([...host.chiefTools]);
      return;
    }
    const current = host.pi.getActiveTools();
    const source =
      current.some((name: string) => host.ownedTools().has(name)) &&
      host.getLeadTools()
        ? host.getLeadTools()
        : current;
    host.pi.setActiveTools(
      activeLeadRole(state) === "manager"
        ? host.appendRegisteredTools(
            host.normalizeBaseTools(source),
            host.managerTools,
          )
        : host.normalizeLeadTools(source),
    );
  };
  const resolveControllerRole = (
    ctx: ExtensionContext,
    requestedRole: SessionRole,
  ): Promise<void> =>
    resolveLeadControllerRole(state, ctx, requestedRole, {
      identity: host.identity,
      build: host.build,
      worktreeGroupScope: (workspaceId, signal) =>
        host.worktreeGroupScope(ctx, workspaceId, signal),
      claimManagerLease: host.claimManagerLease,
      persistLeadRole: () => host.persistRole("lead"),
    });
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
    restoreChiefState: (ctx: ExtensionContext) =>
      restoreLeadChiefState(ctx, host),
    suspendMalformedRole,
    shouldRestoreChief: (persistedRole: SessionRole) =>
      persistedRole === "chief" &&
      state.controllerRole === "lead" &&
      !state.roleSuspended,
    activeChiefGeneration: () =>
      state.chiefMode === "active" ? state.chiefModeGeneration : undefined,
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
    managerForScope,
    withProjectWorkLock,
    withProjectAssignmentLock,
    publishProjectMessage,
    currentManager,
    currentChief,
    currentChiefAuthority,
    currentSupervisor,
    retireRemovedProjectWork,
    clearLeadContext: () => {
      state.leadContext = undefined;
    },
  };
}
