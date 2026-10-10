import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  ContextEvent,
  ModelSelectEvent,
  SessionCompactFailedEvent,
  SessionBeforeCompactEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import {
  agentMailboxPath,
  controlMarker,
  mailboxRecordBytes,
  observeMailbox,
  parseControlMarker,
  readPendingAsk,
  readResult,
  readRequest,
  readAgentState,
  readUnacknowledgedRequest,
  removeRequest,
  removeAsk as removeMailboxAsk,
  writeResult,
  writeAsk,
  writeAgentState,
  readAgentBootstrap,
  removeAgentBootstrap,
  unacknowledgedRequestExists,
  type AskRecord,
  type ManagedAgentState,
  type ResultRecord,
  type ResultPersistenceError,
  type RequestRecord,
} from "./mailbox.ts";
import { contentText } from "@earendil-works/pi-ai";
import {
  AGENT_DEFINITION_ENTRY,
  DELEGATING_AGENT_SCOPE_DESCRIPTION,
  sessionAgentIdentity,
  validateManagedAgentControllerIdentity,
  validId,
  type Runtime,
} from "./agent-controller.ts";
import {
  buildAgentStatusSnapshot,
  statusBreadcrumb,
  createAgentController,
  createAgentStatusRuntime,
  hasPendingDirectChildWork,
  allDirectChildrenAskBlocked,
  hasUndeliveredDirectChildWork,
  managedAgentSnapshots,
  type AgentControllerOptions,
  type ManagedAgentSnapshotCollection,
} from "./agent-controller.ts";
import {
  herdrSessionId,
  listAllHerdrAgents,
  runHerdr,
  sameCwd,
} from "./herdr.ts";
import {
  displayIdentity,
  FILE_HANDOFF_GUIDANCE,
  prepareMessageInput,
  MANAGED_AGENT_BOOTSTRAP_EVENT,
} from "./core.ts";
import {
  collapseDisplayText,
  createStatusWidget,
  nameSessionIfUnset,
  type FocusIntent,
} from "./presentation.ts";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  sameRuntimeBuild,
  formatRuntimeBuild,
  type RuntimeBuild,
} from "./compatibility.ts";
import {
  taskAcceptanceAllowed,
  steerAcceptanceAllowed,
  currentTurnIsSoleToolCall,
} from "./core.ts";
import { importResultBindings } from "./agent-controller.ts";
import { fail, OperationError } from "./errors.ts";
import { readConfig } from "./config.ts";
import { isDeepStrictEqual } from "node:util";
import type { ResultBinding } from "./storage.ts";
import {
  agentDefinitionEnabled,
  agentDefinitionMetadata,
  validateAgentDefinitionReferences,
  type AgentDefinition,
} from "./agent-definitions.ts";

const DELEGATING_AGENT_ROLE_CHARTER = `## Delegating agent role
${DELEGATING_AGENT_SCOPE_DESCRIPTION}
${FILE_HANDOFF_GUIDANCE}`;

function askRecordBytes(
  state: ManagedAgentState,
  askId: string,
  text: string,
  createdAt: number,
  resultBindings: readonly ResultBinding[],
): number {
  return mailboxRecordBytes({
    version: 5,
    askId,
    requestId: state.activeRequestId!,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    piSessionId: state.piSessionId,
    question: text,
    ...(resultBindings.length ? { resultBindings: [...resultBindings] } : {}),
    createdAt,
  });
}

function validateManagedAgentDefinition(definitions: AgentDefinition[]): void {
  const name = process.env.PI_HERDSMAN_AGENT_DEFINITION;
  const definition = definitions.find((item) => item.name === name);
  if (!definition) throw new Error(`agent ${name} not found`);
  if (!agentDefinitionEnabled(definition))
    throw new Error(
      `agent ${definition.name} is disabled; enable it from a Lead session through /herdsman → Definitions before starting a new agent`,
    );
  validateAgentDefinitionReferences(definition, definitions);
}

function managedAgentDefinitionRoster(
  definitions: AgentDefinition[],
  allowed: string[],
): Record<string, unknown>[] {
  return definitions
    .map((definition) => agentDefinitionMetadata(definition, "leaf"))
    .filter(
      (definition) =>
        allowed.includes(definition.name) && definition.enabled !== false,
    );
}

export function ensureManagedAgentIdentity(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  definition: string,
  label: string,
): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const identity = sessionAgentIdentity(
    ctx.sessionManager.getEntries(),
    sessionId,
  );
  if (identity) {
    if (identity.definition !== definition || identity.label !== label)
      throw new Error("agent session identity does not match environment");
    return;
  }
  pi.appendEntry(AGENT_DEFINITION_ENTRY, { sessionId, definition, label });
}

export function managedAgentEnvironmentIdentity(
  ctx: ExtensionContext,
  build: RuntimeBuild,
): ManagedAgentState | undefined {
  const e = process.env;
  if (managedAgentEnvironmentError()) return undefined;
  return {
    version: 5,
    build,
    runId: e.PI_HERDSMAN_RUN_ID,
    ownerSessionId: e.PI_HERDSMAN_OWNER_SESSION_ID,
    workspaceId: e.PI_HERDSMAN_WORKSPACE_ID,
    agentLabel: e.PI_HERDSMAN_LABEL,
    paneId: e.HERDR_PANE_ID,
    piSessionId: ctx.sessionManager.getSessionId(),
    piSessionFile: ctx.sessionManager.getSessionFile(),
    agentDefinition: e.PI_HERDSMAN_AGENT_DEFINITION,
    cwd: ctx.cwd,
    updatedAt: Date.now(),
  };
}

export function sameManagedAgentIdentity(
  left: ManagedAgentState,
  right: ManagedAgentState,
): boolean {
  return (
    left.runId === right.runId &&
    left.ownerSessionId === right.ownerSessionId &&
    left.workspaceId === right.workspaceId &&
    left.agentLabel === right.agentLabel &&
    left.paneId === right.paneId &&
    left.piSessionId === right.piSessionId &&
    sameSessionPath(left.piSessionFile, right.piSessionFile) &&
    sameCwd(left.cwd, right.cwd)
  );
}

function sameSessionPath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const canonical = (path: string) => {
    try {
      return realpathSync(path);
    } catch (error) {
      throw new Error(
        `could not canonicalize exact Pi session path ${path}: ${String(error)}`,
      );
    }
  };
  return canonical(left) === canonical(right);
}

export function sameManagedAgentDurableState(
  left: ManagedAgentState,
  right: ManagedAgentState,
): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftDurable } = left;
  const { updatedAt: _rightUpdatedAt, ...rightDurable } = right;
  return isDeepStrictEqual(leftDurable, rightDurable);
}

export function runtimeIdentityState(
  runtime: Runtime,
  build: RuntimeBuild,
): ManagedAgentState {
  return {
    version: 5,
    build,
    runId: runtime.runId,
    ownerSessionId: runtime.ownerSessionId,
    workspaceId: runtime.workspaceId,
    agentLabel: runtime.label,
    paneId: runtime.paneId,
    piSessionId: runtime.piSessionId ?? "",
    piSessionFile: runtime.piSessionFile,
    cwd: runtime.cwd,
    updatedAt: 0,
  };
}

export function validateManagedAgentIdentity(input: {
  state: ManagedAgentState | undefined;
  stateError?: unknown;
  mailbox: string | undefined;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  sessionFile: string | undefined;
  cwd: string;
  sameSessionPath(left: string | undefined, right: string | undefined): boolean;
}): ManagedAgentState {
  const { state, mailbox, env } = input;
  if (input.stateError !== undefined)
    fail(
      "internal_failure",
      `Agent mailbox state is malformed or oversized: ${String(input.stateError)}`,
      "controller",
      {
        ids: { label: env.PI_HERDSMAN_LABEL, paneId: env.HERDR_PANE_ID },
      },
    );
  if (
    !state ||
    !mailbox ||
    state.workspaceId !== env.PI_HERDSMAN_WORKSPACE_ID ||
    state.agentLabel !== env.PI_HERDSMAN_LABEL ||
    state.paneId !== env.HERDR_PANE_ID ||
    state.ownerSessionId !== env.PI_HERDSMAN_OWNER_SESSION_ID ||
    state.piSessionId !== input.sessionId ||
    !input.sameSessionPath(state.piSessionFile, input.sessionFile) ||
    resolve(state.cwd) !== resolve(input.cwd) ||
    state.runId !== env.PI_HERDSMAN_RUN_ID
  )
    fail(
      "target_not_found",
      "Delegation controller identity is not a valid managed agent",
      "controller",
      {
        ids: { label: env.PI_HERDSMAN_LABEL, paneId: env.HERDR_PANE_ID },
      },
    );
  return state;
}

function managedAgentIdentity(ctx: ExtensionContext): ManagedAgentState {
  const env = process.env;
  const mailbox = env.PI_HERDSMAN_MAILBOX;
  let state: ManagedAgentState | undefined;
  let stateError: unknown;
  try {
    state = mailbox ? readAgentState(mailbox) : undefined;
  } catch (error) {
    stateError = error;
  }
  return validateManagedAgentIdentity({
    state,
    stateError,
    mailbox,
    env,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    sameSessionPath,
  });
}

function managedAgentControllerIdentity(
  ctx: ExtensionContext,
): ManagedAgentState {
  const state = managedAgentIdentity(ctx);
  return validateManagedAgentControllerIdentity(ctx, state);
}

const AGENT_LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_PREFIX = "__PI_HERDSMAN_AGENT_V5__:";
const AGENT_CONTEXT_RETIRED_ENTRY = "pi-herdsman-agent-context-retired";
const CONTEXT_RETIREMENT_INSTRUCTION =
  "Context pressure has retired this session. Do not start new work or new agents. " +
  "Finish the current coherent operation at the next safe point. Avoid nonessential " +
  "tool calls and validation; perform only what is needed for a reliable handoff. " +
  "Resolve already-running dependent work, then complete this assignment with a " +
  "self-contained handoff covering completed work, current state, relevant files, " +
  "validation performed, unresolved issues, and exact next steps. This session " +
  "will not be continued or forked.";
const CONTEXT_RETIREMENT_REMINDER =
  "This session is retired. Do not start new work or agents. " +
  "Finish the current assignment and return a self-contained handoff.";

type MetadataActivity = { requestId: string; task: string; startedAt: number };
type MetadataRuntime = {
  label: string;
  paneId: string;
  runId: string;
  agentDefinition: string;
  cwd: string;
};
type MetadataDesiredState = {
  generation: number;
  revision: number;
  runtime: MetadataRuntime;
  activity?: MetadataActivity;
  context?: number;
  model?: string;
  thinking?: string;
};
type MetadataPublishedState = {
  generation: number;
  activityKnown: boolean;
  activity?: MetadataActivity;
  contextKnown: boolean;
  context?: number;
  modelKnown: boolean;
  model?: string;
  thinkingKnown: boolean;
  thinking?: string;
};
export type ManagedAgentMetadataPatch = {
  activity?: MetadataActivity | null;
  context?: number | null;
  model?: string | null;
  thinking?: string | null;
};

export function createManagedAgentExecutionState() {
  return {
    assignment: undefined as ManagedAgentState | undefined,
    initialized: false,
    latest: "",
    pendingResult: undefined as ResultRecord | undefined,
    pendingStateTransition: false,
    pendingInterruptReplacement: undefined as string | undefined,
    resultWriteAttempts: 0,
    retryTimer: undefined as ReturnType<typeof setInterval> | undefined,
    stateRetryTimer: undefined as ReturnType<typeof setInterval> | undefined,
    stopRequestObserver: undefined as (() => void) | undefined,
    stateErrorReported: false,
    resultErrorReported: false,
    agentContext: undefined as ExtensionContext | undefined,
    agentStartedAt: undefined as number | undefined,
    mutationErrorReported: false,
  };
}

export function createManagedAgentMetadataPublisher(pi: ExtensionAPI) {
  let generation = 0;
  let desired: MetadataDesiredState | undefined;
  let published: MetadataPublishedState = {
    generation: 0,
    activityKnown: false,
    contextKnown: false,
    modelKnown: false,
    thinkingKnown: false,
  };
  let dirty = false;
  let flushActive = false;
  let abortController: AbortController | undefined;

  const invalidate = () => {
    generation++;
    desired = undefined;
    published = {
      generation,
      activityKnown: false,
      contextKnown: false,
      modelKnown: false,
      thinkingKnown: false,
    };
    dirty = false;
  };
  const beginSession = (): AbortSignal => {
    abortController?.abort();
    abortController = new AbortController();
    return abortController.signal;
  };
  const abort = () => {
    abortController?.abort();
    abortController = undefined;
    invalidate();
  };
  const reset = (
    runtime: MetadataRuntime,
    patch: ManagedAgentMetadataPatch,
  ) => {
    generation++;
    desired = {
      generation,
      revision: 1,
      runtime,
      ...(patch.activity && { activity: patch.activity }),
      ...(patch.context !== undefined && patch.context !== null
        ? { context: Math.max(0, Math.min(100, Math.round(patch.context))) }
        : {}),
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.thinking ? { thinking: patch.thinking } : {}),
    };
    published = {
      generation,
      activityKnown: false,
      contextKnown: false,
      modelKnown: false,
      thinkingKnown: false,
    };
    dirty = true;
  };
  const update = (
    runtime: MetadataRuntime,
    patch: ManagedAgentMetadataPatch,
  ) => {
    if (!desired) return;
    let changed = false;
    if (JSON.stringify(desired.runtime) !== JSON.stringify(runtime)) {
      desired.runtime = runtime;
      changed = true;
    }
    if (patch.activity !== undefined) {
      const next = patch.activity ?? undefined;
      if (!sameActivity(desired.activity, next)) {
        desired.activity = next;
        changed = true;
      }
    }
    if (patch.context !== undefined) {
      const next =
        patch.context === null
          ? undefined
          : Math.max(0, Math.min(100, Math.round(patch.context)));
      if (desired.context !== next) {
        desired.context = next;
        changed = true;
      }
    }
    if (
      patch.model !== undefined &&
      desired.model !== (patch.model ?? undefined)
    ) {
      desired.model = patch.model ?? undefined;
      changed = true;
    }
    if (
      patch.thinking !== undefined &&
      desired.thinking !== (patch.thinking ?? undefined)
    ) {
      desired.thinking = patch.thinking ?? undefined;
      changed = true;
    }
    if (changed) {
      desired.revision++;
      dirty = true;
    }
  };
  const flush = async (ctx: ExtensionContext) => {
    if (flushActive) return;
    flushActive = true;
    try {
      while (dirty && desired) {
        dirty = false;
        const attempted = {
          ...desired,
          runtime: { ...desired.runtime },
          ...(desired.activity ? { activity: { ...desired.activity } } : {}),
        };
        let succeeded = false;
        try {
          await runHerdr(
            pi,
            ctx,
            [
              "pane",
              "report-metadata",
              attempted.runtime.paneId,
              ...metadataArgs(attempted, published),
            ],
            {
              timeout: 10_000,
              signal: abortController?.signal,
              noResult: true,
            },
          );
          succeeded = true;
        } catch {}
        const current = desired;
        if (!current || current.generation !== attempted.generation) continue;
        if (!succeeded) {
          if (current.revision !== attempted.revision) continue;
          dirty = true;
          break;
        }
        const generationChanged = published.generation !== attempted.generation;
        const modelChanged =
          generationChanged ||
          !published.modelKnown ||
          attempted.model !== published.model;
        const thinkingChanged =
          generationChanged ||
          !published.thinkingKnown ||
          attempted.thinking !== published.thinking;
        published = {
          generation: attempted.generation,
          activityKnown: true,
          activity: attempted.activity ? { ...attempted.activity } : undefined,
          contextKnown: true,
          context: attempted.context,
          modelKnown: true,
          model:
            attempted.model ?? (modelChanged ? undefined : published.model),
          thinkingKnown: true,
          thinking:
            attempted.thinking ??
            (thinkingChanged ? undefined : published.thinking),
        };
        if (current.revision !== attempted.revision) dirty = true;
      }
    } finally {
      flushActive = false;
    }
  };
  return {
    get signal() {
      return abortController?.signal;
    },
    beginSession,
    abort,
    invalidate,
    report(
      state: ManagedAgentState,
      ctx: ExtensionContext,
      patch: ManagedAgentMetadataPatch,
      resetSession = false,
    ) {
      const runtime = {
        label: state.agentLabel,
        paneId: state.paneId,
        runId: state.runId,
        agentDefinition: process.env.PI_HERDSMAN_AGENT_DEFINITION!,
        cwd: ctx.cwd,
      };
      if (resetSession) reset(runtime, patch);
      else update(runtime, patch);
      void flush(ctx);
    },
  };
}

function sameActivity(
  left?: MetadataActivity,
  right?: MetadataActivity,
): boolean {
  return (
    left?.requestId === right?.requestId &&
    left?.task === right?.task &&
    left?.startedAt === right?.startedAt
  );
}

function metadataArgs(
  desired: MetadataDesiredState,
  published: MetadataPublishedState,
): string[] {
  const { runtime, activity } = desired;
  const title =
    collapseDisplayText(
      activity ? `${runtime.label} · ${activity.task}` : runtime.label,
      80,
    ) ?? runtime.label.slice(0, 80);
  const args = [
    "--source",
    `pi-herdsman:${runtime.runId}`,
    "--title",
    title,
    "--display-agent",
    runtime.agentDefinition,
    "--token",
    "managed=1",
    "--token",
    `role=${runtime.agentDefinition}`,
  ];
  const generationChanged = published.generation !== desired.generation;
  if (
    generationChanged ||
    !published.activityKnown ||
    !sameActivity(published.activity, activity)
  ) {
    if (activity)
      args.push(
        "--token",
        `request=${activity.requestId}`,
        "--token",
        `task=${collapseDisplayText(activity.task) ?? ""}`,
        "--token",
        `started=${activity.startedAt}`,
      );
    else
      args.push(
        "--clear-token",
        "request",
        "--clear-token",
        "task",
        "--clear-token",
        "started",
      );
  }
  if (
    generationChanged ||
    !published.contextKnown ||
    published.context !== desired.context
  ) {
    if (activity && desired.context !== undefined)
      args.push("--token", `ctx=${desired.context}`);
    else args.push("--clear-token", "ctx");
  }
  if (
    generationChanged ||
    !published.modelKnown ||
    desired.model !== published.model
  )
    args.push(
      desired.model !== undefined ? "--token" : "--clear-token",
      desired.model !== undefined ? `model=${desired.model}` : "model",
    );
  if (
    generationChanged ||
    !published.thinkingKnown ||
    desired.thinking !== published.thinking
  )
    args.push(
      desired.thinking !== undefined ? "--token" : "--clear-token",
      desired.thinking !== undefined
        ? `thinking=${desired.thinking}`
        : "thinking",
    );
  return args;
}

export function createManagedAgentLeafStatus(options: {
  snapshot(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<ManagedAgentSnapshotCollection>;
  identity(ctx: ExtensionContext): ManagedAgentState | undefined;
  sameIdentity(left: ManagedAgentState, right: ManagedAgentState): boolean;
  signal(): AbortSignal | undefined;
  focusTarget?(
    ctx: ExtensionContext,
    intent: FocusIntent,
    isCurrent: () => boolean,
  ): Promise<void>;
}) {
  let widget: ReturnType<typeof createStatusWidget> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: ExtensionContext | undefined;
  let generation = 0;
  let inFlight = false;
  let focusInFlight = false;
  let breadcrumb: ReturnType<typeof statusBreadcrumb> | undefined;
  let ownTools: string[] | undefined;
  const ownToolsSnapshot = () => (ownTools ? { ownTools } : {});
  const reset = () => {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (widget) {
      context?.ui.setWidget("pi-herdsman", undefined);
      widget.dispose();
      widget = undefined;
    }
    context = undefined;
    inFlight = false;
    focusInFlight = false;
  };
  const refresh = async (ctx: ExtensionContext, activeGeneration: number) => {
    if (activeGeneration !== generation || ctx !== context || inFlight) return;
    inFlight = true;
    try {
      const snapshot = await options.snapshot(ctx, options.signal());
      if (activeGeneration !== generation || ctx !== context) return;
      breadcrumb = statusBreadcrumb(
        snapshot,
        options.identity(ctx),
        {
          definition: process.env.PI_HERDSMAN_AGENT_DEFINITION,
          label: process.env.PI_HERDSMAN_LABEL,
        },
        options.sameIdentity,
      );
      widget?.setSnapshot({
        agents: [],
        stale: false,
        unavailable: false,
        breadcrumb,
        ...ownToolsSnapshot(),
        identityOnly: true,
        refreshedAt: Date.now(),
      });
    } catch {
      if (activeGeneration === generation && ctx === context)
        widget?.setSnapshot({
          agents: [],
          stale: false,
          unavailable: true,
          breadcrumb: breadcrumb ?? [
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
          ],
          ...ownToolsSnapshot(),
          identityOnly: true,
        });
    } finally {
      if (activeGeneration === generation && ctx === context) inFlight = false;
    }
  };
  return {
    reset,
    captureOwnTools(tools: string[] | undefined) {
      ownTools = tools;
    },
    start(ctx: ExtensionContext) {
      const activeGeneration = generation;
      context = ctx;
      ctx.ui.setWidget("pi-herdsman", (tui, theme) => {
        let next: ReturnType<typeof createStatusWidget>;
        next = createStatusWidget(
          () => tui.requestRender(),
          theme,
          (intent) => {
            if (
              activeGeneration !== generation ||
              ctx !== context ||
              widget !== next ||
              focusInFlight
            )
              return;
            if (!options.focusTarget) return;
            focusInFlight = true;
            const isCurrent = () =>
              activeGeneration === generation &&
              ctx === context &&
              widget === next;
            void options
              .focusTarget(ctx, intent, isCurrent)
              .catch((error) => {
                if (activeGeneration === generation && ctx === context)
                  ctx.ui.notify(
                    String(error).replace(/^Error: /u, ""),
                    "warning",
                  );
              })
              .finally(() => {
                if (activeGeneration === generation) focusInFlight = false;
              });
          },
        );
        next.setSnapshot({
          agents: [],
          stale: false,
          unavailable: true,
          breadcrumb: [
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
          ],
          ...ownToolsSnapshot(),
          identityOnly: true,
        });
        if (activeGeneration === generation && ctx === context) widget = next;
        else next.dispose();
        return next;
      });
      timer = setInterval(() => void refresh(ctx, activeGeneration), 10_000);
      void refresh(ctx, activeGeneration);
    },
  };
}

export function createManagedAgentAskOwnerHandler(options: {
  state(): ManagedAgentState | undefined;
  setState(state: ManagedAgentState): void;
  sameIdentity(left: ManagedAgentState, right: ManagedAgentState): boolean;
  eligible(): boolean;
  rejectionReason(): string;
  isSoleToolCall(ctx: ExtensionContext): boolean;
  messageLimits(ctx: ExtensionContext): Promise<{
    inline: { bytes: number };
    mailbox: { bytes: number };
  }>;
  prepare(
    ctx: ExtensionContext,
    question: string,
    files: string[] | undefined,
    state: ManagedAgentState,
    askId: string,
    createdAt: number,
    limits: { inline: { bytes: number }; mailbox: { bytes: number } },
  ): Promise<{ text: string; resultBindings: unknown[] }>;
  checkMailboxSize(bytes: number, limit: number): void;
  claimLock(mailbox: string, state: ManagedAgentState): () => void;
  readState(mailbox: string): ManagedAgentState | undefined;
  writeState(mailbox: string, state: ManagedAgentState): void;
  writeAsk(mailbox: string, ask: AskRecord): void;
  removeAsk(mailbox: string): void;
  latest(value: string): void;
}) {
  return async (
    _id: string,
    params: { question: string; files?: string[] },
    _signal: AbortSignal | undefined,
    _update: unknown,
    ctx: ExtensionContext,
  ) => {
    if (typeof params.question !== "string" || !params.question.trim())
      throw new Error("Question must contain non-whitespace text");
    if (!options.isSoleToolCall(ctx))
      throw new Error(
        "Call ask_owner alone as the final tool call of the turn, with no other tool calls, then wait for the reply.",
      );
    const managed = managedAgentIdentity(ctx);
    const state = options.state();
    if (!state || !options.sameIdentity(state, managed))
      throw new Error("Agent identity is not eligible to ask its owner");
    if (!options.eligible())
      throw new Error(
        `Agent cannot ask its owner: ${options.rejectionReason()}`,
      );
    const askId = randomUUID();
    const askCreatedAt = Date.now();
    const limits = await options.messageLimits(ctx);
    const prepared = await options.prepare(
      ctx,
      params.question,
      params.files,
      state,
      askId,
      askCreatedAt,
      limits,
    );
    const ask: AskRecord = {
      version: 5,
      askId,
      requestId: state.activeRequestId!,
      runId: state.runId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      piSessionId: state.piSessionId,
      question: prepared.text,
      ...(prepared.resultBindings.length
        ? { resultBindings: prepared.resultBindings as any }
        : {}),
      createdAt: askCreatedAt,
    };
    options.checkMailboxSize(mailboxRecordBytes(ask), limits.mailbox.bytes);
    const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
    const release = options.claimLock(mailbox, state);
    try {
      const current = options.readState(mailbox);
      if (!current || !options.sameIdentity(current, state))
        throw new Error("Agent identity changed while asking its owner");
      options.writeAsk(mailbox, ask);
      const next = { ...current, pendingAskId: askId, updatedAt: Date.now() };
      options.writeState(mailbox, next);
      options.setState(next);
    } catch (error) {
      try {
        options.removeAsk(mailbox);
      } catch {}
      throw error;
    } finally {
      release();
    }
    options.latest("");
    return {
      content: [
        {
          type: "text" as const,
          text:
            "Question sent to your owner. This assignment is blocked until the reply; " +
            "the reply will resume it automatically.",
        },
      ],
      details: { askId, assignmentRequestId: ask.requestId },
      terminate: true,
    };
  };
}

export function registerManagedAgentAskOwnerTool(
  pi: ExtensionAPI,
  execute: ReturnType<typeof createManagedAgentAskOwnerHandler>,
): void {
  const files = Type.Optional(
    Type.Array(
      Type.String({
        minLength: 1,
        description:
          'Readable regular local file path or exact result ref such as "result:researcher#1".',
      }),
      {
        description:
          "File or result evidence transferred to the recipient. Copy result refs exactly. Files do not grant runtime capabilities.",
      },
    ),
  );
  pi.registerTool({
    name: "ask_owner",
    label: "Ask owner",
    exposure: "model-only",
    promptSnippet:
      "Ask this managed agent's direct owner for a required decision",
    promptGuidelines: [FILE_HANDOFF_GUIDANCE],
    description:
      "Ask your direct owner for a decision that is required to continue. Call this alone as the final tool call of the turn, then stop and wait for the reply. Only one question may be outstanding.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        question: Type.String({
          minLength: 1,
          description: "Non-empty decision question required to continue.",
        }),
        files,
      },
      { additionalProperties: false },
    ),
    execute,
  });
}

export function registerManagedAgentInputHandlers(
  pi: ExtensionAPI,
  options: {
    state(): ManagedAgentState | undefined;
    setState(state: ManagedAgentState): void;
    initialized(): boolean;
    pendingResult(): boolean;
    pendingStateTransition(): boolean;
    pendingInterruptReplacement(): string | undefined;
    setPendingInterruptReplacement(value: string | undefined): void;
    build: RuntimeBuild;
    sameIdentity(left: ManagedAgentState, right: ManagedAgentState): boolean;
    mutateState(
      update: (state: ManagedAgentState) => ManagedAgentState,
    ): ManagedAgentState | undefined;
    requestState: ReturnType<typeof createManagedAgentRequestState>;
    tryClaimAssignmentLock(mailbox: string): (() => void) | undefined;
    hasPendingDirectChildWork(state: ManagedAgentState): boolean;
    hasUndeliveredDirectChildWork(
      state: ManagedAgentState,
      entries: readonly unknown[],
    ): boolean;
    reportError(ctx: ExtensionContext, error: unknown): void;
    reportMetadata(
      state: ManagedAgentState,
      ctx: ExtensionContext,
      patch: ManagedAgentMetadataPatch,
    ): void;
    setLatest(value: string): void;
    startAgent(): number;
  },
): void {
  pi.on("input", (event: any, ctx: ExtensionContext) => {
    const text = event.text;
    if (typeof text !== "string" || !text.startsWith(RESERVED_PREFIX))
      return { action: "continue" };
    const id = parseControlMarker(text);
    if (!id) return { action: "handled" };
    let request: RequestRecord | undefined;
    try {
      request = readRequest(process.env.PI_HERDSMAN_MAILBOX!, id);
    } catch {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "invalid",
        "Malformed or oversized request",
      );
      return { action: "handled" };
    }
    if (!request) return { action: "handled" };
    let state = options.state();
    if (!options.initialized() || !state) return { action: "handled" };
    if (state.lastAck?.requestId === id) return { action: "handled" };
    if (
      request.runId !== state.runId ||
      request.ownerSessionId !== state.ownerSessionId ||
      request.workspaceId !== state.workspaceId ||
      request.agentLabel !== state.agentLabel ||
      request.paneId !== state.paneId
    ) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "identity",
        "Request identity did not match agent state",
      );
      return { action: "handled" };
    }
    if (!request.build || !sameRuntimeBuild(request.build, options.build)) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "incompatible",
        request.build
          ? `Owner build ${formatRuntimeBuild(request.build)} does not match local ${formatRuntimeBuild(options.build)}`
          : "Owner build identity is unavailable; restart the owner session",
      );
      return { action: "handled" };
    }
    if (request.kind === "reply") {
      let ask: AskRecord | undefined;
      try {
        ask = readPendingAsk(process.env.PI_HERDSMAN_MAILBOX!, state);
      } catch (error) {
        options.reportError(ctx, error);
        options.requestState.acknowledgeAndDiscard(
          id,
          false,
          ctx,
          "identity",
          "Malformed or oversized owner ask",
        );
        return { action: "handled" };
      }
      if (
        !state.activeRequestId ||
        !state.pendingAskId ||
        request.askId !== state.pendingAskId ||
        !ask ||
        ask.askId !== state.pendingAskId ||
        ask.requestId !== state.activeRequestId ||
        ask.runId !== state.runId ||
        ask.ownerSessionId !== state.ownerSessionId ||
        ask.workspaceId !== state.workspaceId ||
        ask.agentLabel !== state.agentLabel ||
        ask.paneId !== state.paneId ||
        ask.piSessionId !== state.piSessionId
      ) {
        options.requestState.acknowledgeAndDiscard(
          id,
          false,
          ctx,
          "identity",
          "Owner reply did not match the pending ask",
        );
        return { action: "handled" };
      }
      try {
        importResultBindings(pi, ctx, request.resultBindings, "reply");
      } catch (error) {
        const ambiguous =
          error instanceof OperationError &&
          error.detail.category === "target_ambiguous";
        options.requestState.acknowledgeAndDiscard(
          id,
          false,
          ctx,
          ambiguous ? "ambiguous" : "delivery",
          error instanceof Error ? error.message : String(error),
        );
        return { action: "handled" };
      }
      const candidate: ManagedAgentState = {
        ...state,
        pendingAskId: undefined,
        lastAck: { requestId: id, accepted: true, acknowledgedAt: Date.now() },
        updatedAt: Date.now(),
      };
      const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
      const release = options.tryClaimAssignmentLock(mailbox);
      if (!release) return { action: "handled" };
      try {
        const current = readAgentState(mailbox);
        if (
          !current ||
          !options.sameIdentity(current, state) ||
          current.pendingAskId !== state.pendingAskId
        )
          return { action: "handled" };
        writeAgentState(mailbox, candidate);
        removeMailboxAsk(mailbox);
      } catch (error) {
        options.requestState.reportAcknowledgementFailure(ctx, error);
        return { action: "handled" };
      } finally {
        release();
      }
      options.setState(candidate);
      options.requestState.reset();
      options.setLatest("");
      return {
        action: "transform",
        text: `Owner reply:\n\n${request.text}\n\nContinue the original assignment using this answer.`,
      };
    }
    const controlRequest =
      request.kind === "steer" || request.kind === "interrupt";
    if (controlRequest && state.pendingAskId) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "busy",
        "Agent is waiting for an owner reply",
      );
      return { action: "handled" };
    }
    if (request.kind === "task" && state.resultError) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "busy",
        state.resultError.nextAction,
      );
      return { action: "handled" };
    }
    if (
      request.kind === "task" &&
      (state.completedRequestId !== undefined ||
        !taskAcceptanceAllowed(
          ctx.isIdle(),
          state.activeRequestId,
          options.pendingResult() || options.pendingStateTransition(),
        ))
    ) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "busy",
        state.completedRequestId
          ? "Agent assignment is already complete"
          : "Agent already has an active assignment",
      );
      return { action: "handled" };
    }
    if (controlRequest && options.pendingInterruptReplacement()) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "busy",
        "Agent interrupt is still settling",
      );
      return { action: "handled" };
    }
    if (
      controlRequest &&
      (options.pendingResult() || options.pendingStateTransition())
    ) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "busy",
        "Agent completion is being published",
      );
      return { action: "handled" };
    }
    const isIdle = ctx.isIdle();
    if (
      request.kind === "interrupt" &&
      (!state.activeRequestId || isIdle || ctx.signal?.aborted)
    ) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "idle",
        "Agent has no active Pi operation to interrupt",
      );
      return { action: "handled" };
    }
    if (
      request.kind === "steer" &&
      !steerAcceptanceAllowed(
        isIdle,
        state.activeRequestId,
        options.pendingStateTransition(),
        isIdle && options.hasPendingDirectChildWork(state),
      )
    ) {
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        "idle",
        "Agent is not accepting steering",
      );
      return { action: "handled" };
    }
    try {
      importResultBindings(pi, ctx, request.resultBindings, request.kind);
    } catch (error) {
      const ambiguous =
        error instanceof OperationError &&
        error.detail.category === "target_ambiguous";
      options.requestState.acknowledgeAndDiscard(
        id,
        false,
        ctx,
        ambiguous ? "ambiguous" : "delivery",
        error instanceof Error ? error.message : String(error),
      );
      return { action: "handled" };
    }
    if (request.kind === "task") {
      const candidate = options.mutateState((current) => ({
        ...current,
        activeRequestId: id,
        completedRequestId: undefined,
        lastActivityAt: Date.now(),
        lastAck: { requestId: id, accepted: true, acknowledgedAt: Date.now() },
        updatedAt: Date.now(),
      }));
      if (!candidate) return { action: "handled" };
      options.requestState.reset();
      const startedAt = options.startAgent();
      const model = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const thinking = ctx.thinkingLevel;
      options.reportMetadata(options.state()!, ctx, {
        activity: { requestId: id, task: request.text, startedAt },
        context: null,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      });
    }
    if (request.kind === "steer" || request.kind === "interrupt") {
      if (!options.requestState.acknowledge(id, true))
        return { action: "handled" };
      options.setLatest("");
      if (request.kind === "interrupt") {
        const editorText =
          ctx.mode === "tui" ? ctx.ui.getEditorText() : undefined;
        options.setPendingInterruptReplacement(
          `Owner interrupt:\n\n${request.text}\n\nThe previous in-flight operation was intentionally aborted. Continue the original assignment using this replacement instruction.`,
        );
        ctx.abort();
        if (editorText !== undefined) ctx.ui.setEditorText(editorText);
        return { action: "handled" };
      }
      return { action: "transform", text: request.text };
    }
    options.setLatest("");
    return { action: "transform", text: request.text };
  });
}

export function registerManagedAgentResultCapture(
  pi: ExtensionAPI,
  options: {
    state(): ManagedAgentState | undefined;
    pendingResult(): boolean;
    delegationEnabled: boolean;
    hasUndeliveredDirectChildWork(
      state: ManagedAgentState,
      entries: readonly unknown[],
    ): boolean;
    setLatest(value: string): void;
  },
): void {
  pi.on("message_end", (event: any, ctx: ExtensionContext) => {
    const state = options.state();
    if (!state?.activeRequestId || options.pendingResult()) return;
    const message = event.message ?? event;
    if (message?.role !== "assistant") return;
    if (
      options.delegationEnabled &&
      options.hasUndeliveredDirectChildWork(
        state,
        ctx.sessionManager.getEntries(),
      )
    )
      return;
    options.setLatest(contentText(message.content, "").trim());
  });
}

export function registerManagedAgentActivityHandlers(
  pi: ExtensionAPI,
  execution: ReturnType<typeof createManagedAgentExecutionState>,
  options: {
    touchActivity(): void;
    resetAssignmentGuidance(): void;
    reportMetadata(
      state: ManagedAgentState,
      ctx: ExtensionContext,
      patch: ManagedAgentMetadataPatch,
    ): void;
  },
): void {
  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    options.touchActivity();
    if (!execution.assignment?.activeRequestId) return;
    const usage = ctx.getContextUsage();
    const percent =
      usage?.percent == null ? undefined : Math.round(usage.percent);
    const model = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const thinking = ctx.thinkingLevel;
    options.reportMetadata(execution.assignment, ctx, {
      context: percent ?? null,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    });
  });
  pi.on("turn_start", () => {
    options.resetAssignmentGuidance();
    options.touchActivity();
  });
  for (const event of [
    "message_update",
    "tool_execution_start",
    "tool_execution_end",
  ])
    pi.on(event, () => options.touchActivity());
  pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
    if (!execution.assignment) return;
    const model = `${event.model.provider}/${event.model.id}`;
    const thinking = ctx.thinkingLevel;
    options.reportMetadata(execution.assignment, ctx, {
      model,
      ...(thinking ? { thinking } : {}),
    });
  });
  pi.on(
    "thinking_level_select",
    (event: ThinkingLevelSelectEvent, ctx: ExtensionContext) => {
      if (!execution.assignment) return;
      const model = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      options.reportMetadata(execution.assignment, ctx, {
        thinking: event.level,
        ...(model ? { model } : {}),
      });
    },
  );
}

export function registerManagedAgentSettlementHandlers(
  pi: ExtensionAPI,
  execution: ReturnType<typeof createManagedAgentExecutionState>,
  options: {
    delegationEnabled: boolean;
    tryClaimAssignmentLock(mailbox: string): (() => void) | undefined;
    sameIdentity(left: ManagedAgentState, right: ManagedAgentState): boolean;
    hasUndeliveredDirectChildWork(
      state: ManagedAgentState,
      entries: readonly unknown[],
    ): boolean;
    reportMetadata(
      state: ManagedAgentState,
      ctx: ExtensionContext,
      patch: ManagedAgentMetadataPatch,
    ): void;
    appendStateError(ctx: ExtensionContext, error: unknown): void;
    appendResultError(ctx: ExtensionContext, error: unknown): void;
    resultWriteMaxAttempts: number;
    settleControllerResults(ctx: ExtensionContext): Promise<void>;
  },
): { cleanup(): void } {
  const finalizeStateTransition = (
    ctx: ExtensionContext,
    assignmentLockHeld = false,
  ): void => {
    if (!execution.assignment?.activeRequestId) return;
    execution.pendingStateTransition = true;
    let release: (() => void) | undefined;
    try {
      if (!assignmentLockHeld) {
        release = options.tryClaimAssignmentLock(
          process.env.PI_HERDSMAN_MAILBOX!,
        );
        if (!release) {
          if (!execution.stateRetryTimer)
            execution.stateRetryTimer = setInterval(
              () => finalizeStateTransition(ctx),
              250,
            );
          return;
        }
      }
      const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
      const current = readAgentState(mailbox);
      if (
        !current ||
        !options.sameIdentity(current, execution.assignment) ||
        !current.activeRequestId
      ) {
        if (execution.stateRetryTimer) clearInterval(execution.stateRetryTimer);
        execution.stateRetryTimer = undefined;
        return;
      }
      const nextState: ManagedAgentState = {
        ...current,
        completedRequestId: current.activeRequestId,
        activeRequestId: undefined,
        lastActivityAt: undefined,
        updatedAt: Date.now(),
      };
      writeAgentState(mailbox, nextState);
      execution.assignment = nextState;
      execution.agentStartedAt = undefined;
      const model = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const thinking = ctx.thinkingLevel;
      execution.pendingStateTransition = false;
      execution.stateErrorReported = false;
      if (execution.stateRetryTimer) clearInterval(execution.stateRetryTimer);
      execution.stateRetryTimer = undefined;
      execution.latest = "";
      options.reportMetadata(nextState, ctx, {
        activity: null,
        context: null,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      });
    } catch (error) {
      if (!execution.stateErrorReported) {
        execution.stateErrorReported = true;
        options.appendStateError(ctx, error);
      }
      if (!execution.stateRetryTimer)
        execution.stateRetryTimer = setInterval(
          () => finalizeStateTransition(ctx),
          250,
        );
    } finally {
      release?.();
    }
  };
  const settleCurrentAgent = (
    ctx: ExtensionContext,
    aborted: boolean,
  ): void => {
    const state = execution.assignment;
    if (
      !state?.activeRequestId ||
      state.pendingAskId ||
      execution.pendingResult ||
      execution.pendingStateTransition
    )
      return;
    if (
      options.delegationEnabled &&
      options.hasUndeliveredDirectChildWork(
        state,
        ctx.sessionManager.getEntries(),
      )
    )
      return;
    const completed = !aborted && Boolean(execution.latest);
    const result: ResultRecord = {
      version: 5,
      runId: state.runId,
      requestId: state.activeRequestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: completed ? "completed" : "failed",
      ...(completed
        ? { text: execution.latest }
        : {
            error: {
              code: aborted ? "aborted" : "empty_result",
              message: aborted
                ? "Agent execution was cancelled"
                : "Agent produced no assistant text",
            },
          }),
      contextUsage: ctx.getContextUsage(),
      completedAt: Date.now(),
    };
    execution.pendingResult = result;
    execution.resultWriteAttempts = 0;
    execution.resultErrorReported = false;
    const flush = (assignmentLockHeld = false) => {
      const current = execution.pendingResult;
      if (!current) return;
      const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
      let release: (() => void) | undefined;
      try {
        if (!assignmentLockHeld) {
          release = options.tryClaimAssignmentLock(mailbox);
          if (!release) return;
        }
        const currentState = readAgentState(mailbox);
        if (
          !currentState ||
          !execution.assignment ||
          !options.sameIdentity(currentState, execution.assignment) ||
          currentState.activeRequestId !== current.requestId
        ) {
          execution.pendingResult = undefined;
          if (execution.retryTimer) clearInterval(execution.retryTimer);
          execution.retryTimer = undefined;
          return;
        }
        execution.resultWriteAttempts++;
        writeResult(mailbox, current);
        execution.pendingResult = undefined;
        if (execution.retryTimer) clearInterval(execution.retryTimer);
        execution.retryTimer = undefined;
        finalizeStateTransition(ctx, true);
      } catch (error) {
        if (
          current.status === "completed" &&
          String(error).toLowerCase().includes("too large")
        ) {
          execution.pendingResult = {
            ...current,
            status: "failed",
            text: undefined,
            error: {
              code: "result_too_large",
              message:
                "Agent assistant response exceeded the mailbox result limit",
            },
          };
          execution.resultWriteAttempts = 0;
          flush(true);
          return;
        }
        if (execution.resultWriteAttempts >= options.resultWriteMaxAttempts) {
          const recovery: ResultPersistenceError = {
            code: "write_failure",
            message: `Could not persist agent result after ${execution.resultWriteAttempts} attempts: ${String(error).slice(0, 512)}`,
            requestId: current.requestId,
            runId: current.runId,
            ownerSessionId: current.ownerSessionId,
            workspaceId: current.workspaceId,
            agentLabel: current.agentLabel,
            paneId: current.paneId,
            originalStatus: current.status,
            attempts: execution.resultWriteAttempts,
            failedAt: Date.now(),
            retrySafe: false,
            cleanupSafe: true,
            nextAction:
              "Resolve the mailbox persistence failure described by result_error, then use close_agent before starting another assignment.",
          };
          try {
            const currentAssignment = execution.assignment;
            if (!currentAssignment) return;
            const nextState: ManagedAgentState = {
              ...currentAssignment,
              activeRequestId: undefined,
              completedRequestId: undefined,
              lastActivityAt: undefined,
              resultError: recovery,
              updatedAt: Date.now(),
            };
            writeAgentState(mailbox, nextState);
            execution.assignment = nextState;
            execution.pendingResult = undefined;
            if (execution.retryTimer) clearInterval(execution.retryTimer);
            execution.retryTimer = undefined;
            execution.agentStartedAt = undefined;
            execution.latest = "";
            options.reportMetadata(nextState, ctx, {
              activity: null,
              context: null,
            });
          } catch (recoveryError) {
            options.appendResultError(
              ctx,
              JSON.stringify({
                recovery,
                recoveryError: String(recoveryError),
              }),
            );
            if (execution.retryTimer) clearInterval(execution.retryTimer);
            execution.retryTimer = undefined;
          }
          return;
        }
        if (!execution.resultErrorReported) {
          execution.resultErrorReported = true;
          options.appendResultError(ctx, error);
        }
      } finally {
        release?.();
      }
    };
    flush();
    if (execution.pendingResult && !execution.retryTimer)
      execution.retryTimer = setInterval(flush, 250);
  };
  pi.on(
    "agent_settled",
    async (event: { aborted: boolean }, ctx: ExtensionContext) => {
      if (execution.pendingInterruptReplacement) {
        const replacement = execution.pendingInterruptReplacement;
        execution.pendingInterruptReplacement = undefined;
        execution.latest = "";
        pi.sendUserMessage(replacement);
        return;
      }
      settleCurrentAgent(ctx, event.aborted);
      await options.settleControllerResults(ctx).catch(() => {});
    },
  );
  return {
    cleanup() {
      if (execution.retryTimer) clearInterval(execution.retryTimer);
      execution.retryTimer = undefined;
      if (execution.stateRetryTimer) clearInterval(execution.stateRetryTimer);
      execution.stateRetryTimer = undefined;
    },
  };
}

export function registerManagedAgentShutdownHandler(
  pi: ExtensionAPI,
  execution: ReturnType<typeof createManagedAgentExecutionState>,
  options: {
    resetRequestPump(): void;
    resetLeafStatus(): void;
    statusRuntime: ReturnType<typeof createAgentStatusRuntime>;
    abortMetadata(): void;
    setControllerReady(ready: boolean): void;
    clearControllerRuntimes(): void;
    cleanupResultTimers(): void;
    shutdownController(): void;
  },
): void {
  pi.on("session_shutdown", () => {
    options.shutdownController();
    options.statusRuntime.shutdown();
    execution.pendingInterruptReplacement = undefined;
    options.resetLeafStatus();
    options.abortMetadata();
    execution.initialized = false;
    options.resetRequestPump();
    options.setControllerReady(false);
    execution.assignment = undefined;
    options.clearControllerRuntimes();
    options.cleanupResultTimers();
  });
}

export function registerManagedAgentRuntime(
  pi: ExtensionAPI,
  options: {
    build: RuntimeBuild;
    shellTimeoutSeconds: number;
    statusRuntime: ReturnType<typeof createAgentStatusRuntime>;
    controllerOptions: Omit<AgentControllerOptions, "scope" | "build">;
    activityWriteMinMs: number;
    resultWriteMaxAttempts: number;
    tryClaimAssignmentLock(mailbox: string): (() => void) | undefined;
    claimAssignmentLock(
      mailbox: string,
      operation: string,
      ids: { label?: string; paneId?: string },
    ): () => void;
    messageLimits(
      ctx: ExtensionContext,
    ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
    resolveMessageFiles(
      ctx: ExtensionContext,
      files: string[] | undefined,
      operation: string,
    ): any;
    appendError(ctx: ExtensionContext, kind: string, error: unknown): void;
    getAgentDefinitions(ctx: ExtensionContext): Promise<AgentDefinition[]>;
  },
): void {
  pi.on("tool_call", (event: any) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const tool = pi
      .getAllTools()
      .find((candidate) => candidate.name === event.toolName);
    const properties = (tool?.parameters as any)?.properties;
    if (
      tool?.sourceInfo?.source === "builtin" &&
      properties &&
      Object.prototype.hasOwnProperty.call(properties, "timeout") &&
      !Object.prototype.hasOwnProperty.call(event.input, "timeout")
    )
      event.input.timeout = options.shellTimeoutSeconds;
  });
  const allowedAgentDefinitions = allowedAgentDefinitionsFromEnv();
  const delegationEnabled = allowedAgentDefinitions.length > 0;
  let startupDefinitionRoster:
    { sessionId: string; definitions: Record<string, unknown>[] } | undefined;
  const controller = delegationEnabled
    ? createAgentController(pi, {
        ...options.controllerOptions,
        scope: {
          kind: "managed-agent",
          allowedAgentDefinitions: new Set(allowedAgentDefinitions),
        },
        build: options.build,
      })
    : undefined;
  if (controller) {
    const scope = {
      kind: "managed-agent" as const,
      allowedAgentDefinitions: new Set(allowedAgentDefinitions),
    };
    options.statusRuntime.configure({
      pendingStartEntries: () => controller.pendingStartEntries(),
      hasPendingStart: (label) => controller.hasPendingStart(label),
      clearPendingStart: (label, expected) =>
        controller.clearPendingStart(label, expected),
      runtimeForLabel: (label) => controller.runtimeForLabel(label),
      ownToolsSnapshot: () => ({}),
      focusTarget: async (ctx, intent, isCurrent) => {
        if (intent.kind !== "session")
          throw new Error("Manager navigation is unavailable from an Agent.");
        const signal = controller.sessionSignal();
        if (!signal) throw new Error("Agent session is no longer active.");
        const ownerSessionId = ctx.sessionManager.getSessionId();
        const view = await controller.agentSnapshotView(
          ctx,
          scope,
          signal,
          true,
          false,
        );
        const fresh = buildAgentStatusSnapshot(view, ctx, {
          scope,
          listedAgentRecord: controller.listedAgentRecord,
          runtimeForLabel: controller.runtimeForLabel,
          environmentIdentity: (context) =>
            managedAgentEnvironmentIdentity(context, options.build),
          identityFromEnvironment: () => ({
            definition: process.env.PI_HERDSMAN_AGENT_DEFINITION,
            label: process.env.PI_HERDSMAN_LABEL,
          }),
          sameIdentity: sameManagedAgentIdentity,
          ownToolsSnapshot: () => ({}),
        });
        const currentIdentity = managedAgentEnvironmentIdentity(
          ctx,
          options.build,
        );
        const breadcrumb = currentIdentity
          ? statusBreadcrumb(
              view,
              currentIdentity,
              {
                definition: process.env.PI_HERDSMAN_AGENT_DEFINITION,
                label: process.env.PI_HERDSMAN_LABEL,
              },
              sameManagedAgentIdentity,
            )
          : [];
        const statusTarget = fresh.agents.filter(
          (agent) => agent.sessionId === intent.sessionId,
        );
        const isAncestor = breadcrumb.some(
          (segment) => segment.sessionId === intent.sessionId,
        );
        if (
          !isCurrent() ||
          signal.aborted ||
          ctx.sessionManager.getSessionId() !== ownerSessionId ||
          (statusTarget.length !== 1 && !isAncestor)
        )
          throw new Error("Agent changed; reopen status.");
        if (
          statusTarget.length === 1 &&
          (statusTarget[0]!.state === "unknown" ||
            statusTarget[0]!.state === "lost" ||
            statusTarget[0]!.state === "starting" ||
            !statusTarget[0]!.paneId)
        )
          throw new Error("Agent changed; reopen status.");
        const { agents } = await listAllHerdrAgents(pi, ctx, signal);
        const live = agents.filter(
          (agent) =>
            herdrSessionId(agent) === intent.sessionId &&
            typeof agent.pane_id === "string",
        );
        if (
          signal.aborted ||
          !isCurrent() ||
          live.length !== 1 ||
          (statusTarget.length === 1 &&
            live[0]!.pane_id !== statusTarget[0]!.paneId)
        )
          throw new Error("Agent changed; reopen status.");
        const current = await runHerdr(
          pi,
          ctx,
          ["agent", "get", live[0]!.pane_id],
          { signal },
        );
        if (
          signal.aborted ||
          !isCurrent() ||
          herdrSessionId(current?.agent) !== intent.sessionId ||
          current?.agent?.pane_id !== live[0]!.pane_id ||
          current?.agent?.workspace_id !== live[0]!.workspace_id ||
          current?.agent?.tab_id !== live[0]!.tab_id
        )
          throw new Error("Agent changed; reopen status.");
        await runHerdr(pi, ctx, ["agent", "focus", current.agent.pane_id], {
          signal,
        });
      },
      loadSnapshot: async (ctx) => {
        const view = await controller.agentSnapshotView(
          ctx,
          scope,
          controller.sessionSignal(),
          true,
          false,
        );
        return buildAgentStatusSnapshot(view, ctx, {
          scope,
          listedAgentRecord: controller.listedAgentRecord,
          runtimeForLabel: controller.runtimeForLabel,
          environmentIdentity: (context: ExtensionContext) =>
            managedAgentEnvironmentIdentity(context, options.build),
          identityFromEnvironment: () => ({
            definition: process.env.PI_HERDSMAN_AGENT_DEFINITION,
            label: process.env.PI_HERDSMAN_LABEL,
          }),
          sameIdentity: sameManagedAgentIdentity,
          ownToolsSnapshot: () => ({}),
        });
      },
    });
  }
  controller?.registerTools(new Map());
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
    const definition = process.env.PI_HERDSMAN_AGENT_DEFINITION!;
    const label = process.env.PI_HERDSMAN_LABEL!;
    event.systemPromptOptions.sections.pi_herdsman_agent = [
      `identity: ${displayIdentity(definition, label)}`,
      `direct_owner: ${process.env.PI_HERDSMAN_OWNER_DISPLAY!}`,
    ].join("\n");
    if (delegationEnabled) {
      const roster = startupDefinitionRoster;
      const availableRoster =
        roster?.sessionId === ctx.sessionManager.getSessionId()
          ? roster
          : undefined;
      event.systemPromptOptions.sections.delegating_agent_role =
        DELEGATING_AGENT_ROLE_CHARTER;
      if (availableRoster)
        event.systemPromptOptions.sections.agent_definitions =
          `${JSON.stringify(availableRoster.definitions, null, 2)}\n\n` +
          `This is the session-start definition snapshot. ` +
          `Use list_agents for live Agent state or to refresh Agent definitions after configuration changes.`;
    }
  });
  const execution = createManagedAgentExecutionState();
  const metadataPublisher = createManagedAgentMetadataPublisher(pi);
  const leafStatus = createManagedAgentLeafStatus({
    snapshot: (ctx, signal) =>
      managedAgentSnapshots(
        pi,
        ctx,
        options.controllerOptions.snapshotDependencies,
        signal,
        true,
        false,
        undefined,
        false,
      ),
    identity: (ctx) => managedAgentEnvironmentIdentity(ctx, options.build),
    sameIdentity: sameManagedAgentIdentity,
    signal: () => metadataPublisher.signal,
    focusTarget: async (ctx, intent, isCurrent) => {
      if (intent.kind !== "session")
        throw new Error("Manager navigation is unavailable from an Agent.");
      const signal = metadataPublisher.signal;
      const sessionId = ctx.sessionManager.getSessionId();
      const snapshot = await managedAgentSnapshots(
        pi,
        ctx,
        options.controllerOptions.snapshotDependencies,
        signal,
        true,
        false,
        undefined,
        false,
      );
      const identity = managedAgentEnvironmentIdentity(ctx, options.build);
      const breadcrumb = identity
        ? statusBreadcrumb(
            snapshot,
            identity,
            {
              definition: process.env.PI_HERDSMAN_AGENT_DEFINITION,
              label: process.env.PI_HERDSMAN_LABEL,
            },
            sameManagedAgentIdentity,
          )
        : [];
      if (
        signal?.aborted ||
        !isCurrent() ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        !breadcrumb.some((segment) => segment.sessionId === intent.sessionId)
      )
        throw new Error("Agent ancestry changed; reopen status.");
      const { agents } = await listAllHerdrAgents(pi, ctx, signal);
      const matches = agents.filter(
        (agent) =>
          herdrSessionId(agent) === intent.sessionId &&
          typeof agent.pane_id === "string",
      );
      if (signal?.aborted || !isCurrent() || matches.length !== 1)
        throw new Error("Agent changed; reopen status.");
      const current = await runHerdr(
        pi,
        ctx,
        ["agent", "get", matches[0]!.pane_id],
        { signal },
      );
      if (
        signal?.aborted ||
        !isCurrent() ||
        herdrSessionId(current?.agent) !== intent.sessionId ||
        current?.agent?.pane_id !== matches[0]!.pane_id ||
        current?.agent?.workspace_id !== matches[0]!.workspace_id ||
        current?.agent?.tab_id !== matches[0]!.tab_id
      )
        throw new Error("Agent changed; reopen status.");
      await runHerdr(pi, ctx, ["agent", "focus", current.agent.pane_id], {
        signal,
      });
    },
  });
  const mutateAgentState = (
    update: (current: ManagedAgentState) => ManagedAgentState,
  ): ManagedAgentState | undefined => {
    const state = execution.assignment;
    if (!state) return undefined;
    const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
    const release = options.tryClaimAssignmentLock(mailbox);
    if (!release) return undefined;
    try {
      const current = readAgentState(mailbox);
      if (!current || !sameManagedAgentIdentity(current, state))
        return undefined;
      const next = update(current);
      writeAgentState(mailbox, next);
      execution.assignment = next;
      execution.mutationErrorReported = false;
      return next;
    } catch (error) {
      if (execution.agentContext && !execution.mutationErrorReported)
        options.appendError(
          execution.agentContext,
          "pi_herdsman_state_error",
          error,
        );
      execution.mutationErrorReported = true;
      return undefined;
    } finally {
      release();
    }
  };
  const requestState = createManagedAgentRequestState(pi, {
    state: () => execution.assignment,
    setState: (state) => {
      execution.assignment = state;
    },
    initialized: () => execution.initialized,
    mutateState: mutateAgentState,
    pendingResult: () => !!execution.pendingResult,
    pendingStateTransition: () => execution.pendingStateTransition,
    allDirectChildrenAskBlocked: (state) =>
      (controller?.allDirectChildrenAskBlocked ?? allDirectChildrenAskBlocked)(
        state,
      ),
    tryClaimAssignmentLock: options.tryClaimAssignmentLock,
    sameIdentity: sameManagedAgentIdentity,
    activeContext: () => execution.agentContext,
    appendError: (ctx, error) =>
      options.appendError(ctx, "pi_herdsman_state_error", error),
  });
  const touchActivity = (now = Date.now(), force = false): void => {
    const state = execution.assignment;
    if (!state?.activeRequestId || execution.pendingResult) return;
    if (
      !force &&
      state.lastActivityAt !== undefined &&
      now >= state.lastActivityAt &&
      now - state.lastActivityAt < options.activityWriteMinMs
    )
      return;
    mutateAgentState((current) => ({
      ...current,
      lastActivityAt: now,
      updatedAt: now,
    }));
  };
  const resetRequestPump = (): void => {
    execution.stopRequestObserver?.();
    execution.stopRequestObserver = undefined;
    requestState.reset();
  };
  const clearAgentRuntimes = () => controller?.clearRuntimes();
  if (controller) {
    pi.on("session_tree", (_event: unknown, ctx: ExtensionContext) => {
      if (controller.sessionActive())
        controller.sessionTreeChanged(ctx, controller.sessionSignal());
    });
  }
  registerManagedAgentAskOwnerTool(
    pi,
    createManagedAgentAskOwnerHandler({
      state: () => execution.assignment,
      setState: (state) => {
        execution.assignment = state;
      },
      sameIdentity: sameManagedAgentIdentity,
      eligible: requestState.eligibleToAsk,
      rejectionReason: requestState.askRejectionReason,
      isSoleToolCall: (ctx) => currentTurnIsSoleToolCall(ctx, "ask_owner"),
      messageLimits: options.messageLimits,
      prepare: (ctx, question, files, state, askId, createdAt, limits) =>
        prepareMessageInput(
          question,
          options.resolveMessageFiles(ctx, files, "ask_owner"),
          state.cwd,
          "ask_owner",
          "Question",
          {
            inlineLimitBytes: limits.inline.bytes,
            mailboxLimitBytes: limits.mailbox.bytes,
            serializedBytes: (text, bindings) =>
              askRecordBytes(
                state,
                askId,
                text,
                createdAt,
                bindings as ResultBinding[],
              ),
          },
        ),
      checkMailboxSize: (bytes, limit) => {
        if (bytes > limit)
          fail(
            "invalid_request",
            `Mailbox payload is ${bytes} bytes; configured limit is ${limit} bytes`,
            "ask_owner",
          );
      },
      claimLock: (mailbox, state) =>
        options.claimAssignmentLock(mailbox, "ask_owner", {
          label: state.agentLabel,
          paneId: state.paneId,
        }),
      readState: readAgentState,
      writeState: writeAgentState,
      writeAsk,
      removeAsk: removeMailboxAsk,
      latest: (value) => {
        execution.latest = value;
      },
    }),
  );
  const prepareDelegatingRoster = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    startupDefinitionRoster = undefined;
    if (!delegationEnabled) return;
    try {
      startupDefinitionRoster = {
        sessionId: ctx.sessionManager.getSessionId(),
        definitions: managedAgentDefinitionRoster(
          await options.getAgentDefinitions(ctx),
          allowedAgentDefinitions,
        ),
      };
    } catch (error) {
      options.appendError(ctx, "pi_herdsman_definition_error", error);
    }
  };
  registerManagedAgentSessionStartHandler(pi, execution, {
    build: options.build,
    delegationEnabled,
    statusRuntime: options.statusRuntime,
    startControllerSession: () => {
      if (!controller) return;
      controller.abortSession();
      controller.beginSession();
      controller.sessionStart();
    },
    resetRequestPump,
    resetLeafStatus: leafStatus.reset,
    captureOwnTools: leafStatus.captureOwnTools,
    getActiveTools: () => pi.getActiveTools(),
    clearControllerRuntimes: clearAgentRuntimes,
    setControllerReady: (ready) => controller?.setReady(ready),
    beginMetadataSession: metadataPublisher.beginSession,
    prepareDelegatingRoster,
    reportMetadata: (state, ctx, patch, reset) =>
      metadataPublisher.report(state, ctx, patch, reset),
    environmentIdentity: (ctx) =>
      managedAgentEnvironmentIdentity(ctx, options.build),
    ensureAgentIdentity: (ctx) =>
      ensureManagedAgentIdentity(
        pi,
        ctx,
        process.env.PI_HERDSMAN_AGENT_DEFINITION!,
        process.env.PI_HERDSMAN_LABEL!,
      ),
    getAgentDefinitions: options.getAgentDefinitions,
    sameIdentity: sameManagedAgentIdentity,
    sameDurableState: sameManagedAgentDurableState,
    claimAssignmentLock: options.claimAssignmentLock,
    recoverControllerRuntimes: (ctx, signal) =>
      controller!.recoverRuntimes(ctx, signal),
    startControllerHealthScanner: (ctx, signal) =>
      controller!.startHealthScanner(ctx, signal),
    touchActivity,
    pumpRequest: requestState.pump,
    startLeafStatus: leafStatus.start,
    appendError: (ctx, error) =>
      options.appendError(ctx, "pi_herdsman_state_error", error),
  });
  registerManagedAgentInputHandlers(pi, {
    state: () => execution.assignment,
    setState: (state) => {
      execution.assignment = state;
    },
    initialized: () => execution.initialized,
    pendingResult: () => !!execution.pendingResult,
    pendingStateTransition: () => execution.pendingStateTransition,
    pendingInterruptReplacement: () => execution.pendingInterruptReplacement,
    setPendingInterruptReplacement: (value) => {
      execution.pendingInterruptReplacement = value;
    },
    build: options.build,
    sameIdentity: sameManagedAgentIdentity,
    mutateState: mutateAgentState,
    requestState,
    tryClaimAssignmentLock: options.tryClaimAssignmentLock,
    hasPendingDirectChildWork: (state) =>
      (controller?.hasPendingDirectChildWork ?? hasPendingDirectChildWork)(
        state,
      ),
    hasUndeliveredDirectChildWork: (state, entries) =>
      (
        controller?.hasUndeliveredDirectChildWork ??
        hasUndeliveredDirectChildWork
      )(state, entries),
    reportError: (ctx, error) =>
      options.appendError(ctx, "pi_herdsman_state_error", error),
    reportMetadata: (state, ctx, patch) =>
      metadataPublisher.report(state, ctx, patch),
    setLatest: (value) => {
      execution.latest = value;
    },
    startAgent: () => (execution.agentStartedAt = Date.now()),
  });
  registerManagedAgentResultCapture(pi, {
    state: () => execution.assignment,
    pendingResult: () => !!execution.pendingResult,
    delegationEnabled,
    hasUndeliveredDirectChildWork: (state, entries) =>
      (
        controller?.hasUndeliveredDirectChildWork ??
        hasUndeliveredDirectChildWork
      )(state, entries),
    setLatest: (value) => {
      execution.latest = value;
    },
  });
  registerManagedAgentActivityHandlers(pi, execution, {
    touchActivity,
    resetAssignmentGuidance: () => controller?.resetAssignmentGuidance(),
    reportMetadata: (state, ctx, patch) =>
      metadataPublisher.report(state, ctx, patch),
  });
  const resultLifecycle = registerManagedAgentSettlementHandlers(
    pi,
    execution,
    {
      delegationEnabled,
      tryClaimAssignmentLock: options.tryClaimAssignmentLock,
      sameIdentity: sameManagedAgentIdentity,
      hasUndeliveredDirectChildWork: (state, entries) =>
        (
          controller?.hasUndeliveredDirectChildWork ??
          hasUndeliveredDirectChildWork
        )(state, entries),
      reportMetadata: (state, ctx, patch) =>
        metadataPublisher.report(state, ctx, patch),
      appendStateError: (ctx, error) =>
        options.appendError(ctx, "pi_herdsman_state_error", error),
      appendResultError: (ctx, error) =>
        options.appendError(ctx, "pi_herdsman_result_error", error),
      resultWriteMaxAttempts: options.resultWriteMaxAttempts,
      settleControllerResults: (ctx) =>
        controller
          ? controller.settleResults(ctx, controller.sessionSignal())
          : Promise.resolve(),
    },
  );
  registerManagedAgentShutdownHandler(pi, execution, {
    resetRequestPump,
    statusRuntime: options.statusRuntime,
    resetLeafStatus: leafStatus.reset,
    abortMetadata: metadataPublisher.abort,
    setControllerReady: (ready) => controller?.setReady(ready),
    clearControllerRuntimes: clearAgentRuntimes,
    cleanupResultTimers: resultLifecycle.cleanup,
    shutdownController: () => {
      if (!controller) return;
      controller.abortSession();
      controller.clearSession();
      controller.markSessionInactive();
      controller.stopHealthScanner();
      controller.shutdown();
    },
  });
  registerManagedAgentContextHandlers(pi, {
    contextRetirementEnabled: () => readConfig().contextRetirement,
    hasActiveAssignment: () => !!execution.assignment?.activeRequestId,
  });
}

export function createManagedAgentRequestState(
  pi: ExtensionAPI,
  options: {
    state(): ManagedAgentState | undefined;
    setState(state: ManagedAgentState): void;
    initialized(): boolean;
    mutateState(
      update: (state: ManagedAgentState) => ManagedAgentState,
    ): ManagedAgentState | undefined;
    pendingResult(): boolean;
    pendingStateTransition(): boolean;
    allDirectChildrenAskBlocked(state: ManagedAgentState): boolean;
    tryClaimAssignmentLock(mailbox: string): (() => void) | undefined;
    sameIdentity(left: ManagedAgentState, right: ManagedAgentState): boolean;
    appendError(ctx: ExtensionContext, error: unknown): void;
    activeContext(): ExtensionContext | undefined;
  },
) {
  let requestPumpErrorReported = false;
  let acknowledgementErrorReported = false;
  const acknowledge = (
    requestId: string,
    accepted: boolean,
    code?:
      | "busy"
      | "idle"
      | "invalid"
      | "identity"
      | "delivery"
      | "incompatible"
      | "ambiguous",
    message?: string,
  ): boolean => {
    const state = options.state();
    if (!state) return false;
    const next = options.mutateState((current) => ({
      ...current,
      lastAck: {
        requestId,
        accepted,
        ...(code ? { code } : {}),
        ...(message ? { message } : {}),
        acknowledgedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }));
    if (next) {
      acknowledgementErrorReported = false;
      return true;
    }
    return false;
  };
  const acknowledgeAndDiscard = (
    requestId: string,
    accepted: boolean,
    ctx: ExtensionContext,
    code?:
      | "busy"
      | "idle"
      | "invalid"
      | "identity"
      | "delivery"
      | "incompatible"
      | "ambiguous",
    message?: string,
  ): void => {
    const state = options.state();
    if (!state) return;
    const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
    const release = options.tryClaimAssignmentLock(mailbox);
    if (!release) return;
    try {
      const current = readAgentState(mailbox);
      if (!current || !options.sameIdentity(current, state)) return;
      const next = {
        ...current,
        lastAck: {
          requestId,
          accepted,
          ...(code ? { code } : {}),
          ...(message ? { message } : {}),
          acknowledgedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      writeAgentState(mailbox, next);
      removeRequest(mailbox, requestId);
      options.setState(next);
      acknowledgementErrorReported = false;
    } catch (error) {
      reportAcknowledgementFailure(ctx, error);
    } finally {
      release();
    }
  };
  const pump = (ctx: ExtensionContext): void => {
    const state = options.state();
    if (!options.initialized() || !state) return;
    try {
      const request = readUnacknowledgedRequest(
        process.env.PI_HERDSMAN_MAILBOX!,
        state,
      );
      if (!request) {
        requestPumpErrorReported = false;
        acknowledgementErrorReported = false;
        return;
      }
      pi.sendUserMessage(controlMarker(request.requestId), {
        deliverAs: "steer",
      });
    } catch (error) {
      if (!requestPumpErrorReported) {
        requestPumpErrorReported = true;
        options.appendError(ctx, error);
      }
    }
  };
  const eligibleToAsk = (): boolean => {
    const state = options.state();
    return (
      !!state?.activeRequestId &&
      !state.pendingAskId &&
      !state.completedRequestId &&
      !options.pendingResult() &&
      !options.pendingStateTransition() &&
      !unacknowledgedRequestExists(process.env.PI_HERDSMAN_MAILBOX!, state) &&
      options.allDirectChildrenAskBlocked(state)
    );
  };
  const askRejectionReason = (): string => {
    const state = options.state();
    if (!state?.activeRequestId) return "no active assignment";
    if (state.pendingAskId) return "already waiting for an owner reply";
    if (state.completedRequestId || options.pendingResult())
      return "assignment is settling";
    if (options.pendingStateTransition()) return "assignment state is settling";
    if (unacknowledgedRequestExists(process.env.PI_HERDSMAN_MAILBOX!, state))
      return "a control request is still pending";
    if (!options.allDirectChildrenAskBlocked(state))
      return "direct agent work is still active";
    return "agent state is not eligible";
  };
  const reportAcknowledgementFailure = (
    ctx: ExtensionContext,
    error: unknown,
  ) => {
    if (!acknowledgementErrorReported) options.appendError(ctx, error);
    acknowledgementErrorReported = true;
  };
  const reset = () => {
    requestPumpErrorReported = false;
    acknowledgementErrorReported = false;
  };
  return {
    acknowledge,
    acknowledgeAndDiscard,
    pump,
    eligibleToAsk,
    askRejectionReason,
    reportAcknowledgementFailure,
    reset,
  };
}

function parseAllowedAgentDefinitions(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS must be a JSON string array",
    );
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error(
      "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS must be a JSON array of unique non-empty strings",
    );
  return value;
}

export function allowedAgentDefinitionsFromEnv(): string[] {
  return parseAllowedAgentDefinitions(
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS,
  );
}

export function managedAgentEnvironmentError(): string | undefined {
  const e = process.env;
  if (!e.PI_HERDSMAN_MAILBOX) return "PI_HERDSMAN_MAILBOX missing";
  if (!isAbsolute(e.PI_HERDSMAN_MAILBOX))
    return "PI_HERDSMAN_MAILBOX is not absolute";
  if (!validId(e.PI_HERDSMAN_RUN_ID)) return "PI_HERDSMAN_RUN_ID invalid";
  if (!validId(e.PI_HERDSMAN_OWNER_SESSION_ID))
    return "PI_HERDSMAN_OWNER_SESSION_ID invalid";
  if (!e.PI_HERDSMAN_OWNER_DISPLAY?.trim())
    return "PI_HERDSMAN_OWNER_DISPLAY missing";
  if (!e.PI_HERDSMAN_LABEL || !AGENT_LABEL_PATTERN.test(e.PI_HERDSMAN_LABEL))
    return "PI_HERDSMAN_LABEL invalid";
  if (!e.PI_HERDSMAN_WORKSPACE_ID?.trim())
    return "PI_HERDSMAN_WORKSPACE_ID missing";
  if (
    agentMailboxPath(e.PI_HERDSMAN_WORKSPACE_ID, e.PI_HERDSMAN_LABEL) !==
    e.PI_HERDSMAN_MAILBOX
  )
    return "PI_HERDSMAN_MAILBOX does not match workspace/label";
  if (!e.PI_HERDSMAN_AGENT_DEFINITION?.trim())
    return "PI_HERDSMAN_AGENT_DEFINITION missing";
  if (!e.HERDR_PANE_ID?.trim()) return "HERDR_PANE_ID missing";
  try {
    parseAllowedAgentDefinitions(e.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS);
  } catch (error) {
    return String(error).replace(/^Error: /, "");
  }
  return undefined;
}

export function sessionContextRetired(
  entries: readonly unknown[],
  sessionId: string,
): boolean {
  return entries.some(
    (entry: any) =>
      entry?.type === "custom" &&
      entry.customType === AGENT_CONTEXT_RETIRED_ENTRY &&
      entry.data?.sessionId === sessionId,
  );
}

function sessionRetirementGuidanceVisible(
  ctx: ExtensionContext,
  sessionId: string,
): boolean {
  return buildSessionProjection(ctx.sessionManager.getBranch()).entries.some(
    ({ sourceEntry, messages }: any) =>
      sourceEntry.type === "custom_message" &&
      sourceEntry.customType === AGENT_CONTEXT_RETIRED_ENTRY &&
      sourceEntry.details?.sessionId === sessionId &&
      messages.length > 0,
  );
}

export function registerManagedAgentContextHandlers(
  pi: ExtensionAPI,
  options: {
    contextRetirementEnabled(): boolean;
    hasActiveAssignment(): boolean;
  },
): void {
  let pendingGuidance: { sessionId: string; content: string } | undefined;
  let queuedGuidanceSessionId: string | undefined;
  let bridgedGuidanceSessionId: string | undefined;
  pi.on(
    "session_before_compact",
    (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
      if (!options.contextRetirementEnabled()) return;
      if (!options.hasActiveAssignment()) return;
      if (event.reason === "manual") return;

      const sessionId = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.getEntries();
      const retired = sessionContextRetired(entries, sessionId);
      const guided = sessionRetirementGuidanceVisible(ctx, sessionId);
      let guidance: string | undefined;
      if (!retired) pi.appendEntry(AGENT_CONTEXT_RETIRED_ENTRY, { sessionId });
      if (guided) queuedGuidanceSessionId = undefined;
      if (!guided) {
        if (queuedGuidanceSessionId !== sessionId)
          guidance = CONTEXT_RETIREMENT_INSTRUCTION;
      } else if (event.reason === "overflow") {
        guidance = CONTEXT_RETIREMENT_REMINDER;
      }
      if (guidance) {
        pi.sendMessage(
          {
            customType: AGENT_CONTEXT_RETIRED_ENTRY,
            content: guidance,
            display: false,
            details: { sessionId },
          },
          { triggerTurn: false },
        );
        queuedGuidanceSessionId = sessionId;
      }
      if (event.reason === "threshold") {
        if (
          !guided &&
          bridgedGuidanceSessionId !== sessionId &&
          !pendingGuidance
        )
          pendingGuidance = {
            sessionId,
            content: CONTEXT_RETIREMENT_INSTRUCTION,
          };
      } else if (event.reason === "overflow" && event.willRetry) {
        pendingGuidance = {
          sessionId,
          content: guided
            ? CONTEXT_RETIREMENT_REMINDER
            : CONTEXT_RETIREMENT_INSTRUCTION,
        };
      }
      if (event.reason === "threshold") return { cancel: true };
    },
  );
  pi.on("session_compact_failed", (event: SessionCompactFailedEvent) => {
    if (event.reason === "overflow") {
      pendingGuidance = undefined;
      queuedGuidanceSessionId = undefined;
      bridgedGuidanceSessionId = undefined;
    }
  });
  pi.on("agent_settled", () => {
    pendingGuidance = undefined;
    queuedGuidanceSessionId = undefined;
    bridgedGuidanceSessionId = undefined;
  });
  pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const pending = pendingGuidance;
    if (!pending) return;
    pendingGuidance = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (
      !options.contextRetirementEnabled() ||
      !options.hasActiveAssignment() ||
      sessionId !== pending.sessionId
    )
      return;
    bridgedGuidanceSessionId = sessionId;
    const alreadyVisible = event.messages.some(
      (message: any) =>
        message.role === "custom" &&
        message.customType === AGENT_CONTEXT_RETIRED_ENTRY &&
        message.details?.sessionId === pending.sessionId &&
        contentText(message.content ?? "", "") === pending.content,
    );
    if (alreadyVisible) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: AGENT_CONTEXT_RETIRED_ENTRY,
          content: pending.content,
          display: false,
          details: { sessionId: pending.sessionId },
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
    if (
      !options.contextRetirementEnabled() ||
      !options.hasActiveAssignment() ||
      (event.toolName !== "delegate_agent" &&
        event.toolName !== "continue_agent")
    )
      return;
    if (
      !sessionContextRetired(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getSessionId(),
      )
    )
      return;
    return {
      block: true,
      reason:
        "This Agent session is retired. Complete the current work and return a handoff.",
    };
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
}

export function registerManagedAgentSessionStartHandler(
  pi: ExtensionAPI,
  execution: ReturnType<typeof createManagedAgentExecutionState>,
  options: {
    build: RuntimeBuild;
    delegationEnabled: boolean;
    startControllerSession(): void;
    resetRequestPump(): void;
    resetLeafStatus(): void;
    captureOwnTools(tools: string[] | undefined): void;
    getActiveTools(): string[];
    clearControllerRuntimes(): void;
    setControllerReady(ready: boolean): void;
    beginMetadataSession(): AbortSignal;
    prepareDelegatingRoster(ctx: ExtensionContext): Promise<void>;
    reportMetadata(
      state: ManagedAgentState,
      ctx: ExtensionContext,
      patch: ManagedAgentMetadataPatch,
      reset?: boolean,
    ): void;
    environmentIdentity(ctx: ExtensionContext): ManagedAgentState | undefined;
    ensureAgentIdentity(ctx: ExtensionContext): void;
    getAgentDefinitions(ctx: ExtensionContext): Promise<AgentDefinition[]>;
    sameIdentity(left: ManagedAgentState, right: ManagedAgentState): boolean;
    sameDurableState(
      left: ManagedAgentState,
      right: ManagedAgentState,
    ): boolean;
    claimAssignmentLock(
      mailbox: string,
      operation: string,
      ids: { label?: string; paneId?: string },
    ): () => void;
    recoverControllerRuntimes(
      ctx: ExtensionContext,
      signal: AbortSignal,
    ): Promise<void>;
    startControllerHealthScanner(
      ctx: ExtensionContext,
      signal: AbortSignal,
    ): void;
    touchActivity(now?: number, force?: boolean): void;
    pumpRequest(ctx: ExtensionContext): void;
    startLeafStatus(ctx: ExtensionContext): void;
    statusRuntime: ReturnType<typeof createAgentStatusRuntime>;
    appendError(ctx: ExtensionContext, error: unknown): void;
  },
): void {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    options.statusRuntime.prepareSession(ctx);
    options.startControllerSession();
    options.resetRequestPump();
    options.resetLeafStatus();
    options.captureOwnTools(undefined);
    if (options.delegationEnabled) options.clearControllerRuntimes();
    execution.initialized = false;
    options.setControllerReady(false);
    execution.assignment = undefined;
    execution.agentStartedAt = undefined;
    const metadataSignal = options.beginMetadataSession();
    if (options.delegationEnabled) await options.prepareDelegatingRoster(ctx);
    try {
      if (options.delegationEnabled) options.statusRuntime.start(ctx);
      let forceActivityTouch = false;
      execution.agentContext = ctx;
      const candidate = options.environmentIdentity(ctx);
      if (!candidate) throw new Error("invalid agent environment");
      if (!options.delegationEnabled)
        options.captureOwnTools(options.getActiveTools());
      options.ensureAgentIdentity(ctx);
      const mailbox = process.env.PI_HERDSMAN_MAILBOX!;
      const existing = readAgentState(mailbox);
      if (existing && !options.sameIdentity(existing, candidate))
        throw new Error("agent session identity changed while state existed");
      execution.assignment = candidate;
      if (existing && options.sameIdentity(existing, candidate)) {
        execution.assignment = {
          ...candidate,
          ...existing,
          build: options.build,
          updatedAt: Date.now(),
        };
        forceActivityTouch = !!execution.assignment.activeRequestId;
        if (
          execution.assignment.activeRequestId &&
          !execution.assignment.pendingAskId
        ) {
          try {
            const result = readResult(
              mailbox,
              execution.assignment.activeRequestId,
            );
            if (
              result &&
              result.runId === execution.assignment.runId &&
              result.ownerSessionId === execution.assignment.ownerSessionId &&
              result.workspaceId === execution.assignment.workspaceId &&
              result.agentLabel === execution.assignment.agentLabel &&
              result.paneId === execution.assignment.paneId &&
              result.requestId === execution.assignment.activeRequestId
            ) {
              execution.assignment = {
                ...execution.assignment,
                activeRequestId: undefined,
                completedRequestId: result.requestId,
                lastActivityAt: undefined,
                updatedAt: Date.now(),
              };
              forceActivityTouch = false;
            } else if (result) {
              options.appendError(
                ctx,
                new Error("active agent result identity did not match state"),
              );
            }
          } catch (error) {
            options.appendError(ctx, error);
          }
        }
      }
      if (!existing) {
        validateManagedAgentDefinition(await options.getAgentDefinitions(ctx));
        const bootstrap = readAgentBootstrap(mailbox);
        if (bootstrap) {
          if (
            bootstrap.runId !== candidate.runId ||
            bootstrap.ownerSessionId !== candidate.ownerSessionId ||
            bootstrap.workspaceId !== candidate.workspaceId ||
            bootstrap.agentLabel !== candidate.agentLabel
          )
            throw new Error("Managed-agent bootstrap identity mismatch");
          if (!sameRuntimeBuild(options.build, bootstrap.build))
            throw new Error("Managed-agent bootstrap Herdsman build mismatch");
          for (const participant of bootstrap.participants) {
            let initializer: (() => void | Promise<void>) | undefined;
            let acceptCount = 0;
            let invalidInitializer = false;
            pi.events.emit(MANAGED_AGENT_BOOTSTRAP_EVENT, {
              protocol: 1,
              phase: "initialize",
              context: ctx,
              agent: candidate.agentLabel,
              participant: { id: participant.id, payload: participant.payload },
              accept(callback: () => void | Promise<void>) {
                acceptCount++;
                if (typeof callback !== "function") {
                  invalidInitializer = true;
                  return;
                }
                if (acceptCount === 1) initializer = callback;
              },
            });
            if (acceptCount === 0 || invalidInitializer)
              throw new Error(
                `Managed-agent bootstrap participant "${participant.id}" is unavailable or invalid`,
              );
            if (acceptCount > 1)
              throw new Error(
                `Managed-agent bootstrap participant "${participant.id}" has multiple initializers`,
              );
            try {
              await initializer!();
            } catch (error) {
              throw new Error(
                `Managed-agent bootstrap participant "${participant.id}" failed: ${String(error)}`,
                { cause: error },
              );
            }
          }
          removeAgentBootstrap(mailbox);
        }
      }
      const release = options.claimAssignmentLock(mailbox, "session_start", {
        label: execution.assignment.agentLabel,
        paneId: execution.assignment.paneId,
      });
      try {
        const current = readAgentState(mailbox);
        if (current && !options.sameIdentity(current, execution.assignment))
          throw new Error("agent session identity changed while state existed");
        if (existing !== undefined && current === undefined)
          throw new Error("agent mailbox disappeared while state existed");
        if (
          existing !== undefined &&
          current !== undefined &&
          !options.sameDurableState(current, existing)
        )
          throw new Error(
            "agent mailbox changed while session start was preparing",
          );
        if (existing === undefined && current !== undefined)
          execution.assignment = {
            ...candidate,
            ...current,
            build: options.build,
            updatedAt: Date.now(),
          };
        writeAgentState(mailbox, execution.assignment);
      } finally {
        release();
      }
      if (options.delegationEnabled) {
        managedAgentControllerIdentity(ctx);
        await options.recoverControllerRuntimes(ctx, metadataSignal);
        options.setControllerReady(true);
      }
      if (execution.assignment.activeRequestId)
        options.touchActivity(Date.now(), forceActivityTouch);
      if (options.delegationEnabled)
        options.startControllerHealthScanner(ctx, metadataSignal);
      execution.initialized = true;
      const definition = process.env.PI_HERDSMAN_AGENT_DEFINITION!;
      const label = execution.assignment.agentLabel;
      nameSessionIfUnset(
        pi,
        ctx,
        definition === label ? label : `${definition} · ${label}`,
      );
      execution.stopRequestObserver = observeMailbox(
        mailbox,
        (name) => /^request-.*\.json$/.test(name),
        () => options.pumpRequest(ctx),
        (error) => options.appendError(ctx, error),
      );
      options.pumpRequest(ctx);
      if (!options.delegationEnabled && ctx.mode === "tui" && ctx.hasUI)
        options.startLeafStatus(ctx);
      const model = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const thinking = ctx.thinkingLevel;
      options.reportMetadata(
        execution.assignment,
        ctx,
        {
          activity: null,
          context: null,
          model: model || null,
          thinking: thinking || null,
        },
        true,
      );
    } catch (error) {
      execution.initialized = false;
      options.resetRequestPump();
      options.statusRuntime.clear();
      options.setControllerReady(false);
      execution.assignment = undefined;
      if (options.delegationEnabled) options.clearControllerRuntimes();
      options.appendError(ctx, error);
      ctx.ui.notify(`pi_herdsman_state_error: ${String(error)}`, "error");
    }
  });
}
