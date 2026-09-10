import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { OperationError } from "./errors.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
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
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  discoverAgent,
  fakeContext,
  fakePi,
  fakeAgentContext,
  herdrAlias,
  isAgentList,
  isPaneList,
  managedState,
  nativeSessions,
  agentControllerExecutor,
  promptLaunchContents,
  promptLaunchPaths,
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
  resolveAssignmentSession,
  resolveManagedSession,
  leadExec,
  setLeadEnvironment,
  setAgentEnvironment,
  startupExecutor,
  agentMailboxPath,
  writeAsk,
  writePromptDefinition,
  writeRequest,
  writeResult,
  writeAgentState,
} from "./support.ts";

test("project agent discovery is gated by trusted project settings", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-gate-"),
  );
  let pi: ReturnType<typeof fakePi> | undefined;
  try {
    const agents = join(project, ".pi", "agents");
    realFs.mkdirSync(agents, { recursive: true });
    realFs.writeFileSync(
      join(agents, "project-only.md"),
      "---\nname: project-only\n---\nproject policy",
    );
    pi = fakePi();
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.cwd = project;
    context.hasUI = true;
    const selections: string[][] = [];
    context.ui.select = async (_title: string, options: string[]) => {
      selections.push(options);
      return undefined;
    };
    realFs.writeFileSync(
      join(PI_AGENT_ROOT, "settings.json"),
      JSON.stringify({ piHerd: { projectAgents: true } }),
    );
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      false,
    );
    realFs.writeFileSync(
      join(PI_AGENT_ROOT, "settings.json"),
      JSON.stringify({ piHerdsman: { projectAgents: true } }),
    );
    await command.handler("definitions", context);
    assert.equal(
      selections.flat().some((value) => value.includes("project-only")),
      false,
    );
    realFs.mkdirSync(join(project, ".pi"), { recursive: true });
    realFs.writeFileSync(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ piHerdsman: { projectAgents: true } }),
    );
    await command.handler("definitions", context);
    assert.equal(
      selections.flat().some((value) => value.includes("project-only")),
      true,
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "project-only.md"),
      "---\nname: project-only\nmodel: global/model\n---\nglobal policy",
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "standalone-global.md"),
      "---\nname: standalone-global\n---\nglobal",
    );
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, "scout.md"),
      "---\nname: scout\nmodel: global/model\n---\nglobal",
    );
    await command.handler("definitions", context);
    const options = selections.at(-1) ?? [];
    assert.ok(
      options.some((value) => value.startsWith("project-only [project] *")),
    );
    assert.ok(options.some((value) => value.startsWith("scout *")));
    assert.ok(options.some((value) => value.startsWith("standalone-global")));
    assert.equal(
      options.some((value) => value.startsWith("standalone-global *")),
      false,
    );
    realFs.rmSync(join(PI_AGENTS_DIR, "project-only.md"), { force: true });
    realFs.writeFileSync(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ piHerdsman: { projectAgents: false } }),
    );
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      false,
    );
    context.isProjectTrusted = () => false;
    realFs.writeFileSync(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ piHerdsman: { projectAgents: true } }),
    );
    await command.handler("definitions", context);
    assert.equal(
      selections.at(-1)?.some((value) => value.includes("project-only")),
      false,
    );
  } finally {
    pi?.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
    realFs.rmSync(join(PI_AGENT_ROOT, "settings.json"), { force: true });
    for (const name of ["project-only.md", "standalone-global.md", "scout.md"])
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
    setLeadEnvironment();
  }
});

test("managed agent validates project definitions before publishing state", async () => {
  const mailbox = setAgentEnvironment("project-validation-agent");
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-agent-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ piHerdsman: { projectAgents: true } }),
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "broken.md"),
    '---\nname: broken-parent\nagents: ["missing-child"]\n---\nbroken',
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "project-parent" },
    },
  ]) as any;
  context.cwd = project;
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(project, { recursive: true, force: true });
  }
});

test("project agents reject cross-cwd assignment before agent startup", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-assign-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ piHerdsman: { projectAgents: true } }),
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-only.md"),
    "---\nname: project-only\n---\nproject",
  );
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && args[0] === "--version"
        ? { stdout: "0.8.0", stderr: "", code: 0 }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = project;
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "project-only",
        cwd: "/other",
        task: "no",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /belongs to/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
  }
});

test("trusted same-cwd project assignment launches with native approval", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-assign-same-cwd-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ piHerdsman: { projectAgents: true } }),
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-only.md"),
    "---\nname: project-only\n---\nproject",
  );
  const startArgs: string[][] = [];
  const startup = startupExecutor(
    "project-only",
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    (args) => startArgs.push(args),
    project,
    AGENT_ID,
    true,
  );
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = project;
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", definition: "project-only", task: "same cwd" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      result.details.ok,
      true,
      JSON.stringify({ result: result.details, entries: pi.entries }),
    );
    assert.ok(startArgs[0]?.includes("--approve"));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(project, { recursive: true, force: true });
  }
  await (async () => {
    setLeadEnvironment();
    const project = realFs.mkdtempSync(
      join(tmpdir(), "pi-herdsman-assign-symlink-cwd-"),
    );
    const projectLink = `${project}-link`;
    realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    realFs.writeFileSync(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ piHerdsman: { projectAgents: true } }),
    );
    realFs.writeFileSync(
      join(project, ".pi", "agents", "project-only.md"),
      "---\nname: project-only\n---\nproject",
    );
    realFs.symlinkSync(project, projectLink);
    const startArgs: string[][] = [];
    const startup = startupExecutor(
      "project-only",
      () => DEFAULT_PI_SESSION_ID,
      undefined,
      undefined,
      false,
      (args) => startArgs.push(args),
      project,
      AGENT_ID,
      true,
    );
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    const context = fakeContext() as any;
    context.cwd = projectLink;
    try {
      const result = await pi.tools[0].execute(
        "id",
        { action: "delegate", definition: "project-only", task: "symlink cwd" },
        undefined,
        undefined,
        context,
      );
      assert.equal(
        result.details.ok,
        true,
        JSON.stringify({ result: result.details, entries: pi.entries }),
      );
      assert.ok(startArgs[0]?.includes("--approve"));
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
      realFs.rmSync(projectLink, { force: true });
      realFs.rmSync(project, { recursive: true, force: true });
    }
  })();
});

test("inactive and cross-cwd non-project assignments omit feature approval", async () => {
  for (const scenario of [
    { name: "inactive", projectAgents: false, cwd: undefined },
    { name: "cross-cwd", projectAgents: true, cwd: "/other" },
  ]) {
    setLeadEnvironment();
    const project = realFs.mkdtempSync(
      join(tmpdir(), `pi-herdsman-approval-${scenario.name}-`),
    );
    realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    realFs.writeFileSync(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ piHerdsman: { projectAgents: scenario.projectAgents } }),
    );
    const startArgs: string[][] = [];
    const startup = startupExecutor(
      "agent",
      () => DEFAULT_PI_SESSION_ID,
      undefined,
      undefined,
      false,
      (args) => startArgs.push(args),
      scenario.cwd ?? project,
      AGENT_ID,
    );
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    const context = fakeContext() as any;
    context.cwd = project;
    try {
      const result = await pi.tools[0].execute(
        "id",
        {
          action: "delegate",
          definition: "agent",
          cwd: scenario.cwd,
          task: scenario.name,
        },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(startArgs[0]?.includes("--approve"), false);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
      realFs.rmSync(project, { recursive: true, force: true });
    }
  }
});

test("project-only Definitions edits create a global override", async () => {
  setLeadEnvironment();
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-edit-"),
  );
  const projectPath = join(project, ".pi", "agents", "project-only.md");
  const original = "---\nname: project-only\n---\nproject policy\n";
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ piHerdsman: { projectAgents: true } }),
  );
  realFs.writeFileSync(projectPath, original);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.cwd = project;
  context.hasUI = true;
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "provider", id: "edited-model" }],
    getAvailable: () => [{ provider: "provider", id: "edited-model" }],
  };
  let selection = 0;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("project-only"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return "edited-model";
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    const globalPath = join(PI_AGENTS_DIR, "project-only.md");
    assert.equal(realFs.readFileSync(projectPath, "utf8"), original);
    assert.match(
      realFs.readFileSync(globalPath, "utf8"),
      /^model: provider\/edited-model$/m,
    );
    const effective = discoverAgent("project-only", { projectRoot: project });
    assert.equal(effective.frontmatter.model, "provider/edited-model");
    assert.equal(effective.projectSource, projectPath);
    assert.equal(effective.overrideSource, globalPath);
    realFs.rmSync(globalPath, { force: true });
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(project, { recursive: true, force: true });
    realFs.rmSync(join(PI_AGENTS_DIR, "project-only.md"), { force: true });
  }
});

test("same-cwd managed parents resolve project children", async () => {
  setAgentEnvironment("project-parent", ["project-child"]);
  const project = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-parent-project-"),
  );
  realFs.mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  realFs.writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ piHerdsman: { projectAgents: true } }),
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-parent.md"),
    '---\nname: project-parent\nagents: ["project-child"]\n---\nparent',
  );
  realFs.writeFileSync(
    join(project, ".pi", "agents", "project-child.md"),
    "---\nname: project-child\n---\nchild",
  );
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "project-parent";
  const parent = { ...managedState("project-parent"), cwd: project };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const lifecycle = delegatedLifecycleExecutor(parent, [], project);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "project-parent" },
    },
  ]) as any;
  context.cwd = project;
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const started = await pi.tools[0].execute(
      "start",
      {
        action: "delegate",
        definition: "project-child",
        label: "project-child",
        task: "delegate project child work",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(started.details.ok, true, JSON.stringify(started.details));
    const childState = readAgentState(
      agentMailboxPath(WORKSPACE, "project-child"),
    );
    assert.equal(childState?.ownerSessionId, parent.piSessionId);
    assert.equal(childState?.cwd, project);
    const child = discoverAgent("project-child", { projectRoot: project });
    assert.equal(
      child.projectSource,
      join(project, ".pi", "agents", "project-child.md"),
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(agentMailboxPath(WORKSPACE, "project-child"));
    realFs.rmSync(project, { recursive: true, force: true });
    setLeadEnvironment();
  }
});

test("parent controller readiness, allowlist, and cwd preflight fail closed", async () => {
  setAgentEnvironment("delegating-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("delegating-parent");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
    ["other.md", "---\nname: other\n---\nother\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ]);
  const pi = fakePi({ exec: agentControllerExecutor(parent) });
  registerExtension!(pi.pi as never);
  const tool = pi.tools[0];
  try {
    const beforeInit = await tool.execute(
      "id",
      { action: "delegate", definition: "child", task: "before init" },
      undefined,
      undefined,
      context,
    );
    assert.equal(beforeInit.details.error.category, "target_not_found");
    assert.equal(pi.calls.length, 0);

    const listBeforeInit = await tool.execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(listBeforeInit.details.error.category, "target_not_found");
    assert.equal(pi.calls.length, 0);

    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const unauthorized = await tool.execute(
      "id",
      { action: "delegate", definition: "other", task: "not allowed" },
      undefined,
      undefined,
      context,
    );
    assert.equal(unauthorized.details.error.category, "invalid_request");
    assert.equal(unauthorized.details.error.message, "Invalid agent input");
    const beforeLifecycle = pi.calls.length;
    const cwdMismatch = await tool.execute(
      "id",
      {
        action: "delegate",
        definition: "child",
        cwd: "/other",
        task: "wrong cwd",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(cwdMismatch.details.error.category, "invalid_request");
    assert.match(cwdMismatch.details.error.message, /delegating agent cwd/);
    assert.equal(
      pi.calls
        .slice(beforeLifecycle)
        .some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(parentMailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }

  setAgentEnvironment("conflicting-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const conflict = managedState("conflicting-parent");
  const conflictMailbox = agentMailboxPath(WORKSPACE, conflict.agentLabel);
  resetAgentMailbox(conflictMailbox);
  writeAgentState(conflictMailbox, {
    ...conflict,
    runId: "11111111-1111-4111-8111-111111111111",
  });
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const failing = fakePi({ exec: agentControllerExecutor(conflict) });
  registerExtension!(failing.pi as never);
  const failingContext = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ]);
  try {
    for (const handler of failing.events.get("session_start") ?? [])
      await handler(undefined, failingContext);
    const rejected = await failing.tools[0].execute(
      "id",
      { action: "delegate", definition: "child", task: "conflicting state" },
      undefined,
      undefined,
      failingContext,
    );
    assert.equal(rejected.details.error.category, "target_not_found");
    assert.equal(
      failing.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    for (const handler of failing.events.get("session_shutdown") ?? [])
      handler();
    resetAgentMailbox(conflictMailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("parent list hides disabled allowed definitions", async () => {
  setAgentEnvironment("listing-parent", ["enabled-child", "disabled-child"]);
  const files = [
    ["enabled-child.md", "---\nname: enabled-child\n---\nchild\n"],
    [
      "disabled-child.md",
      "---\nname: disabled-child\nenabled: false\n---\nchild\n",
    ],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const pi = fakePi({
    exec: agentControllerExecutor(managedState("listing-parent")),
  });
  registerExtension!(pi.pi as never);
  const entries = pi.entries;
  const context = fakeAgentContext(entries);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const listed = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(
      (listed.details.agent_definitions as { name: string }[]).map(
        ({ name }) => name,
      ),
      ["enabled-child"],
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const [name] of files)
      realFs.rmSync(join(PI_AGENTS_DIR, name), { force: true });
  }
});

test("parent list omits unrelated unknown mailbox diagnostics", async () => {
  setAgentEnvironment("recovery-parent-no-self-get", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("recovery-parent-no-self-get");
  const child = {
    ...managedState(
      "recovered-child",
      undefined,
      recoveryIdentity("recovered-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/recovered-child.jsonl",
  };
  const mailboxes = [parent, child].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  const unknownMailbox = agentMailboxPath(
    "unrelated-workspace",
    "unrelated-agent",
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  writeAgentState(mailboxes[0], parent);
  writeAgentState(mailboxes[1], child);
  realFs.mkdirSync(unknownMailbox, { recursive: true });
  realFs.writeFileSync(join(unknownMailbox, "state.json"), "{malformed");
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const getTargets: string[] = [];
  const base = agentControllerExecutor(parent, [child]);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = base(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        getTargets.push(args[2]!);
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ]);

  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    assert.deepEqual(getTargets, [child.paneId]);
    const listed = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      (listed.details.agents as { agent?: string }[])
        .map((agent) => agent.agent)
        .filter((agent): agent is string => agent !== undefined),
      [child.agentLabel],
    );
    assert.equal(
      (listed.details.agents as { state?: string }[]).some(
        (agent) => agent.state === "unknown",
      ),
      false,
    );
    assert.doesNotMatch(
      (listed.content[0] as { text: string }).text,
      /diagnostic:/,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    realFs.rmSync(unknownMailbox, { recursive: true, force: true });
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("foreign-workspace mailbox is ignored by recovery and list", async () => {
  setLeadEnvironment();
  const label = "cross-workspace-agent";
  const identity = recoveryIdentity(label);
  const current = managedState(label, undefined, identity);
  const foreign: ManagedAgentState = {
    ...current,
    workspaceId: "foreign-workspace",
    paneId: "foreign-pane",
    piSessionFile: "/tmp/foreign-workspace-agent.jsonl",
  };
  const currentMailbox = agentMailboxPath(WORKSPACE, label);
  const foreignMailbox = agentMailboxPath(foreign.workspaceId, label);
  resetAgentMailbox(currentMailbox);
  resetAgentMailbox(foreignMailbox);
  writeAgentState(currentMailbox, current);
  writeAgentState(foreignMailbox, foreign);
  const entries: unknown[] = [];
  const lifecycle = cascadeExecutor([current]);
  const pi = fakePi({ entries, exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);

  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    const listed = await pi.tools[0].execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
    assert.deepEqual(
      (listed.details.agents as { agent?: string }[])
        .map((agent) => agent.agent)
        .filter((agent): agent is string => agent !== undefined),
      [label],
    );
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_recovery_error",
      ),
      false,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    resetAgentMailbox(currentMailbox);
    resetAgentMailbox(foreignMailbox);
  }
});

test("parent controls only direct children and enforces session allowlists", async () => {
  setAgentEnvironment("ownership-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("ownership-parent");
  const child = {
    ...managedState(
      "ownership-child",
      undefined,
      recoveryIdentity("ownership-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/ownership-child.jsonl",
  };
  const activeRequestId = randomUUID();
  const workingChild = {
    ...managedState(
      "ownership-working-child",
      activeRequestId,
      recoveryIdentity("ownership-working-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/ownership-working-child.jsonl",
  };
  const sibling = {
    ...managedState(
      "ownership-sibling",
      undefined,
      recoveryIdentity("ownership-sibling"),
    ),
    ownerSessionId: LEAD_SESSION_ID,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/ownership-sibling.jsonl",
  };
  const mailboxes = [parent, child, workingChild, sibling].map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  writeAgentState(mailboxes[0], parent);
  writeAgentState(mailboxes[1], child);
  writeAgentState(mailboxes[2], workingChild);
  writeAgentState(mailboxes[3], sibling);
  const files = [
    ["parent.md", '---\nname: parent\nagents: ["child"]\n---\nparent\n'],
    ["child.md", "---\nname: child\n---\nchild\n"],
    ["other.md", "---\nname: other\n---\nother\n"],
  ];
  for (const [name, content] of files)
    realFs.writeFileSync(join(PI_AGENTS_DIR, name), content, "utf8");
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: { name: "parent" },
    },
  ];
  const pi = fakePi({
    exec: agentControllerExecutor(parent, [child, workingChild, sibling]),
  });
  registerExtension!(pi.pi as never);
  const context = fakeAgentContext(entries);
  const resumePath = "/tmp/ownership-resume.jsonl";
  nativeSessions.set("ownership-resume", {
    id: "33333333-3333-4333-8333-333333333333",
    path: resumePath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "other" },
      },
    ],
  });
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const listed = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(
      (listed.details.agents as { agent: string }[])
        .map((agent) => agent.agent)
        .sort(),
      [child.agentLabel, workingChild.agentLabel],
    );

    const steered = await pi.tools[0].execute(
      "steer",
      {
        action: "steer",
        agent: workingChild.agentLabel,
        message: "steer direct child",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(steered.details.ok, true);
    const siblingResult = await pi.tools[0].execute(
      "sibling",
      { action: "steer", agent: sibling.agentLabel, message: "wrong owner" },
      undefined,
      undefined,
      context,
    );
    assert.equal(siblingResult.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "prompt" &&
          args[2] === sibling.paneId,
      ),
      false,
    );

    const resumed = await pi.tools[0].execute(
      "resume",
      {
        action: "delegate",
        session: resumePath,
        task: "wrong definition",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(resumed.details.error.category, "invalid_request");
    assert.match(resumed.details.error.message, /not allowed/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    nativeSessions.delete("ownership-resume");
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    for (const [name] of files) realFs.unlinkSync(join(PI_AGENTS_DIR, name));
  }
});

test("list exposes only agents with exact mailbox and Pi identities", async () => {
  setLeadEnvironment();
  const validLabel = "valid-list-agent";
  const invalidLabel = "invalid-list-agent";
  const valid = recoveryIdentity(validLabel);
  const invalid = {
    ...recoveryIdentity(invalidLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const validMailbox = agentMailboxPath(WORKSPACE, validLabel);
  const invalidMailbox = agentMailboxPath(WORKSPACE, invalidLabel);
  resetAgentMailbox(validMailbox);
  resetAgentMailbox(invalidMailbox);
  writeAgentState(validMailbox, managedState(validLabel, undefined, valid));
  writeAgentState(
    invalidMailbox,
    managedState(invalidLabel, undefined, invalid),
  );
  nativeSessions.set(invalid.piSessionId, {
    id: invalid.piSessionId,
    path: invalid.piSessionFile,
    entries: [],
  });
  nativeSessions.set(valid.piSessionId, {
    id: valid.piSessionId,
    path: valid.piSessionFile,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "agent" },
      },
    ],
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            workspace_id: WORKSPACE,
            agents: [
              {
                name: "unmanaged-agent",
                agent_status: "idle",
                workspace_id: WORKSPACE,
                pane_id: "unmanaged-pane",
                cwd: "/tmp",
              },
              {
                name: herdrAlias(invalidLabel),
                agent_status: "idle",
                workspace_id: WORKSPACE,
                pane_id: invalid.paneId,
                cwd: "/tmp",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: invalid.piSessionId,
                },
              },
              {
                name: herdrAlias(validLabel),
                agent_status: "idle",
                workspace_id: WORKSPACE,
                pane_id: valid.paneId,
                cwd: "/tmp",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: valid.piSessionId,
                },
                agent_definition: "wrong-herdr-definition",
              },
            ],
            agent_definitions: [],
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
                  pane_id: "unmanaged-pane",
                  workspace_id: WORKSPACE,
                  agent: "unmanaged-agent",
                  agent_status: "unknown",
                },
                {
                  pane_id: invalid.paneId,
                  workspace_id: WORKSPACE,
                  agent: invalidLabel,
                  agent_status: "idle",
                },
                {
                  pane_id: valid.paneId,
                  workspace_id: WORKSPACE,
                  agent: validLabel,
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
  try {
    registerExtension!(pi.pi as never);
    const result = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    const agents = (
      result.details as { agents: Array<Record<string, unknown>> }
    ).agents;
    assert.deepEqual(
      agents
        .filter((agent) => typeof agent.agent === "string")
        .map((agent) => agent.agent),
      [validLabel],
    );
    assert.equal(agents[0].agent_definition, "agent");
    assert.equal(agents[0].managed, true);
  } finally {
    nativeSessions.delete(invalid.piSessionId);
    nativeSessions.delete(valid.piSessionId);
    resetAgentMailbox(validMailbox);
    resetAgentMailbox(invalidMailbox);
  }
});

test("list projects an unreadable current mailbox as non-actionable unknown", async () => {
  setLeadEnvironment();
  const mailbox = agentMailboxPath(WORKSPACE, "unreadable-list-agent");
  realFs.mkdirSync(mailbox, { recursive: true });
  realFs.writeFileSync(join(mailbox, "state.json"), "x".repeat(70 * 1024));
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.agents.length, 1);
    assert.deepEqual(
      { ...result.details.agents[0], diagnostic: undefined },
      {
        state: "unknown",
        available_actions: [],
        managed: true,
        diagnostic: undefined,
      },
    );
    assert.match(
      result.details.agents[0].diagnostic,
      /Mailbox state unavailable: .*Mailbox record is too large/,
    );
    assert.match(
      (result.content[0] as { text: string }).text,
      /diagnostic: Mailbox state unavailable: .*Mailbox record is too large/,
    );
    assert.doesNotMatch(
      (result.content[0] as { text: string }).text,
      /session:|pane:/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
  }
});

test("assignment session resolution accepts exact paths and UUIDs only", async () => {
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ab",
    path: join(homedir(), "native-resume.jsonl"),
    cwd: join(homedir(), "saved-agent"),
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "reviewer" },
      },
    ],
  };
  nativeSessions.clear();
  nativeSessions.set(session.id, session);
  const context = fakeContext() as any;
  context.cwd = homedir();
  const byPath = await resolveAssignmentSession(context, session.path);
  assert.deepEqual(byPath, {
    path: session.path,
    id: session.id,
    agent: "reviewer",
    cwd: session.cwd,
  });
  const byId = await resolveAssignmentSession(context, session.id);
  assert.deepEqual(byId, byPath);
  const byTilde = await resolveAssignmentSession(
    context,
    "~/native-resume.jsonl",
  );
  assert.deepEqual(byTilde, byPath);
  await assert.rejects(
    resolveAssignmentSession(context, "11111111"),
    /prefixes are not allowed/,
  );
  nativeSessions.set("duplicate", {
    ...session,
    path: "/tmp/native-resume-2.jsonl",
  });
  await assert.rejects(
    resolveAssignmentSession(context, session.id),
    /ambiguous/,
  );
  nativeSessions.clear();
});

test("session delegation supports explicit labels and preserves generated labels", async () => {
  const run = async (label?: string) => {
    setLeadEnvironment();
    nativeSessions.clear();
    const source = {
      id: randomUUID(),
      path: join(tmpdir(), `session-delegate-${randomUUID()}.jsonl`),
      cwd: "/tmp",
    };
    realFs.writeFileSync(source.path, "{}", "utf8");
    nativeSessions.set(source.id, source);
    const startup = startupExecutor(
      label ?? "agent",
      () => DEFAULT_PI_SESSION_ID,
    );
    const pi = fakePi({ exec: startup.exec });
    registerExtension!(pi.pi as never);
    try {
      const result = await pi.tools[0].execute(
        "id",
        {
          action: "delegate",
          session: source.path,
          ...(label ? { label } : {}),
          task: label
            ? "continue with an explicit label"
            : "continue with the generated label",
        },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.equal(result.details.agent, label ?? "agent");
      assert.equal(
        readAgentState(agentMailboxPath(WORKSPACE, label ?? "agent"))
          ?.agentLabel,
        label ?? "agent",
      );
      const start = pi.calls.find(
        (args) => args[0] === "agent" && args[1] === "start",
      )!;
      assert.ok(start);
      assert.equal(
        start[start.indexOf("--session") + 1],
        realFs.realpathSync(source.path),
      );
      assert.equal(start.includes("--fork"), false);
      return result;
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      nativeSessions.clear();
      resetAgentMailbox(startup.mailbox);
      realFs.rmSync(source.path, { force: true });
    }
  };

  const first = await run("resume-explicit");
  assert.equal(first.details.agent, "resume-explicit");
  const reused = await run("resume-explicit");
  assert.equal(reused.details.agent, "resume-explicit");
  const generated = await run();
  assert.equal(generated.details.agent, "agent");
});

test("session delegation rejects invalid and occupied explicit labels without starting Herdr", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const invalidPi = fakePi();
  registerExtension!(invalidPi.pi as never);
  try {
    const invalidRequest = {
      action: "delegate",
      session: "/tmp/session.jsonl",
      label: "Invalid_Label",
      task: "reject the label",
    } as const;
    assert.equal(
      Value.Check(invalidPi.tools[0].parameters, invalidRequest),
      false,
    );
    const invalid = await invalidPi.tools[0].execute(
      "id",
      invalidRequest,
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(invalid.details.error.category, "invalid_request");
    assert.equal(invalidPi.calls.length, 0);
  } finally {
    invalidPi.events.get("session_shutdown")?.[0]();
  }

  setLeadEnvironment();
  const label = "resume-occupied";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label));
  const source = {
    id: randomUUID(),
    path: join(tmpdir(), `session-occupied-${randomUUID()}.jsonl`),
    cwd: "/tmp",
  };
  realFs.writeFileSync(source.path, "{}", "utf8");
  nativeSessions.set(source.id, source);
  const pi = fakePi({
    exec: leadExec(label, "idle", DEFAULT_PI_SESSION_ID),
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: source.path,
        label,
        task: "must not fall back to another label",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "agent_label_exists");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(mailbox);
    realFs.rmSync(source.path, { force: true });
  }
});

test("registered agent revalidates input mutated after tool_call", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  const input = {
    action: "delegate",
    definition: "agent",
    task: "initially valid",
  };
  try {
    const toolCall = pi.events.get("tool_call")?.[0];
    assert.ok(toolCall);
    assert.equal(
      await toolCall({ toolName: "agent", input }, context),
      undefined,
    );
    input.task = "";
    const blocked = await toolCall({ toolName: "agent", input }, context);
    assert.equal(blocked?.block, true);
    assert.equal(blocked?.reason, "Invalid agent input");
    const result = await pi.tools[0].execute(
      "id",
      input,
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.message, "Invalid agent input");
    assert.equal(result.details.error.operation, "delegate");
    assert.equal(result.details.error.details, undefined);
    assert.equal(pi.calls.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("public assignment normalizes invalid and unknown session sources", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const pi = fakePi({
    exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
  });
  registerExtension!(pi.pi as never);
  try {
    for (const [field, value, diagnostic] of [
      ["session", "11111111", /prefixes are not allowed/],
      [
        "session",
        "11111111-1111-4111-8111-111111111111",
        /no assignment session found/,
      ],
      ["fork", "11111111", /prefixes are not allowed/],
      [
        "fork",
        "22222222-2222-4222-8222-222222222222",
        /no assignment session found/,
      ],
    ] as const) {
      const result = await pi.tools[0].execute(
        "id",
        {
          action: "delegate",
          task: "resolve the source",
          ...(field === "session"
            ? { session: value }
            : { definition: "agent", fork: value }),
        },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, false, JSON.stringify(result.details));
      assert.equal(result.details.error.category, "invalid_request");
      assert.match(result.details.error.message, diagnostic);
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
  }
});

test("session assignment rejects the controller's active session", async () => {
  setLeadEnvironment();
  nativeSessions.clear();
  const session = {
    id: LEAD_SESSION_ID,
    path: "/tmp/lead.jsonl",
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "agent" },
      },
    ],
  };
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const pi = fakePi({
    exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      { action: "delegate", session: session.path, task: "same session" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /currently active Pi session/);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    nativeSessions.clear();
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("public assignment preserves session source open failures", async () => {
  setLeadEnvironment();
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789af",
    path: join(homedir(), "assignment-open-failure.jsonl"),
    cwd: "/tmp",
    entries: [],
  };
  nativeSessions.set(session.id, session);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  const openOperationError = new OperationError({
    category: "internal_failure",
    message: "session dependency failed",
    operation: "session-open-test",
    rollbackOccurred: false,
    retryAttempted: false,
  });
  support.sessionOpenError = openOperationError;
  try {
    const structured = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: session.path,
        task: "continue the saved session",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(structured.details.error, openOperationError.detail);

    const internalError = new Error("permission denied while opening session");
    support.sessionOpenError = internalError;
    await assert.rejects(
      pi.tools[0].execute(
        "id",
        {
          action: "delegate",
          session: session.path,
          task: "continue the saved session",
        },
        undefined,
        undefined,
        context,
      ),
      (error) => error === internalError,
    );
  } finally {
    support.sessionOpenError = undefined;
    nativeSessions.clear();
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("assignment session rejects unusable saved cwd headers without mutation", async () => {
  setLeadEnvironment();
  for (const [name, cwd] of [
    ["missing", undefined],
    ["empty", ""],
  ] as const) {
    const id = randomUUID();
    const label = `assignment-session-cwd-${name}-${id}`;
    const path = `/tmp/${id}.jsonl`;
    const mailbox = agentMailboxPath(WORKSPACE, label);
    assert.equal(realFs.existsSync(mailbox), false);
    nativeSessions.clear();
    nativeSessions.set(id, { id, path, cwd });
    const pi = fakePi({
      exec: () => ({ stdout: "0.8.0", stderr: "", code: 0 }),
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext();
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: path,
        task: "continue the saved session",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /no non-empty cwd/);
    assert.deepEqual(pi.calls, []);
    assert.equal(realFs.existsSync(mailbox), false);
    assert.deepEqual(pi.entries, []);
    pi.events.get("session_shutdown")?.[0]();
  }
  nativeSessions.clear();
  await (async () => {
    setLeadEnvironment();
    const source = {
      id: "018f2f2e-7b13-7abc-8def-0123456789ac",
      path: join(homedir(), "fork-lead.jsonl"),
      entries: [],
    };
    nativeSessions.clear();
    nativeSessions.set(source.id, source);
    try {
      const expected = {
        path: source.path,
        id: source.id,
      };
      assert.deepEqual(
        await resolveManagedSession(fakeContext(), source.path),
        expected,
      );
      assert.deepEqual(
        await resolveManagedSession(fakeContext(), source.id),
        expected,
      );
    } finally {
      nativeSessions.clear();
    }
  })();
});

test("agent assignment uses only an explicit exact fork source", async () => {
  setLeadEnvironment();
  const name = `fork-prompt-${randomUUID().slice(0, 8)}`;
  const source = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ad",
    path: join(homedir(), "explicit-fork-source.jsonl"),
    entries: [],
  };
  nativeSessions.set(source.id, source);
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  realFs.writeFileSync(promptPath, "current fork prompt");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    undefined,
    false,
    (args) =>
      launched.push({ args: [...args], contents: promptLaunchContents(args) }),
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
        fork: source.path,
        task: "review the forked session",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const start = pi.calls.find(
      (args) => args[0] === "agent" && args[1] === "start",
    )!;
    assert.equal(start[start.indexOf("--fork") + 1], source.path);
    assert.equal(start.includes("--session"), false);
    assert.equal(launched[0].contents.length, 2);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /current fork prompt/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.deepEqual(
      start.filter(
        (arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
      ),
      ["--system-prompt", "--append-system-prompt"],
    );
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    resetAgentMailbox(startup.mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("session assignment fails closed on duplicate live representations", async () => {
  setLeadEnvironment();
  const session = {
    id: "018f2f2e-7b13-7abc-8def-0123456789ae",
    path: "/tmp/duplicate-live-session.jsonl",
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { name: "agent" },
      },
    ],
  };
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const first = managedState(
    "duplicate-live-one",
    undefined,
    recoveryIdentity("duplicate-live-one"),
  );
  const second = {
    ...managedState(
      "duplicate-live-two",
      undefined,
      recoveryIdentity("duplicate-live-two"),
    ),
    piSessionId: session.id,
    piSessionFile: session.path,
  };
  first.piSessionId = session.id;
  first.piSessionFile = session.path;
  const mailboxes = [first, second].map((state) => {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    return mailbox;
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({
            result: {
              agents: [agentFromState(first), agentFromState(second)],
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        session: session.path,
        label: "session-conflict-label",
        task: "continue the ambiguous session",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.clear();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
    realFs.rmSync(session.path, { force: true });
  }
});

test("registered delegate validates duplicate agents, selectors, and timeout before lifecycle use", async () => {
  setLeadEnvironment();
  const label = "duplicate-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, undefined, identity));
  const duplicate = fakePi({
    exec: leadExec(
      label,
      "idle",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(duplicate.pi as never);
  await duplicate.events.get("session_start")![0](undefined, fakeContext());
  const tool = duplicate.tools[0];
  assert.equal(tool.name, "agent");
  assert.equal(
    duplicate.tools.some((candidate) => candidate.name === "subagent"),
    false,
  );
  assert.equal(duplicate.commandOptions.has("agents"), true);
  assert.equal(duplicate.commandOptions.has("subagents"), false);
  const context = fakeContext();
  const duplicateResult = await tool.execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      label: "duplicate-agent",
      task: "duplicate task",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(duplicateResult.details.error.category, "agent_label_exists");
  assert.equal(
    duplicate.calls.some((args) => args.includes("--env")),
    false,
  );

  const invalidTimeout = await tool.execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      timeoutMs: 5000,
      task: "invalid timeout task",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(invalidTimeout.details.error.category, "invalid_request");
  assert.equal(invalidTimeout.details.error.message, "Invalid agent input");
  const missingAgentTask = await tool.execute(
    "id",
    { action: "delegate", agent: "session-agent" },
    undefined,
    undefined,
    context,
  );
  assert.equal(missingAgentTask.details.error.category, "invalid_request");
  for (const legacy of [
    { action: "start", definition: "agent", task: "legacy start" },
    {
      action: "resume",
      session: "/tmp/session.jsonl",
      task: "legacy resume",
    },
    { action: "assign", agent: label, task: "legacy assign" },
  ]) {
    const result = await tool.execute(
      "id",
      legacy,
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.message, "Invalid agent input");
  }
  const substitutedResume = await tool.execute(
    "id",
    {
      action: "delegate",
      session: "/tmp/missing-session.jsonl",
      definition: "implementer",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(substitutedResume.details.error.category, "invalid_request");
  duplicate.events.get("session_shutdown")?.[0]();
});

test("registered delegate ignores an unrelated agent and forwards its child budget", async () => {
  setLeadEnvironment();
  const label = "minimum-timeout-agent";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = startup.exec(command, args, options);
      if (command === "herdr" && isAgentList(args)) {
        const value = JSON.parse(result.stdout);
        const envelope = value.result ?? value;
        envelope.agents.push({
          herdr_kind: "pi",
          workspace_id: WORKSPACE,
          pane_id: "unmanaged-lead-pane",
          cwd: "/tmp",
        });
        return { ...result, stdout: JSON.stringify(value) };
      }
      return result;
    },
  });
  registerExtension!(pi.pi as never);
  const originalDateNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const result = await pi.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: "agent",
        label,
        task: "minimum timeout task",
        timeoutMs: 6000,
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true);
    const start = pi.calls.findIndex(
      (args) => args[0] === "agent" && args[1] === "start",
    );
    assert.ok(start >= 0);
    const childTimeout = Number(
      pi.calls[start]![pi.calls[start]!.indexOf("--timeout") + 1],
    );
    assert.equal(childTimeout, 4000);
    assert.equal(pi.execOptions[start]?.timeout, 4000);
  } finally {
    Date.now = originalDateNow;
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("registered delegate protects a live mailbox owned by another owner", async () => {
  setLeadEnvironment();
  const label = "reviewer";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = {
    ...managedState(label, undefined, defaultFixtureIdentity),
    ownerSessionId: "owner-a",
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: state.paneId,
    kind: "task",
    text: "preserve me",
    createdAt: Date.now(),
  });
  writeResult(mailbox, {
    version: 4,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: state.paneId,
    status: "completed",
    text: "preserve this result",
    completedAt: Date.now(),
  });
  const before = readFileSync(`${mailbox}/state.json`, "utf8");
  const requestBefore = readFileSync(
    `${mailbox}/request-${REQUEST_ID}.json`,
    "utf8",
  );
  const resultBefore = readFileSync(
    `${mailbox}/result-${REQUEST_ID}.json`,
    "utf8",
  );
  const pi = fakePi({
    exec: leadExec(label, "idle", DEFAULT_PI_SESSION_ID),
  });
  registerExtension!(pi.pi as never);
  const tool = pi.tools[0];
  const result = await tool.execute(
    "id",
    { action: "delegate", definition: "agent", label, task: "preserve me" },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.error.category, "agent_label_exists");
  assert.equal(
    pi.calls.some((args) => args.includes("--placement")),
    false,
  );
  assert.equal(readFileSync(`${mailbox}/state.json`, "utf8"), before);
  assert.equal(
    readFileSync(`${mailbox}/request-${REQUEST_ID}.json`, "utf8"),
    requestBefore,
  );
  assert.equal(
    readFileSync(`${mailbox}/result-${REQUEST_ID}.json`, "utf8"),
    resultBefore,
  );
  pi.events.get("session_shutdown")?.[0]();
});

test("fresh assignments do not reset an unacknowledged stale mailbox", async () => {
  setLeadEnvironment();
  const explicitLabel = "stale-explicit-agent";
  const explicitMailbox = agentMailboxPath(WORKSPACE, explicitLabel);
  const explicitState = managedState(explicitLabel);
  const explicitRequestId = randomUUID();
  writeAgentState(explicitMailbox, explicitState);
  writeRequest(explicitMailbox, {
    version: 4,
    runId: explicitState.runId,
    requestId: explicitRequestId,
    ownerSessionId: explicitState.ownerSessionId,
    workspaceId: explicitState.workspaceId,
    agentLabel: explicitState.agentLabel,
    paneId: explicitState.paneId,
    kind: "task",
    text: "preserve stale handoff",
    createdAt: Date.now(),
  });
  const explicitStartup = startupExecutor(explicitLabel, () => null);
  const explicitPi = fakePi({ exec: explicitStartup.exec });
  registerExtension!(explicitPi.pi as never);
  const explicit = await explicitPi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      label: explicitLabel,
      task: "must not reset stale handoff",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(explicit.details.error.category, "agent_label_exists");
  assert.ok(readRequest(explicitMailbox, explicitRequestId));
  assert.equal(
    explicitPi.calls.some((args) => args[0] === "agent" && args[1] === "start"),
    false,
  );
  explicitPi.events.get("session_shutdown")?.[0]();

  const automaticLabel = "agent";
  const automaticMailbox = agentMailboxPath(WORKSPACE, automaticLabel);
  const automaticState = managedState(automaticLabel);
  const automaticRequestId = randomUUID();
  writeAgentState(automaticMailbox, automaticState);
  writeRequest(automaticMailbox, {
    version: 4,
    runId: automaticState.runId,
    requestId: automaticRequestId,
    ownerSessionId: automaticState.ownerSessionId,
    workspaceId: automaticState.workspaceId,
    agentLabel: automaticState.agentLabel,
    paneId: automaticState.paneId,
    kind: "task",
    text: "preserve automatic handoff",
    createdAt: Date.now(),
  });
  const automaticStartup = startupExecutor(
    automaticLabel + "-2",
    () => DEFAULT_PI_SESSION_ID,
  );
  const automaticPi = fakePi({ exec: automaticStartup.exec });
  registerExtension!(automaticPi.pi as never);
  const automatic = await automaticPi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      task: "use the next safe label",
    },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(automatic.details.ok, true, JSON.stringify(automatic.details));
  assert.equal(automatic.details.agent, `${automaticLabel}-2`);
  assert.ok(readRequest(automaticMailbox, automaticRequestId));
  automaticPi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(automaticStartup.mailbox);
  resetAgentMailbox(explicitMailbox);
});

test("assignment retains its request when acknowledgement never arrives", async () => {
  setLeadEnvironment();
  const label = "ack-timeout-agent";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const controller = new AbortController();
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        setTimeout(() => controller.abort(), 10);
        return { stdout: "{}", stderr: "", code: 0 };
      }
      return startup.exec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  const result = await pi.tools[0].execute(
    "id",
    {
      action: "delegate",
      definition: "agent",
      label,
      task: "retain on timeout",
    },
    controller.signal,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.ok, false);
  assert.equal(
    realFs
      .readdirSync(startup.mailbox)
      .filter((name) => name.startsWith("request-") && name.endsWith(".json"))
      .length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startup.mailbox);
});

test("registered lead exposes only explicit live controls", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const label = "action-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const steerFile = join("/tmp", `${label}-update.md`);
  realFs.writeFileSync(steerFile, "steer evidence");
  let steerSubmitted: RequestRecord | undefined;
  const accepting = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V4__:".length);
        steerSubmitted = readRequest(requestMailbox, requestId);
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
  registerExtension!(accepting.pi as never);
  assert.deepEqual(
    accepting.tools.map((candidate) => candidate.name),
    ["agent", "chief"],
  );
  assert.equal(
    accepting.tools.some((candidate) => candidate.name === "subagent"),
    false,
  );
  const tool = accepting.tools[0];
  const context = fakeContext(accepting.entries);
  await accepting.events.get("session_start")![0](
    undefined,
    fakeContext(accepting.entries),
  );
  const listed = await tool.execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(listed.details.agents[0].available_actions, [
    "inspect",
    "steer",
    "close",
  ]);
  const steer = await accepting.tools[0].execute(
    "id",
    { action: "steer", agent: label, message: "continue", files: [steerFile] },
    undefined,
    undefined,
    context,
  );
  assert.equal(steer.details.ok, true);
  assert.equal(steer.details.action, "steer");
  assert.equal(steer.details.agent, label);
  assert.equal(steer.details.session_id, identity.piSessionId);
  assert.equal(steer.details.assignment_request_id, REQUEST_ID);
  assert.equal(steer.details.truncated, false);
  assert.equal(steerSubmitted?.kind, "steer");
  assert.match(steerSubmitted?.text ?? "", /steer evidence/);
  assert.equal(steerSubmitted?.requestId, steer.details.request_id);
  assert.match(
    (steer.content[0] as { text: string }).text,
    new RegExp(`Session: ${identity.piSessionId}`),
  );
  assert.match(
    (steer.content[0] as { text: string }).text,
    /Assignment request: /,
  );
  const rendered = accepting.tools[0].renderResult(
    { content: steer.content, details: steer.details },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text },
    { args: { action: "steer", agent: label, message: "continue" } },
  );
  assert.match(rendered.text, new RegExp(`session: ${identity.piSessionId}`));
  assert.match(rendered.text, /assignment request: /);
  accepting.events.get("session_shutdown")?.[0]();
  realFs.rmSync(steerFile, { force: true });
});

test("lead steers a blocked parent waiting for direct-child work", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "steerable-parent",
      REQUEST_ID,
      recoveryIdentity("steerable-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/steerable-parent.jsonl",
  };
  const child = {
    ...managedState(
      "steerable-child",
      randomUUID(),
      recoveryIdentity("steerable-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/steerable-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  const foreignChildMailbox = agentMailboxPath(
    "foreign-steerable-workspace",
    "foreign-steerable-child",
  );
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  resetAgentMailbox(foreignChildMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const childBefore = readAgentState(childMailbox);
  const observedParent = { ...parent, activeRequestId: undefined };
  let parentStatus: "idle" | "working" = "idle";
  const base = agentControllerExecutor(observedParent, [child]);
  const pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        const requestId = (args.at(-1) ?? "").replace(
          "__PI_HERDSMAN_AGENT_V4__:",
          "",
        );
        const current = readAgentState(parentMailbox)!;
        writeAgentState(parentMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command === "herdr" && isAgentList(args)) {
        const liveParent = readAgentState(parentMailbox) ?? observedParent;
        const liveChild = readAgentState(childMailbox) ?? child;
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                agentFromState(liveParent, parentStatus),
                agentFromState(
                  liveChild,
                  liveChild.activeRequestId ? "working" : "idle",
                ),
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (
        command === "herdr" &&
        args[0] === "agent" &&
        args[1] === "get" &&
        args[2] === parent.paneId
      )
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                ...agentFromState(observedParent, parentStatus),
                session_id: parent.piSessionId,
                session_path: parent.piSessionFile,
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return base(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const listed = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      listed.details.agents[0]?.state,
      "blocked",
      JSON.stringify(listed.details),
    );
    assert.ok(listed.details.agents[0].available_actions.includes("steer"));
    const listedChild = (listed.details.agents as any[]).find(
      (agent) => agent.agent === child.agentLabel,
    );
    assert.deepEqual(listedChild?.available_actions, []);

    parentStatus = "working";
    const workingParent = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(workingParent.details.agents[0].state, "working");
    assert.ok(
      workingParent.details.agents[0].available_actions.includes("steer"),
    );

    parentStatus = "idle";
    writeAgentState(childMailbox, {
      ...child,
      activeRequestId: undefined,
      completedRequestId: undefined,
    });
    const noChildWork = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(noChildWork.details.agents[0].state, "settling");
    assert.ok(
      !noChildWork.details.agents[0].available_actions.includes("steer"),
    );

    writeAgentState(foreignChildMailbox, {
      ...child,
      workspaceId: "foreign-steerable-workspace",
      agentLabel: "foreign-steerable-child",
      activeRequestId: randomUUID(),
    });
    const foreignWorkspaceChild = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.ok(
      !foreignWorkspaceChild.details.agents[0].available_actions.includes(
        "steer",
      ),
    );
    resetAgentMailbox(foreignChildMailbox);
    writeAgentState(childMailbox, child);

    writeAgentState(childMailbox, {
      ...child,
      ownerSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const otherOwnerChild = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.ok(
      !otherOwnerChild.details.agents[0].available_actions.includes("steer"),
    );
    writeAgentState(childMailbox, child);

    writeAgentState(parentMailbox, {
      ...parent,
      activeRequestId: undefined,
    });
    const noParentAssignment = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.ok(
      !noParentAssignment.details.agents[0].available_actions.includes("steer"),
    );
    writeAgentState(parentMailbox, parent);

    const handoffRequestId = randomUUID();
    writeRequest(parentMailbox, {
      version: 4,
      runId: parent.runId,
      requestId: handoffRequestId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      kind: "task",
      text: "pending handoff",
      createdAt: Date.now(),
    });
    const handoffPending = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(handoffPending.details.agents[0].state, "settling");
    assert.ok(
      !handoffPending.details.agents[0].available_actions.includes("steer"),
    );
    removeRequest(parentMailbox, handoffRequestId);

    const steered = await pi.tools[0].execute(
      "steer",
      { action: "steer", agent: parent.agentLabel, message: "continue" },
      undefined,
      undefined,
      context,
    );
    assert.equal(steered.details.ok, true, JSON.stringify(steered.details));
    assert.equal(readAgentState(parentMailbox)?.activeRequestId, REQUEST_ID);
    assert.deepEqual(readAgentState(childMailbox), childBefore);

    writeAgentState(childMailbox, {
      ...child,
      activeRequestId: undefined,
      completedRequestId: child.activeRequestId,
    });
    writeResult(childMailbox, {
      version: 4,
      runId: child.runId,
      requestId: child.activeRequestId!,
      ownerSessionId: child.ownerSessionId,
      workspaceId: child.workspaceId,
      agentLabel: child.agentLabel,
      paneId: child.paneId,
      status: "completed",
      text: "child result",
      completedAt: Date.now(),
    });
    assert.ok(readResult(childMailbox, child.activeRequestId!));
    const completedChild = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(completedChild.details.agents[0].state, "blocked");
    assert.ok(
      completedChild.details.agents[0].available_actions.includes("steer"),
    );
    assert.equal(
      readAgentState(childMailbox)?.completedRequestId,
      child.activeRequestId,
    );

    const ownerAskId = randomUUID();
    writeAsk(parentMailbox, {
      version: 4,
      askId: ownerAskId,
      requestId: REQUEST_ID,
      runId: parent.runId,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      piSessionId: parent.piSessionId,
      question: "owner clarification",
      createdAt: Date.now(),
    });
    writeAgentState(parentMailbox, {
      ...parent,
      pendingAskId: ownerAskId,
    });
    const ownerAsk = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(ownerAsk.details.agents[0].state, "blocked");
    assert.deepEqual(ownerAsk.details.agents[0].available_actions, [
      "inspect",
      "reply",
      "close",
    ]);
    removeAsk(parentMailbox, ownerAskId);
    writeAgentState(parentMailbox, parent);

    writeAgentState(parentMailbox, {
      ...parent,
      activeRequestId: undefined,
      completedRequestId: REQUEST_ID,
    });
    writeResult(parentMailbox, {
      version: 4,
      runId: parent.runId,
      requestId: REQUEST_ID,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      status: "completed",
      text: "parent result while child result is pending",
      completedAt: Date.now(),
    });
    const completionWithChild = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(completionWithChild.details.agents[0].state, "settling");
    assert.ok(
      !completionWithChild.details.agents[0].available_actions.includes(
        "steer",
      ),
    );
    writeAgentState(parentMailbox, parent);

    removeResult(childMailbox, child.activeRequestId!);
    assert.equal(
      readAgentState(childMailbox)?.completedRequestId,
      child.activeRequestId,
    );
    const completedChildWithoutResult = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      completedChildWithoutResult.details.agents[0].available_actions.includes(
        "steer",
      ),
      false,
    );

    writeAgentState(parentMailbox, {
      ...parent,
      activeRequestId: undefined,
      completedRequestId: REQUEST_ID,
    });
    writeResult(parentMailbox, {
      version: 4,
      runId: parent.runId,
      requestId: REQUEST_ID,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      status: "completed",
      text: "parent result",
      completedAt: Date.now(),
    });
    const ownCompletion = await pi.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
    assert.equal(ownCompletion.details.agents[0].state, "settling");
    assert.ok(
      !ownCompletion.details.agents[0].available_actions.includes("steer"),
    );
    const rejected = await pi.tools[0].execute(
      "steer",
      { action: "steer", agent: parent.agentLabel, message: "late" },
      undefined,
      undefined,
      context,
    );
    assert.equal(rejected.details.error.category, "agent_busy");
    assert.match(
      rejected.details.error.message,
      /not currently accepting steering/,
    );

    pi.events.get("session_shutdown")?.[0]();
    const restarted = fakePi({
      exec: (command, args, options) => {
        if (
          command === "herdr" &&
          args[0] === "agent" &&
          args[1] === "get" &&
          args[2] === parent.paneId
        )
          return {
            stdout: JSON.stringify({
              result: {
                agent: {
                  ...agentFromState(observedParent, parentStatus),
                  session_id: parent.piSessionId,
                  session_path: parent.piSessionFile,
                },
              },
            }),
            stderr: "",
            code: 0,
          };
        return base(command, args, options);
      },
    });
    registerExtension!(restarted.pi as never);
    const restartedList = await restarted.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.ok(
      !restartedList.details.agents[0].available_actions.includes("steer"),
    );
    restarted.events.get("session_shutdown")?.[0]();

    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    const recoveredPositive = fakePi({ exec: base });
    registerExtension!(recoveredPositive.pi as never);
    const recoveredPositiveList = await recoveredPositive.tools[0].execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.ok(
      recoveredPositiveList.details.agents[0].available_actions.includes(
        "steer",
      ),
    );
    recoveredPositive.events.get("session_shutdown")?.[0]();
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    resetAgentMailbox(foreignChildMailbox);
  }
});

test("acknowledgement state-write failures retain requests for terminal retry", () => {
  const cases = [
    {
      name: "busy rejection",
      kind: "task" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      expected: {
        accepted: false,
        code: "busy" as const,
        message: "Agent already has an active assignment",
      },
    },
    {
      name: "idle rejection",
      kind: "steer" as const,
      isIdle: true,
      expected: {
        accepted: false,
        code: "idle" as const,
        message: "Agent is not accepting steering",
      },
    },
    {
      name: "successful steer delivery",
      kind: "steer" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      expected: { accepted: true },
    },
    {
      name: "failed steer delivery",
      kind: "steer" as const,
      isIdle: false,
      activeRequestId: randomUUID(),
      deliveryFailure: true,
      expected: {
        accepted: false,
        code: "delivery" as const,
        message: "Error: injected steer delivery failure",
      },
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const label = `ack-retry-${index}`;
    const mailbox = setAgentEnvironment(label);
    const activeRequestId = scenario.activeRequestId;
    writeAgentState(mailbox, managedState(label, activeRequestId));
    const agent = fakePi();
    registerExtension!(agent.pi as never);
    const context = fakeAgentContext();
    (context as any).isIdle = () => scenario.isIdle;
    agent.events.get("session_start")![0](undefined, context);
    if (scenario.deliveryFailure)
      agent.pi.sendUserMessage = () => {
        throw new Error("injected steer delivery failure");
      };

    const started = readAgentState(mailbox)!;
    const request: RequestRecord = {
      version: 4,
      runId: started.runId,
      requestId: randomUUID(),
      ownerSessionId: started.ownerSessionId,
      workspaceId: started.workspaceId,
      agentLabel: started.agentLabel,
      paneId: started.paneId,
      kind: scenario.kind,
      text: scenario.name,
      createdAt: Date.now(),
    };
    writeRequest(mailbox, request);
    support.failNextMailboxWrite = true;
    const input = agent.events.get("input")![0];
    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "handled",
      },
    );
    assert.equal(readAgentState(mailbox)?.lastAck, undefined);
    assert.ok(readRequest(mailbox, request.requestId));
    if (scenario.name === "successful steer delivery")
      assert.equal(agent.sentUsers.length, 1);

    assert.deepEqual(
      input({ text: controlMarker(request.requestId) }, context),
      {
        action: "handled",
      },
    );
    const acknowledged = readAgentState(mailbox)?.lastAck;
    assert.equal(acknowledged?.requestId, request.requestId, scenario.name);
    assert.equal(acknowledged?.accepted, scenario.expected.accepted);
    assert.equal(acknowledged?.code, scenario.expected.code);
    assert.equal(acknowledged?.message, scenario.expected.message);
    assert.equal(readRequest(mailbox, request.requestId), undefined);
    if (scenario.name === "successful steer delivery")
      assert.equal(agent.sentUsers.length, 2);
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("assignment status normalization fails closed safely", async () => {
  const cases = [
    {
      suffix: "available",
      status: "done" as const,
      result: false,
      expectedState: "settling",
    },
    {
      suffix: "working",
      status: "working" as const,
      result: false,
      expectedState: "unknown",
    },
    {
      suffix: "pending",
      status: "done" as const,
      result: true,
      expectedState: "settling",
    },
    {
      suffix: "null-status",
      status: "done" as const,
      agentStatus: null,
      result: false,
      expectedState: "unknown",
    },
    {
      suffix: "unsupported-status",
      status: "done" as const,
      agentStatus: "interactive",
      result: false,
      expectedState: "unknown",
    },
  ];
  for (const scenario of cases) {
    setLeadEnvironment();
    const label = `status-${scenario.suffix}`;
    const identity = recoveryIdentity(label);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    const state = managedState(label, undefined, identity);
    writeAgentState(mailbox, state);
    if (scenario.result) {
      state.completedRequestId = REQUEST_ID;
      writeAgentState(mailbox, state);
      writeResult(mailbox, {
        version: 4,
        runId: AGENT_ID,
        requestId: REQUEST_ID,
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: identity.paneId,
        status: "completed",
        text: "pending",
        completedAt: Date.now(),
      });
    }
    const pi = fakePi({
      exec: leadExec(
        label,
        scenario.status,
        identity.piSessionId,
        (requestMailbox, marker) => {
          const requestId = marker.slice("__PI_HERDSMAN_AGENT_V4__:".length);
          const current = readAgentState(requestMailbox)!;
          writeAgentState(requestMailbox, {
            ...current,
            lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
            updatedAt: Date.now(),
          });
        },
        identity.piSessionId,
        identity,
        true,
        scenario.agentStatus,
      ),
    });
    try {
      registerExtension!(pi.pi as never);
      const context = fakeContext();
      const listed = await pi.tools[0].execute(
        "list",
        { action: "list" },
        undefined,
        undefined,
        context,
      );
      const agents = (listed.details as { agents: any[] }).agents;
      assert.equal(agents.length, 1);
      assert.equal(agents[0].state, scenario.expectedState);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
  await (async () => {
    setLeadEnvironment();
    const label = "mailbox-eligibility-agent";
    const identity = recoveryIdentity(label);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const state = managedState(label, undefined, identity);
    writeAgentState(mailbox, state);
    const pi = fakePi({
      exec: leadExec(
        label,
        "idle",
        identity.piSessionId,
        (requestMailbox, marker) => {
          const requestId = marker.slice("__PI_HERDSMAN_AGENT_V4__:".length);
          const current = readAgentState(requestMailbox)!;
          writeAgentState(requestMailbox, {
            ...current,
            activeRequestId: requestId,
            completedRequestId: undefined,
            lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
            updatedAt: Date.now(),
          });
        },
        identity.piSessionId,
        identity,
      ),
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext();
    try {
      const handoffRequestId = randomUUID();
      writeRequest(mailbox, {
        version: 4,
        runId: state.runId,
        requestId: handoffRequestId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        kind: "task",
        text: "recover this handoff",
        createdAt: Date.now(),
      });
      await pi.events.get("session_start")![0](undefined, context);
      const handoffList = await pi.tools[0].execute(
        "id",
        { action: "list" },
        undefined,
        undefined,
        context,
      );
      assert.equal(handoffList.details.agents[0].state, "settling");
      assert.equal(
        handoffList.details.agents[0].available_actions.includes("delegate"),
        false,
      );
      removeRequest(mailbox, handoffRequestId);

      const requestA = randomUUID();
      writeAgentState(mailbox, {
        ...state,
        activeRequestId: requestA,
      });
      const activeList = await pi.tools[0].execute(
        "id",
        { action: "list" },
        undefined,
        undefined,
        context,
      );
      assert.equal(activeList.details.agents[0].state, "settling");
      assert.equal(activeList.details.agents[0].active_request_id, requestA);
      assert.equal(
        activeList.details.agents[0].available_actions.includes("delegate"),
        false,
      );

      writeAgentState(mailbox, {
        ...state,
        completedRequestId: requestA,
      });
      writeResult(mailbox, {
        version: 4,
        runId: state.runId,
        requestId: requestA,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        status: "completed",
        text: "done",
        completedAt: Date.now(),
      });
      const completedList = await pi.tools[0].execute(
        "id",
        { action: "list" },
        undefined,
        undefined,
        context,
      );
      assert.equal(completedList.details.agents[0].state, "settling");
      assert.equal(
        completedList.details.agents[0].available_actions.includes("delegate"),
        false,
      );

      removeResult(mailbox, requestA);
      const settledList = await pi.tools[0].execute(
        "id",
        { action: "list" },
        undefined,
        undefined,
        context,
      );
      assert.equal(settledList.details.agents[0].state, "settling");
      assert.deepEqual(settledList.details.agents[0].available_actions, [
        "inspect",
        "close",
      ]);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  })();
});

test("rejects context injection before unsupported actions perform work", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const filesResult = await pi.tools[0].execute(
    "id",
    { action: "list", files: ["missing.txt"] },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(filesResult.details.error.category, "invalid_request");
  assert.equal(pi.calls.length, 0);
  const closeFilesResult = await pi.tools[0].execute(
    "id",
    { action: "close", agent: "agent", files: ["missing.txt"] },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(closeFilesResult.details.error.category, "invalid_request");
  assert.equal(pi.calls.length, 0);
});
