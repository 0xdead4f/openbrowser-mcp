// Framing for both wire formats: newline-delimited JSON on TCP, and Chrome's
// 4-byte-LE-length-prefixed native messaging. Used on every hop.

// Accumulate chunks in an array and concat at most once per batch of completed
// lines. The naive `buffer = Buffer.concat([buffer, chunk])` is O(n^2): a 1.5 MB
// line arriving in 64 KB chunks recopies ~18 MB. Lines here routinely exceed
// 512 KiB (base64 file chunks), so this matters.
export function createLineReader(onLine) {
  let pending = [];
  let pendingBytes = 0;

  return function push(chunk) {
    if (typeof chunk === "string") chunk = Buffer.from(chunk, "utf-8");
    if (!chunk || chunk.length === 0) return;

    if (chunk.indexOf(10) === -1) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      return;
    }

    let buf;
    if (pendingBytes === 0) {
      buf = chunk;
    } else {
      pending.push(chunk);
      buf = Buffer.concat(pending, pendingBytes + chunk.length);
    }
    pending = [];
    pendingBytes = 0;

    let start = 0;
    let idx;
    while ((idx = buf.indexOf(10, start)) !== -1) {
      const line = buf.toString("utf-8", start, idx).trim();
      start = idx + 1;
      if (line) onLine(line);
    }
    if (start < buf.length) {
      const tail = buf.subarray(start);
      pending.push(tail);
      pendingBytes = tail.length;
    }
  };
}

export function encodeLine(obj) {
  return JSON.stringify(obj) + "\n";
}

// The state is opaque; pass `null` on the first call and hand back whatever this
// returns. A Buffer is accepted too, so a caller that seeds with Buffer.alloc(0)
// still works.
function normalizeState(state) {
  if (!state) return { chunks: [], bytes: 0 };
  if (Buffer.isBuffer(state)) {
    return state.length ? { chunks: [state], bytes: state.length } : { chunks: [], bytes: 0 };
  }
  return state;
}

// Read the length prefix without materialising the backlog — a multi-megabyte
// frame can span dozens of chunks and we only want to concat once, when the
// whole frame has arrived.
function peekFrameLength(state) {
  const first = state.chunks[0];
  if (first.length >= 4) return first.readUInt32LE(0);
  const head = Buffer.alloc(4);
  let n = 0;
  for (const c of state.chunks) {
    for (let i = 0; i < c.length && n < 4; i++) head[n++] = c[i];
    if (n === 4) break;
  }
  return head.readUInt32LE(0);
}

export function readNativeMessages(state, chunk) {
  const s = normalizeState(state);
  if (chunk && chunk.length) {
    s.chunks.push(chunk);
    s.bytes += chunk.length;
  }

  const messages = [];
  if (s.bytes < 4) return { messages, state: s };
  if (s.bytes < 4 + peekFrameLength(s)) return { messages, state: s };

  const buf = s.chunks.length === 1 ? s.chunks[0] : Buffer.concat(s.chunks, s.bytes);
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    if (offset + 4 + len > buf.length) break;
    try {
      messages.push(JSON.parse(buf.toString("utf-8", offset + 4, offset + 4 + len)));
    } catch {
      // skip malformed frame
    }
    offset += 4 + len;
  }

  const rest = buf.subarray(offset);
  s.chunks = rest.length ? [rest] : [];
  s.bytes = rest.length;
  return { messages, state: s };
}

export function encodeNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf-8");
  const out = Buffer.allocUnsafe(4 + json.length);
  out.writeUInt32LE(json.length, 0);
  json.copy(out, 4);
  return out;
}
