import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import test from "node:test";
import { agentMailboxPath } from "./mailbox.ts";
import { supervisionRuntime } from "./supervision.ts";
import { herdsmanDataRoot } from "./tmp.ts";

test("recoverable Herdsman state lives under Pi agent data", () => {
  const root = join(getAgentDir(), "pi-herdsman");
  assert.equal(herdsmanDataRoot(), root);
  assert.equal(
    dirname(agentMailboxPath("workspace", "agent")),
    join(root, "runtime", "mailboxes-v4"),
  );
  assert.equal(
    dirname(supervisionRuntime("socket with spaces").root),
    join(root, "runtime", "supervision"),
  );
});
