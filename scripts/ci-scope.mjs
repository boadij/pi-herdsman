import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nodeTarget } from "./node-target.mjs";

function classify(paths) {
  let format = false;
  let tests = false;
  let packageCheck = false;
  let container = "none";
  let runtimeSmoke = false;
  let bootstrap = false;
  let peer = false;

  const smoke = () => {
    container = "smoke";
  };

  const config = () => {
    if (container === "none") container = "config";
  };

  const full = () => {
    tests = true;
    packageCheck = true;
    smoke();
    runtimeSmoke = true;
    peer = true;
  };

  const all = () => {
    format = true;
    full();
    bootstrap = true;
  };

  for (const path of paths) {
    if (!path) continue;

    if (
      path !== "CHANGELOG.md" &&
      path !== "package-lock.json" &&
      /\.(?:[cm]?[jt]sx?|json|ya?ml|md|css|html)$/u.test(path)
    )
      format = true;

    if (
      path === "AGENTS.md" ||
      path === "CONTRIBUTING.md" ||
      path === "CONTRIBUTORS.md" ||
      path === "CHANGELOG.md" ||
      path === ".oxfmtrc.json" ||
      path === "renovate.json" ||
      path === "release-please-config.json" ||
      path === ".release-please-manifest.json" ||
      path === ".github/pull_request_template.md" ||
      path.startsWith(".github/ISSUE_TEMPLATE/") ||
      path.startsWith(".agents/")
    ) {
      continue;
    }

    if (path === ".gitignore") {
      format = true;
      packageCheck = true;
      continue;
    }

    if (
      path === "README.md" ||
      path === "LICENSE" ||
      path.startsWith("docs/") ||
      path.startsWith("skills/")
    ) {
      packageCheck = true;
      continue;
    }

    if (
      path === "vendor/github-cli/SKILL.md" ||
      path === "vendor/github-cli/source.json" ||
      path === "vendor/gh-stack/SKILL.md" ||
      path === "vendor/gh-stack/source.json" ||
      /^vendor\/gh-stack\/references\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md$/u.test(
        path,
      )
    ) {
      format = true;
      tests = true;
      continue;
    }

    if (/^extension\/.*\.test\.ts$/u.test(path)) {
      tests = true;
      continue;
    }

    if (path.startsWith("extension/")) {
      full();
      continue;
    }

    if (path === "install.ps1" || path === "scripts/docker-setup.ps1") {
      tests = true;
      bootstrap = true;
      continue;
    }

    if (path === "scripts/docker-setup.sh") {
      tests = true;
      smoke();
      continue;
    }

    if (path === "scripts/docker-setup.test.sh") {
      tests = true;
      config();
      continue;
    }

    if (path === "scripts/docker-setup.test.ps1") {
      tests = true;
      bootstrap = true;
      continue;
    }

    if (path === "install.sh" || path.startsWith(".githooks/")) {
      tests = true;
      continue;
    }

    if (path === "package.json") {
      full();
      bootstrap = true;
      continue;
    }

    if (path === "package-lock.json") {
      full();
      continue;
    }

    if (/^scripts\/.*\.test\.mjs$/u.test(path)) {
      tests = true;
      continue;
    }

    if (path.startsWith("scripts/peer-federation-")) {
      tests = true;
      peer = true;
      continue;
    }

    if (
      path === "scripts/check.mjs" ||
      path === "scripts/check.d.mts" ||
      path === "scripts/check-progress.mjs" ||
      path === "scripts/check-hang.mjs" ||
      path === "scripts/test-env.mjs" ||
      path === ".github/workflows/release.yml" ||
      path === ".github/workflows/preview.yml"
    ) {
      tests = true;
      continue;
    }

    if (
      path === "scripts/update-vendored-skills.mjs" ||
      path === "scripts/verify-vendored-skills-branch.mjs" ||
      path === ".github/workflows/gh-skill-drift.yml"
    ) {
      tests = true;
      continue;
    }

    if (path === "scripts/smoke.mjs" || path === "scripts/smoke-faux.mjs") {
      tests = true;
      runtimeSmoke = true;
      if (path === "scripts/smoke-faux.mjs") peer = true;
      continue;
    }

    if (path === "scripts/tool-policy-diagnostic.mjs") continue;

    if (path === "scripts/build.mjs") {
      packageCheck = true;
      smoke();
      runtimeSmoke = true;
      peer = true;
      continue;
    }

    if (path === "scripts/package-audit.mjs") {
      packageCheck = true;
      peer = true;
      continue;
    }

    if (path === "Dockerfile" || path === ".dockerignore" || path.startsWith("docker/")) {
      if (path === "docker/pi-herdsman-peer" || path === "docker/pi-herdsman-peer.test.mjs")
        tests = true;
      smoke();
      peer = true;
      continue;
    }

    if (path === "scripts/container-smoke.sh") {
      smoke();
      continue;
    }

    if (path === "compose.yaml") {
      smoke();
      continue;
    }

    if (path === "compose.tailscale.yaml" || path === "compose.bind-mount.yaml") {
      config();
      continue;
    }

    if (path === ".github/workflows/validate.yml" || path === "scripts/ci-scope.mjs") {
      all();
      continue;
    }

    // ponytail: unknown paths fail toward more validation; narrow only when repeated CI cost proves useful.
    all();
  }

  return {
    format,
    tests,
    package: packageCheck,
    container,
    smoke: runtimeSmoke,
    bootstrap,
    peer,
  };
}

if (process.argv[2] === "--self-test") {
  assert.deepEqual(classify(["docs/guides/container-deployment.md"]), {
    format: true,
    tests: false,
    package: true,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify([".github/ISSUE_TEMPLATE/01-bug.yml"]), {
    format: true,
    tests: false,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["extension/core.test.ts"]), {
    format: true,
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["extension/index.ts"]), {
    format: true,
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: false,
    peer: true,
  });

  assert.deepEqual(classify(["compose.yaml"]), {
    format: true,
    tests: false,
    package: false,
    container: "smoke",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  for (const path of ["compose.tailscale.yaml", "compose.bind-mount.yaml"]) {
    assert.deepEqual(classify([path]), {
      format: true,
      tests: false,
      package: false,
      container: "config",
      smoke: false,
      bootstrap: false,
      peer: false,
    });
  }

  assert.deepEqual(classify([".github/workflows/release.yml"]), {
    format: true,
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["docs/README.md", "extension/config.test.ts"]), {
    format: true,
    tests: true,
    package: true,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["some-new-runtime-surface/file"]), {
    format: true,
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: true,
    peer: true,
  });

  for (const path of [
    "vendor/github-cli/SKILL.md",
    "vendor/github-cli/source.json",
    "vendor/gh-stack/SKILL.md",
    "vendor/gh-stack/source.json",
    "vendor/gh-stack/references/commands.md",
    "vendor/gh-stack/references/nested/example.md",
  ]) {
    assert.deepEqual(classify([path]), {
      format: true,
      tests: true,
      package: false,
      container: "none",
      smoke: false,
      bootstrap: false,
      peer: false,
    });
  }

  assert.deepEqual(classify(["vendor/gh-stack/scripts/update.mjs"]), {
    format: true,
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: true,
    peer: true,
  });

  assert.deepEqual(classify(["vendor/github-cli/tool.sh"]), {
    format: true,
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: true,
    peer: true,
  });

  assert.deepEqual(classify(["vendor/gh-stack/references/unmanaged file.md"]), {
    format: true,
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: true,
    peer: true,
  });

  assert.deepEqual(classify(["scripts/build.mjs"]), {
    format: true,
    tests: false,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: false,
    peer: true,
  });

  assert.deepEqual(classify(["scripts/smoke.mjs"]), {
    format: true,
    tests: true,
    package: false,
    container: "none",
    smoke: true,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["Dockerfile"]), {
    format: false,
    tests: false,
    package: false,
    container: "smoke",
    smoke: false,
    bootstrap: false,
    peer: true,
  });

  assert.deepEqual(classify(["extension/core.test.ts", "docs/README.md"]), {
    format: true,
    tests: true,
    package: true,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["install.ps1"]), {
    format: false,
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: true,
    peer: false,
  });

  assert.deepEqual(classify(["scripts/docker-setup.sh"]), {
    format: false,
    tests: true,
    package: false,
    container: "smoke",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["scripts/docker-setup.ps1"]), {
    format: false,
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: true,
    peer: false,
  });

  assert.deepEqual(classify(["scripts/docker-setup.test.sh"]), {
    format: false,
    tests: true,
    package: false,
    container: "config",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["scripts/docker-setup.test.ps1"]), {
    format: false,
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: true,
    peer: false,
  });

  assert.deepEqual(classify(["scripts/peer-federation-result.test.mjs"]), {
    format: true,
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  const expectOnly = (path, selected = {}) =>
    assert.deepEqual(classify([path]), {
      format: false,
      tests: false,
      package: false,
      container: "none",
      smoke: false,
      bootstrap: false,
      peer: false,
      ...selected,
    });

  for (const path of [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "CONTRIBUTORS.md",
    ".agents/skills/testing/SKILL.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/01-bug.yml",
    ".oxfmtrc.json",
    "renovate.json",
    "release-please-config.json",
    ".release-please-manifest.json",
    "scripts/tool-policy-diagnostic.mjs",
  ])
    expectOnly(path, { format: true });

  expectOnly("CHANGELOG.md");
  expectOnly("package-lock.json", {
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    peer: true,
  });
  assert.deepEqual(classify(["extension/core.test.ts", "package-lock.json"]), {
    format: true,
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: false,
    peer: true,
  });
  expectOnly(".gitignore", { format: true, package: true });
  expectOnly("LICENSE", { package: true });
  expectOnly("docs/assets/thumbnail.webp", { package: true });
  expectOnly("skills/agent-definitions/SKILL.md", {
    format: true,
    package: true,
  });
  expectOnly("docker/AGENTS.md", {
    format: true,
    container: "smoke",
    peer: true,
  });
  expectOnly("docker/pi-herdsman-peer", {
    tests: true,
    container: "smoke",
    peer: true,
  });
  expectOnly("docker/pi-herdsman-peer.test.mjs", {
    format: true,
    tests: true,
    container: "smoke",
    peer: true,
  });
  expectOnly("install.sh", { tests: true });
  expectOnly(".githooks/post-checkout", { tests: true });
  for (const path of [
    "scripts/check.mjs",
    "scripts/check.d.mts",
    "scripts/check-progress.mjs",
    "scripts/worktree-hook.test.mjs",
    ".github/workflows/preview.yml",
  ])
    expectOnly(path, { format: true, tests: true });
  expectOnly("scripts/smoke-faux.mjs", {
    format: true,
    tests: true,
    smoke: true,
    peer: true,
  });

  process.exit(0);
}

const paths = readFileSync(0, "utf8").split("\0").filter(Boolean);

for (const [name, value] of Object.entries(classify(paths))) {
  console.log(`${name}=${value}`);
}

console.log(`node_version=${nodeTarget.version}`);
