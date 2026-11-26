import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { readConfig } from "./config.ts";
import {
  gitRepositoryScope,
  herdrSessionSnapshot,
  sameDirectory,
  type HerdrSessionSnapshot,
} from "./herdr.ts";
import { readProcessLockStatus } from "./lock.ts";
import { requireNoLiveLegacyManager } from "./manager-git.ts";
import { readSavedManagerSession } from "./manager-recovery.ts";
import { resolveLocalRepositoryPath } from "./repository.ts";
import {
  listManagerRecoveryReferences,
  managerDescriptorPath,
  readManagerDescriptorStatus,
  readManagerRecoveryReference,
  sameManagerDescriptor,
  type ManagerDescriptor,
  type ManagerRecoveryReference,
  type SupervisionRuntime,
} from "./supervision.ts";

type Repository = Awaited<ReturnType<typeof gitRepositoryScope>>;
type Workspace = {
  workspaceId: string;
  checkoutPath: string;
  isPrimary: boolean;
};
type Project = {
  canonicalRepoKey: string;
  primaryCheckoutPath?: string;
  workspaces: Workspace[];
  managerStatus: "running" | "recoverable" | "none" | "unknown";
};
export type ProjectDiscoveryResult = {
  projects: Project[];
  complete: boolean;
  diagnostics: string[];
};

const MAX_PROJECTS = 200;
const MAX_DIRECTORIES = 2_000;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_DEPTH = 12;
const MAX_WORKSPACE_PATHS = 400;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" && isAbsolute(value) && !value.includes("\0")
  );
}

export async function discoverProjects(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: {
    runtime: SupervisionRuntime;
    includeProjectsDirectory: boolean;
    signal?: AbortSignal;
    inventory?: HerdrSessionSnapshot | null;
    verifyRunningManager(
      repository: Repository,
      descriptor: ManagerDescriptor,
      signal: AbortSignal,
    ): Promise<void>;
  },
): Promise<ProjectDiscoveryResult> {
  const { runtime } = options;
  const callerSignal = options.signal ?? ctx.signal;
  const deadline = AbortSignal.timeout(
    options.includeProjectsDirectory ? 30_000 : 5_000,
  );
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline])
    : deadline;
  const diagnostics = new Set<string>();
  const projects = new Map<string, Project>();
  const scopes = new Map<string, Promise<Repository>>();
  const recoveryResults = new Map<
    string,
    { path: string; id: string; valid: boolean }
  >();

  const scope = (path: string) => {
    signal.throwIfAborted();
    const prior = scopes.get(path);
    if (prior) return prior;
    const pending = gitRepositoryScope(pi, path, signal);
    scopes.set(path, pending);
    return pending;
  };
  const add = (repository: Repository, workspaceId?: string) => {
    const key = repository.canonicalRepoKey;
    let project = projects.get(key);
    if (!project) {
      if (projects.size >= MAX_PROJECTS) {
        diagnostics.add("Project observation limit reached");
        return;
      }
      project = {
        canonicalRepoKey: key,
        workspaces: [],
        managerStatus: "unknown",
      };
      projects.set(key, project);
    }
    if (repository.isPrimary)
      project.primaryCheckoutPath = repository.checkoutPath;
    if (
      workspaceId &&
      !project.workspaces.some(
        (placement) =>
          placement.workspaceId === workspaceId &&
          placement.checkoutPath === repository.checkoutPath,
      )
    ) {
      project.workspaces.push({
        workspaceId,
        checkoutPath: repository.checkoutPath,
        isPrimary: repository.isPrimary,
      });
    }
  };

  async function observeWorkspaces(inventory: HerdrSessionSnapshot) {
    const ids = new Set<string>();
    const duplicateIds = new Set<string>();
    const panePaths = new Map<string, Set<string>>();
    for (const item of inventory.workspaces) {
      const id = item?.workspace_id;
      if (typeof id !== "string" || !id || id.includes("\0")) {
        diagnostics.add("Herdr workspace identity could not be verified");
        continue;
      }
      if (ids.has(id)) duplicateIds.add(id);
      ids.add(id);
    }
    for (const pane of inventory.panes) {
      if (!ids.has(pane?.workspace_id) || !validPath(pane?.cwd)) continue;
      const paths = panePaths.get(pane.workspace_id) ?? new Set<string>();
      paths.add(pane.cwd);
      panePaths.set(pane.workspace_id, paths);
    }
    let observations = 0;
    for (const item of inventory.workspaces) {
      signal.throwIfAborted();
      const id = item?.workspace_id;
      if (!ids.has(id)) continue;
      if (duplicateIds.has(id)) {
        diagnostics.add("Herdr workspace identity is ambiguous");
        continue;
      }
      const membership = item.worktree;
      const paths =
        membership == null
          ? (panePaths.get(id) ?? [])
          : [membership.checkout_path];
      for (const path of paths) {
        if (++observations > MAX_WORKSPACE_PATHS) {
          diagnostics.add("Herdr workspace observation limit reached");
          return;
        }
        try {
          if (!validPath(path)) throw new Error("Invalid workspace checkout");
          // Ordinary workspaces lack worktree metadata. Only an actual pane
          // at an exact repository root proves such a checkout placement.
          if (
            membership == null &&
            !lstatSync(join(path, ".git"), { throwIfNoEntry: false })
          )
            continue;
          const repository = await scope(path);
          if (
            !sameDirectory(path, repository.checkoutPath) ||
            (membership != null &&
              (!validPath(membership.repo_key) ||
                !sameDirectory(
                  membership.repo_key,
                  repository.canonicalRepoKey,
                ) ||
                membership.is_linked_worktree !== !repository.isPrimary))
          )
            throw new Error("Herdr checkout identity disagrees with Git");
          add(repository, id);
        } catch {
          signal.throwIfAborted();
          diagnostics.add(
            "Some Herdr checkout placements could not be verified",
          );
        }
      }
    }
  }

  async function observeRecovery(
    reference: ManagerRecoveryReference,
  ): Promise<boolean> {
    let valid = false;
    try {
      signal.throwIfAborted();
      const saved = readSavedManagerSession(
        { id: reference.piSessionId, path: reference.piSessionFile },
        { maxBytes: MAX_SESSION_BYTES },
      );
      const repository = await scope(saved.checkoutPath);
      if (
        repository.canonicalRepoKey === reference.canonicalRepoKey &&
        repository.isPrimary &&
        sameDirectory(saved.checkoutPath, repository.checkoutPath)
      ) {
        add(repository);
        valid = saved.role === "manager";
      }
    } catch {
      signal.throwIfAborted();
    }
    if (!valid)
      diagnostics.add("Some saved Manager sessions could not be verified");
    recoveryResults.set(reference.canonicalRepoKey, {
      path: reference.piSessionFile,
      id: reference.piSessionId,
      valid,
    });
    return valid;
  }

  async function observeProjectsDirectory() {
    const root = resolveLocalRepositoryPath(readConfig().projectsDirectory);
    if (!root.exists) return;
    const pending = [{ path: root.path, depth: 0 }];
    let visited = 0;
    let entries = 0;
    while (pending.length) {
      signal.throwIfAborted();
      if (++visited > MAX_DIRECTORIES || projects.size >= MAX_PROJECTS) {
        diagnostics.add("Projects directory observation limit reached");
        return;
      }
      const { path, depth } = pending.pop()!;
      try {
        // Recheck the path component chain before opening a queued directory.
        const directory = resolveLocalRepositoryPath(path);
        if (!directory.exists || directory.path !== path)
          throw new Error("Projects directory changed during observation");
        const marker = lstatSync(join(path, ".git"), { throwIfNoEntry: false });
        if (marker) {
          if (!marker.isDirectory() && !marker.isFile())
            throw new Error("Unsupported Git marker");
          const repository = await scope(path);
          if (!sameDirectory(repository.checkoutPath, path))
            throw new Error(
              "Git checkout root does not match discovery candidate",
            );
          add(repository);
          continue;
        }
        const children = await opendir(path);
        for await (const entry of children) {
          signal.throwIfAborted();
          if (++entries > MAX_DIRECTORY_ENTRIES) {
            diagnostics.add("Projects directory entry limit reached");
            return;
          }
          if (!entry.isDirectory() || entry.name === ".git") continue;
          if (depth >= MAX_DEPTH) {
            diagnostics.add("Projects directory depth limit reached");
            break;
          }
          pending.push({ path: join(path, entry.name), depth: depth + 1 });
        }
      } catch {
        signal.throwIfAborted();
        diagnostics.add(
          "Some projects directory locations could not be verified",
        );
      }
    }
  }

  async function observeManager(project: Project) {
    const key = project.canonicalRepoKey;
    try {
      signal.throwIfAborted();
      const status = readManagerDescriptorStatus(runtime, key);
      if (status?.live) {
        const checkout = project.primaryCheckoutPath;
        if (
          !checkout ||
          !project.workspaces.some(
            (workspace) =>
              workspace.workspaceId === status.descriptor.workspaceId &&
              workspace.checkoutPath === checkout &&
              workspace.isPrimary,
          )
        )
          throw new Error("Manager workspace not verified");
        await options.verifyRunningManager(
          { checkoutPath: checkout, canonicalRepoKey: key, isPrimary: true },
          status.descriptor,
          signal,
        );
        signal.throwIfAborted();
        const confirmed = readManagerDescriptorStatus(runtime, key);
        if (
          !confirmed?.live ||
          !sameManagerDescriptor(confirmed.descriptor, status.descriptor)
        )
          throw new Error("Manager lease changed during observation");
        project.managerStatus = "running";
        return;
      }
      if (!workspaceObservationComplete)
        throw new Error("Herdr workspace observation incomplete");
      const checkNoPendingLaunch = () => {
        const path = managerDescriptorPath(runtime, key);
        if (
          lstatSync(`${path}.unsettled`, { throwIfNoEntry: false }) ||
          (lstatSync(`${path}.startup.lock`, { throwIfNoEntry: false }) &&
            readProcessLockStatus(`${path}.startup.lock`).live)
        )
          throw new Error("Manager launch is unsettled or in progress");
      };
      checkNoPendingLaunch();
      const workspaceId = project.workspaces.find(
        (workspace) => workspace.isPrimary,
      )?.workspaceId;
      await requireNoLiveLegacyManager(pi, runtime, key, workspaceId, signal);
      signal.throwIfAborted();
      const reference = readManagerRecoveryReference(runtime, key);
      const known = recoveryResults.get(key);
      const valid =
        reference &&
        (known?.path === reference.piSessionFile &&
        known.id === reference.piSessionId
          ? known.valid
          : await observeRecovery(reference));
      checkNoPendingLaunch();
      if (readManagerDescriptorStatus(runtime, key)?.live)
        throw new Error("Manager lease changed during observation");
      if (reference && !valid) return;
      project.managerStatus = reference ? "recoverable" : "none";
    } catch {
      signal.throwIfAborted();
      diagnostics.add(
        "Some Manager authority or readiness observations were inconclusive",
      );
    }
  }

  let workspaceObservationComplete = false;
  try {
    signal.throwIfAborted();
    try {
      const inventory =
        options.inventory === undefined
          ? await herdrSessionSnapshot(pi, ctx, signal)
          : options.inventory;
      if (!inventory)
        throw new Error("Herdr workspace observation unavailable");
      await observeWorkspaces(inventory);
      workspaceObservationComplete = diagnostics.size === 0;
    } catch {
      signal.throwIfAborted();
      diagnostics.add("Herdr workspace observation unavailable");
    }
    const { references, complete } = listManagerRecoveryReferences(
      runtime,
      signal,
    );
    if (!complete)
      diagnostics.add("Manager recovery record observation incomplete");
    for (const reference of references) {
      if (recoveryResults.size >= MAX_PROJECTS) {
        diagnostics.add("Manager recovery observation limit reached");
        break;
      }
      await observeRecovery(reference);
    }
    if (options.includeProjectsDirectory) {
      try {
        await observeProjectsDirectory();
      } catch {
        signal.throwIfAborted();
        diagnostics.add(
          "Configured projects directory observation unavailable",
        );
      }
    }
    for (const project of projects.values()) {
      // A linked checkout can reveal its primary checkout without assuming
      // that every common directory lives inside the primary checkout.
      if (!project.primaryCheckoutPath) {
        const possiblePrimary = dirname(project.canonicalRepoKey);
        if (join(possiblePrimary, ".git") === project.canonicalRepoKey) {
          try {
            const repository = await scope(possiblePrimary);
            if (
              repository.canonicalRepoKey === project.canonicalRepoKey &&
              repository.isPrimary
            )
              add(repository);
          } catch {
            signal.throwIfAborted();
          }
        }
      }
      await observeManager(project);
    }
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (!deadline.aborted) throw error;
    diagnostics.add("Project observation time limit reached");
  }
  callerSignal?.throwIfAborted();
  return {
    projects: [...projects.values()].sort((a, b) =>
      a.canonicalRepoKey.localeCompare(b.canonicalRepoKey),
    ),
    complete: diagnostics.size === 0,
    diagnostics: [...diagnostics],
  };
}
