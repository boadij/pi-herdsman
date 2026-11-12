import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadProjectContextFiles,
  parseFrontmatter as parsePiFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
const THINKING_LEVELS = new Set<string>(VALID_THINKING_LEVELS);
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
const BUILTIN_AGENT_DIR = fileURLToPath(new URL("./agents", import.meta.url));

const BUILTIN_ROLE_DIR = fileURLToPath(
  new URL("./coordinators", import.meta.url),
);

export const FLEXIBLE_LEAD_DEFINITION_NAME = "flexible-lead";
export const ORCHESTRATOR_LEAD_DEFINITION_NAME = "orchestrator-lead";
export const MANAGED_LEAD_DEFINITION_NAME = "managed-lead";
export const MANAGER_DEFINITION_NAME = "manager";
export const CHIEF_DEFINITION_NAME = "chief";
export const RESERVED_ROLE_DEFINITION_NAMES = [
  FLEXIBLE_LEAD_DEFINITION_NAME,
  ORCHESTRATOR_LEAD_DEFINITION_NAME,
  MANAGED_LEAD_DEFINITION_NAME,
  MANAGER_DEFINITION_NAME,
  CHIEF_DEFINITION_NAME,
] as const;
const RESERVED_ROLE_DEFINITION_NAME_SET = new Set<string>(
  RESERVED_ROLE_DEFINITION_NAMES,
);

export function isReservedRoleDefinition(name: string): boolean {
  return RESERVED_ROLE_DEFINITION_NAME_SET.has(name);
}

export function isRuntimeRoleDefinition(name: string): boolean {
  return (
    isReservedRoleDefinition(name) && name !== MANAGED_LEAD_DEFINITION_NAME
  );
}
const RUNTIME_LEAD_FIELDS = new Set([
  "name",
  "description",
  "bodyMode",
  "tools",
  "excludeTools",
  "agents",
]);

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
  privateRepositorySource?: string;
};

export const AGENT_COORDINATION_TOOLS = [
  "list_agents",
  "delegate_agent",
  "continue_agent",
  "steer_agent",
  "interrupt_agent",
  "reply_agent",
  "stop_agent",
  "inspect_agent",
  "read_agent_transcript",
] as const;

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    // Dotfile managers deploy definitions as symlinks; reading follows them.
    return (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith(".md")
      ? [path]
      : [];
  });
}

function readAgentDefinitions(
  root: string,
  category?: "agent" | "role",
  onWarning?: (message: string) => void,
): AgentDefinition[] {
  const definitions = markdownFiles(root)
    .filter((path) => !path.endsWith(".example.md"))
    .sort()
    .flatMap((path) => {
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
      const name = parsed.frontmatter.name;
      if (
        category &&
        typeof name === "string" &&
        name.length > 0 &&
        isReservedRoleDefinition(name) !== (category === "role")
      ) {
        const destination = join(
          dirname(root),
          category === "agent" ? "coordinators" : "agents",
          relative(root, path),
        );
        onWarning?.(
          `${path}: definition belongs in ${destination}; file excluded from discovery`,
        );
        return [];
      }
      const frontmatter = parsed.frontmatter as Frontmatter;
      const definition: AgentDefinition = {
        name: typeof frontmatter.name === "string" ? frontmatter.name : "",
        path,
        frontmatter,
        body: resolveBodyFileReferences(parsed.body, path),
      };
      validateDefinition(definition, { allowBodyMode: true });
      return [definition];
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

const isArrayModifier = (entry: string): boolean =>
  entry.startsWith("+") || entry.startsWith("-");

function validateArrayFields(
  frontmatter: Frontmatter,
  invalid: (field: string, reason: string) => never,
): void {
  for (const field of ARRAY_FIELDS) {
    const value = frontmatter[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.some(
          (entry) => typeof entry !== "string" || entry.trim().length === 0,
        ) ||
        (field === "agents" &&
          new Set(value.filter((entry) => !isArrayModifier(entry))).size !==
            value.filter((entry) => !isArrayModifier(entry)).length))
    )
      invalid(
        field,
        field === "agents"
          ? "must be an array with unique explicit names and non-empty modifiers"
          : "must be an array of non-empty strings",
      );
    if (Array.isArray(value)) {
      const entries =
        field === "tools"
          ? normalizedToolNames(value as string[])
          : (value as string[]);
      for (const entry of entries)
        if (
          isArrayModifier(entry) &&
          (!entry.slice(1).trim() ||
            (field === "tools" && entry.slice(1).trim().includes("*")))
        )
          invalid(
            field,
            field === "tools"
              ? "modifiers require exact tool names without wildcards"
              : "modifiers require a non-empty name",
          );
    }
  }
}

function applyArrayModifiers(
  base: readonly string[],
  entries: readonly string[],
): string[] {
  const plain = entries.filter((entry) => !isArrayModifier(entry));
  const result =
    plain.length > 0 || entries.length === 0 ? [...new Set(plain)] : [...base];
  for (const entry of entries) {
    if (!isArrayModifier(entry)) continue;
    const value = entry.slice(1);
    const index = result.indexOf(value);
    if (entry[0] === "+" && index < 0) result.push(value);
    if (entry[0] === "-" && index >= 0) result.splice(index, 1);
  }
  return result;
}

function composeFrontmatter(
  base: Frontmatter | undefined,
  override: Frontmatter,
  definitionName: string,
): Frontmatter {
  validateArrayFields(override, (field, reason) => {
    throw new Error(`agent ${definitionName} field ${field}: ${reason}`);
  });
  const effective: Frontmatter = { ...base, ...override };
  for (const field of ARRAY_FIELDS) {
    const rawEntries = override[field];
    if (!Array.isArray(rawEntries)) continue;
    const entries =
      field === "tools"
        ? normalizedToolNames(rawEntries as string[])
        : rawEntries;
    const baseEntries = base?.[field];
    if (!entries.some((entry) => isArrayModifier(entry as string))) continue;
    if (field === "tools") {
      const normalized = normalizedToolNames(entries as string[]);
      if (baseEntries === undefined) {
        effective.tools =
          normalized.length > 0 && normalized.every(isArrayModifier)
            ? normalized
            : applyArrayModifiers([], normalized);
        continue;
      }
      const inheritedTools = normalizedToolNames(baseEntries as string[]);
      const inheritedRelative =
        inheritedTools.length > 0 && inheritedTools.every(isArrayModifier);
      if (
        inheritedRelative &&
        normalized.length > 0 &&
        normalized.every(isArrayModifier)
      ) {
        effective.tools = [...inheritedTools, ...normalized];
        continue;
      }
    }
    if (
      field === "agents" &&
      baseEntries === undefined &&
      [
        FLEXIBLE_LEAD_DEFINITION_NAME,
        ORCHESTRATOR_LEAD_DEFINITION_NAME,
        MANAGED_LEAD_DEFINITION_NAME,
      ].includes(
        definitionName as (typeof RESERVED_ROLE_DEFINITION_NAMES)[number],
      ) &&
      entries.every((entry) => isArrayModifier(entry as string))
    )
      throw new Error(
        `agent ${definitionName} field agents: modifier-only overlays require an explicit agents allowlist`,
      );
    const inherited =
      field === "tools"
        ? normalizedToolNames(baseEntries as string[] | undefined)
        : ((baseEntries as string[] | undefined) ?? []);
    const normalized =
      field === "tools"
        ? normalizedToolNames(entries as string[])
        : (entries as string[]);
    effective[field] = applyArrayModifiers(inherited, normalized);
  }
  return effective;
}

export function mergeFrontmatter(
  base: Frontmatter,
  override: Frontmatter,
): Frontmatter {
  return composeFrontmatter(
    base,
    override,
    String(override.name ?? base.name ?? ""),
  );
}

function validateDefinition(
  definition: AgentDefinition,
  options: { allowBodyMode?: boolean } = {},
): void {
  const { frontmatter, name } = definition;
  const source = definition.path;
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
  validateArrayFields(frontmatter, invalid);
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

export function matchesToolPattern(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "u").test(name);
}

export type ConfiguredToolPolicy = {
  mode: "inherit" | "relative" | "explicit";
  explicit: boolean;
  tools: string[];
  excluded: string[];
};

export function configuredToolPolicy(
  definition: AgentDefinition,
  requiredTools: readonly string[],
): ConfiguredToolPolicy {
  const configured = normalizedToolNames(definition.frontmatter.tools);
  const relative =
    definition.frontmatter.tools !== undefined &&
    configured.length > 0 &&
    configured.every(isArrayModifier);
  const mode: ConfiguredToolPolicy["mode"] =
    definition.frontmatter.tools === undefined
      ? "inherit"
      : relative
        ? "relative"
        : "explicit";
  const required = new Set(requiredTools);
  const terminal = new Map<string, boolean>();
  if (relative)
    for (const operation of configured) {
      const name = operation.slice(1);
      terminal.set(name, operation[0] === "-");
    }
  const removed = [...terminal]
    .filter(([, isRemoved]) => isRemoved)
    .map(([name]) => name);
  const forbiddenRequired = removed.find((name) => required.has(name));
  if (forbiddenRequired)
    throw new Error(
      `agent ${definition.name} tools modifier cannot remove required tool ${JSON.stringify(forbiddenRequired)}`,
    );
  const excluded = [
    ...normalizedToolNames(definition.frontmatter.excludeTools),
    ...removed,
  ]
    .filter((pattern) => !required.has(pattern))
    .filter((pattern, index, all) => all.indexOf(pattern) === index);
  for (const pattern of excluded) {
    if (!pattern.includes("*")) continue;
    const matched = requiredTools.find((tool) =>
      matchesToolPattern(pattern, tool),
    );
    if (matched)
      throw new Error(
        `agent ${definition.name} excludeTools pattern ${JSON.stringify(pattern)} ` +
          `matches required tool ${JSON.stringify(matched)}; ` +
          `required tools cannot be excluded by patterns`,
      );
  }
  return {
    mode,
    explicit: mode === "explicit",
    tools: configured.filter(
      (tool) => !isArrayModifier(tool) && !required.has(tool),
    ),
    excluded,
  };
}

export function toolPolicyAllowsName(
  policy: ReturnType<typeof configuredToolPolicy>,
  requiredTools: ReadonlySet<string>,
  name: string,
): boolean {
  if (requiredTools.has(name)) return true;
  if (policy.excluded.some((pattern) => matchesToolPattern(pattern, name)))
    return false;
  return (
    policy.mode !== "explicit" ||
    policy.tools.some((pattern) => matchesToolPattern(pattern, name))
  );
}

function readOptionalAgentDefinitions(
  root: string,
  category: "agent" | "role",
  onWarning?: (message: string) => void,
): AgentDefinition[] {
  const stats = statSync(root, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory())
    throw new Error(`agent directory is not a directory: ${root}`);
  return readAgentDefinitions(root, category, onWarning);
}

function assertNoLegacyCoordinatorProfiles(
  legacy: string,
  canonical: string,
): void {
  const stats = statSync(legacy, { throwIfNoEntry: false });
  if (!stats) return;
  if (!stats.isDirectory())
    throw new Error(
      `legacy coordinator path is not a directory: ${legacy}; use ${canonical}`,
    );
  const file = markdownFiles(legacy).find(
    (path) => !path.endsWith(".example.md"),
  );
  if (file)
    throw new Error(
      `${file}: legacy coordinator profile is no longer loaded; ` +
        `move profiles and their relative assets to ${canonical}`,
    );
}

function privateRepositoryRoot(projectRoot: string): string | undefined {
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "rev-parse",
        "--is-inside-work-tree",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      {
        cwd: projectRoot,
        // The catch below matches Git's English diagnostic.
        env: { ...process.env, LC_ALL: "C" },
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 8_192,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch (error) {
    const failure = error as Error & {
      code?: string;
      status?: number | null;
      stderr?: Buffer | string;
    };
    const diagnostic = failure.stderr?.toString() ?? "";
    if (
      failure.code === "ENOENT" ||
      (failure.status === 128 && /not a git repository/u.test(diagnostic))
    )
      return undefined;
    throw new Error(
      `Cannot resolve private definitions for ${projectRoot}: ${diagnostic.trimEnd() || failure.message}`,
      { cause: error },
    );
  }
  const [inside, commonDir, ...extra] = output.trimEnd().split(/\r?\n/u);
  if (inside === "false") return undefined;
  if (inside !== "true" || !commonDir || !isAbsolute(commonDir) || extra.length)
    throw new Error(`Invalid Git common-directory result for ${projectRoot}`);
  return join(realpathSync(commonDir), "pi-herdsman");
}

type DefinitionLayerSource =
  "projectSource" | "overrideSource" | "privateRepositorySource";

export type DefinitionLayerTrace = {
  scope: "bundled" | "global" | "project" | "private";
  path: string;
  supplied: Frontmatter;
  before?: Frontmatter;
  after: Frontmatter;
  body: string;
  bodyAction: "base" | "inherit" | "append" | "replace";
};

export type DefinitionInspection = {
  definition: AgentDefinition;
  layers: DefinitionLayerTrace[];
  bodyFragments: DefinitionBodyFragment[];
};

type DefinitionTraceCapture = {
  name: string;
  layers: DefinitionLayerTrace[];
  bodyFragments: Array<{
    path: string;
    scope: DefinitionLayerTrace["scope"];
    body: string;
  }>;
};

function sourceScope(
  field: DefinitionLayerSource,
): DefinitionLayerTrace["scope"] {
  return field === "projectSource"
    ? "project"
    : field === "overrideSource"
      ? "global"
      : "private";
}

function applyDefinitionLayer(
  definitions: Map<string, AgentDefinition>,
  layer: readonly AgentDefinition[],
  sourceField: DefinitionLayerSource,
  trace?: DefinitionTraceCapture,
): void {
  for (const definition of layer) {
    const base = definitions.get(definition.name);
    if (!base) {
      const standalone: AgentDefinition = {
        ...definition,
        frontmatter: composeFrontmatter(
          undefined,
          definition.frontmatter,
          definition.name,
        ),
        [sourceField]: definition.path,
      };
      validateDefinition(standalone);
      if (trace?.name === definition.name) {
        const scope = sourceScope(sourceField);
        trace.layers.push({
          scope,
          path: definition.path,
          supplied: definition.frontmatter,
          after: standalone.frontmatter,
          body: definition.body,
          bodyAction: "base",
        });
        trace.bodyFragments = definition.body
          ? [{ path: definition.path, scope, body: definition.body }]
          : [];
      }
      definitions.set(definition.name, standalone);
      continue;
    }
    const mode = overrideBodyMode(definition);
    const { bodyMode: _bodyMode, ...overrideFrontmatter } =
      definition.frontmatter;
    const effective: AgentDefinition = {
      name: base.name,
      path: definition.path,
      frontmatter: composeFrontmatter(
        base.frontmatter,
        overrideFrontmatter,
        definition.name,
      ),
      body: mergeDefinitionBody(base.body, definition.body, mode),
      extensionSource: base.extensionSource,
      projectSource: base.projectSource,
      overrideSource: base.overrideSource,
      privateRepositorySource: base.privateRepositorySource,
      [sourceField]: definition.path,
    };
    validateDefinition(effective);
    if (trace?.name === definition.name) {
      const scope = sourceScope(sourceField);
      trace.layers.push({
        scope,
        path: definition.path,
        supplied: definition.frontmatter,
        before: base.frontmatter,
        after: effective.frontmatter,
        body: definition.body,
        bodyAction: definition.body ? mode : "inherit",
      });
      if (definition.body) {
        trace.bodyFragments =
          mode === "append" && trace.bodyFragments.length
            ? [
                ...trace.bodyFragments,
                { path: definition.path, scope, body: definition.body },
              ]
            : [{ path: definition.path, scope, body: definition.body }];
      }
    }
    definitions.set(effective.name, effective);
  }
}

export type DiscoverAgentDefinitionsOptions = {
  projectRoot?: string;
  onWarning?: (message: string) => void;
};

function validateEffectiveAgentReferences(
  definitions: readonly AgentDefinition[],
): void {
  const agents = definitions.filter(
    ({ name }) => !isReservedRoleDefinition(name),
  );
  const names = new Set(agents.map((definition) => definition.name));
  for (const definition of agents)
    for (const reference of definition.frontmatter.agents ?? [])
      if (!names.has(reference))
        throw new Error(
          `agent ${definition.name} references missing agent definition ${reference}`,
        );
}

export function validateRoleAgentDefinitionReferences(
  definition: AgentDefinition,
  definitions: readonly AgentDefinition[],
): void {
  const byName = new Map(
    definitions.map((candidate) => [candidate.name, candidate]),
  );
  for (const reference of definition.frontmatter.agents ?? []) {
    if (isReservedRoleDefinition(reference))
      throw new Error(
        `agent ${definition.name} references reserved agent definition ${reference}`,
      );
    if (!byName.has(reference))
      throw new Error(
        `agent ${definition.name} references missing agent definition ${reference}`,
      );
  }
}

function validateManagedLeadLayer(definition: AgentDefinition): void {
  if (definition.name !== MANAGED_LEAD_DEFINITION_NAME) return;
  if (definition.frontmatter.systemPromptMode === "replace")
    throw new Error(
      `${definition.path} managed Lead field systemPromptMode: must be append`,
    );
  for (const field of ["enabled", "permission"] as const)
    if (definition.frontmatter[field] !== undefined)
      throw new Error(
        `${definition.path} managed Lead field ${field}: is not supported`,
      );
}

function validateRuntimeRoleLayer(definition: AgentDefinition): void {
  if (!isRuntimeRoleDefinition(definition.name)) return;
  for (const field of Object.keys(definition.frontmatter))
    if (!RUNTIME_LEAD_FIELDS.has(field))
      throw new Error(
        `${definition.path} ${definition.name} field ${field}: is not supported`,
      );
}

function discoverEffectiveDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
  category: "agent" | "role" = "agent",
  validateReferences = true,
  trace?: DefinitionTraceCapture,
): AgentDefinition[] {
  const role = category === "role";
  const bundled = readAgentDefinitions(
    role ? BUILTIN_ROLE_DIR : BUILTIN_AGENT_DIR,
  );
  for (const definition of bundled)
    if (isReservedRoleDefinition(definition.name) !== role)
      throw new Error(
        `${definition.path}: ${role ? "non-coordinator name in coordinators directory" : "reserved coordinator name in agents directory; use coordinators"}`,
      );
  const directory = role ? "coordinators" : "agents";
  const privateRoot = options.projectRoot
    ? privateRepositoryRoot(options.projectRoot)
    : undefined;
  if (role) {
    const globalDirectory = join(getAgentDir(), directory);
    assertNoLegacyCoordinatorProfiles(
      join(getAgentDir(), "pi-herdsman", "roles"),
      globalDirectory,
    );
    if (options.projectRoot)
      assertNoLegacyCoordinatorProfiles(
        join(options.projectRoot, CONFIG_DIR_NAME, "pi-herdsman", "roles"),
        join(options.projectRoot, CONFIG_DIR_NAME, directory),
      );
    if (privateRoot)
      assertNoLegacyCoordinatorProfiles(
        join(privateRoot, "roles"),
        join(privateRoot, directory),
      );
  }
  const project = options.projectRoot
    ? readOptionalAgentDefinitions(
        join(options.projectRoot, CONFIG_DIR_NAME, directory),
        category,
        options.onWarning,
      )
    : [];
  const privateRepository = privateRoot
    ? readOptionalAgentDefinitions(
        join(privateRoot, directory),
        category,
        options.onWarning,
      )
    : [];
  const user = readOptionalAgentDefinitions(
    join(getAgentDir(), directory),
    category,
    options.onWarning,
  );
  const definitions = new Map(
    bundled.map((definition) => [definition.name, definition]),
  );
  for (const definition of bundled) {
    if (!definition.extensionSource)
      definition.extensionSource = definition.path;
    validateDefinition(definition);
    if (trace?.name === definition.name) {
      trace.layers.push({
        scope: "bundled",
        path: definition.path,
        supplied: definition.frontmatter,
        after: definition.frontmatter,
        body: definition.body,
        bodyAction: "base",
      });
      trace.bodyFragments = definition.body
        ? [{ path: definition.path, scope: "bundled", body: definition.body }]
        : [];
    }
  }
  for (const definition of [
    ...bundled,
    ...project,
    ...user,
    ...privateRepository,
  ]) {
    validateManagedLeadLayer(definition);
    validateRuntimeRoleLayer(definition);
  }
  const projectChief = project.find(
    ({ name }) => name === CHIEF_DEFINITION_NAME,
  );
  if (projectChief)
    throw new Error(
      `${projectChief.path} chief definition: project overrides are not supported; configure chief globally instead`,
    );
  const privateChief = privateRepository.find(
    ({ name }) => name === CHIEF_DEFINITION_NAME,
  );
  if (privateChief)
    throw new Error(
      `${privateChief.path} chief definition: private repository overrides are not supported; configure chief globally instead`,
    );
  applyDefinitionLayer(definitions, user, "overrideSource", trace);
  applyDefinitionLayer(definitions, project, "projectSource", trace);
  applyDefinitionLayer(
    definitions,
    privateRepository,
    "privateRepositorySource",
    trace,
  );
  const effective = [...definitions.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (!role && validateReferences) validateEffectiveAgentReferences(effective);
  return effective;
}

export function inspectAgentDefinition(
  name: string,
  options: DiscoverAgentDefinitionsOptions = {},
): DefinitionInspection {
  const trace: DefinitionTraceCapture = { name, layers: [], bodyFragments: [] };
  const definition = discoverEffectiveDefinitions(options, "agent", true, trace)
    .filter((candidate) => !isReservedRoleDefinition(candidate.name))
    .map(withDefaultEnabled)
    .find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`agent ${name} not found`);
  if (
    trace.bodyFragments.map((fragment) => fragment.body).join("\n\n") !==
    definition.body
  )
    throw new Error(
      `Definition body trace did not reproduce effective body for ${name}`,
    );
  return {
    definition,
    layers: trace.layers,
    bodyFragments: trace.bodyFragments,
  };
}

export function inspectRoleDefinition(
  name: RoleDefinitionName,
  options: DiscoverAgentDefinitionsOptions = {},
): DefinitionInspection {
  const trace: DefinitionTraceCapture = { name, layers: [], bodyFragments: [] };
  const definition = discoverEffectiveDefinitions(
    options,
    "role",
    true,
    trace,
  ).find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`role definition ${name} not found`);
  if (definition.frontmatter.agents?.length)
    validateRoleAgentDefinitionReferences(
      definition,
      discoverAgentDefinitions(options),
    );
  if (
    trace.bodyFragments.map((fragment) => fragment.body).join("\n\n") !==
    definition.body
  )
    throw new Error(
      `Definition body trace did not reproduce effective body for ${name}`,
    );
  return {
    definition,
    layers: trace.layers,
    bodyFragments: trace.bodyFragments,
  };
}

export function discoverAgentDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition[] {
  return discoverEffectiveDefinitions(options)
    .filter(({ name }) => !isReservedRoleDefinition(name))
    .map((definition) => withDefaultEnabled(definition));
}

export function discoverGlobalAgentDefinition(
  name: string,
): AgentDefinition | undefined {
  // Global references may resolve only after a trusted project overlay is applied.
  return discoverEffectiveDefinitions({}, "agent", false)
    .filter(({ name }) => !isReservedRoleDefinition(name))
    .map(withDefaultEnabled)
    .find((definition) => definition.name === name);
}

function withDefaultEnabled(definition: AgentDefinition): AgentDefinition {
  return {
    ...definition,
    frontmatter: {
      ...definition.frontmatter,
      enabled: definition.frontmatter.enabled ?? true,
    },
  };
}

const definitionWarningSessions = new WeakMap<
  object,
  { sessionId: string | null; messages: Set<string> }
>();

export function notifyDefinitionWarning(
  ctx: ExtensionContext,
  message: string,
): void {
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId();
  let state = definitionWarningSessions.get(manager);
  if (!state || state.sessionId !== sessionId) {
    state = { sessionId, messages: new Set() };
    definitionWarningSessions.set(manager, state);
  }
  if (state.messages.has(message)) return;
  state.messages.add(message);
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else process.emitWarning(message, { code: "PI_HERDSMAN_DEFINITION" });
}

export async function contextAgentDefinitions(
  ctx: ExtensionContext,
  onWarning?: (message: string) => void,
) {
  const projectTrusted = ctx.isProjectTrusted();
  const options: DiscoverAgentDefinitionsOptions = projectTrusted
    ? { projectRoot: ctx.cwd }
    : {};
  options.onWarning = (message) => {
    notifyDefinitionWarning(ctx, message);
    onWarning?.(message);
  };
  const effective = discoverAgentDefinitions(options);
  return {
    projectTrusted,
    definitions: effective
      .filter(({ name }) => !isReservedRoleDefinition(name))
      .map(withDefaultEnabled),
    get roleDefinitions() {
      return discoverRoleDefinitions(options);
    },
  };
}

export type RoleDefinitionName =
  | typeof FLEXIBLE_LEAD_DEFINITION_NAME
  | typeof ORCHESTRATOR_LEAD_DEFINITION_NAME
  | typeof MANAGED_LEAD_DEFINITION_NAME
  | typeof MANAGER_DEFINITION_NAME
  | typeof CHIEF_DEFINITION_NAME;

export function discoverRoleDefinition(
  name: RoleDefinitionName,
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition {
  const definition = discoverEffectiveDefinitions(options, "role").find(
    (candidate) => candidate.name === name,
  );
  if (!definition) throw new Error(`role definition ${name} not found`);
  if (definition.frontmatter.agents?.length)
    validateRoleAgentDefinitionReferences(
      definition,
      discoverAgentDefinitions(options),
    );
  return definition;
}

export function discoverRoleDefinitions(
  options: DiscoverAgentDefinitionsOptions = {},
): AgentDefinition[] {
  const definitions = discoverEffectiveDefinitions(options, "role");
  return [...RESERVED_ROLE_DEFINITION_NAMES].map((name) => {
    const definition = definitions.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`role definition ${name} not found`);
    return definition;
  });
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
  if (frontmatter.tools !== undefined)
    frontmatter.tools = normalizedToolNames(frontmatter.tools).filter(
      (tool) => tool !== "agent",
    );
  return {
    ...definition,
    frontmatter,
  };
}

/**
 * Agents are numbered by generation below the root controller: an Agent
 * started by the Lead, Manager or Chief has depth 1, its children depth 2, and
 * so on. An Agent whose depth has reached `maxAgentDepth` is a leaf.
 */
export function agentScopeAtDepth(
  depth: number,
  maxAgentDepth: number,
): AgentDefinitionScope {
  return depth >= maxAgentDepth ? "leaf" : "delegating";
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
    ...(agent.privateRepositorySource === undefined
      ? {}
      : { privateRepositorySource: agent.privateRepositorySource }),
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

export type DefinitionEditScope = "global" | "project" | "private";
export type DefinitionEditTarget = { scope: DefinitionEditScope; path: string };
export type DefinitionEditSnapshot = {
  target: DefinitionEditTarget;
  content: string | null;
  frontmatter: Frontmatter;
};

function globalOverridePath(definition: AgentDefinition): string {
  return join(
    getAgentDir(),
    ...(isReservedRoleDefinition(definition.name)
      ? ["coordinators"]
      : ["agents"]),
    `${encodeURIComponent(definition.name)}.md`,
  );
}

export function definitionEditTargets(
  definition: AgentDefinition,
): DefinitionEditTarget[] {
  const targets: DefinitionEditTarget[] = [];
  if (definition.privateRepositorySource)
    targets.push({
      scope: "private",
      path: definition.privateRepositorySource,
    });
  if (definition.projectSource)
    targets.push({ scope: "project", path: definition.projectSource });
  if (definition.overrideSource)
    targets.push({ scope: "global", path: definition.overrideSource });
  if (!targets.length && definition.extensionSource)
    targets.push({ scope: "global", path: globalOverridePath(definition) });
  return targets;
}

export function readDefinitionEditSnapshot(
  definition: AgentDefinition,
  target: DefinitionEditTarget,
): DefinitionEditSnapshot {
  const expected = definitionEditTargets(definition).find(
    (candidate) => candidate.scope === target.scope,
  );
  if (!expected || expected.path !== target.path)
    throw new Error(
      `definition edit source is no longer available: ${target.path}`,
    );
  const info = lstatSync(target.path, { throwIfNoEntry: false });
  if (!info) {
    if (
      definition.extensionSource &&
      target.scope === "global" &&
      !definition.overrideSource
    )
      return { target, content: null, frontmatter: {} };
    throw new Error(`definition source is no longer available: ${target.path}`);
  }
  if (!info.isFile())
    throw new Error(`definition source is not a regular file: ${target.path}`);
  const content = readFileSync(target.path, "utf8");
  const parsed = parsePiFrontmatter<Record<string, unknown>>(
    content.replace(/^\uFEFF/u, ""),
  );
  if (parsed.frontmatter.name !== definition.name)
    throw new Error(
      `definition source name does not match ${definition.name}: ${target.path}`,
    );
  return { target, content, frontmatter: parsed.frontmatter as Frontmatter };
}

export function updateAgentOverride(
  definition: AgentDefinition,
  field: AgentOverrideField,
  value: string | boolean | undefined,
  options: {
    scope?: DefinitionEditScope;
    expectedContent?: string | null;
  } = {},
): { path: string; changed: boolean; content: string } {
  const targets = definitionEditTargets(definition);
  const target = targets.find(
    (candidate) => candidate.scope === (options.scope ?? "global"),
  );
  if (!target)
    throw new Error(
      `definition has no eligible ${options.scope ?? "global"} edit source`,
    );
  const path = target.path;
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (link?.isSymbolicLink())
    throw new Error(`refusing to replace symlinked definition: ${path}`);
  const exists = statSync(path, { throwIfNoEntry: false });
  if (
    options.expectedContent !== undefined &&
    (exists ? readFileSync(path, "utf8") : null) !== options.expectedContent
  )
    throw new Error(
      `Definition changed while editing: ${path}. Reopen the setting.`,
    );
  if (value === undefined && !exists) {
    return { path, changed: false, content: "" };
  }

  let content: string;
  let mode = 0o600;
  if (exists) {
    if (!exists.isFile())
      throw new Error(`agent override is not a file: ${path}`);
    content = readFileSync(path, "utf8");
    if (
      parsePiFrontmatter<Record<string, unknown>>(
        content.replace(/^\uFEFF/u, ""),
      ).frontmatter.name !== definition.name
    )
      throw new Error(
        `definition source name does not match ${definition.name}: ${path}`,
      );
    mode = exists.mode & 0o777;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    content = `---\nname: ${JSON.stringify(definition.name)}\n---\n`;
  }

  const lines = [...content.matchAll(/.*(?:\r\n|\n|\r|$)/g)].filter(
    (match) => match[0].length > 0,
  );
  if (
    lines[0]?.[0]
      .replace(/^\uFEFF/u, "")
      .replace(/\r?\n|\r$/u, "")
      .trim() !== "---"
  )
    throw new Error(`invalid agent override frontmatter: ${path}`);
  const closing = lines.findIndex(
    (match, index) =>
      index > 0 && match[0].replace(/\r?\n|\r$/u, "").trim() === "---",
  );
  if (closing < 0)
    throw new Error(`invalid agent override frontmatter: ${path}`);
  const eol = content.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const fieldLine = new RegExp(`^${field}:\\s*`);
  const existingIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      index < closing &&
      fieldLine.test(line[0].replace(/\r?\n|\r$/u, "")),
  );
  const hadField = existingIndex !== -1;
  if (value === undefined && hadField) {
    const next = lines
      .slice(existingIndex + 1, closing)
      .find(([text]) => text.trim() && !text.trimStart().startsWith("#"));
    if (next && /^[ \t]/u.test(next[0]))
      throw new Error(`cannot safely remove multiline ${field} in ${path}`);
  }
  if (
    !hadField &&
    Object.hasOwn(parsePiFrontmatter(content).frontmatter, field)
  ) {
    throw new Error(`cannot safely edit ${field} in ${path}`);
  }
  const updated = lines
    .map((line, index) => {
      if (index === existingIndex) {
        if (value === undefined) return "";
        const ending = line[0].match(/\r\n|\n|\r$/u)?.[0] ?? "";
        return `${field}: ${value}${ending}`;
      }
      if (index === closing && !hadField && value !== undefined)
        return `${field}: ${value}${eol}${line[0]}`;
      return line[0];
    })
    .join("");
  const parsed = parsePiFrontmatter(updated).frontmatter;
  if (
    value === undefined ? Object.hasOwn(parsed, field) : parsed[field] !== value
  ) {
    throw new Error(`invalid ${field} override in ${path}`);
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
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current?.isSymbolicLink())
      throw new Error(`refusing to replace symlinked definition: ${path}`);
    if (
      (current ? readFileSync(path, "utf8") : null) !==
      (exists ? content : null)
    )
      throw new Error(
        `Definition changed while editing: ${path}. Reopen the setting.`,
      );
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
  | { kind: "none"; extensionDiscovery: boolean }
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
  /** Selection already stored in a resumed Pi session; never passed as CLI model. */
  saved?: { provider: string; modelId: string };
  /** Historical model entries conflict and cannot be resolved in this registry. */
  savedUnresolved?: boolean;
  /** True when `providerId` is registered by an extension. */
  isForeignProvider: (providerId: string) => boolean;
  isKnownModel?: (providerId: string, modelId: string) => boolean;
}): ChildModelDecision {
  if (input.configured !== undefined && input.configured.trim() !== "") {
    const model = input.configured;
    let extensionDiscovery = false;

    for (
      let slash = model.lastIndexOf("/");
      slash > 0;
      slash = model.lastIndexOf("/", slash - 1)
    ) {
      if (input.isForeignProvider(model.slice(0, slash).trim().toLowerCase())) {
        extensionDiscovery = true;
        break;
      }
    }

    return { kind: "use", model, extensionDiscovery };
  }
  if (input.inherited === undefined) {
    const saved = input.saved;
    return {
      kind: "none",
      extensionDiscovery:
        input.savedUnresolved === true ||
        (!!saved &&
          (input.isForeignProvider(saved.provider) ||
            (input.isKnownModel !== undefined &&
              !input.isKnownModel(saved.provider, saved.modelId)))),
    };
  }
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

export type DefinitionBodyFragment = {
  path: string;
  scope: DefinitionLayerTrace["scope"];
  body: string;
};

export type ExpandedDefinitionBodyPart = {
  text: string;
  filePath?: string;
};

export function expandDefinitionBodyFragmentsWithSources(
  fragments: readonly DefinitionBodyFragment[],
  skipCanonicalPaths: readonly string[],
  operation: string,
): ExpandedDefinitionBodyPart[][] {
  const references = fragments.flatMap(({ body }) =>
    [...body.matchAll(BODY_FILE_REFERENCE)].map((match) => match[1]!),
  );
  const snapshots = references.length
    ? snapshotTextFiles(references, process.cwd(), operation, {
        skipCanonicalPaths,
      })
    : [];
  const remaining = new Map(
    snapshots.map((snapshot) => [snapshot.input, snapshot]),
  );
  return fragments.map(({ body }) => {
    const parts: ExpandedDefinitionBodyPart[] = [];
    let cursor = 0;
    for (const match of body.matchAll(BODY_FILE_REFERENCE)) {
      const index = match.index!;
      if (index > cursor) parts.push({ text: body.slice(cursor, index) });
      const snapshot = remaining.get(match[1]!);
      if (snapshot) {
        parts.push({ text: snapshot.text, filePath: snapshot.path });
        remaining.delete(match[1]!);
      }
      cursor = index + match[0].length;
    }
    if (cursor < body.length) parts.push({ text: body.slice(cursor) });
    return parts;
  });
}

export function expandDefinitionBodyFragments(
  fragments: readonly DefinitionBodyFragment[],
  skipCanonicalPaths: readonly string[],
  operation: string,
): string[] {
  return expandDefinitionBodyFragmentsWithSources(
    fragments,
    skipCanonicalPaths,
    operation,
  ).map((parts) => parts.map(({ text }) => text).join(""));
}

export function expandAgentBodyFiles(
  body: string,
  skipCanonicalPaths: readonly string[],
  operation: string,
): string {
  return expandDefinitionBodyFragments(
    [{ path: "", scope: "bundled", body }],
    skipCanonicalPaths,
    operation,
  )[0]!;
}

export function agentDefinitionDelegationEnabled(
  definition: AgentDefinition,
): boolean {
  const {
    agents,
    tools: configured,
    excludeTools,
    noTools,
  } = definition.frontmatter;
  if ((agents?.length ?? 0) === 0) return false;

  const tools = normalizedToolNames(configured);
  if (normalizedToolNames(excludeTools).includes("agent")) return false;
  if (noTools === true && !tools.includes("+agent") && !tools.includes("agent"))
    return false;
  if (configured === undefined) return true;
  const policy = configuredToolPolicy(definition, []);
  if (policy.mode === "relative")
    return toolPolicyAllowsName(policy, new Set(), "agent");
  return tools.length > 0;
}

export function contextInheritance(definition: AgentDefinition): {
  global: boolean;
  project: boolean;
} {
  const project =
    definition.frontmatter.inheritProjectContext === true ||
    (definition.frontmatter.inheritProjectContext === undefined &&
      definition.name === "delegate");
  const global =
    definition.frontmatter.inheritGlobalContext === true ||
    (definition.frontmatter.inheritGlobalContext === undefined && project);
  return { global, project };
}

export function selectedAgentContextFiles(
  definition: AgentDefinition,
  cwd: string,
  loader: typeof loadProjectContextFiles = loadProjectContextFiles,
) {
  const inheritance = contextInheritance(definition);
  if (!inheritance.global && !inheritance.project) return [];
  const agentDir = getAgentDir();
  return loader({ cwd, agentDir }).filter((context) => {
    const isGlobal = resolve(dirname(context.path)) === resolve(agentDir);
    return isGlobal ? inheritance.global : inheritance.project;
  });
}

export type AgentLaunchOptions = {
  bodyPromptPath?: string;
  sharedPromptPath?: string;
  cwd?: string;
  loadProjectContextFiles?: typeof loadProjectContextFiles;
  managedAgent?: boolean;
  approveProject?: boolean;
  inheritedModel?: string;
  inheritedThinking?: string;
  requiredTools?: readonly string[];
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
    approveProject: options.approveProject,
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
  if (approveProject === true) args.push("--approve");
  else if (approveProject === false) args.push("--no-approve");
  const requestedModel = configuredModel(frontmatter) ?? inheritedModel;
  const decision =
    options.modelDecision ??
    (requestedModel === undefined
      ? { kind: "none" as const, extensionDiscovery: false }
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

  const mode = frontmatter.systemPromptMode ?? "append";
  if (typeof mode !== "string" || !SYSTEM_PROMPT_MODES.has(mode))
    throw new Error(
      `agent ${agent.name} has invalid systemPromptMode: ${JSON.stringify(mode)}`,
    );
  if (bodyPromptPathForLaunch !== undefined)
    args.push(
      mode === "append" ? "--append-system-prompt" : "--system-prompt",
      bodyPromptPathForLaunch,
    );
  const inheritance = contextInheritance(agent);
  if (!inheritance.global || !inheritance.project) {
    args.push("--no-context-files");
    for (const context of selectedAgentContextFiles(
      agent,
      cwd,
      options.loadProjectContextFiles ?? loadProjectContextFiles,
    ))
      args.push("--append-system-prompt", context.path);
  }
  if (sharedPromptPath) args.push("--append-system-prompt", sharedPromptPath);
  const requiredTools = [
    ...(managedAgent
      ? agentDefinitionDelegationEnabled(agent)
        ? [
            ...AGENT_COORDINATION_TOOLS,
            "await_owner",
            "notify_owner",
            "read_evidence",
            "attach_handoff",
          ]
        : ["await_owner", "notify_owner", "read_evidence", "attach_handoff"]
      : []),
    ...(options.requiredTools ?? []),
  ].filter((tool, index, all) => all.indexOf(tool) === index);
  const policy = configuredToolPolicy(agent, requiredTools);
  const noTools =
    frontmatter.noTools === true ||
    (policy.explicit && normalizedToolNames(frontmatter.tools).length === 0);
  if (noTools) args.push("--no-tools");
  if (frontmatter.noBuiltinTools) args.push("--no-builtin-tools");
  const excluded = policy.excluded;
  if (policy.mode === "relative") {
    const operations = [...normalizedToolNames(frontmatter.tools)];
    for (const tool of requiredTools)
      if (!operations.includes(`+${tool}`)) operations.push(`+${tool}`);
    if (
      noTools &&
      !operations.some((operation) => operation.startsWith("+mcp__"))
    ) {
      operations.push("+mcp__");
      if (!excluded.includes("mcp__")) excluded.push("mcp__");
    }
    if (operations.length) args.push("--tools", operations.join(","));
  } else if (noTools || policy.mode === "explicit") {
    const configured = policy.tools.filter(
      (tool) => !managedAgent || tool !== "agent",
    );
    const selected = [...new Set([...configured, ...requiredTools])];
    if (selected.length) {
      if (!selected.some((tool) => tool.startsWith("mcp__"))) {
        selected.push("mcp__");
        if (!excluded.includes("mcp__")) excluded.push("mcp__");
      }
      args.push("--tools", selected.join(","));
    }
  }
  if (excluded.length) args.push("--exclude-tools", excluded.join(","));

  const noSkills = frontmatter.noSkills ?? frontmatter.inheritSkills !== true;
  if (noSkills) args.push("--no-skills");
  for (const skill of frontmatter.skills ?? []) args.push("--skill", skill);

  // A model whose provider comes from an extension cannot resolve inside a
  // child denied extension discovery, so the model's needs outrank the
  // definition's preference to stay lean.
  if (frontmatter.noExtensions && !decision.extensionDiscovery)
    args.push("--no-extensions");
  for (const extension of frontmatter.extensions ?? [])
    args.push("--extension", extension);
  if (managedAgent)
    args.push("--append-system-prompt", `<active_agent name="${agent.name}"/>`);
  return args;
}
