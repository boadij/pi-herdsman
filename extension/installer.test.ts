import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const packageLock = JSON.parse(
  readFileSync(resolve("package-lock.json"), "utf8"),
);
const installer = resolve("install.sh");

test("released runtime metadata matches the locked Pi and has Herdr checksums", () => {
  const runtime = packageJson.piHerdsman?.runtime;
  assert.equal(
    runtime?.pi,
    packageLock.packages["node_modules/@earendil-works/pi-coding-agent"]
      ?.version,
  );
  assert.match(
    runtime?.herdr?.version ?? "",
    /^\d+\.\d+\.\d+$/u,
  );
  assert.deepEqual(Object.keys(runtime?.herdr?.sha256 ?? {}).sort(), [
    "linux-aarch64",
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
  ]);
  for (const checksum of Object.values(runtime.herdr.sha256)) {
    assert.match(checksum, /^[0-9a-f]{64}$/u);
  }
});

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function fixture({
  badChecksum = false,
  initialPiVersion = "0.1.0",
  initialHerdrVersion = "0.1.0",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-install-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);

  const log = join(root, "log");
  const manifest = join(root, "manifest.json");
  const piVersion = join(root, "pi-version");
  const herdrVersion = join(root, "herdr-version");
  const piList = join(root, "pi-list");
  const herdrAsset = join(root, "herdr-asset");

  writeFileSync(log, "");
  writeFileSync(piVersion, `${initialPiVersion}\n`);
  writeFileSync(herdrVersion, `${initialHerdrVersion}\n`);
  writeFileSync(piList, `  npm:pi-herdsman@${packageJson.version}\n`);

  executable(
    herdrAsset,
    `#!/bin/sh
case "\${1:-}" in
  --version) printf 'herdr %s\\n' "$FAKE_HERDR_TARGET" ;;
  integration) printf 'herdr %s\\n' "$*" >> "$FAKE_LOG" ;;
esac
`,
  );

  const runtime = structuredClone(packageJson.piHerdsman.runtime);
  runtime.herdr.sha256["linux-x86_64"] = badChecksum
    ? "0".repeat(64)
    : createHash("sha256").update(readFileSync(herdrAsset)).digest("hex");
  writeFileSync(
    manifest,
    JSON.stringify({
      name: packageJson.name,
      version: packageJson.version,
      piHerdsman: { runtime },
    }),
  );

  executable(
    join(bin, "uname"),
    `#!/bin/sh
case "\${1:-}" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  -o) echo GNU/Linux ;;
  *) echo Linux ;;
esac
`,
  );
  executable(
    join(bin, "node"),
    `#!/bin/sh
case "\${2:-}" in
  *process.versions.node*) exit 0 ;;
esac
exec "$REAL_NODE" "$@"
`,
  );
  executable(
    join(bin, "npm"),
    `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$FAKE_LOG"
case "\${1:-}" in
  view) cat "$FAKE_MANIFEST" ;;
  install) printf '%s\\n' "$FAKE_PI_TARGET" > "$FAKE_PI_VERSION" ;;
esac
`,
  );
  executable(
    join(bin, "pi"),
    `#!/bin/sh
case "\${1:-}" in
  --version) cat "$FAKE_PI_VERSION" ;;
  list) cat "$FAKE_PI_LIST" ;;
  install)
    printf 'pi %s\\n' "$*" >> "$FAKE_LOG"
    printf '  %s\\n' "$2" > "$FAKE_PI_LIST"
    ;;
esac
`,
  );
  executable(
    join(bin, "herdr"),
    `#!/bin/sh
case "\${1:-}" in
  --version) cat "$FAKE_HERDR_VERSION" ;;
  integration) printf 'herdr %s\\n' "$*" >> "$FAKE_LOG" ;;
esac
`,
  );
  executable(
    join(bin, "curl"),
    `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *https://pi.dev/install.sh*)
    cat <<'SH'
#!/bin/sh
printf '%s\\n' "$FAKE_PI_TARGET" > "$FAKE_PI_VERSION"
SH
    exit 0
    ;;
esac
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    out="$2"
    shift 2
    continue
  fi
  shift
done
cp "$FAKE_HERDR_ASSET" "$out"
`,
  );
  executable(
    join(bin, "sha256sum"),
    `#!/bin/sh
"$REAL_NODE" -e '
const { createHash } = require("node:crypto");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(createHash("sha256").update(Buffer.concat(chunks)).digest("hex") + "  -\\n");
});
'
`,
  );

  return {
    root,
    bin,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      HERDR_INSTALL_DIR: bin,
      REAL_NODE: process.execPath,
      FAKE_LOG: log,
      FAKE_MANIFEST: manifest,
      FAKE_PI_VERSION: piVersion,
      FAKE_HERDR_VERSION: herdrVersion,
      FAKE_PI_LIST: piList,
      FAKE_HERDR_ASSET: herdrAsset,
      FAKE_PI_TARGET: packageJson.piHerdsman.runtime.pi,
      FAKE_HERDR_TARGET: packageJson.piHerdsman.runtime.herdr.version,
    },
  };
}

test(
  "installer raises older runtimes to tested baselines and repeat runs leave them alone",
  { skip: process.platform === "win32" },
  () => {
    const setup = fixture();
    try {
      const first = spawnSync("sh", [installer], {
        env: setup.env,
        encoding: "utf8",
      });
      assert.equal(first.status, 0, first.stderr);
      assert.match(
        first.stdout,
        new RegExp(
          `Pi Herdsman ${packageJson.version} ready with Pi ${packageJson.piHerdsman.runtime.pi} and Herdr ${packageJson.piHerdsman.runtime.herdr.version}`,
          "u",
        ),
      );

      const firstLog = readFileSync(setup.log, "utf8");
      assert.match(firstLog, /curl .*https:\/\/pi\.dev\/install\.sh/u);
      assert.match(firstLog, /pi install npm:pi-herdsman --no-approve/u);
      assert.match(firstLog, /herdr integration install pi/u);
      assert.match(
        firstLog,
        new RegExp(
          `releases/download/v${packageJson.piHerdsman.runtime.herdr.version}/herdr-linux-x86_64`,
          "u",
        ),
      );

      writeFileSync(setup.log, "");
      const second = spawnSync("sh", [installer], {
        env: setup.env,
        encoding: "utf8",
      });
      assert.equal(second.status, 0, second.stderr);
      assert.ok(
        second.stdout.includes(
          `Pi ${packageJson.piHerdsman.runtime.pi} already satisfies tested baseline ${packageJson.piHerdsman.runtime.pi}`,
        ),
      );
      assert.ok(
        second.stdout.includes(
          `Herdr ${packageJson.piHerdsman.runtime.herdr.version} already satisfies tested baseline ${packageJson.piHerdsman.runtime.herdr.version}`,
        ),
      );
      assert.ok(
        second.stdout.includes(
          `Pi Herdsman ${packageJson.version} already installed`,
        ),
      );

      const secondLog = readFileSync(setup.log, "utf8");
      assert.doesNotMatch(secondLog, /https:\/\/pi\.dev\/install\.sh/u);
      assert.doesNotMatch(secondLog, /releases\/download\/v/u);
      assert.doesNotMatch(secondLog, /^pi install /mu);
      assert.match(secondLog, /herdr integration install pi/u);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
);

test(
  "installer does not downgrade newer Pi or Herdr runtimes",
  { skip: process.platform === "win32" },
  () => {
    const setup = fixture({
      initialPiVersion: "9.0.0",
      initialHerdrVersion: "9.0.0",
    });
    try {
      const result = spawnSync("sh", [installer], {
        env: setup.env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stdout.includes(
          `Pi 9.0.0 already satisfies tested baseline ${packageJson.piHerdsman.runtime.pi}`,
        ),
      );
      assert.ok(
        result.stdout.includes(
          `Herdr 9.0.0 already satisfies tested baseline ${packageJson.piHerdsman.runtime.herdr.version}`,
        ),
      );

      const log = readFileSync(setup.log, "utf8");
      assert.doesNotMatch(log, /https:\/\/pi\.dev\/install\.sh/u);
      assert.doesNotMatch(log, /releases\/download\/v/u);
      assert.match(log, /herdr integration install pi/u);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
);

test(
  "installer rejects a mismatched Herdr checksum before replacing the binary",
  { skip: process.platform === "win32" },
  () => {
    const setup = fixture({ badChecksum: true });
    try {
      const result = spawnSync("sh", [installer], {
        env: setup.env,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /downloaded Herdr checksum did not match/u);
      assert.match(
        readFileSync(join(setup.bin, "herdr"), "utf8"),
        /FAKE_HERDR_VERSION/u,
      );
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
);
