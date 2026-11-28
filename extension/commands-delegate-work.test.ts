import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, toNamespacedPath } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { initTheme, ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";

import { Value } from "typebox/value";
import { acquireProcessLock, claimProcessLock, readLiveProcessLock } from "./lock.ts";
import {
  listPendingRetirements,
  listProjectAssignments,
  listProjectMessages,
  projectAssignmentPath,
  listCoordinationMessagePaths,
  removeChiefMessage,
  readChiefMessage,
  readProjectAssignment,
  readManagerDescriptor,
  supervisionRuntime,
  readLeadCoordinationState,
  writeLeadCoordinationState as writeLeadCoordinationStateRaw,
  writeProjectAssignment,
  removeProjectAssignment,
  removeProjectMessagesForAssignment,
} from "./supervision.ts";
import { rememberCoordinatorTarget } from "./coordinator-target.ts";
import { readRequiredEvidenceSnapshot } from "./storage.ts";
import {
  PI_AGENT_ROOT,
  LEAD_SESSION_ID,
  AGENT_ID,
  HERDSMAN_BUILD,
  WORKSPACE,
  fakeChiefPi,
  fakeContext,
  invokeEventHandlers,
  isApiSnapshot,
  isAgentList,
  nativeSessions,
  nonGitWorkspaceResponse,
  realFs,
  registerExtension,
  registerExtensionForTest,
  setLeadEnvironment,
} from "./support.ts";
import { sameDirectory } from "./herdr.ts";

initTheme("dark");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const leadTools = [
  "list_agents",
  "delegate_agent",
  "resume_agent",
  "steer_agent",
  "interrupt_agent",
  "reply_agent",
  "stop_agent",
  "inspect_agent",
  "read_agent_transcript",
  "list_peers",
  "message_peer",
];

const writeLeadCoordinationState = (runtime: any, state: any) =>
  writeLeadCoordinationStateRaw(runtime, {
    ...state,
    build: state.build ?? HERDSMAN_BUILD,
  });

async function managerDelegateAssignmentTest(
  t: TestContext,
  projectTrusted: boolean,
  lockOrder?: "manager-first" | "lead-first",
  targetDecision: boolean | null = null,
  ancestorDecision: boolean | null = null,
  extendedPaths = false,
  authorityContention?: "publication" | "binding" | "conflict" | "cancel",
) {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "root-pane";
  process.env.HERDR_TAB_ID = "root-tab";
  process.env.HERDR_SOCKET_PATH =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdr-${randomUUID()}`
      : `/tmp/herdr-${randomUUID()}.sock`;
  const lifecycleSocketPath = process.env.HERDR_SOCKET_PATH;
  t.after(() => {
    if (process.platform === "win32") return;
    try {
      realFs.unlinkSync(lifecycleSocketPath!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  const repoPath = join(PI_AGENT_ROOT, `herdsman-command-repo-key-${randomUUID()}`);
  realFs.mkdirSync(repoPath);
  t.after(() => rmSync(repoPath, { recursive: true, force: true }));
  const git = (args: string[], cwd = repoPath) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  if (extendedPaths) {
    git(["init"]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
  }
  const gitRepoPath = extendedPaths
    ? git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    : repoPath;
  const repoKey = extendedPaths ? toNamespacedPath(gitRepoPath) : repoPath;
  const primaryPath = extendedPaths ? toNamespacedPath(repoPath) : repoKey;
  assert.ok(gitRepoPath);
  const childWorkspace = `child-${randomUUID()}`;
  const childCwd = realFs.mkdtempSync(join(PI_AGENT_ROOT, "manager-child-"));
  t.after(() => rmSync(childCwd, { recursive: true, force: true }));
  if (extendedPaths) git(["worktree", "add", "-b", `fixture-${randomUUID()}`, childCwd]);
  new ProjectTrustStore(PI_AGENT_ROOT).set(PI_AGENT_ROOT, ancestorDecision);
  t.after(() => new ProjectTrustStore(PI_AGENT_ROOT).set(PI_AGENT_ROOT, null));
  const trustPath = extendedPaths ? toNamespacedPath(childCwd) : childCwd;
  new ProjectTrustStore(PI_AGENT_ROOT).set(trustPath, targetDecision);
  t.after(() => new ProjectTrustStore(PI_AGENT_ROOT).set(trustPath, null));
  const managedLeadDir = join(childCwd, ".pi", "coordinators", "leads");
  realFs.mkdirSync(managedLeadDir, { recursive: true });
  realFs.writeFileSync(
    join(managedLeadDir, "managed-lead.md"),
    "---\nname: managed-lead\nthinking: low\nbodyMode: append\n---\n\nTARGET_WORKTREE_MANAGED_LEAD",
  );
  let childSession = `lead-${randomUUID()}`;
  let lead: any;
  let leadCtx: any;
  let leadStarted = false;
  let initializeLeadRuntime!: () => Promise<void>;
  let lockPhase = "";
  let leadToolError: unknown;
  let leadToolResult: unknown;
  let leadPublication: Promise<void> | undefined;
  let authorityHolder: ReturnType<typeof acquireProcessLock> | undefined;
  let signalAuthorityWait!: () => void;
  const authorityWait = new Promise<void>((resolve) => {
    signalAuthorityWait = resolve;
  });
  let authorityWaitSeen = false;
  let authorityWaitController: AbortController | undefined;
  let managerLockClaim: ReturnType<typeof readLiveProcessLock> | undefined;
  let leadLockClaim: ReturnType<typeof readLiveProcessLock> | undefined;
  let lockedAssignmentSnapshot: unknown;
  let releaseLeadLock!: () => void;
  const leadLockRelease = new Promise<void>((resolve) => {
    releaseLeadLock = resolve;
  });
  let signalLeadLock!: () => void;
  const leadLockHeld = new Promise<void>((resolve) => {
    signalLeadLock = resolve;
  });
  let signalManagerWait!: () => void;
  const managerWaitStarted = new Promise<void>((resolve) => {
    signalManagerWait = resolve;
  });
  let signalLeadWait!: () => void;
  const leadWaitStarted = new Promise<void>((resolve) => {
    signalLeadWait = resolve;
  });
  let primaryWorkspace = WORKSPACE;
  const childSessionPath = () => join(tmpdir(), `${childSession}.jsonl`);
  let created = false;
  let createdBranch = "";
  let coordinatorTabCreated = false;
  let reportCheckoutAbsent = false;
  let gitStatusOutput = "";
  let started = false;
  let manager1Shutdown = false;
  let failScopeLookup = false;
  let unavailableScope = false;
  let topologyRequests = 0;
  let lifecycleServer: ReturnType<typeof createServer> | undefined;
  const lifecycleClients = new Set<any>();
  const subscribedLifecycleClients = new Set<any>();
  let lifecycleSubscriptions = 0;
  const tabLabels = new Map([
    ["root-tab", "1"],
    ["child-tab", "1"],
  ]);
  const tabCommands: string[][] = [];
  let managerUsesRootPane = false;
  let holdChildPaneGet = false;
  let childPaneGetDidStart = false;
  let releaseChildPaneGet!: () => void;
  const heldChildPaneGet = new Promise<void>((resolve) => (releaseChildPaneGet = resolve));
  const respond = (result: unknown) => ({
    stdout: JSON.stringify({ id: AGENT_ID, result }),
    stderr: "",
    code: 0,
  });
  let managerAgent: any = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: LEAD_SESSION_ID,
    },
    workspace_id: WORKSPACE,
    pane_id: "root-pane",
    tab_id: "root-tab",
  };
  const exec = (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ) => {
    if (command === "herdr" && args[0] === "tab" && args[1] === "list") {
      tabCommands.push(args);
      const tabId =
        args[3] === childWorkspace
          ? coordinatorTabCreated
            ? "child-tab"
            : "worktree-tab"
          : "root-tab";
      return respond({
        tabs: [
          {
            tab_id: tabId,
            workspace_id: args[3] === childWorkspace ? childWorkspace : WORKSPACE,
            number: tabId === "child-tab" ? 41 : 27,
            label: tabLabels.get(tabId),
          },
        ],
      });
    }
    if (command === "herdr" && args[0] === "tab" && args[1] === "rename") {
      tabCommands.push(args);
      tabLabels.set(args[2]!, args[3]!);
      return respond({});
    }
    if (command === "git") {
      if (
        extendedPaths &&
        created &&
        !reportCheckoutAbsent &&
        args[0] === "worktree" &&
        args[1] === "list"
      )
        return { stdout: git(args, options?.cwd), stderr: "", code: 0 };
      if (
        extendedPaths &&
        options?.cwd &&
        (options.cwd === childCwd || options.cwd === toNamespacedPath(childCwd)) &&
        ((args[0] === "rev-parse" && args.includes("--git-common-dir")) ||
          args[0] === "symbolic-ref")
      ) {
        return { stdout: `${git(args, options.cwd)}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "status") return { stdout: gitStatusOutput, stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { stdout: `${childCwd}\n`, stderr: "", code: 0 };
      if (
        args[0] === "rev-parse" &&
        args[1] === "--path-format=absolute" &&
        args[2] === "--git-path" &&
        args[3] === "modules"
      )
        return {
          stdout: `${join(childCwd, ".herdsman-test-no-modules")}\n`,
          stderr: "",
          code: 0,
        };
      if (args[0] === "submodule" && args[1] === "status")
        return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute")
        return {
          stdout: `${(options?.cwd === childCwd || options?.cwd === toNamespacedPath(childCwd)) && (args.includes("--show-toplevel") || args.includes("--git-dir")) ? childCwd : extendedPaths && args.includes("--show-toplevel") ? repoPath : gitRepoPath}\n`,
          stderr: "",
          code: 0,
        };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: [
            `worktree ${repoKey}`,
            `HEAD ${"0".repeat(40)}`,
            "branch refs/heads/main",
            "",
            ...(!reportCheckoutAbsent
              ? [
                  `worktree ${realFs.realpathSync(childCwd)}`,
                  `HEAD ${"1".repeat(40)}`,
                  `branch refs/heads/${createdBranch}`,
                  "",
                ]
              : []),
            "",
          ].join("\0"),
          stderr: "",
          code: 0,
        };
      if (args[0] === "symbolic-ref") return { stdout: `${createdBranch}\n`, stderr: "", code: 0 };
    }
    if (
      (failScopeLookup || unavailableScope) &&
      command === "herdr" &&
      args[0] === "worktree" &&
      args[1] === "list"
    )
      return unavailableScope
        ? nonGitWorkspaceResponse()
        : {
            stdout: JSON.stringify({
              id: AGENT_ID,
              error: { code: "unavailable", message: "scope lookup failure" },
            }),
            stderr: "",
            code: 1,
          };
    if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
      return respond({
        workspace: {
          workspace_id: args[2],
          worktree: {
            repo_key: repoKey,
            is_linked_worktree: args[2] === childWorkspace,
            checkout_path: args[2] === childWorkspace ? childCwd : primaryPath,
          },
        },
        ...(args[2] === childWorkspace
          ? { root_pane: { pane_id: "worktree-pane", tab_id: "worktree-tab" } }
          : {}),
      });
    if (command === "herdr" && args[0] === "worktree" && args[1] === "list") {
      topologyRequests++;
      return respond({
        source: {
          source_workspace_id: primaryWorkspace,
          repo_key: repoKey,
          repo_name: "project",
          source_checkout_path: primaryPath,
        },
        worktrees: created
          ? [
              {
                open_workspace_id: primaryWorkspace,
                branch: "main",
                path: primaryPath,
                is_linked_worktree: false,
              },
              ...(!reportCheckoutAbsent
                ? [
                    {
                      open_workspace_id: childWorkspace,
                      branch: listProjectAssignments(supervisionRuntime(), repoKey)[0]?.branch,
                      path: realFs.realpathSync(childCwd),
                      is_linked_worktree: true,
                    },
                  ]
                : []),
              {
                branch: "closed-worktree",
                path: "/tmp/manager-closed",
                is_linked_worktree: true,
              },
            ]
          : [],
      });
    }
    if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
      const branchIndex = args.indexOf("--branch");
      createdBranch = args[branchIndex + 1]!;
      assert.ok(createdBranch);
      if (extendedPaths) git(["branch", "-m", createdBranch], childCwd);
      created = true;
      return respond({
        workspace: { workspace_id: childWorkspace },
        tab: { tab_id: "worktree-tab" },
        root_pane: { pane_id: "worktree-pane", tab_id: "worktree-tab" },
        worktree: {
          branch: createdBranch,
          path: trustPath,
        },
      });
    }
    if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
      assert.equal(args[args.indexOf("--workspace") + 1], childWorkspace);
      assert.equal(sameDirectory(args[args.indexOf("--cwd") + 1]!, childCwd), true);
      assert.equal(args[args.indexOf("--env") + 1], `PI_CODING_AGENT_DIR=${PI_AGENT_ROOT}`);
      assert.ok(args.includes("--no-focus"));
      coordinatorTabCreated = true;
      return respond({
        tab: { tab_id: "child-tab", workspace_id: childWorkspace },
        root_pane: {
          pane_id: "child-pane",
          workspace_id: childWorkspace,
          tab_id: "child-tab",
          terminal_id: "child-terminal",
        },
      });
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "list")
      return respond({
        panes: [
          coordinatorTabCreated
            ? {
                pane_id: "child-pane",
                workspace_id: childWorkspace,
                tab_id: "child-tab",
                terminal_id: "child-terminal",
                cwd: childCwd,
              }
            : {
                pane_id: "worktree-pane",
                workspace_id: childWorkspace,
                tab_id: "worktree-tab",
                cwd: childCwd,
              },
        ],
      });
    if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
      if (args[2] === "child-pane") tabCommands.push(args);
      const paneResult = () =>
        respond({
          pane: {
            pane_id: "child-pane",
            workspace_id: childWorkspace,
            tab_id: "child-tab",
            terminal_id: "child-terminal",
            cwd: childCwd,
          },
        });
      if (args[2] === "child-pane" && holdChildPaneGet) {
        holdChildPaneGet = false;
        childPaneGetDidStart = true;
        return heldChildPaneGet.then(paneResult);
      }
      return paneResult();
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "process-info")
      return respond({
        process_info: {
          pane_id: args[3],
          shell_pid: 33,
          foreground_process_group_id: 33,
          foreground_processes: [{ pid: 33, argv0: "/bin/zsh" }],
        },
      });
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      (args[1] === "run" || args[1] === "wait-output")
    )
      return respond({});
    if (args[0] === "agent" && args[1] === "start") {
      started = true;
      const [assignment] = listProjectAssignments(supervisionRuntime(), repoKey);
      assert.ok(assignment);
      const assignmentLease = claimProcessLock(
        `${projectAssignmentPath(supervisionRuntime(), repoKey, assignment.branch)}.lock`,
        { name: "test startup assignment lock release" },
      );
      assignmentLease();
      const sessionIdIndex = args.indexOf("--session-id");
      if (extendedPaths) {
        const sessionDirIndex = args.indexOf("--session-dir");
        assert.notEqual(sessionDirIndex, -1);
        assert.equal(
          args[sessionDirIndex + 1],
          SessionManager.create(realFs.realpathSync.native(childCwd)).getSessionDir(),
        );
      }
      assert.notEqual(sessionIdIndex, -1);
      childSession = args[sessionIdIndex + 1]!;
      assert.equal(childSession, assignment.id);
      const toolsIndex = args.indexOf("--tools");
      assert.notEqual(toolsIndex, -1);
      assert.equal(args.includes("--no-tools"), false);
      assert.deepEqual(args[toolsIndex + 1]!.split(","), [
        "codemode",
        ...leadTools.filter((name) => name !== "list_peers" && name !== "message_peer"),
        "message_manager",
        "list_peers",
        "message_peer",
        "load_skill",
        "mcp__",
      ]);
      assert.ok(
        args.some((arg, index) => arg === "--extension" && args[index + 1] === "builtin:codemode"),
      );
      const excludedIndex = args.indexOf("--exclude-tools");
      assert.notEqual(excludedIndex, -1);
      assert.equal(args[excludedIndex + 1], "mcp__");
      for (const tool of ["bash", "powershell", "edit", "write"])
        assert.equal(args[toolsIndex + 1]!.split(",").includes(tool), false);
      assert.equal(args.includes("--no-skills"), true);
      assert.equal(args.includes("--no-extensions"), true);
      const thinkingIndex = args.indexOf("--thinking");
      assert.notEqual(thinkingIndex, -1);
      assert.equal(args[thinkingIndex + 1] === "low", projectTrusted);
      assert.equal(args.includes("--approve"), projectTrusted);
      assert.equal(args.includes("--no-approve"), !projectTrusted);
      const promptIndex = args.indexOf("--append-system-prompt");
      assert.notEqual(promptIndex, -1);
      const childPrompt = readFileSync(args[promptIndex + 1]!, "utf8");
      if (projectTrusted) {
        assert.match(childPrompt, /TARGET_WORKTREE_MANAGED_LEAD/);
      } else {
        assert.doesNotMatch(childPrompt, /TARGET_WORKTREE_MANAGED_LEAD/);
      }
      writeLeadCoordinationState(supervisionRuntime(), {
        version: 1,
        role: "lead",
        instanceId: randomUUID(),
        piSessionId: childSession,
        updatedAt: Date.now(),
      });
      return respond({
        agent: {
          name: "lead",
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "path",
            value: childSessionPath(),
          },
        },
      });
    }
    if (command === "herdr" && isApiSnapshot(args))
      return respond({
        snapshot: {
          workspaces:
            created || started
              ? [
                  {
                    workspace_id: childWorkspace,
                    worktree: { checkout_path: childCwd, repo_key: repoKey },
                  },
                ]
              : [],
          panes: coordinatorTabCreated
            ? [
                {
                  pane_id: "child-pane",
                  workspace_id: childWorkspace,
                  tab_id: "child-tab",
                  cwd: childCwd,
                  ...(started
                    ? {
                        agent_session: {
                          source: "herdr:pi",
                          agent: "pi",
                          kind: "path",
                          value: childSessionPath(),
                        },
                      }
                    : {}),
                },
              ]
            : [],
          agents: started
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "path",
                    value: childSessionPath(),
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                  cwd: childCwd,
                },
              ]
            : [],
        },
      });
    if (command === "herdr" && isAgentList(args)) {
      if (
        started &&
        !realFs.existsSync(childSessionPath()) &&
        listCoordinationMessagePaths(supervisionRuntime(), childSession).length
      ) {
        realFs.writeFileSync(
          childSessionPath(),
          JSON.stringify({
            type: "session",
            id: childSession,
          }),
        );
        nativeSessions.set(childSessionPath(), {
          id: childSession,
          path: childSessionPath(),
          cwd: realFs.realpathSync.native(childCwd),
          entries: [],
        });
      }
      return respond({
        agents: [
          ...(managerAgent ? [managerAgent] : []),
          ...(started
            ? [
                {
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "path",
                    value: childSessionPath(),
                  },
                  workspace_id: childWorkspace,
                  pane_id: "child-pane",
                  tab_id: "child-tab",
                  cwd: childCwd,
                },
              ]
            : []),
        ],
      });
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return respond({
        agent:
          args[2] === "child-pane"
            ? {
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "path",
                  value: childSessionPath(),
                },
                workspace_id: childWorkspace,
                pane_id: "child-pane",
                tab_id: "child-tab",
                cwd: childCwd,
              }
            : managerAgent,
      });
    return respond({});
  };
  let mutateRetainedSource: (() => void) | undefined;
  const managerExec = async (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ) => {
    mutateRetainedSource?.();
    if (managerUsesRootPane && command === "herdr" && args[0] === "pane" && args[1] === "get")
      return respond({
        pane: {
          pane_id: "root-pane",
          workspace_id: WORKSPACE,
          tab_id: "root-tab",
          terminal_id: "root-terminal",
          cwd: "/tmp/manager-root",
        },
      });
    const result = await exec(command, args, options);
    if (
      authorityContention === "binding" &&
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "start" &&
      !leadStarted
    ) {
      await initializeLeadRuntime();
      await lead.events.get("session_start")![0](undefined, leadCtx);
      leadStarted = true;
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      process.env.HERDR_PANE_ID = "root-pane";
      process.env.HERDR_TAB_ID = "root-tab";
    }
    if (
      authorityContention === "binding" &&
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "start"
    ) {
      const { projectAssignmentAuthorityLockPath } = await import("./supervision.ts");
      authorityHolder = acquireProcessLock(projectAssignmentAuthorityLockPath(), {
        name: "test session-binding contention",
      });
    }
    if (
      lockOrder === "lead-first" &&
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "start"
    ) {
      await initializeLeadRuntime();
      lockPhase = "lead-publish";
      const messageTool = lead.tools.find((tool: any) => tool.name === "message_manager")!;
      leadPublication = messageTool
        .execute(
          "contention-ready",
          { message: "ready under assignment contention" },
          undefined,
          undefined,
          leadCtx,
        )
        .then((value: unknown) => {
          leadToolResult = value;
        })
        .catch((error: unknown) => {
          leadToolError = error;
        });
      await leadLockHeld;
      lockPhase = "manager-bind";
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      process.env.HERDR_PANE_ID = "root-pane";
      process.env.HERDR_TAB_ID = "root-tab";
    } else if (lockOrder && command === "herdr" && args[0] === "agent" && args[1] === "start") {
      lockPhase = "manager-bind";
    }
    if (
      !lockOrder &&
      authorityContention !== "binding" &&
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "start" &&
      !leadStarted
    ) {
      await initializeLeadRuntime();
      await lead.events.get("session_start")![0](undefined, leadCtx);
      leadStarted = true;
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      process.env.HERDR_PANE_ID = "root-pane";
      process.env.HERDR_TAB_ID = "root-tab";
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
      const state = readLeadCoordinationState(supervisionRuntime(), childSession);
      assert.ok(state);
      writeLeadCoordinationState(supervisionRuntime(), {
        ...state,
        updatedAt: Date.now(),
        startupAttestation: {
          kind: "model_restore",
          assignmentId: childSession,
          generation: state.instanceId,
          result: "verified",
        },
      });
    }
    return result;
  };
  const pi = fakeChiefPi({
    activeTools: ["read"],
    exec: managerExec,
    persistMessages: true,
  });
  const managerLockHooks = {
    onAuthorityWaitOccupied: () => {
      authorityWaitSeen = true;
      signalAuthorityWait();
      if (authorityContention === "conflict" && authorityHolder) {
        authorityHolder.release();
        authorityHolder = undefined;
        writeProjectAssignment(supervisionRuntime(), {
          version: 2,
          id: randomUUID(),
          repoKey,
          branch: createdBranch,
          text: "competing assignment",
        });
      } else if (authorityContention === "cancel") {
        authorityWaitController?.abort(new Error("cancel during authority wait"));
      }
    },
    afterOccupied: async (lockedRepo: string) => {
      if (lockedRepo === repoKey && lockOrder === "lead-first") {
        signalManagerWait();
      }
    },
    afterAcquired: async (lockedRepo: string, branch: string) => {
      if (
        lockedRepo !== repoKey ||
        !lockOrder ||
        !listProjectAssignments(supervisionRuntime(), repoKey).some(
          (assignment) => assignment.branch === branch,
        )
      )
        return;
      if (lockOrder === "manager-first" && lockPhase === "manager-bind") {
        lockPhase = "manager-held";
        managerLockClaim = readLiveProcessLock(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, branch)}.lock`,
        );
        lockedAssignmentSnapshot = readProjectAssignment(supervisionRuntime(), repoKey, branch);
        try {
          await initializeLeadRuntime();
          const messageTool = lead.tools.find((tool: any) => tool.name === "message_manager")!;
          leadPublication = messageTool
            .execute(
              "contention-ready",
              { message: "ready under assignment contention" },
              undefined,
              undefined,
              leadCtx,
            )
            .then((value: unknown) => {
              leadToolResult = value;
            })
            .catch((error: unknown) => {
              leadToolError = error;
            });
          await leadWaitStarted;
        } finally {
          process.env.HERDR_WORKSPACE_ID = WORKSPACE;
          process.env.HERDR_PANE_ID = "root-pane";
          process.env.HERDR_TAB_ID = "root-tab";
        }
        return;
      }
    },
  };
  if (lockOrder || authorityContention) registerExtensionForTest(pi.pi as never, managerLockHooks);
  else registerExtension!(pi.pi as never);
  initializeLeadRuntime = async () => {
    process.env.HERDR_WORKSPACE_ID = childWorkspace;
    process.env.HERDR_PANE_ID = "child-pane";
    process.env.HERDR_TAB_ID = "child-tab";
    managerUsesRootPane = true;
    if (lead) return;
    lifecycleServer = createServer((socket) => {
      lifecycleClients.add(socket);
      socket.once("close", () => {
        lifecycleClients.delete(socket);
        subscribedLifecycleClients.delete(socket);
      });
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        lifecycleSubscriptions++;
        subscribedLifecycleClients.add(socket);
        socket.write(
          `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      lifecycleServer!.once("error", reject);
      lifecycleServer!.listen(process.env.HERDR_SOCKET_PATH!, resolve);
    });
    lead = fakeChiefPi({
      activeTools: ["read"],
      exec,
      sessionName: "Existing session name",
      entries: [{ type: "session_info", name: "Existing session name" }],
    });
    const leadLockHooks = {
      afterOccupied: async (lockedRepo: string) => {
        if (lockOrder === "manager-first" && lockedRepo === repoKey) signalLeadWait();
      },
      afterAcquired: async (lockedRepo: string, branch: string) => {
        if (
          lockOrder !== "lead-first" ||
          lockPhase !== "lead-publish" ||
          lockedRepo !== repoKey ||
          !listProjectAssignments(supervisionRuntime(), repoKey).some(
            (assignment) => assignment.branch === branch,
          )
        )
          return;
        leadLockClaim = readLiveProcessLock(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, branch)}.lock`,
        );
        lockedAssignmentSnapshot = readProjectAssignment(supervisionRuntime(), repoKey, branch);
        signalLeadLock();
        await leadLockRelease;
      },
    };
    if (lockOrder) registerExtensionForTest(lead.pi as never, leadLockHooks);
    else registerExtension!(lead.pi as never);
    leadCtx = fakeContext(lead.entries) as any;
    leadCtx.cwd = childCwd;
    leadCtx.isProjectTrusted = () => projectTrusted;
    leadCtx.hasUI = true;
    leadCtx.sessionManager.getSessionId = () => childSession;
    leadCtx.sessionManager.getSessionFile = childSessionPath;
    if (lockOrder && !leadStarted) {
      await lead.events.get("session_start")![0](undefined, leadCtx);
      leadStarted = true;
    }
  };
  try {
    const ctx = fakeContext(pi.entries) as any;
    ctx.isProjectTrusted = () => projectTrusted;
    await pi.events.get("session_start")![0](undefined, ctx);
    await pi.commandOptions.get("manager").handler("", ctx);
    const staff = pi.tools.find((tool) => tool.name === "delegate_work")!;
    assert.equal(
      Value.Check(staff.parameters, {
        task: "Do it",
        unexpected: childSession,
      }),
      false,
    );
    let outcome: any;
    let delegationError: unknown;
    if (
      authorityContention === "publication" ||
      authorityContention === "conflict" ||
      authorityContention === "cancel"
    ) {
      const { projectAssignmentAuthorityLockPath } = await import("./supervision.ts");
      authorityHolder = acquireProcessLock(projectAssignmentAuthorityLockPath(), {
        name: "test assignment-publication contention",
      });
    }
    if (authorityContention === "cancel") {
      authorityWaitController = new AbortController();
      ctx.signal = authorityWaitController.signal;
    }
    const delegate = staff.execute(
      "delegate",
      { task: "Implement focused change" },
      authorityWaitController?.signal,
      undefined,
      ctx,
    );
    if (authorityContention) {
      const settled = delegate.then(
        (value: unknown) => {
          outcome = value;
        },
        (error: unknown) => {
          delegationError = error;
        },
      );
      await authorityWait;
      assert.equal(authorityWaitSeen, true);
      const pendingAssignments = listProjectAssignments(supervisionRuntime(), repoKey);
      if (authorityContention === "publication") {
        assert.equal(pendingAssignments.length, 0);
        assert.equal(leadStarted, false);
      } else if (authorityContention === "conflict") {
        assert.equal(pendingAssignments.length, 1);
        assert.equal(pendingAssignments[0]!.text, "competing assignment");
        assert.equal(leadStarted, false);
      } else if (authorityContention === "cancel") {
        assert.equal(pendingAssignments.length, 0);
        assert.equal(leadStarted, false);
      } else {
        assert.equal(pendingAssignments.length, 1);
        assert.equal(pendingAssignments[0]!.piSessionFile, undefined);
        assert.equal(
          pi.calls.filter((args) => args[0] === "agent" && args[1] === "start").length,
          1,
        );
      }
      authorityHolder?.release();
      authorityHolder = undefined;
      await settled;
      if (authorityContention === "conflict") {
        assert.match(String(delegationError), /resume it with resume_work/);
        assert.equal(
          listProjectAssignments(supervisionRuntime(), repoKey)[0]!.text,
          "competing assignment",
        );
        removeProjectAssignment(supervisionRuntime(), repoKey, createdBranch);
        return;
      }
      if (authorityContention === "cancel") {
        assert.ok(delegationError);
        assert.equal(listProjectAssignments(supervisionRuntime(), repoKey).length, 0);
        return;
      }
    } else if (lockOrder === "lead-first") {
      const settled = delegate.then(
        (value: unknown) => {
          outcome = value;
        },
        (error: unknown) => {
          delegationError = error;
        },
      );
      await managerWaitStarted;
      releaseLeadLock();
      await settled;
    } else {
      try {
        outcome = await delegate;
      } catch (error) {
        delegationError = error;
      }
    }
    if (lockOrder === "lead-first") {
      assert.equal(delegationError, undefined);
      assert.equal(outcome.details.ok, true);
      await leadPublication;
      const assignment = listProjectAssignments(supervisionRuntime(), repoKey);
      assert.equal(assignment.length, 1);
      const boundAssignment = readProjectAssignment(
        supervisionRuntime(),
        repoKey,
        assignment[0]!.branch,
      );
      const { piSessionFile: _piSessionFile, ...assignmentIdentity } = boundAssignment!;
      assert.deepEqual(
        assignmentIdentity,
        lockedAssignmentSnapshot,
        "Manager preserves assignment identity while binding the session",
      );
      assert.equal(assignment[0]!.id, childSession);
      assert.equal(assignment[0]!.piSessionFile, realFs.realpathSync(childSessionPath()));
      const assignmentNotifications = listCoordinationMessagePaths(
        supervisionRuntime(),
        childSession,
      )
        .map((path) => readChiefMessage(path))
        .filter((message) => message.kind === "project_assignment");
      assert.equal(assignmentNotifications.length, 1);
      for (const notification of assignmentNotifications) {
        assert.equal(notification.id, childSession);
        assert.equal(notification.branch, assignment[0]!.branch);
        assert.equal(notification.text, "Project assignment ready.");
      }
      assert.equal(leadLockClaim?.pid, process.pid);
      assert.ok(leadLockClaim?.id);
      assert.equal(leadToolError, undefined);
      assert.match(JSON.stringify(leadToolResult), /Project message saved for Manager/);
      assert.equal(created, true);
      assert.equal(
        pi.calls.filter((args) => args[0] === "worktree" && args[1] === "create").length,
        1,
      );
      const messages = listProjectMessages(supervisionRuntime(), repoKey, assignment[0]!.branch);
      assert.ok(messages.length <= 1, "handoff is not published more than once");
      if (messages.length) {
        assert.equal(messages[0]!.fromSessionId, childSession);
        assert.equal(messages[0]!.repoKey, repoKey);
        assert.equal(messages[0]!.branch, assignment[0]!.branch);
        assert.equal(messages[0]!.text, "ready under assignment contention");
      }
      assert.match(JSON.stringify(leadToolResult), /Project message saved for Manager/);
      assert.equal(leadToolError, undefined);
      assert.equal(lockPhase, "manager-bind");
      removeProjectMessagesForAssignment(supervisionRuntime(), assignment[0]!);
      removeProjectAssignment(supervisionRuntime(), repoKey, assignment[0]!.branch);
      assert.equal(
        existsSync(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, assignment[0]!.branch)}.lock`,
        ),
        false,
      );
      return;
    }
    assert.equal(delegationError, undefined);
    assert.equal(outcome.details.ok, true);
    assert.equal(outcome.details.trust, projectTrusted ? "trusted" : "restricted");
    if (outcome.details.trust === "restricted") {
      assert.equal(outcome.details.project_definitions, "unavailable");
      assert.equal(outcome.details.private_definitions, "unavailable");
    }
    const assignment = listProjectAssignments(supervisionRuntime(), repoKey)[0];
    assert.equal(listProjectAssignments(supervisionRuntime(), repoKey).length, 1);
    assert.ok(assignment);
    if (lockOrder === "manager-first") {
      await leadPublication;
      assert.equal(leadToolError, undefined);
      assert.equal(assignment.id, childSession);
      assert.ok(assignment.piSessionFile);
      assert.equal(assignment.piSessionFile, realFs.realpathSync(childSessionPath()));
      assert.equal(managerLockClaim?.pid, process.pid);
      assert.ok(managerLockClaim?.id);
      const messages = listProjectMessages(supervisionRuntime(), repoKey, assignment.branch);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.fromSessionId, childSession);
      assert.equal(messages[0]!.text, "ready under assignment contention");
      const readyMessages = listCoordinationMessagePaths(supervisionRuntime(), childSession)
        .map((path) => readChiefMessage(path))
        .filter((message) => message.kind === "project_assignment");
      assert.equal(readyMessages.length, 1);
      assert.equal(readyMessages[0]!.id, childSession);
      assert.equal(readyMessages[0]!.branch, assignment.branch);
      assert.equal(created, true);
      assert.equal(
        pi.calls.filter((args) => args[0] === "worktree" && args[1] === "create").length,
        1,
      );
      assert.equal(
        existsSync(
          `${projectAssignmentPath(supervisionRuntime(), repoKey, assignment.branch)}.lock`,
        ),
        false,
      );
      removeProjectAssignment(supervisionRuntime(), repoKey, assignment.branch);
      for (const path of listCoordinationMessagePaths(supervisionRuntime(), childSession)) {
        const message = readChiefMessage(path);
        removeChiefMessage(supervisionRuntime(), childSession, message.id);
      }
      return;
    }
    assert.equal(assignment.text.match(/Implement focused change/g)?.length, 1);
    const brief = assignment.requiredEvidence?.find((entry) => entry.name === "project-brief.md");
    assert.ok(brief && "path" in brief);
    assert.equal(readRequiredEvidenceSnapshot(assignment.id, brief), "Implement focused change");
    const reviewFile = join(tmpdir(), `manager-review-${randomUUID()}.md`);
    t.after(() => rmSync(reviewFile, { force: true }));
    realFs.writeFileSync(reviewFile, "external review finding");
    const staffMessage = pi.tools.find((tool) => tool.name === "message_staff")!;
    const assignedTarget = rememberCoordinatorTarget(pi.pi as never, ctx, "lead", childSession);
    for (const selector of [
      {},
      { target: assignedTarget },
      { target: assignedTarget, branch: assignment.branch },
    ])
      await assert.rejects(
        staffMessage.execute(
          "selector",
          { ...selector, message: "must not publish" },
          undefined,
          undefined,
          ctx,
        ),
        /exactly one|require branch targeting/,
      );
    let changedSource = false;
    mutateRetainedSource = () => {
      if (changedSource) return;
      const current = listProjectAssignments(supervisionRuntime(), repoKey).find(
        (item) => item.branch === assignment.branch,
      );
      if (current?.requiredEvidence?.some((entry) => entry.name === basename(reviewFile))) {
        changedSource = true;
        realFs.writeFileSync(reviewFile, "changed review bytes");
      }
    };
    const retainedOutcome = await staffMessage.execute(
      "retain-review",
      {
        branch: assignment.branch,
        message: "Address the external review",
        files: [reviewFile],
        retain: true,
      },
      undefined,
      undefined,
      ctx,
    );
    mutateRetainedSource = undefined;
    assert.equal(retainedOutcome.details.ok, true, JSON.stringify(retainedOutcome.details));
    assert.equal(
      changedSource,
      true,
      "source must change after retention and before delivery completes",
    );
    const reviewMessages = listCoordinationMessagePaths(supervisionRuntime(), childSession)
      .map((path) => readChiefMessage(path))
      .filter((message) => message.text.includes("Address the external review"));
    assert.equal(reviewMessages.length, 1);
    assert.match(reviewMessages[0].text, /external review finding/);
    assert.doesNotMatch(reviewMessages[0].text, /changed review bytes/);
    const retained = listProjectAssignments(supervisionRuntime(), repoKey).find(
      (item) => item.branch === assignment.branch,
    )!;
    assert.equal(retained.requiredEvidence?.[2].name, "assignment-note.md");
    assert.deepEqual(
      retained.currentEvidenceIds?.map(
        (id) => retained.requiredEvidence?.find((entry) => entry.id === id)?.name,
      ),
      ["assignment-note.md", basename(reviewFile)],
    );
    assert.deepEqual(
      retained.requiredEvidence?.map((entry) => readRequiredEvidenceSnapshot(retained.id, entry)),
      ["Implement focused change", "external review finding", "Address the external review"],
    );
    assert.ok(retained.requiredEvidence?.some((entry) => entry.name === "project-brief.md"));
    assert.ok(!retained.requiredEvidence?.some((entry) => entry.name === "project-brief.txt"));
    realFs.rmSync(reviewFile, { force: true });
    const staffListTool = pi.tools.find((tool) => tool.name === "list_staff")!;
    const staffList = await staffListTool.execute("list", {}, undefined, undefined, ctx);
    assert.deepEqual(staffList.details.open_workspaces, [
      {
        workspace: WORKSPACE,
        branch: "main",
        path: primaryPath,
        linked: false,
      },
      {
        workspace: childWorkspace,
        branch: assignment!.branch,
        path: realFs.realpathSync(childCwd),
        linked: true,
      },
    ]);
    const contextProjection = await invokeEventHandlers(pi, "before_agent_start")(
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      ctx,
    );
    assert.equal(isRecord(contextProjection) ? contextProjection.message : undefined, undefined);
    const contextMessage = pi.sentMessageCalls
      .slice()
      .reverse()
      .find(({ message }: any) => message?.customType === "pi-herdsman-supervision-context");
    assert.match(
      String((contextMessage?.message as any)?.content),
      new RegExp(
        `open_workspaces:[\\s\\S]*main · workspace=${WORKSPACE} · primary[\\s\\S]*${assignment!.branch} · workspace=${childWorkspace} · linked`,
      ),
    );
    assert.equal(assignment?.id, childSession);
    const managerCommand = pi.commandOptions.get("manager")!;
    assert.equal(managerCommand.getArgumentCompletions, undefined);
    const removeCommand = pi.commandOptions.get("manager-remove")!;
    const forgetCommand = pi.commandOptions.get("manager-forget")!;
    const policyCommand = pi.commandOptions.get("manager-removal-confirmation")!;
    assert.deepEqual(removeCommand.getArgumentCompletions("herds"), [
      { value: assignment.branch, label: assignment.branch },
    ]);
    assert.deepEqual(forgetCommand.getArgumentCompletions("herds"), [
      { value: assignment.branch, label: assignment.branch },
    ]);
    assert.deepEqual(forgetCommand.getArgumentCompletions(""), [
      { value: assignment.branch, label: assignment.branch },
    ]);
    assert.deepEqual(removeCommand.getArgumentCompletions("herds "), [
      { value: assignment.branch, label: assignment.branch },
    ]);
    assert.deepEqual(policyCommand.getArgumentCompletions(""), [
      { value: "required", label: "required" },
      { value: "skip", label: "skip" },
    ]);
    assert.deepEqual(policyCommand.getArgumentCompletions("s"), [{ value: "skip", label: "skip" }]);
    const policyNotices: string[] = [];
    const previousNotify = ctx.ui.notify;
    ctx.ui.notify = (message: string) => policyNotices.push(message);
    await policyCommand.handler("", ctx);
    assert.match(policyNotices.pop()!, /Worktree removal approval: (Skipped|Required) for /);
    await policyCommand.handler("off", ctx);
    assert.equal(policyNotices.pop(), "Usage: /manager-removal-confirmation [required|skip]");
    ctx.ui.notify = previousNotify;
    let confirmationPrompts = 0;
    ctx.hasUI = true;
    ctx.ui.input = async () => {
      confirmationPrompts++;
      return "cancel";
    };
    const removeTool = pi.tools.find((tool) => tool.name === "remove_worktree")!;
    gitStatusOutput = "?? dirty-file\n";
    await assert.rejects(
      removeTool.execute("remove-dirty", { branch: assignment.branch }, undefined, undefined, ctx),
      /dirty or could not be verified/,
    );
    assert.equal(confirmationPrompts, 0);
    gitStatusOutput = "";
    const requestedTool = await removeTool.execute(
      "remove",
      { branch: assignment.branch },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(requestedTool.details.ok, false);
    assert.equal(requestedTool.details.action, "remove");
    assert.equal(requestedTool.details.branch, assignment.branch);
    assert.equal(requestedTool.details.confirmation_required, true);
    assert.equal(requestedTool.details.pending, true);
    assert.match(requestedTool.details.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(confirmationPrompts, 0);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "stop"),
      false,
    );
    assert.ok(readProjectAssignment(supervisionRuntime(), repoKey, assignment.branch));
    if (projectTrusted && !lockOrder && !extendedPaths && !authorityContention) {
      // Exercise both registered entry points against actual durable requests.
      ctx.mode = "rpc";
      const notices: string[] = [];
      ctx.ui.notify = (message: string) => notices.push(message);
      const events = () =>
        pi.entries
          .filter((entry: any) => entry.customType === "pi-herdsman-pending-removal")
          .map((entry: any) => entry.data);
      const issueRequest = async () => {
        const result = await removeTool.execute(
          "review-request",
          { branch: assignment.branch },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(result.details.pending, true);
        return result.details.request_id as string;
      };
      const review = async (
        route: "menu" | "cli",
        action: "approve" | "dismiss",
        replace = false,
      ) => {
        let rootVisited = false;
        let projectVisited = false;
        ctx.ui.select = async (title: string, options: string[]) => {
          if (title.startsWith("Pi Herdsman")) {
            if (rootVisited) return undefined;
            rootVisited = true;
            return options.find((option) => option.startsWith("Project management"));
          }
          if (title === "Project management") {
            if (projectVisited) return undefined;
            projectVisited = true;
            return "Pending removal requests";
          }
          if (title === "Review pending worktree removal") {
            assert.equal(options.length, 1);
            assert.ok(options[0].startsWith(`${assignment.branch} · `));
            return options[0];
          }
          if (title === `Pending removal · ${assignment.branch}`) {
            if (replace) {
              const previous = events()
                .filter((event: any) => event.action === "request")
                .at(-1);
              pi.pi.appendEntry("pi-herdsman-pending-removal", {
                ...previous,
                id: randomUUID(),
              });
            }
            return action === "approve" ? "Approve removal…" : "Dismiss request";
          }
          throw new Error(`Unexpected review menu: ${title}`);
        };
        if (route === "cli") await removeCommand.handler("", ctx);
        else await pi.commandOptions.get("herdsman")!.handler("", ctx);
      };
      const firstId = requestedTool.details.request_id;
      await review("menu", "approve");
      assert.equal(confirmationPrompts, 1);
      assert.equal(events().at(-1).action, "resolve");
      assert.equal(events().at(-1).id, firstId);
      assert.equal(
        pi.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
        false,
      );

      const secondId = await issueRequest();
      assert.notEqual(secondId, firstId);
      await review("cli", "dismiss");
      assert.equal(events().at(-1).action, "resolve");
      assert.equal(events().at(-1).id, secondId);
      assert.ok(notices.some((message) => message.includes("dismissed")));

      const thirdId = await issueRequest();
      await review("cli", "approve");
      assert.equal(confirmationPrompts, 2);
      assert.equal(events().at(-1).action, "resolve");
      assert.equal(events().at(-1).id, thirdId);
      const fourthId = await issueRequest();
      await review("menu", "dismiss");
      assert.equal(events().at(-1).action, "resolve");
      assert.equal(events().at(-1).id, fourthId);

      for (const [route, action] of [
        ["cli", "approve"],
        ["menu", "dismiss"],
      ] as const) {
        const staleId = await issueRequest();
        if (route === "cli")
          await assert.rejects(review(route, action, true), /Pending removal changed/);
        else {
          await review(route, action, true);
          assert.ok(notices.some((message) => message.includes("Pending removal changed")));
        }
        const replacement = events().at(-1);
        assert.equal(replacement.action, "request");
        assert.notEqual(replacement.id, staleId);
        assert.equal(
          events().some((event: any) => event.action === "resolve" && event.id === replacement.id),
          false,
        );
        await review("cli", "dismiss");
        assert.equal(events().at(-1).id, replacement.id);
      }
      ctx.mode = "tui";
      confirmationPrompts = 0;
    }
    const afterRequest = await pi.tools
      .find((tool) => tool.name === "list_staff")!
      .execute("after-removal-request", {}, undefined, undefined, ctx);
    assert.equal(afterRequest.details.ok, true);
    await removeCommand.handler(assignment.branch, ctx);
    assert.equal(confirmationPrompts, 1);
    assert.equal(
      pi.calls.some((args) => args[0] === "worktree" && args[1] === "remove"),
      false,
      "the model request and human cancellation have no destructive effect",
    );
    assert.match(assignment!.branch, /^herdsman\/work-[0-9a-f]{8}$/);
    assert.equal(assignment!.branch.includes(assignment!.id), false);
    assert.equal(assignment!.piSessionFile, realFs.realpathSync(childSessionPath()));
    const assignmentBytes = readFileSync(
      projectAssignmentPath(supervisionRuntime(), repoKey, assignment.branch),
      "utf8",
    );
    assert.deepEqual(Object.keys(JSON.parse(assignmentBytes)).sort(), [
      "branch",
      "checkoutPath",
      "currentEvidenceIds",
      "definition",
      "id",
      "piSessionFile",
      "repoKey",
      "requiredEvidence",
      "text",
      "version",
    ]);
    assert.equal(outcome.details.workspace_id, childWorkspace);
    assert.ok(
      pi.calls.some(
        (args) =>
          args[0] === "agent" &&
          args[1] === "start" &&
          args.includes("--pane") &&
          args.includes("child-pane") &&
          args.includes("--session-id") &&
          args.includes(childSession),
      ),
    );
    const paths = listCoordinationMessagePaths(supervisionRuntime(), childSession);
    assert.equal(paths.length, 2);
    const assignmentDeliveryPath = paths.find(
      (path) => readChiefMessage(path).kind === "project_assignment",
    )!;
    const deliverySnapshot = readFileSync(assignmentDeliveryPath);
    const delivery = readChiefMessage(assignmentDeliveryPath);
    assert.equal(delivery.kind, "project_assignment");
    assert.equal(delivery.text, "Project assignment ready.");
    assert.equal(delivery.resultBindings, undefined);
    assert.ok(pi.calls.some((args) => args.includes("--no-focus") && args.includes("--branch")));
    assert.ok(
      pi.calls.some(
        (args) => args[0] === "agent" && args[1] === "start" && args.includes("--pane"),
      ),
    );
    const managerIsIdle = ctx.isIdle;
    // Keep the Manager's lifecycle subscription for retirement coverage, but
    // prevent it from draining the retained-message assertion below.
    ctx.isIdle = () => false;
    await initializeLeadRuntime();
    const waitForStage = async (stage: string, assertion: () => void) => {
      try {
        await t.waitFor(assertion);
      } catch (error) {
        console.error(
          `[managerDelegateAssignmentTest:${projectTrusted ? "trusted" : "untrusted"}] failed: ${JSON.stringify(
            {
              stage,
              tabCommands,
              tabLabels: Object.fromEntries(tabLabels),
              failedScopeCalls: lead.callResults
                .filter(
                  ({ args, succeeded }: { args: string[]; succeeded: boolean }) =>
                    args[0] === "worktree" && args[1] === "list" && !succeeded,
                )
                .map(({ args }: { args: string[] }) => args),
              leadTools: lead.pi.getActiveTools(),
              leadRole: readLeadCoordinationState(supervisionRuntime(), childSession),
              leadEntries: lead.entries
                .filter((entry: any) => entry.type === "custom")
                .map((entry: any) => ({
                  customType: entry.customType,
                  data: entry.data,
                })),
              lifecycleSubscriptions,
            },
          )}`,
        );
        throw error;
      }
    };
    try {
      // Keep assignment delivery unavailable until after startup while the
      // persisted assignment establishes immutable Managed Lead identity.
      unlinkSync(assignmentDeliveryPath);
      if (!leadStarted) {
        await lead.events.get("session_start")![0](undefined, leadCtx);
        leadStarted = true;
      }
      await waitForStage("initial Managed Lead tab rename", () =>
        assert.ok(
          tabCommands.some(
            (args) =>
              args[0] === "tab" &&
              args[1] === "rename" &&
              args[2] === "child-tab" &&
              args[3] === "Managed Lead",
          ),
        ),
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      assert.equal(lead.pi.getSessionName(), "Existing session name");

      writeFileSync(assignmentDeliveryPath, deliverySnapshot);
      await waitForStage("assignment delivery", () =>
        assert.ok(
          lead.sent.some((message: any) => message.customType === "pi-herdsman-project_assignment"),
        ),
      );
      const assignmentDelivery = lead.sent.find(
        (message: any) => message.customType === "pi-herdsman-project_assignment",
      ) as { content?: string } | undefined;
      assert.ok(assignmentDelivery);
      assert.match(assignmentDelivery.content!, /Implement focused change/);
      assert.doesNotMatch(
        assignmentDelivery.content!,
        /Be orchestration-first|Work directly when the work is trivial|acceptance of Agent outputs/,
      );
      assert.match(
        assignmentDelivery.content!,
        /Settlement is\s+nonterminal; do not infer project closure from runtime state\./,
      );
      assert.match(
        assignmentDelivery.content!,
        /Herdsman automatically hands every completed\s+direct-work response to the Manager role while this assignment remains active\./,
      );
      assert.match(
        assignmentDelivery.content!,
        /If no Manager is available,\s+the handoff remains pending until a Manager can receive it\./,
      );
      assert.match(
        assignmentDelivery.content!,
        /the herd run owns that handoff\s+until it settles; summarize outcome, validation, and important unresolved\s+points in your response\./,
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      assert.equal(
        tabCommands.some((args) => args[0] === "tab" && args[1] === "rename" && args[3] === "Lead"),
        false,
        "assignment delivery must not promote an ordinary Lead session",
      );
      assert.equal(lead.pi.getSessionName(), "Existing session name");
      tabCommands.length = 0;
      holdChildPaneGet = true;
      const heldManagedRefresh = lead.events.get("session_tree")![0](undefined, leadCtx);
      await waitForStage("held pane lookup started", () =>
        assert.equal(childPaneGetDidStart, true),
      );
      await heldManagedRefresh;
      failScopeLookup = true;
      const ambiguousReconciliation = lead.events.get("session_tree")![0](undefined, leadCtx);
      await waitForStage("failed scope lookup recorded", () =>
        assert.ok(
          lead.callResults.some(
            ({ args, succeeded }: { args: string[]; succeeded: boolean }) =>
              args[0] === "worktree" && args[1] === "list" && !succeeded,
          ),
        ),
      );
      releaseChildPaneGet();
      await ambiguousReconciliation;
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      leadCtx.mode = "rpc";
      let lifecyclePresentation: string[] = [];
      leadCtx.ui.select = async (title: string, items: string[]) => {
        if (title.startsWith("Pi Herdsman") || title === "Managed orchestration")
          lifecyclePresentation = items;
        return undefined;
      };
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.equal(lifecyclePresentation[0], "Agents & definitions");
      assert.equal(
        lifecyclePresentation.some((item) => item.startsWith("Lead mode")),
        false,
      );
      await lead.commandOptions.get("lead").handler("", leadCtx);
      assert.deepEqual(lifecyclePresentation, ["managed · unavailable"]);
      const childTabCommands = tabCommands.filter(
        (args) =>
          (args[0] === "pane" && args[1] === "get" && args[2] === "child-pane") ||
          (args[0] === "tab" && args[1] === "list" && args[3] === childWorkspace) ||
          (args[0] === "tab" && args[1] === "rename" && args[2] === "child-tab"),
      );
      assert.ok(childTabCommands.every((args) => args[0] !== "tab" || args[1] !== "rename"));
      failScopeLookup = false;
      await lead.events.get("session_tree")![0](undefined, leadCtx);
      await waitForStage("managed label restored after scope recovery", () =>
        assert.equal(tabLabels.get("child-tab"), "Managed Lead"),
      );
      const messageTool: unknown = lead.tools.find(
        (tool: unknown) => isRecord(tool) && tool.name === "message_manager",
      );
      assert.ok(isRecord(messageTool) && typeof messageTool.execute === "function");
      const message = await messageTool.execute(
        "message",
        { message: "Ready for review" },
        undefined,
        undefined,
        leadCtx,
      );
      assert.match(JSON.stringify(message), /Project message saved for Manager/);
      const { listProjectMessages } = await import("./supervision.ts");
      const retained = listProjectMessages(supervisionRuntime(), repoKey, assignment!.branch);
      assert.equal(retained.length, 1);
      assert.equal(retained[0]!.fromSessionId, childSession);
      assert.equal(retained[0]!.text, "Ready for review");
      ctx.isIdle = managerIsIdle;
      assert.equal(listProjectAssignments(supervisionRuntime(), repoKey)[0]?.id, childSession);
      const publishRetirement = () => {
        const event = `${JSON.stringify({
          event: "worktree_removed",
          data: {
            type: "worktree_removed",
            workspace_id: childWorkspace,
            workspace: {
              workspace_id: childWorkspace,
              worktree: {
                repo_key: repoKey,
                checkout_path: childCwd,
                is_linked_worktree: true,
              },
            },
            worktree: {
              path: childCwd,
              branch: assignment!.branch,
              is_linked_worktree: true,
            },
            forced: false,
          },
        })}\n`;
        for (const client of subscribedLifecycleClients) if (!client.destroyed) client.write(event);
      };
      await waitForStage("lifecycle subscriptions ready", () =>
        assert.ok(subscribedLifecycleClients.size >= 2),
      );
      failScopeLookup = true;
      publishRetirement();
      await waitForStage("first retirement processed", () =>
        assert.ok(
          lead.entries.some((entry: any) =>
            String(entry.data?.error).includes("scope lookup failure"),
          ) || !listProjectAssignments(supervisionRuntime(), repoKey).length,
          JSON.stringify(lead.entries),
        ),
      );
      assert.equal(listProjectAssignments(supervisionRuntime(), repoKey).length, 1);
      const lookupNotices: string[] = [];
      leadCtx.ui.notify = (message: string) => lookupNotices.push(message);
      await lead.commandOptions.get("lead-orchestrate").handler("", leadCtx);
      assert.ok(
        lookupNotices.some(
          (message) => message.includes("Dedicated") || message.includes("Managed Leads"),
        ),
      );
      assert.deepEqual(lead.pi.getActiveTools(), []);
      unavailableScope = true;
      const unavailableNotices: string[] = [];
      leadCtx.ui.notify = (message: string) => unavailableNotices.push(message);
      await lead.commandOptions.get("lead-flexible").handler("", leadCtx);
      assert.ok(unavailableNotices.some((message) => message.includes("Managed Leads")));
      assert.deepEqual(lead.pi.getActiveTools(), []);
      unavailableScope = false;
      leadCtx.mode = "rpc";
      let managedPresentation: string[] = [];
      leadCtx.ui.select = async (title: string, items: string[]) => {
        if (title.startsWith("Pi Herdsman") || title === "Managed orchestration")
          managedPresentation = items;
        return undefined;
      };
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.equal(managedPresentation[0], "Agents & definitions");
      assert.equal(
        managedPresentation.some((item) => item.startsWith("Lead mode")),
        false,
      );
      await lead.commandOptions.get("lead").handler("", leadCtx);
      assert.deepEqual(managedPresentation, ["managed"]);

      failScopeLookup = false;
      const requestsBeforeRemoval = topologyRequests;
      tabCommands.length = 0;
      publishRetirement();
      await waitForStage("retirement topology refresh", () =>
        assert.ok(topologyRequests > requestsBeforeRemoval),
      );
      assert.equal(listProjectAssignments(supervisionRuntime(), repoKey).length, 1);
      assert.equal(
        tabCommands.some(
          (args) =>
            args[0] === "tab" &&
            args[1] === "rename" &&
            args[2] === "child-tab" &&
            args[3] === "Managed Lead",
        ),
        false,
        "retained checkout keeps both the assignment and Managed Lead tab label",
      );
      assert.deepEqual(lead.pi.getActiveTools(), []);
      await lead.commandOptions.get("lead-orchestrate").handler("", leadCtx);
      assert.deepEqual(lead.pi.getActiveTools(), []);
      managedPresentation = [];
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.equal(managedPresentation[0], "Agents & definitions");
      assert.equal(
        managedPresentation.some((item) => item.startsWith("Lead mode")),
        false,
      );
      await lead.commandOptions.get("lead").handler("", leadCtx);
      assert.deepEqual(managedPresentation, ["managed"]);

      reportCheckoutAbsent = true;
      rmSync(childCwd, { recursive: true, force: true });
      tabCommands.length = 0;
      // The Manager and Lead contexts share process.env in this test harness.
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      publishRetirement();
      await waitForStage("removed assignment", () =>
        assert.equal(listProjectAssignments(supervisionRuntime(), repoKey).length, 0),
      );
      await lead.events.get("session_tree")![0](undefined, leadCtx);
      lifecyclePresentation = [];
      leadCtx.ui.select = async (title: string, items: string[]) => {
        if (title.startsWith("Pi Herdsman") || title === "Managed orchestration")
          lifecyclePresentation = items;
        return undefined;
      };
      await lead.commandOptions.get("herdsman").handler("", leadCtx);
      assert.equal(lifecyclePresentation[0], "Agents & definitions");
      assert.equal(
        lifecyclePresentation.some((item) => item.startsWith("Lead mode")),
        false,
      );
      await lead.commandOptions.get("lead").handler("", leadCtx);
      assert.deepEqual(lifecyclePresentation, ["managed · retired"]);
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      assert.equal(lead.pi.getActiveTools().includes("delegate_agent"), false);
      assert.equal(lead.pi.getActiveTools().includes("resume_agent"), false);
      const retiredLeadNotices: string[] = [];
      leadCtx.ui.notify = (message: string) => retiredLeadNotices.push(message);
      await lead.commandOptions.get("lead-orchestrate").handler("", leadCtx);
      assert.ok(
        retiredLeadNotices.some((message) => message.includes("Managed Leads")),
        "retired Managed Lead cannot fall back to ordinary execution",
      );
      assert.equal(tabLabels.get("child-tab"), "Managed Lead");
      process.env.HERDR_WORKSPACE_ID = WORKSPACE;
      await pi.commandOptions.get("manager-leave").handler("", ctx);
      assert.equal(
        readManagerDescriptor(supervisionRuntime(), realFs.realpathSync.native(gitRepoPath)),
        undefined,
      );
      assert.equal(listProjectAssignments(supervisionRuntime(), repoKey).length, 0);
      const retirement = listPendingRetirements(supervisionRuntime(), repoKey).find(
        (record) => record.id === childSession && record.branch === assignment!.branch,
      );
      assert.ok(retirement, "the exact committed retirement record remains authoritative");
      assert.equal(retirement.repoKey, assignment!.repoKey);
      process.env.HERDR_WORKSPACE_ID = childWorkspace;
      await lead.events.get("session_shutdown")?.[0]();
    } finally {
      await lead.events.get("session_shutdown")?.[0]();
    }
  } finally {
    authorityHolder?.release();
    releaseLeadLock();
    if (leadPublication) await leadPublication;
    if (lockOrder) await lead?.events.get("session_shutdown")?.[0]();
    if (!manager1Shutdown) await pi.events.get("session_shutdown")?.[0]();
    for (const client of lifecycleClients) client.destroy();
    if (lifecycleServer?.listening)
      await new Promise<void>((resolve) => lifecycleServer!.close(() => resolve()));
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
}

for (const projectTrusted of [true, false])
  test(`Manager delegate persists an exact worktree Lead assignment (${projectTrusted ? "trusted" : "untrusted"})`, (t) =>
    managerDelegateAssignmentTest(t, projectTrusted));

test(
  "Manager delegation accepts Windows extended Herdr repository keys",
  { skip: process.platform !== "win32" },
  (t) => managerDelegateAssignmentTest(t, true, undefined, undefined, undefined, true),
);

test("trusted Manager approves an undecided delegated worktree", (t) =>
  managerDelegateAssignmentTest(t, true, undefined, null));
test("trusted Manager overrides a saved target denial", (t) =>
  managerDelegateAssignmentTest(t, true, undefined, false, true));
test("untrusted Manager restricts a saved-approved target", (t) =>
  managerDelegateAssignmentTest(t, false, undefined, true));
test("untrusted Manager does not inherit saved ancestor approval", (t) =>
  managerDelegateAssignmentTest(t, false, undefined, null, true));

test("Manager session binding holds the assignment lock before Lead publication", (t) =>
  managerDelegateAssignmentTest(t, false, "manager-first"));

test("registered delegate_work waits for authority before initial assignment publication", (t) =>
  managerDelegateAssignmentTest(t, true, undefined, true, null, false, "publication"));

test("registered delegate_work waits for authority while binding the started Lead session", (t) =>
  managerDelegateAssignmentTest(t, true, undefined, true, null, false, "binding"));

test("registered delegate_work preserves a conflicting assignment created during authority wait", (t) =>
  managerDelegateAssignmentTest(t, true, undefined, true, null, false, "conflict"));

test("registered delegate_work cancellation during authority wait publishes nothing", (t) =>
  managerDelegateAssignmentTest(t, true, undefined, true, null, false, "cancel"));

test("Lead publication holds the assignment lock before Manager session binding", (t) =>
  managerDelegateAssignmentTest(t, false, "lead-first"));
