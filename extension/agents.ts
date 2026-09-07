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
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { snapshotTextFiles } from "./core.ts";

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
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
  "workers",
]);
const SUPPORTED_FIELDS = new Set([
  "name",
  "description",
  ...STRING_FIELDS,
  ...BOOLEAN_CAPABILITY_FIELDS,
  ...ARRAY_FIELDS,
]);
const BODY_FILE_REFERENCE = /^[ \t]*@((?:\/|~\/|\.\.?\/).+?)[ \t]*$/gmu;
const BUILTIN_AGENT_DIR = fileURLToPath(
  new URL("./agent-definitions", import.meta.url),
);

export type FrontmatterValue =
  string | boolean | string[] | { [key: string]: unknown };
export type Frontmatter = {
  enabled?: boolean;
  model?: string;
  thinking?: string | false;
  bodyMode?: string;
  noTools?: boolean;
  noBuiltinTools?: boolean;
  tools?: string[];
  excludeTools?: string[];
  noSkills?: boolean;
  skills?: string[];
  noExtensions?: boolean;
  extensions?: string[];
  workers?: string[];
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

export function parseFrontmatter(
  content: string,
): { frontmatter: Frontmatter; body: string } | undefined {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end < 0) return undefined;

  const frontmatter: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1];
    const raw = match[2].trim();
    if (!SUPPORTED_FIELDS.has(field))
      throw new Error(`${field} is not a supported agent-definition field`);
    if (ARRAY_FIELDS.has(field)) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(
          `${field} must be an inline array of non-empty strings`,
        );
      }
      if (
        !Array.isArray(value) ||
        value.some(
          (entry) => typeof entry !== "string" || entry.trim().length === 0,
        ) ||
        (field === "workers" && new Set(value).size !== value.length)
      )
        throw new Error(
          field === "workers"
            ? "workers must be an inline array of unique non-empty strings"
            : `${field} must be an inline array of non-empty strings`,
        );
      frontmatter[field] = value;
      continue;
    }
    if (
      STRING_FIELDS.has(field) &&
      (raw.startsWith("[") ||
        raw === "null" ||
        /^[-+]?\d(?:[\d.eE+-]*)$/u.test(raw))
    ) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(`${field} must be a string`);
      }
      frontmatter[field] = value as FrontmatterValue;
      continue;
    }
    if (BOOLEAN_CAPABILITY_FIELDS.has(field) && raw.startsWith("{"))
      throw new Error(`${field} must be a boolean`);
    if (raw.startsWith("{")) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(`${field} must be an inline JSON object`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${field} must be an inline JSON object`);
      frontmatter[field] = value as { [key: string]: unknown };
      continue;
    }
    let value: string | boolean = raw;
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === "'" || value[0] === '"')
    ) {
      value = value.slice(1, -1);
    } else if (value.toLowerCase() === "true") {
      value = true;
    } else if (value.toLowerCase() === "false") {
      value = false;
    }
    if (BOOLEAN_CAPABILITY_FIELDS.has(field) && typeof value !== "boolean")
      throw new Error(`${field} must be a boolean`);
    frontmatter[field] = value;
  }
  return {
    frontmatter,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

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
      const content = readFileSync(path, "utf8");
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const field = /^([A-Za-z0-9_-]+)\s/u.exec(message)?.[1];
        const name = /^name:\s*["']?([^"'\r\n]+)["']?\s*$/mu.exec(content)?.[1];
        throw new Error(
          `${path}${name ? ` agent ${name}` : ""}${field ? ` field ${field}` : ""}: ${message}`,
        );
      }
      const name = parsed?.frontmatter.name;
      if (!parsed || typeof name !== "string" || name.length === 0)
        throw new Error(`invalid agent definition: ${path}`);
      return {
        name,
        path,
        frontmatter: parsed.frontmatter,
        body: resolveBodyFileReferences(parsed.body, path),
      };
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
  return body.replace(
    BODY_FILE_REFERENCE,
    (_match, input: string) =>
      `@${
        input.startsWith("~/")
          ? resolve(homedir(), input.slice(2))
          : input.startsWith("/")
            ? input
            : resolve(dirname(definitionPath), input)
      }`,
  );
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
  const merge = (left: unknown, right: unknown): unknown => {
    if (isPlainObject(left) && isPlainObject(right)) {
      const merged: { [key: string]: unknown } = { ...left };
      for (const [key, value] of Object.entries(right))
        merged[key] = merge(merged[key], value);
      return merged;
    }
    return right;
  };
  return merge(base, override) as Frontmatter;
}

function validateDefinition(definition: AgentDefinition): void {
  const { frontmatter, name, overrideSource, projectSource, extensionSource } =
    definition;
  const source =
    overrideSource ?? projectSource ?? extensionSource ?? definition.path;
  const invalid = (field: string, reason: string): never => {
    throw new Error(`${source} agent ${name} field ${field}: ${reason}`);
  };
  for (const field of Object.keys(frontmatter))
    if (!SUPPORTED_FIELDS.has(field))
      invalid(field, "is not a supported agent-definition field");
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
        (field === "workers" && new Set(value).size !== value.length))
    )
      invalid(
        field,
        field === "workers"
          ? "must be an inline array of unique non-empty strings"
          : "must be an inline array of non-empty strings",
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
  if (frontmatter.bodyMode !== undefined)
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
  const mode = definition.frontmatter.bodyMode;
  if (mode === undefined) return "replace";
  if (typeof mode !== "string" || !BODY_MODES.has(mode))
    throw new Error(
      `${definition.path} agent ${definition.name} field bodyMode: must be append or replace`,
    );
  return mode as BodyMode;
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
    for (const reference of definition.frontmatter.workers ?? [])
      if (!names.has(reference))
        throw new Error(
          `agent ${definition.name} references missing worker ${reference}`,
        );
  return effective.map((definition) =>
    inferAgentDefinitionTools({
      ...definition,
      frontmatter: {
        ...definition.frontmatter,
        enabled: definition.frontmatter.enabled ?? true,
      },
    }),
  );
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

export function validateAgentDefinitionWorkers(
  definition: AgentDefinition,
  definitions: readonly AgentDefinition[],
): void {
  const byName = new Map(
    definitions.map((candidate) => [candidate.name, candidate]),
  );
  for (const reference of definition.frontmatter.workers ?? []) {
    const worker = byName.get(reference);
    if (!worker)
      throw new Error(
        `agent ${definition.name} references missing worker ${reference}`,
      );
    if (!agentDefinitionEnabled(worker))
      throw new Error(
        `agent ${definition.name} references disabled worker ${reference}; enable ${reference} before assigning ${definition.name}`,
      );
  }
}

export type AgentDefinitionScope = "delegating" | "leaf";

function withoutDelegationCapability(
  definition: AgentDefinition,
): AgentDefinition {
  const { workers: _workers, tools, ...frontmatter } = definition.frontmatter;
  if (tools === undefined)
    return {
      ...definition,
      frontmatter,
    };
  const projectedTools = tools
    .flatMap((tool) => tool.split(","))
    .map((tool) => tool.trim())
    .filter((tool) => tool && tool !== "worker");
  return {
    ...definition,
    frontmatter: {
      ...frontmatter,
      ...(tools.length > 0 && projectedTools.length === 0
        ? { noTools: true }
        : {}),
      tools: projectedTools,
    },
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
    ...(frontmatter.workers === undefined
      ? {}
      : { workers: frontmatter.workers }),
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

function configuredModel(frontmatter: Frontmatter): string | undefined {
  return typeof frontmatter.model === "string" && frontmatter.model
    ? frontmatter.model
    : undefined;
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
  const root = join(
    tmpdir(),
    "pi-herdsman",
    String(process.getuid?.() ?? "user"),
  );
  const privateRoot = join(tmpdir(), "pi-herdsman");
  const prompts = join(root, "prompts");
  mkdirSync(prompts, { recursive: true, mode: 0o700 });
  chmodSync(privateRoot, 0o700);
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

export function inferAgentDefinitionTools(
  definition: AgentDefinition,
): AgentDefinition {
  const workers = definition.frontmatter.workers ?? [];
  if (workers.length === 0) return definition;
  const tools = (definition.frontmatter.tools ?? [])
    .flatMap((tool) => tool.split(","))
    .map((tool) => tool.trim())
    .filter(Boolean);
  const excluded = new Set(
    (definition.frontmatter.excludeTools ?? [])
      .flatMap((tool) => tool.split(","))
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
  if (
    excluded.has("worker") ||
    (definition.frontmatter.noTools === true && !tools.includes("worker")) ||
    tools.length === 0 ||
    tools.includes("worker")
  )
    return definition;
  return {
    ...definition,
    frontmatter: {
      ...definition.frontmatter,
      tools: [...(definition.frontmatter.tools ?? []), "worker"],
    },
  };
}

export function agentDefinitionDelegationEnabled(
  definition: AgentDefinition,
): boolean {
  if ((definition.frontmatter.workers?.length ?? 0) === 0) return false;
  const tools = (definition.frontmatter.tools ?? [])
    .flatMap((tool) => tool.split(","))
    .map((tool) => tool.trim())
    .filter(Boolean);
  const excluded = (definition.frontmatter.excludeTools ?? [])
    .flatMap((tool) => tool.split(","))
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (excluded.includes("worker")) return false;
  if (definition.frontmatter.noTools === true && !tools.includes("worker"))
    return false;
  return definition.frontmatter.tools === undefined || tools.length > 0;
}

export type AgentLaunchOptions = {
  bodyPromptPath?: string;
  sharedPromptPath?: string;
  cwd?: string;
  managedWorker?: boolean;
  approveProject?: boolean;
};

export function agentLaunchArgs(
  agent: AgentDefinition,
  options: AgentLaunchOptions,
): string[] {
  const {
    bodyPromptPath,
    sharedPromptPath,
    cwd,
    managedWorker,
    approveProject,
  } = {
    bodyPromptPath: options.bodyPromptPath,
    sharedPromptPath: options.sharedPromptPath,
    cwd: options.cwd ?? process.cwd(),
    managedWorker: options.managedWorker ?? false,
    approveProject: options.approveProject ?? false,
  };
  const bodyPromptPathForLaunch = agent.body ? bodyPromptPath : undefined;
  const { frontmatter } = agent;
  if (agent.body && bodyPromptPathForLaunch === undefined)
    throw new Error(
      `agent ${agent.name} has a body but no bodyPromptPath was provided`,
    );
  const args: string[] = [];
  if (approveProject) args.push("--approve");
  const model = configuredModel(frontmatter);
  if (model) args.push("--model", model);

  const thinking = configuredThinking(agent);
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

  if (frontmatter.noTools) args.push("--no-tools");
  if (frontmatter.noBuiltinTools) args.push("--no-builtin-tools");
  if (managedWorker) {
    if (frontmatter.noTools || frontmatter.tools?.length) {
      const tools = [...(frontmatter.tools ?? []), "ask_owner"]
        .flatMap((tool) => tool.split(","))
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
        .filter((tool, index, all) => all.indexOf(tool) === index);
      args.push("--tools", tools.join(","));
    }
    const excluded = (frontmatter.excludeTools ?? [])
      .flatMap((tool) => tool.split(","))
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0 && tool !== "ask_owner")
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

  if (frontmatter.noExtensions) args.push("--no-extensions");
  for (const extension of frontmatter.extensions ?? [])
    args.push("--extension", extension);
  return args;
}
