# Separate repository settings from Manager execution authority

[Documentation index](../README.md)

## Status

Accepted

## Context

Repository permissions control future Manager removal and integration. Requiring
an active Manager to configure them prevents a user from setting policy before
starting the role. ADR 0030 and ADR 0032 specify the permissions and their
execution safeguards but do not require Manager authority to administer them.

## Decision

An interactive user may administer repository permissions independently of an
active Manager, for the repository verified from the current workspace and Git
checkout. Repository identity and session context are revalidated before a
write; unavailable, conflicting or changed identity fails closed. Permission
grants require explicit human confirmation, including effective increases from
inheritance. Policy remains in user-owned configuration, and stale policy
changes are rejected.

This changes settings-administration authority, not execution authority. Actual
Manager operations still require the active verified Manager and all existing
exact-target, occupancy, cleanliness, integration-evidence and removal guards.
Pending intent does not authorize removal. ADR 0030 and ADR 0032 remain in
force for those operations.

## Consequences

- Users can configure a verified repository before activating Manager mode.
- A repository-controlled file cannot grant repository permission.
- Verification and publication are not a cross-process transaction over Git,
  Herdr and configuration; revalidation limits but cannot eliminate races.
