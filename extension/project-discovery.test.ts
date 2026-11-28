import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { discoverProjects } from "./project-discovery.ts";
import { herdsmanConfigPath } from "./storage.ts";
import {
  claimManagerLease,
  listManagerRecoveryReferences,
  managerDescriptorPath,
  supervisionRuntime,
  writeManagerRecoveryReference,
} from "./supervision.ts";

const run = promisify(execFile);
const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });

function init(path: string) {
  mkdirSync(path, { recursive: true });
  git("-C", path, "init", "-q");
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "projects-"));
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi");
  t.after(() => {
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    rmSync(root, { recursive: true, force: true });
  });
  const projectsRoot = join(root, "projects");
  const configFile = herdsmanConfigPath();
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ projectsDirectory: projectsRoot }));
  const runtime = {
    ...supervisionRuntime(join(root, "socket")),
    managers: join(root, "authority", "managers"),
  };
  const calls: string[] = [];
  const pi = {
    exec: async (command, args, options) => {
      assert.equal(command, "git");
      assert.equal(args[0], "rev-parse");
      if (options?.cwd) calls.push(options.cwd);
      const result = await run(command, args, {
        cwd: options?.cwd,
        signal: options?.signal,
      });
      return { ...result, code: 0, killed: false, truncated: false };
    },
  } satisfies Pick<ExtensionAPI, "exec">;
  const observe = (options: Partial<Parameters<typeof discoverProjects>[2]> = {}) =>
    discoverProjects(pi as ExtensionAPI, { cwd: root } as ExtensionContext, {
      runtime,
      includeProjectsDirectory: false,
      inventory: { workspaces: [], panes: [], agents: [] },
      verifyRunningManager: async () => assert.fail("Unexpected Manager readiness check"),
      ...options,
    });
  return { root, projectsRoot, runtime, calls, observe };
}

test("discovery combines exact workspace placement with bounded nested Git inventory", async (t) => {
  const { root, projectsRoot, calls, observe } = fixture(t);
  const primary = join(projectsRoot, "company", "team", "primary");
  const clone = join(projectsRoot, "another", "clone");
  const linked = join(root, "linked");
  const outside = join(root, "outside");
  init(primary);
  init(outside);
  git(
    "-C",
    primary,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  git("-C", primary, "worktree", "add", "--detach", linked);
  mkdirSync(dirname(clone), { recursive: true });
  git("clone", "-q", primary, clone);
  symlinkSync(outside, join(projectsRoot, "ignored-link"), "junction");
  const inventory = {
    workspaces: [
      { workspace_id: "primary" },
      {
        workspace_id: "linked",
        worktree: {
          checkout_path: linked,
          repo_key: join(primary, ".git"),
          is_linked_worktree: true,
        },
      },
    ],
    panes: [{ workspace_id: "primary", cwd: primary }],
    agents: [],
  };
  const overview = await observe({ inventory });
  assert.equal(overview.complete, true);
  assert.deepEqual(overview.projects, [
    {
      canonicalRepoKey: join(primary, ".git"),
      primaryCheckoutPath: primary,
      workspaces: [
        { workspaceId: "primary", checkoutPath: primary, isPrimary: true },
        { workspaceId: "linked", checkoutPath: linked, isPrimary: false },
      ],
      managerStatus: "none",
    },
  ]);
  assert.ok(!calls.includes(clone));
  const explicit = await observe({ inventory, includeProjectsDirectory: true });
  assert.equal(explicit.complete, true);
  assert.deepEqual(
    explicit.projects.map((project) => project.primaryCheckoutPath),
    [clone, primary],
  );
  assert.ok(!calls.includes(outside));
  assert.ok(!calls.includes(join(projectsRoot, "ignored-link")));
});

test("only exact persisted Manager sessions make closed projects recoverable", async (t) => {
  const { root, runtime, observe } = fixture(t);
  const checkout = join(root, "closed");
  const canonicalRepoKey = join(checkout, ".git");
  const piSessionFile = join(root, "saved.jsonl");
  init(checkout);
  const saved = SessionManager.open(piSessionFile, root, checkout);
  const piSessionId = saved.getSessionId();
  saved.appendCustomEntry("pi-herdsman-role", {
    sessionId: piSessionId,
    role: "manager",
    leadTools: [],
  });
  saved.appendMessage({
    role: "user",
    content: "private conversation",
    timestamp: Date.now(),
  });
  writeManagerRecoveryReference(runtime, {
    version: 1,
    canonicalRepoKey,
    piSessionId,
    piSessionFile,
  });
  const initial = readFileSync(piSessionFile);
  const discovery = await observe();
  assert.equal(discovery.complete, true);
  assert.deepEqual(discovery.projects, [
    {
      canonicalRepoKey,
      primaryCheckoutPath: checkout,
      workspaces: [],
      managerStatus: "recoverable",
    },
  ]);
  assert.deepEqual(readFileSync(piSessionFile), initial);
  assert.ok(!JSON.stringify(discovery).includes(piSessionFile));

  const incomplete = await observe({ inventory: null });
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.projects, [
    {
      canonicalRepoKey,
      primaryCheckoutPath: checkout,
      workspaces: [],
      managerStatus: "unknown",
    },
  ]);

  const managerPath = managerDescriptorPath(runtime, canonicalRepoKey);
  mkdirSync(dirname(managerPath), { recursive: true, mode: 0o700 });
  writeFileSync(`${managerPath}.unsettled`, "{}");
  const unsettled = await observe();
  assert.equal(unsettled.complete, false);
  assert.equal(unsettled.projects[0]?.managerStatus, "unknown");
  rmSync(`${managerPath}.unsettled`);

  saved.appendCustomEntry("pi-herdsman-role", {
    sessionId: piSessionId,
    role: "lead",
    leadTools: [],
  });
  const invalid = await observe();
  assert.equal(invalid.complete, false);
  assert.equal(invalid.projects[0]?.managerStatus, "unknown");
  rmSync(checkout, { recursive: true });
  assert.deepEqual((await observe()).projects, []);
});

test("discovery does not infer running from a lease alone or expose foreign authority", async (t) => {
  const { root, runtime, observe } = fixture(t);
  const checkout = join(root, "open");
  const key = join(checkout, ".git");
  init(checkout);
  const workspaceId = "workspace";
  const inventory = {
    workspaces: [{ workspace_id: workspaceId }],
    panes: [{ workspace_id: workspaceId, cwd: checkout }],
    agents: [],
  };
  const incomplete = await observe({
    inventory: {
      ...inventory,
      workspaces: [...inventory.workspaces, { workspace_id: "incomplete", worktree: {} }],
    },
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.projects[0]?.managerStatus, "unknown");

  const identity = {
    build: { version: "test", sha256: "a".repeat(64) },
    piSessionId: randomUUID(),
    repoKey: key,
    canonicalRepoKey: key,
    paneId: "pane",
    tabId: "tab",
    workspaceId,
  };
  const local = claimManagerLease(identity, runtime);
  try {
    const unready = await observe({
      inventory,
      verifyRunningManager: async () => {
        throw new Error("not ready");
      },
    });
    assert.equal(unready.complete, false);
    assert.equal(unready.projects[0]?.managerStatus, "unknown");
    let verified = 0;
    const running = await observe({
      inventory,
      verifyRunningManager: async (repository, descriptor, signal) => {
        verified++;
        assert.equal(repository.checkoutPath, checkout);
        assert.equal(descriptor.piSessionId, identity.piSessionId);
        assert.equal(signal.aborted, false);
      },
    });
    assert.equal(verified, 1);
    assert.equal(running.complete, true);
    assert.equal(running.projects[0]?.managerStatus, "running");
  } finally {
    local.release();
  }

  const foreign = claimManagerLease(identity, {
    ...runtime,
    root: join(root, "foreign-socket"),
  });
  try {
    const conflicting = await observe({ inventory });
    assert.equal(conflicting.complete, false);
    assert.equal(conflicting.projects[0]?.managerStatus, "unknown");
    assert.ok(!JSON.stringify(conflicting).includes(identity.piSessionId));
  } finally {
    foreign.release();
  }
});

test("recovery enumeration checks filenames and file type without following symlinks", (t) => {
  const { root, runtime } = fixture(t);
  const reference = {
    version: 1 as const,
    canonicalRepoKey: join(root, "repository", ".git"),
    piSessionId: randomUUID(),
    piSessionFile: join(root, "saved.jsonl"),
  };
  writeManagerRecoveryReference(runtime, reference);
  const [filename] = readdirSync(runtime.managerRecovery);
  assert.ok(filename);
  const recordPath = join(runtime.managerRecovery, filename);
  writeFileSync(join(runtime.managerRecovery, ".DS_Store"), "");
  assert.deepEqual(listManagerRecoveryReferences(runtime), {
    references: [reference],
    complete: true,
  });
  writeFileSync(join(runtime.managerRecovery, `${"a".repeat(64)}.json`), readFileSync(recordPath));
  mkdirSync(join(runtime.managerRecovery, `${"b".repeat(64)}.json`));
  if (process.platform !== "win32")
    symlinkSync(recordPath, join(runtime.managerRecovery, `${"c".repeat(64)}.json`));
  assert.deepEqual(listManagerRecoveryReferences(runtime), {
    references: [reference],
    complete: false,
  });
});

test("directory discovery reports depth truncation and honors cancellation", async (t) => {
  const { projectsRoot, calls, observe } = fixture(t);
  init(join(projectsRoot, ...Array.from({ length: 13 }, () => "namespace")));
  const result = await observe({ includeProjectsDirectory: true });
  assert.equal(result.complete, false);
  assert.match(result.diagnostics.join(" "), /depth limit/);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(calls, []);
  const signal = AbortSignal.abort(new Error("discovery canceled"));
  await assert.rejects(observe({ includeProjectsDirectory: true, signal }), /discovery canceled/);
});
