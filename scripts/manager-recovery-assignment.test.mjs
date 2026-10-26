import assert from "node:assert/strict";
import test from "node:test";
import { assertManagerRecoveryAssignment } from "./manager-recovery-assignment.mjs";

test("manager recovery assignment contract accepts verified checkout provenance", () => {
  const assignment = {
    version: 2,
    id: "session-id",
    repoKey: "/repo/.git",
    branch: "project-branch",
    text: "project intent",
    checkoutPath: "/repo/worktree",
    piSessionFile: "/sessions/lead.jsonl",
  };
  assert.doesNotThrow(() => assertManagerRecoveryAssignment(assignment));
  assert.throws(() =>
    assertManagerRecoveryAssignment({ ...assignment, unexpected: true }),
  );
});
