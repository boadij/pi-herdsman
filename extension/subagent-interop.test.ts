import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentLaunchArgs,
  discoverAgentDefinitions,
} from "./agent-definitions.ts";
import { structuredTopologyEnvironment } from "./herdr.ts";

function withPiAgentDir<T>(callback: (agentDir: string) => T): T {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-herdsman-interop-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return callback(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("managed agents publish the active-agent convention", () => {
  const args = agentLaunchArgs(
    { name: "reviewer", path: "reviewer.md", frontmatter: {}, body: "" },
    { managedAgent: true },
  );
  assert.ok(args.includes("<active_agent name=\"reviewer\"/>"));

  const unmanaged = agentLaunchArgs(
    { name: "reviewer", path: "reviewer.md", frontmatter: {}, body: "" },
    { managedAgent: false },
  );
  assert.ok(!unmanaged.includes("<active_agent name=\"reviewer\"/>"));
});

test("managed launch environment publishes canonical subagent lineage", () => {
  const env = structuredTopologyEnvironment("workspace", [
    "PI_HERDSMAN_OWNER_SESSION_ID=parent-session",
    "PI_SUBAGENT_CHILD=stale",
    "PI_SUBAGENT_PARENT_SESSION=stale-parent",
    "EXTRA=value",
  ]);

  assert.ok(env.includes("PI_SUBAGENT_CHILD=1"));
  assert.ok(env.includes("PI_SUBAGENT_PARENT_SESSION=parent-session"));
  assert.ok(!env.includes("PI_SUBAGENT_CHILD=stale"));
  assert.ok(!env.includes("PI_SUBAGENT_PARENT_SESSION=stale-parent"));
  assert.ok(env.includes("EXTRA=value"));
});

test("permission frontmatter remains opaque but valid", () =>
  withPiAgentDir((agentDir) => {
    const agentsDir = join(agentDir, "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "custom.md"),
      `---\nname: custom\npermission:\n  "*": deny\n  read: allow\n  bash:\n    "*": deny\n    "git status": allow\n---\n`,
    );

    const definition = discoverAgentDefinitions().find(
      ({ name }) => name === "custom",
    );
    assert.deepEqual(definition?.frontmatter.permission, {
      "*": "deny",
      read: "allow",
      bash: { "*": "deny", "git status": "allow" },
    });
  }));
