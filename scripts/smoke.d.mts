type OpenRecord = Record<string, unknown>;
type Awaitable<T> = T | Promise<T>;
type Env = Record<string, string | undefined>;
type CommandOptions = { cwd?: string; env?: Env; timeout?: number };
type WaitObservation = {
  done: boolean;
  value?: OpenRecord;
  observationError?: string;
};
type WaitOptions = { timeoutMs: number; stallMs: number; pollMs?: number };
type Scenario =
  | "core"
  | "continuation"
  | "chief-tree"
  | "supervisor-agent"
  | "manager-bootstrap"
  | "manager-recovery"
  | "active-stop"
  | "terminal-failure"
  | "agent-terminal-failure"
  | "manager-handoff"
  | "manager-merge"
  | "agent-crash-recovery"
  | "deep-chain";
type Command = (
  file: string,
  args: string[],
  options?: OpenRecord,
) => Promise<OpenRecord>;
type ProcessRecord = {
  paneId: unknown;
  pid: unknown;
  parentPid?: unknown;
  processName?: "pi" | "node" | "other";
  processMatch: boolean;
  processMatchSource?: "argv" | "process-title" | "cmdline" | null;
  error: string | null;
  stage?: string;
  argvPresent?: boolean;
  argvLength?: number | null;
  candidateExtensionArgMatch?: boolean;
  integrationExtensionArgMatch?: boolean;
  cmdlinePresent?: boolean;
};
type SanitizedProcessRecord = {
  paneId: string | null;
  pid: number | null;
  parentPid: number | null;
  processName: string | null;
  processMatch: boolean;
  processMatchSource: string | null;
  error: string | null;
};
type ManagerHandoffProgress = {
  fauxSupervisorToolAvailability: string;
  expectedBranchWorktree: string;
  successfulCorrelatedDelegateProjectResult: string;
  assignmentIdentitySessionWorkspaceBranchMatch: string;
  matchedLead: string;
  candidateProcessCount: number | "not_observed";
  candidateProcessProvenanceMatch: string;
  supervisorCallObserved: boolean;
  supervisorResultState: string;
  supervisorErrorCategory: string;
  supervisorUnstructuredErrorClass?: string;
  supervisorHandlerBranchStatus: string;
  supervisorPersistedErrorCategoryPresent: boolean;
  supervisorPersistedErrorCategory: string;
  readinessDeliveryObserved: boolean;
  errorCategory: string;
  worktreeIdentityState: string;
};
type CoreDelegationEdge = {
  delegation: string;
  session: string;
  terminalResult: string;
  terminalStatus: string;
  resultDelivered: string;
};
type CoreDelegation = {
  rootToImplementer: CoreDelegationEdge;
  implementerToScout: CoreDelegationEdge;
  rootCompletionMarker: boolean | null;
  firstUnverifiedBoundary: string;
};
type CoreMailbox = {
  candidates: number;
  stateMatches: boolean;
  requestMatches: boolean;
  resultMatches: boolean;
  requestId: string | null;
  runId: string | null;
  ownerSessionId: string | null;
  workspaceId: string | null;
  agentLabel: string | null;
  paneId: string | null;
  status: string;
  errorCode: string | null;
};
type CoreIdentity = {
  sessionId: string | null;
  sessionPath: string | null;
  requestId: string | null;
  mailbox: CoreMailbox;
};
type CoreHandoff = {
  intermediate: CoreIdentity;
  scout: CoreIdentity;
  scoutReference: {
    ref: string | null;
    canonicalRef: string | null;
    receiptCount: number;
    receiptIndex: number | null;
    receiptMatches: boolean;
    referenceMatches: boolean;
    artifact: {
      path: string | null;
      exists: boolean;
      readableUtf8: boolean;
      bytes: number | null;
      error: string;
    };
    valid: boolean;
  };
  attachHandoff: {
    callCount: number;
    calls: {
      index: number | null;
      callId: string | null;
      files: (string | null)[];
      resultCount: number;
      results: {
        index: number | null;
        toolCallId: string | null;
        isError: boolean;
        text: string;
        details: {
          assignmentRequestId: string | null;
          runId: string | null;
          ownerSessionId: string | null;
          workspaceId: string | null;
          agentLabel: string | null;
          paneId: string | null;
          piSessionId: string | null;
          errorCategory: string | null;
          resultBindings: { ref: string | null; canonicalRef: string | null }[];
        };
      }[];
    }[];
    selectionMatches: boolean;
  };
  ownerImport: {
    receiptCount: number;
    status: "completed" | "failed" | "unknown";
    forwardableRefs: (string | null)[];
    importedBindings: { ref: string | null; canonicalRef: string | null }[];
    successfullyImported: boolean;
  };
  nextAgent: CoreIdentity & {
    callCount: number;
    callId: string | null;
    files: (string | null)[];
    correlatedResultCount: number;
    assignmentMatches: boolean;
    artifact: {
      ref: string | null;
      canonicalRef: string | null;
      attachmentCount: number;
      received: boolean;
      attachedPackage: { name: string | null; version: string | null };
      provenanceMatches: boolean;
      readback: { name: string | null; version: string | null };
      responseMatchesArtifact: boolean;
    };
  };
};

export function worktreePiCommand(args: string[]): string[];
export function parseSmokeArgs(args: string[]): {
  scenario: Scenario;
  model: string | undefined;
  simulated: boolean;
  managerReadyTimeoutMs: number | undefined;
  managerRecoveryDiagnostics: boolean;
  managerExternalRemoval: boolean;
  managerRemovalAcceptance: boolean;
};
export function managerDiagnosticLines(contents: unknown): string[];
export function captureManagerLeadDiagnostics(
  ctx: OpenRecord,
  paneId: string,
  readPane?: (
    ctx: OpenRecord,
    paneId: string,
    mode: "recent-unwrapped",
  ) => Promise<unknown>,
): Promise<void>;
export function formatSmokeFailure(error: unknown, stage?: string): string;
export function classifyOldExecution(
  snapshot: unknown,
  target: { paneId: string; sessionId: string; sessionPath: string },
  inspect: (paneId: string) => string | Promise<string>,
): Promise<"quiescent" | "active" | "unknown">;
export function latestPostRestartListAgentsResult(
  entries: OpenRecord[],
): OpenRecord | undefined;
export function matchesProjectMessageContent(
  actual: unknown,
  expected: string,
): boolean;
export function managerBootstrapDelegationProjection(progress?: OpenRecord): {
  delegateCalls: number;
  expectedBranchDelegateCalls: number;
  resultState: "absent" | "error" | "success";
  correlatedChild: boolean;
  childSessionSaved: boolean;
  linkedWorktreeObserved: boolean;
};
export function managerBootstrapDelegationState(
  contents: string,
  branch: unknown,
): {
  delegateCalls: number;
  expectedBranchDelegateCalls: number;
  resultState: "success" | "absent";
};
export function waitForEvidence<T>(
  ctx: OpenRecord,
  stage: string,
  inspect: () => T | Promise<T>,
  options: { timeoutMs: number; stallMs: number; pollMs?: number },
): Promise<T>;
export function resolveSmokeModel(
  override: string | undefined,
  execute?: Command,
): Promise<string>;
export function selectSmokeModel(
  args: { simulated: boolean; scenario: string; model?: string },
  execute?: Command,
): Promise<string>;
export function isolatedEnv(
  base: Record<string, string | undefined>,
  paths: OpenRecord,
): Record<string, string | undefined>;
export function nestedControlEnv(
  base: Record<string, string | undefined>,
  paths: OpenRecord,
  sessionName: string,
): Record<string, string | undefined>;
export function parentControlEnv(
  base: Record<string, string | undefined>,
  paths: OpenRecord,
  sessionName: string,
): Record<string, string | undefined>;
export function rootCandidateCommand(args: string[]): string[];
export function nestedHerdrApiSocketPath(
  paths: OpenRecord,
  sessionName: string,
): string;
export function candidateArgs(config: {
  candidateExtension: string;
  herdrStateExtension: string;
  model: string;
  simulatedProviderExtension?: string;
  chiefTreeProbeExtension?: string;
}): string[];
export function chiefTreeProbeSource(resultPath: string): string;
export function parseToolSnapshots(
  contents: string,
): Map<"lead" | "chief" | "tree" | "lead-after", string[]>;
export function distinctPaneCount(
  processes: { paneId: unknown; [key: string]: unknown }[],
): number;
export function chiefTreeBranchPlan(
  contents: string,
  startupPrompt: string,
  startupMarker: string,
  chiefPrompt: string,
  chiefMarker: string,
):
  | { targetId: unknown; error?: undefined }
  | { targetId?: undefined; error: string };
export function chiefTreeFooter(
  output: string,
): { selected: number; total: number } | null;
export function chiefTreeSelectedRow(output: string, marker: string): boolean;
export function countChiefTreeEvents(
  contents: string,
  baseline?: number,
): number;
export function chiefTreeBranchTransition(
  text: string,
  snapshots: { has(key: string): unknown } | null | undefined,
  treeEventsBefore: unknown,
  treeEvents: number,
): {
  done: boolean;
  value:
    | { state: "summary-dialog"; treeEventsBefore: unknown; treeEvents: number }
    | { state: "tree-loaded"; treeEvents: number }
    | undefined;
  progress: OpenRecord;
};
export function staffDelegateResults(contents: string): unknown[];
export function assertNoFailedProjectDelegation(
  contents: string,
  branch: unknown,
): void;
export function assertNoFailedManagerHandoff(progress: {
  supervisorResultState?: unknown;
  [key: string]: unknown;
}): void;
export function managerAssignmentDiagnostics(input: OpenRecord): {
  expectedBranchWorktree: unknown;
  successfulCorrelatedDelegateProjectResult: unknown;
  assignmentIdentitySessionWorkspaceBranchMatch: unknown;
  matchedLead: unknown;
  messageSupervisorCall: unknown;
  messageSupervisorSuccess: unknown;
  messageSupervisorResult: unknown;
  exactManagerReadinessDelivery: unknown;
  fauxSupervisorToolAvailability: "not_offered" | "not_observed";
  supervisorCallObserved: unknown;
  supervisorResultState: unknown;
  supervisorErrorCategory: unknown;
  supervisorUnstructuredErrorClass?: string;
  supervisorHandlerBranchStatus: "operation_error_returned" | "not_observed";
  supervisorPersistedErrorCategoryPresent: boolean;
  supervisorPersistedErrorCategory: unknown;
  readinessDeliveryObserved: unknown;
  candidateProcessCount: unknown;
  candidateProcessProvenanceMatch: unknown;
  errorCategory: unknown;
  worktreeIdentityState: unknown;
};
export function managerHandoffSupervisorToolAvailability(
  contents: unknown,
): "not_offered" | "not_observed";
export function supervisorAgentCompletionMatches(
  message: unknown,
  requestId: unknown,
  childSessionId: unknown,
): boolean;
export function supervisorMessageDiagnostics(
  path: string,
  expectedSessionId: unknown,
  text: string,
): OpenRecord;
export function managerAssignmentIdentity(
  row: unknown,
  worktree: unknown,
  branch: unknown,
): "not_observed" | "true" | "false";
export function managerAssignmentBranchMismatch(
  row: unknown,
  branch: unknown,
): boolean;
export function staffActionResults(
  contents: string,
  toolName: unknown,
  action: unknown,
  prompt?: string,
): unknown[];
export function projectMessageEntries(
  contents: string,
  branch: unknown,
  sessionId: unknown,
): unknown[];
export function retirementNoticeEntries(
  contents: string,
  repoKey: unknown,
  branch: unknown,
  assignmentId: unknown,
): unknown[];
export function assertPassiveRetirementEvidence(
  before: string,
  after: string,
  repoKey: unknown,
  branch: unknown,
  assignmentId: unknown,
): unknown;
export function retainedProjectMessageRecord(
  records: OpenRecord[],
  branch: unknown,
  sessionId: unknown,
  text: unknown,
): OpenRecord | null;
export function managerHandoffRetainedRecord(
  records: OpenRecord[],
  repoKey: unknown,
  branch: unknown,
  sessionId: unknown,
  text: unknown,
): OpenRecord | null;
export function managerHandoffDeliveredEntry(
  contents: string,
  repoKey: unknown,
  branch: unknown,
  sessionId: unknown,
  messageId: unknown,
  text: unknown,
): unknown | null;
export function managerCleanupTarget(
  worktrees: OpenRecord[],
  branch: unknown,
  worktreePath: unknown,
  workspaceId: unknown,
  retirementRequested?: boolean,
): OpenRecord | null;
export function removeManagerRecoveryWorktree(
  ctx: OpenRecord,
  worktrees: OpenRecord[],
  execute?: (
    file: string,
    args: string[],
    options: { cwd: string },
  ) => Awaitable<{ stdout: string }>,
  control?: (ctx: unknown, args: string[]) => Awaitable<unknown>,
): Promise<unknown>;
export function captureTerminalFailureWorktree(
  ctx: OpenRecord,
  worktrees: OpenRecord[],
  branch: unknown,
): OpenRecord | null;
export function captureManagerHandoffWorktree(
  ctx: OpenRecord,
  worktrees: OpenRecord[],
  branch: unknown,
  expectedWorkspaceId?: unknown,
): OpenRecord | null;
export function captureTerminalFailureAssignment(
  ctx: OpenRecord,
  path: unknown,
  workspaceId: unknown,
): void;
export function terminalFailureAssignmentPoll(
  ctx: OpenRecord,
  branch: string,
  root: () => Promise<{ contents: string } | null>,
  agents: () => Promise<OpenRecord[]>,
  execute?: (ctx: OpenRecord, args: string[]) => Promise<OpenRecord>,
  getAgentSessionId?: (ctx: OpenRecord, agent: OpenRecord) => Promise<unknown>,
): Promise<{
  done: boolean;
  value: OpenRecord;
  progress: { delegationCount: number };
  evidence: unknown;
}>;
export function prepareManagerRepository(
  paths: OpenRecord,
  execute?: (
    file: string,
    args: string[],
    options?: { cwd?: string },
  ) => Awaitable<unknown>,
): Promise<string>;
export function assertManagerFreshPrimary(
  workspaceId: unknown,
  primaryCheckoutPath: string,
  workspace: unknown,
  topology: unknown,
): string;
export function deleteBranchIfPresent(
  branch: string,
  execute?: Command,
  cwd?: string,
): Promise<boolean>;
export function hasSuccessfulSupervisorMessage(
  contents: string,
  text: string,
): boolean;
export function supervisorMessageCallStatus(
  contents: string,
  text: string,
): "not_called" | "error" | "success" | "pending";
export function leadReadyCompleted(contents: string, text: string): boolean;
export function verifiedLeadSession(
  childSession: unknown,
  expectedSession: unknown,
): boolean;
export function managerReadyAnswer(
  contents: string,
  branch: unknown,
  leadSessionId: unknown,
): {
  receipt: boolean;
  answer: unknown | null;
  answerAfterReceipt: unknown | null;
  prematureReady: boolean;
  prematureFinish: boolean;
};
export function managerReadyEntryEvidence(
  contents: string,
  branch: unknown,
  leadSessionId: unknown,
): OpenRecord[];
export function isPackageReadPath(path: string, cwd: unknown): boolean;
export function managerProjectMessageSettled(
  contents: string,
  branch: unknown,
  fromSessionId: unknown,
  marker: string,
): boolean;
export function savedSessionHeaderEvidence(
  contents: string,
  expectedSessionId: unknown,
): {
  expectedSessionId: unknown;
  actualSessionId: string | null;
  sessionHeaderFound: boolean;
  sessionIdMatches: boolean;
};
export function continuationSessionEvidence(
  contents: string,
  expectedSessionId: unknown,
  task: unknown,
): {
  sessionHeaderFound: boolean;
  sessionIdMatches: boolean;
  continuationTaskFound: boolean;
  taskInstructionFound: boolean;
};
export function correlatedContinuationTask(
  contents: string,
  resultId: unknown,
  expectedSessionId: unknown,
  prompt: string,
  identity?: OpenRecord | null,
): unknown | null;
export function activeStopContinuationEvidence(
  contents: string,
  childContents: string,
  resultId: unknown,
  prompt: string,
  marker: string,
  identity: OpenRecord,
  boundary: string,
): OpenRecord | null;

export function managerChildSessionEvidence(
  ctx: OpenRecord,
  agents: readonly unknown[],
  workspaceId: string,
  expectedSessionId: string,
): Promise<{
  workspaceId: string;
  expectedSessionId: string;
  candidates: unknown[];
  expectedSessionFile: unknown;
}>;
export function acceptsFailedAgentHandoff(
  entry: unknown,
  requestId: string,
  sessionId: string,
  ownerSessionId: string,
): boolean;
export function failedAgentHandoff(
  entries: readonly unknown[],
  requestId: string,
  sessionId: string,
  ownerSessionId: string,
): unknown | null;
export function agentRetirementConverged(input: {
  matchingAgents: number;
  panePresent: boolean;
  processAlive: boolean;
  mailboxPending: boolean;
}): boolean;
export function managerHandoffCanReenter(
  managerLeasePresent: unknown,
  contents: string,
  repoKey: string,
  branch: string,
  sessionId: string,
  messageId: string,
  text: string,
): boolean;
export function managerHandoffLeadPidContinues(
  initialPid: unknown,
  currentPid: unknown,
): boolean;
export function managerHandoffAssignmentReady(
  ready: unknown,
  readyEntry: unknown,
  processProof: unknown,
): boolean;
export function continuationResultsForPrompt(
  contents: string,
  prompt: string,
  marker: string,
): unknown[];
export function assistantResultForSession(
  session: { contents: string },
  prompt: string,
  marker: string,
): unknown | null;
export function assistantResponseCompletedForSession(
  session: { contents: string },
  prompt: string,
): boolean;
export function rootDelegationDiagnostics(contents: string): {
  delegationCallObserved: boolean;
  matchingResult: "absent" | "pending" | "error" | "success" | "unknown";
  errorCategory?: "agent_busy";
  assistantObserved: boolean;
  assistantStopReason:
    "stop" | "length" | "toolUse" | "error" | "aborted" | "unknown";
  assistantErrorObserved: boolean;
};
export function assertNoFailedAgentDelegation(contents: string): void;
export function parseHerdrOutput(
  stdout: string,
  args: readonly string[],
): unknown;
export function herdrErrorCode(error: unknown): string | undefined;
export function candidateStartObservationError(
  observed: { ok?: unknown; herdrCode?: unknown; error?: unknown },
  paneId: string,
): undefined | { done: false; observationError: unknown };
export function requireTestedBaseline(
  name: string,
  actualVersion: unknown,
  baselineVersion: unknown,
): void;
export function preflight(
  pkg: unknown,
  runCommand?: Command,
): Promise<{ piVersion: string; herdrVersion: string }>;
export function startParent(
  paths: OpenRecord,
  owned: unknown,
  options?: {
    spawnProcess?: (...args: unknown[]) => unknown;
    tryHerdrCommand?: (...args: unknown[]) => Promise<unknown>;
    wait?: (
      ctx: { stage: string },
      stage: string,
      inspect: () => Promise<WaitObservation>,
      options: WaitOptions,
    ) => Awaitable<unknown>;
  },
): Promise<{ name: string; env: unknown }>;
export function createParentWorkspace(
  paths: OpenRecord,
  parent: unknown,
  owned: unknown,
  cwd: string,
  herdrCommand?: (args: string[], options?: OpenRecord) => Promise<unknown>,
): Promise<string>;
export function preparePi(
  paths: OpenRecord,
  model: string,
  execute?: Command,
): Promise<"ambient" | "auth.json symlink">;
export function prepareContinuationFaux(
  paths: OpenRecord,
  extensionPath: string,
): Promise<void>;
export function nestedPaneInput(
  ctx: OpenRecord,
  args: string[],
  execute?: Command,
  options?: OpenRecord,
): Promise<OpenRecord>;
export function nestedPaneText(
  ctx: OpenRecord,
  paneId: string,
  source: string,
  execute?: Command,
): Promise<string>;
export function submitPaneCommand(
  ctx: OpenRecord,
  paneId: string,
  command: string,
  execute?: Command,
): Promise<OpenRecord>;
export function requireNestedHerdrServer(
  status: unknown,
  sessionName: string,
  baseline: string,
): string;
export function managerRecoveryFreshPrompt(branch: string): string;
export function terminalFailureEvidence(
  contents: string,
  branch: string,
  sessionId: string,
): {
  executionFailures: number;
  logicalReports: number;
  actionable: boolean;
  successHandoff: boolean;
  toolCalls: number;
  toolNames: string[];
};
export function matchPiProvenance(
  records: readonly unknown[],
  sessionId: string,
  paneId: string,
  foregroundProcesses: readonly unknown[],
  expectedModel: string,
  requireAgentDefinitions: boolean,
  expectedPiVersion: string,
): { paneId: string; pid: number; sessionId: string; piVersion: string };
export function assertContinuationFauxEvidence(
  sessionStarts: readonly unknown[],
  provenance: readonly unknown[],
  sessionId: string,
  pids: readonly number[],
): void;
export function rootFailureProvenance(
  contents: string,
  sessionId: string,
): { sessionId: string; pid: number; piVersion: string } | null;
export function scenarioVersionProvenance(
  contents: string,
  sessionIds: readonly string[],
  expectedVersion: string,
): unknown[][];
export function managerHandoffLeadProcessProof(
  provenanceContents: string,
  sessionId: string,
  paneId: string,
  foregroundProcesses: readonly unknown[],
  expectedPiVersion: string,
): { paneId: string; pid: number; sessionId: string; piVersion: string } | null;
export function requireSmokeEvidence(
  condition: unknown,
  message: string,
): asserts condition;
export function verifyCoreProvenanceEvidence(
  ctx: { firstRequestVerified?: boolean },
  provenance: readonly unknown[],
  sessionIds: Set<unknown>,
): void;
export function classifySmokeFailure(
  phase: string,
  error: unknown,
): "SETUP_FAIL" | "EVIDENCE_FAIL" | "SCENARIO_FAIL";
export function coreAgentDefinitionsExpectations(
  sessions: readonly { id: string; entries: readonly unknown[] }[],
  rootId: string,
): Map<string, boolean>;
export function coreObservationReady(input: {
  assistantResult: unknown;
  paneCount: number;
  rootProcess: unknown;
  simulated: boolean;
  provenance?: readonly { sessionId: string; pid: number }[];
  sessionIds?: Set<string>;
  observedPids?: Set<number>;
}): boolean;
export function coreCorrelationSummary(
  provenanceObservation: unknown,
  observedPids: Set<number>,
  done: boolean,
): {
  observedPids: number[];
  observedPidCount: number;
  evaluated: boolean;
  ready: boolean;
  sessionCount?: number;
  provenanceCount?: number;
  matchedCount?: number;
};
export function managerRecoveryResumePrompt(branch: string): string;
export function managerRecoveryResumeInstruction(): string;
export function managerRecoveryRetiredResumePrompt(branch: string): string;
export function managerRecoveryPostRecoveryPrompt(): string;
export function managerRecoveryLeadContextPrompt(marker: string): string;
export function managerRecoveryStopPrompt(branch: string): string;
export function managerRecoveryReviewPrompt(branch: string): string;
export function managerRecoveryResumeOnlyPrompt(branch: string): string;
export function managerRecoveryResumeDiagnostics(
  contents: string,
  prompt: string,
): {
  branch: unknown | null;
  arguments: unknown | null;
  result: { isError: unknown; details: unknown; content: unknown } | null;
}[];
export function initialPromptForScenario(
  scenario: "core",
  ctx: { expectedPackage?: string },
): string;
export function initialPromptForScenario(
  scenario: string,
  ctx: { expectedPackage?: string },
): string | undefined;
export function runScenario(ctx: unknown, scenario: string): Promise<void>;
export function listedPanes(value: unknown): { paneId: string }[];
export function inspectPaneProcesses(
  panes: readonly (string | { paneId: string })[],
  rootPaneId: string | null,
  inspect: (paneId: string) => Promise<unknown>,
  extension: string,
  integration: string,
  stage?: string,
): Promise<{ records: ProcessRecord[]; verified: ProcessRecord[] }>;
export function bestEffortProcessDiagnostics(
  ...args: Parameters<typeof inspectPaneProcesses>
): Promise<ProcessRecord[] | { error: string }>;
export function isolatedSessionDetails(
  ctx: { paths: { piSessions: string } },
  agent: unknown,
): Promise<{ path: string; id: unknown; contents: string } | null | undefined>;
export function exactIsolatedSession(
  ctx: { paths: { piSessions: string } },
  id: unknown,
): Promise<{ path: string; id: unknown; contents: string } | undefined>;
export function agentsForPiSession(
  ctx: unknown,
  agents: readonly unknown[],
  sessionId: unknown,
  getSessionId?: (ctx: unknown, agent: unknown) => unknown | Promise<unknown>,
): Promise<unknown[]>;
export function assertCoreToolEvidence(
  simulated: boolean,
  evidence: readonly OpenRecord[],
  expectedPackage: string,
): void;
export function assertContinuationReadEvidence(
  simulated: boolean,
  reads: readonly unknown[],
  readResult: unknown,
  expectedName: string,
): void;
export function retainCoreObservation(
  ctx: OpenRecord,
  records: readonly OpenRecord[],
  elapsedMs: number,
): void;
export function assertDescendantVisibility(
  labels: readonly unknown[],
  seen: { has(label: unknown): unknown },
): void;
export function assertDeepChainEvidence(
  sessions: readonly OpenRecord[],
): string[];
export function descendantCleanupStatus(
  inspection: {
    verified: Map<unknown, OpenRecord>;
    paneIds: readonly unknown[];
    unresolved: readonly unknown[];
  },
  previouslyVerified: Map<unknown, OpenRecord>,
  isPidAlive?: (pid: number) => boolean,
): {
  done: boolean;
  live: { paneId: unknown; pid: number }[];
  unresolved: unknown[];
  verified: Map<unknown, { paneId: unknown; pid: number }>;
};
export function verifyParentShutdown(
  parent: OpenRecord,
  callbacks: {
    stop: (...args: unknown[]) => Promise<unknown>;
    waitForExit: (...args: unknown[]) => Promise<unknown>;
    status: (...args: unknown[]) => Promise<OpenRecord>;
  },
  diagnostics?: OpenRecord,
): Promise<string[]>;
export function collectDiagnostics(
  ctx: OpenRecord,
  owned: OpenRecord,
  failure: unknown,
  options?: {
    execute?: Command;
    observe?: (...args: unknown[]) => Promise<unknown>;
    snapshot?: (...args: unknown[]) => Promise<unknown>;
  },
): Promise<{
  stage: unknown;
  agentsObserved: number | null;
  panesObserved: number | null;
  rootSessionObserved: boolean;
  candidateProcessesObserved: number | null;
  rootDelegation?: {
    delegationCallObserved: boolean;
    matchingResult: "absent" | "pending" | "error" | "success" | "unknown";
    errorCategory?: "agent_busy";
    assistantObserved: boolean;
    assistantStopReason:
      "stop" | "length" | "toolUse" | "error" | "aborted" | "unknown";
    assistantErrorObserved: boolean;
  } | null;
  coreDelegation?: CoreDelegation;
  coreHandoff?: CoreHandoff | null;
  supervisorAgent?: {
    assignmentsObserved: number;
    childSessionObserved: boolean;
    matchingMailboxes: number;
  };
}>;
export function bestEffortDiagnostics<T>(
  ctx: OpenRecord,
  collect: () => Promise<T>,
): Promise<T | { stage: unknown; collectionFailed: true }>;
export function cleanup(
  paths: OpenRecord,
  owned: OpenRecord,
  ctx: OpenRecord,
  options?: {
    runCommand?: (
      file: string,
      args: string[],
      options: CommandOptions,
    ) => Awaitable<{ code?: number | null; signal?: string | null }>;
    herdrCommand?: (
      args: string[],
      options?: { env?: Env; timeout?: number },
    ) => Awaitable<OpenRecord>;
    tryHerdrCommand?: (
      args: string[],
      options?: { env?: Env; timeout?: number },
    ) => Awaitable<{ ok: boolean; error?: string; value?: OpenRecord }>;
    remove?: (
      path: string,
      options: { recursive: true; force: true },
    ) => Awaitable<unknown>;
    removeFile?: (path: string) => Awaitable<unknown>;
    sleepFor?: (milliseconds: number) => Promise<unknown>;
  },
): Promise<string | null>;
export function sanitizedFailureEvidence(
  ctx: OpenRecord,
  failure: unknown,
  outcome: string,
  cleanup: string | null,
  diagnostics?: OpenRecord,
): {
  scenario: string;
  mode: string;
  outcome: string;
  stage: unknown;
  errorCode: string | undefined;
  lastVerified: unknown;
  processesVerified: boolean;
  sessionStartObserved: boolean;
  firstRequestObserved: boolean;
  firstRequestVerified: boolean;
  parentOwnership: OpenRecord;
  parentCleanup: OpenRecord;
  cleanupErrorCode: string | undefined;
  cleanupFailureCategories: string[];
  cleanup: string | null;
  terminalFailureProgress?: OpenRecord | null;
  coreObservation?: {
    verifiedProcesses: OpenRecord[] | null;
    processRecords: SanitizedProcessRecord[] | null;
    lastNonemptyObservation: {
      elapsedMs: number | null;
      processRecords: SanitizedProcessRecord[] | null;
    } | null;
    lastObservationError: string | null;
    candidateStartRecords: SanitizedProcessRecord[] | null;
    gateRootObservation: OpenRecord | null;
    correlation: OpenRecord | null;
  } | null;
  candidateStartObservation?: {
    processRecords: SanitizedProcessRecord[] | null;
  } | null;
  managerHandoffProgress?: ManagerHandoffProgress | null;
  managerBootstrapDelegation?: OpenRecord | null;
  diagnostics?: OpenRecord;
  managerBootstrapFailureDiagnostics?: OpenRecord | null;
  coreDelegation?: OpenRecord | null;
  crashRecovery?: {
    recoveryPath: string;
    continueAgentRejectionCategory: string;
  };
  rootProvenance?: OpenRecord | null;
};
export function preserveFailureEvidence(
  evidence: unknown,
  path?: string,
): Promise<string>;
export function retainScenarioFailureEvidence(
  ctx: OpenRecord,
  evidence: unknown,
  save?: (path: string, evidence: unknown) => Promise<unknown>,
): Promise<string | null>;
export function updateFailureEvidenceAfterCleanup(
  ctx: OpenRecord,
  evidence: unknown,
  save?: (path: string, evidence: unknown) => Promise<unknown>,
): Promise<void>;
export function reportFinalFailureEvidence(
  artifact: unknown,
  output?: (message: string) => void,
): Promise<boolean>;
export function reportFailureEvidenceWriteError(
  error: unknown,
  action?: string,
): void;
