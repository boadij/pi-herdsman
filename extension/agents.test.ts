import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentDefinitionMetadata,
  agentDefinitionEnabled,
  agentLaunchArgs,
  discoverAgent,
  discoverAgentDefinitions,
  expandAgentBodyFiles,
  inferAgentDefinitionTools,
  mergeFrontmatter,
  parseFrontmatter,
  projectAgentDefinition,
  updateAgentOverride,
  validateAgentDefinitionWorkers,
  writePrivatePromptSnapshots,
  type Frontmatter,
} from "./agents.ts";

function withPiAgentDir<T>(agentDir: string, callback: () => T): T {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return callback();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

function discoverAgentDefinitionsWithContents(content: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-invalid-agent-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(join(agents, "custom.md"), content);
  return withPiAgentDir(root, () => discoverAgentDefinitions());
}

test("parses scalar frontmatter fields and applies defaults", () => {
  assert.deepEqual(
    parseFrontmatter(
      '---\nname: "worker"\ninheritSkills: false\n---\n\nPrompt\n',
    ),
    {
      frontmatter: { name: "worker", inheritSkills: false },
      body: "Prompt",
    },
  );
  assert.deepEqual(
    parseFrontmatter("---\nname: worker\nenabled: false\n---\nPrompt"),
    {
      frontmatter: { name: "worker", enabled: false },
      body: "Prompt",
    },
  );
  assert.equal(parseFrontmatter("name: worker"), undefined);
  assert.throws(
    () => parseFrontmatter("---\ninheritSkills: yes\n---"),
    /inheritSkills must be a boolean/,
  );
  assert.deepEqual(
    parseFrontmatter("---\nname: worker\nenabled: true\n---\nPrompt")
      ?.frontmatter,
    { name: "worker", enabled: true },
  );
  for (const value of ["yes", '"false"', "1", "null", "[]", "{}"]) {
    assert.throws(
      () => parseFrontmatter(`---\nenabled: ${value}\n---`),
      /enabled must be a boolean/,
    );
  }
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\nenabled: yes\n---\n",
      ),
    /custom\.md agent custom field enabled: enabled must be a boolean/,
  );

  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-enabled-default-"));
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").frontmatter.enabled),
    true,
  );
});

test("parses inline capability arrays and rejects unsupported fields", () => {
  assert.deepEqual(
    parseFrontmatter(
      '---\ntools: ["read", " grep "]\nexcludeTools: []\nskills: ["./skills/local.md"]\nextensions: ["./extensions/local.ts"]\nworkers: ["scout", "reviewer"]\n---\nPrompt',
    ),
    {
      frontmatter: {
        tools: ["read", " grep "],
        excludeTools: [],
        skills: ["./skills/local.md"],
        extensions: ["./extensions/local.ts"],
        workers: ["scout", "reviewer"],
      },
      body: "Prompt",
    },
  );
  assert.throws(
    () => parseFrontmatter('---\nsubagents: ["scout"]\n---'),
    /subagents is not a supported agent-definition field/,
  );
});

test("resolves whole-line body file references from their definition", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-files-"));
  const agents = join(root, "agents");
  const prompts = join(root, "prompts");
  mkdirSync(agents);
  const definitionPath = join(agents, "custom.md");
  const absolutePath = join(root, "absolute.md");
  mkdirSync(prompts);
  writeFileSync(join(prompts, "one.md"), "one");
  writeFileSync(
    definitionPath,
    `---\nname: custom\n---\nBefore\n@../prompts/one.md\n@./custom.md\n@~/prompts/home.md\n@${absolutePath}\nAfter\n@example`,
  );
  const definition = withPiAgentDir(root, () => discoverAgent("custom"));
  assert.equal(
    definition.body,
    `Before\n@${join(prompts, "one.md")}\n@${join(agents, "custom.md")}\n@${join(homedir(), "prompts", "home.md")}\n@${absolutePath}\nAfter\n@example`,
  );
});

test("normalizes home-relative references in project and global definitions", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-project-agents-"));
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-global-agents-"));
  const projectAgents = join(project, ".pi", "agents");
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(globalAgents);
  writeFileSync(
    join(projectAgents, "project.md"),
    "---\nname: project\n---\n@~/project.md",
  );
  writeFileSync(
    join(globalAgents, "global.md"),
    "---\nname: global\n---\n@~/global.md",
  );

  const definitions = withPiAgentDir(global, () =>
    discoverAgentDefinitions({ projectRoot: project }),
  );
  assert.equal(
    definitions.find(({ name }) => name === "project")?.body,
    `@${join(homedir(), "project.md")}`,
  );
  assert.equal(
    definitions.find(({ name }) => name === "global")?.body,
    `@${join(homedir(), "global.md")}`,
  );
});

test("leaves unsupported home and shell-looking references unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-reference-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "custom.md"),
    "---\nname: custom\n---\n@~user/file\n@$HOME/file\n@${HOME}/file\ninline @~/file",
  );

  assert.equal(
    withPiAgentDir(root, () => discoverAgent("custom")).body,
    "@~user/file\n@$HOME/file\n@${HOME}/file\ninline @~/file",
  );
});

test("merges scalars, arrays, false, and nested inline objects", () => {
  assert.deepEqual(
    mergeFrontmatter(
      {
        name: "worker",
        model: "base/model",
        noTools: true,
        tools: ["read"],
        skills: ["base"],
        options: { keep: true, nested: { base: true, shared: "base" } },
      },
      {
        name: "worker",
        model: "override/model",
        noTools: false,
        tools: [],
        skills: ["override"],
        options: { nested: { shared: "override", added: false } },
      },
    ),
    {
      name: "worker",
      model: "override/model",
      noTools: false,
      tools: [],
      skills: ["override"],
      options: {
        keep: true,
        nested: { base: true, shared: "override", added: false },
      },
    },
  );
});

test("rejects malformed capability fields", () => {
  for (const [field, value, message] of [
    ["tools", '"read"', /tools must be an inline array/],
    ["excludeTools", "[", /excludeTools must be an inline array/],
    ["skills", '["ok", 1]', /skills must be an inline array/],
    ["extensions", '[""]', /extensions must be an inline array/],
    [
      "systemPromptFiles",
      '["prompt.md"]',
      /systemPromptFiles is not a supported agent-definition field/,
    ],
    ["tools", '["   "]', /tools must be an inline array/],
    ["workers", '"scout"', /workers must be an inline array/],
    ["workers", '["scout", 1]', /workers must be an inline array/],
    ["workers", '["   "]', /workers must be an inline array/],
    [
      "workers",
      '["scout", "scout"]',
      /workers must be an inline array of unique non-empty strings/,
    ],
    ["noTools", '"true"', /noTools must be a boolean/],
    ["noBuiltinTools", "yes", /noBuiltinTools must be a boolean/],
    ["noSkills", "1", /noSkills must be a boolean/],
    ["noExtensions", '"false"', /noExtensions must be a boolean/],
    ["enabled", '"false"', /enabled must be a boolean/],
    ["enabled", "yes", /enabled must be a boolean/],
    ["enabled", "1", /enabled must be a boolean/],
    ["enabled", "null", /enabled must be a boolean/],
    [
      "inheritGlobalContext",
      '"false"',
      /inheritGlobalContext must be a boolean/,
    ],
    ["inheritGlobalContext", "1", /inheritGlobalContext must be a boolean/],
    ["inheritGlobalContext", "yes", /inheritGlobalContext must be a boolean/],
  ] as const)
    assert.throws(
      () => parseFrontmatter(`---\n${field}: ${value}\n---`),
      message,
    );
  for (const [field, value, message] of [
    ["model", "[]", /model.*must be a non-empty string/],
    ["model", "[", /model.*must be a string/],
    ["thinking", "1", /thinking.*must be one of/],
    [
      "systemPromptMode",
      "false",
      /systemPromptMode.*must be append or replace/,
    ],
    ["bodyMode", "merge", /bodyMode.*must be append or replace/],
  ] as const)
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\n${field}: ${value}\n---\n`,
        ),
      message,
    );
});

test("selects global and project context independently in native order", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-context-"));
  const agentDir = join(root, "custom-agent-dir");
  const project = join(root, "project");
  const cwd = join(project, "nested");
  mkdirSync(agentDir);
  mkdirSync(cwd, { recursive: true });
  const global = join(agentDir, "AGENTS.md");
  const outer = join(project, "AGENTS.md");
  const inner = join(cwd, "AGENTS.md");
  writeFileSync(global, "Global");
  writeFileSync(outer, "Outer");
  writeFileSync(inner, "Inner");

  assert.equal(
    parseFrontmatter("---\ninheritGlobalContext: false\n---")?.frontmatter
      .inheritGlobalContext,
    false,
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const launch = (
      name: string,
      frontmatter: Record<string, string | boolean>,
    ) =>
      agentLaunchArgs(
        { name, path: "/agent.md", frontmatter, body: "Prompt" },
        { bodyPromptPath: "/prompt", cwd },
      );
    const noContext = ["--no-context-files"];
    const append = (path: string) => ["--append-system-prompt", path];
    const noSkills = ["--no-skills"];

    assert.deepEqual(launch("worker", {}), [
      "--system-prompt",
      "/prompt",
      ...noContext,
      ...noSkills,
    ]);
    assert.deepEqual(launch("delegate", {}), [
      "--append-system-prompt",
      "/prompt",
      ...noSkills,
    ]);
    for (const systemPromptMode of ["replace", "append"] as const) {
      const prompt = [
        systemPromptMode === "replace"
          ? "--system-prompt"
          : "--append-system-prompt",
        "/prompt",
      ];
      for (const [frontmatter, contexts] of [
        [{ inheritProjectContext: true, inheritGlobalContext: true }, []],
        [
          { inheritProjectContext: true, inheritGlobalContext: false },
          [...noContext, ...append(outer), ...append(inner)],
        ],
        [
          { inheritProjectContext: false, inheritGlobalContext: true },
          [...noContext, ...append(global)],
        ],
        [
          { inheritProjectContext: false, inheritGlobalContext: false },
          noContext,
        ],
      ] as const)
        assert.deepEqual(
          launch("worker", { ...frontmatter, systemPromptMode }),
          [...prompt, ...contexts, ...noSkills],
        );
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("discovers the five portable bundled definitions without a user agents directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agents-"));
  assert.deepEqual(
    withPiAgentDir(root, () =>
      discoverAgentDefinitions().map((definition) => definition.name),
    ),
    ["generalist", "implementer", "researcher", "reviewer", "scout"],
  );
});

test("bundled definitions carry portable capabilities and role contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-bundled-prompts-"));
  const definitions = withPiAgentDir(root, () => discoverAgentDefinitions());
  const expectedTools = new Map([
    ["implementer", ["read", "bash", "edit", "write", "worker"]],
    [
      "researcher",
      [
        "read",
        "ls",
        "find",
        "grep",
        "web_search",
        "fetch_content",
        "get_search_content",
        "source_check",
      ],
    ],
    ["reviewer", ["read", "ls", "find", "grep", "worker"]],
    ["scout", ["read", "ls", "find", "grep"]],
    ["generalist", ["read", "bash", "edit", "write", "worker"]],
  ]);
  const required = withPiAgentDir(
    root,
    () =>
      new Map(
        ["generalist", "implementer", "researcher", "reviewer", "scout"].map(
          (name) =>
            [name, discoverAgent(name).body.replaceAll(/\s+/g, " ")] as const,
        ),
      ),
  );
  assert.equal(required.size, 5);
  for (const definition of definitions) {
    assert.deepEqual(
      definition.frontmatter.tools,
      expectedTools.get(definition.name),
    );
    assert.deepEqual(definition.frontmatter.skills, []);
    if (definition.name === "researcher")
      assert.equal(definition.frontmatter.extensions, undefined);
    else assert.deepEqual(definition.frontmatter.extensions, []);
    assert.doesNotMatch(readFileSync(definition.path, "utf8"), /Users\/jeff/);
    if (definition.frontmatter.workers?.length)
      assert.doesNotMatch(
        readFileSync(definition.path, "utf8"),
        /tools:.*worker/,
      );
    assert.doesNotMatch(
      definition.body,
      /\b(exec|wait|mcp)\b|tools\.|Ponytail|Code Mode/i,
    );
  }
  assert.match(required.get("implementer")!, /scoped edits and validation/);
  assert.match(required.get("generalist")!, /smallest complete action/);
  assert.match(required.get("reviewer")!, /strictly read-only/);
  assert.match(required.get("scout")!, /read-only codebase reconnaissance/);
  assert.match(
    required.get("researcher")!,
    /prefer official and primary sources.*active capabilities/i,
  );
  assert.match(required.get("researcher")!, /Do not mutate files/);
  for (const name of ["generalist", "implementer", "reviewer"])
    assert.doesNotMatch(required.get(name)!, /delegate|orchestrat/i);
  assert.equal(
    definitions.filter((definition) => required.has(definition.name)).length,
    5,
  );
});

test("enforces read-only managed launch policies and reviewer leaf projection", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-audit-policy-"));
  const expected = new Map([
    ["scout", ["read", "ls", "find", "grep", "ask_owner"]],
    [
      "researcher",
      [
        "read",
        "ls",
        "find",
        "grep",
        "web_search",
        "fetch_content",
        "get_search_content",
        "source_check",
        "ask_owner",
      ],
    ],
    ["reviewer", ["read", "ls", "find", "grep", "worker", "ask_owner"]],
  ]);
  const forbidden = ["bash", "powershell", "edit", "write"];

  withPiAgentDir(root, () => {
    for (const [name, tools] of expected) {
      const definition = projectAgentDefinition(
        discoverAgent(name),
        "delegating",
      );
      const args = agentLaunchArgs(definition, {
        bodyPromptPath: "/tmp/prompt.txt",
        cwd: process.cwd(),
        managedWorker: true,
      });
      const toolsIndex = args.indexOf("--tools");
      assert.notEqual(toolsIndex, -1);
      assert.deepEqual(args[toolsIndex + 1].split(","), tools);
      const launchedTools = args.flatMap((arg) => arg.split(","));
      for (const tool of forbidden)
        assert.equal(launchedTools.includes(tool), false);
      assert.equal(args.includes("npm:pi-web-access"), false);
      if (name === "researcher") {
        assert.equal(definition.frontmatter.noExtensions, undefined);
        assert.equal(args.includes("--no-extensions"), false);
      } else assert.equal(args.includes("--no-extensions"), true);
    }

    const reviewer = projectAgentDefinition(discoverAgent("reviewer"), "leaf");
    const args = agentLaunchArgs(reviewer, {
      bodyPromptPath: "/tmp/prompt.txt",
      cwd: process.cwd(),
      managedWorker: true,
    });
    const toolsIndex = args.indexOf("--tools");
    assert.deepEqual(args[toolsIndex + 1].split(","), [
      "read",
      "ls",
      "find",
      "grep",
      "ask_owner",
    ]);
    assert.equal(
      args.flatMap((arg) => arg.split(",")).includes("worker"),
      false,
    );
  });
});

test("does not bundle the operator-local MCP runner", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-mcp-runner-agent-"));
  assert.deepEqual(
    withPiAgentDir(root, () =>
      discoverAgentDefinitions().map(({ name }) => name),
    ),
    ["generalist", "implementer", "researcher", "reviewer", "scout"],
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgent("mcp-runner")),
    /agent mcp-runner not found/,
  );
});

test("composes matching bundled bodies with bodyMode", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-mode-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const base = withPiAgentDir(root, () => discoverAgent("scout").body);

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\n---\nCustom scout instructions.",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    "Custom scout instructions.",
  );

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: replace\n---\nReplacement.",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    "Replacement.",
  );

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: append\n---\nAdditional instructions.",
  );
  const appended = withPiAgentDir(root, () => discoverAgent("scout"));
  assert.equal(appended.body, `${base}\n\nAdditional instructions.`);
  assert.equal(appended.frontmatter.bodyMode, undefined);

  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: append\n---\n",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    base,
  );
  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\nbodyMode: replace\n---\n",
  );
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").body),
    base,
  );
  const promptRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-body-mode-prompt-"),
  );
  const promptAgents = join(promptRoot, "agents");
  mkdirSync(promptAgents);
  writeFileSync(
    join(promptAgents, "scout.md"),
    "---\nname: scout\nbodyMode: append\nsystemPromptMode: append\n---\nExtra.",
  );
  const definition = withPiAgentDir(promptRoot, () => discoverAgent("scout"));
  assert.equal(definition.frontmatter.bodyMode, undefined);
  assert.equal(definition.frontmatter.systemPromptMode, "append");
  assert.match(definition.body, /\n\nExtra\.$/);
  const invalidRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-body-mode-invalid-"),
  );
  const invalidAgents = join(invalidRoot, "agents");
  mkdirSync(invalidAgents);
  const overridePath = join(invalidAgents, "scout.md");
  writeFileSync(overridePath, "---\nname: scout\nbodyMode: merge\n---\nExtra.");
  assert.throws(
    () => withPiAgentDir(invalidRoot, () => discoverAgent("scout")),
    new RegExp(
      `${overridePath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} agent scout field bodyMode: must be append or replace`,
    ),
  );
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\nbodyMode: append\n---\nCustom",
      ),
    /custom\.md agent custom field bodyMode: only valid when overlaying an existing agent/,
  );
});

test("discovers trusted project definitions and gives global overlays final precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-project-agents-"));
  const projectAgents = join(root, ".pi", "agents");
  mkdirSync(projectAgents, { recursive: true });
  writeFileSync(
    join(projectAgents, "project.md"),
    "---\nname: project-only\nmodel: project-model\n---\nProject policy",
  );
  const globalRoot = mkdtempSync(join(tmpdir(), "pi-herdsman-project-global-"));
  const globalAgents = join(globalRoot, "agents");
  mkdirSync(globalAgents);
  writeFileSync(
    join(globalAgents, "project.md"),
    "---\nname: project-only\nmodel: global-model\n---\nGlobal policy",
  );
  const definition = withPiAgentDir(globalRoot, () =>
    discoverAgent("project-only", { projectRoot: root }),
  );
  assert.equal(definition.frontmatter.model, "global-model");
  assert.equal(definition.projectSource, join(projectAgents, "project.md"));
  assert.equal(definition.overrideSource, join(globalAgents, "project.md"));
  assert.equal(definition.body, "Global policy");
});

test("project discovery tolerates a missing directory and rejects a file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-project-root-"));
  withPiAgentDir(root, () => {
    assert.deepEqual(
      discoverAgentDefinitions({ projectRoot: root }).some(
        (d) => d.projectSource,
      ),
      false,
    );
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents"), "not a directory");
    assert.throws(
      () => discoverAgentDefinitions({ projectRoot: root }),
      /agent directory is not a directory/,
    );
  });
});

test("project approval is emitted only when requested", () => {
  const agent = { name: "test", path: "test", frontmatter: {}, body: "" };
  assert.deepEqual(agentLaunchArgs(agent, {}).includes("--approve"), false);
  assert.deepEqual(
    agentLaunchArgs(agent, { approveProject: true }).includes("--approve"),
    true,
  );
});

test("composes all definition layers with provenance and whole-array replacement", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-layered-project-"));
  const projectAgents = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-layered-global-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(globalAgents);
  const bundled = withPiAgentDir(global, () => discoverAgent("reviewer"));
  const projectPath = join(projectAgents, "reviewer.md");
  const globalPath = join(globalAgents, "reviewer.md");
  writeFileSync(
    projectPath,
    '---\nname: reviewer\nmodel: project/model\ntools: ["read", "grep"]\nbodyMode: append\n---\nProject policy',
  );
  writeFileSync(
    globalPath,
    '---\nname: reviewer\nmodel: global/model\nthinking: high\ntools: ["read"]\nbodyMode: append\n---\nGlobal policy',
  );
  const effective = withPiAgentDir(global, () =>
    discoverAgent("reviewer", { projectRoot: project }),
  );
  assert.equal(effective.frontmatter.model, "global/model");
  assert.equal(effective.frontmatter.thinking, "high");
  assert.deepEqual(effective.frontmatter.tools, ["read", "worker"]);
  assert.equal(
    effective.body,
    `${bundled.body}\n\nProject policy\n\nGlobal policy`,
  );
  assert.equal(effective.extensionSource, bundled.path);
  assert.equal(effective.projectSource, projectPath);
  assert.equal(effective.overrideSource, globalPath);
});

test("project body modes, duplicate names, body-file provenance, and child validation use the shared engine", () => {
  const project = mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-validation-"),
  );
  const projectAgents = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-global-validation-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(globalAgents);

  const standalone = join(projectAgents, "standalone.md");
  writeFileSync(
    standalone,
    "---\nname: standalone\nbodyMode: append\n---\nbody",
  );
  assert.throws(
    () => discoverAgentDefinitions({ projectRoot: project }),
    new RegExp(
      `${standalone.replaceAll(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}.*bodyMode`,
    ),
  );
  unlinkSync(standalone);

  writeFileSync(
    join(projectAgents, "child.md"),
    "---\nname: child\n---\nchild",
  );
  writeFileSync(
    join(projectAgents, "parent.md"),
    '---\nname: parent\nworkers: ["child"]\n---\nparent',
  );
  writeFileSync(
    join(projectAgents, "body.md"),
    "---\nname: scout\nbodyMode: append\n---\n@./policy.txt",
  );
  writeFileSync(join(projectAgents, "policy.txt"), "project policy");
  writeFileSync(
    join(globalAgents, "body.md"),
    "---\nname: scout\nbodyMode: append\n---\n@./policy.txt",
  );
  writeFileSync(join(globalAgents, "policy.txt"), "global policy");
  const definitions = withPiAgentDir(global, () =>
    discoverAgentDefinitions({ projectRoot: project }),
  );
  const body = definitions.find((definition) => definition.name === "scout")!;
  assert.match(
    body.body,
    new RegExp(
      join(projectAgents, "policy.txt").replaceAll(
        /[.*+?^${}()|[\\]\\]/g,
        "\\\\$&",
      ),
    ),
  );
  assert.match(
    body.body,
    new RegExp(
      join(globalAgents, "policy.txt").replaceAll(
        /[.*+?^${}()|[\\]\\]/g,
        "\\\\$&",
      ),
    ),
  );
  validateAgentDefinitionWorkers(
    definitions.find((definition) => definition.name === "parent")!,
    definitions,
  );
  assert.equal(
    inferAgentDefinitionTools({
      ...definitions.find((definition) => definition.name === "parent")!,
      frontmatter: {
        ...definitions.find((definition) => definition.name === "parent")!
          .frontmatter,
        tools: ["read"],
      },
    }).projectSource,
    join(projectAgents, "parent.md"),
  );

  const duplicate = join(projectAgents, "nested");
  mkdirSync(duplicate);
  writeFileSync(
    join(duplicate, "child.md"),
    "---\nname: child\n---\nduplicate",
  );
  assert.throws(
    () => discoverAgentDefinitions({ projectRoot: project }),
    /multiple definitions found for agent child/,
  );
});

test("overlays a bundled definition and extends the roster", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agents-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const overridePath = join(agents, "implementer.md");
  const override =
    "---\nname: implementer\ndescription: User implementation\nnoTools: true\n---\nUser prompt";
  writeFileSync(overridePath, override);
  writeFileSync(
    join(agents, "custom.md"),
    '---\nname: custom\nworkers: ["researcher"]\n---\nCustom prompt',
  );

  withPiAgentDir(root, () => {
    const definitions = discoverAgentDefinitions();
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      [
        "custom",
        "generalist",
        "implementer",
        "researcher",
        "reviewer",
        "scout",
      ],
    );
    const implementer = discoverAgent("implementer");
    assert.equal(implementer.path, overridePath);
    assert.match(
      implementer.extensionSource!,
      /extension\/agent-definitions\/implementer\.md$/,
    );
    assert.equal(implementer.overrideSource, overridePath);
    assert.equal(implementer.frontmatter.description, "User implementation");
    assert.equal(implementer.frontmatter.model, "openai-codex/gpt-5.6-luna");
    assert.equal(implementer.frontmatter.noTools, true);
    assert.equal(implementer.frontmatter.noSkills, true);
    assert.equal(implementer.body, "User prompt");
  });
});

test("merges enabled overrides and validates disabled children without hiding the root roster", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-enabled-override-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "reviewer.md"),
    "---\nname: reviewer\nenabled: false\n---\n",
  );
  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nworkers: ["reviewer"]\n---\nParent',
  );

  withPiAgentDir(root, () => {
    const definitions = discoverAgentDefinitions();
    const reviewer = definitions.find(({ name }) => name === "reviewer")!;
    const parent = definitions.find(({ name }) => name === "parent")!;
    assert.equal(reviewer.frontmatter.enabled, false);
    assert.equal(agentDefinitionEnabled(reviewer), false);
    assert.equal(agentDefinitionMetadata(reviewer).enabled, false);
    assert.throws(
      () => validateAgentDefinitionWorkers(parent, definitions),
      /agent parent references disabled worker reviewer; enable reviewer/,
    );
    assert.equal(
      definitions.some(({ name }) => name === "reviewer"),
      true,
    );
  });
});

test("validates user duplicates and merged worker references", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-"));
  const agents = join(root, "agents");
  mkdirSync(join(agents, "nested"), { recursive: true });
  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nworkers: ["child"]\n---\nParent',
  );
  writeFileSync(
    join(agents, "child.md"),
    '---\nname: child\nworkers: ["parent"]\n---\nChild',
  );
  writeFileSync(
    join(agents, "nested", "parent.md"),
    "---\nname: parent\n---\nDuplicate",
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgentDefinitions()),
    /multiple definitions found for agent parent/,
  );

  unlinkSync(join(agents, "nested", "parent.md"));
  assert.deepEqual(
    withPiAgentDir(root, () => discoverAgent("reviewer").frontmatter.workers),
    ["scout", "researcher"],
  );
  assert.deepEqual(
    withPiAgentDir(root, () => discoverAgentDefinitions())
      .filter(({ name }) => name === "parent" || name === "child")
      .map(({ name }) => name),
    ["child", "parent"],
  );

  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nworkers: ["missing"]\n---\nParent',
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgentDefinitions()),
    /agent parent references missing worker missing/,
  );
});

test("keeps a bundled parent valid when its child is overridden", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  writeFileSync(
    join(agents, "scout.md"),
    "---\nname: scout\ndescription: Overridden scout\n---\nScout",
  );
  assert.equal(
    withPiAgentDir(
      root,
      () => discoverAgent("reviewer").frontmatter.workers,
    )?.includes("scout"),
    true,
  );
});

test("transports complex prompts through a private temporary file", () => {
  const body = "line 1\nquotes \" ' $ `\nUnicode: café 🦊\nline 4";
  const [promptPath] = writePrivatePromptSnapshots([body]);
  try {
    assert.equal(readFileSync(promptPath, "utf8"), body);
    assert.equal(statSync(promptPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(tmpdir(), "pi-herdsman")).mode & 0o777, 0o700);
    assert.equal(
      statSync(
        join(
          tmpdir(),
          "pi-herdsman",
          String(process.getuid?.() ?? "user"),
          "prompts",
        ),
      ).mode & 0o777,
      0o700,
    );
    const launch = agentLaunchArgs(
      {
        name: "delegate",
        path: "/agents/delegate.md",
        frontmatter: { name: "delegate", systemPromptMode: "append" },
        body,
      },
      { bodyPromptPath: promptPath },
    );
    assert.deepEqual(launch, [
      "--append-system-prompt",
      promptPath,
      "--no-skills",
    ]);
  } finally {
    unlinkSync(promptPath);
  }
  assert.throws(() => statSync(promptPath), /ENOENT/);
});

test("writes ordered private prompt snapshots with private permissions", () => {
  const paths = writePrivatePromptSnapshots(["body", "append"]);
  try {
    assert.deepEqual(
      paths.map((path) => readFileSync(path, "utf8")),
      ["body", "append"],
    );
    assert.deepEqual(
      paths.map((path) => statSync(path).mode & 0o777),
      [0o600, 0o600],
    );
  } finally {
    for (const path of paths) unlinkSync(path);
  }
});

test("builds exact Pi capability launch arguments", () => {
  const agent = {
    name: "delegate",
    path: "/agents/delegate.md",
    frontmatter: {
      name: "delegate",
      model: "model-a",
      thinking: false,
      inheritSkills: false,
      fallbackModels: true,
      noTools: true,
      noBuiltinTools: false,
      tools: ["read", " grep "],
      excludeTools: ["bash", "write"],
      noSkills: false,
      skills: ["./skills/local.md", "/skills/shared.md"],
      noExtensions: true,
      extensions: ["./extensions/local.ts", "/extensions/shared.ts"],
    },
    body: "Use this prompt",
  };
  const promptPath = "/tmp/prompt.txt";
  assert.deepEqual(agentLaunchArgs(agent, { bodyPromptPath: promptPath }), [
    "--model",
    "model-a",
    "--thinking",
    "off",
    "--append-system-prompt",
    promptPath,
    "--no-tools",
    "--tools",
    "read, grep ",
    "--exclude-tools",
    "bash,write",
    "--skill",
    "./skills/local.md",
    "--skill",
    "/skills/shared.md",
    "--no-extensions",
    "--extension",
    "./extensions/local.ts",
    "--extension",
    "/extensions/shared.ts",
  ]);
});

test("appends the shared prompt after context additions", () => {
  assert.deepEqual(
    agentLaunchArgs(
      {
        name: "worker",
        path: "/worker.md",
        frontmatter: { systemPromptMode: "replace" },
        body: "body",
      },
      {
        bodyPromptPath: "/body",
        sharedPromptPath: "/shared",
      },
    ),
    [
      "--system-prompt",
      "/body",
      "--no-context-files",
      "--append-system-prompt",
      "/shared",
      "--no-skills",
    ],
  );
});

test("requires a body prompt path for body-bearing agents", () => {
  assert.throws(
    () =>
      agentLaunchArgs(
        {
          name: "worker",
          path: "/worker.md",
          frontmatter: {},
          body: "body",
        },
        {},
      ),
    /agent worker has a body but no bodyPromptPath was provided/,
  );
});

test("bundled generalist definition retains its declared tool policy", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-worker-policy-"));
  const generalist = withPiAgentDir(root, () => discoverAgent("generalist"));
  assert.equal(generalist.frontmatter.noExtensions, true);
  assert.deepEqual(generalist.frontmatter.tools, [
    "read",
    "bash",
    "edit",
    "write",
    "worker",
  ]);
  const args = agentLaunchArgs(generalist, {
    bodyPromptPath: "/tmp/prompt.txt",
    cwd: process.cwd(),
    managedWorker: true,
  });
  const tools = args.indexOf("--tools");
  assert.notEqual(tools, -1);
  assert.equal(args[tools + 1], "read,bash,edit,write,worker,ask_owner");
});

test("managed launch policy always includes ask_owner", () => {
  const launch = (frontmatter: Record<string, unknown>) =>
    agentLaunchArgs(
      { name: "worker", path: "/worker.md", frontmatter, body: "" },
      {
        bodyPromptPath: "/prompt",
        cwd: process.cwd(),
        managedWorker: true,
      },
    );
  const cases = [
    [{ tools: ["read", " ask_owner", "read"] }, ["--tools", "read,ask_owner"]],
    [{ noTools: true }, ["--no-tools", "--tools", "ask_owner"]],
    [
      { noTools: true, tools: ["read"] },
      ["--no-tools", "--tools", "read,ask_owner"],
    ],
    [
      { noBuiltinTools: true, excludeTools: ["write", "ask_owner"] },
      ["--no-builtin-tools", "--exclude-tools", "write"],
    ],
    [{}, []],
  ] as const;
  for (const [frontmatter, expected] of cases) {
    const args = launch(frontmatter);
    if (expected.length) {
      const start = args.indexOf(expected[0]);
      assert.notEqual(start, -1);
      assert.deepEqual(args.slice(start, start + expected.length), expected);
    }
    assert.equal(
      args.flatMap((arg) => arg.split(",")).filter((arg) => arg === "ask_owner")
        .length,
      expected.some((arg) => arg.split(",").includes("ask_owner")) ? 1 : 0,
    );
  }
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-worker-standalone-"));
  const standalone = withPiAgentDir(root, () => discoverAgent("generalist"));
  assert.match(standalone.path, /agent-definitions\/generalist\.md$/);
  assert.equal(
    agentLaunchArgs(standalone, {
      bodyPromptPath: "/prompt",
      cwd: process.cwd(),
      managedWorker: true,
    })
      .flatMap((arg) => arg.split(","))
      .filter((arg) => arg === "ask_owner").length,
    1,
  );
});

test("applies explicit noSkills before inheritSkills defaults", () => {
  const launch = (frontmatter: Record<string, string | boolean>) =>
    agentLaunchArgs(
      { name: "worker", path: "/worker.md", frontmatter, body: "" },
      { bodyPromptPath: "/prompt" },
    );
  assert.deepEqual(launch({}), ["--no-context-files", "--no-skills"]);
  assert.deepEqual(launch({ inheritSkills: true }), ["--no-context-files"]);
  assert.deepEqual(launch({ inheritSkills: "true" }), [
    "--no-context-files",
    "--no-skills",
  ]);
  assert.deepEqual(launch({ inheritSkills: true, noSkills: true }), [
    "--no-context-files",
    "--no-skills",
  ]);
  assert.deepEqual(launch({ inheritSkills: false, noSkills: false }), [
    "--no-context-files",
  ]);
});

test("passes native capability combinations through to Pi", () => {
  assert.deepEqual(
    agentLaunchArgs(
      {
        name: "worker",
        path: "/worker.md",
        frontmatter: {
          inheritProjectContext: true,
          noTools: true,
          noBuiltinTools: true,
          noSkills: true,
          skills: ["explicit-skill"],
          noExtensions: true,
          extensions: ["explicit-extension"],
        },
        body: "",
      },
      { bodyPromptPath: "/prompt" },
    ),
    [
      "--no-tools",
      "--no-builtin-tools",
      "--no-skills",
      "--skill",
      "explicit-skill",
      "--no-extensions",
      "--extension",
      "explicit-extension",
    ],
  );
});

test("preserves current definition metadata", () => {
  const agent = {
    name: "worker",
    path: "/agents/worker.md",
    frontmatter: {
      name: "worker",
      description: "A worker",
    },
    body: "",
  };
  assert.deepEqual(agentDefinitionMetadata(agent), {
    name: "worker",
    description: "A worker",
  });
  const configured = agentDefinitionMetadata({
    name: "reviewer",
    path: "/agents/reviewer.md",
    frontmatter: { model: "provider/model", thinking: "high" },
    body: "",
  });
  assert.deepEqual(configured, {
    name: "reviewer",
    model: "provider/model",
    thinking: "high",
  });
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "worker",
      path: "/agents/worker.md",
      frontmatter: { thinking: false },
      body: "",
    }),
    { name: "worker", thinking: "off" },
  );
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "worker",
      path: "/agents/worker.md",
      frontmatter: {},
      body: "",
    }),
    { name: "worker" },
  );
  const capabilityAgent = {
    name: "reviewer",
    path: "/agents/reviewer.md",
    frontmatter: {
      name: "reviewer",
      description: "Read-only review",
      noTools: false,
      noBuiltinTools: true,
      tools: ["read", "grep"],
      excludeTools: ["write"],
      noSkills: false,
      inheritSkills: true,
      skills: ["./skills/review.md"],
    },
    body: "",
  };
  assert.deepEqual(agentDefinitionMetadata(capabilityAgent), {
    name: "reviewer",
    description: "Read-only review",
    noTools: false,
    noBuiltinTools: true,
    tools: ["read", "grep"],
    excludeTools: ["write"],
    noSkills: false,
    inheritSkills: true,
    skills: ["./skills/review.md"],
  });
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "implementer",
      path: "/agents/implementer.md",
      frontmatter: { workers: ["scout", "reviewer"] },
      body: "",
    }),
    { name: "implementer", workers: ["scout", "reviewer"] },
  );
});

test("expands body references with caller precedence and no recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-body-expand-"));
  const nested = join(root, "nested.md");
  const included = join(root, "included.md");
  writeFileSync(nested, "@./ignored.md");
  writeFileSync(included, "included\n@./nested.md");
  assert.equal(
    expandAgentBodyFiles(
      `before\n@${included}\n@${included}\nafter`,
      [],
      "assign",
    ),
    "before\nincluded\n@./nested.md\n\nafter",
  );
  assert.equal(
    expandAgentBodyFiles(`@${included}`, [realpathSync(included)], "assign"),
    "",
  );
});

test("infers worker only when native policy permits it", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-tool-inference-"));
  const definitions = withPiAgentDir(root, () => discoverAgentDefinitions());
  const effective = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  assert.deepEqual(effective.get("implementer")?.frontmatter.tools, [
    "read",
    "bash",
    "edit",
    "write",
    "worker",
  ]);
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "parent",
      path: "/parent.md",
      frontmatter: { workers: ["child"], tools: ["read"] },
      body: "",
    }),
    { name: "parent", workers: ["child"], tools: ["read"] },
  );
  const make = (frontmatter: Frontmatter) =>
    agentLaunchArgs(
      inferAgentDefinitionTools({
        name: "parent",
        path: "/parent.md",
        frontmatter,
        body: "",
      }),
      { managedWorker: true },
    );
  assert.deepEqual(
    make({ workers: ["child"], tools: ["read", "worker"] }).filter(
      (v) => v === "--tools" || v.includes("read"),
    ),
    ["--tools", "read,worker,ask_owner"],
  );
  assert.deepEqual(
    make({
      workers: ["child"],
      tools: ["read"],
      excludeTools: ["worker"],
    }).filter(
      (v) =>
        v === "--tools" ||
        v.startsWith("read") ||
        v === "--exclude-tools" ||
        v === "worker",
    ),
    ["--tools", "read,ask_owner", "--exclude-tools", "worker"],
  );
  assert.deepEqual(
    make({ workers: ["child"], noTools: true }).filter(
      (v) => v === "--tools" || v === "ask_owner",
    ),
    ["--tools", "ask_owner"],
  );
});

test("projects parent-launched definitions as exact leaf capabilities", () => {
  const definition = inferAgentDefinitionTools({
    name: "parent",
    path: "/parent.md",
    frontmatter: {
      workers: ["scout"],
      tools: ["read,worker", "bash"],
      excludeTools: ["write"],
    },
    body: "",
  });
  const leaf = projectAgentDefinition(definition, "leaf");
  assert.equal(leaf.frontmatter.workers, undefined);
  assert.deepEqual(leaf.frontmatter.tools, ["read", "bash"]);
  assert.deepEqual(agentDefinitionMetadata(definition, "leaf"), {
    name: "parent",
    tools: ["read", "bash"],
    excludeTools: ["write"],
  });
  assert.deepEqual(
    agentLaunchArgs(leaf, { managedWorker: true }).filter(
      (value) => value === "--tools" || value.includes("ask_owner"),
    ),
    ["--tools", "read,bash,ask_owner"],
  );
  const empty = projectAgentDefinition(
    {
      name: "empty",
      path: "/empty.md",
      frontmatter: { workers: ["scout"], tools: [] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(empty.frontmatter.tools, []);
  assert.equal(empty.frontmatter.workers, undefined);
  const denied = projectAgentDefinition(
    {
      name: "denied",
      path: "/denied.md",
      frontmatter: {
        workers: ["scout"],
        tools: ["read", "worker"],
        excludeTools: ["worker"],
      },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(denied.frontmatter.tools, ["read"]);
  assert.deepEqual(denied.frontmatter.excludeTools, ["worker"]);
  const delegationOnlyLeaf = projectAgentDefinition(
    {
      name: "parent",
      path: "/parent.md",
      frontmatter: { workers: ["scout"], tools: ["worker"] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(
    agentLaunchArgs(delegationOnlyLeaf, { managedWorker: true }),
    ["--no-context-files", "--no-tools", "--tools", "ask_owner", "--no-skills"],
  );
  const omittedToolsLeaf = projectAgentDefinition(
    inferAgentDefinitionTools({
      name: "parent",
      path: "/parent.md",
      frontmatter: { workers: ["scout"] },
      body: "",
    }),
    "leaf",
  );
  assert.equal(omittedToolsLeaf.frontmatter.workers, undefined);
  assert.equal(omittedToolsLeaf.frontmatter.tools, undefined);
  assert.equal(
    agentLaunchArgs(omittedToolsLeaf, { managedWorker: true }).includes(
      "worker",
    ),
    false,
  );
});

test("merges effective frontmatter and preserves narrow override mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-overrides-"));
  const agents = join(root, "agents");
  mkdirSync(agents);
  const path = join(agents, "reviewer.md");
  const original =
    "---\r\nname: reviewer\r\nmodel: old/model\r\nthinking: low\r\ndescription: keep\r\nbodyMode: append\r\n---\r\n\r\nKeep this body.\r\n";
  writeFileSync(path, original);
  const overrideDefinition = {
    name: "reviewer",
    path,
    overrideSource: path,
    extensionSource: "/bundled/reviewer.md",
    frontmatter: { name: "reviewer", model: "old/model", thinking: "low" },
    body: "Keep this body.",
  } as const;
  const set = withPiAgentDir(root, () =>
    updateAgentOverride(overrideDefinition, "model", "provider/model"),
  );
  assert.equal(set.changed, true);
  assert.equal(
    readFileSync(path, "utf8"),
    "---\r\nname: reviewer\r\nthinking: low\r\ndescription: keep\r\nbodyMode: append\r\nmodel: provider/model\r\n---\r\n\r\nKeep this body.\r\n",
  );
  const reset = withPiAgentDir(root, () =>
    updateAgentOverride(
      {
        ...overrideDefinition,
        frontmatter: {
          ...overrideDefinition.frontmatter,
          model: "provider/model",
        },
      },
      "model",
      undefined,
    ),
  );
  assert.equal(reset.changed, true);
  assert.equal(
    readFileSync(path, "utf8"),
    original.replace("model: old/model\r\n", ""),
  );
  const createRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-override-create-"),
  );
  const createDefinition = {
    name: "custom/name",
    path: "/bundled/custom.md",
    extensionSource: "/bundled/custom.md",
    frontmatter: { name: "custom/name" },
    body: "",
  } as const;
  const result = withPiAgentDir(createRoot, () =>
    updateAgentOverride(createDefinition, "thinking", "off"),
  );
  assert.equal(result.changed, true);
  assert.match(result.path, /custom%2Fname\.md$/);
  assert.equal(
    readFileSync(result.path, "utf8"),
    '---\nname: "custom/name"\nthinking: off\n---\n',
  );
  const noop = withPiAgentDir(createRoot, () =>
    updateAgentOverride(
      { ...createDefinition, overrideSource: result.path },
      "model",
      undefined,
    ),
  );
  assert.equal(noop.changed, false);
  const enabledRoot = mkdtempSync(
    join(tmpdir(), "pi-herdsman-enabled-persist-"),
  );
  const enabledDefinition = {
    name: "reviewer",
    path: "/bundled/reviewer.md",
    extensionSource: "/bundled/reviewer.md",
    frontmatter: { name: "reviewer", enabled: true },
    body: "bundled body",
  } as const;
  const disabled = withPiAgentDir(enabledRoot, () =>
    updateAgentOverride(enabledDefinition, "enabled", false),
  );
  assert.equal(disabled.changed, true);
  assert.equal(
    readFileSync(disabled.path, "utf8"),
    '---\nname: "reviewer"\nenabled: false\n---\n',
  );
  const enabledReset = withPiAgentDir(enabledRoot, () =>
    updateAgentOverride(
      { ...enabledDefinition, overrideSource: disabled.path },
      "enabled",
      undefined,
    ),
  );
  assert.equal(enabledReset.changed, true);
  assert.doesNotMatch(readFileSync(disabled.path, "utf8"), /^enabled:/m);
});
