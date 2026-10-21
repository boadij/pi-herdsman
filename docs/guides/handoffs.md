# Handoffs and files

[Documentation index](../README.md)

Any coordination operation whose schema accepts `files` uses it as the explicit
evidence channel across session boundaries.

Pass user-supplied or already-available artifacts through `files` when they are
relevant to what the recipient must do or decide, unless the recipient already
inherits the same evidence version as required evidence. Forward changed
versions explicitly. Do not assume the recipient inherits arbitrary
conversation or attachments. Preserve exact
supplied result refs when forwarding them and omit unrelated evidence. `files`
carries evidence, not runtime capability.

## Required assignment evidence

A verified managed project assignment can retain **required evidence** for
future delegated Agents. The initial `delegate_project` task is preserved
unchanged as `project-brief.md`; files supplied to `delegate_project` also
become required evidence. Later evidence is retained as part of a handoff by
setting `retain: true` on an existing coordination operation:

- A Manager uses `message_staff` to retain the supplied message text and files
  for the target assigned Lead's project assignment.
- An eligible managed Agent uses `delegate_agent` to retain supplied files as
  additions to its local assignment for its own descendants. Its task text is
  not retained, and it cannot modify the parent project's evidence set.

The Manager alone controls project-wide requirements. Root Lead delegation
accepts `files` for the current handoff, without a retention parameter.
Leads can forward findings directly for immediate correction; when findings
should become continuing project requirements, send the relevant files or
result references through `message_supervisor.files` for Manager evaluation.
Ordinary delegation need not wait for that decision.

On operations that support it, omitted or false `retain` leaves files as
evidence for that handoff only.
Retention requires verified assignment authority and eligible evidence;
failure is explicit and never silently downgraded to an ordinary handoff. The
operation persists requirements and performs its normal handoff together. If
retention succeeds but delivery fails, the result reports the partial outcome.
Retention failures or operations that fail before the assignment update may
leave private, unreferenced immutable snapshots; in those cases the
authoritative assignment remains unchanged. Successful retention followed by
delivery failure leaves the assignment updated and is reported as partial
success. This change adds no garbage collection.
See the [staff-tool reference](../reference/staff.md#message_staff) and
[Agent-tool reference](../reference/agent.md#delegate_agent).

Each new descendant assignment receives the effective required-evidence set
when that assignment is accepted, merged with explicit `files` for that
handoff and deduplicated by verified version and result binding. The Manager's
latest retained update identifies one current batch for future eligible
descendants; other required entries remain historical and reference-first.
Project
descendants inherit project requirements; nested descendants also inherit
relevant additions owned by their Agent parent. Siblings do not inherit one
another's local additions. An inherited snapshot keeps its original
`sourceAssignmentId`; forwarding inherited evidence does not transfer
ownership. The receiving managed Agent cannot remove inherited requirements
or change the project set. Parent changes do not silently rewrite an
already-running child's accepted evidence set; continuation resumes the saved
assignment evidence and still requires valid ownership authority. Retired
project assignments cannot be resumed.

For each managed-Agent assignment, the task and current files are presented
before historical requirements. A complete Manager-selected current batch is
embedded when it fits the configured limits; if the automatic batch exceeds
capacity, it is presented as semantic references as a whole. Explicit
attachments remain strict: an explicit file that cannot be embedded rejects
the handoff. Previously accepted requirements outside that batch are listed
as semantic references. Selecting an accepted reference through `files`
presents that exact version as a current explicit attachment. All accepted
requirements remain part of the assignment; presentation does not change their
authority or ownership. The initial project brief is delivered as task text
and separately retained for descendants without duplicating it in the initial
message. A saved Agent continuation keeps the current-batch selection accepted
with that session, even if the Manager later changes the project batch.
Successful Agent delegation and continuation return a receipt of the inline
and referenced evidence in the accepted task. It confirms mailbox acceptance,
not that the Agent read, understood, or applied the evidence.

Retained file evidence is an immutable snapshot of supported UTF-8 text no
larger than 1 MiB. Registration of unsupported, binary, or oversized files
fails explicitly. Current evidence must fit complete-content delivery limits;
it is not replaced with a path-only reference. Earlier retained evidence is
identified by a stable semantic `evidence:` reference. The authorized
recipient can use `read_evidence` to retrieve bounded content for references
in its accepted evidence set. Retained evidence remains available throughout
eligible descendant assignments. Agents should inspect evidence relevant to
their task and decisions; they are not expected to read every historical entry.
Agent results preserve their existing semantic
`result:` bindings. Historical references do not grant access by themselves,
and internal snapshot paths are not exposed as evidence identities.
Ordinary files supplied to `message_staff`, `message_supervisor`, or
`message_peer` are delivered as complete supported UTF-8 text within the
configured per-file and complete-message budgets; unsupported, changed, or
non-fitting files reject the handoff instead of becoming path-only references.
Other `files` operations retain their existing preparation behavior. Ordinary
coordination attachments are per-message evidence and are not added to
continuing required evidence unless an eligible Manager explicitly sets
`retain: true`.

This is not general attachment or conversation inheritance. Automatic required
evidence applies to verified managed project assignments and their nested
managed-Agent assignments, not to an ordinary Lead's whole session. Evidence
availability does not grant execution or control authority. An unassigned Lead
or unrelated session acquires no automatic evidence scope. Retained evidence
removal remains an internal exact-ID capability; there is no standalone
model-facing evidence-management tool. Removing a requirement does not erase
prior Pi-session entries or evidence already accepted by an Agent.
For project-owned requirements, a Manager can use the existing project
assignment action menu: **Retained evidence** → select an entry to inspect its
ID, name, and origin → **Remove** → confirm. This removes only the exact
project-owned requirement; inherited baseline entries are protected. It does
not delete snapshots or source files. The project menu does not remove
managed-Agent-local additions; assigned Leads have no separate evidence
removal UI, and local Agent-addition removal remains internal only.

Pi Herdsman has two text-file mechanisms with different purposes:

- `files` supplies evidence to the coordination operations that accept it:
  `delegate_agent`, `continue_agent`, `steer_agent`, `interrupt_agent`,
  `reply_agent`, `delegate_project`, `message_staff`,
  `message_supervisor`, `message_peer`, and `ask_owner`.
- whole-line body `@file` references put definition-owned text into the agent
  system prompt when a new agent generation is built.

Strict UTF-8 text is embedded when it fits; ordinary non-text and non-fitting
files are canonical local references and are not copied or snapshotted. The
required-assignment exception preserves supported text snapshots and can
reference those snapshots when they do not fit inline; see
[Required assignment evidence](#required-assignment-evidence).

## Coordination `files`

Coordination evidence crosses session boundaries explicitly.

- Task or message text and `files` carry evidence relevant to the recipient's
  work or decision.
- The sender's conversation and attachments are not implicitly copied into
  another session.

When the recipient's work or decision depends on a user-supplied or
already-available artifact, pass it through `files`.

Do not attach or mention agent instruction files such as `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, or equivalents merely because they exist; rely on normal project
or runtime discovery.

Attach an agent instruction file only when the task requires inspecting,
modifying, comparing, or transmitting it, the user explicitly requests it, or
its instructions are required and the target would not otherwise receive them.
Skills are separate: attach a required `SKILL.md` only when the task needs it
and the selected definition does not already provide that skill. Ordinary
relevant source, documentation, configuration, and evidence files remain
attachable.

`files` is the single evidence channel. It accepts ordinary paths, reusable
direct-agent result refs such as `result:researcher#1`, and already-known
canonical result references. Copy the exact result ref shown by a completion
into `files` when later work depends on that result.

Example:

```json
{
  "definition": "reviewer",
  "task": "Review the implementation against the approved plan.",
  "files": ["plan.md"]
}
```

The model-facing representation follows Pi's native `@file` convention:

```xml
<file name="/absolute/canonical/path" bytes="123">
contents
</file>
```

A reference-only file uses a self-closing tag:

```xml
<file name="/absolute/canonical/path" bytes="123" />
```

For an ordinary file, `name` is the canonical absolute path and `bytes` is the
observed file size. For a result reference, an embedded file uses the exact
supplied reference as `name`:

```xml
<file name="result:researcher#1" bytes="123">
contents
</file>
```

A result that is supplied by reference keeps both identities in its
self-closing envelope:

```xml
<file name="result:researcher#1" path="/absolute/canonical/path" bytes="123" />
```

A body means the complete submission-time UTF-8 snapshot was embedded. For an
ordinary file, a self-closing tag carries its canonical path and observed byte
size; for a result reference, it carries the supplied logical result name, the
physical path attribute, and observed byte size. File content remains raw text. This
markup frames evidence for the model and is not a security boundary.

`files` is supported by `delegate_agent`, `continue_agent`, `steer_agent`,
`interrupt_agent`, `reply_agent`, `delegate_project`, `message_staff`,
`message_supervisor`, `message_peer`, and `ask_owner`. For controller actions,
relative paths resolve from the calling controller's cwd; for `ask_owner`, they
resolve from the managed agent's cwd. Accepted ordinary filesystem paths retain
canonical absolute-path names; semantic and canonical result refs retain the
exact supplied reference as the model-facing name.

Supplied paths must resolve to readable regular files. Missing, broken,
unreadable, and non-regular paths reject the whole operation. Canonical
duplicates are represented once, with the first occurrence winning.

For `delegate` with `definition`, deterministic validation and known-input sizing happen
before mutation. The final durable envelope can be sized only after herdr
returns the authoritative pane ID; if the configured `mailboxPayloadLimitBytes`
is then exceeded, `delegate` with `definition` returns `invalid_request` without delivering a task and
rolls back the exact startup attempt (`rollbackOccurred: true` when
applicable).

For ordinary coordination messages (`message_staff`, `message_supervisor`,
and `message_peer`):

- complete strict UTF-8 text is embedded only when the per-file
  `inlineAttachmentLimitBytes` and complete logical-message
  `mailboxPayloadLimitBytes` both fit;
- unsupported, changed, or non-fitting files reject the handoff explicitly;
- the physical 8 KiB coordination record does not limit message content;
  larger accepted bodies are stored separately and verified before Pi
  delivery.

For other operations that accept `files`, file preparation retains its
operation-specific behavior. In particular, managed-Agent mailbox and initial
project-assignment paths continue to use their existing reference behavior.

For those existing preparation paths, each regular file:

- complete strict UTF-8 text without NUL bytes is embedded when the complete
  message fits the effective configured `mailboxPayloadLimitBytes` boundary;
- invalid UTF-8, NUL-containing, binary, and non-fitting ordinary files are
  represented only by their canonical local path and observed byte size;
  result references retain their logical name and carry the physical path and
  observed byte size.

The fixed 1 MiB mailbox protocol safety ceiling is a separate read limit for
mailbox records; it does not replace the configured admission limit for new
messages.

No file is partially embedded. Embedded text is a submission-time snapshot.
Where an operation permits reference-only files, they are not copied or
snapshotted; their contents may change or disappear after submission, and the
recipient must already have local filesystem/tool access to inspect them.
`files` supplies evidence and does not grant runtime capabilities.

Files are read through their canonical `realpath` target. Ordinary file inputs
are rendered with that canonical path; result references retain the exact
supplied name so recipients can pass the same reference through `files` again.

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
@~/home-relative.md
```

On Windows, native backslash forms are also supported, including `@.\relative.md`,
`@..\relative.md`, `@~\home-relative.md`, rooted paths, drive-rooted paths,
and UNC paths. References use the host platform's native path resolution rules.

These remain literal text:

```text
@alice
Use @./policy.md when needed
@~user/file.md
@$HOME/file.md
@${HOME}/file.md
```

Relative body references are resolved from the Markdown definition that
declared them **before** bundled/global body composition.

Expansion then happens once, in body order, when a new agent generation is
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

A definition body is expanded into text before agent lifecycle mutation.

The final expanded body and shared herdr agent guidance are written to private
temporary snapshots (`0600` files under private `0700` directories), passed to
Pi, and removed after the delegation attempt.

Original body source paths are never handed to Pi as system-prompt paths.

Each agent generation builds its system prompt once for its single assignment.
Session continuation builds a new generation with the current effective
definition configuration while preserving the saved Pi session context. Its
omitted model and thinking fields restore the saved session settings; explicit
definition overrides still apply.

## Result handoff

Automatic project reports are summary text with no file attachments. A result
reference mentioned in report text is informational; mentioning it does not
itself make the result available, though the Manager may already have its
binding from an earlier handoff. When asking the reporting Lead to revisit its
own result, a Manager can mention the reference in `message_staff.message`
without attaching it. Use `message_staff.files` to transfer relevant readable
local files or result references resolvable on the current Pi branch. A semantic
result reference is resolvable when the branch contains its direct Agent
completion or an explicitly imported binding; already-supplied canonical result
references may also be passed through. A Lead that needs to provide an artifact
for review or onward delegation explicitly sends the evidence through
`message_supervisor.files`.

A direct-agent completion that has a reusable persisted result exposes an exact
ref such as `result:global-peer-fix#1`. Pass relevant direct-agent results
through `files` using the exact refs shown by the completions:

```json
{
  "definition": "reviewer",
  "task": "Compare both implementation passes.",
  "files": ["result:global-peer-fix#1", "result:global-peer-fix#2"]
}
```

`result:<agent>#<index>` is a globally unique reusable direct-result ref within
the Herdsman durable data root. It resolves in another session only when
explicitly handed through `files`; resolution is against matching completion
entries or imported bindings on the caller's current Pi branch. Indexes are
allocated globally and are never reused, while availability remains
branch-local. Semantic result refs retain their model-facing identity during
attachment preparation. Herdsman resolves the durable artifact through a
hidden canonical binding and carries that binding across Pi session boundaries
so the receiving session can forward the same semantic ref later.

Pass an exact canonical reference through `files` when it was supplied as file
evidence, especially for a transitive handoff:

```json
{
  "definition": "reviewer",
  "task": "Review the implementation described in the supplied result.",
  "files": ["result:550e8400-e29b-41d4-a716-446655440000"]
}
```

`files` accepts ordinary readable regular local file paths, reusable direct
refs in the form `result:<agent>#<index>`, and canonical
`result:<request-id>` references already supplied as evidence. Semantic refs
resolve against the caller's current Pi branch to a hidden canonical binding.
A result reference mentioned only in message text does not establish a reusable
binding. A semantic result reference can be forwarded through `files` when the
current Pi branch contains either its direct Agent completion or an explicitly
imported result binding.
A canonical result reference resolves internally to the normal private result file under Pi
Herdsman's durable data directory; it is still validated, canonicalized, and
deduplicated like any other file. Preserve the exact reference already supplied
as evidence. Do not guess or reconstruct the underlying path.
Completion results live under Pi's agent data directory
(`~/.pi/agent/pi-herdsman/results` by default, respecting Pi's configured agent
directory) rather than the OS temporary directory, so result handoffs are not
subject to temporary-directory cleanup.

Persisted reusable completions are self-describing. Herdsman prefixes the
agent-authored result with source context containing the logical agent label,
agent definition, assignment cwd, and producing Pi session ID when available:

```text
Agent result source: {"agent":"researcher","definition":"scout","cwd":"/project","piSessionId":"<producing-session-id>"}

<agent-authored result>
```

This context is part of the durable result artifact, so it survives semantic-ref
resolution and transitive forwarding through `files`. For a
reference-only result, the provenance is available with the body when the
referenced artifact is read; it is not separately embedded. The context is
informational model evidence, not authorization: an exact session ID or path
does not authorize `continue_agent` without durable ownership ancestry. The normal
completion shown to the owning session
remains unchanged.

Oversized non-completion registered-tool output may additionally expose
`full_output_path` when overflow persistence succeeds. Model-visible content
remains bounded in both cases.

## See also

- [Agent tools](../reference/agent.md)
- [Agent-definition schema](../reference/agent-definition-schema.md)
- [Delegation](../concepts/delegation.md)
