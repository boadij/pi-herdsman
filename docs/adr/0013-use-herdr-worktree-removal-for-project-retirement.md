# Use Herdr worktree removal for project retirement

> **Historical decision; superseded in part.** [ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md) adds confirmed `/takeover` as a separate assignment-release path. [ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md) supersedes the event-only retirement rule and the decision to recover assignments after verified worktree absence; the current runtime implements both retirement authorities.

## Decision

A persisted `ProjectAssignment` represents project work still managed by
Pi Herdsman. Lead settlement, Lead runtime state, Manager review, and Manager
messages are nonterminal.

Managers may start, resume, message, review, and stop project execution, but
cannot remove a `ProjectAssignment`. A successful Herdr `worktree.removed`
lifecycle event with coherent linked-workspace repository provenance and branch
identity retires the matching assignment and any still-pending project messages.

A worktree that is merely absent does not imply retirement. Missing checkout
recovery remains supported through `staff_resume`.

## Rationale

Herdr already owns the human Git-worktree lifecycle and provides the native TUI
for removal. Duplicating that action through Manager model tools or Herdsman
commands creates multiple lifecycle authorities.

`worktree.remove` preserves the Git branch, so retirement removes Herdsman
coordination state without deleting project history.

## Consequences

`staff_complete` and `staff_discard` are removed without compatibility aliases.
There is no persisted completed/discarded outcome because Herdsman did not
retain that distinction after resolution and no current consumer requires it.

Herdr lifecycle events are not durable. If an explicit removal event is not
observed, Herdsman preserves the assignment rather than inferring retirement
from missing topology. Add stronger upstream durable evidence only if real
failures demonstrate the need.
