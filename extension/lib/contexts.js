// Workspaces are tab groups, keyed by groupId. Several agents run at once and none of them can know which
// existing window or tab is its own, so each creates its own group and names it. The name is only a
// label for the human (and a hint for the agent): the tab id is the identity, nothing is ever looked up
// by name, and two groups with the same name are two workspaces. Agents may use any tab group, the
// human's own included; ungrouped tabs stay off-limits.
//
// Live group and tab state is always read from chrome.tabGroups / chrome.tabs, never cached: Chrome adds
// link-opened tabs to groups, and the human drags tabs and groups around, so any cached tab set goes
// stale. The one thing kept here is what the browser cannot tell us — whether a group is a Brave
// temporary container, and the stamp its tabs must carry (brave-containers.js). Those records are
// mirrored to chrome.storage.session, because the MV3 worker is torn down after ~30 s idle and a record
// lost with it would drop a container group's isolation check until the group was probed again.

import * as brave from "./brave-containers.js";
import { editTabs } from "./tab-edits.js";

export const TAB_GROUP_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
export const DEFAULT_GROUP_NAME = "MCP";

const STORE_KEY = "groupRecords";
// A group moved to another window fires tabGroups.onRemoved and then onCreated under the SAME id
// (Chromium detaches and re-inserts it), so removal is only believed once the id is still gone after this.
const REMOVAL_CONFIRM_MS = 2000;
// tabs_context_mcp declares a 20000-char result budget; the listing stops short of it (footer included)
// rather than being cut off by the client, which would lose exactly the tab ids an agent needs.
const LISTING_MAX_CHARS = 19000;
// grey is left out: it is what an unnamed group looks like, and a workspace always has a name.
const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// --- Group records -----------------------------------------------------------------------------

export const groupRecords = new Map(); // groupId -> { container: null | { stamp, containerName } }
const learning = new Map(); // groupId -> in-flight probe, so concurrent calls on one group probe once
let loading = null;
let persisting = Promise.resolve();

function validRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.container === null) return true;
  return typeof rec.container?.stamp === "string" && typeof rec.container?.containerName === "string";
}

// chrome.storage.session outlives a worker restart but not a browser restart or an extension reload;
// after either, container groups come back through the lazy probe in recordFor instead.
export function loadRecords() {
  if (!loading) {
    loading = (async () => {
      let stored = {};
      try {
        stored = (await chrome.storage.session.get(STORE_KEY))?.[STORE_KEY] || {};
      } catch {}
      for (const [key, rec] of Object.entries(stored)) {
        const id = Number(key);
        // A record set in this worker before the load finished is newer than what storage holds.
        if (!Number.isInteger(id) || groupRecords.has(id) || !validRecord(rec)) continue;
        groupRecords.set(id, rec);
      }
      // onRemoved can fire before the load lands (and is then pruned from nothing), so the load
      // prunes too; otherwise records of closed groups would pile up for the whole browser session.
      let pruned = false;
      for (const id of [...groupRecords.keys()]) {
        try {
          await chrome.tabGroups.get(id);
        } catch {
          groupRecords.delete(id);
          pruned = true;
        }
      }
      if (pruned) persist();
    })();
  }
  return loading;
}

// Chained so a slow write can never land after a newer one; the snapshot is taken when the write
// runs, so it is always the latest map.
function persist() {
  persisting = persisting
    .then(() => chrome.storage.session.set({ [STORE_KEY]: Object.fromEntries(groupRecords) }))
    .catch(() => {});
  return persisting;
}

async function setRecord(groupId, record) {
  await loadRecords();
  groupRecords.set(groupId, record);
  await persist();
}

// Deleted only once the group is really gone. Dropping the record on a window move lost a container
// group's isolation check: the next gated call re-learned the group from whichever tab it named, and a
// default-jar tab the human had added made the whole group plain. loadRecords prunes anything this misses
// (a worker torn down within the delay).
chrome.tabGroups.onRemoved.addListener((group) => {
  setTimeout(async () => {
    try {
      await chrome.tabGroups.get(group.id);
      return;
    } catch {}
    learning.delete(group.id);
    if (groupRecords.delete(group.id)) persist();
  }, REMOVAL_CONFIRM_MS);
});

// The record for a tab's group, learning it on first use. On Brave a group with no record (a browser
// restart renumbers groups and empties session storage) is probed through this tab once. Returns
// { tab, record }: tab may be a reloaded copy, and record is null when the probe could not read the
// tab's jar, or read it before the tab's page had finished loading and found no container; nothing is
// recorded then, and the next call probes again.
async function recordFor(tab) {
  await loadRecords();
  const known = groupRecords.get(tab.groupId);
  if (known) return { tab, record: known };

  // Only Brave has temporary containers, and never in incognito (tabs_create_mcp refuses the pair),
  // so everything else is plain without spending a debugger attach on it.
  if (tab.incognito || !(await brave.isBrave())) {
    const record = { container: null };
    await setRecord(tab.groupId, record);
    return { tab, record };
  }

  // Reload a discarded tab before the probe attaches: if the tab is a container tab, any navigation
  // issued while it is discarded moves it to the default jar for good.
  try {
    tab = await brave.wakeTab(tab);
  } catch (e) {
    throw new Error(`${e.message}. Retry, or call tabs_context_mcp to pick another tab.`);
  }

  let pending = learning.get(tab.groupId);
  if (!pending) {
    const groupId = tab.groupId;
    const probed = tab;
    pending = (async () => {
      const learned = await brave.learnContainer(probed.id);
      if (!learned) return null;
      // A valid stamp can only come from a container's own jar, so a container verdict stands. A plain
      // one needs a committed page: before a reload commits, the tab can still read the default jar
      // through its discarded placeholder, and a group recorded plain is never checked again.
      if (!learned.container) {
        const now = await chrome.tabs.get(probed.id).catch(() => null);
        if (probed.status !== "complete" || now?.status !== "complete") return null;
      }
      await setRecord(groupId, learned);
      return learned;
    })().finally(() => learning.delete(groupId));
    learning.set(groupId, pending);
  }
  return { tab, record: await pending };
}

// The record already known for a tab's group, without probing. null when there is none yet.
export async function knownRecord(tab) {
  if (tab?.groupId == null || tab.groupId === TAB_GROUP_NONE) return null;
  await loadRecords();
  return groupRecords.get(tab.groupId) || null;
}

// --- Rendering ---------------------------------------------------------------------------------

function cell(value, max) {
  const flat = String(value ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// Quoted, with quotes and control characters escaped, so a group named `x" · window 9` cannot forge
// the fields that follow it on the line.
export function groupName(title) {
  const flat = String(title ?? "").replace(/\s+/g, " ").trim();
  return flat ? JSON.stringify(flat) : "(untitled)";
}

export function groupLabel(group) {
  return `group ${group.id} ${groupName(group.title)}`;
}

// entries: [{ group, tabs, record }]. One compact markdown block per group and nothing else — the data
// an agent needs to pick a tabId, at the cost of one table row per tab. The human's own groups are listed
// too, so the output is capped: it stops at the first row past the budget and says what it left out.
export function formatGroups(entries) {
  const FOOTER_RESERVE = 120;
  const blocks = [];
  let used = 0;
  let hiddenTabs = 0;
  let hiddenGroups = 0;
  for (const { group, tabs, record } of entries) {
    if (hiddenTabs > 0) {
      hiddenTabs += tabs.length;
      hiddenGroups++;
      continue;
    }
    let head = `Group ${group.id} ${groupName(group.title)} · window ${group.windowId} · ${group.color}`;
    if (tabs.some((t) => t.incognito)) head += " · incognito";
    if (record?.container) head += ` · temporary container ${JSON.stringify(record.container.containerName)}`;
    let block = `${head}\n| tabId | active | title | url |\n|---|---|---|---|`;
    let size = used + (blocks.length ? 2 : 0) + block.length;
    let shown = 0;
    for (const t of tabs) {
      const row = `| ${t.id} | ${t.active ? "yes" : ""} | ${cell(t.title || "Untitled", 40)} | ${cell(t.url || t.pendingUrl, 100)} |`;
      if (size + 1 + row.length > LISTING_MAX_CHARS - FOOTER_RESERVE) break;
      block += `\n${row}`;
      size += 1 + row.length;
      shown++;
    }
    if (shown < tabs.length) {
      hiddenTabs += tabs.length - shown;
      hiddenGroups++;
    }
    if (shown > 0) {
      blocks.push(block);
      used = size;
    }
  }
  let out = blocks.join("\n\n");
  if (hiddenTabs > 0) {
    out +=
      `${out ? "\n\n" : ""}… ${hiddenTabs} more tab(s) in ${hiddenGroups} group(s) not shown; pass windowId to ` +
      `list one window.`;
  }
  return out;
}

// --- Lookup ------------------------------------------------------------------------------------

// Every tab group (in one window when windowId is given) with its tabs in strip order. Read-only: no
// probe, no attach, so listing never touches a tab.
export async function listGroups({ windowId } = {}) {
  await loadRecords();
  const filter = windowId != null ? { windowId: Number(windowId) } : {};
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query(filter), chrome.tabs.query(filter)]);
  const byGroup = new Map();
  for (const t of tabs) {
    if (t.groupId === TAB_GROUP_NONE) continue;
    let list = byGroup.get(t.groupId);
    if (!list) byGroup.set(t.groupId, (list = []));
    list.push(t);
  }
  return groups
    .map((group) => ({
      group,
      tabs: (byGroup.get(group.id) || []).sort((a, b) => a.index - b.index),
      record: groupRecords.get(group.id) || null,
    }))
    .filter((e) => e.tabs.length > 0)
    .sort((a, b) => a.group.windowId - b.group.windowId || a.tabs[0].index - b.tabs[0].index);
}

// One group and its tabs, or null once it is gone (Chrome destroys a group with its last tab).
export async function groupEntry(groupId) {
  let group;
  try {
    group = await chrome.tabGroups.get(Number(groupId));
  } catch {
    return null;
  }
  const tabs = (await chrome.tabs.query({ groupId: group.id })).sort((a, b) => a.index - b.index);
  if (tabs.length === 0) return null;
  return { group, tabs, record: await knownRecord(tabs[0]) };
}

// The tab and its group, with no isolation check. For operations that do not act inside the page:
// closing a tab must work precisely when its isolation check is failing.
export async function groupedTab(tabId) {
  if (tabId == null || tabId === "" || !Number.isInteger(Number(tabId))) {
    throw new Error(
      "tabId is required. Call tabs_context_mcp to list the tabs in tab groups, or tabs_create_mcp to open one."
    );
  }
  let tab;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch {
    throw new Error(
      `No tab with id ${tabId}. Call tabs_context_mcp to list the tabs in tab groups, or tabs_create_mcp to open one.`
    );
  }
  if (tab.groupId === TAB_GROUP_NONE) {
    throw new Error(
      `Tab ${tab.id} is not in a tab group, and only tabs in tab groups can be used. Call tabs_context_mcp ` +
        `to list grouped tabs, or tabs_create_mcp({group: "<name>"}) to open a tab in a new group.`
    );
  }
  let group;
  try {
    group = await chrome.tabGroups.get(tab.groupId);
  } catch {
    throw new Error(`Tab ${tab.id}'s group was just removed. Call tabs_context_mcp and pick a tab again.`);
  }
  return { tab, group };
}

// The gate every tool that acts on a tab goes through. Returns { tab, group, record }; throws unless
// the tab exists, is in a tab group, and — when that group is a temporary container — provably still
// reads its container's cookie jar right now. record is null only on Brave when the group has never
// been probed successfully (the tab shows a page the debugger cannot attach to), so callers must treat
// null as "possibly a container".
export async function requireTab(tabId) {
  const found = await groupedTab(tabId);
  const { group } = found;
  let tab = found.tab;

  // On Brave every grouped tab is woken, whatever its group's record says: the record describes the
  // group, not this tab, and a container tab can sit in a group recorded plain (dragged there, or one of
  // the human's own Brave container tabs). Navigating it while discarded would move it into the default
  // jar for good. A no-op for a tab that is awake; before any probe or navigation. Woken here rather than
  // inside the isolation check, so a tab that will not reload is reported as that, not as a leaked one.
  if (!tab.incognito && (await brave.isBrave())) {
    try {
      tab = await brave.wakeTab(tab);
    } catch (e) {
      throw new Error(`${e.message}. Retry, or call tabs_context_mcp to pick another tab.`);
    }
  }
  let record;
  ({ tab, record } = await recordFor(tab));
  if (!record?.container) return { tab, group, record };

  const { tab: checked, reason } = await brave.checkIsolation(tab, record.container.stamp);
  if (reason == null) return { tab: checked, group, record };

  // Adding first, closing second: tabs_create_mcp({tabId}) reuses the container without checking the tab
  // it names, while closing a group's last tab ends the group, its record, and with it the only way back
  // into that container (a logged-in session would be lost).
  throw new Error(
    `Tab ${tab.id} is in temporary-container ${groupLabel(group)} (container ` +
      `${JSON.stringify(record.container.containerName)}) but is no longer isolated in its container ` +
      `(${reason}). First open a verified tab in the same container with tabs_create_mcp({tabId: ${tab.id}}), ` +
      `then close this one with tabs_close_mcp({tabId: ${tab.id}}); or create a new group with ` +
      `tabs_create_mcp({group: "<name>", temporaryContainer: true}).`
  );
}

// Every grouped tab, for the broker's tabId -> browser routing index.
export async function groupedTabIndex() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.groupId !== TAB_GROUP_NONE)
    .map((t) => ({ tabId: t.id, windowId: t.windowId, incognito: !!t.incognito }))
    .sort((a, b) => a.tabId - b.tabId);
}

// --- Windows -----------------------------------------------------------------------------------

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

// incognito flag -> the windows.create promise of the fallback window made for that mode. Kept after it
// resolves: a caller whose getAll ran before that window existed must still find it here.
const fallbackWindows = new Map();

// Windows belong to the human, so a new one is the last resort: the requested window, else the
// last-focused normal window of the right mode, else the newest such window, and only when none exists
// a new UNFOCUSED one. Returns { windowId, placeholderTabId }: a window created by THIS call comes with an
// about:blank tab the caller removes once its own tab is in place (removing it first would close the
// window).
export async function chooseWindow({ windowId, incognito = false } = {}) {
  if (incognito) await assertIncognitoAllowed();

  if (windowId != null) {
    let win;
    try {
      win = await chrome.windows.get(Number(windowId));
    } catch {
      throw new Error(
        `No window with windowId ${windowId}. Omit windowId to use the last-focused window, or call ` +
          `tabs_context_mcp to see which windows hold tab groups.`
      );
    }
    if (win.type !== "normal") {
      throw new Error(`Window ${windowId} is a ${win.type} window, not a normal browser window. Omit windowId.`);
    }
    if (!!win.incognito !== !!incognito) {
      throw new Error(
        win.incognito
          ? `Window ${windowId} is an incognito window: pass incognito: true to create a tab there, or omit windowId.`
          : `Window ${windowId} is not an incognito window: drop incognito: true, or omit windowId.`
      );
    }
    return { windowId: win.id, placeholderTabId: null };
  }

  try {
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (last?.type === "normal" && !!last.incognito === !!incognito) {
      return { windowId: last.id, placeholderTabId: null };
    }
  } catch {} // no window was ever focused

  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const newest = all
    .filter((w) => w.type === "normal" && !!w.incognito === !!incognito)
    .sort((a, b) => b.id - a.id)[0];
  if (newest) return { windowId: newest.id, placeholderTabId: null };

  // One window shared by every concurrent caller: each of them ran getAll before the first window
  // existed, so four agents starting against a windowless browser each opened their own.
  const key = !!incognito;
  for (;;) {
    const pending = fallbackWindows.get(key);
    if (!pending) break;
    const shared = await pending.catch(() => null);
    if (shared && (await chrome.windows.get(shared.id).catch(() => null))) {
      return { windowId: shared.id, placeholderTabId: null };
    }
    if (fallbackWindows.get(key) === pending) fallbackWindows.delete(key);
  }
  const creating = chrome.windows.create({ focused: false, incognito: key, url: "about:blank" });
  fallbackWindows.set(key, creating);
  let win;
  try {
    win = await creating;
  } catch (e) {
    if (fallbackWindows.get(key) === creating) fallbackWindows.delete(key);
    if (incognito) {
      throw new Error(`Could not open an incognito window: ${e.message}. Incognito may be disabled by policy.`);
    }
    throw e;
  }
  return { windowId: win.id, placeholderTabId: win.tabs?.[0]?.id ?? null };
}

// --- Creation ----------------------------------------------------------------------------------

// Control characters and bidi overrides/isolates out: the title is shown in the human's tab strip, where
// U+202E would make one agent's label read as another's.
function normalizeName(name) {
  return typeof name === "string"
    ? name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

// Deterministic, so the same name gets the same colour across calls and restarts; FNV-1a because a
// plain character sum puts anagrams and near-identical names on the same colour.
export function colorFor(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return GROUP_COLORS[(h >>> 0) % GROUP_COLORS.length];
}

// A NEW group holding one background tab — always new, even when a group with that name exists.
// Returns { tab, group, record }.
export async function createGroup({ group, windowId, incognito = false, temporaryContainer = false } = {}) {
  const name = normalizeName(group) || DEFAULT_GROUP_NAME;
  if (temporaryContainer) {
    // Brand first: on any other browser "drop incognito" would only lead to the next refusal.
    await brave.assertBrave();
    if (incognito) {
      throw new Error(
        "temporaryContainer cannot be combined with incognito: Brave does not put incognito tabs in " +
          "temporary containers. Drop one of the two."
      );
    }
  }

  const { windowId: winId, placeholderTabId } = await chooseWindow({ windowId, incognito });
  let tab = null;
  try {
    let record;
    if (temporaryContainer) {
      // Opens wherever Brave's relay puts it (the last-active window); grouping below moves it to winId.
      const opened = await brave.newContainerTab(name);
      tab = opened.tab;
      record = { container: { stamp: opened.stamp, containerName: opened.containerName } };
    } else {
      // about:blank, not the chrome://newtab/ default: the debugger cannot attach to a chrome:// URL,
      // so a newtab-parked tab refuses every attach until the first navigation has already finished —
      // which is exactly too late for navigate to enable Network and see the document request.
      tab = await chrome.tabs.create({ windowId: winId, active: false, url: "about:blank" });
      record = { container: null };
    }
    const groupId = await editTabs(() =>
      chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: winId } })
    );
    // Recorded before anything else can fail, so a container group never exists unrecorded.
    await setRecord(groupId, record);
    await editTabs(() => chrome.tabGroups.update(groupId, { title: name, color: colorFor(name) }));
    return { tab: await chrome.tabs.get(tab.id), group: await chrome.tabGroups.get(groupId), record };
  } catch (e) {
    if (tab) await editTabs(() => chrome.tabs.remove(tab.id)).catch(() => {});
    throw e;
  } finally {
    // Only while the window holds another tab: removing its last tab closes the window, which a
    // concurrent creation may have picked up (chooseWindow shares it) and not filled yet.
    if (placeholderTabId != null) {
      const rest = await chrome.tabs.query({ windowId: winId }).catch(() => []);
      if (rest.some((t) => t.id !== placeholderTabId)) await editTabs(() => chrome.tabs.remove(placeholderTabId)).catch(() => {});
    }
  }
}

// ONE new background tab at the end of tabId's group, in that group's window, and in its container
// when it is a container group. The creation params only have to agree with the group; they never
// select anything. Returns { tab, group, record }.
export async function addTabToGroup(tabId, { group: name, windowId, incognito, temporaryContainer } = {}) {
  // Brand first, so a non-Brave browser is never told to "pass temporaryContainer: true" instead.
  if (temporaryContainer === true) await brave.assertBrave();
  const found = await groupedTab(tabId);
  const { group } = found;
  const label = groupLabel(group);

  const wanted = normalizeName(name);
  if (wanted && wanted !== normalizeName(group.title)) {
    throw new Error(
      `group names a NEW tab group, but tabId ${found.tab.id} adds a tab to its existing ${label}. Drop ` +
        `group to add the tab there, or drop tabId to create a new group named ${JSON.stringify(wanted)}.`
    );
  }
  if (windowId != null && Number(windowId) !== group.windowId) {
    throw new Error(
      `tabId ${found.tab.id} is in window ${group.windowId}, and a tab added to its group opens there. ` +
        `Drop windowId, or drop tabId to create a new group in window ${windowId}.`
    );
  }
  if (incognito != null && !!incognito !== !!found.tab.incognito) {
    throw new Error(
      `tabId ${found.tab.id} is ${found.tab.incognito ? "" : "not "}in an incognito window, and a tab added ` +
        `to its group opens there. Drop incognito, or drop tabId to create a new group.`
    );
  }

  const { record } = await recordFor(found.tab);
  if (!record) {
    throw new Error(
      `Could not tell whether ${label} is a Brave temporary container: tab ${found.tab.id}'s cookie jar ` +
        `cannot be read yet (it may still be loading, show a browser-internal page, or have another debugger ` +
        `attached). Retry once it has loaded, pass the tabId of another tab of that group that shows a web ` +
        `page, or navigate this one to a web page first.`
    );
  }
  if (temporaryContainer != null && !!temporaryContainer !== !!record.container) {
    throw new Error(
      record.container
        ? `${label} is a temporary-container group, so a tab added with tabId opens in its container ` +
            `${JSON.stringify(record.container.containerName)}. Drop temporaryContainer, or drop tabId ` +
            `to create a new plain group.`
        : `${label} is a plain tab group, and a tab added with tabId joins it as it is. Drop ` +
            `temporaryContainer, or drop tabId and pass temporaryContainer: true to create a new container group.`
    );
  }

  let tab = null;
  try {
    if (record.container) {
      tab = await brave.newTabInContainer(record.container);
      // Re-read the group: the relay waited in the queue, and the group may have grown or moved since.
      const now = await chrome.tabs.query({ groupId: group.id });
      if (now.length === 0) {
        throw new Error(`${label} was closed while its new tab was being opened; the tab was closed too`);
      }
      const target = await chrome.tabGroups.get(group.id);
      // The relay put the tab in the last-active window; moving keeps the container.
      await editTabs(() =>
        chrome.tabs.move(tab.id, { windowId: target.windowId, index: Math.max(...now.map((t) => t.index)) + 1 })
      );
    } else {
      const now = await chrome.tabs.query({ groupId: group.id });
      if (now.length === 0) throw new Error(`${label} was just closed. Call tabs_context_mcp and pick a tab again.`);
      tab = await chrome.tabs.create({
        windowId: group.windowId,
        index: Math.max(...now.map((t) => t.index)) + 1,
        active: false,
        url: "about:blank",
      });
    }
    await editTabs(() => chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] }));
    return { tab: await chrome.tabs.get(tab.id), group: await chrome.tabGroups.get(group.id), record };
  } catch (e) {
    if (tab) await editTabs(() => chrome.tabs.remove(tab.id)).catch(() => {});
    throw e;
  }
}
