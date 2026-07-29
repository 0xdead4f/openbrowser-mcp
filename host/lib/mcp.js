// Minimal MCP stdio server: newline-delimited JSON-RPC 2.0 on stdin/stdout.
// Replaces @modelcontextprotocol/sdk + zod, which cost +28 MB RSS per process —
// ~700 MB across the measured 25-way agent fan-out — for a stdio<->TCP pipe.
//
// MCP stdio framing is NOT Content-Length framed; one JSON object per line.
// stdout carries JSON-RPC and nothing else: every diagnostic goes to stderr.
//
// A `--sdk` escape hatch is specified as a documented no-op: the flag is
// accepted by mcp-server.js and deliberately does nothing here, because
// importing the SDK is the exact cost this file exists to avoid. If protocol
// drift ever forces the SDK back, it lands as a separate module, not an import.

import { createLineReader, encodeLine } from "./framing.js";

// Ported from mcp-server.js's pre-validation pass. Models routinely hand back
// JSON-encoded strings for structured params, and one coercion here is cheaper
// than a failed tool call plus a retry.
const JSON_ARRAY_KEYS = new Set(["coordinate", "start_coordinate", "region"]);
const LIST_KEYS = new Set(["include", "exclude", "origins", "resourceTypes"]);

function parseArrayish(value, { csv, numeric }) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to the comma-separated reading
    }
  }
  if (!csv) return value;
  if (trimmed === "") return [];
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  if (!numeric) return parts;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : parts;
}

function coerceValue(key, value, propSchema) {
  if (typeof value !== "string") return value;
  const type = propSchema && propSchema.type;

  if (key === "tabId" || type === "number" || type === "integer") {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) ? n : value;
  }
  if (type === "boolean" || !type) {
    if (value === "true") return true;
    if (value === "false") return false;
    if (type === "boolean") return value;
  }
  if (type === "array" || JSON_ARRAY_KEYS.has(key) || LIST_KEYS.has(key)) {
    const numeric = JSON_ARRAY_KEYS.has(key);
    return parseArrayish(value, { csv: numeric || LIST_KEYS.has(key) || type === "array", numeric });
  }
  return value;
}

export function coerceArgs(args, inputSchema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const props = (inputSchema && inputSchema.properties) || {};
  for (const key of Object.keys(args)) {
    args[key] = coerceValue(key, args[key], props[key]);
  }
  return args;
}

// Instructive errors are cheaper than retries: name the field, its type and its
// own description rather than emitting a schema-validation blob.
function missingRequired(tool, args) {
  const schema = tool.inputSchema || {};
  if (!Array.isArray(schema.required) || schema.required.length === 0) return null;
  const props = schema.properties || {};
  // `required` is presence-based: an explicitly-null nullable field is present, and that is
  // the documented spelling of browser_select({browserId:null}) — clearing the pin.
  const missing = schema.required.filter((k) => {
    if (args[k] === undefined) return true;
    if (args[k] !== null) return false;
    const t = (props[k] || {}).type;
    return !(Array.isArray(t) && t.includes("null"));
  });
  if (missing.length === 0) return null;

  const lines = missing.map((k) => {
    const p = props[k] || {};
    const type = Array.isArray(p.type) ? p.type.join("|") : p.type || "value";
    const desc = p.description ? ` — ${p.description}` : "";
    return `  ${k} (${type})${desc}`;
  });
  const noun = missing.length > 1 ? "parameters" : "parameter";
  return `Missing required ${noun} for ${tool.name}:\n${lines.join("\n")}`;
}

function errorResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export class McpStdioServer {
  constructor({ name, version, protocolVersion, tools, onCall }) {
    this.name = name;
    this.version = version;
    this.protocolVersion = protocolVersion;
    this.tools = tools || [];
    this.onCall = onCall;
    this.started = false;
    this.toolsByName = new Map(this.tools.map((t) => [t.name, t]));
  }

  start() {
    if (this.started) return this;
    this.started = true;
    const reader = createLineReader((line) => this.handleLine(line));
    process.stdin.on("data", reader);
    process.stdin.on("error", () => {});
    process.stdin.resume();
    return this;
  }

  send(message) {
    process.stdout.write(encodeLine(message));
  }

  reply(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  replyError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.replyError(null, -32700, "Parse error");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return; // a response, not a request
    this.dispatch(msg).catch((err) => {
      process.stderr.write(`mcp dispatch failed: ${err && err.message}\n`);
    });
  }

  async dispatch(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        if (!isNotification) {
          this.reply(id, {
            protocolVersion: this.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version },
          });
        }
        return;

      case "tools/list":
        if (!isNotification) this.reply(id, { tools: this.tools });
        return;

      case "tools/call": {
        if (isNotification) return;
        this.reply(id, await this.callTool(params));
        return;
      }

      case "ping":
        if (!isNotification) this.reply(id, {});
        return;

      default:
        if (method.startsWith("notifications/") || isNotification) return;
        this.replyError(id, -32601, `Method not found: ${method}`);
    }
  }

  // A failing tool is a normal result with isError, never a JSON-RPC error —
  // that is what lets the model read the message and correct itself.
  async callTool(params) {
    const name = params && params.name;
    const tool = this.toolsByName.get(name);
    if (!tool) return errorResult(`Unknown tool: ${name}`);

    const args = coerceArgs(params.arguments, tool.inputSchema);
    const missing = missingRequired(tool, args);
    if (missing) return errorResult(missing);

    try {
      const result = await this.onCall(name, args);
      if (typeof result === "string") return { content: [{ type: "text", text: result }] };
      if (result && Array.isArray(result.content)) return result;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResult((err && err.message) || String(err));
    }
  }
}
