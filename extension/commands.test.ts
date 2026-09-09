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
  claimChiefLease,
  supervisionRuntime,
  readLeadCoordinationState,
  writeLeadCoordinationState,
} from "./supervision.ts";
import { OperationError } from "./errors.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  NON_PI_AGENT,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  StatusWidget,
  AGENT_ID,
  WORKSPACE,
  agentFromState,
  buildStatusRows,
  cascadeExecutor,
  defaultFixtureIdentity,
  discoverAgent,
  fakeContext,
  fakePi,
  fakeAgentContext,
  herdrAlias,
  isAgentList,
  isPaneList,
  isTabList,
  listResponse,
  managedState,
  nativeSessions,
  projectContextCwds,
  readAgentState,
  realFs,
  recoveryIdentity,
  registerExtension,
  renderRunningOptions,
  resetAgentMailbox,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setAgentEnvironment,
  startupExecutor,
  stopSummary,
  visibleWidth,
  waitForTestCondition,
  agentMailboxPath,
  writeResult,
  writeAgentState,
} from "./support.ts";
test("partial supervision registration is rolled back when host restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-registration-rollback-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({
    activeTools: ["read", "bash"],
    autoActivateRegisteredTools: true,
    entries,
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  const registerTool = pi.pi.registerTool.bind(pi.pi);
  pi.pi.registerTool = (tool: unknown) => {
    registerTool(tool);
    throw new Error("tool registration failed");
  };
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("tool restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("", context);

  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  assert.ok(pi.tools.some((tool) => tool.name === "staff"));
  assert.ok(notices.includes("tool restoration failed"));
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief shutdown releases its lease when ordinary tool restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-suspend-failure-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.includes("read")) {
      failRestore = false;
      throw new Error("tool restoration failed");
    }
    setActiveTools(next);
  };

  await pi.events.get("session_shutdown")![0]();

  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-role" && entry.data.role === "chief",
    ),
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief activation keeps its baseline when activation rollback also fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-activation-rollback-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  const setActiveTools = pi.pi.setActiveTools;
  let activationAttempted = false;
  let failures = 2;
  pi.pi.setActiveTools = (next: string[]) => {
    if (next.includes("staff")) {
      activationAttempted = true;
      throw new Error("Chief activation failed");
    }
    if (
      activationAttempted &&
      failures > 0 &&
      next.join("|") === baseline.join("|")
    ) {
      failures--;
      throw new Error("Chief baseline restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("", context);

  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  assert.deepEqual(notices, ["Chief activation failed"]);
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief session-start restoration failure does not skip role recovery", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-start-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("session-start restoration failed");
    }
    setActiveTools(next);
  };

  await pi.events.get("session_start")![0](undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("session-start restoration failed"),
    ),
  );
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("manual chief leave completes lead cleanup when tool restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-leave-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("manual leave restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("leave", context);

  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-role" && entry.data.role === "lead",
    ),
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("lead session-start retries an exact baseline after restoration fails", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-lead-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({ activeTools: ["read", "bash"], entries });
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const baseline = ["read", "bash", "agent", "chief"];
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "lead" },
  });
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("lead session-start restoration failed");
    }
    setActiveTools(next);
  };

  await start(undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("lead session-start restoration failed"),
    ),
  );
  await start(undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
});

test("lead session-start continues when chief lease release fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-release-failure-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakePi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "lead" },
  });
  const runtime = supervisionRuntime();
  const owner = realFs.readdirSync(runtime.lock)[0];
  assert.ok(owner);
  realFs.writeFileSync(join(runtime.lock, owner), "{}");

  await start(undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), ["read", "bash", "agent", "chief"]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("Chief supervision lease ownership changed"),
    ),
  );
  await pi.events.get("session_shutdown")?.[0]();
  realFs.rmSync(runtime.root, { recursive: true, force: true });
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
});

test("Chief activation rejects owned work outside the current workspace", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const foreignWorkspace = `foreign-${randomUUID()}`;
  const mailbox = agentMailboxPath(foreignWorkspace, "foreign-agent");
  writeAgentState(mailbox, {
    ...managedState("foreign-agent"),
    workspaceId: foreignWorkspace,
    ownerSessionId: LEAD_SESSION_ID,
  });
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args)
        ? {
            stdout: JSON.stringify({ result: { agents: [] } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeContext() as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  assert.ok(notices.some((message) => /owned agent work exists/.test(message)));
  realFs.rmSync(mailbox, { recursive: true, force: true });
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("lead agents command uses native completion and exact human grammar", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  assert.deepEqual(
    pi.entryRenderers.map((entry) => entry.customType),
    ["pi-herdsman-agent-definitions", "pi-herdsman-herd-run"],
  );
  assert.ok(
    pi.messageRenderers.some(
      (message) => message.customType === "pi-herdsman-stop-summary",
    ),
  );
  const command = pi.commandOptions.get("agents");
  assert.ok(command);
  assert.deepEqual(command.getArgumentCompletions(""), [
    { value: "definitions", label: "definitions" },
    { value: "placement", label: "placement" },
    { value: "stop", label: "stop" },
  ]);
  assert.deepEqual(command.getArgumentCompletions("placement "), [
    { value: "placement tab", label: "tab" },
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  assert.deepEqual(command.getArgumentCompletions("placement s"), [
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  const context = fakeContext([]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.select = async () => undefined;
  context.ui.notify = (message: string) => notices.push(message);
  await command.handler("", context);
  await command.handler("agents extra", context);
  await command.handler("placement invalid", context);
  assert.deepEqual(notices, [
    "Usage: /agents definitions | placement [tab|subtree|split] | stop",
    "Usage: /agents placement [tab|subtree|split]",
  ]);
  assert.equal(pi.calls.length, 2);
});

test("/agents placement subtree writes and rereads trusted project settings", async () => {
  setLeadEnvironment();
  const projectRoot = join(PI_AGENT_ROOT, "placement-project");
  const projectSettings = join(projectRoot, ".pi", "settings.json");
  realFs.mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  realFs.writeFileSync(
    projectSettings,
    JSON.stringify({ piHerdsman: { spawnPlacement: "tab" } }),
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = projectRoot;
  context.hasUI = true;
  try {
    await pi.commandOptions.get("agents").handler("placement subtree", context);
    assert.equal(
      JSON.parse(realFs.readFileSync(projectSettings, "utf8")).piHerdsman
        .spawnPlacement,
      "subtree",
    );
  } finally {
    realFs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Chief activation replaces the lead widget and overview selection is interactive", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const lead = {
    agent: "pi",
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: PARENT_SESSION_ID,
    },
    tokens: {
      pi_herdsman_role: "lead",
    },
  };
  const entries: unknown[] = [];
  const pi = fakePi({
    activeTools: ["agent", "chief", "read"],
    autoActivateRegisteredTools: true,
    entries,
    exec: (_command, args) => {
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({ result: { agents: [lead] } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return { stdout: JSON.stringify({ agent: lead }), stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  const widgetKeys: string[] = [];
  const confirmations: string[] = [];
  const notices: string[] = [];
  let confirmLeave = false;
  let overview: any;
  let overviewDone = 0;
  let customCalls = 0;
  context.ui = {
    setWidget: (key: string) => widgetKeys.push(key),
    notify: (message: string) => notices.push(message),
    confirm: async (title: string, body: string) => {
      confirmations.push(`${title}\n${body}`);
      return confirmLeave;
    },
    select: async () => undefined,
    custom: async (factory: any) => {
      customCalls++;
      overview = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        () => overviewDone++,
      );
    },
  };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => ({ unref: () => undefined })) as any;
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    globalThis.setInterval = originalSetInterval;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    instanceId: randomUUID(),
    piSessionId: PARENT_SESSION_ID,
    pendingAsk: {
      askId: randomUUID(),
      question: "remote question",
      text: "Question: remote question",
    },
    updatedAt: Date.now(),
  });
  assert.deepEqual(pi.pi.getActiveTools(), ["read", "agent", "chief"]);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  assert.ok(widgetKeys.includes("pi-herdsman"));
  assert.ok(widgetKeys.includes("pi-herdsman-staff"));
  assert.equal(
    pi.commandOptions.get("chief").description,
    "Activate chief mode, or open its overview when already active",
  );
  assert.equal(customCalls, 0);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  assert.equal(customCalls, 1);
  assert.ok(overview);
  assert.match(overview.render(120).join("\n"), /Pi Herdsman ·/);
  assert.doesNotMatch(overview.render(120).join("\n"), /Pi Chief/);
  assert.doesNotMatch(overview.render(120).join("\n"), /├─|└─/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(overview.render(120).every((line: string) => line.length <= 120));
  const customCallsBeforePeek = customCalls;
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(customCalls, customCallsBeforePeek);
  overview.handleInput("\u001b");
  assert.equal(overviewDone, 0);
  await pi.commandOptions.get("chief").handler("", context);
  assert.ok(overview);
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  overview.handleInput(" ");
  assert.equal(overviewDone, 0);
  await pi.commandOptions.get("chief").handler("", context);
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  overview.handleInput("\u0003");
  assert.equal(overviewDone, 1);
  await pi.commandOptions.get("chief").handler("", context);
  assert.ok(overview);
  overview.handleInput("\u001b[B");
  overview.handleInput("\r");
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(overviewDone, 2, notices.join(" | "));
  const entriesBeforeCancel = entries.length;
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.match(confirmations[0], /Outstanding supervised lead asks: 1/);
  assert.equal(pi.pi.getActiveTools().includes("staff"), true);
  assert.equal(entries.length, entriesBeforeCancel);
  assert.equal(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-role" && entry.data.role === "lead",
    ),
    false,
  );
  confirmLeave = true;
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), ["read", "agent", "chief"]);
  assert.match(confirmations[1], /Supervised leads will not be changed/);
  const baseline = pi.pi.getActiveTools();
  const setActiveTools = pi.pi.setActiveTools;
  pi.pi.setActiveTools = (next: string[]) => {
    if (next.includes("staff")) throw new Error("tool activation failed");
    setActiveTools(next);
  };
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  assert.ok(notices.includes("tool activation failed"));
});

test("Chief shutdown restores tools before a fresh runtime resumes", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-reload-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const ordinaryTools = ["read", "bash", "agent", "chief"];
  const pi = fakePi({
    activeTools: ["agent", "chief", "read", "bash"],
    entries,
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);

  await pi.events.get("session_shutdown")![0]();
  assert.deepEqual(pi.pi.getActiveTools(), ordinaryTools);

  const reloaded = fakePi({
    activeTools: pi.pi.getActiveTools(),
    entries: [...entries],
  });
  const reloadedContext = fakeContext(reloaded.entries) as any;
  reloadedContext.mode = "rpc";
  reloadedContext.ui.notify = () => undefined;
  registerExtension!(reloaded.pi as never);
  await reloaded.events.get("session_start")![0](undefined, reloadedContext);
  assert.deepEqual(reloaded.pi.getActiveTools(), ["staff"]);
  await reloaded.commandOptions.get("chief").handler("leave", reloadedContext);
  assert.deepEqual(reloaded.pi.getActiveTools(), ordinaryTools);

  await reloaded.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

async function openChiefOverview(
  populated: boolean,
  options: {
    failSetWidget?: boolean;
    failRender?: boolean;
    failRefresh?: boolean;
    openOverview?: boolean;
  } = {},
) {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-tui-${randomUUID()}.sock`,
  );
  let failRefresh = options.failRefresh ?? false;
  const agents = populated
    ? [
        {
          agent: "pi",
          pane_id: "lead-pane",
          tab_id: "lead-tab",
          workspace_id: WORKSPACE,
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: PARENT_SESSION_ID,
          },
          tokens: { pi_herdsman_role: "lead" },
        },
      ]
    : [];
  const pi = fakePi({
    activeTools: ["agent", "chief", "read"],
    entries: [],
    exec: (_command, args) => {
      if (failRefresh && isAgentList(args))
        throw new Error("supervision unavailable");
      return isAgentList(args)
        ? {
            stdout: JSON.stringify({ result: { agents } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext([]) as any;
  context.hasUI = true;
  let component: any;
  let customCalls = 0;
  let doneCalls = 0;
  let renderRequests = 0;
  const widgetRegistrations: Array<{ key: string; content: unknown }> = [];
  context.ui = {
    setWidget: (key: string, content: unknown) => {
      if (options.failSetWidget && key === "pi-herdsman-staff")
        throw new Error("widget registration failed");
      widgetRegistrations.push({ key, content });
      if (content !== undefined) assert.equal(typeof content, "function");
      if (typeof content === "function")
        component = content(
          {
            requestRender: () => {
              if (options.failRender) throw new Error("render failed");
              renderRequests++;
            },
          },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    confirm: async () => false,
    select: async () => undefined,
    custom: async (factory: any) => {
      customCalls++;
      component = factory(
        { requestRender: () => renderRequests++ },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        () => doneCalls++,
      );
    },
  };
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  if (populated)
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      instanceId: randomUUID(),
      piSessionId: PARENT_SESSION_ID,
      updatedAt: Date.now(),
    });
  if (options.openOverview !== false)
    await pi.commandOptions.get("chief").handler("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  return {
    pi,
    context,
    component,
    get customCalls() {
      return customCalls;
    },
    get doneCalls() {
      return doneCalls;
    },
    get renderRequests() {
      return renderRequests;
    },
    setFailRefresh(value: boolean) {
      failRefresh = value;
    },
    widgetRegistrations,
    async cleanup() {
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_TAB_ID;
      setLeadEnvironment();
    },
  };
}

test("registered chief widget obeys registration, refresh, and teardown contracts", async () => {
  const originalSetInterval = globalThis.setInterval;
  const callbacks: TimerHandler[] = [];
  globalThis.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback);
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  try {
    const harness = await openChiefOverview(false, {
      openOverview: false,
    });
    const registrations = harness.widgetRegistrations.filter(
      ({ key, content }) =>
        key === "pi-herdsman-staff" && content !== undefined,
    );
    assert.equal(registrations.length, 1);
    assert.equal(typeof registrations[0].content, "function");
    assert.equal(typeof harness.component.render, "function");
    assert.equal(typeof harness.component.invalidate, "function");
    const before = harness.renderRequests;
    (callbacks.at(-1) as () => void)();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.renderRequests > before);
    assert.equal(
      harness.widgetRegistrations.filter(
        ({ key, content }) =>
          key === "pi-herdsman-staff" && content !== undefined,
      ).length,
      1,
    );
    await harness.cleanup();
    const teardown = harness.widgetRegistrations.filter(
      ({ key, content }) =>
        key === "pi-herdsman-staff" && content === undefined,
    );
    assert.ok(teardown.length > 0);
    assert.equal(teardown.at(-1)?.content, undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("Chief overview closes on native Escape and Ctrl+C with no herds", async () => {
  for (const key of ["\u001b", "\u0003"]) {
    const harness = await openChiefOverview(false);
    harness.component.handleInput(key);
    assert.equal(harness.doneCalls, 1);
    await harness.cleanup();
  }
});

test("Chief overview reports unavailable when its first refresh fails", async () => {
  const harness = await openChiefOverview(false, {
    failRefresh: true,
  });
  try {
    const output = harness.component.render(120).join("\n");
    assert.match(output, /Pi Herdsman · unavailable/);
    assert.doesNotMatch(output, /0 herds/);
  } finally {
    await harness.cleanup();
  }
});

test("Chief overview redraws identical herds when freshness changes", async () => {
  const originalSetInterval = globalThis.setInterval;
  const callbacks: TimerHandler[] = [];
  globalThis.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback);
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  try {
    const harness = await openChiefOverview(true);
    try {
      assert.match(harness.component.render(120).join("\n"), /1 herd/);
      assert.doesNotMatch(
        harness.component.render(120).join("\n"),
        /stale|unavailable/,
      );

      harness.setFailRefresh(true);
      (callbacks.at(-1) as () => void)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(harness.component.render(120).join("\n"), /1 herd · stale/);

      harness.setFailRefresh(false);
      (callbacks.at(-1) as () => void)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(harness.component.render(120).join("\n"), /1 herd/);
      assert.doesNotMatch(
        harness.component.render(120).join("\n"),
        /stale|unavailable/,
      );
    } finally {
      await harness.cleanup();
    }
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("Chief overview redraws after a background refresh", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<object>();
  let intervalCalls = 0;
  let refresh: (() => void) | undefined;
  globalThis.setInterval = ((callback: TimerHandler) => {
    refresh = callback as () => void;
    intervalCalls++;
    const timer = { unref: () => undefined };
    activeTimers.add(timer);
    return timer as any;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: any) => {
    activeTimers.delete(timer);
  }) as typeof clearInterval;
  try {
    const harness = await openChiefOverview(true);
    assert.equal(intervalCalls, 2);
    assert.equal(activeTimers.size, 1);
    const before = harness.renderRequests;
    refresh!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.renderRequests > before);
    await harness.cleanup();
    assert.equal(activeTimers.size, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("active chief shutdown clears its role before releasing the lease", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args)
        ? {
            stdout: JSON.stringify({ result: { agents: [] } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeContext() as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const activationCallCount = pi.calls.length;
  await pi.events.get("session_shutdown")?.[0]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const shutdownMetadata = pi.calls
    .slice(activationCallCount)
    .filter((args) => args[0] === "pane" && args[1] === "report-metadata");
  assert.ok(shutdownMetadata.some((args) => args.includes("--clear-token")));
  assert.ok(
    shutdownMetadata.every((args) => !args.includes("pi_herdsman_role=lead")),
  );
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("Chief resume rejects a persisted pending chief ask without activation", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief" },
    },
    {
      type: "custom",
      customType: "pi-herdsman-lead-state",
      data: {
        pendingAsk: {
          askId: "11111111-1111-4111-8111-111111111111",
          question: "Need a decision",
          text: "Question: Need a decision",
        },
      },
    },
  ];
  const pi = fakePi({ entries, activeTools: ["agent", "chief"] });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["agent", "chief"]);
  assert.equal(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-role" && entry.data.role === "chief",
    ),
    true,
  );
  assert.equal(pi.pi.getActiveTools().includes("staff"), false);
  assert.equal(
    realFs.existsSync(supervisionRuntime().lock) &&
      realFs.readdirSync(supervisionRuntime().lock).length > 0,
    false,
  );
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("persisted chief resume isolates tools and restores its ordinary baseline", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-resume-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief" },
    },
  ];
  const pi = fakePi({
    entries,
    activeTools: ["read", "bash", "foreign_tool"],
    exec: (_command, args) =>
      isAgentList(args)
        ? {
            stdout: JSON.stringify({ result: { agents: [] } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["staff"]);
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), ["read", "bash", "foreign_tool"]);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  setLeadEnvironment();
});

test("persisted chief collision is suspended and has no lead authority", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: { role: "chief" },
    },
  ];
  const incumbent = claimChiefLease({
    piSessionId: "incumbent-session",
    paneId: "incumbent-pane",
    tabId: "incumbent-tab",
    workspaceId: "incumbent-workspace",
  });
  try {
    const pi = fakePi({ entries, activeTools: ["agent", "chief"] });
    registerExtension!(pi.pi as never);
    const context = fakeContext(entries) as any;
    context.ui.notify = () => undefined;
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), []);
    assert.equal(
      readLeadCoordinationState(
        supervisionRuntime(),
        context.sessionManager.getSessionId(),
      ),
      undefined,
    );
    await pi.events.get("session_shutdown")?.[0]();
  } finally {
    incumbent.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("plain agents opens the native management menu", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            result: { workspace_id: WORKSPACE, agents: [] },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({ result: { panes: [] } }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1)
      return options.find((option) => option.startsWith("Layout"));
    return undefined;
  };
  await command.handler("", context);
  assert.equal(prompts[0]?.label, "agents");
  assert.deepEqual(
    prompts[0]?.options.map((option) => option.replace(/\s+.*/u, "")),
    ["Running", "Definitions", "Layout", "Message", "Stop"],
  );
  assert.equal(prompts[1]?.label, "Layout");
  assert.deepEqual(prompts[1]?.options, [
    "Lead agents tab",
    "Subtree tabs (current)",
    "Split from caller",
  ]);
  await pi.events.get("session_shutdown")?.[0]();
});

test("message limits use global byte settings and one rough token formatter", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1) return "Message limits";
    if (prompts.length === 2) return options[0];
    if (prompts.length === 3) return options[1];
    return undefined;
  };
  await command.handler("", context);
  assert.equal(prompts[1]?.label, "Message limits");
  assert.match(prompts[1]?.options[0] ?? "", /≈32,768 tokens/);
  assert.match(prompts[1]?.options[1] ?? "", /≈32,768 tokens/);
  assert.ok(prompts.every(({ label }) => label !== "Scope"));
  assert.deepEqual(prompts[2]?.options, [
    "1 KiB · ≈256 tokens",
    "4 KiB · ≈1,024 tokens",
    "16 KiB · ≈4,096 tokens",
    "64 KiB · ≈16,384 tokens",
    "128 KiB · ≈32,768 tokens",
    "Custom…",
    "Reset",
  ]);
  assert.match(notices.at(-1) ?? "", /4 KiB · ≈1,024 tokens/);
  await pi.events.get("session_shutdown")?.[0]();
});

test("Running uses compact native options and focuses the freshly verified pane", async () => {
  setLeadEnvironment();
  const label = "running-menu-agent";
  const identity = defaultFixtureIdentity;
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const pi = fakePi({
    exec: leadExec(label, "working", DEFAULT_PI_SESSION_ID),
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.select = async (prompt: string, options: string[]) => {
    prompts.push({ label: prompt, options });
    if (prompts.length === 1) {
      assert.equal(options[0], "Running        1 working");
      return options.find((option) => option.startsWith("Running"));
    }
    if (prompts.length === 2) {
      const expected = renderRunningOptions(
        buildStatusRows(
          [
            {
              label,
              definition: "agent",
              state: "working",
              paneId: identity.paneId,
              sessionId: identity.piSessionId,
            },
          ],
          { now: Date.now() },
        ),
      )[0];
      assert.equal(prompts[1]?.label, "Running");
      assert.equal(options[0], expected);
      assert.match(options[0]!, /└─ agent\s+running-menu-agent\s+● working/);
      assert.doesNotMatch(options[0]!, /⠋|gpt|high|0s|Implement/);
      return options[0];
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "focus" &&
          args[2] === identity.paneId,
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("Running warns when the selected agent is replaced before focus", async () => {
  setLeadEnvironment();
  const label = "running-menu-replaced-agent";
  const identity = defaultFixtureIdentity;
  const replacementIdentity: FixtureIdentity = {
    paneId: "replacement-pane",
    tabId: "replacement-tab",
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/replacement-agent.jsonl",
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  let currentIdentity = identity;
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isAgentList(args))
        return {
          stdout: listResponse(
            label,
            "working",
            currentIdentity.piSessionId,
            currentIdentity,
          ),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                {
                  pane_id: currentIdentity.paneId,
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  agent: label,
                  agent_status: "working",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: { message: string; level?: string }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string, level?: string) =>
    notices.push({ message, level });
  let selection = 0;
  context.ui.select = async (_prompt: string, options: string[]) => {
    if (selection === 0) {
      selection++;
      return options.find((option) => option.startsWith("Running"));
    }
    if (selection === 1) {
      selection++;
      currentIdentity = replacementIdentity;
      writeAgentState(
        mailbox,
        managedState(label, REQUEST_ID, replacementIdentity),
      );
      return options[0];
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "focus"),
      false,
    );
    assert.ok(
      notices.some(
        ({ message, level }) =>
          level === "warning" && message.includes("Agent changed"),
      ),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("Running keeps colliding display labels distinct and focuses the selected pane", async () => {
  setLeadEnvironment();
  const states = [
    {
      label: "reviewer:task",
      definition: "reviewer",
      identity: {
        paneId: "reviewer-task-pane",
        tabId: "reviewer-task-tab",
        piSessionId: "22222222-2222-4222-8222-222222222222",
        piSessionFile: "/tmp/reviewer-task-agent.jsonl",
      },
    },
    {
      label: "scout:task",
      definition: "scout",
      identity: {
        paneId: "scout-task-pane",
        tabId: "scout-task-tab",
        piSessionId: "33333333-3333-4333-8333-333333333333",
        piSessionFile: "/tmp/scout-task-agent.jsonl",
      },
    },
  ] as const;
  const agentStates = states.map(({ label, identity }) => ({
    ...managedState(label, REQUEST_ID, identity),
  }));
  const mailboxes = agentStates.map((state, index) => {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    writeAgentState(mailbox, state);
    nativeSessions.set(state.piSessionFile!, {
      id: state.piSessionId!,
      path: state.piSessionFile!,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            name: states[index]!.definition,
          },
        },
      ],
    });
    return mailbox;
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            action: "list",
            workspace_id: WORKSPACE,
            tab: "",
            tabs: [],
            agents: states.map(({ label, identity }) => ({
              herdr_agent: herdrAlias(label),
              status: "working",
              cwd: "/tmp",
              workspace_id: WORKSPACE,
              pane_id: identity.paneId,
              tab_id: identity.tabId,
              tab_label: "agents",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: identity.piSessionId,
              },
              session_id: identity.piSessionId,
              session_path: identity.piSessionFile,
            })),
            available_panes: [],
            agent_definitions: [],
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes: states.map(({ label, identity }) => ({
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent: label,
                agent_status: "working",
              })),
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  let selection = 0;
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (selection++ === 0)
      return options.find((option) => option.startsWith("Running"));
    if (selection === 2) {
      assert.ok(options.some((option) => option.includes("reviewer:task")));
      assert.ok(options.some((option) => option.includes("scout:task")));
      assert.equal(new Set(options).size, 2);
      return options.find((option) => option.includes("scout:task"));
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "focus" &&
          args[2] === "scout-task-pane",
      ),
    );
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "focus" &&
          args[2] === "reviewer-task-pane",
      ),
      false,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const [index, mailbox] of mailboxes.entries()) {
      resetAgentMailbox(mailbox);
      nativeSessions.delete(states[index]!.identity.piSessionFile);
    }
  }
});

test("Definitions edits standalone definitions through the shared override writer", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "docs-reviewer.md");
  const original =
    '---\nname: docs-reviewer\ndescription: Docs review\nmodel: old/model\nthinking: medium\ntools: ["read"]\n---\n\nKeep this body exactly.\n';
  realFs.writeFileSync(definitionPath, original);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "new", id: "model" }],
    getAvailable: () => [{ provider: "new", id: "model" }],
  };
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (selection++ === 0)
      return options.find((option) => option.includes("docs-reviewer"));
    if (selection === 2) return "Model       old/model";
    if (selection === 3) return "Use default";
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    assert.ok(
      prompts.some(({ options }) =>
        options.some((option) => option.includes("--- Custom ---")),
      ),
    );
    assert.equal(
      realFs.readFileSync(definitionPath, "utf8"),
      original.replace("model: old/model\n", ""),
    );
    assert.ok(
      prompts[0]?.options.some((option) => option.includes("docs-reviewer")),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions Details snapshots effective append and replace instructions", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "scout.md");
  const customDefinitionPath = join(PI_AGENTS_DIR, "details-scout.md");
  const bodyPath = join(PI_AGENT_ROOT, "scout-details-body.md");
  const baseBody = discoverAgent("scout").body;

  const selectDetails = async (
    selectedName: string,
    beforeDetails?: () => void,
  ) => {
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const initialEntryCount = pi.entries.length;
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.hasUI = true;
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    let selection = 0;
    context.ui.select = async (_label: string, options: string[]) => {
      if (selection++ === 0)
        return options.find((option) => option.includes(selectedName));
      if (selection === 2) {
        beforeDetails?.();
        return "Details…";
      }
      return undefined;
    };
    let error: unknown;
    try {
      await command.handler("definitions", context);
    } catch (caught) {
      error = caught;
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
    }
    return {
      entry: [...pi.entries.slice(initialEntryCount)]
        .reverse()
        .find(
          (entry: any) => entry?.customType === "pi-herdsman-agent-definitions",
        ) as
        | {
            customType: string;
            data: {
              definitions: Array<Record<string, unknown>>;
              instructions: string;
            };
          }
        | undefined,
      notices,
      error,
    };
  };

  try {
    realFs.writeFileSync(bodyPath, "file instructions");
    realFs.writeFileSync(
      definitionPath,
      `---\nname: scout\ndescription: before\nbodyMode: append\n---\nAdditional instructions\n@${bodyPath}\n`,
    );
    const appended = discoverAgent("scout");
    assert.equal(
      appended.body,
      `${baseBody}\n\nAdditional instructions\n@${bodyPath}`,
    );
    const appendedResult = await selectDetails("scout", () => {
      realFs.writeFileSync(bodyPath, "mutated after selection");
      realFs.writeFileSync(
        definitionPath,
        `---\nname: scout\ndescription: after\nbodyMode: append\n---\nAdditional instructions\n@${bodyPath}\n`,
      );
    });
    const appendedEntry = appendedResult.entry!;
    assert.equal(
      appendedEntry.data.instructions,
      `${baseBody}\n\nAdditional instructions\nmutated after selection`,
    );
    assert.equal(appendedEntry.data.definitions[0]?.description, "after");

    realFs.writeFileSync(
      definitionPath,
      `---\nname: scout\nbodyMode: replace\n---\nReplacement instructions\n@${bodyPath}\n`,
    );
    const replacedResult = await selectDetails("scout", () => {
      realFs.writeFileSync(bodyPath, "changed file instructions");
    });
    const replacedEntry = replacedResult.entry!;
    assert.equal(
      replacedEntry.data.instructions,
      "Replacement instructions\nchanged file instructions",
    );
    assert.equal(
      appendedEntry.data.instructions,
      `${baseBody}\n\nAdditional instructions\nmutated after selection`,
    );

    realFs.writeFileSync(
      customDefinitionPath,
      `---\nname: details-scout\ndescription: Still available\n---\nStill available\n`,
    );
    const deletedResult = await selectDetails("details-scout", () => {
      realFs.rmSync(customDefinitionPath, { force: true });
    });
    assert.equal(deletedResult.entry, undefined);
    assert.ok(
      deletedResult.notices.some((notice) =>
        notice.includes("Definition details-scout is no longer available."),
      ),
    );

    realFs.writeFileSync(
      customDefinitionPath,
      `---\nname: details-scout\ndescription: Still available\n---\nStill available\n`,
    );
    const invalidResult = await selectDetails("details-scout", () => {
      realFs.writeFileSync(
        customDefinitionPath,
        `---\nname: details-scout\nunknownField: true\n---\nInvalid\n`,
      );
    });
    assert.ok(
      invalidResult.notices.some((notice) =>
        /unknownField|Malformed|invalid/i.test(notice),
      ),
    );
  } finally {
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(customDefinitionPath, { force: true });
    realFs.rmSync(bodyPath, { force: true });
  }
});

test("Definitions Back navigates one menu level at a time", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "provider", id: "model", reasoning: true }],
    getAvailable: () => [
      { provider: "provider", id: "model", reasoning: true },
    ],
  };
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return "Back";
      case 3:
        return options.find((option) => option.startsWith("Thinking"));
      case 4:
        return "Back";
      case 5:
        return "Back";
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        "Definitions",
        "implementer",
        "Model",
        "implementer",
        "Thinking",
        "implementer",
        "Definitions",
      ],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions preserves bundled model and thinking set/default semantics", async () => {
  for (const scenario of [
    { field: "Model", selected: "new-model", property: "model" },
    { field: "Thinking", selected: "medium", property: "thinking" },
  ] as const) {
    setLeadEnvironment();
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
    const prompts: { label: string; options: string[] }[] = [];
    let selection = 0;
    const context = fakeContext() as any;
    context.hasUI = true;
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => [
        { provider: "provider", id: "new-model", reasoning: true },
      ],
      getAvailable: () => [
        { provider: "provider", id: "new-model", reasoning: true },
      ],
    };
    context.ui.select = async (label: string, options: string[]) => {
      prompts.push({ label, options });
      switch (selection++) {
        case 0:
          return options.find((option) => option.includes("implementer"));
        case 1:
          return options.find((option) => option.startsWith(scenario.field));
        case 2:
          return scenario.selected;
        case 3:
          assert.equal(
            discoverAgent("implementer").frontmatter[scenario.property],
            scenario.property === "model" ? "provider/new-model" : "medium",
          );
          return options.find((option) => option.includes("implementer"));
        case 4:
          return options.find((option) => option.startsWith(scenario.field));
        case 5:
          return "Use default";
        default:
          return undefined;
      }
    };
    try {
      await command.handler("definitions", context);
      const content = realFs.readFileSync(definitionPath, "utf8");
      assert.doesNotMatch(content, new RegExp(`^${scenario.property}:`, "m"));
      assert.equal(
        discoverAgent("implementer").frontmatter[scenario.property],
        scenario.property === "model" ? "openai-codex/gpt-5.6-luna" : "high",
      );
      assert.ok(prompts.some(({ label }) => label === scenario.field));
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("Definitions toggles enabled state for bundled definitions", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Enabled"));
      case 2:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, false);
        return options.find((option) => option.includes("implementer"));
      case 3:
        return options.find((option) => option.startsWith("Enabled"));
      case 4:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, true);
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.match(
      realFs.readFileSync(definitionPath, "utf8"),
      /^enabled: true$/m,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions refreshes the model registry before post-model thinking choices", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
  const refreshedModel = {
    provider: "refresh-provider",
    id: "refresh-model",
    reasoning: true,
  };
  let registryModels: (typeof refreshedModel)[] = [];
  const registry = {
    refreshes: 0,
    async refresh() {
      this.refreshes++;
      registryModels = [refreshedModel];
    },
    getAll: () => registryModels,
    getAvailable: () => registryModels,
  };
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.modelRegistry = registry;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return "refresh-model";
      case 3:
        return options.find((option) => option.includes("implementer"));
      case 4:
        return options.find((option) => option.startsWith("Thinking"));
      case 5:
        assert.equal(registry.refreshes, 2);
        assert.ok(options.includes("medium"));
        assert.equal(options.includes("xhigh"), false);
        return "medium";
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.equal(
      discoverAgent("implementer").frontmatter.model,
      "refresh-provider/refresh-model",
    );
    assert.equal(discoverAgent("implementer").frontmatter.thinking, "medium");
    assert.equal(registry.refreshes, 2);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions aligns Unicode names and models by display width", async () => {
  setLeadEnvironment();
  const definitionPaths = [
    join(PI_AGENTS_DIR, "unicode-reviewer-a.md"),
    join(PI_AGENTS_DIR, "unicode-reviewer-b.md"),
  ];
  realFs.writeFileSync(
    definitionPaths[0],
    "---\nname: 審査\nmodel: provider/模型\nthinking: high\n---\nreview\n",
  );
  realFs.writeFileSync(
    definitionPaths[1],
    "---\nname: 設計確認\nmodel: provider/長い名前\nthinking: high\n---\nreview\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: string[][] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.select = async (_label: string, options: string[]) => {
    prompts.push(options);
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    const options = prompts[0] ?? [];
    const rowA = options.find((option) => option.includes("模型"));
    const rowB = options.find((option) => option.includes("長い名前"));
    assert.ok(rowA);
    assert.ok(rowB);
    assert.notEqual("審査".length, visibleWidth("審査"));
    assert.notEqual("設計確認".length, visibleWidth("設計確認"));
    assert.notEqual("模型".length, visibleWidth("模型"));
    assert.notEqual("長い名前".length, visibleWidth("長い名前"));
    const column = (line: string, token: string) => {
      const index = line.indexOf(token);
      assert.notEqual(index, -1);
      return visibleWidth(line.slice(0, index));
    };
    assert.equal(column(rowA, "模型"), column(rowB, "長い名前"));
    assert.equal(column(rowA, "high"), column(rowB, "high"));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const definitionPath of definitionPaths)
      realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions separators are ignored and reopen the list", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: string[][] = [];
  let selections = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.select = async (_label: string, options: string[]) => {
    prompts.push(options);
    return selections++ === 0 ? options[0] : undefined;
  };
  await command.handler("definitions", context);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]![0], "--- Bundled (* overridden) ---");
  assert.deepEqual(prompts[0], prompts[1]);
  await pi.events.get("session_shutdown")?.[0]();
});

test("lead agents stop reports an empty owned inventory safely", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && isAgentList(args)
        ? {
            stdout: JSON.stringify({ result: { agents: [] } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  await command.handler("stop", context);
  await command.handler("stop", context);
  assert.equal(
    pi.sentMessageCalls.filter(
      (call: any) => call.message.customType === "pi-herdsman-stop-summary",
    ).length,
    2,
  );
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi-herdsman-stop-summary",
    ),
    false,
  );
  assert.equal(stopSummary(pi), "No owned agents running.");
});

test("lead agents stop closes a direct subtree agents-first", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "pi-herdsman-parent",
      undefined,
      recoveryIdentity("pi-herdsman-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/pi-herdsman-parent.jsonl",
  };
  const agents = {
    ...managedState(
      "pi-herdsman-agents",
      undefined,
      recoveryIdentity("pi-herdsman-agents"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/pi-herdsman-agents.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, agents.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  for (const state of [parent, agents])
    nativeSessions.set(state.piSessionFile!, {
      id: state.piSessionId!,
      path: state.piSessionFile!,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: { name: "agent" },
        },
      ],
    });
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, agents);
  const lifecycle = cascadeExecutor([parent, agents]);
  const pi = fakePi({ exec: lifecycle.exec, persistMessages: true });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await command.handler("stop", context);
    assert.deepEqual(lifecycle.closeOrder, [
      agents.agentLabel,
      parent.agentLabel,
    ]);
    assert.match(stopSummary(pi), /Stopped 2 agents/);
    assert.match(stopSummary(pi), /✓ pi-herdsman-agents/);
    assert.match(stopSummary(pi), /✓ pi-herdsman-parent/);
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.deepEqual(pi.sentMessageCalls[0]?.options, { triggerTurn: false });
    assert.equal(pi.sentMessageCalls[0]?.message.display, true);
    assert.equal(
      pi.sentMessageCalls[0]?.message.content,
      `[Pi Herdsman] Stop all result:\n${stopSummary(pi)}`,
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-stop-summary" &&
          entry.details.summary === stopSummary(pi),
      ),
    );
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    for (const state of [parent, agents])
      nativeSessions.delete(state.piSessionFile!);
  }
});

test("lead agents stop refuses an agent whose identity changes after inventory", async () => {
  setLeadEnvironment();
  const agent = managedState(
    "pi-herdsman-identity-race",
    undefined,
    recoveryIdentity("pi-herdsman-identity-race"),
  );
  const mailbox = agentMailboxPath(WORKSPACE, agent.agentLabel);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, agent);
  const lifecycle = cascadeExecutor([agent]);
  let listCalls = 0;
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = lifecycle.exec(command, args, options);
      if (command === "herdr" && isAgentList(args) && ++listCalls === 3) {
        const value = JSON.parse(result.stdout);
        value.result.agents[0].agent_session = {
          kind: "id",
          value: "22222222-2222-4222-8222-222222222222",
        };
        return { ...result, stdout: JSON.stringify(value) };
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = () => undefined;
  try {
    await command.handler("stop", context);
    assert.equal(lifecycle.closeOrder.length, 0);
    assert.match(stopSummary(pi), /pi-herdsman-identity-race/);
    assert.match(stopSummary(pi), /not closed|No exact agent identity matched/);
    assert.ok(readAgentState(mailbox));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("lead agents stop reports cleanup failures and preserves accurate discarded-work summary", async () => {
  setLeadEnvironment();
  const failed = managedState(
    "stop-failed-agent",
    undefined,
    recoveryIdentity("stop-failed-agent"),
  );
  const pending = managedState(
    "stop-pending-agent",
    REQUEST_ID,
    recoveryIdentity("stop-pending-agent"),
  );
  pending.completedRequestId = randomUUID();
  const mailboxes = [failed, pending].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  mailboxes.forEach(resetAgentMailbox);
  writeAgentState(mailboxes[0]!, failed);
  writeAgentState(mailboxes[1]!, pending);
  writeResult(mailboxes[1]!, {
    version: 4,
    runId: pending.runId,
    requestId: pending.completedRequestId,
    ownerSessionId: pending.ownerSessionId,
    workspaceId: pending.workspaceId,
    agentLabel: pending.agentLabel,
    paneId: pending.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([failed, pending], {
    failCloseLabel: failed.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    const summary = stopSummary(pi);
    assert.match(summary, /Stopped 1 of 2 agents/);
    assert.match(summary, /✗ stop-failed-agent/);
    assert.match(summary, /Discarded:/);
    assert.match(summary, /stop-pending-agent: active assignment/);
    assert.match(summary, /stop-pending-agent: pending result/);
    assert.deepEqual(lifecycle.closeOrder, [pending.agentLabel]);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("lead agents stop continues independent leads after a partial cascade failure", async () => {
  setLeadEnvironment();
  const states = ["stop-partial-failure", "stop-independent"].map((label) =>
    managedState(label, undefined, recoveryIdentity(label)),
  );
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  states.forEach((state, index) => writeAgentState(mailboxes[index]!, state));
  const lifecycle = cascadeExecutor(states, {
    failCloseLabel: states[0]!.agentLabel,
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    assert.deepEqual(lifecycle.closeOrder, [states[1]!.agentLabel]);
    assert.match(stopSummary(pi), /Stopped 1 of 2 agents/);
    assert.match(stopSummary(pi), /✓ stop-independent/);
    assert.match(stopSummary(pi), /✗ stop-partial-failure/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("lead agents stop reports and closes a proven orphan subtree", async () => {
  setLeadEnvironment();
  const parent = managedState(
    "orphan-stop-parent",
    undefined,
    recoveryIdentity("orphan-stop-parent"),
  );
  parent.piSessionId = PARENT_SESSION_ID;
  const child = managedState(
    "orphan-stop-child",
    undefined,
    recoveryIdentity("orphan-stop-child"),
  );
  child.ownerSessionId = parent.piSessionId;
  child.piSessionId = CHILD_SESSION_ID;
  const mailboxes = [parent, child].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  writeAgentState(mailboxes[0]!, parent);
  writeAgentState(mailboxes[1]!, child);
  const lifecycle = cascadeExecutor([child], {
    omitAgentLabels: [parent.agentLabel],
  });
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    assert.deepEqual(lifecycle.closeOrder, [child.agentLabel]);
    assert.match(stopSummary(pi), /Stopped 1 agents/);
    assert.match(stopSummary(pi), /✓ orphan-stop-child/);
    assert.doesNotMatch(stopSummary(pi), /orphan-stop-parent/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("lead agents stop scopes its summary to the current lead subtree", async () => {
  setLeadEnvironment();
  const owned = managedState(
    "scoped-owned-agent",
    undefined,
    recoveryIdentity("scoped-owned-agent"),
  );
  const foreign = {
    ...managedState(
      "scoped-foreign-agent",
      undefined,
      recoveryIdentity("scoped-foreign-agent"),
    ),
    ownerSessionId: "foreign-lead-session",
  };
  const states = [owned, foreign];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  states.forEach((state, index) => writeAgentState(mailboxes[index]!, state));
  const lifecycle = cascadeExecutor(states);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  try {
    await command.handler("stop", { ...fakeContext(), hasUI: true } as any);
    assert.deepEqual(lifecycle.closeOrder, [owned.agentLabel]);
    assert.match(stopSummary(pi), /Stopped 1 agents/);
    assert.match(stopSummary(pi), /✓ scoped-owned-agent/);
    assert.doesNotMatch(stopSummary(pi), /scoped-foreign-agent/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("valid managed leaf agents receive identity-only TUI presentation", async () => {
  const mailbox = setAgentEnvironment("leaf-agent");
  let sessionRuntimeInitialized = false;
  let activeToolsCalls = 0;
  const state: ManagedAgentState = {
    ...managedState("leaf-agent"),
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const pi = fakePi({
    activeTools: () => {
      activeToolsCalls++;
      assert.equal(sessionRuntimeInitialized, true);
      return ["read", "bash", "ask_owner"];
    },
    exec: (command, args) =>
      command === "herdr" && isAgentList(args)
        ? {
            stdout: JSON.stringify({
              result: {
                agents: [
                  agentFromState(state),
                  {
                    agent: "pi",
                    workspace_id: WORKSPACE,
                    pane_id: "lead-pane",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: LEAD_SESSION_ID,
                    },
                  },
                ],
              },
            }),
            stderr: "",
            code: 0,
          }
        : command === "herdr" && isPaneList(args)
          ? {
              stdout: JSON.stringify({
                result: {
                  panes: [
                    {
                      pane_id: "lead-pane",
                      workspace_id: WORKSPACE,
                      agent: NON_PI_AGENT,
                    },
                  ],
                },
              }),
              stderr: "",
              code: 0,
            }
          : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeAgentContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    select: async () => "tab",
  };
  registerExtension!(pi.pi as never);
  assert.equal(activeToolsCalls, 0);
  sessionRuntimeInitialized = true;
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.deepEqual(widget!.render(160), [
    "● ? → agent:leaf-agent  [read, bash, ask_owner]",
  ]);
  assert.equal(pi.tools.filter((tool) => tool.name === "ask_owner").length, 1);
  assert.ok(activeToolsCalls > 0);
  await pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("TUI status widget is registered as a Pi component factory", async (t) => {
  setLeadEnvironment();
  let factory: unknown;
  let renderRequests = 0;
  const pi = fakePi();
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      factory = content;
    },
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);

  assert.equal(typeof factory, "function");
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = (factory as (tui: unknown, theme: unknown) => unknown)(
    { requestRender: () => renderRequests++ },
    theme,
  );
  assert.ok(component instanceof StatusWidget);
  (component as StatusWidget).setSnapshot({
    agents: [{ label: "agent", definition: "agent", state: "working" }],
    stale: false,
    unavailable: false,
  });
  assert.equal(renderRequests, 1);
  assert.notEqual(factory, component);
  const leadSignal = pi.execOptions.find((options) => options.signal)?.signal;
  assert.ok(leadSignal);
  (component as StatusWidget).dispose();
  await pi.events.get("session_shutdown")?.[0]();
  assert.equal(leadSignal.aborted, true);
});

test("repeated lead starts replace the widget and ignore old refreshes", async (t) => {
  setLeadEnvironment();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<ReturnType<typeof setInterval>>();
  const pendingLists: {
    resolve: (value: { stdout: string; stderr: string; code: number }) => void;
  }[] = [];
  const widgets: StatusWidget[] = [];
  const factories: ((tui: any, theme: any) => StatusWidget)[] = [];
  const originalDispose = StatusWidget.prototype.dispose;
  let disposeCalls = 0;
  let registrations = 0;
  StatusWidget.prototype.dispose = function () {
    disposeCalls++;
    originalDispose.call(this);
  };
  globalThis.setInterval = ((callback: TimerHandler) => {
    const timer = originalSetInterval(callback, 60_000);
    activeTimers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer) => {
    activeTimers.delete(timer);
    originalClearInterval(timer);
  }) as typeof clearInterval;
  try {
    const pi = fakePi({
      exec: (command, args) => {
        if (command === "herdr" && args[0] === "agent" && args[1] === "list")
          return new Promise((resolve) =>
            pendingLists.push({ resolve }),
          ) as any;
        if (command === "herdr" && isPaneList(args))
          return {
            stdout: JSON.stringify({
              result: {
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    agent: "agent",
                    agent_status: "idle",
                  },
                ],
              },
            }),
            stderr: "",
            code: 0,
          };
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    const makeContext = () => {
      const context = fakeContext() as any;
      context.mode = "tui";
      context.hasUI = true;
      context.ui = {
        setWidget: (_key: string, content: unknown) => {
          registrations++;
          if (typeof content === "function")
            (factories.push(content as (tui: any, theme: any) => StatusWidget),
              widgets.push(
                (content as (tui: any, theme: any) => StatusWidget)(
                  { requestRender: () => undefined },
                  {
                    fg: (_color: string, text: string) => text,
                    bold: (text: string) => text,
                  },
                ),
              ));
        },
      };
      return context;
    };
    registerExtension!(pi.pi as never);
    t.after(async () => {
      await pi.events.get("session_shutdown")?.[0]();
    });
    const start = pi.events.get("session_start")![0];
    const firstStart = start(undefined, makeContext());
    await Promise.resolve();
    const secondStart = start(undefined, makeContext());
    await Promise.resolve();

    assert.equal(widgets.length, 2);
    assert.equal(
      registrations,
      3,
      "two registrations and one old-widget removal",
    );
    assert.equal(disposeCalls, 1, "the old widget is disposed on replacement");
    const staleWidget = factories[0](
      { requestRender: () => undefined },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    );
    assert.ok(staleWidget);
    assert.equal(
      disposeCalls,
      2,
      "a stale factory widget is disposed immediately",
    );
    assert.equal(activeTimers.size, 1);
    for (const pending of pendingLists.splice(0, 2))
      pending.resolve({
        stdout: listResponse("old-agent"),
        stderr: "",
        code: 0,
      });
    await Promise.resolve();
    await Promise.resolve();
    assert.match(widgets[1].render(120)[0], /unavailable/);
    for (const pending of pendingLists.splice(0))
      pending.resolve({
        stdout: listResponse("new-agent"),
        stderr: "",
        code: 0,
      });
    await Promise.all([firstStart, secondStart]);
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.doesNotMatch(widgets[1].render(120)[0], /unavailable/);
    await pi.events.get("session_shutdown")?.[0]();
    assert.equal(activeTimers.size, 0);
    assert.equal(disposeCalls, 3, "the current widget is disposed on shutdown");
    assert.equal(widgets[0].render(120)[0], "● herd  unavailable");
  } finally {
    StatusWidget.prototype.dispose = originalDispose;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("TUI status refresh consumes the supported Herdr agent list envelope", async (t) => {
  setLeadEnvironment();
  const label = "sleep-smoke-a";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const calls: string[][] = [];
  const definitionReadsBeforeStatus = support.agentDefinitionReadCount;
  let refreshTimer: TimerHandler | undefined;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler) => {
    refreshTimer = callback;
    return {} as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const herdrAgent = {
    agent: "pi",
    name: herdrAlias("sleep-smoke-a"),
    agent_session: {
      kind: "path",
      value: identity.piSessionFile,
    },
    agent_status: "working",
    cwd: "/tmp",
    pane_id: identity.paneId,
    tab_id: identity.tabId,
    workspace_id: WORKSPACE,
    display_agent: "agent",
    tokens: {
      task: "live task",
      started: "123",
      model: "live-model",
      thinking: "high",
      ctx: "42",
    },
  };
  const pi = fakePi({
    activeTools: ["read", "bash", "ask_owner"],
    exec: (command, args) => {
      calls.push(args);
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                herdrAgent,
                {
                  agent: "pi",
                  workspace_id: WORKSPACE,
                  pane_id: "unmanaged-lead-pane",
                  cwd: "/tmp",
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: LEAD_SESSION_ID,
                  },
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                {
                  pane_id: identity.paneId,
                  workspace_id: WORKSPACE,
                  agent: label,
                  agent_status: "working",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                name: herdrAlias("sleep-smoke-a"),
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent_session: {
                  kind: "path",
                  value: identity.piSessionFile,
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = (content as any)(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  (refreshTimer as () => void)();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.setInterval = originalSetInterval;

  assert.ok(widget);
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "agent" && args[1] === "list" && !args.includes("--json"),
    ),
  );
  assert.ok(
    pi.execOptions.some((options) => options.timeout === 30_000),
    "direct Herdr status polling must have a finite timeout",
  );
  const rendered = widget.render(160).join("\n");
  assert.match(rendered, /1 working/);
  assert.match(rendered, /sleep-smoke-a/);
  assert.doesNotMatch(rendered, /\[read, bash, ask_owner\]/);
  assert.ok(
    support.agentDefinitionReadCount > definitionReadsBeforeStatus,
    "session-start roster should discover agent definitions once",
  );
  const listed = await pi.tools[0].execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
  assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
  assert.ok(
    support.agentDefinitionReadCount > definitionReadsBeforeStatus,
    "agent list should continue to discover agent definitions",
  );
  await pi.events.get("session_shutdown")?.[0]();
});

test("zero-runtime reconciliation requests one status refresh", async (t) => {
  setLeadEnvironment();
  const label = "fresh-widget-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, undefined, identity));

  const herdrAgent = {
    agent: "pi",
    name: herdrAlias(label),
    agent_session: {
      agent: "pi",
      kind: "path",
      source: "herdr:pi",
      value: identity.piSessionFile,
    },
    agent_status: "working",
    cwd: "/tmp",
    pane_id: identity.paneId,
    workspace_id: WORKSPACE,
    display_agent: "agent",
    tokens: { task: "fresh task" },
  };
  const envelope = () =>
    JSON.stringify({ id: 1, result: { agents: [herdrAgent] } });
  let listCount = 0;
  let resolveInitial: ((value: ExecResult) => void) | undefined;
  let resolveReconciliation: ((value: ExecResult) => void) | undefined;
  let resolveAfterRegistration: ((value: ExecResult) => void) | undefined;
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isAgentList(args)) {
        listCount++;
        if (listCount === 1)
          return new Promise<ExecResult>((resolve) => {
            resolveInitial = resolve;
          });
        if (listCount === 2)
          return new Promise<ExecResult>((resolve) => {
            resolveReconciliation = resolve;
          });
        return new Promise<ExecResult>((resolve) => {
          resolveAfterRegistration = resolve;
        });
      }
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({ result: { agent: herdrAgent } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };

  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  const starting = pi.events.get("session_start")![0](undefined, context);
  await Promise.resolve();
  resolveInitial!({ stdout: envelope(), stderr: "", code: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.match(widget.render(160).join("\n"), /1 unknown/);

  resolveReconciliation!({
    stdout: JSON.stringify({ id: 1, result: { agents: [] } }),
    stderr: "",
    code: 0,
  });
  for (let attempt = 0; attempt < 20 && listCount < 3; attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(listCount >= 3, JSON.stringify(pi.calls));
  resolveAfterRegistration!({ stdout: envelope(), stderr: "", code: 0 });
  await starting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rendered = widget.render(160).join("\n");
  assert.match(rendered, /1 unknown/);
  assert.match(rendered, /fresh-widget-agent/);
  await pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("fresh assignment refreshes the widget after validation", async () => {
  setLeadEnvironment();
  const label = "fresh-start-widget-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const agentsDir = PI_AGENTS_DIR;
  const definitionPath = `${agentsDir}/agent.md`;
  const hadAgentsDir = realFs.existsSync(agentsDir);
  const hadDefinition = realFs.existsSync(definitionPath);
  const previousDefinition = hadDefinition
    ? realFs.readFileSync(definitionPath, "utf8")
    : undefined;
  realFs.mkdirSync(agentsDir, { recursive: true });
  realFs.writeFileSync(
    definitionPath,
    "---\nname: agent\ninheritProjectContext: true\ninheritGlobalContext: false\n---\nagent instructions\n",
  );
  projectContextCwds.length = 0;
  const requestedCwd = PI_AGENT_ROOT;
  resetAgentMailbox(mailbox);
  let live = false;
  let listCount = 0;
  let resolveInitialStatus: ((value: ExecResult) => void) | undefined;
  let resolveIntegration: ((value: ExecResult) => void) | undefined;
  let releaseInitialPrompt: (() => void) | undefined;
  let holdInitialPrompt = true;
  let integrationGetCount = 0;
  let failSubmit = false;
  let failValidation = false;
  const herdrAgent = {
    agent: "pi",
    name: herdrAlias(label),
    agent_session: {
      agent: "pi",
      kind: "path",
      source: "herdr:pi",
      value: "/tmp/registered-agent.jsonl",
    },
    agent_status: "working",
    cwd: requestedCwd,
    pane_id: "startup-pane",
    workspace_id: WORKSPACE,
    display_agent: "agent",
    tokens: { task: "fresh task" },
  };
  const emptyList = () => JSON.stringify({ id: 1, result: { agents: [] } });
  const liveList = () =>
    JSON.stringify({ id: 1, result: { agents: [herdrAgent] } });
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const processInfo = {
    pane_id: "startup-pane",
    shell_pid: 123,
    foreground_process_group_id: 123,
    foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
  };
  let startedRunId = AGENT_ID;
  let startedOwnerSessionId = LEAD_SESSION_ID;
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && isAgentList(args)) {
        listCount++;
        if (listCount === 1)
          return new Promise<ExecResult>((resolve) => {
            resolveInitialStatus = resolve;
          });
        return {
          stdout: live ? liveList() : emptyList(),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [
                {
                  tab_id: "startup-tab",
                  label: "agents",
                  workspace_id: WORKSPACE,
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
        const value = (key: string) =>
          args
            .slice(0, -1)
            .find((arg) => arg.startsWith(`${key}=`))
            ?.slice(key.length + 1);
        startedRunId = value("PI_HERDSMAN_RUN_ID") ?? startedRunId;
        startedOwnerSessionId =
          value("PI_HERDSMAN_OWNER_SESSION_ID") ?? startedOwnerSessionId;
        herdrAgent.name = runScopedHerdrAlias(WORKSPACE, label, startedRunId);
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "startup-tab" },
              root_pane: { pane_id: "startup-pane" },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                {
                  pane_id: "startup-pane",
                  tab_id: "startup-tab",
                  workspace_id: WORKSPACE,
                  cwd: requestedCwd,
                  foreground_cwd: requestedCwd,
                  agent_status: "unknown",
                },
              ],
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
          stdout: JSON.stringify({ result: { process: processInfo } }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        const value = (key: string) =>
          args
            .slice(0, -1)
            .find((arg) => arg.startsWith(`${key}=`))
            ?.slice(key.length + 1);
        startedRunId = value("PI_HERDSMAN_RUN_ID") ?? startedRunId;
        startedOwnerSessionId =
          value("PI_HERDSMAN_OWNER_SESSION_ID") ?? startedOwnerSessionId;
        herdrAgent.name = runScopedHerdrAlias(WORKSPACE, label, startedRunId);
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "startup-pane" } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (
        command === "herdr" &&
        args[0] === "pane" &&
        (args[1] === "run" || args[1] === "wait-output")
      ) {
        if (args[1] === "run") {
          const value = (key: string) =>
            new RegExp(`${key}='([^']*)'`).exec(args.at(-1) ?? "")?.[1];
          startedRunId = value("PI_HERDSMAN_RUN_ID") ?? startedRunId;
          startedOwnerSessionId =
            value("PI_HERDSMAN_OWNER_SESSION_ID") ?? startedOwnerSessionId;
          herdrAgent.name = runScopedHerdrAlias(WORKSPACE, label, startedRunId);
        }
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        integrationGetCount++;
        if (failValidation) {
          live = false;
          return {
            stdout: JSON.stringify({
              result: {
                agent: {
                  ...herdrAgent,
                  agent_session: {
                    ...herdrAgent.agent_session,
                    value: "/tmp/validation-mismatch.jsonl",
                  },
                },
              },
            }),
            stderr: "",
            code: 0,
          };
        }
        const response = {
          stdout: JSON.stringify({ result: { agent: herdrAgent } }),
          stderr: "",
          code: 0,
        };
        if (integrationGetCount === 1)
          return new Promise<ExecResult>((resolve) => {
            resolveIntegration = () => resolve(response);
          });
        return response;
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt")
        if (holdInitialPrompt) {
          holdInitialPrompt = false;
          return new Promise<ExecResult>((resolve) => {
            releaseInitialPrompt = () => {
              Promise.resolve(startup.exec(command, args, options)).then(
                resolve,
              );
            };
          });
        } else if (failSubmit) {
          live = false;
          return { stdout: "{}", stderr: "submit failed", code: 1 };
        }
      if (
        command === "herdr" &&
        args[0] === "agent" &&
        args[1] === "send-keys"
      ) {
        live = false;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: "startup-pane",
                tab_id: "startup-tab",
                workspace_id: WORKSPACE,
                cwd: requestedCwd,
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        live = true;
        writeAgentState(mailbox, {
          version: 4,
          runId: startedRunId,
          ownerSessionId: startedOwnerSessionId,
          workspaceId: WORKSPACE,
          agentLabel: label,
          paneId: "startup-pane",
          piSessionId: DEFAULT_PI_SESSION_ID,
          piSessionFile: "/tmp/registered-agent.jsonl",
          cwd: requestedCwd,
          updatedAt: Date.now(),
        });
        return {
          stdout: JSON.stringify({
            tab_id: "startup-tab",
            tab_label: "agents",
            pane_id: "startup-pane",
            cwd: requestedCwd,
            herdr_agent: herdrAlias(label),
            created_tab: false,
            created_pane: false,
            agent: herdrAgent,
          }),
          stderr: "",
          code: 0,
        };
      }
      return startup.exec(command, args, options);
    },
  });
  const context = fakeContext() as any;
  context.cwd = "/tmp/lead-cwd";
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };
  try {
    registerExtension!(pi.pi as never);
    await pi.events.get("session_start")![0](undefined, context);
    const starting = pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "fresh task",
        cwd: requestedCwd,
      },
      undefined,
      undefined,
      context,
    );
    await waitForTestCondition(
      () => resolveInitialStatus !== undefined,
      "assignment did not request initial status",
    );
    resolveInitialStatus!({ stdout: liveList(), stderr: "", code: 0 });
    await waitForTestCondition(
      () => resolveIntegration !== undefined,
      "assignment did not reach integration validation",
    );
    assert.match(widget!.render(160).join("\n"), /herd/);
    resolveIntegration!({ stdout: "{}", stderr: "", code: 0 });
    await waitForTestCondition(
      () => releaseInitialPrompt !== undefined,
      "assignment did not reach initial prompt",
    );
    const pendingList = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(pendingList.details.agents[0].state, "settling");
    releaseInitialPrompt!();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.deepEqual(
      {
        discoveryCwds: projectContextCwds,
        splitForMismatchedCwd: pi.calls.some(
          (args) => args[0] === "pane" && args[1] === "split",
        ),
      },
      { discoveryCwds: [requestedCwd], splitForMismatchedCwd: false },
    );
    context.cwd = requestedCwd;
    const getIndexes = pi.calls.flatMap((args, index) =>
      args[0] === "agent" && args[1] === "get" ? [index] : [],
    );
    const firstStatusAfterValidation = pi.calls.findIndex(
      (args, index) =>
        index > getIndexes[0] &&
        index < getIndexes[1] &&
        args[0] === "agent" &&
        args[1] === "list",
    );
    assert.ok(
      firstStatusAfterValidation >= 0,
      "fresh runtime refresh must occur after validation and before submit validation",
    );
    await waitForTestCondition(
      () => widget!.render(160).join("\n").includes("1 working"),
      "widget did not refresh to working after validation",
    );
    const rendered = widget!.render(160).join("\n");
    assert.match(rendered, /1 working/);
    assert.match(rendered, /fresh-start-widget-agent/);

    failSubmit = true;
    live = false;
    resetAgentMailbox(mailbox);
    const failed = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "fail this task",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(failed.details.ok, false, JSON.stringify(failed.details));
    assert.equal(pi.sentMessageCalls.length, 1);
    await waitForTestCondition(
      () => widget!.render(160).join("\n").includes("herd"),
      "widget did not refresh after failed submission",
    );
    assert.match(widget!.render(160).join("\n"), /herd/);

    failSubmit = false;
    failValidation = true;
    live = false;
    resetAgentMailbox(mailbox);
    const invalid = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "invalid identity",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(invalid.details.ok, false);
    await waitForTestCondition(
      () => widget!.render(160).join("\n").includes("herd"),
      "widget did not refresh after failed validation",
    );
    assert.match(widget!.render(160).join("\n"), /herd/);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    if (hadDefinition)
      realFs.writeFileSync(definitionPath, previousDefinition!);
    else if (!hadAgentsDir) {
      realFs.unlinkSync(definitionPath);
      realFs.rmdirSync(agentsDir);
    } else realFs.unlinkSync(definitionPath);
  }
});
