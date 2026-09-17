// Multi-browser routing for the broker. Every Chromium profile that loads the extension gets the
// same extension ID and the same browser-level native-host manifest, so they all dial the broker —
// the second one is registered here instead of being rejected.

// A browser that drops off keeps its tab index here so a native-host reconnect (which happens on
// every broker restart and every service-worker respawn) doesn't lose the tabId -> browser mapping.
const RETIRED_LIMIT = 16;

function describe(entry) {
  return `${entry.browserId} "${entry.label || entry.brand || "unlabelled"}"`;
}

export class BrowserRegistry {
  constructor() {
    this.browsers = new Map(); // browserId -> { socket, brand, label, extVersion, incognitoAllowed, connectedAt, tabs }
    this.retired = new Map(); // browserId -> tabs Map
    this.selections = new Map(); // clientId -> browserId
  }

  socketBrowserId(socket) {
    for (const [browserId, entry] of this.browsers) {
      if (entry.socket === socket) return browserId;
    }
    return null;
  }

  register(socket, hello = {}) {
    const browserId = String(hello.browserId || "legacy");

    // A socket classified as "legacy" by the 500 ms fallback can still send a late host_hello.
    const prev = this.socketBrowserId(socket);
    if (prev && prev !== browserId) this.unregister(socket);

    let entry = this.browsers.get(browserId);
    if (entry) {
      if (entry.socket !== socket && entry.socket && !entry.socket.destroyed) entry.socket.destroy();
      entry.socket = socket;
    } else {
      entry = {
        browserId,
        socket,
        connectedAt: Date.now(),
        tabs: this.retired.get(browserId) || new Map(),
      };
      this.retired.delete(browserId);
      this.browsers.set(browserId, entry);
    }
    entry.brand = hello.brand || entry.brand || "Chromium";
    entry.label = hello.label ?? entry.label ?? null;
    entry.extVersion = hello.extVersion || entry.extVersion || null;
    entry.incognitoAllowed = hello.incognitoAllowed ?? entry.incognitoAllowed ?? false;
    return browserId;
  }

  unregister(socket) {
    const browserId = this.socketBrowserId(socket);
    if (!browserId) return null;
    const entry = this.browsers.get(browserId);
    this.browsers.delete(browserId);
    if (entry.tabs.size) {
      this.retired.set(browserId, entry.tabs);
      while (this.retired.size > RETIRED_LIMIT) {
        this.retired.delete(this.retired.keys().next().value);
      }
    }
    return browserId;
  }

  get(browserId) {
    return this.browsers.get(String(browserId));
  }

  list() {
    return [...this.browsers.values()].map((e) => ({
      browserId: e.browserId,
      brand: e.brand,
      label: e.label,
      incognitoAllowed: !!e.incognitoAllowed,
      connectedAt: e.connectedAt,
      // Popups sit alone in a window of their own that no group can live in, so counting those
      // would report more windows than the human has open.
      windows: new Set([...e.tabs.values()].filter((t) => !t.popup).map((t) => t.windowId)).size,
      tabs: e.tabs.size,
    }));
  }

  // `replace` is the tab_index case (a full enumeration); tool results only ever add.
  updateTabIndex(browserId, tabs, { replace = true } = {}) {
    const entry = this.browsers.get(String(browserId));
    if (!entry || !Array.isArray(tabs)) return;
    if (replace) entry.tabs.clear();
    for (const t of tabs) {
      const tabId = Number(t?.tabId);
      if (!Number.isFinite(tabId)) continue;
      entry.tabs.set(tabId, { tabId, windowId: t.windowId ?? null, incognito: !!t.incognito, popup: !!t.popup });
    }
  }

  dropTab(browserId, tabId) {
    const entry = this.browsers.get(String(browserId));
    if (entry) entry.tabs.delete(Number(tabId));
  }

  browsersForTab(tabId) {
    const id = Number(tabId);
    const out = [];
    for (const [browserId, entry] of this.browsers) {
      if (entry.tabs.has(id)) out.push(browserId);
    }
    return out;
  }

  route({ tabId, browserId, selected } = {}) {
    if (browserId) {
      const entry = this.browsers.get(String(browserId));
      if (!entry) throw new Error(`Browser ${browserId} is not connected. Call browsers_list to see what is.`);
      return { browserId: entry.browserId };
    }

    if (this.browsers.size === 0) {
      throw new Error(
        "Browser extension is not connected. Make sure a supported Chromium browser is running with the OpenBrowser MCP extension installed and enabled."
      );
    }
    // The single-browser case must never depend on the tab index — the index is populated
    // asynchronously and a cold broker would otherwise reject the very first call.
    if (this.browsers.size === 1) return { browserId: this.browsers.keys().next().value };

    const selectedLive = selected && this.browsers.has(String(selected)) ? String(selected) : null;

    if (tabId !== undefined && tabId !== null && tabId !== "") {
      const candidates = this.browsersForTab(tabId);
      // A browser_select pin outranks a lone index hit in ANOTHER browser. Tab ids are per-browser
      // counters and the index lists every grouped tab, the human's own groups included, so a stale id
      // (a closed container tab in the pinned Brave) that collides with a grouped Chrome tab used to
      // run the agent's navigate or JS in the human's logged-in Chrome session. The pinned browser
      // answers "No tab with id" instead; an explicit browserId (above) still reaches the other one.
      if (candidates.length === 1) {
        return { browserId: selectedLive && candidates[0] !== selectedLive ? selectedLive : candidates[0] };
      }
      if (candidates.length > 1) {
        if (selectedLive && candidates.includes(selectedLive)) return { browserId: selectedLive };
        const who = candidates.map((id) => describe(this.browsers.get(id))).join(", ");
        throw new Error(`tabId ${tabId} exists in ${candidates.length} browsers (${who}) — pass browserId`);
      }
      if (selectedLive) return { browserId: selectedLive };
      throw new Error(`tabId ${tabId} is not in any connected browser's tab index — pass browserId`);
    }

    if (selectedLive) return { browserId: selectedLive };
    const who = [...this.browsers.values()].map(describe).join(", ");
    throw new Error(
      `${this.browsers.size} browsers connected (${who}) — pass browserId or pin one with browser_select`
    );
  }

  select(clientId, browserId) {
    if (browserId === null || browserId === undefined || browserId === "") {
      this.selections.delete(String(clientId));
      return null;
    }
    const entry = this.browsers.get(String(browserId));
    if (!entry) throw new Error(`Browser ${browserId} is not connected. Call browsers_list to see what is.`);
    this.selections.set(String(clientId), entry.browserId);
    return entry.browserId;
  }

  selectedFor(clientId) {
    const browserId = this.selections.get(String(clientId));
    if (!browserId) return null;
    // A selection that outlived its browser must not silently misroute.
    return this.browsers.has(browserId) ? browserId : null;
  }

  releaseClient(clientId) {
    this.selections.delete(String(clientId));
  }
}
