import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gitRepositoryScope } from "./herdr.ts";
import { acquireProcessLock } from "./lock.ts";
import { requireNoLiveLegacyManager } from "./manager-git.ts";
import { listManagerDescriptors, supervisionRuntime } from "./supervision.ts";

test("live workspace-keyed legacy authority blocks only a correlated repository", async (t) => {
  const account = os.userInfo();
  const root = mkdtempSync(join(tmpdir(), "manager-legacy-"));
  t.mock.method(os, "userInfo", () => ({ ...account, homedir: root }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pi: Pick<ExtensionAPI, "exec"> = {
    async exec(command, args, options) {
      const result = spawnSync(command, args, {
        cwd: options?.cwd,
        encoding: "utf8",
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.status ?? -1,
        killed: !!result.signal,
        truncated: false,
      };
    },
  };
  const primary = join(root, "primary");
  const other = join(root, "other");
  for (const checkout of [primary, other]) {
    mkdirSync(checkout);
    const result = await pi.exec("git", ["init"], { cwd: checkout });
    assert.equal(result.code, 0, result.stderr);
  }
  const sessionId = randomUUID();
  const sessionFile = join(root, "legacy.jsonl");
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "session", id: sessionId, cwd: primary }) + "\n",
  );
  const workspaceId = "legacy-workspace";
  const runtime = supervisionRuntime(join(root, "calling.socket"));
  const foreign = supervisionRuntime(join(root, "legacy.socket"));
  t.after(() => {
    rmSync(runtime.root, { recursive: true, force: true });
    rmSync(foreign.root, { recursive: true, force: true });
  });
  const managers = join(runtime.root, "managers");
  const descriptorPath = join(
    managers,
    createHash("sha256").update(workspaceId).digest("hex") + ".json",
  );
  const lock = acquireProcessLock(descriptorPath + ".lock");
  try {
    const targetKey = realpathSync.native(join(primary, ".git"));
    await assert.rejects(
      requireNoLiveLegacyManager(pi, runtime, targetKey, workspaceId),
      /legacy Manager authority.*restart/,
    );
    writeFileSync(
      descriptorPath,
      JSON.stringify({
        version: 1,
        claim: lock.claim,
        leaseId: randomUUID(),
        piSessionId: sessionId,
        piSessionFile: sessionFile,
        workspaceId,
        paneId: "legacy-pane",
        tabId: "legacy-tab",
        repoKey: join(root, "obsolete-repository-path"),
        createdAt: 1,
      }),
    );
    const targetScope = await gitRepositoryScope(pi, primary);
    assert.equal(targetScope.canonicalRepoKey, targetKey);
    await assert.rejects(
      requireNoLiveLegacyManager(pi, runtime, targetScope.canonicalRepoKey, "different-workspace"),
      /legacy Manager authority.*restart/,
    );
    lock.release();
    const legacy = JSON.parse(readFileSync(descriptorPath, "utf8"));
    const otherScope = await gitRepositoryScope(pi, other);
    const alternateKey = join(realpathSync.native(root), "legacy-common");
    symlinkSync(targetKey, alternateKey, process.platform === "win32" ? "junction" : "dir");
    for (const oldKey of [workspaceId, targetKey, alternateKey]) {
      const foreignPath = join(
        foreign.root,
        "managers",
        createHash("sha256").update(oldKey).digest("hex") + ".json",
      );
      const foreignLock = acquireProcessLock(foreignPath + ".lock");
      try {
        writeFileSync(
          foreignPath,
          JSON.stringify({
            ...legacy,
            claim: foreignLock.claim,
            ...(oldKey !== workspaceId
              ? { canonicalRepoKey: oldKey, piSessionFile: undefined }
              : {}),
          }),
        );
        await assert.rejects(
          requireNoLiveLegacyManager(pi, runtime, targetKey, "different-workspace"),
          /legacy Manager authority.*restart/,
        );
        await requireNoLiveLegacyManager(pi, runtime, otherScope.canonicalRepoKey, workspaceId);
      } finally {
        foreignLock.release();
      }
    }
    const defaultProfileManagers = join(
      root,
      ".pi",
      "agent",
      "pi-herdsman",
      "runtime",
      "manager-authority-v1",
      "managers",
    );
    const oldRepoPath = join(
      defaultProfileManagers,
      createHash("sha256").update(targetKey).digest("hex") + ".json",
    );
    const oldStartup = acquireProcessLock(oldRepoPath + ".startup.lock");
    try {
      await assert.rejects(
        requireNoLiveLegacyManager(pi, runtime, targetKey),
        /legacy Manager authority/,
      );
      await requireNoLiveLegacyManager(pi, runtime, otherScope.canonicalRepoKey);
    } finally {
      oldStartup.release();
    }
    writeFileSync(oldRepoPath + ".unsettled", "prior launch evidence");
    await assert.rejects(
      requireNoLiveLegacyManager(pi, runtime, targetKey),
      /legacy Manager authority/,
    );
    assert.equal(readFileSync(oldRepoPath + ".unsettled", "utf8"), "prior launch evidence");
    unlinkSync(oldRepoPath + ".unsettled");
    assert.deepEqual(listManagerDescriptors(runtime, true), []);
  } finally {
    lock.release();
  }
  await requireNoLiveLegacyManager(
    pi,
    runtime,
    realpathSync.native(join(primary, ".git")),
    workspaceId,
  );
});
