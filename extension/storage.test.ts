import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
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
  reserveSemanticResultRef,
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
    join(root, "runtime", "mailboxes-v5"),
  );
  assert.equal(
    dirname(supervisionRuntime("socket with spaces").root),
    join(root, "runtime", "supervision-v2"),
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

test("semantic result refs are uniquely reserved across independent allocations", () => {
  const label = `globalref-${randomUUID().slice(0, 8)}`;
  const directory = join(herdsmanDataRoot(), "result-ref-reservations", label);
  try {
    const first = reserveSemanticResultRef(label, 1);
    const second = reserveSemanticResultRef(label, 1);
    assert.deepEqual(first, { ref: `result:${label}#1`, index: 1 });
    assert.deepEqual(second, { ref: `result:${label}#2`, index: 2 });
    assert.equal(reserveSemanticResultRef(label, 17).index, 17);
    assert.equal(reserveSemanticResultRef(label, 2).index, 18);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
