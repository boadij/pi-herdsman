# GitHub CLI reference snapshot

[SKILL.md](SKILL.md) is an unchanged copy of
`cli/cli:skills/gh/SKILL.md` at the upstream commit in
[source.json](source.json). Copyright (c) 2019 GitHub Inc., distributed under the
upstream MIT [license](LICENSE) from that commit.

This is optional reference material, outside automatic skill discovery.
An agent can explicitly select `./vendor/github-cli/SKILL.md` from the
repository root. Its examples include write operations and preview commands; they
do not authorize writes or establish support in the installed CLI.

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

Before invoking the PR action, the workflow checks the existing branch's
changes from its merge base with `main`. Only managed snapshot files in
ordinary, non-executable Git mode may change. It rejects conflicting PRs but
does not require the old proposal to match the new snapshot or have a PR.
This lets the action refresh successive updates, retire obsolete proposals,
and recover if a branch push succeeded but PR creation failed.

**Deployment authorization:** Leave the repository Actions variable
`VENDORED_SKILLS_PR_ENABLED` unset until a maintainer verifies effective
writer protection for `automation/upstream-skills` and that the Actions token
can create and update PRs and push and delete the reserved branch. Only the
exact value `true` authorizes the PR action; any other value disables all its
branch and PR writes, including deletion. The variable records maintainer
authorization, not proof of settings or an atomic safety guarantee.

Restrict creation, updates, and deletion of the reserved branch to the
automation actor. A ruleset bypass for the GitHub Actions App must permit
direct writes and deletion; it is app-level, not workflow-specific. Other
workflows with sufficiently write-enabled tokens can share it. The PR action
fetches the branch separately after verification, so the read-only checks
cannot protect against other writers in that interval.
