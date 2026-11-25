# Recover Managers by exact Pi session

## Status

Accepted

## Context

[#1109](https://github.com/boadij/pi-herdsman/issues/1109) lets Chief provision
a project and start or recover its Manager. A Manager may stop without losing
its Pi history or project assignments. The same checkout can also be visible
in multiple Herdr workspaces, local sockets, or Pi profiles under the same OS
account. Neither a saved session nor a visible workspace establishes current
Manager authority.

## Decision

Key the single live Manager lease by the canonical Git common directory
verified from the checkout. Chief-started and manually activated Managers
compete for the same lease across local Pi profiles and Herdr sockets under
the same OS account. This does not coordinate across accounts or hosts.
Separate clones of the same remote remain independent; linked worktrees share
the same physical identity but are not eligible as Manager primary checkouts.
The existing assignment repository key retains its own meaning.

Herdr placement and staff discovery remain scoped to the current profile and
socket. Detected conflicting authority fails closed: a live lease outside
that scope blocks a competing launch but is not a local staff target. The
shared lease does not authorize cross-profile supervision.
Chief verifies the primary workspace and the dedicated launch pane on its
own socket. Readiness requires current, consistent evidence of the Manager
lease, exact Pi session and role, and running Herdr process and placement.

Store a minimal recovery reference per physical repository in the originating
Pi profile's private data: the exact Pi session ID and session file for an
explicitly persisted Manager role. Never adopt another profile's history. The
reference survives process loss and is removed on intentional Manager leave
only if it still names that session. It is neither a liveness record nor an
authority grant. Resume verifies the reference against the repository and
persisted role and opens that same conversation through Pi. Missing or
conflicting identity is not grounds to substitute another session.

Separate Chief's launch reservation from Manager authority. A short-lived
repository startup lock serializes Chief's launch decisions across local Pi
profiles and Herdr sockets under the same OS account without holding the lease
the child must acquire. Before dispatching a fresh start or resume
to Herdr, Chief records a durable reservation for that exact attempt. If
dispatch may have succeeded but readiness is unconfirmed, the reservation
blocks another launch even after Chief exits. Definite refusal or verification
of the exact ready Manager settles the reservation; elapsed time alone does
not. The reservation blocks competing launches across the same scope as the
startup lock but does not grant access to the originating profile's history.
It is not proof that a process exists.

This is a narrow exception to
[ADR 0007](0007-store-durable-state-under-pi-agent-data.md): store only the
repository-scoped Manager authority records, startup locks, and durable
unsettled launch reservations in a private OS-account-level store outside Pi
agent data. Keeping them in separate Pi profiles would allow competing
launches, including after a Chief exits with a launch still unsettled.
The recovery reference and session history stay in the originating Pi
profile; ADR 0007 still governs other durable Herdsman state.

Fresh starts use a one-shot intent bound to the exact new Pi session and
expected repository and placement. It selects Manager activation but does
not authorize it. The Manager process must establish its own authority.
Pi owns session creation, history, restoration, and project trust; Git
verifies repository identity and Herdr owns topology and process execution.

## Rationale and consequences

Workspace-keyed authority permits duplicate Managers for one physical
repository. Remote-keyed authority conflates separate clones. Using a Git
identity for exclusivity while observing Herdr placement separately follows
[ADR 0002](0002-persist-intent-and-derive-runtime-state.md) and
[ADR 0008](0008-prefer-native-pi-and-herdr-contracts.md) without introducing a
project registry or a parallel session store.

Recovery restores only the Manager conversation. It neither changes
assignments nor restarts subordinate Leads or Agents. Chief supervision
does not acquire project execution or Agent ownership, consistent with
[ADR 0021](0021-unify-direct-supervision-authority.md). Repository settings
remain separate from Manager execution authority under
[ADR 0040](0040-separate-repository-settings-from-manager-authority.md).

## Upgrade note

Stop Managers in all local Pi profiles under the OS account before upgrading
to this authority scheme. Detected live legacy authority blocks conflicting
activation, but Herdsman cannot enumerate undiscovered legacy profiles. A
Manager left running in such a profile may not participate in the shared
lease, so mixed-version coexistence is not safe.
