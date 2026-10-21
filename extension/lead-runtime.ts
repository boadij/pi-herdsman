import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import type {
  ChiefLease,
  ChiefDescriptor,
  ManagerDescriptor,
  ManagerLease,
  ProjectAssignment,
  ProjectMessage,
  ProjectMessageHeader,
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
  projectTaskSummary,
  COORDINATION_INBOX_SCAN_LIMIT,
  listPendingRetirements,
  removePendingRetirement,
  removeProjectMessagesForAssignment,
  listProjectAssignments,
  migrateProjectAssignmentEvidence,
  listProjectMessageHeaders,
  readProjectMessage,
  supervisionRuntime,
  globalProjectAssignmentSnapshot,
  withProjectAssignmentAuthority,
  readPeerLeadRecord,
  samePeerLeadGeneration,
  samePeerLeadAuthority,
  canMessagePeer,
  staffToolName,
  supervisorStateMessage,
  verifyManagerCoordinationAuthority,
  verifyRemoteChiefAuthority,
} from "./supervision.ts";
import { OperationError } from "./errors.ts";
import { sameObservedSessionPath, verifiedHerdrAgent } from "./herdr.ts";
import { ProcessLockOccupiedError } from "./lock.ts";
import { contentText, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  isLeadExecutionMode,
  prepareMessageInput,
  persistRequiredTextFiles,
  type LeadExecutionMode,
} from "./core.ts";
import {
  persistRequiredEvidenceSnapshot,
  type RequiredEvidence,
} from "./storage.ts";
import {
  createAgentController,
  buildAgentStatusSnapshot,
  createAgentStatusRuntime,
  claimDelegationLock,
  type AgentControllerOptions,
  type AgentStatusSnapshotHost,
  type PendingStart,
  type Runtime,
  type ControllerScope,
  type RootDelegationPolicy,
  type RootDelegationGeneration,
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
import {
  AGENT_COORDINATION_TOOLS,
  agentLaunchArgs,
  configuredToolPolicy,
  configuredModel,
  discoverRoleDefinition,
  isReservedRoleDefinition,
  isRuntimeRoleDefinition,
  RESERVED_ROLE_DEFINITION_NAMES,
  matchesToolPattern,
  expandAgentBodyFiles,
  FLEXIBLE_LEAD_DEFINITION_NAME,
  ORCHESTRATOR_LEAD_DEFINITION_NAME,
  MANAGED_LEAD_DEFINITION_NAME,
  MANAGER_DEFINITION_NAME,
  CHIEF_DEFINITION_NAME,
  resolveChildModel,
  writePrivatePromptSnapshots,
  type AgentDefinition,
  type RoleDefinitionName,
} from "./agent-definitions.ts";
import type { MessageFileInput } from "./core.ts";
import type { ManagedAgentState, ResultBinding } from "./mailbox.ts";
import {
  populateMenuFrame,
  compactModelToken,
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
import { realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
  releaseProjectAssignment: typeof import("./supervision.ts").releaseProjectAssignment;
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

type LeadCommandHost = {
  collectOwnedSessionUsage(
    ctx: ExtensionContext,
    managedLeads?: readonly { id: string; piSessionFile?: string }[],
  ): ReturnType<typeof import("./agent-controller.ts").collectSessionUsage>;
  formatSessionUsage: typeof import("./presentation.ts").formatSessionUsage;
  runHerdr: typeof runHerdr;
  presentStopSummary(summary: string): void;
  version: string;
  selectMenu(
    ctx: ExtensionContext,
    title: string,
    items: readonly (SelectItem & { help?: string })[],
    selectedValue?: string,
  ): Promise<string | undefined>;
  selectModelMenu(
    ctx: ExtensionContext,
    items: readonly { value: string; label: string; searchText?: string }[],
    selectedValue?: string,
  ): Promise<string | undefined>;
  readConfig: typeof import("./config.ts").readConfig;
  readEffectiveConfig: typeof import("./config.ts").readEffectiveConfig;
  readProjectOverrides: typeof import("./config.ts").readProjectOverrides;
  updateProjectOverride: typeof import("./config.ts").updateProjectOverride;
  contextAgentDefinitions(ctx: ExtensionContext): Promise<{
    definitions: AgentDefinition[];
    roleDefinitions: AgentDefinition[];
    projectTrusted: boolean;
  }>;
  discoverRoleDefinition(
    name: RoleDefinitionName,
    options?: {
      projectRoot?: string;
    },
  ): AgentDefinition;
  setLeadExecutionMode(
    ctx: ExtensionCommandContext,
    mode: LeadExecutionMode,
  ): Promise<void>;
  leadExecutionPresentation(): { managed: boolean; mode: LeadExecutionMode };
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

type LeadProjectHost = {
  currentManager(ctx: ExtensionContext): Promise<ManagerDescriptor | undefined>;
  managerLease(): ManagerLease | undefined;
  sameManagerDescriptor(
    left: ManagerDescriptor,
    right: ManagerDescriptor,
  ): boolean;
  worktreeGroupScope: typeof import("./herdr.ts").worktreeGroupScope;
  reconcileProjectAssignments(
    ctx: ExtensionContext,
    repoKey: string,
    primaryWorkspaceId: string,
    sourceCheckoutPath: string,
    alreadyLocked?: boolean,
    onlyBranch?: string,
  ): Promise<void>;
  findProjectAssignmentBySession: typeof import("./supervision.ts").findProjectAssignmentBySession;
  supervisionRuntime: typeof import("./supervision.ts").supervisionRuntime;
  readProjectAssignment: typeof import("./supervision.ts").readProjectAssignment;
  currentProjectAssignment(
    ctx: ExtensionContext,
  ): Promise<ProjectAssignment | undefined>;
  writeProjectAssignment: typeof import("./supervision.ts").writeProjectAssignment;
  liveLead(ctx: ExtensionContext, sessionId: string): Promise<HerdrRecord[]>;
  runHerdr: typeof import("./herdr.ts").runHerdr;
  listProjectAssignments: typeof import("./supervision.ts").listProjectAssignments;
  herdrSessionSnapshot: typeof import("./herdr.ts").herdrSessionSnapshot;
  herdrSessionId: typeof import("./herdr.ts").herdrSessionId;
  isPiAgent(agent: HerdrRecord): boolean;
  scanAgentStates: typeof import("./mailbox.ts").scanAgentStates;
  readLeadCoordinationState: typeof import("./supervision.ts").readLeadCoordinationState;
  requireCompatibleBuild: typeof import("./compatibility.ts").requireCompatibleBuild;
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
  ): Promise<import("./agent-controller.ts").StopOwnedAgentsResult>;
  stopProjectLeadPane(
    ctx: ExtensionContext,
    target: HerdrRecord,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  withProjectWorkLock: LeadRoleTransitionRuntime["withProjectWorkLock"];
  leadCoordinationTools: readonly string[];
  pi: ExtensionAPI;
  SessionManager: Pick<
    typeof import("@earendil-works/pi-coding-agent").SessionManager,
    "open" | "listAll"
  >;
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
  listProjectMessageHeaders: typeof import("./supervision.ts").listProjectMessageHeaders;
  readProjectMessage: typeof import("./supervision.ts").readProjectMessage;
  removeProjectMessage: typeof import("./supervision.ts").removeProjectMessage;
  readProjectAssignment: typeof import("./supervision.ts").readProjectAssignment;
  importResultBindings: typeof import("./agent-controller.ts").importResultBindings;
  worktreeGroupScope: typeof import("./herdr.ts").worktreeGroupScope;
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
  currentWorktreeScope: LeadRoleTransitionRuntime["currentWorktreeScope"];
  projectAssignmentForScope: LeadRoleTransitionRuntime["projectAssignmentForScope"];
  resolveEffectiveSupervisor: LeadRoleTransitionRuntime["resolveEffectiveSupervisor"];
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
): LeadExecutionSessionState | undefined {
  const entry = [...entries]
    .reverse()
    .find(
      (candidate: any) =>
        candidate?.type === "custom" &&
        candidate.customType === "pi-herdsman-lead-execution",
    ) as any;
  if (!entry) return undefined;
  const data = entry.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length !== 2 ||
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
  return { mode: data.mode, leadTools: [...data.leadTools] };
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
  isRoot(): boolean;
  herdRun: Pick<LeadHerdRunRuntime, "shutdown">;
}) {
  const isRoot = () => host.isRoot();
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
  sessionLeadRoleState(
    entries: readonly any[],
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
        host.herdRun.restoreSession(ctx.sessionManager.getEntries(), sessionId);
        let persistedRole: SessionRole = "lead";
        let hasPersistedRole = false;
        try {
          const persisted = host.sessionLeadRoleState(
            ctx.sessionManager.getEntries(),
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
          }
        }
      }
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
      const supervisorStateMessage = host.isActiveLead()
        ? await host.prepareLeadSupervisorStateMessage(ctx)
        : undefined;
      if (supervisorStateMessage) host.sendMessage(supervisorStateMessage);
      const roster = host.definitionRoster();
      const prompt = host.isActiveLead() ? host.executionPrompt() : undefined;
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
            label: "Lead agents tab",
            description: current.effective === "tab" ? "current" : undefined,
            help: "Place Lead-direct Agents in one lead-owned agents tab.",
          },
          {
            value: "subtree",
            label: "Subtree tabs",
            description:
              current.effective === "subtree" ? "current" : undefined,
            help: "Give each Lead-direct Agent its own tab. Nested delegation still splits in its owner's current tab.",
          },
          {
            value: "split",
            label: "Split from caller",
            description: current.effective === "split" ? "current" : undefined,
            help: "Split Lead-direct Agents from the caller's pane. Nested delegation still splits in its owner's current tab.",
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
              label: "Inline attachments",
              description: host.formatMessageLimit(limits.inline.bytes),
              help: "Per-file limit for embedding complete strict UTF-8 file contents. Larger or ineligible files remain references.",
            },
            {
              value: "mailboxPayloadLimitBytes",
              label: "Mailbox payload",
              description: host.formatMessageLimit(limits.mailbox.bytes),
              help: "Limit new managed-Agent request and ask payloads and new Manager project assignments.",
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
          {
            value: "custom",
            label: "Custom…",
            help: "Enter a custom limit in KiB, from 1 through 1024.",
          },
          {
            value: "reset",
            label: "Reset",
            help: "Remove the configured override and use the default.",
          },
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
      let selectedSection = "agents";
      const selectedDefinitions: Record<string, string | undefined> = {};
      const loadDefinitions = async () => {
        const { definitions, roleDefinitions } =
          await host.contextAgentDefinitions(ctx);
        return {
          definitions,
          roleDefinitions: RESERVED_ROLE_DEFINITION_NAMES.map((name) => {
            const definition = roleDefinitions.find(
              (candidate) => candidate.name === name,
            );
            if (!definition)
              throw new Error(`role definition ${name} not found`);
            return definition;
          }),
        };
      };
      const resolveDefinition = async (name: string) => {
        const loaded = await loadDefinitions();
        return [...loaded.roleDefinitions, ...loaded.definitions].find(
          (candidate) => candidate.name === name,
        );
      };
      while (true) {
        const section = await host.selectMenu(
          ctx,
          "Definitions",
          [
            {
              value: "agents",
              label: "Agent definitions",
              help: "Definitions available for Agent delegation.",
            },
            {
              value: "roles",
              label: "Role profiles",
              help: "Reserved Lead, Manager, and Chief definitions.",
            },
          ],
          selectedSection,
        );
        if (section !== "agents" && section !== "roles") return;
        selectedSection = section;
        const sectionDefinitions =
          section === "agents" ? "definitions" : "roleDefinitions";
        definitionList: while (true) {
          const loaded = await loadDefinitions();
          const availableDefinitions = loaded[sectionDefinitions];
          if (!availableDefinitions.length) {
            ctx.ui.notify("No Agent definitions are available.");
            break definitionList;
          }
          const options = availableDefinitions.map((definition) => {
            const { model, thinking } = this.executionSettings(ctx, definition);
            const sources = [
              definition.extensionSource ? "bundled" : undefined,
              definition.projectSource ? "project" : undefined,
              definition.overrideSource ? "global" : undefined,
            ]
              .filter(Boolean)
              .join(" + ");
            const reservedLead = isReservedRoleDefinition(definition.name);
            const runtimeProfile = isRuntimeRoleDefinition(definition.name);
            const description = [
              ...(!runtimeProfile ? [model, thinking] : []),
              sources,
              ...(!reservedLead && !host.agentDefinitionEnabled(definition)
                ? ["disabled"]
                : []),
            ]
              .filter(Boolean)
              .join(" · ");
            return {
              value: definition.name,
              label: definition.name,
              description,
              ...(typeof definition.frontmatter.description === "string"
                ? { help: definition.frontmatter.description }
                : {}),
            };
          });
          const selected = await host.selectMenu(
            ctx,
            section === "agents" ? "Agent definitions" : "Role profiles",
            options,
            selectedDefinitions[section],
          );
          if (selected === undefined) break definitionList;
          if (!selected) continue;
          const selectedEntry = availableDefinitions.find(
            (definition) => definition.name === selected,
          );
          if (!selectedEntry) continue;
          selectedDefinitions[section] = selectedEntry.name;
          let definition = selectedEntry;
          const selectedName = definition.name;
          let selectedAction = "model";
          while (true) {
            const { model, thinking } = this.executionSettings(ctx, definition);
            const managedDefinition =
              definition.name === MANAGED_LEAD_DEFINITION_NAME;
            const runtimeProfile = isRuntimeRoleDefinition(definition.name);
            const action = await host.selectMenu(
              ctx,
              definition.name,
              [
                ...(!runtimeProfile
                  ? [
                      {
                        value: "model",
                        label: "Model",
                        description: model,
                        help: managedDefinition
                          ? "Model for future managed Lead launches. Changes do not affect a running Lead."
                          : "Model for future Agent generations. When unset, fresh delegation inherits the spawning controller and continuation restores the saved session model.",
                      },
                    ]
                  : []),
                ...(!runtimeProfile
                  ? [
                      {
                        value: "thinking",
                        label: "Thinking",
                        description: thinking,
                        help: managedDefinition
                          ? "Thinking level for future managed Lead launches. Changes do not affect a running Lead."
                          : "Thinking level for future Agent generations. When unset, fresh delegation inherits the spawning controller and continuation restores the saved session level.",
                      },
                    ]
                  : []),
                ...(!isReservedRoleDefinition(definition.name)
                  ? [
                      {
                        value: "enabled",
                        label: "Enabled",
                        description: host.agentDefinitionEnabled(definition)
                          ? "on"
                          : "off",
                        help: "Control whether this Agent definition is available for new assignments. Running Agents are unchanged.",
                      },
                    ]
                  : []),
                {
                  value: "details",
                  label: "Details…",
                  help: "Show effective definition metadata and expanded instructions.",
                },
              ],
              selectedAction,
            );
            if (!action) break;
            selectedAction = action;
            if (action === "details") {
              let current;
              try {
                current = await resolveDefinition(selectedName);
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
              } else {
                ctx.ui.notify(
                  host.formatAgentDefinitions([metadata]).join("\n"),
                );
              }
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
            const verified = await resolveDefinition(definition.name);
            if (!verified)
              throw new Error(
                `definition ${definition.name} is no longer available`,
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
          "No running Agents. Ask Pi to delegate using an available definition.",
        );
        return;
      }
      const options = host.renderRunningOptions(rows);
      if (ctx.mode !== "tui" && new Set(options).size !== options.length) {
        ctx.ui.notify("Running list is ambiguous; reopen Running.", "warning");
        return;
      }
      const selected = await host.selectMenu(
        ctx,
        "Running",
        options.map((label, index) => ({
          value: String(index),
          label,
          help: rows[index]?.task
            ? `Task: ${rows[index]!.task}`
            : "Focus this managed Agent.",
        })),
      );
      if (selected === undefined) return;
      const selectedIndex = Number(selected);
      const selectedRow =
        !Number.isInteger(selectedIndex) ||
        selectedIndex < 0 ||
        selectedIndex >= rows.length
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
    async showSessionStats(ctx: ExtensionCommandContext): Promise<void> {
      const managerActive = host.roleActive("manager");
      const stats = host.collectOwnedSessionUsage(ctx);
      ctx.ui.notify(
        host.formatSessionUsage(
          stats.current,
          stats.agents,
          stats.agentSessions,
          stats.complete,
          stats.breakdown,
          managerActive
            ? {
                usage: stats.leads,
                sessions: stats.leadSessions,
              }
            : undefined,
        ),
      );
    },
    async confirmAndStopAll(ctx: ExtensionCommandContext): Promise<void> {
      const snapshot = await host.loadStatusSnapshot(
        ctx,
        host.controller.sessionSignal(),
      );
      if (!snapshot.agents.length) {
        const release = claimDelegationLock(
          host.controller.workspaceId(),
          ctx.sessionManager.getSessionId(),
        );
        try {
          const fresh = await host.controller.agentSnapshotView(
            ctx,
            { kind: "lead" },
            host.controller.sessionSignal(),
          );
          if (fresh.stateIssues.length)
            throw new Error(
              "Owned Agent mailbox state is unresolved; stop not verified",
            );
          if (fresh.visible.length) {
            ctx.ui.notify("Agent state changed; reopen Stop all.", "warning");
            return;
          }
          host.presentStopSummary("No owned agents running.");
        } finally {
          release();
        }
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Stop all agents?",
        `${host.formatStatusCounts(snapshot.agents)}\n\nActive work or pending results may be discarded.`,
      );
      if (!confirmed) return;
      ctx.abort();
      const sessionId = ctx.sessionManager.getSessionId();
      const workspaceId = host.controller.workspaceId();
      const release = claimDelegationLock(workspaceId, sessionId);
      try {
        const result = await host.controller.stopOwnedAgentsForSession(
          ctx,
          sessionId,
          workspaceId,
          host.controller.sessionSignal(),
        );
        host.presentStopSummary(result.summary);
      } finally {
        release();
      }
      if (activeLeadRole(options.leadRuntime) === "lead")
        host.maybeFinishHerdRun(ctx);
    },
    async openExecutionMenu(ctx: ExtensionCommandContext): Promise<void> {
      const execution = host.leadExecutionPresentation();
      if (execution.managed) {
        await host.selectMenu(ctx, "Managed orchestration", [
          {
            value: "managed",
            label: "managed-lead",
            help: "This assigned session uses the managed-lead execution profile.",
          },
        ]);
        return;
      }
      const mode = await host.selectMenu(
        ctx,
        "Execution",
        [
          {
            value: "flexible",
            label: "Flexible",
            description: execution.mode === "flexible" ? "current" : undefined,
          },
          {
            value: "orchestrate",
            label: "Orchestrate",
            description:
              execution.mode === "orchestrate" ? "current" : undefined,
          },
        ],
        execution.mode,
      );
      if (mode === "flexible" || mode === "orchestrate") {
        try {
          await host.setLeadExecutionMode(ctx, mode);
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
        }
      }
    },
    async openSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSetting = "auto-activate-manager";
      const loadProjectState = () => {
        if (!ctx.isProjectTrusted())
          return { trusted: false as const, overrides: {} };
        try {
          return {
            trusted: true as const,
            overrides: host.readProjectOverrides(ctx),
          };
        } catch (error) {
          return {
            trusted: true as const,
            error: String(error),
            overrides: {},
          };
        }
      };
      while (true) {
        const config = host.readConfig();
        const project = loadProjectState();
        const projectDescription = (
          key: "autoActivateManager" | "contextRetirement",
        ) =>
          !project.trusted
            ? `Effective ${config[key] ? "on" : "off"} (global; untrusted project)`
            : "error" in project
              ? "Project value unavailable"
              : `Effective ${(Object.hasOwn(project.overrides, key) ? project.overrides[key] : config[key]) ? "on" : "off"}${Object.hasOwn(project.overrides, key) ? " (project)" : " (global)"}`;
        const selected = await host.selectMenu(
          ctx,
          "Settings",
          [
            {
              value: "default-lead-execution",
              label: "Default Lead execution",
              description:
                config.defaultLeadExecution === "flexible"
                  ? "Flexible"
                  : "Orchestrate",
              help: "Used when a future ordinary Lead session has no persisted execution choice.",
            },
            {
              value: "auto-activate-manager",
              label: "Manager auto-start",
              description: `Global ${config.autoActivateManager ? "on" : "off"} · ${projectDescription("autoActivateManager")}`,
              help: "Attempt Manager mode automatically on eligible future session starts. Changing this does not alter the current role.",
            },
            {
              value: "context-retirement",
              label: "Context retirement",
              description: `Global ${config.contextRetirement ? "on" : "off"} · ${projectDescription("contextRetirement")}`,
              help: "Retire managed-Agent sessions at automatic context pressure instead of allowing normal threshold compaction.",
            },
            {
              value: "message-limits",
              label: "Message limits",
              help: "Configure inline attachment and managed mailbox payload byte limits.",
            },
            {
              value: "project-overrides",
              label: "Project overrides…",
              help: "Choose project-specific values for Manager auto-start and context retirement.",
            },
          ],
          selectedSetting,
        );
        if (!selected) return;
        selectedSetting = selected;
        if (selected === "project-overrides") {
          if (!ctx.isProjectTrusted()) {
            ctx.ui.notify(
              "Project overrides are unavailable because this project is not trusted.",
              "warning",
            );
            continue;
          }
          if ("error" in project) {
            ctx.ui.notify(project.error.replace(/^Error: /, ""), "error");
            continue;
          }
          await this.openProjectOverridesMenu(ctx);
        } else if (selected === "message-limits")
          await this.openMessageLimitsMenu(ctx);
        else if (selected === "default-lead-execution") {
          const mode = await host.selectMenu(
            ctx,
            "Default Lead execution",
            [
              { value: "flexible", label: "Flexible" },
              { value: "orchestrate", label: "Orchestrate" },
            ],
            config.defaultLeadExecution,
          );
          if (mode) host.updateConfig("defaultLeadExecution", mode);
        } else if (
          selected === "context-retirement" ||
          selected === "auto-activate-manager"
        ) {
          const key =
            selected === "context-retirement"
              ? "contextRetirement"
              : "autoActivateManager";
          const enabled = !host.readConfig()[key];
          host.updateConfig(key, enabled);
          ctx.ui.notify(
            `Global ${key === "contextRetirement" ? "context retirement" : "Manager auto-start"}: ${enabled ? "on" : "off"}`,
          );
        }
      }
    },
    async openProjectOverridesMenu(
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      while (true) {
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify(
            "Project overrides are unavailable because this project is not trusted.",
            "warning",
          );
          return;
        }
        let overrides;
        try {
          overrides = host.readProjectOverrides(ctx);
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
          return;
        }
        const field = await host.selectMenu(ctx, "Project overrides", [
          {
            value: "autoActivateManager",
            label: "Manager auto-start",
            help: "Attempt Manager mode automatically on eligible future session starts.",
          },
          {
            value: "contextRetirement",
            label: "Context retirement",
            help: "Retire managed-Agent sessions at automatic context pressure.",
          },
        ]);
        if (!field) return;
        const key = field as "autoActivateManager" | "contextRetirement";
        const global = host.readConfig()[key];
        const choice = await host.selectMenu(
          ctx,
          key === "autoActivateManager"
            ? "Manager auto-start"
            : "Context retirement",
          [
            {
              value: "inherit",
              label: `Inherit global (${global ? "on" : "off"})`,
              help: "Remove this project's explicit value and use the current global default.",
            },
            {
              value: "on",
              label: "On for this project",
              help: "Enable this preference in this trusted project.",
            },
            {
              value: "off",
              label: "Off for this project",
              help: "Disable this preference in this trusted project.",
            },
          ],
          Object.hasOwn(overrides, key)
            ? overrides[key]
              ? "on"
              : "off"
            : "inherit",
        );
        if (!choice) continue;
        try {
          host.updateProjectOverride(
            ctx,
            key,
            choice === "inherit" ? undefined : choice === "on",
          );
          ctx.ui.notify(
            `${key === "autoActivateManager" ? "Manager auto-start" : "Context retirement"} ${choice === "inherit" ? "inherited" : `set ${choice} for this project`}.`,
          );
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
        }
      }
    },
    async openAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "running";
      while (true) {
        const snapshot = await host.loadStatusSnapshot(
          ctx,
          host.controller.sessionSignal(),
        );
        const running = host.formatStatusCounts(snapshot.agents) || "0";
        const placement = await host.placementSettings(ctx);
        const selected = await host.selectMenu(
          ctx,
          "Agents",
          [
            {
              value: "running",
              label: "Running",
              description: running,
              help: "Focus a live managed Agent.",
            },
            {
              value: "layout",
              label: "Layout",
              description: placement.effective,
              help: "Choose where newly delegated Lead-direct Agents are placed in Herdr.",
            },
            {
              value: "stop-all",
              label: "Stop all…",
              help: "Emergency stop for the owned Agent tree. Active work or pending results may be discarded.",
            },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "running") await this.openRunningAgentsMenu(ctx);
        else if (selected === "layout") await this.openPlacementMenu(ctx);
        else if (selected === "stop-all") await this.confirmAndStopAll(ctx);
      }
    },
    async openHerdsmanMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "execution";
      while (true) {
        const execution = host.leadExecutionPresentation();
        const selected = await host.selectMenu(
          ctx,
          `Pi Herdsman · v${host.version}`,
          [
            {
              value: "execution",
              label: "Execution",
              description: execution.managed
                ? "Managed"
                : execution.mode === "flexible"
                  ? "Flexible"
                  : "Orchestrate",
              help: execution.managed
                ? "This assigned session uses managed-lead. Use /takeover to release Manager authority."
                : "Choose this ordinary Lead session's execution profile.",
            },
            {
              value: "agents",
              label: "Agents",
              help: "Manage running Agents, layout, and the owned Agent tree.",
            },
            {
              value: "manager",
              label: "Project manager",
              description: host.roleActive("manager") ? "active" : undefined,
              help: "Coordinate durable project work across dedicated Lead sessions.",
            },
            {
              value: "stats",
              label: "Session stats",
              help: "Show Pi-native token usage and cost for this session and managed work.",
            },
            {
              value: "definitions",
              label: "Definitions",
              help: "Inspect effective Agent and role definitions and edit global overrides.",
            },
            {
              value: "settings",
              label: "Settings",
              help: "Configure future-session and user-wide Herdsman behavior.",
            },
            {
              value: "advanced",
              label: "Advanced…",
              description: host.roleActive("chief")
                ? "Chief active"
                : undefined,
              help: "Open advanced Herdsman coordination controls.",
            },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "execution") await this.openExecutionMenu(ctx);
        else if (selected === "agents") await this.openAgentsMenu(ctx);
        else if (selected === "manager")
          await this.openRoleMenu("manager", ctx);
        else if (selected === "stats") await this.showSessionStats(ctx);
        else if (selected === "definitions")
          await this.openDefinitionsMenu(ctx);
        else if (selected === "settings") await this.openSettingsMenu(ctx);
        else if (selected === "advanced") await this.openAdvancedMenu(ctx);
      }
    },
    async openAdvancedMenu(ctx: ExtensionCommandContext): Promise<void> {
      const selected = await host.selectMenu(ctx, "Advanced", [
        {
          value: "chief",
          label: "Chief mode",
          description: host.roleActive("chief") ? "active" : undefined,
          help: "Supervise Managers and unassigned Leads across Herdsman.",
        },
      ]);
      if (selected === "chief") await this.openRoleMenu("chief", ctx);
    },
    async openRoleMenu(
      role: "manager" | "chief",
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const active = host.roleActive(role);
      const name = role === "manager" ? "Manager" : "Chief";
      const title = role === "manager" ? "Project manager" : "Chief mode";
      const selected = await host.selectMenu(
        ctx,
        title,
        active
          ? [
              { value: "overview", label: "Overview" },
              { value: "leave", label: `Leave ${name} mode` },
            ]
          : [{ value: "start", label: `Start ${name} mode` }],
      );
      if (selected === "overview" || selected === "start")
        await this.runRoleCommand(role, "", ctx);
      else if (selected === "leave")
        await this.runRoleCommand(role, "leave", ctx);
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
          ctx.ui.notify(await host.transitionRole(role, false, ctx));
          await host.openSupervisionOverview(ctx);
          return;
        }
        ctx.ui.notify(
          await host.transitionRole(role, args[0] === "leave", ctx),
        );
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
        if (!args.length && host.roleActive(role))
          await host.openSupervisionOverview(ctx);
      }
    },
    async runHerdsmanCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      if (!ctx.hasUI) return;
      const usage =
        "Usage: /herdsman [stats | definitions | placement [tab|subtree|split] | stop]";
      const placementUsage = "Usage: /herdsman placement [tab|subtree|split]";
      const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/u) : [];
      try {
        if (!args.length) return void (await this.openHerdsmanMenu(ctx));
        if (args[0] === "stats" && args.length === 1)
          return void (await this.showSessionStats(ctx));
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
    async runLeadExecutionCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
      if (
        args.length > 1 ||
        (args[0] && args[0] !== "flexible" && args[0] !== "orchestrate")
      ) {
        ctx.ui.notify("Usage: /lead [flexible|orchestrate]", "error");
        return;
      }
      if (!args.length) return void (await this.openExecutionMenu(ctx));
      try {
        await host.setLeadExecutionMode(ctx, args[0]);
        ctx.ui.notify(`Lead execution: ${args[0]}`);
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
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
  let leadExecution:
    | {
        mode: LeadExecutionMode;
        definition: AgentDefinition;
        valid: true;
        managed: boolean;
      }
    | { mode: LeadExecutionMode; valid: false; managed: boolean }
    | undefined;
  let leadExecutionPending = false;
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
    if (role === "lead") return "all";
    if (role === "manager" || role === "chief") {
      const profile = currentSupervisoryProfile(
        options.leadRuntime!.leadContext!,
        role,
      );
      if (profile?.valid)
        return new Set(profile.definition.frontmatter.agents ?? []);
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
      mode,
      leadTools: [...tools],
    });
  };
  const captureInheritedTools = (): void => {
    const projection = inheritedProjection;
    if (!projection) return;

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
  const publishLeadRole = (
    ctx: ExtensionContext,
    _mode: "inactive" | "active" | "suspended",
    generation: number,
  ): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionGeneration = leadRuntime.sessionGeneration;
    const failureKey = `${sessionId}:${sessionGeneration}:${generation}`;
    leadMetadataQueue = leadMetadataQueue
      .catch(() => {})
      .then(async () => {
        if (
          generation !== leadRuntime.chiefModeGeneration ||
          sessionGeneration !== leadRuntime.sessionGeneration ||
          sessionId !== ctx.sessionManager.getSessionId()
        )
          return;
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
        reportedRoleMetadataFailure = undefined;
      })
      .catch((error) => {
        if (
          sessionGeneration !== leadRuntime.sessionGeneration ||
          sessionId !== ctx.sessionManager.getSessionId()
        )
          return;
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
      revision === tabRenameRevision &&
      sessionGeneration === leadRuntime.sessionGeneration &&
      sessionId === ctx.sessionManager.getSessionId();
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
            label = (await currentProjectAssignment(ctx))
              ? "Managed Lead"
              : "Lead";
          } catch (error) {
            // A verified assignment is required to claim Managed Lead.
            options.sessionStartOptions.appendRoleError(ctx, error);
            label = "Lead";
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
        ownedTab = { tabId: tab.tab_id, label };
        reportedTabRenameFailure = undefined;
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
    leadMetadataQueue = leadMetadataQueue
      .catch(() => {})
      .then(() => {
        if (
          sessionGeneration !== leadRuntime.sessionGeneration ||
          sessionId !== ctx.sessionManager.getSessionId() ||
          leadRuntime.controllerRole !== "lead" ||
          leadRuntime.roleSuspended
        )
          return;
        return roleHost.reportLeadMetadata(pi, ctx, metadata).then(() => {
          reportedRoleMetadataFailure = undefined;
        });
      })
      .catch((error) => {
        if (
          sessionGeneration !== leadRuntime.sessionGeneration ||
          sessionId !== ctx.sessionManager.getSessionId()
        )
          return;
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
    pi.appendEntry("pi-herdsman-role", { role, leadTools: [...tools] });
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
    if (leadExecutionPending) return leadToolState.normalizeLeadTools([]);
    if (!leadExecution) return leadToolState.normalizeLeadTools(baseline);
    if (leadExecution.managed)
      return leadToolState.appendRegisteredTools(
        leadToolState.normalizeLeadTools(baseline),
        ["read_evidence"],
      );
    if (!leadExecution.valid) return leadToolState.normalizeLeadTools([]);
    return leadToolState.projectLeadTools(baseline, leadExecution.definition);
  };
  const activationGuard = (
    _sessionId: string,
    _role: "Chief" | "Manager",
  ): void => {
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
    releaseProjectAssignment: (
      ...args: Parameters<typeof roleHost.releaseProjectAssignment>
    ) => {
      const released = roleHost.releaseProjectAssignment(...args);
      supervisionUiRuntime.requestRefresh();
      return released;
    },
    controllerScope: { kind: "root" },
    activationGuard,
    advancePeerPresenceGeneration: () =>
      coordinationRuntime.advancePresenceGeneration(),
    setCoordinationHealthy: (healthy: boolean) =>
      coordinationRuntime.setCoordinationHealthy(healthy),
    normalizeBaseTools: leadToolState.normalizeBaseTools,
    captureInheritedTools,
    inheritedProjection: () =>
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
    currentPeerPresenceValid: (ctx: ExtensionContext) =>
      coordinationRuntime.currentPeerPresenceValid(ctx),
    drainProjectMessages: (ctx: ExtensionContext) =>
      coordinationRuntime
        .drainRetirementNotices(ctx)
        .then(
          async (count) =>
            count + (await coordinationRuntime.drainProjectMessages(ctx)),
        ),
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
    projectEvidence: async (ctx) => {
      if (
        activeLeadRole(options.leadRuntime) !== "lead" ||
        !leadExecution?.managed
      )
        return undefined;
      const assignment = await currentProjectAssignment(ctx);
      if (!assignment) return undefined;
      const migrated = migrateProjectAssignmentEvidence(
        options.coordinationHost.supervisionRuntime(),
        assignment.repoKey,
        assignment.branch,
        assignment.id,
      );
      if (!migrated || migrated.id !== assignment.id) return undefined;
      return {
        assignment: migrated,
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
            ctx.signal,
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
    const snapshot = buildAgentStatusSnapshot(view, ctx, {
      ...options.statusSnapshotHost,
      scope: { kind: "root" },
      activeRootRoleForPresentation,
      listedAgentRecord: controller.listedAgentRecord,
      runtimeForLabel,
      herdStartedAt: () => herdRunRuntime?.startedAt(),
    });
    const execution =
      isLead && assignmentVerified
        ? assignment
          ? { kind: "managed" as const }
          : leadExecution?.valid
            ? { kind: "ordinary" as const, mode: leadExecution.mode }
            : undefined
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
    isManagedLead: () => !!leadExecution?.managed,
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
  const currentProjectAssignment = async (
    ctx: ExtensionContext,
  ): Promise<ProjectAssignment | undefined> => {
    const scope = await roleTransitions.currentWorktreeScope(ctx);
    if (!scope && leadExecution?.managed)
      throw new Error("Cannot verify the current project assignment");
    return scope
      ? roleTransitions.projectAssignmentForScope(
          scope,
          ctx.sessionManager.getSessionId(),
        )
      : undefined;
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
        managed: false,
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
        managed: false,
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
      saved = sessionLeadExecutionState(ctx.sessionManager.getBranch());
    } catch (error) {
      if (signal.aborted) return;
      leadToolState.setLeadTools(currentBaseline());
      leadExecution = {
        mode: options.commandHost.readConfig().defaultLeadExecution,
        valid: false,
        managed: !!assignment,
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
    if (!saved) persistLeadExecution(mode, baseline);
    if (assignment) {
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
        managed: false,
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
      if (assignment) {
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
        managed: false,
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
    const assignment = await currentProjectAssignment(ctx);
    if (assignment)
      throw new Error(
        "Managed Leads use managed-lead; use /takeover to release Manager authority.",
      );
    if (leadExecution?.managed) await restoreLeadExecution(ctx);
    await ctx.waitForIdle();
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
  const takeover = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    const assignment = await currentProjectAssignment(ctx);
    if (!assignment) return roleTransitions.takeover(ctx);
    const definition = resolveExecutionDefinition(ctx, "orchestrate");
    const baseline =
      leadToolState.getLeadTools() ??
      leadToolState.normalizeBaseTools(pi.getActiveTools());
    const targetTools = leadToolState.projectLeadTools(baseline, definition);
    if (!(await roleTransitions.takeover(ctx))) return false;
    publishLeadRole(ctx, "inactive", leadRuntime.chiefModeGeneration);
    try {
      persistLeadExecution("orchestrate", baseline);
      leadToolState.setLeadTools(baseline);
      leadExecution = {
        mode: "orchestrate",
        definition,
        valid: true,
        managed: false,
      };
      pi.setActiveTools(targetTools);
    } catch (error) {
      leadExecution = { mode: "orchestrate", valid: false, managed: false };
      try {
        pi.setActiveTools(leadToolState.normalizeLeadTools([]));
      } catch {
        // Preserve the original transition failure.
      }
      try {
        options.sessionStartOptions.appendDefinitionError(ctx, error);
      } catch {
        // Preserve the original transition failure.
      }
      throw error;
    }
    return true;
  };
  const reconcileBranchExecution = async (ctx: ExtensionContext) => {
    inheritedProjection = undefined;
    let saved: LeadExecutionSessionState | undefined;
    try {
      saved = sessionLeadExecutionState(ctx.sessionManager.getBranch());
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
    discoverSessionDefinitions: (ctx: ExtensionContext) =>
      options.commandHost.contextAgentDefinitions(ctx),
    clearLeadExecution: () => {
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
  pi.on("agent_settled", (event: { aborted: boolean }, ctx: ExtensionContext) =>
    agentEvents.agentSettled(ctx, event.aborted),
  );
  pi.on("tool_call", (event: any, ctx: ExtensionContext) =>
    agentEvents.toolCall(event, ctx),
  );
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    inheritedProjection = undefined;
    return sessionStart.sessionStart(ctx);
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
    takeover,
    leadExecutionPresentation: () =>
      leadExecution?.managed
        ? { managed: true, mode: leadExecution.mode }
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
      if (
        group.repoKey !== manager.repoKey ||
        group.primaryWorkspaceId !== manager.workspaceId
      )
        throw new Error("Manager workspace is not the assigned project");
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
        topology?.source?.source_workspace_id !== group.primaryWorkspaceId ||
        !Array.isArray(topology?.worktrees)
      )
        throw new Error("Herdr worktree topology is not authoritative");
      if (typeof topology.source.source_checkout_path === "string")
        await host.reconcileProjectAssignments?.(
          ctx,
          group.repoKey,
          group.primaryWorkspaceId,
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
    const snapshot = host.projectSupervision({
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
    });
    return { ...snapshot, ...(diagnostics ? { diagnostics } : {}) };
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
      const assignments = host.listProjectAssignments(
        host.supervisionRuntime(),
        manager.repoKey,
      );
      const sessions = new Set(assignments.map((assignment) => assignment.id));
      if (sessions.size !== assignments.length)
        throw new Error("Multiple project assignments match a Lead session");
      return snapshot.leads
        .filter((lead) => scope.workspaceIds.includes(lead.workspaceId))
        .map((lead) => ({
          ...lead,
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
      const effectiveManager = await host.currentManager(ctx, scope);
      if (
        !effectiveManager ||
        !host.sameManagerDescriptor(effectiveManager, descriptor)
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
            ? item.lead.lead === leadId
            : item.work.status === "active" && item.lead?.lead === leadId,
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
      if (!parent || children?.length !== 1)
        throw new Error("Lead changed; reopen staff.");
      lead = { lead: leadId };
    } else {
      const matches = host
        .presentationReports(fresh)
        .filter((candidate: any) => candidate.lead === leadId);
      if (matches.length !== 1) throw new Error("Lead changed; reopen staff.");
      lead = matches[0];
    }
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
                          description:
                            entry.lead.relationship === "supervised"
                              ? `${entry.lead.runtimeState} · supervised`
                              : entry.lead.runtimeState,
                        },
                  )
                : leads.map((lead) => ({
                    value: lead.lead,
                    label: lead.displayName,
                    description: `${lead.runtimeState}${lead.agentCounts.total ? ` · ${lead.agentCounts.total} agent${lead.agentCounts.total === 1 ? "" : "s"}` : ""}`,
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
              if (item.value.startsWith("work:")) {
                const branch = item.value.slice("work:".length);
                const entry = work.find(
                  (candidate) => candidate.branch === branch,
                );
                if (!entry) return;
                const liveLead = host
                  .managerSupervisionItems(snapshot)
                  .some(
                    (candidate) =>
                      candidate.kind === "work" &&
                      candidate.work.branch === branch &&
                      !!candidate.lead,
                  );
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
                  `${lead.lead}:${lead.runtimeState}:${lead.agentCounts.total}`,
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
                if (!lead) return;
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
        ...(host.activeRole() === "manager"
          ? [{ value: "required-evidence", label: "Required evidence" }]
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
        } else if (action === "required-evidence") {
          const assignment = await uiActions.inspectRequiredEvidence(
            selection.branch,
            ctx,
          );
          const entries = assignment.requiredEvidence ?? [];
          if (!entries.length) {
            ctx.ui.notify("This project has no required evidence.", "info");
          } else {
            const selectedEvidence = await uiActions.selectMenu(
              ctx,
              `Required evidence · ${selection.branch}`,
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

export function createLeadProjectRuntime(host: LeadProjectHost) {
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
    } finally {
      release();
    }
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
    if (assignments.length !== 1)
      throw new Error("Lead is not an exact current project assignment");
    const assignment = assignments[0];
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
    if (
      group.repoKey !== manager.repoKey ||
      group.primaryWorkspaceId !== manager.workspaceId
    )
      throw new Error("Manager worktree group is not authoritative");
    const topology = await host.runHerdr(
      host.pi,
      ctx,
      ["worktree", "list", "--workspace", manager.workspaceId],
      { signal },
    );
    if (
      topology?.source?.source_workspace_id !== manager.workspaceId ||
      topology?.source?.repo_key !== manager.repoKey ||
      typeof topology?.source?.source_checkout_path !== "string" ||
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
    const matches = topology.worktrees.filter(
      (worktree: any) => worktree?.branch === branch,
    );
    if (matches.length !== 1)
      throw new Error("Branch does not identify exactly one Herdr worktree");
    const worktree = matches[0];
    if (
      typeof worktree.path !== "string" ||
      !worktree.path ||
      worktree.is_linked_worktree !== true
    )
      throw new Error("Herdr worktree checkout path is unavailable");
    const checkoutPath = resolve(worktree.path);
    if (checkoutPath === resolve(topology.source.source_checkout_path))
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
          resolve(session.getCwd()) !== checkoutPath
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
        realpathSync(String(gitRoot.stdout ?? "").trim()) !==
          realpathSync(checkoutPath) ||
        realpathSync(String(gitCommonDir.stdout ?? "").trim()) !==
          realpathSync(manager.repoKey) ||
        !gitWorktrees ||
        gitWorktrees.filter(
          (entry) =>
            resolve(entry.path) === checkoutPath && entry.branch === branch,
        ).length !== 1
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
  const removeWorktree = async (
    branch: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    if (activeRole() !== "manager")
      throw new Error("Only Managers can remove project worktrees");
    if (!ctx.hasUI)
      throw new Error("Worktree removal requires interactive confirmation");
    const operationSignal = signal ?? ctx.signal;
    operationSignal?.throwIfAborted();
    const candidate = await inspectRemovalTarget(branch, ctx, operationSignal);
    await assertNoUnrelatedPiExecution(candidate, ctx, operationSignal);
    const answer = await ctx.ui.input(
      [
        "Remove worktree",
        "",
        `Branch: ${branch}`,
        `Checkout: ${candidate.checkoutPath}`,
        "",
        "Removes this checkout and Herdr workspace.",
        "Running managed execution may be stopped.",
        "Preserves the Git branch and Pi conversation.",
        "Retires the assignment after verified removal.",
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
                current.checkoutPath !== candidate.checkoutPath ||
                !host.sameManagerDescriptor(current.manager, candidate.manager)
              )
                throw new Error(
                  "Removal target changed during confirmation; worktree preserved",
                );
              await assertNoUnrelatedPiExecution(current, ctx, operationSignal);
              if (current.liveLead) {
                try {
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
                    "--branch",
                    branch,
                    "--no-focus",
                  ],
                  { signal: operationSignal },
                );
                workspaceId = opened?.workspace?.workspace_id;
                if (
                  !workspaceId ||
                  workspaceId === current.manager.workspaceId ||
                  opened?.worktree?.branch !== branch ||
                  resolve(opened?.worktree?.path ?? "") !== current.checkoutPath
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
                final.checkoutPath !== current.checkoutPath
              )
                throw new Error(
                  "Removal target changed before native removal; worktree preserved",
                );
              try {
                operationSignal?.throwIfAborted();
                return {
                  result: await host.runHerdr(
                    host.pi,
                    ctx,
                    ["worktree", "remove", "--workspace", workspaceId],
                    { signal: operationSignal },
                  ),
                };
              } catch (error) {
                return {
                  error: error instanceof Error ? error.message : String(error),
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
        return {
          content: [
            {
              type: "text" as const,
              text: checkoutRemoved
                ? assignmentRetired
                  ? `${leadStopped ? "Assigned Lead stopped; " : ""}removed checkout for ${branch}; assignment retired. Git branch and Pi conversation preserved.`
                  : `${leadStopped ? "Assigned Lead stopped; " : ""}checkout removed for ${branch}; assignment retirement is unconfirmed${retirementError ? `: ${retirementError}` : "."}`
                : checkoutState === "present"
                  ? `${leadStopped ? "Assigned Lead stopped; " : ""}worktree removal was not confirmed for ${branch}; checkout remains and assignment ${assignmentRetired ? "was retired" : "was not retired"}${"error" in removed ? `: ${removed.error}` : "."}`
                  : `${leadStopped ? "Assigned Lead stopped; " : ""}worktree removal result is unknown for ${branch}; assignment ${assignmentRetired ? "was retired" : "retirement is unconfirmed"}${"error" in removed ? `: ${removed.error}` : "."}`,
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
          },
        };
      },
    );
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
    withProjectAssignmentLock,
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
    | { action: "stop"; session: string }
    | { action: "inspect" | "transcript"; session: string }
    | {
        action: "message";
        session: string;
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
  const activateProjectLeadLocked = async (
    operation: ProjectLeadActivation,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    const operationName =
      operation.action === "resume" ? "resume_project" : "delegate_project";
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
    if (existing && existing.repoKey !== manager.repoKey)
      throw new Error("Project assignment belongs to another repository");
    if (operation.action === "delegate" && existing)
      throw new Error(
        `Work already exists on ${branch}; resume it with resume_project.`,
      );
    if (operation.action === "resume" && !existing)
      throw new Error(
        `No existing work was found on ${branch}; start it with delegate_project and a task.`,
      );
    const presentationTask =
      operation.action === "resume"
        ? projectTaskSummary(existing!.text)
        : undefined;
    const id = operation.action === "resume" ? existing!.id : operation.id;
    const branchWorktrees = topology.worktrees.filter(
      (worktree: any) => worktree?.branch === branch,
    );
    if (operation.action === "resume" && branchWorktrees.length === 0)
      throw new Error(
        "Worktree availability could not be verified; the existing assignment was preserved. Retry when repository access is available.",
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
      await bindLeadSessionFile(existing!, live[0]);
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
    if (operation.action === "resume") assignment = existing!;
    else {
      const limits = await messageLimits(ctx);
      const suppliedFiles = resolveMessageFiles(
        ctx,
        operation.files,
        "delegate_project",
      );
      const projectBrief = persistRequiredEvidenceSnapshot(
        id,
        "project-brief.md",
        operation.task,
      );
      const attachedEvidence: RequiredEvidence[] = [
        ...persistRequiredTextFiles(
          id,
          suppliedFiles.filter(
            (file): file is string => typeof file === "string",
          ),
          ctx.cwd,
          "delegate_project",
        ),
        ...suppliedFiles.flatMap((file) =>
          typeof file === "string"
            ? []
            : [{ id: randomUUID(), name: file.ref, result: file }],
        ),
      ];
      const requiredEvidence = [projectBrief, ...attachedEvidence];
      const prepared = prepareMessageInput(
        operation.task,
        attachedEvidence.flatMap((evidence) =>
          "path" in evidence ? [evidence.path] : [evidence.result],
        ),
        ctx.cwd,
        "delegate_project",
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
        ...(requiredEvidence.length ? { requiredEvidence } : {}),
        ...(prepared.resultBindings.length
          ? { resultBindings: prepared.resultBindings }
          : {}),
      };
    }
    const promptPaths: string[] = [];
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
        if (operation.action === "resume")
          throw new Error("The existing project checkout is unavailable");
        const args = [
          "worktree",
          "create",
          "--workspace",
          primaryWorkspaceId,
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
          realpathSync(String(common.stdout).trim()) !==
            realpathSync(manager.repoKey) ||
          String(branchResult.stdout ?? "").trim() !== assignment.branch
        )
          throw new Error(
            "Herdr checkout does not match the assigned repository and branch",
          );
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
                `Work already exists on ${assignment.branch}; resume it with resume_project.`,
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
          const projectTrusted = ctx.isProjectTrusted();
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
    if (params.action === "delegate" || params.action === "resume") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can control project work");
      return activateProjectLead(params, ctx, signal);
    }
    if (params.action === "remove") {
      if (activeRole() !== "manager")
        throw new Error("Only Managers can remove project worktrees");
      if (!ctx.hasUI)
        throw new Error("Worktree removal requires interactive confirmation");
      const operationSignal = signal ?? ctx.signal;
      operationSignal?.throwIfAborted();
      const target = await inspectRemovalTarget(
        params.branch,
        ctx,
        operationSignal,
      );
      await assertNoUnrelatedPiExecution(target, ctx, operationSignal);
      return {
        content: [
          {
            type: "text" as const,
            text: `No worktree was removed. To confirm removal of ${params.branch}, use /manager remove ${params.branch} or /manager → Project → Remove worktree….`,
          },
        ],
        details: {
          ok: false,
          action: "remove",
          branch: params.branch,
          confirmation_required: true,
        },
      };
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
          ...(activeRole() === "manager"
            ? { relationship: report.relationship ?? "assigned" }
            : {}),
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
          available_tools: report.availableActions.map(staffToolName),
        })),
      });
    }
    const lead = reports.find(
      (candidate: any) => reportSession(candidate) === params.session,
    );
    if (!lead)
      throw new Error(
        "Lead target was not found or is no longer eligible. Retry with session set to the exact full Pi session ID shown as session in a fresh automatic supervision snapshot or returned by list_staff; never use display_name.",
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
      const currentAuthority =
        activeRole() === "chief"
          ? await currentChiefAuthority(ctx)
          : await currentManager(ctx);
      const currentLead = (await directReports(ctx)).find(
        (candidate: any) => reportSession(candidate) === params.session,
      );
      if (
        !currentAuthority ||
        currentAuthority.leaseId !== authority.leaseId ||
        !currentLead ||
        !sameLeadIdentity(currentLead, lead) ||
        !currentLead.availableActions.includes("inspect")
      )
        throw new Error("Lead changed during inspection");
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
    if (params.retain === true) {
      if (activeRole() !== "manager" || !initialAssignment)
        throw new Error(
          "Required evidence can be retained only by a Manager forwarding to an assigned project Lead",
        );
      const supplied = resolveMessageFiles(
        ctx,
        params.files,
        `staff.${params.action}`,
      );
      await updateAssignmentEvidence(
        _id,
        {
          branch: initialAssignment.branch,
          add: params.files,
          resolvedAdd: supplied,
          text: params.message,
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
      const prepared = await prepareCoordinationInput(
        ctx,
        params.message,
        params.retain === true
          ? retainedFiles.flatMap((file) =>
              "result" in file ? [file.result] : [file.path],
            )
          : resolveMessageFiles(ctx, params.files, `staff.${params.action}`),
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
      const writeLead = (await directReports(ctx)).find(
        (candidate: any) => reportSession(candidate) === params.session,
      );
      const writeAssignment = writeLead
        ? assignmentMatches(writeLead)
        : undefined;
      if (
        !writeChief ||
        writeChief.leaseId !== finalChief.leaseId ||
        !writeLead ||
        !sameLeadTarget(writeLead, currentLead) ||
        !writeLead.availableActions.includes(params.action)
      )
        throw new Error("Lead or Chief changed before the message was queued");
      if (
        (writeLead.relationship === "assigned") !== !!writeAssignment ||
        writeAssignment?.branch !== initialAssignment?.branch
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
        ...(initialAssignment ? { branch: initialAssignment.branch } : {}),
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
      throw new Error("Only the Manager can update project required evidence");
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
    if (
      scope.repoKey !== manager.repoKey ||
      scope.primaryWorkspaceId !== manager.workspaceId
    )
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
    const additions: RequiredEvidence[] = [];
    const resolved =
      params.resolvedAdd ??
      host.resolveMessageFiles(ctx, params.add, operation);
    additions.push(
      ...persistRequiredTextFiles(
        assignment.id,
        resolved.filter((file): file is string => typeof file === "string"),
        ctx.cwd,
        operation,
      ),
      ...resolved.flatMap((file) =>
        typeof file === "string"
          ? []
          : [{ id: randomUUID(), name: file.ref, result: file }],
      ),
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
        if (
          currentScope.repoKey !== assignment.repoKey ||
          currentScope.primaryWorkspaceId !== currentManager.workspaceId
        )
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
        const written = {
          ...current,
          ...(next.length
            ? { requiredEvidence: next }
            : { requiredEvidence: undefined }),
          ...(resultBindings.length ? { resultBindings } : {}),
        };
        host.writeProjectAssignment(runtime, written);
        return written;
      },
      ctx.signal,
    );
    onPersisted?.(suppliedAdditions);
    return {
      content: [
        {
          type: "text" as const,
          text: `Required evidence updated. Current assignment evidence:\n${(updated.requiredEvidence ?? []).map((entry) => `- ${entry.id}: ${entry.name}`).join("\n") || "- none"}`,
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
      throw new Error("Only the Manager can inspect project requirements");
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
      throw new Error("Only the Manager can remove project requirements");
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
  return {
    stopExecution,
    stop,
    activateProjectLead,
    removeWorktree,
    executeStaff,
    updateAssignmentEvidence,
    inspectRequiredEvidence,
    removeRequiredEvidence,
  };
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
    workspaceId,
    currentWorktreeScope,
    projectAssignmentForScope,
    resolveEffectiveSupervisor,
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
    listProjectMessageHeaders,
    readProjectMessage,
    removeProjectMessage,
    readProjectAssignment,
    importResultBindings,
  } = host;
  const reportedProjectMessageCleanupErrors = new Set<string>();
  const reportedProjectMessageReadErrors = new Set<string>();
  const reportedRetirementErrors = new Set<string>();
  const retirementCursors = new Map<string, string>();
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
        version: 2,
        build: HERDSMAN_BUILD,
        role: activeRole() === "manager" ? "manager" : "lead",
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
      import("./supervision.ts").GlobalProjectAssignment[]
    >,
    requireFreshGroup = false,
  ): Promise<import("./supervision.ts").PeerContext | undefined> => {
    const role = record.role ?? "lead";
    if (role === "manager") return { role: "manager" };
    const socket = record.socket;
    const assignments =
      (assignmentSnapshot ?? globalProjectAssignmentSnapshot()).get(
        record.piSessionId,
      ) ?? [];
    if (assignments.length > 1) return undefined;
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
    if (
      !target ||
      (target.role ?? "lead") !== activeRole() ||
      target.piSessionId !== record.toSessionId
    )
      return false;
    const source = record.peerSource;
    const assignmentSnapshot =
      source?.role === "lead" ? globalProjectAssignmentSnapshot() : undefined;
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
    const record: ChiefMessageRecord = {
      version: 2,
      build: HERDSMAN_BUILD,
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
        import("./supervision.ts").GlobalProjectAssignment[]
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
      if (
        !currentSender ||
        !currentTarget ||
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
    signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    if (controllerScope.kind !== "root" || leadRuntime.chiefMode !== "inactive")
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
        const publishSignal =
          signal && ctx.signal
            ? AbortSignal.any([signal, ctx.signal])
            : (signal ?? ctx.signal);
        const published = await publishProjectMessage(
          ctx,
          assignment,
          params.message,
          resolveMessageFiles(ctx, params.files, "message_supervisor"),
          undefined,
          undefined,
          undefined,
          publishSignal,
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
      const chief = await currentSupervisor(ctx);
      if (!chief) throw new Error("No active supervisor is available");
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
      if (!ownContext)
        throw new Error(
          "Peer eligibility could not be verified; retry list_peers.",
        );
      const peers = [];
      for (const record of listPeerLeadRecords(peerRuntime())) {
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
        peers.push({
          session: record.piSessionId,
          name: record.name ?? `lead-${record.piSessionId.slice(0, 8)}`,
          cwd: record.cwd ?? "",
          repo: record.repo ?? "",
          branch: record.branch ?? "",
          workspace_label: record.workspaceLabel ?? "",
        });
      }
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
        id: recordId,
        leaseId: sender.claim.id,
        kind: "peer_message",
        fromSessionId: sender.piSessionId,
        toSessionId: target.piSessionId,
        leadSessionId: sender.piSessionId,
        peerSource: submissionSource,
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
    const runtime = supervisionRuntime();
    const manager = await currentManager(ctx);
    if (
      !manager ||
      !leadRuntime.managerLease ||
      !sameManagerDescriptor(manager, leadRuntime.managerLease.descriptor)
    )
      return 0;
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
    for (const assignment of listProjectAssignments(runtime, manager.repoKey)) {
      let pending: ProjectMessageHeader[];
      try {
        pending = listProjectMessageHeaders(
          runtime,
          manager.repoKey,
          assignment.branch,
        );
      } catch (error) {
        appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
        return 0;
      }
      for (const record of pending) {
        if (record.fromSessionId !== assignment.id) continue;
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
            content: `Project ${message.branch} from lead ${message.fromSessionId}:\n\n${message.text}`,
            display: true,
            details: {
              id: message.id,
              repoKey: message.repoKey,
              branch: message.branch,
              fromSessionId: message.fromSessionId,
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
    authorizePeerRecord,
    peerContext,
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

If the Manager needs coordination, a question, clarification, warning, or FYI
before the normal result boundary, use message_supervisor. If it can wait, let
the automatic result handoff carry it.
Undelivered project handoffs survive Manager absence. Once delivered, they
are not automatically replayed to later Managers. Settlement is nonterminal; do not infer project closure from runtime state.`;
}

export function createLeadInboxRuntime(host: LeadInboxHost) {
  let chiefInboxTimer: ReturnType<typeof setTimeout> | undefined;
  let chiefInboxGeneration = 0;
  let chiefInboxAbortController: AbortController | undefined;
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
      .getEntries()
      .some(
        (entry: any) =>
          entry?.customType === `pi-herdsman-${record.kind}` &&
          entry?.details?.id === record.id &&
          entry?.details?.leaseId === record.leaseId &&
          entry?.details?.fromSessionId === record.fromSessionId &&
          entry?.details?.leadSessionId === record.leadSessionId &&
          entry?.details?.branch === record.branch,
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
      if (leads.length !== 1) return false;
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
      const supervisor = await host.resolveEffectiveSupervisor(
        ctx,
        record.fromSessionId,
        leads[0].workspace_id,
        scope,
      );
      return (
        scope.workspaceIds.includes(leads[0].workspace_id) &&
        supervisor.kind === "manager" &&
        supervisor.manager.piSessionId === manager.piSessionId &&
        supervisor.manager.leaseId === manager.leaseId &&
        scope.primaryWorkspaceId === manager.workspaceId &&
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
      const supervisor = await host.resolveEffectiveSupervisor(
        ctx,
        sessionId,
        workspaceId,
      );
      const state = readLeadCoordinationState(supervisionRuntime(), sessionId);
      return (
        !!chief &&
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
    const workspaceId = host.workspaceId();
    if (!workspaceId) throw new Error("Project scope cannot be verified");
    const supervisor = await host.resolveEffectiveSupervisor(
      ctx,
      sessionId,
      workspaceId,
    );
    const manager =
      supervisor.kind === "assigned"
        ? await currentManager(ctx, supervisor.scope)
        : supervisor.kind === "manager"
          ? supervisor.manager
          : undefined;
    if (
      supervisor.kind === "assigned"
        ? supervisor.assignment.branch !== record.branch
        : record.branch !== undefined || supervisor.kind !== "manager"
    )
      return false;
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
    if (!manager)
      throw new Error("Manager authority is temporarily unavailable");
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
                  !canMessagePeer(source, recipientContext)
                )
                  throw new Error("Peer eligibility changed before delivery");
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
                    !canMessagePeer(source, recipientContext)
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
      currentSubmittedAt?.clear();
      settledSubmissions.clear();
      chiefInboxAbortController?.abort();
      chiefInboxAbortController = new AbortController();
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
    worktreeGroupScope: (
      workspaceId: string,
      signal: AbortSignal,
    ) => Promise<{ primaryWorkspaceId: string; repoKey: string }>;
    claimManagerLease: typeof import("./supervision.ts").claimManagerLease;
    coordinationHealthy(): boolean;
    verifyManagerIdentity(
      descriptor: import("./supervision.ts").ManagerDescriptor,
    ): Promise<unknown>;
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
  if (optional)
    deps.activationGuard(ctx.sessionManager.getSessionId(), "Manager");
  let scope;
  try {
    scope = await deps.worktreeGroupScope(workspaceId, ctx.signal);
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
  if (!deps.isCurrent()) return;
  if (scope.primaryWorkspaceId !== workspaceId) {
    if (!optional) deps.persistLeadRole();
    return;
  }
  try {
    const lease = deps.claimManagerLease({
      build: deps.build,
      piSessionId: ctx.sessionManager.getSessionId(),
      piSessionFile: ctx.sessionManager.getSessionFile(),
      paneId,
      tabId,
      workspaceId,
      repoKey: scope.repoKey,
    });
    if (optional) {
      let verified: unknown;
      try {
        verified = await deps.verifyManagerIdentity(lease.descriptor);
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

function gitPathStatus(path: string): "present" | "absent" | "unknown" {
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
    scope:
      Pick<WorktreeGroupScope, "repoKey" | "primaryWorkspaceId"> | undefined,
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
    scope?: Pick<WorktreeGroupScope, "repoKey" | "primaryWorkspaceId"> | null,
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
  const resolveEffectiveSupervisor = async (
    ctx: ExtensionContext,
    sessionId: string,
    workspaceId: string,
    verifiedScope?: WorktreeGroupScope,
  ) => {
    let scope = verifiedScope;
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
    const scope = await currentWorktreeScope(ctx);
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
    takeover = false,
  ): boolean => {
    const runtime = host.supervisionRuntime();
    if (
      !(takeover
        ? host.releaseProjectAssignment(runtime, assignment)
        : host.retireProjectAssignment(runtime, assignment))
    )
      return false;
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
      if (
        scope.repoKey !== repoKey ||
        scope.primaryWorkspaceId !== primaryWorkspaceId
      )
        return undefined;
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
        realpathSync(commonDir) !== realpathSync(repoKey) ||
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
    const knownCheckoutPath = (
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
    const checkoutMaySurvive = (
      assignment: ProjectAssignment,
      inventory: NonNullable<typeof initialInventory>,
    ): boolean => {
      const cwd = knownCheckoutPath(assignment);
      if (cwd)
        return inventory.some(
          (worktree) =>
            resolve(worktree.path) === cwd &&
            gitPathStatus(worktree.path) !== "absent",
        );
      // Without checkout provenance, any linked checkout could be the assigned one.
      return inventory.some(
        (worktree) =>
          resolve(worktree.path) !== resolve(sourceCheckoutPath) &&
          gitPathStatus(worktree.path) !== "absent",
      );
    };
    for (const observed of assignments) {
      if (onlyBranch && observed.branch !== onlyBranch) continue;
      if (checkoutMaySurvive(observed, initialInventory)) continue;
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
          if (checkoutMaySurvive(current, inventory)) return;
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
      topology?.source?.source_workspace_id !== manager.workspaceId ||
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
  const takeover = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    if (
      activeLeadRole(state) !== "lead" ||
      state.chiefMode === "active" ||
      state.roleSuspended
    )
      throw new Error("Takeover is available only in Lead mode.");
    if (!ctx.hasUI) throw new Error("Takeover requires an interactive UI.");
    const scope = await currentWorktreeScope(ctx);
    if (!scope) throw new Error("Current project scope is unavailable");
    const sessionId = ctx.sessionManager.getSessionId();
    const assignment = projectAssignmentForScope(scope, sessionId);
    if (!assignment) {
      ctx.ui.notify("This Lead is not managed.", "info");
      return false;
    }
    if (
      !(await ctx.ui.confirm(
        "Take over this managed Lead?",
        "Manager control and automatic project-result forwarding will stop.\nThe Pi session, conversation, branch, worktree, and owned Agents will remain.",
      ))
    )
      return false;
    await withProjectWorkLock(
      `${assignment.repoKey}\0${assignment.branch}`,
      () =>
        withProjectAssignmentLock(
          assignment.repoKey,
          assignment.branch,
          async () => {
            const currentScope = await currentWorktreeScope(ctx);
            const current =
              currentScope && currentScope.repoKey === assignment.repoKey
                ? projectAssignmentForScope(currentScope, sessionId)
                : undefined;
            if (
              !current ||
              current.branch !== assignment.branch ||
              !removeProjectAssignmentState(assignment, ctx, true)
            )
              throw new Error("Project assignment changed during takeover");
          },
          ctx.signal,
        ),
    );
    ctx.ui.notify(
      "Lead taken over. Manager control and automatic project-result forwarding ended.",
      "info",
    );
    return true;
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
    const scope = await host.worktreeGroupScope(ctx, workspaceId);
    if (scope.primaryWorkspaceId !== workspaceId)
      throw new Error("/manager is available only in the primary workspace");
    const profile = host.prepareSupervisoryProfile(ctx, "manager");
    host.captureInheritedTools?.();
    const previousTools =
      host.getLeadTools() ?? host.normalizeLeadTools(host.pi.getActiveTools());
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
      branchRole = host.sessionLeadRoleState(ctx.sessionManager.getBranch());
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
          worktreeGroupScope: (workspaceId, signal) =>
            host.worktreeGroupScope(ctx, workspaceId, signal),
          claimManagerLease: host.claimManagerLease,
          coordinationHealthy: host.coordinationHealthy,
          verifyManagerIdentity: (descriptor) =>
            host.remoteChiefAgent(ctx, descriptor),
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
    takeover,
    retireRemovedProjectWork,
    reconcileProjectAssignments,
    clearLeadContext: () => {
      state.leadContext = undefined;
    },
  };
}
