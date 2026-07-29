// MCP browsing contexts, keyed by windowId. Each context is one window holding one MCP tab group.
// Keying by windowId means several windows — including several incognito ones — work for free,
// and chrome.tabGroups.get() returns a windowId, so recovery after a service worker restart is exact.

export const GROUP_TITLE = "MCP";
export const GROUP_TITLE_INCOGNITO = "MCP Incognito";

export const contexts = new Map(); // windowId -> { groupId, incognito, tabs: Set<tabId> }

function titleForMode(incognito) {
  return incognito ? GROUP_TITLE_INCOGNITO : GROUP_TITLE;
}

function isMcpGroupTitle(title) {
  return title === GROUP_TITLE || title === GROUP_TITLE_INCOGNITO;
}

// Drop contexts whose group is gone, and refresh tab sets from live state.
// Chrome destroys a group once its last tab leaves, so an empty group means the context is dead.
export async function syncContexts() {
  for (const [windowId, ctx] of contexts) {
    try {
      const group = await chrome.tabGroups.get(ctx.groupId);
      const tabs = await chrome.tabs.query({ groupId: ctx.groupId });
      if (tabs.length === 0) {
        contexts.delete(windowId);
        continue;
      }
      ctx.tabs = new Set(tabs.map((t) => t.id));
      // A group dragged into another window keeps its id, so the key would otherwise go stale and
      // contextOfTab would later insert a SECOND entry for the same group under the new window.
      if (group.windowId !== windowId) {
        contexts.delete(windowId);
        contexts.set(group.windowId, ctx);
      }
    } catch {
      contexts.delete(windowId);
    }
  }

  // After a service worker restart the Map is empty until recoverContexts() lands. Rebuild on
  // demand so we adopt the existing MCP windows instead of opening duplicates alongside them.
  if (contexts.size === 0) await recoverContexts();
}

// Recover MCP contexts after service worker restart. Every MCP group is rebuilt, so multiple
// windows (including several incognito ones) survive a restart rather than the first one winning.
export async function recoverContexts() {
  try {
    for (const title of [GROUP_TITLE, GROUP_TITLE_INCOGNITO]) {
      const groups = await chrome.tabGroups.query({ title });
      for (const group of groups) {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        if (tabs.length === 0) continue;
        contexts.set(group.windowId, {
          groupId: group.id,
          incognito: title === GROUP_TITLE_INCOGNITO,
          tabs: new Set(tabs.map((t) => t.id)),
        });
      }
    }
  } catch {
    // Not critical - contexts are rebuilt on demand by resolveContext/contextOfTab
  }
}

// "Allow in Incognito" is a user-granted permission that no API can turn on, so fail loudly with
// the exact steps instead of letting windows.create throw something cryptic.
export async function assertIncognitoAllowed() {
  let allowed = false;
  try {
    allowed = await chrome.extension.isAllowedIncognitoAccess();
  } catch {}
  if (!allowed) {
    throw new Error(
      'Incognito access is not enabled for this extension. Open chrome://extensions, find ' +
        '"OpenBrowser MCP", click Details, and turn on "Allow in Incognito", then retry. ' +
        "This cannot be enabled programmatically."
    );
  }
}

export async function createContext(incognito) {
  if (incognito) await assertIncognitoAllowed();

  let win;
  try {
    win = await chrome.windows.create({ focused: true, url: "about:blank", incognito: !!incognito });
  } catch (e) {
    if (incognito) {
      throw new Error(`Could not open an incognito window: ${e.message}. Incognito may be disabled by policy.`);
    }
    throw e;
  }

  const tab = win.tabs[0];
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, {
    title: titleForMode(incognito),
    color: incognito ? "purple" : "blue",
  });

  const ctx = { groupId, incognito: !!incognito, tabs: new Set([tab.id]) };
  contexts.set(win.id, ctx);
  return { windowId: win.id, ctx };
}

// Resolve which context a request targets:
// - windowId given  -> that exact context (must already exist)
// - newWindow: true -> always a fresh window
// - otherwise       -> reuse the most recent context matching `incognito`, creating one if none
export async function resolveContext({ windowId, incognito, newWindow, createIfEmpty = true } = {}) {
  await syncContexts();

  if (windowId != null) {
    const ctx = contexts.get(windowId);
    if (!ctx) {
      throw new Error(`No MCP window with windowId ${windowId}. Use tabs_context_mcp to list open MCP windows.`);
    }
    return { windowId, ctx };
  }

  if (!newWindow) {
    // Map preserves insertion order, so the last match is the most recently created context.
    let match = null;
    for (const [id, ctx] of contexts) {
      if (ctx.incognito === !!incognito) match = { windowId: id, ctx };
    }
    if (match) return match;
  }

  if (!createIfEmpty) return null;
  return createContext(incognito);
}

// Find the context a tab belongs to, or null if it isn't in an MCP group.
export async function contextOfTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }

  const known = contexts.get(tab.windowId);
  if (known && tab.groupId === known.groupId) return { windowId: tab.windowId, ctx: known };

  // Always check live state - in-memory contexts can be stale after a service worker restart.
  if (tab.groupId !== -1) {
    try {
      const group = await chrome.tabGroups.get(tab.groupId);
      if (isMcpGroupTitle(group.title)) {
        const groupTabs = await chrome.tabs.query({ groupId: group.id });
        const recovered = {
          groupId: group.id,
          incognito: group.title === GROUP_TITLE_INCOGNITO,
          tabs: new Set(groupTabs.map((t) => t.id)),
        };
        // Drop any entry still filed under the group's previous window, so one group never ends
        // up listed twice under two different windowIds.
        for (const [wid, c] of contexts) {
          if (c.groupId === group.id && wid !== group.windowId) contexts.delete(wid);
        }
        contexts.set(group.windowId, recovered);
        return { windowId: group.windowId, ctx: recovered };
      }
    } catch {}
    return null;
  }

  // Ungrouped but still tracked (e.g. the user dragged it out of the group).
  if (known && known.tabs.has(tabId)) return { windowId: tab.windowId, ctx: known };
  return null;
}

export async function isInGroup(tabId) {
  return (await contextOfTab(tabId)) !== null;
}

function cell(value, max) {
  const flat = String(value ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// entries: [{ windowId, ctx, tabs }] where tabs are chrome.tabs.Tab objects.
// One markdown table and nothing else — the previous shape returned the same data three times
// (availableTabs JSON, windows JSON, markdown) at 2,337 chars a call.
export function formatTabContext(entries) {
  const blocks = [];
  for (const { windowId, ctx, tabs } of entries) {
    let text = `Window ${windowId}${ctx.incognito ? " (incognito)" : ""}\n`;
    if (!tabs || tabs.length === 0) {
      text += "(no tabs)";
    } else {
      text += "| tabId | title | url |\n|---|---|---|\n";
      text += tabs
        .map((t) => `| ${t.id} | ${cell(t.title || "Untitled", 40)} | ${cell(t.url, 100)} |`)
        .join("\n");
    }
    blocks.push(text);
  }
  return { content: [{ type: "text", text: blocks.join("\n\n") }] };
}
