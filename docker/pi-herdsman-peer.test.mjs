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
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), "peer-launcher-"));
  const agent = join(home, ".pi/agent");
  mkdirSync(agent, { recursive: true });
  const settings = (packages) =>
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages }));
  const packageAt = (root, marker = "local", name = "pi-herdsman") => {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        pi: { extensions: ["./dist/index.js"] },
      }),
    );
    writeFileSync(join(root, "dist/index.js"), "");
    writeFileSync(
      join(root, "dist/peer-bridge.js"),
      `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stderr); process.exitCode = 17;`,
    );
  };
  const run = (dir = "") =>
    spawnSync("sh", [resolve("docker/pi-herdsman-peer"), "one", "two words"], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: dir,
      },
      input: "input\n",
      encoding: "utf8",
    });
  try {
    fn({ home, agent, settings, packageAt, run });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("launcher selects configured npm package and forwards the process contract for agent directory forms", () => {
  fixture(({ home, agent, settings, packageAt, run }) => {
    for (const [dir, setting] of [
      [agent, ""],
      [join(home, "custom"), "~/custom"],
      [join(home, "url"), pathToFileURL(join(home, "url")).href],
    ]) {
      packageAt(join(dir, "npm/node_modules/pi-herdsman"), "npm");
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ packages: ["npm:pi-herdsman@1.0"] }),
      );
      const result = run(setting);
      assert.equal(result.status, 17);
      assert.equal(result.stdout, 'npm["one","two words"]');
      assert.equal(result.stderr, "input\n");
    }
    settings([]);
    assert.match(run().stderr, /no supported Herdsman/);
  });
});

test("launcher resolves selected local packages and rejects ambiguous selections", () => {
  fixture(({ home, agent, settings, packageAt, run }) => {
    const npm = join(agent, "npm/node_modules/pi-herdsman");
    const local = join(home, "dev/herdsman");
    const other = join(home, "other");
    const second = join(home, "second");
    packageAt(npm, "npm");
    packageAt(local);
    packageAt(other, "other", "other");
    packageAt(second);
    const rel = relative(agent, local);
    for (const [packages, marker] of [
      [[local], "local"],
      [[rel], "local"],
      [[{ source: rel }], "local"],
      [[rel, local], "local"],
      [[other, "npm:pi-herdsman"], "npm"],
      [["npm:pi-herdsman", "npm:pi-herdsman@1"], "npm"],
    ]) {
      settings(packages);
      const result = run();
      assert.equal(result.status, 17, JSON.stringify(packages));
      assert.ok(result.stdout.startsWith(marker));
    }
    for (const packages of [
      ["npm:pi-herdsman", local],
      [local, second],
    ]) {
      settings(packages);
      assert.match(run().stderr, /multiple Herdsman package sources/);
      assert.equal(run().status, 1);
    }
    settings([{ source: local, extensions: [] }]);
    assert.match(run().stderr, /unsupported Herdsman extension filter/);
    settings([
      "git:https://example.invalid/repo",
      "https://example.invalid/repo",
    ]);
    assert.match(run().stderr, /no supported Herdsman/);
    writeFileSync(join(agent, "settings.json"), "{");
    assert.equal(run().status, 1);
  });
});

test("launcher rejects selected manifests without the runtime identity and declaration", () => {
  for (const local of [false, true])
    fixture(({ home, agent, settings, packageAt, run }) => {
      const root = local
        ? join(home, "local")
        : join(agent, "npm/node_modules/pi-herdsman");
      packageAt(root);
      settings([local ? root : "npm:pi-herdsman"]);
      for (const manifest of [
        { name: "pi-herdsman" },
        {
          name: "pi-herdsman",
          version: "",
          pi: { extensions: ["./dist/index.js"] },
        },
        {
          name: "pi-herdsman",
          version: 1,
          pi: { extensions: ["./dist/index.js"] },
        },
        { name: "pi-herdsman", version: "1.0.0" },
        {
          name: "pi-herdsman",
          version: "1.0.0",
          pi: { extensions: "./dist/index.js" },
        },
        {
          name: "pi-herdsman",
          version: "1.0.0",
          pi: { extensions: ["./other.js"] },
        },
      ]) {
        writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
        const result = run();
        assert.equal(result.status, 1, JSON.stringify(manifest));
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /invalid package manifest/);
      }
    });
});

test("launcher rejects invalid builds and symlinks in selected package paths", () => {
  for (const [local, relativePath] of [
    ...[
      "npm",
      "npm/node_modules",
      "npm/node_modules/pi-herdsman",
      "npm/node_modules/pi-herdsman/package.json",
      "npm/node_modules/pi-herdsman/dist",
      "npm/node_modules/pi-herdsman/dist/index.js",
      "npm/node_modules/pi-herdsman/dist/peer-bridge.js",
    ].map((p) => [false, p]),
    ...["", "package.json", "dist", "dist/index.js", "dist/peer-bridge.js"].map(
      (p) => [true, p],
    ),
  ])
    fixture(({ home, agent, settings, packageAt, run }) => {
      const root = local
        ? join(home, "local")
        : join(agent, "npm/node_modules/pi-herdsman");
      packageAt(root);
      settings([local ? root : "npm:pi-herdsman"]);
      const target = local
        ? join(root, relativePath)
        : join(agent, relativePath);
      const outside = join(home, "outside");
      renameSync(target, outside);
      symlinkSync(outside, target);
      assert.equal(run().status, 1, relativePath);
    });
  fixture(({ home, settings, packageAt, run }) => {
    const root = join(home, "local");
    packageAt(root);
    settings([root]);
    rmSync(join(root, "dist/index.js"));
    assert.equal(run().status, 1);
    writeFileSync(join(root, "package.json"), '{"name":"other"}');
    assert.equal(run().status, 1);
  });
});
