import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  continuationResultsForPrompt,
  initialPromptForScenario,
  inspectPaneProcesses,
  isolatedEnv,
  listedPanes,
  nestedControlEnv,
  nestedPaneInput,
  nestedPaneText,
  submitPaneCommand,
  submitManagerLeave,
  parseSmokeArgs,
  formatSmokeFailure,
  staffDelegateResults,
  hasManagerResultRef,
  assertManagerRootWorktreeGroup,
  managerPrimaryCheckout,
  managerWorktreeOpenArgs,
  assertManagerOpenedPrimary,
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

test("smoke CLI parses scenarios and one-off model overrides", async () => {
  assert.deepEqual(parseSmokeArgs([]), { scenario: "core", model: undefined });
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
    },
  );
  assert.deepEqual(
    parseSmokeArgs(["--model", "provider/model:xhigh", "continuation"]),
    {
      scenario: "continuation",
      model: "provider/model:xhigh",
    },
  );
  assert.throws(() => parseSmokeArgs(["core", "extra"]));
  assert.throws(() => parseSmokeArgs(["--unknown"]));
  assert.throws(() => parseSmokeArgs(["wat"]), /unknown smoke scenario/);
  await assert.rejects(runScenario({}, "wat"), /unknown smoke scenario/);
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

test("manager-recovery starts with one ordinary Lead startup turn", () => {
  assert.equal(
    initialPromptForScenario("manager-recovery", {}),
    "Reply exactly with PI_HERDSMAN_MANAGER_RECOVERY_STARTUP.",
  );
});

test("manager-recovery fresh delegation specifies only fresh-delegation fields", () => {
  const branch = "herdsman/smoke-manager-recovery-exact";
  const prompt = managerRecoveryFreshPrompt(branch);
  assert.match(prompt, /staff_delegate exactly once for a fresh assignment/);
  assert.match(prompt, /`task` argument/);
  assert.match(
    prompt,
    /`branch` argument to exactly herdsman\/smoke-manager-recovery-exact/,
  );
  assert.match(
    prompt,
    /Omit `assignment` and recovery-only fields \(`base` and `files`\)/,
  );
});

test("staff delegate results retain only valid successful delegation payloads in order", () => {
  const messages = [
    { toolName: "unrelated", content: '{"ok":true,"action":"delegate"}' },
    { toolName: "staff_delegate", content: "not JSON" },
    {
      toolName: "staff_delegate",
      isError: true,
      content: '{"ok":true,"action":"delegate"}',
    },
    {
      toolName: "staff_delegate",
      content: '{"ok":true,"action":"delegate","assignment":"fresh"}',
    },
    {
      toolName: "staff_delegate",
      content:
        '{"ok":true,"action":"delegate","assignment":"recovered","recovered":true}',
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
    { ok: true, action: "delegate", assignment: "fresh" },
    { ok: true, action: "delegate", assignment: "recovered", recovered: true },
  ]);
});

test("manager result ref is read from the delivered report-result custom message", () => {
  const assignment = "assignment-id";
  const contents = [
    {
      type: "message",
      message: { role: "user", content: `Result ref: result:${assignment}` },
    },
    {
      type: "custom_message",
      customType: "other",
      content: `Result ref: result:${assignment}`,
    },
    {
      type: "custom_message",
      customType: "pi-herdsman-report_result",
      content: "Result ref: result:other-assignment",
    },
    {
      type: "custom_message",
      customType: "pi-herdsman-report_result",
      content: `Lead result received.\nResult ref: result:${assignment}`,
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.equal(hasManagerResultRef(contents, assignment), true);
  assert.equal(hasManagerResultRef(contents, "missing"), false);
});

test("Manager recovery requires the primary workspace's verified Herdr worktree group", () => {
  const workspace = {
    worktree: { repo_key: "repo", is_linked_worktree: false },
  };
  assert.equal(
    assertManagerRootWorktreeGroup("root", workspace, {
      source: { repo_key: "repo" },
      worktrees: [],
    }),
    "root",
  );
  assert.throws(
    () =>
      assertManagerRootWorktreeGroup(
        "root",
        {},
        { source: { repo_key: "repo" } },
      ),
    /belong to a Herdr Git worktree group/,
  );
  assert.throws(
    () =>
      assertManagerRootWorktreeGroup("root", workspace, {
        source: { repo_key: "other" },
      }),
    /could not verify worktree-group topology/,
  );
  assert.throws(
    () =>
      assertManagerRootWorktreeGroup(
        "linked",
        {
          worktree: { repo_key: "repo", is_linked_worktree: true },
        },
        { source: { repo_key: "repo", source_workspace_id: "root" } },
      ),
    /requires root workspace linked to be the primary workspace/,
  );
});

test("Manager recovery uses and verifies the isolated primary checkout", () => {
  const checkout = "/repo/primary";
  const hostWorkspace = {
    worktree: {
      repo_key: "repo",
      is_linked_worktree: false,
      checkout_path: checkout,
    },
  };
  const hostTopology = {
    source: {
      repo_key: "repo",
      source_workspace_id: "host",
      source_checkout_path: checkout,
    },
  };
  assert.equal(
    managerPrimaryCheckout("host", hostWorkspace, hostTopology),
    checkout,
  );
  assert.throws(
    () =>
      managerPrimaryCheckout("host", hostWorkspace, {
        source: { ...hostTopology.source, source_workspace_id: "linked" },
      }),
    /requires root workspace host to be the primary workspace/,
  );
  assert.throws(
    () =>
      managerPrimaryCheckout("host", hostWorkspace, {
        source: { ...hostTopology.source, source_checkout_path: "/repo/other" },
      }),
    /checkout paths do not match/,
  );
  assert.throws(
    () =>
      managerPrimaryCheckout("host", hostWorkspace, {
        source: { repo_key: "repo", source_workspace_id: "host" },
      }),
    /source checkout path must be a non-empty absolute path/,
  );

  assert.deepEqual(managerWorktreeOpenArgs("isolated-root", checkout), [
    "worktree",
    "open",
    "--workspace",
    "isolated-root",
    "--path",
    checkout,
    "--no-focus",
  ]);
  assert.throws(() =>
    managerWorktreeOpenArgs("isolated-root", "relative/path"),
  );

  const workspace = {
    workspace_id: "isolated-root",
    worktree: {
      repo_key: "repo",
      is_linked_worktree: false,
      checkout_path: checkout,
    },
  };
  const topology = {
    source: {
      repo_key: "repo",
      source_workspace_id: "isolated-root",
      source_checkout_path: checkout,
    },
  };
  assertManagerOpenedPrimary("isolated-root", checkout, workspace, topology);
  assert.throws(() =>
    assertManagerOpenedPrimary("isolated-root", checkout, workspace, {
      source: { ...topology.source, repo_key: "other" },
    }),
  );
  assert.throws(() =>
    assertManagerOpenedPrimary("isolated-root", checkout, workspace, {
      source: { ...topology.source, source_workspace_id: "elsewhere" },
    }),
  );
  assert.throws(
    () =>
      assertManagerOpenedPrimary("isolated-root", checkout, workspace, {
        source: { repo_key: "repo", source_workspace_id: "isolated-root" },
      }),
    /source checkout path must be a non-empty absolute path/,
  );
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
  });
  assert.deepEqual(managerReadyAnswer(contents(entries.slice(0, 5)), lead), {
    receipt: true,
    answer: null,
  });
  assert.equal(
    managerReadyAnswer(contents(entries), lead).answer?.id,
    "answer",
  );
  assert.equal(
    managerReadyAnswer(contents(entries), "wrong-lead").answer,
    null,
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
