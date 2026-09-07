import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { updateSpawnPlacementJson, type SpawnPlacement } from "./core.ts";

const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;
export const DEFAULT_BYTE_LIMIT = 128 * 1024;
export const MIN_BYTE_LIMIT = 1024;
export const MAX_BYTE_LIMIT = 1024 * 1024;
export type EffectiveByteLimit = {
  bytes: number;
  source: "global" | "default";
  invalidSource?: "global";
};
export function validByteLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_BYTE_LIMIT &&
    value <= MAX_BYTE_LIMIT
  );
}
export function resolveEffectiveByteLimit(value: unknown): EffectiveByteLimit {
  if (validByteLimit(value)) return { bytes: value, source: "global" };
  return {
    bytes: DEFAULT_BYTE_LIMIT,
    source: "default",
    ...(value === undefined ? {} : { invalidSource: "global" }),
  };
}
export function updatePiHerdsmanSettingJson(
  content: string | undefined,
  key: string,
  value: number | undefined,
): string {
  const parsed = content ? JSON.parse(content) : {};
  parsed.piHerdsman = { ...(parsed.piHerdsman ?? {}) };
  if (value === undefined) delete parsed.piHerdsman[key];
  else parsed.piHerdsman[key] = value;
  if (!Object.keys(parsed.piHerdsman).length) delete parsed.piHerdsman;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
export function updatePiHerdsmanSettingFile(
  settingsPath: string,
  key: string,
  value: number | undefined,
): void {
  const resolvedSettingsPath = resolve(settingsPath);
  mkdirSync(dirname(resolvedSettingsPath), { recursive: true });
  const release = acquireSettingsLock(resolvedSettingsPath);
  try {
    const current = existsSync(resolvedSettingsPath)
      ? readFileSync(resolvedSettingsPath, "utf8")
      : undefined;
    writeSettingsAtomically(
      resolvedSettingsPath,
      updatePiHerdsmanSettingJson(current, key, value),
    );
  } finally {
    release();
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireSettingsLock(settingsPath: string): () => void {
  const lockPath = `${settingsPath}.lock`;
  let lastError: unknown;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockPath);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmdirSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let lockStat: ReturnType<typeof statSync>;
      try {
        lockStat = statSync(lockPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (!lockStat.isDirectory())
        throw new Error(`Settings lock is not a directory: ${lockPath}`);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lockPath);
        continue;
      }
      lastError = error;
      if (attempt + 1 < LOCK_ATTEMPTS) sleepSync(LOCK_RETRY_MS);
    }
  }

  throw (
    lastError ?? new Error(`Unable to acquire settings lock: ${settingsPath}`)
  );
}

function writeSettingsAtomically(settingsPath: string, content: string): void {
  const directory = dirname(settingsPath);
  const temporaryPath = join(
    directory,
    `.${basename(settingsPath)}.${randomUUID()}.tmp`,
  );
  const mode = existsSync(settingsPath)
    ? statSync(settingsPath).mode & 0o777
    : 0o600;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, settingsPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function updateSpawnPlacementFile(
  settingsPath: string,
  placement: SpawnPlacement,
): void {
  const resolvedSettingsPath = resolve(settingsPath);
  const directory = dirname(resolvedSettingsPath);
  mkdirSync(directory, { recursive: true });
  const release = acquireSettingsLock(resolvedSettingsPath);
  try {
    const current = existsSync(resolvedSettingsPath)
      ? readFileSync(resolvedSettingsPath, "utf8")
      : undefined;
    const next = updateSpawnPlacementJson(current, placement);
    writeSettingsAtomically(resolvedSettingsPath, next);
  } finally {
    release();
  }
}
