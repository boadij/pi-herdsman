import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioNames = [
  "core",
  "continuation",
  "chief-tree",
  "supervisor-agent",
  "manager-recovery",
  "terminal-failure",
  "agent-terminal-failure",
  "manager-handoff",
  "agent-crash-recovery",
];
const SMOKE_MODEL_KEY = "pi-herdsman.smoke-model";
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_CHIEF_TREE_RESULT_BYTES = 16 * 1024;
const POLL_MS = 250;
const OBSERVATION_TIMEOUT_MS = 5_000;
const CONTROL_STALL_MS = 15_000;
const MODEL_STALL_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_MANAGER_READY_TIMEOUT_MS = 6 * 60_000;
const MAX_MANAGER_READY_TIMEOUT_MS = 10 * 60_000;
const MANAGER_DIAGNOSTIC_PREFIX = "[pi-herdsman-manager-diagnostic] ";
const HERDR_ROUTING_KEYS = [
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
];
const MANAGED_AGENT_IDENTITY_KEYS = [
  "PI_HERDSMAN_MAILBOX",
  "PI_HERDSMAN_RUN_ID",
  "PI_HERDSMAN_OWNER_SESSION_ID",
  "PI_HERDSMAN_OWNER_DISPLAY",
  "PI_HERDSMAN_LABEL",
  "PI_HERDSMAN_WORKSPACE_ID",
  "PI_HERDSMAN_AGENT_DEFINITION",
  "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_SUBAGENT_CHILD",
];

export function parseScenario(args) {
  if (args.length > 1) throw new Error(`unexpected smoke argument: ${args[1]}`);
  const scenario = args[0] ?? "core";
  if (!scenarioNames.includes(scenario))
    throw new Error(`unknown smoke scenario: ${scenario}`);
  return scenario;
}

export function parseSmokeArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: "string" },
      simulated: { type: "boolean" },
      "manager-ready-timeout-ms": { type: "string" },
      "manager-recovery-diagnostics": { type: "boolean" },
      "manager-external-removal": { type: "boolean" },
    },
  });
  const scenario = parseScenario(positionals);
  const simulated = values.simulated ?? false;
  if (simulated && values.model !== undefined)
    throw new Error("--simulated cannot be combined with --model");
  if (simulated && scenario === "manager-recovery")
    throw new Error("manager-recovery does not support --simulated");
  if (
    !simulated &&
    [
      "agent-terminal-failure",
      "manager-handoff",
      "agent-crash-recovery",
    ].includes(scenario)
  )
    throw new Error(`${scenario} requires --simulated`);
  const timeout = values["manager-ready-timeout-ms"];
  const managerReadyTimeoutMs =
    timeout === undefined ? undefined : Number(timeout);
  if (
    timeout !== undefined &&
    (scenario !== "manager-recovery" ||
      !/^\d+$/.test(timeout) ||
      !Number.isSafeInteger(managerReadyTimeoutMs) ||
      managerReadyTimeoutMs < 1 ||
      managerReadyTimeoutMs > MAX_MANAGER_READY_TIMEOUT_MS)
  )
    throw new Error(
      `--manager-ready-timeout-ms must be a positive integer no greater than ${MAX_MANAGER_READY_TIMEOUT_MS}, and is only valid for manager-recovery`,
    );
  const managerRecoveryDiagnostics =
    values["manager-recovery-diagnostics"] ?? false;
  if (managerRecoveryDiagnostics && scenario !== "manager-recovery")
    throw new Error(
      "--manager-recovery-diagnostics is only valid for manager-recovery",
    );
  const managerExternalRemoval = values["manager-external-removal"] ?? false;
  if (managerExternalRemoval && scenario !== "manager-recovery")
    throw new Error(
      "--manager-external-removal is only valid for manager-recovery",
    );
  return {
    scenario,
    model: values.model,
    simulated,
    managerReadyTimeoutMs,
    managerRecoveryDiagnostics,
    managerExternalRemoval,
  };
}

export function managerDiagnosticLines(contents) {
  if (typeof contents !== "string") return [];
  const safeLines = [];
  const seen = new Set();
  for (const line of contents.split(/\r?\n/)) {
    const prefixIndex = line.indexOf(MANAGER_DIAGNOSTIC_PREFIX);
    if (prefixIndex < 0) continue;
    let diagnostic;
    try {
      diagnostic = JSON.parse(
        line.slice(prefixIndex + MANAGER_DIAGNOSTIC_PREFIX.length),
      );
    } catch {
      continue;
    }
    let safe;
    if (
      [
        "session_start_reached",
        "initial_inbox_drain_start",
        "project_assignment_scope_start",
        "project_assignment_scope_complete",
        "project_assignment_topology_start",
        "project_assignment_topology_complete",
        "project_assignment_live_lead_start",
        "project_assignment_live_lead_complete",
      ].includes(diagnostic?.event)
    )
      safe = { event: diagnostic.event };
    else if (
      [
        "inbox_preflight",
        "inbox_preflight_recheck",
        "inbox_peer_presence",
      ].includes(diagnostic?.event) &&
      (diagnostic.event === "inbox_peer_presence"
        ? ["pass", "missing"]
        : diagnostic.event === "inbox_preflight_recheck"
          ? ["pass", "held", "stale"]
          : ["pass", "held"]
      ).includes(diagnostic.reason)
    )
      safe = { event: diagnostic.event, reason: diagnostic.reason };
    else if (
      ["inbox_candidates", "inbox_drain_complete"].includes(
        diagnostic?.event,
      ) &&
      Number.isInteger(diagnostic.count) &&
      diagnostic.count >= 0 &&
      diagnostic.count <= 1000 &&
      (diagnostic.event !== "inbox_drain_complete" ||
        typeof diagnostic.sessionStable === "boolean")
    )
      safe = {
        event: diagnostic.event,
        count: diagnostic.count,
        ...(diagnostic.event === "inbox_drain_complete"
          ? { sessionStable: diagnostic.sessionStable }
          : {}),
      };
    else if (
      diagnostic?.event === "inbox_catch" &&
      [
        "cleanup",
        "authorization",
        "send",
        "drain",
        "reconcile",
        "candidate_scan",
        "transaction",
      ].includes(diagnostic.category)
    )
      safe = { event: diagnostic.event, category: diagnostic.category };
    else if (
      diagnostic?.event === "project_assignment_authorization" &&
      ["authorized", "rejected", "error"].includes(diagnostic.outcome) &&
      [
        "matched",
        "target_or_workspace_mismatch",
        "lease_mismatch",
        "workspace_scope_mismatch",
        "assignment_evidence_mismatch",
        "worktree_topology_mismatch",
        "branch_placement_mismatch",
        "live_lead_mismatch",
        "workspace_placement_mismatch",
        "authorization_exception",
      ].includes(diagnostic.reason)
    )
      safe = {
        event: diagnostic.event,
        outcome: diagnostic.outcome,
        reason: diagnostic.reason,
      };
    else if (
      diagnostic?.event === "project_assignment_send" &&
      ["resolved", "rejected"].includes(diagnostic.outcome) &&
      typeof diagnostic.triggerTurn === "boolean"
    )
      safe = {
        event: diagnostic.event,
        outcome: diagnostic.outcome,
        triggerTurn: diagnostic.triggerTurn,
      };
    if (safe) {
      const safeLine =
        `${MANAGER_DIAGNOSTIC_PREFIX}${JSON.stringify(safe)}`.slice(0, 512);
      if (!seen.has(safeLine)) {
        seen.add(safeLine);
        safeLines.push(safeLine);
        if (safeLines.length > 16) seen.delete(safeLines.shift());
      }
    }
  }
  return safeLines;
}

export async function captureManagerLeadDiagnostics(
  ctx,
  paneId,
  readPane = nestedPaneText,
) {
  if (!ctx.managerRecoveryDiagnostics) return;
  ctx.managerRecovery.leadDiagnostics = [];
  try {
    ctx.managerRecovery.leadDiagnostics = managerDiagnosticLines(
      await readPane(ctx, paneId, "recent-unwrapped"),
    );
  } catch (error) {
    ctx.managerRecovery.leadDiagnosticsError = String(
      error?.message ?? error,
    ).slice(0, 200);
  }
}

export function formatSmokeFailure(error, stage) {
  const name = typeof error?.name === "string" ? error.name : typeof error;
  const message =
    typeof error?.message === "string" ? error.message : String(error);
  if (error?.code === "SMOKE_STALLED" || error?.code === "SMOKE_TIMEOUT") {
    const smoke = error.smoke ?? {};
    return `${name}: ${message}\nstage: ${smoke.stage ?? stage ?? "not recorded"}\nkind: ${error.code === "SMOKE_STALLED" ? "STALLED" : "TIMEOUT"}\nelapsed: ${smoke.elapsedMs ?? "unknown"}ms\ninactive: ${smoke.inactiveMs ?? "unknown"}ms\nlast progress: ${JSON.stringify(smoke.lastProgress ?? null)}\nlast evidence: ${JSON.stringify(smoke.lastEvidence ?? null)}\nlast observation error: ${smoke.lastObservationError ?? "none"}`;
  }
  return `stage: ${stage ?? "not recorded"}\nerror: ${name}: ${message}`;
}

function markStage(ctx, stage) {
  ctx.stage = stage;
}

function smokeWaitError(
  code,
  stage,
  startedAt,
  lastProgressAt,
  lastProgress,
  lastEvidence,
  lastObservationError,
) {
  const now = Date.now();
  const error = new Error(
    code === "SMOKE_STALLED"
      ? `${stage}: no meaningful progress`
      : `${stage}: hard deadline exceeded`,
  );
  error.code = code;
  error.smoke = {
    stage,
    elapsedMs: now - startedAt,
    inactiveMs: now - lastProgressAt,
    lastProgress,
    lastEvidence,
    lastObservationError,
  };
  return error;
}

function observationFailure(message) {
  const error = new Error(message);
  error.code = "SMOKE_OBSERVATION";
  return error;
}

export async function waitForEvidence(
  ctx,
  stage,
  inspect,
  { timeoutMs, stallMs, pollMs = POLL_MS },
) {
  markStage(ctx, stage);
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastProgress;
  let lastProgressKey;
  let lastEvidence;
  let lastObservationError;
  while (true) {
    const now = Date.now();
    if (now - startedAt >= timeoutMs)
      throw smokeWaitError(
        "SMOKE_TIMEOUT",
        stage,
        startedAt,
        lastProgressAt,
        lastProgress,
        lastEvidence,
        lastObservationError,
      );
    let observed;
    try {
      observed = await inspect();
    } catch (error) {
      if (error?.code !== "SMOKE_OBSERVATION") throw error;
      observed = { done: false, observationError: error.message };
    }
    lastObservationError = observed.observationError;
    if (Object.hasOwn(observed, "evidence")) lastEvidence = observed.evidence;
    if (Object.hasOwn(observed, "progress")) {
      const key = JSON.stringify(observed.progress);
      if (key !== lastProgressKey) {
        lastProgressKey = key;
        lastProgress = observed.progress;
        lastProgressAt = Date.now();
      }
    }
    if (Date.now() - startedAt >= timeoutMs)
      throw smokeWaitError(
        "SMOKE_TIMEOUT",
        stage,
        startedAt,
        lastProgressAt,
        lastProgress,
        lastEvidence,
        lastObservationError,
      );
    if (observed.done) return observed.value;
    const after = Date.now();
    if (after - lastProgressAt >= stallMs)
      throw smokeWaitError(
        "SMOKE_STALLED",
        stage,
        startedAt,
        lastProgressAt,
        lastProgress,
        lastEvidence,
        lastObservationError,
      );
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (after - startedAt))));
  }
}

export async function resolveSmokeModel(override, execute = run) {
  if (override !== undefined) {
    const model = override.trim();
    if (!model) throw new Error("smoke --model must not be empty");
    return model;
  }
  try {
    const { stdout } = await execute(
      "git",
      ["config", "--get", SMOKE_MODEL_KEY],
      { cwd: repoRoot },
    );
    const model = stdout.trim();
    if (model) return model;
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  throw new Error(
    `smoke model is not configured; run: git config --local ${SMOKE_MODEL_KEY} 'provider/model:thinking' or pass --model`,
  );
}

export function selectSmokeModel(args, execute = run) {
  return args.simulated
    ? Promise.resolve(`smoke-faux/${args.scenario}`)
    : resolveSmokeModel(args.model, execute);
}

export function isolatedEnv(base, paths) {
  const env = { ...base };
  for (const key of HERDR_ROUTING_KEYS) delete env[key];
  Object.assign(env, {
    HERDR_CONFIG_PATH: paths.herdrConfig,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_STATE_HOME: paths.xdgState,
    PI_CODING_AGENT_DIR: paths.piAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
  });
  return env;
}

export function nestedControlEnv(base, paths, sessionName) {
  return { ...isolatedEnv(base, paths), HERDR_SESSION: sessionName };
}

export function parentControlEnv(base, paths, sessionName) {
  const env = isolatedEnv(base, paths);
  delete env.HERDR_STARTUP_CWD;
  delete env.HERDR_MACOS_SERVER_CONTEXT;
  for (const key of MANAGED_AGENT_IDENTITY_KEYS) delete env[key];
  return { ...env, HERDR_SESSION: sessionName };
}

export function rootCandidateCommand(args) {
  return shellCommand([
    "env",
    ...MANAGED_AGENT_IDENTITY_KEYS.flatMap((key) => ["-u", key]),
    ...args,
  ]);
}

export function nestedHerdrApiSocketPath(paths, sessionName) {
  const directory = join(paths.xdgConfig, "herdr", "sessions", sessionName);
  for (const name of ["herdr.sock", "herdr-client.sock"]) {
    const bytesIncludingTerminator =
      Buffer.byteLength(join(directory, name)) + 1;
    assert.ok(
      bytesIncludingTerminator <= MAX_SOCKET_PATH_BYTES,
      `nested Herdr ${name} path is too long (${bytesIncludingTerminator} bytes; maximum ${MAX_SOCKET_PATH_BYTES})`,
    );
  }
  return join(directory, "herdr.sock");
}

export function candidateArgs(config) {
  assert.ok(
    typeof config.candidateExtension === "string" &&
      isAbsolute(config.candidateExtension),
    "candidate extension path must be absolute",
  );
  assert.ok(
    typeof config.herdrStateExtension === "string" &&
      isAbsolute(config.herdrStateExtension),
    "Herdr state extension path must be absolute",
  );
  const args = [
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    ...(config.simulatedProviderExtension
      ? ["--extension", config.simulatedProviderExtension]
      : []),
    ...(config.chiefTreeProbeExtension
      ? ["--extension", config.chiefTreeProbeExtension]
      : []),
    "--model",
    config.model,
  ];
  if (config.chiefTreeProbeExtension)
    assert.ok(
      isAbsolute(config.chiefTreeProbeExtension),
      "Chief tree probe path must be absolute",
    );
  return args;
}

export function chiefTreeProbeSource(resultPath) {
  assert.ok(
    typeof resultPath === "string" && isAbsolute(resultPath),
    "Chief tree result path must be absolute",
  );
  return `import { appendFileSync } from "node:fs";
const resultPath = ${JSON.stringify(resultPath)};
export default function (pi) {
  function record(label) {
    appendFileSync(resultPath, JSON.stringify({ label, tools: [...pi.getActiveTools()].sort() }) + "\\n");
  }
  pi.registerCommand("smoke-tools", {
    description: "Record active tools for isolated smoke",
    handler: async (args) => {
      if (["lead", "chief", "lead-after"].includes(args)) record(args);
    },
  });
  pi.on("session_tree", () => record("tree"));
}`;
}

export function parseToolSnapshots(contents) {
  assert.ok(
    typeof contents === "string" &&
      Buffer.byteLength(contents) <= MAX_CHIEF_TREE_RESULT_BYTES,
  );
  const snapshots = new Map();
  for (const line of contents.trim().split("\n")) {
    const { label, tools } = JSON.parse(line);
    assert.ok(["lead", "chief", "tree", "lead-after"].includes(label));
    assert.ok(Array.isArray(tools));
    assert.ok(tools.every((tool) => typeof tool === "string"));
    const normalized = [...tools].sort();
    const previous = snapshots.get(label);
    if (previous)
      assert.deepEqual(
        normalized,
        previous,
        `conflicting ${label} tool snapshots`,
      );
    else snapshots.set(label, normalized);
  }
  return snapshots;
}

export function distinctPaneCount(processes) {
  return new Set(processes.map(({ paneId }) => paneId)).size;
}

export function chiefTreeBranchPlan(
  contents,
  startupPrompt,
  startupMarker,
  chiefPrompt,
  chiefMarker,
) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const isAncestor = (ancestorId, descendantId) => {
    const visited = new Set();
    let parentId = byId.get(descendantId)?.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const userFor = (prompt) =>
    entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry.message.content) === prompt,
    );
  const answerFor = (user, marker) =>
    entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        isAncestor(user?.id, entry.id) &&
        entry.message.stopReason === "stop" &&
        messageText(entry.message.content)
          .split(/\r?\n/)
          .some((line) => line.trim() === marker),
    );
  const startupUser = userFor(startupPrompt);
  const startupAnswer = answerFor(startupUser, startupMarker);
  const chiefUser = userFor(chiefPrompt);
  const chiefAnswer = answerFor(chiefUser, chiefMarker);
  if (
    !startupUser ||
    !startupAnswer ||
    !chiefUser ||
    !chiefAnswer ||
    !isAncestor(startupAnswer.id, chiefUser.id) ||
    !isAncestor(chiefUser.id, chiefAnswer.id)
  )
    return {
      error:
        "saved transcript does not contain one completed Chief turn descended from the startup Lead branch",
    };
  const userPrompts = entries.filter(
    (entry) => entry.type === "message" && entry.message?.role === "user",
  );
  if (
    userPrompts.length !== 2 ||
    userPrompts[0]?.id !== startupUser.id ||
    userPrompts[1]?.id !== chiefUser.id
  )
    return { error: "saved transcript contains an unexpected user prompt" };
  const completedTurns = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.stopReason === "stop",
  );
  if (
    completedTurns.length !== 2 ||
    completedTurns[0]?.id !== startupAnswer.id ||
    completedTurns[1]?.id !== chiefAnswer.id
  )
    return {
      error: "saved transcript contains an unexpected completed model turn",
    };
  return { targetId: startupAnswer.id };
}

export function chiefTreeFooter(output) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = [...text.matchAll(/^[ \t]*\((\d+)\/(\d+)\)(?:[ \t]|$)/gm)];
  if (!matches.length) return null;
  const [, selected, total] = matches.at(-1);
  const position = Number(selected);
  const count = Number(total);
  return position > 0 && count > 0 && position <= count
    ? { selected: position, total: count }
    : null;
}

export function chiefTreeSelectedRow(output, marker) {
  output = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const expected = `assistant: ${marker}`;
  const rows = output.split(/\r?\n/).filter((line) => line.includes(expected));
  return rows.length === 1 && /^[ \t│├└─⊟⊞]*›\s/.test(rows[0]);
}

export function countChiefTreeEvents(contents, baseline = 0) {
  return (
    contents
      .split("\n")
      .filter(Boolean)
      .filter((line) => JSON.parse(line).label === "tree").length - baseline
  );
}

export function chiefTreeBranchTransition(
  text,
  snapshots,
  treeEventsBefore,
  treeEvents,
) {
  if (text.includes("Summarize branch?"))
    return {
      done: true,
      value: { state: "summary-dialog", treeEventsBefore, treeEvents },
      progress: { state: "summary-dialog" },
    };
  const treeLoaded = (snapshots?.has("tree") ?? false) && treeEvents > 0;
  return {
    done: treeLoaded,
    value: treeLoaded ? { state: "tree-loaded", treeEvents } : undefined,
    progress: { treeEvents, treeSnapshot: treeLoaded },
  };
}

export function staffDelegateResults(contents) {
  return sessionEntries(contents).flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "delegate_project" ||
      message.isError
    )
      return [];
    try {
      const value = JSON.parse(messageText(message.content));
      return value?.ok === true && value.action === "delegate" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function assertNoFailedProjectDelegation(contents, branch) {
  const entries = sessionEntries(contents);
  const callIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      Array.isArray(entry.message.content)
        ? entry.message.content
            .filter(
              (call) =>
                call?.type === "toolCall" &&
                call.name === "delegate_project" &&
                call.arguments?.branch === branch &&
                typeof call.id === "string",
            )
            .map((call) => call.id)
        : [],
    ),
  );
  const failed = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "delegate_project" &&
      callIds.has(entry.message.toolCallId) &&
      (entry.message.isError === true || entry.message.details?.ok === false),
  );
  if (!failed) return;

  const category =
    messageText(failed.message.content).trim() ===
    "Project assignment lock is in progress"
      ? "assignment_lock_occupied"
      : "tool_error";
  const error = new Error(`delegate_project failed (${category})`);
  error.code = "SMOKE_DELEGATION_FAILED";
  throw error;
}

export function managerAssignmentDiagnostics({
  worktree,
  result,
  identity,
  lead,
  supervisorCall,
  supervisorSuccess,
  supervisorResult,
  readiness,
  supervisorCallObserved,
  supervisorResultState,
  supervisorErrorCategory,
  supervisorUnstructuredErrorClass,
  readinessDeliveryObserved,
  candidateProcessCount,
  provenanceMatch,
  errorCategory,
  worktreeIdentityState,
  fauxSupervisorToolAvailability,
}) {
  return {
    expectedBranchWorktree: worktree ?? "not_observed",
    successfulCorrelatedDelegateProjectResult: result ?? "not_observed",
    assignmentIdentitySessionWorkspaceBranchMatch: identity ?? "not_observed",
    matchedLead: lead ?? "not_observed",
    messageSupervisorCall: supervisorCall ?? "not_observed",
    messageSupervisorSuccess: supervisorSuccess ?? "not_observed",
    messageSupervisorResult: supervisorResult ?? "not_called",
    exactManagerReadinessDelivery: readiness ?? "not_observed",
    fauxSupervisorToolAvailability:
      fauxSupervisorToolAvailability === "not_offered"
        ? "not_offered"
        : "not_observed",
    supervisorCallObserved: supervisorCallObserved ?? false,
    supervisorResultState: supervisorResultState ?? "not_observed",
    supervisorErrorCategory: supervisorErrorCategory ?? "none",
    ...([
      "abort_error",
      "lock_occupied",
      "dispatch_error",
      "unstructured_error_unknown",
    ].includes(supervisorUnstructuredErrorClass)
      ? { supervisorUnstructuredErrorClass }
      : {}),
    supervisorHandlerBranchStatus: "not_observed",
    supervisorPersistedErrorCategoryPresent: false,
    supervisorPersistedErrorCategory: "not_observed",
    readinessDeliveryObserved: readinessDeliveryObserved ?? false,
    candidateProcessCount: candidateProcessCount ?? "not_observed",
    candidateProcessProvenanceMatch: provenanceMatch ?? "not_evaluated",
    errorCategory: errorCategory ?? "none",
    worktreeIdentityState: worktreeIdentityState ?? "not_observed",
  };
}

export function managerHandoffSupervisorToolAvailability(contents) {
  if (typeof contents !== "string") return "not_observed";
  for (const line of contents.split(/\r?\n/)) {
    try {
      const attempt = JSON.parse(line);
      if (
        attempt?.model === "manager-handoff-lead" &&
        attempt.supervisorToolAvailability === "not_offered"
      )
        return "not_offered";
    } catch {
      // Ignore malformed and unrelated attempt records.
    }
  }
  return "not_observed";
}

const STRUCTURED_TOOL_ERROR_CATEGORIES = new Set([
  "not_running_inside_herdr",
  "agent_label_exists",
  "pane_not_ready",
  "target_not_found",
  "target_ambiguous",
  "rollback_failure",
  "agent_busy",
  "invalid_request",
  "incompatible_build",
  "internal_failure",
]);

export function supervisorMessageDiagnostics(path, expectedSessionId, text) {
  let session;
  try {
    session = SessionManager.open(path);
  } catch {
    return emptySupervisorMessageDiagnostics(false);
  }
  if (session.getHeader()?.id !== expectedSessionId)
    return emptySupervisorMessageDiagnostics(false);

  const entries = session.getBranch();
  const calls = entries.flatMap((entry, index) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content
          .filter(
            (block) =>
              block?.type === "toolCall" &&
              block.name === "message_supervisor" &&
              block.arguments?.message === text &&
              typeof block.id === "string",
          )
          .map((call) => ({ call, index }))
      : [],
  );
  const candidate = calls.length === 1 ? calls[0] : undefined;
  const matchingCallIdCount = candidate
    ? entries.reduce(
        (count, entry) =>
          count +
          (entry.type === "message" && entry.message?.role === "assistant"
            ? (Array.isArray(entry.message.content)
                ? entry.message.content
                : []
              ).filter(
                (block) =>
                  block?.type === "toolCall" && block.id === candidate.call.id,
              ).length
            : 0),
        0,
      )
    : 0;
  const match = matchingCallIdCount === 1 ? candidate : undefined;
  const call = match?.call;
  const correlatedResults = call
    ? entries.flatMap((entry, index) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolCallId === call.id
          ? [{ message: entry.message, index }]
          : [],
      )
    : [];
  const matchingResult =
    correlatedResults.length === 1 &&
    correlatedResults[0].message.toolName === "message_supervisor" &&
    correlatedResults[0].index > match.index
      ? correlatedResults[0].message
      : undefined;
  const result = matchingResult;
  const success = result && !result.isError && result.details?.ok !== false;
  const failed =
    result && (result.isError === true || result.details?.ok === false)
      ? result
      : undefined;
  const category = failed?.details?.error?.category;
  const errorDetails = failed?.details?.error;
  const handlerBranchStatus = errorDetails?.branchStatus;
  const categoryPresent =
    errorDetails !== null &&
    typeof errorDetails === "object" &&
    Object.hasOwn(errorDetails, "category");
  const resultText =
    typeof result?.content === "string"
      ? result.content
      : Array.isArray(result?.content)
        ? result.content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .filter((value) => typeof value === "string")
            .join("\n")
        : "";
  const unstructuredErrorClass =
    failed?.isError === true &&
    !STRUCTURED_TOOL_ERROR_CATEGORIES.has(category) &&
    resultText
      ? /\bAbortError\b/u.test(resultText)
        ? "abort_error"
        : /\bProcessLockOccupiedError\b/u.test(resultText)
          ? "lock_occupied"
          : /\btool\s+["']?message_supervisor["']?\s+(?:was\s+)?not found\b|\bmessage_supervisor\b.{0,40}\b(?:not found|unavailable)\b/iu.test(
                resultText,
              )
            ? "dispatch_error"
            : "unstructured_error_unknown"
      : "not_applicable";
  return {
    supervisorSessionHeaderMatches: true,
    supervisorCallObserved: !!call,
    supervisorResultState: !call
      ? "missing"
      : success
        ? "success"
        : failed
          ? "error"
          : correlatedResults.length === 0
            ? "pending"
            : "not_observed",
    supervisorErrorCategory:
      failed && !success
        ? STRUCTURED_TOOL_ERROR_CATEGORIES.has(category)
          ? category
          : "tool_error"
        : "none",
    supervisorHandlerBranchStatus:
      handlerBranchStatus === "operation_error_returned"
        ? handlerBranchStatus
        : "not_observed",
    supervisorPersistedErrorCategoryPresent: categoryPresent,
    supervisorPersistedErrorCategory:
      categoryPresent && STRUCTURED_TOOL_ERROR_CATEGORIES.has(category)
        ? category
        : "not_observed",
    ...(unstructuredErrorClass !== "not_applicable"
      ? { supervisorUnstructuredErrorClass: unstructuredErrorClass }
      : {}),
  };
}

function emptySupervisorMessageDiagnostics(headerMatches) {
  return {
    supervisorSessionHeaderMatches: headerMatches,
    supervisorCallObserved: false,
    supervisorResultState: headerMatches ? "missing" : "not_observed",
    supervisorErrorCategory: "none",
    supervisorHandlerBranchStatus: "not_observed",
    supervisorPersistedErrorCategoryPresent: false,
    supervisorPersistedErrorCategory: "not_observed",
  };
}

export function managerAssignmentIdentity(row, worktree, branch) {
  if (!row) return "not_observed";
  return String(
    row.branch === branch &&
      !!row.session &&
      !!row.workspace_id &&
      worktree?.open_workspace_id === row.workspace_id,
  );
}

export function managerAssignmentBranchMismatch(row, branch) {
  return !!row && row.branch !== branch;
}

export function staffActionResults(contents, toolName, action, prompt) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const promptEntry =
    prompt === undefined
      ? null
      : entries.find(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "user" &&
            messageText(entry.message.content) === prompt,
        );
  const descendsFromPrompt = (entry) => {
    if (prompt === undefined) return true;
    if (!promptEntry) return false;
    const visited = new Set();
    let parentId = entry.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === promptEntry.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  return entries.flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== toolName ||
      message.isError ||
      !descendsFromPrompt(entry)
    )
      return [];
    const value = message.details;
    return value?.ok === true && value.action === action ? [value] : [];
  });
}

export function projectMessageEntries(contents, branch, sessionId) {
  return sessionEntries(contents).filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === sessionId,
  );
}

export function retirementNoticeEntries(
  contents,
  repoKey,
  branch,
  assignmentId,
) {
  return sessionEntries(contents).filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_retired" &&
      entry.details?.repoKey === repoKey &&
      entry.details?.branch === branch &&
      entry.details?.assignmentId === assignmentId,
  );
}

export function assertPassiveRetirementEvidence(
  before,
  after,
  repoKey,
  branch,
  assignmentId,
) {
  const notices = retirementNoticeEntries(after, repoKey, branch, assignmentId);
  assert.equal(notices.length, 1, "expected one exact retirement notice");
  assert.equal(notices[0].display, false);
  assert.deepEqual(
    sessionEntries(after).filter((entry) => entry.type === "message"),
    sessionEntries(before).filter((entry) => entry.type === "message"),
    "passive retirement must not add a user, assistant, system, or tool-result message",
  );
  return notices[0];
}

export function retainedProjectMessageRecord(records, branch, sessionId, text) {
  return (
    records.find(
      (record) =>
        record?.branch === branch &&
        record?.fromSessionId === sessionId &&
        record?.text === text &&
        typeof record?.id === "string" &&
        record.id.length > 0,
    ) ?? null
  );
}

export function managerHandoffRetainedRecord(
  records,
  repoKey,
  branch,
  sessionId,
  text,
) {
  const matches = records.filter(
    (record) =>
      record?.repoKey === repoKey &&
      record?.branch === branch &&
      record?.fromSessionId === sessionId &&
      record?.text === text &&
      typeof record?.id === "string" &&
      record.id.length > 0,
  );
  if (matches.length > 1)
    throw new Error("Manager handoff retained message is ambiguous");
  return matches[0] ?? null;
}

export function managerHandoffDeliveredEntry(
  contents,
  repoKey,
  branch,
  sessionId,
  messageId,
  text,
) {
  return (
    sessionEntries(contents).find(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-herdsman-project_message" &&
        entry.details?.repoKey === repoKey &&
        entry.details?.branch === branch &&
        entry.details?.fromSessionId === sessionId &&
        entry.details?.id === messageId &&
        entry.content ===
          `Project ${branch} from lead ${sessionId}:\n\n${text}`,
    ) ?? null
  );
}

export function managerCleanupTarget(
  worktrees,
  branch,
  worktreePath,
  workspaceId,
  retirementRequested = false,
) {
  if (typeof worktreePath !== "string" || !worktreePath)
    throw new Error("captured worktree path is unavailable");
  if (typeof workspaceId !== "string" || !workspaceId)
    throw new Error("captured workspace identity is unavailable");
  const matches = worktrees.filter((item) => item.branch === branch);
  if (matches.length === 0 && retirementRequested) return null;
  if (matches.length !== 1)
    throw new Error("exact branch must identify one worktree");
  const [target] = matches;
  if (target.path !== worktreePath)
    throw new Error("exact branch worktree path does not match captured path");
  if (typeof target.open_workspace_id !== "string" || !target.open_workspace_id)
    throw new Error("exact branch worktree has no workspace identity");
  if (target.open_workspace_id !== workspaceId)
    throw new Error(
      "exact branch worktree workspace identity does not match captured identity",
    );
  return target;
}

export async function removeManagerRecoveryWorktree(
  ctx,
  worktrees,
  execute = run,
  control = nestedCommand,
) {
  const { branch, worktreePath, workspaceId } = ctx.managerRecovery;
  assert.equal(branch, ctx.owned.managerBranch);
  assert.equal(worktreePath, ctx.owned.managerWorktreePath);
  assert.equal(workspaceId, ctx.owned.managerWorkspaceId);
  const target = managerCleanupTarget(
    worktrees.map((item) => ({
      ...item,
      path: item.path ?? item.worktree_path,
    })),
    branch,
    worktreePath,
    workspaceId,
  );
  assert.ok(target, "removal requires the exact currently owned worktree");
  if (ctx.managerExternalRemoval) {
    const primary = await realpath(ctx.primaryCheckoutPath);
    assert.equal(
      primary,
      await realpath(join(ctx.paths.root, "project")),
      "Git removal requires the isolated smoke repository",
    );
    const checkout = await realpath(worktreePath);
    assert.notEqual(checkout, primary, "cannot remove the primary checkout");
    const top = await execute("git", ["rev-parse", "--show-toplevel"], {
      cwd: checkout,
    });
    assert.equal(await realpath(top.stdout.trim()), checkout);
    const currentBranch = await execute("git", ["branch", "--show-current"], {
      cwd: checkout,
    });
    assert.equal(
      currentBranch.stdout.trim(),
      branch,
      "checkout branch changed before removal",
    );
    const commonArgs = [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ];
    const primaryCommon = await execute("git", commonArgs, { cwd: primary });
    const checkoutCommon = await execute("git", commonArgs, { cwd: checkout });
    assert.ok(
      isAbsolute(primaryCommon.stdout.trim()) &&
        isAbsolute(checkoutCommon.stdout.trim()),
    );
    assert.equal(
      await realpath(checkoutCommon.stdout.trim()),
      await realpath(primaryCommon.stdout.trim()),
      "checkout belongs to another Git repository",
    );
    ctx.owned.managerWorktreeRetirementRequested = true;
    return execute("git", ["worktree", "remove", "--", checkout], {
      cwd: primary,
    });
  }
  ctx.owned.managerWorktreeRetirementRequested = true;
  return control(ctx, ["worktree", "remove", "--workspace", workspaceId]);
}

export function captureTerminalFailureWorktree(ctx, worktrees, branch) {
  const matches = worktrees.filter((item) => item.branch === branch);
  if (matches.length === 0) return null;
  if (matches.length !== 1)
    throw new Error("exact branch must identify one worktree");
  const [worktree] = matches;
  const path = worktree.path ?? worktree.worktree_path;
  const workspaceId = worktree.open_workspace_id;
  if (
    (path !== undefined && path !== null && typeof path !== "string") ||
    (workspaceId !== undefined &&
      workspaceId !== null &&
      typeof workspaceId !== "string")
  )
    throw new Error("exact branch worktree identity is malformed");
  if (!path || !workspaceId)
    throw observationFailure("exact branch worktree identity is incomplete");
  captureTerminalFailureAssignment(ctx, path, workspaceId);
  return worktree;
}

export function captureManagerHandoffWorktree(
  ctx,
  worktrees,
  branch,
  expectedWorkspaceId,
) {
  const worktree = captureTerminalFailureWorktree(ctx, worktrees, branch);
  if (!worktree) return null;
  if (
    expectedWorkspaceId !== undefined &&
    worktree.open_workspace_id !== expectedWorkspaceId
  )
    throw new Error(
      "Manager assignment workspace does not match exact worktree",
    );
  return worktree;
}

export function captureTerminalFailureAssignment(ctx, path, workspaceId) {
  if (typeof path !== "string" || !path || !workspaceId)
    throw new Error("exact assigned worktree identity is incomplete");
  if (ctx.owned.managerWorktreePath || ctx.owned.managerWorkspaceId) {
    if (
      ctx.owned.managerWorktreePath !== path ||
      ctx.owned.managerWorkspaceId !== workspaceId
    )
      throw new Error(
        "exact assigned worktree identity conflicts with captured identity",
      );
    return;
  }
  ctx.owned.managerWorktreePath = path;
  ctx.owned.managerWorkspaceId = workspaceId;
  ctx.owned.managerWorktreeRetirementRequested = false;
}

export function parentHostPaneReadOptions(parentEnv) {
  return { env: parentEnv, timeout: OBSERVATION_TIMEOUT_MS };
}

export async function readParentHostPane(ctx, paneId, execute = run) {
  return execute(
    "herdr",
    ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "80"],
    parentHostPaneReadOptions(ctx.parentEnv),
  );
}

export async function captureTerminalFailureTopology(
  ctx,
  branch,
  execute = nestedCommand,
) {
  const topology = await execute(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  return captureTerminalFailureWorktree(ctx, topology.worktrees ?? [], branch);
}

export async function terminalFailureAssignmentPoll(
  ctx,
  branch,
  root,
  agents,
  execute = nestedCommand,
  getAgentSessionId = agentSessionId,
) {
  const session = await root();
  const delegated = session
    ? staffDelegateResults(session.contents).filter(
        (item) => item.branch === branch,
      )
    : [];
  try {
    await captureTerminalFailureTopology(ctx, branch, execute);
  } catch {
    // Assignment verification remains authoritative; retain cleanup evidence when observable.
  }
  if (session) assertNoFailedProjectDelegation(session.contents, branch);
  let child;
  if (delegated.length === 1)
    for (const agent of await agents())
      if ((await getAgentSessionId(ctx, agent)) === delegated[0].session) {
        child = agent;
        break;
      }
  let processObservation;
  if (child?.pane_id) {
    try {
      const info = await execute(ctx, [
        "pane",
        "process-info",
        "--pane",
        child.pane_id,
      ]);
      const matches = candidateProcess(
        info,
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      if (matches.length === 1)
        processObservation = {
          paneId: child.pane_id,
          processes: [{ pid: matches[0].pid }],
        };
    } catch {
      // The existing evidence poll retries while the assigned Lead is starting.
    }
  }
  return {
    done: !!child && !!processObservation,
    value: { delegated: delegated[0], child, processObservation },
    progress: { delegationCount: delegated.length },
    evidence: session ? summarizeSession(session.contents) : null,
  };
}

export async function prepareManagerRepository(paths, execute = run) {
  const cwd = join(paths.root, "project");
  await mkdir(cwd);
  await execute("git", ["init", "--initial-branch=main", cwd]);
  await execute(
    "git",
    [
      "-c",
      "user.name=Herdsman Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Smoke root",
    ],
    { cwd },
  );
  return cwd;
}

export function assertManagerFreshPrimary(
  workspaceId,
  primaryCheckoutPath,
  workspace,
  topology,
) {
  assert.equal(workspace?.workspace_id, workspaceId);
  const repoKey = topology?.source?.repo_key;
  assert.ok(
    typeof repoKey === "string" && repoKey.length > 0,
    "worktree source repo key must be a non-empty string",
  );
  assert.ok(topology?.source?.repo_name);
  assert.equal(topology?.source?.source_workspace_id, workspaceId);
  const sourceCheckoutPath = topology?.source?.source_checkout_path;
  assert.ok(
    typeof sourceCheckoutPath === "string" &&
      sourceCheckoutPath.length > 0 &&
      isAbsolute(sourceCheckoutPath),
    "worktree source checkout path must be a non-empty absolute path",
  );
  assert.equal(resolve(sourceCheckoutPath), primaryCheckoutPath);
  assert.ok(Array.isArray(topology.worktrees));
  assert.ok(
    topology.worktrees.length <= 1,
    "bootstrap must have no linked worktrees",
  );
  assert.ok(
    topology.worktrees.every(
      (item) =>
        !item.open_workspace_id || item.open_workspace_id === workspaceId,
    ),
    "bootstrap unexpectedly contains a linked workspace",
  );
  return repoKey;
}

export async function deleteBranchIfPresent(
  branch,
  execute = run,
  cwd = repoRoot,
) {
  try {
    await execute(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd },
    );
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
  await execute("git", ["branch", "-D", branch], { cwd });
  return true;
}

export function hasSuccessfulSupervisorMessage(contents, text) {
  const entries = sessionEntries(contents);
  const calls = entries.flatMap((entry) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content.filter(
          (block) =>
            block?.type === "toolCall" &&
            block.name === "message_supervisor" &&
            block.arguments?.message === text,
        )
      : [],
  );
  return calls.some((call) =>
    entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "message_supervisor" &&
        entry.message.toolCallId === call.id &&
        !entry.message.isError,
    ),
  );
}

export function supervisorMessageCallStatus(contents, text) {
  const entries = sessionEntries(contents);
  const calls = entries.flatMap((entry) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content.filter(
          (block) =>
            block?.type === "toolCall" &&
            block.name === "message_supervisor" &&
            block.arguments?.message === text,
        )
      : [],
  );
  if (!calls.length) return "not_called";
  for (const call of calls) {
    const result = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "message_supervisor" &&
        entry.message.toolCallId === call.id,
    );
    if (result) return result.message.isError ? "error" : "success";
  }
  return "pending";
}

export function leadReadyCompleted(contents, text) {
  const entries = sessionEntries(contents);
  const calls = entries.flatMap((entry, index) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content
          .filter(
            (block) =>
              block?.type === "toolCall" &&
              block.name === "message_supervisor" &&
              block.arguments?.message === text,
          )
          .map((block) => ({ id: block.id, index }))
      : [],
  );
  const resultIndex = entries.findIndex(
    (entry, index) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "message_supervisor" &&
      !entry.message.isError &&
      calls.some(
        (call) => call.index < index && call.id === entry.message.toolCallId,
      ),
  );
  return (
    resultIndex >= 0 &&
    entries
      .slice(resultIndex + 1)
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message.stopReason === "stop",
      )
  );
}

export function verifiedLeadSession(childSession, expectedSession) {
  return (
    !!childSession &&
    typeof expectedSession === "string" &&
    expectedSession.length > 0 &&
    childSession.id === expectedSession
  );
}

export function managerReadyAnswer(contents, branch, leadSessionId) {
  const entries = sessionEntries(contents);
  const receipt = entries.findIndex(
    (entry) =>
      typeof leadSessionId === "string" &&
      leadSessionId.length > 0 &&
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === leadSessionId &&
      entry.content ===
        `Project ${branch} from lead ${leadSessionId}:\n\nMANAGER_RECOVERY_READY`,
  );
  const readyMarkers = entries.flatMap((entry, index) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    messageText(entry.message.content)
      .split(/\r?\n/)
      .some((line) => line.trim() === "PI_HERDSMAN_MANAGER_RECOVERY_READY")
      ? [{ entry, index }]
      : [],
  );
  const answer = readyMarkers.find(
    ({ entry }) => entry.message.stopReason === "stop",
  )?.entry;
  const answerAfterReceipt =
    receipt < 0
      ? null
      : (readyMarkers.find(
          ({ entry, index }) =>
            index > receipt && entry.message.stopReason === "stop",
        )?.entry ?? null);
  const prematureReady = readyMarkers.some(
    ({ index }) => receipt < 0 || index < receipt,
  );
  const prematureFinish = entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      Array.isArray(entry.message.content) &&
      entry.message.content.some(
        (block) =>
          block?.type === "toolCall" &&
          block.name === "message_staff" &&
          block.arguments?.message === "MANAGER_RECOVERY_FINISH",
      ),
  );
  return {
    receipt: receipt >= 0,
    answer: answer ?? null,
    answerAfterReceipt,
    prematureReady,
    prematureFinish,
  };
}

export function managerReadyEntryEvidence(contents, branch, leadSessionId) {
  const entries = sessionEntries(contents);
  const receiptText = `Project ${branch} from lead ${leadSessionId}:\n\nMANAGER_RECOVERY_READY`;
  const receipts = [];
  const markers = [];
  entries.forEach((entry, index) => {
    if (
      typeof leadSessionId === "string" &&
      leadSessionId.length > 0 &&
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === leadSessionId &&
      entry.content === receiptText
    )
      receipts.push(index);
    if (
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      messageText(entry.message.content).includes(
        "PI_HERDSMAN_MANAGER_RECOVERY_READY",
      )
    )
      markers.push(index);
  });
  const centers = [
    ...receipts.slice(-1),
    ...markers.slice(0, 1),
    ...markers.slice(-2),
  ];
  const indices = new Set();
  for (const center of centers)
    for (
      let index = Math.max(0, center - 2);
      index <= Math.min(entries.length - 1, center + 2);
      index++
    )
      indices.add(index);
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => {
      const entry = entries[index];
      return {
        index,
        id: entry.id ?? null,
        parentId: entry.parentId ?? null,
        type: entry.type ?? null,
        customType: entry.customType ?? null,
        role: entry.message?.role ?? null,
        stopReason: entry.message?.stopReason ?? null,
        receipt: receipts.includes(index),
        readyMarker:
          entry.type === "message" &&
          messageText(entry.message?.content).includes(
            "PI_HERDSMAN_MANAGER_RECOVERY_READY",
          ),
      };
    });
}

function shellCommand(args) {
  assert.ok(
    Array.isArray(args) &&
      args.length > 0 &&
      args.every((arg) => typeof arg === "string"),
  );
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

function sessionEntries(contents) {
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function isPackageReadPath(path, cwd) {
  return (
    typeof path === "string" &&
    typeof cwd === "string" &&
    resolve(cwd, path) === resolve(cwd, "package.json")
  );
}

export function managerProjectMessageSettled(
  contents,
  branch,
  fromSessionId,
  marker,
) {
  const entries = sessionEntries(contents);
  const receipt = entries.find(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === fromSessionId &&
      String(entry.content).includes(marker),
  );
  if (!receipt?.id) return false;
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  return entries.some((entry) => {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.stopReason !== "stop"
    )
      return false;
    const visited = new Set();
    let parentId = entry.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === receipt.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  });
}

export function savedSessionHeaderEvidence(contents, expectedSessionId) {
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  return {
    expectedSessionId,
    actualSessionId: typeof header?.id === "string" ? header.id : null,
    sessionHeaderFound: !!header,
    sessionIdMatches: header?.id === expectedSessionId,
  };
}

export function continuationSessionEvidence(contents, expectedSessionId, task) {
  const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const taskFound = typeof task === "string" && normalize(task).length > 0;
  const header = savedSessionHeaderEvidence(contents, expectedSessionId);
  return {
    sessionHeaderFound: header.sessionHeaderFound,
    sessionIdMatches: header.sessionIdMatches,
    continuationTaskFound: taskFound,
    taskInstructionFound:
      taskFound &&
      sessionEntries(contents).some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "user" &&
          normalize(messageText(entry.message.content)).includes(
            normalize(task),
          ),
      ),
  };
}

export function correlatedContinuationTask(
  contents,
  resultId,
  expectedSessionId,
  prompt,
) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const ancestors = [];
  const visited = new Set();
  let entry = byId.get(resultId);
  let promptFound = false;
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    if (
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt
    ) {
      promptFound = true;
      break;
    }
    ancestors.unshift(entry);
    entry = byId.get(entry.parentId);
  }
  if (!promptFound) return null;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const message = ancestors[index].message;
    if (
      ancestors[index].type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "continue_agent" ||
      message.isError ||
      message.details?.ok !== true ||
      message.details.action !== "continue" ||
      message.details.session_id !== expectedSessionId
    )
      continue;
    for (const candidate of ancestors.slice(0, index).reverse()) {
      if (
        candidate.type !== "message" ||
        candidate.message?.role !== "assistant" ||
        !Array.isArray(candidate.message.content)
      )
        continue;
      const call = candidate.message.content.find(
        (block) =>
          block?.type === "toolCall" &&
          block.name === "continue_agent" &&
          typeof block.id === "string" &&
          block.id === message.toolCallId,
      );
      if (!call) continue;
      const task = call.arguments?.task;
      // Keep the exact task in memory only; reject oversized tasks rather than truncate them.
      return typeof task === "string" &&
        task.trim() &&
        Buffer.byteLength(task) <= 16 * 1024
        ? task
        : null;
    }
  }
  return null;
}

async function sessionPathEvidence(ctx, path, expectedSessionId) {
  const absolutePath = resolve(path);
  const isolatedSessions = resolve(ctx.paths.piSessions);
  const relativePath = relative(isolatedSessions, absolutePath);
  const evidence = {
    path: absolutePath,
    exists: null,
    ...savedSessionHeaderEvidence("", expectedSessionId),
  };
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    return { ...evidence, error: "outside isolated session directory" };

  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return { ...evidence, exists: false };
    return { ...evidence, error: String(error.message).slice(0, 200) };
  }
  evidence.exists = true;
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_SESSION_BYTES
  )
    return { ...evidence, error: "not a bounded regular session file" };
  try {
    return {
      ...evidence,
      ...savedSessionHeaderEvidence(
        await readFile(absolutePath, "utf8"),
        expectedSessionId,
      ),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { ...evidence, exists: false };
    return { ...evidence, error: String(error.message).slice(0, 200) };
  }
}

export async function managerChildSessionEvidence(
  ctx,
  agents,
  workspaceId,
  expectedSessionId,
) {
  const candidates = [];
  for (const agent of agents
    .filter((item) => item.workspace_id === workspaceId)
    .slice(0, 10)) {
    const identity = agent.agent_session;
    const candidate = {
      identityKind: identity?.kind ?? null,
      reportedSessionId:
        identity?.kind === "id" && typeof identity.value === "string"
          ? identity.value
          : null,
    };
    if (identity?.kind === "path" && typeof identity.value === "string")
      Object.assign(
        candidate,
        await sessionPathEvidence(ctx, identity.value, expectedSessionId),
      );
    else if (identity?.kind === "id" && typeof identity.value === "string") {
      try {
        const session = await exactIsolatedSession(ctx, identity.value);
        if (session)
          Object.assign(candidate, {
            path: session.path,
            exists: true,
            ...savedSessionHeaderEvidence(session.contents, expectedSessionId),
          });
      } catch (error) {
        candidate.error = String(error.message).slice(0, 200);
      }
    }
    candidates.push(candidate);
  }

  let expectedSessionFile = null;
  try {
    const session = await exactIsolatedSession(ctx, expectedSessionId);
    if (session)
      expectedSessionFile = {
        path: session.path,
        exists: true,
        ...savedSessionHeaderEvidence(session.contents, expectedSessionId),
      };
  } catch (error) {
    expectedSessionFile = { error: String(error.message).slice(0, 200) };
  }
  return { workspaceId, expectedSessionId, candidates, expectedSessionFile };
}

function messageText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";
}

export function acceptsFailedAgentHandoff(
  entry,
  requestId,
  sessionId,
  ownerSessionId,
) {
  const details = entry?.details;
  return (
    entry?.type === "custom_message" &&
    entry.customType === "pi-herdsman-agent-result" &&
    details?.requestId === requestId &&
    details?.piSessionId === sessionId &&
    details?.ownerSessionId === ownerSessionId &&
    details?.agentLabel === "smoke-terminal-agent" &&
    details?.agentDefinition === "smoke-failure-agent" &&
    details?.status === "failed" &&
    details?.error?.code === "execution_error" &&
    messageText(entry.content).startsWith(
      `Agent result · agent=smoke-terminal-agent · definition=smoke-failure-agent · session=${sessionId} · status=failed`,
    )
  );
}

export function failedAgentHandoff(
  entries,
  requestId,
  sessionId,
  ownerSessionId,
) {
  const handoffs = entries.filter(
    (entry) =>
      entry?.type === "custom_message" &&
      entry.customType === "pi-herdsman-agent-result" &&
      entry.details?.requestId === requestId &&
      entry.details?.piSessionId === sessionId,
  );
  if (handoffs.length > 1)
    throw new Error("Agent assignment delivered multiple final results");
  if (handoffs.length === 0) return null;
  if (
    !acceptsFailedAgentHandoff(
      handoffs[0],
      requestId,
      sessionId,
      ownerSessionId,
    )
  )
    throw new Error("Agent assignment delivered the wrong terminal outcome");
  return handoffs[0];
}

export function agentRetirementConverged({
  matchingAgents,
  panePresent,
  processAlive,
  mailboxPending,
}) {
  return (
    matchingAgents === 0 &&
    panePresent === false &&
    processAlive === false &&
    mailboxPending === false
  );
}

async function exactAgentMailboxPending(ctx, identity) {
  const root = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "mailboxes-v5",
  );
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const dir of dirs) {
    if (!/^[0-9a-f]{32}$/.test(dir.name)) continue;
    if (dir.isSymbolicLink())
      throw new Error("Agent mailbox inventory contains a symlink");
    if (!dir.isDirectory()) continue;
    const mailbox = join(root, dir.name);
    let state;
    try {
      const path = join(mailbox, "state.json");
      const details = await lstat(path);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > 64 * 1024
      )
        throw new Error("exact Agent mailbox state is not a safe file");
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      state?.ownerSessionId === identity.ownerSessionId &&
      state.agentLabel === "smoke-terminal-agent" &&
      state.piSessionId === identity.sessionId
    )
      return true;
    for (const prefix of ["request", "result"]) {
      const path = join(mailbox, `${prefix}-${identity.requestId}.json`);
      try {
        const details = await lstat(path);
        if (
          !details.isFile() ||
          details.isSymbolicLink() ||
          details.size > 4 * 1024 * 1024
        )
          throw new Error(
            "exact Agent mailbox request/result is not a safe file",
          );
        const record = JSON.parse(await readFile(path, "utf8"));
        if (
          record.requestId === identity.requestId &&
          record.ownerSessionId === identity.ownerSessionId &&
          record.agentLabel === "smoke-terminal-agent"
        )
          return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return false;
}

export function managerHandoffCanReenter(
  managerLeasePresent,
  contents,
  repoKey,
  branch,
  sessionId,
  messageId,
  text,
) {
  return (
    !managerLeasePresent &&
    !managerHandoffDeliveredEntry(
      contents,
      repoKey,
      branch,
      sessionId,
      messageId,
      text,
    )
  );
}

export function managerHandoffLeadPidContinues(initialPid, currentPid) {
  return initialPid === currentPid;
}

function assistantResultsForPrompt(contents, prompt, marker, matchesMarker) {
  const entries = sessionEntries(contents);
  const promptEntry = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt,
  );
  if (!promptEntry) return [];
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const descendsFromPrompt = (entry) => {
    let parentId = entry.parentId;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      if (parentId === promptEntry.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  return entries.filter((entry) => {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.stopReason !== "stop"
    )
      return false;
    if (!descendsFromPrompt(entry)) return false;
    return matchesMarker(messageText(entry.message.content), marker);
  });
}

function assistantResultForPrompt(contents, prompt, marker) {
  return (
    assistantResultsForPrompt(contents, prompt, marker, (text, expected) =>
      text.split(/\r?\n/).some((line) => line.trim() === expected),
    )[0] ?? null
  );
}

export function continuationResultsForPrompt(contents, prompt, marker) {
  return assistantResultsForPrompt(contents, prompt, marker, (text, expected) =>
    text.split(/\s+/).includes(expected),
  );
}

export function assistantResultForSession(session, prompt, marker) {
  return assistantResultForPrompt(session.contents, prompt, marker);
}

// Transcript evidence of a completed response, not Pi's whole-run settlement signal.
export function assistantResponseCompletedForSession(session, prompt) {
  return (
    assistantResultsForPrompt(session.contents, prompt, "", () => true).length >
    0
  );
}

export function rootDelegationDiagnostics(contents) {
  const messages = sessionEntries(contents)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message ?? {});
  let call;
  let result;
  let assistant;
  for (const message of messages) {
    if (message.role === "assistant") {
      assistant = message;
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        if (block?.type === "toolCall" && block.name === "delegate_agent") {
          call = block;
          result = undefined;
        }
      }
    }
    if (
      call &&
      typeof call.id === "string" &&
      message.role === "toolResult" &&
      message.toolName === "delegate_agent" &&
      message.toolCallId === call.id
    )
      result = message;
  }
  return {
    delegationCallObserved: Boolean(call),
    matchingResult: !call
      ? "absent"
      : !result
        ? "pending"
        : result.isError === true || result.details?.ok === false
          ? "error"
          : result.isError === false
            ? "success"
            : "unknown",
    assistantObserved: Boolean(assistant),
    assistantStopReason: [
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
    ].includes(assistant?.stopReason)
      ? assistant.stopReason
      : "unknown",
    assistantErrorObserved: Boolean(
      assistant &&
      (assistant.stopReason === "error" ||
        (typeof assistant.errorMessage === "string" &&
          assistant.errorMessage.length > 0)),
    ),
  };
}

function summarizeSession(contents) {
  const entries = sessionEntries(contents);
  const header = entries.find((entry) => entry.type === "session");
  const tools = new Set();
  const messages = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    for (const tool of message.toolsAdded ?? [])
      if (tool.name) tools.add(tool.name);
    const text = messageText(message.content);
    const calls = Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "toolCall")
          .map((block) => block.name)
      : [];
    if (
      message.role === "system" &&
      typeof message.sections?.tools === "string"
    ) {
      for (const [, name] of message.sections.tools.matchAll(
        /^\s*-\s+([\w-]+):/gm,
      ))
        tools.add(name);
    }
    if (message.role !== "system" || calls.length || text)
      messages.push({
        role: message.role,
        stopReason: message.stopReason,
        errorMessage:
          typeof message.errorMessage === "string"
            ? message.errorMessage.slice(0, 500)
            : undefined,
        toolName: message.toolName,
        isError: message.isError,
        tools: calls,
        text: text.slice(0, 500),
      });
  }
  return {
    session: header ? { id: header.id, cwd: header.cwd } : null,
    tools: [...tools].slice(0, 100),
    recentMessages: messages.slice(-16),
  };
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
}

function protocolError(message) {
  const error = new Error(message);
  error.code = "SMOKE_PROTOCOL";
  throw error;
}

export function parseHerdrOutput(stdout, args) {
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    protocolError(
      `herdr ${args.slice(0, 2).join(" ")} returned malformed JSON`,
    );
  }
  if (args[0] === "status" && args[1] === "--json") return value;
  // Session JSON is emitted by the CLI rather than the API response envelope.
  if (args[0] === "session" && args.at(-1) === "--json") return value;
  if (
    !value ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "id") ||
    !Object.hasOwn(value, "result")
  )
    protocolError(
      `herdr ${args.slice(0, 2).join(" ")} returned no result envelope`,
    );
  return value.result;
}

async function herdr(args, options = {}) {
  const { stdout } = await run("herdr", args, options);
  return parseHerdrOutput(stdout, args);
}

async function tryHerdr(args, options = {}) {
  try {
    return { ok: true, value: await herdr(args, options) };
  } catch (error) {
    if (error?.code === "SMOKE_PROTOCOL") throw error;
    return {
      ok: false,
      error: error?.message ?? String(error),
      herdrCode: herdrErrorCode(error),
    };
  }
}

export function herdrErrorCode(error) {
  try {
    const value = JSON.parse(String(error?.stderr ?? "").trim());
    return typeof value?.error?.code === "string"
      ? value.error.code
      : undefined;
  } catch {
    return undefined;
  }
}

export function candidateStartObservationError(observed, paneId) {
  if (observed.ok) return undefined;
  if (observed.herdrCode === "pane_not_found")
    throw new Error(`candidate pane ${paneId} disappeared`);
  return { done: false, observationError: observed.error };
}

export function requireTestedBaseline(name, actualVersion, baselineVersion) {
  const parse = (version, kind) => {
    const match =
      typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match)
      throw new Error(
        kind === "baseline"
          ? `smoke: invalid ${name} tested baseline: ${version}`
          : `smoke: invalid ${name} version: ${version}`,
      );
    return match.slice(1).map(Number);
  };
  const actual = parse(actualVersion, "actual");
  const minimum = parse(baselineVersion, "baseline");
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) {
      if (actual[i] < minimum[i])
        throw new Error(
          `smoke: ${name} ${actualVersion} is below tested baseline ${baselineVersion}`,
        );
      return;
    }
  }
}

async function preflight(pkg) {
  const nodeEngine = pkg?.engines?.node;
  const nodeBaseline =
    typeof nodeEngine === "string"
      ? /^>=(\d+\.\d+\.\d+)$/.exec(nodeEngine)?.[1]
      : undefined;
  const piBaseline = pkg?.piHerdsman?.runtime?.pi;
  const herdrBaseline = pkg?.piHerdsman?.runtime?.herdr?.version;
  requireTestedBaseline("Node", process.versions.node, nodeBaseline);
  const [{ stdout: piVersion }, { stdout: herdrVersion }] = await Promise.all([
    run("pi", ["--version"], { timeout: OBSERVATION_TIMEOUT_MS }),
    run("herdr", ["--version"], { timeout: OBSERVATION_TIMEOUT_MS }),
  ]);
  const actualPiVersion = piVersion.trim();
  requireTestedBaseline("Pi", actualPiVersion, piBaseline);
  const actualHerdrVersion = herdrVersion.trim().replace(/^herdr\s+v?/, "");
  requireTestedBaseline("Herdr", actualHerdrVersion, herdrBaseline);
  return { piVersion: actualPiVersion, herdrVersion: actualHerdrVersion };
}

export async function startParent(
  paths,
  owned,
  {
    spawnProcess = spawn,
    tryHerdrCommand = tryHerdr,
    wait = waitForEvidence,
  } = {},
) {
  const name = `phs-${randomUUID().slice(0, 12)}`;
  nestedHerdrApiSocketPath(paths, name);
  const env = parentControlEnv(process.env, paths, name);
  const server = spawnProcess("herdr", ["--session", name, "server"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const parent = { name, server, env, stderr: "" };
  owned.parent = parent;
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    parent.stderr = `${parent.stderr}${chunk}`.slice(-8_192);
  });
  server.on("error", (error) => {
    parent.spawnError = error;
  });
  server.on("exit", (code, signal) => {
    parent.exit = { code, signal };
  });
  await wait(
    { stage: "parent-herdr-ready" },
    "parent-herdr-ready",
    async () => {
      if (parent.spawnError) throw parent.spawnError;
      if (parent.exit)
        throw new Error(
          `owned Herdr server exited (${JSON.stringify(parent.exit)})`,
        );
      const result = await tryHerdrCommand(["status", "--json"], {
        env,
        timeout: OBSERVATION_TIMEOUT_MS,
      });
      if (!result.ok) return { done: false, observationError: result.error };
      if (!result.value?.server?.running)
        return {
          done: false,
          observationError: "owned Herdr server is not running",
        };
      if (!result.value.server.compatible)
        throw new Error("owned Herdr client/server are incompatible");
      assert.equal(result.value.server.session, name);
      assert.equal(
        resolve(result.value.server.socket),
        resolve(nestedHerdrApiSocketPath(paths, name)),
        "owned Herdr server selected an unexpected socket",
      );
      return { done: true, value: result.value };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 150 },
  );
  return { name, env };
}

export async function createParentWorkspace(
  paths,
  parent,
  owned,
  cwd,
  herdrCommand = herdr,
) {
  const created = await herdrCommand(
    [
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      "pi-herdsman-smoke",
      "--no-focus",
    ],
    { env: parent.env, timeout: OBSERVATION_TIMEOUT_MS },
  );
  const workspaceId = created?.workspace?.workspace_id;
  const paneId = created?.root_pane?.pane_id;
  assert.ok(workspaceId && paneId, "Herdr workspace create omitted owned IDs");
  owned.parent.workspaceId = workspaceId;
  owned.parent.rootPaneId = paneId;
  const observed = await herdrCommand(["workspace", "get", workspaceId], {
    env: parent.env,
    timeout: OBSERVATION_TIMEOUT_MS,
  });
  assert.equal(observed?.workspace?.workspace_id, workspaceId);
  return workspaceId;
}

async function preflightParent(pkg, parentEnv) {
  const status = await herdr(["status", "--json"], {
    env: parentEnv,
    timeout: OBSERVATION_TIMEOUT_MS,
  });
  if (!status?.server?.running) throw new Error("Herdr server is not running");
  if (!status?.server?.compatible)
    throw new Error("Herdr client/server are incompatible");
  const herdrClientVersion = status.client?.version;
  if (typeof herdrClientVersion !== "string")
    throw new Error("Herdr client version is unavailable or invalid");
  requireTestedBaseline(
    "Herdr",
    herdrClientVersion,
    pkg.piHerdsman.runtime.herdr.version,
  );
  return { herdrClientVersion };
}

async function createIsolation() {
  const root = await mkdtemp(join(await realpath("/tmp"), "phs-"));
  const paths = {
    root,
    xdgConfig: join(root, "xdg-config"),
    xdgState: join(root, "xdg-state"),
    herdrConfig: join(root, "herdr.toml"),
    piAgent: join(root, "pi-agent"),
    piSessions: join(root, "pi-sessions"),
    herdrStateExtension: join(
      root,
      "pi-agent",
      "extensions",
      "herdr-agent-state.ts",
    ),
    authLink: join(root, "pi-agent", "auth.json"),
  };
  try {
    await Promise.all([
      mkdir(paths.xdgConfig, { recursive: true }),
      mkdir(paths.xdgState, { recursive: true }),
      mkdir(join(paths.piAgent, "extensions"), { recursive: true }),
      mkdir(paths.piSessions, { recursive: true }),
    ]);
    await writeFile(paths.herdrConfig, "[experimental]\nallow_nested = true\n");
    return paths;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function linkIfPresent(source, target) {
  try {
    await symlink(source, target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function preparePi(paths, model, execute = run) {
  const sourceAgentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const env = isolatedEnv(process.env, paths);
  const authArgs = ["auth", "check", "--model", model, "--no-refresh"];
  try {
    await execute("pi", authArgs, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "ambient";
  } catch {
    if (
      !(await linkIfPresent(join(sourceAgentDir, "auth.json"), paths.authLink))
    )
      throw new Error(
        "Pi auth check failed and no current auth.json is available",
      );
    try {
      await execute("pi", authArgs, {
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return "auth.json symlink";
    } catch {
      throw new Error(
        "Pi auth check failed with ambient credentials and auth.json",
      );
    }
  }
}

export async function prepareContinuationFaux(paths, extensionPath) {
  const agents = join(paths.piAgent, "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    join(agents, "implementer.md"),
    `---\nname: implementer\nextensions: [${JSON.stringify(extensionPath)}]\n---\n`,
    { flag: "wx" },
  );
}

async function prepareHerdr(paths) {
  await run("herdr", ["config", "check"], {
    env: isolatedEnv(process.env, paths),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await run("herdr", ["integration", "install", "pi"], {
    env: isolatedEnv(process.env, paths),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await access(paths.herdrStateExtension);
}

async function startNestedHerdr(
  paths,
  owned,
  parentEnv,
  primaryCheckoutPath,
  managerRecoveryDiagnostics,
) {
  const id = randomUUID().slice(0, 12);
  const sessionName = `phs-${id}`;
  owned.sessionName = sessionName;
  nestedHerdrApiSocketPath(paths, sessionName);
  const host = await herdr(
    [
      "tab",
      "create",
      "--workspace",
      parentEnv.HERDR_WORKSPACE_ID,
      "--cwd",
      primaryCheckoutPath,
      "--label",
      `smoke-${id}`,
      "--no-focus",
      "--env",
      `HERDR_CONFIG_PATH=${paths.herdrConfig}`,
      "--env",
      `XDG_CONFIG_HOME=${paths.xdgConfig}`,
      "--env",
      `XDG_STATE_HOME=${paths.xdgState}`,
      "--env",
      `PI_CODING_AGENT_DIR=${paths.piAgent}`,
      "--env",
      `PI_CODING_AGENT_SESSION_DIR=${paths.piSessions}`,
      ...(managerRecoveryDiagnostics
        ? ["--env", "PI_HERDSMAN_MANAGER_DIAGNOSTICS=1"]
        : []),
    ],
    { env: parentEnv },
  );
  const result = host;
  owned.hostTabId = result.tab?.tab_id;
  owned.hostPaneId = result.root_pane?.pane_id;
  assert.ok(
    owned.hostTabId && owned.hostPaneId,
    "Herdr tab response omitted owned IDs",
  );
  owned.sessionName = sessionName;
  await run(
    "herdr",
    [
      "pane",
      "run",
      owned.hostPaneId,
      shellCommand([
        process.execPath,
        join(repoRoot, "scripts", "smoke.mjs"),
        "--nested-host",
        sessionName,
        paths.root,
      ]),
    ],
    { env: parentEnv },
  ).catch((error) => {
    throw new Error(`could not launch nested host: ${error.message}`);
  });
}

function nestedHost(args) {
  const [sessionName, root] = args;
  if (!sessionName || !root)
    throw new Error("nested host requires a session and temp root");
  const paths = {
    root,
    xdgConfig: join(root, "xdg-config"),
    xdgState: join(root, "xdg-state"),
    herdrConfig: join(root, "herdr.toml"),
    piAgent: join(root, "pi-agent"),
    piSessions: join(root, "pi-sessions"),
  };
  const result = spawnSync("herdr", ["--session", sessionName], {
    env: isolatedEnv(process.env, paths),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

async function nestedCommand(ctx, args) {
  return herdr(args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
}

export async function nestedPaneInput(ctx, args, execute = run, options = {}) {
  return execute("herdr", args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    ...options,
  });
}

export async function nestedPaneText(ctx, paneId, source, execute = run) {
  const { stdout } = await nestedPaneInput(
    ctx,
    ["pane", "read", paneId, "--source", source, "--lines", "120"],
    execute,
    { timeout: OBSERVATION_TIMEOUT_MS },
  );
  return stdout;
}

export async function submitPaneCommand(ctx, paneId, command, execute = run) {
  return nestedPaneInput(ctx, ["pane", "run", paneId, command], execute);
}

async function tryNestedCommand(ctx, args) {
  return tryHerdr(args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    timeout: OBSERVATION_TIMEOUT_MS,
  });
}

async function waitForNestedHerdr(ctx) {
  return waitForEvidence(
    ctx,
    "nested-herdr-ready",
    async () => {
      const result = await tryNestedCommand(ctx, ["pane", "list"]);
      return result.ok
        ? { done: true, value: result.value }
        : { done: false, observationError: result.error };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 150 },
  );
}

export function requireNestedHerdrServer(status, sessionName, baseline) {
  assert.equal(
    status?.server?.running,
    true,
    "nested Herdr server is not running",
  );
  assert.equal(
    status.server.session,
    sessionName,
    "nested Herdr session mismatch",
  );
  assert.equal(
    status.server.compatible,
    true,
    "nested Herdr client/server incompatible",
  );

  requireTestedBaseline("Herdr server", status.server.version, baseline);

  return status.server.version;
}

async function startCandidate(ctx) {
  assert.equal(ctx.candidateExtension, join(ctx.repoRoot, "dist", "index.js"));
  assert.equal(
    ctx.herdrStateExtension,
    join(ctx.paths.piAgent, "extensions", "herdr-agent-state.ts"),
  );
  assert.ok(
    isAbsolute(ctx.herdrStateExtension),
    "Herdr state extension path must be absolute",
  );
  await Promise.all([
    access(ctx.candidateExtension),
    access(ctx.herdrStateExtension),
    ...(ctx.simulatedProviderExtension
      ? [access(ctx.simulatedProviderExtension)]
      : []),
    ...(ctx.chiefTreeProbeExtension
      ? [access(ctx.chiefTreeProbeExtension)]
      : []),
  ]);
  const panes = await nestedCommand(ctx, ["pane", "list"]);
  assert.ok(Array.isArray(panes.panes), "Herdr pane list result is malformed");
  const pane = panes.panes.find(
    (item) => resolve(item.cwd ?? "") === ctx.rootCwd,
  );
  const paneId = pane?.pane_id;
  assert.ok(paneId, "nested primary pane ID was not found");
  assert.ok(pane.workspace_id, "nested primary workspace ID was not found");
  ctx.rootWorkspaceId = pane.workspace_id;
  assert.equal(resolve(pane.cwd), ctx.rootCwd);
  ctx.rootPaneId = paneId;
  const prompt = ctx.initialPrompt;
  assert.ok(
    prompt === undefined || typeof prompt === "string",
    "candidate initial prompt must be a string when present",
  );
  const args = candidateArgs({
    candidateExtension: ctx.candidateExtension,
    herdrStateExtension: ctx.herdrStateExtension,
    ...(ctx.simulatedProviderExtension
      ? { simulatedProviderExtension: ctx.simulatedProviderExtension }
      : {}),
    ...(ctx.chiefTreeProbeExtension
      ? { chiefTreeProbeExtension: ctx.chiefTreeProbeExtension }
      : {}),
    model: ctx.model,
  });
  await run(
    "herdr",
    [
      "pane",
      "run",
      paneId,
      rootCandidateCommand([
        "pi",
        ...args,
        ...(prompt === undefined ? [] : [prompt]),
      ]),
    ],
    {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    },
  );
  await waitForEvidence(
    ctx,
    "candidate-start",
    async () => {
      const observed = await tryNestedCommand(ctx, [
        "pane",
        "process-info",
        "--pane",
        paneId,
      ]);
      const observationError = candidateStartObservationError(observed, paneId);
      if (observationError) return observationError;
      const matches = candidateProcess(
        observed.value,
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      return {
        done: matches.length > 0,
        value: paneId,
        progress: {
          pids: matches
            .map((proc) => proc.pid)
            .filter(Boolean)
            .sort(),
        },
        evidence: observed.value.process_info,
      };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS },
  );
  return paneId;
}

function corePrompt(expected) {
  return `Delegate this task to one implementer.\n\nDo not read package.json yourself. The implementer must delegate exactly one scout to read package.json and determine its exact "name" and "version". The implementer must return that result to you.\n\nWhen the delegated work is complete, output exactly:\n\nPI_HERDSMAN_SMOKE_OK ${expected}\n\nDo not output that marker before the implementer reports its result.`;
}

function continuationPrompt() {
  return `Delegate exactly one bounded task to an implementer: read package.json, remember its exact package name, and return only CONTINUATION_FIRST_DONE. After that result reaches you, output exactly PI_HERDSMAN_CONTINUATION_FIRST. Do not read package.json yourself.`;
}

export function managerRecoveryFreshPrompt(branch) {
  return `Use delegate_project exactly once to start new project work. Set its \`task\` argument to the delegated task below and its \`branch\` argument to exactly ${branch}. Omit \`base\` and \`files\`.\n\nThe delegated task is:\n- do not modify any files;\n- immediately call message_supervisor with exactly MANAGER_RECOVERY_READY;\n- then end the turn and wait for further instruction.\n\nManager handshake: after delegate_project returns, end this turn immediately. Do not call any other tool, output any recovery marker, or send any message_staff. Wait until the exact MANAGER_RECOVERY_READY message from this Lead is delivered into your conversation; do not infer delivery from the delegate result, a Lead transcript, or other evidence. Only after that delivered message, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_READY and end the turn.`;
}

export function terminalFailureEvidence(contents, branch, sessionId) {
  const entries = sessionEntries(contents);
  const reports = projectMessageEntries(contents, branch, sessionId);
  const failures = reports.filter((entry) =>
    /Lead model execution failed|Lead execution settled without verified completion/.test(
      String(entry.content),
    ),
  );
  const success = reports.some((entry) =>
    /Project complete|execution completed successfully/i.test(
      String(entry.content),
    ),
  );
  const toolCalls = entries.flatMap((entry) =>
    entry.message?.role === "assistant" && Array.isArray(entry.message.content)
      ? entry.message.content.filter((part) => part.type === "toolCall")
      : [],
  );
  return {
    executionFailures: failures.length,
    logicalReports: reports.length,
    actionable:
      failures.length === 1 &&
      /inspect|unresolved|failed/i.test(String(failures[0].content)),
    successHandoff: success,
    toolCalls: toolCalls.length,
    toolNames: toolCalls.map((part) => part.name),
  };
}

export function matchPiProvenance(
  records,
  sessionId,
  paneId,
  foregroundProcesses,
  expectedModel,
  requireAgentDefinitions,
  expectedPiVersion,
) {
  try {
    const matches = records.filter((record) => record.sessionId === sessionId);
    assert.equal(
      matches.length,
      1,
      `expected one provenance row for ${sessionId}`,
    );
    const [record] = matches;
    assert.equal(record.packageName, "@earendil-works/pi-coding-agent");
    requireTestedBaseline("Pi", record.piVersion, expectedPiVersion);
    assert.equal(record.model, expectedModel);
    assert.equal(record.hasAgentDefinitions, requireAgentDefinitions);
    const processes = foregroundProcesses.filter(
      (process) => process.pid === record.pid,
    );
    assert.equal(
      processes.length,
      1,
      `expected one foreground PID match in pane ${paneId}`,
    );
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
    return { paneId, pid: record.pid, sessionId, piVersion: record.piVersion };
  } catch (error) {
    error.code = "SMOKE_EVIDENCE";
    throw error;
  }
}

export function requireSmokeEvidence(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = "SMOKE_EVIDENCE";
    throw error;
  }
}

export function verifyCoreProvenanceEvidence(ctx, provenance, sessionIds) {
  requireSmokeEvidence(
    provenance.length === sessionIds.size,
    "unexpected or duplicate core provenance rows",
  );
  ctx.firstRequestVerified = true;
}

export function classifySmokeFailure(phase, error) {
  return phase === "setup"
    ? "SETUP_FAIL"
    : ["SMOKE_PROTOCOL", "SMOKE_EVIDENCE"].includes(error.code)
      ? "EVIDENCE_FAIL"
      : "SCENARIO_FAIL";
}

export function coreAgentDefinitionsExpectations(sessions, rootId) {
  return new Map(
    sessions.map(({ id, entries }) => [
      id,
      id === rootId ||
        entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message.content?.some(
              (part) =>
                part.type === "toolCall" && part.name === "delegate_agent",
            ),
        ),
    ]),
  );
}

async function runTerminalFailureSmoke(ctx) {
  const branch = `herdsman/smoke-terminal-failure-${randomUUID()}`;
  const task =
    "Do not call tools or perform work. Wait for your first model response.";
  const providerPath = ctx.simulatedProviderExtension;
  const evidenceDir = join(ctx.paths.piAgent, "pi-herdsman", "runtime");
  await mkdir(evidenceDir, { recursive: true });
  const attemptsPath = join(evidenceDir, "smoke-faux-attempts.jsonl");
  const settledPath = join(evidenceDir, "smoke-faux-settled.jsonl");
  const provenancePath = join(evidenceDir, "smoke-faux-provenance.jsonl");
  const definitionDir = join(ctx.rootCwd, ".pi", "agents");
  await mkdir(definitionDir, { recursive: true });
  await writeFile(
    join(definitionDir, "managed-lead.md"),
    `---\nname: managed-lead\nmodel: smoke-faux/terminal-error\nextensions: [${JSON.stringify(providerPath)}]\n---\n`,
  );
  await writeFile(
    join(ctx.paths.piAgent, "settings.json"),
    JSON.stringify(
      {
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 1,
          maxAgentDelayMs: 1,
          provider: { maxRetries: 0 },
        },
      },
      null,
      2,
    ) + "\n",
  );
  await run("git", ["add", ".pi/agents/managed-lead.md"], { cwd: ctx.rootCwd });
  await run(
    "git",
    [
      "-c",
      "user.name=Herdsman Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Configure isolated terminal failure Lead",
    ],
    { cwd: ctx.rootCwd },
  );
  ctx.owned.managerBranch = branch;
  ctx.owned.managerWorktreeRetirementRequested = true;
  ctx.terminalFailure = {
    branch,
    model: "smoke-faux/terminal-error",
    providerPath,
  };
  ctx.managerRecovery = { branch };
  const root = async () => rootSessionSnapshot(ctx);
  const agents = async () =>
    (await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
  const prompt = `Use delegate_project exactly once. Set branch to exactly ${branch}, task to exactly ${JSON.stringify(task)}, and omit base and files. After it returns, wait for the Lead's report. Do not create or resume other work.`;
  markStage(ctx, "terminal-failure-manager-start");
  await waitForEvidence(
    ctx,
    "terminal-failure-root-session",
    async () => {
      const rootAgent = (await agents()).find(
        (agent) =>
          agent.pane_id === ctx.rootPaneId &&
          typeof agent.agent_session?.value === "string",
      );
      return {
        done: !!rootAgent,
        value: rootAgent,
        progress: { rootSessionFound: !!rootAgent },
      };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS },
  );
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode active.",
    "--timeout",
    "15000",
  ]);
  markStage(ctx, "terminal-failure-delegation");
  await nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  const result = await waitForEvidence(
    ctx,
    "terminal-failure-assignment",
    () => terminalFailureAssignmentPoll(ctx, branch, root, agents),
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  const assigned = result.delegated;
  const child = result.child;
  assert.equal(assigned.ok, true);
  assert.equal(assigned.branch, branch);
  assert.ok(child?.pane_id);
  const sessionId = assigned.session;
  const paneId = child.pane_id;
  const processObservation = result.processObservation;
  assert.equal(processObservation?.paneId, paneId);
  const worktrees = await nestedCommand(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  const exactWorktree = (worktrees.worktrees ?? []).filter(
    (item) => item.branch === branch,
  );
  assert.equal(exactWorktree.length, 1);
  const paneCwd = (await nestedCommand(ctx, ["pane", "list"])).panes.find(
    (pane) => pane.pane_id === paneId,
  )?.cwd;
  const worktreePath =
    exactWorktree[0].path ?? exactWorktree[0].worktree_path ?? paneCwd;
  assert.ok(
    typeof worktreePath === "string" && isAbsolute(worktreePath),
    "exact assigned Lead pane must identify its worktree path",
  );
  captureTerminalFailureAssignment(ctx, worktreePath, assigned.workspace_id);
  ctx.owned.managerWorktreeRetirementRequested = false;
  ctx.managerRecovery = { branch, worktreePath };
  assert.equal(resolve(paneCwd), resolve(worktreePath));
  const sessionSnapshot = () => exactIsolatedSession(ctx, sessionId);
  markStage(ctx, "terminal-failure-settlement-and-report");
  await waitForEvidence(
    ctx,
    "terminal-failure-report",
    async () => {
      const leadSession = await sessionSnapshot();
      const manager = await root();
      const requests = await readFile(attemptsPath, "utf8").catch(() => "");
      const settled = await readFile(settledPath, "utf8").catch(() => "");
      const reports = manager
        ? terminalFailureEvidence(manager.contents, branch, sessionId)
        : null;
      const failureMessage =
        manager &&
        projectMessageEntries(manager.contents, branch, sessionId).find(
          (entry) =>
            /Lead model execution failed|Lead execution settled without verified completion/.test(
              String(entry.content),
            ),
        );
      const managerResponded = !!(
        manager &&
        failureMessage &&
        managerProjectMessageSettled(
          manager.contents,
          branch,
          sessionId,
          String(failureMessage.content),
        )
      );
      const reportPending = !!(
        leadSession &&
        sessionEntries(leadSession.contents).some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-herdsman-herd-run" &&
            entry.data?.phase === "report_pending" &&
            entry.data.sessionId === sessionId,
        )
      );
      const settledRows = settled
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.sessionId === sessionId);
      const requestCount = requests.split(/\r?\n/).filter(Boolean).length;
      const finalError =
        leadSession &&
        sessionEntries(leadSession.contents).some(
          (entry) =>
            entry.message?.role === "assistant" &&
            entry.message.stopReason === "error",
        );
      const partialObserved =
        leadSession &&
        leadSession.contents.includes("CONTROLLED_PARTIAL_RESPONSE");
      const leadToolCalls = leadSession
        ? sessionEntries(leadSession.contents).flatMap((entry) =>
            entry.message?.role === "assistant" &&
            Array.isArray(entry.message.content)
              ? entry.message.content.filter((part) => part.type === "toolCall")
              : [],
          ).length
        : -1;
      const done = !!(
        reports?.executionFailures === 1 &&
        reports.logicalReports === 1 &&
        reports.actionable &&
        managerResponded &&
        !reports.successHandoff &&
        settledRows.length === 1 &&
        settledRows[0].aborted === false &&
        requestCount === 2 &&
        finalError &&
        partialObserved &&
        leadToolCalls === 0
      );
      return {
        done,
        value: {
          reports,
          settledRows,
          requestCount,
          finalError,
          partialObserved,
          leadToolCalls,
        },
        progress: {
          requestCount,
          reportCount: reports?.executionFailures ?? 0,
          logicalReports: reports?.logicalReports ?? 0,
          actionable: !!reports?.actionable,
          managerResponded,
          reportPending: reportPending ? "observed" : "not_observed",
          managerReceipt: failureMessage ? "observed" : "not_observed",
          managerFollowup: managerResponded ? "observed" : "not_observed",
          settledCount: settledRows.length,
          settledNonAborted:
            settledRows.length === 1 && settledRows[0].aborted === false,
          finalError: !!finalError,
          partialObserved: !!partialObserved,
          leadToolCalls,
        },
        evidence: leadSession ? summarizeSession(leadSession.contents) : null,
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  const managerSession = await root();
  const provenance = (await readFile(provenancePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  ctx.firstRequestObserved = provenance.length > 0;
  try {
    ctx.sessionStartObserved = Boolean(
      (
        await readFile(
          join(
            ctx.paths.piAgent,
            "pi-herdsman",
            "runtime",
            "smoke-faux-session-start.jsonl",
          ),
          "utf8",
        )
      ).trim(),
    );
  } catch {
    ctx.sessionStartObserved = false;
  }
  ctx.terminalFailure.provenance = matchPiProvenance(
    provenance,
    sessionId,
    paneId,
    processObservation.processes,
    "terminal-error",
    true,
    ctx.expectedPiVersion,
  );
  ctx.firstRequestVerified = true;
  const report = terminalFailureEvidence(
    managerSession.contents,
    branch,
    sessionId,
  );
  assert.equal(report.executionFailures, 1);
  assert.equal(report.logicalReports, 1);
  assert.equal(report.actionable, true);
  assert.equal(report.successHandoff, false);
  const failureMessage = projectMessageEntries(
    managerSession.contents,
    branch,
    sessionId,
  ).find((entry) =>
    /Lead model execution failed|Lead execution settled without verified completion/.test(
      String(entry.content),
    ),
  );
  assert.ok(failureMessage);
  assert.equal(
    managerProjectMessageSettled(
      managerSession.contents,
      branch,
      sessionId,
      String(failureMessage.content),
    ),
    true,
    "Manager must complete its response to the exact delivered Lead failure report",
  );
  assert.equal(
    report.toolCalls,
    1,
    "Manager should make only the requested delegate_project call",
  );
  assert.deepEqual(report.toolNames, ["delegate_project"]);
  const preservedLead = [];
  for (const agent of await agents())
    if ((await agentSessionId(ctx, agent)) === sessionId)
      preservedLead.push(agent);
  assert.ok(
    preservedLead.length <= 1,
    "assignment must not have a second live Lead writer",
  );
  const session = await exactIsolatedSession(ctx, sessionId);
  assert.ok(
    session,
    "the exact assigned Pi session must remain persisted after failure",
  );
  const topology = await nestedCommand(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  const repoKey = topology.source?.repo_key;
  assert.ok(typeof repoKey === "string" && repoKey.length > 0);
  const assignmentPath = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "supervision-v2",
    createHash("sha256")
      .update(nestedHerdrApiSocketPath(ctx.paths, ctx.sessionName))
      .digest("hex"),
    "assignments",
    createHash("sha256").update(repoKey).digest("hex"),
    `${createHash("sha256").update(branch).digest("hex")}.json`,
  );
  const assignment = JSON.parse(await readFile(assignmentPath, "utf8"));
  assert.equal(assignment.id, sessionId);
  assert.equal(assignment.branch, branch);
  assert.equal(
    resolve(
      (await nestedCommand(ctx, ["pane", "list"])).panes.find(
        (pane) => pane.pane_id === paneId,
      ).cwd,
    ),
    resolve(worktreePath),
  );
  assert.equal(
    (
      await nestedCommand(ctx, [
        "worktree",
        "list",
        "--workspace",
        ctx.rootWorkspaceId,
      ])
    ).worktrees.filter((item) => item.branch === branch).length,
    1,
  );
  ctx.terminalFailure = {
    ...ctx.terminalFailure,
    sessionId,
    paneId,
    worktreePath,
    reportCount: report.executionFailures,
  };
}

async function runAgentTerminalFailureSmoke(ctx) {
  const prompt =
    "SMOKE_AGENT_FAILURE: delegate exactly one smoke-failure-agent with label smoke-terminal-agent; then report its failed result.";
  await waitForEvidence(
    ctx,
    "agent-terminal-failure-root-agent",
    async () => ({
      done:
        (await nestedCommand(ctx, ["agent", "list"])).agents?.some(
          (agent) =>
            agent.pane_id === ctx.rootPaneId &&
            typeof agent.agent_session?.value === "string",
        ) ?? false,
    }),
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS },
  );
  await submitPaneCommand(ctx, ctx.rootPaneId, prompt);
  const evidenceDir = join(ctx.paths.piAgent, "pi-herdsman", "runtime");
  const observedPath = join(evidenceDir, "agent-terminal-failure-observed");
  let identity;
  let observedAgentEvidence;
  await waitForEvidence(
    ctx,
    "agent-terminal-failure-result",
    async () => {
      const owner = await rootSessionSnapshot(ctx);
      if (!owner) return { done: false };
      const entries = sessionEntries(owner.contents);
      const calls = entries
        .filter(
          (entry) =>
            entry.type === "message" && entry.message?.role === "assistant",
        )
        .flatMap((entry) =>
          (entry.message.content ?? []).filter(
            (part) =>
              part.type === "toolCall" && part.name === "delegate_agent",
          ),
        );
      if (calls.length > 1)
        throw new Error("Agent failure scenario delegated more than once");
      if (!calls.length)
        return { done: false, progress: { delegationCount: 0 } };
      const call = calls[0];
      if (
        call.arguments?.definition !== "smoke-failure-agent" ||
        call.arguments?.label !== "smoke-terminal-agent"
      )
        throw new Error("Unexpected Agent failure delegation identity");
      const result = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.toolName === "delegate_agent" &&
          entry.message.toolCallId === call.id &&
          !entry.message.isError,
      );
      if (!result)
        return { done: false, progress: { delegationCount: calls.length } };
      const raw = messageText(result.message.content);
      const sessionId = raw.match(/^Session: ([^\n]+)$/m)?.[1];
      const requestId = raw.match(/^Request: ([^\n]+)$/m)?.[1];
      if (!sessionId || !requestId)
        throw new Error("Agent delegation omitted session/request identity");
      const ownerSessionId = entries.find(
        (entry) => entry.type === "session",
      )?.id;
      if (!ownerSessionId)
        throw new Error("Agent owner session identity is missing");
      identity = { callId: call.id, sessionId, requestId, ownerSessionId };
      // Hold the first native error until the exact child process and faux provenance are visible.
      let childAgent;
      const persistedChild = await exactIsolatedSession(ctx, sessionId);
      let listedAgents = [];
      let matchingAgents = [];
      if (!observedAgentEvidence) {
        listedAgents =
          (await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
        matchingAgents = await agentsForPiSession(ctx, listedAgents, sessionId);
        if (matchingAgents.length > 1)
          throw new Error(
            "Delegated Pi session matches multiple managed Agents",
          );
        if (matchingAgents.length === 1 && persistedChild)
          childAgent = matchingAgents[0];
      }
      if (!observedAgentEvidence && childAgent?.pane_id) {
        const info = await nestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          childAgent.pane_id,
        ]).catch(() => null);
        const processes = candidateProcess(
          info,
          ctx.candidateExtension,
          ctx.herdrStateExtension,
        );
        const provenance = (
          await readFile(
            join(evidenceDir, "smoke-faux-provenance.jsonl"),
            "utf8",
          ).catch(() => "")
        )
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const childProvenance = provenance.filter(
          (row) => row.sessionId === sessionId,
        );
        if (processes.length === 1 && childProvenance.length === 1) {
          const processProof = matchPiProvenance(
            provenance,
            sessionId,
            childAgent.pane_id,
            processes,
            "terminal-agent-error",
            false,
            ctx.expectedPiVersion,
          );
          observedAgentEvidence = Object.freeze({
            ...processProof,
            agentPaneId: childAgent.pane_id,
            process: Object.freeze({ ...processes[0] }),
            provenance: Object.freeze({ ...childProvenance[0] }),
          });
          await writeFile(observedPath, "observed\n");
        }
      }
      const handoff = failedAgentHandoff(
        entries,
        requestId,
        sessionId,
        ownerSessionId,
      );
      if (!handoff || !observedAgentEvidence)
        return {
          done: false,
          progress: {
            delegationCount: 1,
            failedHandoff: false,
            childSessionId: sessionId,
            persistedChildSession: !!persistedChild,
            persistedChildBytes: persistedChild
              ? Buffer.byteLength(persistedChild.contents)
              : 0,
            persistedChildErrors: persistedChild
              ? sessionEntries(persistedChild.contents).filter(
                  (entry) =>
                    entry.type === "message" &&
                    entry.message?.role === "assistant" &&
                    entry.message.stopReason === "error",
                ).length
              : 0,
            matchingAgentCount: matchingAgents.length,
            listedAgentIdentities: listedAgents.map(
              ({ pane_id, pi_session_id, agent_session }) => ({
                pane_id,
                pi_session_id,
                agentSessionKind: agent_session?.kind,
                agentSessionValue: agent_session?.value,
              }),
            ),
            childPane: childAgent?.pane_id ?? null,
            candidateProcessCount: childAgent?.pane_id
              ? candidateProcess(
                  await nestedCommand(ctx, [
                    "pane",
                    "process-info",
                    "--pane",
                    childAgent.pane_id,
                  ]).catch(() => null),
                  ctx.candidateExtension,
                  ctx.herdrStateExtension,
                ).length
              : 0,
          },
        };
      const child = await exactIsolatedSession(ctx, sessionId);
      const childEntries = child && sessionEntries(child.contents);
      const errors =
        childEntries?.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message.stopReason === "error",
        ) ?? [];
      if (
        !child ||
        !child.contents.includes("CONTROLLED_PARTIAL_RESPONSE") ||
        errors.length !== 2
      )
        return {
          done: false,
          progress: { failedHandoff: true, childError: errors.length },
        };
      const attempts = (
        await readFile(
          join(evidenceDir, "smoke-faux-attempts.jsonl"),
          "utf8",
        ).catch(() => "")
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.sessionId === sessionId);
      const settlements = (
        await readFile(
          join(evidenceDir, "smoke-faux-settled.jsonl"),
          "utf8",
        ).catch(() => "")
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.sessionId === sessionId);
      const acknowledged = entries.some(
        (entry, index) =>
          index > entries.indexOf(handoff) &&
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          messageText(entry.message.content).includes(
            "SMOKE_AGENT_FAILURE_DELIVERED",
          ),
      );
      if (
        attempts.length !== 2 ||
        attempts.some((row) => row.model !== "terminal-agent-error") ||
        settlements.length !== 1 ||
        settlements[0].aborted !== false ||
        observedAgentEvidence.sessionId !== sessionId ||
        !acknowledged
      )
        return {
          done: false,
          progress: {
            attempts: attempts.length,
            settlements: settlements.length,
            acknowledged,
          },
        };
      return {
        done: true,
        value: { handoff, errors: errors.length },
        progress: {
          delegationCount: 1,
          failedHandoff: true,
          childError: errors.length,
        },
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  if (!identity)
    throw new Error("Agent failure result lacked delegated identity");
  await waitForEvidence(
    ctx,
    "agent-terminal-failure-retired",
    async () => {
      const agents = (await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
      const matching = await agentsForPiSession(
        ctx,
        agents,
        identity.sessionId,
      );
      const panes = (await nestedCommand(ctx, ["pane", "list"])).panes ?? [];
      const panePresent = panes.some(
        (pane) => pane.pane_id === observedAgentEvidence.agentPaneId,
      );
      const processAlive = (() => {
        try {
          process.kill(observedAgentEvidence.process.pid, 0);
          return true;
        } catch (error) {
          return error?.code !== "ESRCH";
        }
      })();
      const mailboxPending = await exactAgentMailboxPending(ctx, identity);
      const done = agentRetirementConverged({
        matchingAgents: matching.length,
        panePresent,
        processAlive,
        mailboxPending,
      });
      return {
        done,
        progress: {
          matchingAgents: matching.length,
          panePresent,
          processAlive,
          mailboxPending,
        },
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS },
  );
  const finalOwner = await rootSessionSnapshot(ctx);
  assert.ok(finalOwner);
  assert.ok(
    failedAgentHandoff(
      sessionEntries(finalOwner.contents),
      identity.requestId,
      identity.sessionId,
      identity.ownerSessionId,
    ),
  );
}

async function runManagerHandoffSmoke(ctx) {
  // Reuses the established Manager assignment and project-message paths; only the turnover under test is exercised.
  const branch = `herdsman/smoke-manager-handoff-${randomUUID()}`;
  const marker = `MANAGER_HANDOFF_PENDING_${randomUUID()}`;
  ctx.managerRecovery = { branch };
  ctx.owned.managerBranch = branch;
  await run("git", ["add", ".pi/agents/managed-lead.md"], { cwd: ctx.rootCwd });
  await run(
    "git",
    [
      "-c",
      "user.name=Herdsman Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Configure Manager handoff Lead",
    ],
    { cwd: ctx.rootCwd },
  );
  const root = async () => rootSessionSnapshot(ctx);
  await waitForEvidence(
    ctx,
    "manager-handoff-root-agent",
    async () => {
      const agents = (await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
      const rootAgent = agents.find(
        (agent) =>
          agent.pane_id === ctx.rootPaneId &&
          typeof agent.agent_session?.value === "string",
      );
      return { done: !!rootAgent };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS },
  );
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode active.",
    "--timeout",
    "15000",
  ]);
  const prompt = `Use delegate_project exactly once with branch ${branch} and task exactly "Do not modify files. Call message_supervisor with MANAGER_HANDOFF_READY, then end the turn."`;
  await submitPaneCommand(ctx, ctx.rootPaneId, prompt);
  const assignment = await waitForEvidence(
    ctx,
    "manager-handoff-assignment",
    async () => {
      const topology = await nestedCommand(ctx, [
        "worktree",
        "list",
        "--workspace",
        ctx.rootWorkspaceId,
      ]);
      if (!Array.isArray(topology.worktrees))
        throw new Error("Manager handoff worktree topology is unavailable");
      let worktree;
      try {
        worktree = captureManagerHandoffWorktree(
          ctx,
          topology.worktrees,
          branch,
        );
      } catch (error) {
        if (error?.code !== "SMOKE_OBSERVATION") throw error;
        return {
          done: false,
          progress: managerAssignmentDiagnostics({
            worktreeIdentityState: "incomplete",
            errorCategory: "worktree_identity_incomplete",
          }),
        };
      }
      const session = await root();
      if (session) assertNoFailedProjectDelegation(session.contents, branch);
      const rows = session ? staffDelegateResults(session.contents) : [];
      if (rows.length > 1)
        throw new Error("Manager handoff created multiple project assignments");
      const row = rows.length === 1 ? rows[0] : null;
      const fauxAttempts = await readFile(
        join(
          ctx.paths.piAgent,
          "pi-herdsman",
          "runtime",
          "smoke-faux-attempts.jsonl",
        ),
        "utf8",
      ).catch(() => "");
      const diagnostics = (values = {}) =>
        managerAssignmentDiagnostics({
          worktree: worktree ? "true" : "false",
          worktreeIdentityState: worktree ? "verified" : "not_observed",
          result: rows.length ? String(row?.branch === branch) : "not_observed",
          identity: managerAssignmentIdentity(row, worktree, branch),
          lead: "not_yet_evaluated",
          supervisorCall: "not_yet_evaluated",
          supervisorSuccess: "not_yet_evaluated",
          readiness: "not_yet_evaluated",
          fauxSupervisorToolAvailability:
            managerHandoffSupervisorToolAvailability(fauxAttempts),
          candidateProcessCount: "not_observed",
          provenanceMatch: "not_evaluated",
          ...values,
        });
      if (managerAssignmentBranchMismatch(row, branch))
        throw new Error(
          "Manager handoff delegate result has a mismatched branch identity",
        );
      if (row?.workspace_id) {
        ctx.owned.managerWorkspaceId = row.workspace_id;
      }
      if (row?.workspace_id)
        captureManagerHandoffWorktree(
          ctx,
          topology.worktrees,
          branch,
          row.workspace_id,
        );
      if (!row || !row.branch || !row.session || !row.workspace_id || !worktree)
        return { done: false, progress: diagnostics() };
      const agents = (await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
      let lead;
      for (const agent of agents)
        if (
          agent.workspace_id === row.workspace_id &&
          agent.pane_id !== ctx.rootPaneId &&
          (await agentSessionId(ctx, agent)) === row.session
        ) {
          lead = agent;
          break;
        }
      if (!lead)
        return { done: false, progress: diagnostics({ lead: "false" }) };
      const leadSession = await isolatedSessionDetails(ctx, lead);
      let processCount = "not_observed";
      let provenanceMatch = "not_evaluated";
      let errorCategory = "none";
      try {
        const info = await nestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          lead.pane_id,
        ]);
        const processes = candidateProcess(
          info,
          ctx.candidateExtension,
          ctx.herdrStateExtension,
        );
        processCount = processes.length;
        const provenancePath = join(
          ctx.paths.piAgent,
          "pi-herdsman",
          "runtime",
          "smoke-faux-provenance.jsonl",
        );
        const records = (await readFile(provenancePath, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        matchPiProvenance(
          records,
          row.session,
          lead.pane_id,
          processes,
          "manager-handoff-lead",
          true,
          ctx.expectedPiVersion,
        );
        provenanceMatch = "true";
      } catch {
        provenanceMatch = "false";
        errorCategory = "provenance_observation_failed";
      }
      const supervisor = supervisorMessageDiagnostics(
        leadSession.path,
        row.session,
        "MANAGER_HANDOFF_READY",
      );
      const ready = supervisor.supervisorResultState === "success";
      const readyEntry =
        session &&
        sessionEntries(session.contents).find(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "pi-herdsman-project_message" &&
            entry.details?.branch === row.branch &&
            entry.details?.fromSessionId === row.session &&
            entry.content ===
              `Project ${row.branch} from lead ${row.session}:\n\nMANAGER_HANDOFF_READY`,
        );
      const supervisorResult = supervisor.supervisorResultState;
      if (!ready || !readyEntry)
        return {
          done: false,
          progress: diagnostics({
            lead: "true",
            candidateProcessCount: processCount,
            provenanceMatch,
            errorCategory,
            ...supervisor,
            supervisorCall: String(supervisor.supervisorCallObserved),
            supervisorSuccess: String(ready),
            supervisorResult,
            readiness: String(!!readyEntry),
            readinessDeliveryObserved: !!readyEntry,
          }),
        };
      return {
        done: true,
        progress: diagnostics({
          lead: "true",
          candidateProcessCount: processCount,
          provenanceMatch,
          errorCategory,
          supervisorCall: "true",
          supervisorSuccess: "true",
          ...supervisor,
          readiness: "true",
          readinessDeliveryObserved: true,
        }),
        value: { row, lead, leadSession, owner: session },
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  const row = assignment.row;
  const lead = assignment.lead;
  const leadSessionId = row.session;
  const worktrees = await nestedCommand(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  const worktree = (worktrees.worktrees ?? []).find(
    (item) => item.branch === branch,
  );
  if (!worktree) throw new Error("Manager handoff worktree was not found");
  const worktreePath = worktree.path ?? worktree.worktree_path;
  ctx.owned.managerWorkspaceId = row.workspace_id;
  ctx.owned.managerWorktreePath = worktreePath;
  ctx.managerRecovery = {
    ...ctx.managerRecovery,
    sessionId: leadSessionId,
    workspaceId: row.workspace_id,
    worktreePath,
  };
  const topology = await nestedCommand(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  const repoKey = topology.source?.repo_key;
  if (typeof repoKey !== "string")
    throw new Error("Manager handoff repository identity is missing");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const runtime = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "supervision-v2",
    hash(nestedHerdrApiSocketPath(ctx.paths, ctx.sessionName)),
  );
  const assignmentPath = join(
    runtime,
    "assignments",
    hash(repoKey),
    `${hash(branch)}.json`,
  );
  const managerPath = join(
    runtime,
    "managers",
    `${hash(ctx.rootWorkspaceId)}.json`,
  );
  const provenancePath = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "smoke-faux-provenance.jsonl",
  );
  const leadProcessPid = async () => {
    const info = await nestedCommand(ctx, [
      "pane",
      "process-info",
      "--pane",
      lead.pane_id,
    ]);
    const processes = candidateProcess(
      info,
      ctx.candidateExtension,
      ctx.herdrStateExtension,
    );
    const provenance = (await readFile(provenancePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const proof = matchPiProvenance(
      provenance,
      leadSessionId,
      lead.pane_id,
      processes,
      "manager-handoff-lead",
      true,
      ctx.expectedPiVersion,
    );
    return proof.pid;
  };
  const initialLeadPid = await leadProcessPid();
  const initialBytes = await readFile(assignmentPath, "utf8");
  const previousLease = JSON.parse(await readFile(managerPath, "utf8")).leaseId;
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager leave");
  await waitForEvidence(
    ctx,
    "manager-handoff-manager-absent",
    async () => {
      try {
        await lstat(managerPath);
        return { done: false };
      } catch (error) {
        if (error.code === "ENOENT") return { done: true };
        throw error;
      }
    },
    { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS },
  );
  const assertLeadContinuity = async () => {
    assert.equal(await readFile(assignmentPath, "utf8"), initialBytes);
    if (!managerHandoffLeadPidContinues(initialLeadPid, await leadProcessPid()))
      throw new Error(
        "Assigned Lead Pi process changed during Manager handoff",
      );
    const agents = (await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
    const sameLead = agents.find(
      (agent) =>
        agent.workspace_id === row.workspace_id &&
        agent.pane_id === lead.pane_id,
    );
    if (!sameLead || (await agentSessionId(ctx, sameLead)) !== leadSessionId)
      throw new Error("Assigned Lead did not remain in its exact session");
    const panes = (await nestedCommand(ctx, ["pane", "list"])).panes ?? [];
    if (
      resolve(
        panes.find((pane) => pane.pane_id === lead.pane_id)?.cwd ?? "",
      ) !== resolve(worktreePath)
    )
      throw new Error("Assigned Lead workspace changed during Manager handoff");
  };
  await assertLeadContinuity();
  const leadPrompt = `Call message_supervisor exactly once with this exact text: ${marker}. Then end the turn.`;
  await nestedCommand(ctx, ["agent", "prompt", lead.pane_id, leadPrompt]);
  const messagesDir = join(dirname(assignmentPath), `${hash(branch)}.messages`);
  const retained = await waitForEvidence(
    ctx,
    "manager-handoff-retained",
    async () => {
      try {
        const records = [];
        for (const name of await readdir(messagesDir))
          if (name.endsWith(".json"))
            try {
              records.push(
                JSON.parse(await readFile(join(messagesDir, name), "utf8")),
              );
            } catch (error) {
              if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
                throw error;
            }
        const record = managerHandoffRetainedRecord(
          records,
          repoKey,
          branch,
          leadSessionId,
          marker,
        );
        const leadSession = await isolatedSessionDetails(ctx, lead);
        const toolEvidence =
          leadSession &&
          hasSuccessfulSupervisorMessage(leadSession.contents, marker);
        return {
          done: !!record && !!toolEvidence,
          value: record,
          progress: { retained: !!record, successfulToolCall: !!toolEvidence },
        };
      } catch (error) {
        if (error.code === "ENOENT") return { done: false };
        throw error;
      }
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  let managerLeasePresent = true;
  try {
    await lstat(managerPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    managerLeasePresent = false;
  }
  const beforeReentry = await root();
  if (!beforeReentry)
    throw new Error("Manager handoff owner session disappeared before reentry");
  if (
    !managerHandoffCanReenter(
      managerLeasePresent,
      beforeReentry.contents,
      repoKey,
      branch,
      leadSessionId,
      retained.id,
      marker,
    )
  )
    throw new Error("Manager handoff was delivered before Manager reentry");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  const newLease = await waitForEvidence(
    ctx,
    "manager-handoff-reentered",
    async () => {
      try {
        const lease = JSON.parse(await readFile(managerPath, "utf8")).leaseId;
        return { done: lease !== previousLease, value: lease };
      } catch (error) {
        if (error.code === "ENOENT") return { done: false };
        throw error;
      }
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS },
  );
  const delivered = await waitForEvidence(
    ctx,
    "manager-handoff-delivered",
    async () => {
      const session = await root();
      const entry =
        session &&
        managerHandoffDeliveredEntry(
          session.contents,
          repoKey,
          branch,
          leadSessionId,
          retained.id,
          marker,
        );
      return {
        done: !!entry,
        value: entry && session,
        progress: { delivered: !!entry },
      };
    },
    { timeoutMs: 60_000, stallMs: MODEL_STALL_MS },
  );
  await waitForEvidence(
    ctx,
    "manager-handoff-consumed",
    async () => {
      try {
        return {
          done: !(await readdir(messagesDir)).includes(`${retained.id}.json`),
        };
      } catch (error) {
        if (error.code === "ENOENT") return { done: true };
        throw error;
      }
    },
    { timeoutMs: 30_000, stallMs: MODEL_STALL_MS },
  );
  await assertLeadContinuity();
  assert.notEqual(newLease, previousLease);
  if (
    resolve(
      (await nestedCommand(ctx, ["pane", "list"])).panes.find(
        (pane) => pane.pane_id === lead.pane_id,
      )?.cwd,
    ) !== resolve(worktreePath)
  )
    throw new Error("Assigned Lead workspace changed during Manager handoff");
}

export function managerRecoveryResumePrompt(branch) {
  return `Resume the existing work on branch ${branch}.\n\nCall resume_project using only:\n${JSON.stringify({ branch })}\n\nDo not start new work.\n\nAfter recovery succeeds, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED and end the turn.`;
}

export function managerRecoveryRetiredResumePrompt(branch) {
  return `Attempt to resume the retired assignment on ${branch}. Call resume_project exactly once using only ${JSON.stringify({ branch })}. Do not delegate new work. After the tool fails because there is no assignment, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_RETIRED and end the turn.`;
}

export function managerRecoveryPostRecoveryPrompt() {
  return "Recall the exact context marker you were instructed to remember before recovery using your prior conversation context. This information must reach the Manager before your normal result boundary, so send it now with message_supervisor. If information can wait until the normal result boundary, do not send it early; let the automatic result handoff carry it. Use exactly the recalled marker as the message and no other tool.";
}

export function managerRecoveryLeadContextPrompt(marker) {
  return `Remember this exact context marker for later: ${marker}\n\nReply with exactly the marker and do not call any tools.`;
}

export function managerRecoveryStopPrompt(session) {
  return `Pause the existing project work. Call stop_lead exactly once using only ${JSON.stringify({ session })}. After stop_lead succeeds, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_PAUSED.`;
}

export function managerRecoveryReviewPrompt(branch) {
  return `Use message_staff to send a nonblocking request for the Lead to confirm readiness for review of ${branch}. Routine information that can wait should be left to the Lead's automatic result handoff. Then end the turn.`;
}

export function managerRecoveryResumeOnlyPrompt(branch) {
  return `Resume the existing project work on the exact full branch string ${JSON.stringify(branch)}. Copy that branch string verbatim; do not shorten, summarize, normalize, or otherwise alter it.\n\nCall resume_project exactly once using only these arguments:\n${JSON.stringify({ branch })}\n\nDo not call any other tool.\n\nAfter resume_project succeeds, reply exactly:\nPI_HERDSMAN_MANAGER_RECOVERY_RESUMED`;
}

export function managerRecoveryResumeDiagnostics(contents, prompt) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const isDescendantOf = (entry, ancestorId) => {
    const visited = new Set();
    let parentId = entry.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const promptEntry = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt,
  );
  if (!promptEntry) return [];
  return entries.flatMap((entry) => {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      !isDescendantOf(entry, promptEntry.id)
    )
      return [];
    return (Array.isArray(entry.message.content) ? entry.message.content : [])
      .filter(
        (part) => part.type === "toolCall" && part.name === "resume_project",
      )
      .map((call) => {
        const result = entries.find(
          (candidate) =>
            candidate.type === "message" &&
            candidate.message?.role === "toolResult" &&
            candidate.message.toolName === "resume_project" &&
            candidate.message.toolCallId === call.id,
        );
        return {
          branch: call.arguments?.branch ?? null,
          arguments: call.arguments ?? null,
          result: result
            ? {
                isError: result.message.isError === true,
                details: result.message.details ?? null,
                content: messageText(result.message.content),
              }
            : null,
        };
      });
  });
}

export function initialPromptForScenario(scenario, ctx) {
  switch (scenario) {
    case "core":
      return corePrompt(ctx.expectedPackage);
    case "continuation":
      return continuationPrompt();
    case "chief-tree":
      return "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.";
    case "supervisor-agent":
      return "Reply exactly with PI_HERDSMAN_SUPERVISOR_AGENT_STARTUP.";
    case "manager-recovery":
      return undefined;
    case "terminal-failure":
      return undefined;
    case "agent-terminal-failure":
    case "manager-handoff":
      return undefined;
    case "agent-crash-recovery":
      return undefined;
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

export async function runScenario(ctx, scenario) {
  markStage(ctx, scenario);
  switch (scenario) {
    case "core":
      return runCoreSmoke(ctx);
    case "continuation":
      return runContinuationSmoke(ctx);
    case "chief-tree":
      return runChiefTreeSmoke(ctx);
    case "supervisor-agent":
      return runSupervisorAgentSmoke(ctx);
    case "manager-recovery":
      return runManagerRecoverySmoke(ctx);
    case "terminal-failure":
      return runTerminalFailureSmoke(ctx);
    case "agent-terminal-failure":
      return runAgentTerminalFailureSmoke(ctx);
    case "manager-handoff":
      return runManagerHandoffSmoke(ctx);
    case "agent-crash-recovery":
      return runAgentCrashRecoverySmoke(ctx);
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

function hasExtensionArg(argv, extension) {
  return argv.some(
    (arg, index) => arg === "--extension" && argv[index + 1] === extension,
  );
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandLineHasPath(cmdline, path) {
  return new RegExp(`(?:^|[\\s"'])${escapedPattern(path)}(?:$|[\\s"'])`).test(
    cmdline,
  );
}

function candidateProcessMatch(proc, extension, integration) {
  if (Array.isArray(proc.argv)) {
    if (
      hasExtensionArg(proc.argv, extension) &&
      hasExtensionArg(proc.argv, integration)
    )
      return "argv";
    // shortcut: accepts Pi's exact process title when Linux hides CLI args, later scenario evidence still proves loaded extensions; upgrade when Herdr exposes executable and extension provenance.
    if (
      proc.name === "pi" &&
      proc.argv.length === 1 &&
      proc.argv[0] === "pi" &&
      proc.cmdline === "pi" &&
      Number.isSafeInteger(proc.pid) &&
      proc.pid > 0
    )
      return "process-title";
    return null;
  }
  if (typeof proc.cmdline === "string")
    return commandLineHasPath(proc.cmdline, extension) &&
      commandLineHasPath(proc.cmdline, integration)
      ? "cmdline"
      : null;
  return null;
}

function candidateProcess(processInfo, extension, integration) {
  return (processInfo?.process_info?.foreground_processes ?? []).filter(
    (proc) => candidateProcessMatch(proc, extension, integration),
  );
}

export function listedPanes(value) {
  assert.ok(Array.isArray(value?.panes), "Herdr pane list result is malformed");
  return value.panes.map((pane) => {
    assert.ok(
      typeof pane?.pane_id === "string" && pane.pane_id,
      "Herdr pane list entry is malformed",
    );
    return { paneId: pane.pane_id };
  });
}

export async function inspectPaneProcesses(
  panes,
  rootPaneId,
  inspect,
  extension,
  integration,
) {
  const paneIds = [
    ...new Set(
      panes.map((pane) => (typeof pane === "string" ? pane : pane.paneId)),
    ),
  ].filter((paneId) => paneId && paneId !== rootPaneId);
  const inspected = await Promise.all(
    paneIds.map(async (paneId) => {
      try {
        return { paneId, info: await inspect(paneId) };
      } catch (error) {
        if (error?.code === "SMOKE_PROTOCOL") throw error;
        return { paneId, error: error?.message ?? String(error) };
      }
    }),
  );
  const records = inspected.flatMap(({ paneId, info, error }) => {
    const processes = info?.process_info?.foreground_processes;
    if (error) return [{ paneId, pid: null, processMatch: false, error }];
    if (!Array.isArray(processes) || !processes.length)
      return [
        {
          paneId,
          pid: null,
          processMatch: false,
          error: "no foreground process records",
        },
      ];
    return processes.map((proc) => {
      const processMatchSource = candidateProcessMatch(
        proc,
        extension,
        integration,
      );
      return {
        paneId,
        pid: proc.pid ?? null,
        processMatch: !!processMatchSource,
        processMatchSource,
        error: null,
      };
    });
  });
  const verified = new Map();
  for (const record of records) {
    if (record.processMatch && record.pid != null)
      verified.set(`${record.paneId}\0${record.pid}`, record);
  }
  return { records, verified: [...verified.values()] };
}

export async function bestEffortProcessDiagnostics(...args) {
  try {
    return (await inspectPaneProcesses(...args)).records.slice(0, 40);
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 500) };
  }
}

async function inspectCandidateProcesses(ctx) {
  const listed = await tryNestedCommand(ctx, ["pane", "list"]);
  if (!listed.ok) throw observationFailure(listed.error);
  const inspection = await inspectPaneProcesses(
    listedPanes(listed.value),
    ctx.rootPaneId,
    async (paneId) => {
      const result = await tryNestedCommand(ctx, [
        "pane",
        "process-info",
        "--pane",
        paneId,
      ]);
      if (!result.ok) throw observationFailure(result.error);
      return result.value;
    },
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  const unresolved = inspection.records
    .filter((record) => record.error)
    .map((record) => ({ paneId: record.paneId, error: record.error }));
  return {
    ...inspection,
    paneIds: listedPanes(listed.value).map(({ paneId }) => paneId),
    unresolved,
  };
}

async function rootSessionSnapshot(ctx) {
  const observed = await tryNestedCommand(ctx, ["agent", "list"]);
  if (!observed.ok) throw observationFailure(observed.error);
  const listed = observed.value;
  const rootAgent = (listed.agents ?? []).find(
    (agent) => agent.pane_id === ctx.rootPaneId,
  );
  const sessionPath = rootAgent?.agent_session?.value;
  if (!sessionPath || rootAgent.agent_session?.kind !== "path") return null;
  const absolutePath = resolve(sessionPath);
  const sessionRoot = resolve(ctx.paths.piSessions);
  const relativePath = relative(sessionRoot, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(
      "root Pi session path is outside the isolated session directory",
    );
  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("root Pi session is not a regular isolated session file");
  if (details.size > MAX_SESSION_BYTES)
    throw new Error(
      `root Pi session exceeds ${MAX_SESSION_BYTES} byte read limit`,
    );
  const contents = await readFile(absolutePath, "utf8");
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  if (!header) return null;
  if (header.cwd !== ctx.rootCwd)
    throw new Error(
      "root Pi session cwd does not match the candidate repository",
    );
  return { path: absolutePath, status: rootAgent.agent_status, contents };
}

function smokeAgentLabel(agent) {
  return agent?.label ?? agent?.agent_label ?? agent?.agent;
}

async function smokeMailbox(
  ctx,
  agent,
  expectedLabel = smokeAgentLabel(agent),
) {
  const root = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "mailboxes-v5",
  );
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!/^[0-9a-f]{32}$/.test(dir.name)) continue;
    if (dir.isSymbolicLink() || !dir.isDirectory())
      throw new Error("smoke mailbox inventory contains an unsafe entry");
    const directory = join(root, dir.name);
    const statePath = join(directory, "state.json");
    let stateStat;
    try {
      stateStat = await lstat(statePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !stateStat.isFile() ||
      stateStat.isSymbolicLink() ||
      stateStat.size > 65536
    )
      throw new Error("smoke mailbox state is not a bounded regular file");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.agentLabel !== expectedLabel) continue;
    const requestPath = state.activeRequestId
      ? join(directory, `request-${state.activeRequestId}.json`)
      : undefined;
    let request;
    if (requestPath) {
      try {
        const requestStat = await lstat(requestPath);
        if (
          !requestStat.isFile() ||
          requestStat.isSymbolicLink() ||
          requestStat.size > 4 * 1024 * 1024
        )
          throw new Error(
            "smoke mailbox request is not a bounded regular file",
          );
        request = JSON.parse(await readFile(requestPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return { directory, state, request };
  }
  throw new Error(`mailbox not found for ${smokeAgentLabel(agent)}`);
}

async function smokeManagedAgentRecords(ctx, agents) {
  return Promise.all(
    agents.map(async (agent) => {
      const session = await isolatedSessionDetails(ctx, agent);
      if (!session) return { agent, session, mailbox: undefined };
      const root = join(
        ctx.paths.piAgent,
        "pi-herdsman",
        "runtime",
        "mailboxes-v5",
      );
      let mailboxDirs;
      try {
        mailboxDirs = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT")
          return { agent, session, mailbox: undefined };
        throw error;
      }
      for (const dir of mailboxDirs) {
        if (!/^[0-9a-f]{32}$/.test(dir.name)) continue;
        if (dir.isSymbolicLink() || !dir.isDirectory())
          throw new Error("smoke mailbox inventory contains an unsafe entry");
        const statePath = join(root, dir.name, "state.json");
        let stateStat;
        try {
          stateStat = await lstat(statePath);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (
          !stateStat.isFile() ||
          stateStat.isSymbolicLink() ||
          stateStat.size > 65536
        )
          throw new Error("smoke mailbox state is not a bounded regular file");
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (state.piSessionId !== session.id) continue;
        return {
          agent,
          session,
          mailbox: await smokeMailbox(ctx, agent, state.agentLabel),
        };
      }
      return { agent, session, mailbox: undefined };
    }),
  );
}

async function restartNestedHerdr(ctx) {
  await run("herdr", ["server", "stop"], {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
  await waitForEvidence(
    ctx,
    "crash-recovery-server-stopped",
    async () => {
      const status = await tryHerdr(["status", "--json"], {
        env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
        timeout: OBSERVATION_TIMEOUT_MS,
      });
      return {
        done: !status.ok || status.value?.server?.running === false,
        observationError: status.ok ? undefined : status.error,
        evidence: status.ok ? status.value?.server : undefined,
      };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  await run(
    "herdr",
    [
      "pane",
      "run",
      ctx.owned.hostPaneId,
      shellCommand(["herdr", "--session", ctx.sessionName]),
    ],
    { env: ctx.parentEnv },
  );
  await waitForNestedHerdr(ctx);
  const status = await nestedCommand(ctx, ["status", "--json"]);
  requireNestedHerdrServer(status, ctx.sessionName, ctx.nestedServerVersion);
}

async function runAgentCrashRecoverySmoke(ctx) {
  const startedAt = Date.now();
  assert.ok(
    ctx.paths.root &&
      resolve(ctx.paths.xdgConfig).startsWith(
        `${resolve(ctx.paths.root)}${sep}`,
      ) &&
      /^phs-[0-9a-f-]{12}$/.test(ctx.sessionName) &&
      ctx.owned.hostPaneId,
    "crash-recovery resources are not proven disposable and isolated",
  );
  const isolatedSessions = await tryHerdr(["session", "list", "--json"], {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
  if (!isolatedSessions.ok) throw observationFailure(isolatedSessions.error);
  assert.ok(
    isolatedSessions.value.sessions?.some(
      (session) => session.name === ctx.sessionName,
    ),
    "named disposable session is not present in its isolated Herdr config",
  );
  const firstAgents = await waitForEvidence(
    ctx,
    "crash-recovery-accepted-generations",
    async () => {
      const listing = await tryNestedCommand(ctx, ["agent", "list"]);
      if (!listing.ok) return { done: false, observationError: listing.error };
      const agents = listing.value.agents ?? [];
      const managed = await smokeManagedAgentRecords(ctx, agents);
      const target = managed.find(
        ({ mailbox }) => mailbox?.state.agentLabel === "smoke-crash-target",
      )?.agent;
      const parent = managed.find(
        ({ mailbox }) => mailbox?.state.agentLabel === "smoke-crash-parent",
      )?.agent;
      const child = managed.find(
        ({ mailbox }) => mailbox?.state.agentLabel === "smoke-crash-child",
      )?.agent;
      if (!target || !parent || !child) {
        return {
          done: false,
          progress: {
            target: !!target,
            parent: !!parent,
            child: !!child,
            agentCount: agents.length,
          },
        };
      }
      const [targetSession, parentSession, childSession] = await Promise.all([
        isolatedSessionDetails(ctx, target),
        isolatedSessionDetails(ctx, parent),
        isolatedSessionDetails(ctx, child),
      ]);
      if (!targetSession || !parentSession || !childSession)
        return { done: false, progress: { sessions: false } };
      const [targetMailbox, parentMailbox, childMailbox] = await Promise.all([
        smokeMailbox(ctx, target, "smoke-crash-target"),
        smokeMailbox(ctx, parent, "smoke-crash-parent"),
        smokeMailbox(ctx, child, "smoke-crash-child"),
      ]);
      if (
        !targetMailbox.state.activeRequestId ||
        !parentMailbox.state.activeRequestId ||
        !childMailbox.state.pendingAskId ||
        childMailbox.state.ownerSessionId !== parentSession.id
      )
        return {
          done: false,
          progress: {
            targetRequest: !!targetMailbox.state.activeRequestId,
            parentRequest: !!parentMailbox.state.activeRequestId,
            childAsk: !!childMailbox.state.pendingAskId,
          },
        };
      const herdrSnapshot = await nestedCommand(ctx, ["api", "snapshot"]);
      const snapshot = herdrSnapshot.snapshot;
      const capturedSessions = new Set([
        targetSession.path,
        parentSession.path,
        childSession.path,
      ]);
      ctx.crashRecovery = {
        target: {
          sessionId: targetSession.id,
          sessionPath: targetSession.path,
          runId: targetMailbox.state.runId,
          requestId: targetMailbox.state.activeRequestId,
          paneId: target.pane_id,
          workspaceId: target.workspace_id,
          request: targetMailbox.request
            ? {
                requestId: targetMailbox.request.requestId,
                runId: targetMailbox.request.runId,
                ownerSessionId: targetMailbox.request.ownerSessionId,
                kind: targetMailbox.request.kind,
              }
            : null,
        },
        parent: {
          sessionId: parentSession.id,
          sessionPath: parentSession.path,
          runId: parentMailbox.state.runId,
          requestId: parentMailbox.state.activeRequestId,
          paneId: parent.pane_id,
          workspaceId: parent.workspace_id,
        },
        child: {
          sessionId: childSession.id,
          sessionPath: childSession.path,
          runId: childMailbox.state.runId,
          requestId: childMailbox.state.activeRequestId,
          paneId: child.pane_id,
          workspaceId: child.workspace_id,
          pendingAskId: childMailbox.state.pendingAskId,
        },
        ownerSessionPath: (await rootSessionSnapshot(ctx)).path,
        workspaceId: ctx.rootWorkspaceId,
        sessionName: ctx.sessionName,
        parentSnapshot: {
          version: snapshot.version,
          workspaceId: snapshot.workspaces?.find(
            (workspace) => workspace.workspace_id === ctx.rootWorkspaceId,
          )?.workspace_id,
          agents: snapshot.agents
            .filter((agent) => capturedSessions.has(agent.agent_session?.value))
            .map((agent) => ({
              session: agent.agent_session?.value,
              paneId: agent.pane_id,
              workspaceId: agent.workspace_id,
              agentStatus: agent.agent_status,
            })),
          panes: snapshot.panes
            .filter((pane) => capturedSessions.has(pane.agent_session?.value))
            .map((pane) => ({
              paneId: pane.pane_id,
              workspaceId: pane.workspace_id,
              agentStatus: pane.agent_status,
            })),
        },
        processInfoBeforeRestart: [],
      };
      for (const agent of [target, parent, child]) {
        const observed = await tryNestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          agent.pane_id,
        ]);
        if (!observed.ok)
          return { done: false, observationError: observed.error };
        ctx.crashRecovery.processInfoBeforeRestart.push({
          label:
            agent === target
              ? "smoke-crash-target"
              : agent === parent
                ? "smoke-crash-parent"
                : "smoke-crash-child",
          paneId: agent.pane_id,
          processInfo: {
            paneId: observed.value.process_info?.pane_id,
            shellPid: observed.value.process_info?.shell_pid,
            foregroundProcesses: (
              observed.value.process_info?.foreground_processes ?? []
            ).map((process) => ({ pid: process.pid, argv0: process.argv0 })),
          },
        });
      }
      return {
        done: true,
        value: ctx.crashRecovery,
        progress: {
          requestIds: [
            targetMailbox.state.activeRequestId,
            parentMailbox.state.activeRequestId,
            childMailbox.state.activeRequestId,
          ],
        },
      };
    },
    { timeoutMs: 120_000, stallMs: MODEL_STALL_MS, pollMs: 200 },
  );

  const ownerSession = await rootSessionSnapshot(ctx);
  const ownerHeader = sessionEntries(ownerSession.contents).find(
    (entry) => entry.type === "session",
  );
  assert.ok(ownerHeader?.id, "saved owner session omitted its exact ID");
  ctx.crashRecovery.ownerSessionId = ownerHeader.id;
  await restartNestedHerdr(ctx);
  ctx.crashRecovery.restartDurationMs = Date.now() - startedAt;

  const restartedListing = await nestedCommand(ctx, ["agent", "list"]);
  const restartedAgents = restartedListing.agents ?? [];
  const restartedManaged = await smokeManagedAgentRecords(ctx, restartedAgents);
  const restoredParent = restartedManaged.find(
    ({ mailbox }) => mailbox?.state.agentLabel === "smoke-crash-parent",
  );
  assert.ok(
    restoredParent,
    "pending-child parent disappeared from the restored agent list",
  );
  ctx.crashRecovery.parentAfterRestart = {
    paneId: restoredParent.agent.pane_id,
    agentStatus: restoredParent.agent.agent_status,
    sessionId: restoredParent.session?.id,
    mailboxRequestId: restoredParent.mailbox.state.activeRequestId,
  };
  assert.equal(
    ctx.crashRecovery.parentAfterRestart.agentStatus,
    "idle",
    `expected restored pending-child parent pane to be idle, observed ${ctx.crashRecovery.parentAfterRestart.agentStatus}`,
  );
  const parentProcessAfterRestart = await tryNestedCommand(ctx, [
    "pane",
    "process-info",
    "--pane",
    restoredParent.agent.pane_id,
  ]);
  ctx.crashRecovery.parentAfterRestart.processInfo =
    parentProcessAfterRestart.ok
      ? {
          found: true,
          processInfo: parentProcessAfterRestart.value.process_info,
        }
      : { found: false, error: parentProcessAfterRestart.error };

  const created = await nestedCommand(ctx, [
    "tab",
    "create",
    "--workspace",
    ctx.rootWorkspaceId,
    "--cwd",
    ctx.rootCwd,
    "--label",
    "smoke-crash-owner-reopen",
    "--no-focus",
  ]);
  const ownerPane = created.root_pane;
  assert.ok(
    ownerPane?.pane_id,
    "could not create isolated owner controller pane",
  );
  ctx.crashRecovery.reopenedOwnerTabId = created.tab?.tab_id;
  ctx.rootPaneId = ownerPane.pane_id;
  const restartPrompt = `PI_HERDSMAN_CRASH_RECOVERY_AFTER_RESTART target session: ${ctx.crashRecovery.target.sessionPath}. Inspect list_agents, cleanly close only smoke-crash-target if close_agent is available, then continue that exact saved session.`;
  const args = candidateArgs({
    candidateExtension: ctx.candidateExtension,
    herdrStateExtension: ctx.herdrStateExtension,
    simulatedProviderExtension: ctx.simulatedProviderExtension,
    model: ctx.model,
  });
  await run(
    "herdr",
    [
      "pane",
      "run",
      ctx.rootPaneId,
      rootCandidateCommand([
        "pi",
        ...args,
        "--session",
        ctx.crashRecovery.ownerSessionPath,
      ]),
    ],
    { env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName) },
  );
  await waitForEvidence(
    ctx,
    "crash-recovery-owner-reopened",
    async () => {
      const agents = await tryNestedCommand(ctx, ["agent", "list"]);
      if (!agents.ok) return { done: false, observationError: agents.error };
      const owner = (agents.value.agents ?? []).find(
        (agent) =>
          agent.pane_id === ctx.rootPaneId &&
          agent.agent_session?.kind === "path" &&
          resolve(agent.agent_session.value) ===
            ctx.crashRecovery.ownerSessionPath,
      );
      return { done: !!owner, value: owner };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  await nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, restartPrompt]);

  const reopenedOwner = await waitForEvidence(
    ctx,
    "crash-recovery-restored-controller-list",
    async () => {
      const owner = await rootSessionSnapshot(ctx);
      const found =
        owner &&
        sessionEntries(owner.contents).some(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolName === "list_agents" &&
            !entry.message.isError,
        );
      return { done: !!found, value: owner };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  const ownerEntries = sessionEntries(reopenedOwner.contents);
  const listResult = ownerEntries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "list_agents" &&
      !entry.message.isError,
  );
  const controlledAgents = listResult?.message?.details?.agents;
  assert.ok(
    Array.isArray(controlledAgents),
    "reopened owner did not persist list_agents state",
  );
  const restoredParentState = controlledAgents.find(
    (agent) => smokeAgentLabel(agent) === "smoke-crash-parent",
  );
  const reopenedTarget = controlledAgents.find(
    (agent) => smokeAgentLabel(agent) === "smoke-crash-target",
  );
  assert.ok(
    restoredParentState,
    "reopened owner could not inspect pending-child parent",
  );
  assert.ok(
    ["blocked", "unknown"].includes(restoredParentState.state),
    `restored idle parent was not safely blocked/unknown: ${restoredParentState.state}`,
  );
  assert.ok(
    !restoredParentState.available_tools?.includes("steer_agent"),
    "restored parent was granted steer authority without live execution proof",
  );
  ctx.crashRecovery.parentAfterRestart.state = restoredParentState.state;
  ctx.crashRecovery.parentAfterRestart.availableTools =
    restoredParentState.available_tools ?? [];
  assert.ok(
    reopenedTarget,
    "target generation missing from reopened owner view",
  );
  assert.ok(
    reopenedTarget.available_tools?.includes("close_agent"),
    `target close is not permitted after restart; state=${reopenedTarget.state}, tools=${JSON.stringify(reopenedTarget.available_tools)}`,
  );

  const closeResult = await waitForEvidence(
    ctx,
    "crash-recovery-close-receipt-persisted",
    async () => {
      const owner = await rootSessionSnapshot(ctx);
      const entries = owner ? sessionEntries(owner.contents) : [];
      const result = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.toolName === "close_agent" &&
          !entry.message.isError,
      );
      const completed = owner?.contents.includes(
        "PI_HERDSMAN_CRASH_RECOVERY_CLOSED",
      );
      return { done: !!result && !!completed, value: result };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  const closeDetails = closeResult.message.details;
  assert.equal(
    closeDetails?.ok,
    true,
    `persisted close result was not successful: ${JSON.stringify(closeDetails)}`,
  );
  assert.equal(closeDetails?.action, "close");
  assert.equal(
    closeDetails?.closed_assignment?.session_path,
    ctx.crashRecovery.target.sessionPath,
    "close receipt did not identify the exact accepted target session",
  );
  ctx.crashRecovery.closeReceipt = closeDetails.closed_assignment;
  const afterCloseSnapshot = await nestedCommand(ctx, ["api", "snapshot"]);
  const staleTarget = (afterCloseSnapshot.snapshot?.agents ?? []).find(
    (agent) =>
      agent.agent_session?.value === ctx.crashRecovery.target.sessionPath ||
      agent.agent_session?.value === ctx.crashRecovery.target.sessionId,
  );
  let targetProcessAfterClose;
  if (staleTarget?.pane_id) {
    const processInfo = await tryNestedCommand(ctx, [
      "pane",
      "process-info",
      "--pane",
      staleTarget.pane_id,
    ]);
    targetProcessAfterClose = processInfo.ok
      ? { found: true, processInfo: processInfo.value.process_info }
      : { found: false, error: processInfo.error };
  }
  ctx.crashRecovery.staleTargetAfterClose = {
    agent: staleTarget
      ? {
          paneId: staleTarget.pane_id,
          workspaceId: staleTarget.workspace_id,
          session: staleTarget.agent_session,
        }
      : null,
    process: targetProcessAfterClose,
  };
  await nestedCommand(ctx, [
    "agent",
    "prompt",
    ctx.rootPaneId,
    "PI_HERDSMAN_CRASH_RECOVERY_CONTINUE: continue the exact cleanly closed target session without replaying its unfinished task.",
  ]);
  const continuationRelease = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "crash-continuation-release",
  );
  await waitForEvidence(
    ctx,
    "crash-recovery-new-generation",
    async () => {
      const owner = await rootSessionSnapshot(ctx);
      const entries = owner ? sessionEntries(owner.contents) : [];
      const continueResult = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.toolName === "continue_agent" &&
          !entry.message.isError,
      );
      const failedContinuation = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.toolName === "continue_agent" &&
          entry.message.isError,
      );
      if (failedContinuation)
        throw new Error(
          `continue_agent failed: ${JSON.stringify(failedContinuation.message.details)} / ${messageText(failedContinuation.message.content)}`,
        );
      if (!continueResult)
        return { done: false, progress: { continuationStarted: false } };
      const continued = continueResult.message.details;
      assert.equal(continued?.ok, true);
      assert.equal(continued?.session_id, ctx.crashRecovery.target.sessionId);
      const agents = await tryNestedCommand(ctx, ["agent", "list"]);
      if (!agents.ok) return { done: false, observationError: agents.error };
      const generation = (
        await smokeManagedAgentRecords(ctx, agents.value.agents ?? [])
      ).find(
        ({ agent, mailbox }) =>
          mailbox?.state.agentLabel === "smoke-crash-target" &&
          agent.agent_status === "working",
      );
      if (!generation)
        return { done: false, progress: { continuedGenerationVisible: false } };
      const { agent, mailbox, session } = generation;
      assert.equal(session?.path, ctx.crashRecovery.target.sessionPath);
      assert.notEqual(mailbox.state.runId, ctx.crashRecovery.target.runId);
      assert.notEqual(
        mailbox.state.activeRequestId,
        ctx.crashRecovery.target.requestId,
      );
      ctx.crashRecovery.continuedGeneration = {
        runId: mailbox.state.runId,
        requestId: mailbox.state.activeRequestId,
        sessionId: session.id,
        sessionPath: session.path,
        paneId: agent.pane_id,
        workspaceId: agent.workspace_id,
      };
      await writeFile(continuationRelease, "observed\n", {
        flag: "wx",
        mode: 0o600,
      });
      return { done: true, progress: { continuedGenerationVisible: true } };
    },
    { timeoutMs: 30_000, stallMs: MODEL_STALL_MS, pollMs: 200 },
  );
  await waitForEvidence(
    ctx,
    "crash-recovery-owner-completed",
    async () => {
      const owner = await rootSessionSnapshot(ctx);
      return {
        done:
          owner?.contents.includes("PI_HERDSMAN_CRASH_RECOVERY_CONTINUED") ??
          false,
        evidence: owner ? summarizeSession(owner.contents) : null,
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  await writeFile(
    join(ctx.paths.piAgent, "pi-herdsman", "runtime", "crash-parent-release"),
    "observed\n",
    { flag: "wx", mode: 0o600 },
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  ctx.crashRecovery.elapsedMs = Date.now() - startedAt;
}

export async function isolatedSessionDetails(ctx, agent) {
  const identity = agent?.agent_session;
  if (identity?.kind !== "path" || typeof identity.value !== "string")
    return null;
  const path = resolve(identity.value);
  const isolatedSessions = resolve(ctx.paths.piSessions);
  const relativePath = relative(isolatedSessions, path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(
      "managed Pi session path is outside the isolated session directory",
    );
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_SESSION_BYTES
  )
    throw new Error(
      "managed Pi session is not a bounded regular isolated session file",
    );
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  if (!header?.id)
    throw new Error("managed Pi session has no persisted session ID");
  return { path, id: header.id, contents };
}

export async function exactIsolatedSession(ctx, id) {
  const root = ctx.paths.piSessions;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  );
  if (files.length > 256)
    throw new Error(
      "too many isolated Pi session files to identify Lead safely",
    );
  const matches = [];
  for (const entry of files) {
    const session = await isolatedSessionDetails(ctx, {
      agent_session: {
        kind: "path",
        value: join(entry.parentPath, entry.name),
      },
    });
    if (session?.id === id) matches.push(session);
  }
  if (matches.length > 1)
    throw new Error(`ambiguous isolated Pi session ID: ${id}`);
  return matches[0];
}

async function agentSessionId(ctx, agent) {
  const identity = agent?.agent_session;
  if (identity?.kind === "id" && typeof identity.value === "string")
    return identity.value;
  return (await isolatedSessionDetails(ctx, agent))?.id;
}

export async function agentsForPiSession(
  ctx,
  agents,
  sessionId,
  getSessionId = agentSessionId,
) {
  const matches = [];
  for (const agent of agents)
    if ((await getSessionId(ctx, agent)) === sessionId) matches.push(agent);
  return matches;
}

export function assertCoreToolEvidence(simulated, evidence, expectedPackage) {
  if (!simulated) return;
  requireSmokeEvidence(
    JSON.stringify(evidence.map(({ name }) => name).sort()) ===
      JSON.stringify(["delegate_agent", "delegate_agent", "read"]),
    "core must perform the actual nested delegation and package read",
  );
  requireSmokeEvidence(
    evidence.some(
      ({ name, result }) =>
        name === "read" &&
        result.includes(`\"name\": \"${expectedPackage.split("@")[0]}\"`) &&
        result.includes(
          `\"version\": \"${expectedPackage.split("@").at(-1)}\"`,
        ),
    ),
    "correlated read result must contain the real package metadata",
  );
}

export function assertContinuationReadEvidence(
  simulated,
  reads,
  readResult,
  expectedName,
) {
  if (!simulated) return;
  assert.equal(reads.length, 1, "continued Agent must not reread package.json");
  assert.ok(
    readResult,
    "remembered package must come from its successful persisted read",
  );
  assert.ok(
    messageText(readResult.message.content).includes(expectedName),
    "persisted package read must contain the returned package name",
  );
}

async function runCoreSmoke(ctx) {
  const marker = `PI_HERDSMAN_SMOKE_OK ${ctx.expectedPackage}`;
  const observed = new Map();
  await waitForEvidence(
    ctx,
    "core-delegation",
    async () => {
      const inspection = await inspectCandidateProcesses(ctx);
      for (const item of inspection.verified) {
        observed.set(`${item.paneId}\0${item.pid}`, item);
      }
      if (inspection.verified.length)
        ctx.lastVerified = "agent_process_observed";
      const rootInfo = await tryNestedCommand(ctx, [
        "pane",
        "process-info",
        "--pane",
        ctx.rootPaneId,
      ]);
      if (!rootInfo.ok) throw observationFailure(rootInfo.error);
      const rootMatches = candidateProcess(
        rootInfo.value,
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      if (rootMatches.length === 1)
        ctx.coreRootProcess = {
          paneId: ctx.rootPaneId,
          pid: rootMatches[0].pid,
        };
      ctx.coreProcessEvidence = [...observed.values()].slice(-40);
      ctx.coreProcessDiagnostics = inspection.records.slice(0, 40);
      const session = await rootSessionSnapshot(ctx);
      if (session) {
        ctx.rootSessionPath = session.path;
        const assistantResult = assistantResultForSession(
          session,
          ctx.initialPrompt,
          marker,
        );
        if (assistantResult) ctx.assistantResult = assistantResult;
      }
      const paneCount = distinctPaneCount([...observed.values()]);
      if (session && ctx.assistantResult)
        ctx.lastVerified = "scenario_session_result_observed";
      return {
        done: !!ctx.assistantResult && paneCount >= 2 && !!ctx.coreRootProcess,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          verifiedProcesses: [...observed.keys()].sort(),
          assistantResultFound: !!ctx.assistantResult,
        },
        evidence: {
          paneCount,
          rootSession: session ? summarizeSession(session.contents) : null,
          processRecords: inspection.records.slice(-10),
        },
        value: paneCount,
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  if (ctx.simulated) {
    const provenancePath = join(
      ctx.paths.piAgent,
      "pi-herdsman",
      "runtime",
      "smoke-faux-provenance.jsonl",
    );
    const provenance = (await readFile(provenancePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    ctx.firstRequestObserved = provenance.length > 0;
    try {
      ctx.sessionStartObserved = Boolean(
        (
          await readFile(
            join(
              ctx.paths.piAgent,
              "pi-herdsman",
              "runtime",
              "smoke-faux-session-start.jsonl",
            ),
            "utf8",
          )
        ).trim(),
      );
    } catch {
      ctx.sessionStartObserved = false;
    }
    const sessionFiles = (
      await readdir(ctx.paths.piSessions, { recursive: true })
    ).filter((file) => file.endsWith(".jsonl"));
    const sessionIds = new Set();
    for (const file of sessionFiles) {
      const header = sessionEntries(
        await readFile(join(ctx.paths.piSessions, file), "utf8"),
      ).find((entry) => entry.type === "session");
      if (typeof header?.id === "string" && header.id)
        sessionIds.add(header.id);
    }
    const rootSession = await rootSessionSnapshot(ctx);
    const rootId =
      rootSession &&
      sessionEntries(rootSession.contents).find(
        (entry) => entry.type === "session",
      )?.id;
    requireSmokeEvidence(
      rootId,
      "core root session has no exact Pi session identity",
    );
    const observedProcesses = [ctx.coreRootProcess, ...observed.values()].map(
      ({ paneId, pid }) => ({ paneId, processes: [{ pid }] }),
    );
    const sessions = [];
    for (const file of sessionFiles) {
      const entries = sessionEntries(
        await readFile(join(ctx.paths.piSessions, file), "utf8"),
      );
      const id = entries.find((entry) => entry.type === "session")?.id;
      if (sessionIds.has(id)) sessions.push({ id, entries });
    }
    const expectedDefinitions = coreAgentDefinitionsExpectations(
      sessions,
      rootId,
    );
    for (const sessionId of sessionIds) {
      const expectedAgentDefinitions = expectedDefinitions.get(sessionId);
      requireSmokeEvidence(
        expectedAgentDefinitions !== undefined,
        `missing persisted role evidence for ${sessionId}`,
      );
      const matches = provenance.filter(
        (record) => record.sessionId === sessionId,
      );
      requireSmokeEvidence(
        matches.length === 1,
        `expected one provenance row for ${sessionId}`,
      );
      const record = matches[0];
      const pane = observedProcesses.find(({ processes }) =>
        processes.some((process) => process.pid === record.pid),
      );
      requireSmokeEvidence(
        pane,
        `no exact foreground PID match for ${sessionId}`,
      );
      matchPiProvenance(
        provenance,
        sessionId,
        pane.paneId,
        pane.processes,
        "core",
        expectedAgentDefinitions,
        ctx.expectedPiVersion,
      );
    }
    verifyCoreProvenanceEvidence(ctx, provenance, sessionIds);
    const files = (
      await readdir(ctx.paths.piSessions, { recursive: true })
    ).filter((file) => file.endsWith(".jsonl"));
    const evidence = [];
    for (const file of files) {
      const entries = sessionEntries(
        await readFile(join(ctx.paths.piSessions, file), "utf8"),
      );
      const cwd = entries.find((entry) => entry.type === "session")?.cwd;
      const calls = entries.flatMap((entry) =>
        entry.type === "message" && entry.message?.role === "assistant"
          ? (entry.message.content ?? []).filter(
              (part) => part.type === "toolCall",
            )
          : [],
      );
      const results = entries
        .filter(
          (entry) =>
            entry.type === "message" && entry.message?.role === "toolResult",
        )
        .map((entry) => entry.message);
      for (const call of calls) {
        if (
          call.name !== "delegate_agent" &&
          !(
            call.name === "read" && isPackageReadPath(call.arguments?.path, cwd)
          )
        )
          continue;
        const result = results.find(
          (item) => item.toolCallId === call.id && item.toolName === call.name,
        );
        requireSmokeEvidence(
          result && !result.isError,
          `missing successful correlated ${call.name} result`,
        );
        evidence.push({ name: call.name, result: messageText(result.content) });
      }
    }
    assertCoreToolEvidence(ctx.simulated, evidence, ctx.expectedPackage);
    ctx.coreToolEvidence = evidence.map(({ name }) => name);
  }
  ctx.descendantCount = distinctPaneCount([...observed.values()]);
  await waitForDescendantsToExit(ctx);
}

async function runContinuationSmoke(ctx) {
  const deadline = Date.now() + 6 * 60_000;
  const firstPrompt = ctx.initialPrompt;
  const firstMarker = "PI_HERDSMAN_CONTINUATION_FIRST";
  const secondMarker = "PI_HERDSMAN_CONTINUATION_SECOND";
  const expectedName = JSON.parse(
    await readFile(join(ctx.repoRoot, "package.json"), "utf8"),
  ).name;
  let firstSession;
  let firstGeneration;
  const firstPids = new Set();

  const childAgents = async () => {
    const listed = await tryNestedCommand(ctx, ["agent", "list"]);
    if (!listed.ok) throw observationFailure(listed.error);
    return (listed.value.agents ?? []).filter(
      (agent) => agent.pane_id && agent.pane_id !== ctx.rootPaneId,
    );
  };

  const promptRoot = async (prompt) => {
    await nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  };

  firstSession = await waitForEvidence(
    ctx,
    "continuation-first-generation",
    async () => {
      const listed = await tryNestedCommand(ctx, ["agent", "list"]);
      if (!listed.ok) return { done: false, observationError: listed.error };
      const agents = (listed.value.agents ?? []).filter(
        (agent) => agent.pane_id && agent.pane_id !== ctx.rootPaneId,
      );
      if (agents.length > 1)
        throw new Error(
          `continuation-first-generation: expected one managed Agent, observed ${agents.length}`,
        );
      let session;
      let sessionError;
      let pids = [];
      for (const agent of agents) {
        try {
          session = await isolatedSessionDetails(ctx, agent);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sessionError = error.message;
        }
        if (session) {
          const observed = await tryNestedCommand(ctx, [
            "pane",
            "process-info",
            "--pane",
            agent.pane_id,
          ]);
          if (!observed.ok)
            return {
              done: false,
              observationError: observed.error,
              evidence: { sessionId: session.id, paneId: agent.pane_id },
            };
          pids = candidateProcess(
            observed.value,
            ctx.candidateExtension,
            ctx.herdrStateExtension,
          )
            .map(({ pid }) => pid)
            .filter((pid) => pid != null);
          firstSession = { ...session, paneId: agent.pane_id };
          for (const pid of pids) firstPids.add(pid);
          break;
        }
      }
      const done = !!firstSession && pids.length > 0;
      // Keep the simulated child alive until its required live evidence is captured.
      if (done && ctx.simulated)
        await writeFile(
          join(
            ctx.paths.piAgent,
            "pi-herdsman",
            "runtime",
            "continuation-first-observed",
          ),
          "observed\n",
          { flag: "wx", mode: 0o600 },
        );
      return {
        done,
        value: firstSession,
        progress: {
          childCount: agents.length,
          sessionId: session?.id ?? null,
          sessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          candidatePids: pids.sort(),
        },
        evidence: {
          sessionError,
          agents: agents.map(({ pane_id, agent_status }) => ({
            pane_id,
            agent_status,
          })),
        },
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS, pollMs: 200 },
  );
  if (!firstPids.size)
    throw new Error(
      "continuation-first-generation: no candidate process identity was observed",
    );

  await waitForEvidence(
    ctx,
    "continuation-first-result",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const result =
        session && assistantResultForSession(session, firstPrompt, firstMarker);
      return {
        done: !!result,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          resultFound: !!result,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  firstSession.contents = await readFile(firstSession.path, "utf8");
  if (
    !sessionEntries(firstSession.contents).some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        messageText(entry.message.content).includes("CONTINUATION_FIRST_DONE"),
    )
  )
    throw new Error(
      "continuation-first-result: persisted managed session did not contain its first result",
    );

  await waitForEvidence(
    ctx,
    "continuation-first-cleanup",
    async () => {
      const listed = await tryNestedCommand(ctx, ["pane", "list"]);
      if (!listed.ok) return { done: false, observationError: listed.error };
      const paneStillExists = listedPanes(listed.value).some(
        ({ paneId }) => paneId === firstSession.paneId,
      );
      return {
        done: !paneStillExists,
        progress: { paneStillExists },
        evidence: { paneId: firstSession.paneId },
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS, pollMs: 300 },
  );
  const panesAfterFirst = listedPanes(
    await nestedCommand(ctx, ["pane", "list"]),
  );
  if (panesAfterFirst.some((pane) => pane.paneId === firstSession.paneId))
    throw new Error(
      "continuation-first-cleanup: first managed pane did not disappear",
    );
  const savedAfterCleanup = await isolatedSessionDetails(ctx, {
    agent_session: { kind: "path", value: firstSession.path },
  });
  if (savedAfterCleanup.id !== firstSession.id)
    throw new Error(
      "continuation-session-identity: first cleanup changed the persisted Pi session ID",
    );

  const followup = `Continue the exact saved Pi session at ${firstSession.path}. This is the same implementer you delegated previously. Without rereading package.json, return the package name you were asked to remember, followed by exactly ${secondMarker}. The final answer to me must include that marker.`;
  await promptRoot(followup);
  firstGeneration = await waitForEvidence(
    ctx,
    "continuation-second-generation",
    async () => {
      const agents = await childAgents();
      let matchingSessionSeen = false;
      let matchingPane;
      for (const agent of agents) {
        const session = await isolatedSessionDetails(ctx, agent).catch(
          (error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (
          session?.path !== firstSession.path ||
          session.id !== firstSession.id
        )
          continue;
        matchingSessionSeen = true;
        matchingPane = agent.pane_id;
        const observed = await tryNestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          agent.pane_id,
        ]);
        if (!observed.ok)
          return { done: false, observationError: observed.error };
        const matches = candidateProcess(
          observed.value,
          ctx.candidateExtension,
          ctx.herdrStateExtension,
        );
        for (const proc of matches) {
          if (
            proc.pid != null &&
            !firstPids.has(proc.pid) &&
            agent.pane_id !== firstSession.paneId
          ) {
            firstGeneration = proc.pid;
            ctx.continuationSecondPaneId = agent.pane_id;
          }
        }
      }
      return {
        done: firstGeneration !== undefined,
        value: firstGeneration,
        progress: {
          matchingSessionSeen,
          matchingPane: matchingPane ?? null,
          newPid: firstGeneration ?? null,
        },
        evidence: { childCount: agents.length },
      };
    },
    {
      timeoutMs: Math.max(1, deadline - Date.now()),
      stallMs: CONTROL_STALL_MS,
      pollMs: 200,
    },
  );

  await waitForEvidence(
    ctx,
    "continuation-follow-up",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const matchingResults =
        session &&
        continuationResultsForPrompt(session.contents, followup, secondMarker);
      const result = matchingResults?.[0];
      if (result) {
        if (!messageText(result.message.content).includes(expectedName))
          throw new Error(
            "continuation-follow-up: final result did not return the remembered package name",
          );
        if (matchingResults.length !== 1 || matchingResults[0].id !== result.id)
          throw new Error(
            `continuation-follow-up: expected exactly one final result, observed ${matchingResults.length}`,
          );
        const contents = await readFile(firstSession.path, "utf8");
        const childEntries = sessionEntries(contents);
        const childCwd = childEntries.find(
          (entry) => entry.type === "session",
        )?.cwd;
        if (ctx.simulated) {
          const reads = childEntries.flatMap((entry) =>
            entry.type === "message" && entry.message?.role === "assistant"
              ? (entry.message.content ?? []).filter(
                  (part) =>
                    part.type === "toolCall" &&
                    part.name === "read" &&
                    isPackageReadPath(part.arguments?.path, childCwd),
                )
              : [],
          );
          const readResult = childEntries.find(
            (entry) =>
              entry.type === "message" &&
              entry.message?.role === "toolResult" &&
              entry.message.toolName === "read" &&
              entry.message.toolCallId === reads[0]?.id &&
              !entry.message.isError,
          );
          assertContinuationReadEvidence(
            ctx.simulated,
            reads,
            readResult,
            expectedName,
          );
        }
        const evidence = continuationSessionEvidence(
          contents,
          firstSession.id,
          correlatedContinuationTask(
            session.contents,
            result.id,
            firstSession.id,
            followup,
          ),
        );
        ctx.continuationSessionEvidence = evidence;
        if (
          !evidence.sessionIdMatches ||
          !evidence.continuationTaskFound ||
          !evidence.taskInstructionFound
        )
          throw new Error(
            `continuation-session-identity: persisted ID or remembered-context follow-up was not preserved; evidence: ${JSON.stringify(evidence)}`,
          );
        await waitForDescendantsToExit(ctx);
        const finalSession = await rootSessionSnapshot(ctx);
        const finalResults = finalSession
          ? continuationResultsForPrompt(
              finalSession.contents,
              followup,
              secondMarker,
            )
          : [];
        if (finalResults.length !== 1)
          throw new Error(
            `continuation-follow-up: expected one final owner result after cleanup, observed ${finalResults.length}`,
          );
        ctx.continuationSessionId = firstSession.id;
        ctx.continuationSessionPath = firstSession.path;
        ctx.continuationFirstPaneId = firstSession.paneId;
        ctx.continuationGenerationPid = firstGeneration;
        return {
          done: true,
          value: true,
          progress: {
            rootSessionBytes: Buffer.byteLength(session.contents),
            resultFound: true,
          },
        };
      }
      return {
        done: false,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          resultFound: false,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), stallMs: MODEL_STALL_MS },
  );
}

async function runManagerRecoverySmoke(ctx) {
  const deadline = Date.now() + 6 * 60_000;
  const branch = `herdsman/smoke-manager-recovery-${randomUUID()}`;
  const contextMarker = `MANAGER_RECOVERY_CONTEXT_${randomUUID()}`;
  ctx.managerRecovery = {
    branch,
    contextMarker,
    leadReadyTimeoutMs: ctx.managerReadyTimeoutMs,
    retirementSource: ctx.managerExternalRemoval ? "git" : "herdr",
  };
  ctx.owned.managerBranch = branch;
  let waitRootSessionBytes = 0;
  const rootSnapshot = async () => {
    const snapshot = await rootSessionSnapshot(ctx);
    waitRootSessionBytes = snapshot ? Buffer.byteLength(snapshot.contents) : 0;
    return snapshot;
  };
  const promptRoot = (prompt) =>
    nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  const promptAgent = (paneId, prompt) =>
    nestedCommand(ctx, ["agent", "prompt", paneId, prompt]);
  const agents = async () => {
    const result = await tryNestedCommand(ctx, ["agent", "list"]);
    if (!result.ok) throw observationFailure(result.error);
    return result.value.agents ?? [];
  };
  const worktrees = async () => {
    const observed = await tryNestedCommand(ctx, [
      "worktree",
      "list",
      "--workspace",
      ctx.rootWorkspaceId,
    ]);
    if (!observed.ok) throw observationFailure(observed.error);
    const result = observed.value;
    return result.worktrees ?? [];
  };
  const primaryPath = ctx.primaryCheckoutPath;
  const rootWorkspace = (
    await nestedCommand(ctx, ["workspace", "get", ctx.rootWorkspaceId])
  ).workspace;
  const rootTopology = await nestedCommand(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  const repoKey = assertManagerFreshPrimary(
    ctx.rootWorkspaceId,
    primaryPath,
    rootWorkspace,
    rootTopology,
  );
  const matchingWorktrees = async () =>
    (await worktrees()).filter((item) => item.branch === branch);
  const paneInfo = async (paneId) => {
    const result = await tryNestedCommand(ctx, [
      "pane",
      "process-info",
      "--pane",
      paneId,
    ]);
    if (!result.ok) throw observationFailure(result.error);
    return result.value;
  };
  const paneExists = async (paneId) =>
    listedPanes(await nestedCommand(ctx, ["pane", "list"])).some(
      (pane) => pane.paneId === paneId,
    );
  const candidatePids = async (paneId) => {
    const info = await paneInfo(paneId);
    return candidateProcess(
      info,
      ctx.candidateExtension,
      ctx.herdrStateExtension,
    )
      .map((proc) => proc.pid)
      .filter((pid) => pid != null);
  };
  const waitFor = async (label, inspect, timeout = 6 * 60_000) => {
    try {
      return await waitForEvidence(
        ctx,
        `manager-recovery-${label}`,
        async () => {
          const value = await inspect();
          const ready = ctx.managerRecovery.readyEvidence ?? {};
          const progress =
            label === "ready"
              ? {
                  delegationCount: ready.delegationCount ?? 0,
                  childFound: !!ready.childFound,
                  childSessionVerified: !!ready.childSessionVerified,
                  leadCompleted: !!ready.leadCompleted,
                  receipt: !!ready.receipt,
                  managerAnswerAfterReceipt: !!ready.managerAnswerAfterReceipt,
                }
              : [
                    "lead-context-acknowledgment",
                    "direct-handoff-settled",
                    "graceful-close",
                    "review-message",
                    "graceful-resume",
                    "recovery",
                    "project-message-retained",
                    "project-complete",
                  ].includes(label)
                ? { rootSessionBytes: waitRootSessionBytes, observed: !!value }
                : { observed: !!value };
          return {
            done: !!value,
            value,
            progress,
            evidence: ctx.managerRecovery.readyEvidence,
          };
        },
        {
          timeoutMs: timeout,
          stallMs: [
            "ready",
            "lead-context-acknowledgment",
            "direct-handoff-settled",
            "graceful-close",
            "review-message",
            "graceful-resume",
            "recovery",
            "project-message-retained",
            "project-complete",
          ].includes(label)
            ? MODEL_STALL_MS
            : CONTROL_STALL_MS,
        },
      );
    } catch (error) {
      if (error.code !== "SMOKE_STALLED" && error.code !== "SMOKE_TIMEOUT")
        throw error;
      if (label === "ready") {
        ctx.managerRecovery.readyEvidence ??= {};
        try {
          const session = await rootSnapshot();
          const results = session ? staffDelegateResults(session.contents) : [];
          const evidence = ctx.managerRecovery.readyEvidence;
          evidence.entries = session
            ? managerReadyEntryEvidence(
                session.contents,
                branch,
                results[0]?.session,
              )
            : [];
          if (
            results.length === 1 &&
            typeof results[0].session === "string" &&
            typeof results[0].workspace_id === "string"
          ) {
            let listedAgents = [];
            try {
              listedAgents = await agents();
              evidence.childSession = await managerChildSessionEvidence(
                ctx,
                listedAgents,
                results[0].workspace_id,
                results[0].session,
              );
              if (ctx.managerRecoveryDiagnostics) {
                const lead = listedAgents.find(
                  (agent) =>
                    agent.workspace_id === results[0].workspace_id &&
                    typeof agent.pane_id === "string" &&
                    agent.pane_id !== ctx.rootPaneId,
                );
                if (lead) {
                  try {
                    evidence.leadDiagnostics = managerDiagnosticLines(
                      await nestedPaneText(
                        ctx,
                        lead.pane_id,
                        "recent-unwrapped",
                      ),
                    );
                  } catch {
                    evidence.leadDiagnostics = [];
                  }
                } else evidence.leadDiagnostics = [];
              }
            } catch (error) {
              evidence.childSession = {
                error: String(error.message).slice(0, 200),
              };
            }
          }
        } catch (error) {
          ctx.managerRecovery.readyEvidence.entriesError = String(error).slice(
            0,
            200,
          );
        }
      }
      if (label === "ready")
        error.smoke.lastEvidence =
          ctx.managerRecovery.readyEvidence ?? error.smoke.lastEvidence;
      throw error;
    }
  };

  markStage(ctx, "fresh-session-identity");
  const freshRoot = await waitFor(
    "fresh-session",
    async () =>
      (await agents()).find(
        (agent) =>
          agent.pane_id === ctx.rootPaneId &&
          (agent.agent_session?.kind === "id" ||
            agent.agent_session?.kind === "path") &&
          typeof agent.agent_session.value === "string" &&
          agent.agent_session.value.length > 0,
      ),
    30_000,
  );
  const persistedFreshRoot = () =>
    freshRoot.agent_session.kind === "id"
      ? exactIsolatedSession(ctx, freshRoot.agent_session.value)
      : isolatedSessionDetails(ctx, freshRoot);
  assert.equal(
    await persistedFreshRoot(),
    undefined,
    "Manager bootstrap must precede Pi transcript persistence",
  );
  markStage(ctx, "manager-mode-command");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  markStage(ctx, "manager-mode-active-wait");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode active.",
    "--timeout",
    "15000",
  ]);
  assert.equal(
    await persistedFreshRoot(),
    undefined,
    "/manager must not manufacture a conversation",
  );

  const prompt = managerRecoveryFreshPrompt(branch);
  markStage(ctx, "fresh-delegation");
  await promptRoot(prompt);
  markStage(ctx, "lead-ready-handshake");
  const ready = await waitFor(
    "ready",
    async () => {
      const session = await rootSnapshot();
      if (session) assertNoFailedProjectDelegation(session.contents, branch);
      const results = session ? staffDelegateResults(session.contents) : [];
      let child;
      if (
        results.length === 1 &&
        typeof results[0].session === "string" &&
        results[0].session.length > 0
      )
        for (const agent of await agents())
          if (
            agent.workspace_id === results[0].workspace_id &&
            (await agentSessionId(ctx, agent)) === results[0].session
          ) {
            child = agent;
            break;
          }
      const childSession =
        child &&
        (child.agent_session?.kind === "id"
          ? await exactIsolatedSession(ctx, results[0].session)
          : await isolatedSessionDetails(ctx, child));
      const childVerified = verifiedLeadSession(
        childSession,
        results[0]?.session,
      );
      const leadCompleted =
        childVerified &&
        leadReadyCompleted(childSession.contents, "MANAGER_RECOVERY_READY");
      const {
        receipt,
        answer,
        answerAfterReceipt,
        prematureReady,
        prematureFinish,
      } =
        session && results.length === 1
          ? managerReadyAnswer(session.contents, branch, results[0].session)
          : {
              receipt: false,
              answer: null,
              answerAfterReceipt: null,
              prematureReady: false,
              prematureFinish: false,
            };
      ctx.managerRecovery.readyEvidence = {
        delegationCount: results.length,
        childFound: !!child,
        childIdentity: child?.agent_session?.kind ?? null,
        childSessionVerified: !!childVerified,
        leadReadyResult: !!(
          childVerified &&
          hasSuccessfulSupervisorMessage(
            childSession.contents,
            "MANAGER_RECOVERY_READY",
          )
        ),
        leadCompleted: !!leadCompleted,
        receipt,
        managerAnswer: !!answer,
        managerAnswerAfterReceipt: !!answerAfterReceipt,
        prematureReady,
        prematureFinish,
        rootRecent: session
          ? summarizeSession(session.contents).recentMessages.slice(-6)
          : [],
        leadRecent: childSession
          ? summarizeSession(childSession.contents).recentMessages.slice(-6)
          : [],
        rootCustom: session
          ? sessionEntries(session.contents)
              .filter(
                (entry) =>
                  entry.type === "custom_message" &&
                  entry.customType === "pi-herdsman-project_message" &&
                  entry.details?.branch === branch &&
                  entry.details?.fromSessionId === results[0]?.session,
              )
              .slice(-3)
              .map((entry) => ({
                type: entry.customType,
                content: String(entry.content).slice(0, 200),
              }))
          : [],
      };
      return results.length === 1 &&
        leadCompleted &&
        receipt &&
        answerAfterReceipt &&
        !prematureReady &&
        !prematureFinish
        ? { results, answer, child }
        : null;
    },
    ctx.managerReadyTimeoutMs ?? DEFAULT_MANAGER_READY_TIMEOUT_MS,
  );
  const first = ready.results[0];
  await captureManagerLeadDiagnostics(ctx, ready.child.pane_id);
  markStage(ctx, "initial-assignment-validation");
  assert.equal(first.ok, true);
  assert.equal(first.action, "delegate");
  assert.match(first.session, /^[0-9a-f-]{36}$/i);
  assert.equal(first.branch, branch);
  assert.ok(first.workspace_id);
  const initialWorktrees = await matchingWorktrees();
  assert.equal(initialWorktrees.length, 1, "expected one matching worktree");
  const worktree = initialWorktrees[0];
  const worktreePath = worktree.path ?? worktree.worktree_path;
  const workspaceId = first.workspace_id;
  assert.ok(worktreePath, "worktree path was not reported");
  ctx.managerRecovery = {
    ...ctx.managerRecovery,
    sessionId: first.session,
    workspaceId,
    worktreePath,
  };
  markStage(ctx, "initial-topology-validation");
  ctx.owned.managerWorkspaceId = workspaceId;
  ctx.owned.managerWorktreePath = worktreePath;

  const initialAgent = (await agents()).find(
    (agent) => agent.workspace_id === workspaceId,
  );
  assert.ok(initialAgent, "delegated Lead was not listed in its workspace");
  const paneId = initialAgent.pane_id;
  assert.ok(paneId);
  assert.equal(await agentSessionId(ctx, initialAgent), first.session);
  assert.equal(initialAgent.workspace_id, workspaceId);
  const panes = listedPanes(await nestedCommand(ctx, ["pane", "list"]));
  assert.ok(panes.some((pane) => pane.paneId === paneId));
  const placement = await paneInfo(paneId);
  const initialProcesses = candidateProcess(
    placement,
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  assert.equal(
    initialProcesses.length,
    1,
    "expected one child candidate process",
  );
  const initialPid = initialProcesses[0].pid;
  assert.ok(initialPid);
  const pane = (await nestedCommand(ctx, ["pane", "list"])).panes.find(
    (item) => item.pane_id === paneId,
  );
  assert.ok(pane, "child pane placement was not listed");
  assert.equal(pane.workspace_id, workspaceId);
  assert.equal(resolve(pane.cwd), resolve(worktreePath));
  ctx.managerRecovery = {
    ...ctx.managerRecovery,
    paneId,
    tabId: pane.tab_id,
    firstPid: initialPid,
  };

  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const runtime = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "supervision-v2",
    hash(nestedHerdrApiSocketPath(ctx.paths, ctx.sessionName)),
  );
  const assignmentPath = join(
    runtime,
    "assignments",
    hash(repoKey),
    `${hash(branch)}.json`,
  );
  const primaryBranch = rootTopology.worktrees.find(
    (item) => item.open_workspace_id === ctx.rootWorkspaceId,
  )?.branch;
  assert.equal(typeof primaryBranch, "string");
  const unrelatedAssignment = {
    version: 2,
    id: randomUUID(),
    repoKey,
    branch: primaryBranch,
    text: "unrelated primary-worktree assignment",
  };
  const unrelatedAssignmentPath = join(
    runtime,
    "assignments",
    hash(repoKey),
    `${hash(primaryBranch)}.json`,
  );
  await mkdir(dirname(unrelatedAssignmentPath), { recursive: true });
  await writeFile(
    unrelatedAssignmentPath,
    `${JSON.stringify(unrelatedAssignment)}\n`,
    { flag: "wx" },
  );
  const managerPath = join(
    runtime,
    "managers",
    `${hash(ctx.rootWorkspaceId)}.json`,
  );
  const assignmentBytes = async () => {
    const details = await lstat(assignmentPath);
    assert.ok(details.isFile() && !details.isSymbolicLink());
    assert.ok(details.size <= 16 * 1024);
    return readFile(assignmentPath, "utf8");
  };
  const managerLease = async () =>
    JSON.parse(await readFile(managerPath, "utf8")).leaseId;
  markStage(ctx, "initial-assignment-validation");
  const initialAssignmentBytes = await assignmentBytes();
  const record = JSON.parse(initialAssignmentBytes);
  assert.equal(record.id, first.session);
  assert.equal(record.branch, branch);
  assert.equal(record.repoKey, repoKey);
  assert.doesNotMatch(record.text, new RegExp(contextMarker));
  assert.equal(typeof record.piSessionFile, "string");
  assert.ok(record.piSessionFile.length > 0);
  const requiredAssignmentKeys = [
    "branch",
    "id",
    "piSessionFile",
    "repoKey",
    "text",
    "version",
  ];
  const allowedAssignmentKeys = [
    ...requiredAssignmentKeys,
    "requiredEvidence",
    "resultBindings",
  ];
  assert.ok(requiredAssignmentKeys.every((key) => Object.hasOwn(record, key)));
  assert.ok(
    Object.keys(record).every((key) => allowedAssignmentKeys.includes(key)),
  );
  const assertUnchangedAssignment = async () =>
    assert.equal(
      await assignmentBytes(),
      initialAssignmentBytes,
      "runtime recovery must not mutate durable project intent",
    );
  const leadContextPrompt = managerRecoveryLeadContextPrompt(contextMarker);
  markStage(ctx, "lead-context-seed");
  await promptAgent(paneId, leadContextPrompt);
  await waitFor("lead-context-acknowledgment", async () => {
    const session = await exactIsolatedSession(ctx, first.session);
    return session &&
      verifiedLeadSession(session, first.session) &&
      assistantResultForSession(session, leadContextPrompt, contextMarker)
      ? session
      : null;
  });
  await waitFor("direct-handoff-settled", async () => {
    const session = await rootSnapshot();
    return session &&
      managerProjectMessageSettled(
        session.contents,
        branch,
        first.session,
        contextMarker,
      )
      ? session
      : null;
  });
  const reviewPrompt = managerRecoveryReviewPrompt(branch);
  await promptRoot(reviewPrompt);
  await waitFor("review-message", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    return sessionEntries(session.contents).some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "message_staff" &&
        !entry.message.isError,
    )
      ? session
      : null;
  });
  await waitFor("review-response-completed", async () => {
    const session = await rootSnapshot();
    return session &&
      assistantResponseCompletedForSession(session, reviewPrompt)
      ? session
      : null;
  });
  const closePrompt = managerRecoveryStopPrompt(first.session);
  markStage(ctx, "graceful-close");
  await promptRoot(closePrompt);
  await waitFor(
    "graceful-close",
    async () => {
      const session = await rootSnapshot();
      if (!session) return null;
      const closes = staffActionResults(session.contents, "stop_lead", "stop");
      if (closes.length !== 1) return null;
      const close = closes[0];
      if (
        close.branch !== branch ||
        !assistantResultForSession(
          session,
          closePrompt,
          "PI_HERDSMAN_MANAGER_RECOVERY_PAUSED",
        )
      )
        return null;
      const pids = await candidatePids(paneId).catch(() => []);
      if (pids.length !== 0) return null;
      for (const agent of await agents())
        if ((await agentSessionId(ctx, agent)) === first.session) return null;
      return close;
    },
    30_000,
  );
  markStage(ctx, "graceful-close-validation");
  await assertUnchangedAssignment();
  assert.ok(
    await paneExists(paneId),
    "stop_lead removed the preserved assignment pane",
  );
  const pausedWorktrees = await matchingWorktrees();
  assert.equal(pausedWorktrees.length, 1);
  assert.equal(
    pausedWorktrees[0].path ?? pausedWorktrees[0].worktree_path,
    worktreePath,
  );

  const resumePrompt = managerRecoveryResumeOnlyPrompt(branch);
  ctx.managerRecovery.resumePrompt = resumePrompt;
  markStage(ctx, "graceful-resume");
  await promptRoot(resumePrompt);
  const resumed = await waitFor("graceful-resume", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    const results = staffActionResults(
      session.contents,
      "resume_project",
      "resume",
      resumePrompt,
    );
    if (
      results.length !== 1 ||
      !assistantResultForSession(
        session,
        resumePrompt,
        "PI_HERDSMAN_MANAGER_RECOVERY_RESUMED",
      )
    )
      return null;
    return results[0];
  });
  markStage(ctx, "graceful-resume-validation");
  assert.equal(resumed.session, first.session);
  assert.equal(resumed.branch, first.branch);
  assert.equal(resumed.workspace_id, workspaceId);
  await assertUnchangedAssignment();
  const resumedWorktrees = await matchingWorktrees();
  assert.equal(resumedWorktrees.length, 1);
  assert.equal(
    resumedWorktrees[0].path ?? resumedWorktrees[0].worktree_path,
    worktreePath,
  );
  const resumedPane = (await nestedCommand(ctx, ["pane", "list"])).panes.find(
    (item) => item.pane_id === paneId,
  );
  assert.ok(resumedPane);
  assert.equal(resumedPane.workspace_id, workspaceId);
  assert.equal(resumedPane.tab_id, ctx.managerRecovery.tabId);
  assert.equal(resolve(resumedPane.cwd), resolve(worktreePath));
  const resumedAgents = [];
  for (const agent of await agents())
    if ((await agentSessionId(ctx, agent)) === first.session)
      resumedAgents.push(agent);
  assert.equal(
    resumedAgents.length,
    1,
    "resume must produce exactly one live Lead for the assignment session",
  );
  const resumedAgent = resumedAgents[0];
  assert.equal(resumedAgent.pane_id, paneId);
  assert.equal(resumedAgent.workspace_id, workspaceId);
  const resumedProcesses = await waitFor(
    "graceful-resume-process",
    async () => {
      const processes = candidateProcess(
        await paneInfo(paneId),
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      return processes.length === 1 && processes[0].pid !== initialPid
        ? processes
        : null;
    },
    30_000,
  );
  const resumedPid = resumedProcesses[0].pid;
  ctx.managerRecovery.resumedPid = resumedPid;
  const previousLease = await managerLease();
  markStage(ctx, "manager-turnover-leave");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager leave");
  await waitFor(
    "manager-left",
    async () => {
      try {
        await lstat(managerPath);
        return false;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
    15_000,
  );
  markStage(ctx, "manager-away-before-project-message");
  await promptAgent(paneId, managerRecoveryPostRecoveryPrompt());
  const retainedMessagesDirectory = join(
    dirname(assignmentPath),
    `${hash(branch)}.messages`,
  );
  const retainedRecord = await waitFor("project-message-retained", async () => {
    try {
      const names = await readdir(retainedMessagesDirectory);
      const records = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          records.push(
            JSON.parse(
              await readFile(join(retainedMessagesDirectory, name), "utf8"),
            ),
          );
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
        }
      }
      return retainedProjectMessageRecord(
        records,
        branch,
        first.session,
        contextMarker,
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  assert.equal(retainedRecord.text, contextMarker);
  assert.equal((await candidatePids(paneId)).includes(resumedPid), true);
  let retainedLead = false;
  for (const agent of await agents())
    if (
      agent.pane_id === paneId &&
      agent.workspace_id === workspaceId &&
      (await agentSessionId(ctx, agent)) === first.session
    )
      retainedLead = true;
  assert.ok(retainedLead, "exact Lead must survive Manager departure");
  markStage(ctx, "manager-turnover-reenter");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  await waitFor(
    "manager-reentered",
    async () => {
      try {
        const lease = await managerLease();
        return lease !== previousLease ? lease : null;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    15_000,
  );
  markStage(ctx, "project-message-delivery");
  const delivered = await waitFor("project-message-delivery", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    return projectMessageEntries(session.contents, branch, first.session).some(
      (entry) => entry.details?.id === retainedRecord.id,
    )
      ? session
      : null;
  });
  const deliveredRecord = projectMessageEntries(
    delivered.contents,
    branch,
    first.session,
  ).find((entry) => entry.details?.id === retainedRecord.id);
  assert.equal(
    deliveredRecord.content,
    `Project ${branch} from lead ${first.session}:\n\n${contextMarker}`,
  );
  await assertUnchangedAssignment();
  assert.equal((await candidatePids(paneId)).includes(resumedPid), true);

  const beforeKillAgents = [];
  for (const agent of await agents())
    if ((await agentSessionId(ctx, agent)) === first.session)
      beforeKillAgents.push(agent);
  assert.equal(
    beforeKillAgents.length,
    1,
    "expected one exact Lead before kill",
  );
  const beforeKillAgent = beforeKillAgents[0];
  assert.equal(beforeKillAgent.pane_id, paneId);
  assert.equal(beforeKillAgent.workspace_id, workspaceId);
  const beforeKillInfo = await paneInfo(paneId);
  const proven = candidateProcess(
    beforeKillInfo,
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  assert.equal(proven.length, 1);
  assert.equal(proven[0].pid, resumedPid);
  assert.ok(
    leadReadyCompleted(
      (beforeKillAgent.agent_session?.kind === "id"
        ? await exactIsolatedSession(ctx, first.session)
        : await isolatedSessionDetails(ctx, beforeKillAgent)
      )?.contents ?? "",
      "MANAGER_RECOVERY_READY",
    ),
    "Lead READY turn was not completed immediately before kill",
  );
  process.kill(resumedPid, "SIGKILL");
  markStage(ctx, "executor-loss-verification");
  await waitFor(
    "executor-loss",
    async () => {
      const currentPids = await candidatePids(paneId).catch(() => []);
      let stillLive = false;
      for (const agent of await agents())
        if (
          agent.pane_id === paneId &&
          (await agentSessionId(ctx, agent)) === first.session &&
          ["working", "idle"].includes(agent.agent_status)
        ) {
          stillLive = true;
          break;
        }
      return !currentPids.includes(resumedPid) && !stillLive;
    },
    30_000,
  );
  assert.ok(
    await paneExists(paneId),
    "child pane did not survive executor loss",
  );
  const retainedWorktrees = await matchingWorktrees();
  assert.equal(retainedWorktrees.length, 1);
  assert.equal(
    retainedWorktrees[0].path ?? retainedWorktrees[0].worktree_path,
    worktreePath,
  );

  const beforeRetirement = await waitFor(
    "manager-idle-before-retirement",
    async () => {
      const manager = (await agents()).find(
        (agent) => agent.pane_id === ctx.rootPaneId,
      );
      return manager?.agent_status === "idle" ? rootSnapshot() : null;
    },
    15_000,
  );
  const preservedLeadHistory = await exactIsolatedSession(ctx, first.session);
  assert.ok(
    preservedLeadHistory,
    "retirement requires verified saved Lead history",
  );
  assert.deepEqual(
    retirementNoticeEntries(
      beforeRetirement.contents,
      repoKey,
      branch,
      first.session,
    ),
    [],
  );
  markStage(ctx, "missing-worktree");
  await assertUnchangedAssignment();
  await removeManagerRecoveryWorktree(ctx, await worktrees());
  assert.equal((await matchingWorktrees()).length, 0);
  markStage(ctx, "assignment-absence-reconciliation");
  ctx.owned.managerWorktreeRetirementRequested = true;
  await waitFor(
    "assignment-removed",
    async () => {
      try {
        await lstat(assignmentPath);
        return false;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
    15_000,
  );
  await assert.rejects(lstat(assignmentPath), { code: "ENOENT" });
  await waitFor(
    "retired-project-messages-removed",
    async () => {
      try {
        for (const name of await readdir(retainedMessagesDirectory)) {
          if (!name.endsWith(".json")) continue;
          let record;
          try {
            record = JSON.parse(
              await readFile(join(retainedMessagesDirectory, name), "utf8"),
            );
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          if (record.fromSessionId === first.session) return false;
        }
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
    15_000,
  );
  assert.deepEqual(
    JSON.parse(await readFile(unrelatedAssignmentPath, "utf8")),
    unrelatedAssignment,
  );
  assert.equal((await matchingWorktrees()).length, 0);
  await run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: ctx.primaryCheckoutPath },
  );
  const pendingRetirementPath = join(
    runtime,
    "retirements",
    hash(repoKey),
    `${hash(branch)}.${first.session}.json`,
  );
  await waitFor(
    "passive-retirement-notice",
    async () => {
      const session = await rootSnapshot();
      if (
        !session ||
        retirementNoticeEntries(
          session.contents,
          repoKey,
          branch,
          first.session,
        ).length === 0
      )
        return null;
      assertPassiveRetirementEvidence(
        beforeRetirement.contents,
        session.contents,
        repoKey,
        branch,
        first.session,
      );
      try {
        await lstat(pendingRetirementPath);
        return null;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return session;
    },
    15_000,
  );
  // Observe several existing inbox ticks before allowing another user/model turn.
  const passiveObservationUntil = Date.now() + 1_500;
  await waitFor(
    "passive-retirement-idle",
    async () => {
      const session = await rootSnapshot();
      assert.ok(session);
      assertPassiveRetirementEvidence(
        beforeRetirement.contents,
        session.contents,
        repoKey,
        branch,
        first.session,
      );
      const manager = (await agents()).find(
        (agent) => agent.pane_id === ctx.rootPaneId,
      );
      assert.equal(
        manager?.agent_status,
        "idle",
        "retirement must not wake the Manager",
      );
      return Date.now() >= passiveObservationUntil;
    },
    15_000,
  );
  assert.equal(
    (await exactIsolatedSession(ctx, first.session))?.contents,
    preservedLeadHistory.contents,
    "retirement must preserve exact Lead history",
  );
  ctx.managerRecovery.passiveRetirementNotice = true;
  ctx.managerRecovery.retired = branch;
  const retiredResumePrompt = managerRecoveryRetiredResumePrompt(branch);
  markStage(ctx, "retired-assignment-resume-rejected");
  await promptRoot(retiredResumePrompt);
  const rejectedResume = await waitFor(
    "retired-assignment-resume-rejected",
    async () => {
      const session = await rootSnapshot();
      const attempts = session
        ? managerRecoveryResumeDiagnostics(
            session.contents,
            retiredResumePrompt,
          )
        : [];
      return attempts.length === 1 && attempts[0].result?.isError
        ? attempts[0]
        : null;
    },
  );
  assert.equal(rejectedResume.branch, branch);
  await waitFor("retired-resume-response-completed", async () => {
    const session = await rootSnapshot();
    return session &&
      assistantResponseCompletedForSession(session, retiredResumePrompt)
      ? session
      : null;
  });
  const afterRepeatedReconciliation = await rootSnapshot();
  assert.equal(
    retirementNoticeEntries(
      afterRepeatedReconciliation.contents,
      repoKey,
      branch,
      first.session,
    ).length,
    1,
    "preflight and repeated inbox observation must not duplicate retirement context",
  );
  await assert.rejects(lstat(pendingRetirementPath), { code: "ENOENT" });
  ctx.managerRecovery.retirementNoticeDeduplicated = true;
  assert.equal((await matchingWorktrees()).length, 0);
  await assert.rejects(lstat(assignmentPath), { code: "ENOENT" });
  markStage(ctx, "manager-leave-command-submission");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager leave");
  markStage(ctx, "manager-leave-output-wait");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode left.",
    "--timeout",
    "15000",
  ]);
  markStage(ctx, "post-leave-validation");
}

async function runChiefTreeSmoke(ctx) {
  const deadline = Date.now() + 90_000;
  const startupTurn = (session) => {
    const entries = sessionEntries(session.contents);
    const prompt = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry.message.content) === ctx.initialPrompt,
    );
    const response =
      prompt &&
      assistantResultForSession(
        session,
        ctx.initialPrompt,
        "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      );
    return prompt && response ? { prompt, response } : null;
  };

  // Establish the exact pre-Chief assistant branch before changing roles.
  const startup = await waitForEvidence(
    ctx,
    "chief-tree-startup",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const turn = session && startupTurn(session);
      return {
        done: !!turn,
        value: turn,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          startupFound: !!turn,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: 90_000, stallMs: MODEL_STALL_MS },
  );

  const readSnapshotContents = async () => {
    const details = await lstat(ctx.chiefTreeResultFile);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > MAX_CHIEF_TREE_RESULT_BYTES
    )
      throw new Error(
        "chief-tree-probe: result path is not a bounded regular file",
      );
    return readFile(ctx.chiefTreeResultFile, "utf8");
  };
  const readSnapshots = async () =>
    parseToolSnapshots(await readSnapshotContents());
  const awaitSnapshot = async (label) =>
    waitForEvidence(
      ctx,
      `chief-tree-${label}-snapshot`,
      async () => {
        let snapshots;
        try {
          snapshots = await readSnapshots();
        } catch (error) {
          if (error.code === "ENOENT")
            return { done: false, observationError: error.message };
          throw error;
        }
        return {
          done: snapshots.has(label),
          value: snapshots,
          progress: { labels: [...snapshots.keys()].sort() },
          evidence: { labels: [...snapshots.keys()].sort() },
        };
      },
      { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
    );
  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools lead");
  await awaitSnapshot("lead");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/chief");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Chief mode active.",
    "--timeout",
    "15000",
  ]);

  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools chief");
  await awaitSnapshot("chief");
  const chiefPrompt = "Reply exactly with PI_HERDSMAN_CHIEF_TREE_POST_CHIEF.";
  await submitPaneCommand(ctx, ctx.rootPaneId, chiefPrompt);
  const branchPlan = await waitForEvidence(
    ctx,
    "chief-tree-branch",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      if (session) {
        const plan = chiefTreeBranchPlan(
          session.contents,
          ctx.initialPrompt,
          "PI_HERDSMAN_CHIEF_TREE_STARTUP",
          chiefPrompt,
          "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
        );
        if (!plan.error)
          return {
            done: true,
            value: plan,
            progress: {
              rootSessionBytes: Buffer.byteLength(session.contents),
              branchFound: true,
            },
          };
        return {
          done: false,
          progress: {
            rootSessionBytes: Buffer.byteLength(session.contents),
            branchFound: false,
          },
          evidence: plan.error,
        };
      }
      return {
        done: false,
        progress: { rootSessionBytes: 0, branchFound: false },
      };
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), stallMs: MODEL_STALL_MS },
  );
  ctx.chiefTreeBranchPlan = branchPlan;

  await submitPaneCommand(ctx, ctx.rootPaneId, "/tree");
  const initialTree = await waitForEvidence(
    ctx,
    "chief-tree-selection",
    async () => {
      let treeText;
      try {
        treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
      } catch (error) {
        return {
          done: false,
          observationError: error?.message ?? String(error),
        };
      }
      const footer = chiefTreeFooter(treeText);
      const selected =
        !!footer &&
        chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF");
      return {
        done: selected,
        value: { footer, treeText },
        progress: {
          selected: footer?.selected ?? null,
          total: footer?.total ?? null,
        },
        evidence: { footer },
      };
    },
    { timeoutMs: 5_000, stallMs: CONTROL_STALL_MS, pollMs: 150 },
  );
  const { footer } = initialTree;
  let treeText = initialTree.treeText;

  let startupSelected = false;
  for (let attempt = 0; attempt < footer.total; attempt++) {
    treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
    const currentFooter = chiefTreeFooter(treeText);
    if (!currentFooter || currentFooter.total !== footer.total)
      throw new Error(
        "chief-tree-selection: tree footer disappeared or changed while locating the startup branch",
      );
    if (chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_STARTUP")) {
      startupSelected = true;
      break;
    }
    const before = currentFooter.selected;
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "up"]);
    await waitForEvidence(
      ctx,
      "chief-tree-selection-move",
      async () => {
        let text;
        try {
          text = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
        } catch (error) {
          return {
            done: false,
            observationError: error?.message ?? String(error),
          };
        }
        const next = chiefTreeFooter(text);
        if (!next || next.total !== footer.total)
          throw new Error(
            "chief-tree-selection: tree footer disappeared or changed",
          );
        return {
          done: next.selected !== before,
          progress: { selected: next.selected },
          evidence: { selected: next.selected, total: next.total },
        };
      },
      { timeoutMs: 5_000, stallMs: CONTROL_STALL_MS, pollMs: 100 },
    );
  }
  if (!startupSelected)
    throw new Error(
      `chief-tree-selection: startup answer was not selected after checking ${footer.total} tree rows; Enter was not sent`,
    );
  const treeEventsBefore = countChiefTreeEvents(await readSnapshotContents());
  await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);
  const transition = await waitForEvidence(
    ctx,
    "chief-tree-branch-load",
    async () => {
      let text;
      try {
        text = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
      } catch (error) {
        return {
          done: false,
          observationError: error?.message ?? String(error),
        };
      }
      let snapshots;
      let treeEvents = 0;
      try {
        snapshots = await readSnapshots();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (snapshots)
        treeEvents = countChiefTreeEvents(
          await readSnapshotContents(),
          treeEventsBefore,
        );
      return {
        ...chiefTreeBranchTransition(
          text,
          snapshots,
          treeEventsBefore,
          treeEvents,
        ),
        evidence: {
          footer: chiefTreeFooter(text),
          treeEvents,
          treeEventsBefore,
        },
      };
    },
    { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS },
  );
  if (transition.state === "summary-dialog") {
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);
    await waitForEvidence(
      ctx,
      "chief-tree-branch-tree-snapshot",
      async () => {
        let snapshots;
        try {
          snapshots = await readSnapshots();
        } catch (error) {
          if (error.code === "ENOENT")
            return { done: false, observationError: error.message };
          throw error;
        }
        const treeEvents = countChiefTreeEvents(
          await readSnapshotContents(),
          treeEventsBefore,
        );
        const done =
          snapshots.has("tree") && treeEvents > transition.treeEvents;
        return {
          done,
          progress: { treeEvents, treeSnapshot: done },
          evidence: {
            treeEvents,
            treeEventsBeforeDialog: transition.treeEvents,
          },
        };
      },
      { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS },
    );
  }

  const snapshots = await awaitSnapshot("tree");
  ctx.chiefTreeProbeDiagnostics = Object.fromEntries(snapshots);
  const lead = snapshots.get("lead");
  const chief = snapshots.get("chief");
  const tree = snapshots.get("tree");
  assert.ok(
    lead && chief && tree,
    "chief-tree-probe: three snapshots required",
  );
  assert.notDeepEqual(
    chief,
    lead,
    "Chief tools must differ from ordinary Lead tools",
  );
  assert.deepEqual(
    tree,
    lead,
    "selecting the pre-Chief branch must restore ordinary Lead tools",
  );

  const followup = "Reply exactly PI_HERDSMAN_CHIEF_TREE_FOLLOWUP.";
  await submitPaneCommand(ctx, ctx.rootPaneId, followup);
  await waitForEvidence(
    ctx,
    "chief-tree-follow-up",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const done = !!(
        session &&
        assistantResultForSession(
          session,
          followup,
          "PI_HERDSMAN_CHIEF_TREE_FOLLOWUP",
        )
      );
      return {
        done,
        value: true,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          resultFound: done,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), stallMs: MODEL_STALL_MS },
  );
}

async function runSupervisorAgentSmoke(ctx) {
  await waitForEvidence(
    ctx,
    "supervisor-agent-startup",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      return {
        done:
          !!session &&
          session.contents.includes("PI_HERDSMAN_SUPERVISOR_AGENT_STARTUP"),
      };
    },
    { timeoutMs: 90_000, stallMs: MODEL_STALL_MS },
  );
  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools lead");
  const leadBeforeChief = await waitForEvidence(
    ctx,
    "supervisor-agent-lead-before-snapshot",
    async () => {
      try {
        const snapshots = parseToolSnapshots(
          await readFile(ctx.chiefTreeResultFile, "utf8"),
        );
        return { done: snapshots.has("lead"), value: snapshots.get("lead") };
      } catch (error) {
        if (error.code === "ENOENT") return { done: false };
        throw error;
      }
    },
    { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  await submitPaneCommand(ctx, ctx.rootPaneId, "/chief");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Chief mode active.",
    "--timeout",
    "15000",
  ]);
  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools chief");
  const chiefTools = await waitForEvidence(
    ctx,
    "supervisor-agent-chief-tool-snapshot",
    async () => {
      try {
        const snapshots = parseToolSnapshots(
          await readFile(ctx.chiefTreeResultFile, "utf8"),
        );
        return { done: snapshots.has("chief"), value: snapshots.get("chief") };
      } catch (error) {
        if (error.code === "ENOENT") return { done: false };
        throw error;
      }
    },
    { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  for (const tool of [
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
    "list_agents",
    "delegate_agent",
    "continue_agent",
  ])
    assert.ok(chiefTools.includes(tool), `Chief tool snapshot missing ${tool}`);
  for (const tool of [
    "delegate_project",
    "resume_project",
    "stop_lead",
    "remove_worktree",
    "message_supervisor",
    "list_peers",
    "message_peer",
  ])
    assert.ok(
      !chiefTools.includes(tool),
      `Chief tool snapshot unexpectedly includes ${tool}`,
    );
  assert.notDeepEqual(
    chiefTools,
    leadBeforeChief,
    "Chief tool snapshot did not transition from ordinary Lead tools",
  );
  const prompt =
    "SMOKE_SUPERVISOR_AGENT_DELEGATE: start the explicitly allowed Agent and wait for its result.";
  await submitPaneCommand(ctx, ctx.rootPaneId, prompt);
  const mailboxRoot = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "mailboxes-v5",
  );
  const timelineStartedAt = Date.now();
  const mailboxPreviouslySeen = new Map();
  const sampleHandoffTimeline = async (
    session,
    requestId,
    childSessionId,
    listed,
  ) => {
    const entries = sessionEntries(session.contents);
    const ownerSessionId = entries.find(
      (entry) => entry.type === "session",
    )?.id;
    const now = Date.now();
    const current = new Map();
    try {
      const dirs = await readdir(mailboxRoot, { withFileTypes: true });
      for (const dir of dirs.slice(0, 256)) {
        if (!dir.isDirectory() || !/^[0-9a-f]{32}$/.test(dir.name)) continue;
        const mailbox = join(mailboxRoot, dir.name);
        let state = null;
        let statePresent = false;
        try {
          const path = join(mailbox, "state.json");
          const stat = await lstat(path);
          if (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size <= 64 * 1024
          ) {
            state = JSON.parse(await readFile(path, "utf8"));
            statePresent = true;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (
          state?.agentLabel !== "smoke-supervisor-agent" &&
          !state?.completedRequestId &&
          !state?.activeRequestId
        )
          continue;
        let result = null;
        let resultPresent = false;
        try {
          const path = join(mailbox, `result-${requestId}.json`);
          const stat = await lstat(path);
          if (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size <= 64 * 1024
          ) {
            result = JSON.parse(await readFile(path, "utf8"));
            resultPresent = true;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const matches =
          !!state &&
          state.ownerSessionId === ownerSessionId &&
          state.agentLabel === "smoke-supervisor-agent" &&
          state.piSessionId === childSessionId;
        if (!matches && !resultPresent) continue;
        const sample = {
          mailbox: dir.name,
          matchesOwnerAgentSession: matches,
          statePresent,
          state: state
            ? {
                version: state.version,
                runId: state.runId,
                ownerSessionId: state.ownerSessionId,
                workspaceId: state.workspaceId,
                agentLabel: state.agentLabel,
                paneId: state.paneId,
                piSessionId: state.piSessionId,
                activeRequestId: state.activeRequestId,
                completedRequestId: state.completedRequestId,
                resultError: state.resultError,
                lastAck: state.lastAck,
                updatedAt: state.updatedAt,
              }
            : null,
          resultPresent,
          result: result
            ? {
                runId: result.runId,
                requestId: result.requestId,
                ownerSessionId: result.ownerSessionId,
                workspaceId: result.workspaceId,
                agentLabel: result.agentLabel,
                paneId: result.paneId,
                status: result.status,
                text:
                  typeof result.text === "string"
                    ? result.text.slice(0, 1200)
                    : null,
                error: result.error,
                completedAt: result.completedAt,
              }
            : null,
        };
        current.set(dir.name, sample);
      }
    } catch (error) {
      ctx.supervisorAgentTimeline ??= {
        startedAt: new Date(timelineStartedAt).toISOString(),
        events: [],
      };
      ctx.supervisorAgentTimeline.mailboxScanError = String(
        error?.message ?? error,
      ).slice(0, 500);
    }
    ctx.supervisorAgentTimeline ??= {
      startedAt: new Date(timelineStartedAt).toISOString(),
      events: [],
    };
    const timeline = ctx.supervisorAgentTimeline;
    for (const [dir, sample] of current) {
      const previous = mailboxPreviouslySeen.get(dir);
      const serialized = JSON.stringify(sample);
      if (serialized !== previous?.serialized && timeline.events.length < 64)
        timeline.events.push({
          at: new Date(now).toISOString(),
          elapsedMs: now - timelineStartedAt,
          type: previous ? "mailbox-change" : "mailbox-first-seen",
          ...sample,
        });
      mailboxPreviouslySeen.set(dir, { serialized });
    }
    for (const dir of mailboxPreviouslySeen.keys()) {
      if (!current.has(dir) && timeline.events.length < 64) {
        timeline.events.push({
          at: new Date(now).toISOString(),
          elapsedMs: now - timelineStartedAt,
          type: "mailbox-disappeared",
          mailbox: dir,
        });
        mailboxPreviouslySeen.delete(dir);
      }
    }
    const delivered = entries.find((entry) => {
      const message = entry.type === "custom_message" ? entry : entry.message;
      const details = message?.details;
      return (
        message?.customType === "pi-herdsman-agent-result" &&
        details?.requestId === requestId &&
        details?.piSessionId === childSessionId &&
        details?.agentLabel === "smoke-supervisor-agent" &&
        details?.agentDefinition === "smoke-agent" &&
        details?.status === "completed" &&
        messageText(message.content).startsWith(
          `Agent result · agent=smoke-supervisor-agent · definition=smoke-agent · session=${childSessionId} · status=completed`,
        ) &&
        messageText(message.content).includes(
          "SMOKE_SUPERVISOR_AGENT_COMPLETED",
        )
      );
    });
    timeline.requestId = requestId;
    timeline.childSessionId = childSessionId;
    timeline.mailboxesPresent = [...current.values()];
    timeline.rootSessionPath = session.path;
    timeline.rootTail = entries
      .filter((entry) => entry.type === "message")
      .slice(-12)
      .map(({ message = {} }) => ({
        role: message.role ?? null,
        toolName: message.toolName ?? null,
        toolCallId: message.toolCallId ?? null,
        isError: message.isError ?? null,
        stopReason: message.stopReason ?? null,
        errorMessage:
          typeof message.errorMessage === "string"
            ? message.errorMessage.slice(0, 500)
            : null,
        details: message.details
          ? {
              requestId: message.details.requestId,
              agentLabel: message.details.agentLabel,
              agentDefinition: message.details.agentDefinition,
              piSessionId: message.details.piSessionId,
              status: message.details.status,
            }
          : null,
        text: messageText(message.content).slice(0, 1000),
      }));
    timeline.deliveredResultObserved = !!delivered;
    timeline.currentAgents = (listed.agents ?? []).map((agent) => ({
      paneId: agent.pane_id ?? null,
      status: agent.agent_status ?? null,
      session: agent.agent_session ?? null,
    }));
  };
  const delivered = await waitForEvidence(
    ctx,
    "supervisor-agent-result-delivery",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      if (!session) return { done: false };
      const listed = await tryNestedCommand(ctx, ["agent", "list"]);
      if (!listed.ok) throw observationFailure(listed.error);
      const entries = sessionEntries(session.contents);
      const calls = entries.flatMap((entry, index) =>
        entry.type === "message" && entry.message?.role === "assistant"
          ? (entry.message.content ?? [])
              .filter(
                (part) =>
                  part.type === "toolCall" &&
                  part.name === "delegate_agent" &&
                  part.arguments?.label === "smoke-supervisor-agent",
              )
              .map((call) => ({ call, index }))
          : [],
      );
      for (const { call, index } of calls) {
        const resultIndex = entries.findIndex(
          (entry, i) =>
            i > index &&
            entry.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolName === "delegate_agent" &&
            entry.message.toolCallId === call.id &&
            !entry.message.isError,
        );
        const failed = entries.find(
          (entry, i) =>
            i > index &&
            entry.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolName === "delegate_agent" &&
            entry.message.toolCallId === call.id &&
            entry.message.isError,
        );
        if (failed)
          throw new Error(
            `Supervisor Agent assignment failed: ${messageText(failed.message.content)}`,
          );
        if (resultIndex < 0) continue;
        const assignmentResult = messageText(
          entries[resultIndex].message.content,
        );
        const childSessionId =
          assignmentResult.match(/^Session: ([^\n]+)$/m)?.[1];
        const requestId = assignmentResult.match(/^Request: ([^\n]+)$/m)?.[1];
        if (!childSessionId || !requestId)
          throw new Error(
            "Supervisor Agent assignment result omitted session/request identity",
          );
        const handoffIndex = entries.findIndex(
          (entry, i) =>
            i > resultIndex &&
            entry.type === "custom_message" &&
            entry.customType === "pi-herdsman-agent-result" &&
            entry.details?.requestId === requestId &&
            entry.details?.piSessionId === childSessionId &&
            entry.details?.agentLabel === "smoke-supervisor-agent" &&
            entry.details?.agentDefinition === "smoke-agent" &&
            entry.details?.status === "completed",
        );
        await sampleHandoffTimeline(
          session,
          requestId,
          childSessionId,
          listed.value,
        );
        const expectedHeader = `Agent result · agent=smoke-supervisor-agent · definition=smoke-agent · session=${childSessionId} · status=completed`;
        const handoff = handoffIndex >= 0 ? entries[handoffIndex] : null;
        const completion =
          handoffIndex >= 0 &&
          entries
            .slice(handoffIndex + 1)
            .some(
              (entry) =>
                entry.type === "message" &&
                entry.message?.role === "assistant" &&
                messageText(entry.message.content).includes(
                  "PI_HERDSMAN_SUPERVISOR_AGENT_DELIVERED",
                ),
            );
        if (
          handoff &&
          messageText(handoff.content).startsWith(expectedHeader) &&
          messageText(handoff.content).includes(
            "SMOKE_SUPERVISOR_AGENT_COMPLETED",
          ) &&
          completion
        ) {
          ctx.supervisorAgentEvidence = {
            session: session.path,
            assignment: call.arguments,
            requestId,
            childSessionId,
            result: messageText(handoff.content),
          };
          return { done: true, value: session };
        }
      }
      return {
        done: false,
        progress: {
          calls: calls.length,
          agents: (listed.value.agents ?? []).map(
            ({ pane_id, agent_status, agent_session }) => ({
              pane_id,
              agent_status,
              sessionKind: agent_session?.kind,
            }),
          ),
        },
      };
    },
    { timeoutMs: 60_000, stallMs: 30_000 },
  );
  assert.ok(delivered);
  await submitPaneCommand(ctx, ctx.rootPaneId, "/chief leave");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Leave chief mode?",
    "--timeout",
    "15000",
  ]);
  await submitPaneCommand(ctx, ctx.rootPaneId, "y");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Chief mode left.",
    "--timeout",
    "15000",
  ]);
  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools lead-after");
  const snapshots = await waitForEvidence(
    ctx,
    "supervisor-agent-lead-tool-snapshot",
    async () => {
      try {
        const current = parseToolSnapshots(
          await readFile(ctx.chiefTreeResultFile, "utf8"),
        );
        return { done: current.has("lead-after"), value: current };
      } catch (error) {
        if (error.code === "ENOENT") return { done: false };
        throw error;
      }
    },
    { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
  );
  assert.ok(
    snapshots.has("lead-after"),
    "ordinary Lead tool snapshot missing after Chief transition",
  );
  assert.deepEqual(
    snapshots.get("lead-after"),
    leadBeforeChief,
    "Chief leave did not restore the ordinary Lead tool snapshot",
  );
}

async function prepareSupervisorAgent(ctx) {
  const definitions = join(ctx.rootCwd, ".pi", "agents");
  await mkdir(definitions, { recursive: true });
  await writeFile(
    join(definitions, "smoke-agent.md"),
    `---\nname: smoke-agent\nmodel: smoke-faux/supervisor-agent\nextensions: [${JSON.stringify(ctx.simulatedProviderExtension)}]\n---\nReturn the requested completion marker.\n`,
  );
  const globalAgents = join(ctx.paths.piAgent, "agents");
  await mkdir(globalAgents, { recursive: true });
  await writeFile(
    join(globalAgents, "chief.md"),
    "---\nname: chief\nagents: [smoke-agent]\n---\n",
  );
}

export function descendantCleanupStatus(
  inspection,
  previouslyVerified,
  isPidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  },
) {
  const verified = new Map(previouslyVerified);
  for (const item of inspection.verified)
    verified.set(item.pid, { paneId: item.paneId, pid: item.pid });
  const live = [...verified.values()].filter(({ pid }) => isPidAlive(pid));
  const livePaneIds = new Set(inspection.paneIds);
  const unresolved = inspection.unresolved.filter(({ paneId }) =>
    livePaneIds.has(paneId),
  );
  return {
    done: live.length === 0 && unresolved.length === 0,
    live,
    unresolved,
    verified,
  };
}

async function waitForDescendantsToExit(ctx) {
  const previouslyVerified = new Map();
  await waitForEvidence(
    ctx,
    "descendant-cleanup",
    async () => {
      const inspection = await inspectCandidateProcesses(ctx);
      const status = descendantCleanupStatus(inspection, previouslyVerified);
      for (const [pid, item] of status.verified)
        previouslyVerified.set(pid, item);
      return {
        done: status.done,
        progress: {
          live: status.live.map(({ paneId, pid }) => `${paneId}:${pid}`).sort(),
          unresolved: status.unresolved.map(({ paneId }) => paneId).sort(),
        },
        evidence: inspection.records.slice(-20),
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS, pollMs: 500 },
  );
}

export async function verifyParentShutdown(
  parent,
  { stop, waitForExit, status },
  diagnostics = {},
) {
  const terminalState = () => ({
    exitCode: parent.server?.exitCode ?? null,
    signalCode: parent.server?.signalCode ?? null,
  });
  const childExited = () =>
    Boolean(parent.exit) ||
    (parent.server?.exitCode !== null &&
      parent.server?.exitCode !== undefined) ||
    (parent.server?.signalCode !== null &&
      parent.server?.signalCode !== undefined);
  const signalName = (signal) =>
    ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGQUIT"].includes(
      signal,
    )
      ? signal
      : null;
  const exitedBeforeStop = childExited();
  diagnostics.child = {
    exitObservedBeforeStop: Boolean(parent.exit),
    ...terminalState(),
  };
  let stopError;
  try {
    const result = await stop();
    diagnostics.stop = {
      completed: true,
      exitCode: Number.isInteger(result?.code) ? result.code : null,
      signal: signalName(result?.signal),
    };
  } catch (error) {
    stopError = error;
    diagnostics.stop = {
      completed: false,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      errorCode: "COMMAND_FAILED",
    };
  }
  let exitError;
  try {
    await waitForExit();
  } catch (error) {
    exitError = error;
  }
  if (!exitError && !childExited())
    exitError = new Error("owned child exit event was not observed");
  diagnostics.child.exitObservedAfterStop ??= Boolean(parent.exit);
  Object.assign(diagnostics.child, terminalState());
  let serverStopped = false;
  let statusError;
  try {
    const observed = await status();
    serverStopped = observed?.server?.running === false;
    diagnostics.namedServer = {
      verified: typeof observed?.server?.running === "boolean",
      running:
        typeof observed?.server?.running === "boolean"
          ? observed.server.running
          : null,
    };
  } catch (error) {
    statusError = error;
    diagnostics.namedServer = {
      verified: false,
      running: null,
      errorCode: "STATUS_UNAVAILABLE",
    };
  }
  const failures = [];
  if (exitedBeforeStop)
    failures.push("owned child exited before requested server shutdown");
  if (exitError)
    failures.push(`owned child did not exit: ${exitError.message}`);
  if (statusError || !serverStopped)
    failures.push(
      `named Herdr server stop not verified${statusError ? `: ${statusError.message}` : ""}`,
    );
  if (stopError && (exitError || !serverStopped))
    failures.push(
      `named Herdr server stop command failed: ${stopError.message}`,
    );
  return failures;
}

export async function collectDiagnostics(
  ctx,
  owned,
  failure,
  { execute = run, observe = tryHerdr, snapshot = rootSessionSnapshot } = {},
) {
  const diagnostics = {};
  const env = nestedControlEnv(process.env, ctx.paths, ctx.sessionName);
  diagnostics.chiefTreeProbe = ctx.chiefTreeProbeDiagnostics ?? null;
  diagnostics.managerRecovery = ctx.managerRecovery ?? null;
  diagnostics.terminalFailure = ctx.terminalFailure ?? null;
  diagnostics.continuationSession = ctx.continuationSessionEvidence ?? null;
  diagnostics.failure = failure?.smoke ?? null;
  diagnostics.stage = ctx.stage ?? null;
  diagnostics.preflight = ctx.preflight ?? null;
  const [agents, panes, rootSession, rootPane, hostPane] =
    await Promise.allSettled([
      observe(["agent", "list"], { env, timeout: OBSERVATION_TIMEOUT_MS }),
      observe(["pane", "list"], { env, timeout: OBSERVATION_TIMEOUT_MS }),
      snapshot(ctx),
      ctx.rootPaneId
        ? execute(
            "herdr",
            [
              "pane",
              "read",
              ctx.rootPaneId,
              "--source",
              "recent-unwrapped",
              "--lines",
              "120",
            ],
            { env, timeout: OBSERVATION_TIMEOUT_MS },
          )
        : null,
      owned.hostPaneId
        ? readParentHostPane(ctx, owned.hostPaneId, execute)
        : null,
    ]);
  diagnostics.agents =
    agents.status === "fulfilled"
      ? agents.value
      : { ok: false, error: agents.reason?.message };
  diagnostics.panes =
    panes.status === "fulfilled"
      ? panes.value
      : { ok: false, error: panes.reason?.message };
  diagnostics.observedCoreProcesses = ctx.coreProcessEvidence ?? [];
  diagnostics.coreProcessDiagnostics = ctx.coreProcessDiagnostics ?? [];
  const paneIds = diagnostics.panes.ok
    ? listedPanes(diagnostics.panes.value)
    : [];
  diagnostics.processes = await bestEffortProcessDiagnostics(
    paneIds,
    ctx.rootPaneId,
    async (paneId) => {
      const result = await observe(["pane", "process-info", "--pane", paneId], {
        env,
        timeout: OBSERVATION_TIMEOUT_MS,
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  try {
    const session =
      rootSession.status === "fulfilled" ? rootSession.value : null;
    diagnostics.rootSession = session
      ? {
          path: session.path,
          status: session.status,
          ...summarizeSession(session.contents),
          gracefulResumeCalls: ctx.managerRecovery?.resumePrompt
            ? managerRecoveryResumeDiagnostics(
                session.contents,
                ctx.managerRecovery.resumePrompt,
              )
            : null,
        }
      : { error: "no saved root Pi session was available" };
  } catch (error) {
    diagnostics.rootSession = { error: error.message };
  }
  if (ctx.scenario === "supervisor-agent") {
    const session =
      rootSession.status === "fulfilled" ? rootSession.value : null;
    const entries = session ? sessionEntries(session.contents) : [];
    const calls = entries.flatMap((entry, index) =>
      entry.type === "message" && entry.message?.role === "assistant"
        ? (entry.message.content ?? [])
            .filter(
              (part) =>
                part.type === "toolCall" &&
                part.name === "delegate_agent" &&
                part.arguments?.label === "smoke-supervisor-agent",
            )
            .map((call) => ({ call, index }))
        : [],
    );
    diagnostics.supervisorAgent = {
      rootSessionPath: session?.path ?? null,
      liveTimeline: ctx.supervisorAgentTimeline ?? null,
      assignments: calls.map(({ call, index }) => {
        const result = entries.find(
          (entry, resultIndex) =>
            resultIndex > index &&
            entry.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolName === "delegate_agent" &&
            entry.message.toolCallId === call.id,
        )?.message;
        return {
          toolCallId: call.id,
          arguments: call.arguments,
          outcome: result ? (result.isError ? "error" : "success") : "pending",
          result: result ? messageText(result.content).slice(0, 2000) : null,
        };
      }),
    };
    const latestAssignment = diagnostics.supervisorAgent.assignments.at(-1);
    const childSessionId =
      latestAssignment?.result?.match(/^Session: ([^\n]+)/m)?.[1];
    const requestId =
      latestAssignment?.result?.match(/^Request: ([^\n]+)/m)?.[1];
    diagnostics.supervisorAgent.childSessionId = childSessionId ?? null;
    diagnostics.supervisorAgent.requestId = requestId ?? null;
    const rootEntries = entries.filter((entry) => entry.type === "message");
    const assignmentEntryIndex = calls.at(-1)?.index ?? 0;
    diagnostics.supervisorAgent.rootEntries = rootEntries
      .filter((entry) => entries.indexOf(entry) >= assignmentEntryIndex)
      .slice(-20)
      .map((entry) => {
        const message = entry.message ?? {};
        return {
          role: message.role ?? null,
          toolName: message.toolName ?? null,
          toolCallId: message.toolCallId ?? null,
          isError: message.isError ?? null,
          stopReason: message.stopReason ?? null,
          errorMessage:
            typeof message.errorMessage === "string"
              ? message.errorMessage.slice(0, 1000)
              : null,
          calls: (Array.isArray(message.content) ? message.content : [])
            .filter((part) => part.type === "toolCall")
            .map((part) => ({
              id: part.id,
              name: part.name,
              arguments: part.arguments,
            })),
          text: messageText(message.content).slice(0, 2000),
        };
      });
    if (requestId && session) {
      const mailboxRoot = join(
        ctx.paths.piAgent,
        "pi-herdsman",
        "runtime",
        "mailboxes-v5",
      );
      const mailboxEvidence = [];
      let mailboxDirectoriesScanned = 0;
      try {
        const dirs = await readdir(mailboxRoot, { withFileTypes: true });
        for (const dir of dirs.slice(0, 256)) {
          if (!dir.isDirectory() || !/^[0-9a-f]{32}$/.test(dir.name)) continue;
          mailboxDirectoriesScanned++;
          const path = join(mailboxRoot, dir.name);
          let state;
          try {
            const statePath = join(path, "state.json");
            const details = await lstat(statePath);
            if (
              !details.isFile() ||
              details.isSymbolicLink() ||
              details.size > 64 * 1024
            )
              continue;
            state = JSON.parse(await readFile(statePath, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            state = null;
          }
          let result = null;
          try {
            const resultPath = join(path, `result-${requestId}.json`);
            const details = await lstat(resultPath);
            if (
              details.isFile() &&
              !details.isSymbolicLink() &&
              details.size <= 64 * 1024
            )
              result = JSON.parse(await readFile(resultPath, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const ownerSessionId = sessionEntries(session.contents).find(
            (entry) => entry.type === "session",
          )?.id;
          const stateMatches =
            !!state &&
            state.ownerSessionId === ownerSessionId &&
            state.agentLabel === latestAssignment?.arguments?.label &&
            [state.activeRequestId, state.completedRequestId].includes(
              requestId,
            );
          if (
            stateMatches ||
            result ||
            state?.agentLabel === latestAssignment?.arguments?.label
          )
            mailboxEvidence.push({
              mailbox: dir.name,
              stateMatches,
              ownerMatches: state?.ownerSessionId === ownerSessionId,
              requestMatches: [
                state?.activeRequestId,
                state?.completedRequestId,
              ].includes(requestId),
              state,
              result,
            });
        }
      } catch (error) {
        if (error.code !== "ENOENT")
          diagnostics.supervisorAgent.mailboxError = String(
            error?.message ?? error,
          ).slice(0, 500);
      }
      diagnostics.supervisorAgent.mailboxDirectoriesScanned =
        mailboxDirectoriesScanned;
      diagnostics.supervisorAgent.mailboxes = mailboxEvidence;
    }
    if (childSessionId) {
      const records = diagnostics.agents.ok
        ? (diagnostics.agents.value?.agents ?? [])
        : [];
      let childRecord = records.find(
        (agent) =>
          agent.agent_session?.kind === "id" &&
          agent.agent_session.value === childSessionId,
      );
      if (!childRecord) {
        for (const agent of records) {
          if (agent.agent_session?.kind !== "path") continue;
          const details = await isolatedSessionDetails(ctx, agent);
          if (details?.id === childSessionId) {
            childRecord = agent;
            break;
          }
        }
      }
      diagnostics.supervisorAgent.childAgent = childRecord
        ? {
            paneId: childRecord.pane_id ?? null,
            status: childRecord.agent_status ?? null,
            sessionIdentity: childRecord.agent_session ?? null,
          }
        : null;
      let childSession;
      try {
        childSession = await exactIsolatedSession(ctx, childSessionId);
      } catch (error) {
        diagnostics.supervisorAgent.childSessionError = String(
          error?.message ?? error,
        ).slice(0, 500);
      }
      diagnostics.supervisorAgent.childSession = childSession
        ? {
            path: childSession.path,
            ...summarizeSession(childSession.contents),
          }
        : null;
      const childPaneId = childRecord?.pane_id;
      if (childPaneId) {
        const [terminal, processes] = await Promise.allSettled([
          execute(
            "herdr",
            [
              "pane",
              "read",
              childPaneId,
              "--source",
              "recent-unwrapped",
              "--lines",
              "100",
            ],
            { env, timeout: OBSERVATION_TIMEOUT_MS },
          ),
          observe(["pane", "process-info", "--pane", childPaneId], {
            env,
            timeout: OBSERVATION_TIMEOUT_MS,
          }),
        ]);
        diagnostics.supervisorAgent.childTerminal =
          terminal.status === "fulfilled"
            ? terminal.value.stdout.slice(-12_000)
            : String(terminal.reason?.message ?? terminal.reason).slice(0, 500);
        diagnostics.supervisorAgent.childProcesses =
          processes.status === "fulfilled" && processes.value.ok
            ? await bestEffortProcessDiagnostics(
                [childPaneId],
                ctx.rootPaneId,
                async () => processes.value.value,
                ctx.candidateExtension,
                ctx.herdrStateExtension,
              )
            : {
                error:
                  processes.status === "rejected"
                    ? String(
                        processes.reason?.message ?? processes.reason,
                      ).slice(0, 500)
                    : processes.value.error,
              };
      } else {
        diagnostics.supervisorAgent.childTerminal = null;
        diagnostics.supervisorAgent.childProcesses = null;
      }
    }
  }
  diagnostics.root =
    rootPane.status === "fulfilled"
      ? rootPane.value.stdout.slice(-20_000)
      : { error: rootPane.reason?.message ?? null };
  diagnostics.host =
    hostPane.status === "fulfilled"
      ? hostPane.value.stdout.slice(-12_000)
      : { error: hostPane.reason?.message ?? null };
  const knownDescendants = [
    ...new Set(
      [
        ...(ctx.coreProcessEvidence ?? []).map((item) => item.paneId),
        ctx.continuationFirstPaneId,
        ctx.continuationSecondPaneId,
        ctx.managerRecovery?.paneId,
      ].filter((id) => id && id !== ctx.rootPaneId && id !== owned.hostPaneId),
    ),
  ].slice(0, 4);
  const descendantReads = await Promise.allSettled(
    knownDescendants.map((paneId) =>
      execute(
        "herdr",
        [
          "pane",
          "read",
          paneId,
          "--source",
          "recent-unwrapped",
          "--lines",
          "80",
        ],
        { env, timeout: OBSERVATION_TIMEOUT_MS },
      ),
    ),
  );
  diagnostics.descendants = descendantReads.map((entry, index) =>
    entry.status === "fulfilled"
      ? {
          paneId: knownDescendants[index],
          output: entry.value.stdout.slice(-12_000),
        }
      : { paneId: knownDescendants[index], error: entry.reason?.message },
  );
  try {
    const serialized = JSON.stringify({
      stage: diagnostics.stage,
      failureCode: diagnostics.failure?.code ?? null,
      agentsObserved: diagnostics.agents?.ok
        ? (diagnostics.agents.value?.agents?.length ?? 0)
        : null,
      panesObserved: diagnostics.panes?.ok
        ? (diagnostics.panes.value?.panes?.length ?? 0)
        : null,
      candidateProcessesObserved: Array.isArray(diagnostics.processes)
        ? diagnostics.processes.filter((record) => record.processMatch).length
        : null,
      rootSessionObserved: !diagnostics.rootSession?.error,
    });
    console.error(`diagnostics: ${serialized}`);
  } catch {
    console.error("diagnostics: collection failed");
  }
  return {
    stage: diagnostics.stage,
    agentsObserved: diagnostics.agents?.ok
      ? (diagnostics.agents.value?.agents?.length ?? 0)
      : null,
    panesObserved: diagnostics.panes?.ok
      ? (diagnostics.panes.value?.panes?.length ?? 0)
      : null,
    rootSessionObserved: Boolean(
      diagnostics.rootSession && !diagnostics.rootSession.error,
    ),
    ...(ctx.scenario === "continuation"
      ? {
          rootDelegation:
            rootSession.status === "fulfilled" && rootSession.value
              ? rootDelegationDiagnostics(rootSession.value.contents)
              : null,
        }
      : {}),
    candidateProcessesObserved: Array.isArray(diagnostics.processes)
      ? diagnostics.processes.filter((record) => record.processMatch).length
      : null,
    ...(diagnostics.supervisorAgent
      ? {
          supervisorAgent: {
            assignmentsObserved: diagnostics.supervisorAgent.assignments.length,
            childSessionObserved: Boolean(
              diagnostics.supervisorAgent.childSession,
            ),
            matchingMailboxes:
              diagnostics.supervisorAgent.mailboxes?.filter(
                (item) => item.stateMatches,
              ).length ?? 0,
          },
        }
      : {}),
  };
}

export async function bestEffortDiagnostics(ctx, collect) {
  try {
    return await collect();
  } catch {
    return { stage: ctx.stage ?? null, collectionFailed: true };
  }
}

export async function cleanup(
  paths,
  owned,
  ctx,
  {
    runCommand = run,
    herdrCommand = herdr,
    tryHerdrCommand = tryHerdr,
    remove = rm,
    removeFile = unlink,
    sleepFor = sleep,
  } = {},
) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("smoke cleanup deadline exhausted");
    return Math.min(OBSERVATION_TIMEOUT_MS, remaining);
  };
  const cleanupRun = (file, args, options = {}) =>
    runCommand(file, args, { ...options, timeout: remainingTimeout() });
  const cleanupHerdr = (args, options = {}) =>
    herdrCommand(args, { ...options, timeout: remainingTimeout() });
  const failures = [];
  const cleanupFailureCategories = new Set();
  const recordCleanupFailure = (category, message) => {
    cleanupFailureCategories.add(category);
    failures.push(message);
  };
  try {
    await removeFile(paths.authLink);
  } catch (error) {
    if (error.code !== "ENOENT")
      recordCleanupFailure("auth_symlink", `auth symlink: ${error.message}`);
  }
  if (owned.managerBranch) {
    let managerWorktreeSafe = true;
    try {
      assert.equal(
        owned.managerBranch,
        ctx.managerRecovery?.branch ?? ctx.terminalFailure?.branch,
      );
      const listed = await cleanupHerdr(
        ["worktree", "list", "--workspace", ctx.rootWorkspaceId],
        {
          env: nestedControlEnv(process.env, paths, owned.sessionName),
        },
      );
      if (!Array.isArray(listed.worktrees))
        throw new Error("Herdr worktree topology is unavailable");
      const worktrees = listed.worktrees;
      const cleanupTopology = worktrees.map((item) =>
        owned.managerBranch === item.branch &&
        typeof item.path !== "string" &&
        typeof item.worktree_path !== "string" &&
        typeof owned.managerWorktreePath === "string"
          ? { ...item, path: owned.managerWorktreePath }
          : item,
      );
      const target = managerCleanupTarget(
        cleanupTopology,
        owned.managerBranch,
        owned.managerWorktreePath,
        owned.managerWorkspaceId,
        owned.managerWorktreeRetirementRequested === true,
      );
      if (target) {
        const env = nestedControlEnv(process.env, paths, owned.sessionName);
        await cleanupHerdr(
          ["worktree", "remove", "--workspace", target.open_workspace_id],
          {
            env,
          },
        );
      }
    } catch (error) {
      managerWorktreeSafe = false;
      recordCleanupFailure(
        "manager_worktree",
        `manager worktree ${owned.managerWorkspaceId ?? owned.managerBranch}: ${error.message}`,
      );
    }
    if (managerWorktreeSafe) {
      try {
        assert.equal(
          owned.managerBranch,
          ctx.managerRecovery?.branch ?? ctx.terminalFailure?.branch,
        );
        await deleteBranchIfPresent(
          owned.managerBranch,
          cleanupRun,
          ctx.primaryCheckoutPath ?? repoRoot,
        );
      } catch (error) {
        recordCleanupFailure(
          "manager_branch",
          `manager branch ${owned.managerBranch}: ${error.message}`,
        );
      }
    }
  }
  if (owned.sessionName) {
    const env = nestedControlEnv(process.env, paths, owned.sessionName);
    let deleted = false;
    try {
      await tryHerdrCommand(["session", "stop", owned.sessionName, "--json"], {
        env,
        timeout: remainingTimeout(),
      });
      for (let i = 0; i < 3 && !deleted; i++) {
        const deletion = await tryHerdrCommand(
          ["session", "delete", owned.sessionName, "--json"],
          { env, timeout: remainingTimeout() },
        );
        const sessions = await tryHerdrCommand(["session", "list", "--json"], {
          env,
          timeout: remainingTimeout(),
        });
        if (!sessions.ok)
          throw new Error(
            `could not verify nested session deletion: ${sessions.error}`,
          );
        const rows = sessions.value?.sessions;
        if (!Array.isArray(rows))
          throw new Error("Herdr session list result is malformed");
        deleted = !rows.some((item) => item.name === owned.sessionName);
        if (!deletion.ok && !deleted)
          throw new Error(
            `session delete delivery is ambiguous; session still listed: ${deletion.error}`,
          );
        if (!deleted && i < 2)
          await sleepFor(Math.min(300, remainingTimeout()));
      }
    } catch (error) {
      recordCleanupFailure(
        "nested_session",
        `nested session cleanup ${owned.sessionName}: ${error.message}`,
      );
    }
    if (
      !deleted &&
      !failures.some((item) => item.startsWith("nested session remains"))
    )
      recordCleanupFailure(
        "nested_session",
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
  }
  if (owned.hostTabId) {
    try {
      await cleanupHerdr(["tab", "close", owned.hostTabId], {
        env: ctx.parentEnv,
      });
    } catch (error) {
      recordCleanupFailure(
        "host_tab",
        `host tab ${owned.hostTabId}: ${error.message}`,
      );
    }
  }
  if (owned.parent) {
    const parent = owned.parent;
    const parentDiagnostics = {
      child: { exitObservedBeforeStop: Boolean(parent.exit) },
    };
    ctx.parentCleanupDiagnostics = parentDiagnostics;
    if (parent.workspaceId) {
      try {
        await cleanupHerdr(["workspace", "close", parent.workspaceId], {
          env: parent.env,
        });
      } catch (error) {
        recordCleanupFailure(
          "parent_workspace",
          `parent workspace ${parent.workspaceId}: ${error.message}`,
        );
      }
    }
    const waitForParentExit = async (timeoutMs) => {
      if (
        parent.exit ||
        parent.server.exitCode != null ||
        parent.server.signalCode != null
      )
        return;
      await Promise.race([
        new Promise((resolve) => parent.server.once("exit", resolve)),
        sleepFor(timeoutMs).then(() => {
          throw new Error("owned child process did not exit");
        }),
      ]);
    };
    const parentFailures = await verifyParentShutdown(
      parent,
      {
        stop: () =>
          cleanupRun("herdr", ["--session", parent.name, "server", "stop"], {
            env: parent.env,
          }),
        waitForExit: async () => {
          try {
            await waitForParentExit(5_000);
            parentDiagnostics.child.waitAfterStop = "exited";
            parentDiagnostics.child.exitObservedAfterStop = Boolean(
              parent.exit,
            );
          } catch {
            parentDiagnostics.child.waitAfterStop = "timeout";
            parentDiagnostics.child.exitObservedAfterStop = Boolean(
              parent.exit,
            );
            parentDiagnostics.child.sigtermSent = parent.server.kill("SIGTERM");
            try {
              await waitForParentExit(3_000);
              parentDiagnostics.child.waitAfterSigterm = "exited";
            } catch {
              parentDiagnostics.child.waitAfterSigterm = "timeout";
            } finally {
              parentDiagnostics.child.exitObservedAfterSigterm = Boolean(
                parent.exit,
              );
            }
            if (parentDiagnostics.child.waitAfterSigterm !== "exited") {
              parentDiagnostics.child.sigkillSent =
                parent.server.kill("SIGKILL");
              try {
                await waitForParentExit(2_000);
                parentDiagnostics.child.waitAfterSigkill = "exited";
              } catch (error) {
                parentDiagnostics.child.waitAfterSigkill = "timeout";
                throw error;
              } finally {
                parentDiagnostics.child.exitObservedAfterSigkill = Boolean(
                  parent.exit,
                );
              }
            }
          }
        },
        status: async () => {
          const result = await tryHerdrCommand(["status", "--json"], {
            env: parent.env,
            timeout: remainingTimeout(),
          });
          if (!result.ok) throw new Error(result.error);
          return result.value;
        },
      },
      parentDiagnostics,
    );
    parentDiagnostics.cleanupErrorCode = parentFailures.length
      ? "PARENT_SHUTDOWN_UNVERIFIED"
      : null;
    failures.push(
      ...parentFailures.map((failure) => `parent ${parent.name}: ${failure}`),
    );
  }
  const sessionMayRemain =
    owned.sessionName &&
    failures.some(
      (item) => item.includes(owned.sessionName) && item.includes("cleanup"),
    );
  if (!sessionMayRemain && !failures.length) {
    try {
      await remove(paths.root, { recursive: true, force: true });
    } catch (error) {
      recordCleanupFailure(
        "temporary_state",
        `temporary state: ${error.message}`,
      );
    }
  }
  ctx.cleanupErrorCode = failures.length
    ? (ctx.parentCleanupDiagnostics?.cleanupErrorCode ?? "CLEANUP_FAILED")
    : null;
  ctx.cleanupFailureCategories = [...cleanupFailureCategories].sort();
  return failures.length ? failures.join("\n") : null;
}

export function sanitizedFailureEvidence(ctx, failure, outcome, cleanup) {
  const parent = ctx.owned?.parent;
  const progress =
    failure?.error?.smoke?.stage === "terminal-failure-report"
      ? failure.error.smoke.lastProgress
      : null;
  const terminalFailureProgress = progress
    ? {
        requestCount: Number.isSafeInteger(progress.requestCount)
          ? progress.requestCount
          : null,
        settledCount: Number.isSafeInteger(progress.settledCount)
          ? progress.settledCount
          : null,
        settledNonAborted:
          typeof progress.settledNonAborted === "boolean"
            ? progress.settledNonAborted
            : null,
        finalError:
          typeof progress.finalError === "boolean" ? progress.finalError : null,
        partialObserved:
          typeof progress.partialObserved === "boolean"
            ? progress.partialObserved
            : null,
        leadToolCalls: Number.isSafeInteger(progress.leadToolCalls)
          ? progress.leadToolCalls
          : null,
        reportCount: Number.isSafeInteger(progress.reportCount)
          ? progress.reportCount
          : null,
        logicalReports: Number.isSafeInteger(progress.logicalReports)
          ? progress.logicalReports
          : null,
        actionable:
          typeof progress.actionable === "boolean" ? progress.actionable : null,
        managerResponded:
          typeof progress.managerResponded === "boolean"
            ? progress.managerResponded
            : null,
        settlementCallback: ["observed", "not_observed"].includes(
          progress.settlementCallback,
        )
          ? progress.settlementCallback
          : "not_observed",
        settlementOutcome: [
          "aborted",
          "error",
          "completed",
          "other",
          "not_observed",
        ].includes(progress.settlementOutcome)
          ? progress.settlementOutcome
          : "not_observed",
        reportPending: ["observed", "not_observed"].includes(
          progress.reportPending,
        )
          ? progress.reportPending
          : "not_observed",
        publicationAttempt: [
          "attempted",
          "not_attempted",
          "not_observed",
        ].includes(progress.publicationAttempt)
          ? progress.publicationAttempt
          : "not_observed",
        publicationOutcome: ["returned", "failed", "not_observed"].includes(
          progress.publicationOutcome,
        )
          ? progress.publicationOutcome
          : "not_observed",
        managerReceipt: ["observed", "not_observed"].includes(
          progress.managerReceipt,
        )
          ? progress.managerReceipt
          : "not_observed",
        managerFollowup: ["observed", "not_observed"].includes(
          progress.managerFollowup,
        )
          ? progress.managerFollowup
          : "not_observed",
      }
    : null;
  const managerProgress =
    failure?.error?.smoke?.stage === "manager-handoff-assignment"
      ? failure.error.smoke.lastProgress
      : null;
  const managerHandoffProgress = managerProgress
    ? {
        fauxSupervisorToolAvailability: [
          "not_offered",
          "not_observed",
        ].includes(managerProgress.fauxSupervisorToolAvailability)
          ? managerProgress.fauxSupervisorToolAvailability
          : "not_observed",
        expectedBranchWorktree: ["true", "false", "not_observed"].includes(
          managerProgress.expectedBranchWorktree,
        )
          ? managerProgress.expectedBranchWorktree
          : "not_observed",
        successfulCorrelatedDelegateProjectResult: [
          "true",
          "false",
          "not_observed",
        ].includes(managerProgress.successfulCorrelatedDelegateProjectResult)
          ? managerProgress.successfulCorrelatedDelegateProjectResult
          : "not_observed",
        assignmentIdentitySessionWorkspaceBranchMatch: [
          "true",
          "false",
          "not_observed",
        ].includes(
          managerProgress.assignmentIdentitySessionWorkspaceBranchMatch,
        )
          ? managerProgress.assignmentIdentitySessionWorkspaceBranchMatch
          : "not_observed",
        matchedLead: [
          "true",
          "false",
          "not_observed",
          "not_yet_evaluated",
        ].includes(managerProgress.matchedLead)
          ? managerProgress.matchedLead
          : "not_yet_evaluated",
        candidateProcessCount:
          Number.isSafeInteger(managerProgress.candidateProcessCount) &&
          managerProgress.candidateProcessCount >= 0
            ? Math.min(managerProgress.candidateProcessCount, 100)
            : "not_observed",
        candidateProcessProvenanceMatch: [
          "true",
          "false",
          "not_evaluated",
        ].includes(managerProgress.candidateProcessProvenanceMatch)
          ? managerProgress.candidateProcessProvenanceMatch
          : "not_evaluated",
        supervisorCallObserved:
          typeof managerProgress.supervisorCallObserved === "boolean"
            ? managerProgress.supervisorCallObserved
            : false,
        supervisorResultState: [
          "not_observed",
          "missing",
          "pending",
          "success",
          "error",
        ].includes(managerProgress.supervisorResultState)
          ? managerProgress.supervisorResultState
          : "not_observed",
        supervisorErrorCategory: [
          ...STRUCTURED_TOOL_ERROR_CATEGORIES,
          "tool_error",
          "none",
        ].includes(managerProgress.supervisorErrorCategory)
          ? managerProgress.supervisorErrorCategory
          : "none",
        supervisorHandlerBranchStatus:
          managerProgress.supervisorHandlerBranchStatus ===
          "operation_error_returned"
            ? managerProgress.supervisorHandlerBranchStatus
            : "not_observed",
        supervisorPersistedErrorCategoryPresent:
          typeof managerProgress.supervisorPersistedErrorCategoryPresent ===
          "boolean"
            ? managerProgress.supervisorPersistedErrorCategoryPresent
            : false,
        supervisorPersistedErrorCategory: STRUCTURED_TOOL_ERROR_CATEGORIES.has(
          managerProgress.supervisorPersistedErrorCategory,
        )
          ? managerProgress.supervisorPersistedErrorCategory
          : "not_observed",
        ...([
          "abort_error",
          "lock_occupied",
          "dispatch_error",
          "unstructured_error_unknown",
        ].includes(managerProgress.supervisorUnstructuredErrorClass)
          ? {
              supervisorUnstructuredErrorClass:
                managerProgress.supervisorUnstructuredErrorClass,
            }
          : {}),
        readinessDeliveryObserved:
          typeof managerProgress.readinessDeliveryObserved === "boolean"
            ? managerProgress.readinessDeliveryObserved
            : false,
        worktreeIdentityState: ["verified", "incomplete"].includes(
          managerProgress.worktreeIdentityState,
        )
          ? managerProgress.worktreeIdentityState
          : "not_observed",
        errorCategory:
          managerProgress.errorCategory === "worktree_identity_incomplete"
            ? managerProgress.errorCategory
            : "none",
        elapsedMs:
          typeof failure.error.smoke.elapsedMs === "number" &&
          Number.isFinite(failure.error.smoke.elapsedMs) &&
          failure.error.smoke.elapsedMs >= 0
            ? failure.error.smoke.elapsedMs
            : null,
        inactiveMs:
          typeof failure.error.smoke.inactiveMs === "number" &&
          Number.isFinite(failure.error.smoke.inactiveMs) &&
          failure.error.smoke.inactiveMs >= 0
            ? failure.error.smoke.inactiveMs
            : null,
      }
    : null;
  return {
    scenario: ctx.scenario,
    mode: ctx.simulated ? "simulated" : "live",
    outcome,
    stage: ctx.stage ?? "setup",
    errorCode:
      typeof failure?.error?.code === "string"
        ? failure.error.code.slice(0, 80)
        : undefined,
    ...(terminalFailureProgress ? { terminalFailureProgress } : {}),
    ...(managerHandoffProgress ? { managerHandoffProgress } : {}),
    lastVerified: ctx.lastVerified ?? null,
    processesVerified: ctx.coreProcessEvidence?.length ?? 0,
    sessionStartObserved: ctx.sessionStartObserved ?? false,
    firstRequestObserved: ctx.firstRequestObserved ?? false,
    firstRequestVerified: ctx.firstRequestVerified ?? false,
    parentOwnership: parent
      ? {
          session: parent.name,
          workspaceId: parent.workspaceId ?? null,
          childPid: parent.server.pid ?? null,
          childExitObserved: Boolean(parent.exit),
        }
      : null,
    parentCleanup: ctx.parentCleanupDiagnostics
      ? {
          stop: ctx.parentCleanupDiagnostics.stop ?? null,
          child: { ...ctx.parentCleanupDiagnostics.child },
          namedServer: ctx.parentCleanupDiagnostics.namedServer ?? null,
          cleanupErrorCode:
            ctx.parentCleanupDiagnostics.cleanupErrorCode ?? null,
        }
      : null,
    cleanupErrorCode: ctx.cleanupErrorCode ?? null,
    cleanupFailureCategories: [
      ...new Set(
        (ctx.cleanupFailureCategories ?? []).filter((category) =>
          [
            "auth_symlink",
            "manager_worktree",
            "manager_branch",
            "nested_session",
            "host_tab",
            "parent_workspace",
            "temporary_state",
          ].includes(category),
        ),
      ),
    ].sort(),
    cleanup,
  };
}

export async function preserveFailureEvidence(evidence, path) {
  if (path) {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    return path;
  }
  const directory = await mkdtemp(
    join(tmpdir(), "pi-herdsman-smoke-evidence-"),
  );
  const evidencePath = join(directory, "result.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return evidencePath;
}

function cleanupEvidence(owned) {
  return `parent=${owned.parent?.name ?? "not-created"} workspace=${owned.parent?.workspaceId ?? "not-created"} session=${owned.sessionName ?? "not-created"} host-tab=${owned.hostTabId ?? "not-created"} host-pane=${owned.hostPaneId ?? "not-created"}`;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  const pkg = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const scenario = args.scenario;
  let preflightEvidence;
  let model;
  try {
    preflightEvidence = await preflight(pkg);
    model = await selectSmokeModel(args);
    await run("npm", ["run", "build"], { cwd: repoRoot });
  } catch (error) {
    console.error(
      `smoke ${scenario}: SETUP FAIL\n${formatSmokeFailure(error, "preflight-build")}`,
    );
    try {
      const artifact = await preserveFailureEvidence({
        scenario,
        mode: args.simulated ? "simulated" : "live",
        outcome: "SETUP_FAIL",
        stage: "preflight-build",
        errorCode:
          typeof error?.code === "string" ? error.code.slice(0, 80) : null,
        lastVerified: null,
        processesVerified: 0,
        sessionStartObserved: false,
        firstRequestObserved: false,
        firstRequestVerified: false,
        cleanup: "NOT_REQUIRED",
      });
      console.error(`failure evidence: ${artifact}`);
    } catch (evidenceError) {
      console.error(
        `failure evidence: could not save: ${evidenceError.message}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  let paths;
  try {
    paths = await createIsolation();
  } catch (error) {
    console.error(
      `smoke ${scenario}: SETUP FAIL\n${formatSmokeFailure(error, "isolation")}`,
    );
    try {
      const artifact = await preserveFailureEvidence({
        scenario,
        mode: args.simulated ? "simulated" : "live",
        outcome: "SETUP_FAIL",
        stage: "isolation",
        errorCode:
          typeof error?.code === "string" ? error.code.slice(0, 80) : null,
        lastVerified: null,
        processesVerified: 0,
        sessionStartObserved: false,
        firstRequestObserved: false,
        firstRequestVerified: false,
        cleanup: "NOT_REQUIRED",
      });
      console.error(`failure evidence: ${artifact}`);
    } catch (evidenceError) {
      console.error(
        `failure evidence: could not save: ${evidenceError.message}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const owned = {};
  const ctx = {
    repoRoot,
    candidateExtension: join(repoRoot, "dist", "index.js"),
    herdrStateExtension: paths.herdrStateExtension,
    ...(scenario === "chief-tree" || scenario === "supervisor-agent"
      ? {
          chiefTreeProbeExtension: join(
            paths.piAgent,
            "extensions",
            "chief-tree-tools.mjs",
          ),
          chiefTreeResultFile: join(paths.root, "chief-tree-tools.json"),
        }
      : {}),
    sessionName: undefined,
    paths,
    model,
    simulated: args.simulated,
    ...(args.simulated || scenario === "terminal-failure"
      ? {
          simulatedProviderExtension: join(
            paths.piAgent,
            "extensions",
            "smoke-faux.ts",
          ),
        }
      : {}),
    managerReadyTimeoutMs:
      args.managerReadyTimeoutMs ?? DEFAULT_MANAGER_READY_TIMEOUT_MS,
    managerRecoveryDiagnostics: args.managerRecoveryDiagnostics,
    managerExternalRemoval: args.managerExternalRemoval,
    expectedPackage: `${pkg.name}@${pkg.version}`,
    scenario,
    owned,
    expectedPiVersion: pkg.piHerdsman.runtime.pi,
    preflight: preflightEvidence,
  };
  ctx.initialPrompt = initialPromptForScenario(scenario, ctx);
  let failure;
  let phase = "setup";
  let evidence;
  try {
    ctx.rootCwd =
      scenario === "agent-crash-recovery"
        ? join(paths.root, "crash-recovery-project")
        : scenario === "manager-recovery" ||
            scenario === "terminal-failure" ||
            scenario === "agent-terminal-failure" ||
            scenario === "manager-handoff" ||
            scenario === "supervisor-agent"
          ? await prepareManagerRepository(paths)
          : repoRoot;
    if (scenario === "agent-crash-recovery")
      await mkdir(ctx.rootCwd, { recursive: true });
    if (
      scenario === "manager-recovery" ||
      scenario === "terminal-failure" ||
      scenario === "agent-terminal-failure" ||
      scenario === "manager-handoff" ||
      scenario === "supervisor-agent"
    ) {
      ctx.primaryCheckoutPath = ctx.rootCwd;
    }
    await prepareHerdr(paths);
    const parent = await startParent(paths, owned);
    ctx.parentEnv = parent.env;
    ctx.parentName = parent.name;
    ctx.preflight = {
      ...preflightEvidence,
      ...(await preflightParent(pkg, parent.env)),
    };
    ctx.rootWorkspaceId = await createParentWorkspace(
      paths,
      parent,
      owned,
      ctx.rootCwd,
    );
    ctx.parentEnv = { ...parent.env, HERDR_WORKSPACE_ID: ctx.rootWorkspaceId };
    if (ctx.simulatedProviderExtension) {
      await copyFile(
        join(repoRoot, "scripts", "smoke-faux.mjs"),
        ctx.simulatedProviderExtension,
      );
      if (scenario === "continuation")
        await prepareContinuationFaux(paths, ctx.simulatedProviderExtension);
    }
    if (scenario === "agent-terminal-failure") {
      await mkdir(join(ctx.rootCwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(ctx.rootCwd, ".pi", "agents", "smoke-failure-agent.md"),
        `---\nname: smoke-failure-agent\nmodel: smoke-faux/terminal-agent-error\nextensions: [${JSON.stringify(ctx.simulatedProviderExtension)}]\n---\n`,
      );
      await writeFile(
        join(paths.piAgent, "settings.json"),
        JSON.stringify(
          {
            retry: {
              enabled: true,
              maxRetries: 1,
              baseDelayMs: 1,
              maxAgentDelayMs: 1,
              provider: { maxRetries: 0 },
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
    if (scenario === "manager-handoff") {
      await mkdir(join(ctx.rootCwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(ctx.rootCwd, ".pi", "agents", "managed-lead.md"),
        `---\nname: managed-lead\nmodel: smoke-faux/manager-handoff-lead\nextensions: [${JSON.stringify(ctx.simulatedProviderExtension)}]\n---\n`,
      );
    }
    if (scenario === "agent-crash-recovery") {
      await mkdir(join(ctx.rootCwd, ".pi", "agents"), { recursive: true });
      const definitions = [
        ["smoke-crash-target", "agent-crash-target"],
        ["implementer", "agent-crash-parent"],
        ["scout", "agent-crash-child"],
      ];
      for (const [name, modelId] of definitions) {
        const faux = ctx.simulated
          ? `model: smoke-faux/${modelId}\nnoExtensions: false\nextensions: [${JSON.stringify(ctx.simulatedProviderExtension)}]\n`
          : "";
        await writeFile(
          join(ctx.rootCwd, ".pi", "agents", `${name}.md`),
          `---\nname: ${name}\n${faux}---\n`,
          { flag: "wx" },
        );
      }
    }
    if (scenario === "supervisor-agent") await prepareSupervisorAgent(ctx);
    if (args.simulated) ctx.authMechanism = "not required (simulated)";
    else ctx.authMechanism = await preparePi(paths, model);
    if (ctx.chiefTreeProbeExtension)
      await writeFile(
        ctx.chiefTreeProbeExtension,
        chiefTreeProbeSource(ctx.chiefTreeResultFile),
        { flag: "wx" },
      );
    await startNestedHerdr(
      paths,
      owned,
      ctx.parentEnv,
      ctx.rootCwd,
      ctx.managerRecoveryDiagnostics,
    );
    ctx.sessionName = owned.sessionName;
    await waitForNestedHerdr(ctx);
    ctx.nestedServerVersion = requireNestedHerdrServer(
      await nestedCommand(ctx, ["status", "--json"]),
      ctx.sessionName,
      pkg.piHerdsman.runtime.herdr.version,
    );
    ctx.rootPaneId = await startCandidate(ctx);
    if (scenario === "agent-crash-recovery") {
      await waitForEvidence(
        ctx,
        "crash-recovery-initial-owner-ready",
        async () => {
          const listing = await tryNestedCommand(ctx, ["agent", "list"]);
          if (!listing.ok)
            return { done: false, observationError: listing.error };
          const owner = (listing.value.agents ?? []).find(
            (agent) =>
              agent.pane_id === ctx.rootPaneId &&
              typeof agent.agent_session?.value === "string",
          );
          return { done: !!owner, value: owner };
        },
        { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
      );
      await nestedCommand(ctx, [
        "agent",
        "prompt",
        ctx.rootPaneId,
        `PI_HERDSMAN_CRASH_RECOVERY_INITIAL: perform exactly two delegations. Delegate smoke-crash-target with the task "Call ask_owner with exactly CRASH_TARGET_WAITING, then remain waiting for an owner reply." Then delegate definition implementer as label smoke-crash-parent with the task "Delegate exactly one scout as smoke-crash-child; that child must call ask_owner with exactly CRASH_CHILD_WAITING and remain waiting. Remain unresolved while the child is pending." After both assignments are accepted, end your turn without replying to either ask_owner. Do not complete either Agent's task before the owner restarts Herdr.`,
      ]);
    }
    phase = "scenario";
    await runScenario(ctx, scenario);
    console.log(`herdr server: ${ctx.nestedServerVersion}`);
    console.log(`model: ${ctx.model}`);
    console.log(`candidate: ${ctx.candidateExtension}`);
    if (scenario === "core") {
      console.log(`descendant panes: ${ctx.descendantCount}`);
      console.log(
        `process evidence: ${JSON.stringify(ctx.coreProcessEvidence)}`,
      );
      console.log(`package result: ${ctx.expectedPackage}`);
    }
    if (scenario === "continuation")
      console.log(
        `continuation: ${JSON.stringify({
          sessionId: ctx.continuationSessionId,
          sessionPath: ctx.continuationSessionPath,
          firstPane: ctx.continuationFirstPaneId,
          secondPane: ctx.continuationSecondPaneId,
          secondPid: ctx.continuationGenerationPid,
          result: "one final remembered-context owner result",
        })}`,
      );
    if (scenario === "chief-tree")
      console.log(
        `chief-tree: ${JSON.stringify({
          snapshots: ctx.chiefTreeProbeDiagnostics,
          selectedBranch: ctx.chiefTreeBranchPlan,
        })}`,
      );
    if (scenario === "supervisor-agent")
      console.log(
        `supervisor-agent: ${JSON.stringify(ctx.supervisorAgentEvidence)}`,
      );
    if (scenario === "manager-recovery")
      console.log(`manager-recovery: ${JSON.stringify(ctx.managerRecovery)}`);
    if (scenario === "terminal-failure")
      console.log(`terminal-failure: ${JSON.stringify(ctx.terminalFailure)}`);
    if (scenario === "agent-crash-recovery")
      console.log(`agent-crash-recovery: ${JSON.stringify(ctx.crashRecovery)}`);
    console.log(`authentication: ${ctx.authMechanism}`);
  } catch (error) {
    failure = { phase, error };
    console.error(
      `smoke ${scenario}: ${classifySmokeFailure(phase, error).replace("_", " ")}\n${formatSmokeFailure(error, ctx.stage)}`,
    );
    try {
      const diagnosticProjection = ctx.sessionName
        ? await bestEffortDiagnostics(ctx, () =>
            collectDiagnostics(ctx, owned, failure),
          )
        : null;
      evidence = sanitizedFailureEvidence(
        ctx,
        failure,
        classifySmokeFailure(phase, error),
        "PENDING",
      );
      const markerPath = join(
        paths.piAgent,
        "pi-herdsman",
        "runtime",
        "smoke-faux-session-start.jsonl",
      );
      try {
        ctx.sessionStarts = (await readFile(markerPath, "utf8"))
          .trim()
          .split(/\r?\n/)
          .filter(Boolean).length;
      } catch {}
      ctx.sessionStartObserved = Boolean(ctx.sessionStarts);
      try {
        const provenance = await readFile(
          join(
            paths.piAgent,
            "pi-herdsman",
            "runtime",
            "smoke-faux-provenance.jsonl",
          ),
          "utf8",
        );
        ctx.firstRequestObserved = provenance.trim().length > 0;
      } catch {}
      evidence.sessionStartObserved = ctx.sessionStartObserved;
      evidence.firstRequestObserved = ctx.firstRequestObserved ?? false;
      evidence.firstRequestVerified = ctx.firstRequestVerified ?? false;
      evidence.diagnostics = diagnosticProjection;
      const artifact = await preserveFailureEvidence(evidence);
      ctx.failureArtifact = artifact;
      console.error(`failure evidence: ${artifact}`);
    } catch (diagnosticError) {
      console.error(
        `failure evidence: could not save: ${
          diagnosticError?.message ?? diagnosticError
        }`,
      );
      ctx.evidenceSaveFailed = true;
    }
  } finally {
    // Capture routing identity before cleanup can remove the isolated state.
    const parentOwnership = sanitizedFailureEvidence(
      { ...ctx, owned },
      null,
      "PENDING",
      "PENDING",
    ).parentOwnership;
    const cleanupError = await cleanup(paths, owned, ctx);
    if (cleanupError) {
      console.error(`CLEANUP FAIL ${cleanupEvidence(owned)}\n${cleanupError}`);
      process.exitCode = 1;
      if (!failure) {
        failure = { phase: "cleanup", error: new Error(cleanupError) };
        evidence = sanitizedFailureEvidence(
          ctx,
          failure,
          "CLEANUP_FAIL",
          "FAIL",
        );
        evidence.parentOwnership = parentOwnership;
        evidence.parentCleanup = sanitizedFailureEvidence(
          { ...ctx, owned },
          null,
          "PENDING",
          "PENDING",
        ).parentCleanup;
        evidence.cleanupErrorCode = ctx.cleanupErrorCode ?? "CLEANUP_FAILED";
        try {
          const artifact = await preserveFailureEvidence(
            evidence,
            ctx.failureArtifact,
          );
          ctx.failureArtifact = artifact;
          console.error(`failure evidence: ${artifact}`);
        } catch (error) {
          ctx.evidenceSaveFailed = true;
          console.error(`failure evidence: could not save: ${error.message}`);
        }
      } else if (evidence) {
        evidence.parentOwnership = parentOwnership;
        evidence.parentCleanup = sanitizedFailureEvidence(
          { ...ctx, owned },
          null,
          "PENDING",
          "PENDING",
        ).parentCleanup;
        evidence.cleanupErrorCode = ctx.cleanupErrorCode ?? "CLEANUP_FAILED";
        evidence.cleanup = "FAIL";
        try {
          const artifact = await preserveFailureEvidence(
            evidence,
            ctx.failureArtifact,
          );
          ctx.failureArtifact = artifact;
          console.error(`failure evidence: ${artifact}`);
        } catch (error) {
          ctx.evidenceSaveFailed = true;
          console.error(`failure evidence: could not save: ${error.message}`);
        }
      }
    } else {
      console.log(`cleanup: PASS ${cleanupEvidence(owned)}`);
      if (failure && evidence) {
        evidence.parentCleanup = sanitizedFailureEvidence(
          { ...ctx, owned },
          null,
          "PENDING",
          "PENDING",
        ).parentCleanup;
        evidence.cleanupErrorCode = null;
        evidence.cleanup = "PASS";
        try {
          await preserveFailureEvidence(evidence, ctx.failureArtifact);
        } catch (error) {
          ctx.evidenceSaveFailed = true;
          console.error(
            `failure evidence: could not update cleanup result: ${error.message}`,
          );
        }
      }
    }
    if (!failure && !cleanupError) console.log(`smoke ${scenario}: PASS`);
    if (failure || ctx.evidenceSaveFailed) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--nested-host") nestedHost(process.argv.slice(3));
  else await main();
}
