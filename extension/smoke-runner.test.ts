import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantResultForSession,
  assertOrdinaryLeadTools,
  chiefTreeRestoreFailure,
  chiefTreeFooter,
  chiefTreeSelectedRow,
  candidateArgs,
  parseChiefTreeProbeResult,
  chiefTreeProbeSource,
  chiefTreeBranchPlan,
  continuationResultsForPrompt,
  assertOwnerReplyOrder,
  initialPromptForScenario,
  inspectPaneProcesses,
  isolatedEnv,
  listedPanes,
  nestedControlEnv,
  ownerReplyProbeSource,
  ownerReplyEventMatches,
  ownerReplyResultMatches,
  ownerReplySnapshotDiagnostics,
  ownerReplyToolResultMatches,
  captureOwnerAskIdentity,
  nestedPaneInput,
  nestedPaneText,
  submitPaneCommand,
  preSecretOwnerReplyGate,
  parseScenario,
  persistedOwnerReplyCalls,
  sameOwnerAskIdentity,
  runScenario,
} from "../scripts/smoke.mjs";

test("smoke isolates nested Herdr routing and Pi paths", () => {
  const base = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/parent.sock",
    HERDR_CLIENT_SOCKET_PATH: "/parent-client.sock",
    HERDR_SESSION: "parent",
    HERDR_WORKSPACE_ID: "parent-workspace",
    HERDR_TAB_ID: "parent-tab",
    HERDR_PANE_ID: "parent-pane",
    HERDR_CONFIG_PATH: "/parent/config",
    XDG_CONFIG_HOME: "/parent/xdg-config",
    XDG_STATE_HOME: "/parent/xdg-state",
    PI_CODING_AGENT_DIR: "/parent/pi-agent",
    PI_CODING_AGENT_SESSION_DIR: "/parent/pi-sessions",
    KEEP_ME: "yes",
  };
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
  };
  const expected = {
    HERDR_ENV: "1",
    HERDR_CONFIG_PATH: paths.herdrConfig,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_STATE_HOME: paths.xdgState,
    PI_CODING_AGENT_DIR: paths.piAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    KEEP_ME: "yes",
  };
  assert.deepEqual(isolatedEnv(base, paths), expected);
  assert.deepEqual(nestedControlEnv(base, paths, "smoke-123"), {
    ...expected,
    HERDR_SESSION: "smoke-123",
  });
  assert.equal(base.HERDR_SESSION, "parent");
});

test("smoke scenario parsing accepts the four supported scenarios and defaults to core", async () => {
  assert.equal(parseScenario([]), "core");
  for (const scenario of ["core", "continuation", "owner-reply", "chief-tree"])
    assert.equal(parseScenario([scenario]), scenario);
  assert.throws(() => parseScenario(["wat"]), /unknown smoke scenario/);
  await assert.rejects(runScenario({}, "wat"), /unknown smoke scenario/);
});

test("owner-reply prompt keeps its generated secret private and requires separate owner input", () => {
  const ctx = {};
  const prompt = initialPromptForScenario("owner-reply", ctx);
  assert.ok(/^[a-f0-9]{12}$/i.test(ctx.ownerSecret));
  assert.ok(!prompt.includes(ctx.ownerSecret));
  assert.match(
    prompt,
    /must not answer the child or choose a value until a separate user message/i,
  );
});

test("chief-tree startup prompt creates one ordinary Lead branch for harness controls", () => {
  const prompt = initialPromptForScenario("chief-tree", {});
  assert.equal(prompt, "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.");
  assert.doesNotMatch(prompt, /\/chief|\/tree/i);
});

test("chief-tree requires a persisted post-Chief turn and targets the pre-Chief assistant branch", () => {
  const contents = [
    { type: "session", id: "session" },
    {
      type: "message",
      id: "startup-user",
      message: { role: "user", content: "startup prompt" },
    },
    {
      type: "message",
      id: "startup-answer",
      parentId: "startup-user",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      },
    },
    {
      type: "custom",
      id: "chief-state",
      parentId: "startup-answer",
      customType: "pi-herdsman-chief-state",
    },
    {
      type: "message",
      id: "chief-user",
      parentId: "chief-state",
      message: { role: "user", content: "post-Chief prompt" },
    },
    {
      type: "custom",
      id: "turn-metadata",
      parentId: "chief-user",
      customType: "pi-usage",
    },
    {
      type: "message",
      id: "chief-answer",
      parentId: "turn-metadata",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(
    chiefTreeBranchPlan(
      contents,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ),
    { targetId: "startup-answer" },
  );

  const noPostChiefTurn = contents.split("\n").slice(0, 3).join("\n");
  assert.match(
    chiefTreeBranchPlan(
      noPostChiefTurn,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /one completed Chief turn/,
  );
  const extraTurn = `${contents}\n${JSON.stringify({
    type: "message",
    id: "unexpected-answer",
    parentId: "chief-answer",
    message: { role: "assistant", stopReason: "stop", content: "" },
  })}`;
  assert.match(
    chiefTreeBranchPlan(
      extraTurn,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /unexpected completed model turn/,
  );
  const extraPrompt = `${contents}\n${JSON.stringify({
    type: "message",
    id: "unexpected-user",
    parentId: "chief-answer",
    message: { role: "user", content: "unrequested prompt" },
  })}`;
  assert.match(
    chiefTreeBranchPlan(
      extraPrompt,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /unexpected user prompt/,
  );
});

test("chief-tree selector locates the unique selected preview and reads the visible footer count", () => {
  assert.deepEqual(chiefTreeFooter("tree rows\n  (7/19)\n"), {
    selected: 7,
    total: 19,
  });
  assert.equal(chiefTreeFooter("tree rows\nnot a footer"), null);
  assert.equal(chiefTreeFooter("(0/0)"), null);
  assert.equal(
    chiefTreeSelectedRow(
      "    › ├─ • assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    true,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "  │  › └─ assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    true,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "    ├─ • assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "› assistant: PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
  assert.equal(
    chiefTreeSelectedRow(
      [
        "› assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
        "› assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      ].join("\n"),
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
});

test("nested pane input returns raw Herdr output and targets the exact isolated pane", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const rawOutput = { stdout: "pane input accepted", stderr: "", pid: 123 };
  const result = await nestedPaneInput(
    ctx,
    ["pane", "send-text", "w1:p2", "/chief"],
    async (file, args, options) => {
      assert.equal(file, "herdr");
      assert.deepEqual(args, ["pane", "send-text", "w1:p2", "/chief"]);
      assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
      assert.equal(options.env.HERDR_SOCKET_PATH, undefined);
      assert.equal(options.env.HERDR_WORKSPACE_ID, undefined);
      return rawOutput;
    },
  );
  assert.equal(result, rawOutput);
});

test("nested pane text reads bounded Herdr stdout without JSON parsing", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const screen = "startup Lead branch\n>";
  const text = await nestedPaneText(
    ctx,
    "w1:p2",
    "visible",
    async (file, args, options) => {
      assert.equal(file, "herdr");
      assert.deepEqual(args, [
        "pane",
        "read",
        "w1:p2",
        "--source",
        "visible",
        "--lines",
        "120",
      ]);
      assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
      return { stdout: screen, stderr: "", pid: 123 };
    },
  );
  assert.equal(text, screen);
});

test("pane commands submit literal text with one explicit Enter", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const calls = [];
  await submitPaneCommand(ctx, "w1:p2", "/chief", async (file, args) => {
    calls.push([file, args]);
    return { stdout: "", stderr: "", pid: 123 };
  });
  assert.deepEqual(calls, [
    ["herdr", ["pane", "send-text", "w1:p2", "/chief"]],
    ["herdr", ["pane", "send-keys", "w1:p2", "enter"]],
  ]);
});

test("owner-reply probe steers once only for the exact correlated ask event", () => {
  const secret = "a1b2c3d4e5f6";
  const question = "choose token for this smoke";
  const source = ownerReplyProbeSource(secret, question);
  assert.match(source, /pi\.on\("message_end"/);
  assert.match(source, /message\?\.customType === "pi-herdsman-agent-ask"/);
  assert.match(source, /ask\.question !== "choose token for this smoke"/);
  assert.match(source, /if \(submitted \|\|/);
  assert.match(
    source,
    /pi\.sendUserMessage\("a1b2c3d4e5f6", \{ deliverAs: "steer" \}\)/,
  );
  assert.equal((source.match(/pi\.sendUserMessage\(/g) ?? []).length, 1);
  assert.doesNotMatch(
    source,
    /registerCommand|isIdle|waitForIdle|sendMessage\(|mailbox|action:\s*["']reply/,
  );
  const event = {
    customType: "pi-herdsman-agent-ask",
    details: {
      question,
      agentLabel: "implementer",
      askId: "ask-1",
      requestId: "request-1",
      runId: "run-1",
      workspaceId: "workspace-1",
      paneId: "pane-1",
      piSessionId: "session-1",
    },
  };
  assert.equal(ownerReplyEventMatches(event, question), true);
  assert.equal(
    ownerReplyEventMatches({ ...event, customType: "other" }, question),
    false,
  );
  assert.equal(
    ownerReplyEventMatches(
      { ...event, details: { ...event.details, askId: "" } },
      question,
    ),
    false,
  );
  assert.equal(
    ownerReplyEventMatches(
      { ...event, details: { ...event.details, question: "other" } },
      question,
    ),
    false,
  );
});

test("owner-reply gate rejects successful or unresolved pre-secret reply calls without requiring idle", () => {
  const entries = (result) => [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "reply-call",
            name: "agent",
            arguments: { action: "reply", agent: "child", message: "guess" },
          },
        ],
      },
    },
    ...(result === "missing"
      ? []
      : [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "reply-call",
              toolName: "agent",
              ...(result === "unresolved" ? {} : { isError: result }),
            },
          },
        ]),
  ];

  assert.equal(preSecretOwnerReplyGate(entries(true)), "ready");
  assert.equal(preSecretOwnerReplyGate(entries(false)), "successful");
  assert.equal(preSecretOwnerReplyGate(entries("missing")), "unresolved");
  assert.equal(preSecretOwnerReplyGate(entries("unresolved")), "unresolved");
  assert.equal(preSecretOwnerReplyGate([]), "ready");
});

test("owner-reply correlation rejects a different askId", () => {
  const ask = {
    askId: "ask-1",
    requestId: "request-1",
    runId: "run-1",
    workspaceId: "workspace-1",
    agentLabel: "child",
    paneId: "w1:p2",
    piSessionId: "session-1",
  };
  assert.equal(sameOwnerAskIdentity(ask, { ...ask }), true);
  assert.equal(sameOwnerAskIdentity({ ...ask, askId: "ask-2" }, ask), false);
});

test("owner-reply captures the first persisted ask identity before checking the snapshot", () => {
  const details = {
    askId: "ask-1",
    requestId: "request-1",
    runId: "run-1",
    workspaceId: "workspace-1",
    agentLabel: "child",
    paneId: "w1:p2",
    piSessionId: "session-1",
  };
  const firstAsk = { customType: "pi-herdsman-agent-ask", details };
  const originalAskIdentity = captureOwnerAskIdentity(firstAsk);

  assert.deepEqual(originalAskIdentity, details);
  details.askId = "mutated-after-capture";
  assert.equal(originalAskIdentity.askId, "ask-1");
  assert.deepEqual(
    captureOwnerAskIdentity(
      { message: { details: { ...originalAskIdentity } } },
      originalAskIdentity,
    ),
    originalAskIdentity,
  );
  assert.throws(
    () =>
      captureOwnerAskIdentity(
        { details: { ...originalAskIdentity, askId: "ask-2" } },
        originalAskIdentity,
      ),
    /pending ask identity changed/,
  );
});

test("owner-reply requires persisted ask, user message, successful reply, then child result", () => {
  const ask = {
    askId: "ask-1",
    requestId: "request-1",
    runId: "run-1",
    workspaceId: "workspace-1",
    agentLabel: "child",
    paneId: "w1:p2",
    piSessionId: "session-1",
  };
  const childResult = {
    id: "child-result",
    parentId: "turn",
    type: "custom",
    customType: "pi-herdsman-agent-result",
    details: { ...ask },
    content: [{ type: "text", text: "a1b2c3d4e5f6" }],
  };
  const replyCall = {
    id: "reply-call-entry",
    parentId: "turn",
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "reply-id",
          name: "agent",
          arguments: {
            action: "reply",
            agent: "child",
            message: "a1b2c3d4e5f6",
          },
        },
      ],
    },
  };
  const replyResult = {
    id: "reply-result-entry",
    parentId: "reply-call-entry",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "reply-id",
      toolName: "agent",
      isError: false,
      details: {
        action: "reply",
        agent: "child",
        ask_id: "ask-1",
        assignment_request_id: "request-1",
        session_id: "session-1",
      },
    },
  };
  const toolDetails = replyResult.message.details;
  assert.equal(ownerReplyToolResultMatches(toolDetails, ask), true);
  for (const key of [
    "ask_id",
    "assignment_request_id",
    "session_id",
    "agent",
  ]) {
    const wrong = { ...toolDetails, [key]: "other" };
    assert.equal(
      ownerReplyToolResultMatches(wrong, ask),
      false,
      `mismatched ${key} must fail`,
    );
  }
  const askEntry = { customType: "pi-herdsman-agent-ask" };
  const userMessage = {
    type: "message",
    message: { role: "user", content: "a1b2c3d4e5f6" },
  };
  const entries = [askEntry, userMessage, replyCall, replyResult, childResult];
  const reply = persistedOwnerReplyCalls(entries)[0];
  assert.equal(reply.status, "successful");
  assert.deepEqual(
    assertOwnerReplyOrder(
      entries,
      askEntry,
      userMessage,
      reply.resultEntry,
      childResult,
    ),
    [0, 1, 3, 4],
  );
  assert.throws(
    () =>
      assertOwnerReplyOrder(
        [childResult, askEntry, userMessage, replyCall],
        askEntry,
        userMessage,
        reply.entry,
        childResult,
      ),
    /ask < user message < successful reply < child result/,
  );
  assert.equal(ownerReplyResultMatches(childResult, ask, "a1b2c3d4e5f6"), true);
  assert.equal(
    ownerReplyResultMatches(
      { ...childResult, details: { ...ask, runId: "other" } },
      ask,
      "a1b2c3d4e5f6",
    ),
    false,
  );
  assert.equal(
    ownerReplyResultMatches(
      childResult,
      { ...ask, paneId: "other" },
      "a1b2c3d4e5f6",
    ),
    false,
  );
  const diagnostic = ownerReplySnapshotDiagnostics(entries, ask);
  assert.equal(diagnostic.calls[0].matchesOriginalAsk, true);
  assert.deepEqual(
    diagnostic.entries.map(({ id, parentId }) => [id, parentId]),
    [
      [null, null],
      [null, null],
      ["reply-call-entry", "turn"],
      ["reply-result-entry", "reply-call-entry"],
      ["child-result", "turn"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(diagnostic), /a1b2c3d4e5f6/);
});

test("Chief tree probe is opt-in, last in root extension order, and validates restored Lead tools", () => {
  const config = {
    candidateExtension: "/candidate/dist/index.js",
    herdrStateExtension: "/isolated/herdr-agent-state.ts",
    model: "provider/model",
    thinking: "high",
  };
  assert.deepEqual(candidateArgs(config), [
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--model",
    config.model,
    "--thinking",
    config.thinking,
  ]);
  const args = candidateArgs({
    ...config,
    chiefTreeProbeExtension: "/isolated/chief-tree-tools.mjs",
  });
  assert.deepEqual(args.slice(args.indexOf("--extension")), [
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--extension",
    "/isolated/chief-tree-tools.mjs",
    "--model",
    config.model,
    "--thinking",
    config.thinking,
  ]);
  const ownerArgs = candidateArgs({
    ...config,
    ownerReplyProbeExtension: "/isolated/smoke-owner-reply.mjs",
  });
  assert.deepEqual(ownerArgs.slice(ownerArgs.indexOf("--extension")), [
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--extension",
    "/isolated/smoke-owner-reply.mjs",
    "--model",
    config.model,
    "--thinking",
    config.thinking,
  ]);
  const resultPath = "/tmp/pi-herdsman-smoke/chief-tree-tools.json";
  const source = chiefTreeProbeSource(resultPath);
  assert.match(source, /session_tree/);
  assert.match(source, /PI_HERDSMAN_SMOKE_TOOLS/);
  assert.match(source, /getActiveTools\(\)/);
  assert.ok(source.includes(JSON.stringify(resultPath)));
  assert.match(source, /writeFile/);
  assert.doesNotMatch(source, /stdout|console\.log/);

  const parsed = parseChiefTreeProbeResult(
    JSON.stringify({
      marker: "PI_HERDSMAN_SMOKE_TOOLS",
      eventCount: 1,
      tools: ["agent", "chief", "peer"],
    }),
  );
  const tools = parsed.tools;
  assert.deepEqual(tools, ["agent", "chief", "peer"]);
  assertOrdinaryLeadTools(tools);
  assert.match(
    parseChiefTreeProbeResult("PI_HERDSMAN_SMOKE_TOOLS nope").error,
    /JSON is malformed/,
  );
  assert.match(
    parseChiefTreeProbeResult(
      JSON.stringify({
        marker: "PI_HERDSMAN_SMOKE_TOOLS",
        eventCount: 2,
        tools: ["staff"],
      }),
    ).error,
    /expected one/,
  );
  assert.throws(
    () => assertOrdinaryLeadTools(["agent", "chief", "peer", "staff"]),
    /Chief-only staff/,
  );
});

test("Chief tree Lead-restoration failure reports the exact probe and observed tool classification", () => {
  const record = {
    marker: "PI_HERDSMAN_SMOKE_TOOLS",
    eventCount: 1,
    tools: ["read", "bash", "edit", "write", "staff"],
  };
  let failure;
  try {
    assertOrdinaryLeadTools(record.tools);
  } catch (error) {
    failure = chiefTreeRestoreFailure(record.tools, record, error);
  }
  assert.match(failure, /restored Lead is missing agent/);
  assert.ok(failure.includes(`marker record=${JSON.stringify(record)}`));
  assert.ok(
    failure.includes(
      `observed post-session_tree=${JSON.stringify({
        leadToolsMissing: ["agent", "chief", "peer"],
        staff: "present",
      })}`,
    ),
  );
});

test("core requires the prompt-correlated root assistant marker, not root status", () => {
  const prompt = "delegate the task";
  const marker = "PI_HERDSMAN_SMOKE_OK pi-herdsman@0.16.0";
  const contents = [
    { type: "message", id: "user", message: { role: "user", content: prompt } },
    {
      type: "message",
      id: "answer",
      parentId: "user",
      message: { role: "assistant", stopReason: "stop", content: marker },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  for (const status of ["idle", "done"])
    assert.equal(
      assistantResultForSession({ status, contents: "" }, prompt, marker),
      null,
    );
  assert.equal(
    assistantResultForSession({ contents }, prompt, marker)?.id,
    "answer",
  );
});

test("continuation accepts a prefixed marker only in the stopped response descended from its exact prompt", () => {
  const prompt = "continue the saved session";
  const marker = "PI_HERDSMAN_CONTINUATION_SECOND";
  const contents = [
    {
      type: "message",
      id: "other-user",
      message: { role: "user", content: "unrelated prompt" },
    },
    {
      type: "message",
      id: "other-answer",
      parentId: "other-user",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: `pi-herdsman ${marker}`,
      },
    },
    {
      type: "message",
      id: "followup",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "response",
      parentId: "followup",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: `pi-herdsman ${marker}`,
      },
    },
    {
      type: "message",
      id: "unfinished",
      parentId: "followup",
      message: { role: "assistant", stopReason: "toolUse", content: marker },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.deepEqual(
    continuationResultsForPrompt(contents, prompt, marker).map(
      (entry) => entry.id,
    ),
    ["response"],
  );
  assert.equal(assistantResultForSession({ contents }, prompt, marker), null);
});

test("core counts distinct non-root pane/PID processes with both extension paths, without role labels", async () => {
  const panes = listedPanes({
    result: {
      panes: [
        { pane_id: "root", definition: "lead" },
        { pane_id: "child-pane" },
        { pane_id: "grandchild-pane" },
        { pane_id: "unrelated-pane" },
      ],
    },
  });
  const response = {
    "child-pane": {
      process_info: {
        foreground_processes: [
          {
            pid: 11,
            argv: [
              "pi",
              "--extension",
              "/candidate/dist/index.js",
              "--extension",
              "/isolated/herdr-agent-state.ts",
            ],
          },
          { pid: 11, cmdline: "duplicate same process" },
        ],
      },
    },
    "grandchild-pane": {
      process_info: {
        foreground_processes: [
          {
            pid: 21,
            cmdline:
              "pi --extension /candidate/dist/index.js --extension /isolated/herdr-agent-state.ts",
          },
        ],
      },
    },
    "unrelated-pane": {
      process_info: {
        foreground_processes: [
          { pid: 31, cmdline: "pi --extension /candidate/dist/index.js" },
        ],
      },
    },
  };
  const result = await inspectPaneProcesses(
    panes,
    "root",
    async (paneId) => response[paneId],
    "/candidate/dist/index.js",
    "/isolated/herdr-agent-state.ts",
  );
  assert.deepEqual(
    result.verified.map(({ paneId, pid }) => [paneId, pid]),
    [
      ["child-pane", 11],
      ["grandchild-pane", 21],
    ],
  );
  assert.equal(result.verified.length, 2);
  assert.ok(
    result.verified.every(
      (record) => !("identity" in record) && !("definition" in record),
    ),
  );
});

test("process evidence requires both exact extension paths and excludes root pane", async () => {
  const result = await inspectPaneProcesses(
    ["root", "missing-extension", "missing-pane"],
    "root",
    async (paneId) => {
      if (paneId === "missing-pane") throw new Error("pane disappeared");
      return {
        process_info: {
          foreground_processes: [
            { pid: 42, cmdline: "pi --extension /candidate/dist/index.js" },
          ],
        },
      };
    },
    "/candidate/dist/index.js",
    "/isolated/herdr-agent-state.ts",
  );
  assert.deepEqual(result.verified, []);
  assert.deepEqual(
    result.records.map(({ paneId, processMatch, error }) => [
      paneId,
      processMatch,
      error,
    ]),
    [
      ["missing-extension", false, null],
      ["missing-pane", false, "pane disappeared"],
    ],
  );
});
