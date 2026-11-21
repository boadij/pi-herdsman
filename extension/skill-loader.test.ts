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

function testSkill(
  cwd: string,
  name: string,
  disableModelInvocation = false,
): Skill {
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

test("Pi declares the session loader only when needed and disallows nesting", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "herdsman-skill-loader-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const guide = testSkill(cwd, "guide");
  const manual = testSkill(cwd, "manual", true);
  const missing = testSkill(cwd, "missing");
  const content = "---\nname: guide\n---\n# Full skill instructions\n";
  const userGuide = testSkill(cwd, "user-guide");
  userGuide.sourceInfo.scope = "user";
  await Promise.all(
    [guide, userGuide].map(({ filePath }) =>
      writeFile(filePath, content, "utf8"),
    ),
  );

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
  const resourceOptions = {
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
      createCodemodeExtension({ mode: "only" }),
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
  async function startSession(
    selection: Pick<
      NonNullable<Parameters<typeof createAgentSession>[0]>,
      "tools" | "excludeTools" | "noTools"
    > = {},
  ) {
    const resourceLoader = new DefaultResourceLoader(resourceOptions);
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
      () => fauxAssistantMessage("done"),
    ]);
    await session.prompt("Check the session tools.");
    return declarations.find(({ name }) => name === "load_skill");
  }

  function lastToolResult() {
    const result = [...session.agent.state.messages]
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
  await prompt(fauxToolCall("load_skill", { name: "guide" }));
  assert.equal(lastToolResult().isError, true);
  assert.deepEqual(lastToolResult().content, [
    { type: "text", text: "Skill unavailable in this session" },
  ]);

  for (const nonReader of ["grep", "powershell", "codemode"]) {
    tools = ["load_skill", nonReader];
    const declaration = await prompt();
    assert.ok(declaration, nonReader);
    assert.ok(
      declaration.description.includes(
        `- "guide": ${JSON.stringify(guide.description)}`,
      ),
    );
    assert.ok(!declaration.description.includes("manual"));
    assert.ok(!declaration.description.includes(cwd));
  }
  await prompt(fauxToolCall("load_skill", { name: "guide" }));
  assert.equal(lastToolResult().isError, false);
  assert.deepEqual(lastToolResult().content, [
    {
      type: "text",
      text: `Skill: guide\nDirectory: ${guide.baseDir}\n\n${content}`,
    },
  ]);

  assert.ok(!session.getCallableToolNames().includes("load_skill"));
  await prompt(
    fauxToolCall("codemode", {
      code: 'await tools.load_skill({ name: "guide" });',
    }),
  );
  assert.equal(lastToolResult().toolName, "codemode");
  assert.equal(lastToolResult().isError, true);

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
  const beforeChief = await prompt(
    fauxToolCall("load_skill", { name: "guide" }),
    () => {
      chief = true;
    },
  );
  assert.ok(beforeChief?.description.includes('- "guide":'));
  assert.equal(lastToolResult().isError, true);
  assert.deepEqual(lastToolResult().content, [
    { type: "text", text: "Skill unavailable in this session" },
  ]);

  const chiefDeclaration = await prompt(
    fauxToolCall("load_skill", { name: "user-guide" }),
  );
  assert.ok(chiefDeclaration);
  assert.ok(chiefDeclaration.description.includes('- "user-guide":'));
  assert.ok(!chiefDeclaration.description.includes('- "guide":'));
  assert.equal(lastToolResult().isError, false);

  skills = [guide];
  assert.equal(await prompt(), undefined, "Chief has no user-scoped skills");
  chief = false;
  assert.ok(await prompt(), "project skills return outside Chief scope");

  for (const emptyCatalog of [[], [manual]]) {
    skills = emptyCatalog;
    assert.equal(await prompt(), undefined);
  }

  skills = [missing];
  const updated = await prompt(fauxToolCall("load_skill", { name: "missing" }));
  assert.ok(updated);
  assert.ok(updated.description.includes('"missing"'));
  assert.ok(!updated.description.includes('"guide"'));
  assert.equal(lastToolResult().isError, true);
  assert.deepEqual(lastToolResult().content, [
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
    assert.ok(
      !restricted.getAllTools().some(({ name }) => name === "load_skill"),
    );
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
  await start(
    { systemPromptOptions: { skills: [testSkill("/unused", "guide")] } },
    context,
  );

  for (const [sessionChanged, activeTools] of [
    [true, ["load_skill"]],
    [false, []],
  ] as const) {
    pi.setActiveTools([...activeTools]);
    const executeContext = fakeContext();
    if (sessionChanged) {
      t.mock.method(
        executeContext.sessionManager,
        "getSessionId",
        () => "different-session",
      );
    }
    await assert.rejects(
      tools[0].execute(
        "call",
        { name: "guide" },
        undefined,
        undefined,
        executeContext,
      ),
      { message: "Skill unavailable in this session" },
    );
  }
});
