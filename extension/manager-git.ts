import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  gitRepositoryScope,
  readPiSessionHeaderIdentity,
  sameDirectory,
} from "./herdr.ts";
import { acquireProcessLock } from "./lock.ts";
import { herdsmanTempRoot } from "./storage.ts";
import {
  listLiveLegacyManagers,
  type SupervisionRuntime,
} from "./supervision.ts";

export async function requireNoLiveLegacyManager(
  pi: Pick<ExtensionAPI, "exec">,
  runtime: SupervisionRuntime,
  canonicalRepoKey: string,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const legacy of listLiveLegacyManagers(
    runtime,
    canonicalRepoKey,
    workspaceId,
  )) {
    const recordedRepoMatches =
      isAbsolute(legacy.repoKey) &&
      sameDirectory(legacy.repoKey, canonicalRepoKey);
    let checkout: Awaited<ReturnType<typeof gitRepositoryScope>> | undefined;
    if (legacy.piSessionFile) {
      try {
        const saved = readPiSessionHeaderIdentity(legacy.piSessionFile);
        if (
          saved?.id === legacy.piSessionId &&
          saved.cwd &&
          isAbsolute(saved.cwd)
        )
          checkout = await gitRepositoryScope(pi, saved.cwd, signal);
      } catch {
        // Missing checkout evidence does not make a correlated live lock safe.
      }
    }
    signal?.throwIfAborted();
    if (
      legacy.canonicalRepoKey === canonicalRepoKey ||
      recordedRepoMatches ||
      (checkout
        ? sameDirectory(checkout.canonicalRepoKey, canonicalRepoKey)
        : legacy.localSocket && legacy.workspaceId === workspaceId)
    )
      throw new Error(
        "This repository has legacy Manager authority; stop or restart the existing Manager",
      );
  }
}

export async function ensureManagerGitRepository(
  pi: Pick<ExtensionAPI, "exec">,
  directory: string,
  options: {
    signal?: AbortSignal;
    createIfMissing: boolean;
    confirm?(target: string): Promise<boolean>;
    verifyApprovedTarget?(target: string): Promise<void>;
    verifyPreparedRepository?(
      repository: Awaited<ReturnType<typeof gitRepositoryScope>>,
    ): Promise<void>;
  },
): Promise<Awaited<ReturnType<typeof gitRepositoryScope>> | undefined> {
  const target = realpathSync(resolve(directory));
  const targetStat = statSync(target, { bigint: true });
  if (
    !targetStat.isDirectory() ||
    targetStat.dev === 0n ||
    targetStat.ino === 0n
  )
    throw new Error("Manager Git target is not a directory");
  await options.verifyApprovedTarget?.(target);
  if (
    [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
      "GIT_PREFIX",
    ].some((key) => process.env[key])
  )
    throw new Error(
      "Cannot initialize Git while repository-redirection environment variables are set",
    );
  if (
    options.createIfMissing &&
    options.confirm &&
    !(await options.confirm(target))
  )
    return undefined;
  await options.verifyApprovedTarget?.(target);
  const verifyDirectory = () => {
    const current = statSync(target, { bigint: true });
    if (
      !sameDirectory(resolve(directory), target) ||
      current.dev !== targetStat.dev ||
      current.ino !== targetStat.ino
    )
      throw new Error(
        "Manager activation cancelled because the workspace changed",
      );
  };
  verifyDirectory();
  const runGit = async (args: string[]) => {
    const result = await pi.exec("git", args, {
      cwd: target,
      signal: options.signal,
      timeout: 30_000,
    });
    if (result.code !== 0 || result.killed)
      throw new Error(
        `Git ${args[0]} failed: ${result.stderr?.trim() || "process unsuccessful"}`,
      );
    return result.stdout.trim();
  };
  const probeRoot = async (): Promise<string | undefined> => {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: target,
      signal: options.signal,
      timeout: 30_000,
    });
    if (result.code === 0 && !result.killed)
      return String(result.stdout ?? "").trim();
    if (result.killed) throw new Error("Git repository inspection failed");
    return undefined;
  };
  const bootstrapLock = acquireProcessLock(
    join(
      herdsmanTempRoot(),
      "locks",
      `manager-bootstrap-${createHash("sha256").update(target).digest("hex")}`,
    ),
    { name: "Manager Git bootstrap" },
  );
  try {
    const hasRepositoryMetadata = () => {
      let directory = target;
      while (true) {
        try {
          lstatSync(resolve(directory, ".git"));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) return false;
        directory = parent;
      }
    };
    let root = await probeRoot();
    if (!root) {
      const bare = await pi.exec("git", ["rev-parse", "--is-bare-repository"], {
        cwd: target,
        signal: options.signal,
        timeout: 30_000,
      });
      if (bare.killed) throw new Error("Git repository type inspection failed");
      const bareStatus = String(bare.stdout ?? "").trim();
      if (bare.code === 0 && bareStatus === "true")
        throw new Error(
          "Cannot initialize Manager Git inside an existing bare repository",
        );
      if (bare.code === 0 && bareStatus !== "false")
        throw new Error("Git repository type inspection failed");
      if (hasRepositoryMetadata())
        throw new Error(
          "Refusing to initialize: existing Git metadata is invalid or conflicting",
        );
      if (!options.createIfMissing) return undefined;
      verifyDirectory();
      await runGit(["init", "--initial-branch=main"]);
      root = await probeRoot();
    }
    if (root && !sameDirectory(root, target))
      throw new Error(
        "Refusing to initialize inside an enclosing Git repository",
      );
    if (!root)
      throw new Error(
        "Git initialization could not verify its working-tree root",
      );
    const verifyRepository = async () => {
      const repository = await gitRepositoryScope(pi, target, options.signal);
      if (
        !repository.isPrimary ||
        !sameDirectory(repository.checkoutPath, target)
      )
        throw new Error("Manager requires the selected primary Git checkout");
      verifyDirectory();
      return repository;
    };
    const repository = await verifyRepository();
    if (!options.createIfMissing) return repository;
    const inspectHead = async (): Promise<string | undefined> => {
      const result = await pi.exec(
        "git",
        ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        { cwd: target, signal: options.signal, timeout: 30_000 },
      );
      if (result.code === 0 && !result.killed)
        return String(result.stdout ?? "").trim();
      if (result.killed || result.code !== 1)
        throw new Error(
          `Git HEAD inspection failed: ${String(result.stderr ?? "").trim() || "process unsuccessful"}`,
        );
      return undefined;
    };
    let head = await inspectHead();
    let createdInitialCommit = false;
    if (!head) {
      const staged = await pi.exec("git", ["diff", "--cached", "--quiet"], {
        cwd: target,
        signal: options.signal,
        timeout: 30_000,
      });
      const index = await runGit(["ls-files", "--stage"]);
      if (staged.killed || (staged.code !== 0 && staged.code !== 1) || index)
        throw new Error(
          "Refusing to complete an unborn repository with an existing or unreadable index",
        );
      const beforeCommit = await verifyRepository();
      if (beforeCommit.canonicalRepoKey !== repository.canonicalRepoKey)
        throw new Error("Manager Git repository changed before initial commit");
      await runGit([
        "commit",
        "--only",
        "--allow-empty",
        "-m",
        "chore: initialize repository",
      ]);
      createdInitialCommit = true;
      head = await inspectHead();
    }
    if (!head) throw new Error("Git did not create an initial commit");
    if (createdInitialCommit) {
      const parents = await runGit([
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ]);
      if (parents.trim().split(/\s+/).length !== 1)
        throw new Error("Initial Git commit is not a root commit");
      const tree = await runGit(["rev-parse", "HEAD^{tree}"]);
      if (tree !== (await runGit(["mktree"])))
        throw new Error("Initial Git commit is not empty");
    }
    await options.verifyApprovedTarget?.(target);
    const prepared = await verifyRepository();
    if (prepared.canonicalRepoKey !== repository.canonicalRepoKey)
      throw new Error("Manager Git repository changed during preparation");
    await options.verifyPreparedRepository?.(prepared);
    return prepared;
  } finally {
    bootstrapLock.release();
  }
}
