---
name: agent-definitions
description: Manage Pi Herdsman Agent definitions and reserved role profiles. Use when inspecting, creating, customizing, enabling, disabling, or changing Agent-definition models, thinking, tools, skills, extensions, delegation, permissions, or instructions.
---

# Pi Herdsman Agent definitions

Manage Agent definitions through Herdsman's existing Markdown configuration.
The runtime definition engine and canonical documentation remain authoritative;
this skill does not define a second schema or management API.

## Workflow

1. Inspect the Markdown definition layers before changing configuration.
   - Identify a definition by its frontmatter `name`, never by its filename.
     Inspect bundled, trusted project, and global layers in precedence order
     (`bundled < project < global`), including which files contribute to the
     effective definition. Project definitions apply only when Pi trusts the
     project.
   - Resolve matching overlays and effective field values before choosing the
     requested project or global edit scope. `list_agents` is useful after an
     edit to invoke Herdsman's existing discovery and validation, but its
     enabled-definition capability summary does not expose source paths or
     complete configuration. It cannot establish effective configuration by
     itself.
   - Disabled definitions, definitions with unavailable required children,
     and reserved role profiles are not included in the runtime definition
     capability list; inspect their Markdown layers directly. Reserved role
     definitions have special restrictions. Chief is global-only;
     project-local Chief definitions are rejected.
   - Read the canonical contract when exact field behavior matters:
     - `../../docs/reference/agent-definition-schema.md`
     - `../../docs/guides/agent-definitions.md`
     - `../../docs/guides/customizing-agents.md`

2. Choose the configuration layer from the requested scope.
   - Project policy: `<cwd>/.pi/agents/`.
   - Global user policy: `$PI_CODING_AGENT_DIR/agents/` when that variable is
     set, otherwise `~/.pi/agent/agents/`.
   - If scope is genuinely ambiguous and materially changes the result, ask.
   - Never edit bundled definitions under `dist/agent-definitions/`.

3. Make the smallest correct Markdown change.
   - Prefer a partial overlay over copying a complete lower-precedence
     definition.
   - Preserve unrelated frontmatter, body content, and existing source files.
   - The frontmatter `name` is the definition identity; the filename is not.
   - Array fields replace the whole lower-precedence array. Before adding or
     removing one array value, inspect the effective array and write the desired
     complete replacement.
   - For additive prompt instructions, prefer an overlay body with
     `bodyMode: append`; replace the body only when replacement is intended.
   - Express capability restrictions structurally through definition fields
     rather than relying on prompt prose.
   - Herdsman preserves `permission:` for compatible extensions but does not
     enforce its contents itself.
   - Before editing a reserved role definition, read the canonical schema for
     its restrictions and authority boundaries.
   - Lead, Manager, and Chief runtime profiles are not launch definitions. They
     support only `name`, `description`, `body`, `bodyMode` on overlays,
     `tools`, and `excludeTools`. Do not configure
     model, thinking, prompt launch mode, enabled/permission/agent policy,
     tools-default switches, skills, extensions, or context inheritance on
     these profiles. Their tool policy affects registered ordinary tools;
     Herdsman-owned tools cannot be activated through a profile and mandatory
     required coordination tools remain available. Manager preserves the saved
     ordinary Lead tool baseline when `tools` is omitted. Chief defaults to no
     ordinary tools and accepts global overrides only.

4. Validate through Herdsman's existing definition engine where available.
   - After an edit in a Lead session, call `list_agents` again. Treat any
     discovery or validation failure as a failed edit and repair or restore the
     target file. Its returned summary can confirm discoverability and
     validation, not the complete effective configuration.
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
