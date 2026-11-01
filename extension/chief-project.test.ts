import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChiefProjectRuntime } from "./chief-project.ts";
import type { RuntimeBuild } from "./compatibility.ts";
import { fakeContext, fakePi } from "./support.ts";
import {
  claimManagerLease,
  consumeManagerStartIntent,
  hasManagerStartIntent,
  listManagerDescriptors,
  managerRepositoryLeaseIsHeld,
  readLeadCoordinationState,
  writeLeadCoordinationState,
  writeManagerStartIntent,
  writeManagerRecoveryReference,
} from "./supervision.ts";

const BUILD: RuntimeBuild = { version: "test", sha256: "a".repeat(64) };
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ROLE_ENTRY = (sessionId: string) => ({
  type: "custom",
  customType: "pi-herdsman-role",
  data: { sessionId, role: "manager", leadTools: [] },
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chief-project-"));
  const checkoutPath = join(root, "checkout");
  const gitDir = join(checkoutPath, ".git");
  mkdirSync(gitDir, { recursive: true });
  const sessionFile = join(root, "manager.jsonl");
  const runtime = {
    root: join(root, "runtime"),
    lock: join(root, "runtime", "chief.lock"),
    descriptor: join(root, "runtime", "chief.json"),
    inbox: join(root, "runtime", "inbox"),
    coordinators: join(root, "runtime", "coordinators"),
    managers: join(root, "runtime", "managers"),
    assignments: join(root, "runtime", "assignments"),
    leads: join(root, "runtime", "coordinators"),
  };
  const leases: { release(): void }[] = [];
  const sessions = new Map<string, any>();
  const sessionEntries = new Map<string, unknown[]>();
  let execHandler = async (
    _command: string,
    args: string[],
    _options?: { signal?: AbortSignal; timeout?: number },
  ) => {
    const path =
      args[args.length - 1] === "--show-toplevel" ? checkoutPath : gitDir;
    return { stdout: path, stderr: "", code: 0 };
  };
  const pi = fakePi({
    exec: (command, args, options) => execHandler(command, args, options),
  }).pi;
  const pane = {
    repoKey: gitDir,
    checkoutPath,
    primaryWorkspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
  };
  const managerScope = {
    isPrimary: true,
    repoKey: gitDir,
    canonicalRepoKey: realpathSync.native(gitDir),
    checkoutPath,
  };
  let assertChiefCalls = 0;
  let remoteManagerChecks = 0;
  const host: any = {
    assertChief: async () => {
      assertChiefCalls++;
    },
    runtime: () => runtime,
    build: BUILD,
    extensionPath: "/test/extension.js",
    SessionManager: {
      open(path: string) {
        const session = sessions.get(realpathSync.native(path));
        if (!session) throw new Error("unexpected saved session");
        return session;
      },
    },
    remoteManager: async () => {
      remoteManagerChecks++;
      return { verified: true };
    },
    preparePane: async () => pane,
    repositoryScope: async () => managerScope,
    startInPane: async () => {
      throw new Error("unexpected Manager launch");
    },
  };
  function createSession(id: string, path = sessionFile, cwd = checkoutPath) {
    writeFileSync(
      path,
      `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`,
    );
    const entries = sessionEntries.get(path) ?? [ROLE_ENTRY(id)];
    sessionEntries.set(path, entries);
    sessions.set(realpathSync.native(path), {
      getSessionId: () => id,
      getSessionFile: () => path,
      getCwd: () => cwd,
      getEntries: () => entries,
    });
    return path;
  }
  function activateManager(
    id: string,
    path = sessionFile,
    overrides: Record<string, unknown> = {},
  ) {
    createSession(id, path);
    const lease = claimManagerLease(
      {
        piSessionId: id,
        piSessionFile: path,
        paneId: "pane-1",
        tabId: "tab-1",
        workspaceId: "workspace-1",
        repoKey: gitDir,
        canonicalRepoKey: realpathSync.native(gitDir),
        build: BUILD,
        ...overrides,
      } as any,
      runtime,
    );
    leases.push(lease);
    writeLeadCoordinationState(runtime, {
      version: 1,
      instanceId: "22222222-2222-4222-8222-222222222222",
      piSessionId: id,
      role: "manager",
      updatedAt: Date.now(),
      build: BUILD,
    });
    return lease.descriptor;
  }
  function projectRuntime() {
    return createChiefProjectRuntime(pi as any, host);
  }
  function cleanup() {
    for (const lease of leases.reverse()) lease.release();
    rmSync(root, { recursive: true, force: true });
  }
  function context() {
    return Object.assign(fakeContext(), {
      cwd: "/chief",
      signal: new AbortController().signal,
    });
  }
  return {
    root,
    checkoutPath,
    gitDir,
    sessionFile,
    runtime,
    leases,
    sessions,
    sessionEntries,
    pi,
    pane,
    managerScope,
    host,
    projectRuntime,
    context,
    setExecHandler(handler: typeof execHandler) {
      execHandler = handler;
    },
    createSession,
    activateManager,
    cleanup,
    get assertChiefCalls() {
      return assertChiefCalls;
    },
    get remoteManagerChecks() {
      return remoteManagerChecks;
    },
  };
}

test("startup-intent candidate check is exact-session and non-consuming", () => {
  const f = fixture();
  const intent = {
    version: 1 as const,
    sessionId: SESSION_ID,
    repoKey: realpathSync.native(f.gitDir),
    checkoutPath: realpathSync.native(f.checkoutPath),
    workspaceId: f.pane.primaryWorkspaceId,
    paneId: f.pane.paneId,
    createdAt: Date.now(),
  };
  try {
    assert.equal(hasManagerStartIntent(f.runtime, SESSION_ID), false);
    writeManagerStartIntent(f.runtime, intent);
    assert.equal(hasManagerStartIntent(f.runtime, SESSION_ID), true);
    assert.equal(
      hasManagerStartIntent(f.runtime, "22222222-2222-4222-8222-222222222222"),
      false,
    );
    assert.throws(
      () =>
        consumeManagerStartIntent(f.runtime, {
          ...intent,
          paneId: "other-pane",
        }),
      /does not match this Herdr session/,
    );
    assert.equal(hasManagerStartIntent(f.runtime, SESSION_ID), true);
    assert.deepEqual(consumeManagerStartIntent(f.runtime, intent), intent);
    assert.equal(hasManagerStartIntent(f.runtime, SESSION_ID), false);
  } finally {
    f.cleanup();
  }
});

test("Chief authorization precedes project side effects", async () => {
  const f = fixture();
  f.host.assertChief = async () => {
    throw new Error("not Chief");
  };
  let gitCalls = 0;
  let launches = 0;
  f.setExecHandler(async () => {
    gitCalls++;
    return { stdout: "", stderr: "", code: 1 };
  });
  f.host.startInPane = async () => {
    launches++;
    throw new Error("must not launch");
  };
  const rt = f.projectRuntime();
  try {
    await assert.rejects(
      rt.clone("https://example.test/owner/repo.git", undefined, {} as any),
      /not Chief/,
    );
    await assert.rejects(
      rt.start(f.checkoutPath, undefined, {} as any),
      /not Chief/,
    );
    await assert.rejects(rt.resume(f.checkoutPath, {} as any), /not Chief/);
    assert.equal(gitCalls, 0);
    assert.equal(launches, 0);
    assert.equal(f.leases.length, 0);
  } finally {
    f.cleanup();
  }
});

test("clone verifies the checkout and never launches a Manager", async () => {
  const f = fixture();
  const destination = join(realpathSync.native(f.root), "cloned");
  let launches = 0;
  f.setExecHandler(async (_command: string, args: string[]) => {
    if (args[0] === "clone") {
      mkdirSync(join(args[3]!, ".git"), { recursive: true });
      return { stdout: "", stderr: "", code: 0 };
    }
    const value =
      args.at(-1) === "--show-toplevel"
        ? destination
        : join(destination, ".git");
    return { stdout: value, stderr: "", code: 0 };
  });
  f.host.startInPane = async () => {
    launches++;
    throw new Error("clone must not start Manager");
  };
  try {
    const result = await f
      .projectRuntime()
      .clone("https://example.test/owner/repo.git", destination, {
        signal: new AbortController().signal,
      } as any);
    assert.deepEqual(result, { status: "cloned", repository: destination });
    assert.equal(launches, 0);
  } finally {
    f.cleanup();
  }
});

test("start reports success only after exact Manager readiness and preserves repo-key split", async () => {
  const f = fixture();
  const ctx: any = f.context();
  let launchOptions: any;
  let observedIntent: any;
  f.host.startInPane = async (_pi: unknown, _ctx: unknown, options: any) => {
    launchOptions = options;
    observedIntent = consumeManagerStartIntent(f.runtime, {
      sessionId: options.runId,
      repoKey: f.managerScope.repoKey,
      checkoutPath: f.checkoutPath,
      workspaceId: f.pane.primaryWorkspaceId,
      paneId: f.pane.paneId,
    });
    await options.verifyAuthorization({
      workspaceId: f.pane.primaryWorkspaceId,
      paneId: f.pane.paneId,
      tabId: f.pane.tabId,
      repoKey: f.gitDir,
      checkoutPath: f.checkoutPath,
    });
    f.activateManager(options.runId);
    return {
      herdrAgent: "manager-agent",
      workspaceId: f.pane.primaryWorkspaceId,
      tabId: f.pane.tabId,
      paneId: f.pane.paneId,
      terminalId: "terminal-1",
      cwd: f.checkoutPath,
      createdTab: false,
      launchMayHaveStarted: true,
      sessionReference: { id: options.runId, path: f.sessionFile },
    };
  };
  try {
    const result = await f
      .projectRuntime()
      .start(f.checkoutPath, undefined, ctx);
    assert.equal(result.status, "started");
    assert.equal(launchOptions.runId, observedIntent.sessionId);
    assert.deepEqual(launchOptions.agentArgs, [
      "--session-id",
      observedIntent.sessionId,
    ]);
    assert.equal(launchOptions.repoKey, f.gitDir);
    assert.equal(observedIntent.repoKey, f.gitDir);
    assert.equal(observedIntent.checkoutPath, f.checkoutPath);
    assert.equal(observedIntent.workspaceId, f.pane.primaryWorkspaceId);
    assert.equal(observedIntent.paneId, f.pane.paneId);
    assert.equal(
      f.leases[0]!.descriptor.canonicalRepoKey,
      realpathSync.native(f.gitDir),
    );
    assert.equal(f.leases[0]!.descriptor.repoKey, f.gitDir);
    assert.equal(
      listManagerDescriptors(f.runtime, true)[0]!.piSessionId,
      observedIntent.sessionId,
    );
    assert.equal(
      readLeadCoordinationState(f.runtime, observedIntent.sessionId)?.role,
      "manager",
    );
    assert.equal(
      managerRepositoryLeaseIsHeld(f.runtime, realpathSync.native(f.gitDir)),
      true,
    );
    assert.ok(observedIntent);
    assert.ok(f.remoteManagerChecks > 0);
    assert.ok(f.assertChiefCalls >= 3);
  } finally {
    f.cleanup();
  }
});

test("start reports resume_required for a verified stopped Manager", async () => {
  const f = fixture();
  const saved = f.createSession(SESSION_ID);
  writeManagerRecoveryReference(f.runtime, {
    version: 1,
    canonicalRepoKey: realpathSync.native(f.gitDir),
    piSessionId: SESSION_ID,
    piSessionFile: saved,
  });
  let launches = 0;
  f.host.startInPane = async () => {
    launches++;
    throw new Error("must not launch");
  };
  try {
    const result = await f.projectRuntime().start(f.checkoutPath, undefined, {
      ...f.context(),
    } as any);
    assert.deepEqual(result, {
      status: "resume_required",
      repository: realpathSync.native(f.checkoutPath),
    });
    assert.equal(launches, 0);
  } finally {
    f.cleanup();
  }
});

test("start rejects mismatched readiness without reporting success", async () => {
  const f = fixture();
  f.host.startInPane = async (_pi: unknown, _ctx: unknown, options: any) => {
    f.activateManager(options.runId, f.sessionFile, { paneId: "other-pane" });
    return {
      herdrAgent: "manager-agent",
      workspaceId: f.pane.primaryWorkspaceId,
      tabId: f.pane.tabId,
      paneId: f.pane.paneId,
      terminalId: "terminal-1",
      cwd: f.checkoutPath,
      createdTab: false,
      launchMayHaveStarted: true,
      sessionReference: { id: options.runId, path: f.sessionFile },
    };
  };
  try {
    const result = await f.projectRuntime().start(f.checkoutPath, undefined, {
      ...f.context(),
    } as any);
    assert.equal(result.status, "partial_failure");
    assert.equal((result as any).stage, "readiness");
    assert.match((result as any).reason, /lease identity/);
  } finally {
    f.cleanup();
  }
});

test("resume restores the saved session file and rejects foreign sessions or another live Manager", async () => {
  const f = fixture();
  const ctx: any = f.context();
  const recoveryPath = f.createSession(SESSION_ID);
  writeManagerRecoveryReference(f.runtime, {
    version: 1,
    canonicalRepoKey: realpathSync.native(f.gitDir),
    piSessionId: SESSION_ID,
    piSessionFile: recoveryPath,
  });
  let launchOptions: any;
  f.host.startInPane = async (_pi: unknown, _ctx: unknown, options: any) => {
    launchOptions = options;
    f.activateManager(SESSION_ID, recoveryPath);
    return {
      herdrAgent: "manager-agent",
      workspaceId: f.pane.primaryWorkspaceId,
      tabId: f.pane.tabId,
      paneId: f.pane.paneId,
      terminalId: "terminal-1",
      cwd: f.checkoutPath,
      createdTab: false,
      launchMayHaveStarted: true,
      sessionReference: { id: SESSION_ID, path: recoveryPath },
    };
  };
  try {
    const resumed = await f.projectRuntime().resume(f.checkoutPath, ctx);
    assert.equal(resumed.status, "resumed");
    assert.equal(launchOptions.runId, SESSION_ID);
    assert.deepEqual(launchOptions.agentArgs, ["--session", recoveryPath]);
    assert.equal(launchOptions.agentArgs.includes("--session-id"), false);
    f.leases.pop()!.release();

    const foreign = join(f.root, "foreign.jsonl");
    f.createSession(SESSION_ID, foreign, join(f.root, "elsewhere"));
    writeManagerRecoveryReference(f.runtime, {
      version: 1,
      canonicalRepoKey: realpathSync.native(f.gitDir),
      piSessionId: SESSION_ID,
      piSessionFile: foreign,
    });
    await assert.rejects(
      f.projectRuntime().resume(f.checkoutPath, ctx),
      /invalid or foreign/,
    );

    writeManagerRecoveryReference(f.runtime, {
      version: 1,
      canonicalRepoKey: realpathSync.native(f.gitDir),
      piSessionId: SESSION_ID,
      piSessionFile: recoveryPath,
    });
    f.activateManager(
      "33333333-3333-4333-8333-333333333333",
      join(f.root, "other-live.jsonl"),
    );
    await assert.rejects(
      f.projectRuntime().resume(f.checkoutPath, ctx),
      /Another Manager is already active/,
    );
  } finally {
    f.cleanup();
  }
});
