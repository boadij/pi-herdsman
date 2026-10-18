import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  persistRequiredEvidenceSnapshot,
  readRequiredEvidenceSnapshot,
  requiredEvidenceDirectory,
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

test("required evidence snapshots are private, immutable, and integrity checked", () => {
  const assignmentId = randomUUID();
  const directory = requiredEvidenceDirectory(assignmentId);
  const entry = persistRequiredEvidenceSnapshot(
    assignmentId,
    "plan.md",
    "café\n",
  );
  try {
    assert.equal(entry.name, "plan.md");
    assert.equal(entry.sourceAssignmentId, assignmentId);
    assert.equal(readRequiredEvidenceSnapshot(assignmentId, entry), "café\n");
    assert.equal(entry.path.startsWith(directory), true);
    assert.throws(
      () => readRequiredEvidenceSnapshot(randomUUID(), entry),
      /source assignment mismatch/,
    );
    assert.throws(
      () =>
        readRequiredEvidenceSnapshot(assignmentId, {
          ...entry,
          path: join(directory, "substituted"),
        }),
      /path mismatch/,
    );
    assert.throws(
      () =>
        persistRequiredEvidenceSnapshot(
          assignmentId,
          "large.txt",
          "x".repeat(1024 * 1024 + 1),
        ),
      /no larger than 1 MiB/,
    );
    rmSync(entry.path);
    assert.throws(
      () => readRequiredEvidenceSnapshot(assignmentId, entry),
      /ENOENT/,
    );
    writeFileSync(entry.path, "café\n");
    writeFileSync(entry.path, "changed\n");
    assert.throws(
      () => readRequiredEvidenceSnapshot(assignmentId, entry),
      /integrity check failed/,
    );
    rmSync(entry.path);
    writeFileSync(join(directory, "target"), "target");
    symlinkSync(join(directory, "target"), entry.path);
    assert.throws(
      () => readRequiredEvidenceSnapshot(assignmentId, entry),
      /unsafe/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("required evidence rejects a symlinked assignment directory on write and read", () => {
  const assignmentId = randomUUID();
  const directory = requiredEvidenceDirectory(assignmentId);
  const entry = persistRequiredEvidenceSnapshot(
    assignmentId,
    "plan.md",
    "plan\n",
  );
  const outside = join(
    dirname(herdsmanDataRoot()),
    `evidence-outside-${randomUUID()}`,
  );
  mkdirSync(outside, { mode: 0o700 });
  try {
    rmSync(directory, { recursive: true });
    symlinkSync(outside, directory);
    assert.throws(
      () =>
        persistRequiredEvidenceSnapshot(assignmentId, "review.md", "review\n"),
      /directory is unsafe/,
    );
    assert.throws(
      () => readRequiredEvidenceSnapshot(assignmentId, entry),
      /directory is unsafe/,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
