import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { runtimeBuild } from "./compatibility.ts";

mock.module("node:fs", {
  namedExports: {
    constants: realFs.constants,
    ...Object.fromEntries(
      Object.entries(realFs).filter(
        ([name]) => name !== "constants" && name !== "default",
      ),
    ),
    rmdirSync: () => {
      const error = new Error(
        "injected directory pruning failure",
      ) as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    },
    statSync: realFs.statSync,
    unlinkSync: realFs.unlinkSync,
    writeSync: realFs.writeSync,
  },
});

const {
  agentMailboxPath,
  listAgentStates,
  removeAgentMailbox,
  writeAgentState,
} = await import("./mailbox.ts");
const HERDSMAN_BUILD = runtimeBuild(
  packageMetadata.version,
  fileURLToPath(new URL("./index.ts", import.meta.url)),
);

test("state removal completes cleanup when directory pruning fails", () => {
  const path = agentMailboxPath("cleanup-test", `agent-${process.pid}`);
  writeAgentState(path, {
    version: 5,
    build: HERDSMAN_BUILD,
    runId: "11111111-1111-4111-8111-111111111111",
    ownerSessionId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "cleanup-test",
    agentLabel: `agent-${process.pid}`,
    paneId: "p",
    piSessionId: "33333333-3333-4333-8333-333333333333",
    cwd: "/tmp",
    updatedAt: Date.now(),
  });

  assert.doesNotThrow(() => removeAgentMailbox(path));
  assert.equal(realFs.existsSync(join(path, "state.json")), false);
  assert.equal(
    listAgentStates().some((entry) => entry.path === path),
    false,
  );
  realFs.rmdirSync(path);
});
