// Tools 1-10: MCP tab groups, navigation, input, and page reading.

import { ensureAttached, ensureDomain, cdp, captureScreenshot, detach, setViewport, CAPTURE_W, CAPTURE_H } from "./cdp.js";
import { snapshotRefs, resolveRefForAction, formatRef } from "./refs.js";
import { contexts, syncContexts, contextOfTab, resolveContext, isInGroup, formatTabContext } from "./contexts.js";

const DEFAULT_MAX_CHARS = 20000;
const SNAPSHOT_MAX_CHARS = 2000;
const LOAD_TIMEOUT_MS = 10000;

// Refs minted by refs.js: e17, f2e17, ba3f1c9d2f2e17. Anything else is a content-script ref_N.
const CDP_REF = /^(?:b[0-9a-f]{1,16})?(?:f\d+)?e\d+$/;

const CLICK_ACTIONS = new Set(["left_click", "right_click", "double_click", "triple_click"]);

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "option", "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton",
  "switch", "tab", "textarea", "treeitem", "disclosuretriangle",
]);

const OUTLINE_ROLES = new Set([
  "heading", "banner", "navigation", "main", "complementary", "contentinfo",
  "region", "form", "search", "table", "dialog", "alertdialog", "article",
]);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// formatTabContext owns the one rendering of a context; accept either the bare markdown or a
// full result object so a prefix can be prepended without knowing which it returned.
function tabContextResult(entries, prefix) {
  const rendered = formatTabContext(entries);
  const body = typeof rendered === "string" ? rendered : rendered.content[0].text;
  return text(prefix ? prefix + "\n\n" + body : body);
}

// --- Key and modifier parsing ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function modifierBit(part) {
  if (part === "ctrl" || part === "control") return 2;
  if (part === "alt") return 1;
  if (part === "shift") return 8;
  if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") return 4;
  return 0;
}

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    const bit = modifierBit(part);
    if (bit) modifiers |= bit;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  for (const part of modStr.split("+")) modifiers |= modifierBit(part.trim().toLowerCase());
  return modifiers;
}

// --- Mouse ---
async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
}

// --- Content script (still backs find and legacy ref_N form input) ---
async function sendContentMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Ref tree rendering (shared by read_page and the includeSnapshot block) ---
function refOf(entry, browserId) {
  return entry.ref || formatRef(browserId, entry.frameOrdinal || 0, entry.backendNodeId);
}

function refLine(entry, ref) {
  let line = "";
  if (entry.role) line += entry.role;
  if (entry.name) line += ` "${String(entry.name).slice(0, 100)}"`;
  line += ` [${ref}]`;
  if (entry.level) line += ` level=${entry.level}`;
  if (entry.url) line += ` href="${String(entry.url).slice(0, 100)}"`;
  if (entry.value) line += ` value="${String(entry.value).slice(0, 60)}"`;
  if (entry.checked != null) line += ` checked=${entry.checked}`;
  if (entry.expanded != null) line += ` expanded=${entry.expanded}`;
  if (entry.disabled) line += " disabled";
  return line.trimStart();
}

function renderTree(entries, { keep, maxChars, browserId }) {
  const lines = [];
  let used = 0;
  let dropped = 0;

  for (const entry of entries) {
    if (!keep(entry)) continue;
    const indent = "  ".repeat(Math.min(entry.depth || 0, 12));
    const line = indent + refLine(entry, refOf(entry, browserId));
    // Keep counting past the budget so the footer can say how much was actually left behind.
    if (used + line.length + 1 > maxChars) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  return { text: lines.join("\n"), shown: lines.length, dropped, used };
}

function keepInteractive(entry) {
  return entry.interactive === true || INTERACTIVE_ROLES.has(entry.role);
}

function keepOutline(entry) {
  return OUTLINE_ROLES.has(entry.role) || keepInteractive(entry);
}

// page_outline-shaped block appended by navigate/computer/form_input when includeSnapshot is set.
async function snapshotBlock(tabId, ctx) {
  let entries;
  try {
    entries = await snapshotRefs(tabId);
  } catch (e) {
    return `## Snapshot\n(unavailable: ${e.message})`;
  }
  const r = renderTree(entries, { keep: keepOutline, maxChars: SNAPSHOT_MAX_CHARS, browserId: ctx?.browserId });
  if (!r.text) return "";
  const more = r.dropped ? `\n… ${r.dropped} more omitted; read_page for the rest.` : "";
  return `## Snapshot\n${r.text}${more}`;
}

async function withSnapshot(line, args, tabId, ctx) {
  if (!args.includeSnapshot) return text(line);
  const block = await snapshotBlock(tabId, ctx);
  return text(block ? `${line}\n\n${block}` : line);
}

// --- Navigation helpers ---
function normalizeUrl(url) {
  if (/^https?:\/\//i.test(url) || url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("brave:")) {
    return url;
  }
  // Repair a broken protocol prefix ("hps://", "http:/", "ht://") rather than gluing https:// onto it.
  return "https://" + url.replace(/^[a-z]{1,5}:\/+/i, "");
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Bounded so a hanging page cannot hold the service worker until it is killed.
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, LOAD_TIMEOUT_MS);
  });
}

// The Network domain belongs to net.js, so read the status off the navigation timing entry
// instead of racing it for events.
async function navigationStatus(tabId) {
  try {
    const r = await cdp(tabId, "Runtime.evaluate", {
      expression: "(performance.getEntriesByType('navigation')[0]||{}).responseStatus||0",
      returnByValue: true,
    });
    const v = r?.result?.value;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

// --- Form value setter, run against the resolved node in the page ---
const SET_VALUE_FN = `function(value) {
  const pick = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === "input" || t === "textarea" || t === "select") return el;
    const root = el.shadowRoot || el;
    return root.querySelector("input, textarea, select");
  };
  const target = pick(this) || this;
  const tag = target.tagName.toLowerCase();
  const type = (target.type || "").toLowerCase();

  if (tag === "select") {
    const opt = Array.from(target.options).find(
      (o) => o.value === String(value) || o.textContent.trim() === String(value)
    );
    target.value = opt ? opt.value : String(value);
  } else if (type === "checkbox" || type === "radio") {
    const want = value === true || value === "true";
    if (target.checked !== want) target.click();
    return { ok: true, checked: target.checked };
  } else if (target.isContentEditable) {
    target.textContent = String(value);
  } else {
    // React and friends install a value tracker that swallows a plain assignment; going through
    // the prototype setter is what makes the change visible to the framework.
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(target, String(value));
    else target.value = String(value);
  }

  target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { ok: true, value: target.value };
}`;

export const handlers = {
  async tabs_context_mcp(args) {
    const { incognito, windowId, createIfEmpty } = args;

    if (createIfEmpty || windowId != null) {
      await resolveContext({ windowId, incognito, createIfEmpty: !!createIfEmpty });
    } else {
      await syncContexts();
    }

    let entries = [...contexts].map(([id, ctx]) => ({ windowId: id, ctx }));
    if (windowId != null) entries = entries.filter((e) => e.windowId === windowId);
    if (incognito !== undefined) entries = entries.filter((e) => e.ctx.incognito === !!incognito);

    if (entries.length === 0) {
      return text(
        "No MCP tab group exists. Use createIfEmpty: true to create one (add incognito: true for an incognito window)."
      );
    }

    const withTabs = [];
    for (const e of entries) {
      withTabs.push({ ...e, tabs: await chrome.tabs.query({ groupId: e.ctx.groupId }) });
    }
    return tabContextResult(withTabs);
  },

  async tabs_create_mcp(args) {
    const { incognito, windowId, newWindow } = args;
    const { windowId: winId, ctx } = await resolveContext({ windowId, incognito, newWindow });

    // Create directly in the target window - omitting windowId lands the tab in whatever window
    // is currently focused, which is the wrong one as soon as more than one MCP window exists.
    // about:blank, not the chrome://newtab/ default: the debugger cannot attach to a chrome:// URL,
    // so a newtab-parked tab refuses every attach until the first navigation has already finished —
    // which is exactly too late for navigate to enable Network and see the document request.
    // contexts.js opens MCP *windows* at about:blank for the same reason.
    const tab = await chrome.tabs.create({ active: true, windowId: winId, url: "about:blank" });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: ctx.groupId });
    ctx.tabs.add(tab.id);

    const tabs = await chrome.tabs.query({ groupId: ctx.groupId });
    const where = `window ${winId}${ctx.incognito ? ", incognito" : ""}`;
    return tabContextResult([{ windowId: winId, ctx, tabs }], `Created tab ${tab.id} (${where}).`);
  },

  async tabs_close_mcp(args) {
    const { tabId, windowId } = args;
    if (tabId == null && windowId == null) {
      return text("Provide tabId to close one tab, or windowId to close a whole MCP window.");
    }

    // Whole window. Gated on the context map so a stray windowId can never close one of the
    // user's own windows - only windows this extension opened are closable.
    if (tabId == null) {
      await syncContexts();
      const ctx = contexts.get(windowId);
      if (!ctx) {
        return text(`No MCP window with windowId ${windowId}. Use tabs_context_mcp to list open MCP windows.`);
      }
      const tabs = await chrome.tabs.query({ groupId: ctx.groupId });
      for (const t of tabs) {
        try { await detach(t.id); } catch {}
      }
      await chrome.windows.remove(windowId);
      contexts.delete(windowId);
      return text(`Closed MCP window ${windowId}${ctx.incognito ? " (incognito)" : ""} and its ${tabs.length} tab(s).`);
    }

    const found = await contextOfTab(tabId);
    if (!found) return notInGroup(tabId);
    const { windowId: winId, ctx } = found;

    try { await detach(tabId); } catch {}
    await chrome.tabs.remove(tabId);
    ctx.tabs.delete(tabId);

    // Chrome destroys a group with its last tab, and the window with its last tab, so the
    // context can be gone entirely now.
    const remaining = await chrome.tabs.query({ groupId: ctx.groupId });
    if (remaining.length === 0) {
      contexts.delete(winId);
      return text(`Closed tab ${tabId}. It was the last tab in MCP window ${winId}, which is now closed too.`);
    }

    return tabContextResult([{ windowId: winId, ctx, tabs: remaining }], `Closed tab ${tabId}.`);
  },

  async navigate(args, ctx) {
    const { url, tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    const started = Date.now();

    // Network.enable has to land *before* the navigation starts or the whole load is invisible:
    // the log is populated by CDP events, so a lazily-enabled domain misses everything already
    // in flight. read_network_requests enabling it on first call is too late by definition —
    // "navigate, then read the log" would always come back empty, and sources_download would
    // ship an _unexercised.json that degenerates to the full static set. Tolerated on failure
    // for the same reason find does: a refused attach should cost the log, not the navigation.
    try {
      await ensureDomain(tabId, "Network");
      await ensureDomain(tabId, "Page");
    } catch {}

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      const targetUrl = normalizeUrl(String(url));
      try {
        new URL(targetUrl);
      } catch {
        return text(`Invalid URL: "${url}". Could not parse as a valid URL.`);
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    await waitForLoad(tabId);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const tab = await chrome.tabs.get(tabId);
    const status = await navigationStatus(tabId);
    const stamp = status ? `${status}, ${elapsed}s` : `${elapsed}s`;

    let line = `Navigated → ${tab.url} (${stamp})`;
    if (tab.status !== "complete") line += " (still loading)";
    if (tab.title) line += ` · title "${tab.title}"`;

    return withSnapshot(line, args, tabId, ctx);
  },

  async computer(args, ctx) {
    const { action, tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    let coordinate = args.coordinate;
    let inputPath = "";
    let alreadyClicked = false;
    let refScrolled = false;

    if (args.ref && !coordinate) {
      // read_page hands out CDP refs, find hands out content-script refs; accept both, as
      // form_input does - the tool description sends the model to either source.
      if (!CDP_REF.test(String(args.ref))) {
        const c = (await sendContentMessage(tabId, { type: "getRefCoordinates", ref: args.ref }))?.result;
        if (!c) return text(`Ref ${args.ref} not found on the page. Run find again, or read_page for a stable ref.`);
        coordinate = [c.x, c.y];
        inputPath = " · trusted input";
      } else {
        // Only a click action should pay for refs.js's clicking fallback on a box-less node.
        let target;
        try {
          target = await resolveRefForAction(tabId, args.ref, { click: CLICK_ACTIONS.has(action) });
        } catch (e) {
          return text(e.message);
        }
        refScrolled = true;
        if (target.x != null) {
          coordinate = [Math.round(target.x), Math.round(target.y)];
          inputPath = " · trusted input";
        } else if (target.clicked) {
          // The fallback path in refs.js dispatches el.click() itself, so the click already
          // happened - and it happened with isTrusted=false, which the page can see.
          inputPath = " · synthetic click (isTrusted=false)";
          alreadyClicked = true;
        } else {
          return text(
            `Ref ${args.ref} has no layout box (display:contents, zero-size, or off-document), ` +
              `so ${action} has no point to aim at. Pass a coordinate, or use form_input for a field.`
          );
        }
      }
    }

    const modifiers = parseModifierString(args.modifiers);
    const needsCoordinate = () => text(`coordinate or ref is required for ${action}`);

    switch (action) {
      case "screenshot": {
        const { base64, width, height } = await captureScreenshot(tabId, { full: args.full === true });
        return {
          content: [
            { type: "text", text: `Screenshot ${width}x${height}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        const button = action === "right_click" ? "right" : "left";
        const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        const verb = action === "right_click" ? "Right-clicked" :
          action === "double_click" ? "Double-clicked" :
          action === "triple_click" ? "Triple-clicked" : "Clicked";

        if (alreadyClicked) {
          return withSnapshot(`${verb} ${args.ref}${inputPath}`, args, tabId, ctx);
        }
        if (!coordinate) return needsCoordinate();
        await mouseClick(tabId, coordinate[0], coordinate[1], { button, clickCount, modifiers });
        return withSnapshot(`${verb} at (${coordinate[0]}, ${coordinate[1]})${inputPath}`, args, tabId, ctx);
      }

      case "hover": {
        if (!coordinate) return needsCoordinate();
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return withSnapshot(`Hovered at (${coordinate[0]}, ${coordinate[1]})${inputPath}`, args, tabId, ctx);
      }

      case "type": {
        if (!args.text) return text("text is required for type action");
        await ensureAttached(tabId);
        // Character by character: pages that key off individual input events (autocomplete,
        // masked fields) do not react to a single bulk insert.
        for (const char of args.text) {
          await cdp(tabId, "Input.insertText", { text: char });
          await sleep(10);
        }
        const shown = args.text.length > 50 ? args.text.slice(0, 50) + "..." : args.text;
        return withSnapshot(`Typed "${shown}"`, args, tabId, ctx);
      }

      case "key": {
        if (!args.text) return text("text is required for key action");
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key,
              code,
              modifiers: keyMod,
              windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: keyMod });
            await sleep(30);
          }
        }
        return withSnapshot(`Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}`, args, tabId, ctx);
      }

      case "scroll": {
        if (!coordinate) return needsCoordinate();
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        });
        await sleep(300);
        return withSnapshot(
          `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})`,
          args, tabId, ctx
        );
      }

      case "scroll_to": {
        // A CDP ref resolve already scrolls the node into view, so there is nothing left to do.
        if (refScrolled) return withSnapshot(`Scrolled ${args.ref} into view${inputPath}`, args, tabId, ctx);
        if (!coordinate) return needsCoordinate();
        await cdp(tabId, "Runtime.evaluate", {
          expression: `window.scrollTo(${Number(coordinate[0])}, ${Number(coordinate[1])})`,
        });
        await sleep(300);
        return withSnapshot(`Scrolled to (${coordinate[0]}, ${coordinate[1]})`, args, tabId, ctx);
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return withSnapshot(`Waited for ${duration} second${duration !== 1 ? "s" : ""}`, args, tabId, ctx);
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return text("start_coordinate and coordinate are required for left_click_drag");
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          await dispatchMouse(tabId, "mouseMoved", sx + ((ex - sx) * i) / steps, sy + ((ey - sy) * i) / steps, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return withSnapshot(`Dragged from (${sx}, ${sy}) to (${ex}, ${ey})`, args, tabId, ctx);
      }

      case "zoom": {
        const region = args.region;
        if (!Array.isArray(region) || region.length !== 4) {
          return text("region [x0, y0, x1, y1] is required for zoom");
        }
        const [x0, y0, x1, y1] = region.map(Number);
        const w = Math.max(1, Math.round(x1 - x0));
        const h = Math.max(1, Math.round(y1 - y0));
        await ensureAttached(tabId);

        // Page.captureScreenshot clips in document coordinates, but the region the model read off
        // a screenshot is viewport-relative, so shift it by the current scroll offset.
        let sx = 0;
        let sy = 0;
        try {
          const off = await cdp(tabId, "Runtime.evaluate", {
            expression: "[window.scrollX, window.scrollY]",
            returnByValue: true,
          });
          if (Array.isArray(off?.result?.value)) [sx, sy] = off.result.value;
        } catch {}

        const scale = Math.max(1, Math.min(2, CAPTURE_W / w, CAPTURE_H / h));
        const shot = await cdp(tabId, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 85,
          optimizeForSpeed: true,
          captureBeyondViewport: false,
          clip: { x: x0 + sx, y: y0 + sy, width: w, height: h, scale },
        });
        return {
          content: [
            {
              type: "text",
              text: `Zoom [${x0}, ${y0}, ${x1}, ${y1}] → ${Math.round(w * scale)}x${Math.round(h * scale)}`,
            },
            { type: "image", data: shot.data, mimeType: "image/jpeg" },
          ],
        };
      }

      default:
        return text(`Unknown computer action: ${action}`);
    }
  },

  async read_page(args, ctx) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    const filter = args.filter === "all" ? "all" : "interactive";
    const maxChars = clampInt(args.max_chars, DEFAULT_MAX_CHARS, 500, 200000);
    const maxDepth = clampInt(args.depth, Infinity, 1, 100);

    let entries = await snapshotRefs(tabId);

    if (args.ref_id) {
      const rootIdx = entries.findIndex((e) => refOf(e, ctx?.browserId) === args.ref_id);
      if (rootIdx === -1) {
        return text(`Ref ${args.ref_id} not found in the current page snapshot. Try capturing new snapshot.`);
      }
      // Entries come back in document order, so a subtree is the run of deeper nodes that follows.
      const rootDepth = entries[rootIdx].depth || 0;
      const subtree = [entries[rootIdx]];
      for (let i = rootIdx + 1; i < entries.length && (entries[i].depth || 0) > rootDepth; i++) {
        subtree.push(entries[i]);
      }
      entries = subtree;
    }

    const keep = (e) => (e.depth || 0) <= maxDepth && (filter === "all" ? !!(e.role || e.name) : keepInteractive(e));
    const r = renderTree(entries, { keep, maxChars, browserId: ctx?.browserId });

    if (r.shown === 0 && r.dropped === 0) {
      return text(
        filter === "interactive"
          ? "No interactive elements found. Try filter: \"all\", or page_surface for hidden fields."
          : "No elements found."
      );
    }

    let out = r.text;
    if (r.dropped) {
      out += `\n… truncated: ${r.dropped} of ${r.shown + r.dropped} elements omitted at ${maxChars} chars.` +
        ` Raise max_chars, or pass ref_id to read one subtree at a time.`;
    }
    return text(out);
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    // Attach first: the 1344x756 override relayouts the page, and coordinates measured before
    // it lands would be stale by the time the very next action applies it. find itself needs no
    // debugger, so a refused attach only costs that alignment.
    try { await ensureAttached(tabId); } catch {}

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) return text(`No elements found matching "${query}"`);

    let out = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      out += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }
    return text(out);
  },

  async form_input(args, ctx) {
    const { ref, value, tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    // read_page hands out CDP refs, find hands out content-script refs; accept both.
    if (CDP_REF.test(String(ref))) {
      let target;
      try {
        // Setting a value must not click the field: only the node identity is wanted here.
        target = await resolveRefForAction(tabId, ref, { click: false });
      } catch (e) {
        return text(e.message);
      }
      const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
      const objectId = resolved?.object?.objectId;
      if (!objectId) return text(`Ref ${ref} could not be resolved to a live node.`);

      const res = await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: SET_VALUE_FN,
        arguments: [{ value: value === undefined ? "" : value }],
        returnByValue: true,
      }, target.sessionId);

      if (res?.exceptionDetails) {
        return text(`Error: ${res.exceptionDetails.text || "could not set value"}`);
      }
      const out = res?.result?.value || {};
      const now = out.checked != null ? `checked=${out.checked}` : `"${out.value ?? value}"`;
      return withSnapshot(`Set ${ref} to ${now}`, args, tabId, ctx);
    }

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;
    if (result?.error) return text(`Error: ${result.error}`);
    const now = result?.checked != null ? `checked=${result.checked}` : `"${result?.value ?? value}"`;
    return withSnapshot(`Set ${ref} to ${now}`, args, tabId, ctx);
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    const maxChars = clampInt(args.max_chars, DEFAULT_MAX_CHARS, 500, 200000);
    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return text("Error: Could not extract page text");

    let data;
    try {
      data = JSON.parse(resp.result);
    } catch {
      return text(resp.result.slice(0, maxChars));
    }

    const header = `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n`;
    const budget = Math.max(200, maxChars - header.length);
    const full = data.text || "";
    if (full.length <= budget) return text(header + full);

    return text(
      header + full.slice(0, budget) +
      `\n… truncated: ${full.length - budget} of ${full.length} chars omitted at ${maxChars} chars. Raise max_chars to read more.`
    );
  },

  async resize_window(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return notInGroup(tabId);

    const width = clampInt(args.width, CAPTURE_W, 200, 4000);
    const height = clampInt(args.height, CAPTURE_H, 200, 4000);

    // Re-point the emulation override rather than resizing the OS window: the override is what
    // screenshots and Input.dispatchMouseEvent coordinates both follow, so moving it is what
    // actually changes the coordinate space, and it keeps the two in step. It goes through
    // cdp.js so the capture path reads the new size instead of the pinned default.
    await setViewport(tabId, width, height);

    let note = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === "normal") await chrome.windows.update(win.id, { width, height });
      else note = ` (window left ${win.state})`;
    } catch {
      note = " (window unchanged)";
    }

    return text(`Viewport now ${width}x${height}${note}. Screenshots and coordinates use this space.`);
  },
};
