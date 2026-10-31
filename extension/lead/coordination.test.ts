import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { fakeContext, HERDSMAN_BUILD, testTmpRoot } from "../support.ts";
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
