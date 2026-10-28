import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  COORDINATOR_TARGET_PATTERN,
  coordinatorTarget,
  rememberCoordinatorTarget,
  resolveCoordinatorTarget,
} from "./coordinator-target.ts";

const OWNER_SESSION_ID = "0190abc1-2345-7def-8123-456789abcdef";
const RECIPIENT_SESSION_ID = "0190abc1-2345-7def-8123-456789abcdee";
const ENTRY = "pi-herdsman-coordinator-target-v1";
const INVALID_SESSION_IDS = [
  "not/a-session",
  "session-id.",
  " 0190abc1-2345-7def-8123-456789abcdef",
  "0190abc1-2345-7def-8123-456789abcde-",
];

function fixture(sessionId = OWNER_SESSION_ID, entries: unknown[] = []) {
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type: "custom", customType: type, data });
    },
  } as unknown as ExtensionAPI;
  return { ctx, pi, entries };
}

test("coordinator targets are deterministic, role-scoped, and normalized", () => {
  const leadTarget = coordinatorTarget("lead", OWNER_SESSION_ID);
  assert.equal(leadTarget, "lead:t4mjqepa65");
  assert.equal(coordinatorTarget("lead", OWNER_SESSION_ID), leadTarget);
  assert.equal(
    coordinatorTarget("manager", OWNER_SESSION_ID),
    "manager:099y7rb03g",
  );
  assert.notEqual(coordinatorTarget("lead", RECIPIENT_SESSION_ID), leadTarget);

  const pattern = new RegExp(COORDINATOR_TARGET_PATTERN);
  assert.match(leadTarget, pattern);
  assert.match("lead:T4MJQEPA65", pattern);
  assert.doesNotMatch("lead:O4MJQEPA65", pattern);
  assert.doesNotMatch("LEAD:T4MJQEPA65", pattern);
  for (const sessionId of INVALID_SESSION_IDS) {
    assert.throws(() => coordinatorTarget("lead", sessionId));
  }
  assert.throws(() => coordinatorTarget("chief" as never, OWNER_SESSION_ID));
});

test("caller bindings persist once and resolve after session restoration", () => {
  const { ctx, pi, entries } = fixture();
  const target = rememberCoordinatorTarget(
    pi,
    ctx,
    "lead",
    RECIPIENT_SESSION_ID,
  );
  assert.equal(entries.length, 1);
  assert.deepEqual((entries[0] as any).data, {
    version: 1,
    ownerSessionId: OWNER_SESSION_ID,
    target,
    role: "lead",
    sessionId: RECIPIENT_SESSION_ID,
  });
  assert.equal(
    rememberCoordinatorTarget(pi, ctx, "lead", RECIPIENT_SESSION_ID),
    target,
  );
  assert.equal(entries.length, 1);

  const restored = fixture(OWNER_SESSION_ID, entries);
  assert.deepEqual(resolveCoordinatorTarget(restored.ctx, target), {
    role: "lead",
    sessionId: RECIPIENT_SESSION_ID,
  });
  const uppercaseSuffixTarget = `lead:${target
    .slice(target.indexOf(":") + 1)
    .toUpperCase()}`;
  assert.deepEqual(
    resolveCoordinatorTarget(restored.ctx, uppercaseSuffixTarget),
    { role: "lead", sessionId: RECIPIENT_SESSION_ID },
  );
  assert.throws(() =>
    resolveCoordinatorTarget(fixture("other-caller", entries).ctx, target),
  );
});

test("bindings on an abandoned branch must be rebound in the active branch", () => {
  const { ctx, pi, entries } = fixture();
  const target = rememberCoordinatorTarget(
    pi,
    ctx,
    "lead",
    RECIPIENT_SESSION_ID,
  );
  const activeBranch: unknown[] = [];
  (ctx.sessionManager as any).getBranch = () => activeBranch;
  (pi as any).appendEntry = (type: string, data: unknown) => {
    const entry = { type: "custom", customType: type, data };
    entries.push(entry);
    activeBranch.push(entry);
  };

  assert.throws(() => resolveCoordinatorTarget(ctx, target));
  assert.equal(
    rememberCoordinatorTarget(pi, ctx, "lead", RECIPIENT_SESSION_ID),
    target,
  );
  assert.equal(entries.length, 2);
  assert.equal(activeBranch.length, 1);
  assert.deepEqual(resolveCoordinatorTarget(ctx, target), {
    role: "lead",
    sessionId: RECIPIENT_SESSION_ID,
  });
});

test("absent, malformed, tampered, and conflicting bindings fail closed", () => {
  const target = coordinatorTarget("lead", RECIPIENT_SESSION_ID);
  assert.throws(() => resolveCoordinatorTarget(fixture().ctx, target));
  assert.throws(() => resolveCoordinatorTarget(fixture().ctx, "lead:t4mj"));

  for (const sessionId of INVALID_SESSION_IDS) {
    assert.throws(() =>
      rememberCoordinatorTarget(fixture().pi, fixture().ctx, "lead", sessionId),
    );
  }

  const invalidBindings = [
    {
      version: 2,
      ownerSessionId: OWNER_SESSION_ID,
      target,
      role: "lead",
      sessionId: RECIPIENT_SESSION_ID,
    },
    {
      version: 1,
      ownerSessionId: "other-owner",
      target,
      role: "lead",
      sessionId: RECIPIENT_SESSION_ID,
    },
    {
      version: 1,
      ownerSessionId: OWNER_SESSION_ID,
      target,
      role: "manager",
      sessionId: RECIPIENT_SESSION_ID,
    },
    {
      version: 1,
      ownerSessionId: OWNER_SESSION_ID,
      target,
      role: "lead",
      sessionId: INVALID_SESSION_IDS[0],
    },
    {
      version: 1,
      ownerSessionId: "session-id.",
      target,
      role: "lead",
      sessionId: RECIPIENT_SESSION_ID,
    },
    {
      version: 1,
      ownerSessionId: OWNER_SESSION_ID,
      target: "lead:0000000000",
      role: "lead",
      sessionId: RECIPIENT_SESSION_ID,
    },
    {
      version: 1,
      ownerSessionId: OWNER_SESSION_ID,
      target,
      role: "lead",
      sessionId: RECIPIENT_SESSION_ID,
      extra: true,
    },
  ];
  for (const data of invalidBindings) {
    const entries = [{ type: "custom", customType: ENTRY, data }];
    const resolve = () =>
      resolveCoordinatorTarget(fixture(OWNER_SESSION_ID, entries).ctx, target);
    if (
      data.sessionId === INVALID_SESSION_IDS[0] ||
      data.ownerSessionId === "session-id."
    ) {
      assert.throws(resolve, /Invalid canonical Pi session ID/);
    } else {
      assert.throws(resolve);
    }
    assert.throws(() =>
      rememberCoordinatorTarget(
        fixture(OWNER_SESSION_ID, entries).pi,
        fixture(OWNER_SESSION_ID, entries).ctx,
        "lead",
        RECIPIENT_SESSION_ID,
      ),
    );
  }

  const conflicting = [
    {
      type: "custom",
      customType: ENTRY,
      data: {
        version: 1,
        ownerSessionId: OWNER_SESSION_ID,
        target,
        role: "lead",
        sessionId: RECIPIENT_SESSION_ID,
      },
    },
    {
      type: "custom",
      customType: ENTRY,
      data: {
        version: 1,
        ownerSessionId: OWNER_SESSION_ID,
        target,
        role: "lead",
        sessionId: OWNER_SESSION_ID,
      },
    },
  ];
  assert.throws(() =>
    resolveCoordinatorTarget(
      fixture(OWNER_SESSION_ID, conflicting).ctx,
      target,
    ),
  );
});
