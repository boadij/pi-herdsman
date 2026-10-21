import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  reserveSemanticEvidenceRef,
  semanticEvidenceRef,
  upgradeRequiredEvidence,
  upgradeAndVerifyRequiredEvidence,
  verifySemanticEvidenceReservation,
  isRequiredEvidence,
  isCanonicalSemanticEvidenceRef,
  persistRequiredEvidenceSnapshot,
  readRequiredEvidenceSnapshot,
  requiredEvidenceDirectory,
  nodeOnlyAgentDir,
  persistPeerAttachment,
  persistPeerResultArtifact,
} from "./storage.ts";

test("Node-only agent directory resolution matches Pi 1.3.0", () => {
  const original = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(nodeOnlyAgentDir(), getAgentDir());
    for (const override of [
      join(tmpdir(), `pi-agent-${randomUUID()}`),
      "~/pi-agent",
      pathToFileURL(join(tmpdir(), `pi-agent-${randomUUID()}`)).href,
      "relative-agent-dir",
      process.platform === "win32" ? "/c/temp/pi-agent" : "C:\\temp\\pi-agent",
    ]) {
      process.env.PI_CODING_AGENT_DIR = override;
      assert.equal(nodeOnlyAgentDir(), getAgentDir(), override);
    }
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
});

test("peer evidence is immutable and result identities cannot be rebound", () => {
  const attachment = persistPeerAttachment("spec.md", "specification\n");
  assert.equal(readFileSync(attachment, "utf8"), "specification\n");
  assert.equal(persistPeerAttachment("spec.md", "specification\n"), attachment);
  assert.throws(
    () => persistPeerAttachment("../escape", "unsafe"),
    /invalid peer attachment/,
  );

  const canonicalRef = resultRef(randomUUID());
  const result = persistPeerResultArtifact(canonicalRef, "result\n");
  assert.equal(readFileSync(result, "utf8"), "result\n");
  assert.throws(
    () => persistPeerResultArtifact(canonicalRef, "different result\n"),
    /identity collision/,
  );
});

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

test("semantic evidence refs are stable, collision-safe, and separate from result refs", () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const name = `review-${firstId.slice(0, 8)}.md`;
  const label = name.slice(0, -3);
  const first = reserveSemanticEvidenceRef(firstId, name);
  const second = reserveSemanticEvidenceRef(secondId, name);
  try {
    assert.equal(first, `evidence:${label}#1`);
    assert.equal(second, `evidence:${label}#2`);
    assert.equal(reserveSemanticEvidenceRef(firstId, "renamed.md"), first);
    assert.equal(
      semanticEvidenceRef({
        id: firstId,
        name: "review.md",
        result: {
          ref: "result:reviewer#1",
          canonicalRef: "result:550e8400-e29b-41d4-a716-446655440000",
        },
      }),
      "result:reviewer#1",
    );
    for (const ref of [
      "evidence:Review#1",
      "evidence:review#0",
      "evidence:review#01",
      "evidence:review#9007199254740992",
    ]) {
      assert.equal(isCanonicalSemanticEvidenceRef(ref), false);
    }
    assert.equal(isCanonicalSemanticEvidenceRef(first), true);
  } finally {
    const root = join(herdsmanDataRoot(), "evidence-ref-reservations");
    rmSync(join(root, "by-id", firstId), { force: true });
    rmSync(join(root, "by-id", secondId), { force: true });
    rmSync(join(root, "refs", label), { recursive: true, force: true });
  }
});

test("semantic evidence reservation verification is read-only and checks both directions", () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = reserveSemanticEvidenceRef(firstId, "reserved-one.md");
  const second = reserveSemanticEvidenceRef(secondId, "reserved-two.md");
  assert.doesNotThrow(() => verifySemanticEvidenceReservation(firstId, first));
  assert.throws(() =>
    verifySemanticEvidenceReservation(randomUUID(), "evidence:forged#1"),
  );
  assert.throws(() => verifySemanticEvidenceReservation(firstId, second));
  const forged = {
    id: randomUUID(),
    ref: "evidence:unreserved#1",
    name: "forged.md",
    sourceAssignmentId: randomUUID(),
    path: "/private/forged",
    sha256: "a".repeat(64),
  };
  assert.throws(() => upgradeAndVerifyRequiredEvidence(forged));
  const root = join(herdsmanDataRoot(), "evidence-ref-reservations");
  rmSync(join(root, "by-id", firstId), { force: true });
  assert.throws(() => verifySemanticEvidenceReservation(firstId, first));
  rmSync(join(root, "by-id", secondId), { force: true });
  rmSync(join(root, "refs", "reserved-one"), { recursive: true, force: true });
  rmSync(join(root, "refs", "reserved-two"), { recursive: true, force: true });
});

test("legacy snapshot records remain valid and upgrade without changing provenance", () => {
  const assignmentId = randomUUID();
  const name = `plan-${assignmentId.slice(0, 8)}.md`;
  const entry = persistRequiredEvidenceSnapshot(assignmentId, name, "plan\n");
  try {
    const { ref: _ref, ...legacy } = entry;
    assert.equal(isRequiredEvidence(legacy), true);
    const upgraded = upgradeRequiredEvidence(legacy);
    assert.equal(upgraded.id, legacy.id);
    assert.equal(upgraded.name, legacy.name);
    assert.equal("result" in upgraded, false);
    if ("result" in upgraded) assert.fail("expected snapshot");
    assert.equal(upgraded.path, legacy.path);
    assert.equal(upgraded.sha256, legacy.sha256);
    assert.equal(upgraded.sourceAssignmentId, assignmentId);
    assert.equal(
      upgraded.ref,
      reserveSemanticEvidenceRef(legacy.id, legacy.name),
    );
    assert.equal(
      readRequiredEvidenceSnapshot(assignmentId, upgraded),
      "plan\n",
    );
    assert.equal(upgradeRequiredEvidence(legacy).ref, upgraded.ref);
  } finally {
    rmSync(requiredEvidenceDirectory(assignmentId), {
      recursive: true,
      force: true,
    });
    const root = join(herdsmanDataRoot(), "evidence-ref-reservations");
    rmSync(join(root, "by-id", entry.id), { force: true });
    rmSync(join(root, "refs", name.slice(0, -3)), {
      recursive: true,
      force: true,
    });
  }
});

test("required evidence accepts only exact legacy, semantic, and result record shapes", () => {
  const assignmentId = randomUUID();
  const name = `shape-${assignmentId.slice(0, 8)}.md`;
  const label = name.slice(0, -3);
  const snapshot = persistRequiredEvidenceSnapshot(assignmentId, name, "body");
  const { ref: _ref, ...legacy } = snapshot;
  const result = {
    id: randomUUID(),
    name: "prior result",
    result: {
      ref: "result:reviewer#1",
      canonicalRef: "result:550e8400-e29b-41d4-a716-446655440000",
    },
  };
  try {
    assert.equal(isRequiredEvidence(legacy), true);
    assert.equal(isRequiredEvidence(snapshot), true);
    assert.equal(isRequiredEvidence(result), true);
    assert.equal(isRequiredEvidence({ ...legacy, extra: true }), false);
    assert.equal(isRequiredEvidence({ ...snapshot, extra: true }), false);
    assert.equal(isRequiredEvidence({ ...snapshot, ref: undefined }), false);
    assert.equal(
      isRequiredEvidence({ ...legacy, ref: "evidence:shape#1" }),
      true,
    );
    assert.equal(
      isRequiredEvidence({ ...legacy, ref: "evidence:shape#01" }),
      false,
    );
    assert.equal(isRequiredEvidence({ ...result, extra: true }), false);
    assert.equal(
      isRequiredEvidence({
        ...result,
        canonicalRef: "result:550e8400-e29b-41d4-a716-446655440000",
      }),
      false,
    );
  } finally {
    rmSync(requiredEvidenceDirectory(assignmentId), {
      recursive: true,
      force: true,
    });
    const root = join(herdsmanDataRoot(), "evidence-ref-reservations");
    rmSync(join(root, "by-id", snapshot.id), { force: true });
    rmSync(join(root, "refs", label), { recursive: true, force: true });
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
