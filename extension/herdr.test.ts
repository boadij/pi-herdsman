import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  HerdrStartFailure,
  herdrAgentAlias,
  listHerdrAgents,
  listAllHerdrAgents,
  leadMetadataArgs,
  reportLeadMetadata,
  inspectHerdrAgent,
  paneIsAvailable,
  runHerdr,
  sameShellProcessOwner,
  sameRunningProcessOwner,
  sameCwd,
  stopHerdrAgentPreservingPane,
  closeHerdrPane,
  rollbackHerdrStart,
  startHerdrAgent,
  matchesExpectedSession,
  sameObservedSessionPath,
  sessionIdentity,
  STARTUP_TIMEOUT_MAX,
  STARTUP_TIMEOUT_MIN,
  startupTimeoutBudget,
  structuredTopologyEnvironment,
  type HerdrStartPlacement,
} from "./herdr.ts";
import { claimProcessLock } from "./lock.ts";
import { herdsmanTempRoot } from "./storage.ts";

test("nested topology keeps the Herdr workspace authoritative", () => {
  assert.deepEqual(
    structuredTopologyEnvironment("live-workspace", [
      "PI_HERDSMAN_WORKSPACE_ID=stale-workspace",
      "HERDR_SOCKET_PATH=stale-socket",
      "HERDR_ENV=stale-env",
      "HERDR_WORKSPACE_ID=stale-herdr-workspace",
      "HERDR_TAB_ID=stale-tab",
      "HERDR_PANE_ID=stale-pane",
      "PI_HERDSMAN_LABEL=task20_nested",
    ]),
    [
      "PI_HERDSMAN_LABEL=task20_nested",
      "PI_HERDSMAN_WORKSPACE_ID=live-workspace",
    ],
  );

  const env = structuredTopologyEnvironment("workspace", [
    "PI_HERDSMAN_OWNER_SESSION_ID=implementer-session",
    "PI_SUBAGENT_CHILD=stale",
    "PI_SUBAGENT_PARENT_SESSION=lead-session",
    "PI_SUBAGENT_PARENT_SESSION=stale-parent",
    "EXTRA=value",
  ]);
  assert.ok(env.includes("PI_SUBAGENT_CHILD=1"));
  assert.ok(env.includes("PI_SUBAGENT_PARENT_SESSION=lead-session"));
  assert.ok(!env.includes("PI_SUBAGENT_CHILD=stale"));
  assert.ok(!env.includes("PI_SUBAGENT_PARENT_SESSION=stale-parent"));
  assert.ok(env.includes("EXTRA=value"));
  assert.ok(env.includes("PI_HERDSMAN_OWNER_SESSION_ID=implementer-session"));

  assert.deepEqual(
    structuredTopologyEnvironment("workspace", [
      "PI_HERDSMAN_OWNER_SESSION_ID=owner-session",
    ]),
    [
      "PI_HERDSMAN_OWNER_SESSION_ID=owner-session",
      "PI_SUBAGENT_CHILD=1",
      "PI_SUBAGENT_PARENT_SESSION=owner-session",
      "PI_HERDSMAN_WORKSPACE_ID=workspace",
    ],
  );
});

test("lists all Herdr agents without changing the current-workspace view", async () => {
  const pi = {
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({
        id: 1,
        result: {
          agents: [
            { pane_id: "one", workspace_id: "workspace-one" },
            { pane_id: "two", workspace_id: "workspace-two" },
          ],
        },
      }),
      stderr: "",
    }),
  } as any;
  const all = await listAllHerdrAgents(pi, { cwd: "/tmp" } as any);
  assert.equal(all.agents.length, 2);
  const environment = globalThis.process.env;
  const previous = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-two";
  try {
    assert.deepEqual(
      (await listHerdrAgents(pi, { cwd: "/tmp" } as any)).agents,
      [{ pane_id: "two", workspace_id: "workspace-two" }],
    );
  } finally {
    if (previous === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previous;
  }
});

test("agent list fails closed when the native agents array is absent", async () => {
  for (const result of [{}, { agents: null }, { agents: {} }]) {
    const pi = {
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({ id: 1, result }),
        stderr: "",
      }),
    } as any;
    await assert.rejects(
      listAllHerdrAgents(pi, { cwd: "/tmp" } as any),
      /agent list ownership proof is unavailable/,
    );
  }
});

test("lead metadata is display-only and carries current name and ask", () => {
  assert.deepEqual(
    leadMetadataArgs({
      paneId: "root-pane",
      name: " API root ",
      pendingAskId: "ask-1",
    }),
    [
      "pane",
      "report-metadata",
      "root-pane",
      "--source",
      "pi-herdsman:lead",
      "--title",
      "API root",
      "--token",
      "pi_herdsman_role=lead",
      "--token",
      "pi_herdsman_ask=ask-1",
      "--token",
      "pi_herdsman_name=API root",
    ],
  );
  assert.deepEqual(leadMetadataArgs({ paneId: "root-pane" }).slice(-4), [
    "--clear-token",
    "pi_herdsman_ask",
    "--clear-token",
    "pi_herdsman_name",
  ]);
});

test("lead metadata accepts successful empty Herdr output", async () => {
  let call: { args: string[]; options: Record<string, unknown> } | undefined;
  const pi = {
    exec: async (
      _command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      call = { args, options };
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;

  await reportLeadMetadata(pi, { cwd: "/tmp" } as any, {
    paneId: "root-pane",
  });

  assert.deepEqual(call?.args, leadMetadataArgs({ paneId: "root-pane" }));
  assert.equal(call?.options.timeout, 10_000);
});

test("inspection reads raw bounded text and tolerates unavailable process evidence", async () => {
  const text = "x".repeat(9_000);
  const calls: string[][] = [];
  let gets = 0;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              agent: {
                workspace_id: "workspace",
                pane_id: "pane",
                tab_id: gets++ === 0 ? "tab-a" : "tab-b",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "session",
                },
              },
            },
          }),
          stderr: "",
        };
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stdout: text, stderr: "" };
      if (args[0] === "pane" && args[1] === "process-info")
        return { code: 1, stdout: "", stderr: "unavailable" };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  } as any;
  const snapshot = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
    workspaceId: "workspace",
    paneId: "pane",
    piSessionId: "session",
  });
  assert.equal(snapshot.recentOutput?.length, 9_000);
  assert.equal(snapshot.recentOutput?.at(-1), "x");
  assert.equal(snapshot.recentOutputTruncated, false);
  assert.equal(snapshot.process, undefined);
  assert.equal(snapshot.identity.agent.tab_id, "tab-b");
  assert.deepEqual(calls[1], [
    "agent",
    "read",
    "pane",
    "--source",
    "recent-unwrapped",
    "--lines",
    "80",
    "--format",
    "text",
  ]);
  assert.equal(calls[1].filter((arg) => arg === "--lines").length, 1);
  assert.equal(calls[1].includes("--raw"), false);
  assert.equal(
    calls.filter((args) => args[0] === "agent" && args[1] === "get").length,
    2,
  );
});

test("inspection keeps partial process evidence when pane identity is absent or different", async () => {
  const processInfo = {
    pane_id: "different-pane",
    shell_pid: 12,
    foreground_processes: Array.from({ length: 20 }, (_, pid) => ({
      pid: pid + 1,
      argv0: `${"a".repeat(300)}-${pid}`,
      cmdline: "b".repeat(5_000),
      arbitrary: "must not escape",
    })),
  };
  const pi = {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              agent: {
                workspace_id: "workspace",
                pane_id: "pane",
                tab_id: "tab",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "session",
                },
              },
            },
          }),
          stderr: "",
        };
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stdout: "recent output", stderr: "" };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: { process_info: processInfo },
          }),
          stderr: "",
        };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  } as any;

  const snapshot = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
    workspaceId: "workspace",
    paneId: "pane",
    piSessionId: "session",
  });
  assert.equal(snapshot.recentOutput, "recent output");
  assert.equal(snapshot.recentOutputTruncated, false);
  assert.equal(snapshot.process?.pane_id, undefined);
  assert.equal(
    "foreground_process_group_id" in (snapshot.process ?? {}),
    false,
  );
  assert.equal(snapshot.process?.foreground_processes?.length, 8);
  assert.equal(snapshot.process?.foreground_processes?.[0]?.pid, 1);
  assert.ok(
    Buffer.byteLength(
      snapshot.process?.foreground_processes?.[0]?.argv0 ?? "",
    ) <= 256,
  );
  assert.ok(
    Buffer.byteLength(
      snapshot.process?.foreground_processes?.[0]?.cmdline ?? "",
    ) <=
      4 * 1024,
  );
  assert.equal(
    "arbitrary" in (snapshot.process?.foreground_processes?.[0] ?? {}),
    false,
  );
});

test("inspection omits malformed process entries without exposing extra fields", async () => {
  const pi = {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              agent: {
                workspace_id: "workspace",
                pane_id: "pane",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "session",
                },
              },
            },
          }),
          stderr: "",
        };
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stdout: "recent output", stderr: "" };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              process_info: {
                pane_id: "pane",
                shell_pid: 12,
                foreground_process_group_id: 12,
                foreground_processes: [
                  { pid: "bad", argv0: 42, cmdline: null },
                  { pid: 13, argv0: "/bin/zsh", extra: { secret: true } },
                ],
                extra: "must not escape",
              },
            },
          }),
          stderr: "",
        };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  } as any;
  const snapshot = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
    workspaceId: "workspace",
    paneId: "pane",
    piSessionId: "session",
  });
  assert.deepEqual(snapshot.process, {
    pane_id: "pane",
    shell_pid: 12,
    foreground_process_group_id: 12,
    foreground_processes: [{}, { pid: 13, argv0: "/bin/zsh" }],
  });
  assert.equal(snapshot.recentOutputTruncated, false);
  assert.equal("extra" in (snapshot.process ?? {}), false);
});

test("inspection preserves bounded terminal output", async () => {
  const calls: string[][] = [];
  let output = "界".repeat(7_000);
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              agent: {
                workspace_id: "workspace",
                pane_id: "pane",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "session",
                },
              },
            },
          }),
          stderr: "",
        };
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stdout: output, stderr: "" };
      if (args[0] === "pane" && args[1] === "process-info")
        return { code: 1, stdout: "", stderr: "unavailable" };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  } as any;
  const snapshot = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
    workspaceId: "workspace",
    paneId: "pane",
    piSessionId: "session",
  });
  assert.ok(snapshot.recentOutput);
  assert.ok(Buffer.byteLength(snapshot.recentOutput) <= 16 * 1024);
  assert.equal(snapshot.recentOutputTruncated, true);
  assert.equal(snapshot.recentOutput?.includes("\uFFFD"), false);
  assert.deepEqual(calls[1]?.slice(-4), ["--lines", "80", "--format", "text"]);
  output = "x".repeat(16 * 1024);
  const exact = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
    workspaceId: "workspace",
    paneId: "pane",
    piSessionId: "session",
  });
  assert.equal(Buffer.byteLength(exact.recentOutput ?? ""), 16 * 1024);
  assert.equal(exact.recentOutputTruncated, false);
  await (async () => {
    const pi = {
      exec: async (_command: string, args: string[]) => {
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stdout: JSON.stringify({
              id: 1,
              result: {
                agent: {
                  workspace_id: "workspace",
                  pane_id: "pane",
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: "session",
                  },
                },
              },
            }),
            stderr: "",
          };
        if (args[0] === "agent" && args[1] === "read")
          return {
            code: 0,
            stdout: Array.from({ length: 100 }, (_, i) => `line-${i}`).join(
              "\n",
            ),
            stderr: "",
          };
        if (args[0] === "pane" && args[1] === "process-info")
          return { code: 1, stdout: "", stderr: "unavailable" };
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    } as any;
    const snapshot = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
      workspaceId: "workspace",
      paneId: "pane",
      piSessionId: "session",
    });
    const lines = snapshot.recentOutput?.split("\n") ?? [];
    assert.equal(lines.length, 80);
    assert.equal(lines[0], "line-20");
    assert.equal(lines.at(-1), "line-99");
    assert.equal(snapshot.recentOutputTruncated, false);
    assert.ok(Buffer.byteLength(snapshot.recentOutput ?? "") <= 16 * 1024);
  })();
});

test("inspection fails closed when the caller's exact ownership generation changes", async () => {
  let gets = 0;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "agent" && args[1] === "get") {
        gets++;
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              agent: {
                workspace_id: "workspace",
                pane_id: "pane",
                tab_id: "tab",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "session",
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stdout: "evidence", stderr: "" };
      if (args[0] === "pane" && args[1] === "process-info")
        return { code: 1, stdout: "", stderr: "unavailable" };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  } as any;
  await assert.rejects(
    inspectHerdrAgent(
      pi,
      { cwd: "/tmp" } as any,
      {
        workspaceId: "workspace",
        paneId: "pane",
        piSessionId: "session",
      },
      undefined,
      () => gets < 2,
    ),
    /changed during capture/,
  );
  assert.equal(gets, 2);
});

const NON_PI_AGENT = "legacy-root";

test("startup timeout budget reserves the full bounded diagnostic window", () => {
  const minimum = startupTimeoutBudget(STARTUP_TIMEOUT_MIN);
  assert.deepEqual(minimum, {
    totalTimeout: 5001,
    childTimeout: 3001,
    diagnosticTimeout: 2000,
  });
  const explicit = startupTimeoutBudget(30_000);
  assert.deepEqual(explicit, {
    totalTimeout: 30_000,
    childTimeout: 28_000,
    diagnosticTimeout: 2000,
  });
  const maximum = startupTimeoutBudget(STARTUP_TIMEOUT_MAX);
  assert.deepEqual(maximum, {
    totalTimeout: 300_000,
    childTimeout: 298_000,
    diagnosticTimeout: 2000,
  });
  const defaultBudget = startupTimeoutBudget();
  assert.equal(defaultBudget.totalTimeout, 302_000);
  assert.deepEqual(defaultBudget, {
    totalTimeout: 302_000,
    childTimeout: 300_000,
    diagnosticTimeout: 2000,
  });
  for (const budget of [minimum, explicit, defaultBudget]) {
    const remainingAfterChild = budget.totalTimeout - budget.childTimeout;
    assert.ok(remainingAfterChild > 0);
    assert.ok(remainingAfterChild <= budget.diagnosticTimeout);
  }
  assert.throws(() => startupTimeoutBudget(5000), /5001 through 300000/);
  assert.throws(
    () => startupTimeoutBudget(STARTUP_TIMEOUT_MAX + 1),
    /5001 through 300000/,
  );
});

test("runHerdr enforces stdout success envelopes and preserves diagnostics", async () => {
  const ctx = { cwd: "/tmp" } as any;
  assert.equal(
    await runHerdr(
      { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as any,
      ctx,
      ["pane", "run"],
      { noResult: true },
    ),
    undefined,
  );
  assert.deepEqual(
    await runHerdr(
      {
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ id: 1, result: { source: "stdout" } }),
          stderr: JSON.stringify({ result: { source: "stderr" } }),
        }),
      } as any,
      ctx,
      ["agent", "list"],
    ),
    { source: "stdout" },
  );
  assert.equal(
    await runHerdr(
      {
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ id: "null-1", result: null }),
          stderr: JSON.stringify({ result: { source: "stderr" } }),
        }),
      } as any,
      ctx,
      ["agent", "list"],
    ),
    null,
  );
  assert.deepEqual(
    await runHerdr(
      {
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({
            id: "status-1",
            result: { source: "stdout" },
          }),
          stderr: JSON.stringify({ result: { source: "stderr" } }),
        }),
      } as any,
      ctx,
      ["agent", "list"],
    ),
    { source: "stdout" },
  );
  assert.deepEqual(
    await runHerdr(
      {
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ client: { version: "0.9.0" } }),
          stderr: "",
        }),
      } as any,
      ctx,
      ["status", "--json"],
    ),
    { client: { version: "0.9.0" } },
  );
  for (const [args, stdout] of [
    [["agent", "list"], { agents: [] }],
    [["agent", "get", "pane-1"], { agent: {} }],
    [["pane", "process-info"], { process_info: {} }],
  ] as const) {
    await assert.rejects(
      runHerdr(
        {
          exec: async () => ({
            code: 0,
            stdout: JSON.stringify(stdout),
            stderr: "",
          }),
        } as any,
        ctx,
        args,
      ),
      /without a result envelope/,
    );
  }
  for (const stdout of ["malformed", ""]) {
    await assert.rejects(
      runHerdr(
        {
          exec: async () => ({
            code: 0,
            stdout,
            stderr: JSON.stringify({ result: { source: "stderr" } }),
          }),
        } as any,
        ctx,
        ["agent", "list"],
      ),
      /malformed JSON/,
    );
  }
  for (const [result, expected] of [
    [
      {
        code: 1,
        stdout: JSON.stringify({ error: { message: "stdout structured" } }),
        stderr: JSON.stringify({ error: { message: "stderr structured" } }),
      },
      "stdout structured",
    ],
    [
      {
        code: 1,
        stdout: "not json",
        stderr: JSON.stringify({ error: { message: "stderr structured" } }),
      },
      "stderr structured",
    ],
    [
      { code: 1, stdout: "plain stdout", stderr: "plain stderr" },
      "plain stderr",
    ],
    [{ code: 1, stdout: "plain stdout", stderr: "" }, "plain stdout"],
    [{ code: 1, stdout: "", stderr: "" }, "exit 1"],
  ] as const) {
    const pi = { exec: async () => result } as any;
    await assert.rejects(
      runHerdr(pi, ctx, ["agent", "start"]),
      new RegExp(expected),
    );
  }
  for (const [result, expected, classification] of [
    [{ code: 0, stdout: "", stderr: "" }, /empty output/, "empty"],
    [
      { code: 0, stdout: "garbage", stderr: "" },
      /malformed JSON: garbage/,
      "malformed",
    ],
  ] as const) {
    const pi = { exec: async () => result } as any;
    await assert.rejects(
      runHerdr(pi, ctx, ["agent", "start"]),
      (failure: any) => {
        assert.match(failure.message, expected);
        assert.notEqual(failure.message.at(-1), ":");
        assert.equal(
          failure.detail.details.result.classification,
          classification,
        );
        return true;
      },
    );
  }
});

test("runHerdr rejects a successful result-only envelope", async () => {
  await assert.rejects(
    runHerdr(
      {
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({ result: { agents: [] } }),
          stderr: "",
        }),
      } as any,
      { cwd: "/tmp" } as any,
      ["agent", "list"],
    ),
    /without a result envelope/,
  );
});

test("lists agents with the supported Herdr command", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-list-test";
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({
          id: 1,
          result: {
            agents: [
              { name: "same", workspace_id: "workspace-list-test" },
              { name: "foreign", workspace_id: "other-workspace" },
              { name: "missing" },
            ],
          },
        }),
        stderr: "",
      };
    },
  } as any;

  const originalDateNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    assert.deepEqual(await listHerdrAgents(pi, { cwd: "/tmp" } as any), {
      workspaceId: "workspace-list-test",
      agents: [{ name: "same", workspace_id: "workspace-list-test" }],
    });
    assert.deepEqual(calls, [["agent", "list"]]);
  } finally {
    Date.now = originalDateNow;
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
});

test("serializes lifecycle mutations across managed and concrete tab identities", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-lock-test";
  const startAbort = new AbortController();
  const closeAbort = new AbortController();
  const calls: string[][] = [];
  let releaseTabList!: (value: unknown) => void;
  const tabList = new Promise((resolve) => {
    releaseTabList = resolve;
  });
  let firstTabList = true;
  const pi = {
    exec: async (_command: string, args: string[], options: any) => {
      calls.push(args);
      if (args[0] === "tab" && args[1] === "list" && firstTabList) {
        firstTabList = false;
        return tabList;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stdout: JSON.stringify({ id: 1, result: { agent: {} } }),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;

  try {
    const starting = startHerdrAgent(pi, { cwd: "/tmp" } as any, {
      label: "agent",
      runId: "run-id",
      cwd: "/tmp",
      placement: { kind: "tab", label: "agents", tabId: "concrete-tab" },
      signal: startAbort.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closing = closeHerdrPane(
      pi,
      { cwd: "/tmp" } as any,
      "agent-run",
      { tabId: "concrete-tab", workspaceId: "workspace-lock-test" },
      closeAbort.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      calls.some((args) => args[0] === "agent" && args[1] === "get"),
      false,
    );

    startAbort.abort(new Error("release start"));
    releaseTabList({
      code: 0,
      stdout: JSON.stringify({ id: 1, result: { tabs: [] } }),
      stderr: "",
    });
    await assert.rejects(starting);
    await assert.rejects(closing, /ownership is unproven/);
    assert.equal(
      calls.some((args) => args[0] === "agent" && args[1] === "get"),
      true,
    );
    assert.equal(
      calls.some(
        (args) =>
          (args[0] === "agent" && args[1] === "send-keys") ||
          (args[0] === "pane" && args[1] === "close"),
      ),
      false,
    );
  } finally {
    startAbort.abort();
    closeAbort.abort();
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
});

test("start injects mandatory extensions before definition args and configures the environment", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "root-workspace";
  const cwd = mkdtempSync(join(tmpdir(), "pi-herdsman-agent-space-"));
  const mailbox = join(cwd, "mailbox with $dollar 'quote' `backtick`");
  const processInfo = {
    pane_id: "pane-1",
    shell_pid: 12,
    foreground_process_group_id: 12,
    foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
  };
  const contract = [
    `PI_HERDSMAN_MAILBOX=${mailbox}`,
    "PI_HERDSMAN_RUN_ID=run-id",
    "PI_HERDSMAN_OWNER_SESSION_ID=owner-session",
    "PI_SUBAGENT_PARENT_SESSION=lead-session",
    "PI_HERDSMAN_LABEL=agent",
    "PI_HERDSMAN_WORKSPACE_ID=agent-workspace",
    "PI_HERDSMAN_AGENT_DEFINITION=agent",
    "PI_OFFLINE=1",
  ];
  const calls: string[][] = [];
  const execTimeouts: Array<number | undefined> = [];
  const originalDateNow = Date.now;
  Date.now = () => 1_000_000;
  const pi = {
    exec: async (_command: string, args: string[], options: any) => {
      calls.push(args);
      execTimeouts.push(options?.timeout);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: { tabs: [] },
          }),
          stderr: "",
        };
      if (key === "pane list")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              panes: [
                {
                  pane_id: "pane-1",
                  workspace_id: "root-workspace",
                  tab_id: "tab-1",
                  agent_status: "unknown",
                  foreground_cwd: cwd,
                },
              ],
            },
          }),
          stderr: "",
        };
      if (key === "pane process-info")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: { process_info: processInfo },
          }),
          stderr: "",
        };
      if (key === "pane wait-output")
        return {
          code: 0,
          stdout: JSON.stringify({ id: 1, result: {} }),
          stderr: "",
        };
      if (key === "tab create")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              tab: { tab_id: "tab-1", label: "agents" },
              root_pane: { pane_id: "pane-1" },
            },
          }),
          stderr: "",
        };
      if (key === "agent start")
        return {
          code: 0,
          stdout: JSON.stringify({
            id: 1,
            result: {
              agent: {
                name: "agent-run",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "session-id",
                },
              },
            },
          }),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;

  try {
    await startHerdrAgent(pi, { cwd } as any, {
      label: "agent",
      runId: "run-id",
      cwd,
      placement: { kind: "tab", label: "agents", tabId: "tab-1" },
      extensionPath: join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
      env: contract,
      agentArgs: ["--name", "value with spaces", "Unicode-路径", "--approve"],
    });
  } finally {
    Date.now = originalDateNow;
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }

  const start = calls.findIndex(
    (args) => args[0] === "agent" && args[1] === "start",
  );
  const startArgs = calls[start]!;
  const tabCreate = calls.find(
    (args) => args[0] === "tab" && args[1] === "create",
  )!;
  assert.equal(tabCreate[tabCreate.indexOf("--cwd") + 1], realpathSync(cwd));
  assert.equal(tabCreate[tabCreate.indexOf("--label") + 1], "agents");
  assert.deepEqual(
    tabCreate
      .flatMap((arg, index) => (arg === "--env" ? [tabCreate[index + 1]!] : []))
      .filter((arg) =>
        /^(PI_HERDSMAN_(MAILBOX|RUN_ID|OWNER_SESSION_ID|LABEL|WORKSPACE_ID|AGENT_DEFINITION)|PI_SUBAGENT_PARENT_SESSION|PI_OFFLINE)=/.test(
          arg,
        ),
      ),
    [
      ...contract.filter(
        (arg) =>
          !arg.startsWith("PI_HERDSMAN_WORKSPACE_ID=") &&
          !arg.startsWith("PI_SUBAGENT_PARENT_SESSION="),
      ),
      "PI_SUBAGENT_PARENT_SESSION=lead-session",
      "PI_HERDSMAN_WORKSPACE_ID=root-workspace",
    ],
  );
  assert.deepEqual(startArgs.slice(startArgs.indexOf("--") + 1), [
    "--extension",
    join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
    "--extension",
    join(getAgentDir(), "extensions", "herdr-agent-state.ts"),
    "--name",
    "value with spaces",
    "Unicode-路径",
    "--approve",
  ]);
  assert.equal(startArgs[startArgs.indexOf("--timeout") + 1], "300000");
  assert.equal(execTimeouts[start], 300_000);
  assert.equal(
    calls.some(
      (args) =>
        args[0] === "pane" &&
        args[1] === "run" &&
        String(args[3]).startsWith("export "),
    ),
    false,
  );
  const markerRun = calls.find(
    (args) => args[0] === "pane" && args[1] === "run",
  )!;
  assert.match(markerRun[3]!, /^echo __PI_HERDSMAN_READY_[0-9a-f-]{36}__$/);
  const markerWait = calls.find(
    (args) => args[0] === "pane" && args[1] === "wait-output",
  )!;
  assert.match(
    markerWait[markerWait.indexOf("--regex") + 1]!,
    /^\^__PI_HERDSMAN_READY_[0-9a-f-]{36}__\$$/,
  );
  const marker = markerRun[3]!.match(
    /(__PI_HERDSMAN_READY_[0-9a-f-]{36}__)$/,
  )![1];
  assert.equal(markerWait[markerWait.indexOf("--regex") + 1], `^${marker}$`);
  assert.ok(
    execTimeouts.every((timeout) => timeout !== undefined && timeout > 0),
  );
});

async function executeFailedStart(
  startResult: { code: number; stdout: string; stderr: string },
  paneReadResult?:
    { code: number; killed?: boolean; stdout: string; stderr: string } | Error,
  timeoutMs?: number,
  signal?: AbortSignal,
  onPaneRead?: () => void,
  expireBeforeCapture = false,
  advanceAfterStartMs?: number,
  placement: HerdrStartPlacement = { kind: "tab", label: "agents" },
  placementRevalidator?: (
    placement: HerdrStartPlacement,
  ) => Promise<HerdrStartPlacement>,
): Promise<{
  failure: any;
  calls: Array<{ args: string[]; timeout?: number }>;
}> {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  const originalDateNow = Date.now;
  environment.HERDR_WORKSPACE_ID = "root-workspace";
  const cwd = "/tmp/pi-herdsman-agent";
  const calls: Array<{ args: string[]; timeout?: number }> = [];
  const response = (value: unknown) => ({
    code: 0,
    killed: false,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const processInfo = {
    pane_id: "pane-1",
    shell_pid: 12,
    foreground_process_group_id: 12,
    foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
  };
  const pi = {
    exec: async (_command: string, args: string[], options: any) => {
      calls.push({ args, timeout: options.timeout });
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return response({ tabs: [] });
      if (key === "tab create")
        return response({
          tab: { tab_id: "tab-1", label: "agents" },
          root_pane: { pane_id: "pane-1" },
        });
      if (key === "pane list")
        return response({
          panes: [
            {
              pane_id: "pane-1",
              workspace_id: "root-workspace",
              tab_id: "tab-1",
              agent_status: "unknown",
              foreground_cwd: cwd,
            },
          ],
        });
      if (key === "pane process-info")
        return response({ process_info: processInfo });
      if (key === "pane wait-output") return response({});
      if (key === "agent start") {
        if (expireBeforeCapture) Date.now = () => Number.MAX_SAFE_INTEGER;
        else if (advanceAfterStartMs !== undefined) {
          const startNow = Date.now();
          Date.now = () => startNow + advanceAfterStartMs;
        }
        return startResult;
      }
      if (key === "pane read") {
        onPaneRead?.();
        if (paneReadResult instanceof Error) throw paneReadResult;
        return (
          paneReadResult ?? { code: 0, killed: false, stdout: "", stderr: "" }
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;

  let failure: any;
  try {
    try {
      await startHerdrAgent(pi, { cwd } as any, {
        label: "agent",
        runId: "run-id",
        cwd,
        placement,
        ...(placementRevalidator ? { placementRevalidator } : {}),
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (errorValue) {
      failure = errorValue;
    }
  } finally {
    Date.now = originalDateNow;
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.ok(failure instanceof HerdrStartFailure);
  return { failure, calls };
}

test("exact reusable tab disappearance creates a fresh labeled tab", async () => {
  const { calls } = await executeFailedStart(
    { code: 1, stdout: "", stderr: "start failed" },
    undefined,
    30_000,
    undefined,
    undefined,
    false,
    undefined,
    { kind: "tab", label: "agents · auth", tabId: "exact-tab" },
  );
  const created = calls.find(
    ({ args }) => args[0] === "tab" && args[1] === "create",
  )?.args;
  assert.equal(created?.[created.indexOf("--label") + 1], "agents · auth");
  assert.equal(
    calls.some(({ args }) => args[0] === "pane" && args[1] === "split"),
    false,
  );
});

test("revalidated placement runs under the lifecycle lock and falls back fresh", async () => {
  let revalidated = false;
  let lifecycleLockObserved = false;
  let lifecycleLockError = "";
  const lockPath = join(
    herdsmanTempRoot(),
    "locks",
    createHash("sha256").update("root-workspace").digest("hex"),
  );
  const { calls } = await executeFailedStart(
    { code: 1, stdout: "", stderr: "start failed" },
    undefined,
    30_000,
    undefined,
    undefined,
    false,
    undefined,
    { kind: "tab", label: "agents · auth", tabId: "candidate-tab" },
    async (placement) => {
      revalidated = true;
      try {
        const release = claimProcessLock(lockPath, {
          name: "Herdr lifecycle",
        });
        release();
      } catch (error) {
        lifecycleLockError = String(error);
        lifecycleLockObserved = /Herdr lifecycle is in progress/.test(
          String(error),
        );
      }
      assert.equal(placement.kind, "tab");
      assert.equal(placement.tabId, "candidate-tab");
      return { kind: "tab", label: placement.label };
    },
  );
  assert.equal(revalidated, true);
  assert.equal(lifecycleLockObserved, true, lifecycleLockError);
  assert.equal(
    calls.some(
      ({ args }) =>
        args[0] === "tab" &&
        args[1] === "create" &&
        args[args.indexOf("--label") + 1] === "agents · auth",
    ),
    true,
  );
});

test("empty agent start captures one bounded exact-pane diagnostic", async () => {
  const originalDateNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      {
        code: 0,
        killed: false,
        stdout: `${"x".repeat(9000)}\nUnknown extension: broken.ts`,
        stderr: "",
      },
      30_000,
      undefined,
      undefined,
      false,
      20_000,
    );
    assert.equal(failure.stage, "agent_start");
    assert.equal(failure.attempt.paneId, "pane-1");
    assert.match(failure.cause.message, /Unknown extension: broken\.ts/);
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    assert.ok(failure.cause.detail.details.paneSnapshot.length <= 8192);
    assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
    assert.equal(failure.cause.detail.details.paneSnapshotStatus, "captured");
    assert.equal(failure.cause.detail.details.paneSnapshotReason, undefined);
    const reads = calls.filter(
      ({ args }) => args[0] === "pane" && args[1] === "read",
    );
    assert.deepEqual(reads[0]?.args, [
      "pane",
      "read",
      "pane-1",
      "--source",
      "recent-unwrapped",
      "--lines",
      "40",
      "--format",
      "text",
      "--raw",
    ]);
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.timeout, 2000);
    const start = calls.find(
      ({ args }) => args[0] === "agent" && args[1] === "start",
    )!;
    assert.equal(
      Number(start.args[start.args.indexOf("--timeout") + 1]),
      28_000,
    );
    assert.equal(start.timeout, 28_000);
  } finally {
    Date.now = originalDateNow;
  }
});

test("minimum startup budget keeps the child timeout Herdr-supported", async () => {
  const originalDateNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      {
        code: 0,
        killed: false,
        stdout: "Unknown extension: minimum.ts",
        stderr: "",
      },
      6_000,
    );
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    const start = calls.find(
      ({ args }) => args[0] === "agent" && args[1] === "start",
    )!;
    assert.equal(
      Number(start.args[start.args.indexOf("--timeout") + 1]),
      4_000,
    );
    assert.equal(start.timeout, 4_000);
    const reads = calls.filter(
      ({ args }) => args[0] === "pane" && args[1] === "read",
    );
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.timeout, 2000);
  } finally {
    Date.now = originalDateNow;
  }
});

test("structured agent start failure never reads the pane", async () => {
  const { failure, calls } = await executeFailedStart({
    code: 1,
    stdout: JSON.stringify({ error: { message: "actionable start error" } }),
    stderr: "",
  });
  assert.match(failure.cause.message, /actionable start error/);
  assert.equal(
    calls.some(({ args }) => args[0] === "pane" && args[1] === "read"),
    false,
  );
  assert.equal(failure.cause.detail.details?.paneSnapshotAttempted, undefined);
});

test("failed pane snapshots preserve start classification and diagnostic outcomes", async () => {
  const { failure, calls } = await executeFailedStart(
    { code: 0, stdout: "bad", stderr: "" },
    { code: 1, killed: false, stdout: "", stderr: "snapshot failed" },
  );
  assert.equal(failure.cause.detail.details.result.classification, "malformed");
  assert.equal(failure.cause.detail.details.paneSnapshot, undefined);
  assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
  assert.equal(failure.cause.detail.details.paneSnapshotStatus, "unavailable");
  assert.equal(failure.cause.detail.details.paneSnapshotReason, "nonzero");
  assert.equal(
    calls.filter(({ args }) => args[0] === "pane" && args[1] === "read").length,
    1,
  );
  await (async () => {
    const { failure, calls } = await executeFailedStart({
      code: 0,
      stdout: "",
      stderr: "",
    });
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
    assert.equal(failure.cause.detail.details.paneSnapshotStatus, "empty");
    assert.equal(failure.cause.detail.details.paneSnapshot, undefined);
    assert.equal(failure.cause.detail.details.paneSnapshotReason, undefined);
    assert.equal(
      calls.filter(({ args }) => args[0] === "pane" && args[1] === "read")
        .length,
      1,
    );
  })();
  await (async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      abort,
    );
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
    assert.equal(
      failure.cause.detail.details.paneSnapshotStatus,
      "unavailable",
    );
    assert.equal(failure.cause.detail.details.paneSnapshotReason, "aborted");
    assert.equal(
      calls.filter(({ args }) => args[0] === "pane" && args[1] === "read")
        .length,
      1,
    );
  })();
  await (async () => {
    const controller = new AbortController();
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      {
        code: 0,
        killed: true,
        stdout: "partial Failed to load extension diagnostic",
        stderr: "",
      },
      undefined,
      controller.signal,
      () => controller.abort(),
    );
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
    assert.equal(
      failure.cause.detail.details.paneSnapshotStatus,
      "unavailable",
    );
    assert.equal(failure.cause.detail.details.paneSnapshotReason, "aborted");
    assert.equal(failure.cause.detail.details.paneSnapshot, undefined);
    assert.doesNotMatch(failure.cause.message, /partial Failed/);
    assert.equal(
      calls.filter(({ args }) => args[0] === "pane" && args[1] === "read")
        .length,
      1,
    );
  })();
  await (async () => {
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      {
        code: 0,
        killed: true,
        stdout: "partial timeout diagnostic",
        stderr: "",
      },
    );
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
    assert.equal(
      failure.cause.detail.details.paneSnapshotStatus,
      "unavailable",
    );
    assert.equal(
      failure.cause.detail.details.paneSnapshotReason,
      "exception_or_timeout",
    );
    assert.equal(failure.cause.detail.details.paneSnapshot, undefined);
    assert.doesNotMatch(failure.cause.message, /partial timeout/);
    assert.equal(
      calls.filter(({ args }) => args[0] === "pane" && args[1] === "read")
        .length,
      1,
    );
  })();
  await (async () => {
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      new Error("pane read timed out"),
    );
    assert.equal(failure.cause.detail.details.result.classification, "empty");
    assert.equal(failure.cause.detail.details.paneSnapshotAttempted, true);
    assert.equal(
      failure.cause.detail.details.paneSnapshotStatus,
      "unavailable",
    );
    assert.equal(
      failure.cause.detail.details.paneSnapshotReason,
      "exception_or_timeout",
    );
    assert.equal(
      calls.filter(({ args }) => args[0] === "pane" && args[1] === "read")
        .length,
      1,
    );
  })();
});

test("deadline exhaustion before pane snapshot is observable without a read", async () => {
  const originalDateNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { failure, calls } = await executeFailedStart(
      { code: 0, stdout: "", stderr: "" },
      undefined,
      5_001,
      undefined,
      undefined,
      false,
      5_001,
    );
    assert.equal(failure.stage, "agent_start");
    const details = failure.cause.detail.details;
    assert.equal(details.result.classification, "empty");
    assert.equal(details.paneSnapshotAttempted, false);
    assert.equal(details.paneSnapshotStatus, "unavailable");
    assert.equal(details.paneSnapshotReason, "deadline");
    assert.equal(
      calls.filter(({ args }) => args[0] === "agent" && args[1] === "start")
        .length,
      1,
    );
    assert.equal(
      calls.filter(({ args }) => args[0] === "pane" && args[1] === "read")
        .length,
      0,
    );
  } finally {
    Date.now = originalDateNow;
  }
});

test("invalid environment assignments are rejected before topology mutation", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "root-workspace";
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      throw new Error("topology mutation should not run");
    },
  } as any;

  try {
    for (const env of [
      "PI_HERDSMAN_BAD-KEY=value",
      "PI_HERDSMAN_MAILBOX=line\r\nbreak",
      "PI_HERDSMAN_MAILBOX=has\0nul",
    ]) {
      await assert.rejects(
        startHerdrAgent(pi, { cwd: "/tmp" } as any, {
          label: "agent",
          runId: "run-id",
          cwd: "/tmp",
          placement: { kind: "tab", label: "agents" },
          env: [env],
        }),
        /invalid environment/,
      );
    }
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.deepEqual(calls, []);
});

test("readiness failure keeps one pane attempt and never starts a replacement agent", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "root-workspace";
  const cwd = "/tmp/pi-herdsman-agent";
  const calls: string[][] = [];
  let paneSplit = false;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list")
        return response({ tabs: [{ tab_id: "tab-1", label: "agents" }] });
      if (key === "pane list") {
        return response({
          panes: [
            {
              pane_id: paneSplit ? "pane-2" : "pane-1",
              workspace_id: "root-workspace",
              tab_id: "tab-1",
              agent_status: "working",
              agent: "busy",
              foreground_cwd: cwd,
            },
          ],
        });
      }
      if (key === "pane process-info")
        return response({
          process_info: {
            pane_id: "pane-2",
            shell_pid: 12,
            foreground_process_group_id: 12,
            foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
          },
        });
      if (key === "pane split") {
        paneSplit = true;
        return response({ pane: { pane_id: "pane-2" } });
      }
      if (key === "pane layout")
        return response({
          layout: {
            workspace_id: "root-workspace",
            tab_id: "tab-1",
            panes: [{ pane_id: "pane-1", rect: { width: 1, height: 1 } }],
          },
        });
      if (key === "pane wait-output") return response({});
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;

  try {
    await assert.rejects(
      startHerdrAgent(pi, { cwd } as any, {
        label: "agent",
        runId: "run-id",
        cwd,
        placement: { kind: "tab", label: "agents", tabId: "tab-1" },
        env: ["PI_HERDSMAN_MAILBOX=/tmp/mailbox"],
      }),
      /did not become an available shell/,
    );
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }

  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "split").length,
    1,
  );
  assert.equal(
    calls.some((args) => args[0] === "agent" && args[1] === "start"),
    false,
  );
  const splitCall = calls.find(
    (args) => args[0] === "pane" && args[1] === "split",
  )!;
  assert.equal(splitCall.includes("--env"), true);
  assert.equal(splitCall.includes("PI_HERDSMAN_MAILBOX=/tmp/mailbox"), true);
  assert.equal(splitCall.includes("HERDR_ENV=1"), false);
  assert.equal(splitCall.includes("HERDR_WORKSPACE_ID=root-workspace"), false);
  assert.equal(
    splitCall.includes("PI_HERDSMAN_WORKSPACE_ID=root-workspace"),
    true,
  );
});

test("fresh panes wait for shell and pane metadata before agent start", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  const workspaceId = "workspace-fresh";
  const tabId = "tab-fresh";
  const paneId = "pane-fresh";
  const cwd = "/tmp/fresh-agent";
  environment.HERDR_WORKSPACE_ID = workspaceId;
  const calls: string[][] = [];
  let paneLists = 0;
  let processInfoCalls = 0;
  let agentStartAt = 0;
  const beganAt = Date.now();
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const processInfo = {
    pane_id: paneId,
    shell_pid: 12,
    foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
  };
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return response({ tabs: [] });
      if (key === "tab create")
        return response({
          tab: { tab_id: tabId, label: "agents", workspace_id: workspaceId },
          root_pane: { pane_id: paneId },
        });
      if (key === "pane list") {
        paneLists++;
        const ready = true;
        return response({
          panes: [
            {
              pane_id: paneId,
              workspace_id: workspaceId,
              tab_id: tabId,
              agent_status: ready ? "unknown" : "working",
              ...(ready ? {} : { agent: "shell-starting" }),
              foreground_cwd: cwd,
            },
          ],
        });
      }
      if (key === "pane process-info") {
        processInfoCalls++;
        return response({
          process_info: processInfo,
        });
      }
      if (key === "pane run") return response({});
      if (key === "pane wait-output") {
        const run = calls.find(
          (item) => item[0] === "pane" && item[1] === "run",
        )!;
        const marker = String(run[3]).match(
          /(__PI_HERDSMAN_READY_[0-9a-f-]{36}__)$/,
        )![1];
        assert.equal(args[args.indexOf("--regex") + 1], `^${marker}$`);
        return response({});
      }
      if (key === "agent start") {
        agentStartAt = Date.now();
        return response({
          agent: {
            name: "agent-run",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: "session-id",
            },
          },
        });
      }
      throw new Error("unexpected Herdr call: " + args.join(" "));
    },
  } as any;

  try {
    await startHerdrAgent(pi, { cwd } as any, {
      label: "agent",
      runId: "run-id",
      cwd,
      placement: { kind: "tab", label: "agents" },
      env: ["PI_HERDSMAN_MAILBOX=/tmp/mailbox"],
    });
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }

  const paneListCalls = calls
    .map((args, index) =>
      args[0] === "pane" && args[1] === "list" ? index : -1,
    )
    .filter((index) => index >= 0);
  const start = calls.findIndex(
    (args) => args[0] === "agent" && args[1] === "start",
  );
  assert.ok(paneLists >= 1);
  assert.equal(
    calls.some((args) => args[0] === "tab" && args[1] === "list"),
    false,
  );
  assert.equal(processInfoCalls, 2);
  assert.ok(start > paneListCalls[0]!);
  assert.ok(agentStartAt >= beganAt);
});

test("startup does not launch while the exact readiness marker is pending", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "pending-workspace";
  const calls: string[][] = [];
  let releaseMarker!: () => void;
  let markerStarted!: () => void;
  const markerPending = new Promise<void>(
    (resolve) => (releaseMarker = resolve),
  );
  const markerSeen = new Promise<void>((resolve) => (markerStarted = resolve));
  let processInfo = {
    pane_id: "pending-pane",
    shell_pid: 100,
    foreground_process_group_id: 200,
    foreground_processes: [{ pid: 200, argv0: "child" }],
  };
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return response({ tabs: [] });
      if (key === "tab create")
        return response({
          tab: { tab_id: "pending-tab", label: "agents" },
          root_pane: { pane_id: "pending-pane" },
        });
      if (key === "pane run") {
        markerStarted();
        return response({});
      }
      if (key === "pane wait-output") {
        await markerPending;
        processInfo = {
          pane_id: "pending-pane",
          shell_pid: 100,
          foreground_process_group_id: 100,
          foreground_processes: [{ pid: 100, argv0: "/bin/zsh" }],
        };
        return response({});
      }
      if (key === "pane list")
        return response({
          panes: [
            {
              pane_id: "pending-pane",
              workspace_id: "pending-workspace",
              tab_id: "pending-tab",
              agent_status: "unknown",
              foreground_cwd: "/tmp/pending-agent",
            },
          ],
        });
      if (key === "pane process-info")
        return response({ process_info: processInfo });
      if (key === "agent start")
        return response({ agent: { name: "pending-agent" } });
      throw new Error("unexpected Herdr call: " + args.join(" "));
    },
  } as any;
  try {
    const starting = startHerdrAgent(pi, { cwd: "/tmp/pending-agent" } as any, {
      label: "pending",
      runId: "pending-run",
      cwd: "/tmp/pending-agent",
      placement: { kind: "tab", label: "agents" },
    });
    await markerSeen;
    assert.equal(
      calls.filter((args) => args[0] === "agent" && args[1] === "start").length,
      0,
    );
    releaseMarker();
    await starting;
    const readinessCalls = calls.filter(
      (args) =>
        args[0] === "pane" &&
        ["run", "process-info", "wait-output", "list"].includes(args[1]),
    );
    assert.deepEqual(
      readinessCalls.map((args) => args.slice(0, 2).join(" ")),
      [
        "pane run",
        "pane wait-output",
        "pane process-info",
        "pane list",
        "pane process-info",
      ],
    );
    assert.equal(
      calls.filter((args) => args[0] === "agent" && args[1] === "start").length,
      1,
    );
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
});

type StartAgentCase =
  | "missing-marker"
  | "corrupt-marker"
  | "workspace-mutation"
  | "tab-mutation"
  | "pane-mutation"
  | "cwd-mutation"
  | "shell-pid-mutation"
  | "busy-foreground-pgid"
  | "malformed-process-info"
  | "mismatched-process-info-pane"
  | "success"
  | "native-failure";

async function startAgentCase(
  kind: StartAgentCase,
  onMarker?: () => void,
  timeoutMs = 30_000,
) {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "case-workspace";
  const cwd = "/tmp/case-agent";
  const calls: string[][] = [];
  let processInfoCalls = 0;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const processInfo = () => ({
    pane_id:
      kind === "mismatched-process-info-pane" ? "other-pane" : "case-pane",
    shell_pid:
      kind === "malformed-process-info"
        ? "unknown"
        : kind === "shell-pid-mutation" && processInfoCalls > 1
          ? 99
          : 12,
    foreground_process_group_id:
      kind === "busy-foreground-pgid" && processInfoCalls === 2 ? 99 : 12,
    foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list") return response({ tabs: [] });
      if (key === "tab create")
        return response({
          tab: { tab_id: "case-tab", label: "agents" },
          root_pane: { pane_id: "case-pane" },
        });
      if (key === "pane run") return response({});
      if (key === "pane wait-output") {
        if (kind === "missing-marker") throw new Error("wait-output timeout");
        if (kind === "corrupt-marker") {
          const run = calls.find(
            (item) => item[0] === "pane" && item[1] === "run",
          )!;
          const marker = String(run[3]).match(
            /(__PI_HERDSMAN_READY_[0-9a-f-]{36}__)$/,
          )![1];
          const matchIndex = args.indexOf("--regex");
          assert.deepEqual(args.slice(matchIndex, matchIndex + 2), [
            "--regex",
            `^${marker}$`,
          ]);
          return {
            code: 1,
            stdout: "__PI_HERDSMAN_READY_wrong__ unrelated terminal text",
            stderr: "marker did not match",
          };
        }
        onMarker?.();
        return response({});
      }
      if (key === "pane list") {
        const mutation =
          kind === "workspace-mutation"
            ? { workspace_id: "other-workspace" }
            : kind === "tab-mutation"
              ? { tab_id: "other-tab" }
              : kind === "pane-mutation"
                ? { pane_id: "other-pane" }
                : kind === "cwd-mutation"
                  ? { foreground_cwd: "/tmp/other-agent" }
                  : {};
        return response({
          panes: [
            {
              pane_id: "case-pane",
              workspace_id: "case-workspace",
              tab_id: "case-tab",
              agent_status: "unknown",
              foreground_cwd: cwd,
              ...mutation,
            },
          ],
        });
      }
      if (key === "pane process-info") {
        processInfoCalls++;
        return response({ process_info: processInfo() });
      }
      if (key === "pane read") return { code: 0, stdout: "", stderr: "" };
      if (key === "agent start") {
        return kind === "native-failure"
          ? { code: 1, stdout: "", stderr: "native start failed" }
          : response({
              agent: {
                name: "case-agent",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: "case-session",
                },
              },
            });
      }
      throw new Error("unexpected Herdr call: " + args.join(" "));
    },
  } as any;
  try {
    let failure: unknown;
    try {
      await startHerdrAgent(pi, { cwd } as any, {
        label: "case",
        runId: "case-run",
        cwd,
        placement: { kind: "tab", label: "agents" },
        timeoutMs,
      });
    } catch (errorValue) {
      failure = errorValue;
    }
    const startArgs = calls.find(
      (args) => args[0] === "agent" && args[1] === "start",
    );
    return {
      calls,
      failure,
      agentStarts: calls.filter(
        (args) => args[0] === "agent" && args[1] === "start",
      ).length,
      startTimeout: Number(
        startArgs?.[startArgs.findIndex((arg) => arg === "--timeout") + 1],
      ),
    };
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
}

test("startHerdrAgent rejects unstable readiness observations without starting an agent", async () => {
  for (const kind of [
    "missing-marker",
    "corrupt-marker",
    "workspace-mutation",
    "tab-mutation",
    "pane-mutation",
    "cwd-mutation",
    "shell-pid-mutation",
    "busy-foreground-pgid",
    "malformed-process-info",
    "mismatched-process-info-pane",
  ] as const) {
    {
      const result = await startAgentCase(kind);
      assert.equal(result.agentStarts, 0);
      assert.ok(result.failure);
    }
  }
});

test("startHerdrAgent handles stable readiness and native-start outcomes", async () => {
  const result = await startAgentCase("success");
  assert.equal(result.failure, undefined);
  assert.equal(result.agentStarts, 1);
  await (async () => {
    const result = await startAgentCase("native-failure");
    assert.ok(result.failure);
    assert.equal(result.agentStarts, 1);
  })();
  await (async () => {
    const originalDateNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const result = await startAgentCase("success", () => {
        now += 2_500;
      });
      assert.equal(result.agentStarts, 1);
      assert.equal(result.startTimeout, 25_500);
      assert.ok(result.startTimeout < 28_000);
      assert.ok(result.startTimeout > 2_000);
    } finally {
      Date.now = originalDateNow;
    }
  })();
});

test("readiness exhaustion preserves the diagnostic reserve and never starts", async () => {
  const originalDateNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const result = await startAgentCase(
      "success",
      () => {
        now += 4_001;
      },
      6_000,
    );
    assert.equal(result.agentStarts, 0);
    assert.ok(result.failure);
    assert.equal(
      result.calls.some((args) => args[0] === "pane" && args[1] === "read"),
      false,
    );
  } finally {
    Date.now = originalDateNow;
  }
});

test("split rejects a stale caller before topology mutation", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  const previousTab = environment.HERDR_TAB_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  environment.HERDR_TAB_ID = "tab-1";
  const calls: string[][] = [];
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list")
        return response({
          tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
        });
      if (key === "pane list")
        return response({
          panes: [
            {
              pane_id: "caller",
              workspace_id: "workspace-2",
              tab_id: "tab-1",
            },
          ],
        });
      throw new Error("topology mutation should not run");
    },
  } as any;

  try {
    await assert.rejects(
      startHerdrAgent(pi, { cwd: "/tmp" } as any, {
        label: "agent",
        runId: "run-id",
        cwd: "/tmp",
        placement: { kind: "split", paneId: "caller" },
      }),
      /not in workspace/,
    );
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
    if (previousTab === undefined) delete environment.HERDR_TAB_ID;
    else environment.HERDR_TAB_ID = previousTab;
  }
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "split"),
    false,
  );
});

async function placementCalls(config: {
  placement: "tab" | "split";
  callerPaneId?: string;
  direction?: "right" | "down";
  panes: any[];
  layout?: any;
}): Promise<{ calls: string[][]; cwd: string }> {
  const environment = globalThis.process.env;
  const previous = {
    workspace: environment.HERDR_WORKSPACE_ID,
    tab: environment.HERDR_TAB_ID,
    pane: environment.HERDR_PANE_ID,
  };
  const workspaceId = "workspace-1";
  const tabId = "tab-1";
  const cwd = mkdtempSync(join(tmpdir(), "pi-herdsman-placement-agent-"));
  environment.HERDR_WORKSPACE_ID = workspaceId;
  if (config.placement === "split") {
    environment.HERDR_TAB_ID = "stale-tab";
    environment.HERDR_PANE_ID = config.callerPaneId;
  }
  let split = false;
  const calls: string[][] = [];
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "tab list")
        return response({
          tabs: [
            {
              tab_id: tabId,
              label: "agents",
              workspace_id: workspaceId,
            },
          ],
        });
      if (key === "pane list")
        return response({
          panes: split
            ? [
                ...config.panes,
                {
                  pane_id: "new-pane",
                  workspace_id: workspaceId,
                  tab_id: tabId,
                  agent_status: "unknown",
                  foreground_cwd: cwd,
                },
              ]
            : config.panes,
        });
      if (key === "pane layout") return response({ layout: config.layout });
      if (key === "pane split") {
        split = true;
        return response({ pane: { pane_id: "new-pane" } });
      }
      if (key === "pane process-info")
        return response({
          process_info: {
            pane_id: args[3],
            shell_pid: 12,
            foreground_process_group_id: 12,
            foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
          },
        });
      if (key === "pane wait-output") return response({});
      if (key === "agent start")
        return response({
          agent: {
            name: "agent-run",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: "session-id",
            },
          },
        });
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any;

  try {
    await startHerdrAgent(pi, { cwd } as any, {
      label: "agent",
      runId: "run-id",
      cwd,
      placement:
        config.placement === "split"
          ? { kind: "split", paneId: config.callerPaneId! }
          : { kind: "tab", label: "agents", tabId },
      direction: config.direction,
    });
  } finally {
    if (previous.workspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previous.workspace;
    if (previous.tab === undefined) delete environment.HERDR_TAB_ID;
    else environment.HERDR_TAB_ID = previous.tab;
    if (previous.pane === undefined) delete environment.HERDR_PANE_ID;
    else environment.HERDR_PANE_ID = previous.pane;
  }
  return { calls, cwd };
}

test("placement validates a non-lead caller and selects the largest agent axis", async () => {
  const caller = await placementCalls({
    placement: "split",
    callerPaneId: "caller",
    direction: "down",
    panes: [
      {
        pane_id: "caller",
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        agent: NON_PI_AGENT,
      },
    ],
  });
  const option = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const callerSplit = caller.calls.find(
    (args) => args[0] === "pane" && args[1] === "split",
  )!;
  assert.equal(option(callerSplit, "--pane"), "caller");
  assert.equal(option(callerSplit, "--ratio"), "0.65");
  assert.equal(option(callerSplit, "--direction"), "down");
  assert.equal(option(callerSplit, "--cwd"), realpathSync(caller.cwd));
  assert.equal(callerSplit.includes("--no-focus"), true);
  assert.equal(
    caller.calls.some((args) => args[0] === "pane" && args[1] === "layout"),
    false,
  );

  for (const testCase of [
    {
      layout: {
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        panes: [
          { pane_id: "small", rect: { width: 20, height: 100 } },
          { pane_id: "large", rect: { width: 120, height: 100 } },
        ],
      },
      anchor: "large",
      direction: "right",
    },
    {
      layout: {
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        panes: [
          { pane_id: "wide", rect: { width: 100, height: 40 } },
          { pane_id: "tall", rect: { width: 70, height: 120 } },
        ],
      },
      anchor: "tall",
      direction: "down",
    },
  ]) {
    const placement = await placementCalls({
      placement: "tab",
      panes: testCase.layout.panes.map((item: any) => ({
        pane_id: item.pane_id,
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        agent: "agent",
      })),
      layout: testCase.layout,
    });
    assert.deepEqual(
      placement.calls.find(
        (args) => args[0] === "pane" && args[1] === "layout",
      ),
      ["pane", "layout", "--pane", testCase.layout.panes[0].pane_id],
    );
    const agentSplit = placement.calls.find(
      (args) => args[0] === "pane" && args[1] === "split",
    )!;
    assert.equal(option(agentSplit, "--pane"), testCase.anchor);
    assert.equal(option(agentSplit, "--ratio"), "0.5");
    assert.equal(option(agentSplit, "--direction"), testCase.direction);
    assert.equal(option(agentSplit, "--cwd"), realpathSync(placement.cwd));
    assert.equal(agentSplit.includes("--no-focus"), true);
  }
});

test("preserving stop refuses a process takeover at the destructive boundary", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const session = {
    source: "herdr:pi" as const,
    agent: "pi" as const,
    kind: "id" as const,
    value: "session-1",
  };
  const agent = {
    name: "agent-1",
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    cwd: "/tmp",
    agent_session: session,
  };
  const pane = {
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    cwd: "/tmp",
    agent_session: session,
  };
  const running = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 20,
    foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
  };
  const takeover = { ...running, foreground_process_group_id: 99 };
  const calls: string[][] = [];
  let processInfoCalls = 0;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent get") return response({ agent });
      if (key === "pane get") return response({ pane });
      if (key === "tab list")
        return response({
          tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
        });
      if (key === "pane process-info")
        return response({
          process_info: processInfoCalls++ === 0 ? running : takeover,
        });
      if (key === "agent send-keys")
        throw new Error("stop keys should not be sent");
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  } as any;

  try {
    await assert.rejects(
      stopHerdrAgentPreservingPane(pi, { cwd: "/tmp" } as any, "agent-1", {
        paneId: "pane-1",
        tabId: "tab-1",
        workspaceId: "workspace-1",
        cwd: "/tmp",
        session: { id: "session-1" },
      }),
      /process ownership is unproven/,
    );
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.equal(
    calls.some((args) => args[1] === "send-keys"),
    false,
  );
});

test("preserving stop rejects malformed session identity observations", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const sessionShapes = [
    { value: "session-1" },
    { kind: "unexpected", value: "session-1" },
    {
      source: "other",
      agent: "pi",
      kind: "id",
      value: "session-1",
    },
    {
      source: "herdr:pi",
      agent: "other",
      kind: "id",
      value: "session-1",
    },
  ];
  let sessionShape = sessionShapes[0];
  const calls: string[][] = [];
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "get")
        return response({
          agent: {
            name: "agent-1",
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: sessionShape,
          },
        });
      throw new Error("destructive observation should not continue");
    },
  } as any;

  try {
    for (const shape of sessionShapes) {
      sessionShape = shape;
      await assert.rejects(
        stopHerdrAgentPreservingPane(pi, { cwd: "/tmp" } as any, "agent-1", {
          paneId: "pane-1",
          tabId: "tab-1",
          workspaceId: "workspace-1",
          cwd: "/tmp",
          session: { id: "session-1" },
        }),
        /ownership is unproven/,
      );
    }
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.equal(
    calls.some((args) => args[1] === "send-keys"),
    false,
  );
});

test("session matching keeps id and canonical path observations kind-aware", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-session-"));
  const path = join(root, "agent-session.jsonl");
  const alias = join(root, "alias-session.jsonl");
  const other = join(root, "other-session.jsonl");
  const missing = join(root, "missing-session.jsonl");
  writeFileSync(path, "{}");
  writeFileSync(other, "{}");
  symlinkSync(path, alias);
  try {
    assert.equal(
      matchesExpectedSession(
        {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: alias,
        },
        { id: "different-id", path },
      ),
      true,
    );
    assert.equal(sameObservedSessionPath(alias, path), true);
    assert.equal(sameObservedSessionPath(missing, path), false);
    assert.equal(sameObservedSessionPath(missing, missing), true);
    assert.throws(
      () => sameObservedSessionPath(path, missing),
      /could not canonicalize exact Pi session path/,
    );
    assert.throws(
      () =>
        matchesExpectedSession(
          {
            source: "herdr:pi",
            agent: "pi",
            kind: "path",
            value: path,
          },
          { path: missing },
        ),
      /could not canonicalize exact Pi session path/,
    );
    assert.equal(
      matchesExpectedSession(
        {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: other,
        },
        { id: "agent-session", path },
      ),
      false,
    );
    assert.equal(
      matchesExpectedSession(
        {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: missing,
        },
        { id: "different-id", path: missing },
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(
    matchesExpectedSession(
      {
        source: "herdr:pi",
        agent: "pi",
        kind: "id",
        value: "agent-session",
      },
      { id: "agent-session", path: "/tmp/other-session.jsonl" },
    ),
    true,
  );
});

test("inspection matches canonical native path identities and rejects missing paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-inspection-session-"));
  const path = join(root, "agent-session.jsonl");
  const alias = join(root, "alias-session.jsonl");
  const missing = join(root, "missing-session.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "session",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    })}\n`,
  );
  symlinkSync(path, alias);
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  let reads = 0;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "agent" && args[1] === "get")
        return response({
          agent: {
            workspace_id: "workspace",
            pane_id: "pane",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: alias,
            },
          },
        });
      if (args[0] === "agent" && args[1] === "read") {
        reads++;
        return { code: 0, stdout: "recent output", stderr: "" };
      }
      if (args[0] === "pane" && args[1] === "process-info")
        return { code: 1, stdout: "", stderr: "unavailable" };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  } as any;

  try {
    const snapshot = await inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
      workspaceId: "workspace",
      paneId: "pane",
      piSessionId: "session",
      piSessionFile: path,
    });
    assert.equal(snapshot.recentOutput, "recent output");
    assert.equal(reads, 1);

    const originalExec = pi.exec;
    pi.exec = async (_command: string, args: string[]) => {
      if (args[0] === "agent" && args[1] === "get")
        return response({
          agent: {
            workspace_id: "workspace",
            pane_id: "pane",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: missing,
            },
          },
        });
      return originalExec(_command, args);
    };
    await assert.rejects(
      inspectHerdrAgent(pi, { cwd: "/tmp" } as any, {
        workspaceId: "workspace",
        paneId: "pane",
        piSessionId: "session",
      }),
      /Inspection target identity did not match/,
    );
    assert.equal(reads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session identity requires the native Pi AgentSessionInfo", () => {
  const valid = {
    source: "herdr:pi",
    agent: "pi",
    kind: "id" as const,
    value: "agent-session",
  };
  assert.deepEqual(sessionIdentity(valid), {
    kind: "id",
    value: "agent-session",
  });
  for (const invalid of [
    { ...valid, source: "other" },
    { ...valid, agent: "claude" },
    { ...valid, kind: "other" },
    { ...valid, value: "" },
    { kind: "id", value: valid.value },
  ]) {
    assert.equal(sessionIdentity(invalid), undefined);
    assert.equal(
      matchesExpectedSession(invalid, { id: "agent-session" }),
      false,
    );
  }
  assert.deepEqual(
    sessionIdentity({ ...valid, kind: "path", value: "/tmp/session.jsonl" }),
    { kind: "path", value: "/tmp/session.jsonl" },
  );
});

test("close accepts a same-workspace tab move without historical tab identity", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const session = {
    source: "herdr:pi" as const,
    agent: "pi" as const,
    kind: "id" as const,
    value: "session-1",
  };
  const processInfo = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 20,
    foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
  };
  const calls: string[][] = [];
  let closed = false;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent get")
        return response({
          agent: {
            name: "agent-1",
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-2",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "pane get")
        return response({
          pane: {
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-2",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "tab list") return response({ tabs: [{ tab_id: "tab-2" }] });
      if (key === "pane process-info")
        return response({ process_info: processInfo });
      if (key === "pane close") {
        closed = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (key === "agent list") return response({ agents: closed ? [] : [] });
      if (key === "pane list") return response({ panes: [] });
      throw new Error("unexpected Herdr call: " + args.join(" "));
    },
  } as any;

  try {
    await closeHerdrPane(pi, { cwd: "/tmp" } as any, "agent-1", {
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp",
      session: { id: "session-1" },
    });
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.equal(closed, true);
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "close"),
    true,
  );
  assert.equal(
    calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
    false,
  );
});

test("completed agent shell transition closes the pane without stop keys", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const session = {
    source: "herdr:pi" as const,
    agent: "pi" as const,
    kind: "id" as const,
    value: "session-1",
  };
  const running = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 20,
    foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
  };
  const shell = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 10,
    foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
  };
  const calls: string[][] = [];
  let processInfoCalls = 0;
  let closed = false;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent get")
        return response({
          agent: {
            name: "agent-1",
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "pane get")
        return response({
          pane: {
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "tab list")
        return response({
          tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
        });
      if (key === "pane process-info")
        return response({
          process_info: processInfoCalls++ === 0 ? running : shell,
        });
      if (key === "pane run" || key === "pane wait-output") return response({});
      if (key === "pane close") {
        closed = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (key === "agent list")
        return response({ agents: closed ? [] : [{ name: "agent-1" }] });
      if (key === "pane list")
        return response({ panes: closed ? [] : [{ pane_id: "pane-1" }] });
      throw new Error("unexpected Herdr call: " + args.join(" "));
    },
  } as any;

  try {
    await closeHerdrPane(pi, { cwd: "/tmp" } as any, "agent-1", {
      paneId: "pane-1",
      tabId: "tab-1",
      workspaceId: "workspace-1",
      cwd: "/tmp",
      session: { id: "session-1" },
      allowPostCompletionTransition: true,
    });
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.equal(closed, true);
  assert.equal(
    calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
    false,
  );
  assert.match(
    calls.find((args) => args[0] === "pane" && args[1] === "run")?.[3] ?? "",
    /^echo __PI_HERDSMAN_READY_[0-9a-f-]{36}__$/,
  );
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "close").length,
    1,
  );
});

test("strict close rejects a completed agent shell transition", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const session = {
    source: "herdr:pi" as const,
    agent: "pi" as const,
    kind: "id" as const,
    value: "session-1",
  };
  const running = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 20,
    foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
  };
  const shell = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 10,
    foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
  };
  const calls: string[][] = [];
  let processInfoCalls = 0;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent get")
        return response({
          agent: {
            name: "agent-1",
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "pane get")
        return response({
          pane: {
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "tab list")
        return response({
          tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
        });
      if (key === "pane process-info")
        return response({
          process_info: processInfoCalls++ === 0 ? running : shell,
        });
      throw new Error("unexpected Herdr call: " + args.join(" "));
    },
  } as any;

  try {
    await assert.rejects(
      closeHerdrPane(pi, { cwd: "/tmp" } as any, "agent-1", {
        paneId: "pane-1",
        tabId: "tab-1",
        workspaceId: "workspace-1",
        cwd: "/tmp",
        session: { id: "session-1" },
      }),
      /process ownership is unproven/,
    );
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "close"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "agent" && args[1] === "send-keys"),
    false,
  );
});

test("rollback refuses malformed or taken-over process ownership before cleanup", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const session = {
    source: "herdr:pi" as const,
    agent: "pi" as const,
    kind: "id" as const,
    value: "session-1",
  };
  const calls: string[][] = [];
  let processObservations: unknown[] = [];
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent get")
        return response({
          agent: {
            name: "agent-1",
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "agent list")
        return response({ agents: [{ name: "agent-1", pane_id: "pane-1" }] });
      if (key === "pane get")
        return response({
          pane: {
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "tab list")
        return response({
          tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
        });
      if (key === "pane process-info")
        return response({ process_info: processObservations.shift() });
      if (key === "agent send-keys")
        throw new Error("stop keys should not be sent");
      if (key === "pane close" || key === "tab close")
        throw new Error("created resources should not be closed");
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  } as any;

  try {
    for (const observations of [
      [[]],
      [
        {
          pane_id: "pane-1",
          shell_pid: 10,
          foreground_process_group_id: 20,
          foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
        },
        {
          pane_id: "pane-1",
          shell_pid: 99,
          foreground_process_group_id: 99,
          foreground_processes: [{ pid: 99, argv0: "/bin/zsh" }],
        },
      ],
    ]) {
      processObservations = observations;
      calls.length = 0;
      await assert.rejects(
        rollbackHerdrStart(pi, { cwd: "/tmp" } as any, {
          herdrAgent: "agent-1",
          workspaceId: "workspace-1",
          tabId: "tab-1",
          paneId: "pane-1",
          cwd: "/tmp",
          createdTab: false,
          createdPane: true,
          sessionReference: { id: session.value },
          paneOwnership: {
            "pane-1": {
              pane_id: "pane-1",
              shell_pid: 10,
              foreground_process_group_id: 10,
              foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
            },
          },
          tabPaneOwnership: {},
        }),
        /process ownership is unproven/,
      );
      assert.equal(
        calls.some((args) => args[1] === "send-keys"),
        false,
      );
      assert.equal(
        calls.some((args) => args[1] === "close"),
        false,
      );
    }
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
});

test("rollback proves the boundary before keys and resources before close", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-rollback-session-"));
  const sessionPath = join(root, "missing-session.jsonl");
  const session = {
    source: "herdr:pi" as const,
    agent: "pi" as const,
    kind: "path" as const,
    value: sessionPath,
  };
  const running = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 20,
    foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
  };
  const shell = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 10,
    foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
  };
  const pane = {
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    cwd: "/tmp",
    agent_session: session,
  };
  const calls: string[][] = [];
  let processInfoCalls = 0;
  let panePresent = true;
  let malformedSettlement = true;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent get")
        return response({
          agent: {
            name: "agent-1",
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
            agent_session: session,
          },
        });
      if (key === "agent list")
        return response(
          processInfoCalls < 2
            ? { agents: [{ ...pane, name: "agent-1" }] }
            : malformedSettlement
              ? { agents: null }
              : { agents: [] },
        );
      if (key === "pane get") return response({ pane });
      if (key === "pane list")
        return response({ panes: panePresent ? [pane] : [] });
      if (key === "tab list")
        return response({
          tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
        });
      if (key === "pane process-info")
        return response({
          process_info: processInfoCalls++ < 2 ? running : shell,
        });
      if (key === "agent send-keys") return { code: 0, stdout: "", stderr: "" };
      if (key === "pane close") {
        assert.equal(panePresent, true);
        panePresent = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  } as any;

  const attempt = {
    herdrAgent: "agent-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    cwd: "/tmp",
    createdTab: false,
    createdPane: true,
    sessionReference: { path: sessionPath },
    paneOwnership: { "pane-1": shell },
    tabPaneOwnership: {},
  };

  try {
    await assert.rejects(
      rollbackHerdrStart(pi, { cwd: "/tmp" } as any, attempt),
      /agent list ownership proof is unavailable/,
    );
    assert.equal(
      calls.some((args) => args[1] === "send-keys"),
      true,
    );
    assert.equal(
      calls.some((args) => args[1] === "close"),
      false,
    );
    calls.length = 0;
    processInfoCalls = 0;
    malformedSettlement = false;
    await rollbackHerdrStart(pi, { cwd: "/tmp" } as any, attempt);
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
    rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(
    calls.map((args) => args.slice(0, 2).join(" ")),
    [
      "agent list",
      "agent get",
      "pane get",
      "tab list",
      "pane process-info",
      "agent get",
      "pane get",
      "tab list",
      "pane process-info",
      "agent send-keys",
      "agent list",
      "pane get",
      "pane process-info",
      "agent list",
      "pane get",
      "pane process-info",
      "tab list",
      "pane get",
      "pane process-info",
      "pane close",
      "agent list",
      "pane list",
    ],
  );
  assert.equal(panePresent, false);
});

test("rollback cleans an exited created pane and preserves an exited reused pane", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const shell = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 10,
    foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
  };
  for (const createdPane of [true, false]) {
    const calls: string[][] = [];
    let panePresent = true;
    const response = (value: unknown) => ({
      code: 0,
      stdout: JSON.stringify({ id: 1, result: value }),
      stderr: "",
    });
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        if (key === "agent list") return response({ agents: [] });
        if (key === "tab list")
          return response({
            tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
          });
        if (key === "pane list")
          return response({
            panes: panePresent ? [{ pane_id: "pane-1", tab_id: "tab-1" }] : [],
          });
        if (key === "pane get")
          return response({
            pane: {
              pane_id: "pane-1",
              workspace_id: "workspace-1",
              tab_id: "tab-1",
              cwd: "/tmp",
            },
          });
        if (key === "pane process-info")
          return response({ process_info: shell });
        if (key === "pane close") {
          assert.equal(panePresent, true);
          panePresent = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
      },
    } as any;
    await rollbackHerdrStart(pi, { cwd: "/tmp" } as any, {
      herdrAgent: "agent-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: "pane-1",
      cwd: "/tmp",
      createdTab: false,
      createdPane,
      sessionReference: { id: "session-1" },
      paneOwnership: { "pane-1": shell },
      tabPaneOwnership: {},
    });
    assert.equal(
      calls.filter((args) => args[0] === "pane" && args[1] === "close").length,
      createdPane ? 1 : 0,
    );
    assert.equal(panePresent, !createdPane);
    assert.equal(
      calls.filter((args) => args[0] === "agent" && args[1] === "list").length,
      createdPane ? 3 : 2,
    );
    assert.equal(
      calls.some((args) => args[1] === "send-keys"),
      false,
    );
  }
  if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
  else environment.HERDR_WORKSPACE_ID = previousWorkspace;
});

test("rollback closes an exactly owned exited created tab", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const shell = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 10,
    foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
  };
  const calls: string[][] = [];
  let tabPresent = true;
  let panePresent = true;
  const response = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ id: 1, result: value }),
    stderr: "",
  });
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "agent list") return response({ agents: [] });
      if (key === "tab list")
        return response({
          tabs: tabPresent
            ? [{ tab_id: "tab-1", workspace_id: "workspace-1" }]
            : [],
        });
      if (key === "pane list")
        return response({
          panes: panePresent ? [{ pane_id: "pane-1", tab_id: "tab-1" }] : [],
        });
      if (key === "pane get")
        return response({
          pane: {
            pane_id: "pane-1",
            workspace_id: "workspace-1",
            tab_id: "tab-1",
            cwd: "/tmp",
          },
        });
      if (key === "pane process-info") return response({ process_info: shell });
      if (key === "pane close")
        throw new Error("created tab must not be closed through its root pane");
      if (key === "tab close") {
        assert.equal(tabPresent, true);
        assert.equal(panePresent, true);
        tabPresent = false;
        panePresent = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    },
  } as any;
  try {
    await rollbackHerdrStart(pi, { cwd: "/tmp" } as any, {
      herdrAgent: "agent-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: "pane-1",
      cwd: "/tmp",
      createdTab: true,
      createdPane: true,
      sessionReference: { id: "session-1" },
      paneOwnership: { "pane-1": shell },
      tabPaneOwnership: { "pane-1": shell },
    });
  } finally {
    if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
    else environment.HERDR_WORKSPACE_ID = previousWorkspace;
  }
  assert.deepEqual(
    calls.filter((args) => args[1] === "close").map((args) => args.slice(0, 3)),
    [["tab", "close", "tab-1"]],
  );
  assert.equal(tabPresent, false);
  assert.equal(panePresent, false);
});

test("exited-start rollback refuses agent, process, and tab ownership changes", async () => {
  const environment = globalThis.process.env;
  const previousWorkspace = environment.HERDR_WORKSPACE_ID;
  environment.HERDR_WORKSPACE_ID = "workspace-1";
  const shell = {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_process_group_id: 10,
    foreground_processes: [{ pid: 10, argv0: "/bin/zsh" }],
  };
  for (const changed of [
    "agent",
    "agent-list",
    "pid",
    "group",
    "tab",
    "panes",
  ] as const) {
    const calls: string[][] = [];
    let agentLists = 0;
    const response = (value: unknown) => ({
      code: 0,
      stdout: JSON.stringify({ id: 1, result: value }),
      stderr: "",
    });
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        const key = args.slice(0, 2).join(" ");
        if (key === "agent list")
          return response({
            ...(changed === "agent-list" && agentLists++ > 0
              ? {}
              : {
                  agents:
                    changed === "agent"
                      ? [{ name: "replacement", pane_id: "pane-1" }]
                      : [],
                }),
          });
        if (key === "tab list")
          return response({
            tabs:
              changed === "tab"
                ? []
                : [{ tab_id: "tab-1", workspace_id: "workspace-1" }],
          });
        if (key === "pane list")
          return response({
            panes: [
              { pane_id: "pane-1", tab_id: "tab-1" },
              { pane_id: "replacement-pane", tab_id: "tab-1" },
            ],
          });
        if (key === "pane get")
          return response({
            pane: {
              pane_id: "pane-1",
              workspace_id: "workspace-1",
              tab_id: "tab-1",
              cwd: "/tmp",
            },
          });
        if (key === "pane process-info")
          return response({
            process_info: {
              ...shell,
              ...(changed === "pid" ? { shell_pid: 11 } : {}),
              ...(changed === "group"
                ? { foreground_process_group_id: 11 }
                : {}),
            },
          });
        throw new Error("destructive cleanup must not run");
      },
    } as any;
    await assert.rejects(
      rollbackHerdrStart(pi, { cwd: "/tmp" } as any, {
        herdrAgent: "agent-1",
        workspaceId: "workspace-1",
        tabId: "tab-1",
        paneId: "pane-1",
        cwd: "/tmp",
        createdTab: changed === "panes",
        createdPane: true,
        sessionReference: { id: "session-1" },
        paneOwnership: { "pane-1": shell },
        tabPaneOwnership: changed === "panes" ? { "pane-1": shell } : {},
      }),
      /replacement agent|ownership is unproven|ownership proof is unavailable/,
    );
    assert.equal(
      calls.some((args) => args[1] === "close"),
      false,
    );
  }
  if (previousWorkspace === undefined) delete environment.HERDR_WORKSPACE_ID;
  else environment.HERDR_WORKSPACE_ID = previousWorkspace;
});

const process = {
  pane_id: "pane-1",
  shell_pid: 12,
  foreground_process_group_id: 34,
  foreground_processes: [{ pid: 99, argv0: "/usr/bin/pi" }],
};

test("run-scoped aliases are stable and distinct by incarnation", () => {
  assert.equal(
    herdrAgentAlias("ws", "agent", "run-1"),
    herdrAgentAlias("ws", "agent", "run-1"),
  );
  assert.notEqual(
    herdrAgentAlias("ws", "agent", "run-1"),
    herdrAgentAlias("ws", "agent", "run-2"),
  );
});

test("pane availability requires an empty pane and matching cwd", () => {
  assert.equal(
    paneIsAvailable(
      { tab_id: "tab", agent_status: "unknown", foreground_cwd: "/tmp" },
      "tab",
      "/tmp",
    ),
    true,
  );
  assert.equal(
    paneIsAvailable(
      {
        tab_id: "tab",
        agent: "agent",
        agent_status: "unknown",
        foreground_cwd: "/tmp",
      },
      "tab",
      "/tmp",
    ),
    false,
  );
  assert.equal(
    paneIsAvailable(
      { tab_id: "tab", agent_status: "unknown", foreground_cwd: "/other" },
      "tab",
      "/tmp",
    ),
    false,
  );
});

test("cwd comparisons accept equivalent symlink paths", () => {
  const real = mkdtempSync(join(tmpdir(), "pi-herdsman-cwd-"));
  const link = `${real}-link`;
  try {
    symlinkSync(real, link);
    assert.equal(sameCwd(real, link), true);
    assert.equal(sameCwd(link, real), true);
    assert.equal(
      paneIsAvailable(
        { tab_id: "tab", agent_status: "unknown", foreground_cwd: real },
        "tab",
        link,
      ),
      true,
    );
    assert.equal(
      paneIsAvailable(
        { tab_id: "tab", agent_status: "unknown", foreground_cwd: link },
        "tab",
        real,
      ),
      true,
    );
    assert.equal(sameCwd(join(real, "missing"), join(real, "missing")), true);
    assert.equal(sameCwd(join(real, "missing"), join(real, "other")), false);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("running ownership includes shell and foreground process group", () => {
  assert.equal(sameRunningProcessOwner(process, process), true);
  assert.equal(
    sameRunningProcessOwner(process, { ...process, shell_pid: 13 }),
    false,
  );
  assert.equal(
    sameRunningProcessOwner(process, {
      ...process,
      foreground_process_group_id: 35,
    }),
    false,
  );
});

test("process ownership handles optional foreground process groups", () => {
  const shell = {
    pane_id: "pane-1",
    shell_pid: 12,
    foreground_process_group_id: 12,
    foreground_processes: [{ pid: 12, argv0: "pwsh.exe" }],
  };
  const cases = [
    ["Unix PGID and singleton shell", shell, true],
    [
      "Windows-style singleton shell without PGID",
      { ...shell, foreground_process_group_id: undefined },
      true,
    ],
    [
      "PGID-only shell proof",
      { ...shell, foreground_processes: undefined },
      true,
    ],
    [
      "busy foreground fails closed",
      { ...shell, foreground_processes: [{ pid: 99, argv0: "node" }] },
      false,
    ],
    [
      "empty foreground fails closed",
      { ...shell, foreground_processes: [] },
      false,
    ],
    [
      "missing foreground proof fails closed",
      {
        ...shell,
        foreground_process_group_id: undefined,
        foreground_processes: undefined,
      },
      false,
    ],
    ["shell PID changes", { ...shell, shell_pid: 13 }, false],
    [
      "contradictory PGID fails closed",
      { ...shell, foreground_process_group_id: 99 },
      false,
    ],
  ] as const;
  for (const [, observed, expected] of cases)
    assert.equal(sameShellProcessOwner(shell, observed), expected);

  const running = { ...shell, foreground_processes: [{ pid: 99 }] };
  assert.equal(
    sameShellProcessOwner(shell, { ...shell, shell_pid: undefined } as any),
    false,
  );
  for (const [expectedProcess, observedProcess, expected] of [
    [
      { ...running, foreground_process_group_id: undefined },
      { ...running, foreground_process_group_id: undefined },
      true,
    ],
    [running, { ...running, foreground_process_group_id: undefined }, false],
    [{ ...running, foreground_process_group_id: undefined }, running, false],
    [running, { ...running, foreground_process_group_id: 99 }, false],
    [{ ...running, pane_id: undefined }, running, false],
    [running, { ...running, pane_id: "other-pane" }, false],
    [running, { ...running, shell_pid: 13 }, false],
  ] as const)
    assert.equal(
      sameRunningProcessOwner(expectedProcess, observedProcess),
      expected,
    );
});

test("shell ownership uses captured identity without a shell allowlist", () => {
  const captured = {
    ...process,
    foreground_process_group_id: 12,
    foreground_processes: [{ pid: 12, argv0: "pwsh.exe" }],
  };
  assert.equal(sameShellProcessOwner(captured, captured), true);
  assert.equal(
    sameShellProcessOwner(captured, {
      ...captured,
      foreground_processes: [{ pid: 12, argv0: "/bin/zsh" }],
    }),
    false,
  );
  assert.equal(
    sameShellProcessOwner(
      { ...process, foreground_process_group_id: 20 },
      captured,
    ),
    true,
  );
  assert.equal(
    sameShellProcessOwner(captured, {
      ...captured,
      foreground_processes: [
        { pid: 12, argv0: "pwsh.exe" },
        { pid: 13, argv0: "child" },
      ],
    }),
    false,
  );
});
