import {
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { claimProcessLock, ProcessLockOccupiedError } from "./lock.ts";
import { OperationError } from "./errors.ts";
import { herdsmanTempRoot } from "./tmp.ts";

export type HerdrRecord = Record<string, any>;
export type HerdrContext = {
  workspaceId: string;
  tabId?: string;
  paneId?: string;
};
export type PaneProcess = Readonly<{
  pane_id?: string;
  shell_pid: number;
  foreground_process_group_id: number;
  foreground_processes?: readonly Readonly<{
    pid?: number;
    argv0?: string;
    cmdline?: string;
  }>[];
}>;
export type ExpectedSession = {
  id?: string;
  path?: string;
};
export type StartedHerdrAgent = {
  herdrAgent: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string;
  createdTab: boolean;
  createdPane: boolean;
  sessionReference?: ExpectedSession;
  agent?: HerdrRecord;
  paneOwnership: Record<string, PaneProcess>;
  tabPaneOwnership: Record<string, PaneProcess>;
};

export class HerdrStartFailure extends Error {
  readonly cause: unknown;
  readonly stage: string;
  readonly attempt: StartedHerdrAgent;
  readonly retryAttempted: boolean;

  constructor(
    cause: unknown,
    stage: string,
    attempt: StartedHerdrAgent,
    retryAttempted = false,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.stage = stage;
    this.attempt = attempt;
    this.retryAttempted = retryAttempted;
  }
}

const SETTLE_TIMEOUT = 2_000;
const START_DIAGNOSTIC_TIMEOUT = 2_000;
const HERDR_START_TIMEOUT_MIN = 3_001;
const HERDR_START_TIMEOUT_MAX = 300_000;
export const STARTUP_TIMEOUT_MIN =
  HERDR_START_TIMEOUT_MIN + START_DIAGNOSTIC_TIMEOUT;
export const STARTUP_TIMEOUT_MAX = HERDR_START_TIMEOUT_MAX;
const STARTUP_TIMEOUT_DEFAULT =
  HERDR_START_TIMEOUT_MAX + START_DIAGNOSTIC_TIMEOUT;
const RAW_DIAGNOSTIC_BYTES = 8 * 1024;
const INSPECTION_LINES = 80;
const INSPECTION_OUTPUT_BYTES = 16 * 1024;
const MAX_FOREGROUND_PROCESSES = 8;
const MAX_PROCESS_ARGV0_BYTES = 256;
const MAX_PROCESS_CMDLINE_BYTES = 4 * 1024;
const POLL_INTERVAL = 75;
const INITIAL_RATIO = 0.65;
const AGENT_SPLIT_RATIO = 0.5;
const SHELLS = new Set(["bash", "dash", "fish", "ksh", "sh", "tcsh", "zsh"]);
const HERDR_AGENT_STATE_EXTENSION = join(
  getAgentDir(),
  "extensions",
  "herdr-agent-state.ts",
);
function error(operation: string, message: string, details?: unknown): never {
  throw new OperationError({
    category: "internal_failure",
    message,
    operation,
    rollbackOccurred: false,
    retryAttempted: false,
    ...(details && typeof details === "object"
      ? { details: details as Record<string, unknown> }
      : {}),
  });
}

function boundedUtf8Tail(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return {
    text: bytes.subarray(start).toString(),
    truncated: true,
  };
}

function boundedDiagnostic(value: string): string {
  return boundedUtf8Tail(value.trim(), RAW_DIAGNOSTIC_BYTES).text;
}

function boundedInspectionOutput(value: string): {
  text: string;
  truncated: boolean;
} {
  // Pi's ExecOptions has no maxBuffer, and herdr 0.8.2's agent.read schema
  // bounds lines but not bytes. This bounds returned evidence only; pi.exec
  // may still buffer a larger subprocess response before returning it.
  return boundedUtf8Tail(
    value.trim().split(/\r?\n/).slice(-INSPECTION_LINES).join("\n"),
    INSPECTION_OUTPUT_BYTES,
  );
}

export type AgentInspectionTarget = {
  workspaceId: string;
  paneId: string;
  piSessionId: string;
};
export type AgentInspectionValidator = (
  agent: HerdrRecord,
) => boolean | Promise<boolean>;

export type AgentInspection = {
  identity: AgentInspectionTarget & { agent: HerdrRecord };
  capturedAt: number;
  recentOutputTruncated: boolean;
  recentOutput?: string;
  process?: PaneProcess;
};

function exactAgent(agent: any, target: AgentInspectionTarget): boolean {
  const session = sessionIdentity(agent?.agent_session);
  const sessionMatches =
    session?.kind === "id"
      ? session.value === target.piSessionId
      : session?.kind === "path"
        ? (() => {
            try {
              return (
                SessionManager.open(session.value).getSessionId() ===
                target.piSessionId
              );
            } catch {
              return false;
            }
          })()
        : false;
  return (
    agent?.workspace_id === target.workspaceId &&
    agent?.pane_id === target.paneId &&
    sessionMatches
  );
}

export async function inspectHerdrAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: AgentInspectionTarget,
  signal?: AbortSignal,
  validate?: AgentInspectionValidator,
): Promise<AgentInspection> {
  const beforeResult = await runHerdr(
    pi,
    ctx,
    ["agent", "get", target.paneId],
    {
      signal,
    },
  );
  const before = beforeResult?.agent ?? beforeResult;
  if (!exactAgent(before, target) || (validate && !(await validate(before))))
    throw new Error("Inspection target identity did not match");
  // Pi's exec API exposes only signal, timeout, and cwd; it has no supported
  // stdout/stderr max-buffer option. Keep the Herdr read at 80 lines and
  // enforce the local 16 KiB byte bound after capture instead of inventing one.
  const outputResult = await pi.exec(
    "herdr",
    [
      "agent",
      "read",
      target.paneId,
      "--source",
      "recent-unwrapped",
      "--lines",
      "80",
      "--format",
      "text",
    ],
    { cwd: ctx.cwd, signal, timeout: 30_000 },
  );
  if (outputResult.code !== 0 || outputResult.killed)
    throw new Error("Inspection output could not be read");
  let process: PaneProcess | undefined;
  try {
    process = await paneProcess(pi, ctx, target.paneId, signal);
  } catch {
    // Process evidence is advisory; terminal identity remains authoritative.
  }
  const afterResult = await runHerdr(pi, ctx, ["agent", "get", target.paneId], {
    signal,
  });
  const after = afterResult?.agent ?? afterResult;
  if (!exactAgent(after, target) || (validate && !(await validate(after))))
    throw new Error("Inspection target changed during capture");
  const raw = [outputResult.stdout, outputResult.stderr]
    .map((value) => String(value ?? ""))
    .filter((value) => value.length > 0)
    .join("\n");
  const inspectionOutput = boundedInspectionOutput(raw);
  return Object.freeze({
    identity: Object.freeze({ ...target, agent: after }),
    capturedAt: Date.now(),
    recentOutputTruncated: inspectionOutput.truncated,
    ...(inspectionOutput.text ? { recentOutput: inspectionOutput.text } : {}),
    ...(process ? { process } : {}),
  });
}

function parseJson(value: string): any | undefined {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function structuredHerdrError(value: any): any | undefined {
  return [value?.error, value?.result?.error, value].find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.message === "string" &&
      candidate.message,
  );
}

export async function runHerdr(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeout?: number;
    noResult?: boolean;
  } = {},
): Promise<any> {
  const result = await pi.exec("herdr", args, {
    cwd: ctx.cwd,
    signal: options.signal,
    timeout: options.timeout ?? 30_000,
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const stdoutJson = parseJson(stdout);
  const stderrJson = parseJson(stderr);
  const parsed = stdoutJson !== undefined ? stdoutJson : stderrJson;
  const operation = `herdr ${args.slice(0, 2).join(" ") || "command"}`;
  if (result.code !== 0) {
    const value =
      structuredHerdrError(stdoutJson) ?? structuredHerdrError(stderrJson);
    error(
      operation,
      value?.message ??
        (boundedDiagnostic(stderr) ||
          boundedDiagnostic(stdout) ||
          `exit ${result.code}`),
      value?.details,
    );
  }
  if (options.noResult) return undefined;
  if (parsed === undefined && args.length === 1 && args[0] === "--version")
    return `${stdout}\n${stderr}`;
  if (parsed === undefined) {
    const classification =
      stdout.trim() || stderr.trim() ? "malformed" : "empty";
    const raw = {
      classification,
      stdout: boundedDiagnostic(stdout),
      stderr: boundedDiagnostic(stderr),
    };
    error(
      operation,
      classification === "empty"
        ? "Herdr returned empty output"
        : `Herdr returned malformed JSON: ${raw.stderr || raw.stdout}`,
      { result: raw },
    );
  }
  return parsed?.result ?? parsed;
}

function workspace(ctx: ExtensionContext): string {
  const value = process.env.HERDR_WORKSPACE_ID;
  if (!value) error("herdr context", "HERDR_WORKSPACE_ID is not set");
  return value;
}
export function structuredTopologyEnvironment(
  workspaceId: string,
  assignments: readonly string[],
): string[] {
  const reserved = new Set([
    "HERDR_ENV",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
    "PI_HERDSMAN_WORKSPACE_ID",
  ]);
  return [
    ...validateEnvironment(assignments).filter(
      (assignment) =>
        !reserved.has(assignment.slice(0, assignment.indexOf("="))),
    ),
    "HERDR_ENV=1",
    `HERDR_WORKSPACE_ID=${workspaceId}`,
    `PI_HERDSMAN_WORKSPACE_ID=${workspaceId}`,
  ];
}
function alias(workspaceId: string, label: string, runId: string): string {
  return `${label.slice(0, 15)}_${createHash("sha256").update(`${workspaceId}\0${label}\0${runId}`).digest("hex").slice(0, 16)}`;
}
export function herdrAgentAlias(
  workspaceId: string,
  label: string,
  runId: string,
): string {
  return alias(workspaceId, label, runId);
}

export function paneIsAvailable(
  pane: HerdrRecord,
  tabId: string,
  cwd: string,
): boolean {
  return (
    pane.tab_id === tabId &&
    !pane.agent &&
    pane.agent_status === "unknown" &&
    sameCwd(pane.foreground_cwd, cwd)
  );
}
function canonicalCwd(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
export function sameCwd(observed: unknown, expected: string): boolean {
  if (typeof observed !== "string") return false;
  return canonicalCwd(observed) === canonicalCwd(expected);
}
export function safeShellProcessTransition(
  expected: PaneProcess,
  observed: PaneProcess,
): boolean {
  if (
    expected.shell_pid !== observed.shell_pid ||
    observed.foreground_process_group_id !== expected.shell_pid
  )
    return false;
  const processes = observed.foreground_processes;
  return (
    !!processes?.length &&
    processes.some((p) => p.pid === expected.shell_pid) &&
    processes.every(
      (p) =>
        typeof p.argv0 === "string" &&
        SHELLS.has(p.argv0.split("/").pop()!.replace(/^-/, "")),
    )
  );
}
export function sameRunningProcessOwner(
  expected: PaneProcess,
  observed: PaneProcess,
): boolean {
  return (
    expected.pane_id === observed.pane_id &&
    expected.shell_pid === observed.shell_pid &&
    expected.foreground_process_group_id ===
      observed.foreground_process_group_id
  );
}
export function samePostStopPaneProcessIdentity(
  expected: PaneProcess,
  observed: PaneProcess,
): boolean {
  return safeShellProcessTransition(expected, observed);
}

async function lockLifecycle(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<() => void> {
  const id = workspace(ctx);
  // ponytail: serialize physical lifecycle mutations per workspace.
  // Split only if lifecycle throughput becomes a measured problem.
  const path = join(
    herdsmanTempRoot(),
    "locks",
    createHash("sha256").update(id).digest("hex"),
  );
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
    try {
      return claimProcessLock(path, {
        name: "Herdr lifecycle",
        occupiedMessage: "Herdr lifecycle is in progress",
      });
    } catch (e) {
      if (!(e instanceof ProcessLockOccupiedError) || Date.now() >= deadline)
        throw e;
      await sleep(50, undefined, { signal });
    }
  }
}

export async function listHerdrAgents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ workspaceId: string; agents: any[] }> {
  const workspaceId = workspace(ctx);
  const { agents } = await listAllHerdrAgents(pi, ctx, signal);
  return {
    workspaceId,
    agents: agents.filter((agent: any) => agent.workspace_id === workspaceId),
  };
}

export async function listAllHerdrAgents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ agents: any[] }> {
  const result = await runHerdr(pi, ctx, ["agent", "list"], { signal });
  return { agents: result?.agents ?? [] };
}

export type LeadMetadata = {
  paneId: string;
  name?: string;
  pendingAskId?: string;
};

export function leadMetadataArgs(metadata: LeadMetadata): string[] {
  const args = [
    "pane",
    "report-metadata",
    metadata.paneId,
    "--source",
    "pi-herdsman:lead",
    "--title",
    metadata.name?.trim() || "Pi Herdsman lead",
    "--token",
    "pi_herdsman_role=lead",
  ];
  if (metadata.pendingAskId)
    args.push("--token", `pi_herdsman_ask=${metadata.pendingAskId}`);
  else args.push("--clear-token", "pi_herdsman_ask");
  if (metadata.name?.trim())
    args.push("--token", `pi_herdsman_name=${metadata.name.trim()}`);
  else args.push("--clear-token", "pi_herdsman_name");
  return args;
}

export async function reportLeadMetadata(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  metadata: LeadMetadata,
): Promise<void> {
  await runHerdr(pi, ctx, leadMetadataArgs(metadata), {
    timeout: 10_000,
    noResult: true,
  });
}

export type StartHerdrOptions = {
  label: string;
  runId: string;
  cwd: string;
  extensionPath?: string;
  placement: HerdrStartPlacement;
  placementRevalidator?: (
    placement: HerdrStartPlacement,
  ) => Promise<HerdrStartPlacement>;
  agentArgs?: string[];
  env?: string[];
  timeoutMs?: number;
  direction?: "right" | "down";
  signal?: AbortSignal;
};

export type HerdrStartPlacement =
  | { kind: "tab"; label: string; tabId?: string }
  | { kind: "split"; paneId: string };

type SplitPlacement = {
  paneId: string;
  ratio: number;
  direction: "right" | "down";
};

function isUnstructuredResultFailure(value: unknown): value is OperationError {
  if (!(value instanceof OperationError)) return false;
  const classification = value.detail.details?.result as
    { classification?: unknown } | undefined;
  return (
    classification?.classification === "empty" ||
    classification?.classification === "malformed"
  );
}

function startupCallTimeout(deadline: number, cap = Infinity): number {
  const remaining = deadline - START_DIAGNOSTIC_TIMEOUT - Date.now();
  if (remaining <= 0) error("start", "startup deadline exhausted");
  return Math.min(remaining, cap);
}

type StartupDiagnosticOutcome =
  | { attempted: false; status: "unavailable"; reason: "deadline" }
  | { attempted: false; status: "unavailable"; reason: "aborted" }
  | { attempted: true; status: "captured"; snapshot: string }
  | { attempted: true; status: "empty" }
  | {
      attempted: true;
      status: "unavailable";
      reason: "nonzero" | "aborted" | "exception_or_timeout";
    };

export type StartupTimeoutBudget = {
  totalTimeout: number;
  childTimeout: number;
  diagnosticTimeout: number;
};

export function startupTimeoutBudget(timeoutMs?: number): StartupTimeoutBudget {
  const totalTimeout = timeoutMs ?? STARTUP_TIMEOUT_DEFAULT;
  const childTimeout = totalTimeout - START_DIAGNOSTIC_TIMEOUT;
  if (
    !Number.isInteger(totalTimeout) ||
    (timeoutMs !== undefined &&
      (totalTimeout < STARTUP_TIMEOUT_MIN ||
        totalTimeout > STARTUP_TIMEOUT_MAX)) ||
    childTimeout < HERDR_START_TIMEOUT_MIN ||
    childTimeout > HERDR_START_TIMEOUT_MAX
  )
    throw new RangeError(
      `timeoutMs must be an integer from ${STARTUP_TIMEOUT_MIN} through ${STARTUP_TIMEOUT_MAX}`,
    );
  return {
    totalTimeout,
    childTimeout,
    diagnosticTimeout: START_DIAGNOSTIC_TIMEOUT,
  };
}

function isAbortError(value: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof value === "object" &&
      value !== null &&
      ((value as { name?: unknown }).name === "AbortError" ||
        (value as { code?: unknown }).code === "ABORT_ERR"))
  );
}

async function captureStartupDiagnostic(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paneId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<StartupDiagnosticOutcome> {
  const timeout = Math.min(START_DIAGNOSTIC_TIMEOUT, deadline - Date.now());
  if (signal?.aborted)
    return { attempted: false, status: "unavailable", reason: "aborted" };
  if (timeout <= 0)
    return { attempted: false, status: "unavailable", reason: "deadline" };
  try {
    const result = await pi.exec(
      "herdr",
      [
        "pane",
        "read",
        paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "40",
        "--format",
        "text",
        "--raw",
      ],
      { cwd: ctx.cwd, signal, timeout },
    );
    if (result.killed)
      return {
        attempted: true,
        status: "unavailable",
        reason: signal?.aborted ? "aborted" : "exception_or_timeout",
      };
    if (result.code !== 0)
      return { attempted: true, status: "unavailable", reason: "nonzero" };
    const snapshot = boundedDiagnostic(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    return snapshot
      ? { attempted: true, status: "captured", snapshot }
      : { attempted: true, status: "empty" };
  } catch (cause) {
    return {
      attempted: true,
      status: "unavailable",
      reason: isAbortError(cause, signal) ? "aborted" : "exception_or_timeout",
    };
  }
}

function withStartupDiagnostic(
  failure: OperationError,
  outcome: StartupDiagnosticOutcome,
): OperationError {
  const details = {
    ...failure.detail.details,
    paneSnapshotAttempted: outcome.attempted,
    paneSnapshotStatus: outcome.status,
    ...(outcome.status === "unavailable"
      ? { paneSnapshotReason: outcome.reason }
      : {}),
    ...(outcome.status === "captured"
      ? { paneSnapshot: outcome.snapshot }
      : {}),
  };
  return new OperationError({
    ...failure.detail,
    message:
      outcome.status === "captured"
        ? `${failure.detail.message}\nPane diagnostic:\n${outcome.snapshot}`
        : failure.detail.message,
    details,
  });
}

async function selectSplitPlacement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  panes: any[],
  workspaceId: string,
  tabId: string,
  callerPaneId: string | undefined,
  defaultDirection: "right" | "down",
  deadline: number,
  signal?: AbortSignal,
): Promise<SplitPlacement> {
  const agentPanes = panes.filter(
    (pane: any) =>
      pane.workspace_id === workspaceId &&
      pane.tab_id === tabId &&
      (callerPaneId === undefined || pane.pane_id !== callerPaneId) &&
      (pane.agent ||
        (pane.agent_status !== undefined &&
          pane.agent_status !== null &&
          pane.agent_status !== "unknown")),
  );
  if (!agentPanes.length) {
    const anchor =
      callerPaneId ??
      panes.find(
        (pane: any) =>
          pane.workspace_id === workspaceId && pane.tab_id === tabId,
      )?.pane_id;
    if (!anchor) error("start", `tab ${tabId} has no pane to split`);
    return {
      paneId: anchor,
      ratio: INITIAL_RATIO,
      direction: defaultDirection,
    };
  }

  const layoutPaneId = callerPaneId ?? agentPanes[0]?.pane_id;
  if (!layoutPaneId) error("start", `tab ${tabId} has no pane layout anchor`);
  const layout = (
    await runHerdr(pi, ctx, ["pane", "layout", "--pane", layoutPaneId], {
      signal,
      timeout: startupCallTimeout(deadline),
    })
  )?.layout;
  if (
    !layout ||
    layout.workspace_id !== workspaceId ||
    layout.tab_id !== tabId ||
    !Array.isArray(layout.panes)
  )
    error(
      "start",
      `cannot safely select an agent split anchor in tab ${tabId}`,
    );

  const rectangles = new Map<string, { width: number; height: number }>();
  for (const item of layout.panes) {
    const paneId = item?.pane_id;
    const rect = item?.rect;
    if (typeof paneId !== "string" || rectangles.has(paneId) || !rect)
      error(
        "start",
        `cannot safely select an agent split anchor in tab ${tabId}`,
      );
    const { width, height } = rect;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    )
      error(
        "start",
        `cannot safely select an agent split anchor in tab ${tabId}`,
      );
    rectangles.set(paneId, { width, height });
  }

  let anchor:
    { pane: any; rect: { width: number; height: number } } | undefined;
  let anchorArea = -1;
  for (const pane of agentPanes) {
    const paneId = pane.pane_id;
    const rect = rectangles.get(paneId);
    if (typeof paneId !== "string" || !rect)
      error(
        "start",
        `cannot safely select an agent split anchor in tab ${tabId}`,
      );
    const area = rect.width * rect.height;
    if (!Number.isFinite(area))
      error(
        "start",
        `cannot safely select an agent split anchor in tab ${tabId}`,
      );
    if (area > anchorArea) {
      anchor = { pane, rect };
      anchorArea = area;
    }
  }
  if (!anchor)
    error(
      "start",
      `cannot safely select an agent split anchor in tab ${tabId}`,
    );
  return {
    paneId: anchor.pane.pane_id,
    ratio: AGENT_SPLIT_RATIO,
    direction: anchor.rect.width >= anchor.rect.height ? "right" : "down",
  };
}

export async function startHerdrAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: StartHerdrOptions,
): Promise<StartedHerdrAgent> {
  const workspaceId = workspace(ctx);
  const env = validateEnvironment(options.env ?? []);
  const release = await lockLifecycle(ctx, options.signal);
  let attempt: StartedHerdrAgent | undefined;
  let stage = "topology";
  try {
    const cwd = canonicalCwd(options.cwd);
    const { totalTimeout, childTimeout } = startupTimeoutBudget(
      options.timeoutMs,
    );
    const startupDeadline = Date.now() + totalTimeout;
    const topologyEnv = structuredTopologyEnvironment(workspaceId, env);
    const placement = options.placementRevalidator
      ? await options.placementRevalidator(options.placement)
      : options.placement;
    if (!placement) error("start", "physical Herdr placement is required");
    if (placement.kind === "split" && !placement.paneId)
      error("start", "caller pane is required for split placement");
    let tab: any;
    let panes: any[] | undefined;
    let paneId: string | undefined;
    let createdTab = false;
    let createdPane = false;
    const ownership: Record<string, PaneProcess> = {};
    const tabOwnership: Record<string, PaneProcess> = {};
    const tabs =
      placement.kind === "tab" && !placement.tabId
        ? undefined
        : ((
            await runHerdr(
              pi,
              ctx,
              ["tab", "list", "--workspace", workspaceId],
              {
                signal: options.signal,
                timeout: startupCallTimeout(startupDeadline),
              },
            )
          ).tabs ?? []);
    if (placement.kind === "split") {
      panes =
        (
          await runHerdr(
            pi,
            ctx,
            ["pane", "list", "--workspace", workspaceId],
            {
              signal: options.signal,
              timeout: startupCallTimeout(startupDeadline),
            },
          )
        ).panes ?? [];
      const callerPane = panes.find(
        (pane: any) =>
          pane.pane_id === placement.paneId &&
          pane.workspace_id === workspaceId,
      );
      if (!callerPane)
        error(
          "start",
          "caller pane " +
            placement.paneId +
            " is not in workspace " +
            workspaceId,
        );
      tab = tabs.find(
        (item: any) =>
          item.tab_id === callerPane.tab_id &&
          (item.workspace_id === undefined ||
            item.workspace_id === workspaceId),
      );
      if (!tab)
        error(
          "start",
          "caller pane " + placement.paneId + " has no owning Herdr tab",
        );
    } else {
      tab = tabs?.find((item: any) => item.tab_id === placement.tabId);
    }
    if (!tab) {
      if (placement.kind !== "tab")
        error("start", "cannot create a tab for split placement");
      const made = await runHerdr(
        pi,
        ctx,
        [
          "tab",
          "create",
          "--workspace",
          workspaceId,
          "--cwd",
          cwd,
          "--label",
          placement.label,
          ...topologyEnv.flatMap((x) => ["--env", x]),
          "--no-focus",
        ],
        {
          signal: options.signal,
          timeout: startupCallTimeout(startupDeadline),
        },
      );
      tab = made.tab;
      paneId = made.root_pane.pane_id;
      createdTab = createdPane = true;
    } else {
      const existingPanes =
        panes ??
        (
          await runHerdr(
            pi,
            ctx,
            ["pane", "list", "--workspace", workspaceId],
            {
              signal: options.signal,
              timeout: startupCallTimeout(startupDeadline),
            },
          )
        ).panes ??
        [];
      {
        const splitPlacement =
          placement.kind === "split"
            ? {
                paneId: placement.paneId,
                ratio: INITIAL_RATIO,
                direction: options.direction ?? "right",
              }
            : await selectSplitPlacement(
                pi,
                ctx,
                existingPanes,
                workspaceId,
                tab.tab_id,
                undefined,
                options.direction ?? "right",
                startupDeadline,
                options.signal,
              );
        const split = await runHerdr(
          pi,
          ctx,
          [
            "pane",
            "split",
            "--pane",
            splitPlacement.paneId,
            "--direction",
            splitPlacement.direction,
            "--ratio",
            String(splitPlacement.ratio),
            "--cwd",
            cwd,
            ...topologyEnv.flatMap((x) => ["--env", x]),
            "--no-focus",
          ],
          {
            signal: options.signal,
            timeout: startupCallTimeout(startupDeadline),
          },
        );
        paneId = split.pane.pane_id;
        createdPane = true;
      }
    }
    if (!paneId) error("start", "Herdr did not return a pane");
    attempt = {
      herdrAgent: alias(workspaceId, options.label, options.runId),
      workspaceId,
      tabId: tab.tab_id,
      paneId,
      cwd,
      createdTab,
      createdPane,
      paneOwnership: ownership,
      tabPaneOwnership: tabOwnership,
    };
    let started: any;
    stage = "pane_readiness";
    const shell = await waitForOwnedShellReady(
      pi,
      ctx,
      workspaceId,
      tab.tab_id,
      paneId,
      cwd,
      options.runId,
      startupDeadline,
      options.signal,
    );
    stage = "ownership_capture";
    for (const key of Object.keys(ownership)) delete ownership[key];
    for (const key of Object.keys(tabOwnership)) delete tabOwnership[key];
    ownership[paneId] = shell;
    tabOwnership[paneId] = shell;
    const currentPanes =
      (
        await runHerdr(pi, ctx, ["pane", "list", "--workspace", workspaceId], {
          signal: options.signal,
          timeout: startupCallTimeout(startupDeadline),
        })
      ).panes ?? [];
    const currentPane = currentPanes.find(
      (item: any) => item.pane_id === paneId,
    );
    if (
      !currentPane ||
      currentPane.workspace_id !== workspaceId ||
      currentPane.tab_id !== tab.tab_id ||
      !paneIsAvailable(currentPane, tab.tab_id, cwd)
    )
      error(
        "start",
        `pane ${paneId} did not become an available shell (topology changed before launch)`,
      );
    for (const pane of currentPanes.filter(
      (item: any) => item.tab_id === tab.tab_id && item.pane_id !== paneId,
    )) {
      const observed = await paneProcess(
        pi,
        ctx,
        pane.pane_id,
        options.signal,
        startupDeadline,
        true,
      );
      tabOwnership[pane.pane_id] = observed;
    }
    stage = "agent_start";
    const latest = await paneProcess(
      pi,
      ctx,
      paneId,
      options.signal,
      startupDeadline,
      true,
    );
    if (
      !latest ||
      latest.pane_id !== paneId ||
      latest.shell_pid !== shell.shell_pid ||
      !safeShellProcessTransition(latest, latest)
    )
      error("start", `pane ${paneId} shell identity changed before launch`);
    const remaining = startupCallTimeout(startupDeadline, childTimeout);
    if (remaining < HERDR_START_TIMEOUT_MIN)
      error("start", "startup deadline exhausted before agent start");
    try {
      started = await runHerdr(
        pi,
        ctx,
        [
          "agent",
          "start",
          attempt.herdrAgent,
          "--kind",
          "pi",
          "--pane",
          paneId,
          "--timeout",
          String(Math.min(remaining, childTimeout)),
          "--",
          ...(options.extensionPath
            ? ["--extension", options.extensionPath]
            : []),
          "--extension",
          HERDR_AGENT_STATE_EXTENSION,
          ...(options.agentArgs ?? []),
        ],
        {
          signal: options.signal,
          timeout: Math.min(remaining, childTimeout),
        },
      );
    } catch (failure) {
      if (isUnstructuredResultFailure(failure))
        throw withStartupDiagnostic(
          failure,
          await captureStartupDiagnostic(
            pi,
            ctx,
            paneId,
            startupDeadline,
            options.signal,
          ),
        );
      throw failure;
    }
    stage = "agent_result";
    const agent = started.agent ?? started;
    const session = sessionIdentity(agent.agent_session);
    const reference = session
      ? session.kind === "id"
        ? { id: session.value }
        : { path: session.value }
      : undefined;
    attempt.herdrAgent = agent.name ?? attempt.herdrAgent;
    attempt.paneId = paneId;
    attempt.createdPane = createdPane;
    attempt.sessionReference = reference;
    attempt.agent = agent;
    return attempt;
  } catch (cause) {
    if (attempt) throw new HerdrStartFailure(cause, stage, attempt, false);
    throw cause;
  } finally {
    release();
  }
}

function validateEnvironment(
  assignments: readonly string[],
): readonly string[] {
  const validated = [...assignments];
  for (const assignment of validated) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    const value = separator < 0 ? "" : assignment.slice(separator + 1);
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      error("start", "invalid environment key");
    if (/[\0\r\n]/.test(value))
      error("start", `invalid environment value for ${key}`);
  }
  return Object.freeze(validated);
}

async function paneProcess(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  paneId: string,
  signal?: AbortSignal,
  deadline?: number,
  required = false,
): Promise<PaneProcess | undefined> {
  const result = await runHerdr(
    pi,
    ctx,
    ["pane", "process-info", "--pane", paneId],
    {
      signal,
      ...(deadline === undefined
        ? {}
        : { timeout: startupCallTimeout(deadline) }),
    },
  );
  const value = result?.process ?? result?.process_info ?? result;
  const observed = normalizePaneProcess(value, paneId, required);
  if (required && !observed)
    error("start", `pane ${paneId} process ownership is unavailable`);
  return observed;
}

function boundedProcessString(
  value: unknown,
  maxBytes: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes
    ? value
    : bytes
        .subarray(0, maxBytes)
        .toString()
        .replace(/\uFFFD$/, "");
}

function normalizePaneProcess(
  value: unknown,
  paneId: string,
  required: boolean,
): PaneProcess | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.shell_pid) ||
    (candidate.shell_pid as number) <= 0 ||
    !Number.isInteger(candidate.foreground_process_group_id) ||
    (candidate.foreground_process_group_id as number) <= 0
  )
    return undefined;

  const hasExactPane = candidate.pane_id === paneId;
  if (required && !hasExactPane) return undefined;
  const foreground = Array.isArray(candidate.foreground_processes)
    ? candidate.foreground_processes
        .slice(0, MAX_FOREGROUND_PROCESSES)
        .filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object",
        )
        .map((item) => {
          const process = {
            ...(Number.isInteger(item.pid) && (item.pid as number) > 0
              ? { pid: item.pid as number }
              : {}),
            ...(boundedProcessString(item.argv0, MAX_PROCESS_ARGV0_BYTES)
              ? {
                  argv0: boundedProcessString(
                    item.argv0,
                    MAX_PROCESS_ARGV0_BYTES,
                  ),
                }
              : {}),
            ...(boundedProcessString(item.cmdline, MAX_PROCESS_CMDLINE_BYTES)
              ? {
                  cmdline: boundedProcessString(
                    item.cmdline,
                    MAX_PROCESS_CMDLINE_BYTES,
                  ),
                }
              : {}),
          };
          return Object.freeze(process);
        })
    : undefined;
  return Object.freeze({
    ...(hasExactPane ? { pane_id: paneId } : {}),
    shell_pid: candidate.shell_pid as number,
    foreground_process_group_id:
      candidate.foreground_process_group_id as number,
    ...(foreground?.length
      ? { foreground_processes: Object.freeze(foreground) }
      : {}),
  });
}

async function waitForOwnedShellReady(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workspaceId: string,
  tabId: string,
  paneId: string,
  cwd: string,
  runId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<PaneProcess> {
  const digest = createHash("sha256")
    .update(`${workspaceId}:${tabId}:${paneId}:${runId}`)
    .digest("hex")
    .slice(0, 12);
  const marker = `__PI_HERDSMAN_READY_${digest}__`;
  await runHerdr(
    pi,
    ctx,
    ["pane", "run", paneId, `printf '%s\\n' '${marker}'`],
    {
      signal,
      timeout: startupCallTimeout(deadline),
      noResult: true,
    },
  );
  const waitTimeout = startupCallTimeout(deadline);
  await runHerdr(
    pi,
    ctx,
    [
      "pane",
      "wait-output",
      paneId,
      "--regex",
      `^${marker}$`,
      "--timeout",
      String(waitTimeout),
    ],
    {
      signal,
      timeout: waitTimeout,
      noResult: true,
    },
  );
  const shell = await paneProcess(pi, ctx, paneId, signal, deadline, true);
  if (
    !shell ||
    shell.pane_id !== paneId ||
    !safeShellProcessTransition(shell, shell)
  )
    error("start", `pane ${paneId} did not become an available shell`);
  return shell;
}

async function settlePreservedPane(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrAgent: string,
  expected: {
    paneId: string;
    tabId: string;
    workspaceId: string;
    cwd: string;
  },
  processIdentity: PaneProcess,
  operation: "close" | "rollback",
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  let safeObservation = false;
  while (Date.now() < deadline) {
    const listed = await runHerdr(pi, ctx, ["agent", "list"], { signal });
    if (!Array.isArray(listed?.agents))
      error(operation, "agent list ownership proof is unavailable");
    const agents = listed.agents;
    const currentAgent = agents.find((item: any) => item.name === herdrAgent);
    const replacement = agents.find(
      (item: any) =>
        item.pane_id === expected.paneId && item.name !== herdrAgent,
    );
    if (currentAgent || replacement) {
      safeObservation = false;
    } else {
      const pane = (
        await runHerdr(pi, ctx, ["pane", "get", expected.paneId], { signal })
      ).pane;
      if (
        !pane ||
        pane.pane_id !== expected.paneId ||
        pane.workspace_id !== expected.workspaceId ||
        pane.tab_id !== expected.tabId ||
        !sameCwd(pane.cwd, expected.cwd)
      )
        error(operation, `pane ${expected.paneId} ownership changed`);
      const observed = await paneProcess(pi, ctx, expected.paneId, signal);
      if (observed && safeShellProcessTransition(processIdentity, observed)) {
        if (safeObservation) return;
        safeObservation = true;
      } else {
        safeObservation = false;
      }
    }
    await sleep(POLL_INTERVAL, undefined, { signal });
  }
  error(
    operation,
    `agent ${herdrAgent} did not settle back to its original shell`,
  );
}

type RunningAgentExpectation = {
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  cwd?: string;
  session?: ExpectedSession;
};
type RunningAgentProof = {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  session?: ExpectedSession;
  process: PaneProcess;
};

export function sessionIdentity(
  value: unknown,
): { kind: "id" | "path"; value: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  const sessionValue = (value as { value?: unknown }).value;
  return (kind === "id" || kind === "path") &&
    typeof sessionValue === "string" &&
    sessionValue
    ? { kind, value: sessionValue }
    : undefined;
}
export function matchesExpectedSession(
  observed: unknown,
  expected: ExpectedSession | undefined,
): boolean {
  if (!expected) return false;
  const session = sessionIdentity(observed);
  if (!session) return false;
  if (session.kind === "id")
    return (
      typeof expected.id === "string" &&
      expected.id.length > 0 &&
      session.value === expected.id
    );
  return (
    typeof expected.path === "string" &&
    expected.path.length > 0 &&
    resolve(session.value) === resolve(expected.path)
  );
}

async function proveExactRunningAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrAgent: string,
  expected: RunningAgentExpectation,
  processOwner: PaneProcess | undefined,
  operation: "close" | "rollback",
  allowPostCompletionTransition = false,
  signal?: AbortSignal,
): Promise<RunningAgentProof> {
  const agent = (
    await runHerdr(pi, ctx, ["agent", "get", herdrAgent], { signal })
  ).agent;
  const paneId = typeof agent?.pane_id === "string" ? agent.pane_id : undefined;
  const workspaceId =
    typeof agent?.workspace_id === "string" ? agent.workspace_id : undefined;
  const cwd = typeof agent?.cwd === "string" ? agent.cwd : undefined;
  const agentSession = sessionIdentity(agent?.agent_session);
  if (
    !agent ||
    agent.name !== herdrAgent ||
    !paneId ||
    !workspaceId ||
    !cwd ||
    (expected.paneId !== undefined && paneId !== expected.paneId) ||
    (expected.workspaceId !== undefined &&
      workspaceId !== expected.workspaceId) ||
    (expected.cwd !== undefined && !sameCwd(cwd, expected.cwd)) ||
    (expected.tabId !== undefined && agent.tab_id !== expected.tabId) ||
    typeof agent.tab_id !== "string" ||
    (expected.session !== undefined &&
      !matchesExpectedSession(agent?.agent_session, expected.session)) ||
    (processOwner !== undefined && expected.session === undefined) ||
    (agent.agent_session !== undefined &&
      agent.agent_session !== null &&
      agentSession === undefined)
  )
    error(operation, `agent ${herdrAgent} ownership is unproven`);

  const pane = (await runHerdr(pi, ctx, ["pane", "get", paneId], { signal }))
    .pane;
  const paneSession = sessionIdentity(pane?.agent_session);
  if (
    !pane ||
    pane.pane_id !== paneId ||
    pane.workspace_id !== workspaceId ||
    pane.tab_id !== agent.tab_id ||
    (expected.tabId !== undefined && pane.tab_id !== expected.tabId) ||
    !sameCwd(pane.cwd, cwd) ||
    (pane.agent_session !== undefined &&
      pane.agent_session !== null &&
      paneSession === undefined) ||
    (expected.session !== undefined
      ? !matchesExpectedSession(pane?.agent_session, expected.session)
      : paneSession?.kind !== agentSession?.kind ||
        paneSession?.value !== agentSession?.value)
  )
    error(operation, `pane ${paneId} ownership is unproven`);

  const listedTabs = await runHerdr(
    pi,
    ctx,
    ["tab", "list", "--workspace", workspaceId],
    { signal },
  );
  if (!Array.isArray(listedTabs?.tabs))
    error(operation, "tab list ownership proof is unavailable");
  const tabs = listedTabs.tabs;
  const tab = tabs.find((item: any) => item.tab_id === agent.tab_id);
  if (
    !tab ||
    (tab.workspace_id !== undefined && tab.workspace_id !== workspaceId)
  )
    error(operation, `tab ${agent.tab_id} ownership is unproven`);

  const observed = await paneProcess(pi, ctx, paneId, signal);
  if (
    !observed ||
    observed.pane_id !== paneId ||
    (processOwner !== undefined &&
      !sameRunningProcessOwner(processOwner, observed) &&
      !(
        allowPostCompletionTransition &&
        safeShellProcessTransition(processOwner, observed)
      ))
  )
    error(operation, `pane ${paneId} process ownership is unproven`);
  return {
    paneId,
    tabId: agent.tab_id,
    workspaceId,
    cwd,
    session: expected.session,
    process: observed,
  };
}

async function verifyHerdrPaneClosed(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrAgent: string,
  workspaceId: string,
  paneId: string,
  operation: "close" | "rollback",
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  while (Date.now() < deadline) {
    const [agents, panes] = await Promise.all([
      runHerdr(pi, ctx, ["agent", "list"], { signal }),
      runHerdr(pi, ctx, ["pane", "list", "--workspace", workspaceId], {
        signal,
      }),
    ]);
    if (!Array.isArray(agents?.agents))
      error(operation, "agent list disappearance proof is unavailable");
    if (!Array.isArray(panes?.panes))
      error(operation, "pane list disappearance proof is unavailable");
    const agentGone = !agents.agents.some(
      (item: any) =>
        item.name === herdrAgent || item.herdr_agent === herdrAgent,
    );
    const paneGone = !panes.panes.some((item: any) => item.pane_id === paneId);
    if (agentGone && paneGone) return;
    await sleep(POLL_INTERVAL, undefined, { signal });
  }
  error(
    operation,
    `agent ${herdrAgent} and pane ${paneId} did not disappear after close`,
  );
}

export async function closeHerdrPane(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrAgent: string,
  expected?: {
    paneId?: string;
    tabId?: string;
    workspaceId?: string;
    cwd?: string;
    session?: ExpectedSession;
    allowPostCompletionTransition?: boolean;
  },
  signal?: AbortSignal,
): Promise<void> {
  const allowPostCompletionTransition =
    expected?.allowPostCompletionTransition === true;
  const release = await lockLifecycle(ctx, signal);
  try {
    const initial = await proveExactRunningAgent(
      pi,
      ctx,
      herdrAgent,
      expected ?? {},
      undefined,
      "close",
      false,
      signal,
    );
    const proved = await proveExactRunningAgent(
      pi,
      ctx,
      herdrAgent,
      {
        paneId: initial.paneId,
        workspaceId: initial.workspaceId,
        cwd: initial.cwd,
        session: initial.session,
      },
      initial.process,
      "close",
      allowPostCompletionTransition,
      signal,
    );
    await runHerdr(pi, ctx, ["pane", "close", proved.paneId], {
      signal,
      noResult: true,
    });
    await verifyHerdrPaneClosed(
      pi,
      ctx,
      herdrAgent,
      proved.workspaceId,
      proved.paneId,
      "close",
      signal,
    );
  } finally {
    release();
  }
}

export async function stopHerdrAgentPreservingPane(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  herdrAgent: string,
  expected?: {
    paneId?: string;
    tabId?: string;
    workspaceId?: string;
    cwd?: string;
    session?: ExpectedSession;
  },
  signal?: AbortSignal,
): Promise<void> {
  const release = await lockLifecycle(ctx, signal);
  try {
    const initial = await proveExactRunningAgent(
      pi,
      ctx,
      herdrAgent,
      expected ?? {},
      undefined,
      "rollback",
      false,
      signal,
    );
    const proved = await proveExactRunningAgent(
      pi,
      ctx,
      herdrAgent,
      {
        paneId: initial.paneId,
        workspaceId: initial.workspaceId,
        cwd: initial.cwd,
        session: initial.session,
      },
      initial.process,
      "rollback",
      false,
      signal,
    );
    await runHerdr(
      pi,
      ctx,
      ["agent", "send-keys", proved.paneId, "ctrl+c", "ctrl+d"],
      { signal, noResult: true },
    );
    await settlePreservedPane(
      pi,
      ctx,
      herdrAgent,
      {
        paneId: proved.paneId,
        tabId: proved.tabId,
        workspaceId: proved.workspaceId,
        cwd: proved.cwd,
      },
      proved.process,
      "rollback",
      signal,
    );
  } finally {
    release();
  }
}

export async function rollbackHerdrStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  started: StartedHerdrAgent,
  signal?: AbortSignal,
): Promise<void> {
  const release = await lockLifecycle(ctx, signal);
  try {
    if (started.createdPane && !started.paneOwnership[started.paneId])
      error("rollback", `pane ${started.paneId} process ownership is unproven`);
    if (started.createdTab && !Object.keys(started.tabPaneOwnership).length)
      error("rollback", `tab ${started.tabId} process ownership is unproven`);
    const processOwnership = started.createdTab
      ? started.tabPaneOwnership
      : started.paneOwnership;
    const targetProcess = processOwnership[started.paneId];
    if (!targetProcess)
      error("rollback", `pane ${started.paneId} process ownership is unproven`);
    const listedAgents = await runHerdr(pi, ctx, ["agent", "list"], {
      signal,
    });
    if (!Array.isArray(listedAgents?.agents))
      error("rollback", "agent list ownership proof is unavailable");
    const agents = listedAgents.agents;
    const managed = agents.find(
      (item: any) => item.name === started.herdrAgent,
    );
    const replacement = agents.find(
      (item: any) =>
        item.pane_id === started.paneId && item.name !== started.herdrAgent,
    );
    if (replacement)
      error("rollback", `pane ${started.paneId} has a replacement agent`);
    if (managed) {
      const observedSession = sessionIdentity(managed.agent_session);
      const sessionReference =
        started.sessionReference ??
        (observedSession?.kind === "id"
          ? { id: observedSession.value }
          : observedSession?.kind === "path"
            ? { path: observedSession.value }
            : undefined);
      const initial = await proveExactRunningAgent(
        pi,
        ctx,
        started.herdrAgent,
        {
          paneId: started.paneId,
          tabId: started.tabId,
          workspaceId: started.workspaceId,
          cwd: started.cwd,
          session: sessionReference,
        },
        undefined,
        "rollback",
        false,
        signal,
      );
      const proved = await proveExactRunningAgent(
        pi,
        ctx,
        started.herdrAgent,
        {
          paneId: initial.paneId,
          tabId: initial.tabId,
          workspaceId: initial.workspaceId,
          cwd: initial.cwd,
          session: initial.session,
        },
        initial.process,
        "rollback",
        false,
        signal,
      );
      await runHerdr(
        pi,
        ctx,
        ["agent", "send-keys", proved.paneId, "ctrl+c", "ctrl+d"],
        { signal, noResult: true },
      );
      await settlePreservedPane(
        pi,
        ctx,
        started.herdrAgent,
        {
          paneId: started.paneId,
          tabId: started.tabId,
          workspaceId: started.workspaceId,
          cwd: started.cwd,
        },
        targetProcess,
        "rollback",
        signal,
      );
    }
    const listedTabs = await runHerdr(
      pi,
      ctx,
      ["tab", "list", "--workspace", started.workspaceId],
      { signal },
    );
    if (!Array.isArray(listedTabs?.tabs))
      error("rollback", "tab list ownership proof is unavailable");
    const tabs = listedTabs.tabs;
    const tab = tabs.find((item: any) => item.tab_id === started.tabId);
    if (
      !tab ||
      (tab.workspace_id !== undefined &&
        tab.workspace_id !== started.workspaceId)
    ) {
      error("rollback", `tab ${started.tabId} ownership is unproven`);
    }
    if (started.createdTab) {
      const listedPanes = await runHerdr(
        pi,
        ctx,
        ["pane", "list", "--workspace", started.workspaceId],
        { signal },
      );
      if (!Array.isArray(listedPanes?.panes))
        error("rollback", "pane list ownership proof is unavailable");
      const panes = listedPanes.panes;
      const currentIds = panes
        .filter((pane: any) => pane.tab_id === started.tabId)
        .map((pane: any) => pane.pane_id)
        .sort();
      const expectedIds = Object.keys(processOwnership).sort();
      if (
        currentIds.length !== expectedIds.length ||
        currentIds.some(
          (paneId: string, index: number) => paneId !== expectedIds[index],
        )
      ) {
        error("rollback", `tab ${started.tabId} pane ownership is unproven`);
      }
    }
    for (const [paneId, expected] of Object.entries(processOwnership)) {
      const pane = (
        await runHerdr(pi, ctx, ["pane", "get", paneId], { signal })
      ).pane;
      if (
        !pane ||
        pane.pane_id !== paneId ||
        pane.workspace_id !== started.workspaceId ||
        pane.tab_id !== started.tabId ||
        !sameCwd(pane.cwd, started.cwd)
      )
        error("rollback", `pane ${paneId} ownership is unproven`);
      const observed = await paneProcess(pi, ctx, paneId, signal);
      if (!observed || !samePostStopPaneProcessIdentity(expected, observed))
        error("rollback", `pane ${paneId} process ownership is unproven`);
    }
    if (!managed) {
      const listedAgents = await runHerdr(pi, ctx, ["agent", "list"], {
        signal,
      });
      if (!Array.isArray(listedAgents?.agents))
        error("rollback", "agent list ownership proof is unavailable");
      const currentAgents = listedAgents.agents;
      if (
        currentAgents.some(
          (item: any) =>
            item.name === started.herdrAgent || item.pane_id === started.paneId,
        )
      )
        error("rollback", `pane ${started.paneId} agent ownership changed`);
    }
    if (started.createdTab)
      await runHerdr(pi, ctx, ["tab", "close", started.tabId], {
        signal,
        noResult: true,
      });
    else if (started.createdPane)
      await runHerdr(pi, ctx, ["pane", "close", started.paneId], {
        signal,
        noResult: true,
      });
    if (started.createdTab) {
      const [currentTabs, currentPanes] = await Promise.all([
        runHerdr(pi, ctx, ["tab", "list", "--workspace", started.workspaceId], {
          signal,
        }),
        runHerdr(
          pi,
          ctx,
          ["pane", "list", "--workspace", started.workspaceId],
          { signal },
        ),
      ]);
      if (!Array.isArray(currentTabs?.tabs))
        error("rollback", "tab list disappearance proof is unavailable");
      if (!Array.isArray(currentPanes?.panes))
        error("rollback", "pane list disappearance proof is unavailable");
      const capturedPaneIds = new Set(Object.keys(started.tabPaneOwnership));
      if (
        currentTabs.tabs.some((item: any) => item.tab_id === started.tabId) ||
        currentPanes.panes.some((item: any) =>
          capturedPaneIds.has(item.pane_id),
        )
      )
        error("rollback", `tab ${started.tabId} did not disappear after close`);
    } else if (started.createdPane)
      await verifyHerdrPaneClosed(
        pi,
        ctx,
        started.herdrAgent,
        started.workspaceId,
        started.paneId,
        "rollback",
        signal,
      );
  } finally {
    release();
  }
}
