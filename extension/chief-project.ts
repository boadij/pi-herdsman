import {
  type ExtensionAPI,
  type ExtensionContext,
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requireCompatibleBuild, type RuntimeBuild } from "./compatibility.ts";
import { readConfig } from "./config.ts";
import {
  HerdrManagerPreparationFailure,
  HerdrStartFailure,
  localRepositoryScope,
  paneProcess,
  prepareHerdrManagerPane,
  runHerdr,
  sameDirectory,
  sameObservedSessionPath,
  startHerdrManagerInPane,
} from "./herdr.ts";
import {
  ensureManagerGitRepository,
  requireNoLiveLegacyManager,
} from "./manager-git.ts";
import {
  cloneRepository,
  createLocalRepositoryDirectory,
  parseRepositorySource,
  RepositoryCloneError,
  resolveLocalRepositoryPath,
  verifyLocalRepositoryPath,
} from "./repository.ts";
import {
  claimManagerStartupLock,
  managerDescriptorPath,
  readLeadCoordinationState,
  readManagerDescriptorStatus,
  readManagerRecoveryReference,
  removeManagerStartIntent,
  sameManagerDescriptor,
  sessionLeadRoleState,
  verifyManagerCoordinationAuthority,
  writeManagerStartIntent,
  type ChiefDescriptor,
  type ManagerDescriptor,
  type ManagerRecoveryReference,
  type SupervisionRuntime,
} from "./supervision.ts";

const STARTUP_TIMEOUT_MS = 90_000;
type Repository = NonNullable<
  Awaited<ReturnType<typeof ensureManagerGitRepository>>
>;
type Session = { id: string; path: string };
type LaunchGuard = {
  version: 1;
  chiefRoot: string;
  action: "start" | "resume";
  session: Session;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  previousCoordinator?: string;
};
const LAUNCH_GUARD_MAX_BYTES = 8192;

function readLaunchGuard(path: string): LaunchGuard | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > LAUNCH_GUARD_MAX_BYTES)
    throw new Error("Invalid unsettled Manager launch record");
  const record = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<LaunchGuard> | null;
  const identity = (value: unknown): value is string =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0");
  if (
    record?.version !== 1 ||
    !identity(record.chiefRoot) ||
    !isAbsolute(record.chiefRoot) ||
    (record.action !== "start" && record.action !== "resume") ||
    !record.session ||
    !identity(record.session.id) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.session.id) ||
    !identity(record.session.path) ||
    !isAbsolute(record.session.path) ||
    !identity(record.workspaceId) ||
    !identity(record.tabId) ||
    !identity(record.paneId) ||
    !identity(record.terminalId) ||
    (record.previousCoordinator !== undefined &&
      !identity(record.previousCoordinator))
  )
    throw new Error("Invalid unsettled Manager launch record");
  return record as LaunchGuard;
}

// The repository startup lock serializes publication and removal of this guard.
function syncLaunchGuardDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeLaunchGuard(path: string, record: LaunchGuard): void {
  const content = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(content) > LAUNCH_GUARD_MAX_BYTES)
    throw new Error("Unsettled Manager launch record is too large");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AggregateError(
          [error, cleanupError],
          "Could not publish Manager launch guard or clean up its temporary file",
        );
    }
    throw error;
  }
}

function clearLaunchGuard(path: string): void {
  unlinkSync(path);
  syncLaunchGuardDirectory(path);
}

type ProjectResult =
  | {
      status:
        | "cloned"
        | "started"
        | "resumed"
        | "already_running"
        | "resume_required"
        | "cancelled";
      repository: string;
    }
  | {
      status: "partial_failure";
      repository: string;
      stage: string;
      reason: string;
    };

type Host = {
  assertChief(ctx: ExtensionContext): Promise<void>;
  runtime(): SupervisionRuntime;
  build: RuntimeBuild;
  extensionPath: string;
  remoteIdentity(
    ctx: ExtensionContext,
    descriptor: Pick<
      ChiefDescriptor,
      "piSessionId" | "piSessionFile" | "paneId" | "tabId" | "workspaceId"
    >,
  ): Promise<unknown>;
};

function partial(
  repository: string,
  stage: string,
  error: unknown,
): ProjectResult {
  return {
    status: "partial_failure",
    repository,
    stage,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function reserveManagerSession(checkout: string): Session {
  const dir = SessionManager.create(checkout).getSessionDir();
  const path = join(realpathSync(dir), `manager-${randomUUID()}.jsonl`);
  closeSync(openSync(path, "wx", 0o600));
  // Pi initializes the reserved empty file with its own durable session header.
  const session = SessionManager.open(path, dir, checkout);
  return { id: session.getSessionId(), path };
}

function readSavedRole(session: Session, checkout: string) {
  if (!statSync(session.path).isFile())
    throw new Error("Saved Manager session is not a regular file");
  const entries = parseSessionEntries(readFileSync(session.path, "utf8"));
  const header = entries[0];
  if (
    header?.type !== "session" ||
    header.id !== session.id ||
    typeof header.cwd !== "string" ||
    !sameDirectory(header.cwd, checkout)
  )
    throw new Error(
      "Saved Manager session identity does not match the repository",
    );
  // Opening an existing file with Pi can migrate it. Validate the active branch in memory.
  const saved = SessionManager.inMemory(checkout, undefined, entries);
  return sessionLeadRoleState(saved.getBranch(), session.id)?.role;
}

function matchesSession(reference: ManagerRecoveryReference, session: Session) {
  return (
    reference.piSessionId === session.id &&
    sameObservedSessionPath(reference.piSessionFile, session.path)
  );
}

export function createChiefProjectRuntime(pi: ExtensionAPI, host: Host) {
  const clone = async (
    url: string,
    destination: string | undefined,
    ctx: ExtensionContext,
  ): Promise<ProjectResult> => {
    await host.assertChief(ctx);
    try {
      const repository = await cloneRepository(
        pi,
        url,
        readConfig().projectsDirectory,
        { destination, signal: ctx.signal },
      );
      return { status: "cloned", repository: repository.checkoutPath };
    } catch (error) {
      if (error instanceof RepositoryCloneError)
        return partial(error.destination, error.stage, error);
      throw error;
    }
  };

  async function verifyActive(
    ctx: ExtensionContext,
    runtime: SupervisionRuntime,
    repository: Repository,
    descriptor: ManagerDescriptor,
    terminalId?: string,
  ) {
    const { signal } = ctx;
    const scope = await localRepositoryScope(
      pi,
      { ...ctx, cwd: repository.checkoutPath },
      descriptor.workspaceId,
      signal,
    );
    if (
      !scope.isPrimary ||
      scope.repoKey !== descriptor.repoKey ||
      scope.canonicalRepoKey !== repository.canonicalRepoKey ||
      !sameDirectory(scope.checkoutPath, repository.checkoutPath)
    )
      throw new Error("Manager Herdr repository placement changed");
    verifyManagerCoordinationAuthority(
      descriptor,
      readLeadCoordinationState(runtime, descriptor.piSessionId),
      host.build,
      requireCompatibleBuild,
    );
    if (!(await host.remoteIdentity(ctx, descriptor)))
      throw new Error(
        "Manager Herdr placement or session identity could not be verified",
      );
    await verifyPaneProcess(
      ctx,
      repository,
      descriptor,
      descriptor.claim.pid,
      terminalId,
    );
    await host.assertChief(ctx);
    const current = readManagerDescriptorStatus(
      runtime,
      repository.canonicalRepoKey,
    );
    if (
      !current?.live ||
      !sameManagerDescriptor(current.descriptor, descriptor)
    )
      throw new Error("Manager authority changed during verification");
  }

  async function verifyPaneProcess(
    ctx: ExtensionContext,
    repository: Repository,
    placement: Pick<ManagerDescriptor, "paneId" | "tabId" | "workspaceId">,
    pid: number,
    terminalId?: string,
  ) {
    const { signal } = ctx;
    const pane = (
      await runHerdr(pi, ctx, ["pane", "get", placement.paneId], { signal })
    )?.pane;
    if (
      pane?.pane_id !== placement.paneId ||
      pane.tab_id !== placement.tabId ||
      pane.workspace_id !== placement.workspaceId ||
      (terminalId !== undefined && pane.terminal_id !== terminalId) ||
      typeof pane.cwd !== "string" ||
      !sameDirectory(pane.cwd, repository.checkoutPath)
    )
      throw new Error("Manager Herdr pane no longer matches the repository");
    const process = await paneProcess(
      pi,
      ctx,
      placement.paneId,
      signal,
      undefined,
      true,
    );
    if (!process?.foreground_processes?.some((entry) => entry.pid === pid))
      throw new Error(
        "Manager lease owner is not the exact running Herdr pane process",
      );
  }

  async function verifyLaunchReady(
    ctx: ExtensionContext,
    runtime: SupervisionRuntime,
    repository: Repository,
    descriptor: ManagerDescriptor,
    guard: LaunchGuard,
  ): Promise<boolean> {
    const { session } = guard;
    if (
      descriptor.piSessionId !== session.id ||
      !descriptor.piSessionFile ||
      !sameObservedSessionPath(descriptor.piSessionFile, session.path) ||
      descriptor.workspaceId !== guard.workspaceId ||
      descriptor.tabId !== guard.tabId ||
      descriptor.paneId !== guard.paneId
    )
      throw new Error(
        "Manager lease does not match the requested Pi session and pane",
      );
    const currentRecovery = () =>
      readManagerRecoveryReference(runtime, repository.canonicalRepoKey);
    const recovery = currentRecovery();
    if (recovery && !matchesSession(recovery, session))
      throw new Error(
        "Manager recovery reference does not match the requested Pi session",
      );
    const coordinator = readLeadCoordinationState(runtime, session.id);
    if (
      !recovery ||
      !coordinator ||
      coordinator.instanceId === guard.previousCoordinator ||
      readSavedRole(session, repository.checkoutPath) !== "manager"
    )
      return false;
    await verifyActive(ctx, runtime, repository, descriptor, guard.terminalId);
    const confirmed = currentRecovery();
    if (!confirmed || !matchesSession(confirmed, session))
      throw new Error(
        "Manager recovery reference changed during readiness verification",
      );
    return true;
  }

  async function manage(
    action: "start" | "resume",
    input: string,
    destination: string | undefined,
    ctx: ExtensionContext,
  ): Promise<ProjectResult> {
    await host.assertChief(ctx);
    const { signal } = ctx;
    const source = parseRepositorySource(input);
    if (action === "resume" && source.kind !== "local")
      throw new Error("resume_manager requires a local repository path");
    if (source.kind === "local" && destination !== undefined)
      throw new Error("destination is supported only for remote repositories");
    let repositoryPath = source.kind === "local" ? source.path : input;
    let stage = "repository";
    let preparationChanged = false;
    try {
      const approve = async (target: string) => {
        if (readConfig().managerGitBootstrapWithoutConfirmation) return true;
        if (!ctx.hasUI)
          throw new Error(
            "Chief requires interactive confirmation to initialize Git",
          );
        return ctx.ui.confirm(
          "Prepare Manager repository?",
          `Initialize Git at ${target}, creating the directory if missing? Existing files will not be committed.`,
        );
      };
      let repository: Repository | undefined;
      if (source.kind === "remote") {
        repository = await cloneRepository(
          pi,
          source.url,
          readConfig().projectsDirectory,
          { destination, signal },
        );
        preparationChanged = true;
      } else {
        let selected = resolveLocalRepositoryPath(source.path);
        repositoryPath = selected.path;
        if (selected.exists)
          repository = await ensureManagerGitRepository(pi, repositoryPath, {
            signal,
            createIfMissing: false,
          });
        if (!repository && action === "resume")
          throw new Error(
            "Recovery requires a verified local primary Git checkout",
          );
        if (!repository) {
          stage = "git_setup";
          const needsCreation = !selected.exists;
          if (needsCreation) {
            if (!(await approve(repositoryPath)))
              return { status: "cancelled", repository: repositoryPath };
            await host.assertChief(ctx);
            verifyLocalRepositoryPath(selected);
            preparationChanged = true;
            selected = createLocalRepositoryDirectory(selected);
            repositoryPath = selected.path;
          }
          repository = await ensureManagerGitRepository(pi, repositoryPath, {
            signal,
            createIfMissing: true,
            confirm: needsCreation
              ? undefined
              : async (target) => {
                  const approved = await approve(target);
                  if (approved) preparationChanged = true;
                  return approved;
                },
            verifyApprovedTarget: async (target) => {
              await host.assertChief(ctx);
              verifyLocalRepositoryPath(selected);
              if (!sameDirectory(target, selected.path))
                throw new Error("Approved local repository path changed");
            },
          });
          if (!repository)
            return { status: "cancelled", repository: repositoryPath };
        }
      }
      if (!repository)
        throw new Error("Manager repository could not be prepared");
      repositoryPath = repository.checkoutPath;
      const { canonicalRepoKey } = repository;
      const runtime = host.runtime();
      stage = "manager_check";
      const lock = claimManagerStartupLock(runtime, canonicalRepoKey);
      let session: Session | undefined;
      let hasIntent = false;
      let launchMayHaveStarted = false;
      const guardPath = `${managerDescriptorPath(runtime, canonicalRepoKey)}.unsettled`;
      try {
        await host.assertChief(ctx);
        try {
          const guard = readLaunchGuard(guardPath);
          if (guard) {
            if (guard.chiefRoot !== runtime.root)
              return partial(
                repositoryPath,
                "unsettled_launch",
                new Error(
                  "A prior Manager launch from another Pi profile or Herdr socket is unsettled. Reconcile it in the originating runtime before retrying.",
                ),
              );
            try {
              await requireNoLiveLegacyManager(
                pi,
                runtime,
                canonicalRepoKey,
                guard.workspaceId,
                signal,
              );
              const active = readManagerDescriptorStatus(
                runtime,
                canonicalRepoKey,
              );
              if (
                !active?.live ||
                !(await verifyLaunchReady(
                  ctx,
                  runtime,
                  repository,
                  active.descriptor,
                  guard,
                ))
              )
                throw new Error(
                  "The exact Manager has not reached verified readiness",
                );
              if (guard.action === "start")
                removeManagerStartIntent(runtime, guard.session.id);
              clearLaunchGuard(guardPath);
              return { status: "already_running", repository: repositoryPath };
            } catch (error) {
              return partial(
                repositoryPath,
                "unsettled_launch",
                new Error(
                  `Prior Manager ${guard.action} for Pi session ${guard.session.id} in Herdr pane ${guard.paneId} is unsettled. Inspect that exact session and pane in the initiating Herdr runtime before retrying; no new Pi process was launched. If the attempt cannot be verified live, an operator must reconcile the retained launch record at ${guardPath}. ${String(error)}`,
                ),
              );
            }
          }
        } catch (error) {
          return partial(
            repositoryPath,
            "unsettled_launch",
            new Error(
              `Cannot verify the prior Manager launch record. Ask the operator to reconcile the record at ${guardPath} with Herdr state before retrying. ${String(error)}`,
            ),
          );
        }
        await requireNoLiveLegacyManager(
          pi,
          runtime,
          canonicalRepoKey,
          undefined,
          signal,
        );
        const active = readManagerDescriptorStatus(runtime, canonicalRepoKey);
        if (active?.live && action === "start") {
          // Optional auto-activation holds live authority without a durable role.
          await verifyActive(ctx, runtime, repository, active.descriptor);
          return { status: "already_running", repository: repositoryPath };
        }

        stage = "recovery";
        const readRecovery = () => {
          const recovery = readManagerRecoveryReference(
            runtime,
            canonicalRepoKey,
          );
          if (!recovery) return undefined;
          const saved = {
            id: recovery.piSessionId,
            path: realpathSync(recovery.piSessionFile),
          };
          if (readSavedRole(saved, repositoryPath) !== "manager")
            throw new Error(
              "Saved Pi session does not have a persisted Manager role",
            );
          return saved;
        };
        try {
          session = readRecovery();
          if (!session && action === "resume")
            throw new Error(
              "No saved Manager session is available for this repository",
            );
        } catch (error) {
          return partial(repositoryPath, stage, error);
        }
        if (session && action === "start")
          return { status: "resume_required", repository: repositoryPath };

        stage = "manager_check";
        if (active?.live) {
          const descriptor = active.descriptor;
          if (
            !session ||
            !descriptor.piSessionFile ||
            descriptor.piSessionId !== session.id ||
            !sameObservedSessionPath(descriptor.piSessionFile, session.path)
          )
            throw new Error("A different Manager session is already active");
          await verifyActive(ctx, runtime, repository, descriptor);
          return { status: "already_running", repository: repositoryPath };
        }

        stage = "workspace";
        const assertCurrentAuthority = () => host.assertChief(ctx);
        const options = {
          repository,
          signal,
          assertCurrentAuthority,
          timeoutMs: STARTUP_TIMEOUT_MS,
        };
        const pane = await prepareHerdrManagerPane(pi, ctx, options);
        preparationChanged = true;
        await requireNoLiveLegacyManager(
          pi,
          runtime,
          canonicalRepoKey,
          pane.workspaceId,
          signal,
        );

        stage = "session";
        await host.assertChief(ctx);
        if (!session) {
          session = reserveManagerSession(repositoryPath);
          hasIntent = true;
          writeManagerStartIntent(runtime, {
            version: 1,
            sessionId: session.id,
            canonicalRepoKey,
            checkoutPath: repositoryPath,
            workspaceId: pane.workspaceId,
            paneId: pane.paneId,
            createdAt: Date.now(),
          });
        }

        stage = "launch";
        const launchSession = session;
        const guard: LaunchGuard = {
          version: 1,
          chiefRoot: runtime.root,
          action,
          session: launchSession,
          workspaceId: pane.workspaceId,
          tabId: pane.tabId,
          paneId: pane.paneId,
          terminalId: pane.terminalId,
          previousCoordinator: readLeadCoordinationState(
            runtime,
            launchSession.id,
          )?.instanceId,
        };
        try {
          await startHerdrManagerInPane(pi, ctx, {
            ...options,
            pane,
            session: launchSession,
            extensionPath: host.extensionPath,
            assertCurrentAuthority: async () => {
              await assertCurrentAuthority();
              if (readManagerDescriptorStatus(runtime, canonicalRepoKey)?.live)
                throw new Error("Manager authority appeared before launch");
              if (action === "resume") {
                const saved = readRecovery();
                if (
                  !saved ||
                  saved.id !== launchSession.id ||
                  !sameObservedSessionPath(saved.path, launchSession.path)
                )
                  throw new Error(
                    "Manager recovery reference changed before launch",
                  );
              } else if (
                readManagerRecoveryReference(runtime, canonicalRepoKey)
              ) {
                throw new Error(
                  "Manager recovery reference appeared before launch",
                );
              }
              if (!launchMayHaveStarted) {
                // Herdr calls this immediately before it can request Pi startup.
                writeLaunchGuard(guardPath, guard);
                launchMayHaveStarted = true;
                syncLaunchGuardDirectory(guardPath);
              }
            },
          });
        } catch (error) {
          if (error instanceof HerdrStartFailure) {
            stage = error.stage;
            if (launchMayHaveStarted && !error.attempt.launchMayHaveStarted) {
              clearLaunchGuard(guardPath);
              launchMayHaveStarted = false;
            }
          }
          throw error;
        }

        stage = "readiness";
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          await host.assertChief(ctx);
          let pendingPid: number | undefined;
          const status = readManagerDescriptorStatus(
            runtime,
            canonicalRepoKey,
            (claim) => {
              pendingPid = claim.pid;
            },
          );
          if (pendingPid !== undefined) {
            await verifyPaneProcess(
              ctx,
              repository,
              pane,
              pendingPid,
              pane.terminalId,
            );
            if (
              !(await host.remoteIdentity(ctx, {
                ...pane,
                piSessionId: session.id,
                piSessionFile: session.path,
              }))
            )
              throw new Error(
                "Pending Manager claim does not match the launched Herdr session",
              );
          }
          if (
            status?.live &&
            (await verifyLaunchReady(
              ctx,
              runtime,
              repository,
              status.descriptor,
              guard,
            ))
          ) {
            if (hasIntent) removeManagerStartIntent(runtime, session.id);
            clearLaunchGuard(guardPath);
            return {
              status: action === "start" ? "started" : "resumed",
              repository: repositoryPath,
            };
          }
          await delay(100, undefined, { signal });
        }
        throw new Error(
          "Manager did not reach verified readiness before the startup deadline",
        );
      } catch (error) {
        if (hasIntent && session && !launchMayHaveStarted) {
          try {
            removeManagerStartIntent(runtime, session.id);
          } catch (cleanupError) {
            return partial(
              repositoryPath,
              stage,
              new AggregateError(
                [error, cleanupError],
                `${String(error)}; unused Manager startup intent could not be removed: ${String(cleanupError)}`,
              ),
            );
          }
        }
        throw error;
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof RepositoryCloneError)
        return partial(error.destination, error.stage, error);
      if (error instanceof HerdrManagerPreparationFailure)
        return partial(repositoryPath, error.stage, error);
      if (preparationChanged) return partial(repositoryPath, stage, error);
      throw error;
    }
  }

  return {
    clone,
    start: (
      repository: string,
      destination: string | undefined,
      ctx: ExtensionContext,
    ) => manage("start", repository, destination, ctx),
    resume: (repository: string, ctx: ExtensionContext) =>
      manage("resume", repository, undefined, ctx),
  };
}
