import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
const previewWorkflow = readFileSync(
  resolve(".github/workflows/preview.yml"),
  "utf8",
).replaceAll("\r\n", "\n");

test("release publication uses explicit release identity", () => {
  assert.match(
    workflow,
    /id:\s*release[\s\S]*if:\s*\$\{\{\s*github\.event_name\s*==\s*'push'\s*\}\}[\s\S]*googleapis\/release-please-action@v5/,
  );
  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*tag:[\s\S]*description:\s*Existing GitHub release tag to retry release publication[\s\S]*required:\s*true/,
  );
  assert.match(workflow, /steps\.release\.outputs\.release_created/);
  assert.match(workflow, /steps\.release\.outputs\.tag_name/);
  assert.match(
    workflow,
    /elif\s+\[\s*"\$RELEASE_CREATED"\s*=\s*"true"\s*\];\s*then[\s\S]*TAG="\$RELEASE_TAG"[\s\S]*else[\s\S]*publish=false/,
  );
  assert.match(
    workflow,
    /if:\s*\$\{\{\s*steps\.target\.outputs\.publish\s*==\s*'true'\s*\}\}[\s\S]*ref:\s*refs\/tags\/\$\{\{\s*steps\.target\.outputs\.tag\s*\}\}/,
  );
  assert.match(
    workflow,
    /- uses: actions\/setup-node@v6[\s\S]*if:\s*\$\{\{\s*steps\.target\.outputs\.publish\s*==\s*'true'\s*\}\}/,
  );
  assert.match(
    workflow,
    /- name: Publish released npm version[\s\S]*if:\s*\$\{\{\s*steps\.target\.outputs\.publish\s*==\s*'true'\s*\}\}/,
  );
  assert.match(workflow, /test "v\$VERSION" = "\$RELEASE_TAG"/);
  assert.match(workflow, /gh release view "\$RELEASE_TAG"/);
  assert.match(workflow, /npm run release:check/);
  assert.match(
    workflow,
    /npm run release:check[\s\S]*if npm view "\$PACKAGE@\$VERSION" version >\/dev\/null; then\s+echo "\$PACKAGE@\$VERSION is already published; skipping npm publish"\s+else\s+npm publish\s+fi[\s\S]*- name: Set up QEMU/,
  );
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

  assert.match(previewWorkflow, /npm run release:check/);
  assert.match(previewWorkflow, /npm pack[\s\S]*--ignore-scripts/);

  const publishIndex = previewWorkflow.indexOf("\n  publish:\n");
  assert.notEqual(publishIndex, -1);

  const prepare = previewWorkflow.slice(0, publishIndex);
  const publish = previewWorkflow.slice(publishIndex);

  assert.doesNotMatch(prepare, /id-token:\s*write/);
  assert.match(publish, /id-token:\s*write/);
  assert.match(publish, /environment:\s*npm-preview/);

  assert.match(publish, /actions\/download-artifact@v8/);
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
