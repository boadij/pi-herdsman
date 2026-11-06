import assert from "node:assert/strict";
import * as realChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    execFileSync(
      _file: string,
      _args: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) {
      const error = new Error("git failed") as Error & {
        status: number;
        stderr: Buffer;
      };
      error.status = 128;
      error.stderr = Buffer.from(
        options?.env?.LC_ALL === "C"
          ? "fatal: not a git repository (or any of the parent directories): .git\n"
          : "fatal: não é um repositório git (ou qualquer pai até o ponto de montagem /)\n",
      );
      throw error;
    },
  },
});

const { discoverAgentDefinitions } = await import("./agent-definitions.ts");

test("private definition discovery treats a non-repository as such under a translated Git locale", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-git-locale-"));
  try {
    assert.doesNotThrow(() =>
      discoverAgentDefinitions({ projectRoot: project }),
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
