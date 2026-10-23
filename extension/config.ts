import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lockSync } from "proper-lockfile";
import { claimProcessLock } from "./lock.ts";
import { herdsmanConfigPath } from "./storage.ts";
import {
  isLeadExecutionMode,
  isSpawnPlacement,
  type LeadExecutionMode,
  type SpawnPlacement,
} from "./core.ts";

const DEFAULT_BYTE_LIMIT = 128 * 1024;
export const MIN_BYTE_LIMIT = 1024;
export const MAX_BYTE_LIMIT = 1024 * 1024;

export type HerdsmanConfig = {
  spawnPlacement: SpawnPlacement;
  defaultLeadExecution: LeadExecutionMode;
  contextRetirement: boolean;
  autoActivateManager: boolean;
  inlineAttachmentLimitBytes: number;
  mailboxPayloadLimitBytes: number;
  worktreeRemovalPreapprovedRepos: string[];
  managerMergeEnabled: boolean;
  managerMergeOverrides: Record<string, boolean>;
};

export const DEFAULT_CONFIG: HerdsmanConfig = {
  spawnPlacement: "subtree",
  defaultLeadExecution: "flexible",
  contextRetirement: true,
  autoActivateManager: false,
  inlineAttachmentLimitBytes: DEFAULT_BYTE_LIMIT,
  mailboxPayloadLimitBytes: DEFAULT_BYTE_LIMIT,
  worktreeRemovalPreapprovedRepos: [],
  managerMergeEnabled: false,
  managerMergeOverrides: {},
};

export function validByteLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_BYTE_LIMIT &&
    value <= MAX_BYTE_LIMIT
  );
}

type ConfigKey = keyof HerdsmanConfig;
const CONFIG_KEYS = new Set<ConfigKey>([
  "spawnPlacement",
  "defaultLeadExecution",
  "contextRetirement",
  "autoActivateManager",
  "inlineAttachmentLimitBytes",
  "mailboxPayloadLimitBytes",
  "worktreeRemovalPreapprovedRepos",
  "managerMergeEnabled",
  "managerMergeOverrides",
]);

function validRepoIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value === value.trim() &&
    value.length <= 4096 &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype" &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validManagerMergeOverrides(
  value: unknown,
): value is Record<string, boolean> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([repoKey, enabled]) =>
        validRepoIdentity(repoKey) && typeof enabled === "boolean",
    )
  );
}

function parseRawConfig(content: string): Partial<HerdsmanConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid Pi Herdsman config JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Pi Herdsman config: root must be an object");
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!CONFIG_KEYS.has(key as ConfigKey))
      throw new Error(`Invalid Pi Herdsman config: unknown field ${key}`);
  const result: Partial<HerdsmanConfig> = {};
  if ("spawnPlacement" in record) {
    if (!isSpawnPlacement(record.spawnPlacement))
      throw new Error("Invalid Pi Herdsman config field spawnPlacement");
    result.spawnPlacement = record.spawnPlacement;
  }
  if ("defaultLeadExecution" in record) {
    if (!isLeadExecutionMode(record.defaultLeadExecution))
      throw new Error("Invalid Pi Herdsman config field defaultLeadExecution");
    result.defaultLeadExecution = record.defaultLeadExecution;
  }
  if ("contextRetirement" in record) {
    if (typeof record.contextRetirement !== "boolean")
      throw new Error("Invalid Pi Herdsman config field contextRetirement");
    result.contextRetirement = record.contextRetirement;
  }
  if ("autoActivateManager" in record) {
    if (typeof record.autoActivateManager !== "boolean")
      throw new Error("Invalid Pi Herdsman config field autoActivateManager");
    result.autoActivateManager = record.autoActivateManager;
  }
  if ("managerMergeEnabled" in record) {
    if (typeof record.managerMergeEnabled !== "boolean")
      throw new Error("Invalid Pi Herdsman config field managerMergeEnabled");
    result.managerMergeEnabled = record.managerMergeEnabled;
  }
  if ("managerMergeOverrides" in record) {
    if (!validManagerMergeOverrides(record.managerMergeOverrides))
      throw new Error("Invalid Pi Herdsman config field managerMergeOverrides");
    result.managerMergeOverrides = record.managerMergeOverrides;
  }
  for (const key of [
    "inlineAttachmentLimitBytes",
    "mailboxPayloadLimitBytes",
  ] as const)
    if (key in record) {
      if (!validByteLimit(record[key]))
        throw new Error(`Invalid Pi Herdsman config field ${key}`);
      result[key] = record[key];
    }
  if ("worktreeRemovalPreapprovedRepos" in record) {
    const repos = record.worktreeRemovalPreapprovedRepos;
    if (
      !Array.isArray(repos) ||
      repos.some((repo) => typeof repo !== "string" || !repo.trim()) ||
      new Set(repos).size !== repos.length
    )
      throw new Error(
        "Invalid Pi Herdsman config field worktreeRemovalPreapprovedRepos",
      );
    result.worktreeRemovalPreapprovedRepos = repos;
  }
  return result;
}

export function isWorktreeRemovalPreapproved(repoKey: string): boolean {
  return (
    !!repoKey && readConfig().worktreeRemovalPreapprovedRepos.includes(repoKey)
  );
}

export type EffectiveMergePolicy = {
  enabled: boolean;
  source: "global" | "repository";
};

export function effectiveMergePolicy(
  config: Pick<HerdsmanConfig, "managerMergeEnabled" | "managerMergeOverrides">,
  repoKey: string,
): EffectiveMergePolicy {
  if (!validRepoIdentity(repoKey))
    throw new Error("A verified repository identity is required");
  const override = config.managerMergeOverrides[repoKey];
  return !Object.hasOwn(config.managerMergeOverrides, repoKey)
    ? { enabled: config.managerMergeEnabled, source: "global" }
    : { enabled: override, source: "repository" };
}

export function setManagerMergeOverride(
  repoKey: string,
  enabled: boolean | undefined,
): void {
  if (
    !validRepoIdentity(repoKey) ||
    (enabled !== undefined && typeof enabled !== "boolean")
  )
    throw new Error(
      "A verified repository identity and optional boolean policy are required",
    );
  const path = herdsmanConfigPath();
  const release = claimProcessLock(`${path}.lock`, {
    name: "Pi Herdsman config update",
  });
  try {
    const current = readRawConfig();
    const overrides = { ...current.managerMergeOverrides };
    if (enabled === undefined) delete overrides[repoKey];
    else overrides[repoKey] = enabled;
    if (Object.keys(overrides).length)
      current.managerMergeOverrides = overrides;
    else delete current.managerMergeOverrides;
    if (Object.keys(current).length)
      writeConfigAtomically(path, `${JSON.stringify(current, null, 2)}\n`);
    else {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    release();
  }
}

export function setWorktreeRemovalPreapproved(
  repoKey: string,
  enabled: boolean,
): void {
  if (!repoKey || typeof enabled !== "boolean")
    throw new Error(
      "A verified repository identity and boolean policy are required",
    );
  const path = herdsmanConfigPath();
  const release = claimProcessLock(`${path}.lock`, {
    name: "Pi Herdsman config update",
  });
  try {
    const current = readRawConfig();
    const repos = new Set(current.worktreeRemovalPreapprovedRepos ?? []);
    if (enabled) repos.add(repoKey);
    else repos.delete(repoKey);
    if (repos.size) current.worktreeRemovalPreapprovedRepos = [...repos];
    else delete current.worktreeRemovalPreapprovedRepos;
    if (Object.keys(current).length)
      writeConfigAtomically(path, `${JSON.stringify(current, null, 2)}\n`);
    else {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    release();
  }
}

function readRawConfig(): Partial<HerdsmanConfig> {
  const path = herdsmanConfigPath();
  try {
    return parseRawConfig(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function readConfig(): HerdsmanConfig {
  const config = { ...DEFAULT_CONFIG, ...readRawConfig() };
  config.managerMergeOverrides = { ...config.managerMergeOverrides };
  return config;
}

type ProjectContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
export type ProjectOverrides = Partial<
  Pick<HerdsmanConfig, "autoActivateManager" | "contextRetirement">
>;

function parseProjectSettings(
  content: string,
  path: string,
): Record<string, unknown> {
  let settings: unknown;
  try {
    settings = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(
      `Invalid project settings ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error(`Invalid project settings ${path}: expected an object`);
  return settings as Record<string, unknown>;
}

function parseProjectOverrides(
  settings: Record<string, unknown>,
  path: string,
): ProjectOverrides {
  const raw = settings.piHerdsman;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`Invalid ${path}: piHerdsman must be an object`);
  const overrides: ProjectOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "autoActivateManager" && key !== "contextRetirement")
      throw new Error(`Invalid ${path}: unsupported piHerdsman field ${key}`);
    if (typeof value !== "boolean")
      throw new Error(`Invalid ${path}: piHerdsman.${key} must be boolean`);
    overrides[key] = value;
  }
  return overrides;
}

function projectSettingsFile(ctx: ProjectContext): string {
  return join(ctx.cwd, ".pi", "settings.json");
}

function assertRegularProjectSettings(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile())
      throw new Error(
        `Invalid project settings ${path}: expected a regular file`,
      );
    return stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function acquireProjectSettingsLock(path: string): () => void {
  for (let attempt = 0; ; attempt++) {
    try {
      return lockSync(path, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 9)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

export function readProjectOverrides(ctx: ProjectContext): ProjectOverrides {
  if (!ctx.isProjectTrusted()) return {};
  const path = projectSettingsFile(ctx);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseProjectOverrides(parseProjectSettings(content, path), path);
}

export function updateProjectOverride(
  ctx: ProjectContext,
  key: keyof ProjectOverrides,
  value: boolean | undefined,
): void {
  if (!ctx.isProjectTrusted())
    throw new Error("Cannot update project settings for an untrusted project");
  if (key !== "autoActivateManager" && key !== "contextRetirement")
    throw new Error(`Invalid project override key ${String(key)}`);
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`Invalid project override value for ${key}`);

  const path = projectSettingsFile(ctx);
  let mode = assertRegularProjectSettings(path);
  if (value === undefined && mode === undefined) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireProjectSettingsLock(path);
  let changed = false;
  try {
    mode = assertRegularProjectSettings(path) ?? 0o600;
    let settings: Record<string, unknown> = {};
    try {
      settings = parseProjectSettings(readFileSync(path, "utf8"), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const overrides = parseProjectOverrides(settings, path);
    const alreadySet = Object.hasOwn(overrides, key);
    if (
      value === undefined ? !alreadySet : alreadySet && overrides[key] === value
    ) {
      changed = false;
    } else {
      if (value === undefined) delete overrides[key];
      else overrides[key] = value;
      if (Object.keys(overrides).length) settings.piHerdsman = overrides;
      else delete settings.piHerdsman;
      writeConfigAtomically(
        path,
        `${JSON.stringify(settings, null, 2)}\n`,
        mode,
      );
      changed = true;
    }
  } finally {
    release();
  }
  let stored: ProjectOverrides;
  try {
    stored = parseProjectOverrides(
      parseProjectSettings(readFileSync(path, "utf8"), path),
      path,
    );
  } catch (error) {
    if (
      !changed &&
      value === undefined &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      stored = {};
    else throw error;
  }
  if (
    value === undefined
      ? Object.hasOwn(stored, key)
      : !Object.hasOwn(stored, key) || stored[key] !== value
  )
    throw new Error(`Project setting ${key} did not persist to ${path}`);
}

export function readEffectiveConfig(ctx: ProjectContext): HerdsmanConfig {
  return { ...readConfig(), ...readProjectOverrides(ctx) };
}

function writeConfigAtomically(
  path: string,
  content: string,
  mode = 0o600,
): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function updateConfig<K extends ConfigKey>(
  key: K,
  value: HerdsmanConfig[K] | undefined,
): void {
  const path = herdsmanConfigPath();
  const release = claimProcessLock(`${path}.lock`, {
    name: "Pi Herdsman config update",
  });
  try {
    const current = readRawConfig();
    if (value !== undefined) {
      if (key === "spawnPlacement" && !isSpawnPlacement(value))
        throw new Error("Invalid Pi Herdsman config field spawnPlacement");
      if (key === "defaultLeadExecution" && !isLeadExecutionMode(value))
        throw new Error(
          "Invalid Pi Herdsman config field defaultLeadExecution",
        );
      if (key === "contextRetirement" && typeof value !== "boolean")
        throw new Error("Invalid Pi Herdsman config field contextRetirement");
      if (key === "autoActivateManager" && typeof value !== "boolean")
        throw new Error("Invalid Pi Herdsman config field autoActivateManager");
      if (key === "managerMergeEnabled" && typeof value !== "boolean")
        throw new Error("Invalid Pi Herdsman config field managerMergeEnabled");
      if (key === "managerMergeOverrides" && !validManagerMergeOverrides(value))
        throw new Error(
          "Invalid Pi Herdsman config field managerMergeOverrides",
        );
      if (
        key === "worktreeRemovalPreapprovedRepos" &&
        (!Array.isArray(value) ||
          value.some((repo) => typeof repo !== "string" || !repo.trim()) ||
          new Set(value).size !== value.length)
      )
        throw new Error(
          "Invalid Pi Herdsman config field worktreeRemovalPreapprovedRepos",
        );
      if (
        key !== "spawnPlacement" &&
        key !== "defaultLeadExecution" &&
        key !== "contextRetirement" &&
        key !== "autoActivateManager" &&
        key !== "managerMergeEnabled" &&
        key !== "managerMergeOverrides" &&
        key !== "worktreeRemovalPreapprovedRepos" &&
        !validByteLimit(value)
      )
        throw new Error(`Invalid Pi Herdsman config field ${key}`);
      current[key] = value;
    } else delete current[key];
    if (Object.keys(current).length)
      writeConfigAtomically(path, `${JSON.stringify(current, null, 2)}\n`);
    else {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    release();
  }
}
