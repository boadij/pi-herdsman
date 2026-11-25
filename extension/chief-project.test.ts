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
import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createChiefProjectRuntime } from "./chief-project.ts";
import { fakeContext, PI_AGENT_ROOT } from "./support.ts";
import {
  claimManagerLease,
  getManagerStartIntent,
  managerDescriptorPath,
  readManagerDescriptorStatus,
  type ManagerLease,
  supervisionRuntime,
  writeLeadCoordinationState,
  writeManagerRecoveryReference,
} from "./supervision.ts";

test("Chief Git approval cannot transfer to a replacement directory", async (t) => {
  for (const change of [
    "existing",
    "missing ancestor",
    "missing symlink",
    "declined",
  ] as const) {
    await t.test(change, async (t) => {
      const root = realpathSync.native(
        mkdtempSync(join(tmpdir(), "chief-approval-")),
      );
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const anchor = join(root, "selected");
      const retired = join(root, "retired");
      const replacement = join(root, "replacement");
      mkdirSync(anchor);
      mkdirSync(replacement);
      const target =
        change === "existing" ? anchor : join(anchor, "missing", "project");
      let confirmations = 0;
      const context = fakeContext();
      context.hasUI = true;
      context.ui.confirm = async (_title, message) => {
        confirmations++;
        assert.ok(message.includes(target));
        if (change === "declined") return false;
        renameSync(anchor, retired);
        if (change === "missing symlink")
          symlinkSync(replacement, anchor, "junction");
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
      if (change !== "existing")
        assert.equal(existsSync(dirname(target)), false);
    });
  }
});

test("Chief lifecycle uses one exact Pi conversation and preserves uncertain startup", async (t) => {
  for (const scenario of [
    "lifecycle",
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
  ] as const) {
    await t.test(scenario, async (t) => {
      const root = realpathSync.native(
        mkdtempSync(join(tmpdir(), "chief-project-")),
      );
      const prior = process.env.PI_CODING_AGENT_DIR;
      const agentDir = join(root, "pi");
      const hook = join("extensions", "herdr-agent-state.ts");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      if (scenario !== "missing integration" && scenario !== "optional") {
        mkdirSync(join(agentDir, "extensions"), { recursive: true });
        writeFileSync(
          join(agentDir, hook),
          readFileSync(join(PI_AGENT_ROOT, hook)),
        );
      }
      const gitDirectory = join(root, "project", ".git");
      mkdirSync(gitDirectory, { recursive: true });
      const repository = realpathSync.native(dirname(gitDirectory));
      const canonicalRepoKey = realpathSync.native(gitDirectory);
      const runtime = supervisionRuntime(join(root, "socket"));
      let currentRuntime = runtime;
      const build = { version: "test", sha256: "a".repeat(64) };
      let manager: ManagerLease | undefined;
      t.after(() => {
        if (
          manager &&
          !managerPublished &&
          ["malformed", "foreign"].includes(scenario)
        )
          renameSync(delayedDescriptor, descriptorPath);
        manager?.release();
        rmSync(guardPath, { force: true });
        if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prior;
        rmSync(root, { force: true, recursive: true });
      });
      let tabCreated = false;
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
      const remainingIntents = () =>
        existsSync(intents) ? readdirSync(intents) : [];
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
        writeLeadCoordinationState(runtime, {
          version: 1,
          role: "manager",
          piSessionId,
          build,
          instanceId: randomUUID(),
          updatedAt: Date.now(),
        });
      }
      const response = (result: unknown) => ({
        code: 0,
        stdout: JSON.stringify({ id: 1, result }),
        stderr: "",
      });
      const pi = {
        exec: async (command: string, args: string[]) => {
          if (command === "git")
            return {
              code: 0,
              stdout:
                args.at(-1) === "--show-toplevel"
                  ? repository
                  : canonicalRepoKey,
              stderr: "",
            };
          const operation = args.slice(0, 2).join(" ");
          if (
            ["workspace create", "tab create", "agent start"].includes(
              operation,
            )
          )
            placementCalls.push(operation);
          switch (operation) {
            case "api snapshot":
              return response({
                snapshot: {
                  agents: [],
                  panes: [],
                  workspaces:
                    scenario === "missing integration" ? [] : [workspace],
                },
              });
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
              assert.equal(
                args[args.indexOf("--env") + 1],
                `PI_CODING_AGENT_DIR=${agentDir}`,
              );
              tabCreated = true;
              return response({
                tab: { tab_id: pane.tab_id },
                root_pane: pane,
              });
            case "tab list":
              return response({
                tabs: tabCreated
                  ? [{ workspace_id: pane.workspace_id, tab_id: pane.tab_id }]
                  : [],
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
              assert.equal(args.at(-2), "--session");
              assert.ok(!args.some((arg) => arg.includes("--trust")));
              const path = args.at(-1)!;
              if (expectedHistoryAtLaunch !== undefined)
                assert.equal(
                  readFileSync(path, "utf8"),
                  expectedHistoryAtLaunch,
                );
              const saved = SessionManager.open(path);
              assert.ok(
                existsSync(guardPath),
                "Guard must be published before Herdr launch",
              );
              if (!file) {
                file = path;
                id = saved.getSessionId();
                assert.equal(saved.getCwd(), repository);
                assert.equal(saved.getEntries().length, 0);
                assert.equal(
                  readFileSync(path, "utf8").trim().split("\n").length,
                  1,
                );
                if (process.platform !== "win32")
                  assert.equal(statSync(path).mode & 0o777, 0o600);
                assert.equal(
                  getManagerStartIntent(runtime, id)?.paneId,
                  pane.pane_id,
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
              } else {
                assert.equal(path, file);
                assert.equal(saved.getSessionId(), id);
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
              if (
                ["pending", "old generation", "malformed", "foreign"].includes(
                  scenario,
                )
              ) {
                renameSync(descriptorPath, delayedDescriptor);
                if (scenario === "old generation")
                  writeFileSync(
                    descriptorPath,
                    JSON.stringify({
                      ...manager!.descriptor,
                      claim: { ...manager!.descriptor.claim, id: randomUUID() },
                    }),
                  );
                if (scenario === "malformed")
                  writeFileSync(descriptorPath, "{}");
                if (scenario === "foreign") observedPid++;
                assert.throws(() =>
                  readManagerDescriptorStatus(runtime, canonicalRepoKey),
                );
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
      });
      const ctx = fakeContext();
      const start = () => chief.start(repository, undefined, ctx);
      if (scenario === "missing integration") {
        await assert.rejects(
          start(),
          /Required Herdr Pi integration is missing/,
        );
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
      const first = await (scenario === "uncertain resume"
        ? resume()
        : start());
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
        assert.deepEqual(await start(), { status: "started", repository });
        assert.equal(launches, 2);
        assert.equal(existsSync(guardPath), false);
        return;
      }
      assert.ok(file && id);
      if (scenario === "uncertain" || scenario === "uncertain resume") {
        assert.equal(first.status, "partial_failure");
        assert.equal(existsSync(guardPath), true);
        if (scenario === "uncertain")
          assert.equal(
            getManagerStartIntent(runtime, id)?.paneId,
            pane.pane_id,
          );
        const guardBefore = readFileSync(guardPath, "utf8");
        process.env.PI_CODING_AGENT_DIR = join(root, "other-profile");
        currentRuntime = supervisionRuntime(join(root, "socket"));
        try {
          assert.equal(
            managerDescriptorPath(currentRuntime, canonicalRepoKey) +
              ".unsettled",
            guardPath,
          );
          for (const retry of [start, resume]) {
            const blocked = await retry();
            assert.ok(
              "stage" in blocked && blocked.stage === "unsettled_launch",
            );
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
      assert.deepEqual(first, { status: "started", repository });
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
      });
      assert.equal(readFileSync(file, "utf8"), expectedHistoryAtLaunch);
      assert.deepEqual(await chief.resume(repository, ctx), {
        status: "resumed",
        repository,
      });
      assert.equal(launches, 2);
      assert.equal(existsSync(guardPath), false);
      assert.equal(readFileSync(file, "utf8"), history);
    });
  }
});
