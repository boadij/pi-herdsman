import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(".github/workflows/release.yml"),
  "utf8",
).replaceAll("\r\n", "\n");
const previewWorkflow = readFileSync(
  resolve(".github/workflows/preview.yml"),
  "utf8",
).replaceAll("\r\n", "\n");

test("release publication recovers with exact identity", () => {
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /googleapis\/release-please-action@v5/);
  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*tag:[\s\S]*required:\s*true/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(
    workflow,
    /- id: target\n\s+if: \$\{\{ !cancelled\(\) && steps\.source\.outcome == 'success' \}\}/,
  );

  const target = workflow.slice(
    workflow.indexOf("- id: target"),
    workflow.indexOf("- id: node"),
  );
  assert.match(target, /RELEASE_CREATED/);
  assert.match(target, /releases\/tags\/\$TAG/);
  assert.match(target, /HTTP 404/);
  assert.match(target, /published_at != null/);
  assert.match(target, /TAG_SHA.*GITHUB_SHA/);
  assert.match(target, /git checkout --detach "\$TAG_SHA"/);
  assert.match(target, /test "v\$VERSION" = "\$TAG"/);
  assert.match(target, /releases\/latest/);
  assert.match(target, /DIST_TAG=backfill/);
  assert.match(target, /DIST_TAG=latest/);
  assert.match(target, /docker_tags<<EOF/);

  assert.match(workflow, /VERSIONS=\$\(npm view "\$PACKAGE" versions --json\)/);
  assert.match(workflow, /npm run release:check -- --tag "\$DIST_TAG"/);
  assert.match(workflow, /npm publish --tag "\$DIST_TAG"/);
  assert.match(
    workflow,
    /- id: qemu\n\s+if: \$\{\{ !cancelled\(\) && steps\.target\.outputs\.publish == 'true' \}\}/,
  );
  assert.match(
    workflow,
    /- id: buildx\n\s+if: \$\{\{ !cancelled\(\) && steps\.qemu\.outcome == 'success' \}\}/,
  );
  assert.match(
    workflow,
    /- id: login\n\s+if: \$\{\{ !cancelled\(\) && steps\.buildx\.outcome == 'success' \}\}/,
  );
  assert.match(
    workflow,
    /- name: Publish container\n\s+if: \$\{\{ !cancelled\(\) && steps\.login\.outcome == 'success' \}\}/,
  );
  assert.match(
    workflow,
    /tags: \$\{\{ steps\.target\.outputs\.docker_tags \}\}/,
  );
  assert.doesNotMatch(workflow, /steps\.package\./);
});

test("PR preview publication isolates publish credentials from PR code", () => {
  assert.match(
    previewWorkflow,
    /workflow_dispatch:[\s\S]*pr:[\s\S]*required:\s*true/,
  );
  assert.match(previewWorkflow, /pull_request_target:\n\s+types: \[closed\]/);
  assert.match(previewWorkflow, /queue: max/);
  assert.match(
    previewWorkflow,
    /group: npm-preview-pr-\$\{\{ inputs\.pr \|\| github\.event\.pull_request\.number \}\}/,
  );

  assert.match(
    previewWorkflow,
    /\[ "\$STATE" = "open" \][\s\S]*\[ "\$HEAD_REPO" = "\$GITHUB_REPOSITORY" \]/,
  );

  assert.match(
    previewWorkflow,
    /ref:\s*\$\{\{\s*steps\.target\.outputs\.sha\s*\}\}/,
  );

  assert.match(previewWorkflow, /\[\[ "\$PR" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
  assert.match(
    previewWorkflow,
    /VERSION="0\.0\.0-pr\.\$PR\.g\$\{HEAD_SHA:0:12\}"/,
  );
  assert.match(previewWorkflow, /TAG="pr-\$PR"/);
  assert.match(
    previewWorkflow,
    /prepare:[\s\S]*outputs:\s*\n\s+sha:\s*\$\{\{\s*steps\.target\.outputs\.sha\s*\}\}\s*\n\s*steps:/,
  );

  assert.match(previewWorkflow, /npm run release:check -- --tag "pr-\$PR"/);
  assert.match(previewWorkflow, /npm pkg set previewSourceSha="\$HEAD_SHA"/);
  assert.match(previewWorkflow, /npm pack[\s\S]*--ignore-scripts/);

  const publishIndex = previewWorkflow.indexOf("\n  publish:\n");
  assert.notEqual(publishIndex, -1);

  const prepare = previewWorkflow.slice(0, publishIndex);
  const publish = previewWorkflow.slice(publishIndex);

  assert.doesNotMatch(prepare, /id-token:\s*write/);
  assert.match(publish, /id-token:\s*write/);
  assert.match(publish, /environment:\s*npm-preview/);

  assert.match(publish, /npm install -g npm@11\.21\.0/);
  assert.match(publish, /actions\/download-artifact@v8/);
  assert.match(publish, /TARBALLS=\(\.\/package\/\*\.tgz\)/);
  assert.match(publish, /VERSION="0\.0\.0-pr\.\$PR\.g\$\{SHA:0:12\}"/);
  assert.match(publish, /TAG="pr-\$PR"/);
  assert.match(publish, /STATE HEAD_REPO CURRENT_SHA/);
  assert.match(publish, /\[ "\$CURRENT_SHA" = "\$SHA" \]/);
  assert.match(publish, /npm view "\$PACKAGE" versions --json/);
  assert.match(publish, /npm view "\$PACKAGE@\$VERSION" previewSourceSha/);
  assert.match(
    publish,
    /if type == "array" then index\(\$v\) != null else \. == \$v end/,
  );
  assert.match(publish, /npm dist-tag add "\$PACKAGE@\$VERSION" "\$TAG"/);
  assert.doesNotMatch(publish, /needs\.prepare\.outputs\.(?:version|tag)/);
  const packageNameCheck = publish.search(
    /test "\$\(node -p "require\('\.\/manifest\/package\/package\.json'\)\.name"\)" = "\$PACKAGE"/,
  );
  const packageVersionCheck = publish.search(
    /test "\$\(node -p "require\('\.\/manifest\/package\/package\.json'\)\.version"\)" = "\$VERSION"/,
  );
  const tarballExtraction = publish.indexOf(
    'tar -xzf "${TARBALLS[0]}" -C manifest package/package.json',
  );
  const firstNpmView = publish.indexOf("npm view");
  const firstNpmPublish = publish.indexOf("npm publish");
  assert.notEqual(tarballExtraction, -1);
  assert.notEqual(packageNameCheck, -1);
  assert.notEqual(packageVersionCheck, -1);
  assert.notEqual(firstNpmView, -1);
  assert.notEqual(firstNpmPublish, -1);
  assert.ok(tarballExtraction < packageNameCheck);
  assert.ok(tarballExtraction < packageVersionCheck);
  assert.ok(packageNameCheck < firstNpmView);
  assert.ok(packageVersionCheck < firstNpmView);
  assert.ok(packageNameCheck < firstNpmPublish);
  assert.ok(packageVersionCheck < firstNpmPublish);
  assert.match(
    publish,
    /npm publish[\s\S]*--tag "\$TAG"[\s\S]*--ignore-scripts/,
  );
  assert.match(
    publish,
    /REGISTRY="https:\/\/registry\.npmjs\.org"[\s\S]*npm publish[\s\S]*--registry "\$REGISTRY"/,
  );

  const cleanup = previewWorkflow.slice(
    previewWorkflow.indexOf("\n  cleanup:\n"),
  );
  assert.match(cleanup, /github\.event_name == 'pull_request_target'/);
  assert.match(cleanup, /head\.repo\.full_name == github\.repository/);
  assert.match(cleanup, /environment: npm-preview/);
  assert.match(
    cleanup,
    /STATE=\$\(gh api[\s\S]*case "\$STATE" in[\s\S]*open\).*exit 0/,
  );
  assert.match(cleanup, /npm view "\$PACKAGE" dist-tags --json/);
  assert.match(cleanup, /"0\.0\.0-pr\.\$PR\."\*/);
  assert.match(cleanup, /npm dist-tag rm "\$PACKAGE" "\$TAG"/);
  assert.doesNotMatch(
    cleanup,
    /actions\/checkout|download-artifact|npm (?:ci|pack)/,
  );
});

test("an existing preview version cannot be retagged for a different full SHA", () => {
  const checkStart = previewWorkflow.indexOf(
    '            PUBLISHED_SHA=$(npm view "$PACKAGE@$VERSION" previewSourceSha',
  );
  const checkEnd = previewWorkflow.indexOf(
    '            npm dist-tag add "$PACKAGE@$VERSION" "$TAG"',
    checkStart,
  );
  assert.ok(checkStart >= 0 && checkEnd > checkStart);
  const identityGuard = previewWorkflow.slice(checkStart, checkEnd);

  const dir = mkdtempSync(resolve(tmpdir(), "preview-version-test-"));
  try {
    const npm = resolve(dir, "npm");
    const log = resolve(dir, "npm.log");
    writeFileSync(
      npm,
      '#!/bin/sh\nif [ "$1" = view ]; then printf "%s" "$PUBLISHED_SHA"; else echo "$*" >> "$NPM_LOG"; fi\n',
    );
    chmodSync(npm, 0o755);

    const run = (publishedSha: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail\n${identityGuard}npm dist-tag add "$PACKAGE@$VERSION" "$TAG"`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            NPM_LOG: log,
            PUBLISHED_SHA: publishedSha,
            PACKAGE: "pi-herdsman",
            VERSION: "0.0.0-pr.1.g123456789abc",
            SHA: "123456789abcdef0123456789abcdef01234567",
            TAG: "pr-1",
            REGISTRY: "https://registry.npmjs.org",
          },
          encoding: "utf8",
        },
      );

    const collision = run("123456789abcffff0123456789abcdef01234567");
    assert.notEqual(collision.status, 0);
    assert.equal(
      collision.stderr.includes("does not identify source commit"),
      true,
    );
    assert.equal(
      existsSync(log) && readFileSync(log, "utf8").includes("dist-tag add"),
      false,
    );

    const sameSource = run("123456789abcdef0123456789abcdef01234567");
    assert.equal(sameSource.status, 0, sameSource.stderr);
    assert.match(readFileSync(log, "utf8"), /dist-tag add/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish verifies the tarball's full source SHA before registry operations", () => {
  const publish = previewWorkflow.slice(
    previewWorkflow.indexOf("\n  publish:\n"),
  );
  const sourceShaCheck = publish.indexOf(
    'test "$(node -p "require(\'./manifest/package/package.json\').previewSourceSha")" = "$SHA"',
  );
  const npmInstall = publish.indexOf("npm install -g npm@11.21.0");
  const registryLookup = publish.indexOf('npm view "$PACKAGE" versions');
  const existingVersionLookup = publish.indexOf(
    'npm view "$PACKAGE@$VERSION" previewSourceSha',
  );
  const distTagAdd = publish.indexOf(
    'npm dist-tag add "$PACKAGE@$VERSION" "$TAG"',
  );
  const registryPublish = publish.indexOf('npm publish "${TARBALLS[0]}"');

  assert.notEqual(sourceShaCheck, -1);
  assert.notEqual(npmInstall, -1);
  assert.notEqual(registryLookup, -1);
  assert.notEqual(existingVersionLookup, -1);
  assert.notEqual(distTagAdd, -1);
  assert.notEqual(registryPublish, -1);
  assert.ok(sourceShaCheck < npmInstall);
  assert.ok(sourceShaCheck < registryLookup);
  assert.ok(sourceShaCheck < existingVersionLookup);
  assert.ok(sourceShaCheck < distTagAdd);
  assert.ok(sourceShaCheck < registryPublish);
});
