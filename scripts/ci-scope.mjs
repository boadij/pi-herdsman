import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function classify(paths) {
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
    full();
    bootstrap = true;
  };

  for (const path of paths) {
    if (!path) continue;

    if (path.startsWith(".github/ISSUE_TEMPLATE/")) continue;

    if (
      path === "README.md" ||
      path === "SKILL.md" ||
      path === "LICENSE" ||
      path.startsWith("docs/")
    ) {
      packageCheck = true;
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

    if (path === "install.ps1") {
      bootstrap = true;
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

    if (/^scripts\/peer-federation.*\.test\.mjs$/u.test(path)) {
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
      path === "scripts/check-hang.mjs" ||
      path === "scripts/test-env.mjs" ||
      path === ".github/workflows/release.yml"
    ) {
      tests = true;
      continue;
    }

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

    if (
      path === "Dockerfile" ||
      path === ".dockerignore" ||
      path.startsWith("docker/")
    ) {
      smoke();
      peer = true;
      continue;
    }

    if (path === "scripts/container-smoke.sh") {
      smoke();
      continue;
    }

    if (path === "compose.yaml" || path === "compose.tailscale.yaml") {
      config();
      continue;
    }

    if (
      path === ".github/workflows/validate.yml" ||
      path === "scripts/ci-scope.mjs"
    ) {
      all();
      continue;
    }

    // ponytail: unknown paths fail toward more validation; narrow only when repeated CI cost proves useful.
    all();
  }

  return {
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
    tests: false,
    package: true,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify([".github/ISSUE_TEMPLATE/01-bug.yml"]), {
    tests: false,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["extension/core.test.ts"]), {
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["extension/index.ts"]), {
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: false,
    peer: true,
  });

  assert.deepEqual(classify(["compose.yaml"]), {
    tests: false,
    package: false,
    container: "config",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify([".github/workflows/release.yml"]), {
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["docs/README.md", "extension/config.test.ts"]), {
    tests: true,
    package: true,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["some-new-runtime-surface/file"]), {
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: true,
    peer: true,
  });

  assert.deepEqual(classify(["scripts/build.mjs"]), {
    tests: false,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: false,
    peer: true,
  });

  assert.deepEqual(classify(["scripts/smoke.mjs"]), {
    tests: true,
    package: true,
    container: "smoke",
    smoke: true,
    bootstrap: true,
    peer: true,
  });

  assert.deepEqual(classify(["Dockerfile"]), {
    tests: false,
    package: false,
    container: "smoke",
    smoke: false,
    bootstrap: false,
    peer: true,
  });

  assert.deepEqual(classify(["scripts/check.mjs"]), {
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["extension/core.test.ts", "docs/README.md"]), {
    tests: true,
    package: true,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  assert.deepEqual(classify(["install.ps1"]), {
    tests: false,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: true,
    peer: false,
  });

  assert.deepEqual(classify(["scripts/peer-federation-result.test.mjs"]), {
    tests: true,
    package: false,
    container: "none",
    smoke: false,
    bootstrap: false,
    peer: false,
  });

  process.exit(0);
}

const paths = readFileSync(0, "utf8").split("\0").filter(Boolean);

for (const [name, value] of Object.entries(classify(paths))) {
  console.log(`${name}=${value}`);
}
