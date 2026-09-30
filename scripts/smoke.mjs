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
    if (safe && !seen.has(safe.event) && seen.size < 16) {
      seen.add(safe.event);
      safeLines.push(
        `${MANAGER_DIAGNOSTIC_PREFIX}${JSON.stringify(safe)}`.slice(0, 512),
      );
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
  } catch {}
}

export function formatSmokeFailure(error, stage) {
  const name = typeof error?.name === "string" ? error.name : typeof error;
  const message =
    typeof error?.message === "string" ? error.message : String(error);
  return `stage: ${stage ?? "not recorded"}\nerror: ${name}: ${message}`;
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
  return `import { appendFile } from "node:fs/promises";
const resultPath = ${JSON.stringify(resultPath)};
export default function (pi) {
  async function record(label) {
    await appendFile(resultPath, JSON.stringify({ label, tools: [...pi.getActiveTools()].sort() }) + "\\n");
  }
  pi.registerCommand("smoke-tools", {
    description: "Record active tools for isolated smoke",
    handler: async (args) => {
      if (args === "lead" || args === "chief") await record(args);
    },
  });
  pi.on("session_tree", async () => { await record("tree"); });
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
    assert.ok(!snapshots.has(label));
    snapshots.set(label, [...tools].sort());
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

export function staffDelegateResults(contents) {
  return sessionEntries(contents).flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "staff_delegate" ||
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

export function staffCloseResults(contents) {
  return sessionEntries(contents).flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "staff_close" ||
      message.isError
    )
      return [];
    // staff_close reports human-readable content; Pi persists its structured details.
    const value = message.details;
    return value?.ok === true && value.action === "close" ? [value] : [];
  });
}

export function hasManagerResultRef(contents, assignmentId) {
  const resultRef = `Result ref: result:${assignmentId}`;
  return sessionEntries(contents).some(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-report_result" &&
      messageText(entry.content).includes(resultRef),
  );
}

export function managerSourceCheckout(workspaceId, workspace, topology) {
  const membership = workspace?.worktree;
  assert.ok(
    typeof membership?.repo_key === "string" && membership.repo_key,
    `workspace ${workspaceId} is not in a Herdr Git worktree group`,
  );
  assert.equal(
    topology?.source?.repo_key,
    membership.repo_key,
    `worktree-group topology does not match workspace ${workspaceId}`,
  );
  const sourceCheckoutPath = topology?.source?.source_checkout_path;
  assert.ok(
    typeof sourceCheckoutPath === "string" &&
      sourceCheckoutPath.length > 0 &&
      isAbsolute(sourceCheckoutPath),
    "Herdr primary checkout path is unavailable",
  );
  return resolve(sourceCheckoutPath);
}

export function managerWorktreeOpenArgs(workspaceId, primaryCheckoutPath) {
  assert.ok(workspaceId, "isolated root workspace ID is required");
  assert.ok(
    isAbsolute(primaryCheckoutPath),
    "primary checkout path must be absolute",
  );
  return [
    "worktree",
    "open",
    "--workspace",
    workspaceId,
    "--path",
    primaryCheckoutPath,
    "--no-focus",
  ];
}

export function assertManagerOpenedPrimary(
  workspaceId,
  primaryCheckoutPath,
  workspace,
  topology,
) {
  assert.equal(workspace?.workspace_id, workspaceId);
  const membership = workspace?.worktree;
  assert.equal(
    membership?.is_linked_worktree,
    false,
    "isolated root workspace is not the primary checkout",
  );
  assert.equal(
    membership?.checkout_path && resolve(membership.checkout_path),
    primaryCheckoutPath,
  );
  assert.equal(membership?.repo_key, topology?.source?.repo_key);
  assert.equal(topology?.source?.source_workspace_id, workspaceId);
  const sourceCheckoutPath = topology?.source?.source_checkout_path;
  assert.ok(
    typeof sourceCheckoutPath === "string" &&
      sourceCheckoutPath.length > 0 &&
      isAbsolute(sourceCheckoutPath),
    "worktree source checkout path must be a non-empty absolute path",
  );
  assert.equal(resolve(sourceCheckoutPath), primaryCheckoutPath);
}

export async function deleteBranchIfPresent(branch, execute = run) {
  try {
    await execute(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoRoot },
    );
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
  await execute("git", ["branch", "-D", branch], { cwd: repoRoot });
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
            block.name === "supervisor_message" &&
            block.arguments?.message === text,
        )
      : [],
  );
  return calls.some((call) =>
    entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "supervisor_message" &&
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
              block.name === "supervisor_message" &&
              block.arguments?.message === text,
          )
          .map((block) => ({ id: block.id, index }))
      : [],
  );
  const resultIndex = entries.findIndex(
    (entry, index) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "supervisor_message" &&
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

export function managerReadyAnswer(contents, leadSessionId) {
  const entries = sessionEntries(contents);
  const rootSessionId = entries.find((entry) => entry.type === "session")?.id;
  const receipt = entries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-lead_message" &&
      entry.content ===
        `From lead ${leadSessionId} to chief ${rootSessionId}: MANAGER_RECOVERY_READY`,
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
  const answer =
    receipt < 0
      ? null
      : readyMarkers.find(
          ({ entry, index }) =>
            index > receipt && entry.message.stopReason === "stop",
        )?.entry;
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
          block.name === "staff_message" &&
          block.arguments?.message === "MANAGER_RECOVERY_FINISH",
      ),
  );
  return {
    receipt: receipt >= 0,
    answer: answer ?? null,
    prematureReady,
    prematureFinish,
  };
}

export function managerReadyEntryEvidence(contents, leadSessionId) {
  const entries = sessionEntries(contents);
  const rootId = entries.find((entry) => entry.type === "session")?.id;
  const receiptText = `From lead ${leadSessionId} to chief ${rootId}: MANAGER_RECOVERY_READY`;
  const receipts = [];
  const markers = [];
  entries.forEach((entry, index) => {
    if (
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-lead_message" &&
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
      message.toolName !== "agent_continue" ||
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
          block.name === "agent_continue" &&
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

function json(output) {
  const text = output.trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error("Herdr did not return JSON");
  return JSON.parse(text.slice(start));
}

function resultOf(value) {
  return value?.result ?? value;
}

async function herdr(args, options = {}) {
  const { stdout } = await run("herdr", args, options);
  return json(stdout);
}

async function tryHerdr(args, options = {}) {
  try {
    return { ok: true, value: await herdr(args, options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function preflight() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID)
    throw new Error("smoke must run from a Herdr-managed Pi session");
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
  const result = resultOf(host);
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

export async function nestedPaneInput(ctx, args, execute = run) {
  return execute("herdr", args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
}

export async function nestedPaneText(ctx, paneId, source, execute = run) {
  const { stdout } = await nestedPaneInput(
    ctx,
    ["pane", "read", paneId, "--source", source, "--lines", "120"],
    execute,
  );
  return stdout;
}

export async function submitPaneCommand(ctx, paneId, command, execute = run) {
  await nestedPaneInput(ctx, ["pane", "send-text", paneId, command], execute);
  await nestedPaneInput(ctx, ["pane", "send-keys", paneId, "enter"], execute);
}

export async function submitManagerLeave(ctx, paneId, execute = run) {
  // pane run sends text and Enter in one ordered submission; never retry an ambiguous leave.
  return nestedPaneInput(
    ctx,
    ["pane", "run", paneId, "/manager leave"],
    execute,
  );
}

async function waitForNestedHerdr(ctx) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await tryHerdr(["pane", "list"], {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    });
    if (result.ok) return resultOf(result.value);
    await sleep(150);
  }
  throw new Error("nested Herdr session did not become ready");
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
  const result = resultOf(panes);
  const paneList = result.panes ?? result;
  const pane = Array.isArray(paneList)
    ? paneList.find(
        (item) =>
          resolve(item.cwd ?? item.working_directory ?? "") === ctx.rootCwd,
      )
    : undefined;
  const paneId = pane?.pane_id ?? pane?.id;
  assert.ok(paneId, "nested primary pane ID was not found");
  assert.ok(pane.workspace_id, "nested primary workspace ID was not found");
  ctx.rootWorkspaceId = pane.workspace_id;
  assert.equal(resolve(pane.cwd ?? pane.working_directory), ctx.rootCwd);
  ctx.rootPaneId = paneId;
  const prompt = ctx.initialPrompt;
  assert.equal(
    typeof prompt,
    "string",
    "candidate initial prompt must be selected before startup",
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
    ["pane", "run", paneId, shellCommand(["pi", ...args, prompt])],
    {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = resultOf(
      await nestedCommand(ctx, ["pane", "process-info", "--pane", paneId]),
    );
    if (
      candidateProcess(info, ctx.candidateExtension, ctx.herdrStateExtension)
        .length
    )
      return paneId;
    await sleep(200);
  }
  throw new Error("candidate Pi did not start with both explicit extensions");
}

function corePrompt(expected) {
  return `Delegate this task to one implementer.\n\nDo not read package.json yourself. The implementer must delegate exactly one scout to read package.json and determine its exact "name" and "version". The implementer must return that result to you.\n\nWhen the delegated work is complete, output exactly:\n\nPI_HERDSMAN_SMOKE_OK ${expected}\n\nDo not output that marker before the implementer reports its result.`;
}

function continuationPrompt() {
  return `Delegate exactly one bounded task to an implementer: read package.json, remember its exact package name, and return only CONTINUATION_FIRST_DONE. After that result reaches you, output exactly PI_HERDSMAN_CONTINUATION_FIRST. Do not read package.json yourself.`;
}

export function managerRecoveryFreshPrompt(branch) {
  return `Use staff_delegate exactly once to start new project work. Set its \`task\` argument to the delegated task below and its \`branch\` argument to exactly ${branch}. Omit \`base\` and \`files\`.\n\nThe delegated task is:\n- do not modify any files;\n- immediately call supervisor_message with exactly MANAGER_RECOVERY_READY;\n- then end the turn and wait;\n- do not call supervisor_result until the Manager later sends exactly MANAGER_RECOVERY_FINISH via staff_message;\n- after that message, call supervisor_result with exactly MANAGER_RECOVERY_DONE.\n\nManager handshake: after staff_delegate returns, end this turn immediately. Do not call any other tool, output any recovery marker, or send any staff_message. Wait until the exact MANAGER_RECOVERY_READY message from this Lead is delivered into your conversation; do not infer delivery from the delegate result, a Lead transcript, or other evidence. Only after that delivered message, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_READY and end the turn. Do not send MANAGER_RECOVERY_FINISH; the later recovery prompt is the only instruction to do so.`;
}

export function managerRecoveryResumePrompt(branch, session) {
  return `Resume the existing work on branch ${branch}.\n\nCall staff_delegate using only:\n${JSON.stringify({ branch })}\n\nDo not start new work or supply task, base, or files.\n\nAfter recovery succeeds, send staff_message to session ${session} with exactly MANAGER_RECOVERY_FINISH.\n\nThen wait for that Lead's project result. Only after the result arrives, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_OK.`;
}

export function managerRecoveryClosePrompt(session) {
  return `Pause the existing project work.\n\nCall staff_close exactly once using only:\n${JSON.stringify({ session })}\n\nDo not call any other tool.\n\nAfter staff_close succeeds, reply exactly:\nPI_HERDSMAN_MANAGER_RECOVERY_PAUSED`;
}

export function managerRecoveryResumeOnlyPrompt(branch) {
  return `Resume the existing project work.\n\nCall staff_delegate exactly once using only:\n${JSON.stringify({ branch })}\n\nDo not supply task, base, or files.\nDo not call any other tool.\n\nAfter staff_delegate succeeds, reply exactly:\nPI_HERDSMAN_MANAGER_RECOVERY_RESUMED`;
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
      return "Reply exactly with PI_HERDSMAN_MANAGER_RECOVERY_STARTUP.";
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

export async function runScenario(ctx, scenario) {
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

function candidateProcess(processInfo, extension, integration) {
  return (processInfo?.process_info?.foreground_processes ?? []).filter(
    (proc) => {
      const argv = Array.isArray(proc.argv) ? proc.argv.join("\0") : "";
      const cmdline = typeof proc.cmdline === "string" ? proc.cmdline : "";
      return [argv, cmdline].some(
        (line) => line.includes(extension) && line.includes(integration),
      );
    },
  );
}

export function listedPanes(value) {
  const result = resultOf(value);
  const panes = Array.isArray(result)
    ? result
    : (result?.panes ?? result?.result?.panes ?? []);
  return panes.flatMap((pane) => {
    const paneId = pane?.pane_id ?? pane?.id;
    return typeof paneId === "string" && paneId ? [{ paneId }] : [];
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
      panes.map((pane) =>
        typeof pane === "string"
          ? pane
          : (pane.paneId ?? pane.pane_id ?? pane.id),
      ),
    ),
  ].filter((paneId) => paneId && paneId !== rootPaneId);
  const inspected = await Promise.all(
    paneIds.map(async (paneId) => {
      try {
        return { paneId, info: resultOf(await inspect(paneId)) };
      } catch (error) {
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
    return processes.map((proc) => ({
      paneId,
      pid: proc.pid ?? null,
      processMatch:
        candidateProcess(
          { process_info: { foreground_processes: [proc] } },
          extension,
          integration,
        ).length > 0,
      error: null,
    }));
  });
  const verified = new Map();
  for (const record of records) {
    if (record.processMatch && record.pid != null)
      verified.set(`${record.paneId}\0${record.pid}`, record);
  }
  return { records, verified: [...verified.values()] };
}

async function inspectCandidateProcesses(ctx) {
  const listed = await nestedCommand(ctx, ["pane", "list"]);
  return inspectPaneProcesses(
    listedPanes(listed),
    ctx.rootPaneId,
    (paneId) => nestedCommand(ctx, ["pane", "process-info", "--pane", paneId]),
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
}

async function rootSessionSnapshot(ctx) {
  const listed = resultOf(await nestedCommand(ctx, ["agent", "list"]));
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
  const deadline = Date.now() + 6 * 60_000;
  const marker = `PI_HERDSMAN_SMOKE_OK ${ctx.expectedPackage}`;
  const observed = new Map();
  let sawRootSession = false;
  while (Date.now() < deadline) {
    const inspection = await inspectCandidateProcesses(ctx);
    for (const item of inspection.verified) {
      observed.set(`${item.paneId}\0${item.pid}`, item);
    }
    ctx.coreProcessEvidence = [...observed.values()].slice(-40);
    ctx.coreProcessDiagnostics = inspection.records.slice(0, 40);
    const session = await rootSessionSnapshot(ctx);
    if (session) {
      sawRootSession = true;
      ctx.rootSessionPath = session.path;
      const assistantResult = assistantResultForSession(
        session,
        ctx.initialPrompt,
        marker,
      );
      if (assistantResult) ctx.assistantResult = assistantResult;
    }
    const paneCount = distinctPaneCount([...observed.values()]);
    if (ctx.assistantResult && paneCount >= 2) {
      ctx.descendantCount = paneCount;
      await waitForDescendantsToExit(ctx);
      return;
    }
    if (!sawRootSession && Date.now() > deadline - 5.5 * 60_000)
      throw new Error(
        "waiting-for-root-session: no saved Pi session identity appeared for the candidate root",
      );
    await sleep(250);
  }
  if (!sawRootSession)
    throw new Error(
      "waiting-for-root-session: candidate root did not save a Pi session",
    );
  const paneCount = distinctPaneCount([...observed.values()]);
  if (ctx.assistantResult && paneCount < 2)
    throw new Error(
      `waiting-for-descendant-processes: expected two distinct panes with both extensions; observed ${paneCount}`,
    );
  throw new Error(
    "waiting-for-assistant-result: saved candidate session had no completed assistant response with the expected marker",
  );
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
    const listed = resultOf(await nestedCommand(ctx, ["agent", "list"]));
    return (listed.agents ?? []).filter(
      (agent) => agent.pane_id && agent.pane_id !== ctx.rootPaneId,
    );
  };

  const promptRoot = async (prompt) => {
    await nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  };

  while (Date.now() < deadline && !firstSession) {
    const agents = await childAgents();
    if (agents.length > 1)
      throw new Error(
        `continuation-first-generation: expected one managed Agent, observed ${agents.length}`,
      );
    for (const agent of agents) {
      const session = await isolatedSessionDetails(ctx, agent).catch(
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (session) {
        firstSession = { ...session, paneId: agent.pane_id };
        const info = resultOf(
          await nestedCommand(ctx, [
            "pane",
            "process-info",
            "--pane",
            agent.pane_id,
          ]),
        );
        for (const proc of candidateProcess(
          info,
          ctx.candidateExtension,
          ctx.herdrStateExtension,
        ))
          if (proc.pid != null) firstPids.add(proc.pid);
        break;
      }
    }
    if (!firstSession) await sleep(200);
  }
  if (!firstSession)
    throw new Error(
      "continuation-first-generation: no persisted managed Pi session was observed",
    );
  if (!firstPids.size)
    throw new Error(
      "continuation-first-generation: no candidate process identity was observed",
    );

  const firstResult = new Map();
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    if (session) {
      const result = assistantResultForSession(
        session,
        firstPrompt,
        firstMarker,
      );
      if (result) {
        firstResult.set("result", result);
        break;
      }
    }
    await sleep(250);
  }
  if (!firstResult.size)
    throw new Error(
      "continuation-first-result: root did not receive the first delegated result",
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

  const firstExitDeadline = Date.now() + 60_000;
  while (Date.now() < firstExitDeadline) {
    const panes = listedPanes(await nestedCommand(ctx, ["pane", "list"]));
    const firstPaneExists = panes.some(
      (pane) => pane.paneId === firstSession.paneId,
    );
    if (!firstPaneExists) break;
    await sleep(300);
  }
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
  let followupSubmitted = false;
  while (Date.now() < deadline) {
    if (!followupSubmitted) {
      await promptRoot(followup);
      followupSubmitted = true;
    }
    const agents = await childAgents();
    for (const agent of agents) {
      const session = await isolatedSessionDetails(ctx, agent).catch(
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (session?.path !== firstSession.path || session.id !== firstSession.id)
        continue;
      const info = resultOf(
        await nestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          agent.pane_id,
        ]),
      );
      const matches = candidateProcess(
        info,
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
    if (firstGeneration !== undefined) break;
    await sleep(200);
  }
  if (firstGeneration === undefined)
    throw new Error(
      "continuation-second-generation: no new candidate process used the exact saved session",
    );

  while (Date.now() < deadline) {
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
      return;
    }
    await sleep(250);
  }
  throw new Error(
    "continuation-follow-up: no completed root response proved the persisted context and result",
  );
}

async function runManagerRecoverySmoke(ctx) {
  const deadline = Date.now() + 6 * 60_000;
  const branch = `herdsman/smoke-manager-recovery-${randomUUID()}`;
  ctx.managerRecovery = {
    branch,
    leadReadyTimeoutMs: ctx.managerReadyTimeoutMs,
  };
  const markStage = (stage) => {
    ctx.managerRecovery.stage = stage;
  };
  ctx.owned.managerBranch = branch;
  const startupMarker = "PI_HERDSMAN_MANAGER_RECOVERY_STARTUP";
  const rootSnapshot = async () => rootSessionSnapshot(ctx);
  const promptRoot = (prompt) =>
    nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  const agents = async () =>
    resultOf(await nestedCommand(ctx, ["agent", "list"])).agents ?? [];
  const worktrees = async () => {
    const result = resultOf(
      await nestedCommand(ctx, [
        "worktree",
        "list",
        "--workspace",
        ctx.rootWorkspaceId,
      ]),
    );
    return result.worktrees ?? [];
  };
  const primaryPath = ctx.primaryCheckoutPath;
  const opened = resultOf(
    await nestedCommand(
      ctx,
      managerWorktreeOpenArgs(ctx.rootWorkspaceId, primaryPath),
    ),
  );
  assert.equal(opened.workspace?.workspace_id, ctx.rootWorkspaceId);
  assert.equal(
    opened.worktree?.path && resolve(opened.worktree.path),
    primaryPath,
  );
  assert.equal(opened.worktree?.is_linked_worktree, false);
  const rootWorkspace = resultOf(
    await nestedCommand(ctx, ["workspace", "get", ctx.rootWorkspaceId]),
  ).workspace;
  const rootTopology = resultOf(
    await nestedCommand(ctx, [
      "worktree",
      "list",
      "--workspace",
      ctx.rootWorkspaceId,
    ]),
  );
  assertManagerOpenedPrimary(
    ctx.rootWorkspaceId,
    primaryPath,
    rootWorkspace,
    rootTopology,
  );
  assert.equal(
    opened.workspace.worktree?.repo_key,
    rootTopology.source.repo_key,
  );
  assert.equal(
    resolve(opened.workspace.worktree?.checkout_path ?? ""),
    primaryPath,
  );
  assert.equal(opened.workspace.worktree?.is_linked_worktree, false);
  const matchingWorktrees = async () =>
    (await worktrees()).filter((item) => item.branch === branch);
  const paneInfo = (paneId) =>
    nestedCommand(ctx, ["pane", "process-info", "--pane", paneId]);
  const paneExists = async (paneId) =>
    listedPanes(await nestedCommand(ctx, ["pane", "list"])).some(
      (pane) => pane.paneId === paneId,
    );
  const candidatePids = async (paneId) => {
    const info = resultOf(await paneInfo(paneId));
    return candidateProcess(
      info,
      ctx.candidateExtension,
      ctx.herdrStateExtension,
    )
      .map((proc) => proc.pid)
      .filter((pid) => pid != null);
  };
  const waitFor = async (label, inspect, timeout = 6 * 60_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await inspect();
      if (value) return value;
      await sleep(250);
    }
    if (label === "ready") {
      ctx.managerRecovery.readyEvidence ??= {};
      try {
        const session = await rootSnapshot();
        const results = session ? staffDelegateResults(session.contents) : [];
        const evidence = ctx.managerRecovery.readyEvidence;
        evidence.entries = session
          ? managerReadyEntryEvidence(session.contents, results[0]?.session)
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
                    await nestedPaneText(ctx, lead.pane_id, "recent-unwrapped"),
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
    throw new Error(
      `manager-recovery-${label}: timed out${label === "ready" ? `; last READY evidence: ${JSON.stringify(ctx.managerRecovery.readyEvidence ?? null)}` : ""}`,
    );
  };

  markStage("startup-marker");
  await waitFor("startup", async () => {
    const session = await rootSnapshot();
    return (
      session &&
      assistantResultForSession(session, ctx.initialPrompt, startupMarker)
    );
  });
  markStage("manager-mode-command");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  markStage("manager-mode-active-wait");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode active.",
    "--timeout",
    "15000",
  ]);

  const prompt = managerRecoveryFreshPrompt(branch);
  markStage("fresh-delegation");
  await promptRoot(prompt);
  markStage("lead-ready-handshake");
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
      const { receipt, answer, prematureReady, prematureFinish } =
        session && results.length === 1
          ? managerReadyAnswer(session.contents, results[0].session)
          : {
              receipt: false,
              answer: null,
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
                  entry.customType === "pi-herdsman-lead_message",
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
        answer &&
        !prematureReady &&
        !prematureFinish
        ? { results, answer, child }
        : null;
    },
    ctx.managerReadyTimeoutMs ?? DEFAULT_MANAGER_READY_TIMEOUT_MS,
  );
  const first = ready.results[0];
  await captureManagerLeadDiagnostics(ctx, ready.child.pane_id);
  markStage("initial-assignment-validation");
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
  markStage("initial-topology-validation");
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
  const placement = resultOf(await paneInfo(paneId));
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
  const pane = (
    resultOf(await nestedCommand(ctx, ["pane", "list"])).panes ?? []
  ).find((item) => (item.pane_id ?? item.id) === paneId);
  assert.ok(pane, "child pane placement was not listed");
  assert.equal(pane.workspace_id, workspaceId);
  assert.equal(
    resolve(pane.cwd ?? pane.working_directory),
    resolve(worktreePath),
  );
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
    hash(ctx.rootWorkspaceId),
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
  markStage("initial-assignment-validation");
  const initialAssignmentBytes = await assignmentBytes();
  const record = JSON.parse(initialAssignmentBytes);
  assert.equal(record.id, first.session);
  assert.equal(record.branch, branch);
  assert.deepEqual(
    Object.keys(record).sort(),
    ["branch", "id", "repoKey", "text", "version"].sort(),
  );
  const assertUnchangedAssignment = async () =>
    assert.equal(
      await assignmentBytes(),
      initialAssignmentBytes,
      "runtime recovery must not mutate durable project intent",
    );
  const closePrompt = managerRecoveryClosePrompt(first.session);
  markStage("graceful-close");
  await promptRoot(closePrompt);
  await waitFor(
    "graceful-close",
    async () => {
      const session = await rootSnapshot();
      if (!session) return null;
      const closes = staffCloseResults(session.contents);
      if (closes.length !== 1) return null;
      const close = closes[0];
      if (
        close.session !== first.session ||
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
  markStage("graceful-close-validation");
  await assertUnchangedAssignment();
  assert.ok(
    await paneExists(paneId),
    "staff_close removed the preserved assignment pane",
  );
  const pausedWorktrees = await matchingWorktrees();
  assert.equal(pausedWorktrees.length, 1);
  assert.equal(
    pausedWorktrees[0].path ?? pausedWorktrees[0].worktree_path,
    worktreePath,
  );

  const resumePrompt = managerRecoveryResumeOnlyPrompt(branch);
  markStage("graceful-resume");
  await promptRoot(resumePrompt);
  const resumed = await waitFor("graceful-resume", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    const results = staffDelegateResults(session.contents);
    if (
      results.length !== 2 ||
      !assistantResultForSession(
        session,
        resumePrompt,
        "PI_HERDSMAN_MANAGER_RECOVERY_RESUMED",
      )
    )
      return null;
    return results[1];
  });
  markStage("graceful-resume-validation");
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
  const resumedPane = (
    resultOf(await nestedCommand(ctx, ["pane", "list"])).panes ?? []
  ).find((item) => (item.pane_id ?? item.id) === paneId);
  assert.ok(resumedPane);
  assert.equal(resumedPane.workspace_id, workspaceId);
  assert.equal(resumedPane.tab_id, ctx.managerRecovery.tabId);
  assert.equal(
    resolve(resumedPane.cwd ?? resumedPane.working_directory),
    resolve(worktreePath),
  );
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
        resultOf(await paneInfo(paneId)),
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
  markStage("manager-turnover-leave");
  await submitManagerLeave(ctx, ctx.rootPaneId);
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
  await assertUnchangedAssignment();
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
  markStage("manager-turnover-reenter");
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
  const beforeKillInfo = resultOf(await paneInfo(paneId));
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
  markStage("executor-loss-verification");
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

  const recoveryPrompt = managerRecoveryResumePrompt(branch, first.session);
  markStage("assignment-recovery");
  await promptRoot(recoveryPrompt);
  markStage("recovered-identity-validation");
  const recovery = await waitFor("recovery", async () => {
    const session = await rootSnapshot();
    const results = session && staffDelegateResults(session.contents);
    return results?.length === 3 ? { session, results } : null;
  });
  const recovered = recovery.results[2];
  assert.equal(recovered.session, first.session);
  assert.equal(recovered.branch, first.branch);
  assert.equal(recovered.workspace_id, workspaceId);
  assert.equal(recovery.results.length, 3);
  const afterWorktrees = await matchingWorktrees();
  assert.equal(afterWorktrees.length, 1);
  assert.equal(
    afterWorktrees[0].path ?? afterWorktrees[0].worktree_path,
    worktreePath,
  );
  const recoveredAgent = (await agents()).find(
    (agent) => agent.pane_id === paneId,
  );
  assert.ok(recoveredAgent);
  assert.equal(await agentSessionId(ctx, recoveredAgent), first.session);
  assert.equal(recoveredAgent.workspace_id, workspaceId);
  const recoveredPane = (
    resultOf(await nestedCommand(ctx, ["pane", "list"])).panes ?? []
  ).find((item) => (item.pane_id ?? item.id) === paneId);
  assert.ok(recoveredPane);
  assert.equal(recoveredPane.workspace_id, workspaceId);
  assert.equal(recoveredPane.tab_id, ctx.managerRecovery.tabId);
  assert.equal(
    resolve(recoveredPane.cwd ?? recoveredPane.working_directory),
    resolve(worktreePath),
  );
  const recoveredProcesses = await waitFor("new-pid", async () => {
    const processes = candidateProcess(
      resultOf(await paneInfo(paneId)),
      ctx.candidateExtension,
      ctx.herdrStateExtension,
    );
    return processes.length === 1 && processes[0].pid !== resumedPid
      ? processes
      : null;
  });
  const recoveredPid = recoveredProcesses[0].pid;
  assert.notEqual(recoveredPid, initialPid);
  assert.notEqual(recoveredPid, resumedPid);
  ctx.managerRecovery.recoveredPid = recoveredPid;
  await assertUnchangedAssignment();

  const finalMarker = "PI_HERDSMAN_MANAGER_RECOVERY_OK";
  markStage("completion-marker");
  const completed = await waitFor("completion", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    const assistant = assistantResultsForPrompt(
      session.contents,
      recoveryPrompt,
      finalMarker,
      (text, marker) =>
        text.split(/\r?\n/).some((line) => line.trim() === marker),
    )[0];
    return assistant ? session : null;
  });
  markStage("final-transcript-assertions");
  assert.equal(staffDelegateResults(completed.contents).length, 3);
  assert.equal((await matchingWorktrees()).length, 1);
  assert.ok(
    hasManagerResultRef(completed.contents, first.session),
    "Manager transcript omitted canonical result ref",
  );
  assert.ok(completed.contents.includes("MANAGER_RECOVERY_DONE"));
  const resultPath = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "results",
    first.session,
  );
  const assertResult = async () => {
    const details = await lstat(resultPath);
    assert.ok(details.isFile() && !details.isSymbolicLink());
    assert.ok(details.size <= MAX_SESSION_BYTES);
    assert.match(await readFile(resultPath, "utf8"), /MANAGER_RECOVERY_DONE/);
  };
  markStage("pre-leave-result-validation");
  await assertResult();
  ctx.managerRecovery.resultRef = `result:${first.session}`;
  markStage("settled-assignment-validation");
  await assert.rejects(lstat(assignmentPath), { code: "ENOENT" });
  markStage("manager-leave-command-submission");
  await submitManagerLeave(ctx, ctx.rootPaneId);
  markStage("manager-leave-output-wait");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode left.",
    "--timeout",
    "15000",
  ]);
  markStage("post-leave-result-validation");
  await assertResult();
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
    const response = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.parentId === prompt?.id &&
        entry.message.stopReason === "stop" &&
        messageText(entry.message.content)
          .split(/\r?\n/)
          .some((line) => line.trim() === "PI_HERDSMAN_CHIEF_TREE_STARTUP"),
    );
    return prompt && response ? { prompt, response } : null;
  };

  // Establish the exact pre-Chief assistant branch before changing roles.
  let startup;
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    startup = session && startupTurn(session);
    if (startup) break;
    await sleep(250);
  }
  if (!startup)
    throw new Error(
      "chief-tree-startup: candidate did not complete the ordinary Lead startup exchange",
    );

  const awaitSnapshot = async (label) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      try {
        const details = await lstat(ctx.chiefTreeResultFile);
        if (
          !details.isFile() ||
          details.isSymbolicLink() ||
          details.size > MAX_CHIEF_TREE_RESULT_BYTES
        )
          throw new Error(
            "chief-tree-probe: result path is not a bounded regular file",
          );
        const snapshots = parseToolSnapshots(
          await readFile(ctx.chiefTreeResultFile, "utf8"),
        );
        if (snapshots.has(label)) return snapshots;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await sleep(200);
    }
    throw new Error(`chief-tree-probe: missing ${label} tool snapshot`);
  };
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
  let branchPlan;
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    if (session) {
      branchPlan = chiefTreeBranchPlan(
        session.contents,
        ctx.initialPrompt,
        "PI_HERDSMAN_CHIEF_TREE_STARTUP",
        chiefPrompt,
        "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      );
      if (!branchPlan.error) break;
    }
    await sleep(250);
  }
  if (!branchPlan || branchPlan.error)
    throw new Error(
      `chief-tree-branch: ${branchPlan?.error ?? "no completed post-Chief turn was persisted"}`,
    );
  ctx.chiefTreeBranchPlan = branchPlan;

  await submitPaneCommand(ctx, ctx.rootPaneId, "/tree");
  const treeDeadline = Date.now() + 5_000;
  let footer;
  let treeText;
  while (Date.now() < treeDeadline) {
    treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
    footer = chiefTreeFooter(treeText);
    if (
      footer &&
      chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF")
    )
      break;
    await sleep(150);
  }
  if (
    !footer ||
    !chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF")
  )
    throw new Error(
      "chief-tree-selection: /tree did not show the post-Chief response selected with a valid footer",
    );

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
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "up"]);
  }
  if (!startupSelected)
    throw new Error(
      `chief-tree-selection: startup answer was not selected after checking ${footer.total} tree rows; Enter was not sent`,
    );
  await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);
  // Pi may ask whether to summarize the selected branch; its first choice is No summary.
  const summaryDialog = await tryHerdr(
    [
      "pane",
      "wait-output",
      ctx.rootPaneId,
      "--match",
      "Summarize branch?",
      "--timeout",
      "1200",
    ],
    {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    },
  );
  if (summaryDialog.ok)
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);

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
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    if (
      session &&
      assistantResultForSession(
        session,
        followup,
        "PI_HERDSMAN_CHIEF_TREE_FOLLOWUP",
      )
    )
      return;
    await sleep(250);
  }
  throw new Error(
    "chief-tree-follow-up: Lead did not complete the follow-up action",
  );
}

async function waitForDescendantsToExit(ctx) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const inspection = await inspectCandidateProcesses(ctx);
    if (!inspection.verified.length) return;
    await sleep(500);
  }
  throw new Error(
    "candidate descendant processes did not disappear from non-root panes",
  );
}

async function collectDiagnostics(ctx, owned) {
  const diagnostics = {};
  const env = nestedControlEnv(process.env, ctx.paths, ctx.sessionName);
  diagnostics.chiefTreeProbe = ctx.chiefTreeProbeDiagnostics ?? null;
  diagnostics.managerRecovery = ctx.managerRecovery ?? null;
  diagnostics.continuationSession = ctx.continuationSessionEvidence ?? null;
  diagnostics.agents = await tryHerdr(["agent", "list"], { env });
  diagnostics.panes = await tryHerdr(["pane", "list"], { env });
  diagnostics.observedCoreProcesses = ctx.coreProcessEvidence ?? [];
  diagnostics.coreProcessDiagnostics = ctx.coreProcessDiagnostics ?? [];
  const processDiagnostics = await inspectPaneProcesses(
    listedPanes(diagnostics.panes.value),
    ctx.rootPaneId,
    async (paneId) => {
      const result = await tryHerdr(
        ["pane", "process-info", "--pane", paneId],
        { env },
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  diagnostics.processes = processDiagnostics.records.slice(0, 40);
  try {
    const session = await rootSessionSnapshot(ctx);
    diagnostics.rootSession = session
      ? {
          path: session.path,
          status: session.status,
          ...summarizeSession(session.contents),
        }
      : { error: "no saved root Pi session was available" };
  } catch (error) {
    diagnostics.rootSession = { error: error.message };
  }
  if (ctx.rootPaneId)
    diagnostics.root = await run(
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
      { env },
    ).catch((error) => ({ error: error.message }));
  if (owned.hostPaneId)
    diagnostics.host = await run(
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
      {},
    ).catch((error) => ({ error: error.message }));
  try {
    const serialized = JSON.stringify(diagnostics);
    console.error(`diagnostics: ${serialized}`);
  } catch {
    console.error("diagnostics: collection failed");
  }
}

async function cleanup(paths, owned, ctx) {
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
      let workspaceId = owned.managerWorkspaceId;
      const listed = resultOf(
        await herdr(["worktree", "list", "--workspace", ctx.rootWorkspaceId], {
          env: nestedControlEnv(process.env, paths, owned.sessionName),
        }),
      );
      if (!Array.isArray(listed.worktrees))
        throw new Error("Herdr worktree topology is unavailable");
      const worktrees = listed.worktrees;
      if (workspaceId) {
        const exactWorkspace = worktrees.filter(
          (item) => item.open_workspace_id === workspaceId,
        );
        const exactBranch = worktrees.filter(
          (item) => item.branch === owned.managerBranch,
        );
        if (
          exactWorkspace.length !== 1 ||
          exactBranch.length !== 1 ||
          exactWorkspace[0] !== exactBranch[0] ||
          (owned.managerWorktreePath &&
            exactWorkspace[0].path !== owned.managerWorktreePath)
        )
          throw new Error(
            "captured workspace no longer identifies the exact smoke branch and worktree path",
          );
      } else {
        const matches = worktrees.filter(
          (item) => item.branch === owned.managerBranch,
        );
        if (matches.length > 1)
          throw new Error("exact branch matches multiple worktrees");
        if (matches.length === 1) {
          if (
            owned.managerWorktreePath &&
            matches[0].path !== owned.managerWorktreePath
          )
            throw new Error(
              "exact branch worktree path does not match captured path",
            );
          workspaceId = matches[0].open_workspace_id;
          if (!workspaceId)
            throw new Error("exact branch worktree has no workspace identity");
        }
      }
      if (workspaceId) {
        const env = nestedControlEnv(process.env, paths, owned.sessionName);
        await herdr(["worktree", "remove", "--workspace", workspaceId], {
          env,
        });
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
        await deleteBranchIfPresent(owned.managerBranch);
      } catch (error) {
        failures.push(
          `manager branch ${owned.managerBranch}: ${error.message}`,
        );
      }
    }
  }
  if (owned.sessionName) {
    const env = nestedControlEnv(process.env, paths, owned.sessionName);
    await tryHerdr(["session", "stop", owned.sessionName, "--json"], { env });
    let deleted = false;
    for (let i = 0; i < 3 && !deleted; i++) {
      await tryHerdr(["session", "delete", owned.sessionName, "--json"], {
        env,
      });
      const sessions = await tryHerdr(["session", "list", "--json"], { env });
      const all = resultOf(sessions.value);
      const rows = Array.isArray(all) ? all : (all?.sessions ?? []);
      deleted =
        sessions.ok &&
        !rows.some((item) => (item.name ?? item.session) === owned.sessionName);
      if (!deleted) await sleep(300);
    }
    if (!deleted)
      failures.push(
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
  }
  if (owned.hostTabId) {
    try {
      await herdr(["tab", "close", owned.hostTabId]);
    } catch (error) {
      failures.push(`host tab ${owned.hostTabId}: ${error.message}`);
    }
  }
  if (
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
  preflight();
  const model = await resolveSmokeModel(args.model);
  const scenario = args.scenario;
  await run("npm", ["run", "build"], { cwd: repoRoot });
  const paths = await createIsolation();
  const owned = {};
  const pkg = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
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
  };
  ctx.rootCwd = repoRoot;
  ctx.initialPrompt = initialPromptForScenario(scenario, ctx);
  let failure;
  try {
    if (scenario === "manager-recovery") {
      const hostWorkspaceId = process.env.HERDR_WORKSPACE_ID;
      const hostWorkspace = resultOf(
        await herdr(["workspace", "get", hostWorkspaceId], {
          env: process.env,
        }),
      ).workspace;
      const hostTopology = resultOf(
        await herdr(["worktree", "list", "--workspace", hostWorkspaceId], {
          env: process.env,
        }),
      );
      ctx.primaryCheckoutPath = managerSourceCheckout(
        hostWorkspaceId,
        hostWorkspace,
        hostTopology,
      );
      ctx.rootCwd = ctx.primaryCheckoutPath;
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
      `smoke ${scenario}: FAIL\n${formatSmokeFailure(error, ctx.managerRecovery?.stage)}`,
    );
    await collectDiagnostics(ctx, owned);
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
