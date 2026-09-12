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
import { join, sep } from "node:path";
import test from "node:test";
import {
  agentDefinitionDelegationEnabled,
  agentDefinitionMetadata,
  agentDefinitionEnabled,
  agentLaunchArgs,
  discoverAgent,
  discoverAgentDefinitions,
  expandAgentBodyFiles,
  inferAgentDefinitionTools,
  mergeFrontmatter,
  projectAgentDefinition,
  updateAgentOverride,
  validateAgentDefinitionReferences,
  writePrivatePromptSnapshots,
  type Frontmatter,
} from "./agent-definitions.ts";

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

function assertPosixMode(path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777;
  if (process.platform !== "win32") assert.equal(actual, expected);
}

test("parses scalar frontmatter fields and applies defaults", () => {
  const definition = discoverAgentDefinitionsWithContents(
    "---\nname: custom\ninheritSkills: false\n---\n\nPrompt\n",
  ).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter, {
    name: "custom",
    inheritSkills: false,
    enabled: true,
  });
  assert.equal(definition.body, "Prompt");
  assert.deepEqual(
    discoverAgentDefinitionsWithContents(
      "---\nname: custom\nenabled: false\n---\nPrompt",
    ).find(({ name }) => name === "custom")?.frontmatter,
    { name: "custom", enabled: false },
  );
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\ninheritSkills: yes\n---",
      ),
    /custom\.md agent custom field inheritSkills: must be a boolean/,
  );
  for (const value of ["yes", '"false"', "1", "null", "[]", "{}"]) {
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\nenabled: ${value}\n---`,
        ),
      /must be a boolean/,
    );
  }
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        "---\nname: custom\nenabled: yes\n---\n",
      ),
    /custom\.md agent custom field enabled: must be a boolean/,
  );

  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-enabled-default-"));
  assert.equal(
    withPiAgentDir(root, () => discoverAgent("scout").frontmatter.enabled),
    true,
  );
});

test("accepts a UTF-8 BOM before native YAML frontmatter", () => {
  const definition = discoverAgentDefinitionsWithContents(
    "\uFEFF---\nname: custom\nskills:\n  - one\n  - two\n---\n",
  ).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter.skills, ["one", "two"]);
});

test("parses native YAML capability arrays and rejects unsupported fields", () => {
  const definition = discoverAgentDefinitionsWithContents(`---
name: custom
tools: ["read", " grep "]
excludeTools: []
skills:
  - "./skills/local.md"
extensions:
  - "./extensions/local.ts"
agents:
  - "scout"
  - "reviewer"
---
Prompt`).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter, {
    name: "custom",
    tools: ["read", " grep ", "agent"],
    excludeTools: [],
    skills: ["./skills/local.md"],
    extensions: ["./extensions/local.ts"],
    agents: ["scout", "reviewer"],
    enabled: true,
  });
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        '---\nname: custom\nsubagents: ["scout"]\n---',
      ),
    /is not a supported agent-definition field/,
  );
});

test("loads multiline flow arrays and preserves compact arrays", () => {
  const definition = discoverAgentDefinitionsWithContents(`---
name: custom
skills:
  [
    "~/.agents/skills/ego-browser/SKILL.md",
    "~/Coding/AI/agent-skills/skills/backlog/SKILL.md",
    "~/Coding/AI/agent-skills/skills/gh-github/SKILL.md",
  ]
extensions:
  [
    "~/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js",
    "~/.pi/agent/extensions/agents-md-imports.ts",
  ]
tools: ["read", "grep"]
---
Prompt`).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter.skills, [
    "~/.agents/skills/ego-browser/SKILL.md",
    "~/Coding/AI/agent-skills/skills/backlog/SKILL.md",
    "~/Coding/AI/agent-skills/skills/gh-github/SKILL.md",
  ]);
  assert.deepEqual(definition.frontmatter.extensions, [
    "~/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js",
    "~/.pi/agent/extensions/agents-md-imports.ts",
  ]);
  assert.deepEqual(definition.frontmatter.tools, ["read", "grep"]);
});

test("reports malformed YAML with the source definition path", () => {
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents("---\nname: custom\nskills: [\n---"),
    /custom\.md:/,
  );
});

test("requires a YAML mapping as the frontmatter root", () => {
  assert.throws(
    () => discoverAgentDefinitionsWithContents("---\n- foo\n- bar\n---"),
    /custom\.md: frontmatter must be a YAML mapping/,
  );
});

test("preserves opaque permission mappings", () => {
  const definition = discoverAgentDefinitionsWithContents(
    `---
name: custom
permission:
  "*": deny
  read: allow
  bash:
    "*": deny
    "git status": allow
---
`,
  ).find(({ name }) => name === "custom")!;
  assert.deepEqual(definition.frontmatter.permission, {
    "*": "deny",
    read: "allow",
    bash: { "*": "deny", "git status": "allow" },
  });
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

test(
  "resolves native Windows body file reference forms",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-herdsman-windows-body-files-"));
    const agents = join(root, "agents");
    const prompts = join(root, "prompts");
    mkdirSync(agents);
    mkdirSync(prompts);
    const definitionPath = join(agents, "custom.md");
    writeFileSync(join(prompts, "one.md"), "one");
    writeFileSync(
      definitionPath,
      `---\nname: custom\n---\nBefore\n@..\\prompts\\one.md\n@.\\custom.md\n@~\\prompts\\home.md\n@C:\\work\\prompt.md\n@\\rooted\\prompt.md\n@\\\\server\\share\\prompt.md\nAfter\n@example`,
    );
    const definition = withPiAgentDir(root, () => discoverAgent("custom"));
    assert.equal(
      definition.body,
      `Before\n@${join(prompts, "one.md")}\n@${join(agents, "custom.md")}\n@${join(homedir(), "prompts", "home.md")}\n@C:\\work\\prompt.md\n@\\rooted\\prompt.md\n@\\\\server\\share\\prompt.md\nAfter\n@example`,
    );
  },
);

test("normalizes home-relative references in project and global definitions", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-project-agents-"));
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-global-agents-"));
  const projectAgentDir = join(project, ".pi", "agents");
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  mkdirSync(globalAgents);
  writeFileSync(
    join(projectAgentDir, "project.md"),
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

test("merges scalars, arrays, and false values", () => {
  assert.deepEqual(
    mergeFrontmatter(
      {
        name: "agent",
        model: "base/model",
        noTools: true,
        tools: ["read"],
        skills: ["base"],
      },
      {
        name: "agent",
        model: "override/model",
        noTools: false,
        tools: [],
        skills: ["override"],
      },
    ),
    {
      name: "agent",
      model: "override/model",
      noTools: false,
      tools: [],
      skills: ["override"],
    },
  );
});

test("rejects malformed capability fields", () => {
  for (const [field, value, message] of [
    ["tools", '"read"', /must be an array/],
    ["skills", '["ok", 1]', /must be an array/],
    ["extensions", '[""]', /must be an array/],
    [
      "systemPromptFiles",
      '["prompt.md"]',
      /is not a supported agent-definition field/,
    ],
    ["tools", '["   "]', /must be an array/],
    ["agents", '"scout"', /must be an array/],
    ["agents", '["scout", 1]', /must be an array/],
    ["agents", '["   "]', /must be an array/],
    [
      "agents",
      '["scout", "scout"]',
      /must be an array of unique non-empty strings/,
    ],
    ["noTools", '"true"', /must be a boolean/],
    ["noBuiltinTools", "yes", /must be a boolean/],
    ["noSkills", "1", /must be a boolean/],
    ["noExtensions", '"false"', /must be a boolean/],
    ["enabled", '"false"', /must be a boolean/],
    ["enabled", "yes", /must be a boolean/],
    ["enabled", "1", /must be a boolean/],
    ["enabled", "null", /must be a boolean/],
    ["permission", "allow", /must be a mapping/],
    ["inheritGlobalContext", '"false"', /must be a boolean/],
    ["inheritGlobalContext", "1", /must be a boolean/],
    ["inheritGlobalContext", "yes", /must be a boolean/],
  ] as const)
    assert.throws(
      () =>
        discoverAgentDefinitionsWithContents(
          `---\nname: custom\n${field}: ${value}\n---`,
        ),
      message,
    );
  for (const [field, value, message] of [
    ["model", "[]", /model.*must be a non-empty string/],
    ["model", "false", /model.*must be a non-empty string/],
    ["thinking", "1", /thinking.*must be one of/],
    [
      "systemPromptMode",
      "false",
      /systemPromptMode.*must be append or replace/,
    ],
    ["bodyMode", "merge", /bodyMode.*must be append or replace/],
    [
      "agents",
      "[\n  scout,\n  scout,\n]",
      /must be an array of unique non-empty strings/,
    ],
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

    assert.deepEqual(launch("agent", {}), [
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
          launch("agent", { ...frontmatter, systemPromptMode }),
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
    ["implementer", ["read", "bash", "edit", "write", "agent"]],
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
    ["reviewer", ["read", "ls", "find", "grep", "agent"]],
    ["scout", ["read", "ls", "find", "grep"]],
    ["generalist", ["read", "bash", "edit", "write", "agent"]],
  ]);
  const expectedDescriptions = new Map([
    [
      "scout",
      "Read-only codebase reconnaissance for unfamiliar areas; use to find entry points, trace flows, dependencies, constraints, and risks before deciding or editing",
    ],
    [
      "researcher",
      "External research specialist for questions that require web, documentation, standards, vendor, or other authoritative evidence beyond the repository; use for current facts, API behavior, comparisons, and source-backed recommendations",
    ],
    [
      "implementer",
      "Focused implementation agent for a resolved change; use when the required behavior is already decided and the task is to edit, test, and report",
    ],
    [
      "reviewer",
      "Independent read-only reviewer for plans, diffs, implementations, and codebase health; use when work needs verification, missing-case analysis, or regression review rather than modification",
    ],
    [
      "generalist",
      "General-purpose execution agent for scoped tasks that do not fit scout, researcher, implementer, or reviewer",
    ],
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
    assert.equal(
      definition.frontmatter.description,
      expectedDescriptions.get(definition.name),
    );
    assert.equal(
      agentDefinitionMetadata(definition).description,
      expectedDescriptions.get(definition.name),
    );
    assert.deepEqual(
      definition.frontmatter.tools,
      expectedTools.get(definition.name),
    );
    assert.deepEqual(definition.frontmatter.skills, []);
    if (definition.name === "researcher")
      assert.equal(definition.frontmatter.extensions, undefined);
    else assert.deepEqual(definition.frontmatter.extensions, []);
    assert.doesNotMatch(readFileSync(definition.path, "utf8"), /Users\/jeff/);
    if (definition.frontmatter.agents?.length)
      assert.doesNotMatch(
        readFileSync(definition.path, "utf8"),
        /tools:.*agent/,
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
    ["reviewer", ["read", "ls", "find", "grep", "agent", "ask_owner"]],
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
        managedAgent: true,
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
      managedAgent: true,
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
      args.flatMap((arg) => arg.split(",")).includes("agent"),
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

test("discovers project definitions and gives global overlays final precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-project-agents-"));
  const projectAgentDir = join(root, ".pi", "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  writeFileSync(
    join(projectAgentDir, "project.md"),
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
  assert.equal(definition.projectSource, join(projectAgentDir, "project.md"));
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
  const projectAgentDir = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-layered-global-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  mkdirSync(globalAgents);
  const bundled = withPiAgentDir(global, () => discoverAgent("reviewer"));
  const projectPath = join(projectAgentDir, "reviewer.md");
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
  assert.deepEqual(effective.frontmatter.tools, ["read", "agent"]);
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
  const projectAgentDir = join(project, ".pi", "agents");
  const global = mkdtempSync(join(tmpdir(), "pi-herdsman-global-validation-"));
  const globalAgents = join(global, "agents");
  mkdirSync(projectAgentDir, { recursive: true });
  mkdirSync(globalAgents);

  const standalone = join(projectAgentDir, "standalone.md");
  writeFileSync(
    standalone,
    "---\nname: standalone\nbodyMode: append\n---\nbody",
  );
  assert.throws(
    () => discoverAgentDefinitions({ projectRoot: project }),
    new RegExp(
      `${standalone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*bodyMode`,
    ),
  );
  unlinkSync(standalone);

  writeFileSync(
    join(projectAgentDir, "child.md"),
    "---\nname: child\n---\nchild",
  );
  writeFileSync(
    join(projectAgentDir, "parent.md"),
    '---\nname: parent\nagents: ["child"]\n---\nparent',
  );
  writeFileSync(
    join(projectAgentDir, "body.md"),
    "---\nname: scout\nbodyMode: append\n---\n@./policy.txt",
  );
  writeFileSync(join(projectAgentDir, "policy.txt"), "project policy");
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
      join(projectAgentDir, "policy.txt").replaceAll(
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
  validateAgentDefinitionReferences(
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
    join(projectAgentDir, "parent.md"),
  );

  const duplicate = join(projectAgentDir, "nested");
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
    '---\nname: custom\nagents: ["researcher"]\n---\nCustom prompt',
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
      implementer.extensionSource!.split(sep).join("/"),
      /extension\/agent-definitions\/implementer\.md$/,
    );
    assert.equal(implementer.overrideSource, overridePath);
    assert.equal(implementer.frontmatter.description, "User implementation");
    assert.equal(implementer.frontmatter.model, undefined);
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
    '---\nname: parent\nagents: ["reviewer"]\n---\nParent',
  );

  withPiAgentDir(root, () => {
    const definitions = discoverAgentDefinitions();
    const reviewer = definitions.find(({ name }) => name === "reviewer")!;
    const parent = definitions.find(({ name }) => name === "parent")!;
    assert.equal(reviewer.frontmatter.enabled, false);
    assert.equal(agentDefinitionEnabled(reviewer), false);
    assert.equal(agentDefinitionMetadata(reviewer).enabled, false);
    assert.throws(
      () => validateAgentDefinitionReferences(parent, definitions),
      /agent parent references disabled agent definition reviewer; enable reviewer/,
    );
    assert.equal(
      definitions.some(({ name }) => name === "reviewer"),
      true,
    );
  });
});

test("validates user duplicates and merged agent references", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-"));
  const agents = join(root, "agents");
  mkdirSync(join(agents, "nested"), { recursive: true });
  writeFileSync(
    join(agents, "parent.md"),
    '---\nname: parent\nagents: ["child"]\n---\nParent',
  );
  writeFileSync(
    join(agents, "child.md"),
    '---\nname: child\nagents: ["parent"]\n---\nChild',
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
    withPiAgentDir(root, () => discoverAgent("reviewer").frontmatter.agents),
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
    '---\nname: parent\nagents: ["missing"]\n---\nParent',
  );
  assert.throws(
    () => withPiAgentDir(root, () => discoverAgentDefinitions()),
    /agent parent references missing agent definition missing/,
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
      () => discoverAgent("reviewer").frontmatter.agents,
    )?.includes("scout"),
    true,
  );
});

test("transports complex prompts through a private temporary file", () => {
  const body = "line 1\nquotes \" ' $ `\nUnicode: café 🦊\nline 4";
  const [promptPath] = writePrivatePromptSnapshots([body]);
  try {
    assert.equal(readFileSync(promptPath, "utf8"), body);
    assertPosixMode(promptPath, 0o600);
    const tempRoot = join(
      tmpdir(),
      `pi-herdsman-${process.getuid?.() ?? "user"}`,
    );
    assertPosixMode(tempRoot, 0o700);
    assertPosixMode(join(tempRoot, "prompts"), 0o700);
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
    for (const path of paths) assertPosixMode(path, 0o600);
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

test("resolves model and thinking fallbacks independently at launch", () => {
  const launch = (frontmatter: Frontmatter, options = {}) =>
    agentLaunchArgs(
      { name: "agent", path: "/agent.md", frontmatter, body: "" },
      {
        inheritedModel: "inherited/model",
        inheritedThinking: "high",
        ...options,
      },
    );
  const suffix = ["--no-context-files", "--no-skills"];
  for (const [frontmatter, settings] of [
    [{}, ["--model", "inherited/model", "--thinking", "high"]],
    [
      { model: "explicit/model" },
      ["--model", "explicit/model", "--thinking", "high"],
    ],
    [{ thinking: "low" }, ["--model", "inherited/model", "--thinking", "low"]],
    [{ thinking: false }, ["--model", "inherited/model", "--thinking", "off"]],
  ] as const)
    assert.deepEqual(launch(frontmatter), [...settings, ...suffix]);
  assert.deepEqual(
    agentLaunchArgs(
      { name: "agent", path: "/agent.md", frontmatter: {}, body: "" },
      {},
    ),
    ["--no-context-files", "--no-skills"],
  );
});

test("bundled definitions leave execution settings to the controller", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-bundled-settings-"));
  withPiAgentDir(root, () => {
    for (const name of [
      "generalist",
      "implementer",
      "researcher",
      "reviewer",
      "scout",
    ]) {
      const definition = discoverAgent(name);
      assert.equal(definition.frontmatter.model, undefined);
      assert.equal(definition.frontmatter.thinking, undefined);
    }
  });
});

test("appends the shared prompt after context additions", () => {
  assert.deepEqual(
    agentLaunchArgs(
      {
        name: "agent",
        path: "/agent.md",
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
          name: "agent",
          path: "/agent.md",
          frontmatter: {},
          body: "body",
        },
        {},
      ),
    /agent agent has a body but no bodyPromptPath was provided/,
  );
});

test("bundled generalist definition retains its declared tool policy", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agent-policy-"));
  const generalist = withPiAgentDir(root, () => discoverAgent("generalist"));
  assert.equal(generalist.frontmatter.noExtensions, true);
  assert.deepEqual(generalist.frontmatter.tools, [
    "read",
    "bash",
    "edit",
    "write",
    "agent",
  ]);
  const args = agentLaunchArgs(generalist, {
    bodyPromptPath: "/tmp/prompt.txt",
    cwd: process.cwd(),
    managedAgent: true,
  });
  const tools = args.indexOf("--tools");
  assert.notEqual(tools, -1);
  assert.equal(args[tools + 1], "read,bash,edit,write,agent,ask_owner");
});

test("managed launch policy always includes ask_owner", () => {
  const launch = (frontmatter: Record<string, unknown>) =>
    agentLaunchArgs(
      { name: "agent", path: "/agent.md", frontmatter, body: "" },
      {
        bodyPromptPath: "/prompt",
        cwd: process.cwd(),
        managedAgent: true,
      },
    );
  const cases = [
    [{ tools: ["read", " ask_owner", "read"] }, ["--tools", "read,ask_owner"]],
    [{ noTools: true }, ["--no-tools", "--tools", "ask_owner"]],
    [
      { noTools: true, tools: ["read"] },
      ["--no-tools", "--tools", "read,ask_owner"],
    ],
    [{ tools: [] }, ["--no-tools", "--tools", "ask_owner"]],
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
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-agent-standalone-"));
  const standalone = withPiAgentDir(root, () => discoverAgent("generalist"));
  assert.match(
    standalone.path.split(sep).join("/"),
    /agent-definitions\/generalist\.md$/,
  );
  assert.equal(
    agentLaunchArgs(standalone, {
      bodyPromptPath: "/prompt",
      cwd: process.cwd(),
      managedAgent: true,
    })
      .flatMap((arg) => arg.split(","))
      .filter((arg) => arg === "ask_owner").length,
    1,
  );
});

test("keeps omitted tools default and closes an explicit empty allowlist", () => {
  const launch = (frontmatter: Record<string, unknown>) =>
    agentLaunchArgs(
      { name: "agent", path: "/agent.md", frontmatter, body: "" },
      { bodyPromptPath: "/prompt" },
    );
  assert.deepEqual(launch({}), ["--no-context-files", "--no-skills"]);
  assert.deepEqual(launch({ tools: [] }), [
    "--no-context-files",
    "--no-tools",
    "--no-skills",
  ]);
});

test("applies explicit noSkills before inheritSkills defaults", () => {
  const launch = (frontmatter: Record<string, string | boolean>) =>
    agentLaunchArgs(
      { name: "agent", path: "/agent.md", frontmatter, body: "" },
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
        name: "agent",
        path: "/agent.md",
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
    name: "agent",
    path: "/agents/agent.md",
    frontmatter: {
      name: "agent",
      description: "An agent",
    },
    body: "",
  };
  assert.deepEqual(agentDefinitionMetadata(agent), {
    name: "agent",
    description: "An agent",
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
      name: "agent",
      path: "/agents/agent.md",
      frontmatter: { thinking: false },
      body: "",
    }),
    { name: "agent", thinking: "off" },
  );
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "agent",
      path: "/agents/agent.md",
      frontmatter: {},
      body: "",
    }),
    { name: "agent" },
  );
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "agent",
      path: "/agents/agent.md",
      frontmatter: { noExtensions: false, extensions: [] },
      body: "",
    }),
    { name: "agent", noExtensions: false, extensions: [] },
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
      noExtensions: true,
      extensions: ["./extensions/local.ts", "/extensions/shared.ts"],
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
    noExtensions: true,
    extensions: ["./extensions/local.ts", "/extensions/shared.ts"],
  });
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "implementer",
      path: "/agents/implementer.md",
      frontmatter: { agents: ["scout", "reviewer"] },
      body: "",
    }),
    { name: "implementer", agents: ["scout", "reviewer"] },
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

test("rejects previous delegation frontmatter and tool capability", () => {
  assert.throws(
    () =>
      discoverAgentDefinitionsWithContents(
        '---\nname: custom\nworkers: ["scout"]\n---',
      ),
    /is not a supported agent-definition field/,
  );
  const definition = {
    name: "parent",
    path: "/parent.md",
    frontmatter: { agents: ["scout"], noTools: true, tools: ["worker"] },
    body: "",
  };
  assert.equal(inferAgentDefinitionTools(definition), definition);
  assert.equal(agentDefinitionDelegationEnabled(definition), false);
});

test("infers agent only when native policy permits it", () => {
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
    "agent",
  ]);
  assert.deepEqual(
    agentDefinitionMetadata({
      name: "parent",
      path: "/parent.md",
      frontmatter: { agents: ["child"], tools: ["read"] },
      body: "",
    }),
    { name: "parent", agents: ["child"], tools: ["read"] },
  );
  const make = (frontmatter: Frontmatter) =>
    agentLaunchArgs(
      inferAgentDefinitionTools({
        name: "parent",
        path: "/parent.md",
        frontmatter,
        body: "",
      }),
      { managedAgent: true },
    );
  assert.deepEqual(
    make({ agents: ["child"], tools: ["read"] }).filter(
      (v) => v === "--tools" || v.includes("read"),
    ),
    ["--tools", "read,agent,ask_owner"],
  );
  assert.deepEqual(
    make({ agents: ["child"], tools: ["read", "agent"] }).filter(
      (v) => v === "--tools" || v.includes("read"),
    ),
    ["--tools", "read,agent,ask_owner"],
  );
  assert.deepEqual(
    make({
      agents: ["child"],
      tools: ["read"],
      excludeTools: ["agent"],
    }).filter(
      (v) =>
        v === "--tools" ||
        v.startsWith("read") ||
        v === "--exclude-tools" ||
        v === "agent",
    ),
    ["--tools", "read,ask_owner", "--exclude-tools", "agent"],
  );
  assert.deepEqual(
    make({ agents: ["child"], noTools: true }).filter(
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
      agents: ["scout"],
      tools: ["read,agent", "bash"],
      excludeTools: ["write"],
      noExtensions: true,
      extensions: ["./review.ts"],
    },
    body: "",
  });
  const leaf = projectAgentDefinition(definition, "leaf");
  assert.equal(leaf.frontmatter.agents, undefined);
  assert.deepEqual(leaf.frontmatter.tools, ["read", "bash"]);
  assert.deepEqual(agentDefinitionMetadata(definition, "leaf"), {
    name: "parent",
    tools: ["read", "bash"],
    excludeTools: ["write"],
    noExtensions: true,
    extensions: ["./review.ts"],
  });
  assert.deepEqual(
    agentLaunchArgs(leaf, { managedAgent: true }).filter(
      (value) => value === "--tools" || value.includes("ask_owner"),
    ),
    ["--tools", "read,bash,ask_owner"],
  );
  const empty = projectAgentDefinition(
    {
      name: "empty",
      path: "/empty.md",
      frontmatter: { agents: ["scout"], tools: [] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(empty.frontmatter.tools, []);
  assert.equal(empty.frontmatter.agents, undefined);
  const denied = projectAgentDefinition(
    {
      name: "denied",
      path: "/denied.md",
      frontmatter: {
        agents: ["scout"],
        tools: ["read", "agent"],
        excludeTools: ["agent"],
      },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(denied.frontmatter.tools, ["read"]);
  assert.deepEqual(denied.frontmatter.excludeTools, ["agent"]);
  const delegationOnlyLeaf = projectAgentDefinition(
    {
      name: "parent",
      path: "/parent.md",
      frontmatter: { agents: ["scout"], tools: ["agent"] },
      body: "",
    },
    "leaf",
  );
  assert.deepEqual(
    agentLaunchArgs(delegationOnlyLeaf, { managedAgent: true }),
    [
      "--no-context-files",
      "--append-system-prompt",
      '<active_agent name="parent"/>',
      "--no-tools",
      "--tools",
      "ask_owner",
      "--no-skills",
    ],
  );
  const omittedToolsLeaf = projectAgentDefinition(
    inferAgentDefinitionTools({
      name: "parent",
      path: "/parent.md",
      frontmatter: { agents: ["scout"] },
      body: "",
    }),
    "leaf",
  );
  assert.equal(omittedToolsLeaf.frontmatter.agents, undefined);
  assert.equal(omittedToolsLeaf.frontmatter.tools, undefined);
  assert.equal(
    agentLaunchArgs(omittedToolsLeaf, { managedAgent: true }).includes("agent"),
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
