import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const realTransport = await import("./peer-transport.ts");
const realCorrespondence = await import("./peer-correspondence.ts");
type Machine = realTransport.SavedPeerMachine;
type Snapshot = realTransport.RemotePeerSnapshot;
const machines: Machine[] = [];
const correspondences: any[] = [];
const diagnostics: unknown[] = [];
const deliveredReplies: any[] = [];
let diagnosticAttempts = 0;
let failNextDiagnosticAppend = false;
let nextSnapshots: Snapshot[] = [];
let failRecoveryForB = false;
let abortRecoveryForB: (() => void) | undefined;
let cReplyAcknowledged = false;
const cReply = {
  id: "reply-C",
  text: "reply from C",
  digest: realTransport.peerPayloadDigest({ text: "reply from C" }),
  createdAt: 1,
};
const endpointCalls: { action: string; recipientSession?: string }[] = [];
let probeImpl: (machine: Machine) => Promise<Snapshot> = async () => {
  const snapshot = nextSnapshots.shift();
  if (!snapshot) throw new Error("missing test snapshot");
  return snapshot;
};
const deliveries: string[] = [];
mock.module("./peer-transport.ts", {
  namedExports: {
    ...realTransport,
    listSavedPeerMachines: async () => machines,
    probePeerEndpoint: (machine: Machine) => probeImpl(machine),
    runPeerEndpoint: async (
      _machine: Machine,
      action: string,
      input?: string,
    ) => {
      const request = JSON.parse(input ?? "{}") as {
        id?: string;
        recipientSession?: string;
        replyId?: string;
        record?: { id?: string };
      };
      endpointCalls.push({
        action,
        recipientSession: request.recipientSession,
      });
      if (action === "recover-recipient") {
        if (request.recipientSession === "peer-B" && failRecoveryForB) {
          abortRecoveryForB?.();
          throw new Error("injected recipient recovery failure");
        }
        return JSON.stringify({ recovered: true });
      }
      if (action === "recover") return JSON.stringify({ recovered: true });
      if (action === "poll")
        return JSON.stringify({
          dataRoot,
          replies:
            request.recipientSession === "peer-C" && !cReplyAcknowledged
              ? [cReply]
              : [],
        });
      if (action === "ack") {
        if (
          request.recipientSession === "peer-C" &&
          request.replyId === cReply.id
        )
          cReplyAcknowledged = true;
        return JSON.stringify({ acknowledged: true });
      }
      const id = request.record?.id;
      deliveries.push(id ?? "");
      return JSON.stringify({ accepted: true, id });
    },
  },
});
mock.module("./peer-correspondence.ts", {
  namedExports: {
    ...realCorrespondence,
    listPeerCorrespondences: () => correspondences,
    updatePeerRecipientGeneration: (
      id: string,
      _capability: string,
      _recipient: string,
      _previous: string,
      next: string,
    ) => {
      const current = correspondences.find((item) => item.id === id);
      if (current) current.recipientGeneration = next;
    },
    updatePeerOriginGeneration: (
      id: string,
      _cap: string,
      _origin: string,
      _previous: string,
      next: string,
    ) => {
      const current = correspondences.find((item) => item.id === id);
      if (current) current.originGeneration = next;
    },
    storePeerCorrespondence: (item: any) => {
      const index = correspondences.findIndex(
        (current) => current.id === item.id,
      );
      if (index < 0) correspondences.push(item);
      else correspondences[index] = item;
    },
    createPeerCorrespondence: (item: unknown) => item,
  },
});

const support = await import("./support.ts");
const compatibility = await import("./compatibility.ts");
const supervision = await import("./supervision.ts");
const { createLeadCoordinationRuntime } = await import("./lead-runtime.ts");

const dataRoot = "remote-route-test-root";
const self = "manager-local";
const claim = { id: "local-generation", pid: 1, startedAt: 1 };
const machine = (id: string, reachable = true): Machine => ({
  id,
  label: id,
  target: `${id}.example`,
  reachable,
});
const snapshot = (peers: Snapshot["peers"], root = dataRoot): Snapshot => ({
  dataRoot: root,
  peers,
});
const remote = (
  id: string,
  generation = `${id}-generation`,
  build?: unknown,
) => ({
  role: "manager",
  piSessionId: id,
  claim: { id: generation },
  build: build ?? support.HERDSMAN_BUILD,
});
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "peer-route-refresh-"));
  process.env.PI_CODING_AGENT_DIR = root;
  support.setLeadEnvironment();
  machines.length = 0;
  correspondences.length = 0;
  diagnostics.length = 0;
  deliveredReplies.length = 0;
  diagnosticAttempts = 0;
  failNextDiagnosticAppend = false;
  endpointCalls.length = 0;
  failRecoveryForB = false;
  abortRecoveryForB = undefined;
  cReplyAcknowledged = false;
  nextSnapshots = [];
  deliveries.length = 0;
  probeImpl = async () => {
    const value = nextSnapshots.shift();
    if (!value) throw new Error("missing test snapshot");
    return value;
  };
  const manager = { piSessionId: self, leaseId: "manager-lease", createdAt: 1 };
  const context = support.fakeContext() as any;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => self,
  };
  const leadRuntime = {
    controllerRole: "manager",
    managerLease: { descriptor: manager },
    chiefMode: "inactive",
    roleSuspended: false,
  };
  const sender = {
    version: 2,
    build: support.HERDSMAN_BUILD,
    sessionKind: "ordinary",
    role: "manager",
    piSessionId: self,
    claim,
    updatedAt: 1,
  };
  const runtime = createLeadCoordinationRuntime({
    pi: { sendMessage() {} },
    leadRuntime,
    processRole: "lead",
    controllerScope: { kind: "root" },
    activeRole: () => "manager",
    HERDSMAN_BUILD: support.HERDSMAN_BUILD,
    supervisionRuntime: () => supervision.supervisionRuntime(),
    peerRuntime: () => supervision.peerRuntime(),
    readPeerLeadRecord: (_runtime: unknown, id: string) =>
      id === self ? sender : undefined,
    listPeerLeadRecords: () => [],
    currentManager: async () => manager,
    appendDurableError: (
      _pi: unknown,
      _ctx: unknown,
      _type: string,
      error: unknown,
    ) => {
      diagnosticAttempts++;
      if (failNextDiagnosticAppend) {
        failNextDiagnosticAppend = false;
        throw new Error("injected diagnostic append failure");
      }
      diagnostics.push(error);
    },
    writeCoordinationMessage: (record: unknown) =>
      deliveredReplies.push(record),
    importResultBindings: () => {},
    messageLimits: async () => ({
      inline: { bytes: 10000 },
      mailbox: { bytes: 10000 },
    }),
    resolveMessageFiles: () => [],
    chiefMessageBytes: (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value)),
    requireCompatibleBuild: compatibility.requireCompatibleBuild,
    sameRuntimeBuild: compatibility.sameRuntimeBuild,
    listManagerDescriptors: () => [],
  } as any);
  return {
    context,
    runtime,
    async close() {
      delete process.env.PI_CODING_AGENT_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const list = (
  runtime: ReturnType<typeof createLeadCoordinationRuntime>,
  context: any,
  signal?: AbortSignal,
) =>
  runtime.peerMessage("list", { action: "list" }, signal, undefined, context);
const send = (
  runtime: ReturnType<typeof createLeadCoordinationRuntime>,
  context: any,
  session: string,
) =>
  runtime.peerMessage(
    "send",
    { action: "message", session, message: "test" },
    undefined,
    undefined,
    context,
  );

test("published route remains sendable during refresh and a stale discovery cannot overwrite newer routes", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [snapshot([remote("peer-old")])];
  await list(f.runtime, f.context);

  const held = gate<Snapshot>();
  const probeEntered = gate<void>();
  let refreshProbe = true;
  probeImpl = async () => {
    if (refreshProbe) {
      refreshProbe = false;
      probeEntered.resolve();
      return held.promise;
    }
    return snapshot([remote("peer-old")]);
  };
  const refreshing = list(f.runtime, f.context);
  await probeEntered.promise;
  const sent = await send(f.runtime, f.context, "peer-old");
  assert.equal(sent.details?.accepted, true);
  held.resolve(snapshot([remote("peer-old")]));
  await refreshing;

  const older = gate<Snapshot>();
  const newer = gate<Snapshot>();
  let calls = 0;
  probeImpl = async () => (calls++ === 0 ? older.promise : newer.promise);
  const oldDiscovery = list(f.runtime, f.context);
  const newDiscovery = list(f.runtime, f.context);
  newer.resolve(snapshot([remote("peer-newer")]));
  await newDiscovery;
  older.resolve(snapshot([remote("peer-stale")]));
  await oldDiscovery;
  assert.equal(
    (await send(f.runtime, f.context, "peer-newer")).details?.accepted,
    true,
  );
  await assert.rejects(
    send(f.runtime, f.context, "peer-stale"),
    /not found|unavailable/,
  );
});

test("a correspondence failure is isolated, deduplicated, and retried", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [
    snapshot([
      remote("peer-B", "generation-1"),
      remote("peer-C", "generation-C"),
    ]),
  ];
  await list(f.runtime, f.context);

  correspondences.push(
    {
      id: "correspondence-B",
      capability: "capability-B",
      originSession: self,
      originGeneration: claim.id,
      recipientSession: "peer-B",
      recipientGeneration: "generation-1",
      finalized: false,
    },
    {
      id: "correspondence-C",
      capability: "capability-C",
      originSession: self,
      originGeneration: claim.id,
      recipientSession: "peer-C",
      recipientGeneration: "generation-C",
      finalized: false,
    },
  );
  failRecoveryForB = true;
  failNextDiagnosticAppend = true;
  probeImpl = async () =>
    snapshot([
      remote("peer-B", "generation-2"),
      remote("peer-C", "generation-C"),
    ]);
  const first = await list(f.runtime, f.context);
  assert.equal(first.details?.unavailable_machines, undefined);
  assert.equal(diagnostics.length, 0, "failed diagnostic append is contained");
  assert.equal(deliveredReplies.length, 1);
  assert.equal(deliveredReplies[0].id, cReply.id);
  assert.ok(
    endpointCalls.some(
      (call) => call.action === "poll" && call.recipientSession === "peer-C",
    ),
  );
  assert.ok(
    endpointCalls.some(
      (call) => call.action === "ack" && call.recipientSession === "peer-C",
    ),
  );

  await list(f.runtime, f.context);
  assert.equal(
    diagnostics.length,
    1,
    "recovery error is reported after append succeeds",
  );
  assert.match(String(diagnostics[0]), /injected recipient recovery failure/);
  await list(f.runtime, f.context);
  assert.equal(diagnostics.length, 1, "same B recovery error is reported once");
  assert.equal(
    diagnosticAttempts,
    2,
    "failed append is retried once, then deduplicated",
  );
  assert.equal(
    deliveredReplies.length,
    1,
    "C's acknowledged reply is not redelivered",
  );

  failRecoveryForB = false;
  await list(f.runtime, f.context);
  assert.equal(correspondences[0].recipientGeneration, "generation-2");
  assert.equal(diagnostics.length, 1);
  assert.ok(
    endpointCalls.some(
      (call) =>
        call.action === "recover-recipient" &&
        call.recipientSession === "peer-B",
    ),
  );
  const sent = await send(f.runtime, f.context, "peer-B");
  assert.equal(sent.details?.accepted, true);
});

test("aborted correspondence recovery stops later correspondence processing", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [
    snapshot([
      remote("peer-B", "generation-1"),
      remote("peer-C", "generation-C"),
    ]),
  ];
  await list(f.runtime, f.context);
  correspondences.push(
    {
      id: "correspondence-B",
      capability: "capability-B",
      originSession: self,
      originGeneration: claim.id,
      recipientSession: "peer-B",
      recipientGeneration: "generation-1",
      finalized: false,
    },
    {
      id: "correspondence-C",
      capability: "capability-C",
      originSession: self,
      originGeneration: claim.id,
      recipientSession: "peer-C",
      recipientGeneration: "generation-C",
      finalized: false,
    },
  );

  const controller = new AbortController();
  failRecoveryForB = true;
  abortRecoveryForB = () => controller.abort();
  probeImpl = async () =>
    snapshot([
      remote("peer-B", "generation-2"),
      remote("peer-C", "generation-C"),
    ]);
  const result = await list(f.runtime, f.context, controller.signal);

  assert.equal(controller.signal.aborted, true);
  assert.equal(result.details?.unavailable_machines, undefined);
  assert.deepEqual(diagnostics, []);
  assert.ok(
    endpointCalls.some(
      (call) =>
        call.action === "recover-recipient" &&
        call.recipientSession === "peer-B",
    ),
  );
  assert.equal(
    endpointCalls.some((call) => call.recipientSession === "peer-C"),
    false,
  );
  assert.deepEqual(deliveredReplies, []);
});

test("genuine remote probe failure remains listed as unavailable", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("unreachable"));
  probeImpl = async () => {
    throw new Error("injected probe failure");
  };
  const result = await list(f.runtime, f.context);
  assert.deepEqual(result.details?.unavailable_machines, ["unreachable"]);
  assert.deepEqual(diagnostics, []);
});

test("partial discovery refreshes healthy routes, retains unavailable routes, and fails closed on conflicts", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("healthy"), machine("offline"));
  nextSnapshots = [
    snapshot([remote("healthy-peer", "old-healthy")]),
    snapshot([remote("offline-peer", "offline-generation")]),
  ];
  await list(f.runtime, f.context);
  machines[1] = machine("offline", false);

  const changed = snapshot([
    remote("healthy-peer", "new-healthy"),
    remote("offline-peer", "offline-generation"),
  ]);
  probeImpl = async (item) =>
    item.id === "healthy" ? changed : Promise.reject(new Error("offline"));
  const partial = await list(f.runtime, f.context);
  assert.deepEqual(partial.details?.unavailable_machines, ["offline"]);
  assert.equal(
    (await send(f.runtime, f.context, "healthy-peer")).details?.accepted,
    true,
  );

  probeImpl = async (item) =>
    item.id === "healthy"
      ? snapshot([remote("offline-peer", "offline-generation")])
      : Promise.reject(new Error("offline"));
  await list(f.runtime, f.context);
  await assert.rejects(
    send(f.runtime, f.context, "offline-peer"),
    /not found|ambiguous/,
  );
});

test("fresh send-time probe rejects incompatible or missing build metadata", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [snapshot([remote("peer")])];
  await list(f.runtime, f.context);
  for (const build of [support.OTHER_HERDSMAN_BUILD, undefined]) {
    probeImpl = async () => snapshot([{ ...remote("peer"), build }]);
    await assert.rejects(
      send(f.runtime, f.context, "peer"),
      /incompatible|build/i,
    );
  }
});
