---
name: agent-definitions
description: Manage Pi Herdsman Agent definitions and managed Lead configuration. Use when inspecting, creating, customizing, enabling, disabling, or changing Agent-definition models, thinking, tools, skills, extensions, delegation, permissions, or instructions.
---

# Pi Herdsman Agent definitions

Manage Agent definitions through Herdsman's existing Markdown configuration.
The runtime definition engine and canonical documentation remain authoritative;
this skill does not define a second schema or management API.

## Workflow

1. Inspect the current effective definition before changing it.
   - In an ordinary Lead session, use `list_agents` first. It refreshes the
     definition roster and returns effective metadata plus contributing source
     paths.
   - `managed-lead` is intentionally excluded from the Agent roster. Inspect
     its relevant bundled, project, and global layers directly.
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
   - Before editing `managed-lead`, read the canonical schema for its reserved
     restrictions.

4. Validate through Herdsman's existing definition engine.
   - After an edit in a Lead session, call `list_agents` again. Treat any
     discovery or validation failure as a failed edit and repair or restore the
     target file.
   - If `list_agents` is unavailable, do not claim that the effective Herdsman
     definition set was runtime-validated. The next normal definition discovery
     will validate it.

5. Report the changed scope and file, the effective change, and validation.
   Definition changes affect future Agent or managed Lead launches. They do not
   hot-reconfigure a running session. Restart a managed project Lead only when
   the user explicitly asks for the running Lead to pick up changed policy.
