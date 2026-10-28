import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { acquireProcessLock } from "../extension/lock.ts";
import { HERDSMAN_BUILD } from "../extension/support.ts";
import {
  herdsmanDataRoot,
  peerAttachmentPath,
  resultPath,
} from "../extension/storage.ts";
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
  writeProjectAssignment,
  supervisionRuntime,
  peerLeadLockPath,
  removePeerLeadRecord,
} from "../extension/supervision.ts";
import {
  listPeerCorrespondences,
  peerPayloadDigest,
  storePeerCorrespondence,
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
    build: HERDSMAN_BUILD,
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
      const withAttachments = cut === "inbox-publication-durable";
      const binding = { ref: "result:scout#1", canonicalRef: `result:${id()}` };
      const attachments = withAttachments
        ? [
            { name: "notes.txt", marker: "<notes>", text: "ordinary evidence" },
            {
              name: "result.txt",
              ref: binding.ref,
              marker: "<result>",
              text: "result evidence",
            },
          ].map((attachment) => ({
            ...attachment,
            sha256: createHash("sha256").update(attachment.text).digest("hex"),
          }))
        : [];
      const record = {
        version: 2 as const,
        build: manager.build,
        id: messageId,
        leaseId,
        kind: "peer_message" as const,
        fromSessionId: originSession,
        toSessionId: sessionId,
        leadSessionId: sessionId,
        text: withAttachments
          ? "message <notes> and <result>"
          : `message ${cut} ${consumed ? "consumed" : "queued"}`,
        ...(withAttachments ? { resultBindings: [binding] } : {}),
        peerSource: { role: "manager" as const },
        createdAt: Date.now(),
      };
      const acceptedRecord = withAttachments
        ? {
            ...record,
            text: `message ordinary evidence and result evidence\n\nForwardable received files:\nnotes.txt: ${peerAttachmentPath("notes.txt", "ordinary evidence")}\nresult.txt: ${binding.ref} (canonical ${binding.canonicalRef})`,
          }
        : record;
      const correspondence: PeerCorrespondence = {
        id: id(),
        capability: "c".repeat(64),
        originSession,
        originGeneration: leaseId,
        recipientSession: sessionId,
        recipientGeneration: manager.claim.id,
        acceptanceId: messageId,
        originDisplay: {
          name: "Research Manager",
          workspaceLabel: "project-alpha/main",
        },
        replies: [],
      };
      const transfer = {
        record,
        attachments,
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
      if (cut === "pending-marker-durable" && !replacement && !retargetCrash) {
        const peerPath = writePeerLeadRecord(runtime, {
          ...manager,
          build: { ...HERDSMAN_BUILD, sha256: "a".repeat(64) },
        });
        const rejectedAttachment = {
          name: "new.txt",
          marker: "<new>",
          text: "new evidence",
          sha256: createHash("sha256").update("new evidence").digest("hex"),
        };
        const rejectedTransfer = {
          ...transfer,
          record: { ...record, text: "<new>" },
          attachments: [rejectedAttachment],
        };
        for (const missing of [false, true]) {
          if (missing) {
            const { build: _build, ...unverified } = manager;
            writeFileSync(peerPath, JSON.stringify(unverified));
          }
          const stale = spawnSync(
            process.execPath,
            ["--experimental-strip-types", "bin/peer-bridge.ts", "accept"],
            {
              cwd: process.cwd(),
              env: process.env,
              input: JSON.stringify(rejectedTransfer),
              encoding: "utf8",
            },
          );
          assert.notEqual(stale.status, 0);
          assert.equal(existsSync(marker), false);
          assert.equal(
            existsSync(join(runtime.root, "received-evidence")),
            false,
          );
          assert.equal(
            existsSync(
              join(herdsmanDataRoot(), "runtime", "peer-correspondences"),
            ),
            false,
          );
          assert.equal(
            existsSync(chiefMessagePath(runtime, sessionId, messageId)),
            false,
          );
        }
        writePeerLeadRecord(runtime, manager);
      }
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
          acceptedRecord,
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
          acceptedRecord,
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
              digest: coordinationMessageDigest(acceptedRecord),
            },
          },
        ];
        await drainCoordinationInbox({
          runtime,
          sessionId,
          isAuthorized: () => true,
          isDelivered: () =>
            coordinationMessageDelivered(acceptedRecord, sessionId, history),
          sendMessage: () => submitted++,
          accepted: (delivered) => writePeerDeliveryReceipt(runtime, delivered),
        });
        assert.equal(submitted, 0);
        assert.equal(
          hasPeerDeliveryReceipt(
            runtime,
            sessionId,
            messageId,
            coordinationMessageDigest(acceptedRecord),
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
      const digest = peerPayloadDigest({ record, attachments });
      const statusRequest = JSON.stringify({
        id: messageId,
        originSession,
        recipientSession: sessionId,
        digest,
        expectedDataRoot: herdsmanDataRoot(),
      });
      if (cut === "pending-marker-durable" && !replacement && !retargetCrash) {
        const before = readFileSync(marker, "utf8");
        writePeerLeadRecord(runtime, {
          ...manager,
          build: { ...HERDSMAN_BUILD, sha256: "a".repeat(64) },
        });
        const stale = spawnSync(
          process.execPath,
          ["--experimental-strip-types", "bin/peer-bridge.ts", "status"],
          {
            cwd: process.cwd(),
            env: process.env,
            input: statusRequest,
            encoding: "utf8",
          },
        );
        assert.notEqual(stale.status, 0);
        assert.equal(readFileSync(marker, "utf8"), before);
        writePeerLeadRecord(runtime, manager);
      }
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
      if (cut === "inbox-publication-durable")
        writePeerLeadRecord(runtime, {
          ...manager,
          build: { ...HERDSMAN_BUILD, sha256: "a".repeat(64) },
        });
      const correspondencePath = join(
        herdsmanDataRoot(),
        "runtime",
        "peer-correspondences",
        `${correspondence.id}.json`,
      );
      const correspondenceBefore = withAttachments
        ? readFileSync(correspondencePath)
        : undefined;
      if (withAttachments) {
        for (const path of [
          peerAttachmentPath("notes.txt", "ordinary evidence"),
          resultPath(binding.canonicalRef.slice("result:".length)),
        ]) {
          const original = readFileSync(path);
          writeFileSync(path, "corrupt");
          try {
            const rejected = spawnSync(
              process.execPath,
              ["--experimental-strip-types", "bin/peer-bridge.ts", "status"],
              {
                cwd: process.cwd(),
                env: process.env,
                input: statusRequest,
                encoding: "utf8",
              },
            );
            assert.notEqual(rejected.status, 0);
            assert.equal(readFileSync(path, "utf8"), "corrupt");
            assert.deepEqual(
              readFileSync(correspondencePath),
              correspondenceBefore,
            );
            assert.equal(
              JSON.parse(readFileSync(marker, "utf8")).status,
              "pending",
            );
          } finally {
            writeFileSync(path, original);
          }
        }
      }
      if (cut === "inbox-publication-durable" && !consumed) {
        const path = join(
          herdsmanDataRoot(),
          "runtime",
          "peer-correspondences",
          `${correspondence.id}.json`,
        );
        renameSync(path, `${path}.saved`);
        try {
          const missing = spawnSync(
            process.execPath,
            ["--experimental-strip-types", "bin/peer-bridge.ts", "status"],
            {
              cwd: process.cwd(),
              env: process.env,
              input: statusRequest,
              encoding: "utf8",
            },
          );
          assert.notEqual(missing.status, 0);
          assert.equal(existsSync(path), false);
          assert.equal(
            JSON.parse(readFileSync(marker, "utf8")).status,
            "pending",
          );
        } finally {
          renameSync(`${path}.saved`, path);
        }
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
      if (withAttachments) {
        assert.deepEqual(
          readFileSync(correspondencePath),
          correspondenceBefore,
        );
        assert.equal(
          JSON.parse(readFileSync(correspondencePath, "utf8"))
            .recipientGeneration,
          correspondence.recipientGeneration,
        );
        assert.equal(
          readFileSync(
            peerAttachmentPath("notes.txt", "ordinary evidence"),
            "utf8",
          ),
          "ordinary evidence",
        );
        assert.equal(
          readFileSync(
            resultPath(binding.canonicalRef.slice("result:".length)),
            "utf8",
          ),
          "result evidence",
        );
      }
      if (cut === "inbox-publication-durable")
        writePeerLeadRecord(runtime, manager);
      assert.deepEqual(JSON.parse(output.stdout), {
        dataRoot: herdsmanDataRoot(),
        id: messageId,
        digest,
        status: "accepted",
      });
      const savedMarker = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(savedMarker.status, "accepted", cut);
      assert.deepEqual(
        listPeerCorrespondences().find((item) => item.id === correspondence.id)
          ?.originDisplay,
        {
          name: "Research Manager",
          workspaceLabel: "project-alpha/main",
        },
        "bridge acceptance persists advisory origin display metadata",
      );
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
          acceptedRecord,
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
      build: HERDSMAN_BUILD,
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

test("bridge accepts a directly addressed ordinary Lead and rejects role-transition transfers", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-ordinary-lead-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const sessionId = id();
  const originSession = id();
  const leaseId = id();
  const claim = acquireProcessLock(peerLeadLockPath(peerRuntime(), sessionId), {
    name: "test ordinary Lead peer presence",
  });
  try {
    const runtime = peerRuntime();
    const lead = {
      version: 2 as const,
      build: HERDSMAN_BUILD,
      role: "lead" as const,
      sessionKind: "ordinary" as const,
      piSessionId: sessionId,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: claim.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(runtime, lead);
    const record = {
      version: 2 as const,
      build: lead.build,
      id: id(),
      leaseId,
      kind: "peer_message" as const,
      fromSessionId: originSession,
      toSessionId: sessionId,
      leadSessionId: sessionId,
      text: "ordinary Lead acceptance",
      peerSource: { role: "lead" as const, remoteOrdinary: true as const },
      createdAt: Date.now(),
    };
    const correspondence: PeerCorrespondence = {
      id: id(),
      capability: "c".repeat(64),
      role: "lead",
      originSession,
      originGeneration: leaseId,
      recipientSession: sessionId,
      recipientGeneration: lead.claim.id,
      acceptanceId: record.id,
      replies: [],
    };
    const transfer = {
      record,
      attachments: [],
      correspondence,
      recipientClaimId: lead.claim.id,
      expectedDataRoot: herdsmanDataRoot(),
    };
    const run = (payload: typeof transfer, hook?: string) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          ...(hook
            ? [`--import=data:text/javascript,${encodeURIComponent(hook)}`]
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
    const accepted = run(transfer);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), {
      accepted: true,
      id: record.id,
    });
    assert.deepEqual(
      readCoordinationMessage(chiefMessagePath(runtime, sessionId, record.id)),
      record,
    );

    const buildRaceRecord = { ...record, id: id() };
    const buildRaceCorrespondence = {
      ...correspondence,
      id: id(),
      acceptanceId: buildRaceRecord.id,
    };
    const buildRaceTransfer = {
      ...transfer,
      record: buildRaceRecord,
      correspondence: buildRaceCorrespondence,
    };
    const staleLead = {
      ...lead,
      build: { ...HERDSMAN_BUILD, sha256: "a".repeat(64) },
    };
    const buildHook = `import { setPeerAcceptanceFaultHookForTests } from ${JSON.stringify(new URL("./peer-bridge-fault-seam.ts", import.meta.url).href)}; import { writePeerLeadRecord, peerRuntime } from ${JSON.stringify(new URL("../extension/supervision.ts", import.meta.url).href)}; setPeerAcceptanceFaultHookForTests((cutPoint) => { if (cutPoint === "pending-marker-durable") writePeerLeadRecord(peerRuntime(), ${JSON.stringify(staleLead)}); });`;
    const buildRace = run(buildRaceTransfer, buildHook);
    assert.notEqual(buildRace.status, 0);
    assert.equal(
      existsSync(chiefMessagePath(runtime, sessionId, buildRaceRecord.id)),
      false,
    );
    assert.equal(
      listPeerCorrespondences().some(
        (item) => item.id === buildRaceCorrespondence.id,
      ),
      false,
    );
    writePeerLeadRecord(runtime, lead);
    const recoveredBuildRace = run(buildRaceTransfer);
    assert.equal(recoveredBuildRace.status, 0, recoveredBuildRace.stderr);
    assert.deepEqual(
      readCoordinationMessage(
        chiefMessagePath(runtime, sessionId, buildRaceRecord.id),
      ),
      buildRaceRecord,
    );

    const assignmentHook = `import { setPeerAcceptanceFaultHookForTests } from ${JSON.stringify(new URL("./peer-bridge-fault-seam.ts", import.meta.url).href)}; import { writeProjectAssignment, supervisionRuntime } from ${JSON.stringify(new URL("../extension/supervision.ts", import.meta.url).href)}; setPeerAcceptanceFaultHookForTests((cutPoint) => { if (cutPoint === "pending-marker-durable") writeProjectAssignment(supervisionRuntime(), { version: 2, id: ${JSON.stringify(sessionId)}, repoKey: "race-repo", branch: "assigned-after-discovery", text: "assignment changed before publication" }); });`;
    const racedRecord = { ...record, id: id() };
    const raced = run(
      {
        ...transfer,
        record: racedRecord,
        correspondence: {
          ...correspondence,
          id: id(),
          acceptanceId: racedRecord.id,
        },
      },
      assignmentHook,
    );
    assert.notEqual(raced.status, 0);
    assert.match(
      raced.stderr,
      /exact correspondence recipient is not live or authorized/,
    );
    assert.throws(
      () =>
        readCoordinationMessage(
          chiefMessagePath(runtime, sessionId, racedRecord.id),
        ),
      /Unable to read Chief message/,
      "assignment added after discovery must reject before inbox publication",
    );
    rmSync(supervisionRuntime().assignments, { recursive: true, force: true });

    const assignments = supervisionRuntime().assignments;
    const hook = `import { mkdirSync } from 'node:fs'; import { setPendingMarkerPublishHookForTests } from ${JSON.stringify(new URL("./peer-bridge-fault-seam.ts", import.meta.url).href)}; setPendingMarkerPublishHookForTests(() => mkdirSync(${JSON.stringify(join(assignments, "unexpected"))}, { recursive: true }));`;
    const changed = run(
      {
        ...transfer,
        record: { ...record, id: id() },
        correspondence: { ...correspondence, id: id(), acceptanceId: id() },
      },
      hook,
    );
    assert.notEqual(changed.status, 0);
    assert.match(
      changed.stderr,
      /Unexpected project assignment repository entry/,
    );

    const transition = run({
      ...transfer,
      record: { ...record, id: id(), peerSource: { role: "manager" as const } },
      correspondence: { ...correspondence, id: id(), acceptanceId: id() },
    });
    assert.notEqual(transition.status, 0);
    assert.match(
      transition.stderr,
      /peer source role does not match correspondence role/,
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

test("probe preserves incompatible Managers and rejects their delivery before mutation", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-probe-scan-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  const managerId = id();
  const leadId = id();
  const staleId = id();
  const runtime = peerRuntime();
  const managerClaim = acquireProcessLock(
    peerLeadLockPath(peerRuntime(), managerId),
    { name: "probe Manager" },
  );
  const leadClaim = acquireProcessLock(
    peerLeadLockPath(peerRuntime(), leadId),
    { name: "probe Lead" },
  );
  const staleClaim = acquireProcessLock(
    peerLeadLockPath(peerRuntime(), staleId),
    { name: "stale probe Manager" },
  );
  try {
    const build = HERDSMAN_BUILD;
    for (const [session, role, claim] of [
      [managerId, "manager", managerClaim],
      [leadId, "lead", leadClaim],
    ] as const)
      writePeerLeadRecord(peerRuntime(), {
        version: 2,
        build,
        role,
        sessionKind: "ordinary",
        piSessionId: session,
        paneId: "pane",
        tabId: "tab",
        workspaceId: "workspace",
        socket,
        claim: claim.claim,
        updatedAt: Date.now(),
      });
    writePeerLeadRecord(peerRuntime(), {
      version: 2,
      build: { ...build, sha256: "a".repeat(64) },
      role: "manager",
      sessionKind: "ordinary",
      piSessionId: staleId,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: staleClaim.claim,
      updatedAt: Date.now(),
    });
    const assignments = supervisionRuntime().assignments;
    mkdirSync(assignments, { recursive: true });
    mkdirSync(join(assignments, "unexpected"));
    const probe = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "bin/peer-bridge.ts", "probe"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          HERDR_SOCKET_PATH: socket,
        },
        encoding: "utf8",
      },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout);
    assert.equal(result.ordinaryLeadsComplete, false);
    assert.deepEqual(
      result.peers
        .map((peer: { piSessionId: string }) => peer.piSessionId)
        .sort(),
      [managerId, staleId].sort(),
    );

    const messageId = id();
    const originSession = id();
    const leaseId = id();
    const delivery = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "bin/peer-bridge.ts", "accept"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SSH_CONNECTION: "test-ssh-connection" },
        input: JSON.stringify({
          record: {
            version: 2,
            build,
            id: messageId,
            leaseId,
            kind: "peer_message",
            fromSessionId: originSession,
            toSessionId: staleId,
            leadSessionId: staleId,
            text: "incompatible peer delivery",
            peerSource: { role: "manager" },
            createdAt: Date.now(),
          },
          attachments: [],
          correspondence: {
            id: id(),
            capability: "c".repeat(64),
            originSession,
            originGeneration: leaseId,
            recipientSession: staleId,
            recipientGeneration: staleClaim.claim.id,
            acceptanceId: messageId,
            originDisplay: {
              name: "Test Manager",
              workspaceLabel: "test/main",
            },
            replies: [],
          },
          recipientClaimId: staleClaim.claim.id,
          expectedDataRoot: herdsmanDataRoot(),
        }),
        encoding: "utf8",
      },
    );
    assert.notEqual(delivery.status, 0);
    assert.match(
      delivery.stderr,
      /exact correspondence recipient is not live or authorized/,
    );
    assert.equal(existsSync(join(runtime.root, "peer-acceptances")), false);
    assert.equal(
      existsSync(join(herdsmanDataRoot(), "runtime", "peer-correspondences")),
      false,
    );
    assert.equal(
      existsSync(chiefMessagePath(runtime, staleId, messageId)),
      false,
    );
    assert.equal(existsSync(join(runtime.root, "received-evidence")), false);
  } finally {
    managerClaim.release();
    leadClaim.release();
    staleClaim.release();
    if (previousData === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousData;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Lead correspondence commands reject a recipient transitioned to Manager", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-role-transition-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const recipient = id();
  const origin = id();
  const originGeneration = id();
  const claim = acquireProcessLock(peerLeadLockPath(peerRuntime(), recipient), {
    name: "transitioned Manager",
  });
  try {
    const manager = {
      version: 2 as const,
      build: HERDSMAN_BUILD,
      role: "manager" as const,
      sessionKind: "ordinary" as const,
      piSessionId: recipient,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: claim.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(peerRuntime(), manager);
    const correspondence: PeerCorrespondence = {
      id: id(),
      capability: "d".repeat(64),
      role: "lead",
      originSession: origin,
      originGeneration,
      recipientSession: recipient,
      recipientGeneration: claim.claim.id,
      acceptanceId: id(),
      replies: [],
    };
    storePeerCorrespondence(correspondence);
    const payload = {
      id: correspondence.id,
      capability: correspondence.capability,
      originSession: origin,
      originGeneration,
      recipientSession: recipient,
      recipientGeneration: claim.claim.id,
      expectedDataRoot: herdsmanDataRoot(),
      previousOriginGeneration: originGeneration,
      newRecipientGeneration: claim.claim.id,
      replyId: id(),
    };
    for (const action of [
      "poll",
      "ack",
      "recover",
      "recover-recipient",
      "finalize",
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "bin/peer-bridge.ts", action],
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
      assert.notEqual(result.status, 0, action);
      assert.match(
        result.stderr,
        /exact correspondence recipient is not live or authorized/,
        action,
      );
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

test("live replacement Manager cannot recover prior Manager correspondence", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(
    join(tmpdir(), "peer-bridge-manager-replacement-"),
  );
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const originalSession = id();
  const replacementSession = id();
  const originSession = id();
  const originGeneration = id();
  const claim = acquireProcessLock(
    peerLeadLockPath(peerRuntime(), replacementSession),
    { name: "replacement Manager" },
  );
  try {
    writePeerLeadRecord(peerRuntime(), {
      version: 2,
      build: HERDSMAN_BUILD,
      role: "manager",
      sessionKind: "ordinary",
      piSessionId: replacementSession,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: claim.claim,
      updatedAt: Date.now(),
    });
    const correspondence: PeerCorrespondence = {
      id: id(),
      capability: "7".repeat(64),
      role: "manager",
      originSession,
      originGeneration,
      recipientSession: originalSession,
      recipientGeneration: id(),
      acceptanceId: id(),
      replies: [],
    };
    storePeerCorrespondence(correspondence);
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "bin/peer-bridge.ts", "recover-recipient"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          HERDR_SOCKET_PATH: socket,
          SSH_CONNECTION: "test-ssh-connection",
        },
        input: `${JSON.stringify({
          id: correspondence.id,
          capability: correspondence.capability,
          originSession,
          originGeneration,
          recipientSession: originalSession,
          recipientGeneration: correspondence.recipientGeneration,
          newRecipientGeneration: claim.claim.id,
          expectedDataRoot: herdsmanDataRoot(),
        })}\n`,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /exact correspondence recipient is not live or authorized/,
    );
    assert.equal(
      listPeerCorrespondences().find((item) => item.id === correspondence.id)
        ?.recipientGeneration,
      correspondence.recipientGeneration,
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

test("Lead ACK does not complete after assignment authority changes", () => {
  const previousData = process.env.PI_CODING_AGENT_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousConnection = process.env.SSH_CONNECTION;
  const agentDir = mkdtempSync(join(tmpdir(), "peer-bridge-ack-assignment-"));
  const socket = join(agentDir, "herdr.sock");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.SSH_CONNECTION = "test-ssh-connection";
  const recipient = id();
  const origin = id();
  const generation = id();
  const claim = acquireProcessLock(peerLeadLockPath(peerRuntime(), recipient), {
    name: "ordinary Lead ACK recipient",
  });
  try {
    const lead = {
      version: 2 as const,
      build: HERDSMAN_BUILD,
      role: "lead" as const,
      sessionKind: "ordinary" as const,
      piSessionId: recipient,
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      socket,
      claim: claim.claim,
      updatedAt: Date.now(),
    };
    writePeerLeadRecord(peerRuntime(), lead);
    const replyId = id();
    const correspondence: PeerCorrespondence = {
      id: id(),
      capability: "e".repeat(64),
      role: "lead",
      originSession: origin,
      originGeneration: generation,
      recipientSession: recipient,
      recipientGeneration: claim.claim.id,
      acceptanceId: id(),
      replies: [
        {
          id: replyId,
          digest: "f".repeat(64),
          text: "reply",
          createdAt: Date.now(),
          acknowledged: false,
        },
      ],
    };
    storePeerCorrespondence(correspondence);
    writeProjectAssignment(supervisionRuntime(), {
      version: 2,
      id: recipient,
      repoKey: "ack-race",
      branch: "assigned-before-ack",
      text: "authority changed after discovery",
    });
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "bin/peer-bridge.ts", "ack"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          HERDR_SOCKET_PATH: socket,
          SSH_CONNECTION: "test-ssh-connection",
        },
        input: `${JSON.stringify({
          id: correspondence.id,
          capability: correspondence.capability,
          originSession: origin,
          originGeneration: generation,
          recipientSession: recipient,
          recipientGeneration: claim.claim.id,
          replyId,
          expectedDataRoot: herdsmanDataRoot(),
        })}\n`,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /exact correspondence recipient is not live or authorized/,
    );
    assert.doesNotMatch(result.stdout, /"acknowledged":true/);
    assert.equal(
      listPeerCorrespondences().find((item) => item.id === correspondence.id)
        ?.replies[0]?.acknowledged,
      false,
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
      build: HERDSMAN_BUILD,
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
