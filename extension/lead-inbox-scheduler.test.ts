import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLeadInboxRuntime } from "./lead-runtime.ts";
import {
  listChiefMessagePaths,
  readChiefMessage,
  supervisionRuntime,
  writeChiefMessage,
} from "./supervision.ts";
import { fakeContext } from "./support.ts";

test("managed peer inbox cleanup removes messages only for a verified scope mismatch", async () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const socket = join(
    mkdtempSync(join(tmpdir(), "lead-inbox-cleanup-")),
    "sock",
  );
  process.env.HERDR_SOCKET_PATH = socket;
  const context = fakeContext([
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId: "lead-session",
        kind: "managed",
        repoKey: "assigned-repo",
        branch: "feature",
      },
    },
  ]);
  context.sessionManager.getSessionId = () => "lead-session";
  const peerInboxRuntime = supervisionRuntime(socket);
  const record = {
    version: 2 as const,
    build: { version: "0.18.0", sha256: "a".repeat(64) },
    id: randomUUID(),
    leaseId: randomUUID(),
    kind: "peer_message" as const,
    fromSessionId: "sender",
    toSessionId: "lead-session",
    leadSessionId: "lead-session",
    text: "stale",
    peerSource: {
      role: "lead" as const,
      socket,
      group: { repoKey: "assigned-repo", primaryWorkspaceId: "workspace" },
      managed: true,
    },
    createdAt: 1,
  };
  let currentScope: any = {
    repoKey: "current-repo",
    repoName: "current",
    primaryWorkspaceId: "workspace",
    workspaceIds: ["workspace"],
  };
  const runtime = createLeadInboxRuntime({
    leadRuntime: {
      chiefMode: "inactive",
      sessionGeneration: 0,
      chiefModeGeneration: 0,
    },
    peerRuntime: () => peerInboxRuntime,
    listChiefMessagePaths,
    currentWorktreeScope: async (_ctx: unknown) => currentScope,
  } as any);

  try {
    writeChiefMessage(record, peerInboxRuntime);
    await runtime.cleanupManagedPeerInbox(context as any);
    assert.deepEqual(
      listChiefMessagePaths(peerInboxRuntime, "lead-session"),
      [],
    );

    for (const scope of [
      {
        repoKey: "assigned-repo",
        repoName: "assigned",
        primaryWorkspaceId: "workspace",
        workspaceIds: ["workspace"],
      },
      undefined,
    ]) {
      const retained = { ...record, id: randomUUID() };
      writeChiefMessage(retained, peerInboxRuntime);
      currentScope = scope;
      await runtime.cleanupManagedPeerInbox(context as any);
      assert.equal(
        listChiefMessagePaths(peerInboxRuntime, "lead-session").some(
          (path) => readChiefMessage(path).id === retained.id,
        ),
        true,
      );
    }
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

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

test("scheduled peer inbox drains without valid presence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/unused-scheduler-test-socket";

  try {
    for (const valid of [false, true]) {
      let peerDrains = 0;
      const peerRuntime = {};
      const context = fakeContext();
      const runtime = createLeadInboxRuntime({
        leadRuntime: {
          chiefMode: "inactive",
          sessionGeneration: 0,
          chiefModeGeneration: 0,
        },
        activeRole: () => "lead",
        controllerScope: { kind: "root" },
        supervisionRuntime: () => ({}),
        peerRuntime: () => peerRuntime,
        pi: {},
        managerDiagnostic: () => {},
        managerDiagnosticEvents: new Set(),
        listChiefMessagePaths: () => [],
        drainCoordinationInbox: async (options: { runtime: unknown }) => {
          if (options.runtime === peerRuntime) peerDrains++;
          return 0;
        },
        currentPeerPresenceValid: async () => valid,
        drainProjectMessages: async () => 0,
      } as any);

      try {
        runtime.beginSession();
        runtime.start(context as any);
        await flush();
        t.mock.timers.tick(500);
        await flush();
        assert.equal(peerDrains, 2);
      } finally {
        runtime.beginShutdown();
        runtime.shutdown();
      }
    }
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("peer send boundary rejects unavailable local presence", async () => {
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/unused-peer-send-test-socket";
  const context = fakeContext();
  const peerInboxRuntime = {};
  const sent: unknown[] = [];
  let peerOptions: any;
  let projectDrains = 0;
  const runtime = createLeadInboxRuntime({
    leadRuntime: {
      chiefMode: "inactive",
      roleSuspended: false,
      sessionGeneration: 0,
      chiefModeGeneration: 0,
    },
    leadInstanceId: () => "lead-instance",
    activeRole: () => "manager",
    controllerScope: { kind: "root" },
    supervisionRuntime: () => ({}),
    peerRuntime: () => peerInboxRuntime,
    pi: { sendMessage: (message: unknown) => sent.push(message) },
    coordinationHealthy: () => true,
    managerDiagnostic: () => {},
    managerDiagnosticEvents: new Set(),
    listChiefMessagePaths: () => [],
    drainCoordinationInbox: async (options: any) => {
      if (options.runtime === peerInboxRuntime) peerOptions = options;
      return 0;
    },
    authorizePeerRecord: async () => true,
    authorizeChiefRecord: async () => true,
    livePeerLead: async () => ({ piSessionId: "recipient", role: "manager" }),
    peerContext: async () => ({ role: "manager" }),
    resolvePeerResultBindings: () => ({ bindings: [], conflicts: [] }),
    describePeerResultConflicts: () => "",
    currentPeerPresenceValid: async () => false,
    importResultBindings: () => {},
    drainProjectMessages: async () => {
      projectDrains++;
      return 0;
    },
  } as any);

  try {
    runtime.beginSession();
    runtime.start(context as any);
    await flush();
    assert.ok(peerOptions, "peer inbox options were passed to the drain");
    await assert.rejects(
      peerOptions.sendMessage(
        "queued peer",
        { triggerTurn: false },
        {
          id: "queued-peer",
          messageProtocol: 1,
          kind: "peer_message",
          fromSessionId: "sender",
          toSessionId: "recipient",
          peerSource: { role: "manager" },
        },
      ),
      /Peer presence is unavailable before delivery/,
    );
    assert.ok(projectDrains > 0, "the project-message inbox still drains");
    assert.deepEqual(sent, []);
  } finally {
    runtime.beginShutdown();
    runtime.shutdown();
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

test("ordinary Lead peer reconciliation starts automatically", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/unused-scheduler-test-socket";

  let attempts = 0;
  const context = fakeContext();
  const runtime = createLeadInboxRuntime({
    leadRuntime: {
      chiefMode: "inactive",
      sessionGeneration: 0,
      chiefModeGeneration: 0,
    },
    activeRole: () => "lead",
    controllerScope: { kind: "root" },
    supervisionRuntime: () => ({}),
    peerRuntime: () => ({}),
    pi: {},
    managerDiagnostic: () => {},
    managerDiagnosticEvents: new Set(),
    listChiefMessagePaths: () => [],
    drainCoordinationInbox: async () => 0,
    currentPeerPresenceValid: async () => false,
    drainProjectMessages: async () => 0,
    reconcileRemotePeers: () => {
      attempts++;
    },
  } as any);

  try {
    runtime.beginSession();
    runtime.start(context as any);
    await flush();
    t.mock.timers.tick(500);
    await flush();
    assert.equal(attempts, 1, "Lead starts reconciliation without list_peers");
  } finally {
    runtime.beginShutdown();
    runtime.shutdown();
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});

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
          details: {
            remote_diagnostics: [
              { machine: "offline-peer", reason: "herdr_not_reachable" },
            ],
          },
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
      details: {
        remote_diagnostics: [
          { machine: "still-offline", reason: "herdr_not_reachable" },
        ],
      },
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
