import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import test from "node:test";
import { agentMailboxPath } from "./mailbox.ts";
import { supervisionRuntime } from "./supervision.ts";
import {
  herdsmanDataRoot,
  herdsmanConfigPath,
  herdsmanTempRoot,
  resolveResultRef,
  resultPath,
  resultRef,
} from "./storage.ts";

test("recoverable Herdsman state lives under Pi agent data", () => {
  const root = join(getAgentDir(), "pi-herdsman");
  assert.equal(herdsmanDataRoot(), root);
  assert.equal(herdsmanConfigPath(), join(root, "config.json"));
  assert.equal(
    dirname(resultPath("550e8400-e29b-41d4-a716-446655440000")),
    join(root, "results"),
  );
  assert.equal(
    dirname(agentMailboxPath("workspace", "agent")),
    join(root, "runtime", "mailboxes-v4"),
  );
  assert.equal(
    dirname(supervisionRuntime("socket with spaces").root),
    join(root, "runtime", "supervision"),
  );
  assert.notEqual(herdsmanTempRoot().startsWith(root), true);
});

test("result references use canonical request UUIDs", () => {
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const ref = resultRef(requestId);
  assert.equal(ref, `result:${requestId}`);
  assert.equal(resolveResultRef(ref), resultPath(requestId));
  for (const input of [
    "result:",
    "result:not-a-uuid",
    "result:../../file",
    "result:550e8400-e29b-41d4-a716-44665544000",
    "result:550E8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.throws(() => resolveResultRef(input));
  }
  assert.equal(resolveResultRef("ordinary.txt"), undefined);
});
