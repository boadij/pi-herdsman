# Contributing

Contributions are welcome. Please keep changes focused and avoid unrelated refactors.

## Issues

Use the Bug Report, Improvement, or Investigation form when it fits; a blank
issue is also fine. Search existing issues and related pull requests first to
avoid duplicates.

Keep reports focused on an independently understandable problem or decision:

- **Bugs:** Expected versus observed behavior, impact, and available
  reproduction or source evidence.
- **Improvements:** Current limitation, motivation, and desired outcome,
  without prematurely prescribing an implementation.
- **Investigations:** The question, known facts and unknowns, and what
  evidence would enable a decision. No change may be the right outcome.

Include relevant versions, dates, commits, environment, related work, and
documentation when known. Distinguish user reports, independently reproduced
behavior, source-supported findings, and hypotheses. Do not invent evidence
or require logs, reproduction steps, or a proposed fix when unavailable.
Include acceptance criteria only when they clarify the intended outcome.
Conventional Commit formatting applies to commits and PR titles, not issues.

## AI-assisted issue creation

Agents creating or substantially revising issues for users should evaluate
the proposal, not merely reformat it. Inspect existing issues and PRs,
current behavior, relevant code and documentation, product boundaries, and
active ADRs to the extent needed to support the claims being made.

Explain material mistakes, duplicates, unsupported assumptions, and conflicts
with existing capabilities or decisions. Offer an evidence-supported,
appropriately scoped alternative. Correct minor inaccuracies without
unnecessary questions, but seek the user's decision before materially
changing the requested scope or outcome. An active ADR is relevant context,
not a ban on explicitly proposing a different architectural decision.

Create an issue when it faithfully represents the user's intent and known
evidence. Otherwise explain why an existing issue, investigation, or no new
issue is more appropriate. Do not claim checks or reproduction that were not
performed. Apply the public disclosure and private security reporting
requirements below.

## Before opening a pull request

Open an issue first for:

- New features
- Breaking changes
- Significant behavioral changes
- Substantial refactors

This allows the proposed direction to be discussed before implementation work begins.

Bug fixes, documentation changes, tests, and small maintenance improvements may be submitted directly as pull requests.

If an issue already exists, link it from the pull request using `Fixes #123` or `Closes #123`.

## Pull requests

- Keep each pull request focused on one change.
- Clearly describe the problem being solved and the approach taken.
- Include relevant tests when behavior changes.
- Run the repository's validation checks before submitting.
- Avoid unrelated formatting or cleanup changes.
- Use a Conventional Commit formatted pull request title.

Pull requests are squash-merged, so the pull request title becomes the commit message on `main` and is used by the release workflow.

Examples:

```text
feat: add delegated launch metadata
fix: preserve cleanup history
docs: clarify container setup
test: cover interrupted delegation
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

Individual commits should follow the same convention, although the pull request title is particularly important because it becomes the squash-merge commit.

## AI-assisted contributions

AI-assisted contributions are welcome, but contributors remain responsible for understanding, reviewing, and testing the code they submit.

## Public disclosure safety

Before publishing, review the actual outgoing changes, commit metadata, issue
and pull request text, logs, screenshots, and attachments. Omit secrets,
confidential content, and unnecessary private personal or infrastructure
information while preserving legitimate attribution and technical evidence.
Do not silently anonymize contributors, change Git identities, or rewrite
history merely because a person's identity is visible.

If a private detail cannot be omitted without altering an authoritative record,
withhold publication and resolve it privately. For accidental disclosures,
avoid repeating the material publicly and promptly revoke exposed credentials.
Agents follow the corresponding policy in `AGENTS.md`.

## Security issues

Please do not report security vulnerabilities in public issues.

Use GitHub's private vulnerability reporting or another private contact method instead.
