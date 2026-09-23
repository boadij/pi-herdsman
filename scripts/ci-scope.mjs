import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function classify(paths) {
  let tests = false;
  let packageCheck = false;
  let container = "none";

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
  };

  for (const path of paths) {
    if (!path) continue;

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

    if (path === "package.json" || path === "package-lock.json") {
      full();
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
      continue;
    }

    if (path === "scripts/package-audit.mjs") {
      packageCheck = true;
      continue;
    }

    if (
      path === "Dockerfile" ||
      path === ".dockerignore" ||
      path === "scripts/container-smoke.sh" ||
      path.startsWith("docker/")
    ) {
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
      full();
      continue;
    }

    // ponytail: unknown paths fail toward more validation; narrow only when repeated CI cost proves useful.
    full();
  }

  return { tests, package: packageCheck, container };
}

if (process.argv[2] === "--self-test") {
  assert.deepEqual(classify(["docs/guides/container-deployment.md"]), {
    tests: false,
    package: true,
    container: "none",
  });

  assert.deepEqual(classify(["extension/core.test.ts"]), {
    tests: true,
    package: false,
    container: "none",
  });

  assert.deepEqual(classify(["extension/index.ts"]), {
    tests: true,
    package: true,
    container: "smoke",
  });

  assert.deepEqual(classify(["compose.yaml"]), {
    tests: false,
    package: false,
    container: "config",
  });

  assert.deepEqual(classify([".github/workflows/release.yml"]), {
    tests: true,
    package: false,
    container: "none",
  });

  assert.deepEqual(classify(["docs/README.md", "extension/config.test.ts"]), {
    tests: true,
    package: true,
    container: "none",
  });

  assert.deepEqual(classify(["some-new-runtime-surface/file"]), {
    tests: true,
    package: true,
    container: "smoke",
  });

  process.exit(0);
}

const paths = readFileSync(0, "utf8").split("\0").filter(Boolean);

for (const [name, value] of Object.entries(classify(paths))) {
  console.log(`${name}=${value}`);
}
