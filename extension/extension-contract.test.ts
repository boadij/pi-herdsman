import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import packageMetadata from "../package.json" with { type: "json" };
import {
  buildSessionProjection,
  convertToLlm,
  type BeforeAgentStartEvent,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { acquireProcessLock } from "./lock.ts";
import { resultPath, resultRef } from "./storage.ts";
import {
  runtimeBuild,
  sameRuntimeBuild,
  isRuntimeBuild,
} from "./compatibility.ts";
import {
  COORDINATION_MESSAGE_KINDS,
  claimChiefLease,
  claimManagerLease,
  listCoordinationMessagePaths,
  invalidateLeadCoordinationState,
  listChiefMessagePaths,
  readChiefDescriptor,
  readPeerLeadRecord,
  removePeerLeadRecord,
  removeProjectAssignment,
  removeProjectMessage,
  removeChiefMessage,
  readChiefMessage,
  listProjectMessageHeaders,
  readProjectMessage,
  writeChiefMessage,
  supervisionRuntime,
  readLeadCoordinationState,
  writeLeadCoordinationState,
  peerLeadLockPath,
  peerRuntime,
  writePeerLeadRecord,
  writeProjectAssignment,
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
  HERDSMAN_BUILD,
  nativeSessions,
  agentControllerExecutor,
  delegatedLifecycleExecutor,
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
  agentMailboxPath,
  writeRequest,
  writeAsk,
  writeAgentState,
} from "./support.ts";
import { parseHerdrVersion } from "./herdr.ts";
import { supervisorMessageDiagnostics } from "../scripts/smoke.mjs";

const peerTopology = () => ({
  stdout: JSON.stringify({
    id: AGENT_ID,
    result: {
      source: {
        repo_key: "peer-test-repo",
        repo_name: "peer-test-repo",
        source_workspace_id: WORKSPACE,
      },
      worktrees: [],
    },
  }),
  stderr: "",
  code: 0,
});

test("new project worktree creation gets an extended Herdr timeout", async () => {
  const { createLeadProjectRuntime } = await import("./lead-runtime.ts");
  const repoKey = realFs.realpathSync(process.cwd());
  const manager = {
    repoKey,
    workspaceId: WORKSPACE,
    socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
    group: null,
    leaseId: randomUUID(),
    piSessionId: randomUUID(),
  };
  const calls: { args: string[]; options: any }[] = [];
  const lockKeys: string[] = [];
  const signal = new AbortController().signal;
  const runtime = createLeadProjectRuntime({
    pi: {} as any,
    leadRuntime: { managerLease: { descriptor: manager } } as any,
    managerLease: () => ({ descriptor: manager }),
    currentManager: async () => manager,
    sameManagerDescriptor: () => true,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: [],
    }),
    runHerdr: async (_pi: any, _ctx: any, args: string[], options: any) => {
      calls.push({ args, options });
      if (args[1] === "list")
        return {
          source: { source_workspace_id: WORKSPACE, repo_key: repoKey },
          worktrees: [],
        } as any;
      throw new Error("stop after observing create options");
    },
    supervisionRuntime: () => ({}),
    readProjectAssignment: () => undefined,
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareMessageInput: (text: string) => ({ text, resultBindings: [] }),
    resolveMessageFiles: () => [],
    withProjectWorkLock: (key: string, operation: () => unknown) => {
      lockKeys.push(key);
      return operation();
    },
    appendDurableError: () => {},
  } as any);

  for (const [params, expected] of [
    [
      { action: "delegate", task: "work", branch: " \t" },
      /Project branch must not be empty/,
    ],
    [{ action: "resume", branch: " \n" }, /Project branch must not be empty/],
    [
      { action: "delegate", task: "work", base: " \t" },
      /Base ref must not be empty/,
    ],
  ] as const) {
    await assert.rejects(
      runtime.activateProjectLead(params, {} as any, signal),
      expected,
    );
  }
  assert.deepEqual(lockKeys, []);
  assert.deepEqual(calls, []);

  await assert.rejects(
    runtime.activateProjectLead(
      { action: "delegate", task: "test" },
      {} as any,
      signal,
    ),
    /stop after observing create options/,
  );
  assert.deepEqual(
    calls.map(({ args }) => args.slice(0, 2)),
    [
      ["worktree", "list"],
      ["worktree", "create"],
    ],
  );
  assert.deepEqual(calls[0]?.options, { signal });
  assert.deepEqual(calls[1]?.options, { signal, timeout: 180_000 });
});

test("runtime build identity includes exact executable bytes", () => {
  const path = join(tmpdir(), `herdsman-build-${randomUUID()}.js`);
  writeFileSync(path, "export default 1;\n");
  const first = runtimeBuild("0.0.0-pr.149.gabc", path);
  const same = runtimeBuild("0.0.0-pr.149.gabc", path);
  writeFileSync(path, "export default 2;\n");
  const changed = runtimeBuild("0.0.0-pr.149.gabc", path);
  assert.equal(sameRuntimeBuild(first, same), true);
  assert.equal(sameRuntimeBuild(first, changed), false);
  assert.equal(isRuntimeBuild(first), true);
});

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

function assertPortableToolSchema(tool: any): void {
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.parameters?.type, "object");
  assert.ok(tool.parameters?.properties);
  assert.equal(tool.parameters?.additionalProperties, false);
  assert.equal(tool.parameters?.anyOf, undefined);
  assert.equal(tool.parameters?.oneOf, undefined);
  assert.equal(tool.parameters?.allOf, undefined);
  assert.equal(tool.parameters.required?.includes("files") ?? false, false);
  if (tool.parameters.properties.files) {
    const guidance = tool.promptGuidelines?.join(" ") ?? "";

    assert.match(
      guidance,
      /relevant to the recipient's assignment, decisions, integration, validation, or onward handoff through `files`/,
      tool.name,
    );
    assert.match(
      guidance,
      /Do not assume the recipient inherits the sender's conversation or arbitrary attachments/,
      tool.name,
    );
    assert.match(guidance, /omit unrelated evidence/, tool.name);
  }
  assert.equal(tool.parameters.properties.action, undefined, tool.name);
  // Provider constrained-sampling policy belongs to Pi, not Herdsman.
  assert.equal(tool.constrainedSampling, undefined, tool.name);
}

const REGISTERED_ROLE_TOOLS = [
  ...[
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
    "read_evidence",
    "message_supervisor",
    "list_peers",
    "message_peer",
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
    "delegate_project",
    "resume_project",
    "stop_lead",
    "remove_worktree",
  ].map((name) => ({ name })),
];

const SEMANTIC_TOOL_CASES = [
  ["list_agents", {}, { agent: "x" }, []],
  [
    "delegate_agent",
    { definition: "scout", task: "work" },
    { definition: "scout", task: "work", session: "x" },
    ["definition", "task"],
  ],
  [
    "continue_agent",
    { session: "/tmp/session.jsonl", task: "work" },
    { session: "/tmp/session.jsonl", task: "work", agent: "x" },
    ["session", "task"],
  ],
  [
    "steer_agent",
    { agent: "worker", message: "change" },
    { agent: "worker", message: "change", session: "x" },
    ["agent", "message"],
  ],
  [
    "interrupt_agent",
    { agent: "worker", message: "replace" },
    { agent: "worker", message: "replace", task: "x" },
    ["agent", "message"],
  ],
  [
    "reply_agent",
    { agent: "worker", message: "decision" },
    { agent: "worker", message: "decision", session: "x" },
    ["agent", "message"],
  ],
  [
    "close_agent",
    { agent: "worker" },
    { agent: "worker", message: "x" },
    ["agent"],
  ],
  [
    "inspect_agent",
    { agent: "worker" },
    { agent: "worker", session: "x" },
    ["agent"],
  ],
  [
    "read_agent_transcript",
    { agent: "worker" },
    { agent: "worker", session: "x" },
    ["agent"],
  ],
  [
    "message_supervisor",
    { message: "progress" },
    { message: "progress", question: "x" },
    ["message"],
  ],
  ["list_peers", {}, { session: "x" }, []],
  [
    "message_peer",
    { session: "session-id", message: "please review" },
    { session: "session-id", message: "please review", lead: "x" },
    ["session", "message"],
  ],
] as const;

const STAFF_TOOL_CASES = [
  ["list_staff", {}, { session: "x" }, []],
  [
    "inspect_staff",
    { session: "session-id" },
    { session: "session-id", message: "x" },
    ["session"],
  ],
  [
    "read_staff_transcript",
    { session: "session-id" },
    { session: "session-id", message: "x" },
    ["session"],
  ],
  [
    "message_staff",
    { session: "session-id", message: "progress", retain: true },
    { session: "session-id", message: "progress", lead: "x" },
    ["session", "message"],
  ],
] as const;

const MANAGER_STAFF_TOOL_CASES = [
  [
    "delegate_project",
    { task: "implement" },
    { branch: "feat/existing" },
    ["task"],
  ],
  [
    "resume_project",
    { branch: "feat/existing" },
    { branch: "feat/existing", task: "replace it" },
    ["branch"],
  ],
  [
    "stop_lead",
    { session: "session-id" },
    { session: "session-id", branch: "feat/x" },
    ["session"],
  ],
  [
    "remove_worktree",
    { branch: "feat/existing" },
    { branch: "feat/existing", force: true },
    ["branch"],
  ],
] as const;

test("semantic coordination tools expose exact strict object contracts", () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const tools = new Map(pi.tools.map((tool) => [tool.name, tool]));
  const semanticNames = SEMANTIC_TOOL_CASES.map(([name]) => name);
  const portableStrings = [
    ["delegate_agent", ["definition", "task"]],
    ["continue_agent", ["session", "task"]],
    ["steer_agent", ["message"]],
    ["interrupt_agent", ["message"]],
    ["reply_agent", ["message"]],
    ["message_staff", ["message"]],
    ["message_peer", ["message"]],
    ["delegate_project", ["task", "branch", "base"]],
    ["resume_project", ["branch"]],
    ["remove_worktree", ["branch"]],
    ["message_supervisor", ["message"]],
  ] as const;
  for (const [name, fields] of portableStrings) {
    const properties = tools.get(name)!.parameters.properties;
    for (const field of fields) {
      const schema = properties[field];
      assert.equal(schema.minLength, 1, `${name}.${field}`);
      assert.equal(schema.pattern, undefined, `${name}.${field}`);
      assert.equal(Value.Check(schema, "multi-character value"), true);
      assert.equal(Value.Check(schema, ""), false);
    }
  }
  const labels: Record<string, string> = {
    list_agents: "list agents",
    delegate_agent: "delegate agent",
    continue_agent: "continue agent",
    steer_agent: "steer agent",
    interrupt_agent: "interrupt agent",
    reply_agent: "reply agent",
    close_agent: "close agent",
    inspect_agent: "inspect agent",
    read_agent_transcript: "read agent transcript",
    message_supervisor: "message supervisor",
    list_peers: "list peers",
    message_peer: "message peer",
    list_staff: "list staff",
    inspect_staff: "inspect staff",
    read_staff_transcript: "read staff transcript",
    message_staff: "message staff",
    delegate_project: "delegate project",
    resume_project: "resume project",
    stop_lead: "stop lead",
    remove_worktree: "remove worktree",
  };
  for (const legacy of ["agent", "chief", "peer", "staff"])
    assert.equal(tools.has(legacy), false, `legacy tool remains: ${legacy}`);
  for (const removed of [
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "peer_list",
    "peer_message",
    "supervisor_message",
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
    "staff_delegate",
    "staff_resume",
    "staff_stop",
  ])
    assert.equal(tools.has(removed), false, `old callable remains: ${removed}`);
  for (const removed of ["staff_close", "staff_complete", "staff_discard"])
    assert.equal(tools.has(removed), false, `removed tool remains: ${removed}`);

  const rootDelegate = pi.tools.find((tool) => tool.name === "delegate_agent")!;
  assert.equal(rootDelegate.parameters.properties.retain, undefined);
  for (const retain of [true, false])
    assert.equal(
      Value.Check(rootDelegate.parameters, {
        definition: "scout",
        task: "work",
        retain,
      }),
      false,
    );
  for (const [name, valid, invalid, required] of SEMANTIC_TOOL_CASES) {
    const tool = tools.get(name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(tool.label, labels[name], name);
    assertPortableToolSchema(tool);
    assert.deepEqual(
      [...(tool.parameters.required ?? [])].sort(),
      [...required].sort(),
      name,
    );
    assert.equal(
      Value.Check(tool.parameters, valid),
      true,
      `${name} valid input`,
    );
    assert.equal(
      Value.Check(tool.parameters, invalid),
      false,
      `${name} cross-operation input`,
    );
    assert.equal(tool.parameters.properties.action, undefined, name);
  }
  assert.deepEqual(
    pi.tools
      .map((tool) => tool.name)
      .filter((name) => semanticNames.includes(name as never))
      .sort(),
    [...semanticNames].sort(),
  );
  assert.equal(
    tools.has("ask_owner"),
    false,
    "ordinary Leads do not get ask_owner",
  );
  assert.deepEqual(
    pi.tools.map((tool) => tool.name).sort(),
    [
      ...semanticNames,
      "read_evidence",
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
      "delegate_project",
      "resume_project",
      "stop_lead",
      "remove_worktree",
    ].sort(),
  );
  for (const name of [
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
    "delegate_project",
    "resume_project",
    "stop_lead",
    "remove_worktree",
  ]) {
    const tool = tools.get(name)!;
    assert.equal(tool.defaultActive, false);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  for (const [name, valid, invalid, required] of MANAGER_STAFF_TOOL_CASES) {
    const tool = tools.get(name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(tool.label, labels[name], name);
    assertPortableToolSchema(tool);
    assert.deepEqual(
      [...(tool.parameters.required ?? [])].sort(),
      [...required].sort(),
      name,
    );
    assert.equal(
      Value.Check(tool.parameters, valid),
      true,
      `${name} valid input`,
    );
    assert.equal(
      Value.Check(tool.parameters, invalid),
      false,
      `${name} cross-operation input`,
    );
  }
  pi.events.get("session_shutdown")?.[0]();

  const mailbox = setAgentEnvironment("contract-leaf-agent");
  const leaf = fakePi();
  registerExtension!(leaf.pi as never);
  assert.deepEqual(
    leaf.tools.map((tool) => tool.name).sort(),
    ["ask_owner", "read_evidence"].sort(),
  );
  const askOwner = leaf.tools.find((tool) => tool.name === "ask_owner")!;
  assertPortableToolSchema(askOwner);
  assert.deepEqual(askOwner.parameters.required, ["question"]);
  assert.equal(
    Value.Check(askOwner.parameters, { question: "decision?" }),
    true,
  );
  assert.equal(Value.Check(askOwner.parameters, {}), false);
  assert.equal(
    leaf.tools.some((tool) => tool.name === "update_assignment_evidence"),
    false,
  );
  leaf.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("extension loading does not call runtime action methods", () => {
  setLeadEnvironment();
  const pi = fakePi();
  const runtimeMethods = {
    getActiveTools: pi.pi.getActiveTools,
    getAllTools: pi.pi.getAllTools,
    setActiveTools: pi.pi.setActiveTools,
    getSessionName: pi.pi.getSessionName,
    getThinkingLevel: pi.pi.getThinkingLevel,
  };
  const unavailable = () => {
    throw new Error("runtime action used during extension loading");
  };
  pi.pi.getActiveTools = unavailable;
  pi.pi.getAllTools = unavailable;
  pi.pi.setActiveTools = unavailable;
  pi.pi.getSessionName = unavailable;
  pi.pi.getThinkingLevel = unavailable;

  try {
    assert.doesNotThrow(() => registerExtension!(pi.pi as never));
  } finally {
    Object.assign(pi.pi, runtimeMethods);
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("Chief activation exposes only semantic staff tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "semantic-chief-pane";
  process.env.HERDR_TAB_ID = "semantic-chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `semantic-chief-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  const chief = fakePi({
    entries,
    activeTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(chief.pi as never);
  try {
    await chief.events.get("session_start")![0](
      undefined,
      fakeContext(entries) as any,
    );
    assert.deepEqual(chief.pi.getActiveTools(), [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
    ]);
    const tools = new Map(chief.tools.map((tool) => [tool.name, tool]));
    for (const [name, valid, invalid, required] of STAFF_TOOL_CASES) {
      const tool = tools.get(name);
      assert.ok(tool, `missing ${name}`);
      assertPortableToolSchema(tool);
      assert.deepEqual(
        [...(tool.parameters.required ?? [])].sort(),
        [...required].sort(),
        name,
      );
      assert.equal(
        Value.Check(tool.parameters, valid),
        true,
        `${name} valid input`,
      );
      assert.equal(
        Value.Check(tool.parameters, invalid),
        false,
        `${name} cross-operation input`,
      );
    }
    for (const name of ["delegate_project", "stop_lead"])
      assert.equal(tools.get(name)?.exposure, "model-only", name);
  } finally {
    await chief.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("Herdr version parsing accepts preview suffixes but rejects trailing text", async () => {
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
      await pi.events.get("session_start")![0](undefined, fakeContext());
      return await pi.tools
        .find((tool) => tool.name === "delegate_agent")!
        .execute(
          "preflight",
          {
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
  const lead = fakePi({
    activeTools: [],
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(lead.pi as never);
  const historicalStaffMessage = lead.tools.find(
    (tool) => tool.name === "message_staff",
  )!;
  assert.ok(historicalStaffMessage);
  assert.match(
    (historicalStaffMessage.parameters as any).properties.files.description,
    /Transfer relevant readable files or result refs actually available in this Pi session\. Recipients do not inherit your conversation or attachments\. A ref mentioned only in text is not transferable evidence\./,
  );
  assert.equal(historicalStaffMessage.defaultActive, false);
  assert.equal(typeof historicalStaffMessage.renderCall, "function");
  assert.equal(typeof historicalStaffMessage.renderResult, "function");
  const historicalArgs = {
    session: "lead-historical-session",
    message: "Please continue the prior assignment",
  };
  const historicalCall = historicalStaffMessage.renderCall(
    historicalArgs,
    {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    },
    { args: historicalArgs, argsComplete: true },
  );
  assert.match(
    historicalCall.render(160).join("\n"),
    /^message staff  lead-his/,
  );
  const leadContext = fakeContext() as any;
  await lead.events.get("session_start")![0](undefined, leadContext);
  assert.deepEqual(lead.commands.sort(), [
    "agents",
    "chief",
    "herdsman",
    "lead",
    "manager",
  ]);
  assert.deepEqual(
    lead.pi.getActiveTools().sort(),
    [
      "close_agent",
      "continue_agent",
      "delegate_agent",
      "inspect_agent",
      "interrupt_agent",
      "list_agents",
      "reply_agent",
      "steer_agent",
      "read_agent_transcript",
      "message_supervisor",
      "list_peers",
      "message_peer",
    ].sort(),
  );
  assert.equal(
    lead.tools.some((tool) =>
      ["agent", "chief", "peer", "staff"].includes(tool.name),
    ),
    false,
  );
  assert.equal(
    lead.tools.some((tool) => tool.name === "ask_owner"),
    false,
  );
  assert.deepEqual(
    lead.tools.map((tool) => tool.name).sort(),
    [
      ...SEMANTIC_TOOL_CASES.map(([name]) => name),
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "read_evidence",
      "message_staff",
      "delegate_project",
      "resume_project",
      "stop_lead",
      "remove_worktree",
    ].sort(),
  );
  assert.equal(
    lead.pi.getActiveTools().some((name) => name.startsWith("staff_")),
    false,
  );
  for (const tool of lead.tools) {
    assertPortableToolSchema(tool);
    if (tool.name === "read_evidence") continue;
    assert.equal(tool.executionMode, "sequential");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  assert.ok(
    lead.tools.find((tool) => tool.name === "list_agents")?.promptGuidelines
      ?.length,
  );
  assert.deepEqual(
    lead.messageRenderers.map(({ customType }) => customType).sort(),
    [
      "pi-herdsman-agent-ask",
      "pi-herdsman-agent-attention",
      "pi-herdsman-agent-lost",
      "pi-herdsman-agent-result",
      "pi-herdsman-agent-stale",
      "pi-herdsman-project_message",
      "pi-herdsman-stop-summary",
      ...COORDINATION_MESSAGE_KINDS.map((kind) => `pi-herdsman-${kind}`),
    ].sort(),
  );
  const leadMessageRenderer = lead.messageRenderers.find(
    ({ customType }) => customType === "pi-herdsman-lead_message",
  )!.renderer as any;
  const leadMessage = {
    content: "A lead message body",
    details: { fromSessionId: "lead-session" },
  };
  const click = (button: "left" | "right") => ({
    type: "click",
    button,
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 4,
    shift: false,
    alt: false,
    ctrl: false,
  });
  const first = leadMessageRenderer(
    leadMessage,
    { expanded: false },
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  );
  const second = leadMessageRenderer(
    leadMessage,
    { expanded: false },
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  );
  assert.doesNotMatch(
    first.render(120).join("\n"),
    /from session: lead-session/,
  );
  assert.equal(first.handleMouse(click("right"))?.handled, undefined);
  assert.doesNotMatch(
    first.render(120).join("\n"),
    /from session: lead-session/,
  );
  assert.equal(first.handleMouse(click("left"))?.handled, true);
  assert.match(first.render(120).join("\n"), /from session: lead-session/);
  assert.doesNotMatch(
    second.render(120).join("\n"),
    /from session: lead-session/,
  );
  assert.equal(first.handleMouse(click("left"))?.handled, true);
  assert.doesNotMatch(
    first.render(120).join("\n"),
    /from session: lead-session/,
  );
  const initiallyExpanded = leadMessageRenderer(
    leadMessage,
    { expanded: true },
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  );
  assert.match(
    initiallyExpanded.render(120).join("\n"),
    /from session: lead-session/,
  );
  initiallyExpanded.handleMouse(click("left"));
  assert.doesNotMatch(
    initiallyExpanded.render(120).join("\n"),
    /from session: lead-session/,
  );
  assert.equal(lead.commands.includes("subagents"), false);
  assert.equal(lead.events.has("before_agent_start"), true);
  assert.equal(lead.events.has("context"), false);
  assert.ok(lead.events.has("session_start"));
  assert.ok(lead.events.has("session_shutdown"));
  lead.events.get("session_shutdown")?.[0]();

  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  const unmanaged = fakePi();
  registerExtension!(unmanaged.pi as never);
  assert.deepEqual(unmanaged.commands, ["herdsman", "agents"]);
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
  assert.equal(agentsCommand.description, "Alias for /herdsman");
  assert.equal(herdsmanCommand.description, "Set up Pi Herdsman");
  assert.equal(agentsCommand.handler, herdsmanCommand.handler);
  const levels: string[] = [];
  context.ui.notify = (message: string, level?: string) => {
    notices.push(message);
    if (level) levels.push(level);
  };
  await herdsmanCommand.handler("", context);
  assert.equal(notices.length, 1);
  assert.ok(
    notices[0]!.startsWith(
      `Pi Herdsman v${packageMetadata.version} is inactive`,
    ),
  );
  assert.match(notices[0]!, /inactive because .*not running inside Herdr/);
  assert.match(notices[0]!, /herdr\n  pi/);
  assert.match(notices[0]!, /herdr integration install pi/);
  await herdsmanCommand.handler("anything", context);
  assert.equal(notices[1], "Usage: /herdsman");
  await agentsCommand.handler("anything", context);
  assert.equal(notices[2], notices[1]);
  assert.deepEqual(levels, ["error", "error"]);
});

test("managed agents receive no peer tool and Chiefs expose only staff actively", async () => {
  const mailbox = setAgentEnvironment("peer-exclusion-agent");
  const managed = fakePi();
  registerExtension!(managed.pi as never);
  assert.equal(
    managed.tools.some((tool) => tool.name.startsWith("peer_")),
    false,
  );
  assert.equal(
    managed.tools.find((tool) => tool.name === "ask_owner")?.promptSnippet,
    "Ask this managed agent's direct owner for a required decision",
  );
  const askOwnerTool = managed.tools.find((tool) => tool.name === "ask_owner");
  assert.ok(askOwnerTool);
  assertPortableToolSchema(askOwnerTool);
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  const chief = fakePi({
    entries,
    activeTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(chief.pi as never);
  const context = fakeContext(entries) as any;
  try {
    await chief.events.get("session_start")![0](undefined, context);
    assert.deepEqual(chief.pi.getActiveTools(), [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
    ]);
    assert.equal(
      chief.pi.getActiveTools().some((name) => name.startsWith("peer_")),
      false,
    );
  } finally {
    await chief.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("list peers and message use global peer presence, not caller inventory", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-a-pane";
  process.env.HERDR_TAB_ID = "lead-a-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-target-race-${randomUUID()}.sock`,
  );
  const senderId = randomUUID();
  const targetId = randomUUID();
  const unenrichedTargetId = `lead-c-${randomUUID()}`;
  const unverifiedTargetId = `lead-d-${randomUUID()}`;
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
  const assignments = supervisionRuntime(process.env.HERDR_SOCKET_PATH);
  const claim = (sessionId: string, paneId: string, tabId: string) => {
    const lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
      name: "Lead peer presence",
    });
    const record = {
      version: 2 as const,
      build: HERDSMAN_BUILD,
      sessionKind: "ordinary" as const,
      piSessionId: sessionId,
      paneId,
      tabId,
      workspaceId: WORKSPACE,
      socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
      group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
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
  const unverifiedTarget = claim(
    unverifiedTargetId,
    "lead-d-pane",
    "lead-d-tab",
  );
  writePeerLeadRecord(runtime, { ...unverifiedTarget.record, group: null });
  const pi = fakePi({
    exec: (_command, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? peerTopology()
        : isAgentList(args) || isApiSnapshot(args)
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
    const peerList = pi.tools.find((tool) => tool.name === "list_peers");
    const peerMessage = pi.tools.find((tool) => tool.name === "message_peer");
    assert.ok(peerList);
    assert.ok(peerMessage);
    for (const branch of ["peer-ambiguous-a", "peer-ambiguous-b"])
      writeProjectAssignment(assignments, {
        version: 2,
        id: senderId,
        repoKey: "peer-test-repo",
        branch,
        text: "ambiguous assignment fixture",
      });
    await assert.rejects(
      peerList.execute("list", {}, undefined, undefined, context),
      /eligibility could not be verified/,
    );
    for (const branch of ["peer-ambiguous-a", "peer-ambiguous-b"])
      removeProjectAssignment(assignments, "peer-test-repo", branch);
    const listed = await peerList.execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    const modelJson = listed.content[0].text;
    const payload = JSON.parse(modelJson);
    assert.deepEqual(
      {
        self: payload.self,
        peers: [...payload.peers].sort((a, b) =>
          a.session.localeCompare(b.session),
        ),
      },
      {
        self: senderId,
        peers: [
          {
            session: targetId,
            name: "Target Lead",
            cwd: "/workspaces/target",
            repo: "pi-herdsman",
            branch: "feature/peer",
            workspace_label: "pi-herdsman/feature/peer",
          },
          {
            session: unenrichedTargetId,
            name: `lead-${unenrichedTargetId.slice(0, 8)}`,
            cwd: "",
            repo: "",
            branch: "",
            workspace_label: "",
          },
          {
            session: unverifiedTargetId,
            name: `lead-${unverifiedTargetId.slice(0, 8)}`,
            cwd: "",
            repo: "",
            branch: "",
            workspace_label: "",
          },
        ].sort((a, b) => a.session.localeCompare(b.session)),
      },
    );
    assert.equal(modelJson.includes(WORKSPACE), false);
    writeProjectAssignment(assignments, {
      version: 2,
      id: targetId,
      repoKey: "peer-test-repo",
      branch: "feature/peer",
      text: "ordinary peer contradiction fixture",
    });
    const contradictoryList = await peerList.execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(
      JSON.parse(contradictoryList.content[0].text).peers.some(
        (peer: { session: string }) => peer.session === targetId,
      ),
      false,
    );
    await assert.rejects(
      peerMessage.execute(
        "message",
        { session: targetId, message: "contradictory identity" },
        undefined,
        undefined,
        context,
      ),
    );
    removeProjectAssignment(assignments, "peer-test-repo", "feature/peer");
    assert.equal(
      payload.peers.some(
        (peer: { session: string }) => peer.session === unverifiedTargetId,
      ),
      true,
    );
    assert.equal(
      payload.peers.some(
        (peer: { session: string }) => peer.session === senderId,
      ),
      false,
    );
    for (const peer of payload.peers) {
      assert.equal("lead" in peer, false);
      assert.equal(
        Value.Check(peerMessage.parameters, {
          session: peer.session,
          message: "hello",
        }),
        true,
      );
    }
    // Ordinary peers do not need a worktree group; the exact ID is still
    // authorized only after the complete global no-assignment proof.
    writePeerLeadRecord(runtime, {
      ...target.record,
      group: {
        repoKey: "peer-test-repo",
        primaryWorkspaceId: "another-worktree-group",
      },
    });
    await peerMessage.execute(
      "message",
      { session: targetId, message: "ordinary peers are global" },
      undefined,
      undefined,
      context,
    );
    const ordinaryMessage = readChiefMessage(
      listCoordinationMessagePaths(runtime, targetId)[0],
    );
    removeChiefMessage(runtime, targetId, ordinaryMessage.id);
    writePeerLeadRecord(runtime, target.record);
    const queued = await peerMessage.execute(
      "message",
      {
        session: targetId,
        message: "global peer",
        files: ["result:implementation#1"],
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(queued.details?.session, targetId);
    assert.equal("lead" in (queued.details ?? {}), false);
    const messagePaths = listCoordinationMessagePaths(runtime, targetId);
    assert.equal(messagePaths.length, 1);
    const message = readChiefMessage(messagePaths[0]);
    assert.ok(message.text.includes("global peer"));
    assert.ok(message.text.includes('name="result:implementation#1"'));
    assert.deepEqual(message.resultBindings, [
      {
        ref: "result:implementation#1",
        canonicalRef: resultReference,
      },
    ]);
    assert.deepEqual(message.peerSource, {
      role: "lead",
      socket: process.env.HERDR_SOCKET_PATH,
      group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
      managed: false,
    });
    assert.equal(readChiefMessage(messagePaths[0]).peerSource?.managed, false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    sender.lease.release();
    target.lease.release();
    unenrichedTarget.lease.release();
    unverifiedTarget.lease.release();
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
  const entries: unknown[] = [];
  const context = fakeContext(entries) as any;
  context.cwd = "/active/lead-checkout";
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  entries.push({
    type: "custom",
    customType: "pi-herdsman-session-kind",
    data: { version: 1, sessionId, kind: "ordinary" },
  });
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  try {
    const starting = sessionStart(undefined, context);
    await provenanceStarted.promise;

    const record = readPeerLeadRecord(runtime, sessionId);
    assert.ok(record);
    assert.deepEqual(Object.keys(record).sort(), [
      "build",
      "claim",
      "cwd",
      "paneId",
      "piSessionId",
      "role",
      "sessionKind",
      "socket",
      "tabId",
      "updatedAt",
      "version",
      "workspaceId",
    ]);
    assert.equal(record.sessionKind, "ordinary");
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

test("registered failed-turn reporting uses exact Managed session identity before execution restoration", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "managed-lead-pane";
  const sessionId = randomUUID();
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId,
        kind: "managed",
        repoKey: "managed-repo",
        branch: "managed-branch",
      },
    },
  ];
  const definitionsReached = testGate<void>();
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  support.fileReadHook = (path) => {
    if (path === join(PI_AGENTS_DIR, "agent.md")) definitionsReached.resolve();
  };
  let sessionStartFinished = false;
  const starting = pi.events
    .get("session_start")![0](undefined, context)
    .then(() => {
      sessionStartFinished = true;
    });
  try {
    // Session identity has been initialized, but prepareLeadExecution has not
    // run yet, so the mutable execution profile is still absent.
    await definitionsReached.promise;
    assert.equal(sessionStartFinished, false);
    assert.ok(
      entries.some(
        (entry: any) =>
          entry?.customType === "pi-herdsman-session-kind" &&
          entry.data?.sessionId === sessionId &&
          entry.data?.kind === "managed",
      ),
    );

    pi.events.get("agent_start")![0]({}, context);
    pi.events.get("turn_end")![0](
      {
        outcome: "error",
        messageEntryId: randomUUID(),
        message: { role: "assistant", content: "failed" },
      },
      context,
    );
    pi.events.get("agent_before_settle")![0]({ outcome: "error" }, context);
    await pi.events.get("agent_settled")![0]({ aborted: false }, context);

    const report = entries.find(
      (entry: any) =>
        entry?.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "report_pending" &&
        entry.data?.sessionId === sessionId,
    ) as any;
    assert.equal(report?.data?.target, "project");

    // The same restored Managed identity must not classify a different active
    // Pi session as project-owned.
    const otherSessionId = randomUUID();
    context.sessionManager.getSessionId = () => otherSessionId;
    pi.events.get("agent_start")![0]({}, context);
    pi.events.get("turn_end")![0](
      {
        outcome: "error",
        messageEntryId: randomUUID(),
        message: { role: "assistant", content: "failed" },
      },
      context,
    );
    pi.events.get("agent_before_settle")![0]({ outcome: "error" }, context);
    await pi.events.get("agent_settled")![0]({ aborted: false }, context);
    const mismatchedReport = entries.find(
      (entry: any) =>
        entry?.customType === "pi-herdsman-herd-run" &&
        entry.data?.phase === "report_pending" &&
        entry.data?.sessionId === otherSessionId,
    ) as any;
    assert.equal(mismatchedReport?.data?.target, "chief");
  } finally {
    await starting;
    support.fileReadHook = undefined;
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("peer provenance enrichment never replaces the Lead cwd", async (t) => {
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
  const context = fakeContext(pi.entries) as any;
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

    releaseWorktree.resolve();
    await starting;
    await t.waitFor(() => {
      const record = readPeerLeadRecord(runtime, sessionId);
      assert.equal(record?.cwd, context.cwd);
      assert.equal(record.repo, "pi-herdsman");
      assert.equal(record.branch, "feature/linked");
      assert.equal(record.workspaceLabel, "pi-herdsman/feature/linked");
    });
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
  const targetId = randomUUID();
  const runtime = peerRuntime();
  let primaryWorkspaceId = WORKSPACE;
  let rewriteTargetDuringTopology = false;
  let ordinaryLeadMoved = false;
  const topology = (workspaceId = WORKSPACE) => ({
    stdout: JSON.stringify({
      id: AGENT_ID,
      result: {
        source: {
          repo_key:
            ordinaryLeadMoved && workspaceId === "ordinary-new"
              ? "peer-other-repo"
              : "peer-test-repo",
          repo_name: "peer-test-repo",
          source_workspace_id:
            ordinaryLeadMoved && workspaceId === "ordinary-new"
              ? "other-primary"
              : primaryWorkspaceId,
        },
        worktrees: [{ open_workspace_id: workspaceId }],
      },
    }),
    stderr: "",
    code: 0,
  });
  const claim = (
    sessionId: string,
    paneId: string,
    tabId: string,
    sessionKind: "ordinary" | "managed" = "ordinary",
  ) => {
    const lease = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
      name: "Lead peer presence",
    });
    const record = {
      version: 2 as const,
      build: HERDSMAN_BUILD,
      sessionKind,
      piSessionId: sessionId,
      paneId,
      tabId,
      workspaceId: WORKSPACE,
      socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
      group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
      claim: lease.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, record);
    return { lease, record };
  };
  const pi = fakePi({
    exec: (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        if (rewriteTargetDuringTopology) {
          rewriteTargetDuringTopology = false;
          const current = readPeerLeadRecord(runtime, targetId)!;
          writePeerLeadRecord(runtime, {
            ...current,
            group: {
              repoKey: "peer-other-repo",
              primaryWorkspaceId: WORKSPACE,
            },
          });
        }
        return topology(args.at(-1));
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => senderId,
  };
  try {
    const peer = pi.tools.find((tool) => tool.name === "message_peer");
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
          session: targetId,
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

    {
      const sender = claim(senderId, "lead-a-pane", "lead-a-tab");
      const target = claim(targetId, "lead-b-pane", "lead-b-tab", "managed");
      const branch = `managed-target-${randomUUID()}`;
      writePeerLeadRecord(runtime, {
        ...target.record,
        workspaceId: "managed-target",
      });
      writeProjectAssignment(supervisionRuntime(), {
        version: 2,
        id: targetId,
        repoKey: "peer-test-repo",
        branch,
        text: "managed target",
      });
      process.env.HERDR_WORKSPACE_ID = "ordinary-new";
      ordinaryLeadMoved = true;
      await assert.rejects(
        peer.execute(
          "message",
          { session: targetId, message: "ordinary Lead changed groups" },
          undefined,
          undefined,
          context,
        ),
        /outside the permitted project scope/,
      );
      assert.deepEqual(listCoordinationMessagePaths(runtime, targetId), []);
      ordinaryLeadMoved = false;
      delete process.env.HERDR_WORKSPACE_ID;
      removeProjectAssignment(supervisionRuntime(), "peer-test-repo", branch);
      sender.lease.release();
      target.lease.release();
      removePeerLeadRecord(runtime, senderId);
      removePeerLeadRecord(runtime, targetId);
    }

    {
      const sender = claim(senderId, "lead-a-pane", "lead-a-tab");
      const target = claim(targetId, "lead-b-pane", "lead-b-tab", "managed");
      const branch = `authority-race-${randomUUID()}`;
      writeProjectAssignment(supervisionRuntime(), {
        version: 2,
        id: targetId,
        repoKey: "peer-test-repo",
        branch,
        text: "managed target",
      });
      // Managed target identity must agree with the exact assignment under test.
      writePeerLeadRecord(runtime, {
        ...target.record,
        sessionKind: "managed",
      });
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      rewriteTargetDuringTopology = true;
      await assert.rejects(
        peer.execute(
          "message",
          {
            session: targetId,
            message: "same generation but changed authority",
          },
          undefined,
          undefined,
          context,
        ),
        /Peer assignment changed before the message was queued/,
      );
      assert.deepEqual(listCoordinationMessagePaths(runtime, targetId), []);
      removeProjectAssignment(supervisionRuntime(), "peer-test-repo", branch);
      delete process.env.HERDR_WORKSPACE_ID;
      sender.lease.release();
      target.lease.release();
      removePeerLeadRecord(runtime, senderId);
      removePeerLeadRecord(runtime, targetId);
    }

    const sender = claim(senderId, "lead-a-pane", "lead-a-tab");
    const target = claim(targetId, "lead-b-pane", "lead-b-tab");
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
      { session: targetId, message: "topology changed", files: [attachment] },
      undefined,
      undefined,
      context,
    );
    await preparationReached.promise;
    primaryWorkspaceId = "new-primary";
    await pending;
    const queued = listCoordinationMessagePaths(runtime, targetId);
    assert.equal(queued.length, 1);
    removeChiefMessage(runtime, targetId, readChiefMessage(queued[0]).id);
    sender.lease.release();
    target.lease.release();
    removePeerLeadRecord(runtime, senderId);
    removePeerLeadRecord(runtime, targetId);
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
      version: 2 as const,
      build: HERDSMAN_BUILD,
      sessionKind: "ordinary" as const,
      piSessionId: sessionId,
      paneId,
      tabId,
      workspaceId: WORKSPACE,
      socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
      group: { repoKey: "peer-test-repo", primaryWorkspaceId: WORKSPACE },
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
  const pi = fakePi({
    exec: (_command, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? peerTopology()
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => senderId,
  };
  try {
    const peer = pi.tools.find((tool) => tool.name === "message_peer");
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
            session: targetId,
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
        assert.equal(queued.details?.session, targetId);
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
  const context = fakeContext(pi.entries) as any;
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
  const context = fakeContext(pi.entries) as any;
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
      version: 2 as const,
      build: HERDSMAN_BUILD,
      sessionKind: "ordinary" as const,
      piSessionId: sessionId,
      paneId: "replacement-pane",
      tabId: "replacement-tab",
      workspaceId: WORKSPACE,
      socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
      group: null,
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
  writeFileSync(
    join(PI_AGENTS_DIR, "chief.md"),
    "---\nname: chief\nbodyMode: replace\n---\nCustom Chief strategy",
  );
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
    allTools: REGISTERED_ROLE_TOOLS,
  });
  const originalSetInterval = globalThis.setInterval;
  const installedIntervals: number[] = [];
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    installedIntervals.push(delay ?? 0);
    return {} as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const restoreSetInterval = () => {
    globalThis.setInterval = originalSetInterval;
  };
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  try {
    await pi.events.get("session_start")![0](undefined, context);
  } finally {
    restoreSetInterval();
  }
  assert.deepEqual(installedIntervals, []);
  const tool = pi.tools.find((candidate) => candidate.name === "message_staff");
  const inspectTool = pi.tools.find(
    (candidate) => candidate.name === "inspect_staff",
  );
  const transcriptTool = pi.tools.find(
    (candidate) => candidate.name === "read_staff_transcript",
  );
  const listTool = pi.tools.find(
    (candidate) => candidate.name === "list_staff",
  );
  assert.ok(tool);
  assert.ok(inspectTool);
  assert.ok(transcriptTool);
  assert.ok(listTool);
  for (const operation of [tool, inspectTool, transcriptTool, listTool])
    assertPortableToolSchema(operation);
  for (const [operation, phrase] of [
    [
      listTool,
      "when a fresh roster or diagnosis is needed; not for progress polling.",
    ],
    [inspectTool, "Read bounded live terminal/process evidence"],
    [transcriptTool, "Read bounded persisted Pi conversation/tool evidence"],
    [
      tool,
      "Send nonterminal coordination or review feedback to an exact direct report; active work is steered cooperatively.",
    ],
  ] as const)
    assert.match(operation.description, new RegExp(phrase));
  assert.match(
    tool.description,
    /Result refs mentioned only in report text are not automatically transferable evidence\. Attach refs only when available; otherwise request follow-up from the direct report in message text\./,
  );
  assert.doesNotMatch(
    tool.description,
    /staff_(?:list|inspect|transcript)|List direct-report|Read bounded/i,
  );
  assert.equal(tool.label, "message staff");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.equal(
    (tool.parameters as { properties: { retain: { description: string } } })
      .properties.retain.description,
    "For Manager messages to assigned project Leads: retain both message text and files as evidence available to eligible descendant Agents. They can inspect relevant references as needed; use for lasting requirements and accepted reviews, not temporary communication.",
  );
  const delegateTool = pi.tools.find(
    (candidate) => candidate.name === "delegate_project",
  );
  assert.ok(delegateTool);
  assert.match(
    delegateTool.description,
    /initial task and supplied files become required project evidence/,
  );
  assert.match(
    delegateTool.description,
    /use resume_project for existing work/,
  );
  assert.match(
    (tool.parameters as any).properties.files.description,
    /Recipients do not inherit your conversation or attachments/,
  );
  assert.match(
    (tool.parameters as any).properties.files.description,
    /A ref mentioned only in text is not transferable evidence/,
  );
  assert.match(
    (tool.parameters as any).properties.retain.description,
    /lasting requirements and accepted reviews/,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      session: LEAD_SESSION_ID,
      message: "Please continue",
      files: ["result:implementation#1"],
    }),
    true,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      session: LEAD_SESSION_ID,
      message: "Please continue",
      results: [{ agent: "implementation", index: 1 }],
    }),
    false,
  );
  const renderedStaffCall = tool.renderCall(
    { session: "lead-bbbbbbbbb", message: "Please continue" },
    {
      fg: (_color: string, value: string) => value,
      bold: (text: string) => text,
    },
    { argsComplete: true },
  );
  assert.equal(typeof renderedStaffCall.render, "function");
  assert.match(
    renderedStaffCall.render(160).join("\n"),
    /^message staff  lead-bbbbbb…/,
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
    { args: { session: "lead-bbbbbbbbb" } },
  );
  assert.match(renderedStaffResult.text, /✓ sent to workspace\/api/);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "list_staff",
    "inspect_staff",
    "read_staff_transcript",
    "message_staff",
  ]);
  const snapshotsBeforePreparation = pi.calls.filter(isApiSnapshot).length;
  const beforeStart = await pi.events.get("before_agent_start")![0](
    { systemPromptOptions: { contextFiles: [] } },
    context,
  );
  const chiefPrompt = beforeStart?.systemPrompt;
  assert.equal(beforeStart?.message, undefined);
  assert.deepEqual(installedIntervals, []);
  assert.ok(pi.calls.filter(isApiSnapshot).length > snapshotsBeforePreparation);
  const contextCall = pi.sentMessageCalls.findLast(
    ({ message }: any) =>
      message?.customType === "pi-herdsman-supervision-context",
  );
  assert.ok(contextCall);
  assert.deepEqual(contextCall.options, { triggerTurn: false });
  assert.equal((contextCall.message as any).display, false);
  assert.match(String((contextCall.message as any).content), /status="fresh"/);
  assert.match(
    String(chiefPrompt),
    /Supervision is event-driven\. Do not poll staff tools/,
  );
  assert.match(String(chiefPrompt), /verified workspace-neutral Chief/);
  assert.match(String(chiefPrompt), /Custom Chief strategy/);
  assert.doesNotMatch(String(chiefPrompt), /You are the active chief/);
  const sessionSchema = (tool.parameters as any).properties.session;
  assert.equal(
    sessionSchema.pattern,
    "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
  );
  assert.equal(Value.Check(sessionSchema, ""), false);
  assert.equal(Value.Check(sessionSchema, "-"), false);
  assert.equal(Value.Check(sessionSchema, "lead/session"), false);
  assert.equal(Value.Check(sessionSchema, LEAD_SESSION_ID), true);
  assert.equal(
    Value.Check(inspectTool.parameters, { session: LEAD_SESSION_ID }),
    true,
  );
  assert.equal(
    Value.Check(transcriptTool.parameters, { session: LEAD_SESSION_ID }),
    true,
  );
  assert.equal(
    Value.Check(tool.parameters, {
      root: LEAD_SESSION_ID,
      message: "legacy target names are rejected",
    }),
    false,
  );
  assert.equal(
    Value.Check(tool.parameters, {
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

test("idle Chief supervision reconciles at the 10s cadence, not UI redraw ticks", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-scheduler-pane";
  process.env.HERDR_TAB_ID = "chief-scheduler-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-scheduler-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  let snapshotCalls = 0;
  const pi = fakePi({
    entries,
    allTools: REGISTERED_ROLE_TOOLS,
    exec: (_command, args) => {
      if (isApiSnapshot(args)) snapshotCalls++;
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const callbacks = new Map<number, TimerHandler>();
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    callbacks.set(delay ?? 0, callback);
    return {} as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  context.ui.setWidget = () => undefined;
  await pi.events.get("session_start")![0](undefined, context);
  await pi.events.get("before_agent_start")![0](
    { systemPromptOptions: { contextFiles: [] } },
    context,
  );
  const afterPreparation = snapshotCalls;
  assert.equal(typeof callbacks.get(10_000), "function");
  assert.equal(callbacks.has(2_000), false);

  // Two callback invocations represent 20s of configured interval cadence.
  for (let tick = 0; tick < 2; tick++) {
    (callbacks.get(10_000) as () => void)();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(snapshotCalls - afterPreparation, 2);
});

test("read staff transcript advertises persisted candidates and revalidates the lead", async () => {
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
    if (args[0] === "worktree" && args[1] === "list")
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            source: {
              source_workspace_id: WORKSPACE,
              repo_key: "repo-key",
              repo_name: "project",
            },
            worktrees: [],
          },
        }),
        stderr: "",
        code: 0,
      };
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
      data: {
        sessionId: chiefId,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
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
    build: HERDSMAN_BUILD,
    instanceId: randomUUID(),
    piSessionId: leadId,
    updatedAt: Date.now(),
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const listTool = pi.tools.find(
      (candidate) => candidate.name === "list_staff",
    );
    const tool = pi.tools.find(
      (candidate) => candidate.name === "read_staff_transcript",
    );
    assert.ok(listTool);
    assert.ok(tool);

    const { SessionManager: observedSessionManager } =
      await import("@earendil-works/pi-coding-agent");
    const observedManager = observedSessionManager as any;
    const originalOpen = observedManager.open;
    let openCalls = 0;
    observedManager.open = (...args: any[]) => {
      openCalls++;
      return originalOpen.apply(observedManager, args);
    };
    let listed: any;
    try {
      listed = await listTool.execute(
        "list",
        {},
        undefined,
        undefined,
        context,
      );
      assert.equal(openCalls, 0);
    } finally {
      observedManager.open = originalOpen;
    }
    assertToolResult(listed);
    const listedLead = (listed.details?.reports as any[])[0];
    assert.equal(listedLead.session, leadId);
    assert.equal(listedLead.role, "lead");
    assert.equal("lead" in listedLead, false);
    assert.deepEqual(
      listedLead?.available_tools,
      ["inspect_staff", "read_staff_transcript", "message_staff"],
      JSON.stringify(listed.details),
    );

    const transcript = await tool.execute(
      "transcript",
      { session: leadId },
      undefined,
      undefined,
      context,
    );
    assertToolResult(transcript);
    assert.equal(transcript.details?.session, leadId);
    assert.equal("lead" in (transcript.details ?? {}), false);
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
    const malformed = await listTool.execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    assertToolResult(malformed);
    assert.equal(
      (malformed.details?.reports as any[]).some(
        (report) => report.session === leadId,
      ),
      false,
    );
    await assert.rejects(
      tool.execute(
        "transcript",
        { session: leadId },
        undefined,
        undefined,
        context,
      ),
      /Lead target was not found or is no longer eligible/,
    );
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionManager = SessionManager as any;
    const originalFindById = Object.getOwnPropertyDescriptor(
      sessionManager,
      "findById",
    );
    const originalSession = leadAgent.agent_session;
    sessionManager.findById = (cwd: string, id: string) =>
      cwd === leadAgent.cwd && id === leadId ? leadPath : undefined;
    leadAgent.agent_session = { ...originalSession, kind: "id", value: leadId };
    try {
      const mismatched = await listTool.execute(
        "list",
        {},
        undefined,
        undefined,
        context,
      );
      assertToolResult(mismatched);
      const mismatchedLead = (mismatched.details?.reports as any[]).find(
        (report) => report.session === leadId,
      );
      assert.ok(mismatchedLead);
      assert.ok(
        mismatchedLead.available_tools.includes("read_staff_transcript"),
      );
      await assert.rejects(
        tool.execute(
          "transcript",
          { session: leadId },
          undefined,
          undefined,
          context,
        ),
        /Persisted Pi session is missing a matching current session header/,
      );
    } finally {
      leadAgent.agent_session = originalSession;
      if (originalFindById)
        Object.defineProperty(sessionManager, "findById", originalFindById);
      else delete sessionManager.findById;
    }
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
        { session: leadId },
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
    build: HERDSMAN_BUILD,
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
      if (args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: {
                worktree: { repo_key: "repo", is_linked_worktree: false },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                repo_key: "repo",
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
  registerExtension!(pi.pi as never);
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: { version: 1, sessionId: LEAD_SESSION_ID, kind: "ordinary" },
    },
  ];
  const context = fakeContext(entries, [
    {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "message_supervisor" }],
      },
    },
  ]) as any;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const tool = pi.tools.find(
      (candidate) => candidate.name === "message_supervisor",
    );
    assert.ok(tool);
    const result = await tool.execute(
      "message",
      { message: "should not be delivered" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [
      { type: "text", text: "No active supervisor is available" },
    ]);
    assert.deepEqual(result.details, {
      error: {
        branchStatus: "operation_error_returned",
        category: "target_not_found",
      },
    });
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
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-activation-${randomUUID()}.sock`,
  );
  const mailbox = agentMailboxPath(
    WORKSPACE,
    `chief-activation-invalid-state-${randomUUID()}`,
  );
  const notices: string[] = [];
  realFs.mkdirSync(mailbox, { recursive: true });
  realFs.writeFileSync(join(mailbox, "state.json"), "not json");
  const pi = fakePi({ allTools: REGISTERED_ROLE_TOOLS });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);

  try {
    const command = pi.commandOptions.get("chief");
    assert.ok(command);

    await pi.events.get("session_start")![0](undefined, context);
    await command.handler("", context);

    assert.doesNotMatch(
      notices.join("\n"),
      /cannot activate|owned agent work exists/,
    );
    assert.equal(
      realFs.readFileSync(join(mailbox, "state.json"), "utf8"),
      "not json",
    );
    assert.deepEqual(
      pi.pi.getActiveTools(),
      ["list_staff", "inspect_staff", "read_staff_transcript", "message_staff"],
      JSON.stringify(notices),
    );
  } finally {
    realFs.rmSync(mailbox, { recursive: true, force: true });
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
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
    await pi.commandOptions.get("chief").handler("", context);
    const first = await beforeStart();
    assert.equal(first?.message, undefined);
    let call = pi.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    )!;
    assert.deepEqual(call.options, { triggerTurn: false });
    assert.equal((call.message as any).display, false);
    assert.match(String((call.message as any).content), /status="fresh"/);

    sessionId = chiefB;
    failRefresh = true;
    await sessionStart(undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    assert.equal((await beforeStart())?.message, undefined);
    call = pi.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    )!;
    assert.equal((call.message as any).display, false);
    assert.match(String((call.message as any).content), /status="unavailable"/);
    assert.doesNotMatch(
      String((call.message as any).content),
      /status="stale"/,
    );
    assert.doesNotMatch(
      String((call.message as any).content),
      new RegExp(leadId),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("an obsolete background supervision refresh cannot publish after chief transition", async (t) => {
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
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
    await pi.commandOptions.get("chief").handler("", context);
    const first = await beforeStart();
    assert.equal(first?.message, undefined);
    let call = pi.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    )!;
    assert.deepEqual(call.options, { triggerTurn: false });
    assert.equal((call.message as any).display, false);
    assert.match(String((call.message as any).content), /status="fresh"/);
    blockNextRefresh = true;
    const command = pi.commandOptions.get("chief");
    assert.ok(command);
    const background = command.handler("", context);
    await t.waitFor(() => assert.ok(releaseBlocked, "refresh did not start"));

    sessionId = chiefB;
    await sessionStart(undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    failRefresh = true;
    releaseBlocked();
    await background;
    assert.equal((await beforeStart())?.message, undefined);
    call = pi.sentMessageCalls.findLast(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervision-context",
    )!;
    assert.equal((call.message as any).display, false);
    assert.match(String((call.message as any).content), /status="unavailable"/);
    assert.doesNotMatch(
      String((call.message as any).content),
      /status="stale"/,
    );
    assert.doesNotMatch(
      String((call.message as any).content),
      new RegExp(leadId),
    );
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  const branch: any[] = [...entries];
  let nextId = 0;
  const pi = fakePi({
    entries,
    allTools: REGISTERED_ROLE_TOOLS,
    sendMessage: (message: any) => {
      const id = `snapshot-${++nextId}`;
      branch.push({
        type: "custom_message",
        id,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        ...message,
      });
    },
  });
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
    assert.equal(first?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.equal(
      (pi.sentMessageCalls[0]!.message as any).customType,
      "pi-herdsman-supervision-context",
    );
    assert.deepEqual(pi.sentMessageCalls[0]!.options, {
      triggerTurn: false,
    });
    const snapshot = branch.at(-1)!;
    assert.equal(snapshot.display, false);
    assert.match(String(snapshot.content), /status="fresh"/);

    branch.push({
      type: "message",
      id: "user-1",
      parentId: snapshot.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "actual user request" }],
        timestamp: Date.now(),
      },
    });
    const projected = buildSessionProjection(branch).messages;
    assert.equal(projected.at(-2)?.role, "custom");
    assert.equal(
      (projected.at(-2) as any)?.customType,
      "pi-herdsman-supervision-context",
    );
    assert.equal(projected.at(-1)?.role, "user");
    assert.match(
      JSON.stringify(projected.at(-1)?.content),
      /actual user request/,
    );
    const modelVisible = convertToLlm(projected);
    assert.equal(modelVisible.at(-2)?.role, "user");
    assert.match(
      JSON.stringify(modelVisible.at(-2)?.content),
      /supervision_state/,
    );
    assert.equal(modelVisible.at(-1)?.role, "user");
    assert.match(
      JSON.stringify(modelVisible.at(-1)?.content),
      /actual user request/,
    );

    const beforeDuplicate = pi.sentMessageCalls.length;
    const second = await beforeStart();
    assert.equal(second?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, beforeDuplicate);

    branch.push({
      type: "context_edit",
      id: "snapshot-edit",
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      targetId: snapshot.id,
      replacement: null,
    });
    const beforeOmission = pi.sentMessageCalls.length;
    const afterOmission = await beforeStart();
    assert.equal(
      (pi.sentMessageCalls.at(-1)!.message as any).customType,
      "pi-herdsman-supervision-context",
    );
    assert.equal(pi.sentMessageCalls.length, beforeOmission + 1);
    assert.equal(afterOmission?.message, undefined);

    branch.splice(
      0,
      branch.length,
      {
        type: "custom_message",
        id: "snapshot-old",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "pi-herdsman-supervision-context",
        content: snapshot.content,
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
    const beforeCompactionRefresh = pi.sentMessageCalls.length;
    const afterCompaction = await beforeStart();
    assert.equal(afterCompaction?.message, undefined);
    assert.equal(pi.sentMessageCalls.length, beforeCompactionRefresh + 1);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  }
});

test("lead metadata omits coordination state and follows session names", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const pi = fakePi({ sessionName: "first name" });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  await pi.events.get("session_start")![0](undefined, context);
  await t.waitFor(() =>
    assert.ok(
      pi.calls.some(
        (args) => args[0] === "pane" && args[1] === "report-metadata",
      ),
    ),
  );
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

test("Lead tab naming verifies the pane's current tab and automatic position", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const pi = fakePi({
    exec: async (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: "ok",
            result: {
              pane: {
                pane_id: "lead-pane",
                workspace_id: "workspace-1",
                tab_id: "current-tab",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "tab" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: "ok",
            result: {
              tabs: [
                { tab_id: "first", number: 10, label: "1" },
                { tab_id: "second", number: 20, label: "2" },
                { tab_id: "current-tab", number: 44, label: "3" },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      return {
        stdout: JSON.stringify({ id: "ok", result: {} }),
        stderr: "",
        code: 0,
      };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  await pi.events.get("session_start")![0](undefined, context);
  await t.waitFor(() =>
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "current-tab" &&
          args[3] === "Lead",
      ),
    ),
  );
  const calls = pi.calls.filter(
    (args) =>
      (args[0] === "pane" && args[1] === "get") ||
      (args[0] === "tab" && (args[1] === "list" || args[1] === "rename")),
  );
  assert.deepEqual(calls, [
    ["pane", "get", "lead-pane"],
    ["tab", "list", "--workspace", "workspace-1"],
    ["tab", "rename", "current-tab", "Lead"],
  ]);
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
  setLeadEnvironment();
});

test("Lead tab naming preserves custom names and contains malformed/failed Herdr operations", async (t) => {
  for (const mode of [
    "custom",
    "malformed",
    "invalid-entry",
    "duplicate-id",
    "empty-identity",
    "rename-fails",
  ] as const) {
    await t.test(mode, async () => {
      setLeadEnvironment();
      process.env.HERDR_PANE_ID = "lead-pane";
      const pi = fakePi({
        exec: async (command, args) => {
          if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
          if (args[0] === "pane" && args[1] === "get")
            return {
              stdout: JSON.stringify({
                id: "ok",
                result: {
                  pane: {
                    pane_id: "lead-pane",
                    workspace_id:
                      mode === "empty-identity" ? "" : "workspace-1",
                    tab_id: mode === "empty-identity" ? "" : "current-tab",
                  },
                },
              }),
              stderr: "",
              code: 0,
            };
          if (args[0] === "tab" && args[1] === "list")
            return {
              stdout:
                mode === "malformed"
                  ? JSON.stringify({ id: "ok", result: { tabs: "invalid" } })
                  : mode === "invalid-entry"
                    ? JSON.stringify({
                        id: "ok",
                        result: {
                          tabs: [
                            null,
                            { tab_id: "current-tab", number: 44, label: "2" },
                          ],
                        },
                      })
                    : mode === "duplicate-id"
                      ? JSON.stringify({
                          id: "ok",
                          result: {
                            tabs: [
                              { tab_id: "current-tab", number: 44, label: "1" },
                              { tab_id: "current-tab", number: 45, label: "2" },
                            ],
                          },
                        })
                      : JSON.stringify({
                          id: "ok",
                          result: {
                            tabs: [
                              {
                                tab_id: "current-tab",
                                number: 44,
                                label: mode === "custom" ? "Architecture" : "1",
                              },
                            ],
                          },
                        }),
              stderr: "",
              code: 0,
            };
          if (
            args[0] === "tab" &&
            args[1] === "rename" &&
            mode === "rename-fails"
          )
            return { stdout: "", stderr: "failed", code: 1 };
          return {
            stdout: JSON.stringify({ id: "ok", result: {} }),
            stderr: "",
            code: 0,
          };
        },
      });
      registerExtension!(pi.pi as never);
      const context = fakeContext() as any;
      await pi.events.get("session_start")![0](undefined, context);
      await t.waitFor(() =>
        assert.ok(
          pi.calls.some(
            (args) =>
              (args[0] === "tab" && args[1] === "list") ||
              (mode === "empty-identity" &&
                args[0] === "pane" &&
                args[1] === "get") ||
              (mode === "rename-fails" &&
                args[0] === "tab" &&
                args[1] === "rename"),
          ),
        ),
      );
      const renames = pi.calls.filter(
        (args) => args[0] === "tab" && args[1] === "rename",
      );
      assert.equal(renames.length, mode === "rename-fails" ? 1 : 0);
      assert.ok(
        pi.calls.some(
          (args) => args[0] === "pane" && args[1] === "report-metadata",
        ),
        "role metadata remains independent from tab presentation",
      );
      pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_PANE_ID;
      setLeadEnvironment();
    });
  }
});

test("Lead tab naming remembers manual overrides, skips the target, and reclaims role labels after restart", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  let tabLabel = "1";
  const tabCalls: string[][] = [];
  let deferNextPaneGet = true;
  let paneGetDidStart = false;
  let releasePaneGet!: () => void;
  const heldPaneGet = new Promise<void>(
    (resolve) => (releasePaneGet = resolve),
  );
  const makePi = () =>
    fakePi({
      exec: async (command, args) => {
        if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
        const result = (value: unknown) => ({
          stdout: JSON.stringify({ id: "ok", result: value }),
          stderr: "",
          code: 0,
        });
        if (args[0] === "pane" && args[1] === "get") {
          tabCalls.push(args);
          const paneResult = () =>
            result({
              pane: {
                pane_id: "lead-pane",
                workspace_id: "workspace-1",
                tab_id: "current-tab",
              },
            });
          if (deferNextPaneGet) {
            deferNextPaneGet = false;
            paneGetDidStart = true;
            return heldPaneGet.then(paneResult);
          }
          return paneResult();
        }
        if (args[0] === "tab" && args[1] === "list") {
          tabCalls.push(args);
          return result({
            tabs: [{ tab_id: "current-tab", number: 44, label: tabLabel }],
          });
        }
        if (args[0] === "tab" && args[1] === "rename") {
          tabCalls.push(args);
          tabLabel = args[3]!;
          return result({});
        }
        return result({});
      },
    });
  const first = makePi();
  registerExtension!(first.pi as never);
  const firstContext = fakeContext() as any;
  const initialSessionId = firstContext.sessionManager.getSessionId();
  let activeSessionId = initialSessionId;
  firstContext.sessionManager.getSessionId = () => activeSessionId;
  const startFirst = () =>
    first.events.get("session_start")![0](undefined, firstContext);
  const supersededStart = startFirst();
  await t.waitFor(() => assert.equal(paneGetDidStart, true));
  await supersededStart;
  activeSessionId = `${initialSessionId}-replacement`;
  await startFirst();
  releasePaneGet();
  await t.waitFor(() =>
    assert.ok(
      first.calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "current-tab" &&
          args[3] === "Lead",
      ),
    ),
  );
  assert.deepEqual(
    tabCalls.filter(
      (args) =>
        (args[0] === "pane" && args[1] === "get") ||
        (args[0] === "tab" && args[1] === "list") ||
        (args[0] === "tab" && args[1] === "rename"),
    ),
    [
      ["pane", "get", "lead-pane"],
      ["pane", "get", "lead-pane"],
      ["tab", "list", "--workspace", "workspace-1"],
      ["tab", "rename", "current-tab", "Lead"],
    ],
  );
  const firstRenameCount = () =>
    first.calls.filter((args) => args[0] === "tab" && args[1] === "rename")
      .length;
  const firstListCount = () =>
    first.calls.filter((args) => args[0] === "tab" && args[1] === "list")
      .length;
  const writesAfterLead = firstRenameCount();
  let lists = firstListCount();
  tabLabel = "Architecture";
  await startFirst();
  await t.waitFor(() => assert.equal(firstListCount(), lists + 1));
  assert.equal(firstRenameCount(), writesAfterLead);
  tabLabel = "Lead";
  lists = firstListCount();
  await startFirst();
  await t.waitFor(() => assert.equal(firstListCount(), lists + 1));
  assert.equal(firstRenameCount(), writesAfterLead, "target label is a no-op");
  first.events.get("session_shutdown")?.[0]();

  tabLabel = "Chief";
  const restarted = makePi();
  registerExtension!(restarted.pi as never);
  const restartedContext = fakeContext() as any;
  await restarted.events.get("session_start")![0](undefined, restartedContext);
  await t.waitFor(() =>
    assert.ok(
      restarted.calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[2] === "current-tab" &&
          args[3] === "Lead",
      ),
    ),
  );
  assert.deepEqual(
    restarted.calls.filter((args) => args[0] === "tab" && args[1] === "rename"),
    [["tab", "rename", "current-tab", "Lead"]],
  );
  restarted.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
  setLeadEnvironment();
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
      data: { sessionId: LEAD_SESSION_ID, role: "not-a-role" },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), []);
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

test("persisted Chief keeps verified authority and mandatory tools when definitions are invalid", async () => {
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
    allTools: REGISTERED_ROLE_TOOLS,
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
    ]);
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_definition_error",
      ),
      true,
    );
    const prompt = await pi.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      context,
    );
    assert.match(
      prompt?.systemPrompt ?? "",
      /verified workspace-neutral Chief/,
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
  assert.ok(
    pi.tools.some((candidate) => candidate.name === "message_supervisor"),
  );
  delete process.env.HERDR_PANE_ID;
});

test("replaced Lead strategy keeps its protected charter and coordination tools", async () => {
  setLeadEnvironment();
  const overlay = join(PI_AGENTS_DIR, "orchestrator-lead.md");
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `lead-contract-${randomUUID()}.sock`,
  );
  writeFileSync(
    overlay,
    "---\nname: orchestrator-lead\nbodyMode: replace\n---\nCustom Lead strategy",
  );
  process.env.HERDR_PANE_ID = "lead-pane";
  const pi = fakePi({
    allTools: REGISTERED_ROLE_TOOLS,
    exec: (_command, args) => ({
      stdout: JSON.stringify({
        id: AGENT_ID,
        result: isApiSnapshot(args)
          ? { snapshot: { agents: [], panes: [] } }
          : {
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
    }),
  });
  const context = fakeContext(pi.entries) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("lead").handler("orchestrate", context);
    const event = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](event, context);
    const sections = event.systemPromptOptions.sections;
    assert.match(
      sections.pi_herdsman_lead_execution ?? "",
      /Custom Lead strategy/,
      notices.join("\n"),
    );
    assert.doesNotMatch(
      sections.pi_herdsman_lead_execution,
      /Partition delegable work/,
    );
    const charter = sections.pi_herdsman_role;
    assert.match(
      charter,
      /required project evidence is automatically inherited/,
    );
    assert.match(
      charter,
      /Ordinary Leads have no automatic required-evidence scope/,
    );
    assert.match(
      charter,
      /Only the Manager can designate continuing project requirements/,
    );
    assert.match(
      charter,
      /delegation task and ordinary files are recipient-specific/,
    );
    assert.match(charter, /`files` carries evidence, not runtime capability/);
    for (const name of [
      "delegate_agent",
      "continue_agent",
      "message_supervisor",
    ]) {
      assert.ok(pi.pi.getActiveTools().includes(name), name);
      const tool = pi.tools.find((candidate) => candidate.name === name)!;
      assert.match(
        tool.promptGuidelines.join(" "),
        /unless the recipient already inherits the same evidence version as required evidence\. Forward changed versions explicitly\./,
      );
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(overlay, { force: true });
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
  }
});

test("ordinary Lead custom startup receives the exact-session definition roster", async () => {
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
  const createPromptEvent = () =>
    ({
      type: "before_agent_start",
      messageType: "custom",
      message: {
        role: "custom",
        customType: "pi-herdsman-test",
        content: "custom startup",
        display: true,
        timestamp: Date.now(),
      },
      systemPrompt: "base",
      systemPromptOptions: {
        cwd: context.cwd,
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
    }) satisfies BeforeAgentStartEvent;
  const promptEvent = createPromptEvent();
  const prompt = await pi.events.get("before_agent_start")![0](
    promptEvent,
    context,
  );
  assert.equal(prompt, undefined);
  assert.match(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /Use message_supervisor for material nonblocking coordination with your direct supervisor\./,
  );
  assert.match(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /integration, validation, or onward handoff/,
  );
  assert.match(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /carry relevant evidence into onward handoffs/,
  );
  assert.match(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /For assigned project work, automatic result handoffs contain summary text but no file attachments\./,
  );
  assert.match(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /explicitly transfer the relevant evidence through message_supervisor\.files\./,
  );
  assert.match(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /list_peers\/message_peer/,
  );
  assert.doesNotMatch(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /project-assignment delivery/,
  );
  assert.doesNotMatch(
    promptEvent.systemPromptOptions.sections.pi_herdsman_role,
    /available direct supervisor/,
  );
  assert.match(
    promptEvent.systemPromptOptions.sections.agent_definitions,
    /Use list_agents for live Agent state/,
  );
  const roster = JSON.parse(
    promptEvent.systemPromptOptions.sections.agent_definitions.split(
      "\n\nThis is the session-start definition snapshot.",
    )[0],
  );
  const listResult = await pi.tools
    .find((tool) => tool.name === "list_agents")!
    .execute("list", {}, undefined, undefined, context);
  assert.deepEqual(
    roster,
    listResult.details.agent_definitions,
    JSON.stringify(listResult.details),
  );
  sessionId = randomUUID();
  const staleEvent = createPromptEvent();
  const stalePrompt = await pi.events.get("before_agent_start")![0](
    staleEvent,
    context,
  );
  assert.equal(stalePrompt, undefined);
  assert.match(
    staleEvent.systemPromptOptions.sections.pi_herdsman_role,
    /## Lead role/,
  );
  assert.equal(
    staleEvent.systemPromptOptions.sections.agent_definitions,
    undefined,
  );
  await pi.events.get("session_start")![0](undefined, context);
  const restartedEvent = createPromptEvent();
  const restartedPrompt = await pi.events.get("before_agent_start")![0](
    restartedEvent,
    context,
  );
  assert.equal(restartedPrompt, undefined);
  assert.ok(restartedEvent.systemPromptOptions.sections.agent_definitions);
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
  assert.equal(readAgentState(mailbox), undefined);
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
  const sessionStartHandlers = pi.events.get("session_start") ?? [];
  assert.equal(sessionStartHandlers.length, 1);
  await sessionStartHandlers[0](undefined, context);
  assert.ok(readAgentState(mailbox), "fresh managed agent was not initialized");
  const contextHandlers = pi.events.get("context") ?? [];
  assert.equal(contextHandlers.length, 1);
  const ordinaryContext = {
    messages: [{ role: "user", content: "ordinary turn" }],
  };
  assert.equal(contextHandlers[0](ordinaryContext, context), undefined);
  const event: any = {
    systemPromptOptions: { sections: {}, contextFiles: [] },
  };
  const prompt = await pi.events.get("before_agent_start")![0](event, context);
  assert.equal(prompt, undefined);
  assert.match(
    event.systemPromptOptions.sections.pi_herdsman_agent,
    /identity: agent:delegating-agent/,
  );
  assert.match(
    event.systemPromptOptions.sections.pi_herdsman_agent,
    /direct_owner: lead/,
  );
  assert.match(
    event.systemPromptOptions.sections.delegating_agent_role,
    /## Delegating agent role/,
  );
  assert.match(
    event.systemPromptOptions.sections.delegating_agent_role,
    /integration, validation, or onward handoff/,
  );
  assert.doesNotMatch(
    event.systemPromptOptions.sections.delegating_agent_role,
    /message_supervisor/,
  );
  assert.match(
    event.systemPromptOptions.sections.agent_definitions,
    /Use list_agents for live Agent state/,
  );
  const roster = JSON.parse(
    event.systemPromptOptions.sections.agent_definitions.split(
      "\n\nThis is the session-start definition snapshot.",
    )[0],
  );
  assert.equal(
    pi.sentMessageCalls.some(
      ({ message }: any) =>
        message?.customType === "pi-herdsman-supervisor-state",
    ),
    false,
  );
  assert.deepEqual(
    roster.map((definition: Record<string, unknown>) => definition.name),
    ["scout"],
  );
  assert.equal(roster[0].model, undefined);
  assert.equal(roster[0].thinking, undefined);
  assert.doesNotMatch(
    event.systemPromptOptions.sections.agent_definitions.split(
      "\n\nThis is the session-start definition snapshot.",
    )[0],
    /\n/,
  );
  const listResult = await pi.tools
    .find((tool) => tool.name === "list_agents")!
    .execute("list", {}, undefined, undefined, context);
  assert.deepEqual(
    roster,
    listResult.details.agent_definitions,
    JSON.stringify(listResult.details),
  );
  const agentListTool = pi.tools.find((tool) => tool.name === "list_agents")!;
  const delegateTool = pi.tools.find((tool) => tool.name === "delegate_agent")!;
  assert.equal(
    Value.Check(delegateTool.parameters, {
      definition: "scout",
      task: "review this",
    }),
    true,
  );
  assert.equal(
    Value.Check(delegateTool.parameters, {
      definition: "implementer",
      task: "review this",
    }),
    false,
  );
  assert.match(agentListTool.description, /list current owned Agent state/i);
  assert.match(agentListTool.description, /Do not use for progress polling/i);
  assert.doesNotMatch(
    agentListTool.description,
    /agent_(?:delegate|continue|steer|interrupt|reply|close|inspect|transcript)/,
  );
  const sharedGuidance = agentListTool.promptGuidelines?.join(" ") ?? "";
  assert.match(
    sharedGuidance,
    /Delegate bounded execution work when an Agent can reasonably own it and delegation is useful/,
  );
  assert.match(
    sharedGuidance,
    /delegation would add more coordination than value/,
  );
  assert.doesNotMatch(
    sharedGuidance,
    /genuinely independent or context-heavy work/,
  );
  for (const toolName of [
    "list_agents",
    "delegate_agent",
    "continue_agent",
    "steer_agent",
    "interrupt_agent",
    "reply_agent",
    "close_agent",
    "inspect_agent",
    "read_agent_transcript",
  ])
    assert.ok(
      sharedGuidance.includes(toolName),
      `missing ${toolName} guidance`,
    );
  const description =
    `${agentListTool.description} ${agentListTool.promptGuidelines?.join(" ")}`.replaceAll(
      /\s+/g,
      " ",
    );
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
    /Agent-started agents are leaves\. Delegate bounded execution work when an Agent can reasonably\s+own it and delegation is useful\./,
  );
  assert.doesNotMatch(
    description,
    /genuinely independent or context-heavy work|independent or unfamiliar work/,
  );
  assert.match(
    description,
    /Each unresolved unit of work has one executor\. Using delegate_agent transfers that assignment's execution ownership to the Agent until it resolves\. After delegation succeeds, stop executing, inspecting, or analyzing that delegated scope locally; do not assign overlapping work\. Continue only concrete, necessary work clearly outside the delegated scope that you still own\./,
  );
  assert.match(
    sharedGuidance,
    /Each live Agent generation exists for one assignment/,
  );
  assert.match(
    sharedGuidance,
    /exact Pi sessions identify historical context and continuation/,
  );
  assert.match(sharedGuidance, /physical disappearance is not completion/);
  assert.match(
    sharedGuidance,
    /Unknown or conflicting identity remains fail-closed/,
  );
  for (const file of ["AGENTS\\.md", "CLAUDE\\.md", "GEMINI\\.md"])
    assert.match(sharedGuidance, new RegExp(file));
  assert.match(sharedGuidance, /do not attach or mention/i);
  assert.match(sharedGuidance, /Complete strict UTF-8 text may be embedded/);
  assert.match(
    sharedGuidance,
    /canonical local references and are not copied or snapshotted/,
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

test("replaced Manager body keeps its protected prompt contract and tools", async () => {
  setLeadEnvironment();
  writeFileSync(
    join(PI_AGENTS_DIR, "manager.md"),
    "---\nname: manager\nbodyMode: replace\n---\nCustom Manager strategy",
  );
  process.env.HERDR_PANE_ID = "manager-pane";
  process.env.HERDR_TAB_ID = "manager-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `manager-contract-${randomUUID()}.sock`,
  );
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  const managerIdentity = () => ({
    pane_id: process.env.HERDR_PANE_ID,
    tab_id: process.env.HERDR_TAB_ID,
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
  });
  const pi = fakePi({
    activeTools: ["read", "bash"],
    allTools: REGISTERED_ROLE_TOOLS,
    exec: (_command, args) =>
      args[0] === "workspace" && args[1] === "get"
        ? respond({ workspace: { worktree: { repo_key: "repo-key" } } })
        : args[0] === "worktree" && args[1] === "list"
          ? respond({
              source: {
                source_workspace_id: WORKSPACE,
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [],
            })
          : isAgentList(args)
            ? respond({ agents: [managerIdentity()] })
            : args[0] === "agent" && args[1] === "get"
              ? respond({ agent: managerIdentity() })
              : isApiSnapshot(args)
                ? respond({ snapshot: { agents: [], panes: [] } })
                : respond({}),
  });
  const context = fakeContext(pi.entries) as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("manager").handler("", context);
    assert.equal(
      readLeadCoordinationState(
        supervisionRuntime(),
        context.sessionManager.getSessionId(),
      )?.role,
      "manager",
      notices.join("\n"),
    );
    const event = {
      systemPrompt: "base",
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](event, context);
    const prompt = event.systemPromptOptions.sections.pi_herdsman_role;
    assert.match(prompt, /verified Manager for this Pi session/);
    assert.match(prompt, /Supervision is event-driven/);
    assert.match(prompt, /Custom Manager strategy/);
    assert.doesNotMatch(
      prompt,
      /Coordinate assigned project work through Leads/,
    );
    for (const name of [
      "list_staff",
      "inspect_staff",
      "read_staff_transcript",
      "message_staff",
      "delegate_project",
      "resume_project",
      "stop_lead",
      "remove_worktree",
    ])
      assert.ok(
        pi.pi.getActiveTools().includes(name),
        `${name} is active for the Manager`,
      );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  }
});

test("delegating agents do not receive Manager supervisor projections", async () => {
  const mailbox = setAgentEnvironment("manager-projection-agent", ["scout"]);
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `managed-supervisor-state-${randomUUID()}.sock`,
  );
  const runtime = supervisionRuntime();
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const managerId = randomUUID();
  const branch = "smoke/managed-supervisor-state";
  process.env.HERDR_WORKSPACE_ID = "linked-workspace";
  const manager = claimManagerLease({
    build: HERDSMAN_BUILD,
    piSessionId: managerId,
    paneId: "manager-pane",
    tabId: "manager-tab",
    workspaceId: WORKSPACE,
    repoKey: "repo-key",
  });
  writeProjectAssignment(runtime, {
    version: 2,
    id: sessionId,
    repoKey: "repo-key",
    branch,
    text: "assigned project",
  });
  writeLeadCoordinationState(runtime, {
    version: 1,
    role: "manager",
    instanceId: randomUUID(),
    piSessionId: managerId,
    build: HERDSMAN_BUILD,
    updatedAt: Date.now(),
  });
  const managerAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: managerId,
    },
    pane_id: "manager-pane",
    tab_id: "manager-tab",
    workspace_id: WORKSPACE,
  };
  const delegateAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: sessionId,
    },
    pane_id: "registered-pane",
    tab_id: "registered-tab",
    workspace_id: "linked-workspace",
  };
  const controllerState = {
    ...managedState("manager-projection-agent"),
    piSessionId: sessionId,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const baseExec = agentControllerExecutor(controllerState);
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              workspace: {
                worktree: { repo_key: "repo-key", is_linked_worktree: true },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
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
              worktrees: [{ branch, open_workspace_id: "linked-workspace" }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [managerAgent, delegateAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agent: [managerAgent, delegateAgent].find(
                (a) => a.pane_id === args[2],
              ),
            },
          }),
          stderr: "",
          code: 0,
        };
      return baseExec(command, args);
    },
  });
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId,
        definition: "agent",
        label: "manager-projection-agent",
      },
    },
  ];
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries) as any;
  try {
    const sessionStartHandlers = pi.events.get("session_start") ?? [];
    assert.equal(sessionStartHandlers.length, 1);
    await sessionStartHandlers[0](undefined, context);
    const event: any = {
      systemPromptOptions: { sections: {}, contextFiles: [] },
    };
    await pi.events.get("before_agent_start")![0](event, context);
    assert.match(
      event.systemPromptOptions.sections.pi_herdsman_agent,
      /direct_owner: lead/,
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }: any) =>
          message?.customType === "pi-herdsman-supervisor-state",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    manager.release();
    invalidateLeadCoordinationState(runtime, managerId);
    removeProjectAssignment(runtime, "repo-key", branch);
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    resetAgentMailbox(mailbox);
  }
});

test("delegating roster discovery failure does not abort managed startup", async () => {
  const mailbox = setAgentEnvironment("roster-failure-agent", ["scout"]);
  const state = managedState("roster-failure-agent");
  writeAgentState(mailbox, state);
  const malformed = join(PI_AGENTS_DIR, "malformed-roster.md");
  writeFileSync(
    malformed,
    "---\nname: malformed-roster\nmodel: {not valid json\n---\nbad\n",
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: "roster-failure-agent",
      },
    },
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries) as any;
  try {
    const sessionStartHandlers = pi.events.get("session_start") ?? [];
    assert.equal(sessionStartHandlers.length, 1);
    await sessionStartHandlers[0](undefined, context);
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_definition_error" &&
          /malformed-roster/.test(entry.data?.error),
      ),
    );
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_state_error",
      ),
      false,
    );
    assert.ok(readAgentState(mailbox));

    pi.events.get("session_shutdown")?.[0]();
    writeAgentState(mailbox, { ...state, agentLabel: "conflicting-label" });
    const firstNewEntry = entries.length;
    await sessionStartHandlers[0](undefined, context);
    const startupErrors = entries
      .slice(firstNewEntry)
      .filter(
        (entry: any) =>
          entry.customType === "pi_herdsman_definition_error" ||
          entry.customType === "pi_herdsman_state_error",
      );
    assert.ok(
      startupErrors.findIndex(
        (entry: any) => entry.customType === "pi_herdsman_definition_error",
      ) <
        startupErrors.findIndex(
          (entry: any) => entry.customType === "pi_herdsman_state_error",
        ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(malformed, { force: true });
    delete process.env.HERDR_PANE_ID;
  }
});

test("leaf agents and active Chiefs do not receive agent definition rosters", async () => {
  const mailbox = setAgentEnvironment("leaf-agent");
  const leaf = fakePi();
  registerExtension!(leaf.pi as never);
  assert.equal(leaf.events.has("before_agent_start"), true);
  const leafContext = fakeContext() as any;
  const leafEvent: any = {
    systemPromptOptions: {
      sections: {
        delegating_agent_role: "earlier extension role",
        agent_definitions: "earlier extension definitions",
      },
      contextFiles: [],
    },
  };
  await leaf.events.get("before_agent_start")![0](leafEvent, leafContext);
  assert.match(
    leafEvent.systemPromptOptions.sections.pi_herdsman_agent,
    /identity: agent:leaf-agent/,
  );
  assert.match(
    leafEvent.systemPromptOptions.sections.pi_herdsman_agent,
    /direct_owner: lead/,
  );
  assert.equal(
    leafEvent.systemPromptOptions.sections.delegating_agent_role,
    "earlier extension role",
  );
  assert.equal(
    leafEvent.systemPromptOptions.sections.agent_definitions,
    "earlier extension definitions",
  );
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
    },
  ];
  const chief = fakePi({
    entries,
    activeTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
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
  assert.equal(prompt?.message, undefined);
  const contextCall = chief.sentMessageCalls.findLast(
    ({ message }: any) =>
      message?.customType === "pi-herdsman-supervision-context",
  );
  assert.ok(contextCall);
  assert.deepEqual(contextCall.options, { triggerTurn: false });
  assert.equal((contextCall.message as any).display, false);
  assert.match(String((contextCall.message as any).content), /status="fresh"/);
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
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "chief",
        leadTools: REGISTERED_ROLE_TOOLS.map(({ name }) => name),
      },
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
  assert.equal(result?.message, undefined);
  const contextCall = pi.sentMessageCalls.findLast(
    ({ message }: any) =>
      message?.customType === "pi-herdsman-supervision-context",
  );
  assert.ok(contextCall);
  assert.deepEqual(contextCall.options, { triggerTurn: false });
  assert.equal((contextCall.message as any).display, false);
  assert.match(
    String((contextCall.message as any).content),
    /status="unavailable"/,
  );
  assert.match(
    String((contextCall.message as any).content),
    /Current supervision state could not be established/,
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
  assert.equal(reports.length, 3);
  assert.ok(reports[0].includes("pi_herdsman_name=first name"));
  assert.ok(reports[1].includes("pi_herdsman_name=first name"));
  assert.ok(reports[2].includes("pi_herdsman_name=new name"));
  pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_PANE_ID;
});

test("lead metadata failures do not escape the serialized queue", async (t) => {
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
        if (metadataCalls === 1 || metadataCalls === 3)
          throw new Error("metadata unavailable");
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
    assert.ok(pi.tools.some((tool) => tool.name === "message_supervisor"));
    await pi.events.get("session_info_changed")![0]({ name: "retry" }, context);
    await t.waitFor(() => assert.equal(metadataCalls, 2));
    const errorCount = () =>
      pi.entries.filter(
        (entry: any) => entry?.customType === "pi_herdsman_state_error",
      ).length;
    const errorsAfterFirstFailure = errorCount();
    await pi.events.get("session_info_changed")![0](
      { name: "fail after recovery" },
      context,
    );
    await t.waitFor(() => assert.equal(metadataCalls, 3));
    await t.waitFor(() =>
      assert.equal(errorCount(), errorsAfterFirstFailure + 1),
    );
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
  }
});

test("registered message_supervisor projects OperationError categories to tool results", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const tool = pi.tools.find(
      (candidate) => candidate.name === "message_supervisor",
    );
    assert.ok(tool);

    const result = await tool.execute(
      "call-id",
      { message: " " },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [
      { type: "text", text: "Message must contain non-whitespace text" },
    ]);
    assert.deepEqual(result.details, {
      error: {
        branchStatus: "operation_error_returned",
        category: "invalid_request",
      },
    });
    assert.doesNotMatch(
      JSON.stringify(result.details),
      /Message must|cause|message_supervisor/,
    );

    const persistedResult = {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "message_supervisor",
        toolCallId: "call-id",
        ...result,
      },
    };
    const sessionPath = join(
      testTmpRoot,
      `supervisor-message-${randomUUID()}.jsonl`,
    );
    const sessionHeader = {
      type: "session",
      version: 3,
      id: DEFAULT_PI_SESSION_ID,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const contents = [
      sessionHeader,
      {
        type: "message",
        id: "call-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "message_supervisor",
              id: "call-id",
              arguments: { message: "MANAGER_HANDOFF_READY" },
            },
          ],
        },
      },
      persistedResult,
    ];
    contents[2] = {
      ...contents[2],
      id: "result-entry",
      parentId: "call-entry",
      timestamp: new Date().toISOString(),
    };
    writeFileSync(
      sessionPath,
      contents.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    assert.deepEqual(
      supervisorMessageDiagnostics(
        sessionPath,
        DEFAULT_PI_SESSION_ID,
        "MANAGER_HANDOFF_READY",
      ),
      {
        supervisorSessionHeaderMatches: true,
        supervisorCallObserved: true,
        supervisorResultState: "error",
        supervisorErrorCategory: "invalid_request",
        supervisorHandlerBranchStatus: "operation_error_returned",
        supervisorPersistedErrorCategoryPresent: true,
        supervisorPersistedErrorCategory: "invalid_request",
      },
    );

    const nonOperationError = new Error("sensitive non-operation error");
    const hostileParams = new Proxy(
      {},
      {
        get() {
          throw nonOperationError;
        },
      },
    );
    await assert.rejects(
      tool.execute("call-id", hostileParams, undefined, undefined, context),
      (error: unknown) => error === nonOperationError,
    );
    const persistedThrownError = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "message_supervisor",
            id: "call-id",
            arguments: { message: "MANAGER_HANDOFF_READY" },
          },
        ],
      },
    };
    const persistedPiThrownResult = {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "message_supervisor",
        toolCallId: "call-id",
        isError: true,
        content: [{ type: "text", text: nonOperationError.message }],
      },
    };
    const thrownEntries = [
      sessionHeader,
      {
        ...persistedThrownError,
        id: "thrown-call-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
      },
      {
        ...persistedPiThrownResult,
        id: "thrown-result-entry",
        parentId: "thrown-call-entry",
        timestamp: new Date().toISOString(),
      },
    ];
    writeFileSync(
      sessionPath,
      thrownEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const thrownDiagnostics = supervisorMessageDiagnostics(
      sessionPath,
      DEFAULT_PI_SESSION_ID,
      "MANAGER_HANDOFF_READY",
    );
    assert.equal(thrownDiagnostics.supervisorResultState, "error");
    assert.equal(
      thrownDiagnostics.supervisorHandlerBranchStatus,
      "not_observed",
    );
    assert.equal(
      thrownDiagnostics.supervisorPersistedErrorCategoryPresent,
      false,
    );
    assert.equal(
      thrownDiagnostics.supervisorPersistedErrorCategory,
      "not_observed",
    );
    assert.doesNotMatch(
      JSON.stringify(thrownDiagnostics),
      /sensitive|PRIVATE/u,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    setLeadEnvironment();
  }
});

test("registered message_supervisor publishes for a Lead initialized from its exact assignment", async () => {
  setLeadEnvironment();
  const sessionId = randomUUID();
  const repoKey = `registered-managed-${randomUUID()}`;
  const branch = `registered-managed-${randomUUID()}`;
  process.env.HERDR_PANE_ID = "managed-lead-pane";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `registered-managed-${randomUUID()}.sock`,
  );
  const runtime = supervisionRuntime();
  writeProjectAssignment(runtime, {
    version: 2,
    id: sessionId,
    repoKey,
    branch,
    text: "registered message supervisor integration test",
  });
  const pi = fakePi({
    exec: (_command, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                source: {
                  repo_key: repoKey,
                  repo_name: repoKey,
                  source_workspace_id: WORKSPACE,
                },
                worktrees: [{ branch, open_workspace_id: WORKSPACE }],
              },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries) as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => sessionId,
  };
  const sessionStart = pi.events.get("session_start")![0];
  const sessionShutdown = pi.events.get("session_shutdown")![0];
  try {
    await sessionStart(undefined, context);
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry?.customType === "pi-herdsman-session-kind" &&
          entry.data?.sessionId === sessionId &&
          entry.data?.kind === "managed" &&
          entry.data?.repoKey === repoKey &&
          entry.data?.branch === branch,
      ),
      "session_start should establish Managed identity from the current assignment",
    );
    const tool = pi.tools.find(
      (candidate) => candidate.name === "message_supervisor",
    );
    assert.ok(tool);
    const result = await tool.execute(
      "call-id",
      { message: "registered managed supervisor publication" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.isError, undefined);
    const messages = listProjectMessageHeaders(runtime, repoKey, branch);
    assert.equal(messages.length, 1);
    const message = readProjectMessage(
      runtime,
      repoKey,
      branch,
      messages[0]!.id,
    );
    assert.equal(message?.fromSessionId, sessionId);
    assert.equal(message?.text, "registered managed supervisor publication");
  } finally {
    await sessionShutdown();
    for (const message of listProjectMessageHeaders(runtime, repoKey, branch))
      removeProjectMessage(runtime, repoKey, branch, message.id);
    removeProjectAssignment(runtime, repoKey, branch);
    setLeadEnvironment();
  }
});

test("disabled managed-agent definitions direct configuration to a Lead", async () => {
  const mailbox = setAgentEnvironment("delegating-agent", ["child"]);
  writeFileSync(
    join(PI_AGENTS_DIR, "agent.md"),
    "---\nname: agent\nenabled: false\n---\nagent instructions\n",
  );
  const parent = fakePi();
  registerExtension!(parent.pi as never);
  assert.deepEqual(parent.commands, []);
  const context = fakeAgentContext(parent.entries) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await parent.events.get("session_start")![0](undefined, context);
    const error = notices.find((message) =>
      message.includes("agent is disabled"),
    );
    assert.match(
      error ?? "",
      /enable it from a Lead session through \/herdsman → Definitions/,
    );
    assert.doesNotMatch(
      error ?? "",
      /enable it through \/herdsman → Definitions/,
    );
  } finally {
    parent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    setLeadEnvironment();
  }
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
  const context = fakeContext() as any;
  await pi.events.get("session_start")![0](undefined, context);

  const result = await pi.tools
    .find((tool) => tool.name === "list_agents")!
    .execute("list", {}, undefined, undefined, context);

  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.deepEqual(result.details.agents, []);
  pi.events.get("session_shutdown")?.[0]();
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

  const missingDisplayMailbox = setAgentEnvironment();
  delete process.env.PI_HERDSMAN_OWNER_DISPLAY;
  const missingDisplay = fakePi();
  registerExtension!(missingDisplay.pi as never);
  assert.equal(missingDisplay.events.has("before_agent_start"), false);
  assert.equal(readAgentState(missingDisplayMailbox), undefined);
  resetAgentMailbox(missingDisplayMailbox);
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
  assert.equal(readAgentState(mailbox), undefined);
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
  assert.ok(
    readAgentState(mailbox),
    "fresh managed session was not initialized",
  );
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi_herdsman_state_error",
    ),
    false,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("delegating managed agents refresh their status widget after controller changes", async (t) => {
  const label = "status-delegating-agent";
  const mailbox = setAgentEnvironment(label, ["child"]);
  const sessionFile = join(
    testTmpRoot,
    `status-delegating-${randomUUID()}.jsonl`,
  );
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    }) + "\n",
  );
  const parent = {
    ...managedState(label),
    ownerSessionId: process.env.PI_HERDSMAN_OWNER_SESSION_ID!,
    runId: process.env.PI_HERDSMAN_RUN_ID!,
    paneId: process.env.HERDR_PANE_ID!,
    piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    piSessionFile: sessionFile,
  };
  writeAgentState(mailbox, parent);
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label,
      },
    },
  ];
  const lifecycle = delegatedLifecycleExecutor(parent);
  const pi = fakePi({
    entries,
    exec: (command, args, options) =>
      command === "herdr" && args[0] === "pane" && args[1] === "split"
        ? { stdout: "", stderr: "intentional test launch failure", code: 1 }
        : lifecycle.exec(command, args, options),
  });
  const context = fakeAgentContext(entries) as any;
  context.sessionManager.getSessionFile = () => sessionFile;
  context.mode = "tui";
  context.hasUI = true;
  let registrations = 0;
  let renders = 0;
  const notifications: string[] = [];
  context.ui.notify = (message: string) => notifications.push(message);
  context.ui.setWidget = (_key: string, content: any) => {
    if (typeof content !== "function") return;
    registrations++;
    content(
      { requestRender: () => renders++ },
      {
        fg: (_color: string, value: string) => value,
        bold: (value: string) => value,
      },
    );
  };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() =>
    ({}) as ReturnType<typeof setInterval>) as typeof setInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(sessionFile, { force: true });
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  for (const start of pi.events.get("session_start") ?? [])
    await start(undefined, context);
  assert.equal(registrations, 1, notifications.join("\n"));
  await t.waitFor(() => assert.ok(renders > 0));
  const initialRenders = renders;
  const delegated = pi.tools
    .find((tool) => tool.name === "delegate_agent")!
    .execute(
      "status-change",
      { definition: "child", label: "status-child", task: "refresh" },
      undefined,
      undefined,
      context,
    );
  await t.waitFor(() => {
    assert.ok(renders > initialRenders);
  });
  const result = await delegated;
  assert.equal(result.details.ok, false);
  assert.match(result.details.error.message, /intentional test launch failure/);
});

test("presentation event bursts coalesce to one controller snapshot refresh", async (t) => {
  const label = "presentation-burst-agent";
  const mailbox = setAgentEnvironment(label, ["child"]);
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdsman-${randomUUID()}`
      : `/tmp/h-${randomUUID()}.sock`;
  process.env.HERDR_SOCKET_PATH = socketPath;
  const sessionFile = join(
    testTmpRoot,
    `presentation-burst-${randomUUID()}.jsonl`,
  );
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    }) + "\n",
  );
  const parent = {
    ...managedState(label),
    ownerSessionId: process.env.PI_HERDSMAN_OWNER_SESSION_ID!,
    runId: process.env.PI_HERDSMAN_RUN_ID!,
    paneId: process.env.HERDR_PANE_ID!,
    piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    piSessionFile: sessionFile,
  };
  writeAgentState(mailbox, parent);
  const server = createServer();
  const sockets = new Set<Socket>();
  let subscribed!: () => void;
  const subscriptionReady = new Promise<void>(
    (resolve) => (subscribed = resolve),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.write(
        JSON.stringify({
          id: request.id,
          result: { type: "subscription_started" },
        }) + "\n",
      );
      subscribed();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { sessionId: parent.piSessionId, definition: "agent", label },
    },
  ];
  let snapshotCalls = 0;
  const lifecycle = delegatedLifecycleExecutor(parent);
  const pi = fakePi({
    entries,
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args)) snapshotCalls++;
      return lifecycle.exec(command, args, options);
    },
  });
  const context = fakeAgentContext(entries) as any;
  context.sessionManager.getSessionFile = () => sessionFile;
  context.mode = "tui";
  context.hasUI = true;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  let presentationTimer: TimerHandler | undefined;
  globalThis.setInterval = (() => ({})) as typeof setInterval;
  t.after(async () => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    pi.events.get("session_shutdown")?.[0]();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetAgentMailbox(mailbox);
    realFs.rmSync(sessionFile, { force: true });
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  for (const start of pi.events.get("session_start") ?? [])
    await start(undefined, context);
  await subscriptionReady;
  await t.waitFor(() => assert.ok(snapshotCalls > 0));
  for (let turn = 0; turn < 4; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeBurst = snapshotCalls;

  globalThis.setTimeout = ((
    handler: TimerHandler,
    delay?: number,
    ...args: any[]
  ) => {
    if (typeof handler === "function") {
      presentationTimer = () => handler(...args);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  const socket = [...sockets][0]!;
  socket.write(
    Array.from(
      { length: 8 },
      () =>
        JSON.stringify({
          event: "pane_updated",
          data: { type: "pane_updated" },
        }) + "\n",
    ).join(""),
  );
  for (let turn = 0; turn < 4 && !presentationTimer; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    snapshotCalls,
    beforeBurst,
    "presentation refresh waits for its coalescing boundary",
  );
  assert.equal(typeof presentationTimer, "function");
  presentationTimer!();
  await t.waitFor(() => assert.equal(snapshotCalls, beforeBurst + 1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    snapshotCalls,
    beforeBurst + 1,
    "one event burst must not trigger one snapshot per notification",
  );
});

for (const delegationEnabled of [false, true]) {
  test(`${delegationEnabled ? "delegating" : "leaf"} status proves its Lead boundary from coordination state without opening transcripts`, async (t) => {
    const label = delegationEnabled
      ? "status-delegating-agent"
      : "status-lead-boundary";
    const mailbox = setAgentEnvironment(
      label,
      delegationEnabled ? ["child"] : undefined,
    );
    process.env.HERDR_SOCKET_PATH = join(
      tmpdir(),
      `status-lead-boundary-${randomUUID()}.sock`,
    );
    const ownerSessionId = LEAD_SESSION_ID;
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = ownerSessionId;
    process.env.PI_HERDSMAN_OWNER_DISPLAY = "lead";
    const leadPaneId = "status-boundary-lead-pane";
    const agentSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const agentPaneId = "status-boundary-agent-pane";
    const agentSessionFile = join(
      tmpdir(),
      `status-boundary-${randomUUID()}.jsonl`,
    );
    process.env.HERDR_PANE_ID = agentPaneId;
    process.env.HERDR_TAB_ID = "status-boundary-tab";
    writeAgentState(
      mailbox,
      managedState(label, undefined, {
        paneId: agentPaneId,
        tabId: "status-boundary-tab",
        piSessionId: agentSessionId,
        piSessionFile: agentSessionFile,
      }),
    );
    const identity = {
      agent: "pi",
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: agentSessionId,
      },
      workspace_id: WORKSPACE,
      pane_id: agentPaneId,
      tab_id: "status-boundary-tab",
      cwd: "/tmp",
      agent_status: "idle",
    };
    const lead = {
      agent: "pi",
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: ownerSessionId,
      },
      workspace_id: WORKSPACE,
      pane_id: leadPaneId,
      tab_id: "status-boundary-lead-tab",
      cwd: "/tmp",
      agent_status: "idle",
    };
    const entries = delegationEnabled
      ? [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: { sessionId: agentSessionId, definition: "agent", label },
          },
        ]
      : [];
    const pi = fakePi({
      entries,
      exec: (_command, args) =>
        isApiSnapshot(args)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: {
                  snapshot: {
                    agents: [identity, lead],
                    panes: [
                      {
                        pane_id: agentPaneId,
                        workspace_id: WORKSPACE,
                        agent: "pi",
                      },
                      {
                        pane_id: leadPaneId,
                        workspace_id: WORKSPACE,
                        agent: "pi",
                      },
                    ],
                  },
                },
              }),
              stderr: "",
              code: 0,
            }
          : { stdout: "{}", stderr: "", code: 0 },
    });
    const context = fakeAgentContext(entries) as any;
    context.sessionManager.getSessionFile = () => agentSessionFile;
    context.mode = "tui";
    context.hasUI = true;
    let widget: any;
    let registrations = 0;
    context.ui.setWidget = (_key: string, content: any) => {
      if (typeof content === "function") {
        registrations++;
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, value: string) => value,
            bold: (value: string) => value,
          },
        );
      }
    };
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionManager = SessionManager as any;
    const originalOpen = sessionManager.open;
    const originalSetInterval = globalThis.setInterval;
    let openCalls = 0;
    let refreshTimer: TimerHandler | undefined;
    globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
      if (delay === 10_000) refreshTimer = callback;
      return {} as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    t.after(() => {
      globalThis.setInterval = originalSetInterval;
      sessionManager.open = originalOpen;
      pi.events.get("session_shutdown")?.[0]();
      invalidateLeadCoordinationState(supervisionRuntime(), ownerSessionId);
      resetAgentMailbox(mailbox);
      delete process.env.HERDR_SOCKET_PATH;
      setLeadEnvironment();
    });
    sessionManager.open = (...args: any[]) => {
      openCalls++;
      return originalOpen.apply(sessionManager, args);
    };
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      build: HERDSMAN_BUILD,
      instanceId: randomUUID(),
      piSessionId: ownerSessionId,
      updatedAt: Date.now(),
    });
    assert.equal(readAgentState(mailbox)?.agentDefinition, undefined);
    registerExtension!(pi.pi as never);
    try {
      for (const start of pi.events.get("session_start") ?? [])
        await start(undefined, context);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
    assert.equal(registrations, 1);
    await t.waitFor(() =>
      assert.ok(
        widget.render(120)[0].includes(`lead → agent:${label}`),
        widget.render(120)[0],
      ),
    );
    if (!delegationEnabled) assert.equal(openCalls, 0);
    const statusIdentity = `${delegationEnabled ? "unknown" : "agent"}:${label}`;
    if (delegationEnabled) {
      // Startup enriches legacy state; keep the periodic read's fallback observable.
      const statusState = readAgentState(mailbox)!;
      delete statusState.agentDefinition;
      writeAgentState(mailbox, statusState);
      assert.equal(readAgentState(mailbox)?.agentDefinition, undefined);
      assert.equal(typeof refreshTimer, "function");
      (refreshTimer as () => void)();
      await t.waitFor(() =>
        assert.ok(
          widget.render(120)[0].includes(`lead → ${statusIdentity}`),
          widget.render(120)[0],
        ),
      );
    }
    const beforeRefresh = openCalls;

    invalidateLeadCoordinationState(supervisionRuntime(), ownerSessionId);
    assert.equal(typeof refreshTimer, "function");
    (refreshTimer as () => void)();
    await t.waitFor(() =>
      assert.ok(
        widget.render(120)[0].includes(`? → ${statusIdentity}`),
        widget.render(120)[0],
      ),
    );
    assert.equal(openCalls, beforeRefresh);
  });
}

test("periodic health loss reminders do not open transcripts for missing mailbox definitions", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "health-missing-definition-pane";
  process.env.HERDR_TAB_ID = "health-missing-definition-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `health-missing-definition-${randomUUID()}.sock`,
  );
  const label = "health-missing-definition";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = managedState(label, undefined, recoveryIdentity(label));
  assert.equal(state.agentDefinition, undefined);
  writeAgentState(mailbox, state);
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
  const context = fakeContext() as any;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionManager = SessionManager as any;
  const originalOpen = sessionManager.open;
  let openCalls = 0;
  sessionManager.open = (...args: any[]) => {
    openCalls++;
    return originalOpen.apply(sessionManager, args);
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    sessionManager.open = originalOpen;
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });

  await pi.events.get("session_start")![0](undefined, context);
  // Startup runtime recovery may use the explicit definition fallback; count
  // only calls caused by the periodic health reconciliation below.
  openCalls = 0;
  await t.waitFor(() =>
    assert.ok(
      pi.sentMessageCalls.some(
        ({ message }: any) => message?.customType === "pi-herdsman-agent-lost",
      ),
      "health reconciliation did not publish the lost assignment reminder",
    ),
  );
  const reminder = pi.sentMessageCalls.find(
    ({ message }: any) => message?.customType === "pi-herdsman-agent-lost",
  );
  assert.equal((reminder?.message as any).details.agentDefinition, "unknown");
  assert.equal(openCalls, 0);
});

test("registered inspect agent exposes process and recent activity evidence", async () => {
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
  const tool = pi.tools.find((candidate) => candidate.name === "inspect_agent");
  assert.ok(tool);
  try {
    const result = await tool.execute(
      "inspect-fixture",
      { agent: label },
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
      { args: { agent: label } },
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
      version: 5,
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
      input({ text: "__PI_HERDSMAN_AGENT_V5__:malformed" }, context),
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
    version: 5,
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

test("registered delegate rejects binary evidence without path-only delivery", async () => {
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
    await pi.events.get("session_start")![0](undefined, fakeContext());
    const result = await pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "id",
        {
          definition: "agent",
          label,
          task: "Inspect these.",
          files: [textPath, binaryPath],
        },
        undefined,
        undefined,
        fakeContext(),
      );
    assert.equal(result.details.ok, false, JSON.stringify(result.details));
    assert.equal(submittedRequest, undefined);
    assert.equal(prompted, "");
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(textPath, { force: true });
    realFs.rmSync(binaryPath, { force: true });
  }
});
