import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mock, test } from "node:test";
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  WorkerState,
} from "./mailbox.ts";
import { claimProcessLock } from "./lock.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  REQUEST_ID,
  LEAD_SESSION_ID,
  WORKER_ID,
  WORKSPACE,
  cascadeExecutor,
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  delegationLockPathForTest,
  fakeContext,
  fakePi,
  fakeWorkerContext,
  herdrAlias,
  isAgentList,
  isHerdrList,
  isPaneClose,
  isPaneList,
  isPreservePaneStop,
  isTabClose,
  isTabList,
  listResponse,
  managedState,
  nativeSessions,
  workerControllerExecutor,
  readPendingAsk,
  readRequest,
  readResult,
  readWorkerState,
  realFs,
  recoveryIdentity,
  registerExtension,
  removeAsk,
  resetWorkerMailbox,
  resultEntryDetails,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setWorkerEnvironment,
  truncateModelText,
  workerMailboxPath,
  writeAsk,
  writeResult,
  writeWorkerState,
} from "./support.ts";

test("combined status reports a completed worker as pending, not active", async () => {
  setWorkerEnvironment("status-pending-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("status-pending-parent");
  const triggerRequestId = randomUUID();
  const pendingRequestId = triggerRequestId;
  const trigger = {
    ...managedState(
      "status-trigger-child",
      undefined,
      recoveryIdentity("status-trigger-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/status-trigger-child.jsonl",
    completedRequestId: triggerRequestId,
  };
  const pending = {
    ...managedState(
      "status-pending-child",
      undefined,
      recoveryIdentity("status-pending-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/status-pending-child.jsonl",
    completedRequestId: pendingRequestId,
  };
  const settling = {
    ...managedState(
      "status-settling-child",
      undefined,
      recoveryIdentity("status-settling-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/status-settling-child.jsonl",
  };
  const states = [parent, trigger, pending, settling];
  const mailboxes = states.map((state) =>
    workerMailboxPath(WORKSPACE, state.workerLabel),
  );
  for (const mailbox of mailboxes) resetWorkerMailbox(mailbox);
  for (const [index, state] of states.entries())
    writeWorkerState(mailboxes[index], state);
  const writeChildResult = (
    state: WorkerState,
    mailbox: string,
    requestId: string,
    text: string,
  ) =>
    writeResult(mailbox, {
      version: 3,
      runId: state.runId,
      requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      workerLabel: state.workerLabel,
      paneId: state.paneId,
      status: "completed",
      text,
      completedAt: Date.now(),
    });
  writeChildResult(trigger, mailboxes[1], triggerRequestId, "trigger");
  writeChildResult(pending, mailboxes[2], pendingRequestId, "pending");
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "parent" },
    },
  ];
  const pi = fakePi({
    entries,
    exec: workerControllerExecutor(parent, [trigger, pending, settling]),
    sendMessage: (message) => entries.push(message),
  });
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeWorkerContext(entries));
    const resultMessages = pi.sentMessageCalls.filter(
      ({ message }) =>
        (message as any).customType === "pi-herdsman-worker-result",
    );
    assert.equal(resultMessages.length, 2);
    const statuses = resultMessages.map(
      ({ message }) => (message as any).details,
    );
    assert.deepEqual(
      new Set(statuses.map((details) => details.workerLabel)),
      new Set(["status-trigger-child", "status-pending-child"]),
    );
    assert.equal(
      statuses.filter(
        (details) =>
          details.activeDirectChildCount === 0 &&
          details.pendingDirectResultCount === 1 &&
          details.unresolvedDirectChildCount === 1,
      ).length,
      1,
      "the sibling sharing a request ID remains counted while the exact current child is excluded",
    );
    assert.equal(
      statuses.filter(
        (details) =>
          details.activeDirectChildCount === 0 &&
          details.pendingDirectResultCount === 0 &&
          details.unresolvedDirectChildCount === 0,
      ).length,
      1,
      "the exact current child is excluded once its sibling result is delivered",
    );
    assert.equal(
      resultMessages.some(
        ({ message }) =>
          (message as any).details.activeDirectChildCount === 0 &&
          (message as any).details.pendingDirectResultCount === 1 &&
          (message as any).details.unresolvedDirectChildCount === 1 &&
          /Delegation status: 0 active direct workers; 1 pending direct result; 1 direct worker assignment remains unresolved\./.test(
            String((message as any).content),
          ),
      ),
      true,
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetWorkerMailbox(mailbox);
  }
});

test("rejects legacy mailbox records at the protocol boundary", () => {
  const label = "legacy-mailbox-record";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  const state = managedState(label, REQUEST_ID, recoveryIdentity(label));
  resetWorkerMailbox(mailbox);
  const records: Array<[string, unknown, () => unknown]> = [
    ["state.json", { ...state, version: 2 }, () => readWorkerState(mailbox)],
    [
      `request-${REQUEST_ID}.json`,
      {
        version: 2,
        runId: state.runId,
        requestId: REQUEST_ID,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        workerLabel: state.workerLabel,
        paneId: state.paneId,
        kind: "task",
        text: "legacy request",
        createdAt: Date.now(),
      },
      () => readRequest(mailbox, REQUEST_ID),
    ],
    [
      "ask.json",
      {
        version: 2,
        askId: REQUEST_ID,
        requestId: REQUEST_ID,
        runId: state.runId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        workerLabel: state.workerLabel,
        paneId: state.paneId,
        piSessionId: state.piSessionId,
        question: "legacy ask",
        createdAt: Date.now(),
      },
      () =>
        readPendingAsk(mailbox, {
          ...state,
          activeRequestId: REQUEST_ID,
          pendingAskId: REQUEST_ID,
        }),
    ],
    [
      `result-${REQUEST_ID}.json`,
      {
        version: 2,
        runId: state.runId,
        requestId: REQUEST_ID,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        workerLabel: state.workerLabel,
        paneId: state.paneId,
        status: "completed",
        text: "legacy result",
        completedAt: Date.now(),
      },
      () => readResult(mailbox, REQUEST_ID),
    ],
  ];
  try {
    for (const [name, record, read] of records) {
      resetWorkerMailbox(mailbox);
      writeFileSync(join(mailbox, name), JSON.stringify(record));
      assert.throws(read, /Invalid mailbox protocol version or record/);
    }
  } finally {
    resetWorkerMailbox(mailbox);
  }
});

test("conflicting same-request entries do not suppress an exact combined result", async () => {
  setLeadEnvironment();
  const child = {
    ...managedState(
      "queued-child",
      undefined,
      recoveryIdentity("queued-child"),
    ),
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/queued-child.jsonl",
    completedRequestId: REQUEST_ID,
  };
  const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
  resetWorkerMailbox(childMailbox);
  writeWorkerState(childMailbox, child);
  writeResult(childMailbox, {
    version: 3,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    workerLabel: child.workerLabel,
    paneId: child.paneId,
    status: "completed",
    text: "queued child result",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "worker" },
    },
    {
      customType: "pi-herdsman-worker-result",
      details: {
        ...resultEntryDetails(child, REQUEST_ID),
        runId: "11111111-1111-4111-8111-111111111111",
        ownerSessionId: "22222222-2222-4222-8222-222222222222",
        workerLabel: "different-worker",
        paneId: "different-pane",
        piSessionId: "33333333-3333-4333-8333-333333333333",
        piSessionFile: "/tmp/different-worker.jsonl",
      },
    },
    {
      customType: "pi-herdsman-delegation-guidance",
      details: {
        ...resultEntryDetails(child, REQUEST_ID),
        paneId: "conflicting-pane",
        piSessionFile: "/tmp/conflicting-worker.jsonl",
      },
    },
  ];
  let queued = 0;
  const lifecycle = cascadeExecutor([child]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") queued++;
      else entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(queued, 1);
    assert.equal(
      pi.sent.some(
        (message: any) =>
          message.customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
    assert.ok(readResult(childMailbox, REQUEST_ID));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries((pi.sent[0] as any).details).filter(([key]) =>
          [
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "workerLabel",
            "paneId",
            "cwd",
            "piSessionId",
            "piSessionFile",
          ].includes(key),
        ),
      ),
      resultEntryDetails(child, REQUEST_ID),
      "result persistence details must carry the complete child identity",
    );

    await pi.events.get("agent_settled")![0](undefined, context);
    assert.equal(
      pi.sent.filter(
        (message: any) =>
          message.customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
      "a conflicting same-request result must not resolve status",
    );
    assert.equal(queued, 1, "a conflicting entry must not suppress redelivery");
    assert.ok(readResult(childMailbox, REQUEST_ID));

    entries.push({
      message: {
        customType: "pi-herdsman-worker-result",
        details: resultEntryDetails(child, REQUEST_ID),
      },
    });
    await pi.events.get("agent_settled")![0](undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const statuses = pi.sent.filter(
      (message: any) =>
        message.customType === "pi-herdsman-delegation-guidance",
    );
    assert.equal(statuses.length, 0);
    assert.match(
      String((pi.sent[0] as any).content),
      /Delegation status: 0 active direct workers; 0 pending direct results; all direct worker assignments are resolved\./,
    );
    assert.equal((pi.sent[0] as any).details.unresolvedDirectChildCount, 0);
    assert.equal((pi.sent[0] as any).details.activeDirectChildCount, 0);
    assert.equal((pi.sent[0] as any).details.pendingDirectResultCount, 0);
    await pi.events.get("agent_settled")![0](undefined, context);
    assert.equal(
      pi.sent.filter(
        (message: any) =>
          message.customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
      "an exact persisted result must not create a second status steer",
    );
    assert.equal(readResult(childMailbox, REQUEST_ID), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(childMailbox);
  }
});

test("reload result recovery rejects wrong owners and replacement identities", async () => {
  const label = "reload-proof-child";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  const resultFor = (state: WorkerState): ResultRecord => ({
    version: 3,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    workerLabel: state.workerLabel,
    paneId: state.paneId,
    status: "completed",
    text: "must not replay",
    completedAt: Date.now(),
  });

  setLeadEnvironment();
  const wrongOwner = {
    ...managedState(label, undefined, identity),
    ownerSessionId: "11111111-1111-4111-8111-111111111111",
    completedRequestId: REQUEST_ID,
  };
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, wrongOwner);
  writeResult(mailbox, resultFor(wrongOwner));
  const noLive = cascadeExecutor([]);
  const wrongOwnerPi = fakePi({ exec: noLive.exec });
  registerExtension!(wrongOwnerPi.pi as never);
  try {
    await wrongOwnerPi.events.get("session_start")![0](
      undefined,
      fakeContext(wrongOwnerPi.entries),
    );
    assert.equal(
      wrongOwnerPi.sent.some(
        (message: any) => message.customType === "pi-herdsman-worker-result",
      ),
      false,
    );
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    wrongOwnerPi.events.get("session_shutdown")?.[0]();
  }

  setLeadEnvironment();
  const oldState = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const replacement = {
    ...managedState(label, undefined, {
      paneId: `${label}-replacement-pane`,
      tabId: `${label}-replacement-tab`,
      piSessionId: "22222222-2222-4222-8222-222222222222",
      piSessionFile: `/tmp/${label}-replacement.jsonl`,
    }),
    runId: "33333333-3333-4333-8333-333333333333",
  };
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, oldState);
  writeResult(mailbox, resultFor(oldState));
  const replacementLifecycle = cascadeExecutor([replacement]);
  const replacementPi = fakePi({ exec: replacementLifecycle.exec });
  registerExtension!(replacementPi.pi as never);
  try {
    await replacementPi.events.get("session_start")![0](
      undefined,
      fakeContext(replacementPi.entries),
    );
    assert.equal(
      replacementPi.sent.some(
        (message: any) => message.customType === "pi-herdsman-worker-result",
      ),
      false,
    );
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    replacementPi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(mailbox);
  }
});

test("malformed disappearance proof retains failed-launch cleanup evidence", async () => {
  setLeadEnvironment();
  const label = "rollback-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  let agentGetCount = 0;
  let started = false;
  let stopped = false;
  let tabPresent = false;
  let panePresent = false;
  let malformedPostClosePaneList = false;
  let runId = "";
  let ownerSessionId = "";
  const emptyList = () => {
    const value = JSON.parse(listResponse(label));
    value.agents = [];
    return JSON.stringify(value);
  };
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const validating = args[2] === "pane-start";
        if (validating) agentGetCount++;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                name: validating
                  ? runScopedHerdrAlias(WORKSPACE, label, runId || WORKER_ID)
                  : args[2],
                pane_id: "pane-start",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  kind: "id",
                  value: validating
                    ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
                    : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: tabPresent
                ? [
                    {
                      tab_id: "registered-tab",
                      label: "workers",
                      workspace_id: WORKSPACE,
                    },
                  ]
                : [],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "tab" && args[1] === "create") {
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator > 0) {
            const key = assignment.slice(0, separator);
            const value = assignment.slice(separator + 1);
            if (key === "PI_HERDSMAN_RUN_ID") runId = value;
            if (key === "PI_HERDSMAN_OWNER_SESSION_ID") ownerSessionId = value;
          }
        }
        tabPresent = panePresent = true;
        return {
          stdout: JSON.stringify({
            result: {
              tab: {
                tab_id: "registered-tab",
                label: "workers",
                workspace_id: WORKSPACE,
              },
              root_pane: { pane_id: "pane-start" },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (isPaneList(args)) {
        if (malformedPostClosePaneList) {
          malformedPostClosePaneList = false;
          return {
            stdout: JSON.stringify({ result: {} }),
            stderr: "",
            code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            result: {
              panes: panePresent
                ? [
                    {
                      pane_id: "pane-start",
                      tab_id: "registered-tab",
                      workspace_id: WORKSPACE,
                      cwd: "/tmp",
                      foreground_cwd: "/tmp",
                      agent_status: "unknown",
                    },
                  ]
                : [],
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: "pane-start",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                ...(stopped
                  ? {}
                  : {
                      agent_session: {
                        kind: "id",
                        value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                      },
                    }),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          stdout: JSON.stringify({
            result: {
              process: {
                pane_id: "pane-start",
                shell_pid: 123,
                foreground_process_group_id: !started || stopped ? 123 : 456,
                foreground_processes:
                  !started || stopped
                    ? [{ pid: 123, argv0: "/bin/zsh" }]
                    : [{ pid: 456, argv0: "pi" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (
        args[0] === "pane" &&
        (args[1] === "run" || args[1] === "wait-output")
      ) {
        if (args[1] === "run") {
          const value = (key: string) =>
            new RegExp(`${key}='([^']*)'`).exec(args.at(-1) ?? "")?.[1];
          runId = value("PI_HERDSMAN_RUN_ID") ?? runId;
          ownerSessionId =
            value("PI_HERDSMAN_OWNER_SESSION_ID") ?? ownerSessionId;
        }
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isAgentList(args))
        return {
          stdout:
            started && !stopped
              ? (() => {
                  const value = JSON.parse(listResponse(label));
                  const alias = runScopedHerdrAlias(WORKSPACE, label, runId);
                  value.agents[0].herdr_agent = alias;
                  value.agents[0].name = alias;
                  value.agents[0].pane_id = "pane-start";
                  value.agents[0].tab_id = "registered-tab";
                  return JSON.stringify(value);
                })()
              : emptyList(),
          stderr: "",
          code: 0,
        };
      if (isPaneClose(args))
        throw new Error("created tab must not be closed through its root pane");
      if (isTabClose(args)) {
        assert.equal(args[2], "registered-tab");
        assert.equal(tabPresent, true);
        assert.equal(panePresent, true);
        tabPresent = false;
        panePresent = false;
        malformedPostClosePaneList = true;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isPreservePaneStop(args)) {
        stopped = true;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      started = true;
      writeWorkerState(mailbox, {
        version: 3,
        runId,
        ownerSessionId,
        workspaceId: WORKSPACE,
        workerLabel: label,
        paneId: "pane-start",
        piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        piSessionFile: "/tmp/registered-worker.jsonl",
        cwd: "/tmp",
        updatedAt: Date.now(),
      });
      return {
        stdout: JSON.stringify({
          tab_id: "registered-tab",
          tab_label: "workers",
          pane_id: "pane-start",
          cwd: "/tmp",
          herdr_agent: herdrAlias(label),
          created_tab: false,
          created_pane: true,
          agent: {
            name: args[2],
            pane_id: "pane-start",
            tab_id: "registered-tab",
            workspace_id: WORKSPACE,
            cwd: "/tmp",
            agent_session: {
              kind: "id",
              value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            },
          },
          runtime_identity: {
            herdr_agent: herdrAlias(label),
            herdr_kind: "pi",
            agent_definition: null,
            model: null,
            thinking: null,
            cwd: "/tmp",
            resumed: false,
            session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            session_name: null,
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  });
  registerExtension!(pi.pi as never);
  const result = await pi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "worker",
      label,
      task: "fresh lifecycle task",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.error.category, "rollback_failure");
  assert.equal(result.details.truncated, false);
  assert.equal(result.details.error.retryAttempted, true);
  assert.equal(result.details.error.primary.category, "target_not_found");
  assert.equal(
    result.details.error.primary.message,
    "live Herdr agent Pi session mismatch",
  );
  assert.match(
    result.details.error.cleanup.message,
    /pane list disappearance proof is unavailable/,
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Primary:.*category=target_not_found/s,
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Cleanup:.*operation=rollback/s,
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Next action: Inspect cleanup_errors before retrying cleanup/,
  );
  const rendered = pi.tools[0].renderResult(
    { content: result.content, details: result.details },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text },
    {
      args: {
        action: "delegate",
        definition: "worker",
        task: "fresh lifecycle task",
      },
    },
  );
  assert.match(rendered.text, /Primary:.*category=target_not_found/s);
  assert.match(rendered.text, /Cleanup:.*operation=rollback/s);
  assert.match(
    rendered.text,
    /Next action: Inspect cleanup_errors before retrying cleanup/,
  );
  assert.equal(agentGetCount, 1);
  assert.equal(
    pi.calls.some((args) => isPreservePaneStop(args)),
    true,
  );
  assert.equal(
    pi.calls.some((args) => isTabClose(args)),
    true,
  );
  assert.equal(
    pi.calls.some((args) => isPaneClose(args)),
    false,
  );
  assert.equal(tabPresent, false);
  assert.equal(panePresent, false);
  assert.equal(readWorkerState(mailbox)?.workerLabel, label);
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
    ),
    true,
  );
  const listed = await pi.tools[0].execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.deepEqual(listed.details.workers, []);
  assert.match(
    listed.details.cleanup_errors[label],
    /pane list disappearance proof is unavailable/,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetWorkerMailbox(mailbox);
});

test("assignment rollback retains primary failure and actionable cleanup details", async () => {
  setLeadEnvironment();
  const label = "rollback-detail-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  let runId = "";
  let ownerSessionId = "";
  let splitCreated = false;
  const emptyList = () => {
    const value = JSON.parse(listResponse(label));
    value.agents = [];
    return JSON.stringify(value);
  };
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                name:
                  args[2] === "detail-pane"
                    ? runScopedHerdrAlias(WORKSPACE, label, runId || WORKER_ID)
                    : args[2],
                pane_id: "detail-pane",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  kind: "id",
                  value:
                    args[2] === "detail-pane"
                      ? "wrong-session"
                      : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [
                {
                  tab_id: "registered-tab",
                  label: "workers",
                  workspace_id: WORKSPACE,
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                {
                  pane_id: "detail-pane",
                  tab_id: "registered-tab",
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  foreground_cwd: "/tmp",
                  agent_status: splitCreated ? "unknown" : "idle",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "layout")
        return {
          stdout: JSON.stringify({
            result: {
              layout: {
                workspace_id: WORKSPACE,
                tab_id: "registered-tab",
                panes: [
                  { pane_id: "detail-pane", rect: { width: 100, height: 40 } },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "split") {
        splitCreated = true;
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator <= 0) continue;
          const key = assignment.slice(0, separator);
          const value = assignment.slice(separator + 1);
          if (key === "PI_HERDSMAN_RUN_ID") runId = value;
          if (key === "PI_HERDSMAN_OWNER_SESSION_ID") ownerSessionId = value;
        }
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "detail-pane" } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: "detail-pane",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  kind: "id",
                  value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          stdout: JSON.stringify({
            result: {
              process: {
                pane_id: "detail-pane",
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (
        args[0] === "pane" &&
        (args[1] === "run" || args[1] === "wait-output")
      ) {
        if (args[1] === "run") {
          const value = (key: string) =>
            new RegExp(`${key}='([^']*)'`).exec(args.at(-1) ?? "")?.[1];
          runId = value("PI_HERDSMAN_RUN_ID") ?? runId;
          ownerSessionId =
            value("PI_HERDSMAN_OWNER_SESSION_ID") ?? ownerSessionId;
        }
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isAgentList(args))
        return {
          stdout: (() => {
            const value = JSON.parse(listResponse(label));
            const alias = runScopedHerdrAlias(WORKSPACE, label, runId);
            value.agents[0].herdr_agent = alias;
            value.agents[0].name = alias;
            value.agents[0].pane_id = "detail-pane";
            value.agents[0].tab_id = "registered-tab";
            value.agents.push({
              herdr_kind: "pi",
              workspace_id: WORKSPACE,
              pane_id: "unmanaged-root-pane",
              cwd: "/tmp",
            });
            return JSON.stringify(value);
          })(),
          stderr: "",
          code: 0,
        };
      if (isPreservePaneStop(args))
        return {
          stdout: "",
          stderr: `error: preserved pane identity did not settle: {"pane_id":"detail-pane","workspace_id":"${WORKSPACE}"}`,
          code: 1,
        };
      writeWorkerState(mailbox, {
        version: 3,
        runId,
        ownerSessionId,
        workspaceId: WORKSPACE,
        workerLabel: label,
        paneId: "detail-pane",
        piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        piSessionFile: "/tmp/registered-worker.jsonl",
        cwd: "/tmp",
        updatedAt: Date.now(),
      });
      return {
        stdout: JSON.stringify({
          tab_id: "registered-tab",
          tab_label: "workers",
          pane_id: "detail-pane",
          cwd: "/tmp",
          herdr_agent: herdrAlias(label),
          created_tab: false,
          created_pane: true,
          agent: {
            name: args[2],
            pane_id: "detail-pane",
            tab_id: "registered-tab",
            workspace_id: WORKSPACE,
            cwd: "/tmp",
            agent_session: {
              kind: "id",
              value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            },
          },
          runtime_identity: {
            herdr_agent: herdrAlias(label),
            herdr_kind: "pi",
            agent_definition: null,
            model: null,
            thinking: null,
            cwd: "/tmp",
            resumed: false,
            session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            session_name: null,
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  });
  registerExtension!(pi.pi as never);
  const result = await pi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "worker",
      label,
      task: "rollback details",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.error.category, "rollback_failure");
  assert.equal(result.details.error.primary.category, "target_not_found");
  assert.match(result.details.error.primary.message, /integration|session/i);
  assert.equal(result.details.error.cleanup.category, "internal_failure");
  assert.equal(result.details.error.ids.label, label);
  assert.equal(result.details.error.ids.paneId, "detail-pane");
  assert.match(result.details.error.cleanup.message, /preserved pane identity/);
  assert.equal(
    pi.calls.some((args) => isPaneClose(args)),
    false,
  );
  assert.equal(readWorkerState(mailbox)?.workerLabel, label);
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
    ),
    true,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetWorkerMailbox(mailbox);
});

test("recovery requires the official session and retries one failed delivery", async (t) => {
  setLeadEnvironment();
  const label = "recovery-worker";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  writeFileSync(identity.piSessionFile, "{}", "utf8");
  resetWorkerMailbox(mailbox);
  const retryState = managedState(label, undefined, identity);
  retryState.completedRequestId = REQUEST_ID;
  writeWorkerState(mailbox, retryState);
  const scoutText = "scout discovered SECRET implementation details";
  const scoutPresentation = truncateModelText(scoutText, {
    keep: "head",
    sessionId: identity.piSessionId,
    key: REQUEST_ID,
    requestId: REQUEST_ID,
    persist: "completion",
  });
  assert.ok(scoutPresentation.resultPath);
  assert.equal(readFileSync(scoutPresentation.resultPath, "utf8"), scoutText);
  const result: ResultRecord = {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: label,
    paneId: identity.paneId,
    status: "completed",
    text: scoutText,
    completedAt: Date.now(),
  };
  writeResult(mailbox, result);
  const mismatch = fakePi({
    exec: leadExec(
      label,
      "working",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(mismatch.pi as never);
  await mismatch.events.get("session_start")![0](
    undefined,
    fakeContext(mismatch.entries),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mismatch.sent.length, 0);
  mismatch.events.get("session_shutdown")?.[0]();

  resetWorkerMailbox(mailbox);
  const removalState = managedState(label, undefined, identity);
  removalState.completedRequestId = REQUEST_ID;
  writeWorkerState(mailbox, removalState);
  writeResult(mailbox, result);
  const lifecycle = cascadeExecutor([removalState]);
  let attempts = 0;
  let delivered = "";
  let deliveredDetails: any;
  const transientFailures = 5;
  let successful = 0;
  const entries: unknown[] = [];
  const recovering = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") {
        delivered = String((message as any).content ?? "");
        deliveredDetails = (message as any).details;
        attempts++;
        if (attempts <= transientFailures) throw new Error("transient");
        successful++;
        entries.push({
          customType: "pi-herdsman-worker-result",
          details: resultEntryDetails(removalState, REQUEST_ID),
        });
      } else entries.push(message);
    },
  });
  registerExtension!(recovering.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await recovering.events.get("session_start")![0](
    undefined,
    fakeContext(entries),
  );
  assert.equal(attempts, 1);
  assert.ok(
    readResult(mailbox, REQUEST_ID),
    "a rejected send must retain the durable result for retry",
  );
  for (let index = 0; index < transientFailures; index++) {
    t.mock.timers.tick(250);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(attempts, index + 2);
  }
  assert.equal(attempts, transientFailures + 1);
  assert.equal(successful, 1);
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recovering.sentUsers.length, 0);
  assert.match(
    delivered,
    new RegExp(`Result file: ${scoutPresentation.resultPath}`),
  );
  assert.match(
    delivered,
    new RegExp(
      `^Worker result · worker=${label} · definition=worker · session=${identity.piSessionId} · request=${REQUEST_ID} · status=completed`,
    ),
  );
  assert.equal(deliveredDetails.workerLabel, label);
  assert.equal(deliveredDetails.agentDefinition, "worker");
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  assert.deepEqual(lifecycle.closeOrder, [label]);
  recovering.events.get("session_shutdown")?.[0]();
  t.mock.timers.reset();
  realFs.rmSync(identity.piSessionFile, { force: true });
});

test("completed and failed one-shot workers converge after durable delivery", async (t) => {
  setLeadEnvironment();
  const children = [
    ["converge-child-one", REQUEST_ID],
    ["converge-child-two", randomUUID()],
  ].map(([label, requestId], index) => {
    const identity = recoveryIdentity(label);
    if (index === 1)
      identity.piSessionId = "11111111-1111-4111-8111-111111111111";
    return {
      ...managedState(label, undefined, identity),
      completedRequestId: requestId,
    };
  });
  const mailboxes = children.map((child) =>
    workerMailboxPath(WORKSPACE, child.workerLabel),
  );
  for (const [index, [child, mailbox]] of children
    .map((child, index) => [child, mailboxes[index]] as const)
    .entries()) {
    resetWorkerMailbox(mailbox);
    writeWorkerState(mailbox, child);
    writeResult(mailbox, {
      version: 3,
      runId: child.runId,
      requestId: child.completedRequestId!,
      ownerSessionId: child.ownerSessionId,
      workspaceId: child.workspaceId,
      workerLabel: child.workerLabel,
      paneId: child.paneId,
      status: index === 0 ? "completed" : "failed",
      ...(index === 0
        ? { text: child.workerLabel }
        : {
            error: {
              code: "empty_result" as const,
              message: "worker returned no result",
            },
          }),
      completedAt: Date.now(),
    });
  }
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-worker-result",
      details: resultEntryDetails(children[0], children[0].completedRequestId!),
    },
  ];
  const lifecycle = cascadeExecutor(children);
  let deliveries = 0;
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result")
        deliveries++;
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1);
    assert.deepEqual(lifecycle.closeOrder, [children[0].workerLabel]);
    assert.ok(readResult(mailboxes[1], children[1].completedRequestId!));

    entries.push({
      customType: "pi-herdsman-worker-result",
      details: resultEntryDetails(children[1], children[1].completedRequestId!),
    });
    t.mock.timers.tick(1000);
    for (let index = 0; index < 10; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(
      new Set(lifecycle.closeOrder),
      new Set(children.map((child) => child.workerLabel)),
      JSON.stringify({
        live: [...lifecycle.live.keys()],
        states: mailboxes.map((mailbox) => readWorkerState(mailbox)),
        results: children.map((child, index) =>
          readResult(mailboxes[index], child.completedRequestId!),
        ),
      }),
    );
    for (const mailbox of mailboxes)
      assert.equal(readWorkerState(mailbox), undefined);
    assert.equal(deliveries, 1);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetWorkerMailbox(mailbox);
  }
});

test("one-shot close failure retains the result for exact cleanup retry", async (t) => {
  setLeadEnvironment();
  const label = "close-retry-child";
  const child = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, child);
  writeResult(mailbox, {
    version: 3,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    workerLabel: child.workerLabel,
    paneId: child.paneId,
    status: "completed",
    text: "retry close",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const lifecycle = cascadeExecutor([child]);
  let failClose = true;
  let deliveries = 0;
  const pi = fakePi({
    entries,
    exec: (command, args) => {
      if (failClose && isPaneClose(args)) {
        failClose = false;
        return { stdout: "{}", stderr: "close failed", code: 1 };
      }
      return lifecycle.exec(command, args);
    },
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") {
        deliveries++;
        entries.push({
          customType: "pi-herdsman-worker-result",
          details: resultEntryDetails(child, REQUEST_ID),
        });
      }
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1);
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readResult(mailbox, REQUEST_ID));

    for (let index = 0; index < 4; index++) {
      t.mock.timers.tick(250);
      for (let flush = 0; flush < 10; flush++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(deliveries, 1);
    assert.deepEqual(lifecycle.closeOrder, [label]);
    assert.equal(readWorkerState(mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(mailbox);
  }
});

test("recovery redelivers an unpersisted child result and then cleans it safely", async () => {
  setLeadEnvironment();
  const child = {
    ...managedState(
      "reload-result-child",
      undefined,
      recoveryIdentity("reload-result-child"),
    ),
    completedRequestId: REQUEST_ID,
  };
  const sibling = {
    ...managedState(
      "reload-result-sibling",
      randomUUID(),
      recoveryIdentity("reload-result-sibling"),
    ),
  };
  const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
  const siblingMailbox = workerMailboxPath(WORKSPACE, sibling.workerLabel);
  resetWorkerMailbox(childMailbox);
  resetWorkerMailbox(siblingMailbox);
  writeWorkerState(childMailbox, child);
  writeWorkerState(siblingMailbox, sibling);
  const result: ResultRecord = {
    version: 3,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    workerLabel: child.workerLabel,
    paneId: child.paneId,
    status: "completed",
    text: "durable child result",
    completedAt: Date.now(),
  };
  writeResult(childMailbox, result);
  const lifecycle = cascadeExecutor([child, sibling]);
  const firstEntries: unknown[] = [];
  let queued = 0;
  const first = fakePi({
    entries: firstEntries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") queued++;
      else firstEntries.push(message);
    },
  });
  registerExtension!(first.pi as never);
  try {
    await first.events.get("session_start")![0](
      undefined,
      fakeContext(firstEntries),
    );
    assert.equal(queued, 1);
    assert.ok(
      readResult(childMailbox, REQUEST_ID),
      "an accepted but not-yet-persisted message must retain its result file",
    );
  } finally {
    first.events.get("session_shutdown")?.[0]();
  }
  lifecycle.live.delete(child.workerLabel);

  const recoveredEntries: unknown[] = [];
  let redeliveries = 0;
  const recovered = fakePi({
    entries: recoveredEntries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") {
        redeliveries++;
        recoveredEntries.push({
          message: {
            role: "custom",
            customType: "pi-herdsman-worker-result",
            details: (message as any).details,
          },
        });
      } else recoveredEntries.push(message);
    },
  });
  registerExtension!(recovered.pi as never);
  const context = fakeContext(recoveredEntries);
  try {
    await recovered.events.get("session_start")![0](undefined, context);
    assert.equal(redeliveries, 1);
    assert.equal(
      recoveredEntries.filter(
        (entry: any) =>
          entry.message?.customType === "pi-herdsman-worker-result" &&
          entry.message.details?.requestId === REQUEST_ID,
      ).length,
      1,
    );
    assert.equal(
      recovered.sentMessageCalls.filter(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .unresolvedDirectChildCount,
      1,
    );
    assert.match(
      String((recovered.sentMessageCalls[0]?.message as any).content),
      /Delegation status: 1 active direct worker; 0 pending direct results; 1 direct worker assignment remains unresolved\./,
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .activeDirectChildCount,
      1,
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .pendingDirectResultCount,
      0,
    );
    assert.equal(readResult(childMailbox, REQUEST_ID), undefined);

    writeResult(childMailbox, result);
    await recovered.events.get("session_start")![0](undefined, context);
    assert.equal(
      redeliveries,
      1,
      "an existing persisted result entry must deduplicate replay",
    );
    assert.equal(readResult(childMailbox, REQUEST_ID), undefined);
  } finally {
    recovered.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(childMailbox);
    resetWorkerMailbox(siblingMailbox);
  }
});

test("recovered no-live result removal retry never cleans up a replacement", async (t) => {
  setLeadEnvironment();
  const label = "no-live-removal-retry-worker";
  const identity = recoveryIdentity(label);
  const state = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, state);
  writeResult(mailbox, {
    version: 3,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    workerLabel: state.workerLabel,
    paneId: state.paneId,
    status: "completed",
    text: "no live worker",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([]);
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      entries.push({
        customType: "pi-herdsman-worker-result",
        details: (message as any).details,
      });
    },
  });
  const replacement = {
    ...state,
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    paneId: `${label}-replacement-pane`,
    piSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    piSessionFile: `/tmp/${label}-replacement.jsonl`,
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const removalAttemptsBefore = support.resultRemovalAttempts;
  support.failNextResultRemoval = true;
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(support.failNextResultRemoval, false);
    assert.equal(support.resultRemovalAttempts, removalAttemptsBefore + 1);
    assert.equal(readResult(mailbox, REQUEST_ID)?.runId, state.runId);
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_cleanup_error" &&
          /injected result removal failure/.test(String(entry.data?.error)),
      ),
      "the initial removal must fail before the retry is exercised",
    );

    const callsBeforeRetry = pi.calls.length;
    lifecycle.live.set(label, replacement);
    assert.notEqual(replacement.runId, state.runId);
    assert.notEqual(replacement.paneId, state.paneId);
    assert.notEqual(replacement.piSessionId, state.piSessionId);
    assert.deepEqual(readWorkerState(mailbox), state);
    t.mock.timers.tick(250);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.deepEqual(
      pi.calls
        .slice(callsBeforeRetry)
        .filter(
          (args) =>
            isAgentList(args) ||
            isPaneList(args) ||
            isPaneClose(args) ||
            isPreservePaneStop(args) ||
            isHerdrList(args),
        ),
      [],
      "no-live retry must not inspect or clean up the replacement",
    );
    const listed = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(listed.details.cleanup_errors, undefined);
    const callsAfterRetry = pi.calls.length;
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(pi.calls.length, callsAfterRetry);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  } finally {
    support.failNextResultRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(mailbox);
  }
});

test("controller reply submits the normal request and preserves the assignment", async () => {
  setLeadEnvironment();
  const label = "reply-controller-worker";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  const waiting = {
    ...managedState(label, REQUEST_ID, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeWorkerState(mailbox, waiting);
  writeAsk(mailbox, {
    version: 3,
    askId: waiting.pendingAskId!,
    requestId: REQUEST_ID,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    workerLabel: waiting.workerLabel,
    paneId: waiting.paneId,
    piSessionId: waiting.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  });
  const replyFile = join("/tmp", `${label}-decision.md`);
  realFs.writeFileSync(replyFile, "decision evidence");
  let submitted: RequestRecord | undefined;
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_WORKER_V3__:".length);
        submitted = readRequest(requestMailbox, requestId);
        const current = readWorkerState(requestMailbox)!;
        writeWorkerState(requestMailbox, {
          ...current,
          ...(submitted?.kind === "reply" ? { pendingAskId: undefined } : {}),
          lastAck: {
            requestId,
            accepted: true,
            acknowledgedAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
        if (submitted?.kind === "reply") removeAsk(requestMailbox);
      },
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  const waitingList = await pi.tools[0].execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(waitingList.details.workers[0].available_actions, [
    "inspect",
    "reply",
    "close",
  ]);
  const result = await pi.tools[0].execute(
    "reply",
    {
      action: "reply",
      worker: label,
      message: "Use ALPHA.",
      files: [replyFile],
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.details.action, "reply");
  assert.doesNotMatch((result.content[0] as { text: string }).text, /Next:/);
  assert.equal(result.terminate, undefined);
  assert.equal(submitted?.kind, "reply");
  assert.equal(submitted?.askId, waiting.pendingAskId);
  assert.match(submitted?.text ?? "", /decision evidence/);
  assert.equal(submitted?.requestId, result.details.request_id);
  assert.notEqual(result.details.request_id, REQUEST_ID);
  assert.equal(result.details.ask_id, waiting.pendingAskId);
  assert.equal(result.details.assignment_request_id, REQUEST_ID);
  assert.equal(result.details.session_id, identity.piSessionId);
  assert.equal(result.details.truncated, false);
  assert.match((result.content[0] as { text: string }).text, /Request: /);
  assert.ok(
    (result.content[0] as { text: string }).text.includes(
      `Ask: ${waiting.pendingAskId}`,
    ),
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Assignment request: /,
  );
  const rendered = pi.tools[0].renderResult(
    { content: result.content, details: result.details },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text },
    { args: { action: "reply", worker: label, message: "Use ALPHA." } },
  );
  assert.match(
    rendered.text,
    new RegExp(`Request: ${result.details.request_id}`),
  );
  assert.match(rendered.text, new RegExp(`Ask: ${waiting.pendingAskId}`));
  assert.match(rendered.text, new RegExp(`Session: ${identity.piSessionId}`));
  assert.match(rendered.text, /Assignment request: /);
  assert.equal(readWorkerState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.equal(readWorkerState(mailbox)?.pendingAskId, undefined);
  assert.equal(readRequest(mailbox, submitted!.requestId), undefined);
  const afterReply = await pi.tools[0].execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(afterReply.details.workers[0].available_actions, [
    "inspect",
    "steer",
    "close",
  ]);
  const missingAsk = await pi.tools[0].execute(
    "reply-without-ask",
    { action: "reply", worker: label, message: "No question is pending." },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(missingAsk.details.error.category, "worker_busy");
  assert.match(
    missingAsk.details.error.nextAction,
    /Use reply only for an outstanding ask_owner question/,
  );
  resetWorkerMailbox(mailbox);
  realFs.rmSync(replyFile, { force: true });
});

test("lead recovery integration validation aborts with session shutdown", async () => {
  setLeadEnvironment();
  const label = "signal-recovery-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, managedState(label));
  let integrationSignal: AbortSignal | undefined;
  let integrationAborted = false;
  const recovery = fakePi({
    exec: async (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: listResponse(label, "working"),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        integrationSignal = options?.signal;
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            integrationAborted = true;
            resolve();
            return;
          }
          options?.signal?.addEventListener(
            "abort",
            () => {
              integrationAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      }
      return {
        stdout: JSON.stringify({
          result: {
            agent: {
              name: herdrAlias(label),
              pane_id: "registered-pane",
              workspace_id: WORKSPACE,
              cwd: "/tmp",
              agent_session: {
                kind: "id",
                value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              },
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  });
  registerExtension!(recovery.pi as never);
  const pending = recovery.events.get("session_start")![0](
    undefined,
    fakeContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(integrationSignal);
  assert.equal(integrationSignal?.aborted, false);
  recovery.events.get("session_shutdown")?.[0]();
  await pending;
  assert.equal(integrationSignal?.aborted, true);
  assert.equal(integrationAborted, true);
});

test("parent close cascades child-first and reports a structured child failure", async () => {
  for (const failed of [false, true]) {
    setLeadEnvironment();
    const parent = {
      ...managedState(
        "cascade-parent",
        undefined,
        recoveryIdentity("cascade-parent"),
      ),
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: "/tmp/cascade-parent.jsonl",
    };
    const child = {
      ...managedState(
        "cascade-child",
        undefined,
        recoveryIdentity("cascade-child"),
      ),
      ownerSessionId: parent.piSessionId,
      piSessionId: CHILD_SESSION_ID,
      piSessionFile: "/tmp/cascade-child.jsonl",
    };
    const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
    const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(childMailbox);
    writeWorkerState(parentMailbox, parent);
    writeWorkerState(childMailbox, child);
    const lifecycle = cascadeExecutor([parent, child], {
      failCloseLabel: failed ? child.workerLabel : undefined,
    });
    const pi = fakePi({
      exec: (command, args, options) => {
        const result = lifecycle.exec(command, args, options);
        if (command === "herdr" && isAgentList(args)) {
          const value = JSON.parse(result.stdout);
          const envelope = value.result ?? value;
          envelope.agents.push({
            herdr_kind: "pi",
            workspace_id: WORKSPACE,
            pane_id: "unmanaged-root-pane",
            cwd: "/tmp",
          });
          return { ...result, stdout: JSON.stringify(value) };
        }
        return result;
      },
    });
    registerExtension!(pi.pi as never);
    try {
      const result = await pi.tools[0].execute(
        "id",
        { action: "close", worker: parent.workerLabel },
        undefined,
        undefined,
        fakeContext(),
      );
      if (!failed) {
        assert.equal(result.details.ok, true);
        assert.equal(result.details.action, "close");
        assert.equal(result.details.worker, parent.workerLabel);
        assert.equal(result.details.truncated, false);
        assert.ok(
          (result.content[0] as { text: string }).text.includes(
            `Close worker ${parent.workerLabel}.`,
          ),
        );
        const rendered = pi.tools[0].renderResult(
          { content: result.content, details: result.details },
          { expanded: true, isPartial: false },
          { fg: (_color: string, text: string) => text },
          { args: { action: "close", worker: parent.workerLabel } },
        );
        assert.match(
          rendered.text,
          new RegExp(`Close worker ${parent.workerLabel}\\.`),
        );
        assert.deepEqual(lifecycle.closeOrder, [
          child.workerLabel,
          parent.workerLabel,
        ]);
        assert.equal(readWorkerState(parentMailbox), undefined);
        assert.equal(readWorkerState(childMailbox), undefined);
      } else {
        assert.equal(result.details.error.category, "internal_failure");
        assert.equal(result.details.error.ids.label, child.workerLabel);
        assert.equal(
          result.details.error.details.parentLabel,
          parent.workerLabel,
        );
        assert.deepEqual(lifecycle.closeOrder, []);
        assert.ok(readWorkerState(parentMailbox));
        assert.ok(readWorkerState(childMailbox));
      }
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetWorkerMailbox(parentMailbox);
      resetWorkerMailbox(childMailbox);
    }
  }
});

test("close returns a structured nonfatal mailbox cleanup warning", async () => {
  setLeadEnvironment();
  const parent = managedState(
    "cleanup-warning-parent",
    undefined,
    recoveryIdentity("cleanup-warning-parent"),
  );
  const mailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, parent);
  realFs.mkdirSync(join(mailbox, "stubborn"));
  const lifecycle = cascadeExecutor([parent]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", worker: parent.workerLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true);
    assert.match(result.details.cleanup_error, /mailbox cleanup failed/);
    assert.match(
      result.details.cleanup_errors[parent.workerLabel],
      /mailbox cleanup failed/,
    );
    assert.deepEqual(lifecycle.closeOrder, [parent.workerLabel]);
    assert.equal(readWorkerState(mailbox), undefined);
    assert.ok(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
  }
});

test("lead orphan recovery requires parent pane absence and recovers only the proven child", async () => {
  for (const parentPresent of [false, true]) {
    setLeadEnvironment();
    const parent = {
      ...managedState(
        "orphan-parent",
        undefined,
        recoveryIdentity("orphan-parent"),
      ),
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: "/tmp/orphan-parent.jsonl",
    };
    const child = {
      ...managedState(
        "orphan-child",
        undefined,
        recoveryIdentity("orphan-child"),
      ),
      ownerSessionId: parent.piSessionId,
      piSessionId: CHILD_SESSION_ID,
      piSessionFile: "/tmp/orphan-child.jsonl",
    };
    const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
    const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(childMailbox);
    writeWorkerState(parentMailbox, parent);
    writeWorkerState(childMailbox, child);
    const lifecycle = cascadeExecutor(
      parentPresent ? [parent, child] : [child],
      parentPresent ? { omitAgentLabels: [parent.workerLabel] } : {},
    );
    const pi = fakePi({ exec: lifecycle.exec });
    registerExtension!(pi.pi as never);
    try {
      const listed = await pi.tools[0].execute(
        "id",
        { action: "list" },
        undefined,
        undefined,
        fakeContext(),
      );
      const listedChild = (listed.details.workers as any[]).find(
        (worker) => worker.worker === child.workerLabel,
      );
      if (parentPresent) {
        assert.equal(listedChild, undefined);
      } else {
        assert.equal(listedChild?.orphan, true);
        assert.deepEqual(listedChild?.available_actions, ["close"]);
      }
      const result = await pi.tools[0].execute(
        "id",
        { action: "close", worker: child.workerLabel },
        undefined,
        undefined,
        fakeContext(),
      );
      if (parentPresent) {
        assert.equal(result.details.error.category, "target_not_found");
        assert.match(
          result.details.error.message,
          /orphan recovery is refused/,
        );
        assert.deepEqual(lifecycle.closeOrder, []);
        assert.ok(readWorkerState(childMailbox));
      } else {
        assert.equal(result.details.ok, true, JSON.stringify(result.details));
        assert.deepEqual(lifecycle.closeOrder, [child.workerLabel]);
        assert.equal(readWorkerState(childMailbox), undefined);
        assert.ok(readWorkerState(parentMailbox));
      }
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetWorkerMailbox(parentMailbox);
      resetWorkerMailbox(childMailbox);
    }
  }
});

test("lead cannot mutate a child owned by a live parent", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "owned-parent",
      undefined,
      recoveryIdentity("owned-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/owned-parent.jsonl",
  };
  const child = {
    ...managedState("owned-child", undefined, recoveryIdentity("owned-child")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/owned-child.jsonl",
  };
  const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
  const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
  resetWorkerMailbox(parentMailbox);
  resetWorkerMailbox(childMailbox);
  writeWorkerState(parentMailbox, parent);
  writeWorkerState(childMailbox, child);
  const lifecycle = cascadeExecutor([parent, child]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", worker: child.workerLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
    assert.ok(readWorkerState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(childMailbox);
  }
});

test("manual close omits malformed and absent workers", async () => {
  setLeadEnvironment();
  const label = "close-worker";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  const pi = fakePi({
    exec: leadExec(
      label,
      "idle",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  writeWorkerState(mailbox, managedState(label, undefined, identity));
  await pi.events.get("session_start")![0](undefined, fakeContext());
  writeFileSync(join(mailbox, "state.json"), "{malformed", "utf8");
  const tool = pi.tools[0];
  const malformed = await tool.execute(
    "id",
    { action: "close", worker: label },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(malformed.details.error.category, "target_not_found");
  resetWorkerMailbox(mailbox);
  const absent = await tool.execute(
    "id",
    { action: "close", worker: label },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(absent.details.error.category, "target_not_found");
  pi.events.get("session_shutdown")?.[0]();
});

test("result cleanup retains durable delivery across worker identity changes", async () => {
  setLeadEnvironment();
  const label = "identity-change-result-worker";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  const initial = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const changed = {
    ...initial,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/identity-change-result-worker.jsonl",
  };
  resetWorkerMailbox(mailbox);
  writeWorkerState(mailbox, initial);
  writeResult(mailbox, {
    version: 3,
    runId: initial.runId,
    requestId: REQUEST_ID,
    ownerSessionId: initial.ownerSessionId,
    workspaceId: initial.workspaceId,
    workerLabel: initial.workerLabel,
    paneId: initial.paneId,
    status: "completed",
    text: "retain this result",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const lifecycle = cascadeExecutor([initial]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") {
        entries.push({
          customType: "pi-herdsman-worker-result",
          details: resultEntryDetails(initial, REQUEST_ID),
        });
        writeWorkerState(mailbox, changed);
      } else entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-worker-result",
      ).length,
      1,
    );
    assert.ok(
      readResult(mailbox, REQUEST_ID),
      "changed worker identity must retain the durable result",
    );
    assert.deepEqual(lifecycle.closeOrder, []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(mailbox);
  }
});

test("delivered result remains while worker state is active", async () => {
  setLeadEnvironment();
  const label = "active-result-anchor-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  const parent = {
    ...managedState("active-result-anchor-parent"),
    piSessionId: LEAD_SESSION_ID,
  };
  const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
  resetWorkerMailbox(mailbox);
  resetWorkerMailbox(parentMailbox);
  writeWorkerState(parentMailbox, parent);
  const activeState = managedState(label, REQUEST_ID);
  writeWorkerState(mailbox, activeState);
  writeResult(mailbox, {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: label,
    paneId: "registered-pane",
    status: "completed",
    text: "anchor",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: leadExec(label, "working", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    sendMessage: () => {
      entries.push({
        customType: "pi-herdsman-worker-result",
        details: resultEntryDetails(activeState, REQUEST_ID),
      });
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(readResult(mailbox, REQUEST_ID));
    assert.equal(
      pi.sentMessageCalls.filter(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
    );
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      pi.sentMessageCalls.filter(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(mailbox);
  }
});

test("accepted result delivery survives session identity failure in status guidance", async (t) => {
  setLeadEnvironment();
  const label = "status-identity-failure-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  const parent = {
    ...managedState("status-identity-failure-parent"),
    piSessionId: LEAD_SESSION_ID,
  };
  const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
  resetWorkerMailbox(mailbox);
  resetWorkerMailbox(parentMailbox);
  writeWorkerState(parentMailbox, parent);
  const resultState = {
    ...managedState(label),
    completedRequestId: REQUEST_ID,
  };
  writeWorkerState(mailbox, resultState);
  writeResult(mailbox, {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: label,
    paneId: "registered-pane",
    status: "completed",
    text: "accepted before status failure",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const context = fakeContext(entries);
  let identityLookupFailed = false;
  context.sessionManager.getSessionId = () => {
    if (identityLookupFailed) throw new Error("session identity unavailable");
    return LEAD_SESSION_ID;
  };
  let resultAttempts = 0;
  const pi = fakePi({
    entries,
    exec: leadExec(label, "working", DEFAULT_PI_SESSION_ID),
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result") {
        resultAttempts++;
        entries.push({
          customType: "pi-herdsman-worker-result",
          details: resultEntryDetails(resultState, REQUEST_ID),
        });
        identityLookupFailed = true;
      } else entries.push(message);
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resultAttempts, 1);
    assert.equal((pi.sent[0] as any).details.status, "completed");
    assert.ok(readResult(mailbox, REQUEST_ID));

    t.mock.timers.tick(250);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resultAttempts, 1);
    assert.equal(
      pi.sent.some(
        (message: any) =>
          message.customType === "pi-herdsman-worker-result" &&
          message.details?.status === "failed",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(mailbox);
  }
});

test("result is removed after worker state reaches completed", async () => {
  setLeadEnvironment();
  const label = "completed-result-anchor-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  const activeState = managedState(label, REQUEST_ID);
  writeWorkerState(mailbox, activeState);
  writeResult(mailbox, {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: label,
    paneId: "registered-pane",
    status: "completed",
    text: "complete",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const lifecycle = cascadeExecutor([activeState]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: () => {
      entries.push({
        customType: "pi-herdsman-worker-result",
        details: resultEntryDetails(activeState, REQUEST_ID),
      });
    },
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const completed = managedState(label);
  completed.completedRequestId = REQUEST_ID;
  writeWorkerState(mailbox, completed);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  assert.deepEqual(lifecycle.closeOrder, [label]);
  pi.events.get("session_shutdown")?.[0]();
});

test("automatic close invokes the exact lifecycle only after live identity proof", async () => {
  setLeadEnvironment();
  const label = "automatic-close-worker";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  const resultState = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  writeWorkerState(mailbox, resultState);
  writeResult(mailbox, {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: label,
    paneId: identity.paneId,
    status: "completed",
    text: "close me",
    completedAt: Date.now(),
  });
  let live = true;
  let closeCalls = 0;
  let closeArgs: string[] | undefined;
  const entries: unknown[] = [];
  const emptyList = () => {
    const value = JSON.parse(
      listResponse(label, "working", identity.piSessionId, identity),
    );
    value.agents = [];
    return JSON.stringify(value);
  };
  const pi = fakePi({
    entries,
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "tab" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [{ tab_id: identity.tabId, workspace_id: WORKSPACE }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "pane" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              panes: live
                ? [{ pane_id: identity.paneId, workspace_id: WORKSPACE }]
                : [],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                tab_id: identity.tabId,
                cwd: "/tmp",
                agent_session: {
                  kind: "id",
                  value: identity.piSessionId,
                },
              },
            },
          }),
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
            result: {
              process: {
                pane_id: identity.paneId,
                shell_pid: 10,
                foreground_process_group_id: 20,
                foreground_processes: [{ pid: 20, argv0: "/usr/bin/pi" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "pane" && args[1] === "close") {
        closeCalls++;
        closeArgs = args;
        live = false;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: live
            ? listResponse(label, "working", identity.piSessionId, identity)
            : emptyList(),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                name: runScopedHerdrAlias(WORKSPACE, label, WORKER_ID),
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  kind: "id",
                  value: identity.piSessionId,
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
    sendMessage: () => {
      entries.push({
        customType: "pi-herdsman-worker-result",
        details: resultEntryDetails(resultState, REQUEST_ID),
      });
    },
  });
  realFs.mkdirSync(PI_AGENTS_DIR, { recursive: true });
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "automatic-close-test.md"),
    "---\nname: automatic-close-test\n---\nworker\n",
    "utf8",
  );
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(closeCalls, 1);
    assert.equal(closeArgs?.[2], identity.paneId);
    assert.equal(readWorkerState(mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.unlinkSync(join(PI_AGENTS_DIR, "automatic-close-test.md"));
  }
});

test("managed child automatic cleanup respects the parent delegation lock", async () => {
  setWorkerEnvironment("cleanup-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("cleanup-parent");
  const child = {
    ...managedState(
      "cleanup-child",
      undefined,
      recoveryIdentity("cleanup-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/cleanup-child.jsonl",
    completedRequestId: REQUEST_ID,
  };
  const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
  const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
  resetWorkerMailbox(parentMailbox);
  resetWorkerMailbox(childMailbox);
  writeWorkerState(parentMailbox, parent);
  writeWorkerState(childMailbox, child);
  writeResult(childMailbox, {
    version: 3,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    workerLabel: child.workerLabel,
    paneId: child.paneId,
    status: "completed",
    text: "close the child",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "parent" },
    },
  ];
  const lifecycle = delegatedLifecycleExecutor(parent, [child]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-worker-result")
        entries.push({
          customType: "pi-herdsman-worker-result",
          details: (message as any).details,
        });
    },
  });
  const release = claimProcessLock(
    delegationLockPathForTest(WORKSPACE, parent.piSessionId),
    {
      name: "test delegation lifecycle",
    },
  );
  const context = fakeWorkerContext(entries);
  try {
    registerExtension!(pi.pi as never);
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readWorkerState(childMailbox));
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_cleanup_error" &&
          String(entry.data?.error).includes("Delegation lifecycle"),
      ),
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    release();
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(childMailbox);
  }
});

test("manual close retains ownership when live session identity is missing or wrong", async () => {
  for (const liveSession of [null, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]) {
    setLeadEnvironment();
    const label = liveSession ? "wrong-session-close" : "missing-session-close";
    const mailbox = workerMailboxPath(WORKSPACE, label);
    resetWorkerMailbox(mailbox);
    writeWorkerState(mailbox, managedState(label));
    const pi = fakePi({
      exec: leadExec(
        label,
        "idle",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        undefined,
        liveSession,
      ),
    });
    registerExtension!(pi.pi as never);
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", worker: label },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_not_found");
    assert.ok(readWorkerState(mailbox));
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("stale scanner starts immediately, reschedules, deduplicates, and retries failed publication", async (t) => {
  setLeadEnvironment();
  const label = "scanner-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  const staleAt = Date.now() - 10 * 60_000 - 1_000;
  writeWorkerState(mailbox, {
    ...managedState(label, REQUEST_ID, defaultFixtureIdentity),
    lastActivityAt: staleAt,
  });
  let attempts = 0;
  const pi = fakePi({
    exec: leadExec(label, "working", DEFAULT_PI_SESSION_ID),
    sendMessage: () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
    },
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(attempts, 1, "the controller performs an immediate scan");

  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "a failed advisory is retried on the next scan");
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "a successful episode is deduplicated");

  writeWorkerState(mailbox, {
    ...readWorkerState(mailbox)!,
    lastActivityAt: Date.now(),
    updatedAt: Date.now(),
  });
  writeWorkerState(mailbox, {
    ...readWorkerState(mailbox)!,
    lastActivityAt: Date.now() - 10 * 60_000 - 1_000,
    updatedAt: Date.now(),
  });
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    attempts,
    3,
    "a changed activity timestamp starts a new episode",
  );
  pi.events.get("session_shutdown")?.[0]();
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 3, "shutdown removes the recurring scanner");
});

test("stale scanner skips completion or identity changes before publication", async () => {
  setLeadEnvironment();
  const label = "scanner-race-worker";
  const mailbox = workerMailboxPath(WORKSPACE, label);
  writeWorkerState(mailbox, {
    ...managedState(label, REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  });
  let resolveList!: () => void;
  const listPending = new Promise<void>((resolve) => (resolveList = resolve));
  let sendCount = 0;
  const pi = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "list") {
        await listPending;
        return {
          stdout: listResponse(label, "working"),
          stderr: "",
          code: 0,
        };
      }
      return leadExec(label, "working", DEFAULT_PI_SESSION_ID)(command, args);
    },
    sendMessage: () => {
      sendCount++;
    },
  });
  registerExtension!(pi.pi as never);
  const startup = pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  writeWorkerState(mailbox, {
    ...readWorkerState(mailbox)!,
    activeRequestId: undefined,
    completedRequestId: REQUEST_ID,
  });
  resolveList();
  await startup;
  await Promise.resolve();
  assert.equal(sendCount, 0, "completion invalidates the pending advisory");
  pi.events.get("session_shutdown")?.[0]();
});

test("stale scanner skips every replaced identity field before publication", async () => {
  for (const field of [
    "runId",
    "ownerSessionId",
    "workspaceId",
    "workerLabel",
    "paneId",
    "piSessionId",
  ] as const) {
    setLeadEnvironment();
    const label = `identity-race-${field}`;
    const mailbox = workerMailboxPath(WORKSPACE, label);
    writeWorkerState(mailbox, {
      ...managedState(label, REQUEST_ID),
      lastActivityAt: Date.now() - 11 * 60_000,
    });
    let resolveList!: () => void;
    const pending = new Promise<void>((resolve) => (resolveList = resolve));
    let sends = 0;
    const pi = fakePi({
      exec: async (command, args) => {
        if (command === "herdr" && args[0] === "agent" && args[1] === "list") {
          await pending;
          return {
            stdout: listResponse(label, "working"),
            stderr: "",
            code: 0,
          };
        }
        return leadExec(label, "working", DEFAULT_PI_SESSION_ID)(command, args);
      },
      sendMessage: () => {
        sends++;
      },
    });
    registerExtension!(pi.pi as never);
    const startup = pi.events.get("session_start")![0](
      undefined,
      fakeContext(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const replacements = {
      runId: "99999999-9999-4999-8999-999999999999",
      ownerSessionId: "88888888-8888-4888-8888-888888888888",
      workspaceId: `${WORKSPACE}-replacement`,
      workerLabel: `${label}-replacement`,
      paneId: "replacement-pane",
      piSessionId: "77777777-7777-4777-8777-777777777777",
    };
    const replacement = {
      ...readWorkerState(mailbox)!,
      [field]: replacements[field],
    };
    writeWorkerState(mailbox, replacement);
    resolveList();
    await startup;
    assert.equal(sends, 0, field);
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("delegation parent notifies only its direct stale child", async () => {
  setWorkerEnvironment("stale-parent", ["worker"]);
  const parent = managedState("stale-parent");
  const child = {
    ...managedState("stale-child", REQUEST_ID, recoveryIdentity("stale-child")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const unrelated = {
    ...managedState(
      "unrelated-child",
      REQUEST_ID,
      recoveryIdentity("unrelated-child"),
    ),
    ownerSessionId: PARENT_SESSION_ID,
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  for (const state of [parent, child, unrelated])
    writeWorkerState(workerMailboxPath(WORKSPACE, state.workerLabel), state);
  nativeSessions.set(parent.piSessionFile!, {
    id: parent.piSessionId!,
    path: parent.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-worker-definition",
        data: { name: "parent" },
      },
    ],
  });
  nativeSessions.set(child.piSessionFile!, {
    id: child.piSessionId!,
    path: child.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-worker-definition",
        data: { name: "worker" },
      },
    ],
  });
  nativeSessions.set(unrelated.piSessionFile!, {
    id: unrelated.piSessionId!,
    path: unrelated.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-worker-definition",
        data: { name: "worker" },
      },
    ],
  });
  const sent: unknown[] = [];
  process.env.PI_HERDSMAN_RUN_ID = parent.runId;
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = LEAD_SESSION_ID;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parentPi = fakePi({
    exec: workerControllerExecutor(parent, [child, unrelated]),
    sendMessage: (message) => sent.push(message),
  });
  registerExtension!(parentPi.pi as never);
  const parentContext = fakeWorkerContext([
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "parent" },
    },
  ]);
  for (const handler of parentPi.events.get("session_start") ?? [])
    await handler(undefined, parentContext);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    sent.length,
    1,
    `parent publishes one direct-child advisory: ${JSON.stringify(parentPi.calls)}`,
  );
  const advisory = sent[0] as any;
  assert.equal(advisory.customType, "pi-herdsman-worker-stale");
  assert.match(
    advisory.content,
    /Worker stale-child has had no observed Pi activity/,
  );
  assert.match(advisory.content, /not proof of a hang/);
  assert.match(advisory.content, /safe to leave the worker running/);
  assert.match(advisory.content, /only when task evidence justifies it/);
  assert.match(advisory.content, /do not close solely because of inactivity/);
  assert.equal(advisory.details.workerLabel, child.workerLabel);
  assert.equal(advisory.details.ownerSessionId, parent.piSessionId);
  assert.equal(advisory.details.requestId, REQUEST_ID);
  assert.equal(advisory.details.lastActivityAt, child.lastActivityAt);
  parentPi.events.get("session_shutdown")?.[0]();

  setLeadEnvironment();
  for (const state of [parent, child, unrelated])
    writeWorkerState(workerMailboxPath(WORKSPACE, state.workerLabel), state);
  const rootSent: unknown[] = [];
  const rootPi = fakePi({
    exec: workerControllerExecutor(parent, [child, unrelated]),
    sendMessage: (message) => rootSent.push(message),
  });
  registerExtension!(rootPi.pi as never);
  await rootPi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    rootSent.map((message: any) => message.details.workerLabel),
    [],
    "lead must not steal a parent's child advisory",
  );
  rootPi.events.get("session_shutdown")?.[0]();
  for (const state of [parent, child, unrelated])
    resetWorkerMailbox(workerMailboxPath(WORKSPACE, state.workerLabel));
  for (const state of [parent, child, unrelated])
    nativeSessions.delete(state.piSessionFile!);
});

test("stale scanner never notifies non-working candidates", async () => {
  setLeadEnvironment();
  const cases = ["blocked", "settling", "unknown"] as const;
  const states = cases.map((label) => ({
    ...managedState(
      `not-${label}`,
      REQUEST_ID,
      recoveryIdentity(`not-${label}`),
    ),
    lastActivityAt: Date.now() - 11 * 60_000,
  }));
  for (const state of states)
    writeWorkerState(workerMailboxPath(WORKSPACE, state.workerLabel), state);
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            agents: states.map((state, index) =>
              JSON.parse(
                listResponse(
                  state.workerLabel,
                  "working",
                  DEFAULT_PI_SESSION_ID,
                  state,
                  true,
                  cases[index],
                ),
              ),
            ),
            workspace_id: WORKSPACE,
          }),
          stderr: "",
          code: 0,
        };
      return leadExec(
        states[0].workerLabel,
        "working",
        DEFAULT_PI_SESSION_ID,
      )(command, args);
    },
    sendMessage: () => {
      throw new Error("unexpected advisory");
    },
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  pi.events.get("session_shutdown")?.[0]();
  for (const state of states)
    resetWorkerMailbox(workerMailboxPath(WORKSPACE, state.workerLabel));
});

test("stale scanner keeps one inventory in flight and retries rejection", async (t) => {
  setLeadEnvironment();
  const state = {
    ...managedState("pending-inventory", REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = workerMailboxPath(WORKSPACE, state.workerLabel);
  writeWorkerState(mailbox, state);
  let listCalls = 0;
  let resolveList!: () => void;
  let first = true;
  let rejectNext = false;
  const pending = new Promise<void>((resolve) => (resolveList = resolve));
  let sends = 0;
  const pi = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "list") {
        listCalls++;
        if (first) {
          first = false;
          return {
            stdout: listResponse(state.workerLabel, "working"),
            stderr: "",
            code: 0,
          };
        }
        if (rejectNext) {
          rejectNext = false;
          throw new Error("inventory unavailable");
        }
        await pending;
        return {
          stdout: listResponse(state.workerLabel, "working"),
          stderr: "",
          code: 0,
        };
      }
      return leadExec(
        state.workerLabel,
        "working",
        DEFAULT_PI_SESSION_ID,
      )(command, args);
    },
    sendMessage: () => {
      sends++;
    },
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await Promise.resolve();
  const initialListCalls = listCalls;
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(
    listCalls,
    initialListCalls,
    "the pending inventory remains the sole in-flight scan",
  );
  t.mock.timers.tick(30_000);
  assert.equal(
    listCalls,
    initialListCalls,
    "the pending inventory remains the sole in-flight scan",
  );
  resolveList();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(sends, 1);
  rejectNext = true;
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(sends, 1, "inventory rejection is contained and retried");
  pi.events.get("session_shutdown")?.[0]();
});

test("stale scanner shutdown invalidates old inventory generation", async (t) => {
  setLeadEnvironment();
  const state = {
    ...managedState("generation-worker", REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  writeWorkerState(workerMailboxPath(WORKSPACE, state.workerLabel), state);
  let resolveOld!: () => void;
  const oldInventory = new Promise<void>((resolve) => (resolveOld = resolve));
  let listCalls = 0;
  const sends: unknown[] = [];
  const pi = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "list") {
        listCalls++;
        if (listCalls === 2) {
          await oldInventory;
          return {
            stdout: listResponse(state.workerLabel, "working"),
            stderr: "",
            code: 0,
          };
        }
        return {
          stdout: listResponse(state.workerLabel, "working"),
          stderr: "",
          code: 0,
        };
      }
      return leadExec(
        state.workerLabel,
        "working",
        DEFAULT_PI_SESSION_ID,
      )(command, args);
    },
    sendMessage: (message) => sends.push(message),
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  pi.events.get("session_shutdown")?.[0]();
  resolveOld();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  assert.equal(sends.length, 0);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends.length, 1, "a new generation scans independently");
  pi.events.get("session_shutdown")?.[0]();
});

test("list derives inactivity without changing public state", async () => {
  setLeadEnvironment();
  const now = Date.now();
  const cases = [
    { label: "old-working", status: "working" as const, at: now - 11 * 60_000 },
    { label: "fresh-working", status: "working" as const, at: now - 1_000 },
    { label: "missing-working", status: "working" as const },
    { label: "future-working", status: "working" as const, at: now + 1_000 },
  ];
  for (const item of cases) {
    const state = managedState(item.label, REQUEST_ID);
    if (item.at !== undefined) state.lastActivityAt = item.at;
    writeWorkerState(workerMailboxPath(WORKSPACE, item.label), state);
  }
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            agents: cases
              .map((item) => JSON.parse(listResponse(item.label, item.status)))
              .flatMap((item) => item.agents),
            workspace_id: WORKSPACE,
          }),
          stderr: "",
          code: 0,
        };
      return leadExec(
        "old-working",
        "working",
        DEFAULT_PI_SESSION_ID,
      )(command, args);
    },
  });
  registerExtension!(pi.pi as never);
  const result = await pi.tools[0].execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    fakeContext(),
  );
  const workers = result.details.workers as any[];
  assert.equal(workers.find((w) => w.worker === "old-working")?.stale, true);
  assert.equal(
    workers.find((w) => w.worker === "old-working")?.state,
    "working",
  );
  assert.ok(
    workers.find((w) => w.worker === "old-working")?.inactive_ms >= 11 * 60_000,
  );
  assert.equal(
    typeof workers.find((w) => w.worker === "old-working")?.last_activity_at,
    "number",
  );
  for (const label of ["fresh-working", "missing-working", "future-working"]) {
    assert.equal(workers.find((w) => w.worker === label)?.stale, undefined);
    const worker = workers.find((w) => w.worker === label);
    if (label === "missing-working")
      assert.equal(worker?.last_activity_at, undefined);
    else assert.equal(typeof worker?.last_activity_at, "number");
    assert.equal(worker?.inactive_ms, undefined);
  }
  pi.events.get("session_shutdown")?.[0]();
});
