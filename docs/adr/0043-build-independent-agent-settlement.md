# Separate durable Agent settlement from live build compatibility

## Decision

Use the existing mailbox version as the compatibility contract for durable Agent notifications, terminal results, and receipt reconciliation. Builds supporting that contract must agree on record interpretation, evidence bindings, receipt identity, and settlement prerequisites. Breaking those semantics requires a mailbox version increment.

Durable handoffs may be consumed across executable builds, including notifications while an Agent remains active. Live Agent execution and control continue to require exact build equality. Ownership, assignment generation, evidence validation, receipt checks, and identity-safe cleanup remain unchanged. Unsupported records are preserved and reported through existing diagnostics.

## Rationale

Persisted records and Pi session receipts contain the information needed to settle accepted work; requiring the originating executable to match creates an unnecessary dependency. The mailbox contract already supplies a versioned boundary without another protocol or lifecycle state.

## Consequences

This establishes compatibility for supported implementations, not every historical executable that happens to use the same version. Delivery remains recoverable and at-least-once, not exactly-once. No new persistence or diagnostic subsystem is introduced.
