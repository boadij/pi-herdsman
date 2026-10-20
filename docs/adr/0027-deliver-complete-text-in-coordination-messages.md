# Deliver complete text in coordination messages

## Status

Accepted

## Decision

Ordinary coordination messages that accept `files` deliver each attachment as
complete strict UTF-8 text within the configured per-file and complete-message
budgets, or reject the handoff. They do not treat a local-path reference as
successful delivery. `retain` controls continuing assignment requirements,
not immediate message delivery.

Coordination records remain compact and bounded. When a complete logical
message exceeds the physical record limit, its body and semantic result
bindings are stored as one private, immutable, integrity-checked payload and
resolved before Pi receives the message. Existing Pi conversation history,
authorization, receipt, and retry semantics remain authoritative.

This decision applies to Chief, staff, supervisor, peer, and project messages.
It does not change managed-Agent mailboxes or initial project assignment
delivery, which retain their existing behavior.

## Rationale

A path-only attachment can be inaccessible to the recipient and does not prove
that the evidence crossed the coordination boundary. A bounded explicit error
is safer than reporting an incomplete handoff as delivered. Keeping overflow
content separate from the small record preserves efficient durable inbox
scans.

## Consequences

- Unsupported, changed, missing, or over-budget attachments fail before
  publication.
- The accepted content survives sender-file deletion and is verified before
  recipient delivery.
- The physical coordination-record limit remains an internal storage bound;
  configured limits govern the complete logical message.
- Payloads can remain orphaned after interrupted publication or cleanup; they
  are not deliverable without their authoritative pending record.
