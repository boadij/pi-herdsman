import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { sameDirectory } from "../herdr.ts";
import { AGENT_ID, WORKSPACE, fakeContext, realFs } from "../support.ts";
import { rememberCoordinatorTarget } from "../coordinator-target.ts";
import {
  persistRequiredEvidenceSnapshot,
  readRequiredEvidenceSnapshot,
} from "../storage.ts";

const { createLeadProjectRuntime, parseGitWorktreeInventory } =
  await import("./project.ts");
const { readProjectAssignment, writeProjectAssignment } =
  await import("../supervision.ts");

const lifecycleStop = "stop after assignment publication";
const testSha = (letter: string) => letter.repeat(40);

test("staff message rejects an identity change during attachment preparation", async () => {
  const entries: unknown[] = [];
  const ctx = fakeContext(entries) as any;
  const pi = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  };
  const session = randomUUID();
  const target = rememberCoordinatorTarget(pi as any, ctx, "lead", session);
  const authority = {
    leaseId: "lease",
    repoKey: "/repo",
    piSessionId: randomUUID(),
  };
  let paneId = "original";
  let release!: () => void;
  let started!: () => void;
  const preparing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const runtime = createLeadProjectRuntime({
    pi,
    leadRuntime: {},
    activeRole: () => "manager",
    currentManager: async () => authority,
    managerLease: () => ({ descriptor: authority }),
    supervisionRuntime: () => ({}),
    directReports: async () => [
      {
        lead: session,
        paneId,
        workspaceId: "workspace",
        tabId: "tab",
        instanceId: "instance",
        relationship: "supervised",
        availableActions: ["message"],
      },
    ],
    findProjectAssignmentBySession: () => [],
    resolveMessageFiles: () => ["attachment"],
    prepareCoordinationInput: async () => {
      started();
      await resume;
      return { text: "message", resultBindings: [] };
    },
    writeChiefMessage: () => {
      writes++;
    },
  } as any);
  const operation = runtime.executeStaff(
    "message",
    { action: "message", target, message: "message", files: ["attachment"] },
    undefined,
    undefined,
    ctx,
  );
  await preparing;
  paneId = "changed";
  release();
  await assert.rejects(operation, /changed before the message was queued/);
  assert.equal(writes, 0);
});

function baselineLifecycle(options: {
  reused?: boolean;
  resume?: boolean;
  managerHead?: string;
  worktreeHead?: string;
  mergeBases?: string[];
  savedBaseline?: string;
  retained?: ReturnType<typeof persistRequiredEvidenceSnapshot>;
  rejectEvidence?: boolean;
  rejectAtPublication?: boolean;
}) {
  const repoKey = realFs.realpathSync(process.cwd());
  const managerCheckout = repoKey;
  const worktreePath = join(tmpdir(), `project-${randomUUID()}`);
  mkdirSync(worktreePath);
  const workspaceId = `workspace-${randomUUID()}`;
  const assignments = join(tmpdir(), `assignments-${randomUUID()}`);
  const assignmentRoot = join(assignments, "root");
  mkdirSync(assignmentRoot, { recursive: true });
  const branch = "feature/baseline";
  const manager = {
    repoKey,
    workspaceId: WORKSPACE,
    socket: "/test-socket",
    group: null,
    leaseId: randomUUID(),
    piSessionId: randomUUID(),
  };
  const gitCalls: { args: string[]; cwd?: string }[] = [];
  let published: any;
  const current = options.resume
    ? {
        version: 2 as const,
        id: randomUUID(),
        repoKey,
        branch,
        text: "existing task",
        checkoutPath: realFs.realpathSync(worktreePath),
        gitBaselineSha: options.savedBaseline,
      }
    : undefined;
  const topology = {
    source: {
      repo_key: repoKey,
      repo_name: "project",
      source_workspace_id: WORKSPACE,
      source_checkout_path: managerCheckout,
    },
    worktrees:
      options.reused || options.resume
        ? [{ path: worktreePath, branch, is_linked_worktree: true }]
        : [],
  };
  const runtime = createLeadProjectRuntime({
    pi: {
      exec: async (command: string, args: string[], execOptions: any) => {
        if (command === "herdr") {
          const result =
            args[0] === "worktree" && args[1] === "list"
              ? topology
              : args[0] === "workspace" && args[1] === "get"
                ? { workspace: { workspace_id: WORKSPACE } }
                : {};
          return {
            stdout: JSON.stringify({ id: AGENT_ID, result }),
            stderr: "",
            code: 0,
          };
        }
        gitCalls.push({ args, cwd: execOptions?.cwd });
        let stdout = "";
        if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
          stdout = managerCheckout;
        else if (args[0] === "rev-parse" && args.includes("--git-dir"))
          stdout = repoKey;
        else if (args[0] === "rev-parse" && args.includes("--git-common-dir"))
          stdout = repoKey;
        else if (args[0] === "symbolic-ref") stdout = `${branch}\n`;
        else if (args[0] === "rev-parse" && args.includes("HEAD^{commit}"))
          stdout = `${execOptions?.cwd === managerCheckout ? options.managerHead : options.worktreeHead}\n`;
        else if (args[0] === "merge-base")
          stdout = `${(options.mergeBases ?? []).join("\n")}\n`;
        return { stdout, stderr: "", code: 0 };
      },
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } } as any,
    managerLease: () => ({ descriptor: manager }),
    currentManager: async () => manager,
    sameManagerDescriptor: (a: any, b: any) =>
      a.piSessionId === b.piSessionId && a.leaseId === b.leaseId,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: topology.worktrees,
    }),
    supervisionRuntime: () => ({ root: assignmentRoot, assignments }),
    readProjectAssignment: () => current,
    listProjectAssignments: () => (current ? [current] : []),
    reconcileProjectAssignments: async () => {},
    runHerdr: async (_pi: any, _ctx: any, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return topology;
      if (args[0] === "workspace" && args[1] === "get")
        return { workspace: { workspace_id: WORKSPACE } };
      if (args[0] === "worktree" && args[1] === "create")
        return {
          workspace: { workspace_id: workspaceId },
          root_pane: { pane_id: "pane" },
          tab: { tab_id: "tab" },
          worktree: { path: worktreePath, branch },
        };
      if (args[0] === "worktree" && args[1] === "open")
        return {
          workspace: { workspace_id: workspaceId },
          root_pane: { pane_id: "pane" },
          tab: { tab_id: "tab" },
          worktree: { path: worktreePath, branch },
        };
      throw new Error(`Unexpected Herdr request: ${args.join(" ")}`);
    },
    herdrSessionSnapshot: async () => {
      throw new Error(lifecycleStop);
    },
    liveAgent: async () => [],
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareMessageInput: (text: string) => ({ text, resultBindings: [] }),
    managerEvidence: options.retained
      ? async () => ({
          roots: new Set(["source"]),
          retained: [options.retained],
          verify: () => {
            if (options.rejectAtPublication)
              throw new Error("evidence authority changed at publication");
          },
          verifyProvenance: () => {},
          revalidate: async (operation: () => unknown) => {
            if (options.rejectEvidence)
              throw new Error("evidence authority changed");
            await operation();
          },
        })
      : undefined,
    resolveMessageFiles: () =>
      options.retained
        ? [
            {
              kind: "retainedEvidence",
              ref: options.retained.ref,
              name: options.retained.name,
              path: options.retained.path,
              sha256: options.retained.sha256,
            },
          ]
        : [],
    persistRequiredEvidenceSnapshot: () => ({
      id: "brief",
      name: "project-brief.md",
      sourceAssignmentId: "assignment",
      path: "/brief",
      sha256: "a".repeat(64),
    }),
    persistRequiredTextFiles: () => [],
    withProjectWorkLock: (_key: string, operation: () => unknown) =>
      operation(),
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => unknown,
    ) => operation(),
    writeProjectAssignment: (
      _runtime: unknown,
      assignment: any,
      verify?: () => void,
    ) => {
      verify?.();
      published = assignment;
    },
    appendDurableError: () => {},
  } as any);
  if (current)
    writeProjectAssignment(
      { root: assignmentRoot, assignments } as any,
      current,
    );
  const ctx = fakeContext() as any;
  ctx.cwd = managerCheckout;
  return {
    branch,
    manager,
    managerCheckout,
    worktreePath,
    workspaceId,
    gitCalls,
    get published() {
      return published;
    },
    runtime,
    ctx,
    activate: (signal = new AbortController().signal) =>
      runtime.activateProjectLead(
        options.resume
          ? { action: "resume", branch }
          : {
              action: "delegate",
              task: "work",
              branch,
              ...(options.retained ? { files: [options.retained.ref!] } : {}),
            },
        ctx,
        signal,
      ),
  };
}

test("delegation copies retained evidence under the destination and rejects stale authority", async () => {
  const source = persistRequiredEvidenceSnapshot(
    randomUUID(),
    "source.md",
    "selected content",
  );
  const accepted = baselineLifecycle({
    retained: source,
    managerHead: testSha("a"),
    worktreeHead: testSha("b"),
  });
  await assert.rejects(accepted.activate(), new RegExp(lifecycleStop));
  const copy = accepted.published.requiredEvidence.find(
    (entry: any) => entry.name === source.name,
  );
  assert.ok(copy);
  assert.equal(copy.sourceAssignmentId, accepted.published.id);
  assert.notEqual(copy.ref, source.ref);
  assert.equal(
    readRequiredEvidenceSnapshot(copy.sourceAssignmentId, copy),
    "selected content",
  );
  assert.equal(
    readRequiredEvidenceSnapshot(source.sourceAssignmentId, source),
    "selected content",
  );
  const denied = baselineLifecycle({
    retained: source,
    rejectEvidence: true,
    managerHead: testSha("a"),
    worktreeHead: testSha("b"),
  });
  await assert.rejects(denied.activate(), /evidence authority changed/);
  assert.equal(denied.published, undefined);
  const stale = baselineLifecycle({
    retained: source,
    rejectAtPublication: true,
    managerHead: testSha("a"),
    worktreeHead: testSha("b"),
  });
  await assert.rejects(
    stale.activate(),
    /evidence authority changed at publication/,
  );
  assert.equal(stale.published, undefined);
});

test("nested retained provenance is rechecked at the synchronous assignment publication guard", async () => {
  const repoKey = realFs.realpathSync(process.cwd());
  const assignments = join(tmpdir(), `provenance-assignments-${randomUUID()}`);
  const root = join(assignments, "root");
  mkdirSync(root, { recursive: true });
  const assignment = {
    version: 2 as const,
    id: randomUUID(),
    repoKey,
    branch: "feature/provenance",
    text: "work",
  };
  const runtimeDir = { root, assignments } as any;
  writeProjectAssignment(runtimeDir, assignment);
  const manager = {
    piSessionId: randomUUID(),
    repoKey,
    workspaceId: WORKSPACE,
    leaseId: randomUUID(),
  } as any;
  const retained = persistRequiredEvidenceSnapshot(
    randomUUID(),
    "source.md",
    "selected content",
  );
  let current = assignment;
  let nestedProvenance = "nested-parent-original";
  const runtime = createLeadProjectRuntime({
    leadRuntime: { roleSuspended: false } as any,
    activeRole: () => "manager",
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: manager }),
    sameManagerDescriptor: (left: any, right: any) =>
      left.piSessionId === right.piSessionId && left.leaseId === right.leaseId,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
    }),
    supervisionRuntime: () => runtimeDir,
    readProjectAssignment: () => current,
    listProjectAssignments: () => [current],
    managerEvidence: async () => ({
      roots: new Set([assignment.id]),
      retained: [retained],
      verify: () => {},
      verifyProvenance: () => {
        if (nestedProvenance !== "nested-parent-original")
          throw new Error("Manager evidence provenance changed");
      },
      revalidate: async (operation: () => unknown) => {
        await operation();
        nestedProvenance = "nested-parent-replaced";
      },
    }),
    resolveMessageFiles: () => [
      {
        kind: "retainedEvidence",
        ref: retained.ref,
        name: retained.name,
        path: retained.path,
        sha256: retained.sha256,
      },
    ],
    persistRequiredTextFiles: () => [],
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => unknown,
    ) => operation(),
    writeProjectAssignment: (_runtime: unknown, next: any) => {
      current = next;
    },
  } as any);

  await assert.rejects(
    runtime.updateAssignmentEvidence(
      "update",
      { branch: assignment.branch, add: [retained.ref] },
      undefined,
      undefined,
      fakeContext() as any,
    ),
    /Manager evidence provenance changed/,
  );
  assert.deepEqual(current, assignment);
  assert.deepEqual(
    readProjectAssignment(runtimeDir, repoKey, assignment.branch),
    assignment,
  );
});

test("Manager required-evidence removal is exact, assignment-scoped, and fail-closed", async () => {
  const manager = {
    piSessionId: "evidence-manager",
    repoKey: "evidence-repo",
    workspaceId: "evidence-workspace",
    leaseId: "lease-1",
  } as any;
  const assignment = {
    version: 2 as const,
    id: "assignment-current",
    repoKey: manager.repoKey,
    branch: "feature/evidence",
    text: "work",
    requiredEvidence: [
      {
        id: "local-a",
        name: "same-name.md",
        sourceAssignmentId: "assignment-current",
        path: "/immutable/a",
        sha256: "a".repeat(64),
      },
      {
        id: "local-b",
        name: "same-name.md",
        sourceAssignmentId: "assignment-current",
        path: "/immutable/b",
        sha256: "b".repeat(64),
      },
      {
        id: "inherited",
        name: "baseline.md",
        sourceAssignmentId: "parent-assignment",
        path: "/immutable/baseline",
        sha256: "c".repeat(64),
      },
    ],
  };
  let current = assignment;
  let leaseId = "lease-1";
  let role = "manager";
  let changeRoleUnderLock = false;
  const storedSnapshots = new Set([
    "/immutable/a",
    "/immutable/b",
    "/immutable/baseline",
  ]);
  const acceptedEvidence = [...assignment.requiredEvidence];
  const runtime = createLeadProjectRuntime({
    leadRuntime: { roleSuspended: false } as any,
    activeRole: () => role,
    currentManager: async () => manager,
    managerLease: () => ({ descriptor: { ...manager, leaseId } }),
    sameManagerDescriptor: (left: any, right: any) =>
      left.piSessionId === right.piSessionId && left.leaseId === right.leaseId,
    worktreeGroupScope: async () => ({
      repoKey: manager.repoKey,
      primaryWorkspaceId: "unrelated-repository-workspace",
    }),
    supervisionRuntime: () => ({}),
    readProjectAssignment: () => current,
    listProjectAssignments: () => [current],
    withProjectAssignmentLock: async (
      _repo: string,
      _branch: string,
      operation: () => Promise<unknown>,
    ) => {
      if (changeRoleUnderLock) role = "lead";
      return operation();
    },
    writeProjectAssignment: (_runtime: unknown, next: any) => {
      current = next;
    },
    resolveMessageFiles: () => [],
    persistRequiredTextFiles: () => [],
  } as any);
  const ctx = fakeContext() as any;
  for (const unauthorizedRole of ["lead", "chief"]) {
    role = unauthorizedRole;
    await assert.rejects(
      runtime.updateAssignmentEvidence(
        "unauthorized",
        { branch: assignment.branch, remove: ["local-a"] },
        undefined,
        undefined,
        ctx,
      ),
      /Only the Manager can update assignment required evidence/,
    );
    assert.deepEqual(current, assignment);
  }
  role = "manager";
  changeRoleUnderLock = true;
  await assert.rejects(
    runtime.updateAssignmentEvidence(
      "role-changed",
      { branch: assignment.branch, remove: ["local-a"] },
      undefined,
      undefined,
      ctx,
    ),
    /Manager authority changed/,
  );
  assert.deepEqual(current, assignment);
  changeRoleUnderLock = false;
  role = "manager";
  const before = await runtime.inspectRequiredEvidence(assignment.branch, ctx);
  assert.equal(
    before.requiredEvidence?.find((item) => item.id === "inherited")
      ?.sourceAssignmentId,
    "parent-assignment",
  );

  // Cancel means the UI does not invoke the removal callback.
  const confirmation = "cancel";
  if (confirmation === "confirm")
    await runtime.removeRequiredEvidence(assignment.branch, "local-a", ctx);
  assert.deepEqual(
    current.requiredEvidence?.map((item) => item.id),
    ["local-a", "local-b", "inherited"],
  );

  // IDs, not duplicate display names, identify the selected requirement.
  await runtime.removeRequiredEvidence(
    assignment.branch,
    "local-b",
    before,
    ctx,
  );
  assert.deepEqual(
    current.requiredEvidence?.map((item) => item.id),
    ["local-a", "inherited"],
  );
  assert.deepEqual(
    [...storedSnapshots],
    ["/immutable/a", "/immutable/b", "/immutable/baseline"],
  );
  const afterRemoval = await runtime.inspectRequiredEvidence(
    assignment.branch,
    ctx,
  );
  await assert.rejects(
    runtime.removeRequiredEvidence(
      assignment.branch,
      "inherited",
      afterRemoval,
      ctx,
    ),
    /Inherited required evidence cannot be removed/,
  );

  const inspected = await runtime.inspectRequiredEvidence(
    assignment.branch,
    ctx,
  );
  current = {
    ...inspected,
    id: "replacement-assignment",
    requiredEvidence: inspected.requiredEvidence?.map((entry) =>
      entry.id === "local-a"
        ? { ...entry, sourceAssignmentId: "replacement-assignment" }
        : entry,
    ),
  };
  // A confirmation applies to the exact assignment shown, not a replacement
  // that happens to reuse the same branch and evidence ID.
  await assert.rejects(
    runtime.removeRequiredEvidence(
      assignment.branch,
      "local-a",
      inspected,
      ctx,
    ),
    /Project assignment changed/,
  );
  assert.deepEqual(
    current.requiredEvidence?.map(({ id }) => id),
    ["local-a", "inherited"],
  );
  current = assignment;
  await runtime.inspectRequiredEvidence(assignment.branch, ctx);
  leaseId = "lease-replaced";
  await assert.rejects(
    runtime.removeRequiredEvidence(
      assignment.branch,
      "local-a",
      assignment,
      ctx,
    ),
    /Manager (?:authority changed|lease is no longer active)/,
  );
  assert.deepEqual(
    [...storedSnapshots],
    ["/immutable/a", "/immutable/b", "/immutable/baseline"],
  );
  assert.deepEqual(
    acceptedEvidence.map(({ id }) => id),
    ["local-a", "local-b", "inherited"],
  );
});

test("new project worktree creation gets an extended Herdr timeout", async () => {
  const repoKey = realFs.realpathSync(process.cwd());
  const manager = {
    repoKey,
    workspaceId: WORKSPACE,
    socket: process.env.HERDR_SOCKET_PATH ?? "/test-socket",
    group: null,
    leaseId: randomUUID(),
    piSessionId: randomUUID(),
  };
  const calls: { args: string[]; options: any }[] = [];
  const lockKeys: string[] = [];
  const signal = new AbortController().signal;
  const runtime = createLeadProjectRuntime({
    pi: {
      exec: async (command: string, args: string[]) => ({
        stdout:
          command === "git"
            ? repoKey
            : JSON.stringify({
                id: AGENT_ID,
                result:
                  args[0] === "workspace"
                    ? { workspace: { workspace_id: WORKSPACE } }
                    : {
                        source: { repo_key: repoKey, repo_name: "project" },
                        worktrees: [],
                      },
              }),
        stderr: "",
        code: 0,
      }),
    } as any,
    leadRuntime: { managerLease: { descriptor: manager } } as any,
    managerLease: () => ({ descriptor: manager }),
    currentManager: async () => manager,
    sameManagerDescriptor: () => true,
    worktreeGroupScope: async () => ({
      repoKey,
      primaryWorkspaceId: WORKSPACE,
      worktrees: [],
    }),
    runHerdr: async (_pi: any, _ctx: any, args: string[], options: any) => {
      calls.push({ args, options });
      if (args[1] === "list")
        return {
          source: { source_workspace_id: WORKSPACE, repo_key: repoKey },
          worktrees: [],
        } as any;
      throw new Error("stop after observing create options");
    },
    supervisionRuntime: () => ({}),
    readProjectAssignment: () => undefined,
    messageLimits: async () => ({
      inline: { bytes: 1000 },
      mailbox: { bytes: 1000 },
    }),
    prepareMessageInput: (text: string) => ({ text, resultBindings: [] }),
    resolveMessageFiles: () => [],
    withProjectWorkLock: (key: string, operation: () => unknown) => {
      lockKeys.push(key);
      return operation();
    },
    appendDurableError: () => {},
  } as any);

  for (const [params, expected] of [
    [
      { action: "delegate", task: "work", branch: " \t" },
      /Project branch must not be empty/,
    ],
    [{ action: "resume", branch: " \n" }, /Project branch must not be empty/],
    [
      { action: "delegate", task: "work", base: " \t" },
      /Base ref must not be empty/,
    ],
  ] as const) {
    await assert.rejects(
      runtime.activateProjectLead(params, {} as any, signal),
      expected,
    );
  }
  assert.deepEqual(lockKeys, []);
  assert.deepEqual(calls, []);

  await assert.rejects(
    runtime.activateProjectLead(
      { action: "delegate", task: "test" },
      { cwd: repoKey } as any,
      signal,
    ),
    /stop after observing create options/,
  );
  assert.deepEqual(
    calls.map(({ args }) => args.slice(0, 2)),
    [
      ["worktree", "list"],
      ["worktree", "create"],
    ],
  );
  assert.deepEqual(calls[0]?.options, { signal });
  assert.deepEqual(calls[1]?.options, { signal, timeout: 180_000 });
});

test("new delegate worktree pins its verified HEAD without probing merge-base", async () => {
  const worktreeHead = testSha("a");
  const fixture = baselineLifecycle({ worktreeHead });
  await assert.rejects(fixture.activate(), new RegExp(lifecycleStop));
  assert.equal(fixture.published?.gitBaselineSha, worktreeHead);
  assert.equal(
    sameDirectory(fixture.published!.checkoutPath, fixture.worktreePath),
    true,
  );
  assert.equal(
    fixture.gitCalls.some(({ args }) => args[0] === "merge-base"),
    false,
  );
  assert.ok(
    fixture.gitCalls.some(
      ({ args, cwd }) =>
        args.includes("HEAD^{commit}") && cwd === fixture.worktreePath,
    ),
  );
});

test("reused matching worktree pins its unique manager/worktree merge-base", async () => {
  const managerHead = testSha("b");
  const worktreeHead = testSha("c");
  const mergeBase = testSha("d");
  const fixture = baselineLifecycle({
    reused: true,
    managerHead,
    worktreeHead,
    mergeBases: [mergeBase],
  });
  await assert.rejects(fixture.activate(), new RegExp(lifecycleStop));
  assert.deepEqual(
    fixture.gitCalls.find(({ args }) => args[0] === "merge-base"),
    {
      args: ["merge-base", "--all", managerHead, worktreeHead],
      cwd: fixture.worktreePath,
    },
  );
  assert.equal(fixture.published?.gitBaselineSha, mergeBase);
  assert.deepEqual(
    fixture.gitCalls.find(({ args }) => args[0] === "merge-base"),
    {
      args: ["merge-base", "--all", managerHead, worktreeHead],
      cwd: fixture.worktreePath,
    },
  );
});

test("resume preserves its stored baseline and skips capture probes when Manager HEAD differs", async () => {
  const storedBaseline = testSha("e");
  const fixture = baselineLifecycle({
    resume: true,
    savedBaseline: storedBaseline,
    managerHead: testSha("f"),
    worktreeHead: testSha("a"),
  });
  await assert.rejects(fixture.activate(), new RegExp(lifecycleStop));
  assert.equal(fixture.published, undefined);
  assert.equal(
    fixture.gitCalls.some(({ args }) => args[0] === "merge-base"),
    false,
  );
  assert.equal(
    fixture.gitCalls.some(({ args }) => args.includes("HEAD^{commit}")),
    false,
  );
});

test("Git worktree porcelain inventory rejects incomplete or ambiguous records", () => {
  const hash = "a".repeat(40);
  const root = join(tmpdir(), "work-repo");
  const linked = join(tmpdir(), "work-branch");
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${root}\0HEAD ${hash}\0branch refs/heads/main\0\0worktree ${linked}\0HEAD ${hash}\0branch refs/heads/topic\0\0`,
    ),
    [
      { path: root, branch: "main" },
      { path: linked, branch: "topic" },
    ],
  );
  assert.equal(
    parseGitWorktreeInventory(`worktree ${root}\0HEAD ${hash}\0`),
    undefined,
  );
  assert.equal(
    parseGitWorktreeInventory(
      `worktree ${root}\0HEAD ${hash}\0branch refs/heads/topic\0\0junk\0\0`,
    ),
    undefined,
  );
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0future-attribute value\0branch refs/heads/topic\0locked active\0\0`,
    ),
    [{ path: linked, branch: "topic", locked: true }],
  );
  assert.equal(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0HEAD ${hash}\0branch refs/heads/topic\0\0`,
    ),
    undefined,
  );
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0branch refs/heads/topic\0prunable missing\0\0`,
    ),
    [{ path: linked, branch: "topic", prunable: true }],
  );
  assert.deepEqual(
    parseGitWorktreeInventory(`worktree ${linked}\0HEAD ${hash}\0detached\0\0`),
    [{ path: linked, detached: true }],
  );
  assert.deepEqual(
    parseGitWorktreeInventory(
      `worktree ${linked}\0HEAD ${hash}\0detached\0prunable gitdir file points to non-existent location\0\0`,
    ),
    [{ path: linked, detached: true, prunable: true }],
  );
});
