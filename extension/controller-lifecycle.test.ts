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
import {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  MAILBOX_PROTOCOL_LIMIT_BYTES,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  agentFromState,
  cascadeExecutor,
  controlMarker,
  createStagedAssignmentFixture,
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  delegationLockPathForTest,
  fakeContext,
  fakePi,
  fakeAgentContext,
  isAgentList,
  isHerdrList,
  isPaneClose,
  isPaneList,
  isPreservePaneStop,
  isTabList,
  listResponse,
  listAgentStates,
  managedState,
  nativeSessions,
  agentControllerExecutor,
  promptLaunchContents,
  promptLaunchPaths,
  readPendingAsk,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  recoveryIdentity,
  registerExtension,
  requestRecordBytes,
  resetAgentMailbox,
  resultEntryDetails,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setAgentEnvironment,
  skillBlock,
  startupExecutor,
  waitForTestCondition,
  agentMailboxPath,
  writeAsk,
  writePromptDefinition,
  writeRequest,
  writeAgentState,
} from "./support.ts";

test("parent delegates two same-definition children with exact ownership", async () => {
  setAgentEnvironment("multiplicity-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("multiplicity-parent");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const lifecycle = delegatedLifecycleExecutor(parent);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ]);
  const mailboxes: string[] = [];
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const task of ["first child", "second child"]) {
      const started = await pi.tools[0].execute(
        "start",
        { action: "delegate", definition: "child", task },
        undefined,
        undefined,
        context,
      );
      assert.equal(started.details.ok, true, JSON.stringify(started.details));
      mailboxes.push(
        agentMailboxPath(WORKSPACE, started.details.agent as string),
      );
    }
    const labels = mailboxes.map(
      (mailbox) => readAgentState(mailbox)!.agentLabel,
    );
    assert.equal(new Set(labels).size, 2);
    const states = mailboxes.map((mailbox) => readAgentState(mailbox)!);
    assert.deepEqual(
      states.map((state) => state.ownerSessionId),
      [parent.piSessionId, parent.piSessionId],
    );
    assert.equal(new Set(states.map((state) => state.paneId)).size, 2);
    assert.equal(
      lifecycle.environmentCommands.filter((command) =>
        command.includes("PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=[]"),
      ).length,
      2,
    );
    for (const label of labels) {
      const closed = await pi.tools[0].execute(
        "close",
        { action: "close", agent: label },
        undefined,
        undefined,
        context,
      );
      assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
      assert.equal(
        readAgentState(agentMailboxPath(WORKSPACE, label)),
        undefined,
      );
    }
    assert.deepEqual(lifecycle.closeOrder, labels);
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("parent delegation lock makes concurrent close and delegate fail fast", async () => {
  setLeadEnvironment();
  const parent = managedState("race-parent");
  const child = {
    ...managedState("race-child", undefined, recoveryIdentity("race-child")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/race-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");

  const lifecycle = delegatedLifecycleExecutor(parent, [child]);
  let closeEnteredResolve!: () => void;
  const closeEntered = new Promise<void>(
    (resolve) => (closeEnteredResolve = resolve),
  );
  let releaseCloseResolve!: () => void;
  const releaseClose = new Promise<void>(
    (resolve) => (releaseCloseResolve = resolve),
  );
  const sharedExec: ExecHandler = async (command, args, options) => {
    if (command === "herdr" && isPaneClose(args)) {
      closeEnteredResolve();
      await releaseClose;
    }
    return lifecycle.exec(command, args, options);
  };

  const leadPi = fakePi({ exec: sharedExec });
  registerExtension!(leadPi.pi as never);
  setAgentEnvironment("race-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const parentPi = fakePi({ exec: sharedExec });
  registerExtension!(parentPi.pi as never);
  const parentContext = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ]);
  const leadContext = fakeContext();

  try {
    for (const handler of parentPi.events.get("session_start") ?? [])
      await handler(undefined, parentContext);
    assert.equal(parentPi.entries.length, 0, JSON.stringify(parentPi.entries));

    const closePromise = leadPi.tools[0].execute(
      "close",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      leadContext,
    );
    await closeEntered;

    const started = await parentPi.tools[0].execute(
      "start",
      {
        action: "delegate",
        definition: "child",
        label: "race-new-child",
        task: "must not start during parent close",
      },
      undefined,
      undefined,
      parentContext,
    );
    assert.equal(
      started.details.error.category,
      "agent_busy",
      JSON.stringify(started.details),
    );
    assert.equal(
      parentPi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );

    releaseCloseResolve();
    const closed = await closePromise;
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.deepEqual(lifecycle.closeOrder, [
      child.agentLabel,
      parent.agentLabel,
    ]);
  } finally {
    releaseCloseResolve();
    for (const handler of leadPi.events.get("session_shutdown") ?? [])
      handler();
    for (const handler of parentPi.events.get("session_shutdown") ?? [])
      handler();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "race-new-child"));
    for (const [name] of files)
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
  }
});

test("zero-child lead close is blocked by the parent delegation lock", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "zero-child-parent",
      undefined,
      recoveryIdentity("zero-child-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/zero-child-parent.jsonl",
  };
  const mailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, parent);
  const lifecycle = cascadeExecutor([parent]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  let releaseLock: (() => void) | undefined = claimProcessLock(
    delegationLockPathForTest(WORKSPACE, parent.piSessionId),
    { name: "test delegation lifecycle" },
  );

  try {
    const closed = await pi.tools[0].execute(
      "id",
      { action: "close", agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      closed.details.error.category,
      "agent_busy",
      JSON.stringify(closed.details),
    );
    assert.match(closed.details.error.message, /Delegation lifecycle/);
    assert.match(
      closed.details.error.nextAction,
      /current delegation lifecycle/,
    );
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.equal(
      pi.calls.some((args) => isPaneClose(args)),
      false,
    );
    assert.equal(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herd_cleanup_error",
      ),
      false,
    );
    assert.ok(readAgentState(mailbox));
    releaseLock();
    releaseLock = undefined;
    const listed = await pi.tools[0].execute(
      "list-after-busy-close",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(listed.details.cleanup_errors, undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    releaseLock?.();
    resetAgentMailbox(mailbox);
  }
});

test("staged fresh assignment bridges pending start through working", async () => {
  const fixture = createStagedAssignmentFixture("staged-bridge-agent");
  try {
    const starting = fixture.pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label: "staged-bridge-agent",
        task: "bridge the staged lifecycle",
      },
      undefined,
      undefined,
      fixture.context,
    );
    await waitForTestCondition(
      () =>
        fixture.pi.calls.some(
          (args) => args[0] === "agent" && args[1] === "start",
        ),
      "assignment did not reach the gated startup",
    );
    fixture.releaseInitialStatus();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readAgentState(fixture.mailbox), undefined);
    assert.equal(
      fixture.widgetValue
        .render(160)
        .join("\n")
        .match(/staged-bridge-agent/g)?.length,
      1,
    );

    fixture.releaseStart();
    await waitForTestCondition(
      () => fixture.preSubmitValidationReady,
      "assignment did not reach pre-submit validation",
    );
    const beforeAck = await fixture.list();
    assert.equal(fixture.promptRequested, false);
    assert.equal(beforeAck.details.agents[0].state, "settling");

    fixture.releasePreSubmitValidation();
    await waitForTestCondition(
      () => fixture.promptRequested,
      "assignment did not reach the gated prompt",
    );
    fixture.releasePrompt();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const requestId = result.details.request_id;
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(requestId, fixture.promptRequestId);
    assert.equal(requestId, fixture.acceptedRequestIdWritten);
    assert.equal(
      readAgentState(fixture.mailbox)?.lastAck?.requestId,
      requestId,
    );
    assert.equal(readAgentState(fixture.mailbox)?.activeRequestId, undefined);

    const afterAck = await fixture.list();
    assert.equal(afterAck.details.agents[0].state, "settling");

    const settlingRefresh = await fixture.list();
    assert.equal(settlingRefresh.details.agents[0].state, "settling");

    fixture.markWorking(requestId);
    const working = await fixture.list();
    assert.equal(working.details.agents[0].state, "working");
    assert.equal(working.details.agents[0].active_request_id, requestId);
    assert.equal(
      working.details.agents[0].available_actions.includes("delegate"),
      false,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 2100));
    const renderedWorking = fixture.widgetValue.render(160).join("\n");
    assert.match(renderedWorking, /1 working/);
    assert.doesNotMatch(renderedWorking, /starting/);
    assert.equal(working.details.agents.length, 1);
    assert.ok(fixture.workingObservations > 0);

    const settling = await fixture.list();
    assert.equal(settling.details.agents[0].state, "working");
    assert.doesNotMatch(fixture.widgetValue.render(160).join("\n"), /ready/);
  } finally {
    fixture.shutdown();
  }
});

test("staged fresh assignment removes a fast completion without observing working", async () => {
  const fixture = createStagedAssignmentFixture(
    "staged-fast-completion-agent",
    true,
  );
  try {
    const starting = fixture.pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label: "staged-fast-completion-agent",
        task: "complete before the working snapshot",
      },
      undefined,
      undefined,
      fixture.context,
    );
    await waitForTestCondition(
      () =>
        fixture.pi.calls.some(
          (args) => args[0] === "agent" && args[1] === "start",
        ),
      "fast assignment did not reach the gated startup",
    );
    fixture.releaseStart();
    await waitForTestCondition(
      () => fixture.preSubmitValidationReady,
      "fast assignment did not reach pre-submit validation",
    );
    fixture.releasePreSubmitValidation();
    await waitForTestCondition(
      () => fixture.promptRequested,
      "fast assignment did not reach the gated prompt",
    );
    fixture.releasePrompt();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const requestId = result.details.request_id;
    assert.equal(requestId, fixture.promptRequestId);
    assert.equal(requestId, fixture.acceptedRequestIdWritten);
    assert.equal(readAgentState(fixture.mailbox)?.activeRequestId, undefined);

    const beforeCompletion = await fixture.list();
    assert.equal(beforeCompletion.details.agents[0].state, "settling");
    assert.equal(fixture.workingObservations, 0);
    fixture.completeFast(requestId);
    await waitForTestCondition(
      () =>
        fixture.pi.sent.some(
          (message: any) => message.customType === "pi-herdsman-agent-result",
        ),
      "fast completion result was not delivered",
    );
    assert.equal(requestId, fixture.promptRequestId);
    assert.equal(fixture.workingObservations, 0);
    await waitForTestCondition(
      () => !readAgentState(fixture.mailbox),
      "fast completion cleanup did not remove the mailbox",
    );
    const afterCleanup = await fixture.list();
    assert.deepEqual(afterCleanup.details.agents, []);
    assert.equal(readAgentState(fixture.mailbox), undefined);
    assert.equal(realFs.existsSync(fixture.mailbox), false);
    const renderedAfterCleanup = fixture.widgetValue.render(160).join("\n");
    assert.doesNotMatch(renderedAfterCleanup, /starting/);
    assert.doesNotMatch(renderedAfterCleanup, /working/);
    const laterRefresh = await fixture.list();
    assert.deepEqual(laterRefresh.details.agents, []);
    await new Promise<void>((resolve) => setTimeout(resolve, 2100));
    const renderedAfterRefresh = fixture.widgetValue.render(160).join("\n");
    assert.doesNotMatch(renderedAfterRefresh, /starting/);
    assert.doesNotMatch(renderedAfterRefresh, /working/);
  } finally {
    fixture.shutdown();
  }
});

test("registered extensions preserve adjacent ask escalation and assignment results", async () => {
  setLeadEnvironment();
  const parentLabel = "escalation-parent";
  const childLabel = "escalation-child";
  const parentRequestId = randomUUID();
  const childRequestId = randomUUID();
  const parentIdentity = defaultFixtureIdentity;
  const childIdentity: FixtureIdentity = {
    paneId: "escalation-child-pane",
    tabId: "escalation-child-tab",
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/escalation-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
  const parent = {
    ...managedState(parentLabel, parentRequestId, parentIdentity),
    piSessionId: parentIdentity.piSessionId,
    piSessionFile: parentIdentity.piSessionFile,
  };
  const child = {
    ...managedState(childLabel, childRequestId, childIdentity),
    ownerSessionId: parent.piSessionId,
  };
  const setNestedAgentEnv = (
    label: string,
    ownerSessionId: string,
    definition: string,
    allowedAgentDefinitions: string[],
  ): void => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    process.env.PI_HERDSMAN_MAILBOX = agentMailboxPath(WORKSPACE, label);
    process.env.PI_HERDSMAN_RUN_ID = AGENT_ID;
    process.env.PI_HERDSMAN_OWNER_SESSION_ID = ownerSessionId;
    process.env.PI_HERDSMAN_LABEL = label;
    process.env.PI_HERDSMAN_WORKSPACE_ID = WORKSPACE;
    process.env.PI_HERDSMAN_AGENT_DEFINITION = definition;
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify(
      allowedAgentDefinitions,
    );
    process.env.HERDR_PANE_ID =
      label === parentLabel ? parentIdentity.paneId : childIdentity.paneId;
  };
  const childDefinition = join(PI_AGENTS_DIR, "child.md");
  writeFileSync(childDefinition, "---\nname: child\n---\nchild\n");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);

  let childAgent: ReturnType<typeof fakePi> | undefined;
  let parentAgent: ReturnType<typeof fakePi> | undefined;
  let leadAgent: ReturnType<typeof fakePi> | undefined;
  let leadReply: RequestRecord | undefined;
  let parentReply: RequestRecord | undefined;
  try {
    setNestedAgentEnv(childLabel, parent.piSessionId, "child", []);
    childAgent = fakePi();
    registerExtension!(childAgent.pi as never);
    const childBranch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "ask_owner" }],
        },
      },
    ];
    const childContext = fakeAgentContext(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { name: "child" },
        },
      ],
      childBranch,
    );
    childContext.sessionManager.getSessionId = () => child.piSessionId;
    childContext.sessionManager.getSessionFile = () => child.piSessionFile!;
    await childAgent.events.get("session_start")![0](undefined, childContext);
    const childAskTool = childAgent.tools.find(
      (tool) => tool.name === "ask_owner",
    );
    assert.ok(childAskTool);
    await childAskTool.execute(
      "child-ask",
      { question: "Which implementation should I use?" },
      undefined,
      undefined,
      childContext,
    );
    const childWaiting = readAgentState(childMailbox)!;
    assert.equal(childWaiting.activeRequestId, childRequestId);
    assert.ok(childWaiting.pendingAskId);
    assert.equal(childWaiting.ownerSessionId, parent.piSessionId);
    assert.equal(childWaiting.workspaceId, parent.workspaceId);
    const childAsk = readPendingAsk(childMailbox, childWaiting)!;
    childAgent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(childMailbox);

    setNestedAgentEnv(parentLabel, LEAD_SESSION_ID, "agent", ["child"]);
    const parentBase = agentControllerExecutor(parent, [child]);
    const parentEntries: unknown[] = [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "agent" },
      },
    ];
    parentAgent = fakePi({ exec: parentBase, entries: parentEntries });
    registerExtension!(parentAgent.pi as never);
    const parentBranch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "ask_owner" }],
        },
      },
    ];
    const parentContext = fakeAgentContext(parentEntries, parentBranch);
    parentContext.sessionManager.getBranch = () => parentBranch;
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentContext);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
      parentEntries.map(String).join("\n"),
    );
    writeAgentState(childMailbox, childWaiting);
    writeAsk(childMailbox, childAsk);
    const parentAskTool = parentAgent.tools.find(
      (tool) => tool.name === "ask_owner",
    );
    assert.ok(parentAskTool);
    await parentAskTool.execute(
      "parent-ask",
      { question: "How should I answer the child?" },
      undefined,
      undefined,
      parentContext,
    );
    const parentWaiting = readAgentState(parentMailbox)!;
    assert.equal(parentWaiting.activeRequestId, parentRequestId);
    assert.ok(parentWaiting.pendingAskId);
    assert.equal(
      readAgentState(childMailbox)?.pendingAskId,
      childWaiting.pendingAskId,
    );
    parentAgent.events.get("session_shutdown")?.[0]();

    delete process.env.PI_HERDSMAN_MAILBOX;
    delete process.env.PI_HERDSMAN_RUN_ID;
    delete process.env.PI_HERDSMAN_OWNER_SESSION_ID;
    delete process.env.PI_HERDSMAN_LABEL;
    delete process.env.PI_HERDSMAN_WORKSPACE_ID;
    delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
    delete process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS;
    delete process.env.HERDR_PANE_ID;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = WORKSPACE;
    const leadBase = leadExec(
      parentLabel,
      "working",
      parent.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V4__:".length);
        leadReply = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
      },
      parent.piSessionId,
      parentIdentity,
    );
    leadAgent = fakePi({ exec: leadBase });
    registerExtension!(leadAgent.pi as never);
    const leadContext = fakeContext();
    await leadAgent.events.get("session_start")![0](undefined, leadContext);
    const leadReplyResult = await leadAgent.tools[0].execute(
      "lead-reply",
      {
        action: "reply",
        agent: parentLabel,
        message: "Tell the child ALPHA.",
      },
      undefined,
      undefined,
      leadContext,
    );
    assert.equal(leadReplyResult.details.ok, true);
    assert.equal(leadReply?.kind, "reply");
    assert.equal(leadReply?.askId, parentWaiting.pendingAskId);
    assert.equal(leadReply?.requestId === parentRequestId, false);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );
    assert.equal(
      readAgentState(parentMailbox)?.pendingAskId,
      parentWaiting.pendingAskId,
    );
    leadAgent.events.get("session_shutdown")?.[0]();

    setNestedAgentEnv(parentLabel, LEAD_SESSION_ID, "agent", ["child"]);
    parentAgent = fakePi({ exec: parentBase });
    registerExtension!(parentAgent.pi as never);
    const parentReplyContext = fakeAgentContext([
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "agent" },
      },
    ]);
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentReplyContext);
    assert.ok(leadReply);
    writeRequest(parentMailbox, leadReply!);
    assert.deepEqual(
      parentAgent.events.get("input")![0](
        { text: controlMarker(leadReply!.requestId) },
        parentReplyContext,
      ),
      {
        action: "transform",
        text: "Owner reply:\n\nTell the child ALPHA.\n\nContinue the original assignment using this answer.",
      },
    );
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );
    assert.equal(readAgentState(parentMailbox)?.pendingAskId, undefined);
    const parentBaseWithCapture: ExecHandler = (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        const requestId = (args.at(-1) ?? "").replace(
          "__PI_HERDSMAN_AGENT_V4__:",
          "",
        );
        parentReply = readRequest(childMailbox, requestId);
      }
      return parentBase(command, args, options);
    };
    parentAgent.events.get("session_shutdown")?.[0]();
    parentAgent = fakePi({ exec: parentBaseWithCapture });
    registerExtension!(parentAgent.pi as never);
    const parentReplyBranch: unknown[] = [];
    const parentReplyAgentContext = fakeAgentContext(
      [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { name: "agent" },
        },
      ],
      parentReplyBranch,
    );
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentReplyAgentContext);
    const parentTool = parentAgent.tools[0];
    const childReplyResult = await parentTool.execute(
      "parent-reply",
      {
        action: "reply",
        agent: childLabel,
        message: "Use ALPHA and finish.",
      },
      undefined,
      undefined,
      parentReplyAgentContext,
    );
    assert.equal(
      childReplyResult.details.ok,
      true,
      JSON.stringify(childReplyResult.details),
    );
    assert.equal(
      childReplyResult.details.assignment_request_id,
      childRequestId,
    );
    assert.equal(parentReply?.kind, "reply");
    assert.equal(parentReply?.askId, childWaiting.pendingAskId);
    assert.equal(
      readAgentState(parentMailbox)?.activeRequestId,
      parentRequestId,
    );
    parentAgent.events.get("session_shutdown")?.[0]();
    writeAgentState(childMailbox, childWaiting);
    writeAsk(childMailbox, childAsk);

    setNestedAgentEnv(childLabel, parent.piSessionId, "child", []);
    childAgent = fakePi();
    registerExtension!(childAgent.pi as never);
    const childResultContext = fakeAgentContext([
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "child" },
      },
    ]);
    childResultContext.sessionManager.getSessionId = () => child.piSessionId;
    childResultContext.sessionManager.getSessionFile = () =>
      child.piSessionFile!;
    await childAgent.events.get("session_start")![0](
      undefined,
      childResultContext,
    );
    assert.ok(parentReply);
    assert.equal(readAgentState(childMailbox)?.activeRequestId, childRequestId);
    assert.equal(
      readAgentState(childMailbox)?.pendingAskId,
      childWaiting.pendingAskId,
    );
    assert.ok(readPendingAsk(childMailbox, readAgentState(childMailbox)!));
    writeRequest(childMailbox, parentReply!);
    assert.equal(
      childAgent.events.get("input")![0](
        { text: controlMarker(parentReply!.requestId) },
        childResultContext,
      ).action,
      "transform",
    );
    assert.equal(readAgentState(childMailbox)?.activeRequestId, childRequestId);
    assert.equal(readAgentState(childMailbox)?.pendingAskId, undefined);
    childAgent.events.get("message_end")![0](
      { message: { role: "assistant", content: "ALPHA" } },
      childResultContext,
    );
    childAgent.events.get("agent_settled")![0](undefined, childResultContext);
    assert.equal(readResult(childMailbox, childRequestId)?.text, "ALPHA");
    assert.equal(
      readAgentState(childMailbox)?.completedRequestId,
      childRequestId,
    );
    childAgent.events.get("session_shutdown")?.[0]();

    setNestedAgentEnv(parentLabel, LEAD_SESSION_ID, "agent", ["child"]);
    parentAgent = fakePi({ exec: parentBase });
    registerExtension!(parentAgent.pi as never);
    const parentResultEntries: unknown[] = [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "agent" },
      },
      {
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(child, childRequestId),
      },
    ];
    const parentResultContext = fakeAgentContext(parentResultEntries);
    for (const handler of parentAgent.events.get("session_start") ?? [])
      await handler(undefined, parentResultContext);
    parentAgent.events.get("message_end")![0](
      { message: { role: "assistant", content: "Parent completed." } },
      parentResultContext,
    );
    parentAgent.events.get("agent_settled")![0](undefined, parentResultContext);
    assert.equal(
      readResult(parentMailbox, parentRequestId)?.text,
      "Parent completed.",
    );
    assert.equal(
      readAgentState(parentMailbox)?.completedRequestId,
      parentRequestId,
    );
    assert.deepEqual(
      listAgentStates()
        .filter(({ state }) =>
          [parentLabel, childLabel].includes(state.agentLabel),
        )
        .map(({ state }) => state.activeRequestId ?? state.completedRequestId)
        .sort(),
      [childRequestId, parentRequestId].sort(),
    );
    parentAgent.events.get("session_shutdown")?.[0]();
  } finally {
    childAgent?.events.get("session_shutdown")?.[0]();
    parentAgent?.events.get("session_shutdown")?.[0]();
    leadAgent?.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
    realFs.unlinkSync(childDefinition);
    setLeadEnvironment();
  }
});

test("one failed child recovery does not clear valid sibling runtimes", async () => {
  setAgentEnvironment("recovery-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("recovery-parent");
  const badChild = {
    ...managedState(
      "recovery-bad",
      undefined,
      recoveryIdentity("recovery-bad"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/recovery-bad.jsonl",
  };
  const goodChild = {
    ...managedState(
      "recovery-good",
      undefined,
      recoveryIdentity("recovery-good"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/recovery-good.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const badMailbox = agentMailboxPath(WORKSPACE, badChild.agentLabel);
  const goodMailbox = agentMailboxPath(WORKSPACE, goodChild.agentLabel);
  for (const mailbox of [parentMailbox, badMailbox, goodMailbox])
    resetAgentMailbox(mailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(badMailbox, badChild);
  writeAgentState(goodMailbox, goodChild);
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ];
  const base = agentControllerExecutor(parent, [badChild, goodChild]);
  const pi = fakePi({
    entries,
    exec: (command, args, options) => {
      const result = base(command, args, options);
      if (command === "herdr" && isAgentList(args)) {
        const value = JSON.parse(result.stdout);
        const bad = value.result.agents.find(
          (agent: any) => agent.pane_id === badChild.paneId,
        );
        if (bad)
          bad.agent_session = {
            kind: "id",
            value: "22222222-2222-4222-8222-222222222222",
          };
        return { ...result, stdout: JSON.stringify(value) };
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    assert.ok(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_recovery_error",
      ),
    );
    const listed = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      listed.details.agents.map((agent: any) => agent.agent),
      [goodChild.agentLabel],
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of [parentMailbox, badMailbox, goodMailbox])
      resetAgentMailbox(mailbox);
  }
});

test("historical session rejects an active managed representation", async () => {
  setLeadEnvironment();
  const name = `active-session-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const identity = recoveryIdentity(label);
  const aliasPath = `${identity.piSessionFile}-alias`;
  const liveIdentity = { ...identity, piSessionFile: aliasPath };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const session = {
    id: identity.piSessionId,
    path: identity.piSessionFile,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nenabled active session test\n`,
  );
  realFs.writeFileSync(identity.piSessionFile, "{}", "utf8");
  realFs.symlinkSync(identity.piSessionFile, aliasPath);
  nativeSessions.set(session.id, session);
  const active = {
    ...managedState(label, REQUEST_ID, liveIdentity),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: aliasPath,
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, active);
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      session.id,
      undefined,
      session.id,
      liveIdentity,
    ),
  });
  registerExtension!(pi.pi as never);
  try {
    const controllerContext = fakeContext();
    controllerContext.sessionManager.getSessionId = () => session.id;
    const ownSession = await pi.tools[0].execute(
      "controller-session",
      {
        action: "delegate",
        session: session.id,
        task: "must not self-delegate",
      },
      undefined,
      undefined,
      controllerContext,
    );
    assert.equal(ownSession.details.error.category, "invalid_request");
    const before = pi.calls.length;
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", session: session.path, task: "must wait" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "agent_busy");
    assert.match(result.details.error.message, /exact Pi session|represented/i);
    assert.equal(
      pi.calls
        .slice(before)
        .some(
          (args) =>
            args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
        ),
      false,
    );
    assert.deepEqual(readAgentState(mailbox), active);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(aliasPath, { force: true });
    realFs.rmSync(identity.piSessionFile, { force: true });
  }
});

test("exact requested session IDs remain busy when persisted paths are stale", async () => {
  setLeadEnvironment();
  const name = `stale-id-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact stale ID test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: session.id,
    piSessionFile: join(PI_AGENT_ROOT, `${name}-deleted-session.jsonl`),
  });
  const startup = startupExecutor(`${name}-agent`, () => session.id);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "agent_busy");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("concurrent session activation permits one generation", async () => {
  setLeadEnvironment();
  const name = `concurrent-session-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nconcurrent activation test\n`,
  );
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  let release!: () => void;
  let startEntered!: () => void;
  const entered = new Promise<void>((resolve) => (startEntered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pi = fakePi({
    exec: async (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        startEntered();
        await gate;
      }
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const first = pi.tools[0].execute(
      "first",
      { action: "delegate", session: session.path, task: "first assignment" },
      undefined,
      undefined,
      fakeContext(),
    );
    await entered;
    const second = await pi.tools[0].execute(
      "second",
      { action: "delegate", session: session.id, task: "duplicate assignment" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(second.details.error.category, "agent_busy");
    release();
    const firstResult = await first;
    assert.equal(
      firstResult.details.ok,
      true,
      JSON.stringify(firstResult.details),
    );
  } finally {
    release();
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("session assignment reports a pane mismatch from the agent state producer", async () => {
  const label = "agent";
  const mailbox = setAgentEnvironment(label);
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  const agentStart = agent.events.get("session_start")![0];
  const paneEnvironment: Record<string, string> = {};
  nativeSessions.set("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    path: "/tmp/producer-mismatch.jsonl",
    cwd: "/tmp",
  });
  realFs.writeFileSync("/tmp/producer-mismatch.jsonl", "{}", "utf8");
  realFs.writeFileSync("/tmp/registered-agent.jsonl", "{}", "utf8");
  setLeadEnvironment();
  const lead = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "tab" && args[1] === "create")
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator > 0)
            paneEnvironment[assignment.slice(0, separator)] = assignment.slice(
              separator + 1,
            );
        }
      if (args[0] === "tab" && args[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: {
                tab_id: "producer-tab",
                label: "agents",
                workspace_id: WORKSPACE,
              },
              root_pane: { pane_id: "helper-pane" },
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
                  pane_id: "helper-pane",
                  tab_id: "producer-tab",
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  foreground_cwd: "/tmp",
                  agent_status: "unknown",
                },
              ],
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
                pane_id: "helper-pane",
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
        if (args[1] === "run")
          for (const match of (args.at(-1) ?? "").matchAll(
            /([A-Z][A-Z0-9_]*)='([^']*)'/g,
          ))
            paneEnvironment[match[1]] = match[2];
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isAgentList(args))
        return {
          stdout: listResponse(label, "idle", null),
          stderr: "",
          code: 0,
        };
      const previous = { ...process.env };
      Object.assign(process.env, paneEnvironment, {
        HERDR_PANE_ID: "agent-pane",
      });
      await agentStart(undefined, fakeAgentContext(agent.entries));
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      return {
        stdout: JSON.stringify({
          tab_id: "producer-tab",
          tab_label: "agents",
          pane_id: "helper-pane",
          cwd: "/tmp",
          herdr_agent: runScopedHerdrAlias(
            WORKSPACE,
            label,
            paneEnvironment.PI_HERDSMAN_RUN_ID ?? AGENT_ID,
          ),
          created_tab: true,
          created_pane: true,
          runtime_identity: {
            herdr_agent: runScopedHerdrAlias(
              WORKSPACE,
              label,
              paneEnvironment.PI_HERDSMAN_RUN_ID ?? AGENT_ID,
            ),
            herdr_kind: "pi",
            agent_definition: "agent",
            model: null,
            thinking: null,
            cwd: "/tmp",
            resumed: true,
            session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            session_name: null,
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  });
  registerExtension!(lead.pi as never);
  try {
    const result = await lead.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: "/tmp/producer-mismatch.jsonl",
        task: "continue the mismatched session",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, false);
    assert.match(result.details.error.message, /paneId/);
    assert.match(result.details.error.message, /agent-pane/);
    assert.match(result.details.error.message, /helper-pane/);
  } finally {
    lead.events.get("session_shutdown")?.[0]();
    agent.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(mailbox);
    realFs.rmSync("/tmp/producer-mismatch.jsonl", { force: true });
    realFs.rmSync("/tmp/registered-agent.jsonl", { force: true });
  }
});

test("fresh assignment transports automatic prompt snapshots and cleans them up", async () => {
  setLeadEnvironment();
  const name = `prompt-fresh-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(promptPath, "automatic prompt snapshot");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  let assignedText = "";
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text) => {
      assignedText = text;
    },
    false,
    (args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", definition: name, label, task: "fresh task" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched.length, 1);
    assert.deepEqual(
      launched[0].args.filter(
        (arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
      ),
      ["--system-prompt", "--append-system-prompt"],
    );
    assert.equal(launched[0].contents.length, 2);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /automatic prompt snapshot/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.equal(
      launched[0].contents[1]!.replaceAll(/\s+/g, " ").trim(),
      skillBlock(readFileSync(resolve("SKILL.md"), "utf8"), "agent"),
    );
    assert.match(
      launched[0].contents[1]!,
      /Do not overlap writers in a worktree or file-ownership boundary/,
    );
    assert.match(
      launched[0].contents[1]!,
      /use and preserve files and resultPath handoffs/,
    );
    assert.match(assignedText, /fresh task/);
    assert.equal(realFs.existsSync(mailbox), true);
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("startup failure cleans private prompt snapshots", async () => {
  setLeadEnvironment();
  const name = `failure-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  realFs.writeFileSync(promptPath, "startup failure prompt");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: string[][] = [];
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    (args) => launched.push(promptLaunchPaths(args)),
  );
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        throw new Error("injected startup failure");
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: name,
        label,
        task: "must fail at startup",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.notEqual(result.details.ok, true);
    assert.equal(launched.length, 1);
    assert.ok(launched[0].length > 0);
    for (const path of launched[0])
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("caller assignment files suppress canonical-overlapping automatic prompts", async () => {
  setLeadEnvironment();
  const name = `prompt-overlap-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const callerPath = join(PI_AGENT_ROOT, `${name}-caller.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(promptPath, "caller wins canonical overlap");
  realFs.symlinkSync(promptPath, callerPath);
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  let assignedText = "";
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text) => {
      assignedText = text;
    },
    false,
    (args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: name,
        label,
        files: [callerPath],
        task: "use caller context",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched[0].contents.length, 2);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.deepEqual(
      launched[0].args.filter(
        (arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
      ),
      ["--system-prompt", "--append-system-prompt"],
    );
    assert.match(assignedText, /caller wins canonical overlap/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(callerPath, { force: true });
  }
});

test("automatic prompt failures happen before topology or mailbox mutation", async () => {
  setLeadEnvironment();
  const name = `prompt-invalid-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const directoryPath = join(PI_AGENT_ROOT, `${name}-directory`);
  const invalidPath = join(PI_AGENT_ROOT, `${name}-invalid.md`);
  const nulPath = join(PI_AGENT_ROOT, `${name}-nul.md`);
  realFs.mkdirSync(directoryPath);
  realFs.writeFileSync(invalidPath, Buffer.from([0xff, 0xfe]));
  realFs.writeFileSync(nulPath, Buffer.from("prompt\0content"));
  const cases = [
    ["missing", join(PI_AGENT_ROOT, `${name}-missing.md`)],
    ["directory", directoryPath],
    ["invalid utf8", invalidPath],
    ["nul", nulPath],
  ] as const;
  try {
    for (const [kind, promptPath] of cases) {
      const label = `${name}-${kind.replaceAll(" ", "-")}`;
      const mailbox = agentMailboxPath(WORKSPACE, label);
      writePromptDefinition(definitionPath, name, promptPath);
      const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
      const pi = fakePi({ exec: startup.exec });
      registerExtension!(pi.pi as never);
      try {
        const result = await pi.tools[0].execute(
          "id",
          { action: "delegate", definition: name, label, task: "must fail" },
          undefined,
          undefined,
          fakeContext(),
        );
        assert.equal(result.details.error.category, "invalid_request", kind);
        assert.equal(startup.getCount(), 0, kind);
        assert.equal(realFs.existsSync(mailbox), false, kind);
        assert.equal(
          pi.calls.some(
            (args) =>
              args[0] === "pane" ||
              (args[0] === "agent" &&
                ["start", "stop"].includes(args[1] ?? "")),
          ),
          false,
          kind,
        );
      } finally {
        pi.events.get("session_shutdown")?.[0]();
        resetAgentMailbox(mailbox);
      }
    }
  } finally {
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(directoryPath, { recursive: true, force: true });
    realFs.rmSync(invalidPath, { force: true });
    realFs.rmSync(nulPath, { force: true });
  }
});

test("fresh and non-live historical assignments reject disabled definitions", async () => {
  setLeadEnvironment();
  const freshName = `disabled-fresh-${randomUUID().slice(0, 8)}`;
  const freshLabel = `${freshName}-agent`;
  const freshDefinitionPath = join(PI_AGENTS_DIR, `${freshName}.md`);
  realFs.writeFileSync(
    freshDefinitionPath,
    `---\nname: ${freshName}\nenabled: false\n---\nfresh\n`,
  );
  const freshStartup = startupExecutor(freshLabel, () => DEFAULT_PI_SESSION_ID);
  const freshPi = fakePi({ exec: freshStartup.exec });
  registerExtension!(freshPi.pi as never);
  try {
    const result = await freshPi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: freshName,
        label: freshLabel,
        task: "must remain disabled",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /disabled/);
    assert.match(result.details.error.message, new RegExp(freshName));
    assert.equal(freshStartup.getCount(), 0);
    assert.equal(realFs.existsSync(freshStartup.mailbox), false);
  } finally {
    freshPi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(freshDefinitionPath, { force: true });
  }

  setLeadEnvironment();
  const historicalName = `disabled-session-${randomUUID().slice(0, 8)}`;
  const historicalDefinitionPath = join(PI_AGENTS_DIR, `${historicalName}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${historicalName}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: historicalName },
      },
    ],
  };
  realFs.writeFileSync(
    historicalDefinitionPath,
    `---\nname: ${historicalName}\nenabled: false\n---\nhistorical\n`,
  );
  nativeSessions.set(session.id, session);
  const historicalStartup = startupExecutor(
    `${historicalName}-agent`,
    () => session.id,
  );
  const historicalPi = fakePi({ exec: historicalStartup.exec });
  registerExtension!(historicalPi.pi as never);
  try {
    const result = await historicalPi.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: session.path,
        task: "must remain disabled",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /disabled/);
    assert.equal(historicalStartup.getCount(), 0);
    assert.equal(realFs.existsSync(historicalStartup.mailbox), false);
  } finally {
    historicalPi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    realFs.rmSync(historicalDefinitionPath, { force: true });
  }
});

test("assigning a parent with a disabled child fails with an explicit reason", async () => {
  setLeadEnvironment();
  const parentPath = join(PI_AGENTS_DIR, "disabled-child-parent.md");
  const childPath = join(PI_AGENTS_DIR, "disabled-child.md");
  realFs.writeFileSync(
    parentPath,
    '---\nname: disabled-child-parent\nagents: ["disabled-child"]\n---\nparent\n',
  );
  realFs.writeFileSync(
    childPath,
    "---\nname: disabled-child\nenabled: false\n---\nchild\n",
  );
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && args[0] === "--version"
        ? { stdout: "0.8.0", stderr: "", code: 0 }
        : {
            stdout: JSON.stringify({ result: { agents: [] } }),
            stderr: "",
            code: 0,
          },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "disabled-child-parent",
        label: "disabled-child-parent",
        task: "must reject disabled child",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(
      result.details.error.message,
      /references disabled agent definition disabled-child/,
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(parentPath, { force: true });
    realFs.rmSync(childPath, { force: true });
  }
});

test("session delegation starts a new agent generation with current prompt contents", async () => {
  setLeadEnvironment();
  const name = `prompt-resume-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  realFs.writeFileSync(promptPath, "current saved-session prompt");
  realFs.writeFileSync(session.path, "{}", "utf8");
  writePromptDefinition(definitionPath, name, promptPath);
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-deleted-session.jsonl`),
  });
  const launched: { args: string[]; contents: string[] }[] = [];
  const startup = startupExecutor(
    label,
    () => session.id,
    undefined,
    undefined,
    false,
    (args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    },
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: session.path,
        task: "resume current prompt",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched[0].contents.length, 2);
    assert.equal(result.details.session_id, session.id);
    assert.equal((result.details as any).reusable, undefined);
    assert.equal((result.details as any).keepAlive, undefined);
    const state = readAgentState(startup.mailbox)!;
    assert.equal(state.version, 4);
    assert.equal(state.piSessionId, session.id);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /current saved-session prompt/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    const sessionIndex = launched[0].args.indexOf("--session");
    assert.equal(
      launched[0].args[sessionIndex + 1],
      realFs.realpathSync(session.path),
    );
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startup.mailbox);
    resetAgentMailbox(staleMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("session delegation ignores an unrelated missing live session path", async () => {
  setLeadEnvironment();
  const name = `stale-live-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const staleLabel = `${name}-stale`;
  const staleExpectedPath = join(PI_AGENT_ROOT, `${name}-stale.jsonl`);
  const staleObservedPath = join(PI_AGENT_ROOT, `${name}-deleted.jsonl`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: staleExpectedPath,
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: staleObservedPath,
    },
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nmissing live session test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  realFs.writeFileSync(staleExpectedPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  let started = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isAgentList(args) && !started)
        return {
          stdout: JSON.stringify({ result: { agents: [staleAgent] } }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        started = true;
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", session: sessionPath, task: "continue" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.session_id, session.id);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      true,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(staleExpectedPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session delegation keeps an exact live ID busy despite a missing path observation", async () => {
  setLeadEnvironment();
  const name = `stale-secondary-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const staleObservedPath = join(PI_AGENT_ROOT, `${name}-deleted.jsonl`);
  const staleLabel = `${name}-stale`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-stale.jsonl`),
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: session.id,
    },
    session_path: staleObservedPath,
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact live ID with stale path test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({ result: { agents: [staleAgent] } }),
          stderr: "",
          code: 0,
        };
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "agent_busy");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session delegation keeps an exact live ID busy despite contradictory live observations", async () => {
  setLeadEnvironment();
  const name = `contradictory-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const unrelatedObservedPath = join(PI_AGENT_ROOT, `${name}-other.jsonl`);
  const staleLabel = `${name}-stale`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-stale.jsonl`),
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: session.id,
    },
    session_id: "22222222-2222-4222-8222-222222222222",
    session_path: unrelatedObservedPath,
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact live ID with contradictory observations test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  realFs.writeFileSync(unrelatedObservedPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({ result: { agents: [staleAgent] } }),
          stderr: "",
          code: 0,
        };
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      result.details.error.category,
      "agent_busy",
      JSON.stringify(result.details),
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(unrelatedObservedPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session delegation fails closed on an exact live ID with a non-ENOENT secondary path error", async () => {
  setLeadEnvironment();
  const name = `error-live-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const notDirectoryPath = join(PI_AGENT_ROOT, `${name}-not-directory`);
  const staleObservedPath = `${notDirectoryPath}/deleted.jsonl`;
  const staleExpectedPath = join(PI_AGENT_ROOT, `${name}-stale.jsonl`);
  const staleLabel = `${name}-stale`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  const staleState = managedState(staleLabel, undefined, {
    ...recoveryIdentity(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: staleExpectedPath,
  });
  const staleAgent = {
    ...agentFromState(staleState),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: session.id,
    },
    session_path: staleObservedPath,
  };
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nlive session path error test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  realFs.writeFileSync(notDirectoryPath, "not a directory", "utf8");
  realFs.writeFileSync(staleExpectedPath, "{}", "utf8");
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, staleState);
  nativeSessions.set(session.id, session);
  const startup = startupExecutor(name, () => session.id);
  let started = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isAgentList(args) && !started)
        return {
          stdout: JSON.stringify({ result: { agents: [staleAgent] } }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start")
        started = true;
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await assert.rejects(
      pi.tools[0].execute(
        "id",
        { action: "delegate", session: sessionPath, task: "must fail" },
        undefined,
        undefined,
        fakeContext(),
      ),
      (error: unknown) => {
        assert.match(String(error), /could not canonicalize/);
        assert.match(String(error), /ENOTDIR/);
        return true;
      },
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(notDirectoryPath, { force: true });
    realFs.rmSync(staleExpectedPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("session delegation fails closed on persisted session path errors", async () => {
  setLeadEnvironment();
  const name = `error-resume-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const notDirectoryPath = join(PI_AGENT_ROOT, `${name}-not-directory`);
  const invalidPersistedPath = `${notDirectoryPath}/session.jsonl`;
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name },
      },
    ],
  };
  const identity = {
    ...recoveryIdentity(label),
    piSessionId: session.id,
    piSessionFile: session.path,
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\npersisted path error test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  realFs.writeFileSync(notDirectoryPath, "not a directory", "utf8");
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: invalidPersistedPath,
  });
  const startup = startupExecutor(label, () => session.id);
  const pi = fakePi({
    exec: leadExec(label, "idle", session.id, undefined, session.id, identity),
  });
  registerExtension!(pi.pi as never);
  try {
    await assert.rejects(
      pi.tools[0].execute(
        "id",
        { action: "delegate", session: sessionPath, task: "must fail closed" },
        undefined,
        undefined,
        fakeContext(),
      ),
      (error: unknown) => {
        assert.match(String(error), /could not canonicalize/);
        assert.match(String(error), /ENOTDIR/);
        return true;
      },
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && ["start", "prompt"].includes(args[1] ?? ""),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(notDirectoryPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("rejects known generated-label envelope overflow before startup", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  realFs.rmSync(startup.mailbox, { recursive: true, force: true });
  const mailboxLimit = 64 * 1024;
  realFs.writeFileSync(
    join(PI_AGENT_ROOT, "settings.json"),
    JSON.stringify({ piHerdsman: { mailboxPayloadLimitBytes: mailboxLimit } }),
  );
  let prompts = 0;
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt")
        prompts++;
      return startup.exec(command, args);
    },
  });
  registerExtension!(pi.pi as never);
  const emptyEnvelope = requestRecordBytes(label, "", "");
  const task = "x".repeat(mailboxLimit - emptyEnvelope + 1);
  assert.equal(requestRecordBytes(label, "", task) > mailboxLimit, true);
  assert.equal(
    requestRecordBytes(label, "", task) <= MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", definition: "agent", task },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.notEqual(result.details.error.rollbackOccurred, true);
    assert.equal(startup.getCount(), 0);
    assert.equal(realFs.existsSync(startup.mailbox), false);
    assert.equal(prompts, 0);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(join(PI_AGENT_ROOT, "settings.json"), { force: true });
  }
});

test("revalidates automatic-label collision sizing before startup", async () => {
  setLeadEnvironment();
  const occupiedLabel = "agent";
  const occupiedMailbox = agentMailboxPath(WORKSPACE, occupiedLabel);
  const replacementMailbox = agentMailboxPath(WORKSPACE, "agent-2");
  const occupiedState = managedState(occupiedLabel);
  let prompts = 0;
  const pi = fakePi({
    exec: leadExec("other-agent", "idle", DEFAULT_PI_SESSION_ID, () => {
      prompts++;
    }),
  });
  registerExtension!(pi.pi as never);
  realFs.rmSync(replacementMailbox, { recursive: true, force: true });
  writeAgentState(occupiedMailbox, occupiedState);
  writeRequest(occupiedMailbox, {
    version: 4,
    runId: occupiedState.runId,
    requestId: REQUEST_ID,
    ownerSessionId: occupiedState.ownerSessionId,
    workspaceId: occupiedState.workspaceId,
    agentLabel: occupiedState.agentLabel,
    paneId: occupiedState.paneId,
    kind: "task",
    text: "occupied request",
    createdAt: Date.now(),
  });
  const occupiedSnapshot = readFileSync(
    `${occupiedMailbox}/state.json`,
    "utf8",
  );
  const initialEnvelope = requestRecordBytes(occupiedLabel, "", "");
  // This fits the initial `agent` identity but exceeds the envelope after
  // the collision selects `agent-2`.
  const task = "x".repeat(MAILBOX_PROTOCOL_LIMIT_BYTES - initialEnvelope);
  assert.equal(
    requestRecordBytes(occupiedLabel, "", task) <= MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  assert.equal(
    requestRecordBytes("agent-2", "", task) > MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", definition: "agent", task },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.notEqual(result.details.error.rollbackOccurred, true);
    assert.equal(
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "start")
        .length,
      0,
    );
    assert.equal(prompts, 0);
    assert.equal(realFs.existsSync(replacementMailbox), false);
    assert.equal(
      readFileSync(`${occupiedMailbox}/state.json`, "utf8"),
      occupiedSnapshot,
    );
    assert.ok(readRequest(occupiedMailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(occupiedMailbox);
    resetAgentMailbox(replacementMailbox);
  }
});

test("rolls back fresh assignment when the authoritative pane makes the request too large", async () => {
  setLeadEnvironment();
  const label = "fresh-envelope-boundary";
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
    false,
    true,
  );
  realFs.rmSync(startup.mailbox, { recursive: true, force: true });
  let prompts = 0;
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt")
        prompts++;
      return startup.exec(command, args);
    },
  });
  registerExtension!(pi.pi as never);
  const preflightEnvelope = requestRecordBytes(label, "", "");
  const task = "x".repeat(131072 - preflightEnvelope);
  assert.equal(requestRecordBytes(label, "", task) <= 131072, true);
  assert.equal(requestRecordBytes(label, "startup-pane", task) > 131072, true);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", definition: "agent", label, task },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "rollback_failure");
    assert.equal(result.details.error.rollbackOccurred, true);
    assert.ok(startup.getCount() > 0, "overflow must reach authoritative pane");
    assert.equal(prompts, 0, "overflow must not submit a control marker");
    assert.deepEqual(
      realFs.existsSync(startup.mailbox)
        ? realFs.readdirSync(startup.mailbox)
        : [],
      ["state.json"],
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }

  const reuse = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const reusePi = fakePi({ exec: reuse.exec });
  registerExtension!(reusePi.pi as never);
  try {
    const result = await reusePi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "retry after rollback",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    reusePi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(reuse.mailbox);
  }
});

test("rejects invalid assignment prerequisites before lifecycle mutation", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const prefix = `fresh-${randomUUID().slice(0, 8)}`;
  const cases = [
    {
      label: `${prefix}-missing-agent`,
      params: { action: "delegate" },
      message: "Delegate requires exactly one of definition or session",
    },
    {
      label: `${prefix}-whitespace-agent`,
      params: { action: "delegate", definition: " \t", task: " \t" },
      message:
        "Fields must contain non-whitespace text when supplied: definition, task",
    },
    {
      label: `${prefix}-missing-task`,
      params: { action: "delegate", definition: "agent" },
      message: "Definition delegation requires a non-empty task",
    },
    {
      label: `${prefix}-whitespace-task`,
      params: { action: "delegate", definition: "agent", task: " \t" },
      message: "Fields must contain non-whitespace text when supplied: task",
    },
  ];

  for (const { label, params, message } of cases) {
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const before = readAgentState(mailbox);
    const result = await pi.tools[0].execute(
      "id",
      { ...params, label },
      undefined,
      undefined,
      fakeContext(),
    );

    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.message, message);
    assert.deepEqual(pi.calls, []);
    assert.deepEqual(readAgentState(mailbox), before);
  }
});

test("enforces the agent label grammar before assignment lifecycle mutation", async () => {
  setLeadEnvironment();
  const validLabel = "a" + "b".repeat(31);
  const startup = startupExecutor(validLabel, () => DEFAULT_PI_SESSION_ID);
  const acceptedPi = fakePi({ exec: startup.exec });
  registerExtension!(acceptedPi.pi as never);
  const accepted = await acceptedPi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      label: validLabel,
      task: "accept the maximum valid label",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(accepted.details.ok, true, JSON.stringify(accepted.details));
  assert.equal(accepted.details.agent, validLabel);
  acceptedPi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startup.mailbox);

  setLeadEnvironment();
  const invalidPi = fakePi();
  registerExtension!(invalidPi.pi as never);
  for (const label of [
    "a" + "b".repeat(32),
    "A" + "b".repeat(10),
    "agent.label",
  ]) {
    const result = await invalidPi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "reject the invalid label",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.operation, "delegate");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /Agent label must start/);
    assert.deepEqual(invalidPi.calls, []);
    assert.equal(realFs.existsSync(agentMailboxPath(WORKSPACE, label)), false);
  }
  for (const params of [
    { action: "delegate", agent: "Agent", task: "reject the agent" },
    { action: "steer", agent: "Agent", message: "reject the agent" },
    { action: "reply", agent: "Agent", message: "reject the agent" },
    { action: "close", agent: "Agent" },
  ]) {
    const result = await invalidPi.tools[0].execute(
      "id",
      params,
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /Agent label must start/);
    assert.deepEqual(invalidPi.calls, []);
  }
  invalidPi.events.get("session_shutdown")?.[0]();
});

test("rejects an invalid generated collision label after releasing its claim", async () => {
  setLeadEnvironment();
  const label = "a" + "b".repeat(31);
  const definitionPath = join(PI_AGENTS_DIR, `${label}.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const visibleMailbox = agentMailboxPath(WORKSPACE, "other-agent");
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${label}\n---\nlong-name collision test\n`,
  );
  writeAgentState(visibleMailbox, managedState("other-agent"));
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: listResponse("other-agent"),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  context.isProjectTrusted = () => {
    // Simulate the mailbox becoming visible after the assignment snapshot.
    writeAgentState(mailbox, managedState(label));
    return true;
  };

  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: label,
        task: "reject the oversized generated collision label",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.operation, "delegate");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /Agent label must start/);
    assert.equal(realFs.existsSync(join(mailbox, ".starting")), false);
    assert.equal(
      pi.calls.some((args) => args[0] === "pane"),
      false,
      "generated-label rejection must not mutate Herdr topology",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
    realFs.rmSync(visibleMailbox, { recursive: true, force: true });
    realFs.unlinkSync(definitionPath);
  }
});

test("rejects illegal public parameter combinations before lifecycle mutation", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const cases = [
    { action: "delegate", task: "work" },
    {
      action: "delegate",
      definition: "agent",
      session: "/tmp/session.jsonl",
      task: "work",
    },
    { action: "delegate", agent: "agent", task: "work" },
    { action: "delegate", definition: "agent", reusable: true, task: "work" },
    { action: "delegate", agent: "agent", timeoutMs: 5001, task: "work" },
    { action: "delegate", agent: "agent", message: "wrong", task: "work" },
    { action: "delegate", definition: "agent", label: " ", task: "work" },
    { action: "delegate", definition: "agent", cwd: "\t", task: "work" },
    { action: "delegate", definition: "agent", fork: "\n", task: "work" },
    {
      action: "delegate",
      session: "/tmp/session.jsonl",
      label: "agent",
      task: "work",
    },
    {
      action: "delegate",
      session: "/tmp/session.jsonl",
      cwd: "/tmp",
      task: "work",
    },
    {
      action: "delegate",
      session: "/tmp/session.jsonl",
      fork: "/tmp/source.jsonl",
      task: "work",
    },
    {
      action: "delegate",
      session: "/tmp/session.jsonl",
      fork: "/tmp/source.jsonl",
      message: "wrong",
      task: "work",
    },
    { action: "steer", message: "change" },
    { action: "steer", agent: "agent" },
    { action: "close" },
  ];
  for (const params of cases) {
    const result = await pi.tools[0].execute(
      "id",
      params,
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.deepEqual(pi.calls, []);
  }
  const aggregate = await pi.tools[0].execute(
    "id",
    {
      action: "delegate",
      session: "/tmp/session.jsonl",
      fork: "/tmp/fork.jsonl",
      message: "wrong",
      task: "work",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(aggregate.details.error.category, "invalid_request");
  assert.match(
    aggregate.details.error.message,
    /Session delegation does not support: fork, message/,
  );
  assert.match(
    aggregate.details.error.message,
    /Allowed: action, session, label, task, files, timeoutMs/,
  );
  assert.deepEqual(pi.calls, []);
  const legacy = await pi.tools[0].execute(
    "id",
    { action: "close", label: "agent" } as any,
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(legacy.details.error.category, "invalid_request");
  assert.match(legacy.details.error.message, /close does not support: label/);
  assert.deepEqual(pi.calls, []);
});

test("assignment launch handles delayed official Pi session identity", async () => {
  const expectedSession = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const cases = [
    {
      label: "delayed-session-agent",
      task: "delayed identity",
      session: (count: number) => (count < 3 ? null : expectedSession),
      expectedCount: 4,
      retry: false,
    },
    {
      label: "null-session-agent",
      task: "retry null identity",
      session: (count: number) => (count === 1 ? null : expectedSession),
      expectedCount: 3,
      retry: true,
    },
  ];

  for (const { label, task, session, expectedCount, retry } of cases) {
    setLeadEnvironment();
    const startup = startupExecutor(
      label,
      session,
      undefined,
      undefined,
      retry,
    );
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    try {
      const result = await pi.tools[0].execute(
        "id",
        { action: "delegate", definition: "agent", label, task },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(startup.getCount(), expectedCount);
      assert.equal(result.details.session_id, expectedSession);
      if (!retry)
        assert.equal(
          pi.calls.some((args) => isPreservePaneStop(args)),
          false,
        );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    }
  }
});

test("empty early launch cleans exact resources and same-label retry creates one agent", async () => {
  setLeadEnvironment();
  const label = "early-diagnostic-retry";
  const startup = startupExecutor(
    label,
    () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  );
  let starts = 0;
  let splits = 0;
  let closes = 0;
  let panePresent = false;
  let closeProvedByList = false;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isPaneList(args)) {
        if (closes > 0 && !panePresent) closeProvedByList = true;
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                {
                  pane_id: "source-pane",
                  tab_id: "startup-tab",
                  workspace_id: WORKSPACE,
                  cwd: "/other",
                  foreground_cwd: "/other",
                  agent_status: "unknown",
                },
                ...(panePresent
                  ? [
                      {
                        pane_id: "startup-pane",
                        tab_id: "startup-tab",
                        workspace_id: WORKSPACE,
                        cwd: "/tmp",
                        foreground_cwd: "/tmp",
                        agent_status: "unknown",
                      },
                    ]
                  : []),
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        assert.equal(panePresent, false);
        panePresent = true;
        splits++;
        return startup.exec(command, args, options);
      }
      if (command === "herdr" && isPaneClose(args)) {
        assert.equal(panePresent, true);
        assert.equal(args[2], "startup-pane");
        panePresent = false;
        closes++;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        args[1] === "process-info"
      )
        return {
          stdout: JSON.stringify({
            result: {
              process: {
                pane_id: args[3],
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        starts++;
        if (starts === 1) return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "read")
        return {
          stdout: "Unknown extension: /tmp/broken-extension.ts",
          stderr: "",
          code: 0,
          killed: false,
        };
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  const tool = pi.tools[0];
  const context = fakeContext();
  const failed = await tool.execute(
    "id",
    { action: "delegate", definition: "agent", label, task: "first attempt" },
    undefined,
    undefined,
    context,
  );
  assert.equal(failed.details.error.category, "internal_failure");
  assert.equal(failed.details.error.details.stage, "agent_start");
  assert.equal(failed.details.error.details.result.classification, "empty");
  assert.equal(failed.details.error.details.paneSnapshotAttempted, true);
  assert.equal(failed.details.error.details.paneSnapshotStatus, "captured");
  assert.equal(failed.details.error.details.paneSnapshotReason, undefined);
  assert.ok(failed.details.error.details.paneSnapshot.length <= 8192);
  assert.match(
    failed.details.error.message,
    /Unknown extension.*broken-extension/,
  );
  assert.equal(failed.details.error.ids.paneId, "startup-pane");
  assert.equal(failed.details.error.ids.tabId, "startup-tab");
  assert.equal(readAgentState(startup.mailbox), undefined);
  assert.equal(
    pi.calls.filter((args) => args[0] === "pane" && args[1] === "read").length,
    1,
  );
  assert.equal(closes, 1);
  assert.equal(closeProvedByList, true);
  assert.equal(panePresent, false);

  const listed = await tool.execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(listed.details.agents, []);
  const retried = await tool.execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      label,
      task: "corrected attempt",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(retried.details.ok, true);
  assert.equal(starts, 2);
  assert.equal(splits, 2);
  assert.equal(panePresent, true);
  assert.equal(readAgentState(startup.mailbox)?.agentLabel, label);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startup.mailbox);
});

test("assignment launch bounds missing official Pi session identity grace", async () => {
  setLeadEnvironment();
  const label = "missing-session-agent";
  const startup = startupExecutor(
    label,
    () => null,
    undefined,
    undefined,
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const result = await pi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      label,
      task: "missing identity",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(startup.getCount(), 9);
  assert.equal(result.details.error.category, "invalid_request");
  assert.match(
    result.details.error.message,
    /official Pi integration did not report its session identity/,
  );
  assert.equal(result.details.error.retryAttempted, true);
  assert.equal(pi.calls.filter((args) => isPreservePaneStop(args)).length, 1);
  assert.equal(pi.calls.filter((args) => isPaneClose(args)).length, 1);
  pi.events.get("session_shutdown")?.[0]();
});

test("assignment integration grace aborts without a later lookup or timer", async () => {
  setLeadEnvironment();
  const controller = new AbortController();
  const label = "aborted-session-agent";
  const startup = startupExecutor(
    label,
    () => null,
    (count) => {
      if (count === 1) setTimeout(() => controller.abort(), 10);
    },
  );
  const pi = fakePi({
    exec: (command, args, options) => {
      if (options?.signal?.aborted) throw new Error("aborted executor signal");
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  const startedAt = Date.now();
  const result = await pi.tools[0].execute(
    "id",
    { action: "delegate", definition: "agent", label, task: "abort identity" },
    controller.signal,
    undefined,
    fakeContext(),
  );
  assert.ok(Date.now() - startedAt < 2500);
  assert.equal(result.details.error.category, "rollback_failure");
  assert.equal(startup.getCount(), 1);
  const cleanupCalls = pi.calls.filter(
    (args) =>
      isPreservePaneStop(args) || isPaneClose(args) || isHerdrList(args),
  );
  assert.equal(
    cleanupCalls.some((args) => isPaneClose(args)),
    true,
  );
  assert.equal(
    cleanupCalls.some((args) => isPreservePaneStop(args)),
    true,
  );
  const firstCleanupIndex = pi.calls.findIndex((args) =>
    isPreservePaneStop(args),
  );
  assert.equal(
    pi.execOptions
      .filter((_options, index) => {
        if (index < firstCleanupIndex) return false;
        const args = pi.calls[index];
        return (
          isPreservePaneStop(args) || isPaneClose(args) || isHerdrList(args)
        );
      })
      .some((options) => options.signal?.aborted === true),
    false,
  );
  assert.ok(readAgentState(startup.mailbox));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(startup.getCount(), 1);
  pi.events.get("session_shutdown")?.[0]();
});
