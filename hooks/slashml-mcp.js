#!/usr/bin/env node
"use strict";

/**
 * / ml (SlashML) Official Plugin MCP Server & Lifecycle Hook Handler
 * https://slashml.ai · support@slashml.ai
 *
 * Self-contained stdio MCP server and hook handler for the SlashML plugin.
 * API key is supplied via Claude Code userConfig (CLAUDE_PLUGIN_OPTION_API_KEY).
 */

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const PACKAGE_VERSION = "1.0.15";
const MAX_STOP_BLOCKS_PER_PROMPT = 3;
const DEFAULT_BASE_URL = "https://api.slashml.ai";
const DEFAULT_USER_ID = "default";
const HOOK_DAEMON_IDLE_MS = 15 * 60 * 1000;

function getPluginDaemonSocketPath() {
  if (process.env.SLASHML_DAEMON_SOCK) {
    return process.env.SLASHML_DAEMON_SOCK;
  }
  if (process.env.SLASHML_HOOK_SOCKET) {
    return process.env.SLASHML_HOOK_SOCKET;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const candidate = path.join(os.homedir(), ".slashml", "run", `plugin-hook-daemon-${uid}.sock`);
  if (candidate.length <= 96) {
    return candidate;
  }
  const hash = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 10);
  return path.join(os.tmpdir(), `slashml-plg-${uid}-${hash}.sock`);
}

function shouldUsePluginDaemon(baseUrl) {
  if (process.platform === "win32") return false;
  if (process.env.SLASHML_DISABLE_HOOK_DAEMON === "1") return false;
  if (process.env.SLASHML_FORCE_HOOK_DAEMON === "1") return true;
  const s = String(baseUrl || DEFAULT_BASE_URL);
  if (s.includes("127.0.0.1") || s.includes("localhost")) return false;
  return true;
}

function parseArgs(argv) {
  const out = {
    apiKey: String(
      process.env.CLAUDE_PLUGIN_OPTION_API_KEY || process.env.SLASHML_API_KEY || ""
    ).trim(),
    baseUrl: String(process.env.SLASHML_BASE_URL || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    userId: String(process.env.SLASHML_USER_ID || DEFAULT_USER_ID).trim() || DEFAULT_USER_ID,
    agentId: String(
      process.env.CLAUDE_PLUGIN_OPTION_AGENT_ID || process.env.SLASHML_AGENT_ID || ""
    ).trim(),
    redactPolicy: String(
      process.env.CLAUDE_PLUGIN_OPTION_REDACT_POLICY || process.env.SLASHML_REDACT_POLICY || ""
    ).trim(),
    redactScope: String(
      process.env.CLAUDE_PLUGIN_OPTION_REDACT_SCOPE || process.env.SLASHML_REDACT_SCOPE || ""
    ).trim(),
    isHook: false,
    isHookDaemon: false,
    hookEvent: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exit(0);
    } else if (arg === "--hook") {
      out.isHook = true;
    } else if (arg === "--hook-daemon") {
      out.isHookDaemon = true;
    } else if (arg === "--hook-event" && i + 1 < argv.length) {
      out.hookEvent = String(argv[++i] || "").trim();
    } else if (arg === "--agent-id" && i + 1 < argv.length) {
      out.agentId = String(argv[++i] || "").trim();
    } else if (arg === "--redact-policy" && i + 1 < argv.length) {
      out.redactPolicy = String(argv[++i] || "").trim();
    } else if (arg === "--redact-scope" && i + 1 < argv.length) {
      out.redactScope = String(argv[++i] || "").trim();
    }
  }
  return out;
}

const KEEP_ALIVE_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 8,
  maxFreeSockets: 4,
});
const KEEP_ALIVE_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 8,
  maxFreeSockets: 4,
});

function directKeepAliveJsonRequest(opts, method, endpoint, body, timeoutMs = 30000, extraHeaders = null) {
  return new Promise((resolve, reject) => {
    if (!opts.apiKey) {
      reject(new Error("Missing SlashML API key. Configure api_key in the plugin settings."));
      return;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(`${opts.baseUrl.replace(/\/+$/, "")}${endpoint}`);
    } catch (err) {
      reject(err);
      return;
    }
    const isHttps = parsedUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const agent = isHttps ? KEEP_ALIVE_HTTPS_AGENT : KEEP_ALIVE_HTTP_AGENT;
    const payloadStr = body !== undefined ? JSON.stringify(body) : "";
    const headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Connection: "keep-alive",
      "User-Agent": `slashml-claude-plugin/${PACKAGE_VERSION}`,
    };
    if (opts.agentId) {
      headers["X-SlashML-Agent-Id"] = opts.agentId;
    }
    if (extraHeaders && typeof extraHeaders === "object") {
      Object.assign(headers, extraHeaders);
    }
    if (body !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(payloadStr);
    }
    const req = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = { detail: text };
            }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = (data && (data.detail || data.error || data.message)) || res.statusMessage || "Request failed";
            reject(new Error(`HTTP ${res.statusCode}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.write(payloadStr);
    }
    req.end();
  });
}

function unixSocketPost(socketPath, routePath, payload, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const rawBody = JSON.stringify(payload || {});
    const req = http.request(
      {
        socketPath,
        path: routePath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = { detail: text };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || parsed.detail || `Daemon HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Daemon socket timeout"));
    });
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

async function ensurePluginDaemonRunning(socketPath) {
  try {
    const pingRes = await unixSocketPost(socketPath, "/ping", {}, 250);
    if (pingRes && pingRes.ok) return true;
  } catch {
    // spawn below
  }
  try {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const child = spawn(process.execPath, [__filename, "--hook-daemon"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SLASHML_HOOK_SOCKET: socketPath },
    });
    child.unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    try {
      const pingRes = await unixSocketPost(socketPath, "/ping", {}, 200);
      if (pingRes && pingRes.ok) return true;
    } catch {
      // wait
    }
  }
  return false;
}

async function runPluginDaemonServer() {
  const socketPath = getPluginDaemonSocketPath();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (fs.existsSync(socketPath)) {
    try {
      const pingRes = await unixSocketPost(socketPath, "/ping", {}, 200);
      if (pingRes && pingRes.ok) return;
    } catch {
      // stale socket
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }
  let idleTimer = null;
  const server = http.createServer((req, res) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try {
        server.close();
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      } catch {}
      process.exit(0);
    }, HOOK_DAEMON_IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: process.pid, version: PACKAGE_VERSION }));
        return;
      }
      if (req.url === "/shutdown") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => {
          try {
            server.close();
            if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
          } catch {}
          process.exit(0);
        });
        return;
      }
      let msg = {};
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const reqOpts = msg.opts || {};
      const method = msg.method || "POST";
      const endpoint = msg.endpoint || "/v1/memory/intervene";
      const body = msg.body;
      const timeoutMs = Number(msg.timeoutMs || 25000);
      const extraHeaders = msg.extraHeaders || null;
      if (req.url === "/async") {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true }));
        directKeepAliveJsonRequest(reqOpts, method, endpoint, body, timeoutMs, extraHeaders).catch(() => {});
        return;
      }
      try {
        const out = await directKeepAliveJsonRequest(reqOpts, method, endpoint, body, timeoutMs, extraHeaders);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out || {}));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String((err && err.message) || err) }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {}
      resolve();
    });
  });
  idleTimer = setTimeout(() => {
    try {
      server.close();
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  }, HOOK_DAEMON_IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();

  try {
    const warmUrl = new URL(`${DEFAULT_BASE_URL}/health`);
    if (warmUrl.protocol === "https:") {
      const warmReq = https.request(
        {
          hostname: warmUrl.hostname,
          port: warmUrl.port || 443,
          path: warmUrl.pathname,
          method: "GET",
          agent: KEEP_ALIVE_HTTPS_AGENT,
          headers: { Connection: "keep-alive" },
        },
        (r) => r.resume()
      );
      warmReq.setTimeout(4000, () => warmReq.destroy());
      warmReq.on("error", () => {});
      warmReq.end();
    }
  } catch {}

  await new Promise(() => {});
}

async function apiRequest(opts, method, endpoint, body, timeoutMs = 30000, extraHeaders = null, asyncFireAndForget = false) {
  if (!opts.apiKey) {
    throw new Error(
      "Missing SlashML API key. Configure api_key in the plugin settings."
    );
  }
  if (shouldUsePluginDaemon(opts.baseUrl)) {
    const socketPath = getPluginDaemonSocketPath();
    const ok = await ensurePluginDaemonRunning(socketPath);
    if (ok) {
      try {
        return await unixSocketPost(
          socketPath,
          asyncFireAndForget ? "/async" : "/request",
          { opts, method, endpoint, body, timeoutMs, extraHeaders },
          asyncFireAndForget ? 1500 : timeoutMs
        );
      } catch {
        // fallback to direct keep-alive request below
      }
    }
  }
  return directKeepAliveJsonRequest(opts, method, endpoint, body, timeoutMs, extraHeaders);
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

  const rawHookEvent = String(
    opts.hookEvent || payload.hook_event_name || "UserPromptSubmit"
  ).trim();
  const hookEvent =
    rawHookEvent === "PreInvocation"
      ? "UserPromptSubmit"
      : rawHookEvent === "BeforeTool"
      ? "PreToolUse"
      : rawHookEvent === "AfterTool"
      ? "PostToolUse"
      : rawHookEvent === "AfterAgent"
      ? "Stop"
      : rawHookEvent;

  if (hookEvent === "Stop" && Number(payload.loop_count || 0) >= MAX_STOP_BLOCKS_PER_PROMPT) {
    process.stdout.write("{}\n");
    return;
  }

  const statePath = path.join(os.homedir(), ".slashml", "plugin_hook_state.json");
  let hookState = { stop_turn_by_session: {} };
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.stop_turn_by_session && typeof parsed.stop_turn_by_session === "object") {
        hookState = parsed;
      }
    }
  } catch {
    hookState = { stop_turn_by_session: {} };
  }
  const sessionKey = String(payload.session_id || payload.conversation_id || payload.conversationId || opts.userId || "default").trim();
  const prevStopEntry = hookState.stop_turn_by_session[sessionKey];
  const isStopRetryPreInvocation = Boolean(
    rawHookEvent === "PreInvocation" &&
      payload.invocationNum == null &&
      prevStopEntry &&
      typeof prevStopEntry === "object" &&
      prevStopEntry.awaiting_stop_retry &&
      Date.now() - Number(prevStopEntry.blocked_at_ms || 0) < 120000
  );
  if (hookEvent === "UserPromptSubmit") {
    if (isStopRetryPreInvocation && prevStopEntry) {
      prevStopEntry.awaiting_stop_retry = false;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(hookState), "utf8");
      } catch {
        // ignore state persistence errors
      }
    } else if (hookState.stop_turn_by_session[sessionKey]) {
      hookState.stop_turn_by_session[sessionKey] = { blocked_ids: [], retry_count: 0 };
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(hookState), "utf8");
      } catch {
        // ignore state persistence errors
      }
    }
  }
  const stopTurnEntry =
    (hookState.stop_turn_by_session[sessionKey] && typeof hookState.stop_turn_by_session[sessionKey] === "object")
      ? hookState.stop_turn_by_session[sessionKey]
      : { blocked_ids: [], retry_count: 0 };
  const stopBlockedIds = Array.isArray(stopTurnEntry.blocked_ids)
    ? stopTurnEntry.blocked_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const stopRetryCount = Math.max(0, Number(stopTurnEntry.retry_count || 0));
  if (hookEvent === "Stop" && stopRetryCount >= MAX_STOP_BLOCKS_PER_PROMPT) {
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

  if (
    (hookEvent === "PreToolUse" || hookEvent === "PostToolUse") &&
    toolName &&
    /^(bash|run_command|shell)$/i.test(toolName)
  ) {
    const cmdCheck = String(toolSummary || "")
      .trim()
      .toLowerCase()
      .replace(/^\s*cd\s+[^&;]+(?:&&|;)\s*/, "")
      .replace(/\b2>\s*\/dev\/null\b/g, " ")
      .replace(/\b2>&1\b/g, " ")
      .trim();
    const isReadOnlyCmd =
      /^(ls\b|pwd\b|cat\s|head\s|tail\s|grep\s|rg\s|find\s|git\s+(status|log|diff|branch|show|worktree|rev-parse|remote|tag|describe)\b|which\s|whoami\b|stat\s|wc\s)/.test(
        cmdCheck
      ) && !/[>]|(\brm\s|\bmv\s|\bcp\s|git\s+(push|commit)|\binstall\b)/.test(cmdCheck);
    if (isReadOnlyCmd) {
      process.stdout.write("{}\n");
      return;
    }
  }

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

  const interveneBody = {
    hook_event_name: hookEvent,
    prompt: payload.prompt || deltaText,
    text: deltaText,
    ...(hookEvent === "Stop"
      ? {
          last_assistant_message: deltaText,
          stop_hook_active: Boolean(payload.stop_hook_active) || stopRetryCount > 0,
          turn_blocked_memory_ids: stopBlockedIds,
          stop_retry_count: stopRetryCount,
        }
      : {}),
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: payload.tool_response || null,
    commit_writes: !isStopRetryPreInvocation,
    user_id: opts.userId,
    ...(opts.agentId ? { caller_agent_id: opts.agentId } : {}),
    ...(opts.redactPolicy ? { redact_policy: opts.redactPolicy } : {}),
    ...(opts.redactScope ? { redact_scope: opts.redactScope } : {}),
    ...(payload.session_id ? { session_id: String(payload.session_id) } : {}),
  };

  if (
    hookEvent === "PostToolUse" &&
    process.env.SLASHML_SYNC_POST_HOOK !== "1" &&
    shouldUsePluginDaemon(opts.baseUrl)
  ) {
    try {
      const asyncRes = await apiRequest(opts, "POST", "/v1/memory/intervene", interveneBody, 1500, null, true);
      if (asyncRes && asyncRes.queued) {
        process.stdout.write("{}\n");
        return;
      }
    } catch {
      // fallback below
    }
  }

  try {
    const resp = await apiRequest(
      opts,
      "POST",
      "/v1/memory/intervene",
      interveneBody,
      25000
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
        const newlyTriggered = Array.from(
          new Set(
            [
              ...(Array.isArray(resp.violated_memory_ids) ? resp.violated_memory_ids : []),
              ...(resp.violated_memory_id ? [resp.violated_memory_id] : []),
              ...(Array.isArray(resp.triggered_memory_ids) ? resp.triggered_memory_ids : []),
              ...(resp.triggered_memory_id ? [resp.triggered_memory_id] : []),
            ]
              .map((x) => String(x || "").trim())
              .filter(Boolean)
          )
        );
        const novelStopIds = newlyTriggered.filter((id) => !stopBlockedIds.includes(id));
        if (newlyTriggered.length > 0 && novelStopIds.length === 0) {
          process.stdout.write("{}\n");
          return;
        }
        const mergedIds = Array.from(new Set([...stopBlockedIds, ...novelStopIds])).slice(-16);
        hookState.stop_turn_by_session[sessionKey] = {
          blocked_ids: mergedIds,
          retry_count: stopRetryCount + 1,
          awaiting_stop_retry: true,
          blocked_at_ms: Date.now(),
        };
        try {
          fs.mkdirSync(path.dirname(statePath), { recursive: true });
          fs.writeFileSync(statePath, JSON.stringify(hookState), "utf8");
        } catch {
          // ignore state persistence errors
        }
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
        caller_agent_id: { type: "string" },
        redact_policy: { type: "string" },
        redact_scope: { type: "string" },
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
        caller_agent_id: { type: "string" },
        redact_policy: { type: "string" },
        redact_scope: { type: "string" },
      },
    },
  },
  {
    name: "forget_memory",
    description: "Delete or subject-purge a specific memory ID.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
        user_id: { type: "string" },
        purge: { type: "boolean", default: false },
        caller_agent_id: { type: "string" },
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
        caller_agent_id: { type: "string" },
        redact_policy: { type: "string" },
        redact_scope: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "redact_memory",
    description: "Redact sensitive spans statelessly from text or in-place on a stored memory_id.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        memory_id: { type: "string" },
        redact_policy: { type: "string" },
        caller_agent_id: { type: "string" },
      },
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
  const callerAgent = String(args.caller_agent_id || opts.agentId || "").trim();
  const redactPol = String(
    args.redact_policy || args.sanitize_policy || opts.redactPolicy || ""
  ).trim();
  const redactScp = String(
    args.redact_scope || args.sanitize_scope || opts.redactScope || ""
  ).trim();
  const agentHeaders = callerAgent ? { "X-SlashML-Agent-Id": callerAgent } : null;

  if (name === "search_memories") {
    return apiRequest(
      opts,
      "POST",
      "/v1/memories/search",
      {
        query: String(args.query || ""),
        user_id: uid,
        limit: Number(args.limit ?? 5),
        ...(callerAgent ? { caller_agent_id: callerAgent } : {}),
        ...(redactPol ? { redact_policy: redactPol } : {}),
        ...(redactScp ? { redact_scope: redactScp } : {}),
      },
      15000,
      agentHeaders
    );
  }
  if (name === "get_memories") {
    const q = new URLSearchParams({
      user_id: uid,
      limit: String(args.limit ?? 100),
    });
    if (redactPol) q.set("redact_policy", redactPol);
    if (redactScp) q.set("redact_scope", redactScp);
    return apiRequest(opts, "GET", `/v1/memories/?${q.toString()}`, undefined, 15000, agentHeaders);
  }
  if (name === "forget_memory") {
    if (args.purge) {
      return apiRequest(
        opts,
        "POST",
        "/v1/memory/purge",
        {
          memory_ids: [String(args.memory_id || "")],
          user_id: uid,
          ...(callerAgent ? { caller_agent_id: callerAgent } : {}),
        },
        15000,
        agentHeaders
      );
    }
    const q = new URLSearchParams({ user_id: uid });
    return apiRequest(
      opts,
      "DELETE",
      `/v1/memories/${encodeURIComponent(String(args.memory_id || ""))}/?${q.toString()}`,
      undefined,
      15000,
      agentHeaders
    );
  }
  if (name === "add_memory") {
    return apiRequest(
      opts,
      "POST",
      "/v1/memories/",
      {
        messages: [{ role: "user", content: String(args.text || "") }],
        user_id: uid,
        ...(callerAgent ? { caller_agent_id: callerAgent } : {}),
        ...(redactPol ? { redact_policy: redactPol } : {}),
        ...(redactScp ? { redact_scope: redactScp } : {}),
        ...(args.metadata && typeof args.metadata === "object"
          ? { metadata: args.metadata }
          : {}),
      },
      15000,
      agentHeaders
    );
  }
  if (name === "redact_memory" || name === "sanitize_memory") {
    return apiRequest(
      opts,
      "POST",
      "/v1/memory/redact",
      {
        ...(args.text !== undefined ? { text: String(args.text) } : {}),
        ...(args.memory_id !== undefined ? { memory_id: String(args.memory_id) } : {}),
        ...(redactPol ? { redact_policy: redactPol } : {}),
        ...(callerAgent ? { caller_agent_id: callerAgent } : {}),
      },
      15000,
      agentHeaders
    );
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

if (parsed.isHookDaemon) {
  runPluginDaemonServer()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
} else if (parsed.isHook) {
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
