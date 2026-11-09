#!/usr/bin/env node
/**
 * @slashml/mcp (Code Mode) -- Exposes single `execute_memory_code` MCP tool
 * for 91% token reduction on tool definitions.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const mcpBin = path.join(__dirname, "slashml-mcp.js");
const res = spawnSync(process.execPath, [mcpBin, "--code-mode", ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 0);
