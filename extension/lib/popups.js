// Popup windows, adopted into the tab group of whatever opened them.
//
// A tab group only exists in a normal window. A page an agent drives can call window.open with a
// features string — every OAuth consent window does — and Chromium answers with a window of type
// "popup" holding that one tab, which can therefore never be grouped: chrome.tabs.group refuses it
// ("Grouping is not supported by tabs in this window.") and chrome.tabs.move refuses to relocate it
// ("Tabs can only be moved to and from normal windows."), both verified against Brave 1.95.102. The tab
// is pinned to that window for as long as it lives, and no extension API changes that. Preventing the
// popup is not an option either: Chromium has no pref or policy that routes popups into tabs, and the
// site decides whether to call window.open.
//
// So contexts.js's ownership rule — ungrouped means the human's — reads the wrong signal here: a popup
// is ungrouped by Chromium's construction, not by ownership. It is instead attributed to the tab group
// of its opener, transitively, since a popup may itself open a popup. From then on every tool treats it
// as a member of that group and nothing else has to change: chrome.debugger.attach({tabId}) does not
// care what kind of window a tab lives in, and the Brave container check still applies, because
// Network.getCookies reads the TAB's storage partition for a fixed probe URL — a popup showing
// accounts.google.com is probed exactly like any other tab (brave-containers.js).
//
// Both sources of attribution are perishable, so it is recorded the moment a popup is seen:
// chrome.tabs.onCreated fires once, the MV3 worker is torn down after ~30 s idle, and Chromium clears
// openerTabId when the opener closes — which happens mid-flow every time a site closes the tab that
// launched the popup. Records are mirrored to chrome.storage.session, which survives that teardown; a
// browser restart or extension reload clears them, and the live openerTabId walk covers that, since
// group ids are renumbered by a restart anyway and a stale id must never be believed.
//
// An ungrouped opener is followed only while it is itself a popup. An ungrouped tab in a normal window
// is the human's, and walking through one would hand an agent a window the human opened themselves.

const TAB_GROUP_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

const STORE_KEY = "popupOwners";
// Chromium builds no opener cycles, but a corrupt chain must not spin, and no real flow nests this deep
// (a consent window opening a consent window is two).
const MAX_CHAIN = 8;
// Only "popup". A PWA's "app" window and a "devtools" window are the human's and are never the answer to
// a page's window.open; "normal" tabs are either grouped already or deliberately the human's.
const ADOPTABLE_WINDOW_TYPES = new Set(["popup"]);

export const popupOwners = new Map(); // popup tabId -> { groupId, openerTabId }
let loading = null;
let persisting = Promise.resolve();

function validRecord(rec) {
  return !!rec && typeof rec === "object" && Number.isInteger(rec.groupId) && rec.groupId !== TAB_GROUP_NONE;
}

async function groupExists(groupId) {
  if (!Number.isInteger(groupId) || groupId === TAB_GROUP_NONE) return false;
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch {
    return false;
  }
}

// Mirrors loadRecords in contexts.js: a record written in this worker before the load landed is newer
// than storage, and the load prunes, since onRemoved may have fired before it (pruning nothing).
export function loadOwners() {
  if (!loading) {
    loading = (async () => {
      let stored = {};
      try {
        stored = (await chrome.storage.session.get(STORE_KEY))?.[STORE_KEY] || {};
      } catch {}
      for (const [key, rec] of Object.entries(stored)) {
        const id = Number(key);
        if (!Number.isInteger(id) || popupOwners.has(id) || !validRecord(rec)) continue;
        popupOwners.set(id, rec);
      }
      let pruned = false;
      for (const [tabId, rec] of [...popupOwners]) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && (await groupExists(rec.groupId))) continue;
        popupOwners.delete(tabId);
        pruned = true;
      }
      if (pruned) persist();
    })();
  }
  return loading;
}

function persist() {
  persisting = persisting
    .then(() => chrome.storage.session.set({ [STORE_KEY]: Object.fromEntries(popupOwners) }))
    .catch(() => {});
  return persisting;
}

// --- Classification --------------------------------------------------------------------------

// Whether this tab is one an agent may only reach through adoption: ungrouped, and alone in a window
// Chromium will not let it be grouped in or moved out of.
export async function isAdoptableWindow(tab) {
  if (!tab || tab.groupId !== TAB_GROUP_NONE) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return !!win && ADOPTABLE_WINDOW_TYPES.has(win.type);
}

// --- Attribution -----------------------------------------------------------------------------

// Walks openerTabId until it reaches a grouped tab. Returns { groupId, openerTabId } or null.
async function walkOpeners(tab) {
  const seen = new Set([tab.id]);
  let nextId = tab.openerTabId;
  for (let hop = 0; nextId != null && hop < MAX_CHAIN; hop++) {
    if (seen.has(nextId)) break;
    seen.add(nextId);
    const opener = await chrome.tabs.get(nextId).catch(() => null);
    if (!opener) break;
    if (opener.groupId !== TAB_GROUP_NONE) {
      return (await groupExists(opener.groupId)) ? { groupId: opener.groupId, openerTabId: opener.id } : null;
    }
    // An intermediate popup that was seen earlier still names its group after Chromium cleared ITS
    // openerTabId, which is the only thing that survives the opener of a chain closing.
    const known = popupOwners.get(opener.id);
    if (validRecord(known) && (await groupExists(known.groupId))) {
      return { groupId: known.groupId, openerTabId: opener.id };
    }
    if (!(await isAdoptableWindow(opener))) break;
    nextId = opener.openerTabId;
  }
  return null;
}

// The tab group an adoptable tab belongs to, or null when it cannot be attributed — which is the case
// for a popup the human opened from their own tab, and which must stay off-limits exactly like an
// ungrouped tab. Records what it learns, so the answer outlives the opener.
export async function ownerGroupId(tab) {
  await loadOwners();
  const known = popupOwners.get(tab.id);
  if (validRecord(known)) {
    // A record must never resurrect a group Chrome destroyed with its last tab.
    if (await groupExists(known.groupId)) return known.groupId;
    popupOwners.delete(tab.id);
    persist();
  }
  const walked = await walkOpeners(tab);
  if (!walked) return null;
  popupOwners.set(tab.id, walked);
  await persist();
  return walked.groupId;
}

// tabs.onCreated: record the attribution while both of its sources are still alive. Returns the owner
// group id when the tab was adopted, else null, so the caller can hand focus back for that case only.
export async function noteOpened(tab) {
  if (!(await isAdoptableWindow(tab))) return null;
  return ownerGroupId(tab);
}

// Every popup of a group that is confirmed gone. Called from the group's CONFIRMED-removal path, never
// from the bare onRemoved: a group moved to another window fires onRemoved and then onCreated under the
// same id, and dropping the records there would un-adopt every popup of a group the human dragged. A
// record that outlived its group would, if Chromium ever reissued that group id, hand the popup to
// whoever holds the new group — a change of owner with no error anywhere.
export async function forgetGroup(groupId) {
  await loadOwners();
  const id = Number(groupId);
  let dropped = false;
  for (const [tabId, rec] of [...popupOwners]) {
    if (rec.groupId === id) {
      popupOwners.delete(tabId);
      dropped = true;
    }
  }
  if (dropped) await persist();
}

export async function forget(tabId) {
  await loadOwners();
  if (popupOwners.delete(Number(tabId))) await persist();
}

// --- Lookup ----------------------------------------------------------------------------------

// Every adopted popup tab in the browser, bucketed by owner group id. Read-only: the opener walk
// reads tabs and windows and attaches nothing, so listing still never touches a tab.
export async function adoptedByGroup() {
  await loadOwners();
  let windows = [];
  try {
    windows = await chrome.windows.getAll({ windowTypes: ["popup"], populate: true });
  } catch {
    return new Map();
  }
  const byGroup = new Map();
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.groupId !== TAB_GROUP_NONE) continue;
      const groupId = await ownerGroupId(tab);
      if (groupId == null) continue;
      let list = byGroup.get(groupId);
      if (!list) byGroup.set(groupId, (list = []));
      list.push(tab);
    }
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.id - b.id);
  return byGroup;
}

// The adopted popups of one group, in tab-id order.
export async function adoptedFor(groupId) {
  return (await adoptedByGroup()).get(Number(groupId)) || [];
}
