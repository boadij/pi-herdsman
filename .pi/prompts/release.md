---
description: Validate and squash an eligible Pi Herdsman Release Please PR, then verify exact published release notes.
argument-hint: "[additional instructions]"
---

Run from the trusted Pi Herdsman checkout root, exclusively against
`github.com/boadij/pi-herdsman`. Supplemental instructions may refine copy
or Discord recap scope, not the target, authority, or safeguards:

${@:-None provided.}

1. Confirm this is a Herdsman Lead and project `release-drafter` and bundled
   `ship` are eligible in the effective roster. While CI runs, delegate one
   read-only preflight to `release-drafter`. Require one pinned candidate,
   complete evidence, an exact proposed API squash `commit_title` and
   `commit_message` (including `""` when empty), a separately expected
   stored Git message, one verified contributor roster, and both delimited
   drafts. Multiple eligible candidates require maintainer selection and a
   focused drafter continuation. Missing evidence or moved refs block.
2. Review the complete immutable drafter result and outgoing material. Extract
   exactly one ordered, non-overlapping pair each of standalone
   `BEGIN RELEASE BODY` / `END RELEASE BODY` and
   `BEGIN DISCORD DRAFT` / `END DISCORD DRAFT` lines. The bytes immediately
   after each opening newline through the start of its closing marker are the
   artifact, including the newline preceding the closing marker. Never trim,
   retype, or normalize. Check pinned PR diff and Release Please provenance,
   stable tag/version, previous-to-proposed readable comparison, contributor
   identities and distinct credits, install/runtime requirements, migration,
   and disclosure. Both drafts must use the same verified roster (unless an
   expressly requested earlier Discord recap expands only Discord scope).
   Discord requires exactly one `{{RELEASE_URL}}`, no other placeholders and
   room for the canonical URL within 1,600 characters.
3. Display the complete exact material to the maintainer, including trailing
   newlines and the SHA-256 of the extracted release-body bytes. Show pinned
   head/base SHAs, the exact proposed API `commit_title` and `commit_message`
   separately from the expected stored message, and both full drafts. Ask for
   three independent answers in one exchange, with this copyable reply:

   ```text
   Squash: yes
   Body only: yes
   No other writer: confirmed
   ```

   The first grants a squash of the shown PR and pinned refs using those
   exact API fields. State that pushing to `main` can trigger Release Please,
   tag/GitHub Release creation, and npm/GHCR publication even if notes are
   withheld. The second grants only updating that release's body to the exact
   displayed artifact from the identified drafter result ref. The third
   confirms no overlapping ship attempt or release-body editor. Invocation,
   silence, ambiguity or one grant do not imply any other grant. Known
   competing writers block; coordination cannot guarantee cross-host exclusion.
4. After both grants and writer confirmation, delegate `ship` one bounded
   assignment with the **actual immutable drafter result ref in `files`**.
   Provide the pinned identity/provenance, complete review evidence, the exact
   approved API fields, expected stored message, release-body SHA-256 and
   distinct grants with their bindings. Evidence alone is not authorization.
   Moved reviewed refs require fresh validation, drafting and approval.
5. `ship` performs the independent live checks below and uses the single
   tested `scripts/release-ship.mjs` executor for final guards, one guarded
   squash, publication lookup, at most one body PATCH and exact readback.
   Do not rebuild the API commands in another language or command layer.
   It takes two local UTF-8 files outside the worktree: a private JSON record
   containing exactly `pr`, `tag`, `base_sha`, `head_sha`, `commit_title`,
   `commit_message`, `expected_stored_message`, `body_sha256`, and
   `drafter_result_ref`, plus the actual transferred drafter result text.
   Bind both to the approved inputs and exact ref. Run:

   ```sh
   node scripts/release-ship.mjs "$record_file" "$drafter_result_file"
   ```

   Do not invoke before authorization and live preflight. The executor is not
   a consent system. Inspect its structured result. Never retry an uncertain
   write; reconcile the actual server state and stop on unverifiable outcomes.
6. If a required Actions run truly needs approval, identify the exact pending
   run/attempt, event, repository, PR association and reviewed head and stop.
   Only a human operator may independently reverify and approve that run.
   Resume with a fresh `ship` assignment carrying the original drafter and
   prior `ship` result refs and approval evidence in `files`; repeat live
   checks and preserve the still-valid grants. An `action_required` status or
   empty pending-deployments list alone does not establish the approval kind.
7. Report checks, squash SHA, release URL, and exact body readback separately,
   including partial or blocked states. **Only after verified notes readback**,
   replace the original Discord draft's single `{{RELEASE_URL}}` token with
   the canonical URL and change nothing else. Check version, roster,
   migration, install command, placeholders, and the 1,600-character limit.
   Return complete copy-ready Markdown without posting. On a material copy
   discrepancy, continue the drafter with the original drafter and completed
   ship refs for a focused correction, not a repeat research pass.

## Live checks owned by `ship`

- Use authenticated native `gh` and Git from the trusted checkout, with
  `gh api --hostname github.com repos/boadij/pi-herdsman/...` and
  `-R github.com/boadij/pi-herdsman` on typed commands. Read branch protection
  and effective active/inherited rulesets. A permission failure is not proof
  of absence. Verify all required contexts against GitHub's evaluated SHA and
  required app/source, including duplicate check runs and commit statuses;
  `gh pr checks --required` alone does not define policy. If a test-merge SHA
  is used, verify its Git commit has exactly two ordered parents: pinned base
  then pinned head. Check current review/CODEOWNERS and last-push rules,
  conversation resolution, strict up-to-date status, squash eligibility,
  mergeability, and any required merge queue. Legitimately skipped non-required
  jobs are not blockers. Missing, pending, failed, contradictory or unknowable
  gates block; never bypass or enable auto-merge.
- Independently verify upstream PR creator, base/head repo/ref/SHA, pinned
  Release Please provenance and version/tag, current `main` tip, and writer
  coordination. Validate the transferred artifact's byte identity, source
  ref, approved body digest and exact API fields before creating the private
  record. The expected stored Git message is separate from the API message.
  Stop if any binding or permission is uncertain. There must be no other
  GitHub write except the approved squash and at most one body-only PATCH.
- Run the executor immediately after the final live preflight, with no
  intervening model-driven work. It independently rereads main/PR, verifies
  tag and release absence using real HTTP status, sends the head-guarded
  squash payload, checks the sole pinned-base parent and exact stored message,
  verifies published release ID/URL and peeled tag, and compares exact body
  bytes after any conditional PATCH. GitHub's head guard is not an atomic
  expected-base guard. A failure after a write is not proof it failed.
- No local Git writes, direct tag/release creation, registry operations,
  workflow approval/dispatch/rerun, or Discord posting. Do not infer npm or
  GHCR availability from a verified GitHub Release.

On the next authorized real release, measure unnecessary calls, approval
turns, and squash-to-body-readback time separately from CI and publication
waits. Never run a release solely to test this procedure.
