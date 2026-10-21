import assert from "node:assert/strict";
import test from "node:test";
import {
  listRemotePeerOutbounds,
  parsePeerSshTarget,
  persistRemotePeerOutbound,
  removeRemotePeerOutbound,
} from "./peer-transport.ts";
import { randomUUID } from "node:crypto";

test("saved SSH targets preserve URI ports and SSH config aliases", () => {
  assert.deepEqual(parsePeerSshTarget("ssh://buildbox:2222"), {
    host: "buildbox",
    port: "2222",
  });
  assert.deepEqual(parsePeerSshTarget("ssh://user@buildbox:2222"), {
    host: "user@buildbox",
    port: "2222",
  });
  assert.deepEqual(parsePeerSshTarget("herdsman@buildbox"), {
    host: "herdsman@buildbox",
  });
  assert.deepEqual(parsePeerSshTarget("buildbox"), { host: "buildbox" });
});

test("remote peer outbox survives until acknowledged delivery", () => {
  const id = randomUUID();
  const outbound = {
    id,
    machine: {
      id: "test-machine",
      label: "test-machine",
      target: "ssh://test-machine:2222",
      reachable: true,
    },
    dataRoot: "/test/agent/pi-herdsman",
    session: randomUUID(),
    claimId: randomUUID(),
    envelope: JSON.stringify({ record: { id } }),
  };
  persistRemotePeerOutbound(outbound);
  assert.deepEqual(
    listRemotePeerOutbounds().find((item) => item.id === id),
    outbound,
  );
  removeRemotePeerOutbound(id);
  assert.equal(
    listRemotePeerOutbounds().some((item) => item.id === id),
    false,
  );
});

test("saved SSH targets reject URI paths and option-shaped aliases", () => {
  for (const target of [
    "ssh://buildbox/path",
    "ssh://buildbox?option=value",
    "ssh://buildbox#fragment",
    "ssh://user%20name@buildbox",
    "-oProxyCommand=evil",
    "buildbox with args",
  ])
    assert.throws(
      () => parsePeerSshTarget(target),
      /Unsupported saved SSH target/,
    );
});
