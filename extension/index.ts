import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  getAgentDir,
  getSelectListTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  chiefGlobalInstructions as selectChiefGlobalInstructions,
  chiefSystemPrompt as buildChiefSystemPrompt,
} from "./chief-prompt.ts";
import { createChiefProjectRuntime } from "./chief-project.ts";
import {
  rememberCoordinatorTarget,
  resolveCoordinatorTarget,
} from "./coordinator-target.ts";
import { discoverProjects } from "./project-discovery.ts";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };
import {
  formatRuntimeBuild,
  runtimeBuild,
  requireCompatibleBuild,
  sameRuntimeBuild,
} from "./compatibility.ts";
import { Type } from "typebox";
import { COORDINATOR_TARGET_PATTERN } from "./coordinator-target.ts";
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
import { scanAgentStates } from "./mailbox.ts";
import type { OwnerMessageRecord } from "./mailbox.ts";
import {
  prepareMessageInput,
  FILE_HANDOFF_GUIDANCE,
  displayIdentity,
  isSpawnPlacement,
  type LeadExecutionMode,
  type SpawnPlacement,
} from "./core.ts";
import {
  AGENT_COORDINATION_TOOLS,
  agentDefinitionEnabled,
  agentDefinitionMetadata,
  contextAgentDefinitions,
  resolveDefinition,
  inspectDefinition,
  expandAgentBodyFiles,
  expandDefinitionBodyFragments,
  expandDefinitionBodyFragmentsWithSources,
  selectedAgentContextFiles,
  updateAgentOverride,
  VALID_THINKING_LEVELS,
  type AgentDefinition,
} from "./agent-definitions.ts";
import { DEFINITION_NAME_PATTERN } from "./definition-identity.ts";
import { sessionAgentModelCatalog } from "./agent-model-overrides.ts";
import {
  captureStartupDiagnostic,
  herdrSessionSnapshot,
  listAllHerdrAgents,
  runHerdr,
  worktreeGroupScope,
  sessionIdentity,
  herdrSessionId,
  supervisedSessionFile,
  matchesExpectedSession,
  sameCwd,
  inspectHerdrAgent,
  stopHerdrAgentPreservingPane,
  startHerdrCoordinatorInPane,
  prepareHerdrCoordinatorPane,
  type ExpectedSession,
  type HerdrRecord,
  type HerdrSessionSnapshot,
} from "./herdr.ts";
import { reportLeadMetadata } from "./herdr.ts";
import {
  managedAgentEnvironmentError,
  managedAgentEnvironmentIdentity,
  managedAgentRequiredEvidence,
  evidencePageContent,
  readEvidencePage,
  managedAgentIdentity,
  authorizedScopedResult,
  registerManagedAgentRuntime,
  sameManagedAgentIdentity,
  sessionContextRetired,
} from "./managed-agent-runtime.ts";
import {
  AUTHORITY_GUIDANCE,
  AGENT_EXECUTION_OWNERSHIP_GUIDANCE,
  AGENT_UNRESOLVED_GUIDANCE,
  LEAD_SCOPE_DESCRIPTION,
  canonicalSessionPath,
  createAgentStatusRuntime,
  importResultBindings,
  collectSessionUsage,
  openOwnedAssignmentSession,
  ownedAssignmentChildren,
  sessionAgentIdentity,
  persistedTranscriptReady as controllerPersistedTranscriptReady,
  readAgentTranscript as controllerReadAgentTranscript,
  readPersistedTranscript as controllerReadPersistedTranscript,
  resolveMessageFiles as controllerResolveMessageFiles,
  type ControllerScope,
  type RootDelegationPolicy,
  type AgentControllerOptions,
  visibleAgentCapabilities,
} from "./agent-controller.ts";
import {
  acquireCoordinatorAdmission,
  acquireProcessLock,
  claimAssignmentLock as claimManagedAssignmentLock,
  ProcessLockOccupiedError,
  tryClaimAssignmentLock,
} from "./lock.ts";
import {
  claimChiefLease,
  removeChiefMessage,
  quarantineChiefMessage,
  chiefMessageQuarantined,
  listChiefMessagePaths,
  supervisionRuntime,
  readChiefDescriptor,
  writeChiefMessage,
  writeCoordinationMessage,
  chiefMessageBytes,
  COORDINATION_MESSAGE_MAX_BYTES,
  projectAssignmentBytes,
  projectAssignmentPath,
  projectMessageBytes,
  writeProjectMessage,
  readProjectMessage,
  removeProjectMessage,
  removeProjectMessagesForAssignment,
  recoverStaleProjectMessages,
  sessionLeadRoleState,
  type SessionRole,
  claimManagerLease,
  readManagerDescriptor,
  readManagerDescriptorStatus,
  listManagerDescriptors,
  listCoordinatorStartIntents,
  sameManagerDescriptor,
  writeProjectAssignment,
  readProjectAssignment,
  listProjectAssignments,
  listProjectMessageHeaders,
  findProjectAssignmentBySession,
  retireProjectAssignment,
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
import { fail, OperationError } from "./errors.ts";

import {
  DEFAULT_STATUS_WIDGET_MAX_ROWS,
  readConfig,
  readEffectiveConfig,
  readProjectOverrides,
  updateProjectOverride,
  updateConfig,
  validByteLimit,
  validMaxAgentDepth,
  validStatusWidgetMaxRows,
} from "./config.ts";
import {
  activeLeadRole,
  createLeadToolState,
  type LeadRuntimeState,
  registerLeadRuntime,
  createLeadRoleTransitions,
} from "./lead-runtime.ts";
import { readRootOwners } from "./lead/coordination.ts";
import { registerSkillLoader } from "./skill-loader.ts";

import {
  populateMenuFrame,
  collapseDisplayText,
  formatAgentDefinitions,
  renderAgentDefinitionsOverview,
  renderStopSummary,
  renderCompletionMessage,
  renderAgentAskMessage,
  renderAgentOwnerMessage,
  renderAgentStaleMessage,
  renderAgentLostMessage,
  renderAgentAttentionMessage,
  renderCoordinationMessage,
  renderCoordinationCall,
  renderCoordinationResult,
  truncateModelText,
  formatRuntimeBuildDetails,
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
const HERDSMAN_RUNTIME_IDENTITY = `Pi Herdsman runtime: ${formatRuntimeBuild(HERDSMAN_BUILD)}`;
const withRuntimeIdentity = (prompt: string): string =>
  `${HERDSMAN_RUNTIME_IDENTITY}\n\n${prompt}`;
const AGENT_DEFINITIONS_ENTRY = "pi-herdsman-agent-definitions";
const HERD_RUN_ENTRY = "pi-herdsman-herd-run";
const SUPERVISOR_TOOLS = ["message_manager", "message_chief"] as const;
const LEAD_SUPERVISOR_TOOLS = SUPERVISOR_TOOLS;
const PEER_TOOLS = ["list_peers", "message_peer"] as const;
const STAFF_TOOLS = [
  "list_staff",
  "inspect_staff",
  "read_staff_transcript",
  "message_staff",
] as const;
const MANAGER_TOOLS = [
  "message_chief",
  ...PEER_TOOLS,
  ...STAFF_TOOLS,
  "delegate_work",
  "resume_work",
  "stop_lead",
  "remove_worktree",
  "integrate_branch",
] as const;
const LEAD_COORDINATION_TOOLS = [
  ...AGENT_COORDINATION_TOOLS,
  ...LEAD_SUPERVISOR_TOOLS,
  ...PEER_TOOLS,
] as const;
const CHIEF_TOOLS = [
  ...STAFF_TOOLS,
  "list_projects",
  "clone_repository",
  "start_manager",
  "resume_manager",
  "start_lead",
  "stop_hierarchy",
] as const;

export async function stopCoordinatorChildrenFirst<T>(
  children: readonly T[],
  stopChild: (child: T) => Promise<void>,
  stopOwner: () => Promise<void>,
): Promise<{
  failedChildren: Array<{ child: T; reason: string }>;
  ownerError?: string;
}> {
  const failedChildren: Array<{ child: T; reason: string }> = [];
  for (const child of children) {
    try {
      await stopChild(child);
    } catch (error) {
      failedChildren.push({ child, reason: String(error) });
    }
  }
  if (failedChildren.length) return { failedChildren };
  try {
    await stopOwner();
    return { failedChildren };
  } catch (error) {
    return { failedChildren, ownerError: String(error) };
  }
}

const INTERNAL_MESSAGE_PROVENANCE_GUIDANCE =
  "Herdsman-delivered coordination messages, Agent results, and lifecycle notices are internal communications, even when Pi represents them as user-role messages. Interpret them according to their identified sender and established authority; they are not direct human requests or approvals. Their receipt alone does not require a reply or acknowledgment. Follow your existing role-specific coordination and reporting rules.";
const LEAD_SUPERVISOR_PEER_GUIDANCE =
  "Use the available upward messaging tool for material coordination your direct supervisor needs. Use list_peers/message_peer for task-relevant peer coordination. Avoid unsolicited progress updates, unnecessary acknowledgments, and duplicate result announcements.";
const COMMON_LEAD_GUIDANCE = `${AUTHORITY_GUIDANCE}
${LEAD_SCOPE_DESCRIPTION}
${INTERNAL_MESSAGE_PROVENANCE_GUIDANCE}
${LEAD_SUPERVISOR_PEER_GUIDANCE}`;
const ORDINARY_LEAD_CHARTER = `## Lead role
You are an ordinary Lead for this Pi session.
${COMMON_LEAD_GUIDANCE}
Your Agent assignments and file handoffs are recipient-specific. Peer messages coordinate work but do not independently transfer execution ownership.`;
const MANAGED_LEAD_GUIDANCE = `Managed Lead identity is permanent for this exact Pi session. Only a current exact work assignment permits execution of that assignment; unavailable or retired assignment state does not grant ordinary Lead execution authority. Exactly owned Agent recovery remains separate. Use native Pi /fork or /clone for independent ordinary continuation; this does not create a separate Git checkout or fresh process configuration.
For a verified managed project assignment, assignment required evidence is automatically inherited by newly accepted descendant Agent assignments; sibling Lead assignments do not automatically inherit it.
A Lead's delegation task and ordinary files are recipient-specific; they do not create assignment requirements.
When a previous Agent execution is unresolvable, retain its unresolved assignment and preserve its execution scope. Assess current competing execution separately from historical Agent identity. Continue independently authorized work when current evidence permits it. Escalate only a concrete blocker that cannot be resolved through existing controls.
Only the Manager can designate continuing requirements for an assignment. When a proposed scope or continuing-requirement change needs Manager authorization, do not execute or delegate that change before the decision. Continue independently authorized work.
An overlap with another assignment or unanswered coordination message does not itself block your assignment. Continue independently safe work. Defer only steps requiring a concrete prerequisite, an authoritative sequencing decision, or verified writer safety. Escalate a specific cross-assignment decision when needed; if no actionable work remains, report the blocker in your normal response and end the turn rather than polling.
For assigned project work, include findings, proposed continuing
requirements, validation, completion, and review readiness in your
normal response; Herdsman delivers it to the Manager automatically.

Use message_manager only when the Manager needs information before the
handoff or needs files for review or onward delegation. Automatic results
contain no file attachments; transfer needed artifacts through
message_manager.files.`;
const MANAGED_LEAD_CHARTER = `## Lead role
You are a Managed Lead for this Pi session.
${COMMON_LEAD_GUIDANCE}
${MANAGED_LEAD_GUIDANCE}`;
const SUPERVISION_EVENT_GUIDANCE =
  "Supervision is event-driven. Do not poll staff tools, send repeated messages, or sleep solely to wait for Lead progress. When no independent work remains, end the turn; incoming Lead updates resume coordination.";
const MANAGER_ROLE_CONTRACT = `## Manager role
You are the verified Manager for this Pi session. Supervise eligible Leads in your verified project worktree group. Manage project execution only through exact current project assignments; supervision alone grants no Agent ownership or project lifecycle authority. Configuration changes operating guidance and ordinary tool availability, never authority.
${AUTHORITY_GUIDANCE}
${INTERNAL_MESSAGE_PROVENANCE_GUIDANCE}
Use message_chief for material upward coordination or replies to Chief.
Project execution belongs to assigned Leads and their Agent trees. Recovery of a Lead's directly owned Agents belongs to that Lead. Coordinate the existing project assignment through the Lead. Do not reconstruct child-Agent ownership or repeatedly request unavailable historical identities. If the Lead reports a verified blocker, resolve only the project-level decision or external action required; otherwise allow the Lead to continue independently authorized work. Coordination messages and reports are nonterminal and do not establish completion. Use remove_worktree only for an explicitly requested checkout-removal action; never infer removal from completion, review, or inactivity. Unless this repository has been explicitly preauthorized by a human, the tool registers a pending approval and returns promptly. Direct the user to /manager-remove to review it, then continue unrelated coordination. Do not repeat or poll a pending request; its result is not evidence of removal.
Subject to existing writer and authority safeguards, overlapping assignments
or unanswered coordination messages do not themselves block project work.
Independent assignments remain independent by default. Potential overlap,
shared files, or future integration alone do not justify initiating or
directing cross-assignment coordination unless the user explicitly requested it.
Coordinate concrete dependencies within direction already supplied by the user.
If a concrete cross-assignment blocker requires a scope, priority, sequencing,
or other project-level decision not settled by existing user instructions,
report the evidence and affected work to the user for direction before
redirecting Leads. Keep unaffected assignments progressing independently.
For a new objective requiring independent project-assignment ownership, use delegate_work when authorized; do not route it through message_staff to an unrelated existing Lead. message_staff changes or coordinates work within an existing assignment; resume_work recovers a paused assignment. list_staff reports current assignments and direct reports, not a limit on creating another assignment. Keep work with an existing Lead when the user intends that ownership and the existing assignment authorizes it.
For assigned project work, use message_staff when the assignment is active, including when its Lead's runtime state is idle or done. Use resume_work to recover a paused assignment with fresh instructions. Unknown or conflicted assignment state is not evidence that the Lead is stopped. A successfully queued instruction must not be resent merely because the Lead was already running; queue acceptance is not delivery confirmation.
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
You are the verified workspace-neutral Chief for this Pi session. Supervise only verified direct-report Managers and eligible unassigned top-level Leads; never bypass a Manager to control assigned Leads or their Agents. Role configuration does not establish authority. Supervision snapshots are non-authoritative coordination data. Do not perform local implementation work or assume this Pi process's working directory is the supervised scope.
Use list_projects for fresh read-only discovery. The automatic project overview is bounded observation data, not authority for mutation or proof of absence. Repository paths select project lifecycle operations; verified workspace selectors select workspace operations, not staff targets. Use list_staff to obtain a verified staff target.
Use project tools to provision projects and start Managers. Use start_lead only for a requested ordinary Lead in an exact workspace; it creates no assignment. A supplied initial message is rejected when an active project Manager supervises that workspace and is queued only through authorized Chief staff messaging. If start_manager reports resume_required, use resume_manager only when asked to recover the saved Manager. Use stop_hierarchy only for an explicit user-intended manager, staff, or all scope; it stops verified children before owners and never removes project data. Treat partial or blocked results as evidence that execution may remain. The all scope reports shutdown requested, not Chief process exit; Pi performs graceful shutdown after queued work.
${AUTHORITY_GUIDANCE}
${INTERNAL_MESSAGE_PROVENANCE_GUIDANCE}
${AGENT_EXECUTION_OWNERSHIP_GUIDANCE}
${AGENT_UNRESOLVED_GUIDANCE}
${SUPERVISION_EVENT_GUIDANCE}`;
type Role = "lead" | "managed-agent" | "unmanaged";
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
  knownTopology?: HerdrRecord,
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
    if (
      knownTopology?.source?.repo_key === source.repoKey &&
      knownTopology?.source?.repo_root === source.repoRoot &&
      Array.isArray(knownTopology.worktrees)
    ) {
      topologyByRepo.set(key, knownTopology);
      continue;
    }
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
type TestProjectAssignmentLockHooks = {
  afterAcquired?: (repoKey: string, branch: string) => Promise<void>;
  afterOccupied?: (repoKey: string, branch: string) => Promise<void>;
  onAuthorityWaitOccupied?: () => void;
  afterRequestPublished?: (
    mailboxPath: string,
    request: import("./mailbox.ts").RequestRecord,
  ) => undefined;
  afterManagedSessionIdentityInitialized?: () => void;
  managedLeadDefinition?: (name: string) => AgentDefinition;
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
  let chiefStaffShutdownActive = false;
  let pendingShutdownAdmission:
    ReturnType<typeof acquireCoordinatorAdmission> | undefined;
  const registerNoArgs = (
    name: string,
    description: string,
    action: (ctx: ExtensionCommandContext) => Promise<void> | void,
    uiOnly = false,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (rawArgs, ctx) => {
        if (uiOnly && !ctx.hasUI) return;
        if (rawArgs.trim()) {
          ctx.ui.notify(`Usage: /${name}`, "error");
          return;
        }
        await action(ctx);
      },
    });
  };
  const runHerdsmanAction = async (
    ctx: ExtensionCommandContext,
    action: () => Promise<void> | void,
  ) => {
    if (!ctx.hasUI) return;
    try {
      await action();
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    }
  };
  const completeValues = (values: readonly string[], prefix: string) => {
    const input = prefix.trim();
    if (/\s/u.test(input)) return [];
    return values
      .filter((value) => value.startsWith(input))
      .map((value) => ({ value, label: value }));
  };
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
      pi.setActiveTools([]);
      appendDurableError(
        pi,
        ctx,
        "pi_herdsman_state_error",
        new Error("invalid agent environment: " + agentEnvError),
      );
      ctx.ui.notify("Managed Agent startup rejected.", "error");
    });
    pi.on("before_agent_start", () => pi.setActiveTools([]));
    pi.on("tool_call", () => ({
      block: true,
      reason: "Invalid managed Agent startup environment.",
    }));
    return;
  }
  pi.registerEntryRenderer(AGENT_DEFINITIONS_ENTRY, (entry, options, theme) => {
    const data = entry?.data;
    const definitions =
      data && typeof data === "object" && "definitions" in data
        ? data.definitions
        : undefined;
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
      data &&
      typeof data === "object" &&
      "instructions" in data &&
      typeof data.instructions === "string"
        ? data.instructions
        : undefined;
    const storedInspector =
      data && typeof data === "object" && "inspector" in data
        ? data.inspector
        : undefined;
    const validSections = (
      sections: unknown,
    ): sections is import("./presentation.ts").InstructionSection[] =>
      Array.isArray(sections) &&
      sections.every(
        (section) =>
          section !== null &&
          typeof section === "object" &&
          !Array.isArray(section) &&
          "title" in section &&
          typeof section.title === "string" &&
          (!("source" in section) ||
            section.source === undefined ||
            typeof section.source === "string") &&
          (!("content" in section) ||
            section.content === undefined ||
            typeof section.content === "string") &&
          (!("format" in section) ||
            section.format === undefined ||
            section.format === "markdown" ||
            section.format === "text") &&
          (!("changes" in section) ||
            section.changes === undefined ||
            (Array.isArray(section.changes) &&
              section.changes.every(
                (change: unknown) => typeof change === "string",
              ))),
      );
    const inspector =
      storedInspector &&
      typeof storedInspector === "object" &&
      !Array.isArray(storedInspector) &&
      "summary" in storedInspector &&
      Array.isArray(storedInspector.summary) &&
      storedInspector.summary.every((line) => typeof line === "string")
        ? "sections" in storedInspector &&
          validSections(storedInspector.sections)
          ? {
              summary: storedInspector.summary,
              sections: storedInspector.sections,
            }
          : "tree" in storedInspector &&
              typeof storedInspector.tree === "string"
            ? { summary: storedInspector.summary, tree: storedInspector.tree }
            : undefined
        : undefined;
    return expandablePresentation(options.expanded, (expanded) =>
      renderAgentDefinitionsOverview(definitions, theme, {
        ...options,
        expanded,
        instructions,
        inspector,
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
    "pi-herdsman-agent-owner-message",
    (message, options, theme) =>
      expandablePresentation(options.expanded, (expanded) =>
        renderAgentOwnerMessage(message, { ...options, expanded }, theme),
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
  const showHerdsmanVersion = (ctx: ExtensionCommandContext) => {
    ctx.ui.notify(
      formatRuntimeBuildDetails(HERDSMAN_BUILD, HERDSMAN_EXTENSION_PATH),
    );
  };
  const processRole = role();
  if (processRole === "unmanaged") {
    registerNoArgs(
      "herdsman",
      "Set up Pi Herdsman",
      (ctx) => {
        ctx.ui.notify(
          `Pi Herdsman v${HERDSMAN_VERSION} is inactive because this Pi session is not running inside Herdr.\n\nStart Herdr in this project, then run Pi in a Herdr pane:\n  herdr\n  pi\n\nIf needed, install the Pi integration once:\n  herdr integration install pi`,
        );
      },
      true,
    );
    registerNoArgs(
      "herdsman-version",
      "Show loaded Herdsman version and fingerprint",
      showHerdsmanVersion,
      true,
    );
    return;
  }
  const controllerScope: ControllerScope | undefined =
    processRole === "lead" ? { kind: "root" } : undefined;
  const controllerServices: Omit<
    AgentControllerOptions,
    "scope" | "build" | "onWorkChanged" | "onWorktreeRemoved"
  > = {
    afterRequestPublishedForTest: lockHooks?.afterRequestPublished,
    extensionPath: HERDSMAN_EXTENSION_PATH,
    isContextRetired: (manager) => retiredManagedSession(manager),
    snapshotDependencies: {
      runtimeForLabel: () => undefined,
      readRootOwners: (inventory, mailboxes, workspaceId) =>
        readRootOwners(inventory, mailboxes, workspaceId, {
          matchesExpectedSession,
          isPiAgent,
          supervisionRuntime,
          readLeadCoordinationState,
          readManagerDescriptor,
          readChiefDescriptor,
          chiefLeaseIsHeld,
        }),
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
    sendResultMessage: (
      ctx,
      _runtime,
      _result,
      content,
      details,
      triggerTurn = true,
    ) => {
      if (triggerTurn && !ctx.isIdle())
        throw new Error("Agent result owner is no longer idle");
      pi.sendMessage(
        {
          customType: "pi-herdsman-agent-result",
          content,
          display: true,
          details,
        },
        {
          triggerTurn,
          ...(triggerTurn ? { deliverAs: "steer" as const } : {}),
        },
      );
    },
    sendAskMessage: (ctx, ask, triggerTurn = true) => {
      if (triggerTurn && !ctx.isIdle())
        throw new Error("Agent ask owner is no longer idle");
      pi.sendMessage(
        {
          customType: "pi-herdsman-agent-ask",
          content: `Agent ${ask.agentLabel} needs your input:\n\n${ask.question}\n\nUse reply_agent with agent="${ask.agentLabel}" to answer this question.\n\nReply only when you can provide the requested input or an\nactionable alternative. For an external condition that is not\nyet satisfied, leave the question pending rather than replying\nwith a promise to provide the answer later.`,
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
        { triggerTurn },
      );
    },
    sendOwnerMessage: (
      ctx,
      ownerMessage: OwnerMessageRecord,
      triggerTurn = true,
    ) => {
      if (ctx.sessionManager.getSessionId() !== ownerMessage.ownerSessionId)
        throw new Error("Owner notification recipient session changed");
      pi.sendMessage(
        {
          customType: "pi-herdsman-agent-owner-message",
          content:
            `Agent ${ownerMessage.agentLabel} notification:\n\n` +
            `${ownerMessage.text}\n\n` +
            "This is a nonblocking notification, not a pending " +
            "await_owner request. Do not use reply_agent to " +
            "acknowledge it. Use eligible Agent control only " +
            "when an actual correction is needed.",
          display: true,
          details: {
            messageId: ownerMessage.messageId,
            requestId: ownerMessage.requestId,
            runId: ownerMessage.runId,
            ownerSessionId: ownerMessage.ownerSessionId,
            workspaceId: ownerMessage.workspaceId,
            agentLabel: ownerMessage.agentLabel,
            paneId: ownerMessage.paneId,
            piSessionId: ownerMessage.piSessionId,
          },
        },
        {
          triggerTurn,
          ...(triggerTurn ? { deliverAs: "steer" as const } : {}),
        },
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
      branch: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Exact assigned project branch (Managers only).",
        }),
      ),
      target: Type.Optional(
        Type.String({
          pattern: COORDINATOR_TARGET_PATTERN,
          description: "Stable target from current staff discovery.",
        }),
      ),
    },
    { additionalProperties: false },
  );
  const staffMessageParameters = Type.Object(
    {
      branch: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Exact assigned project branch (Managers only).",
        }),
      ),
      target: Type.Optional(
        Type.String({
          pattern: COORDINATOR_TARGET_PATTERN,
          description: "Stable target from current staff discovery.",
        }),
      ),
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
      target: Type.String({
        pattern: COORDINATOR_TARGET_PATTERN,
        description: "Stable target returned by list_peers.",
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
            "Optional Git branch for new work. Prefer a concise, task-specific name following repository conventions, without sensitive details (e.g. fix/agent-selection). Herdsman generates one when omitted.",
        }),
      ),
      base: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Base ref used when Herdsman creates a new worktree.",
        }),
      ),
      definition: Type.Optional(
        Type.String({
          pattern: DEFINITION_NAME_PATTERN.source,
          description:
            "Assigned Lead launch definition. Defaults to managed-lead.",
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
  const staffResumeParameters = Type.Object(
    {
      ...staffBranchParameters.properties,
      definition: Type.Optional(
        Type.String({
          pattern: DEFINITION_NAME_PATTERN.source,
          description:
            "Assert the saved assigned Lead definition. Omit to use the saved selection.",
        }),
      ),
      message: Type.String({
        minLength: 1,
        description:
          "Required instruction for continuing the existing assignment. Does not replace its original task.",
      }),
      files: FILES_SCHEMA,
      retain: staffMessageParameters.properties.retain,
    },
    { additionalProperties: false },
  );
  let startupDefinitionRoster:
    { sessionId: string; definitions: Record<string, unknown>[] } | undefined;
  let modelCatalogSnapshot: { sessionId: string; text: string } | undefined;
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
    remoteChiefAgent: (
      ...args: Parameters<typeof leadRuntimes.remoteChiefAgent>
    ) => leadRuntimes.remoteChiefAgent(...args),
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
    supervisedSessionFile: (agent: HerdrRecord, sessionId: string) =>
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
    build: HERDSMAN_BUILD,
    resolveEffectiveSupervisor: (
      ...args: Parameters<typeof roleTransitions.resolveEffectiveSupervisor>
    ) => roleTransitions.resolveEffectiveSupervisor(...args),
    persistedTranscriptReady: (
      target: Parameters<typeof controllerPersistedTranscriptReady>[0],
    ) =>
      controllerPersistedTranscriptReady(target, (path) => {
        const file = statSync(path, { throwIfNoEntry: false });
        return !!file?.isFile() && file.size > 0;
      }),
    SessionManager,
  };
  const resetSupervisionSnapshot = (): void =>
    leadRuntimes?.supervisionUiRuntime?.reset();
  let prepareSupervisionMessage: (
    ctx: ExtensionContext,
    inventory?: HerdrSessionSnapshot,
  ) => Promise<
    { customType: string; content: string; display: boolean } | undefined
  > = async () => undefined;
  let peerTool: any;
  const ownedToolNames = [
    "agent",
    "chief",
    "peer",
    "staff",
    ...AGENT_COORDINATION_TOOLS,
    ...LEAD_SUPERVISOR_TOOLS,
    ...PEER_TOOLS,
    ...CHIEF_TOOLS,
    "read_evidence",
    "load_skill",
    "delegate_work",
    "resume_work",
    "stop_lead",
    "remove_worktree",
    "integrate_branch",
  ];
  if (processRole === "managed-agent") {
    leadStatusRuntime = createAgentStatusRuntime();
    leadToolState = createLeadToolState(
      () => pi.getAllTools(),
      ownedToolNames,
      LEAD_COORDINATION_TOOLS,
      SUPERVISOR_TOOLS,
    );
  }
  const ownedTools = () => leadToolState.ownedTools;
  const normalizeLeadTools = (tools: readonly string[]): string[] =>
    leadToolState.normalizeLeadTools(tools);
  let roleTransitions: ReturnType<typeof createLeadRoleTransitions>;
  const isCurrentChief = (ctx: ExtensionContext): boolean =>
    leadRuntime.chiefMode === "active" &&
    !!leadRuntime.chiefLease &&
    leadRuntime.chiefLease.descriptor.piSessionId ===
      ctx.sessionManager.getSessionId();
  const chiefGlobalInstructions = (
    options: BuildSystemPromptOptions | undefined,
  ) => selectChiefGlobalInstructions(options, getAgentDir());
  const chiefSystemPrompt = (
    options: BuildSystemPromptOptions | undefined,
    body: string,
  ): string =>
    withRuntimeIdentity(
      buildChiefSystemPrompt(options, body, CHIEF_ROLE_CONTRACT, getAgentDir()),
    );
  const roleCharterBody = (ctx: ExtensionContext): string => {
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
  };
  const roleCharter = (ctx: ExtensionContext): string =>
    withRuntimeIdentity(roleCharterBody(ctx));
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
  const remoteChiefAgent = (
    ...args: Parameters<typeof leadRuntimes.remoteChiefAgent>
  ) => leadRuntimes.remoteChiefAgent(...args);
  const liveLead = (...args: Parameters<typeof leadRuntimes.liveLead>) =>
    leadRuntimes.liveLead(...args);
  const activateChief = (
    ...args: Parameters<typeof roleTransitions.activateChief>
  ): Promise<string> => roleTransitions.activateChief(...args);
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
    unlinkLeadCoordinationState: (
      runtime: Parameters<typeof leadCoordinationStatePath>[0],
      sessionId: Parameters<typeof leadCoordinationStatePath>[1],
    ) => unlinkSync(leadCoordinationStatePath(runtime, sessionId)),
    ownedTools,
    worktreeGroupScope: (
      ctx: ExtensionContext,
      workspaceId: string,
      signal: AbortSignal | undefined = ctx.signal,
    ) => worktreeGroupScope(pi, ctx, workspaceId, signal),
    claimManagerLease,
    readLeadCoordinationState,
    requireCompatibleBuild,
    findProjectAssignmentBySession,
    projectAssignmentPath,
    acquireProcessLock,
    readProjectAssignment,
    prepareCoordinationInput: (
      ...args: Parameters<
        NonNullable<
          typeof leadRuntimes.coordinationRuntime
        >["prepareCoordinationInput"]
      >
    ) => leadRuntimes.coordinationRuntime!.prepareCoordinationInput(...args),
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
  const failClosedRole = (
    ...args: Parameters<typeof roleTransitions.failClosedRole>
  ) => roleTransitions.failClosedRole(...args);
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
        ...(name !== undefined ? { name } : {}),
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
      startHerdrCoordinatorInPane,
      prepareHerdrCoordinatorPane,
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
      readPersistedTranscript: (
        target: Parameters<typeof controllerReadPersistedTranscript>[0],
      ) =>
        controllerReadPersistedTranscript(
          target,
          (path) => readFileSync(path, "utf8"),
          (path) => {
            const file = statSync(path, { throwIfNoEntry: false });
            return !!file?.isFile() && file.size > 0;
          },
        ),
    };
    prepareSupervisionMessage = (ctx, inventory) =>
      leadRuntimes.supervisionUiRuntime!.prepareMessage(ctx, inventory);
    const assertChiefProjectAuthority = async (ctx: ExtensionContext) => {
      if (
        !isCurrentChief(ctx) ||
        leadRuntime.roleSuspended ||
        !(await roleTransitions.currentChiefAuthority(ctx, true))
      )
        throw new Error(
          "Chief project tools require verified active Chief authority",
        );
    };
    const chiefProject = createChiefProjectRuntime(pi, {
      build: HERDSMAN_BUILD,
      extensionPath: HERDSMAN_EXTENSION_PATH,
      managerTools: MANAGER_TOOLS,
      runtime: supervisionRuntime,
      remoteIdentity: remoteChiefAgent,
      assertChief: assertChiefProjectAuthority,
      sendInitialLeadMessage: async (sessionId, message, ctx) => {
        const target = rememberCoordinatorTarget(pi, ctx, "lead", sessionId);
        return projectRuntime.executeStaff(
          randomUUID(),
          { action: "message", target, message },
          ctx.signal,
          undefined,
          ctx,
        );
      },
    });
    const discoverChiefProjects = async (
      ctx: ExtensionContext,
      includeProjectsDirectory: boolean,
      signal?: AbortSignal,
      inventory?: HerdrSessionSnapshot | null,
    ) => {
      await assertChiefProjectAuthority(ctx);
      const runtime = supervisionRuntime();
      const result = await discoverProjects(pi, ctx, {
        runtime,
        includeProjectsDirectory,
        signal,
        inventory,
        verifyRunningManager: (repository, descriptor, signal) =>
          chiefProject.verifyActive(
            { ...ctx, signal },
            runtime,
            repository,
            descriptor,
          ),
      });
      await assertChiefProjectAuthority(ctx);
      return result;
    };
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
      observeChiefTopology: (ctx: ExtensionContext) =>
        herdrSessionSnapshot(pi, ctx, ctx.signal),
      discoverChiefOverview: (
        ctx: ExtensionContext,
        inventory: HerdrSessionSnapshot | null,
      ) => discoverChiefProjects(ctx, false, ctx.signal, inventory),
      sendMessage: (message: any) =>
        pi.sendMessage(message, { triggerTurn: false }),
      chiefSystemPrompt,
      roleCharter,
      supervisoryProfileBody: (
        ctx: ExtensionContext,
        role: "manager" | "chief",
      ) => leadRuntimes.supervisoryProfileBody(ctx, role),
      currentChiefAllowedTools: (ctx: ExtensionContext) =>
        leadRuntimes.currentChiefAllowedTools(ctx),
      currentManagerAllowedTools: (ctx: ExtensionContext) =>
        leadRuntimes.currentManagerAllowedTools(ctx),
      reconcileRoleTools: () =>
        leadRuntimes.roleTransitions.reconcileRoleTools(),
      managerTools: MANAGER_TOOLS,
      isActiveManager: () =>
        activeRole() === "manager" && !leadRuntime.roleSuspended,
      isActiveLead: () => activeRole() === "lead",
      prepareLeadSupervisorStateMessage: (ctx: ExtensionContext) =>
        leadRuntimes.coordinationRuntime!.prepareLeadSupervisorStateMessage(
          ctx,
        ),
      selectSupervisorTool: (destination?: "manager" | "chief") => {
        const current = pi.getActiveTools();
        const next = current.filter(
          (name) => !(SUPERVISOR_TOOLS as readonly string[]).includes(name),
        );
        if (destination) next.push(`message_${destination}`);
        if (
          next.length !== current.length ||
          next.some((name, index) => name !== current[index])
        )
          pi.setActiveTools(next);
      },
      definitionRoster: () => startupDefinitionRoster,
      modelCatalog: (ctx: ExtensionContext) => {
        if (!pi.getActiveTools().includes("delegate_agent")) return undefined;
        const config = readConfig();
        if (!config.allowAgentModelOverrides) return undefined;

        const sessionId = ctx.sessionManager.getSessionId();
        if (modelCatalogSnapshot?.sessionId !== sessionId) {
          try {
            const text = sessionAgentModelCatalog(ctx, config);
            if (text !== undefined) modelCatalogSnapshot = { sessionId, text };
          } catch (error) {
            appendDurableError(pi, ctx, "pi_herdsman_definition_error", error);
          }
        }
        return modelCatalogSnapshot?.sessionId === sessionId
          ? modelCatalogSnapshot.text
          : undefined;
      },
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
    type MenuItem = SelectItem & { help?: string; searchText?: string };
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
        (
          tui: any,
          theme: any,
          keybindings: any,
          done: (value: unknown) => void,
        ) => {
          const input = new Input();
          const listContainer = new Container();
          const maxHelpCharacters = 280;
          const helpArea = items.some((item) =>
            collapseDisplayText(item.help, maxHelpCharacters),
          )
            ? new Container()
            : undefined;
          const helpText = new TuiText("", 1, 0);
          const emptyHelp = new Spacer(1);
          const updateHelp = (item: SelectItem | null): void => {
            if (!helpArea) return;
            const help = collapseDisplayText(
              (item as MenuItem | null)?.help,
              maxHelpCharacters,
            );
            helpArea.clear();
            if (help) {
              helpText.setText(theme.fg("dim", help));
              helpArea.addChild(helpText);
            } else {
              helpArea.addChild(emptyHelp);
            }
          };
          const maxPrimaryColumnWidth = Math.max(
            12,
            ...items.map((item) => visibleWidth(item.label) + 2),
          );
          let filtered: MenuItem[] = [...items];
          let list: SelectList | undefined;
          let previousQuery = input.getValue();
          const rebuildList = (): void => {
            const query = input.getValue();
            filtered = query.trim()
              ? fuzzyFilter([...items], query, (item) =>
                  [item.label, item.description, item.searchText]
                    .filter(Boolean)
                    .join(" "),
                )
              : [...items];
            listContainer.clear();
            if (!filtered.length) {
              list = undefined;
              listContainer.addChild(
                new TuiText(theme.fg("muted", "No matching options"), 1, 0),
              );
              updateHelp(null);
              return;
            }
            list = new SelectList(filtered, 8, getSelectListTheme(), {
              minPrimaryColumnWidth: 12,
              maxPrimaryColumnWidth,
            });
            const index = query.trim()
              ? 0
              : filtered.findIndex((item) => item.value === selectedValue);
            list.setSelectedIndex(index >= 0 ? index : 0);
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(undefined);
            list.onSelectionChange = updateHelp;
            listContainer.addChild(list);
            updateHelp(list.getSelectedItem());
          };
          input.onSubmit = () => {
            const selected = list?.getSelectedItem();
            if (selected) done(selected.value);
          };
          input.onEscape = () => done(undefined);
          rebuildList();
          const body = new Container();
          body.addChild(input);
          body.addChild(new Spacer(1));
          body.addChild(listContainer);
          const container = new Container();
          populateMenuFrame(
            container,
            theme,
            title,
            body,
            "Type to filter · ↑↓ navigate · Enter select · Esc back",
            helpArea,
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
              if (
                keybindings.matches(data, "tui.select.up") ||
                keybindings.matches(data, "tui.select.down")
              ) {
                const selected = list?.getSelectedItem();
                if (selected && list) {
                  const index = filtered.findIndex(
                    (item) => item.value === selected.value,
                  );
                  const next = keybindings.matches(data, "tui.select.up")
                    ? index <= 0
                      ? filtered.length - 1
                      : index - 1
                    : index < 0 || index === filtered.length - 1
                      ? 0
                      : index + 1;
                  list.setSelectedIndex(next);
                  updateHelp(list.getSelectedItem());
                }
              } else if (keybindings.matches(data, "tui.select.confirm")) {
                const selected = list?.getSelectedItem();
                if (selected) done(selected.value);
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                done(undefined);
              } else {
                input.handleInput(data);
                const query = input.getValue();
                if (query !== previousQuery) {
                  previousQuery = query;
                  rebuildList();
                }
              }
              tui.requestRender();
            },
          };
        },
        { blocked: { kind: "question", message: title } },
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
    const reviewPendingRemoval = async (
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const pending = projectRuntime.listPendingRemovals(ctx);
      if (!pending.length) {
        ctx.ui.notify("There are no pending worktree removals.", "info");
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
      const request = pending.find((item) => item.branch === selected);
      if (!request) throw new Error("Pending removal is unavailable");
      const action = await selectMenu(ctx, `Pending removal · ${selected}`, [
        { value: "approve", label: "Approve removal…" },
        { value: "dismiss", label: "Dismiss request" },
      ]);
      if (!action) return;
      if (action === "dismiss") {
        if (!projectRuntime.cancelPendingRemoval(request, ctx))
          throw new Error("Pending removal changed; review the new request");
        ctx.ui.notify(
          `Pending removal of ${request.branch} dismissed.`,
          "info",
        );
        return;
      }
      const result = await projectRuntime.approvePendingRemoval(request, ctx);
      ctx.ui.notify(
        result.content[0]?.text ?? "Removal finished.",
        result.details.ok ||
          ("cancelled" in result.details && result.details.cancelled)
          ? "info"
          : "warning",
      );
      return;
    };
    let leadCommandRuntime: any;
    const leadCommandHost = {
      reviewPendingRemoval,
      persistStopClosures: (
        ctx: ExtensionContext,
        closures: Parameters<typeof projectRuntime.persistStopClosures>[1],
      ) => projectRuntime.persistStopClosures(ctx, closures),
      getRemovalPreauthorization: (ctx: ExtensionContext) =>
        projectRuntime.getRemovalPreauthorization(ctx),
      setRemovalPreauthorization: (
        enabled: boolean,
        ctx: ExtensionContext,
        expectedManager?: Parameters<
          typeof projectRuntime.setRemovalPreauthorization
        >[2],
      ) =>
        projectRuntime.setRemovalPreauthorization(
          enabled,
          ctx,
          expectedManager,
        ),
      setRepositoryMergeOverride: (
        ...args: Parameters<typeof projectRuntime.setRepositoryMergeOverride>
      ) => projectRuntime.setRepositoryMergeOverride(...args),
      runHerdr,
      presentStopSummary,
      build: HERDSMAN_BUILD,
      extensionPath: HERDSMAN_EXTENSION_PATH,
      selectMenu,
      readConfig,
      readEffectiveConfig,
      readProjectOverrides,
      updateProjectOverride,
      contextAgentDefinitions,
      resolveDefinition: (
        ...[category, name, options]: Parameters<typeof resolveDefinition>
      ) =>
        category === "lead" &&
        options?.usage === "assigned-lead" &&
        lockHooks?.managedLeadDefinition
          ? lockHooks.managedLeadDefinition(name)
          : resolveDefinition(category, name, options),
      getSystemPromptOptions: (ctx: ExtensionCommandContext) =>
        ctx.getSystemPromptOptions(),
      chiefSystemPrompt,
      chiefGlobalInstructions,
      roleCharter,
      isCurrentChief,
      supervisoryProfileBody: (
        ctx: ExtensionContext,
        role: "manager" | "chief",
      ) => leadRuntimes.supervisoryProfileBody(ctx, role),
      executionPrompt: () => leadRuntimes.executionPrompt(),
      leadExecutionDefinition: () => leadRuntimes.leadExecutionDefinition(),
      inspectDefinition,
      expandDefinitionBodyFragments,
      expandDefinitionBodyFragmentsWithSources,
      expandAgentBodyFiles,
      selectedAgentContextFiles,
      setLeadExecutionMode: (
        ctx: ExtensionCommandContext,
        mode: LeadExecutionMode,
      ) => leadRuntimes.setLeadExecutionMode(ctx, mode),
      leadExecutionPresentation: () => leadRuntimes.leadExecutionPresentation(),
      agentDefinitionEnabled,
      agentDefinitionMetadata,
      appendDefinitionsEntry: (data: {
        definitions: Record<string, unknown>[];
        inspector: {
          summary: string[];
          sections: import("./presentation.ts").InstructionSection[];
        };
      }) => pi.appendEntry(AGENT_DEFINITIONS_ENTRY, data),
      formatAgentDefinitions,
      validThinkingLevels: VALID_THINKING_LEVELS,
      updateAgentOverride,
      isSpawnPlacement,
      placementSettings,
      messageLimits,
      formatMessageLimit,
      validByteLimit,
      validStatusWidgetMaxRows,
      validMaxAgentDepth,
      input: (ctx: ExtensionCommandContext, label: string) =>
        ctx.ui.input(label),
      updateSpawnPlacement: (placement: string) =>
        updateConfig("spawnPlacement", placement as SpawnPlacement),
      updateMessageLimit: (key: string, value: number | undefined) =>
        updateConfig(key as any, value),
      updateConfig: (
        key: string,
        value: unknown,
        expectedManagerMergeEnabled?: import("./config.ts").ManagerMergeSetting,
      ) => {
        updateConfig(key as any, value as any, expectedManagerMergeEnabled);
        if (key === "statusWidgetMaxRows") {
          const rows =
            value === undefined
              ? DEFAULT_STATUS_WIDGET_MAX_ROWS
              : (value as number);
          leadRuntimes.statusRuntime?.setStatusWidgetMaxRows(rows);
          leadRuntimes.supervisionUiRuntime?.setStatusWidgetMaxRows(rows);
        }
      },
      collectOwnedSessionUsage,
      formatSessionUsage,
    };
    if (controllerScope.kind === "root") {
      const completeAssignedBranches = (prefix: string) => {
        const lease = leadRuntime.managerLease;
        if (!lease) return [];
        try {
          const branches = listProjectAssignments(
            supervisionRuntime(),
            lease.descriptor.repoKey,
          ).map(({ branch }) => branch);
          return completeValues(branches, prefix);
        } catch {
          return [];
        }
      };
      registerNoArgs("lead", "Choose Lead execution profile", (ctx) =>
        leadCommandRuntime.openExecutionMenu(ctx),
      );
      registerNoArgs(
        "lead-flexible",
        "Select or refresh Flexible Lead profile",
        (ctx) => leadCommandRuntime.setLeadMode("flexible", ctx),
      );
      registerNoArgs(
        "lead-orchestrate",
        "Select or refresh Orchestrator Lead profile",
        (ctx) => leadCommandRuntime.setLeadMode("orchestrate", ctx),
      );
      registerNoArgs(
        "herdsman",
        "Open Pi Herdsman",
        (ctx) =>
          runHerdsmanAction(ctx, () =>
            leadCommandRuntime.openHerdsmanMenu(ctx),
          ),
        true,
      );
      registerNoArgs(
        "herdsman-version",
        "Show loaded Herdsman version and fingerprint",
        showHerdsmanVersion,
        true,
      );
      registerNoArgs(
        "herdsman-stats",
        "Show session usage and costs",
        (ctx) =>
          runHerdsmanAction(ctx, () =>
            leadCommandRuntime.showSessionStats(ctx),
          ),
        true,
      );
      registerNoArgs(
        "herdsman-definitions",
        "Open agent and coordinator definitions",
        (ctx) =>
          runHerdsmanAction(ctx, () =>
            leadCommandRuntime.openDefinitionsMenu(ctx),
          ),
        true,
      );
      registerNoArgs(
        "herdsman-stop",
        "Emergency stop owned Agent tree",
        (ctx) =>
          runHerdsmanAction(ctx, () =>
            leadCommandRuntime.confirmAndStopAll(ctx),
          ),
        true,
      );
      pi.registerCommand("herdsman-placement", {
        description: "Configure agent terminal layout",
        getArgumentCompletions: (prefix) =>
          completeValues(["tab", "subtree", "split"], prefix),
        handler: async (rawArgs, ctx) => {
          if (!ctx.hasUI) return;
          const placement = rawArgs.trim();
          if (!placement) {
            await runHerdsmanAction(ctx, () =>
              leadCommandRuntime.openPlacementMenu(ctx),
            );
            return;
          }
          if (!isSpawnPlacement(placement)) {
            ctx.ui.notify(
              "Usage: /herdsman-placement [tab|subtree|split]",
              "error",
            );
            return;
          }
          await runHerdsmanAction(ctx, () =>
            leadCommandRuntime.setPlacement(placement, ctx),
          );
        },
      });
      if (process.env.HERDR_PANE_ID) {
        for (const role of ["manager", "chief"] as const) {
          const label = role === "manager" ? "Manager" : "Chief";
          registerNoArgs(
            role,
            `Activate ${label} mode or open overview`,
            (ctx) => leadCommandRuntime.runRoleCommand(role, "open", ctx),
          );
          registerNoArgs(
            `${role}-refresh`,
            `Refresh active ${label} profile`,
            (ctx) => leadCommandRuntime.runRoleCommand(role, "refresh", ctx),
          );
          registerNoArgs(`${role}-leave`, `Leave ${label} mode`, (ctx) =>
            leadCommandRuntime.runRoleCommand(role, "leave", ctx),
          );
        }
        pi.registerCommand("manager-remove", {
          description:
            "Review pending removal requests or remove assigned worktree",
          getArgumentCompletions: completeAssignedBranches,
          handler: async (rawArgs, ctx) => {
            const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
            if (!args.length) {
              await reviewPendingRemoval(ctx);
              return;
            }
            if (args.length !== 1) {
              ctx.ui.notify("Usage: /manager-remove [branch]", "error");
              return;
            }
            const result = await projectRuntime.removeWorktree(args[0]!, ctx);
            ctx.ui.notify(
              result.content[0]?.text ?? `Removal of ${args[0]} finished.`,
              result.details.ok ||
                ("cancelled" in result.details && result.details.cancelled)
                ? "info"
                : "warning",
            );
          },
        });
        pi.registerCommand("manager-forget", {
          description: "Forget orphaned project assignment",
          getArgumentCompletions: completeAssignedBranches,
          handler: async (rawArgs, ctx) => {
            const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
            if (args.length !== 1) {
              ctx.ui.notify("Usage: /manager-forget <branch>", "error");
              return;
            }
            const result = await projectRuntime.forgetLegacyProjectAssignment(
              args[0]!,
              ctx,
            );
            ctx.ui.notify(
              result.content[0]?.text ?? `Forget of ${args[0]} finished.`,
              result.details.ok ||
                ("cancelled" in result.details && result.details.cancelled)
                ? "info"
                : "warning",
            );
          },
        });
        pi.registerCommand("manager-removal-confirmation", {
          description: "Inspect or change worktree removal approval policy",
          getArgumentCompletions: (prefix) =>
            completeValues(["required", "skip"], prefix),
          handler: async (rawArgs, ctx) => {
            const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
            if (!args.length) {
              const policy =
                await projectRuntime.getRemovalPreauthorization(ctx);
              ctx.ui.notify(
                `Worktree removal approval: ${policy.enabled ? "Skipped" : "Required"} for ${policy.repoKey}.`,
                "info",
              );
              return;
            }
            if (args.length !== 1 || !["required", "skip"].includes(args[0]!)) {
              ctx.ui.notify(
                "Usage: /manager-removal-confirmation [required|skip]",
                "error",
              );
              return;
            }
            const enabled = args[0] === "skip";
            const stored = await projectRuntime.setRemovalPreauthorization(
              enabled,
              ctx,
            );
            ctx.ui.notify(
              stored
                ? `Worktree removal approval: ${enabled ? "Skipped" : "Required"}.`
                : "Worktree removal approval setting unchanged.",
              stored ? "info" : "warning",
            );
          },
        });
      }
      peerTool = {
        name: "message_peer",
        label: "message peer",
        exposure: "direct",
        promptSnippet:
          "Discover same-role peers, including remote ordinary Leads, and reply through existing correspondences",
        description:
          "Send task-relevant communication needed by another eligible coordinator, not routine broadcasts or gratuitous acknowledgments. Send to an eligible same-role Lead or Manager using its stable target. Ordinary Leads and Managers may discover eligible same-role peers on reachable saved Herdr machines; remote Leads must be ordinary and unassigned. An existing return correspondence may allow a reply-only target without independent discovery or current availability. Use only the exact target from list_peers; optional name/workspace labels are advisory display context.",
        executionMode: "sequential",
        parameters: peerMessageParameters,
        execute: (
          ...args: Parameters<
            NonNullable<typeof leadRuntimes.coordinationRuntime>["peerMessage"]
          >
        ) => leadRuntimes.coordinationRuntime!.peerMessage(...args),
        renderCall: (args: unknown, theme: any, context: any) =>
          renderCoordinationCall("peer", "message", args, theme, context),
        renderResult: (result: any, options: any, theme: any, context: any) =>
          renderCoordinationResult("peer", "message", result, options, theme, {
            ...context,
            activeRole: activeRole(),
          }),
      };
      const chiefProjectTool = {
        defaultActive: false,
        exposure: "direct" as const,
        executionMode: "sequential" as const,
      };
      const projectResult = <T>(details: T) => ({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      });
      const projectLocation = Type.String({ minLength: 1 });
      const projectDestination = Type.Optional(Type.String({ minLength: 1 }));
      pi.registerTool({
        ...chiefProjectTool,
        name: "list_projects",
        label: "list projects",
        description:
          "Discover verified Git projects, Herdr workspaces and Manager status, including a bounded scan of the configured projects directory. Read-only.",
        parameters: emptyParameters,
        execute: async (_id, _params, signal, _update, ctx) =>
          projectResult(
            await discoverChiefProjects(
              ctx,
              true,
              signal && ctx.signal && signal !== ctx.signal
                ? AbortSignal.any([signal, ctx.signal])
                : (signal ?? ctx.signal),
            ),
          ),
      });
      pi.registerTool({
        ...chiefProjectTool,
        name: "clone_repository",
        label: "clone repository",
        description:
          "Clone and verify an HTTPS or SSH Git repository and provision or reuse its primary Herdr workspace without launching Pi.",
        parameters: Type.Object(
          { url: projectLocation, destination: projectDestination },
          { additionalProperties: false },
        ),
        execute: async (_id, { url, destination }, _signal, _update, ctx) =>
          projectResult(await chiefProject.clone(url, destination, ctx)),
      });
      pi.registerTool({
        ...chiefProjectTool,
        name: "start_manager",
        label: "start Manager",
        description:
          "Prepare a local Git project or clone a remote project and start its Manager. Destination is only for remote clones. Does not replace a saved Manager session.",
        parameters: Type.Object(
          {
            repository: projectLocation,
            destination: projectDestination,
            definition: Type.Optional(
              Type.String({ pattern: DEFINITION_NAME_PATTERN }),
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (
          _id,
          { repository, destination, definition },
          _signal,
          _update,
          ctx,
        ) =>
          projectResult(
            await chiefProject.startNamed(
              repository,
              destination,
              definition,
              ctx,
            ),
          ),
      });
      pi.registerTool({
        ...chiefProjectTool,
        name: "resume_manager",
        label: "resume Manager",
        description:
          "Recover a stopped Manager using its exact saved Pi session for the selected local Git repository.",
        parameters: Type.Object(
          { repository: projectLocation },
          { additionalProperties: false },
        ),
        execute: async (_id, { repository }, _signal, _update, ctx) =>
          projectResult(await chiefProject.resume(repository, ctx)),
      });
      pi.registerTool({
        ...chiefProjectTool,
        name: "start_lead",
        label: "start Lead",
        description:
          "Start an ordinary Lead in an exact current Herdr workspace. Does not create a project assignment or activate a Manager. An optional initial message is queued only if the Lead is currently a Chief direct report.",
        parameters: Type.Object(
          {
            workspace: projectLocation,
            definition: Type.Optional(
              Type.String({ pattern: DEFINITION_NAME_PATTERN }),
            ),
            message: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
        execute: async (
          _id,
          { workspace, definition, message },
          _signal,
          _update,
          ctx,
        ) =>
          projectResult(
            await chiefProject.startLead(workspace, definition, message, ctx),
          ),
      });
      pi.registerTool({
        ...chiefProjectTool,
        name: "stop_hierarchy",
        label: "stop hierarchy",
        description:
          "Stop an explicitly selected verified hierarchy child-first. Manager scope requires the exact Manager target from current staff discovery; staff stops all Chief-supervised execution but keeps Chief running; all requests Pi's graceful Chief shutdown only after descendants are verified stopped. Partial or blocked results mean execution may remain. This never deletes projects, worktrees, branches, assignments, or session history and does not restart stopped execution.",
        parameters: Type.Object(
          {
            scope: Type.String({ enum: ["manager", "staff", "all"] }),
            target: Type.Optional(
              Type.String({ pattern: COORDINATOR_TARGET_PATTERN }),
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, request, signal, _update, ctx) => {
          const result = (details: Record<string, unknown>) => ({
            content: [{ type: "text" as const, text: JSON.stringify(details) }],
            details,
          });
          const scope = request.scope as "manager" | "staff" | "all";
          if (
            !["manager", "staff", "all"].includes(scope) ||
            (scope === "manager" &&
              typeof (request as any).target !== "string") ||
            (scope !== "manager" && Object.hasOwn(request, "target"))
          )
            return result({
              status: "blocked",
              scope,
              reason:
                "manager scope requires exactly one verified staff target; staff and all scopes prohibit target",
              stopped: [],
              remaining: [],
            });
          if (scope === "all" && ctx.mode === "print")
            return result({
              status: "blocked",
              scope,
              reason:
                "Pi print mode treats ctx.shutdown() as a no-op; no execution was stopped",
              stopped: [],
              remaining: [],
            });
          try {
            await assertChiefProjectAuthority(ctx);
          } catch (error) {
            return result({
              status: "blocked",
              scope,
              reason: String(error),
              stopped: [],
              remaining: [],
            });
          }
          let admission: ReturnType<typeof acquireCoordinatorAdmission>;
          try {
            admission = acquireCoordinatorAdmission();
          } catch (error) {
            return result({
              status: "blocked",
              scope,
              reason: String(error),
              stopped: [],
              remaining: [],
            });
          }
          // Freeze new Chief-owned assignments before tree cleanup and through
          // final observation. Any already admitted assignment holds the owner
          // lock and must settle before that tree can be quiesced.
          chiefStaffShutdownActive = scope !== "manager";
          const stopped: Array<{ role: string; session: string }> = [];
          const remaining: Array<{
            role: string;
            session: string;
            reason: string;
          }> = [];
          const getReports = async () => {
            const incompatible: any[] = [];
            const intents = listCoordinatorStartIntents(supervisionRuntime());
            if (!intents.complete)
              throw new Error(
                "Coordinator startup-intent observation is incomplete",
              );
            for (const intent of intents.intents)
              incompatible.push({
                role: intent.role ?? "manager",
                session: intent.sessionId,
                reason: `Coordinator startup remains unsettled for ${intent.workspaceId}/${intent.paneId}`,
              });
            const managerLaunches = chiefProject.unsettledManagerLaunches();
            if (!managerLaunches.complete)
              incompatible.push({
                role: "manager",
                session: "unknown",
                reason:
                  "Unsettled Manager launch records could not be fully verified",
              });
            for (const session of managerLaunches.sessions)
              incompatible.push({
                role: "manager",
                session,
                reason:
                  "An exact Manager start or recovery attempt remains unsettled",
              });
            const fullSnapshot =
              await leadRuntimes.supervisionUiRuntime!.loadSnapshot(
                ctx,
                undefined,
                undefined,
                true,
                true,
              );
            if (fullSnapshot.diagnostics?.length)
              for (const diagnostic of fullSnapshot.diagnostics)
                incompatible.push({
                  role: "staff",
                  session: "unknown",
                  reason: diagnostic,
                });
            for (const item of fullSnapshot.incompatible ?? [])
              incompatible.push(item);
            const reports =
              await leadRuntimes.supervisionUiRuntime!.directReports(
                ctx,
                undefined,
                undefined,
                incompatible,
              );
            return { reports, incompatible };
          };
          const sameManager = (left: any, right: any) =>
            left?.role === "manager" &&
            right?.role === "manager" &&
            left.session === right.session &&
            left.instanceId === right.instanceId &&
            left.workspaceId === right.workspaceId &&
            left.paneId === right.paneId &&
            left.tabId === right.tabId;
          const managerFor = (reports: any[], expected: any) =>
            reports.find((report) => sameManager(report, expected));
          const verifyManager = async (expected: any) => {
            const current = await getReports();
            if (
              current.incompatible.length ||
              !managerFor(current.reports, expected)
            )
              throw new Error(
                "Manager identity, supervision, or report completeness changed",
              );
            const manager = managerFor(current.reports, expected);
            if (manager.incompatibleLeadCount)
              throw new Error(
                "Manager subtree contains an incompatible or unverified Lead",
              );
            return manager;
          };
          const verifyNestedLead = async (manager: any, expected: any) => {
            const currentManager = await verifyManager(manager);
            const lead = currentManager.leads?.find(
              (candidate: any) =>
                candidate.session === expected.session &&
                candidate.instanceId === expected.instanceId &&
                candidate.workspaceId === expected.workspaceId &&
                candidate.paneId === expected.paneId &&
                candidate.tabId === expected.tabId &&
                !candidate.compatibility,
            );
            if (!lead)
              throw new Error(
                "Lead is no longer a verified report of the selected Manager",
              );
          };
          const stopCoordinator = async (
            target: any,
            revalidate: () => Promise<void>,
          ) => {
            await projectRuntime.stopCoordinatorExecution(
              {
                role: target.role,
                sessionId: target.sessionId,
                workspaceId: target.workspaceId,
                paneId: target.paneId,
                tabId: target.tabId,
                instanceId: target.instanceId,
              },
              ctx,
              revalidate,
              signal ?? ctx.signal,
            );
            stopped.push({ role: target.role, session: target.sessionId });
          };
          const stopManagerSubtree = async (manager: any) => {
            const current = await verifyManager(manager);
            const outcome = await stopCoordinatorChildrenFirst(
              current.leads ?? [],
              async (lead: any) => {
                if (
                  lead.compatibility ||
                  typeof lead.instanceId !== "string" ||
                  typeof lead.workspaceId !== "string" ||
                  typeof lead.paneId !== "string" ||
                  typeof lead.tabId !== "string"
                )
                  throw new Error(
                    "Lead identity is incomplete or incompatible",
                  );
                await stopCoordinator(
                  {
                    role: "lead",
                    sessionId: lead.session,
                    instanceId: lead.instanceId,
                    workspaceId: lead.workspaceId,
                    paneId: lead.paneId,
                    tabId: lead.tabId,
                  },
                  () => verifyNestedLead(manager, lead),
                );
              },
              async () =>
                stopCoordinator(
                  {
                    role: "manager",
                    sessionId: manager.session,
                    workspaceId: manager.workspaceId,
                    paneId: manager.paneId,
                    tabId: manager.tabId,
                    instanceId: manager.instanceId,
                  },
                  async () => {
                    const latest = await getReports();
                    if (
                      latest.incompatible.length ||
                      !managerFor(latest.reports, manager) ||
                      managerFor(latest.reports, manager).leads?.length
                    )
                      throw new Error(
                        "Manager scope changed or supervised Leads remain",
                      );
                  },
                ),
            );
            for (const failure of outcome.failedChildren)
              remaining.push({
                role: "lead",
                session: String(failure.child.session ?? "unknown"),
                reason: failure.reason,
              });
            if (outcome.failedChildren.length) {
              remaining.push({
                role: "manager",
                session: manager.session,
                reason:
                  "Manager preserved because one or more required Lead subtrees did not settle",
              });
            } else if (outcome.ownerError) {
              remaining.push({
                role: "manager",
                session: manager.session,
                reason: outcome.ownerError,
              });
            }
          };
          try {
            const initial = await getReports();
            if (initial.incompatible.length)
              return result({
                status: "blocked",
                scope,
                reason:
                  "Staff discovery contains incompatible or unverified execution; shutdown scope is incomplete",
                stopped,
                remaining: initial.incompatible.map((item: any) => ({
                  role: item.role,
                  session: item.session,
                  reason: item.reason ?? "execution could not be verified",
                })),
              });
            let selectedManagers: any[] = initial.reports.filter(
              (report: any) => report.role === "manager",
            );
            let directLeads: any[] = initial.reports.filter(
              (report: any) => report.role === "lead",
            );
            if (scope === "manager") {
              let identity: { role: string; sessionId: string };
              try {
                identity = resolveCoordinatorTarget(
                  ctx,
                  (request as { target: string }).target,
                );
              } catch (error) {
                return result({
                  status: "blocked",
                  scope,
                  reason: String(error),
                  stopped,
                  remaining,
                });
              }
              const manager = selectedManagers.find(
                (report: any) =>
                  identity.role === "manager" &&
                  report.session === identity.sessionId,
              );
              if (!manager)
                return result({
                  status: "blocked",
                  scope,
                  reason:
                    "Target is not a currently verified Chief-supervised Manager",
                  stopped,
                  remaining,
                });
              selectedManagers = [manager];
              directLeads = [];
            }
            for (const manager of selectedManagers)
              await stopManagerSubtree(manager);
            for (const lead of directLeads) {
              if (
                typeof lead.instanceId !== "string" ||
                typeof lead.workspaceId !== "string" ||
                typeof lead.paneId !== "string" ||
                typeof lead.tabId !== "string"
              ) {
                remaining.push({
                  role: "lead",
                  session: lead.lead,
                  reason: "Lead identity is incomplete",
                });
                continue;
              }
              try {
                await stopCoordinator(
                  {
                    role: "lead",
                    sessionId: lead.lead,
                    workspaceId: lead.workspaceId,
                    paneId: lead.paneId,
                    tabId: lead.tabId,
                    instanceId: lead.instanceId,
                  },
                  async () => {
                    const latest = await getReports();
                    if (
                      latest.incompatible.length ||
                      !latest.reports.some(
                        (report: any) =>
                          report.role === "lead" &&
                          report.lead === lead.lead &&
                          report.instanceId === lead.instanceId &&
                          report.workspaceId === lead.workspaceId &&
                          report.paneId === lead.paneId &&
                          report.tabId === lead.tabId,
                      )
                    )
                      throw new Error(
                        "Lead is no longer a verified Chief direct report",
                      );
                  },
                );
              } catch (error) {
                remaining.push({
                  role: "lead",
                  session: lead.lead,
                  reason: String(error),
                });
              }
            }
            if (scope !== "manager") {
              const sessionId = ctx.sessionManager.getSessionId();
              const workspaceId = process.env.HERDR_WORKSPACE_ID;
              if (!workspaceId) {
                remaining.push({
                  role: "chief-agent",
                  session: sessionId,
                  reason: "Chief workspace identity is unavailable",
                });
              } else {
                try {
                  const root = leadRuntimes.controller!;
                  const result = await root.withQuiescedTree(
                    ctx,
                    sessionId,
                    workspaceId,
                    (held) =>
                      root.stopOwnedAgentsForSession(
                        ctx,
                        sessionId,
                        workspaceId,
                        signal ?? ctx.signal,
                        held,
                      ),
                    signal ?? ctx.signal,
                  );
                  if (!result.complete) throw new Error(result.summary);
                } catch (error) {
                  remaining.push({
                    role: "chief-agent",
                    session: sessionId,
                    reason: String(error),
                  });
                }
              }
            }
            let finalReports:
              Awaited<ReturnType<typeof getReports>> | undefined;
            try {
              finalReports = await getReports();
            } catch (error) {
              remaining.push({
                role: "staff",
                session: "unknown",
                reason: `Final supervision observation failed: ${String(error)}`,
              });
            }
            if (finalReports?.incompatible.length)
              remaining.push(
                ...finalReports.incompatible.map((item: any) => ({
                  role: item.role,
                  session: item.session,
                  reason: item.reason ?? "execution could not be verified",
                })),
              );
            if (finalReports) {
              const remainingReports =
                scope === "manager"
                  ? finalReports.reports.filter(
                      (report: any) =>
                        report.role === "manager" &&
                        report.session === selectedManagers[0]?.session,
                    )
                  : finalReports.reports;
              for (const report of remainingReports)
                remaining.push({
                  role: report.role,
                  session:
                    report.role === "manager" ? report.session : report.lead,
                  reason: "Execution remains in the selected scope",
                });
            }
            if (remaining.length)
              return result({
                status: stopped.length ? "partial" : "blocked",
                scope,
                stopped,
                remaining,
              });
            if (scope === "all") {
              pendingShutdownAdmission = admission;
              try {
                ctx.shutdown();
              } catch (error) {
                pendingShutdownAdmission = undefined;
                throw error;
              }
              return result({
                status: "shutdown_requested",
                scope,
                chief:
                  "graceful exit requested; external process exit not observed",
                stopped,
                remaining: [],
              });
            }
            return result({
              status: "complete",
              scope,
              stopped,
              remaining: [],
            });
          } catch (error) {
            return result({
              status: stopped.length ? "partial" : "blocked",
              scope,
              reason: String(error),
              stopped,
              remaining,
            });
          } finally {
            chiefStaffShutdownActive = false;
            if (pendingShutdownAdmission !== admission) admission.release();
          }
        },
      });
      const staffTool = {
        name: "message_staff",
        label: "message staff",
        defaultActive: false,
        exposure: "direct" as const,
        promptSnippet:
          "Supervise direct reports; Managers may delegate new linked-worktree Leads",
        executionMode: "sequential" as const,
        parameters: staffMessageParameters,
        execute: (...args: Parameters<typeof projectRuntime.executeStaff>) =>
          projectRuntime.executeStaff(...args),
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
            "Read bounded live terminal/process evidence for a direct report. Managers use branch for assigned Leads; otherwise use a stable target.",
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
              { action: "inspect", ...p },
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
            "Read bounded persisted Pi conversation/tool evidence for a direct report. Managers use branch for assigned Leads; otherwise use a stable target.",
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
              { action: "transcript", ...p },
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
            "Send nonterminal instructions, corrections or coordination to a verified direct report. For an active assigned Lead, use its assignment branch, even when its current execution is idle or done; active work is steered cooperatively. This does not perform lifecycle recovery. Managers use branch for assigned Leads; otherwise use a stable target. Result refs mentioned only in report text are not automatically transferable evidence. Attach refs only when available; otherwise request follow-up from the direct report in message text.",
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
          name: "delegate_work",
          label: "delegate work",
          description:
            "Start a new work assignment, reusing an unoccupied Herdr worktree when available. The initial task and supplied files become required assignment evidence; use resume_work for existing work.",
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
          name: "resume_work",
          label: "resume work",
          description:
            "Recover a paused existing project assignment using its original branch handle and a required fresh instruction. Restore the exact saved Lead session and checkout. If the Lead is already running when recovery executes, queue the instruction without relaunching it. The result distinguishes queue acceptance from recovery and delivery. Use message_staff for ordinary communication with known running Leads.",
          parameters: staffResumeParameters,
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
              {
                action: "resume",
                branch: p.branch,
                definition: p.definition,
                message: p.message,
                files: p.files,
                retain: p.retain,
              },
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
          name: "integrate_branch",
          label: "integrate branch",
          description:
            "Integrate an assigned local branch into the verified primary branch using fast-forward Git, or a clean divergent merge when explicitly authorized. Supply the exact full source SHA accepted after validation. New integration requires a matching completed Lead handoff for that revision and no unresolved assigned execution; a visible SHA, idle status, or interim supervisor message is insufficient. If the handoff is missing or stale, wait for the normal completion handoff or request a fresh completion report; do not poll staff or integration tools. A completed handoff is not proof that tests passed or that the work is acceptable. A divergent merge may create a merge commit; actual conflicts are distinguished from divergent ancestry. Merge preflight failure/conflict occurs before stopping the Lead. If a later step fails after execution stops, it is not automatically restarted. Git integration does not prove tests or semantic acceptance. Verified integration triggers separately guarded cleanup; integration and cleanup can complete separately, so do not treat integration alone as full finalization. An already-integrated accepted SHA follows the existing guarded cleanup-recovery path.",
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
            "Stop the assigned Lead for an exact project branch and its owned execution tree while preserving project work, Pi session, branch, and worktree.",
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
              { action: "stop", branch: p.branch },
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
    }
    if (processRole === "lead") {
      const shutdownOptions = {
        clearStartupDefinitionRoster: () => {
          startupDefinitionRoster = undefined;
          modelCatalogSnapshot = undefined;
        },
        isLead: () => activeRole() === "lead" && !leadRuntime.roleSuspended,
      };
      const sessionTreeOptions = {
        isLead: () => activeRole() === "lead" && !leadRuntime.roleSuspended,
        appendRoleError: (ctx: ExtensionContext, error: unknown) =>
          appendDurableError(pi, ctx, "pi_herdsman_role_error", error),
      };
      const sessionStartOptions = {
        afterManagedSessionIdentityInitialized:
          lockHooks?.afterManagedSessionIdentityInitialized,
        rejectNativeAgentRestore: (ctx: ExtensionContext) => {
          const sessionId = ctx.sessionManager.getSessionId();
          try {
            if (
              !sessionAgentIdentity(ctx.sessionManager.getEntries(), sessionId)
            )
              return false;
            throw new Error(
              "This session belongs to a managed Agent but was restored without its authorized launch context. Execution is disabled. Recover the assignment through its original Lead using Herdsman's existing recovery controls.",
            );
          } catch (error) {
            appendDurableError(pi, ctx, "pi_herdsman_state_error", error);
            ctx.ui.notify(
              "Managed Agent session requires recovery by its original Lead; execution is disabled.",
              "error",
            );
            return true;
          }
        },
        autoActivateManager: (ctx: ExtensionContext) =>
          readEffectiveConfig(ctx).autoActivateManager,
        clearDefinitionRoster: () => {
          startupDefinitionRoster = undefined;
        },
        snapshotModelCatalog: (ctx: ExtensionContext) => {
          modelCatalogSnapshot = undefined;
          const text = sessionAgentModelCatalog(ctx, readConfig());
          if (text)
            modelCatalogSnapshot = {
              sessionId: ctx.sessionManager.getSessionId(),
              text,
            };
        },
        setDefinitionRoster: (roster: typeof startupDefinitionRoster) => {
          startupDefinitionRoster = roster;
        },
        isLead: () => activeRole() === "lead" && !leadRuntime.roleSuspended,
        isManagedAgent: () => false,
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
        supervisorToolNames: SUPERVISOR_TOOLS,
        onLeadRuntimeReady: (
          runtime: LeadRuntimeState,
          tools: typeof leadToolState,
        ) => {
          leadRuntime = runtime;
          leadToolState = tools;
        },
        controllerServices: {
          ...controllerServices,
          rootAgentAdmissionBlocked: () =>
            chiefStaffShutdownActive || pendingShutdownAdmission !== undefined,
        },
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
      pi.on("session_shutdown", () => {
        const pending = pendingShutdownAdmission;
        pendingShutdownAdmission = undefined;
        try {
          pending?.release();
        } catch {
          // The process is exiting; its exact lock claim is recovered on next use.
        }
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
        for (const destination of ["manager", "chief"] as const) {
          const name = `message_${destination}`;
          pi.registerTool({
            name,
            label: `message ${destination}`,
            exposure: "direct",
            defaultActive: false,
            description: `Send nonblocking material coordination to your ${destination}. Avoid routine progress updates and duplicate result announcements.`,
            executionMode: "sequential",
            parameters: supervisorMessageParameters,
            promptGuidelines: [FILE_HANDOFF_GUIDANCE],
            execute: async (
              id: string,
              p: any,
              signal: AbortSignal | undefined,
              update: unknown,
              ctx: ExtensionContext,
            ): Promise<any> => {
              try {
                return await leadRuntimes.coordinationRuntime!.supervisorMessage(
                  destination,
                  id,
                  p,
                  signal,
                  update,
                  ctx,
                );
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
              renderCoordinationCall(destination, "message", a, t, c),
            renderResult: (r: any, o: any, t: any, c: any) =>
              renderCoordinationResult(destination, "message", r, o, t, c),
          });
        }
        pi.registerTool({
          ...peerTool,
          name: "list_peers",
          label: "list peers",
          description:
            "List independently discovered eligible same-role peers, including eligible ordinary Leads or Managers on reachable saved Herdr machines. Remote Lead discovery requires verified ordinary, unassigned status; incomplete discovery is not proof that no peers exist. A reply-only originating Lead or Manager may also appear when an existing return correspondence allows a reply without independent discovery or current availability. Use only the exact target as a selector; labels do not verify identity, availability, or permission to initiate unrelated messages. Do not use for progress polling.",
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
              { action: "message", ...p },
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
  if (processRole !== "managed-agent") {
    registerSkillLoader(pi, () => activeRole() === "chief");
    return;
  }
  pi.registerTool({
    name: "read_evidence",
    label: "Read accepted evidence",
    exposure: "direct",
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
        const state = managedAgentIdentity(ctx);
        const scoped = authorizedScopedResult(
          params.ref,
          state.rootSessionId ?? "",
          accepted.effectiveEvidence,
          ctx.sessionManager.getBranch(),
          ctx.sessionManager.getSessionId(),
        );
        const page = readEvidencePage(
          accepted.effectiveEvidence,
          params.ref,
          params,
          scoped,
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
  const isVerifiedSession = registerManagedAgentRuntime(pi, {
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
  registerSkillLoader(pi, undefined, isVerifiedSession);
}
