import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChiefProjectRuntime } from "./chief-project.ts";
import { AGENT_COORDINATION_TOOLS, EXPECTED_COORDINATOR_LAUNCH_ENV } from "./agent-definitions.ts";
import { fakeContext, PI_AGENT_ROOT } from "./support.ts";
import {
  COORDINATOR_DEFINITION_ENTRY,
  claimManagerLease,
  claimManagerStartupLock,
  getManagerStartIntent,
  managerDescriptorPath,
  readManagerDescriptorStatus,
  type ManagerLease,
  supervisionRuntime,
  writeLeadCoordinationState,
  writeManagerRecoveryReference,
} from "./supervision.ts";

test.before(() => {
  process.env.HERDR_SOCKET_PATH = join(PI_AGENT_ROOT, "test-herdr.sock");
});

test("Chief clone provisions only a verified primary workspace", async (t) => {
  for (const scenario of [
    "create",
    "reuse",
    "incomplete membership",
    "checkout replaced",
    "authority lost",
    "startup locked",
    "lost acknowledgement",
    "unverified placement",
  ]) {
    await t.test(scenario, async (t) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "chief-clone-")));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const repository = join(root, "project");
      const canonicalRepoKey = join(repository, ".git");
      const runtime = supervisionRuntime(join(root, "socket"));
      const url = "https://example.test/owner/project.git";
      const workspaceId = "project-workspace";
      const retired = join(root, "retired");
      let workspaceExists = scenario === "reuse" || scenario === "incomplete membership";
      let checkoutReplaced = false;
      let snapshotObserved = false;
      let gitCheckedAfterSnapshot = false;
      let authorityChecks = 0;
      const mutations: string[] = [];
      if (scenario === "startup locked") {
        const lock = claimManagerStartupLock(runtime, canonicalRepoKey);
        t.after(() => lock.release());
      }
      const chief = createChiefProjectRuntime(
        {
          exec: async (command: string, args: string[]) => {
            const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
            const response = (result: unknown) => ok(JSON.stringify({ id: 1, result }));
            if (command === "git") {
              if (args[0] === "clone") {
                assert.deepEqual(args, ["clone", "--", url, repository]);
                mutations.push("git clone");
                mkdirSync(canonicalRepoKey);
                return ok("");
              }
              assert.equal(args[0], "rev-parse");
              if (snapshotObserved) gitCheckedAfterSnapshot = true;
              if (checkoutReplaced)
                return {
                  code: 128,
                  stdout: "",
                  stderr: "not a git repository",
                };
              return ok(args.at(-1) === "--show-toplevel" ? repository : canonicalRepoKey);
            }
            switch (args.slice(0, 2).join(" ")) {
              case "api snapshot":
                snapshotObserved = true;
                if (scenario === "checkout replaced" && !checkoutReplaced) {
                  renameSync(repository, retired);
                  mkdirSync(repository);
                  checkoutReplaced = true;
                }
                return response({
                  snapshot: {
                    workspaces: workspaceExists
                      ? [
                          {
                            workspace_id: workspaceId,
                            worktree: scenario === "incomplete membership" ? {} : null,
                          },
                        ]
                      : [],
                    panes: workspaceExists ? [{ workspace_id: workspaceId, cwd: repository }] : [],
                    agents: [],
                  },
                });
              case "workspace create":
                assert.deepEqual(args.slice(2), ["--cwd", repository, "--no-focus"]);
                mutations.push("workspace create");
                workspaceExists = true;
                if (scenario === "lost acknowledgement")
                  throw new Error("lost workspace acknowledgement");
                return response({ workspace: { workspace_id: workspaceId } });
              case "worktree list":
                assert.deepEqual(args.slice(2), ["--workspace", workspaceId]);
                return response({
                  source: {
                    repo_key: canonicalRepoKey,
                    repo_name: "project",
                    source_workspace_id: workspaceId,
                    source_checkout_path: scenario === "unverified placement" ? root : repository,
                  },
                  worktrees: [],
                });
              default:
                assert.fail(`Unexpected command: ${command} ${args.join(" ")}`);
            }
          },
        } as unknown as ExtensionAPI,
        {
          assertChief: async () => {
            if (++authorityChecks === 3 && scenario === "authority lost") {
              assert.ok(gitCheckedAfterSnapshot);
              throw new Error("Chief authority lost");
            }
          },
          remoteIdentity: async () => undefined,
          runtime: () => runtime,
          build: { version: "test", sha256: "a".repeat(64) },
          extensionPath: "/extension.ts",
        },
      );
      const result = await chief.clone(url, repository, fakeContext());
      assert.ok("repository" in result);
      assert.equal(result.repository, repository);
      assert.ok(
        statSync(checkoutReplaced ? join(retired, ".git") : canonicalRepoKey).isDirectory(),
      );
      assert.deepEqual(
        mutations,
        ["create", "lost acknowledgement", "unverified placement"].includes(scenario)
          ? ["git clone", "workspace create"]
          : ["git clone"],
      );
      switch (scenario) {
        case "create":
        case "reuse":
          assert.deepEqual(result, {
            status: "cloned",
            repository,
            workspaceId,
          });
          break;
        default:
          assert.equal(result.status, "partial_failure");
          if (scenario === "unverified placement") {
            assert.equal(result.stage, "workspace_verify");
            assert.deepEqual(result.placement, { workspaceId });
          } else if (scenario === "lost acknowledgement") {
            assert.equal(result.stage, "workspace_create");
            assert.match(result.reason, /lost workspace acknowledgement/);
            assert.equal(result.placement?.workspaceId, undefined);
          } else if (scenario === "incomplete membership") {
            assert.match(result.reason, /conflicting repository identity/);
          } else if (scenario === "checkout replaced") {
            assert.match(result.reason, /Git local repository identity is unavailable/);
          } else {
            assert.match(result.reason, /authority lost|startup lock is in progress/i);
          }
      }
    });
  }
});

test("Chief Git approval cannot transfer to a replacement directory", async (t) => {
  for (const change of ["existing", "missing ancestor", "missing symlink", "declined"] as const) {
    await t.test(change, async (t) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "chief-approval-")));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const anchor = join(root, "selected");
      const retired = join(root, "retired");
      const replacement = join(root, "replacement");
      mkdirSync(anchor);
      mkdirSync(replacement);
      const target = change === "existing" ? anchor : join(anchor, "missing", "project");
      let confirmations = 0;
      const context = fakeContext();
      context.hasUI = true;
      context.ui.confirm = async (_title, message) => {
        confirmations++;
        assert.ok(message.includes(target));
        if (change === "declined") return false;
        renameSync(anchor, retired);
        if (change === "missing symlink") symlinkSync(replacement, anchor, "junction");
        else mkdirSync(anchor);
        return true;
      };
      const chief = createChiefProjectRuntime(
        {
          exec: async (command: string, args: string[]) => {
            assert.equal(command, "git");
            assert.equal(args[0], "rev-parse", "no mutating Git command");
            return { code: 128, stdout: "", stderr: "" };
          },
        } as unknown as ExtensionAPI,
        {
          assertChief: async () => {},
          remoteIdentity: async () => undefined,
          runtime: () => {
            throw new Error("Unexpected startup");
          },
          build: { version: "test", sha256: "a".repeat(64) },
          extensionPath: "/extension.ts",
        },
      );
      const start = () => chief.start(target, undefined, context);
      if (change === "declined") {
        assert.deepEqual(await start(), {
          status: "cancelled",
          repository: target,
        });
      } else if (change === "existing") {
        const result = await start();
        assert.equal(result.status, "partial_failure");
        assert.ok("reason" in result && /changed/.test(result.reason));
      } else {
        await assert.rejects(start(), /changed|symlink/);
      }
      assert.equal(confirmations, 1);
      for (const path of [anchor, retired, replacement])
        assert.equal(existsSync(join(path, ".git")), false);
      if (change !== "existing") assert.equal(existsSync(dirname(target)), false);
    });
  }
});

test("Chief lifecycle uses one exact Pi conversation and preserves uncertain startup", async (t) => {
  for (const scenario of [
    "lifecycle",
    "clone from running project",
    "clone origin mismatch",
    "uncertain",
    "uncertain resume",
    "safe refusal",
    "missing integration",
    "denied",
    "optional",
    "pending",
    "old generation",
    "malformed",
    "foreign",
    "named",
    "conflicting configuration",
  ] as const) {
    await t.test(scenario, async (t) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "chief-project-")));
      const prior = process.env.PI_CODING_AGENT_DIR;
      const agentDir = join(root, "pi");
      const hook = join("extensions", "herdr-agent-state.ts");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      if (scenario !== "missing integration" && scenario !== "optional") {
        mkdirSync(join(agentDir, "extensions"), { recursive: true });
        writeFileSync(join(agentDir, hook), readFileSync(join(PI_AGENT_ROOT, hook)));
      }
      const namedDefinition = join(agentDir, "coordinators", "managers", "custom-manager.md");
      const writeNamedDefinition = (toolPolicy: string) =>
        writeFileSync(
          namedDefinition,
          `---\nname: custom-manager\nmodel: test-provider/test-model\nthinking: high\n${toolPolicy}\n---\nCustom manager profile body`,
        );
      if (scenario === "named") {
        mkdirSync(dirname(namedDefinition), { recursive: true });
        writeNamedDefinition("tools: [codemode]\nagents: [scout]");
      }
      const originMismatch = scenario === "clone origin mismatch";
      const cloneFromCheckout = scenario === "clone from running project" || originMismatch;
      const sourceCheckout = join(root, "source");
      const sourceKey = join(sourceCheckout, ".git");
      const origin = "https://example.test/owner/project.git";
      const gitDirectory = join(root, "project", ".git");
      if (!cloneFromCheckout) mkdirSync(gitDirectory, { recursive: true });
      const repository = dirname(gitDirectory);
      const canonicalRepoKey = gitDirectory;
      const runtime = supervisionRuntime(join(root, "socket"));
      let currentRuntime = runtime;
      const build = { version: "test", sha256: "a".repeat(64) };
      let manager: ManagerLease | undefined;
      let sourceManager: ManagerLease | undefined;
      t.after(() => {
        if (manager && !managerPublished && ["malformed", "foreign"].includes(scenario))
          renameSync(delayedDescriptor, descriptorPath);
        manager?.release();
        sourceManager?.release();
        rmSync(guardPath, { force: true });
        if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prior;
        rmSync(root, { force: true, recursive: true });
      });
      let tabCreated = false;
      let launchConfiguration: string | undefined;
      let workspaceCreated = !cloneFromCheckout;
      const cloneCalls: string[] = [];
      const placementCalls: string[] = [];
      let denyChief = false;
      let observedPid = process.pid;
      let launches = 0;
      let file: string | undefined;
      let id: string | undefined;
      let managerPublished = false;
      let expectedHistoryAtLaunch: string | undefined;
      const descriptorPath = managerDescriptorPath(runtime, canonicalRepoKey);
      const delayedDescriptor = descriptorPath + ".delayed";
      const guardPath = descriptorPath + ".unsettled";
      const intents = join(runtime.root, "manager-start-intents");
      const remainingIntents = () => (existsSync(intents) ? readdirSync(intents) : []);
      let lostAcknowledgement = false;
      const workspace = {
        workspace_id: "manager-workspace",
        worktree: {
          checkout_path: repository,
          is_linked_worktree: false,
          repo_key: canonicalRepoKey,
        },
      };
      const pane = {
        pane_id: "manager-pane",
        tab_id: "manager-tab",
        workspace_id: workspace.workspace_id,
        terminal_id: "manager-terminal",
        cwd: repository,
      };
      function activate(piSessionId: string, piSessionFile?: string) {
        manager = claimManagerLease(
          {
            build,
            canonicalRepoKey,
            repoKey: canonicalRepoKey,
            workspaceId: pane.workspace_id,
            tabId: pane.tab_id,
            paneId: pane.pane_id,
            piSessionId,
            piSessionFile,
          },
          runtime,
        );
        const instanceId = randomUUID();
        writeLeadCoordinationState(runtime, {
          version: 1,
          role: "manager",
          piSessionId,
          build,
          instanceId,
          updatedAt: Date.now(),
          ...(launchConfiguration
            ? {
                startupAttestation: {
                  kind: "model_restore",
                  assignmentId: piSessionId,
                  generation: instanceId,
                  result: scenario === "named" ? "definition_override" : "no_saved_model",
                  launchConfiguration:
                    scenario === "conflicting configuration" ? "0".repeat(64) : launchConfiguration,
                },
              }
            : {}),
        });
      }
      const response = (result: unknown) => ({
        code: 0,
        stdout: JSON.stringify({ id: 1, result }),
        stderr: "",
      });
      const pi = {
        exec: async (command: string, args: string[], options?: { cwd?: string }) => {
          if (command === "git") {
            const cwd = options?.cwd;
            let stdout = "";
            if (args[0] === "rev-parse") {
              assert.ok(cwd === repository || (cloneFromCheckout && cwd === sourceCheckout));
              stdout = args.at(-1) === "--show-toplevel" ? cwd : join(cwd, ".git");
            } else {
              assert.ok(cloneFromCheckout);
              if (args[0] === "remote" && args[1] === "get-url") {
                assert.deepEqual(args, ["remote", "get-url", "--all", "origin"]);
                assert.ok(cwd === sourceCheckout || cwd === repository);
                cloneCalls.push(cwd === sourceCheckout ? "read origin" : "verify origin");
                stdout =
                  cwd === repository && originMismatch
                    ? "https://different.test/repo.git\n"
                    : origin + "\n";
              } else if (args.includes("clone")) {
                const alias = args[8];
                const nonce = new URL(alias).hostname.replace(/\.invalid$/, "");
                assert.equal(cwd, root);
                assert.deepEqual(args, [
                  "-c",
                  `remote.herdsman-${nonce}.url=${origin}`,
                  "-c",
                  `url.${origin}.insteadOf=${alias}`,
                  "clone",
                  "--origin",
                  "origin",
                  "--",
                  alias,
                  repository,
                ]);
                assert.notEqual(alias, origin);
                assert.ok(statSync(repository).isDirectory());
                cloneCalls.push("git clone");
                mkdirSync(canonicalRepoKey);
              } else {
                assert.equal(cwd, repository);
                assert.deepEqual(args, ["remote", "set-url", "--", "origin", origin]);
                cloneCalls.push("record origin");
              }
            }
            return {
              code: 0,
              stdout,
              stderr: "",
            };
          }
          const operation = args.slice(0, 2).join(" ");
          if (["workspace create", "tab create", "agent start"].includes(operation))
            placementCalls.push(operation);
          switch (operation) {
            case "api snapshot":
              return response({
                snapshot: {
                  agents: [],
                  panes: [],
                  workspaces:
                    scenario === "missing integration" || !workspaceCreated ? [] : [workspace],
                },
              });
            case "workspace create":
              assert.ok(cloneFromCheckout && !workspaceCreated);
              assert.deepEqual(args.slice(2), ["--cwd", repository, "--no-focus"]);
              assert.ok(statSync(canonicalRepoKey).isDirectory());
              workspaceCreated = true;
              return response({ workspace });
            case "workspace get":
              return response({ workspace });
            case "worktree list":
              return response({
                source: {
                  repo_key: canonicalRepoKey,
                  repo_name: "project",
                  source_workspace_id: workspace.workspace_id,
                  source_checkout_path: repository,
                },
                worktrees: [],
              });
            case "tab create":
              assert.equal(args[args.indexOf("--env") + 1], `PI_CODING_AGENT_DIR=${agentDir}`);
              launchConfiguration = args
                .find((arg) => arg.startsWith(`${EXPECTED_COORDINATOR_LAUNCH_ENV}=`))
                ?.split("=")[1];
              assert.match(launchConfiguration ?? "", /^[0-9a-f]{64}$/);
              tabCreated = true;
              return response({
                tab: { tab_id: pane.tab_id },
                root_pane: pane,
              });
            case "tab list":
              return response({
                tabs: tabCreated ? [{ workspace_id: pane.workspace_id, tab_id: pane.tab_id }] : [],
              });
            case "pane list":
              return response({ panes: tabCreated ? [pane] : [] });
            case "agent list":
              return response({ agents: [] });
            case "pane process-info":
              if (
                manager &&
                !managerPublished &&
                (scenario === "pending" || scenario === "old generation")
              ) {
                renameSync(delayedDescriptor, descriptorPath);
                managerPublished = true;
              }
              return response({
                process_info: {
                  pane_id: pane.pane_id,
                  shell_pid: 12,
                  foreground_process_group_id: 12,
                  foreground_processes: manager
                    ? [{ pid: observedPid }]
                    : [{ pid: 12, argv0: "/bin/sh" }],
                },
              });
            case "pane run":
              return response({});
            case "pane wait-output":
              if (scenario === "denied") denyChief = true;
              return response({});
            case "pane get":
              return response({ pane });
            case "agent start": {
              launches++;
              assert.ok(args.includes(join(agentDir, hook)));
              if (scenario === "named") {
                assert.ok(args.includes("--model"), JSON.stringify(args));
                assert.ok(args.includes("test-provider/test-model"));
                assert.ok(args.includes("--thinking"));
                assert.ok(args.includes("high"));
                const tools = args[args.indexOf("--tools") + 1]?.split(",") ?? [];
                for (const name of [...AGENT_COORDINATION_TOOLS, "delegate_work"])
                  assert.ok(tools.includes(name), name);
                assert.equal(tools.includes("codemode"), launches === 1);
                assert.equal(args.includes("--no-tools"), launches === 2);
              }
              assert.ok(!args.includes("--no-skills"));
              assert.ok(!args.includes("--no-context-files"));
              if (scenario !== "named") {
                const tools = args[args.indexOf("--tools") + 1]?.split(",") ?? [];
                assert.ok(tools.includes("delegate_work"), JSON.stringify(args));
              }
              assert.equal(args.at(-2), "--session");
              assert.ok(!args.some((arg) => arg.includes("--trust")));
              const path = args.at(-1)!;
              if (expectedHistoryAtLaunch !== undefined)
                assert.equal(readFileSync(path, "utf8"), expectedHistoryAtLaunch);
              const saved = SessionManager.open(path);
              assert.ok(existsSync(guardPath), "Guard must be published before Herdr launch");
              if (!file) {
                file = path;
                id = saved.getSessionId();
                assert.equal(saved.getCwd(), repository);
                assert.equal(saved.getEntries().length, 0);
                assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
                if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
                assert.equal(getManagerStartIntent(runtime, id)?.paneId, pane.pane_id);
                assert.equal(
                  getManagerStartIntent(runtime, id)?.definition,
                  scenario === "named" ? "custom-manager" : "manager",
                );
                if (scenario === "safe refusal" && launches === 1) {
                  file = undefined;
                  id = undefined;
                  denyChief = true;
                  return {
                    code: 1,
                    stdout: "",
                    stderr: JSON.stringify({
                      error: {
                        code: "agent_pane_busy",
                        message: "Pane launch refused",
                      },
                    }),
                  };
                }
                if (scenario !== "uncertain")
                  saved.appendCustomEntry("pi-herdsman-role", {
                    sessionId: id,
                    role: "manager",
                    leadTools: [],
                  });
                if (scenario === "named")
                  saved.appendCustomEntry(COORDINATOR_DEFINITION_ENTRY, {
                    version: 1,
                    sessionId: id,
                    category: "manager",
                    name: "custom-manager",
                  });
              } else {
                assert.equal(path, file);
                assert.equal(saved.getSessionId(), id);
                const intent = getManagerStartIntent(runtime, saved.getSessionId());
                assert.equal(intent?.recoverySessionFile, path);
                assert.equal(intent?.paneId, pane.pane_id);
                assert.ok(intent?.admission);
              }
              if (
                (scenario === "uncertain" || scenario === "uncertain resume") &&
                !lostAcknowledgement
              ) {
                lostAcknowledgement = true;
                throw new Error("lost launch acknowledgement");
              }
              const piSessionId = saved.getSessionId();
              activate(piSessionId, path);
              if (["pending", "old generation", "malformed", "foreign"].includes(scenario)) {
                renameSync(descriptorPath, delayedDescriptor);
                if (scenario === "old generation")
                  writeFileSync(
                    descriptorPath,
                    JSON.stringify({
                      ...manager!.descriptor,
                      claim: { ...manager!.descriptor.claim, id: randomUUID() },
                    }),
                  );
                if (scenario === "malformed") writeFileSync(descriptorPath, "{}");
                if (scenario === "foreign") observedPid++;
                assert.throws(() => readManagerDescriptorStatus(runtime, canonicalRepoKey));
              }
              writeManagerRecoveryReference(runtime, {
                version: 1,
                canonicalRepoKey,
                piSessionId,
                piSessionFile: path,
              });
              return response({ agent: { name: args[2] } });
            }
            default:
              throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
          }
        },
      } as unknown as ExtensionAPI;
      const chief = createChiefProjectRuntime(pi, {
        assertChief: async () => {
          if (denyChief) throw new Error("Chief authority lost");
        },
        remoteIdentity: async () => manager,
        runtime: () => currentRuntime,
        build,
        extensionPath: "/extension.ts",
        managerTools: ["delegate_work"],
      });
      const ctx = fakeContext();
      if (scenario === "named") {
        await assert.rejects(
          chief.startLead("workspace", "managed-lead", undefined, ctx),
          /managed-lead is reserved for assigned Leads/,
        );
        assert.deepEqual(placementCalls, []);
        assert.deepEqual(remainingIntents(), []);
      }
      const start = () =>
        scenario === "named"
          ? chief.startNamed(repository, undefined, "custom-manager", ctx)
          : cloneFromCheckout
            ? chief.start(sourceCheckout, repository, ctx)
            : chief.start(repository, undefined, ctx);
      if (cloneFromCheckout) {
        mkdirSync(sourceKey, { recursive: true });
        const sourceFile = join(sourceCheckout, "uncommitted.txt");
        writeFileSync(sourceFile, "source-only changes");
        const sourceStat = statSync(sourceCheckout);
        sourceManager = claimManagerLease(
          {
            build,
            canonicalRepoKey: sourceKey,
            repoKey: sourceKey,
            workspaceId: "source-workspace",
            tabId: "source-tab",
            paneId: "source-pane",
            piSessionId: randomUUID(),
          },
          runtime,
        );
        const result = await start();
        assert.deepEqual(cloneCalls, [
          "read origin",
          "git clone",
          "record origin",
          "verify origin",
        ]);
        if (originMismatch) {
          assert.equal(result.status, "partial_failure");
          assert.ok("stage" in result && result.stage === "verification");
          assert.equal(result.repository, repository);
          assert.ok(!result.reason.includes("different.test"));
          assert.ok(statSync(canonicalRepoKey).isDirectory());
          assert.deepEqual(placementCalls, []);
          return;
        }
        assert.deepEqual(result, {
          status: "started",
          repository,
          definition: "manager",
        });
        const expectedPlacement = ["workspace create", "tab create", "agent start"];
        assert.deepEqual(placementCalls, expectedPlacement);
        assert.equal(launches, 1);
        const destination = readManagerDescriptorStatus(runtime, canonicalRepoKey);
        assert.ok(destination?.live);
        assert.equal(destination.descriptor.canonicalRepoKey, canonicalRepoKey);
        assert.equal(destination.descriptor.workspaceId, workspace.workspace_id);
        assert.equal(destination.descriptor.piSessionId, id);
        assert.notEqual(destination.descriptor.piSessionId, sourceManager.descriptor.piSessionId);

        const destinationFile = join(repository, "keep.txt");
        writeFileSync(destinationFile, "existing destination");
        await assert.rejects(start(), /Clone destination already exists/);
        assert.deepEqual(cloneCalls, [
          "read origin",
          "git clone",
          "record origin",
          "verify origin",
          "read origin",
        ]);
        assert.deepEqual(placementCalls, expectedPlacement);
        assert.equal(readFileSync(destinationFile, "utf8"), "existing destination");
        assert.equal(statSync(sourceCheckout).ino, sourceStat.ino);
        assert.equal(readFileSync(sourceFile, "utf8"), "source-only changes");
        assert.ok(!existsSync(join(repository, "uncommitted.txt")));
        const source = readManagerDescriptorStatus(runtime, sourceKey);
        assert.ok(source?.live);
        assert.deepEqual(source.descriptor, sourceManager.descriptor);
        return;
      }
      if (scenario === "missing integration") {
        await assert.rejects(start(), /Required Herdr Pi integration is missing/);
        assert.deepEqual(placementCalls, []);
        return;
      }
      if (scenario === "optional") {
        activate(randomUUID(), join(repository, "not-flushed.jsonl"));
        assert.deepEqual(await start(), {
          status: "already_running",
          repository,
        });
        const result = await chief.resume(repository, ctx);
        assert.equal(result.status, "partial_failure");
        assert.ok("stage" in result && result.stage === "recovery");
        assert.equal(launches, 0);
        assert.equal(tabCreated, false);
        return;
      }
      const resume = () => chief.resume(repository, ctx);
      if (scenario === "uncertain resume") {
        const saved = SessionManager.create(repository);
        file = saved.getSessionFile()!;
        id = saved.getSessionId();
        saved.appendCustomEntry("pi-herdsman-role", {
          sessionId: id,
          role: "manager",
          leadTools: [],
        });
        saved.appendMessage({
          role: "user",
          content: "Previous Manager conversation",
          timestamp: Date.now(),
        });
        writeManagerRecoveryReference(runtime, {
          version: 1,
          canonicalRepoKey,
          piSessionId: id,
          piSessionFile: file,
        });
      }
      const first = await (scenario === "uncertain resume" ? resume() : start());
      if (scenario === "denied") {
        assert.equal(first.status, "partial_failure");
        assert.equal(launches, 0);
        assert.deepEqual(remainingIntents(), []);
        return;
      }
      assert.equal(launches, 1);
      if (scenario === "safe refusal") {
        assert.equal(first.status, "partial_failure");
        assert.equal(existsSync(guardPath), false);
        assert.deepEqual(remainingIntents(), []);
        denyChief = false;
        tabCreated = false;
        assert.deepEqual(await start(), {
          status: "started",
          repository,
          definition: "manager",
        });
        assert.equal(launches, 2);
        assert.equal(existsSync(guardPath), false);
        return;
      }
      assert.ok(file && id);
      if (scenario === "conflicting configuration") {
        assert.equal(first.status, "partial_failure");
        assert.ok("stage" in first && first.stage === "readiness");
        assert.match(first.reason, /different launch configuration/);
        assert.ok(existsSync(guardPath));
        return;
      }
      if (scenario === "uncertain" || scenario === "uncertain resume") {
        assert.equal(first.status, "partial_failure");
        assert.equal(existsSync(guardPath), true);
        if (scenario === "uncertain")
          assert.equal(getManagerStartIntent(runtime, id)?.paneId, pane.pane_id);
        const guardBefore = readFileSync(guardPath, "utf8");
        process.env.PI_CODING_AGENT_DIR = join(root, "other-profile");
        currentRuntime = supervisionRuntime(join(root, "socket"));
        try {
          assert.equal(
            managerDescriptorPath(currentRuntime, canonicalRepoKey) + ".unsettled",
            guardPath,
          );
          for (const retry of [start, resume]) {
            const blocked = await retry();
            assert.ok("stage" in blocked && blocked.stage === "unsettled_launch");
            assert.match(blocked.reason, /another Pi profile/);
            assert.ok(!blocked.reason.includes(id));
          }
          assert.equal(launches, 1);
          assert.equal(readFileSync(guardPath, "utf8"), guardBefore);
        } finally {
          currentRuntime = runtime;
          process.env.PI_CODING_AGENT_DIR = join(root, "pi");
        }
        for (const retry of [start, resume]) {
          const blocked = await retry();
          assert.equal(blocked.status, "partial_failure");
          assert.ok("stage" in blocked && blocked.stage === "unsettled_launch");
          assert.match(blocked.reason, /Inspect that exact session and pane/);
          assert.equal(launches, 1);
        }
        if (scenario === "uncertain") {
          const guard = readFileSync(guardPath, "utf8");
          writeFileSync(guardPath, "{");
          const blocked = await start();
          assert.ok("stage" in blocked && blocked.stage === "unsettled_launch");
          assert.equal(launches, 1);
          assert.equal(readFileSync(guardPath, "utf8"), "{");
          writeFileSync(guardPath, guard);
        }
        if (scenario === "uncertain")
          SessionManager.open(file).appendCustomEntry("pi-herdsman-role", {
            sessionId: id,
            role: "manager",
            leadTools: [],
          });
        activate(id, file);
        writeManagerRecoveryReference(runtime, {
          version: 1,
          canonicalRepoKey,
          piSessionId: id,
          piSessionFile: file,
        });
        assert.deepEqual(await resume(), {
          status: "already_running",
          repository,
        });
        assert.equal(launches, 1);
        assert.equal(existsSync(guardPath), false);
        assert.equal(getManagerStartIntent(runtime, id), undefined);
        return;
      }
      if (scenario === "malformed" || scenario === "foreign") {
        assert.equal(first.status, "partial_failure");
        assert.ok("stage" in first && first.stage === "readiness");
        assert.match(
          first.reason,
          scenario === "malformed"
            ? /Unable to verify Manager descriptor/
            : /exact running Herdr pane process/,
        );
        return;
      }
      assert.deepEqual(first, {
        status: "started",
        repository,
        definition: scenario === "named" ? "custom-manager" : "manager",
      });
      assert.equal(existsSync(guardPath), false);
      if (scenario === "pending" || scenario === "old generation") {
        assert.equal(managerPublished, true);
        return;
      }
      assert.equal(getManagerStartIntent(runtime, id), undefined);
      assert.deepEqual(await start(), {
        status: "already_running",
        repository,
      });
      observedPid++;
      await assert.rejects(start(), /exact running Herdr pane process/);
      observedPid--;
      manager!.release();
      manager = undefined;
      tabCreated = false;

      const recovery = {
        version: 1 as const,
        canonicalRepoKey,
        piSessionFile: file,
      };
      writeManagerRecoveryReference(runtime, {
        ...recovery,
        piSessionId: randomUUID(),
      });
      for (const operation of [start, () => chief.resume(repository, ctx)]) {
        const result = await operation();
        assert.equal(result.status, "partial_failure");
        assert.ok("stage" in result);
        assert.equal(result.stage, "recovery");
        assert.equal(launches, 1);
        assert.equal(tabCreated, false);
      }
      writeManagerRecoveryReference(runtime, { ...recovery, piSessionId: id });
      const history = readFileSync(file, "utf8");
      // A v2 header would be rewritten by SessionManager.open, but not Chief's inspection.
      const [header, ...rest] = history.split("\n");
      expectedHistoryAtLaunch = [
        JSON.stringify({ ...JSON.parse(header), version: 2 }),
        ...rest,
      ].join("\n");
      writeFileSync(file, expectedHistoryAtLaunch);
      assert.deepEqual(await start(), {
        status: "resume_required",
        repository,
        ...(scenario === "named" ? { definition: "custom-manager" } : {}),
      });
      assert.equal(readFileSync(file, "utf8"), expectedHistoryAtLaunch);
      if (scenario === "named") writeNamedDefinition("tools: []\nagents: []");
      assert.deepEqual(await chief.resume(repository, ctx), {
        status: "resumed",
        repository,
        definition: scenario === "named" ? "custom-manager" : "manager",
      });
      assert.equal(launches, 2);
      assert.equal(existsSync(guardPath), false);
      assert.deepEqual(remainingIntents(), []);
      assert.equal(readFileSync(file, "utf8"), history);
    });
  }
});
