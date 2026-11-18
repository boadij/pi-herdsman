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

## Changelog ownership

`CHANGELOG.md` is maintained by **Release Please**, which generates release entries from Conventional Commit messages in the merged Git history.

- **Do not manually edit `CHANGELOG.md`** in ordinary feature, bug-fix, refactoring, or documentation PRs.
- Use accurate Conventional Commit titles (for example, `feat(agent): ...` or `fix(config): ...`) so Release Please can categorize changes correctly.
- Release Please release PRs are responsible for generating and updating changelog entries.
- Manual corrections to existing changelog content are permitted only as explicitly scoped maintenance, not as part of routine feature or fix documentation.

**In short:** Describe changes through Conventional Commits, not manual changelog entries.

## Release operations

The maintainer-only `/release` workflow runs from a source checkout. Start a
Herdsman Lead in Herdr at the root of a clean `boadij/pi-herdsman` checkout
with compatible Pi and Herdr versions and the GitHub CLI (`gh`). Review the
checkout before approving it in Pi: project trust enables the
`.pi/prompts/release.md` prompt and the project `release-drafter` Agent.
The Git and GitHub executor `ship` is bundled with Herdsman; this workflow's
release policy comes from the project prompt and the task it assigns to
`ship`. In `/herdsman definitions`, confirm both Agents are enabled with
their respective project and bundled provenance, not overridden. If the
Lead has an explicit `agents` allowlist, include both names. Check its
effective delegation roster separately; discovery alone does not grant
delegation.

Use GitHub credentials with the least access needed: read access for
`release-drafter` research; access for `ship` to inspect live repository rules,
checks and reviews, squash-merge the upstream PR, and edit its GitHub Release
body. Only an authorized human operator with the corresponding GitHub
permission may approve workflows, outside `ship`. Pi trust, tool and Agent allowlists,
and Herdsman's `permission` field do not sandbox shell credentials. Keep secrets
out of project files and agent handoffs, and do not use credentials that bypass
repository protections.

### Verify without publishing

Use a fresh clone, an empty `PI_CODING_AGENT_DIR`, no GitHub credentials, and no
resource overrides. Send only `{"type":"get_commands"}` to
`pi --mode rpc --no-session --no-extensions --approve` and check for exactly one
project-scope `release` prompt sourced from `.pi/prompts/release.md`. Repeat with
`--no-approve` and confirm it is absent. In a Lead, inspect
`/herdsman definitions` without editing: `release-drafter` should be enabled
with project provenance only in the trusted checkout; `ship` should be enabled
with bundled provenance in both. Check the Lead's effective delegation roster
in each case. After building and running `npm run package:audit`, verify that
`npm pack --dry-run --json --ignore-scripts` includes the bundled `ship`
definition but neither `.pi/` files nor `CONTRIBUTING.md`. Do not submit
`/release`, delegate `ship`, or make GitHub writes during verification.

### Run a release

1. Run `/release` only for an intended upstream release, with no concurrent
   `ship` attempt or release-body editor. Before requesting grants, verify
   from upstream workflow or repository audit evidence that the open PR was
   created by this repository's Release Please automation. The workflow uses
   `GITHUB_TOKEN` and does not pin a login; do not guess the actor or rely on
   a title, label, branch name, or bot status alone. Require both sides to be
   in upstream `boadij/pi-herdsman`, with base `main` and the expected
   Release Please-generated head ref. At the reviewed head, confirm that
   the manifest, package and lockfile versions, and changelog entry agree
   with the proposed stable `v<version>` tag and release configuration.
   Stop if the evidence is insufficient or no candidate qualifies; if
   several qualify, resolve which one to use. Pin the verified identity,
   refs and SHAs. Review the draft against the previous published tag through
   the pinned base and inspect the release PR diff separately.
2. Review the exact outgoing squash material and complete Markdown for facts,
   breaking changes, attribution, and public disclosure. Include a deduplicated
   **Authors** line of verified human authors and co-authors, including
   maintainers but excluding bots and release-only metadata. Use plain
   `@handle` text, with optional **Acknowledgments** only for distinct verified
   contributions. Keep research and handoff notes out of the release body.
3. Give separate explicit grants for the guarded squash of the pinned PR
   with the reviewed title and message, and for the body-only update with
   the exact reviewed Markdown for the resulting release. The squash grant
   must explicitly cover the resulting push to `main`, which triggers the
   release workflow. It can create a tag and GitHub Release through Release
   Please and publish to npm and GHCR. Withholding or failing the body update does not stop
   that automation. This is not a grant for direct publication by `ship`.
   Invoking the prompt authorizes neither operation. Workflow approval
   always requires its own direct explicit human grant. Before approving
   outside `ship`, the
   operator verifies true pending approval (not merely `action_required`),
   the exact run, event, repository, PR association, and reviewed head.
   Verify live branch protections and rulesets, required checks and reviews,
   and mergeability; recheck all gates after workflow approval. Do not bypass
   policy, use auto-merge, or proceed if a merge queue is required. Recheck
   candidate provenance, version metadata, and the base and head immediately
   before the matching-head squash. Stop if identity cannot be verified.
   If a ref changed, stop for fresh review, a refreshed draft, and renewed
   authorization before merging. The head guard
   does not lock the base. Verify the resulting squash commit's parent is the
   reviewed base; on mismatch, report the merge and withhold the notes.
4. Poll with a bounded wait for Release Please to create the expected GitHub
   Release. Verify that its tag resolves to the squash commit;
   stop if the release is missing or the commit differs. Never create a
   separate release. As soon as the tag is verified, submit one complete
   body-only update unless the body already matches, then verify the exact
   readback on the same release and tag. Do not wait for npm or container
   publishing or make a follow-up edit for availability. If the write response
   is ambiguous, read back instead of retrying; report uncertainty if the
   intended body cannot be verified.
5. Only after verified readback, obtain the final copy-ready Discord draft.
   Do not post it from the workflow. Check the reported PR, required checks,
   merge SHA, release URL, and body verification before using the draft.

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
