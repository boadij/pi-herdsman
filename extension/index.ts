import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contentText, StringEnum } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  getAgentDir,
  getSelectListTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import {
  formatRuntimeBuild,
  runtimeBuild,
  requireCompatibleBuild,
  sameRuntimeBuild,
  type RuntimeBuild,
} from "./compatibility.ts";
import {
  resultPath as canonicalResultPath,
  resultRef,
  parseSemanticResultRef,
  reserveSemanticResultRef,
  isResultBinding,
} from "./storage.ts";
import { Type } from "typebox";
import {
  Container,
  fuzzyFilter,
  Input,
  Key,
  MouseRegion,
  matchesKey,
  SelectList,
  Spacer,
  Text as TuiText,
  type Component,
  type SelectItem,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  controlMarker,
  claimAgentMailbox,
  MailboxClaimOccupiedError,
  parseControlMarker,
  readRequest,
  readAgentState,
  scanAgentStates,
  removeRequest,
  removeAsk,
  removeResult,
  removeAgentMailbox,
  resetAgentMailbox,
  waitForState,
  agentMailboxPath,
  agentStatePath,
  writeAsk,
  writeRequest,
  writeResult,
  writeAgentState,
  type RequestRecord,
  type AskRecord,
  type ResultPersistenceError,
  type ResultRecord,
  type ManagedAgentState,
} from "./mailbox.ts";
import {
  chooseLabel,
  prepareMessageInput,
  FILE_HANDOFF_GUIDANCE,
  displayIdentity,
  steerAcceptanceAllowed,
  taskAcceptanceAllowed,
  agentControlState,
  isSpawnPlacement,
  type LeadExecutionMode,
  type SpawnPlacement,
} from "./core.ts";
import {
  AGENT_COORDINATION_TOOLS,
  agentLaunchArgs,
  agentDefinitionEnabled,
  agentDefinitionDelegationEnabled,
  agentDefinitionMetadata,
  configuredModel,
  contextAgentDefinitions,
  discoverRoleDefinition,
  discoverAgentDefinitions,
  expandAgentBodyFiles,
  projectAgentDefinition,
  resolveChildModel,
  updateAgentOverride,
  validateAgentDefinitionReferences,
  VALID_THINKING_LEVELS,
  writePrivatePromptSnapshots,
  type AgentDefinition,
} from "./agent-definitions.ts";
import {
  captureStartupDiagnostic,
  closeHerdrPane,
  herdrAgentAlias,
  herdrSessionSnapshot,
  listHerdrAgents,
  listAllHerdrAgents,
  rollbackHerdrStart,
  runHerdr,
  worktreeGroupScope,
  paneProcess,
  sessionIdentity,
  herdrSessionId,
  supervisedSessionFile,
  matchesExpectedSession,
  startHerdrAgent,
  startHerdrAgentInPane,
  sameCwd,
  inspectHerdrAgent,
  stopHerdrAgentPreservingPane,
  HerdrStartFailure,
  validateHerdrStatus,
  type ExpectedSession,
  type StartedHerdrAgent,
  type HerdrStartPlacement,
  type HerdrSessionSnapshot,
  type RemovedHerdrWorktree,
} from "./herdr.ts";
import { reportLeadMetadata } from "./herdr.ts";
import {
  managedAgentEnvironmentError,
  managedAgentEnvironmentIdentity,
  managedAgentRequiredEvidence,
  evidencePageContent,
  readEvidencePage,
  registerManagedAgentRuntime,
  runtimeIdentityState,
  sameManagedAgentIdentity,
  sessionContextRetired,
} from "./managed-agent-runtime.ts";
import {
  AGENT_EXECUTION_OWNERSHIP_GUIDANCE,
  AGENT_UNRESOLVED_GUIDANCE,
  LEAD_SCOPE_DESCRIPTION,
  canonicalSessionPath,
  createAgentStatusRuntime,
  importResultBindings,
  agentResultDetails,
  hasDeliveredAsk as controllerHasDeliveredAsk,
  collectSessionUsage,
  openOwnedAssignmentSession,
  ownedAssignmentChildren,
  resolveAssignmentSession,
  sessionAgentIdentity,
  validId,
  assertUniqueDurableIdentities,
  persistedTranscriptReady as controllerPersistedTranscriptReady,
  durableIdentityKey,
  readAgentTranscript as controllerReadAgentTranscript,
  readPersistedTranscript as controllerReadPersistedTranscript,
  resolveMessageFiles as controllerResolveMessageFiles,
  type ManagedAgentPresence,
  type ControllerScope,
  type RootDelegationPolicy,
  type Params,
  requestRecordBytesFor,
  prospectiveAssignmentFits,
  validateAssignmentCwd,
  herdrSessionsMatch,
  validateIdentity,
  validateAssignmentRequest,
  visibleAgentCapabilities,
} from "./agent-controller.ts";
import {
  acquireProcessLock,
  claimAssignmentLock as claimManagedAssignmentLock,
  claimSessionActivationLock as claimExactSessionActivationLock,
  ProcessLockOccupiedError,
  readProcessLockStatus,
  tryClaimAssignmentLock,
} from "./lock.ts";
import {
  claimChiefLease,
  chiefMessagePath,
  removeChiefMessage,
  quarantineChiefMessage,
  chiefMessageQuarantined,
  listChiefMessagePaths,
  supervisionRuntime,
  readChiefDescriptor,
  readChiefMessage,
  writeChiefMessage,
  writeCoordinationMessage,
  chiefMessageBytes,
  COORDINATION_MESSAGE_MAX_BYTES,
  projectAssignmentBytes,
  projectAssignmentPath,
  projectMessageBytes,
  writeProjectMessage,
  readProjectMessage,
  listProjectMessages,
  removeProjectMessage,
  removeProjectMessagesForAssignment,
  recoverStaleProjectMessages,
  sessionLeadRoleState,
  type ChiefLease,
  type SessionRole,
  type ManagerLease,
  type ManagerDescriptor,
  claimManagerLease,
  readManagerDescriptor,
  readManagerDescriptorStatus,
  listManagerDescriptors,
  sameManagerDescriptor,
  writeProjectAssignment,
  readProjectAssignment,
  listProjectAssignments,
  listProjectMessageHeaders,
  findProjectAssignmentBySession,
  retireProjectAssignment,
  type ChiefDescriptor,
  type ChiefMessageKind,
  type ChiefMessageRecord,
  type WorkspaceProvenance,
  projectSupervision,
  projectWorkSnapshot,
  readLeadCoordinationState,
  invalidateLeadCoordinationState,
  leadCoordinationStatePath,
  writeLeadCoordinationState,
  chiefLeaseIsHeld,
  sameChiefDescriptor,
  normalizeHerdrLifecycleState,
  peerLeadLockPath,
  peerRuntime,
  readPeerLeadRecord,
  listPeerLeadRecords,
  removePeerLeadRecord,
  samePeerLeadRecord,
  samePeerLeadGeneration,
  writePeerLeadRecord,
  drainCoordinationInbox,
  COORDINATION_MESSAGE_KINDS,
} from "./supervision.ts";
import {
  fail,
  markRetryAttempted,
  OperationError,
  type ErrorCategory,
} from "./errors.ts";

import {
  MAX_BYTE_LIMIT,
  MIN_BYTE_LIMIT,
  readConfig,
  readEffectiveConfig,
  readProjectOverrides,
  updateProjectOverride,
  updateConfig,
  validByteLimit,
} from "./config.ts";
import {
  activeLeadRole,
  createLeadToolState,
  type LeadRuntimeState,
  registerLeadRuntime,
  createLeadRoleTransitions,
  resolveLeadControllerRole,
  readLeadSessionIds,
} from "./lead-runtime.ts";

import {
  populateMenuFrame,
  collapseDisplayText,
  formatToolModelResult,
  formatAgentDefinitions,
  renderAgentDefinitionsOverview,
  renderStopSummary,
  renderCompletionMessage,
  renderAgentAskMessage,
  renderAgentStaleMessage,
  renderAgentLostMessage,
  renderAgentAttentionMessage,
  renderCoordinationMessage,
  renderCoordinationCall,
  renderCoordinationResult,
  truncateModelText,
  formatSessionUsage,
  formatSupervisionNotification,
  formatSupervisionContext,
  orderedSupervisionLeads,
  managerSupervisionItems,
  renderSupervisionPeek,
  supervisionPresentationReports,
  renderHerdRunEntry,
  hasWorkspaceWorktree,
  projectWorkspaceProvenance,
} from "./presentation.ts";
import type { SupervisionContextStatus } from "./presentation.ts";

const HERDSMAN_VERSION = packageMetadata.version;

function expandablePresentation(
  initialExpanded: boolean,
  render: (expanded: boolean) => Component,
): MouseRegion {
  let expanded = initialExpanded;
  const content = new Container();
  const rebuild = () => {
    content.clear();
    content.addChild(render(expanded));
  };
  rebuild();
  return new MouseRegion(content, (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    expanded = !expanded;
    rebuild();
    return { handled: true };
  });
}

const HERDSMAN_EXTENSION_PATH = fileURLToPath(import.meta.url);
const HERDSMAN_BUILD = runtimeBuild(HERDSMAN_VERSION, HERDSMAN_EXTENSION_PATH);
// Keep model-facing lead handles aligned with Pi's SessionManager grammar.
const PI_SESSION_ID_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$";
const AGENT_DEFINITIONS_ENTRY = "pi-herdsman-agent-definitions";
const HERD_RUN_ENTRY = "pi-herdsman-herd-run";
const AGENT_CONTEXT_RETIRED_ENTRY = "pi-herdsman-agent-context-retired";
type HerdRunEntry =
  | { phase: "started"; sessionId: string; startedAt: number }
  | {
      phase: "finished";
      sessionId: string;
      startedAt: number;
      completedAt: number;
    };
const SUPERVISOR_TOOLS = ["message_supervisor"] as const;
const LEAD_SUPERVISOR_TOOLS = SUPERVISOR_TOOLS;
const PEER_TOOLS = ["list_peers", "message_peer"] as const;
const STAFF_TOOLS = [
  "list_staff",
  "inspect_staff",
  "read_staff_transcript",
  "message_staff",
] as const;
const MANAGER_TOOLS = [
  ...SUPERVISOR_TOOLS,
  ...PEER_TOOLS,
  ...STAFF_TOOLS,
  "delegate_project",
  "resume_project",
  "stop_lead",
  "remove_worktree",
  "merge_project",
] as const;
const LEAD_COORDINATION_TOOLS = [
  ...AGENT_COORDINATION_TOOLS,
  ...LEAD_SUPERVISOR_TOOLS,
  ...PEER_TOOLS,
] as const;
const CHIEF_TOOLS = STAFF_TOOLS;
const LEAD_SUPERVISOR_PEER_GUIDANCE =
  "Use message_supervisor for material coordination or evidence your direct supervisor needs. Use list_peers/message_peer for concrete, task-relevant coordination with eligible peers. Avoid unsolicited routine progress updates, unnecessary acknowledgments, and redundant result announcements. Continue work or report normally when no coordination is needed.";
const COMMON_LEAD_GUIDANCE = `${LEAD_SCOPE_DESCRIPTION}
${LEAD_SUPERVISOR_PEER_GUIDANCE}
${FILE_HANDOFF_GUIDANCE}`;
const ORDINARY_LEAD_CHARTER = `## Lead role
You are an ordinary Lead for this Pi session.
${COMMON_LEAD_GUIDANCE}
Your Agent assignments and file handoffs are recipient-specific. Peer messages coordinate work but do not independently transfer execution ownership.`;
const MANAGED_LEAD_GUIDANCE = `Managed Lead identity is permanent for this exact Pi session. Only a current exact ProjectAssignment permits fresh managed project execution; unavailable or retired assignment state does not grant ordinary Lead execution authority. Exactly owned Agent recovery remains separate. Use native Pi /fork or /clone for independent ordinary continuation; this does not create a separate Git checkout or fresh process configuration.
For a verified managed project assignment, required project evidence is automatically inherited by newly accepted descendant Agent assignments.
A Lead's delegation task and ordinary files are recipient-specific; they do not create project-wide requirements.
Only the Manager can designate continuing project requirements.
Send proposed continuing requirements and available supporting evidence to the Manager for evaluation.
For assigned project work, include routine proposed requirements, completion, and review readiness in your normal response; Herdsman delivers it to the Manager automatically.
For assigned project work, use message_supervisor for timely coordination or explicit evidence transfer, not for a separate completion announcement.
For assigned project work, automatic result handoffs contain summary text but no file attachments. When the Manager needs an actual artifact for review, decision-making, or onward delegation, explicitly transfer the relevant evidence through message_supervisor.files.`;
const MANAGED_LEAD_CHARTER = `## Lead role
You are a Managed Lead for this Pi session.
${COMMON_LEAD_GUIDANCE}
${MANAGED_LEAD_GUIDANCE}`;
const SUPERVISION_EVENT_GUIDANCE =
  "Supervision is event-driven. Do not poll staff tools, send repeated messages, or sleep solely to wait for Lead progress. When no independent work remains, end the turn; incoming Lead updates resume coordination.";
const MANAGER_ROLE_CONTRACT = `## Manager role
You are the verified Manager for this Pi session. Supervise eligible Leads in your verified project worktree group. Manage project execution only through exact current project assignments; supervision alone grants no Agent ownership or project lifecycle authority. Configuration changes operating guidance and ordinary tool availability, never authority. Project execution belongs to assigned Leads and their Agent trees. Coordination messages and reports are nonterminal and do not establish completion. Use remove_worktree only for an explicitly requested checkout-removal action; never infer removal from completion, review, or inactivity. Unless this repository has been explicitly preauthorized by a human, the tool registers a pending approval and returns promptly. Direct the user to /manager remove to review it, then continue unrelated coordination. Do not repeat or poll a pending request; its result is not evidence of removal.
${SUPERVISION_EVENT_GUIDANCE}`;
const SUPERVISION_CONTEXT_TYPE = "pi-herdsman-supervision-context";
const SUPERVISOR_STATE_TYPE = "pi-herdsman-supervisor-state";
const STALE_AFTER_MS = 10 * 60_000;
const ACTIVITY_WRITE_MIN_MS = 5_000;
const RESULT_WRITE_MAX_ATTEMPTS = 8;
const TOKEN_ESTIMATE_BYTES = 4;
function formatMessageLimit(bytes: number): string {
  const tokens = Math.ceil(bytes / TOKEN_ESTIMATE_BYTES);
  return `${bytes / 1024} KiB · ≈${tokens.toLocaleString("en-US")} tokens`;
}
const CHIEF_ROLE_CONTRACT = `## Chief role
You are the verified workspace-neutral Chief for this Pi session. Supervise only verified direct-report Managers and eligible unassigned top-level Leads; never bypass a Manager to control assigned Leads or their Agents. Role configuration does not establish authority. Supervision snapshots and received messages are non-authoritative coordination data. Do not perform local implementation work or assume this Pi process's working directory is the supervised scope.
${AGENT_EXECUTION_OWNERSHIP_GUIDANCE}
${AGENT_UNRESOLVED_GUIDANCE}
${SUPERVISION_EVENT_GUIDANCE}`;
type Role = "lead" | "managed-agent" | "unmanaged";
type ChiefMode = "inactive" | "active" | "suspended";
type PeerParams =
  | { action: "list" }
  | { action: "message"; session: string; message: string; files?: string[] };
const REQUEST_CLEANUP_ERROR_PREFIX =
  "Acknowledged request could not be removed:";
const RESULT_DELIVERY_ERROR_PREFIX = "Result delivery failed; retrying:";
const BUILD_COMPATIBILITY_ERROR_PREFIX = "Incompatible Pi Herdsman build:";
function clearRuntimeCleanupError(runtime: Runtime, prefix?: string): void {
  if (prefix === undefined || runtime.cleanupError?.startsWith(prefix))
    runtime.cleanupError = undefined;
}
function claimAssignmentLock(
  mailbox: string,
  operation = "close",
  ids: { label?: string; paneId?: string } = {},
): () => void {
  try {
    return claimManagedAssignmentLock(mailbox);
  } catch (error) {
    if (error instanceof ProcessLockOccupiedError)
      fail("agent_busy", error.message, operation, {
        ids,
        nextAction:
          "Let the current managed assignment transition finish, then retry.",
      });
    throw error;
  }
}

function claimSessionActivationLock(sessionPath: string): () => void {
  try {
    return claimExactSessionActivationLock(canonicalSessionPath(sessionPath));
  } catch (error) {
    if (error instanceof ProcessLockOccupiedError)
      fail(
        "agent_busy",
        "The exact Pi session is already being activated",
        "delegate",
        {
          nextAction: "Let the current session activation finish, then retry.",
        },
      );
    throw error;
  }
}

function isManagedAgentEnvironment(): boolean {
  return managedAgentEnvironmentError() === undefined;
}
const role = (): Role =>
  isManagedAgentEnvironment()
    ? "managed-agent"
    : process.env.PI_HERDSMAN_MAILBOX !== undefined
      ? "unmanaged"
      : process.env.HERDR_ENV === "1"
        ? "lead"
        : "unmanaged";
async function placementSettings(
  _ctx: ExtensionContext,
): Promise<{ effective: SpawnPlacement }> {
  return { effective: readConfig().spawnPlacement };
}
const json = (v: unknown) => JSON.stringify(v, null, 2);
function appendDurableError(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: string,
  error: unknown,
): void {
  try {
    pi.appendEntry(type, { error: String(error), timestamp: Date.now() });
  } catch {
    ctx.ui.notify(type, "error");
  }
}
async function messageLimits(
  _ctx: ExtensionContext,
): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }> {
  const config = readConfig();
  return {
    inline: { bytes: config.inlineAttachmentLimitBytes },
    mailbox: { bytes: config.mailboxPayloadLimitBytes },
  };
}
function retiredManagedSession(
  manager: Pick<SessionManager, "getEntries" | "getSessionId">,
): boolean {
  const sessionId = manager.getSessionId();
  const entries = manager.getEntries();
  return (
    !!sessionAgentIdentity(entries, sessionId) &&
    sessionContextRetired(entries, sessionId)
  );
}
function collectOwnedSessionUsage(
  ctx: ExtensionContext,
  managedLeads?: readonly { id: string; piSessionFile?: string }[],
) {
  if (managedLeads === undefined)
    return collectSessionUsage(
      ctx,
      ownedAssignmentChildren,
      openOwnedAssignmentSession,
    );
  const pathsById = new Map<string, Set<string>>();
  for (const { id, piSessionFile } of managedLeads) {
    if (!pathsById.has(id)) pathsById.set(id, new Set());
    if (!piSessionFile) continue;
    try {
      pathsById.get(id)!.add(canonicalSessionPath(piSessionFile));
    } catch {
      // This ID remains unresolved unless another exact path proves it.
    }
  }
  const roots: SessionManager[] = [];
  let complete = true;
  for (const [id, paths] of pathsById) {
    if (paths.size !== 1) {
      complete = false;
      continue;
    }
    try {
      const manager = SessionManager.open(paths.values().next().value!);
      if (manager.getSessionId() !== id) {
        complete = false;
        continue;
      }
      roots.push(manager);
    } catch {
      complete = false;
    }
  }
  return collectSessionUsage(
    ctx,
    ownedAssignmentChildren,
    openOwnedAssignmentSession,
    roots,
    complete,
  );
}

async function herdrVersion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<void> {
  const status = await runHerdr(pi, ctx, ["status", "--json"], {
    signal,
    timeout: 10_000,
  });
  validateHerdrStatus(status);
}
function expectedSession(id?: string, path?: string): ExpectedSession {
  return { id, path };
}
function isPiAgent(agent: any): boolean {
  return sessionIdentity(agent?.agent_session) !== undefined;
}
export async function workspacePresentationProvenance(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workspaceIds: readonly string[],
  workspaceCwds: ReadonlyMap<string, string>,
  signal?: AbortSignal,
  snapshotWorkspaces?: readonly HerdrRecord[],
): Promise<ReadonlyMap<string, WorkspaceProvenance>> {
  const workspaces = new Map<string, HerdrRecord>();
  if (snapshotWorkspaces) {
    for (const workspace of snapshotWorkspaces)
      if (typeof workspace?.workspace_id === "string")
        workspaces.set(workspace.workspace_id, workspace);
  } else {
    const records = await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        try {
          return [
            workspaceId,
            (
              await runHerdr(pi, ctx, ["workspace", "get", workspaceId], {
                signal,
              })
            )?.workspace,
          ] as const;
        } catch {
          return [workspaceId, undefined] as const;
        }
      }),
    );
    for (const [workspaceId, workspace] of records)
      if (workspace) workspaces.set(workspaceId, workspace);
  }

  const sources = new Map<
    string,
    { workspaceId: string; repoKey: string; repoRoot: string }
  >();
  for (const workspaceId of new Set(workspaceIds)) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) continue;
    const repoKey = workspace?.worktree?.repo_key;
    const repoRoot = workspace?.worktree?.repo_root;
    if (
      typeof repoKey !== "string" ||
      !repoKey ||
      typeof repoRoot !== "string" ||
      !repoRoot
    )
      continue;
    const key = `${repoKey}\0${repoRoot}`;
    if (!sources.has(key)) sources.set(key, { workspaceId, repoKey, repoRoot });
  }

  const topologyByRepo = new Map<string, HerdrRecord>();
  for (const [key, source] of sources) {
    if (signal?.aborted) break;
    try {
      const topology = await runHerdr(
        pi,
        ctx,
        ["worktree", "list", "--workspace", source.workspaceId],
        { signal },
      );
      if (
        topology?.source?.repo_key === source.repoKey &&
        topology?.source?.repo_root === source.repoRoot &&
        Array.isArray(topology?.worktrees)
      )
        topologyByRepo.set(key, topology);
    } catch {
      // Presentation stays partial when repository discovery is unavailable.
    }
  }

  const topologyByWorkspace = new Map<string, HerdrRecord>();
  if (!snapshotWorkspaces)
    for (const workspaceId of new Set(workspaceIds)) {
      const workspace = workspaces.get(workspaceId);
      const repoKey = workspace?.worktree?.repo_key;
      const repoRoot = workspace?.worktree?.repo_root;
      if (
        !hasWorkspaceWorktree(workspace) ||
        (typeof repoKey === "string" &&
          repoKey &&
          typeof repoRoot === "string" &&
          repoRoot)
      )
        continue;
      try {
        topologyByWorkspace.set(
          workspaceId,
          await runHerdr(
            pi,
            ctx,
            ["worktree", "list", "--workspace", workspaceId],
            { signal },
          ),
        );
      } catch {
        // Preserve the peer's partial presentation when discovery is unavailable.
      }
    }

  return new Map(
    workspaceIds.map((workspaceId) => {
      const workspace = workspaces.get(workspaceId);
      const repoKey = workspace?.worktree?.repo_key;
      const repoRoot = workspace?.worktree?.repo_root;
      const key =
        typeof repoKey === "string" && typeof repoRoot === "string"
          ? `${repoKey}\0${repoRoot}`
          : undefined;
      return [
        workspaceId,
        projectWorkspaceProvenance(
          workspaceId,
          workspace,
          (key ? topologyByRepo.get(key) : undefined) ??
            topologyByWorkspace.get(workspaceId),
          workspaceCwds.get(workspaceId),
        ),
      ];
    }),
  );
}
function resultPath(runtime: Runtime, requestId: string): string {
  return `${runtime.mailboxPath}/result-${requestId}.json`;
}
function nextBranchResultIndex(
  entries: readonly unknown[],
  agentLabel: string,
): number {
  let max = 0;

  for (const entry of entries) {
    const details = agentResultDetails(entry);
    if (details?.agentLabel === agentLabel) {
      const index = details.resultIndex;
      if (
        typeof index === "number" &&
        Number.isSafeInteger(index) &&
        index > max
      )
        max = index;
    }

    const imported = importedResultBinding(entry);
    const semantic = imported && parseSemanticResultRef(imported.ref);
    if (semantic?.agent === agentLabel) max = Math.max(max, semantic.index);
  }

  return max + 1;
}
function normalizeCloseFailure(
  error: unknown,
  ids: { label?: string; paneId?: string },
  details: Record<string, unknown> = {},
): OperationError {
  if (error instanceof OperationError) {
    return new OperationError({
      ...error.detail,
      operation: "close",
      ids: { ...ids, ...error.detail.ids },
      details: { ...error.detail.details, ...details },
    });
  }
  return new OperationError({
    category: "internal_failure",
    message: String(error),
    operation: "close",
    rollbackOccurred: false,
    retryAttempted: false,
    ids,
    details,
  });
}

type StopReportCallbacks = {
  onClosed?: (label: string) => void;
  onCleanupFailure?: (label: string, message: string) => void;
};

type TestProjectAssignmentLockHooks = {
  afterAcquired?: (repoKey: string, branch: string) => Promise<void>;
  afterOccupied?: (repoKey: string, branch: string) => Promise<void>;
  onAuthorityWaitOccupied?: () => void;
  afterRequestPublished?: (
    mailboxPath: string,
    request: import("./mailbox.ts").RequestRecord,
  ) => undefined;
  removeProjectMessage?: typeof removeProjectMessage;
};

export function registerExtensionForTest(
  pi: ExtensionAPI,
  lockHooks: TestProjectAssignmentLockHooks,
): void {
  registerExtensionImpl(pi, lockHooks);
}

export default function (pi: ExtensionAPI): void {
  registerExtensionImpl(pi);
}

function registerExtensionImpl(
  pi: ExtensionAPI,
  lockHooks?: TestProjectAssignmentLockHooks,
): void {
  let leadRuntimes!: ReturnType<typeof registerLeadRuntime>;
  let leadStatusRuntime: ReturnType<
    typeof registerLeadRuntime
  >["statusRuntime"];
  let leadHerdRunRuntime!: NonNullable<
    ReturnType<typeof registerLeadRuntime>["herdRunRuntime"]
  >;

  const agentEnvError =
    process.env.PI_HERDSMAN_MAILBOX !== undefined
      ? managedAgentEnvironmentError()
      : undefined;
  if (agentEnvError) {
    pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
      appendDurableError(
        pi,
        ctx,
        "pi_herdsman_state_error",
        new Error("invalid agent environment: " + agentEnvError),
      );
    });
    return;
  }
  pi.registerEntryRenderer(AGENT_DEFINITIONS_ENTRY, (entry, options, theme) => {
    const definitions = entry?.data?.definitions;
    if (
      !Array.isArray(definitions) ||
      !definitions.every(
        (definition) =>
          definition !== null &&
          typeof definition === "object" &&
          !Array.isArray(definition),
      )
    )
      return undefined;
    const instructions =
      typeof entry?.data?.instructions === "string"
        ? entry.data.instructions
        : undefined;
    return expandablePresentation(options.expanded, (expanded) =>
      renderAgentDefinitionsOverview(definitions, theme, {
        ...options,
        expanded,
        instructions,
      }),
    );
  });
  pi.registerEntryRenderer(HERD_RUN_ENTRY, (entry, _options, theme) =>
    renderHerdRunEntry(entry, theme),
  );
  for (const kind of COORDINATION_MESSAGE_KINDS) {
    pi.registerMessageRenderer(
      `pi-herdsman-${kind}`,
      (message, options, theme) =>
        expandablePresentation(options.expanded, (expanded) =>
          renderCoordinationMessage(
            kind,
            message,
            { ...options, expanded },
            theme,
          ),
        ),
    );
  }
  pi.registerMessageRenderer(
    "pi-herdsman-project_message",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderCoordinationMessage(
          "project_message",
          message,
          { ...options, expanded },
          theme,
        ),
      ),
  );
  pi.registerMessageRenderer(
    "pi-herdsman-stop-summary",
    (message, _options, theme) => renderStopSummary(message, theme),
  );
  pi.registerMessageRenderer(
    "pi-herdsman-agent-result",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderCompletionMessage(message, { ...options, expanded }, theme),
      ),
  );
  pi.registerMessageRenderer(
    "pi-herdsman-agent-ask",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderAgentAskMessage(message, { ...options, expanded }, theme),
      ),
  );
  pi.registerMessageRenderer(
    "pi-herdsman-agent-stale",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderAgentStaleMessage(message, { ...options, expanded }, theme),
      ),
  );
  pi.registerMessageRenderer(
    "pi-herdsman-agent-lost",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderAgentLostMessage(message, { ...options, expanded }, theme),
      ),
  );
  pi.registerMessageRenderer(
    "pi-herdsman-agent-attention",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderAgentAttentionMessage(message, { ...options, expanded }, theme),
      ),
  );
  const processRole = role();
  if (processRole === "unmanaged") {
    const setupHandler = async (
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ) => {
      if (!ctx.hasUI) return;
      if (rawArgs.trim()) {
        ctx.ui.notify("Usage: /herdsman", "error");
        return;
      }
      ctx.ui.notify(
        `Pi Herdsman v${HERDSMAN_VERSION} is inactive because this Pi session is not running inside Herdr.\n\nStart Herdr in this project, then run Pi in a Herdr pane:\n  herdr\n  pi\n\nIf needed, install the Pi integration once:\n  herdr integration install pi`,
      );
    };
    const setupCommand = {
      description: "Set up Pi Herdsman",
      handler: setupHandler,
    };
    pi.registerCommand("herdsman", setupCommand);
    pi.registerCommand("agents", {
      ...setupCommand,
      description: "Alias for /herdsman",
    });
    return;
  }
  const controllerScope: ControllerScope | undefined =
    processRole === "lead" ? { kind: "root" } : undefined;
  const controllerServices = {
    afterRequestPublishedForTest: lockHooks?.afterRequestPublished,
    extensionPath: HERDSMAN_EXTENSION_PATH,
    isContextRetired: (manager) => retiredManagedSession(manager),
    snapshotDependencies: {
      runtimeForLabel: () => undefined,
      readLeadSessionIds: (inventory, mailboxes, workspaceId) =>
        processRole === "managed-agent"
          ? readLeadSessionIds(inventory, mailboxes, workspaceId, {
              matchesExpectedSession,
              isPiAgent,
              supervisionRuntime,
              readLeadCoordinationState,
            })
          : leadRuntimes.coordinationRuntime!.readLeadSessionIds(
              inventory,
              mailboxes,
              workspaceId,
            ),
      staleAfterMs: STALE_AFTER_MS,
    },
    managedProjectEvidence: async (ctx, workspaceId, projectAssignmentId) => {
      const resolve = async () => {
        const scope = await worktreeGroupScope(
          pi,
          ctx,
          workspaceId,
          ctx.signal,
        );
        const matches = findProjectAssignmentBySession(
          supervisionRuntime(),
          scope.repoKey,
          projectAssignmentId,
        );
        if (matches.length > 1)
          throw new Error(
            "Multiple project assignments match the Agent session",
          );
        return matches[0];
      };
      const assignment = await resolve();
      if (!assignment) return undefined;
      return {
        assignment,
        revalidate: async (operation: () => Promise<void> | void) => {
          const lease = acquireProcessLock(
            `${projectAssignmentPath(
              supervisionRuntime(),
              assignment.repoKey,
              assignment.branch,
            )}.lock`,
            { name: "project assignment lock" },
          );
          try {
            const current = await resolve();
            if (!current || current.id !== assignment.id)
              throw new Error(
                "Project assignment changed during Agent startup; retry delegation",
              );
            await operation();
          } finally {
            lease.release();
          }
        },
      };
    },
    persistedTranscriptReady: (state) =>
      controllerPersistedTranscriptReady(state, (path) => {
        const file = statSync(path, { throwIfNoEntry: false });
        return !!file?.isFile() && file.size > 0;
      }),
    agentDefinitions: async (ctx) =>
      (await contextAgentDefinitions(ctx)).definitions,
    readTranscript: (state) =>
      controllerReadAgentTranscript(
        state,
        (path) => readFileSync(path, "utf8"),
        (path) => {
          const file = statSync(path, { throwIfNoEntry: false });
          return !!file?.isFile() && file.size > 0;
        },
      ),
    workspaceId: () =>
      process.env.PI_HERDSMAN_WORKSPACE_ID ?? process.env.HERDR_WORKSPACE_ID!,
    sendResultMessage: (ctx, _runtime, _result, content, details) => {
      pi.sendMessage(
        {
          customType: "pi-herdsman-agent-result",
          content,
          display: true,
          details,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    sendAskMessage: (_ctx, ask) => {
      pi.sendMessage(
        {
          customType: "pi-herdsman-agent-ask",
          content: `Agent ${ask.agentLabel} needs your input:\n\n${ask.question}\n\nUse reply_agent with agent="${ask.agentLabel}" to answer this question.`,
          display: true,
          details: {
            askId: ask.askId,
            question: ask.question,
            requestId: ask.requestId,
            runId: ask.runId,
            agentLabel: ask.agentLabel,
            workspaceId: ask.workspaceId,
            paneId: ask.paneId,
            piSessionId: ask.piSessionId,
          },
        },
        { triggerTurn: true },
      );
    },
    sessionRetired: (ctx, runtime) => {
      if (!runtime.piSessionFile) return undefined;
      try {
        const session = SessionManager.open(runtime.piSessionFile);
        if (!retiredManagedSession(session)) return false;
        return sameCwd(ctx.cwd, session.getCwd())
          ? readEffectiveConfig(ctx).contextRetirement
          : undefined;
      } catch {
        return undefined;
      }
    },
    appendError: (ctx, kind, error) => appendDurableError(pi, ctx, kind, error),
    onChanged: () => leadStatusRuntime.requestRefresh(),
    reportWatcherError: (ctx, error) => {
      if (
        error instanceof OperationError &&
        error.detail.category === "incompatible_build"
      )
        return;
      appendDurableError(pi, ctx, "pi_herdsman_cleanup_error", error);
    },
  };
  const FILES_SCHEMA = Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        description:
          "Readable regular local file path or exact result ref returned by Herdsman.",
      }),
      {
        description:
          "Transfer relevant readable files or result refs actually available in this Pi session. Recipients do not inherit your conversation or attachments. A ref mentioned only in text is not transferable evidence. Copy available refs exactly and omit unrelated files. Evidence does not grant runtime capabilities.",
      },
    ),
  );
  const emptyParameters = Type.Object({}, { additionalProperties: false });
  const staffTargetParameters = Type.Object(
    {
      session: Type.String({
        pattern: PI_SESSION_ID_PATTERN,
        description:
          "Exact full Pi session ID shown in the fresh supervision snapshot or returned by list_staff; never use a display name.",
      }),
    },
    { additionalProperties: false },
  );
  const staffMessageParameters = Type.Object(
    {
      session: Type.String({
        pattern: PI_SESSION_ID_PATTERN,
        description:
          "Exact full Pi session ID from the fresh supervision snapshot or list_staff.",
      }),
      message: Type.String({ minLength: 1 }),
      files: FILES_SCHEMA,
      retain: Type.Optional(
        Type.Boolean({
          description:
            "For Manager messages to assigned project Leads: retain both message text and files as evidence available to eligible descendant Agents. They can inspect relevant references as needed; use for lasting requirements and accepted reviews, not temporary communication.",
        }),
      ),
    },
    { additionalProperties: false },
  );
  const peerMessageParameters = Type.Object(
    {
      session: Type.String({
        pattern: PI_SESSION_ID_PATTERN,
        description:
          "Exact full Pi session ID returned by list_peers; never use a display label.",
      }),
      message: Type.String({ minLength: 1 }),
      files: FILES_SCHEMA,
    },
    { additionalProperties: false },
  );
  const supervisorMessageParameters = Type.Object(
    { message: Type.String({ minLength: 1 }), files: FILES_SCHEMA },
    { additionalProperties: false },
  );
  const staffDelegateParameters = Type.Object(
    {
      task: Type.String({
        minLength: 1,
        description: "Non-empty task for new project work.",
      }),
      branch: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Optional Git branch for the new project work; Herdsman generates one when omitted.",
        }),
      ),
      base: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Base ref used only when Herdsman creates a new worktree.",
        }),
      ),
      files: FILES_SCHEMA,
    },
    { additionalProperties: false },
  );
  const staffBranchParameters = Type.Object(
    {
      branch: Type.String({
        minLength: 1,
        description: "Exact project branch.",
      }),
    },
    { additionalProperties: false },
  );
  let startupDefinitionRoster:
    { sessionId: string; definitions: Record<string, unknown>[] } | undefined;
  let leadRuntime!: LeadRuntimeState;
  let leadToolState!: ReturnType<typeof createLeadToolState>;
  const activeRole = (): SessionRole => activeLeadRole(leadRuntime);
  const supervisionHost = {
    herdrSessionSnapshot,
    managedAgentSnapshots: (
      _pi: ExtensionAPI,
      context: ExtensionContext,
      ...args: any[]
    ) => leadRuntimes.controller!.managedAgentSnapshots(context, ...args),
    presentationReports: supervisionPresentationReports,
    readLeadCoordinationState,
    supervisionRuntime,
    listAllHerdrAgents,
    isPiAgent,
    herdrSessionId,
    runHerdr,
    readChiefDescriptor,
    remoteChiefAgent: (...args: any[]) =>
      leadRuntimes.remoteChiefAgent(...args),
    sameChiefDescriptor,
    formatContext: formatSupervisionContext,
    contextType: SUPERVISION_CONTEXT_TYPE,
    tui: {
      Container,
      Key,
      matchesKey,
      SelectList,
      Text: TuiText,
    },
    sameManagerDescriptor,
    worktreeGroupScope,
    listProjectAssignments,
    projectWorkSnapshot,
    supervisedSessionFile: (agent, sessionId) =>
      supervisedSessionFile(agent, sessionId, (cwd, id) =>
        SessionManager.findById(cwd, id),
      ),
    statSync,
    workspacePresentationProvenance,
    normalizeHerdrLifecycleState,
    appendDurableError,
    projectSupervision,
    listManagerDescriptors,
    formatSupervisionNotification,
    orderedSupervisionLeads,
    managerSupervisionItems,
    renderSupervisionPeek,
    inspectHerdrAgent,
  };
  const resetSupervisionSnapshot = (): void =>
    leadRuntimes?.supervisionUiRuntime?.reset();
  const clearChiefStartPreflight = (): void =>
    leadRuntimes.inboxRuntime!.clearStartPreflight();
  let prepareSupervisionMessage: (
    ctx: ExtensionContext,
  ) => Promise<
    { customType: string; content: string; display: boolean } | undefined
  > = async () => undefined;
  let supervisorTool: any;
  let peerTool: any;
  const ownedToolNames = [
    "agent",
    "chief",
    "peer",
    "staff",
    ...AGENT_COORDINATION_TOOLS,
    ...LEAD_SUPERVISOR_TOOLS,
    ...PEER_TOOLS,
    ...STAFF_TOOLS,
    "read_evidence",
    "delegate_project",
    "resume_project",
    "stop_lead",
    "remove_worktree",
    "merge_project",
  ];
  if (processRole === "managed-agent") {
    leadStatusRuntime = createAgentStatusRuntime();
    leadToolState = createLeadToolState(
      () => pi.getAllTools(),
      ownedToolNames,
      LEAD_COORDINATION_TOOLS,
    );
  }
  const ownedTools = () => leadToolState.ownedTools;
  const normalizeBaseTools = (tools: readonly string[]): string[] =>
    leadToolState.normalizeBaseTools(tools);
  const appendRegisteredTools = (
    tools: readonly string[],
    names: readonly string[],
  ): string[] => leadToolState.appendRegisteredTools(tools, names);
  const normalizeLeadTools = (tools: readonly string[]): string[] =>
    leadToolState.normalizeLeadTools(tools);
  let roleTransitions: ReturnType<typeof createLeadRoleTransitions>;
  const reconcileRoleTools = (): void => roleTransitions.reconcileRoleTools();
  const isCurrentChief = (ctx: ExtensionContext): boolean =>
    leadRuntime.chiefMode === "active" &&
    !!leadRuntime.chiefLease &&
    leadRuntime.chiefLease.descriptor.piSessionId ===
      ctx.sessionManager.getSessionId();
  const chiefSystemPrompt = (
    options: BuildSystemPromptOptions | undefined,
    body: string,
  ): string => {
    const agentDir = resolve(getAgentDir());
    const globalInstructions = (options?.contextFiles ?? [])
      .filter(
        ({ path, content }) =>
          typeof path === "string" &&
          typeof content === "string" &&
          resolve(dirname(path)) === agentDir &&
          content.length > 0,
      )
      .map(({ content }) => content)
      .join("\n\n");
    return [
      CHIEF_ROLE_CONTRACT,
      body || undefined,
      globalInstructions
        ? `## global user instructions\n\n<global_instructions>\n${globalInstructions}\n</global_instructions>`
        : undefined,
    ]
      .filter((section): section is string => section !== undefined)
      .join("\n\n");
  };
  const markLeadCoordinationUnhealthy = (ctx?: ExtensionContext): void =>
    leadRuntimes.coordinationRuntime!.markLeadCoordinationUnhealthy(ctx);
  const schedulePeerPresence = (ctx: ExtensionContext): Promise<void> =>
    leadRuntimes.coordinationRuntime!.schedulePeerPresence(ctx);
  const publishLeadRole = (
    ...args: Parameters<typeof leadRuntimes.publishLeadRole>
  ) => leadRuntimes.publishLeadRole(...args);
  const queueLeadMetadata = (
    ...args: Parameters<typeof leadRuntimes.queueLeadMetadata>
  ) => leadRuntimes.queueLeadMetadata(...args);
  const enterLead = (...args: Parameters<typeof leadRuntimes.enterLead>) =>
    leadRuntimes.enterLead(...args);
  const enterChief = (...args: Parameters<typeof leadRuntimes.enterChief>) =>
    leadRuntimes.enterChief(...args);
  const enterSuspended = (
    ...args: Parameters<typeof leadRuntimes.enterSuspended>
  ) => leadRuntimes.enterSuspended(...args);
  const assertCurrentLeadCoordination = (ctx: ExtensionContext): void =>
    leadRuntimes.coordinationRuntime!.assertCurrentLeadCoordination(ctx);
  const currentChief = (
    failOnVerificationError = false,
  ): ChiefDescriptor | undefined =>
    roleTransitions.currentChief(failOnVerificationError);
  const managerForScope = (
    scope: Awaited<ReturnType<typeof worktreeGroupScope>> | undefined,
  ) => roleTransitions.managerForScope(scope);
  const currentWorktreeScope = (ctx: ExtensionContext) =>
    roleTransitions.currentWorktreeScope(ctx);
  const currentManager = (
    ctx: ExtensionContext,
    scope:
      Awaited<ReturnType<typeof worktreeGroupScope>> | undefined | null = null,
  ): Promise<ManagerDescriptor | undefined> =>
    roleTransitions.currentManager(ctx, scope);
  const currentSupervisor = (ctx: ExtensionContext) =>
    roleTransitions.currentSupervisor(ctx);
  const liveAgent = (...args: any[]) => leadRuntimes.liveAgent(...args);
  const remoteChiefAgent = (...args: any[]) =>
    leadRuntimes.remoteChiefAgent(...args);
  const liveLead = (...args: any[]) => leadRuntimes.liveLead(...args);
  const currentChiefAuthority = (
    ctx: ExtensionContext,
    failOnVerificationError = false,
  ) => roleTransitions.currentChiefAuthority(ctx, failOnVerificationError);
  const activateChief = (
    ctx: ExtensionCommandContext,
    resumed = false,
  ): Promise<string> => roleTransitions.activateChief(ctx, resumed);
  const roleTransitionHost = {
    processRole,
    build: HERDSMAN_BUILD,
    paneId: () => process.env.HERDR_PANE_ID,
    getSessionName: () => pi.getSessionName(),
    runHerdr,
    SessionManager,
    reportLeadMetadata,
    workspaceId: () => process.env.HERDR_WORKSPACE_ID,
    identity: {
      paneId: process.env.HERDR_PANE_ID,
      tabId: process.env.HERDR_TAB_ID,
      workspaceId: process.env.HERDR_WORKSPACE_ID,
    },
    statSync,
    readChiefDescriptor,
    chiefLeaseIsHeld,
    sameChiefDescriptor,
    remoteChiefAgent,
    claimChiefLease,
    supervisionRuntime,
    readManagerDescriptor,
    readManagerDescriptorStatus,
    sameManagerDescriptor,
    chiefTools: CHIEF_TOOLS,
    managerTools: MANAGER_TOOLS,
    invalidateLeadCoordinationState,
    enterChief,
    resetSupervisionSnapshot,
    unlinkLeadCoordinationState: (runtime, sessionId) =>
      unlinkSync(leadCoordinationStatePath(runtime, sessionId)),
    ownedTools,
    worktreeGroupScope: (ctx, workspaceId, signal = ctx.signal) =>
      worktreeGroupScope(pi, ctx, workspaceId, signal),
    claimManagerLease,
    readLeadCoordinationState,
    requireCompatibleBuild,
    findProjectAssignmentBySession,
    projectAssignmentPath,
    acquireProcessLock,
    readProjectAssignment,
    prepareCoordinationInput: (...args: any[]) =>
      leadRuntimes.coordinationRuntime!.prepareCoordinationInput(...args),
    projectMessageBytes,
    writeProjectMessage,
    afterProjectAssignmentLockAcquired: lockHooks?.afterAcquired,
    afterProjectAssignmentLockOccupied: lockHooks?.afterOccupied,
    onProjectAssignmentAuthorityWaitOccupied:
      lockHooks?.onAuthorityWaitOccupied,
    retireProjectAssignment,
    removeProjectMessagesForAssignment,
    recoverStaleProjectMessages,
    delay,
    appendDurableError,
    markLeadCoordinationUnhealthy,
    supervisorTools: SUPERVISOR_TOOLS,
    sessionLeadRoleState,
    isCurrentChief,
    scanAgentStates,
    enterLead,
    enterSuspended,
    activation: { activateChief },
  };
  const deactivateChief = (...args: any[]) =>
    roleTransitions.deactivateChief(...args);
  const leaveChief = (...args: any[]) => roleTransitions.leaveChief(...args);
  const failClosedRole = (...args: any[]) =>
    roleTransitions.failClosedRole(...args);
  const activateManager = (...args: any[]) =>
    roleTransitions.activateManager(...args);
  const leaveManager = (...args: any[]) =>
    roleTransitions.leaveManager(...args);
  if (controllerScope) {
    let projectRuntime: NonNullable<
      ReturnType<typeof registerLeadRuntime>["projectRuntime"]
    >;
    const queueLeadPresentation = (
      ctx: ExtensionContext,
      name = pi.getSessionName(),
    ): void => {
      if (
        controllerScope.kind !== "root" ||
        !roleTransitions.leadPresentationAllowed()
      )
        return;
      const paneId = process.env.HERDR_PANE_ID;
      if (!paneId) return;
      const percent = ctx.getContextUsage()?.percent;
      const startedAt = leadHerdRunRuntime?.startedAt();
      queueLeadMetadata(ctx, {
        paneId,
        name,
        ...(startedAt !== undefined ? { herdRunStartedAt: startedAt } : {}),
        ...(percent == null ? {} : { contextPercent: Math.round(percent) }),
      });
    };
    const projectHost = {
      readConfig,
      projectAssignmentPath,
      acquireProcessLock,
      stopProjectLeadPane: (
        ctx: ExtensionContext,
        target: any,
        session: string,
        signal?: AbortSignal,
      ) =>
        stopHerdrAgentPreservingPane(
          pi,
          ctx,
          target.pane_id,
          {
            paneId: target.pane_id,
            tabId: target.tab_id,
            workspaceId: target.workspace_id,
            cwd: target.cwd,
            session: expectedSession(session),
          },
          signal,
        ),
      sameManagerDescriptor,
      worktreeGroupScope: (
        _pi: any,
        ctx: ExtensionContext,
        workspaceId: string,
        signal?: AbortSignal,
      ) => worktreeGroupScope(pi, ctx, workspaceId, signal),
      findProjectAssignmentBySession,
      supervisionRuntime,
      readProjectAssignment,
      runHerdr,
      readLeadCoordinationState,
      requireCompatibleBuild,
      scanAgentStates,
      writeChiefMessage,
      herdrSessionSnapshot,
      isPiAgent,
      listProjectAssignments,
      herdrSessionId,
      messageLimits,
      prepareMessageInput,
      resolveMessageFiles: controllerResolveMessageFiles,
      projectAssignmentBytes,
      writeProjectAssignment,
      onProjectAssignmentAuthorityWaitOccupied:
        lockHooks?.onAuthorityWaitOccupied,
      delay,
      startHerdrAgentInPane,
      sessionIdentity,
      captureStartupDiagnostic,
      appendDurableError,
      stopHerdrAgentPreservingPane,
      expectedSession,
      build: HERDSMAN_BUILD,
      extensionPath: HERDSMAN_EXTENSION_PATH,
      SessionManager,
      truncateModelText,
      inspectHerdrAgent,
      readPersistedTranscript: (target) =>
        controllerReadPersistedTranscript(
          target,
          (path) => readFileSync(path, "utf8"),
          (path) => {
            const file = statSync(path, { throwIfNoEntry: false });
            return !!file?.isFile() && file.size > 0;
          },
        ),
    };
    prepareSupervisionMessage = (ctx) =>
      leadRuntimes.supervisionUiRuntime!.prepareMessage(ctx);
    const leadAgentEventOptions = {
      drainRetirementNotices: (ctx: ExtensionContext, preflight: boolean) =>
        leadRuntimes.coordinationRuntime!.drainRetirementNotices(
          ctx,
          preflight,
        ),
      isCurrentChief,
      chiefTools: CHIEF_TOOLS,
      setActiveTools: (tools: string[]) => pi.setActiveTools(tools),
      prepareSupervisionMessage,
      sendMessage: (message: any) =>
        pi.sendMessage(message, { triggerTurn: false }),
      chiefSystemPrompt,
      roleCharter: (ctx: ExtensionContext) => {
        const role = activeRole();
        if (
          leadRuntime.roleSuspended ||
          (role === "chief" && !isCurrentChief(ctx)) ||
          (role === "manager" && !leadRuntime.managerLease)
        )
          return `## Herdsman role\nNo active Herdsman role is verified for this Pi session.`;
        if (role === "manager")
          return `${MANAGER_ROLE_CONTRACT}\n\n${leadRuntimes.supervisoryProfileBody(ctx, "manager")}`;
        const kind = leadRuntimes.sessionKindForPrompt(ctx);
        if (kind === "ordinary") return ORDINARY_LEAD_CHARTER;
        if (kind === "managed") return MANAGED_LEAD_CHARTER;
        return `## Herdsman role\nNo active Herdsman role is verified for this Pi session.`;
      },
      supervisoryProfileBody: (
        ctx: ExtensionContext,
        role: "manager" | "chief",
      ) => leadRuntimes.supervisoryProfileBody(ctx, role),
      currentChiefAllowedTools: (ctx: ExtensionContext) =>
        leadRuntimes.currentChiefAllowedTools(ctx),
      isActiveManager: () =>
        activeRole() === "manager" && !leadRuntime.roleSuspended,
      isActiveLead: () => activeRole() === "lead",
      prepareLeadSupervisorStateMessage: (ctx: ExtensionContext) =>
        leadRuntimes.coordinationRuntime!.prepareLeadSupervisorStateMessage(
          ctx,
        ),
      definitionRoster: () => startupDefinitionRoster,
      isRoleSuspended: () => leadRuntime.roleSuspended,
    };
    const initialStatusBreadcrumb =
      controllerScope.kind === "root"
        ? [{ text: "owner/controller" }]
        : [
            { text: "?" },
            {
              text:
                process.env.PI_HERDSMAN_AGENT_DEFINITION &&
                process.env.PI_HERDSMAN_LABEL
                  ? displayIdentity(
                      process.env.PI_HERDSMAN_AGENT_DEFINITION,
                      process.env.PI_HERDSMAN_LABEL,
                    )
                  : (process.env.PI_HERDSMAN_AGENT_DEFINITION ?? "?"),
            },
          ];
    let ownTools: string[] | undefined;
    const ownToolsSnapshot = (): { ownTools?: string[] } =>
      ownTools ? { ownTools } : {};
    type MenuItem = SelectItem & { help?: string };
    type ModelMenuItem = MenuItem & { searchText: string };
    const selectMenu = async (
      ctx: ExtensionContext,
      title: string,
      items: readonly MenuItem[],
      selectedValue?: string,
    ): Promise<string | undefined> => {
      if (ctx.mode !== "tui") {
        const options = items.map((item) =>
          item.description ? `${item.label}  ${item.description}` : item.label,
        );
        const selected = await ctx.ui.select(title, options);
        const index = selected === undefined ? -1 : options.indexOf(selected);
        return index >= 0 ? items[index]?.value : undefined;
      }
      return (await ctx.ui.custom(
        (tui: any, theme: any, _keys: any, done: (value: unknown) => void) => {
          const maxPrimaryColumnWidth = Math.max(
            12,
            ...items.map((item) => visibleWidth(item.label) + 2),
          );
          const list = new SelectList(items, 8, getSelectListTheme(), {
            minPrimaryColumnWidth: 12,
            maxPrimaryColumnWidth,
          });
          const hasHelp = items.some((item) =>
            collapseDisplayText(item.help, 160),
          );
          const helpArea = hasHelp ? new Container() : undefined;
          const helpText = new TuiText("", 1, 0);
          const emptyHelp = new Spacer(1);
          const updateHelp = (item: SelectItem | null): void => {
            if (!helpArea) return;
            const text = collapseDisplayText(
              (item as MenuItem | null)?.help,
              160,
            );
            helpArea.clear();
            if (text) {
              helpText.setText(theme.fg("dim", text));
              helpArea.addChild(helpText);
            } else {
              helpArea.addChild(emptyHelp);
            }
          };
          const index = items.findIndex((item) => item.value === selectedValue);
          if (index >= 0) list.setSelectedIndex(index);
          updateHelp(items[index >= 0 ? index : 0] ?? null);
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(undefined);
          list.onSelectionChange = updateHelp;
          const container = new Container();
          populateMenuFrame(
            container,
            theme,
            title,
            list,
            "↑↓ navigate · Enter select · Esc close",
            helpArea,
          );
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              list.handleInput(data);
              tui.requestRender();
            },
          };
        },
      )) as string | undefined;
    };
    const selectModelMenu = async (
      ctx: ExtensionContext,
      items: readonly ModelMenuItem[],
      selectedValue?: string,
    ): Promise<string | undefined> => {
      if (ctx.mode !== "tui")
        return selectMenu(ctx, "Model", items, selectedValue);
      return (await ctx.ui.custom(
        (
          tui: any,
          theme: any,
          keybindings: any,
          done: (value: unknown) => void,
        ) => {
          const input = new Input();
          const listContainer = new Container();
          let list: SelectList | undefined;
          let filtered: ModelMenuItem[] = [...items];
          let previousQuery = input.getValue();
          const rebuildList = (): void => {
            const query = input.getValue();
            const filtering = query.split(/[\s/]+/u).some(Boolean);
            filtered = filtering
              ? fuzzyFilter([...items], query, (item) => item.searchText)
              : [...items];
            listContainer.clear();
            if (!filtered.length) {
              list = undefined;
              listContainer.addChild(
                new TuiText(theme.fg("muted", "No matching models"), 1, 0),
              );
              return;
            }
            list = new SelectList(filtered, 10, getSelectListTheme());
            const index = filtering
              ? 0
              : filtered.findIndex((item) => item.value === selectedValue);
            list.setSelectedIndex(index >= 0 ? index : 0);
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(undefined);
            listContainer.addChild(list);
          };
          input.onSubmit = () => {
            const item = list?.getSelectedItem();
            if (item) done(item.value);
          };
          input.onEscape = () => done(undefined);
          rebuildList();
          const container = new Container();
          const body = new Container();
          body.addChild(input);
          body.addChild(listContainer);
          populateMenuFrame(
            container,
            theme,
            "Model",
            body,
            "Type to filter · ↑↓ navigate · Enter select · Esc back",
          );
          return {
            get focused() {
              return input.focused;
            },
            set focused(value: boolean) {
              input.focused = value;
            },
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (keybindings.matches(data, "tui.select.up")) {
                const selected = list?.getSelectedItem();
                if (selected && list) {
                  const index = filtered.findIndex(
                    (item) => item.value === selected.value,
                  );
                  list.setSelectedIndex(
                    index <= 0 ? filtered.length - 1 : index - 1,
                  );
                }
                tui.requestRender();
                return;
              }
              if (keybindings.matches(data, "tui.select.down")) {
                const selected = list?.getSelectedItem();
                if (selected && list) {
                  const index = filtered.findIndex(
                    (item) => item.value === selected.value,
                  );
                  list.setSelectedIndex(
                    index < 0 || index === filtered.length - 1 ? 0 : index + 1,
                  );
                }
                tui.requestRender();
                return;
              }
              if (keybindings.matches(data, "tui.select.confirm")) {
                const selected = list?.getSelectedItem();
                if (selected) done(selected.value);
                tui.requestRender();
                return;
              }
              if (keybindings.matches(data, "tui.select.cancel")) {
                done(undefined);
                tui.requestRender();
                return;
              }
              input.handleInput(data);
              const query = input.getValue();
              if (query !== previousQuery) {
                previousQuery = query;
                rebuildList();
              }
              tui.requestRender();
            },
          };
        },
      )) as string | undefined;
    };
    const presentStopSummary = (summary: string): void => {
      pi.sendMessage(
        {
          customType: "pi-herdsman-stop-summary",
          content: `[Pi Herdsman] Stop all result:\n${summary}`,
          display: true,
          details: { summary },
        },
        { triggerTurn: false },
      );
    };
    let leadCommandRuntime: any;
    const leadCommandHost = {
      runHerdr,
      presentStopSummary,
      version: HERDSMAN_VERSION,
      selectMenu,
      selectModelMenu,
      readConfig,
      readEffectiveConfig,
      readProjectOverrides,
      updateProjectOverride,
      contextAgentDefinitions,
      discoverRoleDefinition,
      setLeadExecutionMode: (
        ctx: ExtensionCommandContext,
        mode: LeadExecutionMode,
      ) => leadRuntimes.setLeadExecutionMode(ctx, mode),
      leadExecutionPresentation: () => leadRuntimes.leadExecutionPresentation(),
      agentDefinitionEnabled,
      agentDefinitionMetadata,
      expandAgentBodyFiles,
      appendDefinitionsEntry: (data: any) =>
        pi.appendEntry(AGENT_DEFINITIONS_ENTRY, data),
      formatAgentDefinitions,
      validThinkingLevels: VALID_THINKING_LEVELS,
      updateAgentOverride,
      isSpawnPlacement,
      placementSettings,
      messageLimits,
      formatMessageLimit,
      validByteLimit,
      input: (ctx: ExtensionCommandContext, label: string) =>
        ctx.ui.input(label),
      updateSpawnPlacement: (placement: string) =>
        updateConfig("spawnPlacement", placement as SpawnPlacement),
      updateMessageLimit: (key: string, value: number | undefined) =>
        updateConfig(key as any, value),
      updateConfig: (key: string, value: unknown) =>
        updateConfig(key as any, value as any),
      collectOwnedSessionUsage,
      formatSessionUsage,
    };
    if (controllerScope.kind === "root") {
      pi.registerCommand("lead", {
        description: "Choose the ordinary Lead execution profile",
        getArgumentCompletions: (prefix: string) =>
          (["flexible", "orchestrate"] as const)
            .filter((value) => value.startsWith(prefix.trim()))
            .map((value) => ({ value, label: value })),
        handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
          await leadCommandRuntime.runLeadExecutionCommand(rawArgs, ctx);
        },
      });
      if (process.env.HERDR_PANE_ID)
        pi.registerCommand("manager", {
          description:
            "Activate Manager mode, open its overview, remove a worktree, or forget a legacy assignment",
          getArgumentCompletions: (prefix: string) => {
            const input = prefix.trimStart();
            const [command, branchPrefix] = input.split(/\s+/u);
            if (!command)
              return ["leave", "remove", "forget", "remove-preapproval"].map(
                (value) => ({
                  value,
                  label: value,
                }),
              );
            if (command === "remove-preapproval")
              return input.trim().split(/\s+/u).length === 2
                ? ["on", "off"]
                    .filter((value) => value.startsWith(branchPrefix ?? ""))
                    .map((value) => ({
                      value: `remove-preapproval ${value}`,
                      label: value,
                    }))
                : null;
            if (command !== "remove" && command !== "forget")
              return input.includes(" ")
                ? null
                : ["leave", "remove", "forget", "remove-preapproval"]
                    .filter((value) => value.startsWith(command))
                    .map((value) => ({ value, label: value }));
            if (input === "remove") return [];
            if (input.trim().split(/\s+/u).length > 2) return null;
            const lease = leadRuntime.managerLease;
            if (!lease) return [];
            try {
              return listProjectAssignments(
                supervisionRuntime(),
                lease.descriptor.repoKey,
              )
                .map(({ branch }) => branch)
                .filter((branch) => branch.startsWith(branchPrefix ?? ""))
                .map((branch) => ({
                  value: `${command} ${branch}`,
                  label: branch,
                }));
            } catch {
              return [];
            }
          },
          handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
            const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
            if (args[0] === "remove-preapproval") {
              if (args.length === 1) {
                const policy =
                  await projectRuntime.getRemovalPreauthorization(ctx);
                ctx.ui.notify(
                  `Worktree removal confirmation: ${policy.enabled ? "skipped" : "required"} for ${policy.repoKey}.`,
                  "info",
                );
                return;
              }
              if (args.length !== 2 || !["on", "off"].includes(args[1]!)) {
                ctx.ui.notify(
                  "Usage: /manager remove-preapproval <on|off>",
                  "error",
                );
                return;
              }
              const enabled = args[1] === "on";
              const stored = await projectRuntime.setRemovalPreauthorization(
                enabled,
                ctx,
              );
              ctx.ui.notify(
                `Skip worktree removal confirmation for ${enabled ? "this repository is On" : "this repository is Off"}${stored ? "." : "; setting unchanged."}`,
                stored ? "info" : "warning",
              );
              return;
            }
            if (args[0] === "remove") {
              if (args.length === 1) {
                const pending = projectRuntime.listPendingRemovals(ctx);
                if (!pending.length) {
                  ctx.ui.notify(
                    "There are no pending worktree removals.",
                    "info",
                  );
                  return;
                }
                const selected = await selectMenu(
                  ctx,
                  "Review pending worktree removal",
                  pending.map(({ branch, checkoutPath }) => ({
                    value: branch,
                    label: `${branch} · ${checkoutPath}`,
                  })),
                );
                if (!selected) return;
                const request = pending.find(
                  (item) => item.branch === selected,
                );
                if (!request) throw new Error("Pending removal is unavailable");
                const action = await selectMenu(
                  ctx,
                  `Pending removal · ${selected}`,
                  [
                    { value: "approve", label: "Approve removal…" },
                    { value: "dismiss", label: "Dismiss request" },
                  ],
                );
                if (!action) return;
                if (action === "dismiss") {
                  if (!projectRuntime.cancelPendingRemoval(request, ctx))
                    throw new Error(
                      "Pending removal changed; review the new request",
                    );
                  ctx.ui.notify(
                    `Pending removal of ${request.branch} dismissed.`,
                    "info",
                  );
                  return;
                }
                const result = await projectRuntime.approvePendingRemoval(
                  request,
                  ctx,
                );
                ctx.ui.notify(
                  result.content[0]?.text ?? "Removal finished.",
                  result.details.ok || result.details.cancelled
                    ? "info"
                    : "warning",
                );
                return;
              }
              if (args.length !== 2) {
                ctx.ui.notify("Usage: /manager remove <branch>", "error");
                return;
              }
              const result = await projectRuntime.removeWorktree(args[1]!, ctx);
              ctx.ui.notify(
                result.content[0]?.text ?? `Removal of ${args[1]} finished.`,
                result.details.ok || result.details.cancelled
                  ? "info"
                  : "warning",
              );
              return;
            }
            if (args[0] === "forget") {
              if (args.length !== 2) {
                ctx.ui.notify("Usage: /manager forget <branch>", "error");
                return;
              }
              const result = await projectRuntime.forgetLegacyProjectAssignment(
                args[1]!,
                ctx,
              );
              ctx.ui.notify(
                result.content[0]?.text ?? `Forget of ${args[1]} finished.`,
                result.details.ok || result.details.cancelled
                  ? "info"
                  : "warning",
              );
              return;
            }
            await leadCommandRuntime.runRoleCommand("manager", rawArgs, ctx);
          },
        });
      if (process.env.HERDR_PANE_ID)
        pi.registerCommand("chief", {
          description:
            "Activate chief mode, or open its overview when already active",
          getArgumentCompletions: (prefix: string) =>
            ["leave"]
              .filter((value) => value.startsWith(prefix.trim()))
              .map((value) => ({ value, label: value })),
          handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
            await leadCommandRuntime.runRoleCommand("chief", rawArgs, ctx);
          },
        });
      supervisorTool = {
        name: "message_supervisor",
        label: "message supervisor",
        exposure: "model-only",
        promptSnippet:
          "Send nonblocking material coordination to your direct supervisor",
        description:
          "Send a nonblocking question, clarification, warning, risk, decision, scope change, or evidence only when it is material or needed by your direct supervisor. Avoid unsolicited routine progress updates and duplicate result announcements.",
        executionMode: "sequential",
        parameters: supervisorMessageParameters,
        execute: (...args: any[]) =>
          leadRuntimes.coordinationRuntime!.supervisorMessage(...args),
        renderCall: (args: unknown, theme: any, context: any) =>
          renderCoordinationCall("supervisor", "message", args, theme, context),
        renderResult: (result: any, options: any, theme: any, context: any) =>
          renderCoordinationResult(
            "supervisor",
            "message",
            result,
            options,
            theme,
            context,
          ),
      };
      peerTool = {
        name: "message_peer",
        label: "message peer",
        exposure: "model-only",
        promptSnippet:
          "Discover same-role peers, including remote ordinary Leads, and reply through existing correspondences",
        description:
          "Send task-relevant communication needed by another eligible coordinator, not routine broadcasts or gratuitous acknowledgments. Send to an eligible same-role Lead or Manager by exact session ID. Ordinary Leads and Managers may discover eligible same-role peers on reachable saved Herdr machines; remote Leads must be ordinary and unassigned. An existing return correspondence may allow a reply-only target without independent discovery or current availability. Use only the exact session from list_peers; optional name/workspace labels are advisory display context.",
        executionMode: "sequential",
        parameters: peerMessageParameters,
        execute: (...args: any[]) =>
          leadRuntimes.coordinationRuntime!.peerMessage(...args),
        renderCall: (args: unknown, theme: any, context: any) =>
          renderCoordinationCall("peer", "message", args, theme, context),
        renderResult: (result: any, options: any, theme: any, context: any) =>
          renderCoordinationResult("peer", "message", result, options, theme, {
            ...context,
            activeRole: activeRole(),
          }),
      };
      const staffTool = {
        name: "message_staff",
        label: "message staff",
        defaultActive: false,
        exposure: "model-only",
        promptSnippet:
          "Supervise direct reports; Managers may delegate new linked-worktree Leads",
        executionMode: "sequential",
        parameters: staffMessageParameters,
        execute: (...args: any[]) => projectRuntime.executeStaff(...args),
        renderCall: (args: unknown, theme: any, context: any) =>
          renderCoordinationCall("staff", "message", args, theme, context),
        renderResult: (result: any, options: any, theme: any, context: any) =>
          renderCoordinationResult(
            "staff",
            "message",
            result,
            options,
            theme,
            context,
          ),
      };
      {
        pi.registerTool({
          ...staffTool,
          name: "list_staff",
          label: "list staff",
          description:
            "Fetch current direct-report supervision state when a fresh roster or diagnosis is needed; not for progress polling.",
          parameters: emptyParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            _p: unknown,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) => staffTool.execute(id, { action: "list" }, signal, update, ctx),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "list", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "list", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "inspect_staff",
          label: "inspect staff",
          description:
            "Read bounded live terminal/process evidence for a direct report.",
          parameters: staffTargetParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "inspect", session: p.session },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "inspect", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "inspect", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "read_staff_transcript",
          label: "read staff transcript",
          description:
            "Read bounded persisted Pi conversation/tool evidence for a direct report.",
          parameters: staffTargetParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "transcript", session: p.session },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "transcript", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "transcript", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "message_staff",
          label: "message staff",
          description:
            "Send nonterminal coordination or review feedback to an exact direct report; active work is steered cooperatively. Result refs mentioned only in report text are not automatically transferable evidence. Attach refs only when available; otherwise request follow-up from the direct report in message text.",
          parameters: staffMessageParameters,
          promptSnippet: undefined,
          promptGuidelines: [FILE_HANDOFF_GUIDANCE],
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "message", ...p },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "message", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "message", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "delegate_project",
          label: "delegate project",
          description:
            "Start new project work, reusing an unoccupied Herdr worktree when available. The initial task and supplied files become required project evidence; use resume_project for existing work.",
          parameters: staffDelegateParameters,
          promptSnippet: undefined,
          promptGuidelines: [FILE_HANDOFF_GUIDANCE],
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "delegate", ...p },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "delegate", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "delegate", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "resume_project",
          label: "resume project",
          description:
            "Reuse an already-running Lead for the exact branch; otherwise resume its existing assignment without creating a duplicate.",
          parameters: staffBranchParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "resume", branch: p.branch },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "resume", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "resume", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "remove_worktree",
          label: "remove worktree",
          description:
            "Remove an explicitly requested assigned project's linked worktree. After authorization, automatically stop any running assigned Lead and its owned Agents before removal; no separate stop call is needed. The Git branch and Pi conversation are preserved. Pending human approval performs no cleanup. When project preauthorization is enabled, execute the guarded removal. Otherwise create an actionable human approval request and return promptly. Do not repeat or poll a pending request.",
          parameters: staffBranchParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "remove", branch: p.branch },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "remove", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "remove", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "merge_project",
          label: "merge project",
          description:
            "Integrate an assigned local branch into the verified primary branch using fast-forward-only Git. Supply the exact full source SHA accepted after validation. This may stop running managed execution before integration. If a later step fails after execution stops, it is not automatically restarted. Verified integration triggers guarded cleanup, but integration and cleanup can complete separately; do not treat integration alone as full finalization.",
          parameters: Type.Object(
            {
              branch: Type.String({
                description: "Exact assigned local branch",
              }),
              expected_head: Type.String({
                description: "Exact full SHA of the accepted source commit",
              }),
            },
            { additionalProperties: false },
          ),
          promptSnippet: undefined,
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              {
                action: "merge",
                branch: p.branch,
                expected_head: p.expected_head,
              },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "merge", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "merge", r, o, t, c),
        });
        pi.registerTool({
          ...staffTool,
          name: "stop_lead",
          label: "stop lead",
          description:
            "Stop an exact direct Lead and its owned execution tree while preserving project work, Pi session, branch, and worktree.",
          parameters: staffTargetParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            staffTool.execute(
              id,
              { action: "stop", session: p.session },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("staff", "stop", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("staff", "stop", r, o, t, c),
        });
      }
      const herdsmanCommand = {
        description: "Open Pi Herdsman",
        getArgumentCompletions: (argumentPrefix: string) => {
          const commands = ["stats", "definitions", "placement", "stop"];
          const trimmed = argumentPrefix.trimStart();
          if (!trimmed || !trimmed.includes(" "))
            return commands
              .filter((command) => command.startsWith(trimmed))
              .map((value) => ({ value, label: value }));
          const parts = trimmed.trim().split(/\s+/u);
          if (parts[0] !== "placement" || parts.length > 2) return null;
          const prefix = parts[1] ?? "";
          return ["tab", "subtree", "split"]
            .filter((value) => value.startsWith(prefix))
            .map((value) => ({ value: `placement ${value}`, label: value }));
        },
        handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
          await leadCommandRuntime.runHerdsmanCommand(rawArgs, ctx);
        },
      };
      pi.registerCommand("herdsman", herdsmanCommand);
      pi.registerCommand("agents", {
        ...herdsmanCommand,
        description: "Alias for /herdsman",
      });
    }
    if (processRole === "lead") {
      const shutdownOptions = {
        clearStartupDefinitionRoster: () => {
          startupDefinitionRoster = undefined;
        },
        isLead: () => activeRole() === "lead" && !leadRuntime.roleSuspended,
      };
      const sessionTreeOptions = {
        isLead: () => activeRole() === "lead" && !leadRuntime.roleSuspended,
        appendRoleError: (ctx: ExtensionContext, error: unknown) =>
          appendDurableError(pi, ctx, "pi_herdsman_role_error", error),
      };
      const sessionStartOptions = {
        autoActivateManager: (ctx: ExtensionContext) =>
          readEffectiveConfig(ctx).autoActivateManager,
        clearDefinitionRoster: () => {
          startupDefinitionRoster = undefined;
        },
        setDefinitionRoster: (roster: typeof startupDefinitionRoster) => {
          startupDefinitionRoster = roster;
        },
        isLead: () => activeRole() === "lead" && !leadRuntime.roleSuspended,
        isManagedAgent: () => controllerScope.kind === "managed-agent",
        sessionLeadRoleState,
        normalizeLeadTools,
        activeTools: () => pi.getActiveTools(),
        setLeadTools: (tools: string[]) => leadToolState.setLeadTools(tools),
        ownedTools,
        failClosedRole,
        appendRoleError: (ctx: ExtensionContext, error: unknown) =>
          appendDurableError(pi, ctx, "pi_herdsman_role_error", error),
        activateChief,
        publishLeadRole,
        enterSuspended,
        enterLead,
        schedulePeerPresence,
        queueLeadPresentation,
        setOwnTools: (tools: string[] | undefined) => {
          ownTools = tools;
        },
        initialStatusBreadcrumb: () => initialStatusBreadcrumb,
        ownToolsSnapshot,
        visibleAgentCapabilities: async (
          ctx: ExtensionContext,
          definitions?: AgentDefinition[],
          rootPolicy?: RootDelegationPolicy,
        ) =>
          visibleAgentCapabilities(
            definitions ?? (await contextAgentDefinitions(ctx)).definitions,
            controllerScope,
            rootPolicy ?? (controllerScope.kind === "root" ? new Set() : "all"),
          ),
        appendDefinitionError: (ctx: ExtensionContext, error: unknown) =>
          appendDurableError(pi, ctx, "pi_herdsman_definition_error", error),
      };
      leadRuntimes = registerLeadRuntime(pi, {
        leadRuntime,
        leadToolState,
        ownedToolNames,
        leadCoordinationToolNames: LEAD_COORDINATION_TOOLS,
        onLeadRuntimeReady: (
          runtime: LeadRuntimeState,
          tools: typeof leadToolState,
        ) => {
          leadRuntime = runtime;
          leadToolState = tools;
        },
        controllerServices,
        identityHost: {
          listAgents: (ctx: ExtensionContext) =>
            listAllHerdrAgents(pi, ctx, ctx.signal),
          isPiAgent,
          expectedSession,
          matchesExpectedSession,
          getAgent: (ctx: ExtensionContext, paneId: string) =>
            runHerdr(pi, ctx, ["agent", "get", paneId], { signal: ctx.signal }),
          hasLeadCoordination: (sessionId: string) =>
            !!readLeadCoordinationState(supervisionRuntime(), sessionId),
        },
        roleTransitionHost,
        coordinationHost: {
          supervisionRuntime,
          writeLeadCoordinationState,
          appendDurableError,
          peerRuntime,
          listPeerLeadRecords,
          removePeerLeadRecord,
          acquireProcessLock,
          peerLeadLockPath,
          worktreeGroupScope,
          workspacePresentationProvenance,
          basename,
          readPeerLeadRecord,
          samePeerLeadRecord,
          writePeerLeadRecord,
          invalidateLeadCoordinationState,
          runHerdr,
          resolveMessageFiles: controllerResolveMessageFiles,
          messageLimits,
          chiefMessageBytes,
          coordinationMessageMaxBytes: COORDINATION_MESSAGE_MAX_BYTES,
          buildSessionProjection,
          contentText,
          supervisorStateType: SUPERVISOR_STATE_TYPE,
          sameManagerDescriptor,
          requireCompatibleBuild,
          sameRuntimeBuild,
          samePeerLeadGeneration,
          writeCoordinationMessage,
          removeChiefMessage,
          quarantineChiefMessage,
          readLeadCoordinationState,
          matchesExpectedSession,
          isPiAgent,
          writeChiefMessage,
          listProjectAssignments,
          listProjectMessageHeaders,
          readProjectMessage,
          listProjectMessages,
          removeProjectMessage:
            lockHooks?.removeProjectMessage ?? removeProjectMessage,
          readProjectAssignment,
          importResultBindings,
        },
        build: HERDSMAN_BUILD,
        projectHost,
        commandHost: leadCommandHost,
        supervisionHost,
        herdRunEntryName: HERD_RUN_ENTRY,
        herdRunServices: {
          appendDurableError,
        },
        statusSnapshotHost: {
          environmentIdentity: (ctx: ExtensionContext) =>
            managedAgentEnvironmentIdentity(ctx, HERDSMAN_BUILD),
          identityFromEnvironment: () => ({
            definition: process.env.PI_HERDSMAN_AGENT_DEFINITION,
            label: process.env.PI_HERDSMAN_LABEL,
          }),
          sameIdentity: sameManagedAgentIdentity,
          ownToolsSnapshot,
        },
        inboxHost: {
          supervisionRuntime,
          peerRuntime,
          appendDurableError,
          listManagerDescriptors,
          remoteChiefAgent,
          liveLead,
          readLeadCoordinationState,
          runHerdr,
          sameRuntimeBuild,
          worktreeGroupScope: (
            _pi: any,
            ctx: ExtensionContext,
            workspaceId: string,
            signal?: AbortSignal,
          ) => worktreeGroupScope(pi, ctx, workspaceId, signal),
          readProjectAssignment,
          importResultBindings,
          HERDSMAN_BUILD,
          formatRuntimeBuild,
          listChiefMessagePaths,
          chiefMessageQuarantined,
          drainCoordinationInbox,
          basename,
        },
        agentEventOptions: leadAgentEventOptions,
        sessionStartOptions,
        sessionTreeOptions,
        shutdownOptions,
        hasPane: () => !!process.env.HERDR_PANE_ID,
        sessionName: () => pi.getSessionName(),
        queueLeadPresentation,
      });
      roleTransitions = leadRuntimes.roleTransitions;
      leadCommandRuntime = leadRuntimes.commandRuntime;
      leadStatusRuntime = leadRuntimes.statusRuntime;
      projectRuntime = leadRuntimes.projectRuntime!;
      leadHerdRunRuntime = leadRuntimes.herdRunRuntime!;
      leadRuntimes.controller!.registerTools(
        controllerScope.kind === "root" ? leadHerdRunRuntime.begin : undefined,
      );
      if (controllerScope.kind === "root") {
        pi.registerTool({
          ...supervisorTool,
          name: "message_supervisor",
          parameters: supervisorMessageParameters,
          promptSnippet: undefined,
          promptGuidelines: [FILE_HANDOFF_GUIDANCE],
          execute: async (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) => {
            try {
              return await supervisorTool.execute(id, p, signal, update, ctx);
            } catch (error) {
              if (!(error instanceof OperationError)) throw error;
              return {
                content: [{ type: "text", text: error.message }],
                isError: true,
                details: {
                  error: {
                    branchStatus: "operation_error_returned",
                    category: error.detail.category,
                  },
                },
              };
            }
          },
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("supervisor", "message", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("supervisor", "message", r, o, t, c),
        });
        pi.registerTool({
          ...peerTool,
          name: "list_peers",
          label: "list peers",
          description:
            "List independently discovered eligible same-role peers, including eligible ordinary Leads or Managers on reachable saved Herdr machines. Remote Lead discovery requires verified ordinary, unassigned status; incomplete discovery is not proof that no peers exist. A reply-only originating Lead or Manager may also appear when an existing return correspondence allows a reply without independent discovery or current availability. Use only the exact session as a target; labels do not verify identity, availability, or permission to initiate unrelated messages. Do not use for progress polling.",
          parameters: emptyParameters,
          promptSnippet: undefined,
          execute: (
            id: string,
            _p: unknown,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) => peerTool.execute(id, { action: "list" }, signal, update, ctx),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("peer", "list", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("peer", "list", r, o, t, {
              ...c,
              activeRole: activeRole(),
            }),
        });
        pi.registerTool({
          ...peerTool,
          name: "message_peer",
          parameters: peerMessageParameters,
          promptSnippet: undefined,
          promptGuidelines: [FILE_HANDOFF_GUIDANCE],
          execute: (
            id: string,
            p: any,
            signal: AbortSignal | undefined,
            update: unknown,
            ctx: ExtensionContext,
          ) =>
            peerTool.execute(
              id,
              { action: "message", lead: p.session, ...p },
              signal,
              update,
              ctx,
            ),
          renderCall: (a: unknown, t: any, c: any) =>
            renderCoordinationCall("peer", "message", a, t, c),
          renderResult: (r: any, o: any, t: any, c: any) =>
            renderCoordinationResult("peer", "message", r, o, t, {
              ...c,
              activeRole: activeRole(),
            }),
        });
      }
    }
  }
  if (processRole !== "managed-agent") return;
  pi.registerTool({
    name: "read_evidence",
    label: "Read accepted evidence",
    exposure: "model-only",
    description:
      "Read a bounded page from evidence accepted by this managed Agent.",
    parameters: Type.Object(
      {
        ref: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        byteOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    execute: async (
      _id: string,
      params: any,
      _signal: AbortSignal | undefined,
      _update: unknown,
      ctx: ExtensionContext,
    ) => {
      try {
        const accepted = managedAgentRequiredEvidence(ctx);
        if (!accepted) throw new Error();
        const page = readEvidencePage(
          accepted.effectiveEvidence,
          params.ref,
          params,
        );
        return {
          content: [{ type: "text", text: evidencePageContent(page) }],
          details: page,
        };
      } catch {
        throw new Error("Evidence reference unavailable or invalid");
      }
    },
  });
  registerManagedAgentRuntime(pi, {
    build: HERDSMAN_BUILD,
    shellTimeoutSeconds: STALE_AFTER_MS / 1000,
    statusRuntime: leadStatusRuntime!,
    controllerOptions: { ...controllerServices, onWorkChanged: () => {} },
    activityWriteMinMs: ACTIVITY_WRITE_MIN_MS,
    resultWriteMaxAttempts: RESULT_WRITE_MAX_ATTEMPTS,
    tryClaimAssignmentLock,
    claimAssignmentLock,
    messageLimits,
    resolveMessageFiles: controllerResolveMessageFiles,
    getAgentDefinitions: async (ctx) =>
      (await contextAgentDefinitions(ctx)).definitions,
    appendError: (ctx, kind, error) => appendDurableError(pi, ctx, kind, error),
  });
}
