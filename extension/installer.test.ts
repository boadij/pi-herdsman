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
const windowsInstaller = resolve("install.ps1");

test("Windows bootstrap uses official temporary installers and preserves native channel selection", () => {
  const source = readFileSync(windowsInstaller, "utf8");
  assert.match(source, /https:\/\/pi\.dev\/install\.ps1/u);
  assert.match(source, /https:\/\/herdr\.dev\/install\.ps1/u);
  assert.match(source, /Invoke-WebRequest -Uri \$Url -OutFile \$file/u);
  assert.match(source, /finally \{ Remove-Item \$file -Force/u);
  assert.match(source, /-ExecutionPolicy Bypass -File \$file/u);
  assert.match(source, /GetEnvironmentVariable\('Path', 'User'\)/u);
  assert.match(source, /GetEnvironmentVariable\('Path', 'Machine'\)/u);
  assert.doesNotMatch(source, /-Channel\s/u);
  assert.match(
    source,
    /Invoke-RestMethod -Uri "https:\/\/registry\.npmjs\.org\/\$package\/latest"/u,
  );
  assert.ok(
    source.indexOf("Invoke-RestMethod -Uri") <
      source.indexOf("Invoke-UpstreamInstaller 'https://pi.dev/install.ps1'"),
  );
  assert.match(source, /Version 'npm\.cmd'/u);
  assert.match(source, /npm:pi-herdsman@/u);
  assert.match(source, /npm:pi-herdsman\(\?:/u);
  assert.match(source, /LASTEXITCODE -ne 0/u);
  assert.doesNotMatch(source, /IsInputRedirected/u);
  assert.match(source, /Node\.js and\/or npm are unavailable/u);
  const currentIntegration = /^pi: current \(v\d+\)(?: .+)?$/u;
  assert.ok(source.includes("'(?m)^pi: current \\(v\\d+\\)(?: .+)?$'"));
  for (const line of [
    "pi: current (v9)",
    "pi: current (v9) (C:\\Users\\user\\.herdr)",
  ]) {
    assert.match(line, currentIntegration);
  }
  for (const line of [
    "pi: outdated (v8)",
    "pi: repair required (v9)",
    "pi: not installed",
  ]) {
    assert.doesNotMatch(line, currentIntegration);
  }
});

function runWindowsBootstrap({
  pi = "1.4.0",
  herdr = "1.0.0",
  node = "22.19.0",
  installed = "",
  fail = "",
  status = "pi: current (v9) (C:\\mock\\integration)",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-herdsman-ps-test-"));
  const harness = join(root, "harness.ps1");
  const values = { pi, herdr, node, installed, fail, status };
  const escaped = JSON.stringify(values).replaceAll("'", "''");
  writeFileSync(
    harness,
    `
$ErrorActionPreference = 'Stop'
$script:case = ConvertFrom-Json '${escaped}'
$script:log = [System.Collections.Generic.List[string]]::new()
$script:LASTEXITCODE = 0
. '${windowsInstaller.replaceAll("'", "''")}' -DefinitionsOnly
function Invoke-RestMethod { [pscustomobject]@{ version='8.0.0'; engines=@{node='>=22.19.0'}; piHerdsman=@{runtime=@{pi='1.4.0';herdr=@{version='0.9.5'}}} } }
function Resolve-Command([string]$Name) {
  if ($Name -eq 'pi.cmd' -or $Name -eq 'pi') { return [pscustomobject]@{Source='MockPi'} }
  if ($Name -eq 'herdr.exe' -or $Name -eq 'herdr') { return [pscustomobject]@{Source='MockHerdr'} }
  if ($Name -eq 'node') { return [pscustomobject]@{Source='MockNode'} }
  if ($Name -eq 'npm.cmd') { return [pscustomobject]@{Source='MockNpm'} }
  return $null
}
function Version([string]$Command) {
  if ($Command -eq 'MockPi') { return [version]$script:case.pi }
  if ($Command -eq 'MockHerdr') { return [version]($script:case.herdr -replace '-preview(?:\..*)?$', '') }
  if ($Command -in @('MockNode', 'node')) { return [version]$script:case.node }
  if ($Command -eq 'npm.cmd') { return [version]'10.0.0' }
  throw "Unexpected version command: $Command"
}
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing) Set-Content -Path $OutFile -Value 'mock installer' }
function powershell.exe { $script:LASTEXITCODE=0; $env:Path += ';C:\\mock-installed' }
function Invoke-UpstreamInstaller([string]$Url) { $script:log.Add("installer $Url") }
function MockPi { param($Action,$Arg1,$Arg2,$Arg3) $script:LASTEXITCODE=0; if ($Action -eq 'list') { return $script:case.installed }; $script:log.Add("pi $Action $Arg1 $Arg2"); if ($script:case.fail -eq $Action) {$script:LASTEXITCODE=17} }
function MockHerdr { param($Action,$Arg1,$Arg2) $script:LASTEXITCODE=0; if ($Action -eq 'integration' -and $Arg1 -eq 'status') { return $script:case.status }; $script:log.Add("herdr $Action $Arg1 $Arg2"); if ($script:case.fail -eq 'integration') {$script:LASTEXITCODE=19} }
$failed = $false
try { Invoke-Bootstrap } catch { $failed = $true; [Console]::Error.WriteLine($_.Exception.Message) }
'RESULT failed=' + $failed
'LOG ' + ($script:log -join '|')
`,
  );
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      harness,
    ],
    { encoding: "utf8" },
  );
  rmSync(root, { recursive: true, force: true });
  return result;
}

test(
  "Windows bootstrap executes in native PowerShell and reconciles a fresh package install",
  { skip: process.platform !== "win32" },
  () => {
    const result = runWindowsBootstrap();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT failed=False/u);
    assert.match(result.stdout, /pi install npm:pi-herdsman --no-approve/u);
    assert.match(result.stdout, /herdr integration install pi/u);
    assert.match(result.stdout, /Next steps:/u);
  },
);

test(
  "Windows bootstrap refreshes PATH in the real upstream helper",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-herdsman-ps-path-"));
    const harness = join(root, "path.ps1");
    writeFileSync(
      harness,
      `
$ErrorActionPreference = 'Stop'
. '${windowsInstaller.replaceAll("'", "''")}' -DefinitionsOnly
$oldUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
  function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing) Set-Content -Path $OutFile -Value 'mock installer' }
  function powershell.exe { [Environment]::SetEnvironmentVariable('Path', 'C:\\mock-installed', 'User'); $script:LASTEXITCODE=0 }
  Invoke-UpstreamInstaller 'mock://installer'
  'PATHREFRESH ' + $env:Path.Contains('C:\\mock-installed')
} finally { [Environment]::SetEnvironmentVariable('Path', $oldUserPath, 'User') }
`,
    );
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        harness,
      ],
      { encoding: "utf8" },
    );
    rmSync(root, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PATHREFRESH True/u);
  },
);

test(
  "Windows upstream helper fails on a nonzero child exit and removes its temporary installer",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-herdsman-ps-child-failure-"));
    const harness = join(root, "failure.ps1");
    writeFileSync(
      harness,
      `
$ErrorActionPreference = 'Stop'
$env:TEMP = '${root.replaceAll("'", "''")}'
$fakeBin = Join-Path $env:TEMP 'bin'
New-Item -ItemType Directory -Path $fakeBin | Out-Null
Copy-Item (Join-Path $PSHOME 'powershell.exe') (Join-Path $fakeBin 'powershell.exe')
Copy-Item (Join-Path $PSHOME 'powershell.exe.config') $fakeBin
$env:Path = $fakeBin + ';' + $env:Path
. '${windowsInstaller.replaceAll("'", "''")}' -DefinitionsOnly
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing) Set-Content -Path $OutFile -Value 'exit 23' }
$failed = $false
try { Invoke-UpstreamInstaller 'mock://installer' } catch { $failed = $true }
$remaining = @(Get-ChildItem -Path $env:TEMP -Filter '*.ps1' | Where-Object { $_.Name -match '^[0-9a-f-]{36}\\.ps1$' })
'RESULT failed=' + $failed + ' remaining=' + $remaining.Count
`,
    );
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          harness,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /RESULT failed=True remaining=0/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows bootstrap preserves newer runtimes, updates only unpinned package, and refuses pins",
  { skip: process.platform !== "win32" },
  () => {
    const newer = runWindowsBootstrap({
      pi: "9.0.0",
      herdr: "9.0.0",
      installed: "npm:pi-herdsman (filtered)",
    });
    assert.equal(newer.status, 0, newer.stderr);
    assert.match(newer.stdout, /pi update npm:pi-herdsman --no-approve/u);
    assert.doesNotMatch(newer.stdout, /installer https:/u);
    const pinned = runWindowsBootstrap({ installed: "npm:pi-herdsman@^1.2.0" });
    assert.match(pinned.stdout, /RESULT failed=True/u);
    assert.match(pinned.stderr, /version-pinned/u);
    assert.doesNotMatch(pinned.stdout, /pi (install|update) /u);
    assert.doesNotMatch(pinned.stdout, /Next steps:/u);
  },
);

test(
  "Windows bootstrap accepts a preview-reported Herdr version and preserves its channel",
  { skip: process.platform !== "win32" },
  () => {
    const source = readFileSync(windowsInstaller, "utf8");
    assert.ok(source.includes("(?:-preview(?:\\.[0-9A-Za-z-]+)?)?"));
    const result = runWindowsBootstrap({ herdr: "0.9.6-preview.1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT failed=False/u);
    assert.doesNotMatch(result.stdout, /installer https:\/\/herdr\.dev/u);
    assert.match(result.stdout, /herdr integration install pi/u);
    assert.doesNotMatch(
      result.stdout,
      /-Channel|installer https:\/\/herdr\.dev/u,
    );
  },
);

test(
  "Windows bootstrap catches package and integration failures without success output",
  { skip: process.platform !== "win32" },
  () => {
    for (const fail of ["install", "integration"]) {
      const result = runWindowsBootstrap({ fail });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /RESULT failed=True/u);
      assert.doesNotMatch(
        result.stdout,
        /Next steps:|package operation completed/u,
      );
    }
  },
);

test(
  "Windows top-level installer exits nonzero when package installation fails",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-herdsman-ps-entrypoint-"));
    const bin = join(root, "bin");
    const harness = join(root, "entrypoint.ps1");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pi.cmd"),
      '@echo off\r\nif "%1"=="--version" (echo 1.4.0 & exit /b 0)\r\nif "%1"=="list" exit /b 0\r\nif "%1"=="install" (echo MOCK_PI_INSTALL_FAILED & exit /b 17)\r\nexit /b 0\r\n',
    );
    writeFileSync(
      join(bin, "herdr.cmd"),
      '@echo off\r\nif "%1"=="--version" (echo 1.0.0 & exit /b 0)\r\nif "%1"=="integration" if "%2"=="status" (echo pi: current (v9) & exit /b 0)\r\nexit /b 0\r\n',
    );
    writeFileSync(join(bin, "node.cmd"), "@echo 22.19.0\r\n");
    writeFileSync(join(bin, "npm.cmd"), "@echo 10.0.0\r\n");
    writeFileSync(
      harness,
      `
$env:Path = '${bin.replaceAll("'", "''")}' + ';' + $env:Path
function Invoke-RestMethod { [pscustomobject]@{ version='8.0.0'; engines=@{node='>=22.19.0'}; piHerdsman=@{runtime=@{pi='1.4.0';herdr=@{version='0.9.5'}}} } }
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing) throw "Unexpected Invoke-WebRequest: $Uri" }
& '${windowsInstaller.replaceAll("'", "''")}'
exit $LASTEXITCODE
`,
    );
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          harness,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, null, result.error?.message);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /MOCK_PI_INSTALL_FAILED/u);
      assert.doesNotMatch(
        result.stdout,
        /Next steps:|package operation completed/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows bootstrap rejects non-current Herdr integration status",
  { skip: process.platform !== "win32" },
  () => {
    for (const status of [
      "pi: outdated (v8)",
      "pi: repair required (v9)",
      "pi: legacy (v9)",
      "pi: not installed",
    ]) {
      const result = runWindowsBootstrap({ status });
      assert.match(result.stdout, /RESULT failed=True/u);
      assert.match(result.stderr, /not enabled\/current/u);
      assert.doesNotMatch(
        result.stdout,
        /Next steps:|package operation completed/u,
      );
    }
  },
);

test("released runtime metadata matches locked Pi packages and has Herdr checksums", () => {
  const runtime = packageJson.piHerdsman?.runtime;
  const piPackages = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  for (const name of piPackages) {
    assert.equal(packageJson.devDependencies[name], runtime?.pi);
    assert.equal(
      packageLock.packages[`node_modules/${name}`]?.version,
      runtime?.pi,
    );
  }
  assert.match(runtime?.herdr?.version ?? "", /^\d+\.\d+\.\d+$/u);
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
  piInstallerVersion = packageJson.piHerdsman.runtime.pi,
  initialPiList = "",
  piListFails = false,
  piInstallFails = false,
  piUpdateFails = false,
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
  writeFileSync(piList, initialPiList);

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
esac
`,
  );
  executable(
    join(bin, "pi"),
    `#!/bin/sh
case "\${1:-}" in
  --version) cat "$FAKE_PI_VERSION" ;;
  list) cat "$FAKE_PI_LIST"; [ "$FAKE_PI_LIST_FAILS" != true ] ;;
  install)
    printf 'pi %s\\n' "$*" >> "$FAKE_LOG"
    [ "$FAKE_PI_INSTALL_FAILS" != true ] || exit 1
    printf '  %s\\n' "$2" > "$FAKE_PI_LIST"
    ;;
  update)
    printf 'pi %s\\n' "$*" >> "$FAKE_LOG"
    [ "$FAKE_PI_UPDATE_FAILS" != true ] || exit 1
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
printf '%s\\n' "$FAKE_PI_INSTALLER_TARGET" > "$FAKE_PI_VERSION"
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
      FAKE_PI_LIST_FAILS: String(piListFails),
      FAKE_PI_INSTALL_FAILS: String(piInstallFails),
      FAKE_PI_UPDATE_FAILS: String(piUpdateFails),
      FAKE_HERDR_ASSET: herdrAsset,
      FAKE_PI_INSTALLER_TARGET: piInstallerVersion,
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
      assert.ok(
        first.stdout.includes(
          `Pi Herdsman package operation completed (target release ${packageJson.version})`,
        ),
      );
      assert.match(first.stdout, /Open your project and run: herdr/u);

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
      assert.match(second.stdout, /Pi Herdsman package operation completed/u);

      const secondLog = readFileSync(setup.log, "utf8");
      assert.doesNotMatch(secondLog, /https:\/\/pi\.dev\/install\.sh/u);
      assert.doesNotMatch(secondLog, /releases\/download\/v/u);
      assert.match(secondLog, /^pi update npm:pi-herdsman --no-approve$/mu);
      assert.doesNotMatch(secondLog, /^pi install /mu);
      assert.match(secondLog, /herdr integration install pi/u);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
);

test(
  "installer accepts a newer Pi selected by the upstream managed installer",
  { skip: process.platform === "win32" },
  () => {
    const setup = fixture({
      initialHerdrVersion: packageJson.piHerdsman.runtime.herdr.version,
      piInstallerVersion: "9.0.0",
    });
    try {
      const result = spawnSync("sh", [installer], {
        env: setup.env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stdout.includes(
          `Pi Herdsman package operation completed (target release ${packageJson.version})`,
        ),
      );
      assert.match(
        readFileSync(setup.log, "utf8"),
        /curl .*https:\/\/pi\.dev\/install\.sh/u,
      );
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
  "installer updates an exact unpinned source entry, including filtered entries",
  { skip: process.platform === "win32" },
  () => {
    const setup = fixture({
      initialPiList: "  npm:pi-herdsman (filtered)\n",
      initialPiVersion: packageJson.piHerdsman.runtime.pi,
      initialHerdrVersion: packageJson.piHerdsman.runtime.herdr.version,
    });
    try {
      const result = spawnSync("sh", [installer], {
        env: setup.env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        readFileSync(setup.log, "utf8"),
        /^pi update npm:pi-herdsman --no-approve$/mu,
      );
      assert.doesNotMatch(result.stdout, /installed version/u);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
);

test(
  "installer preserves pinned sources and refuses speculative installation when listing fails",
  { skip: process.platform === "win32" },
  () => {
    const pinned = fixture({
      initialPiList: "  npm:pi-herdsman@^1.2.0 (filtered)\n",
      initialPiVersion: packageJson.piHerdsman.runtime.pi,
      initialHerdrVersion: packageJson.piHerdsman.runtime.herdr.version,
    });
    const unavailable = fixture({
      piListFails: true,
      initialPiVersion: packageJson.piHerdsman.runtime.pi,
      initialHerdrVersion: packageJson.piHerdsman.runtime.herdr.version,
    });
    try {
      const pinnedResult = spawnSync("sh", [installer], {
        env: pinned.env,
        encoding: "utf8",
      });
      assert.notEqual(pinnedResult.status, 0);
      assert.doesNotMatch(pinnedResult.stdout, /Next steps:/u);
      assert.match(
        pinnedResult.stderr,
        /version-pinned; this bootstrap cannot reconcile it to the latest release\. Change or remove the pin with Pi's package manager to reconcile to the latest release/u,
      );
      assert.doesNotMatch(
        readFileSync(pinned.log, "utf8"),
        /^pi (install|update) /mu,
      );
      assert.doesNotMatch(pinnedResult.stdout, /package operation completed/u);

      const unavailableResult = spawnSync("sh", [installer], {
        env: unavailable.env,
        encoding: "utf8",
      });
      assert.notEqual(unavailableResult.status, 0);
      assert.doesNotMatch(unavailableResult.stdout, /Next steps:/u);
      assert.match(
        unavailableResult.stderr,
        /could not inspect installed Pi packages/u,
      );
      assert.doesNotMatch(
        readFileSync(unavailable.log, "utf8"),
        /^pi (install|update) /mu,
      );
      assert.doesNotMatch(
        unavailableResult.stdout,
        /package operation completed/u,
      );
    } finally {
      rmSync(pinned.root, { recursive: true, force: true });
      rmSync(unavailable.root, { recursive: true, force: true });
    }
  },
);

test(
  "installer reports install and update failures without success",
  { skip: process.platform === "win32" },
  () => {
    const absent = fixture({ piInstallFails: true });
    const present = fixture({
      initialPiList: "  npm:pi-herdsman\n",
      piUpdateFails: true,
    });
    try {
      for (const setup of [absent, present]) {
        const result = spawnSync("sh", [installer], {
          env: setup.env,
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /Next steps:/u);
        assert.doesNotMatch(result.stdout, /package operation completed/u);
      }
      assert.match(
        readFileSync(absent.log, "utf8"),
        /^pi install npm:pi-herdsman --no-approve$/mu,
      );
      assert.match(
        readFileSync(present.log, "utf8"),
        /^pi update npm:pi-herdsman --no-approve$/mu,
      );
    } finally {
      rmSync(absent.root, { recursive: true, force: true });
      rmSync(present.root, { recursive: true, force: true });
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
