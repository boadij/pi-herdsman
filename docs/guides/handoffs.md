# Handoffs and files

[Documentation index](../README.md)

Pi Herdsman has two text-file mechanisms with different purposes:

- `files` supplies evidence to delegate (definition or session), steer, reply,
  or ask_owner.
- whole-line body `@file` references put definition-owned text into the worker
  system prompt when a new worker generation is built.

Strict UTF-8 text is embedded when it fits; non-text and non-fitting files are
canonical local references and are not copied or snapshotted.

## Message `files`

For `delegate` with `definition`, `delegate` with `session`, `steer`, and
`reply`, pass supporting artifacts, including
applicable instruction or skill files, through `files` instead of mentioning
only their paths in the task or message; explain each file's relevance in the
accompanying text, and do not reattach skills already supplied by the selected
agent definition.

Example:

```json
{
  "action": "delegate",
  "definition": "reviewer",
  "task": "Review the implementation against the approved plan.",
  "files": [".pi-herdsman/plan.md", "/tmp/implementation-result"]
}
```

`files` is supported by `delegate` with `definition`, `delegate` with `session`,
`steer`, `reply`, and `ask_owner`. For
controller actions, relative paths resolve from the calling controller's cwd;
for `ask_owner`, they resolve from the managed worker's cwd. Every accepted
path is displayed using its canonical absolute path.

Supplied paths must resolve to readable regular files. Missing, broken,
unreadable, and non-regular paths reject the whole operation. Canonical
duplicates are represented once, with the first occurrence winning.

For `delegate` with `definition`, deterministic validation and known-input sizing happen
before mutation. The final durable envelope can be sized only after herdr
returns the authoritative pane ID; if the configured `mailboxPayloadLimitBytes`
is then exceeded, `delegate` with `definition` returns `invalid_request` without delivering a task and
rolls back the exact startup attempt (`rollbackOccurred: true` when
applicable).

For each regular file:

- complete strict UTF-8 text without NUL bytes is embedded when the complete
  message fits the effective configured `mailboxPayloadLimitBytes` boundary;
- invalid UTF-8, NUL-containing, binary, and non-fitting files are represented
  only by a canonical local path and observed byte size.

The fixed 1 MiB mailbox protocol safety ceiling is a separate read limit for
mailbox records; it does not replace the configured admission limit for new
messages.

No file is partially embedded. Embedded text is a submission-time snapshot.
Reference-only files are not copied or snapshotted; their contents may change
or disappear after submission, and the recipient must already have local
filesystem/tool access to inspect them. `files` supplies evidence and does not
grant runtime capabilities.

Files are read through their canonical `realpath` target.

## Canonical deduplication

Within any message's `files`, the first canonical occurrence wins.

These can therefore represent one attachment:

```text
./notes.md
/project/notes.md
./symlink-to-notes.md
```

when they resolve to the same physical canonical path. The same canonical path
in caller-supplied `delegate.files` also takes precedence over a definition body
`@file` reference, including when the caller file is reference-only.

Later duplicates are omitted.

## Body `@file` references

Inside an agent body, a line is a file reference only when the trimmed complete
line has one of these shapes:

```text
@./relative.md
@../relative.md
@/absolute/path.md
```

These remain literal text:

```text
@alice
Use @./policy.md when needed
```

Relative body references are resolved from the Markdown definition that
declared them **before** bundled/global body composition.

Expansion then happens once, in body order, when a new worker generation is
constructed.

Included file contents are not recursively parsed for more `@file` references.

## Cross-mechanism precedence

Caller assignment files win overlap with definition body references.

If the same canonical file appears in both:

```text
delegate.files
body @file
```

the assignment keeps its user-message copy and the body reference is omitted.

The combined rule is:

```text
duplicates inside delegate.files
    → first caller occurrence wins

duplicates inside body @file references
    → first body occurrence wins

same canonical file in both
    → caller attachment wins
```

## Immutable prompt transport

A definition body is expanded into text before worker lifecycle mutation.

The final expanded body and shared herdr worker guidance are written to private
temporary snapshots (`0600` files under private `0700` directories), passed to
Pi, and removed after the delegation attempt.

Original body source paths are never handed to Pi as system-prompt paths.

Each worker generation builds its system prompt once for its single assignment.
Session continuation builds a new generation with the current effective
definition configuration while preserving the saved Pi session context.

## Result handoff

Successful worker completion may expose a private `resultPath`.

For dependent work, pass the exact result path through `files` rather than
copying a large result manually:

```json
{
  "action": "delegate",
  "definition": "reviewer",
  "task": "Review the implementation described in the supplied result.",
  "files": ["/exact/resultPath"]
}
```

Successful worker completions persist their complete output at the canonical
`resultPath`; they do not receive a separate completion overflow path.
Oversized non-completion registered-tool output may additionally expose
`full_output_path` when overflow persistence succeeds. Model-visible content
remains bounded in both cases.

## Project-local coordination workspace

Use the project-local `.pi-herdsman/` directory for temporary coordination artifacts
used by agents working on the repository.

Typical contents include implementation plans, scope and non-goals,
specifications, accepted decisions, investigation notes, review scope or
acceptance criteria, validation notes, and handoff state.

Prefer one current artifact per coordinated objective. Reuse and update an
adequate artifact rather than creating multiple competing descriptions of the
same work.

Keep the default structure flat:

```
.pi-herdsman/
  task.md
  runtime-contract.md
  plugin-remapping-ui.md
```

Create subdirectories only when real artifact volume makes the flat layout
unwieldy.

These files are coordination state, not product state. Do not use `.pi-herdsman/`
for product source, permanent user documentation, application data, build
output, caches, or generated artifacts.

Read-only workers may consume existing coordination artifacts but do not gain
permission to modify them.

When dependent work uses an artifact, pass the same path through `files` on the
message that creates or updates the dependency: `delegate.files` for a new
worker, `steer.files` for an active worker, `ask_owner.files` for supporting
evidence in a question, or `reply.files` for the owner's answer. Update the
artifact before submission. Small text is embedded at submission time; a
reference-only artifact remains a live canonical local path.

Required textual instructions or evidence may be passed through `files`.
`files` does not add runtime capability; use a capable definition when an
actual runtime capability is required.

## See also

- [`worker` API](../reference/worker.md)
- [Agent-definition schema](../reference/agent-definition-schema.md)
- [Delegation](../concepts/delegation.md)
