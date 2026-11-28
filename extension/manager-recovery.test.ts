import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { durableManagerRecoveryReference } from "./lead-runtime.ts";
import "./support.ts";
import { ProcessLockOccupiedError } from "./lock.ts";
import {
  claimManagerLease,
  claimManagerStartupLock,
  consumeManagerStartIntent,
  getManagerStartIntent,
  readManagerRecoveryReference,
  removeManagerRecoveryReference,
  removeManagerStartIntent,
  writeManagerRecoveryReference,
  writeManagerStartIntent,
  type ManagerDescriptor,
  supervisionRuntime,
} from "./supervision.ts";

function setup(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "manager-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ...supervisionRuntime(randomUUID()),
    root,
    managerRecovery: join(root, "manager-recovery"),
  };
}

test("recovery removal compares the repository and both parts of exact Pi identity", (t) => {
  const runtime = setup(t);
  const reference = {
    version: 1 as const,
    canonicalRepoKey: join(runtime.root, ".git"),
    piSessionId: randomUUID(),
    piSessionFile: join(runtime.root, "manager.jsonl"),
  };
  assert.equal(readManagerRecoveryReference(runtime, reference.canonicalRepoKey), undefined);
  writeManagerRecoveryReference(runtime, reference);
  assert.equal(
    removeManagerRecoveryReference(runtime, {
      ...reference,
      piSessionId: randomUUID(),
    }),
    false,
  );
  assert.equal(
    removeManagerRecoveryReference(runtime, {
      ...reference,
      piSessionFile: join(runtime.root, "other.jsonl"),
    }),
    false,
  );
  assert.deepEqual(readManagerRecoveryReference(runtime, reference.canonicalRepoKey), reference);
  assert.equal(removeManagerRecoveryReference(runtime, reference), true);
  assert.equal(removeManagerRecoveryReference(runtime, reference), false);

  writeManagerRecoveryReference(runtime, reference);
  const key = createHash("sha256").update(reference.canonicalRepoKey).digest("hex");
  writeFileSync(
    join(runtime.root, "manager-recovery", key + ".json"),
    JSON.stringify({
      ...reference,
      canonicalRepoKey: join(runtime.root, "wrong.git"),
    }),
  );
  assert.throws(
    () => readManagerRecoveryReference(runtime, reference.canonicalRepoKey),
    /invalid Manager recovery reference/i,
  );
  assert.throws(
    () => writeManagerRecoveryReference(runtime, reference),
    /invalid Manager recovery reference/i,
  );
});

test("startup intents are exact, one-shot, and reject invalid or expired state", (t) => {
  const runtime = setup(t);
  const intent = {
    version: 1 as const,
    sessionId: randomUUID(),
    canonicalRepoKey: join(runtime.root, ".git"),
    checkoutPath: runtime.root,
    workspaceId: "workspace",
    paneId: "pane",
    createdAt: Date.now(),
  };
  writeManagerStartIntent(runtime, intent);
  assert.throws(() => writeManagerStartIntent(runtime, intent), /already exists/);
  assert.equal(getManagerStartIntent(runtime, randomUUID()), undefined);
  assert.throws(
    () => consumeManagerStartIntent(runtime, { ...intent, paneId: "other" }),
    /changed/,
  );
  assert.deepEqual(getManagerStartIntent(runtime, intent.sessionId), intent);
  consumeManagerStartIntent(runtime, intent);
  assert.equal(getManagerStartIntent(runtime, intent.sessionId), undefined);
  assert.throws(() => consumeManagerStartIntent(runtime, intent), /changed/);
  assert.equal(removeManagerStartIntent(runtime, intent.sessionId), false);

  writeManagerStartIntent(runtime, intent);
  const key = createHash("sha256").update(intent.sessionId).digest("hex");
  const record = join(runtime.root, "manager-start-intents", key + ".json");
  writeFileSync(record, JSON.stringify({ ...intent, createdAt: 0 }));
  assert.throws(() => consumeManagerStartIntent(runtime, intent), /expired/);
  assert.equal(removeManagerStartIntent(runtime, intent.sessionId), true);
  writeManagerStartIntent(runtime, intent);
  writeFileSync(record, "{broken");
  assert.throws(() => getManagerStartIntent(runtime, intent.sessionId), SyntaxError);
});

test("the Chief startup mutex does not hold the Manager supervision lease", (t) => {
  const runtime = setup(t);
  const canonicalRepoKey = join(runtime.root, ".git");
  const startup = claimManagerStartupLock(runtime, canonicalRepoKey);
  t.after(() => startup.release());
  assert.throws(() => claimManagerStartupLock(runtime, canonicalRepoKey), ProcessLockOccupiedError);
  const manager = claimManagerLease(
    {
      build: { version: "test", sha256: "a".repeat(64) },
      piSessionId: randomUUID(),
      repoKey: runtime.root,
      canonicalRepoKey,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
    },
    runtime,
  );
  manager.release();
});

test("Pi's buffered role is not durable, and recovery verifies exact disk identity and role", (t) => {
  const runtime = setup(t);
  const session = SessionManager.create(runtime.root, runtime.root);
  const piSessionId = session.getSessionId();
  const piSessionFile = session.getSessionFile()!;
  const canonicalRepoKey = join(runtime.root, ".git");
  const descriptor = {
    canonicalRepoKey,
    piSessionId,
    piSessionFile,
  } as ManagerDescriptor;
  session.appendCustomEntry("pi-herdsman-role", {
    sessionId: piSessionId,
    role: "manager",
    leadTools: [],
  });
  assert.equal(durableManagerRecoveryReference(descriptor, runtime.root), undefined);
  // Simulate Pi persisting a genuine user's first conversation message.
  session.appendMessage({
    role: "user",
    content: "Check project state",
    timestamp: Date.now(),
  });
  const before = readFileSync(piSessionFile, "utf8");
  assert.deepEqual(durableManagerRecoveryReference(descriptor, runtime.root), {
    version: 1,
    canonicalRepoKey,
    piSessionId,
    piSessionFile,
  });
  assert.equal(readFileSync(piSessionFile, "utf8"), before);
  assert.throws(
    () =>
      durableManagerRecoveryReference({ ...descriptor, piSessionId: randomUUID() }, runtime.root),
    /does not match/,
  );
  session.appendCustomEntry("pi-herdsman-role", {
    sessionId: piSessionId,
    role: "lead",
    leadTools: [],
  });
  assert.throws(
    () => durableManagerRecoveryReference(descriptor, runtime.root),
    /expected manager role/,
  );
});
