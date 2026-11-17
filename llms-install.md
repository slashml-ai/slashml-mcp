# SlashML (`/ml`) MCP Server Installation Guide for AI Agents (`llms-install.md`)

This document instructs AI coding agents (Cline, Claude Code, OpenAI Codex, Cursor, Windsurf) how to install and configure `@slashml/mcp`.

## Prerequisites
* Node.js `>= 18.0.0` (`npx` available on `PATH`)
* A `SLASHML_API_KEY` (`sml_live_...`) from `https://app.slashml.ai` (ask the user for their API key if not already set in the environment).

## 1. Standard MCP Configuration (`mcp.json` / `cline_mcp_settings.json`)
Add the following entry under `mcpServers`:

```json
{
  "mcpServers": {
    "ml-memory": {
      "command": "npx",
      "args": [
        "-y",
        "@slashml/mcp@latest"
      ],
      "env": {
        "SLASHML_API_KEY": "YOUR_SLASHML_API_KEY",
        "SLASHML_AGENT_ID": "optional_agent_id",
        "SLASHML_REDACT_POLICY": "optional_preset_such_as_soc2_coding"
      }
    }
  }
}
```

## 2. Claude Code CLI One-Liner (Local Stdio or Remote Streamable HTTP)
```bash
# Option A: Local stdio server
claude mcp add --scope user ml-memory -- env SLASHML_API_KEY=YOUR_SLASHML_API_KEY npx -y @slashml/mcp@latest

# Option B: Remote Streamable HTTP server (1-click OAuth 2.1 at https://app.slashml.ai/oauth/authorize)
claude mcp add --transport http --scope user ml-memory https://api.slashml.ai/mcp
claude mcp add --transport http --scope user slashml-robotics https://api.slashml.ai/robotics/mcp

# Option C: Claude Code Plugin Marketplace
# /plugin marketplace add slashml-ai/claude-slashml-memory
# /plugin install ml-memory@slashml-marketplace
```

## 3. OpenAI Codex CLI, Gemini CLI & Portable Agent Skills
```bash
npx skills add slashml-ai/ml-memory --skill slashml-memory
codex mcp add ml-memory -- npx -y @slashml/mcp@latest
gemini extensions install https://github.com/slashml-ai/gemini-slashml-memory
```

## 4. Verification
Run `npx -y @slashml/mcp@latest --version` to verify the binary resolves cleanly (`1.0.16`), or check the Official MCP Registry listings `ai.slashml/ml-memory` and `ai.slashml/slashml-robotics`.
