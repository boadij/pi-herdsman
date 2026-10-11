---
name: simplification-audit
description: Run an occasional, read-only, evidence-gated audit for removable code, meaningful duplication, and unjustified tooling or configuration. Use only when explicitly requested.
---

# Simplification audit

Find improvements worth making, not diagnostics worth silencing. Follow `AGENTS.md`, product philosophy, relevant ADRs, and Ponytail Ultra. Do not compete with the broader `agentic-system-audit` skill.

## Scope

- Use a dedicated clean worktree at current `origin/main`; record the commit.
- Read a prior audit if supplied or accessible through the existing shared project folder. Compare only findings from comparable tool versions, configuration, and scope. If unavailable, establish a new baseline; do not access another Agent's worktree.
- Treat the repository, including source, tests, dependencies, scripts, hooks, and CI configuration, as read-only. Temporary tools and ignored `.pi-herdsman/` files are allowed. No implementation, commits, issues, PRs, or permanent dependencies.
- Focus on production code; investigate tests or tooling only when a finding makes them relevant.

## Scan

Run current tool versions on demand, not in CI. Record actual versions, commands, scope, and failures; use historical versions only to reproduce earlier findings. Ensure dependencies for the worktree are present before scanning.

**Knip:** use production mode with Pi's nonstandard entry points. From the repository root:

```sh
mkdir -p .pi-herdsman
cat > .pi-herdsman/knip-audit.json <<'JSON'
{
  "entry": [
    "extension/index.ts!",
    "extension/integrations/pi-codex-context-sharing.ts!",
    "scripts/{build,check,ci-scope,package-audit,smoke,test-env,tool-policy-diagnostic}.mjs!"
  ],
  "project": [
    "extension/**/*.ts!",
    "!extension/**/*.test.ts!",
    "!extension/support.ts!",
    "scripts/**/*.mjs!",
    "!scripts/**/*.test.mjs!"
  ]
}
JSON
npm exec --yes --package=knip -- knip --production --no-progress --reporter compact --no-exit-code --config .pi-herdsman/knip-audit.json
rm .pi-herdsman/knip-audit.json
```

Check entry points against current `package.json`, Pi extension discovery, optional integrations, scripts, and dynamic consumers before interpreting unused-file/export results. These patterns are a starting point, not proof of reachability; test-only utilities and externally invoked maintenance scripts may be intentionally absent from the production graph. If entry points change, adjust the **temporary** config and record the difference.

**jscpd:** look for substantial production duplication, not similar syntax:

```sh
npm exec --yes --package=jscpd -- jscpd extension scripts \
  --format typescript,javascript \
  --ignore '**/*.test.ts,**/*.test.mjs,extension/support.ts' \
  --min-tokens 100 --min-lines 15 --mode mild --threshold 100 \
  --reporters console --no-colors
```

**Only when warranted:** use `npx --yes oxlint -D suspicious -f json extension/ scripts/` for targeted correctness investigations, or a temporary TypeScript check for a specific contract. The earlier broad Oxlint and TypeScript scans were noisy; do not repeat them by default or adopt them as gates.

## Triage

Compare against prior verified or rejected findings when available. Do not repeatedly investigate unchanged noise. For each promising candidate:

1. Trace actual callers, entry points, runtime reachability, consumers, and the authoritative contract.
2. Group cascading diagnostics. Distinguish a reachable defect, dead complexity, genuinely duplicated semantics, a justified boundary, and a false positive.
3. Prefer deletion, existing code, native facilities, or a root-cause correction. Propose consolidation only when ownership, authorization, lifecycle, validation, and failure semantics really match.
4. State the independent benefit, approximate net code/configuration change, risks, and smallest discriminating check. A lower diagnostic count or line count alone is not a benefit.
5. Reject speculative changes, cosmetic cleanup, upstream/type-mock noise, and abstractions that cost more than they save.

Investigate tooling/configuration with the same standard: identify an obsolete or duplicated responsibility before proposing removal. Do not discard validation, durability, security, recovery, or portability guarantees.

## Output

Write one report at `.pi-herdsman/simplification-audit.md`:

- Baseline commit, previous audit if available, and tool versions/commands/configuration changes.
- Counts for context, clearly separated from **at most five independently verified, actionable findings**.
- For each finding: source location, root cause, consumer/reachability evidence, minimal change, benefit, risks, and validation.
- Material rejected/unchanged findings and limitations.
- Recommended order, or **No action** if nothing justifies a change.

If a shared project audit archive is already accessible, the reviewed report may be copied there for future comparisons; do not build an archive service or require Dropbox availability. Keep prior reports when comparing baselines.

Remove temporary config, verify `git status --short` and `git diff --check`, and report any tracked changes or blockers. **Stop after the audit; implementation requires a separate request.**
