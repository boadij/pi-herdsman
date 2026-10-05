import assert from "node:assert/strict";
import test from "node:test";
import { fakeContext, fakePi } from "../support.ts";
import register from "./pi-codex-context-sharing.ts";

const BOOTSTRAP_EVENT = "pi-herdsman:managed-agent-bootstrap";
const PCC_AVAILABLE = "pi-codex:context-sharing:available";
const PARTICIPANT_ID = "pi-codex/context-sharing";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeHarness(
  options: {
    canCreateChild?: boolean;
    identity?: { storage: string };
  } = {},
) {
  const pi = fakePi();
  const context = fakeContext() as any;
  const calls: unknown[][] = [];
  let adopted = 0;
  const binding = { protocol: 1, opaque: "binding" };
  const service = {
    protocol: 1,
    canCreateChild: (ctx: unknown) => {
      calls.push(["canCreateChild", ctx]);
      return options.canCreateChild ?? true;
    },
    describe: (ctx: unknown) => {
      calls.push(["describe", ctx]);
      return Object.hasOwn(options, "identity")
        ? options.identity
        : { storage: "remote" };
    },
    verify: async () => undefined,
    createChild: async (ctx: unknown, args: unknown) => {
      calls.push(["createChild", ctx, args]);
      return {
        binding,
        adopt: async () => {
          adopted++;
        },
      };
    },
    bind: async (ctx: unknown, value: unknown) => {
      calls.push(["bind", ctx, value]);
      return { storage: "remote" };
    },
    execute: async () => ({ content: [] }),
    registerRouter: () => () => undefined,
  };
  register(pi.pi as any);
  return {
    ...pi,
    context,
    calls,
    binding,
    service,
    get adopted() {
      return adopted;
    },
    async exposeService() {
      pi.pi.events.emit(PCC_AVAILABLE, service);
      await tick();
    },
  };
}

async function prepare(harness: ReturnType<typeof makeHarness>) {
  let prepareParticipant: (() => unknown | Promise<unknown>) | undefined;
  harness.pi.events.emit(BOOTSTRAP_EVENT, {
    protocol: 1,
    phase: "prepare",
    context: harness.context,
    agent: "worker-1",
    register(id: string, callback: () => unknown | Promise<unknown>) {
      assert.equal(id, PARTICIPANT_ID);
      prepareParticipant = callback;
    },
  });
  await tick();
  assert.ok(prepareParticipant);
  return prepareParticipant();
}

test("Remote prepare returns opaque binding and adopts on commit", async () => {
  const harness = makeHarness();
  await harness.exposeService();
  const result = (await prepare(harness)) as {
    payload: string;
    commit: () => Promise<void>;
  };

  assert.equal(
    JSON.stringify(harness.calls),
    JSON.stringify([
      ["canCreateChild", harness.context],
      ["describe", harness.context],
      ["createChild", harness.context, { name: "worker-1" }],
    ]),
  );
  assert.equal(result.payload, JSON.stringify(harness.binding));
  assert.equal(harness.adopted, 0);
  await result.commit();
  assert.equal(harness.adopted, 1);
});

test("safe prepare opt-outs do not create a PCC child", async (t) => {
  const cases = [
    { name: "service unavailable", service: false },
    { name: "sharing disabled", canCreateChild: false },
    { name: "no context identity", identity: undefined },
    { name: "session storage", identity: { storage: "session" } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const options: {
        canCreateChild?: boolean;
        identity?: { storage: string };
      } = {};
      if ("canCreateChild" in scenario)
        options.canCreateChild = scenario.canCreateChild;
      if ("identity" in scenario) options.identity = scenario.identity;
      const harness = makeHarness(options);
      if (scenario.service !== false) await harness.exposeService();

      assert.equal(await prepare(harness), undefined);
      assert.equal(
        harness.calls.some(([name]) => name === "createChild"),
        false,
      );
    });
  }
});

test("child initialize binds the decoded opaque binding", async () => {
  const harness = makeHarness();
  await harness.exposeService();
  const binding = { arbitrary: ["decoded", 7] };
  let initialize: (() => Promise<void>) | undefined;
  harness.pi.events.emit(BOOTSTRAP_EVENT, {
    protocol: 1,
    phase: "initialize",
    context: harness.context,
    agent: "worker-1",
    participant: { id: PARTICIPANT_ID, payload: JSON.stringify(binding) },
    accept(callback: () => Promise<void>) {
      initialize = callback;
    },
  });
  await tick();
  assert.ok(initialize);
  await initialize();
  assert.deepEqual(harness.calls.at(-1), ["bind", harness.context, binding]);
});

test("child initialize fails if PCC is unavailable", async () => {
  const harness = makeHarness();
  let initialize: (() => Promise<void>) | undefined;
  harness.pi.events.emit(BOOTSTRAP_EVENT, {
    protocol: 1,
    phase: "initialize",
    context: harness.context,
    agent: "worker-1",
    participant: { id: PARTICIPANT_ID, payload: "{}" },
    accept(callback: () => Promise<void>) {
      initialize = callback;
    },
  });
  await tick();
  assert.ok(initialize);
  await assert.rejects(initialize(), /context sharing is unavailable/u);
});

test("unrelated participants are ignored", async () => {
  const harness = makeHarness();
  let accepted = false;
  harness.pi.events.emit(BOOTSTRAP_EVENT, {
    protocol: 1,
    phase: "initialize",
    context: harness.context,
    agent: "worker-1",
    participant: { id: "another/integration", payload: "{}" },
    accept() {
      accepted = true;
    },
  });
  await tick();
  assert.equal(accepted, false);
});
