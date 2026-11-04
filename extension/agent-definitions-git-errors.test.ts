import assert from "node:assert/strict";
import * as realChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const diagnostic = "fatal: detected dubious ownership in repository at '/repo'";
mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    execFileSync() {
      const error = new Error("git failed") as Error & {
        status: number;
        stderr: Buffer;
      };
      error.status = 128;
      error.stderr = Buffer.from(`${diagnostic}\n`);
      throw error;
    },
  },
});

const { discoverAgentDefinitions } = await import("./agent-definitions.ts");

test("private definition discovery reports unexpected Git status-128 failures", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-git-error-"));
  try {
    assert.throws(
      () => discoverAgentDefinitions({ projectRoot: project }),
      (error: unknown) =>
        error instanceof Error && error.message.includes(diagnostic),
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
