import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantResultForSession,
  chiefTreeFooter,
  chiefTreeSelectedRow,
  candidateArgs,
  chiefTreeProbeSource,
  distinctPaneCount,
  parseToolSnapshots,
  chiefTreeBranchPlan,
  continuationResultsForPrompt,
  initialPromptForScenario,
  inspectPaneProcesses,
  isolatedEnv,
  listedPanes,
  nestedControlEnv,
  nestedPaneInput,
  nestedPaneText,
  submitPaneCommand,
  parseScenario,
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

test("smoke scenario parsing accepts the three supported scenarios and defaults to core", async () => {
  assert.equal(parseScenario([]), "core");
  for (const scenario of ["core", "continuation", "chief-tree"])
    assert.equal(parseScenario([scenario]), scenario);
  assert.throws(() => parseScenario(["wat"]), /unknown smoke scenario/);
  await assert.rejects(runScenario({}, "wat"), /unknown smoke scenario/);
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

test("Chief tree probe is opt-in, last in root extension order, and validates three tool snapshots", () => {
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
