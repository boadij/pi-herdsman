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
  await writeFile(guide.filePath, content, "utf8");

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
  const resourceLoader = new DefaultResourceLoader({
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
      (pi) => {
        pi.on("before_agent_start", (event) => {
          if (tools) pi.setActiveTools(tools);
          event.systemPromptOptions.skills = skills;
        });
        registerSkillLoader(pi);
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime,
    model: faux.getModel()!,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["+codemode", "+load_skill", "+grep", "+powershell"],
  });
  t.after(() => session.dispose());

  let declarations: ReturnType<typeof getCurrentTools> = [];
  async function prompt(call?: ReturnType<typeof fauxToolCall>) {
    declarations = [];
    faux.setResponses([
      (context) => {
        declarations = getCurrentTools(context.messages);
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
    "explicit launch selection",
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
});

test("the loader rejects stale session identity and revoked tool access", async (t) => {
  const { fakeContext, fakePi } = await import("./support.ts");
  const { pi, events, tools } = fakePi({ activeTools: ["load_skill"] });
  registerSkillLoader(pi as unknown as ExtensionAPI);
  const start = events.get("before_agent_start")?.[0];
  assert.ok(start);
  assert.equal(tools[0].defaultActive, false);
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
