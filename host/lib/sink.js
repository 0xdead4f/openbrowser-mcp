// Disk writer + path reconstruction for sources_download.
// A malicious site controls every URL that lands here, so each segment is sanitized and the
// resolved destination is asserted to be inside outDir before a single byte is written.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { beautify } from "./beautify.js";

// Beautify needs a whole file in memory, so it is only applied under this ceiling; anything
// bigger streams straight through and stays minified.
const BEAUTIFY_MAX_BYTES = 8 * 1024 * 1024;

// Sidecars the download writes at the root; a resource must never be able to overwrite them.
const RESERVED_ROOT = ["_manifest.json", "_endpoints.json", "_unexercised.json"];

const CONTENT_TYPE_EXT = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/css": "css",
  "text/javascript": "js",
  "application/javascript": "js",
  "application/x-javascript": "js",
  "text/ecmascript": "js",
  "application/ecmascript": "js",
  "module": "mjs",
  "application/json": "json",
  "application/ld+json": "json",
  "application/manifest+json": "webmanifest",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/xml": "xml",
  "application/xml": "xml",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "application/font-woff": "woff",
  "application/font-woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/vnd.ms-fontobject": "eot",
  "application/wasm": "wasm",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "application/octet-stream": "bin",
};

// Fallback counter so a bare urlToPath() call still produces unique inline names.
let inlineCounter = 0;

export function sanitizeSegment(seg) {
  let s = String(seg == null ? "" : seg)
    .replace(/[\x00-\x20]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/[<>:"|?*]/g, "_");
  // "." and ".." would climb out of the tree once the OS resolves them.
  if (/^\.+$/.test(s)) s = "_";
  if (s.length > 200) s = s.slice(0, 200);
  return s || "_";
}

function extFromContentType(ct) {
  if (!ct) return null;
  const base = String(ct).split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_EXT[base] || null;
}

function hasExtension(name) {
  return /\.[A-Za-z0-9]{1,10}$/.test(name);
}

function dynamicPath(raw, contentType, index) {
  const n = index != null ? index : ++inlineCounter;
  const ext = extFromContentType(contentType) || "js";
  const tail = String(raw).split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
  const base = sanitizeSegment(tail).slice(0, 80);
  const name = /[A-Za-z0-9]/.test(base) ? `${n}-${base}` : `${n}`;
  return `_dynamic/${hasExtension(name) ? name : `${name}.${ext}`}`;
}

export function urlToPath(url, opts = {}) {
  const { contentType = null, keepQuery = false, index = null } = opts;
  const raw = String(url == null ? "" : url);

  if (/^data:/i.test(raw)) {
    const n = index != null ? index : ++inlineCounter;
    const m = /^data:([^;,]*)/i.exec(raw);
    const ext = extFromContentType(m && m[1]) || extFromContentType(contentType) || "bin";
    return `_inline/data-${n}.${ext}`;
  }

  let u = null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
    return dynamicPath(raw, contentType, index);
  }

  const hostDir = sanitizeSegment(u.port ? `${u.hostname}_${u.port}` : u.hostname);
  const segs = u.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  if (u.pathname === "" || u.pathname.endsWith("/") || segs.length === 0) segs.push("index.html");

  // Inline <script> blocks are addressed as <docUrl>#script-<n> (the form sources_list renders).
  const inline = /^#(?:inline-)?script-(\d+)$/i.exec(u.hash || "");
  if (inline) {
    let doc = segs[segs.length - 1];
    if (!hasExtension(doc)) doc += ".html";
    return `${hostDir}/_inline/${doc}.script-${inline[1]}.js`;
  }

  let file = segs.pop();
  if (!hasExtension(file)) {
    const ext = extFromContentType(contentType);
    if (ext) file += `.${ext}`;
  }
  if (keepQuery && u.search && u.search !== "?") {
    file += `__q${crypto.createHash("sha256").update(u.search).digest("hex").slice(0, 8)}`;
  }
  return [hostDir, ...segs, file].join("/");
}

function errText(e) {
  const msg = String((e && e.message) || e);
  return e && e.code && !msg.startsWith(e.code) ? `${e.code}: ${msg}` : msg;
}

function normalizeRel(rel) {
  return String(rel)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(sanitizeSegment)
    .join("/");
}

function beautifyKind(rel, contentType) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(rel) || ["", ""])[1].toLowerCase();
  // A .map is JSON but pretty-printing it triples a file whose sourcesContent is unpacked anyway.
  if (ext === "map") return null;
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "jsx" ||
      ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  if (ext === "css" || ct === "text/css") return "css";
  if (ext === "json" || ext === "webmanifest" || ct.includes("json")) return "json";
  return null;
}

function prettify(buf, kind) {
  if (!kind || buf.length === 0 || buf.length > BEAUTIFY_MAX_BYTES) return buf;
  if (buf.includes(0)) return buf;
  const text = buf.toString("utf8");
  if (text.includes("�")) return buf;
  const out = beautify(text, kind);
  return out === text ? buf : Buffer.from(out, "utf8");
}

export class DownloadSink {
  constructor({ outDir } = {}) {
    this.outDir = path.resolve(outDir || "source");
    this.manifest = [];
    this.failed = [];
    // Lowercased because macOS and Windows filesystems are case-insensitive: App.js and
    // app.js are the same file on disk even though they are two different URLs.
    this.claimed = new Set(RESERVED_ROOT);
    this.inlineIndex = 0;
    this.openHandles = 0;
    this.live = new Set();
  }

  get failures() {
    return this.failed;
  }

  async begin(fileMeta = {}) {
    const meta = {
      url: fileMeta.url == null ? "" : String(fileMeta.url),
      contentType: fileMeta.contentType == null ? null : String(fileMeta.contentType),
      httpStatus: fileMeta.httpStatus == null ? null : fileMeta.httpStatus,
      source: fileMeta.source == null ? null : String(fileMeta.source),
    };

    let rel;
    try {
      if (fileMeta.rel) {
        rel = normalizeRel(fileMeta.rel);
      } else {
        const synthetic = /^data:/i.test(meta.url) || !/^https?:\/\//i.test(meta.url);
        rel = urlToPath(meta.url, {
          contentType: meta.contentType,
          keepQuery: !!fileMeta.keepQuery,
          index: synthetic ? ++this.inlineIndex : null,
        });
      }
    } catch (e) {
      return this.#refuse(meta, null, `path reconstruction failed: ${e.message}`);
    }
    if (!rel) return this.#refuse(meta, null, "url produced an empty path");

    rel = this.#claim(rel);
    const dest = path.resolve(this.outDir, rel);
    if (!dest.startsWith(path.resolve(this.outDir) + path.sep)) {
      return this.#refuse(meta, rel, "resolves outside outDir");
    }

    const handle = {
      refused: false,
      closed: false,
      rel,
      dest,
      meta,
      stream: null,
      hash: crypto.createHash("sha256"),
      bytes: 0,
      error: null,
      kind: beautifyKind(rel, meta.contentType),
      parts: [],
      buffered: 0,
      buffering: false,
      result: null,
    };
    handle.buffering = handle.kind !== null;

    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      handle.stream = fs.createWriteStream(dest);
      handle.stream.on("error", (e) => {
        handle.error = e;
      });
      await once(handle.stream, "open");
    } catch (e) {
      return this.#refuse(meta, rel, errText(e));
    }

    this.openHandles++;
    this.live.add(handle);
    return handle;
  }

  async write(handle, buf) {
    if (!handle || handle.refused || handle.closed || handle.error) return;
    const chunk = Buffer.isBuffer(buf)
      ? buf
      : typeof buf === "string"
        ? Buffer.from(buf, "utf8")
        : Buffer.from(buf || []);
    if (chunk.length === 0) return;

    if (handle.buffering) {
      handle.parts.push(chunk);
      handle.buffered += chunk.length;
      if (handle.buffered > BEAUTIFY_MAX_BYTES) {
        // Too big to pretty-print — flush and stream the rest so memory stays bounded.
        const all = Buffer.concat(handle.parts, handle.buffered);
        handle.parts = [];
        handle.buffered = 0;
        handle.buffering = false;
        await this.#raw(handle, all);
      }
      return;
    }
    await this.#raw(handle, chunk);
  }

  async end(handle) {
    if (!handle || handle.refused) return { savedTo: null, bytes: 0, sha256: null, refused: true };
    if (handle.closed) return handle.result;
    handle.closed = true;

    try {
      if (handle.buffering) {
        const all = Buffer.concat(handle.parts, handle.buffered);
        handle.parts = [];
        handle.buffered = 0;
        handle.buffering = false;
        await this.#raw(handle, prettify(all, handle.kind));
      }
      await new Promise((resolve, reject) => {
        handle.stream.once("error", reject);
        handle.stream.end(resolve);
      });
      if (handle.error) throw handle.error;

      const row = {
        url: handle.meta.url,
        savedTo: handle.rel,
        bytes: handle.bytes,
        sha256: handle.hash.digest("hex"),
        contentType: handle.meta.contentType,
        httpStatus: handle.meta.httpStatus,
        source: handle.meta.source,
      };
      this.manifest.push(row);
      handle.result = { savedTo: row.savedTo, bytes: row.bytes, sha256: row.sha256 };
    } catch (e) {
      this.failed.push({
        url: handle.meta.url,
        savedTo: handle.rel,
        reason: errText(e),
      });
      handle.result = { savedTo: null, bytes: 0, sha256: null, refused: false, error: errText(e) };
    } finally {
      this.openHandles--;
      this.live.delete(handle);
    }
    return handle.result;
  }

  async finalize() {
    // A download that threw (tab closed, timeout) leaves handles that never reached end():
    // an open fd plus a truncated file on disk. Recording them in failed[] is what keeps the
    // manifest an honest record of what was captured — a partial file listed nowhere is worse
    // than no file at all when the tree is the evidence.
    for (const h of this.live) {
      h.stream.destroy();
      h.closed = true;
      h.result = { savedTo: null, bytes: 0, sha256: null, refused: false, error: "stream never finalized" };
      this.failed.push({ url: h.meta.url, savedTo: h.rel, reason: "stream never finalized" });
      this.openHandles--;
    }
    this.live.clear();

    // Sorted so two runs of the same target diff cleanly — that is the point for recon.
    const rows = this.manifest.slice().sort((a, b) => (a.savedTo < b.savedTo ? -1 : a.savedTo > b.savedTo ? 1 : 0));
    const manifestPath = path.join(this.outDir, "_manifest.json");
    let bytes = 0;
    for (const r of rows) bytes += r.bytes;

    try {
      await fsp.mkdir(this.outDir, { recursive: true });
      await fsp.writeFile(manifestPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    } catch (e) {
      this.failed.push({ url: null, savedTo: "_manifest.json", reason: errText(e) });
    }

    return {
      outDir: this.outDir,
      manifestPath,
      written: rows.length,
      failed: this.failed.length,
      bytes,
      failures: this.failed.slice(0, 50),
    };
  }

  async #raw(handle, chunk) {
    if (handle.error) return;
    handle.hash.update(chunk);
    handle.bytes += chunk.length;
    if (!handle.stream.write(chunk)) await once(handle.stream, "drain");
  }

  #refuse(meta, rel, reason) {
    this.failed.push({ url: meta.url, savedTo: rel, reason });
    return { refused: true, closed: true, rel, meta, result: { savedTo: null, bytes: 0, sha256: null, refused: true } };
  }

  #claim(rel) {
    const key = rel.toLowerCase();
    if (!this.claimed.has(key)) {
      this.claimed.add(key);
      return rel;
    }
    const slash = rel.lastIndexOf("/");
    const dir = slash < 0 ? "" : rel.slice(0, slash + 1);
    const file = slash < 0 ? rel : rel.slice(slash + 1);
    const dot = file.lastIndexOf(".");
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : "";
    for (let i = 1; i < 10000; i++) {
      const cand = `${dir}${stem}.${i}${ext}`;
      const ck = cand.toLowerCase();
      if (!this.claimed.has(ck)) {
        this.claimed.add(ck);
        return cand;
      }
    }
    const cand = `${dir}${stem}.${crypto.randomBytes(4).toString("hex")}${ext}`;
    this.claimed.add(cand.toLowerCase());
    return cand;
  }
}
