import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  assert.match(
    previewWorkflow,
    /\[ "\$STATE" = "open" \][\s\S]*\[ "\$HEAD_REPO" = "\$GITHUB_REPOSITORY" \]/,
  );

  assert.match(
    previewWorkflow,
    /ref:\s*\$\{\{\s*steps\.target\.outputs\.sha\s*\}\}/,
  );

  assert.match(previewWorkflow, /VERSION="0\.0\.0-pr\.\$PR\.g\$HEAD_SHA"/);
  assert.match(previewWorkflow, /TAG="pr-\$PR"/);
  assert.match(
    previewWorkflow,
    /prepare:[\s\S]*outputs:\s*\n\s+sha:\s*\$\{\{\s*steps\.target\.outputs\.sha\s*\}\}\s*\n\s*steps:/,
  );

  assert.match(previewWorkflow, /npm run release:check -- --tag "pr-\$PR"/);
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
  assert.match(publish, /VERSION="0\.0\.0-pr\.\$PR\.g\$SHA"/);
  assert.match(publish, /TAG="pr-\$PR"/);
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
});
