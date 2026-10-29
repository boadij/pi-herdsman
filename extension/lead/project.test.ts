import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { AGENT_ID, WORKSPACE, fakeContext, realFs } from "../support.ts";

const { createLeadProjectRuntime, parseGitWorktreeInventory } =
  await import("./project.ts");

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
