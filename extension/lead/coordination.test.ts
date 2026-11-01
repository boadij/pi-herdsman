import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  fakeContext,
  HERDSMAN_BUILD,
  OTHER_HERDSMAN_BUILD,
  testTmpRoot,
} from "../support.ts";
import {
  canMessagePeer,
  leadCoordinationStatePath,
  listProjectAssignments,
  listProjectMessageHeaders,
  readProjectAssignment,
  readLeadCoordinationStateForObservation,
  takeProtocolDiagnostics,
  samePeerLeadAuthority,
  samePeerLeadGeneration,
  type ProjectMessageHeaderIssue,
  writeProjectAssignment,
} from "../supervision.ts";
import { sameRuntimeBuild } from "../compatibility.ts";
import { supervisionRuntime } from "../supervision.ts";
import { projectAssignmentPath } from "../supervision.ts";
import {
  listPeerLeadRecordsForDiscovery,
  peerLeadLockPath,
  peerLeadRecordPath,
  peerRuntime,
} from "../supervision.ts";
import { acquireProcessLock } from "../lock.ts";
import { createLeadCoordinationRuntime } from "./coordination.ts";

test("scoped peer presence writes its worktree group", async () => {
  const sessionId = randomUUID();
  const repoKey = "a".repeat(64);
  const records: any[] = [];
  let provenanceStarted!: () => void;
  const groupedRecordWritten = new Promise<void>((resolve) => {
    provenanceStarted = resolve;
  });
  const context = fakeContext([
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: { version: 1, sessionId, kind: "ordinary" },
    },
  ]) as any;
  context.sessionManager.getSessionId = () => sessionId;
  const root = join(testTmpRoot, randomUUID());
  const runtime = createLeadCoordinationRuntime(
    new Proxy(
      {
        pi: { getSessionName: () => undefined },
        leadRuntime: { chiefMode: "inactive", roleSuspended: false },
        processRole: "lead",
        controllerScope: { kind: "root" },
        HERDSMAN_BUILD,
        activeRole: () => "lead",
        supervisionRuntime: () => ({ assignments: join(root, "assignments") }),
        peerRuntime: () => ({}),
        peerLeadLockPath: () => "peer-lock",
        acquireProcessLock: () => ({ claim: {}, release: () => undefined }),
        currentWorktreeScope: async () => ({
          repoKey,
          primaryWorkspaceId: "primary-workspace",
        }),
        writePeerLeadRecord: (_runtime: unknown, record: unknown) =>
          records.push(record),
        readPeerLeadRecord: () => records.at(-1),
        samePeerLeadGeneration: () => true,
        samePeerLeadRecord: () => true,
        workspacePresentationProvenance: async () => {
          provenanceStarted();
          return new Map();
        },
        basename: (path: string) => path,
      },
      {
        get(target, key: string) {
          return key in target
            ? target[key as keyof typeof target]
            : () => undefined;
        },
      },
    ) as any,
  );

  const env = {
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_TAB_ID: process.env.HERDR_TAB_ID,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  };
  process.env.HERDR_PANE_ID = "pane";
  process.env.HERDR_TAB_ID = "tab";
  process.env.HERDR_WORKSPACE_ID = "workspace";
  process.env.HERDR_SOCKET_PATH = "socket";
  try {
    await runtime.schedulePeerPresence(context);
    await groupedRecordWritten;
    assert.ok(
      records.some(
        (record) =>
          record.group?.repoKey === repoKey &&
          record.group.primaryWorkspaceId === "primary-workspace",
      ),
    );
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    runtime.removePeerPresence();
  }
});

test("empty project-message drain skips assignment listing", async () => {
  let assignmentLists = 0;
  const socket = `/tmp/empty-project-message-drain-${randomUUID()}.sock`;
  const host = new Proxy(
    {
      pi: {},
      leadRuntime: {
        chiefMode: "inactive",
        roleSuspended: false,
        managerLease: { descriptor: { repoKey: "empty-repo" } },
      },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "manager",
      supervisionRuntime: () => supervisionRuntime(socket),
      listProjectAssignments: () => {
        assignmentLists++;
        return [];
      },
    },
    {
      get(target, key: string) {
        return key in target
          ? target[key as keyof typeof target]
          : () => undefined;
      },
    },
  ) as any;
  const runtime = createLeadCoordinationRuntime(host);

  assert.equal(await runtime.drainProjectMessages(fakeContext() as any), 0);
  assert.equal(assignmentLists, 0);
});

test("Managed supervisor messages never fall through when the active role is not Lead", async () => {
  let ordinaryRoutingCalls = 0;
  let assignmentLookups = 0;
  let projectPublications = 0;
  const host = new Proxy(
    {
      pi: {},
      leadRuntime: { chiefMode: "inactive" },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "manager",
      currentSupervisor: async () => {
        ordinaryRoutingCalls++;
        return undefined;
      },
      currentProjectAssignment: async () => {
        assignmentLookups++;
        return undefined;
      },
      publishProjectMessage: async () => {
        projectPublications++;
        return undefined;
      },
    },
    {
      get(target, key: string) {
        return key in target
          ? target[key as keyof typeof target]
          : () => undefined;
      },
    },
  ) as any;
  const runtime = createLeadCoordinationRuntime(host);
  const sessionId = randomUUID();
  const context = fakeContext([
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId,
        kind: "managed",
        repoKey: "repo-key",
        branch: "managed-branch",
      },
    },
  ]) as any;
  context.sessionManager.getSessionId = () => sessionId;

  await assert.rejects(
    runtime.supervisorMessage(
      "message",
      { message: "must not route through Chief" },
      undefined,
      undefined,
      context,
    ),
    /Managed Lead cannot use ordinary supervisor routing/,
  );
  assert.equal(ordinaryRoutingCalls, 0);
  assert.equal(assignmentLookups, 0);
  assert.equal(projectPublications, 0);
});

test("assigned Lead supervisor messages use the project publisher without a live Manager", async () => {
  const sessionId = randomUUID();
  const assignment = {
    version: 2,
    id: sessionId,
    repoKey: "assigned-repo",
    branch: "assigned-branch",
    text: "assigned task",
  };
  let publishedArgs: unknown[] | undefined;
  let supervisorLookups = 0;
  const runtime = createLeadCoordinationRuntime(
    hostWithDefaults({
      pi: {},
      leadRuntime: { chiefMode: "inactive", roleSuspended: false },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "lead",
      currentProjectAssignment: async () => assignment,
      currentSupervisor: async () => {
        supervisorLookups++;
        return undefined;
      },
      publishProjectMessage: async (...args: unknown[]) => {
        publishedArgs = args;
        return { id: "durable-project-message" };
      },
    }),
  );
  const context = fakeContext([
    {
      type: "custom",
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId,
        kind: "managed",
        repoKey: assignment.repoKey,
        branch: assignment.branch,
      },
    },
  ]) as any;
  context.sessionManager.getSessionId = () => sessionId;

  const result = await runtime.supervisorMessage(
    "message",
    { message: "explicit message" },
    undefined,
    undefined,
    context,
  );

  assert.equal(publishedArgs?.[6], "supervisor_message");
  assert.equal(supervisorLookups, 0);
  assert.equal(result.details?.id, "durable-project-message");
});

function tempDataRoot(t: any): string {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "lead-coordination-test-"));
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function hostWithDefaults(values: Record<string, unknown>): any {
  return new Proxy(values, {
    get(target, key: string) {
      return key in target ? target[key] : () => undefined;
    },
  });
}

function managerPeer(sessionId: string, build = HERDSMAN_BUILD, protocol = 1) {
  return {
    version: 2,
    build,
    messageProtocol: protocol,
    role: "manager",
    sessionKind: "ordinary",
    piSessionId: sessionId,
    paneId: `pane-${sessionId}`,
    tabId: `tab-${sessionId}`,
    workspaceId: `workspace-${sessionId}`,
    socket: "/peer-test.sock",
    claim: { id: `generation-${sessionId}`, pid: 1, startedAt: 1 },
    updatedAt: 1,
  };
}

function peerQueueFixture(
  records: Map<string, any>,
  overrides: Record<string, unknown> = {},
) {
  const sessionId = [...records.keys()][0]!;
  let coordinationState: any = {
    instanceId: "peer-coordination-instance",
    piSessionId: sessionId,
    build: HERDSMAN_BUILD,
    messageProtocol: 1,
    role: "manager",
  };
  const context = fakeContext() as any;
  context.sessionManager.getSessionId = () => sessionId;
  const written: any[] = [];
  const runtime = createLeadCoordinationRuntime(
    hostWithDefaults({
      pi: {},
      leadRuntime: {
        controllerRole: "lead",
        chiefMode: "inactive",
        roleSuspended: false,
      },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "manager",
      HERDSMAN_BUILD,
      leadInstanceId: () => coordinationState.instanceId,
      readLeadCoordinationState: () => coordinationState,
      supervisionRuntime: () => ({}),
      peerRuntime: () => ({}),
      readPeerLeadRecord: (_runtime: unknown, id: string) => records.get(id),
      samePeerLeadGeneration,
      samePeerLeadAuthority,
      canMessagePeer,
      sameRuntimeBuild,
      writeCoordinationMessage: (record: unknown) => written.push(record),
      ...overrides,
    }),
  );
  return {
    runtime,
    context,
    written,
    setCoordinationState: (state: unknown) => {
      coordinationState = state;
    },
  };
}

test("local peers with protocol 1 can message across builds", async (t) => {
  tempDataRoot(t);
  const senderId = randomUUID();
  const targetId = randomUUID();
  const sender = managerPeer(senderId);
  const target = managerPeer(targetId, OTHER_HERDSMAN_BUILD);
  const fixture = peerQueueFixture(
    new Map([
      [senderId, sender],
      [targetId, target],
    ]),
  );

  const record = await fixture.runtime.queuePeerRecord(
    "cross-build message",
    targetId,
    fixture.context,
    sender,
    target,
  );

  assert.equal(record.messageProtocol, 1);
  assert.deepEqual(fixture.written, [record]);
});

test("local peer messaging rejects missing participant protocol and a changed generation", async (t) => {
  tempDataRoot(t);
  for (const [senderProtocol, targetProtocol, error] of [
    [undefined, 1, /Local peer messaging protocol changed/u],
    [1, undefined, /Peer messaging protocol 1 is required/u],
    [2, 1, /Local peer messaging protocol changed/u],
  ] as const) {
    const senderId = randomUUID();
    const targetId = randomUUID();
    const sender = managerPeer(senderId, HERDSMAN_BUILD, senderProtocol as any);
    const target = managerPeer(
      targetId,
      OTHER_HERDSMAN_BUILD,
      targetProtocol as any,
    );
    if (senderProtocol === undefined) delete sender.messageProtocol;
    if (targetProtocol === undefined) delete target.messageProtocol;
    const fixture = peerQueueFixture(
      new Map([
        [senderId, sender],
        [targetId, target],
      ]),
    );
    await assert.rejects(
      fixture.runtime.queuePeerRecord(
        "blocked",
        targetId,
        fixture.context,
        sender,
        target,
      ),
      error,
    );
    assert.deepEqual(fixture.written, []);
  }

  const senderId = randomUUID();
  const targetId = randomUUID();
  const sender = managerPeer(senderId);
  const target = managerPeer(targetId, OTHER_HERDSMAN_BUILD);
  let targetReads = 0;
  const fixture = peerQueueFixture(
    new Map([
      [senderId, sender],
      [targetId, target],
    ]),
    {
      readPeerLeadRecord: (_runtime: unknown, id: string) => {
        if (id !== targetId || ++targetReads < 2)
          return id === senderId ? sender : target;
        return { ...target, claim: { ...target.claim, id: "new-generation" } };
      },
    },
  );
  await assert.rejects(
    fixture.runtime.queuePeerRecord(
      "stale generation",
      targetId,
      fixture.context,
      sender,
      target,
    ),
    /assignment changed/u,
  );
  assert.deepEqual(fixture.written, []);
});

test("local peer messaging still requires the sender's current build evidence", async (t) => {
  tempDataRoot(t);
  const senderId = randomUUID();
  const targetId = randomUUID();
  const sender = managerPeer(senderId);
  const target = managerPeer(targetId, OTHER_HERDSMAN_BUILD);
  const fixture = peerQueueFixture(
    new Map([
      [senderId, sender],
      [targetId, target],
    ]),
    {
      readLeadCoordinationState: () => ({
        instanceId: "peer-coordination-instance",
        piSessionId: senderId,
        build: OTHER_HERDSMAN_BUILD,
        role: "manager",
      }),
    },
  );
  await assert.rejects(
    fixture.runtime.queuePeerRecord(
      "stale local build",
      targetId,
      fixture.context,
      sender,
      target,
    ),
    /coordination state changed/u,
  );
  assert.deepEqual(fixture.written, []);
});

test("local peer publication requires current coordination protocol evidence", async (t) => {
  tempDataRoot(t);
  const cases = [
    {
      state: (_sessionId: string) => undefined,
      error: /coordination state changed/u,
    },
    {
      state: (sessionId: string) => ({
        instanceId: "peer-coordination-instance",
        piSessionId: sessionId,
        build: HERDSMAN_BUILD,
        role: "manager",
      }),
      error: /messaging protocol changed/u,
    },
    {
      state: (sessionId: string) => ({
        instanceId: "peer-coordination-instance",
        piSessionId: sessionId,
        messageProtocol: 2,
        build: HERDSMAN_BUILD,
        role: "manager",
      }),
      error: /messaging protocol changed/u,
    },
  ];

  for (const { state: currentState, error } of cases) {
    const senderId = randomUUID();
    const targetId = randomUUID();
    const sender = managerPeer(senderId);
    const target = managerPeer(targetId, OTHER_HERDSMAN_BUILD);
    const fixture = peerQueueFixture(
      new Map([
        [senderId, sender],
        [targetId, target],
      ]),
      { readLeadCoordinationState: () => currentState(senderId) },
    );
    await assert.rejects(
      fixture.runtime.queuePeerRecord(
        "blocked",
        targetId,
        fixture.context,
        sender,
        target,
      ),
      error,
    );
    assert.deepEqual(fixture.written, []);
  }
});

test("local peer publication revalidates coordination after async preparation", async (t) => {
  tempDataRoot(t);
  for (const changedState of [
    undefined,
    {
      instanceId: "peer-coordination-instance",
      piSessionId: "sender",
      build: HERDSMAN_BUILD,
      messageProtocol: 2,
      role: "manager",
    },
  ]) {
    const senderId = randomUUID();
    const targetId = randomUUID();
    const sender = managerPeer(senderId);
    const target = managerPeer(targetId, OTHER_HERDSMAN_BUILD);
    let fixture!: ReturnType<typeof peerQueueFixture>;
    fixture = peerQueueFixture(
      new Map([
        [senderId, sender],
        [targetId, target],
      ]),
      {
        leadRuntime: {
          controllerRole: "manager",
          managerLease: { descriptor: { leaseId: "live-manager" } },
          chiefMode: "inactive",
          roleSuspended: false,
        },
        currentManager: async () => {
          await Promise.resolve();
          fixture.setCoordinationState(
            changedState
              ? { ...changedState, piSessionId: senderId }
              : undefined,
          );
          return { leaseId: "live-manager" };
        },
      },
    );

    await assert.rejects(
      fixture.runtime.queuePeerRecord(
        "blocked after preparation",
        targetId,
        fixture.context,
        sender,
        target,
      ),
      /coordination state changed|messaging protocol changed/u,
    );
    assert.deepEqual(fixture.written, []);
  }
});

test("local assigned peer scope is revalidated before message eligibility", async (t) => {
  tempDataRoot(t);
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/peer-test.sock";
  t.after(() => {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  });
  const senderId = randomUUID();
  const context = fakeContext() as any;
  context.sessionManager.getSessionId = () => senderId;
  const lead = {
    ...managerPeer("assigned-peer"),
    role: "lead",
    sessionKind: "managed",
    socket: "/peer-test.sock",
    workspaceId: "assigned-workspace",
    group: { repoKey: "repo-a", primaryWorkspaceId: "primary" },
  };
  const runtime = createLeadCoordinationRuntime(
    hostWithDefaults({
      pi: {},
      leadRuntime: { chiefMode: "inactive", roleSuspended: false },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "lead",
      HERDSMAN_BUILD,
      worktreeGroupScope: async () => ({
        repoKey: "repo-b",
        primaryWorkspaceId: "primary",
        workspaceIds: ["assigned-workspace"],
      }),
    }),
  );
  const assignments = new Map([
    [
      lead.piSessionId,
      [
        {
          socketHash: createHash("sha256").update(lead.socket).digest("hex"),
          assignment: { repoKey: "repo-a" },
        },
      ],
    ],
  ]);

  assert.equal(
    await runtime.peerContext(lead, context, assignments, true),
    undefined,
  );
});

test("ordinary coordinator messages are protocol-tagged while automatic records remain strict", async () => {
  const sessionId = randomUUID();
  const instanceId = randomUUID();
  const context = fakeContext() as any;
  context.sessionManager.getSessionId = () => sessionId;
  const state = {
    instanceId,
    piSessionId: sessionId,
    build: HERDSMAN_BUILD,
    role: "lead",
  };
  const chief = {
    piSessionId: randomUUID(),
    leaseId: "chief-lease",
    messageProtocol: 1,
  };
  const written: any[] = [];
  const policies: unknown[] = [];
  const runtime = createLeadCoordinationRuntime(
    hostWithDefaults({
      pi: {},
      leadRuntime: {
        controllerRole: "lead",
        chiefMode: "inactive",
        roleSuspended: false,
      },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "lead",
      HERDSMAN_BUILD,
      supervisionRuntime: () => ({}),
      leadInstanceId: () => instanceId,
      readLeadCoordinationState: () => state,
      sameRuntimeBuild,
      currentSupervisor: async (_ctx: unknown, policy: unknown) => {
        policies.push(policy);
        return chief;
      },
      writeChiefMessage: (record: unknown) => written.push(record),
    }),
  );

  await runtime.queueChiefRecord("lead_message", "automatic result", context);
  await runtime.queueChiefRecord(
    "lead_message",
    "ordinary message",
    context,
    randomUUID(),
    Date.now(),
    undefined,
    undefined,
    [],
    1,
  );

  assert.equal(written[0].messageProtocol, undefined);
  assert.equal(written[1].messageProtocol, 1);
  assert.deepEqual(policies, [
    undefined,
    undefined,
    "identity-only",
    "identity-only",
  ]);
});

function projectMessageDrainFixture(
  kind?: string,
  protocol?: number,
  existingReceipt = false,
  messageOverrides: Record<string, unknown> = {},
  invalidHeaderIssue?: ProjectMessageHeaderIssue,
  useRealHeaderReader = false,
  persistSourceIdentity = true,
  persistLiveEvidence = true,
) {
  process.env.PI_CODING_AGENT_DIR ??= testTmpRoot;
  const manager = {
    piSessionId: "manager-session",
    repoKey: "message-repo",
    leaseId: "manager-lease",
    createdAt: 100,
  };
  const assignment = {
    version: 2,
    id: useRealHeaderReader ? randomUUID() : "assigned-lead",
    repoKey: manager.repoKey,
    branch: "assigned-branch",
    text: "assigned task",
    ...(useRealHeaderReader
      ? {
          checkoutPath: tmpdir(),
          piSessionFile: join(tmpdir(), `${randomUUID()}.jsonl`),
        }
      : {}),
  };
  const probeRuntime = supervisionRuntime(
    `/tmp/project-message-drain-${randomUUID()}.sock`,
  );
  const assignmentFile = projectAssignmentPath(
    probeRuntime,
    manager.repoKey,
    assignment.branch,
  );
  if (useRealHeaderReader) {
    writeProjectAssignment(probeRuntime, assignment as any);
    if (persistSourceIdentity) {
      const sourceStatePath = leadCoordinationStatePath(
        probeRuntime,
        assignment.id,
      );
      mkdirSync(dirname(sourceStatePath), { recursive: true });
      writeFileSync(
        sourceStatePath,
        JSON.stringify({
          version: 1,
          build: OTHER_HERDSMAN_BUILD,
          role: "lead",
          instanceId: randomUUID(),
          piSessionId: assignment.id,
          updatedAt: 50,
          messageProtocol: 2,
        }),
      );
    }
  }
  const sourcePeers = peerRuntime();
  let liveEvidenceEnabled = persistLiveEvidence;
  let sourcePresenceLease: ReturnType<typeof acquireProcessLock> | undefined;
  const publishLiveEvidence = () => {
    liveEvidenceEnabled = true;
    sourcePresenceLease ??= acquireProcessLock(
      peerLeadLockPath(sourcePeers, assignment.id),
      { name: "project-message source test presence" },
    );
    const peerPath = peerLeadRecordPath(sourcePeers, assignment.id);
    writeFileSync(
      peerPath,
      JSON.stringify({
        version: 2,
        build: OTHER_HERDSMAN_BUILD,
        messageProtocol: 2,
        role: "lead",
        sessionKind: "managed",
        piSessionId: assignment.id,
        paneId: "source-pane",
        tabId: "source-tab",
        workspaceId: "source-workspace",
        socket: "source-socket",
        group: {
          repoKey: assignment.repoKey,
          primaryWorkspaceId: "source-workspace",
        },
        claim: sourcePresenceLease.claim,
        updatedAt: 50,
      }),
    );
  };
  if (useRealHeaderReader && persistLiveEvidence) {
    publishLiveEvidence();
  }
  const messageDirectory = join(
    dirname(assignmentFile),
    `${basename(assignmentFile, ".json")}.messages`,
  );
  mkdirSync(messageDirectory, { recursive: true });
  const persistedHeaderPath = join(messageDirectory, `${randomUUID()}.json`);
  writeFileSync(persistedHeaderPath, "{}");
  const header: any = {
    version: 2,
    id: useRealHeaderReader
      ? basename(persistedHeaderPath, ".json")
      : "project-message-id",
    repoKey: manager.repoKey,
    branch: assignment.branch,
    fromSessionId: assignment.id,
    createdAt: 50,
  };
  const message: any = {
    ...header,
    text: "project message",
    ...messageOverrides,
  };
  if (kind !== undefined) {
    header.kind = kind;
    message.kind = kind;
  }
  if (protocol !== undefined) {
    header.messageProtocol = protocol;
    message.messageProtocol = protocol;
  }
  if (useRealHeaderReader)
    writeFileSync(persistedHeaderPath, JSON.stringify(message));
  const entries: any[] = existingReceipt
    ? [
        {
          customType: "pi-herdsman-project_message",
          details: {
            id: header.id,
            repoKey: header.repoKey,
            branch: header.branch,
            fromSessionId: header.fromSessionId,
          },
        },
      ]
    : [];
  const context = fakeContext() as any;
  context.isIdle = () => true;
  context.sessionManager.getEntries = () => entries;
  const imported: unknown[] = [];
  const delivered: any[] = [];
  const removed: string[] = [];
  const errors: unknown[] = [];
  let reads = 0;
  const runtime = createLeadCoordinationRuntime(
    hostWithDefaults({
      pi: {
        sendMessage(value: unknown, options: unknown) {
          delivered.push({ value, options });
          entries.push({
            customType: value && (value as any).customType,
            details: (value as any).details,
          });
        },
      },
      leadRuntime: {
        controllerRole: "manager",
        managerLease: { descriptor: manager },
        chiefMode: "inactive",
        roleSuspended: false,
      },
      processRole: "lead",
      controllerScope: { kind: "root" },
      activeRole: () => "manager",
      sameRuntimeBuild,
      supervisionRuntime: () => probeRuntime,
      peerRuntime: () => sourcePeers,
      listPeerLeadRecordsForDiscovery,
      liveAgent: async (
        _ctx: unknown,
        sessionId: string,
        sessionPath?: string,
      ) =>
        liveEvidenceEnabled &&
        sessionId === assignment.id &&
        sessionPath === assignment.piSessionFile
          ? [
              {
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: assignment.id,
                },
                pane_id: "source-pane",
                tab_id: "source-tab",
                workspace_id: "source-workspace",
                cwd: assignment.checkoutPath,
              },
            ]
          : [],
      currentManager: async () => manager,
      sameManagerDescriptor: (left: any, right: any) =>
        left?.piSessionId === right?.piSessionId &&
        left?.leaseId === right?.leaseId,
      listProjectAssignments: useRealHeaderReader
        ? listProjectAssignments
        : () => [assignment],
      listProjectMessageHeaders: useRealHeaderReader
        ? listProjectMessageHeaders
        : (
            _runtime: unknown,
            _repoKey: string,
            _branch: string,
            onInvalid?: (issue: ProjectMessageHeaderIssue) => void,
          ) => {
            if (invalidHeaderIssue) onInvalid?.(invalidHeaderIssue);
            return [header];
          },
      readProjectAssignment: useRealHeaderReader
        ? readProjectAssignment
        : () => assignment,
      readProjectMessage: () => {
        reads++;
        return message;
      },
      removeProjectMessage: (
        _runtime: unknown,
        _repo: string,
        _branch: string,
        id: string,
      ) => removed.push(id),
      importResultBindings: (...args: unknown[]) => imported.push(args),
      appendDurableError: (
        _pi: unknown,
        _ctx: unknown,
        _type: string,
        error: unknown,
      ) => errors.push(error),
    }),
  );
  return {
    runtime,
    context,
    probeRuntime,
    sourcePeers,
    assignment,
    sourceSessionId: assignment.id,
    recordId: header.id,
    headerPath: persistedHeaderPath,
    publishLiveEvidence,
    releaseSourcePresence: () => {
      sourcePresenceLease?.release();
    },
    imported,
    delivered,
    removed,
    errors,
    get reads() {
      return reads;
    },
  };
}

test("project messages without verified source evidence stay pending without protocol attribution", async () => {
  for (const protocol of [undefined, 2]) {
    const fixture = projectMessageDrainFixture(
      "supervisor_message",
      protocol,
      true,
    );
    assert.equal(
      await fixture.runtime.drainProjectMessages(fixture.context),
      0,
    );
    assert.equal(fixture.reads, 0);
    assert.deepEqual(fixture.imported, []);
    assert.deepEqual(fixture.delivered, []);
    assert.deepEqual(fixture.removed, []);
    assert.match(
      String(fixture.errors[0]),
      /Malformed explicit project message/u,
    );
    const diagnostics = takeProtocolDiagnostics(
      fixture.context.sessionManager.getSessionId(),
    );
    assert.deepEqual(diagnostics, []);
  }
});

test("real project header validation reports unsupported protocol without delivery", async () => {
  const fixture = projectMessageDrainFixture(
    "supervisor_message",
    2,
    false,
    {
      text: "private supervisor text",
      resultBindings: [
        { ref: "private attachment ref", canonicalRef: "result:secret" },
      ],
    },
    undefined,
    true,
  );
  assert.equal(
    listProjectAssignments(fixture.probeRuntime, fixture.assignment.repoKey)
      .length,
    1,
  );
  assert.equal(
    readLeadCoordinationStateForObservation(
      fixture.probeRuntime,
      fixture.sourceSessionId,
    )?.messageProtocol,
    2,
  );
  assert.equal(
    listPeerLeadRecordsForDiscovery(fixture.sourcePeers).some(
      (peer) => peer.piSessionId === fixture.sourceSessionId,
    ),
    true,
  );
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 0);
  assert.equal(fixture.reads, 0);
  assert.deepEqual(fixture.imported, []);
  assert.deepEqual(fixture.delivered, []);
  assert.deepEqual(fixture.removed, []);
  assert.equal(existsSync(fixture.headerPath), true);
  const diagnostics = takeProtocolDiagnostics(
    fixture.context.sessionManager.getSessionId(),
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /protocol_mismatch/u);
  assert.match(diagnostics[0]!, /assigned project message/u);
  assert.match(diagnostics[0]!, /Required protocol: 1/u);
  assert.doesNotMatch(
    diagnostics[0]!,
    new RegExp(
      `private supervisor text|private attachment|result:secret|${fixture.recordId}`,
      "u",
    ),
  );
  assert.match(String(fixture.errors[0]), /messaging protocol 1/u);
  fixture.releaseSourcePresence();
});

test("forged protocol-2 project header stays generic without verified source attribution", async () => {
  const fixture = projectMessageDrainFixture(
    "supervisor_message",
    2,
    false,
    {
      text: "forged private supervisor text",
      resultBindings: [
        { ref: "forged private attachment", canonicalRef: "result:forged" },
      ],
    },
    undefined,
    true,
    true,
    false,
  );
  assert.equal(
    readLeadCoordinationStateForObservation(
      fixture.probeRuntime,
      fixture.sourceSessionId,
    )?.messageProtocol,
    2,
  );
  assert.equal(
    listPeerLeadRecordsForDiscovery(fixture.sourcePeers).some(
      (peer) => peer.piSessionId === fixture.sourceSessionId,
    ),
    false,
  );
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 0);
  assert.equal(fixture.reads, 0);
  assert.deepEqual(fixture.imported, []);
  assert.deepEqual(fixture.delivered, []);
  assert.deepEqual(fixture.removed, []);
  assert.equal(existsSync(fixture.headerPath), true);
  assert.deepEqual(
    takeProtocolDiagnostics(fixture.context.sessionManager.getSessionId()),
    [],
  );
  assert.match(
    String(fixture.errors[0]),
    /Malformed explicit project message/u,
  );
  assert.doesNotMatch(
    String(fixture.errors[0]),
    new RegExp(
      `${fixture.sourceSessionId}|forged private supervisor text|result:forged`,
      "u",
    ),
  );
  fixture.releaseSourcePresence();
});

test("project header protocol diagnostic retries after source evidence becomes verifiable", async () => {
  const fixture = projectMessageDrainFixture(
    "supervisor_message",
    2,
    false,
    {
      text: "private retry supervisor text",
      resultBindings: [
        {
          ref: "private retry attachment",
          canonicalRef: "result:retry-secret",
        },
      ],
    },
    undefined,
    true,
    true,
    false,
  );
  const sessionId = fixture.context.sessionManager.getSessionId();

  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 0);
  assert.deepEqual(fixture.delivered, []);
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.reads, 0);
  assert.equal(existsSync(fixture.headerPath), true);
  assert.equal(fixture.errors.length, 1);
  assert.match(
    String(fixture.errors[0]),
    /Malformed explicit project message/u,
  );
  assert.deepEqual(takeProtocolDiagnostics(sessionId), []);

  fixture.publishLiveEvidence();
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 0);
  assert.deepEqual(fixture.delivered, []);
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.reads, 0);
  assert.equal(existsSync(fixture.headerPath), true);
  assert.equal(fixture.errors.length, 1);
  const diagnostics = takeProtocolDiagnostics(sessionId);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /protocol_mismatch/u);
  assert.match(diagnostics[0]!, /assigned project message/u);
  assert.doesNotMatch(
    diagnostics[0]!,
    new RegExp(
      `private retry supervisor text|private retry attachment|result:retry-secret|${fixture.recordId}|${fixture.sourceSessionId}`,
      "u",
    ),
  );

  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 0);
  assert.deepEqual(takeProtocolDiagnostics(sessionId), []);
  assert.equal(fixture.errors.length, 1);
  assert.deepEqual(fixture.delivered, []);
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.reads, 0);
  assert.equal(existsSync(fixture.headerPath), true);
  fixture.releaseSourcePresence();
});

test("protocol-1 assigned-Lead messages deliver and consume under current assignment", async () => {
  const fixture = projectMessageDrainFixture("supervisor_message", 1);
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 1);
  assert.equal(fixture.reads, 1);
  assert.equal(fixture.imported.length, 1);
  assert.equal(fixture.delivered.length, 1);
  assert.deepEqual(fixture.removed, ["project-message-id"]);
  assert.deepEqual(fixture.errors, []);
});

test("explicit assigned-Lead messages with a changed source remain pending", async () => {
  const fixture = projectMessageDrainFixture("supervisor_message", 1, false, {
    fromSessionId: "different-assignment",
  });
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 0);
  assert.equal(fixture.imported.length, 0);
  assert.equal(fixture.delivered.length, 0);
  assert.deepEqual(fixture.removed, []);
});

test("untagged automatic project results retain their existing delivery behavior", async () => {
  for (const [kind, options] of [
    [undefined, { triggerTurn: false }],
    ["execution_failure", { deliverAs: "followUp", triggerTurn: true }],
  ] as const) {
    const fixture = projectMessageDrainFixture(kind);
    assert.equal(
      await fixture.runtime.drainProjectMessages(fixture.context),
      1,
    );
    assert.deepEqual(fixture.delivered[0].options, options);
    assert.deepEqual(fixture.removed, ["project-message-id"]);
    assert.deepEqual(fixture.errors, []);
  }
});

test("a malformed explicit message without routing identity stays pending while automatic results drain", async () => {
  const invalidId = randomUUID();
  const fixture = projectMessageDrainFixture(
    undefined,
    undefined,
    false,
    {},
    {
      id: invalidId,
      reason: "malformed",
    },
  );
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 1);
  assert.equal(fixture.reads, 1);
  assert.equal(fixture.delivered.length, 1);
  assert.deepEqual(fixture.removed, ["project-message-id"]);
  assert.equal(fixture.removed.includes(invalidId), false);
  assert.match(
    String(fixture.errors[0]),
    /Malformed explicit project message/u,
  );
});

test("an oversized project message stays pending while automatic results drain", async () => {
  const oversizedId = randomUUID();
  const fixture = projectMessageDrainFixture(
    undefined,
    undefined,
    false,
    {},
    { id: oversizedId, reason: "oversized" },
  );
  assert.equal(await fixture.runtime.drainProjectMessages(fixture.context), 1);
  assert.equal(fixture.reads, 1);
  assert.equal(fixture.delivered.length, 1);
  assert.deepEqual(fixture.removed, ["project-message-id"]);
  assert.equal(fixture.removed.includes(oversizedId), false);
  assert.equal(
    String(fixture.errors[0]),
    "Error: Oversized project message is pending and was not delivered",
  );
});
