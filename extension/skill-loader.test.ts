import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { registerSkillLoader } from "./skill-loader.ts";

function testSkill(cwd: string, name: string, disableModelInvocation = false): Skill {
  const filePath = join(cwd, `${name}.md`);
  return {
    name,
    description: 'Guide with "quotes"\nand a new line',
    filePath,
    baseDir: cwd,
    sourceInfo: {
      path: filePath,
      source: "test",
      scope: "project",
      origin: "top-level",
    },
    disableModelInvocation,
  };
}

test("Pi exposes eligible skills to direct and Code Mode invocation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "herdsman-skill-loader-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const guide = testSkill(cwd, "guide");
  const manual = testSkill(cwd, "manual", true);
  const missing = testSkill(cwd, "missing");
  const content = "---\nname: guide\n---\n# Full skill instructions\n";
  const userGuide = testSkill(cwd, "user-guide");
  userGuide.sourceInfo.scope = "user";
  await Promise.all([guide, userGuide].map(({ filePath }) => writeFile(filePath, content, "utf8")));

  const faux = fauxProvider({
    provider: "session-skill-loader-test",
    models: [{ id: "test", reasoning: false, input: ["text"] }],
  });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  let tools: string[] | undefined;
  let skills = [guide, manual];
  let chief = false;
  let shadowRead = false;
  function resourceOptions(mode: "only" | "on") {
    return {
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      skillsOverride: () => ({ skills: [guide, manual], diagnostics: [] }),
      extensionFactories: [
        createCodemodeExtension({ mode }),
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", (event) => {
            if (shadowRead) {
              shadowRead = false;
              pi.registerTool({
                name: "read",
                label: "Not a native reader",
                description: "A custom tool sharing the name read.",
                parameters: { type: "object", properties: {} },
                async execute() {
                  return { content: [], details: undefined };
                },
              });
            }
            if (tools) pi.setActiveTools(tools);
            event.systemPromptOptions.skills = skills;
          });
          registerSkillLoader(pi, () => chief);
        },
      ],
    };
  }
  async function startSession(
    selection: Pick<
      NonNullable<Parameters<typeof createAgentSession>[0]>,
      "tools" | "excludeTools" | "noTools"
    > = {},
    mode: "only" | "on" = "only",
  ) {
    const resourceLoader = new DefaultResourceLoader(resourceOptions(mode));
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime,
      model: faux.getModel()!,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      ...selection,
    });
    t.after(() => session.dispose());
    return session;
  }
  const session = await startSession();

  let declarations: ReturnType<typeof getCurrentTools> = [];
  async function prompt(
    call?: ReturnType<typeof fauxToolCall>,
    afterDeclaration?: () => void,
    target = session,
    onNextDeclarations?: (nextDeclarations: ReturnType<typeof getCurrentTools>) => void,
  ) {
    declarations = [];
    faux.setResponses([
      (context) => {
        declarations = getCurrentTools(context.messages);
        afterDeclaration?.();
        return call
          ? fauxAssistantMessage([call], { stopReason: "toolUse" })
          : fauxAssistantMessage("done");
      },
      (context) => {
        onNextDeclarations?.(getCurrentTools(context.messages));
        return fauxAssistantMessage("done");
      },
    ]);
    await target.prompt("Check the session tools.");
    return declarations.find(({ name }) => name === "load_skill");
  }

  function lastToolResult(target = session) {
    const result = [...target.agent.state.messages]
      .reverse()
      .find((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    return result;
  }

  assert.ok(
    session.getActiveToolNames().includes("load_skill"),
    "intrinsic activation without a launch selection",
  );
  assert.equal(await prompt(), undefined, "native readers mask the loader");

  for (const [reader, mode] of [
    ["read", []],
    ["bash", ["codemode"]],
  ] as const) {
    tools = ["load_skill", reader, ...mode];
    assert.equal(await prompt(), undefined, reader);
    assert.equal(
      declarations.some(({ name }) => name === reader),
      !mode.length,
    );
    assert.ok(session.getActiveToolNames().includes("load_skill"));
  }
  tools = ["load_skill", "read", "codemode"];
  assert.equal(await prompt(), undefined, "native reader hides direct declaration");
  assert.ok(
    !session.getCallableToolNames().includes("load_skill"),
    "native reader also removes Code Mode callability",
  );

  await prompt(fauxToolCall("load_skill", { name: "guide" }));
  assert.equal(lastToolResult().isError, true);
  assert.deepEqual(lastToolResult().content, [
    { type: "text", text: "Skill unavailable in this session" },
  ]);

  for (const nonReader of ["grep", "powershell", "codemode"]) {
    tools = ["load_skill", nonReader];
    const declaration = await prompt();
    if (nonReader === "codemode") {
      assert.equal(declaration, undefined);
      assert.ok(session.getCallableToolNames().includes("load_skill"));
      const codemode = declarations.find(({ name }) => name === "codemode");
      assert.ok(codemode?.description.includes("Do not reload a skill"));
      assert.ok(codemode?.description.includes('- "guide":'));
      assert.ok(!codemode?.description.includes('"manual"'));
      assert.ok(!codemode?.description.includes(cwd));
      const registered = session.getAllTools().find(({ name }) => name === "load_skill");
      assert.ok(registered?.description.includes("Do not reload a skill"));
      assert.ok(
        registered?.description.includes(`- "guide": ${JSON.stringify(guide.description)}`),
      );
      assert.ok(!registered?.description.includes("manual"));
      assert.ok(!registered?.description.includes(cwd));
    } else {
      assert.ok(declaration, nonReader);
      assert.ok(declaration.description.includes("Do not reload a skill"));
      assert.ok(
        declaration.description.includes(`- "guide": ${JSON.stringify(guide.description)}`),
      );
      assert.ok(!declaration.description.includes("manual"));
      assert.ok(!declaration.description.includes(cwd));
    }
  }
  await prompt(fauxToolCall("load_skill", { name: "guide" }));
  assert.equal(lastToolResult().isError, false);
  assert.deepEqual(lastToolResult().content, [
    {
      type: "text",
      text: `Skill: guide\nDirectory: ${guide.baseDir}\n\n${content}`,
    },
  ]);

  assert.ok(session.getCallableToolNames().includes("load_skill"));
  await prompt(
    fauxToolCall("codemode", {
      code: 'text(await tools.load_skill({ name: "guide" }));',
    }),
  );
  assert.equal(lastToolResult().toolName, "codemode");
  assert.equal(lastToolResult().isError, false);
  assert.match(
    lastToolResult()
      .content.map((item) => (item.type === "text" ? item.text : ""))
      .join("\\n"),
    /Full skill instructions/,
  );

  tools = ["load_skill", "codemode"];
  skills = [guide, manual];
  const onSession = await startSession({ tools: ["load_skill", "codemode"] }, "on");
  const onDeclaration = await prompt(undefined, undefined, onSession);
  assert.ok(onDeclaration?.description.includes("Do not reload a skill"));
  assert.ok(onDeclaration?.description.includes('- "guide":'));
  assert.ok(onSession.getCallableToolNames().includes("load_skill"));
  await prompt(
    fauxToolCall("codemode", {
      code: 'text(await tools.load_skill({ name: "guide" }));',
    }),
    undefined,
    onSession,
  );
  assert.equal(lastToolResult(onSession).isError, false);
  assert.match(
    lastToolResult(onSession)
      .content.map((item) => (item.type === "text" ? item.text : ""))
      .join("\\n"),
    /Full skill instructions/,
  );

  for (const name of ["Guide", "manual"]) {
    await prompt(fauxToolCall("load_skill", { name }));
    assert.equal(lastToolResult().isError, true);
    assert.deepEqual(lastToolResult().content, [
      { type: "text", text: "Skill unavailable in this session" },
    ]);
  }

  shadowRead = true;
  tools = ["load_skill", "read"];
  assert.ok(await prompt(fauxToolCall("load_skill", { name: "guide" })));
  assert.ok(declarations.some(({ name }) => name === "read"));
  assert.equal(lastToolResult().isError, false);

  skills = [guide, userGuide];
  const beforeChief = await prompt(fauxToolCall("load_skill", { name: "guide" }), () => {
    chief = true;
  });
  assert.ok(beforeChief?.description.includes('- "guide":'));
  assert.equal(lastToolResult().isError, true);
  assert.deepEqual(lastToolResult().content, [
    { type: "text", text: "Skill unavailable in this session" },
  ]);

  const chiefDeclaration = await prompt(fauxToolCall("load_skill", { name: "user-guide" }));
  assert.ok(chiefDeclaration);
  assert.ok(chiefDeclaration.description.includes('- "user-guide":'));
  assert.ok(!chiefDeclaration.description.includes('- "guide":'));
  assert.equal(lastToolResult().isError, false);

  skills = [guide];
  assert.equal(await prompt(), undefined, "Chief has no user-scoped skills");
  chief = false;
  assert.ok(await prompt(), "project skills return outside Chief scope");

  tools = ["load_skill", "codemode"];
  for (const emptyCatalog of [[], [manual]]) {
    skills = emptyCatalog;
    assert.equal(await prompt(), undefined);
    assert.ok(
      !session.getCallableToolNames().includes("load_skill"),
      "empty eligibility removes Code Mode callability",
    );
  }

  tools = ["load_skill", "codemode"];
  skills = [guide];
  await prompt();
  let nextDeclarations: ReturnType<typeof getCurrentTools> = [];
  await prompt(
    fauxToolCall("codemode", { code: 'text("continue after policy change");' }),
    () => {
      session.setActiveToolsByName(["load_skill", "bash", "codemode"]);
    },
    session,
    (declared) => {
      nextDeclarations = declared;
    },
  );
  assert.ok(!nextDeclarations.some(({ name }) => name === "load_skill"));
  const nextCodemode = nextDeclarations.find(({ name }) => name === "codemode");
  assert.ok(nextCodemode);
  assert.ok(!nextCodemode.description.includes('- "guide":'));
  assert.ok(!session.getCallableToolNames().includes("load_skill"));

  tools = ["load_skill"];
  skills = [guide];
  const sentinelSession = await startSession({
    tools: ["load_skill", "grep", "codemode"],
  });
  assert.ok(sentinelSession.getActiveToolNames().includes("grep"));
  await prompt(undefined, undefined, sentinelSession);
  assert.ok(!sentinelSession.getActiveToolNames().includes("grep"));
  skills = [missing];
  const updated = await prompt(
    fauxToolCall("load_skill", { name: "missing" }),
    undefined,
    sentinelSession,
  );
  assert.ok(!sentinelSession.getActiveToolNames().includes("grep"));
  assert.ok(!sentinelSession.getCallableToolNames().includes("grep"));
  assert.ok(updated);
  assert.ok(updated.description.includes('"missing"'));
  assert.ok(!updated.description.includes('"guide"'));
  assert.equal(lastToolResult(sentinelSession).isError, true);
  assert.deepEqual(lastToolResult(sentinelSession).content, [
    { type: "text", text: "Skill file could not be read" },
  ]);

  tools = ["codemode"];
  assert.equal(await prompt(), undefined, "removed by turn policy");

  for (const selection of [
    { tools: ["read"] },
    { excludeTools: ["load_skill"] },
    { tools: ["load_skill"], excludeTools: ["load_skill"] },
  ]) {
    const restricted = await startSession(selection);
    restricted.setActiveToolsByName(["load_skill"]);
    assert.ok(!restricted.getAllTools().some(({ name }) => name === "load_skill"));
    assert.ok(!restricted.getActiveToolNames().includes("load_skill"));
  }
  const managed = await startSession({
    noTools: "all",
    tools: ["load_skill"],
  });
  assert.deepEqual(managed.getActiveToolNames(), ["load_skill"]);
});

test("the loader rejects stale session identity and revoked tool access", async (t) => {
  const { fakeContext, fakePi } = await import("./support.ts");
  const { pi, events, tools } = fakePi({ activeTools: ["load_skill"] });
  registerSkillLoader(pi as unknown as ExtensionAPI);
  const start = events.get("before_agent_start")?.[0];
  assert.ok(start);
  assert.equal(tools[0].defaultActive, true);
  const context = fakeContext();
  await start({ systemPromptOptions: { skills: [testSkill("/unused", "guide")] } }, context);

  for (const [sessionChanged, activeTools] of [
    [true, ["load_skill"]],
    [false, []],
  ] as const) {
    pi.setActiveTools([...activeTools]);
    const executeContext = fakeContext();
    if (sessionChanged) {
      t.mock.method(executeContext.sessionManager, "getSessionId", () => "different-session");
    }
    await assert.rejects(
      tools[0].execute("call", { name: "guide" }, undefined, undefined, executeContext),
      { message: "Skill unavailable in this session" },
    );
  }
});
