// backendNodeId-based element refs. backendNodeId is stable for a node's lifetime inside
// a renderer, so refs survive re-snapshots with no bookkeeping — but it is unique only
// within a CDP session, and OOPIFs each get their own. Hence the three-part key.

import { cdp, ensureAttached, ensureDomain } from "./cdp.js";
import { getIdentity } from "./identity.js";

const ROOT = "root"; // stand-in sessionId for the tab's own session

const snapshots = new Map(); // tabId -> snapshot
const oopifSessions = new Map(); // tabId -> Map<targetId(=frameId), sessionId>
const primedSessions = new Set(); // `${tabId}:${sessionId}` that have had DOM primed

// browserId is 8 hex chars (identity.js). Fixing the length is what keeps the grammar
// unambiguous — a variable-length id containing 'f' or 'e' would swallow the other segments.
const REF_RE = /^(?:b([0-9a-f]{8}))?(?:f(\d+))?e(\d+)$/;

export function formatRef(browserId, frameOrdinal, backendNodeId) {
  const b = browserId ? `b${browserId}` : "";
  const f = frameOrdinal ? `f${frameOrdinal}` : "";
  return `${b}${f}e${backendNodeId}`;
}

export function parseRef(ref) {
  const m = REF_RE.exec(String(ref || "").trim());
  if (!m) return null;
  return {
    browserId: m[1] || null,
    frameOrdinal: m[2] ? Number(m[2]) : 0,
    backendNodeId: Number(m[3]),
  };
}

function keyOf(browserId, sessionId, backendNodeId) {
  return `${browserId}:${sessionId || ROOT}:${backendNodeId}`;
}

// Auto-attach is not recursive: setting it on a session only surfaces that session's
// direct OOPIF children, so it has to be re-issued on every new level.
async function autoAttachAll(tabId) {
  const issued = new Set();
  let level = [undefined];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    for (const sessionId of level) {
      try {
        await cdp(
          tabId,
          "Target.setAutoAttach",
          { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
          sessionId
        );
      } catch {}
      issued.add(sessionId);
    }
    // attachedToTarget lands asynchronously on the event listener below.
    await new Promise((r) => setTimeout(r, 50));
    const known = oopifSessions.get(tabId);
    level = known ? [...known.values()].filter((s) => !issued.has(s)) : [];
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === "Target.attachedToTarget") {
    // For an iframe target the targetId is the frameId, which is how a frame from
    // Page.getFrameTree gets matched to the session that can address its nodes.
    const info = params?.targetInfo;
    if (!info || !params.sessionId) return;
    let map = oopifSessions.get(tabId);
    if (!map) oopifSessions.set(tabId, (map = new Map()));
    map.set(info.targetId, params.sessionId);
  } else if (method === "Target.detachedFromTarget") {
    const map = oopifSessions.get(tabId);
    if (!map) return;
    for (const [targetId, sessionId] of map) {
      if (sessionId === params?.sessionId) map.delete(targetId);
    }
  }
});

function collectFrames(node, parentId, sessionOf, out) {
  const frame = node.frame;
  const frameId = frame.id;
  out.push({
    frameId,
    parentFrameId: parentId,
    url: frame.url || "",
    loaderId: frame.loaderId || null,
    sessionId: sessionOf(frameId),
    ordinal: out.length,
  });
  for (const child of node.childFrames || []) collectFrames(child, frameId, sessionOf, out);
}

async function enumerateFrames(tabId) {
  const sessions = oopifSessions.get(tabId) || new Map();
  const sessionOf = (frameId) => sessions.get(frameId) || null;

  const frames = [];
  const seen = new Set();
  const push = (list) => {
    for (const f of list) {
      if (seen.has(f.frameId)) continue;
      seen.add(f.frameId);
      f.ordinal = frames.length;
      frames.push(f);
    }
  };

  const root = await cdp(tabId, "Page.getFrameTree");
  const rootFrames = [];
  collectFrames(root.frameTree, null, sessionOf, rootFrames);
  push(rootFrames);

  // An OOPIF appears in the parent tree as a stub with no reachable nodes; its own
  // session is the only place its subtree exists.
  for (const [frameId, sessionId] of sessions) {
    try {
      const sub = await cdp(tabId, "Page.getFrameTree", {}, sessionId);
      const subFrames = [];
      collectFrames(sub.frameTree, null, () => sessionId, subFrames);
      for (const f of subFrames) f.sessionId = sessionId;
      const known = frames.find((f) => f.frameId === sub.frameTree.frame.id);
      if (known) {
        known.sessionId = sessionId;
        known.loaderId = sub.frameTree.frame.loaderId || known.loaderId;
        push(subFrames.slice(1));
      } else {
        push(subFrames);
      }
    } catch {}
  }
  return frames;
}

async function axTreeFor(tabId, frame) {
  try {
    await cdp(tabId, "Accessibility.enable", {}, frame.sessionId);
  } catch {}
  try {
    const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree", { frameId: frame.frameId }, frame.sessionId);
    return nodes || [];
  } catch {
    // A session's own root frame rejects an explicit frameId on some Chrome builds.
    try {
      const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree", {}, frame.sessionId);
      return nodes || [];
    } catch {
      return [];
    }
  }
}

export async function snapshotRefs(tabId) {
  await ensureAttached(tabId);
  await ensureDomain(tabId, "Page");
  const { browserId } = await getIdentity();

  await autoAttachAll(tabId);
  const frames = await enumerateFrames(tabId);

  const byKey = new Map();
  const entries = [];
  for (const frame of frames) {
    for (const node of await axTreeFor(tabId, frame)) {
      const backendNodeId = node.backendDOMNodeId;
      if (backendNodeId == null) continue;
      const entry = {
        ref: formatRef(null, frame.ordinal, backendNodeId),
        browserId,
        backendNodeId,
        sessionId: frame.sessionId,
        frameId: frame.frameId,
        frameOrdinal: frame.ordinal,
        role: node.role?.value || "",
        name: node.name?.value || "",
        value: node.value?.value,
        ignored: !!node.ignored,
        axNodeId: node.nodeId,
        parentAxId: node.parentId || null,
        childAxIds: node.childIds || [],
        properties: node.properties || [],
      };
      byKey.set(keyOf(browserId, frame.sessionId, backendNodeId), entry);
      entries.push(entry);
    }
  }

  snapshots.set(tabId, {
    browserId,
    frames,
    byKey,
    entries,
    loaderIds: new Set(frames.map((f) => f.loaderId).filter(Boolean)),
  });
  return entries;
}

// Only a *new* loaderId means a new document. pushState/hash navigations arrive as
// Page.navigatedWithinDocument, which must never reach this function — the DOM survives
// them and so do the refs.
export function invalidate(tabId, loaderId) {
  const snap = snapshots.get(tabId);
  if (!snap) return false;
  if (loaderId && snap.loaderIds.has(loaderId)) return false;
  snapshots.delete(tabId);
  oopifSessions.delete(tabId);
  for (const k of primedSessions) {
    if (k.startsWith(`${tabId}:`)) primedSessions.delete(k);
  }
  return true;
}

// backendNodeId commands need the renderer's node map populated for that session.
async function primeDom(tabId, sessionId) {
  const key = `${tabId}:${sessionId || ROOT}`;
  if (primedSessions.has(key)) return;
  primedSessions.add(key);
  try {
    await cdp(tabId, "DOM.enable", {}, sessionId);
    await cdp(tabId, "DOM.getDocument", { depth: 0 }, sessionId);
  } catch {}
}

function boxCentre(model) {
  const q = model.content;
  return {
    x: (q[0] + q[2] + q[4] + q[6]) / 4,
    y: (q[1] + q[3] + q[5] + q[7]) / 4,
  };
}

// Box-model coordinates from an OOPIF session are relative to that frame, not the page,
// so the owner <iframe>'s origin in the parent has to be added back in.
async function frameOffset(tabId, snap, frame) {
  if (frame.offset) return frame.offset;
  const parent = frame.parentFrameId ? snap.frames.find((f) => f.frameId === frame.parentFrameId) : null;
  if (!parent || parent === frame || !frame.sessionId || frame.sessionId === parent.sessionId) {
    return (frame.offset = { x: 0, y: 0 });
  }
  frame.offset = { x: 0, y: 0 }; // breaks a cycle if a malformed tree makes an ancestor loop
  const base = await frameOffset(tabId, snap, parent);
  try {
    await primeDom(tabId, parent.sessionId);
    const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId: frame.frameId }, parent.sessionId);
    const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, parent.sessionId);
    const q = model.content;
    return (frame.offset = {
      x: base.x + Math.min(q[0], q[2], q[4], q[6]),
      y: base.y + Math.min(q[1], q[3], q[5], q[7]),
    });
  } catch {
    return (frame.offset = base);
  }
}

// `click` is opt-out because the box-model fallback below can only reach a node by *clicking* it.
// hover, scroll_to, type and form_input must never trigger that, or a box-less element silently
// receives an activation the caller never asked for.
export async function resolveRefForAction(tabId, ref, { click = true } = {}) {
  const parsed = parseRef(ref);
  const snap = snapshots.get(tabId);
  let entry = null;
  if (parsed && snap) {
    const frame = snap.frames[parsed.frameOrdinal];
    if (frame) entry = snap.byKey.get(keyOf(snap.browserId, frame.sessionId, parsed.backendNodeId));
  }
  if (!entry) {
    throw new Error(`Ref ${ref} not found in the current page snapshot. Try capturing new snapshot.`);
  }

  const { backendNodeId, sessionId } = entry;
  const frame = snap.frames[entry.frameOrdinal];
  await primeDom(tabId, sessionId);

  try {
    await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
  } catch {}

  try {
    const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId }, sessionId);
    if (model && model.width > 0 && model.height > 0) {
      const centre = boxCentre(model);
      const offset = await frameOffset(tabId, snap, frame);
      return {
        x: centre.x + offset.x,
        y: centre.y + offset.y,
        sessionId,
        backendNodeId,
        frameOrdinal: entry.frameOrdinal,
        ref,
        trusted: true,
      };
    }
  } catch {}

  // No box model (display:contents, zero-size, detached-but-live). The only remaining way to reach
  // the node is to activate it, so a non-click caller gets coordinates of null and no side effect.
  if (!click) {
    return { x: null, y: null, sessionId, backendNodeId, frameOrdinal: entry.frameOrdinal, ref, trusted: false, clicked: false };
  }

  // Runtime.callFunctionOn still reaches the node, but the resulting event carries
  // isTrusted === false — which a page can check, so the caller has to be told which path ran.
  const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId }, sessionId);
  try {
    await cdp(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration:
          'function(){ this.scrollIntoView({block:"center",inline:"center"}); this.click(); }',
        awaitPromise: true,
      },
      sessionId
    );
  } finally {
    try {
      await cdp(tabId, "Runtime.releaseObject", { objectId: object.objectId }, sessionId);
    } catch {}
  }

  return {
    x: null,
    y: null,
    sessionId,
    backendNodeId,
    frameOrdinal: entry.frameOrdinal,
    ref,
    trusted: false,
    clicked: true,
  };
}
