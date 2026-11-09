import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptionsWithStringEncoding,
  StdioOptions,
} from "node:child_process";

export const CHECK_TIMEOUT_MS: 360_000;
export const WORKER_SNAPSHOT_AT_MS: 335_000;
export const windowsTestFileClassifierScript: string;

export function windowsTestFile(command: string): string | undefined;

type SnapshotCapture = {
  promise: Promise<string>;
  cancelAndWait?: () => boolean | Promise<boolean>;
};

type WindowsSnapshotCapture = {
  promise: Promise<string>;
  cancelAndWait: () => Promise<boolean>;
};

type SnapshotRunner = (
  pid: number,
  signal: AbortSignal,
) => string | Promise<string> | SnapshotCapture;

type SnapshotExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr?: string,
  ) => void,
) => ChildProcess;

type ActiveProcessCleanup =
  | {
      forceSent: boolean;
      runnerGone: boolean;
      treeGone: undefined;
      cleanupError: string | undefined;
      termSent?: never;
      killSent?: never;
    }
  | {
      termSent: boolean;
      killSent: boolean;
      treeGone: boolean;
      cleanupError: string | undefined;
      forceSent?: never;
      runnerGone?: never;
    };

type SuccessfulTimeoutCleanup =
  | {
      forceSent: boolean;
      runnerGone: true;
      treeGone: undefined;
      cleanupError: undefined;
      termSent?: never;
      killSent?: never;
    }
  | {
      termSent: boolean;
      killSent: boolean;
      treeGone: true;
      cleanupError: undefined;
      forceSent?: never;
      runnerGone?: never;
    };

type NoCleanup = {
  forceSent?: never;
  runnerGone?: never;
  termSent?: never;
  killSent?: never;
  treeGone?: never;
  cleanupError?: never;
};

type NoProcessCleanup =
  | {
      forceSent: false;
      treeGone: true;
      cleanupError: undefined;
      runnerGone?: never;
      termSent?: never;
      killSent?: never;
    }
  | {
      termSent: false;
      killSent: false;
      treeGone: true;
      cleanupError: undefined;
      forceSent?: never;
      runnerGone?: never;
    };

type CloseResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type RunnerResult =
  | ({
      ok: true;
      kind?: never;
      label: string;
      pid: number;
      close: CloseResult;
      timedOut?: never;
      captureStopUnconfirmed?: never;
      workerDiagnostic?: never;
      diagnostic?: never;
    } & NoCleanup)
  | ({
      ok: false;
      kind: "suite-timeout";
      label: string;
      diagnostic: string;
      pid?: never;
      close?: never;
      timedOut?: never;
      captureStopUnconfirmed?: never;
      workerDiagnostic?: never;
    } & NoCleanup)
  | ({
      ok: false;
      kind: "suite-timeout";
      label: string;
      pid: number;
      timedOut: true;
      close: CloseResult;
      workerDiagnostic: string | undefined;
      diagnostic: string;
      captureStopUnconfirmed?: never;
    } & SuccessfulTimeoutCleanup)
  | ({
      ok: false;
      kind: "suite-timeout-cleanup-failed";
      label: string;
      pid: number;
      timedOut: true;
      captureStopUnconfirmed?: true;
      close: CloseResult | undefined;
      workerDiagnostic: string | undefined;
      diagnostic: string;
    } & ActiveProcessCleanup)
  | ({
      ok: false;
      kind: "spawn-failed";
      label: string;
      close: CloseResult | undefined;
      diagnostic: string;
      timedOut?: never;
      captureStopUnconfirmed?: never;
      workerDiagnostic?: never;
    } & (
      | (ActiveProcessCleanup & { pid: number })
      | (NoProcessCleanup & { pid?: never })
    ))
  | {
      ok: false;
      kind: "leaked-process-tree";
      label: string;
      pid: number;
      close: CloseResult;
      diagnostic: string;
      timedOut?: never;
      captureStopUnconfirmed?: never;
      workerDiagnostic?: never;
      forceSent?: never;
      runnerGone?: never;
      treeGone: true;
      cleanupError: string | undefined;
      termSent: boolean;
      killSent: boolean;
    }
  | {
      ok: false;
      kind: "leaked-process-tree-cleanup-failed";
      label: string;
      pid: number;
      close: CloseResult;
      diagnostic: string;
      timedOut?: never;
      captureStopUnconfirmed?: never;
      workerDiagnostic?: never;
      forceSent?: never;
      runnerGone?: never;
      treeGone: false;
      cleanupError: string | undefined;
      termSent: boolean;
      killSent: boolean;
    }
  | ({
      ok: false;
      kind: "test-runner-failed";
      label: string;
      pid: number;
      close: CloseResult;
      diagnostic: string;
      timedOut?: never;
      captureStopUnconfirmed?: never;
      workerDiagnostic?: never;
    } & NoCleanup);

export function snapshotWindowsTestWorkers(
  pid: number,
  signal: AbortSignal,
  execFileImpl?: SnapshotExecFile,
  terminateTree?: (pid: number) => unknown,
): WindowsSnapshotCapture;

export function runTestRunner(
  args: readonly string[],
  deadline: number | Promise<number>,
  label?: string,
  snapshot?: SnapshotRunner,
  stdio?: StdioOptions,
  diagnosticOptions?: {
    snapshotAt?: number;
    emit?: (text: string) => void;
  },
): Promise<RunnerResult>;

export function runCheck(
  mode?: string,
): Promise<RunnerResult | { ok: false; kind: "usage"; diagnostic: string }>;
