import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("launcher selects the Pi npm package and forwards its process contract", () => {
  const home = mkdtempSync(join(tmpdir(), "peer-launcher-"));
  try {
    const launcher = resolve("docker/pi-herdsman-peer");
    const run = (dir) =>
      spawnSync("sh", [launcher, "one", "two words"], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: dir,
        },
        input: "input\n",
        encoding: "utf8",
      });
    for (const [dir, setting] of [
      [join(home, ".pi/agent"), ""],
      [join(home, "custom"), "~/custom"],
      [join(home, "url"), pathToFileURL(join(home, "url")).href],
    ]) {
      const pkg = join(dir, "npm/node_modules/pi-herdsman");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "pi-herdsman" }),
      );
      writeFileSync(
        join(pkg, "dist/peer-bridge.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stderr); process.exitCode = 17;",
      );
      const result = run(setting);
      assert.equal(result.status, 17);
      assert.equal(result.stdout, '["one","two words"]');
      assert.equal(result.stderr, "input\n");
    }
    const missing = run(join(home, "missing"));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /invalid or missing installed package/);
    writeFileSync(
      join(home, ".pi/agent/npm/node_modules/pi-herdsman/package.json"),
      '{"name":"other"}',
    );
    assert.equal(run("").status, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launcher rejects symlinks in managed package paths", () => {
  for (const relative of [
    "npm",
    "npm/node_modules",
    "npm/node_modules/pi-herdsman",
    "npm/node_modules/pi-herdsman/package.json",
    "npm/node_modules/pi-herdsman/dist",
    "npm/node_modules/pi-herdsman/dist/peer-bridge.js",
  ]) {
    const home = mkdtempSync(join(tmpdir(), "peer-launcher-link-"));
    try {
      const agent = join(home, ".pi/agent");
      const pkg = join(agent, "npm/node_modules/pi-herdsman");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"name":"pi-herdsman"}');
      writeFileSync(join(pkg, "dist/peer-bridge.js"), "process.exit(42)");
      const target = join(agent, relative);
      const outside = join(home, "outside");
      renameSync(target, outside);
      symlinkSync(outside, target);
      const result = spawnSync("sh", [resolve("docker/pi-herdsman-peer")], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: "",
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 1, relative);
      assert.match(result.stderr, /invalid or missing installed package/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
