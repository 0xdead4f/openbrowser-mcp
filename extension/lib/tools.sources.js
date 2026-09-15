// sources_list / sources_download — the DevTools Sources tree over CDP, and the bytes behind it.
// Holding the debugger permission is the whole advantage here: the tree is the browser's actual
// resource tree instead of a DOM sweep, and the bytes come from the renderer's own cache first.

import { cdp, ensureDomain } from "./cdp.js";
import { knownRecord } from "./contexts.js";
import { isBrave, readsDefaultJar } from "./brave-containers.js";
import { observedUrls } from "./net.js";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const FETCH_POOL = 6;

// A sourcemap can carry thousands of sources; they get their own budget so unpacking one bundle
// cannot silently consume the whole maxFiles allowance meant for real resources.
const MAX_SOURCEMAP_FILES = 2000;

// 384 KiB raw. A multiple of 3, so each piece base64s standalone rather than only being valid
// after concatenation on the far side.
const RAW_CHUNK = 393216;

const MAX_TRACKED_TABS = 8;
const MAX_TRACKED_REQUESTS = 400;

// Assets are listed but not downloaded by default — 300 slots of webp is not what recon wants.
const ASSET_TYPES = new Set(["image", "font", "media", "texttrack"]);

// Ported from CSA's noise list. Matched as an exact host or a dot-suffix, never a substring:
// "stripe.com" must not swallow "notstripe.com".
const NOISE_HOSTS = [
  "googletagmanager.com", "google-analytics.com", "googleadservices.com", "googlesyndication.com",
  "doubleclick.net", "gstatic.com", "fonts.googleapis.com", "adservice.google.com",
  "facebook.com", "facebook.net", "fbcdn.net",
  "js.stripe.com", "m.stripe.com", "m.stripe.network",
  "sentry.io", "sentry-cdn.com", "ingest.sentry.io",
  "segment.com", "segment.io", "mixpanel.com", "amplitude.com", "heap.io", "heapanalytics.com",
  "hotjar.com", "hotjar.io", "fullstory.com", "logrocket.com", "logrocket.io", "mouseflow.com",
  "crazyegg.com", "clarity.ms", "quantserve.com", "scorecardresearch.com", "chartbeat.com",
  "newrelic.com", "nr-data.net", "datadoghq.com", "datadoghq.eu", "bugsnag.com", "rollbar.com",
  "cloudflareinsights.com", "optimizely.com", "launchdarkly.com",
  "bat.bing.com", "ads-twitter.com", "analytics.twitter.com", "snap.licdn.com",
  "analytics.tiktok.com", "ct.pinterest.com", "criteo.com", "criteo.net", "adroll.com",
  "adobedtm.com", "omtrdc.net", "demdex.net", "everesttech.net",
  "intercom.io", "intercomcdn.com", "hs-scripts.com", "hs-analytics.net", "hubspot.com",
  "zendesk.com", "zdassets.com", "drift.com", "tawk.to", "olark.com", "livechatinc.com",
  "onesignal.com", "klaviyo.com", "braze.com", "appboycdn.com",
  "cookielaw.org", "onetrust.com", "cookiebot.com", "usercentrics.eu", "trustarc.com",
];

// --- Per-tab collection state -------------------------------------------------------------

const trees = new Map(); // tabId -> { loaderId, origin, pageUrl, resources: Map, scripts: Map, dynamic }
const requests = new Map(); // tabId -> Map(url -> { requestId, status, mimeType })

// Network events land here whether or not a tree has been collected yet, because tier 3 of the
// ladder needs the requestId that was minted long before the agent asked for sources.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !params) return;

  if (method === "Network.responseReceived") {
    let byUrl = requests.get(tabId);
    if (!byUrl) requests.set(tabId, (byUrl = new Map()));
    byUrl.delete(params.response?.url);
    byUrl.set(params.response?.url, {
      requestId: params.requestId,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
    });
    while (byUrl.size > MAX_TRACKED_REQUESTS) byUrl.delete(byUrl.keys().next().value);
    return;
  }

  if (method === "Debugger.scriptParsed") {
    const entry = trees.get(tabId);
    if (!entry) return;
    const url = params.url || "";
    if (url.startsWith("chrome-extension://") || url.startsWith("extensions::")) return;
    entry.scripts.set(params.scriptId, {
      scriptId: params.scriptId,
      url,
      sourceMapURL: params.sourceMapURL || null,
      hasSourceURL: !!params.hasSourceURL,
    });
    return;
  }

  // Only a cross-document navigation of the main frame invalidates; a same-document one keeps
  // both the tree and the requestId map usable.
  if (method === "Page.frameNavigated" && !params.frame?.parentId) {
    const entry = trees.get(tabId);
    if (entry && entry.loaderId !== params.frame?.loaderId) {
      trees.delete(tabId);
      requests.delete(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  trees.delete(tabId);
  requests.delete(tabId);
});

function setTree(tabId, entry) {
  trees.delete(tabId);
  trees.set(tabId, entry);
  while (trees.size > MAX_TRACKED_TABS) trees.delete(trees.keys().next().value);
}

// --- Helpers ------------------------------------------------------------------------------

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "blob:") return hostOf(u.pathname);
    return u.host || u.protocol.replace(":", "");
  } catch {
    return "(unknown)";
  }
}

function isNoise(host) {
  return NOISE_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

function formatSize(n) {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${trim(n / 1024)} KB`;
  return `${trim(n / (1024 * 1024))} MB`;
}

function trim(v) {
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + " " : s.padEnd(n);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? " " + s : s.padStart(n);
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter((x) => x != null).map(String) : [String(v)];
}

// Candidates are what a glob is tested against: an agent writes "**/main.*.js" thinking of the
// path, "*.map" thinking of the basename, and sometimes the whole URL.
function candidates(item) {
  const base = item.path.split("/").pop();
  return [item.url, `${item.host}/${item.path}`, item.path, base];
}

function matchesAny(patterns, item) {
  if (!patterns.length) return false;
  const cands = candidates(item);
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return cands.some((c) => re.test(c));
  });
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function bytesToBase64(bytes) {
  const parts = [];
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
  }
  return btoa(parts.join(""));
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

async function targetTab(args) {
  if (args.tabId != null) {
    try {
      return await chrome.tabs.get(Number(args.tabId));
    } catch {
      throw new Error(`No tab with id ${args.tabId}.`);
    }
  }
  // Not restricted to tab groups: pointing at a tab the user opened and logged into is the point of
  // these two tools. With several agents' groups open there is no "own" group to prefer, so the
  // default is simply the tab the human is looking at.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("No tab to read sources from — pass tabId.");
  return active;
}

// --- Collection ---------------------------------------------------------------------------

async function collectTree(tabId, { dynamic = false } = {}) {
  await ensureDomain(tabId, "Page").catch(() => {});
  const { frameTree } = await cdp(tabId, "Page.getResourceTree");
  const loaderId = frameTree.frame.loaderId;

  let entry = trees.get(tabId);
  if (entry && entry.loaderId !== loaderId) entry = null;
  if (!entry) {
    entry = {
      loaderId,
      origin: hostOf(frameTree.frame.url),
      pageUrl: frameTree.frame.url,
      resources: new Map(),
      scripts: new Map(),
      dynamic: false,
    };
    setTree(tabId, entry);
  }

  // The resource tree is cheap and authoritative, so it is rebuilt every call; scriptParsed
  // accumulations survive because they are the half CDP will not replay on demand.
  entry.resources = new Map();
  walkFrame(frameTree, entry);

  if (dynamic && !entry.dynamic) {
    await ensureDomain(tabId, "Debugger");
    entry.dynamic = true;
    // Debugger.enable replays scriptParsed for everything already parsed, so the dynamic set is
    // complete a beat after enabling rather than only for scripts parsed from here on.
    await new Promise((r) => setTimeout(r, 400));
  }
  return entry;
}

function walkFrame(node, entry) {
  const frame = node.frame || {};
  if (frame.url && /^(https?|file):/.test(frame.url)) {
    entry.resources.set(frame.url, {
      url: frame.url,
      type: "Document",
      mimeType: frame.mimeType || "text/html",
      size: null,
      frameId: frame.id,
    });
  }
  for (const r of node.resources || []) {
    if (!r.url || entry.resources.has(r.url)) continue;
    if (r.url.startsWith("chrome-extension://")) continue;
    entry.resources.set(r.url, {
      url: r.url,
      type: r.type || "Other",
      mimeType: r.mimeType || "",
      size: r.contentSize ?? null,
      frameId: frame.id,
    });
  }
  for (const child of node.childFrames || []) walkFrame(child, entry);
}

// Flatten the tree plus the dynamic scripts into one list of listable/downloadable items.
function itemsOf(entry) {
  const out = [];
  const byUrl = new Map();

  for (const r of entry.resources.values()) {
    const item = {
      url: r.url,
      type: String(r.type).toLowerCase(),
      mimeType: r.mimeType,
      size: r.size,
      frameId: r.frameId,
      scriptId: null,
      sourceMapURL: null,
      host: hostOf(r.url),
      path: pathOf(r.url),
      dynamic: false,
    };
    item.noise = isNoise(item.host);
    out.push(item);
    byUrl.set(r.url, item);
  }

  const inlineSeq = new Map(); // document url -> count
  let dynamicSeq = 0;

  for (const s of entry.scripts.values()) {
    const known = byUrl.get(s.url);
    if (known && known.type !== "document") {
      // Same file the resource tree already listed — the only new information is the sourcemap.
      known.sourceMapURL = known.sourceMapURL || s.sourceMapURL;
      known.scriptId = known.scriptId || s.scriptId;
      continue;
    }

    let host;
    let path;
    let url;
    if (known) {
      // url equals a document url: this is an inline <script> inside that document.
      const n = (inlineSeq.get(s.url) || 0) + 1;
      inlineSeq.set(s.url, n);
      const doc = known.path.split("/").pop() || "index.html";
      host = known.host;
      path = `_inline/${doc}.script-${n}.js`;
      url = `${s.url}#script-${n}`;
    } else if (s.url && /^(https?|file):/.test(s.url)) {
      host = hostOf(s.url);
      path = pathOf(s.url);
      url = s.url;
    } else {
      // blob:, data:, eval'd, or no URL at all — code that exists only in the VM.
      const n = ++dynamicSeq;
      host = s.url ? hostOf(s.url) : entry.origin;
      path = `_dynamic/script-${n}.js`;
      url = s.url || `dynamic://script-${s.scriptId}`;
    }

    const item = {
      url,
      type: "script",
      mimeType: "application/javascript",
      size: null,
      frameId: null,
      scriptId: s.scriptId,
      sourceMapURL: s.sourceMapURL || null,
      host,
      path,
      dynamic: true,
    };
    item.noise = isNoise(item.host);
    out.push(item);
  }

  return out;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/^\/+/, "");
    if (p === "" || p.endsWith("/")) p += "index.html";
    return p;
  } catch {
    return url.replace(/^[a-z]+:\/*/i, "") || "index.html";
  }
}

// --- sources_list -------------------------------------------------------------------------

function applyListFilters(items, { origin, glob, type }) {
  const globs = asArray(glob);
  const types = asArray(type).map((t) => t.toLowerCase());
  const originNeedle = origin ? String(origin).toLowerCase() : null;
  return items.filter((it) => {
    if (originNeedle && !it.host.toLowerCase().includes(originNeedle)) return false;
    if (types.length && !types.includes(it.type)) return false;
    if (globs.length && !matchesAny(globs, it)) return false;
    return true;
  });
}

function groupByOrigin(items, pageOrigin) {
  const groups = new Map();
  for (const it of items) {
    let g = groups.get(it.host);
    if (!g) groups.set(it.host, (g = { host: it.host, items: [], bytes: 0, noise: isNoise(it.host) }));
    g.items.push(it);
    g.bytes += it.size || 0;
  }
  return Array.from(groups.values()).sort((a, b) => {
    const pa = a.host === pageOrigin;
    const pb = b.host === pageOrigin;
    if (pa !== pb) return pa ? -1 : 1;
    if (a.noise !== b.noise) return a.noise ? 1 : -1;
    return b.bytes - a.bytes || a.host.localeCompare(b.host);
  });
}

function makeNode() {
  return { dirs: new Map(), files: [] };
}

function buildTrie(items) {
  const root = makeNode();
  for (const it of items) {
    const segs = it.path.split("/").filter(Boolean);
    const name = segs.pop() || "index.html";
    let node = root;
    for (const seg of segs) {
      let next = node.dirs.get(seg);
      if (!next) node.dirs.set(seg, (next = makeNode()));
      node = next;
    }
    node.files.push({ name, item: it });
  }
  return root;
}

function fileLabel(name, item) {
  // DevTools shows the document at a directory root as (index); it is never a real filename.
  if (name === "index.html" && item.type === "document" && !/index\.html$/i.test(item.url)) return "(index)";
  return name;
}

// Synthetic buckets sort last so the real tree reads first.
function dirOrder(a, b) {
  const sa = a.startsWith("_") ? 1 : 0;
  const sb = b.startsWith("_") ? 1 : 0;
  return sa - sb || a.localeCompare(b);
}

function renderNode(node, depth, prefix, out, budget) {
  const indent = "  ".repeat(depth);

  for (const f of node.files.sort((a, b) => fileLabel(a.name, a.item).localeCompare(fileLabel(b.name, b.item)))) {
    if (budget.left <= 0) {
      budget.dropped++;
      continue;
    }
    budget.left--;
    const it = f.item;
    const map = it.sourceMapURL ? `   ↪ ${it.sourceMapURL.slice(0, 5) === "data:" ? "inline map" : it.sourceMapURL.split("/").pop()}` : "";
    out.push(pad(indent + prefix + fileLabel(f.name, it), 39) + pad(it.type, 12) + padLeft(formatSize(it.size), 10) + map);
    prefix = "";
  }

  const dirs = Array.from(node.dirs.keys()).sort(dirOrder);
  for (const name of dirs) {
    let child = node.dirs.get(name);
    let label = prefix + name + "/";
    // Collapse single-child directories the way the DevTools Sources panel does.
    while (child.files.length === 0 && child.dirs.size === 1) {
      const only = child.dirs.keys().next().value;
      label += only + "/";
      child = child.dirs.get(only);
    }
    if (budget.left > 0) out.push(indent + label);
    renderNode(child, depth + 1, "", out, budget);
    prefix = "";
  }
}

function renderTree(items, pageOrigin, maxEntries) {
  const groups = groupByOrigin(items, pageOrigin);
  const budget = { left: maxEntries, dropped: 0 };
  const lines = [];

  for (const g of groups) {
    if (budget.left <= 0) {
      budget.dropped += g.items.length;
      continue;
    }
    lines.push(
      pad(g.host + "/", 54) +
        padLeft(`${g.items.length} file${g.items.length === 1 ? "" : "s"}`, 10) +
        padLeft(formatSize(g.bytes), 10) +
        (g.noise ? "   [noise]" : "")
    );
    renderNode(buildTrie(g.items), 1, "", lines, budget);
  }

  if (budget.dropped > 0) lines.push(`… ${budget.dropped} more, narrow with origin/glob`);
  return lines.join("\n");
}

// --- Content-resolution ladder --------------------------------------------------------------

function recordedResponse(tabId, url) {
  return requests.get(tabId)?.get(url) || null;
}

async function fromResourceTree(tabId, item) {
  if (!item.frameId || !/^(https?|file):/.test(item.url)) return null;
  const res = await cdp(tabId, "Page.getResourceContent", { frameId: item.frameId, url: item.url });
  if (res?.content == null) return null;
  return { bytes: res.base64Encoded ? base64ToBytes(res.content) : textToBytes(res.content), source: "resourceTree" };
}

async function fromDebugger(tabId, item) {
  if (!item.scriptId) return null;
  const res = await cdp(tabId, "Debugger.getScriptSource", { scriptId: item.scriptId });
  if (res?.scriptSource == null) return null;
  return { bytes: textToBytes(res.scriptSource), source: "debugger" };
}

async function fromNetwork(tabId, item) {
  const rec = recordedResponse(tabId, item.url);
  if (!rec) return null;
  const res = await cdp(tabId, "Network.getResponseBody", { requestId: rec.requestId });
  if (res?.body == null) return null;
  return { bytes: res.base64Encoded ? base64ToBytes(res.body) : textToBytes(res.body), source: "network" };
}

// Tier 4 runs in this service worker, whose fetch always carries the profile's DEFAULT cookie jar. For
// a normal tab that is the point — it fetches as the logged-in session, which no external crawler can
// do. For a tab holding another jar it is exactly wrong: a Brave temporary container (or an incognito
// tab) would get the human's default-jar session mixed into what the agent believes is its isolated
// one. Those fetch without cookies. On Brave only a tab that provably reads the default jar keeps
// credentials, since a container tab can sit outside any known group (opened from Brave's own UI, or a
// group not yet re-learned after a restart); an unreadable jar counts as not default.
async function fetchCredentials(tab) {
  if (tab.incognito) return "omit";
  if ((await knownRecord(tab))?.container) return "omit";
  if (!(await isBrave())) return "include";
  try {
    return (await readsDefaultJar(tab.id)) ? "include" : "omit";
  } catch {
    return "omit";
  }
}

async function fromCredentialedFetch(item, allowedHosts, credentials) {
  const res = await fetch(item.url, { credentials, redirect: "follow", cache: "no-cache" });
  // redirect:"manual" would hand back an opaque response with no readable body, so the only
  // available check is on the final URL — the body is discarded if the chain left `origins`.
  const landedOn = hostOf(res.url || item.url);
  if (!allowedHosts.has(landedOn)) {
    const err = new Error(`redirected to ${landedOn}, outside origins`);
    err.blocked = true; // a refusal, not a miss — the host must not retry it and follow the same hop
    throw err;
  }
  // A 401/403/404 body is an error page, not the resource. Writing it would poison the tree with
  // something indistinguishable from real content; throwing hands the item to tier 5 instead.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    bytes: buf,
    source: credentials === "include" ? "fetch-auth" : "fetch",
    httpStatus: res.status,
    contentType: res.headers.get("content-type") || item.mimeType,
  };
}

async function resolveContent(tabId, item, allowedHosts, credentials) {
  const tiers = [
    () => fromResourceTree(tabId, item),
    () => fromDebugger(tabId, item),
    () => fromNetwork(tabId, item),
    () => fromCredentialedFetch(item, allowedHosts, credentials),
  ];
  const errors = [];
  let blocked = false;
  for (const tier of tiers) {
    try {
      const got = await tier();
      if (got) return got;
    } catch (e) {
      if (e?.blocked) blocked = true;
      errors.push(e?.message || String(e));
    }
  }
  // Tier 5 is the Node side's: report the miss and let the host retry unauthenticated.
  return { miss: true, blocked, reason: errors[errors.length - 1] || "no tier produced content" };
}

// --- Transport ----------------------------------------------------------------------------

function sendFile(ctx, meta, bytes) {
  const file = { ...meta, bytes: bytes.length };
  let seq = 0;
  let off = 0;
  do {
    const piece = bytes.subarray(off, off + RAW_CHUNK);
    off += RAW_CHUNK;
    ctx.sendChunk(ctx.requestId, { seq: seq++, final: off >= bytes.length, file, data: bytesToBase64(piece) });
  } while (off < bytes.length);
}

// --- Sourcemaps ---------------------------------------------------------------------------

const SOURCEMAP_RE = /[#@]\s*sourceMappingURL=([^\s'"*]+)/g;

function findSourceMappingURL(text) {
  SOURCEMAP_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = SOURCEMAP_RE.exec(text))) last = m[1];
  return last;
}

// webpack:///./src/App.tsx -> src/App.tsx, and no segment may escape the bundle directory.
function sourcemapPath(src) {
  let p = String(src || "unknown").replace(/^[a-zA-Z][\w+.-]*:\/\/\/?/, "");
  p = p
    .split(/[\\/]/)
    .map((s) => (s === "." ? null : /^\.+$/.test(s) ? "_" : s))
    .filter(Boolean)
    .join("/");
  return p || "unknown";
}

async function loadSourceMap(tabId, item, mapUrl, allowedHosts, credentials) {
  if (mapUrl.startsWith("data:")) {
    const comma = mapUrl.indexOf(",");
    const head = mapUrl.slice(0, comma);
    const body = mapUrl.slice(comma + 1);
    const raw = /;base64/i.test(head) ? decoder.decode(base64ToBytes(body)) : decodeURIComponent(body);
    return { url: `${item.url}.map`, json: JSON.parse(raw) };
  }
  const abs = new URL(mapUrl, item.url).href;
  if (!allowedHosts.has(hostOf(abs))) return null;
  const got = await resolveContent(
    tabId,
    { ...item, url: abs, scriptId: null, sourceMapURL: null },
    allowedHosts,
    credentials
  );
  if (got.miss) return null;
  return { url: abs, json: JSON.parse(decoder.decode(got.bytes)) };
}

// --- Concurrency --------------------------------------------------------------------------

async function pool(items, limit, worker) {
  const it = items[Symbol.iterator]();
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        for (;;) {
          const next = it.next();
          if (next.done) return;
          await worker(next.value);
        }
      })()
    );
  }
  await Promise.all(runners);
}

// --- Handlers -----------------------------------------------------------------------------

export const handlers = {
  async sources_list(args = {}) {
    const tab = await targetTab(args);
    const entry = await collectTree(tab.id, { dynamic: !!args.dynamic });

    const all = itemsOf(entry);
    const shown = applyListFilters(all, args);
    const maxEntries = Number(args.maxEntries) > 0 ? Number(args.maxEntries) : DEFAULT_MAX_ENTRIES;

    const bytes = shown.reduce((n, it) => n + (it.size || 0), 0);
    const origins = new Set(shown.map((it) => it.host)).size;
    const header =
      `tab ${tab.id} · ${entry.pageUrl}\n` +
      `${shown.length} files · ${formatSize(bytes)} · ${origins} origins` +
      (shown.length === all.length ? "" : ` (of ${all.length})`) +
      (entry.dynamic ? " · dynamic scripts included" : "");

    if (shown.length === 0) {
      return { content: [{ type: "text", text: `${header}\n\nNothing matched. Drop origin/glob/type, or reload the tab.` }] };
    }
    return { content: [{ type: "text", text: `${header}\n\n${renderTree(shown, entry.origin, maxEntries)}` }] };
  },

  async sources_download(args = {}, ctx) {
    const tab = await targetTab(args);
    // Pinning this false made ladder tier 2 (Debugger.getScriptSource) unreachable, so eval'd and
    // blob: code — the _inline/ and _dynamic/ files that only the debugger can reach — never
    // downloaded. collectTree never turns dynamic back off, so a tree already enriched by
    // sources_list({dynamic:true}) keeps its scripts either way.
    const entry = await collectTree(tab.id, { dynamic: !!args.dynamic });
    const all = itemsOf(entry);
    const credentials = await fetchCredentials(tab);

    const include = asArray(args.include);
    const exclude = asArray(args.exclude);
    const wantsEverything = include.includes("*") || include.includes("**");
    const maxFiles = Number(args.maxFiles) > 0 ? Number(args.maxFiles) : DEFAULT_MAX_FILES;
    const maxBytes = Number(args.maxBytes) > 0 ? Number(args.maxBytes) : DEFAULT_MAX_BYTES;
    const wantSourcemaps = args.sourcemaps !== false;
    const outDir = args.outDir || "./source";

    // origins is both the selector and the redirect allowlist. Unset means "every origin the page
    // actually loaded from", minus the noise hosts — unless include:["*"] asked for everything, in
    // which case the noise hosts have to enter the allowlist here or the opt-out below never fires.
    const requested = asArray(args.origins).map((o) => hostOf(/^[a-z]+:\/\//i.test(o) ? o : `https://${o}`));
    const allowedHosts = new Set(
      requested.length ? requested : all.filter((it) => wantsEverything || !it.noise).map((it) => it.host)
    );

    const skipped = { noise: 0, filtered: 0, assets: 0, capped: 0 };
    const selected = [];
    for (const it of all) {
      if (!allowedHosts.has(it.host)) {
        if (it.noise && !requested.length) skipped.noise++;
        else skipped.filtered++;
        continue;
      }
      if (it.noise && !wantsEverything && !requested.includes(it.host)) {
        skipped.noise++;
        continue;
      }
      if (exclude.length && matchesAny(exclude, it)) {
        skipped.filtered++;
        continue;
      }
      if (include.length && !wantsEverything && !matchesAny(include, it)) {
        skipped.filtered++;
        continue;
      }
      // Assets are listed by sources_list but only downloaded when a glob explicitly asks.
      if (ASSET_TYPES.has(it.type) && !include.length) {
        skipped.assets++;
        continue;
      }
      selected.push(it);
    }

    const queue = selected.slice(0, maxFiles);
    skipped.capped = selected.length - queue.length;

    const tiers = { resourceTree: 0, debugger: 0, network: 0, "fetch-auth": 0, fetch: 0 };
    const failed = [];
    const retry = [];
    const maps = { maps: 0, sources: 0, bytes: 0 };
    let written = 0;
    let bytesOut = 0;
    let stoppedOnBytes = false;

    const emit = (meta, bytes) => {
      sendFile(ctx, meta, bytes);
      written++;
      bytesOut += bytes.length;
    };

    await pool(queue, FETCH_POOL, async (item) => {
      if (bytesOut >= maxBytes) {
        stoppedOnBytes = true;
        skipped.capped++;
        return;
      }

      let got;
      try {
        got = await resolveContent(tab.id, item, allowedHosts, credentials);
      } catch (e) {
        failed.push(`${item.url} — ${e?.message || e}`);
        return;
      }
      if (got.miss) {
        if (got.blocked) failed.push(`${item.url} — ${got.reason}`);
        else retry.push({ url: item.url, path: `${item.host}/${item.path}`, reason: got.reason });
        return;
      }

      const rec = recordedResponse(tab.id, item.url);
      tiers[got.source] = (tiers[got.source] || 0) + 1;
      emit(
        {
          url: item.url,
          path: item.dynamic ? `${item.host}/${item.path}` : undefined,
          contentType: got.contentType || rec?.mimeType || item.mimeType || "",
          httpStatus: got.httpStatus ?? rec?.status ?? 200,
          source: got.source,
        },
        got.bytes
      );

      if (!wantSourcemaps || (item.type !== "script" && item.type !== "stylesheet")) return;
      if (maps.sources >= MAX_SOURCEMAP_FILES) return;

      let text;
      try {
        text = decoder.decode(got.bytes);
      } catch {
        return;
      }
      const mapUrl = item.sourceMapURL || findSourceMappingURL(text);
      if (!mapUrl) return;

      let map;
      try {
        map = await loadSourceMap(tab.id, item, mapUrl, allowedHosts, credentials);
      } catch (e) {
        failed.push(`${mapUrl} — sourcemap: ${e?.message || e}`);
        return;
      }
      if (!map?.json?.sourcesContent) return;

      const bundle = sourcemapPath(item.path).split("/").pop() || "bundle";
      const sources = map.json.sources || [];
      maps.maps++;
      for (let i = 0; i < sources.length; i++) {
        const content = map.json.sourcesContent[i];
        if (typeof content !== "string") continue;
        if (maps.sources >= MAX_SOURCEMAP_FILES || bytesOut >= maxBytes) {
          if (bytesOut >= maxBytes) stoppedOnBytes = true;
          break;
        }
        const rel = sourcemapPath(sources[i]);
        const path = `${item.host}/_sourcemaps/${bundle}/${rel}`;
        // include is deliberately not re-applied here: it selected the bundle, and re-applying it
        // would drop every original file the agent asked for the bundle in order to get.
        if (exclude.length && matchesAny(exclude, { url: map.url, host: item.host, path })) continue;
        const bytes = textToBytes(content);
        emit(
          { url: `${map.url}#${rel}`, path, contentType: "text/plain", httpStatus: 200, source: got.source },
          bytes
        );
        maps.sources++;
        maps.bytes += bytes.length;
      }
    });

    const lines = [];
    lines.push(`Downloaded ${written} files · ${formatSize(bytesOut)} → ${outDir}`);
    const tierLine = Object.entries(tiers)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ");
    if (tierLine) lines.push(`tiers: ${tierLine}`);
    if (maps.maps) {
      lines.push(
        `sourcemaps: ${maps.maps} map${maps.maps === 1 ? "" : "s"} → ${maps.sources} original sources (${formatSize(maps.bytes)})`
      );
    }

    const skips = [];
    if (skipped.noise) skips.push(`${skipped.noise} noise`);
    if (skipped.filtered) skips.push(`${skipped.filtered} filtered`);
    if (skipped.assets) skips.push(`${skipped.assets} assets (image/font/media — add an include glob to fetch them)`);
    if (skipped.capped) skips.push(`${skipped.capped} over caps (maxFiles ${maxFiles}, maxBytes ${formatSize(maxBytes)})`);
    if (skips.length) lines.push(`skipped: ${skips.join(" · ")}`);
    if (stoppedOnBytes) lines.push(`stopped at maxBytes ${formatSize(maxBytes)} — narrow with origins/include or raise maxBytes`);

    if (failed.length) {
      lines.push(`failed ${failed.length}:`);
      for (const f of failed.slice(0, 10)) lines.push(`  ${f}`);
      if (failed.length > 10) lines.push(`  … ${failed.length - 10} more`);
    }
    if (retry.length) {
      lines.push(`${retry.length} unreachable from the browser — retrying unauthenticated host-side:`);
      for (const r of retry.slice(0, 10)) lines.push(`  ${r.url}`);
      if (retry.length > 10) lines.push(`  … ${retry.length - 10} more`);
    }
    lines.push(`manifest: ${outDir}/_manifest.json`);

    // `retry` is the tier-5 handoff: the host client refetches these plainly and folds the results
    // into the same manifest. `observedUrls` is what the network log actually saw, which the host
    // diffs against the statically-extracted endpoints to produce _unexercised.json — without it
    // that file degenerates to the full static set. `skipped`/`failed` are the counts the host
    // reprints: it discards `content` and rebuilds the summary itself, so anything only in the text
    // above never reaches the agent. All siblings of `content`, not part of it, so none of them
    // costs the model any tokens.
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      retry,
      outDir,
      observedUrls: observedUrls(tab.id),
      skipped: skipped.noise + skipped.filtered + skipped.assets + skipped.capped,
      failed,
    };
  },
};
