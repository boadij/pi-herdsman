import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  assistantResultForSession,
  chiefTreeFooter,
  chiefTreeSelectedRow,
  candidateArgs,
  chiefTreeProbeSource,
  distinctPaneCount,
  parseToolSnapshots,
  chiefTreeBranchPlan,
  managerRecoveryFreshPrompt,
  managerRecoveryClosePrompt,
  managerRecoveryResumeOnlyPrompt,
  managerRecoveryResumePrompt,
  continuationResultsForPrompt,
  continuationSessionEvidence,
  correlatedContinuationTask,
  managerChildSessionEvidence,
  initialPromptForScenario,
  inspectPaneProcesses,
  isolatedEnv,
  listedPanes,
  nestedControlEnv,
  nestedHerdrApiSocketPath,
  nestedPaneInput,
  nestedPaneText,
  submitPaneCommand,
  submitManagerLeave,
  parseSmokeArgs,
  formatSmokeFailure,
  managerDiagnosticLines,
  captureManagerLeadDiagnostics,
  savedSessionHeaderEvidence,
  staffDelegateResults,
  staffCloseResults,
  assertManagerResultSettlement,
  hasManagerResultReceipt,
  managerResultDelivery,
  supervisorResultAccepted,
  prepareManagerRepository,
  assertManagerFreshPrimary,
  deleteBranchIfPresent,
  hasSuccessfulSupervisorMessage,
  leadReadyCompleted,
  verifiedLeadSession,
  managerReadyAnswer,
  exactIsolatedSession,
  isolatedSessionDetails,
  preparePi,
  resolveSmokeModel,
  runScenario,
} from "../scripts/smoke.mjs";

test("missing managed session file is not ready yet", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  try {
    assert.equal(
      await isolatedSessionDetails(
        { paths: { piSessions } },
        {
          agent_session: {
            kind: "path",
            value: join(piSessions, "pending.jsonl"),
          },
        },
      ),
      undefined,
    );
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
});

test("saved-session evidence separates header identity from continuation task instruction", () => {
  const followup = "Continue this exact saved session.";
  const contents = [
    { type: "session", id: "actual-session" },
    {
      type: "message",
      message: { role: "user", content: followup },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.deepEqual(savedSessionHeaderEvidence(contents, "expected-session"), {
    expectedSessionId: "expected-session",
    actualSessionId: "actual-session",
    sessionHeaderFound: true,
    sessionIdMatches: false,
  });
  assert.deepEqual(
    continuationSessionEvidence(contents, "expected-session", followup),
    {
      sessionHeaderFound: true,
      sessionIdMatches: false,
      continuationTaskFound: true,
      taskInstructionFound: true,
    },
  );
  assert.equal(
    continuationSessionEvidence(
      contents,
      "actual-session",
      "missing instruction",
    ).taskInstructionFound,
    false,
  );
});

test("continuation task evidence accepts the paraphrased task only in child user text", () => {
  const task =
    "Recall the exact package name from your previous assignment; do not reread package.json. Return PI_HERDSMAN_CONTINUATION_SECOND.";
  const rootPrompt =
    "Without rereading package.json, return the remembered package name.";
  for (const [role, content, expected] of [
    [
      "user",
      `Assignment:\n${task.toLowerCase().replaceAll(" ", "\n")}\nEnd assignment.`,
      true,
    ],
    ["user", rootPrompt, false],
    ["assistant", task, false],
  ] as const) {
    const contents = [
      { type: "session", id: "saved-session" },
      {
        type: "message",
        message: {
          role,
          content,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const evidence = continuationSessionEvidence(
      contents,
      "saved-session",
      task,
    );
    assert.equal(evidence.sessionIdMatches, true);
    assert.equal(evidence.taskInstructionFound, expected);
    assert.equal(
      continuationSessionEvidence(contents, "saved-session", null)
        .taskInstructionFound,
      false,
    );
  }
});

test("continuation task parser correlates tool call, successful session result and response ancestry", () => {
  const task = "Recall the exact package name; return SECOND.";
  const prompt = "Without rereading package.json...";
  const entries = [
    {
      type: "message",
      id: "prompt",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "call",
      parentId: "prompt",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "other-call",
            name: "agent_continue",
            arguments: { task: "wrong task" },
          },
          {
            type: "toolCall",
            id: "continue-call",
            name: "agent_continue",
            arguments: { session: "/saved/child.jsonl", task },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: "call",
      message: {
        role: "toolResult",
        toolName: "agent_continue",
        toolCallId: "continue-call",
        details: { ok: true, action: "continue", session_id: "child" },
      },
    },
    {
      type: "message",
      id: "response",
      parentId: "tool-result",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "package SECOND",
      },
    },
  ];
  const encode = (value: unknown[]) =>
    value.map((entry) => JSON.stringify(entry)).join("\n");
  assert.equal(
    correlatedContinuationTask(encode(entries), "response", "child", prompt),
    task,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "response",
      "wrong-child",
      prompt,
    ),
    null,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "missing-response",
      "child",
      prompt,
    ),
    null,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "response",
      "child",
      "another prompt",
    ),
    null,
  );
  for (const mutation of [
    (copy: any[]) => {
      copy[2].message.toolCallId = "missing-call";
    },
    (copy: any[]) => {
      copy[2].message.isError = true;
    },
    (copy: any[]) => {
      copy[2].message.details.ok = false;
    },
    (copy: any[]) => {
      copy[3].parentId = "prompt";
    },
    (copy: any[]) => {
      copy.splice(3, 0, {
        type: "message",
        id: "new-prompt",
        parentId: "tool-result",
        message: { role: "user", content: prompt },
      });
      copy[4].parentId = "new-prompt";
    },
    (copy: any[]) => {
      delete copy[1].message.content[1].arguments.task;
    },
    (copy: any[]) => {
      copy[1].message.content[1].arguments.task = " ";
    },
    (copy: any[]) => {
      copy[1].message.content[1].arguments.task = "x".repeat(16 * 1024 + 1);
    },
  ]) {
    const copy = structuredClone(entries);
    mutation(copy);
    assert.equal(
      correlatedContinuationTask(encode(copy), "response", "child", prompt),
      null,
    );
  }
  const child = encode([
    { type: "session", id: "wrong-child" },
    { type: "message", message: { role: "user", content: task } },
  ]);
  const evidence = continuationSessionEvidence(child, "child", task);
  assert.equal(evidence.sessionIdMatches, false);
  assert.equal(evidence.taskInstructionFound, true);
  assert.doesNotMatch(JSON.stringify(evidence), /wrong-child|Recall/);
  assert.equal(
    continuationSessionEvidence(child, "child", null).continuationTaskFound,
    false,
  );
});

test("manager readiness evidence includes a workspace child's mismatched session header", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  const path = join(piSessions, "lead.jsonl");
  try {
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", id: "actual-session" })}\n${JSON.stringify({ secret: "not diagnostic" })}\n`,
    );
    const evidence = await managerChildSessionEvidence(
      { paths: { piSessions } },
      [
        {
          workspace_id: "assigned-workspace",
          agent_session: { kind: "path", value: path },
        },
      ],
      "assigned-workspace",
      "expected-session",
    );

    assert.deepEqual(evidence, {
      workspaceId: "assigned-workspace",
      expectedSessionId: "expected-session",
      candidates: [
        {
          identityKind: "path",
          reportedSessionId: null,
          path,
          exists: true,
          expectedSessionId: "expected-session",
          actualSessionId: "actual-session",
          sessionHeaderFound: true,
          sessionIdMatches: false,
        },
      ],
      expectedSessionFile: null,
    });
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
});

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

test("nested Herdr hashes the API socket while checking both socket limits", () => {
  const paths = { xdgConfig: "/tmp/xdg" };
  assert.equal(
    nestedHerdrApiSocketPath(paths, "smoke"),
    join(paths.xdgConfig, "herdr", "sessions", "smoke", "herdr.sock"),
  );
  const directory = join(paths.xdgConfig, "herdr", "sessions");
  const clientOnlyTooLong = "x".repeat(
    99 -
      Buffer.byteLength(join(directory, "herdr.sock")) -
      Buffer.byteLength(sep),
  );
  assert.ok(
    Buffer.byteLength(join(directory, clientOnlyTooLong, "herdr.sock")) + 1 <=
      100,
  );
  assert.throws(
    () => nestedHerdrApiSocketPath(paths, clientOnlyTooLong),
    /herdr-client\.sock path is too long/,
  );
});

test("smoke CLI parses scenarios and one-off model overrides", async () => {
  assert.deepEqual(parseSmokeArgs([]), {
    scenario: "core",
    model: undefined,
    managerReadyTimeoutMs: undefined,
    managerRecoveryDiagnostics: false,
  });
  for (const scenario of [
    "core",
    "continuation",
    "chief-tree",
    "manager-recovery",
  ])
    assert.equal(parseSmokeArgs([scenario]).scenario, scenario);
  assert.deepEqual(
    parseSmokeArgs(["chief-tree", "--model", "provider/model:high"]),
    {
      scenario: "chief-tree",
      model: "provider/model:high",
      managerReadyTimeoutMs: undefined,
      managerRecoveryDiagnostics: false,
    },
  );
  assert.deepEqual(
    parseSmokeArgs(["--model", "provider/model:xhigh", "continuation"]),
    {
      scenario: "continuation",
      model: "provider/model:xhigh",
      managerReadyTimeoutMs: undefined,
      managerRecoveryDiagnostics: false,
    },
  );
  assert.throws(() => parseSmokeArgs(["core", "extra"]));
  assert.throws(() => parseSmokeArgs(["--unknown"]));
  assert.throws(() => parseSmokeArgs(["wat"]), /unknown smoke scenario/);
  await assert.rejects(runScenario({}, "wat"), /unknown smoke scenario/);
});

test("manager-recovery timeout is bounded and scoped to its ready handshake", () => {
  assert.deepEqual(
    parseSmokeArgs([
      "manager-recovery",
      "--manager-ready-timeout-ms",
      "45000",
      "--manager-recovery-diagnostics",
    ]),
    {
      scenario: "manager-recovery",
      model: undefined,
      managerReadyTimeoutMs: 45_000,
      managerRecoveryDiagnostics: true,
    },
  );
  for (const timeout of ["0", "-1", "1.5", "600001", "many"])
    assert.throws(
      () =>
        parseSmokeArgs([
          "manager-recovery",
          `--manager-ready-timeout-ms=${timeout}`,
        ]),
      /positive integer no greater than 600000/,
    );
  assert.throws(
    () => parseSmokeArgs(["core", "--manager-ready-timeout-ms", "45000"]),
    /only valid for manager-recovery/,
  );
  assert.throws(
    () => parseSmokeArgs(["core", "--manager-recovery-diagnostics"]),
    /only valid for manager-recovery/,
  );
});

test("manager diagnostics retain bounded pane evidence", () => {
  const prefix = "[pi-herdsman-manager-diagnostic] ";
  const events = [
    { event: "session_start_reached" },
    { event: "initial_inbox_drain_start" },
    {
      event: "project_assignment_authorization",
      outcome: "rejected",
      reason: "live_lead_mismatch",
    },
    {
      event: "project_assignment_send",
      outcome: "resolved",
      triggerTurn: true,
    },
    {
      event: "project_assignment_authorization",
      outcome: "authorized",
      reason: "matched",
    },
    {
      event: "project_assignment_send",
      outcome: "rejected",
      triggerTurn: false,
      payload: "secret",
    },
  ];
  const lines = managerDiagnosticLines(
    [
      "unrelated pane content containing a secret",
      ...events.map((event) => `${prefix}${JSON.stringify(event)}`),
    ].join("\n"),
  );
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.startsWith(prefix)));
  assert.doesNotMatch(lines.join("\n"), /secret/);
  assert.ok(lines.every((line) => line.length <= 512));
  assert.deepEqual(
    lines,
    events.slice(0, 4).map((event) => `${prefix}${JSON.stringify(event)}`),
  );
});

test("manager drain checkpoints are allowlisted, deduplicated and bounded without private fields", () => {
  const prefix = "[pi-herdsman-manager-diagnostic] ";
  const events = [
    { event: "session_start_reached" },
    { event: "initial_inbox_drain_start" },
    ...["scope", "topology", "live_lead"].flatMap((stage) => [
      { event: `project_assignment_${stage}_start` },
      { event: `project_assignment_${stage}_complete` },
    ]),
    {
      event: "project_assignment_authorization",
      outcome: "authorized",
      reason: "matched",
    },
    {
      event: "project_assignment_send",
      outcome: "resolved",
      triggerTurn: true,
    },
    { event: "inbox_preflight", reason: "pass" },
    { event: "inbox_preflight_recheck", reason: "pass" },
    { event: "inbox_peer_presence", reason: "missing" },
    { event: "inbox_candidates", count: 1000 },
    { event: "inbox_drain_complete", count: 1, sessionStable: true },
    { event: "inbox_catch", category: "drain" },
  ];
  const encode = (event: object) => `${prefix}${JSON.stringify(event)}`;
  const lines = managerDiagnosticLines(
    [
      `${prefix}{malformed`,
      ...[
        { event: "unknown", payload: "secret" },
        { event: "inbox_preflight", reason: "secret" },
        { event: "inbox_peer_presence", reason: "stale" },
        { event: "inbox_candidates", count: -1 },
        { event: "inbox_candidates", count: 1001 },
        { event: "inbox_candidates", count: 0.5 },
        { event: "inbox_candidates", count: "1" },
        { event: "inbox_drain_complete", count: 0, sessionStable: "secret" },
        { event: "inbox_catch", category: "secret" },
      ].map(encode),
      ...events.map((event) =>
        encode({
          ...event,
          sessionId: "secret",
          path: "secret",
          payload: "secret",
        }),
      ),
      ...Array.from({ length: 40 }, () =>
        encode({ event: "inbox_candidates", count: 0 }),
      ),
    ].join("\n"),
  );
  assert.deepEqual(lines, events.map(encode));
  assert.equal(lines.length, 16);
  assert.doesNotMatch(lines.join("\n"), /secret|sessionId|payload|path/);
  assert.ok(lines.every((line) => line.length <= 512));
  assert.deepEqual(managerDiagnosticLines(undefined), []);

  for (const event of [
    { event: "inbox_preflight", reason: "held" },
    { event: "inbox_preflight_recheck", reason: "stale" },
    { event: "inbox_preflight_recheck", reason: "held" },
    { event: "inbox_peer_presence", reason: "pass" },
    { event: "inbox_candidates", count: 0 },
    { event: "inbox_drain_complete", count: 0, sessionStable: false },
    ...[
      "cleanup",
      "authorization",
      "send",
      "reconcile",
      "candidate_scan",
      "transaction",
    ].map((category) => ({ event: "inbox_catch", category })),
  ])
    assert.deepEqual(managerDiagnosticLines(encode(event)), [encode(event)]);
});

test("successful manager recovery projects opt-in Lead diagnostics without changing acceptance", async () => {
  const prefix = "[pi-herdsman-manager-diagnostic] ";
  const ctx = {
    managerRecoveryDiagnostics: true,
    managerRecovery: {
      stage: "lead-ready-handshake",
      sessionId: "lead-session",
    },
  };
  await captureManagerLeadDiagnostics(
    ctx,
    "lead-pane",
    async (context, paneId, source) => {
      assert.equal(context, ctx);
      assert.equal(paneId, "lead-pane");
      assert.equal(source, "recent-unwrapped");
      return [
        "private pane text",
        `${prefix}{"event":"session_start_reached","payload":"private"}`,
        `${prefix}{"event":"session_start_reached"}`,
        `${prefix}{"event":"inbox_preflight","reason":"pass"}`,
        `${prefix}{"event":"unknown","payload":"private"}`,
      ].join("\n");
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.managerRecovery)), {
    stage: "lead-ready-handshake",
    sessionId: "lead-session",
    leadDiagnostics: [
      `${prefix}{"event":"session_start_reached"}`,
      `${prefix}{"event":"inbox_preflight","reason":"pass"}`,
    ],
  });

  await captureManagerLeadDiagnostics(ctx, "lead-pane", async () => {
    throw new Error("pane unavailable");
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.managerRecovery)).leadDiagnostics,
    [],
  );
  const disabled = { managerRecoveryDiagnostics: false, managerRecovery: {} };
  await captureManagerLeadDiagnostics(disabled, "lead-pane", async () => {
    assert.fail("diagnostics must remain opt-in");
  });
  assert.deepEqual(disabled.managerRecovery, {});
});

test("smoke failure report separates stage from error details", () => {
  assert.equal(
    formatSmokeFailure(
      new TypeError("leave wait timed out"),
      "manager-leave-output-wait",
    ),
    "stage: manager-leave-output-wait\nerror: TypeError: leave wait timed out",
  );
});

test("smoke model override wins without reading Git config", async () => {
  assert.equal(
    await resolveSmokeModel(" provider/model:high ", async () => {
      throw new Error("Git config should not be read");
    }),
    "provider/model:high",
  );
  await assert.rejects(
    resolveSmokeModel("  ", async () => {
      throw new Error("Git config should not be read");
    }),
    /smoke --model must not be empty/,
  );
});

test("smoke model falls back to effective Git config", async () => {
  const model = await resolveSmokeModel(
    undefined,
    async (file, args, options) => {
      assert.equal(file, "git");
      assert.deepEqual(args, ["config", "--get", "pi-herdsman.smoke-model"]);
      assert.ok(options.cwd);
      return { stdout: "provider/model:xhigh\n", stderr: "", pid: 1 };
    },
  );
  assert.equal(model, "provider/model:xhigh");
});

test("smoke model requires configuration when no override exists", async () => {
  const missing = Object.assign(new Error("not found"), { code: 1 });
  await assert.rejects(
    resolveSmokeModel(undefined, async () => {
      throw missing;
    }),
    /git config --local pi-herdsman\.smoke-model/,
  );
});

test("smoke model propagates Git failures", async () => {
  const failure = Object.assign(new Error("invalid Git config"), { code: 3 });
  await assert.rejects(
    resolveSmokeModel(undefined, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("smoke auth resolves credentials from the configured model", async () => {
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
    authLink: "/smoke/pi-agent/auth.json",
  };
  const calls = [];
  const mechanism = await preparePi(
    paths,
    "provider/model:high",
    async (file, args) => {
      calls.push([file, args]);
      return { stdout: "", stderr: "", pid: 1 };
    },
  );
  assert.equal(mechanism, "ambient");
  assert.deepEqual(calls, [
    ["pi", ["auth", "check", "--model", "provider/model:high", "--no-refresh"]],
  ]);
});

test("chief-tree startup prompt creates one ordinary Lead branch for harness controls", () => {
  const prompt = initialPromptForScenario("chief-tree", {});
  assert.equal(prompt, "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.");
  assert.doesNotMatch(prompt, /\/chief|\/tree/i);
});

test("manager-recovery starts without a chat prompt", () => {
  assert.equal(initialPromptForScenario("manager-recovery", {}), undefined);
});

test("manager-recovery starts work by task and branch, then resumes by branch only", () => {
  const branch = "herdsman/smoke-manager-recovery-exact";
  const prompt = managerRecoveryFreshPrompt(branch);
  assert.match(prompt, /staff_delegate exactly once to start new project work/);
  assert.match(prompt, /`task` argument/);
  assert.match(
    prompt,
    /`branch` argument to exactly herdsman\/smoke-manager-recovery-exact/,
  );
  assert.match(prompt, /Omit `base` and `files`/);
  assert.doesNotMatch(prompt, /`assignment`/);
  assert.match(
    prompt,
    /after staff_delegate returns, end this turn immediately/,
  );
  assert.match(prompt, /Wait until the exact MANAGER_RECOVERY_READY message/);
  assert.match(prompt, /Only after that delivered message, reply exactly/);
  assert.doesNotMatch(prompt, /MANAGER_RECOVERY_FINISH/);
  const resume = managerRecoveryResumePrompt(branch);
  assert.match(
    resume,
    /staff_delegate using only:\n\{"branch":"herdsman\/smoke-manager-recovery-exact"\}/,
  );
  assert.match(resume, /PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED/);
  assert.doesNotMatch(resume, /staff_message|session-exact/);
  assert.doesNotMatch(resume, /"assignment"|"task"|"base"|"files"/);
});

test("manager-recovery pauses and resumes by exact durable handles", () => {
  const session = "01a0ed33-3720-75bd-908c-44c05c6a2fd9";
  const branch = "herdsman/smoke-manager-recovery-exact";
  const close = managerRecoveryClosePrompt(session);
  assert.match(close, /staff_close exactly once/);
  assert.ok(close.includes(JSON.stringify({ session })));
  assert.match(close, /PI_HERDSMAN_MANAGER_RECOVERY_PAUSED/);
  const resume = managerRecoveryResumeOnlyPrompt(branch);
  assert.match(resume, /staff_delegate exactly once/);
  assert.ok(resume.includes(JSON.stringify({ branch })));
  assert.match(resume, /PI_HERDSMAN_MANAGER_RECOVERY_RESUMED/);
});

test("smoke parses successful staff_close results only", () => {
  const result = {
    ok: true,
    action: "close",
    session: "lead-session",
    branch: "feat/example",
  };
  const contents = [
    {
      toolName: "staff_close",
      content: [{ type: "text", text: "Lead closed; project work preserved." }],
      details: result,
    },
    { toolName: "staff_delegate", content: JSON.stringify(result) },
    { toolName: "staff_close", isError: true, content: JSON.stringify(result) },
  ]
    .map((message) =>
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", ...message },
      }),
    )
    .join("\n");
  assert.deepEqual(staffCloseResults(contents), [result]);
});

test("staff delegate results retain only valid successful delegation payloads in order", () => {
  const messages = [
    { toolName: "unrelated", content: '{"ok":true,"action":"delegate"}' },
    { toolName: "staff_delegate", content: "not JSON" },
    {
      toolName: "staff_delegate",
      content: "not JSON",
      details: { ok: true, action: "delegate", session: "must-not-match" },
    },
    {
      toolName: "staff_delegate",
      isError: true,
      content: '{"ok":true,"action":"delegate"}',
    },
    {
      toolName: "staff_delegate",
      content:
        '{"ok":true,"action":"delegate","branch":"feat/fresh","session":"fresh"}',
    },
    {
      toolName: "staff_delegate",
      content:
        '{"ok":true,"action":"delegate","branch":"feat/fresh","session":"fresh","state":"working"}',
    },
  ];
  const contents = messages
    .map((message, index) =>
      JSON.stringify({
        type: "message",
        id: `entry-${index}`,
        message: { role: "toolResult", ...message },
      }),
    )
    .join("\n");
  assert.deepEqual(staffDelegateResults(contents), [
    { ok: true, action: "delegate", branch: "feat/fresh", session: "fresh" },
    {
      ok: true,
      action: "delegate",
      branch: "feat/fresh",
      session: "fresh",
      state: "working",
    },
  ]);
});

test("Manager result delivery is branch-keyed, semantic, and followed by its triggered turn", () => {
  const branch = "feature/bootstrap";
  const sessionId = "lead-session";
  const contents = [
    {
      type: "custom_message",
      id: "inbox-message",
      customType: "pi-herdsman-report_result",
      details: { branch, fromSessionId: sessionId, leadSessionId: sessionId },
      content: `Project work ${branch} finished:\n\nMANAGER_RECOVERY_DONE`,
    },
    {
      type: "message",
      id: "follow-up",
      parentId: "inbox-message",
      message: { role: "user", content: "result" },
    },
    {
      type: "message",
      parentId: "follow-up",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_OK",
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(managerResultDelivery(contents, branch, sessionId), {
    receipt: contents.split("\n").map(JSON.parse)[0],
    answer: contents.split("\n").map(JSON.parse)[2],
  });
  assert.equal(managerResultDelivery(contents, "other", sessionId), null);
  assert.equal(hasManagerResultReceipt(contents, branch, sessionId), true);
  assert.doesNotMatch(contents, /result:[0-9a-f-]{36}/i);
  assertManagerResultSettlement({
    resultPersisted: true,
    delivered: false,
    assignmentExists: true,
  });
  assertManagerResultSettlement({
    resultPersisted: true,
    delivered: true,
    assignmentExists: false,
  });
  assert.throws(
    () =>
      assertManagerResultSettlement({
        resultPersisted: false,
        delivered: false,
        assignmentExists: true,
      }),
    /persisted first/,
  );
  assert.throws(
    () =>
      assertManagerResultSettlement({
        resultPersisted: true,
        delivered: false,
        assignmentExists: false,
      }),
    /undelivered result must preserve/,
  );
});

test("Manager-away supervisor_result persists before notification reconciliation", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "supervisor_result",
        details: {
          ok: true,
          action: "result",
          branch: "feature/bootstrap",
          queued: false,
        },
      },
    },
  ];
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");
  assert.equal(supervisorResultAccepted(contents, "feature/bootstrap"), true);
  assert.equal(supervisorResultAccepted(contents, "other"), false);
  assert.equal(
    supervisorResultAccepted(
      JSON.stringify({
        type: "message",
        message: { ...entries[0].message, isError: true },
      }),
      "feature/bootstrap",
    ),
    false,
  );
});

test("Manager smoke creates a fresh Git primary without pre-opening a worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-manager-smoke-"));
  try {
    const calls = [];
    const checkout = await prepareManagerRepository({ root }, async (...args) =>
      calls.push(args),
    );
    assert.equal(checkout, join(root, "project"));
    assert.deepEqual(
      calls.map((call) => call[1][0]),
      ["init", "-c"],
    );
    assert.deepEqual(calls[1][1].slice(-4), [
      "commit",
      "--allow-empty",
      "-m",
      "Smoke root",
    ]);
    assertManagerFreshPrimary(
      "root",
      checkout,
      { workspace_id: "root" },
      {
        source: {
          repo_key: "repo",
          repo_name: "project",
          source_workspace_id: "root",
          source_checkout_path: checkout,
        },
        worktrees: [{ open_workspace_id: "root" }],
      },
    );
    assert.throws(
      () =>
        assertManagerFreshPrimary(
          "root",
          checkout,
          { workspace_id: "root" },
          {
            source: {
              repo_key: "repo",
              repo_name: "project",
              source_workspace_id: "root",
              source_checkout_path: checkout,
            },
            worktrees: [{ open_workspace_id: "linked" }],
          },
        ),
      /linked workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("smoke branch cleanup treats only a proven absent local branch as already clean", async () => {
  const calls = [];
  const absent = Object.assign(new Error("not found"), { code: 1 });
  assert.equal(
    await deleteBranchIfPresent("herdsman/smoke-exact", async (...args) => {
      calls.push(args);
      throw absent;
    }),
    false,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/herdsman/smoke-exact",
  ]);

  calls.length = 0;
  assert.equal(
    await deleteBranchIfPresent("herdsman/smoke-exact", async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "", pid: 1 };
    }),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call[1][0]),
    ["show-ref", "branch"],
  );
  await assert.rejects(
    deleteBranchIfPresent("herdsman/smoke-exact", async () => {
      throw Object.assign(new Error("git failed"), { code: 128 });
    }),
    /git failed/,
  );
});

test("Manager recovery READY requires a successful supervisor_message tool result", () => {
  const ready = "MANAGER_RECOVERY_READY";
  const promptOnly = JSON.stringify({
    type: "message",
    message: { role: "user", content: `Please send ${ready}.` },
  });
  const call = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "ready-call",
          name: "supervisor_message",
          arguments: { message: ready },
        },
      ],
    },
  });
  const result = (isError = false) =>
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "supervisor_message",
        toolCallId: "ready-call",
        isError,
        content: "Message sent to supervisor.",
      },
    });
  assert.equal(hasSuccessfulSupervisorMessage(promptOnly, ready), false);
  assert.equal(
    hasSuccessfulSupervisorMessage(`${call}\n${result(true)}`, ready),
    false,
  );
  assert.equal(hasSuccessfulSupervisorMessage(call, ready), false);
  assert.equal(
    hasSuccessfulSupervisorMessage(`${call}\n${result()}`, ready),
    true,
  );
  assert.equal(leadReadyCompleted(`${call}\n${result()}`, ready), false);
  const stopped = JSON.stringify({
    type: "message",
    message: { role: "assistant", stopReason: "stop", content: "Waiting." },
  });
  assert.equal(
    leadReadyCompleted(`${call}\n${stopped}\n${result()}`, ready),
    false,
  );
  assert.equal(
    leadReadyCompleted(`${result()}\n${call}\n${stopped}`, ready),
    false,
  );
  assert.equal(
    leadReadyCompleted(`${call}\n${result(true)}\n${stopped}`, ready),
    false,
  );
  assert.equal(
    leadReadyCompleted(`${call}\n${result()}\n${stopped}`, ready),
    true,
  );
});

test("Manager recovery READY never matches missing session identities", () => {
  for (const [child, expected] of [
    [undefined, undefined],
    [undefined, "lead-id"],
    [{ id: "lead-id" }, undefined],
    [{ id: undefined }, undefined],
    [{ id: "" }, ""],
  ])
    assert.equal(verifiedLeadSession(child, expected), false);
  assert.equal(verifiedLeadSession({ id: "lead-id" }, "lead-id"), true);
});

test("Manager READY answer follows delivered message even on a separate followUp branch", () => {
  const lead = "lead-id";
  const entries = [
    { type: "session", id: "chief-id" },
    {
      type: "message",
      id: "delegation",
      message: { role: "user", content: "delegate" },
    },
    {
      type: "message",
      id: "premature",
      parentId: "delegation",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_READY",
      },
    },
    {
      type: "custom_message",
      id: "receipt",
      customType: "pi-herdsman-lead_message",
      content: `From lead ${lead} to chief chief-id: MANAGER_RECOVERY_READY`,
    },
    {
      type: "message",
      id: "follow-up",
      parentId: "receipt",
      message: { role: "user", content: "followUp" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "follow-up",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_READY",
      },
    },
  ];
  const contents = (items) =>
    items.map((entry) => JSON.stringify(entry)).join("\n");
  assert.deepEqual(managerReadyAnswer(contents(entries.slice(0, 3)), lead), {
    receipt: false,
    answer: null,
    prematureReady: true,
    prematureFinish: false,
  });
  assert.deepEqual(managerReadyAnswer(contents(entries.slice(0, 5)), lead), {
    receipt: true,
    answer: null,
    prematureReady: true,
    prematureFinish: false,
  });
  const noPrematureAnswer = entries.filter((entry) => entry.id !== "premature");
  assert.deepEqual(
    managerReadyAnswer(contents(noPrematureAnswer.slice(0, 3)), lead),
    {
      receipt: true,
      answer: null,
      prematureReady: false,
      prematureFinish: false,
    },
  );
  assert.equal(
    managerReadyAnswer(contents(noPrematureAnswer), lead).answer?.id,
    "answer",
  );
  assert.equal(
    managerReadyAnswer(contents(entries), lead).prematureReady,
    true,
  );
  assert.equal(
    managerReadyAnswer(contents(entries), "wrong-lead").answer,
    null,
  );
  const prematureFinish = [
    ...noPrematureAnswer.slice(0, 4),
    {
      type: "message",
      id: "finish-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "finish-tool-call",
            name: "staff_message",
            arguments: { message: "MANAGER_RECOVERY_FINISH" },
          },
        ],
      },
    },
    ...noPrematureAnswer.slice(4),
  ];
  assert.equal(
    managerReadyAnswer(contents(prematureFinish), lead).prematureFinish,
    true,
  );
});

test("ID-only Lead identity resolves only exact bounded isolated session", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  try {
    const contents = JSON.stringify({ type: "session", id: "lead-id" });
    await writeFile(join(piSessions, "opaque.jsonl"), contents);
    assert.equal(
      (await exactIsolatedSession({ paths: { piSessions } }, "lead-id"))
        ?.contents,
      contents,
    );
    assert.equal(
      await exactIsolatedSession({ paths: { piSessions } }, "other"),
      undefined,
    );
    await writeFile(join(piSessions, "duplicate.jsonl"), contents);
    await assert.rejects(
      exactIsolatedSession({ paths: { piSessions } }, "lead-id"),
      /ambiguous/,
    );
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
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

test("Manager leave submits text and Enter as one ordered pane operation", async () => {
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
  await submitManagerLeave(ctx, "w1:p2", async (file, args, options) => {
    calls.push([file, args]);
    assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
    return { stdout: "", stderr: "", pid: 123 };
  });
  assert.deepEqual(calls, [
    ["herdr", ["pane", "run", "w1:p2", "/manager leave"]],
  ]);
  let attempts = 0;
  await assert.rejects(
    submitManagerLeave(ctx, "w1:p2", async () => {
      attempts++;
      throw new Error("submission uncertain");
    }),
    /submission uncertain/,
  );
  assert.equal(attempts, 1);
});

test("Chief tree probe is opt-in, last in root extension order, and validates three tool snapshots", () => {
  const config = {
    candidateExtension: "/candidate/dist/index.js",
    herdrStateExtension: "/isolated/herdr-agent-state.ts",
    model: "provider/model:high",
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
  ]);
  const resultPath = "/tmp/pi-herdsman-smoke/chief-tree-tools.json";
  const source = chiefTreeProbeSource(resultPath);
  assert.match(source, /getActiveTools/);
  assert.match(source, /session_tree/);
  assert.match(source, /smoke-tools/);
  const snapshots = parseToolSnapshots(
    [
      '{"label":"lead","tools":["chief","agent"]}',
      '{"label":"chief","tools":["staff"]}',
      '{"label":"tree","tools":["staff"]}',
    ].join("\n"),
  );
  assert.deepEqual(snapshots.get("lead"), ["agent", "chief"]);
  assert.notDeepEqual(snapshots.get("chief"), snapshots.get("lead"));
  assert.deepEqual(snapshots.get("tree"), snapshots.get("chief"));
  assert.throws(() =>
    parseToolSnapshots(
      '{"label":"lead","tools":[]}\n{"label":"lead","tools":[]}',
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
  assert.equal(
    distinctPaneCount([
      { paneId: "same", pid: 1 },
      { paneId: "same", pid: 2 },
    ]),
    1,
  );
  assert.equal(
    distinctPaneCount([
      { paneId: "child", pid: 1 },
      { paneId: "scout", pid: 2 },
    ]),
    2,
  );
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
