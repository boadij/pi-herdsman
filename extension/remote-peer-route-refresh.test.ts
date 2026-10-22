import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const realTransport = await import("./peer-transport.ts");
type Machine = realTransport.SavedPeerMachine;
type Snapshot = realTransport.RemotePeerSnapshot;
const machines: Machine[] = [];
let nextSnapshots: Snapshot[] = [];
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
      _action: string,
      input?: string,
    ) => {
      const envelope = JSON.parse(input ?? "{}") as {
        record?: { id?: string };
      };
      const id = envelope.record?.id;
      deliveries.push(id ?? "");
      return JSON.stringify({ accepted: true, id });
    },
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
) =>
  runtime.peerMessage(
    "list",
    { action: "list" },
    undefined,
    undefined,
    context,
  );
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
  let refreshProbe = true;
  probeImpl = async () => {
    if (refreshProbe) {
      refreshProbe = false;
      return held.promise;
    }
    return snapshot([remote("peer-old")]);
  };
  const refreshing = list(f.runtime, f.context);
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
