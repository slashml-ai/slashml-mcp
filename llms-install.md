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
        "@slashml/mcp"
      ],
      "env": {
        "SLASHML_API_KEY": "YOUR_SLASHML_API_KEY"
      }
    }
  }
}
```

## 2. Claude Code CLI One-Liner
```bash
claude mcp add --scope user ml-memory -- env SLASHML_API_KEY=YOUR_SLASHML_API_KEY npx -y @slashml/mcp
```

## 3. OpenAI Codex CLI & Portable Agent Skills
```bash
npx skills add slashml-ai/ml-memory --skill slashml-memory
codex mcp add ml-memory -- npx -y @slashml/mcp
```

## 4. Verification
Run `npx -y @slashml/mcp --version` to verify the binary resolves cleanly (`1.0.11`).
