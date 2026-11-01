import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readConfig } from "./config.ts";
import { acquireProcessLock } from "./lock.ts";
import {
  assertSafeLocalRepositoryPath,
  ensureSafeLocalRepositoryDirectory,
} from "./repository.ts";
import { herdsmanTempRoot } from "./storage.ts";

const GIT_TIMEOUT_MS = 30_000;
const REDIRECTED_GIT_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
] as const;

export type VerifiedManagerGitRepository = Readonly<{
  checkoutPath: string;
  gitDir: string;
  commonDir: string;
}>;

export async function confirmManagerGitSetup(
  ctx: ExtensionContext,
  target: string,
): Promise<boolean> {
  if (readConfig().managerGitBootstrapWithoutConfirmation) return true;
  if (!ctx.hasUI)
    throw new Error("Interactive Git setup approval is required.");
  return ctx.ui.confirm(
    "Initialize Git repository?",
    `Initialize ${target} with an empty initial commit, then start Manager mode? Existing files will not be committed.`,
  );
}

/** Reuses /manager's guarded Git initialization for both manual and Chief starts. */
export async function ensureManagerGitRepository(
  pi: Pick<ExtensionAPI, "exec">,
  requestedPath: string,
  options: {
    signal?: AbortSignal;
    createIfMissing?: boolean;
    confirm?(target: string): Promise<boolean>;
    verifyApprovedTarget?(): Promise<void>;
  } = {},
): Promise<VerifiedManagerGitRepository | undefined> {
  const target = assertSafeLocalRepositoryPath(requestedPath);
  const exists = pathExists(target);
  if (!exists && !options.createIfMissing)
    throw new Error("Manager repository directory does not exist");
  if (exists) assertSafeLocalRepositoryPath(target);
  const initialTargetIdentity = exists ? directoryIdentity(target) : undefined;
  await options.verifyApprovedTarget?.();

  let initialRepository: VerifiedManagerGitRepository | undefined;
  if (exists) {
    initialRepository = await inspectRepository(pi, target, options.signal);
    if (initialRepository && (await inspectHead(pi, target, options.signal)))
      return initialRepository;
  }

  if (!(await (options.confirm ?? (async () => false))(target)))
    return undefined;
  await options.verifyApprovedTarget?.();

  const lockPath = join(
    herdsmanTempRoot(),
    "locks",
    `manager-bootstrap-${createHash("sha256").update(target).digest("hex")}`,
  );
  const bootstrapLock = acquireProcessLock(lockPath, {
    name: "Manager Git bootstrap",
  });
  try {
    await options.verifyApprovedTarget?.();
    const currentExists = pathExists(target);
    if (!currentExists) ensureSafeLocalRepositoryDirectory(target);
    else assertSafeLocalRepositoryPath(target);
    const identity = directoryIdentity(target);
    if (initialTargetIdentity)
      assertDirectoryIdentity(target, initialTargetIdentity);
    const existing = await inspectRepository(pi, target, options.signal);
    if (initialRepository && !sameRepository(initialRepository, existing))
      throw new Error("Manager Git repository changed during setup");
    const existingHead = existing
      ? await inspectHead(pi, target, options.signal)
      : undefined;
    if (existing && existingHead) return existing;
    if (existing && !initialRepository)
      throw new Error("Manager Git repository changed during setup");
    const completingUnbornRepository = existing !== undefined;

    if (REDIRECTED_GIT_ENVIRONMENT.some((key) => process.env[key]))
      throw new Error(
        "Cannot initialize Git while repository-redirection environment variables are set",
      );

    const hasRepositoryMetadata = () => {
      let directory = target;
      while (true) {
        try {
          lstatSync(join(directory, ".git"));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) return false;
        directory = parent;
      }
    };
    const run = async (args: string[]) => {
      const result = await pi.exec("git", args, {
        cwd: target,
        signal: options.signal,
        timeout: GIT_TIMEOUT_MS,
      });
      if (result.code !== 0 || result.killed)
        throw new Error(
          `Git ${args[0]} failed: ${result.stderr?.trim() || "process unsuccessful"}`,
        );
      return String(result.stdout ?? "").trim();
    };

    const bare = await pi.exec("git", ["rev-parse", "--is-bare-repository"], {
      cwd: target,
      signal: options.signal,
      timeout: GIT_TIMEOUT_MS,
    });
    const bareStatus = String(bare.stdout ?? "").trim();
    if (bare.killed) throw new Error("Git repository type inspection failed");
    if (bare.code === 0 && bareStatus === "true")
      throw new Error("Cannot initialize Manager Git inside a bare repository");
    if (bare.code === 0 && bareStatus !== "false")
      throw new Error("Git repository type inspection failed");
    if (!completingUnbornRepository && hasRepositoryMetadata())
      throw new Error(
        "Refusing to initialize: existing Git metadata is invalid or conflicting",
      );

    assertDirectoryIdentity(target, identity);
    if (!completingUnbornRepository) {
      await options.verifyApprovedTarget?.();
      await run(["init", "--initial-branch=main"]);
    }
    const initialized = completingUnbornRepository
      ? existing
      : await inspectRepository(pi, target, options.signal);
    if (!initialized)
      throw new Error(
        "Git initialization could not verify its working-tree root",
      );
    const head = await inspectHead(pi, target, options.signal);
    if (!head) {
      const staged = await pi.exec("git", ["diff", "--cached", "--quiet"], {
        cwd: target,
        signal: options.signal,
        timeout: GIT_TIMEOUT_MS,
      });
      const index = await run(["ls-files", "--stage"]);
      if (staged.killed || staged.code !== 0 || index)
        throw new Error(
          "Refusing to complete an unborn repository with an existing or unreadable index",
        );
      await run([
        "commit",
        "--only",
        "--allow-empty",
        "-m",
        "chore: initialize repository",
      ]);
      const createdHead = await inspectHead(pi, target, options.signal);
      if (!createdHead) throw new Error("Git did not create an initial commit");
      const parents = await run(["rev-list", "--parents", "-n", "1", "HEAD"]);
      if (parents.split(/\s+/).length !== 1)
        throw new Error("Initial Git commit is not a root commit");
      const tree = await run(["rev-parse", "HEAD^{tree}"]);
      if (tree !== (await run(["mktree"])))
        throw new Error("Initial Git commit is not empty");
    }
    await options.verifyApprovedTarget?.();
    assertDirectoryIdentity(target, identity);
    return initialized;
  } finally {
    bootstrapLock.release();
  }
}

function sameRepository(
  expected: VerifiedManagerGitRepository,
  current: VerifiedManagerGitRepository | undefined,
): boolean {
  return (
    current !== undefined &&
    expected.checkoutPath === current.checkoutPath &&
    expected.gitDir === current.gitDir &&
    expected.commonDir === current.commonDir
  );
}

async function inspectRepository(
  pi: Pick<ExtensionAPI, "exec">,
  target: string,
  signal?: AbortSignal,
): Promise<VerifiedManagerGitRepository | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: target,
    signal,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.killed) throw new Error("Git repository inspection failed");
  if (result.code !== 0) {
    if (hasRepositoryMetadata(target))
      throw new Error(
        "Refusing to initialize: existing Git metadata is invalid or conflicting",
      );
    return undefined;
  }
  const root = String(result.stdout ?? "").trim();
  if (!isAbsolute(root))
    throw new Error("Git working-tree root is unavailable");
  const [gitDir, commonDir] = await Promise.all([
    gitPath(pi, target, "--git-dir", signal),
    gitPath(pi, target, "--git-common-dir", signal),
  ]);
  if (!samePath(root, target))
    throw new Error(
      "Refusing to initialize inside an enclosing Git repository",
    );
  if (!samePath(gitDir, commonDir))
    throw new Error("Manager is available only in a primary Git repository");
  return {
    checkoutPath: realpathSync.native(target),
    gitDir,
    commonDir,
  };
}

async function gitPath(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  argument: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await pi.exec(
    "git",
    ["rev-parse", "--path-format=absolute", argument],
    { cwd, signal, timeout: GIT_TIMEOUT_MS },
  );
  const value = String(result.stdout ?? "").trim();
  if (result.code !== 0 || result.killed || !isAbsolute(value))
    throw new Error("Git repository identity is unavailable");
  return realpathSync.native(value);
}

async function inspectHead(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await pi.exec(
    "git",
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    { cwd, signal, timeout: GIT_TIMEOUT_MS },
  );
  if (result.code === 0 && !result.killed)
    return String(result.stdout ?? "").trim();
  if (result.killed || result.code !== 1)
    throw new Error(
      `Git HEAD inspection failed: ${result.stderr?.trim() || "process unsuccessful"}`,
    );
  return undefined;
}

function hasRepositoryMetadata(target: string): boolean {
  let directory = target;
  while (true) {
    try {
      lstatSync(join(directory, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function directoryIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.dev === 0n || stat.ino === 0n)
    throw new Error("Manager Git target is not a directory");
  return { dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(
  path: string,
  expected: ReturnType<typeof directoryIdentity>,
): void {
  const current = directoryIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw new Error("Manager Git target changed during setup");
}
