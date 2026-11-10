import assert from "node:assert/strict";
import { test } from "node:test";
import {
  includeFanInMessage,
  registerRecipientFanIn,
} from "./recipient-fan-in.ts";

function fanInApi() {
  const handlers: {
    event: string;
    handler: (event: object, context: object) => Promise<unknown>;
  }[] = [];
  const pi = {
    on: (
      event: string,
      handler: (event: object, context: object) => Promise<unknown>,
    ) => {
      handlers.push({ event, handler });
    },
  };
  return { pi, handlers };
}

test("one recipient handler shares budgets across sources despite per-handler event cloning", async () => {
  const { pi, handlers } = fanInApi();
  const accepted = [0, 0];
  const sourceBudgets: object[] = [];
  const boundaryBudgets: object[] = [];
  let largeContent = "x".repeat(200 * 1024);
  let maxPerSource = 20;
  const drainAgentNotifications = async (
    budget: Parameters<typeof includeFanInMessage>[0],
  ) => {
    sourceBudgets.push(budget);
    let submitted = 0;
    for (let index = 0; index < maxPerSource; index++) {
      if (!includeFanInMessage(budget, largeContent)) break;
      submitted++;
    }
    accepted[0] += submitted;
    return submitted;
  };
  const drainCoordinationInbox = async (
    budget: Parameters<typeof includeFanInMessage>[0],
  ) => {
    sourceBudgets.push(budget);
    let submitted = 0;
    for (let index = 0; index < maxPerSource; index++) {
      if (!includeFanInMessage(budget, largeContent)) break;
      submitted++;
    }
    accepted[1] += submitted;
    return submitted;
  };
  registerRecipientFanIn(pi as never, async (_ctx, _phase, budget) => {
    boundaryBudgets.push(budget);
    const agent = await drainAgentNotifications(budget);
    const coordination = await drainCoordinationInbox(budget);
    return agent + coordination;
  });
  assert.equal(handlers.filter(({ event }) => event === "turn_end").length, 1);

  const context = {};
  const dispatch = async (event: object) => {
    // Pi creates an event object separately for every registered callback.
    for (const { event: type, handler } of handlers)
      if (type === "turn_end") await handler({ ...event }, context);
  };
  const countBoundary = { type: "turn_end", outcome: "completed" };
  // Small messages exercise the shared 32-message cap; both sources contribute.
  largeContent = "x";
  await dispatch(countBoundary);
  assert.deepEqual(accepted, [20, 12]);
  assert.equal(sourceBudgets[0], sourceBudgets[1]);

  accepted.fill(0);
  largeContent = "x".repeat(200 * 1024);
  const byteBoundary = { type: "turn_end", outcome: "completed" };
  await dispatch(byteBoundary);
  assert.deepEqual(accepted, [1, 0]);
  assert.equal(sourceBudgets[2], sourceBudgets[3]);

  // A new lifecycle event gets a fresh budget, and both sources run when room remains.
  accepted.fill(0);
  largeContent = "x".repeat(100 * 1024);
  maxPerSource = 1;
  const nextBoundary = { type: "turn_end", outcome: "completed" };
  await dispatch(nextBoundary);
  assert.deepEqual(accepted, [1, 1]);
  assert.equal(sourceBudgets[4], sourceBudgets[5]);
  assert.notEqual(boundaryBudgets[0], boundaryBudgets[1]);
  assert.notEqual(boundaryBudgets[1], boundaryBudgets[2]);
});
