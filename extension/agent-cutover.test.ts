import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { parseControlMarker } from "./mailbox.ts";
import { ownedAssignmentChildren } from "./agent-controller.ts";
import {
  controlMarker,
  fakeContext,
  fakePi,
  leadExec,
  managedState,
  recoveryIdentity,
  registerExtension,
  resetAgentMailbox,
  sessionAgentIdentity,
  setAgentEnvironment,
  setLeadEnvironment,
  WORKSPACE,
  agentMailboxPath,
  writeAgentState,
} from "./support.ts";

test("historical Agent assignment tool results still reconstruct ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-history-"));
  try {
    const entries = [
      ["agent_delegate", "11111111-1111-4111-8111-111111111111"],
      ["agent_continue", "22222222-2222-4222-8222-222222222222"],
    ].map(([toolName, sessionId], index) => {
      const sessionPath = join(root, `${index}.jsonl`);
      writeFileSync(sessionPath, "{}\n");
      return {
        type: "message",
        message: {
          role: "toolResult",
          toolName,
          details: {
            ok: true,
            owner_session_id: "33333333-3333-4333-8333-333333333333",
            session_id: sessionId,
            session_path: sessionPath,
            agent: `child-${index}`,
            definition: "scout",
          },
        },
      };
    });
    assert.deepEqual(
      ownedAssignmentChildren(
        entries,
        "33333333-3333-4333-8333-333333333333",
        true,
      ).map(({ label, id }) => ({ label, id })),
      [
        { label: "child-0", id: "11111111-1111-4111-8111-111111111111" },
        { label: "child-1", id: "22222222-2222-4222-8222-222222222222" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiplexed coordination tool aliases are absent", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);

  for (const name of ["agent", "chief", "peer", "staff"])
    assert.equal(
      pi.tools.some((tool) => tool.name === name),
      false,
      name,
    );
  assert.equal(
    pi.tools.some((tool) => tool.name === "worker"),
    false,
  );
  assert.equal(pi.commands.includes("agents"), true);
  assert.equal(pi.commands.includes("workers"), false);
  assert.equal(
    pi.entryRenderers.some(
      ({ customType }) => customType === "pi-herdsman-worker-definition",
    ),
    false,
  );
  for (const customType of [
    "pi-herdsman-worker-result",
    "pi-herdsman-worker-ask",
    "pi-herdsman-worker-stale",
  ])
    assert.equal(
      pi.messageRenderers.some(
        (renderer) => renderer.customType === customType,
      ),
      false,
      `legacy renderer registered: ${customType}`,
    );

  const notices: string[] = [];
  const context = fakeContext([]) as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  const command = pi.commandOptions.get("agents");
  await command.handler("agents", context);
  assert.deepEqual(notices, [
    "Usage: /agents stats | definitions | placement [tab|subtree|split] | stop",
  ]);
  pi.events.get("session_shutdown")?.[0]();
});

test("the legacy allowlist environment variable grants no agent capability", () => {
  const mailbox = setAgentEnvironment("legacy-allowlist-agent");
  process.env.PI_HERDSMAN_ALLOWED_WORKERS = JSON.stringify(["child"]);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  try {
    for (const name of [
      "agent_list",
      "agent_delegate",
      "agent_continue",
      "agent_steer",
      "agent_interrupt",
      "agent_reply",
      "agent_close",
      "agent_inspect",
      "agent_transcript",
    ])
      assert.equal(
        pi.tools.some((tool) => tool.name === name),
        false,
        name,
      );
    assert.equal(
      pi.tools.some((tool) => tool.name === "ask_owner"),
      true,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    delete process.env.PI_HERDSMAN_ALLOWED_WORKERS;
    resetAgentMailbox(mailbox);
  }
});

test("managed Agent surfaces distinguish delegation capability from leaf access", () => {
  const names = (pi: ReturnType<typeof fakePi>) =>
    pi.tools.map((tool) => tool.name).sort();
  const leafMailbox = setAgentEnvironment("leaf-surface-agent");
  const leaf = fakePi();
  registerExtension!(leaf.pi as never);
  assert.deepEqual(names(leaf), ["ask_owner"]);
  leaf.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(leafMailbox);

  const mailbox = setAgentEnvironment("delegating-surface-agent", ["scout"]);
  const delegating = fakePi();
  registerExtension!(delegating.pi as never);
  assert.deepEqual(
    names(delegating),
    [
      "ask_owner",
      "close_agent",
      "continue_agent",
      "delegate_agent",
      "inspect_agent",
      "interrupt_agent",
      "list_agents",
      "reply_agent",
      "steer_agent",
      "read_agent_transcript",
    ].sort(),
  );
  delegating.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("legacy V3 marker and definition metadata are not accepted", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  assert.equal(
    parseControlMarker(`__PI_HERDSMAN_WORKER_V3__:${id}`),
    undefined,
  );
  assert.equal(parseControlMarker(controlMarker(id)), id);
  assert.equal(
    sessionAgentIdentity(
      [
        {
          type: "custom",
          customType: "pi-herdsman-worker-definition",
          data: { name: "legacy" },
        },
      ],
      "current-session",
    ),
    undefined,
  );
});

test("current error codes replace the legacy label and busy codes", async () => {
  setLeadEnvironment();
  const duplicateLabel = "cutover-duplicate-agent";
  const duplicateIdentity = recoveryIdentity(duplicateLabel);
  const duplicateMailbox = agentMailboxPath(WORKSPACE, duplicateLabel);
  writeAgentState(
    duplicateMailbox,
    managedState(duplicateLabel, undefined, duplicateIdentity),
  );
  const duplicatePi = fakePi({
    exec: leadExec(
      duplicateLabel,
      "idle",
      duplicateIdentity.piSessionId,
      undefined,
      duplicateIdentity.piSessionId,
      duplicateIdentity,
    ),
  });
  registerExtension!(duplicatePi.pi as never);
  const duplicateResult = await duplicatePi.tools
    .find((tool) => tool.name === "delegate_agent")!
    .execute(
      "id",
      {
        definition: "agent",
        label: duplicateLabel,
        task: "duplicate",
      },
      undefined,
      undefined,
      fakeContext(),
    );
  assert.equal(duplicateResult.details.error.category, "agent_label_exists");
  assert.notEqual(
    duplicateResult.details.error.category,
    "worker_label_exists",
  );
  duplicatePi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(duplicateMailbox);

  setLeadEnvironment();
  const busyLabel = "cutover-busy-agent";
  const busyIdentity = recoveryIdentity(busyLabel);
  const busyMailbox = agentMailboxPath(WORKSPACE, busyLabel);
  writeAgentState(busyMailbox, {
    ...managedState(busyLabel, undefined, busyIdentity),
    agentDefinition: "agent",
  });
  const busyPi = fakePi({
    exec: leadExec(
      busyLabel,
      "idle",
      busyIdentity.piSessionId,
      undefined,
      busyIdentity.piSessionId,
      busyIdentity,
    ),
  });
  registerExtension!(busyPi.pi as never);
  try {
    const busyResult = await busyPi.tools
      .find((tool) => tool.name === "steer_agent")!
      .execute(
        "id",
        { agent: busyLabel, message: "busy" },
        undefined,
        undefined,
        fakeContext(),
      );
    assert.equal(busyResult.details.error.category, "agent_busy");
    assert.notEqual(busyResult.details.error.category, "worker_busy");
  } finally {
    busyPi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(busyMailbox);
  }
});

test("each Agent operation has its own schema without projection", () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const cases = [
    ["list_agents", {}, { agent: "target" }, []],
    [
      "delegate_agent",
      { definition: "scout", task: "work" },
      { definition: "scout", task: "work", session: "x" },
      ["definition", "task"],
    ],
    [
      "continue_agent",
      { session: "/tmp/session.jsonl", task: "work" },
      { session: "/tmp/session.jsonl", task: "work", agent: "x" },
      ["session", "task"],
    ],
    [
      "steer_agent",
      { agent: "worker", message: "change" },
      { agent: "worker", message: "change", session: "x" },
      ["agent", "message"],
    ],
    [
      "interrupt_agent",
      { agent: "worker", message: "replace" },
      { agent: "worker", message: "replace", task: "x" },
      ["agent", "message"],
    ],
    [
      "reply_agent",
      { agent: "worker", message: "decision" },
      { agent: "worker", message: "decision", session: "x" },
      ["agent", "message"],
    ],
    [
      "close_agent",
      { agent: "worker" },
      { agent: "worker", message: "x" },
      ["agent"],
    ],
    [
      "inspect_agent",
      { agent: "worker" },
      { agent: "worker", session: "x" },
      ["agent"],
    ],
    [
      "read_agent_transcript",
      { agent: "worker" },
      { agent: "worker", session: "x" },
      ["agent"],
    ],
  ] as const;
  for (const [name, valid, crossOperation, required] of cases) {
    const tool = pi.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing ${name}`);
    const schema = tool.parameters;
    assert.equal(schema.type, "object", name);
    assert.equal(schema.additionalProperties, false, name);
    assert.equal(schema.properties.action, undefined, name);
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      [...required].sort(),
      name,
    );
    assert.equal(Value.Check(schema, valid), true, `${name} valid input`);
    assert.equal(
      Value.Check(schema, crossOperation),
      false,
      `${name} rejects cross-operation fields`,
    );
    assert.equal(
      tool.prepareArguments,
      undefined,
      `${name} needs no projection`,
    );
  }
  pi.events.get("session_shutdown")?.[0]();
});
