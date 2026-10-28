import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const realTransport = await import("./peer-transport.ts");
const realCorrespondence = await import("./peer-correspondence.ts");
const { acquireProcessLock } = await import("./lock.ts");
type Machine = realTransport.SavedPeerMachine;
type Snapshot = realTransport.RemotePeerSnapshot;
const machines: Machine[] = [];
let listMachinesImpl: () => Promise<Machine[]> = async () => machines;
const correspondences: any[] = [];
const queuedReplies: any[] = [];
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
let outboundCorrespondence: any;
mock.module("./peer-transport.ts", {
  namedExports: {
    ...realTransport,
    listSavedPeerMachines: () => listMachinesImpl(),
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
        correspondence?: unknown;
      };
      if (request.correspondence)
        outboundCorrespondence = request.correspondence;
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
    queuePeerReply: (...args: any[]) => {
      queuedReplies.push(args);
      return "queued";
    },
  },
});

const support = await import("./support.ts");
const compatibility = await import("./compatibility.ts");
const supervision = await import("./supervision.ts");
const { createLeadCoordinationRuntime } = await import("./lead-runtime.ts");
const { coordinatorTarget, rememberCoordinatorTarget } =
  await import("./coordinator-target.ts");

const self = "11111111-1111-4111-8111-111111111111";
const assignment = {
  version: 2 as const,
  id: self,
  repoKey: "route-test-repo",
  branch: "assigned-work",
  text: "assigned work",
};

const dataRoot = "remote-route-test-root";
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

function fixture(
  role: "manager" | "lead" = "manager",
  messageLimits?: () => Promise<any>,
) {
  const root = mkdtempSync(join(tmpdir(), "peer-route-refresh-"));
  process.env.PI_CODING_AGENT_DIR = root;
  support.setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = "/test-route-refresh.sock";
  machines.length = 0;
  listMachinesImpl = async () => machines;
  correspondences.length = 0;
  queuedReplies.length = 0;
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
  outboundCorrespondence = undefined;
  probeImpl = async () => {
    const value = nextSnapshots.shift();
    if (!value) throw new Error("missing test snapshot");
    return value;
  };
  const manager = { piSessionId: self, leaseId: "manager-lease", createdAt: 1 };
  const context = support.fakeContext() as any;
  context.activeRole = role;
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => self,
  };
  const leadRuntime = {
    controllerRole: role,
    managerLease: { descriptor: manager },
    chiefMode: "inactive",
    roleSuspended: false,
  };
  const sender = {
    version: 2,
    build: support.HERDSMAN_BUILD,
    sessionKind: "ordinary",
    role,
    name: "Local Research Manager",
    workspaceLabel: "project-alpha/main",
    piSessionId: self,
    claim,
    updatedAt: 1,
  };
  const runtime = createLeadCoordinationRuntime({
    pi: {
      sendMessage() {},
      appendEntry(customType: string, data: unknown) {
        context.sessionManager
          .getEntries()
          .push({ type: "custom", customType, data });
      },
    },
    leadRuntime,
    processRole: "lead",
    controllerScope: { kind: "root" },
    activeRole: () => role,
    HERDSMAN_BUILD: support.HERDSMAN_BUILD,
    supervisionRuntime: () => supervision.supervisionRuntime(),
    peerRuntime: () => supervision.peerRuntime(),
    readPeerLeadRecord: (_runtime: unknown, id: string) =>
      id === self ? sender : undefined,
    listPeerLeadRecords: () => [],
    currentManager: async () => manager,
    workspaceId: () => "route-test-workspace",
    currentWorktreeScope: async () => ({
      repoKey: assignment.repoKey,
      primaryWorkspaceId: "route-test-workspace",
      workspaceIds: ["route-test-workspace"],
    }),
    worktreeGroupScope: async () => ({
      repoKey: assignment.repoKey,
      primaryWorkspaceId: "route-test-workspace",
      workspaceIds: ["route-test-workspace"],
    }),
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
    ...(messageLimits ? { messageLimits } : {}),
  } as any);
  return {
    context,
    runtime,
    sender,
    leadRuntime,
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
) => {
  const entries = context.sessionManager.getEntries();
  const branch = context.sessionManager.getBranch();
  const target = rememberCoordinatorTarget(
    {
      appendEntry(customType: string, data: unknown) {
        const entry = { type: "custom", customType, data };
        entries.push(entry);
        if (branch !== entries) branch.push(entry);
      },
    } as any,
    context,
    context.activeRole,
    session,
  );
  return runtime.peerMessage(
    "send",
    { action: "message", target, message: "test" },
    undefined,
    undefined,
    context,
  );
};

test("internal peer reconciliation does not persist model-facing target bindings", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  probeImpl = async () => snapshot([remote("remote-manager")]);
  const entries = f.context.sessionManager.getEntries();
  const before = entries.slice();
  await f.runtime.peerMessage(
    "remote-reconciliation",
    { action: "list", internal: true },
    undefined,
    undefined,
    f.context,
  );
  assert.deepEqual(entries, before);
  const visible = await list(f.runtime, f.context);
  assert.equal(
    visible.details?.peers[0].target,
    coordinatorTarget("manager", "remote-manager"),
  );
  assert.equal(
    entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-coordinator-target-v1",
    ).length,
    1,
  );
});

test("Lead rejects a bound remote peer that becomes managed", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  const peer = {
    ...remote("remote-lead"),
    role: "lead" as const,
    sessionKind: "ordinary" as const,
  };
  probeImpl = async () => ({
    ...snapshot([peer]),
    ordinaryLeadsComplete: true,
  });
  const discovered = await list(f.runtime, f.context);
  const target = discovered.details!.peers[0].target;
  probeImpl = async () => ({
    ...snapshot([{ ...peer, sessionKind: "managed" as const }]),
    ordinaryLeadsComplete: true,
  });
  await assert.rejects(
    f.runtime.peerMessage(
      "send",
      { action: "message", target, message: "test" },
      undefined,
      undefined,
      f.context,
    ),
    /Remote Manager changed/u,
  );
  assert.deepEqual(deliveries, []);
});

test("Lead send reports failed authorization predicates without rejecting a valid route", async (t) => {
  const unauthorized = fixture("lead");
  t.after(unauthorized.close);
  await assert.rejects(
    send(unauthorized.runtime, unauthorized.context, "missing-peer"),
    /\[no_authorized_target\]$/u,
  );

  const changed = fixture("lead");
  t.after(changed.close);
  changed.sender.role = "manager";
  await assert.rejects(
    send(changed.runtime, changed.context, "missing-peer"),
    /\[sender_role_changed\]$/u,
  );

  const valid = fixture("lead");
  t.after(valid.close);
  machines.push(machine("one"));
  const remoteLead = {
    ...remote("remote-lead"),
    role: "lead",
    sessionKind: "ordinary",
  };
  nextSnapshots = [
    { ...snapshot([remoteLead]), ordinaryLeadsComplete: true },
    { ...snapshot([remoteLead]), ordinaryLeadsComplete: true },
  ];
  await list(valid.runtime, valid.context);
  assert.equal(
    (await send(valid.runtime, valid.context, "remote-lead")).details?.accepted,
    true,
  );
});

test("ambiguous remote routes are excluded and report route_ambiguous", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"), machine("two"));
  const remoteLead = {
    ...remote("ambiguous-peer"),
    role: "lead",
    sessionKind: "ordinary",
  };
  nextSnapshots = [
    { ...snapshot([remoteLead]), ordinaryLeadsComplete: true },
    { ...snapshot([remoteLead]), ordinaryLeadsComplete: true },
  ];

  const peers = await list(f.runtime, f.context);
  assert.deepEqual(peers.details?.peers, []);
  assert.doesNotMatch(peers.content[0].text, /ambiguous-peer/u);
  await assert.rejects(
    send(f.runtime, f.context, "ambiguous-peer"),
    /\[route_ambiguous\]$/u,
  );
});

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
  assert.deepEqual(correspondences[0].originDisplay, {
    name: "Local Research Manager",
    workspaceLabel: "project-alpha/main",
  });
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

test("outbound correspondence merges newly captured partial origin metadata", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [
    snapshot([remote("peer-old")]),
    snapshot([remote("peer-old")]),
  ];
  await list(f.runtime, f.context);
  const correspondence = realCorrespondence.createPeerCorrespondence({
    originSession: self,
    originGeneration: claim.id,
    recipientSession: "peer-old",
    recipientGeneration: "peer-old-generation",
    acceptanceId: "acceptance-existing",
    originDisplay: { workspaceLabel: "remembered workspace" },
  });
  correspondences.push(correspondence);
  f.sender.workspaceLabel = "";
  const sent = await send(f.runtime, f.context, "peer-old");
  assert.equal(sent.details?.accepted, true);
  assert.deepEqual(outboundCorrespondence.originDisplay, {
    workspaceLabel: "remembered workspace",
    name: "Local Research Manager",
  });
});

test("Lead send does not reuse a Manager correspondence for the same remote session", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  const remoteLead = {
    ...remote("peer-old"),
    role: "lead",
    sessionKind: "ordinary",
  };
  nextSnapshots = [
    { ...snapshot([remoteLead]), ordinaryLeadsComplete: true },
    { ...snapshot([remoteLead]), ordinaryLeadsComplete: true },
  ];
  await list(f.runtime, f.context);
  const managerCorrespondence = realCorrespondence.createPeerCorrespondence({
    originSession: self,
    originGeneration: claim.id,
    recipientSession: "peer-old",
    recipientGeneration: "peer-old-generation",
    acceptanceId: "manager-acceptance",
  });
  delete managerCorrespondence.role;
  correspondences.push(managerCorrespondence);

  const sent = await send(f.runtime, f.context, "peer-old");

  assert.equal(sent.details?.accepted, true);
  assert.equal(outboundCorrespondence.role, "lead");
  assert.equal(correspondences.length, 2);
  assert.equal(correspondences[0].role, undefined);
  assert.equal(correspondences[0].acceptanceId, "manager-acceptance");
});

test("reply receipt names the originating Lead correspondence role", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  correspondences.push({
    id: "lead-correspondence",
    role: "lead",
    originSession: "peer-old",
    originGeneration: "peer-old-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    replies: [],
  });

  const sent = await send(f.runtime, f.context, "peer-old");

  assert.match(
    sent.content?.[0]?.text ?? "",
    new RegExp(
      `^Reply queued for originating Lead ${coordinatorTarget("lead", "peer-old")} \\([0-9a-f-]+\\)\\.$`,
      "u",
    ),
  );
});

test("Manager reply enqueue avoids assignment authority lock while Lead still requires it", async (t) => {
  let managerLock: ReturnType<typeof acquireProcessLock> | undefined;
  const managerEntered = gate<void>();
  const manager = fixture("manager", async () => {
    managerLock = acquireProcessLock(
      supervision.projectAssignmentAuthorityLockPath(),
    );
    managerEntered.resolve();
    return { inline: { bytes: 10000 }, mailbox: { bytes: 10000 } };
  });
  t.after(manager.close);
  correspondences.push({
    id: "manager-lock-return",
    originSession: "origin-manager",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    finalized: false,
    replies: [],
  });
  const managerSending = send(
    manager.runtime,
    manager.context,
    "origin-manager",
  );
  await managerEntered.promise;
  try {
    const sent = await managerSending;
    assert.equal(sent.details?.queued, true);
    assert.equal(queuedReplies.length, 1);
  } finally {
    managerLock?.release();
  }

  correspondences.length = 0;
  let leadLock: ReturnType<typeof acquireProcessLock> | undefined;
  const leadEntered = gate<void>();
  const lead = fixture("lead", async () => {
    leadLock = acquireProcessLock(
      supervision.projectAssignmentAuthorityLockPath(),
    );
    leadEntered.resolve();
    return { inline: { bytes: 10000 }, mailbox: { bytes: 10000 } };
  });
  t.after(lead.close);
  lead.sender.sessionKind = "ordinary";
  lead.sender.workspaceId = "route-test-workspace";
  lead.sender.socket = "/test-route-refresh.sock";
  lead.sender.group = {
    repoKey: assignment.repoKey,
    primaryWorkspaceId: "route-test-workspace",
  };
  correspondences.push({
    id: "lead-lock-return",
    originSession: "origin-lead",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    role: "lead",
    finalized: false,
    replies: [],
  });
  const leadSending = send(lead.runtime, lead.context, "origin-lead");
  await leadEntered.promise;
  try {
    await assert.rejects(
      leadSending,
      /Project assignment authority is in progress/u,
    );
    assert.equal(queuedReplies.length, 0);
  } finally {
    leadLock?.release();
  }
});

test("list_peers projects exact reply-only correspondence targets without exposing capabilities", async (t) => {
  const f = fixture();
  t.after(f.close);
  const correspondence = {
    id: "corr-origin",
    capability: "secret-capability",
    originSession: "origin-manager",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    acceptanceId: "acceptance-id",
    originDisplay: {
      name: "Research Manager",
      workspaceLabel: "project-alpha/main",
    },
    finalized: false,
    replies: [],
  };
  correspondences.push(correspondence);

  const result = await list(f.runtime, f.context);
  assert.deepEqual(result.details?.peers, []);
  const expected = [
    {
      target: coordinatorTarget("manager", "origin-manager"),
      name: "Research Manager",
      workspace_label: "project-alpha/main",
    },
  ];
  assert.deepEqual(result.details?.reply_only, expected);
  assert.deepEqual(JSON.parse(result.content[0].text).reply_only, [
    ...expected,
  ]);
  assert.doesNotMatch(result.content[0].text, /secret-capability|corr-origin/);
  assert.doesNotMatch(
    JSON.stringify(result.details),
    /secret-capability|corr-origin/,
  );

  const sent = await send(f.runtime, f.context, "origin-manager");
  assert.equal(
    sent.details?.target,
    coordinatorTarget("manager", "origin-manager"),
  );
  assert.equal(sent.details?.queued, true);
  assert.equal(queuedReplies.length, 1);
  assert.equal(queuedReplies[0][0].id, "corr-origin");

  for (const invalid of [
    { ...correspondence, finalized: true },
    { ...correspondence, recipientSession: "another-manager" },
    { ...correspondence, id: "corr-duplicate" },
  ]) {
    correspondences.length = 0;
    correspondences.push(
      invalid,
      ...(invalid.id === "corr-duplicate" ? [correspondence] : []),
    );
    const excluded = await list(f.runtime, f.context);
    assert.equal(excluded.details?.reply_only, undefined);
    assert.equal(JSON.parse(excluded.content[0].text).reply_only, undefined);
  }

  correspondences.length = 0;
  correspondences.push({
    ...correspondence,
    recipientGeneration: "old-generation",
  });
  const recovered = await list(f.runtime, f.context);
  assert.deepEqual(recovered.details?.reply_only, [...expected]);
  assert.equal(correspondences[0].recipientGeneration, claim.id);
});

test("a discovered Manager is not duplicated in reply_only", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [snapshot([remote("origin-manager")])];
  correspondences.push({
    id: "corr-discovered-origin",
    capability: "secret-capability",
    originSession: "origin-manager",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    acceptanceId: "acceptance-id",
    finalized: false,
    replies: [],
  });
  const result = await list(f.runtime, f.context);
  assert.ok(
    result.details?.peers.some(
      (peer: any) =>
        peer.target === coordinatorTarget("manager", "origin-manager"),
    ),
  );
  assert.equal(result.details?.reply_only, undefined);
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
  assert.equal(first.details?.remote_diagnostics, undefined);
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
  assert.equal(result.details?.remote_diagnostics, undefined);
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

test("reachability and probe failures have distinct remote diagnostics", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("unreachable", false), machine("probe-failed"));
  probeImpl = async (item) => {
    if (item.id === "probe-failed") throw new Error("injected probe failure");
    return snapshot([]);
  };
  const result = await list(f.runtime, f.context);
  assert.deepEqual(result.details?.remote_diagnostics, [
    { machine: "unreachable", reason: "herdr_not_reachable" },
    { machine: "probe-failed", reason: "probe_failed" },
  ]);
  assert.deepEqual(
    JSON.parse(result.content[0].text).remote_diagnostics,
    result.details?.remote_diagnostics,
  );
  assert.doesNotMatch(
    JSON.stringify(result.details?.remote_diagnostics),
    /\.example|injected/u,
  );
});

test("machine-list failures are reported without exposing transport details", async (t) => {
  const f = fixture();
  t.after(f.close);
  listMachinesImpl = async () => {
    throw new Error("ssh://user:secret@private-target");
  };
  const result = await list(f.runtime, f.context);
  assert.deepEqual(result.details?.remote_diagnostics, [
    { reason: "machine_list_failed" },
  ]);
  assert.doesNotMatch(result.content[0].text, /secret|private-target|ssh:/u);
});

test("build diagnostics exclude unverified and incompatible peers but retain compatible peers", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  const mismatchedBuild = {
    ...support.OTHER_HERDSMAN_BUILD,
    version: "0.34.0\nuntrusted",
  };
  probeImpl = async () =>
    snapshot([
      {
        ...remote("old-peer"),
        name: "Old worker",
        build: mismatchedBuild,
      },
      { ...remote("missing-build"), name: "Missing build", build: undefined },
      {
        ...remote("invalid-build"),
        name: "Invalid build",
        build: { version: "x", sha256: "bad" },
      },
      remote("compatible-peer"),
    ]);
  const result = await list(f.runtime, f.context);
  assert.deepEqual(
    result.details?.peers.map((peer: any) => peer.target),
    [coordinatorTarget("manager", "compatible-peer")],
  );
  assert.deepEqual(result.details?.remote_diagnostics, [
    {
      machine: "one",
      reason: "build_mismatch",
      peer: "Old worker",
      local_build: compatibility.formatRuntimeBuild(support.HERDSMAN_BUILD),
      remote_build: `v0.34.0 untrusted · ${mismatchedBuild.sha256.slice(0, 12)}`,
    },
    { machine: "one", reason: "build_unverified", peer: "Missing build" },
    { machine: "one", reason: "build_unverified", peer: "Invalid build" },
  ]);
  assert.deepEqual(
    JSON.parse(result.content[0].text).remote_diagnostics,
    result.details?.remote_diagnostics,
  );
  assert.equal("unavailable_machines" in result.details!, false);
});

test("remote diagnostics are capped and report the omitted count in both result projections", async (t) => {
  const f = fixture();
  t.after(f.close);
  machines.push(machine("one"));
  probeImpl = async () =>
    snapshot(
      Array.from({ length: 25 }, (_, index) => ({
        ...remote(`missing-build-${index}`),
        build: undefined,
      })),
    );

  const result = await list(f.runtime, f.context);

  assert.equal(result.details?.remote_diagnostics.length, 20);
  assert.equal(result.details?.remote_diagnostics_omitted, 5);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    self: { role: "manager" },
    peers: [],
    remote_diagnostics: result.details?.remote_diagnostics,
    remote_diagnostics_omitted: 5,
  });
});

test("incomplete ordinary-Lead scans are diagnosed and complete empty scans are quiet", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  const remoteLead = {
    ...remote("unverified-lead"),
    role: "lead",
    sessionKind: "ordinary" as const,
  };
  probeImpl = async () => ({
    ...snapshot([remoteLead]),
    ordinaryLeadsComplete: false,
  });
  const incomplete = await list(f.runtime, f.context);
  assert.deepEqual(incomplete.details?.peers, []);
  assert.deepEqual(incomplete.details?.remote_diagnostics, [
    { machine: "one", reason: "eligibility_unverified" },
  ]);

  probeImpl = async () => ({ ...snapshot([]), ordinaryLeadsComplete: true });
  const complete = await list(f.runtime, f.context);
  assert.equal(complete.details?.remote_diagnostics, undefined);
});

test("incomplete ordinary-Lead scans retain prior verified routes", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  const remoteLead = {
    ...remote("previously-verified-peer"),
    role: "lead",
    sessionKind: "ordinary" as const,
  };
  probeImpl = async () => ({
    ...snapshot([remoteLead]),
    ordinaryLeadsComplete: true,
  });
  const complete = await list(f.runtime, f.context);
  assert.deepEqual(
    complete.details?.peers.map((peer: any) => peer.target),
    [coordinatorTarget("lead", "previously-verified-peer")],
  );

  probeImpl = async () => ({
    ...snapshot([remoteLead]),
    ordinaryLeadsComplete: false,
  });
  const incomplete = await list(f.runtime, f.context);
  assert.deepEqual(incomplete.details?.peers, []);
  assert.deepEqual(incomplete.details?.remote_diagnostics, [
    { machine: "one", reason: "eligibility_unverified" },
  ]);
  await assert.rejects(
    send(f.runtime, f.context, "previously-verified-peer"),
    /Remote Manager changed/u,
  );

  probeImpl = async () => ({
    ...snapshot([remoteLead]),
    ordinaryLeadsComplete: true,
  });
  assert.equal(
    (await send(f.runtime, f.context, "previously-verified-peer")).details
      ?.accepted,
    true,
  );
});

test("managed assigned local Leads do not discover or probe remote peers", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [snapshot([])];
  supervision.writeProjectAssignment(
    supervision.supervisionRuntime(),
    assignment,
  );
  t.after(() =>
    supervision.removeProjectAssignment(
      supervision.supervisionRuntime(),
      assignment.repoKey,
      assignment.branch,
    ),
  );
  f.sender.sessionKind = "managed";
  f.sender.workspaceId = "route-test-workspace";
  f.sender.socket = "/test-route-refresh.sock";
  f.sender.group = {
    repoKey: assignment.repoKey,
    primaryWorkspaceId: "route-test-workspace",
  };

  await list(f.runtime, f.context);
  assert.equal(nextSnapshots.length, 1, "managed Lead skips remote probe");

  assert.equal(
    supervision.globalProjectAssignmentSnapshot().get(self)?.length,
    1,
    "managed Lead is assigned in the authoritative snapshot",
  );
});

test("ordinary assigned local Leads do not discover or probe remote peers", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [snapshot([])];
  supervision.writeProjectAssignment(
    supervision.supervisionRuntime(),
    assignment,
  );
  t.after(() =>
    supervision.removeProjectAssignment(
      supervision.supervisionRuntime(),
      assignment.repoKey,
      assignment.branch,
    ),
  );

  assert.equal(f.sender.sessionKind, "ordinary");
  await assert.rejects(
    list(f.runtime, f.context),
    /eligibility could not be verified/,
  );

  assert.equal(
    nextSnapshots.length,
    1,
    "assigned ordinary Lead skips remote probe",
  );
  assert.equal(
    supervision.globalProjectAssignmentSnapshot().get(self)?.length,
    1,
    "ordinary Lead has a nonempty authoritative assignment",
  );
  correspondences.push({
    id: "assigned-lead-return",
    capability: "secret",
    originSession: "origin-lead",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    role: "lead",
    finalized: false,
    replies: [],
  });
  await assert.rejects(send(f.runtime, f.context, "origin-lead"));
  assert.equal(queuedReplies.length, 0);
});

test("Lead reply is rejected when assignment changes during async preparation", async (t) => {
  const entered = gate<void>();
  const preparation = gate<any>();
  const f = fixture("lead", async () => {
    entered.resolve();
    return preparation.promise;
  });
  t.after(f.close);
  f.sender.sessionKind = "ordinary";
  f.sender.workspaceId = "route-test-workspace";
  f.sender.socket = "/test-route-refresh.sock";
  f.sender.group = {
    repoKey: assignment.repoKey,
    primaryWorkspaceId: "route-test-workspace",
  };
  correspondences.push({
    id: "ordinary-lead-return",
    capability: "secret",
    originSession: "origin-lead",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: claim.id,
    role: "lead",
    finalized: false,
    replies: [],
  });

  const replying = send(f.runtime, f.context, "origin-lead");
  await entered.promise;
  supervision.writeProjectAssignment(
    supervision.supervisionRuntime(),
    assignment,
  );
  t.after(() =>
    supervision.removeProjectAssignment(
      supervision.supervisionRuntime(),
      assignment.repoKey,
      assignment.branch,
    ),
  );
  preparation.resolve({ inline: { bytes: 10000 }, mailbox: { bytes: 10000 } });

  await assert.rejects(replying, /authority changed/);
  assert.equal(queuedReplies.length, 0);
});

test("cross-role correspondences cannot recover generations, become reply-only, or poll and ACK", async (t) => {
  const f = fixture("lead");
  t.after(f.close);
  machines.push(machine("one"));
  nextSnapshots = [snapshot([remote("cross-role-peer")])];
  const localRecipient = {
    id: "manager-correspondence-to-local",
    capability: "local-capability",
    role: "manager",
    originSession: "manager-origin",
    originGeneration: "origin-generation",
    recipientSession: self,
    recipientGeneration: "old-local-generation",
    finalized: false,
    replies: [],
  };
  const localOrigin = {
    id: "manager-correspondence-from-local",
    capability: "remote-capability",
    role: "manager",
    originSession: self,
    originGeneration: "old-local-generation",
    recipientSession: "cross-role-peer",
    recipientGeneration: "old-remote-generation",
    finalized: false,
    replies: [],
  };
  correspondences.push(localRecipient, localOrigin);

  const result = await list(f.runtime, f.context);

  assert.equal(localRecipient.recipientGeneration, "old-local-generation");
  assert.equal(localOrigin.originGeneration, "old-local-generation");
  assert.equal(localOrigin.recipientGeneration, "old-remote-generation");
  assert.equal(result.details?.reply_only, undefined);
  assert.equal(
    endpointCalls.some((call) =>
      ["recover", "recover-recipient", "poll", "ack"].includes(call.action),
    ),
    false,
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
  assert.deepEqual(partial.details?.remote_diagnostics, [
    { machine: "offline", reason: "herdr_not_reachable" },
  ]);
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
