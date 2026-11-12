---
name: agent-definitions
description: Manage Pi Herdsman Agent definitions and reserved Coordinator profiles. Use when inspecting, creating, customizing, enabling, disabling, or changing Agent-definition descriptions, models, thinking, tools, skills, extensions, delegation, permissions, or instructions.
---

# Pi Herdsman Agent definitions

Manage Agent definitions through Herdsman's existing Markdown configuration.
The runtime definition engine and canonical documentation remain authoritative;
this skill does not define a second schema or management API.

## Workflow

1. Inspect the Markdown definition layers before changing configuration.
   - Identify a definition by its frontmatter `name`, never by its filename.
     Inspect bundled, global, trusted project, and private repository layers
     in precedence order (`bundled < global < trusted project < private
repository`), including which files contribute to the effective
     definition. Project and private definitions apply only when Pi trusts the
     project.
   - Resolve matching overlays and effective field values before choosing the
     requested project or global edit scope. The Definitions UI edits global
     files only; compare its global editable values with effective project
     or private values and report masked changes accurately. `list_agents` is useful after an
     edit to invoke Herdsman's existing discovery and validation, but its
     enabled-definition capability summary does not expose source paths or
     complete configuration. It cannot establish effective configuration by
     itself.
   - Disabled definitions, definitions with unavailable required children,
     and reserved Coordinator profiles are not included in the runtime definition
     capability list; inspect their Markdown layers directly. Reserved role
     definitions have special restrictions. Chief is global-only;
     project and private repository Chief definitions are rejected.
   - Read the canonical contract when exact field behavior matters:
     - `../../docs/reference/agent-definition-schema.md`
     - `../../docs/guides/agent-definitions.md`
     - `../../docs/guides/customizing-agents.md`

2. Choose the configuration layer from the requested scope.
   - Agent project policy: `<cwd>/.pi/agents/`; global policy:
     `<agentDir>/agents/`.
   - Coordinator project policy: `<cwd>/.pi/coordinators/`; global
     policy: `<agentDir>/coordinators/`. Pi's agent directory
     normally is `~/.pi/agent`. Managed Lead project policy resolves from
     the trusted delegated worktree.
   - Private repository Agent/Coordinator policy: find the Git common directory with
     `git rev-parse --path-format=absolute --git-common-dir`, then use its
     `pi-herdsman/agents/` or `pi-herdsman/coordinators/` subdirectory. It is
     shared by linked worktrees in one clone only. Referenced skills and
     scripts need their own accessible paths and are not synchronized.
   - Reserved Coordinator names are invalid in Agent directories; ordinary
     Agent names are invalid in Coordinator directories.
   - Coordinator profiles use sibling directories: bundled
     `dist/coordinators/`, global `<agentDir>/coordinators/`, trusted project
     `<cwd>/.pi/coordinators/`, and private repository
     `<git-common-dir>/pi-herdsman/coordinators/`. They overlay in the same
     `bundled < global < trusted project < private repository` order as Agents.
   - Old profile files are not loaded from legacy `roles/` paths. If
     Coordinator discovery reports an actionable migration error, do not
     bypass it or create a fallback: move the profiles and referenced relative
     prompt assets to these canonical destinations, preserving their contents;
     update symlink-managed definitions too. The exact moves are:

     ```text
     <agentDir>/pi-herdsman/roles/       -> <agentDir>/coordinators/
     <project>/.pi/pi-herdsman/roles/    -> <project>/.pi/coordinators/
     <git-common-dir>/pi-herdsman/roles/ -> <git-common-dir>/pi-herdsman/coordinators/
     ```

     Only applicable global, trusted-project, or resolved private repository
     scopes are checked. Agent discovery is independent. Do not automatically
     move, copy, or delete user files.

   - If scope is genuinely ambiguous and materially changes the result, ask.
   - Never edit bundled files under `dist/agents/` or
     `dist/coordinators/`. The Definitions UI defaults to the most specific existing
     editable source (private repository, project, global); bundled-only
     definitions create global overrides. It can select another existing
     scope, but does not create missing project/private files. Project edits
     may be committed; private files are shared by linked worktrees in one
     clone.

3. Make the smallest correct Markdown change.
   - Prefer a partial overlay over copying a complete lower-precedence
     definition.
   - Preserve unrelated frontmatter, body content, and existing source files.
   - The frontmatter `name` is the definition identity; the filename is not.
   - Plain array values replace the inherited array, including `[]`. Use
     `+name` and `-name` entries to add or remove individual inherited values;
     mixed lists use their plain entries as a replacement base before modifiers.
     Modifier-only `tools` lists remain relative to Pi's ordinary selection,
     while plain `tools` lists are closed allowlists. Leads with unrestricted
     implicit `agents` defaults need a concrete allowlist before using
     modifiers.
   - For additive prompt instructions, prefer an overlay body with
     `bodyMode: append`; replace the body only when replacement is intended.
   - Express capability restrictions structurally through definition fields
     rather than relying on prompt prose.
   - For ordinary Agents, make `description` explain capabilities, suitable
     tasks, and meaningful selection boundaries. Keep it accurate when changing
     effective capabilities; follow the Agent-definitions guide.
   - Herdsman preserves `permission:` for compatible extensions but does not
     enforce its contents itself.
   - Before editing a reserved Coordinator profile, read the canonical schema for
     its restrictions and authority boundaries.
   - Lead, Manager, and Chief runtime profiles are not launch definitions. They
     support only `name`, `description`, `body`, `bodyMode` on overlays,
     `tools`, `excludeTools`, and `agents` as their direct-delegation
     allowlist. Do not configure
     model, thinking, prompt launch mode, enabled or permission policy,
     tools-default switches, skills, extensions, or context inheritance on
     these profiles. Their tool policy affects registered ordinary tools;
     Herdsman-owned tools cannot be activated through a profile and mandatory
     required coordination tools remain available. Manager defaults to no
     ordinary tools (`tools: []`); explicit overlays can select registered
     ordinary tools. The saved ordinary Lead tool baseline is restored when
     Manager mode ends. Chief also defaults to no ordinary tools and accepts
     global overrides only. Inspect effective definition layers, validate
     edits, and repeat `/manager` to refresh a running Manager.

4. Validate through Herdsman's existing definition engine where available.
   - After an edit in a Lead session, call `list_agents` again. Treat any
     discovery or validation failure as a failed edit and repair or restore the
     target file. Its returned summary can confirm discoverability and
     validation, not the complete effective configuration or Coordinator
     profile validation. Validate Coordinator profiles through the relevant
     runtime resolution;
     Active role allowlist references must resolve against the Agent roster.
   - If `list_agents` is unavailable, do not claim that the effective Herdsman
     definition set was runtime-validated. The next normal definition discovery
     will validate it.

5. Inspect the effective result using the definition layers and available
   runtime evidence. Report the changed scope and file, effective change, and
   validation evidence; distinguish configuration inspection from runtime
   validation.
   Agent-definition changes affect future Agent assignments; they do not
   mutate an active Agent. Lead execution profiles resolve at session start,
   resume, or `/lead`. Manager and Chief profiles resolve at role activation or
   restoration; repeating `/manager` or `/chief` refreshes the active profile.
   `managed-lead` is launch policy: changes do not hot-reconfigure an assigned
   Lead, and taking effect requires a later managed Lead process start.
