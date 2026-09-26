import {
  chmodSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadProjectContextFiles,
  parseFrontmatter as parsePiFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { snapshotTextFiles } from "./core.ts";
import { herdsmanTempRoot } from "./storage.ts";

export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const THINKING_LEVELS = new Set(VALID_THINKING_LEVELS);
const SYSTEM_PROMPT_MODES = new Set(["append", "replace"]);
type BodyMode = "replace" | "append";
const BODY_MODES = new Set<BodyMode>(["append", "replace"]);
const STRING_FIELDS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "systemPromptMode",
  "bodyMode",
]);
const BOOLEAN_CAPABILITY_FIELDS = new Set([
  "enabled",
  "noTools",
  "noBuiltinTools",
  "noSkills",
  "noExtensions",
  "inheritGlobalContext",
  "inheritProjectContext",
  "inheritSkills",
]);
const ARRAY_FIELDS = new Set([
  "tools",
  "excludeTools",
  "skills",
  "extensions",
  "agents",
]);
const SUPPORTED_FIELDS = new Set([
  "name",
  "description",
  "permission",
  ...STRING_FIELDS,
  ...BOOLEAN_CAPABILITY_FIELDS,
  ...ARRAY_FIELDS,
]);
const BODY_FILE_REFERENCE =
  sep === "\\"
    ? /^[ \t]*@((?:[\\/]|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\).+?)[ \t]*$/gmu
    : /^[ \t]*@((?:\/|~\/|\.\.?\/).+?)[ \t]*$/gmu;
const BUILTIN_AGENT_DIR = fileURLToPath(
  new URL("./agent-definitions", import.meta.url),
);

export type FrontmatterValue =
  string | boolean | string[] | { [key: string]: unknown };
export type Frontmatter = {
  enabled?: boolean;
  model?: string;
  thinking?: string | false;
  bodyMode?: BodyMode;
  permission?: { [key: string]: unknown };
  noTools?: boolean;
  noBuiltinTools?: boolean;
  tools?: string[];
  excludeTools?: string[];
  noSkills?: boolean;
  skills?: string[];
  noExtensions?: boolean;
  extensions?: string[];
  agents?: string[];
  inheritGlobalContext?: boolean;
  [key: string]: FrontmatterValue | undefined;
};

export type AgentDefinition = {
  name: string;
  path: string;
  frontmatter: Frontmatter;
  body: string;
  extensionSource?: string;
  projectSource?: string;
  overrideSource?: string;
};

export const AGENT_COORDINATION_TOOLS = [
  "agent_list",
  "agent_delegate",
  "agent_continue",
  "agent_steer",
  "agent_interrupt",
  "agent_reply",
  "agent_close",
  "agent_inspect",
  "agent_transcript",
] as const;

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function readAgentDefinitions(root: string): AgentDefinition[] {
  const definitions = markdownFiles(root)
    .filter((path) => !path.endsWith(".example.md"))
    .sort()
    .map((path) => {
      const content = readFileSync(path, "utf8").replace(/^\uFEFF/u, "");
      let parsed: ReturnType<typeof parsePiFrontmatter>;
      try {
        parsed = parsePiFrontmatter<Record<string, unknown>>(content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path}: ${message}`, { cause: error });
      }
      if (!isPlainObject(parsed.frontmatter))
        throw new Error(`${path}: frontmatter must be a YAML mapping`);
      const frontmatter = parsed.frontmatter as Frontmatter;
      const definition: AgentDefinition = {
        name: typeof frontmatter.name === "string" ? frontmatter.name : "",
        path,
        frontmatter,
        body: resolveBodyFileReferences(parsed.body, path),
      };
      validateDefinition(definition, { allowBodyMode: true });
      return definition;
    });
  const pathsByName = new Map<string, string[]>();
  for (const definition of definitions)
    pathsByName.set(definition.name, [
      ...(pathsByName.get(definition.name) ?? []),
      definition.path,
    ]);
  for (const [name, paths] of pathsByName)
    if (paths.length > 1)
      throw new Error(
        `multiple definitions found for agent ${name}: ${paths.join(", ")}`,
      );
  return definitions;
}

function resolveBodyFileReferences(
  body: string,
  definitionPath: string,
): string {
  return body.replace(BODY_FILE_REFERENCE, (_match, input: string) => {
    const homeRelative = input.startsWith("~/") || input.startsWith(`~${sep}`);
    const expanded = homeRelative ? resolve(homedir(), input.slice(2)) : input;
    return `@${isAbsolute(expanded) ? expanded : resolve(dirname(definitionPath), expanded)}`;
  });
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function mergeFrontmatter(
  base: Frontmatter,
  override: Frontmatter,
): Frontmatter {
  return { ...base, ...override };
}

function validateDefinition(
  definition: AgentDefinition,
  options: { allowBodyMode?: boolean } = {},
): void {
  const { frontmatter, name, overrideSource, projectSource, extensionSource } =
    definition;
  const source =
    overrideSource ?? projectSource ?? extensionSource ?? definition.path;
  const invalid = (field: string, reason: string): never => {
    throw new Error(
      `${source}${name ? ` agent ${name}` : ""} field ${field}: ${reason}`,
    );
  };
  for (const field of Object.keys(frontmatter))
    if (!SUPPORTED_FIELDS.has(field))
      invalid(field, "is not a supported agent-definition field");
  if (
    frontmatter.permission !== undefined &&
    !isPlainObject(frontmatter.permission)
  )
    invalid("permission", "must be a mapping");
  if (typeof frontmatter.name !== "string" || !frontmatter.name)
    invalid("name", "must be a non-empty string");
  for (const field of BOOLEAN_CAPABILITY_FIELDS)
    if (
      frontmatter[field] !== undefined &&
      typeof frontmatter[field] !== "boolean"
    )
      invalid(field, "must be a boolean");
  for (const field of ARRAY_FIELDS) {
    const value = frontmatter[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.some(
          (entry) => typeof entry !== "string" || entry.trim().length === 0,
        ) ||
        (field === "agents" && new Set(value).size !== value.length))
    )
      invalid(
        field,
        field === "agents"
          ? "must be an array of unique non-empty strings"
          : "must be an array of non-empty strings",
      );
  }
  if (frontmatter.model !== undefined) {
    if (typeof frontmatter.model !== "string" || !frontmatter.model)
      invalid("model", "must be a non-empty string");
  }
  if (
    frontmatter.description !== undefined &&
    typeof frontmatter.description !== "string"
  )
    invalid("description", "must be a string");
  if (
    frontmatter.thinking !== undefined &&
    frontmatter.thinking !== false &&
    (typeof frontmatter.thinking !== "string" ||
      !THINKING_LEVELS.has(frontmatter.thinking))
  )
    invalid(
      "thinking",
      "must be one of off, minimal, low, medium, high, xhigh, max, or false",
    );
  if (
    frontmatter.systemPromptMode !== undefined &&
    (typeof frontmatter.systemPromptMode !== "string" ||
      !SYSTEM_PROMPT_MODES.has(frontmatter.systemPromptMode))
  )
    invalid("systemPromptMode", "must be append or replace");
  if (
    frontmatter.bodyMode !== undefined &&
    (typeof frontmatter.bodyMode !== "string" ||
      !BODY_MODES.has(frontmatter.bodyMode))
  )
    invalid("bodyMode", "must be append or replace");
  if (frontmatter.bodyMode !== undefined && !options.allowBodyMode)
    invalid("bodyMode", "only valid when overlaying an existing agent");
}

function mergeDefinitionBody(
  base: string,
  override: string,
  mode: BodyMode,
): string {
  if (!override) return base;
  if (mode === "append" && base) return `${base}\n\n${override}`;
  return override;
}

function overrideBodyMode(definition: AgentDefinition): BodyMode {
  return definition.frontmatter.bodyMode ?? "replace";
}

function normalizedToolNames(tools: readonly string[] | undefined): string[] {
  return (tools ?? [])
    .flatMap((tool) => tool.split(","))
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function readOptionalAgentDefinitions(root: string): AgentDefinition[] {
  const stats = statSync(root, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory())
    throw new Error(`agent directory is not a directory: ${root}`);
  return readAgentDefinitions(root);
}

type DefinitionLayerSource = "projectSource" | "overrideSource";

function applyDefinitionLayer(
  definitions: Map<string, AgentDefinition>,
  layer: readonly AgentDefinition[],
  sourceField: DefinitionLayerSource,
): void {
  for (const definition of layer) {
    const base = definitions.get(definition.name);
    if (!base) {
      definition[sourceField] = definition.path;
      validateDefinition(definition);
      definitions.set(definition.name, definition);
      continue;
    }
    const mode = overrideBodyMode(definition);
    const { bodyMode: _bodyMode, ...overrideFrontmatter } =
      definition.frontmatter;
    const effective: AgentDefinition = {
      name: base.name,
      path: definition.path,
      frontmatter: mergeFrontmatter(base.frontmatter, overrideFrontmatter),
      body: mergeDefinitionBody(base.body, definition.body, mode),
      extensionSource: base.extensionSource,
      projectSource: base.projectSource,
      overrideSource: base.overrideSource,
      [sourceField]: definition.path,
    };
    validateDefinition(effective);
    definitions.set(effective.name, effective);
  }
}

export type DiscoverAgentDefinitionsOptions = { projectRoot?: string };

export function discoverAgentDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition[] {
  const bundled = readAgentDefinitions(BUILTIN_AGENT_DIR);
  const project = options.projectRoot
    ? readOptionalAgentDefinitions(
        join(options.projectRoot, CONFIG_DIR_NAME, "agents"),
      )
    : [];
  const user = readOptionalAgentDefinitions(join(getAgentDir(), "agents"));
  const definitions = new Map(
    bundled.map((definition) => [definition.name, definition]),
  );
  for (const definition of bundled) {
    if (!definition.extensionSource)
      definition.extensionSource = definition.path;
    validateDefinition(definition);
  }
  applyDefinitionLayer(definitions, project, "projectSource");
  applyDefinitionLayer(definitions, user, "overrideSource");

  const effective = [...definitions.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = new Set(effective.map((definition) => definition.name));
  for (const definition of effective)
    for (const reference of definition.frontmatter.agents ?? [])
      if (!names.has(reference))
        throw new Error(
          `agent ${definition.name} references missing agent definition ${reference}`,
        );
  return effective.map((definition) => ({
    ...definition,
    frontmatter: {
      ...definition.frontmatter,
      enabled: definition.frontmatter.enabled ?? true,
    },
  }));
}

export function discoverAgent(
  agentName: string,
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition {
  const definition = discoverAgentDefinitions(options).find(
    (candidate) => candidate.name === agentName,
  );
  if (!definition) throw new Error(`agent ${agentName} not found`);
  return definition;
}

export function agentDefinitionEnabled(definition: AgentDefinition): boolean {
  return definition.frontmatter.enabled !== false;
}

export function validateAgentDefinitionReferences(
  definition: AgentDefinition,
  definitions: readonly AgentDefinition[],
): void {
  const byName = new Map(
    definitions.map((candidate) => [candidate.name, candidate]),
  );
  for (const reference of definition.frontmatter.agents ?? []) {
    const referencedDefinition = byName.get(reference);
    if (!referencedDefinition)
      throw new Error(
        `agent ${definition.name} references missing agent definition ${reference}`,
      );
    if (!agentDefinitionEnabled(referencedDefinition))
      throw new Error(
        `agent ${definition.name} references disabled agent definition ${reference}; enable ${reference} before assigning ${definition.name}`,
      );
  }
}

export type AgentDefinitionScope = "delegating" | "leaf";

function withoutDelegationCapability(
  definition: AgentDefinition,
): AgentDefinition {
  const { agents: _agents, ...frontmatter } = definition.frontmatter;
  return {
    ...definition,
    frontmatter,
  };
}

export function projectAgentDefinition(
  agent: AgentDefinition,
  scope: AgentDefinitionScope,
): AgentDefinition {
  return scope === "leaf" ? withoutDelegationCapability(agent) : agent;
}

export function agentDefinitionMetadata(
  agent: AgentDefinition,
  scope: AgentDefinitionScope = "delegating",
) {
  const { frontmatter } = projectAgentDefinition(agent, scope);
  const description = frontmatter.description;
  const model = configuredModel(frontmatter);
  const thinking = configuredThinking(agent);
  return {
    name: agent.name,
    ...(agentDefinitionEnabled(agent) ? {} : { enabled: false }),
    ...(agent.extensionSource === undefined
      ? {}
      : { extensionSource: agent.extensionSource }),
    ...(agent.projectSource === undefined
      ? {}
      : { projectSource: agent.projectSource }),
    ...(agent.overrideSource === undefined
      ? {}
      : { overrideSource: agent.overrideSource }),
    ...(typeof description === "string" ? { description } : {}),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(frontmatter.noTools === undefined
      ? {}
      : { noTools: frontmatter.noTools }),
    ...(frontmatter.noBuiltinTools === undefined
      ? {}
      : { noBuiltinTools: frontmatter.noBuiltinTools }),
    ...(frontmatter.tools === undefined ? {} : { tools: frontmatter.tools }),
    ...(frontmatter.excludeTools === undefined
      ? {}
      : { excludeTools: frontmatter.excludeTools }),
    ...(frontmatter.noSkills === undefined
      ? {}
      : { noSkills: frontmatter.noSkills }),
    ...(frontmatter.inheritSkills === undefined
      ? {}
      : { inheritSkills: frontmatter.inheritSkills }),
    ...(frontmatter.skills === undefined ? {} : { skills: frontmatter.skills }),
    ...(frontmatter.noExtensions === undefined
      ? {}
      : { noExtensions: frontmatter.noExtensions }),
    ...(frontmatter.extensions === undefined
      ? {}
      : { extensions: frontmatter.extensions }),
    ...(frontmatter.agents === undefined ? {} : { agents: frontmatter.agents }),
  };
}

export type AgentOverrideField = "model" | "thinking" | "enabled";

export function updateAgentOverride(
  definition: AgentDefinition,
  field: AgentOverrideField,
  value: string | boolean | undefined,
): { path: string; changed: boolean; content: string } {
  const path =
    definition.overrideSource ??
    join(getAgentDir(), "agents", `${encodeURIComponent(definition.name)}.md`);
  const exists = statSync(path, { throwIfNoEntry: false });
  if (value === undefined && !exists) {
    return { path, changed: false, content: "" };
  }
  if (value === undefined && definition.overrideSource === undefined)
    return { path, changed: false, content: readFileSync(path, "utf8") };

  let content: string;
  let mode = 0o600;
  if (exists) {
    if (!exists.isFile())
      throw new Error(`agent override is not a file: ${path}`);
    content = readFileSync(path, "utf8");
    mode = exists.mode & 0o777;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    content = `---\nname: ${JSON.stringify(definition.name)}\n---\n`;
  }

  const lines = [...content.matchAll(/.*(?:\r\n|\n|\r|$)/g)].filter(
    (match) => match[0].length > 0,
  );
  if (lines[0]?.[0].replace(/\r?\n|\r$/u, "").trim() !== "---")
    throw new Error(`invalid agent override frontmatter: ${path}`);
  const closing = lines.findIndex(
    (match, index) =>
      index > 0 && match[0].replace(/\r?\n|\r$/u, "").trim() === "---",
  );
  if (closing < 0)
    throw new Error(`invalid agent override frontmatter: ${path}`);
  const eol = content.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const fieldLine = new RegExp(`^${field}:\\s*`);
  const hadField = lines
    .slice(1, closing)
    .some((match) => fieldLine.test(match[0].replace(/\r?\n|\r$/u, "")));
  const retained = lines.filter(
    (match, index) =>
      index <= 0 ||
      index >= closing ||
      !fieldLine.test(match[0].replace(/\r?\n|\r$/u, "")),
  );
  let updated = retained.join("");
  if (value !== undefined) {
    const closingLine = retained.findIndex(
      (match, index) =>
        index > 0 && match[0].replace(/\r?\n|\r$/u, "").trim() === "---",
    );
    const before = retained
      .slice(0, closingLine)
      .map((match) => match[0])
      .join("");
    const after = retained
      .slice(closingLine)
      .map((match) => match[0])
      .join("");
    updated = `${before}${field}: ${value}${eol}${after}`;
  }
  if (value === undefined && !hadField)
    return { path, changed: false, content: readFileSync(path, "utf8") };

  const temporary = join(
    dirname(path),
    `.${encodeURIComponent(definition.name)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, updated, {
      encoding: "utf8",
      mode,
      flag: "wx",
      flush: true,
    });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    return { path, changed: true, content: readFileSync(path, "utf8") };
  } finally {
    if (statSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
  }
}

export function configuredModel(frontmatter: Frontmatter): string | undefined {
  return typeof frontmatter.model === "string" && frontmatter.model
    ? frontmatter.model
    : undefined;
}

/**
 * Which model a delegated child may be launched with.
 *
 * Agent definitions opt out of extension discovery (`noExtensions: true`),
 * which is what keeps a child lean, while delegation hands that child the
 * spawning controller's model. When that model's provider is registered by an
 * extension, the two contradict each other and pi exits with
 * `Model "<id>" not found` about two seconds after launch.
 *
 * Pi reports which providers extensions registered, so the model's needs
 * outrank the definition's preference to stay lean.
 */
export type ChildModelDecision =
  /** Nothing to pass: the child uses its own default. */
  | { kind: "none" }
  /**
   * Pass `--model`. `extensionDiscovery` is true when the model's provider is
   * registered by an extension, in which case the child must not be launched
   * with `--no-extensions` or it cannot resolve the model it was given.
   */
  | { kind: "use"; model: string; extensionDiscovery: boolean };

export function resolveChildModel(input: {
  /** Model pinned by the agent definition's frontmatter, passed to Pi as given. */
  configured?: string;
  /** The spawning controller's model; Pi already resolved its provider. */
  inherited?: { provider: string; token: string };
  /** True when `providerId` is registered by an extension. */
  isForeignProvider: (providerId: string) => boolean;
}): ChildModelDecision {
  // A pinned model is passed through as written: the definition's own extension
  // policy governs it, so nothing here needs to interpret the value.
  if (input.configured !== undefined && input.configured.trim() !== "")
    return { kind: "use", model: input.configured, extensionDiscovery: false };
  if (input.inherited === undefined) return { kind: "none" };
  return {
    kind: "use",
    model: input.inherited.token,
    // Only an inherited model needs the exception: a child denied discovery
    // cannot resolve a model whose provider only an extension supplies.
    extensionDiscovery: input.isForeignProvider(input.inherited.provider),
  };
}

function configuredThinking(agent: AgentDefinition): string | undefined {
  const configured = agent.frontmatter.thinking;
  if (configured === false) return "off";
  if (typeof configured !== "string") return undefined;
  if (!THINKING_LEVELS.has(configured))
    throw new Error(
      `agent ${agent.name} has invalid thinking level: ${JSON.stringify(configured)}`,
    );
  return configured;
}

export function writePrivatePromptSnapshots(
  contents: readonly string[],
): string[] {
  const root = herdsmanTempRoot();
  const prompts = join(root, "prompts");
  mkdirSync(prompts, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(prompts, 0o700);
  const paths: string[] = [];
  try {
    for (const content of contents) {
      const path = join(prompts, randomUUID());
      writeFileSync(path, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      paths.push(path);
      chmodSync(path, 0o600);
    }
    return paths;
  } catch (error) {
    for (const path of paths) unlinkSync(path);
    throw error;
  }
}

export function expandAgentBodyFiles(
  body: string,
  skipCanonicalPaths: readonly string[],
  operation: string,
): string {
  const references = [...body.matchAll(BODY_FILE_REFERENCE)].map(
    (match) => match[1]!,
  );
  if (references.length === 0) return body;
  const snapshots = snapshotTextFiles(references, process.cwd(), operation, {
    skipCanonicalPaths,
  });
  const remaining = new Map(
    snapshots.map((snapshot) => [snapshot.input, snapshot.text]),
  );
  return body.replace(BODY_FILE_REFERENCE, (_match, input: string) => {
    const text = remaining.get(input);
    if (text === undefined) return "";
    remaining.delete(input);
    return text;
  });
}

export function agentDefinitionDelegationEnabled(
  definition: AgentDefinition,
): boolean {
  return (definition.frontmatter.agents?.length ?? 0) > 0;
}

export type AgentLaunchOptions = {
  bodyPromptPath?: string;
  sharedPromptPath?: string;
  cwd?: string;
  managedAgent?: boolean;
  approveProject?: boolean;
  inheritedModel?: string;
  inheritedThinking?: string;
  /**
   * Pre-computed model decision for this child. When omitted, the requested
   * model (configured, else inherited) is passed through unchanged.
   */
  modelDecision?: ChildModelDecision;
};

export function agentLaunchArgs(
  agent: AgentDefinition,
  options: AgentLaunchOptions,
): string[] {
  const {
    bodyPromptPath,
    sharedPromptPath,
    cwd,
    managedAgent,
    approveProject,
    inheritedModel,
    inheritedThinking,
  } = {
    bodyPromptPath: options.bodyPromptPath,
    sharedPromptPath: options.sharedPromptPath,
    cwd: options.cwd ?? process.cwd(),
    managedAgent: options.managedAgent ?? false,
    approveProject: options.approveProject ?? false,
    inheritedModel: options.inheritedModel,
    inheritedThinking: options.inheritedThinking,
  };
  const bodyPromptPathForLaunch = agent.body ? bodyPromptPath : undefined;
  const { frontmatter } = agent;
  if (agent.body && bodyPromptPathForLaunch === undefined)
    throw new Error(
      `agent ${agent.name} has a body but no bodyPromptPath was provided`,
    );
  const args: string[] = [];
  if (approveProject) args.push("--approve");
  const requestedModel = configuredModel(frontmatter) ?? inheritedModel;
  const decision =
    options.modelDecision ??
    (requestedModel === undefined
      ? { kind: "none" as const }
      : {
          kind: "use" as const,
          model: requestedModel,
          extensionDiscovery: false,
        });
  if (decision.kind === "use") args.push("--model", decision.model);

  const thinking = configuredThinking(agent) ?? inheritedThinking;
  if (thinking !== undefined) {
    args.push("--thinking", thinking);
  }

  const mode =
    frontmatter.systemPromptMode ??
    (agent.name === "delegate" ? "append" : "replace");
  if (!SYSTEM_PROMPT_MODES.has(mode))
    throw new Error(
      `agent ${agent.name} has invalid systemPromptMode: ${JSON.stringify(mode)}`,
    );
  if (bodyPromptPathForLaunch !== undefined)
    args.push(
      mode === "append" ? "--append-system-prompt" : "--system-prompt",
      bodyPromptPathForLaunch,
    );
  const inheritProjectContext =
    frontmatter.inheritProjectContext ?? agent.name === "delegate";
  const inheritGlobalContext =
    frontmatter.inheritGlobalContext ?? inheritProjectContext;
  if (inheritProjectContext !== true || inheritGlobalContext !== true) {
    args.push("--no-context-files");
    if (inheritProjectContext === true || inheritGlobalContext === true) {
      const agentDir = getAgentDir();
      for (const context of loadProjectContextFiles({ cwd, agentDir })) {
        const isGlobal = resolve(dirname(context.path)) === resolve(agentDir);
        if (
          (isGlobal && inheritGlobalContext === true) ||
          (!isGlobal && inheritProjectContext === true)
        )
          args.push("--append-system-prompt", context.path);
      }
    }
  }
  if (sharedPromptPath) args.push("--append-system-prompt", sharedPromptPath);
  if (managedAgent)
    args.push("--append-system-prompt", `<active_agent name="${agent.name}"/>`);

  const explicitTools = frontmatter.tools !== undefined;
  const noTools =
    frontmatter.noTools || (explicitTools && frontmatter.tools.length === 0);
  if (noTools) args.push("--no-tools");
  if (frontmatter.noBuiltinTools) args.push("--no-builtin-tools");
  if (managedAgent) {
    if (noTools || explicitTools) {
      const requiredTools = agentDefinitionDelegationEnabled(agent)
        ? [...AGENT_COORDINATION_TOOLS, "ask_owner"]
        : ["ask_owner"];
      const tools = [
        ...new Set([
          ...(noTools
            ? []
            : normalizedToolNames(frontmatter.tools).filter(
                (tool) => !requiredTools.includes(tool),
              )),
          ...requiredTools,
        ]),
      ];
      args.push("--tools", tools.join(","));
    }
    const requiredTools = new Set([
      "ask_owner",
      ...(agentDefinitionDelegationEnabled(agent)
        ? AGENT_COORDINATION_TOOLS
        : []),
    ]);
    const excluded = normalizedToolNames(frontmatter.excludeTools)
      .filter((tool) => !requiredTools.has(tool))
      .filter((tool, index, all) => all.indexOf(tool) === index);
    if (excluded.length) args.push("--exclude-tools", excluded.join(","));
  } else {
    if (frontmatter.tools?.length)
      args.push("--tools", frontmatter.tools.join(","));
    if (frontmatter.excludeTools?.length)
      args.push("--exclude-tools", frontmatter.excludeTools.join(","));
  }

  const noSkills = frontmatter.noSkills ?? frontmatter.inheritSkills !== true;
  if (noSkills) args.push("--no-skills");
  for (const skill of frontmatter.skills ?? []) args.push("--skill", skill);

  // A model whose provider comes from an extension cannot resolve inside a
  // child denied extension discovery, so the model's needs outrank the
  // definition's preference to stay lean.
  const extensionDiscovery =
    decision.kind === "use" && decision.extensionDiscovery;
  if (frontmatter.noExtensions && !extensionDiscovery)
    args.push("--no-extensions");
  for (const extension of frontmatter.extensions ?? [])
    args.push("--extension", extension);
  return args;
}
