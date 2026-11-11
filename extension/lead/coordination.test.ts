import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fakeContext, HERDSMAN_BUILD, testTmpRoot } from "../support.ts";
import { supervisionRuntime, writeProjectMessage } from "../supervision.ts";
import { createLeadCoordinationRuntime } from "./coordination.ts";

test("scoped peer presence writes its worktree group", async () => {
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
