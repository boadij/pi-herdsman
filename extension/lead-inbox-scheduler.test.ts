import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadInboxRuntime } from "./lead-runtime.ts";
import { fakeContext } from "./support.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test("Manager peer reconciliation is automatic, fixed-cadence, and single-flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/unused-scheduler-test-socket";

  let attempts = 0;
  let activeReconciliations = 0;
  let maxActiveReconciliations = 0;
  let abortedReconciliations = 0;
  const diagnostics: unknown[] = [];
  const pending: ReturnType<typeof deferred<unknown>>[] = [];
  const context = fakeContext();
  const runtime = createLeadInboxRuntime({
    leadRuntime: {
      chiefMode: "inactive",
      sessionGeneration: 0,
      chiefModeGeneration: 0,
    },
    activeRole: () => "manager",
    controllerScope: { kind: "root" },
    supervisionRuntime: () => ({}),
    peerRuntime: () => ({}),
    pi: {},
    managerDiagnostic: (...args: unknown[]) => diagnostics.push(args),
    managerDiagnosticEvents: new Set(),
    listChiefMessagePaths: () => [],
    drainCoordinationInbox: async () => 0,
    currentPeerPresenceValid: async () => false,
    drainProjectMessages: async () => 0,
    reconcileRemotePeers: (_ctx: unknown, signal?: AbortSignal) => {
      attempts++;
      if (attempts === 1)
        return Promise.resolve({
          details: { unavailable_machines: ["offline-peer"] },
        });
      const request = deferred<unknown>();
      pending.push(request);
      activeReconciliations++;
      maxActiveReconciliations = Math.max(
        maxActiveReconciliations,
        activeReconciliations,
      );
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          activeReconciliations--;
          complete();
        };
        const abort = () => {
          abortedReconciliations++;
          finish(() => reject(signal?.reason ?? new Error("aborted")));
        };
        signal?.addEventListener("abort", abort, { once: true });
        request.promise.then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      });
    },
  } as any);

  const start = async () => {
    runtime.start(context as any);
    await flush();
  };
  const tick = async (ms: number) => {
    while (ms > 0) {
      const step = Math.min(ms, 500);
      t.mock.timers.tick(step);
      await flush();
      ms -= step;
    }
  };

  try {
    runtime.beginSession();
    await start();
    await tick(500);
    assert.equal(
      attempts,
      1,
      "Manager starts reconciliation without list_peers",
    );
    await flush();
    await tick(9_500);
    assert.equal(
      attempts,
      1,
      "partial unavailable discovery is not a failure backoff",
    );
    await tick(500);
    assert.equal(
      attempts,
      2,
      "the next attempt follows the fixed 10-second cadence",
    );

    // Keep the second attempt in flight past its nominal deadline. Timer ticks
    // must neither overlap it nor start its successor before completion+10s.
    await tick(20_000);
    assert.equal(attempts, 2, "a long reconciliation remains single-flight");
    const failedAt = Date.now();
    pending[0]!.reject(new Error("temporary SSH failure"));
    await flush();
    assert.ok(
      diagnostics.some((entry) =>
        JSON.stringify(entry).includes("remote_reconciliation"),
      ),
      "genuine failures retain their diagnostic",
    );
    await tick(9_500);
    assert.equal(attempts, 2);
    await tick(500);
    assert.equal(
      attempts,
      3,
      "an exception retries after 10 seconds, not exponential backoff",
    );

    // A slow successful request sets its deadline from settlement, not start.
    await tick(20_000);
    assert.equal(attempts, 3);
    const completedAt = Date.now();
    pending[1]!.resolve({
      details: { unavailable_machines: ["still-offline"] },
    });
    await flush();
    assert.ok(Date.now() - failedAt >= 20_000);
    await tick(9_999);
    assert.equal(attempts, 3);
    await tick(1);
    assert.equal(
      attempts,
      4,
      "next attempt starts exactly 10 seconds after completion",
    );
    assert.ok(Date.now() - completedAt >= 10_000);

    // Completing an attempt creates a future deadline. A new session must
    // discard it and poll on its first timer tick.
    await tick(500);
    assert.equal(attempts, 4);
    pending[2]!.resolve({});
    await flush();
    runtime.beginSession();
    await start();
    await tick(500);
    assert.equal(attempts, 5, "a new session ignores the old future deadline");

    // A replacement session aborts the old operation. It must settle before
    // the replacement's first timer tick can start another reconciliation.
    runtime.beginSession();
    await flush();
    assert.equal(
      abortedReconciliations,
      1,
      "old reconciliation observes abort",
    );
    assert.equal(activeReconciliations, 0, "aborted operation has settled");
    await start();
    await tick(500);
    assert.equal(attempts, 6, "replacement reconciles on its first timer tick");
    assert.equal(
      maxActiveReconciliations,
      1,
      "external reconciliation stays single-flight",
    );
  } finally {
    runtime.beginShutdown();
    runtime.shutdown();
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});
