# Errors

[Documentation index](../README.md)

Normal public `worker` failures use structured error details.

## Shape

A structured error contains:

```text
category
message
operation
rollbackOccurred
retryAttempted
```

and may include:

```text
ids
nextAction
primary
cleanup
details
```

Do not discard `primary` when `cleanup` also failed.

`retryAttempted` is true only after a retry or recovery attempt is scheduled or
entered. It is preserved when a structured error is wrapped. Cleanup that is
still pending remains represented by cleanup evidence and retry wording; it
must not be presented as exhausted cleanup.

## Categories

| Category                   | Meaning                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `not_running_inside_herdr` | Required herdr environment is missing.                                              |
| `worker_label_exists`      | Requested/generated live label conflicts with an existing worker.                   |
| `pane_not_ready`           | Worker pane/startup did not reach the required readiness boundary.                  |
| `target_not_found`         | Exact requested identity or ownership evidence was not found.                       |
| `target_ambiguous`         | More than one live candidate matched an identity that must be exact.                |
| `rollback_failure`         | Primary operation failed and cleanup did not fully converge.                        |
| `worker_busy`              | Worker state does not allow the requested control action.                           |
| `invalid_request`          | Request fields, values, definition input, file input, or preconditions are invalid. |
| `internal_failure`         | An invariant or underlying operation failed outside a narrower public category.     |

## Identity failures

`target_not_found` can intentionally mean "could not prove this exact target",
not necessarily "nothing exists physically".

`target_ambiguous` means Pi Herdsman refuses to choose among multiple candidates.

Both are fail-closed behavior.

## Rollback

When a worker launch fails, exact resources created by that attempt are cleaned
only when ownership is proved.

A `rollback_failure` can preserve:

- primary startup/control error;
- cleanup error;
- known label/pane/tab/session evidence;
- stage;
- next action.

Inspect these fields before another destructive attempt.

Model-facing error text surfaces available identity, stage, primary cause,
cleanup cause, and next action without discarding the structured details.

## Model-visible truncation

Very large tool output can be bounded for model delivery. When full output is
persisted, tool details may include a `full_output_path`.

This is output presentation behavior, not an error category.

## See also

- [Recovery](../guides/recovery.md)
- [`worker` API](worker.md)
