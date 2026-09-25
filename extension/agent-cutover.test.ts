import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { parseControlMarker } from "./mailbox.ts";
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

test("legacy tool, command, selectors, grammar, and renderers stay absent", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);

  assert.equal(
    pi.tools.some((tool) => tool.name === "agent"),
    true,
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

  const tool = pi.tools.find((candidate) => candidate.name === "agent")!;
  const legacySelector = await tool.execute(
    "id",
    { action: "inspect", worker: "agent" },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(legacySelector.details.error.category, "invalid_request");
  assert.equal(legacySelector.details.error.message, "Invalid agent input");

  const notices: string[] = [];
  const context = fakeContext([]) as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  const command = pi.commandOptions.get("agents");
  await command.handler("agents", context);
  assert.deepEqual(notices, [
    "Usage: /agents definitions | placement [tab|subtree|split] | stop",
  ]);
  pi.events.get("session_shutdown")?.[0]();
});

test("the legacy allowlist environment variable grants no agent capability", () => {
  const mailbox = setAgentEnvironment("legacy-allowlist-agent");
  process.env.PI_HERDSMAN_ALLOWED_WORKERS = JSON.stringify(["child"]);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  try {
    assert.equal(
      pi.tools.some((tool) => tool.name === "agent"),
      false,
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
  const duplicateResult = await duplicatePi.tools[0].execute(
    "id",
    {
      action: "delegate",
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
  writeAgentState(
    busyMailbox,
    managedState(busyLabel, undefined, busyIdentity),
  );
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
    const busyResult = await busyPi.tools[0].execute(
      "id",
      { action: "steer", agent: busyLabel, message: "busy" },
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

test("agent schema exposes portable structure and canonicalizes action fields", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const schema = pi.tools.find((tool) => tool.name === "agent")!.parameters;
  assert.equal(schema.type, "object");
  assert.ok(schema.properties);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.allOf, undefined);
  assert.ok(schema.properties.label);
  assert.equal(schema.properties.fork, undefined);
  assert.equal(schema.properties.timeoutMs, undefined);
  assert.equal(
    Value.Check(schema, { action: "inspect", agent: "target" }),
    true,
  );
  assert.equal(
    Value.Check(schema, { action: "inspect", worker: "target" }),
    false,
  );
  assert.equal(
    Value.Check(schema, { action: "transcript", agent: "target" }),
    true,
  );
  assert.equal(
    Value.Check(schema, {
      action: "delegate",
      definition: "agent",
      label: "check-map",
      task: "fresh work",
    }),
    true,
  );
  assert.equal(
    Value.Check(schema, {
      action: "continue",
      session: "/tmp/session.jsonl",
      task: "continued work",
    }),
    true,
  );
  const toolCall = pi.events.get("tool_call")![0];
  const tool = pi.tools.find((candidate) => candidate.name === "agent")!;
  const prepareArguments = tool.prepareArguments;
  assert.equal(typeof prepareArguments, "function");
  const rawInput = {
    action: "delegate",
    definition: "agent",
    task: "inspect",
    session: null,
    agent: null,
    message: null,
  };
  const preparedInput = prepareArguments(rawInput);
  assert.deepEqual(rawInput, {
    action: "delegate",
    definition: "agent",
    task: "inspect",
    session: null,
    agent: null,
    message: null,
  });
  assert.notEqual(preparedInput, rawInput);
  assert.deepEqual(preparedInput, {
    action: "delegate",
    definition: "agent",
    task: "inspect",
  });
  assert.equal(Value.Check(schema, preparedInput), true);
  assert.equal(
    await toolCall({ toolName: "agent", input: preparedInput }, fakeContext()),
    undefined,
  );
  assert.deepEqual(preparedInput, {
    action: "delegate",
    definition: "agent",
    task: "inspect",
  });

  const removedFieldInput = {
    action: "delegate",
    definition: "agent",
    task: "inspect",
    fork: "removed",
  };
  prepareArguments(removedFieldInput);
  assert.equal(removedFieldInput.fork, "removed");
  assert.equal(Value.Check(schema, removedFieldInput), false);

  const input = {
    action: "delegate",
    definition: "agent",
    label: "check-map",
    task: "inspect",
    session: "none",
    agent: "none",
    message: "none",
    files: [],
  };
  assert.equal(Value.Check(schema, input), true);
  assert.equal(
    await toolCall({ toolName: "agent", input }, fakeContext()),
    undefined,
  );
  assert.deepEqual(input, {
    action: "delegate",
    definition: "agent",
    label: "check-map",
    task: "inspect",
  });

  const invalid = { action: "continue", task: "inspect" };
  assert.deepEqual(
    await toolCall({ toolName: "agent", input: invalid }, fakeContext()),
    { block: true, reason: "continue requires session", terminate: true },
  );
  pi.events.get("session_shutdown")?.[0]();
});
