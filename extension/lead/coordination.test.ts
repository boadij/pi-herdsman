import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fakeContext } from "../support.ts";
import { supervisionRuntime } from "../supervision.ts";
import { createLeadCoordinationRuntime } from "./coordination.ts";

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
