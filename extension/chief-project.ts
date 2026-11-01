import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requireCompatibleBuild, type RuntimeBuild } from "./compatibility.ts";
import { readConfig } from "./config.ts";
import { sameDirectory } from "./path-identity.ts";
import {
  localRepositoryScope,
  prepareHerdrManagerPane,
  readPiSessionHeaderId,
  sameObservedSessionPath,
  startHerdrManagerInPane,
  HerdrStartFailure,
  type HerdrManagerLaunchTarget,
  type HerdrManagerPaneSelection,
  type StartedHerdrAgent,
} from "./herdr.ts";
import {
  confirmManagerGitSetup,
  ensureManagerGitRepository,
} from "./manager-git.ts";
import {
  CloneDestinationExistsError,
  RepositoryCloneError,
  assertSafeLocalRepositoryPath,
  cloneRepository,
  parseRepositorySource,
  resolveLocalRepositoryPath,
} from "./repository.ts";
import {
  claimManagerStartupLock,
  listManagerDescriptors,
  managerRepositoryLeaseIsHeld,
  readLeadCoordinationState,
  readManagerRecoveryReference,
  removeManagerStartIntent,
  sameManagerDescriptor,
  sessionLeadRoleState,
  verifyManagerCoordinationAuthority,
  writeManagerStartIntent,
  type ManagerDescriptor,
  type ManagerRecoveryReference,
  type ManagerStartIntent,
  type SupervisionRuntime,
} from "./supervision.ts";

const MANAGER_STARTUP_TIMEOUT_MS = 90_000;
const MANAGER_STARTUP_POLL_MS = 100;

export type ChiefManagerStartResult =
  | { status: "started" | "resumed"; repository: string }
  | { status: "already_running"; repository: string }
  | { status: "resume_required"; repository: string }
  | { status: "cancelled"; repository: string }
  | {
      status: "partial_failure";
      repository: string;
      stage: string;
      reason: string;
    };

export type ChiefProjectHost = {
  assertChief(ctx: ExtensionContext): Promise<void>;
  runtime(): SupervisionRuntime;
  build: RuntimeBuild;
  extensionPath: string;
  SessionManager: Pick<
    typeof import("@earendil-works/pi-coding-agent").SessionManager,
    "open"
  >;
  remoteManager(
    ctx: ExtensionContext,
    descriptor: ManagerDescriptor,
  ): Promise<unknown | undefined>;
  preparePane: typeof prepareHerdrManagerPane;
  startInPane: typeof startHerdrManagerInPane;
  repositoryScope: typeof localRepositoryScope;
};

export function createChiefProjectRuntime(
  pi: ExtensionAPI,
  host: ChiefProjectHost,
) {
  const clone = async (
    url: string,
    destination: string | undefined,
    ctx: ExtensionContext,
  ) => {
    await host.assertChief(ctx);
    const source = parseRepositorySource(url);
    if (source.kind !== "remote")
      throw new Error("clone_repository requires an HTTPS or SSH Git remote");
    try {
      const repository = await cloneRepository(
        pi,
        source.url,
        readConfig().projectsDirectory,
        { destination, signal: ctx.signal },
      );
      await host.assertChief(ctx);
      return { status: "cloned" as const, repository };
    } catch (error) {
      if (error instanceof RepositoryCloneError)
        return {
          status: "partial_failure" as const,
          repository: error.destination,
          stage: error.stage,
          reason: error.message,
        };
      if (error instanceof CloneDestinationExistsError)
        return {
          status: "destination_exists" as const,
          repository: error.destination,
        };
      throw error;
    }
  };

  const start = async (
    repository: string,
    destination: string | undefined,
    ctx: ExtensionContext,
  ): Promise<ChiefManagerStartResult> => {
    await host.assertChief(ctx);
    const source = parseRepositorySource(repository);
    if (source.kind === "local" && destination !== undefined)
      throw new Error("destination is supported only for remote repositories");

    let target = source.kind === "local" ? source.path : undefined;
    let cloneCompleted = false;
    let launchMayHaveStarted = false;
    let intentSessionId: string | undefined;
    let stage = "repository";
    try {
      if (source.kind === "remote") {
        stage = "clone";
        target = await cloneRepository(
          pi,
          source.url,
          readConfig().projectsDirectory,
          { destination, signal: ctx.signal },
        );
        cloneCompleted = true;
      }
      if (!target) throw new Error("Repository path could not be resolved");

      stage = "git_setup";
      const git = await ensureManagerGitRepository(pi, target, {
        signal: ctx.signal,
        createIfMissing: source.kind === "local",
        confirm: async (path) => {
          await host.assertChief(ctx);
          if (
            !ctx.hasUI &&
            !readConfig().managerGitBootstrapWithoutConfirmation
          )
            throw new Error(
              "Chief requires interactive confirmation to initialize Git",
            );
          return confirmManagerGitSetup(ctx, path);
        },
        verifyApprovedTarget: () => host.assertChief(ctx),
      });
      if (!git) return { status: "cancelled", repository: target };
      const scope = await verifyPrimaryCheckout(pi, git.checkoutPath, ctx);
      if (!sameDirectory(scope.commonDir, git.commonDir))
        throw new Error(
          "Selected repository identity changed during Git setup",
        );

      stage = "manager_check";
      const release = claimManagerStartupLock(host.runtime(), scope.commonDir);
      try {
        await host.assertChief(ctx);
        if (await findActiveManager(ctx, scope))
          return {
            status: "already_running",
            repository: scope.checkoutPath,
          };
        const recovery = readManagerRecoveryReference(
          host.runtime(),
          scope.commonDir,
        );
        if (recovery) {
          await verifyRecoverySession(recovery, scope);
          return { status: "resume_required", repository: scope.checkoutPath };
        }

        stage = "workspace";
        const projectContext = contextFor(ctx, scope.checkoutPath);
        const pane = await host.preparePane(pi, projectContext, {
          repoKey: scope.commonDir,
          checkoutPath: scope.checkoutPath,
          signal: ctx.signal,
        });
        const managerScope = await host.repositoryScope(
          pi,
          projectContext,
          pane.primaryWorkspaceId,
          ctx.signal,
        );
        verifySelectedScope(managerScope, scope);
        const launchScope = { ...scope, repoKey: managerScope.repoKey };

        intentSessionId = randomUUID();
        const intent: ManagerStartIntent = {
          version: 1,
          sessionId: intentSessionId,
          repoKey: managerScope.repoKey,
          checkoutPath: managerScope.checkoutPath,
          workspaceId: pane.primaryWorkspaceId,
          paneId: pane.paneId,
          createdAt: Date.now(),
        };
        writeManagerStartIntent(host.runtime(), intent);

        stage = "launch";
        let started: StartedHerdrAgent;
        try {
          started = await host.startInPane(pi, projectContext, {
            repoKey: managerScope.repoKey,
            checkoutPath: managerScope.checkoutPath,
            primaryWorkspaceId: pane.primaryWorkspaceId,
            tabId: pane.tabId,
            paneId: pane.paneId,
            label: "Manager",
            runId: intentSessionId,
            extensionPath: host.extensionPath,
            agentArgs: ["--session-id", intentSessionId],
            timeoutMs: MANAGER_STARTUP_TIMEOUT_MS,
            signal: ctx.signal,
            verifyAuthorization: async (actual) => {
              await host.assertChief(ctx);
              verifyLaunchTarget(actual, pane, managerScope.repoKey, scope);
            },
          });
        } catch (error) {
          if (error instanceof HerdrStartFailure)
            launchMayHaveStarted = error.attempt.launchMayHaveStarted;
          throw error;
        }
        launchMayHaveStarted = started.launchMayHaveStarted;
        requireStartedSession(started, intentSessionId);

        stage = "readiness";
        await waitForManagerReady(
          ctx,
          launchScope,
          pane,
          intentSessionId,
          undefined,
          started,
        );
        removeManagerStartIntent(host.runtime(), intentSessionId);
        intentSessionId = undefined;
        return {
          status: "started",
          repository: scope.checkoutPath,
        };
      } finally {
        release.release();
      }
    } catch (error) {
      if (intentSessionId && !launchMayHaveStarted) {
        try {
          removeManagerStartIntent(host.runtime(), intentSessionId);
        } catch {}
      }
      if (error instanceof RepositoryCloneError)
        return {
          status: "partial_failure",
          repository: error.destination,
          stage: error.stage,
          reason: error.message,
        };
      if (launchMayHaveStarted || cloneCompleted)
        return {
          status: "partial_failure",
          repository: target ?? repository,
          stage,
          reason: error instanceof Error ? error.message : String(error),
        };
      throw error;
    }
  };

  const resume = async (
    repository: string,
    ctx: ExtensionContext,
  ): Promise<ChiefManagerStartResult> => {
    await host.assertChief(ctx);
    const source = parseRepositorySource(repository);
    if (source.kind !== "local")
      throw new Error("resume_manager requires a local repository path");
    const scope = await verifyPrimaryCheckout(pi, source.path, ctx);
    const recovery = readManagerRecoveryReference(
      host.runtime(),
      scope.commonDir,
    );
    if (!recovery)
      throw new Error(
        "No previous Manager session is available for this repository",
      );
    await verifyRecoverySession(recovery, scope);

    const release = claimManagerStartupLock(host.runtime(), scope.commonDir);
    try {
      await host.assertChief(ctx);
      const active = await findActiveManager(ctx, scope);
      if (active) {
        if (
          active.piSessionId === recovery.piSessionId &&
          active.piSessionFile &&
          sameObservedSessionPath(active.piSessionFile, recovery.piSessionFile)
        )
          return {
            status: "already_running",
            repository: scope.checkoutPath,
          };
        throw new Error(
          "Another Manager is already active for this repository",
        );
      }

      const projectContext = contextFor(ctx, scope.checkoutPath);
      const pane = await host.preparePane(pi, projectContext, {
        repoKey: scope.commonDir,
        checkoutPath: scope.checkoutPath,
        signal: ctx.signal,
      });
      const managerScope = await host.repositoryScope(
        pi,
        projectContext,
        pane.primaryWorkspaceId,
        ctx.signal,
      );
      verifySelectedScope(managerScope, scope);
      const launchScope = { ...scope, repoKey: managerScope.repoKey };

      let launchMayHaveStarted = false;
      try {
        let started: StartedHerdrAgent;
        try {
          started = await host.startInPane(pi, projectContext, {
            repoKey: managerScope.repoKey,
            checkoutPath: managerScope.checkoutPath,
            primaryWorkspaceId: pane.primaryWorkspaceId,
            tabId: pane.tabId,
            paneId: pane.paneId,
            label: "Manager",
            runId: recovery.piSessionId,
            extensionPath: host.extensionPath,
            agentArgs: ["--session", recovery.piSessionFile],
            timeoutMs: MANAGER_STARTUP_TIMEOUT_MS,
            signal: ctx.signal,
            verifyAuthorization: async (actual) => {
              await host.assertChief(ctx);
              verifyLaunchTarget(actual, pane, managerScope.repoKey, scope);
            },
          });
        } catch (error) {
          if (error instanceof HerdrStartFailure)
            launchMayHaveStarted = error.attempt.launchMayHaveStarted;
          throw error;
        }
        launchMayHaveStarted = started.launchMayHaveStarted;
        requireStartedSession(
          started,
          recovery.piSessionId,
          recovery.piSessionFile,
        );
        await waitForManagerReady(
          ctx,
          launchScope,
          pane,
          recovery.piSessionId,
          recovery.piSessionFile,
          started,
        );
        return {
          status: "resumed",
          repository: scope.checkoutPath,
        };
      } catch (error) {
        if (launchMayHaveStarted)
          return {
            status: "partial_failure",
            repository: scope.checkoutPath,
            stage: "resume_readiness",
            reason: error instanceof Error ? error.message : String(error),
          };
        throw error;
      }
    } finally {
      release.release();
    }
  };

  async function findActiveManager(
    ctx: ExtensionContext,
    scope: VerifiedRepository,
  ): Promise<ManagerDescriptor | undefined> {
    const managers = listManagerDescriptors(host.runtime(), true).filter(
      (descriptor) =>
        descriptor.canonicalRepoKey !== undefined &&
        sameDirectory(descriptor.canonicalRepoKey, scope.commonDir),
    );
    if (managers.length > 1)
      throw new Error("Multiple active Managers match this repository");
    const manager = managers[0];
    if (!manager) {
      if (managerRepositoryLeaseIsHeld(host.runtime(), scope.commonDir))
        throw new Error(
          "Manager repository lease is active but its descriptor is unavailable",
        );
      return undefined;
    }
    if (
      manager.canonicalRepoKey !== undefined &&
      !sameDirectory(manager.canonicalRepoKey, scope.commonDir)
    )
      throw new Error(
        "Manager descriptor has a conflicting repository identity",
      );
    verifyManagerCoordinationAuthority(
      manager,
      readLeadCoordinationState(host.runtime(), manager.piSessionId),
      host.build,
      requireCompatibleBuild,
    );
    if (!(await host.remoteManager(ctx, manager)))
      throw new Error(
        "Manager is active but its exact Herdr process identity is unverified",
      );
    return manager;
  }

  async function verifyRecoverySession(
    recovery: ManagerRecoveryReference,
    scope: VerifiedRepository,
  ): Promise<void> {
    if (
      !sameDirectory(recovery.canonicalRepoKey, scope.commonDir) ||
      !isAbsolute(recovery.piSessionFile)
    )
      throw new Error(
        "Manager recovery reference does not match this repository",
      );
    try {
      const file = realpathSync.native(recovery.piSessionFile);
      const session = host.SessionManager.open(file);
      if (
        session.getSessionId() !== recovery.piSessionId ||
        !sameObservedSessionPath(session.getSessionFile(), file) ||
        !sameDirectory(session.getCwd(), scope.checkoutPath) ||
        readPiSessionHeaderId(file) !== recovery.piSessionId
      )
        throw new Error(
          "saved Pi session identity does not match the repository",
        );
      const persisted = sessionLeadRoleState(
        session.getEntries(),
        recovery.piSessionId,
      );
      if (persisted?.role !== "manager")
        throw new Error("saved Pi session is not persisted as a Manager");
      const savedScope = await verifyPrimaryCheckout(pi, session.getCwd());
      if (!sameDirectory(savedScope.commonDir, scope.commonDir))
        throw new Error("saved Pi session belongs to a different repository");
    } catch (error) {
      throw new Error("Manager recovery reference is invalid or foreign", {
        cause: error,
      });
    }
  }

  async function waitForManagerReady(
    ctx: ExtensionContext,
    scope: VerifiedManagerRepository,
    pane: HerdrManagerPaneSelection,
    sessionId: string,
    expectedFile: string | undefined,
    started: StartedHerdrAgent,
  ): Promise<ManagerDescriptor> {
    const deadline = Date.now() + MANAGER_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      ctx.signal.throwIfAborted();
      await host.assertChief(ctx);
      const descriptors = listManagerDescriptors(host.runtime(), true).filter(
        (descriptor) =>
          descriptor.canonicalRepoKey !== undefined &&
          sameDirectory(descriptor.canonicalRepoKey, scope.commonDir),
      );
      if (descriptors.length > 1)
        throw new Error("Multiple active Managers match this repository");
      const descriptor = descriptors[0];
      if (descriptor) {
        if (
          descriptor.piSessionId !== sessionId ||
          descriptor.workspaceId !== pane.primaryWorkspaceId ||
          descriptor.paneId !== pane.paneId ||
          descriptor.tabId !== pane.tabId ||
          !descriptor.canonicalRepoKey ||
          !sameDirectory(descriptor.canonicalRepoKey, scope.commonDir) ||
          descriptor.repoKey !== scope.repoKey ||
          !descriptor.piSessionFile ||
          (expectedFile &&
            !sameObservedSessionPath(descriptor.piSessionFile, expectedFile))
        )
          throw new Error(
            "Manager lease identity does not match the requested session",
          );
        if (!existsSync(descriptor.piSessionFile)) {
          await delay(MANAGER_STARTUP_POLL_MS, undefined, {
            signal: ctx.signal,
          });
          continue;
        }
        const file = realpathSync.native(descriptor.piSessionFile);
        const session = host.SessionManager.open(file);
        if (
          session.getSessionId() !== sessionId ||
          !sameObservedSessionPath(session.getSessionFile(), file) ||
          !sameDirectory(session.getCwd(), scope.checkoutPath)
        )
          throw new Error("Manager Pi session file or repository changed");
        const role = sessionLeadRoleState(session.getEntries(), sessionId);
        if (!role) {
          await delay(MANAGER_STARTUP_POLL_MS, undefined, {
            signal: ctx.signal,
          });
          continue;
        }
        if (role.role !== "manager")
          throw new Error("Pi session did not restore the Manager role");
        if (
          started.sessionReference?.path &&
          !sameObservedSessionPath(started.sessionReference.path, file)
        )
          throw new Error("Herdr observed a different Pi session file");
        if (
          started.sessionReference?.id &&
          started.sessionReference.id !== sessionId
        )
          throw new Error("Herdr observed a different Pi session ID");
        const coordinator = readLeadCoordinationState(
          host.runtime(),
          sessionId,
        );
        if (!coordinator) {
          await delay(MANAGER_STARTUP_POLL_MS, undefined, {
            signal: ctx.signal,
          });
          continue;
        }
        verifyManagerCoordinationAuthority(
          descriptor,
          coordinator,
          host.build,
          requireCompatibleBuild,
        );
        if (!(await host.remoteManager(ctx, descriptor))) {
          await delay(MANAGER_STARTUP_POLL_MS, undefined, {
            signal: ctx.signal,
          });
          continue;
        }
        const current = listManagerDescriptors(host.runtime(), true).find(
          (candidate) => candidate.workspaceId === pane.primaryWorkspaceId,
        );
        if (!current || !sameManagerDescriptor(current, descriptor))
          throw new Error(
            "Manager lease changed during readiness verification",
          );
        if (!managerRepositoryLeaseIsHeld(host.runtime(), scope.commonDir))
          throw new Error(
            "Manager repository lease was released during startup",
          );
        const finalScope = await verifyPrimaryCheckout(
          pi,
          scope.checkoutPath,
          ctx,
        );
        if (!sameDirectory(finalScope.commonDir, scope.commonDir))
          throw new Error("Manager repository changed during startup");
        return descriptor;
      }
      await delay(MANAGER_STARTUP_POLL_MS, undefined, { signal: ctx.signal });
    }
    throw new Error(
      "Manager did not reach verified readiness before the startup deadline",
    );
  }

  return { clone, start, resume };
}

type VerifiedRepository = Readonly<{
  checkoutPath: string;
  commonDir: string;
}>;

async function verifyPrimaryCheckout(
  pi: ExtensionAPI,
  repository: string,
  ctx?: ExtensionContext,
): Promise<VerifiedRepository> {
  const source = assertSafeLocalRepositoryPath(repository);
  const run = async (argument: string) => {
    const result = await pi.exec(
      "git",
      ["rev-parse", "--path-format=absolute", argument],
      { cwd: source, signal: ctx?.signal, timeout: 10_000 },
    );
    const value = String(result.stdout ?? "").trim();
    if (
      result.code !== 0 ||
      result.killed ||
      result.stderr?.trim() ||
      !isAbsolute(value)
    )
      throw new Error("A verified local primary Git repository is required");
    try {
      return realpathSync.native(value);
    } catch {
      throw new Error("Git repository identity is unavailable");
    }
  };
  const [checkoutPath, gitDir, commonDir] = await Promise.all([
    run("--show-toplevel"),
    run("--git-dir"),
    run("--git-common-dir"),
  ]);
  if (!sameDirectory(checkoutPath, source) || !sameDirectory(gitDir, commonDir))
    throw new Error("Manager requires the verified primary Git worktree");
  return { checkoutPath, commonDir };
}

type VerifiedManagerRepository = VerifiedRepository &
  Readonly<{ repoKey: string }>;

function verifySelectedScope(
  actual: Awaited<ReturnType<typeof localRepositoryScope>>,
  expected: VerifiedRepository,
): void {
  if (
    !actual.isPrimary ||
    !sameDirectory(actual.canonicalRepoKey, expected.commonDir) ||
    !sameDirectory(actual.checkoutPath, expected.checkoutPath)
  )
    throw new Error("Herdr workspace does not match the selected repository");
}

function verifyLaunchTarget(
  actual: HerdrManagerLaunchTarget,
  expected: HerdrManagerPaneSelection,
  expectedRepoKey: string,
  scope: VerifiedRepository,
): void {
  if (
    actual.workspaceId !== expected.primaryWorkspaceId ||
    actual.paneId !== expected.paneId ||
    actual.tabId !== expected.tabId ||
    actual.repoKey !== expectedRepoKey ||
    !sameDirectory(actual.checkoutPath, scope.checkoutPath)
  )
    throw new Error("Chief Manager launch target changed");
}

function contextFor(ctx: ExtensionContext, cwd: string): ExtensionContext {
  return { ...ctx, cwd };
}

function requireStartedSession(
  started: StartedHerdrAgent,
  expectedId: string,
  expectedFile?: string,
): void {
  const observed = started.sessionReference;
  if (!observed)
    throw new Error("Herdr did not report the launched Pi session identity");
  if (observed.id && observed.id !== expectedId)
    throw new Error("Herdr started a different Pi session ID");
  if (observed.path) {
    let actualId: string | undefined;
    try {
      actualId = readPiSessionHeaderId(observed.path);
    } catch {
      throw new Error("Herdr returned an invalid Pi session file");
    }
    if (actualId !== expectedId)
      throw new Error("Herdr started a different Pi conversation");
    if (expectedFile && !sameObservedSessionPath(observed.path, expectedFile))
      throw new Error("Herdr restored a different Pi session file");
  }
}
