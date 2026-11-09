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
3. `forget_memory` -- Delete a specific memory by ID.
4. `dismiss_intervention` -- Record that an active pre-tool intervention was a false positive or superseded for the current target.
5. `index_repository` -- Index a git repository for code search and bug localization.
6. `search_code_by_behavior` -- Search indexed repository symbols by behavioral or architectural description.
7. `find_bug_candidates` -- Rank likely bug locations across a repository from symptoms and stack traces.
8. `add_memory` *(opt-in via `--enable-write-tool`; ambient lifecycle hooks assimilate memories automatically by default)* -- Explicitly store a persistent conversational memory, user preference, or operational rule.

## License
Apache-2.0. Connects to the SlashML Cloud Service (`https://api.slashml.ai`).
