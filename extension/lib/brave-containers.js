// Brave temporary containers: the one non-UI way to open a tab in one, and the probe that proves a tab
// is still in it. Verified live against Brave 1.95 (Chromium 153); every function here is fail-closed —
// a tab is only handed out after its own cookie jar was read through its own debugger session.
//
// Why a relaunch: no extension, CDP or URL API creates a container. Brave's `--temporary-container
// --container=<name> <url>` switches, relayed into the running browser through its process singleton,
// are the only path, so the native host re-execs the browser binary (host op open_temporary_container).
// The relayed tab opens ACTIVE in the last-active window and Brave's app comes to the front, and there is
// no switch for a background tab. So the previously active tab is switched back at once, the native host
// hands app focus back to whatever was in front before (host op restore_front; macOS only so far), and
// creations run one at a time: with two relays interleaved, the second tab's "previously active" tab is
// the first agent tab.
//
// Why cookies prove isolation: chrome.cookies (and CDP Storage.*) always act on the profile's DEFAULT
// jar, while CDP Network.getCookies/setCookie act on the tab's own storage partition, and no tab or
// target field reveals a container. So the default jar carries a canary a contained tab must NOT see,
// and each container carries a stamp its tabs MUST see and the default jar must not. Both cookies live
// on obprobe.localhost, a host no page ever visits, so a site can neither read nor forge them.
//
// Leaks this module guards against, all silent in Brave (no error, the tab just joins the default jar):
// a start URL of about:blank; any browser-initiated navigation TO about:blank (tabs.update or CDP);
// navigating while tab.discarded is true; chrome.tabs.create / windows.create / Target.createTarget,
// none of which inherit the opener's container.

import { ensureAttached, withTransientSession } from "./cdp.js";
import { hostRequest, portGeneration } from "./bridge.js";
import { getIdentity } from "./identity.js";
import { editTabs } from "./tab-edits.js";

const PROBE_URL = "http://obprobe.localhost/";
const CANARY = "ob_default_jar";
const STAMP = "ob_container";

const CANARY_TTL_S = 365 * 86400;
// A stamp that expired would make every later check on a healthy container tab fail, so a verified
// tab whose stamp is within a week of expiry gets it re-written (see checkIsolation).
const STAMP_TTL_S = 30 * 86400;
const STAMP_REFRESH_S = 7 * 86400;

// The relayed process exits in ~50-110 ms and the tab follows ~100 ms later; 10 s only covers a
// loaded machine. A tab that turns up after the deadline is closed, never adopted unverified.
const ARRIVAL_TIMEOUT_MS = 10000;
const LATE_ARRIVAL_MS = 20000;
// profile_dir may walk up to 4 parent processes (a PowerShell start each on Windows) and then scan
// LevelDB logs for up to 3 s; the relay op itself resolves on exit or after 10 s.
const PROFILE_TIMEOUT_MS = 12000;
const RELAY_TIMEOUT_MS = 14000;
const RELOAD_TIMEOUT_MS = 15000;
// Fire-and-forget: the answer changes nothing here, so it only bounds how long a host that never answers
// (an older one that forwards the op to the broker) keeps a pending entry.
const RESTORE_FRONT_TIMEOUT_MS = 5000;

// Mirrors (and is stricter than) the host's validation of --container=<name>: 1-80 chars, no control
// chars, no leading "-" (it would parse as a switch), no surrounding whitespace.
const CONTAINER_NAME_MAX = 80;
// Control characters, plus bidi overrides and isolates: Brave shows the container name in its own UI,
// where U+202E would make "agent-a" read as something else.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_CHARS_G = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RELOAD_HINT =
  'Reload OpenBrowser MCP at brave://extensions (this version adds the "cookies" permission) and retry.';

// --- Brand -----------------------------------------------------------------------------------

let brand = null;

export async function isBrave() {
  if (brand == null) brand = (await getIdentity()).brand;
  return brand === "Brave";
}

export async function assertBrave() {
  if (await isBrave()) return;
  throw new Error(
    `temporaryContainer is only available in Brave; this browser is ${brand}. Drop temporaryContainer ` +
      `for a plain tab group (no isolation), or call browsers_list and browser_select to use a connected ` +
      `Brave profile.`
  );
}

// --- Names and stamps ------------------------------------------------------------------------

function base64url(str) {
  let bin = "";
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validContainerName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= CONTAINER_NAME_MAX &&
    !UNSAFE_CHARS.test(name) &&
    !name.startsWith("-") &&
    name === name.trim()
  );
}

// Brave matches named temporary containers by name alone, and group names may repeat, so the nonce
// suffix is what keeps two groups both labelled "checkout" from sharing one cookie jar.
function containerNameFor(label, nonce) {
  const suffix = ` #${nonce.slice(0, 4)}`;
  const base = String(label ?? "")
    .replace(UNSAFE_CHARS_G, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-\s]+/, "")
    .trim();
  let out = "";
  // By code point, so a truncation never splits a surrogate pair into invalid UTF-16.
  for (const ch of base) {
    if (out.length + ch.length > CONTAINER_NAME_MAX - suffix.length) break;
    out += ch;
  }
  return (out.trim() || "MCP") + suffix;
}

// The stamp carries the container name so a group re-learned after a browser restart (when group ids
// and chrome.storage.session are both gone) can still name its container.
function makeStamp(nonce, containerName) {
  return `${nonce}.${base64url(containerName)}`;
}

export function parseStamp(value) {
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const nonce = value.slice(0, dot);
  const encoded = value.slice(dot + 1);
  if (!UUID_RE.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const containerName = fromBase64url(encoded);
    return validContainerName(containerName) ? { stamp: value, containerName } : null;
  } catch {
    return null;
  }
}

// Non-ASCII too: a data: page without a charset decodes as windows-1252, so a UTF-8 "·" in the
// group name would show as "Â·" in the tab strip until the agent navigates.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']|[^\x20-\x7e]/gu, (c) => `&#${c.codePointAt(0)};`);
}

// data:, never about:blank: an about:blank start URL lands in the default partition, and
// about:blank#<nonce> is dropped entirely in favour of a plain new window. The nonce rides in a
// comment so the tab can be matched on its pendingUrl in the very first onCreated event.
function bootstrapUrl(label, nonce) {
  return "data:text/html," + encodeURIComponent(`<title>${escapeHtml(label)}</title><!--ob:${nonce}-->`);
}

// --- Cookie jar probe ------------------------------------------------------------------------

// Idempotent, and run before every creation rather than once: the human can clear cookies at any time,
// and with no canary in the default jar a leaked tab would read as contained.
export async function ensureCanary() {
  if (!chrome.cookies?.set) {
    throw new Error(`chrome.cookies is unavailable, so no container tab can be verified. ${RELOAD_HINT}`);
  }
  let cookie;
  try {
    cookie = await chrome.cookies.set({
      url: PROBE_URL,
      name: CANARY,
      value: "1",
      expirationDate: Math.floor(Date.now() / 1000) + CANARY_TTL_S,
    });
  } catch (e) {
    throw new Error(`Could not set the default-jar canary cookie on ${PROBE_URL}: ${e?.message || e}`);
  }
  if (!cookie) {
    throw new Error(
      `Could not set the default-jar canary cookie on ${PROBE_URL}` +
        `${chrome.runtime.lastError ? `: ${chrome.runtime.lastError.message}` : ""}.`
    );
  }
}

// Network.getCookies runs in the tab's own partition; it needs no Network.enable. probe: the tab may be
// one no tool goes on to use (the human's tab named only to classify its group), so a tab cdp.js does not
// hold yet is read through a transient session instead of a kept, viewport-pinned one.
async function readJar(tabId, { probe = false } = {}) {
  const read = async () => {
    const res = await chrome.debugger.sendCommand({ tabId }, "Network.getCookies", { urls: [PROBE_URL] });
    return new Map((res?.cookies || []).map((c) => [c.name, c]));
  };
  if (probe) return withTransientSession(tabId, read);
  await ensureAttached(tabId);
  return read();
}

async function writeStamp(tabId, stamp) {
  await chrome.debugger.sendCommand({ tabId }, "Network.setCookie", {
    url: PROBE_URL,
    name: STAMP,
    value: stamp,
    expires: Math.floor(Date.now() / 1000) + STAMP_TTL_S,
  });
}

// Any navigation issued while a tab is discarded — tabs.update, or a debugger attach plus
// Page.navigate — silently lands it in the default jar, and activation alone is no fix (status was
// still "unloaded" 500 ms after it). chrome.tabs.reload keeps the container, so reload and wait before
// anything touches the tab. "unloaded" covers session-restored tabs that were never loaded, which are
// not flagged discarded but were not shown to behave any differently.
export async function wakeTab(tab) {
  if (!tab.discarded && tab.status !== "unloaded") return tab;
  const tabId = tab.id;
  let completed = false;
  await new Promise((resolve, reject) => {
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId || info.status !== "complete") return;
      completed = true;
      stop();
      resolve();
    };
    const onRemoved = (id) => {
      if (id !== tabId) return;
      stop();
      reject(new Error(`tab ${tabId} was closed while it reloaded`));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // Only bounds the wait; whether the reload got far enough is decided below.
    timer = setTimeout(() => {
      stop();
      resolve();
    }, RELOAD_TIMEOUT_MS);
    chrome.tabs.reload(tabId).catch((e) => {
      stop();
      reject(new Error(`tab ${tabId} is discarded and could not be reloaded: ${e?.message || e}`));
    });
  });
  const fresh = await chrome.tabs.get(tabId);
  if (fresh.discarded || fresh.status === "unloaded") {
    throw new Error(`tab ${tabId} is discarded and did not reload within ${RELOAD_TIMEOUT_MS / 1000} s`);
  }
  // Until the reload commits, the debugger can still be reading the discarded placeholder, which sits in
  // the default jar whatever the tab's container: a probe then would call a healthy container tab leaked,
  // or record its group as plain for good. A slow server (TTFB past the timeout) is enough for that. Only
  // the timeout path: a reload seen reaching "complete" has committed, and a page that redirects on load
  // is "loading" again by the time of this read, which would fail a healthy tab with a false message.
  if (!completed && fresh.status !== "complete") {
    throw new Error(
      `tab ${tabId} was discarded and is still reloading after ${RELOAD_TIMEOUT_MS / 1000} s (a discarded tab ` +
        `is reloaded before anything touches it), so it cannot be used until it has loaded`
    );
  }
  return fresh;
}

// The per-call gate for a tab of a known container group. Returns { tab, reason }: reason is null only
// when the tab (reloaded first if it was discarded; a no-op when the caller already woke it) reads its
// own container's jar right now.
export async function checkIsolation(tab, stamp) {
  if (tab.incognito) return { tab, reason: "it is an incognito tab" };
  try {
    tab = await wakeTab(tab);
  } catch (e) {
    return { tab, reason: e.message };
  }
  let jar;
  try {
    jar = await readJar(tab.id);
  } catch (e) {
    return { tab, reason: `its cookie jar could not be read through the debugger: ${e?.message || e}` };
  }
  if (jar.has(CANARY)) return { tab, reason: "it now reads the profile's default cookie jar" };
  const mine = jar.get(STAMP);
  if (!mine) {
    return { tab, reason: "its container stamp is gone, so it is in another container or its cookies were cleared" };
  }
  if (mine.value !== stamp) return { tab, reason: "it carries a different container's stamp" };
  if (mine.expires > 0 && mine.expires - Date.now() / 1000 < STAMP_REFRESH_S) {
    try {
      await writeStamp(tab.id, stamp);
    } catch {}
  }
  return { tab, reason: null };
}

// Lazy re-learning for a group with no record (after a browser restart or an extension reload): a
// valid stamp and no canary make it a container group; a readable jar without both makes it plain.
// null when the jar cannot be read at all (a browser-internal page, another debugger attached), so the
// caller can neither record nor trust anything. The tab must already be awake (wakeTab).
export async function learnContainer(tabId) {
  let jar;
  try {
    jar = await readJar(tabId, { probe: true });
  } catch {
    return null;
  }
  const parsed = parseStamp(jar.get(STAMP)?.value);
  return parsed && !jar.has(CANARY) ? { container: parsed } : { container: null };
}

// For callers about to use the service worker's own network stack, which always carries the DEFAULT
// jar: true only when the tab provably reads that same jar. Throws when the jar cannot be read.
export async function readsDefaultJar(tabId) {
  await ensureCanary();
  return (await readJar(tabId, { probe: true })).has(CANARY);
}

// --- Native host ops -------------------------------------------------------------------------

// The host only relays into the profile directory it found for THIS native host process, so the cache
// follows the port: a reconnect means a new host process that has not resolved anything yet, and its
// open_temporary_container would refuse to run.
let profile = null; // { generation, info }

async function ensureProfile() {
  const generation = portGeneration();
  if (profile?.generation === generation) return profile.info;

  // The host finds this profile by scanning every profile's extension-settings LevelDB log for a
  // nonce only this profile just wrote. Without --profile-directory the relay goes to whichever
  // profile was used last, and a wrong name silently CREATES a new profile.
  const nonce = crypto.randomUUID();
  try {
    await chrome.storage.local.set({ obProfileNonce: nonce });
  } catch (e) {
    throw new Error(`Could not write the profile nonce to chrome.storage.local: ${e?.message || e}`);
  }
  let info;
  try {
    info = await hostRequest("profile_dir", { nonce }, { timeoutMs: PROFILE_TIMEOUT_MS });
  } catch (e) {
    throw new Error(`The native host could not identify this Brave profile's directory: ${e.message}`);
  }
  if (info.brand && info.brand !== "Brave") {
    throw new Error(
      `temporaryContainer is only available in Brave, but the native host's browser process is ` +
        `${info.brand}${info.binary ? ` (${info.binary})` : ""}.`
    );
  }
  if (typeof info.profileDir !== "string" || !info.profileDir) {
    throw new Error("The native host answered profile_dir without a profile directory.");
  }
  profile = { generation, info };
  return info;
}

async function activeTabsByWindow() {
  const map = new Map();
  try {
    for (const t of await chrome.tabs.query({ active: true })) map.set(t.windowId, t.id);
  } catch {}
  return map;
}

// Matches on the nonce in pendingUrl, never on openerTabId (the relay sets that to whatever tab was
// active). Listeners go in before the relay is sent: the tab event can beat the host's reply. Resolves
// with { tab, back }: back settles once the window has been switched back to the opener (or that was not
// needed or failed), so a later check never issues a second tabs.update for the same switch.
function awaitTabWithNonce(nonce, restoreKey) {
  let state = "waiting"; // -> "found" | "late"
  let timer = null;
  let lateTimer = null;
  let resolve;
  let reject;
  const closed = new Set();
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});

  const stop = () => {
    clearTimeout(timer);
    clearTimeout(lateTimer);
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
  const hit = (tab) => {
    if (!tab || !(tab.pendingUrl || tab.url || "").includes(nonce)) return;
    if (state === "waiting") {
      state = "found";
      stop();
      // Both from this listener, before anything is awaited: exp2 measured the relayed tab active for
      // 6-19 ms and Brave frontmost for 20-42 ms this way, and every await in front adds its length to
      // both. App focus goes first — keystrokes meant for the human's editor landing in their Brave tab
      // is the worse half — and only now that the tab exists: the relay process exits before Brave
      // activates for the tab, so a hand-back on relay exit would be undone.
      hostRequest("restore_front", { restoreKey }, { timeoutMs: RESTORE_FRONT_TIMEOUT_MS }).catch(() => {});
      const back =
        tab.active && tab.openerTabId != null
          ? editTabs(() => chrome.tabs.update(tab.openerTabId, { active: true })).then(
              () => true,
              () => false
            )
          : Promise.resolve(false);
      resolve({ tab, back });
    } else if (state === "late" && !closed.has(tab.id)) {
      // Nobody is waiting for this tab any more, so nobody would verify it: close it.
      closed.add(tab.id);
      editTabs(() => chrome.tabs.remove(tab.id)).catch(() => {});
    }
  };
  const onCreated = (tab) => hit(tab);
  const onUpdated = (_id, _info, tab) => hit(tab);
  const goLate = (why) => {
    if (state !== "waiting") return;
    state = "late";
    clearTimeout(timer);
    lateTimer = setTimeout(stop, LATE_ARRIVAL_MS);
    reject(new Error(why));
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  timer = setTimeout(() => goLate("timeout"), ARRIVAL_TIMEOUT_MS);
  return { promise, abandon: () => goLate("abandoned") };
}

// The relayed tab is active in its window. Switch that window back to the tab that was active before,
// but only while the new tab is still the active one: if the human already moved on, leave it alone.
async function restoreActive(tabId, openerTabId, before) {
  let current;
  try {
    current = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!current.active) return;
  for (const candidate of [openerTabId, current.openerTabId, before.get(current.windowId)]) {
    if (candidate == null || candidate === tabId) continue;
    try {
      const back = await chrome.tabs.get(candidate);
      if (back.windowId !== current.windowId) continue;
      await editTabs(() => chrome.tabs.update(candidate, { active: true }));
      return;
    } catch {}
  }
}

async function relay({ nonce, containerName, reuse }) {
  const url = bootstrapUrl(containerName, nonce);
  // Fresh per relay: the host records the app in front under it just before spawning, and restore_front
  // (sent when the tab arrives) hands focus back to exactly that app.
  const restoreKey = crypto.randomUUID();
  const before = await activeTabsByWindow();
  const arrival = awaitTabWithNonce(nonce, restoreKey);

  let sent;
  try {
    sent = await hostRequest(
      "open_temporary_container",
      { url, containerName, reuse: !!reuse, restoreKey },
      { timeoutMs: RELAY_TIMEOUT_MS }
    );
  } catch (e) {
    arrival.abandon();
    // The host can fail after Brave already took the relay (the relay outlived its 10 s, the port
    // dropped), so the tab may be here: unverified, ungrouped and active in the human's window. Switch
    // back and close it, and before returning — the next queued relay snapshots the active tabs and
    // would take this one for the human's. A tab still on its way is closed by the late handler.
    await arrival.promise
      .then(async ({ tab, back }) => {
        await back;
        await restoreActive(tab.id, tab.openerTabId, before);
        await editTabs(() => chrome.tabs.remove(tab.id));
      })
      .catch(() => {});
    throw new Error(`The native host could not relay the tab into Brave: ${e.message}`);
  }

  let tab;
  let back;
  try {
    ({ tab, back } = await arrival.promise);
  } catch {
    throw new Error(
      `The native host relayed into Brave (exit code ${sent.exitCode ?? "none"}` +
        `${sent.relayed ? "" : ', and Brave did not report "Opening in existing browser session"'}) but no ` +
        `tab for it appeared in this profile within ${ARRIVAL_TIMEOUT_MS / 1000} s, so it may have gone to ` +
        `another profile or Brave instance. Retry; if it keeps failing, restart Brave so the native host ` +
        `re-resolves the browser process and profile.`
    );
  }
  // Before anything else: every millisecond the relayed tab stays active is the human's view stolen. The
  // arrival listener already switched to the opener; this covers a tab that came without one.
  await back;
  await restoreActive(tab.id, tab.openerTabId, before);
  return { tab, before };
}

// One relay at a time: restoring the previously active tab is only right when no other relay's tab
// arrived in between.
let chain = Promise.resolve();

function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// --- Creation --------------------------------------------------------------------------------

// A tab in a brand-new temporary container, stamped and verified, and no longer active. The caller
// groups it. Any failure closes the tab: an unverified tab is never handed out.
export function newContainerTab(label) {
  return serialized(async () => {
    await ensureCanary();
    await ensureProfile();
    const nonce = crypto.randomUUID();
    const containerName = containerNameFor(label, nonce);
    const stamp = makeStamp(nonce, containerName);
    const { tab, before } = await relay({ nonce, containerName, reuse: false });

    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.incognito) throw new Error("it opened in an incognito window");
      if (t.discarded) throw new Error("it was discarded before it could be checked");
      const jar = await readJar(t.id);
      if (jar.has(CANARY)) throw new Error("it reads the profile's default cookie jar, so Brave did not contain it");
      if (jar.has(STAMP)) throw new Error("its jar already holds a container stamp, so the container is not new");
      await writeStamp(t.id, stamp);
      const again = await readJar(t.id);
      if (again.get(STAMP)?.value !== stamp) throw new Error("the container stamp did not stick in its cookie jar");
      if (again.has(CANARY)) throw new Error("it reads the profile's default cookie jar");
      if (await chrome.cookies.get({ url: PROBE_URL, name: STAMP })) {
        throw new Error("the container stamp showed up in the profile's default cookie jar");
      }
      // The relay may activate the tab after onCreated; check once more now that the tab is settled.
      await restoreActive(t.id, t.openerTabId, before);
      return { tab: await chrome.tabs.get(t.id), stamp, containerName };
    } catch (e) {
      await editTabs(() => chrome.tabs.remove(tab.id)).catch(() => {});
      throw new Error(
        `The tab Brave opened for a new temporary container failed its isolation check and was closed ` +
          `(${e?.message || e}). Retry tabs_create_mcp, or drop temporaryContainer for a plain, unisolated group.`
      );
    }
  });
}

// One more tab in an existing container, reusing it by name (--container=<name> with reuse), verified
// by the group's stamp instead of a new one. Kept to this one function so a relay-free inheritance path
// can replace it: chrome.tabs.duplicate of a group tab inherits the container without activating the app
// (window.open and target=_blank inherit it too, but activate Brave just like the relay does).
export function newTabInContainer({ stamp, containerName }) {
  return serialized(async () => {
    await ensureCanary();
    await ensureProfile();
    const { tab, before } = await relay({ nonce: crypto.randomUUID(), containerName, reuse: true });

    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.incognito) throw new Error("it opened in an incognito window");
      if (t.discarded) throw new Error("it was discarded before it could be checked");
      const jar = await readJar(t.id);
      if (jar.has(CANARY)) throw new Error("it reads the profile's default cookie jar");
      const got = jar.get(STAMP)?.value;
      if (got !== stamp) {
        throw new Error(
          got
            ? "it carries a different container's stamp"
            : "its jar has no container stamp, so Brave opened a new container under that name instead of reusing it"
        );
      }
      await restoreActive(t.id, t.openerTabId, before);
      return await chrome.tabs.get(t.id);
    } catch (e) {
      await editTabs(() => chrome.tabs.remove(tab.id)).catch(() => {});
      throw new Error(
        `The tab Brave opened for temporary container "${containerName}" is not in that container and was ` +
          `closed (${e?.message || e}). Create a new group with tabs_create_mcp({group, temporaryContainer: true}).`
      );
    }
  });
}
