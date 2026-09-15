// chrome.debugger attach/detach, domain enable, and screenshot capture.

// 1344x756 = 48x27 exact 28px patches => 1296 visual tokens with zero padding waste,
// true 16:9, and under both the standard and high-resolution tiers so the server never
// downscales it and returned coordinates stay 1:1 with Input.dispatchMouseEvent.
export const CAPTURE_W = 1344;
export const CAPTURE_H = 756;

// Past this the long-edge clamp collapses the short edge: 1344x8000 renders 487px wide.
const MAX_FULL_ASPECT = 2;

const MAX_SCREENSHOTS = 10;

const attachedTabs = new Map(); // tabId -> { enabledDomains: Set, viewport: {width, height} }
const attaching = new Map(); // tabId -> in-flight attach promise
const probing = new Map(); // tabId -> promise that settles when withTransientSession has detached again
const screenshotStore = new Map(); // imageId -> base64

let imageSeq = 0;

// Chrome's own defaults are ~100MB total / 10MB per resource, applied *per attached tab*.
// §5.4's eager body capture is what makes the smaller window safe.
const DOMAIN_DEFAULTS = {
  Network: { maxTotalBufferSize: 32000000, maxResourceBufferSize: 4000000 },
};

export function attachedTabIds() {
  return Array.from(attachedTabs.keys());
}

export async function ensureAttached(tabId) {
  // A transient probe session is torn down by its own detach, and chrome.debugger fires no onDetach
  // for that, so an attach that tolerated it as "already attached" would be left recorded as held
  // while no session exists — every later command on the tab would fail until it closed.
  while (probing.has(tabId)) await probing.get(tabId);
  if (attachedTabs.has(tabId)) return;
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = doAttach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

async function doAttach(tabId) {
  let preexisting = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // The service worker can be torn down while the attachment survives; Chrome then
    // reports "Another debugger is already attached" for what is still our own session.
    if (!/already attached/i.test(String(e?.message || e))) throw e;
    preexisting = true;
  }
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  try {
    await pinViewport(tabId);
    // Agent tabs open in the background, so they are hidden, and a hidden page gets no rAF, timers
    // clamped to ~1 s, and — the fatal part — no ack for Input.dispatchMouseEvent mouseMoved, which
    // hung every click, hover and drag until the client's timeout (6 of 6 on Brave 1.95). Emulated
    // focus makes the page visible and focused to itself without activating any tab, window or app
    // (moves ack in 10-17 ms). Per session: a detach clears it, so every attach and re-attach sets it.
    // Tolerated: a browser that rejects it still gets clicks through tools.core.js's move timeout.
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch {}
  } catch (e) {
    // The first command is what proves the tolerated attach really was ours. If it was not,
    // the entry has to go — ensureAttached short-circuits on it, so leaving it behind makes
    // every later call on this tab fail with no way back.
    attachedTabs.delete(tabId);
    throw preexisting
      ? new Error(
          `Cannot attach to tab ${tabId}: another debugger is already attached. ` +
            `Close DevTools on that tab and retry.`
        )
      : e;
  }
}

// Runs fn with a debugger session on tabId, for a read-only look at a tab no tool may go on to use
// (brave-containers.js classifying a group through the human's own tab). A tab this module does not
// hold yet gets a session of its own that is detached again afterwards: no viewport pin re-laying out
// the human's page, no focus emulation, no session (and "is debugging" bar) left behind. A tab that is
// already held, or being attached, is read through that session, which stays.
export async function withTransientSession(tabId, fn) {
  while (probing.has(tabId)) await probing.get(tabId);
  if (!attachedTabs.has(tabId) && !attaching.has(tabId)) {
    let release;
    probing.set(tabId, new Promise((resolve) => (release = resolve)));
    const done = () => {
      probing.delete(tabId);
      release();
    };
    let attached = false;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    } catch (e) {
      done();
      // Our own session that outlived a worker restart, or another debugger: ensureAttached (below)
      // is what tells the two apart.
      if (!/already attached/i.test(String(e?.message || e))) throw e;
    }
    if (attached) {
      try {
        return await fn();
      } finally {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {}
        done();
      }
    }
  }
  await ensureAttached(tabId);
  return fn();
}

// The override is pinned for the life of the attachment, not cleared after each capture.
// Clearing it between the screenshot and the click relayouts the page back to the host
// window size, so the 1344x756 coordinates the model just read would land on the wrong
// element. detach() clears it, so it never outlives the session.
async function pinViewport(tabId, width = CAPTURE_W, height = CAPTURE_H) {
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const state = attachedTabs.get(tabId);
  if (state) state.viewport = { width, height };
}

// resize_window re-points the override; it must go through here so the capture path and the
// emulated page never hold two different ideas of the viewport size.
export async function setViewport(tabId, width, height) {
  await ensureAttached(tabId);
  await pinViewport(tabId, width, height);
}

export function viewportOf(tabId) {
  return attachedTabs.get(tabId)?.viewport || { width: CAPTURE_W, height: CAPTURE_H };
}

export async function ensureDomain(tabId, domain, params) {
  await ensureAttached(tabId);
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error(`Not attached to tab ${tabId}`);
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {
    ...(DOMAIN_DEFAULTS[domain] || {}),
    ...(params || {}),
  });
  state.enabledDomains.add(domain);
}

export async function cdp(tabId, method, params = {}, sessionId) {
  await ensureAttached(tabId);
  // Flattened OOPIF sessions are addressed by adding sessionId to the debuggee.
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return chrome.debugger.sendCommand(target, method, params);
}

export async function detach(tabId) {
  const wasAttached = attachedTabs.delete(tabId);
  attaching.delete(tabId);
  if (!wasAttached) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {});
  } catch {}
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

// Chrome detaches us when the user dismisses the debugging infobar or the tab dies;
// only local bookkeeping needs clearing, the transport is already gone.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attachedTabs.delete(source.tabId);
    attaching.delete(source.tabId);
  }
});

export async function captureScreenshot(tabId, { full = false } = {}) {
  await ensureAttached(tabId);

  const vp = viewportOf(tabId);
  let width = vp.width;
  let height = vp.height;

  if (full) {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics");
    const content = metrics.cssContentSize || metrics.contentSize || {};
    const contentHeight = Math.ceil(content.height || vp.height);
    const ratio = contentHeight / vp.width;
    if (ratio > MAX_FULL_ASPECT) {
      throw new Error(
        `Full-page capture refused: content is ${vp.width}x${contentHeight} (${ratio.toFixed(1)}:1). ` +
          `Past ${MAX_FULL_ASPECT}:1 the long-edge clamp crushes the short edge — an 8000px-tall capture ` +
          `renders 487px wide, so body text is unreadable and the token cost is unchanged. ` +
          `Use page_outline for structure, page_surface for the full attack surface (both flat in page length), ` +
          `or scroll and capture viewport-sized tiles.`
      );
    }
    height = Math.max(vp.height, contentHeight);
  }

  // Quality is not a token lever — only dimensions are billed — so it is set once and
  // never re-tuned, and there is no size-triggered downgrade pass.
  const result = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 85,
    optimizeForSpeed: true,
    captureBeyondViewport: !!full,
    ...(full ? { clip: { x: 0, y: 0, width, height, scale: 1 } } : {}),
  });

  const base64 = result.data;
  const imageId = `screenshot_${Date.now()}_${++imageSeq}`;
  screenshotStore.set(imageId, base64);
  while (screenshotStore.size > MAX_SCREENSHOTS) {
    screenshotStore.delete(screenshotStore.keys().next().value);
  }

  return { base64, width, height, imageId };
}

export function getScreenshot(imageId) {
  return screenshotStore.get(imageId) || null;
}
