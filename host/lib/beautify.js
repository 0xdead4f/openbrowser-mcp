// Dependency-free JS/CSS/JSON pretty-printer used by the download sink.
// The on-disk tree is the greppable copy, so minified bundles are broken onto
// lines at write time and nobody has to re-run prettier.

const MAX_INPUT = 16 * 1024 * 1024;
const ALREADY_FORMATTED_AVG = 200;

// After these a `/` starts a regex literal; after any other identifier it is division.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

export function beautify(source, kind) {
  if (typeof source !== "string" || source.length === 0) return source;
  if (source.length > MAX_INPUT) return source;
  if (source.length / countLines(source) < ALREADY_FORMATTED_AVG) return source;
  try {
    if (kind === "js") return beautifyJs(source);
    if (kind === "css") return beautifyCss(source);
    if (kind === "json") return beautifyJson(source);
    return source;
  } catch {
    // A half-formatted bundle is worse than a minified one.
    return source;
  }
}

function countLines(s) {
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

function beautifyJson(src) {
  return JSON.stringify(JSON.parse(src), null, 2);
}

// --- shared character tests (charCode, not regex — this runs over multi-MB bundles) ---

function isIdentStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
}
function isIdentPart(c) {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}
function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\r";
}
function nextNonSpace(s, i) {
  while (i < s.length && (isSpace(s[i]) || s[i] === "\n")) i++;
  return i;
}

// --- literal scanners: each returns the index just past the token, or -1 if unterminated ---

function scanString(s, i) {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === q) return i + 1;
    if (c === "\n") return -1;
    i++;
  }
  return -1;
}

function scanTemplate(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && s[i + 1] === "{") {
      const e = scanSubstitution(s, i + 2);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    i++;
  }
  return -1;
}

// The `${ … }` of a template can hold arbitrary code, including nested templates and
// strings whose braces must not be counted.
function scanSubstitution(s, i) {
  let depth = 1;
  let lastChar = null;
  let lastWord = null;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const e = scanString(s, i);
      if (e < 0) return -1;
      i = e; lastChar = c; lastWord = null; continue;
    }
    if (c === "`") {
      const e = scanTemplate(s, i);
      if (e < 0) return -1;
      i = e; lastChar = "`"; lastWord = null; continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const e = s.indexOf("\n", i);
      i = e < 0 ? s.length : e;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      if (e < 0) return -1;
      i = e + 2; continue;
    }
    if (c === "/" && regexAllowed(lastChar, lastWord)) {
      const e = scanRegexLiteral(s, i);
      if (e > 0) { i = e; lastChar = "/"; lastWord = null; continue; }
    }
    if (isIdentStart(s.charCodeAt(i))) {
      let j = i;
      while (j < s.length && isIdentPart(s.charCodeAt(j))) j++;
      lastWord = s.slice(i, j);
      lastChar = s[j - 1];
      i = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    if (!isSpace(c) && c !== "\n") { lastChar = c; lastWord = null; }
    i++;
  }
  return -1;
}

function scanRegexLiteral(s, i) {
  i++;
  if (s[i] === "/" || s[i] === "*") return -1;
  let inClass = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return -1;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      i++;
      while (i < s.length && isIdentPart(s.charCodeAt(i))) i++;
      return i;
    }
    i++;
  }
  return -1;
}

function regexAllowed(lastChar, lastWord) {
  if (lastChar === null) return true;
  if (lastWord !== null) return REGEX_KEYWORDS.has(lastWord);
  // The `)` that closes an if/for/while head leaves us in statement position, so the next `/`
  // starts a regex. Reading it as division makes `/a{2,3}/` look like a block and the emitted
  // file is no longer valid JS — silent corruption, since the braces still balance.
  if (lastChar === ")kw") return true;
  if (lastChar === ")" || lastChar === "]" || lastChar === '"' || lastChar === "'" || lastChar === "`") return false;
  // '}' is ambiguous; a closing block before `/` is far more common than an object literal.
  return !isIdentPart(lastChar.charCodeAt(0));
}

// --- JS ---

function beautifyJs(src) {
  const out = [];
  const stack = [];
  let indent = 0;
  let pending = true;
  let lastChar = null;
  let lastWord = null;

  // The newline is materialized on the next emit, so a `}` that lowers the indent after
  // the break was requested still lands at the right column.
  const nl = () => { pending = true; };
  const atLineStart = () => pending;
  const emit = (s) => {
    if (pending) {
      if (out.length) out.push("\n");
      if (indent > 0) out.push("  ".repeat(indent));
      pending = false;
    }
    out.push(s);
  };
  const topIsBrace = () => stack.length === 0 || stack[stack.length - 1] === "{";

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    if (c === "\n") {
      // Never drop the last line terminator between two tokens — ASI depends on it.
      if (!atLineStart()) nl();
      i++;
      continue;
    }
    if (isSpace(c)) {
      let j = i;
      while (j < n && isSpace(src[j])) j++;
      if (!atLineStart() && j < n && src[j] !== "\n") emit(" ");
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      emit(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) return src;
      emit(src.slice(i, e + 2));
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = scanString(src, i);
      if (e < 0) return src;
      emit(src.slice(i, e));
      i = e; lastChar = c; lastWord = null;
      continue;
    }
    if (c === "`") {
      const e = scanTemplate(src, i);
      if (e < 0) return src;
      emit(src.slice(i, e));
      i = e; lastChar = "`"; lastWord = null;
      continue;
    }
    if (c === "/" && regexAllowed(lastChar, lastWord)) {
      const e = scanRegexLiteral(src, i);
      if (e > 0) {
        emit(src.slice(i, e));
        i = e; lastChar = "/"; lastWord = null;
        continue;
      }
      // Not a regex after all; fall through and treat it as the division operator.
    }
    if (isIdentStart(src.charCodeAt(i))) {
      let j = i;
      while (j < n && isIdentPart(src.charCodeAt(j))) j++;
      const word = src.slice(i, j);
      emit(word);
      // A word after `.` is a property name, not a keyword — `x.if(a)/2` and `x.in/2` are
      // division, and mistaking either for a regex head swallows the rest of the line.
      lastWord = lastChar === "." ? null : word;
      lastChar = src[j - 1];
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && (isIdentPart(src.charCodeAt(j)) || src[j] === ".")) j++;
      emit(src.slice(i, j));
      lastWord = null; lastChar = src[j - 1];
      i = j;
      continue;
    }
    if (c === "{") {
      const k = nextNonSpace(src, i + 1);
      if (k < n && src[k] === "}") {
        emit("{}");
        i = k + 1; lastChar = "}"; lastWord = null;
        continue;
      }
      emit("{");
      stack.push("{");
      indent++;
      lastChar = "{"; lastWord = null;
      i++;
      nl();
      continue;
    }
    if (c === "}") {
      if (stack.pop() !== "{") return src;
      indent--;
      if (!atLineStart()) nl();
      emit("}");
      lastChar = "}"; lastWord = null;
      i++;
      const k = nextNonSpace(src, i);
      const nx = k < n ? src[k] : "";
      if (topIsBrace() && (nx === "{" || (nx !== "" && isIdentStart(nx.charCodeAt(0))))) nl();
      continue;
    }
    if (c === "(" || c === "[") {
      emit(c);
      // Remember control-flow heads so the matching `)` knows it is not an expression.
      stack.push(c === "(" && (lastWord === "if" || lastWord === "for" || lastWord === "while") ? "(kw" : c);
      lastChar = c; lastWord = null;
      i++;
      continue;
    }
    if (c === ")" || c === "]") {
      const open = stack.pop();
      if (c === ")" ? open !== "(" && open !== "(kw" : open !== "[") return src;
      emit(c);
      lastChar = open === "(kw" ? ")kw" : c; lastWord = null;
      i++;
      continue;
    }
    if (c === ";") {
      emit(";");
      lastChar = ";"; lastWord = null;
      i++;
      if (topIsBrace()) {
        const k = nextNonSpace(src, i);
        if (k < n && src[k] !== "}") nl();
      }
      continue;
    }
    if (c === "," && stack.length > 0 && stack[stack.length - 1] === "{") {
      // Object literals only — a webpack module map becomes one module per line.
      emit(",");
      lastChar = ","; lastWord = null;
      i++;
      const k = nextNonSpace(src, i);
      if (k < n && src[k] !== "}") nl();
      continue;
    }
    emit(c);
    lastChar = c; lastWord = null;
    i++;
  }

  if (stack.length !== 0) return src;
  if (pending && out.length) out.push("\n");
  return out.join("");
}

// --- CSS ---

function beautifyCss(src) {
  const out = [];
  let indent = 0;
  let paren = 0;
  let pending = true;
  let inDecl = false;

  const nl = () => { pending = true; };
  const atLineStart = () => pending;
  const emit = (s) => {
    if (pending) {
      if (out.length) out.push("\n");
      if (indent > 0) out.push("  ".repeat(indent));
      pending = false;
    }
    out.push(s);
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    if (c === "\n") {
      if (!atLineStart()) nl();
      i++;
      continue;
    }
    if (isSpace(c)) {
      let j = i;
      while (j < n && isSpace(src[j])) j++;
      if (!atLineStart() && j < n && src[j] !== "\n") emit(" ");
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) return src;
      emit(src.slice(i, e + 2));
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = scanString(src, i);
      if (e < 0) return src;
      emit(src.slice(i, e));
      i = e;
      continue;
    }
    if (c === "(") { paren++; emit(c); i++; continue; }
    if (c === ")") { if (paren > 0) paren--; emit(c); i++; continue; }
    if (c === "{" && paren === 0) {
      emit(atLineStart() ? "{" : " {");
      indent++;
      inDecl = false;
      i++;
      nl();
      continue;
    }
    if (c === "}" && paren === 0) {
      indent--;
      if (indent < 0) return src;
      if (!atLineStart()) nl();
      emit("}");
      inDecl = false;
      i++;
      nl();
      continue;
    }
    if (c === ":" && paren === 0 && indent > 0) {
      // inside a rule a top-level ':' opens a declaration value; ':' at indent 0 is a
      // pseudo-class in a selector
      inDecl = true;
      emit(":");
      i++;
      continue;
    }
    if (c === ";" && paren === 0) {
      emit(";");
      inDecl = false;
      i++;
      const k = nextNonSpace(src, i);
      if (k < n && src[k] !== "}") nl();
      continue;
    }
    if (c === "," && paren === 0 && !inDecl) {
      // selector list — one selector per line keeps `grep '^\.btn'` working
      emit(",");
      i++;
      nl();
      continue;
    }
    emit(c);
    i++;
  }

  if (indent !== 0) return src;
  if (pending && out.length) out.push("\n");
  return out.join("");
}
