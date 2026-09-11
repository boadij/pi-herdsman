import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  claimChiefLease,
  removeChiefMessage,
  readChiefMessage,
  listChiefMessagePaths,
  supervisionRuntime,
  readLeadCoordinationState,
  writeLeadCoordinationState,
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
  skillBlock,
  startupExecutor,
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

test("Herdr preflight gates server compatibility, not private server version", async () => {
  const run = async (server: Record<string, unknown>) => {
    setLeadEnvironment();
    const label = `preflight-${randomUUID().slice(0, 8)}`;
    const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
    const pi = fakePi({
      exec: startup.exec,
      status: {
        code: 0,
        stdout: JSON.stringify({
          client: { version: "0.9.0" },
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

test("registered lead and unmanaged roles expose the correct surface", () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const lead = fakePi();
  registerExtension!(lead.pi as never);
  assert.deepEqual(lead.commands.sort(), ["agents", "chief"]);
  assert.deepEqual(lead.tools.map((tool) => tool.name).sort(), [
    "agent",
    "chief",
  ]);
  assert.equal(
    lead.tools.find((tool) => tool.name === "chief")?.label,
    "chief",
  );
  assert.equal(
    lead.tools.find((tool) => tool.name === "agent")?.label,
    "agent",
  );
  const agentTool = lead.tools.find((tool) => tool.name === "agent");
  const chiefTool = lead.tools.find((tool) => tool.name === "chief");
  assert.equal(typeof agentTool?.renderCall, "function");
  assert.equal(typeof agentTool?.renderResult, "function");
  assert.equal(typeof chiefTool?.renderCall, "function");
  assert.equal(typeof chiefTool?.renderResult, "function");
  assert.deepEqual(
    lead.messageRenderers.map(({ customType }) => customType).sort(),
    [
      "pi-herdsman-agent-ask",
      "pi-herdsman-agent-result",
      "pi-herdsman-agent-stale",
      "pi-herdsman-stop-summary",
    ],
  );
  assert.ok(lead.tools.every((tool) => tool.executionMode === "sequential"));
  assert.equal(lead.commands.includes("subagents"), false);
  assert.equal(lead.commands.includes("herdsman"), false);
  assert.equal(
    lead.tools.some((tool) =>
      ["subagent", "chief_of_staff", "herdsman"].includes(tool.name),
    ),
    false,
  );
  assert.equal(lead.events.has("before_agent_start"), true);
  assert.ok(lead.events.has("session_start"));
  assert.ok(lead.events.has("session_shutdown"));

  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  const unmanaged = fakePi();
  registerExtension!(unmanaged.pi as never);
  assert.equal(unmanaged.commands.length, 0);
  assert.equal(
    unmanaged.tools.some((tool) => tool.name === "agent"),
    false,
  );
  assert.equal(unmanaged.events.size, 0);
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
      data: { role: "chief" },
    },
  ];
  const pi = fakePi({ entries, activeTools: ["agent", "chief"] });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  await pi.events.get("session_start")![0](undefined, context);
  const tool = pi.tools.find((candidate) => candidate.name === "staff");
  assert.ok(tool);
  assert.equal(tool.label, "staff");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
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
  const chiefPrompt = pi.events.get("before_agent_start")![0](
    { systemPromptOptions: { contextFiles: [] } },
    context,
  )?.systemPrompt;
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
    /For general state questions and ordinary messages or replies, use a fresh snapshot directly; do not call staff list, inspect, or another read command first/,
    /The message and reply actions revalidate exact identity and state themselves/,
    /Every exact-identity-verified lead accepts message/,
    /reply only with the exact pending ask ID and current chief lease/,
    /Messages are bounded and direction-aware, and temporary verification or delivery failures retain queued records/,
    /Metadata is presentation-only and never authority/,
    /Human conversation remains the dispatch surface/,
  ])
    assert.match(description, expected);
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
  const context = fakeContext() as any;
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

test("a replacement chief never falls back to the previous session supervision", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-replacement-context-${randomUUID()}.sock`,
  );
  const entries = [
    { type: "custom", customType: "pi-herdsman-role", data: { role: "chief" } },
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
    exec: (_command, args) => {
      if (failRefresh && isAgentList(args))
        throw new Error("supervision unavailable");
      return isAgentList(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [leadAgent] },
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
  const agentStart = pi.events.get("agent_start")![0];
  try {
    await sessionStart(undefined, context);
    await agentStart(undefined, context);
    assert.match(
      pi.events.get("context")![0]({ messages: [] }, context).messages.at(-1)
        .content,
      /status="fresh"/,
    );

    sessionId = chiefB;
    failRefresh = true;
    await sessionStart(undefined, context);
    await agentStart(undefined, context);
    const message = pi.events
      .get("context")![0]({ messages: [] }, context)
      .messages.at(-1);
    assert.match(message.content, /status="unavailable"/);
    assert.doesNotMatch(message.content, /status="stale"/);
    assert.doesNotMatch(message.content, new RegExp(leadId));
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
    { type: "custom", customType: "pi-herdsman-role", data: { role: "chief" } },
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
    exec: async (_command, args) => {
      if (isAgentList(args) && blockNextRefresh) {
        blockNextRefresh = false;
        return new Promise((resolve) => {
          releaseBlocked = () =>
            resolve({
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: { agents: [leadAgent] },
              }),
              stderr: "",
              code: 0,
            });
        });
      }
      if (failRefresh && isAgentList(args))
        throw new Error("supervision unavailable");
      return isAgentList(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [leadAgent] },
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
  const agentStart = pi.events.get("agent_start")![0];
  try {
    await sessionStart(undefined, context);
    await agentStart(undefined, context);
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
    await agentStart(undefined, context);
    const message = pi.events
      .get("context")![0]({ messages: [] }, context)
      .messages.at(-1);
    assert.match(message.content, /status="unavailable"/);
    assert.doesNotMatch(message.content, /status="stale"/);
    assert.doesNotMatch(message.content, new RegExp(leadId));
  } finally {
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
      kind: "path",
      value: leadPath,
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
      kind: "path",
      value: chiefPath,
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
  const exec = (_command: string, args: string[]) =>
    args[0] === "agent" && args[1] === "get"
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
      : isAgentList(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
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
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 };
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  const lead = fakePi({ exec });
  registerExtension!(lead.pi as never);
  const leadContext = fakeContext() as any;
  leadContext.sessionManager = {
    ...leadContext.sessionManager,
    getSessionId: () => leadId,
    getSessionFile: () => "/tmp/contract-lead.jsonl",
  };
  await lead.events.get("session_start")![0](undefined, leadContext);

  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  const chiefEntries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief" },
    },
    {
      type: "custom",
      customType: "pi-herdsman-lead-state",
      data: {},
    },
  ];
  const chief = fakePi({ exec, entries: chiefEntries });
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
    await chief.events.get("agent_start")![0](undefined, chiefContext);
    const supervisionMessage = chief.events
      .get("context")![0]({ messages: [] }, chiefContext)
      .messages.at(-1);
    const leadFromSnapshot =
      supervisionMessage.content.match(/^  lead: (.+)$/mu)?.[1];
    assert.equal(leadFromSnapshot, leadId);
    assert.match(supervisionMessage.content, /leads: 1/);
    assert.match(
      supervisionMessage.content,
      /agent_counts: working=1 blocked=1 total=2/,
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
    support.settingsAccessHook = (access) => {
      if (access === "global")
        writeFileSync(
          chiefDescriptorPath,
          JSON.stringify({
            ...JSON.parse(chiefDescriptor),
            leaseId: randomUUID(),
          }),
        );
    };
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
      support.settingsAccessHook = undefined;
      writeFileSync(chiefDescriptorPath, chiefDescriptor);
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

    const message = await leadTool.execute(
      "message",
      { action: "message", message: "progress update" },
      undefined,
      undefined,
      leadContext,
    );
    assertToolResult(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    assert.match(
      String(chief.sentMessageCalls[0]?.message?.content),
      /From lead .* to chief .*progress update/,
    );
    assert.deepEqual(chief.sentMessageCalls[0]?.options, {
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
      working: 1,
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
    const replacement = fakePi({ exec, entries: replacementEntries });
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
    replacement.events.get("session_shutdown")?.[0]();
  } finally {
    lead.events.get("session_shutdown")?.[0]();
    chief.events.get("session_shutdown")?.[0]();
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
  const pi = fakePi({ entries, activeTools: ["agent", "chief"] });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["agent"]);
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
      pi.calls.some((args) => isAgentList(args)),
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
    { type: "custom", customType: "pi-herdsman-role", data: { role: "chief" } },
  ];
  const pi = fakePi({ entries, activeTools: ["agent", "chief"] });
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
    /ask when a chief decision is genuinely required, make it the only and final coordination call of the turn, do not guess, and wait for the reply/,
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
      isAgentList(args)
        ? {
            stdout: JSON.stringify({ id: AGENT_ID, result: { agents: [] } }),
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
  const prompt = pi.events.get("before_agent_start")![0](
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
    pi.events.get("before_agent_start")![0]({ systemPrompt: "base" }, context),
    undefined,
  );
  await pi.events.get("session_start")![0](undefined, context);
  assert.match(
    pi.events.get("before_agent_start")![0]({ systemPrompt: "base" }, context)
      ?.systemPrompt ?? "",
    /<agent_definitions>/,
  );
  assert.equal(
    pi.events.get("context")?.[0]({ messages: [{ role: "user" }] }, context),
    undefined,
  );
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
  const prompt = pi.events.get("before_agent_start")![0](
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
    { type: "custom", customType: "pi-herdsman-role", data: { role: "chief" } },
  ];
  const chief = fakePi({ entries, activeTools: ["agent", "chief"] });
  registerExtension!(chief.pi as never);
  const context = fakeContext(entries) as any;
  await chief.events.get("session_start")![0](undefined, context);
  const prompt = chief.events.get("before_agent_start")![0](
    { systemPrompt: "base" },
    context,
  );
  assert.match(prompt?.systemPrompt ?? "", /Chief/);
  assert.doesNotMatch(prompt?.systemPrompt ?? "", /<agent_definitions>/);
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
    { type: "custom", customType: "pi-herdsman-role", data: { role: "chief" } },
  ];
  const pi = fakePi({
    entries,
    exec: () => {
      throw new Error("supervision unavailable");
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  await pi.events.get("agent_start")![0](undefined, context);
  const result = pi.events.get("context")![0]({ messages: [] }, context);
  assert.match(result.messages.at(-1).content, /status="unavailable"/);
  assert.match(
    result.messages.at(-1).content,
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
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
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
  const textPath = join("/tmp", `${label}.md`);
  const binaryPath = join("/tmp", `${label}.bin`);
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
