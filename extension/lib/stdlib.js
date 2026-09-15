// The injected page stdlib. Registered into the isolated world "obmcp" so
// the ~780 chars of hand-written DOM walking measured per javascript_tool call collapse
// to ~30 and return the same shape every session.
//
// The source below is String.raw'd verbatim into Runtime.evaluate: it must stay ES5-ish,
// self-contained, and free of backticks and template substitutions.

import { cdp } from "./cdp.js";

export const STDLIB_VERSION = 2;

export const STDLIB_SOURCE = String.raw`(function () {
  if (globalThis.__ob && globalThis.__ob.v === 2) return;

  var LIMIT_ELEMENTS = 10000;
  var LIMIT_LISTENERS = 100;
  var LIMIT_LINKS = 300;
  var LIMIT_SHADOW = 200;
  var STYLE_KEYS = ['display','visibility','opacity','position','zIndex','pointerEvents','cursor','overflow','width','height'];

  function txt(s, n) {
    s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
    n = n || 240;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function count() { return document.querySelectorAll('*').length; }
  function over() { return count() > LIMIT_ELEMENTS; }
  function esc(s) { try { return CSS.escape(s); } catch (e) { return String(s); } }

  function sel(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + esc(el.id);
    var p = el.tagName.toLowerCase(), named = false;
    if (el.getAttribute && el.getAttribute('name')) { p += '[name="' + el.getAttribute('name') + '"]'; named = true; }
    else if (typeof el.className === 'string' && el.className.trim()) {
      var c = el.className.trim().split(/\s+/).slice(0, 2);
      p += '.' + c.map(esc).join('.');
    }
    var par = el.parentElement;
    if (par && !named) {
      var sibs = [];
      for (var i = 0; i < par.children.length; i++) if (par.children[i].tagName === el.tagName) sibs.push(par.children[i]);
      if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
    }
    return p;
  }

  function styles(el) {
    var o = {};
    try {
      var cs = getComputedStyle(el);
      for (var i = 0; i < STYLE_KEYS.length; i++) o[STYLE_KEYS[i]] = cs[STYLE_KEYS[i]];
    } catch (e) {}
    return o;
  }

  function isHidden(el) {
    try {
      if (el.type === 'hidden') return true;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
      return el.offsetWidth === 0 && el.offsetHeight === 0 && cs.position !== 'fixed';
    } catch (e) { return false; }
  }

  function shadowHosts() {
    var hosts = [], stack = [document];
    while (stack.length && hosts.length < LIMIT_SHADOW) {
      var root = stack.pop();
      var els = root.querySelectorAll('*');
      for (var i = 0; i < els.length && hosts.length < LIMIT_SHADOW; i++) {
        if (els[i].shadowRoot) { hosts.push(els[i]); stack.push(els[i].shadowRoot); }
      }
    }
    return hosts;
  }

  function fieldOf(el) {
    var tag = el.tagName.toLowerCase();
    var o = { tag: tag, type: String(el.type || tag).toLowerCase() };
    if (el.name) o.name = el.name;
    if (el.id) o.id = el.id;
    if (el.placeholder) o.placeholder = txt(el.placeholder, 60);
    if (el.required) o.required = true;
    if (el.disabled) o.disabled = true;
    if (el.readOnly) o.readonly = true;
    if (el.maxLength > 0) o.maxlength = el.maxLength;
    if (el.pattern) o.pattern = el.pattern;
    if (el.autocomplete) o.autocomplete = el.autocomplete;
    if (o.type === 'hidden' || o.type === 'submit' || o.type === 'button') o.value = txt(el.value, 120);
    if (tag === 'select') {
      o.options = [];
      for (var i = 0; i < el.options.length && i < 20; i++) o.options.push(el.options[i].value);
      if (el.options.length > 20) o.moreOptions = el.options.length - 20;
    }
    if (isHidden(el)) o.hidden = true;
    return o;
  }

  function forms() {
    var out = [], fs = document.querySelectorAll('form');
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], fields = [];
      var els = f.querySelectorAll('input,select,textarea,button');
      for (var j = 0; j < els.length && j < 80; j++) fields.push(fieldOf(els[j]));
      var o = {
        i: i,
        selector: sel(f),
        action: f.getAttribute('action') || location.href,
        method: String(f.getAttribute('method') || 'get').toUpperCase(),
        fields: fields
      };
      if (f.id) o.id = f.id;
      if (f.getAttribute('name')) o.name = f.getAttribute('name');
      if (f.enctype && f.enctype !== 'application/x-www-form-urlencoded') o.enctype = f.enctype;
      if (f.target) o.target = f.target;
      if (f.noValidate) o.novalidate = true;
      if (els.length > 80) o.moreFields = els.length - 80;
      out.push(o);
    }
    return out;
  }

  function inputs(opt) {
    opt = opt || {};
    var wantHidden = opt.hidden !== false;
    var list = [], out = [];
    var els = document.querySelectorAll('input,select,textarea');
    for (var i = 0; i < els.length; i++) list.push(els[i]);
    if (!over()) {
      var hosts = shadowHosts();
      for (var h = 0; h < hosts.length; h++) {
        var sh = hosts[h].shadowRoot.querySelectorAll('input,select,textarea');
        for (var k = 0; k < sh.length; k++) list.push(sh[k]);
      }
    }
    for (var n = 0; n < list.length; n++) {
      var hid = isHidden(list[n]);
      if (hid && !wantHidden) continue;
      var f = fieldOf(list[n]);
      f.selector = sel(list[n]);
      f.inForm = !!list[n].form;
      out.push(f);
    }
    return out;
  }

  function links() {
    var seen = {}, out = [], js = [];
    var as = document.querySelectorAll('a[href],area[href]');
    for (var i = 0; i < as.length && out.length < LIMIT_LINKS; i++) {
      var raw = as[i].getAttribute('href') || '';
      if (raw.slice(0, 11).toLowerCase() === 'javascript:') { if (js.length < 20) js.push(txt(raw, 120)); continue; }
      var h = as[i].href;
      if (!h || seen[h]) continue;
      seen[h] = 1;
      var o = { href: h, text: txt(as[i].textContent, 60) };
      try {
        var u = new URL(h);
        var ps = [];
        u.searchParams.forEach(function (v, k) { ps.push(k); });
        if (ps.length) o.params = ps;
        if (u.origin !== location.origin) o.external = true;
      } catch (e) {}
      if (as[i].target) o.target = as[i].target;
      if (as[i].rel) o.rel = as[i].rel;
      out.push(o);
    }
    if (js.length) out.jsHrefs = js;
    return out;
  }

  function scripts() {
    var out = [], ss = document.querySelectorAll('script');
    for (var i = 0; i < ss.length; i++) {
      var s = ss[i];
      if (s.src) {
        var o = { src: s.src, type: s.type || '' };
        if (s.async) o.async = true;
        if (s.defer) o.defer = true;
        if (s.integrity) o.integrity = s.integrity;
        if (s.crossOrigin) o.crossorigin = s.crossOrigin;
        if (s.type === 'module') o.module = true;
        try { if (new URL(s.src).origin !== location.origin) o.external = true; } catch (e) {}
        out.push(o);
      } else {
        var body = s.textContent || '';
        out.push({ inline: true, type: s.type || '', bytes: body.length, head: txt(body, 120) });
      }
    }
    return out;
  }

  function iframes() {
    var out = [], fr = document.querySelectorAll('iframe,frame');
    for (var i = 0; i < fr.length; i++) {
      var f = fr[i], o = { src: f.getAttribute('src') || '' };
      if (f.hasAttribute('srcdoc')) o.srcdoc = txt(f.getAttribute('srcdoc'), 120);
      if (f.hasAttribute('sandbox')) o.sandbox = f.getAttribute('sandbox') || '(empty)';
      if (f.getAttribute('allow')) o.allow = f.getAttribute('allow');
      if (f.name) o.name = f.name;
      try { if (o.src && new URL(o.src, location.href).origin !== location.origin) o.external = true; } catch (e) {}
      out.push(o);
    }
    return out;
  }

  var SINKS = [
    ['innerHTML', /\.(?:inner|outer)HTML\s*=/g],
    ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/g],
    ['document.write', /document\s*\.\s*write(?:ln)?\s*\(/g],
    ['eval', /\beval\s*\(/g],
    ['new Function', /\bnew\s+Function\s*\(/g],
    ['setTimeout-string', /set(?:Timeout|Interval)\s*\(\s*['"]/g],
    ['location-write', /location\s*(?:\.\s*(?:href|assign|replace))?\s*[=(]/g],
    ['location-read', /location\s*\.\s*(?:search|hash)/g],
    ['postMessage', /\.postMessage\s*\(/g],
    ['message-listener', /addEventListener\s*\(\s*['"]message['"]/g],
    ['document.cookie', /document\s*\.\s*cookie/g],
    ['webStorage', /\b(?:local|session)Storage\b/g],
    ['srcdoc', /\.srcdoc\s*=/g],
    ['jquery-html', /\$\s*\([^)]{0,80}\)\s*\.\s*(?:html|append|prepend|after|before)\s*\(/g]
  ];

  function scan(text, tally) {
    for (var i = 0; i < SINKS.length; i++) {
      var m = text.match(SINKS[i][1]);
      if (m) tally[SINKS[i][0]] = (tally[SINKS[i][0]] || 0) + m.length;
    }
  }

  function sinks(known) {
    var tally = {}, bytes = 0;
    var ss = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < ss.length && i < 200; i++) {
      var body = ss[i].textContent || '';
      bytes += body.length;
      scan(body, tally);
    }
    var handlers = known || inlineHandlers();
    if (handlers.length) for (var j = 0; j < handlers.length; j++) scan(handlers[j].code, tally);
    return { tally: tally, inlineBytes: bytes, inlineScripts: ss.length, handlers: handlers.truncated ? handlers : handlers.length };
  }

  var HANDLER_RE = /^on[a-z]+$/;

  function inlineHandlers() {
    if (over()) return { truncated: true, count: count() };
    var out = [], els = document.querySelectorAll('*');
    for (var i = 0; i < els.length && out.length < LIMIT_LISTENERS; i++) {
      var at = els[i].attributes;
      for (var j = 0; j < at.length; j++) {
        if (HANDLER_RE.test(at[j].name)) {
          out.push({ sel: sel(els[i]), on: at[j].name, code: txt(at[j].value, 120) });
          break;
        }
      }
    }
    return out;
  }

  // Real DOM listeners are not enumerable from a script (and the isolated world has its
  // own heap, so patching addEventListener would not see the page's). This is the
  // attribute + role + cursor sweep, capped at LIMIT_LISTENERS elements.
  function listeners() {
    if (over()) return { truncated: true, count: count() };
    var out = [];
    var cand = document.querySelectorAll('[onclick],[role="button"],[role="link"],[role="tab"],[data-action],[data-testid],button,summary,[tabindex]');
    for (var i = 0; i < cand.length && out.length < LIMIT_LISTENERS; i++) {
      var el = cand[i], st = styles(el);
      var o = { sel: sel(el), tag: el.tagName.toLowerCase(), text: txt(el.textContent, 40), cursor: st.cursor };
      var oc = el.getAttribute('onclick');
      if (oc) o.onclick = txt(oc, 80);
      if (el.getAttribute('role')) o.role = el.getAttribute('role');
      if (isHidden(el)) o.hidden = true;
      out.push(o);
    }
    return out;
  }

  function dumpStore(s) {
    var o = {};
    try {
      for (var i = 0; i < s.length && i < 60; i++) {
        var k = s.key(i);
        o[k] = txt(s.getItem(k), 160);
      }
      if (s.length > 60) o['<' + (s.length - 60) + ' more>'] = '';
    } catch (e) { return { error: String((e && e.message) || e) }; }
    return o;
  }

  function storage() {
    var out = {};
    try { out.local = dumpStore(localStorage); } catch (e) { out.local = { error: 'blocked' }; }
    try { out.session = dumpStore(sessionStorage); } catch (e) { out.session = { error: 'blocked' }; }
    try {
      out.cookies = document.cookie ? document.cookie.split('; ').map(function (c) { return c.split('=')[0]; }) : [];
    } catch (e) { out.cookies = []; }
    return out;
  }

  // Header-delivered CSP is invisible to the page; read_network_request response-headers
  // is the other half of this answer.
  function csp() {
    var out = [], m = document.querySelectorAll('meta[http-equiv]');
    for (var i = 0; i < m.length; i++) {
      var h = String(m[i].getAttribute('http-equiv') || '').toLowerCase();
      if (h.indexOf('content-security-policy') === 0) {
        out.push({ via: 'meta', reportOnly: h.indexOf('report-only') > 0, policy: m[i].getAttribute('content') || '' });
      }
    }
    return out;
  }

  function shadow(s) {
    var hosts = shadowHosts();
    if (!s) {
      return hosts.map(function (h) {
        return { host: sel(h), mode: h.shadowRoot.mode, children: h.shadowRoot.childElementCount };
      });
    }
    var out = [];
    for (var i = 0; i < hosts.length && out.length < 100; i++) {
      var found = hosts[i].shadowRoot.querySelectorAll(s);
      for (var j = 0; j < found.length && out.length < 100; j++) {
        out.push({
          host: sel(hosts[i]),
          sel: sel(found[j]),
          tag: found[j].tagName.toLowerCase(),
          text: txt(found[j].textContent, 80),
          html: txt(found[j].outerHTML, 400)
        });
      }
    }
    return out;
  }

  function surface() {
    var n = count(), big = n > LIMIT_ELEMENTS;
    var fs = forms(), ls = links(), sc = scripts(), ifr = iframes();

    var orphan = [], hiddenInputs = 0;
    var ins = document.querySelectorAll('input,select,textarea');
    for (var i = 0; i < ins.length; i++) {
      if (isHidden(ins[i])) hiddenInputs++;
      if (!ins[i].form) {
        var f = fieldOf(ins[i]);
        f.selector = sel(ins[i]);
        if (orphan.length < 60) orphan.push(f);
      }
    }

    var params = {}, external = 0;
    for (var j = 0; j < ls.length; j++) {
      if (ls[j].external) external++;
      if (ls[j].params) for (var k = 0; k < ls[j].params.length; k++) params[ls[j].params[k]] = 1;
    }
    var u = null;
    try { u = new URL(location.href); u.searchParams.forEach(function (v, key) { params[key] = 1; }); } catch (e) {}

    // Selector-scoped rather than a getComputedStyle sweep over every node.
    var hiddenEls = document.querySelectorAll('[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"]').length;

    var ih = big ? { truncated: true, count: n } : inlineHandlers();

    var out = {
      url: location.href,
      title: txt(document.title, 120),
      forms: fs,
      orphanInputs: orphan,
      links: ls.slice(0, 120),
      params: Object.keys(params),
      scripts: sc,
      iframes: ifr,
      inlineHandlers: ih,
      storage: storage(),
      csp: csp(),
      listeners: big ? { truncated: true, count: n } : listeners(),
      sinks: sinks(ih),
      hidden: { inputs: hiddenInputs, elements: hiddenEls },
      counts: {
        elements: n,
        forms: fs.length,
        links: ls.length,
        externalLinks: external,
        inputs: ins.length,
        scripts: sc.length,
        iframes: ifr.length,
        shadowHosts: big ? -1 : shadowHosts().length
      }
    };
    if (ls.jsHrefs) out.jsHrefs = ls.jsHrefs;
    if (big) out.truncated = true;
    return out;
  }

  globalThis.__ob = {
    v: 2,
    forms: forms,
    links: links,
    inputs: inputs,
    scripts: scripts,
    sinks: sinks,
    shadow: shadow,
    storage: storage,
    surface: surface,
    listeners: listeners,
    csp: csp,
    sel: sel,
    styles: styles,
    hidden: isHidden,
    text: txt
  };
})();`;

// Only run the IIFE when the world does not already carry it — the on-demand path is
// prepended to a caller's expression, so it has to be cheap on the hot path.
export const STDLIB_GUARDED = `if(!(globalThis.__ob&&globalThis.__ob.v===${STDLIB_VERSION})){${STDLIB_SOURCE}}`;

const registered = new Set(); // tabId -> addScriptToEvaluateOnNewDocument done

// Survives future navigations; the on-demand prepend covers the already-loaded document.
export async function registerStdlib(tabId) {
  if (registered.has(tabId)) return;
  registered.add(tabId);
  try {
    await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", {
      source: STDLIB_SOURCE,
      worldName: "obmcp",
      runImmediately: true,
    });
  } catch {
    registered.delete(tabId);
  }
}

export function forgetStdlib(tabId) {
  registered.delete(tabId);
}
