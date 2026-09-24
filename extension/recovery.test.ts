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
  ManagedAgentState,
} from "./mailbox.ts";
import { claimProcessLock } from "./lock.ts";
import { resultPath, resultRef } from "./storage.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  cascadeExecutor,
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  delegationLockPathForTest,
  fakeContext,
  fakePi,
  fakeAgentContext,
  herdrAlias,
  isAgentList,
  isApiSnapshot,
  isHerdrList,
  isPaneClose,
  isPaneList,
  isPreservePaneStop,
  isTabClose,
  isTabList,
  listResponse,
  managedState,
  nativeSessions,
  agentControllerExecutor,
  readPendingAsk,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  recoveryIdentity,
  registerExtension,
  removeAsk,
  removeRequest,
  removeResult,
  resetAgentMailbox,
  resultEntryDetails,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setAgentEnvironment,
  startupExecutor,
  testTmpRoot,
  truncateModelText,
  waitForTestCondition,
  agentMailboxPath,
  writeAsk,
  writeRequest,
  writeResult,
  writeAgentState,
} from "./support.ts";
const { updateConfig } = await import("./config.ts");

test("combined status reports a completed agent as pending, not active", async () => {
  setAgentEnvironment("status-pending-parent", ["child"]);
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
    piSessionId: "22222222-2222-4222-8222-222222222222",
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
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/status-settling-child.jsonl",
  };
  const states = [parent, trigger, pending, settling];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  for (const [index, state] of states.entries())
    writeAgentState(mailboxes[index], state);
  const writeChildResult = (
    state: ManagedAgentState,
    mailbox: string,
    requestId: string,
    text: string,
  ) =>
    writeResult(mailbox, {
      version: 4,
      runId: state.runId,
      requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
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
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ];
  const pi = fakePi({
    entries,
    exec: agentControllerExecutor(parent, [trigger, pending, settling]),
    sendMessage: (message) => entries.push(message),
  });
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeAgentContext(entries));
    const resultMessages = pi.sentMessageCalls.filter(
      ({ message }) =>
        (message as any).customType === "pi-herdsman-agent-result",
    );
    assert.equal(resultMessages.length, 2);
    const statuses = resultMessages.map(
      ({ message }) => (message as any).details,
    );
    assert.deepEqual(
      new Set(statuses.map((details) => details.agentLabel)),
      new Set(["status-trigger-child", "status-pending-child"]),
    );
    assert.deepEqual(
      Object.fromEntries(
        statuses.map((details) => [details.agentLabel, details.resultIndex]),
      ),
      {
        "status-trigger-child": 1,
        "status-pending-child": 1,
      },
      "result indexes are scoped to each logical agent label",
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
          String((message as any).content).endsWith(
            "Delegation status: 0 active direct agents; 1 pending direct result; 1 direct agent assignment remains unresolved. " +
              "Each unresolved unit of work has one executor. Delegating a scope transfers its execution ownership to that agent until the assignment resolves. After delegation succeeds, stop executing, inspecting, or analyzing that delegated scope locally; do not assign overlapping work. Continue only concrete, necessary work clearly outside the delegated scope that you still own. " +
              "When agent work is unresolved, handle required agent control, then continue only necessary work you still own or end the turn without concluding; agent results or attention will resume the session automatically. Do not check progress with list, inspect, transcript, status requests, steering, sleep, or other waiting mechanisms. Stale health attention is diagnosis, not progress polling: use attached evidence first and, when it is absent or insufficient, perform at most one bounded diagnostic read before returning to passive waiting. Repeated reminders alone do not justify another read. Do not invent work merely to remain active.",
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
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
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
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(childMailbox);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "queued child result",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: process.env.PI_HERDSMAN_LABEL ?? "agent",
      },
    },
    {
      customType: "pi-herdsman-agent-result",
      details: {
        ...resultEntryDetails(child, REQUEST_ID),
        runId: "11111111-1111-4111-8111-111111111111",
        ownerSessionId: "22222222-2222-4222-8222-222222222222",
        agentLabel: "different-agent",
        paneId: "different-pane",
        piSessionId: "33333333-3333-4333-8333-333333333333",
        piSessionFile: "/tmp/different-agent.jsonl",
      },
    },
    {
      customType: "unrelated-custom-message",
      details: {
        ...resultEntryDetails(child, REQUEST_ID),
        paneId: "conflicting-pane",
        piSessionFile: "/tmp/conflicting-agent.jsonl",
      },
    },
  ];
  let queued = 0;
  const lifecycle = cascadeExecutor([child]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") queued++;
      else entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(queued, 1);
    assert.ok(readResult(childMailbox, REQUEST_ID));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries((pi.sent[0] as any).details).filter(([key]) =>
          [
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
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
    assert.equal(queued, 2, "a conflicting entry must not suppress redelivery");
    assert.ok(readResult(childMailbox, REQUEST_ID));

    entries.push({
      message: {
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(child, REQUEST_ID),
      },
    });
    await pi.events.get("agent_settled")![0](undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      String((pi.sent[0] as any).content).endsWith(
        "Delegation status: 0 active direct agents; 0 pending direct results; all direct agent assignments are resolved.",
      ),
    );
    assert.equal((pi.sent[0] as any).details.unresolvedDirectChildCount, 0);
    assert.equal((pi.sent[0] as any).details.activeDirectChildCount, 0);
    assert.equal((pi.sent[0] as any).details.pendingDirectResultCount, 0);
    await pi.events.get("agent_settled")![0](undefined, context);
    await waitForTestCondition(
      () => readResult(childMailbox, REQUEST_ID) === undefined,
      "exact persisted result did not clean up",
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(childMailbox);
  }
});

test("reload result recovery rejects wrong owners and replacement identities", async () => {
  const label = "reload-proof-child";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const resultFor = (state: ManagedAgentState): ResultRecord => ({
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
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
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, wrongOwner);
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
        (message: any) => message.customType === "pi-herdsman-agent-result",
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
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, oldState);
  writeResult(mailbox, resultFor(oldState));
  const replacementLifecycle = cascadeExecutor([replacement]);
  const replacementPi = fakePi({
    exec: replacementLifecycle.exec,
    persistMessages: true,
  });
  registerExtension!(replacementPi.pi as never);
  try {
    await replacementPi.events.get("session_start")![0](
      undefined,
      fakeContext(replacementPi.entries),
    );
    assert.equal(
      replacementPi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ),
      true,
    );
    assert.deepEqual(replacementLifecycle.closeOrder, []);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    replacementPi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("malformed disappearance proof retains failed-launch cleanup evidence", async () => {
  setLeadEnvironment();
  const label = "rollback-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
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
    return JSON.stringify({ id: AGENT_ID, result: value });
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
            id: AGENT_ID,
            result: {
              agent: {
                name: validating
                  ? runScopedHerdrAlias(WORKSPACE, label, runId || AGENT_ID)
                  : args[2],
                pane_id: "pane-start",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  agent: "pi",
                  kind: "id",
                  source: "herdr:pi",
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
            id: AGENT_ID,
            result: {
              tabs: tabPresent
                ? [
                    {
                      tab_id: "registered-tab",
                      label: "agents",
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
            id: AGENT_ID,
            result: {
              tab: {
                tab_id: "registered-tab",
                label: "agents",
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
            stdout: JSON.stringify({ id: AGENT_ID, result: {} }),
            stderr: "",
            code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
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
            id: AGENT_ID,
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
                        agent: "pi",
                        kind: "id",
                        source: "herdr:pi",
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
            id: AGENT_ID,
            result: {
              process_info: {
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
      if (isAgentList(args) || isApiSnapshot(args))
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
                  value.snapshot = {
                    agents: value.agents,
                    panes: [
                      {
                        pane_id: "pane-start",
                        workspace_id: WORKSPACE,
                        cwd: "/tmp",
                        agent_session: value.agents[0].agent_session,
                      },
                    ],
                  };
                  return JSON.stringify({ id: AGENT_ID, result: value });
                })()
              : JSON.stringify({
                  id: AGENT_ID,
                  result: {
                    ...JSON.parse(emptyList()).result,
                    snapshot: { agents: [], panes: [] },
                  },
                }),
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
      writeAgentState(mailbox, {
        version: 4,
        runId,
        ownerSessionId,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: "pane-start",
        piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        piSessionFile: "/tmp/registered-agent.jsonl",
        cwd: "/tmp",
        updatedAt: Date.now(),
      });
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            tab_id: "registered-tab",
            tab_label: "agents",
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
                agent: "pi",
                kind: "id",
                source: "herdr:pi",
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
      definition: "agent",
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
    /Next action: Resolve the reported cleanup failure before retrying\./,
  );
  const rendered = pi.tools[0].renderResult(
    { content: result.content, details: result.details },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text },
    {
      args: {
        action: "delegate",
        definition: "agent",
        task: "fresh lifecycle task",
      },
    },
  );
  assert.match(rendered.text, /category: rollback_failure/);
  assert.match(
    rendered.text,
    /message: Agent launch failed and rollback was incomplete\./,
  );
  assert.match(
    rendered.text,
    /identity: label=rollback-agent, paneId=pane-start, tabId=registered-tab/,
  );
  assert.match(
    rendered.text,
    /next: Resolve the reported cleanup failure before retrying\./,
  );
  assert.match(
    rendered.text,
    /primary: category=target_not_found, message=live Herdr agent Pi session mismatch/,
  );
  assert.match(rendered.text, /cleanup: .*operation=rollback/);
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
  assert.equal(readAgentState(mailbox)?.agentLabel, label);
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
  assert.equal(listed.details.agents.length, 1);
  assert.equal(listed.details.agents[0].state, "lost");
  assert.deepEqual(listed.details.agents[0].available_actions, ["close"]);
  assert.equal(listed.details.cleanup_errors, undefined);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("rollback requires disappearance proof after a successful close", async () => {
  setLeadEnvironment();
  const label = "persistent-close-agent";
  const startup = startupExecutor(
    label,
    (count) =>
      count === 1
        ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        : DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
  );
  let closeSucceeded = false;
  let paneRemainsAfterClose = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = startup.exec(command, args, options);
      if (command === "herdr" && isTabClose(args)) {
        assert.equal(result.code, 0);
        closeSucceeded = true;
      }
      if (command === "herdr" && isPaneList(args) && closeSucceeded) {
        const payload = JSON.parse(result.stdout);
        paneRemainsAfterClose = payload.result.panes.some(
          (pane: { pane_id?: string }) => pane.pane_id === "startup-pane",
        );
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "leave cleanup evidence",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "rollback_failure");
    assert.equal(result.details.error.primary.category, "target_not_found");
    assert.equal(result.details.error.cleanup.category, "internal_failure");
    assert.match(
      result.details.error.cleanup.message,
      /tab startup-tab did not disappear after close/,
    );
    assert.equal(result.details.error.ids.label, label);
    assert.equal(result.details.error.ids.paneId, "startup-pane");
    assert.equal(result.details.error.ids.tabId, "startup-tab");
    assert.equal(closeSucceeded, true);
    assert.equal(paneRemainsAfterClose, true);
    assert.equal(readAgentState(startup.mailbox)?.agentLabel, label);
    assert.equal(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ),
      true,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }
});

test("assignment rollback retains primary failure and actionable cleanup details", async () => {
  setLeadEnvironment();
  const label = "rollback-detail-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  let runId = "";
  let ownerSessionId = "";
  let splitCreated = false;
  const emptyList = () => {
    const value = JSON.parse(listResponse(label));
    value.agents = [];
    return JSON.stringify({ id: AGENT_ID, result: value });
  };
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agent: {
                name:
                  args[2] === "detail-pane"
                    ? runScopedHerdrAlias(WORKSPACE, label, runId || AGENT_ID)
                    : args[2],
                pane_id: "detail-pane",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  agent: "pi",
                  kind: "id",
                  source: "herdr:pi",
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
            id: AGENT_ID,
            result: {
              tabs: [
                {
                  tab_id: "registered-tab",
                  label: "agents",
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
            id: AGENT_ID,
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
      if (args[0] === "tab" && args[1] === "create") {
        splitCreated = true;
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          if (assignment.startsWith("PI_HERDSMAN_RUN_ID="))
            runId = assignment.slice(19);
          if (assignment.startsWith("PI_HERDSMAN_OWNER_SESSION_ID="))
            ownerSessionId = assignment.slice(29);
        }
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tab: { tab_id: "registered-tab" },
              root_pane: { pane_id: "detail-pane" },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "layout")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
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
            id: AGENT_ID,
            result: { pane: { pane_id: "detail-pane" } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              pane: {
                pane_id: "detail-pane",
                tab_id: "registered-tab",
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  agent: "pi",
                  kind: "id",
                  source: "herdr:pi",
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
            id: AGENT_ID,
            result: {
              process_info: {
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
      if (isAgentList(args) || isApiSnapshot(args))
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
            value.snapshot = {
              agents: value.agents,
              panes: [
                {
                  pane_id: "detail-pane",
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  agent_session: value.agents[0].agent_session,
                },
                {
                  pane_id: "unmanaged-root-pane",
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                },
              ],
            };
            return JSON.stringify({ id: AGENT_ID, result: value });
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
      writeAgentState(mailbox, {
        version: 4,
        runId,
        ownerSessionId,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: "detail-pane",
        piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        piSessionFile: "/tmp/registered-agent.jsonl",
        cwd: "/tmp",
        updatedAt: Date.now(),
      });
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            tab_id: "registered-tab",
            tab_label: "agents",
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
                agent: "pi",
                kind: "id",
                source: "herdr:pi",
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
      definition: "agent",
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
  assert.equal(readAgentState(mailbox)?.agentLabel, label);
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
    ),
    true,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("recovery requires the official session and retries one failed delivery", async (t) => {
  setLeadEnvironment();
  const label = "recovery-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}-session.jsonl`),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeFileSync(identity.piSessionFile, "{}", "utf8");
  resetAgentMailbox(mailbox);
  const retryState = managedState(label, undefined, identity);
  retryState.completedRequestId = REQUEST_ID;
  writeAgentState(mailbox, retryState);
  const scoutText = "scout discovered SECRET implementation details";
  const scoutPresentation = truncateModelText(scoutText, {
    keep: "head",
    sessionId: identity.piSessionId,
    key: REQUEST_ID,
    requestId: REQUEST_ID,
    persist: "completion",
  });
  assert.equal(scoutPresentation.resultRef, `result:${REQUEST_ID}`);
  assert.equal(readFileSync(resultPath(REQUEST_ID), "utf8"), scoutText);
  const result: ResultRecord = {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
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

  resetAgentMailbox(mailbox);
  const removalState = managedState(label, undefined, identity);
  removalState.completedRequestId = REQUEST_ID;
  writeAgentState(mailbox, removalState);
  writeResult(mailbox, result);
  const lifecycle = cascadeExecutor([removalState]);
  let attempts = 0;
  let delivered = "";
  let deliveredDetails: any;
  const transientFailures = 5;
  let successful = 0;
  const previousRequestId = randomUUID();
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: {
        ...resultEntryDetails(removalState, previousRequestId),
        status: "completed",
        resultIndex: 1,
        resultRef: resultRef(previousRequestId),
      },
    },
  ];
  const recovering = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") {
        delivered = String((message as any).content ?? "");
        deliveredDetails = (message as any).details;
        attempts++;
        if (attempts <= transientFailures) throw new Error("transient");
        successful++;
        entries.push({
          customType: "pi-herdsman-agent-result",
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
    new RegExp(
      `^Agent result · agent=${label} · definition=agent · session=${identity.piSessionId} · status=completed`,
    ),
  );
  assert.match(delivered, new RegExp(`Result ref: result:${label}#2`));
  assert.doesNotMatch(delivered, /Agent result source:/);
  assert.equal(
    readFileSync(resultPath(REQUEST_ID), "utf8"),
    [
      `Agent result source: ${JSON.stringify({
        agent: label,
        definition: "agent",
        cwd: removalState.cwd,
        piSessionId: identity.piSessionId,
      })}`,
      scoutText,
    ].join("\n\n"),
  );
  assert.equal(deliveredDetails.agentLabel, label);
  assert.equal(deliveredDetails.agentDefinition, "agent");
  assert.equal(deliveredDetails.resultIndex, 2);
  assert.equal(deliveredDetails.resultRef, `result:${REQUEST_ID}`);
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  assert.deepEqual(lifecycle.closeOrder, [label]);
  recovering.events.get("session_shutdown")?.[0]();
  t.mock.timers.reset();
  realFs.rmSync(identity.piSessionFile, { force: true });
});

test("in-place branch history does not reuse a result index", async () => {
  setLeadEnvironment();
  const label = "branched-result-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}.jsonl`),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  realFs.writeFileSync(identity.piSessionFile, "{}", "utf8");
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "new branch result",
    completedAt: Date.now(),
  });
  const firstRequestId = randomUUID();
  const secondRequestId = randomUUID();
  const first = {
    customType: "pi-herdsman-agent-result",
    details: {
      ...resultEntryDetails(state, firstRequestId),
      status: "completed",
      resultIndex: 1,
      resultRef: resultRef(firstRequestId),
    },
  };
  const abandoned = {
    customType: "pi-herdsman-agent-result",
    details: {
      ...resultEntryDetails(state, secondRequestId),
      status: "completed",
      resultIndex: 2,
      resultRef: resultRef(secondRequestId),
    },
  };
  const entries: unknown[] = [first, abandoned];
  let delivered: any;
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        delivered = message;
      entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(entries, [first]),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delivered?.details.resultIndex, 3);
    assert.match(
      String(delivered?.content),
      /Result ref: result:branched-result-agent#3/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(identity.piSessionFile, { force: true });
    realFs.rmSync(resultPath(REQUEST_ID), { force: true });
  }
});

test("completed and failed one-shot agents converge after durable delivery", async (t) => {
  setLeadEnvironment();
  const children = [
    ["converge-child-one", REQUEST_ID],
    ["converge-child-two", randomUUID()],
  ].map(([label, requestId], index) => {
    const identity = recoveryIdentity(label);
    identity.piSessionFile = join(testTmpRoot, `${label}.jsonl`);
    if (index === 1)
      identity.piSessionId = "11111111-1111-4111-8111-111111111111";
    return {
      ...managedState(label, undefined, identity),
      completedRequestId: requestId,
    };
  });
  const mailboxes = children.map((child) =>
    agentMailboxPath(WORKSPACE, child.agentLabel),
  );
  for (const child of children)
    realFs.writeFileSync(child.piSessionFile!, "{}", "utf8");
  for (const [index, [child, mailbox]] of children
    .map((child, index) => [child, mailboxes[index]] as const)
    .entries()) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, child);
    writeResult(mailbox, {
      version: 4,
      runId: child.runId,
      requestId: child.completedRequestId!,
      ownerSessionId: child.ownerSessionId,
      workspaceId: child.workspaceId,
      agentLabel: child.agentLabel,
      paneId: child.paneId,
      status: index === 0 ? "completed" : "failed",
      ...(index === 0
        ? { text: child.agentLabel }
        : {
            error: {
              code: "empty_result" as const,
              message: "agent returned no result",
            },
          }),
      completedAt: Date.now(),
    });
  }
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(children[0], children[0].completedRequestId!),
    },
  ];
  const lifecycle = cascadeExecutor(children);
  let deliveries = 0;
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
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
    assert.deepEqual(lifecycle.closeOrder, [children[0].agentLabel]);
    assert.ok(readResult(mailboxes[1], children[1].completedRequestId!));

    entries.push({
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(children[1], children[1].completedRequestId!),
    });
    t.mock.timers.tick(1000);
    for (let index = 0; index < 10; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(
      new Set(lifecycle.closeOrder),
      new Set(children.map((child) => child.agentLabel)),
      JSON.stringify({
        live: [...lifecycle.live.keys()],
        states: mailboxes.map((mailbox) => readAgentState(mailbox)),
        results: children.map((child, index) =>
          readResult(mailboxes[index], child.completedRequestId!),
        ),
      }),
    );
    for (const mailbox of mailboxes)
      assert.equal(readAgentState(mailbox), undefined);
    assert.equal(deliveries, 1);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    for (const child of children)
      realFs.rmSync(child.piSessionFile!, { force: true });
  }
});

test("one-shot close failure retains the result for exact cleanup retry", async (t) => {
  setLeadEnvironment();
  const label = "close-retry-child";
  const child = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, child);
  writeResult(mailbox, {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
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
      if ((message as any).customType === "pi-herdsman-agent-result") {
        deliveries++;
        entries.push({
          customType: "pi-herdsman-agent-result",
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
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("delivered-result cascade retries descendant mailbox cleanup failure", async (t) => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "cascade-mailbox-retry-parent",
      undefined,
      recoveryIdentity("cascade-mailbox-retry-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: join(testTmpRoot, "cascade-mailbox-retry-parent.jsonl"),
    completedRequestId: REQUEST_ID,
  };
  const child = {
    ...managedState(
      "cascade-mailbox-retry-child",
      undefined,
      recoveryIdentity("cascade-mailbox-retry-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(testTmpRoot, "cascade-mailbox-retry-child.jsonl"),
  };
  writeFileSync(parent.piSessionFile, "{}", "utf8");
  writeFileSync(child.piSessionFile, "{}", "utf8");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  const obstruction = join(childMailbox, "stubborn-directory");
  realFs.mkdirSync(obstruction);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(parentMailbox, {
    version: 4,
    runId: parent.runId,
    requestId: REQUEST_ID,
    ownerSessionId: parent.ownerSessionId,
    workspaceId: parent.workspaceId,
    agentLabel: parent.agentLabel,
    paneId: parent.paneId,
    status: "completed",
    text: "delivered parent result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([parent, child]);
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(parent, REQUEST_ID),
        });
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(lifecycle.closeOrder, [child.agentLabel]);
    assert.ok(readAgentState(parentMailbox), "root must remain anchored");
    assert.deepEqual(
      readAgentState(childMailbox),
      child,
      "failed mailbox cleanup must preserve the durable identity anchor",
    );
    assert.ok(readResult(parentMailbox, REQUEST_ID));
    assert.ok(
      realFs.existsSync(obstruction),
      "failed descendant mailbox remains",
    );
    assert.equal(
      entries.filter(
        (entry: any) =>
          entry.customType === "pi_herdsman_cleanup_error" &&
          /stubborn-directory/.test(String(entry.data?.error)),
      ).length,
      1,
    );

    realFs.rmSync(obstruction, { recursive: true, force: true });
    t.mock.timers.tick(250);
    for (let index = 0; index < 10; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle.closeOrder, [
      child.agentLabel,
      parent.agentLabel,
    ]);
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readResult(parentMailbox, REQUEST_ID), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    realFs.rmSync(parent.piSessionFile!, { force: true });
    realFs.rmSync(child.piSessionFile!, { force: true });
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
    ...managedState("reload-result-sibling", randomUUID(), {
      ...recoveryIdentity("reload-result-sibling"),
      piSessionId: "11111111-1111-4111-8111-111111111111",
    }),
  };
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  const siblingMailbox = agentMailboxPath(WORKSPACE, sibling.agentLabel);
  resetAgentMailbox(childMailbox);
  resetAgentMailbox(siblingMailbox);
  writeAgentState(childMailbox, child);
  writeAgentState(siblingMailbox, sibling);
  const result: ResultRecord = {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
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
      if ((message as any).customType === "pi-herdsman-agent-result") queued++;
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
  lifecycle.live.delete(child.agentLabel);

  const recoveredEntries: unknown[] = [];
  let redeliveries = 0;
  const recovered = fakePi({
    entries: recoveredEntries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") {
        redeliveries++;
        recoveredEntries.push({
          message: {
            role: "custom",
            customType: "pi-herdsman-agent-result",
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
          entry.message?.customType === "pi-herdsman-agent-result" &&
          entry.message.details?.requestId === REQUEST_ID,
      ).length,
      1,
    );
    assert.equal(
      recovered.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .unresolvedDirectChildCount,
      1,
    );
    assert.ok(
      String((recovered.sentMessageCalls[0]?.message as any).content).endsWith(
        "Delegation status: 1 active direct agent; 0 pending direct results; 1 direct agent assignment remains unresolved. " +
          "Each unresolved unit of work has one executor. Delegating a scope transfers its execution ownership to that agent until the assignment resolves. After delegation succeeds, stop executing, inspecting, or analyzing that delegated scope locally; do not assign overlapping work. Continue only concrete, necessary work clearly outside the delegated scope that you still own. " +
          "When agent work is unresolved, handle required agent control, then continue only necessary work you still own or end the turn without concluding; agent results or attention will resume the session automatically. Do not check progress with list, inspect, transcript, status requests, steering, sleep, or other waiting mechanisms. Stale health attention is diagnosis, not progress polling: use attached evidence first and, when it is absent or insufficient, perform at most one bounded diagnostic read before returning to passive waiting. Repeated reminders alone do not justify another read. Do not invent work merely to remain active.",
      ),
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
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    recovered.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(childMailbox);
    resetAgentMailbox(siblingMailbox);
  }
});

test("settlement redelivers an unpersisted child result in the same session", async () => {
  setLeadEnvironment();

  const label = "settled-redelivery-child";
  const child = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);

  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, child);
  writeResult(mailbox, {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "durable child result",
    completedAt: Date.now(),
  });

  const lifecycle = cascadeExecutor([child]);
  const entries: unknown[] = [];
  let deliveries = 0;

  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType !== "pi-herdsman-agent-result") return;

      deliveries++;
      if (deliveries === 1) return;

      entries.push({
        message: {
          role: "custom",
          customType: "pi-herdsman-agent-result",
          details: (message as any).details,
        },
      });
    },
  });

  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);

  try {
    await pi.events.get("session_start")![0](undefined, context);

    assert.equal(deliveries, 1);
    assert.ok(readResult(mailbox, REQUEST_ID));
    assert.equal(
      entries.some(
        (entry: any) =>
          entry.message?.customType === "pi-herdsman-agent-result",
      ),
      false,
    );

    await pi.events.get("agent_settled")![0](undefined, context);

    await waitForTestCondition(
      () => deliveries === 2,
      "settlement did not redeliver the lost child result",
    );

    await waitForTestCondition(
      () => readResult(mailbox, REQUEST_ID) === undefined,
      "redelivered child result did not clean up",
    );

    assert.equal(deliveries, 2);
    assert.deepEqual(lifecycle.closeOrder, [label]);

    await pi.events.get("agent_settled")![0](undefined, context);
    await Promise.resolve();
    assert.equal(deliveries, 2);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("recovered no-live result removal retry never cleans up a replacement", async (t) => {
  setLeadEnvironment();
  const label = "no-live-removal-retry-agent";
  const identity = recoveryIdentity(label);
  const state = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "no live agent",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([]);
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      entries.push({
        customType: "pi-herdsman-agent-result",
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

    const unresolved = await pi.tools[0].execute(
      "list-unresolved",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(entries),
    );
    const listed = unresolved.details.agents.find(
      (agent: any) => agent.agent === label,
    );
    assert.match(listed.cleanup_error, /injected result removal failure/);
    assert.equal(unresolved.details.cleanup_errors, undefined);

    const callsBeforeRetry = pi.calls.length;
    lifecycle.live.set(label, replacement);
    assert.notEqual(replacement.runId, state.runId);
    assert.notEqual(replacement.paneId, state.paneId);
    assert.notEqual(replacement.piSessionId, state.piSessionId);
    assert.deepEqual(readAgentState(mailbox), state);
    t.mock.timers.tick(250);
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
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
    const callsAfterRetry = pi.calls.length;
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(pi.calls.length, callsAfterRetry);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);

    writeAgentState(mailbox, replacement);
    const replacementListed = await pi.tools[0].execute(
      "list-after-label-reuse",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(
      replacementListed.details.agents.find(
        (agent: any) => agent.agent === label,
      ).cleanup_error,
      undefined,
    );
  } finally {
    support.failNextResultRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("controller reply submits the normal request and preserves the assignment", async () => {
  setLeadEnvironment();
  const label = "reply-controller-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const waiting = {
    ...managedState(label, REQUEST_ID, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeAgentState(mailbox, waiting);
  writeAsk(mailbox, {
    version: 4,
    askId: waiting.pendingAskId!,
    requestId: REQUEST_ID,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    agentLabel: waiting.agentLabel,
    paneId: waiting.paneId,
    piSessionId: waiting.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  });
  const replyFile = join(testTmpRoot, `${label}-decision.md`);
  realFs.writeFileSync(replyFile, "decision evidence");
  let submitted: RequestRecord | undefined;
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V4__:".length);
        submitted = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
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
  assert.deepEqual(waitingList.details.agents[0].available_actions, [
    "inspect",
    "reply",
    "close",
  ]);
  const result = await pi.tools[0].execute(
    "reply",
    {
      action: "reply",
      agent: label,
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
    { args: { action: "reply", agent: label, message: "Use ALPHA." } },
  );
  assert.match(
    rendered.text,
    new RegExp(`request: ${result.details.request_id}`),
  );
  assert.match(rendered.text, new RegExp(`ask: ${waiting.pendingAskId}`));
  assert.match(rendered.text, new RegExp(`session: ${identity.piSessionId}`));
  assert.match(rendered.text, /assignment request: /);
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.equal(readAgentState(mailbox)?.pendingAskId, undefined);
  assert.equal(readRequest(mailbox, submitted!.requestId), undefined);
  const afterReply = await pi.tools[0].execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(afterReply.details.agents[0].available_actions, [
    "inspect",
    "steer",
    "interrupt",
    "close",
  ]);
  const missingAsk = await pi.tools[0].execute(
    "reply-without-ask",
    { action: "reply", agent: label, message: "No question is pending." },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(missingAsk.details.error.category, "agent_busy");
  assert.match(
    missingAsk.details.error.nextAction,
    /Use reply only for an outstanding ask_owner question/,
  );
  resetAgentMailbox(mailbox);
  realFs.rmSync(replyFile, { force: true });
});

test("controller cleanup barrier blocks newer work until stale acknowledgement cleanup succeeds", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const label = "cleanup-barrier-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const staleRequestId = randomUUID();
  const staleState = {
    ...managedState(label, staleRequestId, identity),
    lastAck: {
      requestId: staleRequestId,
      accepted: true,
      acknowledgedAt: Date.now(),
    },
  };
  writeAgentState(mailbox, staleState);
  const stalePath = join(mailbox, `request-${staleRequestId}.json`);
  writeRequest(mailbox, {
    version: 4,
    runId: staleState.runId,
    requestId: staleRequestId,
    ownerSessionId: staleState.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    kind: "task",
    text: "already accepted",
    createdAt: Date.now(),
  });
  let submitted: RequestRecord | undefined;
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V4__:".length);
        submitted = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
      },
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  (context as any).isIdle = () => false;
  try {
    support.failNextRequestRemoval = true;
    const blocked = await pi.tools[0].execute(
      "id",
      { action: "steer", agent: label, message: "must wait" },
      undefined,
      undefined,
      context,
    );
    assert.equal(blocked.details.error.category, "internal_failure");
    assert.equal(realFs.existsSync(stalePath), true);
    const failedList = await pi.tools[0].execute(
      "list-after-cleanup-failure",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.match(
      failedList.details.agents[0].cleanup_error,
      /Acknowledged request could not be removed/,
    );

    const result = await pi.tools[0].execute(
      "id",
      { action: "steer", agent: label, message: "proceed now" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(submitted?.kind, "steer");
    assert.equal(realFs.existsSync(stalePath), false);
    const recoveredList = await pi.tools[0].execute(
      "list-after-cleanup-recovery",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(recoveredList.details.agents[0].cleanup_error, undefined);
  } finally {
    support.failNextRequestRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(stalePath, { recursive: true, force: true });
    resetAgentMailbox(mailbox);
  }
});

test("lead recovery integration validation aborts with session shutdown", async () => {
  setLeadEnvironment();
  const label = "signal-recovery-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label));
  let integrationSignal: AbortSignal | undefined;
  let integrationAborted = false;
  const recovery = fakePi({
    exec: async (command, args, options) => {
      if (command === "herdr" && (isAgentList(args) || isApiSnapshot(args)))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agents: JSON.parse(listResponse(label, "working")).agents,
              snapshot: {
                agents: JSON.parse(listResponse(label, "working")).agents,
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: DEFAULT_PI_SESSION_ID,
                    },
                  },
                ],
              },
            },
          }),
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
          id: AGENT_ID,
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
    const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    const lifecycle = cascadeExecutor([parent, child], {
      failCloseLabel: failed ? child.agentLabel : undefined,
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
        { action: "close", agent: parent.agentLabel },
        undefined,
        undefined,
        fakeContext(),
      );
      if (!failed) {
        assert.equal(result.details.ok, true);
        assert.equal(result.details.action, "close");
        assert.equal(result.details.agent, parent.agentLabel);
        assert.equal(result.details.truncated, false);
        assert.ok(
          (result.content[0] as { text: string }).text.includes(
            `Close agent ${parent.agentLabel}.`,
          ),
        );
        const rendered = pi.tools[0].renderResult(
          { content: result.content, details: result.details },
          { expanded: true, isPartial: false },
          { fg: (_color: string, text: string) => text },
          { args: { action: "close", agent: parent.agentLabel } },
        );
        assert.match(rendered.text, new RegExp(`${parent.agentLabel} closed`));
        assert.deepEqual(lifecycle.closeOrder, [
          child.agentLabel,
          parent.agentLabel,
        ]);
        assert.equal(readAgentState(parentMailbox), undefined);
        assert.equal(readAgentState(childMailbox), undefined);
      } else {
        assert.equal(result.details.error.category, "internal_failure");
        assert.equal(result.details.error.ids.label, child.agentLabel);
        assert.equal(
          result.details.error.details.parentLabel,
          parent.agentLabel,
        );
        assert.deepEqual(lifecycle.closeOrder, []);
        assert.ok(readAgentState(parentMailbox));
        assert.ok(readAgentState(childMailbox));
      }
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
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
  const mailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, parent);
  realFs.mkdirSync(join(mailbox, "stubborn"));
  const lifecycle = cascadeExecutor([parent]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true);
    assert.match(result.details.cleanup_error, /mailbox cleanup failed/);
    assert.equal(result.details.cleanup_errors, undefined);
    assert.deepEqual(lifecycle.closeOrder, [parent.agentLabel]);
    assert.deepEqual(
      readAgentState(mailbox),
      parent,
      "incomplete mailbox cleanup must preserve its durable identity anchor",
    );
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

test("lost parent pane absence preserves durable child ancestry", async () => {
  for (const parentPresent of [false, true]) {
    setLeadEnvironment();
    const parent = {
      ...managedState(
        "missing-parent",
        undefined,
        recoveryIdentity("missing-parent"),
      ),
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: join(testTmpRoot, "missing-parent.jsonl"),
    };
    const child = {
      ...managedState(
        "missing-parent-child",
        undefined,
        recoveryIdentity("missing-parent-child"),
      ),
      ownerSessionId: parent.piSessionId,
      piSessionId: CHILD_SESSION_ID,
      piSessionFile: join(testTmpRoot, "missing-parent-child.jsonl"),
    };
    const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    const lifecycle = cascadeExecutor(
      parentPresent ? [parent, child] : [child],
      parentPresent ? { omitAgentLabels: [parent.agentLabel] } : {},
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
      const listedChild = (listed.details.agents as any[]).find(
        (agent) => agent.agent === child.agentLabel,
      );
      assert.equal(listedChild?.parent_label, parent.agentLabel);
      assert.deepEqual(listedChild?.available_actions, []);
      const result = await pi.tools[0].execute(
        "id",
        { action: "close", agent: child.agentLabel },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.error.category, "target_not_found");
      assert.deepEqual(lifecycle.closeOrder, []);
      assert.ok(readAgentState(childMailbox));
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
    }
  }
});

test("lead list excludes another lead's durable subtree", async () => {
  setLeadEnvironment();
  const foreignLeadSessionId = PARENT_SESSION_ID;
  const child = {
    ...managedState(
      "foreign-lead-agent",
      undefined,
      recoveryIdentity("foreign-lead-agent"),
    ),
    ownerSessionId: foreignLeadSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(testTmpRoot, "foreign-lead-agent.jsonl"),
  };
  const grandchild = {
    ...managedState(
      "foreign-lead-descendant",
      undefined,
      recoveryIdentity("foreign-lead-descendant"),
    ),
    ownerSessionId: child.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(testTmpRoot, "foreign-lead-descendant.jsonl"),
  };
  const mailboxes = [child, grandchild].map((state) => ({
    path: agentMailboxPath(WORKSPACE, state.agentLabel),
    state,
  }));
  for (const { path, state } of mailboxes) {
    resetAgentMailbox(path);
    writeAgentState(path, state);
  }
  const lifecycle = cascadeExecutor([child, grandchild]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    const listed = result.details.agents as any[];
    for (const label of [child.agentLabel, grandchild.agentLabel]) {
      assert.equal(
        listed.some((candidate) => candidate.agent === label),
        false,
        `${label} belongs to another lead`,
      );
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const { path } of mailboxes) resetAgentMailbox(path);
  }
});

test("lead list excludes cyclic unrooted durable ancestry", async () => {
  setLeadEnvironment();
  const cycleA = {
    ...managedState(
      "cycle-ancestry-a",
      undefined,
      recoveryIdentity("cycle-ancestry-a"),
    ),
    ownerSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionId: "22222222-2222-4222-8222-222222222222",
  };
  const cycleB = {
    ...managedState(
      "cycle-ancestry-b",
      undefined,
      recoveryIdentity("cycle-ancestry-b"),
    ),
    ownerSessionId: cycleA.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const descendant = {
    ...managedState(
      "cycle-ancestry-descendant",
      undefined,
      recoveryIdentity("cycle-ancestry-descendant"),
    ),
    ownerSessionId: cycleA.piSessionId,
    piSessionId: "33333333-3333-4333-8333-333333333333",
  };
  const states = [cycleA, cycleB, descendant];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  )) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  const pi = fakePi({ exec: cascadeExecutor(states).exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    const listed = result.details.agents as any[];
    for (const label of [
      cycleA.agentLabel,
      cycleB.agentLabel,
      descendant.agentLabel,
    ]) {
      assert.equal(
        listed.some((candidate) => candidate.agent === label),
        false,
        label,
      );
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("lead list excludes descendants with ambiguous durable parents", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "duplicate-ancestry-parent",
      undefined,
      recoveryIdentity("duplicate-ancestry-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const duplicateParent = {
    ...managedState(
      "duplicate-ancestry-parent-copy",
      undefined,
      recoveryIdentity("duplicate-ancestry-parent-copy"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "duplicate-ancestry-child",
      undefined,
      recoveryIdentity("duplicate-ancestry-child"),
    ),
    ownerSessionId: PARENT_SESSION_ID,
    piSessionId: CHILD_SESSION_ID,
  };
  const states = [parent, duplicateParent, child];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  )) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  const pi = fakePi({ exec: cascadeExecutor(states).exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      (result.details.agents as any[]).some(
        (agent) => agent.agent === child.agentLabel,
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
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
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const lifecycle = cascadeExecutor([parent, child]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: child.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
    assert.ok(readAgentState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("manual close omits malformed and absent agents", async () => {
  setLeadEnvironment();
  const label = "close-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
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
  writeAgentState(mailbox, managedState(label, undefined, identity));
  await pi.events.get("session_start")![0](undefined, fakeContext());
  writeFileSync(join(mailbox, "state.json"), "{malformed", "utf8");
  const tool = pi.tools[0];
  const malformed = await tool.execute(
    "id",
    { action: "close", agent: label },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(malformed.details.error.category, "target_not_found");
  resetAgentMailbox(mailbox);
  const absent = await tool.execute(
    "id",
    { action: "close", agent: label },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(absent.details.error.category, "target_not_found");
  pi.events.get("session_shutdown")?.[0]();
});

test("result cleanup retains durable delivery across agent identity changes", async () => {
  setLeadEnvironment();
  const label = "identity-change-result-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const initial = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const changed = {
    ...initial,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/identity-change-result-agent.jsonl",
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, initial);
  writeResult(mailbox, {
    version: 4,
    runId: initial.runId,
    requestId: REQUEST_ID,
    ownerSessionId: initial.ownerSessionId,
    workspaceId: initial.workspaceId,
    agentLabel: initial.agentLabel,
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
      if ((message as any).customType === "pi-herdsman-agent-result") {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(initial, REQUEST_ID),
        });
        writeAgentState(mailbox, changed);
      } else entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ).length,
      1,
    );
    assert.ok(
      readResult(mailbox, REQUEST_ID),
      "changed agent identity must retain the durable result",
    );
    assert.deepEqual(lifecycle.closeOrder, []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("delivered result remains while agent state is active", async () => {
  setLeadEnvironment();
  const label = "active-result-anchor-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const parent = {
    ...managedState("active-result-anchor-parent"),
    piSessionId: LEAD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const activeState = managedState(label, REQUEST_ID);
  writeAgentState(mailbox, activeState);
  writeResult(mailbox, {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
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
        customType: "pi-herdsman-agent-result",
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
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(mailbox);
  }
});

test("result delivery identifies retired sessions and honors the disabled setting", async () => {
  setLeadEnvironment();
  const deliver = async (
    label: string,
    marker: boolean,
    enabled: boolean,
  ): Promise<any> => {
    const identity = recoveryIdentity(label);
    const child = {
      ...managedState(label, undefined, identity),
      completedRequestId: REQUEST_ID,
    };
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, child);
    writeResult(mailbox, {
      version: 4,
      runId: child.runId,
      requestId: REQUEST_ID,
      ownerSessionId: child.ownerSessionId,
      workspaceId: child.workspaceId,
      agentLabel: child.agentLabel,
      paneId: child.paneId,
      status: "completed",
      text: "completed child work",
      completedAt: Date.now(),
    });
    nativeSessions.set(identity.piSessionFile!, {
      id: identity.piSessionId,
      path: identity.piSessionFile!,
      cwd: identity.piSessionFile ? "/tmp" : undefined,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: identity.piSessionId,
            definition: "agent",
            label,
          },
        },
        ...(marker
          ? [
              {
                type: "custom",
                customType: "pi-herdsman-agent-context-retired",
                data: { sessionId: identity.piSessionId },
              },
            ]
          : []),
      ],
    });
    const lifecycle = cascadeExecutor([child]);
    const entries: unknown[] = [];
    let delivered: any;
    const pi = fakePi({
      entries,
      exec: lifecycle.exec,
      sendMessage: (message) => {
        if ((message as any).customType !== "pi-herdsman-agent-result") return;
        delivered = message;
        entries.push({
          message: {
            customType: "pi-herdsman-agent-result",
            details: (message as any).details,
          },
        });
      },
    });
    registerExtension!(pi.pi as never);
    try {
      updateConfig("contextRetirement", enabled);
      await pi.events.get("session_start")![0](undefined, fakeContext(entries));
      return delivered;
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
      nativeSessions.delete(identity.piSessionFile!);
    }
  };

  try {
    const retired = await deliver("retired-delivery-agent", true, true);
    assert.match(
      retired.content,
      /Session retired after context pressure\. Do not continue or fork this session\./,
    );
    assert.equal(retired.details.sessionRetired, true);

    const disabled = await deliver("disabled-delivery-agent", true, false);
    assert.doesNotMatch(
      disabled.content,
      /Session retired after context pressure/,
    );
    assert.equal(disabled.details.sessionRetired, false);

    const ordinary = await deliver("ordinary-delivery-agent", false, true);
    assert.doesNotMatch(
      ordinary.content,
      /Session retired after context pressure/,
    );
    assert.equal(ordinary.details.sessionRetired, false);
  } finally {
    updateConfig("contextRetirement", undefined);
  }
});

test("accepted result delivery survives session identity failure in status guidance", async (t) => {
  setLeadEnvironment();
  const label = "status-identity-failure-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const parent = {
    ...managedState("status-identity-failure-parent"),
    piSessionId: LEAD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const resultState = {
    ...managedState(label),
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(mailbox, resultState);
  writeResult(mailbox, {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
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
      if ((message as any).customType === "pi-herdsman-agent-result") {
        resultAttempts++;
        entries.push({
          customType: "pi-herdsman-agent-result",
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
          message.customType === "pi-herdsman-agent-result" &&
          message.details?.status === "failed",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(mailbox);
  }
});

test("result is removed after agent state reaches completed", async (t) => {
  setLeadEnvironment();
  const label = "completed-result-anchor-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const activeState = managedState(label, REQUEST_ID);
  writeAgentState(mailbox, activeState);
  writeResult(mailbox, {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
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
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(activeState, REQUEST_ID),
      });
    },
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await Promise.resolve();
  await Promise.resolve();
  const completed = managedState(label);
  completed.completedRequestId = REQUEST_ID;
  const delivered = pi.sentMessageCalls.filter(
    ({ message }) => (message as any).customType === "pi-herdsman-agent-result",
  );
  assert.equal(delivered.length, 1);
  const durableResults = entries.filter(
    (entry: any) =>
      entry.customType === "pi-herdsman-agent-result" &&
      entry.details?.requestId === REQUEST_ID,
  );
  assert.equal(durableResults.length, 1);
  assert.deepEqual(
    durableResults[0].details,
    resultEntryDetails(activeState, REQUEST_ID),
  );
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  const pending = await pi.tools[0].execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    fakeContext(entries),
  );
  assert.equal(pending.details.cleanup_errors?.[label], undefined);
  assert.equal(
    entries.some(
      (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
    ),
    false,
  );
  t.mock.timers.tick(250);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.ok(readResult(mailbox, REQUEST_ID));
  assert.equal(
    pi.sentMessageCalls.filter(
      ({ message }) =>
        (message as any).customType === "pi-herdsman-agent-result",
    ).length,
    1,
  );
  writeAgentState(mailbox, completed);
  t.mock.timers.tick(250);
  await Promise.resolve();
  await Promise.resolve();
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readResult(mailbox, REQUEST_ID), undefined);
  assert.deepEqual(lifecycle.closeOrder, [label]);
  assert.equal(
    pi.sentMessageCalls.filter(
      ({ message }) =>
        (message as any).customType === "pi-herdsman-agent-result",
    ).length,
    1,
  );
  const settled = await pi.tools[0].execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    fakeContext(entries),
  );
  assert.equal(settled.details.cleanup_errors?.[label], undefined);
  pi.events.get("session_shutdown")?.[0]();
});

test("live result cleanup keeps a later request owned by the mailbox", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  for (const durableSecondResult of [false, true]) {
    setLeadEnvironment();
    const label = `root-result-race-${durableSecondResult ? "result" : "request"}`;
    const state = managedState(label, REQUEST_ID);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const secondRequestId = randomUUID();
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    writeResult(mailbox, {
      version: 4,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text: "delivered root result",
      completedAt: Date.now(),
    });
    const lifecycle = cascadeExecutor([state]);
    const entries: unknown[] = [];
    let secondRequestWritten = false;
    const pi = fakePi({
      entries,
      exec: lifecycle.exec,
      sendMessage: (message) => {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(state, REQUEST_ID),
        });
        if (
          !secondRequestWritten &&
          (message as any).customType === "pi-herdsman-agent-result"
        ) {
          secondRequestWritten = true;
          writeRequest(mailbox, {
            version: 4,
            runId: state.runId,
            requestId: secondRequestId,
            ownerSessionId: state.ownerSessionId,
            workspaceId: state.workspaceId,
            agentLabel: state.agentLabel,
            paneId: state.paneId,
            kind: "task",
            text: "later request",
            createdAt: Date.now(),
          });
          if (durableSecondResult)
            writeResult(mailbox, {
              version: 4,
              runId: state.runId,
              requestId: secondRequestId,
              ownerSessionId: state.ownerSessionId,
              workspaceId: state.workspaceId,
              agentLabel: state.agentLabel,
              paneId: state.paneId,
              status: "completed",
              text: "later result",
              completedAt: Date.now(),
            });
        }
      },
    });
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, fakeContext(entries));
      writeAgentState(mailbox, {
        ...state,
        activeRequestId: undefined,
        completedRequestId: REQUEST_ID,
      });
      t.mock.timers.tick(250);
      for (let index = 0; index < 5; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(readAgentState(mailbox));
      assert.ok(readResult(mailbox, REQUEST_ID));
      assert.ok(readRequest(mailbox, secondRequestId));
      assert.deepEqual(lifecycle.closeOrder, []);

      removeRequest(mailbox, secondRequestId);
      if (durableSecondResult) removeResult(mailbox, secondRequestId);
      t.mock.timers.tick(250);
      for (let index = 0; index < 5; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readAgentState(mailbox), undefined);
      assert.equal(readResult(mailbox, REQUEST_ID), undefined);
      assert.deepEqual(lifecycle.closeOrder, [label]);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
});

test("lost result cleanup keeps a later request owned by the mailbox", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  for (const durableSecondResult of [false, true]) {
    setLeadEnvironment();
    const label = `lost-result-race-${durableSecondResult ? "result" : "request"}`;
    const state = {
      ...managedState(label, undefined, recoveryIdentity(label)),
      completedRequestId: REQUEST_ID,
    };
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const secondRequestId = randomUUID();
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    writeResult(mailbox, {
      version: 4,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text: "delivered root result",
      completedAt: Date.now(),
    });
    const entries: unknown[] = [];
    let secondRequestWritten = false;
    const pi = fakePi({
      entries,
      exec: cascadeExecutor([]).exec,
      sendMessage: (message) => {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(state, REQUEST_ID),
        });
        if (
          !secondRequestWritten &&
          (message as any).customType === "pi-herdsman-agent-result"
        ) {
          secondRequestWritten = true;
          writeRequest(mailbox, {
            version: 4,
            runId: state.runId,
            requestId: secondRequestId,
            ownerSessionId: state.ownerSessionId,
            workspaceId: state.workspaceId,
            agentLabel: state.agentLabel,
            paneId: state.paneId,
            kind: "task",
            text: "later request",
            createdAt: Date.now(),
          });
          if (durableSecondResult)
            writeResult(mailbox, {
              version: 4,
              runId: state.runId,
              requestId: secondRequestId,
              ownerSessionId: state.ownerSessionId,
              workspaceId: state.workspaceId,
              agentLabel: state.agentLabel,
              paneId: state.paneId,
              status: "completed",
              text: "later result",
              completedAt: Date.now(),
            });
        }
      },
    });
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, fakeContext(entries));
      t.mock.timers.tick(250);
      for (let index = 0; index < 8; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(readAgentState(mailbox));
      assert.ok(readResult(mailbox, REQUEST_ID));
      assert.ok(readRequest(mailbox, secondRequestId));
      assert.deepEqual(
        (
          await pi.tools[0].execute(
            "id",
            { action: "list" },
            undefined,
            undefined,
            fakeContext(entries),
          )
        ).details.agents.find((agent: any) => agent.agent === label).state,
        "settling",
      );

      removeRequest(mailbox, secondRequestId);
      if (durableSecondResult) removeResult(mailbox, secondRequestId);
      t.mock.timers.tick(250);
      for (let index = 0; index < 8; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readAgentState(mailbox), undefined);
      assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
});

test("parent cascade keeps a later parent request during result cleanup", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "cascade-result-race-parent",
      undefined,
      recoveryIdentity("cascade-result-race-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: join(testTmpRoot, "cascade-result-race-parent.jsonl"),
    completedRequestId: REQUEST_ID,
  };
  writeFileSync(parent.piSessionFile, "{}", "utf8");
  const child = {
    ...managedState(
      "cascade-result-race-child",
      undefined,
      recoveryIdentity("cascade-result-race-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: randomUUID(),
    piSessionFile: join(testTmpRoot, "cascade-result-race-child.jsonl"),
  };
  writeFileSync(child.piSessionFile, "{}", "utf8");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  const secondRequestId = randomUUID();
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(parentMailbox, {
    version: 4,
    runId: parent.runId,
    requestId: REQUEST_ID,
    ownerSessionId: parent.ownerSessionId,
    workspaceId: parent.workspaceId,
    agentLabel: parent.agentLabel,
    paneId: parent.paneId,
    status: "completed",
    text: "delivered parent result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([child]);
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      entries.push({
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(parent, REQUEST_ID),
      });
      if ((message as any).customType === "pi-herdsman-agent-result")
        writeRequest(parentMailbox, {
          version: 4,
          runId: parent.runId,
          requestId: secondRequestId,
          ownerSessionId: parent.ownerSessionId,
          workspaceId: parent.workspaceId,
          agentLabel: parent.agentLabel,
          paneId: parent.paneId,
          kind: "task",
          text: "later parent request",
          createdAt: Date.now(),
        });
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readResult(parentMailbox, REQUEST_ID));
    assert.ok(readRequest(parentMailbox, secondRequestId));
    assert.deepEqual(lifecycle.closeOrder, []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    realFs.rmSync(parent.piSessionFile!, { force: true });
    realFs.rmSync(child.piSessionFile!, { force: true });
  }
});

test("completed lost parent cleanup resolves descendants before its mailbox", async () => {
  for (const childLive of [true, false]) {
    setLeadEnvironment();
    const suffix = childLive ? "live-child" : "lost-child";
    const parent = {
      ...managedState(
        `completed-lost-parent-${suffix}`,
        undefined,
        recoveryIdentity(`completed-lost-parent-${suffix}`),
      ),
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: join(testTmpRoot, `completed-lost-parent-${suffix}.jsonl`),
      completedRequestId: REQUEST_ID,
    };
    writeFileSync(parent.piSessionFile, "{}", "utf8");
    const child = {
      ...managedState(
        `completed-lost-child-${suffix}`,
        undefined,
        recoveryIdentity(`completed-lost-child-${suffix}`),
      ),
      ownerSessionId: parent.piSessionId,
      piSessionId: randomUUID(),
      piSessionFile: join(testTmpRoot, `completed-lost-child-${suffix}.jsonl`),
    };
    writeFileSync(child.piSessionFile, "{}", "utf8");
    const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    writeResult(parentMailbox, {
      version: 4,
      runId: parent.runId,
      requestId: REQUEST_ID,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      status: "completed",
      text: "completed before the parent pane disappeared",
      completedAt: Date.now(),
    });
    const lifecycle = cascadeExecutor(childLive ? [child] : []);
    const entries: unknown[] = [];
    const pi = fakePi({
      entries,
      exec: lifecycle.exec,
      sendMessage: (message) => {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(parent, REQUEST_ID),
        });
        void message;
      },
    });
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, fakeContext(entries));
      for (let index = 0; index < 8; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readResult(parentMailbox, REQUEST_ID), undefined);
      assert.equal(readAgentState(parentMailbox), undefined);
      assert.equal(readAgentState(childMailbox), undefined);
      assert.deepEqual(
        lifecycle.closeOrder,
        childLive ? [child.agentLabel] : [],
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
      realFs.rmSync(child.piSessionFile!, { force: true });
      realFs.rmSync(parent.piSessionFile!, { force: true });
    }
  }
});

test("automatic close invokes the exact lifecycle only after live identity proof", async () => {
  setLeadEnvironment();
  const label = "automatic-close-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const resultState = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(mailbox, resultState);
  writeResult(mailbox, {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
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
    return JSON.stringify({ id: AGENT_ID, result: value });
  };
  const pi = fakePi({
    entries,
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "tab" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
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
            id: AGENT_ID,
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
            id: AGENT_ID,
            result: {
              pane: {
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                tab_id: identity.tabId,
                cwd: "/tmp",
                agent_session: {
                  agent: "pi",
                  kind: "id",
                  source: "herdr:pi",
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
            id: AGENT_ID,
            result: {
              process_info: {
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
            ? JSON.stringify({
                id: AGENT_ID,
                result: JSON.parse(
                  listResponse(
                    label,
                    "working",
                    identity.piSessionId,
                    identity,
                  ),
                ),
              })
            : emptyList(),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: live
            ? JSON.stringify({
                id: AGENT_ID,
                result: {
                  snapshot: {
                    agents: (() => {
                      const value = JSON.parse(
                        listResponse(
                          label,
                          "working",
                          identity.piSessionId,
                          identity,
                        ),
                      );
                      value.agents[0].name = runScopedHerdrAlias(
                        WORKSPACE,
                        label,
                        AGENT_ID,
                      );
                      return value.agents;
                    })(),
                    panes: [
                      {
                        pane_id: identity.paneId,
                        tab_id: identity.tabId,
                        workspace_id: WORKSPACE,
                        cwd: "/tmp",
                        agent_session: {
                          source: "herdr:pi",
                          agent: "pi",
                          kind: "id",
                          value: identity.piSessionId,
                        },
                      },
                    ],
                  },
                },
              })
            : JSON.stringify({
                id: AGENT_ID,
                result: { snapshot: { agents: [], panes: [] } },
              }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agent: {
                name: runScopedHerdrAlias(WORKSPACE, label, AGENT_ID),
                pane_id: identity.paneId,
                tab_id: identity.tabId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  agent: "pi",
                  kind: "id",
                  source: "herdr:pi",
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
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(resultState, REQUEST_ID),
      });
    },
  });
  realFs.mkdirSync(PI_AGENTS_DIR, { recursive: true });
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "automatic-close-test.md"),
    "---\nname: automatic-close-test\n---\nagent\n",
    "utf8",
  );
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(closeCalls, 1);
    assert.equal(closeArgs?.[2], identity.paneId);
    assert.equal(
      readAgentState(mailbox),
      undefined,
      JSON.stringify(pi.entries),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.unlinkSync(join(PI_AGENTS_DIR, "automatic-close-test.md"));
  }
});

test("managed child automatic cleanup respects the parent delegation lock", async () => {
  setAgentEnvironment("cleanup-parent", ["child"]);
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
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "close the child",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ];
  const lifecycle = delegatedLifecycleExecutor(parent, [child]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        entries.push({
          customType: "pi-herdsman-agent-result",
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
  const context = fakeAgentContext(entries);
  try {
    registerExtension!(pi.pi as never);
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(childMailbox));
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
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("manual close retains ownership when live session identity is missing or wrong", async () => {
  for (const liveSession of [null, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]) {
    setLeadEnvironment();
    const label = liveSession ? "wrong-session-close" : "missing-session-close";
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, managedState(label));
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
      { action: "close", agent: label },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.ok(readAgentState(mailbox));
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("stale scanner starts immediately, reschedules, deduplicates, and retries failed publication", async (t) => {
  setLeadEnvironment();
  const label = "scanner-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const staleAt = now - 10 * 60_000 - 1_000;
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, defaultFixtureIdentity),
    lastActivityAt: staleAt,
  });
  let attempts = 0;
  const baseExec = leadExec(label, "working", DEFAULT_PI_SESSION_ID);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = baseExec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const payload = JSON.parse(result.stdout);
        payload.result.agent.agent_status = "working";
        return { ...result, stdout: JSON.stringify(payload) };
      }
      return result;
    },
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
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(attempts, 1, "the controller performs an immediate scan");

  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "a failed advisory is retried on the next scan");
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "a successful episode waits for its reminder");

  now += 5 * 60_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 150_000);

  now += 2 * 60_000 + 30_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 4);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 75_000);

  now += 75_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 5);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 60_000);

  now += 60_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 6);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 60_000);

  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    lastActivityAt: now,
    updatedAt: now,
  });
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    lastActivityAt: now - 10 * 60_000 - 1_000,
    updatedAt: now,
  });
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    attempts,
    7,
    "a changed activity timestamp starts a new episode",
  );
  pi.events.get("session_shutdown")?.[0]();
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 7, "shutdown removes the recurring scanner");
});

test("stale scanner skips completion or identity changes before publication", async () => {
  setLeadEnvironment();
  const label = "scanner-race-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  });
  let resolveList!: () => void;
  const listPending = new Promise<void>((resolve) => (resolveList = resolve));
  let sendCount = 0;
  const pi = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && isApiSnapshot(args)) {
        await listPending;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: JSON.parse(listResponse(label, "working")),
          }),
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
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
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
    "agentLabel",
    "paneId",
    "piSessionId",
  ] as const) {
    setLeadEnvironment();
    const label = `identity-race-${field}`;
    const mailbox = agentMailboxPath(WORKSPACE, label);
    writeAgentState(mailbox, {
      ...managedState(label, REQUEST_ID),
      lastActivityAt: Date.now() - 11 * 60_000,
    });
    let resolveList!: () => void;
    const pending = new Promise<void>((resolve) => (resolveList = resolve));
    let sends = 0;
    const pi = fakePi({
      exec: async (command, args) => {
        if (command === "herdr" && isApiSnapshot(args)) {
          await pending;
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: JSON.parse(listResponse(label, "working")).agents,
                  panes: [
                    {
                      pane_id: `${label}-pane`,
                      workspace_id: WORKSPACE,
                      cwd: "/tmp",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: DEFAULT_PI_SESSION_ID,
                      },
                    },
                  ],
                },
              },
            }),
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
      agentLabel: `${label}-replacement`,
      paneId: "replacement-pane",
      piSessionId: "77777777-7777-4777-8777-777777777777",
    };
    const replacement = {
      ...readAgentState(mailbox)!,
      [field]: replacements[field],
    };
    writeAgentState(mailbox, replacement);
    resolveList();
    await startup;
    assert.equal(sends, 0, field);
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("delegation parent notifies only its direct stale child", async (t) => {
  setAgentEnvironment("stale-parent", ["agent"]);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const parent = managedState("stale-parent");
  const child = {
    ...managedState("stale-child", REQUEST_ID, recoveryIdentity("stale-child")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    lastActivityAt: now - 11 * 60_000,
  };
  const unrelated = {
    ...managedState(
      "unrelated-child",
      REQUEST_ID,
      recoveryIdentity("unrelated-child"),
    ),
    ownerSessionId: PARENT_SESSION_ID,
    lastActivityAt: now - 11 * 60_000,
  };
  for (const state of [parent, child, unrelated])
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
  nativeSessions.set(parent.piSessionFile!, {
    id: parent.piSessionId!,
    path: parent.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: parent.piSessionId,
          definition: "parent",
          label: parent.agentLabel,
        },
      },
    ],
  });
  nativeSessions.set(child.piSessionFile!, {
    id: child.piSessionId!,
    path: child.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: child.piSessionId,
          definition: "agent",
          label: child.agentLabel,
        },
      },
    ],
  });
  nativeSessions.set(unrelated.piSessionFile!, {
    id: unrelated.piSessionId!,
    path: unrelated.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: unrelated.piSessionId,
          definition: "agent",
          label: unrelated.agentLabel,
        },
      },
    ],
  });
  const sent: unknown[] = [];
  const baseExec = agentControllerExecutor(parent, [child, unrelated]);
  let diagnosticReads = 0;
  let resumeOnDiagnostic = false;
  const exec = (command: string, args: string[], options?: any) => {
    if (
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "read" &&
      args[2] === child.paneId
    ) {
      diagnosticReads++;
      if (resumeOnDiagnostic) {
        const current = readAgentState(
          agentMailboxPath(WORKSPACE, child.agentLabel),
        )!;
        writeAgentState(agentMailboxPath(WORKSPACE, child.agentLabel), {
          ...current,
          lastActivityAt: now,
          updatedAt: now,
        });
        return { stdout: "work resumed", stderr: "", code: 0 };
      }
      return {
        stdout: "npm test\n42 passed, still running",
        stderr: "",
        code: 0,
      };
    }
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "process-info" &&
      args.at(-1) === child.paneId
    )
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            process_info: {
              pane_id: child.paneId,
              shell_pid: 100,
              foreground_process_group_id: 101,
              foreground_processes: [
                { pid: 101, argv0: "node", cmdline: "npm test" },
              ],
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    return baseExec(command, args, options);
  };
  process.env.PI_HERDSMAN_RUN_ID = parent.runId;
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = LEAD_SESSION_ID;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parentPi = fakePi({
    exec,
    sendMessage: (message) => sent.push(message),
  });
  registerExtension!(parentPi.pi as never);
  const parentContext = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
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
  assert.equal(advisory.customType, "pi-herdsman-agent-stale");
  assert.match(
    advisory.content,
    /Agent stale-child has had no qualifying execution progress/,
  );
  assert.match(
    advisory.content,
    /Streaming tool output does not count as qualifying progress/,
  );
  assert.match(advisory.content, /not proof of a hang/);
  assert.doesNotMatch(
    advisory.content,
    /Use transcript when .*; use inspect only/,
  );
  assert.match(advisory.content, /Bounded live diagnostic/);
  assert.match(advisory.content, /npm test/);
  assert.match(advisory.content, /42 passed/);
  assert.match(advisory.content, /untrusted observation/);
  assert.equal(diagnosticReads, 1);
  assert.equal(
    advisory.details.recent_output,
    "npm test\n42 passed, still running",
  );
  assert.equal(
    advisory.details.process.foreground_processes[0].cmdline,
    "npm test",
  );
  assert.match(advisory.content, /legitimately long-running/);
  assert.match(advisory.content, /Available actions:/);
  assert.match(advisory.content, /steer for a non-preemptive correction/);
  assert.match(
    advisory.content,
    /interrupt.*current operation.*continues the same assignment/,
  );
  assert.match(advisory.content, /Next reminder if unresolved/);
  assert.equal(advisory.details.agentLabel, child.agentLabel);
  assert.equal(advisory.details.ownerSessionId, parent.piSessionId);
  assert.equal(advisory.details.requestId, REQUEST_ID);
  assert.equal(advisory.details.lastActivityAt, child.lastActivityAt);

  parentPi.sent.length = 0;
  now += 5 * 60_000;
  t.mock.timers.tick(5 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  const reminder = parentPi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-stale",
  ) as any;
  assert.ok(reminder);
  assert.equal(diagnosticReads, 1);
  assert.match(
    reminder.content,
    /same stale episode|Do not repeat a diagnostic read/i,
  );

  const nextEpisode = {
    ...readAgentState(agentMailboxPath(WORKSPACE, child.agentLabel))!,
    lastActivityAt: now - 11 * 60_000,
  };
  writeAgentState(agentMailboxPath(WORKSPACE, child.agentLabel), nextEpisode);
  now += 30_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnosticReads, 2);
  const raceEpisode = {
    ...readAgentState(agentMailboxPath(WORKSPACE, child.agentLabel))!,
    lastActivityAt: now - 12 * 60_000,
  };
  writeAgentState(agentMailboxPath(WORKSPACE, child.agentLabel), raceEpisode);
  parentPi.sent.length = 0;
  resumeOnDiagnostic = true;
  now += 30_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnosticReads, 3);
  assert.equal(
    parentPi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ).length,
    0,
  );
  parentPi.events.get("session_shutdown")?.[0]();

  setLeadEnvironment();
  for (const state of [parent, child, unrelated])
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
  const rootSent: unknown[] = [];
  const rootPi = fakePi({
    exec: agentControllerExecutor(parent, [child, unrelated]),
    sendMessage: (message) => rootSent.push(message),
  });
  registerExtension!(rootPi.pi as never);
  await rootPi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    rootSent
      .filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      )
      .map((message: any) => message.details.agentLabel),
    [],
    "lead must not steal a parent's child advisory",
  );
  rootPi.events.get("session_shutdown")?.[0]();
  for (const state of [parent, child, unrelated])
    resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
  for (const state of [parent, child, unrelated])
    nativeSessions.delete(state.piSessionFile!);
});

test("stale diagnostic failure still publishes advisory without recovery", async () => {
  setLeadEnvironment();
  const label = "stale-diagnostic-failure";
  const state = {
    ...managedState(label, REQUEST_ID, recoveryIdentity(label)),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const calls: [string, string[]][] = [];
  const baseExec = agentControllerExecutor(state);
  const pi = fakePi({
    exec: (command, args, options) => {
      calls.push([command, args]);
      if (command === "herdr" && args[0] === "agent" && args[1] === "read")
        return { stdout: "", stderr: "inspection unavailable", code: 1 };
      return baseExec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    await new Promise((resolve) => setImmediate(resolve));
    const staleMessages = pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ) as any[];
    assert.equal(staleMessages.length, 1);
    assert.match(
      staleMessages[0].content,
      /Automatic live diagnostic evidence was unavailable/,
    );
    assert.match(
      staleMessages[0].content,
      /at most one currently available diagnostic read/,
    );
    assert.equal(
      calls.some(
        ([, args]) =>
          args[0] === "agent" && ["prompt", "close", "stop"].includes(args[1]!),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("stale diagnostic failure refreshes physical state before publication", async () => {
  setLeadEnvironment();
  const label = "stale-diagnostic-physical-race";
  const state = {
    ...managedState(label, REQUEST_ID, recoveryIdentity(label)),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const baseExec = agentControllerExecutor(state);
  let snapshots = 0;
  let diagnosisFailed = false;
  let lifecycle: "working" | "blocked" = "working";
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isApiSnapshot(args)) {
        snapshots++;
        const result = baseExec(command, args, options);
        if (snapshots < 2) return result;
        const payload = JSON.parse(result.stdout);
        payload.result.snapshot.agents[0].agent_status = lifecycle;
        payload.result.snapshot.panes[0].agent_status = lifecycle;
        return { ...result, stdout: JSON.stringify(payload) };
      }
      if (args[0] === "agent" && args[1] === "get") {
        diagnosisFailed = true;
        lifecycle = "blocked";
        return { stdout: "", stderr: "inspection unavailable", code: 1 };
      }
      return baseExec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(diagnosisFailed, true);
    assert.equal(snapshots, 2, "failure triggers a fresh physical snapshot");
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ).length,
      0,
      "a no-longer-working target must not publish stale-working attention",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("stale working parents remain visible while waiting parents project blocked", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const parent = {
    ...managedState(
      "stale-working-parent",
      REQUEST_ID,
      recoveryIdentity("stale-working-parent"),
    ),
    lastActivityAt: now - 11 * 60_000,
  };
  const child = {
    ...managedState("active-parent-child", randomUUID(), {
      ...recoveryIdentity("active-parent-child"),
      piSessionId: CHILD_SESSION_ID,
    }),
    ownerSessionId: parent.piSessionId,
  };
  for (const state of [parent, child])
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);

  let parentLifecycle: "working" | "idle" = "working";
  const controller = agentControllerExecutor(parent, [child]);
  const exec = (command: string, args: string[], options?: any) => {
    const result = controller(command, args, options);
    if (command !== "herdr" || (!isAgentList(args) && !isApiSnapshot(args)))
      return result;
    const payload = JSON.parse(result.stdout);
    const agents = isApiSnapshot(args)
      ? payload.result.snapshot.agents
      : payload.result.agents;
    agents[0].agent_status = parentLifecycle;
    if (isApiSnapshot(args))
      payload.result.snapshot.panes[0].agent_status = parentLifecycle;
    return { ...result, stdout: JSON.stringify(payload) };
  };
  const pi = fakePi({ exec });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ).length,
      1,
      "a stale working parent must notify its own owner even with an active child",
    );
    const stale = pi.sent.find(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ) as any;
    assert.equal(stale.details.agentLabel, parent.agentLabel);
    assert.equal(stale.details.ownerSessionId, LEAD_SESSION_ID);

    pi.sent.length = 0;
    parentLifecycle = "idle";
    t.mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      waiting.details.agents.find(
        (agent: any) => agent.agent === parent.agentLabel,
      )?.state,
      "blocked",
      "an idle parent waiting on an unresolved child projects blocked",
    );
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ).length,
      0,
      "a waiting parent must not receive a stale advisory",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const state of [parent, child])
      resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
  }
});

test("health scanner alerts true runtime blocking", async () => {
  setLeadEnvironment();
  const label = "runtime-blocked";
  const state = {
    ...managedState(label, REQUEST_ID, recoveryIdentity(label)),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const sent: any[] = [];
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      recoveryIdentity(label),
      true,
      "blocked",
    ),
    sendMessage: (message) => sent.push(message),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "pi-herdsman-agent-attention");
  assert.equal(sent[0].details.reason, "blocked");
  assert.match(sent[0].content, /no Herdsman ask_owner question exists/);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("settling alone does not trigger generic health attention", async () => {
  setLeadEnvironment();
  const label = "settling-health-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: Date.now() - 11 * 60_000,
  });
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
      true,
      "settling",
    ),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.some(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ),
    false,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("health attention stays idle-only and does not queue resolved stale work", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const label = "busy-health-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: now - 11 * 60_000,
  });
  const sent: any[] = [];
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
    ),
    sendMessage: (message) => sent.push(message),
  });
  const context = fakeContext();
  (context as any).isIdle = () => false;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    lastActivityAt: now,
    updatedAt: now,
  });
  (context as any).isIdle = () => true;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("result errors wake the direct owner with durable recovery evidence", async () => {
  setLeadEnvironment();
  const label = "result-error-health-agent";
  const identity = recoveryIdentity(label);
  const state = {
    ...managedState(label, undefined, identity),
    resultError: {
      code: "write_failure" as const,
      message: "result write failed",
      requestId: REQUEST_ID,
      runId: AGENT_ID,
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      agentLabel: label,
      paneId: identity.paneId,
      originalStatus: "completed" as const,
      attempts: 8,
      failedAt: Date.now() - 1_000,
      retrySafe: false,
      cleanupSafe: true,
      nextAction:
        "Inspect result_error, resolve mailbox persistence, then close this agent.",
    },
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const pi = fakePi({
    exec: leadExec(
      label,
      "idle",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  const attention = pi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-attention",
  ) as any;
  assert.equal(attention?.details.reason, "result_error");
  assert.equal(attention?.details.requestId, REQUEST_ID);
  assert.equal(attention?.details.nextReminderMs, 5 * 60_000);
  assert.match(attention.content, /Inspect result_error/);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("physical unknown attention is one-shot and fail-closed", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const label = "unknown-health-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const mismatched = { ...identity, paneId: "different-pane" };
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      mismatched,
    ),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    1,
  );
  const attention = pi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-attention",
  ) as any;
  assert.equal(attention.details.reason, "unknown");
  assert.deepEqual(attention.details.availableActions, []);
  now += 20 * 60_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("delivered owner asks repeat without duplicating first delivery", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const label = "repeat-owner-ask";
  const identity = recoveryIdentity(label);
  const state = {
    ...managedState(label, REQUEST_ID, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const ask = {
    version: 4 as const,
    askId: state.pendingAskId!,
    requestId: REQUEST_ID,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    piSessionId: state.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: now,
  };
  writeAsk(mailbox, ask);
  const entries = [{ customType: "pi-herdsman-agent-ask", details: ask }];
  const pi = fakePi({
    entries,
    persistMessages: true,
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-ask",
    ).length,
    0,
  );
  now += 5 * 60_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  const reminders = pi.sent.filter(
    (message: any) => message.customType === "pi-herdsman-agent-ask",
  ) as any[];
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].details.askId, ask.askId);
  assert.equal(reminders[0].details.requestId, ask.requestId);
  assert.equal(reminders[0].details.nextReminderMs, 150_000);
  assert.match(reminders[0].content, /still waiting/);
  writeAgentState(mailbox, { ...state, pendingAskId: undefined });
  removeAsk(mailbox, ask.askId);
  now += 3 * 60_000;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-ask",
    ).length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("old unacknowledged requests get attention without being resubmitted", async () => {
  setLeadEnvironment();
  const label = "old-handoff-health";
  const identity = recoveryIdentity(label);
  const state = managedState(label, REQUEST_ID, identity);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const request: RequestRecord = {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "retain this exact intent",
    createdAt: Date.now() - 11 * 60_000,
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, request);
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: JSON.parse(
                  listResponse(
                    label,
                    "working",
                    DEFAULT_PI_SESSION_ID,
                    identity,
                  ),
                ).agents,
                panes: [
                  {
                    pane_id: identity.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: identity.piSessionId,
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
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  const attention = pi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-attention",
  ) as any;
  assert.equal(attention?.details.reason, "handoff");
  assert.equal(attention?.details.requestId, REQUEST_ID);
  assert.match(attention.content, /Do not submit the same intent again/);
  assert.ok(readRequest(mailbox, REQUEST_ID));
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("health reconciliation publishes at most one attention per scan", async (t) => {
  setLeadEnvironment();
  const states = ["first-health-error", "second-health-error"].map((label) => {
    const identity = recoveryIdentity(label);
    return {
      ...managedState(label, undefined, identity),
      resultError: {
        code: "write_failure" as const,
        message: `${label} failed`,
        requestId: REQUEST_ID,
        runId: AGENT_ID,
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: identity.paneId,
        originalStatus: "completed" as const,
        attempts: 8,
        failedAt: Date.now() - 1_000,
        retrySafe: false,
        cleanupSafe: true,
        nextAction: "Resolve the stored result error, then close this agent.",
      },
    };
  });
  states[1]!.runId = randomUUID();
  states[1]!.resultError!.runId = states[1]!.runId;
  for (const state of states)
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    1,
  );
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    2,
  );
  pi.events.get("session_shutdown")?.[0]();
  for (const state of states)
    resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
});

test("lost managed agents remain visible and repeatedly notify their owner", async (t) => {
  setLeadEnvironment();
  const label = "lost-controller-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}.jsonl`),
  };
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const state = {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: Date.now(),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  realFs.writeFileSync(
    identity.piSessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: identity.piSessionId,
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    })}\n`,
  );
  nativeSessions.set(state.piSessionId, {
    id: state.piSessionId,
    path: state.piSessionFile!,
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "last persisted work" }],
        },
      },
    ],
  });
  realFs.appendFileSync(
    identity.piSessionFile,
    `${JSON.stringify({
      type: "message",
      id: "entry-0",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "last persisted work" }],
      },
    })}\n`,
  );
  writeAgentState(mailbox, state);
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({
    persistMessages: true,
    exec: lifecycle.exec,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    lifecycle.live.delete(label);
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    const listed = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    const agent = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.equal(agent.state, "lost");
    assert.deepEqual(agent.available_actions, ["transcript", "close"]);
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      1,
    );

    const transcript = await pi.tools[0].execute(
      "id",
      { action: "transcript", agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(
      transcript.details.ok,
      true,
      JSON.stringify(transcript.details),
    );
    assert.match(transcript.details.transcript, /last persisted work/);

    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      1,
    );
    now += 5 * 60_000;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      2,
    );
    assert.ok(readAgentState(mailbox));

    const closed = await pi.tools[0].execute(
      "id",
      { action: "close", agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(readAgentState(mailbox), undefined);
    now += 5 * 60_000;
    t.mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      2,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(state.piSessionId);
    realFs.rmSync(identity.piSessionFile, { force: true });
    resetAgentMailbox(mailbox);
  }
});

test("lost parent health attention omits close when a descendant has an unread durable result", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "lost-health-result-parent",
      undefined,
      recoveryIdentity("lost-health-result-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "lost-health-result-child",
      undefined,
      recoveryIdentity("lost-health-result-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    completedRequestId: REQUEST_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "child durable result",
    completedAt: Date.now(),
  });
  const pi = fakePi({ exec: cascadeExecutor([child]).exec });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    const attention = pi.sent.find(
      (message: any) => message.customType === "pi-herdsman-agent-lost",
    ) as any;
    assert.equal(attention?.details.agentLabel, parent.agentLabel);
    assert.equal(attention?.details.availableActions.includes("close"), false);
    assert.doesNotMatch(
      String(attention?.content),
      /Close this lost generation/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("live agents with an unread durable result do not advertise close", async () => {
  setLeadEnvironment();
  const label = "live-result-agent";
  const state = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  const pi = fakePi({ exec: cascadeExecutor([state]).exec });
  registerExtension!(pi.pi as never);
  try {
    const listed = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    const agent = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.equal(agent.state, "settling");
    assert.equal(agent.available_actions.includes("close"), false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("lead list hides close when a descendant has an unread durable result", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "cascade-result-parent",
      undefined,
      recoveryIdentity("cascade-result-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "cascade-result-child",
      undefined,
      recoveryIdentity("cascade-result-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    completedRequestId: REQUEST_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 4,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "child durable result",
    completedAt: Date.now(),
  });
  const pi = fakePi({
    exec: cascadeExecutor([parent, child]).exec,
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    const listedParent = result.details.agents.find(
      (agent: any) => agent.agent === parent.agentLabel,
    );
    assert.equal(listedParent.available_actions.includes("close"), false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("lost agents with an unread durable result cannot be closed", async () => {
  setLeadEnvironment();
  const label = "lost-result-agent";
  const state = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  const pi = fakePi({ exec: cascadeExecutor([]).exec });
  registerExtension!(pi.pi as never);
  try {
    const listed = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    const agent = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.equal(agent.state, "settling");
    assert.deepEqual(agent.available_actions, []);

    const closed = await pi.tools[0].execute(
      "id",
      { action: "close", agent: label },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.ok(readAgentState(mailbox));
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("cascade preflight keeps descendants when a lost parent has a pending result", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "lost-result-parent",
      undefined,
      recoveryIdentity("lost-result-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "lost-result-child",
      REQUEST_ID,
      recoveryIdentity("lost-result-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, {
    ...parent,
    completedRequestId: REQUEST_ID,
  });
  writeAgentState(childMailbox, child);
  writeResult(parentMailbox, {
    version: 4,
    runId: parent.runId,
    requestId: REQUEST_ID,
    ownerSessionId: parent.ownerSessionId,
    workspaceId: parent.workspaceId,
    agentLabel: parent.agentLabel,
    paneId: parent.paneId,
    status: "completed",
    text: "parent durable result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([child]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const closed = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(childMailbox));
    assert.ok(readResult(parentMailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("lost close fails closed when a result appears during its final proof", async () => {
  setLeadEnvironment();
  const mailbox = agentMailboxPath(WORKSPACE, "racing-lost-result");
  const state = {
    ...managedState(
      "racing-lost-result",
      REQUEST_ID,
      recoveryIdentity("racing-lost-result"),
    ),
  };
  writeAgentState(mailbox, state);
  let snapshots = 0;
  const racedState = {
    ...state,
    completedRequestId: REQUEST_ID,
  };
  delete racedState.activeRequestId;
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = cascadeExecutor([]).exec(command, args, options);
      if (command === "herdr" && isApiSnapshot(args) && ++snapshots === 5) {
        writeAgentState(mailbox, racedState);
        writeResult(mailbox, {
          version: 4,
          runId: state.runId,
          requestId: REQUEST_ID,
          ownerSessionId: state.ownerSessionId,
          workspaceId: state.workspaceId,
          agentLabel: state.agentLabel,
          paneId: state.paneId,
          status: "completed",
          text: "raced durable result",
          completedAt: Date.now(),
        });
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const listed = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.deepEqual(listed.details.agents[0].available_actions, ["close"]);
    const closed = await pi.tools[0].execute(
      "id",
      { action: "close", agent: state.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.deepEqual(readAgentState(mailbox), racedState);
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("a lost parent retains its live child ancestry and closes child-first", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState("lost-parent", undefined, recoveryIdentity("lost-parent")),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "lost-parent-child",
      REQUEST_ID,
      recoveryIdentity("lost-parent-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const lifecycle = cascadeExecutor([child]);
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
    const parentRow = listed.details.agents.find(
      (agent: any) => agent.agent === parent.agentLabel,
    );
    const childRow = listed.details.agents.find(
      (agent: any) => agent.agent === child.agentLabel,
    );
    assert.equal(parentRow?.state, "lost");
    assert.equal(parentRow?.available_actions.includes("close"), true);
    assert.equal(childRow?.parent_label, parent.agentLabel);

    const closed = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.deepEqual(lifecycle.closeOrder, [child.agentLabel]);
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("unknown descendants refuse a lost-parent cascade", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "unknown-child-parent",
      undefined,
      recoveryIdentity("unknown-child-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "unknown-child",
      undefined,
      recoveryIdentity("unknown-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const lifecycle = cascadeExecutor([child], {
    mismatchSessionLabel: child.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("mixed live and unknown descendants preflight before closing", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "mixed-live-unknown-parent",
      undefined,
      recoveryIdentity("mixed-live-unknown-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const liveChild = {
    ...managedState(
      "mixed-live-child",
      undefined,
      recoveryIdentity("mixed-live-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const unknownChild = {
    ...managedState(
      "mixed-unknown-child",
      undefined,
      recoveryIdentity("mixed-unknown-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const liveMailbox = agentMailboxPath(WORKSPACE, liveChild.agentLabel);
  const unknownMailbox = agentMailboxPath(WORKSPACE, unknownChild.agentLabel);
  for (const mailbox of [parentMailbox, liveMailbox, unknownMailbox])
    resetAgentMailbox(mailbox);
  for (const [mailbox, state] of [
    [parentMailbox, parent],
    [liveMailbox, liveChild],
    [unknownMailbox, unknownChild],
  ] as const)
    writeAgentState(mailbox, state);
  const lifecycle = cascadeExecutor([liveChild, unknownChild], {
    mismatchSessionLabel: unknownChild.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(liveMailbox));
    assert.ok(readAgentState(unknownMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of [parentMailbox, liveMailbox, unknownMailbox])
      resetAgentMailbox(mailbox);
  }
});

test("mixed lost and unknown descendants preflight before removing mailboxes", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "mixed-lost-unknown-parent",
      undefined,
      recoveryIdentity("mixed-lost-unknown-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const lostChild = {
    ...managedState(
      "mixed-lost-child",
      undefined,
      recoveryIdentity("mixed-lost-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const unknownChild = {
    ...managedState(
      "mixed-lost-unknown-child",
      undefined,
      recoveryIdentity("mixed-lost-unknown-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const lostMailbox = agentMailboxPath(WORKSPACE, lostChild.agentLabel);
  const unknownMailbox = agentMailboxPath(WORKSPACE, unknownChild.agentLabel);
  for (const mailbox of [parentMailbox, lostMailbox, unknownMailbox])
    resetAgentMailbox(mailbox);
  for (const [mailbox, state] of [
    [parentMailbox, parent],
    [lostMailbox, lostChild],
    [unknownMailbox, unknownChild],
  ] as const)
    writeAgentState(mailbox, state);
  const lifecycle = cascadeExecutor([unknownChild], {
    mismatchSessionLabel: unknownChild.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(lostMailbox));
    assert.ok(readAgentState(unknownMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of [parentMailbox, lostMailbox, unknownMailbox])
      resetAgentMailbox(mailbox);
  }
});

test("nested cascades resolve every descendant deepest-first", async () => {
  for (const childLive of [true, false]) {
    setLeadEnvironment();
    const suffix = childLive ? "live-child" : "lost-child";
    const parent = {
      ...managedState(
        `nested-cascade-parent-${suffix}`,
        undefined,
        recoveryIdentity(`nested-cascade-parent-${suffix}`),
      ),
      piSessionId: PARENT_SESSION_ID,
    };
    const child = {
      ...managedState(
        `nested-cascade-child-${suffix}`,
        undefined,
        recoveryIdentity(`nested-cascade-child-${suffix}`),
      ),
      ownerSessionId: parent.piSessionId,
      piSessionId: CHILD_SESSION_ID,
    };
    const grandchild = {
      ...managedState(
        `nested-cascade-grandchild-${suffix}`,
        undefined,
        recoveryIdentity(`nested-cascade-grandchild-${suffix}`),
      ),
      ownerSessionId: child.piSessionId,
      piSessionId: "11111111-1111-4111-8111-111111111111",
    };
    const states = [parent, child, grandchild];
    const mailboxes = states.map((state) =>
      agentMailboxPath(WORKSPACE, state.agentLabel),
    );
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    for (const [mailbox, state] of mailboxes.map(
      (mailbox, index) => [mailbox, states[index]] as const,
    ))
      writeAgentState(mailbox, state);
    const lifecycle = cascadeExecutor(
      childLive ? [child, grandchild] : [grandchild],
    );
    const pi = fakePi({ exec: lifecycle.exec });
    registerExtension!(pi.pi as never);
    try {
      const result = await pi.tools[0].execute(
        "id",
        { action: "close", agent: parent.agentLabel },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.deepEqual(
        lifecycle.closeOrder,
        childLive
          ? [grandchild.agentLabel, child.agentLabel]
          : [grandchild.agentLabel],
      );
      for (const mailbox of mailboxes)
        assert.equal(readAgentState(mailbox), undefined);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    }
  }
});

test("nested unknown descendants refuse the cascade before any mutation", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "nested-unknown-parent",
      undefined,
      recoveryIdentity("nested-unknown-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "nested-unknown-child",
      undefined,
      recoveryIdentity("nested-unknown-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const grandchild = {
    ...managedState(
      "nested-unknown-grandchild",
      undefined,
      recoveryIdentity("nested-unknown-grandchild"),
    ),
    ownerSessionId: child.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const states = [parent, child, grandchild];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  ))
    writeAgentState(mailbox, state);
  const lifecycle = cascadeExecutor([child, grandchild], {
    mismatchSessionLabel: grandchild.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    for (const mailbox of mailboxes) assert.ok(readAgentState(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("duplicate durable parent identities refuse cascade before mutation", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "duplicate-cascade-parent",
      undefined,
      recoveryIdentity("duplicate-cascade-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const duplicateParent = {
    ...managedState(
      "duplicate-cascade-parent-copy",
      undefined,
      recoveryIdentity("duplicate-cascade-parent-copy"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "duplicate-cascade-child",
      undefined,
      recoveryIdentity("duplicate-cascade-child"),
    ),
    ownerSessionId: PARENT_SESSION_ID,
    piSessionId: CHILD_SESSION_ID,
  };
  const states = [parent, duplicateParent, child];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  )) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  const lifecycle = cascadeExecutor(states);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    for (const mailbox of mailboxes) assert.ok(readAgentState(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("cascade preflights the parent before closing descendants", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "unresolved-cascade-parent",
      undefined,
      recoveryIdentity("unresolved-cascade-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "unresolved-cascade-child",
      undefined,
      recoveryIdentity("unresolved-cascade-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const lifecycle = cascadeExecutor([parent, child], {
    mismatchSessionLabel: parent.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("cascade revalidates a live descendant mailbox before closing it", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "changed-live-cascade-parent",
      undefined,
      recoveryIdentity("changed-live-cascade-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "changed-live-cascade-child",
      undefined,
      recoveryIdentity("changed-live-cascade-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const lifecycle = cascadeExecutor([parent, child]);
  let snapshotCalls = 0;
  const changedChild = {
    ...child,
    runId: randomUUID(),
  };
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (command === "herdr" && isApiSnapshot(args)) {
        snapshotCalls++;
        if (snapshotCalls === 2) writeAgentState(childMailbox, changedChild);
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.equal(snapshotCalls, 2);
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.deepEqual(readAgentState(parentMailbox), parent);
    assert.deepEqual(readAgentState(childMailbox), changedChild);
    assert.ok(lifecycle.live.has(child.agentLabel));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("stale scanner keeps one inventory in flight and retries rejection", async (t) => {
  setLeadEnvironment();
  const state = {
    ...managedState("pending-inventory", REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
  writeAgentState(mailbox, state);
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
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: JSON.parse(listResponse(state.agentLabel, "working")),
            }),
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
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: JSON.parse(listResponse(state.agentLabel, "working")),
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const result = leadExec(
          state.agentLabel,
          "working",
          DEFAULT_PI_SESSION_ID,
        )(command, args);
        const payload = JSON.parse(result.stdout);
        payload.result.agent.agent_status = "working";
        return { ...result, stdout: JSON.stringify(payload) };
      }
      return leadExec(
        state.agentLabel,
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
  await new Promise((resolve) => setImmediate(resolve));
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
    ...managedState("generation-agent", REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
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
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: JSON.parse(listResponse(state.agentLabel, "working")),
            }),
            stderr: "",
            code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: JSON.parse(listResponse(state.agentLabel, "working")),
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const result = leadExec(
          state.agentLabel,
          "working",
          DEFAULT_PI_SESSION_ID,
        )(command, args);
        const payload = JSON.parse(result.stdout);
        payload.result.agent.agent_status = "working";
        return { ...result, stdout: JSON.stringify(payload) };
      }
      return leadExec(
        state.agentLabel,
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
    const identity = recoveryIdentity(item.label);
    identity.piSessionId = randomUUID();
    const state = managedState(item.label, REQUEST_ID, identity);
    if (item.at !== undefined) state.lastActivityAt = item.at;
    writeAgentState(agentMailboxPath(WORKSPACE, item.label), state);
  }
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "api" && args[1] === "snapshot") {
        const agents = cases.map((item) => {
          const state = readAgentState(
            agentMailboxPath(WORKSPACE, item.label),
          )!;
          const identity = recoveryIdentity(item.label);
          identity.paneId = state.paneId;
          identity.piSessionId = state.piSessionId;
          return {
            ...JSON.parse(
              listResponse(
                item.label,
                item.status,
                state.piSessionId,
                identity,
              ),
            ).agents[0],
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: state.piSessionId,
            },
            workspace_id: state.workspaceId,
            pane_id: state.paneId,
            cwd: state.cwd,
          };
        });
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents,
                panes: agents.map((agent) => ({
                  pane_id: agent.pane_id,
                  workspace_id: agent.workspace_id,
                  cwd: agent.cwd,
                  agent_session: agent.agent_session,
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
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
  const agents = result.details.agents as any[];
  assert.equal(
    agents.find((agent) => agent.agent === "old-working")?.stale,
    true,
  );
  assert.equal(
    agents.find((agent) => agent.agent === "old-working")?.state,
    "working",
  );
  assert.ok(
    agents.find((agent) => agent.agent === "old-working")?.inactive_ms >=
      11 * 60_000,
  );
  assert.equal(
    typeof agents.find((agent) => agent.agent === "old-working")
      ?.last_activity_at,
    "number",
  );
  for (const label of ["fresh-working", "missing-working", "future-working"]) {
    assert.equal(
      agents.find((agent) => agent.agent === label)?.stale,
      undefined,
    );
    const agent = agents.find((candidate) => candidate.agent === label);
    if (label === "missing-working")
      assert.equal(agent?.last_activity_at, undefined);
    else assert.equal(typeof agent?.last_activity_at, "number");
    assert.equal(agent?.inactive_ms, undefined);
  }
  pi.events.get("session_shutdown")?.[0]();
});
