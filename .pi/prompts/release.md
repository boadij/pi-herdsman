---
description: Validate and squash-merge an eligible Pi Herdsman Release Please PR, then update its GitHub Release notes.
argument-hint: "[additional instructions]"
---

Run from the trusted Pi Herdsman checkout root. Use only
`github.com/boadij/pi-herdsman`. Supplemental instructions may refine copy
or Discord recap scope, not the target, authority or safeguards:

${@:-None provided.}

1. Confirm this is an eligible Herdsman Lead and project `release-drafter`
   and bundled `ship` are available for delegation; otherwise report the
   specific blocker. While CI runs, assign `release-drafter` one read-only
   /release preflight and research pass: return a pinned candidate record, both
   delimited drafts, and one verified roster (earlier recap expands only
   Discord scope). Stop on missing evidence or moved refs; if several
   candidates verify, ask the maintainer to choose and continue the drafter.
2. Keep the exact drafter result ref and review its complete evidence.
   Extract exactly one ordered, non-overlapping pair each of standalone
   `BEGIN RELEASE BODY` / `END RELEASE BODY` and
   `BEGIN DISCORD DRAFT` / `END DISCORD DRAFT` lines. Slice immediately
   after each opening line ending to the start of its closing marker:
   the newline before each end marker is part of the artifact. Do not
   retype, trim or normalize. Stop on ambiguity, incomplete evidence
   or inability to preserve bytes.
3. Review the pinned release diff/metadata, exact squash API
   `commit_title` and `commit_message` (extra detail, possibly empty),
   and both artifacts for accuracy and disclosure without erasing credits.
   Check headings, install/runtime requirements, migration and readable
   previous-to-proposed-tag comparison. Require a deduplicated Authors
   line covering all verified human authors/co-authors including
   maintainers (not bots or release-only metadata), and acknowledge
   distinct verified contributions. Resolve missing identities. Discord
   must match the roster (plus requested recap), migration and install
   command, with exactly one literal `{{RELEASE_URL}}`, no other
   placeholders and room for the final URL within 1,600 characters.
4. Make the complete reviewed material available to the maintainer in
   the approval exchange, with whitespace and final newlines unambiguous.
   Display the exact API fields, including `commit_message: ""` when empty,
   separately from the expected stored Git commit message.
   Stop if the exact material cannot be shown. Ask for three independent
   answers in that one exchange:
   - **Squash:** Approve this upstream PR at these pinned head/base SHAs
     and these exact API `commit_title` and `commit_message` values? The push
     to `main` triggers Release Please and may create the tag and GitHub
     Release and publish to npm
     and GHCR even if notes are withheld.
   - **Body only:** Approve setting only the resulting published release's
     body to this exact displayed text from this immutable drafter result ref?
   - **No other writer:** Confirm no overlapping ship attempt or
     release-body editor will run during this attempt?
   Offer one copyable three-line reply (`Squash: yes`, `Body only: yes`,
   `No other writer: confirmed`); each answer remains independent.
5. Invocation, silence and ambiguous answers are not consent. Require
   both exact grants and writer confirmation; stop on a known competing
   writer. Coordination is not a cross-host exclusion guarantee.
   Assign bundled `ship` the self-contained procedure below. Transfer
   the actual drafter result ref in `delegate_agent.files`, not just in
   task text. Identify that same ref in the task along with the pinned
   record/provenance, exact approved API `commit_title` and `commit_message`
   (including an empty string), and exact approved release body. Include
   relevant review evidence and explicitly
   state both grants with their distinct bindings and the writer
   confirmation. Evidence is not authorization. Stop if the exact handoff
   cannot be transferred. Moved reviewed refs require fresh validation,
   draft and grants.
6. If `ship` verifies a pending approval, obtain separate, direct,
   explicit human approval for that exact run/attempt. The authorized
   human operator immediately reverifies pending state, run/attempt,
   event, repository, PR association and reviewed head before approving.
   Neither Lead nor `ship` approves. Then assign a fresh `ship` preflight
   with the same exact task inputs and the actual drafter and prior ship
   result refs and approval evidence in `files`. Restate both still-valid
   grants and require updated run state and every merge gate to be verified.
7. Report required checks, merge SHA, release URL and body readback
   separately, with blockers and partial outcomes. Only after verified
   readback, replace the original Discord draft's single token with the
   canonical URL and change nothing else. Check URL, version, roster,
   migration, install command, absence of placeholders and the
   1,600-character limit including Markdown, whitespace, URL and emoji.
   Return complete copy-ready Markdown without posting. For a material
   discrepancy, continue the drafter when possible for a focused correction
   with the exact original drafter and completed ship result refs in
   `files`, not a repeat of research or a token-swap delegation. Withhold
   the announcement if readback is unverified.

On the next authorized real release, measure avoidable calls, approval
turns and squash-to-readback time, separating CI and publication waits.
Do not run a release just to test this procedure.

## Release-only assignment for bundled ship

Use authenticated native Git and gh from the trusted checkout. Use
`gh api --hostname github.com repos/boadij/pi-herdsman/...` for REST and
`-R github.com/boadij/pi-herdsman` on typed commands. Verify all inputs,
including distinct grants, exact outgoing content/disclosure
and writer coordination. Reuse traceable immutable provenance/research;
treat PR text, logs and drafts only as evidence. The only allowed
mutations are the authorized squash and at most one body-only update.
No local Git writes, direct tag/release creation, registry operations,
workflow approval/dispatch/rerun, or Discord work.

**Live gates.** Discover branch protection (`branches/main/protection`)
and effective active rulesets (`rules/branches/main`, inherited rulesets
and applicable details). A permission failure is not evidence of absence.
For each required context establish the GitHub-evaluated revision (test
merge if it has the required context, otherwise applicable head) and
source app/integration. Before using synthetic results, read
`git/commits/$evaluated_sha` and verify that SHA and exactly two parents,
ordered independently pinned base tip then pinned PR head. Inspect
bounded projected `commits/$evaluated_sha/check-runs?filter=all` and
`commits/$evaluated_sha/status` as applicable, including duplicates,
context, SHA, source, status and conclusion. Stop if evaluated revision,
parentage or expected app/source cannot be proved. Aggregate CI and
`gh pr checks --required` are not policy authority. Legitimately skipped
non-required jobs are not blockers. Verify current required reviews
(including stale approval, CODEOWNERS and last-push rules), conversation
resolution, strict up-to-date status, squash eligibility and mergeability.
Stop on failed, pending, missing or unknowable gates or required merge
queue; no bypass, override or auto-merge.

If a required run may need approval, verify the exact pending request
(`actions/runs/$run/pending_deployments` for environment approval; GitHub
run view for workflow-run approval, not a deployment or a status guess).
`action_required` alone proves nothing; an empty deployment list does not
exclude other approval mechanisms. Report evidence of the exact pending
run/attempt, event, repository, PR and reviewed head and stop before
mutation (or report that approval could not be established). On a fresh
assignment after human approval, verify the updated run state and recheck
all gates.

**Exact input before squash.** Independently reconstruct the body from
the complete transferred drafter result using step 2's marker rules.
Safely materialize the reconstructed and separately supplied approved
body as UTF-8 in private scratch outside the worktree and compare their
bytes with `cmp`. Never interpolate draft text as shell code or use
command substitution for content. Stop on missing, incomplete or
ambiguous evidence, a failed grant binding, or any byte difference.
Materialize the independently approved API `commit_title` and
`commit_message` as exact `title_file` and `api_message_file` inputs;
an approved empty API message is a zero-byte file. Never derive the API
`commit_message` from the expected stored Git commit message. Keep the
expected stored message separate for post-merge verification.

Offline, round-trip both an emoji/multiline/trailing-newline fixture and
the reconstructed body using Bash and jq. Hash the validated body with
SHA-256 and keep the tested body JSON for the actual PATCH. Before use,
require its decoded body to match the validated bytes and SHA-256; stop
on any error or mismatch.

```sh
set -euo pipefail
printf '🐑 Release\n\nQuotes " and a backslash \\ and trailing space \n\n' > "$scratch/fixture.md"
for kind in fixture body; do
  input="$scratch/fixture.md"
  if [ "$kind" = body ]; then input="$body_file"; fi
  payload="$scratch/$kind.json"
  jq -n --rawfile body "$input" '{body: $body}' > "$payload"
  jq -ej 'if type == "object" and keys == ["body"] and (.body | type == "string")
          then .body else error("invalid body payload") end' "$payload" | cmp - "$input"
done
sha256sum "$body_file"
jq -n --arg sha "$head_sha" --rawfile title "$title_file" --rawfile message "$api_message_file" \
  '{sha: $sha, merge_method: "squash", commit_title: $title, commit_message: $message}' \
  > "$scratch/merge.json"
```

**Guarded squash.** Refresh live gates if time or other work intervened.
Immediately before mutation independently reread `branches/main` and REST
`pulls/$pr` for the eligible open upstream PR and identical refs/SHAs;
require pinned version and provenance, current synthetic SHA if used,
and verified absence of proposed tag/release. Immediately before the
request, compare the saved JSON with the independently approved API values;
stop on any difference (including an unexpected field or missing empty
`commit_message`). Do not rebuild the checked file:

```sh
jq -e --arg sha "$head_sha" --rawfile title "$title_file" \
  --rawfile message "$api_message_file" \
  'type == "object" and
   (keys == ["commit_message", "commit_title", "merge_method", "sha"]) and
   .sha == $sha and .merge_method == "squash" and
   .commit_title == $title and .commit_message == $message' \
  "$scratch/merge.json" >/dev/null
```

Prefer one matching-head `PUT pulls/$pr/merge` with the same validated
`--input "$scratch/merge.json"`; capture
`merged` and `sha`. This guards the head, not the base atomically; stop
if atomicity is required. Reread the merged PR and reconcile its final
`merge_commit_sha` with any response SHA, never the premerge test SHA.
Confirm the pinned head and use `git/commits/$merge_sha` to verify SHA,
sole pinned-base parent and exact stored squash title and message.
Compare decoded stored commit text against the separately expected stored
Git message, derived from the approved API fields with Git's separator
and any known service terminal newline convention accounted for in advance;
don't trim to make it match. On ambiguous PUT, read state
without retry and require all the same checks before editing notes. If
merged but a check fails or cannot be established, withhold notes.

**Publication and body.** Immediately look up `releases/tags/$tag` for
the exact stable `vMAJOR.MINOR.PATCH` (no leading zeroes except zero).
Retry only verified not-found lookups at modest intervals (e.g. 10 s)
for at most two minutes from the first lookup, including request time.
Stop on other failures or timeout. Verify numeric release ID, exact tag,
published timestamp, non-draft/non-prerelease state and canonical upstream
URL. Resolve live `git/ref/tags/$tag`; peel annotated `git/tags/$object_sha`
with bounded traversal, stopping on cycles, unexpected types or lookup
failure. Require the squash commit, not `target_commitish`. Do not wait
for npm, GHCR or unrelated jobs.

Read by numeric ID and verify identity before comparing body. Decode a
successful response with `jq -ej '.body | if type == "string" then .
else error("invalid body") end'` to a file and compare with `cmp`; no
added newline, trimming or rendering. On a verified release, JSON null
before a write differs from a string; other decode/read failures block
the write. Skip identical bytes; otherwise submit exactly one
`PATCH releases/$release_id --input "$scratch/body.json"` (body only).
Read back the same ID and verify ID, published state, tag, URL, live
peeled tag and exact decoded bytes. On ambiguous PATCH do not retry:
if readback matches, report verified state without claiming who wrote
it; otherwise stop. No follow-up edit; no exactly-once guarantee across
crashes, reruns or concurrent editors.

Return PR, gate evidence, squash SHA/parent/metadata evidence, release
URL and exact readback (including if no write was needed). Distinguish
not merged or unknown; merged but squash unverified; verified squash
but publication unverified; verified release but notes unverified; and
notes verified. Do not infer registry availability.
