---
name: agent-definitions
description: Manage Pi Herdsman Agent definitions and Coordinator profiles. Use when inspecting, creating, customizing, enabling, disabling, or changing definition descriptions, models, thinking, tools, skills, extensions, delegation, permissions, or instructions.
---

# Pi Herdsman Agent definitions

Manage definitions through Herdsman's existing Markdown configuration. The
runtime definition engine and canonical documentation remain authoritative;
this skill does not define another schema or management API.

## Workflow

1. Inspect the selected definition and its applicable configuration layers.
   - Frontmatter `name` plus category determines identity; never infer it from
     the filename. Resolve matching layers in precedence order:
     `bundled < global < trusted project < private repository`.
   - Project definitions apply only when Pi trusts the project. Private
     repository definitions are shared by linked worktrees in one clone under
     `git rev-parse --path-format=absolute --git-common-dir`.
   - `list_agents` reports runtime Agent capabilities, not complete definition
     inventory or editable source layers. The Definitions UI is the inventory
     consumer.

2. Identify the correct canonical editable source.
   - Agents: `agents/`.
   - Coordinators: `coordinators/leads/`, `coordinators/managers/`, and
     `coordinators/chief.md`.
   - The category directory classifies the definition; it does not grant
     authority. Chief is bundled and global only. Only canonical locations
     participate in discovery.
   - Use an existing editable project or private file when appropriate. The
     Definitions UI defaults to the most specific existing source and does not
     create missing project or private files. Project edits may appear in Git;
     private files remain local to the clone.

3. Consult the canonical schema for applicable fields and runtime behavior:
   - `../../docs/reference/agent-definition-schema.md`
   - `../../docs/guides/agent-definitions.md`
   - `../../docs/guides/customizing-agents.md`

   Manager definitions and assigned Lead profiles may have documented launch
   settings. Ordinary Flexible/Orchestrate profiles and Chief are runtime-only.
   Use the schema rather than assuming Coordinator categories share one field
   set.

4. Make the smallest valid configuration change.
   - Prefer a partial overlay and preserve unrelated frontmatter, body content,
     and user files. Keep relative body assets beside their declaring source and
     preserve their contents.
   - Plain arrays replace inherited values; `+name` and `-name` modify arrays
     where supported. Modifier-only `tools` policies inherit Pi's selected
     tools; plain `tools` arrays are closed allowlists.
   - Herdsman preserves `permission:` for compatible extensions but does not
     enforce that policy itself. Tool filtering is not an extension sandbox.

5. Reapply and validate through the appropriate runtime operation.
   - Validate Agent inventory through normal discovery or `list_agents` when
     available. Resolve Coordinator profiles through the relevant operation;
     full inventory discovery remains strict.
   - A valid ordinary Flexible Lead tool policy remains active if Agent
     discovery or its `agents` references are invalid, but fresh delegation is
     denied. If an optional Flexible profile cannot be resolved during
     ordinary startup or branch restoration, a verified ordinary, unbound
     Lead retains only its saved native Pi tool selection; profile additions
     and exclusions are not applied, and new delegation is unavailable. This
     may allow a native tool the unreadable profile intended to exclude.
     Managed, assigned, bound, supervisory, quarantined, and identity-invalid
     sessions do not use this fallback.
   - A failed explicit `/lead-flexible` refresh retains the previous valid
     policy. Repair the profile and run `/lead-flexible` again. Assigned Lead
     profiles take effect on process startup; Manager and Chief profiles are
     refreshed through their existing activation or refresh commands.

6. Report the effective change and validation evidence. Distinguish inspection
   from runtime validation, and do not claim a discovery or runtime operation
   that was unavailable.
