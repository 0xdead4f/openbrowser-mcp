// Endpoint / parameter / secret extraction, run once over every downloaded body (PLAN §9.1).
// Doing it at download time is what replaces the ~2,700 hand-rolled regex hunts the transcripts
// show: the agent greps a few-KB JSON instead of re-deriving it from a 500 KB bundle.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";

const exec = promisify(execFile);

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 5000;
const MAX_PARAMS = 2000;
const MAX_HOSTS = 1000;
const MAX_SECRETS = 200;
const MAX_MATCHES_PER_FILE = 20000;
const JSLUICE_BATCH = 60;

// LinkFinder's endpoint regex, transliterated. The third alternative is the extension-less
// REST case, and its {1,}/{3,} shape is the false-positive damper — without it every "a/b"
// in the bundle becomes an endpoint.
// That damper is wrapped in `(?=(…))\5` rather than written inline: its two runs share the
// `/` and both classes are unbounded, so on a long slashed run that ends anywhere but a quote
// V8 retries every split (a 50 KB run cost 1.2 s, and this runs over hostile bundle text).
// A lookahead is atomic — it commits to the greedy match and \5 replays it, no retries. The
// captured text is identical either way, because the closing quote forces the whole run.
const LINKFINDER = new RegExp(
  "[\"'`](" +
    "((?:[a-zA-Z]{1,10}://|//)[^\"'`/]{1,}\\.[a-zA-Z]{2,}[^\"'`]{0,})" +
    "|" +
    "((?:/|\\.\\./|\\./)[^\"'`><,;| *()(%$^/\\\\\\[\\]][^\"'`><,;|()]{1,})" +
    "|" +
    "((?=([a-zA-Z0-9_\\-/]{1,}/[a-zA-Z0-9_\\-/]{3,}))\\5(?:[?#][^\"'`|]{0,}|))" +
    "|" +
    "([a-zA-Z0-9_\\-]{1,}\\.(?:php|asp|aspx|jsp|json|action|html?|js|txt|xml)(?:[?#][^\"'`|]{0,}|))" +
  ")[\"'`]",
  "g"
);

const QUERY_PARAM = /[?&]([A-Za-z_][A-Za-z0-9_.\-]{0,40})=/g;
const REST_DAMPER = /^[a-zA-Z0-9_\-/]{1,}\/[a-zA-Z0-9_\-/]{3,}$/;
const HAS_EXT = /\.(?:php|asp|aspx|jsp|json|action|html?|js|mjs|txt|xml|do|cgi|py|rb|go|graphql)(?:$|[?#])/i;
const MIME_PREFIX = /^(?:text|application|image|audio|video|font|multipart|message|model|x-[a-z]+)\//i;
const NOISE_PATH = /^(?:n\/a|and\/or|or\/and|km\/h|w\/o|24\/7|input\/output|utf-8|us-ascii|https?)$/i;
// Every bundle that touches SVG or MathML carries these; they are namespaces, not routes.
const XML_NAMESPACE = /^\/(?:1999\/(?:xhtml|xlink|XSL\/)|2000\/(?:svg|xmlns)|1998\/(?:Math\/)?MathML|XML\/1998\/namespace|200[01]\/XMLSchema)/;
const STATIC_ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|css|map|mp4|webm|mp3|wav|pdf)$/i;

const SECRET_PATTERNS = [
  ["google_api_key", /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ["aws_access_key_id", /\b(?:A3T[A-Z0-9]|AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack_token", /\bxox[baprse]-[0-9A-Za-z-]{10,72}\b/g],
  ["stripe_key", /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{16,99}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g],
  ["private_key_block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ["github_token", /\b(?:gh[pousr]_[0-9A-Za-z]{36,255}|github_pat_[0-9A-Za-z_]{50,255})\b/g],
];

const GENERIC_ASSIGNMENT =
  /(?:api[_-]?key|apikey|secret|token|passwd|password|auth[_-]?key|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?key)[A-Za-z0-9_]{0,20}["']?\s*[:=]\s*["'`]([A-Za-z0-9+/=_\-]{16,200})["'`]/gi;

const PLACEHOLDER =
  /^(?:x+|0+|\.+|-+|_+|null|undefined|true|false|none|test|example\w*|changeme|dummy|placeholder|sample|redacted|secret|password|your[_-]?\w*|xxx\w*|abc\w*|[a-z]+)$/i;

// --- jsluice ---------------------------------------------------------------------------

let jsluiceBin;

async function findJsluice() {
  if (jsluiceBin !== undefined) return jsluiceBin;
  try {
    const { stdout } = await exec("which", ["jsluice"]);
    jsluiceBin = stdout.trim().split("\n")[0] || null;
  } catch {
    jsluiceBin = null;
  }
  return jsluiceBin;
}

// jsluice's tree-sitter pass recovers concatenated URLs and HTTP methods that no regex can.
async function runJsluice(bin, paths, sink) {
  for (let i = 0; i < paths.length; i += JSLUICE_BATCH) {
    const batch = paths.slice(i, i + JSLUICE_BATCH);
    let stdout;
    try {
      ({ stdout } = await exec(bin, ["urls", ...batch], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      // A jsluice crash on one batch must not lose the whole extraction.
      stdout = (e && e.stdout) || "";
    }
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      ingestUrl(row.url, sink);
      for (const k of row.queryParams || []) addParam(k, sink);
      for (const k of row.bodyParams || []) addParam(k, sink);
    }
  }
}

// --- extraction ------------------------------------------------------------------------

export async function extractEndpoints(files) {
  const list = Array.isArray(files) ? files : [];
  const sink = { paths: new Set(), params: new Set(), hosts: new Set() };
  const secrets = [];
  const seenSecret = new Set();

  const bin = await findJsluice();
  // jsluice reads from disk, so every file that has a path goes through it — selecting on the
  // *absence* of .text made this dead code, since the caller always reads the body first.
  const onDisk = bin ? list.filter((f) => f && f.path) : [];
  if (onDisk.length) await runJsluice(bin, onDisk.map((f) => f.path), sink);

  for (const f of list) {
    if (!f) continue;
    const text = await bodyOf(f);
    if (!text) continue;
    // Both passes always run: jsluice `urls` only reports URLs, so suppressing the regex pass
    // for the files it handled would drop every extension-less REST path. The sink is Sets.
    scanUrls(text, sink);
    scanSecrets(text, labelOf(f), secrets, seenSecret);
    if (secrets.length >= MAX_SECRETS) break;
  }

  return {
    paths: capped(sink.paths, MAX_PATHS),
    params: capped(sink.params, MAX_PARAMS),
    hosts: capped(sink.hosts, MAX_HOSTS),
    secrets: secrets.slice(0, MAX_SECRETS),
  };
}

async function bodyOf(f) {
  if (typeof f.text === "string") return f.text.length > MAX_FILE_BYTES ? f.text.slice(0, MAX_FILE_BYTES) : f.text;
  if (!f.path) return null;
  try {
    const buf = await fsp.readFile(f.path);
    if (buf.length > MAX_FILE_BYTES || buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function labelOf(f) {
  return f.path || f.url || "<unknown>";
}

function capped(set, n) {
  return [...set].sort().slice(0, n);
}

function scanUrls(text, sink) {
  LINKFINDER.lastIndex = 0;
  let m;
  let count = 0;
  while ((m = LINKFINDER.exec(text)) !== null) {
    if (++count > MAX_MATCHES_PER_FILE) break;
    ingestUrl(m[1], sink);
  }
  QUERY_PARAM.lastIndex = 0;
  count = 0;
  while ((m = QUERY_PARAM.exec(text)) !== null) {
    if (++count > MAX_MATCHES_PER_FILE) break;
    addParam(m[1], sink);
  }
}

function addParam(k, sink) {
  const s = String(k || "").trim();
  if (s && s.length <= 40 && /^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(s)) sink.params.add(s);
}

function ingestUrl(raw, sink) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > 400) return;
  const abs = s.startsWith("//") ? `http:${s}` : s;
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(abs)) {
    let u;
    try {
      u = new URL(abs);
    } catch {
      return;
    }
    if (u.hostname) sink.hosts.add(u.hostname.toLowerCase());
    if (u.pathname && u.pathname !== "/" && !XML_NAMESPACE.test(u.pathname)) sink.paths.add(u.pathname);
    for (const k of u.searchParams.keys()) addParam(k, sink);
    return;
  }
  const q = s.indexOf("?");
  if (q !== -1) {
    for (const pair of s.slice(q + 1).split(/[&;]/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) addParam(pair.slice(0, eq), sink);
    }
    s = s.slice(0, q);
  }
  const h = s.indexOf("#");
  if (h !== -1) s = s.slice(0, h);
  if (isPlausiblePath(s)) sink.paths.add(s);
}

function isPlausiblePath(p) {
  if (!p || p.length < 2 || p.length > 300) return false;
  if (!/[a-zA-Z]/.test(p)) return false;
  if (/[\s<>"'`{}\\|^]/.test(p)) return false;
  if (MIME_PREFIX.test(p)) return false;
  if (NOISE_PATH.test(p) || XML_NAMESPACE.test(p)) return false;
  if (p.split("/").length > 14) return false;
  if (p.startsWith("/") || p.startsWith("./") || p.startsWith("../")) return true;
  if (HAS_EXT.test(p)) return true;
  return REST_DAMPER.test(p);
}

// --- secrets ---------------------------------------------------------------------------

function scanSecrets(text, file, out, seen) {
  let starts = null;
  const record = (kind, offset) => {
    if (!starts) starts = lineIndex(text);
    const line = lineAt(starts, offset);
    const key = `${kind} ${file} ${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, file, line });
  };

  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      record(kind, m.index);
      if (out.length >= MAX_SECRETS) return;
    }
  }

  GENERIC_ASSIGNMENT.lastIndex = 0;
  let m;
  while ((m = GENERIC_ASSIGNMENT.exec(text)) !== null) {
    const value = m[1];
    // Entropy is what separates a real key from `apiKey: "REPLACE_ME"`.
    if (PLACEHOLDER.test(value)) continue;
    if (new Set(value).size < 8) continue;
    if (shannon(value) < 3.5) continue;
    record("generic_high_entropy_assignment", m.index);
    if (out.length >= MAX_SECRETS) return;
  }
}

function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function shannon(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// --- the un-exercised surface ----------------------------------------------------------

// Static extraction gives the possible attack surface, the network log gives the exercised
// one. Both sides are normalized first so /user/1234 and /user/{id} do not look like two
// different routes — otherwise every parameterized route shows up as un-exercised.
export function diffUnexercised(endpoints, observedUrls) {
  const ep = endpoints || {};
  const seenPaths = new Set();
  const seenParams = new Set();
  const seenHosts = new Set();

  for (const raw of observedUrls || []) {
    const s = String(raw == null ? "" : raw);
    if (!s) continue;
    let u = null;
    try {
      u = new URL(s.startsWith("//") ? `http:${s}` : s);
    } catch {
      u = null;
    }
    if (u) {
      if (u.hostname) seenHosts.add(u.hostname.toLowerCase());
      seenPaths.add(normalizePath(u.pathname));
      for (const k of u.searchParams.keys()) seenParams.add(k.toLowerCase());
    } else {
      const q = s.indexOf("?");
      if (q !== -1) {
        for (const pair of s.slice(q + 1).split(/[&;]/)) {
          const eq = pair.indexOf("=");
          if (eq > 0) seenParams.add(pair.slice(0, eq).toLowerCase());
        }
      }
      seenPaths.add(normalizePath(q === -1 ? s : s.slice(0, q)));
    }
  }

  const paths = [];
  const emitted = new Set();
  for (const p of ep.paths || []) {
    const n = normalizePath(p);
    if (!n || n === "/") continue;
    if (STATIC_ASSET.test(n)) continue;
    if (seenPaths.has(n) || emitted.has(n)) continue;
    emitted.add(n);
    paths.push(p);
  }

  return {
    paths: paths.sort(),
    params: (ep.params || []).filter((k) => !seenParams.has(String(k).toLowerCase())).sort(),
    hosts: (ep.hosts || []).filter((h) => !seenHosts.has(String(h).toLowerCase())).sort(),
  };
}

function normalizePath(p) {
  let s = String(p == null ? "" : p).trim();
  if (!s) return "";
  if (s.startsWith("//")) s = `http:${s}`;
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return "";
    }
  }
  s = s.split("#")[0].split("?")[0];
  if (!s.startsWith("/")) s = `/${s.replace(/^\.{1,2}\//, "")}`;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.split("/").map(placeholder).join("/");
}

function placeholder(seg) {
  if (!seg) return seg;
  if (/^[:$]/.test(seg) || /^[{<[].*[}>\]]$/.test(seg) || /^%[sd]$/.test(seg)) return "{id}";
  if (/^\d+$/.test(seg)) return "{id}";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{uuid}";
  if (/^[0-9a-f]{24}$/i.test(seg)) return "{oid}";
  if (/^[0-9a-f]{32,}$/i.test(seg)) return "{hash}";
  if (seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /[0-9]/.test(seg) && /[A-Z]/.test(seg)) return "{token}";
  return seg;
}
