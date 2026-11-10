import assert from "node:assert/strict";
import { test } from "node:test";
import {
  includeFanInMessage,
  registerRecipientFanIn,
} from "./recipient-fan-in.ts";

function fanInApi() {
  const handlers: ((event: object, context: object) => Promise<unknown>)[] = [];
  const pi = {
    on: (
      _event: string,
      handler: (event: object, context: object) => Promise<unknown>,
    ) => {
      handlers.push(handler);
    },
  };
  return { pi, handlers };
}

test("recipient fan-in shares count and byte budgets across registered sources", async () => {
  const { pi, handlers } = fanInApi();
  const accepted = [0, 0];
  let largeContent = "x".repeat(200 * 1024);
  let maxPerSource = 20;
  for (let source = 0; source < 2; source++) {
    registerRecipientFanIn(pi as never, async (_ctx, _phase, budget) => {
      const content = largeContent;
      let submitted = 0;
      for (let index = 0; index < maxPerSource; index++) {
        if (!includeFanInMessage(budget, content)) break;
        submitted++;
      }
      accepted[source] += submitted;
      return submitted;
    });
  }

  const context = {};
  const countBoundary = { type: "startup" };
  // Small messages exercise the shared 32-message cap; both sources contribute.
  largeContent = "x";
  for (const handler of handlers) await handler(countBoundary, context);
  assert.deepEqual(accepted, [20, 12]);

  accepted.fill(0);
  largeContent = "x".repeat(200 * 1024);
  const byteBoundary = { type: "startup" };
  for (const handler of handlers) await handler(byteBoundary, context);
  assert.deepEqual(accepted, [1, 0]);

  // A new lifecycle event gets a fresh budget, and both sources run when room remains.
  accepted.fill(0);
  largeContent = "x".repeat(100 * 1024);
  maxPerSource = 1;
  const nextBoundary = { type: "startup" };
  for (const handler of handlers) await handler(nextBoundary, context);
  assert.deepEqual(accepted, [1, 1]);
});
