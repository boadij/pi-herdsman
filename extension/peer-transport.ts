import {
  mkdirSync,
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { acquireProcessLock, ProcessLockOccupiedError } from "./lock.ts";
import { herdsmanDataRoot } from "./storage.ts";

export type SavedPeerMachine = Readonly<{
  id: string;
  label: string;
  target: string;
  reachable: boolean;
}>;
export type RemotePeerSnapshot = Readonly<{
  dataRoot: string;
  peers: Array<{
    role?: string;
    piSessionId: string;
    claim: { id: string };
    name?: string;
    cwd?: string;
    repo?: string;
    branch?: string;
    workspaceLabel?: string;
    sessionKind?: "ordinary" | "managed";
    build?: unknown;
  }>;
  ordinaryLeadsComplete?: boolean;
}>;

export function peerRecoveryRequest(
  request: Readonly<{
    id: string;
    capability: string;
    originSession: string;
    originGeneration: string;
    previousOriginGeneration: string;
    recipientSession: string;
    recipientGeneration: string;
  }>,
  expectedDataRoot: string,
): string {
  return JSON.stringify({ ...request, expectedDataRoot });
}

const COMMAND_TIMEOUT_MS = 15_000;
export const PEER_TRANSPORT_FRAME_LIMIT_BYTES = 2 * 1024 * 1024;
const OUTPUT_LIMIT = PEER_TRANSPORT_FRAME_LIMIT_BYTES;
const OUTBOUND_RECORD_LIMIT_BYTES = 12 * 1024 * 1024;

export function peerPayloadDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== "object") {
      const scalar = JSON.stringify(item);
      if (scalar === undefined) throw new Error("invalid peer digest payload");
      return scalar;
    }
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    const object = item as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export type RemotePeerOutbound = Readonly<{
  id: string;
  machine: SavedPeerMachine;
  dataRoot: string;
  session: string;
  claimId: string;
  recipientSession: string;
  digest: string;
  envelope: string;
}>;

export function resolveRemotePeerOutboundRetry(
  outbound: RemotePeerOutbound,
  status: {
    dataRoot?: unknown;
    id?: unknown;
    digest?: unknown;
    status?: unknown;
  },
  snapshot: RemotePeerSnapshot,
): { kind: "accepted" | "pending" } | { kind: "retry"; envelope: string } {
  if (
    status.dataRoot !== outbound.dataRoot ||
    status.id !== outbound.id ||
    status.digest !== outbound.digest ||
    snapshot.dataRoot !== outbound.dataRoot
  )
    return { kind: "pending" };
  if (status.status === "accepted") return { kind: "accepted" };
  if (status.status !== "absent") return { kind: "pending" };
  let correspondenceRole: "manager" | "lead";
  try {
    const parsed: unknown = JSON.parse(outbound.envelope);
    if (!parsed || typeof parsed !== "object") return { kind: "pending" };
    const correspondence = (parsed as { correspondence?: { role?: unknown } })
      .correspondence;
    const source = (
      parsed as {
        record?: { peerSource?: { role?: unknown; remoteOrdinary?: unknown } };
      }
    ).record?.peerSource;
    correspondenceRole =
      correspondence?.role === undefined
        ? "manager"
        : (correspondence.role as "manager" | "lead");
    if (
      (correspondenceRole !== "manager" && correspondenceRole !== "lead") ||
      (correspondenceRole === "manager" && source?.role !== "manager") ||
      (correspondenceRole === "lead" &&
        (source?.role !== "lead" || source.remoteOrdinary !== true)) ||
      (correspondenceRole === "lead" && snapshot.ordinaryLeadsComplete !== true)
    )
      return { kind: "pending" };
  } catch {
    return { kind: "pending" };
  }
  const recipient = snapshot.peers.find(
    (peer) =>
      peer.role === correspondenceRole &&
      peer.piSessionId === outbound.recipientSession &&
      (correspondenceRole !== "lead" || peer.sessionKind === "ordinary"),
  );
  if (!recipient) return { kind: "pending" };
  const envelope = JSON.parse(outbound.envelope) as {
    record?: { id?: unknown; fromSessionId?: unknown; toSessionId?: unknown };
    recipientClaimId?: unknown;
    correspondence?: {
      originSession?: unknown;
      recipientSession?: unknown;
      recipientGeneration?: unknown;
    };
  };
  if (
    envelope.record?.id !== outbound.id ||
    envelope.record.fromSessionId !== outbound.session ||
    envelope.record.toSessionId !== outbound.recipientSession ||
    envelope.correspondence?.originSession !== outbound.session ||
    envelope.correspondence.recipientSession !== outbound.recipientSession
  )
    return { kind: "pending" };
  const full = JSON.parse(outbound.envelope) as {
    record: unknown;
    attachments?: unknown;
  };
  if (
    peerPayloadDigest({
      record: full.record,
      attachments: full.attachments,
    }) !== outbound.digest
  )
    return { kind: "pending" };
  if (envelope.recipientClaimId !== recipient.claim.id) {
    envelope.recipientClaimId = recipient.claim.id;
    envelope.correspondence.recipientGeneration = recipient.claim.id;
  }
  return { kind: "retry", envelope: JSON.stringify(envelope) };
}

function outboundDirectory(): string {
  const path = join(
    herdsmanDataRoot(),
    "runtime",
    "peers-v2",
    "remote-outbound",
  );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function tryClaimRemotePeerOutbound(
  id: string,
): (() => void) | undefined {
  try {
    return acquireProcessLock(
      join(outboundDirectory(), `${id}.delivery.lock`),
      { name: "peer outbound delivery" },
    ).release;
  } catch (error) {
    if (error instanceof ProcessLockOccupiedError) return undefined;
    throw error;
  }
}

export function persistRemotePeerOutbound(outbound: RemotePeerOutbound): void {
  const frameBytes = Buffer.byteLength(outbound.envelope, "utf8");
  const recordBytes = Buffer.byteLength(JSON.stringify(outbound), "utf8");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      outbound.id,
    ) ||
    frameBytes > PEER_TRANSPORT_FRAME_LIMIT_BYTES ||
    recordBytes > OUTBOUND_RECORD_LIMIT_BYTES
  )
    throw new Error("invalid remote peer outbound record");
  const path = join(outboundDirectory(), `${outbound.id}.json`);
  writeFileSync(path, `${JSON.stringify(outbound)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
}

export function retargetRemotePeerOutbound(
  id: string,
  digest: string,
  recipientSession: string,
  envelope: string,
): RemotePeerOutbound {
  const path = join(outboundDirectory(), `${id}.json`);
  const lock = acquireProcessLock(`${path}.lock`, {
    name: "peer outbound update",
  });
  try {
    const current = listRemotePeerOutbounds().find((item) => item.id === id);
    if (
      !current ||
      current.digest !== digest ||
      current.recipientSession !== recipientSession
    )
      throw new Error("remote peer outbound identity changed");
    const updated = { ...current, envelope };
    if (
      Buffer.byteLength(JSON.stringify(updated), "utf8") >
        OUTBOUND_RECORD_LIMIT_BYTES ||
      Buffer.byteLength(envelope, "utf8") > PEER_TRANSPORT_FRAME_LIMIT_BYTES
    )
      throw new Error("invalid remote peer outbound record");
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(updated)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    try {
      renameSync(temporary, path);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
    return updated;
  } finally {
    lock.release();
  }
}

export function listRemotePeerOutbounds(): RemotePeerOutbound[] {
  const directory = outboundDirectory();
  return readdirSync(directory)
    .filter((name) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(
        name,
      ),
    )
    .flatMap((name) => {
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > OUTBOUND_RECORD_LIMIT_BYTES
        )
          return [];
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          (value as RemotePeerOutbound).id !== name.slice(0, -5) ||
          typeof (value as RemotePeerOutbound).envelope !== "string"
        )
          return [];
        return [value as RemotePeerOutbound];
      } catch {
        return [];
      }
    });
}

export function removeRemotePeerOutbound(id: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)
  )
    return;
  try {
    unlinkSync(join(outboundDirectory(), `${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function run(
  command: string,
  args: readonly string[],
  input?: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Peer transport was cancelled"));
      return;
    }
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let settled = false;
    let stdinError: Error | undefined;
    const timeout = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    let abortKill: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      abortKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      if (abortKill) clearTimeout(abortKill);
      signal?.removeEventListener("abort", cancel);
      child.stdin.removeListener("error", onStdinError);
    };
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const onStdinError = (error: Error) => {
      stdinError ??= error;
    };
    child.stdin.on("error", onStdinError);
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => {
      finish(error);
    });
    child.once("close", (code) => {
      if (stdinError) finish(stdinError);
      else if (signal?.aborted)
        finish(new Error("Peer transport was cancelled"));
      else if (code === 0) finish(undefined, stdout);
      else {
        const error = new Error(stderr.trim() || `${command} exited ${code}`);
        Object.assign(error, { exitCode: code });
        finish(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function listSavedPeerMachines(
  signal?: AbortSignal,
): Promise<SavedPeerMachine[]> {
  const [listText, statusText] = await Promise.all([
    run("herdr", ["machine", "list", "--json"], undefined, signal),
    run("herdr", ["machine", "status", "--json"], undefined, signal),
  ]);
  const list: unknown = JSON.parse(listText);
  const statuses: unknown = JSON.parse(statusText);
  if (!Array.isArray(list) || !Array.isArray(statuses))
    throw new Error("Herdr returned invalid machine data");
  const statusById = new Map<string, string>(
    statuses
      .filter(
        (item): item is { id: string; status: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string" &&
          (item as { status?: unknown }).status === "reachable",
      )
      .map((item) => [item.id, item.status]),
  );
  const machines = list.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { enabled?: unknown }).enabled !== true ||
      typeof (item as { id?: unknown }).id !== "string" ||
      typeof (item as { label?: unknown }).label !== "string" ||
      typeof (item as { target?: unknown }).target !== "string"
    )
      return [];
    return [
      {
        id: (item as { id: string }).id,
        label: (item as { label: string }).label,
        target: (item as { target: string }).target,
        reachable: statusById.get((item as { id: string }).id) === "reachable",
      },
    ];
  });
  return machines;
}

export function parsePeerSshTarget(target: string): {
  host: string;
  port?: string;
} {
  if (target.startsWith("ssh://")) {
    const url = new URL(target);
    if (
      url.protocol !== "ssh:" ||
      !url.hostname ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    )
      throw new Error("Unsupported saved SSH target");
    const username = url.username ? `${decodeURIComponent(url.username)}@` : "";
    const host = `${username}${url.hostname}`;
    if (/^[\s-]|[\s\0]/u.test(host))
      throw new Error("Unsupported saved SSH target");
    return {
      host,
      ...(url.port ? { port: url.port } : {}),
    };
  }
  if (!target || /[\s\0]/u.test(target) || target.startsWith("-"))
    throw new Error("Unsupported saved SSH target");
  return { host: target };
}

export async function runPeerEndpoint(
  machine: SavedPeerMachine,
  action:
    | "probe"
    | "accept"
    | "status"
    | "poll"
    | "ack"
    | "finalize"
    | "recover"
    | "recover-recipient",
  input?: string,
  signal?: AbortSignal,
): Promise<string> {
  const target = parsePeerSshTarget(machine.target);
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.port ? ["-p", target.port] : []),
    target.host,
    `pi-herdsman-peer ${action}`,
  ];
  return run("ssh", args, input, signal);
}

export async function tryPollPeerReplies(
  poll: () => Promise<string>,
): Promise<string | undefined> {
  try {
    return await poll();
  } catch {
    return undefined;
  }
}

export async function probePeerEndpoint(
  machine: SavedPeerMachine,
  signal?: AbortSignal,
): Promise<RemotePeerSnapshot> {
  const output = await runPeerEndpoint(machine, "probe", undefined, signal);
  const probe: unknown = JSON.parse(output);
  if (
    !probe ||
    typeof probe !== "object" ||
    typeof (probe as { dataRoot?: unknown }).dataRoot !== "string" ||
    !Array.isArray((probe as { peers?: unknown }).peers)
  )
    throw new Error("Peer endpoint returned invalid probe data");
  const snapshot = probe as RemotePeerSnapshot;
  if (
    snapshot.peers.some(
      (peer) =>
        !peer ||
        typeof peer !== "object" ||
        typeof peer.piSessionId !== "string" ||
        peer.piSessionId.length === 0 ||
        !peer.claim ||
        typeof peer.claim.id !== "string" ||
        peer.claim.id.length === 0 ||
        (peer.role !== "manager" && peer.role !== "lead") ||
        (peer.role === "lead" &&
          peer.sessionKind !== "ordinary" &&
          peer.sessionKind !== "managed"),
    ) ||
    (snapshot.ordinaryLeadsComplete !== undefined &&
      typeof snapshot.ordinaryLeadsComplete !== "boolean")
  )
    throw new Error("Peer endpoint returned invalid probe data");
  return snapshot;
}
