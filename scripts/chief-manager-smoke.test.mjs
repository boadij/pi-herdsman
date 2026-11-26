import assert from "node:assert/strict";
import test from "node:test";
import { matchesChiefManagerHandoff } from "./chief-manager-smoke.mjs";

test("Manager smoke accepts only the completed correlated persisted handoff", () => {
  const entry = {
    customType: "pi-herdsman-agent-result",
    details: {
      requestId: "request-1",
      piSessionId: "child-1",
      status: "completed",
    },
    content: "Agent result CHIEF_MANAGER_AGENT_COMPLETED",
  };
  assert.equal(matchesChiefManagerHandoff(entry, "request-1", "child-1"), true);
  assert.equal(matchesChiefManagerHandoff(entry, "wrong-request", "child-1"), false);
});
