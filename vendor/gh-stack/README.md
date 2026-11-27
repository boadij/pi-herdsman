# GitHub Stacks reference snapshot

[SKILL.md](SKILL.md) and [references/](references/) are unchanged copies of
`github/gh-stack:skills/gh-stack/` at the upstream commit in
[source.json](source.json). Copyright GitHub, Inc., distributed under the
upstream MIT [license](LICENSE) from that commit.

This project-local reference is explicitly attached only to the Ship Agent.
It does not install the `gh stack` extension, enable GitHub Stacks, authorize
writes, or override the repository's delivery safeguards. Check availability
and command side effects before use.

The weekly **Update vendored GitHub skills** workflow checks both official
upstream sources and proposes verified snapshots in one maintenance PR. Merging
that PR is the acceptance boundary; the workflow never merges automatically.
The PR records immutable upstream revisions and changed paths, and normal CI
and human review remain required. Human approval of the workflow may be needed
before the PR's CI runs.

The PR action exclusively owns `automation/upstream-skills`; do not use that
branch for human or Agent commits. Unsupported upstream file structures or a
license change stop automation and require maintainer intervention. Closing an
update PR without merging does not suppress the same update from a later run.
The reconciler preserves upstream bytes, including whitespace.

Before updating an existing automation branch, the workflow compares its full
branch-only tree changes with the current reconciled snapshot. An unexpected or
stale proposal fails closed and leaves the branch and PR untouched; a
maintainer must inspect and resolve it before automation can continue. Unrelated
advances to `main` and a proposal already present on `main` remain safe to
rebase or close.

**Deployment prerequisite:** before enabling the workflow, configure and verify
a narrowly scoped branch ruleset for `automation/upstream-skills` that restricts
creation and updates to the automation actor as appropriate. The GitHub Actions
App needs an **Always allow** bypass for direct branch pushes and branch deletion
while `delete-branch: true` is enabled. This bypass is app-level, not
workflow-specific: any workflow able to obtain a sufficiently write-enabled
`GITHUB_TOKEN` may share it. Without effective protection, a writer can push
after the read-only verification and before the PR action fetches the branch;
the action may then overwrite that work. Do not enable the automation until the
ruleset and bypass behavior have been verified by a maintainer.
