import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { RequestRecord } from "./mailbox.ts";

const realLock = await import("./lock.ts");
const realMailbox = await import("./mailbox.ts");
const assignmentClaims = new Map<string, { id: string; released: boolean }[]>();
let assignmentMailbox: string | undefined;

const trackClaim = (mailbox: string, release: () => void): (() => void) => {
  const id = realLock.readLiveProcessLock(
    realLock.assignmentLockPath(mailbox),
    "test assignment lock",
  ).id;
  const claim = { id, released: false };
  const claims = assignmentClaims.get(mailbox) ?? [];
  claims.push(claim);
  assignmentClaims.set(mailbox, claims);
  return () => {
    claim.released = true;
    release();
  };
};

mock.module("./lock.ts", {
  namedExports: {
    ...realLock,
    claimAssignmentLock(mailbox: string) {
      return trackClaim(mailbox, realLock.claimAssignmentLock(mailbox));
    },
    tryClaimAssignmentLock(mailbox: string) {
      const release = realLock.tryClaimAssignmentLock(mailbox);
      return release ? trackClaim(mailbox, release) : undefined;
    },
  },
});
mock.module("./mailbox.ts", {
  namedExports: {
    ...realMailbox,
    writeRequest(mailbox: string, request: RequestRecord) {
      if (mailbox === assignmentMailbox) {
        const claims = assignmentClaims.get(mailbox) ?? [];
        assert.equal(
          claims.length,
          1,
          "publication must use one acquisition, not release and reacquire",
        );
        assert.equal(
          claims[0]!.released,
          false,
          "the acquired lock must remain held at request publication",
        );
        assert.equal(
          realLock.readLiveProcessLock(realLock.assignmentLockPath(mailbox)).id,
          claims[0]!.id,
          "publication must hold the exact lock claim acquired for submission",
        );
      }
      realMailbox.writeRequest(mailbox, request);
    },
  },
});

const support = await import("./support.ts");

test("startup hands one held assignment-lock claim through task publication", async (t) => {
  support.setLeadEnvironment();
  const label = "deterministic-startup-lock";
  const startup = support.startupExecutor(
    label,
    () => support.DEFAULT_PI_SESSION_ID,
  );
  assignmentMailbox = startup.mailbox;
  let releaseChildLock: (() => void) | undefined;
  let agentGetCount = 0;
  const pi = support.fakePi({
    exec: async (command, args, options) => {
      const result = await startup.exec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        assignmentClaims.delete(startup.mailbox);
        releaseChildLock = realLock.claimProcessLock(
          realLock.assignmentLockPath(startup.mailbox),
        );
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        agentGetCount++;
      return result;
    },
  });
  const context = support.fakeContext();
  support.registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  try {
    const resultPromise = pi.tools
      .find((tool) => tool.name === "delegate_agent")!
      .execute(
        "id",
        { definition: "agent", label, task: "publish under retained lock" },
        undefined,
        undefined,
        context,
      );

    await t.waitFor(() => {
      assert.ok(releaseChildLock, "child did not hold its startup lock");
      assert.ok(
        agentGetCount >= 2,
        "initial submission must finish integration validation while the child lock is held",
      );
    });
    assert.throws(() =>
      realLock.claimProcessLock(realLock.assignmentLockPath(startup.mailbox)),
    );
    releaseChildLock();
    releaseChildLock = undefined;

    const result = await resultPromise;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    releaseChildLock?.();
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    support.resetAgentMailbox(startup.mailbox);
    assignmentClaims.delete(startup.mailbox);
    assignmentMailbox = undefined;
  }
});
