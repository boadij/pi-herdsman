# Supervision

[Documentation index](../README.md) · [Supervision reference](../reference/supervision.md)

Pi Herdsman coordinates one direct-report edge at a time:

```text
Chief
└─ Manager
   ├─ Lead
   │  └─ Agents...
   └─ Lead
      └─ Agents...
```

Chief supervises active Managers on its Herdr runtime, and ordinary Leads when their Herdsman project scope has no active Manager; Manager supervises ordinary Leads in one Herdsman project scope. Each project scope corresponds to one Herdr worktree group: its primary workspace and linked-worktree workspaces. A Lead owns its complete managed-Agent tree. Delegation-enabled Agents may own their permitted direct Agents. Chief may observe bounded descendant Lead and Agent summaries but acts only on its direct reports; Manager may observe a Lead's Agent descendants but acts only on Leads. Neither supervisor owns descendants across an intermediate coordinator.

## Project authority

Herdr's worktree topology identifies the primary workspace and its linked-worktree workspaces; branch names, Git subprocesses, cwd, labels, and display metadata do not confer authority. Every session starts as an ordinary Lead. A Lead in the primary workspace may explicitly enter Manager mode with `/manager`; Leads in linked-worktree workspaces cannot. Activation claims the single Manager lease for the corresponding Herdsman project scope and persists Manager mode for the Pi session. If another live Manager holds the lease, activation fails and the caller remains an ordinary Lead. Activation also refuses while the session owns unresolved managed-Agent work, preserving its control surface. `/manager leave` is refused while project assignments, Manager-addressed asks, or the Manager's own pending ask to Chief remain outstanding; when clear it releases the lease and restores the Lead profile and exact Lead tool baseline, including `agent`. A restored Manager session uses the same Manager profile, supervision UI, and role-specific context as explicit activation; startup does not load the Lead Agent-definition roster or recover Lead-owned Agent runtimes. Manager uses a distinct coordination charter and has only `staff`, `supervisor`, and `peer` as Herdsman tools; it has no `agent` and cannot own Agents or implement work through them. Manager receives bounded direct-Lead supervision context, not the Lead Agent-definition roster or Agent instructions. Manager coordinates project-level work across Leads and workspaces. Delegated implementation belongs to Leads and their Agent trees, with linked-worktree workspaces as Manager's execution boundary.

An eligible ordinary Lead can use `/chief` to enter the workspace-neutral, supervision-only Chief mode; a Manager cannot enter Chief mode. Chief has exactly `staff`. A Chief lease is unique per Herdr socket. A restored Chief whose lease is occupied is suspended without Herdsman authority tools.

Missing, replaced, duplicate, or ambiguous Herdr/Pi identity, coordinator state, or lease evidence fails closed. Herdr metadata is for display only.

## Communication

| Direction | Tool                  | Boundary                                                                                    |
| --------- | --------------------- | ------------------------------------------------------------------------------------------- |
| Down      | `staff`               | Chief → current Managers and Leads without active Managers; Manager → current project Leads |
| Up        | `supervisor`          | Lead → active project Manager, otherwise Chief; Manager → Chief                             |
| Sideways  | `peer`                | Live same-role Leads or Managers, user-global                                               |
| Ownership | `agent` / `ask_owner` | Lead or delegation-enabled Agent → owned Agent; Agent → exact owner                         |

Without an active Manager, Chief may supervise ordinary Leads directly. With an active Manager, its project's Leads report to that Manager, not Chief; Chief does not have simultaneous authority over those Leads. Chief's snapshot includes active Managers and direct Leads from projects without a Manager. A Lead's upward messages and asks route to the active Manager, otherwise Chief. A Manager routes upward to Chief. Pending asks are attached to their supervision edge: a same-edge replacement can answer after fresh identity and authority validation, but a hierarchy change cannot reroute an ask. Upward escalation is deliberate at each edge, not automatically forwarded. `supervisor.ask` requires a genuine decision, is the sole and final tool call of the turn, and leaves at most one pending question. The authorized direct supervisor answers its exact ask ID with `staff.reply`. Messages are coordination, not agent steering or ownership transfer. Peer messages do not assign work; Agents and Chief never appear as peers. Use exact Pi session IDs from fresh rosters, never display labels. Files can carry ordinary paths, completed direct-Agent refs, and already-supplied canonical `result:<request-id>` refs.

Only explicit `staff.delegate` starts or recovers delegation; roster and report reads never resume external mutations. Independent branches may be delegated concurrently. A branch has at most one nonterminal assignment (`creating`, `starting`, `active`, or `settling`). Same-branch conflicts on `creating` or `starting` assignments direct recovery with `staff.delegate assignment=<id>`. Conflicts on `active` or `settling` assignments direct the Manager to `staff list` and identify the existing Lead session when available; they do not recommend `staff.delegate` recovery. Fresh delegation rejects an existing Herdr worktree and never adopts its Lead. Recovery uses only the exact assignment ID and reconciles that persisted assignment. Herdsman allocates an assignment and persists its branch and selected base ref token before creating the workspace: a requested branch is retained, otherwise the branch is `herdsman/<assignment-id>`; omitted base defaults to the `HEAD` token. It reuses the exact tokens on every recovery. Token stability does not freeze a moving ref; Herdr 0.9.1 exposes no public ref-to-immutable-commit resolver or resolved commit output. During explicit recovery, if the assignment has a persisted placement and authoritative Herdr topology proves its worktree is absent, Herdsman removes the assignment and reports that it was abandoned. Uncertain or contradictory topology fails closed; reads never remove assignments. Ambiguous creation is reconciled against the persisted branch/base and Herdr topology; if a branch exists without an open workspace, use `herdr worktree open --workspace <primary-workspace-id> --branch <branch> --no-focus`. Herdsman does not create a second branch/workspace for the assignment. Herdr controls the workspace path and label. The exact pane is started only after bounded shell-readiness and ownership checks; the assignment is durably delivered after verifying the exact Lead. Manager `staff.list` includes current Leads in its worktree group (including manually created Leads) and unresolved assignment phases.

Manager-created Leads launch Pi with `--no-approve`, which ignores project-local
files for that run; Manager delegation does not implicitly trust the linked-
worktree path. If a Lead needs trust-gated project resources, the user must
explicitly trust that path through Pi's supported project-trust flow.

Recover an uncertain delegation only with `staff.delegate` using `{"action":"delegate","assignment":"<id>"}`; omit `task`, `branch`, `base`, and `files` so recovery uses the persisted assignment.

Idle runtime state is not task completion. An assigned Lead calls `supervisor.result` to persist its outcome and provenance under reusable `result:<assignment-id>`, then notify the current Manager. The assignment is removed after accepted Manager delivery; the result artifact remains for later `files` handoffs. Pending asks and settling results reconcile across Manager replacement. Linked-worktree workspaces remain after completion. Herdsman does not prescribe backlog, review, or merge policy.

The automatic bounded `<supervision_state>` is state-only, untrusted observation. A fresh snapshot suffices for general state questions; use `staff.list` when a refreshed roster is needed, `inspect` for live terminal/process evidence, and `transcript` for persisted conversation/tool evidence. Every action revalidates direct-report identity and current authority.
