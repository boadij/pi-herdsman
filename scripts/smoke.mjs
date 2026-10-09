import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  access,
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
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioNames = [
  "core",
  "continuation",
  "chief-tree",
  "manager-recovery",
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
      "manager-ready-timeout-ms": { type: "string" },
      "manager-recovery-diagnostics": { type: "boolean" },
    },
  });
  const scenario = parseScenario(positionals);
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
  return {
    scenario,
    model: values.model,
    managerReadyTimeoutMs,
    managerRecoveryDiagnostics,
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
      if (args === "lead" || args === "chief") record(args);
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
    assert.ok(["lead", "chief", "tree"].includes(label));
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

export function managerCleanupTarget(
  worktrees,
  branch,
  worktreePath,
  retirementRequested = false,
) {
  if (typeof worktreePath !== "string" || !worktreePath)
    throw new Error("captured worktree path is unavailable");
  const matches = worktrees.filter((item) => item.branch === branch);
  if (matches.length === 0 && retirementRequested) return null;
  if (matches.length !== 1)
    throw new Error("exact branch must identify one worktree");
  const [target] = matches;
  if (target.path !== worktreePath)
    throw new Error("exact branch worktree path does not match captured path");
  if (typeof target.open_workspace_id !== "string" || !target.open_workspace_id)
    throw new Error("exact branch worktree has no workspace identity");
  return target;
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

export function managerProjectMessageSettled(
  contents,
  branch,
  fromSessionId,
  marker,
) {
  const entries = sessionEntries(contents);
  const receipt = entries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === fromSessionId &&
      String(entry.content).includes(marker),
  );
  return (
    receipt >= 0 &&
    entries
      .slice(receipt + 1)
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message.stopReason === "stop",
      )
  );
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
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID)
    throw new Error("smoke must run from a Herdr-managed Pi session");
  const nodeEngine = pkg?.engines?.node;
  const nodeBaseline =
    typeof nodeEngine === "string"
      ? /^>=(\d+\.\d+\.\d+)$/.exec(nodeEngine)?.[1]
      : undefined;
  const piBaseline = pkg?.piHerdsman?.runtime?.pi;
  const herdrBaseline = pkg?.piHerdsman?.runtime?.herdr?.version;
  requireTestedBaseline("Node", process.versions.node, nodeBaseline);
  const [{ stdout: piVersion }, status] = await Promise.all([
    run("pi", ["--version"], { timeout: OBSERVATION_TIMEOUT_MS }),
    herdr(["status", "--json"], { timeout: OBSERVATION_TIMEOUT_MS }),
  ]);
  const actualPiVersion = piVersion.trim();
  requireTestedBaseline("Pi", actualPiVersion, piBaseline);
  if (!status?.server?.running) throw new Error("Herdr server is not running");
  if (!status?.server?.compatible)
    throw new Error("Herdr client/server are incompatible");
  const herdrClientVersion = status.client?.version;
  if (typeof herdrClientVersion !== "string")
    throw new Error("Herdr client version is unavailable or invalid");
  requireTestedBaseline("Herdr", herdrClientVersion, herdrBaseline);
  return {
    piVersion: actualPiVersion,
    herdrClientVersion,
  };
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
  primaryCheckoutPath,
  managerRecoveryDiagnostics,
) {
  const id = randomUUID().slice(0, 12);
  const sessionName = `pi-herdsman-smoke-${id}`;
  owned.sessionName = sessionName;
  nestedHerdrApiSocketPath(paths, sessionName);
  const host = await herdr(
    [
      "tab",
      "create",
      "--workspace",
      process.env.HERDR_WORKSPACE_ID,
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
    { env: process.env },
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
    { env: process.env },
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
      shellCommand(["pi", ...args, ...(prompt === undefined ? [] : [prompt])]),
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
    case "manager-recovery":
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
    case "manager-recovery":
      return runManagerRecoverySmoke(ctx);
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
  if (Array.isArray(proc.argv))
    return hasExtensionArg(proc.argv, extension) &&
      hasExtensionArg(proc.argv, integration)
      ? "argv"
      : null;
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
  const errors = inspection.records
    .filter((record) => record.error)
    .map((record) => `${record.paneId}: ${record.error}`);
  if (errors.length) throw observationFailure(errors.join("; "));
  return inspection;
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
      return {
        done: !!ctx.assistantResult && paneCount >= 2,
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
      return {
        done: !!firstSession && pids.length > 0,
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
  assert.deepEqual(
    Object.keys(record).sort(),
    ["branch", "id", "piSessionFile", "repoKey", "text", "version"].sort(),
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

  markStage(ctx, "missing-worktree");
  await nestedCommand(ctx, ["workspace", "close", workspaceId]);
  await run("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: ctx.primaryCheckoutPath,
  });
  assert.equal((await matchingWorktrees()).length, 0);
  markStage(ctx, "assignment-absence-reconciliation");
  ctx.owned.managerWorktreeRetirementRequested = true;
  const messagesDirectory = join(
    dirname(assignmentPath),
    `${hash(branch)}.messages`,
  );
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
  await assert.rejects(lstat(messagesDirectory), { code: "ENOENT" });
  assert.equal((await matchingWorktrees()).length, 0);
  await run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: ctx.primaryCheckoutPath },
  );
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

async function waitForDescendantsToExit(ctx) {
  await waitForEvidence(
    ctx,
    "descendant-cleanup",
    async () => {
      const inspection = await inspectCandidateProcesses(ctx);
      return {
        done: inspection.verified.length === 0,
        progress: {
          live: inspection.verified
            .map(({ paneId, pid }) => `${paneId}:${pid}`)
            .sort(),
        },
        evidence: inspection.records.slice(-20),
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS, pollMs: 500 },
  );
}

async function collectDiagnostics(ctx, owned, failure) {
  const diagnostics = {};
  const env = nestedControlEnv(process.env, ctx.paths, ctx.sessionName);
  diagnostics.chiefTreeProbe = ctx.chiefTreeProbeDiagnostics ?? null;
  diagnostics.managerRecovery = ctx.managerRecovery ?? null;
  diagnostics.continuationSession = ctx.continuationSessionEvidence ?? null;
  diagnostics.failure = failure?.smoke ?? null;
  diagnostics.stage = ctx.stage ?? null;
  diagnostics.preflight = ctx.preflight ?? null;
  const [agents, panes, rootSession, rootPane, hostPane] =
    await Promise.allSettled([
      tryHerdr(["agent", "list"], { env, timeout: OBSERVATION_TIMEOUT_MS }),
      tryHerdr(["pane", "list"], { env, timeout: OBSERVATION_TIMEOUT_MS }),
      rootSessionSnapshot(ctx),
      ctx.rootPaneId
        ? run(
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
        ? run(
            "herdr",
            [
              "pane",
              "read",
              owned.hostPaneId,
              "--source",
              "recent-unwrapped",
              "--lines",
              "80",
            ],
            { timeout: OBSERVATION_TIMEOUT_MS },
          )
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
      const result = await tryHerdr(
        ["pane", "process-info", "--pane", paneId],
        { env, timeout: OBSERVATION_TIMEOUT_MS },
      );
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
      run(
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
    const serialized = JSON.stringify(diagnostics);
    console.error(`diagnostics: ${serialized}`);
  } catch {
    console.error("diagnostics: collection failed");
  }
}

async function cleanup(paths, owned, ctx) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("smoke cleanup deadline exhausted");
    return Math.min(OBSERVATION_TIMEOUT_MS, remaining);
  };
  const cleanupRun = (file, args, options = {}) =>
    run(file, args, { ...options, timeout: remainingTimeout() });
  const cleanupHerdr = (args, options = {}) =>
    herdr(args, { ...options, timeout: remainingTimeout() });
  const failures = [];
  try {
    await unlink(paths.authLink);
  } catch (error) {
    if (error.code !== "ENOENT")
      failures.push(`auth symlink: ${error.message}`);
  }
  if (owned.managerBranch) {
    let managerWorktreeSafe = true;
    try {
      assert.equal(owned.managerBranch, ctx.managerRecovery.branch);
      const listed = await cleanupHerdr(
        ["worktree", "list", "--workspace", ctx.rootWorkspaceId],
        {
          env: nestedControlEnv(process.env, paths, owned.sessionName),
        },
      );
      if (!Array.isArray(listed.worktrees))
        throw new Error("Herdr worktree topology is unavailable");
      const worktrees = listed.worktrees;
      const target = managerCleanupTarget(
        worktrees,
        owned.managerBranch,
        owned.managerWorktreePath,
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
      failures.push(
        `manager worktree ${owned.managerWorkspaceId ?? owned.managerBranch}: ${error.message}`,
      );
    }
    if (managerWorktreeSafe) {
      try {
        assert.equal(owned.managerBranch, ctx.managerRecovery.branch);
        await deleteBranchIfPresent(
          owned.managerBranch,
          cleanupRun,
          ctx.primaryCheckoutPath ?? repoRoot,
        );
      } catch (error) {
        failures.push(
          `manager branch ${owned.managerBranch}: ${error.message}`,
        );
      }
    }
  }
  if (owned.sessionName) {
    const env = nestedControlEnv(process.env, paths, owned.sessionName);
    let deleted = false;
    try {
      await tryHerdr(["session", "stop", owned.sessionName, "--json"], {
        env,
        timeout: remainingTimeout(),
      });
      for (let i = 0; i < 3 && !deleted; i++) {
        const deletion = await tryHerdr(
          ["session", "delete", owned.sessionName, "--json"],
          { env, timeout: remainingTimeout() },
        );
        const sessions = await tryHerdr(["session", "list", "--json"], {
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
        if (!deleted && i < 2) await sleep(Math.min(300, remainingTimeout()));
      }
    } catch (error) {
      failures.push(
        `nested session cleanup ${owned.sessionName}: ${error.message}`,
      );
    }
    if (
      !deleted &&
      !failures.some((item) =>
        item.startsWith(`nested session cleanup ${owned.sessionName}:`),
      )
    )
      failures.push(
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
    if (
      !deleted &&
      !failures.some((item) => item.startsWith("nested session remains"))
    )
      failures.push(
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
  }
  if (owned.hostTabId) {
    try {
      await cleanupHerdr(["tab", "close", owned.hostTabId]);
    } catch (error) {
      failures.push(`host tab ${owned.hostTabId}: ${error.message}`);
    }
  }
  const sessionMayRemain =
    owned.sessionName &&
    failures.some(
      (item) => item.includes(owned.sessionName) && item.includes("cleanup"),
    );
  if (
    !sessionMayRemain &&
    !failures.some((failure) => failure.startsWith("nested session remains"))
  ) {
    try {
      await rm(paths.root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`temporary state: ${error.message}`);
    }
  }
  return failures.length ? failures.join("\n") : null;
}

function cleanupEvidence(owned) {
  return `session=${owned.sessionName ?? "not-created"} host-tab=${owned.hostTabId ?? "not-created"} host-pane=${owned.hostPaneId ?? "not-created"}`;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  const pkg = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const preflightEvidence = await preflight(pkg);
  const model = await resolveSmokeModel(args.model);
  const scenario = args.scenario;
  await run("npm", ["run", "build"], { cwd: repoRoot });
  const paths = await createIsolation();
  const owned = {};
  const ctx = {
    repoRoot,
    candidateExtension: join(repoRoot, "dist", "index.js"),
    herdrStateExtension: paths.herdrStateExtension,
    ...(scenario === "chief-tree"
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
    managerReadyTimeoutMs:
      args.managerReadyTimeoutMs ?? DEFAULT_MANAGER_READY_TIMEOUT_MS,
    managerRecoveryDiagnostics: args.managerRecoveryDiagnostics,
    expectedPackage: `${pkg.name}@${pkg.version}`,
    owned,
    preflight: preflightEvidence,
  };
  ctx.initialPrompt = initialPromptForScenario(scenario, ctx);
  let failure;
  try {
    ctx.rootCwd =
      scenario === "manager-recovery"
        ? await prepareManagerRepository(paths)
        : repoRoot;
    if (scenario === "manager-recovery") {
      ctx.primaryCheckoutPath = ctx.rootCwd;
    }
    ctx.authMechanism = await preparePi(paths, model);
    await prepareHerdr(paths);
    if (ctx.chiefTreeProbeExtension)
      await writeFile(
        ctx.chiefTreeProbeExtension,
        chiefTreeProbeSource(ctx.chiefTreeResultFile),
        { flag: "wx" },
      );
    await startNestedHerdr(
      paths,
      owned,
      ctx.rootCwd,
      ctx.managerRecoveryDiagnostics,
    );
    ctx.sessionName = owned.sessionName;
    await waitForNestedHerdr(ctx);
    ctx.rootPaneId = await startCandidate(ctx);
    await runScenario(ctx, scenario);
    console.log(`smoke ${scenario}: PASS`);
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
    if (scenario === "manager-recovery")
      console.log(`manager-recovery: ${JSON.stringify(ctx.managerRecovery)}`);
    console.log(`authentication: ${ctx.authMechanism}`);
  } catch (error) {
    failure = error;
    console.error(
      `smoke ${scenario}: FAIL\n${formatSmokeFailure(error, ctx.stage)}`,
    );
    try {
      await collectDiagnostics(ctx, owned, error);
    } catch (diagnosticError) {
      console.error(
        `diagnostics: collection failed: ${
          diagnosticError?.message ?? diagnosticError
        }`,
      );
    }
  } finally {
    const cleanupError = await cleanup(paths, owned, ctx);
    if (cleanupError) {
      console.error(`cleanup: FAIL ${cleanupEvidence(owned)}\n${cleanupError}`);
      process.exitCode = 1;
    } else {
      console.log(`cleanup: PASS ${cleanupEvidence(owned)}`);
    }
    if (failure) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--nested-host") nestedHost(process.argv.slice(3));
  else await main();
}
