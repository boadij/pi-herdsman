# Consume project messages after Manager delivery

## Decision

- ProjectAssignment remains the durable open-project record.
- ProjectMessage exists only while delivery to the Manager role is pending.
- Messages survive periods without a Manager and are delivered to the next
  verified Manager that can receive them.
- Exact presence in the complete Pi Manager session history proves delivery;
  Herdsman then consumes the pending message record.
- Backlog created before a Manager generation is inserted without starting one
  autonomous turn per message. New messages during that generation keep the
  existing Manager wake-up behavior.
- Authoritative Herdr worktree retirement removes any still-pending messages.

## Rationale

Pi already owns durable delivered conversation history. Retaining another
permanent replay log duplicates ownership, while exact session-history proof
allows consumption without receipt state. Project lifecycle remains independent
of message lifecycle: delivering a handoff does not retire its assignment.

## Alternatives rejected

- Permanently replay messages to every Manager.
- Persist per-Manager receipts or introduce a new queue schema.
- Infer project completion from message delivery.

Because Pi's extension sendMessage API is fire-and-forget, a turn-triggering
message may remain pending until a later idle drain can prove its presence in
Pi history. A Manager replaced during that interval may cause one replay; add
durable receipt state only if this occurs in practice.
