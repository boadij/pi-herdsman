import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ID,
  DEFAULT_PI_SESSION_ID,
  fakeContext,
  fakePi,
  isPaneClose,
  isPreservePaneStop,
  isTabClose,
  readAgentState,
  realFs,
  registerExtension,
  resetAgentMailbox,
  seedLeadRole,
  setLeadEnvironment,
  startupExecutor,
} from "./support.ts";

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
    seedLeadRole(fakeContext(pi.entries));
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
      startup.stopMailboxConsumer();
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  },
);
