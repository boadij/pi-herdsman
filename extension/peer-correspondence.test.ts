import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PEER_TRANSPORT_FRAME_LIMIT_BYTES } from "./peer-transport.ts";
import { herdsmanDataRoot } from "./storage.ts";
import {
  acknowledgePeerReply,
  assertPeerDataRoot,
  createPeerCorrespondence,
  finalizePeerCorrespondence,
  listPeerCorrespondences,
  pollPeerReplies,
  peerPayloadDigest,
  queuePeerReply,
  removePeerCorrespondence,
  storePeerCorrespondence,
  updatePeerOriginGeneration,
} from "./peer-correspondence.ts";

const WORKER_DIAGNOSTIC = "HERDSMAN_WORKER:";

function runPeerWorker(
  name: string,
  source: string,
  executable = process.execPath,
  timeout = 8_000,
  onStart?: (terminate: () => void) => void,
  onStderr?: (chunk: string) => void,
  onClose?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let spawnError = false;
    const abortSignal = AbortSignal.timeout(timeout);
    const child = spawn(
      executable,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: process.env,
        signal: abortSignal,
      },
    );
    onStart?.(() => child.kill("SIGTERM"));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
      onStderr?.(chunk);
    });
    child.once("error", (error) => {
      spawnError = !(abortSignal.aborted && error.name === "AbortError");
    });
    child.once("close", (code, signal) => {
      onClose?.();
      if (code === 0 && !spawnError) return resolve();
      let kind = "unclassified";
      const marker = stderr
        .split(/\r?\n/)
        .find((line) => line.startsWith(WORKER_DIAGNOSTIC));
      if (marker) {
        try {
          const diagnostic: unknown = JSON.parse(
            marker.slice(WORKER_DIAGNOSTIC.length),
          );
          if (
            diagnostic &&
            typeof diagnostic === "object" &&
            "kind" in diagnostic &&
            [
              "authorization",
              "lock_verification",
              "filesystem",
              "other",
            ].includes(String(diagnostic.kind))
          )
            kind = String(diagnostic.kind);
        } catch {
          // Malformed child output is never forwarded.
        }
      }
      const ending = spawnError
        ? "spawn_error"
        : abortSignal.aborted
          ? "aborted"
          : signal
            ? `signal ${signal}`
            : `exit ${code}`;
      reject(new Error(`${name} worker ${ending}: ${kind}`));
    });
  });
}

function workerErrorBoundary(operation: string): string {
  return `try { ${operation} } catch (error) {
    const code = ["ENOENT", "EPERM", "EACCES"].includes(error?.code) ? error.code : undefined;
    const kind = error?.message === "peer correspondence authorization failed" ? "authorization" :
      error?.message?.startsWith("Unable to verify peer correspondence mutation") ? "lock_verification" :
      code ? "filesystem" : "other";
    console.error(${JSON.stringify(WORKER_DIAGNOSTIC)} + JSON.stringify({kind, code}));
    process.exitCode = 1;
  }`;
}

test("peer correspondence isolates capability, exact sessions and generations, and finalizes only acknowledged replies", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.equal(c.capability.length, 64);
  assert.equal(
    listPeerCorrespondences().some((item) => item.id === c.id),
    true,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        "0".repeat(64),
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        randomUUID(),
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        randomUUID(),
      ),
    /authorization/,
  );
  const replyId = randomUUID();
  assert.equal(queuePeerReply(c, replyId, "answer"), "queued");
  const recovered = listPeerCorrespondences().find((item) => item.id === c.id)!;
  assert.equal(queuePeerReply(recovered, replyId, "answer"), "duplicate");
  assert.throws(() => queuePeerReply(c, replyId, "changed"), /conflicting/);
  assert.throws(
    () =>
      finalizePeerCorrespondence(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /pending replies/,
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ).map((item) => item.text),
    ["answer"],
  );
  acknowledgePeerReply(
    c.id,
    c.capability,
    replyId,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  acknowledgePeerReply(
    c.id,
    c.capability,
    replyId,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ),
    [],
  );
  finalizePeerCorrespondence(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  finalizePeerCorrespondence(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.equal(
    listPeerCorrespondences().find((item) => item.id === c.id)?.finalized,
    true,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
});

test("correspondence role is validated and immutable with legacy Manager default", () => {
  const manager = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.equal(manager.role, "manager");
  const legacyPath = join(
    herdsmanDataRoot(),
    "runtime",
    "peer-correspondences",
    `${manager.id}.json`,
  );
  const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  delete legacy.role;
  writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`);
  assert.equal(
    listPeerCorrespondences().find((item) => item.id === manager.id)?.role,
    undefined,
  );
  assert.throws(
    () => storePeerCorrespondence({ ...manager, role: "lead" }),
    /conflicting peer correspondence role/,
  );
  assert.doesNotThrow(() => storePeerCorrespondence(manager));

  const lead = createPeerCorrespondence({
    role: "lead",
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.equal(lead.role, "lead");
  assert.throws(
    () => storePeerCorrespondence({ ...lead, role: "manager" }),
    /conflicting peer correspondence role/,
  );
  assert.throws(
    () => storePeerCorrespondence({ ...lead, role: "chief" } as any),
    /invalid peer correspondence/,
  );
  removePeerCorrespondence(manager.id);
  removePeerCorrespondence(lead.id);
});

test("peer origin display metadata validates, persists, and enriches without breaking ID-only records", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.equal(c.originDisplay, undefined);
  assert.throws(
    () =>
      createPeerCorrespondence({
        originSession: randomUUID(),
        originGeneration: randomUUID(),
        recipientSession: randomUUID(),
        recipientGeneration: randomUUID(),
        acceptanceId: randomUUID(),
        originDisplay: { name: "bad\nname" },
      }),
    /invalid peer correspondence/,
  );
  for (const name of [
    "bad\nname",
    "bad\u202Ename",
    "bad\u2066name",
    "bad\u2028name",
  ])
    assert.throws(
      () =>
        createPeerCorrespondence({
          originSession: randomUUID(),
          originGeneration: randomUUID(),
          recipientSession: randomUUID(),
          recipientGeneration: randomUUID(),
          acceptanceId: randomUUID(),
          originDisplay: { name },
        }),
      /invalid peer correspondence/,
    );
  for (const originDisplay of [
    {},
    { name: " " },
    { name: "x".repeat(513) },
    { name: "valid", cwd: "/private/path" },
  ])
    assert.throws(
      () => storePeerCorrespondence({ ...c, originDisplay } as any),
      /invalid peer correspondence/,
    );

  storePeerCorrespondence({
    ...c,
    originDisplay: { name: "Research Manager" },
  });
  storePeerCorrespondence({
    ...c,
    originDisplay: { workspaceLabel: "project-alpha/main" },
  });
  assert.deepEqual(
    listPeerCorrespondences().find((item) => item.id === c.id)?.originDisplay,
    { name: "Research Manager", workspaceLabel: "project-alpha/main" },
  );
  storePeerCorrespondence(c);
  assert.deepEqual(
    listPeerCorrespondences().find((item) => item.id === c.id)?.originDisplay,
    { name: "Research Manager", workspaceLabel: "project-alpha/main" },
  );
  storePeerCorrespondence({
    ...c,
    originDisplay: { name: "Updated Manager" },
  });
  assert.deepEqual(
    listPeerCorrespondences().find((item) => item.id === c.id)?.originDisplay,
    { name: "Updated Manager", workspaceLabel: "project-alpha/main" },
  );
  removePeerCorrespondence(c.id);
});

test("same exact session may explicitly recover a changed generation, but mismatched generations cannot poll", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        randomUUID(),
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        randomUUID(),
      ),
    /authorization/,
  );
  const recovered = updatePeerOriginGeneration(
    c.id,
    c.capability,
    c.originSession,
    c.originGeneration,
    randomUUID(),
  );
  assert.deepEqual(
    updatePeerOriginGeneration(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      recovered.originGeneration,
    ),
    recovered,
  );
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      recovered.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ),
    [],
  );
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        c.capability,
        randomUUID(),
        c.originGeneration,
        recovered.originGeneration,
      ),
    /rejected/,
  );
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        c.capability,
        c.originSession,
        randomUUID(),
        randomUUID(),
      ),
    /rejected/,
  );
  assert.throws(
    () =>
      pollPeerReplies(
        c.id,
        c.capability,
        c.originSession,
        "wrong-generation",
        c.recipientSession,
        c.recipientGeneration,
      ),
    /authorization/,
  );
  assert.equal(recovered.originSession, c.originSession);
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        "0".repeat(64),
        c.originSession,
        recovered.originGeneration,
        randomUUID(),
      ),
    /rejected/,
  );
  finalizePeerCorrespondence(
    c.id,
    c.capability,
    c.originSession,
    recovered.originGeneration,
    c.recipientSession,
    c.recipientGeneration,
  );
  assert.throws(
    () =>
      updatePeerOriginGeneration(
        c.id,
        c.capability,
        c.originSession,
        recovered.originGeneration,
        randomUUID(),
      ),
    /rejected/,
  );
  removePeerCorrespondence(c.id);
});

test("peer endpoint state-root mismatch fails closed", () => {
  assert.doesNotThrow(() => assertPeerDataRoot("/same/root", "/same/root"));
  assert.throws(
    () => assertPeerDataRoot("/manager/root", "/endpoint/root"),
    /data root/,
  );
});

test("peer payload digests canonicalize object key order", () => {
  assert.equal(
    peerPayloadDigest({ a: 1, nested: { x: "v", y: true } }),
    peerPayloadDigest({ nested: { y: true, x: "v" }, a: 1 }),
  );
  assert.notEqual(peerPayloadDigest({ a: 1 }), peerPayloadDigest({ a: 2 }));
});

test("acknowledgment compacts evidence while preserving reply duplicate protection", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const payloads = Array.from({ length: 2 }, (_, index) => {
    const text = `reply ${index}`;
    const attachmentText = `evidence ${index}`;
    const attachments = [
      {
        name: `evidence-${index}.txt`,
        marker: `marker-${index}`,
        text: attachmentText,
        sha256: createHash("sha256").update(attachmentText).digest("hex"),
      },
    ];
    const resultBindings = [
      {
        ref: `result:reviewer#${index + 1}`,
        canonicalRef: `result:${randomUUID()}`,
      },
    ];
    return { id: randomUUID(), text, attachments, resultBindings };
  });
  for (const payload of payloads)
    queuePeerReply(c, payload.id, payload.text, payload);
  const digests = payloads.map((payload) =>
    peerPayloadDigest({
      text: payload.text,
      attachments: payload.attachments,
      resultBindings: payload.resultBindings,
    }),
  );
  for (const payload of payloads)
    acknowledgePeerReply(
      c.id,
      c.capability,
      payload.id,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    );

  const compacted = listPeerCorrespondences().find((item) => item.id === c.id)!;
  assert.deepEqual(
    compacted.replies.map(
      ({ id, digest, text, acknowledged, attachments, resultBindings }) => ({
        id,
        digest,
        text,
        acknowledged,
        attachments,
        resultBindings,
      }),
    ),
    payloads.map((payload, index) => ({
      id: payload.id,
      digest: digests[index],
      text: "",
      acknowledged: true,
      attachments: undefined,
      resultBindings: undefined,
    })),
  );
  for (const payload of payloads) {
    assert.equal(
      queuePeerReply(compacted, payload.id, payload.text, payload),
      "duplicate",
    );
    assert.throws(
      () =>
        queuePeerReply(
          compacted,
          payload.id,
          `${payload.text} changed`,
          payload,
        ),
      /conflicting peer reply identity/,
    );
  }
  removePeerCorrespondence(c.id);
});

test("reply polling bounds full serialized envelopes and drains replies in order", () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  assert.throws(
    () =>
      queuePeerReply(
        c,
        randomUUID(),
        "x".repeat(PEER_TRANSPORT_FRAME_LIMIT_BYTES - 100),
      ),
    /response limit/,
  );
  const ids = Array.from({ length: 20 }, () => randomUUID());
  for (const id of ids) queuePeerReply(c, id, '"'.repeat(120 * 1024));
  let drained: string[] = [];
  while (drained.length < ids.length) {
    const batch = pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    );
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          dataRoot: herdsmanDataRoot(),
          replies: batch,
          hasReplies: true,
        }),
      ) <=
        2 * 1024 * 1024,
    );
    assert.ok(batch.length > 0);
    for (const reply of batch) {
      drained.push(reply.id);
      acknowledgePeerReply(
        c.id,
        c.capability,
        reply.id,
        c.originSession,
        c.originGeneration,
        c.recipientSession,
        c.recipientGeneration,
      );
    }
  }
  assert.deepEqual(drained, ids);
  assert.deepEqual(
    pollPeerReplies(
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ),
    [],
  );
  removePeerCorrespondence(c.id);
});

test("independent processes preserve concurrent reply acknowledgment and enqueue", async () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  const acknowledgedId = randomUUID();
  const queuedId = randomUUID();
  try {
    queuePeerReply(c, acknowledgedId, "existing");
    const args = JSON.stringify([
      c.id,
      c.capability,
      c.originSession,
      c.originGeneration,
      c.recipientSession,
      c.recipientGeneration,
    ]);
    const scripts = [
      workerErrorBoundary(
        `const {acknowledgePeerReply} = await import('./extension/peer-correspondence.ts'); const [id,cap,os,og,rs,rg] = ${args}; acknowledgePeerReply(id,cap,${JSON.stringify(acknowledgedId)},os,og,rs,rg);`,
      ),
      workerErrorBoundary(
        `const {queuePeerReply} = await import('./extension/peer-correspondence.ts'); const [id] = ${args}; queuePeerReply({id},${JSON.stringify(queuedId)},'concurrent');`,
      ),
    ];
    const results = await Promise.allSettled([
      runPeerWorker("acknowledge", scripts[0]!),
      runPeerWorker("enqueue", scripts[1]!),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const current = listPeerCorrespondences().find((item) => item.id === c.id)!;
    assert.equal(
      current.replies.find((reply) => reply.id === acknowledgedId)
        ?.acknowledged,
      true,
    );
    assert.equal(
      current.replies.find((reply) => reply.id === queuedId)?.text,
      "concurrent",
    );
  } finally {
    removePeerCorrespondence(c.id);
  }
});

test("peer worker failures wait for running siblings and clean up after propagation", async () => {
  const c = createPeerCorrespondence({
    originSession: randomUUID(),
    originGeneration: randomUUID(),
    recipientSession: randomUUID(),
    recipientGeneration: randomUUID(),
    acceptanceId: randomUUID(),
  });
  let terminateSibling: (() => void) | undefined;
  const workers: Promise<void>[] = [];
  let markSiblingReady!: () => void;
  let markSiblingClosed!: () => void;
  const siblingReady = new Promise<void>(
    (resolve) => (markSiblingReady = resolve),
  );
  const siblingClosed = new Promise<void>(
    (resolve) => (markSiblingClosed = resolve),
  );
  let readinessOutput = "";
  try {
    const sibling = runPeerWorker(
      "sibling",
      `console.error('SIBLING_READY'); setInterval(() => {}, 1000);`,
      process.execPath,
      8_000,
      (terminate) => {
        terminateSibling = terminate;
      },
      (chunk) => {
        readinessOutput = (readinessOutput + chunk).slice(-256);
        if (readinessOutput.includes("SIBLING_READY")) markSiblingReady();
      },
      markSiblingClosed,
    );
    workers.push(sibling);
    await Promise.race([
      siblingReady,
      siblingClosed.then(async () => {
        await sibling;
        throw new Error("sibling closed before readiness");
      }),
    ]);
    const failure = runPeerWorker(
      "broken",
      `console.error(${JSON.stringify(WORKER_DIAGNOSTIC)} + '{bad'); console.error('/private/path secret-capability'); process.exit(1);`,
    );
    workers.push(failure);
    await assert.rejects(failure, (error: unknown) => {
      const message = String(error);
      assert.match(message, /broken worker exit 1: unclassified/);
      assert.doesNotMatch(message, /\/private\/path|secret-capability/);
      return true;
    });
    terminateSibling();
    const outcomes = await Promise.allSettled(workers);
    assert.equal(outcomes[1]?.status, "rejected");
    assert.match(
      String(outcomes[0]?.status === "rejected" && outcomes[0].reason),
      /sibling worker signal SIGTERM: unclassified/,
    );
  } finally {
    terminateSibling?.();
    await Promise.allSettled(workers);
    removePeerCorrespondence(c.id);
  }
  assert.equal(
    listPeerCorrespondences().some((item) => item.id === c.id),
    false,
  );
});

test("peer worker reports cancellation and spawn errors only after close", async () => {
  await assert.rejects(
    runPeerWorker(
      "cancelled",
      "setInterval(() => {}, 1000)",
      process.execPath,
      100,
    ),
    /cancelled worker aborted/,
  );
  await assert.rejects(
    runPeerWorker("missing", "", "herdsman-no-such-worker"),
    /missing worker spawn_error: unclassified/,
  );
  await assert.rejects(
    runPeerWorker("silent", "process.exitCode = 1"),
    /silent worker exit 1: unclassified/,
  );
});
