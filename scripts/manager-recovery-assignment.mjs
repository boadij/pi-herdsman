import assert from "node:assert/strict";

export function assertManagerRecoveryAssignment(record) {
  const requiredKeys = [
    "branch",
    "id",
    "piSessionFile",
    "repoKey",
    "text",
    "version",
  ];
  const allowedKeys = [
    ...requiredKeys,
    "checkoutPath",
    "currentEvidenceIds",
    "requiredEvidence",
    "resultBindings",
  ];
  assert.ok(requiredKeys.every((key) => Object.hasOwn(record, key)));
  assert.ok(Object.keys(record).every((key) => allowedKeys.includes(key)));
}
