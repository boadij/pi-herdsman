import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentScopeAtDepth } from "./agent-definitions.ts";
import type { AgentDefinition } from "./agent-definitions.ts";
import {
  childAgentDepth,
  durableAgentDepth,
  managedAgentCascadePlanFromSnapshot,
  visibleAgentCapabilities,
  visibleAgentSnapshots,
} from "./agent-controller.ts";
import { writeAsk, writeResult } from "./mailbox.ts";
import type { ManagedAgentState, RequestRecord } from "./mailbox.ts";
import { persistRequiredEvidenceSnapshot } from "./storage.ts";
import {
  removeProjectAssignment,
  supervisionRuntime,
  writeProjectAssignment,
} from "./supervision.ts";
import {
  DEFAULT_MAX_AGENT_DEPTH,
  readConfig,
  readProjectOverrides,
  updateConfig,
} from "./config.ts";
import { herdsmanConfigPath } from "./storage.ts";
import { managedAgentEnvironmentError } from "./managed-agent-runtime.ts";
import {
  HERDSMAN_BUILD,
  LEAD_SESSION_ID,
  MANAGED_AGENT_BOOTSTRAP_EVENT,
  PI_AGENTS_DIR,
  WORKSPACE,
  agentControllerExecutor,
  agentMailboxPath,
  AGENT_ID,
  cascadeExecutor,
  consumeMailboxRequest,
  delegatedLifecycleExecutor,
  fakeAgentContext,
  fakeContext,
  fakePi,
  managedState,
  readAgentState,
  registerExtension,
  resetAgentMailbox,
  resultEntryDetails,
  seedAncestors,
  setAgentEnvironment,
  setLeadEnvironment,
  writeAgentState,
} from "./support.ts";

function writeMaxAgentDepth(value: unknown): void {
  const path = herdsmanConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ maxAgentDepth: value }));
}

function clearConfig(): void {
  rmSync(herdsmanConfigPath(), { force: true });
}

test.afterEach(() => {
  clearConfig();
  delete process.env.PI_HERDSMAN_DEPTH;
});

const definition = (
  name: string,
  frontmatter: AgentDefinition["frontmatter"] = {},
): AgentDefinition => ({ name, path: `/${name}.md`, frontmatter, body: "" });

const managedScope = (depth: number) =>
  ({
    kind: "managed-agent",
    allowedAgentDefinitions: new Set(["worker"]),
    depth,
  }) as const;

test("the depth limit makes an Agent a leaf exactly when its depth reaches it", () => {
  // Today's behavior: depth 1 may delegate, depth 2 is a leaf.
  assert.equal(DEFAULT_MAX_AGENT_DEPTH, 2);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((depth) => agentScopeAtDepth(depth, 4)),
    ["delegating", "delegating", "delegating", "leaf", "leaf"],
  );
  assert.deepEqual(
    [1, 2, 3].map((depth) => agentScopeAtDepth(depth, 2)),
    ["delegating", "leaf", "leaf"],
  );
  assert.equal(agentScopeAtDepth(1, 1), "leaf");
  // Negative control: a limit that is off by one flips the boundary.
  assert.notEqual(agentScopeAtDepth(3, 4), agentScopeAtDepth(3, 3));
});

test("a controller's child depth is one more than its own, and 1 at the root", () => {
  assert.equal(childAgentDepth({ kind: "root" }), 1);
  assert.equal(childAgentDepth(managedScope(1)), 2);
  assert.equal(childAgentDepth(managedScope(3)), 4);
});

test("the roster advertises delegation only for children that may delegate", () => {
  const definitions = [
    definition("worker", { agents: ["worker"] }),
    definition("plain"),
  ];
  const advertised = (
    scope: Parameters<typeof visibleAgentCapabilities>[1],
    max: number,
  ) =>
    visibleAgentCapabilities(definitions, scope, "all", max).find(
      ({ name }) => name === "worker",
    ) as Record<string, unknown>;
  // Default (2): root-started Agents delegate, their children are leaves.
  assert.deepEqual(advertised({ kind: "root" }, 2).agents, ["worker"]);
  assert.equal("agents" in advertised(managedScope(1), 2), false);
  // Limit 4: depths 1..3 may start children that delegate, depth 3 starts leaves.
  assert.deepEqual(advertised(managedScope(1), 4).agents, ["worker"]);
  assert.deepEqual(advertised(managedScope(2), 4).agents, ["worker"]);
  assert.equal("agents" in advertised(managedScope(3), 4), false);
  assert.equal(advertised(managedScope(3), 4).tools, "default");
  // Limit 1: even root-started Agents are leaves.
  assert.equal("agents" in advertised({ kind: "root" }, 1), false);
  // A leaf projection hides the agent tool, a delegating one lists it.
  assert.match(String(advertised(managedScope(2), 4).tools), /default/);
});

test("the default limit is read from config when the caller passes none", () => {
  const definitions = [definition("worker", { agents: ["worker"] })];
  assert.deepEqual(
    (visibleAgentCapabilities(definitions, { kind: "root" })[0] as any).agents,
    ["worker"],
  );
  writeMaxAgentDepth(1);
  assert.equal(
    "agents" in visibleAgentCapabilities(definitions, { kind: "root" })[0]!,
    false,
  );
});

test("PI_HERDSMAN_DEPTH is validated and defaults to a root-started Agent", () => {
  setAgentEnvironment("depth-env-agent", ["worker"]);
  assert.equal(managedAgentEnvironmentError(), undefined);
  for (const good of ["1", "2", "17"]) {
    process.env.PI_HERDSMAN_DEPTH = good;
    assert.equal(managedAgentEnvironmentError(), undefined, good);
  }
  for (const bad of ["0", "-1", "1.5", "two", "", " 3", "1e1", "007"]) {
    process.env.PI_HERDSMAN_DEPTH = bad;
    assert.match(
      managedAgentEnvironmentError() ?? "",
      /PI_HERDSMAN_DEPTH must be a positive integer.*restart this Agent/,
      JSON.stringify(bad),
    );
  }
});

test("config defaults to today's limit, accepts positive integers, rejects the rest", () => {
  assert.equal(readConfig().maxAgentDepth, DEFAULT_MAX_AGENT_DEPTH);
  for (const value of [1, 2, 4, 9]) {
    writeMaxAgentDepth(value);
    assert.equal(readConfig().maxAgentDepth, value);
  }
  for (const value of [0, -1, 1.5, "4", null, true, [], {}]) {
    writeMaxAgentDepth(value);
    assert.throws(
      () => readConfig(),
      new RegExp(
        `maxAgentDepth: expected a positive integer.*got .*Edit .*config\\.json.*default of ${DEFAULT_MAX_AGENT_DEPTH}\\.`,
      ),
      JSON.stringify(value),
    );
  }
});

test("updateConfig validates maxAgentDepth and project settings cannot override it", () => {
  updateConfig("maxAgentDepth", 3);
  assert.equal(readConfig().maxAgentDepth, 3);
  for (const bad of [0, -2, 2.5, "3", null]) {
    assert.throws(
      () => updateConfig("maxAgentDepth", bad as never),
      /maxAgentDepth: expected a positive integer/,
      JSON.stringify(bad),
    );
  }
  assert.equal(readConfig().maxAgentDepth, 3);
  updateConfig("maxAgentDepth", undefined);
  assert.equal(readConfig().maxAgentDepth, DEFAULT_MAX_AGENT_DEPTH);
  const cwd = mkdtempSync(join(tmpdir(), "pi-herdsman-depth-project-"));
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ piHerdsman: { maxAgentDepth: 9 } }),
    );
    assert.throws(
      () => readProjectOverrides({ cwd, isProjectTrusted: () => true }),
      /unsupported piHerdsman field maxAgentDepth/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Launch simulation: a managed Agent at `depth` (or the root) starts a child,
// and the child's environment is read back from the launch command.
async function launch(options: {
  depth?: number;
  /** PI_HERDSMAN_DEPTH when it should differ from the durable chain. */
  hint?: number;
  max?: number;
  root?: boolean;
  parentLabel?: string;
  /** Removes the ownership record of the Agent's direct owner. */
  dropOwnerRecord?: boolean;
  /** Runs while the launch is being prepared, before the Agent starts. */
  duringPreparation?: () => void;
}): Promise<{
  env: string[];
  ok: boolean;
  details: Record<string, any>;
  childOwner: string | undefined;
}> {
  const parentLabel =
    options.parentLabel ?? `depth-parent-${randomUUID().slice(0, 8)}`;
  if (options.max !== undefined) writeMaxAgentDepth(options.max);
  else clearConfig();
  if (options.root) setLeadEnvironment();
  else {
    setAgentEnvironment(parentLabel, ["worker"]);
    process.env.PI_SUBAGENT_PARENT_SESSION = LEAD_SESSION_ID;
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "worker";
    process.env.PI_HERDSMAN_DEPTH = String(options.hint ?? options.depth);
  }
  writeFileSync(
    join(PI_AGENTS_DIR, "worker.md"),
    '---\nname: worker\nagents: ["worker"]\n---\nworker\n',
  );
  const ancestors = seedAncestors(options.root ? 1 : (options.depth ?? 1));
  if (options.dropOwnerRecord) ancestors.dropOwner();
  if (!options.root) process.env.PI_HERDSMAN_OWNER_SESSION_ID = ancestors.owner;
  const parent = {
    ...managedState(parentLabel),
    ownerSessionId: ancestors.owner,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const lifecycle = delegatedLifecycleExecutor(parent);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  if (options.duringPreparation) {
    const prepare = options.duringPreparation;
    pi.pi.events.on(MANAGED_AGENT_BOOTSTRAP_EVENT, (event: any) => {
      if (event?.phase === "prepare")
        event.register("depth-test", () => {
          prepare();
          return undefined;
        });
    });
  }
  const context = options.root
    ? fakeContext()
    : fakeAgentContext([
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            definition: "worker",
            label: parentLabel,
          },
        },
      ]);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "depth-delegate",
        { definition: "worker", task: "go deeper" },
        undefined,
        undefined,
        context,
      );
    const child = result.details.agent
      ? readAgentState(agentMailboxPath(WORKSPACE, result.details.agent))
      : undefined;
    return {
      env: lifecycle.environmentCommands,
      ok: result.details.ok === true,
      details: result.details,
      childOwner: child?.ownerSessionId,
    };
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    ancestors.cleanup();
  }
}

const has = (env: string[], line: string) => env.includes(line);

test("default limit keeps today's behavior: a root-started Agent's child is a leaf", async () => {
  const { env, ok } = await launch({ depth: 1 });
  assert.equal(ok, true);
  assert.ok(has(env, "PI_HERDSMAN_DEPTH=2"), env.join("\n"));
  assert.ok(has(env, "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=[]"));
});

test("delegation is allowed below the limit and the child records its depth", async () => {
  for (const depth of [1, 2]) {
    const { env, ok } = await launch({ depth, max: 4 });
    assert.equal(ok, true, `depth ${depth}`);
    assert.ok(has(env, `PI_HERDSMAN_DEPTH=${depth + 1}`), env.join("\n"));
    assert.ok(
      has(env, 'PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=["worker"]'),
      env.join("\n"),
    );
  }
});

test("a child started at the limit is a leaf", async () => {
  const { env, ok } = await launch({ depth: 3, max: 4 });
  assert.equal(ok, true);
  assert.ok(has(env, "PI_HERDSMAN_DEPTH=4"), env.join("\n"));
  assert.ok(has(env, "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=[]"));
  assert.equal(
    env.some((line) =>
      line.startsWith('PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=["'),
    ),
    false,
  );
});

test("a root controller starts leaves when the limit is 1 and delegating Agents otherwise", async () => {
  const one = await launch({ root: true, max: 1 });
  assert.equal(one.ok, true, JSON.stringify(one.details));
  assert.ok(has(one.env, "PI_HERDSMAN_DEPTH=1"), one.env.join("\n"));
  assert.ok(has(one.env, "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=[]"));
  const two = await launch({ root: true });
  assert.equal(two.ok, true, JSON.stringify(two.details));
  assert.ok(has(two.env, "PI_HERDSMAN_DEPTH=1"));
  assert.ok(has(two.env, 'PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=["worker"]'));
});

test("an Agent deeper than a lowered limit is refused with the cause and the action", async () => {
  const { ok, details } = await launch({ depth: 3, max: 2 });
  assert.equal(ok, false);
  assert.match(
    JSON.stringify(details),
    /depth 3 and maxAgentDepth is 2.*cannot start another Agent.*raise maxAgentDepth/,
  );
});

test("depth-3 launch names its own label as the child's owner display and owns the child", async () => {
  const parentLabel = `deep-parent-${randomUUID().slice(0, 8)}`;
  const { env, ok, childOwner } = await launch({
    depth: 3,
    max: 5,
    parentLabel,
  });
  assert.equal(ok, true);
  assert.ok(
    has(env, `PI_HERDSMAN_OWNER_DISPLAY=worker:${parentLabel}`),
    env.join("\n"),
  );
  assert.equal(childOwner, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.ok(has(env, `PI_SUBAGENT_PARENT_SESSION=${LEAD_SESSION_ID}`));
});

// Evidence and ownership are read from the delegating Agent's own session, so
// an Agent at depth 3 hands its inherited and local evidence to its child just
// as a depth-1 Agent does, and owns the child directly.
test("a depth-3 Agent passes project evidence to its child and owns it directly", async () => {
  const label = `deep-evidence-${randomUUID().slice(0, 8)}`;
  writeMaxAgentDepth(5);
  setAgentEnvironment(label, ["worker"]);
  process.env.PI_HERDSMAN_DEPTH = "3";
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "worker";
  const projectAssignmentId = LEAD_SESSION_ID;
  const socket = join(tmpdir(), `depth-authority-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const projectRuntime = supervisionRuntime(socket);
  const branch = `depth-${randomUUID()}`;
  const requestId = randomUUID();
  const inherited = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "plan.md",
    "plan body",
  );
  const local = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "review.md",
    "review body",
  );
  writeProjectAssignment(projectRuntime, {
    version: 2,
    id: projectAssignmentId,
    repoKey: "repo-key",
    branch,
    text: "Project",
    requiredEvidence: [inherited],
  });
  writeFileSync(
    join(PI_AGENTS_DIR, "worker.md"),
    '---\nname: worker\nagents: ["worker"]\n---\nworker\n',
  );
  const ancestors = seedAncestors(3);
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = ancestors.owner;
  const parent = {
    ...managedState(label, requestId),
    projectAssignmentId,
    ownerSessionId: ancestors.owner,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  process.env.PI_HERDSMAN_MAILBOX = parentMailbox;
  process.env.HERDR_PANE_ID = parent.paneId;
  const lifecycle = delegatedLifecycleExecutor(parent);
  let published: RequestRecord | undefined;
  let stopConsumer: (() => void) | undefined;
  let childMailbox = "";
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                repo_key: "repo-key",
                repo_name: "project",
                source_workspace_id: WORKSPACE,
              },
              worktrees: [],
            },
          }),
          stderr: "",
          code: 0,
        };
      const result = lifecycle.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        stopConsumer = consumeMailboxRequest(
          agentMailboxPath(
            WORKSPACE,
            lifecycle.paneEnvironment.PI_HERDSMAN_LABEL!,
          ),
          (request) => {
            published = request;
          },
        );
      return result;
    },
  });
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const entries: any[] = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId, definition: "worker", label },
    },
    {
      type: "custom",
      customType: "pi-herdsman-agent-required-evidence",
      data: {
        version: 1,
        sessionId,
        requestId,
        runId: parent.runId,
        ownerSessionId: parent.ownerSessionId,
        workspaceId: parent.workspaceId,
        agentLabel: label,
        paneId: parent.paneId,
        projectAssignmentId,
        evidenceAssignmentId: requestId,
        inheritedEvidence: [inherited],
        localEvidence: [local],
      },
    },
  ];
  const context = fakeAgentContext(entries);
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "depth-evidence",
        { definition: "worker", task: "deeper task" },
        undefined,
        undefined,
        context,
      );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    childMailbox = agentMailboxPath(WORKSPACE, result.details.agent as string);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(published);
    assert.equal(published!.ownerSessionId, sessionId);
    assert.equal(published!.projectAssignmentId, projectAssignmentId);
    assert.deepEqual(published!.inheritedEvidence, [inherited, local]);
    assert.equal(published!.requiredEvidence?.length, 3);
    assert.ok(lifecycle.environmentCommands.includes("PI_HERDSMAN_DEPTH=4"));
    assert.ok(
      lifecycle.environmentCommands.includes(
        `PI_HERDSMAN_OWNER_DISPLAY=worker:${label}`,
      ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    stopConsumer?.();
    resetAgentMailbox(parentMailbox);
    if (childMailbox) resetAgentMailbox(childMailbox);
    ancestors.cleanup();
    rmSync(inherited.path, { force: true });
    rmSync(local.path, { force: true });
    removeProjectAssignment(projectRuntime, "repo-key", branch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

// Mailbox-tree simulations over a four-deep chain lead -> a1 -> a2 -> a3 -> a4.
const chain = ["a1", "a2", "a3", "a4"].map((label, index) => ({
  ...managedState(label, randomUUID(), {
    paneId: `pane-${label}`,
    tabId: "tab",
    piSessionId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    piSessionFile: `/tmp/${label}.jsonl`,
  }),
}));
chain.forEach((state, index) => {
  state.ownerSessionId =
    index === 0 ? LEAD_SESSION_ID : chain[index - 1]!.piSessionId;
});
const snapshotOf = (states: ManagedAgentState[]) => ({
  agents: states.map((state) => ({
    state,
    presence: { kind: "live" },
  })) as any[],
  mailboxes: states.map((state) => ({ state })) as any[],
});

test("a controller sees only its direct children, the root sees the whole chain", () => {
  const snapshot = snapshotOf(chain);
  const labels = (
    scope: Parameters<typeof visibleAgentSnapshots>[1],
    owner: string,
  ) =>
    visibleAgentSnapshots(snapshot, scope, owner)
      .map(({ state }) => state.agentLabel)
      .sort();
  assert.deepEqual(labels(managedScope(2), chain[1]!.piSessionId), ["a3"]);
  assert.deepEqual(labels(managedScope(3), chain[2]!.piSessionId), ["a4"]);
  assert.deepEqual(labels({ kind: "root" }, LEAD_SESSION_ID), [
    "a1",
    "a2",
    "a3",
    "a4",
  ]);
});

test("closing an Agent cascades through every level, deepest first", () => {
  const sameIdentity = (a: ManagedAgentState, b: ManagedAgentState) =>
    a.agentLabel === b.agentLabel && a.runId === b.runId;
  const plan = managedAgentCascadePlanFromSnapshot(
    snapshotOf(chain),
    chain[0]!,
    sameIdentity,
  );
  assert.equal(plan.parent.state.agentLabel, "a1");
  assert.deepEqual(
    plan.descendants.map(({ state }) => state.agentLabel),
    ["a4", "a3", "a2"],
  );
  // Closing a middle Agent leaves its ancestors out.
  assert.deepEqual(
    managedAgentCascadePlanFromSnapshot(
      snapshotOf(chain),
      chain[2]!,
      sameIdentity,
    ).descendants.map(({ state }) => state.agentLabel),
    ["a4"],
  );
});

// A delivered Agent's own Agents must be closed with it, whatever its depth.
async function cleanDeliveredChild(options: {
  grandchild: boolean;
  /** a3's mailbox exists but its state cannot be parsed. */
  unreadable?: boolean;
}) {
  const { createAgentController } = await import("./agent-controller.ts");
  const controllerLabel = "cleanup-a1";
  setAgentEnvironment(controllerLabel, ["worker"]);
  process.env.PI_HERDSMAN_DEPTH = "2";
  const context = fakeAgentContext([]) as any;
  const sessionId = (i: number) => `00000000-0000-4000-8000-00000000010${i}`;
  const identity = (label: string, i: number) => ({
    paneId: `pane-${label}`,
    tabId: "tab",
    piSessionId: sessionId(i),
    piSessionFile: `/tmp/${label}.jsonl`,
  });
  const requestId = randomUUID();
  const a2 = {
    ...managedState("cleanup-a2", undefined, identity("cleanup-a2", 2)),
    ownerSessionId: context.sessionManager.getSessionId(),
    completedRequestId: requestId,
  };
  const a3 = {
    ...managedState("cleanup-a3", undefined, identity("cleanup-a3", 3)),
    ownerSessionId: a2.piSessionId,
  };
  const states = options.grandchild ? [a2, a3] : [a2];
  for (const state of states) {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  if (options.unreadable)
    writeFileSync(
      join(agentMailboxPath(WORKSPACE, a3.agentLabel), "state.json"),
      "{ not json",
    );
  const cleanupErrors: unknown[] = [];
  const lifecycle = cascadeExecutor(states);
  const pi = fakePi({ exec: lifecycle.exec });
  const controller = createAgentController(
    pi.pi as never,
    {
      scope: {
        kind: "managed-agent",
        allowedAgentDefinitions: new Set(["worker"]),
        depth: 2,
      },
      build: HERDSMAN_BUILD,
      extensionPath: "test",
      isContextRetired: () => false,
      snapshotDependencies: {
        runtimeForLabel: () => undefined,
        readRootOwners: () => [],
        staleAfterMs: 60_000,
      },
      persistedTranscriptReady: () => false,
      agentDefinitions: async () => [],
      readTranscript: () => ({ transcript: "", truncated: false }),
      workspaceId: () => WORKSPACE,
      sendResultMessage: () => undefined,
      sendAskMessage: () => undefined,
      sessionRetired: () => false,
      appendError: (_ctx: unknown, _kind: string, error: unknown) => {
        if (!options.unreadable) throw error;
        cleanupErrors.push(error);
      },
      onChanged: () => undefined,
      onWorkChanged: () => undefined,
      reportWatcherError: () => undefined,
    } as any,
  );
  (context.sessionManager.getEntries() as any[]).push({
    customType: "pi-herdsman-agent-result",
    details: resultEntryDetails(a2, requestId),
  });
  const runtime = {
    label: a2.agentLabel,
    herdrAgent: a2.agentLabel,
    workspaceId: a2.workspaceId,
    paneId: a2.paneId,
    cwd: a2.cwd,
    runId: a2.runId,
    ownerSessionId: a2.ownerSessionId,
    mailboxPath: agentMailboxPath(WORKSPACE, a2.agentLabel),
    piSessionId: a2.piSessionId,
    piSessionFile: a2.piSessionFile,
    completedRequestId: requestId,
    agentDefinition: "worker",
  };
  try {
    const done = await controller.cleanupDeliveredResult(
      runtime as any,
      { requestId },
      context,
    );
    return {
      done,
      closeOrder: lifecycle.closeOrder,
      cleanupErrors,
      remaining: states
        .filter((state) => {
          try {
            return readAgentState(
              agentMailboxPath(WORKSPACE, state.agentLabel),
            );
          } catch {
            return false; // the deliberately unreadable descendant
          }
        })
        .map(({ agentLabel }) => agentLabel),
    };
  } finally {
    controller.abortSession();
    for (const state of states)
      resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
  }
}

test("cleanup of a delivered Agent without Agents of its own closes only it", async () => {
  const { done, closeOrder, remaining } = await cleanDeliveredChild({
    grandchild: false,
  });
  assert.equal(done, true);
  assert.deepEqual(closeOrder, ["cleanup-a2"]);
  assert.deepEqual(remaining, []);
});

test("cleanup of a delivered Agent closes its own Agents first instead of orphaning them", async () => {
  const { done, closeOrder, remaining } = await cleanDeliveredChild({
    grandchild: true,
  });
  assert.equal(done, true);
  assert.deepEqual(closeOrder, ["cleanup-a3", "cleanup-a2"]);
  assert.deepEqual(remaining, []);
});

test("cleanup of a delivered Agent fails closed when a descendant mailbox is unreadable", async () => {
  const { done, closeOrder, cleanupErrors, remaining } =
    await cleanDeliveredChild({ grandchild: true, unreadable: true });
  assert.equal(done, false);
  assert.deepEqual(closeOrder, [], "nothing was closed");
  // The delivered Agent keeps its durable ownership record, so it stays recoverable.
  assert.deepEqual(remaining, ["cleanup-a2"]);
  assert.match(String(cleanupErrors[0]), /unresolved state/);
});

test("durable depth counts recorded owners and rejects a cycle or a foreign workspace", () => {
  assert.equal(durableAgentDepth(chain, chain[0]!), 1);
  assert.equal(durableAgentDepth(chain, chain[3]!), 4);
  // An owner recorded in another workspace is not part of this chain, so the
  // chain no longer reaches its root and is rejected instead of truncated.
  assert.throws(
    () =>
      durableAgentDepth(
        chain.map((state, index) =>
          index === 1 ? { ...state, workspaceId: "other-workspace" } : state,
        ),
        chain[3]!,
      ),
    /does not reach its verified root/,
  );
  // A missing intermediate owner is not the root.
  assert.throws(
    () => durableAgentDepth([chain[0]!, chain[2]!, chain[3]!], chain[3]!),
    /does not reach its verified root/,
  );
  // Duplicate records for one owner are ambiguous.
  assert.throws(
    () =>
      durableAgentDepth(
        [...chain, { ...chain[1]!, agentLabel: "a2-duplicate" }],
        chain[3]!,
      ),
    /2 ownership records.*ambiguous/,
  );
  // Without a verified root the chain cannot be checked.
  const { rootSessionId: _root, ...unrooted } = chain[0]!;
  assert.throws(
    () => durableAgentDepth([unrooted], unrooted),
    /no verified root session/,
  );
  const loop = [
    { ...chain[0]!, ownerSessionId: chain[1]!.piSessionId },
    { ...chain[1]!, ownerSessionId: chain[0]!.piSessionId },
  ];
  assert.throws(() => durableAgentDepth(loop, loop[0]!), /form a cycle/);
});

test("a PI_HERDSMAN_DEPTH hint that disagrees with the ownership chain is refused", async () => {
  for (const hint of [1, 3]) {
    const { ok, details, env } = await launch({ depth: 2, hint, max: 4 });
    assert.equal(ok, false, `hint ${hint}`);
    assert.match(
      JSON.stringify(details),
      new RegExp(
        `PI_HERDSMAN_DEPTH is ${hint} but the durable ownership records place it at depth 2.*authoritative.*Restart it from its owner`,
      ),
    );
    assert.deepEqual(env, [], "nothing was started");
  }
  // Negative control: the same chain with a matching hint launches.
  assert.equal((await launch({ depth: 2, max: 4 })).ok, true);
});

test("a missing intermediate owner is refused even when the hint equals the truncated count", async () => {
  // Chain: root -> (missing) -> parent. Counting only the parent gives 1.
  const { ok, details, env } = await launch({
    depth: 2,
    hint: 1,
    max: 4,
    dropOwnerRecord: true,
  });
  assert.equal(ok, false);
  assert.match(
    JSON.stringify(details),
    /does not reach its verified root.*restart it from its owner/,
  );
  assert.deepEqual(env, [], "nothing was started");
});

test("a limit that changes while a launch is prepared rejects the launch", async () => {
  for (const changed of [3, 5]) {
    const { ok, details, env } = await launch({
      depth: 1,
      max: 4,
      duringPreparation: () => writeMaxAgentDepth(changed),
    });
    assert.equal(ok, false, `changed to ${changed}`);
    assert.match(
      JSON.stringify(details),
      new RegExp(
        `maxAgentDepth changed from 4 to ${changed} while this Agent was being prepared, so it was not started; retry`,
      ),
    );
    assert.deepEqual(env, [], "nothing was started");
  }
  // Negative control: rewriting the same limit is not a change.
  const same = await launch({
    depth: 1,
    max: 4,
    duringPreparation: () => writeMaxAgentDepth(4),
  });
  assert.equal(same.ok, true, JSON.stringify(same.details));
});

test("an Agent at or beyond the limit is advertised no definitions", () => {
  const definitions = [definition("worker", { agents: ["worker"] })];
  assert.equal(
    visibleAgentCapabilities(definitions, managedScope(2), "all", 2).length,
    0,
  );
  assert.equal(
    visibleAgentCapabilities(definitions, managedScope(3), "all", 2).length,
    0,
  );
  assert.equal(
    visibleAgentCapabilities(definitions, managedScope(1), "all", 2).length,
    1,
  );
});

test("continue_agent applies the same depth policy as delegate_agent", async () => {
  for (const [action, tool, args] of [
    ["delegate", "delegate_agent", { definition: "worker", task: "go" }],
    ["continue", "continue_agent", { session: randomUUID(), task: "go" }],
  ] as const) {
    writeMaxAgentDepth(2);
    const parentLabel = `depth-continue-${randomUUID().slice(0, 6)}`;
    setAgentEnvironment(parentLabel, ["worker"]);
    const ancestors = seedAncestors(2);
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = ancestors.owner;
    process.env.PI_HERDSMAN_DEPTH = "2";
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "worker";
    const parent = {
      ...managedState(parentLabel),
      ownerSessionId: ancestors.owner,
    };
    const mailbox = agentMailboxPath(WORKSPACE, parentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, parent);
    const pi = fakePi({ exec: delegatedLifecycleExecutor(parent).exec });
    registerExtension!(pi.pi as never);
    const context = fakeAgentContext([
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "worker",
          label: parentLabel,
        },
      },
    ]);
    try {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, context);
      const run = () =>
        pi.tools
          .find((candidate) => candidate.name === tool)!
          .execute("depth-policy", args, undefined, undefined, context);
      const refused = await run();
      assert.match(
        JSON.stringify(refused.details),
        /depth 2 and maxAgentDepth is 2.*cannot start another Agent/,
        action,
      );
      // Negative control: with the limit raised the same call passes the
      // depth policy (continue then fails to resolve the unknown session).
      writeMaxAgentDepth(3);
      const allowed = await run();
      assert.doesNotMatch(
        JSON.stringify(allowed.details),
        /maxAgentDepth is/,
        action,
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
      ancestors.cleanup();
    }
  }
});

// A running four-deep chain a1 -> a2 -> a3 -> a4, driven from a2's controller.
async function fromMiddleAgent(
  options: {
    max: number;
    pendingAsk?: boolean;
    grandchildResult?: boolean;
    /** a3's pane is gone from Herdr, so its generation is lost. */
    lostChild?: boolean;
  },
  scenario: (run: {
    tool(name: string, args: Record<string, unknown>): Promise<any>;
    states: ManagedAgentState[];
  }) => Promise<void>,
): Promise<void> {
  writeMaxAgentDepth(options.max);
  const ids = [1, 2, 3, 4].map(() => randomUUID());
  const states = ["a1", "a2", "a3", "a4"].map((label, index) => ({
    ...managedState(label, randomUUID(), {
      paneId: index === 1 ? "registered-pane" : `pane-${label}`,
      tabId: `tab-${label}`,
      piSessionId:
        index === 1 ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd" : ids[index]!,
      piSessionFile:
        index === 1 ? "/tmp/registered-agent.jsonl" : `/tmp/${label}-mid.jsonl`,
    }),
  }));
  states.forEach((state, index) => {
    state.ownerSessionId =
      index === 0 ? LEAD_SESSION_ID : states[index - 1]!.piSessionId;
  });
  const [a1, a2, a3, a4] = states as [
    ManagedAgentState,
    ManagedAgentState,
    ManagedAgentState,
    ManagedAgentState,
  ];
  setAgentEnvironment("a2", ["worker"]);
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = a1.piSessionId;
  process.env.PI_HERDSMAN_DEPTH = "2";
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "worker";
  for (const state of states) {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  if (options.pendingAsk) {
    const mailbox = agentMailboxPath(WORKSPACE, a3.agentLabel);
    const askId = randomUUID();
    writeAgentState(mailbox, { ...a3, pendingAskId: askId });
    writeAsk(mailbox, {
      version: 5,
      askId,
      requestId: a3.activeRequestId!,
      runId: a3.runId,
      ownerSessionId: a3.ownerSessionId,
      workspaceId: a3.workspaceId,
      agentLabel: a3.agentLabel,
      paneId: a3.paneId,
      piSessionId: a3.piSessionId,
      question: "Which branch should I use?",
      createdAt: Date.now(),
    });
  }
  if (options.grandchildResult)
    writeResult(agentMailboxPath(WORKSPACE, a4.agentLabel), {
      version: 5,
      runId: a4.runId,
      requestId: a4.activeRequestId!,
      ownerSessionId: a4.ownerSessionId,
      workspaceId: a4.workspaceId,
      agentLabel: a4.agentLabel,
      paneId: a4.paneId,
      status: "completed",
      text: "undelivered",
      completedAt: Date.now(),
    });
  const pi = fakePi({
    exec: agentControllerExecutor(a2, options.lostChild ? [a4] : [a3, a4]),
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: a2.piSessionId,
        definition: "worker",
        label: "a2",
      },
    },
  ]);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    await scenario({
      states,
      tool: (name, args) =>
        pi.tools
          .find((candidate) => candidate.name === name)!
          .execute(`mid-${name}`, args, undefined, undefined, context),
    });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const state of states)
      resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
  }
}

const listedTools = (listing: any, label: string): string[] =>
  (listing.details.agents ?? assert.fail(JSON.stringify(listing.details))).find(
    (agent: any) => agent.agent === label,
  )?.available_tools ?? [];

test("stop_agent availability accounts for the whole descendant cascade", async () => {
  await fromMiddleAgent({ max: 4 }, async ({ tool }) => {
    const listing = await tool("list_agents", {});
    assert.deepEqual(
      listing.details.agents.map((agent: any) => agent.agent),
      ["a3"],
      "a controller lists only its direct Agent",
    );
    assert.ok(listedTools(listing, "a3").includes("stop_agent"));
  });
  // The grandchild holds an undelivered result, so closing a3 would fail.
  await fromMiddleAgent(
    { max: 4, grandchildResult: true },
    async ({ tool }) => {
      const listing = await tool("list_agents", {});
      assert.ok(listedTools(listing, "a3").includes("inspect_agent"));
      assert.equal(listedTools(listing, "a3").includes("stop_agent"), false);
      const stop = await tool("stop_agent", { agent: "a3" });
      assert.equal(stop.details.ok, false);
    },
  );
});

test("a multi-level ask_owner reaches only the direct owner, who can reply", async () => {
  await fromMiddleAgent({ max: 4, pendingAsk: true }, async ({ tool }) => {
    const listing = await tool("list_agents", {});
    assert.ok(listedTools(listing, "a3").includes("reply_agent"));
    const reply = await tool("reply_agent", {
      agent: "a3",
      message: "Use the release branch.",
    });
    assert.equal(reply.details.ok, true, JSON.stringify(reply.details));
    // The grandchild a4 is not a direct Agent of a2, so a2 cannot answer it.
    const stray = await tool("reply_agent", {
      agent: "a4",
      message: "not yours",
    });
    assert.equal(stray.details.ok, false);
  });
});

test("lowering the limit keeps existing Agents manageable but forbids more delegation", async () => {
  // a2 sits at depth 2 with a limit of 2, so its child a3 is deeper than allowed.
  await fromMiddleAgent({ max: 2, pendingAsk: true }, async ({ tool }) => {
    const listing = await tool("list_agents", {});
    const available = listedTools(listing, "a3");
    for (const name of ["inspect_agent", "reply_agent", "stop_agent"])
      assert.ok(available.includes(name), `${name} in ${available}`);
    assert.deepEqual(listing.details.agent_definitions, []);
    const inspect = await tool("inspect_agent", { agent: "a3" });
    assert.notEqual(
      inspect.details.error?.category,
      "invalid_request",
      JSON.stringify(inspect.details),
    );
    const delegate = await tool("delegate_agent", {
      definition: "worker",
      task: "more work",
    });
    assert.match(
      JSON.stringify(delegate.details),
      /depth 2 and maxAgentDepth is 2.*cannot start another Agent/,
    );
  });
});

test("a lost deep Agent stays recoverable after the limit is lowered", async () => {
  await fromMiddleAgent({ max: 2, lostChild: true }, async ({ tool }) => {
    const listing = await tool("list_agents", {});
    const entry = listing.details.agents.find((a: any) => a.agent === "a3");
    assert.equal(entry.state, "lost", JSON.stringify(entry));
    // Recovery stays available to the owner even though a3 is deeper than the limit.
    assert.ok(listedTools(listing, "a3").includes("stop_agent"));
    const delegate = await tool("delegate_agent", {
      definition: "worker",
      task: "replacement",
    });
    assert.match(
      JSON.stringify(delegate.details),
      /depth 2 and maxAgentDepth is 2.*cannot start another Agent/,
    );
  });
});
