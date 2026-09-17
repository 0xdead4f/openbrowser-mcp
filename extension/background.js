// Background service worker for OpenBrowser MCP: wires the native bridge to the tool handlers,
// fans CDP events out to the network/ref modules, and keeps the broker's tab index current.

import * as bridge from "./lib/bridge.js";
import { TAB_GROUP_NONE, groupRecords, groupedTabIndex, loadRecords } from "./lib/contexts.js";
import { getIdentity, setLabel } from "./lib/identity.js";
import * as popups from "./lib/popups.js";
import { detach, attachedTabIds } from "./lib/cdp.js";
import * as net from "./lib/net.js";
import * as refs from "./lib/refs.js";
import { editTabs } from "./lib/tab-edits.js";
import { handlers as coreHandlers } from "./lib/tools.core.js";
import * as page from "./lib/tools.page.js";
import { forgetStdlib } from "./lib/stdlib.js";
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
// The broker routes a bare tabId to a browser, so it needs to hear about every change to the set of
// usable tabs — every tab in any tab group, since an agent may act on any of them — not just the ones
// a tabs_* result happens to report.
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
  const tabs = await groupedTabIndex();

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
// No window bookkeeping beyond the active-tab memory further down (dropped with its window). Group
// records are pruned by contexts.js on tabGroups.onRemoved (and on its next load, for anything that
// slipped past), and a closing window removes its tabs one by one, which is what refreshes the index.
chrome.tabs.onRemoved.addListener((tabId) => {
  detach(tabId).catch(() => {});
  net.clear(tabId);
  refs.invalidate(tabId);
  forgetStdlib(tabId);
  popups.forget(tabId).catch(() => {});
  schedulePush();
});

// User dismissed the debugger bar, or Chrome detached us on its own.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) detach(source.tabId).catch(() => {});
});

for (const event of [chrome.tabs.onCreated, chrome.tabs.onAttached, chrome.tabs.onDetached]) {
  event.addListener(() => schedulePush());
}

// groupId is the only tab update that can change group membership; ignore the URL/status churn.
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.groupId !== undefined) schedulePush();
});
chrome.tabGroups.onUpdated.addListener(() => schedulePush());
chrome.tabGroups.onRemoved.addListener(() => schedulePush());

// --- Keeping the human's tab in front ---
// Agent tabs live in the human's own windows, and a page an agent drives can open a tab (window.open,
// target=_blank, Enter on a focused link). Chromium adds that tab FOREGROUND in the source's window and
// in the source's group, replacing the tab the human was looking at, and nothing would switch back. The
// app activation that comes with it cannot be undone from here.
const activeTabs = new Map(); // windowId -> { current, previous } from tabs.onActivated
const NEW_TAB_PAGE = /^[a-z-]+:\/\/newtab\/?$/i;

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const seen = activeTabs.get(windowId);
  if (seen?.current !== tabId) activeTabs.set(windowId, { current: tabId, previous: seen?.current });
});
chrome.windows.onRemoved.addListener((windowId) => activeTabs.delete(windowId));
// A restarted worker has seen no activation yet; onCreated's openerTabId covers the gap until this lands.
chrome.tabs
  .query({ active: true })
  .then((tabs) => {
    for (const t of tabs) if (!activeTabs.has(t.windowId)) activeTabs.set(t.windowId, { current: t.id });
  })
  .catch(() => {});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.active && tab.groupId !== TAB_GROUP_NONE) keepHumanTab(tab).catch(() => {});
  // Recorded here and not on demand because both sources of attribution are perishable: the worker is
  // torn down after ~30 s idle, and Chromium clears openerTabId when the opener closes — which a site
  // does routinely, right after its popup reports back.
  popups
    .noteOpened(tab)
    .then((groupId) => {
      if (groupId != null) {
        schedulePush(); // the popup only becomes routable once it is attributed
        keepHumanWindow(tab, groupId).catch(() => {});
      }
    })
    .catch(() => {});
});

// A popup window arrives focused, on top of whatever the human was looking at. keepHumanTab cannot see
// it — it listens for tabs and checks tab.groupId, and a popup's tab has neither a group nor a window of
// the human's. Adoption is what proves the popup is an agent's doing rather than the human's, so the
// hand-back is gated on exactly that. Only the window is raised: the popup keeps running (and stays
// drivable through the focus emulation cdp.js sets on every attach), it just stops covering the human.
let lastFocusedWindowId = null;
let previousFocusedWindowId = null;

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE || windowId === lastFocusedWindowId) return;
  previousFocusedWindowId = lastFocusedWindowId;
  lastFocusedWindowId = windowId;
});
chrome.windows.onRemoved.addListener((windowId) => {
  if (lastFocusedWindowId === windowId) lastFocusedWindowId = null;
  if (previousFocusedWindowId === windowId) previousFocusedWindowId = null;
});
chrome.windows
  .getLastFocused({ windowTypes: ["normal"] })
  .then((win) => {
    if (lastFocusedWindowId == null) lastFocusedWindowId = win.id;
  })
  .catch(() => {});

async function keepHumanWindow(tab, groupId) {
  const held = new Set(attachedTabIds());
  held.delete(tab.id);
  if (held.size === 0) return;
  const members = await chrome.tabs.query({ groupId });
  // Only a group with a tab an agent is actually driving; a popup from the human's own grouped tab is
  // theirs to look at.
  if (!members.some((t) => held.has(t.id))) return;
  // onCreated may land before or after the popup takes focus; either order resolves to the window the
  // human had in front.
  const back = lastFocusedWindowId === tab.windowId ? previousFocusedWindowId : lastFocusedWindowId;
  if (back == null || back === tab.windowId) return;
  // A human watching the group's own tab is watching this flow happen; leave their focus alone.
  if (members.some((t) => t.windowId === back && t.active)) return;
  const win = await chrome.windows.get(back).catch(() => null);
  if (!win || win.type !== "normal") return;
  await chrome.windows.update(back, { focused: true }).catch(() => {});
}

async function keepHumanTab(tab) {
  // A new-tab page is the human's own doing (the group's context menu), never a page's.
  if (NEW_TAB_PAGE.test(tab.pendingUrl || tab.url || "")) return;
  // So is a tab with no opener: a page's window.open, target=_blank or Enter on a link is a LINK
  // transition, which always inherits the window's active tab as opener (exp2 measured it for window.open
  // and link clicks), while the human reopening a closed tab into the group (Cmd+Shift+T) or dropping a
  // link on the tab strip sets none, and switching away from a tab the human just asked for is exactly
  // what this must not do.
  if (tab.openerTabId == null) return;
  const held = new Set(attachedTabIds());
  held.delete(tab.id);
  if (held.size === 0) return;
  // onCreated normally fires before onActivated for the new tab; either order is handled. openerTabId
  // is the window's previously active tab for page-opened tabs (not the source), so it is the fallback.
  const seen = activeTabs.get(tab.windowId);
  const prev = seen && seen.current !== tab.id ? seen.current : (seen?.previous ?? tab.openerTabId);
  if (prev == null || prev === tab.id) return;
  const members = await chrome.tabs.query({ groupId: tab.groupId });
  // Only a group with a tab an agent drives, and only when the human was elsewhere: a human looking at
  // a tab of that group sees its new tab as they would without us.
  if (!members.some((t) => held.has(t.id)) || members.some((t) => t.id === prev)) return;
  const [back, now] = await Promise.all([chrome.tabs.get(prev), chrome.tabs.get(tab.id)]);
  if (back.windowId !== tab.windowId || !now.active) return;
  await editTabs(() => chrome.tabs.update(prev, { active: true }));
}

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

// DevTools console / e2e handle. Module bindings are unreachable from the worker's global scope, so
// without this a tool can only be run through the native host. Nothing outside this extension's own
// worker (its DevTools, or a debugger attached to it) can reach the worker's globals.
// Runs a tool like a broker request does, minus the transport: file chunks are dropped.
globalThis.openbrowser = {
  groupRecords, // groupId -> { container: null | { stamp, containerName } }
  async callTool(tool, args = {}) {
    const handler = handlers[tool];
    if (!handler) throw new Error(`Unknown tool: ${tool}`);
    try {
      const { browserId } = await getIdentity();
      return await handler(args, { browserId, requestId: `console-${Date.now()}`, sendChunk: () => {} });
    } catch (err) {
      throw new Error(`${tool} failed: ${err.message}`);
    } finally {
      schedulePush();
    }
  },
};

// --- Init ---
Promise.all([loadRecords(), popups.loadOwners()]).then(schedulePush, schedulePush);
bridge.connect({ onToolRequest, onControl });
