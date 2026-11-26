# Categorize execution definitions and bind assigned Lead profiles

## Status

Accepted

## Decision

Identify a definition by its category and frontmatter name. At each applicable
scope, keep Agent definitions in `agents/`; use `coordinators/leads/` for
Leads, `coordinators/managers/` for Managers, and `coordinators/chief.md` for
Chief. Chief remains bundled and global only. The directory supplies the
category; the shared Markdown format and overlay engine apply to matching
identities only. An unmatched name is standalone.

Category classifies a definition; the operation determines which settings are
applicable. In particular, a named Coordinator definition is not a delegable
Agent, and the existence of a profile does not grant a launch capability or
runtime authority.

New project assignments may select a named Lead launch profile, defaulting
to `managed-lead`. The assignment records launch intent, including before
session initialization. The exact Pi session binds its established launch
profile immutably, independently of conversation branch and runtime role
state. The binding and assignment selection must agree; recovery is not a
profile switch. Forked sessions do not inherit the binding. Retirement does
not change it. Existing default-profile sessions need no backfill.

The binding records identity, not a snapshot of effective configuration or
proof of authority. The exact current project assignment still authorizes
assigned work; immutable session kind and Agent ownership remain separate.

## Supersession

This replaces the fixed managed-Lead profile selection in ADRs 0015 and 0018,
the closed Coordinator name set in ADRs 0034 and 0039, and the flat Coordinator
layout in ADR 0039. Other decisions stand, including standalone ordinary Lead
profiles, repository trust and overlay precedence, and exact-session identity
and authority boundaries in ADRs 0017 and 0029.
