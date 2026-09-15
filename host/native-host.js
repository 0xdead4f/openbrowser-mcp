#!/usr/bin/env node

// Native messaging host for the OpenBrowser MCP extension.
// Launched by the browser when the extension calls connectNative().
// Bridges Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON) to the broker
// (newline-delimited JSON over TCP on localhost). Both directions go through framing.js, so a
// 1.5 MB base64 tool_chunk costs one copy instead of one per 64 KB socket chunk.

import net from "node:net";

import { createLineReader, encodeLine, readNativeMessages, encodeNativeMessage } from "./lib/framing.js";
import { DEFAULT_PORT, EXTENSION_ID, loadConfig } from "./lib/config.js";
import { createHostOps, realSystem } from "./lib/browser-process.js";

const TCP_PORT = loadConfig().port || DEFAULT_PORT;

// host_request is work only THIS process can do: it is the browser's child, so its parent chain names
// the exact binary and profile a Brave temporary-container relay has to target, which the broker
// (shared by every browser) cannot know. The extension id falls back to the manifest-pinned one
// because the installed wrappers do not forward Chrome's chrome-extension:// argument to node.
const hostOps = createHostOps(realSystem({ defaultExtensionId: EXTENSION_ID }));
// Every exit path (the extension's port closing, the broker gone for good): a Brave relay orphaned
// mid-flight would, at Chromium's 20 s singleton timeout, SIGKILL a stalled browser and take it over.
process.on("exit", () => hostOps.killRelays());
// A signal skips "exit" unless handled, so turn one into a normal exit and the relays die with us.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0));

// --- TCP connection to the broker ---

let tcpSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let tcpReady = false;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals

// This process outlives a broker restart, but the extension sends host_hello once per native port.
// Without a replay the new broker sees a silent socket and files this browser as "legacy" — and two
// such browsers then fight over the single "legacy" registry entry forever. Re-registering with the
// same browserId is a no-op, so replaying unconditionally is safe.
let cachedHello = null;
const pending = [];
const MAX_PENDING = 64;

function connectTcp() {
  if (tcpSocket) return;

  tcpSocket = new net.Socket();

  // A reader per connection: a half-line left behind by a dead broker must not bleed into the next.
  const feed = createLineReader((line) => {
    if (!line) return;
    try {
      process.stdout.write(encodeNativeMessage(JSON.parse(line)));
    } catch {
      // skip malformed
    }
  });

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    // The handshake must be the broker's first line, so writes are held until here rather than
    // issued on the connecting socket — those would flush ahead of anything written from here.
    tcpReady = true;
    if (cachedHello) tcpSocket.write(encodeLine(cachedHello));
    for (const msg of pending.splice(0)) tcpSocket.write(encodeLine(msg));
  });

  tcpSocket.on("data", feed);

  tcpSocket.on("error", () => {
    tcpSocket = null;
    tcpReady = false;
  });

  tcpSocket.on("close", () => {
    tcpSocket = null;
    tcpReady = false;
    if (!reconnectTimer) {
      reconnectTimer = setInterval(() => {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          // Broker is gone — exit cleanly so we don't linger as a zombie.
          clearInterval(reconnectTimer);
          process.exit(0);
        }
        if (!tcpSocket) connectTcp();
      }, 500);
    }
  });
}

// --- Main: bridge stdin (from extension) <-> TCP (to the broker) ---

// host_hello passes through untouched; the broker classifies the socket on it. It is also cached
// above, because every broker that comes after this one needs to see it too.
let nativeState = null;

process.stdin.on("data", (chunk) => {
  const { messages, state } = readNativeMessages(nativeState, chunk);
  nativeState = state;
  for (const msg of messages) {
    // Answered here and written straight back on stdout, never forwarded: the broker has no handler
    // for it, and a request parked in `pending` while the broker is down would stall a tab creation
    // on something that needs no broker at all. handle() never rejects; failures come back ok:false.
    // Deliberately not queued: restore_front arrives while open_temporary_container is still awaiting
    // its relay's exit, and a hand-back that waited for that exit would come too late to matter.
    if (msg?.type === "host_request") {
      hostOps.handle(msg).then((response) => process.stdout.write(encodeNativeMessage(response)));
      continue;
    }
    if (msg?.type === "host_hello") cachedHello = msg;
    if (tcpReady && tcpSocket && !tcpSocket.destroyed) tcpSocket.write(encodeLine(msg));
    else if (msg?.type !== "host_hello" && pending.length < MAX_PENDING) pending.push(msg);
  }
});

process.stdin.on("end", () => {
  // Extension disconnected
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

connectTcp();
