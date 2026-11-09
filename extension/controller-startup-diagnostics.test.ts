import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AGENT_ID,
  DEFAULT_PI_SESSION_ID,
  LEAD_SESSION_ID,
  fakeContext,
  fakePi,
  isPaneClose,
  isPreservePaneStop,
  isTabClose,
  readAgentState,
  writeAgentState,
  realFs,
  registerExtension,
  resetAgentMailbox,
  setLeadEnvironment,
  startupExecutor,
  readAgentStartupOutcome,
  writeAgentStartupOutcome,
} from "./support.ts";

function startupRoleHistory(): SessionEntry[] {
  const timestamp = new Date().toISOString();
  const roleId = "startup-role-entry";
  return [
    {
      type: "custom",
      id: roleId,
      parentId: null,
      timestamp,
      customType: "pi-herdsman-role",
      data: {
        sessionId: LEAD_SESSION_ID,
        role: "lead",
        leadTools: ["read"],
      },
    },
    {
      type: "custom",
      id: "startup-execution-entry",
      parentId: roleId,
      timestamp,
      customType: "pi-herdsman-lead-execution",
      data: {
        sessionId: LEAD_SESSION_ID,
        mode: "orchestrate",
        leadTools: ["read"],
      },
    },
  ];
}

function safeHerdrOperation(
  command: string,
  args: string[],
): string | undefined {
  if (command !== "herdr") return;
  const operation = args.slice(0, 2).join(" ");
  return (
    {
      "agent start": "agent-start",
      "agent list": "agent-list",
      "agent get": "agent-get",
      "agent send-keys": "agent-send-keys",
      "api snapshot": "api-snapshot",
      "pane close": "pane-close",
      "pane get": "pane-get",
      "pane layout": "pane-layout",
      "pane list": "pane-list",
      "pane process-info": "pane-process-info",
      "pane read": "pane-read",
      "pane run": "pane-run",
      "pane split": "pane-split",
      "pane wait-output": "pane-wait-output",
      "tab close": "tab-close",
      "tab list": "tab-list",
      "worktree list": "worktree-list",
    }[operation] ?? undefined
  );
}

for (const scenario of [
  "failed",
  "conflicting",
  "conflicting-state",
  "missing-state",
] as const) {
  test(`startup ${scenario} rejects without dispatch and rolls back`, async () => {
    setLeadEnvironment();
    const label = `startup-${scenario}`;
    const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
    const timing = {
      startupExecMs: 0,
      afterStartupCalls: [] as {
        operation: string;
        offset_ms: number;
        elapsed_ms: number;
      }[],
    };
    let startupReturnedAt: number | undefined;
    let agentStarted = false;
    let startupRejected = false;
    let rollbackPaneSettled = false;
    const pi = fakePi({
      exec: async (command, args, options) => {
        const operation = safeHerdrOperation(command, args);
        const startedAt = performance.now();
        try {
          if (operation === "agent-list" && rollbackPaneSettled)
            return {
              stdout: JSON.stringify({ id: AGENT_ID, result: { agents: [] } }),
              stderr: "",
              code: 0,
              killed: false,
            };
          if (agentStarted && operation === "pane-process-info")
            return {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: {
                  process_info: {
                    pane_id: "startup-pane",
                    shell_pid: 123,
                    foreground_process_group_id: 456,
                    foreground_processes: [{ pid: 456, argv0: "node" }],
                  },
                },
              }),
              stderr: "",
              code: 0,
            };
          if (command === "herdr" && isPreservePaneStop(args))
            return {
              stdout: "",
              stderr: "fixture rollback stop failed",
              code: 1,
            };
          const result = await startup.exec(command, args, options);
          if (operation === "agent-start") {
            agentStarted = true;
            const outcome = readAgentStartupOutcome(startup.mailbox)!;
            if (scenario === "failed")
              writeAgentStartupOutcome(startup.mailbox, {
                ...outcome,
                status: "failed",
                error: "bootstrap failed",
                stage: "bootstrap",
              });
            if (scenario === "conflicting")
              writeAgentStartupOutcome(startup.mailbox, {
                ...outcome,
                paneId: "other-pane",
              });
            if (scenario === "conflicting-state")
              writeAgentState(startup.mailbox, {
                ...readAgentState(startup.mailbox)!,
                runId: "11111111-1111-4111-8111-111111111111",
              });
            if (scenario === "missing-state")
              realFs.unlinkSync(`${startup.mailbox}/state.json`);
            startupRejected = true;
          }
          if (operation === "pane-process-info" && startupRejected)
            rollbackPaneSettled = true;
          return result;
        } finally {
          const finishedAt = performance.now();
          const elapsedMs = finishedAt - startedAt;
          if (operation === "agent-start") {
            timing.startupExecMs += elapsedMs;
            startupReturnedAt = finishedAt;
          } else if (operation && startupReturnedAt !== undefined) {
            timing.afterStartupCalls.push({
              operation,
              offset_ms: Number((finishedAt - startupReturnedAt).toFixed(3)),
              elapsed_ms: Number(elapsedMs.toFixed(3)),
            });
          }
        }
      },
    });
    registerExtension!(pi.pi as never);
    pi.entries.push(...startupRoleHistory());
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries),
    );
    try {
      const delegate = pi.tools.find((tool) => tool.name === "delegate_agent")!;
      const operationStartedAt = performance.now();
      let result: Awaited<ReturnType<typeof delegate.execute>>;
      try {
        result = await delegate.execute(
          "id",
          { definition: "agent", label, task: "test" },
          undefined,
          undefined,
          fakeContext(pi.entries),
        );
      } finally {
        if (process.env.HERDSMAN_STARTUP_DIAGNOSTICS === "1") {
          const afterStartupElapsedMs =
            startupReturnedAt === undefined
              ? "unobserved"
              : (performance.now() - startupReturnedAt).toFixed(1);
          console.log(
            `[startup-timing] ${scenario} delegate_elapsed_ms=${(performance.now() - operationStartedAt).toFixed(1)} startup_exec_elapsed_ms=${timing.startupExecMs.toFixed(1)} after_startup_elapsed_ms=${afterStartupElapsedMs} herdr_calls=${JSON.stringify(timing.afterStartupCalls)}`,
          );
        }
      }
      assert.equal(
        result.details.error.category,
        "rollback_failure",
        JSON.stringify(result.details),
      );
      assert.equal(
        result.details.error.primary.category,
        scenario === "failed"
          ? "pane_not_ready"
          : scenario === "missing-state"
            ? "internal_failure"
            : "target_not_found",
      );
      assert.ok(result.details.error.cleanup.message);
      if (scenario === "failed")
        assert.match(result.details.error.primary.message, /bootstrap failed/);
      assert.equal(
        realFs.existsSync(startup.mailbox) &&
          realFs
            .readdirSync(startup.mailbox)
            .some((name) => name.startsWith("request-")),
        false,
      );
      assert.equal(result.details.error.rollbackOccurred, true);
    } finally {
      startup.stopMailboxConsumer();
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  });
}

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
    pi.entries.push(...startupRoleHistory());
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries),
    );
    try {
      const delegate = pi.tools.find((tool) => tool.name === "delegate_agent");
      assert.ok(delegate);

      const result = await delegate.execute(
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
      startup.stopMailboxConsumer();
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
    pi.entries.push(...startupRoleHistory());
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(pi.entries),
    );
    try {
      const delegate = pi.tools.find((tool) => tool.name === "delegate_agent");
      assert.ok(delegate);

      const result = await delegate.execute(
        "id",
        { definition: "agent", label, task: "optional process diagnostic" },
        undefined,
        undefined,
        fakeContext(pi.entries),
      );
      assert.equal(result.details.error.category, "pane_not_ready");
      assert.equal(
        result.details.error.message,
        "Agent did not report a startup outcome",
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
      startup.stopMailboxConsumer();
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  },
);
