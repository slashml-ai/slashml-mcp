# `@slashml/mcp` -- SlashML MCP Server

Official Model Context Protocol (MCP) server for **SlashML (`/` `ml`)**. Connects coding and chat agents to the SlashML Cloud API (`https://api.slashml.ai`).

## Quick Install

### Claude Code (1-liner)
```bash
claude mcp add --scope user ml-memory -- env SLASHML_API_KEY=sml_live_xxx npx -y @slashml/mcp
```

### Cursor / Claude Desktop / Windsurf (`mcp.json`)
```json
{
  "mcpServers": {
    "ml-memory": {
      "command": "npx",
      "args": ["-y", "@slashml/mcp"],
      "env": {
        "SLASHML_API_KEY": "sml_live_xxx"
      }
    }
  }
}
```

### Code Mode
Expose a single `execute_memory_code` meta-tool:
```bash
claude mcp add --scope user ml-memory-code -- env SLASHML_API_KEY=sml_live_xxx npx -y @slashml/mcp --code-mode
```

### Ambient Lifecycle Hooks
Register `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` hooks in `~/.claude/settings.json`:
```bash
npx -y @slashml/mcp --install-hooks --api-key "$SLASHML_API_KEY"
```

## Available Tools (Standard Mode)
1. `search_memories` -- Search stored conversational memories, user preferences, and facts.
2. `get_memories` -- List conversational memories for a user/agent scope.
3. `forget_memory` -- Delete or subject-purge (`purge: true`) a specific memory by ID.
4. `redact_memory` -- Redact sensitive spans statelessly (`text`) or in-place (`memory_id`) under a policy preset (`tier1_secrets`, `soc2_coding`, `gdpr`, `hipaa`, `enterprise_strict`).
5. `dismiss_intervention` -- Record that an active pre-tool intervention was a false positive or superseded for the current target.
6. `index_repository` -- Index a git repository for code search and bug localization.
7. `search_code_by_behavior` -- Search indexed repository symbols by behavioral or architectural description.
8. `find_bug_candidates` -- Rank likely bug locations across a repository from symptoms and stack traces.
9. `add_memory` *(opt-in via `--enable-write-tool`; ambient lifecycle hooks assimilate memories automatically by default)* -- Explicitly store a persistent conversational memory, user preference, or operational rule.

## Per-Agent Access & Redaction Environment Variables
- `SLASHML_AGENT_ID` (or `--agent-id`): Attaches `X-SlashML-Agent-Id` to enforce per-agent `read_write` / `read_only` access modes and redaction clearances configured in `https://app.slashml.ai` (**Redaction & Access**).
- `SLASHML_REDACT_POLICY` (or `--redact-policy`): Default redaction policy preset or comma-separated buckets.
- `SLASHML_REDACT_SCOPE` (or `--redact-scope`): `memorize_and_recall` or `recall_only`.

## License
Apache-2.0. Connects to the SlashML Cloud Service (`https://api.slashml.ai`).
