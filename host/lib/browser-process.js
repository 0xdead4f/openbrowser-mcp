// Browser-process discovery and the Brave temporary-container relay, for native-host.js.
//
// No extension, CDP or URL API creates a Brave temporary container. The only way in is to run the
// running browser's own binary again with `--temporary-container`, which ProcessSingleton relays into
// the live instance. Doing that safely takes three facts the extension cannot supply — which binary,
// which --user-data-dir, which profile directory — so they are derived here from the process tree and
// the disk and never taken from a request: a request that could name a binary or a path would turn
// the native host into an arbitrary-exec primitive. Everything touches the system through an injected
// `sys` (see realSystem), so every platform branch runs offline against fixtures.

import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// node -> the browser on macOS/Linux (the wrapper execs); node -> cmd.exe -> the browser on Windows,
// where Chrome runs the host's .cmd through cmd.exe. Four levels leaves room for a wrapper that does
// not exec without ever wandering up to launchd, systemd or explorer.exe.
export const MAX_PARENT_LEVELS = 4;
export const PROFILE_SCAN_TIMEOUT_MS = 3000;
export const PROFILE_SCAN_INTERVAL_MS = 250;
// Must stay well under Chromium's ProcessSingleton timeout (kTimeoutInSeconds = 20): a relay that gets
// no ACK by then decides the running browser is hung, SIGKILLs it and starts itself on the profile.
// The host kills the relay at this deadline (runRelay) so that never happens to the human's browser.
export const RELAY_TIMEOUT_MS = 10000;
export const MAX_URL_CHARS = 4096;
export const MAX_CONTAINER_NAME_CHARS = 80;

const PS_TIMEOUT_MS = 3000;
// PowerShell's cold start alone is 1-3 s on a slow disk. Two lookups (cmd.exe, then the browser) plus
// the scan normally fit the extension's profile_dir timeout; when they do not, the late answer is
// still cached here, so the extension's retry is instant instead of starting the walk over.
const POWERSHELL_TIMEOUT_MS = 6000;
// Extension storage is kilobytes. The cap only stops a corrupt or hostile multi-GB file from
// stalling the scan and the extension's request with it.
const MAX_SCAN_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RELAY_STDOUT_BYTES = 64 * 1024;
// A relaying process can hand its stdout to a helper (crashpad) that outlives it, so "close" may
// never come; after "exit" the pipe gets this long to drain the one line it prints.
const RELAY_STDOUT_DRAIN_MS = 150;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION_ORIGIN = /chrome-extension:\/\/([a-p]{32})\//;
const CONTROL_CHAR = /\p{Cc}/u;

export const BRAVE_BINARY = /^(Brave Browser( Beta| Nightly| Dev)?|brave(-browser(-beta|-nightly|-dev)?)?|brave\.exe)$/i;

// Matched on the executable's basename; `channel` runs over the install components (see
// installComponents), because on Linux every Brave channel's binary is plain `brave` and only its
// directory (/opt/brave.com/brave-beta) differs. Order matters: "chrome" also names Chromium's binary
// in some packages, so Chrome goes last and is re-labelled when the install components say chromium.
const BROWSERS = [
  {
    brand: "Brave",
    binary: BRAVE_BINARY,
    channel: /brave[- ](?:browser[- ])?(beta|nightly|dev)(?:\.app)?(?:[\\/]|$)/i,
  },
  {
    brand: "Microsoft Edge",
    binary: /^(Microsoft Edge( Beta| Dev| Canary)?|msedge|microsoft-edge(-stable|-beta|-dev)?|msedge\.exe)$/i,
    channel: /(?:edge|msedge)[- ](beta|dev|canary|sxs)(?:\.app)?(?:[\\/]|$)/i,
  },
  {
    brand: "Vivaldi",
    binary: /^(Vivaldi( Snapshot)?|vivaldi(-bin|-snapshot)?|vivaldi\.exe)$/i,
    channel: /vivaldi[- ](snapshot)(?:\.app)?(?:[\\/]|$)/i,
  },
  { brand: "Opera", binary: /^(Opera( Beta| Developer| GX)?|opera(-beta|-developer)?|opera\.exe)$/i },
  { brand: "Chromium", binary: /^(Chromium|chromium(-browser)?|chromium\.exe)$/i },
  {
    brand: "Google Chrome",
    binary: /^(Google Chrome( Beta| Dev| Canary| for Testing)?|chrome|google-chrome(-stable|-beta|-unstable|-canary)?|chrome\.exe)$/i,
    channel: /chrome[- ](beta|dev|canary|unstable|sxs|for testing)(?:\.app)?(?:[\\/]|$)/i,
  },
];

const CHANNEL_ALIASES = { unstable: "dev", sxs: "canary", "for testing": "testing" };

// Default user-data-dir per brand and channel: [macOS under ~/Library/Application Support,
// Linux under $CHROME_CONFIG_HOME (not for Brave)|$XDG_CONFIG_HOME|~/.config, Windows under %LOCALAPPDATA%].
// Opera keeps its profile at the top of its own directory rather than in profile subdirectories, so
// the profile scan below could never match it; it is left out rather than guessed.
const USER_DATA_DIRS = {
  Brave: {
    stable: ["BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser/User Data"],
    beta: ["BraveSoftware/Brave-Browser-Beta", "BraveSoftware/Brave-Browser-Beta", "BraveSoftware/Brave-Browser-Beta/User Data"],
    nightly: ["BraveSoftware/Brave-Browser-Nightly", "BraveSoftware/Brave-Browser-Nightly", "BraveSoftware/Brave-Browser-Nightly/User Data"],
    dev: ["BraveSoftware/Brave-Browser-Dev", "BraveSoftware/Brave-Browser-Dev", "BraveSoftware/Brave-Browser-Dev/User Data"],
  },
  "Google Chrome": {
    stable: ["Google/Chrome", "google-chrome", "Google/Chrome/User Data"],
    beta: ["Google/Chrome Beta", "google-chrome-beta", "Google/Chrome Beta/User Data"],
    dev: ["Google/Chrome Dev", "google-chrome-unstable", "Google/Chrome Dev/User Data"],
    canary: ["Google/Chrome Canary", "google-chrome-canary", "Google/Chrome SxS/User Data"],
    testing: ["Google/Chrome for Testing", "google-chrome-for-testing", "Google/Chrome for Testing/User Data"],
  },
  Chromium: { stable: ["Chromium", "chromium", "Chromium/User Data"] },
  "Microsoft Edge": {
    stable: ["Microsoft Edge", "microsoft-edge", "Microsoft/Edge/User Data"],
    beta: ["Microsoft Edge Beta", "microsoft-edge-beta", "Microsoft/Edge Beta/User Data"],
    dev: ["Microsoft Edge Dev", "microsoft-edge-dev", "Microsoft/Edge Dev/User Data"],
    canary: ["Microsoft Edge Canary", null, "Microsoft/Edge SxS/User Data"],
  },
  Vivaldi: {
    stable: ["Vivaldi", "vivaldi", "Vivaldi/User Data"],
    snapshot: ["Vivaldi Snapshot", "vivaldi-snapshot", null],
  },
};

const PLATFORM_COLUMN = { darwin: 0, linux: 1, win32: 2 };

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function errCode(e) {
  return (e && (e.code || e.message)) || String(e);
}

// --- The real system ---

export function realSystem({ argv = process.argv, ppid = process.ppid, defaultExtensionId = null } = {}) {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    argv,
    ppid,
    defaultExtensionId,
    // execFile, never a shell: the app path has spaces and nothing here may be reinterpreted.
    exec: (file, args, { timeout }) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout))
        );
      }),
    readFile: (p) => fsp.readFile(p),
    readdir: (p) => fsp.readdir(p),
    readlink: (p) => fsp.readlink(p),
    stat: (p) => fsp.stat(p),
    spawn,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

// --- Identification ---

// Only the path components that name the install, never where it sits: the innermost .app bundle
// down to the binary on macOS, the directory above \Application\ on Windows, the binary's own
// directory elsewhere. Matching the whole path let a user directory pick the channel or brand —
// C:\Users\brave-dev\...\Brave-Browser\Application\brave.exe read as Brave Dev, whose default
// user-data-dir does not exist, so temporaryContainer failed for that user.
export function installComponents(exe, platform) {
  const parts = String(exe).split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);
  if (platform === "darwin") {
    const app = parts.findLastIndex((c) => /\.app$/i.test(c));
    if (app !== -1) return parts.slice(app);
  }
  const parent = parts.length - 2;
  const install = platform === "win32" && /^application$/i.test(parts[parent] || "") ? parent - 1 : parent;
  return [parts[install], parts[parts.length - 1]].filter(Boolean);
}

export function identifyBrowser(exe, platform) {
  if (typeof exe !== "string" || !exe) return null;
  const base = pathFor(platform).basename(exe);
  const hit = BROWSERS.find((b) => b.binary.test(base));
  if (!hit) return null;
  const install = installComponents(exe, platform).join("/");
  const brand = hit.brand === "Google Chrome" && /chromium/i.test(install) ? "Chromium" : hit.brand;
  const m = brand === hit.brand && hit.channel ? hit.channel.exec(install) : null;
  const raw = m ? m[1].toLowerCase() : "stable";
  return { brand, channel: CHANNEL_ALIASES[raw] || raw };
}

export function isBraveBinary(binary, platform) {
  return BRAVE_BINARY.test(pathFor(platform).basename(String(binary || "")));
}

export function defaultUserDataDir({ brand, channel }, { platform, env = {}, homedir }) {
  const row = USER_DATA_DIRS[brand]?.[channel];
  const col = PLATFORM_COLUMN[platform];
  const rel = row && col !== undefined ? row[col] : null;
  if (!rel) return null;
  const p = pathFor(platform);
  let base;
  if (platform === "darwin") base = p.join(homedir, "Library", "Application Support");
  // The native host inherits the browser's environment, so these are the values the browser itself
  // resolved its default against — including a snap's rewritten HOME and XDG_CONFIG_HOME. Brave
  // overrides chrome_paths_linux.cc to skip CHROME_CONFIG_HOME (its profile always lives under
  // BraveSoftware in the XDG config dir), so a CHROME_CONFIG_HOME exported for Chrome must not move
  // Brave's default: that pointed profile_dir at a directory that does not exist.
  else if (platform === "linux") base = [brand === "Brave" ? null : env.CHROME_CONFIG_HOME, env.XDG_CONFIG_HOME].find((d) => d && p.isAbsolute(d)) || p.join(homedir, ".config");
  else base = env.LOCALAPPDATA || p.join(env.USERPROFILE || homedir, "AppData", "Local");
  return p.join(base, ...rel.split("/"));
}

// --- Command lines ---

// CommandLineToArgvW, which is what Chromium's CommandLine parses a Windows command line with. argv[0]
// follows the loader's rule (quotes delimit, backslashes are literal); the rest follow the CRT's
// 2n/2n+1 backslash rule, and `""` inside quotes is a literal quote.
export function parseWindowsCommandLine(line) {
  const s = String(line || "");
  const n = s.length;
  const blank = (c) => c === " " || c === "\t";
  const args = [];
  let i = 0;
  while (i < n && blank(s[i])) i++;
  if (i < n) {
    let arg = "";
    if (s[i] === '"') {
      i++;
      while (i < n && s[i] !== '"') arg += s[i++];
      i++;
    } else {
      while (i < n && !blank(s[i])) arg += s[i++];
    }
    args.push(arg);
  }
  for (;;) {
    while (i < n && blank(s[i])) i++;
    if (i >= n) break;
    let arg = "";
    let quoted = false;
    while (i < n) {
      const c = s[i];
      if (c === "\\") {
        let slashes = 0;
        while (i < n && s[i] === "\\") { slashes++; i++; }
        if (s[i] === '"') {
          arg += "\\".repeat(slashes >> 1);
          if (slashes & 1) { arg += '"'; i++; }
        } else {
          arg += "\\".repeat(slashes);
        }
        continue;
      }
      if (c === '"') {
        if (quoted && s[i + 1] === '"') { arg += '"'; i += 2; continue; }
        quoted = !quoted;
        i++;
        continue;
      }
      if (!quoted && blank(c)) break;
      arg += c;
      i++;
    }
    args.push(arg);
  }
  return args;
}

// Chromium's switch rules: `--` or `-` (and `/` on Windows) prefixes, names case-insensitive on
// Windows only, the last occurrence wins, and a bare `--` ends switch parsing.
export function switchValue(args, name, platform) {
  const prefixes = platform === "win32" ? ["--", "-", "/"] : ["--", "-"];
  let value = null;
  for (const arg of args) {
    if (arg === "--") break;
    const prefix = prefixes.find((pre) => arg.length > pre.length && arg.startsWith(pre));
    if (!prefix) continue;
    const body = arg.slice(prefix.length);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if ((platform === "win32" ? key.toLowerCase() : key) === name) value = eq === -1 ? "" : body.slice(eq + 1);
  }
  return value;
}

function stripQuotes(value) {
  const m = /^(["'])([\s\S]*)\1$/.exec(value);
  return m ? m[2] : value;
}

// `ps -o args=` (macOS) and a Chromium browser's /proc/<pid>/cmdline on Linux — which Chromium
// rewrites with setproctitle into ONE space-joined string — have lost the argv boundaries, so a
// --user-data-dir holding spaces cannot be cut out exactly. Return every plausible reading, longest
// first, up to the next switch; the caller keeps the first that is an existing directory.
export function userDataDirCandidatesFromRaw(raw, exe) {
  let rest = String(raw || "").replace(/\0+/g, " ").trim();
  // argv[0] is the app path, spaces and all; dropping it keeps "Brave Browser.app" out of the parse.
  if (exe && rest.startsWith(exe)) rest = rest.slice(exe.length);
  const re = /(?:^|\s)--?user-data-dir=/g;
  let start = null;
  for (let m; (m = re.exec(rest)); ) start = m.index + m[0].length;
  if (start === null) return null;
  const value = rest.slice(start);
  if (value[0] === '"' || value[0] === "'") {
    const end = value.indexOf(value[0], 1);
    if (end > 1) return [value.slice(1, end)];
  }
  const tokens = value.split(" ");
  let stop = tokens.length;
  for (let k = 1; k < tokens.length; k++) {
    if (/^--?[A-Za-z0-9][\w-]*(=|$)/.test(tokens[k])) { stop = k; break; }
  }
  const out = [];
  for (let k = stop; k >= 1; k--) {
    const candidate = tokens.slice(0, k).join(" ");
    if (candidate) out.push(candidate, stripQuotes(candidate));
  }
  const unique = [...new Set(out)];
  return unique.length ? unique : null;
}

function userDataDirCandidatesFromArgv(argv, platform) {
  const value = switchValue(argv.slice(1), "user-data-dir", platform);
  if (!value) return null;
  return [...new Set([value, stripQuotes(value)])];
}

// --- Processes ---

async function readProcessDarwin(sys, pid) {
  // `comm` is the full executable path on macOS for a same-user process; ppid comes first because
  // the path itself may hold spaces ("Brave Browser.app").
  const out = await sys.exec("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS });
  const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(String(out).split("\n").find((l) => l.trim()) || "");
  if (!m) throw new Error(`ps printed nothing usable for pid ${pid}`);
  return { pid, ppid: Number(m[1]), exe: m[2], argv: null, raw: null };
}

async function readProcessLinux(sys, pid) {
  const status = String(await sys.readFile(`/proc/${pid}/status`));
  const ppid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? NaN);
  // A package upgrade under a running browser leaves the old inode behind; the path still names the
  // installed binary, which relays into the running instance just the same.
  const exe = String(await sys.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, "");
  const parts = String(await sys.readFile(`/proc/${pid}/cmdline`)).split("\0");
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  const nonEmpty = parts.filter((a) => a !== "");
  // One element with spaces is the setproctitle form (see userDataDirCandidatesFromRaw).
  const retitled = nonEmpty.length === 1 && nonEmpty[0].includes(" ");
  return { pid, ppid, exe, argv: retitled ? null : parts, raw: retitled ? nonEmpty[0] : null };
}

async function readProcessWin32(sys, pid) {
  const root = sys.env?.SystemRoot || sys.env?.windir || "C:\\Windows";
  const powershell = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // UTF-8 output: redirected PowerShell otherwise writes the OEM code page, which mangles a
  // non-ASCII user-profile path in ExecutablePath into a binary that does not exist.
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ` +
    "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const out = await sys.exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: POWERSHELL_TIMEOUT_MS });
  const text = String(out).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error(`no Win32_Process with ProcessId ${pid}`);
  let row = JSON.parse(text);
  if (Array.isArray(row)) row = row[0];
  if (!row || Number(row.ProcessId) !== pid) throw new Error(`Win32_Process lookup for ${pid} returned another process`);
  return {
    pid,
    ppid: Number(row.ParentProcessId),
    exe: row.ExecutablePath || "",
    argv: row.CommandLine ? parseWindowsCommandLine(row.CommandLine) : null,
    raw: row.CommandLine || null,
  };
}

export async function readProcess(sys, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  if (sys.platform === "darwin") return readProcessDarwin(sys, pid);
  if (sys.platform === "linux") return readProcessLinux(sys, pid);
  if (sys.platform === "win32") return readProcessWin32(sys, pid);
  throw new Error(`temporaryContainer supports macOS, Linux and Windows; this native host runs on ${sys.platform}`);
}

export async function findBrowserProcess(sys) {
  const chain = [];
  let pid = Number(sys.ppid);
  for (let level = 0; level < MAX_PARENT_LEVELS && Number.isSafeInteger(pid) && pid > 0; level++) {
    let proc;
    try {
      proc = await readProcess(sys, pid);
    } catch (e) {
      throw new Error(`the native host could not inspect ancestor process ${pid}: ${errCode(e)}`);
    }
    chain.push(proc);
    const browser = identifyBrowser(proc.exe, sys.platform);
    if (browser) {
      // A bare name (a truncated `comm`, a missing ExecutablePath) would make spawn search PATH,
      // which is exactly where a planted "brave" would win.
      const p = pathFor(sys.platform);
      if (!p.isAbsolute(proc.exe)) {
        throw new Error(`the browser process ${pid} reports "${proc.exe}", not an absolute executable path, so it cannot be relaunched safely`);
      }
      let st;
      try { st = await sys.stat(proc.exe); } catch { st = null; }
      if (!st || !st.isFile()) throw new Error(`the browser executable ${proc.exe} (pid ${pid}) is not a readable file`);
      return { ...browser, pid, binary: proc.exe, proc, chain };
    }
    if (!(proc.ppid > 0) || proc.ppid === pid || (sys.platform !== "win32" && proc.ppid === 1)) break;
    pid = proc.ppid;
  }
  const seen = chain.map((c) => `${c.pid} ${c.exe || "?"}`).join(" <- ") || "none";
  throw new Error(
    `no Chromium browser executable among the native host's first ${MAX_PARENT_LEVELS} ancestor processes (${seen}); ` +
      "the host must be launched by the browser through connectNative"
  );
}

// --- user-data-dir ---

export function lockOwnerPid(target) {
  const m = /-(\d+)$/.exec(String(target || ""));
  return m ? Number(m[1]) : null;
}

async function isDirectory(sys, p) {
  try { return (await sys.stat(p)).isDirectory(); } catch { return false; }
}

export async function resolveUserDataDir(sys, browser) {
  const p = pathFor(sys.platform);
  let candidates;
  if (sys.platform === "darwin") {
    // Full argv only for the browser itself: `comm` already identified it, `args` is just for the switch.
    const raw = await sys.exec("/bin/ps", ["-ww", "-o", "args=", "-p", String(browser.pid)], { timeout: PS_TIMEOUT_MS });
    candidates = userDataDirCandidatesFromRaw(String(raw).trim(), browser.binary);
  } else if (browser.proc.argv) {
    candidates = userDataDirCandidatesFromArgv(browser.proc.argv, sys.platform);
  } else {
    candidates = userDataDirCandidatesFromRaw(browser.proc.raw, browser.binary);
  }

  let userDataDir = null;
  let explicit = false;
  if (candidates) {
    explicit = true;
    const absolute = candidates.filter((c) => p.isAbsolute(c));
    if (!absolute.length) {
      throw new Error(
        `the browser was started with a relative --user-data-dir (${candidates[0]}), which cannot be resolved from here; ` +
          "restart it with an absolute --user-data-dir to use temporaryContainer"
      );
    }
    for (const c of absolute) {
      if (await isDirectory(sys, c)) { userDataDir = c; break; }
    }
    if (!userDataDir) throw new Error(`the browser's --user-data-dir (${absolute[0]}) is not an existing directory`);
  } else {
    userDataDir = defaultUserDataDir(browser, sys);
    if (!userDataDir) {
      throw new Error(`no known default user data directory for ${browser.brand} (${browser.channel}) on ${sys.platform}; start it with --user-data-dir`);
    }
    // No --user-data-dir and no default directory means the dir came from somewhere this cannot see
    // (an enterprise UserDataDir policy, say); relaying to a guess would start a second browser.
    if (!(await isDirectory(sys, userDataDir))) {
      throw new Error(`the browser has no --user-data-dir and its default (${userDataDir}) does not exist; start it with an explicit --user-data-dir`);
    }
  }

  // POSIX ProcessSingleton keeps SingletonLock as a symlink to "<hostname>-<pid>". A different pid
  // means this directory belongs to ANOTHER browser instance, and relaying into it would open the tab
  // there (or start a second browser) — the wrong-browser failure the whole check exists for. An
  // unreadable lock proceeds, because the nonce scan still has to find this extension's own write
  // under the directory before anything is spawned. Windows is skipped: its singleton is a named
  // mutex plus a message window, and the `lockfile` it keeps holds no pid to compare.
  if (sys.platform !== "win32") {
    let target = null;
    try { target = await sys.readlink(p.join(userDataDir, "SingletonLock")); } catch {}
    const owner = lockOwnerPid(target);
    if (owner !== null && owner !== browser.pid) {
      throw new Error(
        `${p.join(userDataDir, "SingletonLock")} belongs to pid ${owner}, not to this browser (pid ${browser.pid}); ` +
          "its user data directory could not be determined, so no command line was relayed"
      );
    }
  }
  return { userDataDir, explicit };
}

// --- Extension id and profile directory ---

// Chrome passes the calling origin as an argument, but the installed wrappers do not forward it to
// node (native-host-wrapper.sh execs without "$@"; the .cmd drops it too), so on Windows it is read
// from cmd.exe's command line and elsewhere the manifest-pinned id is the fallback.
export function resolveExtensionId(sys, chain = []) {
  for (const source of [...(sys.argv || []), ...chain.map((c) => c.raw || (c.argv || []).join(" "))]) {
    const m = EXTENSION_ORIGIN.exec(String(source || ""));
    if (m) return m[1];
  }
  if (typeof sys.defaultExtensionId === "string" && /^[a-p]{32}$/.test(sys.defaultExtensionId)) return sys.defaultExtensionId;
  throw new Error("the native host could not determine the calling extension's id");
}

async function dirHoldsNonce(sys, p, dir, files, nonce) {
  // The write-ahead .log holds a fresh chrome.storage.local write as plaintext; a compacted .ldb may
  // not (Snappy), so it is only the second place to look.
  const ordered = [...files.filter((f) => f.endsWith(".log")).sort(), ...files.filter((f) => f.endsWith(".ldb")).sort()];
  for (const f of ordered) {
    const full = p.join(dir, f);
    try {
      const st = await sys.stat(full);
      if (!st.isFile() || st.size > MAX_SCAN_FILE_BYTES) continue;
      const buf = await sys.readFile(full);
      if ((Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))).includes(nonce)) return true;
    } catch {
      // LevelDB rotates and compacts under a live browser; a vanished file is not an error.
    }
  }
  return false;
}

export async function findProfileDir(sys, { userDataDir, extensionId, nonce, timeoutMs = PROFILE_SCAN_TIMEOUT_MS, intervalMs = PROFILE_SCAN_INTERVAL_MS }) {
  const p = pathFor(sys.platform);
  const deadline = sys.now() + timeoutMs;
  for (;;) {
    let names;
    try {
      names = await sys.readdir(userDataDir);
    } catch (e) {
      throw new Error(`the native host cannot list ${userDataDir}: ${errCode(e)}`);
    }
    const matches = [];
    let withExtension = 0;
    for (const name of [...names].sort()) {
      const dir = p.join(userDataDir, name, "Local Extension Settings", extensionId);
      let files;
      try { files = await sys.readdir(dir); } catch { continue; }
      withExtension++;
      if (await dirHoldsNonce(sys, p, dir, files, nonce)) matches.push(name);
    }
    if (matches.length === 1) return matches[0];
    // Exactly one, or nothing: the wrong --profile-directory silently opens the tab in (or creates)
    // another profile, where this extension never sees it.
    if (matches.length > 1) {
      throw new Error(`the profile nonce was found in ${matches.length} profiles (${matches.join(", ")}) under ${userDataDir}; refusing to guess which one is this extension's`);
    }
    if (sys.now() >= deadline) {
      throw new Error(
        `no profile under ${userDataDir} held the extension's storage nonce within ${Math.round(timeoutMs / 1000)} s ` +
          `(${withExtension} profile(s) have Local Extension Settings/${extensionId})`
      );
    }
    await sys.sleep(intervalMs);
  }
}

export async function resolveProfile(sys, nonce, scan = {}) {
  const browser = await findBrowserProcess(sys);
  const { userDataDir, explicit } = await resolveUserDataDir(sys, browser);
  // Only the processes between node and the browser: the browser's own argv can carry an unrelated
  // chrome-extension:// page URL it was started with.
  const extensionId = resolveExtensionId(sys, browser.chain.slice(0, -1));
  const profileDir = await findProfileDir(sys, { userDataDir, extensionId, nonce, ...scan });
  return {
    binary: browser.binary,
    brand: browser.brand,
    pid: browser.pid,
    userDataDir,
    explicitUserDataDir: explicit,
    profileDir,
    extensionId,
  };
}

// --- The relay ---

export function validateContainerRequest({ url, containerName, reuse, restoreKey }) {
  if (typeof url !== "string" || !url.startsWith("data:text/html,")) {
    return "url must be a data:text/html, URL (about:blank lands in the default cookie jar, and no other scheme is relayed)";
  }
  if (url.length > MAX_URL_CHARS) return `url is ${url.length} chars; the limit is ${MAX_URL_CHARS}`;
  // The extension percent-encodes the bootstrap page, so raw whitespace or a control character means
  // the request was not built by it.
  if (/\s/.test(url) || CONTROL_CHAR.test(url)) return "url must be percent-encoded (no whitespace or control characters)";
  if (typeof containerName !== "string" || containerName.length < 1 || containerName.length > MAX_CONTAINER_NAME_CHARS) {
    return `containerName must be 1-${MAX_CONTAINER_NAME_CHARS} characters`;
  }
  if (CONTROL_CHAR.test(containerName)) return "containerName must not contain control characters";
  if (containerName.startsWith("-")) return 'containerName must not start with "-"';
  if (containerName !== containerName.trim()) return "containerName must not start or end with whitespace";
  if (reuse !== undefined && typeof reuse !== "boolean") return "reuse must be a boolean";
  if (restoreKey !== undefined && (typeof restoreKey !== "string" || !UUID.test(restoreKey))) {
    return "restoreKey must be a UUID (a fresh crypto.randomUUID() per relay, later passed to restore_front)";
  }
  return null;
}

// Always --container: a fresh unique name makes a new named temporary container, and the same name
// again reuses it (Brave matches temporary containers by name only). Never --new-window (steals the
// human's view), --same-tab (navigates the human's tab in ITS jar) or --enable-automation (the
// running browser refuses the relay with exit 21).
export function relayArgv(profile, { url, containerName }) {
  const argv = [];
  if (profile.explicitUserDataDir) argv.push(`--user-data-dir=${profile.userDataDir}`);
  argv.push(`--profile-directory=${profile.profileDir}`, "--temporary-container", `--container=${containerName}`, url);
  return argv;
}

// SIGKILL for the relay and anything it forked: detached:true made it a process-group leader on POSIX,
// so -pid reaches its whole group and never the browser it was relaying to (a group of its own).
// Windows has no process groups; child.kill is TerminateProcess there. Never called after "exit",
// when the pid may already belong to an unrelated process.
export function killRelay(sys, child) {
  if (sys.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      sys.kill(-child.pid, "SIGKILL");
      return true;
    } catch {}
  }
  try {
    return child.kill("SIGKILL") !== false;
  } catch {
    return false;
  }
}

// `live` (optional Set) holds the relays that have not exited yet, for killing them on host exit.
export function runRelay(sys, binary, argv, { timeoutMs = RELAY_TIMEOUT_MS, live = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdout is a pipe, never inherited: this process's stdout IS the native-messaging channel, and
      // a relay writing "Opening in existing browser session." into it made Brave drop the port.
      child = sys.spawn(binary, argv, { detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (e) {
      resolve({ error: e, stdout: "" });
      return;
    }
    live?.add(child);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let drainTimer = null;
    let exit = null;
    child.stdout?.on("data", (d) => {
      if (bytes >= MAX_RELAY_STDOUT_BYTES) return;
      chunks.push(d);
      bytes += d.length;
    });
    child.stdout?.on("error", () => {});
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      try { child.stdout?.destroy(); } catch {}
      try { child.unref(); } catch {}
      resolve({ ...result, stdout: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString("utf8") });
    };
    // Killed, not just abandoned: unref'd and left running, the relay reaches Chromium's 20 s singleton
    // timeout, SIGKILLs the human's (merely stalled) browser with every window in it and takes over
    // the profile. A relay that already exited is only draining its stdout and is left alone.
    const timer = setTimeout(() => {
      if (exit) return finish(exit);
      const killed = killRelay(sys, child);
      live?.delete(child);
      finish({ timedOut: true, killed });
    }, timeoutMs);
    child.on("error", (e) => {
      live?.delete(child);
      finish({ error: e });
    });
    child.on("exit", (code, signal) => {
      live?.delete(child);
      exit = { exitCode: code, signal };
      drainTimer = setTimeout(() => finish(exit), RELAY_STDOUT_DRAIN_MS);
    });
    child.on("close", (code, signal) => finish(exit || { exitCode: code, signal }));
  });
}

// --- macOS app focus hand-back ---

// The relay path always ends in Browser::Show(), which on macOS activates the whole app
// ([NSApp activateIgnoringOtherApps:YES]); no switch avoids it. Without a hand-back Brave stays
// frontmost and the keystrokes the human was typing into their editor land in their active Brave tab.
// Measured: `open -b <the app that was frontmost before the relay>` fired the moment the tab appears
// leaves Brave frontmost for 20-40 ms; every 150 ms of delay adds about that much, and restoring on
// relay exit is too early (the process exits before the tab is created and activated).
export const FRONT_RECORD_TTL_MS = 15000;
const MAX_FRONT_RECORDS = 16;
const LSAPPINFO = "/usr/bin/lsappinfo";
const OPEN = "/usr/bin/open";
// Recording delays the spawn and eats into the extension's 10 s arrival window, so each lookup gets 1 s.
const LSAPPINFO_TIMEOUT_MS = 1000;
const OPEN_TIMEOUT_MS = 3000;
const ASN = /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i;
// Never a Brave bundle: with two Brave instances (the human's and another) `open -b` is ambiguous.
const BRAVE_BUNDLE = /^com\.brave\./i;
// A bundle id is reverse-DNS; anything else, above all a leading "-", is not handed to open's argv.
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export async function readFrontApp(sys) {
  const asn = String(await sys.exec(LSAPPINFO, ["front"], { timeout: LSAPPINFO_TIMEOUT_MS })).trim();
  if (!ASN.test(asn)) throw new Error(`lsappinfo front printed ${JSON.stringify(asn.slice(0, 80))}, not an application serial number`);
  const info = String(await sys.exec(LSAPPINFO, ["info", "-only", "pid,bundleID", asn], { timeout: LSAPPINFO_TIMEOUT_MS }));
  const pid = Number(/"pid"\s*=\s*(\d+)/.exec(info)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`lsappinfo info printed no pid for ${asn}`);
  // An app without a bundle (a bare executable) prints `"CFBundleIdentifier"=[ NULL ]`.
  return { pid, bundleID: /"CFBundleIdentifier"\s*=\s*"([^"]*)"/.exec(info)?.[1] || null };
}

// --- host_request ops ---

export function createHostOps(sys, { scan = {}, relayTimeoutMs = RELAY_TIMEOUT_MS } = {}) {
  // One native host process serves exactly one browser profile for its whole life (Chrome starts a
  // host per connectNative port), so the first successful resolution is final.
  let profile = null;
  let inFlight = null;
  // Relays that have not exited, killed if this process exits first (see killRelays).
  const relays = new Set();
  // restoreKey -> { at, pid, bundleID } | { at, error }: the app that was frontmost before that relay.
  const fronts = new Map();

  function pruneFronts() {
    const now = sys.now();
    for (const [key, rec] of fronts) if (now - rec.at > FRONT_RECORD_TTL_MS) fronts.delete(key);
    while (fronts.size > MAX_FRONT_RECORDS) fronts.delete(fronts.keys().next().value);
  }

  // Recording is best effort: failing to read the frontmost app must never cost the human a
  // container tab, so the failure is kept only to explain restore_front's `reason`.
  async function recordFront(restoreKey) {
    let rec;
    try {
      rec = await readFrontApp(sys);
    } catch (e) {
      rec = { error: errCode(e) };
    }
    fronts.delete(restoreKey);
    fronts.set(restoreKey, { ...rec, at: sys.now() });
    pruneFronts();
  }

  async function profileDir(msg) {
    if (typeof msg.nonce !== "string" || !UUID.test(msg.nonce)) {
      throw new Error("profile_dir needs `nonce`: the UUID just written to chrome.storage.local as obProfileNonce");
    }
    if (!profile) {
      if (!inFlight) {
        inFlight = resolveProfile(sys, msg.nonce, scan).finally(() => { inFlight = null; });
      }
      try {
        profile = await inFlight;
      } catch (e) {
        throw new Error(`temporaryContainer could not locate this browser profile: ${e.message}`);
      }
    }
    return { binary: profile.binary, userDataDir: profile.userDataDir, profileDir: profile.profileDir, brand: profile.brand };
  }

  async function openTemporaryContainer(msg) {
    // Only the cached resolution is used. Any binary or path in the request is ignored, so a
    // compromised page of the extension cannot point this at another executable or profile.
    if (!profile) throw new Error("open_temporary_container needs a successful profile_dir in this native host first");
    if (!isBraveBinary(profile.binary, sys.platform)) {
      throw new Error(`temporaryContainer is only available in Brave; this browser is ${profile.brand} (${profile.binary}). Create the group without temporaryContainer.`);
    }
    const invalid = validateContainerRequest(msg);
    if (invalid) throw new Error(`open_temporary_container: ${invalid}`);
    // Before the spawn, so the record exists by the time the tab appears and restore_front asks for it
    // — which is while this op is still awaiting the relay's exit (handle() calls are never queued).
    if (msg.restoreKey !== undefined && sys.platform === "darwin") await recordFront(msg.restoreKey);

    const run = await runRelay(sys, profile.binary, relayArgv(profile, msg), { timeoutMs: relayTimeoutMs, live: relays });
    const relayed = /existing browser session/i.test(run.stdout || "");
    if (run.error) throw new Error(`could not start ${profile.binary} to relay the temporary container: ${errCode(run.error)}`);
    if (run.timedOut) {
      throw new Error(
        `the Brave relay did not exit within ${Math.round(relayTimeoutMs / 1000)} s ` +
          (run.killed
            ? "and was killed (left running, it would have force-quit a Brave that does not answer and taken over the profile)"
            : "and could not be killed, so it may yet start a separate browser") +
          "; no tab was handed out. Brave's UI may be stalled: retry tabs_create_mcp once Brave responds, or create the group without temporaryContainer."
      );
    }
    if (run.exitCode === 21) {
      throw new Error(
        "Brave refused the command-line relay (exit 21, profile in use). This happens when Brave was started with " +
          "--enable-automation, which disables relays; restart Brave normally, or create the group without temporaryContainer."
      );
    }
    // Exit 0 is the normal relay (Chromium maps PROCESS_NOTIFIED to 0). The stdout line is localized,
    // so it only rescues a non-zero code, never stands in for one. Either way this means "relay sent":
    // the extension still has to see the tab and verify its jar.
    if (run.exitCode !== 0 && !relayed) {
      throw new Error(`the Brave relay exited with ${run.exitCode ?? `signal ${run.signal}`} without reaching the running browser`);
    }
    return { exitCode: run.exitCode, relayed };
  }

  // Sent by the extension, unawaited, the moment it sees the relayed tab. Each skip is an answer
  // (restored:false + reason), not an error: the tab itself is fine either way.
  async function restoreFront(msg) {
    if (typeof msg.restoreKey !== "string" || !UUID.test(msg.restoreKey)) {
      throw new Error("restore_front needs `restoreKey`: the UUID that was sent with open_temporary_container");
    }
    if (sys.platform !== "darwin") {
      return { restored: false, reason: `app focus hand-back is only implemented on macOS; this native host runs on ${sys.platform}` };
    }
    pruneFronts();
    const prev = fronts.get(msg.restoreKey);
    // One hand-back per relay: a repeat would yank focus from wherever the human has gone since.
    fronts.delete(msg.restoreKey);
    if (!prev) {
      return { restored: false, reason: `no frontmost app is recorded for this restoreKey (never sent with open_temporary_container, already used, or older than ${FRONT_RECORD_TTL_MS / 1000} s)` };
    }
    if (prev.error) return { restored: false, reason: `the frontmost app could not be read before the relay: ${prev.error}` };
    // Brave was already in front, so the relay changed nothing at app level and there is nothing to give back.
    if (profile && prev.pid === profile.pid) return { restored: false, reason: "Brave itself was the frontmost app before the relay" };
    if (!prev.bundleID) return { restored: false, reason: `the app that was frontmost (pid ${prev.pid}) has no bundle id to reactivate` };
    if (BRAVE_BUNDLE.test(prev.bundleID)) return { restored: false, reason: `the app that was frontmost is a Brave bundle (${prev.bundleID}), which open -b cannot target unambiguously` };
    if (!BUNDLE_ID.test(prev.bundleID)) return { restored: false, reason: `the frontmost app's bundle id ${JSON.stringify(prev.bundleID)} is not a plain reverse-DNS id` };
    try {
      await sys.exec(OPEN, ["-b", prev.bundleID], { timeout: OPEN_TIMEOUT_MS });
    } catch (e) {
      return { restored: false, reason: `open -b ${prev.bundleID} failed: ${errCode(e)}` };
    }
    return { restored: true };
  }

  // Synchronous, for process "exit": a relay orphaned by the host's exit (the extension's port closing
  // mid-relay) would reach the same 20 s singleton timeout runRelay's kill exists to pre-empt.
  function killRelays() {
    for (const child of relays) killRelay(sys, child);
    relays.clear();
  }

  const OPS = new Map([
    ["profile_dir", profileDir],
    ["open_temporary_container", openTemporaryContainer],
    ["restore_front", restoreFront],
  ]);

  async function handle(msg) {
    const id = typeof msg?.id === "string" ? msg.id : null;
    try {
      if (id === null) throw new Error("host_request needs a string id");
      const op = OPS.get(msg.op);
      if (!op) {
        throw new Error(
          `unknown host_request op ${JSON.stringify(msg.op)}; this native host supports ${[...OPS.keys()].join(", ")}. ` +
            "Re-run ./install.sh if the extension is newer than the host."
        );
      }
      const result = await op(msg);
      return { type: "host_response", id, ok: true, ...result };
    } catch (e) {
      return { type: "host_response", id, ok: false, error: (e && e.message) || String(e) };
    }
  }

  return { handle, killRelays, get profile() { return profile; } };
}
