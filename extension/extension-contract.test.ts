import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { Value } from "typebox/value";
import { acquireProcessLock } from "./lock.ts";
import { resultPath, resultRef } from "./storage.ts";
import {
  claimChiefLease,
  listCoordinationMessagePaths,
  invalidateLeadCoordinationState,
  listChiefMessagePaths,
  readPeerLeadRecord,
  removePeerLeadRecord,
  removeChiefMessage,
  readChiefMessage,
  writeChiefMessage,
  supervisionRuntime,
  readLeadCoordinationState,
  writeLeadCoordinationState,
  peerLeadLockPath,
  peerRuntime,
  writePeerLeadRecord,
} from "./supervision.ts";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { OperationError } from "./errors.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  PI_AGENT_ROOT,
  PI_AGENTS_DIR,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  agentFromState,
  controlMarker,
  fakeContext,
  fakePi,
  fakeAgentContext,
  isAgentList,
  isApiSnapshot,
  managedState,
  nativeSessions,
  agentControllerExecutor,
  leadExec,
  readAgentState,
  realFs,
  recoveryIdentity,
  registerExtension,
  resetAgentMailbox,
  setLeadEnvironment,
  setAgentEnvironment,
  testGate,
  skillBlock,
  startupExecutor,
  testTmpRoot,
  waitForTestCondition,
  agentMailboxPath,
  writeRequest,
  writeAsk,
  writeAgentState,
} from "./support.ts";

function assertToolResult(result: any): asserts result is {
  content: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
} {
  assert.ok(result && typeof result === "object");
  assert.ok(Array.isArray(result.content));
  assert.ok(
    result.content.every(
      (part: any) => part?.type === "text" && typeof part.text === "string",
    ),
  );
}

const REGISTERED_ROLE_TOOLS = [
  { name: "agent" },
  { name: "chief" },
  { name: "peer" },
  { name: "staff" },
];

test("Herdr version parsing accepts preview suffixes but rejects trailing text", async () => {
  const { parseHerdrVersion } = await import("./index.ts");
  for (const version of [
    "0.9.0",
    "0.9.0-preview",
    "0.9.0-preview.2026-06-02-abcdef123456",
  ])
    assert.ok(parseHerdrVersion(version), version);
  for (const version of [
    "0.9.0 trailing",
    "0.9.0-preview.2026-06-02-abcdef123456 trailing",
    "0.9.0\n",
    "00.9.0",
    "0.09.0",
    "0.9.00",
  ])
    assert.equal(parseHerdrVersion(version), undefined, version);
});

test("Herdr preflight gates minimum client version and server compatibility", async () => {
  const run = async (
    server: Record<string, unknown>,
    clientVersion = "0.9.1",
  ) => {
    setLeadEnvironment();
    const label = `preflight-${randomUUID().slice(0, 8)}`;
    const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
    const pi = fakePi({
      exec: startup.exec,
      status: {
        code: 0,
        stdout: JSON.stringify({
          client: { version: clientVersion },
          server,
        }),
        stderr: "",
      },
    });
    registerExtension!(pi.pi as never);
    try {
      return await pi.tools[0].execute(
        "preflight",
        {
          action: "delegate",
          definition: "agent",
          label,
          task: "preflight",
        },
        undefined,
        undefined,
        fakeContext(),
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  };

  const oldClient = await run({ running: true, compatible: true }, "0.9.0");
  assert.equal(oldClient.details.error.category, "invalid_request");
  assert.match(oldClient.details.error.message, /Herdr >=0\.9\.1/);

  const incompatible = await run({ running: true, compatible: false });
  assert.equal(incompatible.details.error.category, "invalid_request");
  assert.match(incompatible.details.error.message, /compatible server/);

  const staleServer = await run({
    running: true,
    version: "0.8.0",
    compatible: true,
  });
  assert.equal(
    staleServer.details.ok,
    true,
    JSON.stringify(staleServer.details),
  );

  const missingServerVersion = await run({ running: true, compatible: true });
  assert.equal(
    missingServerVersion.details.ok,
    true,
    JSON.stringify(missingServerVersion.details),
  );
});

test("registered lead and unmanaged roles expose the correct surface", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const lead = fakePi();
  registerExtension!(lead.pi as never);
  assert.deepEqual(lead.commands.sort(), ["agents", "chief", "herdsman"]);
  assert.deepEqual(lead.tools.map((tool) => tool.name).sort(), [
    "agent",
    "chief",
    "peer",
  ]);
  assert.equal(
    lead.tools.find((tool) => tool.name === "chief")?.label,
    "chief",
  );
  assert.equal(
    lead.tools.find((tool) => tool.name === "agent")?.label,
    "agent",
  );
  assert.equal(
    lead.tools.find((tool) => tool.name === "agent")?.promptSnippet,
    "Delegate and coordinate work with owned asynchronous agents",
  );
  assert.deepEqual(
    lead.tools.find((tool) => tool.name === "agent")?.promptGuidelines,
    [
      "Use agent for genuinely independent or context-heavy work; keep small, tightly coupled work local.",
      "Each unresolved unit of work has one executor. Delegating a scope transfers its execution ownership to that agent until the assignment resolves. After delegation succeeds, stop executing, inspecting, or analyzing that delegated scope locally; do not assign overlapping work. Continue only concrete, necessary work clearly outside the delegated scope that you still own.",
      "For agent handoffs, `task`/`files` carry assignment evidence and `fork`/`continue` carry selected Pi history; do not assume the caller's conversation or attachments are inherited.",
      "When agent work is unresolved, handle required agent control, then continue only necessary work you still own or end the turn without concluding; agent results or attention will resume the session automatically. Do not check progress with list, inspect, transcript, status requests, steering, sleep, or other waiting mechanisms, and do not invent work merely to remain active.",
    ],
  );
  assert.equal(
    lead.tools.find((tool) => tool.name === "chief")?.promptSnippet,
    "Report progress to or ask the active chief supervising this lead",
  );
  assert.equal(
    lead.tools.find((tool) => tool.name === "peer")?.promptSnippet,
    "Discover and message other live lead sessions",
  );
  const agentTool = lead.tools.find((tool) => tool.name === "agent");
  const chiefTool = lead.tools.find((tool) => tool.name === "chief");
  const peerTool = lead.tools.find((tool) => tool.name === "peer");
  assert.ok(agentTool);
  assert.ok(peerTool);
  const resultRef = "result:implementation#1";
  for (const request of [
    {
      action: "delegate",
      definition: "agent",
      task: "review",
      files: [resultRef],
    },
    {
      action: "continue",
      session: "/tmp/session.jsonl",
      task: "continue",
      files: [resultRef],
    },
    {
      action: "steer",
      agent: "implementation",
      message: "continue",
      files: [resultRef],
    },
    {
      action: "interrupt",
      agent: "implementation",
      message: "stop",
      files: [resultRef],
    },
    {
      action: "reply",
      agent: "implementation",
      message: "answer",
      files: [resultRef],
    },
  ])
    assert.equal(
      Value.Check(agentTool.parameters, request),
      true,
      request.action,
    );
  assert.equal(
    Value.Check(agentTool.parameters, {
      action: "delegate",
      definition: "agent",
      task: "review",
      files: [{ agent: "implementation", index: 1 }],
    }),
    false,
    "files remains a homogeneous string array",
  );
  assert.equal(
    Value.Check(agentTool.parameters, {
      action: "delegate",
      definition: "agent",
      task: "review",
      results: [{ agent: "implementation", index: 1 }],
    }),
    false,
    "results is no longer public API",
  );
  const agentDescription = agentTool.description.replaceAll(/\s+/g, " ");
  assert.match(
    agentDescription,
    /files is the explicit message-evidence channel.*result:researcher#1/,
  );
  assert.match(
    agentDescription,
    /Preserve exact result refs when forwarding them/,
  );
  assert.doesNotMatch(agentDescription, /resultRef\/handoff/);
  assert.doesNotMatch(agentDescription, /\bpeers?\b/i);
  assert.match(agentDescription, /steer changes active work cooperatively/);
  assert.match(
    agentDescription,
    /interrupt abandons the current in-flight Pi operation/,
  );
  assert.match(
    agentDescription,
    /interrupt.*supersedes.*earlier steering.*not yet delivered/is,
  );
  assert.match(agentDescription, /same assignment/);
  assert.match(agentDescription, /available_actions/);
  assert.match(
    agentDescription,
    /transcript provides bounded persisted Pi conversation\/tool evidence/,
  );
  assert.match(
    agentDescription,
    /inspect provides bounded live terminal\/process evidence/,
  );
  assert.doesNotMatch(
    agentDescription,
    /Delegate any other useful independent work now/,
  );
  assert.equal(typeof agentTool?.renderCall, "function");
  assert.equal(typeof agentTool?.renderResult, "function");
  assert.equal(typeof chiefTool?.renderCall, "function");
  assert.equal(typeof chiefTool?.renderResult, "function");
  assert.equal(
    Value.Check(chiefTool.parameters, {
      action: "message",
      message: "progress",
      files: [resultRef],
    }),
    true,
  );
  assert.equal(
    Value.Check(chiefTool.parameters, {
      action: "ask",
      question: "decision needed",
      files: [resultRef],
    }),
    true,
  );
  assert.equal(
    Value.Check(chiefTool.parameters, {
      action: "message",
      message: "progress",
      results: [{ agent: "implementation", index: 1 }],
    }),
    false,
  );
  assert.equal(peerTool.label, "peer");
  assert.equal(peerTool.executionMode, "sequential");
  assert.equal(typeof peerTool.renderCall, "function");
  assert.equal(typeof peerTool.renderResult, "function");
  const renderedPeerCall = peerTool.renderCall(
    { action: "message", lead: LEAD_SESSION_ID, message: "Please coordinate" },
    {
      fg: (_color: string, value: string) => value,
      bold: (text: string) => text,
    },
    { argsComplete: true },
  );
  assert.match(renderedPeerCall.render(160).join("\n"), /^peer message/);
  assert.match(
    peerTool.description,
    /ordinary Lead sessions \(peers\), not managed agents/,
  );
  assert.match(peerTool.description, /list identifies this Lead as self/);
  assert.equal(Value.Check(peerTool.parameters, { action: "list" }), true);
  assert.equal(
    Value.Check(peerTool.parameters, {
      action: "message",
      lead: LEAD_SESSION_ID,
      message: "Please coordinate this result",
    }),
    true,
  );
  assert.equal(
    Value.Check(peerTool.parameters, {
      action: "message",
      lead: LEAD_SESSION_ID,
      message: "Share result",
      files: [resultRef],
    }),
    true,
  );
  assert.equal(
    Value.Check(peerTool.parameters, {
      action: "message",
      lead: LEAD_SESSION_ID,
      message: "Share result",
      results: [{ agent: "implementation", index: 1 }],
    }),
    false,
  );
  assert.equal(
    Value.Check(peerTool.parameters, {
      action: "message",
      lead: "display-name",
      message: "not an exact session ID",
    }),
    true,
    "peer session IDs intentionally accept the canonical full identity pattern",
  );
  assert.equal(
    Value.Check(peerTool.parameters, {
      action: "message",
      lead: "lead/session",
      message: "slash is not a session ID",
    }),
    false,
  );
  assert.equal(
    Value.Check(peerTool.parameters, {
      action: "message",
      lead: LEAD_SESSION_ID,
      message: "legacy target name",
      target: "display-name",
    }),
    false,
  );
  assert.deepEqual(
    lead.messageRenderers.map(({ customType }) => customType).sort(),
    [
      "pi-herdsman-agent-ask",
      "pi-herdsman-agent-attention",
      "pi-herdsman-agent-lost",
      "pi-herdsman-agent-result",
      "pi-herdsman-agent-stale",
      "pi-herdsman-stop-summary",
    ],
  );
  assert.ok(lead.tools.every((tool) => tool.executionMode === "sequential"));
  assert.equal(lead.commands.includes("subagents"), false);
  assert.equal(
    lead.tools.some((tool) =>
      ["subagent", "chief_of_staff", "herdsman"].includes(tool.name),
    ),
    false,
  );
  assert.equal(lead.events.has("before_agent_start"), true);
  assert.equal(lead.events.has("context"), false);
  assert.ok(lead.events.has("session_start"));
  assert.ok(lead.events.has("session_shutdown"));

  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  const unmanaged = fakePi();
  registerExtension!(unmanaged.pi as never);
  assert.deepEqual(unmanaged.commands, ["agents", "herdsman"]);
  assert.deepEqual(unmanaged.tools, []);
  assert.equal(unmanaged.events.size, 0);
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  const agentsCommand = unmanaged.commandOptions.get("agents");
  const herdsmanCommand = unmanaged.commandOptions.get("herdsman");
  assert.ok(agentsCommand);
  assert.ok(herdsmanCommand);
  assert.equal(herdsmanCommand.description, "Alias for /agents");
  assert.equal(herdsmanCommand.handler, agentsCommand.handler);
  await herdsmanCommand.handler("", context);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /inactive because .*not running inside Herdr/);
  assert.match(notices[0]!, /herdr\n  pi/);
  assert.match(notices[0]!, /herdr integration install pi/);
});

test("managed agents receive no peer tool and Chiefs expose only staff actively", async () => {
  const mailbox = setAgentEnvironment("peer-exclusion-agent");
  const managed = fakePi();
  registerExtension!(managed.pi as never);
  assert.equal(
    managed.tools.some((tool) => tool.name === "peer"),
    false,
  );
  assert.equal(
    managed.tools.find((tool) => tool.name === "ask_owner")?.promptSnippet,
    "Ask this managed agent's direct owner for a required decision",
  );
  managed.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);

  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-chief-surface-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief", "peer"] },
    },
  ];
  const chief = fakePi({
    entries,
    activeTools: ["agent", "chief", "peer"],
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(chief.pi as never);
  const context = fakeContext(entries) as any;
  try {
    await chief.events.get("session_start")![0](undefined, context);
    assert.deepEqual(chief.pi.getActiveTools(), ["staff"]);
    assert.equal(chief.pi.getActiveTools().includes("peer"), false);
  } finally {
    await chief.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("peer list and message use global peer presence, not caller inventory", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-a-pane";
  process.env.HERDR_TAB_ID = "lead-a-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-target-race-${randomUUID()}.sock`,
  );
  const senderId = `lead-a-${randomUUID()}`;
  const targetId = `lead-b-${randomUUID()}`;
  const unenrichedTargetId = `lead-c-${randomUUID()}`;
  const resultRequestId = randomUUID();
  const resultReference = resultRef(resultRequestId);
  const resultFile = resultPath(resultRequestId);
  realFs.mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, "peer result evidence", "utf8");
  const resultEntry = {
    customType: "pi-herdsman-agent-result",
    details: {
      agentLabel: "implementation",
      resultIndex: 1,
      status: "completed",
      requestId: resultRequestId,
      resultRef: resultReference,
    },
  };
  const runtime = peerRuntime();
  const claim = (sessionId: string, paneId: string, tabId: string) => {
    const lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
      name: "Lead peer presence",
    });
    const record = {
      version: 1 as const,
      piSessionId: sessionId,
      paneId,
      tabId,
      workspaceId: WORKSPACE,
      ...(sessionId === targetId
        ? {
            name: "Target Lead",
            cwd: "/workspaces/target",
            repo: "pi-herdsman",
            branch: "feature/peer",
            workspaceLabel: "pi-herdsman/feature/peer",
          }
        : {}),
      claim: lease.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, record);
    return { lease, record };
  };
  const sender = claim(senderId, "lead-a-pane", "lead-a-tab");
  const target = claim(targetId, "lead-b-pane", "lead-b-tab");
  const unenrichedTarget = claim(
    unenrichedTargetId,
    "lead-c-pane",
    "lead-c-tab",
  );
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args) || isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [], snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext([resultEntry]) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => senderId,
  };
  try {
    const peer = pi.tools.find((tool) => tool.name === "peer");
    assert.ok(peer);
    const listed = await peer.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    const modelJson = listed.content[0].text;
    const payload = JSON.parse(modelJson);
    assert.deepEqual(
      {
        self: payload.self,
        peers: [...payload.peers].sort((a, b) => a.lead.localeCompare(b.lead)),
      },
      {
        self: senderId,
        peers: [
          {
            lead: targetId,
            name: "Target Lead",
            cwd: "/workspaces/target",
            repo: "pi-herdsman",
            branch: "feature/peer",
            workspace_label: "pi-herdsman/feature/peer",
          },
          {
            lead: unenrichedTargetId,
            name: `lead-${unenrichedTargetId.slice(0, 8)}`,
            cwd: "",
            repo: "",
            branch: "",
            workspace_label: "",
          },
        ].sort((a, b) => a.lead.localeCompare(b.lead)),
      },
    );
    assert.equal(modelJson.includes(WORKSPACE), false);
    assert.equal(
      payload.peers.some((peer: { lead: string }) => peer.lead === senderId),
      false,
    );
    const queued = await peer.execute(
      "message",
      {
        action: "message",
        lead: targetId,
        message: "global peer",
        files: ["result:implementation#1"],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(queued.details?.lead, targetId);
    const messagePaths = listCoordinationMessagePaths(runtime, targetId);
    assert.equal(messagePaths.length, 1);
    const message = readChiefMessage(messagePaths[0]);
    assert.ok(message.text.includes("global peer"));
    assert.ok(message.text.includes(resultReference));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    sender.lease.release();
    target.lease.release();
    unenrichedTarget.lease.release();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
    realFs.rmSync(resultFile, { force: true });
  }
});

test("Lead startup publishes minimal peer presence before provenance resolves", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-startup-provenance-${randomUUID()}.sock`,
  );
  const sessionId = randomUUID();
  const runtime = peerRuntime();
  const provenanceStarted = testGate<void>();
  const releaseProvenance = testGate<void>();
  const pi = fakePi({
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get") {
        provenanceStarted.resolve();
        await releaseProvenance.promise;
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = "/active/lead-checkout";
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  try {
    const starting = sessionStart(undefined, context);
    await provenanceStarted.promise;

    const record = readPeerLeadRecord(runtime, sessionId);
    assert.ok(record);
    assert.deepEqual(Object.keys(record).sort(), [
      "claim",
      "cwd",
      "paneId",
      "piSessionId",
      "tabId",
      "updatedAt",
      "version",
      "workspaceId",
    ]);
    assert.equal(record.cwd, context.cwd);
    assert.equal(record.repo, undefined);
    assert.equal(record.branch, undefined);
    assert.equal(record.workspaceLabel, undefined);

    await starting;
    releaseProvenance.resolve();
  } finally {
    releaseProvenance.resolve();
    await sessionShutdown();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("peer provenance enrichment never replaces the Lead cwd", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-linked-worktree-${randomUUID()}.sock`,
  );
  const sessionId = randomUUID();
  const runtime = peerRuntime();
  const worktreeStarted = testGate<void>();
  const releaseWorktree = testGate<void>();
  const pi = fakePi({
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: {
                label: "linked-workspace",
                worktree: {
                  checkout_path: "/source/checkout",
                  repo_name: "pi-herdsman",
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "worktree" && args[1] === "list") {
        worktreeStarted.resolve();
        await releaseWorktree.promise;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: { source_checkout_path: "/source/checkout" },
              worktrees: [
                { open_workspace_id: WORKSPACE, branch: "feature/linked" },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = "/active/linked-checkout";
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  try {
    const starting = sessionStart(undefined, context);
    await worktreeStarted.promise;
    const minimal = readPeerLeadRecord(runtime, sessionId);
    assert.equal(minimal?.cwd, context.cwd);
    assert.equal(minimal?.repo, undefined);

    await starting;
    releaseWorktree.resolve();
    await waitForTestCondition(() => {
      const record = readPeerLeadRecord(runtime, sessionId);
      return (
        record?.cwd === context.cwd &&
        record.repo === "pi-herdsman" &&
        record.branch === "feature/linked" &&
        record.workspaceLabel === "pi-herdsman/feature/linked"
      );
    }, "linked-worktree provenance did not enrich peer presence");
    const enriched = readPeerLeadRecord(runtime, sessionId);
    assert.equal(enriched?.cwd, context.cwd);
    assert.equal(enriched?.repo, "pi-herdsman");
    assert.equal(enriched?.branch, "feature/linked");
    assert.equal(enriched?.workspaceLabel, "pi-herdsman/feature/linked");
  } finally {
    releaseWorktree.resolve();
    await sessionShutdown();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("peer publication rejects sender and target generation replacement during attachment preparation", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-a-pane";
  process.env.HERDR_TAB_ID = "lead-a-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-generation-race-${randomUUID()}.sock`,
  );
  const attachment = join(tmpdir(), `peer-attachment-${randomUUID()}.md`);
  writeFileSync(attachment, "attachment evidence\n", "utf8");
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  writeFileSync(configPath, "{}", "utf8");
  const senderId = `lead-a-${randomUUID()}`;
  const targetId = `lead-b-${randomUUID()}`;
  const runtime = peerRuntime();
  const claim = (sessionId: string, paneId: string, tabId: string) => {
    const lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
      name: "Lead peer presence",
    });
    const record = {
      version: 1 as const,
      piSessionId: sessionId,
      paneId,
      tabId,
      workspaceId: WORKSPACE,
      claim: lease.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, record);
    return { lease, record };
  };
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => senderId,
  };
  try {
    const peer = pi.tools.find((tool) => tool.name === "peer");
    assert.ok(peer);
    for (const replaced of ["sender", "target"] as const) {
      const sender = claim(senderId, "lead-a-pane", "lead-a-tab");
      const target = claim(targetId, "lead-b-pane", "lead-b-tab");
      const expectedSender = sender.record;
      const expectedTarget = target.record;
      const preparationReached = testGate<void>();
      let reached = false;
      support.configReadHook = () => {
        if (!reached) {
          reached = true;
          preparationReached.resolve();
        }
      };
      const pending = peer.execute(
        "message",
        {
          action: "message",
          lead: targetId,
          message: "must not queue",
          files: [attachment],
        },
        undefined,
        undefined,
        context,
      );
      await preparationReached.promise;
      const current = replaced === "sender" ? sender : target;
      current.lease.release();
      const replacement = claim(
        current.record.piSessionId,
        current.record.paneId,
        current.record.tabId,
      );
      await assert.rejects(
        pending,
        /sender or target changed before the message was queued/,
      );
      assert.deepEqual(
        readPeerLeadRecord(runtime, senderId),
        replaced === "sender" ? replacement.record : expectedSender,
      );
      assert.deepEqual(
        readPeerLeadRecord(runtime, targetId),
        replaced === "target" ? replacement.record : expectedTarget,
      );
      assert.deepEqual(listCoordinationMessagePaths(runtime, targetId), []);
      replacement.lease.release();
      sender.lease.release();
      target.lease.release();
      removePeerLeadRecord(runtime, senderId);
      removePeerLeadRecord(runtime, targetId);
      support.configReadHook = undefined;
    }
  } finally {
    support.configReadHook = undefined;
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(configPath, { force: true });
    realFs.rmSync(attachment, { force: true });
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("peer publication tolerates sender and target presentation enrichment during attachment preparation", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-a-pane";
  process.env.HERDR_TAB_ID = "lead-a-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presentation-race-${randomUUID()}.sock`,
  );
  const attachment = join(tmpdir(), `peer-attachment-${randomUUID()}.md`);
  writeFileSync(attachment, "attachment evidence\n", "utf8");
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  writeFileSync(configPath, "{}", "utf8");
  const senderId = `lead-a-${randomUUID()}`;
  const targetId = `lead-b-${randomUUID()}`;
  const runtime = peerRuntime();
  const claim = (sessionId: string, paneId: string, tabId: string) => {
    const lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
      name: "Lead peer presence",
    });
    const record = {
      version: 1 as const,
      piSessionId: sessionId,
      paneId,
      tabId,
      workspaceId: WORKSPACE,
      name: `${sessionId} Lead`,
      cwd: "/workspaces/peer",
      repo: "pi-herdsman",
      branch: "feature/peer",
      workspaceLabel: "pi-herdsman/feature/peer",
      claim: lease.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, record);
    return { lease, record };
  };
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => senderId,
  };
  try {
    const peer = pi.tools.find((tool) => tool.name === "peer");
    assert.ok(peer);
    for (const enriched of ["sender", "target"] as const) {
      const sender = claim(senderId, "lead-a-pane", "lead-a-tab");
      const target = claim(targetId, "lead-b-pane", "lead-b-tab");
      let messageId: string | undefined;
      try {
        const preparationReached = testGate<void>();
        let reached = false;
        support.configReadHook = () => {
          if (!reached) {
            reached = true;
            preparationReached.resolve();
          }
        };
        const pending = peer.execute(
          "message",
          {
            action: "message",
            lead: targetId,
            message: "presentation enrichment queues",
            files: [attachment],
          },
          undefined,
          undefined,
          context,
        );
        await preparationReached.promise;

        const current = enriched === "sender" ? sender : target;
        const updated = {
          ...current.record,
          name: `${current.record.name} enriched`,
          repo: "pi-herdsman-enriched",
          branch: "feature/enriched",
          workspaceLabel: "pi-herdsman/feature/enriched",
          updatedAt: current.record.updatedAt + 1,
        };
        writePeerLeadRecord(runtime, updated);
        assert.deepEqual(
          readPeerLeadRecord(runtime, current.record.piSessionId),
          updated,
        );

        const queued = await pending;
        assert.equal(queued.details?.lead, targetId);
        messageId = queued.details?.id as string;
        assert.equal(listCoordinationMessagePaths(runtime, targetId).length, 1);
        const message = readChiefMessage(
          listCoordinationMessagePaths(runtime, targetId)[0],
        );
        assert.equal(message.fromSessionId, senderId);
        assert.equal(message.toSessionId, targetId);
      } finally {
        support.configReadHook = undefined;
        if (messageId) removeChiefMessage(runtime, targetId, messageId);
        sender.lease.release();
        target.lease.release();
        removePeerLeadRecord(runtime, senderId);
        removePeerLeadRecord(runtime, targetId);
      }
    }
  } finally {
    support.configReadHook = undefined;
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(configPath, { force: true });
    realFs.rmSync(attachment, { force: true });
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("session shutdown prevents pending peer presence publication", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-shutdown-race-${randomUUID()}.sock`,
  );
  const sessionId = randomUUID();
  const runtime = peerRuntime();
  const provenanceStarted = testGate<void>();
  const releaseProvenance = testGate<void>();
  const pi = fakePi({
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get") {
        provenanceStarted.resolve();
        await releaseProvenance.promise;
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  try {
    const starting = sessionStart(undefined, context);
    await provenanceStarted.promise;
    const shuttingDown = sessionShutdown();
    releaseProvenance.resolve();
    await Promise.all([starting, shuttingDown]);
    await sessionShutdown();

    assert.equal(readPeerLeadRecord(runtime, sessionId), undefined);
    const lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
      name: "test peer presence",
    });
    lease.release();
  } finally {
    releaseProvenance.resolve();
    await sessionShutdown();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("stale peer publication cannot replace a same-session lifecycle generation", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-replacement-race-${randomUUID()}.sock`,
  );
  const sessionId = randomUUID();
  const runtime = peerRuntime();
  const provenanceStarted = testGate<void>();
  const releaseProvenance = testGate<void>();
  const pi = fakePi({
    exec: async (_command, args) => {
      if (args[0] === "workspace" && args[1] === "get") {
        provenanceStarted.resolve();
        await releaseProvenance.promise;
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  let replacementLease: ReturnType<typeof acquireProcessLock> | undefined;
  try {
    const starting = sessionStart(undefined, context);
    await provenanceStarted.promise;
    const shuttingDown = sessionShutdown();
    replacementLease = acquireProcessLock(
      peerLeadLockPath(runtime, sessionId),
      {
        name: "replacement peer presence",
      },
    );
    const replacement = {
      version: 1 as const,
      piSessionId: sessionId,
      paneId: "replacement-pane",
      tabId: "replacement-tab",
      workspaceId: WORKSPACE,
      claim: replacementLease.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, replacement);
    releaseProvenance.resolve();
    await Promise.all([starting, shuttingDown]);

    assert.deepEqual(readPeerLeadRecord(runtime, sessionId), replacement);
  } finally {
    releaseProvenance.resolve();
    await sessionShutdown();
    removePeerLeadRecord(runtime, sessionId);
    replacementLease?.release();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("active chief describes authoritative remote ask projection", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: ["agent", "chief"],
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  await pi.events.get("session_start")![0](undefined, context);
  const tool = pi.tools.find((candidate) => candidate.name === "staff");
  assert.ok(tool);
  assert.equal(tool.label, "staff");
  assert.equal(
    tool.promptSnippet,
    "Supervise and communicate with independent lead sessions",
  );
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.equal(
    Value.Check(tool.parameters, {
      action: "message",
      lead: LEAD_SESSION_ID,
      message: "Please continue",
      files: ["result:implementation#1"],
    }),
    true,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      action: "reply",
      lead: LEAD_SESSION_ID,
      askId: "ask-1",
      message: "Here is the decision",
      files: ["result:implementation#1"],
    }),
    true,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      action: "message",
      lead: LEAD_SESSION_ID,
      message: "Please continue",
      results: [{ agent: "implementation", index: 1 }],
    }),
    false,
  );
  const renderedStaffCall = tool.renderCall(
    { action: "message", lead: "lead-bbbbbbbbb", message: "Please continue" },
    {
      fg: (_color: string, value: string) => value,
      bold: (text: string) => text,
    },
    { argsComplete: true },
  );
  assert.equal(typeof renderedStaffCall.render, "function");
  assert.match(
    renderedStaffCall.render(160).join("\n"),
    /^staff message  lead-bbbbbb…/,
  );
  const renderedStaffResult = tool.renderResult(
    {
      content: [{ type: "text", text: "model result" }],
      details: { ok: true, display_name: "workspace/api", action: "message" },
    },
    { expanded: false },
    {
      fg: (_color: string, value: string) => value,
      bold: (text: string) => text,
    },
    { args: { action: "message", lead: "lead-bbbbbbbbb" } },
  );
  assert.match(renderedStaffResult.text, /✓ sent to workspace\/api/);
  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  const beforeStart = await pi.events.get("before_agent_start")![0](
    { systemPromptOptions: { contextFiles: [] } },
    context,
  );
  const chiefPrompt = beforeStart?.systemPrompt;
  assert.equal(
    beforeStart?.message?.customType,
    "pi-herdsman-supervision-context",
  );
  assert.equal(beforeStart?.message?.display, false);
  assert.match(String(beforeStart?.message?.content), /status="fresh"/);
  assert.match(
    String(chiefPrompt),
    /Chief coordination is event-driven, not polling/,
  );
  assert.match(
    String(chiefPrompt),
    /Do not use list, inspect, repeated messages, status requests, sleep, or any other mechanism merely to wait for lead progress or completion/,
  );
  const description = tool.description.replaceAll(/\s+/g, " ");
  assert.doesNotMatch(description, /remote needs_you.*unavailable/);
  assert.doesNotMatch(
    description,
    /metadata is display-only and never grants reply/,
  );
  for (const expected of [
    /The lead is the exact full Pi session ID shown as lead in a fresh automatic supervision snapshot or returned by staff list; never use display_name/,
    /For ordinary state and coordination, use a fresh snapshot directly; do not call staff list, inspect, transcript, or another read command merely to poll progress/,
    /The message and reply actions revalidate exact identity and state themselves/,
    /Every exact-identity-verified lead accepts message/,
    /reply only with the exact pending ask ID and current chief lease/,
    /Messages are bounded and direction-aware, and temporary verification or delivery failures retain queued records/,
    /Metadata is presentation-only and never authority/,
    /Human conversation remains the dispatch surface/,
    /Inspect provides bounded live terminal\/process evidence/,
    /Transcript provides bounded persisted Pi conversation\/tool evidence/,
    /does not own their agent trees, and receives no owner controls/,
  ])
    assert.match(description, expected);
  assert.doesNotMatch(description, /\b(steer|interrupt|close)\b/);
  const schema = JSON.stringify(tool.parameters);
  assert.equal(
    schema.match(
      /The lead is the exact full Pi session ID shown as lead in a fresh automatic supervision snapshot or returned by staff list; never use display_name\./g,
    )?.length,
    3,
  );
  for (const variant of (tool.parameters as any).anyOf) {
    const leadSchema = variant.properties?.lead;
    if (!leadSchema) continue;
    assert.equal(
      leadSchema.pattern,
      "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
    );
    assert.equal(Value.Check(leadSchema, ""), false);
    assert.equal(Value.Check(leadSchema, "-"), false);
    assert.equal(Value.Check(leadSchema, "lead/session"), false);
    assert.equal(Value.Check(leadSchema, LEAD_SESSION_ID), true);
  }
  assert.equal(
    Value.Check(tool.parameters, {
      action: "inspect",
      lead: LEAD_SESSION_ID,
    }),
    true,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      action: "transcript",
      lead: LEAD_SESSION_ID,
    }),
    true,
  );
  for (const action of ["steer", "interrupt", "close", "delegate", "continue"])
    assert.equal(
      Value.Check(tool.parameters, { action, lead: LEAD_SESSION_ID }),
      false,
      action,
    );
  assert.equal(
    Value.Check(tool.parameters, {
      action: "send",
      root: LEAD_SESSION_ID,
      message: "legacy target names are rejected",
    }),
    false,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      action: "message",
      root: LEAD_SESSION_ID,
      message: "legacy target names are rejected",
    }),
    false,
  );
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("staff transcript advertises persisted candidates and revalidates the lead", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-transcript-${randomUUID()}.sock`,
  );
  const chiefId = randomUUID();
  const leadId = randomUUID();
  const sessionRoot = realFs.realpathSync(
    realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-staff-transcript-")),
  );
  const leadPath = join(sessionRoot, "lead.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: leadId,
    timestamp: new Date().toISOString(),
    cwd: "/tmp",
  };
  const transcriptEntries = [
    header,
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "visible user" }],
      },
    },
    {
      type: "message",
      id: "system-entry",
      parentId: "user-entry",
      timestamp: new Date().toISOString(),
      message: {
        role: "system",
        content: [{ type: "text", text: "HIDDEN_SYSTEM" }],
      },
    },
    {
      type: "message",
      id: "assistant-entry",
      parentId: "system-entry",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "HIDDEN_REASONING" },
          { type: "text", text: "visible assistant" },
          {
            type: "toolCall",
            name: "visible_tool",
            arguments: { answer: "visible argument" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool-entry",
      parentId: "assistant-entry",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolName: "visible_tool",
        content: [{ type: "text", text: "visible tool result" }],
        isError: false,
      },
    },
    {
      type: "custom",
      customType: "hidden-custom",
      id: "custom-entry",
      parentId: "tool-entry",
      timestamp: new Date().toISOString(),
      data: "HIDDEN_CUSTOM",
    },
    {
      type: "message",
      id: "control-entry",
      parentId: "custom-entry",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: controlMarker(randomUUID()) }],
      },
    },
  ];
  writeFileSync(
    leadPath,
    transcriptEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
  nativeSessions.set(leadPath, { id: leadId, path: leadPath, entries: [] });
  let leadAgent: any = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: leadPath,
    },
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    workspace_id: WORKSPACE,
    cwd: "/tmp",
    agent_status: "idle",
  };
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: "chief-pane",
    tab_id: "chief-tab",
    workspace_id: WORKSPACE,
    cwd: "/tmp",
    agent_status: "idle",
  };
  let mutateLeadDuringTranscript = false;
  let snapshotCalls = 0;
  const exec = (_command: string, args: string[]) => {
    if (isApiSnapshot(args)) {
      snapshotCalls++;
      if (mutateLeadDuringTranscript && snapshotCalls > 1) {
        leadAgent = { ...leadAgent, pane_id: "changed-pane" };
        mutateLeadDuringTranscript = false;
      }
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            snapshot: {
              agents: [leadAgent, chiefAgent],
              panes: [leadAgent, chiefAgent],
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "agent" && args[1] === "get")
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            agent: args[2] === leadAgent.pane_id ? leadAgent : chiefAgent,
          },
        }),
        stderr: "",
        code: 0,
      };
    return { stdout: "{}", stderr: "", code: 0 };
  };
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const pi = fakePi({ entries, exec, allTools: REGISTERED_ROLE_TOOLS });
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => chiefId,
    getSessionFile: () => "/tmp/staff-transcript-chief.jsonl",
  };
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    instanceId: randomUUID(),
    piSessionId: leadId,
    updatedAt: Date.now(),
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const tool = pi.tools.find((candidate) => candidate.name === "staff");
    assert.ok(tool);

    const listed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assertToolResult(listed);
    assert.deepEqual(
      (listed.details?.leads as any[])[0]?.available_actions,
      ["inspect", "transcript", "message"],
      JSON.stringify(listed.details),
    );

    const transcript = await tool.execute(
      "transcript",
      { action: "transcript", lead: leadId },
      undefined,
      undefined,
      context,
    );
    assertToolResult(transcript);
    assert.match(transcript.details?.transcript, /visible user/);
    assert.match(transcript.details?.transcript, /visible assistant/);
    assert.match(transcript.details?.transcript, /visible argument/);
    assert.match(transcript.details?.transcript, /visible tool result/);
    for (const hidden of ["HIDDEN_SYSTEM", "HIDDEN_REASONING", "HIDDEN_CUSTOM"])
      assert.doesNotMatch(transcript.details?.transcript, new RegExp(hidden));
    assert.doesNotMatch(transcript.details?.transcript, /__PI_HERDSMAN/);

    writeFileSync(
      leadPath,
      JSON.stringify({ ...header, id: randomUUID() }) + "\n",
      "utf8",
    );
    const malformed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assertToolResult(malformed);
    assert.deepEqual(
      (malformed.details?.leads as any[])[0]?.available_actions,
      ["inspect", "transcript", "message"],
    );
    await assert.rejects(
      tool.execute(
        "transcript",
        { action: "transcript", lead: leadId },
        undefined,
        undefined,
        context,
      ),
      /Persisted Pi session is missing a matching current session header/,
    );
    writeFileSync(
      leadPath,
      transcriptEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    snapshotCalls = 0;
    mutateLeadDuringTranscript = true;
    await assert.rejects(
      tool.execute(
        "transcript",
        { action: "transcript", lead: leadId },
        undefined,
        undefined,
        context,
      ),
      /Lead changed during transcript read/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    invalidateLeadCoordinationState(supervisionRuntime(), leadId);
    nativeSessions.delete(leadPath);
    realFs.rmSync(sessionRoot, { recursive: true, force: true });
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("lead rejects a remote chief with mismatched physical identity", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-remote-chief-identity-${randomUUID()}.sock`,
  );
  const chiefId = `chief-${randomUUID()}`;
  const descriptorIdentity = {
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const lease = claimChiefLease(descriptorIdentity);
  const mismatchedInventoryAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: "moved-pane",
    tab_id: "moved-tab",
    workspace_id: "moved-workspace",
    cwd: "/tmp",
  };
  const descriptorAgent = {
    ...mismatchedInventoryAgent,
    pane_id: descriptorIdentity.paneId,
    tab_id: descriptorIdentity.tabId,
    workspace_id: descriptorIdentity.workspaceId,
  };
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [mismatchedInventoryAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: descriptorAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(
    [],
    [
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "chief" }],
        },
      },
    ],
  ) as any;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const tool = pi.tools.find((candidate) => candidate.name === "chief");
    assert.ok(tool);
    await assert.rejects(
      tool.execute(
        "message",
        { action: "message", message: "should not be delivered" },
        undefined,
        undefined,
        context,
      ),
      /No active chief is available/,
    );
    await assert.rejects(
      tool.execute(
        "ask",
        { action: "ask", question: "should not be delivered" },
        undefined,
        undefined,
        context,
      ),
      /No active chief is available/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    lease.release();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("chief activation reports unresolved mailbox state instead of owned work", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const mailbox = agentMailboxPath(
    WORKSPACE,
    `chief-activation-invalid-state-${randomUUID()}`,
  );
  const notices: string[] = [];
  realFs.mkdirSync(mailbox, { recursive: true });
  realFs.writeFileSync(join(mailbox, "state.json"), "not json");
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);

  try {
    const command = pi.commandOptions.get("chief");
    assert.ok(command);

    await command.handler("", context);

    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /managed mailbox state is unresolved/);
    assert.doesNotMatch(notices[0]!, /owned agent work exists/);
    assert.notDeepEqual(pi.pi.getActiveTools(), ["staff"]);
  } finally {
    realFs.rmSync(mailbox, { recursive: true, force: true });
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("a replacement chief never falls back to the previous session supervision", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-replacement-context-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const chiefA = `chief-a-${randomUUID()}`;
  const chiefB = `chief-b-${randomUUID()}`;
  const leadId = `lead-${randomUUID()}`;
  let sessionId = chiefA;
  let failRefresh = false;
  const leadAgent = {
    agent: "pi",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadId,
    },
    workspace_id: WORKSPACE,
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    cwd: "/tmp",
  };
  const pi = fakePi({
    entries,
    allTools: REGISTERED_ROLE_TOOLS,
    exec: (_command, args) => {
      if (failRefresh && isApiSnapshot(args))
        throw new Error("supervision unavailable");
      return isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [leadAgent],
                  panes: [leadAgent],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const beforeStart = () =>
    pi.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      context,
    );
  try {
    await sessionStart(undefined, context);
    const first = await beforeStart();
    assert.equal(first?.message?.customType, "pi-herdsman-supervision-context");
    assert.equal(first?.message?.display, false);
    assert.match(String(first?.message?.content), /status="fresh"/);

    sessionId = chiefB;
    failRefresh = true;
    await sessionStart(undefined, context);
    const message = (await beforeStart())?.message;
    assert.equal(message?.customType, "pi-herdsman-supervision-context");
    assert.equal(message?.display, false);
    assert.match(String(message?.content), /status="unavailable"/);
    assert.doesNotMatch(String(message?.content), /status="stale"/);
    assert.doesNotMatch(String(message?.content), new RegExp(leadId));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("an obsolete background supervision refresh cannot publish after chief transition", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-background-context-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const chiefA = `chief-a-${randomUUID()}`;
  const chiefB = `chief-b-${randomUUID()}`;
  const leadId = `lead-${randomUUID()}`;
  let sessionId = chiefA;
  let failRefresh = false;
  let blockNextRefresh = false;
  let releaseBlocked!: () => void;
  const leadAgent = {
    agent: "pi",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadId,
    },
    workspace_id: WORKSPACE,
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    cwd: "/tmp",
  };
  const pi = fakePi({
    entries,
    allTools: REGISTERED_ROLE_TOOLS,
    exec: async (_command, args) => {
      if (isApiSnapshot(args) && blockNextRefresh) {
        blockNextRefresh = false;
        return new Promise((resolve) => {
          releaseBlocked = () =>
            resolve({
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: {
                  snapshot: {
                    agents: [leadAgent],
                    panes: [leadAgent],
                  },
                },
              }),
              stderr: "",
              code: 0,
            });
        });
      }
      if (failRefresh && isApiSnapshot(args))
        throw new Error("supervision unavailable");
      return isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [leadAgent],
                  panes: [leadAgent],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const beforeStart = () =>
    pi.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      context,
    );
  try {
    await sessionStart(undefined, context);
    const first = await beforeStart();
    assert.equal(first?.message?.customType, "pi-herdsman-supervision-context");
    assert.equal(first?.message?.display, false);
    assert.match(String(first?.message?.content), /status="fresh"/);
    blockNextRefresh = true;
    const command = pi.commandOptions.get("chief");
    assert.ok(command);
    const background = command.handler("", context);
    await waitForTestCondition(() => releaseBlocked !== undefined);

    sessionId = chiefB;
    await sessionStart(undefined, context);
    failRefresh = true;
    releaseBlocked();
    await background;
    const message = (await beforeStart())?.message;
    assert.equal(message?.customType, "pi-herdsman-supervision-context");
    assert.equal(message?.display, false);
    assert.match(String(message?.content), /status="unavailable"/);
    assert.doesNotMatch(String(message?.content), /status="stale"/);
    assert.doesNotMatch(String(message?.content), new RegExp(leadId));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("Chief supervision context is persistent, deduplicated, and compaction-aware", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-continuity-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const branch: any[] = [];
  const pi = fakePi({ entries, allTools: REGISTERED_ROLE_TOOLS });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries, branch) as any;
  const beforeStart = () =>
    pi.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      context,
    );

  try {
    await pi.events.get("session_start")![0](undefined, context);
    const first = await beforeStart();
    assert.equal(first?.message?.customType, "pi-herdsman-supervision-context");
    assert.equal(first?.message?.display, false);
    assert.match(String(first?.message?.content), /status="fresh"/);

    const content = String(first?.message?.content);
    branch.push({
      type: "custom_message",
      id: "snapshot-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-herdsman-supervision-context",
      content,
      display: false,
    });
    const second = await beforeStart();
    assert.equal(second?.message, undefined);

    branch.push({
      type: "context_edit",
      id: "snapshot-edit",
      parentId: "snapshot-1",
      timestamp: new Date().toISOString(),
      targetId: "snapshot-1",
      replacement: null,
    });
    const afterOmission = await beforeStart();
    assert.equal(
      afterOmission?.message?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.equal(afterOmission?.message?.display, false);
    assert.match(String(afterOmission?.message?.content), /status="fresh"/);

    branch.splice(
      0,
      branch.length,
      {
        type: "custom_message",
        id: "snapshot-old",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "pi-herdsman-supervision-context",
        content,
        display: false,
      },
      {
        type: "message",
        id: "kept",
        parentId: "snapshot-old",
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "kept" }],
          timestamp: 1,
        },
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "kept",
        timestamp: new Date().toISOString(),
        summary: "summary",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
      },
    );
    const afterCompaction = await beforeStart();
    assert.ok(afterCompaction?.message);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("Chief preflight gate defers idle inbox delivery until agent_start", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-preflight-gate-${randomUUID()}.sock`,
  );
  const leadId = LEAD_SESSION_ID;
  const chiefId = `chief-${randomUUID()}`;
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const leadAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadId,
    },
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    workspace_id: WORKSPACE,
    agent_status: "idle",
  };
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: "chief-pane",
    tab_id: "chief-tab",
    workspace_id: WORKSPACE,
    agent_status: "idle",
  };
  const inventory = { agents: [leadAgent, chiefAgent], panes: [] };
  let blockedRefreshes = 0;
  const releaseBlocked: (() => void)[] = [];
  let refreshStarted = 0;
  const pi = fakePi({
    entries,
    allTools: REGISTERED_ROLE_TOOLS,
    exec: (_command, args) => {
      if (isApiSnapshot(args)) {
        if (blockedRefreshes > 0) {
          blockedRefreshes--;
          refreshStarted++;
          return new Promise((resolve) => {
            releaseBlocked.push(() =>
              resolve({
                stdout: JSON.stringify({
                  id: AGENT_ID,
                  result: { snapshot: inventory },
                }),
                stderr: "",
                code: 0,
              }),
            );
          });
        }
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: inventory },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: inventory.agents },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => chiefId,
    getSessionFile: () => "/tmp/chief-preflight-gate.jsonl",
  };
  const runtime = supervisionRuntime();

  try {
    await pi.events.get("session_start")![0](undefined, context);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const descriptor = JSON.parse(readFileSync(runtime.descriptor, "utf8")) as {
      leaseId: string;
    };
    writeLeadCoordinationState(runtime, {
      version: 1,
      instanceId: randomUUID(),
      piSessionId: leadId,
      updatedAt: Date.now(),
    });
    const messageId = randomUUID();
    writeChiefMessage({
      version: 1,
      id: messageId,
      leaseId: descriptor.leaseId,
      kind: "lead_message",
      fromSessionId: leadId,
      toSessionId: chiefId,
      leadSessionId: leadId,
      text: "queued before Chief preflight completes",
      createdAt: Date.now(),
    });
    blockedRefreshes = 2;
    const beforeStart = pi.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      context,
    );
    const overlappingBeforeStart = pi.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      context,
    );
    await waitForTestCondition(
      () => refreshStarted === 2,
      "Overlapping Chief preflights did not start",
    );
    assert.equal(context.isIdle(), true);
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    assert.equal(pi.sentMessageCalls.length, 0);
    assert.equal(
      listChiefMessagePaths(runtime, chiefId).some(
        (path) => readChiefMessage(path).id === messageId,
      ),
      true,
    );

    releaseBlocked.shift()!();
    const prepared = await beforeStart;
    assert.equal(
      prepared?.message?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.equal(pi.sentMessageCalls.length, 0);

    await pi.events.get("agent_start")![0](undefined, context);
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    assert.equal(pi.sentMessageCalls.length, 0);

    releaseBlocked.shift()!();
    const overlappingPrepared = await overlappingBeforeStart;
    assert.equal(
      overlappingPrepared?.message?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.equal(pi.sentMessageCalls.length, 0);

    await pi.events.get("agent_start")![0](undefined, context);
    await waitForTestCondition(
      () => pi.sentMessageCalls.length === 2,
      "Chief inbox delivery did not resume after agent_start",
      2000,
    );
    assert.equal(
      (pi.sentMessageCalls[0]?.message as any)?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.deepEqual(pi.sentMessageCalls[0]?.options, { triggerTurn: false });
    assert.match(
      String((pi.sentMessageCalls[1]?.message as any)?.content),
      /queued before Chief preflight completes/,
    );
    assert.deepEqual(pi.sentMessageCalls[1]?.options, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
  } finally {
    for (const release of releaseBlocked) release();
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("registered lead and replacement chief exchange messages and asks", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `supervision-contract-${randomUUID()}.sock`);
  const leadId = LEAD_SESSION_ID;
  const chiefId = `chief-${randomUUID()}`;
  const replacementId = `replacement-${randomUUID()}`;
  const sessionRoot = realFs.realpathSync(
    realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-contract-sessions-")),
  );
  const leadPath = join(sessionRoot, "lead.jsonl");
  const chiefPath = join(sessionRoot, "chief.jsonl");
  const replacementPath = join(sessionRoot, "replacement.jsonl");
  for (const path of [leadPath, chiefPath, replacementPath])
    writeFileSync(path, "{}", "utf8");
  nativeSessions.set(leadPath, { id: leadId, path: leadPath, entries: [] });
  nativeSessions.set(chiefPath, {
    id: chiefId,
    path: chiefPath,
    entries: [],
  });
  const leadAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: leadId,
    },
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    workspace_id: WORKSPACE,
    agent_status: "idle",
  };
  let chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: "chief-pane",
    tab_id: "chief-tab",
    workspace_id: WORKSPACE,
    agent_status: "idle",
  };
  const directAgent = {
    ...managedState("snapshot-direct-agent", REQUEST_ID, {
      ...recoveryIdentity("snapshot-direct-agent"),
      piSessionId: PARENT_SESSION_ID,
    }),
    ownerSessionId: leadId,
  };
  const descendantAgent = {
    ...managedState("snapshot-descendant-agent", REQUEST_ID, {
      ...recoveryIdentity("snapshot-descendant-agent"),
      piSessionId: CHILD_SESSION_ID,
    }),
    ownerSessionId: directAgent.piSessionId,
  };
  const directAgentMailbox = agentMailboxPath(
    WORKSPACE,
    directAgent.agentLabel,
  );
  const descendantAgentMailbox = agentMailboxPath(
    WORKSPACE,
    descendantAgent.agentLabel,
  );
  let duplicateChief = false;
  let nonPiIntegration = false;
  let unresolvableIdentity = false;
  let aliasAgent: any | undefined;
  let failChiefAliasLookup = false;
  let replacement: ReturnType<typeof fakePi> | undefined;
  const exec = (_command: string, args: string[]) => {
    if (isAgentList(args))
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            agents: [
              leadAgent,
              chiefAgent,
              agentFromState(directAgent, "working"),
              agentFromState(descendantAgent, "blocked"),
            ],
          },
        }),
        stderr: "",
        code: 0,
      };
    return args[0] === "agent" && args[1] === "get"
      ? failChiefAliasLookup && args[2] !== leadAgent.pane_id
        ? (() => {
            throw new Error("Chief alias lookup failed");
          })()
        : {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                agent:
                  args[2] === leadAgent.pane_id
                    ? leadAgent
                    : (aliasAgent ?? chiefAgent),
              },
            }),
            stderr: "",
            code: 0,
          }
      : isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [
                    leadAgent,
                    chiefAgent,
                    agentFromState(directAgent, "working"),
                    agentFromState(descendantAgent, "blocked"),
                    ...(unresolvableIdentity
                      ? [
                          {
                            agent: "pi",
                            pane_id: "unknown-pane",
                          },
                        ]
                      : []),
                    ...(nonPiIntegration
                      ? [
                          {
                            agent: "codex",
                            agent_session: {
                              source: "herdr:codex",
                              agent: "codex",
                              kind: "id",
                              value: "codex-session",
                            },
                            pane_id: "codex-pane",
                          },
                        ]
                      : []),
                    ...(duplicateChief
                      ? [{ ...chiefAgent, pane_id: "duplicate-chief-pane" }]
                      : []),
                  ],
                  panes: [
                    leadAgent,
                    chiefAgent,
                    agentFromState(directAgent, "working"),
                    agentFromState(descendantAgent, "blocked"),
                    ...(unresolvableIdentity
                      ? [{ agent: "pi", pane_id: "unknown-pane" }]
                      : []),
                    ...(nonPiIntegration
                      ? [
                          {
                            agent: "codex",
                            agent_session: {
                              source: "herdr:codex",
                              agent: "codex",
                              kind: "id",
                              value: "codex-session",
                            },
                            pane_id: "codex-pane",
                          },
                        ]
                      : []),
                    ...(duplicateChief
                      ? [{ ...chiefAgent, pane_id: "duplicate-chief-pane" }]
                      : []),
                  ],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 };
  };
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const lead = fakePi({ exec });
  registerExtension!(lead.pi as never);
  const leadContext = fakeContext() as any;
  let leadToolBatch = ["chief"];
  leadContext.sessionManager = {
    ...leadContext.sessionManager,
    getSessionId: () => leadId,
    getSessionFile: () => "/tmp/contract-lead.jsonl",
    getBranch: () => [
      {
        message: {
          role: "assistant",
          content: leadToolBatch.map((name) => ({ type: "toolCall", name })),
        },
      },
    ],
  };
  await lead.events.get("session_start")![0](undefined, leadContext);

  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  const chiefEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
    {
      type: "custom",
      customType: "pi-herdsman-lead-state",
      data: {},
    },
  ];
  const chief = fakePi({
    exec,
    entries: chiefEntries,
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(chief.pi as never);
  const chiefContext = fakeContext(chiefEntries) as any;
  chiefContext.sessionManager = {
    ...chiefContext.sessionManager,
    getSessionId: () => chiefId,
    getSessionFile: () => "/tmp/contract-chief.jsonl",
  };
  chiefContext.ui.notify = () => undefined;
  await chief.events.get("session_start")![0](undefined, chiefContext);
  const leadTool = lead.tools.find((tool) => tool.name === "chief");
  assert.ok(leadTool);
  const chiefTool = chief.tools.find((tool) => tool.name === "staff");
  assert.ok(chiefTool);
  assert.deepEqual(chief.pi.getActiveTools(), ["staff"]);
  const chiefLeadStateEntriesBeforeDelivery = chiefEntries.filter(
    (entry) => (entry as any).customType === "pi-herdsman-lead-state",
  );
  const attachment = join(tmpdir(), `chief-attachment-${randomUUID()}.md`);
  writeFileSync(attachment, "chief evidence\n", "utf8");

  try {
    writeAgentState(directAgentMailbox, directAgent);
    writeAgentState(descendantAgentMailbox, descendantAgent);
    const chiefStart = await chief.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      chiefContext,
    );
    await chief.events.get("agent_start")![0](undefined, chiefContext);
    const supervisionMessage = chiefStart?.message;
    assert.equal(
      supervisionMessage?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.equal(supervisionMessage?.display, false);
    assert.match(String(supervisionMessage?.content), /status="fresh"/);
    const leadFromSnapshot =
      supervisionMessage?.content.match(/^  lead: (.+)$/mu)?.[1];
    assert.equal(leadFromSnapshot, leadId);
    assert.match(supervisionMessage.content, /leads: 1/);
    assert.match(
      supervisionMessage.content,
      /agent_counts: active=1 blocked=1 total=2/,
    );
    assert.match(
      supervisionMessage.content,
      /snapshot-direct-agent · working · id=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/,
    );
    assert.match(
      supervisionMessage.content,
      /snapshot-descendant-agent · blocked · id=ffffffff-ffff-4fff-8fff-ffffffffffff/,
    );
    assert.doesNotMatch(
      supervisionMessage.content,
      /<herdsman_forest>|children|child_counts/,
    );
    const displayName =
      supervisionMessage.content.match(/^display_name: (.+)$/mu)?.[1];
    assert.ok(displayName);
    assert.notEqual(displayName, leadId);
    await assert.rejects(
      chiefTool.execute(
        "message",
        { action: "message", lead: displayName, message: "wrong target" },
        undefined,
        undefined,
        chiefContext,
      ),
      /Invalid staff action/,
    );
    const inspected = await chiefTool.execute(
      "inspect",
      { action: "inspect", lead: leadId },
      undefined,
      undefined,
      chiefContext,
    );
    assertToolResult(inspected);
    assert.equal(inspected.details?.action, "inspect");
    assert.equal(inspected.details?.lead, leadId);
    assert.equal(inspected.details?.recent_output_truncated, false);
    assert.ok(inspected.details?.identity);

    const queuedBeforePreparationRace = listChiefMessagePaths(
      supervisionRuntime(),
      leadId,
    );
    const chiefDescriptorPath = supervisionRuntime().descriptor;
    const chiefDescriptor = readFileSync(chiefDescriptorPath, "utf8");
    realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
    const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
    writeFileSync(configPath, "{}", "utf8");
    support.configReadHook = () =>
      writeFileSync(
        chiefDescriptorPath,
        JSON.stringify({
          ...JSON.parse(chiefDescriptor),
          leaseId: randomUUID(),
        }),
      );
    try {
      await assert.rejects(
        chiefTool.execute(
          "message",
          {
            action: "message",
            lead: leadId,
            message: "must not queue after authority changes",
            files: [attachment],
          },
          undefined,
          undefined,
          chiefContext,
        ),
        /Lead or Chief changed before the message was queued/,
      );
    } finally {
      support.configReadHook = undefined;
      writeFileSync(chiefDescriptorPath, chiefDescriptor);
      realFs.rmSync(configPath, { force: true });
    }
    assert.deepEqual(
      listChiefMessagePaths(supervisionRuntime(), leadId),
      queuedBeforePreparationRace,
    );

    const sent = await chiefTool.execute(
      "message",
      {
        action: "message",
        lead: leadFromSnapshot,
        message: "queued from the chief",
        files: [attachment],
      },
      undefined,
      undefined,
      chiefContext,
    );
    assertToolResult(sent);
    assert.equal(sent.details?.action, "message");
    assert.equal(sent.details?.lead, leadId);
    assert.equal(
      sent.details?.next_action,
      "Lead activity returns asynchronously; continue only independent chief work, otherwise end the turn. Do not poll.",
    );
    const sentAgain = await chiefTool.execute(
      "message",
      { action: "message", lead: leadId, message: "second from the chief" },
      undefined,
      undefined,
      chiefContext,
    );
    assertToolResult(sentAgain);
    const stateBeforeChiefDelivery = readLeadCoordinationState(
      supervisionRuntime(),
      leadId,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    assert.ok(
      lead.sentMessageCalls.some((call) =>
        /<file name="/.test(String(call.message?.content ?? "")),
      ),
    );
    assert.deepEqual(
      readLeadCoordinationState(supervisionRuntime(), leadId),
      stateBeforeChiefDelivery,
    );
    const chiefMessages = lead.sentMessageCalls
      .map((call) => String(call.message?.content))
      .filter((content) => content.includes("From chief"));
    assert.equal(chiefMessages.length, 2);
    assert.match(chiefMessages[0], /<file name=.*Message:/su);
    assert.equal(
      chiefMessages[1],
      "From chief " +
        chiefId +
        " to lead " +
        leadId +
        ": second from the chief",
    );

    const chiefDeliveryStart = chief.sentMessageCalls.length;
    const message = await leadTool.execute(
      "message",
      { action: "message", message: "progress update" },
      undefined,
      undefined,
      leadContext,
    );
    assertToolResult(message);
    await waitForTestCondition(
      () => {
        const calls = chief.sentMessageCalls.slice(chiefDeliveryStart);
        return (
          calls.some(
            (call) =>
              (call.message as any)?.customType ===
              "pi-herdsman-supervision-context",
          ) &&
          calls.some((call) =>
            /From lead .* to chief .*progress update/.test(
              String((call.message as any)?.content ?? ""),
            ),
          )
        );
      },
      "Chief did not receive supervision context and the lead follow-up",
      2000,
    );
    const deliveryCalls = chief.sentMessageCalls.slice(chiefDeliveryStart);
    assert.equal(
      (deliveryCalls[0]?.message as any)?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.deepEqual(deliveryCalls[0]?.options, { triggerTurn: false });
    assert.match(
      String((deliveryCalls[1]?.message as any)?.content),
      /From lead .* to chief .*progress update/,
    );
    assert.deepEqual(deliveryCalls[1]?.options, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
    // A chief receiving a lead message must not mutate its persisted lead
    // state. If it later leaves and resumes as a lead, receipt must not have
    // changed its pending ask.
    assert.deepEqual(
      chiefEntries.filter(
        (entry) => (entry as any).customType === "pi-herdsman-lead-state",
      ),
      chiefLeadStateEntriesBeforeDelivery,
    );

    const beforeMixedBatchAskState = readLeadCoordinationState(
      supervisionRuntime(),
      leadId,
    );
    const beforeMixedBatchAskMessages = listChiefMessagePaths(
      supervisionRuntime(),
      chiefId,
    );
    leadToolBatch = ["chief", "agent"];
    await assert.rejects(
      leadTool.execute(
        "ask",
        {
          action: "ask",
          question: "This mixed batch must not be published.",
        },
        undefined,
        undefined,
        leadContext,
      ),
      /Call chief ask alone as the final tool call of the turn/,
    );
    assert.deepEqual(
      readLeadCoordinationState(supervisionRuntime(), leadId),
      beforeMixedBatchAskState,
    );
    assert.deepEqual(
      listChiefMessagePaths(supervisionRuntime(), chiefId),
      beforeMixedBatchAskMessages,
    );
    leadToolBatch = ["chief"];
    const ask = await leadTool.execute(
      "ask",
      {
        action: "ask",
        question: "Which credential should I use?",
        files: [attachment],
      },
      undefined,
      undefined,
      leadContext,
    );
    assertToolResult(ask);
    assert.equal((ask as any).terminate, true);
    const askId = ask.details.askId as string;
    const state = readLeadCoordinationState(supervisionRuntime(), leadId);
    assert.equal(state?.pendingAsk?.askId, askId);
    assert.equal(state?.pendingAsk?.question, "Which credential should I use?");
    assert.match(state?.pendingAsk?.text ?? "", /<file name="/);
    const missingAskPath = listChiefMessagePaths(
      supervisionRuntime(),
      chiefId,
    ).find((path) => {
      const record = readChiefMessage(path);
      return record.kind === "lead_ask" && record.askId === askId;
    });
    assert.ok(missingAskPath);
    const missingAsk = readChiefMessage(missingAskPath);
    removeChiefMessage(
      supervisionRuntime(),
      chiefId,
      missingAsk.id,
      missingAsk,
    );
    assert.equal(
      listChiefMessagePaths(supervisionRuntime(), chiefId).some((path) => {
        const record = readChiefMessage(path);
        return record.kind === "lead_ask" && record.askId === askId;
      }),
      false,
    );
    await chief.events.get("before_agent_start")![0](
      { systemPromptOptions: { contextFiles: [] } },
      chiefContext,
    );
    await chief.events.get("agent_start")![0](undefined, chiefContext);
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    const repairedAskDeliveries = chief.sentMessageCalls.filter((call) =>
      /From lead .*<file name=.*Which credential should I use\?/su.test(
        String(call.message?.content ?? ""),
      ),
    );
    assert.equal(repairedAskDeliveries.length, 1);
    const projection = await chiefTool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      chiefContext,
    );
    assertToolResult(projection);
    assert.equal(Array.isArray(projection.details?.leads), true);
    assert.equal((projection.details?.leads as any[]).length, 1);
    const projectedLead = (projection.details?.leads as any[]).find(
      (lead: any) => lead.lead === leadId,
    );
    assert.ok(projectedLead);
    assert.deepEqual(projectedLead.agent_counts, {
      active: 1,
      blocked: 1,
      total: 2,
    });
    assert.deepEqual(
      projectedLead.agents
        .map((agent: any) => ({
          id: agent.id,
          label: agent.label,
          state: agent.state,
        }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id)),
      [
        {
          id: PARENT_SESSION_ID,
          label: "snapshot-direct-agent",
          state: "working",
        },
        {
          id: CHILD_SESSION_ID,
          label: "snapshot-descendant-agent",
          state: "blocked",
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    assert.equal(projectedLead.needs_you, true);
    assert.equal(projectedLead.pending_ask_id, askId);
    assert.equal(
      projectedLead.pending_ask_question,
      "Which credential should I use?",
    );

    await chief.events.get("session_shutdown")![0]();
    assert.deepEqual(
      chiefEntries.filter(
        (entry) => (entry as any).customType === "pi-herdsman-lead-state",
      ),
      chiefLeadStateEntriesBeforeDelivery,
    );
    await assert.rejects(
      chiefTool.execute(
        "list",
        { action: "list" },
        undefined,
        undefined,
        chiefContext,
      ),
      /active chief/,
    );
    chiefAgent = {
      ...chiefAgent,
      pane_id: "replacement-pane",
      tab_id: "replacement-tab",
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: replacementId,
      },
    };
    nativeSessions.set(replacementPath, {
      id: replacementId,
      path: replacementPath,
      entries: [],
    });
    process.env.HERDR_PANE_ID = "replacement-pane";
    process.env.HERDR_TAB_ID = "replacement-tab";
    const replacementEntries = [...chiefEntries];
    replacement = fakePi({
      exec,
      entries: replacementEntries,
      allTools: REGISTERED_ROLE_TOOLS,
    });
    registerExtension!(replacement.pi as never);
    const replacementContext = fakeContext(replacementEntries) as any;
    replacementContext.sessionManager = {
      ...replacementContext.sessionManager,
      getSessionId: () => replacementId,
      getSessionFile: () => "/tmp/contract-replacement.jsonl",
    };
    replacementContext.ui.notify = () => undefined;
    await replacement.events.get("session_start")![0](
      undefined,
      replacementContext,
    );
    const replacementTool = replacement.tools.find(
      (tool) => tool.name === "staff",
    );
    assert.ok(replacementTool);
    const reply = await replacementTool.execute(
      "reply",
      {
        action: "reply",
        lead: leadId,
        askId,
        message: "Use the service account.",
        files: [attachment],
      },
      undefined,
      undefined,
      replacementContext,
    );
    assertToolResult(reply);
    assert.equal(
      reply.details?.next_action,
      "Lead activity returns asynchronously; continue only independent chief work, otherwise end the turn. Do not poll.",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    assert.equal(
      readLeadCoordinationState(supervisionRuntime(), leadId)?.pendingAsk,
      undefined,
    );
    assert.match(
      String(lead.sentMessageCalls.at(-1)?.message?.content),
      /From chief .* to lead .*Use the service account/s,
    );
    const beforeFailedAsk = readLeadCoordinationState(
      supervisionRuntime(),
      leadId,
    );
    chiefAgent = { ...chiefAgent, pane_id: "stale-pane" };
    await assert.rejects(
      leadTool.execute(
        "ask",
        { action: "ask", question: "This moved Chief must be rejected." },
        undefined,
        undefined,
        leadContext,
      ),
      /No active chief is available/,
    );
    const afterFailedAsk = readLeadCoordinationState(
      supervisionRuntime(),
      leadId,
    );
    assert.deepEqual(afterFailedAsk, beforeFailedAsk);
    duplicateChief = true;
    await assert.rejects(
      leadTool.execute(
        "message",
        { action: "message", message: "ambiguous Chief" },
        undefined,
        undefined,
        leadContext,
      ),
      /No active chief/,
    );
    duplicateChief = false;
    nonPiIntegration = true;
    const nonPiDiagnosticList = await replacementTool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      replacementContext,
    );
    assertToolResult(nonPiDiagnosticList);
    assert.equal(nonPiDiagnosticList.details?.diagnostics, undefined);
    nonPiIntegration = false;
    unresolvableIdentity = true;
    const diagnosticList = await replacementTool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      replacementContext,
    );
    assertToolResult(diagnosticList);
    assert.deepEqual(diagnosticList.details?.diagnostics, [
      "Live Pi agents are present but their session identities are unresolvable",
    ]);
    unresolvableIdentity = false;
    aliasAgent = {
      ...chiefAgent,
      agent_session: { kind: "id", value: "different-chief-session" },
    };
    await assert.rejects(
      leadTool.execute(
        "message",
        { action: "message", message: "inconsistent Chief alias" },
        undefined,
        undefined,
        leadContext,
      ),
      /descriptor exists but its live Pi identity could not be verified/,
    );
    chiefAgent = {
      ...chiefAgent,
      pane_id: "replacement-pane",
      tab_id: "replacement-tab",
      workspace_id: WORKSPACE,
    };
    aliasAgent = {
      ...chiefAgent,
      pane_id: "replacement-pane",
      tab_id: "replacement-tab",
      workspace_id: WORKSPACE,
    };
    const movedMessage = await leadTool.execute(
      "message",
      { action: "message", message: "chief moved but remains valid" },
      undefined,
      undefined,
      leadContext,
    );
    assertToolResult(movedMessage);
    aliasAgent = undefined;
    failChiefAliasLookup = true;
    await assert.rejects(
      leadTool.execute(
        "message",
        { action: "message", message: "failed Chief alias lookup" },
        undefined,
        undefined,
        leadContext,
      ),
      /descriptor exists but its live Pi identity could not be verified/,
    );
    failChiefAliasLookup = false;
    const staleLead = { ...afterFailedAsk!, instanceId: randomUUID() };
    writeLeadCoordinationState(supervisionRuntime(), staleLead);
    await assert.rejects(
      leadTool.execute(
        "message",
        { action: "message", message: "stale generation" },
        undefined,
        undefined,
        leadContext,
      ),
      /Lead coordination state changed/,
    );
    await replacement.events.get("session_shutdown")?.[0]();
  } finally {
    await replacement?.events.get("session_shutdown")?.[0]();
    await lead.events.get("session_shutdown")?.[0]();
    await chief.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
    nativeSessions.delete(leadPath);
    nativeSessions.delete(chiefPath);
    nativeSessions.delete(replacementPath);
    realFs.rmSync(sessionRoot, { recursive: true, force: true });
    resetAgentMailbox(directAgentMailbox);
    resetAgentMailbox(descendantAgentMailbox);
  }
});

test("lead metadata omits coordination state and follows session names", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const pi = fakePi({ sessionName: "first name" });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  const metadata = pi.calls.find(
    (args) => args[0] === "pane" && args[1] === "report-metadata",
  );
  assert.ok(metadata);
  assert.ok(metadata.includes("pi_herdsman_role=lead"));
  assert.ok(
    !metadata.some((value) => value.includes("pi_herdsman_availability")),
  );
  assert.ok(metadata.includes("pi_herdsman_name=first name"));
  await pi.events.get("session_info_changed")![0]({ name: "renamed" }, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(pi.calls.some((args) => args.includes("pi_herdsman_name=renamed")));
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
});

test("lead restart creates a fresh coordination generation but restores state", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-restart-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-lead-state",
      data: {
        pendingAsk: {
          askId: "11111111-1111-4111-8111-111111111111",
          question: "Need a decision",
          text: "Question: Need a decision",
        },
      },
    },
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  const first = readLeadCoordinationState(
    supervisionRuntime(),
    context.sessionManager.getSessionId(),
  );
  assert.ok(first);
  await start(undefined, context);
  const second = readLeadCoordinationState(
    supervisionRuntime(),
    context.sessionManager.getSessionId(),
  );
  assert.ok(second);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.deepEqual(second.pendingAsk, first.pendingAsk);
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_SOCKET_PATH;
});

test("malformed persisted role fails closed without authoritative lead state", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-malformed-role-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "not-a-role" },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: ["agent", "chief"],
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["agent", "peer"]);
  assert.equal(
    readLeadCoordinationState(
      supervisionRuntime(),
      context.sessionManager.getSessionId(),
    ),
    undefined,
  );
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" && entry.data?.error,
    ),
  );
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_SOCKET_PATH;
});

test("malformed definitions do not abort ordinary lead startup", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const malformed = join(PI_AGENTS_DIR, "malformed.md");
  writeFileSync(
    malformed,
    "---\nname: malformed\nmodel: {not valid json\n---\nmalformed\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.ok(
      pi.calls.some((args) => isApiSnapshot(args)),
      "agent recovery must still run after roster discovery fails",
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_definition_error" &&
          /malformed/.test(entry.data?.error),
      ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(malformed, { force: true });
    delete process.env.HERDR_PANE_ID;
  }
});

test("persisted Chief startup skips agent definition discovery", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-malformed-chief-roster-${randomUUID()}.sock`,
  );
  const malformed = join(PI_AGENTS_DIR, "malformed.md");
  writeFileSync(
    malformed,
    "---\nname: malformed\nmodel: {not valid json\n---\nmalformed\n",
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: ["agent", "chief"],
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_definition_error",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(malformed, { force: true });
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("chief guidance carries the lead coordination contract", () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const tool = pi.tools.find((candidate) => candidate.name === "chief");
  assert.ok(tool);
  const description = tool.description.replaceAll(/\s+/g, " ");
  for (const expected of [
    /meaningful progress, results, warnings, and completion, including exact artifact paths/,
    /ask when a chief decision is genuinely required; call ask alone as the final tool call of the turn, then stop and wait for the reply/,
    /Chief messages arrive as follow-ups/,
    /Questions are limited to 1,024 characters and 1,024 UTF-8 bytes; channel message records are bounded to 8 KiB, so multibyte content can hit the byte limit first/,
    /Descendants use ask_owner, never chief/,
  ])
    assert.match(description, expected);
  delete process.env.HERDR_PANE_ID;
});

test("definition roster matches live list and rejects stale sessions", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const pi = fakePi({
    exec: (_command, args) =>
      isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  let sessionId = context.sessionManager.getSessionId();
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  await pi.events.get("session_start")![0](undefined, context);
  const prompt = await pi.events.get("before_agent_start")![0](
    { systemPrompt: "base" },
    context,
  );
  assert.match(prompt?.systemPrompt ?? "", /## Available agent definitions/);
  assert.match(prompt?.systemPrompt ?? "", /<agent_definitions>/);
  const roster = JSON.parse(
    prompt.systemPrompt.match(
      /<agent_definitions>\n([\s\S]*?)\n<\/agent_definitions>/,
    )[1],
  );
  const listResult = await pi.tools
    .find((tool) => tool.name === "agent")!
    .execute("list", { action: "list" }, undefined, undefined, context);
  assert.deepEqual(roster, listResult.details.agent_definitions);
  sessionId = randomUUID();
  assert.equal(
    await pi.events.get("before_agent_start")![0](
      { systemPrompt: "base" },
      context,
    ),
    undefined,
  );
  await pi.events.get("session_start")![0](undefined, context);
  const restartedPrompt = await pi.events.get("before_agent_start")![0](
    { systemPrompt: "base" },
    context,
  );
  assert.match(restartedPrompt?.systemPrompt ?? "", /<agent_definitions>/);
  assert.equal(pi.events.has("context"), false);
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
});

test("delegating agents receive only their allowed definition roster", async () => {
  const mailbox = setAgentEnvironment("delegating-agent", ["scout"]);
  const controllerState = {
    ...managedState("delegating-agent"),
    piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const entries = [
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
  const pi = fakePi({
    entries,
    exec: agentControllerExecutor(controllerState),
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries) as any;
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
  assert.equal(pi.events.has("context"), true);
  const prompt = await pi.events.get("before_agent_start")![0](
    { systemPrompt: "base" },
    context,
  );
  assert.match(prompt?.systemPrompt ?? "", /<agent_definitions>/);
  const roster = JSON.parse(
    prompt.systemPrompt.match(
      /<agent_definitions>\n([\s\S]*?)\n<\/agent_definitions>/,
    )[1],
  );
  assert.deepEqual(
    roster.map((definition: Record<string, unknown>) => definition.name),
    ["scout"],
  );
  const listResult = await pi.tools
    .find((tool) => tool.name === "agent")!
    .execute("list", { action: "list" }, undefined, undefined, context);
  assert.deepEqual(roster, listResult.details.agent_definitions);
  const description = pi.tools
    .find((tool) => tool.name === "agent")!
    .description.replaceAll(/\s+/g, " ");
  assert.match(
    description,
    /ask_owner follows its normal eligibility rules when you have no unresolved direct-agent work/,
  );
  assert.match(
    description,
    /every such agent must itself be validly waiting on an owner answer/,
  );
  assert.match(
    description,
    /ordinary active or pending-result agent work still blocks escalation/,
  );
  assert.match(description, /Own the assigned objective/);
  assert.match(
    description,
    /execution scope is limited to the non-delegated remainder/,
  );
  assert.match(
    description,
    /Each unresolved unit of work has one executor\. Delegating a scope transfers its execution ownership to that agent until the assignment resolves\. After delegation succeeds, stop executing, inspecting, or analyzing that delegated scope locally; do not assign overlapping work\. Continue only concrete, necessary work clearly outside the delegated scope that you still own\./,
  );
  assert.doesNotMatch(description, /sole executor/);
  assert.doesNotMatch(
    description,
    /Escalate to your direct owner only when unresolved direct-agent work/,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("leaf agents and active Chiefs do not receive agent definition rosters", async () => {
  const mailbox = setAgentEnvironment("leaf-agent");
  const leaf = fakePi();
  registerExtension!(leaf.pi as never);
  assert.equal(leaf.events.has("before_agent_start"), false);
  leaf.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);

  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-roster-chief-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const chief = fakePi({
    entries,
    activeTools: ["agent", "chief"],
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(chief.pi as never);
  const context = fakeContext(entries) as any;
  await chief.events.get("session_start")![0](undefined, context);
  const prompt = await chief.events.get("before_agent_start")![0](
    { systemPromptOptions: { contextFiles: [] } },
    context,
  );
  assert.match(prompt?.systemPrompt ?? "", /Chief/);
  assert.doesNotMatch(prompt?.systemPrompt ?? "", /<agent_definitions>/);
  assert.equal(prompt?.message?.customType, "pi-herdsman-supervision-context");
  assert.equal(prompt?.message?.display, false);
  assert.match(String(prompt?.message?.content), /status="fresh"/);
  chief.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_SOCKET_PATH;
});

test("first failed chief supervision refresh is explicitly unavailable", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-unavailable-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief", leadTools: ["agent", "chief"] },
    },
  ];
  const pi = fakePi({
    entries,
    allTools: REGISTERED_ROLE_TOOLS,
    exec: () => {
      throw new Error("supervision unavailable");
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  const result = await pi.events.get("before_agent_start")![0](
    { systemPromptOptions: { contextFiles: [] } },
    context,
  );
  assert.equal(result?.message?.customType, "pi-herdsman-supervision-context");
  assert.equal(result?.message?.display, false);
  assert.match(String(result?.message?.content), /status="unavailable"/);
  assert.match(
    String(result?.message?.content),
    /Do not infer that there are zero leads/,
  );
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_TAB_ID;
  setLeadEnvironment();
});

test("lead metadata reports preserve session event order", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  let releaseFirst!: () => void;
  const firstReport = new Promise<void>((resolve) => (releaseFirst = resolve));
  let reportCount = 0;
  const pi = fakePi({
    sessionName: "first name",
    exec: async (command, args) => {
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "report-metadata"
      ) {
        reportCount++;
        if (reportCount === 1) await firstReport;
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  const started = pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await pi.events.get("session_info_changed")![0](
    { name: "new name" },
    context,
  );
  releaseFirst();
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const reports = pi.calls.filter(
    (args) => args[0] === "pane" && args[1] === "report-metadata",
  );
  assert.equal(reports.length, 2);
  assert.ok(reports[0].includes("pi_herdsman_name=first name"));
  assert.ok(reports[1].includes("pi_herdsman_name=new name"));
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
});

test("lead metadata failures do not escape the serialized queue", async () => {
  for (const [label, firstResult] of [
    ["empty output", { stdout: "", stderr: "", code: 0 }],
    ["rejected exec", new Error("metadata unavailable")],
  ] as const) {
    setLeadEnvironment();
    process.env.HERDR_PANE_ID = "lead-pane";
    process.env.HERDR_SOCKET_PATH = join(
      tmpdir(),
      `metadata-${randomUUID()}.sock`,
    );
    let metadataCalls = 0;
    const pi = fakePi({
      exec: async (command, args) => {
        if (
          command === "herdr" &&
          args[0] === "pane" &&
          args[1] === "report-metadata"
        ) {
          metadataCalls++;
          if (metadataCalls === 1) {
            if (firstResult instanceof Error) throw firstResult;
            return firstResult;
          }
        }
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      registerExtension!(pi.pi as never);
      const context = fakeContext() as any;
      await pi.events.get("session_start")![0](undefined, context);
      assert.ok(pi.tools.some((tool) => tool.name === "chief"));
      assert.equal(
        readLeadCoordinationState(
          supervisionRuntime(),
          context.sessionManager.getSessionId(),
        )?.pendingAsk,
        undefined,
      );
      await pi.events.get("session_info_changed")![0]({ name: label }, context);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(unhandled.length, 0);
      assert.equal(metadataCalls, 2);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_PANE_ID;
      delete process.env.HERDR_SOCKET_PATH;
    }
  }
});

test("delegation-enabled agents do not receive the lead agents command", () => {
  setAgentEnvironment("delegating-agent", ["agents"]);
  const parent = fakePi();
  registerExtension!(parent.pi as never);
  assert.deepEqual(parent.commands, []);
});

test("list ignores an unrelated unnamed Herdr agent", async () => {
  setLeadEnvironment();

  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: [
                  {
                    workspace_id: WORKSPACE,
                    pane_id: "lead-pane",
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: LEAD_SESSION_ID,
                    },
                    // intentionally no name / herdr_agent
                  },
                ],
                panes: [
                  {
                    pane_id: "lead-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: LEAD_SESSION_ID,
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

  const result = await pi.tools[0].execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    fakeContext(),
  );

  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.agents, []);
});

test("invalid agent owner identity registers no managed agent hooks", () => {
  const mailbox = setAgentEnvironment();
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = "not-a-session-id";
  const invalid = fakePi();
  registerExtension!(invalid.pi as never);
  assert.equal(invalid.tools.length, 0);
  assert.equal(invalid.events.has("before_agent_start"), false);
  assert.equal(invalid.events.size, 1);
  assert.equal(readAgentState(mailbox), undefined);
});

test("invalid mailbox-intent agent environment reports the exact field", async () => {
  const mailbox = setAgentEnvironment();
  process.env.HERDR_PANE_ID = "";
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  assert.equal(agent.tools.length, 0);
  const starts = agent.events.get("session_start") ?? [];
  assert.equal(starts.length, 1);
  await starts[0](undefined, fakeAgentContext(agent.entries));
  const errorEntry = agent.entries.find(
    (entry: any) => entry.customType === "pi_herdsman_state_error",
  ) as any;
  assert.ok(errorEntry);
  assert.match(errorEntry.data.error, /HERDR_PANE_ID missing/);
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("managed non-TUI agents do not receive the widget", async () => {
  const mailbox = setAgentEnvironment("non-tui-agent");
  const pi = fakePi();
  const context = fakeAgentContext() as any;
  context.mode = "rpc";
  let registrations = 0;
  context.ui = {
    setWidget: () => registrations++,
    notify: () => undefined,
    select: async () => "tab",
  };
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(registrations, 0);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("registered agent inspect exposes process and recent activity evidence", async () => {
  setLeadEnvironment();
  const label = "inspect-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = managedState(label, undefined, identity);
  writeAgentState(mailbox, state);
  const baseExec = agentControllerExecutor(state);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: agentFromState(state) },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "read")
        return {
          stdout: "unique-inspect-marker\n",
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
                pane_id: identity.paneId,
                shell_pid: 123,
                foreground_process_group_id: 456,
                foreground_processes: [
                  { pid: 789, argv0: "sleep", cmdline: "sleep 600" },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return baseExec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  const tool = pi.tools.find((candidate) => candidate.name === "agent");
  assert.ok(tool);
  try {
    const result = await tool.execute(
      "inspect-fixture",
      { action: "inspect", agent: label },
      undefined,
      undefined,
      context,
    );
    const text = result.content[0].text;
    assert.match(text, new RegExp(`Inspect agent ${label}`));
    assert.match(text, new RegExp(`Session: ${identity.piSessionId}`));
    assert.match(text, new RegExp(`Pane: ${identity.paneId}`));
    assert.match(text, /sleep 600/);
    assert.match(text, /unique-inspect-marker/);
    assert.equal(result.details.recent_output, "unique-inspect-marker");
    assert.equal(result.details.recent_output_truncated, false);
    assert.equal(
      result.details.process.foreground_processes[0].cmdline,
      "sleep 600",
    );
    const expanded = tool.renderResult(
      { content: result.content, details: result.details },
      { expanded: true, isPartial: false },
      { fg: (_color: string, value: string) => value },
      { args: { action: "inspect", agent: label } },
    );
    assert.match(expanded.text, /sleep 600/);
    assert.match(expanded.text, /unique-inspect-marker/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    setLeadEnvironment();
  }
});

test("agent input accepts only the v3 Herdr control marker", async () => {
  const mailbox = setAgentEnvironment("reserved-input-agent");
  const agent = fakePi();
  const context = fakeAgentContext();
  try {
    registerExtension!(agent.pi as never);
    await agent.events.get("session_start")![0](undefined, context);
    const started = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: started.runId,
      requestId: REQUEST_ID,
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: "task",
      text: "process this assignment",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    const input = agent.events.get("input")![0];

    assert.deepEqual(input({ text: "ordinary" }, context), {
      action: "continue",
    });
    assert.deepEqual(input({ text: controlMarker(REQUEST_ID) }, context), {
      action: "transform",
      text: request.text,
    });
    assert.deepEqual(
      input({ text: `__HERDR_SUBAGENT_V1__:${REQUEST_ID}` }, context),
      { action: "continue" },
    );
    assert.deepEqual(
      input({ text: `__HERDR_SUBAGENT_V2__:${REQUEST_ID}` }, context),
      { action: "continue" },
    );
    assert.deepEqual(
      input({ text: "__PI_HERDSMAN_AGENT_V4__:malformed" }, context),
      { action: "handled" },
    );
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    setLeadEnvironment();
  }
});

test("delivered owner asks retain the question in visible message details", async () => {
  setLeadEnvironment();
  const label = "ask-details-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const ask: AskRecord = {
    version: 4,
    askId: "99999999-9999-4999-8999-999999999999",
    requestId: REQUEST_ID,
    runId: managedState(label, REQUEST_ID, identity).runId,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    piSessionId: identity.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  };
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    pendingAskId: ask.askId,
  });
  writeAsk(mailbox, ask);
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  const branch: unknown[] = [];
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext([], branch),
    );
    assert.deepEqual((pi.sent[0] as any)?.details, {
      askId: ask.askId,
      question: ask.question,
      requestId: ask.requestId,
      runId: ask.runId,
      agentLabel: ask.agentLabel,
      workspaceId: ask.workspaceId,
      paneId: ask.paneId,
      piSessionId: ask.piSessionId,
    });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("registered delegate embeds text and references binary evidence", async () => {
  setLeadEnvironment();
  const label = "mixed-files-agent";
  const textPath = join(testTmpRoot, `${label}.md`);
  const binaryPath = join(testTmpRoot, `${label}.bin`);
  realFs.writeFileSync(textPath, "complete evidence");
  realFs.writeFileSync(binaryPath, Buffer.from([0, 1, 2]));
  let prompted = "";
  let submittedRequest: RequestRecord | undefined;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text, request) => {
      prompted = text;
      submittedRequest = request;
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "Inspect these.",
        files: [textPath, binaryPath],
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(submittedRequest?.kind, "task");
    assert.match(submittedRequest?.text ?? "", /complete evidence/);
    assert.match(
      submittedRequest?.text ?? "",
      new RegExp(
        `<file name=${JSON.stringify(realFs.realpathSync(binaryPath))} bytes="3" />`,
      ),
    );
    assert.equal(prompted, submittedRequest?.text);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(textPath, { force: true });
    realFs.rmSync(binaryPath, { force: true });
  }
});
