// Two-tier network log (PLAN §5.4) plus the console buffer, both navigation-scoped.
// This module is the single CDP-event sink for the worker: background routes every
// chrome.debugger.onEvent here so that navigation eviction, request merging and
// execution-context tracking all observe the same ordered stream.

import { cdp } from "./cdp.js";
import { sendNetBody } from "./bridge.js";

export const DEFAULT_PAGE_SIZE = 20;
export const BODY_CONTEXT_SIZE_LIMIT = 10000;
export const DEFAULT_RESOURCE_TYPES = ["XHR", "Fetch", "Document", "WebSocket", "Other"];

const MAX_NAVS = 3;
const MAX_ENTRIES_PER_NAV = 500;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TAB_BODY_BYTES = 64 * 1024 * 1024;
// Divisible by 3, so each chunk's base64 concatenates cleanly on the broker side.
const CHUNK_RAW_BYTES = 384 * 1024;
const PREVIEW_CHARS = BODY_CONTEXT_SIZE_LIMIT + 2000;
const CONSOLE_MAX = 250;
const CAPTURE_MIME =
  /^(?:application\/(?:json|javascript|x-javascript|ecmascript|[\w.+-]*\+json)|text\/(?:html|javascript))/i;

const tabs = new Map(); // tabId -> state

// Gated per PLAN §5.4; the host owns the config file, the worker only mirrors the flag.
let captureBodies = true;
try {
  chrome.storage.local.get({ captureBodies: true }).then((v) => {
    captureBodies = v.captureBodies !== false;
  }).catch(() => {});
} catch {}

export function setCaptureBodies(on) {
  captureBodies = !!on;
}

function newNav(loaderId, url) {
  return { loaderId: loaderId || null, url: url || "", startedAt: Date.now(), entries: [], byReq: new Map() };
}

function stateFor(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = { navs: [newNav(null, "")], nextIndex: 1, bodyBytes: 0, console: [], ctxs: new Map(), extra: new Map() };
    tabs.set(tabId, st);
  }
  return st;
}

function currentNav(st) {
  if (!st.navs.length) st.navs.push(newNav(null, ""));
  return st.navs[st.navs.length - 1];
}

// A new loaderId means a new document: rotate the ring and drop the console buffer.
function rotate(st, loaderId, url) {
  const cur = currentNav(st);
  if (cur.loaderId === loaderId) return cur;
  if (cur.loaderId === null && cur.entries.length === 0) {
    cur.loaderId = loaderId;
    cur.url = url || cur.url;
    return cur;
  }
  const nav = newNav(loaderId, url);
  st.navs.push(nav);
  while (st.navs.length > MAX_NAVS) {
    const dropped = st.navs.shift();
    for (const e of dropped.entries) st.bodyBytes -= e.bodyBytes || 0;
    if (st.bodyBytes < 0) st.bodyBytes = 0;
  }
  st.console = [];
  return nav;
}

function pushEntry(st, nav, entry) {
  nav.entries.push(entry);
  nav.byReq.set(entry.requestId, entry);
  if (nav.entries.length > MAX_ENTRIES_PER_NAV) {
    const gone = nav.entries.shift();
    if (nav.byReq.get(gone.requestId) === gone) nav.byReq.delete(gone.requestId);
    st.bodyBytes -= gone.bodyBytes || 0;
    if (st.bodyBytes < 0) st.bodyBytes = 0;
  }
}

function headersOf(h) {
  const o = {};
  if (h) for (const k of Object.keys(h)) o[k] = String(h[k]);
  return o;
}

function applyResponse(entry, res, type) {
  if (!res) return;
  entry.status = res.status || 0;
  entry.statusText = res.statusText || "";
  entry.mimeType = res.mimeType || "";
  entry.protocol = res.protocol || "";
  entry.remoteAddress = res.remoteIPAddress ? `${res.remoteIPAddress}:${res.remotePort || 0}` : "";
  entry.fromCache = !!res.fromDiskCache;
  Object.assign(entry.responseHeaders, headersOf(res.headers));
  if (res.requestHeaders) Object.assign(entry.requestHeaders, headersOf(res.requestHeaders));
  if (type) entry.resourceType = type;
  if (!entry.size && res.encodedDataLength) entry.size = res.encodedDataLength;
}

export function onCdpEvent(tabId, method, params) {
  if (!params) params = {};
  switch (method) {
    case "Page.frameNavigated": {
      if (params.frame && !params.frame.parentId) {
        const st = stateFor(tabId);
        // This is the only place the top frame identifies itself; onRequest needs it to tell a
        // real navigation from an iframe fetching its own document.
        st.mainFrameId = params.frame.id;
        rotate(st, params.frame.loaderId || null, params.frame.url || "");
      }
      return;
    }
    case "Runtime.executionContextCreated": {
      const c = params.context;
      if (!c) return;
      const st = stateFor(tabId);
      st.ctxs.set(c.id, {
        contextId: c.id,
        frameId: c.auxData && c.auxData.frameId,
        isDefault: !!(c.auxData && c.auxData.isDefault),
        name: c.name || "",
        origin: c.origin || "",
      });
      return;
    }
    case "Runtime.executionContextDestroyed": {
      const st = tabs.get(tabId);
      if (st) st.ctxs.delete(params.executionContextId);
      return;
    }
    case "Runtime.executionContextsCleared": {
      const st = tabs.get(tabId);
      if (st) st.ctxs.clear();
      return;
    }
    case "Network.requestWillBeSent":
      return onRequest(tabId, params);
    case "Network.requestWillBeSentExtraInfo": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (e) Object.assign(e.requestHeaders, headersOf(params.headers));
      else if (st.extra.size < 200) st.extra.set(params.requestId, headersOf(params.headers));
      return;
    }
    case "Network.responseReceived": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (e) applyResponse(e, params.response, params.type);
      return;
    }
    case "Network.responseReceivedExtraInfo": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (e) Object.assign(e.responseHeaders, headersOf(params.headers));
      return;
    }
    case "Network.dataReceived": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (e) e.received += params.encodedDataLength || params.dataLength || 0;
      return;
    }
    case "Network.loadingFinished": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (!e) return;
      e.size = params.encodedDataLength || e.received || e.size;
      e.endedAt = Date.now();
      e.finished = true;
      maybeCapture(tabId, st, e);
      return;
    }
    case "Network.loadingFailed": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (!e) return;
      e.failed = params.canceled ? "canceled" : params.errorText || "failed";
      e.endedAt = Date.now();
      e.finished = true;
      return;
    }
    case "Network.webSocketCreated": {
      const st = stateFor(tabId);
      const nav = currentNav(st);
      if (nav.byReq.has(params.requestId)) return;
      pushEntry(st, nav, makeEntry(st, params.requestId, "GET", params.url || "", "WebSocket"));
      return;
    }
    case "Network.webSocketWillSendHandshakeRequest": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (e && params.request) Object.assign(e.requestHeaders, headersOf(params.request.headers));
      return;
    }
    case "Network.webSocketHandshakeResponseReceived": {
      const st = stateFor(tabId);
      const e = findByReq(st, params.requestId);
      if (e) applyResponse(e, params.response, "WebSocket");
      return;
    }
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": {
      const st = tabs.get(tabId);
      const e = st && findByReq(st, params.requestId);
      if (e) {
        e.wsFrames = (e.wsFrames || 0) + 1;
        e.size += (params.response && params.response.payloadData ? params.response.payloadData.length : 0);
      }
      return;
    }
    case "Console.messageAdded": {
      if (!params.message) return;
      pushConsole(tabId, {
        level: params.message.level,
        text: params.message.text || "",
        url: params.message.url || "",
        timestamp: Date.now(),
      });
      return;
    }
    case "Runtime.consoleAPICalled": {
      if (!params.args) return;
      const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      pushConsole(tabId, {
        level: params.type || "log",
        text,
        url: (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0] && params.stackTrace.callFrames[0].url) || "",
        timestamp: Date.now(),
      });
      return;
    }
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      pushConsole(tabId, {
        level: "exception",
        text: d.text ? `${d.text} ${(d.exception && (d.exception.description || d.exception.value)) || ""}`.trim() : "uncaught exception",
        url: d.url || "",
        timestamp: Date.now(),
      });
      return;
    }
    default:
      return;
  }
}

function findByReq(st, requestId) {
  for (let i = st.navs.length - 1; i >= 0; i--) {
    const e = st.navs[i].byReq.get(requestId);
    if (e) return e;
  }
  return null;
}

function makeEntry(st, requestId, method, url, resourceType) {
  return {
    index: st.nextIndex++,
    requestId,
    method: method || "GET",
    url: url || "",
    resourceType: resourceType || "Other",
    status: 0,
    statusText: "",
    mimeType: "",
    protocol: "",
    remoteAddress: "",
    fromCache: false,
    requestHeaders: {},
    requestBody: null,
    hasPostData: false,
    responseHeaders: {},
    size: 0,
    received: 0,
    startedAt: Date.now(),
    endedAt: 0,
    finished: false,
    failed: null,
    bodyText: null,
    bodyBytes: 0,
    bodyBinary: false,
    spooled: false,
  };
}

function onRequest(tabId, params) {
  const st = stateFor(tabId);
  const req = params.request || {};
  // requestId === loaderId marks the main resource of *some* frame's navigation, so it also
  // fires for every iframe; without the frame check an ad slot would rotate the ring and wipe
  // the console buffer. Before the first frameNavigated we have no id yet, so let it through —
  // otherwise the very first navigation of a tab would never rotate.
  const isMainDoc =
    params.type === "Document" &&
    params.loaderId &&
    params.loaderId === params.requestId &&
    (!st.mainFrameId || params.frameId === st.mainFrameId);
  const nav = isMainDoc ? rotate(st, params.loaderId, req.url || "") : currentNav(st);

  // Chrome reuses the requestId across a redirect chain; each hop is its own entry.
  if (params.redirectResponse) {
    const prev = findByReq(st, params.requestId);
    if (prev) {
      applyResponse(prev, params.redirectResponse, prev.resourceType);
      prev.finished = true;
      prev.endedAt = Date.now();
      for (const n of st.navs) if (n.byReq.get(params.requestId) === prev) n.byReq.delete(params.requestId);
    }
  }

  const entry = makeEntry(st, params.requestId, req.method, req.url, params.type);
  Object.assign(entry.requestHeaders, headersOf(req.headers));
  const pending = st.extra.get(params.requestId);
  if (pending) {
    Object.assign(entry.requestHeaders, pending);
    st.extra.delete(params.requestId);
  }
  entry.hasPostData = !!req.hasPostData;
  if (req.postData != null) entry.requestBody = req.postData;
  pushEntry(st, nav, entry);
}

function pushConsole(tabId, msg) {
  const st = stateFor(tabId);
  st.console.push(msg);
  if (st.console.length > CONSOLE_MAX) st.console.splice(0, st.console.length - CONSOLE_MAX);
}

// --- eager response-body capture ---------------------------------------------
// Network.getResponseBody fails once the renderer has navigated away, so the only
// way the log survives a navigation at all is to pull interesting bodies out now.

function maybeCapture(tabId, st, entry) {
  if (!captureBodies) return;
  if (entry.spooled || entry.failed) return;
  if (!CAPTURE_MIME.test(entry.mimeType || "")) return;
  if (entry.size > MAX_BODY_BYTES) return;
  if (st.bodyBytes >= MAX_TAB_BODY_BYTES) return;
  entry.spooled = true;
  captureBody(tabId, st, entry).catch(() => {});
}

async function captureBody(tabId, st, entry) {
  const res = await cdp(tabId, "Network.getResponseBody", { requestId: entry.requestId });
  if (!res || res.body == null) return;
  const bytes = res.base64Encoded ? base64ToBytes(res.body) : new TextEncoder().encode(res.body);
  if (bytes.length > MAX_BODY_BYTES || st.bodyBytes + bytes.length > MAX_TAB_BODY_BYTES) return;
  st.bodyBytes += bytes.length;
  entry.bodyBytes = bytes.length;

  const decoded = decodeUtf8(bytes);
  if (decoded === null) entry.bodyBinary = true;
  else entry.bodyText = decoded.length > PREVIEW_CHARS ? decoded.slice(0, PREVIEW_CHARS) : decoded;

  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_RAW_BYTES));
  for (let seq = 0; seq < total; seq++) {
    const part = bytes.subarray(seq * CHUNK_RAW_BYTES, (seq + 1) * CHUNK_RAW_BYTES);
    sendNetBody({
      type: "net_body",
      tabId,
      requestId: entry.requestId,
      url: entry.url,
      mimeType: entry.mimeType,
      status: entry.status,
      resourceType: entry.resourceType,
      encoding: "base64",
      data: bytesToBase64(part),
      seq,
      final: seq === total - 1,
    });
  }
}

export function bytesToBase64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// --- formatting ---------------------------------------------------------------

function fmtSize(n) {
  if (!n || n < 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function shortPath(url, baseOrigin) {
  let s;
  try {
    const u = new URL(url);
    s = u.pathname + u.search;
    if (baseOrigin && u.origin !== baseOrigin) s = `//${u.host}${s}`;
  } catch {
    s = String(url || "");
  }
  return s.length > 64 ? `${s.slice(0, 40)}…${s.slice(-23)}` : s;
}

function clip(text, limit = BODY_CONTEXT_SIZE_LIMIT) {
  if (text == null) return "";
  const s = String(text);
  return s.length <= limit ? s : `${s.slice(0, limit)}... <truncated>`;
}

function matcher(filter) {
  if (!filter) return () => true;
  let re = null;
  try {
    re = new RegExp(filter, "i");
  } catch {
    re = null;
  }
  const needle = String(filter).toLowerCase();
  return (e) => {
    const hay = `${e.method} ${e.url} ${e.status || ""} ${e.resourceType}`;
    return re ? re.test(hay) : hay.toLowerCase().includes(needle);
  };
}

export function list(tabId, opts = {}) {
  const st = tabs.get(tabId);
  const pageSize = Math.max(1, Math.min(100, opts.pageSize || DEFAULT_PAGE_SIZE));
  const pageIdx = Math.max(0, opts.pageIdx || 0);
  if (!st) return { total: 0, pageIdx, pageCount: 0, text: "No network requests recorded for this tab yet." };

  const navs = opts.includePreserved ? st.navs : [currentNav(st)];
  const wanted = new Set(
    (Array.isArray(opts.resourceTypes) && opts.resourceTypes.length ? opts.resourceTypes : DEFAULT_RESOURCE_TYPES)
      .map((t) => String(t).toLowerCase())
  );
  const takeAll = wanted.has("all") || wanted.has("*");
  const test = matcher(opts.filter);

  let all = [];
  for (const nav of navs) {
    for (const e of nav.entries) {
      if (!takeAll && !wanted.has(e.resourceType.toLowerCase())) continue;
      if (!test(e)) continue;
      all.push(e);
    }
  }
  all.sort((a, b) => a.index - b.index);

  const total = all.length;
  if (!total) {
    return { total: 0, pageIdx, pageCount: 0, text: "No network requests matched. Widen resourceTypes or drop the filter." };
  }
  const pageCount = Math.ceil(total / pageSize);
  const page = Math.min(pageIdx, pageCount - 1);
  const rows = all.slice(page * pageSize, page * pageSize + pageSize);

  const baseOrigin = originOf(currentNav(st).url);
  const cells = rows.map((e) => ({
    id: `#${e.index}`,
    method: (e.method || "GET").toUpperCase().slice(0, 7),
    path: shortPath(e.url, baseOrigin),
    status: e.failed ? "err" : e.status ? String(e.status) : "-",
    type: e.resourceType.toLowerCase(),
    size: fmtSize(e.size),
  }));

  const idW = Math.max(...cells.map((c) => c.id.length)) + 1;
  const pathW = Math.max(...cells.map((c) => c.path.length)) + 4;
  const typeW = Math.max(...cells.map((c) => c.type.length));
  const sizeW = Math.max(...cells.map((c) => c.size.length)) + 2;

  const lines = cells.map(
    (c) =>
      `${c.id.padEnd(idW)} ${c.method.padEnd(4)} ${c.path.padEnd(pathW)} ${c.status.padStart(3)}  ` +
      `${c.type.padEnd(typeW)}${c.size.padStart(sizeW)}`
  );

  const from = page * pageSize + 1;
  const to = page * pageSize + rows.length;
  let footer = `Showing ${from}-${to} of ${total} (Page ${page + 1} of ${pageCount}).`;
  if (page + 1 < pageCount) footer += ` Next page: ${page + 1}`;

  return { total, pageIdx: page, pageCount, text: `${lines.join("\n")}\n${footer}` };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function findByIndex(st, index) {
  for (const nav of st.navs) {
    for (const e of nav.entries) if (e.index === index) return e;
  }
  return null;
}

function fmtHeaders(h) {
  const keys = Object.keys(h || {});
  if (!keys.length) return "(none recorded)";
  return keys.map((k) => `${k}: ${h[k]}`).join("\n");
}

export async function detail(tabId, index, part) {
  const st = tabs.get(tabId);
  const idx = Number(index);
  if (!Number.isFinite(idx)) {
    return { header: "read_network_request", text: "index must be the number from a read_network_requests row (the #N)." };
  }
  if (!st) return { header: `#${idx}`, text: "<not available anymore>" };
  const e = findByIndex(st, idx);
  if (!e) {
    return {
      header: `#${idx}`,
      text: idx > 0 && idx < st.nextIndex ? "<not available anymore>" : `No request #${idx}. Call read_network_requests for the index.`,
    };
  }

  const status = e.failed ? `failed (${e.failed})` : e.status || "pending";
  const header = `#${e.index} ${e.method} ${e.url} → ${status} · ${e.resourceType} · ${fmtSize(e.size)}${e.mimeType ? ` · ${e.mimeType}` : ""}`;

  switch (part) {
    case "request-headers":
      return { header, text: clip(fmtHeaders(e.requestHeaders)) };
    case "response-headers":
      return { header, text: clip(fmtHeaders(e.responseHeaders)) };
    case "request-body": {
      if (e.requestBody == null && e.hasPostData) {
        try {
          const r = await cdp(tabId, "Network.getRequestPostData", { requestId: e.requestId });
          if (r && r.postData != null) e.requestBody = r.postData;
        } catch {}
      }
      if (e.requestBody == null) return { header, text: e.hasPostData ? "<not available anymore>" : "(no request body)" };
      return { header, text: clip(e.requestBody) };
    }
    case "response-body": {
      if (e.bodyBinary) return { header, text: "<binary data>" };
      if (e.bodyText != null) return { header, text: clip(e.bodyText) };
      try {
        const r = await cdp(tabId, "Network.getResponseBody", { requestId: e.requestId });
        if (r && r.body != null) {
          if (!r.base64Encoded) return { header, text: clip(r.body) };
          const decoded = decodeUtf8(base64ToBytes(r.body));
          return { header, text: decoded === null ? "<binary data>" : clip(decoded) };
        }
      } catch {}
      return { header, text: "<not available anymore>" };
    }
    default:
      return { header, text: `Unknown part "${part}".` };
  }
}

export function observedUrls(tabId) {
  const st = tabs.get(tabId);
  if (!st) return [];
  const seen = new Set();
  for (const nav of st.navs) for (const e of nav.entries) if (e.url) seen.add(e.url);
  return [...seen];
}

export function clear(tabId) {
  tabs.delete(tabId);
}

// --- console -------------------------------------------------------------------

export function consoleList(tabId, { pattern, limit = 100, onlyErrors, clear: doClear } = {}) {
  const st = tabs.get(tabId);
  let msgs = st ? st.console.slice() : [];

  if (onlyErrors) msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));

  if (pattern) {
    let re = null;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = null;
    }
    msgs = re ? msgs.filter((m) => re.test(m.text) || re.test(m.level)) : msgs.filter((m) => m.text.includes(pattern));
  }

  msgs = msgs.slice(-Math.max(1, limit));
  if (doClear && st) st.console = [];
  return msgs;
}

export function clearConsole(tabId) {
  const st = tabs.get(tabId);
  if (st) st.console = [];
}

// Populated by Runtime.executionContextCreated; javascript_tool's allFrames fan-out
// needs the main-world contextId per frame, which nothing else exposes.
export function contextsForTab(tabId) {
  const st = tabs.get(tabId);
  return st ? [...st.ctxs.values()] : [];
}
