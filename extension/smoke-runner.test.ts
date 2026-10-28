import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  decide as decideSmokeFaux,
  managerHandoffSupervisorToolAvailable,
} from "../scripts/smoke-faux.mjs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  assistantResultForSession,
  assistantResponseCompletedForSession,
  acceptsFailedAgentHandoff,
  failedAgentHandoff,
  agentRetirementConverged,
  assertCoreToolEvidence,
  classifySmokeFailure,
  assertContinuationReadEvidence,
  bestEffortProcessDiagnostics,
  chiefTreeFooter,
  chiefTreeSelectedRow,
  chiefTreeBranchTransition,
  countChiefTreeEvents,
  candidateArgs,
  chiefTreeProbeSource,
  candidateStartObservationError,
  distinctPaneCount,
  parseToolSnapshots,
  chiefTreeBranchPlan,
  managerRecoveryFreshPrompt,
  managerRecoveryLeadContextPrompt,
  managerProjectMessageSettled,
  managerRecoveryPostRecoveryPrompt,
  managerRecoveryStopPrompt,
  managerRecoveryResumeOnlyPrompt,
  managerRecoveryResumeDiagnostics,
  managerRecoveryResumePrompt,
  managerRecoveryRetiredResumePrompt,
  managerRecoveryReviewPrompt,
  continuationResultsForPrompt,
  continuationSessionEvidence,
  activeStopContinuationEvidence,
  correlatedContinuationTask,
  managerChildSessionEvidence,
  initialPromptForScenario,
  inspectPaneProcesses,
  isolatedEnv,
  isPackageReadPath,
  listedPanes,
  nestedControlEnv,
  parentControlEnv,
  rootCandidateCommand,
  nestedHerdrApiSocketPath,
  nestedPaneInput,
  nestedPaneText,
  submitPaneCommand,
  waitForEvidence,
  parseHerdrOutput,
  parseSmokeArgs,
  formatSmokeFailure,
  managerBootstrapDelegationProjection,
  managerBootstrapDelegationState,
  herdrErrorCode,
  managerDiagnosticLines,
  captureManagerLeadDiagnostics,
  savedSessionHeaderEvidence,
  staffDelegateResults,
  assertNoFailedProjectDelegation,
  assertNoFailedManagerHandoff,
  managerAssignmentDiagnostics,
  managerHandoffSupervisorToolAvailability,
  supervisorMessageDiagnostics,
  supervisorMessageCallStatus,
  managerAssignmentIdentity,
  managerAssignmentBranchMismatch,
  staffActionResults,
  projectMessageEntries,
  retirementNoticeEntries,
  assertPassiveRetirementEvidence,
  retainedProjectMessageRecord,
  managerHandoffRetainedRecord,
  managerHandoffDeliveredEntry,
  managerHandoffCanReenter,
  managerHandoffLeadPidContinues,
  managerHandoffAssignmentReady,
  managerCleanupTarget,
  removeManagerRecoveryWorktree,
  collectDiagnostics,
  rootDelegationDiagnostics,
  assertNoFailedAgentDelegation,
  bestEffortDiagnostics,
  captureTerminalFailureAssignment,
  captureManagerHandoffWorktree,
  coreAgentDefinitionsExpectations,
  coreObservationReady,
  captureTerminalFailureWorktree,
  terminalFailureAssignmentPoll,
  terminalFailureEvidence,
  matchPiProvenance,
  managerHandoffLeadProcessProof,
  prepareManagerRepository,
  assertManagerFreshPrimary,
  deleteBranchIfPresent,
  hasSuccessfulSupervisorMessage,
  leadReadyCompleted,
  verifiedLeadSession,
  managerReadyAnswer,
  managerReadyEntryEvidence,
  exactIsolatedSession,
  agentsForPiSession,
  isolatedSessionDetails,
  preparePi,
  prepareContinuationFaux,
  requireTestedBaseline,
  requireNestedHerdrServer,
  resolveSmokeModel,
  selectSmokeModel,
  runScenario,
  sanitizedFailureEvidence,
  preserveFailureEvidence,
  retainScenarioFailureEvidence,
  updateFailureEvidenceAfterCleanup,
  reportFinalFailureEvidence,
  reportFailureEvidenceWriteError,
  descendantCleanupStatus,
  verifyParentShutdown,
  startParent,
  createParentWorkspace,
  cleanup,
  requireSmokeEvidence,
  verifyCoreProvenanceEvidence,
} from "../scripts/smoke.mjs";

test("manager bootstrap failure projection distinguishes delegation boundaries safely", () => {
  const cases = [
    [
      "no call",
      {
        delegateCalls: 0,
        expectedBranchDelegateCalls: 0,
        resultState: "absent",
      },
      "absent",
    ],
    [
      "call error",
      {
        delegateCalls: 1,
        expectedBranchDelegateCalls: 1,
        resultState: "error",
      },
      "error",
    ],
    [
      "missing child",
      {
        delegateCalls: 1,
        expectedBranchDelegateCalls: 1,
        resultState: "success",
      },
      "success",
    ],
    [
      "missing worktree",
      {
        expectedBranchDelegateCalls: 1,
        delegateCalls: 1,
        resultState: "success",
        correlatedChild: true,
        childSessionSaved: true,
      },
      "success",
    ],
  ];
  for (const [name, input, resultState] of cases) {
    const result = managerBootstrapDelegationProjection(input);
    assert.equal(result.resultState, resultState, name);
    assert.equal(
      result.expectedBranchDelegateCalls,
      input.expectedBranchDelegateCalls,
      name,
    );
    assert.equal(
      result.linkedWorktreeObserved,
      input.linkedWorktreeObserved === true,
      name,
    );
    assert.deepEqual(Object.keys(result).sort(), [
      "childSessionSaved",
      "correlatedChild",
      "delegateCalls",
      "expectedBranchDelegateCalls",
      "linkedWorktreeObserved",
      "resultState",
    ]);
  }
});

test("manager bootstrap wrong-branch success remains absent in diagnostics", () => {
  const contents = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "wrong-branch-call",
            name: "delegate_work",
            arguments: { branch: "smoke/wrong" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_work",
        toolCallId: "wrong-branch-call",
        content: JSON.stringify({
          ok: true,
          action: "delegate",
          branch: "smoke/wrong",
          session: "child",
        }),
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  const state = managerBootstrapDelegationState(contents, "smoke/expected");
  assert.deepEqual(state, {
    delegateCalls: 1,
    expectedBranchDelegateCalls: 0,
    resultState: "absent",
  });
});

test("manager bootstrap timeout omits raw session evidence", () => {
  const output = formatSmokeFailure({
    name: "Error",
    message: "timed out",
    code: "SMOKE_TIMEOUT",
    smoke: {
      stage: "manager-bootstrap-correlated-child",
      lastProgress: { expectedBranchDelegateCalls: 1, resultState: "success" },
      lastEvidence: "PRIVATE SESSION CONTENT",
      lastObservationError: "PRIVATE ERROR",
    },
  });
  assert.match(output, /resultState.*success/);
  assert.doesNotMatch(output, /PRIVATE/);
});

test("manager bootstrap run reference resolves to its exact retained artifact", async () => {
  const evidence = { scenario: "manager-bootstrap", safe: true };
  const artifact = await preserveFailureEvidence(evidence);
  const reference = `${evidence.runReference}/result.json`;
  assert.match(reference, /^pi-herdsman-smoke-evidence-[^/]+\/result\.json$/);
  assert.equal(isAbsolute(reference), false);
  const ownedDirectory = join(tmpdir(), evidence.runReference);
  const [directoryInfo, realDirectory, artifactPath, retained] =
    await Promise.all([
      stat(ownedDirectory),
      realpath(ownedDirectory),
      realpath(artifact),
      readFile(join(tmpdir(), reference), "utf8"),
    ]);
  assert.ok(directoryInfo.isDirectory());
  assert.equal(artifactPath, join(realDirectory, "result.json"));
  assert.deepEqual(JSON.parse(retained), evidence);
  assert.equal(reference.includes(tmpdir()), false);
  await rm(ownedDirectory, { recursive: true });
});

test("scenario failure reporting uses an exact relative run reference", async () => {
  const evidence = { scenario: "test", outcome: "FAIL" };
  const ctx = {};
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  let artifact;
  try {
    artifact = await retainScenarioFailureEvidence(ctx, evidence);
  } finally {
    console.error = originalError;
  }
  const expected = `${basename(dirname(artifact))}/result.json`;
  try {
    assert.equal(ctx.failureArtifact, artifact);
    assert.deepEqual(errors, [
      `failure evidence reference: ${expected} (under system temp directory)`,
    ]);
    assert.equal(isAbsolute(errors[0]), false);
    assert.equal(errors[0].includes(tmpdir()), false);
    assert.equal(
      await readFile(join(dirname(artifact), "result.json"), "utf8"),
      `${JSON.stringify({ ...evidence, runReference: basename(dirname(artifact)) }, null, 2)}\n`,
    );
  } finally {
    await rm(dirname(artifact), { recursive: true, force: true });
  }
});

test("consumer receives only the finalized failure artifact through process output", async () => {
  const evidence = {
    scenario: "manager-bootstrap",
    outcome: "EVIDENCE_FAIL",
    mode: "simulated",
    errorCode: "SMOKE_TIMEOUT",
    stage: "manager-bootstrap-correlated-child",
    managerBootstrapDelegation: {
      delegateCalls: 3,
      expectedBranchDelegateCalls: 2,
      resultState: "success",
      correlatedChild: true,
      childSessionSaved: true,
      linkedWorktreeObserved: true,
      session: "SENSITIVE_SESSION_SENTINEL",
      path: "/SENSITIVE_PATH_SENTINEL",
    },
    sessionStartObserved: true,
    firstRequestObserved: false,
    firstRequestVerified: false,
    cleanup: "PENDING",
    parentOwnership: {
      session: "SENSITIVE_SESSION_SENTINEL",
      workspaceId: "SENSITIVE_WORKSPACE_SENTINEL",
      childPid: "SENSITIVE_PID_SENTINEL",
      childExitObserved: true,
    },
    managerBootstrapFailureDiagnostics: "SENSITIVE_DIAGNOSTIC_SENTINEL",
    diagnostics: { message: "SENSITIVE_MESSAGE_SENTINEL" },
    toolOutput: "SENSITIVE_TOOL_OUTPUT_SENTINEL",
    prompt: "SENSITIVE_PROMPT_SENTINEL",
    env: { SECRET_SENTINEL: "SENSITIVE_SECRET_SENTINEL" },
  };
  const artifact = await preserveFailureEvidence(evidence);
  const output = [];
  try {
    assert.equal(
      await reportFinalFailureEvidence(artifact, (line) => output.push(line)),
      false,
    );
    assert.deepEqual(output, []);

    evidence.cleanup = "PASS";
    await preserveFailureEvidence(evidence, artifact);
    assert.equal(
      await reportFinalFailureEvidence(artifact, (line) => output.push(line)),
      true,
    );

    const prefix = "SMOKE_FAILURE_ARTIFACT_JSON ";
    assert.equal(output.length, 1);
    assert.ok(output[0].startsWith(prefix));
    const consumed = JSON.parse(output[0].slice(prefix.length));
    assert.equal(consumed.runReference, basename(dirname(artifact)));
    assert.equal(
      consumed.artifactReference,
      `${consumed.runReference}/result.json`,
    );
    assert.equal(consumed.scenario, "manager-bootstrap");
    assert.equal(consumed.outcome, "EVIDENCE_FAIL");
    assert.equal(consumed.cleanup, "PASS");
    assert.equal(consumed.errorCode, "SMOKE_TIMEOUT");
    assert.equal(consumed.failureStage, "manager-bootstrap-correlated-child");
    assert.deepEqual(consumed.managerBootstrapDelegation, {
      delegateCalls: 3,
      expectedBranchDelegateCalls: 2,
      resultState: "success",
      correlatedChild: true,
      childSessionSaved: true,
      linkedWorktreeObserved: true,
    });
    assert.equal(consumed.sessionStartObserved, true);
    assert.equal(consumed.firstRequestObserved, false);
    assert.equal(consumed.firstRequestVerified, false);
    assert.deepEqual(
      Object.keys(consumed).sort(),
      [
        "artifactReference",
        "cleanup",
        "errorCode",
        "failureStage",
        "firstRequestObserved",
        "firstRequestVerified",
        "mode",
        "outcome",
        "runReference",
        "scenario",
        "sessionStartObserved",
        "managerBootstrapDelegation",
      ].sort(),
    );
    assert.doesNotMatch(output[0], /SENSITIVE_|SECRET_SENTINEL|\/tmp\//);
  } finally {
    await rm(dirname(artifact), { recursive: true, force: true });
  }
});

test("evidence write failure reporting omits raw filesystem paths", () => {
  const sentinel = "/private/fixture/smoke/result.json";
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    reportFailureEvidenceWriteError(
      Object.assign(
        new Error(`EACCES: permission denied, open '${sentinel}'`),
        {
          code: "EACCES",
        },
      ),
    );
    reportFailureEvidenceWriteError(
      Object.assign(new Error(`EIO writing '${sentinel}'`), { code: "EIO" }),
      "update",
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, [
    "failure evidence: could not save (filesystem error EACCES)",
    "failure evidence: could not update cleanup result (filesystem error EIO)",
  ]);
  assert.match(errors[0], /filesystem error EACCES/);
  assert.match(errors[1], /filesystem error EIO/);
  assert.doesNotMatch(errors.join("\n"), /private\/fixture|result\.json/);
});

test("scenario failure evidence save catch reports code without its path", async () => {
  const sentinel = "/private/fixture/smoke/result.json";
  const ctx = {};
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  let result;
  try {
    result = await retainScenarioFailureEvidence(
      ctx,
      { scenario: "test", outcome: "FAIL" },
      async () => {
        throw Object.assign(
          new Error(`EACCES: permission denied, open '${sentinel}'`),
          { code: "EACCES" },
        );
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(result, null);
  assert.equal(ctx.evidenceSaveFailed, true);
  assert.deepEqual(errors, [
    "failure evidence: could not save (filesystem error EACCES)",
  ]);
  assert.doesNotMatch(
    errors.join("\n"),
    /private\/fixture|result\.json|EACCES: permission denied/,
  );
});

test("cleanup evidence retry records and reports a recovered artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-cleanup-retry-"));
  const artifact = join(root, "result.json");
  const ctx = {};
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    await updateFailureEvidenceAfterCleanup(
      ctx,
      { scenario: "test", cleanup: "PASS" },
      async (evidence) => {
        await writeFile(artifact, JSON.stringify(evidence));
        return artifact;
      },
    );
  } finally {
    console.error = originalError;
  }
  try {
    assert.equal(ctx.failureArtifact, artifact);
    assert.equal(ctx.evidenceSaveFailed, undefined);
    assert.deepEqual(errors, [
      `failure evidence reference: ${basename(root)}/result.json (under system temp directory)`,
    ]);
    assert.deepEqual(JSON.parse(await readFile(artifact, "utf8")), {
      scenario: "test",
      cleanup: "PASS",
    });
    assert.equal(isAbsolute(errors[0]), false);
    assert.equal(errors[0].includes(tmpdir()), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup retry artifact is delivered after its initial save failed", async () => {
  const ctx = {};
  const evidence = {
    scenario: "manager-bootstrap",
    outcome: "SCENARIO_FAIL",
    cleanup: "PASS",
  };
  const output = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      await retainScenarioFailureEvidence(ctx, evidence, async () => {
        throw Object.assign(new Error("private failure path"), {
          code: "EACCES",
        });
      }),
      null,
    );
    assert.equal(ctx.evidenceSaveFailed, true);
    await updateFailureEvidenceAfterCleanup(ctx, evidence);
    assert.ok(ctx.failureArtifact);
    assert.equal(
      await reportFinalFailureEvidence(ctx.failureArtifact, (line) =>
        output.push(line),
      ),
      true,
    );
    assert.equal(output.length, 1);
    const payload = JSON.parse(
      output[0].replace("SMOKE_FAILURE_ARTIFACT_JSON ", ""),
    );
    assert.equal(payload.outcome, "SCENARIO_FAIL");
    assert.equal(payload.cleanup, "PASS");
  } finally {
    console.error = originalError;
    if (ctx.failureArtifact)
      await rm(dirname(ctx.failureArtifact), { recursive: true, force: true });
  }
});

test("cleanup evidence retry failure reports sanitized error without undefined reference", async () => {
  const sentinel = "/private/fixture/smoke/result.json";
  const ctx = {};
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    await assert.doesNotReject(
      updateFailureEvidenceAfterCleanup(
        ctx,
        { scenario: "test", cleanup: "PASS" },
        async () => {
          throw Object.assign(
            new Error(`EACCES: permission denied, open '${sentinel}'`),
            { code: "EACCES" },
          );
        },
      ),
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.failureArtifact, undefined);
  assert.equal(ctx.evidenceSaveFailed, true);
  assert.deepEqual(errors, [
    "failure evidence: could not update cleanup result (filesystem error EACCES)",
  ]);
  assert.doesNotMatch(
    errors.join("\n"),
    /undefined|private\/fixture|result\.json|permission denied/,
  );
});
import installFaux, { decide } from "../scripts/smoke-faux.mjs";

test("package read identity accepts equivalent paths and rejects other files", () => {
  const cwd = "/workspace/project";
  assert.equal(isPackageReadPath("package.json", cwd), true);
  assert.equal(isPackageReadPath("./package.json", cwd), true);
  assert.equal(isPackageReadPath(`${cwd}/package.json`, cwd), true);
  assert.equal(isPackageReadPath("other.json", cwd), false);
  assert.equal(isPackageReadPath(`${cwd}/other.json`, cwd), false);
  assert.equal(isPackageReadPath("package.json", undefined), false);
});

test("parent Herdr environment retains nesting context and clears caller routing", () => {
  const base = {
    HERDR_ENV: "1",
    HERDR_SESSION: "unrelated-session",
    HERDR_WORKSPACE_ID: "w2",
    HERDR_TAB_ID: "t2",
    HERDR_PANE_ID: "p2",
    HERDR_SOCKET_PATH: "/wrong/server.sock",
    HERDR_CLIENT_SOCKET_PATH: "/wrong/client.sock",
    HERDR_STARTUP_CWD: "/wrong/cwd",
    HERDR_MACOS_SERVER_CONTEXT: "wrong-context",
    PI_HERDSMAN_RUN_ID: "wrong-agent",
    PI_HERDSMAN_MAILBOX: "wrong-mailbox",
    PI_HERDSMAN_OWNER_SESSION_ID: "wrong-owner",
    PI_HERDSMAN_OWNER_DISPLAY: "wrong-display",
    PI_HERDSMAN_LABEL: "wrong-label",
    PI_HERDSMAN_WORKSPACE_ID: "wrong-agent-workspace",
    PI_HERDSMAN_AGENT_DEFINITION: "wrong-definition",
    PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS: "wrong-allowlist",
    PI_SUBAGENT_PARENT_SESSION: "wrong-parent",
    PI_SUBAGENT_CHILD: "wrong-child",
    XDG_CONFIG_HOME: "/tmp/smoke-parent",
  };
  const paths = {
    herdrConfig: "/tmp/isolated/herdr.toml",
    xdgConfig: "/tmp/isolated/config",
    xdgState: "/tmp/isolated/state",
    piAgent: "/tmp/isolated/pi-agent",
    piSessions: "/tmp/isolated/pi-sessions",
  };
  const env = parentControlEnv(base, paths, "phs-owned");
  assert.equal(env.HERDR_SESSION, "phs-owned");
  assert.equal(env.HERDR_WORKSPACE_ID, undefined);
  assert.equal(env.HERDR_TAB_ID, undefined);
  assert.equal(env.HERDR_PANE_ID, undefined);
  assert.equal(env.HERDR_ENV, "1");
  assert.equal(env.HERDR_STARTUP_CWD, undefined);
  assert.equal(env.HERDR_MACOS_SERVER_CONTEXT, undefined);
  assert.equal(env.HERDR_SOCKET_PATH, undefined);
  assert.equal(env.PI_HERDSMAN_RUN_ID, undefined);
  assert.equal(env.PI_HERDSMAN_MAILBOX, undefined);
  assert.equal(env.PI_HERDSMAN_OWNER_SESSION_ID, undefined);
  assert.equal(env.PI_HERDSMAN_OWNER_DISPLAY, undefined);
  assert.equal(env.PI_HERDSMAN_LABEL, undefined);
  assert.equal(env.PI_HERDSMAN_WORKSPACE_ID, undefined);
  assert.equal(env.PI_HERDSMAN_AGENT_DEFINITION, undefined);
  assert.equal(env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS, undefined);
  assert.equal(env.PI_SUBAGENT_PARENT_SESSION, undefined);
  assert.equal(env.PI_SUBAGENT_CHILD, undefined);
  assert.equal(env.HERDR_CONFIG_PATH, paths.herdrConfig);
  assert.equal(env.XDG_CONFIG_HOME, paths.xdgConfig);
  assert.equal(base.HERDR_SOCKET_PATH, "/wrong/server.sock");
});

test("root delegation diagnostics correlate results and exclude private data", () => {
  const call = {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        name: "delegate_agent",
        id: "PRIVATE_ID",
        arguments: { task: "PRIVATE_TOKEN" },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolName: "delegate_agent",
    toolCallId: "PRIVATE_ID",
    isError: false,
    details: { ok: true },
    content: "PRIVATE_PATH",
  };
  const project = (messages) =>
    rootDelegationDiagnostics(
      messages
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n"),
    );
  for (const [messages, expected] of [
    [[], "absent"],
    [[call], "pending"],
    [[call, { ...result, toolCallId: "unrelated" }], "pending"],
    [[result, call], "pending"],
    [[call, result], "success"],
    [[call, { ...result, isError: true }], "error"],
    [
      [
        call,
        {
          ...result,
          details: {
            ok: false,
            error: { category: "agent_busy", message: "PRIVATE_ERROR" },
          },
        },
      ],
      "error",
    ],
    [[call, { ...result, isError: undefined }], "unknown"],
    [[call, result, call], "pending"],
  ]) {
    const projected = project(messages);
    assert.equal(projected.matchingResult, expected);
    assert.equal(projected.delegationCallObserved, expected !== "absent");
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|unrelated/u);
  }
  assert.deepEqual(
    project([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "PRIVATE_ERROR",
        content: "PRIVATE_TEXT",
      },
    ]),
    {
      delegationCallObserved: false,
      matchingResult: "absent",
      assistantObserved: true,
      assistantStopReason: "error",
      assistantErrorObserved: true,
    },
  );
  assert.equal(
    project([{ role: "assistant", stopReason: "PRIVATE_REASON" }])
      .assistantStopReason,
    "unknown",
  );
  const failed = [
    call,
    {
      ...result,
      details: {
        ok: false,
        error: { category: "agent_busy", message: "PRIVATE_ERROR" },
      },
    },
  ]
    .map((message) => JSON.stringify({ type: "message", message }))
    .join("\n");
  assert.throws(
    () => assertNoFailedAgentDelegation(failed),
    (error) =>
      error.code === "SMOKE_DELEGATION_FAILED" &&
      error.message === "delegate_agent failed (agent_busy)" &&
      !error.message.includes("PRIVATE"),
  );
  assert.doesNotThrow(() =>
    assertNoFailedAgentDelegation(
      [call]
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n"),
    ),
  );
  assert.doesNotThrow(() =>
    assertNoFailedAgentDelegation(
      [call, result]
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n"),
    ),
  );
});

test("continuation failure diagnostics retain sanitized root delegation state", async () => {
  const projection = await collectDiagnostics(
    {
      scenario: "continuation",
      stage: "continuation-first-generation",
      paths: {},
      sessionName: "isolated",
      rootPaneId: "root",
    },
    { hostPaneId: "host" },
    null,
    {
      execute: async () => ({ stdout: "PRIVATE_PANE" }),
      observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
      snapshot: async () => ({
        path: "PRIVATE_PATH",
        status: "saved",
        contents: JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "PRIVATE_ERROR",
          },
        }),
      }),
    },
  );
  assert.deepEqual(projection.rootDelegation, {
    delegationCallObserved: false,
    matchingResult: "absent",
    assistantObserved: true,
    assistantStopReason: "error",
    assistantErrorObserved: true,
  });
  const evidence = sanitizedFailureEvidence(
    {
      scenario: "continuation",
      simulated: true,
      stage: "continuation-first-generation",
    },
    { error: new Error("PRIVATE_ERROR") },
    "STALLED",
    "PASS",
    {
      ...projection,
      path: "PRIVATE_PATH",
      rootSession: { summary: "PRIVATE_TRANSCRIPT" },
      rootDelegation: {
        ...projection.rootDelegation,
        task: "PRIVATE_TASK",
        message: "PRIVATE_MESSAGE",
      },
    },
  );
  assert.equal(evidence.diagnostics.rootDelegation.matchingResult, "absent");
  const artifact = await preserveFailureEvidence(evidence);
  try {
    const saved = JSON.parse(await readFile(artifact, "utf8"));
    assert.equal(saved.diagnostics.rootDelegation.matchingResult, "absent");
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/u);
  } finally {
    await rm(dirname(artifact), { recursive: true, force: true });
  }
});

test("core failure diagnostics correlate accepted delegation without exposing identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-core-diagnostics-"));
  const piSessions = join(root, "sessions");
  const piAgent = join(root, "agent");
  await Promise.all([mkdir(piSessions), mkdir(piAgent)]);
  await mkdir(join(piAgent, "pi-herdsman", "runtime", "mailboxes-v5"), {
    recursive: true,
  });
  const entries = [
    { type: "session", id: "private-owner-session" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "delegate_agent",
            id: "private-call-id",
            arguments: {
              label: "smoke-core-implementer",
              task: "PRIVATE_TASK",
            },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_agent",
        toolCallId: "private-call-id",
        isError: false,
        content:
          "Session: private-child-session\nRequest: 00000000-0000-4000-8000-000000000001",
      },
    },
  ];
  try {
    for (const [receipt, expectedDelivery] of [
      [null, "not_observed"],
      [
        {
          type: "custom_message",
          customType: "pi-herdsman-agent-result",
          details: {
            requestId: "00000000-0000-4000-8000-000000000001",
            piSessionId: "private-child-session",
            ownerSessionId: "private-owner-session",
          },
          content: "PRIVATE_RESULT",
        },
        "observed",
      ],
      [
        {
          type: "custom_message",
          customType: "pi-herdsman-agent-result",
          details: {
            requestId: "foreign-request-id",
            piSessionId: "private-child-session",
            ownerSessionId: "private-owner-session",
          },
          content: "PRIVATE_RESULT",
        },
        "not_observed",
      ],
    ]) {
      const projection = await collectDiagnostics(
        {
          scenario: "core",
          stage: "core-delegation",
          paths: { piSessions, piAgent },
          sessionName: "isolated",
          rootPaneId: "root",
        },
        { hostPaneId: "host" },
        null,
        {
          execute: async () => ({ stdout: "" }),
          observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
          snapshot: async () => ({
            path: "private-path",
            status: "saved",
            contents: [
              ...entries.map((entry) => JSON.stringify(entry)),
              ...(receipt ? [JSON.stringify(receipt)] : []),
            ].join("\n"),
          }),
        },
      );
      assert.deepEqual(projection.coreDelegation, {
        rootToImplementer: {
          delegation: "accepted",
          session: "not_observed",
          terminalResult:
            expectedDelivery === "observed" ? "delivered" : "not_observed",
          terminalStatus: "unknown",
          resultDelivered: expectedDelivery,
        },
        implementerToScout: {
          delegation: "unknown",
          session: "unknown",
          terminalResult: "unknown",
          terminalStatus: "unknown",
          resultDelivered: "unknown",
        },
        rootCompletionMarker: false,
        firstUnverifiedBoundary:
          expectedDelivery === "observed"
            ? "root_completion"
            : "implementer_session",
      });
      assert.doesNotMatch(JSON.stringify(projection), /private|PRIVATE/u);
      const failureEvidence = sanitizedFailureEvidence(
        { scenario: "core", simulated: true },
        { error: new Error("PRIVATE_ERROR") },
        "STALLED",
        "PASS",
        {
          ...projection,
          private: "PRIVATE_PATH",
          rootSession: {
            path: "PRIVATE_SESSION_PATH",
            summary: "PRIVATE_TRANSCRIPT_SUMMARY",
          },
          panes: { output: "PRIVATE_PANE_OUTPUT" },
          mailbox: "PRIVATE_MAILBOX_CONTENT",
          coreDelegation: {
            ...projection.coreDelegation,
            private: "PRIVATE_TASK",
          },
        },
      );
      assert.deepEqual(
        failureEvidence.coreDelegation,
        projection.coreDelegation,
      );
      assert.deepEqual(
        failureEvidence.diagnostics.coreDelegation,
        projection.coreDelegation,
      );
      const artifact = await preserveFailureEvidence(failureEvidence);
      try {
        const saved = await readFile(artifact, "utf8");
        assert.deepEqual(
          JSON.parse(saved).coreDelegation,
          projection.coreDelegation,
        );
        assert.doesNotMatch(saved, /private|PRIVATE/u);
      } finally {
        await rm(dirname(artifact), { recursive: true, force: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core failure diagnostics distinguish nested result publication from delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-core-nested-diagnostics-"));
  const piSessions = join(root, "sessions");
  const mailboxRoot = join(
    root,
    "agent",
    "pi-herdsman",
    "runtime",
    "mailboxes-v5",
  );
  const piAgent = join(root, "agent");
  await Promise.all([
    mkdir(piSessions),
    mkdir(mailboxRoot, { recursive: true }),
  ]);
  const requestId = "00000000-0000-4000-8000-000000000002";
  const intermediateRequestId = "00000000-0000-4000-8000-000000000003";
  const entries = (owner, label, child, request) => [
    { type: "session", id: owner },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "delegate_agent",
            id: `call-${label}`,
            arguments: { label, task: "PRIVATE_TASK" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_agent",
        toolCallId: `call-${label}`,
        isError: false,
        content: `Session: ${child}\nRequest: ${request}`,
      },
    },
  ];
  try {
    const rootEntries = entries(
      "private-root",
      "smoke-core-implementer",
      "private-implementer",
      intermediateRequestId,
    );
    const implementerEntries = entries(
      "private-implementer",
      "smoke-core-scout",
      "private-scout",
      requestId,
    );
    const scoutEntries = [{ type: "session", id: "private-scout" }];
    await Promise.all([
      writeFile(
        join(piSessions, "scout.jsonl"),
        scoutEntries.map((entry) => JSON.stringify(entry)).join("\n"),
      ),
    ]);
    const mailbox = join(mailboxRoot, "a".repeat(32));
    await mkdir(mailbox);
    await writeFile(
      join(mailbox, "state.json"),
      JSON.stringify({
        piSessionId: "private-scout",
        ownerSessionId: "private-implementer",
        agentLabel: "smoke-core-scout",
        runId: "private-run-id",
        workspaceId: "private-workspace-id",
        paneId: "private-pane-id",
        agentDefinition: "scout",
        completedRequestId: requestId,
      }),
    );
    await writeFile(
      join(mailbox, `result-${requestId}.json`),
      JSON.stringify({
        requestId,
        runId: "private-run-id",
        ownerSessionId: "private-implementer",
        workspaceId: "private-workspace-id",
        agentLabel: "smoke-core-scout",
        paneId: "private-pane-id",
        status: "completed",
      }),
    );
    for (const [receipt, expectedReceipt] of [
      [null, "not_observed"],
      [
        {
          type: "custom_message",
          customType: "pi-herdsman-agent-result",
          details: {
            requestId,
            piSessionId: "private-scout",
            ownerSessionId: "private-implementer",
            runId: "private-run-id",
            workspaceId: "private-workspace-id",
            agentLabel: "smoke-core-scout",
            paneId: "private-pane-id",
            agentDefinition: "scout",
          },
          content: "PRIVATE_RESULT",
        },
        "observed",
      ],
      [
        {
          type: "custom_message",
          customType: "pi-herdsman-agent-result",
          details: {
            requestId: "00000000-0000-4000-8000-000000000004",
            piSessionId: "private-scout",
            ownerSessionId: "private-implementer",
            runId: "private-run-id",
            workspaceId: "private-workspace-id",
            agentLabel: "smoke-core-scout",
            paneId: "private-pane-id",
            agentDefinition: "scout",
          },
          content: "PRIVATE_RESULT",
        },
        "not_observed",
      ],
      [
        {
          type: "custom_message",
          customType: "pi-herdsman-agent-result",
          details: {
            requestId,
            piSessionId: "foreign-session",
            ownerSessionId: "private-implementer",
            runId: "private-run-id",
            workspaceId: "private-workspace-id",
            agentLabel: "smoke-core-scout",
            paneId: "private-pane-id",
            agentDefinition: "scout",
          },
          content: "PRIVATE_RESULT",
        },
        "not_observed",
      ],
    ]) {
      await writeFile(
        join(piSessions, "implementer.jsonl"),
        [...implementerEntries, ...(receipt ? [receipt] : [])]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      const projection = await collectDiagnostics(
        {
          scenario: "core",
          stage: "core-delegation",
          paths: { piSessions, piAgent: join(root, "agent") },
          sessionName: "isolated",
          rootPaneId: "root",
        },
        { hostPaneId: "host" },
        null,
        {
          execute: async () => ({ stdout: "" }),
          observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
          snapshot: async () => ({
            path: "private-root-path",
            status: "saved",
            contents: rootEntries
              .map((entry) => JSON.stringify(entry))
              .join("\n"),
          }),
        },
      );
      assert.deepEqual(projection.coreDelegation.implementerToScout, {
        delegation: "accepted",
        session: "observed",
        terminalResult:
          expectedReceipt === "observed" ? "delivered" : "published",
        terminalStatus: "completed",
        resultDelivered: expectedReceipt,
      });
      assert.equal(
        projection.coreDelegation.firstUnverifiedBoundary,
        expectedReceipt === "observed"
          ? "implementer_result_delivery"
          : "scout_result_delivery",
      );
      assert.doesNotMatch(
        JSON.stringify(projection),
        /PRIVATE_TASK|PRIVATE_RESULT/u,
      );
    }

    await rm(join(mailbox, `result-${requestId}.json`));
    const failedReceipt = {
      type: "custom_message",
      customType: "pi-herdsman-agent-result",
      details: {
        requestId,
        piSessionId: "private-scout",
        ownerSessionId: "private-implementer",
        runId: "private-run-id",
        workspaceId: "private-workspace-id",
        agentLabel: "smoke-core-scout",
        paneId: "private-pane-id",
        agentDefinition: "scout",
        status: "failed",
        error: "PRIVATE_ERROR",
      },
      content: "PRIVATE_RESULT",
    };
    await writeFile(
      join(piSessions, "implementer.jsonl"),
      [...implementerEntries, failedReceipt]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const projection = await collectDiagnostics(
      {
        scenario: "core",
        stage: "core-delegation",
        paths: { piSessions, piAgent: join(root, "agent") },
        sessionName: "isolated",
        rootPaneId: "root",
      },
      { hostPaneId: "host" },
      null,
      {
        execute: async () => ({ stdout: "" }),
        observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
        snapshot: async () => ({
          path: "PRIVATE_PATH",
          status: "saved",
          contents: rootEntries
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
        }),
      },
    );
    const evidence = sanitizedFailureEvidence(
      { scenario: "core", simulated: true, stage: "core-delegation" },
      { error: new Error("PRIVATE_ERROR") },
      "STALLED",
      "PASS",
      { ...projection, task: "PRIVATE_TASK" },
    );
    const artifact = await preserveFailureEvidence(evidence);
    try {
      const saved = JSON.parse(await readFile(artifact, "utf8"));
      assert.equal(
        saved.diagnostics.coreDelegation.implementerToScout.terminalStatus,
        "failed",
      );
      assert.equal(
        saved.diagnostics.coreDelegation.implementerToScout.resultDelivered,
        "observed",
      );
      assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/u);
    } finally {
      await rm(dirname(artifact), { recursive: true, force: true });
    }

    const scoutPath = join(piSessions, "scout.jsonl");
    const scoutRef = "result:smoke-core-scout#1";
    const canonicalRef = `result:${requestId}`;
    const packagePayload = JSON.stringify({
      name: "pi-herdsman",
      version: "0.25.1",
    });
    const packageProvenance = JSON.stringify({
      agent: "smoke-core-scout",
      definition: "scout",
      cwd: "/private/project",
      piSessionId: "private-scout",
    });
    const packageArtifact = `Agent result source: ${packageProvenance}\n\n${packagePayload}`;
    const resultArtifact = join(piAgent, "pi-herdsman", "results", requestId);
    await mkdir(dirname(resultArtifact), { recursive: true });
    await writeFile(resultArtifact, packageArtifact);
    const handoffEntries = [
      ...implementerEntries,
      {
        type: "custom_message",
        customType: "pi-herdsman-agent-result",
        id: "scout-result-receipt",
        details: {
          requestId,
          runId: "private-run-id",
          ownerSessionId: "private-implementer",
          workspaceId: "private-workspace-id",
          agentLabel: "smoke-core-scout",
          paneId: "private-pane-id",
          piSessionId: "private-scout",
          piSessionFile: scoutPath,
          status: "completed",
          resultRef: canonicalRef,
          resultIndex: 1,
        },
        content: `Agent result · agent=smoke-core-scout · status=completed\n\nResult ref: ${scoutRef}\n\nPRIVATE_SCOUT_CONTENT`,
      },
      {
        type: "message",
        id: "attach-call-entry",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "attach_handoff",
              id: "attach-call",
              arguments: { files: [scoutRef] },
            },
          ],
        },
      },
      {
        type: "message",
        id: "attach-result-entry",
        message: {
          role: "toolResult",
          toolName: "attach_handoff",
          toolCallId: "attach-call",
          isError: false,
          details: {
            assignmentRequestId: intermediateRequestId,
            runId: "private-implementer-run",
            ownerSessionId: "private-root",
            workspaceId: "private-workspace-id",
            agentLabel: "smoke-core-implementer",
            paneId: "private-implementer-pane",
            piSessionId: "private-implementer",
            resultBindings: [{ ref: scoutRef, canonicalRef }],
          },
          content: "Selected result evidence.",
        },
      },
    ];
    await writeFile(
      join(piSessions, "implementer.jsonl"),
      handoffEntries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    await writeFile(
      join(mailbox, `result-${requestId}.json`),
      JSON.stringify({
        requestId,
        runId: "private-run-id",
        ownerSessionId: "private-implementer",
        workspaceId: "private-workspace-id",
        agentLabel: "smoke-core-scout",
        paneId: "private-pane-id",
        status: "completed",
      }),
    );
    const intermediateMailbox = join(mailboxRoot, "c".repeat(32));
    await mkdir(intermediateMailbox);
    await Promise.all([
      writeFile(
        join(intermediateMailbox, "state.json"),
        JSON.stringify({
          piSessionId: "private-implementer",
          ownerSessionId: "private-root",
          activeRequestId: null,
          completedRequestId: intermediateRequestId,
          runId: "private-implementer-run",
          workspaceId: "private-workspace-id",
          agentLabel: "smoke-core-implementer",
          paneId: "private-implementer-pane",
        }),
      ),
      writeFile(
        join(intermediateMailbox, `result-${intermediateRequestId}.json`),
        JSON.stringify({
          requestId: intermediateRequestId,
          runId: "private-implementer-run",
          ownerSessionId: "private-root",
          workspaceId: "private-workspace-id",
          agentLabel: "smoke-core-implementer",
          paneId: "private-implementer-pane",
          status: "completed",
        }),
      ),
    ]);
    const nextRequestId = "00000000-0000-4000-8000-000000000005";
    rootEntries.push(
      {
        type: "custom_message",
        customType: "pi-herdsman-agent-result",
        details: {
          requestId: intermediateRequestId,
          runId: "private-implementer-run",
          ownerSessionId: "private-root",
          workspaceId: "private-workspace-id",
          agentLabel: "smoke-core-implementer",
          paneId: "private-implementer-pane",
          piSessionId: "private-implementer",
          status: "completed",
        },
        content: `Agent result · agent=smoke-core-implementer · status=completed\n\nForwardable result evidence: ${scoutRef}\n\n${packageArtifact}`,
      },
      {
        type: "custom",
        customType: "pi-herdsman-result-ref",
        data: { ref: scoutRef, canonicalRef },
      },
      {
        type: "message",
        id: "next-call-entry",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "delegate_agent",
              id: "next-call",
              arguments: {
                definition: "scout",
                label: "smoke-core-next",
                task: "PRIVATE_NEXT_TASK",
                files: [scoutRef],
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "next-result-entry",
        message: {
          role: "toolResult",
          toolName: "delegate_agent",
          toolCallId: "next-call",
          isError: false,
          content: `Session: private-next\nRequest: ${nextRequestId}`,
        },
      },
    );
    const nextSessionPath = join(piSessions, "next.jsonl");
    const writeNextSession = (artifactContent, responseText) =>
      writeFile(
        nextSessionPath,
        [
          { type: "session", id: "private-next" },
          {
            type: "message",
            message: {
              role: "user",
              content: `<file name="${scoutRef}" bytes="${Buffer.byteLength(artifactContent)}">\n${artifactContent}\n</file>\n\nTask: PRIVATE_NEXT_TASK`,
            },
          },
          {
            type: "message",
            message: { role: "assistant", content: responseText },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
    await writeNextSession(packageArtifact, packagePayload);
    const nextMailbox = join(mailboxRoot, "d".repeat(32));
    await mkdir(nextMailbox);
    await Promise.all([
      writeFile(
        join(nextMailbox, "state.json"),
        JSON.stringify({
          piSessionId: "private-next",
          ownerSessionId: "private-root",
          activeRequestId: null,
          completedRequestId: nextRequestId,
          runId: "private-next-run",
          workspaceId: "private-workspace-id",
          agentLabel: "smoke-core-next",
          paneId: "private-next-pane",
        }),
      ),
      writeFile(
        join(nextMailbox, `result-${nextRequestId}.json`),
        JSON.stringify({
          requestId: nextRequestId,
          runId: "private-next-run",
          ownerSessionId: "private-root",
          workspaceId: "private-workspace-id",
          agentLabel: "smoke-core-next",
          paneId: "private-next-pane",
          status: "completed",
        }),
      ),
    ]);
    await Promise.all(
      [mailbox, intermediateMailbox, nextMailbox].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
    const handoffContext = {
      scenario: "core",
      stage: "core-delegation",
      paths: { piSessions, piAgent },
      sessionName: "isolated",
      rootPaneId: "root",
      expectedPackage: "pi-herdsman@0.25.1",
    };
    const collectHandoffProjection = () =>
      collectDiagnostics(handoffContext, { hostPaneId: "host" }, null, {
        execute: async () => ({ stdout: "" }),
        observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
        snapshot: async () => ({
          path: "private-root-path",
          status: "saved",
          contents: rootEntries
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
        }),
      });
    const handoffProjection = await collectHandoffProjection();
    const corePrompt = initialPromptForScenario("core", {
      expectedPackage: "pi-herdsman@0.25.1",
    });
    assert.match(
      corePrompt,
      /reply with exactly one JSON object containing the package "name" and "version" as strings, with no prose/u,
    );
    assert.equal(
      handoffProjection.coreHandoff.intermediate.sessionId,
      "private-implementer",
    );
    assert.equal(
      handoffProjection.coreHandoff.intermediate.sessionPath,
      "implementer.jsonl",
    );
    assert.equal(
      handoffProjection.coreHandoff.intermediate.requestId,
      intermediateRequestId,
    );
    assert.equal(
      handoffProjection.coreHandoff.intermediate.mailbox.candidates,
      0,
    );
    assert.equal(handoffProjection.coreHandoff.scout.mailbox.candidates, 0);
    assert.equal(handoffProjection.coreHandoff.scoutReference.ref, scoutRef);
    assert.equal(
      handoffProjection.coreHandoff.scoutReference.canonicalRef,
      canonicalRef,
    );
    assert.equal(
      handoffProjection.coreHandoff.scoutReference.artifact.readableUtf8,
      true,
    );
    assert.equal(handoffProjection.coreHandoff.scoutReference.valid, true);
    assert.deepEqual(
      handoffProjection.coreHandoff.attachHandoff.calls[0].files,
      [scoutRef],
    );
    assert.equal(
      handoffProjection.coreHandoff.attachHandoff.calls[0].results[0]
        .toolCallId,
      "attach-call",
    );
    assert.equal(
      handoffProjection.coreHandoff.attachHandoff.selectionMatches,
      true,
    );
    assert.equal(
      handoffProjection.coreHandoff.attachHandoff.calls[0].results[0].isError,
      false,
    );
    assert.equal(
      handoffProjection.coreHandoff.ownerImport.successfullyImported,
      true,
    );
    assert.equal(handoffProjection.coreHandoff.ownerImport.status, "completed");
    assert.deepEqual(
      handoffProjection.coreHandoff.ownerImport.forwardableRefs,
      [scoutRef],
    );
    assert.deepEqual(
      handoffProjection.coreHandoff.ownerImport.importedBindings,
      [{ ref: scoutRef, canonicalRef }],
    );
    assert.equal(
      handoffProjection.coreHandoff.nextAgent.sessionId,
      "private-next",
    );
    assert.equal(
      handoffProjection.coreHandoff.nextAgent.requestId,
      nextRequestId,
    );
    assert.deepEqual(handoffProjection.coreHandoff.nextAgent.files, [scoutRef]);
    assert.equal(
      handoffProjection.coreHandoff.nextAgent.assignmentMatches,
      true,
    );
    assert.equal(handoffProjection.coreHandoff.nextAgent.mailbox.candidates, 0);
    assert.equal(
      handoffProjection.coreHandoff.nextAgent.artifact.received,
      true,
    );
    assert.deepEqual(
      handoffProjection.coreHandoff.nextAgent.artifact.attachedPackage,
      { name: "pi-herdsman", version: "0.25.1" },
    );
    assert.equal(
      handoffProjection.coreHandoff.nextAgent.artifact.provenanceMatches,
      true,
    );
    assert.equal(
      handoffProjection.coreHandoff.nextAgent.artifact.responseMatchesArtifact,
      true,
    );
    assert.deepEqual(
      handoffProjection.coreHandoff.nextAgent.artifact.readback,
      { name: "pi-herdsman", version: "0.25.1" },
    );
    const handoffEvidence = sanitizedFailureEvidence(
      { scenario: "core", simulated: true, stage: "core-delegation" },
      { error: new Error("PRIVATE_FAILURE") },
      "STALLED",
      "PASS",
      handoffProjection,
    );
    const handoffArtifact = await preserveFailureEvidence(handoffEvidence);
    try {
      const saved = await readFile(handoffArtifact, "utf8");
      assert.equal(
        JSON.parse(saved).diagnostics.coreHandoff.scoutReference.valid,
        true,
      );
      assert.equal(
        JSON.parse(saved).diagnostics.coreHandoff.ownerImport
          .successfullyImported,
        true,
      );
      assert.equal(
        JSON.parse(saved).diagnostics.coreHandoff.nextAgent.artifact
          .responseMatchesArtifact,
        true,
      );
      assert.deepEqual(
        JSON.parse(saved).diagnostics.coreHandoff.nextAgent.artifact.readback,
        { name: "pi-herdsman", version: "0.25.1" },
      );
      assert.deepEqual(
        JSON.parse(saved).diagnostics.coreHandoff.nextAgent.artifact
          .attachedPackage,
        { name: "pi-herdsman", version: "0.25.1" },
      );
      assert.equal(
        JSON.parse(saved).diagnostics.coreHandoff.nextAgent.artifact
          .provenanceMatches,
        true,
      );
      assert.doesNotMatch(
        saved,
        /PRIVATE_TASK|PRIVATE_NEXT_TASK|PRIVATE_SCOUT_CONTENT|PRIVATE_FAILURE|PRIVATE_ERROR|\{"name"/u,
      );
    } finally {
      await rm(dirname(handoffArtifact), { recursive: true, force: true });
    }

    for (const [artifactContent, responseText, expectedAttachedPackage] of [
      [
        `Agent result source: not-json\n\n${packagePayload}`,
        packagePayload,
        { name: null, version: null },
      ],
      [
        `Agent result source: ${JSON.stringify({
          agent: "smoke-other-scout",
          definition: "scout",
          cwd: "/private/project",
        })}\n\n${packagePayload}`,
        packagePayload,
        { name: "pi-herdsman", version: "0.25.1" },
      ],
      [
        `Agent result source: ${packageProvenance}\n\n${JSON.stringify({
          name: "pi-herdsman",
          version: "0.25.2",
        })}`,
        JSON.stringify({ name: "pi-herdsman", version: "0.25.2" }),
        { name: "pi-herdsman", version: "0.25.2" },
      ],
      [
        packageArtifact,
        JSON.stringify({ name: "pi-herdsman", version: "0.25.2" }),
        { name: "pi-herdsman", version: "0.25.1" },
      ],
    ]) {
      await writeNextSession(artifactContent, responseText);
      const projection = await collectHandoffProjection();
      assert.equal(
        projection.coreHandoff.nextAgent.artifact.responseMatchesArtifact,
        false,
      );
      assert.deepEqual(
        projection.coreHandoff.nextAgent.artifact.attachedPackage,
        expectedAttachedPackage,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failure result projection allowlists only bounded nonsensitive fields", () => {
  const result = sanitizedFailureEvidence(
    {
      scenario: "core",
      simulated: true,
      stage: "core-delegation",
      lastVerified: "agent_process_observed",
      coreProcessEvidence: [{ pid: 10 }, { pid: 11 }],
      firstRequestObserved: true,
      firstRequestVerified: false,
      prompt: "private prompt",
      environment: { TOKEN: "secret" },
    },
    {
      error: Object.assign(new Error("private details"), {
        code: "pane_not_found",
      }),
    },
    "EVIDENCE_FAIL",
    "PENDING",
  );
  assert.deepEqual(result, {
    scenario: "core",
    mode: "simulated",
    outcome: "EVIDENCE_FAIL",
    stage: "core-delegation",
    errorCode: "pane_not_found",
    lastVerified: "agent_process_observed",
    processesVerified: 2,
    sessionStartObserved: false,
    firstRequestObserved: true,
    firstRequestVerified: false,
    parentOwnership: null,
    parentCleanup: null,
    cleanupErrorCode: null,
    cleanupFailureCategories: [],
    cleanup: "PENDING",
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("failure artifact propagates only fixed cleanup substep categories", async () => {
  const ctx = { scenario: "manager-handoff", simulated: true };
  const cleanupError = await cleanup(
    { root: "/PRIVATE/root", authLink: "/PRIVATE/auth" },
    { hostTabId: "PRIVATE_TAB" },
    ctx,
    {
      removeFile: async () => {
        const error = new Error("PRIVATE auth path");
        error.code = "ENOENT";
        throw error;
      },
      herdrCommand: async () => {
        throw new Error("PRIVATE /tmp/path cleanup failure");
      },
    },
  );
  assert.match(cleanupError ?? "", /PRIVATE/);
  assert.deepEqual(ctx.cleanupFailureCategories, ["host_tab"]);
  const evidence = sanitizedFailureEvidence(
    {
      ...ctx,
      cleanupFailureCategories: [
        ...ctx.cleanupFailureCategories,
        "PRIVATE /tmp/path and error",
      ],
      privateError: "PRIVATE cleanup error text",
    },
    {},
    "SCENARIO_FAIL",
    "FAIL",
  );
  const artifact = await preserveFailureEvidence(evidence);
  try {
    const persisted = await readFile(artifact, "utf8");
    assert.deepEqual(JSON.parse(persisted).cleanupFailureCategories, [
      "host_tab",
    ]);
    assert.doesNotMatch(persisted, /PRIVATE|\/tmp\/path|error text/u);
  } finally {
    await rm(dirname(artifact), { recursive: true, force: true });
  }
});

test("terminal failure stall artifact retains only allowlisted report progress", async () => {
  const progress = {
    requestCount: 2,
    settledCount: 1,
    settledNonAborted: true,
    finalError: true,
    partialObserved: true,
    leadToolCalls: 0,
    reportCount: 0,
    logicalReports: 0,
    actionable: false,
    managerResponded: false,
    settlementCallback: "observed",
    settlementOutcome: "error",
    reportPending: "observed",
    publicationAttempt: "attempted",
    publicationOutcome: "returned",
    managerReceipt: "not_observed",
    managerFollowup: "not_observed",
    prompt: "private prompt",
    transcript: "private transcript",
    mailbox: "private mailbox",
    sessionId: "private-session-id",
    message: "private report body",
    error: "private raw error",
    secret: "private-secret",
  };
  const evidence = sanitizedFailureEvidence(
    {
      scenario: "terminal-failure",
      simulated: true,
      stage: "terminal-failure-settlement-and-report",
    },
    {
      error: {
        code: "SMOKE_STALLED",
        smoke: { stage: "terminal-failure-report", lastProgress: progress },
      },
    },
    "SCENARIO_FAIL",
    "PASS",
  );
  const artifactPath = await preserveFailureEvidence(evidence);
  const persisted = await readFile(artifactPath, "utf8");
  assert.deepEqual(JSON.parse(persisted).terminalFailureProgress, {
    requestCount: 2,
    settledCount: 1,
    settledNonAborted: true,
    finalError: true,
    partialObserved: true,
    leadToolCalls: 0,
    reportCount: 0,
    logicalReports: 0,
    actionable: false,
    managerResponded: false,
    settlementCallback: "observed",
    settlementOutcome: "error",
    reportPending: "observed",
    publicationAttempt: "attempted",
    publicationOutcome: "returned",
    managerReceipt: "not_observed",
    managerFollowup: "not_observed",
  });
  assert.doesNotMatch(
    persisted,
    /private prompt|private transcript|private mailbox|private-session-id|private report body|private raw error|private-secret/,
  );
  const incomplete = sanitizedFailureEvidence(
    { scenario: "terminal-failure", simulated: true },
    {
      error: {
        smoke: { stage: "terminal-failure-report", lastProgress: {} },
      },
    },
    "SCENARIO_FAIL",
    "PASS",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(incomplete.terminalFailureProgress).filter(([key]) =>
        [
          "settlementCallback",
          "settlementOutcome",
          "reportPending",
          "publicationAttempt",
          "publicationOutcome",
          "managerReceipt",
          "managerFollowup",
        ].includes(key),
      ),
    ),
    {
      settlementCallback: "not_observed",
      settlementOutcome: "not_observed",
      reportPending: "not_observed",
      publicationAttempt: "not_observed",
      publicationOutcome: "not_observed",
      managerReceipt: "not_observed",
      managerFollowup: "not_observed",
    },
  );
  const pendingWithoutAttempt = sanitizedFailureEvidence(
    { scenario: "terminal-failure", simulated: true },
    {
      error: {
        smoke: {
          stage: "terminal-failure-report",
          lastProgress: {
            reportPending: "observed",
            prompt: "PRIVATE prompt",
            sessionId: "PRIVATE session id",
            report: "PRIVATE report body",
          },
        },
      },
    },
    "SCENARIO_FAIL",
    "PASS",
  );
  assert.equal(
    pendingWithoutAttempt.terminalFailureProgress.reportPending,
    "observed",
  );
  assert.equal(
    pendingWithoutAttempt.terminalFailureProgress.publicationAttempt,
    "not_observed",
  );
  assert.doesNotMatch(
    JSON.stringify(pendingWithoutAttempt),
    /PRIVATE|session id|report body/u,
  );
  const unrelated = sanitizedFailureEvidence(
    { scenario: "core", simulated: true },
    { error: { smoke: { stage: "core-delegation", lastProgress: progress } } },
    "SCENARIO_FAIL",
    "PASS",
  );
  assert.equal("terminalFailureProgress" in unrelated, false);
  await rm(dirname(artifactPath), { recursive: true, force: true });
});

test("failure artifact retains allowlisted parent routing identity across cleanup update", async () => {
  const paths = {
    root: "/tmp/phs-owned",
    herdrConfig: "/tmp/phs-owned/herdr.toml",
    xdgConfig: "/tmp/phs-owned/xdg-config",
    xdgState: "/tmp/phs-owned/xdg-state",
  };
  const ctx = {
    scenario: "core",
    simulated: true,
    paths,
    owned: {
      parent: {
        name: "phs-a1b2c3d4e5f6",
        workspaceId: "workspace-owned",
        server: { pid: 4321 },
        exit: undefined,
        env: { HERDR_SESSION: "phs-a1b2c3d4e5f6", TOKEN: "must-not-leak" },
        stderr: "private server output",
      },
    },
    parentCleanupDiagnostics: {
      stop: { completed: false, errorCode: "COMMAND_FAILED" },
      child: {
        exitObservedBeforeStop: false,
        exitObservedAfterStop: false,
        waitAfterStop: "timeout",
        sigtermSent: true,
        exitObservedAfterSigterm: false,
        waitAfterSigterm: "timeout",
        sigkillSent: true,
        exitObservedAfterSigkill: true,
        waitAfterSigkill: "exited",
      },
      namedServer: { verified: true, running: false },
      cleanupErrorCode: "PARENT_SHUTDOWN_UNVERIFIED",
      stderr: "private post-cleanup stderr",
      environment: { TOKEN: "must-not-leak" },
    },
    cleanupErrorCode: "PARENT_SHUTDOWN_UNVERIFIED",
    prompt: "private prompt",
    environment: { TOKEN: "must-not-leak" },
  };
  const result = sanitizedFailureEvidence(
    ctx,
    { error: Object.assign(new Error("private details"), { code: "failure" }) },
    "SCENARIO_FAIL",
    "PENDING",
  );
  assert.deepEqual(result.parentOwnership, {
    session: "phs-a1b2c3d4e5f6",
    workspaceId: "workspace-owned",
    childPid: 4321,
    childExitObserved: false,
  });

  const artifactPath = await preserveFailureEvidence(result);
  const directory = dirname(artifactPath);
  const permissions = await stat(artifactPath);
  if (process.platform !== "win32") {
    assert.equal(permissions.mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  result.cleanup = "FAIL";
  await preserveFailureEvidence(result, artifactPath);
  const persisted = await readFile(artifactPath, "utf8");
  assert.match(persisted, /"cleanup": "FAIL"/);
  assert.match(persisted, /"session": "phs-a1b2c3d4e5f6"/);
  assert.match(persisted, /"childExitObserved": false/);
  assert.match(persisted, /"waitAfterStop": "timeout"/);
  assert.match(persisted, /"sigtermSent": true/);
  assert.match(persisted, /"waitAfterSigkill": "exited"/);
  assert.match(persisted, /"running": false/);
  assert.match(persisted, /"cleanupErrorCode": "PARENT_SHUTDOWN_UNVERIFIED"/);
  assert.doesNotMatch(
    persisted,
    /private post-cleanup stderr|environment|TOKEN|\/tmp\/phs-owned/,
  );
  assert.match(persisted, /"session": "phs-a1b2c3d4e5f6"/);
  assert.doesNotMatch(
    persisted,
    /TOKEN|must-not-leak|private server output|private prompt/,
  );
  await rm(directory, { recursive: true, force: true });
});

test("exact core and continuation tool evidence is enforced only in simulated mode", () => {
  const scoutRef = "result:smoke-core-scout#1";
  const exactCoreEvidence = [
    {
      name: "delegate_agent",
      arguments: { label: "smoke-core-implementer" },
      result: "started",
    },
    {
      name: "delegate_agent",
      arguments: { label: "smoke-core-scout" },
      result: "started",
      sessionId: "intermediate-session",
    },
    {
      name: "attach_handoff",
      arguments: { files: [scoutRef] },
      result: "selected",
      sessionId: "intermediate-session",
    },
    {
      name: "delegate_agent",
      arguments: { label: "smoke-core-next", files: [scoutRef] },
      result: "started",
    },
    {
      name: "read",
      result: '{"name": "pi-herdsman", "version": "0.25.1"}',
    },
  ];
  assert.doesNotThrow(() =>
    assertCoreToolEvidence(true, exactCoreEvidence, "pi-herdsman@0.25.1"),
  );
  assert.throws(
    () => assertCoreToolEvidence(true, [], "pi-herdsman@0.25.1"),
    /select and forward nested result evidence/,
  );
  assert.doesNotThrow(() =>
    assertCoreToolEvidence(false, [], "pi-herdsman@0.25.1"),
  );

  const successfulRead = {
    message: { content: [{ type: "text", text: "pi-herdsman" }] },
  };
  assert.doesNotThrow(() =>
    assertContinuationReadEvidence(true, [{}], successfulRead, "pi-herdsman"),
  );
  assert.throws(
    () => assertContinuationReadEvidence(true, [], undefined, "pi-herdsman"),
    /must not reread package.json/,
  );
  assert.doesNotThrow(() =>
    assertContinuationReadEvidence(false, [], undefined, "pi-herdsman"),
  );
});

test("smoke runtime baseline accepts matching and newer stable versions", () => {
  assert.doesNotThrow(() => requireTestedBaseline("Pi", "1.0.1", "1.0.1"));
  assert.doesNotThrow(() => requireTestedBaseline("Pi", "1.0.2", "1.0.1"));
  assert.doesNotThrow(() => requireTestedBaseline("Pi", "2.0.0", "1.0.1"));
  assert.throws(
    () => requireTestedBaseline("Pi", "1.0.0", "1.0.1"),
    /below tested baseline 1\.0\.1/,
  );
  assert.throws(
    () => requireTestedBaseline("Pi", "not-a-version", "1.0.1"),
    /invalid Pi version/,
  );
  assert.throws(
    () => requireTestedBaseline("Pi", "1.0.1", undefined),
    /invalid Pi tested baseline/,
  );
});

test("smoke verifies the isolated Herdr server", () => {
  const status = {
    client: { version: "0.9.5" },
    server: {
      running: true,
      compatible: true,
      session: "smoke-test",
      version: "0.9.5",
    },
  };

  const verify = (server) =>
    requireNestedHerdrServer(
      { ...status, server: { ...status.server, ...server } },
      "smoke-test",
      "0.9.5",
    );

  assert.equal(verify({}), "0.9.5");
  assert.equal(verify({ version: "0.9.6" }), "0.9.6");

  assert.throws(() => verify({ version: "0.9.3" }), /below tested baseline/);
  assert.throws(
    () => verify({ version: undefined }),
    /invalid Herdr server version/,
  );
  assert.throws(() => verify({ session: "default" }), /session mismatch/);
  assert.throws(() => verify({ compatible: false }), /incompatible/);
  assert.throws(() => verify({ running: false }), /not running/);
});

test("missing managed session file is not ready yet", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  try {
    assert.equal(
      await isolatedSessionDetails(
        { paths: { piSessions } },
        {
          agent_session: {
            kind: "path",
            value: join(piSessions, "pending.jsonl"),
          },
        },
      ),
      undefined,
    );
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
});

test("saved-session evidence separates header identity from continuation task instruction", () => {
  const followup = "Continue this exact saved session.";
  const contents = [
    { type: "session", id: "actual-session" },
    {
      type: "message",
      message: { role: "user", content: followup },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.deepEqual(savedSessionHeaderEvidence(contents, "expected-session"), {
    expectedSessionId: "expected-session",
    actualSessionId: "actual-session",
    sessionHeaderFound: true,
    sessionIdMatches: false,
  });
  assert.deepEqual(
    continuationSessionEvidence(contents, "expected-session", followup),
    {
      sessionHeaderFound: true,
      sessionIdMatches: false,
      continuationTaskFound: true,
      taskInstructionFound: true,
    },
  );
  assert.equal(
    continuationSessionEvidence(
      contents,
      "actual-session",
      "missing instruction",
    ).taskInstructionFound,
    false,
  );
});

test("continuation task evidence accepts the paraphrased task only in child user text", () => {
  const task =
    "Recall the exact package name from your previous assignment; do not reread package.json. Return PI_HERDSMAN_CONTINUATION_SECOND.";
  const rootPrompt =
    "Without rereading package.json, return the remembered package name.";
  for (const [role, content, expected] of [
    [
      "user",
      `Assignment:\n${task.toLowerCase().replaceAll(" ", "\n")}\nEnd assignment.`,
      true,
    ],
    ["user", rootPrompt, false],
    ["assistant", task, false],
  ] as const) {
    const contents = [
      { type: "session", id: "saved-session" },
      {
        type: "message",
        message: {
          role,
          content,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const evidence = continuationSessionEvidence(
      contents,
      "saved-session",
      task,
    );
    assert.equal(evidence.sessionIdMatches, true);
    assert.equal(evidence.taskInstructionFound, expected);
    assert.equal(
      continuationSessionEvidence(contents, "saved-session", null)
        .taskInstructionFound,
      false,
    );
  }
});

test("continuation task parser correlates tool call, successful session result and response ancestry", () => {
  const task = "Recall the exact package name; return SECOND.";
  const prompt = "Without rereading package.json...";
  const entries = [
    {
      type: "message",
      id: "prompt",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "call",
      parentId: "prompt",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "other-call",
            name: "continue_agent",
            arguments: { task: "wrong task" },
          },
          {
            type: "toolCall",
            id: "continue-call",
            name: "continue_agent",
            arguments: { session: "/saved/child.jsonl", task },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: "call",
      message: {
        role: "toolResult",
        toolName: "continue_agent",
        toolCallId: "continue-call",
        details: { ok: true, action: "continue", session_id: "child" },
      },
    },
    {
      type: "message",
      id: "response",
      parentId: "tool-result",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "package SECOND",
      },
    },
  ];
  const encode = (value: unknown[]) =>
    value.map((entry) => JSON.stringify(entry)).join("\n");
  assert.equal(
    correlatedContinuationTask(encode(entries), "response", "child", prompt),
    task,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "response",
      "wrong-child",
      prompt,
    ),
    null,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "missing-response",
      "child",
      prompt,
    ),
    null,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "response",
      "child",
      "another prompt",
    ),
    null,
  );
  for (const mutation of [
    (copy: any[]) => {
      copy[2].message.toolCallId = "missing-call";
    },
    (copy: any[]) => {
      copy[2].message.isError = true;
    },
    (copy: any[]) => {
      copy[2].message.details.ok = false;
    },
    (copy: any[]) => {
      copy[3].parentId = "prompt";
    },
    (copy: any[]) => {
      copy.splice(3, 0, {
        type: "message",
        id: "new-prompt",
        parentId: "tool-result",
        message: { role: "user", content: prompt },
      });
      copy[4].parentId = "new-prompt";
    },
    (copy: any[]) => {
      delete copy[1].message.content[1].arguments.task;
    },
    (copy: any[]) => {
      copy[1].message.content[1].arguments.task = " ";
    },
    (copy: any[]) => {
      copy[1].message.content[1].arguments.task = "x".repeat(16 * 1024 + 1);
    },
  ]) {
    const copy = structuredClone(entries);
    mutation(copy);
    assert.equal(
      correlatedContinuationTask(encode(copy), "response", "child", prompt),
      null,
    );
  }
  const child = encode([
    { type: "session", id: "wrong-child" },
    { type: "message", message: { role: "user", content: task } },
  ]);
  const evidence = continuationSessionEvidence(child, "child", task);
  assert.equal(evidence.sessionIdMatches, false);
  assert.equal(evidence.taskInstructionFound, true);
  assert.doesNotMatch(JSON.stringify(evidence), /wrong-child|Recall/);
  assert.equal(
    continuationSessionEvidence(child, "child", null).continuationTaskFound,
    false,
  );
});

test("manager readiness evidence includes a workspace child's mismatched session header", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  const path = join(piSessions, "lead.jsonl");
  try {
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", id: "actual-session" })}\n${JSON.stringify({ secret: "not diagnostic" })}\n`,
    );
    const evidence = await managerChildSessionEvidence(
      { paths: { piSessions } },
      [
        {
          workspace_id: "assigned-workspace",
          agent_session: { kind: "path", value: path },
        },
      ],
      "assigned-workspace",
      "expected-session",
    );

    assert.deepEqual(evidence, {
      workspaceId: "assigned-workspace",
      expectedSessionId: "expected-session",
      candidates: [
        {
          identityKind: "path",
          reportedSessionId: null,
          path,
          exists: true,
          expectedSessionId: "expected-session",
          actualSessionId: "actual-session",
          sessionHeaderFound: true,
          sessionIdMatches: false,
        },
      ],
      expectedSessionFile: null,
    });
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
});

test("smoke isolates nested Herdr routing and Pi paths", () => {
  const base = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/parent.sock",
    HERDR_CLIENT_SOCKET_PATH: "/parent-client.sock",
    HERDR_SESSION: "parent",
    HERDR_WORKSPACE_ID: "parent-workspace",
    HERDR_TAB_ID: "parent-tab",
    HERDR_PANE_ID: "parent-pane",
    HERDR_CONFIG_PATH: "/parent/config",
    XDG_CONFIG_HOME: "/parent/xdg-config",
    XDG_STATE_HOME: "/parent/xdg-state",
    PI_CODING_AGENT_DIR: "/parent/pi-agent",
    PI_CODING_AGENT_SESSION_DIR: "/parent/pi-sessions",
    KEEP_ME: "yes",
  };
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
  };
  const expected = {
    HERDR_ENV: "1",
    HERDR_CONFIG_PATH: paths.herdrConfig,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_STATE_HOME: paths.xdgState,
    PI_CODING_AGENT_DIR: paths.piAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    KEEP_ME: "yes",
  };
  assert.deepEqual(isolatedEnv(base, paths), expected);
  assert.deepEqual(nestedControlEnv(base, paths, "smoke-123"), {
    ...expected,
    HERDR_SESSION: "smoke-123",
  });
  assert.equal(base.HERDR_SESSION, "parent");
});

test("root pane command removes inherited managed identity before Pi only", async () => {
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
  };
  const identity = {
    PI_HERDSMAN_MAILBOX: "/synthetic/mailbox",
    PI_HERDSMAN_RUN_ID: "synthetic-run",
    PI_HERDSMAN_OWNER_SESSION_ID: "synthetic-owner",
    PI_HERDSMAN_OWNER_DISPLAY: "synthetic display",
    PI_HERDSMAN_LABEL: "synthetic-agent",
    PI_HERDSMAN_WORKSPACE_ID: "synthetic-workspace",
    PI_HERDSMAN_AGENT_DEFINITION: "implementer",
    PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS: '["scout"]',
    PI_SUBAGENT_PARENT_SESSION: "synthetic-parent",
    PI_SUBAGENT_CHILD: "1",
  };
  const args = [
    "pi",
    ...candidateArgs({
      candidateExtension: "/smoke/dist/index.js",
      herdrStateExtension: "/smoke/herdr-agent-state.ts",
      model: "provider/model:high",
    }),
    "startup prompt",
  ];
  const expectedCommand = [
    "env",
    ...Object.keys(identity).flatMap((key) => ["-u", key]),
    ...args,
  ]
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const command = rootCandidateCommand(args);
  assert.equal(command, expectedCommand);
  assert.ok(
    command.indexOf("'-u' 'PI_SUBAGENT_CHILD'") < command.indexOf("'pi'"),
  );
  assert.match(
    command,
    /'--approve'.*'--extension' '\/smoke\/dist\/index\.js'.*'--model' 'provider\/model:high'.*'startup prompt'/,
  );

  const ctx = {
    paths,
    sessionName: "smoke-root",
  };
  let paneArgs;
  let paneOptions;
  await submitPaneCommand(
    ctx,
    "w1:p1",
    command,
    async (_file, callArgs, options) => {
      paneArgs = callArgs;
      paneOptions = options;
      return { stdout: "", stderr: "", pid: 123 };
    },
  );
  assert.deepEqual(paneArgs, ["pane", "run", "w1:p1", expectedCommand]);

  const base = { ...identity, HERDR_ENV: "1", KEEP_ME: "yes" };
  const descendantEnv = nestedControlEnv(base, paths, "smoke-child");
  assert.deepEqual(descendantEnv, {
    ...identity,
    HERDR_ENV: "1",
    HERDR_CONFIG_PATH: "/smoke/herdr.toml",
    XDG_CONFIG_HOME: "/smoke/xdg-config",
    XDG_STATE_HOME: "/smoke/xdg-state",
    PI_CODING_AGENT_DIR: "/smoke/pi-agent",
    PI_CODING_AGENT_SESSION_DIR: "/smoke/pi-sessions",
    KEEP_ME: "yes",
    HERDR_SESSION: "smoke-child",
  });
  assert.equal(paneOptions.env.HERDR_CONFIG_PATH, paths.herdrConfig);
  assert.equal(paneOptions.env.PI_CODING_AGENT_DIR, paths.piAgent);
  assert.equal(paneOptions.env.PI_CODING_AGENT_SESSION_DIR, paths.piSessions);
  for (const [key, value] of Object.entries(identity))
    assert.equal(descendantEnv[key], value);
  assert.deepEqual(base, { ...identity, HERDR_ENV: "1", KEEP_ME: "yes" });
});

test("nested Herdr hashes the API socket while checking both socket limits", () => {
  const paths = { xdgConfig: "/tmp/xdg" };
  assert.equal(
    nestedHerdrApiSocketPath(paths, "smoke"),
    join(paths.xdgConfig, "herdr", "sessions", "smoke", "herdr.sock"),
  );
  const directory = join(paths.xdgConfig, "herdr", "sessions");
  const clientOnlyTooLong = "x".repeat(
    99 -
      Buffer.byteLength(join(directory, "herdr.sock")) -
      Buffer.byteLength(sep),
  );
  assert.ok(
    Buffer.byteLength(join(directory, clientOnlyTooLong, "herdr.sock")) + 1 <=
      100,
  );
  assert.throws(
    () => nestedHerdrApiSocketPath(paths, clientOnlyTooLong),
    /herdr-client\.sock path is too long/,
  );
});

test("smoke CLI parses scenarios and one-off model overrides", async () => {
  assert.deepEqual(parseSmokeArgs([]), {
    scenario: "core",
    model: undefined,
    simulated: false,
    managerReadyTimeoutMs: undefined,
    managerRecoveryDiagnostics: false,
    managerExternalRemoval: false,
    managerRemovalAcceptance: false,
  });
  for (const scenario of [
    "core",
    "continuation",
    "chief-tree",
    "manager-bootstrap",
    "manager-recovery",
    "active-stop",
    "terminal-failure",
  ])
    assert.equal(parseSmokeArgs([scenario]).scenario, scenario);
  assert.deepEqual(
    parseSmokeArgs(["chief-tree", "--model", "provider/model:high"]),
    {
      scenario: "chief-tree",
      model: "provider/model:high",
      simulated: false,
      managerReadyTimeoutMs: undefined,
      managerRecoveryDiagnostics: false,
      managerExternalRemoval: false,
      managerRemovalAcceptance: false,
    },
  );
  assert.deepEqual(
    parseSmokeArgs(["--model", "provider/model:xhigh", "continuation"]),
    {
      scenario: "continuation",
      model: "provider/model:xhigh",
      simulated: false,
      managerReadyTimeoutMs: undefined,
      managerRecoveryDiagnostics: false,
      managerExternalRemoval: false,
      managerRemovalAcceptance: false,
    },
  );
  assert.throws(() => parseSmokeArgs(["core", "extra"]));
  assert.throws(() => parseSmokeArgs(["--unknown"]));
  assert.throws(() => parseSmokeArgs(["wat"]), /unknown smoke scenario/);
  assert.deepEqual(parseSmokeArgs(["chief-tree", "--simulated"]), {
    scenario: "chief-tree",
    model: undefined,
    simulated: true,
    managerReadyTimeoutMs: undefined,
    managerRecoveryDiagnostics: false,
    managerExternalRemoval: false,
    managerRemovalAcceptance: false,
  });
  assert.throws(
    () => parseSmokeArgs(["core", "--simulated", "--model", "p/m"]),
    /cannot be combined/,
  );
  assert.throws(
    () => parseSmokeArgs(["manager-recovery", "--simulated"]),
    /does not support --simulated/,
  );
  assert.throws(
    () => parseSmokeArgs(["manager-bootstrap", "--simulated"]),
    /requires a live model/,
  );
  assert.equal(initialPromptForScenario("manager-bootstrap", {}), undefined);
  for (const scenario of ["core", "continuation"])
    assert.equal(parseSmokeArgs([scenario, "--simulated"]).simulated, true);
  for (const scenario of ["agent-terminal-failure", "manager-handoff"]) {
    assert.equal(parseSmokeArgs([scenario, "--simulated"]).scenario, scenario);
    assert.throws(() => parseSmokeArgs([scenario]), /requires --simulated/);
  }
  await assert.rejects(runScenario({}, "wat"), /unknown smoke scenario/);
});

test("simulated Agent failure decision requires the exact correlated failed handoff", () => {
  const call = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "delegate_agent",
        arguments: {
          definition: "smoke-failure-agent",
          label: "smoke-terminal-agent",
        },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolName: "delegate_agent",
    toolCallId: "call-1",
    content: "Session: child-session\nRequest: request-1",
  };
  const handoff = {
    role: "user",
    content:
      "Agent result · agent=smoke-terminal-agent · definition=smoke-failure-agent · session=child-session · status=failed\n\nDelegation status: failed",
  };
  const decideWith = (delivered) =>
    decide("agent-terminal-failure", {
      messages: [
        { role: "user", content: "SMOKE_AGENT_FAILURE" },
        call,
        result,
        ...(delivered ? [delivered] : []),
      ],
    });
  assert.match(
    decideWith(handoff).content[0].text,
    /SMOKE_AGENT_FAILURE_DELIVERED/,
  );
  assert.match(
    decideWith({
      ...handoff,
      content: handoff.content.replace("child-session", "wrong-session"),
    }).content[0].text,
    /Waiting for the exact Agent failure/,
  );
});

test("failed Agent runner handoff requires the persisted custom-message identity", () => {
  const handoff = {
    type: "custom_message",
    customType: "pi-herdsman-agent-result",
    details: {
      piSessionId: "child-session",
      requestId: "request-1",
      ownerSessionId: "expected-owner",
      agentLabel: "smoke-terminal-agent",
      agentDefinition: "smoke-failure-agent",
      status: "failed",
      error: { code: "execution_error" },
    },
    content:
      "Agent result · agent=smoke-terminal-agent · definition=smoke-failure-agent · session=child-session · status=failed\n\nDelegation status: failed",
  };
  assert.equal(
    acceptsFailedAgentHandoff(
      handoff,
      "request-1",
      "child-session",
      "expected-owner",
    ),
    true,
  );
  assert.equal(
    failedAgentHandoff(
      [handoff],
      "request-1",
      "child-session",
      "expected-owner",
    ),
    handoff,
  );
  for (const invalid of [
    { ...handoff, customType: "other" },
    { ...handoff, details: { ...handoff.details, requestId: "wrong" } },
    { ...handoff, details: { ...handoff.details, piSessionId: "wrong" } },
    { ...handoff, details: { ...handoff.details, ownerSessionId: "wrong" } },
    { ...handoff, details: { ...handoff.details, agentLabel: "wrong-agent" } },
    {
      ...handoff,
      details: { ...handoff.details, agentDefinition: "wrong-definition" },
    },
    { ...handoff, details: { ...handoff.details, status: "completed" } },
    {
      ...handoff,
      details: { ...handoff.details, error: { code: "empty_result" } },
    },
  ])
    assert.equal(
      acceptsFailedAgentHandoff(
        invalid,
        "request-1",
        "child-session",
        "expected-owner",
      ),
      false,
    );
  assert.equal(
    failedAgentHandoff([], "request-1", "child-session", "expected-owner"),
    null,
  );
  assert.throws(
    () =>
      failedAgentHandoff(
        [
          handoff,
          {
            ...handoff,
            details: { ...handoff.details, error: { code: "empty_result" } },
          },
        ],
        "request-1",
        "child-session",
        "expected-owner",
      ),
    /multiple final results/,
  );
  for (const invalid of [
    { ...handoff, details: { ...handoff.details, status: "completed" } },
    {
      ...handoff,
      details: { ...handoff.details, error: { code: "empty_result" } },
    },
  ])
    assert.throws(
      () =>
        failedAgentHandoff(
          [invalid],
          "request-1",
          "child-session",
          "expected-owner",
        ),
      /wrong terminal outcome/,
    );
});

test("failed Agent retirement requires absent process, pane, registration, and mailbox", () => {
  const converged = {
    matchingAgents: 0,
    panePresent: false,
    processAlive: false,
    mailboxPending: false,
  };
  assert.equal(agentRetirementConverged(converged), true);
  assert.equal(
    agentRetirementConverged({ ...converged, processAlive: true }),
    false,
  );
  assert.equal(
    agentRetirementConverged({ ...converged, mailboxPending: true }),
    false,
  );
});

test("manager-handoff faux Lead only calls offered message_supervisor tool", () => {
  const tool = {
    name: "message_supervisor",
    description: "Send a message to the verified supervisor.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  };
  const system = (
    toolsAdded?: (typeof tool)[],
    toolsRemoved?: { name: string }[],
  ) => ({
    role: "system" as const,
    content: "",
    ...(toolsAdded ? { toolsAdded } : {}),
    ...(toolsRemoved ? { toolsRemoved } : {}),
    timestamp: 1,
  });
  const prompt = {
    role: "user" as const,
    content:
      "Call message_supervisor exactly once with this exact text: MANAGER_HANDOFF_READY. Then end the turn.",
    timestamp: 2,
  };
  const availableMessages = [system([tool]), prompt];
  assert.equal(managerHandoffSupervisorToolAvailable(availableMessages), true);
  const available = decideSmokeFaux("manager-handoff-lead", {
    messages: availableMessages,
  });
  assert.equal(available.content[0]?.type, "toolCall");
  assert.equal(
    available.content[0]?.type === "toolCall" && available.content[0].name,
    "message_supervisor",
  );

  const unavailableMessages = [system(), prompt];
  assert.equal(
    managerHandoffSupervisorToolAvailable(unavailableMessages),
    false,
  );
  assert.throws(
    () =>
      decideSmokeFaux("manager-handoff-lead", {
        messages: unavailableMessages,
      }),
    { message: "MANAGER_HANDOFF_SUPERVISOR_TOOL_NOT_OFFERED" },
  );
  const removedMessages = [
    system([tool]),
    system(undefined, [{ name: tool.name }]),
    prompt,
  ];
  assert.equal(managerHandoffSupervisorToolAvailable(removedMessages), false);
});

test("manager-handoff faux tool availability exposes only the sentinel enum", () => {
  assert.equal(
    managerHandoffSupervisorToolAvailability(
      JSON.stringify({
        model: "manager-handoff-lead",
        supervisorToolAvailability: "not_offered",
        private: "PRIVATE_VALUE",
      }),
    ),
    "not_offered",
  );
  assert.equal(managerHandoffSupervisorToolAvailability(""), "not_observed");
  assert.equal(
    managerHandoffSupervisorToolAvailability(
      JSON.stringify({
        model: "manager-handoff-lead",
        supervisorToolAvailability: "PRIVATE_VALUE",
      }),
    ),
    "not_observed",
  );
  assert.equal(
    managerHandoffSupervisorToolAvailability(
      JSON.stringify({
        model: "other-model",
        supervisorToolAvailability: "not_offered",
      }),
    ),
    "not_observed",
  );
  assert.equal(
    managerAssignmentDiagnostics({
      fauxSupervisorToolAvailability: "PRIVATE_VALUE",
    }).fauxSupervisorToolAvailability,
    "not_observed",
  );
});

test("Manager assignment diagnostics are bounded and reject a mismatched branch identity", () => {
  const call = {
    type: "toolCall",
    id: "private-id",
    name: "message_supervisor",
    arguments: { message: "MANAGER_HANDOFF_READY" },
  };
  const assistant = {
    type: "message",
    message: { role: "assistant", content: [call] },
  };
  const session = (...entries: unknown[]) =>
    entries.map((entry) => JSON.stringify(entry)).join("\n");
  const result = (isError: boolean) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "message_supervisor",
      toolCallId: "private-id",
      isError,
      content: "SECRET",
    },
  });
  assert.equal(
    supervisorMessageCallStatus("", "MANAGER_HANDOFF_READY"),
    "not_called",
  );
  assert.equal(
    supervisorMessageCallStatus(session(assistant), "MANAGER_HANDOFF_READY"),
    "pending",
  );
  assert.equal(
    supervisorMessageCallStatus(
      session(assistant, result(true)),
      "MANAGER_HANDOFF_READY",
    ),
    "error",
  );
  assert.equal(
    supervisorMessageCallStatus(
      session(assistant, result(false)),
      "MANAGER_HANDOFF_READY",
    ),
    "success",
  );
  assert.equal(managerAssignmentBranchMismatch(null, "expected-branch"), false);
  assert.equal(
    managerAssignmentBranchMismatch(
      { branch: "expected-branch" },
      "expected-branch",
    ),
    false,
  );
  assert.equal(
    managerAssignmentBranchMismatch(
      { branch: "unexpected-branch" },
      "expected-branch",
    ),
    true,
  );
  assert.equal(
    managerAssignmentDiagnostics({}).successfulCorrelatedDelegateProjectResult,
    "not_observed",
  );
  assert.equal(
    managerAssignmentDiagnostics({ result: "false" })
      .successfulCorrelatedDelegateProjectResult,
    "false",
  );
  assert.equal(
    managerAssignmentIdentity(
      {
        branch: "unexpected-branch",
        session: "private-session",
        workspace_id: "private-workspace",
      },
      { open_workspace_id: "private-workspace" },
      "expected-branch",
    ),
    "false",
  );
  const projection = managerAssignmentDiagnostics({
    worktree: "true",
    result: "true",
    identity: managerAssignmentIdentity(
      {
        branch: "unexpected-branch",
        session: "private-session",
        workspace_id: "private-workspace",
      },
      { open_workspace_id: "private-workspace" },
      "expected-branch",
    ),
    lead: "not_yet_evaluated",
    candidateProcessCount: 0,
    provenanceMatch: "not_evaluated",
    errorCategory: "none",
  });
  assert.equal(
    projection.assignmentIdentitySessionWorkspaceBranchMatch,
    "false",
  );
  assert.equal(projection.candidateProcessCount, 0);
  assert.equal(projection.candidateProcessProvenanceMatch, "not_evaluated");
  assert.equal(projection.matchedLead, "not_yet_evaluated");
  assert.equal(
    Object.hasOwn(
      managerAssignmentDiagnostics({
        supervisorUnstructuredErrorClass: "PRIVATE_UNLISTED_CLASS",
      }),
      "supervisorUnstructuredErrorClass",
    ),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(projection),
    /unexpected-branch|expected-branch/,
  );
});

test("manager handoff failure artifact preserves early-poll defaults and safe timing", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-parser-"));
  const diagnose = async (contents) => {
    const manager = SessionManager.create(process.cwd(), sessionDir);
    for (const line of contents.split(/\r?\n/u).filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.type === "message") manager.appendMessage(entry.message);
    }
    if (!manager.getLeafId())
      manager.appendMessage({ role: "user", content: "fixture" });
    return supervisorMessageDiagnostics(
      manager.getSessionFile(),
      manager.getSessionId(),
      "MANAGER_HANDOFF_READY",
    );
  };
  const contents = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "message_supervisor",
            id: "PRIVATE_CALL_ID",
            arguments: {
              message: "MANAGER_HANDOFF_READY",
              prompt: "PRIVATE_PROMPT",
            },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "message_supervisor",
        toolCallId: "PRIVATE_CALL_ID",
        isError: true,
        details: {
          error: {
            category: "internal_failure",
            branchStatus: "operation_error_returned",
            message: "PRIVATE_ERROR",
            cause: "PRIVATE_CAUSE",
          },
        },
        content: "PRIVATE_RESULT_BODY",
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const correlated = await diagnose(contents);
  assert.deepEqual(correlated, {
    supervisorSessionHeaderMatches: true,
    supervisorCallObserved: true,
    supervisorResultState: "error",
    supervisorErrorCategory: "internal_failure",
    supervisorHandlerBranchStatus: "operation_error_returned",
    supervisorPersistedErrorCategoryPresent: true,
    supervisorPersistedErrorCategory: "internal_failure",
  });
  assert.doesNotMatch(
    JSON.stringify(correlated),
    /PRIVATE_ERROR|PRIVATE_CAUSE/u,
  );
  const failedProgress = managerAssignmentDiagnostics({ ...correlated });
  assert.equal(
    failedProgress.supervisorHandlerBranchStatus,
    "operation_error_returned",
  );
  assert.equal(failedProgress.supervisorPersistedErrorCategoryPresent, true);
  assert.equal(
    failedProgress.supervisorPersistedErrorCategory,
    "internal_failure",
  );
  assert.throws(
    () => assertNoFailedManagerHandoff(failedProgress),
    (error) => {
      assert.equal(error.code, "SMOKE_SUPERVISOR_FAILED");
      assert.equal(error.message, "message_supervisor failed");
      assert.equal(error.smoke.stage, "manager-handoff-assignment");
      assert.deepEqual(error.smoke.lastProgress, failedProgress);
      const artifact = sanitizedFailureEvidence(
        { scenario: "manager-handoff", simulated: true },
        { error },
        "SCENARIO_FAIL",
        "PASS",
      );
      assert.equal(
        artifact.managerHandoffProgress.supervisorResultState,
        "error",
      );
      assert.equal(
        artifact.managerHandoffProgress.supervisorErrorCategory,
        "internal_failure",
      );
      assert.equal(
        artifact.managerHandoffProgress.supervisorHandlerBranchStatus,
        "operation_error_returned",
      );
      assert.equal(
        artifact.managerHandoffProgress.supervisorPersistedErrorCategoryPresent,
        true,
      );
      assert.equal(
        artifact.managerHandoffProgress.supervisorPersistedErrorCategory,
        "internal_failure",
      );
      assert.doesNotMatch(
        JSON.stringify(artifact),
        /PRIVATE_CALL_ID|PRIVATE_PROMPT|PRIVATE_ERROR|PRIVATE_CAUSE|PRIVATE_RESULT_BODY/u,
      );
      return true;
    },
  );
  for (const state of ["missing", "pending", "success"]) {
    assert.doesNotThrow(() =>
      assertNoFailedManagerHandoff(
        managerAssignmentDiagnostics({ supervisorResultState: state }),
      ),
    );
  }
  const unknownCategory = await diagnose(
    contents.replace('"internal_failure"', '"PRIVATE_UNLISTED_CATEGORY"'),
  );
  assert.equal(unknownCategory.supervisorErrorCategory, "tool_error");
  assert.equal(unknownCategory.supervisorPersistedErrorCategoryPresent, true);
  assert.equal(
    unknownCategory.supervisorPersistedErrorCategory,
    "not_observed",
  );
  assert.doesNotMatch(
    JSON.stringify(unknownCategory),
    /PRIVATE_ERROR|PRIVATE_UNLISTED/u,
  );
  const unsupportedBranchStatus = await diagnose(
    contents.replace(
      '"branchStatus":"operation_error_returned"',
      '"branchStatus":"non_operation_error_throw"',
    ),
    "MANAGER_HANDOFF_READY",
  );
  assert.equal(
    unsupportedBranchStatus.supervisorHandlerBranchStatus,
    "not_observed",
  );
  assert.equal(
    unsupportedBranchStatus.supervisorPersistedErrorCategoryPresent,
    true,
  );
  assert.equal(
    unsupportedBranchStatus.supervisorPersistedErrorCategory,
    "internal_failure",
  );
  assert.doesNotMatch(
    JSON.stringify(unsupportedBranchStatus),
    /PRIVATE_CALL_ID|PRIVATE_PROMPT|PRIVATE_ERROR|PRIVATE_CAUSE|PRIVATE_RESULT_BODY/u,
  );
  const mappedSupervisorError = await diagnose(
    contents.replace('"internal_failure"', '"invalid_request"'),
  );
  assert.equal(
    mappedSupervisorError.supervisorErrorCategory,
    "invalid_request",
  );
  assert.doesNotMatch(JSON.stringify(mappedSupervisorError), /PRIVATE_ERROR/u);
  const noCall = await diagnose("");
  assert.deepEqual(noCall, {
    supervisorSessionHeaderMatches: true,
    supervisorCallObserved: false,
    supervisorResultState: "missing",
    supervisorErrorCategory: "none",
    supervisorHandlerBranchStatus: "not_observed",
    supervisorPersistedErrorCategoryPresent: false,
    supervisorPersistedErrorCategory: "not_observed",
  });
  const successfulSupervisor = await diagnose(
    contents
      .replace('"isError":true', '"isError":false')
      .replace('"PRIVATE_RESULT_BODY"', '"sent"'),
    "MANAGER_HANDOFF_READY",
  );
  assert.deepEqual(successfulSupervisor, {
    supervisorSessionHeaderMatches: true,
    supervisorCallObserved: true,
    supervisorResultState: "success",
    supervisorErrorCategory: "none",
    supervisorHandlerBranchStatus: "not_observed",
    supervisorPersistedErrorCategoryPresent: false,
    supervisorPersistedErrorCategory: "not_observed",
  });
  await rm(sessionDir, { recursive: true, force: true });

  const earlyPoll = managerAssignmentDiagnostics({
    worktree: "true",
    result: "true",
    identity: "true",
    lead: "not_yet_evaluated",
    candidateProcessCount: 101,
    provenanceMatch: "false",
    supervisorCall: "not_yet_evaluated",
    supervisorSuccess: "not_yet_evaluated",
    readiness: "not_yet_evaluated",
  });
  assert.deepEqual(
    {
      supervisorCallObserved: earlyPoll.supervisorCallObserved,
      supervisorResultState: earlyPoll.supervisorResultState,
      supervisorErrorCategory: earlyPoll.supervisorErrorCategory,
      readinessDeliveryObserved: earlyPoll.readinessDeliveryObserved,
    },
    {
      supervisorCallObserved: false,
      supervisorResultState: "not_observed",
      supervisorErrorCategory: "none",
      readinessDeliveryObserved: false,
    },
  );
  const earlyEvidence = sanitizedFailureEvidence(
    { scenario: "manager-handoff", simulated: true },
    {
      error: {
        smoke: {
          stage: "manager-handoff-assignment",
          lastProgress: earlyPoll,
        },
      },
    },
    "SCENARIO_FAIL",
    "PASS",
  );
  assert.equal(
    earlyEvidence.managerHandoffProgress.supervisorCallObserved,
    false,
  );
  assert.equal(
    earlyEvidence.managerHandoffProgress.supervisorResultState,
    "not_observed",
  );
  assert.equal(
    earlyEvidence.managerHandoffProgress.supervisorErrorCategory,
    "none",
  );
  assert.equal(
    earlyEvidence.managerHandoffProgress.readinessDeliveryObserved,
    false,
  );
  assert.equal(
    earlyEvidence.managerHandoffProgress.fauxSupervisorToolAvailability,
    "not_observed",
  );
  const resolvedProgress = managerAssignmentDiagnostics({
    worktree: "true",
    result: "true",
    identity: "true",
    lead: "true",
    supervisorCall: "true",
    supervisorSuccess: "true",
    readiness: "true",
    fauxSupervisorToolAvailability: managerHandoffSupervisorToolAvailability(
      JSON.stringify({
        model: "manager-handoff-lead",
        supervisorToolAvailability: "not_offered",
        private: "PRIVATE_ATTEMPT",
      }),
    ),
    ...successfulSupervisor,
    supervisorUnstructuredErrorClass:
      unknownCategory.supervisorUnstructuredErrorClass,
    readinessDeliveryObserved: true,
    worktreeIdentityState: "verified",
    candidateProcessCount: 1,
    provenanceMatch: "true",
    errorCategory: "none",
    prompt: "PRIVATE_PROGRESS_PROMPT",
    args: "PRIVATE_ARGS",
  });
  const evidence = sanitizedFailureEvidence(
    {
      scenario: "manager-handoff",
      simulated: true,
      stage: "manager-handoff-assignment",
      prompt: "PRIVATE_CONTEXT_PROMPT",
      environment: { TOKEN: "PRIVATE_SECRET" },
    },
    {
      error: {
        code: "SMOKE_STALLED",
        smoke: {
          stage: "manager-handoff-assignment",
          elapsedMs: 120_000,
          inactiveMs: 120_000,
          lastProgress: {
            ...resolvedProgress,
            prompt: "PRIVATE_PROGRESS_PROMPT",
            args: "PRIVATE_ARGS",
            body: "PRIVATE_BODY",
            error: "PRIVATE_RAW_ERROR",
            supervisorRawError: "PRIVATE_SUPERVISOR_ERROR",
            transcript: contents,
          },
        },
      },
    },
    "SCENARIO_FAIL",
    "PASS",
  );
  const artifactPath = await preserveFailureEvidence(evidence);
  try {
    const persisted = await readFile(artifactPath, "utf8");
    assert.deepEqual(JSON.parse(persisted).managerHandoffProgress, {
      fauxSupervisorToolAvailability: "not_offered",
      expectedBranchWorktree: "true",
      successfulCorrelatedDelegateProjectResult: "true",
      assignmentIdentitySessionWorkspaceBranchMatch: "true",
      matchedLead: "true",
      candidateProcessCount: 1,
      candidateProcessProvenanceMatch: "true",
      supervisorCallObserved: true,
      supervisorResultState: "success",
      supervisorErrorCategory: "none",
      supervisorHandlerBranchStatus: "not_observed",
      supervisorPersistedErrorCategoryPresent: false,
      supervisorPersistedErrorCategory: "not_observed",
      supervisorUnstructuredErrorClass: "unstructured_error_unknown",
      readinessDeliveryObserved: true,
      worktreeIdentityState: "verified",
      errorCategory: "none",
      elapsedMs: 120_000,
      inactiveMs: 120_000,
    });
    assert.doesNotMatch(persisted, /PRIVATE/u);
    assert.doesNotMatch(persisted, /PRIVATE_CALL_ID|MANAGER_HANDOFF_READY/u);
  } finally {
    await rm(dirname(artifactPath), { recursive: true, force: true });
  }
});

test("manager readiness correlates one active-branch call with its following result", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-branch-"));
  try {
    const source = SessionManager.create(process.cwd(), sessionDir);
    const root = source.appendMessage({ role: "user", content: "root" });
    source.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "message_supervisor",
          id: "FOREIGN_CALL_ID",
          arguments: {
            message: "MANAGER_HANDOFF_READY",
            secret: "PRIVATE_ARGS",
          },
        },
      ],
    });
    source.appendMessage({
      role: "toolResult",
      toolName: "message_supervisor",
      toolCallId: "FOREIGN_CALL_ID",
      isError: false,
      content: "PRIVATE_SUCCESS_BODY",
    });
    source.branch(root);
    source.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "message_supervisor",
          id: "OLD_BRANCH_CALL_ID",
          arguments: { message: "OLDER_BRANCH_READINESS" },
        },
      ],
    });
    source.appendMessage({
      role: "toolResult",
      toolName: "message_supervisor",
      toolCallId: "OLD_BRANCH_CALL_ID",
      isError: false,
    });

    const fork = SessionManager.forkFrom(
      source.getSessionFile(),
      process.cwd(),
      sessionDir,
    );
    fork.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "message_supervisor",
          id: "LATEST_CALL_ID",
          arguments: {
            message: "MANAGER_HANDOFF_READY",
            secret: "LATEST_PRIVATE_ARGS",
          },
        },
      ],
    });
    fork.appendMessage({
      role: "toolResult",
      toolName: "message_supervisor",
      toolCallId: "LATEST_CALL_ID",
      isError: true,
      details: {
        error: {
          category: "UNLISTED_PRIVATE_CATEGORY",
          message: "PRIVATE_ERROR_TEXT",
        },
      },
      content: "PRIVATE_RESULT_BODY",
    });

    const diagnostics = supervisorMessageDiagnostics(
      fork.getSessionFile(),
      fork.getSessionId(),
      "MANAGER_HANDOFF_READY",
    );
    assert.deepEqual(diagnostics, {
      supervisorSessionHeaderMatches: true,
      supervisorCallObserved: true,
      supervisorResultState: "error",
      supervisorErrorCategory: "tool_error",
      supervisorHandlerBranchStatus: "not_observed",
      supervisorPersistedErrorCategoryPresent: true,
      supervisorPersistedErrorCategory: "not_observed",
      supervisorUnstructuredErrorClass: "unstructured_error_unknown",
    });
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /FOREIGN_CALL_ID|OLD_BRANCH_CALL_ID|LATEST_CALL_ID|PRIVATE_ARGS|PRIVATE_SUCCESS_BODY|UNLISTED_PRIVATE_CATEGORY|PRIVATE_ERROR_TEXT|PRIVATE_RESULT_BODY/u,
    );
    const mismatchedHeader = supervisorMessageDiagnostics(
      fork.getSessionFile(),
      "WRONG_EXPECTED_SESSION_ID",
      "MANAGER_HANDOFF_READY",
    );
    assert.equal(mismatchedHeader.supervisorSessionHeaderMatches, false);
    assert.equal(mismatchedHeader.supervisorCallObserved, false);
    assert.equal(mismatchedHeader.supervisorResultState, "not_observed");
    assert.doesNotMatch(
      JSON.stringify(mismatchedHeader),
      /WRONG_EXPECTED_SESSION_ID/u,
    );
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("manager readiness rejects preceding, duplicate, and ambiguous tool evidence", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-order-"));
  const call = (id: string) => ({
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        name: "message_supervisor",
        id,
        arguments: { message: "MANAGER_HANDOFF_READY" },
      },
    ],
  });
  const result = (id: string) => ({
    role: "toolResult" as const,
    toolName: "message_supervisor",
    toolCallId: id,
    isError: false,
  });
  const diagnose = async (messages: unknown[]) => {
    const session = SessionManager.create(process.cwd(), sessionDir);
    for (const message of messages) session.appendMessage(message as any);
    return supervisorMessageDiagnostics(
      session.getSessionFile(),
      session.getSessionId(),
      "MANAGER_HANDOFF_READY",
    );
  };
  try {
    const precedingResult = await diagnose([
      result("CALL_ID"),
      call("CALL_ID"),
    ]);
    assert.equal(precedingResult.supervisorCallObserved, true);
    assert.equal(precedingResult.supervisorResultState, "not_observed");

    const duplicateCalls = await diagnose([
      call("CALL_ID"),
      call("CALL_ID_2"),
      result("CALL_ID_2"),
    ]);
    assert.equal(duplicateCalls.supervisorCallObserved, false);
    assert.equal(duplicateCalls.supervisorResultState, "missing");

    const ambiguousCallId = await diagnose([
      call("CALL_ID"),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "message_supervisor",
            id: "CALL_ID",
            arguments: { message: "different message" },
          },
        ],
      },
      result("CALL_ID"),
    ]);
    assert.equal(ambiguousCallId.supervisorCallObserved, false);
    assert.equal(ambiguousCallId.supervisorResultState, "missing");

    const duplicateResults = await diagnose([
      call("CALL_ID"),
      result("CALL_ID"),
      result("CALL_ID"),
    ]);
    assert.equal(duplicateResults.supervisorCallObserved, true);
    assert.equal(duplicateResults.supervisorResultState, "not_observed");
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("Manager handoff cleanup owns the worktree before Lead readiness", async () => {
  const branch = "herdsman/smoke-manager-handoff-test";
  const ctx = { owned: { managerBranch: branch } };
  const worktree = {
    branch,
    path: "/smoke/manager-handoff",
    open_workspace_id: "workspace-2",
  };
  // A readiness timeout after creation still leaves cleanup exact ownership.
  assert.equal(
    captureManagerHandoffWorktree(ctx, [worktree], branch),
    worktree,
  );
  assert.equal(ctx.owned.managerWorktreePath, worktree.path);
  assert.equal(ctx.owned.managerWorkspaceId, worktree.open_workspace_id);
  assert.equal(
    managerCleanupTarget(
      [worktree],
      branch,
      ctx.owned.managerWorktreePath,
      ctx.owned.managerWorkspaceId,
    ),
    worktree,
  );
  assert.throws(
    () => captureManagerHandoffWorktree(ctx, [worktree], branch, "wrong"),
    /does not match exact worktree/,
  );
  const removals = [];
  const paths = { root: "/smoke", authLink: "/smoke/auth" };
  const cleanupCtx = {
    rootWorkspaceId: "root-workspace",
    managerRecovery: { branch },
    primaryCheckoutPath: "/smoke/project",
  };
  const result = await cleanup(paths, ctx.owned, cleanupCtx, {
    remove: async () => {},
    removeFile: async () => {
      const error = new Error("missing auth link");
      error.code = "ENOENT";
      throw error;
    },
    herdrCommand: async (args) => {
      if (args[0] === "worktree" && args[1] === "list")
        return { worktrees: [worktree] };
      if (args[0] === "worktree" && args[1] === "remove") removals.push(args);
      return {};
    },
    runCommand: async () => {
      const error = new Error("branch absent");
      error.code = 1;
      throw error;
    },
  });
  assert.equal(result, null);
  assert.deepEqual(removals, [
    ["worktree", "remove", "--workspace", "workspace-2"],
  ]);

  const unregistered = await cleanup(
    paths,
    { managerBranch: branch },
    cleanupCtx,
    {
      remove: async () => {},
      removeFile: async () => {
        const error = new Error("missing auth link");
        error.code = "ENOENT";
        throw error;
      },
      herdrCommand: async () => ({ worktrees: [worktree] }),
    },
  );
  assert.match(unregistered ?? "", /captured worktree path is unavailable/);
});

test("Manager handoff retries incomplete exact worktree identity and fails closed", async () => {
  const branch = "herdsman/smoke-manager-handoff-retry";
  const ctx = { owned: { managerBranch: branch } };
  const incomplete = { branch };
  const complete = {
    branch,
    path: "/smoke/manager-handoff-retry",
    open_workspace_id: "workspace-2",
  };
  let observations = 0;
  const identity = await waitForEvidence(
    ctx,
    "manager-handoff-assignment",
    async () => {
      const worktree = observations++ === 0 ? incomplete : complete;
      try {
        const captured = captureManagerHandoffWorktree(ctx, [worktree], branch);
        return {
          done: !!captured,
          value: captured,
          progress: managerAssignmentDiagnostics({
            worktree: "true",
            worktreeIdentityState: "verified",
          }),
        };
      } catch (error) {
        if (error.code !== "SMOKE_OBSERVATION") throw error;
        return {
          done: false,
          progress: managerAssignmentDiagnostics({
            worktreeIdentityState: "incomplete",
            errorCategory: "worktree_identity_incomplete",
          }),
        };
      }
    },
    { timeoutMs: 1000, stallMs: 500, pollMs: 1 },
  );
  assert.equal(observations, 2);
  assert.equal(identity, complete);
  assert.equal(ctx.owned.managerWorktreePath, complete.path);
  assert.equal(ctx.owned.managerWorkspaceId, complete.open_workspace_id);

  for (const incompleteIdentity of [
    { branch, path: null, open_workspace_id: "workspace-2" },
    { branch, path: "", open_workspace_id: "workspace-2" },
    { branch, path: complete.path, open_workspace_id: null },
    { branch, path: complete.path, open_workspace_id: "" },
  ]) {
    assert.throws(
      () =>
        captureManagerHandoffWorktree(
          { owned: { managerBranch: branch } },
          [incompleteIdentity],
          branch,
        ),
      (error) => error.code === "SMOKE_OBSERVATION",
    );
  }

  for (const malformed of [
    { branch, path: 42, open_workspace_id: "workspace-2" },
    { branch, path: "/smoke/malformed-path", open_workspace_id: {} },
  ]) {
    assert.throws(
      () =>
        captureManagerHandoffWorktree(
          { owned: { managerBranch: branch } },
          [malformed],
          branch,
        ),
      /identity is malformed/u,
    );
  }

  const persistent = { ...ctx, owned: { managerBranch: branch } };
  await assert.rejects(
    waitForEvidence(
      persistent,
      "manager-handoff-assignment",
      async () => {
        try {
          captureManagerHandoffWorktree(persistent, [incomplete], branch);
        } catch (error) {
          if (error.code !== "SMOKE_OBSERVATION") throw error;
          return {
            done: false,
            progress: managerAssignmentDiagnostics({
              worktreeIdentityState: "incomplete",
              errorCategory: "worktree_identity_incomplete",
            }),
          };
        }
        return { done: true };
      },
      { timeoutMs: 1000, stallMs: 15, pollMs: 1 },
    ),
    (error) => {
      assert.equal(error.code, "SMOKE_STALLED");
      assert.equal(
        error.smoke.lastProgress.worktreeIdentityState,
        "incomplete",
      );
      assert.equal(
        error.smoke.lastProgress.errorCategory,
        "worktree_identity_incomplete",
      );
      const artifact = sanitizedFailureEvidence(
        { scenario: "manager-handoff", simulated: true },
        { error },
        "SCENARIO_FAIL",
        "FAIL",
      );
      assert.equal(
        artifact.managerHandoffProgress.worktreeIdentityState,
        "incomplete",
      );
      assert.equal(
        artifact.managerHandoffProgress.errorCategory,
        "worktree_identity_incomplete",
      );
      assert.doesNotMatch(
        JSON.stringify(artifact),
        /smoke\/manager|workspace-2/u,
      );
      return true;
    },
  );
  assert.throws(
    () =>
      captureManagerHandoffWorktree(
        persistent,
        [incomplete, incomplete],
        branch,
      ),
    /one worktree/u,
  );
});

test("Manager handoff readiness waits for verified Lead process provenance", async () => {
  let observations = 0;
  let provenanceContents = '{"sessionId":"other-session"}\n';
  const foregroundProcesses = [{ pid: 42 }];
  const pid = await waitForEvidence(
    {},
    "manager-handoff-assignment",
    async () => {
      if (++observations === 2)
        provenanceContents =
          '{"sessionId":"lead-session","packageName":"@earendil-works/pi-coding-agent","piVersion":"1.2.3","model":"manager-handoff-lead","hasAgentDefinitions":true,"pid":42}\n';
      const proof = managerHandoffLeadProcessProof(
        provenanceContents,
        "lead-session",
        "pane-1",
        foregroundProcesses,
        "1.2.3",
      );
      return {
        done: managerHandoffAssignmentReady(true, true, proof),
        value: proof?.pid,
      };
    },
    { timeoutMs: 200, stallMs: 100, pollMs: 1 },
  );
  assert.equal(observations, 2);
  assert.equal(pid, 42);

  const validRow =
    '{"sessionId":"lead-session","packageName":"@earendil-works/pi-coding-agent","piVersion":"1.2.3","model":"manager-handoff-lead","hasAgentDefinitions":true,"pid":42}';
  for (const contents of [
    validRow.replace('"model":"manager-handoff-lead"', '"model":"wrong-model"'),
    `${validRow}\n${validRow}\n`,
  ])
    assert.throws(
      () =>
        managerHandoffLeadProcessProof(
          contents,
          "lead-session",
          "pane-1",
          foregroundProcesses,
          "1.2.3",
        ),
      { code: "SMOKE_EVIDENCE" },
    );

  observations = 0;
  await assert.rejects(
    waitForEvidence(
      {},
      "manager-handoff-assignment",
      async () => {
        observations++;
        return {
          done: managerHandoffAssignmentReady(true, true, null),
        };
      },
      { timeoutMs: 200, stallMs: 20, pollMs: 1 },
    ),
    (error) => {
      assert.equal(error.code, "SMOKE_STALLED");
      assert.equal(error.smoke.stage, "manager-handoff-assignment");
      assert.ok(observations > 1);
      return true;
    },
  );
});

test("Agent failure observation resolves the managed Pi session identity", async () => {
  const child = {
    agent_session: { kind: "id", value: "herdr-agent-id" },
    pane_id: "w1:p2",
  };
  const resolveSessionId = async (_ctx, agent) =>
    agent.agent_session?.value === "herdr-agent-id" ? "child-session" : null;
  assert.deepEqual(
    await agentsForPiSession({}, [child], "child-session", resolveSessionId),
    [child],
  );
  assert.deepEqual(
    await agentsForPiSession({}, [child], "herdr-agent-id", resolveSessionId),
    [],
  );
  assert.deepEqual(
    await agentsForPiSession(
      {},
      [child, { ...child, pane_id: "w1:p3" }],
      "child-session",
      resolveSessionId,
    ),
    [child, { ...child, pane_id: "w1:p3" }],
  );
});

test("manager-recovery timeout is bounded and scoped to its ready handshake", () => {
  assert.deepEqual(
    parseSmokeArgs([
      "manager-recovery",
      "--manager-ready-timeout-ms",
      "45000",
      "--manager-recovery-diagnostics",
    ]),
    {
      scenario: "manager-recovery",
      model: undefined,
      simulated: false,
      managerReadyTimeoutMs: 45_000,
      managerRecoveryDiagnostics: true,
      managerExternalRemoval: false,
      managerRemovalAcceptance: false,
    },
  );
  for (const timeout of ["0", "-1", "1.5", "600001", "many"])
    assert.throws(
      () =>
        parseSmokeArgs([
          "manager-recovery",
          `--manager-ready-timeout-ms=${timeout}`,
        ]),
      /positive integer no greater than 600000/,
    );
  assert.throws(
    () => parseSmokeArgs(["core", "--manager-ready-timeout-ms", "45000"]),
    /only valid for manager-recovery/,
  );
  assert.throws(
    () => parseSmokeArgs(["core", "--manager-recovery-diagnostics"]),
    /only valid for manager-recovery/,
  );
  assert.equal(
    parseSmokeArgs(["manager-recovery", "--manager-removal-acceptance"])
      .managerRemovalAcceptance,
    true,
  );
  assert.throws(
    () => parseSmokeArgs(["core", "--manager-removal-acceptance"]),
    /only valid for manager-recovery/,
  );
});

test("simulated Manager decision only delegates the exact requested project work", () => {
  const answer = decide("terminal-failure", {
    messages: [
      {
        role: "user",
        content:
          'Use delegate_work exactly once. Set branch to exactly herdsman/smoke-test, task to exactly "Wait for the report.", and omit base and files.',
      },
    ],
  });
  assert.equal(answer.stopReason, "toolUse");
  assert.equal(answer.content[0].name, "delegate_work");
  assert.deepEqual(answer.content[0].arguments, {
    branch: "herdsman/smoke-test",
    task: "Wait for the report.",
  });
  assert.throws(
    () =>
      decide("terminal-failure", {
        messages: [
          {
            role: "user",
            content: "Remove worktree herdsman/branch",
          },
        ],
      }),
    /Unexpected terminal-failure transcript/,
  );
});

test("federation Manager starts its branch after an earlier completed managed assignment", () => {
  const origin = "manager:0123456789";
  const branch = "herdsman/federation-smoke-01234567";
  const messages = [
    {
      role: "user",
      content: `Peer message from ${origin}: PEER_E2E_REQUEST; Forwardable received files:\nspec: manager-spec.md\nresult: result:abc#1`,
    },
    { role: "user", content: `Peer message from ${origin}: PEER_E2E_REQUEST` },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "managed-call",
          name: "delegate_work",
          arguments: { branch: "herdsman/peer-smoke-managed" },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "delegate_work",
      toolCallId: "managed-call",
      content: [{ type: "text", text: "Session: managed-session" }],
    },
  ];

  const answer = decide("federated-peer-b", { messages });

  assert.equal(answer.stopReason, "toolUse");
  assert.equal(answer.content[0].name, "delegate_work");
  assert.equal(answer.content[0].arguments.branch, branch);
});

test("federation Lead correlates discovery and sends only within the current turn", () => {
  const history = [
    { role: "user", content: "previous request" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "old-list", name: "list_peers", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolName: "list_peers",
      toolCallId: "old-list",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            peers: [{ target: "old-target", machine: "old" }],
          }),
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "old-send",
          name: "message_peer",
          arguments: {},
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "message_peer",
      toolCallId: "old-send",
      content: "sent",
    },
  ];
  const discover = (content: string) =>
    decide("federated-peer-a", {
      messages: [...history, { role: "user", content }],
    });

  assert.equal(discover("PEER_E2E_A_DISCOVER").content[0].name, "list_peers");
  assert.equal(
    discover("PEER_E2E_A_LEAD_SEND result:researcher#1").content[0].name,
    "list_peers",
  );

  const listed = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "fresh-list", name: "list_peers", arguments: {} },
    ],
  };
  const listedResult = {
    role: "toolResult",
    toolName: "list_peers",
    toolCallId: "fresh-list",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          peers: [{ target: "new-target", machine: "new" }],
        }),
      },
    ],
  };
  const send = decide("federated-peer-a", {
    messages: [
      ...history,
      { role: "user", content: "PEER_E2E_A_LEAD_SEND result:researcher#1" },
      listed,
      listedResult,
    ],
  });
  assert.equal(send.content[0].name, "message_peer");
  assert.equal(send.content[0].arguments.target, "new-target");
});

test("federation Lead handles inbound request after its capture prompt and imported binding", () => {
  const origin = "lead:0123456789";
  const canonical = "result:abcdefab-cdef-abcd-efab-cdefabcdefab";
  const messages = [
    { role: "user", content: "PEER_E2E_B_CAPTURE_SESSION" },
    {
      type: "custom_message",
      customType: "pi-herdsman-peer_message",
      content: `Peer message from ${origin}: PEER_E2E_LEAD_REQUEST; result:researcher#1\n\nForwardable received files:\nartifact: ${canonical}`,
    },
    {
      type: "custom",
      customType: "pi-herdsman-result-ref",
      data: { ref: "result:researcher#1", canonicalRef: canonical },
    },
  ];

  const answer = decide("federated-peer-b", { messages });

  assert.equal(answer.stopReason, "toolUse");
  assert.equal(answer.content[0].name, "read");
  assert.equal(
    answer.content[0].arguments.path,
    join(
      process.env.PI_CODING_AGENT_DIR!,
      "pi-herdsman",
      "results",
      canonical.slice("result:".length),
    ),
  );

  const providerProjection = messages.filter(
    (message) =>
      message.type !== "custom" ||
      message.customType !== "pi-herdsman-result-ref",
  );
  const contextBindingAnswer = decide("federated-peer-b", {
    messages: providerProjection,
    peerImportedBindingVisible: true,
  });
  assert.equal(contextBindingAnswer.content[0].name, "read");
  assert.equal(
    contextBindingAnswer.content[0].arguments.path,
    join(
      process.env.PI_CODING_AGENT_DIR!,
      "pi-herdsman",
      "results",
      canonical.slice("result:".length),
    ),
  );
});

test("core and continuation faux decisions wait for correlated delivered Agent results", () => {
  const call = (name: string, arguments_: object, id = "call") => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: arguments_ }],
  });
  const result = (name: string, id = "call", details = {}) => ({
    role: "toolResult",
    toolName: name,
    toolCallId: id,
    isError: false,
    details,
    content: [{ type: "text", text: "started" }],
  });
  const delivered = (
    label: string,
    session = "child-session",
    body = '{"name":"pi-herdsman","version":"0.25.1"}',
    resultRef = "result:fixture#1",
  ) => ({
    role: "user",
    content: `Agent result · agent=${label} · definition=implementer · session=${session} · status=completed\n\nResult ref: ${resultRef}\n\n${body}\n\nDelegation status: 0 active direct agents; 0 pending direct results; all direct assignments are resolved.`,
  });
  const rootPrompt =
    "Do not read package.json yourself. Delegate and return PI_HERDSMAN_SMOKE_OK pi-herdsman@0.25.1.";
  const rootStarted = [
    {
      role: "system",
      content: "You are a helpful assistant.",
      sections: {
        pi_herdsman_role:
          "<pi_herdsman_role>\n## Lead role\n</pi_herdsman_role>",
      },
      timestamp: Date.now(),
    },
    { role: "user", content: rootPrompt },
    call("delegate_agent", {
      definition: "implementer",
      label: "smoke-core-implementer",
    }),
    result("delegate_agent"),
  ];
  const pendingRoot = decide("core", { messages: rootStarted });
  assert.doesNotMatch(pendingRoot.content[0].text, /PI_HERDSMAN_SMOKE_OK/);
  const managerRoleRoot = rootStarted.map((message, index) =>
    index === 0
      ? {
          ...message,
          sections: {
            pi_herdsman_role:
              "<pi_herdsman_role>\n## Manager role\n</pi_herdsman_role>",
          },
        }
      : message,
  );
  assert.throws(
    () =>
      decide("core", {
        messages: [...managerRoleRoot, delivered("smoke-core-implementer")],
      }),
    /Lead role context missing or incorrect after Agent result/,
  );
  const scoutRef = "result:smoke-core-scout#1";
  const implementerDelivery = delivered(
    "smoke-core-implementer",
    "implementer-session",
    `Forwardable result evidence: ${scoutRef}\n\n{"name":"pi-herdsman","version":"0.25.1"}`,
  );
  const nextAssignment = decide("core", {
    messages: [...rootStarted, implementerDelivery],
  }).content[0];
  assert.equal(nextAssignment.name, "delegate_agent");
  assert.deepEqual(nextAssignment.arguments.files, [scoutRef]);
  const nextTask = {
    role: "user",
    content: `<file name="${scoutRef}" bytes="49">\n{"name":"pi-herdsman","version":"0.25.1"}\n</file>\n\nTask:\nSMOKE_CORE_NEXT_AGENT: verify ${scoutRef}`,
  };
  assert.deepEqual(
    JSON.parse(decide("core", { messages: [nextTask] }).content[0].text),
    { name: "pi-herdsman", version: "0.25.1" },
  );
  const rootAfterNext = [
    ...rootStarted,
    implementerDelivery,
    call("delegate_agent", nextAssignment.arguments, "next-1"),
    result("delegate_agent", "next-1"),
    delivered("smoke-core-next", "next-session"),
  ];
  assert.equal(
    decide("core", { messages: rootAfterNext }).content[0].text,
    "PI_HERDSMAN_SMOKE_OK pi-herdsman@0.25.1",
  );

  const scoutTask = {
    role: "user",
    content: "SMOKE_CORE_SCOUT: read package.json",
  };
  const scoutRead = [
    scoutTask,
    call("read", { path: "package.json" }, "read-1"),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-1",
      isError: false,
      content: [
        { type: "text", text: '{"name":"pi-herdsman","version":"0.25.1"}' },
      ],
    },
  ];
  assert.deepEqual(
    JSON.parse(decide("core", { messages: scoutRead }).content[0].text),
    { name: "pi-herdsman", version: "0.25.1" },
  );
  const nestedPackage = [
    { role: "user", content: "SMOKE_CORE_IMPLEMENTER: delegate one scout." },
    call(
      "delegate_agent",
      { definition: "scout", label: "smoke-core-scout" },
      "scout-1",
    ),
    result("delegate_agent", "scout-1"),
    delivered(
      "smoke-core-scout",
      "scout-session",
      '{"name":"pi-herdsman","version":"0.25.1","repository":{"type":"git"}}',
      scoutRef,
    ),
  ];
  const attachCall = decide("core", { messages: nestedPackage }).content[0];
  assert.equal(attachCall.name, "attach_handoff");
  assert.deepEqual(attachCall.arguments, { files: [scoutRef] });
  assert.deepEqual(
    JSON.parse(
      decide("core", {
        messages: [
          ...nestedPackage,
          call("attach_handoff", attachCall.arguments, "attach-1"),
          result("attach_handoff", "attach-1"),
        ],
      }).content[0].text,
    ),
    { name: "pi-herdsman", version: "0.25.1" },
  );
  assert.throws(
    () =>
      decide("core", {
        messages: [
          scoutTask,
          call("read", { path: "other.json" }, "wrong"),
          { ...scoutRead[2], toolCallId: "wrong" },
        ],
      }),
    /Package read result missing|Unexpected core transcript/,
  );

  const continuationPrompt =
    "Delegate exactly one bounded task to an implementer: read package.json, remember its exact package name, and return only CONTINUATION_FIRST_DONE.";
  const continuationStarted = [
    { role: "user", content: continuationPrompt },
    call("delegate_agent", {
      definition: "implementer",
      label: "smoke-continuation-implementer",
    }),
    result("delegate_agent"),
  ];
  assert.doesNotMatch(
    decide("continuation", { messages: continuationStarted }).content[0].text,
    /PI_HERDSMAN_CONTINUATION_FIRST/,
  );
  assert.equal(
    decide("continuation", {
      messages: [
        ...continuationStarted,
        delivered(
          "smoke-continuation-implementer",
          "child-session",
          "pi-herdsman CONTINUATION_FIRST_DONE",
        ),
      ],
    }).content[0].text,
    "PI_HERDSMAN_CONTINUATION_FIRST",
  );

  const savedPath = "/isolated/pi-sessions/saved.jsonl";
  const followup = `Continue the exact saved Pi session at ${savedPath}. This is the same implementer you delegated previously.`;
  const firstHandoff = delivered(
    "smoke-continuation-implementer",
    "saved-id",
    "pi-herdsman CONTINUATION_FIRST_DONE",
  );
  const beforeContinue = [
    ...continuationStarted,
    firstHandoff,
    { role: "user", content: followup },
  ];
  const continueCall = decide("continuation", { messages: beforeContinue });
  assert.equal(continueCall.content[0].name, "continue_agent");
  assert.equal(continueCall.content[0].arguments.session, savedPath);
  const continued = [
    ...beforeContinue,
    call("continue_agent", continueCall.content[0].arguments, "continue-1"),
    result("continue_agent", "continue-1", { session_id: "saved-id" }),
    delivered(
      "smoke-continuation-implementer",
      "saved-id",
      "pi-herdsman PI_HERDSMAN_CONTINUATION_SECOND",
    ),
  ];
  assert.equal(
    decide("continuation", { messages: continued }).content[0].text,
    "pi-herdsman PI_HERDSMAN_CONTINUATION_SECOND",
  );
  assert.doesNotMatch(
    decide("continuation", {
      messages: [
        ...continued,
        { role: "user", content: "delegation guidance" },
      ],
    }).content[0].text,
    /PI_HERDSMAN_CONTINUATION_SECOND/,
  );

  const resumed = [
    {
      role: "user",
      content: "SMOKE_CONTINUATION_SECOND: do not reread package.json.",
    },
    call("read", { path: "package.json" }, "read-1"),
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-1",
      isError: false,
      content: [
        { type: "text", text: '{"name":"pi-herdsman","version":"0.25.1"}' },
      ],
    },
  ];
  assert.equal(
    decide("continuation", { messages: resumed }).content[0].text,
    "pi-herdsman PI_HERDSMAN_CONTINUATION_SECOND",
  );
});

test("installed faux provider requeues decisions and emits its terminal failure through native error events", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-herdsman-faux-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousAgentDefinition = process.env.PI_HERDSMAN_AGENT_DEFINITION;
  const previousEntryPoint = process.argv[1];
  const evidenceDir = join(agentDir, "pi-herdsman", "runtime");
  await mkdir(evidenceDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
  process.argv[1] = resolve(
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  try {
    let provider;
    const handlers = new Map();
    installFaux({
      registerProvider(value) {
        provider = value;
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });
    handlers.get("session_start")?.(
      {},
      {
        sessionManager: { getSessionId: () => "faux-test-session" },
      },
    );
    const model = (id: string) =>
      provider.getModels().find((item: any) => item.id === id);
    const context = (
      prompt: string,
      sections = {},
      systemPrompt = "You are an ordinary Lead for this Pi session.",
    ) => ({
      messages: [
        {
          role: "system",
          content: systemPrompt,
          sections,
          timestamp: Date.now(),
        },
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
    });
    const collect = async (stream: AsyncIterable<any>) => {
      const events = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    const first = await collect(
      provider.streamSimple(
        model("chief-tree"),
        context("Reply exactly PI_HERDSMAN_CHIEF_TREE_STARTUP."),
      ),
    );
    const second = await collect(
      provider.streamSimple(
        model("chief-tree"),
        context("Reply exactly PI_HERDSMAN_CHIEF_TREE_FOLLOWUP."),
      ),
    );
    const chief = await collect(
      provider.streamSimple(
        model("chief-tree"),
        context(
          "Reply exactly PI_HERDSMAN_CHIEF_TREE_POST_CHIEF.",
          {},
          "You are the verified workspace-neutral Chief for this Pi session.",
        ),
      ),
    );
    assert.ok(first.some((event: any) => event.type === "text_delta"));
    assert.ok(second.some((event: any) => event.type === "text_delta"));
    assert.ok(chief.some((event: any) => event.type === "text_delta"));
    const failure = await collect(
      provider.streamSimple(
        model("terminal-error"),
        context("wait", {
          agent_definitions:
            "<agent_definitions>[]\n\nThis is the session-start definition snapshot. Use list_agents for live Agent state or to refresh Agent definitions after configuration changes.</agent_definitions>",
        }),
      ),
    );
    const error = failure.find((event: any) => event.type === "error");
    assert.equal(
      error?.error.errorMessage,
      "503 Service Unavailable (controlled smoke failure)",
    );
    assert.ok(
      failure
        .filter((event: any) => event.type === "text_delta")
        .map((event: any) => event.delta)
        .join("")
        .includes("CONTROLLED_PARTIAL_RESPONSE"),
    );
    assert.ok(
      error?.error.content.some(
        (part: any) =>
          part.type === "text" && part.text === "CONTROLLED_PARTIAL_RESPONSE",
      ),
    );
    assert.deepEqual(
      JSON.parse(
        (
          await readFile(join(evidenceDir, "smoke-faux-attempts.jsonl"), "utf8")
        ).trim(),
      ),
      {
        model: "terminal-error",
        hasRoster: true,
        sessionId: "faux-test-session",
      },
    );
    const provenance = (
      await readFile(join(evidenceDir, "smoke-faux-provenance.jsonl"), "utf8")
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const piPackage = JSON.parse(
      await readFile(
        resolve("node_modules/@earendil-works/pi-coding-agent/package.json"),
        "utf8",
      ),
    );
    assert.deepEqual(provenance, [
      {
        pid: process.pid,
        sessionId: "faux-test-session",
        packageName: "@earendil-works/pi-coding-agent",
        piVersion: piPackage.version,
        model: "chief-tree",
        hasAgentDefinitions: false,
        hasLeadIdentity: true,
        hasManagedLeadIdentity: false,
        hasManagerIdentity: false,
        hasChiefIdentity: false,
        hasRoleSection: false,
      },
    ]);
    handlers.get("session_start")?.(
      {},
      { sessionManager: { getSessionId: () => "faux-missing-role-section" } },
    );
    const missingRoleSection = await collect(
      provider.streamSimple(
        model("core"),
        context("Reply exactly CORE_SMOKE_READY.", {}, "Base system prompt."),
      ),
    );
    assert.equal(
      missingRoleSection.find((event: any) => event.type === "error")?.error
        .errorMessage,
      "Provider request omitted the Lead role contract",
    );
    handlers.get("session_start")?.(
      {},
      {
        sessionManager: {
          getSessionId: () => "faux-missing-manager-role-section",
        },
      },
    );
    const missingManagerRoleSection = await collect(
      provider.streamSimple(
        model("manager-handoff"),
        context(
          "Reply exactly MANAGER_HANDOFF_ROOT_READY.",
          {},
          "Base system prompt.",
        ),
      ),
    );
    assert.equal(
      missingManagerRoleSection.find((event: any) => event.type === "error")
        ?.error.errorMessage,
      "Provider request omitted the manager role section",
    );
    handlers.get("session_start")?.(
      {},
      {
        sessionManager: {
          getSessionId: () => "faux-missing-managed-lead-identity",
        },
      },
    );
    const missingManagedLeadIdentity = await collect(
      provider.streamSimple(
        model("manager-handoff-lead"),
        context(
          "Reply exactly MANAGER_HANDOFF_LEAD_READY.",
          {},
          "<pi_herdsman_role>\n## Managed Lead role\n</pi_herdsman_role>",
        ),
      ),
    );
    assert.equal(
      missingManagedLeadIdentity.find((event: any) => event.type === "error")
        ?.error.errorMessage,
      "Provider request omitted or contradicted the Managed Lead role contract",
    );
    assert.equal(handlers.has("agent_settled"), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousAgentDefinition === undefined)
      delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
    else process.env.PI_HERDSMAN_AGENT_DEFINITION = previousAgentDefinition;
    process.argv[1] = previousEntryPoint;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("manager diagnostics retain bounded pane evidence", () => {
  const prefix = "[pi-herdsman-manager-diagnostic] ";
  const events = [
    { event: "session_start_reached" },
    { event: "initial_inbox_drain_start" },
    {
      event: "project_assignment_authorization",
      outcome: "rejected",
      reason: "live_lead_mismatch",
    },
    {
      event: "project_assignment_send",
      outcome: "resolved",
      triggerTurn: true,
    },
    {
      event: "project_assignment_authorization",
      outcome: "authorized",
      reason: "matched",
    },
    {
      event: "project_assignment_send",
      outcome: "rejected",
      triggerTurn: false,
      payload: "secret",
    },
  ];
  const lines = managerDiagnosticLines(
    [
      "unrelated pane content containing a secret",
      ...events.map((event) => `${prefix}${JSON.stringify(event)}`),
    ].join("\n"),
  );
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => line.startsWith(prefix)));
  assert.doesNotMatch(lines.join("\n"), /secret/);
  assert.ok(lines.every((line) => line.length <= 512));
  assert.deepEqual(
    lines,
    events.map(
      (event) =>
        `${prefix}${JSON.stringify(event.event === "project_assignment_send" && event.outcome === "rejected" ? { event: event.event, outcome: event.outcome, triggerTurn: event.triggerTurn } : event)}`,
    ),
  );
});

test("manager drain checkpoints are allowlisted, deduplicated and bounded without private fields", () => {
  const prefix = "[pi-herdsman-manager-diagnostic] ";
  const events = [
    { event: "session_start_reached" },
    { event: "initial_inbox_drain_start" },
    ...["scope", "topology", "live_lead"].flatMap((stage) => [
      { event: `project_assignment_${stage}_start` },
      { event: `project_assignment_${stage}_complete` },
    ]),
    {
      event: "project_assignment_authorization",
      outcome: "authorized",
      reason: "matched",
    },
    {
      event: "project_assignment_send",
      outcome: "resolved",
      triggerTurn: true,
    },
    { event: "inbox_preflight", reason: "pass" },
    { event: "inbox_preflight_recheck", reason: "pass" },
    { event: "inbox_peer_presence", reason: "missing" },
    { event: "inbox_candidates", count: 1000 },
    { event: "inbox_drain_complete", count: 1, sessionStable: true },
    { event: "inbox_catch", category: "drain" },
  ];
  const encode = (event: object) => `${prefix}${JSON.stringify(event)}`;
  assert.deepEqual(
    managerDiagnosticLines(
      [
        encode({ event: "inbox_preflight", reason: "held" }),
        encode({ event: "inbox_preflight", reason: "pass" }),
      ].join("\n"),
    ),
    [
      encode({ event: "inbox_preflight", reason: "held" }),
      encode({ event: "inbox_preflight", reason: "pass" }),
    ],
  );
  const lines = managerDiagnosticLines(
    [
      `${prefix}{malformed`,
      ...[
        { event: "unknown", payload: "secret" },
        { event: "inbox_preflight", reason: "secret" },
        { event: "inbox_peer_presence", reason: "stale" },
        { event: "inbox_candidates", count: -1 },
        { event: "inbox_candidates", count: 1001 },
        { event: "inbox_candidates", count: 0.5 },
        { event: "inbox_candidates", count: "1" },
        { event: "inbox_drain_complete", count: 0, sessionStable: "secret" },
        { event: "inbox_catch", category: "secret" },
      ].map(encode),
      ...events.map((event) =>
        encode({
          ...event,
          sessionId: "secret",
          path: "secret",
          payload: "secret",
        }),
      ),
      ...Array.from({ length: 40 }, () =>
        encode({ event: "inbox_candidates", count: 0 }),
      ),
    ].join("\n"),
  );
  assert.deepEqual(
    lines,
    [...events.slice(1), { event: "inbox_candidates", count: 0 }].map(encode),
  );
  assert.equal(lines.length, 16);
  assert.doesNotMatch(lines.join("\n"), /secret|sessionId|payload|path/);
  assert.ok(lines.every((line) => line.length <= 512));
  assert.deepEqual(managerDiagnosticLines(undefined), []);

  for (const event of [
    { event: "inbox_preflight", reason: "held" },
    { event: "inbox_preflight_recheck", reason: "stale" },
    { event: "inbox_preflight_recheck", reason: "held" },
    { event: "inbox_peer_presence", reason: "pass" },
    { event: "inbox_candidates", count: 0 },
    { event: "inbox_drain_complete", count: 0, sessionStable: false },
    ...[
      "cleanup",
      "authorization",
      "send",
      "reconcile",
      "candidate_scan",
      "transaction",
    ].map((category) => ({ event: "inbox_catch", category })),
  ])
    assert.deepEqual(managerDiagnosticLines(encode(event)), [encode(event)]);
});

test("successful manager recovery projects opt-in Lead diagnostics without changing acceptance", async () => {
  const prefix = "[pi-herdsman-manager-diagnostic] ";
  const ctx = {
    managerRecoveryDiagnostics: true,
    managerRecovery: {
      stage: "lead-ready-handshake",
      sessionId: "lead-session",
    },
  };
  await captureManagerLeadDiagnostics(
    ctx,
    "lead-pane",
    async (context, paneId, source) => {
      assert.equal(context, ctx);
      assert.equal(paneId, "lead-pane");
      assert.equal(source, "recent-unwrapped");
      return [
        "private pane text",
        `${prefix}{"event":"session_start_reached","payload":"private"}`,
        `${prefix}{"event":"session_start_reached"}`,
        `${prefix}{"event":"inbox_preflight","reason":"pass"}`,
        `${prefix}{"event":"unknown","payload":"private"}`,
      ].join("\n");
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.managerRecovery)), {
    stage: "lead-ready-handshake",
    sessionId: "lead-session",
    leadDiagnostics: [
      `${prefix}{"event":"session_start_reached"}`,
      `${prefix}{"event":"inbox_preflight","reason":"pass"}`,
    ],
  });

  await captureManagerLeadDiagnostics(ctx, "lead-pane", async () => {
    throw new Error("pane unavailable");
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.managerRecovery)).leadDiagnostics,
    [],
  );
  const disabled = { managerRecoveryDiagnostics: false, managerRecovery: {} };
  await captureManagerLeadDiagnostics(disabled, "lead-pane", async () => {
    assert.fail("diagnostics must remain opt-in");
  });
  assert.deepEqual(disabled.managerRecovery, {});
});

test("smoke failure report separates stage from error details", () => {
  assert.equal(
    formatSmokeFailure(
      new TypeError("leave wait timed out"),
      "manager-leave-output-wait",
    ),
    "stage: manager-leave-output-wait\nerror: TypeError: leave wait timed out",
  );
  const stalled = Object.assign(new Error("control: no meaningful progress"), {
    code: "SMOKE_STALLED",
    smoke: {
      stage: "control",
      elapsedMs: 20,
      inactiveMs: 15,
      lastProgress: { count: 1 },
      lastEvidence: { pane: "p1" },
    },
  });
  assert.match(
    formatSmokeFailure(stalled, "fallback"),
    /kind: STALLED[\s\S]*last evidence: \{"pane":"p1"\}/,
  );
  const timeout = Object.assign(new Error("hard deadline"), {
    code: "SMOKE_TIMEOUT",
    smoke: { stage: "deadline", elapsedMs: 40, inactiveMs: 40 },
  });
  assert.match(formatSmokeFailure(timeout), /kind: TIMEOUT/);
});

test("evidence wait returns completion and distinguishes stalls from deadlines", async () => {
  const ctx = {};
  let calls = 0;
  assert.equal(
    await waitForEvidence(
      ctx,
      "quick",
      async () => ({
        done: ++calls === 2,
        value: "ok",
        progress: { count: calls },
      }),
      { timeoutMs: 1000, stallMs: 500, pollMs: 1 },
    ),
    "ok",
  );
  await assert.rejects(
    waitForEvidence(
      ctx,
      "stuck",
      async () => ({
        done: false,
        progress: { count: 1 },
        evidence: { pane: "p1" },
      }),
      { timeoutMs: 1000, stallMs: 15, pollMs: 2 },
    ),
    (error) =>
      error.code === "SMOKE_STALLED" &&
      error.smoke.stage === "stuck" &&
      error.smoke.lastEvidence.pane === "p1",
  );
  await assert.rejects(
    waitForEvidence(
      ctx,
      "deadline",
      async () => ({ done: false, progress: { count: 1 } }),
      { timeoutMs: 12, stallMs: 1000, pollMs: 2 },
    ),
    (error) => error.code === "SMOKE_TIMEOUT",
  );
  const invariant = new Error("invalid identity");
  await assert.rejects(
    waitForEvidence(
      ctx,
      "invalid",
      async () => {
        throw invariant;
      },
      { timeoutMs: 1000, stallMs: 500 },
    ),
    (error) => error === invariant,
  );
  await assert.rejects(
    waitForEvidence(
      ctx,
      "late-observation",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { done: true, value: "late" };
      },
      { timeoutMs: 5, stallMs: 100 },
    ),
    (error) => error.code === "SMOKE_TIMEOUT",
  );
});

test("continuation first-generation stalls if completed child retires before observation", async (t) => {
  const source = await readFile(
    new URL("../scripts/smoke.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function runContinuationSmoke(ctx) {");
  const end = source.indexOf(
    "\nasync function runManagerBootstrapSmoke(ctx) {",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const exactFunction = source.slice(start, end).trim();
  assert.equal(
    source.match(/async function runContinuationSmoke\(ctx\)/g)?.length,
    1,
  );
  assert.ok(exactFunction.endsWith("\n}"));
  assert.match(source, /const MODEL_STALL_MS = 120_000;/);

  const prompt =
    "Delegate exactly one bounded task to an implementer: read package.json and return CONTINUATION_FIRST_DONE.";
  const completedChild = {
    role: "assistant",
    stopReason: "stop",
    content: "pi-herdsman CONTINUATION_FIRST_DONE",
  };
  const call = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "fixture-call",
        name: "delegate_agent",
        arguments: {
          definition: "implementer",
          label: "smoke-continuation-implementer",
        },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolName: "delegate_agent",
    toolCallId: "fixture-call",
    isError: false,
    details: { ok: true },
    content: "started",
  };
  const delivered = {
    role: "user",
    content: `Agent result · agent=smoke-continuation-implementer · definition=implementer · session=fixture-child · status=completed\n\nResult ref: result:fixture#1\n\n${completedChild.content}\n\nDelegation status: 0 active direct agents; 0 pending direct results; all direct assignments are resolved.`,
  };
  const answer = decide("continuation", {
    messages: [{ role: "user", content: prompt }, call, result, delivered],
  });
  assert.equal(answer.content[0].text, "PI_HERDSMAN_CONTINUATION_FIRST");
  const root = {
    contents: [
      {
        type: "message",
        id: "prompt",
        message: { role: "user", content: prompt },
      },
      { type: "message", id: "call", parentId: "prompt", message: call },
      { type: "message", id: "result", parentId: "call", message: result },
      {
        type: "custom_message",
        id: "delivered",
        parentId: "result",
        customType: "pi-herdsman-agent-result",
        content: delivered.content,
      },
      { type: "message", id: "answer", parentId: "delivered", message: answer },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  };
  assert.equal(
    rootDelegationDiagnostics(root.contents).matchingResult,
    "success",
  );
  assert.ok(
    assistantResultForSession(root, prompt, "PI_HERDSMAN_CONTINUATION_FIRST"),
  );

  // Controlled schedule: completion, delivery, marker, and normal removal precede all polls.
  const order = [
    "child_completed",
    "result_delivered",
    "root_marker",
    "child_removed",
  ];
  let polls = 0;
  let rootReads = 0;
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const run = new Function(
    "readFile",
    "join",
    "waitForEvidence",
    "tryNestedCommand",
    "rootSessionSnapshot",
    "isolatedSessionDetails",
    "MODEL_STALL_MS",
    `return (${exactFunction});`,
  )(
    async () => '{"name":"pi-herdsman"}',
    join,
    waitForEvidence,
    async (_ctx, args) => {
      assert.deepEqual(args, ["agent", "list"]);
      order.push("empty_child_poll");
      if (++polls === 2) t.mock.timers.setTime(120_001);
      return { ok: true, value: { agents: [{ pane_id: "fixture-root" }] } };
    },
    async () => {
      rootReads++;
      return root;
    },
    async () =>
      assert.fail("retired child must not be read through a live Agent"),
    120_000,
  );
  await assert.rejects(
    run({ repoRoot: ".", rootPaneId: "fixture-root", initialPrompt: prompt }),
    (error) => {
      assert.equal(error.code, "SMOKE_STALLED");
      assert.equal(error.smoke.stage, "continuation-first-generation");
      assert.deepEqual(error.smoke.lastProgress, {
        childCount: 0,
        sessionId: null,
        sessionBytes: 0,
        candidatePids: [],
      });
      return true;
    },
  );
  assert.deepEqual(order, [
    "child_completed",
    "result_delivered",
    "root_marker",
    "child_removed",
    "empty_child_poll",
    "empty_child_poll",
  ]);
  assert.equal(rootReads, 0);
});

test("simulated continuation releases completion only after full live evidence", async () => {
  const { waitForContinuationObservation } =
    await import("../scripts/smoke-faux.mjs");
  assert.equal(typeof waitForContinuationObservation, "function");
  const directory = await mkdtemp(join(tmpdir(), "smoke-continuation-gate-"));
  const runtime = join(directory, "pi-herdsman", "runtime");
  await mkdir(runtime, { recursive: true });
  const controller = new AbortController();
  let completed = false;
  const completion = waitForContinuationObservation(
    runtime,
    controller.signal,
  ).then(() => {
    completed = true;
  });
  try {
    const source = await readFile(
      new URL("../scripts/smoke.mjs", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async function runContinuationSmoke(ctx) {");
    const end = source.indexOf(
      "\nasync function runManagerBootstrapSmoke(ctx) {",
      start,
    );
    assert.ok(start >= 0 && end > start);
    assert.equal(
      source.match(/async function runContinuationSmoke\(ctx\)/g)?.length,
      1,
    );
    const exactFunction = source.slice(start, end).trim();
    assert.ok(exactFunction.endsWith("\n}"));
    const stop = new Error("first stage checked");
    let inspection = 0;
    const run = new Function(
      "readFile",
      "join",
      "waitForEvidence",
      "tryNestedCommand",
      "isolatedSessionDetails",
      "candidateProcess",
      "writeFile",
      "MODEL_STALL_MS",
      `return (${exactFunction});`,
    )(
      async () => '{"name":"pi-herdsman"}',
      join,
      async (_ctx, stage, inspect) => {
        assert.equal(stage, "continuation-first-generation");
        for (inspection = 0; inspection < 3; inspection++) {
          const observed = await inspect();
          assert.equal(observed.done, inspection === 2);
          if (inspection < 2) {
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(completed, false);
          }
        }
        assert.ok(
          (await stat(join(runtime, "continuation-first-observed"))).isFile(),
        );
        await completion;
        assert.equal(completed, true);
        throw stop;
      },
      async (_ctx, args) => ({
        ok: true,
        value: args[0] === "agent" ? { agents: [{ pane_id: "child" }] } : {},
      }),
      async () =>
        inspection === 0 ? undefined : { id: "fixture", contents: "saved" },
      () => (inspection === 2 ? [{ pid: 123 }] : []),
      writeFile,
      120_000,
    );
    await assert.rejects(
      run({
        repoRoot: ".",
        simulated: true,
        paths: { piAgent: directory },
        rootPaneId: "root",
      }),
      (error) => error === stop,
    );
  } finally {
    controller.abort();
    await completion.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("continuation completion wait tears down on abort, timeout, and filesystem failure", async (t) => {
  const { waitForContinuationObservation } =
    await import("../scripts/smoke-faux.mjs");
  const directory = await mkdtemp(join(tmpdir(), "smoke-continuation-abort-"));
  try {
    const controller = new AbortController();
    const aborted = assert.rejects(
      waitForContinuationObservation(directory, controller.signal),
      { name: "AbortError" },
    );
    controller.abort();
    await aborted;
    await assert.rejects(
      waitForContinuationObservation(directory, controller.signal),
      { name: "AbortError" },
    );
    await assert.rejects(
      waitForContinuationObservation(join(directory, "absent")),
      { code: "ENOENT" },
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timedOut = assert.rejects(
      waitForContinuationObservation(directory),
      /live evidence was not acknowledged/,
    );
    t.mock.timers.tick(120_000);
    await timedOut;
    t.mock.timers.reset();
    await writeFile(
      join(directory, "continuation-first-observed"),
      "observed\n",
    );
    await waitForContinuationObservation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence progress changes reset inactivity, identical evidence and read errors do not", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let count = 0;
  const times = [0, 15, 20, 35];
  const value = await waitForEvidence(
    {},
    "progress",
    async () => {
      count++;
      t.mock.timers.setTime(times[count - 1]);
      return {
        done: count === 4,
        value: "done",
        progress: { step: count < 3 ? 1 : 2 },
      };
    },
    { timeoutMs: 100, stallMs: 20, pollMs: 1 },
  );
  assert.equal(value, "done");
  let identicalCall = 0;
  await assert.rejects(
    waitForEvidence(
      {},
      "identical",
      async () => {
        t.mock.timers.setTime([35, 45, 55][identicalCall++]);
        return { done: false, progress: { same: true } };
      },
      { timeoutMs: 100, stallMs: 20, pollMs: 1 },
    ),
    (error) => error.code === "SMOKE_STALLED",
  );
  let errorCall = 0;
  await assert.rejects(
    waitForEvidence(
      {},
      "observation-error",
      async () => {
        t.mock.timers.setTime([55, 65, 75][errorCall++]);
        return { done: false, observationError: "temporary read failure" };
      },
      { timeoutMs: 100, stallMs: 20, pollMs: 1 },
    ),
    (error) =>
      error.code === "SMOKE_STALLED" &&
      error.smoke.lastObservationError === "temporary read failure",
  );
});

test("Herdr API output requires the current JSON envelope", () => {
  assert.deepEqual(
    parseHerdrOutput('{"id":"1","result":{"panes":[]}}', ["pane", "list"]),
    { panes: [] },
  );
  assert.deepEqual(
    parseHerdrOutput('{"client":{},"server":{}}', ["status", "--json"]),
    { client: {}, server: {} },
  );
  for (const stdout of [
    'noise {"id":"1","result":{}}',
    '{"result":{}}',
    '{"id":"1"}',
    "no json",
  ])
    assert.throws(() => parseHerdrOutput(stdout, ["pane", "list"]), {
      code: "SMOKE_PROTOCOL",
    });
});

test("candidate start treats only a structured missing-pane error as impossible", () => {
  assert.equal(
    herdrErrorCode({ stderr: '{"error":{"code":"pane_not_found"}}' }),
    "pane_not_found",
  );
  assert.equal(herdrErrorCode({ stderr: "not json" }), undefined);
  assert.deepEqual(
    candidateStartObservationError({ ok: false, error: "timed out" }, "pane-1"),
    { done: false, observationError: "timed out" },
  );
  assert.throws(
    () =>
      candidateStartObservationError(
        {
          ok: false,
          error: "pane absent",
          herdrCode: "pane_not_found",
        },
        "pane-1",
      ),
    /candidate pane pane-1 disappeared/,
  );
});

test("smoke model override wins without reading Git config", async () => {
  assert.equal(
    await resolveSmokeModel(" provider/model:high ", async () => {
      throw new Error("Git config should not be read");
    }),
    "provider/model:high",
  );
  await assert.rejects(
    resolveSmokeModel("  ", async () => {
      throw new Error("Git config should not be read");
    }),
    /smoke --model must not be empty/,
  );
});

test("smoke model falls back to effective Git config", async () => {
  const model = await resolveSmokeModel(
    undefined,
    async (file, args, options) => {
      assert.equal(file, "git");
      assert.deepEqual(args, ["config", "--get", "pi-herdsman.smoke-model"]);
      assert.ok(options.cwd);
      return { stdout: "provider/model:xhigh\n", stderr: "", pid: 1 };
    },
  );
  assert.equal(model, "provider/model:xhigh");
});

test("smoke model requires configuration when no override exists", async () => {
  const missing = Object.assign(new Error("not found"), { code: 1 });
  await assert.rejects(
    resolveSmokeModel(undefined, async () => {
      throw missing;
    }),
    /git config --local pi-herdsman\.smoke-model/,
  );
});

test("simulated model selection never reads Git smoke configuration", async () => {
  const calls: string[] = [];
  assert.equal(
    await selectSmokeModel(
      { scenario: "chief-tree", simulated: true },
      async (...args: any[]) => {
        calls.push(args.join(" "));
        throw new Error("must not read Git configuration");
      },
    ),
    "smoke-faux/chief-tree",
  );
  assert.deepEqual(calls, []);
});

test("smoke model propagates Git failures", async () => {
  const failure = Object.assign(new Error("invalid Git config"), { code: 3 });
  await assert.rejects(
    resolveSmokeModel(undefined, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("smoke auth resolves credentials from the configured model", async () => {
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
    authLink: "/smoke/pi-agent/auth.json",
  };
  const calls = [];
  const mechanism = await preparePi(
    paths,
    "provider/model:high",
    async (file, args) => {
      calls.push([file, args]);
      return { stdout: "", stderr: "", pid: 1 };
    },
  );
  assert.equal(mechanism, "ambient");
  assert.deepEqual(calls, [
    ["pi", ["auth", "check", "--model", "provider/model:high", "--no-refresh"]],
  ]);
});

test("continuation installs the faux extension on the isolated implementer definition", async () => {
  const piAgent = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-agent-"));
  try {
    await prepareContinuationFaux(
      { piAgent },
      "/isolated/extensions/smoke-faux.mjs",
    );
    assert.match(
      await readFile(join(piAgent, "agents", "implementer.md"), "utf8"),
      /extensions: \["\/isolated\/extensions\/smoke-faux\.mjs"\]/,
    );
  } finally {
    await rm(piAgent, { recursive: true, force: true });
  }
});

test("chief-tree startup prompt creates one ordinary Lead branch for harness controls", () => {
  const prompt = initialPromptForScenario("chief-tree", {});
  assert.equal(prompt, "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.");
  assert.doesNotMatch(prompt, /\/chief|\/tree/i);
});

test("manager-recovery starts without a chat prompt", () => {
  assert.equal(initialPromptForScenario("manager-recovery", {}), undefined);
});

test("active-stop preflights startup and verifies interactive stop cleanup", async () => {
  assert.equal(parseSmokeArgs(["active-stop"]).scenario, "active-stop");
  assert.equal(
    initialPromptForScenario("active-stop", {}),
    "Reply exactly PI_HERDSMAN_ACTIVE_STOP_READY",
  );
  const source = await readFile(
    new URL("../scripts/smoke.mjs", import.meta.url),
    "utf8",
  );
  const manager = source.indexOf("async function runManagerRecoverySmoke");
  const active = source.indexOf("async function runActiveStopSmoke");
  const next = source.indexOf("async function runChiefTreeSmoke");
  assert.ok(
    manager >= 0 && manager < active && active < next,
    "active-stop must preserve manager continuation source-extraction boundary",
  );
  const body = source.slice(active, next);
  const markerIndex = (pattern) => body.search(pattern);
  const rootReady = markerIndex(/"active-stop-root-ready"/);
  const agentReady = markerIndex(/"active-stop-agent-ready"/);
  const agentReadiness = body.slice(
    agentReady,
    body.indexOf(
      "const { agent, session, mailbox, pid } = initial;",
      agentReady,
    ),
  );
  assert.match(
    agentReadiness,
    /mailbox\?\.state\.ownerSessionId === ownerId\s*&&\s*mailbox\.state\.activeRequestId/,
  );
  assert.match(agentReadiness, /mailbox\.state\.agentLabel === label/);
  assert.match(
    agentReadiness,
    /const \{ agent, session, mailbox \} = matches\[0\]/,
  );
  assert.match(agentReadiness, /"process-info",\s*"--pane",\s*agent\.pane_id/);
  assert.doesNotMatch(agentReadiness, /isolatedSessionDetails\(ctx, agent\)/);
  assert.match(
    agentReadiness,
    /listed: listed\.value\.agents\?\.length \?\? 0,\s*owned: owned\.length,\s*delegation: root \? rootDelegationDiagnostics\(root\.contents\) : null/,
  );
  const stopInput = markerIndex(
    /submitPaneCommand\(ctx,\s*ctx\.rootPaneId,\s*"\/agents stop"\)/,
  );
  const confirmation = markerIndex(/"active-stop-confirmation"/);
  const confirmEnter = markerIndex(
    /"pane",\s*"send-keys",\s*ctx\.rootPaneId,\s*"enter"/,
  );
  const beforeConfirmEnter = body.slice(0, confirmEnter);
  assert.ok(
    rootReady >= 0 && agentReady >= 0 && stopInput >= 0,
    "root readiness, Agent readiness, and stop input must all exist",
  );
  assert.ok(
    rootReady < stopInput,
    "root snapshot and candidate readiness must precede terminal input",
  );
  assert.match(body, /rootSessionSnapshot\(ctx\)/);
  assert.match(
    body,
    /const label = `stop-\$\{randomUUID\(\)\.slice\(0, 12\)\}`/,
  );
  assert.match(
    body,
    /assistantResultForSession\(\s*snapshot,\s*startupPrompt,\s*"PI_HERDSMAN_ACTIVE_STOP_READY"/,
  );
  assert.match(body, /terminalTail/);
  assert.match(
    body,
    /const processObservationError = sanitizeManagerBootstrapText\(\s*observed\.error,\s*ctx,?\s*\)\.slice\(0,\s*300\)/,
  );
  assert.match(body, /observationError: processObservationError/);
  assert.match(body, /candidateProcess: processObservationError/);
  assert.match(
    body,
    /sanitizeManagerBootstrapText\(error\.message,\s*ctx\)\.slice\(0,\s*300\)/,
  );
  assert.match(body, /candidateProcess:/);
  assert.match(
    body,
    /typeof\s+header\?\.id\s*!==\s*"string"\s*\|\|\s*!header\.id\.trim\(\)/,
  );
  assert.match(body, /"pane",\s*"process-info",\s*"--pane",\s*ctx\.rootPaneId/);
  assert.match(body, /matches\.length !== 1/);
  assert.match(
    body,
    /matches\.length\s*!==\s*1\s*\|\|\s*!Number\.isSafeInteger\(matches\[0\]\?\.pid\)\s*\|\|\s*matches\[0\]\.pid\s*<=\s*0/,
  );
  assert.match(body, /value: \{ snapshot, pid: matches\[0\]\.pid \}/);
  assert.match(
    body,
    /processes\.length\s*===\s*1\s*&&\s*Number\.isSafeInteger\(processes\[0\]\?\.pid\)\s*&&\s*processes\[0\]\.pid\s*>\s*0/,
  );
  assert.match(body, /pid: processes\[0\]\.pid/);
  assert.doesNotMatch(body, /smoke-faux-provenance\.jsonl|matchPiProvenance/);
  assert.ok(
    agentReady < stopInput,
    "active Agent readiness must precede stop input",
  );
  assert.ok(
    confirmation >= 0 && confirmEnter >= 0,
    "confirmation marker and confirmation Enter must both exist",
  );
  assert.ok(
    stopInput < confirmation && confirmation < confirmEnter,
    "stop input, confirmation evidence, and Enter must occur in order",
  );
  assert.match(
    beforeConfirmEnter,
    /normalized\.includes\("Stop all agents\?"\)/,
  );
  assert.match(beforeConfirmEnter, /normalized\.includes\("1 working"\)/);
  assert.match(beforeConfirmEnter, /\/discard\/i\.test\(normalized\)/);
  assert.match(beforeConfirmEnter, /selectedYes = \/\(\?:\^\|\\s\)→\\s\*Yes/);
  assert.match(beforeConfirmEnter, /done: exact && selectedYes/);
  assert.match(beforeConfirmEnter, /selectedYes,/);
  assert.match(body, /pi-herdsman-agent-closed-assignment/);
  assert.match(
    body,
    /continuationResultsForPrompt\(snapshot\.contents, followup, marker\)/,
  );
  assert.match(body, /activeStopContinuationEvidence\(/);
  assert.match(body, /const startupHistory = responseCompleted\s*\? undefined/);
  assert.match(body, /\.slice\(-4\)[\s\S]*?role: entry\.message\.role/);
  assert.match(body, /stopReason: entry\.message\.stopReason/);
  assert.match(
    body,
    /parentId: sanitizeManagerBootstrapText\(entry\.parentId, ctx\)/,
  );
  assert.match(
    body,
    /messageText\(entry\.message\.content\)[\s\S]*?\.slice\(-200\)/,
  );
  assert.match(body, /\.\.\.\(startupHistory && \{ startupHistory \}\)/);
  assert.match(body, /"pane",\s*"send-keys",\s*ctx\.rootPaneId,\s*"enter"/);
  assert.match(body, /process\.kill\(pid, 0\)/);
  assert.match(body, /error\?\.code !== "ESRCH"/);
  assert.match(body, /panePresent/);
  assert.ok(
    markerIndex(/"active-stop-pane-removed"/) <
      markerIndex(/process\.kill\(pid, 0\)/),
    "Agent pane absence must be established before checking the captured PID",
  );
  assert.doesNotMatch(body, /"process-info",\s*"--pane",\s*identity\.paneId/);
});

test("active-stop accepts fast completion only with exact durable identity", () => {
  const identity = {
    sessionId: "child",
    sessionPath: "/child.jsonl",
    ownerSessionId: "owner",
    label: "agent",
    definition: "worker",
    runId: "old-run",
    requestId: "old-request",
  };
  const prompt = "continue",
    task = "finish task",
    marker = "DONE";
  const entries: any[] = [
    {
      type: "message",
      id: "prompt",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "call",
      parentId: "prompt",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool",
            name: "continue_agent",
            arguments: { session: identity.sessionPath, task },
          },
        ],
      },
    },
    {
      type: "message",
      id: "result",
      parentId: "call",
      message: {
        role: "toolResult",
        toolName: "continue_agent",
        toolCallId: "tool",
        details: {
          ok: true,
          action: "continue",
          session_id: "child",
          session_path: "/child.jsonl",
          owner_session_id: "owner",
          agent: "agent",
          definition: "worker",
          request_id: "new-request",
        },
      },
    },
    {
      type: "custom_message",
      id: "receipt",
      parentId: "result",
      customType: "pi-herdsman-agent-result",
      content: "Agent result · agent=agent\n\nDONE",
      details: {
        requestId: "new-request",
        ownerSessionId: "owner",
        agentLabel: "agent",
        agentDefinition: "worker",
        piSessionId: "child",
        piSessionFile: "/child.jsonl",
        runId: "new-run",
        status: "completed",
        sessionRetired: false,
      },
    },
    {
      type: "message",
      id: "response",
      parentId: "receipt",
      message: { role: "assistant", stopReason: "stop", content: marker },
    },
  ];
  const child: any[] = [
    { type: "session", id: "child" },
    {
      type: "message",
      id: "earlier",
      message: { role: "user", content: "earlier" },
    },
    {
      type: "message",
      id: "leaf",
      parentId: "earlier",
      message: { role: "assistant", content: "stopped" },
    },
    {
      type: "message",
      id: "task",
      parentId: "leaf",
      message: { role: "user", content: task },
    },
  ];
  const encode = (value: unknown[]) =>
    value.map((entry) => JSON.stringify(entry)).join("\n");
  const boundary = encode(child.slice(0, 3)) + "\n";
  const check = (root = entries, saved = child, before = boundary) =>
    activeStopContinuationEvidence(
      encode(root),
      encode(saved),
      "response",
      prompt,
      marker,
      identity,
      before,
    );
  assert.deepEqual(check(), {
    sessionId: "child",
    runId: "new-run",
    requestId: "new-request",
  });
  for (const [retired, notice] of [
    [
      true,
      "Continuation unavailable: session retired after context pressure. If follow-up work remains, use delegate_agent with this result and relevant files.",
    ],
    [
      null,
      "Continuation policy unverified. Continue only from the original trusted project context, or delegate a fresh Agent.",
    ],
  ] as const) {
    const valid = structuredClone(entries);
    valid[3].details.sessionRetired = retired;
    valid[3].content = `Agent result · agent=agent\n\n${notice}\n\nDONE`;
    assert.ok(check(valid));
  }
  const referenced = structuredClone(entries);
  referenced[2].message.details.request_id = referenced[3].details.requestId =
    "550e8400-e29b-41d4-a716-446655440000";
  referenced[3].details.resultRef = `result:${referenced[3].details.requestId}`;
  referenced[3].content =
    "Agent result · agent=agent\n\nResult ref: result:agent#1\n\nDONE";
  assert.ok(check(referenced));
  for (const [index, field, value] of [
    [2, "request_id", "old-request"],
    [2, "session_path", "/other"],
    [2, "owner_session_id", "other"],
    [2, "agent", "other"],
    [2, "definition", "other"],
    [3, "requestId", "other"],
    [3, "ownerSessionId", "other"],
    [3, "agentLabel", "other"],
    [3, "agentDefinition", "other"],
    [3, "piSessionId", "other"],
    [3, "piSessionFile", "/other"],
    [3, "runId", "old-run"],
    [3, "status", "failed"],
  ] as const) {
    const copy = structuredClone(entries);
    (index === 2 ? copy[index].message.details : copy[index].details)[field] =
      value;
    assert.equal(check(copy), null, field);
  }
  const missingMarker = structuredClone(entries);
  missingMarker[3].content = "no marker";
  assert.equal(check(missingMarker), null);
  const sibling = structuredClone(entries);
  sibling[4].parentId = "result";
  assert.equal(check(sibling), null);
  const wrapper = structuredClone(entries);
  wrapper[3].content = "Agent result · agent=DONE\n\nnot present";
  assert.equal(check(wrapper), null);
  const status = structuredClone(entries);
  status[3].content = "Agent result · agent=agent\n\nnot present\n\nDONE";
  status[3].details.delegationStatus = "DONE";
  assert.equal(check(status), null);
  const reference = structuredClone(entries);
  reference[3].content =
    "Agent result · agent=agent\n\nResult ref: DONE\n\nnot present";
  reference[3].details.resultRef = "result:request";
  assert.equal(check(reference), null);
  for (const value of [undefined, 0, "false", {}, []]) {
    const malformed = structuredClone(entries);
    malformed[3].details.sessionRetired = value;
    malformed[3].content = "Agent result · agent=agent\n\nDONE\n\nnot present";
    assert.equal(check(malformed), null);
  }
  for (const value of [null, false, "", 0, {}, "result:request"]) {
    const malformed = structuredClone(entries);
    malformed[3].details.resultRef = value;
    malformed[3].content =
      "Agent result · agent=agent\n\nResult ref: DONE\n\nnot present";
    assert.equal(check(malformed), null);
  }
  const branched = structuredClone(child);
  branched[3].parentId = "earlier";
  assert.equal(check(entries, branched), null);
  assert.equal(check(entries, child, encode(child)), null);
  const abandonedTask = [
    ...child,
    {
      type: "message",
      id: "other",
      message: { role: "assistant", content: "other" },
    },
  ];
  assert.equal(check(entries, abandonedTask), null);
  const wrongSession = structuredClone(child);
  wrongSession[0].id = "other";
  assert.equal(check(entries, wrongSession), null);
  const wrongTask = structuredClone(child);
  wrongTask[3].message.content = "other";
  assert.equal(check(entries, wrongTask), null);
});

test("terminal-failure evidence remains actionable and Manager uses only delegate_work", () => {
  const entries = [
    {
      type: "custom_message",
      customType: "pi-herdsman-project_message",
      content: "Lead model execution failed before completion.",
      details: { branch: "branch", fromSessionId: "session", id: "failure" },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(terminalFailureEvidence(entries, "branch", "session"), {
    executionFailures: 1,
    logicalReports: 1,
    actionable: true,
    successHandoff: false,
    toolCalls: 0,
    toolNames: [],
  });
});

test("Pi provenance requires the exact pinned version and reports the observed version", () => {
  const record = {
    pid: 42,
    sessionId: "session",
    packageName: "@earendil-works/pi-coding-agent",
    piVersion: "1.4.0",
    model: "terminal-error",
    hasAgentDefinitions: true,
  };
  const processes = [{ pid: 42 }];
  assert.deepEqual(
    matchPiProvenance(
      [record],
      "session",
      "lead-pane",
      processes,
      "terminal-error",
      true,
      "1.4.0",
    ),
    {
      paneId: "lead-pane",
      pid: 42,
      sessionId: "session",
      piVersion: "1.4.0",
    },
  );
  assert.throws(
    () =>
      matchPiProvenance(
        [record],
        "session",
        "lead-pane",
        [{ pid: 43 }],
        "terminal-error",
        true,
        "1.4.0",
      ),
    (error: Error & { code?: string }) =>
      error.message.includes("foreground PID match") &&
      error.code === "SMOKE_EVIDENCE",
  );
  assert.throws(
    () =>
      matchPiProvenance(
        [record],
        "other-session",
        "lead-pane",
        processes,
        "terminal-error",
        true,
        "1.4.0",
      ),
    /provenance row/,
  );
  for (const [observedVersion, accepted] of [
    ["1.3.9", false],
    ["1.4.0", true],
    ["1.4.1", false],
    ["1.5.0", false],
  ] as const) {
    const attempt = () =>
      matchPiProvenance(
        [{ ...record, piVersion: observedVersion }],
        "session",
        "lead-pane",
        processes,
        "terminal-error",
        true,
        "1.4.0",
      );
    if (!accepted) assert.throws(attempt, /1\.4\.0/);
    else assert.equal(attempt().piVersion, observedVersion);
  }
  assert.throws(
    () =>
      matchPiProvenance(
        [record, record],
        "session",
        "lead-pane",
        processes,
        "terminal-error",
        true,
        "1.4.0",
      ),
    /expected one provenance row/,
  );
});

test("missing provenance row is classified as evidence failure", () => {
  assert.throws(
    () => matchPiProvenance([], "session", "pane", [], "core", true, "1.2.0"),
    (error: Error & { code?: string }) => error.code === "SMOKE_EVIDENCE",
  );
  assert.throws(
    () => requireSmokeEvidence(false, "missing persisted role evidence"),
    (error: Error & { code?: string }) => error.code === "SMOKE_EVIDENCE",
  );
});

test("core observation waits for every persisted session PID or fails closed", async () => {
  const ctx = {
    assistantResult: true,
    rootProcess: { paneId: "root", pid: 101 },
    simulated: true,
    provenance: [
      {
        sessionId: "root",
        pid: 101,
        packageName: "@earendil-works/pi-coding-agent",
        piVersion: "1.4.0",
        model: "core",
        hasAgentDefinitions: true,
      },
      {
        sessionId: "child",
        pid: 202,
        packageName: "@earendil-works/pi-coding-agent",
        piVersion: "1.4.0",
        model: "core",
        hasAgentDefinitions: false,
      },
    ],
    sessionIds: new Set(["root", "child"]),
  };
  const ordinaryReadiness =
    ctx.assistantResult && 2 >= 2 && Boolean(ctx.rootProcess);
  assert.equal(ordinaryReadiness, true);
  assert.equal(
    coreObservationReady({
      ...ctx,
      paneCount: 2,
      observedPids: new Set([101, 111]),
    }),
    false,
  );
  assert.throws(
    () =>
      matchPiProvenance(
        ctx.provenance,
        "child",
        "child-pane",
        [{ pid: 111 }],
        "core",
        false,
        "1.4.0",
      ),
    /expected one foreground PID match/,
  );

  let observations = 0;
  const observedPids = await waitForEvidence(
    {},
    "core-delegation",
    async () => {
      observations++;
      const observedPids = new Set([101, 111]);
      if (observations > 1) observedPids.add(202);
      return {
        done: coreObservationReady({
          ...ctx,
          paneCount: 2,
          observedPids,
        }),
        value: observedPids,
        progress: { pids: [...observedPids].sort((a, b) => a - b) },
      };
    },
    { timeoutMs: 1000, stallMs: 500, pollMs: 1 },
  );
  assert.equal(observations, 2);
  assert.ok(observedPids.has(202));

  await assert.rejects(
    waitForEvidence(
      {},
      "core-delegation",
      async () => ({
        done: coreObservationReady({
          ...ctx,
          paneCount: 2,
          observedPids: new Set([101, 111]),
        }),
      }),
      { timeoutMs: 20, stallMs: 1000, pollMs: 1 },
    ),
    (error: Error & { code?: string; smoke?: { stage?: string } }) =>
      error.code === "SMOKE_TIMEOUT" &&
      error.smoke?.stage === "core-delegation",
  );
});

test("extra core provenance row fails without retaining verified evidence", async () => {
  const ctx = {
    scenario: "core",
    simulated: true,
    firstRequestObserved: true,
    firstRequestVerified: false,
  };
  assert.throws(
    () =>
      verifyCoreProvenanceEvidence(
        ctx,
        [{ sessionId: "root" }, { sessionId: "agent" }, { sessionId: "extra" }],
        new Set(["root", "agent"]),
      ),
    (error: Error & { code?: string }) => error.code === "SMOKE_EVIDENCE",
  );
  const artifact = await preserveFailureEvidence(
    sanitizedFailureEvidence(ctx, {}, "EVIDENCE_FAIL", "FAIL"),
  );
  assert.equal(
    JSON.parse(await readFile(artifact, "utf8")).firstRequestVerified,
    false,
  );
  await rm(dirname(artifact), { recursive: true, force: true });
});

test("required core tool-result gaps are evidence failures, not behavior failures", () => {
  for (const result of [undefined, { isError: true }]) {
    assert.throws(
      () =>
        requireSmokeEvidence(
          result && !result.isError,
          "missing successful correlated read result",
        ),
      (error: Error & { code?: string }) =>
        classifySmokeFailure("scenario", error) === "EVIDENCE_FAIL",
    );
  }
  assert.throws(
    () =>
      assertCoreToolEvidence(
        true,
        [{ name: "delegate_agent", result: "" }],
        "pkg@1",
      ),
    (error: Error & { code?: string }) =>
      classifySmokeFailure("scenario", error) === "EVIDENCE_FAIL",
  );
  assert.equal(
    classifySmokeFailure("scenario", new Error("behavior did not occur")),
    "SCENARIO_FAIL",
  );
});

test("core Pi provenance matches the core model and role-specific roster", () => {
  const root = {
    pid: 41,
    sessionId: "root",
    packageName: "@earendil-works/pi-coding-agent",
    piVersion: "1.2.0",
    model: "core",
    hasAgentDefinitions: true,
  };
  const child = {
    ...root,
    pid: 42,
    sessionId: "child",
    hasAgentDefinitions: true,
  };
  const leaf = {
    ...child,
    pid: 43,
    sessionId: "leaf",
    hasAgentDefinitions: false,
  };
  const expectations = coreAgentDefinitionsExpectations(
    [
      {
        id: "root",
        entries: [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "delegate_agent" }],
            },
          },
        ],
      },
      {
        id: "child",
        entries: [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "delegate_agent" }],
            },
          },
        ],
      },
      { id: "leaf", entries: [] },
    ],
    "root",
  );
  assert.deepEqual(
    [...expectations],
    [
      ["root", true],
      ["child", true],
      ["leaf", false],
    ],
  );
  assert.deepEqual(
    matchPiProvenance(
      [root],
      "root",
      "root-pane",
      [{ pid: 41 }],
      "core",
      expectations.get("root"),
      "1.2.0",
    ),
    { paneId: "root-pane", pid: 41, sessionId: "root", piVersion: "1.2.0" },
  );
  assert.deepEqual(
    matchPiProvenance(
      [child],
      "child",
      "agent-pane",
      [{ pid: 42 }],
      "core",
      expectations.get("child"),
      "1.2.0",
    ),
    { paneId: "agent-pane", pid: 42, sessionId: "child", piVersion: "1.2.0" },
  );
  assert.throws(
    () =>
      matchPiProvenance(
        [root],
        "root",
        "root-pane",
        [{ pid: 41 }],
        "terminal-error",
        expectations.get("root"),
        "1.2.0",
      ),
    /'core'/,
  );
  assert.throws(
    () =>
      matchPiProvenance(
        [leaf],
        "leaf",
        "leaf-pane",
        [{ pid: 43 }],
        "core",
        true,
        "1.2.0",
      ),
    /false !== true/,
  );
});

test("provenance uses retained foreground PID evidence when a pane later disappears", async () => {
  let observations = 0;
  const inspection = await inspectPaneProcesses(
    ["agent-pane"],
    "root-pane",
    async () => {
      observations++;
      return {
        process_info: {
          foreground_processes: [
            {
              pid: 52,
              argv: [
                "node",
                "--extension",
                "/candidate.js",
                "--extension",
                "/herdr.js",
              ],
            },
          ],
        },
      };
    },
    "/candidate.js",
    "/herdr.js",
  );
  const retained = inspection.verified.map(({ paneId, pid }) => ({
    paneId,
    processes: [{ pid }],
  }));
  const disappeared = await inspectPaneProcesses(
    ["agent-pane"],
    "root-pane",
    async () => {
      observations++;
      throw new Error("pane_not_found");
    },
    "/candidate.js",
    "/herdr.js",
  );
  assert.equal(observations, 2);
  assert.equal(disappeared.records[0].error, "pane_not_found");
  assert.deepEqual(
    matchPiProvenance(
      [
        {
          pid: 52,
          sessionId: "child",
          packageName: "@earendil-works/pi-coding-agent",
          piVersion: "1.2.0",
          model: "core",
          hasAgentDefinitions: false,
        },
      ],
      "child",
      retained[0].paneId,
      retained[0].processes,
      "core",
      false,
      "1.2.0",
    ).pid,
    52,
  );
});

test("descendant cleanup requires verified PIDs to be absent after pane closure", () => {
  const prior = new Map([[52, { paneId: "agent-pane", pid: 52 }]]);
  const disappeared = { verified: [], paneIds: [], unresolved: [] };
  assert.equal(
    descendantCleanupStatus(disappeared, prior, () => true).done,
    false,
    "a vanished pane cannot prove its still-live PID exited",
  );
  assert.equal(
    descendantCleanupStatus(disappeared, prior, () => false).done,
    true,
    "an OS-level absent PID resolves the retained observation",
  );
  assert.equal(
    descendantCleanupStatus(
      {
        ...disappeared,
        paneIds: ["agent-pane"],
        unresolved: [{ paneId: "agent-pane" }],
      },
      new Map(),
      () => false,
    ).done,
    false,
    "an unresolved pane still listed by Herdr is ambiguous",
  );
});

test("parent shutdown requires both owned child exit and named server stopped evidence", async () => {
  const successParent = { server: {} };
  const success = await verifyParentShutdown(successParent, {
    stop: async () => {},
    waitForExit: async () => {
      successParent.exit = { code: 0 };
    },
    status: async () => ({ server: { running: false } }),
  });
  assert.deepEqual(success, []);

  const exitCodeDiagnostics = {};
  const exitCodeParent = { server: {} };
  const exitedByCode = await verifyParentShutdown(
    exitCodeParent,
    {
      stop: async () => {},
      waitForExit: async () => {
        exitCodeParent.server.exitCode = 0;
      },
      status: async () => ({ server: { running: false } }),
    },
    exitCodeDiagnostics,
  );
  assert.deepEqual(exitedByCode, []);
  assert.equal(exitCodeDiagnostics.child.exitObservedAfterStop, false);
  assert.equal(exitCodeDiagnostics.child.exitCode, 0);

  const runningParent = { server: {} };
  const serverStillRunningWithTerminalChild = await verifyParentShutdown(
    runningParent,
    {
      stop: async () => {},
      waitForExit: async () => {
        runningParent.server.exitCode = 0;
      },
      status: async () => ({ server: { running: true } }),
    },
  );
  assert.match(
    serverStillRunningWithTerminalChild.join("\n"),
    /named Herdr server stop not verified/,
  );

  const signalParent = { server: {} };
  const exitedBySignal = await verifyParentShutdown(signalParent, {
    stop: async () => {},
    waitForExit: async () => {
      signalParent.server.signalCode = "SIGTERM";
    },
    status: async () => ({ server: { running: false } }),
  });
  assert.deepEqual(exitedBySignal, []);

  const childStillAlive = await verifyParentShutdown(
    { server: {} },
    {
      stop: async () => {},
      waitForExit: async () => {
        throw new Error("timeout");
      },
      status: async () => ({ server: { running: false } }),
    },
  );
  assert.match(childStillAlive.join("\n"), /owned child did not exit/);

  const serverStillRunning = await verifyParentShutdown(
    { server: {}, exit: { code: 0 } },
    {
      stop: async () => {},
      waitForExit: async () => {},
      status: async () => ({ server: { running: true } }),
    },
  );
  assert.match(
    serverStillRunning.join("\n"),
    /named Herdr server stop not verified/,
  );
});

test("cleanup artifact records false child signal results", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-signal-cleanup-"));
  const signals: string[] = [];
  const parent = {
    name: "phs-signal-test",
    env: {},
    server: {
      kill(signal: string) {
        signals.push(signal);
        return false;
      },
    },
  };
  const ctx = {
    scenario: "core",
    simulated: true,
    paths: { root },
    owned: { parent },
  };
  const cleanupError = await cleanup(
    { root, authLink: join(root, "missing-auth-link") },
    { parent },
    ctx,
    {
      runCommand: async () => ({}),
      tryHerdrCommand: async () => ({
        ok: true,
        value: { server: { running: false } },
      }),
      sleepFor: async () => {
        throw new Error("timeout");
      },
    },
  );

  assert.match(cleanupError ?? "", /owned child did not exit/);
  assert.equal(ctx.parentCleanupDiagnostics.namedServer.running, false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    ctx.parentCleanupDiagnostics.cleanupErrorCode,
    "PARENT_SHUTDOWN_UNVERIFIED",
  );
  assert.equal(
    ctx.parentCleanupDiagnostics.child.exitObservedAfterSigkill,
    false,
  );
  assert.equal(ctx.parentCleanupDiagnostics.child.exitCode, null);
  assert.equal(ctx.parentCleanupDiagnostics.child.signalCode, null);
  const evidence = sanitizedFailureEvidence(ctx, {}, "CLEANUP_FAIL", "FAIL");
  const artifactPath = await preserveFailureEvidence(evidence);
  const persisted = await readFile(artifactPath, "utf8");
  assert.match(persisted, /"sigtermSent": false/);
  assert.match(persisted, /"sigkillSent": false/);
  await rm(dirname(artifactPath), {
    recursive: true,
    force: true,
  });
  await rm(root, { recursive: true, force: true });
});

test("cleanup does not SIGKILL when owned child exits after SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-term-cleanup-"));
  const signals: string[] = [];
  const parent = {
    name: "phs-term-test",
    env: {},
    server: {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) {
        signals.push(signal);
        if (signal === "SIGTERM") this.exitCode = 0;
        return true;
      },
    },
  };
  const ctx = {
    scenario: "core",
    simulated: true,
    paths: { root },
    owned: { parent },
  };
  await cleanup(
    { root, authLink: join(root, "missing-auth-link") },
    { parent },
    ctx,
    {
      runCommand: async () => ({}),
      tryHerdrCommand: async () => ({
        ok: true,
        value: { server: { running: false } },
      }),
      sleepFor: async () => {
        throw new Error("initial exit wait timed out");
      },
    },
  );
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(ctx.parentCleanupDiagnostics.child.waitAfterSigterm, "exited");
  assert.equal("sigkillSent" in ctx.parentCleanupDiagnostics.child, false);
  await rm(root, { recursive: true, force: true });
});

test("owned parent setup verifies readiness and workspace identity", async () => {
  const paths = {
    herdrConfig: "/tmp/isolated/herdr.toml",
    xdgConfig: "/tmp/isolated/config",
    xdgState: "/tmp/isolated/state",
    piAgent: "/tmp/isolated/pi-agent",
    piSessions: "/tmp/isolated/pi-sessions",
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  stderr.setEncoding = () => {};
  const server = new EventEmitter() as EventEmitter & { stderr: typeof stderr };
  server.stderr = stderr;
  let ready = false;
  const owned: Record<string, any> = {};
  const parent = await startParent(paths, owned, {
    spawnProcess: () => server,
    tryHerdrCommand: async (_args: unknown, options: any) => ({
      ok: true,
      value: {
        server: {
          running: true,
          compatible: true,
          session: options.env.HERDR_SESSION,
          socket: `/tmp/isolated/config/herdr/sessions/${options.env.HERDR_SESSION}/herdr.sock`,
        },
      },
    }),
    wait: async (
      _ctx: unknown,
      _stage: string,
      observe: () => Promise<any>,
    ) => {
      ready = (await observe()).done;
    },
  });
  assert.equal(ready, true);
  assert.equal(owned.parent.server, server);

  const calls: unknown[][] = [];
  assert.equal(
    await createParentWorkspace(paths, parent, owned, "/repo", async (args) => {
      calls.push(args);
      return args[1] === "create"
        ? {
            workspace: { workspace_id: "w-owned" },
            root_pane: { pane_id: "p-owned" },
          }
        : { workspace: { workspace_id: "w-owned" } };
    }),
    "w-owned",
  );
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["create", "get"],
  );
  await assert.rejects(
    createParentWorkspace(paths, parent, owned, "/repo", async () => ({
      workspace: { workspace_id: "w-other" },
    })),
  );
});

test("cleanup closes and verifies the owned parent through Herdr contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-parent-cleanup-"));
  const server = new EventEmitter() as EventEmitter & {
    exit?: { code: number };
    kill?: never;
  };
  const parentEnv = {
    HERDR_SESSION: "phs-owned",
    HERDR_CONFIG_PATH: "/tmp/isolated/herdr.toml",
    XDG_CONFIG_HOME: "/tmp/isolated/config",
    XDG_STATE_HOME: "/tmp/isolated/state",
  };
  const parent = {
    name: "phs-owned",
    env: parentEnv,
    workspaceId: "w-owned",
    server,
  };
  const calls: string[][] = [];
  let stopCall: { args: string[]; env: unknown } | undefined;
  const result = await cleanup(
    { root, authLink: join(root, "missing-auth-link") },
    { parent },
    {},
    {
      herdrCommand: async (args) => {
        calls.push(args);
        return {};
      },
      runCommand: async (_file, args, options) => {
        calls.push(args);
        stopCall = { args, env: options.env };
        parent.exit = { code: 0 };
        return {};
      },
      tryHerdrCommand: async (args) => {
        calls.push(args);
        return { ok: true, value: { server: { running: false } } };
      },
    },
  );
  assert.equal(result, null);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["workspace", "close"],
      ["--session", "phs-owned"],
      ["status", "--json"],
    ],
  );
  assert.deepEqual(stopCall, {
    args: ["--session", "phs-owned", "server", "stop"],
    env: parentEnv,
  });

  const retainedRoot = await mkdtemp(
    join(tmpdir(), "pi-herdsman-parent-failure-"),
  );
  const marker = join(retainedRoot, "retained");
  await writeFile(marker, "owned state");
  const failed = await cleanup(
    { root: retainedRoot, authLink: join(retainedRoot, "missing-auth-link") },
    { parent: { ...parent, server: { exit: { code: 0 } } } },
    {},
    {
      herdrCommand: async () => ({}),
      runCommand: async () => ({}),
      tryHerdrCommand: async () => ({
        ok: true,
        value: { server: { running: true } },
      }),
    },
  );
  assert.match(failed ?? "", /named Herdr server stop not verified/);
  assert.equal(await readFile(marker, "utf8"), "owned state");
  await rm(retainedRoot, { recursive: true, force: true });
});

test("manager-recovery uses nonblocking messages only when information cannot wait for the automatic result", () => {
  const marker = "MANAGER_RECOVERY_CONTEXT_test";
  const leadPrompt = managerRecoveryPostRecoveryPrompt();
  assert.match(leadPrompt, /message_supervisor/);
  assert.match(
    leadPrompt,
    /must reach the Manager before your normal result boundary/i,
  );
  assert.match(leadPrompt, /if information can wait.*do not send it early/i);
  assert.match(leadPrompt, /automatic result handoff/i);
  assert.doesNotMatch(leadPrompt, new RegExp(marker));

  const managerPrompt = managerRecoveryReviewPrompt("branch-for-review");
  assert.match(managerPrompt, /message_staff/);
  assert.match(managerPrompt, /nonblocking/i);
  assert.match(managerPrompt, /automatic result handoff/i);
  assert.doesNotMatch(managerPrompt, new RegExp(marker));
});

test("manager-recovery starts work by task and branch, then resumes by branch only", () => {
  const branch = "herdsman/smoke-manager-recovery-exact";
  const marker = "MANAGER_RECOVERY_CONTEXT_test";
  const prompt = managerRecoveryFreshPrompt(branch);
  assert.match(prompt, /delegate_work exactly once to start new project work/);
  assert.match(prompt, /`task` argument/);
  assert.match(
    prompt,
    /`branch` argument to exactly herdsman\/smoke-manager-recovery-exact/,
  );
  assert.match(prompt, /Omit `base` and `files`/);
  assert.doesNotMatch(prompt, /`assignment`/);
  assert.match(
    prompt,
    /after delegate_work returns, end this turn immediately/,
  );
  assert.match(prompt, /Wait until the exact MANAGER_RECOVERY_READY message/);
  assert.doesNotMatch(prompt, new RegExp(marker));
  assert.doesNotMatch(prompt, /context marker|remember the exact/i);
  assert.match(prompt, /Only after that delivered message, reply exactly/);
  assert.doesNotMatch(prompt, /MANAGER_RECOVERY_FINISH/);
  const resume = managerRecoveryResumePrompt(branch);
  assert.match(
    resume,
    /resume_work using only:\n\{"branch":"herdsman\/smoke-manager-recovery-exact"\}/,
  );
  assert.match(resume, /PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED/);
  assert.doesNotMatch(resume, /supervisor_result|supervisor_ask/);
  assert.doesNotMatch(resume, /"assignment"|"task"|"base"|"files"/);
});

test("manager-recovery stops and resumes by branch", () => {
  const branch = "herdsman/smoke-manager-recovery-exact";
  const session = "lead-session-exact";
  const marker = "MANAGER_RECOVERY_CONTEXT_test";
  const close = managerRecoveryStopPrompt(branch);
  assert.match(close, /stop_lead exactly once/);
  assert.ok(close.includes(JSON.stringify({ branch })));
  assert.match(close, /PI_HERDSMAN_MANAGER_RECOVERY_PAUSED/);
  const review = managerRecoveryReviewPrompt(branch);
  assert.match(review, /message_staff/);
  assert.doesNotMatch(review, new RegExp(marker));
  const resume = managerRecoveryResumeOnlyPrompt(branch);
  assert.match(resume, /resume_work exactly once/);
  assert.ok(resume.includes(JSON.stringify({ branch })));
  assert.match(resume, /exact full branch string/);
  assert.match(resume, /Copy that branch string verbatim/);
  assert.match(resume, /do not shorten, summarize, normalize/);
  assert.match(resume, /PI_HERDSMAN_MANAGER_RECOVERY_RESUMED/);
});

test("manager-recovery verifies retired assignments cannot be resumed", () => {
  const branch = "herdsman/smoke-manager-recovery-retired";
  const prompt = managerRecoveryRetiredResumePrompt(branch);
  assert.ok(prompt.includes(JSON.stringify({ branch })));
  assert.match(prompt, /resume_work exactly once/);
  assert.match(prompt, /Do not delegate new work/);
  assert.match(prompt, /PI_HERDSMAN_MANAGER_RECOVERY_RETIRED/);
});

test("manager-recovery seeds continuity only in the Lead conversation, then recalls without revealing it", () => {
  const branch = "herdsman/smoke-manager-recovery-exact";
  const marker = "MANAGER_RECOVERY_CONTEXT_test";
  const leadPrompt = managerRecoveryLeadContextPrompt(marker);
  const managerPrompts = [
    managerRecoveryFreshPrompt(branch),
    managerRecoveryResumePrompt(branch),
    managerRecoveryReviewPrompt(branch),
    managerRecoveryStopPrompt("lead-session-exact"),
    managerRecoveryResumeOnlyPrompt(branch),
  ];

  assert.match(leadPrompt, new RegExp(marker));
  for (const prompt of managerPrompts)
    assert.doesNotMatch(prompt, new RegExp(marker));

  const recallPrompt = managerRecoveryPostRecoveryPrompt();
  assert.doesNotMatch(recallPrompt, new RegExp(marker));
  assert.match(recallPrompt, /recall the exact context marker/i);
  assert.match(recallPrompt, /send it now with message_supervisor/i);
  assert.match(recallPrompt, /automatic result handoff/i);
  assert.match(recallPrompt, /do not send it early/i);
});

test("manager-recovery waits for the exact automatic project message turn to settle", () => {
  const contents = [
    {
      id: "receipt",
      parentId: "prior",
      type: "custom_message",
      customType: "pi-herdsman-project_message",
      content: "Project branch-a from lead lead-session:\n\nCONTEXT_MARKER",
      details: { branch: "branch-a", fromSessionId: "lead-session" },
    },
    {
      id: "response",
      parentId: "receipt",
      type: "message",
      message: { role: "assistant", stopReason: "stop" },
    },
    {
      id: "unrelated-response",
      parentId: "unrelated",
      type: "message",
      message: { role: "assistant", stopReason: "stop" },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.equal(
    managerProjectMessageSettled(
      contents,
      "branch-a",
      "lead-session",
      "CONTEXT_MARKER",
    ),
    true,
  );
  assert.equal(
    managerProjectMessageSettled(
      contents,
      "branch-b",
      "lead-session",
      "CONTEXT_MARKER",
    ),
    false,
  );
  assert.equal(
    managerProjectMessageSettled(
      contents.replace('"stopReason":"stop"', '"stopReason":"toolUse"'),
      "branch-a",
      "lead-session",
      "CONTEXT_MARKER",
    ),
    false,
  );
  assert.equal(
    managerProjectMessageSettled(
      contents.replace('"parentId":"receipt"', '"parentId":"unrelated"'),
      "branch-a",
      "lead-session",
      "CONTEXT_MARKER",
    ),
    false,
  );
});

test("manager-recovery detects review assistant response completion after message_staff", () => {
  const prompt = managerRecoveryReviewPrompt("branch-a");
  const entries = [
    { id: "user", type: "message", message: { role: "user", content: prompt } },
    {
      id: "call",
      parentId: "user",
      type: "message",
      message: { role: "assistant", stopReason: "toolUse", content: [] },
    },
    {
      id: "receipt",
      parentId: "call",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "message_staff",
        isError: false,
      },
    },
  ];
  const session = (messages) => ({
    contents: messages.map((entry) => JSON.stringify(entry)).join("\n"),
  });

  assert.equal(
    assistantResponseCompletedForSession(session(entries), prompt),
    false,
  );
  assert.equal(
    assistantResponseCompletedForSession(
      session([
        ...entries,
        {
          id: "final",
          parentId: "receipt",
          type: "message",
          message: { role: "assistant", stopReason: "stop", content: "Done." },
        },
      ]),
      prompt,
    ),
    true,
  );
});

test("manager-recovery diagnostics capture the resume argument and result", () => {
  const branch = "herdsman/smoke-manager-recovery-exact";
  const prompt = managerRecoveryResumeOnlyPrompt(branch);
  const entries = [
    {
      type: "message",
      id: "prompt",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "call",
      parentId: "prompt",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "resume-call",
            name: "resume_work",
            arguments: { branch: "herdsman/smoke-manager-recovery-exac" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "result",
      parentId: "call",
      message: {
        role: "toolResult",
        toolName: "resume_work",
        toolCallId: "resume-call",
        isError: true,
        content: [{ type: "text", text: "No existing work was found." }],
      },
    },
  ];
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");
  assert.deepEqual(managerRecoveryResumeDiagnostics(contents, prompt), [
    {
      branch: "herdsman/smoke-manager-recovery-exac",
      arguments: { branch: "herdsman/smoke-manager-recovery-exac" },
      result: {
        isError: true,
        details: null,
        content: "No existing work was found.",
      },
    },
  ]);
  assert.deepEqual(
    managerRecoveryResumeDiagnostics(contents, "different prompt"),
    [],
  );
});

test("manager-recovery post-recovery prompt recalls the marker from prior context", () => {
  const marker = "MANAGER_RECOVERY_CONTEXT_test";
  const prompt = managerRecoveryPostRecoveryPrompt();
  assert.doesNotMatch(prompt, new RegExp(marker));
  assert.match(prompt, /recall the exact context marker/i);
  assert.match(prompt, /instructed to remember before recovery/i);
  assert.match(prompt, /prior conversation context/i);
});

test("smoke parses successful stop_lead results only", () => {
  const result = {
    ok: true,
    action: "stop",
    session: "lead-session",
    branch: "feat/example",
  };
  const resumed = { ok: true, action: "resume", branch: "feat/example" };
  const contents = [
    {
      toolName: "stop_lead",
      content: [
        { type: "text", text: "Lead stopped; project work preserved." },
      ],
      details: result,
    },
    { toolName: "resume_work", details: resumed },
    { toolName: "delegate_work", content: JSON.stringify(result) },
    { toolName: "stop_lead", isError: true, content: JSON.stringify(result) },
  ]
    .map((message) =>
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", ...message },
      }),
    )
    .join("\n");
  assert.deepEqual(staffActionResults(contents, "stop_lead", "stop"), [result]);
  assert.deepEqual(staffActionResults(contents, "resume_work", "resume"), [
    resumed,
  ]);
});

test("manager-recovery selects the resume result descended from its exact prompt", () => {
  const gracefulPrompt = "resume after stop_lead";
  const recoveryPrompt = "resume after executor loss";
  const entries = [
    {
      type: "message",
      id: "graceful-prompt",
      message: { role: "user", content: gracefulPrompt },
    },
    {
      type: "message",
      id: "graceful-call",
      parentId: "graceful-prompt",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "resume-1", name: "resume_work" }],
      },
    },
    {
      type: "message",
      id: "graceful-result",
      parentId: "graceful-call",
      message: {
        role: "toolResult",
        toolName: "resume_work",
        toolCallId: "resume-1",
        details: { ok: true, action: "resume", session: "lead" },
      },
    },
    {
      type: "message",
      id: "graceful-answer",
      parentId: "graceful-result",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_RESUMED",
      },
    },
    {
      type: "message",
      id: "recovery-prompt",
      message: { role: "user", content: recoveryPrompt },
    },
    {
      type: "message",
      id: "recovery-call",
      parentId: "recovery-prompt",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "resume-2", name: "resume_work" }],
      },
    },
    {
      type: "message",
      id: "recovery-result",
      parentId: "recovery-call",
      message: {
        role: "toolResult",
        toolName: "resume_work",
        toolCallId: "resume-2",
        details: { ok: true, action: "resume", session: "lead" },
      },
    },
    {
      type: "message",
      id: "recovery-answer",
      parentId: "recovery-result",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED",
      },
    },
  ];
  const contents = entries.map((entry) => JSON.stringify(entry)).join("\n");

  assert.equal(staffActionResults(contents, "resume_work", "resume").length, 2);
  assert.deepEqual(
    staffActionResults(contents, "resume_work", "resume", recoveryPrompt),
    [{ ok: true, action: "resume", session: "lead" }],
  );
  assert.equal(
    assistantResultForSession(
      { contents },
      recoveryPrompt,
      "PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED",
    )?.id,
    "recovery-answer",
  );
});

test("delegate project results retain only valid successful delegation payloads in order", () => {
  const messages = [
    { toolName: "unrelated", content: '{"ok":true,"action":"delegate"}' },
    { toolName: "delegate_work", content: "not JSON" },
    {
      toolName: "delegate_work",
      content: "not JSON",
      details: { ok: true, action: "delegate", session: "must-not-match" },
    },
    {
      toolName: "delegate_work",
      isError: true,
      content: '{"ok":true,"action":"delegate"}',
    },
    {
      toolName: "delegate_work",
      content:
        '{"ok":true,"action":"delegate","branch":"feat/fresh","session":"fresh"}',
    },
    {
      toolName: "delegate_work",
      content:
        '{"ok":true,"action":"delegate","branch":"feat/fresh","session":"fresh","state":"working"}',
    },
  ];
  const contents = messages
    .map((message, index) =>
      JSON.stringify({
        type: "message",
        id: `entry-${index}`,
        message: { role: "toolResult", ...message },
      }),
    )
    .join("\n");
  assert.deepEqual(staffDelegateResults(contents), [
    { ok: true, action: "delegate", branch: "feat/fresh", session: "fresh" },
    {
      ok: true,
      action: "delegate",
      branch: "feat/fresh",
      session: "fresh",
      state: "working",
    },
  ]);
});

test("failed project delegation is correlated, sanitized, and preserves topology capture", async () => {
  const branch = "smoke/expected";
  const call = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "delegate_work",
          arguments: { branch },
        },
      ],
    },
  };
  const result = (fields = {}) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "delegate_work",
      toolCallId: "call-1",
      isError: true,
      content: [
        { type: "text", text: "Project assignment lock is in progress" },
      ],
      ...fields,
    },
  });
  const transcript = (...entries) => entries.map(JSON.stringify).join("\n");
  const failed = transcript(call, result());

  assert.throws(
    () => assertNoFailedProjectDelegation(failed, branch),
    (error) =>
      error.code === "SMOKE_DELEGATION_FAILED" &&
      error.message === "delegate_work failed (assignment_lock_occupied)",
  );
  assert.doesNotThrow(() =>
    assertNoFailedProjectDelegation(failed, "smoke/other"),
  );
  assert.doesNotThrow(() =>
    assertNoFailedProjectDelegation(
      transcript(call, result({ toolCallId: "other-call" })),
      branch,
    ),
  );
  assert.doesNotThrow(() =>
    assertNoFailedProjectDelegation(transcript(call), branch),
  );
  assert.doesNotThrow(() =>
    assertNoFailedProjectDelegation(
      transcript(
        call,
        result({
          isError: false,
          details: { ok: true },
          content: [{ type: "text", text: "delegated" }],
        }),
      ),
      branch,
    ),
  );
  assert.throws(
    () =>
      assertNoFailedProjectDelegation(
        transcript(
          call,
          result({
            isError: false,
            details: { ok: false },
            content: [{ type: "text", text: "PRIVATE_TOKEN" }],
          }),
        ),
        branch,
      ),
    (error) =>
      error.code === "SMOKE_DELEGATION_FAILED" &&
      error.message === "delegate_work failed (tool_error)" &&
      !error.message.includes("PRIVATE_TOKEN"),
  );

  const ctx = { rootWorkspaceId: "workspace", owned: {} };
  const worktree = {
    branch,
    path: "/smoke/expected",
    open_workspace_id: "workspace-2",
  };
  await assert.rejects(
    terminalFailureAssignmentPoll(
      ctx,
      branch,
      async () => ({ contents: failed }),
      async () => [],
      async () => ({ worktrees: [worktree] }),
    ),
    (error) => error.code === "SMOKE_DELEGATION_FAILED",
  );
  assert.equal(ctx.owned.managerWorktreePath, worktree.path);
  assert.equal(ctx.owned.managerWorkspaceId, worktree.open_workspace_id);
});

test("Manager history recognizes retained project messages by exact identity", () => {
  const branch = "feature/bootstrap";
  const sessionId = "lead-session";
  const record = {
    type: "custom_message",
    id: "manager-message",
    customType: "pi-herdsman-project_message",
    details: {
      id: "record-id",
      repoKey: "repo",
      branch,
      fromSessionId: sessionId,
    },
    content: "review handoff",
  };
  const contents = JSON.stringify(record);
  assert.deepEqual(projectMessageEntries(contents, branch, sessionId), [
    record,
  ]);
  assert.deepEqual(projectMessageEntries(contents, "other", sessionId), []);
  assert.deepEqual(
    projectMessageEntries(contents, branch, "other-session"),
    [],
  );
});

test("retained project message selection ignores stale and wrong-scope records", () => {
  const marker = "MANAGER_RECOVERY_CONTEXT_new";
  const valid = {
    id: "new-id",
    branch: "feature/current",
    fromSessionId: "lead-current",
    text: marker,
  };
  assert.deepEqual(
    retainedProjectMessageRecord(
      [
        { ...valid, id: "ready", text: "MANAGER_RECOVERY_READY" },
        { ...valid, id: "branch", branch: "feature/other" },
        { ...valid, id: "session", fromSessionId: "lead-other" },
        { ...valid, id: "content", text: `${marker} extra` },
        { ...valid, id: "" },
        Object.fromEntries(
          Object.entries(valid).filter(([key]) => key !== "id"),
        ),
        valid,
      ],
      "feature/current",
      "lead-current",
      marker,
    ),
    valid,
  );
  assert.equal(
    retainedProjectMessageRecord(
      [{ ...valid, text: "MANAGER_RECOVERY_READY" }],
      "feature/current",
      "lead-current",
      marker,
    ),
    null,
  );
});

test("manager handoff requires exact repository, assignment, sender, id, and content", () => {
  const valid = {
    id: "message-id",
    repoKey: "repo",
    branch: "feature/one",
    fromSessionId: "lead-session",
    text: "HANDOFF",
  };
  assert.equal(
    managerHandoffRetainedRecord(
      [valid],
      "repo",
      "feature/one",
      "lead-session",
      "HANDOFF",
    ),
    valid,
  );
  for (const wrong of [
    { ...valid, repoKey: "other" },
    { ...valid, branch: "feature/two" },
    { ...valid, fromSessionId: "other-session" },
  ])
    assert.equal(
      managerHandoffRetainedRecord(
        [wrong],
        "repo",
        "feature/one",
        "lead-session",
        "HANDOFF",
      ),
      null,
    );
  const record = {
    type: "custom_message",
    customType: "pi-herdsman-project_message",
    details: {
      repoKey: "repo",
      branch: "feature/one",
      fromSessionId: "lead-session",
      id: "message-id",
    },
    content: "Project feature/one from lead lead-session:\n\nHANDOFF",
  };
  const contents = JSON.stringify(record);
  assert.deepEqual(
    managerHandoffDeliveredEntry(
      contents,
      "repo",
      "feature/one",
      "lead-session",
      "message-id",
      "HANDOFF",
    ),
    record,
  );
  assert.equal(
    managerHandoffDeliveredEntry(
      contents,
      "other",
      "feature/one",
      "lead-session",
      "message-id",
      "HANDOFF",
    ),
    null,
  );
  assert.equal(
    managerHandoffDeliveredEntry(
      contents,
      "repo",
      "feature/one",
      "lead-session",
      "wrong-id",
      "HANDOFF",
    ),
    null,
  );
  assert.equal(
    managerHandoffDeliveredEntry(
      JSON.stringify({ ...record, content: "wrong" }),
      "repo",
      "feature/one",
      "lead-session",
      "message-id",
      "HANDOFF",
    ),
    null,
  );
  assert.equal(
    managerHandoffCanReenter(
      false,
      "",
      "repo",
      "feature/one",
      "lead-session",
      "message-id",
      "HANDOFF",
    ),
    true,
  );
  assert.equal(
    managerHandoffCanReenter(
      true,
      "",
      "repo",
      "feature/one",
      "lead-session",
      "message-id",
      "HANDOFF",
    ),
    false,
  );
  assert.equal(
    managerHandoffCanReenter(
      false,
      contents,
      "repo",
      "feature/one",
      "lead-session",
      "message-id",
      "HANDOFF",
    ),
    false,
  );
  assert.equal(managerHandoffLeadPidContinues(123, 123), true);
  assert.equal(managerHandoffLeadPidContinues(123, 456), false);
});

test("manager handoff faux decision waits for exact readiness after assignment", () => {
  const prompt = {
    role: "user",
    content:
      'Use delegate_work exactly once with branch smoke/branch and task exactly "ready"; MANAGER_HANDOFF_READY',
  };
  const call = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "delegate_work",
        arguments: { branch: "smoke/branch", task: "ready" },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolName: "delegate_work",
    toolCallId: "call-1",
    content: "Session: lead-session\nWorkspace: workspace",
  };
  assert.equal(
    decide("manager-handoff", { messages: [prompt] }).content[0].type,
    "toolCall",
  );
  const assigned = [prompt, call, result];
  assert.match(
    decide("manager-handoff", { messages: assigned }).content[0].text,
    /Waiting for the exact assigned Lead readiness/,
  );
  const ready = {
    role: "user",
    content:
      "Project smoke/branch from lead lead-session:\n\nMANAGER_HANDOFF_READY",
  };
  assert.match(
    decide("manager-handoff", { messages: [...assigned, ready] }).content[0]
      .text,
    /MANAGER_HANDOFF_READY_RECEIVED/,
  );
  assert.match(
    decide("manager-handoff", {
      messages: [...assigned, { ...ready, content: "MANAGER_HANDOFF_READY" }],
    }).content[0].text,
    /Waiting for the exact assigned Lead readiness/,
  );
});

test("Manager cleanup selects the recreated workspace only for exact branch and path", () => {
  const worktree = {
    branch: "feature/current",
    path: "/smoke/project-worktree",
    open_workspace_id: "new-workspace",
  };
  assert.equal(
    managerCleanupTarget(
      [worktree],
      "feature/current",
      "/smoke/project-worktree",
      worktree.open_workspace_id,
    ),
    worktree,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [worktree, worktree],
        worktree.branch,
        worktree.path,
        worktree.open_workspace_id,
      ),
    /one worktree/,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [worktree],
        worktree.branch,
        "/other/path",
        worktree.open_workspace_id,
      ),
    /path does not match/,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [{ ...worktree, open_workspace_id: "" }],
        worktree.branch,
        worktree.path,
        worktree.open_workspace_id,
      ),
    /no workspace identity/,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [],
        worktree.branch,
        worktree.path,
        worktree.open_workspace_id,
      ),
    /one worktree/,
  );
  assert.equal(
    managerCleanupTarget(
      [],
      worktree.branch,
      worktree.path,
      worktree.open_workspace_id,
      true,
    ),
    null,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [worktree, worktree],
        worktree.branch,
        worktree.path,
        worktree.open_workspace_id,
        true,
      ),
    /one worktree/,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [{ ...worktree, open_workspace_id: "replacement-workspace" }],
        worktree.branch,
        worktree.path,
        worktree.open_workspace_id,
      ),
    /workspace identity does not match captured identity/,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [worktree],
        worktree.branch,
        worktree.path,
        undefined,
      ),
    /captured workspace identity is unavailable/,
  );
});

test("collectDiagnostics reads the host pane through the parent Herdr environment", async () => {
  const parentEnv = { HERDR_SESSION: "parent-session" };
  const calls = [];
  let projection;
  const originalError = console.error;
  console.error = () => {};
  try {
    projection = await collectDiagnostics(
      {
        parentEnv,
        paths: {},
        sessionName: "nested",
        rootPaneId: "root-pane",
      },
      { hostPaneId: "host-pane" },
      null,
      {
        execute: async (...args) => {
          calls.push(args);
          return { stdout: "host output" };
        },
        observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
        snapshot: async () => null,
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(projection, {
    stage: null,
    agentsObserved: 0,
    panesObserved: 0,
    rootSessionObserved: false,
    candidateProcessesObserved: 0,
  });
  assert.deepEqual(
    calls.find(([, args]) => args.includes("host-pane")),
    [
      "herdr",
      [
        "pane",
        "read",
        "host-pane",
        "--source",
        "recent-unwrapped",
        "--lines",
        "80",
      ],
      { env: parentEnv, timeout: 5_000 },
    ],
  );
});

test("diagnostic collection failure preserves sanitized primary failure evidence", async () => {
  const secondaryException = "PRIVATE secondary diagnostic exception";
  const ctx = {
    scenario: "supervisor-agent",
    simulated: true,
    stage: "supervisor-agent-verification",
    sessionName: "smoke-supervisor-agent",
  };
  const diagnostics = await bestEffortDiagnostics(ctx, async () => {
    throw new Error(secondaryException);
  });
  const evidence = sanitizedFailureEvidence(
    ctx,
    { phase: "scenario", error: new Error("primary scenario failure") },
    "SCENARIO_FAIL",
    "PENDING",
  );
  evidence.diagnostics = diagnostics;
  const artifact = await preserveFailureEvidence(evidence);
  try {
    const persisted = await readFile(artifact, "utf8");
    const result = JSON.parse(persisted);
    assert.equal(result.outcome, "SCENARIO_FAIL");
    assert.equal(result.stage, "supervisor-agent-verification");
    assert.deepEqual(result.diagnostics, {
      stage: "supervisor-agent-verification",
      collectionFailed: true,
    });
    assert.doesNotMatch(persisted, /PRIVATE secondary diagnostic exception/u);
  } finally {
    await rm(dirname(artifact), { recursive: true, force: true });
  }
});

test("collectDiagnostics projects supervisor-agent evidence without private session data", async () => {
  const privatePrompt = "PRIVATE_PROMPT PRIVATE_TOKEN";
  const privatePath = "/PRIVATE_PATH/session.jsonl";
  const projection = await collectDiagnostics(
    {
      scenario: "supervisor-agent",
      stage: "supervisor-agent-verification",
      paths: {},
      sessionName: "smoke-supervisor-agent",
      rootPaneId: "root-pane",
    },
    { hostPaneId: "host-pane" },
    null,
    {
      execute: async () => ({ stdout: "root terminal output" }),
      observe: async () => ({ ok: true, value: { agents: [], panes: [] } }),
      snapshot: async () => ({
        path: privatePath,
        status: "saved",
        contents:
          [
            JSON.stringify({
              type: "session",
              id: "root-session",
              cwd: "/workspace",
            }),
            JSON.stringify({
              type: "message",
              message: { role: "user", content: privatePrompt },
            }),
          ].join("\n") + "\n",
      }),
    },
  );

  assert.deepEqual(projection, {
    stage: "supervisor-agent-verification",
    agentsObserved: 0,
    panesObserved: 0,
    rootSessionObserved: true,
    candidateProcessesObserved: 0,
    supervisorAgent: {
      assignmentsObserved: 0,
      childSessionObserved: false,
      matchingMailboxes: 0,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(projection),
    /PRIVATE_PROMPT|PRIVATE_TOKEN|PRIVATE_PATH/u,
  );
  const evidence = sanitizedFailureEvidence(
    { scenario: "supervisor-agent", simulated: true, stage: "verification" },
    { error: { code: "SCENARIO_FAIL" } },
    "SCENARIO_FAIL",
    "PENDING",
  );
  evidence.diagnostics = projection;
  const artifactPath = await preserveFailureEvidence(evidence);
  const persisted = await readFile(artifactPath, "utf8");
  assert.doesNotMatch(persisted, /PRIVATE_PROMPT|PRIVATE_TOKEN|PRIVATE_PATH/u);
  assert.match(persisted, /"agentsObserved": 0/u);
  assert.match(persisted, /"rootSessionObserved": true/u);
  await rm(dirname(artifactPath), { recursive: true, force: true });
});

test("terminal-failure assignment polling captures topology before assignment succeeds", async () => {
  const ctx = {
    rootWorkspaceId: "parent-workspace",
    owned: { managerBranch: "herdsman/smoke-terminal-failure" },
  };
  const worktree = {
    branch: "herdsman/smoke-terminal-failure",
    path: "/smoke/terminal-failure",
    open_workspace_id: "workspace-2",
  };
  const calls = [];
  const result = await terminalFailureAssignmentPoll(
    ctx,
    worktree.branch,
    async () => null,
    async () => [],
    async (...args) => {
      calls.push(args);
      return { worktrees: [worktree] };
    },
  );
  assert.equal(result.done, false);
  assert.deepEqual(calls, [
    [ctx, ["worktree", "list", "--workspace", "parent-workspace"]],
  ]);
  // No successful assignment is required to retain identity exposed by topology.
  assert.equal(ctx.owned.managerWorktreePath, worktree.path);
  assert.equal(ctx.owned.managerWorkspaceId, worktree.open_workspace_id);
  assert.equal(ctx.owned.managerWorktreeRetirementRequested, false);
  assert.equal(
    managerCleanupTarget(
      [worktree],
      worktree.branch,
      ctx.owned.managerWorktreePath,
      ctx.owned.managerWorkspaceId,
    ),
    worktree,
  );
  assert.throws(
    () =>
      managerCleanupTarget(
        [{ ...worktree, open_workspace_id: "replacement-workspace" }],
        worktree.branch,
        ctx.owned.managerWorktreePath,
        ctx.owned.managerWorkspaceId,
      ),
    /workspace identity does not match captured identity/,
  );
  assert.throws(
    () =>
      captureTerminalFailureWorktree(
        ctx,
        [worktree, worktree],
        worktree.branch,
      ),
    /one worktree/,
  );
});

test("terminal-failure retains the assigned Lead PID while its pane is live", async () => {
  const branch = "smoke-branch";
  const contents =
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "delegate_work",
        content: JSON.stringify({
          ok: true,
          action: "delegate",
          branch,
          session: "lead-session",
        }),
      },
    }) + "\n";
  assert.deepEqual(staffDelegateResults(contents), [
    { ok: true, action: "delegate", branch, session: "lead-session" },
  ]);
  const calls = [];
  const ctx = {
    rootWorkspaceId: "workspace",
    candidateExtension: "/candidate.js",
    herdrStateExtension: "/herdr.js",
  };
  const result = await terminalFailureAssignmentPoll(
    ctx,
    branch,
    async () => ({ contents }),
    async () => [
      {
        pane_id: "lead-pane",
        agent_session: { kind: "id", value: "lead-session" },
      },
    ],
    async (_ctx, args) => {
      calls.push(args);
      if (args[0] === "worktree") return { worktrees: [] };
      return {
        process_info: {
          foreground_processes: [
            {
              pid: 91,
              argv: [
                "node",
                "--extension",
                "/candidate.js",
                "--extension",
                "/herdr.js",
              ],
            },
          ],
        },
      };
    },
  );
  assert.equal(result.done, true, JSON.stringify(result));
  assert.deepEqual(result.value.processObservation, {
    paneId: "lead-pane",
    processes: [{ pid: 91 }],
  });
  assert.deepEqual(calls, [
    ["worktree", "list", "--workspace", "workspace"],
    ["pane", "process-info", "--pane", "lead-pane"],
  ]);
});

test("terminal-failure assignment polling preserves the first workspace identity", async () => {
  const ctx = {
    rootWorkspaceId: "parent-workspace",
    owned: { managerBranch: "herdsman/smoke-terminal-failure" },
  };
  const worktree = {
    branch: "herdsman/smoke-terminal-failure",
    path: "/smoke/terminal-failure",
    open_workspace_id: "workspace-2",
  };
  const poll = () =>
    terminalFailureAssignmentPoll(
      ctx,
      worktree.branch,
      async () => null,
      async () => [],
      async () => ({ worktrees: [{ ...worktree }] }),
    );

  assert.equal((await poll()).done, false);
  worktree.open_workspace_id = "replacement-workspace";
  assert.equal((await poll()).done, false);

  assert.equal(ctx.owned.managerWorktreePath, worktree.path);
  assert.equal(ctx.owned.managerWorkspaceId, "workspace-2");
  assert.throws(
    () =>
      captureTerminalFailureAssignment(
        ctx,
        worktree.path,
        "replacement-workspace",
      ),
    /conflicts with captured identity/,
  );
  assert.equal(ctx.owned.managerWorktreePath, worktree.path);
  assert.equal(ctx.owned.managerWorkspaceId, "workspace-2");
  assert.throws(
    () =>
      managerCleanupTarget(
        [worktree],
        worktree.branch,
        ctx.owned.managerWorktreePath,
        ctx.owned.managerWorkspaceId,
      ),
    /workspace identity does not match captured identity/,
  );
});

test("Manager smoke creates a fresh Git primary without pre-opening a worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-manager-smoke-"));
  try {
    const calls = [];
    const checkout = await prepareManagerRepository({ root }, async (...args) =>
      calls.push(args),
    );
    assert.equal(checkout, join(root, "project"));
    assert.deepEqual(
      calls.map((call) => call[1][0]),
      ["init", "-c"],
    );
    assert.deepEqual(calls[1][1].slice(-4), [
      "commit",
      "--allow-empty",
      "-m",
      "Smoke root",
    ]);
    assertManagerFreshPrimary(
      "root",
      checkout,
      { workspace_id: "root" },
      {
        source: {
          repo_key: "repo",
          repo_name: "project",
          source_workspace_id: "root",
          source_checkout_path: checkout,
        },
        worktrees: [{ open_workspace_id: "root" }],
      },
    );
    assert.throws(
      () =>
        assertManagerFreshPrimary(
          "root",
          checkout,
          { workspace_id: "root" },
          {
            source: {
              repo_key: "repo",
              repo_name: "project",
              source_workspace_id: "root",
              source_checkout_path: checkout,
            },
            worktrees: [{ open_workspace_id: "linked" }],
          },
        ),
      /linked workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Manager smoke assignment namespace comes only from the topology repo key", () => {
  const checkout = resolve(tmpdir(), "project");
  const topology = {
    source: {
      repo_key: "canonical-repo",
      repo_name: "project",
      source_workspace_id: "w1",
      source_checkout_path: checkout,
    },
    worktrees: [],
  };
  const validate = (value) =>
    assertManagerFreshPrimary("w1", checkout, { workspace_id: "w1" }, value);
  assert.equal(validate(topology), "canonical-repo");
  for (const repo_key of [undefined, "", null, 1])
    assert.throws(
      () => validate({ ...topology, source: { ...topology.source, repo_key } }),
      /repo key must be a non-empty string/,
    );
});

test("smoke branch cleanup treats only a proven absent local branch as already clean", async () => {
  const calls = [];
  const absent = Object.assign(new Error("not found"), { code: 1 });
  assert.equal(
    await deleteBranchIfPresent("herdsman/smoke-exact", async (...args) => {
      calls.push(args);
      throw absent;
    }),
    false,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/herdsman/smoke-exact",
  ]);

  calls.length = 0;
  assert.equal(
    await deleteBranchIfPresent("herdsman/smoke-exact", async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "", pid: 1 };
    }),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call[1][0]),
    ["show-ref", "branch"],
  );
  await assert.rejects(
    deleteBranchIfPresent("herdsman/smoke-exact", async () => {
      throw Object.assign(new Error("git failed"), { code: 128 });
    }),
    /git failed/,
  );
});

test("Manager recovery READY requires a successful message_supervisor tool result", () => {
  const ready = "MANAGER_RECOVERY_READY";
  const promptOnly = JSON.stringify({
    type: "message",
    message: { role: "user", content: `Please send ${ready}.` },
  });
  const call = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "ready-call",
          name: "message_supervisor",
          arguments: { message: ready },
        },
      ],
    },
  });
  const result = (isError = false) =>
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "message_supervisor",
        toolCallId: "ready-call",
        isError,
        content: "Message sent to supervisor.",
      },
    });
  assert.equal(hasSuccessfulSupervisorMessage(promptOnly, ready), false);
  assert.equal(
    hasSuccessfulSupervisorMessage(`${call}\n${result(true)}`, ready),
    false,
  );
  assert.equal(hasSuccessfulSupervisorMessage(call, ready), false);
  assert.equal(
    hasSuccessfulSupervisorMessage(`${call}\n${result()}`, ready),
    true,
  );
  assert.equal(leadReadyCompleted(`${call}\n${result()}`, ready), false);
  const stopped = JSON.stringify({
    type: "message",
    message: { role: "assistant", stopReason: "stop", content: "Waiting." },
  });
  assert.equal(
    leadReadyCompleted(`${call}\n${stopped}\n${result()}`, ready),
    false,
  );
  assert.equal(
    leadReadyCompleted(`${result()}\n${call}\n${stopped}`, ready),
    false,
  );
  assert.equal(
    leadReadyCompleted(`${call}\n${result(true)}\n${stopped}`, ready),
    false,
  );
  assert.equal(
    leadReadyCompleted(`${call}\n${result()}\n${stopped}`, ready),
    true,
  );
});

test("Manager recovery READY never matches missing session identities", () => {
  for (const [child, expected] of [
    [undefined, undefined],
    [undefined, "lead-id"],
    [{ id: "lead-id" }, undefined],
    [{ id: undefined }, undefined],
    [{ id: "" }, ""],
  ])
    assert.equal(verifiedLeadSession(child, expected), false);
  assert.equal(verifiedLeadSession({ id: "lead-id" }, "lead-id"), true);
});

test("Manager READY answer follows delivered message even on a separate followUp branch", () => {
  const lead = "lead-id";
  const branch = "manager-recovery";
  const entries = [
    { type: "session", id: "chief-id" },
    {
      type: "message",
      id: "delegation",
      message: { role: "user", content: "delegate" },
    },
    {
      type: "message",
      id: "premature",
      parentId: "delegation",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_READY",
      },
    },
    {
      type: "custom_message",
      id: "receipt",
      customType: "pi-herdsman-project_message",
      details: { branch, fromSessionId: lead },
      content: `Project ${branch} from lead ${lead}:\n\nMANAGER_RECOVERY_READY`,
    },
    {
      type: "message",
      id: "follow-up",
      parentId: "receipt",
      message: { role: "user", content: "followUp" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "follow-up",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_MANAGER_RECOVERY_READY",
      },
    },
  ];
  const contents = (items) =>
    items.map((entry) => JSON.stringify(entry)).join("\n");
  assert.deepEqual(
    managerReadyAnswer(contents(entries.slice(0, 3)), branch, lead),
    {
      receipt: false,
      answer: entries[2],
      answerAfterReceipt: null,
      prematureReady: true,
      prematureFinish: false,
    },
  );
  assert.deepEqual(
    managerReadyAnswer(contents(entries.slice(0, 5)), branch, lead),
    {
      receipt: true,
      answer: entries[2],
      answerAfterReceipt: null,
      prematureReady: true,
      prematureFinish: false,
    },
  );
  const noPrematureAnswer = entries.filter((entry) => entry.id !== "premature");
  assert.deepEqual(
    managerReadyAnswer(contents(noPrematureAnswer.slice(0, 3)), branch, lead),
    {
      receipt: true,
      answer: null,
      answerAfterReceipt: null,
      prematureReady: false,
      prematureFinish: false,
    },
  );
  assert.equal(
    managerReadyAnswer(contents(noPrematureAnswer), branch, lead).answer?.id,
    "answer",
  );
  const missingReceipt = managerReadyAnswer(
    contents(noPrematureAnswer.filter((entry) => entry.id !== "receipt")),
    branch,
    lead,
  );
  assert.equal(missingReceipt.answer?.id, "answer");
  assert.equal(missingReceipt.answerAfterReceipt, null);
  assert.equal(
    managerReadyAnswer(contents(entries), branch, lead).prematureReady,
    true,
  );
  assert.equal(
    managerReadyAnswer(contents(entries), branch, "wrong-lead")
      .answerAfterReceipt,
    null,
  );
  const prematureFinish = [
    ...noPrematureAnswer.slice(0, 4),
    {
      type: "message",
      id: "finish-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "finish-tool-call",
            name: "message_staff",
            arguments: { message: "MANAGER_RECOVERY_FINISH" },
          },
        ],
      },
    },
    ...noPrematureAnswer.slice(4),
  ];
  assert.equal(
    managerReadyAnswer(contents(prematureFinish), branch, lead).prematureFinish,
    true,
  );
});

test("Manager READY timeout diagnostics recognize exact project-message receipts", () => {
  const branch = "manager-recovery";
  const receipt = {
    type: "custom_message",
    customType: "pi-herdsman-project_message",
    details: { branch, fromSessionId: "lead-id" },
    content: `Project ${branch} from lead lead-id:\n\nMANAGER_RECOVERY_READY`,
  };
  for (const [entry, expected] of [
    [receipt, true],
    [{ ...receipt, details: { ...receipt.details, branch: "other" } }, false],
    [{ ...receipt, details: { fromSessionId: "wrong-lead" } }, false],
    [{ ...receipt, details: undefined }, false],
    [
      {
        ...receipt,
        content:
          "Project manager-recovery from lead wrong-lead:\n\nMANAGER_RECOVERY_READY",
      },
      false,
    ],
    [
      {
        ...receipt,
        content: `Project ${branch} from lead lead-id to chief chief-id: MANAGER_RECOVERY_READY`,
      },
      false,
    ],
    [{ ...receipt, customType: "pi-herdsman-lead_message" }, false],
  ])
    assert.equal(
      managerReadyEntryEvidence(JSON.stringify(entry), branch, "lead-id").some(
        (evidence) => evidence.receipt,
      ),
      expected,
    );
});

test("Manager READY receipts require exact branch and non-empty expected Lead ID", () => {
  const branch = "manager-recovery";
  for (const leadSessionId of [undefined, "", null, 0, false]) {
    const contents = [
      {
        type: "custom_message",
        customType: "pi-herdsman-project_message",
        details: { branch, fromSessionId: leadSessionId },
        content: `Project ${branch} from lead ${leadSessionId}:\n\nMANAGER_RECOVERY_READY`,
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: "PI_HERDSMAN_MANAGER_RECOVERY_READY",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const answer = managerReadyAnswer(contents, branch, leadSessionId);
    assert.equal(answer.receipt, false);
    assert.ok(
      answer.answer,
      "marker detection must not depend on receipt identity",
    );
    assert.equal(answer.answerAfterReceipt, null);
    assert.equal(
      managerReadyEntryEvidence(contents, branch, leadSessionId).some(
        (evidence) => evidence.receipt,
      ),
      false,
    );
  }
});

test("ID-only Lead identity resolves only exact bounded isolated session", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  try {
    const contents = JSON.stringify({ type: "session", id: "lead-id" });
    await writeFile(join(piSessions, "opaque.jsonl"), contents);
    assert.equal(
      (await exactIsolatedSession({ paths: { piSessions } }, "lead-id"))
        ?.contents,
      contents,
    );
    assert.equal(
      await exactIsolatedSession({ paths: { piSessions } }, "other"),
      undefined,
    );
    await writeFile(join(piSessions, "duplicate.jsonl"), contents);
    await assert.rejects(
      exactIsolatedSession({ paths: { piSessions } }, "lead-id"),
      /ambiguous/,
    );
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
});

test("chief-tree requires a persisted post-Chief turn and targets the pre-Chief assistant branch", () => {
  const contents = [
    { type: "session", id: "session" },
    {
      type: "message",
      id: "startup-user",
      message: { role: "user", content: "startup prompt" },
    },
    {
      type: "message",
      id: "startup-answer",
      parentId: "startup-user",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      },
    },
    {
      type: "custom",
      id: "chief-state",
      parentId: "startup-answer",
      customType: "pi-herdsman-chief-state",
    },
    {
      type: "message",
      id: "chief-user",
      parentId: "chief-state",
      message: { role: "user", content: "post-Chief prompt" },
    },
    {
      type: "custom",
      id: "turn-metadata",
      parentId: "chief-user",
      customType: "pi-usage",
    },
    {
      type: "message",
      id: "chief-answer",
      parentId: "turn-metadata",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(
    chiefTreeBranchPlan(
      contents,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ),
    { targetId: "startup-answer" },
  );

  const noPostChiefTurn = contents.split("\n").slice(0, 3).join("\n");
  assert.match(
    chiefTreeBranchPlan(
      noPostChiefTurn,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /one completed Chief turn/,
  );
  const extraTurn = `${contents}\n${JSON.stringify({
    type: "message",
    id: "unexpected-answer",
    parentId: "chief-answer",
    message: { role: "assistant", stopReason: "stop", content: "" },
  })}`;
  assert.match(
    chiefTreeBranchPlan(
      extraTurn,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /unexpected completed model turn/,
  );
  const extraPrompt = `${contents}\n${JSON.stringify({
    type: "message",
    id: "unexpected-user",
    parentId: "chief-answer",
    message: { role: "user", content: "unrequested prompt" },
  })}`;
  assert.match(
    chiefTreeBranchPlan(
      extraPrompt,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /unexpected user prompt/,
  );
});

test("chief-tree selector locates the unique selected preview and reads the visible footer count", () => {
  assert.deepEqual(chiefTreeFooter("tree rows\n  (7/19)\n"), {
    selected: 7,
    total: 19,
  });
  assert.equal(chiefTreeFooter("tree rows\nnot a footer"), null);
  assert.equal(chiefTreeFooter("(0/0)"), null);
  assert.equal(
    chiefTreeSelectedRow(
      "    › ├─ • assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    true,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "  │  › └─ assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    true,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "    ├─ • assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "› assistant: PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
  assert.equal(
    chiefTreeSelectedRow(
      [
        "› assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
        "› assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      ].join("\n"),
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
});

test("nested pane input returns raw Herdr output and targets the exact isolated pane", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const rawOutput = { stdout: "pane input accepted", stderr: "", pid: 123 };
  const result = await nestedPaneInput(
    ctx,
    ["pane", "send-text", "w1:p2", "/chief"],
    async (file, args, options) => {
      assert.equal(file, "herdr");
      assert.deepEqual(args, ["pane", "send-text", "w1:p2", "/chief"]);
      assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
      assert.equal(options.env.HERDR_SOCKET_PATH, undefined);
      assert.equal(options.env.HERDR_WORKSPACE_ID, undefined);
      return rawOutput;
    },
  );
  assert.equal(result, rawOutput);
});

test("nested pane text reads bounded Herdr stdout without JSON parsing", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const screen = "startup Lead branch\n>";
  const text = await nestedPaneText(
    ctx,
    "w1:p2",
    "visible",
    async (file, args, options) => {
      assert.equal(file, "herdr");
      assert.deepEqual(args, [
        "pane",
        "read",
        "w1:p2",
        "--source",
        "visible",
        "--lines",
        "120",
      ]);
      assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
      return { stdout: screen, stderr: "", pid: 123 };
    },
  );
  assert.equal(text, screen);
});

test("pane commands use one atomic pane run", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const calls = [];
  for (const command of ["/manager leave", "/chief"])
    await submitPaneCommand(ctx, "w1:p2", command, async (file, args) => {
      calls.push(args);
      return { stdout: "", stderr: "", pid: 123 };
    });
  assert.deepEqual(calls, [
    ["pane", "run", "w1:p2", "/manager leave"],
    ["pane", "run", "w1:p2", "/chief"],
  ]);
});

test("Chief tree probe is opt-in, last in root extension order, and validates three tool snapshots", () => {
  const config = {
    candidateExtension: "/candidate/dist/index.js",
    herdrStateExtension: "/isolated/herdr-agent-state.ts",
    model: "provider/model:high",
  };
  assert.deepEqual(candidateArgs(config), [
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--model",
    config.model,
  ]);
  const args = candidateArgs({
    ...config,
    simulatedProviderExtension: "/isolated/smoke-faux.mjs",
    chiefTreeProbeExtension: "/isolated/chief-tree-tools.mjs",
  });
  assert.deepEqual(args.slice(args.indexOf("--extension")), [
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--extension",
    "/isolated/smoke-faux.mjs",
    "--extension",
    "/isolated/chief-tree-tools.mjs",
    "--model",
    config.model,
  ]);
  const resultPath = "/tmp/pi-herdsman-smoke/chief-tree-tools.json";
  const source = chiefTreeProbeSource(resultPath);
  assert.match(source, /getActiveTools/);
  assert.match(source, /session_tree/);
  assert.match(source, /smoke-tools/);
  assert.match(source, /appendFileSync/);
  assert.doesNotMatch(source, /Date\.now|appendFile\(/);
  const snapshots = parseToolSnapshots(
    [
      '{"label":"lead","tools":["chief","agent"]}',
      '{"label":"chief","tools":["staff"]}',
      '{"label":"tree","tools":["staff"]}',
    ].join("\n"),
  );
  assert.deepEqual(snapshots.get("lead"), ["agent", "chief"]);
  assert.notDeepEqual(snapshots.get("chief"), snapshots.get("lead"));
  assert.deepEqual(snapshots.get("tree"), snapshots.get("chief"));
  assert.deepEqual(
    parseToolSnapshots(
      '{"label":"lead","tools":[]}\n{"label":"lead","tools":[]}',
    ).get("lead"),
    [],
  );
});

test("Chief tree snapshots accept identical duplicate events but reject conflicts", () => {
  assert.deepEqual(
    [
      ...parseToolSnapshots(
        '{"label":"tree","tools":["a"]}\n{"label":"tree","tools":["a"]}',
      ).get("tree"),
    ],
    ["a"],
  );
  assert.throws(
    () =>
      parseToolSnapshots(
        '{"label":"tree","tools":["a"]}\n{"label":"tree","tools":["b"]}',
      ),
    /conflicting tree/,
  );
});

test("Chief tree branch wait requires an event added after the baseline", () => {
  const snapshots = new Map([
    ["lead", []],
    ["chief", []],
    ["tree", []],
  ]);
  const baselineContents = '{"label":"tree","tools":[]}';
  const treeEventsBefore = countChiefTreeEvents(baselineContents);
  const delayedCount = countChiefTreeEvents(baselineContents, treeEventsBefore);
  assert.equal(delayedCount, 0);
  assert.deepEqual(
    chiefTreeBranchTransition(
      "branch opening",
      snapshots,
      treeEventsBefore,
      delayedCount,
    ),
    {
      done: false,
      value: undefined,
      progress: { treeEvents: 0, treeSnapshot: false },
    },
  );
  assert.deepEqual(
    chiefTreeBranchTransition(
      "Summarize branch?",
      snapshots,
      treeEventsBefore,
      delayedCount,
    ),
    {
      done: true,
      value: { state: "summary-dialog", treeEventsBefore, treeEvents: 0 },
      progress: { state: "summary-dialog" },
    },
  );
  const afterSelection = `${baselineContents}\n{"label":"tree","tools":[]}`;
  const freshCount = countChiefTreeEvents(afterSelection, treeEventsBefore);
  assert.equal(freshCount, 1);
  assert.deepEqual(
    chiefTreeBranchTransition(
      "branch opened",
      snapshots,
      treeEventsBefore,
      freshCount,
    ),
    {
      done: true,
      value: { state: "tree-loaded", treeEvents: 1 },
      progress: { treeEvents: 1, treeSnapshot: true },
    },
  );
});

test("core requires the prompt-correlated root assistant marker, not root status", () => {
  const prompt = "delegate the task";
  const marker = "PI_HERDSMAN_SMOKE_OK pi-herdsman@0.16.0";
  const contents = [
    { type: "message", id: "user", message: { role: "user", content: prompt } },
    {
      type: "message",
      id: "answer",
      parentId: "user",
      message: { role: "assistant", stopReason: "stop", content: marker },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  for (const status of ["idle", "done"])
    assert.equal(
      assistantResultForSession({ status, contents: "" }, prompt, marker),
      null,
    );
  assert.equal(
    assistantResultForSession({ contents }, prompt, marker)?.id,
    "answer",
  );
});

test("continuation accepts a prefixed marker only in the stopped response descended from its exact prompt", () => {
  const prompt = "continue the saved session";
  const marker = "PI_HERDSMAN_CONTINUATION_SECOND";
  const contents = [
    {
      type: "message",
      id: "other-user",
      message: { role: "user", content: "unrelated prompt" },
    },
    {
      type: "message",
      id: "other-answer",
      parentId: "other-user",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: `pi-herdsman ${marker}`,
      },
    },
    {
      type: "message",
      id: "followup",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "response",
      parentId: "followup",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: `pi-herdsman ${marker}`,
      },
    },
    {
      type: "message",
      id: "unfinished",
      parentId: "followup",
      message: { role: "assistant", stopReason: "toolUse", content: marker },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.deepEqual(
    continuationResultsForPrompt(contents, prompt, marker).map(
      (entry) => entry.id,
    ),
    ["response"],
  );
  assert.equal(assistantResultForSession({ contents }, prompt, marker), null);
});

test("core counts distinct non-root pane/PID processes with both extension paths, without role labels", async () => {
  assert.equal(
    distinctPaneCount([
      { paneId: "same", pid: 1 },
      { paneId: "same", pid: 2 },
    ]),
    1,
  );
  assert.equal(
    distinctPaneCount([
      { paneId: "child", pid: 1 },
      { paneId: "scout", pid: 2 },
    ]),
    2,
  );
  const panes = listedPanes({
    panes: [
      { pane_id: "root", definition: "lead" },
      { pane_id: "child-pane" },
      { pane_id: "grandchild-pane" },
      { pane_id: "unrelated-pane" },
    ],
  });
  const response = {
    "child-pane": {
      process_info: {
        foreground_processes: [
          {
            pid: 11,
            argv: [
              "pi",
              "--extension",
              "/candidate/dist/index.js",
              "--extension",
              "/isolated/herdr-agent-state.ts",
            ],
          },
          { pid: 11, cmdline: "duplicate same process" },
        ],
      },
    },
    "grandchild-pane": {
      process_info: {
        foreground_processes: [
          {
            pid: 21,
            cmdline:
              "pi --extension /candidate/dist/index.js --extension /isolated/herdr-agent-state.ts",
          },
        ],
      },
    },
    "unrelated-pane": {
      process_info: {
        foreground_processes: [
          { pid: 31, cmdline: "pi --extension /candidate/dist/index.js" },
        ],
      },
    },
  };
  const result = await inspectPaneProcesses(
    panes,
    "root",
    async (paneId) => response[paneId],
    "/candidate/dist/index.js",
    "/isolated/herdr-agent-state.ts",
  );
  assert.deepEqual(
    result.verified.map(({ paneId, pid }) => [paneId, pid]),
    [
      ["child-pane", 11],
      ["grandchild-pane", 21],
    ],
  );
  assert.equal(result.verified.length, 2);
  assert.ok(
    result.verified.every(
      (record) => !("identity" in record) && !("definition" in record),
    ),
  );
});

test("process evidence requires both exact extension paths and excludes root pane", async () => {
  const result = await inspectPaneProcesses(
    ["root", "missing-extension", "missing-pane"],
    "root",
    async (paneId) => {
      if (paneId === "missing-pane") throw new Error("pane disappeared");
      return {
        process_info: {
          foreground_processes: [
            { pid: 42, cmdline: "pi --extension /candidate/dist/index.js" },
          ],
        },
      };
    },
    "/candidate/dist/index.js",
    "/isolated/herdr-agent-state.ts",
  );
  assert.deepEqual(result.verified, []);
  assert.deepEqual(
    result.records.map(({ paneId, processMatch, error }) => [
      paneId,
      processMatch,
      error,
    ]),
    [
      ["missing-extension", false, null],
      ["missing-pane", false, "pane disappeared"],
    ],
  );
});

test("Linux Pi process-title evidence requires an exact title and valid PID", async () => {
  const result = await inspectPaneProcesses(
    ["candidate"],
    "root",
    async () => ({
      process_info: {
        foreground_processes: [
          { pid: 42, name: "pi", argv: ["pi"], cmdline: "pi" },
          { pid: 43, name: "Pi", argv: ["pi"], cmdline: "pi" },
          { pid: 44, name: "pi", argv: ["pi", "--extension"], cmdline: "pi" },
          { pid: "45", name: "pi", argv: ["pi"], cmdline: "pi" },
          {
            pid: 46,
            name: "pi",
            argv: ["pi"],
            cmdline: "pi --extension /candidate/dist/index.js",
          },
          {
            pid: 47,
            name: "pi",
            argv: ["pi", "--extension", "/wrong/extension.js"],
            cmdline:
              "pi --extension /candidate/dist/index.js --extension /isolated/herdr-agent-state.ts",
          },
        ],
      },
    }),
    "/candidate/dist/index.js",
    "/isolated/herdr-agent-state.ts",
  );

  assert.deepEqual(
    result.verified.map(({ pid, processMatchSource }) => [
      pid,
      processMatchSource,
    ]),
    [[42, "process-title"]],
  );
});

test("process-info protocol violations escape pane inspection immediately", async () => {
  await assert.rejects(
    inspectPaneProcesses(
      ["child"],
      "root",
      async () =>
        parseHerdrOutput('{"result":{"process_info":{}}}', [
          "pane",
          "process-info",
        ]),
      "/candidate/dist/index.js",
      "/isolated/herdr-agent-state.ts",
    ),
    { code: "SMOKE_PROTOCOL" },
  );
});

test("best-effort process diagnostics retain protocol failures as evidence", async () => {
  assert.deepEqual(
    await bestEffortProcessDiagnostics(
      ["child"],
      "root",
      async () =>
        parseHerdrOutput('{"result":{"process_info":{}}}', [
          "pane",
          "process-info",
        ]),
      "/candidate/dist/index.js",
      "/isolated/herdr-agent-state.ts",
    ),
    { error: "herdr pane process-info returned no result envelope" },
  );
});

test("passive retirement evidence matches exact identity and rejects duplicate or waking delivery", () => {
  const identity = ["repo", "feature", "lead-session"] as const;
  const previous = {
    type: "message",
    id: "prior",
    message: { role: "assistant", content: "done" },
  };
  const notice = {
    type: "custom_message",
    customType: "pi-herdsman-project_retired",
    display: false,
    details: {
      repoKey: identity[0],
      branch: identity[1],
      assignmentId: identity[2],
    },
  };
  const transcript = (entries: unknown[]) =>
    entries.map((entry) => JSON.stringify(entry)).join("\n");
  const before = transcript([previous]);
  const after = transcript([previous, notice]);
  assert.deepEqual(retirementNoticeEntries(after, ...identity), [notice]);
  assert.deepEqual(
    assertPassiveRetirementEvidence(before, after, ...identity),
    notice,
  );
  for (const details of [
    { ...notice.details, repoKey: "elsewhere" },
    { ...notice.details, branch: "other" },
    { ...notice.details, assignmentId: "replacement" },
  ]) {
    const wrong = transcript([previous, { ...notice, details }]);
    assert.deepEqual(retirementNoticeEntries(wrong, ...identity), []);
    assert.throws(() =>
      assertPassiveRetirementEvidence(before, wrong, ...identity),
    );
  }
  for (const entries of [
    [previous, notice, notice],
    [notice],
    [previous, { ...notice, display: true }],
    ...["user", "assistant", "toolResult", "system"].map((role) => [
      previous,
      notice,
      { type: "message", message: { role } },
    ]),
  ])
    assert.throws(() =>
      assertPassiveRetirementEvidence(before, transcript(entries), ...identity),
    );
});

test("external removal variant is smoke-only and scoped to manager-recovery", () => {
  assert.equal(
    parseSmokeArgs(["manager-recovery"]).managerExternalRemoval,
    false,
  );
  assert.equal(
    parseSmokeArgs(["manager-recovery", "--manager-external-removal"])
      .managerExternalRemoval,
    true,
  );
  assert.throws(
    () => parseSmokeArgs(["core", "--manager-external-removal"]),
    /only valid for manager-recovery/,
  );
  assert.throws(
    () =>
      parseSmokeArgs([
        "manager-recovery",
        "--simulated",
        "--manager-external-removal",
      ]),
    /does not support --simulated/,
  );
});

test("Manager removal variants target only the exact owned checkout without force", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "smoke-removal-contract-")),
  );
  try {
    const primary = join(root, "project");
    const checkout = join(root, "checkout");
    const common = join(primary, ".git");
    const otherCommon = join(root, "other-git");
    await mkdir(common, { recursive: true });
    await mkdir(checkout);
    await mkdir(otherCommon);
    for (const scenario of [
      "herdr",
      "git",
      "wrong topology",
      "wrong owner",
      "wrong primary",
      "wrong branch",
      "wrong repository",
      "remove failure",
    ]) {
      const branch = "herdsman/smoke-manager-recovery-exact";
      const workspaceId = "owned-workspace";
      const ctx = {
        paths: { root },
        primaryCheckoutPath: scenario === "wrong primary" ? checkout : primary,
        managerExternalRemoval: scenario !== "herdr",
        managerRecovery: { branch, worktreePath: checkout, workspaceId },
        owned: {
          managerBranch: scenario === "wrong owner" ? "other" : branch,
          managerWorktreePath: checkout,
          managerWorkspaceId: workspaceId,
          managerWorktreeRetirementRequested: false,
        },
      };
      const mutations: unknown[] = [];
      const execute = async (
        file: string,
        args: string[],
        options: { cwd: string },
      ) => {
        assert.equal(file, "git");
        if (args[0] === "worktree") {
          mutations.push({ file, args, options });
          if (scenario === "remove failure")
            throw new Error("Git refused removal");
          return { stdout: "" };
        }
        if (args.includes("--show-toplevel"))
          return { stdout: `${checkout}\n` };
        if (args[0] === "branch")
          return {
            stdout: `${scenario === "wrong branch" ? "other" : branch}\n`,
          };
        return {
          stdout: `${scenario === "wrong repository" && options.cwd === checkout ? otherCommon : common}\n`,
        };
      };
      const control = async (_ctx: unknown, args: string[]) => {
        mutations.push(args);
      };
      const topology = [
        {
          branch,
          path: checkout,
          open_workspace_id:
            scenario === "wrong topology" ? "unowned" : workspaceId,
        },
      ];
      const remove = () =>
        removeManagerRecoveryWorktree(ctx, topology, execute, control);
      if (scenario === "herdr" || scenario === "git") {
        await remove();
        assert.equal(mutations.length, 1);
        assert.deepEqual(
          mutations[0],
          scenario === "herdr"
            ? ["worktree", "remove", "--workspace", workspaceId]
            : {
                file: "git",
                args: ["worktree", "remove", "--", checkout],
                options: { cwd: primary },
              },
        );
        assert.equal(ctx.owned.managerWorktreeRetirementRequested, true);
      } else {
        await assert.rejects(remove);
        assert.equal(
          mutations.length,
          scenario === "remove failure" ? 1 : 0,
          scenario,
        );
        assert.equal(
          ctx.owned.managerWorktreeRetirementRequested,
          scenario === "remove failure",
          scenario,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
