import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";

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

test("state removal completes cleanup when directory pruning fails", () => {
  const path = agentMailboxPath("cleanup-test", `agent-${process.pid}`);
  writeAgentState(path, {
    version: 4,
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
