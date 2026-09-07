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
  REQUEST_ID,
  LEAD_SESSION_ID,
  WORKER_ID,
  WORKSPACE,
  controlMarker,
  fakeContext,
  fakePi,
  fakeWorkerContext,
  managedState,
  workerControllerExecutor,
  readPendingAsk,
  readRequest,
  readResult,
  readWorkerState,
  realFs,
  recoveryIdentity,
  registerExtension,
  removeResult,
  resetWorkerMailbox,
  resultEntryDetails,
  leadExec,
  sessionAgentDefinition,
  setLeadEnvironment,
  setWorkerEnvironment,
  watchedResultPaths,
  workerMailboxPath,
  writeAsk,
  writeMetadataTask,
  writeRequest,
  writeResult,
  writeWorkerState,
} from "./support.ts";

test("managed workers cancel native session replacement", () => {
  setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  assert.deepEqual(
    worker.events.get("session_before_switch")![0](undefined, fakeContext()),
    { cancel: true },
  );
  assert.deepEqual(
    worker.events.get("session_before_fork")![0](undefined, fakeContext()),
    { cancel: true },
  );
  worker.events.get("session_shutdown")?.[0]();
});

test("registered worker writes state, handles input, and settles one result", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  assert.equal(
    worker.tools.filter((tool) => tool.name === "ask_owner").length,
    1,
  );
  const askSchema = worker.tools.find(
    (tool) => tool.name === "ask_owner",
  )!.parameters;
  assert.equal(
    Value.Check(askSchema, { question: "choose", files: ["options.md"] }),
    true,
  );
  assert.equal(worker.events.has("before_agent_start"), false);
  assert.ok(worker.events.has("input"));
  assert.ok(worker.events.has("message_end"));
  assert.ok(worker.events.has("agent_settled"));

  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const started = readWorkerState(mailbox);
  assert.equal(started?.workerLabel, "registered-worker");
  assert.equal(started?.activeRequestId, undefined);
  worker.events.get("agent_settled")![0](undefined, context);
  const idleAfterStartup = readWorkerState(mailbox);
  assert.equal(idleAfterStartup?.activeRequestId, undefined);
  assert.equal(idleAfterStartup?.completedRequestId, undefined);
  assert.equal(
    worker.calls.some((args) =>
      args.some((arg) => arg.startsWith("pi-herdsman:")),
    ),
    true,
  );

  const request: RequestRecord = {
    version: 3,
    runId: started!.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: started!.ownerSessionId,
    workspaceId: started!.workspaceId,
    workerLabel: started!.workerLabel,
    paneId: started!.paneId,
    kind: "task",
    text: "do the deterministic work",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  const legacyMarker = worker.events.get("input")![0](
    { text: `__HERDR_SUBAGENT_V2__:${request.requestId}` },
    context,
  );
  assert.deepEqual(
    legacyMarker,
    { action: "continue" },
    "the removed v2 marker must not be accepted as a worker request",
  );
  assert.equal(readWorkerState(mailbox)?.activeRequestId, undefined);
  assert.ok(readRequest(mailbox, request.requestId));
  const ordinary = worker.events.get("input")![0](
    { text: "ordinary" },
    context,
  );
  assert.deepEqual(ordinary, { action: "continue" });
  const accepted = worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  assert.deepEqual(accepted, {
    action: "transform",
    text: request.text,
  });
  worker.events.get("message_end")![0](
    { message: { role: "user", content: "ignored" } },
    context,
  );
  worker.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  worker.events.get("agent_settled")![0](undefined, context);
  worker.events.get("agent_settled")![0](undefined, context);
  const result = readResult(mailbox, request.requestId);
  assert.equal(result?.status, "completed");
  assert.equal(result?.text, "done");
  assert.equal(readWorkerState(mailbox)?.completedRequestId, request.requestId);
  assert.equal(readWorkerState(mailbox)?.lastActivityAt, undefined);
});

test("worker bounds result persistence failure and exposes owner recovery evidence", async (t) => {
  const label = "result-write-failure-worker";
  const mailbox = setWorkerEnvironment(label);
  const worker = fakePi();
  const context = fakeContext();
  registerExtension!(worker.pi as never);
  await worker.events.get("session_start")![0](undefined, context);
  const started = readWorkerState(mailbox)!;
  const request: RequestRecord = {
    version: 3,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    workerLabel: started.workerLabel,
    paneId: started.paneId,
    kind: "task",
    text: "preserve the failed result evidence",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  worker.events.get("message_end")![0](
    { message: { role: "assistant", content: "unpersisted result" } },
    context,
  );
  realFs.mkdirSync(join(mailbox, `result-${request.requestId}.json`));
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  worker.events.get("agent_settled")![0](undefined, context);
  for (let attempt = 0; attempt < 7; attempt++) {
    t.mock.timers.tick(250);
    await Promise.resolve();
  }

  const recovered = readWorkerState(mailbox)!;
  assert.equal(recovered.activeRequestId, undefined);
  assert.equal(recovered.completedRequestId, undefined);
  assert.equal(recovered.resultError?.code, "write_failure");
  assert.equal(recovered.resultError?.requestId, request.requestId);
  assert.equal(recovered.resultError?.runId, request.runId);
  assert.equal(recovered.resultError?.ownerSessionId, request.ownerSessionId);
  assert.equal(recovered.resultError?.workerLabel, request.workerLabel);
  assert.equal(recovered.resultError?.attempts, 8);
  assert.equal(recovered.resultError?.retrySafe, false);
  assert.equal(recovered.resultError?.cleanupSafe, true);
  assert.match(recovered.resultError?.nextAction ?? "", /close this worker/);

  worker.events.get("session_shutdown")?.[0]();
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
    "PI_HERDSMAN_ALLOWED_WORKERS",
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
  const listedWorker = (listed.details.workers as any[]).find(
    (item) => item.worker === label,
  );
  assert.equal(listedWorker?.state, "settling");
  assert.equal(listedWorker?.result_error.requestId, request.requestId);
  assert.equal(listedWorker?.result_error.code, "write_failure");
  root.events.get("session_shutdown")?.[0]();
  realFs.rmSync(join(mailbox, `result-${request.requestId}.json`), {
    recursive: true,
    force: true,
  });
  resetWorkerMailbox(mailbox);
});

test("worker rejects task replay while result persistence recovery is present", () => {
  const label = "result-error-task-replay-worker";
  const mailbox = setWorkerEnvironment(label);
  const recovery: NonNullable<WorkerState["resultError"]> = {
    code: "write_failure",
    message: "Could not persist worker result after 8 attempts",
    requestId: REQUEST_ID,
    runId: WORKER_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: label,
    paneId: "registered-pane",
    originalStatus: "completed",
    attempts: 8,
    failedAt: Date.now(),
    retrySafe: false,
    cleanupSafe: true,
    nextAction:
      "Inspect result_error, resolve mailbox persistence, then close this worker before assigning new work.",
  };
  writeWorkerState(mailbox, { ...managedState(label), resultError: recovery });

  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext();
  worker.events.get("session_start")![0](undefined, context);
  const before = readWorkerState(mailbox)!;
  const requestId = "99999999-9999-4999-8999-999999999999";
  const request: RequestRecord = {
    version: 3,
    runId: before.runId,
    requestId,
    ownerSessionId: before.ownerSessionId,
    workspaceId: before.workspaceId,
    workerLabel: before.workerLabel,
    paneId: before.paneId,
    kind: "task",
    text: "must not overwrite recovery state",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);

  assert.deepEqual(
    worker.events.get("input")![0]({ text: controlMarker(requestId) }, context),
    { action: "handled" },
  );
  const after = readWorkerState(mailbox)!;
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
  worker.events.get("session_shutdown")?.[0]();
  resetWorkerMailbox(mailbox);
});

test("worker ask_owner blocks settlement and reply resumes the same assignment", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const askTool = worker.tools.find((tool) => tool.name === "ask_owner");
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
  const context = fakeWorkerContext([], branch);
  await worker.events.get("session_start")![0](undefined, context);
  const assignment: RequestRecord = {
    version: 3,
    runId: WORKER_ID,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WORKSPACE,
    workerLabel: "registered-worker",
    paneId: "registered-pane",
    kind: "task",
    text: "choose",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, assignment);
  assert.deepEqual(
    worker.events.get("input")![0](
      { text: controlMarker(assignment.requestId) },
      context,
    ),
    { action: "transform", text: assignment.text },
  );
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
  assert.equal(readWorkerState(mailbox)?.pendingAskId, undefined);
  assert.equal(readPendingAsk(mailbox, readWorkerState(mailbox)!), undefined);
  const askFile = join("/tmp", "registered-ask-options.md");
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
  const invalidAskState = readWorkerState(mailbox);
  assert.equal(invalidAskState?.pendingAskId, undefined);
  assert.equal(readPendingAsk(mailbox, readWorkerState(mailbox)!), undefined);
  assert.equal(invalidAskState?.activeRequestId, assignment.requestId);
  assert.equal(realFs.existsSync(join(mailbox, "ask.json")), false);
  const ask = await askTool.execute(
    "ask",
    {
      question: "Should the token be ALPHA or BETA?",
      files: ["registered-ask-options.md"],
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(ask.terminate, true);
  assert.deepEqual(ask.details, {
    askId: readWorkerState(mailbox)?.pendingAskId,
    assignmentRequestId: assignment.requestId,
  });
  assert.match(
    (ask.content[0] as { text: string }).text,
    /assignment is blocked until the reply; the reply will resume it automatically/,
  );
  const waiting = readWorkerState(mailbox);
  assert.equal(waiting?.activeRequestId, assignment.requestId);
  assert.ok(waiting?.pendingAskId);
  assert.match(
    readPendingAsk(mailbox, waiting!)?.question ?? "",
    /owner options/,
  );
  assert.match(
    readPendingAsk(mailbox, waiting!)?.question ?? "",
    /\/tmp\/registered-ask-options\.md/,
  );
  worker.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, assignment.requestId), undefined);

  const reply: RequestRecord = {
    version: 3,
    runId: WORKER_ID,
    requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ownerSessionId: assignment.ownerSessionId,
    workspaceId: WORKSPACE,
    workerLabel: assignment.workerLabel,
    paneId: assignment.paneId,
    kind: "reply",
    askId: waiting!.pendingAskId,
    text: "Use ALPHA.",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, reply);
  assert.deepEqual(
    worker.events.get("input")![0](
      { text: controlMarker(reply.requestId) },
      context,
    ),
    {
      action: "transform",
      text: "Owner reply:\n\nUse ALPHA.\n\nContinue the original assignment using this answer.",
    },
  );
  const resumed = readWorkerState(mailbox);
  assert.equal(resumed?.activeRequestId, assignment.requestId);
  assert.equal(resumed?.pendingAskId, undefined);
  worker.events.get("message_end")![0](
    { message: { role: "assistant", content: "ALPHA" } },
    context,
  );
  worker.events.get("agent_settled")![0](undefined, context);
  assert.equal(readResult(mailbox, assignment.requestId)?.text, "ALPHA");
  realFs.rmSync(askFile, { force: true });
});

test("ask_owner eligibility permits only ask-blocked direct-worker escalation", async () => {
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
    const mailbox = setWorkerEnvironment(parentLabel);
    const parent = managedState(parentLabel, REQUEST_ID);
    writeWorkerState(mailbox, parent);
    for (const [childIndex, childCase] of scenario.children.entries()) {
      const childLabel = "ask-gate-child-" + index + "-" + childIndex;
      const childMailbox = workerMailboxPath(WORKSPACE, childLabel);
      const childRequestId = randomUUID();
      const askId = randomUUID();
      const child: WorkerState = {
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
      resetWorkerMailbox(childMailbox);
      writeWorkerState(childMailbox, child);
      if (childCase.kind === "ask-blocked")
        writeAsk(childMailbox, {
          version: 3,
          askId,
          requestId: childRequestId,
          runId: child.runId,
          ownerSessionId: child.ownerSessionId,
          workspaceId: child.workspaceId,
          workerLabel: child.workerLabel,
          paneId: child.paneId,
          piSessionId: child.piSessionId,
          question: "Need the parent's decision",
          createdAt: Date.now(),
        });
      if (childCase.kind === "pending-result")
        writeResult(childMailbox, {
          version: 3,
          runId: child.runId,
          requestId: childRequestId,
          ownerSessionId: child.ownerSessionId,
          workspaceId: child.workspaceId,
          workerLabel: child.workerLabel,
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
    const worker = fakePi();
    registerExtension!(worker.pi as never);
    const context = fakeWorkerContext([], branch);
    await worker.events.get("session_start")![0](undefined, context);
    const askTool = worker.tools.find((tool) => tool.name === "ask_owner");
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
      assert.ok(readWorkerState(mailbox)?.pendingAskId, scenario.name);
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
      assert.equal(readWorkerState(mailbox)?.pendingAskId, undefined);
    }
    worker.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(mailbox);
  }
});

test("idle parent steers through its current input turn while worker work is pending", async () => {
  const parentMailbox = setWorkerEnvironment("idle-steer-parent");
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
  const childMailbox = workerMailboxPath(WORKSPACE, child.workerLabel);
  resetWorkerMailbox(childMailbox);
  writeWorkerState(parentMailbox, parent);
  writeWorkerState(childMailbox, child);
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext([
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "parent" },
    },
  ]);
  const input = () => worker.events.get("input")![0];
  try {
    await worker.events.get("session_start")![0](undefined, context);
    const idleSteer: RequestRecord = {
      version: 3,
      runId: parent.runId,
      requestId: randomUUID(),
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      workerLabel: parent.workerLabel,
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
        state: readWorkerState(parentMailbox),
        request: readRequest(parentMailbox, idleSteer.requestId),
      }),
    );
    assert.equal(worker.sentUsers.length, 0);
    assert.equal(readWorkerState(parentMailbox)?.activeRequestId, REQUEST_ID);
    assert.deepEqual(readWorkerState(childMailbox), child);

    const staleCompletedRequestId = randomUUID();
    writeWorkerState(childMailbox, {
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
    assert.equal(worker.sentUsers.length, 0);
    assert.equal(readWorkerState(parentMailbox)?.lastAck?.accepted, false);

    writeWorkerState(childMailbox, child);
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
        action: "handled",
      },
    );
    assert.equal(worker.sentUsers.length, 1);
    assert.deepEqual(worker.sentUserCalls, [
      {
        content: activeSteer.text,
        options: { deliverAs: "steer" },
      },
    ]);
  } finally {
    worker.events.get("session_shutdown")?.[0]();
    resetWorkerMailbox(parentMailbox);
    resetWorkerMailbox(childMailbox);
  }
});

test("parent settlement waits for worker delivery and ignores result cleanup lag", async () => {
  setWorkerEnvironment("delegating-parent", ["child"]);
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
  const parentMailbox = workerMailboxPath(WORKSPACE, parent.workerLabel);
  const childOneMailbox = workerMailboxPath(WORKSPACE, childOne.workerLabel);
  const childTwoMailbox = workerMailboxPath(WORKSPACE, childTwo.workerLabel);
  const childThreeMailbox = workerMailboxPath(
    WORKSPACE,
    childThree.workerLabel,
  );
  const foreignChildMailbox = workerMailboxPath(
    foreignChild.workspaceId,
    foreignChild.workerLabel,
  );
  for (const mailbox of [
    parentMailbox,
    childOneMailbox,
    childTwoMailbox,
    childThreeMailbox,
    foreignChildMailbox,
  ])
    resetWorkerMailbox(mailbox);
  writeWorkerState(parentMailbox, parent);
  writeWorkerState(childOneMailbox, childOne);
  writeWorkerState(childTwoMailbox, childTwo);
  writeWorkerState(childThreeMailbox, childThree);
  writeWorkerState(foreignChildMailbox, foreignChild);
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "parent" },
    },
  ];
  const pi = fakePi({
    entries,
    exec: workerControllerExecutor(parent, [
      childOne,
      childTwo,
      childThree,
      foreignChild,
    ]),
  });
  registerExtension!(pi.pi as never);
  const context = fakeWorkerContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    writeWorkerState(childTwoMailbox, {
      ...childTwo,
      activeRequestId: undefined,
      completedRequestId: secondRequestId,
      updatedAt: Date.now(),
    });
    writeResult(childTwoMailbox, {
      version: 3,
      runId: childTwo.runId,
      requestId: secondRequestId,
      ownerSessionId: childTwo.ownerSessionId,
      workspaceId: childTwo.workspaceId,
      workerLabel: childTwo.workerLabel,
      paneId: childTwo.paneId,
      status: "completed",
      text: "durable two",
      completedAt: Date.now(),
    });

    const parentRequestId = randomUUID();
    writeRequest(parentMailbox, {
      version: 3,
      runId: parent.runId,
      requestId: parentRequestId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      workerLabel: parent.workerLabel,
      paneId: parent.paneId,
      kind: "task",
      text: "integrate the workers",
      createdAt: Date.now(),
    });
    const input = pi.events.get("input")![0];
    assert.deepEqual(input({ text: controlMarker(parentRequestId) }, context), {
      action: "transform",
      text: "integrate the workers",
    });
    pi.events.get("message_end")![0](
      { message: { role: "assistant", content: "premature answer" } },
      context,
    );
    const settle = pi.events.get("agent_settled")![0];
    settle(undefined, context);
    assert.equal(readResult(parentMailbox, parentRequestId), undefined);
    assert.equal(
      readWorkerState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );

    const deliver = (child: WorkerState, mailbox: string, text: string) => {
      const requestId = child.activeRequestId ?? child.completedRequestId;
      assert.ok(requestId);
      writeWorkerState(mailbox, {
        ...child,
        activeRequestId: undefined,
        completedRequestId: requestId,
        updatedAt: Date.now(),
      });
      writeResult(mailbox, {
        version: 3,
        runId: child.runId,
        requestId,
        ownerSessionId: child.ownerSessionId,
        workspaceId: child.workspaceId,
        workerLabel: child.workerLabel,
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
      "pi-herdsman-worker-result",
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
      /Delegation status: 1 active direct worker; 1 pending direct result; 2 direct worker assignments remain unresolved\./,
    );
    assert.match(
      String((pi.sentMessageCalls[0].message as any).content),
      /useful decisions or take useful actions based on partial worker results/i,
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
      customType: "pi-herdsman-worker-result",
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
          customType: "pi-herdsman-worker-result",
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
      /Delegation status: 1 active direct worker; 0 pending direct results; 1 direct worker assignment remains unresolved\./,
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
          (entry.customType === "pi-herdsman-worker-result" ||
            entry.message?.customType === "pi-herdsman-worker-result") &&
          (entry.details?.requestId ?? entry.message?.details?.requestId) ===
            childTwo.activeRequestId,
      ),
      false,
    );
    settle(undefined, context);
    assert.equal(pi.sent.length, 2);
    entries.push({
      message: {
        customType: "pi-herdsman-worker-result",
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
    writeWorkerState(childThreeMailbox, {
      ...childThree,
      activeRequestId: undefined,
      completedRequestId: thirdRequestId,
      updatedAt: Date.now(),
    });
    writeResult(childThreeMailbox, {
      version: 3,
      runId: childThree.runId,
      requestId: thirdRequestId,
      ownerSessionId: childThree.ownerSessionId,
      workspaceId: childThree.workspaceId,
      workerLabel: childThree.workerLabel,
      paneId: childThree.paneId,
      status: "completed",
      text: "three",
      completedAt: Date.now(),
    });
    settle(undefined, context);
    assert.equal(readResult(parentMailbox, parentRequestId), undefined);
    entries.push({
      customType: "pi-herdsman-worker-result",
      details: resultEntryDetails(childThree, thirdRequestId),
    });
    settle(undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pi.sent.length, 3);
    assert.match(
      sentContent(2),
      /Delegation status: 0 active direct workers; 0 pending direct results; all direct worker assignments are resolved\./,
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
      /Delegation status: 0 active direct workers; 0 pending direct results; all direct worker assignments are resolved\./,
    );
    assert.ok(readResult(childThreeMailbox, thirdRequestId));
    earlyResultStatus = readResult(parentMailbox, parentRequestId)?.status;
    assert.equal(
      readWorkerState(parentMailbox)?.completedRequestId,
      parentRequestId,
    );
    removeResult(parentMailbox, parentRequestId);
    assert.ok(readResult(childThreeMailbox, thirdRequestId));
    assert.match(
      sentContent(0),
      /2 direct worker assignments remain unresolved/,
    );
    assert.match(
      sentContent(1),
      /1 direct worker assignment remains unresolved/,
    );
    assert.match(
      sentContent(2),
      /Delegation status: 0 active direct workers; 0 pending direct results; all direct worker assignments are resolved\./,
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
        "pi-herdsman-worker-result",
        "pi-herdsman-worker-result",
        "pi-herdsman-worker-result",
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
      resetWorkerMailbox(mailbox);
  }
});

test("startup and completion metadata omit unavailable model and thinking values", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));

  const startup = worker.calls.find((args) => args.includes("managed=1"));
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

  const started = readWorkerState(mailbox)!;
  const request: RequestRecord = {
    version: 3,
    runId: started.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccd",
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    workerLabel: started.workerLabel,
    paneId: started.paneId,
    kind: "task",
    text: "check unavailable metadata",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  worker.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  const callsBeforeSettlement = worker.calls.length;
  worker.events.get("agent_settled")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));

  const completion = worker.calls
    .slice(callsBeforeSettlement)
    .find((args) => args.includes("--clear-token") && args.includes("task"));
  assert.ok(completion);
  assert.equal(
    completion.some((arg) => /^(model|thinking)=(undefined|null)$/.test(arg)),
    false,
  );
  worker.events.get("session_shutdown")?.[0]();
});

test("startup and completion metadata preserve available model and thinking values", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeContext() as any;
  context.model = { provider: "openai", id: "gpt-5" };
  context.thinkingLevel = "high";
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));

  const startup = worker.calls.find((args) => args.includes("managed=1"));
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
  const callsBeforeModelChange = worker.calls.length;
  worker.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5.1" } },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const changed = worker.calls
    .slice(callsBeforeModelChange)
    .find((args) => args.includes("model=openai/gpt-5.1"));
  assert.ok(changed?.includes("thinking=low"));

  const started = readWorkerState(mailbox)!;
  const request: RequestRecord = {
    version: 3,
    runId: started.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-ccccccccccce",
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    workerLabel: started.workerLabel,
    paneId: started.paneId,
    kind: "task",
    text: "check available metadata",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  worker.events.get("message_end")![0](
    { message: { role: "assistant", content: "done" } },
    context,
  );
  const callsBeforeSettlement = worker.calls.length;
  worker.events.get("agent_settled")![0](undefined, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const laterCalls = worker.calls.slice(callsBeforeSettlement);
  assert.equal(
    laterCalls.some(
      (args) =>
        args.includes("model=openai/gpt-5") || args.includes("thinking=high"),
    ),
    false,
  );
  assert.ok(changed?.includes("model=openai/gpt-5.1"));
  assert.ok(changed?.includes("thinking=low"));
  worker.events.get("session_shutdown")?.[0]();
});

test("successful presentation clears are not repeated by unrelated metadata updates", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const startup = worker.calls.find((args) => args.includes("managed=1"));
  assert.ok(startup);
  const hasClear = (args: string[], name: string) =>
    args.some(
      (arg, index) => arg === "--clear-token" && args[index + 1] === name,
    );
  assert.equal(hasClear(startup, "model"), true);
  assert.equal(hasClear(startup, "thinking"), true);
  const request = writeMetadataTask(mailbox, "unrelated metadata update");
  const beforeTask = worker.calls.length;
  worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const taskPublication = worker.calls
    .slice(beforeTask)
    .find((args) => args.some((arg) => arg === `task=${request.text}`));
  assert.ok(taskPublication);
  assert.equal(hasClear(taskPublication, "model"), false);
  assert.equal(hasClear(taskPublication, "thinking"), false);
  (context as any).thinkingLevel = "high";
  (context as any).model = { provider: "openai", id: "gpt-5.1" };
  worker.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5.1" } },
    context,
  );
  worker.events.get("thinking_level_select")![0]({ level: "high" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(worker.calls.some((args) => args.includes("model=openai/gpt-5.1")));
  assert.ok(worker.calls.some((args) => args.includes("thinking=high")));
  worker.events.get("session_shutdown")?.[0]();
});

test("metadata failure retries the latest desired state", async () => {
  const mailbox = setWorkerEnvironment();
  let metadataAttempts = 0;
  const worker = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "pane") {
        metadataAttempts++;
        if (metadataAttempts === 1)
          return { stdout: "", stderr: "metadata failed", code: 7 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  worker.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5" } },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(metadataAttempts, 2);
  assert.ok(worker.calls.some((args) => args.includes("managed=1")));
  assert.ok(worker.calls.some((args) => args.includes("role=worker")));
  assert.ok(worker.calls.some((args) => args.includes("model=openai/gpt-5")));
  assert.equal(readWorkerState(mailbox)?.workerLabel, "registered-worker");
  worker.events.get("session_shutdown")?.[0]();
});

test("empty worker metadata succeeds and later reports remain usable", async () => {
  setWorkerEnvironment();
  let metadataAttempts = 0;
  const worker = fakePi({
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
    registerExtension!(worker.pi as never);
    const context = fakeContext();
    await worker.events.get("session_start")![0](undefined, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(metadataAttempts, 1);
    worker.events.get("model_select")![0](
      { model: { provider: "openai", id: "gpt-5" } },
      context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.equal(metadataAttempts, 2);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    worker.events.get("session_shutdown")?.[0]();
  }
});

test("failed completion metadata cannot be bypassed by presentation updates", async (t) => {
  const mailbox = setWorkerEnvironment();
  let metadataAttempts = 0;
  let completionFailures = 0;
  let completionMetadataStarted = false;
  const worker = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "pane") {
        metadataAttempts++;
        if (metadataAttempts === 2 || metadataAttempts === 3)
          throw new Error("temporary task metadata failure");
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
  t.after(() => worker.events.get("session_shutdown")?.[0]());
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const started = readWorkerState(mailbox)!;
  const request: RequestRecord = {
    version: 3,
    runId: started.runId,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    workerLabel: started.workerLabel,
    paneId: started.paneId,
    kind: "task",
    text: "retry this task metadata",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readWorkerState(mailbox)?.activeRequestId, request.requestId);
  assert.equal(typeof readWorkerState(mailbox)?.lastActivityAt, "number");
  worker.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5" } },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(worker.calls.some((args) => args.includes(`task=${request.text}`)));
  assert.ok(worker.calls.some((args) => args.includes(`task=${request.text}`)));

  worker.events.get("turn_end")![0](undefined, context);

  worker.events.get("message_end")![0](
    { message: { role: "assistant", content: "completed" } },
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeSettlement = worker.calls.length;
  assert.equal(readWorkerState(mailbox)?.activeRequestId, request.requestId);
  completionMetadataStarted = true;
  worker.events.get("agent_settled")![0](undefined, context);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(
    worker.calls
      .slice(callsBeforeSettlement)
      .some(
        (args) =>
          args.includes("--clear-token") &&
          args.includes("task") &&
          args.includes("ctx"),
      ),
  );
  const completionFailure =
    callsBeforeSettlement +
    worker.calls
      .slice(callsBeforeSettlement)
      .findIndex(
        (args) =>
          args.includes("--clear-token") &&
          args.includes("task") &&
          args.includes("ctx"),
      );
  assert.ok(completionFailure >= 0);
  worker.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5" } },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    worker.calls
      .slice(completionFailure + 1)
      .some(
        (args) =>
          args.some((arg) => arg.startsWith("model=")) &&
          args.some((arg) => arg.startsWith("task=")),
      ),
    false,
    "a later model event must not resurrect cleared task metadata",
  );
  worker.events.get("model_select")![0](
    { model: { provider: "openai", id: "gpt-5.1" } },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completionFailures, 2);
  const completionClears = worker.callResults.filter(
    ({ args }, index) =>
      index >= callsBeforeSettlement &&
      args.includes("--clear-token") &&
      args.includes("request") &&
      args.includes("task") &&
      args.includes("started") &&
      args.includes("ctx"),
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
    assert.ok(args.includes("registered-worker"));
    assert.ok(args.includes("--display-agent"));
    assert.ok(args.includes("worker"));
    assert.ok(args.includes("managed=1"));
    assert.ok(args.includes("role=worker"));
  }
  const successfulClearRecord = completionClears.find(
    ({ succeeded }, index) => index >= 2 && succeeded,
  );
  assert.ok(successfulClearRecord, "a later completion clear must succeed");
  const firstFailedClear = worker.callResults.indexOf(completionClears[0]);
  const secondFailedClear = worker.callResults.indexOf(completionClears[1]);
  const successfulClear = worker.callResults.indexOf(successfulClearRecord);
  assert.ok(firstFailedClear < secondFailedClear);
  assert.ok(secondFailedClear < successfulClear);
  assert.deepEqual(
    completionClears[2].args.filter(
      (arg) =>
        arg.startsWith("--clear-token") ||
        ["request", "task", "started", "ctx"].includes(arg),
    ),
    [
      "--clear-token",
      "request",
      "--clear-token",
      "task",
      "--clear-token",
      "started",
      "--clear-token",
      "ctx",
    ],
  );
  assert.equal(
    worker.callResults
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
  worker.events.get("session_shutdown")?.[0]();
});

test("worker reload preserves an active request", async () => {
  const mailbox = setWorkerEnvironment();
  const state = managedState("registered-worker", REQUEST_ID);
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeWorkerState(mailbox, state);
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext();
  worker.events.get("session_start")![0]({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = readWorkerState(mailbox)!;
  assert.equal(reloaded.activeRequestId, REQUEST_ID);
  assert.equal(typeof reloaded.lastActivityAt, "number");
  assert.deepEqual(reloaded.lastAck, state.lastAck);
  worker.events.get("session_shutdown")?.[0]();
  const sameSessionMailbox = setWorkerEnvironment();
  writeWorkerState(
    sameSessionMailbox,
    managedState("registered-worker", REQUEST_ID),
  );
  const sameSessionWorker = fakePi();
  registerExtension!(sameSessionWorker.pi as never);
  sameSessionWorker.events.get("session_start")![0](
    { reason: "startup" },
    fakeWorkerContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    readWorkerState(sameSessionMailbox)?.activeRequestId,
    REQUEST_ID,
  );
  sameSessionWorker.events.get("session_shutdown")?.[0]();
});

test("worker reload preserves a completed request awaiting delivery", async () => {
  const mailbox = setWorkerEnvironment();
  const state = managedState("registered-worker");
  state.completedRequestId = REQUEST_ID;
  state.lastAck = {
    requestId: REQUEST_ID,
    accepted: true,
    acknowledgedAt: Date.now(),
  };
  writeWorkerState(mailbox, state);
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext();
  worker.events.get("session_start")![0]({ reason: "reload" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = readWorkerState(mailbox)!;
  assert.equal(reloaded.completedRequestId, REQUEST_ID);
  assert.deepEqual(reloaded.lastAck, state.lastAck);
  worker.events.get("session_shutdown")?.[0]();
  const sameSessionMailbox = setWorkerEnvironment();
  const sameSessionState = managedState("registered-worker");
  sameSessionState.completedRequestId = REQUEST_ID;
  writeWorkerState(sameSessionMailbox, sameSessionState);
  const sameSessionWorker = fakePi();
  registerExtension!(sameSessionWorker.pi as never);
  sameSessionWorker.events.get("session_start")![0](
    { reason: "startup" },
    fakeWorkerContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    readWorkerState(sameSessionMailbox)?.completedRequestId,
    REQUEST_ID,
  );
  sameSessionWorker.events.get("session_shutdown")?.[0]();
});

test("active state plus matching durable result repairs to completed", async () => {
  const mailbox = setWorkerEnvironment();
  writeWorkerState(mailbox, managedState("registered-worker", REQUEST_ID));
  writeResult(mailbox, {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: "registered-worker",
    paneId: "registered-pane",
    status: "completed",
    text: "recovered",
    completedAt: Date.now(),
  });
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  worker.events.get("session_start")![0](
    { reason: "startup" },
    fakeWorkerContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const repaired = readWorkerState(mailbox)!;
  assert.equal(repaired.activeRequestId, undefined);
  assert.equal(repaired.completedRequestId, REQUEST_ID);
  assert.equal(repaired.lastActivityAt, undefined);
  worker.events.get("session_shutdown")?.[0]();
});

test("worker registers native activity events and coalesces activity writes", async () => {
  const mailbox = setWorkerEnvironment();
  writeWorkerState(mailbox, managedState("registered-worker", REQUEST_ID));
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext();
  const realNow = Date.now;
  Date.now = () => 2_000_000;
  await worker.events.get("session_start")![0](undefined, context);
  for (const event of [
    "turn_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "turn_end",
  ])
    assert.equal(worker.events.has(event), true, event);
  const before = readWorkerState(mailbox)!.lastActivityAt!;
  worker.events.get("message_update")![0]({}, context);
  assert.equal(readWorkerState(mailbox)!.lastActivityAt, before);
  Date.now = () => 1_000_000;
  worker.events.get("message_update")![0]({}, context);
  assert.equal(readWorkerState(mailbox)!.lastActivityAt, 1_000_000);
  Date.now = realNow;
  worker.events.get("session_shutdown")?.[0]();
});

test("worker restart forces an active activity touch within the coalescing window", async () => {
  const mailbox = setWorkerEnvironment();
  const state = {
    ...managedState("registered-worker", REQUEST_ID),
    lastActivityAt: Date.now() - 1_000,
  };
  writeWorkerState(mailbox, state);
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  await worker.events.get("session_start")![0](
    { reason: "reload" },
    fakeWorkerContext(),
  );
  assert.ok(readWorkerState(mailbox)!.lastActivityAt! > state.lastActivityAt);
  worker.events.get("session_shutdown")?.[0]();
});

test("mismatched result never repairs worker state", async () => {
  const mailbox = setWorkerEnvironment();
  writeWorkerState(mailbox, managedState("registered-worker", REQUEST_ID));
  writeResult(mailbox, {
    version: 3,
    runId: WORKER_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    workerLabel: "other-worker",
    paneId: "registered-pane",
    status: "completed",
    text: "wrong",
    completedAt: Date.now(),
  });
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  worker.events.get("session_start")![0](
    { reason: "startup" },
    fakeWorkerContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readWorkerState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.equal(readWorkerState(mailbox)?.completedRequestId, undefined);
  worker.events.get("session_shutdown")?.[0]();
  const malformedMailbox = setWorkerEnvironment();
  const state = managedState("registered-worker", REQUEST_ID);
  writeWorkerState(malformedMailbox, state);
  writeFileSync(
    join(malformedMailbox, `result-${REQUEST_ID}.json`),
    "{malformed",
    "utf8",
  );
  const malformedWorker = fakePi();
  registerExtension!(malformedWorker.pi as never);
  malformedWorker.events.get("session_start")![0](
    { reason: "startup" },
    fakeWorkerContext(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = readWorkerState(malformedMailbox)!;
  assert.equal(recovered.activeRequestId, state.activeRequestId);
  assert.equal(recovered.completedRequestId, undefined);
  malformedWorker.events.get("session_shutdown")?.[0]();
});

test("worker reload rejects a different Pi session identity", () => {
  const mailbox = setWorkerEnvironment();
  const state = managedState("registered-worker", REQUEST_ID);
  writeWorkerState(mailbox, state);
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext();
  (context as any).sessionManager = {
    ...context.sessionManager,
    getSessionId: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };
  worker.events.get("session_start")![0]({ reason: "reload" }, context);
  assert.deepEqual(readWorkerState(mailbox), state);
  worker.events.get("session_shutdown")?.[0]();
});

test("metadata initialization serializes repeats and rejects stale generations", async () => {
  setWorkerEnvironment();
  const pending: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  const worker = fakePi({
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
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 1);
  assert.equal(worker.calls.length, 1);
  pending.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.length, 2);
  assert.equal(maximum, 1);
  assert.ok(worker.calls[1].includes("registered-worker"));
  assert.ok(worker.calls[1].includes("--clear-token"));
  assert.equal(
    worker.calls[1].some((arg) => arg.includes("old")),
    false,
  );
  pending.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.length, 2);
  worker.events.get("session_shutdown")?.[0]();
  {
    const mailbox = setWorkerEnvironment();
    const gates: (() => void)[] = [];
    const worker = fakePi({
      exec: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    registerExtension!(worker.pi as never);
    const context = fakeContext();
    worker.events.get("session_start")![0](undefined, context);
    await new Promise((resolve) => setImmediate(resolve));
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    const request = writeMetadataTask(mailbox, "old generation task");
    worker.events.get("input")![0](
      { text: controlMarker(request.requestId) },
      context,
    );
    assert.equal(worker.calls.length, 2);
    worker.events.get("session_start")![0](undefined, context);
    assert.equal(worker.calls.length, 2);
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.calls.length, 3);
    const startup = worker.calls[2];
    assert.ok(startup.includes("registered-worker"));
    assert.ok(startup.includes("--clear-token"));
    assert.equal(
      startup.some((arg) => arg === `task=${request.text}`),
      false,
    );
    gates.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.calls.length, 3);
    worker.events.get("session_shutdown")?.[0]();
  }
});

test("metadata outage retains one latest desired snapshot", async () => {
  const mailbox = setWorkerEnvironment();
  let attempts = 0;
  const worker = fakePi({
    exec: async () => {
      attempts++;
      return attempts === 1
        ? { stdout: "", stderr: "outage", code: 7 }
        : { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  const request = writeMetadataTask(
    mailbox,
    "coalesced task",
    "cccccccc-cccc-4ccc-8ccc-ccccccccccdf",
  );
  worker.events.get("input")![0](
    { text: controlMarker(request.requestId) },
    context,
  );
  const intermediateModels = ["model-0", "model-1", "model-2"];
  for (let i = 0; i < 100; i++) {
    const model = `model-${i}`;
    const thinking = `thinking-${i}`;
    worker.events.get("model_select")![0](
      { model: { provider: "test", id: model } },
      context,
    );
    worker.events.get("thinking_level_select")![0](
      { level: thinking },
      context,
    );
    (context as any).getContextUsage = () => ({
      tokens: i + 1,
      contextWindow: 100,
    });
    worker.events.get("turn_end")![0](undefined, context);
  }
  const finalModel = "test/model-99";
  const finalThinking = "thinking-99";
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = worker.calls.at(-1)!;
  assert.equal(attempts, 3);
  assert.ok(recovered.includes(`model=${finalModel}`));
  assert.ok(recovered.includes(`thinking=${finalThinking}`));
  assert.ok(recovered.includes("ctx=100"));
  for (const value of intermediateModels)
    assert.equal(
      recovered.some((arg) => arg.includes(value)),
      false,
    );
  assert.equal(worker.calls.length, 3);
  worker.events.get("session_shutdown")?.[0]();
});

test("worker shutdown invalidates in-flight metadata", async () => {
  const firstMailbox = setWorkerEnvironment();
  let aborted = false;
  const worker = fakePi({
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
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.length, 1);
  worker.events.get("session_shutdown")?.[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(worker.execOptions[0].signal?.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.length, 1);
  const successorMailbox = setWorkerEnvironment();
  worker.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.length, 2);
  const successor = worker.calls[1];
  assert.ok(successor.includes("registered-worker"));
  assert.ok(successor.includes("--clear-token"));
  assert.ok(successor.includes("model"));
  assert.ok(successor.includes("thinking"));
  assert.equal(readWorkerState(successorMailbox)?.activeRequestId, undefined);
  assert.equal(firstMailbox, successorMailbox);
  worker.events.get("session_shutdown")?.[0]();
});

test("task state-write failure retains the request for an exact retry", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  await worker.events.get("session_start")![0](undefined, context);
  const started = readWorkerState(mailbox)!;
  const request: RequestRecord = {
    version: 3,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    workerLabel: started.workerLabel,
    paneId: started.paneId,
    kind: "task",
    text: "retry after durable state recovery",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  support.failNextMailboxWrite = true;
  const failed = worker.events.get("input")![0](
    { text: controlMarker(REQUEST_ID) },
    context,
  );
  assert.deepEqual(failed, { action: "handled" });
  assert.equal(readWorkerState(mailbox)?.activeRequestId, undefined);
  assert.ok(readRequest(mailbox, REQUEST_ID));
  const retried = worker.events.get("input")![0](
    { text: controlMarker(REQUEST_ID) },
    context,
  );
  assert.deepEqual(retried, { action: "transform", text: request.text });
  assert.equal(readWorkerState(mailbox)?.activeRequestId, REQUEST_ID);
  worker.events.get("session_shutdown")?.[0]();
});

test("acknowledgement state-write failure retains an identity-rejected request", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeContext();
  await worker.events.get("session_start")![0](undefined, context);
  const started = readWorkerState(mailbox)!;
  const request: RequestRecord = {
    version: 3,
    runId: started.runId,
    requestId: REQUEST_ID,
    ownerSessionId: started.ownerSessionId,
    workspaceId: started.workspaceId,
    workerLabel: started.workerLabel,
    paneId: "different-pane",
    kind: "task",
    text: "retry after acknowledgement write failure",
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  support.failNextMailboxWrite = true;
  assert.deepEqual(
    worker.events.get("input")![0](
      { text: controlMarker(REQUEST_ID) },
      context,
    ),
    { action: "handled" },
  );
  assert.equal(readWorkerState(mailbox)?.lastAck, undefined);
  assert.ok(readRequest(mailbox, REQUEST_ID));

  assert.deepEqual(
    worker.events.get("input")![0](
      { text: controlMarker(REQUEST_ID) },
      context,
    ),
    { action: "handled" },
  );
  assert.deepEqual(readWorkerState(mailbox)?.lastAck, {
    requestId: REQUEST_ID,
    accepted: false,
    code: "identity",
    message: "Request identity did not match worker state",
    acknowledgedAt: readWorkerState(mailbox)!.lastAck!.acknowledgedAt,
  });
  assert.equal(readRequest(mailbox, REQUEST_ID), undefined);
  worker.events.get("session_shutdown")?.[0]();
});

test("a stray worker variable does not suppress lead registration", () => {
  setLeadEnvironment();
  const lead = fakePi();
  registerExtension!(lead.pi as never);
  assert.equal(lead.tools.length, 1);
  assert.equal(lead.tools[0].name, "worker");
  assert.deepEqual(lead.commands, ["workers"]);
});

test("session agent identity reads the session-wide entry array", () => {
  assert.equal(
    sessionAgentDefinition([
      {
        type: "custom",
        customType: "pi-herdsman-worker-definition",
        data: { name: "reviewer" },
      },
      { type: "message" },
      {
        type: "custom",
        customType: "pi-herdsman-worker-definition",
        data: { name: "reviewer" },
      },
    ]),
    "reviewer",
  );
  assert.equal(sessionAgentDefinition([]), undefined);
  assert.equal(
    sessionAgentDefinition([
      {
        type: "custom",
        customType: "pi-herd-subagent-definition",
        data: { name: "legacy" },
      },
    ]),
    undefined,
    "the removed session definition entry must not be accepted as an alias",
  );
  assert.throws(
    () =>
      sessionAgentDefinition([
        {
          type: "custom",
          customType: "pi-herdsman-worker-definition",
          data: { name: 42 },
        },
      ]),
    /invalid pi-herdsman-worker-definition entry/,
  );
  assert.throws(
    () =>
      sessionAgentDefinition([
        {
          type: "custom",
          customType: "pi-herdsman-worker-definition",
          data: { name: "reviewer" },
        },
        {
          type: "custom",
          customType: "pi-herdsman-worker-definition",
          data: { name: "implementer" },
        },
      ]),
    /conflicting pi-herdsman-worker-definition entries/,
  );
});

test("worker persists one definition entry before mailbox initialization", async () => {
  const mailbox = setWorkerEnvironment();
  const worker = fakePi();
  registerExtension!(worker.pi as never);
  const context = fakeWorkerContext(worker.entries);
  const start = worker.events.get("session_start")![0];
  await start(undefined, context);
  await start({ reason: "reload" }, context);
  assert.deepEqual(worker.entries, [
    {
      type: "custom",
      customType: "pi-herdsman-worker-definition",
      data: { name: "worker" },
    },
  ]);
  assert.ok(readWorkerState(mailbox));
  worker.events.get("session_shutdown")?.[0]();
});

test("owner ask delivery is branch-local and recovers on tree navigation", async () => {
  setLeadEnvironment();
  const label = "ask-delivery-worker";
  const identity = recoveryIdentity(label);
  const mailbox = workerMailboxPath(WORKSPACE, label);
  resetWorkerMailbox(mailbox);
  const requestId = REQUEST_ID;
  const waiting = {
    ...managedState(label, requestId, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeWorkerState(mailbox, waiting);
  const ask: AskRecord = {
    version: 3,
    askId: waiting.pendingAskId!,
    requestId,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    workerLabel: waiting.workerLabel,
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
    requestId,
    runId: ask.runId,
    workerLabel: label,
    workspaceId: WORKSPACE,
    paneId: identity.paneId,
    piSessionId: identity.piSessionId,
  });
  branch.push({ customType: "pi-herdsman-worker-ask", details: ask });
  pi.events.get("session_tree")![0](undefined, context);
  assert.equal(pi.sent.length, 1);
  branch.length = 0;
  pi.events.get("session_tree")![0](undefined, context);
  assert.equal(pi.sent.length, 2);
  assert.deepEqual(pi.sentMessageCalls[0]?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  pi.events.get("session_shutdown")?.[0]();
  resetWorkerMailbox(mailbox);
});
