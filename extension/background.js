// Background service worker for OpenBrowser MCP: wires the native bridge to the tool handlers,
// fans CDP events out to the network/ref modules, and keeps the MCP contexts alive.

import * as bridge from "./lib/bridge.js";
import { contexts, syncContexts, recoverContexts } from "./lib/contexts.js";
import { getIdentity, setLabel } from "./lib/identity.js";
import { detach, attachedTabIds } from "./lib/cdp.js";
import * as net from "./lib/net.js";
import * as refs from "./lib/refs.js";
import { handlers as coreHandlers } from "./lib/tools.core.js";
import * as page from "./lib/tools.page.js";
import { handlers as sourcesHandlers } from "./lib/tools.sources.js";

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const handlers = { ...coreHandlers, ...page.handlers, ...sourcesHandlers };

// --- Tool dispatch ---
async function onToolRequest(id, tool, args) {
  const handler = handlers[tool];
  if (!handler) {
    bridge.sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const { browserId } = await getIdentity();
    const ctx = {
      browserId,
      requestId: id,
      // Handlers may call this as sendChunk(part) or sendChunk(requestId, part); both mean
      // "this request", so accept either rather than making every caller thread the id.
      sendChunk: (a, b) =>
        b === undefined && a && typeof a === "object" ? bridge.sendChunk(id, a) : bridge.sendChunk(a, b),
    };
    bridge.sendResponse(id, await handler(args || {}, ctx));
  } catch (err) {
    bridge.sendError(id, `${tool} failed: ${err.message}`);
  } finally {
    schedulePush();
  }
}

// --- Tab index ---
// The broker routes a bare tabId to a browser, so it needs to hear about every change to the
// MCP tab set — not just the ones a tabs_* result happens to report.
let pushTimer = null;
let lastIndex = "";

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushTabIndex().catch(() => {});
  }, 300);
}

async function pushTabIndex() {
  if (!bridge.isConnected()) {
    lastIndex = ""; // a reconnected broker starts with an empty index, so never suppress that push
    return;
  }
  await syncContexts();

  const tabs = [];
  for (const [windowId, ctx] of contexts) {
    let grouped;
    try {
      grouped = await chrome.tabs.query({ groupId: ctx.groupId });
    } catch {
      continue;
    }
    for (const t of grouped) tabs.push({ tabId: t.id, windowId, incognito: ctx.incognito });
  }
  tabs.sort((a, b) => a.tabId - b.tabId);

  const sig = JSON.stringify(tabs);
  if (sig === lastIndex) return;
  lastIndex = sig;
  bridge.sendTabIndex(tabs);
}

// A restarted broker starts with an empty per-process tab index and the native host reconnects to
// it without the extension ever noticing (the port to the host survives), so a signature match
// would keep this browser invisible to routing forever. Re-announce on the keepalive tick; the
// signature check only suppresses churn between ticks.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return;
  lastIndex = "";
  schedulePush();
});

// --- CDP events ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;

  net.onCdpEvent(tabId, method, params, source.sessionId);
  page.onCdpEvent?.(tabId, method, params, source.sessionId);

  // Only a top-frame document swap invalidates: a subframe carries a loaderId the snapshot never
  // saw, which would drop main-frame refs that are still perfectly valid. refs.js decides whether
  // the loaderId is actually new; a same-document navigation keeps the map.
  if (method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) {
    refs.invalidate(tabId, params.frame.loaderId);
  }
});

// --- Cleanup ---
chrome.tabs.onRemoved.addListener((tabId) => {
  // Only forget the tab. Do NOT retire the context when the set empties: ctx.tabs tracks the tabs
  // we know about, and Chrome silently adds link-opened tabs to the same group, so an empty set
  // does not mean an empty group. syncContexts prunes groups that are really gone, and
  // windows.onRemoved covers closed windows.
  for (const ctx of contexts.values()) ctx.tabs.delete(tabId);
  detach(tabId).catch(() => {});
  net.clear(tabId);
  refs.invalidate(tabId);
  schedulePush();
});

// Closing a window retires its context. Without this, closed incognito windows leak entries
// that resolveContext would keep handing back.
chrome.windows.onRemoved.addListener((windowId) => {
  contexts.delete(windowId);
  schedulePush();
});

// User dismissed the debugger bar, or Chrome detached us on its own.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) detach(source.tabId).catch(() => {});
});

for (const event of [chrome.tabs.onCreated, chrome.tabs.onAttached, chrome.tabs.onDetached]) {
  event.addListener(() => schedulePush());
}
// groupId is the only tab update that can change MCP membership; ignore the URL/status churn.
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.groupId !== undefined) schedulePush();
});
chrome.tabGroups.onUpdated.addListener(() => schedulePush());
chrome.tabGroups.onRemoved.addListener(() => schedulePush());

// Detach everything we hold. This is what drops Chrome's "is debugging this browser" infobar and
// the pinned emulation override; without it both survive until every attached tab is closed.
function detachAll() {
  return Promise.all(attachedTabIds().map((tabId) => detach(tabId).catch(() => {})));
}

// Broker → extension control. The broker sends `shutdown` when it retires, which is the only signal
// the extension gets that the session is over.
function onControl(msg) {
  if (msg.type === "shutdown") detachAll();
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "shutdown") {
    detachAll().then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === "get_identity") {
    getIdentity().then((id) => respond({ ...id, connected: bridge.isConnected() }));
    return true;
  }
  if (msg?.type === "set_label") {
    // Re-announce so browsers_list reflects the new label now, rather than after the next reconnect.
    setLabel(msg.label).then((label) => { bridge.reannounce(); respond({ label }); });
    return true;
  }
});

// --- Init ---
recoverContexts().then(schedulePush);
bridge.connect({ onToolRequest, onControl });
