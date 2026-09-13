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
import support, {
  CHILD_SESSION_ID,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  controlMarker,
  fakeContext,
  fakePi,
  fakeAgentContext,
  managedState,
  agentControllerExecutor,
  readPendingAsk,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  recoveryIdentity,
  removeAsk,
  registerExtension,
  removeRequest,
  removeResult,
  resetAgentMailbox,
  resultEntryDetails,
  leadExec,
  sessionAgentIdentity,
  sessionContextRetired,
  setLeadEnvironment,
  setAgentEnvironment,
  watchedResultPaths,
  agentMailboxPath,
  writeAsk,
  writeMetadataTask,
  writeRequest,
  writeResult,
  writeAgentState,
  waitForTestCondition,
  testTmpRoot,
} from "./support.ts";
const { updateConfig } = await import("./config.ts");

test("managed agents cancel native session replacement", () => {
  setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  assert.deepEqual(
    agent.events.get("session_before_switch")![0](undefined, fakeContext()),
    { cancel: true },
  );
  assert.deepEqual(
    agent.events.get("session_before_fork")![0](undefined, fakeContext()),
    { cancel: true },
  );
  agent.events.get("session_shutdown")?.[0]();
});

test("managed requests pump through Pi semantic input", async () => {
  const mailbox = setAgentEnvironment("pump-agent");
  let context: ReturnType<typeof fakeAgentContext>;
  let transformed: unknown;
  const agent = fakePi({
    sendUserMessage(content) {
      transformed = agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "pump this task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readAgentState(mailbox)?.lastAck?.requestId === request.requestId)
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 99)
        assert.fail("mailbox pump did not accept the request");
    }
    assert.deepEqual(transformed, { action: "transform", text: request.text });
    assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      request.requestId,
    );
    assert.equal(
      agent.calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
    assert.deepEqual(agent.sentUsers, [controlMarker(request.requestId)]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(agent.sentUsers, [controlMarker(request.requestId)]);
    removeRequest(mailbox, request.requestId);
    (context as any).isIdle = () => false;
    const steer: RequestRecord = {
      ...request,
      requestId: randomUUID(),
      kind: "steer",
      text: "pump this steer",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, steer);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readAgentState(mailbox)?.lastAck?.requestId === steer.requestId)
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 99) assert.fail("mailbox pump did not accept steering");
    }
    assert.deepEqual(transformed, {
      action: "transform",
      text: steer.text,
    });
    assert.deepEqual(agent.sentUserCalls, [
      {
        content: controlMarker(request.requestId),
        options: { deliverAs: "steer" },
      },
      {
        content: controlMarker(steer.requestId),
        options: { deliverAs: "steer" },
      },
    ]);
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("managed session start immediately recovers a durable request", async () => {
  const mailbox = setAgentEnvironment("pump-recovery-agent");
  const persisted = managedState("pump-recovery-agent");
  writeAgentState(mailbox, persisted);
  const request: RequestRecord = {
    version: 4,
    runId: persisted.runId,
    requestId: randomUUID(),
    ownerSessionId: persisted.ownerSessionId,
    workspaceId: persisted.workspaceId,
    agentLabel: persisted.agentLabel,
    paneId: persisted.paneId,
    kind: "task",
    text: "recover this task",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  let context: ReturnType<typeof fakeAgentContext>;
  const agent = fakePi({
    sendUserMessage(content) {
      agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readAgentState(mailbox)?.lastAck?.requestId === request.requestId)
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 99)
        assert.fail("session-start recovery did not consume the request");
    }
    assert.deepEqual(agent.sentUsers, [controlMarker(request.requestId)]);
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      request.requestId,
    );
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("managed input handles duplicate markers before and after cleanup idempotently", async () => {
  const mailbox = setAgentEnvironment("duplicate-marker-agent");
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "accept once",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    const input = agent.events.get("input")![0];
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "transform",
        text: request.text,
      },
    );
    const accepted = readAgentState(mailbox)!;
    assert.equal(accepted.lastAck?.requestId, request.requestId);
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "handled",
      },
    );
    assert.deepEqual(readAgentState(mailbox)?.lastAck, accepted.lastAck);
    removeRequest(mailbox, request.requestId);
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "handled",
      },
    );
    assert.deepEqual(readAgentState(mailbox)?.lastAck, accepted.lastAck);
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("managed pump retransmits an unacknowledged marker", async () => {
  const mailbox = setAgentEnvironment("pump-in-flight-agent");
  const agent = fakePi({ sendUserMessage: () => undefined });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "retry this marker",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(agent.sentUsers.length >= 2);
    assert.ok(
      agent.sentUsers.every(
        (marker) => marker === controlMarker(request.requestId),
      ),
    );
    assert.ok(readRequest(mailbox, request.requestId));
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("managed pump retries a request after acknowledgement persistence fails", async () => {
  const mailbox = setAgentEnvironment("pump-retry-agent");
  let context: ReturnType<typeof fakeContext>;
  let forcedFailures = 0;
  const agent = fakePi({
    sendUserMessage(content) {
      if (forcedFailures < 3) {
        forcedFailures++;
        support.failNextMailboxWrite = true;
      }
      agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  context = fakeContext();
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "retry this task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (agent.sentUsers.length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 99) assert.fail("mailbox pump did not submit request");
    }
    assert.ok(readRequest(mailbox, request.requestId));
    assert.equal(readAgentState(mailbox)?.lastAck, undefined);
    for (let attempt = 0; attempt < 250; attempt++) {
      if (readAgentState(mailbox)?.lastAck?.requestId === request.requestId)
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 249)
        assert.fail("mailbox pump did not retry the request");
    }
    assert.ok(agent.sentUsers.length >= 2);
    assert.equal(
      agent.entries.filter(
        (entry: any) => entry.customType === "pi_herdsman_state_error",
      ).length,
      1,
    );
    assert.equal(
      readAgentState(mailbox)?.lastAck?.requestId,
      request.requestId,
    );
    removeRequest(mailbox, request.requestId);
  } finally {
    support.failNextMailboxWrite = false;
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("registered agent writes state, handles input, and settles one result", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  assert.equal(
    agent.tools.filter((tool) => tool.name === "ask_owner").length,
    1,
  );
  const askSchema = agent.tools.find(
    (tool) => tool.name === "ask_owner",
  )!.parameters;
  assert.equal(
    Value.Check(askSchema, { question: "choose", files: ["options.md"] }),
    true,
  );
  assert.equal(agent.events.has("before_agent_start"), false);
  assert.ok(agent.events.has("input"));
  assert.ok(agent.events.has("message_end"));
  assert.ok(agent.events.has("agent_settled"));

  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const started = readAgentState(mailbox);
  assert.equal(started?.agentLabel, "registered-agent");
  assert.equal(started?.activeRequestId, undefined);
  agent.events.get("agent_settled")![0](undefined, context);
  const idleAfterStartup = readAgentState(mailbox);
  assert.equal(idleAfterStartup?.activeRequestId, undefined);
  assert.equal(idleAfterStartup?.completedRequestId, undefined);
  assert.equal(
    agent.calls.some((args) =>
      args.some((arg) => arg.startsWith("pi-herdsman:")),
    ),
    true,
  );

  const request: RequestRecord = {
    version: 4,
    runId: started!.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: started!.ownerSessionId,
    workspaceId: started!.workspaceId,
    agentLabel: started!.agentLabel,
    paneId: started!.paneId,
    kind: "task",
    text: "do the deterministic work",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  const legacyMarker = agent.events.get("input")![0](
    { text: `__HERDR_SUBAGENT_V2__:${request.requestId}` },
    context,
  );
  assert.deepEqual(
    legacyMarker,
    { action: "continue" },
    "the removed v2 marker must not be accepted as an agent request",
  );
  assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
  assert.ok(readRequest(mailbox, request.requestId));
  const ordinary = agent.events.get("input")![0]({ text: "ordinary" }, context);
  assert.deepEqual(ordinary, { action: "continue" });
  const accepted = agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  assert.deepEqual(accepted, {
    action: "transform",
    text: request.text,
  });
  agent.events.get("message_end")![0](
    { message: { role: "user", content: "ignored" } },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  agent.events.get("agent_settled")![0](undefined, context);
  agent.events.get("agent_settled")![0](undefined, context);
  const result = readResult(mailbox, request.requestId);
  assert.equal(result?.status, "completed");
  assert.equal(result?.text, "done");
  assert.equal(readAgentState(mailbox)?.completedRequestId, request.requestId);
  assert.equal(readAgentState(mailbox)?.lastActivityAt, undefined);
});

test("agent bounds result persistence failure and exposes owner recovery evidence", async (t) => {
  const label = "result-write-failure-agent";
  const mailbox = setAgentEnvironment(label);
  const agent = fakePi();
  const context = fakeContext();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "preserve the failed result evidence",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "unpersisted result" } },
    context,
  );
  realFs.mkdirSync(join(mailbox, `result-${request.requestId}.json`));
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  agent.events.get("agent_settled")![0](undefined, context);
  for (let attempt = 0; attempt < 7; attempt++) {
    t.mock.timers.tick(250);
    await Promise.resolve();
  }

  const recovered = readAgentState(mailbox)!;
  assert.equal(recovered.activeRequestId, undefined);
  assert.equal(recovered.completedRequestId, undefined);
  assert.equal(recovered.resultError?.code, "write_failure");
  assert.equal(recovered.resultError?.requestId, request.requestId);
  assert.equal(recovered.resultError?.runId, request.runId);
  assert.equal(recovered.resultError?.ownerSessionId, request.ownerSessionId);
  assert.equal(recovered.resultError?.agentLabel, request.agentLabel);
  assert.equal(recovered.resultError?.attempts, 8);
  assert.equal(recovered.resultError?.retrySafe, false);
  assert.equal(recovered.resultError?.cleanupSafe, true);
  assert.match(recovered.resultError?.nextAction ?? "", /close this agent/);

  agent.events.get("session_shutdown")?.[0]();
  const root = fakePi({
    exec: leadExec(
      label,
      "working",
      LEAD_SESSION_ID,
      undefined,
      LEAD_SESSION_ID,
      {
        paneId: "registered-pane",
        tabId: "registered-tab",
        piSessionId: LEAD_SESSION_ID,
        piSessionFile: "/tmp/root.jsonl",
      },
    ),
  });
  for (const key of [
    "PI_HERDSMAN_MAILBOX",
    "PI_HERDSMAN_RUN_ID",
    "PI_HERDSMAN_OWNER_SESSION_ID",
    "PI_HERDSMAN_LABEL",
    "PI_HERDSMAN_WORKSPACE_ID",
    "PI_HERDSMAN_AGENT_DEFINITION",
    "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
    "HERDR_PANE_ID",
  ])
    delete process.env[key];
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  registerExtension!(root.pi as never);
  const listed = await root.tools[0].execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    fakeContext(),
  );
  const listedAgent = (listed.details.agents as any[]).find(
    (item) => item.agent === label,
  );
  assert.equal(listedAgent?.state, "settling");
  assert.equal(listedAgent?.result_error.requestId, request.requestId);
  assert.equal(listedAgent?.result_error.code, "write_failure");
  root.events.get("session_shutdown")?.[0]();
  realFs.rmSync(join(mailbox, `result-${request.requestId}.json`), {
    recursive: true,
    force: true,
  });
  resetAgentMailbox(mailbox);
});

test("agent rejects task replay while result persistence recovery is present", () => {
  const label = "result-error-task-replay-agent";
  const mailbox = setAgentEnvironment(label);
  const recovery: NonNullable<ManagedAgentState["resultError"]> = {
    code: "write_failure",
    message: "Could not persist agent result after 8 attempts",
    requestId: REQUEST_ID,
    runId: AGENT_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: "registered-pane",
    originalStatus: "completed",
    attempts: 8,
    failedAt: Date.now(),
    retrySafe: false,
    cleanupSafe: true,
    nextAction:
      "Inspect result_error, resolve mailbox persistence, then close this agent before assigning new work.",
  };
  writeAgentState(mailbox, { ...managedState(label), resultError: recovery });

  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  agent.events.get("session_start")![0](undefined, context);
  const before = readAgentState(mailbox)!;
  const requestId = "99999999-9999-4999-8999-999999999999";
  const request: RequestRecord = {
    version: 4,
    runId: before.runId,
    requestId,
    ownerSessionId: before.ownerSessionId,
    workspaceId: before.workspaceId,
    agentLabel: before.agentLabel,
    paneId: before.paneId,
    kind: "task",
    text: "must not overwrite recovery state",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);

  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(requestId) }, context),
    { action: "handled" },
  );
  const after = readAgentState(mailbox)!;
  assert.equal(after.lastAck?.accepted, false);
  assert.equal(after.lastAck?.code, "busy");
  assert.equal(after.lastAck?.message, recovery.nextAction);
  assert.equal(after.activeRequestId, undefined);
  assert.equal(after.completedRequestId, undefined);
  assert.deepEqual(after.resultError, recovery);
  assert.deepEqual(
    { ...after, lastAck: undefined, updatedAt: undefined },
    { ...before, lastAck: undefined, updatedAt: undefined },
  );
  assert.equal(readRequest(mailbox, requestId), undefined);
  agent.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("agent ask_owner blocks settlement and reply resumes the same assignment", async () => {
  const mailbox = setAgentEnvironment();
  let context: ReturnType<typeof fakeAgentContext>;
  let pumpReply = false;
  let transformed: unknown;
  const agent = fakePi({
    sendUserMessage(content) {
      if (pumpReply)
        transformed = agent.events.get("input")![0]({ text: content }, context);
    },
  });
  registerExtension!(agent.pi as never);
  const askTool = agent.tools.find((tool) => tool.name === "ask_owner");
  assert.ok(askTool);
  const branch: unknown[] = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "ask_owner" }],
      },
    },
  ];
  context = fakeAgentContext([], branch);
  await agent.events.get("session_start")![0](undefined, context);
  const assignment: RequestRecord = {
    version: 4,
    runId: AGENT_ID,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WORKSPACE,
    agentLabel: "registered-agent",
    paneId: "registered-pane",
    kind: "task",
    text: "choose",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, assignment);
  assert.deepEqual(
    agent.events.get("input")![0](
      { text: controlMarker(assignment.requestId) },
      context,
    ),
    { action: "transform", text: assignment.text },
  );
  removeRequest(mailbox, assignment.requestId);
  branch[0] = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", name: "ask_owner" },
        { type: "toolCall", name: "read" },
      ],
    },
  };
  await assert.rejects(
    askTool.execute(
      "mixed",
      { question: "Do not persist this" },
      undefined,
      undefined,
      context,
    ),
    /call ask_owner alone as the final tool call/i,
  );
  assert.equal(readAgentState(mailbox)?.pendingAskId, undefined);
  assert.equal(readPendingAsk(mailbox, readAgentState(mailbox)!), undefined);
  const askFile = join(testTmpRoot, "registered-ask-options.md");
  realFs.writeFileSync(askFile, "owner options");
  branch[0] = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "ask_owner" }],
    },
  };
  await assert.rejects(
    askTool.execute(
      "missing-file",
      {
        question: "Should remain unpersisted",
        files: ["missing-ask-evidence.md"],
      },
      undefined,
      undefined,
      context,
    ),
    /does not exist|ENOENT|not found/i,
  );
  const invalidAskState = readAgentState(mailbox);
  assert.equal(invalidAskState?.pendingAskId, undefined);
  assert.equal(readPendingAsk(mailbox, readAgentState(mailbox)!), undefined);
  assert.equal(invalidAskState?.activeRequestId, assignment.requestId);
  assert.equal(realFs.existsSync(join(mailbox, "ask.json")), false);
  const ask = await askTool.execute(
    "ask",
    {
      question: "Should the token be ALPHA or BETA?",
      files: [askFile],
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(ask.terminate, true);
  assert.deepEqual(ask.details, {
    askId: readAgentState(mailbox)?.pendingAskId,
    assignmentRequestId: assignment.requestId,
  });
  assert.match(
    (ask.content[0] as { text: string }).text,
    /assignment is blocked until the reply; the reply will resume it automatically/,
  );
  const waiting = readAgentState(mailbox);
  assert.equal(waiting?.activeRequestId, assignment.requestId);
  assert.ok(waiting?.pendingAskId);
  assert.match(
    readPendingAsk(mailbox, waiting!)?.question ?? "",
    /owner options/,
  );
  assert.match(
    readPendingAsk(mailbox, waiting!)?.question ?? "",
    /registered-ask-options\.md/,
  );
  agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, assignment.requestId), undefined);

  const reply: RequestRecord = {
    version: 4,
    runId: AGENT_ID,
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ownerSessionId: assignment.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: assignment.agentLabel,
    paneId: assignment.paneId,
    kind: "reply",
    askId: waiting!.pendingAskId,
    text: "Use ALPHA.",
    createdAt: Date.now(),
  };
  pumpReply = true;
  writeRequest(mailbox, reply);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (readAgentState(mailbox)?.lastAck?.requestId === reply.requestId) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (attempt === 99) assert.fail("mailbox pump did not deliver the reply");
  }
  assert.deepEqual(transformed, {
    action: "transform",
    text: "Owner reply:\n\nUse ALPHA.\n\nContinue the original assignment using this answer.",
  });
  const resumed = readAgentState(mailbox);
  assert.equal(resumed?.activeRequestId, assignment.requestId);
  assert.equal(resumed?.pendingAskId, undefined);
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "ALPHA" } },
    context,
  );
  agent.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, assignment.requestId)?.text, "ALPHA");
  realFs.rmSync(askFile, { force: true });
});

test("message limits do not consult project trust", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const branch: unknown[] = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "ask_owner" }],
      },
    },
  ];
  const context = fakeAgentContext([], branch);
  const assignment: RequestRecord = {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: "registered-agent",
    paneId: "registered-pane",
    kind: "task",
    text: "choose",
    createdAt: Date.now(),
  };
  try {
    await agent.events.get("session_start")![0](undefined, context);
    writeRequest(mailbox, assignment);
    assert.deepEqual(
      agent.events.get("input")![0](
        { text: controlMarker(REQUEST_ID) },
        context,
      ),
      { action: "transform", text: assignment.text },
    );
    context.isProjectTrusted = () => {
      throw new Error("message limits must not consult project trust");
    };
    const askTool = agent.tools.find((tool) => tool.name === "ask_owner");
    assert.ok(askTool);
    await askTool.execute(
      "global-only-limits",
      { question: "Which option?" },
      undefined,
      undefined,
      context,
    );
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("ask_owner eligibility permits only ask-blocked direct-agent escalation", async () => {
  const cases = [
    { name: "no child", children: [], allowed: true },
    {
      name: "active child",
      children: [{ kind: "active" as const }],
      allowed: false,
    },
    {
      name: "pending-result child",
      children: [{ kind: "pending-result" as const }],
      allowed: false,
    },
    {
      name: "one ask-blocked child",
      children: [{ kind: "ask-blocked" as const }],
      allowed: true,
    },
    {
      name: "multiple ask-blocked children",
      children: [{ kind: "ask-blocked" as const }, { kind: "ask-blocked" }],
      allowed: true,
    },
    {
      name: "ask-blocked plus active child",
      children: [{ kind: "ask-blocked" as const }, { kind: "active" }],
      allowed: false,
    },
    {
      name: "ask-blocked plus pending-result child",
      children: [{ kind: "ask-blocked" as const }, { kind: "pending-result" }],
      allowed: false,
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const parentLabel = "ask-gate-parent-" + index;
    const mailbox = setAgentEnvironment(parentLabel);
    const parent = managedState(parentLabel, REQUEST_ID);
    writeAgentState(mailbox, parent);
    for (const [childIndex, childCase] of scenario.children.entries()) {
      const childLabel = "ask-gate-child-" + index + "-" + childIndex;
      const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
      const childRequestId = randomUUID();
      const askId = randomUUID();
      const child: ManagedAgentState = {
        ...managedState(childLabel, childRequestId, {
          ...recoveryIdentity(childLabel),
          paneId: childLabel + "-pane",
        }),
        ownerSessionId: parent.piSessionId,
        ...(childCase.kind === "ask-blocked" ? { pendingAskId: askId } : {}),
        ...(childCase.kind === "pending-result"
          ? {
              activeRequestId: undefined,
              completedRequestId: childRequestId,
            }
          : {}),
      };
      resetAgentMailbox(childMailbox);
      writeAgentState(childMailbox, child);
      if (childCase.kind === "ask-blocked")
        writeAsk(childMailbox, {
          version: 4,
          askId,
          requestId: childRequestId,
          runId: child.runId,
          ownerSessionId: child.ownerSessionId,
          workspaceId: child.workspaceId,
          agentLabel: child.agentLabel,
          paneId: child.paneId,
          piSessionId: child.piSessionId,
          question: "Need the parent's decision",
          createdAt: Date.now(),
        });
      if (childCase.kind === "pending-result")
        writeResult(childMailbox, {
          version: 4,
          runId: child.runId,
          requestId: childRequestId,
          ownerSessionId: child.ownerSessionId,
          workspaceId: child.workspaceId,
          agentLabel: child.agentLabel,
          paneId: child.paneId,
          status: "completed",
          text: "child result",
          completedAt: Date.now(),
        });
    }

    const branch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "ask_owner" }],
        },
      },
    ];
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext([], branch);
    await agent.events.get("session_start")![0](undefined, context);
    const askTool = agent.tools.find((tool) => tool.name === "ask_owner");
    assert.ok(askTool);
    if (scenario.allowed) {
      const result = await askTool.execute(
        "ask",
        { question: "Escalate: " + scenario.name },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.terminate, true, scenario.name);
      assert.ok(readAgentState(mailbox)?.pendingAskId, scenario.name);
    } else {
      await assert.rejects(
        askTool.execute(
          "ask",
          { question: "Reject: " + scenario.name },
          undefined,
          undefined,
          context,
        ),
        /cannot ask its owner:/,
        scenario.name,
      );
      assert.equal(readAgentState(mailbox)?.pendingAskId, undefined);
    }
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("idle parent steers through its current input turn while agent work is pending", async () => {
  const parentMailbox = setAgentEnvironment("idle-steer-parent");
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("idle-steer-parent", REQUEST_ID);
  const child = {
    ...managedState(
      "idle-steer-child",
      randomUUID(),
      recoveryIdentity("idle-steer-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/idle-steer-child.jsonl",
  };
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext([
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
  const input = () => agent.events.get("input")![0];
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const idleSteer: RequestRecord = {
      version: 4,
      runId: parent.runId,
      requestId: randomUUID(),
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      kind: "steer",
      text: "idle steer",
      createdAt: Date.now(),
    };
    writeRequest(parentMailbox, idleSteer);
    const idleResult = input()(
      { text: controlMarker(idleSteer.requestId) },
      context,
    );
    assert.deepEqual(
      idleResult,
      {
        action: "transform",
        text: idleSteer.text,
      },
      JSON.stringify({
        state: readAgentState(parentMailbox),
        request: readRequest(parentMailbox, idleSteer.requestId),
      }),
    );
    assert.equal(agent.sentUsers.length, 0);
    assert.equal(readAgentState(parentMailbox)?.activeRequestId, REQUEST_ID);
    assert.deepEqual(readAgentState(childMailbox), child);

    const staleCompletedRequestId = randomUUID();
    writeAgentState(childMailbox, {
      ...child,
      activeRequestId: undefined,
      completedRequestId: staleCompletedRequestId,
    });
    assert.equal(readResult(childMailbox, staleCompletedRequestId), undefined);
    const staleCompletedSteer: RequestRecord = {
      ...idleSteer,
      requestId: randomUUID(),
      text: "stale completed steer",
      createdAt: Date.now(),
    };
    writeRequest(parentMailbox, staleCompletedSteer);
    assert.deepEqual(
      input()({ text: controlMarker(staleCompletedSteer.requestId) }, context),
      { action: "handled" },
    );
    assert.equal(agent.sentUsers.length, 0);
    assert.equal(readAgentState(parentMailbox)?.lastAck?.accepted, false);

    writeAgentState(childMailbox, child);
    const activeSteer: RequestRecord = {
      ...idleSteer,
      requestId: randomUUID(),
      text: "active steer",
      createdAt: Date.now(),
    };
    writeRequest(parentMailbox, activeSteer);
    (context as any).isIdle = () => false;
    assert.deepEqual(
      input()({ text: controlMarker(activeSteer.requestId) }, context),
      {
        action: "transform",
        text: activeSteer.text,
      },
    );
    assert.equal(agent.sentUsers.length, 0);
    assert.deepEqual(agent.sentUserCalls, []);
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("parent settlement waits for agent delivery and ignores result cleanup lag", async () => {
  setAgentEnvironment("delegating-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("delegating-parent");
  const childOne = {
    ...managedState("child-one", REQUEST_ID, recoveryIdentity("child-one")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/child-one.jsonl",
  };
  const secondRequestId = randomUUID();
  const childTwo = {
    ...managedState(
      "child-two",
      secondRequestId,
      recoveryIdentity("child-two"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/child-two.jsonl",
  };
  const thirdRequestId = randomUUID();
  const childThree = {
    ...managedState(
      "child-three",
      thirdRequestId,
      recoveryIdentity("child-three"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/child-three.jsonl",
  };
  const foreignChild = {
    ...managedState(
      "foreign-child",
      randomUUID(),
      recoveryIdentity("foreign-child"),
    ),
    workspaceId: "foreign-workspace",
    ownerSessionId: parent.piSessionId,
    piSessionId: "33333333-3333-4333-8333-333333333333",
    piSessionFile: "/tmp/foreign-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childOneMailbox = agentMailboxPath(WORKSPACE, childOne.agentLabel);
  const childTwoMailbox = agentMailboxPath(WORKSPACE, childTwo.agentLabel);
  const childThreeMailbox = agentMailboxPath(WORKSPACE, childThree.agentLabel);
  const foreignChildMailbox = agentMailboxPath(
    foreignChild.workspaceId,
    foreignChild.agentLabel,
  );
  for (const mailbox of [
    parentMailbox,
    childOneMailbox,
    childTwoMailbox,
    childThreeMailbox,
    foreignChildMailbox,
  ])
    resetAgentMailbox(mailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childOneMailbox, childOne);
  writeAgentState(childTwoMailbox, childTwo);
  writeAgentState(childThreeMailbox, childThree);
  writeAgentState(foreignChildMailbox, foreignChild);
  const entries = [
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
    exec: agentControllerExecutor(parent, [
      childOne,
      childTwo,
      childThree,
      foreignChild,
    ]),
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    writeAgentState(childTwoMailbox, {
      ...childTwo,
      activeRequestId: undefined,
      completedRequestId: secondRequestId,
      updatedAt: Date.now(),
    });
    writeResult(childTwoMailbox, {
      version: 4,
      runId: childTwo.runId,
      requestId: secondRequestId,
      ownerSessionId: childTwo.ownerSessionId,
      workspaceId: childTwo.workspaceId,
      agentLabel: childTwo.agentLabel,
      paneId: childTwo.paneId,
      status: "completed",
      text: "durable two",
      completedAt: Date.now(),
    });

    const parentRequestId = randomUUID();
    writeRequest(parentMailbox, {
      version: 4,
      runId: parent.runId,
      requestId: parentRequestId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      kind: "task",
      text: "integrate the agents",
      createdAt: Date.now(),
    });
    const input = pi.events.get("input")![0];
    assert.deepEqual(input({ text: controlMarker(parentRequestId) }, context), {
      action: "transform",
      text: "integrate the agents",
    });
    pi.events.get("message_end")![0](
      { message: { role: "assistant", content: "premature answer" } },
      context,
    );
    const settle = pi.events.get("agent_settled")![0];
    settle(undefined, context);
    assert.equal(readResult(parentMailbox, parentRequestId), undefined);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );

    const deliver = (
      child: ManagedAgentState,
      mailbox: string,
      text: string,
    ) => {
      const requestId = child.activeRequestId ?? child.completedRequestId;
      assert.ok(requestId);
      writeAgentState(mailbox, {
        ...child,
        activeRequestId: undefined,
        completedRequestId: requestId,
        updatedAt: Date.now(),
      });
      writeResult(mailbox, {
        version: 4,
        runId: child.runId,
        requestId,
        ownerSessionId: child.ownerSessionId,
        workspaceId: child.workspaceId,
        agentLabel: child.agentLabel,
        paneId: child.paneId,
        status: "completed",
        text,
        completedAt: Date.now(),
      });
      watchedResultPaths.get(`${mailbox}/result-${requestId}.json`)?.({}, {});
    };
    const sentContent = (index: number): string =>
      String((pi.sentMessageCalls[index]?.message as any)?.content ?? "");
    let earlyResultStatus: string | undefined;
    deliver(childOne, childOneMailbox, "one");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) =>
          message.customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
      "completion status must not be delivered as a separate steer",
    );
    assert.equal(pi.sent.length, 1);
    assert.equal(
      (pi.sentMessageCalls[0].message as any).customType,
      "pi-herdsman-agent-result",
    );
    assert.deepEqual(pi.sentMessageCalls[0].options, {
      triggerTurn: true,
      deliverAs: "steer",
    });
    assert.match(
      String((pi.sentMessageCalls[0].message as any).content),
      /Delegation status:/,
    );
    assert.equal(
      (pi.sentMessageCalls[0].message as any).details
        .unresolvedDirectChildCount,
      2,
    );
    assert.equal(
      (pi.sentMessageCalls[0].message as any).details.activeDirectChildCount,
      1,
    );
    assert.equal(
      (pi.sentMessageCalls[0].message as any).details.pendingDirectResultCount,
      1,
    );
    assert.match(
      String((pi.sentMessageCalls[0].message as any).content),
      /Delegation status: 1 active direct agent; 1 pending direct result; 2 direct agent assignments remain unresolved\./,
    );
    assert.match(
      String((pi.sentMessageCalls[0].message as any).content),
      /useful decisions or take useful actions based on partial agent results/i,
    );
    assert.match(
      String((pi.sentMessageCalls[0].message as any).content),
      /do not conclude or produce the final synthesis/i,
    );
    assert.equal(
      readResult(childOneMailbox, childOne.activeRequestId!)?.text,
      "one",
    );
    entries.push({
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(childOne, childOne.activeRequestId!),
    });
    settle(undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pi.sent.length, 1);
    assert.deepEqual(
      pi.sentMessageCalls.slice(0, 2).map(({ message, options }) => ({
        customType: (message as any).customType,
        options,
      })),
      [
        {
          customType: "pi-herdsman-agent-result",
          options: { triggerTurn: true, deliverAs: "steer" },
        },
      ],
    );
    assert.equal(readResult(parentMailbox, parentRequestId), undefined);

    deliver(childTwo, childTwoMailbox, "two");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pi.sent.length, 2);
    assert.equal(
      (pi.sentMessageCalls[1].message as any).details.activeDirectChildCount,
      1,
    );
    assert.equal(
      (pi.sentMessageCalls[1].message as any).details.pendingDirectResultCount,
      0,
    );
    assert.match(
      String((pi.sentMessageCalls[1].message as any).content),
      /Delegation status: 1 active direct agent; 0 pending direct results; 1 direct agent assignment remains unresolved\./,
    );
    assert.equal(
      readResult(childTwoMailbox, childTwo.activeRequestId!)?.text,
      "two",
    );
    // Child two was accepted by pi.sendMessage above, but its owner-session
    // result entry is still not observable. It remains unresolved alongside
    // child three; no second status steer is sent while it awaits persistence.
    assert.equal(
      entries.some(
        (entry: any) =>
          (entry.customType === "pi-herdsman-agent-result" ||
            entry.message?.customType === "pi-herdsman-agent-result") &&
          (entry.details?.requestId ?? entry.message?.details?.requestId) ===
            childTwo.activeRequestId,
      ),
      false,
    );
    settle(undefined, context);
    assert.equal(pi.sent.length, 2);
    entries.push({
      message: {
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(childTwo, childTwo.activeRequestId!),
      },
    });
    settle(undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The parent observes durable child delivery but does not own child
    // cleanup; each one-shot child removes its own result after delivery.
    assert.ok(readResult(childOneMailbox, childOne.activeRequestId!));
    assert.ok(readResult(childTwoMailbox, childTwo.activeRequestId!));
    assert.equal(readResult(parentMailbox, parentRequestId), undefined);
    deliver(childThree, childThreeMailbox, "three");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pi.sent.length, 3);
    writeAgentState(childThreeMailbox, {
      ...childThree,
      activeRequestId: undefined,
      completedRequestId: thirdRequestId,
      updatedAt: Date.now(),
    });
    writeResult(childThreeMailbox, {
      version: 4,
      runId: childThree.runId,
      requestId: thirdRequestId,
      ownerSessionId: childThree.ownerSessionId,
      workspaceId: childThree.workspaceId,
      agentLabel: childThree.agentLabel,
      paneId: childThree.paneId,
      status: "completed",
      text: "three",
      completedAt: Date.now(),
    });
    settle(undefined, context);
    assert.equal(readResult(parentMailbox, parentRequestId), undefined);
    entries.push({
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(childThree, thirdRequestId),
    });
    settle(undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pi.sent.length, 3);
    assert.match(
      sentContent(2),
      /Delegation status: 0 active direct agents; 0 pending direct results; all direct agent assignments are resolved\./,
    );
    assert.equal(
      (pi.sentMessageCalls[2].message as any).details
        .unresolvedDirectChildCount,
      0,
    );
    assert.equal(
      (pi.sentMessageCalls[2].message as any).details.activeDirectChildCount,
      0,
    );
    assert.equal(
      (pi.sentMessageCalls[2].message as any).details.pendingDirectResultCount,
      0,
    );
    assert.match(
      sentContent(2),
      /Delegation status: 0 active direct agents; 0 pending direct results; all direct agent assignments are resolved\./,
    );
    assert.ok(readResult(childThreeMailbox, thirdRequestId));
    earlyResultStatus = readResult(parentMailbox, parentRequestId)?.status;
    assert.equal(
      readAgentState(parentMailbox)?.completedRequestId,
      parentRequestId,
    );
    removeResult(parentMailbox, parentRequestId);
    assert.ok(readResult(childThreeMailbox, thirdRequestId));
    assert.match(
      sentContent(0),
      /2 direct agent assignments remain unresolved/,
    );
    assert.match(
      sentContent(1),
      /1 direct agent assignment remains unresolved/,
    );
    assert.match(
      sentContent(2),
      /Delegation status: 0 active direct agents; 0 pending direct results; all direct agent assignments are resolved\./,
    );
    assert.equal(earlyResultStatus, "failed");
    settle(undefined, context);
    assert.equal(
      pi.sent.filter(
        (message: any) =>
          message.customType === "pi-herdsman-delegation-guidance",
      ).length,
      0,
      "completion status must never be published as a separate steer",
    );
    assert.deepEqual(
      pi.sentMessageCalls.map(({ message }) => (message as any).customType),
      [
        "pi-herdsman-agent-result",
        "pi-herdsman-agent-result",
        "pi-herdsman-agent-result",
      ],
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of [
      parentMailbox,
      childOneMailbox,
      childTwoMailbox,
      childThreeMailbox,
      foreignChildMailbox,
    ])
      resetAgentMailbox(mailbox);
  }
});

test("startup and completion metadata omit unavailable model and thinking values", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));

  const startup = agent.calls.find((args) => args.includes("managed=1"));
  assert.ok(startup);
  assert.equal(
    startup.some((arg) => /^(model|thinking)=(undefined|null)$/.test(arg)),
    false,
  );
  const hasClear = (name: string) =>
    startup.some(
      (arg, index) => arg === "--clear-token" && startup[index + 1] === name,
    );
  assert.equal(hasClear("model"), true);
  assert.equal(hasClear("thinking"), true);

  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: started.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccd",
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "check unavailable metadata",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  const callsBeforeSettlement = agent.calls.length;
  agent.events.get("agent_settled")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));

  const completion = agent.calls
    .slice(callsBeforeSettlement)
    .find((args) => args.includes("--clear-token") && args.includes("task"));
  assert.ok(completion);
  assert.equal(
    completion.some((arg) => /^(model|thinking)=(undefined|null)$/.test(arg)),
    false,
  );
  agent.events.get("session_shutdown")?.[0]();
});

test("startup and completion metadata preserve available model and thinking values", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext() as any;
  context.model = { provider: "openai", id: "gpt-5" };
  context.thinkingLevel = "high";
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));

  const startup = agent.calls.find((args) => args.includes("managed=1"));
  assert.ok(startup);
  assert.ok(startup.includes("model=openai/gpt-5"));
  assert.ok(startup.includes("thinking=high"));
  assert.equal(
    startup.some(
      (arg, index) =>
        arg === "--clear-token" &&
        ["model", "thinking"].includes(startup[index + 1]),
    ),
    false,
  );

  context.thinkingLevel = "low";
  context.model = { provider: "openai", id: "gpt-5.1" };
  const callsBeforeModelChange = agent.calls.length;
  agent.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5.1" } },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const changed = agent.calls
    .slice(callsBeforeModelChange)
    .find((args) => args.includes("model=openai/gpt-5.1"));
  assert.ok(changed?.includes("thinking=low"));

  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: started.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-ccccccccccce",
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "check available metadata",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  const callsBeforeSettlement = agent.calls.length;
  agent.events.get("agent_settled")![0](undefined, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const laterCalls = agent.calls.slice(callsBeforeSettlement);
  assert.equal(
    laterCalls.some(
      (args) =>
        args.includes("model=openai/gpt-5") || args.includes("thinking=high"),
    ),
    false,
  );
  assert.ok(changed?.includes("model=openai/gpt-5.1"));
  assert.ok(changed?.includes("thinking=low"));
  agent.events.get("session_shutdown")?.[0]();
});

test("successful presentation clears are not repeated by unrelated metadata updates", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const startup = agent.calls.find((args) => args.includes("managed=1"));
  assert.ok(startup);
  const hasClear = (args: string[], name: string) =>
    args.some(
      (arg, index) => arg === "--clear-token" && args[index + 1] === name,
    );
  assert.equal(hasClear(startup, "model"), true);
  assert.equal(hasClear(startup, "thinking"), true);
  const request = writeMetadataTask(mailbox, "unrelated metadata update");
  const beforeTask = agent.calls.length;
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const taskPublication = agent.calls
    .slice(beforeTask)
    .find((args) => args.some((arg) => arg === `task=${request.text}`));
  assert.ok(taskPublication);
  assert.equal(hasClear(taskPublication, "model"), false);
  assert.equal(hasClear(taskPublication, "thinking"), false);
  (context as any).thinkingLevel = "high";
  (context as any).model = { provider: "openai", id: "gpt-5.1" };
  agent.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5.1" } },
    context,
  );
  agent.events.get("thinking_level_select")![0]({ level: "high" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(agent.calls.some((args) => args.includes("model=openai/gpt-5.1")));
  assert.ok(agent.calls.some((args) => args.includes("thinking=high")));
  agent.events.get("session_shutdown")?.[0]();
});

test("metadata failure retries the latest desired state", async () => {
  const mailbox = setAgentEnvironment();
  let metadataAttempts = 0;
  const agent = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "pane") {
        metadataAttempts++;
        if (metadataAttempts === 1)
          return { stdout: "", stderr: "metadata failed", code: 7 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  agent.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5" } },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(metadataAttempts, 2);
  assert.ok(agent.calls.some((args) => args.includes("managed=1")));
  assert.ok(agent.calls.some((args) => args.includes("role=agent")));
  assert.ok(agent.calls.some((args) => args.includes("model=openai/gpt-5")));
  assert.equal(readAgentState(mailbox)?.agentLabel, "registered-agent");
  agent.events.get("session_shutdown")?.[0]();
});

test("empty agent metadata succeeds and later reports remain usable", async () => {
  setAgentEnvironment();
  let metadataAttempts = 0;
  const agent = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "pane") {
        metadataAttempts++;
        if (metadataAttempts === 1) return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    registerExtension!(agent.pi as never);
    const context = fakeContext();
    await agent.events.get("session_start")![0](undefined, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(metadataAttempts, 1);
    agent.events.get("model_select")![0](
      { model: { provider: "openai", id: "gpt-5" } },
      context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.equal(metadataAttempts, 2);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    agent.events.get("session_shutdown")?.[0]();
  }
});

test("failed completion metadata cannot be bypassed by presentation updates", async (t) => {
  const mailbox = setAgentEnvironment();
  const taskText = "retry this task metadata";
  let taskMetadataFailures = 0;
  let completionFailures = 0;
  let completionMetadataStarted = false;
  const agent = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "pane") {
        if (
          !completionMetadataStarted &&
          args.includes(`task=${taskText}`) &&
          taskMetadataFailures < 2
        ) {
          taskMetadataFailures++;
          throw new Error("temporary task metadata failure");
        }
        if (
          completionMetadataStarted &&
          completionFailures < 2 &&
          args.includes("--clear-token")
        ) {
          completionFailures++;
          return {
            stdout: "",
            stderr: "temporary completion metadata failure",
            code: 7,
          };
        }
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  t.after(() => agent.events.get("session_shutdown")?.[0]());
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await waitForTestCondition(
    () =>
      readAgentState(mailbox) !== undefined &&
      agent.callResults.length === agent.calls.length,
    "agent startup did not settle",
    2000,
  );
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: started.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: taskText,
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  await waitForTestCondition(
    () => readAgentState(mailbox)?.activeRequestId === request.requestId,
    "task request was not accepted",
    2000,
  );
  assert.equal(typeof readAgentState(mailbox)?.lastActivityAt, "number");
  agent.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5" } },
    context,
  );
  await waitForTestCondition(
    () =>
      agent.callResults.filter(
        ({ args, succeeded }) =>
          !succeeded && args.includes(`task=${taskText}`),
      ).length >= 2,
    "task metadata failures were not observed",
    2000,
  );
  await waitForTestCondition(
    () => agent.callResults.length === agent.calls.length,
    "task metadata calls did not settle",
    2000,
  );
  assert.ok(agent.calls.some((args) => args.includes(`task=${request.text}`)));
  assert.ok(agent.calls.some((args) => args.includes(`task=${request.text}`)));

  agent.events.get("turn_end")![0](undefined, context);

  agent.events.get("message_end")![0](
    { message: { role: "assistant", content: "completed" } },
    context,
  );
  await waitForTestCondition(
    () => agent.callResults.length === agent.calls.length,
    "turn metadata did not settle",
    2000,
  );
  const callsBeforeSettlement = agent.calls.length;
  assert.equal(readAgentState(mailbox)?.activeRequestId, request.requestId);
  completionMetadataStarted = true;
  agent.events.get("agent_settled")![0](undefined, context);
  await waitForTestCondition(
    () =>
      agent.callResults
        .slice(callsBeforeSettlement)
        .some(
          ({ args, succeeded }) =>
            args.includes("--clear-token") &&
            args.includes("task") &&
            !succeeded,
        ),
    "first completion metadata clear did not fail",
    2000,
  );
  assert.ok(
    agent.calls
      .slice(callsBeforeSettlement)
      .some((args) => args.includes("--clear-token") && args.includes("task")),
  );
  const completionFailure =
    callsBeforeSettlement +
    agent.calls
      .slice(callsBeforeSettlement)
      .findIndex(
        (args) => args.includes("--clear-token") && args.includes("task"),
      );
  assert.ok(completionFailure >= 0);
  agent.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5" } },
    context,
  );
  await waitForTestCondition(
    () =>
      agent.callResults.filter(
        ({ args, succeeded }) =>
          args.includes("--clear-token") && args.includes("task") && !succeeded,
      ).length >= 2,
    "second completion metadata clear did not fail",
    2000,
  );
  assert.equal(
    agent.calls
      .slice(completionFailure + 1)
      .some(
        (args) =>
          args.some((arg) => arg.startsWith("model=")) &&
          args.some((arg) => arg.startsWith("task=")),
      ),
    false,
    "a later model event must not resurrect cleared task metadata",
  );
  agent.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5.1" } },
    context,
  );
  await waitForTestCondition(
    () =>
      agent.callResults.some(
        ({ args, succeeded }) =>
          succeeded &&
          args.includes("--clear-token") &&
          args.includes("task") &&
          args.includes("model=openai/gpt-5.1"),
      ),
    "completion metadata clear did not recover",
    2000,
  );
  assert.equal(completionFailures, 2);
  const completionClears = agent.callResults.filter(
    ({ args }, index) =>
      index >= callsBeforeSettlement &&
      args.includes("--clear-token") &&
      args.includes("request") &&
      args.includes("task") &&
      args.includes("started"),
  );
  assert.equal(
    completionClears.filter(({ succeeded }) => !succeeded).length,
    2,
    "both injected completion-clear failures must be actual failed exec calls",
  );
  assert.equal(completionClears[0].succeeded, false);
  assert.equal(completionClears[1].succeeded, false);
  assert.equal(completionClears[0].code, 7);
  assert.equal(completionClears[1].code, 7);
  for (const { args } of completionClears) {
    assert.ok(args.includes("pane"));
    assert.ok(args.includes("report-metadata"));
    assert.ok(args.includes("--title"));
    assert.ok(args.includes("registered-agent"));
    assert.ok(args.includes("--display-agent"));
    assert.ok(args.includes("agent"));
    assert.ok(args.includes("managed=1"));
    assert.ok(args.includes("role=agent"));
  }
  const successfulClearRecord = completionClears.find(
    ({ succeeded }, index) => index >= 2 && succeeded,
  );
  assert.ok(successfulClearRecord, "a later completion clear must succeed");
  const firstFailedClear = agent.callResults.indexOf(completionClears[0]);
  const secondFailedClear = agent.callResults.indexOf(completionClears[1]);
  const successfulClear = agent.callResults.indexOf(successfulClearRecord);
  assert.ok(firstFailedClear < secondFailedClear);
  assert.ok(secondFailedClear < successfulClear);
  assert.deepEqual(
    completionClears[2].args.filter(
      (arg) =>
        arg.startsWith("--clear-token") ||
        ["request", "task", "started"].includes(arg),
    ),
    [
      "--clear-token",
      "request",
      "--clear-token",
      "task",
      "--clear-token",
      "started",
    ],
  );
  assert.equal(
    agent.callResults
      .slice(secondFailedClear + 1, successfulClear)
      .some(({ args }) =>
        args.some((arg) =>
          /^(model|thinking|ctx|request|task|started)=/.test(arg),
        ),
      ),
    false,
    "no newer metadata update may drain while the failed clear is pending",
  );
  assert.ok(successfulClearRecord.args.includes("model=openai/gpt-5.1"));
  assert.equal(
    successfulClearRecord.args.some((arg) =>
      /^(task|request|started|ctx)=/.test(arg),
    ),
    false,
    "the recovered completion report must not resurrect completed activity",
  );
  agent.events.get("session_shutdown")?.[0]();
});

test("agent reload preserves an active request", async () => {
  const mailbox = setAgentEnvironment();
  const state = managedState("registered-agent", REQUEST_ID);
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  agent.events.get("session_start")![0]({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = readAgentState(mailbox)!;
  assert.equal(reloaded.activeRequestId, REQUEST_ID);
  assert.equal(typeof reloaded.lastActivityAt, "number");
  assert.deepEqual(reloaded.lastAck, state.lastAck);
  agent.events.get("session_shutdown")?.[0]();
  const sameSessionMailbox = setAgentEnvironment();
  writeAgentState(
    sameSessionMailbox,
    managedState("registered-agent", REQUEST_ID),
  );
  const sameSessionAgent = fakePi();
  registerExtension!(sameSessionAgent.pi as never);
  sameSessionAgent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readAgentState(sameSessionMailbox)?.activeRequestId, REQUEST_ID);
  sameSessionAgent.events.get("session_shutdown")?.[0]();
});

test("agent reload preserves a completed request awaiting delivery", async () => {
  const mailbox = setAgentEnvironment();
  const state = managedState("registered-agent");
  state.completedRequestId = REQUEST_ID;
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  agent.events.get("session_start")![0]({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = readAgentState(mailbox)!;
  assert.equal(reloaded.completedRequestId, REQUEST_ID);
  assert.deepEqual(reloaded.lastAck, state.lastAck);
  agent.events.get("session_shutdown")?.[0]();
  const sameSessionMailbox = setAgentEnvironment();
  const sameSessionState = managedState("registered-agent");
  sameSessionState.completedRequestId = REQUEST_ID;
  writeAgentState(sameSessionMailbox, sameSessionState);
  const sameSessionAgent = fakePi();
  registerExtension!(sameSessionAgent.pi as never);
  sameSessionAgent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    readAgentState(sameSessionMailbox)?.completedRequestId,
    REQUEST_ID,
  );
  sameSessionAgent.events.get("session_shutdown")?.[0]();
});

test("active state plus matching durable result repairs to completed", async () => {
  const mailbox = setAgentEnvironment();
  writeAgentState(mailbox, managedState("registered-agent", REQUEST_ID));
  writeResult(mailbox, {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: "registered-agent",
    paneId: "registered-pane",
    status: "completed",
    text: "recovered",
    completedAt: Date.now(),
  });
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  agent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const repaired = readAgentState(mailbox)!;
  assert.equal(repaired.activeRequestId, undefined);
  assert.equal(repaired.completedRequestId, REQUEST_ID);
  assert.equal(repaired.lastActivityAt, undefined);
  agent.events.get("session_shutdown")?.[0]();
});

test("agent registers native activity events and coalesces activity writes", async () => {
  const mailbox = setAgentEnvironment();
  writeAgentState(mailbox, managedState("registered-agent", REQUEST_ID));
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  const realNow = Date.now;
  Date.now = () => 2_000_000;
  await agent.events.get("session_start")![0](undefined, context);
  for (const event of [
    "turn_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
  ])
    assert.equal(agent.events.has(event), true, event);
  assert.equal(agent.events.has("tool_execution_update"), false);
  const before = readAgentState(mailbox)!.lastActivityAt!;
  agent.events.get("message_update")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, before);
  Date.now = () => 1_000_000;
  agent.events.get("message_update")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, 1_000_000);
  const afterMessage = readAgentState(mailbox)!.lastActivityAt;
  agent.events.get("tool_execution_update")?.[0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, afterMessage);
  Date.now = () => 1_006_000;
  agent.events.get("tool_execution_start")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, 1_006_000);
  Date.now = () => 1_012_000;
  agent.events.get("tool_execution_end")![0]({}, context);
  assert.equal(readAgentState(mailbox)!.lastActivityAt, 1_012_000);
  Date.now = realNow;
  agent.events.get("session_shutdown")?.[0]();
});

test("managed agents cap direct built-in shell calls without explicit timeouts", async () => {
  setAgentEnvironment();
  const cases = [
    {
      name: "bash",
      toolName: "bash",
      source: "builtin",
      input: { command: "sleep 1" },
      timeout: 600,
    },
    {
      name: "powershell",
      toolName: "powershell",
      source: "builtin",
      input: { command: "Start-Sleep 1" },
      timeout: 600,
    },
    {
      name: "explicit bash timeout",
      toolName: "bash",
      source: "builtin",
      input: { command: "sleep 1", timeout: 17 },
      timeout: 17,
    },
    {
      name: "built-in bash without timeout schema",
      toolName: "bash",
      source: "builtin",
      input: { command: "sleep 1" },
      timeout: undefined,
      hasTimeoutProperty: false,
    },
    {
      name: "extension-owned bash",
      toolName: "bash",
      source: "extension",
      input: { command: "sleep 1" },
      timeout: undefined,
    },
    {
      name: "unrelated custom tool",
      toolName: "custom",
      source: "extension",
      input: { value: "x" },
      timeout: undefined,
    },
  ] as const;
  for (const scenario of cases) {
    const agent = fakePi({
      allTools: [
        {
          name: scenario.toolName,
          parameters: {
            type: "object",
            properties:
              scenario.hasTimeoutProperty === false ? {} : { timeout: {} },
          },
          sourceInfo: { source: scenario.source },
        },
      ],
    });
    registerExtension!(agent.pi as never);
    const input = { ...scenario.input };
    await agent.events.get("tool_call")![0](
      { toolName: scenario.toolName, input },
      fakeAgentContext(),
    );
    assert.equal(input.timeout, scenario.timeout, scenario.name);
  }
});

test("agent restart forces an active activity touch within the coalescing window", async () => {
  const mailbox = setAgentEnvironment();
  const state = {
    ...managedState("registered-agent", REQUEST_ID),
    lastActivityAt: Date.now() - 1_000,
  };
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  await agent.events.get("session_start")![0](
    { reason: "reload" },
    fakeAgentContext(),
  );
  assert.ok(readAgentState(mailbox)!.lastActivityAt! > state.lastActivityAt);
  agent.events.get("session_shutdown")?.[0]();
});

test("mismatched result never repairs agent state", async () => {
  const mailbox = setAgentEnvironment();
  writeAgentState(mailbox, managedState("registered-agent", REQUEST_ID));
  writeResult(mailbox, {
    version: 4,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: "other-agent",
    paneId: "registered-pane",
    status: "completed",
    text: "wrong",
    completedAt: Date.now(),
  });
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  agent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.equal(readAgentState(mailbox)?.completedRequestId, undefined);
  agent.events.get("session_shutdown")?.[0]();
  const malformedMailbox = setAgentEnvironment();
  const state = managedState("registered-agent", REQUEST_ID);
  writeAgentState(malformedMailbox, state);
  writeFileSync(
    join(malformedMailbox, `result-${REQUEST_ID}.json`),
    "{malformed",
    "utf8",
  );
  const malformedAgent = fakePi();
  registerExtension!(malformedAgent.pi as never);
  malformedAgent.events.get("session_start")![0](
    { reason: "startup" },
    fakeAgentContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = readAgentState(malformedMailbox)!;
  assert.equal(recovered.activeRequestId, state.activeRequestId);
  assert.equal(recovered.completedRequestId, undefined);
  malformedAgent.events.get("session_shutdown")?.[0]();
});

test("agent reload rejects a different Pi session identity", () => {
  const mailbox = setAgentEnvironment();
  const state = managedState("registered-agent", REQUEST_ID);
  writeAgentState(mailbox, state);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext();
  (context as any).sessionManager = {
    ...context.sessionManager,
    getSessionId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };
  agent.events.get("session_start")![0]({ reason: "reload" }, context);
  assert.deepEqual(readAgentState(mailbox), state);
  agent.events.get("session_shutdown")?.[0]();
});

test("metadata initialization serializes repeats and rejects stale generations", async () => {
  setAgentEnvironment();
  const pending: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  const agent = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "pane") {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active--;
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 1);
  assert.equal(agent.calls.length, 1);
  pending.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.calls.length, 2);
  assert.equal(maximum, 1);
  assert.ok(agent.calls[1].includes("registered-agent"));
  assert.ok(agent.calls[1].includes("--clear-token"));
  assert.equal(
    agent.calls[1].some((arg) => arg.includes("old")),
    false,
  );
  pending.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.calls.length, 2);
  agent.events.get("session_shutdown")?.[0]();
  {
    const mailbox = setAgentEnvironment();
    const gates: (() => void)[] = [];
    const agent = fakePi({
      exec: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    registerExtension!(agent.pi as never);
    const context = fakeContext();
    agent.events.get("session_start")![0](undefined, context);
    await new Promise((resolve) => setImmediate(resolve));
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    const request = writeMetadataTask(mailbox, "old generation task");
    agent.events.get("input")![0](
      { text: controlMarker(request.requestId) },
      context,
    );
    assert.equal(agent.calls.length, 2);
    agent.events.get("session_start")![0](undefined, context);
    assert.equal(agent.calls.length, 2);
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.calls.length, 3);
    const startup = agent.calls[2];
    assert.ok(startup.includes("registered-agent"));
    assert.ok(startup.includes("--clear-token"));
    assert.equal(
      startup.some((arg) => arg === `task=${request.text}`),
      false,
    );
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.calls.length, 3);
    agent.events.get("session_shutdown")?.[0]();
  }
});

test("metadata outage retains one latest desired snapshot", async () => {
  const mailbox = setAgentEnvironment();
  let attempts = 0;
  const agent = fakePi({
    exec: async () => {
      attempts++;
      return attempts === 1
        ? { stdout: "", stderr: "outage", code: 7 }
        : { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const request = writeMetadataTask(
    mailbox,
    "coalesced task",
    "cccccccc-cccc-4ccc-8ccc-ccccccccccdf",
  );
  agent.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  const intermediateModels = ["model-0", "model-1", "model-2"];
  for (let i = 0; i < 100; i++) {
    const model = `model-${i}`;
    const thinking = `thinking-${i}`;
    agent.events.get("model_select")![0](
      { model: { provider: "test", id: model } },
      context,
    );
    agent.events.get("thinking_level_select")![0]({ level: thinking }, context);
    (context as any).getContextUsage = () => ({
      tokens: i + 1,
      contextWindow: 100,
      percent: i + 1,
    });
    agent.events.get("turn_end")![0](undefined, context);
  }
  const finalModel = "test/model-99";
  const finalThinking = "thinking-99";
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = agent.calls.at(-1)!;
  assert.equal(attempts, 3);
  assert.ok(recovered.includes(`model=${finalModel}`));
  assert.ok(recovered.includes(`thinking=${finalThinking}`));
  assert.ok(recovered.includes("ctx=100"));
  for (const value of intermediateModels)
    assert.equal(
      recovered.some((arg) => arg.includes(value)),
      false,
    );
  assert.equal(agent.calls.length, 3);
  agent.events.get("session_shutdown")?.[0]();
});

test("agent shutdown invalidates in-flight metadata", async () => {
  const firstMailbox = setAgentEnvironment();
  let aborted = false;
  const agent = fakePi({
    exec: async (_command, _args, options) => {
      await new Promise<void>((resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("metadata aborted"));
          },
          { once: true },
        );
      });
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.calls.length, 1);
  agent.events.get("session_shutdown")?.[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(agent.execOptions[0].signal?.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.calls.length, 1);
  const successorMailbox = setAgentEnvironment();
  agent.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.calls.length, 2);
  const successor = agent.calls[1];
  assert.ok(successor.includes("registered-agent"));
  assert.ok(successor.includes("--clear-token"));
  assert.ok(successor.includes("model"));
  assert.ok(successor.includes("thinking"));
  assert.equal(readAgentState(successorMailbox)?.activeRequestId, undefined);
  assert.equal(firstMailbox, successorMailbox);
  agent.events.get("session_shutdown")?.[0]();
});

test("task state-write failure retains the request for an exact retry", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: started.paneId,
    kind: "task",
    text: "retry after durable state recovery",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  support.failNextMailboxWrite = true;
  const failed = agent.events.get("input")![0](
    { text: controlMarker(REQUEST_ID) },
    context,
  );
  assert.deepEqual(failed, { action: "handled" });
  assert.equal(readAgentState(mailbox)?.activeRequestId, undefined);
  assert.ok(readRequest(mailbox, REQUEST_ID));
  const retried = agent.events.get("input")![0](
    { text: controlMarker(REQUEST_ID) },
    context,
  );
  assert.deepEqual(retried, { action: "transform", text: request.text });
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  agent.events.get("session_shutdown")?.[0]();
});

test("acknowledgement state-write failure retains an identity-rejected request", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeContext();
  await agent.events.get("session_start")![0](undefined, context);
  const started = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    agentLabel: started.agentLabel,
    paneId: "different-pane",
    kind: "task",
    text: "retry after acknowledgement write failure",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  support.failNextMailboxWrite = true;
  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context),
    { action: "handled" },
  );
  assert.equal(readAgentState(mailbox)?.lastAck, undefined);
  assert.ok(readRequest(mailbox, REQUEST_ID));

  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context),
    { action: "handled" },
  );
  assert.deepEqual(readAgentState(mailbox)?.lastAck, {
    requestId: REQUEST_ID,
    accepted: false,
    code: "identity",
    message: "Request identity did not match agent state",
    acknowledgedAt: readAgentState(mailbox)!.lastAck!.acknowledgedAt,
  });
  assert.equal(readRequest(mailbox, REQUEST_ID), undefined);
  agent.events.get("session_shutdown")?.[0]();
});

test("a stray agent variable does not suppress lead registration", () => {
  setLeadEnvironment();
  const lead = fakePi();
  registerExtension!(lead.pi as never);
  assert.equal(lead.tools.length, 1);
  assert.equal(lead.tools[0].name, "agent");
  assert.deepEqual(lead.commands, ["agents"]);
});

test("session agent identity reads the session-wide entry array", () => {
  assert.deepEqual(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "current-session",
            definition: "reviewer",
            label: "reviewer",
          },
        },
        { type: "message" },
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "current-session",
            definition: "reviewer",
            label: "reviewer",
          },
        },
      ],
      "current-session",
    ),
    {
      sessionId: "current-session",
      definition: "reviewer",
      label: "reviewer",
    },
  );
  assert.equal(sessionAgentIdentity([], "current-session"), undefined);
  assert.equal(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { name: "reviewer" },
        },
      ],
      "current-session",
    ),
    undefined,
  );
  assert.throws(
    () =>
      sessionAgentIdentity(
        [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: "current-session",
              definition: 42,
              label: "reviewer",
            },
          },
        ],
        "current-session",
      ),
    /invalid pi-herdsman-agent-definition entry/,
  );
  assert.throws(
    () =>
      sessionAgentIdentity(
        [
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: "current-session",
              definition: "reviewer",
              label: "reviewer",
            },
          },
          {
            type: "custom",
            customType: "pi-herdsman-agent-definition",
            data: {
              sessionId: "current-session",
              definition: "implementer",
              label: "reviewer",
            },
          },
        ],
        "current-session",
      ),
    /conflicting pi-herdsman-agent-definition entries/,
  );
  assert.deepEqual(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "current-session",
            definition: "reviewer",
            label: "reviewer",
          },
        },
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: "other-session",
            definition: "reviewer",
            label: "other",
          },
        },
      ],
      "current-session",
    ),
    {
      sessionId: "current-session",
      definition: "reviewer",
      label: "reviewer",
    },
  );
});

test("automatic compaction retires an active managed session exactly once", async () => {
  const mailbox = setAgentEnvironment("retirement-agent");
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  await agent.events.get("session_start")![0](undefined, context);
  const state = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "retire this task",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  assert.deepEqual(
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context),
    { action: "transform", text: request.text },
  );

  const compact = agent.events.get("session_before_compact")![0];
  assert.deepEqual(compact({ reason: "threshold" }, context), {
    cancel: true,
  });
  assert.equal(
    sessionContextRetired(
      context.sessionManager.getEntries(),
      context.sessionManager.getSessionId(),
    ),
    true,
  );
  assert.equal(compact({ reason: "threshold" }, context), undefined);
  assert.equal(compact({ reason: "overflow" }, context), undefined);
  assert.equal(compact({ reason: "manual" }, context), undefined);

  const injected = agent.events.get("context")![1]?.(
    { messages: [{ role: "user", content: "work" }] },
    context,
  );
  const contextResult =
    injected ??
    agent.events.get("context")![0]?.(
      { messages: [{ role: "user", content: "work" }] },
      context,
    );
  assert.ok(contextResult);
  assert.match(contextResult.messages.at(-1).content, /retired this session/i);
  assert.match(
    contextResult.messages.at(-1).content,
    /self-contained handoff/i,
  );
  agent.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("context retirement bypasses compaction behavior when disabled", async () => {
  updateConfig("contextRetirement", false);
  try {
    const mailbox = setAgentEnvironment("retirement-disabled-agent");
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext();
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "disabled retirement task",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context);
    assert.equal(
      agent.events.get("session_before_compact")![0](
        { reason: "threshold" },
        context,
      ),
      undefined,
    );
    assert.equal(
      agent.events.get("context")![0]({ messages: [] }, context),
      undefined,
    );
    assert.equal(
      sessionContextRetired(
        context.sessionManager.getEntries(),
        context.sessionManager.getSessionId(),
      ),
      false,
    );
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  } finally {
    updateConfig("contextRetirement", undefined);
  }
});

test("overflow retires without cancellation and inactive sessions stay untouched", async () => {
  const mailbox = setAgentEnvironment("retirement-overflow-agent");
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    const state = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "recover overflow safely",
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    agent.events.get("input")![0]({ text: controlMarker(REQUEST_ID) }, context);
    const compact = agent.events.get("session_before_compact")![0];
    assert.equal(compact({ reason: "overflow" }, context), undefined);
    assert.equal(compact({ reason: "threshold" }, context), undefined);
    assert.equal(
      sessionContextRetired(
        context.sessionManager.getEntries(),
        context.sessionManager.getSessionId(),
      ),
      true,
    );
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }

  const inactiveMailbox = setAgentEnvironment("retirement-inactive-agent");
  const inactiveAgent = fakePi();
  registerExtension!(inactiveAgent.pi as never);
  const inactiveContext = fakeAgentContext(inactiveAgent.entries);
  try {
    await inactiveAgent.events.get("session_start")![0](
      undefined,
      inactiveContext,
    );
    inactiveAgent.pi.appendEntry("pi-herdsman-agent-context-retired", {
      sessionId: inactiveContext.sessionManager.getSessionId(),
    });
    assert.equal(
      inactiveAgent.events.get("session_before_compact")![0](
        { reason: "threshold" },
        inactiveContext,
      ),
      undefined,
    );
    assert.equal(
      inactiveAgent.events.get("context")![0](
        { messages: [] },
        inactiveContext,
      ),
      undefined,
    );
  } finally {
    inactiveAgent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(inactiveMailbox);
  }
});

test("agent persists one identity entry before mailbox initialization", async () => {
  const mailbox = setAgentEnvironment();
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  const start = agent.events.get("session_start")![0];
  await start(undefined, context);
  await start({ reason: "reload" }, context);
  assert.deepEqual(agent.entries, [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: "registered-agent",
      },
    },
  ]);
  assert.ok(readAgentState(mailbox));
  agent.events.get("session_shutdown")?.[0]();
});

test("agent rejects a conflicting persisted session identity", async () => {
  const mailbox = setAgentEnvironment("registered-agent");
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: "other-agent",
      },
    },
  ];
  const agent = fakePi({ entries });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(entries);
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  await agent.events.get("session_start")![0](undefined, context);
  assert.ok(
    notices.some((message) =>
      message.includes("session identity does not match environment"),
    ),
  );
  agent.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("a forked session establishes identity for its own Pi session", async () => {
  const mailbox = setAgentEnvironment("forked-agent");
  const copiedIdentity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: {
      sessionId: "source-session",
      definition: "agent",
      label: "source-agent",
    },
  };
  const copiedLegacyIdentity = {
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { name: "old-agent" },
  };
  const agent = fakePi({ entries: [copiedIdentity, copiedLegacyIdentity] });
  registerExtension!(agent.pi as never);
  const context = fakeAgentContext(agent.entries);
  try {
    await agent.events.get("session_start")![0](undefined, context);
    assert.deepEqual(agent.entries, [
      copiedIdentity,
      copiedLegacyIdentity,
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          definition: "agent",
          label: "forked-agent",
        },
      },
    ]);
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("owner ask delivery is branch-local and recovers on tree navigation", async () => {
  setLeadEnvironment();
  const label = "ask-delivery-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const requestId = REQUEST_ID;
  const waiting = {
    ...managedState(label, requestId, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeAgentState(mailbox, waiting);
  const ask: AskRecord = {
    version: 4,
    askId: waiting.pendingAskId!,
    requestId,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    agentLabel: waiting.agentLabel,
    paneId: waiting.paneId,
    piSessionId: waiting.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  };
  writeAsk(mailbox, ask);
  const branch: unknown[] = [];
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
  registerExtension!(pi.pi as never);
  const context = fakeContext([], branch);
  await pi.events.get("session_start")![0](undefined, context);
  assert.equal(pi.sent.length, 1);
  assert.deepEqual((pi.sent[0] as any).details, {
    askId: ask.askId,
    question: ask.question,
    requestId,
    runId: ask.runId,
    agentLabel: label,
    workspaceId: WORKSPACE,
    paneId: identity.paneId,
    piSessionId: identity.piSessionId,
  });
  branch.push({ customType: "pi-herdsman-agent-ask", details: ask });
  pi.events.get("session_tree")![0](undefined, context);
  assert.equal(pi.sent.length, 1);
  branch.length = 0;
  pi.events.get("session_tree")![0](undefined, context);
  assert.equal(pi.sent.length, 2);
  assert.deepEqual(pi.sentMessageCalls[0]?.options, {
    triggerTurn: true,
  });
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("owner ask resolved while busy is not delivered after settlement", async () => {
  setLeadEnvironment();
  const label = "busy-resolved-ask";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const requestId = REQUEST_ID;
  const waiting = {
    ...managedState(label, requestId, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeAgentState(mailbox, waiting);
  writeAsk(mailbox, {
    version: 4,
    askId: waiting.pendingAskId!,
    requestId,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    agentLabel: waiting.agentLabel,
    paneId: waiting.paneId,
    piSessionId: waiting.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  });
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
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  (context as any).isIdle = () => false;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(pi.sent.length, 0);
    writeAgentState(mailbox, { ...waiting, pendingAskId: undefined });
    removeAsk(mailbox, waiting.pendingAskId!);
    (context as any).isIdle = () => true;
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler(undefined, context);
    assert.equal(pi.sent.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("owner ask waits while busy and delivers once after settlement", async () => {
  setLeadEnvironment();
  const label = "busy-pending-ask";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const requestId = REQUEST_ID;
  const waiting = {
    ...managedState(label, requestId, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeAgentState(mailbox, waiting);
  writeAsk(mailbox, {
    version: 4,
    askId: waiting.pendingAskId!,
    requestId,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    agentLabel: waiting.agentLabel,
    paneId: waiting.paneId,
    piSessionId: waiting.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  });
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
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  let idle = false;
  (context as any).isIdle = () => idle;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(pi.sent.length, 0);
    idle = true;
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler(undefined, context);
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-ask",
      ).length,
      1,
    );
    assert.deepEqual(pi.sentMessageCalls[0]?.options, { triggerTurn: true });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});
