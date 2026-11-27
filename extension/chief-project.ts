import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ProjectTrustStore,
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  isRuntimeBuild,
  sameRuntimeBuild,
  requireCompatibleBuild,
  type RuntimeBuild,
} from "./compatibility.ts";
import { readConfig } from "./config.ts";
import {
  ensurePrimaryWorkspace,
  HerdrManagerPreparationFailure,
  HerdrStartFailure,
  localRepositoryScope,
  paneProcess,
  prepareHerdrManagerPane,
  prepareHerdrCoordinatorPane,
  startHerdrCoordinatorInPane,
  herdrSessionSnapshot,
  herdrSessionId,
  worktreeGroupScope,
  gitRepositoryScope,
  requireHerdrPiIntegration,
  runHerdr,
  sameDirectory,
  sameObservedSessionPath,
  startHerdrManagerInPane,
  type HerdrManagerPaneSelection,
} from "./herdr.ts";
import {
  ensureManagerGitRepository,
  requireNoLiveLegacyManager,
} from "./manager-git.ts";
import { readSavedManagerSession } from "./manager-recovery.ts";
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
  verifyManagerCoordinationAuthority,
  writeManagerStartIntent,
  type ChiefDescriptor,
  type ManagerDescriptor,
  type ManagerRecoveryReference,
  type SupervisionRuntime,
  listCoordinatorStartIntents,
  type CoordinatorStartIntent,
} from "./supervision.ts";
import {
  AGENT_COORDINATION_TOOLS,
  agentLaunchArgs,
  coordinatorLaunchConfiguration,
  EXPECTED_COORDINATOR_LAUNCH_ENV,
  notifyDefinitionWarning,
  resolveDefinition,
  type AgentDefinition,
} from "./agent-definitions.ts";

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
  definition?: string;
  launchConfiguration?: string;
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
      !identity(record.previousCoordinator)) ||
    (record.definition !== undefined && !identity(record.definition)) ||
    (record.launchConfiguration !== undefined &&
      (typeof record.launchConfiguration !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.launchConfiguration)))
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
  | { status: "cloned"; repository: string; workspaceId: string }
  | {
      status:
        | "started"
        | "resumed"
        | "already_running"
        | "resume_required"
        | "cancelled";
      repository: string;
      definition?: string;
    }
  | {
      status: "lead_started";
      workspaceId: string;
      checkout: string;
      session: { id: string; path: string };
      definition: string;
      initialMessage: "not_requested" | "queued" | "not_queued";
      messageResult?: unknown;
      supervisor: "chief" | "manager" | "unknown";
    }
  | {
      status: "partial_failure";
      repository: string;
      stage: string;
      reason: string;
      placement?: HerdrManagerPreparationFailure["placement"];
      session?: { id: string; path: string };
    };

type Host = {
  assertChief(ctx: ExtensionContext): Promise<void>;
  runtime(): SupervisionRuntime;
  build: RuntimeBuild;
  extensionPath: string;
  managerTools?: readonly string[];
  resolveDefinition?(
    category: "manager",
    name: string,
    projectRoot?: string,
  ): AgentDefinition;
  remoteIdentity(
    ctx: ExtensionContext,
    descriptor: Pick<
      ChiefDescriptor,
      "piSessionId" | "piSessionFile" | "paneId" | "tabId" | "workspaceId"
    >,
  ): Promise<unknown>;
  sendInitialLeadMessage?(
    sessionId: string,
    message: string,
    ctx: ExtensionContext,
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
    ...(error instanceof HerdrManagerPreparationFailure && {
      placement: error.placement,
    }),
  };
}

function reserveManagerSession(checkout: string): Session {
  return reserveCoordinatorSession(checkout, "manager");
}

function reserveCoordinatorSession(
  checkout: string,
  role: "manager" | "lead",
): Session {
  const dir = SessionManager.create(checkout).getSessionDir();
  const path = join(realpathSync(dir), `${role}-${randomUUID()}.jsonl`);
  closeSync(openSync(path, "wx", 0o600));
  // Pi initializes the reserved empty file with its own durable session header.
  const session = SessionManager.open(path, dir, checkout);
  return { id: session.getSessionId(), path };
}

function managerDefinition(
  name: string,
  checkout: string,
  agentDir: string,
  ctx: ExtensionContext,
  host: Host,
): AgentDefinition {
  const trusted = new ProjectTrustStore(agentDir).get(checkout) === true;
  return host.resolveDefinition
    ? host.resolveDefinition("manager", name, trusted ? checkout : undefined)
    : resolveDefinition("manager", name, {
        ...(trusted ? { projectRoot: checkout } : {}),
        onWarning: (message) => notifyDefinitionWarning(ctx, message),
      });
}

function readSavedRole(session: Session, checkout: string) {
  return readSavedManagerSession(session, { checkout }).role;
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
    let repository: Awaited<ReturnType<typeof cloneRepository>>;
    try {
      repository = await cloneRepository(
        pi,
        url,
        readConfig().projectsDirectory,
        { destination, signal: ctx.signal },
      );
    } catch (error) {
      if (error instanceof RepositoryCloneError)
        return partial(error.destination, error.stage, error);
      throw error;
    }
    try {
      const lock = claimManagerStartupLock(
        host.runtime(),
        repository.canonicalRepoKey,
      );
      try {
        const { workspaceId } = await ensurePrimaryWorkspace(pi, ctx, {
          repository,
          signal: ctx.signal,
          assertCurrentAuthority: () => host.assertChief(ctx),
          timeoutMs: STARTUP_TIMEOUT_MS,
        });
        return {
          status: "cloned",
          repository: repository.checkoutPath,
          workspaceId,
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      return partial(
        repository.checkoutPath,
        error instanceof HerdrManagerPreparationFailure
          ? error.stage
          : "workspace",
        error,
      );
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
    if (
      guard.launchConfiguration !== undefined &&
      coordinator.startupAttestation?.launchConfiguration !==
        guard.launchConfiguration
    ) {
      if (coordinator.startupAttestation?.launchConfiguration !== undefined)
        throw new Error(
          "Manager startup attested a different launch configuration",
        );
      return false;
    }
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
    definitionName: string | undefined,
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
          if (definitionName) {
            const sessionFile = active.descriptor.piSessionFile;
            const sessionId = active.descriptor.piSessionId;
            const binding =
              sessionFile && sessionId
                ? readSavedManagerSession(
                    { id: sessionId, path: sessionFile },
                    { checkout: repositoryPath },
                  ).definition
                : undefined;
            const name =
              binding?.category === "manager" ? binding.name : "manager";
            if (name !== definitionName)
              throw new Error(
                `An active Manager uses definition ${name}; it cannot be replaced with ${definitionName}`,
              );
          }
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
        if (session && action === "start") {
          const binding = readSavedManagerSession(session, {
            checkout: repositoryPath,
          }).definition;
          if (
            definitionName &&
            binding?.category === "manager" &&
            definitionName !== binding.name
          )
            throw new Error(
              `Manager definition ${binding.name} is saved for this session; it cannot be replaced with ${definitionName}`,
            );
          return {
            status: "resume_required",
            repository: repositoryPath,
            ...(binding?.category === "manager"
              ? { definition: binding.name }
              : {}),
          };
        }

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

        stage = "preflight";
        const agentDir = resolve(getAgentDir());
        const savedBinding = session
          ? readSavedManagerSession(session, { checkout: repositoryPath })
              .definition
          : undefined;
        const managerBinding =
          savedBinding?.category === "manager" ? savedBinding : undefined;
        const selectedName =
          managerBinding?.name ?? definitionName ?? "manager";
        const definition = managerDefinition(
          selectedName,
          repositoryPath,
          agentDir,
          ctx,
          host,
        );
        if (
          session &&
          definitionName &&
          managerBinding?.name !== definitionName
        )
          throw new Error(
            `Manager session is bound to ${managerBinding?.name ?? "manager"}; it cannot be replaced with ${definitionName}`,
          );
        const launchArgs = agentLaunchArgs(definition, {
          cwd: repositoryPath,
          // Pi's native allowlist filters registration. The runtime decides
          // which Agent tools to expose from the role policy and owned work.
          requiredTools: [
            ...(host.managerTools ?? []),
            ...AGENT_COORDINATION_TOOLS,
          ],
          nativeCoordinatorDefaults: true,
          omitBodyPrompt: true,
        });
        const launchConfiguration = coordinatorLaunchConfiguration(
          definition,
          repositoryPath,
        );
        requireHerdrPiIntegration(agentDir);
        stage = "workspace";
        const assertCurrentAuthority = () => host.assertChief(ctx);
        const options = {
          agentDir,
          repository,
          signal,
          assertCurrentAuthority,
          timeoutMs: STARTUP_TIMEOUT_MS,
          env: [`${EXPECTED_COORDINATOR_LAUNCH_ENV}=${launchConfiguration}`],
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
            role: "manager",
            canonicalRepoKey,
            checkoutPath: repositoryPath,
            workspaceId: pane.workspaceId,
            paneId: pane.paneId,
            tabId: pane.tabId,
            createdAt: Date.now(),
            definition: selectedName,
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
          definition: selectedName,
          previousCoordinator: readLeadCoordinationState(
            runtime,
            launchSession.id,
          )?.instanceId,
          launchConfiguration,
        };
        try {
          await startHerdrManagerInPane(pi, ctx, {
            ...options,
            pane,
            session: launchSession,
            agentArgs: launchArgs,
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
              definition: selectedName,
            };
          }
          await delay(100, undefined, { signal });
        }
        throw new Error(
          "Manager did not reach verified readiness before the startup deadline. Inspect the exact session for startup definition, project trust, or model selection errors.",
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

  const startLead = async (
    workspaceId: string,
    requestedDefinition: string | undefined,
    message: string | undefined,
    ctx: ExtensionContext,
  ): Promise<ProjectResult> => {
    await host.assertChief(ctx);
    if (requestedDefinition === "managed-lead")
      throw new Error(
        "managed-lead is reserved for assigned Leads and cannot be used for an ordinary Lead",
      );
    const signal = ctx.signal;
    if (!workspaceId.trim() || workspaceId.includes("\0"))
      throw new Error("workspace must be an exact Herdr workspace ID");
    const intents = listCoordinatorStartIntents(host.runtime());
    if (!intents.complete)
      throw new Error(
        "Cannot verify Coordinator startup reservations; no Lead was launched",
      );
    const existing = intents.intents.find(
      (intent) => intent.role === "lead" && intent.workspaceId === workspaceId,
    );
    if (existing)
      throw new Error(
        `An ordinary Lead startup for this workspace remains unsettled (session ${existing.sessionId}, pane ${existing.paneId}); inspect that exact attempt before retrying`,
      );

    const snapshot = await herdrSessionSnapshot(pi, ctx, signal);
    const matches = snapshot.workspaces.filter(
      (item) => item?.workspace_id === workspaceId,
    );
    if (matches.length !== 1)
      throw new Error(
        "Selected Herdr workspace is missing or ambiguous in the current profile",
      );
    const workspace = matches[0]!;
    const membershipPath = workspace.worktree?.checkout_path;
    const observedPaths =
      typeof membershipPath === "string" && isAbsolute(membershipPath)
        ? [membershipPath]
        : snapshot.panes
            .filter(
              (pane) =>
                pane?.workspace_id === workspaceId &&
                typeof pane.cwd === "string" &&
                isAbsolute(pane.cwd),
            )
            .map((pane) => pane.cwd as string);
    const uniquePaths = new Map<string, string>();
    for (const path of observedPaths) {
      try {
        uniquePaths.set(realpathSync(path), path);
      } catch {}
    }
    if (uniquePaths.size !== 1)
      throw new Error(
        "Selected workspace checkout is not established by one exact Herdr observation",
      );
    const checkout = realpathSync([...uniquePaths.keys()][0]!);
    let repository: Awaited<ReturnType<typeof gitRepositoryScope>> | undefined;
    try {
      repository = await gitRepositoryScope(pi, checkout, signal);
      if (!sameDirectory(repository.checkoutPath, checkout))
        throw new Error(
          "Selected workspace does not resolve to its exact Git checkout root",
        );
      if (
        workspace.worktree &&
        (!sameDirectory(
          workspace.worktree.checkout_path,
          repository.checkoutPath,
        ) ||
          !sameDirectory(
            workspace.worktree.repo_key,
            repository.canonicalRepoKey,
          ))
      )
        throw new Error(
          "Herdr workspace association conflicts with Git checkout identity",
        );
    } catch (error) {
      if (workspace.worktree)
        throw new Error(
          `Selected Git workspace could not be verified: ${String(error)}`,
        );
      // A workspace without Herdr worktree metadata may be non-Git. Confirm that
      // Git did not resolve it into an enclosing repository before treating its
      // exact observed directory as an ordinary checkout.
      const probe = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: checkout,
        signal,
        timeout: 2_000,
      });
      if (
        probe.code === 0 ||
        !/not a git repository/iu.test(probe.stderr ?? "")
      )
        throw new Error(
          "Selected workspace checkout is not unambiguously Git or non-Git",
        );
    }

    let activeManager = false;
    if (repository) {
      const status = readManagerDescriptorStatus(
        host.runtime(),
        repository.canonicalRepoKey,
      );
      if (status?.live) {
        try {
          const group = await worktreeGroupScope(
            pi,
            ctx,
            status.descriptor.workspaceId,
            signal,
          );
          activeManager =
            group.workspaceIds.includes(workspaceId) &&
            !!(await host.remoteIdentity(ctx, status.descriptor));
        } catch (error) {
          if (message)
            throw new Error(
              `Cannot determine whether the active Manager supervises this workspace; omit message and retry after resolving topology. ${String(error)}`,
            );
        }
      }
    }
    if (activeManager && message)
      throw new Error(
        "Chief cannot deliver an initial message to a Lead supervised by the active project Manager; omit message or ask the Manager to direct its staff",
      );

    const agentDir = resolve(getAgentDir());
    const projectTrusted =
      new ProjectTrustStore(agentDir).get(checkout) === true;
    const mode =
      requestedDefinition === "flexible-lead"
        ? "flexible"
        : requestedDefinition === "orchestrator-lead"
          ? "orchestrate"
          : readConfig().defaultLeadExecution;
    const definitionName =
      requestedDefinition ??
      (mode === "flexible" ? "flexible-lead" : "orchestrator-lead");
    const definition = resolveDefinition("lead", definitionName, {
      ...(projectTrusted ? { projectRoot: checkout } : {}),
      onWarning: (warning) => notifyDefinitionWarning(ctx, warning),
    });
    requireHerdrPiIntegration(agentDir);
    const launchArgs = agentLaunchArgs(definition, {
      cwd: checkout,
      nativeCoordinatorDefaults: true,
      omitBodyPrompt: true,
    });
    const launchConfiguration = coordinatorLaunchConfiguration(
      definition,
      checkout,
    );
    const session = reserveCoordinatorSession(checkout, "lead");
    let pane: HerdrManagerPaneSelection | undefined;
    try {
      pane = await prepareHerdrCoordinatorPane(pi, ctx, {
        workspaceId,
        cwd: checkout,
        agentDir,
        label: "Lead",
        signal,
        env: [`${EXPECTED_COORDINATOR_LAUNCH_ENV}=${launchConfiguration}`],
        assertCurrentAuthority: () => host.assertChief(ctx),
      });
      await host.assertChief(ctx);
      const intent: CoordinatorStartIntent = {
        version: 1,
        sessionId: session.id,
        role: "lead",
        checkoutPath: checkout,
        workspaceId,
        tabId: pane.tabId,
        paneId: pane.paneId,
        leadMode: mode,
        definition: definitionName,
        createdAt: Date.now(),
      };
      writeManagerStartIntent(host.runtime(), intent);
      const previousInstance = readLeadCoordinationState(
        host.runtime(),
        session.id,
      )?.instanceId;
      const startedAt = Date.now();
      let launched = false;
      try {
        await startHerdrCoordinatorInPane(pi, ctx, {
          agentDir,
          workspaceId,
          tabId: pane.tabId,
          paneId: pane.paneId,
          terminalId: pane.terminalId,
          cwd: checkout,
          label: "lead",
          runId: session.id,
          extensionPath: host.extensionPath,
          session,
          assertCurrentAuthority: () => host.assertChief(ctx),
          signal,
          agentArgs: [...launchArgs, "--session", session.path],
        });
        launched = true;
      } catch (error) {
        if (
          error instanceof HerdrStartFailure &&
          !error.attempt.launchMayHaveStarted
        ) {
          removeManagerStartIntent(host.runtime(), session.id);
          throw error;
        }
        launched =
          error instanceof HerdrStartFailure
            ? error.attempt.launchMayHaveStarted
            : true;
        if (!launched) removeManagerStartIntent(host.runtime(), session.id);
        throw error;
      }

      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let freshLeadReady = false;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        await host.assertChief(ctx);
        const observed = await herdrSessionSnapshot(pi, ctx, signal);
        const agents = observed.agents.filter(
          (agent) =>
            agent?.workspace_id === workspaceId &&
            agent?.pane_id === pane!.paneId &&
            agent?.tab_id === pane!.tabId &&
            herdrSessionId(agent) === session.id,
        );
        if (agents.length > 1)
          throw new Error("Ordinary Lead session is ambiguous in Herdr");
        const state = readLeadCoordinationState(host.runtime(), session.id);
        if (
          agents.length === 1 &&
          state?.role === "lead" &&
          state.piSessionId === session.id &&
          state.updatedAt >= startedAt &&
          state.instanceId !== previousInstance &&
          state.startupAttestation?.launchConfiguration ===
            launchConfiguration &&
          isRuntimeBuild(state.build) &&
          sameRuntimeBuild(state.build, host.build) &&
          (await host.remoteIdentity(ctx, {
            piSessionId: session.id,
            piSessionFile: session.path,
            paneId: pane.paneId,
            tabId: pane.tabId,
            workspaceId,
          }))
        ) {
          freshLeadReady = true;
          break;
        }
        await delay(100, undefined, { signal });
      }
      if (!freshLeadReady)
        throw new Error(
          `Ordinary Lead ${session.id} in pane ${pane.paneId} did not reach exact fresh readiness; inspect the exact session for startup definition, project trust, or model selection errors before retrying`,
        );
      await host.assertChief(ctx);
      let initialMessage: "not_requested" | "queued" | "not_queued" =
        "not_requested";
      let messageResult: unknown;
      if (message) {
        try {
          if (!host.sendInitialLeadMessage)
            throw new Error("Authorized Chief staff messaging is unavailable");
          messageResult = await host.sendInitialLeadMessage(
            session.id,
            message,
            ctx,
          );
          initialMessage = "queued";
        } catch (error) {
          initialMessage = "not_queued";
          messageResult =
            error instanceof Error ? error.message : String(error);
        }
      }
      return {
        status: "lead_started",
        workspaceId,
        checkout,
        session,
        definition: definitionName,
        supervisor: activeManager
          ? "manager"
          : repository
            ? "chief"
            : "unknown",
        initialMessage,
        ...(messageResult !== undefined ? { messageResult } : {}),
      };
    } catch (error) {
      const failure = partial(checkout, "lead_start", error);
      return {
        ...failure,
        ...(session ? { session } : {}),
        ...(pane
          ? {
              placement: {
                workspaceId,
                tabId: pane.tabId,
                paneId: pane.paneId,
              },
            }
          : {}),
      };
    }
  };

  return {
    clone,
    verifyActive,
    start: (
      repository: string,
      destination: string | undefined,
      ctx: ExtensionContext,
    ) => manage("start", repository, destination, undefined, ctx),
    resume: (repository: string, ctx: ExtensionContext) =>
      manage("resume", repository, undefined, undefined, ctx),
    startNamed: (
      repository: string,
      destination: string | undefined,
      definition: string | undefined,
      ctx: ExtensionContext,
    ) => manage("start", repository, destination, definition, ctx),
    startLead,
  };
}
