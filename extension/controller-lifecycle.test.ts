import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mock, test } from "node:test";
import type { TestContext } from "node:test";
import { Value } from "typebox/value";
import type {
  BeforeAgentStartEvent,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";

import { claimProcessLock } from "./lock.ts";
import {
  persistRequiredEvidenceSnapshot,
  readRequiredEvidenceSnapshot,
  resultPath,
  resultRef,
} from "./storage.ts";
import {
  listProjectAssignments,
  listProjectMessages,
  listProjectMessageHeaders,
  projectAssignmentPath,
  managerDescriptorPath,
  readSessionKind,
  readProjectAssignment,
  readManagerDescriptor,
  removeProjectAssignment,
  migrateProjectAssignmentEvidence,
  findProjectAssignmentBySession,
  globalProjectAssignmentSnapshot,
  supervisionRuntime,
  writeProjectAssignment,
  writeProjectMessage,
} from "./supervision.ts";
import { worktreeGroupScope } from "./herdr.ts";
import support from "./support.ts";
import {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  MAILBOX_PROTOCOL_LIMIT_BYTES,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  OTHER_HERDSMAN_BUILD,
  HERDSMAN_BUILD,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  agentFromState,
  cascadeExecutor,
  controlMarker,
  consumeMailboxRequest,
  createStagedAssignmentFixture,
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  delegationLockPathForTest,
  assignmentLockPathForTest,
  fakeContext,
  fakePi,
  fakeAgentContext,
  isApiSnapshot,
  isAgentList,
  isHerdrList,
  isPaneClose,
  isPaneList,
  isPreservePaneStop,
  isTabClose,
  isTabList,
  listResponse,
  listAgentStates,
  managedState,
  nativeSessions,
  agentControllerExecutor,
  promptLaunchContents,
  promptLaunchPaths,
  readPendingAsk,
  readRequest,
  readUnacknowledgedRequest,
  readResult,
  readAgentState,
  MANAGED_AGENT_BOOTSTRAP_EVENT,
  readAgentBootstrap,
  removeAgentBootstrap,
  writeAgentBootstrap,
  realFs,
  recoveryIdentity,
  registerExtension,
  requestRecordBytes,
  resetAgentMailbox,
  resultEntryDetails,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setAgentEnvironment,
  startupExecutor,
  watchedMailboxDirectories,
  emitMailboxChange,
  agentMailboxPath,
  writeAsk,
  writePromptDefinition,
  writeRequest,
  writeResult,
  writeAgentState,
  testTmpRoot,
} from "./support.ts";

test("read_evidence is added only to assigned project Lead tools", async () => {
  const { createLeadToolState } = await import("./lead-runtime.ts");
  const tools = ["read", "bash", "read_evidence", "delegate_agent"];
  const state = createLeadToolState(
    () => tools.map((name) => ({ name })),
    ["delegate_agent"],
    [],
  );
  const definition = {
    name: "project-lead",
    path: "/project-lead.md",
    body: "",
    frontmatter: { tools: ["read"] },
  } as any;
  assert.deepEqual(
    state.projectRoleTools(["read", "bash"], definition, ["read_evidence"]),
    ["read", "read_evidence"],
  );
  assert.deepEqual(state.projectRoleTools(["read", "bash"], definition, []), [
    "read",
  ]);
  assert.deepEqual(state.normalizeLeadTools(["read", "bash"]), [
    "read",
    "bash",
  ]);
  assert.deepEqual(state.normalizeLeadTools(["read"]), ["read"]);
});
const { claimAgentMailbox, removeAgentMailbox } = await import("./mailbox.ts");
const ownedSessionContext = (
  id: string,
  label: string,
  terminal?: Record<string, unknown>,
) =>
  fakeContext([
    {
      type: "custom_message",
      message: {
        customType: "pi-herdsman-agent-result",
        details: {
          piSessionId: id,
          piSessionFile: nativeSessions.get(id)?.path,
          ownerSessionId: LEAD_SESSION_ID,
          runId: randomUUID(),
          requestId: randomUUID(),
          agentLabel: label,
          agentDefinition:
            (
              nativeSessions
                .get(id)
                ?.entries?.find(
                  (entry: any) =>
                    entry?.customType === "pi-herdsman-agent-definition",
                ) as any
            )?.data?.definition ?? "agent",
          status: "completed",
          ...terminal,
        },
      },
    },
  ]);
function seedSessionKind(
  context: ReturnType<typeof fakeContext>,
  kind: "ordinary" | "managed",
  repoKey?: string,
  branch?: string,
): void {
  const sessionId = context.sessionManager.getSessionId();
  const data =
    kind === "managed"
      ? { version: 1, sessionId, kind, repoKey, branch }
      : { version: 1, sessionId, kind };
  (context.sessionManager.getEntries() as any[]).push({
    type: "custom",
    customType: "pi-herdsman-session-kind",
    data,
  });
  seedLeadRole(context, kind === "ordinary");
}

function seedLeadRole(
  context: ReturnType<typeof fakeContext>,
  ordinaryExecution = true,
): void {
  const entries = context.sessionManager.getEntries() as any[];
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: {
      sessionId: context.sessionManager.getSessionId(),
      role: "lead",
      leadTools: ["read"],
    },
  });
  if (ordinaryExecution)
    entries.push({
      type: "custom",
      customType: "pi-herdsman-lead-execution",
      data: {
        sessionId: context.sessionManager.getSessionId(),
        mode: "orchestrate",
        leadTools: ["read"],
      },
    });
}

test("parent delegates two same-definition children with exact ownership", async () => {
  setAgentEnvironment("multiplicity-parent", ["child"]);
  const previousForwardingSession = process.env.PI_SUBAGENT_PARENT_SESSION;
  process.env.PI_SUBAGENT_PARENT_SESSION = LEAD_SESSION_ID;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("multiplicity-parent");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const lifecycle = delegatedLifecycleExecutor(parent);
  const starts: string[][] = [];
  const order: string[] = [];
  let duplicateRegistration = false;
  let commitFails = false;
  let pi: ReturnType<typeof fakePi>;
  pi = fakePi({
    thinkingLevel: "high",
    exec: (command, args) => {
      const starting =
        command === "herdr" && args[0] === "agent" && args[1] === "start";
      if (starting) {
        starts.push([...args]);
        const label = lifecycle.paneEnvironment.PI_HERDSMAN_LABEL;
        const mailbox = agentMailboxPath(WORKSPACE, label);
        const record = readAgentBootstrap(mailbox);
        if (record) {
          order.push("child initialize");
          pi.pi.events.emit(MANAGED_AGENT_BOOTSTRAP_EVENT, {
            protocol: 1,
            phase: "initialize",
            context: fakeAgentContext([]),
            agent: label,
            participant: record.participants[0],
            accept(initialize: () => void) {
              initialize();
            },
          });
          removeAgentBootstrap(mailbox);
        }
      }
      const result = lifecycle.exec(command, args);
      if (starting) {
        assert.equal(
          readAgentBootstrap(
            agentMailboxPath(
              WORKSPACE,
              lifecycle.paneEnvironment.PI_HERDSMAN_LABEL,
            ),
          ),
          undefined,
        );
        order.push("child readiness");
      }
      return result;
    },
  });
  pi.pi.events.on(MANAGED_AGENT_BOOTSTRAP_EVENT, (event: any) => {
    if (event.phase === "prepare") {
      order.push("prepare");
      event.register("test/participant", async () => ({
        payload: "opaque",
        commit: () => {
          if (commitFails) throw new Error("parent commit failed");
          order.push("parent commit");
        },
      }));
    } else if (event.phase === "initialize") {
      event.accept(() => {
        order.push("child initializer");
      });
    }
  });
  pi.pi.events.on(MANAGED_AGENT_BOOTSTRAP_EVENT, (event: any) => {
    if (duplicateRegistration && event.phase === "prepare")
      event.register("test/participant", async () => undefined);
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ]);
  (context as any).model = {
    provider: "parent-provider",
    id: "parent-model",
  };
  (context as any).thinkingLevel = "high";
  const mailboxes: string[] = [];
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const task of ["first child", "second child"]) {
      const started = await pi.tools
        .find((tool) => tool.name === "delegate_agent")!
        .execute(
          "start",
          { definition: "child", task },
          undefined,
          undefined,
          context,
        );
      assert.equal(started.details.ok, true, JSON.stringify(started.details));
      context.sessionManager.getEntries().push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "delegate_agent",
          details: started.details,
        },
      });
      const childMailbox = agentMailboxPath(
        WORKSPACE,
        started.details.agent as string,
      );
      if (task === "first child") {
        order.push("first task delivered");
        assert.deepEqual(order, [
          "prepare",
          "child initialize",
          "child initializer",
          "child readiness",
          "parent commit",
          "first task delivered",
        ]);
      }
      assert.equal(readAgentBootstrap(childMailbox), undefined);
      mailboxes.push(childMailbox);
    }
    duplicateRegistration = true;
    const duplicate = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "duplicate-bootstrap",
        { definition: "child", task: "must not launch" },
        undefined,
        undefined,
        context,
      );
    assert.equal(duplicate.details.ok, false);
    assert.match(
      JSON.stringify(duplicate.details),
      /Duplicate managed-agent bootstrap participant ID/u,
    );
    assert.equal(starts.length, 2);
    duplicateRegistration = false;
    commitFails = true;
    const commitFailure = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "failed-bootstrap-commit",
        { definition: "child", task: "must not be delivered" },
        undefined,
        undefined,
        context,
      );
    assert.equal(commitFailure.details.ok, false);
    assert.match(
      JSON.stringify(commitFailure.details),
      /parent commit failed/u,
    );
    assert.equal(starts.length, 3);
    const guidance = pi.sentMessageCalls.filter(
      ({ message }) =>
        (message as any).customType === "pi-herdsman-delegation-guidance",
    );
    assert.equal(guidance.length, 1);
    const content = String((guidance[0].message as any).content);
    for (const phrase of [
      "Each unresolved unit of work has one executor.",
      "steer_agent queues a cooperative correction",
      "it does not preempt the current operation",
      "A repeated reminder for the same stale episode is additional recovery evidence",
      "A steer queued during that unchanged episode cannot have taken effect yet",
      "otherwise use interrupt_agent",
      "Do not take over or replace unresolved delegated work",
    ])
      assert.ok(content.includes(phrase), phrase);
    const sharedGuidance = pi.tools
      .find((tool) => tool.name === "list_agents")!
      .promptGuidelines!.join(" ");
    for (const phrase of [
      "When delegating a bounded task, prefer continue_agent if a known exact historical managed-Agent Pi session carries substantial context relevant to that task and remains eligible; otherwise use delegate_agent to start fresh from a definition.",
      "Retired sessions cannot be continued while context retirement is enabled. If further work is needed, delegate a fresh Agent with the prior handoff and relevant files.",
      "Each live Agent generation exists for one assignment; after its terminal result is delivered, Herdsman cleans up that generation.",
      "Agent labels identify the current live generation; exact Pi sessions identify historical context and continuation.",
      "Do not attach or mention agent instruction files such as AGENTS.md, CLAUDE.md, GEMINI.md, or equivalents merely because they exist.",
      "A proven lost Agent remains unresolved; physical disappearance is not completion. Unknown or conflicting identity remains fail-closed. Do not take over or replace unresolved delegated work until the current generation is resolved or explicitly closed.",
    ])
      assert.ok(sharedGuidance.includes(phrase), phrase);
    const labels = mailboxes.map(
      (mailbox) => readAgentState(mailbox)!.agentLabel,
    );
    assert.equal(new Set(labels).size, 2);
    assert.equal(starts.length, 3);
    for (const args of starts) {
      assert.equal(
        args[args.indexOf("--model") + 1],
        "parent-provider/parent-model",
      );
      assert.equal(args[args.indexOf("--thinking") + 1], "high");
    }
    const states = mailboxes.map((mailbox) => readAgentState(mailbox)!);
    assert.deepEqual(
      states.map((state) => state.ownerSessionId),
      [parent.piSessionId, parent.piSessionId],
    );
    assert.equal(new Set(states.map((state) => state.paneId)).size, 2);
    assert.equal(
      lifecycle.environmentCommands.filter((command) =>
        command.includes("PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=[]"),
      ).length,
      3,
    );
    assert.equal(
      lifecycle.environmentCommands.filter(
        (command) =>
          command ===
          `PI_HERDSMAN_OWNER_SESSION_ID=${context.sessionManager.getSessionId()}`,
      ).length,
      3,
    );
    assert.equal(
      lifecycle.environmentCommands.filter(
        (command) =>
          command === "PI_HERDSMAN_OWNER_DISPLAY=parent:multiplicity-parent",
      ).length,
      3,
    );
    assert.equal(
      lifecycle.environmentCommands.filter(
        (command) =>
          command === `PI_SUBAGENT_PARENT_SESSION=${LEAD_SESSION_ID}`,
      ).length,
      3,
    );
    assert.equal(lifecycle.createdTabs(), 0);
    for (const label of labels) {
      const beforeClose = readAgentState(agentMailboxPath(WORKSPACE, label))!;
      const closed = await pi.tools
        .find((tool) => tool.name === "close_agent")!
        .execute("close", { agent: label }, undefined, undefined, context);
      assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
      assert.deepEqual(closed.details.closed_assignment, {
        owner_session_id: beforeClose.ownerSessionId,
        session_id: beforeClose.piSessionId,
        session_path: beforeClose.piSessionFile,
        run_id: beforeClose.runId,
        request_id: beforeClose.activeRequestId,
        agent: beforeClose.agentLabel,
        definition: "child",
        pane_id: beforeClose.paneId,
        workspace_id: beforeClose.workspaceId,
      });
      assert.equal(
        readAgentState(agentMailboxPath(WORKSPACE, label)),
        undefined,
      );
    }
    assert.equal(
      pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-herd-run",
      ).length,
      0,
    );
    assert.deepEqual(lifecycle.closeOrder, labels);
  } finally {
    if (previousForwardingSession === undefined)
      delete process.env.PI_SUBAGENT_PARENT_SESSION;
    else process.env.PI_SUBAGENT_PARENT_SESSION = previousForwardingSession;
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

function writePlacementSetting(placement: "tab" | "subtree" | "split") {
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  realFs.writeFileSync(
    join(PI_AGENT_ROOT, "pi-herdsman", "config.json"),
    JSON.stringify({ spawnPlacement: placement }),
  );
}

function writeValidPiSessionFile(session: {
  id: string;
  path: string;
  cwd: string;
  entries?: readonly Record<string, unknown>[];
}): void {
  let parentId: string | null = null;
  const entries = (session.entries ?? []).map((entry) => {
    const persisted = {
      ...entry,
      id: randomUUID(),
      parentId,
      timestamp: new Date().toISOString(),
    };
    parentId = persisted.id;
    return persisted;
  });
  realFs.writeFileSync(
    session.path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: session.id,
      timestamp: new Date().toISOString(),
      cwd: session.cwd,
    })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}${entries.length ? "\n" : ""}`,
    "utf8",
  );
}

function registerNativeAgentSession(state: ManagedAgentState): void {
  nativeSessions.set(state.piSessionId, {
    id: state.piSessionId,
    path: state.piSessionFile!,
    cwd: state.cwd,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: state.piSessionId,
          definition: "agent",
          label: state.agentLabel,
        },
      },
    ],
  });
}

async function liveAgentList(pi: ReturnType<typeof fakePi>) {
  const response = await pi.pi.exec("herdr", ["agent", "list"]);
  return JSON.parse(response.stdout).result.agents as Record<string, unknown>[];
}

const registeredAgentTool = (
  pi: ReturnType<typeof fakePi>,
  operation: string,
) =>
  pi.tools.find(
    (tool) =>
      tool.name ===
      (
        {
          list: "list_agents",
          delegate: "delegate_agent",
          continue: "continue_agent",
          steer: "steer_agent",
          interrupt: "interrupt_agent",
          reply: "reply_agent",
          close: "close_agent",
          inspect: "inspect_agent",
          transcript: "read_agent_transcript",
        } as Record<string, string>
      )[operation],
  )!;

async function assertManagedLeadRole(
  pi: ReturnType<typeof fakePi>,
  context: ReturnType<typeof fakeContext>,
): Promise<void> {
  const menus: { title: string; options: string[] }[] = [];
  let selectedExecution = false;
  context.mode = "rpc";
  context.ui.select = async (title, options) => {
    menus.push({ title, options: [...options] });
    if (title.startsWith("Pi Herdsman ·") && !selectedExecution) {
      selectedExecution = true;
      return options[0];
    }
    return undefined;
  };
  await pi.commandOptions.get("herdsman")!.handler("", context);
  assert.equal(menus[0]?.options[2]?.includes("active"), false);
  assert.equal(menus[0]?.options[6]?.includes("Chief active"), false);
  assert.equal(menus[1]?.title, "Managed orchestration");
  context.mode = "tui";
}

test("lead direct placement modes use real controller delegation", async () => {
  for (const placement of ["tab", "subtree", "split"] as const) {
    setLeadEnvironment();
    writePlacementSetting(placement);
    const parent = {
      ...managedState(`placement-parent-${placement}`),
      paneId: `placement-parent-pane-${placement}`,
    };
    const callerPane =
      placement === "tab"
        ? {
            paneId: `placement-lead-pane-${placement}`,
            tabId: `placement-lead-tab-${placement}`,
          }
        : undefined;
    if (placement === "split") process.env.HERDR_PANE_ID = parent.paneId;
    else if (callerPane) process.env.HERDR_PANE_ID = callerPane.paneId;
    else delete process.env.HERDR_PANE_ID;
    const mailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, parent);
    registerNativeAgentSession(parent);
    const lifecycle = delegatedLifecycleExecutor(
      parent,
      [],
      "/tmp",
      callerPane,
    );
    const pi = fakePi({ exec: lifecycle.exec });
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, fakeContext());
    const childMailboxes: string[] = [];
    try {
      const start = async (label: string) => {
        const result = await registeredAgentTool(pi, "delegate").execute(
          `start-${label}`,
          { definition: "agent", label, task: "placement" },
          undefined,
          undefined,
          fakeContext(),
        );
        assert.equal(result.details.ok, true, JSON.stringify(result.details));
        const childMailbox = agentMailboxPath(WORKSPACE, result.details.agent);
        childMailboxes.push(childMailbox);
        return readAgentState(childMailbox)!;
      };
      const first = await start(`placement-${placement}-one`);
      const second = await start(`placement-${placement}-two`);
      assert.equal(
        lifecycle.environmentCommands.filter(
          (command) => command === "PI_HERDSMAN_OWNER_DISPLAY=lead",
        ).length,
        2,
      );
      const firstTab = lifecycle.tabForPane(first.paneId);
      const secondTab = lifecycle.tabForPane(second.paneId);
      assert.ok(firstTab);
      assert.ok(secondTab);
      if (placement === "tab" || placement === "split") {
        assert.equal(lifecycle.createdTabs(), 0);
        assert.equal(firstTab, lifecycle.tabForPane(parent.paneId));
        assert.equal(secondTab, firstTab);
        assert.equal(
          pi.calls.filter((args) => args[0] === "pane" && args[1] === "split")
            .length,
          2,
        );
      } else {
        assert.equal(lifecycle.createdTabs(), 2);
        assert.notEqual(firstTab, secondTab);
        assert.equal(
          pi.calls.filter((args) => args[0] === "tab" && args[1] === "create")
            .length,
          2,
        );
      }
      const agents = await liveAgentList(pi);
      assert.deepEqual(
        agents
          .filter((agent) =>
            [first, second].some(
              (state) =>
                agent.name ===
                runScopedHerdrAlias(
                  state.workspaceId,
                  state.agentLabel,
                  state.runId,
                ),
            ),
          )
          .map((agent) => agent.tab_id),
        [firstTab, secondTab],
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
      for (const childMailbox of childMailboxes)
        resetAgentMailbox(childMailbox);
      nativeSessions.delete(parent.piSessionId);
      realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
        force: true,
      });
    }
  }
});

test("lead split-to-tab placement creates a dedicated agents tab", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState("split-to-tab-parent"),
    paneId: "split-to-tab-parent-pane",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  registerNativeAgentSession(parent);
  const callerPane = { paneId: parent.paneId, tabId: "delegated-tab" };
  process.env.HERDR_PANE_ID = parent.paneId;
  const lifecycle = delegatedLifecycleExecutor(parent, [], "/tmp", callerPane);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  const childMailboxes: string[] = [];
  try {
    const placements = ["split", "split", "tab"] as const;
    for (const [index, placement] of placements.entries()) {
      writePlacementSetting(placement);
      const label = `split-to-tab-${placement}-${index}`;
      const result = await registeredAgentTool(pi, "delegate").execute(
        `start-${label}`,
        { definition: "agent", label, task: placement },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      childMailboxes.push(agentMailboxPath(WORKSPACE, result.details.agent));
      const state = readAgentState(childMailboxes.at(-1)!);
      assert.ok(state);
      if (placement === "split")
        assert.equal(lifecycle.tabForPane(state.paneId), "delegated-tab");
      else {
        assert.equal(lifecycle.createdTabs(), 1);
        assert.notEqual(lifecycle.tabForPane(state.paneId), "delegated-tab");
      }
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    for (const mailbox of childMailboxes) resetAgentMailbox(mailbox);
    nativeSessions.delete(parent.piSessionId);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("lead tab placement vetoes an ambiguous current-lead direct root", async () => {
  setLeadEnvironment();
  writePlacementSetting("tab");
  const parent = {
    ...managedState("ambiguous-current-root"),
    paneId: "ambiguous-current-root-pane",
  };
  const direct = {
    ...managedState("ambiguous-current-sibling", undefined, {
      paneId: "ambiguous-current-sibling-pane",
      tabId: "ambiguous-current-sibling-tab",
      piSessionId: "11111111-1111-4111-8111-111111111111",
      piSessionFile: "/tmp/ambiguous-current-sibling.jsonl",
    }),
  };
  const callerPane = { paneId: "lead-pane", tabId: "lead-tab" };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const directMailbox = agentMailboxPath(WORKSPACE, direct.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(directMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(directMailbox, direct);
  registerNativeAgentSession(parent);
  registerNativeAgentSession(direct);
  const lifecycle = delegatedLifecycleExecutor(
    parent,
    [direct],
    "/tmp",
    callerPane,
  );
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (command !== "herdr" || !isApiSnapshot(args)) return result;
      const value = JSON.parse(result.stdout);
      value.result.snapshot.agents.push(agentFromState(parent));
      return { ...result, stdout: JSON.stringify(value) };
    },
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  const childMailbox = agentMailboxPath(WORKSPACE, "ambiguous-current-child");
  try {
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "ambiguous-current-start",
        {
          definition: "agent",
          task: "reject ambiguous root reuse",
        },
        undefined,
        undefined,
        fakeContext(),
      );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(lifecycle.createdTabs(), 1);
    assert.equal(
      pi.calls.some((args) => args[0] === "pane" && args[1] === "split"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of [parentMailbox, directMailbox, childMailbox])
      resetAgentMailbox(mailbox);
    nativeSessions.delete(parent.piSessionId);
    nativeSessions.delete(direct.piSessionId);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("lead tab placement vetoes ambiguous foreign-herd evidence", async () => {
  setLeadEnvironment();
  writePlacementSetting("tab");
  const parent = {
    ...managedState("ambiguous-foreign-parent"),
    paneId: "ambiguous-foreign-parent-pane",
  };
  const foreign = {
    ...managedState("ambiguous-foreign-agent", undefined, {
      paneId: "ambiguous-foreign-agent-pane",
      tabId: "ambiguous-foreign-agent-tab",
      piSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      piSessionFile: "/tmp/ambiguous-foreign-agent.jsonl",
    }),
    ownerSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  const callerPane = { paneId: "lead-pane", tabId: "lead-tab" };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const foreignMailbox = agentMailboxPath(WORKSPACE, foreign.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(foreignMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(foreignMailbox, foreign);
  registerNativeAgentSession(parent);
  registerNativeAgentSession(foreign);
  const lifecycle = delegatedLifecycleExecutor(
    parent,
    [foreign],
    "/tmp",
    callerPane,
  );
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (command !== "herdr" || !isApiSnapshot(args)) return result;
      const value = JSON.parse(result.stdout);
      value.result.snapshot.agents.push(agentFromState(foreign));
      return { ...result, stdout: JSON.stringify(value) };
    },
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  const childMailbox = agentMailboxPath(WORKSPACE, "ambiguous-foreign-child");
  try {
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "ambiguous-foreign-start",
        {
          definition: "agent",
          task: "reject foreign ambiguity",
        },
        undefined,
        undefined,
        fakeContext(),
      );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(lifecycle.createdTabs(), 1);
    assert.equal(
      pi.calls.some((args) => args[0] === "pane" && args[1] === "split"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of [parentMailbox, foreignMailbox, childMailbox])
      resetAgentMailbox(mailbox);
    nativeSessions.delete(parent.piSessionId);
    nativeSessions.delete(foreign.piSessionId);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("lead tab placement rejects old shared tabs and only changes future starts", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState("future-placement-parent"),
    paneId: "future-placement-parent-pane",
  };
  const sibling = {
    ...managedState(
      "future-placement-sibling",
      undefined,
      recoveryIdentity("future-placement-sibling"),
    ),
    ownerSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    piSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    piSessionFile: "/tmp/future-placement-sibling.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const siblingMailbox = agentMailboxPath(WORKSPACE, sibling.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(siblingMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(siblingMailbox, sibling);
  registerNativeAgentSession(parent);
  registerNativeAgentSession(sibling);
  writePlacementSetting("tab");
  const lifecycle = delegatedLifecycleExecutor(parent, [sibling]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  const childMailboxes: string[] = [];
  try {
    const start = async (label: string) => {
      const result = await registeredAgentTool(pi, "delegate").execute(
        `start-${label}`,
        { definition: "agent", label, task: "placement" },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      const childMailbox = agentMailboxPath(WORKSPACE, result.details.agent);
      childMailboxes.push(childMailbox);
      return readAgentState(childMailbox)!;
    };
    const first = await start("future-placement-first");
    assert.equal(lifecycle.createdTabs(), 1);
    const firstTab = lifecycle.tabForPane(first.paneId);
    assert.notEqual(firstTab, lifecycle.tabForPane(parent.paneId));
    assert.equal(
      lifecycle.tabForPane(sibling.paneId),
      lifecycle.tabForPane(parent.paneId),
    );

    writePlacementSetting("subtree");
    const second = await start("future-placement-second");
    assert.equal(lifecycle.createdTabs(), 2);
    assert.notEqual(lifecycle.tabForPane(second.paneId), firstTab);
    assert.equal(lifecycle.tabForPane(first.paneId), firstTab);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(siblingMailbox);
    for (const childMailbox of childMailboxes) resetAgentMailbox(childMailbox);
    nativeSessions.delete(parent.piSessionId);
    nativeSessions.delete(sibling.piSessionId);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("lead tab revalidation rejects a newly contaminated candidate under the lock", async () => {
  setLeadEnvironment();
  writePlacementSetting("tab");
  const parent = {
    ...managedState("revalidation-parent"),
    paneId: "revalidation-parent-pane",
  };
  const sibling = {
    ...managedState(
      "revalidation-sibling",
      undefined,
      recoveryIdentity("revalidation-sibling"),
    ),
    ownerSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    piSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    piSessionFile: "/tmp/revalidation-sibling.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const siblingMailbox = agentMailboxPath(WORKSPACE, sibling.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(siblingMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(siblingMailbox, sibling);
  registerNativeAgentSession(parent);
  registerNativeAgentSession(sibling);
  const lifecycle = delegatedLifecycleExecutor(parent);
  let agentLists = 0;
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (command !== "herdr" || !isApiSnapshot(args)) return result;
      agentLists++;
      if (agentLists < 3) return result;
      const value = JSON.parse(result.stdout);
      value.result.snapshot.agents.push({
        ...agentFromState(sibling),
        tab_id: lifecycle.tabForPane(parent.paneId),
      });
      return { ...result, stdout: JSON.stringify(value) };
    },
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  const childMailbox = agentMailboxPath(WORKSPACE, "revalidation-child");
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "revalidation-start",
      {
        definition: "agent",
        task: "reject contaminated candidate",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(agentLists >= 3, true);
    assert.equal(lifecycle.createdTabs(), 1);
    assert.notEqual(
      lifecycle.tabForPane(parent.paneId),
      lifecycle.tabForPane("delegated-slot-1"),
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "pane" && args[1] === "split"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(siblingMailbox);
    resetAgentMailbox(childMailbox);
    nativeSessions.delete(parent.piSessionId);
    nativeSessions.delete(sibling.piSessionId);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("managed-agent delegation always splits in its current pane for every lead layout", async () => {
  for (const placement of ["tab", "subtree", "split"] as const) {
    setLeadEnvironment();
    writePlacementSetting(placement);
    const parent = {
      ...managedState(`nested-placement-parent-${placement}`),
      paneId: `nested-placement-parent-pane-${placement}`,
    };
    const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    resetAgentMailbox(parentMailbox);
    writeAgentState(parentMailbox, parent);
    const lifecycle = delegatedLifecycleExecutor(parent);
    process.env.PI_HERDSMAN_MAILBOX = parentMailbox;
    process.env.PI_HERDSMAN_RUN_ID = parent.runId;
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = parent.ownerSessionId;
    process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
    process.env.PI_HERDSMAN_LABEL = parent.agentLabel;
    process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify([
      "agent",
    ]);
    process.env.HERDR_PANE_ID = parent.paneId;
    const pi = fakePi({ exec: lifecycle.exec });
    registerExtension!(pi.pi as never);
    const context = fakeAgentContext([
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label: process.env.PI_HERDSMAN_LABEL ?? "agent",
        },
      },
    ]);
    const childMailbox = agentMailboxPath(WORKSPACE, "agent");
    try {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, context);
      const result = await registeredAgentTool(pi, "delegate").execute(
        `nested-${placement}`,
        {
          definition: "agent",
          task: "nested placement",
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(lifecycle.createdTabs(), 0);
      assert.equal(
        lifecycle.tabForPane(parent.paneId),
        lifecycle.tabForPane("delegated-slot-1"),
      );
      assert.ok(
        pi.calls.some(
          (args) =>
            args[0] === "pane" &&
            args[1] === "split" &&
            args[args.indexOf("--pane") + 1] === parent.paneId,
        ),
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
      realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
        force: true,
      });
    }
  }
});

test("nested managed-Agent delegation publishes inherited and local evidence as child requirements", async () => {
  const label = `evidence-parent-${randomUUID().slice(0, 8)}`;
  setAgentEnvironment(label, ["agent"]);
  const projectAssignmentId = LEAD_SESSION_ID;
  const socket = join(
    tmpdir(),
    `nested-project-authority-${randomUUID()}.sock`,
  );
  process.env.HERDR_SOCKET_PATH = socket;
  const projectRuntime = supervisionRuntime(socket);
  const projectBranch = `nested-${randomUUID()}`;
  const laterProjectRequirement = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "later-project.md",
    "project requirement not accepted by parent",
  );
  writeProjectAssignment(projectRuntime, {
    version: 2,
    id: projectAssignmentId,
    repoKey: "repo-key",
    branch: projectBranch,
    text: "Parent project",
    requiredEvidence: [laterProjectRequirement],
  });
  const parentRequestId = randomUUID();
  const inherited = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "plan.md",
    "parent plan body",
  );
  const local = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "review.md",
    "parent review body",
  );
  // Session startup cleans testTmpRoot; keep this source outside it.
  const retainedFile = join("/tmp", `agent-local-${randomUUID()}.md`);
  realFs.writeFileSync(retainedFile, "agent-local reviewer note");
  const retainedFileAfterResult = join(
    "/tmp",
    `agent-local-after-result-${randomUUID()}.md`,
  );
  realFs.writeFileSync(
    retainedFileAfterResult,
    "agent-local note after result",
  );
  const resultCanonicalRef = resultRef(randomUUID());
  const resultSemanticRef = "result:reviewer#2";
  const resultArtifact = resultPath(resultCanonicalRef.slice("result:".length));
  realFs.mkdirSync(resolve(resultArtifact, ".."), { recursive: true });
  realFs.writeFileSync(resultArtifact, "interleaved result content");
  const acceptedResultCanonicalRef = resultRef(randomUUID());
  const acceptedResultArtifact = resultPath(
    acceptedResultCanonicalRef.slice("result:".length),
  );
  realFs.mkdirSync(resolve(acceptedResultArtifact, ".."), { recursive: true });
  realFs.writeFileSync(acceptedResultArtifact, "already accepted result");
  const acceptedResult = {
    id: randomUUID(),
    name: "result:reviewer#1",
    result: {
      ref: "result:reviewer#1",
      canonicalRef: acceptedResultCanonicalRef,
    },
  } as const;
  const parent = {
    ...managedState(label, parentRequestId),
    projectAssignmentId,
  };
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "parent.md"),
    '---\nname: parent\nagents: ["agent"]\n---\nparent\n',
  );
  const parentMailbox = agentMailboxPath(WORKSPACE, label);
  let childMailbox = agentMailboxPath(WORKSPACE, "agent");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  Object.assign(process.env, {
    PI_HERDSMAN_MAILBOX: parentMailbox,
    PI_HERDSMAN_RUN_ID: parent.runId,
    PI_HERDSMAN_OWNER_SESSION_ID: parent.ownerSessionId,
    PI_HERDSMAN_OWNER_DISPLAY: "lead",
    PI_HERDSMAN_LABEL: label,
    PI_HERDSMAN_WORKSPACE_ID: WORKSPACE,
    PI_HERDSMAN_AGENT_DEFINITION: "parent",
    PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS: JSON.stringify(["agent"]),
    HERDR_PANE_ID: parent.paneId,
  });
  const lifecycle = delegatedLifecycleExecutor(parent);
  let published: RequestRecord | undefined;
  let stopConsumer: (() => void) | undefined;
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
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        const mailbox = agentMailboxPath(
          WORKSPACE,
          lifecycle.paneEnvironment.PI_HERDSMAN_LABEL!,
        );
        stopConsumer = consumeMailboxRequest(mailbox, (request) => {
          published = request;
        });
      }
      return result;
    },
  });
  const identity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: {
      sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      definition: "parent",
      label,
    },
  };
  const acceptedContext = {
    type: "custom",
    customType: "pi-herdsman-agent-required-evidence",
    data: {
      version: 1,
      sessionId: identity.data.sessionId,
      requestId: parentRequestId,
      runId: parent.runId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: label,
      paneId: parent.paneId,
      projectAssignmentId,
      evidenceAssignmentId: parentRequestId,
      inheritedEvidence: [inherited],
      localEvidence: [local, acceptedResult],
    },
  };
  const { ref: _inheritedRef, ...legacyInherited } = inherited;
  const { ref: _localRef, ...legacyLocal } = local;
  const legacyContext = {
    ...acceptedContext,
    data: {
      ...acceptedContext.data,
      inheritedEvidence: [legacyInherited],
      localEvidence: [legacyLocal, acceptedResult],
    },
  };
  const contextEntries: any[] = [
    identity,
    legacyContext,
    acceptedContext,
    {
      type: "custom",
      customType: "pi-herdsman-result-ref",
      data: acceptedResult.result,
    },
    {
      type: "custom",
      customType: "pi-herdsman-result-ref",
      data: { ref: resultSemanticRef, canonicalRef: resultCanonicalRef },
    },
  ];
  const context = fakeAgentContext(contextEntries);
  const appendEntry = pi.pi.appendEntry.bind(pi.pi);
  pi.pi.appendEntry = ((customType: string, data: unknown) => {
    appendEntry(customType, data);
    contextEntries.push({ type: "custom", customType, data });
  }) as typeof pi.pi.appendEntry;
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const nestedDelegate = pi.tools.find(
      (tool) => tool.name === "delegate_agent",
    )!;
    assert.ok(nestedDelegate.parameters.properties.retain);
    for (const retain of [true, false])
      assert.equal(
        Value.Check(nestedDelegate.parameters, {
          definition: "agent",
          task: "child task",
          retain,
        }),
        true,
      );
    assert.equal(
      Value.Check(nestedDelegate.parameters, {
        definition: "agent",
        task: "child task",
        retain: "true",
      }),
      false,
    );
    const evidenceReader = pi.tools.find(
      (tool) => tool.name === "read_evidence",
    )!;
    const acceptedRead = await evidenceReader.execute(
      "read-upgraded-session-evidence",
      { ref: inherited.ref },
      undefined,
      undefined,
      context,
    );
    assert.match(acceptedRead.content[0].text, /parent plan body/);
    assert.ok(
      realFs.existsSync(retainedFile),
      `fixture missing before retain: ${retainedFile}`,
    );
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "nested-project-evidence",
        {
          definition: "agent",
          task: "child task",
          files: [
            retainedFile,
            `${dirname(retainedFile)}${sep}.${sep}${basename(retainedFile)}`,
            resultSemanticRef,
            retainedFileAfterResult,
          ],
          retain: true,
        },
        undefined,
        undefined,
        context,
      );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    childMailbox = agentMailboxPath(WORKSPACE, result.details.agent as string);
    assert.ok(published);
    assert.equal(published!.requiredEvidence?.length, 6);
    assert.equal(
      published!.requiredEvidence!.filter(
        (entry) =>
          "path" in entry &&
          readRequiredEvidenceSnapshot(entry.sourceAssignmentId, entry) ===
            "agent-local reviewer note",
      ).length,
      1,
    );
    assert.equal(
      readRequiredEvidenceSnapshot(
        parentRequestId,
        published!.requiredEvidence![3]!,
      ),
      "agent-local reviewer note",
    );
    assert.equal(published!.projectAssignmentId, projectAssignmentId);
    assert.equal(published!.evidenceAssignmentId, published!.requestId);
    assert.ok(
      published!.text.indexOf("Task:") <
        published!.text.indexOf("agent-local reviewer note"),
      published!.text,
    );
    assert.equal(
      published!.text.match(/agent-local reviewer note/g)?.length,
      1,
    );
    const orderedCurrent = [
      "agent-local reviewer note",
      "result:reviewer#2",
      "interleaved result content",
      "agent-local note after result",
    ].map((content) => published!.text.indexOf(content));
    assert.ok(
      orderedCurrent.every((index) => index >= 0),
      published!.text,
    );
    assert.deepEqual(
      orderedCurrent,
      [...orderedCurrent].sort((a, b) => a - b),
      published!.text,
    );
    for (const ref of [inherited.ref!, local.ref!]) {
      assert.ok(published!.text.indexOf(ref) < orderedCurrent[0]!);
      assert.equal(published!.text.split(ref).length - 1, 1);
    }
    assert.equal(published!.text.split("result:reviewer#2").length - 1, 1);
    assert.ok(!published!.text.includes(published!.requiredEvidence![3]!.path));
    assert.match(published!.text, /evidence:plan#1 — plan\.md/);
    assert.match(published!.text, /evidence:review#1 — review\.md/);
    assert.doesNotMatch(published!.text, /parent plan body|parent review body/);
    const retained = published!.requiredEvidence![3]!;
    assert.ok(!("result" in retained));
    realFs.rmSync(retainedFile, { force: true });
    realFs.rmSync(retainedFileAfterResult, { force: true });
    realFs.rmSync(resultArtifact, { force: true });

    const retainedBeforeAcceptedResult = join(
      "/tmp",
      `agent-local-before-existing-result-${randomUUID()}.md`,
    );
    const retainedAfterAcceptedResult = join(
      "/tmp",
      `agent-local-after-existing-result-${randomUUID()}.md`,
    );
    realFs.writeFileSync(
      retainedBeforeAcceptedResult,
      "text before accepted result",
    );
    realFs.writeFileSync(
      retainedAfterAcceptedResult,
      "text after accepted result",
    );
    stopConsumer?.();
    stopConsumer = undefined;
    published = undefined;

    stopConsumer?.();
    published = undefined;
    assert.deepEqual(
      listProjectAssignments(projectRuntime, "repo-key").find(
        (item) => item.branch === projectBranch,
      )?.requiredEvidence,
      [laterProjectRequirement],
    );
    stopConsumer?.();
    published = undefined;
    const ordinaryChild = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "nested-project-evidence-ordinary-child",
        {
          definition: "agent",
          task: "ordinary child task",
          files: [
            retainedBeforeAcceptedResult,
            "result:reviewer#1",
            retainedAfterAcceptedResult,
          ],
          retain: true,
        },
        undefined,
        undefined,
        context,
      );
    assert.equal(
      ordinaryChild.details.ok,
      true,
      JSON.stringify(ordinaryChild.details),
    );
    childMailbox = agentMailboxPath(
      WORKSPACE,
      ordinaryChild.details.agent as string,
    );
    assert.ok(published);
    const mixedOrder = [
      "text before accepted result",
      "result:reviewer#1",
      "already accepted result",
      "text after accepted result",
    ].map((content) => published!.text.indexOf(content));
    assert.ok(
      mixedOrder.every((index) => index >= 0),
      published!.text,
    );
    assert.deepEqual(
      mixedOrder,
      [...mixedOrder].sort((a, b) => a - b),
    );
    assert.equal(published!.text.split("result:reviewer#1").length - 1, 1);
    assert.equal(
      published!.text.split("already accepted result").length - 1,
      1,
    );
    realFs.rmSync(retainedBeforeAcceptedResult, { force: true });
    realFs.rmSync(retainedAfterAcceptedResult, { force: true });
    realFs.rmSync(acceptedResultArtifact, { force: true });
    assert.deepEqual(published!.requiredEvidence?.slice(0, 2), [
      inherited,
      local,
    ]);
    assert.equal(published!.requiredEvidence?.length, 8);
    assert.ok(
      published!.requiredEvidence?.some(
        (entry) =>
          "result" in entry && entry.result.ref === "result:reviewer#1",
      ),
    );
    assert.doesNotMatch(published!.text, /agent-local reviewer note/);
    assert.ok(!published!.text.includes(retained.path));
    assert.match(published!.text, /evidence:plan#1 — plan\.md/);
    assert.match(published!.text, /evidence:review#1 — review\.md/);
    assert.doesNotMatch(published!.text, /parent plan body|parent review body/);
    assert.doesNotMatch(
      published!.text,
      /project requirement not accepted by parent/,
    );

    stopConsumer?.();
    const clearedRequestId = randomUUID();
    const clearedParent = {
      ...parent,
      projectAssignmentId: undefined,
      activeRequestId: clearedRequestId,
    };
    writeAgentState(parentMailbox, clearedParent);
    contextEntries.push({
      type: "custom",
      customType: "pi-herdsman-agent-required-evidence",
      data: {
        version: 1,
        sessionId: identity.data.sessionId,
        requestId: clearedRequestId,
        runId: parent.runId,
        ownerSessionId: parent.ownerSessionId,
        workspaceId: parent.workspaceId,
        agentLabel: label,
        paneId: parent.paneId,
        inheritedEvidence: [],
        localEvidence: [],
      },
    });
    published = undefined;
    const unavailableRetention = await nestedDelegate.execute(
      "nested-without-evidence-authority",
      {
        definition: "agent",
        task: "must not retain",
        files: [retainedFile],
        retain: true,
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(unavailableRetention.details.ok, false);
    assert.match(
      JSON.stringify(unavailableRetention.details),
      /Managed-Agent evidence scope is unavailable/,
    );
    assert.equal(published, undefined);
    const cleared = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "nested-after-unscoped",
        { definition: "agent", task: "unscoped follow-up" },
        undefined,
        undefined,
        context,
      );
    assert.equal(cleared.details.ok, true, JSON.stringify(cleared.details));
    childMailbox = agentMailboxPath(WORKSPACE, cleared.details.agent as string);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(published);
    assert.equal(published!.projectAssignmentId, undefined);
    assert.equal(published!.requiredEvidence, undefined);
    assert.doesNotMatch(published!.text, /parent plan body|parent review body/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    stopConsumer?.();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    realFs.rmSync(inherited.path, { force: true });
    realFs.rmSync(local.path, { force: true });
    realFs.rmSync(laterProjectRequirement.path, { force: true });
    realFs.rmSync(retainedFile, { force: true });
    realFs.rmSync(join(PI_AGENTS_DIR, "parent.md"), { force: true });
    removeProjectAssignment(projectRuntime, "repo-key", projectBranch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("nested delegation rejects parent evidence changes during child startup", async () => {
  const label = `evidence-race-parent-${randomUUID().slice(0, 8)}`;
  setAgentEnvironment(label, ["agent"]);
  const projectAssignmentId = LEAD_SESSION_ID;
  const socket = join(tmpdir(), `nested-project-race-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const projectRuntime = supervisionRuntime(socket);
  const projectBranch = `nested-race-${randomUUID()}`;
  writeProjectAssignment(projectRuntime, {
    version: 2,
    id: projectAssignmentId,
    repoKey: "repo-key",
    branch: projectBranch,
    text: "Parent project",
  });
  const parentRequestId = randomUUID();
  const inherited = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "plan.md",
    "parent plan body",
  );
  const local = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "review.md",
    "parent review body",
  );
  const replacementProjectAssignmentId = randomUUID();
  const parent = {
    ...managedState(label, parentRequestId),
    projectAssignmentId,
  };
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "parent.md"),
    '---\nname: parent\nagents: ["agent"]\n---\nparent\n',
  );
  const parentMailbox = agentMailboxPath(WORKSPACE, label);
  let childMailbox = agentMailboxPath(WORKSPACE, "agent");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  Object.assign(process.env, {
    PI_HERDSMAN_MAILBOX: parentMailbox,
    PI_HERDSMAN_RUN_ID: parent.runId,
    PI_HERDSMAN_OWNER_SESSION_ID: parent.ownerSessionId,
    PI_HERDSMAN_LABEL: label,
    PI_HERDSMAN_OWNER_DISPLAY: "lead",
    PI_HERDSMAN_WORKSPACE_ID: WORKSPACE,
    PI_HERDSMAN_AGENT_DEFINITION: "parent",
    PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS: JSON.stringify(["agent"]),
    HERDR_PANE_ID: parent.paneId,
  });
  let published: RequestRecord | undefined;
  let stopConsumer: (() => void) | undefined;
  const lifecycle = delegatedLifecycleExecutor(parent);
  const identity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: {
      sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      definition: "parent",
      label,
    },
  };
  const acceptedContext = {
    type: "custom",
    customType: "pi-herdsman-agent-required-evidence",
    data: {
      version: 1,
      sessionId: identity.data.sessionId,
      requestId: parentRequestId,
      runId: parent.runId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: label,
      paneId: parent.paneId,
      projectAssignmentId,
      evidenceAssignmentId: parentRequestId,
      inheritedEvidence: [inherited],
      localEvidence: [local],
    },
  };
  const contextEntries: any[] = [identity, acceptedContext];
  const context = fakeAgentContext(contextEntries);
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
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        writeProjectAssignment(projectRuntime, {
          version: 2,
          id: replacementProjectAssignmentId,
          repoKey: "repo-key",
          branch: projectBranch,
          text: "Replacement project",
        });
      }
      const result = lifecycle.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        const mailbox = agentMailboxPath(
          WORKSPACE,
          lifecycle.paneEnvironment.PI_HERDSMAN_LABEL!,
        );
        stopConsumer = consumeMailboxRequest(mailbox, (request) => {
          published = request;
        });
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "nested-project-evidence-race",
        { definition: "agent", task: "must not publish stale evidence" },
        undefined,
        undefined,
        context,
      );
    childMailbox = agentMailboxPath(WORKSPACE, result.details.agent as string);
    assert.notEqual(result.details.ok, true);
    assert.equal(published, undefined);
    assert.match(
      JSON.stringify(result.details),
      /project assignment changed|authority|foreign|conflicting/i,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    stopConsumer?.();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    for (const evidence of [inherited, local])
      realFs.rmSync(evidence.path, { force: true });
    realFs.rmSync(join(PI_AGENTS_DIR, "parent.md"), { force: true });
    removeProjectAssignment(projectRuntime, "repo-key", projectBranch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("parent delegation lock makes concurrent close and delegate fail fast", async () => {
  setLeadEnvironment();
  const parent = managedState("race-parent");
  const child = {
    ...managedState("race-child", undefined, recoveryIdentity("race-child")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/race-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");

  const lifecycle = delegatedLifecycleExecutor(parent, [child]);
  let closeEnteredResolve!: () => void;
  const closeEntered = new Promise<void>(
    (resolve) => (closeEnteredResolve = resolve),
  );
  let releaseCloseResolve!: () => void;
  const releaseClose = new Promise<void>(
    (resolve) => (releaseCloseResolve = resolve),
  );
  const sharedExec: ExecHandler = async (command, args, options) => {
    if (command === "herdr" && isPaneClose(args)) {
      closeEnteredResolve();
      await releaseClose;
    }
    return lifecycle.exec(command, args, options);
  };

  const leadPi = fakePi({ exec: sharedExec });
  registerExtension!(leadPi.pi as never);
  setAgentEnvironment("race-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const parentPi = fakePi({ exec: sharedExec });
  registerExtension!(parentPi.pi as never);
  const parentContext = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ]);
  const leadContext = fakeContext();

  try {
    for (const handler of parentPi.events.get("session_start") ?? [])
      await handler(undefined, parentContext);
    assert.equal(
      parentPi.entries.filter((entry: any) => entry.type === "custom").length,
      0,
      JSON.stringify(parentPi.entries),
    );

    const closePromise = registeredAgentTool(leadPi, "close").execute(
      "close",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      leadContext,
    );
    await closeEntered;

    const started = await registeredAgentTool(parentPi, "delegate").execute(
      "start",
      {
        definition: "child",
        task: "must not start during parent close",
      },
      undefined,
      undefined,
      parentContext,
    );
    assert.equal(
      started.details.error.category,
      "agent_busy",
      JSON.stringify(started.details),
    );
    assert.equal(
      parentPi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );

    releaseCloseResolve();
    const closed = await closePromise;
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.deepEqual(lifecycle.closeOrder, [
      child.agentLabel,
      parent.agentLabel,
    ]);
  } finally {
    releaseCloseResolve();
    for (const handler of leadPi.events.get("session_shutdown") ?? [])
      handler();
    for (const handler of parentPi.events.get("session_shutdown") ?? [])
      handler();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "race-new-child"));
    for (const [name] of files)
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
  }
});

test("zero-child lead close is blocked by the parent delegation lock", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "zero-child-parent",
      undefined,
      recoveryIdentity("zero-child-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/zero-child-parent.jsonl",
  };
  const mailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, parent);
  const lifecycle = cascadeExecutor([parent]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  let releaseLock: (() => void) | undefined = claimProcessLock(
    delegationLockPathForTest(WORKSPACE, parent.piSessionId),
    { name: "test delegation lifecycle" },
  );

  try {
    const closed = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      closed.details.error.category,
      "agent_busy",
      JSON.stringify(closed.details),
    );
    assert.match(closed.details.error.message, /Delegation lifecycle/);
    assert.match(
      closed.details.error.nextAction,
      /current delegation lifecycle/,
    );
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.equal(
      pi.calls.some((args) => isPaneClose(args)),
      false,
    );
    assert.equal(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herd_cleanup_error",
      ),
      false,
    );
    assert.ok(readAgentState(mailbox));
    releaseLock();
    releaseLock = undefined;
    const listed = await registeredAgentTool(pi, "list").execute(
      "list-after-busy-close",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(listed.details.cleanup_errors, undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    releaseLock?.();
    resetAgentMailbox(mailbox);
  }
});

test("lead close maps assignment-lock contention to agent_busy", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "assignment-lock-close-parent",
      undefined,
      recoveryIdentity("assignment-lock-close-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: join(testTmpRoot, "assignment-lock-close-parent.jsonl"),
  };
  const mailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, parent);
  const pi = fakePi({ exec: cascadeExecutor([]).exec });
  registerExtension!(pi.pi as never);
  const release = claimProcessLock(assignmentLockPathForTest(mailbox), {
    name: "test assignment transition",
  });
  try {
    const result = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      result.details.error.category,
      "agent_busy",
      result.details.error.message,
    );
    assert.match(result.details.error.message, /managed assignment/i);
    assert.match(result.details.error.nextAction, /retry/i);
    assert.ok(readAgentState(mailbox));
  } finally {
    release();
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("cascade close revalidates the parent generation under its assignment lock", async () => {
  setLeadEnvironment();
  const parent = managedState("close-generation-parent");
  const replacement = {
    ...managedState(
      parent.agentLabel,
      undefined,
      recoveryIdentity("close-generation-replacement"),
    ),
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    piSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const lifecycle = cascadeExecutor([parent]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const parentStatePath = join(parentMailbox, "state.json");
  let parentStateReads = 0;

  try {
    support.agentStateReadHook = (path) => {
      if (path !== parentStatePath) return;
      parentStateReads++;
      // The snapshot has captured generation A; replace it after the close
      // action's targeted state read, before cascade planning begins.
      if (parentStateReads === 2) {
        support.agentStateReadHook = undefined;
        writeAgentState(parentMailbox, replacement);
      }
    };
    const closed = await registeredAgentTool(pi, "close").execute(
      "close-generation-race",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );

    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.match(closed.details.error.message, /changed before close/);
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.deepEqual(readAgentState(parentMailbox), replacement);
  } finally {
    support.agentStateReadHook = undefined;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
  }
});

test("cascade close keeps the parent when descendant mailbox cleanup is unresolved", async () => {
  setLeadEnvironment();
  const parent = managedState("cleanup-cascade-parent", undefined, {
    ...defaultFixtureIdentity,
    paneId: "cleanup-cascade-parent-pane",
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/cleanup-cascade-parent.jsonl",
  });
  const child = {
    ...managedState("cleanup-cascade-child", undefined, {
      ...defaultFixtureIdentity,
      paneId: "cleanup-cascade-child-pane",
      piSessionId: "22222222-2222-4222-8222-222222222222",
      piSessionFile: "/tmp/cleanup-cascade-child.jsonl",
    }),
    ownerSessionId: parent.piSessionId,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeRequest(childMailbox, {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    kind: "task",
    text: "unrelated cleanup artifact",
    createdAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([parent, child]);
  let childRemovedBeforeParentClose = false;
  const pi = fakePi({
    exec: (command, args) => {
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "close" &&
        args[2] === parent.paneId
      ) {
        assert.equal(readAgentState(childMailbox), undefined);
        childRemovedBeforeParentClose = true;
      }
      return lifecycle.exec(command, args);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    support.failNextRequestRemoval = true;
    const first = await registeredAgentTool(pi, "close").execute(
      "close-parent-with-child-cleanup-failure",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(first.details.ok, false);
    assert.equal(first.details.error.category, "internal_failure");
    assert.match(
      first.details.error.message,
      /Descendant mailbox cleanup is unresolved/,
    );
    assert.match(
      first.details.error.cleanup.message,
      /injected request removal failure/,
    );
    assert.equal(first.details.error.ids.label, child.agentLabel);
    assert.equal(
      pi.entries.filter(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ).length,
      1,
    );
    assert.ok(readAgentState(childMailbox));
    assert.ok(readAgentState(parentMailbox));
    assert.deepEqual(lifecycle.closeOrder, [child.agentLabel]);

    const retried = await registeredAgentTool(pi, "close").execute(
      "retry-parent-close-after-child-cleanup",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    assert.equal(readAgentState(childMailbox), undefined);
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.deepEqual(lifecycle.closeOrder, [
      child.agentLabel,
      parent.agentLabel,
    ]);
    assert.equal(childRemovedBeforeParentClose, true);
  } finally {
    support.failNextRequestRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("staged fresh assignment bridges pending start through working", async (t) => {
  const fixture = createStagedAssignmentFixture("agent");
  const list = () =>
    registeredAgentTool(fixture.pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fixture.context,
    );
  try {
    await t.waitFor(() =>
      assert.equal(
        fixture.initialStatusStarted,
        true,
        "session status must start its initial snapshot before delegation",
      ),
    );
    const starting = registeredAgentTool(fixture.pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "bridge the staged lifecycle",
      },
      undefined,
      undefined,
      fixture.context,
    );
    await t.waitFor(() =>
      assert.ok(
        fixture.pi.calls.some(
          (args) => args[0] === "agent" && args[1] === "start",
        ),
        "assignment did not reach the gated startup",
      ),
    );
    fixture.releaseInitialStatus();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readAgentState(fixture.mailbox), undefined);
    assert.equal(
      /agent/.test(fixture.widgetValue.render(160).join("\n")),
      true,
    );

    fixture.releaseStart();
    await t.waitFor(() =>
      assert.ok(
        fixture.preSubmitValidationReady,
        "assignment did not reach pre-submit validation",
      ),
    );
    const beforeAck = await list();
    assert.equal(fixture.requestObserved, false);
    assert.equal(beforeAck.details.agents[0].state, "settling");
    const renderedBeforeAck = fixture.widgetValue.render(160).join("\n");
    assert.match(renderedBeforeAck, /starting/);
    assert.doesNotMatch(renderedBeforeAck, /settling/);
    assert.match(renderedBeforeAck, /agent/);

    fixture.releasePreSubmitValidation();
    await t.waitFor(() =>
      assert.ok(
        fixture.requestObserved,
        "assignment did not reach the gated request handoff",
      ),
    );
    fixture.releaseAcknowledgement();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const requestId = result.details.request_id;
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(requestId, fixture.requestId);
    assert.equal(requestId, fixture.acceptedRequestIdWritten);
    assert.equal(
      readAgentState(fixture.mailbox)?.lastAck?.requestId,
      requestId,
    );
    assert.equal(readAgentState(fixture.mailbox)?.activeRequestId, undefined);

    const afterAck = await list();
    assert.equal(afterAck.details.agents[0].state, "settling");

    const settlingRefresh = await list();
    assert.equal(settlingRefresh.details.agents[0].state, "settling");
    const renderedAfterAck = fixture.widgetValue.render(160).join("\n");
    assert.match(renderedAfterAck, /starting/);
    assert.doesNotMatch(renderedAfterAck, /settling/);

    fixture.markWorking(requestId);
    const working = await list();
    assert.equal(working.details.agents[0].state, "working");
    assert.equal(working.details.agents[0].active_request_id, requestId);
    assert.equal(
      working.details.agents[0].available_tools.includes("delegate_agent"),
      false,
    );
    await t.waitFor(
      () => {
        const rendered = fixture.widgetValue.render(160).join("\n");
        assert.match(rendered, /1 working/);
        assert.doesNotMatch(rendered, /starting/);
      },
      { timeout: 3_000 },
    );
    assert.equal(working.details.agents.length, 1);
    assert.ok(fixture.workingObservations > 0);

    const settling = await list();
    assert.equal(settling.details.agents[0].state, "working");
    assert.doesNotMatch(fixture.widgetValue.render(160).join("\n"), /ready/);
  } finally {
    fixture.shutdown();
  }
});

test("fixture mailbox consumer retries a failed acknowledgement callback", async (t) => {
  const mailbox = setAgentEnvironment("fixture-retry-agent");
  const state = managedState("fixture-retry-agent");
  writeAgentState(mailbox, state);
  const request: RequestRecord = {
    version: 5,
    runId: state.runId,
    requestId: randomUUID(),
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "retry fixture acknowledgement",
    createdAt: Date.now(),
  };
  let attempts = 0;
  const stop = consumeMailboxRequest(mailbox, (observed) => {
    attempts++;
    if (attempts === 1) throw new Error("injected fixture callback failure");
    const current = readAgentState(mailbox)!;
    writeAgentState(mailbox, {
      ...current,
      activeRequestId: observed.requestId,
      lastAck: {
        requestId: observed.requestId,
        accepted: true,
        acknowledgedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
  });
  try {
    writeRequest(mailbox, request);
    await t.waitFor(() =>
      assert.equal(
        readAgentState(mailbox)?.lastAck?.requestId,
        request.requestId,
        "fixture mailbox consumer did not retry acknowledgement",
      ),
    );
    assert.equal(attempts, 2);
  } finally {
    stop();
    resetAgentMailbox(mailbox);
  }
});

test("fresh path sessions remain controllable after controller cache loss", async () => {
  setLeadEnvironment();
  const label = "agent";
  const sessionPath = join(testTmpRoot, "registered-agent.jsonl");
  realFs.rmSync(sessionPath, { force: true });
  realFs.writeFileSync(
    sessionPath,
    JSON.stringify({ type: "session", id: DEFAULT_PI_SESSION_ID }),
    "utf8",
  );
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    undefined,
    sessionPath,
  );
  const pathSession = (result: { stdout: string; [key: string]: unknown }) => {
    const payload = JSON.parse(result.stdout);
    const agents = [payload.result?.agent, ...(payload.result?.agents ?? [])];
    for (const agent of agents)
      if (agent?.agent_session)
        agent.agent_session = {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: sessionPath,
        };
    return { ...result, stdout: JSON.stringify(payload) };
  };
  const pi = fakePi({
    exec: async (command, args, options) => {
      const result = await startup.exec(command, args, options);
      return command === "herdr" && args[0] === "agent"
        ? pathSession(result)
        : result;
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
  try {
    const delegated = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "fresh path" },
      undefined,
      undefined,
      context,
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    assert.equal(delegated.details.action, "delegate");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && args[1] === "start" && args.includes("--fork"),
      ),
      false,
    );
    assert.equal(readAgentState(startup.mailbox)?.lastAck?.accepted, true);
    assert.equal(readAgentState(startup.mailbox)?.agentDefinition, "agent");
    realFs.rmSync(sessionPath, { force: true });
    assert.equal(realFs.existsSync(sessionPath), false);

    support.sessionOpenError = new Error("child session is not materialized");
    for (const handler of pi.events.get("session_shutdown") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const recovered = readAgentState(startup.mailbox)!;
    assert.ok(recovered.activeRequestId);
    assert.ok(watchedMailboxDirectories.has(startup.mailbox));
    const listed = await pi.tools
      .find((tool) => tool.name === "list_agents")!
      .execute("list", {}, undefined, undefined, context);
    assert.equal(
      listed.details.agents[0]?.agent,
      label,
      JSON.stringify(listed.details),
    );

    const inspected = await registeredAgentTool(pi, "inspect").execute(
      "inspect",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(inspected.details.ok, true, JSON.stringify(inspected.details));

    const closed = await registeredAgentTool(pi, "close").execute(
      "close",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(readAgentState(startup.mailbox), undefined);
    assert.equal(realFs.existsSync(startup.mailbox), false);
    assert.ok(
      pi.calls.some((args) => isPaneClose(args) && args[2] === "startup-pane"),
    );
  } finally {
    support.sessionOpenError = undefined;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("staged fresh assignment removes a fast completion during the initial result check", async (t) => {
  const fixture = createStagedAssignmentFixture("agent", true);
  try {
    await t.waitFor(() =>
      assert.equal(
        fixture.initialStatusStarted,
        true,
        "session status must start its initial snapshot before delegation",
      ),
    );
    const starting = registeredAgentTool(fixture.pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "complete before the working snapshot",
      },
      undefined,
      undefined,
      fixture.context,
    );
    await t.waitFor(() =>
      assert.ok(
        fixture.pi.calls.some(
          (args) => args[0] === "agent" && args[1] === "start",
        ),
        "fast assignment did not reach the gated startup",
      ),
    );
    fixture.releaseStart();
    await t.waitFor(() =>
      assert.ok(
        fixture.preSubmitValidationReady,
        "fast assignment did not reach pre-submit validation",
      ),
    );
    fixture.releasePreSubmitValidation();
    await t.waitFor(() =>
      assert.ok(
        fixture.requestObserved,
        "fast assignment did not reach the gated request handoff",
      ),
    );
    fixture.releaseAcknowledgement();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.request_id, fixture.requestId);
    const requestId = fixture.requestId;
    assert.equal(requestId, fixture.requestId);
    assert.equal(requestId, fixture.acceptedRequestIdWritten);
    fixture.markCompleted(requestId);

    fixture.releaseInitialStatus();
    await t.waitFor(
      () =>
        assert.ok(
          fixture.pi.sent.some(
            (message: any) => message.customType === "pi-herdsman-agent-result",
          ),
          "fast completion result was not delivered",
        ),
      { timeout: 5000 },
    );
    assert.equal(watchedMailboxDirectories.has(fixture.mailbox), false);
    assert.equal(requestId, fixture.requestId);
    assert.equal(fixture.workingObservations, 0);
    await t.waitFor(() =>
      assert.doesNotMatch(
        fixture.widgetValue.render(160).join("\n"),
        /starting/,
      ),
    );
  } finally {
    fixture.shutdown();
  }
});

test("staged fresh assignment ignores a mismatched completion before delivery", async (t) => {
  const fixture = createStagedAssignmentFixture("agent", true, true);
  try {
    await t.waitFor(() => assert.equal(fixture.initialStatusStarted, true));
    fixture.releaseInitialStatus();
    const starting = registeredAgentTool(fixture.pi, "delegate").execute(
      "id",
      { definition: "agent", task: "reject mismatched completion" },
      undefined,
      undefined,
      fixture.context,
    );
    await t.waitFor(() =>
      assert.ok(
        fixture.pi.calls.some(
          (args) => args[0] === "agent" && args[1] === "start",
        ),
      ),
    );
    fixture.releaseStart();
    await t.waitFor(() => assert.ok(fixture.preSubmitValidationReady));
    fixture.releasePreSubmitValidation();
    await t.waitFor(() => assert.ok(fixture.requestObserved));
    fixture.releaseAcknowledgement();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await t.waitFor(() =>
      assert.match(fixture.widgetValue.render(160).join("\n"), /starting/),
    );
    assert.equal(
      fixture.pi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ),
      false,
    );
  } finally {
    fixture.shutdown();
  }
});

test("lead herd runs start once and stay open through intermediate settlement", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const label = "agent";
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  const pi = fakePi({ exec: startup.exec });
  const context = fakeContext(pi.entries);
  let contextPercent: number | null = 61;
  context.getContextUsage = () => ({
    tokens: 2,
    contextWindow: 10,
    percent: contextPercent,
  });
  const metadataCalls = () =>
    pi.calls.filter(
      (args) => args[0] === "pane" && args[1] === "report-metadata",
    );
  const herdEntries = () =>
    pi.entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  const emit = async (name: string) => {
    if (name === "agent_settled") {
      for (const handler of pi.events.get("turn_end") ?? [])
        await handler(
          {
            outcome: "completed",
            message: { role: "assistant", content: [] },
            messageEntryId: "test-response",
          },
          context,
        );
      for (const handler of pi.events.get("agent_before_settle") ?? [])
        await handler({ outcome: "completed" }, context);
    }
    for (const handler of pi.events.get(name) ?? [])
      await handler(
        name === "agent_settled" ? { aborted: false } : undefined,
        context,
      );
  };
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await t.waitFor(() =>
      assert.ok(
        metadataCalls().some((args) =>
          args.includes("pi_herdsman_context_percent=61"),
        ),
      ),
    );
    await emit("turn_end");
    contextPercent = null;
    await emit("session_compact");
    await t.waitFor(() =>
      assert.ok(
        metadataCalls().some(
          (args) =>
            args.includes("--clear-token") &&
            args.includes("pi_herdsman_context_percent"),
        ),
      ),
    );
    await emit("agent_start");
    const first = await registeredAgentTool(pi, "delegate").execute(
      "first-delegate",
      { definition: "agent", label, task: "first task" },
      undefined,
      undefined,
      context,
    );
    assert.equal(first.details.ok, true, JSON.stringify(first.details));
    const started = herdEntries().filter(
      (entry) => entry.data?.phase === "started",
    );
    assert.equal(started.length, 1);
    assert.equal(started[0].data.sessionId, LEAD_SESSION_ID);
    assert.equal(Number.isFinite(started[0].data.startedAt), true);
    await t.waitFor(() =>
      assert.ok(
        metadataCalls().some((args) =>
          args.includes(
            `pi_herdsman_herd_run_started_at=${started[0].data.startedAt}`,
          ),
        ),
      ),
    );

    await emit("agent_settled");
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "finished").length,
      0,
    );
    resetAgentMailbox(startup.mailbox);
    await emit("agent_start");
    const second = await registeredAgentTool(pi, "delegate").execute(
      "second-delegate",
      { definition: "agent", label, task: "second task" },
      undefined,
      undefined,
      context,
    );
    assert.equal(second.details.ok, true, JSON.stringify(second.details));
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "started").length,
      1,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }

  const invalidPi = fakePi();
  registerExtension!(invalidPi.pi as never);
  for (const invalidLabel of [
    "Ainvalid",
    "invalid.label",
    "a" + "b".repeat(32),
  ]) {
    const result = await registeredAgentTool(invalidPi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label: invalidLabel,
        task: "reject invalid label",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.ok(
      invalidPi.calls.every(
        (args) =>
          (args[0] === "status" && args[1] === "--json") || isApiSnapshot(args),
      ),
      `invalid label made unexpected calls: ${JSON.stringify(invalidPi.calls)}`,
    );
  }
});

test("restored herd run keeps its start and closes after settlement", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const socket = join(tmpdir(), `restored-handoff-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `restored-${randomUUID()}`;
  writeProjectAssignment(runtime, {
    version: 2,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
  });
  const startedAt = 1_700_000_000_000;
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: startedAt + 1,
        content: [{ type: "text", text: "UNVERIFIED_RESTORED_SUMMARY" }],
      },
    },
  ];
  const label = "agent";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const exec = async (command: string, args: string[]) => {
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
    return startup.exec(command, args);
  };
  const pi = fakePi({ entries, exec });
  const context = fakeContext(entries);
  const herdEntries = () =>
    entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler({ aborted: false }, context);
    await t.waitFor(() =>
      assert.equal(
        herdEntries().filter((entry) => entry.data?.phase === "finished")
          .length,
        1,
        "restored herd run did not finish after settlement",
      ),
    );
    await t.waitFor(() =>
      assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 1),
    );
    const [handoff] = listProjectMessages(runtime, "repo-key", branch);
    assert.match(handoff.text, /outcome was not preserved across restoration/);
    assert.match(handoff.text, /work remains unresolved/);
    assert.doesNotMatch(handoff.text, /UNVERIFIED_RESTORED_SUMMARY/);
    assert.equal(
      listProjectAssignments(runtime, "repo-key").some(
        (assignment) => assignment.id === LEAD_SESSION_ID,
      ),
      true,
      "restored handoff must not resolve the project assignment",
    );
    const finished = herdEntries().find(
      (entry) => entry.data?.phase === "finished",
    );
    assert.equal(finished.data.startedAt, startedAt);
    assert.ok(finished.data.completedAt >= startedAt);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "pane" &&
          args[1] === "report-metadata" &&
          args.includes("--clear-token") &&
          args.includes("pi_herdsman_herd_run_started_at"),
      ),
    );
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    const second = await registeredAgentTool(pi, "delegate").execute(
      "second-run",
      { definition: "agent", label, task: "second run" },
      undefined,
      undefined,
      context,
    );
    assert.equal(second.details.ok, true, JSON.stringify(second.details));
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "started").length,
      3,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    rmSync(
      projectAssignmentPath(runtime, "repo-key", branch).replace(
        /\.json$/,
        ".messages",
      ),
      { recursive: true, force: true },
    );
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("registered managed Lead fails closed if its worktree scope disappears", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const socket = join(tmpdir(), `managed-scope-loss-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `managed-${randomUUID()}`;
  writeProjectAssignment(runtime, {
    version: 2,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
  });
  const startedAt = Date.now();
  const runReportId = randomUUID();
  const reportId = runReportId;
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId: LEAD_SESSION_ID,
        kind: "managed",
        repoKey: "repo-key",
        branch,
      },
    },
  ];
  let scopeUnavailable = false;
  const scopePlans: {
    gate?: Promise<void>;
    started?: () => void;
    unavailable?: boolean;
  }[] = [];
  const startup = startupExecutor("agent", () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({
    entries,
    allTools: [{ name: "read_evidence" }, { name: "message_supervisor" }],
    exec: async (command, args) => {
      if (
        command === "herdr" &&
        isApiSnapshot(args) &&
        !readAgentState(startup.mailbox)
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
        const plan = scopePlans.shift();
        plan?.started?.();
        if (plan?.gate) await plan.gate;
        return (plan?.unavailable ?? scopeUnavailable)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                error: {
                  code: "not_git_worktree",
                  message: "Workspace is not a Git worktree",
                },
              }),
              stderr: "",
              code: 1,
            }
          : {
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
      }
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.hasUI = true;
  context.isIdle = () => false;
  registerExtension!(pi.pi as never);
  t.after(async () => {
    for (const handler of pi.events.get("session_shutdown") ?? [])
      await handler(undefined, context);
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    delete process.env.HERDR_SOCKET_PATH;
  });
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
  for (const handler of pi.events.get("agent_start") ?? [])
    await handler(undefined, context);
  const assignmentMessage = {
    customType: "pi-herdsman-project_assignment",
    details: { id: LEAD_SESSION_ID, branch },
    timestamp: Date.now(),
    content: "Project assignment for branch\nImplement the assigned project",
  };
  (context.sessionManager.getBranch as () => any[])().push({
    type: "custom_message",
    customType: assignmentMessage.customType,
    message: assignmentMessage,
  });
  for (const handler of pi.events.get("message_start") ?? [])
    await handler({ message: assignmentMessage }, context);
  await assertManagedLeadRole(pi, context);
  assert.ok(pi.tools.some((tool) => tool.name === "read_evidence"));
  assert.ok(pi.pi.getActiveTools().includes("read_evidence"));
  assert.ok(pi.pi.getActiveTools().includes("message_supervisor"));

  entries.push(
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId: runReportId,
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "report_pending",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId,
        runReportId,
        message: "Existing assigned handoff",
        target: "project",
      },
    },
  );
  scopePlans.push({});
  await pi.events.get("session_start")![0](undefined, context);
  scopeUnavailable = true;
  const priorDiagnosticCount = entries.filter(
    (entry: any) => entry.customType === "pi_herdsman_state_error",
  ).length;
  for (const handler of pi.events.get("agent_settled") ?? [])
    await handler({ aborted: false }, context);
  assert.ok(
    entries
      .filter((entry: any) => entry.customType === "pi_herdsman_state_error")
      .slice(priorDiagnosticCount)
      .some((entry: any) =>
        /Cannot verify (?:the original managed project scope|the current project assignment)/.test(
          entry.data.error,
        ),
      ),
    `production runtime records the fail-closed assignment diagnostic: ${JSON.stringify(
      entries
        .filter((entry: any) => entry.customType === "pi_herdsman_state_error")
        .slice(priorDiagnosticCount),
    )}`,
  );
  assert.equal(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "finished" &&
        entry.data?.startedAt === startedAt,
    ),
    false,
    "a managed Lead must not finish when assignment scope cannot be verified",
  );
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "report_pending" &&
        entry.data?.reportId === runReportId,
    ),
    "the pending handoff remains durable",
  );
  scopeUnavailable = false;

  const rpcRunningStatus = async () => {
    context.mode = "rpc";
    const selections = ["Agents", "Running"];
    context.ui.select = async (_title, options) => {
      const selection = selections.shift();
      return selection && options.includes(selection) ? selection : undefined;
    };
    await pi.commandOptions.get("herdsman")!.handler("", context);
    context.mode = "tui";
  };

  scopePlans.push({});
  await rpcRunningStatus();

  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshStartedPromise = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  scopePlans.push({ gate: refreshGate, started: refreshStarted });
  context.isIdle = () => true;
  const refreshing = pi.events.get("agent_settled")![0](
    { aborted: false },
    context,
  );
  await refreshStartedPromise;
  assert.ok(
    pi.pi.getActiveTools().includes("read_evidence"),
    "reader before refresh",
  );
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "pending-verification",
      {
        definition: "agent",
        label: "agent",
        task: "verify delegation during pending scope check",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    releaseRefresh();
    await refreshing;
  } finally {
    releaseRefresh();
    await Promise.allSettled([refreshing]);
  }
  assert.ok(
    pi.pi.getActiveTools().includes("read_evidence"),
    "successful exact scope verification restores Managed Lead tools",
  );
  assert.ok(
    pi.pi.getActiveTools().includes("message_supervisor"),
    "successful exact scope verification restores supervisor tools",
  );

  scopeUnavailable = true;
  scopePlans.push({ unavailable: true });
  await rpcRunningStatus();
  assert.ok(
    !pi.pi.getActiveTools().includes("read_evidence"),
    "completed unavailable verification revokes Lead tools before overlapping checks",
  );
  scopeUnavailable = false;

  let releaseOlder!: () => void;
  let olderStarted!: () => void;
  const olderGate = new Promise<void>((resolve) => (releaseOlder = resolve));
  const olderStartedPromise = new Promise<void>(
    (resolve) => (olderStarted = resolve),
  );
  scopePlans.push({ gate: olderGate, started: olderStarted });
  let olderStatus: Promise<void> | undefined;
  let newerStatus: Promise<void> | undefined;
  try {
    olderStatus = rpcRunningStatus();
    await olderStartedPromise;
    scopePlans.push({ unavailable: true });
    newerStatus = rpcRunningStatus();
    await newerStatus;
    assert.ok(!pi.pi.getActiveTools().includes("read_evidence"));
    releaseOlder();
    await olderStatus;
    assert.ok(
      !pi.pi.getActiveTools().includes("read_evidence"),
      "older successful verification cannot restore tools after a newer unavailable result",
    );
  } finally {
    releaseOlder();
    await Promise.allSettled(
      [olderStatus, newerStatus].filter(
        (status): status is Promise<void> => status !== undefined,
      ),
    );
  }

  let releaseSessionChange!: () => void;
  let sessionCheckStarted!: () => void;
  const sessionChangeGate = new Promise<void>(
    (resolve) => (releaseSessionChange = resolve),
  );
  const sessionCheckStartedPromise = new Promise<void>(
    (resolve) => (sessionCheckStarted = resolve),
  );
  scopePlans.push({});
  await pi.events.get("session_start")![0](undefined, context);
  assert.ok(pi.pi.getActiveTools().includes("read_evidence"));
  scopePlans.push({ gate: sessionChangeGate, started: sessionCheckStarted });
  const originalSessionId = context.sessionManager.getSessionId;
  let sessionStatus: Promise<void> | undefined;
  try {
    sessionStatus = rpcRunningStatus();
    await sessionCheckStartedPromise;
    context.sessionManager.getSessionId = () => "different-session";
    releaseSessionChange();
    await sessionStatus;
    assert.ok(
      pi.pi.getActiveTools().includes("read_evidence"),
      "session change leaves the previously active Lead tools unchanged",
    );
  } finally {
    releaseSessionChange();
    context.sessionManager.getSessionId = originalSessionId;
    if (sessionStatus) await Promise.allSettled([sessionStatus]);
  }

  scopeUnavailable = true;
  scopePlans.push({ unavailable: true });
  await pi.events.get("session_start")![0](undefined, context);
  assert.ok(
    !pi.pi.getActiveTools().includes("read_evidence"),
    "unavailable verification revokes Lead tools",
  );
  const denied = await registeredAgentTool(pi, "delegate").execute(
    "unavailable-scope-delegate",
    {
      definition: "agent",
      label: "unavailable-scope",
      task: "must fail closed",
    },
    undefined,
    undefined,
    context,
  );
  assert.notEqual(
    denied.details.ok,
    true,
    "unverifiable scope must deny fresh work",
  );
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "report_pending" &&
        entry.data?.reportId === reportId,
    ),
    "the pending handoff remains durable",
  );
  scopeUnavailable = false;
});

test("unassigned Lead does not activate read_evidence", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const socket = join(tmpdir(), `unassigned-scope-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  supervisionRuntime(socket);
  const startedAt = Date.now();
  const runReportId = randomUUID();
  const reportId = randomUUID();
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId: runReportId,
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "report_pending",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId,
        runReportId,
        message: "Existing assigned handoff",
        target: "project",
      },
    },
  ];
  let scopeUnavailable = false;
  const startup = startupExecutor("agent", () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({
    entries,
    allTools: [{ name: "read_evidence" }],
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return scopeUnavailable
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                error: {
                  code: "not_git_worktree",
                  message: "Workspace is not a Git worktree",
                },
              }),
              stderr: "",
              code: 1,
            }
          : {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(entries);
  context.isIdle = () => false;
  registerExtension!(pi.pi as never);
  t.after(async () => {
    for (const handler of pi.events.get("session_shutdown") ?? [])
      await handler(undefined, context);
  });
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
  for (const handler of pi.events.get("agent_start") ?? [])
    await handler(undefined, context);
  assert.ok(pi.tools.some((tool) => tool.name === "read_evidence"));
  assert.ok(!pi.pi.getActiveTools().includes("read_evidence"));
});

test("aborted Lead settlement waits for active child work before finishing the herd", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let childActive = true;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () =>
      childActive
        ? [{ state: { ownerSessionId: LEAD_SESSION_ID } } as any]
        : [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => true,
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  const finished = () =>
    pi.entries.filter(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "finished",
    ).length;

  herd.agentStarted();
  herd.begin(context);
  await herd.agentSettled(context, true);
  assert.equal(
    finished(),
    0,
    "aborted Lead settlement must not finish while child work is active",
  );

  childActive = false;
  await herd.maybeFinish(context);
  assert.equal(
    finished(),
    1,
    "settling child work should allow the herd to finish",
  );
});

test("failed active Lead reports before child completion and does not hand off success", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let childActive = true;
  const reports: string[] = [];
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () =>
      childActive
        ? [{ state: { ownerSessionId: LEAD_SESSION_ID } } as any]
        : [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async (_ctx, _assignment, message) => {
      reports.push(message);
      return false;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "error",
    message: { role: "assistant", content: "partial output".repeat(500) },
    messageEntryId: "failed-response",
  });
  herd.beforeSettle({ outcome: "error" });
  await herd.agentSettled(context, false);
  assert.ok(
    pi.entries.some((entry: any) => entry.data?.phase === "report_pending"),
    "the failure report is durably pending for delivery",
  );
  assert.equal(reports.length, 1);
  assert.match(reports[0], /failed before completion/);
  assert.match(reports[0], /partial output/);
  assert.ok(reports[0].length < 1200, "partial failure detail stays bounded");
  assert.equal(
    pi.entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "finished",
    ),
    false,
    "child ownership keeps the herd active",
  );
  childActive = false;
  await herd.maybeFinish(context);
  assert.equal(
    reports.length,
    2,
    "a false publication return is recorded as returned and remains retryable",
  );
});

test("unassigned Lead and Manager failure reports replay the exact Chief payload", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const roles: string[] = [];
  for (const role of ["lead", "manager"] as const) {
    const pi = fakePi();
    const context = fakeContext(pi.entries);
    context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
    context.isIdle = () => true;
    const published = new Map<string, { message: string; createdAt: number }>();
    let writes = 0;
    const herd = createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => role,
      isVerifiedActiveLead: () => true,
      isManagedLead: () => role === "manager",
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => undefined,
      publishProjectMessage: async () => {
        throw new Error("unassigned work must not use project handoff");
      },
      publishChiefFailure: async (
        _ctx,
        message,
        reportId,
        targetRole,
        createdAt,
      ) => {
        writes++;
        assert.match(message, /failed before completion/);
        assert.ok(message.length < 1200, "Chief failure detail stays bounded");
        assert.ok(reportId);
        assert.ok(Number.isFinite(createdAt));
        assert.equal(
          pi.entries.find(
            (entry: any) =>
              entry.customType === "pi-herdsman-herd-run" &&
              entry.data?.phase === "report_pending" &&
              entry.data?.reportId === reportId,
          )?.data?.createdAt,
          createdAt,
          "publication timestamp must be persisted before the Chief write",
        );
        const prior = published.get(reportId);
        if (prior) assert.deepEqual(prior, { message, createdAt });
        else published.set(reportId, { message, createdAt });
        roles.push(targetRole);
        return true;
      },
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => {},
    });
    herd.agentStarted();
    herd.turnEnd({
      outcome: "error",
      message: {
        role: "assistant",
        content: role === "lead" ? "partial".repeat(500) : "partial",
      },
      messageEntryId: "failed-response",
    });
    herd.beforeSettle({ outcome: "error" });
    await herd.agentSettled(context, false);
    const reportId = pi.entries.find(
      (entry: any) => entry.data?.phase === "report_pending",
    )?.data?.reportId;
    for (let i = pi.entries.length - 1; i >= 0; i--) {
      if ((pi.entries[i] as any).data?.phase === "report_sent")
        pi.entries.splice(i, 1);
    }
    herd.restoreSession(pi.entries, LEAD_SESSION_ID);
    herd.finishIfIdle(context);
    await t.waitFor(() => assert.equal(writes, 2));
    assert.equal(published.size, 1);
    assert.ok(reportId);
  }
  assert.deepEqual(roles, ["lead", "lead", "manager", "manager"]);
});

test("Lead failure report keeps its assigned-project destination across retirement", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  pi.entries.push({
    type: "custom",
    customType: "pi-herdsman-session-kind",
    data: {
      version: 1,
      sessionId: LEAD_SESSION_ID,
      kind: "managed",
      repoKey: "repo-key",
      branch: "assigned-branch",
    },
  });
  let role: "lead" | "manager" = "lead";
  let assignment: object | undefined = { project: "assigned" };
  let chiefFailures = 0;
  let projectPublications = 0;
  const isManagedLead = () =>
    readSessionKind(pi.entries, context.sessionManager.getSessionId())?.kind ===
    "managed";
  assert.equal(isManagedLead(), true);
  context.sessionManager.getSessionId = () => "different-session";
  assert.equal(
    isManagedLead(),
    false,
    "identity is bound to the exact session",
  );
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  const createRuntime = () =>
    createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => role,
      isVerifiedActiveLead: () => true,
      isManagedLead,
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => assignment,
      publishProjectMessage: async () => {
        projectPublications++;
        return false;
      },
      publishChiefFailure: async () => {
        chiefFailures++;
        return true;
      },
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => {},
    });

  const first = createRuntime();
  first.agentStarted();
  first.turnEnd({
    outcome: "error",
    message: { role: "assistant", content: "failed" },
    messageEntryId: "failed-response",
  });
  first.beforeSettle({ outcome: "error" });
  await first.agentSettled(context, false);
  const pending = pi.entries.find(
    (entry: any) => entry.data?.phase === "report_pending",
  ) as any;
  assert.equal(pending.data.target, "project");
  assert.equal(chiefFailures, 0);

  // Simulate retirement: remove the live assignment.
  assignment = undefined;
  role = "manager";
  const restored = createRuntime();
  restored.restoreSession(pi.entries, LEAD_SESSION_ID);
  restored.finishIfIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chiefFailures, 0);
  assert.equal(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === pending.data.reportId,
    ),
    false,
    "a removed project assignment must not reroute an old report to Chief",
  );

  role = "manager";
  const legacyReportId = randomUUID();
  pi.entries.push({
    type: "custom",
    customType: "pi-herdsman-herd-run",
    data: {
      phase: "report_pending",
      sessionId: LEAD_SESSION_ID,
      startedAt: Date.now(),
      reportId: legacyReportId,
      message: "Legacy report without a proven destination",
      kind: "execution_failure",
      createdAt: Date.now(),
    },
  } as any);
  const legacyRestore = createRuntime();
  const projectPublicationsBeforeLegacyRestore = projectPublications;
  legacyRestore.restoreSession(pi.entries, LEAD_SESSION_ID);
  legacyRestore.finishIfIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chiefFailures, 0);
  assert.equal(
    projectPublications,
    projectPublicationsBeforeLegacyRestore,
    "legacy Manager report must not be published to a project",
  );
  assert.equal(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === legacyReportId,
    ),
    false,
    "legacy report without a persisted destination fails closed",
  );

  role = "lead";
  restored.agentStarted();
  restored.turnEnd({
    outcome: "error",
    message: { role: "assistant", content: "new failure" },
    messageEntryId: "new-failed-response",
  });
  restored.beforeSettle({ outcome: "error" });
  await restored.agentSettled(context, false);
  assert.equal(chiefFailures, 0, "Managed identity never falls back to Chief");
  const newPending = pi.entries.find(
    (entry: any) =>
      entry.data?.phase === "report_pending" &&
      entry.data?.reportId !== pending.data.reportId &&
      entry.data?.target === "project",
  ) as any;
  assert.equal(newPending.data.target, "project");
});

test("failed idle-report publication keeps one recoverable pending intent", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  const startedAt = 1_700_000_000_000;
  const reportId = randomUUID();
  pi.entries.push({
    type: "custom",
    customType: "pi-herdsman-herd-run",
    data: { phase: "started", sessionId: LEAD_SESSION_ID, startedAt, reportId },
  } as any);
  let publications = 0;
  let durableErrors = 0;
  const createRuntime = (publish: () => Promise<boolean>) =>
    createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => "lead",
      isVerifiedActiveLead: () => true,
      isManagedLead: () => false,
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => undefined,
      publishProjectMessage: async () => undefined,
      publishChiefFailure: async () => {
        publications++;
        return publish();
      },
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => durableErrors++,
    });

  const first = createRuntime(async () => false);
  first.restoreSession(pi.entries, LEAD_SESSION_ID);
  first.finishIfIdle(context);
  await t.waitFor(() => assert.equal(publications, 2));
  const pending = pi.entries.filter(
    (entry: any) =>
      entry.customType === "pi-herdsman-herd-run" &&
      entry.data?.phase === "report_pending" &&
      entry.data?.reportId === reportId,
  ) as any[];
  assert.equal(pending.length, 1, "a retry reuses the durable pending intent");
  assert.ok(Number.isFinite(pending[0].data.createdAt));
  const originalPayload = {
    message: pending[0].data.message,
    createdAt: pending[0].data.createdAt,
  };

  first.finishIfIdle(context);
  await t.waitFor(() => assert.ok(publications >= 3));
  const repeatedPending = pi.entries.filter(
    (entry: any) =>
      entry.customType === "pi-herdsman-herd-run" &&
      entry.data?.phase === "report_pending" &&
      entry.data?.reportId === reportId,
  ) as any[];
  assert.equal(repeatedPending.length, 1);
  assert.deepEqual(
    {
      message: repeatedPending[0].data.message,
      createdAt: repeatedPending[0].data.createdAt,
    },
    originalPayload,
    "repeated failed publication preserves report identity and payload",
  );

  const recovered = createRuntime(async () => true);
  recovered.restoreSession(pi.entries, LEAD_SESSION_ID);
  recovered.finishIfIdle(context);
  await t.waitFor(() =>
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.data?.phase === "report_sent" &&
          entry.data?.reportId === reportId,
      ),
    ),
  );
  assert.equal(durableErrors, 0, "recovery accepts and publishes the intent");
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === reportId,
    ).length,
    1,
  );
});

test("restored sent Lead failure report retains its herd-run linkage", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  let publications = 0;
  const createRuntime = () =>
    createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => "lead",
      isVerifiedActiveLead: () => true,
      isManagedLead: () => false,
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => undefined,
      publishProjectMessage: async () => undefined,
      publishChiefFailure: async () => {
        publications++;
        return true;
      },
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => {},
    });

  const herd = createRuntime();
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "error",
    message: { role: "assistant", content: "partial" },
    messageEntryId: "failed-response",
  });
  herd.beforeSettle({ outcome: "error" });
  await herd.agentSettled(context, false);
  const started = pi.entries.find(
    (entry: any) => entry.data?.phase === "started",
  ) as any;
  const sent = pi.entries.find(
    (entry: any) => entry.data?.phase === "report_sent",
  ) as any;
  assert.equal(sent.data.runReportId, started.data.reportId);

  for (let i = pi.entries.length - 1; i >= 0; i--) {
    if ((pi.entries[i] as any).data?.phase === "finished")
      pi.entries.splice(i, 1);
  }

  const recovered = createRuntime();
  recovered.restoreSession(pi.entries, LEAD_SESSION_ID);
  recovered.finishIfIdle(context);
  await t.waitFor(() =>
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-herd-run" &&
          entry.data?.phase === "finished",
      ),
    ),
  );
  assert.equal(
    publications,
    1,
    "recovery does not publish a generic duplicate",
  );
});

test("concurrent herd finalization publishes and finishes only once", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => {
      publications++;
      await blocked;
      return true;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });

  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "completed" },
    messageEntryId: "completed-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  const settling = herd.agentSettled(context, false);
  await Promise.resolve();
  const second = herd.maybeFinish(context);
  release();
  await Promise.all([settling, second]);

  assert.equal(publications, 1);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "finished",
    ).length,
    1,
  );
});

test("concurrent idle recovery publishes and finishes only once", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  const reportId = randomUUID();
  const pendingReportId = randomUUID();
  const startedAt = Date.now();
  pi.entries.push(
    ...([
      { phase: "started", sessionId: LEAD_SESSION_ID, startedAt, reportId },
      {
        phase: "report_pending",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId: pendingReportId,
        runReportId: reportId,
        message: "Recover this report",
        kind: "execution_failure",
        createdAt: startedAt,
        target: "project",
      },
    ].map((data) => ({
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data,
    })) as any[]),
  );
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const publicationEntered = new Promise<void>(
    (resolve) => (entered = resolve),
  );
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => {
      publications++;
      entered();
      await blocked;
      return true;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.restoreSession(pi.entries, LEAD_SESSION_ID);

  herd.finishIfIdle(context);
  herd.finishIfIdle(context);
  await publicationEntered;
  assert.equal(publications, 1);
  release();
  await t.waitFor(() => {
    assert.equal(
      pi.entries.filter(
        (entry: any) =>
          entry.data?.phase === "report_sent" &&
          entry.data?.reportId === pendingReportId &&
          entry.data?.runReportId === reportId,
      ).length,
      1,
    );
    assert.equal(
      pi.entries.filter((entry: any) => entry.data?.phase === "finished")
        .length,
      1,
    );
  });
  assert.equal(publications, 1);
});

test("Chief-directed failure stays pending across a new Manager assignment", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  const reportId = randomUUID();
  const startedAt = Date.now();
  let projectPublications = 0;
  let assignment: object | undefined;
  pi.entries.push(
    ...([
      {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId,
      },
      {
        phase: "report_pending",
        sessionId: LEAD_SESSION_ID,
        startedAt,
        reportId: randomUUID(),
        runReportId: reportId,
        message: "Recover this report",
        kind: "execution_failure",
        createdAt: startedAt,
        target: "chief",
      },
    ].map((data) => ({
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data,
    })) as any[]),
  );
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => assignment as any,
    publishProjectMessage: async () => {
      projectPublications++;
      return {} as any;
    },
    publishChiefFailure: async () => {
      publications++;
      return true;
    },
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.restoreSession(pi.entries, LEAD_SESSION_ID);
  const pending = pi.entries.find(
    (entry: any) => entry.data?.phase === "report_pending",
  ) as any;
  assignment = { project: "new exact Manager assignment" };
  herd.finishIfIdle(context);
  herd.finishIfIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(publications, 0);
  assert.equal(projectPublications, 0);
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "finished").length,
    0,
    "the failed report remains recoverable rather than finalizing the run",
  );
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "report_sent")
      .length,
    0,
    "authority change leaves the saved Chief report pending",
  );
  assignment = undefined;
  const recovered = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => assignment as any,
    publishProjectMessage: async () => {
      projectPublications++;
      return {} as any;
    },
    publishChiefFailure: async (_ctx, message, id) => {
      publications++;
      assert.equal(id, pending.data.reportId);
      assert.equal(message, pending.data.message);
      return true;
    },
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  recovered.restoreSession(pi.entries, LEAD_SESSION_ID);
  recovered.finishIfIdle(context);
  await t.waitFor(() => assert.equal(publications, 1));
  assert.equal(projectPublications, 0);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === pending.data.reportId,
    ).length,
    1,
    "the original report is acknowledged once after Chief authority is restored",
  );
});

test("failed successful-handoff publication keeps herd finalization retryable", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let published = false;
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => {
      publications++;
      return published;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "completed summary" },
    messageEntryId: "completed-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  await herd.agentSettled(context, false);

  const report = pi.entries.find(
    (entry: any) =>
      entry.customType === "pi-herdsman-herd-run" &&
      entry.data?.phase === "report_pending",
  ) as any;
  assert.ok(report, "failed publication leaves the report intent durable");
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "finished"),
    false,
    "failed required publication must not finish the herd",
  );
  assert.ok(herd.startedAt(), "failed publication keeps the herd active");

  published = true;
  await herd.maybeFinish(context);
  assert.equal(publications, 2, "a later finalization retries publication");
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "finished").length,
    1,
  );
  assert.equal(report.data.message, "Herd run settled.\n\ncompleted summary");
});

test("managed success waits for its exact assignment after persisting the report", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  const assignment = { project: "original assignment" };
  let authorityAvailable = false;
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => {
      assert.ok(
        pi.entries.some((entry: any) => entry.data?.phase === "report_pending"),
        "authority is checked only after the report intent is durable",
      );
      return authorityAvailable ? assignment : undefined;
    },
    publishProjectMessage: async (
      _ctx,
      currentAssignment,
      message,
      _files,
      _kind,
      reportId,
    ) => {
      publications++;
      assert.equal(currentAssignment, assignment);
      assert.equal(reportId, report.data.reportId);
      assert.equal(message, report.data.message);
      return true;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "completed summary" },
    messageEntryId: "completed-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  await herd.agentSettled(context, false);

  const report = pi.entries.find(
    (entry: any) =>
      entry.customType === "pi-herdsman-herd-run" &&
      entry.data?.phase === "report_pending",
  ) as any;
  assert.ok(report, "the project report intent is retained");
  assert.equal(publications, 0);
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "report_sent"),
    false,
  );
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "finished"),
    false,
  );

  authorityAvailable = true;
  await herd.maybeFinish(context);
  assert.equal(publications, 1);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === report.data.reportId,
    ).length,
    1,
  );
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "finished").length,
    1,
  );
});

test("successful unassigned Lead herd finishes without a project handoff", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  const chiefFailures: string[] = [];
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => false,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => undefined,
    publishProjectMessage: async () => {
      throw new Error("unassigned success has no project recipient");
    },
    publishChiefFailure: async (_ctx, message) => {
      chiefFailures.push(message);
      return true;
    },
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Integrated work" },
    messageEntryId: "completed-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  await herd.agentSettled(context, false);

  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "finished").length,
    1,
  );
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "report_pending"),
    false,
  );
  assert.deepEqual(chiefFailures, []);
});

test("managed Lead herd fails closed when its worktree scope is unavailable", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let durableErrors = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => {
      throw new Error("Cannot verify the current project assignment");
    },
    publishProjectMessage: async () => undefined,
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: (_pi, _ctx, category) => {
      assert.equal(category, "pi_herdsman_state_error");
      durableErrors++;
    },
  });
  herd.agentStarted();
  herd.begin(context);
  const started = pi.entries.find(
    (entry: any) => entry.data?.phase === "started",
  ) as any;
  pi.entries.push({
    type: "custom",
    customType: "pi-herdsman-herd-run",
    data: {
      phase: "report_pending",
      sessionId: LEAD_SESSION_ID,
      startedAt: started.data.startedAt,
      reportId: randomUUID(),
      runReportId: started.data.reportId,
      message: "Existing handoff",
      target: "project",
    },
  } as any);
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Completed" },
    messageEntryId: "completed-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  await herd.agentSettled(context, false);

  assert.ok(durableErrors > 0);
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "finished"),
    false,
  );
  assert.ok(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_pending" &&
        entry.data?.message === "Existing handoff",
    ),
  );
});

test("direct assigned Lead success records and replays a failed handoff", async () => {
  const { createLeadAgentEventRuntime, createLeadHerdRunRuntime } =
    await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  let publicationAttempts = 0;
  let durableErrors = 0;
  let settledResults = 0;
  const assignment = { project: "assigned" } as any;
  const herdRun = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => assignment,
    publishProjectMessage: async () => {
      publicationAttempts++;
      if (publicationAttempts === 1) throw new Error("publication failed");
      return {} as any;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: (_pi, _ctx, category) => {
      assert.equal(category, "pi_herdsman_state_error");
      durableErrors++;
    },
  });
  const events = createLeadAgentEventRuntime({
    isCurrentChief: () => false,
    setActiveTools: () => {},
    chiefTools: [],
    leadInboxRuntime: { holdStartPreflight: () => {}, agentSettled: () => {} },
    prepareSupervisionMessage: async () => undefined,
    sendMessage: () => {},
    chiefSystemPrompt: (_options, body) => body,
    isActiveManager: () => false,
    roleCharter: () => "",
    currentChiefAllowedTools: () => undefined,
    supervisoryProfileBody: () => "",
    isActiveLead: () => true,
    executionPrompt: () => undefined,
    prepareLeadSupervisorStateMessage: async () => undefined,
    definitionRoster: () => undefined,
    consumeChiefStartPreflight: () => {},
    herdRun,
    controller: {
      settleAsks: () => {},
      sessionSignal: () => new AbortController().signal,
      settleResults: async () => {
        settledResults++;
      },
    },
  });
  events.agentStart(context);
  herdRun.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Direct completed summary" },
    messageEntryId: "direct-completed-response",
  });
  herdRun.beforeSettle({ outcome: "completed" });
  await events.agentSettled(context, false);

  const pending = pi.entries.find(
    (entry: any) => entry.data?.phase === "report_pending",
  ) as any;
  assert.ok(pending);
  assert.equal(pending.data.message, "Direct completed summary");
  assert.equal(durableErrors, 1);
  assert.equal(settledResults, 1);
  assert.equal(publicationAttempts, 1);

  herdRun.finishIfIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(publicationAttempts, 2);
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "report_sent")
      .length,
    1,
  );
});

test("direct managed Lead preserves success before authority verification and replays after restart", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  let authorityLookups = 0;
  let publications = 0;
  const createRuntime = (restored: boolean) =>
    createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => "lead",
      isVerifiedActiveLead: () => true,
      isManagedLead: () => true,
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => {
        authorityLookups++;
        if (!restored) throw new Error("assignment temporarily unavailable");
        return { project: "assigned" } as any;
      },
      publishProjectMessage: async (_ctx, _assignment, message) => {
        publications++;
        assert.equal(message, "Original direct summary");
        return true as any;
      },
      publishChiefFailure: async () => false,
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => {},
    });
  const first = createRuntime(false);
  first.agentStarted();
  first.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Original direct summary" },
    messageEntryId: "direct-original-summary",
  });
  first.beforeSettle({ outcome: "completed" });
  await first.agentSettled(context, false);

  const intent = pi.entries.find(
    (entry: any) => entry.data?.phase === "report_pending",
  ) as any;
  assert.equal(intent?.data?.message, "Original direct summary");
  assert.equal(
    publications,
    0,
    "failed authority verification must not publish",
  );

  const restored = createRuntime(true);
  restored.restoreSession(pi.entries, LEAD_SESSION_ID);
  restored.finishIfIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(authorityLookups, 2);
  assert.equal(publications, 1);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === intent.data.reportId,
    ).length,
    1,
  );
});

test("only active Lead assignments begin Lead herd-run tracking and an existing run settles after a role switch", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  let role: "lead" | "manager" = "manager";
  let verifiedActiveLead = false;
  const herdRun = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => role,
    isVerifiedActiveLead: () => verifiedActiveLead,
    isManagedLead: () => false,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => undefined,
    publishProjectMessage: async () => false as any,
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });

  herdRun.begin(context);
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "started"),
    false,
    "supervisor-owned work must not start Lead tracking",
  );

  role = "lead";
  herdRun.begin(context);
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "started"),
    false,
    "a suspended or unverified Lead must not start tracking",
  );

  verifiedActiveLead = true;
  herdRun.agentStarted();
  herdRun.begin(context);
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "started").length,
    1,
    "active Lead work still starts tracking",
  );
  herdRun.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Lead run completed" },
    messageEntryId: "role-switch-completed-response",
  });
  herdRun.beforeSettle({ outcome: "completed" });

  role = "manager";
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "started").length,
    1,
    "a later role switch does not discard the already-started Lead run",
  );
  await herdRun.agentSettled(context, false);

  assert.equal(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_pending" &&
        entry.data?.kind === "execution_failure",
    ),
    false,
    "the completed response is preserved as a successful Lead outcome",
  );
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "finished").length,
    1,
    "the original Lead run still settles after switching to Manager",
  );
});

test("managed Lead herd preserves success before authority verification and replays after restart", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  let authorityLookups = 0;
  let publications = 0;
  const createRuntime = (restored: boolean) =>
    createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => "lead",
      isVerifiedActiveLead: () => true,
      isManagedLead: () => true,
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => {
        authorityLookups++;
        if (!restored) throw new Error("assignment temporarily unavailable");
        return { project: "assigned" } as any;
      },
      publishProjectMessage: async (_ctx, _assignment, message) => {
        publications++;
        assert.equal(message, "Herd run settled.\n\nOriginal herd summary");
        return true as any;
      },
      publishChiefFailure: async () => false,
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => {},
    });
  const first = createRuntime(false);
  first.agentStarted();
  first.begin(context);
  first.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Original herd summary" },
    messageEntryId: "herd-original-summary",
  });
  first.beforeSettle({ outcome: "completed" });
  await first.agentSettled(context, false);

  const intent = pi.entries.find(
    (entry: any) =>
      entry.customType === "pi-herdsman-herd-run" &&
      entry.data?.phase === "report_pending",
  ) as any;
  assert.equal(
    intent?.data?.message,
    "Herd run settled.\n\nOriginal herd summary",
  );
  assert.equal(
    publications,
    0,
    "failed authority verification must not publish",
  );

  const restored = createRuntime(true);
  restored.restoreSession(pi.entries, LEAD_SESSION_ID);
  restored.finishIfIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(authorityLookups, 2);
  assert.equal(publications, 1);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === intent.data.reportId,
    ).length,
    1,
  );
  assert.equal(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_pending" &&
        /outcome was not preserved/.test(entry.data.message),
    ),
    false,
  );
});

test("direct unassigned Lead success creates no report intent", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let projectWrites = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => false,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => undefined,
    publishProjectMessage: async () => {
      projectWrites++;
      return undefined;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "Direct response" },
    messageEntryId: "direct-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  await herd.agentSettled(context, false);
  assert.equal(projectWrites, 0);
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "report_pending"),
    false,
  );
});

test("newer unsent herd handoff blocks restoration after older report was sent", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  const herdId = randomUUID();
  const earlierId = randomUUID();
  const startedAt = 1_700_000_000_000;
  pi.entries.push(
    ...([
      { phase: "started", reportId: herdId },
      {
        phase: "report_pending",
        reportId: earlierId,
        runReportId: herdId,
        message: "Earlier failure",
        kind: "execution_failure",
        createdAt: startedAt,
        target: "chief",
      },
      { phase: "report_sent", reportId: earlierId, runReportId: herdId },
      {
        phase: "report_pending",
        reportId: herdId,
        message: "Herd run settled.\n\nIntegrated later work",
        createdAt: startedAt + 1,
        target: "project",
      },
    ].map((data) => ({
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: { ...data, sessionId: LEAD_SESSION_ID, startedAt },
    })) as any),
  );
  let publish = false;
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => {
      publications++;
      return publish;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.restoreSession(pi.entries, LEAD_SESSION_ID);
  herd.finishIfIdle(context);
  await t.waitFor(() => assert.ok(publications > 0));
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "finished"),
    false,
  );
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_pending" &&
        entry.data?.kind === "execution_failure",
    ).length,
    1,
    "restoration does not append a generic failure over the pending success",
  );

  publish = true;
  herd.finishIfIdle(context);
  await t.waitFor(() =>
    assert.equal(
      pi.entries.filter((entry: any) => entry.data?.phase === "finished")
        .length,
      1,
    ),
  );
  assert.equal(publications, 2);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_sent" && entry.data?.reportId === herdId,
    ).length,
    1,
  );
});

test("assigned completed Lead without summary publishes factual handoff", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  const reports: any[] = [];
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({ project: "assigned" }) as any,
    publishProjectMessage: async (_ctx, assignment, message, _files, kind) => {
      reports.push({ assignment, message, kind });
      return true;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "completed",
    message: { role: "assistant", content: "   " },
    messageEntryId: "completed-response",
  });
  herd.beforeSettle({ outcome: "completed" });
  await herd.agentSettled(context, false);

  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].assignment, { project: "assigned" });
  assert.match(
    reports[0].message,
    /without a verified Lead integration summary/,
  );
  assert.equal(reports[0].kind, "herd_run");
  assert.equal(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_pending" &&
        entry.data?.kind === "execution_failure",
    ),
    false,
  );
});

test("supervisor turns do not enter Lead herd-run tracking", async () => {
  const { createLeadAgentEventRuntime } = await import("./lead-runtime.ts");
  let herdEvents = 0;
  let settledResults = 0;
  const events = createLeadAgentEventRuntime({
    isCurrentChief: () => false,
    setActiveTools: () => {},
    chiefTools: [],
    leadInboxRuntime: { holdStartPreflight: () => {}, agentSettled: () => {} },
    prepareSupervisionMessage: async () => undefined,
    sendMessage: () => {},
    chiefSystemPrompt: (_options, body) => body,
    isActiveManager: () => true,
    roleCharter: () => "",
    currentChiefAllowedTools: () => undefined,
    supervisoryProfileBody: () => "",
    isActiveLead: () => false,
    executionPrompt: () => undefined,
    prepareLeadSupervisorStateMessage: async () => undefined,
    definitionRoster: () => undefined,
    consumeChiefStartPreflight: () => {},
    herdRun: {
      agentStarted: () => herdEvents++,
      agentSettled: async () => {
        herdEvents++;
      },
      turnEnd: () => {
        herdEvents++;
      },
      beforeSettle: () => {
        herdEvents++;
      },
      hasActiveTurn: () => false,
    },
    controller: {
      settleAsks: () => {},
      sessionSignal: () => new AbortController().signal,
      settleResults: async () => {
        settledResults++;
      },
    },
  });
  const context = fakeContext() as any;
  events.agentStart(context);
  await events.agentSettled(context, false);
  assert.equal(herdEvents, 0);
  assert.equal(settledResults, 1);
});

test("cancellation report failure is diagnosed before result reconciliation", async () => {
  const { createLeadAgentEventRuntime, createLeadHerdRunRuntime } =
    await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let errors = 0;
  const herdRun = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => {
      throw new Error("publication failed");
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: (_pi, _ctx, category) => {
      assert.equal(category, "pi_herdsman_state_error");
      errors++;
    },
  });
  const sessionSignal = new AbortController().signal;
  let settledResults = 0;
  const events = createLeadAgentEventRuntime({
    isCurrentChief: () => false,
    setActiveTools: () => {},
    chiefTools: [],
    leadInboxRuntime: { holdStartPreflight: () => {}, agentSettled: () => {} },
    prepareSupervisionMessage: async () => undefined,
    sendMessage: () => {},
    chiefSystemPrompt: (_options, body) => body,
    isActiveManager: () => false,
    roleCharter: () => "",
    currentChiefAllowedTools: () => undefined,
    supervisoryProfileBody: () => "",
    isActiveLead: () => true,
    executionPrompt: () => undefined,
    prepareLeadSupervisorStateMessage: async () => undefined,
    definitionRoster: () => undefined,
    consumeChiefStartPreflight: () => {},
    herdRun,
    controller: {
      settleAsks: () => {},
      sessionSignal: () => sessionSignal,
      settleResults: async () => {
        settledResults++;
      },
    },
  });
  events.agentStart(context);
  herdRun.begin(context);
  await assert.doesNotReject(events.agentSettled(context, true));
  assert.ok(errors >= 1);
  assert.equal(
    settledResults,
    1,
    "Agent results still reconcile after report failure",
  );
  assert.ok(
    pi.entries.some(
      (entry: any) =>
        entry.data?.phase === "report_pending" &&
        /cancelled before a completed response/.test(entry.data.message),
    ),
    "the durable cancellation intent survives the failed publication",
  );
});

test("failed active-Lead report publication blocks herd finish until retry", async () => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  let published = false;
  let publications = 0;
  const herd = createLeadHerdRunRuntime({
    pi: pi.pi as never,
    activeRole: () => "lead",
    isVerifiedActiveLead: () => true,
    isManagedLead: () => true,
    entryName: "pi-herdsman-herd-run",
    hasPendingStarts: () => false,
    listAgentStates: () => [],
    currentProjectAssignment: async () => ({}) as any,
    publishProjectMessage: async () => {
      publications++;
      return published;
    },
    publishChiefFailure: async () => false,
    requestStatusRefresh: () => {},
    queueLeadPresentation: () => {},
    appendDurableError: () => {},
  });
  herd.agentStarted();
  herd.begin(context);
  herd.turnEnd({
    outcome: "error",
    message: { role: "assistant", content: "partial result" },
    messageEntryId: "failed-response",
  });
  herd.beforeSettle({ outcome: "error" });
  await herd.agentSettled(context, false);

  const pending = pi.entries.find(
    (entry: any) =>
      entry.customType === "pi-herdsman-herd-run" &&
      entry.data?.phase === "report_pending",
  ) as any;
  assert.ok(pending?.data?.runReportId, "failure intent links to its herd");
  assert.equal(
    pi.entries.some((entry: any) => entry.data?.phase === "finished"),
    false,
    "failed report publication must not finish the herd",
  );
  assert.ok(herd.startedAt(), "failed publication keeps the herd active");

  published = true;
  await herd.maybeFinish(context);
  assert.equal(publications, 3, "settlement retries the failed initial write");
  assert.equal(
    pi.entries.filter((entry: any) => entry.data?.phase === "finished").length,
    1,
  );
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.data?.phase === "report_sent" &&
        entry.data?.reportId === pending.data.reportId,
    ).length,
    1,
  );
});

test("cancelled Lead sent marker retains herd link across restoration", async (t) => {
  const { createLeadHerdRunRuntime } = await import("./lead-runtime.ts");
  const pi = fakePi();
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.isIdle = () => true;
  let publications = 0;
  const createRuntime = () =>
    createLeadHerdRunRuntime({
      pi: pi.pi as never,
      activeRole: () => "lead",
      isVerifiedActiveLead: () => true,
      isManagedLead: () => true,
      entryName: "pi-herdsman-herd-run",
      hasPendingStarts: () => false,
      listAgentStates: () => [],
      currentProjectAssignment: async () => ({}) as any,
      publishProjectMessage: async () => {
        publications++;
        return true;
      },
      publishChiefFailure: async () => false,
      requestStatusRefresh: () => {},
      queueLeadPresentation: () => {},
      appendDurableError: () => {},
    });
  const herd = createRuntime();
  herd.agentStarted();
  herd.begin(context);
  await herd.agentSettled(context, true);

  const started = pi.entries.find(
    (entry: any) => entry.data?.phase === "started",
  ) as any;
  const sent = pi.entries.find(
    (entry: any) => entry.data?.phase === "report_sent",
  ) as any;
  assert.equal(sent.data.runReportId, started.data.reportId);

  for (let i = pi.entries.length - 1; i >= 0; i--) {
    if ((pi.entries[i] as any).data?.phase === "finished")
      pi.entries.splice(i, 1);
  }

  const recovered = createRuntime();
  recovered.restoreSession(pi.entries, LEAD_SESSION_ID);
  recovered.finishIfIdle(context);
  await t.waitFor(() =>
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.data?.phase === "finished" &&
          entry.data?.reportId === started.data.reportId,
      ),
    ),
  );
  assert.equal(
    publications,
    1,
    "restoration does not publish a generic duplicate",
  );
});

test("assigned project herd settlement publishes one nonterminal current-run handoff", async (t) => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `project-handoff-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `handoff-${randomUUID()}`;
  writeProjectAssignment(runtime, {
    version: 2,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
  });

  const label = `handoff-agent-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  const exec = async (command: string, args: string[]) => {
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
    return startup.exec(command, args);
  };
  const pi = fakePi({ exec });
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.hasUI = true;
  let widget: any;
  context.ui.setWidget = (_key, content) => {
    if (typeof content === "function")
      widget = content(
        { requestRender: () => {} } as any,
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as any,
      );
  };
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  const herdEntries = () =>
    pi.entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  const emit = async (name: string, event?: unknown) => {
    if (name === "agent_settled" && !(event as any)?.aborted) {
      const latest = [...branchEntries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "message" && entry.message?.role === "assistant",
        )?.message;
      for (const handler of pi.events.get("turn_end") ?? [])
        await handler(
          latest
            ? {
                outcome: (event as any)?.outcome ?? "completed",
                message: latest,
                messageEntryId: "test-response",
              }
            : {
                outcome: (event as any)?.outcome ?? "completed",
                message: { role: "assistant", content: [] },
                messageEntryId: "test-response",
              },
          context,
        );
      for (const handler of pi.events.get("agent_before_settle") ?? [])
        await handler(
          { outcome: (event as any)?.outcome ?? "completed" },
          context,
        );
    }
    for (const handler of pi.events.get(name) ?? [])
      await handler(
        name === "agent_settled" ? (event ?? { aborted: false }) : event,
        context,
      );
  };

  registerExtension!(pi.pi as never);
  try {
    seedSessionKind(context, "managed", "repo-key", branch);
    await emit("session_start");
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-session-kind" &&
          entry.data.sessionId === context.sessionManager.getSessionId(),
      ),
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.type === "session_info" && entry.name === `Lead · ${branch}`,
      ),
    );
    await emit("agent_start");
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: "Project assignment for branch\nImplement the assigned project",
    };
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    await emit("message_start", { message: assignmentMessage });
    const delegated = await registeredAgentTool(pi, "delegate").execute(
      "project-handoff",
      { definition: "agent", label, task: "implement the project" },
      undefined,
      undefined,
      context,
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    await t.waitFor(() =>
      assert.match(widget.render(120).join("\n"), /working/),
    );
    const startedAt = herdEntries().find(
      (entry) => entry.data?.phase === "started",
    )!.data.startedAt;
    branchEntries.push(
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: startedAt - 1,
          content: [{ type: "text", text: "OLD_ROUND_SUMMARY" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: startedAt + 1,
          content: [{ type: "text", text: "CURRENT_ROUND_SUMMARY" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: startedAt + 2,
          content: [{ type: "text", text: "CURRENT_ROUND_SUMMARY" }],
        },
      },
    );

    resetAgentMailbox(startup.mailbox);
    await emit("agent_settled");
    await t.waitFor(() =>
      assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 1),
    );
    const [message] = listProjectMessages(runtime, "repo-key", branch);
    assert.match(message.text, /^Herd run settled\./);
    assert.match(message.text, /CURRENT_ROUND_SUMMARY/);
    assert.doesNotMatch(message.text, /OLD_ROUND_SUMMARY/);
    assert.doesNotMatch(message.text, /list_agents/);
    assert.equal(message.resultBindings, undefined);
    assert.equal(
      listProjectAssignments(runtime, "repo-key").some(
        (assignment) => assignment.id === LEAD_SESSION_ID,
      ),
      true,
      "automatic handoff must not resolve the project assignment",
    );

    await emit("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 1);
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "finished").length,
      1,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("assigned Lead cannot retain project evidence through delegation", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `project-evidence-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `evidence-${randomUUID()}`;
  const snapshot = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "project-brief.txt",
    "initial brief: preserve backward compatibility",
  );
  const retainedFile = join(tmpdir(), `retained-${randomUUID()}.md`);
  realFs.writeFileSync(retainedFile, "reviewer finding to retain");
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "initial brief: preserve backward compatibility",
    requiredEvidence: [snapshot],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const label = `ev-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  seedSessionKind(context, "managed", "repo-key", branch);
  context.hasUI = true;
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${assignment.text}`,
    };
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.type === "session_info" && entry.name === `Lead · ${branch}`,
      ),
    );
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);

    const delegate = () =>
      registeredAgentTool(pi, "delegate").execute(
        `evidence-${randomUUID()}`,
        {
          definition: "agent",
          label,
          task: "implement plan",
          files: [retainedFile],
        },
        undefined,
        undefined,
        context,
      );
    for (const retain of [true, false]) {
      const rejected = await registeredAgentTool(pi, "delegate").execute(
        "evidence-rejected-retain",
        {
          definition: "agent",
          label,
          task: "must not launch",
          files: [retainedFile],
          retain,
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(rejected.details.ok, false);
      assert.match(
        JSON.stringify(rejected.details),
        /retain is available only to managed Agents/,
      );
      assert.equal(accepted, undefined);
      assert.deepEqual(
        listProjectAssignments(runtime, "repo-key").find(
          (item) => item.branch === branch,
        ),
        assignment,
      );
    }
    const result = await delegate();
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.match(accepted!.text, /reviewer finding to retain/);
    assert.match(
      accepted!.text,
      /evidence:project-brief#1 — project-brief\.txt/,
    );
    assert.doesNotMatch(
      accepted!.text,
      /initial brief: preserve backward compatibility/,
    );
    assert.deepEqual(
      accepted!.requiredEvidence?.map((entry) =>
        readRequiredEvidenceSnapshot(assignment.id, entry),
      ),
      ["initial brief: preserve backward compatibility"],
    );
    assert.doesNotMatch(
      accepted!.requiredEvidence?.map((entry) => entry.name).join("\n") ?? "",
      /implement plan/,
      "ordinary child task text is not retained as project evidence",
    );
    assert.equal(
      listProjectAssignments(runtime, "repo-key").find(
        (item) => item.branch === branch,
      )?.requiredEvidence?.length,
      1,
    );
    assert.equal(accepted!.evidenceAssignmentId, accepted!.requestId);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(snapshot.path, { force: true });
    realFs.rmSync(retainedFile, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("assigned Lead migrates legacy project evidence and preserves attachment order", async () => {
  const { READ_EVIDENCE_MAX_BYTES } =
    await import("./managed-agent-runtime.ts");
  setLeadEnvironment();
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_PANE_ID = "lead-pane";
  const socket = join(tmpdir(), `project-brief-reviewer-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const assignedSessionId = randomUUID();
  const branch = `brief-reviewer-${randomUUID()}`;
  const brief = "initial project brief: preserve backward compatibility";
  const snapshot = persistRequiredEvidenceSnapshot(
    assignedSessionId,
    "project-brief.txt",
    brief,
  );
  const olderBrief = persistRequiredEvidenceSnapshot(
    assignedSessionId,
    "older-notes.txt",
    "small historical note",
  );
  const historicalBrief = persistRequiredEvidenceSnapshot(
    assignedSessionId,
    "historical-plan.txt",
    "unselected historical plan",
  );
  const longEvidence = persistRequiredEvidenceSnapshot(
    assignedSessionId,
    "long-evidence.txt",
    "z".repeat(READ_EVIDENCE_MAX_BYTES + 1000),
  );
  const ordinaryPath = join(PI_AGENTS_DIR, `ordinary-${randomUUID()}.txt`);
  const ordinaryText = "ordinary current attachment";
  realFs.writeFileSync(ordinaryPath, ordinaryText, "utf8");
  const { ref: _snapshotRef, ...legacySnapshot } = snapshot;
  const { ref: _olderRef, ...legacyOlderBrief } = olderBrief;
  const { ref: _historicalRef, ...legacyHistoricalBrief } = historicalBrief;
  const { ref: _longRef, ...legacyLongEvidence } = longEvidence;
  const assignment = {
    version: 2 as const,
    id: assignedSessionId,
    repoKey: "repo-key",
    branch,
    text: brief,
    requiredEvidence: [
      legacySnapshot,
      legacyOlderBrief,
      legacyHistoricalBrief,
      legacyLongEvidence,
    ],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const label = `br-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const projectTopology = {
    id: AGENT_ID,
    result: {
      source: {
        repo_key: "repo-key",
        repo_name: "project",
        source_workspace_id: WORKSPACE,
      },
      worktrees: [{ open_workspace_id: WORKSPACE }],
    },
  };
  const startedAt = Date.now();
  const runReportId = randomUUID();
  const reportId = randomUUID();
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "started",
        sessionId: assignedSessionId,
        startedAt,
        reportId: runReportId,
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "report_pending",
        sessionId: assignedSessionId,
        startedAt,
        reportId,
        runReportId,
        message: "Existing assigned handoff",
        target: "project",
      },
    },
  ];
  const pi = fakePi({
    entries,
    allTools: [{ name: "read_evidence" }],
    exec: async (command: string, args: string[]) => {
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify(projectTopology),
          stderr: "",
          code: 0,
        };
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => assignedSessionId;
  seedSessionKind(context, "managed", "repo-key", branch);
  context.hasUI = true;
  context.isIdle = () => false;
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: assignedSessionId, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${brief}`,
    };
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);

    const globalMatches =
      globalProjectAssignmentSnapshot().get(assignedSessionId) ?? [];
    assert.equal(
      globalMatches.length,
      1,
      "global assignment session match count",
    );
    assert.equal(
      globalMatches[0]!.socketHash,
      createHash("sha256").update(process.env.HERDR_SOCKET_PATH!).digest("hex"),
      "assignment socket hash must match HERDR_SOCKET_PATH",
    );
    const worktreeScope = await worktreeGroupScope(
      pi.pi as never,
      context,
      WORKSPACE,
    );
    assert.equal(worktreeScope.repoKey, "repo-key", "Herdr source.repo_key");
    assert.equal(worktreeScope.repoName, "project", "Herdr source.repo_name");
    assert.equal(
      worktreeScope.primaryWorkspaceId,
      WORKSPACE,
      "Herdr source.source_workspace_id",
    );
    assert.ok(
      projectTopology.result.worktrees.some(
        (worktree) => worktree.open_workspace_id === WORKSPACE,
      ),
      "relevant workspace must be present in worktrees",
    );
    assert.ok(
      worktreeScope.workspaceIds.includes(WORKSPACE),
      "current workspace must be in the verified topology",
    );
    const scopeAssignments = findProjectAssignmentBySession(
      runtime,
      worktreeScope.repoKey,
      assignedSessionId,
    );
    assert.equal(
      scopeAssignments.length,
      1,
      "projectAssignmentForScope session match count",
    );
    assert.equal(
      scopeAssignments[0]!.branch,
      branch,
      "exact repo/branch assignment",
    );
    assert.equal(scopeAssignments[0]!.id, assignment.id);
    assert.deepEqual(
      scopeAssignments[0]!.requiredEvidence?.map((entry) => entry.ref),
      [snapshot.ref, olderBrief.ref, historicalBrief.ref, longEvidence.ref],
      "normal active-Lead access upgrades legacy evidence without resume_project",
    );
    assert.ok(
      pi.tools.some((tool) => tool.name === "read_evidence"),
      "assigned Lead reader offer",
    );
    assert.ok(
      pi.pi.getActiveTools().includes("read_evidence"),
      `assigned Lead reader readiness: ${pi.pi.getActiveTools().join(",")}`,
    );

    const result = await registeredAgentTool(pi, "delegate").execute(
      "project-brief-reviewer",
      {
        definition: "reviewer",
        label,
        task: "Review this project",
        files: [olderBrief.ref!, ordinaryPath, snapshot.ref!],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    const migratedAssignment = readProjectAssignment(
      runtime,
      "repo-key",
      branch,
    );
    assert.deepEqual(
      migratedAssignment?.requiredEvidence?.map((entry) => entry.id),
      [snapshot.id, olderBrief.id, historicalBrief.id, longEvidence.id],
      "active assignment migration preserves existing evidence identities",
    );
    assert.deepEqual(
      migratedAssignment?.requiredEvidence?.map((entry) => entry.ref),
      [snapshot.ref, olderBrief.ref, historicalBrief.ref, longEvidence.ref],
      "active Lead delegation persists stable refs without resume_project",
    );
    assert.ok(
      accepted!.text.indexOf("Task:\nReview this project") <
        accepted!.text.indexOf("<file "),
    );
    const orderedCurrent = ["small historical note", ordinaryText, brief].map(
      (content) => accepted!.text.indexOf(content),
    );
    assert.ok(orderedCurrent.every((index) => index >= 0));
    assert.deepEqual(
      orderedCurrent,
      [...orderedCurrent].sort((a, b) => a - b),
    );
    for (const content of ["small historical note", ordinaryText, brief])
      assert.equal(accepted!.text.split(content).length - 1, 1);
    assert.match(
      accepted!.text,
      /initial project brief: preserve backward compatibility/,
    );
    assert.match(
      accepted!.text,
      new RegExp(`${historicalBrief.ref} — historical-plan\\.txt`),
    );
    assert.doesNotMatch(accepted!.text, /unselected historical plan/);
    assert.ok(!accepted!.text.includes(LEAD_SESSION_ID));
    assert.ok(!accepted!.text.includes(snapshot.path));
    assert.match(accepted!.text, /Review this project/);
    assert.deepEqual(
      accepted!.requiredEvidence?.map((entry) =>
        readRequiredEvidenceSnapshot(assignment.id, entry),
      ),
      [
        brief,
        "small historical note",
        "unselected historical plan",
        "z".repeat(READ_EVIDENCE_MAX_BYTES + 1000),
      ],
    );
    const reader = pi.tools.find((tool) => tool.name === "read_evidence");
    assert.ok(reader, "assigned Lead must have the scoped evidence reader");
    const read = await reader.execute(
      "read-current-evidence",
      { ref: snapshot.ref },
      undefined,
      undefined,
      context,
    );
    assert.match(
      JSON.stringify(read),
      /initial project brief: preserve backward compatibility/,
    );
    const firstLongRead = await reader.execute(
      "read-long-evidence",
      { ref: longEvidence.ref },
      undefined,
      undefined,
      context,
    );
    const firstLongText = firstLongRead.content[0].text;
    assert.ok(Buffer.byteLength(firstLongText) <= READ_EVIDENCE_MAX_BYTES);
    const cursor = firstLongText.match(
      /\[More evidence: call read_evidence with offset=(\d+), byteOffset=(\d+)\]$/,
    );
    assert.ok(cursor, "root Lead reader exposes model-visible continuation");
    const secondLongRead = await reader.execute(
      "read-long-evidence-next",
      {
        ref: longEvidence.ref,
        offset: Number(cursor[1]),
        byteOffset: Number(cursor[2]),
      },
      undefined,
      undefined,
      context,
    );
    const firstChunk = firstLongText.replace(/\n\[More evidence:.*\]$/, "");
    const secondChunk = secondLongRead.content[0].text;
    assert.doesNotMatch(secondChunk, /\[More evidence:/);
    assert.equal(
      firstChunk + secondChunk,
      "z".repeat(READ_EVIDENCE_MAX_BYTES + 1000),
    );
    assert.ok(Buffer.byteLength(secondChunk) <= READ_EVIDENCE_MAX_BYTES);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(snapshot.path, { force: true });
    realFs.rmSync(olderBrief.path, { force: true });
    realFs.rmSync(historicalBrief.path, { force: true });
    realFs.rmSync(longEvidence.path, { force: true });
    realFs.rmSync(ordinaryPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("managed project delegation references supported evidence larger than the inline limit", async () => {
  setLeadEnvironment();
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  const previousConfig = realFs.existsSync(configPath)
    ? realFs.readFileSync(configPath, "utf8")
    : undefined;
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  realFs.writeFileSync(
    configPath,
    JSON.stringify({
      inlineAttachmentLimitBytes: 16 * 1024,
      mailboxPayloadLimitBytes: 50 * 1024,
    }),
  );

  const socket = join(
    tmpdir(),
    `project-evidence-reference-${randomUUID()}.sock`,
  );
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `evidence-reference-${randomUUID()}`;
  const content = "large supported evidence\n".repeat(1024);
  const largeExplicitPath = join(tmpdir(), `large-explicit-${randomUUID()}.md`);
  const smallExplicitPath = join(tmpdir(), `small-explicit-${randomUUID()}.md`);
  realFs.writeFileSync(smallExplicitPath, "explicit supporting patch");
  const largeExplicit = "large explicit attachment\n".repeat(65536);
  const nonRegularPath = join(tmpdir(), `non-regular-${randomUUID()}`);
  realFs.writeFileSync(largeExplicitPath, largeExplicit);
  realFs.mkdirSync(nonRegularPath);
  const fifoPath = join(tmpdir(), `non-regular-fifo-${randomUUID()}`);
  if (process.platform !== "win32") execFileSync("mkfifo", [fifoPath]);
  const snapshot = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "plan.md",
    content,
  );
  const collisionPath = join(tmpdir(), snapshot.ref);
  realFs.writeFileSync(collisionPath, "unrelated inline file");
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
    requiredEvidence: [snapshot],
    currentEvidenceIds: [snapshot.id],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const label = `er-${randomUUID().slice(0, 8)}`;
  const finalPaneId = "pane-" + "p".repeat(46_000);
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
    undefined,
    undefined,
    finalPaneId,
  );
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  seedSessionKind(context, "managed", "repo-key", branch);
  context.hasUI = true;
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${assignment.text}`,
    };
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.type === "session_info" && entry.name === `Lead · ${branch}`,
      ),
    );
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);

    const nonRegular = await registeredAgentTool(pi, "delegate").execute(
      "required-evidence-non-regular",
      {
        definition: "agent",
        label,
        task: "reject non-regular input",
        files: [nonRegularPath],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(nonRegular.details.ok, false);
    if (process.platform !== "win32") {
      const fifo = await registeredAgentTool(pi, "delegate").execute(
        "required-evidence-fifo",
        {
          definition: "agent",
          label,
          task: "reject FIFO input",
          files: [fifoPath],
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(fifo.details.ok, false);
    }

    const result = await registeredAgentTool(pi, "delegate").execute(
      "required-evidence-reference",
      {
        definition: "agent",
        label,
        task: "use the retained plan",
        files: [largeExplicitPath],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      result.details.ok,
      false,
      "unretained current attachments must not degrade to path-only delivery",
    );
    assert.match(JSON.stringify(result.details), /could not be fully embedded/);
    assert.equal(
      accepted,
      undefined,
      "failed current delivery must not be advertised as accepted",
    );
    const automatic = await registeredAgentTool(pi, "delegate").execute(
      "automatic-reference-fallback",
      {
        definition: "agent",
        label,
        task: "use the current retained plan",
        files: [smallExplicitPath, collisionPath],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(automatic.details.ok, true, JSON.stringify(automatic.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.equal(accepted!.paneId, finalPaneId);
    assert.match(accepted!.text, /Current evidence — reference-only batch/);
    assert.ok(accepted!.text.includes(`- ${snapshot.ref} — plan.md`));
    assert.ok(
      accepted!.text.includes(`<file name="${realpathSync(collisionPath)}"`),
    );
    assert.ok(accepted!.text.includes("unrelated inline file"));
    assert.match(accepted!.text, /explicit supporting patch/);
    assert.deepEqual(automatic.details.evidence, {
      currentInline: [],
      explicitInline: [basename(smallExplicitPath), snapshot.ref],
      referenced: [snapshot.ref],
    });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(snapshot.path, { force: true });
    realFs.rmSync(collisionPath, { force: true });
    realFs.rmSync(largeExplicitPath, { force: true });
    realFs.rmSync(smallExplicitPath, { force: true });
    realFs.rmSync(nonRegularPath, { recursive: true, force: true });
    if (process.platform !== "win32") realFs.rmSync(fifoPath, { force: true });
    if (previousConfig === undefined)
      realFs.rmSync(configPath, { force: true });
    else realFs.writeFileSync(configPath, previousConfig);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("managed project delegation keeps small changed content and deduplicates matching evidence", async () => {
  setLeadEnvironment();
  const socket = join(
    tmpdir(),
    `project-evidence-duplicate-${randomUUID()}.sock`,
  );
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `evidence-duplicate-${randomUUID()}`;
  const snapshot = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "plan.md",
    "duplicate plan body",
  );
  const originalRelativePath = `retained-plan-${LEAD_SESSION_ID}.md`;
  const originalPath = join("/tmp", originalRelativePath);
  const matchingRelativePath = `matching-plan-${LEAD_SESSION_ID}.md`;
  const matchingPath = join("/tmp", matchingRelativePath);
  realFs.writeFileSync(originalPath, "newer plan body");
  realFs.writeFileSync(matchingPath, "duplicate plan body");
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
    requiredEvidence: [snapshot],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const label = `ed-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  seedSessionKind(context, "managed", "repo-key", branch);
  context.hasUI = true;
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${assignment.text}`,
    };
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.type === "session_info" && entry.name === `Lead · ${branch}`,
      ),
    );
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);

    const result = await registeredAgentTool(pi, "delegate").execute(
      "required-evidence-duplicate",
      {
        definition: "agent",
        label,
        task: "implement plan",
        files: [originalRelativePath, matchingRelativePath],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.match(accepted!.text, /newer plan body/);
    assert.match(accepted!.text, /duplicate plan body/);
    assert.match(
      accepted!.text,
      /<file name="evidence:plan#\d+" label="plan\.md"/,
    );
    assert.doesNotMatch(accepted!.text, /evidence:plan#\d+ — plan\.md/);
    assert.equal(accepted!.text.match(/duplicate plan body/g)?.length, 1);
    assert.deepEqual(accepted!.requiredEvidence, [snapshot]);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(snapshot.path, { force: true });
    realFs.rmSync(originalPath, { force: true });
    realFs.rmSync(matchingPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("managed project delegation keeps changed original-path content alongside retained evidence", async () => {
  setLeadEnvironment();
  const socket = join(
    tmpdir(),
    `project-evidence-changed-${randomUUID()}.sock`,
  );
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `evidence-changed-${randomUUID()}`;
  const inheritedContent = `Inherited evidence body ${"i".repeat(75000)}`;
  const currentContent = `Current review evidence ${"c".repeat(75000)}`;
  const originalRelativePath = `retained-plan-${LEAD_SESSION_ID}.md`;
  const originalPath = join("/tmp", originalRelativePath);
  const snapshot = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    originalRelativePath,
    inheritedContent,
  );
  realFs.writeFileSync(originalPath, currentContent);
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
    requiredEvidence: [snapshot],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const label = `ec-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  seedSessionKind(context, "managed", "repo-key", branch);
  context.hasUI = true;
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${assignment.text}`,
    };
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);

    const result = await registeredAgentTool(pi, "delegate").execute(
      "required-evidence-changed-original",
      {
        definition: "agent",
        label,
        task: "implement newer plan",
        files: [originalRelativePath],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.ok(
      accepted!.text.includes(
        `<file name="${realpathSync(originalPath)}" bytes="${Buffer.byteLength(currentContent)}">\n${currentContent}\n</file>`,
      ),
      "current explicit evidence must be embedded in full",
    );
    assert.ok(
      accepted!.text.includes(`${snapshot.ref} — ${originalRelativePath}`),
      "inherited required evidence remains available by semantic reference",
    );
    assert.deepEqual(accepted!.requiredEvidence, [snapshot]);
    assert.equal(
      readRequiredEvidenceSnapshot(assignment.id, snapshot),
      inheritedContent,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(snapshot.path, { force: true });
    realFs.rmSync(originalPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("managed project delegation preserves inherited semantic result identity over an explicit path", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `project-result-alias-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `result-alias-${randomUUID()}`;
  const canonicalRef = resultRef(randomUUID());
  const artifactPath = resultPath(canonicalRef.slice("result:".length));
  const semanticRef = "result:reviewer#1";
  const inherited = {
    id: randomUUID(),
    name: semanticRef,
    result: { ref: semanticRef, canonicalRef },
  } as const;
  realFs.mkdirSync(resolve(artifactPath, ".."), { recursive: true });
  realFs.writeFileSync(artifactPath, "persisted review evidence");
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
    requiredEvidence: [inherited],
    currentEvidenceIds: [inherited.id],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const label = `er-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  context.hasUI = true;
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${assignment.text}`,
    };
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);

    const result = await registeredAgentTool(pi, "delegate").execute(
      "required-result-alias",
      {
        definition: "agent",
        label,
        task: "Review this result",
        files: [artifactPath],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.match(accepted!.text, /<file name="result:reviewer#1"/);
    assert.match(accepted!.text, /persisted review evidence/);
    assert.deepEqual(accepted!.requiredEvidence, [inherited]);
    assert.deepEqual(accepted!.resultBindings, [
      { ref: semanticRef, canonicalRef },
    ]);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(artifactPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("managed project delegation rejects authority changes during startup without publishing stale evidence", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `project-evidence-stale-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `evidence-stale-${randomUUID()}`;
  const snapshot = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "plan.md",
    "stale plan body",
  );
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
    requiredEvidence: [snapshot],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  let published: RequestRecord | undefined;
  const replacementId = randomUUID();
  const label = `es-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (_text, request) => {
      published = request;
    },
    false,
    () =>
      writeProjectAssignment(runtime, {
        ...assignment,
        id: replacementId,
        requiredEvidence: [],
      }),
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  seedSessionKind(context, "managed", "repo-key", branch);
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: `Project assignment for branch\n${assignment.text}`,
    };
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);

    const result = await registeredAgentTool(pi, "delegate").execute(
      "required-evidence-stale-authority",
      { definition: "agent", label, task: "use current plan" },
      undefined,
      undefined,
      context,
    );
    assert.notEqual(result.details.ok, true);
    assert.equal(
      accepted,
      undefined,
      "stale assignment must not be published to the mailbox",
    );
    assert.equal(
      published,
      undefined,
      "no stale request may reach mailbox delivery",
    );
    assert.equal(
      listProjectAssignments(runtime, "repo-key").find(
        (item) => item.branch === branch,
      )?.id,
      replacementId,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(snapshot.path, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("unassigned Lead delegation does not receive project evidence implicitly", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `ordinary-lead-evidence-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const foreignEvidence = persistRequiredEvidenceSnapshot(
    randomUUID(),
    "other-project.md",
    "unrelated project evidence",
  );
  let accepted: RequestRecord | undefined;
  const label = `ou-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
    },
  );
  const pi = fakePi({ exec: startup.exec });
  const context = fakeContext(pi.entries);
  seedSessionKind(context, "ordinary");
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const retain of [true, false]) {
      const rejected = await registeredAgentTool(pi, "delegate").execute(
        "unassigned-lead-retain",
        {
          definition: "agent",
          label,
          task: "must not launch",
          files: [foreignEvidence.path],
          retain,
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(rejected.details.ok, false);
      assert.match(
        JSON.stringify(rejected.details),
        /retain is available only to managed Agents/,
      );
      assert.equal(accepted, undefined);
    }
    const result = await registeredAgentTool(pi, "delegate").execute(
      "unassigned-lead-delegation",
      { definition: "agent", label, task: "unrelated work" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.doesNotMatch(accepted!.text, /unrelated project evidence/);
    assert.equal(accepted!.requiredEvidence, undefined);
    assert.equal(accepted!.projectAssignmentId, undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(foreignEvidence.path, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("each direct managed Lead turn returns its response", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `project-zero-agent-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `zero-agent-${randomUUID()}`;
  writeProjectAssignment(runtime, {
    version: 2,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
  });
  const pi = fakePi({
    exec: async (command: string, args: string[]) => {
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
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(pi.entries);
  const branchEntries: any[] = (
    context.sessionManager.getBranch as () => any[]
  )();
  const emit = async (name: string, event?: unknown) => {
    if (name === "agent_settled" && !(event as any)?.aborted) {
      const latest = [...branchEntries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "message" && entry.message?.role === "assistant",
        )?.message;
      for (const handler of pi.events.get("turn_end") ?? [])
        await handler(
          latest
            ? {
                outcome: (event as any)?.outcome ?? "completed",
                message: latest,
                messageEntryId: "test-response",
              }
            : {
                outcome: (event as any)?.outcome ?? "completed",
                message: { role: "assistant", content: [] },
                messageEntryId: "test-response",
              },
          context,
        );
      for (const handler of pi.events.get("agent_before_settle") ?? [])
        await handler(
          { outcome: (event as any)?.outcome ?? "completed" },
          context,
        );
    }
    for (const handler of pi.events.get(name) ?? [])
      await handler(
        name === "agent_settled" ? (event ?? { aborted: false }) : event,
        context,
      );
  };
  registerExtension!(pi.pi as never);
  try {
    seedSessionKind(context, "managed", "repo-key", branch);
    await emit("session_start");
    const assignmentMessage = {
      customType: "pi-herdsman-project_assignment",
      details: { id: LEAD_SESSION_ID, branch },
      timestamp: Date.now(),
      content: "Project assignment for branch\nImplement the assigned project",
    };
    branchEntries.push({
      type: "custom_message",
      customType: assignmentMessage.customType,
      message: assignmentMessage,
    });
    await emit("message_start", { message: assignmentMessage });
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.type === "session_info" && entry.name === `Lead · ${branch}`,
      ),
    );
    await emit("agent_start");
    branchEntries.push({
      type: "message",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "The assigned work is complete." }],
      },
    });
    await emit("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [response] = listProjectMessages(runtime, "repo-key", branch);
    assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 1);
    assert.equal(response.text, "The assigned work is complete.");

    const acknowledgement = {
      customType: "pi-herdsman-manager_message",
      details: { id: randomUUID() },
      timestamp: Date.now(),
      content: "Acknowledged; thank you.",
    };
    branchEntries.push({
      type: "custom_message",
      customType: acknowledgement.customType,
      message: acknowledgement,
    });
    await emit("message_start", { message: acknowledgement });
    await emit("agent_start");
    branchEntries.push({
      type: "message",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "You're welcome." }],
      },
    });
    await emit("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      listProjectMessages(runtime, "repo-key", branch).length,
      2,
      "a later direct turn produces another handoff",
    );
    assert.equal(
      listProjectMessages(runtime, "repo-key", branch)[1].text,
      "You're welcome.",
    );

    await emit("agent_start");
    branchEntries.push({
      type: "message",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "partial cancelled response" }],
      },
    });
    await emit("agent_settled", { aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 3);
    assert.equal(
      listProjectMessages(runtime, "repo-key", branch)[2].text,
      "Lead execution was cancelled before a completed response.",
    );
    assert.equal(
      listProjectAssignments(runtime, "repo-key").some(
        (assignment) => assignment.id === LEAD_SESSION_ID,
      ),
      true,
    );

    await emit("agent_start");
    branchEntries.push({
      type: "message",
      message: { role: "assistant", content: [] },
    });
    await emit("agent_settled", { aborted: false, outcome: "error" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 4);
    assert.match(
      listProjectMessages(runtime, "repo-key", branch)[3].text,
      /^Lead model execution failed before completion\./,
    );
    assert.equal(
      listProjectAssignments(runtime, "repo-key").some(
        (assignment) => assignment.id === LEAD_SESSION_ID,
      ),
      true,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    removeProjectAssignment(runtime, "repo-key", branch);
    rmSync(
      projectAssignmentPath(runtime, "repo-key", branch).replace(
        /\.json$/,
        ".messages",
      ),
      { recursive: true, force: true },
    );
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("legacy project evidence gets a durable ref before resume and keeps it across reloads", () => {
  setLeadEnvironment();
  const socket = join(
    tmpdir(),
    `project-evidence-migration-${randomUUID()}.sock`,
  );
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `evidence-${randomUUID()}`;
  const snapshot = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "accepted-plan.md",
    "keep the accepted plan",
  );
  const { ref: _ref, ...legacySnapshot } = snapshot;
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "assigned task",
    requiredEvidence: [legacySnapshot],
  };
  try {
    writeProjectAssignment(runtime, assignment);
    const path = projectAssignmentPath(runtime, "repo-key", branch);
    // Simulate a durable pre-ref assignment created by an earlier version.
    realFs.writeFileSync(path, `${JSON.stringify(assignment)}\n`);
    const upgraded = migrateProjectAssignmentEvidence(
      runtime,
      "repo-key",
      branch,
    )!;
    const ref = upgraded.requiredEvidence![0]!.ref;
    assert.match(ref!, /^evidence:accepted-plan#[1-9][0-9]*$/);
    assert.equal(upgraded.requiredEvidence![0]!.id, snapshot.id);
    assert.equal(
      upgraded.requiredEvidence![0]!.sourceAssignmentId,
      LEAD_SESSION_ID,
    );
    assert.equal(upgraded.requiredEvidence![0]!.path, snapshot.path);
    assert.equal(upgraded.requiredEvidence![0]!.sha256, snapshot.sha256);
    assert.deepEqual(
      readProjectAssignment(runtime, "repo-key", branch),
      upgraded,
    );
    assert.deepEqual(
      migrateProjectAssignmentEvidence(runtime, "repo-key", branch),
      upgraded,
    );
    assert.deepEqual(
      readProjectAssignment(runtime, "repo-key", branch),
      upgraded,
    );
  } finally {
    removeProjectAssignment(runtime, "repo-key", branch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("assigned project handoff remains pending when assignment resolution is locked", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const socket = join(tmpdir(), `project-handoff-race-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `handoff-race-${randomUUID()}`;
  writeProjectAssignment(runtime, {
    version: 2,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Implement the assigned project",
  });
  const label = `handoff-race-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  const pi = fakePi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-session-kind",
        data: {
          version: 1,
          sessionId: LEAD_SESSION_ID,
          kind: "managed",
          repoKey: "repo-key",
          branch,
        },
      },
    ],
    exec: async (command: string, args: string[]) => {
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
      return startup.exec(command, args);
    },
  });
  const context = fakeContext(pi.entries);
  context.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  context.sessionManager.getEntries = () => pi.entries;
  seedLeadRole(context, false);
  const assignmentMessage = {
    customType: "pi-herdsman-project_assignment",
    details: { id: LEAD_SESSION_ID, branch },
    timestamp: Date.now(),
    content: `Project assignment for branch\nImplement the assigned project`,
  };
  context.hasUI = true;
  let widget: any;
  context.ui.setWidget = (_key, content) => {
    if (typeof content === "function")
      widget = content(
        { requestRender: () => {} } as any,
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as any,
      );
  };
  const emit = async (name: string) => {
    if (name === "agent_settled") {
      for (const handler of pi.events.get("turn_end") ?? [])
        await handler(
          {
            outcome: "completed",
            message: { role: "assistant", content: [] },
            messageEntryId: "test-response",
          },
          context,
        );
      for (const handler of pi.events.get("agent_before_settle") ?? [])
        await handler({ outcome: "completed" }, context);
    }
    for (const handler of pi.events.get(name) ?? [])
      await handler(
        name === "agent_settled" ? { aborted: false } : undefined,
        context,
      );
  };
  registerExtension!(pi.pi as never);
  try {
    await emit("session_start");
    for (const handler of pi.events.get("message_start") ?? [])
      await handler({ message: assignmentMessage }, context);
    await assertManagedLeadRole(pi, context);
    await emit("agent_start");
    const delegated = await registeredAgentTool(pi, "delegate").execute(
      "project-handoff-race",
      { definition: "agent", label, task: "resolve project assignment" },
      undefined,
      undefined,
      context,
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    await t.waitFor(() =>
      assert.match(widget.render(120).join("\n"), /working/),
    );
    resetAgentMailbox(startup.mailbox);

    const releaseResolutionLock = claimProcessLock(
      `${projectAssignmentPath(runtime, "repo-key", branch)}.lock`,
      { name: "test project assignment resolution" },
    );
    try {
      await emit("agent_settled");
      assert.equal(
        pi.entries.filter(
          (entry: any) =>
            entry.customType === "pi-herdsman-herd-run" &&
            entry.data?.phase === "finished",
        ).length,
        0,
        "required assigned handoff failure keeps the herd pending",
      );
      assert.ok(
        pi.entries.some(
          (entry: any) =>
            entry.customType === "pi-herdsman-herd-run" &&
            entry.data?.phase === "report_pending",
        ),
        "the project handoff remains recoverable",
      );
      assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 0);
      // Contention is fail-fast: settling cannot leave a publication retry
      // waiting to recreate messages after assignment resolution.
      removeProjectAssignment(runtime, "repo-key", branch);
      rmSync(
        projectAssignmentPath(runtime, "repo-key", branch).replace(
          /\.json$/,
          ".messages",
        ),
        { recursive: true, force: true },
      );
      releaseResolutionLock();
    } finally {
      releaseResolutionLock();
    }
    assert.equal(listProjectAssignments(runtime, "repo-key").length, 0);
    assert.equal(listProjectMessages(runtime, "repo-key", branch).length, 0);
    assert.equal(
      realFs.existsSync(
        projectAssignmentPath(runtime, "repo-key", branch).replace(
          /\.json$/,
          ".messages",
        ),
      ),
      false,
      "publication must not recreate a message directory after resolution",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    rmSync(
      projectAssignmentPath(runtime, "repo-key", branch).replace(
        /\.json$/,
        ".messages",
      ),
      { recursive: true, force: true },
    );
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("replacement Manager wakes once for exact-assignment failure backlog only", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-failure-backlog-${randomUUID()}.sock`,
  );
  const runtime = supervisionRuntime();
  const branch = `manager-failure-${randomUUID()}`;
  const leadId = randomUUID();
  writeProjectAssignment(runtime, {
    version: 2,
    id: leadId,
    repoKey: "repo-key",
    branch,
    text: "current assignment",
  });
  const oldTimestamp = Date.now() - 10_000;
  const failure = {
    version: 2 as const,
    id: randomUUID(),
    repoKey: "repo-key",
    branch,
    fromSessionId: leadId,
    text: "Lead execution failed; inspect before resuming.",
    kind: "execution_failure" as const,
    createdAt: oldTimestamp,
  };
  const corrupt = {
    ...failure,
    id: randomUUID(),
    text: "x".repeat(29_764),
    createdAt: oldTimestamp - 1,
  };
  writeProjectMessage(corrupt, runtime);
  writeFileSync(
    `${projectAssignmentPath(runtime, "repo-key", branch).replace(/\.json$/, ".messages")}/${corrupt.id}.json.body`,
    "corrupt overflow payload",
  );
  writeProjectMessage(failure, runtime);

  const managerSessionFile = join(
    tmpdir(),
    `pi-herdsman-manager-${randomUUID()}.jsonl`,
  );
  const managerAgent: any = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: managerSessionFile,
    },
    pane_id: "root-pane",
    tab_id: "root-tab",
    workspace_id: WORKSPACE,
  };
  const exec = async (_command: string, args: string[]) => {
    let result: unknown = {};
    if (args[0] === "worktree" && args[1] === "list")
      result = {
        source: {
          repo_key: "repo-key",
          repo_name: "project",
          source_workspace_id: WORKSPACE,
        },
        worktrees: [],
      };
    else if (isAgentList(args)) result = { agents: [managerAgent] };
    else if (args[0] === "agent" && args[1] === "get")
      result = { agent: managerAgent };
    else if (isApiSnapshot(args))
      result = { snapshot: { agents: [managerAgent], panes: [] } };
    return {
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    };
  };
  const pi = fakePi({ exec, persistMessages: true });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext(pi.entries) as any;
  seedSessionKind(ctx, "ordinary");
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getSessionFile: () => managerSessionFile,
  };
  try {
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const manager = readManagerDescriptor(runtime, WORKSPACE)!;
    assert.ok(manager.createdAt > failure.createdAt);
    assert.ok(realFs.existsSync(managerDescriptorPath(runtime, WORKSPACE)));

    const deliveries = (id: string) =>
      pi.sentMessageCalls.filter(
        ({ message }: any) => message?.details?.id === id,
      );
    await t.waitFor(() => assert.equal(deliveries(failure.id).length, 1));
    assert.equal(
      deliveries(corrupt.id).length,
      0,
      "a corrupt overflow candidate is not delivered",
    );
    assert.ok(
      listProjectMessageHeaders(runtime, "repo-key", branch).some(
        (message) => message.id === corrupt.id,
      ),
      "the corrupt candidate remains pending while the valid message delivers",
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_state_error" &&
          String(entry.data?.error ?? "").includes(corrupt.id),
      ),
      "the corrupt candidate is reported as a durable state error",
    );
    assert.equal(
      (deliveries(failure.id)[0].options as any).triggerTurn,
      true,
      "an actionable failure predating this Manager wakes it",
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(
      deliveries(failure.id).length,
      1,
      "receipt prevents a second wake",
    );

    const progress = {
      ...failure,
      id: randomUUID(),
      text: "ordinary historical progress",
      kind: undefined,
    };
    writeProjectMessage(progress, runtime);
    await t.waitFor(() => assert.equal(deliveries(progress.id).length, 1));
    assert.equal(
      (deliveries(progress.id)[0].options as any).triggerTurn,
      false,
      "ordinary historical progress does not wake the replacement Manager",
    );

    const activeFailure = {
      ...failure,
      id: randomUUID(),
      text: "failure arrived during active Manager work",
    };
    writeProjectMessage(activeFailure, runtime);
    assert.equal(
      ctx.sessionManager.getSessionId(),
      manager.piSessionId,
      "the active transcript is the exact authorized Manager session",
    );
    ctx.isIdle = () => false;
    const customStartup = {
      type: "before_agent_start",
      messageType: "custom",
      message: {
        role: "custom",
        customType: "pi-herdsman-project_message",
        content: "Project coordination message",
        display: true,
        timestamp: Date.now(),
      },
      systemPrompt: "base",
      systemPromptOptions: {
        cwd: ctx.cwd,
        selectedTools: [],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {},
        contextFiles: [],
        skills: [],
      } satisfies NormalizedBuildSystemPromptOptions,
    } satisfies BeforeAgentStartEvent;
    await pi.events.get("before_agent_start")![0](customStartup, ctx);
    assert.equal(deliveries(activeFailure.id).length, 0);
    assert.deepEqual(
      listProjectMessageHeaders(runtime, "repo-key", branch).map(
        ({ id }) => id,
      ),
      [corrupt.id, activeFailure.id],
      "busy custom startup preserves the authorized durable message",
    );
    assert.ok(
      customStartup.systemPromptOptions.sections.pi_herdsman_role,
      "custom startup applies the Manager role projection",
    );

    ctx.isIdle = () => true;
    await pi.events.get("agent_settled")![0]({ aborted: false }, ctx);
    await t.waitFor(() => assert.equal(deliveries(activeFailure.id).length, 1));
    assert.equal(
      (deliveries(activeFailure.id)[0].options as any).triggerTurn,
      true,
    );
    const [activeDelivery] = deliveries(activeFailure.id);
    assert.equal(
      (activeDelivery.message as any).details.fromSessionId,
      leadId,
      "receipt identifies the authorized assigned Lead",
    );
    assert.equal(
      pi.entries.filter(
        (entry: any) =>
          entry.customType === "pi-herdsman-project_message" &&
          entry.details?.id === activeFailure.id &&
          entry.details?.fromSessionId === leadId,
      ).length,
      1,
      "the exact owner transcript contains one delivery receipt",
    );
    assert.equal(
      listProjectMessageHeaders(runtime, "repo-key", branch).some(
        ({ id }) => id === activeFailure.id,
      ),
      false,
      "receipt-backed delivery consumes the durable message",
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(deliveries(activeFailure.id).length, 1);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    removeProjectAssignment(runtime, "repo-key", branch);
    rmSync(
      projectAssignmentPath(runtime, "repo-key", branch).replace(
        /\.json$/,
        ".messages",
      ),
      { recursive: true, force: true },
    );
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("recovery cleanup keeps an idle restored herd open when failure reporting is unavailable", async () => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `recovered-completed-${randomUUID()}.sock`,
  );
  const startedAt = 1_700_000_000_000;
  const requestId = randomUUID();
  const label = `recovered-completed-${randomUUID().slice(0, 8)}`;
  const identity = {
    paneId: "startup-pane",
    tabId: "startup-tab",
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const state = {
    ...managedState(label, requestId, identity),
    activeRequestId: undefined,
    completedRequestId: requestId,
  };
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  let processInfoCount = 0;
  const execWithSettlement = async (
    command: string,
    args: string[],
    options?: any,
  ) => {
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "process-info"
    ) {
      processInfoCount++;
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            process_info: {
              pane_id: "startup-pane",
              shell_pid: 123,
              foreground_process_group_id: 123,
              foreground_processes:
                processInfoCount === 1
                  ? [
                      { pid: 123, argv0: "/bin/zsh" },
                      { pid: 999, argv0: "/usr/local/bin/pi" },
                    ]
                  : [{ pid: 123, argv0: "/bin/zsh" }],
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    return startup.exec(command, args, options);
  };
  resetAgentMailbox(startup.mailbox);
  writeAgentState(startup.mailbox, state);
  writeResult(startup.mailbox, {
    version: 5,
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "already delivered",
    completedAt: startedAt + 1,
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: { phase: "started", sessionId: LEAD_SESSION_ID, startedAt },
    },
    {
      type: "custom",
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(state, requestId),
    },
  ];
  const pi = fakePi({ entries, exec: execWithSettlement });
  const context = fakeContext(entries);
  const herdEntries = () =>
    entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const finished = herdEntries().filter(
      (entry) => entry.data?.phase === "finished",
    );
    assert.equal(finished.length, 0);
    assert.ok(
      herdEntries().some((entry) => entry.data?.phase === "report_pending"),
      "unreported restored failure remains recoverable",
    );
    assert.equal(readAgentState(startup.mailbox), undefined);
    assert.equal(readResult(startup.mailbox, requestId), undefined);
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ).length,
      0,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("Lead delegation holds the shared lifecycle lock through gated startup", async (t) => {
  const fixture = createStagedAssignmentFixture("agent");
  seedLeadRole(fixture.context);
  let starting: Promise<any> | undefined;
  try {
    await fixture.sessionStart;
    fixture.context.ui.notify = () => {};
    await t.waitFor(() => assert.equal(fixture.initialStatusStarted, true));
    starting = registeredAgentTool(fixture.pi, "delegate").execute(
      "id",
      { definition: "agent", task: "hold stop while startup is unresolved" },
      undefined,
      undefined,
      fixture.context,
    );
    await t.waitFor(() =>
      assert.ok(
        fixture.pi.calls.some(
          (args) => args[0] === "agent" && args[1] === "start",
        ),
      ),
    );
    let busy: unknown;
    try {
      const release = claimProcessLock(
        delegationLockPathForTest(WORKSPACE, LEAD_SESSION_ID),
        { name: "test delegation lifecycle" },
      );
      release();
    } catch (error) {
      busy = error;
    }
    assert.match(String(busy), /delegation lifecycle is in progress/i);
    fixture.releaseInitialStatus();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readAgentState(fixture.mailbox), undefined);
    fixture.widgetValue.render(160);
    fixture.releaseStart();
    await t.waitFor(() => assert.equal(fixture.preSubmitValidationReady, true));
    fixture.releasePreSubmitValidation();
    await t.waitFor(() => assert.equal(fixture.requestObserved, true));
    fixture.releaseAcknowledgement();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));

    const release = claimProcessLock(
      delegationLockPathForTest(WORKSPACE, LEAD_SESSION_ID),
      { name: "test delegation lifecycle" },
    );
    release();
  } finally {
    fixture.releaseInitialStatus();
    fixture.releaseStart();
    fixture.releasePreSubmitValidation();
    fixture.releaseAcknowledgement();
    await starting?.catch(() => {});
    fixture.pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(fixture.mailbox);
  }
});

test("completed and mismatched herd history does not resurrect", async () => {
  for (const history of [
    [
      {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt: 1_000,
      },
      {
        phase: "finished",
        sessionId: LEAD_SESSION_ID,
        startedAt: 1_000,
        completedAt: 2_000,
      },
    ],
    [
      {
        phase: "started",
        sessionId: "other-session",
        startedAt: 1_000,
      },
    ],
  ]) {
    setLeadEnvironment();
    const entries = history.map((data) => ({
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data,
    }));
    const pi = fakePi({ entries });
    const context = fakeContext(entries);
    registerExtension!(pi.pi as never);
    try {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, context);
      for (const handler of pi.events.get("agent_settled") ?? [])
        await handler({ aborted: false }, context);
      assert.equal(
        entries.filter(
          (entry: any) =>
            entry.customType === "pi-herdsman-herd-run" &&
            entry.data?.phase === "finished",
        ).length,
        history.filter((data) => data.phase === "finished").length,
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
    }
  }
});

test("restored herd waits for direct durable cleanup before finishing", async (t) => {
  setLeadEnvironment();
  const label = `recovered-herd-${randomUUID().slice(0, 8)}`;
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: { phase: "started", sessionId: LEAD_SESSION_ID, startedAt: 1_000 },
    },
  ];
  const state = managedState(label);
  resetAgentMailbox(startup.mailbox);
  writeAgentState(startup.mailbox, state);
  const pi = fakePi({ entries, exec: startup.exec });
  const context = fakeContext(entries);
  const herdEntries = () =>
    entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler({ aborted: false }, context);
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "finished").length,
      0,
    );
    resetAgentMailbox(startup.mailbox);
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler({ aborted: false }, context);
    await t.waitFor(() =>
      assert.equal(
        herdEntries().filter((entry) => entry.data?.phase === "finished")
          .length,
        1,
        "herd run did not finish after direct durable cleanup",
      ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }
});

test("registered extensions preserve adjacent ask escalation and assignment results", async (t) => {
  setLeadEnvironment();
  const parentLabel = "escalation-parent";
  const childLabel = "escalation-child";
  const parentRequestId = randomUUID();
  const childRequestId = randomUUID();
  const parentIdentity = defaultFixtureIdentity;
  const childIdentity: FixtureIdentity = {
    paneId: "escalation-child-pane",
    tabId: "escalation-child-tab",
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/escalation-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
  const parent = {
    ...managedState(parentLabel, parentRequestId, parentIdentity),
    piSessionId: parentIdentity.piSessionId,
    piSessionFile: parentIdentity.piSessionFile,
  };
  const child = {
    ...managedState(childLabel, childRequestId, childIdentity),
    ownerSessionId: parent.piSessionId,
  };
  const setNestedAgentEnv = (
    label: string,
    ownerSessionId: string,
    definition: string,
    allowedAgentDefinitions: string[],
  ): void => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    process.env.PI_HERDSMAN_MAILBOX = agentMailboxPath(WORKSPACE, label);
    process.env.PI_HERDSMAN_RUN_ID = AGENT_ID;
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = ownerSessionId;
    process.env.PI_HERDSMAN_OWNER_DISPLAY = `${definition}:${label}`;
    process.env.PI_HERDSMAN_LABEL = label;
    process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
    process.env.PI_HERDSMAN_AGENT_DEFINITION = definition;
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify(
      allowedAgentDefinitions,
    );
    process.env.HERDR_PANE_ID =
      label === parentLabel ? parentIdentity.paneId : childIdentity.paneId;
  };
  const childDefinition = join(PI_AGENTS_DIR, "child.md");
  writeFileSync(childDefinition, "---\nname: child\n---\nchild\n");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);

  let childAgent: ReturnType<typeof fakePi> | undefined;
  let parentAgent: ReturnType<typeof fakePi> | undefined;
  let leadAgent: ReturnType<typeof fakePi> | undefined;
  let leadReply: RequestRecord | undefined;
  let parentReply: RequestRecord | undefined;
  let stopChildConsumer: (() => void) | undefined;
  try {
    setNestedAgentEnv(childLabel, parent.piSessionId, "child", []);
    childAgent = fakePi();
    registerExtension!(childAgent.pi as never);
    const childBranch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "ask_owner" }],
        },
      },
    ];
    const childContext = fakeAgentContext(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            definition: "child",
            label: process.env.PI_HERDSMAN_LABEL ?? "child",
          },
        },
      ],
      childBranch,
    );
    childContext.sessionManager.getSessionId = () => child.piSessionId;
    childContext.sessionManager.getSessionFile = () => child.piSessionFile!;
    await childAgent.events.get("session_start")![0](undefined, childContext);
    const childAskTool = childAgent.tools.find(
      (tool) => tool.name === "ask_owner",
    );
    assert.ok(childAskTool);
    await childAskTool.execute(
      "child-ask",
      { question: "Which implementation should I use?" },
      undefined,
      undefined,
      childContext,
    );
    const childWaiting = readAgentState(childMailbox)!;
    assert.equal(childWaiting.activeRequestId, childRequestId);
    assert.ok(childWaiting.pendingAskId);
    assert.equal(childWaiting.ownerSessionId, parent.piSessionId);
    assert.equal(childWaiting.workspaceId, parent.workspaceId);
    const childAsk = readPendingAsk(childMailbox, childWaiting)!;
    childAgent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(childMailbox);

    setNestedAgentEnv(parentLabel, LEAD_SESSION_ID, "agent", ["child"]);
    const parentBase = agentControllerExecutor(parent, [child]);
    const parentEntries: unknown[] = [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label: process.env.PI_HERDSMAN_LABEL ?? "agent",
        },
      },
    ];
    parentAgent = fakePi({ exec: parentBase, entries: parentEntries });
    registerExtension!(parentAgent.pi as never);
    const parentBranch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "ask_owner" }],
        },
      },
    ];
    const parentContext = fakeAgentContext(parentEntries, parentBranch);
    parentContext.sessionManager.getBranch = () => parentBranch;
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentContext);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
      parentEntries.map(String).join("\n"),
    );
    writeAgentState(childMailbox, childWaiting);
    writeAsk(childMailbox, childAsk);
    const parentAskTool = parentAgent.tools.find(
      (tool) => tool.name === "ask_owner",
    );
    assert.ok(parentAskTool);
    await parentAskTool.execute(
      "parent-ask",
      { question: "How should I answer the child?" },
      undefined,
      undefined,
      parentContext,
    );
    const parentWaiting = readAgentState(parentMailbox)!;
    assert.equal(parentWaiting.activeRequestId, parentRequestId);
    assert.ok(parentWaiting.pendingAskId);
    assert.equal(
      readAgentState(childMailbox)?.pendingAskId,
      childWaiting.pendingAskId,
    );
    parentAgent.events.get("session_shutdown")?.[0]();

    delete process.env.PI_HERDSMAN_MAILBOX;
    delete process.env.PI_HERDSMAN_RUN_ID;
    delete process.env.PI_HERDSMAN_OWNER_SESSION_ID;
    delete process.env.PI_HERDSMAN_OWNER_DISPLAY;
    delete process.env.PI_HERDSMAN_LABEL;
    delete process.env.PI_HERDSMAN_WORKSPACE_ID;
    delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
    delete process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS;
    delete process.env.HERDR_PANE_ID;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    const leadBase = leadExec(
      parentLabel,
      "working",
      parent.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
        leadReply = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
      },
      parent.piSessionId,
      parentIdentity,
    );
    let failInitialAskDelivery = true;
    leadAgent = fakePi({
      exec: leadBase,
      sendMessage: (message) => {
        if (
          failInitialAskDelivery &&
          (message as any)?.customType === "pi-herdsman-agent-ask"
        ) {
          failInitialAskDelivery = false;
          throw new Error("temporary ask delivery failure");
        }
      },
    });
    registerExtension!(leadAgent.pi as never);
    const leadContext = fakeContext();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await leadAgent.events.get("session_start")![0](undefined, leadContext);
    const askWatcher = watchedMailboxDirectories.get(parentMailbox);
    assert.equal(askWatcher?.size, 2, "pending ask keeps its mailbox observer");
    assert.equal(
      failInitialAskDelivery,
      false,
      "initial compatible ask delivery should schedule a retry",
    );
    const retryingList = await registeredAgentTool(leadAgent, "list").execute(
      "list-retrying-ask",
      {},
      undefined,
      undefined,
      leadContext,
    );
    assert.match(
      String(retryingList.details.agents[0].cleanup_error),
      /Ask delivery failed; retrying/i,
    );
    writeAgentState(parentMailbox, {
      ...readAgentState(parentMailbox)!,
      build: OTHER_HERDSMAN_BUILD,
    });
    emitMailboxChange(parentMailbox, "state.json");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const incompatibleList = await registeredAgentTool(
      leadAgent,
      "list",
    ).execute("list-incompatible-ask", {}, undefined, undefined, leadContext);
    assert.match(
      String(incompatibleList.details.agents[0].cleanup_error),
      /incompatible pi herdsman build/i,
    );
    const errorsBefore = leadAgent.entries.filter(
      (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
    ).length;
    for (let attempt = 0; attempt < 3; attempt++)
      for (const handler of leadAgent.events.get("agent_settled") ?? [])
        await handler({ aborted: false }, leadContext);
    assert.equal(
      leadAgent.entries.filter(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ).length,
      errorsBefore,
      "repeated settle checks must not persist stable build mismatch errors",
    );
    const stillIncompatibleList = await registeredAgentTool(
      leadAgent,
      "list",
    ).execute(
      "list-still-incompatible-ask",
      {},
      undefined,
      undefined,
      leadContext,
    );
    assert.match(
      String(stillIncompatibleList.details.agents[0].cleanup_error),
      /incompatible pi herdsman build/i,
      "transient incompatibility status remains visible",
    );
    t.mock.timers.tick(2_000);
    assert.equal(
      leadAgent.entries.filter(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ).length,
      errorsBefore,
      "stable build mismatch must not persist retry errors",
    );
    const afterRetryList = await registeredAgentTool(leadAgent, "list").execute(
      "list-after-mismatch-retry",
      {},
      undefined,
      undefined,
      leadContext,
    );
    assert.match(
      String(afterRetryList.details.agents[0].cleanup_error),
      /incompatible pi herdsman build/i,
      "scheduled retry must stop without replacing the transient mismatch status",
    );
    const incompatibleState = readAgentState(parentMailbox)!;
    writeAgentState(parentMailbox, {
      ...incompatibleState,
      build: HERDSMAN_BUILD,
    });
    emitMailboxChange(parentMailbox, "state.json");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const compatibleList = await registeredAgentTool(leadAgent, "list").execute(
      "list-compatible-ask",
      {},
      undefined,
      undefined,
      leadContext,
    );
    assert.equal(compatibleList.details.agents[0].cleanup_error, undefined);
    assert.equal(
      leadAgent.sent.length,
      2,
      "existing watcher resumes ask delivery",
    );
    assert.equal(readAgentState(parentMailbox)?.runId, parent.runId);
    assert.equal(
      readAgentState(parentMailbox)?.pendingAskId,
      parentWaiting.pendingAskId,
    );
    const leadReplyResult = await registeredAgentTool(
      leadAgent,
      "reply",
    ).execute(
      "lead-reply",
      {
        agent: parentLabel,
        message: "Tell the child ALPHA.",
      },
      undefined,
      undefined,
      leadContext,
    );
    assert.equal(leadReplyResult.details.ok, true);
    assert.equal(leadReply?.kind, "reply");
    assert.equal(leadReply?.askId, parentWaiting.pendingAskId);
    assert.equal(leadReply?.requestId === parentRequestId, false);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );
    assert.equal(
      readAgentState(parentMailbox)?.pendingAskId,
      parentWaiting.pendingAskId,
    );
    leadAgent.events.get("session_shutdown")?.[0]();

    const parentReady = readAgentState(parentMailbox)!;
    writeAgentState(parentMailbox, {
      ...parentReady,
      lastAck: undefined,
      updatedAt: Date.now(),
    });
    setNestedAgentEnv(parentLabel, LEAD_SESSION_ID, "agent", ["child"]);
    parentAgent = fakePi({ exec: parentBase });
    registerExtension!(parentAgent.pi as never);
    const parentReplyContext = fakeAgentContext([
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label: process.env.PI_HERDSMAN_LABEL ?? "agent",
        },
      },
    ]);
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentReplyContext);
    assert.ok(leadReply);
    writeRequest(parentMailbox, leadReply!);
    assert.deepEqual(
      parentAgent.events.get("input")![0](
        { text: controlMarker(leadReply!.requestId) },
        parentReplyContext,
      ),
      {
        action: "transform",
        text: "Owner reply:\n\nTell the child ALPHA.\n\nContinue the original assignment using this answer.",
      },
    );
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );
    assert.equal(readAgentState(parentMailbox)?.pendingAskId, undefined);
    stopChildConsumer = consumeMailboxRequest(childMailbox, (request) => {
      parentReply = request;
      const current = readAgentState(childMailbox)!;
      writeAgentState(childMailbox, {
        ...current,
        lastAck: {
          requestId: request.requestId,
          accepted: true,
          acknowledgedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
    });
    parentAgent.events.get("session_shutdown")?.[0]();
    parentAgent = fakePi({ exec: parentBase });
    registerExtension!(parentAgent.pi as never);
    const parentReplyBranch: unknown[] = [];
    const parentReplyAgentContext = fakeAgentContext(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            definition: "agent",
            label: process.env.PI_HERDSMAN_LABEL ?? "agent",
          },
        },
      ],
      parentReplyBranch,
    );
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentReplyAgentContext);
    const childReplyResult = await registeredAgentTool(
      parentAgent,
      "reply",
    ).execute(
      "parent-reply",
      {
        agent: childLabel,
        message: "Use ALPHA and finish.",
      },
      undefined,
      undefined,
      parentReplyAgentContext,
    );
    assert.equal(
      childReplyResult.details.ok,
      true,
      JSON.stringify(childReplyResult.details),
    );
    assert.equal(
      childReplyResult.details.assignment_request_id,
      childRequestId,
    );
    assert.equal(parentReply?.kind, "reply");
    assert.equal(parentReply?.askId, childWaiting.pendingAskId);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );
    parentAgent.events.get("session_shutdown")?.[0]();
    writeAgentState(childMailbox, childWaiting);
    writeAsk(childMailbox, childAsk);

    setNestedAgentEnv(childLabel, parent.piSessionId, "child", []);
    childAgent = fakePi();
    registerExtension!(childAgent.pi as never);
    const childResultContext = fakeAgentContext([
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "child",
          label: process.env.PI_HERDSMAN_LABEL ?? "child",
        },
      },
    ]);
    childResultContext.sessionManager.getSessionId = () => child.piSessionId;
    childResultContext.sessionManager.getSessionFile = () =>
      child.piSessionFile!;
    await childAgent.events.get("session_start")![0](
      undefined,
      childResultContext,
    );
    assert.ok(parentReply);
    assert.equal(readAgentState(childMailbox)?.activeRequestId, childRequestId);
    assert.equal(
      readAgentState(childMailbox)?.pendingAskId,
      childWaiting.pendingAskId,
    );
    assert.ok(readPendingAsk(childMailbox, readAgentState(childMailbox)!));
    writeRequest(childMailbox, parentReply!);
    assert.equal(
      childAgent.events.get("input")![0](
        { text: controlMarker(parentReply!.requestId) },
        childResultContext,
      ).action,
      "transform",
    );
    assert.equal(readAgentState(childMailbox)?.activeRequestId, childRequestId);
    assert.equal(readAgentState(childMailbox)?.pendingAskId, undefined);
    childAgent.events.get("message_end")![0](
      { message: { role: "assistant", content: "ALPHA" } },
      childResultContext,
    );
    await childAgent.events.get("turn_end")![0](
      {
        outcome: "completed",
        message: { role: "assistant", content: "ALPHA" },
        messageEntryId: "child-response",
      },
      childResultContext,
    );
    await childAgent.events.get("agent_before_settle")![0](
      { outcome: "completed" },
      childResultContext,
    );
    await childAgent.events.get("agent_settled")![0](
      { aborted: false },
      childResultContext,
    );
    assert.equal(readResult(childMailbox, childRequestId)?.text, "ALPHA");
    assert.equal(
      readAgentState(childMailbox)?.completedRequestId,
      childRequestId,
    );
    childAgent.events.get("session_shutdown")?.[0]();

    setNestedAgentEnv(parentLabel, LEAD_SESSION_ID, "agent", ["child"]);
    parentAgent = fakePi({ exec: parentBase });
    registerExtension!(parentAgent.pi as never);
    const parentResultEntries: unknown[] = [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label: process.env.PI_HERDSMAN_LABEL ?? "agent",
        },
      },
      {
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(child, childRequestId),
      },
    ];
    const parentResultContext = fakeAgentContext(parentResultEntries);
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentResultContext);
    parentAgent.events.get("message_end")![0](
      { message: { role: "assistant", content: "Parent completed." } },
      parentResultContext,
    );
    await parentAgent.events.get("turn_end")![0](
      {
        outcome: "completed",
        message: { role: "assistant", content: "Parent completed." },
        messageEntryId: "parent-response",
      },
      parentResultContext,
    );
    await parentAgent.events.get("agent_before_settle")![0](
      { outcome: "completed" },
      parentResultContext,
    );
    await parentAgent.events.get("agent_settled")![0](
      { aborted: false },
      parentResultContext,
    );
    assert.equal(
      readResult(parentMailbox, parentRequestId)?.text,
      "Parent completed.",
    );
    assert.equal(
      readAgentState(parentMailbox)?.completedRequestId,
      parentRequestId,
    );
    assert.deepEqual(
      listAgentStates()
        .filter(({ state }) =>
          [parentLabel, childLabel].includes(state.agentLabel),
        )
        .map(({ state }) => state.activeRequestId ?? state.completedRequestId)
        .sort(),
      [childRequestId, parentRequestId].sort(),
    );
    parentAgent.events.get("session_shutdown")?.[0]();
  } finally {
    stopChildConsumer?.();
    childAgent?.events.get("session_shutdown")?.[0]();
    parentAgent?.events.get("session_shutdown")?.[0]();
    leadAgent?.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
    realFs.unlinkSync(childDefinition);
    setLeadEnvironment();
  }
});

test("one failed child recovery does not clear valid sibling runtimes", async () => {
  setAgentEnvironment("recovery-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("recovery-parent");
  const badChild = {
    ...managedState(
      "recovery-bad",
      undefined,
      recoveryIdentity("recovery-bad"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(testTmpRoot, "recovery-bad.jsonl"),
  };
  const goodChild = {
    ...managedState(
      "recovery-good",
      undefined,
      recoveryIdentity("recovery-good"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(testTmpRoot, "recovery-good.jsonl"),
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const badMailbox = agentMailboxPath(WORKSPACE, badChild.agentLabel);
  const goodMailbox = agentMailboxPath(WORKSPACE, goodChild.agentLabel);
  for (const mailbox of [parentMailbox, badMailbox, goodMailbox])
    resetAgentMailbox(mailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(badMailbox, badChild);
  writeAgentState(goodMailbox, goodChild);
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ];
  const base = agentControllerExecutor(parent, [badChild, goodChild]);
  const pi = fakePi({
    entries,
    exec: (command, args, options) => {
      const result = base(command, args, options);
      if (command === "herdr" && isApiSnapshot(args)) {
        const value = JSON.parse(result.stdout);
        const bad = value.result.snapshot.agents.find(
          (agent: any) => agent.pane_id === badChild.paneId,
        );
        if (bad)
          bad.agent_session = {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "22222222-2222-4222-8222-222222222222",
          };
        return { ...result, stdout: JSON.stringify(value) };
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const listed = await registeredAgentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      listed.details.agents.map((agent: any) => agent.agent).sort(),
      [goodChild.agentLabel, badChild.agentLabel].sort(),
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of [parentMailbox, badMailbox, goodMailbox])
      resetAgentMailbox(mailbox);
  }
});

test("historical session with its inherited label rejects an active managed representation", async () => {
  setLeadEnvironment();
  const name = `active-session-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const chiefDefinitionPath = join(PI_AGENTS_DIR, "chief.md");
  const previousChiefDefinition = realFs.existsSync(chiefDefinitionPath)
    ? realFs.readFileSync(chiefDefinitionPath, "utf8")
    : undefined;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousTab = process.env.HERDR_TAB_ID;
  process.env.HERDR_PANE_ID = "active-session-pane";
  process.env.HERDR_TAB_ID = "active-session-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `active-session-${randomUUID()}.sock`,
  );
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}-session.jsonl`),
  };
  const aliasPath = `${identity.piSessionFile}-alias`;
  const liveIdentity = { ...identity, piSessionFile: aliasPath };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const session = {
    id: identity.piSessionId,
    path: identity.piSessionFile,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: identity.piSessionId, definition: name, label },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nenabled active session test\n`,
  );
  realFs.writeFileSync(
    chiefDefinitionPath,
    `---\nname: chief\nagents: [${name}]\n---\n`,
  );
  writeValidPiSessionFile(session);
  realFs.symlinkSync(identity.piSessionFile, aliasPath);
  nativeSessions.set(session.id, session);
  const active = {
    ...managedState(label, REQUEST_ID, liveIdentity),
    piSessionId: identity.piSessionId,
    piSessionFile: aliasPath,
    agentDefinition: name,
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, active);
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      session.id,
      undefined,
      session.id,
      liveIdentity,
    ),
  });
  registerExtension!(pi.pi as never);
  try {
    const activationContext = fakeContext(pi.entries);
    seedLeadRole(activationContext);
    await pi.events.get("session_start")?.[0](undefined, activationContext);
    await pi.commandOptions.get("chief")!.handler("", activationContext);
    const controllerContext = fakeContext();
    controllerContext.sessionManager.getSessionId = () => session.id;
    const ownSession = await pi.tools
      .find((tool) => tool.name === "continue_agent")!
      .execute(
        "controller-session",
        {
          session: session.id,
          task: "must not self-delegate",
        },
        undefined,
        undefined,
        controllerContext,
      );
    assert.equal(ownSession.details.error.category, "invalid_request");
    const before = pi.calls.length;
    const result = await pi.tools
      .find((tool) => tool.name === "continue_agent")!
      .execute(
        "id",
        { session: session.path, task: "must wait" },
        undefined,
        undefined,
        ownedSessionContext(session.id, label),
      );
    assert.equal(result.details.error.category, "agent_busy");
    assert.match(result.details.error.message, /exact Pi session|represented/i);
    assert.equal(
      pi.calls
        .slice(before)
        .some(
          (args) =>
            args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
        ),
      false,
    );
    assert.deepEqual(readAgentState(mailbox), active);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(aliasPath, { force: true });
    realFs.rmSync(identity.piSessionFile, { force: true });
    if (previousChiefDefinition === undefined)
      realFs.rmSync(chiefDefinitionPath, { force: true });
    else realFs.writeFileSync(chiefDefinitionPath, previousChiefDefinition);
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
    if (previousTab === undefined) delete process.env.HERDR_TAB_ID;
    else process.env.HERDR_TAB_ID = previousTab;
  }
});

test("exact requested session IDs remain busy when persisted paths are stale", async () => {
  setLeadEnvironment();
  const name = `stale-id-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: `${name}-agent`,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact stale ID test\n`,
  );
  writeValidPiSessionFile(session);
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel, REQUEST_ID),
    piSessionId: session.id,
    piSessionFile: join(PI_AGENT_ROOT, `${name}-deleted-session.jsonl`),
  });
  const startup = startupExecutor(`${name}-agent`, () => session.id);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: session.id, task: "must wait" },
      undefined,
      undefined,
      ownedSessionContext(session.id, `${name}-agent`),
    );
    assert.equal(
      result.details.error.category,
      "agent_busy",
      result.details.error.message,
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("concurrent session activation permits one generation", async () => {
  setLeadEnvironment();
  const name = `concurrent-session-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nconcurrent activation test\n`,
  );
  writeValidPiSessionFile(session);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  let release!: () => void;
  let startEntered!: () => void;
  const entered = new Promise<void>((resolve) => (startEntered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pi = fakePi({
    exec: async (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        startEntered();
        await gate;
      }
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const first = registeredAgentTool(pi, "continue").execute(
      "first",
      { session: session.path, task: "first assignment" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    await entered;
    const second = await registeredAgentTool(pi, "continue").execute(
      "second",
      { session: session.id, task: "duplicate assignment" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(second.details.error.category, "agent_busy");
    release();
    const firstResult = await first;
    assert.equal(
      firstResult.details.ok,
      true,
      JSON.stringify(firstResult.details),
    );
  } finally {
    release();
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("session assignment reports a pane mismatch from the agent state producer", async () => {
  const label = "agent";
  const producerMismatchPath = join(testTmpRoot, "producer-mismatch.jsonl");
  const registeredAgentPath = join(testTmpRoot, "registered-agent.jsonl");
  const mailbox = setAgentEnvironment(label);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const agentStart = agent.events.get("session_start")![0];
  const paneEnvironment: Record<string, string> = {};
  const producerMismatchSession = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    path: producerMismatchPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label,
        },
      },
    ],
  };
  nativeSessions.set(producerMismatchSession.id, producerMismatchSession);
  writeValidPiSessionFile(producerMismatchSession);
  realFs.writeFileSync(registeredAgentPath, "{}", "utf8");
  setLeadEnvironment();
  const lead = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tabs: [],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "tab" && args[1] === "create")
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator > 0)
            paneEnvironment[assignment.slice(0, separator)] = assignment.slice(
              separator + 1,
            );
        }
      if (args[0] === "tab" && args[1] === "create")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tab: {
                tab_id: "producer-tab",
                label: "agents",
                workspace_id: WORKSPACE,
              },
              root_pane: {
                pane_id: "helper-pane",
                terminal_id: "helper-terminal",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                {
                  pane_id: "helper-pane",
                  tab_id: "producer-tab",
                  workspace_id: WORKSPACE,
                  terminal_id: "helper-terminal",
                  cwd: "/tmp",
                  foreground_cwd: "/tmp",
                  agent_status: "unknown",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              process_info: {
                pane_id: "helper-pane",
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (
        args[0] === "pane" &&
        (args[1] === "run" || args[1] === "wait-output")
      ) {
        if (args[1] === "run")
          for (const match of (args.at(-1) ?? "").matchAll(
            /([A-Z][A-Z0-9_]*)='([^']*)'/g,
          ))
            paneEnvironment[match[1]] = match[2];
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: JSON.parse(listResponse(label, "idle", null)).agents,
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      const previous = { ...process.env };
      Object.assign(process.env, paneEnvironment, {
        HERDR_PANE_ID: "agent-pane",
      });
      await agentStart(undefined, fakeAgentContext(agent.entries));
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            agent: {
              name: runScopedHerdrAlias(
                WORKSPACE,
                label,
                paneEnvironment.PI_HERDSMAN_RUN_ID ?? AGENT_ID,
              ),
              pane_id: "agent-pane",
              tab_id: "producer-tab",
              workspace_id: WORKSPACE,
              cwd: "/tmp",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              },
            },
          },
          runtime_identity: {
            herdr_agent: runScopedHerdrAlias(
              WORKSPACE,
              label,
              paneEnvironment.PI_HERDSMAN_RUN_ID ?? AGENT_ID,
            ),
            herdr_kind: "pi",
            agent_definition: "agent",
            model: null,
            thinking: null,
            cwd: "/tmp",
            resumed: true,
            session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            session_name: null,
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  });
  registerExtension!(lead.pi as never);
  seedLeadRole(fakeContext(lead.entries));
  await lead.events.get("session_start")![0](
    undefined,
    fakeContext(lead.entries),
  );
  try {
    const result = await registeredAgentTool(lead, "continue").execute(
      "id",
      {
        session: producerMismatchPath,
        task: "continue the mismatched session",
      },
      undefined,
      undefined,
      ownedSessionContext(DEFAULT_PI_SESSION_ID, label),
    );
    assert.equal(result.details.ok, false);
    assert.match(result.details.error.message, /paneId/);
    assert.match(result.details.error.message, /agent-pane/);
    assert.match(result.details.error.message, /helper-pane/);
  } finally {
    lead.events.get("session_shutdown")?.[0]();
    agent.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(mailbox);
    realFs.rmSync(producerMismatchPath, { force: true });
    realFs.rmSync(registeredAgentPath, { force: true });
  }
});

test("fresh assignment transports automatic prompt snapshots and cleans them up", async () => {
  setLeadEnvironment();
  const name = `prompt-fresh-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(promptPath, "automatic prompt snapshot");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  let assignedText = "";
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text) => {
      assignedText = text;
    },
    false,
    (args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "fresh task" },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched.length, 1);
    assert.deepEqual(
      launched[0].args.filter(
        (arg, index, args) =>
          (arg === "--system-prompt" || arg === "--append-system-prompt") &&
          !args[index + 1]?.startsWith("<active_agent "),
      ),
      ["--append-system-prompt", "--append-system-prompt"],
    );
    assert.equal(launched[0].contents.length, 2);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /automatic prompt snapshot/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.match(
      launched[0].contents[1]!.replaceAll(/\s+/g, " ").trim(),
      /canonical result:<request-id> refs already supplied as file evidence exactly\s+when forwarding them/,
    );
    assert.match(
      launched[0].contents[1]!,
      /pass reusable direct-agent result refs through `files`/,
    );
    assert.match(
      launched[0].contents[1]!,
      /Do not overlap writers in a worktree or file-ownership boundary/,
    );
    assert.match(
      launched[0].contents[1]!,
      /Preserve\s+canonical result:<request-id> refs already supplied as file evidence exactly\s+when forwarding them/,
    );
    assert.match(assignedText, /fresh task/);
    assert.equal(realFs.existsSync(mailbox), true);
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("startup failure cleans private prompt snapshots", async () => {
  setLeadEnvironment();
  const name = `failure-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  realFs.writeFileSync(promptPath, "startup failure prompt");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: string[][] = [];
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    (args) => launched.push(promptLaunchPaths(args)),
  );
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        throw new Error("injected startup failure");
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const context = fakeContext(pi.entries);
    await pi.events.get("agent_start")![0](undefined, context);
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: name,
        task: "must fail at startup",
      },
      undefined,
      undefined,
      context,
    );
    assert.notEqual(result.details.ok, true);
    assert.equal(
      pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-herd-run",
      ).length,
      0,
    );
    assert.equal(launched.length, 1);
    assert.ok(launched[0].length > 0);
    for (const path of launched[0])
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("caller assignment files suppress canonical-overlapping automatic prompts", async () => {
  setLeadEnvironment();
  const name = `prompt-overlap-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const callerPath = join(PI_AGENT_ROOT, `${name}-caller.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(promptPath, "caller wins canonical overlap");
  realFs.symlinkSync(promptPath, callerPath);
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  let assignedText = "";
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text) => {
      assignedText = text;
    },
    false,
    (args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: name,
        files: [callerPath],
        task: "use caller context",
      },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched[0].contents.length, 2);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.deepEqual(
      launched[0].args.filter(
        (arg, index, args) =>
          (arg === "--system-prompt" || arg === "--append-system-prompt") &&
          !args[index + 1]?.startsWith("<active_agent "),
      ),
      ["--append-system-prompt", "--append-system-prompt"],
    );
    assert.match(assignedText, /caller wins canonical overlap/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(callerPath, { force: true });
  }
});

test("automatic prompt failures happen before topology or mailbox mutation", async () => {
  setLeadEnvironment();
  const name = `prompt-invalid-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const directoryPath = join(PI_AGENT_ROOT, `${name}-directory`);
  const invalidPath = join(PI_AGENT_ROOT, `${name}-invalid.md`);
  const nulPath = join(PI_AGENT_ROOT, `${name}-nul.md`);
  realFs.mkdirSync(directoryPath);
  realFs.writeFileSync(invalidPath, Buffer.from([0xff, 0xfe]));
  realFs.writeFileSync(nulPath, Buffer.from("prompt\0content"));
  const cases = [
    ["missing", join(PI_AGENT_ROOT, `${name}-missing.md`)],
    ["directory", directoryPath],
    ["invalid utf8", invalidPath],
    ["nul", nulPath],
  ] as const;
  try {
    for (const [kind, promptPath] of cases) {
      const label = `${name}-${kind.replaceAll(" ", "-")}`;
      const mailbox = agentMailboxPath(WORKSPACE, label);
      writePromptDefinition(definitionPath, name, promptPath);
      const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
      const pi = fakePi({ exec: startup.exec });
      registerExtension!(pi.pi as never);
      try {
        const result = await registeredAgentTool(pi, "delegate").execute(
          "id",
          { definition: name, label, task: "must fail" },
          undefined,
          undefined,
          fakeContext(pi.entries),
        );
        assert.equal(result.details.error.category, "invalid_request", kind);
        assert.equal(startup.getCount(), 0, kind);
        assert.equal(realFs.existsSync(mailbox), false, kind);
        assert.equal(
          pi.calls.some(
            (args) =>
              args[0] === "pane" ||
              (args[0] === "agent" &&
                ["start", "stop"].includes(args[1] ?? "")),
          ),
          false,
          kind,
        );
      } finally {
        pi.events.get("session_shutdown")?.[0]();
        resetAgentMailbox(mailbox);
      }
    }
  } finally {
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(directoryPath, { recursive: true, force: true });
    realFs.rmSync(invalidPath, { force: true });
    realFs.rmSync(nulPath, { force: true });
  }
});

test("fresh and non-live historical assignments reject disabled definitions", async () => {
  setLeadEnvironment();
  const freshName = `disabled-fresh-${randomUUID().slice(0, 8)}`;
  const freshLabel = `${freshName}-agent`;
  const freshDefinitionPath = join(PI_AGENTS_DIR, `${freshName}.md`);
  realFs.writeFileSync(
    freshDefinitionPath,
    `---\nname: ${freshName}\nenabled: false\n---\nfresh\n`,
  );
  const freshStartup = startupExecutor(freshLabel, () => DEFAULT_PI_SESSION_ID);
  const freshPi = fakePi({ exec: freshStartup.exec });
  registerExtension!(freshPi.pi as never);
  const freshContext = fakeContext(freshPi.entries);
  await freshPi.events.get("session_start")![0](undefined, freshContext);
  seedLeadRole(fakeContext(freshPi.entries));
  try {
    const result = await registeredAgentTool(freshPi, "delegate").execute(
      "id",
      {
        definition: freshName,
        task: "must remain disabled",
      },
      undefined,
      undefined,
      freshContext,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /disabled/);
    assert.match(result.details.error.message, new RegExp(freshName));
    assert.equal(freshStartup.getCount(), 0);
    assert.equal(realFs.existsSync(freshStartup.mailbox), false);
  } finally {
    freshPi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(freshDefinitionPath, { force: true });
  }

  setLeadEnvironment();
  const historicalName = `disabled-session-${randomUUID().slice(0, 8)}`;
  const historicalDefinitionPath = join(PI_AGENTS_DIR, `${historicalName}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${historicalName}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: historicalName,
          label: `${historicalName}-agent`,
        },
      },
    ],
  };
  realFs.writeFileSync(
    historicalDefinitionPath,
    `---\nname: ${historicalName}\nenabled: false\n---\nhistorical\n`,
  );
  nativeSessions.set(session.id, session);
  const historicalStartup = startupExecutor(
    `${historicalName}-agent`,
    () => session.id,
  );
  const historicalPi = fakePi({ exec: historicalStartup.exec });
  registerExtension!(historicalPi.pi as never);
  const historicalContext = ownedSessionContext(
    session.id,
    `${historicalName}-agent`,
  );
  await historicalPi.events.get("session_start")![0](
    undefined,
    historicalContext,
  );
  try {
    const result = await registeredAgentTool(historicalPi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "must remain disabled",
      },
      undefined,
      undefined,
      historicalContext,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /disabled/);
    assert.equal(historicalStartup.getCount(), 0);
    assert.equal(realFs.existsSync(historicalStartup.mailbox), false);
  } finally {
    historicalPi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    realFs.rmSync(historicalDefinitionPath, { force: true });
  }
});

test("assigning a parent with a disabled child fails with an explicit reason", async () => {
  setLeadEnvironment();
  const parentPath = join(PI_AGENTS_DIR, "disabled-child-parent.md");
  const childPath = join(PI_AGENTS_DIR, "disabled-child.md");
  realFs.writeFileSync(
    parentPath,
    '---\nname: disabled-child-parent\nagents: ["disabled-child"]\n---\nparent\n',
  );
  realFs.writeFileSync(
    childPath,
    "---\nname: disabled-child\nenabled: false\n---\nchild\n",
  );
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && args[0] === "--version"
        ? { stdout: "0.8.0", stderr: "", code: 0 }
        : command === "herdr" && isApiSnapshot(args)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: { snapshot: { agents: [], panes: [] } },
              }),
              stderr: "",
              code: 0,
            }
          : {
              stdout: JSON.stringify({ id: AGENT_ID, result: { agents: [] } }),
              stderr: "",
              code: 0,
            },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: "disabled-child-parent",
        task: "must reject disabled child",
      },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(
      result.details.error.message,
      /references disabled agent definition disabled-child/,
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(parentPath, { force: true });
    realFs.rmSync(childPath, { force: true });
  }
});

test("session continuation starts a new agent generation with current prompt contents", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const name = `prompt-resume-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const savedRequestId = randomUUID();
  const projectAssignmentId = LEAD_SESSION_ID;
  const evidenceAssignmentId = randomUUID();
  const inheritedEvidence = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "plan.md",
    "continued plan",
  );
  const localEvidence = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "review.md",
    "continued review",
  );
  const projectSocket = join(tmpdir(), `resume-authority-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = projectSocket;
  const projectRuntime = supervisionRuntime(projectSocket);
  const projectBranch = `resume-${randomUUID()}`;
  const currentAssignment = {
    version: 2 as const,
    id: projectAssignmentId,
    repoKey: "repo-key",
    branch: projectBranch,
    text: "Current project",
    requiredEvidence: [inheritedEvidence, localEvidence],
  };
  writeProjectAssignment(projectRuntime, currentAssignment);
  const savedState = {
    ...managedState(name),
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    agentDefinition: name,
    projectAssignmentId,
    completedRequestId: savedRequestId,
    lastAck: {
      requestId: savedRequestId,
      accepted: true,
      acknowledgedAt: Date.now(),
    },
  };
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
      {
        type: "custom",
        customType: "pi-herdsman-agent-required-evidence",
        data: {
          version: 1,
          sessionId: DEFAULT_PI_SESSION_ID,
          requestId: savedRequestId,
          runId: savedState.runId,
          ownerSessionId: savedState.ownerSessionId,
          workspaceId: savedState.workspaceId,
          agentLabel: name,
          paneId: savedState.paneId,
          projectAssignmentId,
          evidenceAssignmentId,
          inheritedEvidence: [inheritedEvidence],
          localEvidence: [localEvidence],
        },
      },
    ],
  };
  realFs.writeFileSync(promptPath, "current saved-session prompt");
  writeValidPiSessionFile(session);
  writePromptDefinition(definitionPath, name, promptPath);
  nativeSessions.set(session.id, session);
  const savedMailbox = agentMailboxPath(WORKSPACE, name);
  resetAgentMailbox(savedMailbox);
  writeAgentState(savedMailbox, savedState);
  assert.equal(readUnacknowledgedRequest(savedMailbox, savedState), undefined);
  assert.equal(readPendingAsk(savedMailbox, savedState), undefined);
  assert.equal(readResult(savedMailbox, savedRequestId), undefined);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-deleted-session.jsonl`),
  });
  const launched: { args: string[]; contents: string[] }[] = [];
  const launchedEnvironment: string[] = [];
  const startup = startupExecutor(
    label,
    () => session.id,
    undefined,
    undefined,
    false,
    (args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    },
    "/tmp",
    AGENT_ID,
    false,
    false,
    false,
    (request) => {
      continuedRequest = request;
    },
  );
  let continuedRequest: RequestRecord | undefined;
  const pi = fakePi({
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-session-kind",
        data: {
          version: 1,
          sessionId: LEAD_SESSION_ID,
          kind: "managed",
          repoKey: "repo-key",
          branch: projectBranch,
        },
      },
    ],
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
      if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
        for (let index = 0; index < args.length - 1; index++)
          if (args[index] === "--env")
            launchedEnvironment.push(args[index + 1]!);
      }
      return startup.exec(command, args, options);
    },
  });
  let bootstrapPrepares = 0;
  pi.pi.events.on(MANAGED_AGENT_BOOTSTRAP_EVENT, (event: any) => {
    if (event.phase === "prepare") bootstrapPrepares++;
  });
  pi.entries.push({
    type: "custom_message",
    message: {
      customType: "pi-herdsman-agent-result",
      details: {
        piSessionId: savedState.piSessionId,
        piSessionFile: savedState.piSessionFile,
        ownerSessionId: savedState.ownerSessionId,
        runId: savedState.runId,
        requestId: savedRequestId,
        workspaceId: savedState.workspaceId,
        agentLabel: savedState.agentLabel,
        paneId: savedState.paneId,
        agentDefinition: name,
        status: "completed",
      },
    },
  });

  registerExtension!(pi.pi as never);
  const projectAssignmentMessage = {
    customType: "pi-herdsman-project_assignment",
    details: { id: LEAD_SESSION_ID, branch: projectBranch },
    timestamp: Date.now(),
    content: `Project assignment for branch\n${currentAssignment.text}`,
  };
  const projectAssignmentContext = fakeContext(pi.entries) as any;
  projectAssignmentContext.sessionManager.getSessionId = () => LEAD_SESSION_ID;
  seedLeadRole(projectAssignmentContext, false);
  await pi.events.get("session_start")![0](undefined, projectAssignmentContext);
  await pi.events.get("agent_start")?.[0](undefined, projectAssignmentContext);
  (projectAssignmentContext.sessionManager.getBranch() as any[]).push({
    type: "custom_message",
    customType: projectAssignmentMessage.customType,
    message: projectAssignmentMessage,
  });
  for (const handler of pi.events.get("message_start") ?? [])
    await handler(
      { message: projectAssignmentMessage },
      projectAssignmentContext,
    );
  try {
    for (const pending of ["request", "ask", "result"] as const) {
      resetAgentMailbox(savedMailbox);
      const askId = randomUUID();
      writeAgentState(
        savedMailbox,
        pending === "ask"
          ? {
              ...savedState,
              completedRequestId: undefined,
              lastAck: undefined,
              activeRequestId: savedRequestId,
              pendingAskId: askId,
            }
          : savedState,
      );
      if (pending === "request")
        writeRequest(savedMailbox, {
          version: 5,
          runId: savedState.runId,
          requestId: randomUUID(),
          ownerSessionId: savedState.ownerSessionId,
          workspaceId: savedState.workspaceId,
          agentLabel: savedState.agentLabel,
          paneId: savedState.paneId,
          kind: "task",
          text: "unacknowledged request",
          createdAt: Date.now(),
        });
      if (pending === "ask")
        writeAsk(savedMailbox, {
          version: 5,
          askId,
          requestId: savedRequestId,
          runId: savedState.runId,
          ownerSessionId: savedState.ownerSessionId,
          workspaceId: savedState.workspaceId,
          agentLabel: savedState.agentLabel,
          paneId: savedState.paneId,
          piSessionId: session.id,
          question: "pending owner answer",
          createdAt: Date.now(),
        });
      if (pending === "result")
        writeResult(savedMailbox, {
          version: 5,
          runId: savedState.runId,
          requestId: savedRequestId,
          ownerSessionId: savedState.ownerSessionId,
          workspaceId: savedState.workspaceId,
          agentLabel: savedState.agentLabel,
          paneId: savedState.paneId,
          status: "completed",
          text: "undelivered result",
          completedAt: Date.now(),
        });
      const blocked = await registeredAgentTool(pi, "continue").execute(
        "id",
        { session: session.path, task: `reject pending ${pending}` },
        undefined,
        undefined,
        projectAssignmentContext,
      );
      assert.equal(blocked.details.ok, false, JSON.stringify(blocked.details));
      assert.equal(
        blocked.details.error?.category,
        pending === "ask" ? "target_ambiguous" : "agent_label_exists",
        JSON.stringify(blocked.details),
      );
      if (pending === "request")
        assert.match(blocked.details.error.message, /unacknowledged request/i);
      if (pending === "ask")
        assert.match(blocked.details.error.message, /multiple managed agents/i);
      if (pending === "result")
        assert.match(
          blocked.details.error.message,
          /Agent label already exists/i,
        );
      assert.equal(
        pi.calls.some(
          (args) =>
            args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
        ),
        false,
        `pending ${pending} must prevent startup`,
      );
    }
    resetAgentMailbox(savedMailbox);
    writeAgentState(savedMailbox, savedState);
    const savedEvidenceRecord = session.entries.find(
      (entry: any) =>
        entry.customType === "pi-herdsman-agent-required-evidence",
    ) as any;
    const originalInheritedEvidence =
      savedEvidenceRecord.data.inheritedEvidence[0];
    for (const forgedRef of [
      "evidence:unreserved-continuation#1",
      localEvidence.ref,
    ]) {
      savedEvidenceRecord.data.inheritedEvidence[0] = {
        ...originalInheritedEvidence,
        ref: forgedRef,
      };
      writeValidPiSessionFile(session);
      const persistedEvidenceRecord = realFs
        .readFileSync(session.path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find(
          (entry: any) =>
            entry.customType === "pi-herdsman-agent-required-evidence",
        );
      assert.equal(
        persistedEvidenceRecord.data.inheritedEvidence[0].ref,
        forgedRef,
      );
      const forged = await registeredAgentTool(pi, "continue").execute(
        "id",
        { session: session.path, task: "do not accept forged evidence" },
        undefined,
        undefined,
        ownedSessionContext(session.id, name),
      );
      assert.equal(forged.details.ok, false, JSON.stringify(forged.details));
      assert.equal(forged.details.error?.category, "invalid_request");
      assert.equal(
        forged.details.error.message,
        "Saved assignment evidence is unavailable or invalid",
      );
      assert.ok(!JSON.stringify(forged).includes("continued plan"));
      assert.ok(
        !JSON.stringify(forged).includes(originalInheritedEvidence.path),
      );
      assert.ok(!JSON.stringify(forged).includes(forgedRef));
    }
    savedEvidenceRecord.data.inheritedEvidence[0] = originalInheritedEvidence;
    writeValidPiSessionFile(session);
    const unavailableEvidencePath = `${inheritedEvidence.path}.unavailable`;
    realFs.renameSync(inheritedEvidence.path, unavailableEvidencePath);
    try {
      const unavailableEvidence = await registeredAgentTool(
        pi,
        "continue",
      ).execute(
        "id",
        { session: session.path, task: "must reject missing saved evidence" },
        undefined,
        undefined,
        projectAssignmentContext,
      );
      assert.equal(
        unavailableEvidence.details.error?.category,
        "invalid_request",
        JSON.stringify(unavailableEvidence.details),
      );
      assert.match(
        unavailableEvidence.details.error.message,
        /Saved assignment evidence is unavailable or invalid/,
      );
    } finally {
      realFs.renameSync(unavailableEvidencePath, inheritedEvidence.path);
    }
    removeProjectAssignment(projectRuntime, "repo-key", projectBranch);
    await assert.rejects(
      registeredAgentTool(pi, "continue").execute(
        "id",
        { session: session.path, task: "must not revive retired scope" },
        undefined,
        undefined,
        projectAssignmentContext,
      ),
      /Managed project execution requires a current exact assignment/,
    );
    writeProjectAssignment(projectRuntime, currentAssignment);
    // An update to the parent assignment must not rewrite this saved Agent snapshot.
    writeProjectAssignment(projectRuntime, {
      ...currentAssignment,
      requiredEvidence: [],
    });
    const { ref: _savedRef, ...preReferenceEvidence } =
      savedEvidenceRecord.data.inheritedEvidence[0];
    savedEvidenceRecord.data.inheritedEvidence[0] = preReferenceEvidence;
    writeValidPiSessionFile(session);
    const persistedLegacyRecord = realFs
      .readFileSync(session.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (entry: any) =>
          entry.customType === "pi-herdsman-agent-required-evidence",
      );
    assert.equal(
      "ref" in persistedLegacyRecord.data.inheritedEvidence[0],
      false,
    );
    await pi.events.get("session_start")![0](
      undefined,
      projectAssignmentContext,
    );
    removeAgentMailbox(savedMailbox);
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "resume current prompt",
      },
      undefined,
      undefined,
      projectAssignmentContext,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched[0].contents.length, 2);
    assert.equal(bootstrapPrepares, 0);
    assert.equal(result.details.session_id, session.id);
    assert.equal(result.details.owner_session_id, LEAD_SESSION_ID);
    assert.ok(
      launchedEnvironment.includes(
        `PI_HERDSMAN_OWNER_SESSION_ID=${LEAD_SESSION_ID}`,
      ),
    );
    assert.ok(launchedEnvironment.includes("PI_HERDSMAN_OWNER_DISPLAY=lead"));
    assert.equal(result.details.session_path, "/tmp/registered-agent.jsonl");
    assert.ok(
      !JSON.stringify(result.content).includes("/tmp/registered-agent.jsonl"),
    );
    assert.equal((result.details as any).reusable, undefined);
    assert.equal((result.details as any).keepAlive, undefined);
    const state = readAgentState(startup.mailbox)!;
    assert.equal(state.version, 5);
    assert.equal(state.piSessionId, session.id);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /current saved-session prompt/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(continuedRequest);
    assert.notEqual(continuedRequest!.requestId, savedRequestId);
    assert.notEqual(continuedRequest!.runId, savedState.runId);
    assert.equal(continuedRequest!.projectAssignmentId, projectAssignmentId);
    assert.equal(continuedRequest!.evidenceAssignmentId, evidenceAssignmentId);
    assert.deepEqual(continuedRequest!.requiredEvidence, [
      inheritedEvidence,
      localEvidence,
    ]);
    assert.deepEqual(continuedRequest!.inheritedEvidence, [inheritedEvidence]);
    assert.deepEqual(continuedRequest!.localEvidence, [localEvidence]);
    assert.ok(
      continuedRequest!.text.includes(`${inheritedEvidence.ref} — plan.md`),
    );
    assert.ok(
      continuedRequest!.text.includes(`${localEvidence.ref} — review.md`),
    );
    assert.doesNotMatch(
      continuedRequest!.text,
      /continued plan|continued review/,
    );
    const sessionIndex = launched[0].args.indexOf("--session");
    assert.equal(
      launched[0].args[sessionIndex + 1],
      realFs.realpathSync(session.path),
    );
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startup.mailbox);
    resetAgentMailbox(savedMailbox);
    resetAgentMailbox(staleMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(session.path, { force: true });
    realFs.rmSync(inheritedEvidence.path, { force: true });
    realFs.rmSync(localEvidence.path, { force: true });
    removeProjectAssignment(projectRuntime, "repo-key", projectBranch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("scoped assignment result delivery persists terminal ownership and removes its mailbox", async () => {
  setLeadEnvironment();
  const label = `cleanup-resume-${randomUUID().slice(0, 8)}`;
  const sessionPath = join(PI_AGENT_ROOT, `${label}-session.jsonl`);
  const socket = join(tmpdir(), `cleanup-authority-${randomUUID()}.sock`);
  process.env.HERDR_SOCKET_PATH = socket;
  const runtime = supervisionRuntime(socket);
  const branch = `cleanup-${randomUUID()}`;
  const inherited = persistRequiredEvidenceSnapshot(
    LEAD_SESSION_ID,
    "plan.md",
    "accepted inherited plan",
  );
  const localFile = join("/tmp", `${label}-review.md`);
  realFs.writeFileSync(localFile, "accepted local review", "utf8");
  const assignment = {
    version: 2 as const,
    id: LEAD_SESSION_ID,
    repoKey: "repo-key",
    branch,
    text: "Current cleanup project",
    requiredEvidence: [inherited],
    currentEvidenceIds: [inherited.id],
  };
  writeProjectAssignment(runtime, assignment);
  let accepted: RequestRecord | undefined;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    (request) => {
      accepted = request;
      const state = readAgentState(startup.mailbox)!;
      const session = {
        id: DEFAULT_PI_SESSION_ID,
        path: sessionPath,
        cwd: "/tmp",
        entries: [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: DEFAULT_PI_SESSION_ID,
              definition: "agent",
              label,
            },
          },
          {
            type: "custom",
            customType: "pi-herdsman-agent-required-evidence",
            data: {
              version: 1,
              sessionId: DEFAULT_PI_SESSION_ID,
              requestId: request.requestId,
              runId: request.runId,
              ownerSessionId: request.ownerSessionId,
              workspaceId: request.workspaceId,
              agentLabel: request.agentLabel,
              paneId: request.paneId,
              projectAssignmentId: request.projectAssignmentId,
              evidenceAssignmentId: request.evidenceAssignmentId,
              inheritedEvidence: request.requiredEvidence ?? [],
              localEvidence: request.localEvidence ?? [],
              currentEvidenceIds: request.currentEvidenceIds,
            },
          },
        ],
      };
      nativeSessions.set(DEFAULT_PI_SESSION_ID, session);
      writeValidPiSessionFile(session);
    },
    sessionPath,
  );
  const pi = fakePi({
    persistMessages: true,
    exec: async (command, args, options) => {
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
      return startup.exec(command, args, options);
    },
  });
  const context = fakeContext(pi.entries);
  context.hasUI = true;
  const branchEntries = context.sessionManager.getBranch() as any[];
  registerExtension!(pi.pi as never);
  const assignmentMessage = {
    customType: "pi-herdsman-project_assignment",
    details: { id: LEAD_SESSION_ID, branch },
    timestamp: Date.now(),
    content: `Project assignment for branch\n${assignment.text}`,
  };
  await pi.events.get("session_start")![0](undefined, context);
  await pi.events.get("agent_start")?.[0](undefined, context);
  branchEntries.push({
    type: "custom_message",
    customType: assignmentMessage.customType,
    message: assignmentMessage,
  });
  for (const handler of pi.events.get("message_start") ?? [])
    await handler({ message: assignmentMessage }, context);
  await assertManagedLeadRole(pi, context);
  try {
    const delegated = await registeredAgentTool(pi, "delegate").execute(
      "cleanup-scoped-delegate",
      {
        definition: "agent",
        label,
        task: "review the accepted plan",
        files: [localFile],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    const sessionId = delegated.details.session_id;
    assert.equal(sessionId, DEFAULT_PI_SESSION_ID);
    assert.equal(delegated.details.session_path, sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(
      accepted,
      "delegated task should be accepted by the child mailbox",
    );
    assert.equal(accepted!.projectAssignmentId, assignment.id);
    assert.deepEqual(accepted!.requiredEvidence, [inherited]);
    assert.deepEqual(accepted!.inheritedEvidence, [inherited]);
    assert.deepEqual(accepted!.localEvidence, []);
    assert.deepEqual(accepted!.currentEvidenceIds, [inherited.id]);
    const acceptedEvidenceEntry = nativeSessions
      .get(sessionId)!
      .entries.find(
        (entry: any) =>
          entry?.customType === "pi-herdsman-agent-required-evidence",
      ) as any;
    assert.ok(acceptedEvidenceEntry, "Agent persists accepted evidence");
    assert.deepEqual(acceptedEvidenceEntry.data.inheritedEvidence, [inherited]);
    assert.deepEqual(acceptedEvidenceEntry.data.localEvidence, []);
    assert.deepEqual(acceptedEvidenceEntry.data.currentEvidenceIds, [
      inherited.id,
    ]);

    const mailbox = agentMailboxPath(WORKSPACE, label);
    const acceptedState = readAgentState(mailbox)!;
    writeAgentState(mailbox, {
      ...acceptedState,
      activeRequestId: undefined,
      completedRequestId: accepted!.requestId,
      updatedAt: Date.now(),
    });
    writeResult(mailbox, {
      version: 5,
      runId: accepted!.runId,
      requestId: accepted!.requestId,
      ownerSessionId: accepted!.ownerSessionId,
      workspaceId: accepted!.workspaceId,
      agentLabel: accepted!.agentLabel,
      paneId: accepted!.paneId,
      status: "completed",
      text: "completed review result",
      completedAt: Date.now(),
    });
    emitMailboxChange(mailbox);
    for (
      let attempt = 0;
      attempt < 100 && realFs.existsSync(mailbox);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const terminal = pi.entries.find(
      (entry: any) => entry?.customType === "pi-herdsman-agent-result",
    ) as any;
    assert.ok(terminal, "owner should persist delivered terminal result");
    assert.equal(terminal.details.requestId, accepted!.requestId);
    assert.equal(terminal.details.runId, accepted!.runId);
    assert.equal(terminal.details.piSessionId, sessionId);
    assert.equal(terminal.details.piSessionFile, sessionPath);
    assert.equal(
      realFs.existsSync(mailbox),
      false,
      `normal delivery cleans mailbox: ${JSON.stringify(pi.entries.filter((entry: any) => entry?.customType === "pi_herdsman_cleanup_error"))}`,
    );

    const firstRequest = accepted!;
    const resumed = await registeredAgentTool(pi, "continue").execute(
      "cleanup-scoped-continue",
      {
        session: delegated.details.session_path,
        task: "continue after result delivery cleanup",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(resumed.details.ok, true, JSON.stringify(resumed.details));
    assert.equal(resumed.details.session_id, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(
      accepted,
      "continued task should be accepted by the child mailbox",
    );
    assert.notEqual(accepted!.requestId, firstRequest.requestId);
    assert.notEqual(accepted!.runId, firstRequest.runId);
    assert.equal(
      accepted!.projectAssignmentId,
      firstRequest.projectAssignmentId,
    );
    assert.equal(
      accepted!.evidenceAssignmentId,
      firstRequest.evidenceAssignmentId,
    );
    assert.deepEqual(accepted!.requiredEvidence, firstRequest.requiredEvidence);
    assert.deepEqual(accepted!.localEvidence, []);

    assert.equal(
      readRequiredEvidenceSnapshot(LEAD_SESSION_ID, inherited),
      "accepted inherited plan",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    nativeSessions.delete(DEFAULT_PI_SESSION_ID);
    resetAgentMailbox(startup.mailbox);
    removeProjectAssignment(runtime, "repo-key", branch);
    realFs.rmSync(inherited.path, { force: true });
    realFs.rmSync(localFile, { force: true });
    realFs.rmSync(sessionPath, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("managed parent resumes its completed scoped child after normal cleanup with accepted evidence", async () => {
  const parentLabel = `resume-parent-${randomUUID().slice(0, 8)}`;
  const childLabel = `resume-child-${randomUUID().slice(0, 8)}`;
  const parentMailbox = agentMailboxPath(WORKSPACE, parentLabel);
  const parentSessionPath = join(PI_AGENT_ROOT, `${parentLabel}.jsonl`);
  const childSessionPath = resolve(tmpdir(), `${childLabel}.jsonl`);
  const parentSessionId = PARENT_SESSION_ID;
  const parentRequestId = randomUUID();
  const projectAssignmentId = LEAD_SESSION_ID;
  const authoritySocket = join(
    tmpdir(),
    `resume-authority-${randomUUID()}.sock`,
  );
  process.env.HERDR_SOCKET_PATH = authoritySocket;
  const authorityRuntime = supervisionRuntime(authoritySocket);
  const authorityBranch = `resume-${randomUUID()}`;
  const inherited = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "inherited-plan.md",
    "accepted inherited plan contents",
  );
  const local = persistRequiredEvidenceSnapshot(
    projectAssignmentId,
    "local-review.md",
    "accepted local review contents",
  );
  writeProjectAssignment(authorityRuntime, {
    version: 2,
    id: projectAssignmentId,
    repoKey: "repo-key",
    branch: authorityBranch,
    text: "Current parent project",
    requiredEvidence: [inherited],
  });
  const parent = {
    ...managedState(parentLabel, parentRequestId, {
      paneId: `parent-${randomUUID()}`,
      tabId: "parent-tab",
      piSessionId: parentSessionId,
      piSessionFile: parentSessionPath,
    }),
    projectAssignmentId,
  };
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  writeFileSync(
    join(PI_AGENTS_DIR, "agent.md"),
    "---\nname: agent\n---\nagent\n",
  );
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.PI_HERDSMAN_MAILBOX = parentMailbox;
  process.env.PI_HERDSMAN_RUN_ID = parent.runId;
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = parent.ownerSessionId;
  process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
  process.env.PI_HERDSMAN_LABEL = parentLabel;
  process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
  process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify(["agent"]);
  process.env.HERDR_PANE_ID = parent.paneId;

  const identity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: {
      sessionId: parentSessionId,
      definition: "agent",
      label: parentLabel,
    },
  };
  const parentEvidence = {
    type: "custom",
    customType: "pi-herdsman-agent-required-evidence",
    data: {
      version: 1,
      sessionId: parentSessionId,
      requestId: parentRequestId,
      runId: parent.runId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parentLabel,
      paneId: parent.paneId,
      projectAssignmentId,
      evidenceAssignmentId: parentRequestId,
      inheritedEvidence: [inherited],
      localEvidence: [local],
      currentEvidenceIds: [inherited.id],
    },
  };
  const parentEntries: any[] = [identity, parentEvidence];
  const lifecycle = delegatedLifecycleExecutor(parent, [], "/tmp", {
    paneId: "lead-pane",
    tabId: "lead-tab",
  });
  let accepted: RequestRecord | undefined;
  let childSessionId: string | undefined;
  let childStartCount = 0;
  let stopChildConsumer: (() => void) | undefined;
  let childContext: ReturnType<typeof fakeAgentContext> | undefined;
  let childRequestPump: ReturnType<typeof setInterval> | undefined;
  const baseExec = lifecycle.exec;
  const parentPi = fakePi({
    entries: parentEntries,
    persistMessages: true,
    exec: async (command, args, options) => {
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
      const result = baseExec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        const label = lifecycle.paneEnvironment.PI_HERDSMAN_LABEL;
        if (label === childLabel) {
          childStartCount++;
          if (childStartCount === 1) {
            const parentEnvironment = { ...process.env };
            childSessionId = CHILD_SESSION_ID;
            Object.assign(process.env, lifecycle.paneEnvironment);
            process.env.PI_HERDSMAN_MAILBOX = agentMailboxPath(
              WORKSPACE,
              childLabel,
            );
            process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
            process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = "[]";
            process.env.HERDR_PANE_ID = lifecycle.live.get(childLabel)!.paneId;
            const childEntries: any[] = [
              {
                type: "custom",
                customType: "pi-herdsman-agent-definition",
                data: {
                  sessionId: childSessionId,
                  definition: "agent",
                  label: childLabel,
                },
              },
            ];
            realFs.writeFileSync(
              childSessionPath,
              `${JSON.stringify({
                type: "session",
                version: 3,
                id: childSessionId,
                timestamp: new Date().toISOString(),
                cwd: "/tmp",
              })}\n${childEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
              "utf8",
            );
            nativeSessions.set(childSessionId, {
              id: childSessionId,
              path: childSessionPath,
              cwd: "/tmp",
              entries: childEntries,
            });
            childPi = fakePi({ entries: childEntries });
            registerExtension!(childPi.pi as never);
            childContext = fakeAgentContext(childEntries);
            childContext.sessionManager.getSessionId = () => childSessionId!;
            childContext.sessionManager.getSessionFile = () => childSessionPath;
            for (const handler of childPi.events.get("session_start") ?? [])
              await handler(undefined, childContext);
            const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
            childRequestPump = setInterval(() => {
              const request = readUnacknowledgedRequest(childMailbox);
              if (!request || !childPi || !childContext) return;
              accepted = request;
              if (childRequestPump) clearInterval(childRequestPump);
              const currentEnvironment = { ...process.env };
              Object.assign(process.env, lifecycle.paneEnvironment);
              process.env.PI_HERDSMAN_MAILBOX = childMailbox;
              process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
              process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = "[]";
              process.env.HERDR_PANE_ID =
                lifecycle.live.get(childLabel)!.paneId;
              childPi.events.get("input")![0](
                { text: controlMarker(request.requestId) },
                childContext,
              );
              for (const key of Object.keys(process.env))
                if (!(key in currentEnvironment)) delete process.env[key];
              Object.assign(process.env, currentEnvironment);
            }, 1);
            for (const key of Object.keys(process.env))
              if (!(key in parentEnvironment)) delete process.env[key];
            Object.assign(process.env, parentEnvironment);
          }
          if (childStartCount > 1 && childSessionId) {
            const current = lifecycle.live.get(childLabel)!;
            const sameSession = {
              ...current,
              piSessionId: childSessionId,
              piSessionFile: childSessionPath,
            };
            lifecycle.live.set(childLabel, sameSession);
            writeAgentState(
              agentMailboxPath(WORKSPACE, childLabel),
              sameSession,
            );
            const envelope = JSON.parse(result.stdout);
            envelope.result.agent.agent_session.value = childSessionId;
            result.stdout = JSON.stringify(envelope);
          }
          const mailbox = agentMailboxPath(WORKSPACE, childLabel);
          stopChildConsumer?.();
          stopChildConsumer = consumeMailboxRequest(mailbox, (request) => {
            accepted = request;
          });
        }
      }
      return result;
    },
  });
  registerExtension!(parentPi.pi as never);
  const parentContext = fakeAgentContext(parentEntries);
  parentContext.sessionManager.getSessionId = () => parentSessionId;
  parentContext.sessionManager.getSessionFile = () => parentSessionPath;
  parentContext.sessionManager.getBranch = () => parentEntries;
  let childPi: ReturnType<typeof fakePi> | undefined;
  try {
    await parentPi.events.get("session_start")![0](undefined, parentContext);
    const delegate = parentPi.tools.find(
      (tool) => tool.name === "delegate_agent",
    );
    const continuation = parentPi.tools.find(
      (tool) => tool.name === "continue_agent",
    );
    const persistToolResult = (toolName: string, result: any) =>
      parentContext.sessionManager.getEntries().push({
        type: "message",
        message: {
          role: "toolResult",
          toolName,
          details: result.details,
          ...(result.isError ? { isError: true } : {}),
        },
      });
    assert.ok(delegate);
    assert.ok(continuation);
    const delegated = await delegate.execute(
      "managed-parent-delegation",
      {
        definition: "agent",
        label: childLabel,
        task: "review plan",
        files: [local.path],
        retain: true,
      },
      undefined,
      undefined,
      parentContext,
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    persistToolResult("delegate_agent", delegated);
    assert.equal(delegated.details.session_id, childSessionId);
    assert.equal(delegated.details.session_path, childSessionPath);
    const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.equal(accepted!.ownerSessionId, parentSessionId);
    assert.equal(accepted!.projectAssignmentId, projectAssignmentId);
    assert.deepEqual(accepted!.requiredEvidence, [inherited, local]);
    assert.deepEqual(accepted!.currentEvidenceIds, [inherited.id]);
    assert.deepEqual(accepted!.localEvidence, [local]);
    assert.ok(
      accepted!.text.includes("accepted inherited plan contents") ||
        accepted!.text.includes("Current evidence — reference-only batch"),
      "nested Agent receives the current batch inline or as a truthful reference fallback",
    );
    const firstRequest = structuredClone(accepted!);
    const childState = readAgentState(childMailbox)!;
    assert.ok(childPi && childContext);
    const childEntries = childPi.entries as any[];
    childSessionId = childSessionId!;
    process.env.PI_HERDSMAN_MAILBOX = childMailbox;
    process.env.PI_HERDSMAN_RUN_ID = childState.runId;
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = childState.ownerSessionId;
    process.env.PI_HERDSMAN_OWNER_DISPLAY = `${parentLabel}:agent`;
    process.env.PI_HERDSMAN_LABEL = childLabel;
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = "[]";
    process.env.HERDR_PANE_ID = childState.paneId;
    const activeChildContext = childContext;
    const acceptedEvidence = childEntries.find(
      (entry) => entry?.customType === "pi-herdsman-agent-required-evidence",
    );
    assert.ok(acceptedEvidence, "child runtime persists accepted evidence");
    assert.equal(acceptedEvidence.data.requestId, firstRequest.requestId);
    const { createManagedAgentEvidenceUpdater } =
      await import("./managed-agent-runtime.ts");
    const updateEvidence = createManagedAgentEvidenceUpdater(
      childPi.pi as never,
    );
    const firstLocal = await updateEvidence(
      "remove-local-evidence",
      { text: "retain this local note" },
      undefined,
      undefined,
      activeChildContext,
    );
    const removedLocal = await updateEvidence(
      "add-local-evidence",
      { text: "remove this local note" },
      undefined,
      undefined,
      activeChildContext,
    );
    const removedItem = removedLocal.details.evidence.find(
      (item) =>
        !firstLocal.details.evidence.some(
          (previous) => previous.id === item.id,
        ),
    )!;
    await updateEvidence(
      "remove-local-evidence",
      { remove: [removedItem.id] },
      undefined,
      undefined,
      activeChildContext,
    );
    const updatedAcceptedEvidence = [...(childPi.entries as any[])]
      .reverse()
      .find(
        (entry) => entry?.customType === "pi-herdsman-agent-required-evidence",
      )!.data;
    assert.deepEqual(
      updatedAcceptedEvidence.currentEvidenceIds,
      [inherited.id],
      "local evidence retention preserves the inherited current batch",
    );
    for (const handler of childPi.events.get("agent_start") ?? [])
      await handler(undefined, activeChildContext);
    const control = childPi.events.get("input")![0](
      { text: controlMarker(firstRequest.requestId) },
      activeChildContext,
    );
    assert.ok(["handled", "transform"].includes(control.action));
    childPi.events.get("message_end")![0](
      { message: { role: "assistant", content: "Reviewed." } },
      activeChildContext,
    );
    await childPi.events.get("turn_end")![0](
      {
        outcome: "completed",
        message: { role: "assistant", content: "Reviewed." },
        messageEntryId: "review-result",
      },
      activeChildContext,
    );
    await childPi.events.get("agent_before_settle")![0](
      { outcome: "completed" },
      activeChildContext,
    );
    await childPi.events.get("agent_settled")![0](
      { aborted: false },
      activeChildContext,
    );
    for (
      let attempt = 0;
      attempt < 50 && !readResult(childMailbox, firstRequest.requestId);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      readResult(childMailbox, firstRequest.requestId)?.text,
      "Reviewed.",
      JSON.stringify({
        state: readAgentState(childMailbox),
        result: readResult(childMailbox, firstRequest.requestId),
        control,
      }),
    );
    for (
      let attempt = 0;
      attempt < 100 && realFs.existsSync(childMailbox);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      realFs.existsSync(childMailbox),
      false,
      "parent watcher should deliver and remove the child mailbox",
    );
    const terminal = parentEntries.find(
      (entry) => entry?.customType === "pi-herdsman-agent-result",
    );
    assert.ok(
      terminal,
      "registered managed parent persists child terminal result",
    );
    assert.equal(terminal.details.ownerSessionId, parentSessionId);
    assert.equal(terminal.details.requestId, firstRequest.requestId);
    assert.equal(terminal.details.runId, firstRequest.runId);
    assert.equal(terminal.details.piSessionId, childSessionId);
    assert.equal(terminal.details.piSessionFile, childSessionPath);

    let parentEntryId: string | null = null;
    const persistedChildEntries = childEntries.map((entry) => {
      const persisted = {
        ...entry,
        id: randomUUID(),
        parentId: parentEntryId,
        timestamp: new Date().toISOString(),
      };
      parentEntryId = persisted.id;
      return persisted;
    });
    realFs.writeFileSync(
      childSessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: childSessionId,
        timestamp: new Date().toISOString(),
        cwd: "/tmp",
      })}\n${persistedChildEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    process.env.PI_HERDSMAN_MAILBOX = parentMailbox;
    process.env.PI_HERDSMAN_RUN_ID = parent.runId;
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = parent.ownerSessionId;
    process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
    process.env.PI_HERDSMAN_LABEL = parentLabel;
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify([
      "agent",
    ]);
    process.env.HERDR_PANE_ID = parent.paneId;
    const resumed = await continuation.execute(
      "managed-parent-continuation",
      {
        session: childSessionPath,
        task: "continue with the same accepted plan",
      },
      undefined,
      undefined,
      parentContext,
    );
    assert.equal(resumed.details.ok, true, JSON.stringify(resumed.details));
    persistToolResult("continue_agent", resumed);
    assert.equal(resumed.details.session_id, childSessionId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(accepted);
    assert.notEqual(accepted!.requestId, firstRequest.requestId);
    assert.notEqual(accepted!.runId, firstRequest.runId);
    assert.equal(accepted!.ownerSessionId, parentSessionId);
    assert.equal(
      accepted!.projectAssignmentId,
      firstRequest.projectAssignmentId,
    );
    const retainedNote = firstLocal.details.evidence.find(
      (item) => item.id !== inherited.id && item.id !== local.id,
    )!;
    assert.deepEqual(accepted!.requiredEvidence, [
      inherited,
      local,
      retainedNote,
    ]);
    assert.deepEqual(accepted!.inheritedEvidence, [inherited]);
    assert.deepEqual(accepted!.localEvidence, [local, retainedNote]);
    assert.deepEqual(
      accepted!.currentEvidenceIds,
      [inherited.id],
      "continuation preserves access to the inherited current batch",
    );
    assert.ok(
      accepted!.localEvidence?.some((item) => item.id === retainedNote.id),
      "continued request retains the remaining local note",
    );
    assert.ok(
      !accepted!.localEvidence?.some((item) => item.id === removedItem.id),
      "continued request excludes the removed local note",
    );
    assert.ok(
      !accepted!.requiredEvidence.some((item) => item.id === removedItem.id),
      "removed local evidence is not revived in inherited evidence",
    );
    const interruptedState = readAgentState(childMailbox)!;
    const resultError = {
      code: "write_failure" as const,
      message: "simulated result persistence failure",
      requestId: accepted!.requestId,
      runId: accepted!.runId,
      ownerSessionId: accepted!.ownerSessionId,
      workspaceId: accepted!.workspaceId,
      agentLabel: accepted!.agentLabel,
      paneId: accepted!.paneId,
      originalStatus: "completed" as const,
      attempts: 1,
      failedAt: Date.now(),
      retrySafe: false as const,
      cleanupSafe: true as const,
      nextAction: "close the Agent before continuing",
    };
    writeAgentState(childMailbox, {
      ...interruptedState,
      activeRequestId: undefined,
      completedRequestId: undefined,
      resultError,
      updatedAt: Date.now(),
    });
    childEntries.push({
      type: "custom",
      customType: "pi-herdsman-agent-required-evidence",
      data: {
        version: 1,
        sessionId: childSessionId,
        requestId: accepted!.requestId,
        runId: accepted!.runId,
        ownerSessionId: accepted!.ownerSessionId,
        workspaceId: accepted!.workspaceId,
        agentLabel: accepted!.agentLabel,
        paneId: accepted!.paneId,
        projectAssignmentId: accepted!.projectAssignmentId,
        evidenceAssignmentId: accepted!.evidenceAssignmentId,
        inheritedEvidence: accepted!.inheritedEvidence ?? [],
        localEvidence: accepted!.localEvidence ?? [],
      },
    });
    let childEntryId: string | null = null;
    const latestSessionEntries = childEntries.map((entry) => {
      const persisted = {
        ...entry,
        id: randomUUID(),
        parentId: childEntryId,
        timestamp: new Date().toISOString(),
      };
      childEntryId = persisted.id;
      return persisted;
    });
    realFs.writeFileSync(
      childSessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: childSessionId,
        timestamp: new Date().toISOString(),
        cwd: "/tmp",
      })}\n${latestSessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const closed = await parentPi.tools
      .find((tool) => tool.name === "close_agent")!
      .execute(
        "close-after-result-error",
        { agent: childLabel },
        undefined,
        undefined,
        parentContext,
      );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(
      closed.details.closed_assignment.request_id,
      resultError.requestId,
    );
    persistToolResult("close_agent", closed);
    const continuedAfterClose = await continuation.execute(
      "continue-after-result-error-close",
      {
        session: childSessionId!,
        task: "continue without replaying the abandoned assignment",
      },
      undefined,
      undefined,
      parentContext,
    );
    assert.equal(
      continuedAfterClose.details.ok,
      true,
      JSON.stringify(continuedAfterClose.details),
    );
    assert.equal(continuedAfterClose.details.session_id, childSessionId);
    assert.notEqual(
      continuedAfterClose.details.request_id,
      resultError.requestId,
    );
    assert.equal(
      accepted!.evidenceAssignmentId,
      firstRequest.evidenceAssignmentId,
    );
    assert.equal(
      readRequiredEvidenceSnapshot(projectAssignmentId, inherited),
      "accepted inherited plan contents",
    );
    assert.equal(
      readRequiredEvidenceSnapshot(projectAssignmentId, local),
      "accepted local review contents",
    );
    assert.equal(
      readRequiredEvidenceSnapshot(
        firstRequest.evidenceAssignmentId,
        retainedNote,
      ),
      "retain this local note",
    );
  } finally {
    if (childRequestPump) clearInterval(childRequestPump);
    childPi?.events.get("session_shutdown")?.[0]();
    parentPi.events.get("session_shutdown")?.[0]();
    stopChildConsumer?.();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(agentMailboxPath(WORKSPACE, childLabel));
    nativeSessions.delete(CHILD_SESSION_ID);
    nativeSessions.delete("11111111-1111-4111-8111-111111111111");
    realFs.rmSync(inherited.path, { force: true });
    realFs.rmSync(local.path, { force: true });
    realFs.rmSync(parentSessionPath, { force: true });
    realFs.rmSync(childSessionPath, { force: true });
    removeProjectAssignment(authorityRuntime, "repo-key", authorityBranch);
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("continuation after a later unscoped assignment does not revive prior required evidence", async () => {
  setLeadEnvironment();
  const name = `unscoped-resume-${randomUUID().slice(0, 8)}`;
  const sessionId = DEFAULT_PI_SESSION_ID;
  const path = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const scopedRequestId = randomUUID();
  const unscopedRequestId = randomUUID();
  const scopedProjectId = randomUUID();
  const scopedEvidenceId = randomUUID();
  const plan = persistRequiredEvidenceSnapshot(
    scopedProjectId,
    "old-plan.md",
    "obsolete plan must not return",
  );
  const review = persistRequiredEvidenceSnapshot(
    scopedProjectId,
    "old-review.md",
    "obsolete review must not return",
  );
  const state = managedState(name);
  const currentState = {
    ...state,
    piSessionId: sessionId,
    piSessionFile: path,
    agentDefinition: name,
    completedRequestId: unscopedRequestId,
    projectAssignmentId: undefined,
    lastAck: {
      requestId: unscopedRequestId,
      accepted: true,
      acknowledgedAt: Date.now(),
    },
  };
  const session = {
    id: sessionId,
    path,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId, definition: name, label: name },
      },
      {
        type: "custom",
        customType: "pi-herdsman-agent-required-evidence",
        data: {
          version: 1,
          sessionId,
          requestId: scopedRequestId,
          runId: state.runId,
          ownerSessionId: state.ownerSessionId,
          workspaceId: state.workspaceId,
          agentLabel: name,
          paneId: state.paneId,
          projectAssignmentId: scopedProjectId,
          evidenceAssignmentId: scopedEvidenceId,
          inheritedEvidence: [plan],
          localEvidence: [review],
        },
      },
      {
        type: "custom",
        customType: "pi-herdsman-agent-required-evidence",
        data: {
          version: 1,
          sessionId,
          requestId: unscopedRequestId,
          runId: state.runId,
          ownerSessionId: state.ownerSessionId,
          workspaceId: state.workspaceId,
          agentLabel: name,
          paneId: state.paneId,
          inheritedEvidence: [],
          localEvidence: [],
        },
      },
      // A stale scoped entry after the clearing marker must not override mailbox identity.
      {
        type: "custom",
        customType: "pi-herdsman-agent-required-evidence",
        data: {
          version: 1,
          sessionId,
          requestId: randomUUID(),
          runId: state.runId,
          ownerSessionId: state.ownerSessionId,
          workspaceId: state.workspaceId,
          agentLabel: name,
          paneId: state.paneId,
          projectAssignmentId: scopedProjectId,
          evidenceAssignmentId: scopedEvidenceId,
          inheritedEvidence: [plan],
          localEvidence: [review],
        },
      },
    ],
  };
  writeValidPiSessionFile(session);
  realFs.writeFileSync(promptPath, "saved prompt", "utf8");
  writePromptDefinition(definitionPath, name, promptPath);
  nativeSessions.set(sessionId, session);
  const savedMailbox = agentMailboxPath(WORKSPACE, name);
  resetAgentMailbox(savedMailbox);
  writeAgentState(savedMailbox, currentState);
  let continued: RequestRecord | undefined;
  const startup = startupExecutor(
    name,
    () => sessionId,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    false,
    false,
    (request) => {
      continued = request;
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    resetAgentMailbox(savedMailbox);
    const missingAuthority = await registeredAgentTool(pi, "continue").execute(
      "reject-missing-scoped-history",
      { session: path, task: "must fail closed" },
      undefined,
      undefined,
      ownedSessionContext(sessionId, name),
    );
    assert.equal(
      missingAuthority.details.ok,
      false,
      JSON.stringify(missingAuthority.details),
    );
    assert.equal(missingAuthority.details.error?.category, "invalid_request");
    assert.match(
      missingAuthority.details.error.message,
      /Cannot verify the current accepted assignment/,
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
    writeAgentState(savedMailbox, currentState);
    const result = await registeredAgentTool(pi, "continue").execute(
      "continue-after-unscoped",
      { session: path, task: "continue unrelated work" },
      undefined,
      undefined,
      ownedSessionContext(sessionId, name),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(continued);
    assert.equal(continued!.projectAssignmentId, undefined);
    assert.equal(continued!.evidenceAssignmentId, undefined);
    assert.equal(continued!.requiredEvidence, undefined);
    assert.doesNotMatch(continued!.text, /obsolete plan|obsolete review/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    nativeSessions.delete(sessionId);
    resetAgentMailbox(startup.mailbox);
    resetAgentMailbox(savedMailbox);
    realFs.rmSync(path, { force: true });
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(plan.path, { force: true });
    realFs.rmSync(review.path, { force: true });
  }
});

test("ordinary unscoped accepted session continues after mailbox cleanup", async () => {
  setLeadEnvironment();
  const name = `unscoped-retired-${randomUUID().slice(0, 8)}`;
  const sessionId = DEFAULT_PI_SESSION_ID;
  const path = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const requestId = randomUUID();
  const state = managedState(name);
  const markerData = {
    version: 1,
    sessionId,
    requestId,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: name,
    paneId: state.paneId,
    inheritedEvidence: [] as ReturnType<
      typeof persistRequiredEvidenceSnapshot
    >[],
    localEvidence: [],
  };
  const session = {
    id: sessionId,
    path,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId, definition: name, label: name },
      },
      {
        type: "custom",
        customType: "pi-herdsman-agent-required-evidence",
        data: markerData,
      },
    ],
  };
  writeValidPiSessionFile(session);
  realFs.writeFileSync(promptPath, "saved prompt", "utf8");
  writePromptDefinition(definitionPath, name, promptPath);
  nativeSessions.set(sessionId, session);
  const savedMailbox = agentMailboxPath(WORKSPACE, name);
  resetAgentMailbox(savedMailbox); // Normal cleanup leaves no authoritative mailbox state.
  let continued: RequestRecord | undefined;
  const startup = startupExecutor(
    name,
    () => sessionId,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    false,
    false,
    (request) => {
      continued = request;
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  let malformedEvidence:
    ReturnType<typeof persistRequiredEvidenceSnapshot> | undefined;
  try {
    malformedEvidence = persistRequiredEvidenceSnapshot(
      randomUUID(),
      "malformed.txt",
      "must not be ignored",
    );
    markerData.inheritedEvidence = [malformedEvidence];
    writeValidPiSessionFile(session);
    const malformed = await registeredAgentTool(pi, "continue").execute(
      "reject-malformed-unscoped",
      { session: path, task: "must fail closed" },
      undefined,
      undefined,
      ownedSessionContext(sessionId, name),
    );
    assert.equal(
      malformed.details.ok,
      false,
      JSON.stringify(malformed.details),
    );
    assert.equal(malformed.details.error?.category, "invalid_request");
    assert.match(
      malformed.details.error.message,
      /malformed required-evidence metadata/,
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
    markerData.inheritedEvidence = [];
    writeValidPiSessionFile(session);
    const result = await registeredAgentTool(pi, "continue").execute(
      "continue-retired-unscoped",
      { session: path, task: "continue ordinary work" },
      undefined,
      undefined,
      ownedSessionContext(sessionId, name),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(continued);
    assert.equal(continued!.projectAssignmentId, undefined);
    assert.equal(continued!.requiredEvidence, undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    nativeSessions.delete(sessionId);
    resetAgentMailbox(startup.mailbox);
    resetAgentMailbox(savedMailbox);
    realFs.rmSync(path, { force: true });
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    if (malformedEvidence)
      realFs.rmSync(malformedEvidence.path, { force: true });
  }
});

test("session continuation ignores an unrelated missing live session path", async () => {
  setLeadEnvironment();
  const name = `stale-live-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const staleLabel = `${name}-stale`;
  const staleExpectedPath = join(PI_AGENT_ROOT, `${name}-stale.jsonl`);
  const staleObservedPath = join(PI_AGENT_ROOT, `${name}-deleted.jsonl`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: staleExpectedPath,
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: staleObservedPath,
    },
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nmissing live session test\n`,
  );
  writeValidPiSessionFile(session);
  realFs.writeFileSync(staleExpectedPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  let started = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args) && !started)
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [staleAgent], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        started = true;
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "continue" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.session_id, session.id);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      true,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(staleExpectedPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session continuation keeps an exact live ID busy despite a missing path observation", async () => {
  setLeadEnvironment();
  const name = `stale-secondary-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const staleObservedPath = join(PI_AGENT_ROOT, `${name}-deleted.jsonl`);
  const staleLabel = `${name}-stale`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-stale.jsonl`),
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: session.id,
    },
    session_path: staleObservedPath,
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact live ID with stale path test\n`,
  );
  writeValidPiSessionFile(session);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [staleAgent], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(result.details.error.category, "agent_busy");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session continuation keeps an exact live ID busy despite contradictory live observations", async () => {
  setLeadEnvironment();
  const name = `contradictory-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const unrelatedObservedPath = join(PI_AGENT_ROOT, `${name}-other.jsonl`);
  const staleLabel = `${name}-stale`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-stale.jsonl`),
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: session.id,
    },
    session_id: "22222222-2222-4222-8222-222222222222",
    session_path: unrelatedObservedPath,
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact live ID with contradictory observations test\n`,
  );
  writeValidPiSessionFile(session);
  realFs.writeFileSync(unrelatedObservedPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [staleAgent], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(
      result.details.error.category,
      "agent_busy",
      JSON.stringify(result.details),
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(unrelatedObservedPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session continuation ignores removed secondary session fields", async () => {
  setLeadEnvironment();
  const name = `error-live-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const notDirectoryPath = join(PI_AGENT_ROOT, `${name}-not-directory`);
  const staleObservedPath = `${notDirectoryPath}/deleted.jsonl`;
  const staleExpectedPath = join(PI_AGENT_ROOT, `${name}-stale.jsonl`);
  const staleLabel = `${name}-stale`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: staleExpectedPath,
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: session.id,
    },
    session_path: staleObservedPath,
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nlive session path error test\n`,
  );
  writeValidPiSessionFile(session);
  realFs.writeFileSync(notDirectoryPath, "not a directory", "utf8");
  realFs.writeFileSync(staleExpectedPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  let started = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args) && !started)
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [staleAgent], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        started = true;
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(result.details.error.category, "agent_busy");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(notDirectoryPath, { force: true });
    realFs.rmSync(staleExpectedPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session continuation fails closed on an unrelated malformed persisted mailbox path", async () => {
  setLeadEnvironment();
  const name = `error-resume-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const invalidPersistedPath = `${join(
    PI_AGENT_ROOT,
    `${name}-invalid-session`,
  )}\u0000/session.jsonl`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: `${name}-agent`,
        },
      },
    ],
  };
  const identity = {
    ...recoveryIdentity(label),
    piSessionId: session.id,
    piSessionFile: session.path,
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\npersisted path error test\n`,
  );
  writeValidPiSessionFile(session);
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  // A regular-file child is ENOENT on Windows and intentionally treated as
  // stale; the NUL path is the host-independent malformed input rejected by
  // realpathSync without adding a platform-specific mock seam.
  // Continuation scans all managed states and fails closed on malformed
  // persisted paths, even when the malformed state is unrelated to the target.
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: invalidPersistedPath,
  });
  const startup = startupExecutor(label, () => session.id);
  const pi = fakePi({
    exec: leadExec(label, "idle", session.id, undefined, session.id, identity),
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    await assert.rejects(
      registeredAgentTool(pi, "continue").execute(
        "id",
        { session: sessionPath, task: "must fail closed" },
        undefined,
        undefined,
        ownedSessionContext(session.id, label),
      ),
      (error: unknown) => {
        assert.match(String(error), /could not canonicalize/);
        return true;
      },
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("rejects known generated-label envelope overflow before startup", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  realFs.rmSync(startup.mailbox, { recursive: true, force: true });
  const mailboxLimit = 64 * 1024;
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  realFs.writeFileSync(
    join(PI_AGENT_ROOT, "pi-herdsman", "config.json"),
    JSON.stringify({ mailboxPayloadLimitBytes: mailboxLimit }),
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const emptyEnvelope = requestRecordBytes(label, "", "");
  const task = "x".repeat(mailboxLimit - emptyEnvelope + 1);
  assert.equal(requestRecordBytes(label, "", task) > mailboxLimit, true);
  assert.equal(
    requestRecordBytes(label, "", task) <= MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", task },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.notEqual(result.details.error.rollbackOccurred, true);
    assert.equal(startup.getCount(), 0);
    assert.equal(realFs.existsSync(startup.mailbox), false);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("revalidates automatic-label collision sizing before startup", async () => {
  setLeadEnvironment();
  const occupiedLabel = "agent";
  const occupiedMailbox = agentMailboxPath(WORKSPACE, occupiedLabel);
  const replacementMailbox = agentMailboxPath(WORKSPACE, "agent-2");
  const occupiedState = managedState(occupiedLabel);
  const pi = fakePi({
    exec: leadExec("other-agent", "idle", DEFAULT_PI_SESSION_ID),
  });
  registerExtension!(pi.pi as never);
  realFs.rmSync(replacementMailbox, { recursive: true, force: true });
  writeAgentState(occupiedMailbox, occupiedState);
  writeRequest(occupiedMailbox, {
    version: 5,
    runId: occupiedState.runId,
    requestId: REQUEST_ID,
    ownerSessionId: occupiedState.ownerSessionId,
    workspaceId: occupiedState.workspaceId,
    agentLabel: occupiedState.agentLabel,
    paneId: occupiedState.paneId,
    kind: "task",
    text: "occupied request",
    createdAt: Date.now(),
  });
  const occupiedSnapshot = readFileSync(
    `${occupiedMailbox}/state.json`,
    "utf8",
  );
  const initialEnvelope = requestRecordBytes(occupiedLabel, "", "");
  // This fits the initial `agent` identity but exceeds the envelope after
  // the collision selects `agent-2`.
  const task = "x".repeat(MAILBOX_PROTOCOL_LIMIT_BYTES - initialEnvelope);
  assert.equal(
    requestRecordBytes(occupiedLabel, "", task) <= MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  assert.equal(
    requestRecordBytes("agent-2", "", task) > MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", task },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.notEqual(result.details.error.rollbackOccurred, true);
    assert.equal(
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "start")
        .length,
      0,
    );
    assert.equal(realFs.existsSync(replacementMailbox), false);
    assert.equal(
      readFileSync(`${occupiedMailbox}/state.json`, "utf8"),
      occupiedSnapshot,
    );
    assert.ok(readRequest(occupiedMailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(occupiedMailbox);
    resetAgentMailbox(replacementMailbox);
  }
});

test("fresh mailbox claim collision retries without touching the occupied mailbox", async () => {
  setLeadEnvironment();
  const occupiedMailbox = agentMailboxPath(WORKSPACE, "agent");
  const replacementMailbox = agentMailboxPath(WORKSPACE, "agent-2");
  resetAgentMailbox(occupiedMailbox);
  resetAgentMailbox(replacementMailbox);
  const releaseOccupiedClaim = claimAgentMailbox(occupiedMailbox);
  const occupiedContents = realFs.readdirSync(occupiedMailbox).sort();
  const startup = startupExecutor("agent-2", () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", task: "retry after claim collision" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error, undefined);
    assert.equal(startup.getCount(), 2);
    assert.deepEqual(
      realFs.readdirSync(occupiedMailbox).sort(),
      occupiedContents,
    );
    assert.equal(readAgentState(occupiedMailbox), undefined);
    assert.equal(readRequest(occupiedMailbox, REQUEST_ID), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    releaseOccupiedClaim();
    resetAgentMailbox(occupiedMailbox);
    resetAgentMailbox(replacementMailbox);
  }
});

test("lost mailbox labels remain reserved until explicit close", async () => {
  setLeadEnvironment();
  const label = "lost-reserved-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = managedState(label, REQUEST_ID, recoveryIdentity(label));
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  const pi = fakePi({ exec: cascadeExecutor([]).exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "replace" },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.error.category, "agent_label_exists");
    assert.ok(readAgentState(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("rolls back fresh assignment when the authoritative pane makes the request too large", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const label = "agent";
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    false,
    true,
  );
  realFs.rmSync(startup.mailbox, { recursive: true, force: true });
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  await pi.events.get("session_start")![0](undefined, context);
  const preflightEnvelope = requestRecordBytes(label, "", "");
  const task = "x".repeat(131072 - preflightEnvelope);
  assert.equal(requestRecordBytes(label, "", task) <= 131072, true);
  assert.equal(requestRecordBytes(label, "startup-pane", task) > 131072, true);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "rollback_failure");
    assert.equal(result.details.error.rollbackOccurred, true);
    assert.ok(startup.getCount() > 0, "overflow must reach authoritative pane");
    assert.deepEqual(
      realFs.existsSync(startup.mailbox)
        ? realFs.readdirSync(startup.mailbox)
        : [],
      ["state.json"],
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }

  const reuse = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const reusePi = fakePi({ exec: reuse.exec });
  registerExtension!(reusePi.pi as never);
  const reuseContext = fakeContext(reusePi.entries);
  try {
    await reusePi.events.get("session_start")![0](undefined, reuseContext);
    const result = await registeredAgentTool(reusePi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "retry after rollback",
      },
      undefined,
      undefined,
      reuseContext,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    reusePi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(reuse.mailbox);
  }
});

test("rejects invalid assignment prerequisites before lifecycle mutation", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  const callsAfterActivation = pi.calls.length;
  const cases = [
    {
      operation: "delegate",
      params: {},
      message: "delegate requires definition",
    },
    {
      operation: "continue",
      params: { task: "missing session" },
      message: "continue requires session",
    },
    {
      operation: "delegate",
      params: { definition: " \t", task: " \t" },
      message: "Agent definition  \t was not found",
    },
    {
      operation: "delegate",
      params: { definition: "agent" },
      message: "delegate requires task",
    },
    {
      operation: "delegate",
      params: { definition: "agent", task: " \t" },
      message: "Message must not be empty",
    },
  ];

  for (const { operation, params, message } of cases) {
    const result = await registeredAgentTool(pi, operation).execute(
      "id",
      params,
      undefined,
      undefined,
      fakeContext(pi.entries),
    );

    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.message, message);
    assert.ok(
      pi.calls
        .slice(callsAfterActivation)
        .every(
          (args) =>
            (args[0] === "status" && args[1] === "--json") ||
            isApiSnapshot(args),
        ),
      `invalid assignment prerequisite made unexpected calls: ${JSON.stringify(pi.calls.slice(callsAfterActivation))}`,
    );
  }
});

test("delegate keeps an explicit human-readable label", async () => {
  setLeadEnvironment();
  const label = "review-map";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "map" },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.agent, label);
    assert.equal(readAgentState(startup.mailbox)?.agentLabel, label);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }
});

test("rejects an invalid generated collision label after releasing its claim", async () => {
  setLeadEnvironment();
  const label = "a" + "b".repeat(31);
  const definitionPath = join(PI_AGENTS_DIR, `${label}.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const visibleMailbox = agentMailboxPath(WORKSPACE, "other-agent");
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${label}\n---\nlong-name collision test\n`,
  );
  writeAgentState(visibleMailbox, managedState("other-agent"));
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: JSON.parse(listResponse("other-agent")).agents,
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: DEFAULT_PI_SESSION_ID,
                    },
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  const context = fakeContext(pi.entries);
  context.isProjectTrusted = () => {
    // Simulate the mailbox becoming visible after the assignment snapshot.
    writeAgentState(mailbox, managedState(label));
    return true;
  };

  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: label,
        task: "reject the oversized generated collision label",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.operation, "delegate");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /Agent label must start/);
    assert.equal(realFs.existsSync(join(mailbox, ".starting")), false);
    assert.equal(
      pi.calls.some((args) => args[0] === "pane"),
      false,
      "generated-label rejection must not mutate Herdr topology",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
    realFs.rmSync(visibleMailbox, { recursive: true, force: true });
    realFs.unlinkSync(definitionPath);
  }
});

test("assignment launch handles delayed official Pi session identity", async () => {
  const expectedSession = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const cases = [
    {
      label: "delayed-session-agent",
      task: "delayed identity",
      session: (count: number) => (count < 3 ? null : expectedSession),
      expectedCount: 4,
      retry: false,
    },
    {
      label: "null-session-agent",
      task: "retry null identity",
      session: (count: number) => (count === 1 ? null : expectedSession),
      expectedCount: 3,
      retry: true,
    },
  ];

  for (const { label, task, session, expectedCount, retry } of cases) {
    setLeadEnvironment();
    const startup = startupExecutor(
      label,
      session,
      undefined,
      undefined,
      retry,
    );
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    seedLeadRole(fakeContext(pi.entries));
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries),
    );
    try {
      const result = await registeredAgentTool(pi, "delegate").execute(
        "id",
        { definition: "agent", label, task },
        undefined,
        undefined,
        fakeContext(pi.entries),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(startup.getCount(), expectedCount);
      assert.equal(result.details.session_id, expectedSession);
      if (!retry)
        assert.equal(
          pi.calls.some((args) => isPreservePaneStop(args)),
          false,
        );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  }
});

test("managed startup accepts matching mailbox state after five seconds", async (t) => {
  setLeadEnvironment();
  const label = "delayed-mailbox-startup";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const abort = new AbortController();
  let delayedState: ManagedAgentState | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  const pi = fakePi({
    exec: async (command, args, options) => {
      const result = await startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        delayedState = readAgentState(startup.mailbox);
        assert.ok(delayedState);
        realFs.rmSync(startup.mailbox, { recursive: true, force: true });
        if (!abort.signal.aborted)
          restoreTimer = setTimeout(
            () => writeAgentState(startup.mailbox, delayedState!),
            6_000,
          );
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  let pending:
    ReturnType<ReturnType<typeof registeredAgentTool>["execute"]> | undefined;
  try {
    pending = registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "wait for delayed mailbox state" },
      abort.signal,
      undefined,
      fakeContext(pi.entries),
    );
    void pending.catch(() => {});
    await t.waitFor(() => assert.ok(delayedState, "agent start did not run"), {
      timeout: 5_000,
    });
    const result = await pending;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    abort.abort();
    if (restoreTimer) clearTimeout(restoreTimer);
    if (pending) await pending.catch(() => {});
    startup.stopMailboxConsumer();
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }
});

async function exerciseStartupLock(t: TestContext, failObservation = false) {
  setLeadEnvironment();
  const label = failObservation
    ? "startup-lock-failure-cleanup"
    : "startup-lock-held";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const abort = new AbortController();
  let releaseChildLock: (() => void) | undefined;
  let agentGetCount = 0;
  const pi = fakePi({
    exec: async (command, args, options) => {
      const result = await startup.exec(command, args, options);
      if (
        command === "herdr" &&
        args[0] === "agent" &&
        args[1] === "start" &&
        !abort.signal.aborted
      )
        releaseChildLock = claimProcessLock(
          assignmentLockPathForTest(startup.mailbox),
        );
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        agentGetCount++;
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  let pending:
    ReturnType<ReturnType<typeof registeredAgentTool>["execute"]> | undefined;
  let observationError: unknown;
  let injectedObservationFailure = false;
  try {
    pending = registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "wait for child startup lock" },
      abort.signal,
      undefined,
      fakeContext(pi.entries),
    );
    void pending.catch(() => {});
    try {
      await t.waitFor(
        () => {
          assert.ok(releaseChildLock, "child did not hold its startup lock");
          assert.ok(
            agentGetCount >= 2,
            "initial submit must finish integration validation before acquiring the held lock",
          );
        },
        { timeout: 5_000 },
      );
    } catch (error) {
      t.diagnostic(
        `startup lock held=${Boolean(releaseChildLock)}, ` +
          `agent get count=${agentGetCount}`,
      );
      throw error;
    }
    if (failObservation) {
      try {
        await t.waitFor(
          () => {
            injectedObservationFailure = true;
            assert.fail("injected startup observation failure");
          },
          { timeout: 20 },
        );
      } catch (error) {
        observationError = error;
      }
      if (!observationError) throw new Error("observation unexpectedly passed");
    } else {
      releaseChildLock?.();
      releaseChildLock = undefined;
      const result = await pending;
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
    }
  } finally {
    abort.abort();
    releaseChildLock?.();
    if (pending) await pending.catch(() => {});
    startup.stopMailboxConsumer();
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }
  return {
    mailbox: startup.mailbox,
    observationError,
    injectedObservationFailure,
  };
}

test("managed startup waits for the child assignment lock before first submit", async (t) => {
  await exerciseStartupLock(t);
});

test("managed startup cleanup releases delegation lock after observation failure", async (t) => {
  const { mailbox, observationError, injectedObservationFailure } =
    await exerciseStartupLock(t, true);
  assert.equal(injectedObservationFailure, true);
  assert.match(String(observationError), /waitFor\(\) timed out/);
  const releaseDelegationLock = claimProcessLock(
    delegationLockPathForTest(WORKSPACE, LEAD_SESSION_ID),
  );
  releaseDelegationLock();
  assert.equal(
    readAgentState(mailbox),
    undefined,
    "fixture cleanup must leave no mailbox state after delegation settles",
  );
});

test("managed startup rejects a mismatched Agent before its first task and rolls back", async () => {
  setLeadEnvironment();
  const label = "incompatible-startup";
  let taskAccepted = false;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    () => {
      taskAccepted = true;
    },
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  let started = false;
  let stopped = false;
  const pi = fakePi({
    exec: async (command, args, options) => {
      if (command === "herdr" && isPreservePaneStop(args)) stopped = true;
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              process_info: {
                pane_id: "startup-pane",
                shell_pid: 123,
                foreground_process_group_id: started && !stopped ? 999 : 123,
                foreground_processes:
                  started && !stopped
                    ? [
                        { pid: 123, argv0: "/bin/zsh" },
                        { pid: 999, argv0: "/usr/local/bin/pi" },
                      ]
                    : [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      const result = await startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        started = true;
        const state = readAgentState(startup.mailbox)!;
        writeAgentState(startup.mailbox, {
          ...state,
          build: OTHER_HERDSMAN_BUILD,
        });
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "must not be submitted" },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(
      result.details.error.category,
      "incompatible_build",
      JSON.stringify(result.details.error),
    );
    assert.match(
      result.details.error.nextAction,
      /session that remained running/i,
    );
    assert.match(
      result.details.error.nextAction,
      /any still-running target session/i,
    );
    assert.doesNotMatch(
      result.details.error.nextAction,
      /restart both this session and Agent /i,
    );
    assert.doesNotMatch(result.details.error.nextAction, /^Restart Lead /);
    assert.equal(taskAccepted, false);
    assert.equal(
      pi.calls.some((args) => isPreservePaneStop(args)),
      true,
      "incompatible newly-started Agent should be rolled back",
    );
    assert.equal(readAgentState(startup.mailbox), undefined);
  } finally {
    startup.stopMailboxConsumer();
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }
});

test(
  "pane-not-ready failure retains bounded startup diagnostic and rolls back",
  { timeout: 40_000 },
  async () => {
    setLeadEnvironment();
    const label = "pane-not-ready-diagnostic";
    const startup = startupExecutor(
      label,
      () => DEFAULT_PI_SESSION_ID,
      undefined,
      undefined,
      false,
      undefined,
      "/tmp",
      AGENT_ID,
      false,
      true,
    );
    const diagnostic = "startup diagnostic\n".repeat(500);
    const operationController = new AbortController();
    let processInfoTimeout: number | undefined;
    let processInfoSignal: AbortSignal | undefined;
    let paneReadSeen = false;
    let diagnosticProcessAttempted = false;
    const pi = fakePi({
      exec: async (command, args, options) => {
        if (
          command === "herdr" &&
          args[0] === "pane" &&
          args[1] === "process-info" &&
          paneReadSeen &&
          !diagnosticProcessAttempted
        ) {
          diagnosticProcessAttempted = true;
          processInfoTimeout = options?.timeout;
          processInfoSignal = options?.signal;
          return {
            stdout: JSON.stringify({
              id: 1,
              result: {
                process_info: {
                  pane_id: args[3],
                  shell_pid: 123,
                  foreground_processes: [
                    {
                      pid: 123,
                      argv0: "/bin/zsh",
                      state: "running",
                      cmdline: "secret argument",
                      arbitrary: "must not escape",
                    },
                  ],
                },
              },
            }),
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        const result = await startup.exec(command, args, options);
        if (command === "herdr" && args[0] === "agent" && args[1] === "start")
          realFs.rmSync(startup.mailbox, { recursive: true, force: true });
        if (command === "herdr" && args[0] === "pane" && args[1] === "read") {
          paneReadSeen = true;
          operationController.abort();
          return { stdout: diagnostic, stderr: "", code: 0, killed: false };
        }
        return result;
      },
    });
    registerExtension!(pi.pi as never);
    seedLeadRole(fakeContext(pi.entries));
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries),
    );
    try {
      const result = await registeredAgentTool(pi, "delegate").execute(
        "id",
        { definition: "agent", label, task: "capture startup diagnostics" },
        operationController.signal,
        undefined,
        fakeContext(pi.entries),
      );
      assert.equal(
        result.details.error.category,
        "pane_not_ready",
        JSON.stringify(result.details),
      );
      const attachedDiagnostic = result.details.error.details.startupDiagnostic;
      assert.ok(Buffer.byteLength(attachedDiagnostic) <= 4096);
      assert.ok(attachedDiagnostic.endsWith("startup diagnostic"));
      const processSnapshot = result.details.error.details.startupProcess;
      assert.deepEqual(processSnapshot, {
        pane_id: result.details.error.ids.paneId,
        shell_pid: 123,
        foreground_processes: [{ argv0: "/bin/zsh", state: "running" }],
      });
      assert.equal(processInfoTimeout, 2_000);
      assert.equal(operationController.signal.aborted, true);
      assert.equal(processInfoSignal, undefined);
      assert.equal(diagnosticProcessAttempted, true);
      const reads = pi.calls.filter(
        (args) => args[0] === "pane" && args[1] === "read",
      );
      assert.equal(reads.length, 1);
      assert.deepEqual(reads[0]?.slice(-2), ["--lines", "40"]);
      assert.equal(
        pi.calls.some(
          (args) =>
            isPreservePaneStop(args) || isPaneClose(args) || isTabClose(args),
        ),
        true,
      );
      assert.equal(readAgentState(startup.mailbox), undefined);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  },
);

test(
  "pane process diagnostic failure is optional and does not prevent rollback",
  { timeout: 40_000 },
  async () => {
    setLeadEnvironment();
    const label = "pane-not-ready-process-failure";
    const startup = startupExecutor(
      label,
      () => DEFAULT_PI_SESSION_ID,
      undefined,
      undefined,
      false,
      undefined,
      "/tmp",
      AGENT_ID,
      false,
      true,
    );
    let paneReadSeen = false;
    let diagnosticProcessAttempted = false;
    const pi = fakePi({
      exec: async (command, args, options) => {
        if (
          command === "herdr" &&
          args[0] === "pane" &&
          args[1] === "process-info" &&
          paneReadSeen &&
          !diagnosticProcessAttempted
        ) {
          diagnosticProcessAttempted = true;
          return { stdout: "", stderr: "unavailable", code: 1, killed: false };
        }
        const result = await startup.exec(command, args, options);
        if (command === "herdr" && args[0] === "agent" && args[1] === "start")
          realFs.rmSync(startup.mailbox, { recursive: true, force: true });
        if (command === "herdr" && args[0] === "pane" && args[1] === "read") {
          paneReadSeen = true;
          return { stdout: "pane output", stderr: "", code: 0, killed: false };
        }
        return result;
      },
    });
    registerExtension!(pi.pi as never);
    seedLeadRole(fakeContext(pi.entries));
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries),
    );
    try {
      const result = await registeredAgentTool(pi, "delegate").execute(
        "id",
        { definition: "agent", label, task: "optional process diagnostic" },
        undefined,
        undefined,
        fakeContext(pi.entries),
      );
      assert.equal(result.details.error.category, "pane_not_ready");
      assert.equal(
        result.details.error.message,
        "Agent did not initialize its mailbox",
      );
      assert.equal(
        result.details.error.details.startupDiagnostic,
        "pane output",
      );
      assert.equal("startupProcess" in result.details.error.details, false);
      assert.equal(diagnosticProcessAttempted, true);
      assert.equal(
        pi.calls.some(
          (args) =>
            isPreservePaneStop(args) || isPaneClose(args) || isTabClose(args),
        ),
        true,
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  },
);

test("empty early launch cleans exact resources and same-label retry creates one agent", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startup = startupExecutor(
    label,
    () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  );
  let starts = 0;
  let splits = 0;
  let closes = 0;
  let tabCloses = 0;
  let panePresent = false;
  let closeProvedByList = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isPaneList(args)) {
        if ((closes > 0 || tabCloses > 0) && !panePresent)
          closeProvedByList = true;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                ...(panePresent
                  ? [
                      {
                        pane_id: "startup-pane",
                        tab_id: "startup-tab",
                        workspace_id: WORKSPACE,
                        terminal_id: "startup-terminal",
                        cwd: "/tmp",
                        foreground_cwd: "/tmp",
                        agent_status: "unknown",
                      },
                    ]
                  : []),
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
        panePresent = true;
        return startup.exec(command, args, options);
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        assert.equal(panePresent, false);
        panePresent = true;
        splits++;
        return startup.exec(command, args, options);
      }
      if (command === "herdr" && isPaneClose(args)) {
        assert.equal(panePresent, true);
        assert.equal(args[2], "startup-pane");
        panePresent = false;
        closes++;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "tab" && args[1] === "close") {
        assert.equal(panePresent, true);
        panePresent = false;
        tabCloses++;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && isTabList(args) && tabCloses > 0)
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { tabs: [] } }),
          stderr: "",
          code: 0,
        };
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              process_info: {
                pane_id: args[3],
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        starts++;
        if (starts === 1) return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "read")
        return {
          stdout: "Unknown extension: /tmp/broken-extension.ts",
          stderr: "",
          code: 0,
          killed: false,
        };
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  const tool = registeredAgentTool(pi, "delegate");
  const context = fakeContext(pi.entries);
  const failed = await tool.execute(
    "id",
    { definition: "agent", label, task: "first attempt" },
    undefined,
    undefined,
    context,
  );
  assert.equal(failed.details.error.category, "internal_failure");
  assert.equal(failed.details.error.details.stage, "agent_start");
  assert.equal(failed.details.error.details.result.classification, "empty");
  assert.equal(failed.details.error.details.paneSnapshotAttempted, true);
  assert.equal(failed.details.error.details.paneSnapshotStatus, "captured");
  assert.equal(failed.details.error.details.paneSnapshotReason, undefined);
  assert.ok(failed.details.error.details.paneSnapshot.length <= 8192);
  assert.match(
    failed.details.error.message,
    /Unknown extension.*broken-extension/,
  );
  assert.equal(failed.details.error.ids.paneId, "startup-pane");
  assert.equal(failed.details.error.ids.tabId, "startup-tab");
  assert.equal(readAgentState(startup.mailbox), undefined);
  assert.equal(
    pi.calls.filter((args) => args[0] === "pane" && args[1] === "read").length,
    1,
  );
  assert.equal(tabCloses, 1);
  assert.equal(closeProvedByList, true);
  assert.equal(panePresent, false);

  const listed = await registeredAgentTool(pi, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(listed.details.agents, []);
  const retried = await tool.execute(
    "id",
    {
      definition: "agent",
      task: "corrected attempt",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(retried.details.ok, true);
  assert.equal(starts, 2);
  assert.equal(splits, 0);
  assert.equal(panePresent, true);
  assert.equal(readAgentState(startup.mailbox)?.agentLabel, label);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startup.mailbox);
});

test("assignment launch bounds missing official Pi session identity grace", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startup = startupExecutor(
    label,
    () => null,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    true,
  );
  let started = false;
  let stopped = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isPreservePaneStop(args)) stopped = true;
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              process_info: {
                pane_id: "startup-pane",
                shell_pid: 123,
                foreground_process_group_id: started && !stopped ? 999 : 123,
                foreground_processes:
                  started && !stopped
                    ? [
                        { pid: 123, argv0: "/bin/zsh" },
                        { pid: 999, argv0: "/usr/local/bin/pi" },
                      ]
                    : [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      const result = startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        started = true;
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  const result = await registeredAgentTool(pi, "delegate").execute(
    "id",
    {
      definition: "agent",
      task: "missing identity",
    },
    undefined,
    undefined,
    fakeContext(pi.entries),
  );
  assert.equal(startup.getCount(), 11);
  assert.equal(result.details.error.category, "invalid_request");
  assert.match(
    result.details.error.message,
    /official Pi integration did not report its session identity/,
  );
  assert.equal(result.details.error.retryAttempted, true);
  assert.equal(pi.calls.filter((args) => isPreservePaneStop(args)).length, 1);
  assert.equal(
    pi.calls.filter((args) => isPaneClose(args) || isTabClose(args)).length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
});

test("assignment integration grace aborts without a later lookup or timer", async () => {
  setLeadEnvironment();
  const controller = new AbortController();
  const label = "aborted-session-agent";
  const startup = startupExecutor(
    label,
    () => null,
    (count) => {
      if (count === 1) setTimeout(() => controller.abort(), 10);
    },
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  let started = false;
  let stopped = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (options?.signal?.aborted) throw new Error("aborted executor signal");
      if (command === "herdr" && isPreservePaneStop(args)) stopped = true;
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              process_info: {
                pane_id: "startup-pane",
                shell_pid: 123,
                foreground_process_group_id: started && !stopped ? 999 : 123,
                foreground_processes:
                  started && !stopped
                    ? [
                        { pid: 123, argv0: "/bin/zsh" },
                        { pid: 999, argv0: "/usr/local/bin/pi" },
                      ]
                    : [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      const result = startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        started = true;
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  seedLeadRole(fakeContext(pi.entries));
  await pi.events.get("session_start")![0](undefined, fakeContext(pi.entries));
  const startedAt = Date.now();
  const result = await registeredAgentTool(pi, "delegate").execute(
    "id",
    { definition: "agent", label, task: "abort identity" },
    controller.signal,
    undefined,
    fakeContext(pi.entries),
  );
  assert.ok(Date.now() - startedAt < 2500);
  assert.equal(result.details.error.category, "internal_failure");
  assert.equal(startup.getCount(), 1);
  const cleanupCalls = pi.calls.filter(
    (args) =>
      isPreservePaneStop(args) ||
      isPaneClose(args) ||
      isTabClose(args) ||
      isHerdrList(args),
  );
  assert.equal(
    cleanupCalls.some((args) => isTabClose(args) || isPaneClose(args)),
    true,
  );
  assert.equal(
    cleanupCalls.some((args) => isPreservePaneStop(args)),
    true,
  );
  const firstCleanupIndex = pi.calls.findIndex((args) =>
    isPreservePaneStop(args),
  );
  assert.equal(
    pi.execOptions
      .filter((_options, index) => {
        if (index < firstCleanupIndex) return false;
        const args = pi.calls[index];
        return (
          isPreservePaneStop(args) ||
          isPaneClose(args) ||
          isTabClose(args) ||
          isHerdrList(args)
        );
      })
      .some((options) => options.signal?.aborted === true),
    false,
  );
  assert.equal(readAgentState(startup.mailbox), undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(startup.getCount(), 1);
  pi.events.get("session_shutdown")?.[0]();
});

test("missing child bootstrap initializer prevents managed readiness", async () => {
  const label = `bootstrap-missing-child-${randomUUID().slice(0, 8)}`;
  const envKeys = [
    "HERDR_ENV",
    "HERDR_WORKSPACE_ID",
    "PI_HERDSMAN_MAILBOX",
    "PI_HERDSMAN_RUN_ID",
    "PI_HERDSMAN_OWNER_SESSION_ID",
    "PI_HERDSMAN_OWNER_DISPLAY",
    "PI_HERDSMAN_LABEL",
    "PI_HERDSMAN_WORKSPACE_ID",
    "PI_HERDSMAN_AGENT_DEFINITION",
    "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
    "HERDR_PANE_ID",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const mailbox = agentMailboxPath(WORKSPACE, label);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.PI_HERDSMAN_MAILBOX = mailbox;
  process.env.PI_HERDSMAN_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  process.env.PI_HERDSMAN_OWNER_SESSION_ID =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
  process.env.PI_HERDSMAN_LABEL = label;
  process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
  process.env.HERDR_PANE_ID = "registered-pane";
  const runId = process.env.PI_HERDSMAN_RUN_ID!;
  const ownerSessionId = process.env.PI_HERDSMAN_OWNER_SESSION_ID!;
  resetAgentMailbox(mailbox);
  writeAgentBootstrap(mailbox, {
    version: 5,
    build: HERDSMAN_BUILD,
    runId,
    ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    participants: [{ id: "test/required", payload: "opaque" }],
  });
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([]);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    assert.equal(readAgentState(mailbox), undefined);
    assert.deepEqual(
      realFs
        .readdirSync(mailbox)
        .filter((name) => /^request-.*\.json$/.test(name)),
      [],
    );
    assert.equal(
      pi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ),
      false,
    );
    assert.ok(readAgentBootstrap(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("child bootstrap initializer is awaited before readiness and sidecar removal", async () => {
  const label = `bootstrap-ready-child-${randomUUID().slice(0, 8)}`;
  const envKeys = [
    "HERDR_ENV",
    "HERDR_WORKSPACE_ID",
    "PI_HERDSMAN_MAILBOX",
    "PI_HERDSMAN_RUN_ID",
    "PI_HERDSMAN_OWNER_SESSION_ID",
    "PI_HERDSMAN_OWNER_DISPLAY",
    "PI_HERDSMAN_LABEL",
    "PI_HERDSMAN_WORKSPACE_ID",
    "PI_HERDSMAN_AGENT_DEFINITION",
    "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
    "HERDR_PANE_ID",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const mailbox = agentMailboxPath(WORKSPACE, label);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.PI_HERDSMAN_MAILBOX = mailbox;
  process.env.PI_HERDSMAN_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  process.env.PI_HERDSMAN_OWNER_SESSION_ID =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
  process.env.PI_HERDSMAN_LABEL = label;
  process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
  process.env.HERDR_PANE_ID = "registered-pane";
  resetAgentMailbox(mailbox);
  writeAgentBootstrap(mailbox, {
    version: 5,
    build: HERDSMAN_BUILD,
    runId: process.env.PI_HERDSMAN_RUN_ID!,
    ownerSessionId: process.env.PI_HERDSMAN_OWNER_SESSION_ID!,
    workspaceId: WORKSPACE,
    agentLabel: label,
    participants: [{ id: "test/required", payload: "opaque" }],
  });
  const observed: string[] = [];
  const pi = fakePi();
  pi.pi.events.on(MANAGED_AGENT_BOOTSTRAP_EVENT, (event: any) => {
    if (event.phase !== "initialize") return;
    assert.equal(event.participant.id, "test/required");
    assert.equal(event.participant.payload, "opaque");
    event.accept(async () => {
      assert.equal(readAgentState(mailbox), undefined);
      assert.ok(readAgentBootstrap(mailbox));
      await Promise.resolve();
      observed.push("initialized");
    });
  });
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeAgentContext([]));
    assert.deepEqual(observed, ["initialized"]);
    assert.equal(readAgentBootstrap(mailbox), undefined);
    assert.ok(readAgentState(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("child bootstrap fails closed on identity, build, duplicate, and initializer errors", async (t) => {
  for (const scenario of [
    "identity mismatch",
    "build mismatch",
    "multiple initializers",
    "initializer throws",
  ] as const) {
    await t.test(scenario, async () => {
      const label = `bootstrap-fail-${randomUUID().slice(0, 8)}`;
      const envKeys = [
        "HERDR_ENV",
        "HERDR_WORKSPACE_ID",
        "PI_HERDSMAN_MAILBOX",
        "PI_HERDSMAN_RUN_ID",
        "PI_HERDSMAN_OWNER_SESSION_ID",
        "PI_HERDSMAN_OWNER_DISPLAY",
        "PI_HERDSMAN_LABEL",
        "PI_HERDSMAN_WORKSPACE_ID",
        "PI_HERDSMAN_AGENT_DEFINITION",
        "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
        "HERDR_PANE_ID",
      ];
      const previousEnv = new Map(
        envKeys.map((key) => [key, process.env[key]]),
      );
      const mailbox = agentMailboxPath(WORKSPACE, label);
      process.env.HERDR_ENV = "1";
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      process.env.PI_HERDSMAN_MAILBOX = mailbox;
      process.env.PI_HERDSMAN_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      process.env.PI_HERDSMAN_OWNER_SESSION_ID =
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
      process.env.PI_HERDSMAN_LABEL = label;
      process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
      process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
      process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = "[]";
      process.env.HERDR_PANE_ID = "registered-pane";
      resetAgentMailbox(mailbox);
      writeAgentBootstrap(mailbox, {
        version: 5,
        build:
          scenario === "build mismatch" ? OTHER_HERDSMAN_BUILD : HERDSMAN_BUILD,
        runId:
          scenario === "identity mismatch"
            ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            : process.env.PI_HERDSMAN_RUN_ID,
        ownerSessionId: process.env.PI_HERDSMAN_OWNER_SESSION_ID!,
        workspaceId: WORKSPACE,
        agentLabel: label,
        participants: [{ id: "test/required", payload: "opaque" }],
      });
      const pi = fakePi();
      if (
        scenario === "multiple initializers" ||
        scenario === "initializer throws"
      )
        pi.pi.events.on(MANAGED_AGENT_BOOTSTRAP_EVENT, (event: any) => {
          if (event.phase !== "initialize") return;
          event.accept(() => {
            if (scenario === "initializer throws")
              throw new Error("initializer failed");
          });
          if (scenario === "multiple initializers")
            event.accept(() => undefined);
        });
      registerExtension!(pi.pi as never);
      try {
        for (const handler of pi.events.get("session_start") ?? [])
          await handler(undefined, fakeAgentContext([]));
        assert.equal(readAgentState(mailbox), undefined);
        assert.ok(readAgentBootstrap(mailbox));
      } finally {
        pi.events.get("session_shutdown")?.[0]();
        resetAgentMailbox(mailbox);
        for (const key of envKeys) {
          const value = previousEnv.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
});
