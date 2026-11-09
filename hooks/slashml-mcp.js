#!/usr/bin/env node
"use strict";

/**
 * / ml (SlashML) Official Plugin MCP Server & Lifecycle Hook Handler
 * https://slashml.ai · support@slashml.ai
 *
 * Self-contained stdio MCP server and hook handler for the SlashML plugin.
 * API key is supplied via Claude Code userConfig (CLAUDE_PLUGIN_OPTION_API_KEY).
 */

const readline = require("readline");

const PACKAGE_VERSION = "1.0.11";
const DEFAULT_BASE_URL = "https://api.slashml.ai";
const DEFAULT_USER_ID = "default";

function parseArgs(argv) {
  const out = {
    apiKey: String(process.env.CLAUDE_PLUGIN_OPTION_API_KEY || "").trim(),
    baseUrl: DEFAULT_BASE_URL,
    userId: DEFAULT_USER_ID,
    isHook: false,
    hookEvent: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exit(0);
    } else if (arg === "--hook") {
      out.isHook = true;
    } else if (arg === "--hook-event" && i + 1 < argv.length) {
      out.hookEvent = String(argv[++i] || "").trim();
    }
  }
  return out;
}

async function apiRequest(opts, method, endpoint, body, timeoutMs = 15000) {
  if (!opts.apiKey) {
    throw new Error(
      "Missing SlashML API key. Configure api_key in the plugin settings."
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${opts.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": `slashml-claude-plugin/${PACKAGE_VERSION}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { detail: text };
      }
    }
    if (!res.ok) {
      const msg = (data && (data.detail || data.error || data.message)) || res.statusText;
      throw new Error(`HTTP ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const HOOK_READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "view_file_outline",
  "view_code_item",
  "grep",
  "grep_search",
  "glob",
  "find_by_name",
  "ls",
  "list_dir",
  "todowrite",
  "todoread",
  "websearch",
  "search_web",
  "webfetch",
  "read_url_content",
  "askuserquestion",
  "ask_question",
]);

async function runHookMode(opts) {
  let rawInput = "";
  try {
    for await (const chunk of process.stdin) {
      rawInput += chunk.toString("utf8");
    }
  } catch {
    rawInput = "";
  }
  rawInput = rawInput.trim();
  if (!rawInput || !opts.apiKey) {
    process.stdout.write("{}\n");
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(rawInput);
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  const hookEvent = String(
    opts.hookEvent || payload.hook_event_name || "UserPromptSubmit"
  ).trim();

  if (hookEvent === "Stop" && (payload.stop_hook_active || payload.loop_count > 0)) {
    process.stdout.write("{}\n");
    return;
  }

  const toolName = String(payload.tool_name || "").trim() || null;
  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;

  if ((hookEvent === "PreToolUse" || hookEvent === "PostToolUse") && toolName) {
    if (HOOK_READ_ONLY_TOOLS.has(toolName.toLowerCase())) {
      process.stdout.write("{}\n");
      return;
    }
  }

  const toolSummary = toolInput
    ? toolInput.command ||
      toolInput.CommandLine ||
      toolInput.Replacement ||
      toolInput.new_string ||
      toolInput.Content ||
      toolInput.content ||
      JSON.stringify(toolInput)
    : "";

  let candidateText = "";
  if (hookEvent === "PreToolUse") {
    candidateText = String(toolSummary || "");
  } else if (hookEvent === "PostToolUse") {
    const respVal = payload.tool_response || payload.toolResponse || payload.output;
    candidateText = String(
      (respVal ? (typeof respVal === "string" ? respVal : JSON.stringify(respVal)) : "") ||
        toolSummary ||
        ""
    );
  } else if (hookEvent === "Stop") {
    candidateText = String(
      payload.last_assistant_message || payload.assistant_message || payload.response || ""
    );
  } else {
    candidateText = String(payload.prompt || payload.user_prompt || payload.text || "");
  }

  const deltaText = candidateText.replace(/\s+/g, " ").trim().slice(0, 1024);
  if (!deltaText || deltaText.length < 4) {
    process.stdout.write("{}\n");
    return;
  }

  try {
    const resp = await apiRequest(
      opts,
      "POST",
      "/v1/memory/intervene",
      {
        hook_event_name: hookEvent,
        prompt: payload.prompt || deltaText,
        text: deltaText,
        ...(hookEvent === "Stop"
          ? {
              last_assistant_message: deltaText,
              stop_hook_active: Boolean(payload.stop_hook_active),
            }
          : {}),
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: payload.tool_response || null,
        commit_writes: true,
        user_id: opts.userId,
        ...(payload.session_id ? { session_id: String(payload.session_id) } : {}),
      },
      8000
    );

    if (hookEvent === "PreToolUse") {
      if (
        resp &&
        resp.should_intervene &&
        resp.intervention_severity === "BLOCK" &&
        resp.intervention_message
      ) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: String(resp.intervention_message),
            },
          }) + "\n"
        );
        return;
      }
      process.stdout.write("{}\n");
      return;
    }

    if (hookEvent === "UserPromptSubmit" || hookEvent === "PostToolUse") {
      if (resp && resp.should_intervene && resp.intervention_message) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: hookEvent,
              additionalContext: String(resp.intervention_message),
            },
          }) + "\n"
        );
        return;
      }
      process.stdout.write("{}\n");
      return;
    }

    if (hookEvent === "Stop") {
      if (
        resp &&
        resp.should_intervene &&
        resp.intervention_severity === "BLOCK" &&
        resp.intervention_message
      ) {
        process.stdout.write(
          JSON.stringify({
            decision: "block",
            reason: String(resp.intervention_message),
          }) + "\n"
        );
        return;
      }
      process.stdout.write("{}\n");
      return;
    }

    process.stdout.write("{}\n");
  } catch {
    process.stdout.write("{}\n");
  }
}

const STANDARD_TOOLS = [
  {
    name: "search_memories",
    description: "Retrieve relevant memories and code context for a natural-language query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        user_id: { type: "string" },
        limit: { type: "integer", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memories",
    description: "List stored memories for a user or workspace.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        limit: { type: "integer", default: 100 },
      },
    },
  },
  {
    name: "forget_memory",
    description: "Delete a specific memory ID.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
        user_id: { type: "string" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "add_memory",
    description: "Store a new fact, preference, architectural decision, or rule in SlashML memory.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        user_id: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["text"],
    },
  },
  {
    name: "index_repository",
    description: "Index source files in the current workspace for behavioral search and bug localization.",
    inputSchema: {
      type: "object",
      properties: {
        repo_name: { type: "string", default: "workspace" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        user_id: { type: "string" },
      },
    },
  },
  {
    name: "search_code_by_behavior",
    description: "Search indexed code symbols by architectural or runtime behavior.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        user_id: { type: "string" },
        top_k: { type: "integer", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "find_bug_candidates",
    description: "Rank candidate functions or files most likely responsible for a bug or stack trace.",
    inputSchema: {
      type: "object",
      properties: {
        bug_description: { type: "string" },
        stack_trace: { type: "string", default: "" },
        user_id: { type: "string" },
        top_k: { type: "integer", default: 5 },
      },
      required: ["bug_description"],
    },
  },
  {
    name: "dismiss_intervention",
    description: "Dismiss a memory intervention for the current session when overriding a rule intentionally.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["memory_id"],
    },
  },
];

async function dispatchTool(opts, name, rawArgs) {
  const args = rawArgs || {};
  const uid = args.user_id || opts.userId;

  if (name === "search_memories") {
    return apiRequest(opts, "POST", "/v1/memories/search", {
      query: String(args.query || ""),
      user_id: uid,
      limit: Number(args.limit ?? 5),
    });
  }
  if (name === "get_memories") {
    const q = new URLSearchParams({
      user_id: uid,
      limit: String(args.limit ?? 100),
    });
    return apiRequest(opts, "GET", `/v1/memories/?${q.toString()}`);
  }
  if (name === "forget_memory") {
    const q = new URLSearchParams({ user_id: uid });
    return apiRequest(
      opts,
      "DELETE",
      `/v1/memories/${encodeURIComponent(String(args.memory_id || ""))}/?${q.toString()}`
    );
  }
  if (name === "add_memory") {
    return apiRequest(opts, "POST", "/v1/memories/", {
      messages: [{ role: "user", content: String(args.text || "") }],
      user_id: uid,
      ...(args.metadata && typeof args.metadata === "object"
        ? { metadata: args.metadata }
        : {}),
    });
  }
  if (name === "index_repository") {
    const files = Array.isArray(args.files) ? args.files : [];
    const repoName = String(args.repo_name || args.repo_path || "workspace");
    if (!files.length) {
      return { indexed_files: 0, indexed_symbols: 0, repo_name: repoName };
    }
    return apiRequest(
      opts,
      "POST",
      "/v1/code/index",
      {
        files,
        user_id: uid,
        repo_name: repoName,
      },
      60000
    );
  }
  if (name === "search_code_by_behavior") {
    return apiRequest(opts, "POST", "/v1/code/search", {
      query: String(args.query || ""),
      user_id: uid,
      top_k: Number(args.top_k ?? 5),
    });
  }
  if (name === "find_bug_candidates") {
    return apiRequest(opts, "POST", "/v1/code/find-bugs", {
      bug_description: String(args.bug_description || ""),
      stack_trace: String(args.stack_trace || ""),
      user_id: uid,
      top_k: Number(args.top_k ?? 5),
    });
  }
  if (name === "dismiss_intervention") {
    const memId = String(args.memory_id || "").trim();
    const reason = String(args.reason || "Intentional override").trim();
    await apiRequest(opts, "POST", "/v1/memory/intervene", {
      hook_event_name: "UserPromptSubmit",
      prompt: `Dismiss intervention for ${memId}: ${reason}`,
      text: `Dismiss intervention for ${memId}: ${reason}`,
      overridden_memory_ids: [memId],
      dismiss_memory_ids: [memId],
      commit_writes: false,
      user_id: uid,
    });
    return { status: "dismissed", overridden_memory_ids: [memId], reason };
  }
  throw new Error(`Unknown MCP tool: ${name}`);
}

const parsed = parseArgs(process.argv.slice(2));

if (parsed.isHook) {
  runHookMode(parsed)
    .then(() => process.exit(0))
    .catch(() => {
      process.stdout.write("{}\n");
      process.exit(0);
    });
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let rpcChain = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    rpcChain = rpcChain.then(async () => {
      try {
        const req = JSON.parse(trimmed);
        const { method, id, params } = req;
        if (
          id === undefined ||
          id === null ||
          (typeof method === "string" && method.startsWith("notifications/"))
        ) {
          return;
        }
        if (method === "ping") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
          return;
        }
        if (method === "initialize") {
          const clientProto =
            typeof params?.protocolVersion === "string" && params.protocolVersion
              ? params.protocolVersion
              : "2024-11-05";
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: clientProto,
                serverInfo: { name: "ml-memory", version: PACKAGE_VERSION },
                capabilities: { tools: {} },
              },
            }) + "\n"
          );
          return;
        }
        if (method === "resources/list") {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id, result: { resources: [] } }) + "\n"
          );
          return;
        }
        if (method === "resources/templates/list") {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } }) + "\n"
          );
          return;
        }
        if (method === "prompts/list") {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id, result: { prompts: [] } }) + "\n"
          );
          return;
        }
        if (method === "tools/list") {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id, result: { tools: STANDARD_TOOLS } }) + "\n"
          );
          return;
        }
        if (method === "tools/call") {
          try {
            const result = await dispatchTool(parsed, params?.name, params?.arguments);
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify(result) }] },
              }) + "\n"
            );
          } catch (err) {
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  isError: true,
                  content: [{ type: "text", text: String(err.message || err) }],
                },
              }) + "\n"
            );
          }
          return;
        }
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          }) + "\n"
        );
      } catch {
        // ignore malformed lines
      }
    });
  });
}
