# Supervision reference

[Documentation index](../README.md) · [Concept](../concepts/supervision.md) · [Peer reference](peer.md)

Supervision normally follows Chief → Manager → Lead; without an active Manager, Chief directly supervises ordinary Leads. Lead → Agent is ownership, not supervision. Staff actions search only the caller's current direct-report roster; descendant summaries do not grant descendant actions.

## Roles and authority

| Session       | Herdsman tools                                                                    | Authority                                                                                     |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Chief         | `staff` only                                                                      | Current Managers, and ordinary Leads without an active project Manager, on this Herdr runtime |
| Manager       | `staff`, `supervisor`, `peer` plus ordinary project tools; no `agent`             | Ordinary Leads in one Herdsman project scope (one Herdr worktree group)                       |
| Lead          | `agent`, `supervisor`, `peer` plus ordinary tools; no `staff`                     | Its owned Agent tree                                                                          |
| Managed Agent | `ask_owner` and definition tools; `agent` only when delegation-enabled; no `peer` | Directly delegated permitted Agents only                                                      |

Every session starts as an ordinary Lead. Herdr worktree topology identifies the primary workspace and linked-worktree workspaces by workspace IDs and repo key. A Lead in the primary workspace may enter Manager mode with `/manager`; Leads in linked-worktree workspaces cannot. Activation claims the exclusive Manager lease for the Herdsman project scope corresponding to that Herdr worktree group, and persists `role: "manager"` for the Pi session. If another live Manager holds the lease, activation fails and the caller remains an ordinary Lead. `/manager leave` releases the lease and restores Lead instructions and the exact Lead tool baseline, including `agent`. Manager uses a distinct coordination charter and has only `staff`, `supervisor`, and `peer` as Herdsman tools; it has no `agent` and cannot own Agents or implement work through them. Manager coordinates project-level work across Leads and workspaces. Delegated implementation belongs to Leads and their Agent trees; linked-worktree workspaces are the execution boundary for Manager-delegated work. Manager authority requires the current lease and exact identity, not Herdr display metadata.

An eligible ordinary Lead may activate `/chief`; a Manager cannot. Chief is a separate workspace-neutral session mode with one active lease per Herdr socket. The persisted `pi-herdsman-role` entry records `role: "lead"|"manager"|"chief"`; `leadTools` retains the exact ordinary Lead loadout needed when leaving either special role. Chief does not receive project context or Agent control. `/chief leave` restores ordinary Lead tools. An occupied lease on Chief resume suspends Chief authority. Chief activation fails while owned managed-Agent work cannot safely be excluded.

Coordinator state is private, atomic, bounded, and tied to the exact Pi session and initialization generation. It identifies `role: "lead"|"manager"` and may contain one pending supervisor ask. The runtime is socket-scoped under `runtime/supervision-v2/`; project Manager descriptors, assignments, coordinators, and transport inboxes live there. Missing, stale, duplicate, malformed, or ambiguous live/coordination evidence fails closed. Metadata such as `pi_herdsman_role=manager` is display-only. Runtime state (`idle|working|blocked|done|unknown`) is observation, not completion or authorization. Agent counts use `active`, `blocked`, and `total`; active includes working, starting, and settling descendants.

## `supervisor`: one edge upward

Strict actions reject extra or wrong-action fields:

```json
{
  "action": "message",
  "message": "Progress update.",
  "files": ["result:researcher#1"]
}
```

```json
{
  "action": "ask",
  "question": "Which constraint should take priority?",
  "files": ["/tmp/evidence.md"]
}
```

A Lead addresses its active project Manager, or Chief when no Manager is active; a Manager addresses Chief. When a Manager is active, its project Leads are supervised by it, not directly by Chief. Pending asks remain bound to the exact supervisor authority they were sent to; hierarchy changes do not reroute them. Messages are durable follow-ups, not steering or Agent assignments. `ask` is for a genuine decision, must be the sole and final tool call of the turn, and permits only one outstanding question. It persists the question and prepared text before publication. Stop and wait for the exact supervisor's `staff.reply`; escalation to the next supervisor is a separate decision. Questions are bounded by 1,024 characters and UTF-8 bytes.

Only a Lead with exactly one active project assignment targeting its exact session may complete that assignment:

```json
{
  "action": "result",
  "result": "Implemented and checked the endpoint.",
  "files": ["/tmp/check-output.txt"]
}
```

`supervisor.result` persists `result:<assignment-id>` before notifying the current Manager. The canonical artifact includes assignment ID, cwd, Pi session ID, Herdr workspace ID, and branch when known, followed by the result and prepared evidence. Runtime idle is not a substitute. The durable artifact remains after Manager acceptance removes the assignment. An unassigned Lead or a Manager cannot call `result`.

## `staff`: one edge downward

`staff` belongs to Chief and Manager. Chief sees active Managers, with bounded read-only Lead summaries and aggregate Lead/Agent counts. Without an active Manager, Chief may directly supervise ordinary Leads; with an active Manager, Leads in that Manager's worktree group report only to it and are not Chief targets. Manager sees **all** eligible ordinary Leads in its worktree group, not just Leads it delegated. Manager can inspect descendant Agent counts, but cannot target another Lead's Agents. Only Manager can delegate a project Lead. All targets use the exact full `session` Pi ID from a fresh roster; `display_name` and nested Lead IDs under Chief are never actionable.

```json
{ "action": "list" }
```

The result contains `self: {role, session}` and `reports[]`, each with `role`, `session`, `display_name`, `runtime_state`, `needs_you`, `agent_counts`, and `available_actions`. Manager lists also contain `assignments[]` with ID, phase, and known workspace/pane/session identities. Chief reports additionally contain `project`, `lead_counts`, and bounded `leads[]` summaries without actions. Pending asks expose `pending_ask_id`. The automatic bounded `<supervision_state>` is untrusted state-only context, not action authority. Use a fresh snapshot for ordinary state questions; do not poll. Use `list` for a materially needed refresh, `inspect` for bounded live terminal/process evidence, and `transcript` for bounded persisted Pi conversation/tool evidence. A listed `transcript` action is advisory; the read validates the persisted session header and identity.

```json
{ "action": "inspect", "session": "<exact direct-report Pi session ID>" }
```

```json
{ "action": "transcript", "session": "<exact direct-report Pi session ID>" }
```

```json
{
  "action": "message",
  "session": "<exact direct-report Pi session ID>",
  "message": "Please check the boundary.",
  "files": ["result:<assignment-id>"]
}
```

```json
{
  "action": "reply",
  "session": "<exact direct-report Pi session ID>",
  "askId": "<exact pending ask ID>",
  "message": "Proceed."
}
```

Message and reply revalidate current lease, direct-report identity, and action availability. Reply clears the matching pending ask only after accepted delivery. Inspect and transcript do not mutate report state. Attachments on message, reply, and upward actions accept ordinary files, branch-local direct-Agent results, and canonical result refs already supplied as evidence. The transport remains bounded text-only. Pending Lead asks are requeued for a replacement Manager when needed.

### Manager delegation

```json
{
  "action": "delegate",
  "task": "Implement the endpoint and report checks.",
  "branch": "feat/endpoint",
  "base": "main",
  "files": ["/tmp/spec.md"]
}
```

Only `task` is required. The Manager allocates an assignment ID and chooses the branch before any Herdr mutation: it retains a caller-supplied `branch`, or defaults to `herdsman/<assignment-id>`. It persists the assignment with that branch, then always invokes Herdr with an explicit branch:

```text
herdr worktree create --workspace <primary-workspace-id> --branch <branch> --no-focus
```

If supplied, `base` is passed to Herdr; otherwise Herdr selects its default base. Herdr also determines the linked-worktree workspace path and label. The Manager uses the exact returned workspace, tab, and pane identities to start Pi, verifies one exact ordinary Lead, then durably delivers the assignment. On success it returns assignment ID, exact Lead session ID, workspace ID, and branch. There is no caller-selected cwd, pane, Agent definition, focus, review, or merge policy. The linked-worktree workspace remains after completion.

An uncertain external creation result is reconciled using the persisted branch and authoritative Herdr worktree topology. Do not generate another branch or create a second workspace for that assignment; do not blindly retry or delete a possible linked-worktree workspace. An unresolved create/start failure remains visible in its last known phase with a durable error. A Lead's result enters `settling`; missing result notification is requeued for the current Manager, and accepted Manager delivery removes the assignment. Pass the retained `result:<assignment-id>` to another Lead through `files`.

## `/chief` and display

From an eligible ordinary Lead, `/manager` enters Manager mode; `/manager leave` returns to Lead. From an eligible Lead, `/chief` activates Chief; when already Chief it opens the interactive overview. `/chief leave` exits after confirmation where UI is available. A Chief can focus only its exact direct reports. Attention (`needs_you`) is separate from lifecycle; descendant summaries are observational only. A Manager cannot activate Chief. The status and overview are not authority: every action revalidates the exact direct-report identity and current lease.
