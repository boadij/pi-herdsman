#!/usr/bin/env node
// Disposable, explicitly owned Docker fixture for the real peer-federation smoke.
// Run with `node scripts/peer-federation-smoke.mjs`; set PEER_SMOKE_KEEP=1 to
// retain resources for diagnosis (the printed manifest is the cleanup authority).
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

let runId = `peer474-${randomUUID()}`;
let root = join(tmpdir(), runId);
let manifestPath = join(root, "resources.json");
const resources = {
  runId,
  root,
  network: null,
  volumes: [],
  image: null,
  imageTag: null,
  containers: [],
};
if (process.argv[2] === "--cleanup") {
  const manifest = process.argv[3];
  if (!manifest)
    throw new Error("usage: peer-federation-smoke.mjs --cleanup <manifest>");
  Object.assign(resources, JSON.parse(readFileSync(manifest, "utf8")));
  runId = resources.runId;
  root = resources.root;
  manifestPath = manifest;
}
const save = () =>
  writeFileSync(manifestPath, `${JSON.stringify(resources, null, 2)}\n`, {
    mode: 0o600,
  });

function command(bin, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (result.error || (!allowFailure && result.status !== 0))
    throw new Error(
      `${bin} ${args.join(" ")} failed: ${result.error ?? result.stderr}`,
    );
  return result.stdout.trim();
}

function cleanup() {
  for (const id of resources.containers)
    command("docker", ["rm", "-f", id], { allowFailure: true });
  for (const id of resources.volumes)
    command("docker", ["volume", "rm", id], { allowFailure: true });
  if (resources.network)
    command("docker", ["network", "rm", resources.network], {
      allowFailure: true,
    });
  if (resources.imageTag)
    command("docker", ["image", "rm", resources.imageTag], {
      allowFailure: true,
    });
  const remains = (args) =>
    spawnSync("docker", args, { stdio: "ignore" }).status === 0;
  const leftovers = [
    ...resources.containers.filter((id) =>
      remains(["container", "inspect", id]),
    ),
    ...resources.volumes.filter((id) => remains(["volume", "inspect", id])),
    ...(resources.network && remains(["network", "inspect", resources.network])
      ? [resources.network]
      : []),
    ...(resources.imageTag && remains(["image", "inspect", resources.imageTag])
      ? [resources.imageTag]
      : []),
  ];
  rmSync(root, { recursive: true, force: true });
  if (leftovers.length)
    throw new Error(
      `fixture cleanup left exact resources: ${leftovers.join(", ")}`,
    );
  console.log(
    `Verified fixture cleanup: ${JSON.stringify({ runId: resources.runId, containers: resources.containers, volumes: resources.volumes, network: resources.network, image: resources.imageTag })}`,
  );
}

if (process.argv[2] !== "--cleanup") {
  mkdirSync(root, { mode: 0o700 });
  save();
}

try {
  if (process.argv[2] === "--cleanup") {
    if (
      !resources.runId?.startsWith("peer474-") ||
      !resources.root ||
      !Array.isArray(resources.containers) ||
      !Array.isArray(resources.volumes)
    )
      throw new Error("refusing malformed/non-fixture resource manifest");
    cleanup();
    console.log(`Removed and verified exact resources for ${resources.runId}`);
    process.exit(0);
  }
  const imageTag = `${runId}:fixture`;
  resources.imageTag = imageTag;
  save();
  command("docker", ["build", "--tag", imageTag, "."]);
  resources.image = command("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    imageTag,
  ]);
  save();
  resources.network = command("docker", [
    "network",
    "create",
    "--internal",
    "--label",
    `pi-herdsman.run=${runId}`,
    runId,
  ]);
  save();

  // Create the test client identities before containers start so sshd receives
  // only the opposite fixture key at first boot.
  for (const side of ["a", "b"]) {
    const dir = join(root, side);
    mkdirSync(dir, { mode: 0o700 });
    command("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(dir, "id_ed25519"),
    ]);
    chmodSync(join(dir, "id_ed25519"), 0o600);
    resources[side] = {
      hostHome: dir,
      agentDir: join(dir, "agent"),
      workspace: join(dir, "workspace"),
      herdrConfigPath: join(dir, "herdr", "config.toml"),
    };
    mkdirSync(resources[side].agentDir, { recursive: true, mode: 0o700 });
    mkdirSync(resources[side].workspace, { mode: 0o700 });
    mkdirSync(join(dir, "herdr"), { mode: 0o700 });
    writeFileSync(join(dir, "known_hosts"), "", { mode: 0o600 });
    save();
  }

  for (const side of ["a", "b"]) {
    const home = `ph-${side}-home-${runId}`;
    const ssh = `ph-${side}-ssh-${runId}`;
    command("docker", [
      "volume",
      "create",
      "--label",
      `pi-herdsman.run=${runId}`,
      home,
    ]);
    resources.volumes.push(home);
    save();
    command("docker", [
      "volume",
      "create",
      "--label",
      `pi-herdsman.run=${runId}`,
      ssh,
    ]);
    resources.volumes.push(ssh);
    save();
    const opposite = side === "a" ? "b" : "a";
    const authorizedKey = readFileSync(
      join(root, opposite, "id_ed25519.pub"),
      "utf8",
    ).trim();
    const id = command("docker", [
      "run",
      "--detach",
      "--init",
      "--network",
      resources.network,
      "--label",
      `pi-herdsman.run=${runId}`,
      "--label",
      `pi-herdsman.side=${side}`,
      "--network-alias",
      `peer-${side}`,
      "--volume",
      `${home}:/home/herdsman`,
      "--volume",
      `${ssh}:/var/lib/herdsman/ssh`,
      "--env",
      `SSH_AUTHORIZED_KEYS=${authorizedKey}`,
      imageTag,
    ]);
    resources.containers.push(id);
    save();
    Object.assign(resources[side], {
      home,
      ssh,
      container: id,
      dataRoot: join(resources[side].agentDir, "pi-herdsman"),
    });
    save();
  }

  // Place fixture-only SSH clients in each owned container and pin the opposite
  // container's host key (never accept new keys during subsequent SSH use).
  for (const side of ["a", "b"]) {
    const id = resources[side].container;
    const dir = resources[side].hostHome;
    command("docker", ["cp", join(dir, "id_ed25519"), `${id}:/tmp/peer_id`]);
    command("docker", [
      "exec",
      id,
      "sh",
      "-c",
      "install -d -m 0700 /home/herdsman/.ssh && install -m 0600 /tmp/peer_id /home/herdsman/.ssh/id_ed25519 && chown herdsman:herdsman /home/herdsman/.ssh/id_ed25519",
    ]);
    const other = side === "a" ? "b" : "a";
    let key = "";
    for (
      let attempt = 0;
      attempt < 20 && !key.includes("ssh-ed25519");
      attempt++
    ) {
      const scan = spawnSync(
        "docker",
        [
          "exec",
          id,
          "ssh-keyscan",
          "-T",
          "2",
          "-t",
          "ed25519",
          `peer-${other}`,
        ],
        { encoding: "utf8" },
      );
      key = scan.stdout.trim();
      if (!key.includes("ssh-ed25519"))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!key.includes("ssh-ed25519"))
      throw new Error(`could not pin ${other} host key`);
    writeFileSync(join(dir, "known_hosts"), key, { mode: 0o600 });
    command("docker", [
      "cp",
      join(dir, "known_hosts"),
      `${id}:/tmp/known_hosts`,
    ]);
    command("docker", [
      "exec",
      id,
      "sh",
      "-c",
      "install -m 0600 /tmp/known_hosts /home/herdsman/.ssh/known_hosts && chown herdsman:herdsman /home/herdsman/.ssh/known_hosts",
    ]);
    save();
  }

  for (const side of ["a", "b"]) {
    const other = side === "a" ? "b" : "a";
    const id = resources[side].container;
    const result = command("docker", [
      "exec",
      id,
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/home/herdsman/.ssh/known_hosts",
      "-i",
      "/home/herdsman/.ssh/id_ed25519",
      `herdsman@peer-${other}`,
      "pi-herdsman-peer",
      "probe",
    ]);
    resources[side].sshProbe = JSON.parse(result);
    save();
  }

  // Prepare isolated Pi/Herdr roots inside each owned container. Keep Herdr's
  // server and workspace data test-local rather than using its default config.
  const exec = (side, args, extra = []) =>
    command("docker", ["exec", ...extra, resources[side].container, ...args]);
  const fixturePath = (side) => `/tmp/p${runId.slice(-8)}${side}`;
  const herdrEnv = (side) => [
    "-e",
    `HOME=${fixturePath(side)}`,
    "-e",
    `HERDR_CONFIG_PATH=${fixturePath(side)}/herdr.toml`,
    "-e",
    `PI_CODING_AGENT_DIR=${fixturePath(side)}/.pi/agent`,
    "-e",
    `PI_CODING_AGENT_SESSION_DIR=${fixturePath(side)}/sessions`,
    "-e",
    `XDG_CONFIG_HOME=${fixturePath(side)}/xdg-config`,
    "-e",
    `XDG_STATE_HOME=${fixturePath(side)}/xdg-state`,
    "-e",
    `PATH=${fixturePath(side)}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  ];
  for (const side of ["a", "b"]) {
    const container = resources[side].container;
    const base = fixturePath(side);
    exec(side, [
      "sh",
      "-c",
      `mkdir -p ${base}/.pi/agent/extensions ${base}/.pi/agent/agents ${base}/.pi/agent/pi-herdsman/runtime ${base}/sessions ${base}/workspace ${base}/xdg-config ${base}/xdg-state ${base}/.ssh && cp -a /home/herdsman/.ssh/. ${base}/.ssh/ && chown -R herdsman:herdsman ${base} && chmod 0700 ${base}/.ssh && usermod -d ${base} herdsman && printf '[experimental]\\nallow_nested = true\\n' > ${base}/herdr.toml`,
    ]);
    const sshWrapper = join(root, `ssh-${side}`);
    writeFileSync(
      sshWrapper,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *'pi-herdsman-peer accept'*) umask 077; cat > ${base}/last-accept.json; exec /usr/bin/ssh "$@" < ${base}/last-accept.json ;;`,
        '  *) exec /usr/bin/ssh "$@" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    command("docker", ["exec", container, "mkdir", "-p", `${base}/.local/bin`]);
    command("docker", [
      "cp",
      sshWrapper,
      `${container}:${base}/.local/bin/ssh`,
    ]);
    exec(side, ["chown", "herdsman:herdsman", `${base}/.local/bin/ssh`]);
    command("docker", [
      "cp",
      "scripts/smoke-faux.mjs",
      `${container}:${base}/.pi/agent/extensions/smoke-faux.mjs`,
    ]);
    exec(
      side,
      ["pi", "install", "/opt/pi-herdsman"],
      ["--user", "herdsman", ...herdrEnv(side)],
    );
    exec(
      side,
      ["herdr", "integration", "install", "pi"],
      ["--user", "herdsman", ...herdrEnv(side)],
    );
    resources[side].runtime = {
      home: base,
      herdrConfig: `${base}/herdr.toml`,
      piAgentDir: `${base}/.pi/agent`,
      sessionDir: `${base}/sessions`,
      workspace: `${base}/workspace`,
    };
    save();
  }

  for (const side of ["a", "b"]) {
    const session = `p${runId.slice(-8)}${side}`;
    resources[side].herdrSession = session;
    save();
    command("docker", [
      "exec",
      "--detach",
      "--user",
      "herdsman",
      ...herdrEnv(side),
      resources[side].container,
      "herdr",
      "--session",
      session,
      "server",
    ]);
    let server;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          "herdsman",
          ...herdrEnv(side),
          resources[side].container,
          "herdr",
          "--session",
          session,
          "status",
          "--json",
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        try {
          server = JSON.parse(result.stdout);
          if (server.server?.running) break;
        } catch {}
      }
      server = undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!server?.server?.running)
      throw new Error(`${side}: isolated Herdr server did not become ready`);
    resources[side].serverStatus = server;
    save();
  }

  const herdr = (side, args) =>
    command("docker", [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv(side),
      resources[side].container,
      "herdr",
      "--session",
      resources[side].herdrSession,
      ...args,
    ]);
  for (const side of ["a", "b"]) {
    const created = JSON.parse(
      herdr(side, [
        "workspace",
        "create",
        "--cwd",
        resources[side].runtime.workspace,
        "--label",
        `${runId}-${side}`,
        "--focus",
      ]),
    );
    const pane = created.result?.root_pane?.pane_id;
    if (!pane)
      throw new Error(`${side}: workspace create omitted the root pane`);
    resources[side].workspaceId = created.result.workspace.workspace_id;
    resources[side].paneId = pane;
    save();
    exec(
      side,
      ["git", "-C", resources[side].runtime.workspace, "init", "-q"],
      ["--user", "herdsman"],
    );
    exec(
      side,
      [
        "git",
        "-C",
        resources[side].runtime.workspace,
        "config",
        "user.name",
        "Peer Smoke",
      ],
      ["--user", "herdsman"],
    );
    exec(
      side,
      [
        "git",
        "-C",
        resources[side].runtime.workspace,
        "config",
        "user.email",
        "peer-smoke@example.invalid",
      ],
      ["--user", "herdsman"],
    );
    exec(
      side,
      [
        "git",
        "-C",
        resources[side].runtime.workspace,
        "commit",
        "--allow-empty",
        "-m",
        "peer smoke fixture base",
      ],
      ["--user", "herdsman"],
    );
    herdr(side, [
      "pane",
      "run",
      pane,
      "pi",
      "--model",
      `smoke-faux/federated-peer-${side}`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`,
    ]);
    herdr(side, [
      "pane",
      "wait-output",
      pane,
      "--match",
      "Press ctrl+o",
      "--timeout",
      "30000",
    ]);
    herdr(side, ["pane", "send-text", pane, "/manager"]);
    herdr(side, ["pane", "send-keys", pane, "Enter"]);
    try {
      herdr(side, [
        "pane",
        "wait-output",
        pane,
        "--match",
        "Manager mode active.",
        "--timeout",
        "45000",
      ]);
    } catch (error) {
      const diag = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          "herdsman",
          ...herdrEnv(side),
          resources[side].container,
          "herdr",
          "--session",
          resources[side].herdrSession,
          "pane",
          "read",
          pane,
          "--source",
          "recent",
          "--lines",
          "100",
        ],
        { encoding: "utf8" },
      );
      throw new Error(
        `${side}: Manager activation failed; pane=${pane}; output=${diag.stdout}; error=${error.message}`,
      );
    }
    resources[side].managerActivated = true;
    save();
  }

  // Create real test-owned inputs and a canonical artifact using the shared
  // production persistence helper (no fake Manager record or identity).
  const resultId = randomUUID();
  const resultRef = `result:${resultId}`;
  const specText = `# Federation smoke ${runId}\n\nRead this exact specification and report the supplied canonical artifact digest.\n`;
  const artifactText = `canonical evidence for ${runId}\n`;
  const specHostPath = join(root, "spec.md");
  writeFileSync(specHostPath, specText, { mode: 0o600 });
  command("docker", [
    "cp",
    specHostPath,
    `${resources.a.container}:${resources.a.runtime.workspace}/spec.md`,
  ]);
  exec("a", [
    "chown",
    "herdsman:herdsman",
    `${resources.a.runtime.workspace}/spec.md`,
  ]);
  command("docker", [
    "cp",
    "extension/storage.ts",
    `${resources.a.container}:${fixturePath("a")}/storage.ts`,
  ]);
  command("docker", [
    "cp",
    "extension/storage.ts",
    `${resources.b.container}:${fixturePath("b")}/storage.ts`,
  ]);
  command("docker", [
    "cp",
    "extension/peer-correspondence.ts",
    `${resources.b.container}:${fixturePath("b")}/peer-correspondence.ts`,
  ]);
  const resultModule = `import { persistPeerResultArtifact } from 'file://${fixturePath("a")}/storage.ts';\npersistPeerResultArtifact(${JSON.stringify(resultRef)}, ${JSON.stringify(artifactText)});\n`;
  exec(
    "a",
    [
      "node",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      resultModule,
    ],
    ["--user", "herdsman", ...herdrEnv("a")],
  );
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  resources.evidence = {
    resultRef,
    artifactText,
    artifactSha256: digest(artifactText),
    specSha256: digest(specText),
  };
  const leadProfilePath = join(root, "managed-lead.md");
  writeFileSync(
    leadProfilePath,
    `---\nname: managed-lead\nmodel: smoke-faux/federated-peer-lead\ntools: [read]\nextensions: [${JSON.stringify(`${resources.b.runtime.piAgentDir}/extensions/smoke-faux.mjs`)}]\n---\n`,
    { mode: 0o644 },
  );
  command("docker", [
    "cp",
    leadProfilePath,
    `${resources.b.container}:${resources.b.runtime.piAgentDir}/agents/managed-lead.md`,
  ]);
  exec("b", [
    "chown",
    "herdsman:herdsman",
    `${resources.b.runtime.piAgentDir}/agents/managed-lead.md`,
  ]);
  save();

  herdr("a", [
    "machine",
    "add",
    "ssh://herdsman@peer-b",
    "--label",
    `${runId}-b`,
    "--remote-session",
    resources.b.herdrSession,
  ]);
  for (const side of ["a", "b"]) {
    const other = side === "a" ? "b" : "a";
    const result = command("docker", [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv(side),
      resources[side].container,
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${resources[side].runtime.home}/.ssh/known_hosts`,
      "-i",
      `${resources[side].runtime.home}/.ssh/id_ed25519`,
      `herdsman@peer-${other}`,
      "pi-herdsman-peer",
      "probe",
    ]);
    const probe = JSON.parse(result);
    const expectedRoot = `${resources[other].runtime.piAgentDir}/pi-herdsman`;
    const remoteManager = probe.peers.find((peer) => peer.role === "manager");
    if (probe.dataRoot !== expectedRoot || !remoteManager)
      throw new Error(
        `${side}->${other}: SSH endpoint did not observe the live Manager at expected root ${expectedRoot}; got ${result}`,
      );
    resources[side].remoteProbe = {
      dataRoot: probe.dataRoot,
      session: remoteManager.piSessionId,
      generation: remoteManager.claim?.id,
    };
    save();
  }
  // Ensure discovery reaches the verified remote Manager before message send.
  const listPeersPrompt = `PEER_E2E_A_SEND ${resultRef}`;
  const submitted = command("docker", [
    "exec",
    "--user",
    "herdsman",
    ...herdrEnv("a"),
    resources.a.container,
    "herdr",
    "--session",
    resources.a.herdrSession,
    "agent",
    "prompt",
    resources.a.paneId,
    listPeersPrompt,
    "--wait",
    "--timeout",
    "180000",
  ]);
  resources.a.requestSubmission = submitted;
  save();

  // B's completion marker proves it consumed the request, delegated locally,
  // and queued its reply. A has not polled for the reply yet.
  herdr("b", [
    "pane",
    "wait-output",
    resources.b.paneId,
    "--match",
    "PEER_E2E_B_REPLIED",
    "--timeout",
    "240000",
  ]);
  const correspondenceFiles = exec("b", [
    "sh",
    "-c",
    `find ${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peer-correspondences -maxdepth 1 -type f -name '*.json' -print`,
  ])
    .split("\n")
    .filter(Boolean);
  if (correspondenceFiles.length !== 1)
    throw new Error(
      `expected exactly one test correspondence, got ${correspondenceFiles.length}`,
    );
  const correspondence = JSON.parse(exec("b", ["cat", correspondenceFiles[0]]));
  if (
    correspondence.replies.length !== 1 ||
    correspondence.replies[0].acknowledged
  )
    throw new Error(
      `B did not retain exactly one pending reply: ${JSON.stringify(correspondence)}`,
    );
  const duplicateReplyCheck = `import {listPeerCorrespondences,queuePeerReply} from 'file://${fixturePath("b")}/peer-correspondence.ts';\nconst c=listPeerCorrespondences().find(x=>x.id===${JSON.stringify(correspondence.id)});const r=c?.replies[0];if(!r||queuePeerReply(c,r.id,r.text)!=='duplicate')throw Error('reply retry was not idempotent');let rejected=false;try{queuePeerReply(c,r.id,r.text+' conflict')}catch(e){rejected=/conflicting peer reply identity/.test(e.message)}if(!rejected)throw Error('conflicting reply identity was accepted');console.log('duplicate-and-conflict-reply-ok');\n`;
  const replyCheck = exec(
    "b",
    [
      "node",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      duplicateReplyCheck,
    ],
    ["--user", "herdsman", ...herdrEnv("b")],
  );
  if (!replyCheck.includes("duplicate-and-conflict-reply-ok"))
    throw new Error(`reply retry assertion failed: ${replyCheck}`);
  const pollRequest = {
    id: correspondence.id,
    expectedDataRoot: `${resources.b.runtime.piAgentDir}/pi-herdsman`,
    capability: correspondence.capability,
    originSession: correspondence.originSession,
    originGeneration: correspondence.originGeneration,
    recipientSession: correspondence.recipientSession,
    recipientGeneration: correspondence.recipientGeneration,
  };
  const pollArgs = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${resources.a.runtime.home}/.ssh/known_hosts`,
    "-i",
    `${resources.a.runtime.home}/.ssh/id_ed25519`,
    "herdsman@peer-b",
    "pi-herdsman-peer",
    "poll",
  ];
  const firstPoll = JSON.parse(
    command(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "/usr/bin/ssh",
        ...pollArgs,
      ],
      { input: JSON.stringify(pollRequest) },
    ),
  );
  const repeatedPoll = JSON.parse(
    command(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "/usr/bin/ssh",
        ...pollArgs,
      ],
      { input: JSON.stringify(pollRequest) },
    ),
  );
  if (
    firstPoll.replies?.[0]?.id !== correspondence.replies[0].id ||
    repeatedPoll.replies?.[0]?.id !== correspondence.replies[0].id
  )
    throw new Error(
      `repeated reply poll changed/lost the pending reply: ${JSON.stringify({ firstPoll, repeatedPoll })}`,
    );
  for (const tamper of [
    { originSession: randomUUID() },
    { originGeneration: randomUUID() },
  ]) {
    const rejected = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "/usr/bin/ssh",
        ...pollArgs,
      ],
      {
        input: JSON.stringify({ ...pollRequest, ...tamper }),
        encoding: "utf8",
      },
    );
    if (
      rejected.status === 0 ||
      !`${rejected.stderr}${rejected.stdout}`.includes(
        "peer correspondence authorization failed",
      )
    )
      throw new Error(
        `stale/replaced origin identity was not rejected: ${rejected.stderr}${rejected.stdout}`,
      );
  }
  resources.replyId = correspondence.replies[0].id;
  resources.replyRetryAssertions = {
    duplicateReply: true,
    conflictingReplyRejected: true,
    repeatedPoll: true,
    staleSessionRejected: true,
    staleGenerationRejected: true,
  };
  save();
  const envelopeText = exec("a", [
    "cat",
    `${fixturePath("a")}/last-accept.json`,
  ]);
  const envelope = JSON.parse(envelopeText);
  resources.acceptanceMessageId = envelope.record?.id;
  if (!resources.acceptanceMessageId)
    throw new Error("captured SSH acceptance omitted the message ID");
  const sshArgs = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${resources.a.runtime.home}/.ssh/known_hosts`,
    "-i",
    `${resources.a.runtime.home}/.ssh/id_ed25519`,
    "herdsman@peer-b",
    "pi-herdsman-peer",
    "accept",
  ];
  const duplicate = command(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "/usr/bin/ssh",
      ...sshArgs,
    ],
    { input: envelopeText },
  );
  const duplicateResult = JSON.parse(duplicate);
  if (
    !duplicateResult.accepted ||
    duplicateResult.id !== resources.acceptanceMessageId
  )
    throw new Error(
      `duplicate transfer was not idempotently accepted: ${duplicate}`,
    );
  const conflictingEnvelope = {
    ...envelope,
    record: {
      ...envelope.record,
      text: `${envelope.record.text}\nconflicting payload`,
    },
  };
  const conflict = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "/usr/bin/ssh",
      ...sshArgs,
    ],
    { input: JSON.stringify(conflictingEnvelope), encoding: "utf8" },
  );
  if (
    conflict.status === 0 ||
    !`${conflict.stderr}${conflict.stdout}`.includes(
      "conflicting peer message identity",
    )
  )
    throw new Error(
      `conflicting duplicate transfer was not rejected: ${conflict.stderr}${conflict.stdout}`,
    );
  resources.duplicateAcceptance = {
    sameIdAccepted: duplicateResult.id,
    conflictRejected: true,
  };
  const receivedDir = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/received-evidence`;
  const resultArtifact = `${receivedDir}/${resources.evidence.artifactSha256}-${resultId}`;
  const digestOutput = exec("b", [
    "sha256sum",
    `${receivedDir}/${resources.evidence.specSha256}-spec.md`,
    resultArtifact,
  ]);
  const receivedDigests = digestOutput
    .split("\n")
    .map((line) => line.split(/\s+/u)[0]);
  if (
    receivedDigests[0] !== resources.evidence.specSha256 ||
    receivedDigests[1] !== resources.evidence.artifactSha256
  )
    throw new Error(`forwarded evidence digest mismatch: ${digestOutput}`);
  const evidenceSnapshots = exec("b", [
    "sh",
    "-c",
    `find ${resources.b.runtime.piAgentDir}/pi-herdsman/evidence -type f -exec sha256sum '{}' +`,
  ]);
  const snapshotDigests = evidenceSnapshots
    .split("\n")
    .map((line) => line.split(/\s+/u)[0]);
  if (
    !snapshotDigests.includes(resources.evidence.specSha256) ||
    !snapshotDigests.includes(resources.evidence.artifactSha256)
  )
    throw new Error(
      `B's local assignment snapshots did not preserve both forwarded digests: ${evidenceSnapshots}`,
    );
  resources.evidence.receivedSpecSha256 = receivedDigests[0];
  resources.evidence.receivedResultSha256 = receivedDigests[1];
  resources.evidence.assignmentSnapshotDigests = snapshotDigests;
  resources.evidence.bLocalEvidenceReads = 2;
  save();
  const originalSession = resources.b.remoteProbe.session;
  const originalGeneration = resources.b.remoteProbe.generation;
  const sessionFile = JSON.parse(resources.a.requestSubmission).result.agent
    .agent_session.value;
  command("docker", [
    "network",
    "disconnect",
    resources.network,
    resources.a.container,
  ]);
  resources.a.disconnected = true;
  save();
  const paneProcesses = () =>
    JSON.parse(
      herdr("a", ["pane", "process-info", "--pane", resources.a.paneId]),
    ).result.process_info.foreground_processes;
  const oldPi = paneProcesses().find((process) => process.name === "pi");
  if (!oldPi?.pid)
    throw new Error(
      "A's exact Pi pane process was unavailable for same-session restart",
    );
  exec("a", ["kill", "-TERM", String(oldPi.pid)]);
  let stopped = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!paneProcesses().some((process) => process.name === "pi")) {
      stopped = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!stopped)
    throw new Error(`A's exact Pi process ${oldPi.pid} did not stop`);
  const resumeArgs = [
    "pi",
    "--model",
    "smoke-faux/federated-peer-a",
    "--extension",
    `${resources.a.runtime.piAgentDir}/extensions/smoke-faux.mjs`,
    "--session",
    sessionFile,
  ];
  const resumeCommand = resumeArgs
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  herdr("a", ["pane", "run", resources.a.paneId, resumeCommand]);
  let resumedProcess;
  for (let attempt = 0; attempt < 80; attempt++) {
    resumedProcess = paneProcesses().find(
      (process) => process.name === "pi" && process.argv?.includes(sessionFile),
    );
    if (resumedProcess) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!resumedProcess) {
    const output = herdr("a", [
      "pane",
      "read",
      resources.a.paneId,
      "--source",
      "recent",
      "--lines",
      "80",
    ]);
    throw new Error(
      `A Pi did not resume its exact session file ${sessionFile}; pane: ${output}`,
    );
  }
  command("docker", [
    "network",
    "connect",
    "--alias",
    "peer-a",
    resources.network,
    resources.a.container,
  ]);
  resources.a.disconnected = false;
  resources.a.reconnected = true;
  save();
  let resumedProbe;
  let resumedManager;
  for (let attempt = 0; attempt < 40; attempt++) {
    resumedProbe = JSON.parse(
      command("docker", [
        "exec",
        "--user",
        "herdsman",
        ...herdrEnv("b"),
        resources.b.container,
        "/usr/bin/ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${resources.b.runtime.home}/.ssh/known_hosts`,
        "-i",
        `${resources.b.runtime.home}/.ssh/id_ed25519`,
        "herdsman@peer-a",
        "pi-herdsman-peer",
        "probe",
      ]),
    );
    resumedManager = resumedProbe.peers.find(
      (peer) => peer.role === "manager" && peer.piSessionId === originalSession,
    );
    if (
      resumedManager &&
      resumedProbe.dataRoot ===
        `${resources.a.runtime.piAgentDir}/pi-herdsman` &&
      resumedManager.claim.id !== originalGeneration
    )
      break;
    resumedManager = undefined;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!resumedManager)
    throw new Error(
      `same-session Manager recovery did not preserve identity and replace generation: ${JSON.stringify(resumedProbe)}`,
    );
  resources.a.recoveredSession = resumedManager.piSessionId;
  resources.a.recoveredGeneration = resumedManager.claim.id;
  resources.a.staleGenerationRejected = true;
  save();
  herdr("a", [
    "agent",
    "prompt",
    resources.a.paneId,
    "PEER_E2E_A_POLL",
    "--wait",
    "--timeout",
    "180000",
  ]);
  const replyCompletion = herdr("a", [
    "pane",
    "wait-output",
    resources.a.paneId,
    "--match",
    "PEER_E2E_A_RECEIVED_REPLY",
    "--timeout",
    "60000",
  ]);
  resources.exchange = {
    requestReplyComplete: true,
    replyCompletionMarker: "PEER_E2E_A_RECEIVED_REPLY",
    interruptedAndReconnected: true,
  };
  save();

  console.log(
    `Fixture acceptance evidence: ${JSON.stringify({ runId, image: resources.image, network: resources.network, containers: resources.containers, volumes: resources.volumes, messageId: resources.acceptanceMessageId, replyId: resources.replyId, managers: { beforeRestart: resources.b.remoteProbe, recoveredSession: resources.a.recoveredSession, recoveredGeneration: resources.a.recoveredGeneration }, evidence: resources.evidence, assertions: { duplicateAcceptance: resources.duplicateAcceptance, replyRetries: resources.replyRetryAssertions, sameExactSessionRecovery: resources.a.recoveredSession === resources.b.remoteProbe.session, generationChanged: resources.a.recoveredGeneration !== resources.b.remoteProbe.generation, finalReplyCompletion: resources.exchange.replyCompletionMarker, disconnectedAndReconnected: resources.exchange.interruptedAndReconnected }, replyCompletion: replyCompletion.slice(-300) })}`,
  );
  if (process.env.PEER_SMOKE_KEEP === "1")
    console.log(`Retained exact resource manifest: ${manifestPath}`);
} finally {
  if (process.env.PEER_SMOKE_KEEP !== "1") cleanup();
}
