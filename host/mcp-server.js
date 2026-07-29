#!/usr/bin/env node

// MCP server for the OpenBrowser MCP extension.
// Started by Claude Code via stdio MCP transport (one process per agent), OR as a detached broker
// via `--broker`.
//
// Roles:
// - BROKER (`--broker`): a detached, long-lived process that owns the TCP port and every native-host
//   connection and relays between the browsers and every client. It is spawned lazily by the first
//   agent that finds no broker running, and it OUTLIVES all agents — so an agent finishing never
//   tears down the browser bridge. This is what lets many concurrent agents share one browser.
// - CLIENT: a per-agent MCP server (the normal launch). It ensures a broker exists, then connects to
//   it as a client. All agents are clients.
// - PRIMARY (legacy fallback): if no broker can be started, an agent binds the port itself.

import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createLineReader, encodeLine } from "./lib/framing.js";
import {
  DEFAULT_PORT,
  loadConfig,
  spoolDir,
  pidfilePath,
  legacyPidfilePaths,
  PROTOCOL_VERSION,
  SERVER_NAME,
  VERSION,
} from "./lib/config.js";
import { McpStdioServer } from "./lib/mcp.js";
import { TOOLS, BROKER_LOCAL } from "./lib/tools.js";
import { BrowserRegistry } from "./lib/registry.js";
import { DownloadSink } from "./lib/sink.js";
import { extractEndpoints, diffUnexercised } from "./lib/endpoints.js";

const CONFIG = loadConfig();
const TCP_PORT = CONFIG.port || DEFAULT_PORT;

const BROKER_MODE = process.argv.includes("--broker");
// Installer support: block until a browser's extension actually completes the handshake, so
// install.sh can print positive confirmation instead of "restart your browser and hope".
const WAIT_FOR_HOST = process.argv.includes("--wait-for-host");
const SELF_PATH = fileURLToPath(import.meta.url);

// The broker retires after this long with zero connected clients, so it never leaks across runs.
const BROKER_IDLE_MS = 5 * 60 * 1000;
let brokerIdleTimer = null;

// Agents run as CLIENT; the broker runs as PRIMARY. (Legacy in-process primary is a fallback.)
let mode = "primary"; // or "client"

const registry = new BrowserRegistry();

// Requests this process owns (agent tool calls), keyed by the plain id we minted.
const pendingRequests = new Map(); // id -> { resolve, reject, timer, tool, args, browserId, timeoutMs, resent }
let requestIdCounter = 0;
const downloads = new Map(); // id -> streaming sources_download state

// Broker: connected agents and their in-flight requests.
const clientSockets = new Map(); // clientId -> { socket, cwd, pid }
let clientIdCounter = 0;
const clientRequestMap = new Map(); // prefixed id -> { clientId, originalId, browserId, tool, args, resent }

// Client: TCP connection to the broker.
let brokerSocket = null;
let myClientId = null;

// A download can legitimately run for minutes; everything else keeps the inherited 60 s budget.
const TOOL_TIMEOUT_MS = { sources_download: 600000, sources_list: 120000 };

// --- Pidfile management ---

const PIDFILE = pidfilePath(TCP_PORT);

function writePidfile() {
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch {}
}

function cleanupPidfile() {
  try {
    const content = fs.readFileSync(PIDFILE, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(PIDFILE);
  } catch {}
}

function shutdown() {
  if (mode === "primary") cleanupPidfile();
  for (const entry of registry.browsers.values()) {
    if (entry.socket && !entry.socket.destroyed) entry.socket.destroy();
  }
  if (brokerSocket && !brokerSocket.destroyed) brokerSocket.destroy();
  for (const { socket } of clientSockets.values()) {
    if (!socket.destroyed) socket.destroy();
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (mode === "primary") tcpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (!BROKER_MODE && !WAIT_FOR_HOST) {
  // Agents are stdio MCP children: exit when the parent closes stdin, and on SIGHUP. stdin is left
  // PAUSED until McpStdioServer.start() attaches its reader — resuming here would put stdin in
  // flowing mode with no consumer and silently drop the `initialize` that arrives while
  // ensureBroker() is still polling for a broker to come up.
  process.on("SIGHUP", shutdown);
  process.stdin.on("end", shutdown);
}
// The detached broker has stdio="ignore" → stdin is EOF immediately, so it must NOT treat stdin-end
// as shutdown, and it ignores SIGHUP so a closing parent shell can't kill it. It exits only on
// SIGTERM/SIGINT or the idle timer.

// --- Broker: net_body spool ---
// Eagerly-captured response bodies (§5.4) land on disk here and are never routed to a client.

const SPOOL_DIR = spoolDir();
const SPOOL_LIMIT_BYTES = 256 * 1024 * 1024;
const openSpools = new Map(); // browserId/tabId/requestId -> { stream, bytes, bin, meta }
let spoolFiles = []; // { bin, meta, bytes, at } — oldest first
let spoolBytes = 0;

function safeSeg(value) {
  return String(value ?? "_").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
}

function spoolNetBody(browserId, msg) {
  // `captureBodies` is only reachable from here — the extension has no view of config.json — so this
  // is where the switch has to bite: false means captured bodies are dropped instead of kept on disk.
  if (!CONFIG.captureBodies) return;

  const key = `${browserId}/${msg.tabId}/${msg.requestId}`;
  let spool = openSpools.get(key);
  if (!spool) {
    const dir = path.join(SPOOL_DIR, safeSeg(browserId), safeSeg(msg.tabId));
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
    const bin = path.join(dir, `${safeSeg(msg.requestId)}.bin`);
    spool = { bin, meta: `${bin.slice(0, -4)}.meta.json`, bytes: 0, stream: fs.createWriteStream(bin) };
    spool.stream.on("error", () => openSpools.delete(key));
    openSpools.set(key, spool);
  }

  if (msg.data) {
    const buf = Buffer.from(msg.data, msg.encoding === "base64" ? "base64" : "utf-8");
    spool.bytes += buf.length;
    spool.stream.write(buf);
  }

  // A single-shot body may omit `final`; only an explicit false means more is coming.
  if (msg.final === false) return;

  openSpools.delete(key);
  const bytes = spool.bytes;
  try {
    fs.writeFileSync(spool.meta, JSON.stringify({
      browserId,
      tabId: msg.tabId,
      requestId: msg.requestId,
      url: msg.url,
      mimeType: msg.mimeType,
      status: msg.status,
      resourceType: msg.resourceType,
      bytes,
      capturedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
  spool.stream.end(() => {
    spoolFiles.push({ bin: spool.bin, meta: spool.meta, bytes, at: Date.now() });
    spoolBytes += bytes;
    enforceSpoolCap();
  });
}

function enforceSpoolCap() {
  while (spoolBytes > SPOOL_LIMIT_BYTES && spoolFiles.length) {
    const victim = spoolFiles.shift();
    spoolBytes -= victim.bytes;
    try { fs.unlinkSync(victim.bin); } catch {}
    try { fs.unlinkSync(victim.meta); } catch {}
  }
}

// The spool outlives the broker, so its size has to be recovered at startup or the cap is fiction.
async function scanSpool() {
  const found = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".bin")) {
        try {
          const st = await fsp.stat(full);
          found.push({ bin: full, meta: `${full.slice(0, -4)}.meta.json`, bytes: st.size, at: st.mtimeMs });
        } catch {}
      }
    }
  }
  await walk(SPOOL_DIR);
  found.sort((a, b) => a.at - b.at);
  spoolFiles = found.concat(spoolFiles);
  spoolBytes = spoolFiles.reduce((n, f) => n + f.bytes, 0);
  enforceSpoolCap();
}

// --- Broker: browser-local tools ---
// browsers_list / browser_select are answered here and never reach an extension.

function renderBrowsers(rows) {
  if (!rows.length) return "No browsers connected. Load the OpenBrowser MCP extension in a Chromium browser.";
  const lines = rows.map((b) => {
    const label = b.label ? `"${b.label}"` : "-";
    const counts = `${b.windows} window${b.windows === 1 ? "" : "s"}, ${b.tabs} tab${b.tabs === 1 ? "" : "s"}`;
    return `${b.selected ? "*" : " "} ${b.browserId}  ${b.brand}  ${label}  ${counts}  incognito:${b.incognitoAllowed ? "yes" : "no"}`;
  });
  lines.push("* = this session's default. Pass browserId on a call, or pin one with browser_select.");
  return lines.join("\n");
}

function brokerLocalTool(clientId, tool, args) {
  if (tool === "browsers_list") {
    const selected = registry.selectedFor(clientId);
    const rows = registry.list().map((b) => ({ ...b, selected: b.browserId === selected }));
    return { content: [{ type: "text", text: renderBrowsers(rows) }] };
  }
  if (tool === "browser_select") {
    const picked = registry.select(clientId, args?.browserId ?? null);
    if (!picked) return { content: [{ type: "text", text: "Cleared the browser pin; routing falls back to the tab index." }] };
    const entry = registry.get(picked);
    const label = entry.label ? ` "${entry.label}"` : "";
    return { content: [{ type: "text", text: `Pinned ${picked} (${entry.brand}${label}) as this session's browser.` }] };
  }
  throw new Error(`Unknown broker-local tool: ${tool}`);
}

// --- Broker: client connections ---

function broadcastBrowsers() {
  const rows = registry.list();
  for (const [clientId, { socket }] of clientSockets) {
    if (socket.destroyed) continue;
    const selected = registry.selectedFor(clientId);
    socket.write(encodeLine({ type: "browsers", browsers: rows.map((b) => ({ ...b, selected: b.browserId === selected })) }));
  }
}

function setupClientConnection(socket, hello) {
  const clientId = String(++clientIdCounter);
  clientSockets.set(clientId, { socket, cwd: hello?.cwd || null, pid: hello?.pid || null });
  armIdle(); // a client connected — cancel any pending broker idle-retire
  process.stderr.write(`Client MCP server connected (client ${clientId})\n`);

  socket.write(encodeLine({ type: "client_ack", clientId }));
  socket.write(encodeLine({ type: "browsers", browsers: registry.list() }));

  socket.on("close", () => {
    clientSockets.delete(clientId);
    registry.releaseClient(clientId);
    for (const [prefixedId, info] of clientRequestMap) {
      if (info.clientId === clientId) clientRequestMap.delete(prefixedId);
    }
    process.stderr.write(`Client MCP server disconnected (client ${clientId})\n`);
    armIdle(); // last client may have left — arm broker idle-retire
  });

  return (line) => handleClientLine(clientId, socket, line);
}

function handleClientLine(clientId, socket, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === "client_hello") {
    const rec = clientSockets.get(clientId);
    if (rec) { rec.cwd = msg.cwd || rec.cwd; rec.pid = msg.pid || rec.pid; }
    return;
  }

  if (msg.type === "select_browser") {
    try { registry.select(clientId, msg.browserId ?? null); } catch {}
    return;
  }

  if (msg.type !== "tool_request" || !msg.id) return;

  if (BROKER_LOCAL.has(msg.tool)) {
    try {
      socket.write(encodeLine({ id: msg.id, type: "tool_response", result: brokerLocalTool(clientId, msg.tool, msg.args) }));
    } catch (e) {
      socket.write(encodeLine({ id: msg.id, type: "tool_error", error: e.message }));
    }
    return;
  }

  let target;
  try {
    target = registry.route({
      tabId: msg.args?.tabId,
      browserId: msg.browserId ?? msg.args?.browserId ?? null,
      selected: registry.selectedFor(clientId),
    });
  } catch (e) {
    socket.write(encodeLine({ id: msg.id, type: "tool_error", error: e.message }));
    return;
  }

  const browser = registry.get(target.browserId);
  const prefixedId = `c${clientId}_b${target.browserId}_${msg.id}`;
  clientRequestMap.set(prefixedId, {
    clientId,
    originalId: msg.id,
    browserId: target.browserId,
    tool: msg.tool,
    args: msg.args,
    resent: false,
    // The client's own timeout is invisible here, so mirror its budget: without it a resend can
    // replay a click or a navigate the agent gave up on minutes ago.
    createdAt: Date.now(),
    budgetMs: TOOL_TIMEOUT_MS[msg.tool] || 60000,
  });
  browser.socket.write(encodeLine({ id: prefixedId, type: "tool_request", tool: msg.tool, args: msg.args }));
}

// --- Broker: native-host (browser) connections ---

function adoptNativeHost(socket, hello) {
  // A late host_hello re-registers this socket under its real browserId, so the id has to be a
  // box, not a captured value: the line handler and the close guard below must both follow it.
  const ref = { id: registry.register(socket, hello) };
  const entry = registry.get(ref.id);
  process.stderr.write(`Browser connected: ${ref.id} ${entry.brand}${entry.label ? ` "${entry.label}"` : ""}\n`);
  broadcastBrowsers();

  socket.on("close", () => {
    // Only unregister if this socket is still the live one — a reconnect may already have replaced it.
    if (registry.get(ref.id)?.socket === socket) {
      registry.unregister(socket);
      process.stderr.write(`Browser disconnected: ${ref.id}\n`);
      broadcastBrowsers();
      scheduleResend(ref.id);
    }
  });

  return ref;
}

// The extension's native host reconnects on its own loop; give it 5 s to land before deciding
// whether in-flight requests can be retried or have to fail.
function scheduleResend(browserId) {
  const relayIds = [...clientRequestMap].filter(([, e]) => e.browserId === browserId).map(([id]) => id);
  const localIds = [...pendingRequests].filter(([, e]) => e.browserId === browserId).map(([id]) => id);
  if (!relayIds.length && !localIds.length) return;

  setTimeout(() => {
    const entry = registry.get(browserId);
    const alive = entry && entry.socket && !entry.socket.destroyed;

    for (const id of relayIds) {
      const req = clientRequestMap.get(id);
      if (!req) continue; // completed while we waited
      if (Date.now() - req.createdAt > req.budgetMs) {
        clientRequestMap.delete(id); // the client has already failed this one
        continue;
      }
      if (alive) {
        if (req.resent) continue;
        req.resent = true;
        entry.socket.write(encodeLine({ id, type: "tool_request", tool: req.tool, args: req.args }));
      } else {
        clientRequestMap.delete(id);
        const client = clientSockets.get(req.clientId);
        if (client && !client.socket.destroyed) {
          client.socket.write(encodeLine({ id: req.originalId, type: "tool_error", error: "Native host disconnected" }));
        }
      }
    }

    for (const id of localIds) {
      const req = pendingRequests.get(id);
      if (!req) continue;
      if (alive) {
        if (req.resent) continue;
        req.resent = true;
        entry.socket.write(encodeLine({ id, type: "tool_request", tool: req.tool, args: req.args }));
      } else {
        failPending(id, new Error("Native host disconnected"));
      }
    }
  }, 5000);
}

function handleBrowserLine(ref, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  switch (msg.type) {
    case "heartbeat":
      return;
    case "host_hello": {
      const entry = registry.get(ref.id);
      if (entry) { ref.id = registry.register(entry.socket, msg); broadcastBrowsers(); }
      return;
    }
    case "tab_index":
      registry.updateTabIndex(ref.id, msg.tabs);
      return;
    case "net_body":
      spoolNetBody(ref.id, msg);
      return;
    default:
      break;
  }

  const relay = clientRequestMap.get(msg.id);
  if (relay) {
    if (msg.type !== "tool_chunk") {
      clientRequestMap.delete(msg.id);
      // Closing a tab is the one result that reliably invalidates an index entry.
      if (msg.type === "tool_response" && relay.tool === "tabs_close_mcp" && relay.args?.tabId != null) {
        registry.dropTab(relay.browserId, relay.args.tabId);
      }
    }
    const client = clientSockets.get(relay.clientId);
    if (client && !client.socket.destroyed) {
      client.socket.write(encodeLine({ ...msg, id: relay.originalId }));
    }
    return;
  }

  // Otherwise it belongs to this process (legacy in-process primary).
  handleOwnMessage(msg);
}

// --- Socket classification ---
// Deterministic on the first line: client_hello → agent, host_hello → native host. The 500 ms
// fallback exists only so a pre-0.2.0 extension (which sends nothing on connect) still works, and
// is scheduled for removal after one release.

const tcpServer = net.createServer((socket) => {
  let onLine = classify;
  const feed = createLineReader((line) => onLine(line));

  const fallback = setTimeout(() => {
    if (onLine !== classify) return;
    const ref = adoptNativeHost(socket, { browserId: "legacy", brand: "Chromium" });
    onLine = (line) => handleBrowserLine(ref, line);
  }, 500);

  function classify(line) {
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { msg = null; }
    clearTimeout(fallback);

    if (msg && msg.type === "client_hello") {
      onLine = setupClientConnection(socket, msg);
      return;
    }

    const isHello = !!msg && msg.type === "host_hello";
    const ref = adoptNativeHost(socket, isHello ? msg : { browserId: "legacy", brand: "Chromium" });
    onLine = (l) => handleBrowserLine(ref, l);
    // A legacy host's first line was a real message, not a handshake — don't drop it.
    if (!isHello) onLine(line);
  }

  socket.on("data", feed);
  socket.on("error", () => {});
  socket.on("close", () => clearTimeout(fallback));
});

// --- This process's own requests (client mode, and the legacy in-process primary) ---

function failPending(id, err) {
  const entry = pendingRequests.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingRequests.delete(id);
  entry.reject(err);
}

function onTimeout(id) {
  const entry = pendingRequests.get(id);
  if (!entry) return;
  failPending(id, new Error(`Tool request timed out after ${Math.round(entry.timeoutMs / 1000)}s`));
}

function handleOwnMessage(msg) {
  const entry = pendingRequests.get(msg.id);
  if (!entry) return;

  if (msg.type === "tool_chunk") {
    // Bytes are still flowing, so the request is not stalled.
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => onTimeout(msg.id), entry.timeoutMs);
    const dl = downloads.get(msg.id);
    // Serialize per request: chunks arrive in order but the disk writes are async.
    if (dl) dl.queue = dl.queue.then(() => applyChunk(dl, msg)).catch((e) => { dl.errors.push(e.message); });
    return;
  }

  clearTimeout(entry.timer);
  pendingRequests.delete(msg.id);
  if (msg.type === "tool_error") entry.reject(new Error(msg.error || "Tool execution failed"));
  else entry.resolve(msg.result);
}

function dispatch(tool, args, { onId } = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    if (onId) onId(id);
    const timeoutMs = TOOL_TIMEOUT_MS[tool] || 60000;
    const entry = { resolve, reject, tool, args, browserId: null, timeoutMs, resent: false, timer: null };
    entry.timer = setTimeout(() => onTimeout(id), timeoutMs);
    pendingRequests.set(id, entry);

    const browserId = args?.browserId ?? null;

    if (mode === "primary") {
      let target;
      try {
        target = registry.route({ tabId: args?.tabId, browserId, selected: registry.selectedFor("local") });
      } catch (e) {
        failPending(id, e);
        return;
      }
      entry.browserId = target.browserId;
      registry.get(target.browserId).socket.write(encodeLine({ id, type: "tool_request", tool, args }));
      return;
    }

    if (!brokerSocket || brokerSocket.destroyed) {
      failPending(id, new Error("Lost connection to the OpenBrowser broker."));
      return;
    }
    brokerSocket.write(encodeLine({ id, type: "tool_request", tool, args, browserId }));
  });
}

// --- Client mode: connect to the broker ---

function startClientMode() {
  mode = "client";
  process.stderr.write(`Port ${TCP_PORT} in use. Connecting as client to the broker...\n`);

  // A client whose broker exited must be able to TAKE OVER the port, not loop forever reconnecting
  // to a dead one. Try to bind; win → become primary; if a peer already re-took it, stay a client.
  function tryBecomePrimary() {
    const onError = () => {
      tcpServer.removeListener("listening", onListening);
      setTimeout(connect, 2000); // someone else won the race — stay a client
    };
    const onListening = () => {
      tcpServer.removeListener("error", onError);
      mode = "primary";
      writePidfile();
      process.stderr.write(`Promoted to primary MCP server on :${TCP_PORT}\n`);
      // The extension's native host is on its own reconnect loop and will land on this freshly
      // bound port within a couple of seconds.
    };
    tcpServer.once("error", onError);
    tcpServer.once("listening", onListening);
    try {
      tcpServer.listen(TCP_PORT, "127.0.0.1");
    } catch {
      tcpServer.removeListener("error", onError);
      tcpServer.removeListener("listening", onListening);
      setTimeout(connect, 2000);
    }
  }

  function connect() {
    brokerSocket = net.createConnection(TCP_PORT, "127.0.0.1", () => {
      process.stderr.write(`Connected to the broker on :${TCP_PORT}\n`);
      brokerSocket.write(encodeLine({ type: "client_hello", version: VERSION, pid: process.pid, cwd: process.cwd() }));
    });

    // A reader per connection, so a half-line left by a dead broker can't corrupt the next one.
    const feed = createLineReader((line) => {
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "client_ack") {
        myClientId = msg.clientId;
        process.stderr.write(`Registered with the broker as client ${myClientId}\n`);
        return;
      }
      if (msg.type === "browsers") return;
      if (msg.type === "error") {
        process.stderr.write(`Broker error: ${msg.error}\n`);
        return;
      }
      handleOwnMessage(msg);
    });
    brokerSocket.on("data", feed);

    brokerSocket.on("error", (err) => {
      process.stderr.write(`Client connection error: ${err.message}\n`);
    });

    brokerSocket.on("close", () => {
      brokerSocket = null;
      for (const [, { reject, timer }] of pendingRequests) {
        clearTimeout(timer);
        reject(new Error("Broker disconnected"));
      }
      pendingRequests.clear();
      // Restore the invariant "primary is always a detached broker": spawn a fresh broker and
      // reconnect as a client. Only if that fails do we take over in-process (last-ditch).
      // Small backoff avoids hot-looping if the broker is flapping.
      if (mode === "client") {
        setTimeout(() => {
          if (mode !== "client") return;
          ensureBroker().then((ok) => {
            if (mode !== "client") return; // already promoted elsewhere
            if (ok) connect();
            else tryBecomePrimary();
          });
        }, 500);
      }
    });
  }

  connect();
}

// --- Broker lifecycle (detached, long-lived bridge) ---

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Arm/cancel the broker's idle-retire timer. Only meaningful in the broker process.
function armIdle() {
  if (!BROKER_MODE || mode !== "primary") return;
  if (clientSockets.size > 0) {
    if (brokerIdleTimer) { clearTimeout(brokerIdleTimer); brokerIdleTimer = null; }
    return;
  }
  if (brokerIdleTimer) return;
  brokerIdleTimer = setTimeout(() => {
    brokerIdleTimer = null;
    if (clientSockets.size !== 0) return;
    process.stderr.write("Broker idle — retiring.\n");
    // Tell every browser to let go of its debugger sessions first. This is the only notice the
    // extension gets that the session is over, and it is what clears Chrome's "is debugging this
    // browser" infobar and the pinned emulation override instead of leaving both until tab close.
    for (const entry of registry.browsers.values()) {
      if (entry.socket && !entry.socket.destroyed) {
        try { entry.socket.write(encodeLine({ type: "shutdown" })); } catch {}
      }
    }
    setTimeout(shutdown, 250).unref();
  }, BROKER_IDLE_MS);
}

// Is a broker already running? Trust the pidfile the broker writes once it binds.
function brokerAlive() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, "utf-8").trim(), 10);
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0); // throws if the pid is dead
    return true;
  } catch {
    return false;
  }
}

// Spawn the detached broker. Multiple agents may race this; only one wins the port bind, the rest
// exit cleanly on EADDRINUSE, so no lock is needed.
function spawnDetachedBroker() {
  try {
    spawn(process.execPath, [SELF_PATH, "--broker"], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    process.stderr.write(`Failed to spawn broker: ${e.message}\n`);
  }
}

// Ensure a broker owns the port. Returns true once one is reachable (pidfile-alive).
async function ensureBroker() {
  if (brokerAlive()) return true;
  spawnDetachedBroker();
  for (let i = 0; i < 50; i++) { // up to ~5s for the broker to bind + write its pidfile
    await delay(100);
    if (brokerAlive()) return true;
  }
  return false;
}

// Broker process: own the port + every browser bridge, relay for all clients, retire when idle.
function startBroker() {
  return new Promise((resolve) => {
    tcpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") process.exit(0); // another broker won the race
      process.stderr.write(`Broker TCP error: ${err.message}\n`);
      process.exit(1);
    });
    tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
      mode = "primary";
      writePidfile();
      process.stderr.write(`Broker listening on :${TCP_PORT} (pid ${process.pid})\n`);
      scanSpool().catch(() => {});
      armIdle(); // no clients yet — start the retire countdown (a connecting client cancels it)
      resolve();
    });
  });
}

// --- Startup ---
// Broker: own the port. Agent: ensure a broker exists, then run as a pure client. If no broker can
// be started, fall back to the legacy bind-or-client behavior so we degrade gracefully.

// `--wait-for-host`: ensure a broker, then sit on its `browsers` broadcast until an extension
// registers. Prints exactly one line — "<brand> / <label>" — to stdout and exits, so install.sh can
// consume it directly. Everything else goes to stderr.
function waitForHost() {
  return ensureBroker().then((ok) => {
    if (!ok) {
      process.stderr.write("Could not start the broker.\n");
      process.exit(1);
    }
    let settled = false;
    const socket = net.createConnection(TCP_PORT, "127.0.0.1", () => {
      socket.write(encodeLine({ type: "client_hello", version: VERSION, pid: process.pid, cwd: process.cwd() }));
    });
    const done = (code, line) => {
      if (settled) return;
      settled = true;
      if (line) process.stdout.write(line + "\n");
      socket.destroy();
      process.exit(code);
    };
    socket.on("data", createLineReader((line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type !== "browsers" || !Array.isArray(msg.browsers) || msg.browsers.length === 0) return;
      const b = msg.browsers[0];
      done(0, `${b.brand || "Chromium"} / ${b.label || b.browserId}`);
    }));
    socket.on("error", (e) => { process.stderr.write(`${e.message}\n`); done(1, null); });
    socket.on("close", () => done(1, null));
    // install.sh owns the user-facing timeout; this is only a backstop against hanging forever.
    setTimeout(() => done(1, null), 10 * 60 * 1000).unref();
  });
}

async function start() {
  if (BROKER_MODE) return startBroker();
  if (WAIT_FOR_HOST) return waitForHost();

  // Clean up stale pidfiles from dead brokers so ensureBroker() spawns a fresh one. The two legacy
  // names are swept for one release so a stale old broker on :18765 is cleaned, not fought with.
  for (const pf of [PIDFILE, ...legacyPidfilePaths(TCP_PORT)]) {
    try {
      const oldPid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try { process.kill(oldPid, 0); } catch { try { fs.unlinkSync(pf); } catch {} }
      }
    } catch {}
  }

  const ok = await ensureBroker();
  if (ok) { startClientMode(); return; }

  process.stderr.write("No broker available — falling back to legacy in-process primary.\n");
  return startLegacyPrimaryOrClient();
}

// Legacy fallback: try to bind the port ourselves; if taken, run as client. (Pre-broker behavior.)
function startLegacyPrimaryOrClient() {
  return new Promise((resolve) => {
    tcpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        startClientMode();
        resolve();
      } else {
        process.stderr.write(`TCP server error: ${err.message}\n`);
        process.exit(1);
      }
    });

    tcpServer.listen(TCP_PORT, "127.0.0.1", () => {
      mode = "primary";
      writePidfile();
      process.stderr.write(`Primary MCP server listening on :${TCP_PORT}\n`);
      resolve();
    });
  });
}

await start();

// --- sources_download: the client owns the disk, because only it knows the agent's cwd ---

const TEXTUAL_TYPE = /(javascript|ecmascript|json|html|css|xml|typescript|text\/)/i;
const TEXTUAL_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|html?|css|map|txt|xml|svg|vue|svelte)$/i;
const ENDPOINT_SCAN_FILE_MAX = 8 * 1024 * 1024;
const ENDPOINT_SCAN_TOTAL_MAX = 64 * 1024 * 1024;

async function applyChunk(dl, msg) {
  // A spill is one agent-named file, not a reconstructed tree, so it bypasses the sink entirely.
  if (dl.spill) return dl.spill(msg);

  const file = msg.file || {};
  const key = file.url || `seq:${msg.seq}`;
  let handle = dl.handles.get(key);
  if (!handle) {
    // Sourcemap sources, inline document scripts and eval'd code have no URL that reconstructs to a
    // sane path, so the extension supplies one; the sink calls that field `rel`.
    handle = await dl.sink.begin(file.path ? { ...file, rel: file.path } : file);
    dl.handles.set(key, handle);
  }
  if (msg.data) {
    await dl.sink.write(handle, Buffer.from(msg.data, msg.encoding === "base64" ? "base64" : "utf-8"));
  }
  if (msg.final) {
    dl.handles.delete(key);
    const rec = (await dl.sink.end(handle)) || {};
    dl.bytes += rec.bytes || 0;
    dl.written.push({
      url: file.url,
      savedTo: rec.savedTo,
      bytes: rec.bytes || 0,
      contentType: file.contentType,
      source: file.source,
    });
  }
}

// Tier 5 of the content ladder (§9.2), and the only tier that has to run here: unauthenticated
// fetch from Node for what the extension could not resolve. A redirect that leaves the requested
// origin is refused rather than followed into a host outside `origins`.
async function fetchMisses(dl, misses, origins) {
  const allowed = new Set((origins || []).map((o) => String(o).replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")));
  const queue = misses.slice(0, 300);
  const worker = async () => {
    for (;;) {
      const miss = queue.shift();
      if (!miss) return;
      const url = typeof miss === "string" ? miss : miss?.url;
      if (!url) continue;
      try {
        const res = await fetch(url);
        const finalHost = new URL(res.url).host;
        if (finalHost !== new URL(url).host && allowed.size && !allowed.has(finalHost)) {
          throw new Error(`redirected off-origin to ${finalHost}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const meta = {
          url,
          contentType: res.headers.get("content-type") || (typeof miss === "object" ? miss.contentType : undefined),
          httpStatus: res.status,
          source: "fetch-node",
          bytes: buf.length,
        };
        // The extension already worked out where this file belongs in the tree; reuse it so a
        // tier-5 file sits beside its tier-1 siblings rather than in a second reconstructed layout.
        if (typeof miss === "object" && miss.path) meta.rel = miss.path;
        const handle = await dl.sink.begin(meta);
        await dl.sink.write(handle, buf);
        const rec = (await dl.sink.end(handle)) || {};
        dl.bytes += rec.bytes || buf.length;
        dl.written.push({ url, savedTo: rec.savedTo, bytes: rec.bytes || buf.length, contentType: meta.contentType, source: "fetch-node" });
      } catch (e) {
        dl.errors.push(`fetch-node ${url}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// Read back what we just wrote rather than retaining every body in memory during the download.
async function collectTexts(written, outDir) {
  const files = [];
  let total = 0;
  let unreadable = 0;
  for (const w of written) {
    if (!w.savedTo || w.bytes > ENDPOINT_SCAN_FILE_MAX) continue;
    if (!TEXTUAL_TYPE.test(w.contentType || "") && !TEXTUAL_EXT.test(w.savedTo)) continue;
    if (total > ENDPOINT_SCAN_TOTAL_MAX) break;
    // sink.end() reports savedTo RELATIVE to outDir, so the manifest stays portable across machines.
    // Resolving it here is not optional: reading the relative path against the process cwd throws for
    // every file, and the endpoint scan then silently produces an empty _endpoints.json.
    const abs = path.resolve(outDir, w.savedTo);
    try {
      const text = await fsp.readFile(abs, "utf-8");
      total += text.length;
      files.push({ path: abs, url: w.url, text });
    } catch {
      unreadable++;
    }
  }
  return { files, unreadable };
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function runSourcesDownload(args) {
  // outDir is resolved HERE: the broker is shared and long-lived and has no idea what the agent's
  // cwd is, and the extension has no filesystem at all.
  const outDir = path.resolve(process.cwd(), args?.outDir || CONFIG.outDir || "./source");
  const { outDir: _clientOwned, ...extArgs } = args || {};

  const dl = {
    sink: new DownloadSink({ outDir }),
    handles: new Map(),
    written: [],
    errors: [],
    bytes: 0,
    queue: Promise.resolve(),
  };

  let requestId = null;
  let result;
  try {
    result = await dispatch("sources_download", extArgs, {
      onId: (id) => { requestId = id; downloads.set(id, dl); },
    });
  } finally {
    if (requestId) downloads.delete(requestId);
  }

  await dl.queue;
  // Tier 5: what the browser could not reach, we refetch unauthenticated from here. The extension
  // calls this handoff `retry`; `misses` is accepted as a synonym.
  const tier5 = Array.isArray(result?.misses) ? result.misses
              : Array.isArray(result?.retry) ? result.retry
              : [];
  if (tier5.length) await fetchMisses(dl, tier5, extArgs.origins);

  let summary = null;
  try { summary = await dl.sink.finalize(); } catch (e) { dl.errors.push(`finalize: ${e.message}`); }

  // Extension-side failures (blocked cross-origin redirects, sourcemap errors) only exist over there;
  // the host discards the extension's summary text, so they reach the agent through `failed` or not at all.
  const failures = (dl.sink.failures || []).concat(dl.errors, Array.isArray(result?.failed) ? result.failed : []);
  const lines = [
    `Downloaded ${dl.written.length} file${dl.written.length === 1 ? "" : "s"} (${humanBytes(dl.bytes)}) → ${outDir}`,
  ];

  const byTier = {};
  for (const w of dl.written) byTier[w.source || "unknown"] = (byTier[w.source || "unknown"] || 0) + 1;
  const tiers = Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join(", ");
  if (tiers) lines.push(`  source tiers: ${tiers}`);
  if (typeof result?.skipped === "number") lines.push(`  skipped: ${result.skipped}`);
  if (failures.length) {
    lines.push(`  failed: ${failures.length}`);
    for (const f of failures.slice(0, 5)) lines.push(`    ${typeof f === "string" ? f : f.url || JSON.stringify(f)}`);
    if (failures.length > 5) lines.push(`    … ${failures.length - 5} more`);
  }
  lines.push(`  manifest: ${path.join(outDir, "_manifest.json")}`);
  if (summary && typeof summary.notes === "string") lines.push(`  ${summary.notes}`);

  try {
    const { files, unreadable } = await collectTexts(dl.written, outDir);
    if (unreadable) lines.push(`  note: ${unreadable} written file(s) could not be re-read for the endpoint scan`);
    const endpoints = await extractEndpoints(files);
    const observed = Array.isArray(result?.observedUrls) ? result.observedUrls : [];
    const unexercised = diffUnexercised(endpoints, observed);
    // A download that wrote nothing never made outDir, and these two artifacts still have to land.
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, "_endpoints.json"), JSON.stringify(endpoints, null, 2));
    await fsp.writeFile(path.join(outDir, "_unexercised.json"), JSON.stringify(unexercised, null, 2));
    lines.push(
      `  endpoints: ${path.join(outDir, "_endpoints.json")} (${endpoints.paths?.length || 0} paths, ` +
      `${endpoints.params?.length || 0} params, ${endpoints.hosts?.length || 0} hosts, ` +
      `${endpoints.secrets?.length || 0} secrets)`
    );
    lines.push(
      `  unexercised: ${path.join(outDir, "_unexercised.json")} (${unexercised.paths?.length || 0} paths never seen on the wire)`
    );
    if (!observed.length) lines.push("    (no observed network log supplied — unexercised equals the full static set)");
  } catch (e) {
    lines.push(`  endpoint extraction failed: ${e.message}`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// --- MCP layer (agents only; the broker has no MCP stdio) ---

function shapeResult(result) {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (result && result.content) return result;
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

// `filename` on javascript_tool / read_page / page_surface / read_network_request spills a big result
// to disk instead of into context. Those bytes arrive as tool_chunk exactly like a download does, so
// the client has to have a stream waiting or the tool cheerfully reports "Wrote N bytes" while
// nothing lands. Single file, no path reconstruction — the agent named it.
async function runSpill(name, args) {
  const dest = path.resolve(process.cwd(), String(args.filename));
  if (!dest.startsWith(process.cwd() + path.sep) && dest !== process.cwd()) {
    return { content: [{ type: "text", text: `Error: filename resolves outside the working directory: ${dest}` }], isError: true };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const stream = fs.createWriteStream(dest);
  // An unhandled 'error' here (EISDIR, EACCES, ENOSPC) would take the whole agent's MCP server down
  // mid-session, because a stream error with no listener is a fatal uncaught exception.
  const writeErrors = [];
  stream.on("error", (e) => writeErrors.push(e.message));
  let bytes = 0;
  const dl = {
    queue: Promise.resolve(),
    errors: [],
    spill: (msg) => {
      if (!msg.data) return;
      const buf = Buffer.from(msg.data, msg.encoding === "base64" ? "base64" : "utf-8");
      bytes += buf.length;
      stream.write(buf);
    },
  };

  let requestId = null;
  let result;
  try {
    result = await dispatch(name, args, { onId: (id) => { requestId = id; downloads.set(id, dl); } });
  } finally {
    if (requestId) downloads.delete(requestId);
  }
  await dl.queue;
  await new Promise((resolve) => stream.end(resolve));

  if (writeErrors.length) {
    return { content: [{ type: "text", text: `Error: could not write ${dest}: ${writeErrors[0]}` }], isError: true };
  }

  const shaped = shapeResult(result);
  if (bytes === 0) {
    try { await fsp.unlink(dest); } catch {}
    return shaped;
  }
  return {
    ...shaped,
    content: [...shaped.content, { type: "text", text: `\nSpilled ${humanBytes(bytes)} to ${dest} — Read/Grep it from here.` }],
  };
}

async function callTool(name, args) {
  try {
    // Without a broker there is nobody else to answer these, so serve them from the registry we own.
    if (BROKER_LOCAL.has(name) && mode === "primary") return brokerLocalTool("local", name, args);
    if (name === "sources_download") return await runSourcesDownload(args);
    if (args && typeof args.filename === "string" && args.filename) return await runSpill(name, args);
    return shapeResult(await dispatch(name, args));
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

if (!BROKER_MODE && !WAIT_FOR_HOST) {
  const server = new McpStdioServer({
    name: SERVER_NAME,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    tools: TOOLS,
    onCall: callTool,
  });
  server.start();
}
