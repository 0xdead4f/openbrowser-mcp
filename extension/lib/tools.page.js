// Tools 11-16: page evaluation and the observation ladder (PLAN §5.4, §5.8, §5.9).

import { cdp, ensureAttached, ensureDomain } from "./cdp.js";
import { isInGroup } from "./contexts.js";
import { snapshotRefs } from "./refs.js";
import { STDLIB_GUARDED, registerStdlib } from "./stdlib.js";
import {
  list as netList,
  detail as netDetail,
  consoleList,
  contextsForTab,
  bytesToBase64,
  DEFAULT_PAGE_SIZE,
} from "./net.js";

const JS_MAX_CHARS = 4000;
const SURFACE_MAX_LINKS = 40;
// Held under page_surface's declared maxResultSizeChars (12000) so a form-heavy or
// many-framed page degrades into a stated omission instead of a silently clipped tail.
const SURFACE_MAX_CHARS = 10000;
const CHUNK_RAW_BYTES = 384 * 1024;
// Exceptions are reported against the combined expression; the stdlib preamble is prepended
// on every call, so its line count has to come back off before the model sees a line number.
const PREAMBLE_LINES = STDLIB_GUARDED.split("\n").length;

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

function notInGroup(tabId) {
  return text(`Tab ${tabId} is not in the MCP group.`);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// --- output spill --------------------------------------------------------------
// Anything big leaves as tool_chunk and the result carries only a handle (PLAN §5.10).

async function spill(ctx, filename, body, contentType) {
  const bytes = new TextEncoder().encode(body);
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_RAW_BYTES));
  for (let seq = 0; seq < total; seq++) {
    ctx.sendChunk(ctx.requestId, {
      seq,
      final: seq === total - 1,
      file: { url: filename, contentType, httpStatus: 200, source: "tool", bytes: bytes.length },
      data: bytesToBase64(bytes.subarray(seq * CHUNK_RAW_BYTES, (seq + 1) * CHUNK_RAW_BYTES)),
    });
  }
  return bytes.length;
}

function spillable(ctx) {
  return !!(ctx && typeof ctx.sendChunk === "function");
}

async function maybeSpill(ctx, filename, body, contentType, head) {
  if (!spillable(ctx)) return text(`filename is not available on this connection.\n\n${body.slice(0, 2000)}`);
  const bytes = await spill(ctx, filename, body, contentType);
  return text(`Wrote ${bytes} bytes to ${filename}.${head ? `\nHead: ${head}` : ""}`);
}

// --- javascript_tool -----------------------------------------------------------

async function frameList(tabId) {
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  const out = [];
  const walk = (node) => {
    out.push({ frameId: node.frame.id, url: node.frame.url || "", ordinal: out.length });
    for (const child of node.childFrames || []) walk(child);
  };
  walk(frameTree);
  return out;
}

function formatException(details) {
  const line = details.lineNumber != null ? Math.max(0, details.lineNumber - PREAMBLE_LINES + 1) : null;
  const where = line != null ? ` (line ${line})` : "";
  const desc = details.exception?.description || details.exception?.value;
  return `${details.text || "Uncaught"}${desc ? `: ${desc}` : ""}${where}`;
}

function renderValue(result) {
  if (!result || result.type === "undefined") return "undefined";
  if (result.value !== undefined) {
    return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
  }
  if (result.unserializableValue) return String(result.unserializableValue);
  return result.description || result.type || "undefined";
}

// The isolated world is the default so a hostile page can neither read __ob nor shadow the
// globals an expression relies on; mainWorld is the opt-out for touching page state.
async function evalInFrame(tabId, frame, expression, { mainWorld, allFrames }) {
  let contextId;
  if (mainWorld) {
    if (allFrames) {
      const hit = contextsForTab(tabId).find((c) => c.frameId === frame.frameId && c.isDefault);
      if (!hit) throw new Error("no main-world context tracked for this frame yet");
      contextId = hit.contextId;
    }
  } else {
    const world = await cdp(tabId, "Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "obmcp" });
    contextId = world.executionContextId;
  }

  const res = await cdp(tabId, "Runtime.evaluate", {
    expression: `${STDLIB_GUARDED}\n${expression}`,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) throw new Error(formatException(res.exceptionDetails));
  return renderValue(res.result);
}

async function evalSurface(tabId, frame) {
  const world = await cdp(tabId, "Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "obmcp" });
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression: `${STDLIB_GUARDED}\n__ob.surface()`,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(formatException(res.exceptionDetails));
  return res.result?.value || null;
}

// --- page_outline (L0) ---------------------------------------------------------

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const LANDMARK_TAGS = {
  HEADER: "banner", NAV: "navigation", MAIN: "main", ASIDE: "complementary",
  FOOTER: "contentinfo", SECTION: "region", ARTICLE: "article", DIALOG: "dialog",
};
const LANDMARK_ROLES = new Set([
  "banner", "navigation", "main", "complementary", "contentinfo", "region",
  "search", "form", "dialog", "alertdialog",
]);
const FIELD_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const OUTLINE_CAPS = { headings: 30, landmarks: 15, forms: 15, tables: 10 };

function docReader(doc, strings) {
  const N = doc.nodes;
  const size = N.nodeName.length;
  const str = (i) => (i == null || i < 0 ? "" : strings[i] || "");

  const kids = new Map();
  for (let i = 0; i < size; i++) {
    const p = N.parentIndex ? N.parentIndex[i] : -1;
    if (p >= 0) {
      let a = kids.get(p);
      if (!a) kids.set(p, (a = []));
      a.push(i);
    }
  }

  const y = new Map();
  const L = doc.layout;
  for (let i = 0; i < L.nodeIndex.length; i++) {
    const b = L.bounds[i];
    if (b) y.set(L.nodeIndex[i], Math.round(b[1]));
  }

  const attrs = (i) => {
    const a = N.attributes?.[i] || [];
    const o = {};
    for (let k = 0; k + 1 < a.length; k += 2) o[str(a[k]).toLowerCase()] = str(a[k + 1]);
    return o;
  };

  const subtreeText = (root, cap = 100) => {
    let out = "";
    const stack = [root];
    while (stack.length && out.length < cap * 3) {
      const i = stack.shift();
      if (N.nodeType[i] === 3) out += ` ${str(N.nodeValue[i])}`;
      const c = kids.get(i);
      if (c) for (let j = c.length - 1; j >= 0; j--) stack.unshift(c[j]);
    }
    return out.replace(/\s+/g, " ").trim().slice(0, cap);
  };

  const descendants = (root, pred, cap = 400) => {
    const found = [];
    const stack = [root];
    while (stack.length && found.length < cap) {
      const i = stack.pop();
      if (i !== root && pred(i)) found.push(i);
      const c = kids.get(i);
      if (c) for (const k of c) stack.push(k);
    }
    return found;
  };

  return { N, size, str, kids, y, attrs, subtreeText, descendants, name: (i) => str(N.nodeName[i]) };
}

function collectOutline(doc, strings, refByNode) {
  const d = docReader(doc, strings);
  const out = { headings: [], landmarks: [], forms: [], tables: [] };

  for (let i = 0; i < d.size; i++) {
    if (d.N.nodeType[i] !== 1) continue;
    const tag = d.name(i);
    const a = d.attrs(i);
    const role = (a.role || "").toLowerCase();
    const ref = refByNode ? refByNode.get(d.N.backendNodeId[i]) : null;
    const top = d.y.get(i);

    if (HEADING_TAGS.has(tag) || role === "heading") {
      out.headings.push({
        level: HEADING_TAGS.has(tag) ? Number(tag[1]) : Number(a["aria-level"]) || 2,
        label: d.subtreeText(i, 80) || a["aria-label"] || "",
        ref, top,
      });
    } else if (LANDMARK_TAGS[tag] || LANDMARK_ROLES.has(role)) {
      const kind = role && LANDMARK_ROLES.has(role) ? role : LANDMARK_TAGS[tag];
      // Bare section/article without a label are structural noise, not landmarks.
      const label = a["aria-label"] || a.title || "";
      if ((kind === "region" || kind === "article") && !label) continue;
      out.landmarks.push({ kind, label, ref, top });
    } else if (tag === "FORM") {
      const fields = d.descendants(i, (k) => FIELD_TAGS.has(d.name(k)));
      let hidden = 0;
      for (const f of fields) if ((d.attrs(f).type || "").toLowerCase() === "hidden") hidden++;
      out.forms.push({
        id: a.id || a.name || "",
        method: (a.method || "GET").toUpperCase(),
        action: a.action || "",
        fields: fields.length,
        hidden,
        ref, top,
      });
    } else if (tag === "TABLE") {
      const rows = d.descendants(i, (k) => d.name(k) === "TR");
      let cols = 0;
      if (rows.length) {
        cols = d.descendants(rows[rows.length - 1], (k) => d.name(k) === "TD" || d.name(k) === "TH", 60).length;
      }
      const caps = d.descendants(i, (k) => d.name(k) === "CAPTION", 2);
      out.tables.push({
        label: caps.length ? d.subtreeText(caps[0], 60) : "",
        rows: rows.length,
        cols,
        ref, top,
      });
    }
  }
  return out;
}

function fmtOutlineItem(prefix, body, item) {
  let line = `  ${prefix}${body}`.trimEnd();
  if (item.ref) line += ` ${item.ref}`;
  if (item.top != null) line += ` y${item.top}`;
  return line;
}

function renderOutline(sections, docLabel) {
  const lines = [docLabel];
  const dropped = [];

  const emit = (title, items, cap, render) => {
    if (!items.length) return;
    lines.push(title);
    for (const it of items.slice(0, cap)) lines.push(render(it));
    if (items.length > cap) dropped.push(`${items.length - cap} ${title}`);
  };

  emit("headings", sections.headings, OUTLINE_CAPS.headings, (h) =>
    fmtOutlineItem(`h${h.level} `, `"${h.label}"`, h));
  emit("landmarks", sections.landmarks, OUTLINE_CAPS.landmarks, (l) =>
    fmtOutlineItem(`${l.kind} `, l.label ? `"${l.label}"` : "", l));
  emit("forms", sections.forms, OUTLINE_CAPS.forms, (f) =>
    fmtOutlineItem(
      f.id ? `#${f.id} ` : "",
      `${f.method} ${f.action || "(self)"} · ${f.fields} fields${f.hidden ? `, ${f.hidden} hidden` : ""}`,
      f
    ));
  emit("tables", sections.tables, OUTLINE_CAPS.tables, (t) =>
    fmtOutlineItem(t.label ? `"${t.label}" ` : "", `${t.rows}x${t.cols}`, t));

  return { lines, dropped };
}

// --- page_surface (L1) ---------------------------------------------------------

function fmtField(f) {
  const label = f.name || f.id || (f.value ? `"${String(f.value).slice(0, 24)}"` : "?");
  let s = `${f.type}:${label}`;
  if (f.required) s += "*";
  if (f.type === "hidden" && f.value) s += `=${String(f.value).slice(0, 24)}`;
  if (f.hidden && f.type !== "hidden") s += "(hidden)";
  return s;
}

function renderSurface(s, prefix) {
  const L = [];
  const p = prefix ? `${prefix} ` : "";

  if (s.forms?.length) {
    L.push(`${p}forms ${s.forms.length}`);
    for (const f of s.forms.slice(0, 12)) {
      L.push(`  ${f.id ? `#${f.id}` : f.selector} ${f.method} ${f.action}${f.enctype ? ` enctype=${f.enctype}` : ""}`);
      const fields = f.fields.map(fmtField).join(" ");
      if (fields) L.push(`    ${fields.slice(0, 600)}`);
    }
  }
  if (s.orphanInputs?.length) {
    L.push(`${p}orphan inputs ${s.orphanInputs.length}: ${s.orphanInputs.slice(0, 20).map(fmtField).join(" ")}`);
  }
  if (s.counts) {
    const c = s.counts;
    L.push(`${p}links ${c.links}${c.externalLinks ? ` (${c.externalLinks} external)` : ""}${s.params?.length ? ` · params: ${s.params.slice(0, 30).join(", ")}` : ""}`);
    const ext = (s.scripts || []).filter((x) => x.src).length;
    const inline = (s.scripts || []).length - ext;
    L.push(`${p}scripts ${c.scripts}: ${ext} ext, ${inline} inline (${s.sinks?.inlineBytes || 0}B)`);
  }
  const srcs = (s.scripts || []).filter((x) => x.src).slice(0, 12);
  for (const sc of srcs) {
    L.push(`  ${sc.src}${sc.external ? " [cross-origin]" : ""}${sc.integrity ? " [sri]" : ""}${sc.module ? " [module]" : ""}`);
  }
  if (s.iframes?.length) {
    L.push(`${p}iframes ${s.iframes.length}`);
    for (const f of s.iframes.slice(0, 8)) {
      L.push(`  ${f.src || (f.srcdoc ? "srcdoc" : "(about:blank)")}${f.sandbox ? ` sandbox=${f.sandbox}` : ""}${f.external ? " [cross-origin]" : ""}`);
    }
  }
  if (Array.isArray(s.inlineHandlers) && s.inlineHandlers.length) {
    L.push(`${p}inline handlers ${s.inlineHandlers.length}`);
    for (const h of s.inlineHandlers.slice(0, 8)) L.push(`  ${h.sel} ${h.on}="${h.code}"`);
  } else if (s.inlineHandlers?.truncated) {
    L.push(`${p}inline handlers: skipped, ${s.inlineHandlers.count} elements`);
  }
  if (Array.isArray(s.listeners)) {
    L.push(`${p}clickable ${s.listeners.length} (attrs+roles sweep)`);
  }
  if (s.jsHrefs?.length) L.push(`${p}javascript: hrefs ${s.jsHrefs.length}: ${s.jsHrefs.slice(0, 4).join(" | ")}`);

  const st = s.storage || {};
  const keys = (o) => (o && !o.error ? Object.keys(o) : []);
  const lk = keys(st.local), sk = keys(st.session);
  if (lk.length || sk.length || st.cookies?.length) {
    const bits = [];
    if (lk.length) bits.push(`local ${lk.length}: ${lk.slice(0, 12).join(", ")}`);
    if (sk.length) bits.push(`session ${sk.length}: ${sk.slice(0, 12).join(", ")}`);
    if (st.cookies?.length) bits.push(`cookies: ${st.cookies.slice(0, 12).join(", ")}`);
    L.push(`${p}storage ${bits.join(" · ")}`);
  }
  if (s.csp?.length) {
    for (const c of s.csp) L.push(`${p}csp ${c.via}${c.reportOnly ? " (report-only)" : ""}: ${String(c.policy).slice(0, 300)}`);
  }
  const tally = s.sinks?.tally || {};
  const sinkBits = Object.keys(tally).map((k) => `${k}×${tally[k]}`);
  if (sinkBits.length) L.push(`${p}sinks ${sinkBits.join(" ")}`);
  if (s.hidden) L.push(`${p}hidden inputs ${s.hidden.inputs}, elements ${s.hidden.elements}`);
  if (s.truncated) L.push(`${p}truncated: ${s.counts?.elements} elements exceeds the walk budget; targeted sections are still complete.`);

  return L;
}

// --- handlers ------------------------------------------------------------------

export const handlers = {
  // The only tool here that can mutate the page, so it is the only one that keeps the
  // MCP-group restriction (PLAN §13 Q3).
  async javascript_tool(args, ctx) {
    const { tabId, text: expression } = args;
    if (!expression) return text("Nothing to evaluate: pass text.");
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    await ensureAttached(tabId);
    await ensureDomain(tabId, "Page");
    await ensureDomain(tabId, "Runtime");
    await registerStdlib(tabId);

    const mainWorld = args.mainWorld === true;
    const allFrames = args.allFrames === true;
    const maxChars = clampInt(args.maxChars, JS_MAX_CHARS, 200, 200000);

    let body;
    if (allFrames) {
      const frames = await frameList(tabId);
      const parts = [];
      for (const frame of frames) {
        let value;
        try {
          value = await evalInFrame(tabId, frame, expression, { mainWorld, allFrames });
        } catch (e) {
          value = `Error: ${e.message}`;
        }
        parts.push(`f${frame.ordinal} ${frame.url}\n${value}`);
      }
      body = parts.join("\n\n");
    } else {
      const [main] = await frameList(tabId);
      try {
        body = await evalInFrame(tabId, main, expression, { mainWorld, allFrames: false });
      } catch (e) {
        return text(`Error: ${e.message}`);
      }
    }

    if (args.filename) {
      return maybeSpill(ctx, args.filename, body, "text/plain", body.slice(0, 300));
    }
    if (body.length > maxChars) {
      return text(
        `${body.slice(0, maxChars)}\n… truncated ${body.length - maxChars} of ${body.length} chars.` +
        ` Raise maxChars, narrow the expression, or pass filename to spill to disk.`
      );
    }
    return text(body);
  },

  async page_outline(args) {
    const { tabId } = args;
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Page");
    await ensureDomain(tabId, "DOM");
    await ensureDomain(tabId, "DOMSnapshot");

    // Refs are only resolvable once refs.js has the node in its map, so mint the snapshot
    // first and only emit refs for main-frame nodes it actually knows about.
    const refByNode = new Map();
    try {
      for (const e of await snapshotRefs(tabId)) {
        if ((e.frameOrdinal || 0) === 0 && e.backendNodeId != null && !refByNode.has(e.backendNodeId)) {
          refByNode.set(e.backendNodeId, e.ref);
        }
      }
    } catch {
      // Outline is still useful without clickable refs.
    }

    const snap = await cdp(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
    });
    const docs = snap.documents || [];
    if (!docs.length) return text("No document captured for this tab.");

    const main = docs[0];
    const title = main.title != null ? snap.strings[main.title] || "" : "";
    const head = `page_outline ${snap.strings[main.documentURL] || ""}${title ? ` "${title}"` : ""}` +
      (docs.length > 1 ? ` · ${docs.length} documents` : "");

    const { lines, dropped } = renderOutline(collectOutline(main, snap.strings, refByNode), head);

    for (let i = 1; i < docs.length && i <= 5; i++) {
      const sub = collectOutline(docs[i], snap.strings, null);
      const total = sub.headings.length + sub.landmarks.length + sub.forms.length + sub.tables.length;
      if (!total) continue;
      const url = snap.strings[docs[i].documentURL] || "";
      const r = renderOutline(sub, `frame f${i} ${url}`);
      lines.push(...r.lines);
      dropped.push(...r.dropped);
    }

    if (lines.length === 1) {
      return text(`${head}\nNo headings, landmarks, forms or tables. Try page_surface or read_page.`);
    }
    if (dropped.length) {
      lines.push(`+${dropped.join(", +")} not shown — page_surface for forms/fields, read_page({ref_id}) to expand.`);
    }
    return text(lines.join("\n"));
  },

  async page_surface(args, ctx) {
    const { tabId } = args;
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Page");
    await ensureDomain(tabId, "Runtime");
    await registerStdlib(tabId);

    const frames = await frameList(tabId);
    const merged = [];
    for (const frame of frames) {
      try {
        const surface = await evalSurface(tabId, frame);
        if (surface) merged.push({ frame, surface });
      } catch (e) {
        merged.push({ frame, error: e.message });
      }
    }
    if (!merged.length) return text("No frame could be evaluated on this tab.");

    if (args.filename) {
      const json = JSON.stringify(
        merged.map((m) => ({ frame: `f${m.frame.ordinal}`, url: m.frame.url, ...(m.error ? { error: m.error } : m.surface) })),
        null,
        1
      );
      return maybeSpill(ctx, args.filename, json, "application/json");
    }

    const head = merged[0].surface
      ? `page_surface ${merged[0].surface.url}${merged[0].surface.title ? ` "${merged[0].surface.title}"` : ""}` +
        ` · ${frames.length} frame(s) · ${merged[0].surface.counts?.elements ?? "?"} elements`
      : `page_surface · ${frames.length} frame(s)`;

    const lines = [head];
    let used = head.length;
    let omitted = 0;
    const push = (line) => {
      if (omitted || used + line.length + 1 > SURFACE_MAX_CHARS) {
        omitted += line.length + 1;
        return;
      }
      used += line.length + 1;
      lines.push(line);
    };

    for (const m of merged) {
      const prefix = m.frame.ordinal === 0 ? "" : `f${m.frame.ordinal}`;
      if (m.error) {
        push(`f${m.frame.ordinal} ${m.frame.url} — ${m.error}`);
        continue;
      }
      if (prefix) push(`f${m.frame.ordinal} ${m.frame.url}`);
      for (const line of renderSurface(m.surface, prefix)) push(line);
    }

    const links = merged[0].surface?.links || [];
    if (links.length) {
      const shown = links.slice(0, SURFACE_MAX_LINKS).map((l) => l.href);
      push(`links (${shown.length} of ${links.length}): ${shown.join(" ")}`);
    }
    if (omitted) {
      lines.push(
        `… truncated ${omitted} of ${used + omitted} chars.` +
        ` Pass filename to spill the full surface JSON to disk, or page_outline for a flat summary.`
      );
    }
    return text(lines.join("\n"));
  },

  async read_console_messages(args) {
    const { tabId, pattern, onlyErrors } = args;
    const limit = clampInt(args.limit, 100, 1, 1000);

    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    const msgs = consoleList(tabId, { pattern, limit, onlyErrors, clear: args.clear });
    if (!msgs.length) {
      return text(
        pattern || onlyErrors
          ? "No console messages matching the pattern."
          : "No console messages buffered. Capture starts when the tab is first attached — reload or interact, then call again."
      );
    }

    const body = msgs.map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`).join("\n");
    return text(`Console messages (${msgs.length}):\n${body}`);
  },

  async read_network_requests(args, ctx) {
    const { tabId } = args;
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");
    await ensureDomain(tabId, "Page");

    const opts = {
      filter: args.filter,
      resourceTypes: args.resourceTypes,
      pageIdx: clampInt(args.pageIdx, 0, 0, 10000),
      pageSize: clampInt(args.pageSize, DEFAULT_PAGE_SIZE, 1, 100),
      includePreserved: args.includePreserved === true,
    };

    if (args.filename) {
      const full = netList(tabId, { ...opts, pageIdx: 0, pageSize: 100000 });
      return maybeSpill(ctx, args.filename, full.text, "text/plain");
    }

    const r = netList(tabId, opts);
    return text(r.text);
  },

  async read_network_request(args, ctx) {
    const { tabId, index, part = "response-headers" } = args;
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    const r = await netDetail(tabId, index, part);
    if (args.filename) {
      return maybeSpill(ctx, args.filename, `${r.header}\n\n${r.text}`, "text/plain", r.text.slice(0, 200));
    }
    return text(`${r.header}\n\n${r.text}`);
  },
};
