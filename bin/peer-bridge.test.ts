import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { acquireProcessLock } from "../extension/lock.ts";
import { herdsmanDataRoot } from "../extension/storage.ts";
import {
  chiefMessagePath,
  coordinationMessageDelivered,
  coordinationMessageDigest,
  drainCoordinationInbox,
  hasPeerDeliveryReceipt,
  peerRuntime,
  readCoordinationMessage,
  writeCoordinationMessage,
  writePeerDeliveryReceipt,
  writePeerLeadRecord,
  peerLeadLockPath,
  removePeerLeadRecord,
} from "../extension/supervision.ts";
import {
  listPeerCorrespondences,
  peerPayloadDigest,
  type PeerCorrespondence,
} from "../extension/peer-correspondence.ts";

const id = () => randomUUID();

test("bridge recovers after process death at both durable acceptance cut points", async () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-recovery-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const sessionId = id();
  const originSession = id();
  const leaseId = id();
  let claim = acquireProcessLock(peerLeadLockPath(peerRuntime(), sessionId), {
    name: "test Manager peer presence",
  });
  const peers = peerRuntime();
  let manager = {
    version: 2 as const,
    build: { version: "0.18.0", sha256: "a".repeat(64) },
    role: "manager" as const,
    sessionKind: "ordinary" as const,
    piSessionId: sessionId,
    paneId: "pane",
    tabId: "tab",
    workspaceId: "workspace",
    socket,
    claim: claim.claim,
    updatedAt: Date.now(),
  };
  try {
    writePeerLeadRecord(peers, manager);
    const runtime = peers;
    const scenarios = [
      { cut: "pending-marker-durable", consumed: false },
      { cut: "inbox-publication-durable", consumed: false },
      { cut: "inbox-publication-durable", consumed: true },
      { cut: "pending-marker-durable", consumed: false, retargetCrash: true },
      { cut: "pending-marker-durable", consumed: false, replacement: true },
    ] as const;
    for (const {
      cut,
      consumed,
      replacement = false,
      retargetCrash = false,
    } of scenarios) {
      const messageId = id();
      const record = {
        version: 2 as const,
        build: manager.build,
        id: messageId,
        leaseId,
        kind: "peer_message" as const,
        fromSessionId: originSession,
        toSessionId: sessionId,
        leadSessionId: sessionId,
        text: `message ${cut} ${consumed ? "consumed" : "queued"}`,
        peerSource: { role: "manager" as const },
        createdAt: Date.now(),
      };
      const correspondence: PeerCorrespondence = {
        id: id(),
        capability: "c".repeat(64),
        originSession,
        originGeneration: leaseId,
        recipientSession: sessionId,
        recipientGeneration: manager.claim.id,
        acceptanceId: messageId,
        replies: [],
      };
      const transfer = {
        record,
        attachments: [],
        correspondence,
        recipientClaimId: manager.claim.id,
        expectedDataRoot: herdsmanDataRoot(),
      };
      const markerDir = join(runtime.root, "peer-acceptances");
      const marker = join(
        markerDir,
        `${createHash("sha256")
          .update(`${originSession}\0${messageId}`)
          .digest("hex")}.json`,
      );
      const acceptCrash = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import=./bin/peer-bridge-kill-hook.test-support.mjs",
          "bin/peer-bridge.ts",
          "accept",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            HERDR_SOCKET_PATH: socket,
            SSH_CONNECTION: "test-ssh-connection",
            PEER_TEST_KILL_AFTER: cut,
          },
          input: `${JSON.stringify(transfer)}\n`,
          encoding: "utf8",
        },
      );
      assert.equal(acceptCrash.error, undefined, acceptCrash.stderr);
      assert.equal(JSON.parse(readFileSync(marker, "utf8")).status, "pending");
      if (cut === "pending-marker-durable")
        assert.throws(
          () =>
            readCoordinationMessage(
              chiefMessagePath(runtime, sessionId, messageId),
            ),
          /Unable to read Chief message/,
        );
      else
        assert.deepEqual(
          readCoordinationMessage(
            chiefMessagePath(runtime, sessionId, messageId),
          ),
          record,
          "inbox publication must be durable before process termination",
        );
      if (process.platform === "win32") {
        assert.notEqual(acceptCrash.status, 0, acceptCrash.stderr);
      } else {
        assert.equal(acceptCrash.status, null, acceptCrash.stderr);
        assert.equal(acceptCrash.signal, "SIGKILL", cut);
      }

      if (cut === "inbox-publication-durable" && consumed) {
        assert.deepEqual(
          readCoordinationMessage(
            chiefMessagePath(runtime, sessionId, messageId),
          ),
          record,
        );
        let submitted = 0;
        const history = [
          {
            customType: "pi-herdsman-peer_message",
            details: {
              id: record.id,
              leaseId: record.leaseId,
              fromSessionId: record.fromSessionId,
              leadSessionId: record.leadSessionId,
              digest: coordinationMessageDigest(record),
            },
          },
        ];
        await drainCoordinationInbox({
          runtime,
          sessionId,
          isAuthorized: () => true,
          isDelivered: () =>
            coordinationMessageDelivered(record, sessionId, history),
          sendMessage: () => submitted++,
          accepted: (delivered) => writePeerDeliveryReceipt(runtime, delivered),
        });
        assert.equal(submitted, 0);
        assert.equal(
          hasPeerDeliveryReceipt(
            runtime,
            sessionId,
            messageId,
            coordinationMessageDigest(record),
          ),
          true,
        );
        assert.throws(
          () =>
            readCoordinationMessage(
              chiefMessagePath(runtime, sessionId, messageId),
            ),
          /Unable to read Chief message/,
        );
      }
      claim.release();
      const recoverySession = replacement ? id() : sessionId;
      claim = acquireProcessLock(peerLeadLockPath(runtime, recoverySession), {
        name: "restarted test Manager peer presence",
      });
      manager = {
        ...manager,
        piSessionId: recoverySession,
        claim: claim.claim,
        updatedAt: Date.now(),
      };
      writePeerLeadRecord(runtime, manager);
      const digest = peerPayloadDigest({ record, attachments: [] });
      const statusRequest = JSON.stringify({
        id: messageId,
        originSession,
        recipientSession: sessionId,
        digest,
        expectedDataRoot: herdsmanDataRoot(),
      });
      if (retargetCrash) {
        const publishedCrash = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--import=./bin/peer-bridge-kill-hook.test-support.mjs",
            "bin/peer-bridge.ts",
            "status",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
              HERDR_SOCKET_PATH: socket,
              SSH_CONNECTION: "reconnected-ssh-connection",
              PEER_TEST_KILL_AFTER: "inbox-publication-durable",
            },
            input: `${statusRequest}\n`,
            encoding: "utf8",
          },
        );
        assert.equal(publishedCrash.error, undefined, publishedCrash.stderr);
        const pending = JSON.parse(readFileSync(marker, "utf8"));
        assert.equal(pending.status, "pending");
        assert.equal(pending.transfer.recipientClaimId, manager.claim.id);
        assert.equal(
          pending.transfer.correspondence.recipientGeneration,
          manager.claim.id,
        );
        assert.deepEqual(
          readCoordinationMessage(
            chiefMessagePath(runtime, sessionId, messageId),
          ),
          record,
          "inbox publication must be durable before process termination",
        );
        if (process.platform === "win32") {
          assert.notEqual(publishedCrash.status, 0, publishedCrash.stderr);
        } else {
          assert.equal(publishedCrash.status, null, publishedCrash.stderr);
          assert.equal(publishedCrash.signal, "SIGKILL");
        }
        removePeerLeadRecord(runtime, sessionId, manager);
        claim.release();
      }
      if (cut === "pending-marker-durable" && !replacement) {
        const failedPublication = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--import=./bin/peer-bridge-accepted-write-failure.test-support.mjs",
            "bin/peer-bridge.ts",
            "status",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
              HERDR_SOCKET_PATH: socket,
              SSH_CONNECTION: "reconnected-ssh-connection",
            },
            input: `${statusRequest}\n`,
            encoding: "utf8",
          },
        );
        assert.notEqual(failedPublication.status, 0, failedPublication.stderr);
        assert.match(
          failedPublication.stderr,
          /injected accepted marker publication failure/,
        );
        assert.equal(
          JSON.parse(readFileSync(marker, "utf8")).status,
          "pending",
        );
        assert.equal(
          readdirSync(join(runtime.root, "peer-acceptances")).some((name) =>
            name.endsWith(".tmp"),
          ),
          false,
          "failed accepted-marker publication removes its exact temporary file",
        );
      }
      const output = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "bin/peer-bridge.ts", "status"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            HERDR_SOCKET_PATH: socket,
            SSH_CONNECTION: "reconnected-ssh-connection",
          },
          input: `${statusRequest}\n`,
          encoding: "utf8",
        },
      );
      if (replacement) {
        assert.notEqual(output.status, 0, output.stderr);
        assert.match(output.stderr, /exact destination Manager is not live/);
        assert.equal(
          JSON.parse(readFileSync(marker, "utf8")).status,
          "pending",
        );
        continue;
      }
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(JSON.parse(output.stdout), {
        dataRoot: herdsmanDataRoot(),
        id: messageId,
        digest,
        status: "accepted",
      });
      const savedMarker = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(savedMarker.status, "accepted", cut);
      assert.equal(
        savedMarker.digest,
        digest,
        "recovery preserves transfer digest",
      );
      if (cut === "pending-marker-durable") {
        if (retargetCrash) {
          assert.equal(
            listPeerCorrespondences().find(
              (item) => item.acceptanceId === messageId,
            )?.recipientGeneration,
            manager.claim.id,
            "published recovery keeps the retargeted generation while offline",
          );
          claim = acquireProcessLock(peerLeadLockPath(runtime, sessionId), {
            name: "restarted test Manager after offline acceptance",
          });
          manager = { ...manager, claim: claim.claim, updatedAt: Date.now() };
          writePeerLeadRecord(runtime, manager);
          continue;
        }
        assert.deepEqual(
          readCoordinationMessage(
            chiefMessagePath(runtime, sessionId, messageId),
          ),
          record,
          cut,
        );
      } else if (consumed) {
        assert.throws(
          () =>
            readCoordinationMessage(
              chiefMessagePath(runtime, sessionId, messageId),
            ),
          /Unable to read Chief message/,
          "recovery must not republish a consumed Pi message",
        );
      } else {
        assert.deepEqual(
          readCoordinationMessage(
            chiefMessagePath(runtime, sessionId, messageId),
          ),
          record,
          "recovery accepts the exact still-published inbox record",
        );
      }
    }
  } finally {
    claim.release();
    if (previousData === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousData;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
    if (previousConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = previousConnection;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("partial pending-marker write leaves no final marker and identical retry succeeds", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-partial-marker-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const sessionId = id();
  const originSession = id();
  const leaseId = id();
  const claim = acquireProcessLock(peerLeadLockPath(peerRuntime(), sessionId), {
    name: "test Manager peer presence",
  });
  try {
    const runtime = peerRuntime();
    const manager = {
      version: 2 as const,
      build: { version: "0.18.0", sha256: "a".repeat(64) },
      role: "manager" as const,
      sessionKind: "ordinary" as const,
      piSessionId: sessionId,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: claim.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, manager);
    const record = {
      version: 2 as const,
      build: manager.build,
      id: id(),
      leaseId,
      kind: "peer_message" as const,
      fromSessionId: originSession,
      toSessionId: sessionId,
      leadSessionId: sessionId,
      text: "retry after partial marker write",
      peerSource: { role: "manager" as const },
      createdAt: Date.now(),
    };
    const transfer = {
      record,
      attachments: [],
      correspondence: {
        id: id(),
        capability: "c".repeat(64),
        originSession,
        originGeneration: leaseId,
        recipientSession: sessionId,
        recipientGeneration: manager.claim.id,
        acceptanceId: record.id,
        replies: [],
      },
      recipientClaimId: manager.claim.id,
      expectedDataRoot: herdsmanDataRoot(),
    };
    const marker = join(
      runtime.root,
      "peer-acceptances",
      `${createHash("sha256").update(`${originSession}\0${record.id}`).digest("hex")}.json`,
    );
    const run = (fail: boolean, payload = transfer) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          ...(fail
            ? ["--import=./bin/peer-bridge-write-failure.test-support.mjs"]
            : []),
          "bin/peer-bridge.ts",
          "accept",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            HERDR_SOCKET_PATH: socket,
            SSH_CONNECTION: "test-ssh-connection",
          },
          input: `${JSON.stringify(payload)}\n`,
          encoding: "utf8",
        },
      );
    const failed = run(true);
    assert.notEqual(failed.status, 0, failed.stderr);
    assert.match(failed.stderr, /injected pending marker temp write failure/);
    assert.equal(existsSync(marker), false);
    const retried = run(false);
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(
      readCoordinationMessage(chiefMessagePath(runtime, sessionId, record.id)),
      record,
    );
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).status, "accepted");
    const conflicting = run(false, {
      ...transfer,
      record: { ...record, text: "conflicting retry" },
    });
    assert.notEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /conflicting peer message identity/);
  } finally {
    claim.release();
    if (previousData === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousData;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
    if (previousConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = previousConnection;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("short writes complete before publication and accepted EEXIST race cleans temp", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-publication-race-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const sessionId = id();
  const originSession = id();
  const leaseId = id();
  const claim = acquireProcessLock(peerLeadLockPath(peerRuntime(), sessionId), {
    name: "test Manager peer presence",
  });
  try {
    const runtime = peerRuntime();
    const manager = {
      version: 2 as const,
      build: { version: "0.18.0", sha256: "a".repeat(64) },
      role: "manager" as const,
      sessionKind: "ordinary" as const,
      piSessionId: sessionId,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: claim.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, manager);
    const makeTransfer = (text: string) => {
      const record = {
        version: 2 as const,
        build: manager.build,
        id: id(),
        leaseId,
        kind: "peer_message" as const,
        fromSessionId: originSession,
        toSessionId: sessionId,
        leadSessionId: sessionId,
        text,
        peerSource: { role: "manager" as const },
        createdAt: Date.now(),
      };
      return {
        record,
        attachments: [],
        correspondence: {
          id: id(),
          capability: "c".repeat(64),
          originSession,
          originGeneration: leaseId,
          recipientSession: sessionId,
          recipientGeneration: manager.claim.id,
          acceptanceId: record.id,
          replies: [],
        },
        recipientClaimId: manager.claim.id,
        expectedDataRoot: herdsmanDataRoot(),
      };
    };
    const run = (transfer: ReturnType<typeof makeTransfer>, support: string) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          `--import=./bin/${support}`,
          "bin/peer-bridge.ts",
          "accept",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            HERDR_SOCKET_PATH: socket,
            SSH_CONNECTION: "test-ssh-connection",
          },
          input: `${JSON.stringify(transfer)}\n`,
          encoding: "utf8",
        },
      );
    const markerPath = (transfer: ReturnType<typeof makeTransfer>) =>
      join(
        runtime.root,
        "peer-acceptances",
        `${createHash("sha256").update(`${originSession}\0${transfer.record.id}`).digest("hex")}.json`,
      );
    const shortWrite = makeTransfer("all bytes before publication");
    const shortWriteResult = run(
      shortWrite,
      "peer-bridge-short-write.test-support.mjs",
    );
    assert.equal(shortWriteResult.error, undefined, shortWriteResult.stderr);
    assert.equal(
      JSON.parse(readFileSync(markerPath(shortWrite), "utf8")).status,
      "pending",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(markerPath(shortWrite), "utf8")).transfer,
      shortWrite,
    );
    assert.deepEqual(readdirSync(join(runtime.root, "peer-acceptances")), [
      `${createHash("sha256").update(`${originSession}\0${shortWrite.record.id}`).digest("hex")}.json`,
    ]);

    const raced = makeTransfer("accepted marker race");
    const raceResult = run(raced, "peer-bridge-eexist.test-support.mjs");
    assert.equal(raceResult.status, 0, raceResult.stderr);
    assert.deepEqual(JSON.parse(raceResult.stdout), {
      accepted: true,
      id: raced.record.id,
    });
    assert.equal(
      JSON.parse(readFileSync(markerPath(raced), "utf8")).status,
      "accepted",
    );
    assert.deepEqual(
      readdirSync(join(runtime.root, "peer-acceptances")).sort(),
      [basename(markerPath(shortWrite)), basename(markerPath(raced))].sort(),
    );
  } finally {
    claim.release();
    if (previousData === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousData;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
    if (previousConnection === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = previousConnection;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
