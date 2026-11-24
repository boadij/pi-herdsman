import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { updateConfig } from "../config.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fakeContext, HERDSMAN_BUILD, testTmpRoot } from "../support.ts";
import { supervisionRuntime, writeProjectMessage } from "../supervision.ts";
import { createLeadCoordinationRuntime } from "./coordination.ts";

test("scoped peer presence follows the live master setting", async (t) => {
  t.after(() => updateConfig("peerCommunicationEnabled", undefined));
  const sessionId = randomUUID();
  const repoKey = "a".repeat(64);
  const records: any[] = [];
  let provenanceStarted!: () => void;
  const groupedRecordWritten = new Promise<void>((resolve) => {
    provenanceStarted = resolve;
  });
  const entries: SessionEntry[] = [
    {
      type: "custom",
      id: randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-herdsman-session-kind",
      data: { version: 1, sessionId, kind: "ordinary" },
    },
  ];
  const context = fakeContext(entries) as any;
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
        removePeerLeadRecord: () => {
          records.length = 0;
        },
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
    updateConfig("peerCommunicationEnabled", false);
    await runtime.schedulePeerPresence(context);
    assert.equal(records.length, 0);
    updateConfig("peerCommunicationEnabled", true);
    await runtime.schedulePeerPresence(context);
    await groupedRecordWritten;
    assert.ok(
      records.some(
        (record) =>
          record.group?.repoKey === repoKey &&
          record.group.primaryWorkspaceId === "primary-workspace",
      ),
    );
    updateConfig("peerCommunicationEnabled", false);
    await runtime.reconcileRemotePeers(context);
    assert.equal(records.length, 0);
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

test("Manager startup fan-in submits every ready project handoff non-triggeringly", async () => {
  const sessionId = randomUUID();
  const manager = { id: "manager-generation", repoKey: "repo", createdAt: 10 };
  const assignment = { id: "lead-session", branch: "branch" };
  const records = [1, 2, 3].map((index) => ({
    version: 2 as const,
    id: randomUUID(),
    repoKey: manager.repoKey,
    branch: assignment.branch,
    fromSessionId: assignment.id,
    kind: "direct_response" as const,
    text: `handoff ${index}`,
    createdAt: 20 + index,
  }));
  const sent: any[] = [];
  const storage = supervisionRuntime(
    join(testTmpRoot, `fan-in-${randomUUID()}`, "sock"),
  );
  for (const record of records) writeProjectMessage(record, storage);
  const context = fakeContext() as any;
  context.isIdle = () => true;
  context.sessionManager.getSessionId = () => sessionId;
  const runtime = createLeadCoordinationRuntime(
    new Proxy(
      {
        pi: {
          sendMessage: (message: unknown, options: unknown) =>
            sent.push({ message, options }),
        },
        leadRuntime: {
          chiefMode: "inactive",
          roleSuspended: false,
          managerLease: { descriptor: manager },
        },
        processRole: "lead",
        controllerScope: { kind: "root" },
        activeRole: () => "manager",
        supervisionRuntime: () => storage,
        mightHaveProjectMessages: () => true,
        currentManager: async () => manager,
        sameManagerDescriptor: () => true,
        listProjectAssignments: () => [assignment],
        listProjectMessageHeaders: () => records,
        readProjectAssignment: () => assignment,
        readProjectMessage: (
          _runtime: unknown,
          _repo: string,
          _branch: string,
          id: string,
        ) => records.find((record) => record.id === id),
        importResultBindings: () => {},
        removeProjectMessage: () => {},
        appendDurableError: () => {},
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
  const budget = { count: 0, bytes: 0 };
  runtime.beginProjectMessageStartup(context);
  context.isIdle = () => false;

  assert.equal(
    await runtime.drainProjectMessages(context, "startup", budget),
    3,
  );
  assert.equal(sent.length, 3);
  assert.deepEqual(
    sent.map(({ message, options }) => [
      message.details.id,
      options.triggerTurn,
    ]),
    records.map(({ id }) => [id, false]),
  );
  assert.equal(budget.count, 3);
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
  const entries: SessionEntry[] = [
    {
      type: "custom",
      id: randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-herdsman-session-kind",
      data: {
        version: 1,
        sessionId,
        kind: "managed",
        repoKey: "repo-key",
        branch: "managed-branch",
      },
    },
  ];
  const context = fakeContext(entries) as any;
  context.sessionManager.getSessionId = () => sessionId;

  await assert.rejects(
    runtime.supervisorMessage(
      "chief",
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

test("supervisor message authority and transitions", async (t) => {
  for (const scenario of [
    "manager",
    "lead",
    "recipient-changed",
    "manager-preparation",
    "chief-preparation",
    "role-preparation",
    "manager-queue",
    "failure-report",
  ] as const) {
    await t.test(scenario, async () => {
      const managerLeaseId = randomUUID();
      const chiefLeaseId = randomUUID();
      const sessionId = randomUUID();
      const chiefSessionId = randomUUID();
      let role =
        scenario === "lead" || scenario === "recipient-changed"
          ? "lead"
          : "manager";
      let manager = { leaseId: managerLeaseId };
      let chief = { leaseId: chiefLeaseId, piSessionId: chiefSessionId };
      let currentRecipient = chief;
      const prepared: any[] = [];
      const written: any[] = [];
      const context = fakeContext([
        {
          type: "custom",
          id: randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "pi-herdsman-session-kind",
          data: { version: 1, sessionId, kind: "ordinary" },
        },
      ] as SessionEntry[]) as any;
      context.sessionManager.getSessionId = () => sessionId;
      const leadRuntime = {
        chiefMode: "inactive",
        controllerRole: role,
        managerLease: { descriptor: manager },
      };
      let supervisorCalls = 0;
      const host = new Proxy(
        {
          pi: {},
          leadRuntime,
          controllerScope: { kind: "root" },
          activeRole: () => role,
          currentSupervisor: async () => {
            supervisorCalls++;
            if (scenario === "manager-queue" && supervisorCalls === 3) {
              manager = { leaseId: randomUUID() };
              leadRuntime.managerLease.descriptor = manager;
            }
            return currentRecipient;
          },
          workspaceId: () => "workspace",
          resolveEffectiveSupervisor: async () => {
            if (role === "manager") return { kind: "none" as const };
            const resolvedChief = chief;
            if (scenario === "recipient-changed")
              currentRecipient = {
                leaseId: randomUUID(),
                piSessionId: randomUUID(),
              };
            return { kind: "chief" as const, chief: resolvedChief };
          },
          currentManager: async () => manager,
          supervisionRuntime: () => ({}),
          leadInstanceId: () => "instance",
          readLeadCoordinationState: () => ({
            instanceId: "instance",
            piSessionId: sessionId,
            build: HERDSMAN_BUILD,
            role,
          }),
          sameRuntimeBuild: () => true,
          HERDSMAN_BUILD,
          resolveMessageFiles: () => [],
          messageLimits: async () => {
            if (scenario === "manager-preparation") {
              manager = { leaseId: randomUUID() };
              leadRuntime.managerLease.descriptor = manager;
            }
            if (scenario === "chief-preparation") {
              chief = { leaseId: randomUUID(), piSessionId: randomUUID() };
              currentRecipient = chief;
            }
            if (scenario === "role-preparation") role = "lead";
            return { inline: { bytes: 100000 }, mailbox: { bytes: 100000 } };
          },
          chiefMessageBytes: (record: unknown) => {
            prepared.push(record);
            return 1;
          },
          writeChiefMessage: (record: unknown) => written.push(record),
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
      const reportId = randomUUID();
      const operation =
        scenario === "failure-report"
          ? runtime.queueChiefRecord(
              "manager_message",
              "failure",
              context,
              reportId,
              undefined,
              undefined,
              undefined,
              [],
              undefined,
              null,
            )
          : runtime.supervisorMessage(
              "chief",
              "message",
              { message: "hello" },
              undefined,
              undefined,
              context,
            );
      if (
        scenario.includes("preparation") ||
        scenario === "manager-queue" ||
        scenario === "recipient-changed"
      ) {
        await assert.rejects(
          operation,
          /lease is no longer active|Supervisor authority is no longer active|Coordinator role changed|Supervisor relationship changed/,
        );
        assert.equal(written.length, 0);
        return;
      }
      const result = await operation;
      assert.equal(written.length, 1);
      assert.equal(
        written[0].kind,
        scenario === "lead" ? "lead_message" : "manager_message",
      );
      assert.equal(
        written[0].leaseId,
        scenario === "lead" ? chiefLeaseId : managerLeaseId,
      );
      assert.equal(written[0].toSessionId, chiefSessionId);
      if (scenario === "failure-report") assert.equal(written[0].id, reportId);
      else {
        assert.equal(prepared[0].kind, written[0].kind);
        assert.equal(prepared[0].leaseId, written[0].leaseId);
        assert.ok("content" in result);
        assert.match(result.content[0].text, /Message queued for chief/);
      }
    });
  }
});
