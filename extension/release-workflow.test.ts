import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");

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
