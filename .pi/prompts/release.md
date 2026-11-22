---
description: Prepare, approve, and ship a Pi Herdsman release with Release Please.
argument-hint: "[additional instructions]"
---

Run from the trusted Pi Herdsman checkout root. Only operate on
`github.com/boadij/pi-herdsman`. Additional instructions may refine copy or
Discord recap scope, never the target or safety requirements:

${@:-None provided.}

1. **Draft once.** Confirm this is an eligible Herdsman Lead with project
   `release-drafter` and bundled `ship` available. While CI runs, delegate
   one read-only preflight to the drafter. Require a verified Release Please
   candidate, pinned PR/base/head SHAs and proposed version/tag, supporting
   evidence, contributor roster, proposed squash API `commit_title` and
   `commit_message` (explicitly `""` if empty), and complete GitHub Release
   and Discord drafts. If multiple eligible PRs exist, ask the maintainer to
   select one. Resolve missing or contradictory evidence before proceeding.
2. **Review.** Use the complete drafter result without repeating its research.
   Check the release diff, provenance, version, migration, installation,
   contributors and public-disclosure safety. Preserve verified credits.
   Extract the text between the drafter's standalone `BEGIN RELEASE BODY` /
   `END RELEASE BODY` and `BEGIN DISCORD DRAFT` / `END DISCORD DRAFT`
   markers without rewriting it. Discord must contain one `{{RELEASE_URL}}`,
   no other placeholders, and fit 1,600 characters with the final URL.
3. **Authorize once.** Show the complete proposed release body, Discord draft,
   pinned PR refs, and exact squash API title/message. Distinguish the API
   `commit_message` from the resulting Git commit's stored message. Explain
   that squash merging may trigger tag, GitHub Release, npm and GHCR publication
   even if the custom notes are not applied. Ask for independent approval of
   (a) this squash, (b) updating only the resulting release body to the
   displayed content, and (c) confirmation that no competing release writer
   is active. A copyable reply is:

   ```text
   Squash: yes
   Body only: yes
   No other writer: confirmed
   ```

   Silence, invocation, or ambiguous replies are not consent. Both grants and
   writer confirmation are required for the normal workflow. If the candidate
   or approved content changes, get fresh approval. A confirmation is not a
   cross-host lock.
4. **Ship once.** Give `ship` the actual immutable drafter result ref in
   `delegate_agent.files`, pinned candidate and provenance, review evidence,
   approved content, exact approved API fields, and distinct grants. The Agent
   independently verifies live eligibility and performs only the authorized
   squash and, if needed, one body-only update. The shipping procedure below
   is its complete contract. No local Git writes, tag/release creation,
   registry operations, workflow dispatch/rerun/approval, or Discord posting.
5. **Report.** Return checks, merge SHA, release URL and notes readback as
   distinct outcomes, including partial failures. Only after verified notes
   readback, replace the Discord draft's single `{{RELEASE_URL}}` with the
   canonical URL, check the 1,600-character limit and return copy-ready
   Markdown without posting. Correct material copy errors using the original
   drafter research, not a new full research pass.

## Shipping procedure for `ship`

- **Check live gates.** Use authenticated native Git and `gh` against the
  explicit upstream repository. Confirm the PR is open, non-draft, from/to
  upstream `main`, has the pinned head/base SHAs and verified Release Please
  provenance. Read effective branch protection/rulesets, required checks on
  GitHub's evaluated commit and their trusted sources, required reviews,
  conversation resolution, up-to-date requirements and mergeability. Verify
  test-merge commit parentage when that SHA supplies required checks.
  `gh pr checks --required` alone is not the full policy. Never bypass
  protection, merge a required queue manually, or assume unknown gates passed.
- **Handle exceptional approvals.** If an Actions run requires human approval,
  verify the exact pending run/attempt, event, repository, PR and head. Stop
  for a separate, direct human approval of that run. Neither Agent approves
  it. Resume with a fresh `ship` preflight and the prior immutable evidence.
- **Recheck before writing.** Immediately before the squash, reread the live
  `main` tip and PR head/base against the approved SHAs. Verify that the
  proposed tag and release are absent: only an explicitly observed HTTP 404
  counts as not found. Permission, rate-limit, network, server, parsing or
  other unknown failures must stop, not be interpreted as absence. Refresh
  any stale review/check evidence. Ensure no known competing writer.
- **Use the approved inputs.** Build the squash JSON with `jq` from the
  approved values and send one `gh api --input` PUT to
  `pulls/$pr/merge` with `sha`, `merge_method: "squash"`,
  `commit_title` and `commit_message`. Preserve an approved empty API
  message. Do not derive it from the expected stored Git message. For the
  notes PATCH, read the approved release body from a file with
  `jq --rawfile` so multiline text and trailing newlines survive. Never
  interpolate public draft text into executable shell code.
- **Verify and reconcile.** Read the merged PR and squash commit; require
  the reviewed head, sole expected base parent and approved commit metadata.
  On an uncertain PUT result, inspect GitHub state instead of retrying.
  Wait only for the verified published release, and verify its identity,
  canonical URL and peeled tag target the squash commit, not merely
  `target_commitish`. Skip the notes PATCH if the body already matches;
  otherwise issue at most one body-only PATCH. Read back the release by ID
  and compare the stored body with the approved content. On an uncertain
  PATCH, read back without retrying. Withhold the announcement if publication
  or notes cannot be verified; do not infer npm/GHCR availability.

Stop and report the specific blocker whenever evidence, permission, identity
or authorization is missing. Do not run a release solely to test this procedure.
