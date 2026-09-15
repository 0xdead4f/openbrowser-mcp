#!/usr/bin/env bash
set -euo pipefail

# OpenBrowser MCP installer. Takes no arguments: the extension ID is pinned by
# the public key committed in extension/manifest.json, so it is identical in
# every Chromium browser and every profile and is known before install.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
EXT_DIR="$SCRIPT_DIR/extension"
WRAPPER="$HOST_DIR/native-host-wrapper.sh"
MANIFEST="$EXT_DIR/manifest.json"

HOST_NAME="io.openbrowser.mcp"
SERVER_NAME="openbrowser"
DEFAULT_PORT=18766
LEGACY_PORT=18765
MIN_NODE_MAJOR=20
WAIT_TIMEOUT="${OPENBROWSER_WAIT_TIMEOUT:-180}"

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; N=""
fi

ok()       { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
sub_ok()   { printf '    %s✓%s %s\n' "$G" "$N" "$*"; }
sub_skip() { printf '    %s-%s %s\n' "$D" "$N" "$*"; }
sub_warn() { printf '    %s!%s %s\n' "$Y" "$N" "$*"; }
sub_bad()  { printf '    %s✗%s %s\n' "$R" "$N" "$*"; }
section()  { printf '\n  %s%s%s\n' "$B" "$*" "$N"; }
die()      { printf '\n  %s✗ %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }

usage() {
  cat <<USAGE

  OpenBrowser MCP installer

    ./install.sh              install for every Chromium browser found
    ./install.sh --doctor     diagnose an existing install
    ./install.sh --uninstall  remove everything this installer wrote
    ./install.sh --help       this text

  There is no extension-ID argument: the ID is pinned by the manifest key.

USAGE
}

# --- browser discovery -----------------------------------------------------

# Browser-level data dirs. The native messaging manifest goes in
# <datadir>/NativeMessagingHosts/, which every profile of that browser shares —
# that is what makes multi-profile support free.
browser_dirs() {
  local as
  case "$(uname)" in
    Darwin)
      as="$HOME/Library/Application Support"
      cat <<EOF
Google Chrome|$as/Google/Chrome
Google Chrome Beta|$as/Google/Chrome Beta
Google Chrome Canary|$as/Google/Chrome Canary
Chromium|$as/Chromium
Brave Browser|$as/BraveSoftware/Brave-Browser
Microsoft Edge|$as/Microsoft Edge
Vivaldi|$as/Vivaldi
Opera|$as/com.operasoftware.Opera
Arc|$as/Arc/User Data
EOF
      ;;
    Linux)
      cat <<EOF
Google Chrome|$HOME/.config/google-chrome
Google Chrome Beta|$HOME/.config/google-chrome-beta
Google Chrome Dev|$HOME/.config/google-chrome-unstable
Chromium|$HOME/.config/chromium
Chromium (snap)|$HOME/snap/chromium/current/.config/chromium
Brave Browser|$HOME/.config/BraveSoftware/Brave-Browser
Microsoft Edge|$HOME/.config/microsoft-edge
Vivaldi|$HOME/.config/vivaldi
Opera|$HOME/.config/opera
EOF
      ;;
    *)
      die "unsupported platform $(uname) — macOS and Linux only. Windows: see install.ps1"
      ;;
  esac
}

pretty_path() {
  case "$1" in
    "$HOME/Library/Application Support/"*)
      printf '~/Library/…/%s' "${1#"$HOME/Library/Application Support/"}" ;;
    "$HOME/"*) printf '~/%s' "${1#"$HOME/"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# --- node helpers ----------------------------------------------------------

require_node() {
  local ver major
  ver="$(node --version)"
  major="${ver#v}"; major="${major%%.*}"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "node $ver is too old — this build needs v${MIN_NODE_MAJOR}+."
  fi
  ok "node $ver"
}

# Explicitly CommonJS: host/package.json is "type":"module" and node picks the
# module type for -e from the nearest package.json.
node_eval() { node --input-type=commonjs -e "$@"; }

port_open() {
  node_eval '
const net = require("node:net");
const s = net.connect({ port: Number(process.argv[1]), host: "127.0.0.1" });
s.on("connect", () => { s.destroy(); process.exit(0); });
s.on("error", () => process.exit(1));
setTimeout(() => { s.destroy(); process.exit(1); }, 1500);
' "$1" >/dev/null 2>&1
}

json_field() {
  node_eval '
const fs = require("node:fs");
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const v = m[process.argv[2]];
  process.stdout.write(Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v));
} catch { process.exit(1); }
' "$1" "$2" 2>/dev/null
}

config_port() {
  local p
  p="$(node_eval '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
try {
  const c = JSON.parse(fs.readFileSync(
    path.join(os.homedir(), ".config", "openbrowser-mcp", "config.json"), "utf8"));
  if (Number.isInteger(c.port) && c.port > 0 && c.port < 65536) process.stdout.write(String(c.port));
} catch {}
' 2>/dev/null || true)"
  printf '%s' "${p:-$DEFAULT_PORT}"
}

tmp_dir() { local t="${TMPDIR:-/tmp}"; printf '%s' "${t%/}"; }

# Ours plus both ancestors' names, on our port and on the port the old repo owns.
pidfile_paths() {
  local t port name
  t="$(tmp_dir)"
  for port in "$PORT" "$LEGACY_PORT"; do
    for name in openbrowser-mcp unblocked-chrome-mcp open-claude-in-chrome-mcp; do
      printf '%s/%s-%s.pid\n' "$t" "$name" "$port"
    done
  done | sort -u
}

# --- install ---------------------------------------------------------------

write_wrapper() {
  # Quoted heredoc: nothing in here is expanded at install time, on purpose.
  cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/bin/sh
# Generated by install.sh — do not edit; re-run ./install.sh to regenerate.
#
# node is located at RUN time rather than baked in from `which node` at install
# time: a wrapper holding an absolute path dies the moment nvm switches version,
# and it surfaces only as an unexplained "native host has exited".

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [ -r "$HOME/.nvm/alias/default" ]; then
    read -r ver < "$HOME/.nvm/alias/default"
    for c in "$HOME/.nvm/versions/node/$ver/bin/node" \
             "$HOME/.nvm/versions/node/v$ver"*/bin/node; do
      if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
  fi
  for c in "$HOME"/.nvm/versions/node/*/bin/node \
           /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

NODE=$(find_node) || {
  echo "io.openbrowser.mcp: no node on PATH, in ~/.nvm, /opt/homebrew, /usr/local or /usr/bin" >&2
  exit 1
}

# Chrome only ever passes the calling extension origin; --which-node lets
# --doctor probe this exact resolution under Chrome's minimal environment.
if [ "${1:-}" = "--which-node" ]; then
  printf '%s\n' "$NODE"
  exit 0
fi

DIR=$(cd "$(dirname "$0")" && pwd)
exec "$NODE" "$DIR/native-host.js"
WRAPPER_EOF
  chmod +x "$WRAPPER"
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

host_manifest() {
  cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "OpenBrowser MCP native messaging host",
  "path": "$(json_escape "$WRAPPER")",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
}

install_hosts() {
  section "Installing native messaging host $HOST_NAME"
  local found=0 label datadir nmh
  while IFS='|' read -r label datadir; do
    [ -n "$label" ] || continue
    if [ ! -d "$datadir" ]; then
      printf '    %s-%s %-22s not installed, skipped\n' "$D" "$N" "$label"
      continue
    fi
    nmh="$datadir/NativeMessagingHosts"
    mkdir -p "$nmh"
    host_manifest > "$nmh/$HOST_NAME.json"
    printf '    %s✓%s %-22s %s/\n' "$G" "$N" "$label" "$(pretty_path "$nmh")"
    found=$((found + 1))
  done <<< "$(browser_dirs)"

  [ "$found" -gt 0 ] || sub_warn "no Chromium browser found — nothing to talk to yet"
}

register_claude() {
  section "Registering MCP server with Claude Code"
  local cmd="claude mcp add $SERVER_NAME -- node $HOST_DIR/mcp-server.js"
  if ! command -v claude >/dev/null 2>&1; then
    sub_skip "claude CLI not found — run this once it is installed:"
    printf '      %s\n' "$cmd"
    return 0
  fi
  local out=""
  if out="$(claude mcp add "$SERVER_NAME" -- node "$HOST_DIR/mcp-server.js" 2>&1)"; then
    sub_ok "$cmd"
  elif printf '%s' "$out" | grep -qi 'already exist'; then
    sub_ok "already registered"
  else
    sub_warn "claude mcp add failed — run it yourself:"
    printf '      %s\n' "$cmd"
    printf '      %s%s%s\n' "$D" "$out" "$N"
  fi
}

start_broker() {
  if port_open "$PORT"; then return 0; fi
  ( exec node "$HOST_DIR/mcp-server.js" --broker ) </dev/null >/dev/null 2>&1 &
  local i=0
  while [ "$i" -lt 40 ]; do
    if port_open "$PORT"; then return 0; fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

wait_for_extension() {
  section "Last step — load the extension (once per browser):"
  printf '    1. open  chrome://extensions   → Developer mode ON\n'
  printf '    2. Load unpacked → select  %s\n' "$EXT_DIR"
  printf '    3. (optional) enable "Allow in Incognito" for incognito windows\n\n'

  # The blocking wait is a helper mode of the host process. A checkout that
  # predates it has nothing to block on, so say so instead of spinning forever.
  if ! grep -q -- '--wait-for-host' "$HOST_DIR/mcp-server.js" 2>/dev/null; then
    printf '  This host build cannot report the connection back. Load the extension,\n'
    printf '  then confirm it with:  ./install.sh --doctor\n\n'
    return 0
  fi

  local out; out="$(mktemp "$(tmp_dir)/openbrowser-wait.XXXXXX")"
  node "$HOST_DIR/mcp-server.js" --wait-for-host </dev/null >"$out" 2>/dev/null &
  local wpid=$!

  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  local i=0 start=$SECONDS timed_out=0
  [ -t 1 ] || printf '  Waiting for the extension to connect…\n'
  while kill -0 "$wpid" 2>/dev/null; do
    if [ $((SECONDS - start)) -ge "$WAIT_TIMEOUT" ]; then
      timed_out=1
      kill "$wpid" 2>/dev/null || true
      break
    fi
    # \r only redraws on a terminal; in a log it would be one line per frame.
    [ -t 1 ] && printf '\r  Waiting for the extension to connect… %s' "${frames[$((i % 10))]}"
    i=$((i + 1))
    sleep 0.12
  done

  local status=0
  wait "$wpid" 2>/dev/null || status=$?
  [ -t 1 ] && printf '\r%-64s\r' " "

  if [ "$timed_out" -eq 0 ] && [ "$status" -eq 0 ]; then
    local desc
    desc="$(tr -d '\r' < "$out" | grep -v '^[[:space:]]*$' | tail -1 || true)"
    desc="$(printf '%s' "$desc" | sed 's/^connected[[:space:]]*[—-]*[[:space:]]*//')"
    rm -f "$out"
    ok "connected — ${desc:-browser}"
    printf '\n'
    return 0
  fi

  rm -f "$out"
  printf '  %sStill waiting after %ss.%s The install is complete — the extension just\n' "$Y" "$WAIT_TIMEOUT" "$N"
  printf '  has not connected. Load it, then run:\n'
  printf '    ./install.sh --doctor\n\n'
  return 0
}

cmd_install() {
  printf '\n  %sOpenBrowser MCP installer%s\n' "$B" "$N"
  require_node
  ok "extension id  $EXT_ID  (pinned via manifest key)"

  write_wrapper
  install_hosts
  register_claude

  if ! start_broker; then
    printf '\n'
    sub_warn "broker did not come up on port $PORT — ./install.sh --doctor for why"
  fi

  wait_for_extension
}

# --- doctor ----------------------------------------------------------------

# An unpacked extension's ID appears verbatim in the profile's preference files,
# so a plain scan answers "is it actually loaded" per profile.
profiles_with_extension() {
  local datadir="$1" hits="" pref base
  for pref in "$datadir"/*/Preferences "$datadir"/*/"Secure Preferences"; do
    [ -f "$pref" ] || continue
    if LC_ALL=C grep -q "$EXT_ID" "$pref" 2>/dev/null; then
      base="$(basename "$(dirname "$pref")")"
      case " $hits " in *" $base "*) ;; *) hits="$hits $base" ;; esac
    fi
  done
  printf '%s' "${hits# }"
}

doctor_browsers() {
  section "Native messaging host $HOST_NAME"
  local label datadir nmh mf mpath origins loaded seen=0
  while IFS='|' read -r label datadir; do
    [ -n "$label" ] || continue
    [ -d "$datadir" ] || continue
    seen=$((seen + 1))
    printf '    %s%s%s\n' "$B" "$label" "$N"
    nmh="$datadir/NativeMessagingHosts"
    mf="$nmh/$HOST_NAME.json"

    if [ ! -f "$mf" ]; then
      printf '      %s✗%s manifest   missing — re-run ./install.sh\n' "$R" "$N"
      continue
    fi
    printf '      %s✓%s manifest   %s\n' "$G" "$N" "$(pretty_path "$mf")"

    mpath="$(json_field "$mf" path || true)"
    if [ -z "$mpath" ]; then
      printf '      %s✗%s path       manifest JSON unreadable\n' "$R" "$N"
    elif [ ! -f "$mpath" ]; then
      printf '      %s✗%s path       %s does not exist\n' "$R" "$N" "$(pretty_path "$mpath")"
    elif [ ! -x "$mpath" ]; then
      printf '      %s✗%s path       %s is not executable\n' "$R" "$N" "$(pretty_path "$mpath")"
    elif [ "$mpath" != "$WRAPPER" ]; then
      printf '      %s!%s path       points at another checkout: %s\n' "$Y" "$N" "$(pretty_path "$mpath")"
    else
      printf '      %s✓%s path       %s (executable)\n' "$G" "$N" "$(pretty_path "$mpath")"
    fi

    origins="$(json_field "$mf" allowed_origins || true)"
    if printf '%s' "$origins" | grep -q "chrome-extension://$EXT_ID/"; then
      printf '      %s✓%s origins    chrome-extension://%s/\n' "$G" "$N" "$EXT_ID"
    else
      printf '      %s✗%s origins    pinned ID absent — re-run ./install.sh\n' "$R" "$N"
    fi

    loaded="$(profiles_with_extension "$datadir")"
    if [ -n "$loaded" ]; then
      printf '      %s✓%s extension  loaded in %s\n' "$G" "$N" "$loaded"
    else
      printf '      %s-%s extension  not loaded in any profile yet\n' "$D" "$N"
    fi
  done <<< "$(browser_dirs)"

  [ "$seen" -gt 0 ] || sub_skip "no Chromium browser found"
}

doctor_wrapper() {
  section "Wrapper node resolution"
  if [ ! -x "$WRAPPER" ]; then
    sub_bad "$(pretty_path "$WRAPPER") missing — re-run ./install.sh"
    return 0
  fi
  # env -i is the point: Chrome starts native hosts with almost no environment,
  # which is exactly where a baked-in nvm path fails.
  local resolved
  resolved="$(env -i HOME="$HOME" "$WRAPPER" --which-node 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    sub_ok "$resolved  (found from a minimal environment)"
  else
    sub_bad "no node found from a minimal environment — the bridge cannot start"
  fi
}

doctor_broker() {
  section "Broker"
  local t live_pid="" stale="" pidfile pid cmdline
  t="$(tmp_dir)"

  if port_open "$PORT"; then
    sub_ok "listening on port $PORT"
  else
    sub_skip "port $PORT free — no broker running (one is started on demand)"
  fi

  while IFS= read -r pidfile; do
    [ -f "$pidfile" ] || continue
    pid="$(tr -dc '0-9' < "$pidfile" || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      if [ "$pidfile" = "$t/openbrowser-mcp-$PORT.pid" ]; then
        live_pid="$pid"
      else
        sub_warn "$(basename "$pidfile") → pid $pid alive (another repo's broker)"
      fi
    else
      stale="$stale $(basename "$pidfile")"
    fi
  done <<< "$(pidfile_paths)"

  if [ -n "$live_pid" ]; then
    sub_ok "pidfile → pid $live_pid alive"
    cmdline="$(ps -o command= -p "$live_pid" 2>/dev/null || true)"
    case "$cmdline" in
      *"$HOST_DIR/mcp-server.js"*)
        sub_ok "broker is running this checkout (extension $(repo_version))" ;;
      "")
        sub_warn "cannot read the broker's command line" ;;
      *)
        sub_bad "broker is running a DIFFERENT checkout — stop it with: kill $live_pid"
        printf '      %s%s%s\n' "$D" "$cmdline" "$N" ;;
    esac
  fi

  if [ -n "$stale" ]; then
    sub_warn "stale pidfiles:$stale"
    printf '      %sclear them with: ./install.sh --uninstall%s\n' "$D" "$N"
  else
    sub_ok "no stale pidfiles"
  fi
}

repo_version() {
  local v
  v="$(json_field "$MANIFEST" version || true)"
  printf '%s' "${v:-?}"
}

doctor_repo() {
  section "Repo"
  if [ -d "$HOST_DIR/node_modules" ]; then
    sub_warn "host/node_modules exists — this build has zero runtime deps; delete it"
  else
    sub_ok "host/node_modules absent (zero runtime dependencies)"
  fi
  if [ -f "$HOST_DIR/mcp-server.js" ] && [ -f "$HOST_DIR/native-host.js" ]; then
    sub_ok "host/ intact"
  else
    sub_bad "host/mcp-server.js or host/native-host.js missing"
  fi
}

cmd_doctor() {
  printf '\n  %sOpenBrowser MCP doctor%s\n' "$B" "$N"
  require_node
  ok "extension id  $EXT_ID  (pinned via manifest key)"
  doctor_browsers
  doctor_wrapper
  doctor_broker
  doctor_repo
  printf '\n'
}

# --- uninstall -------------------------------------------------------------

cmd_uninstall() {
  printf '\n  %sOpenBrowser MCP uninstaller%s\n' "$B" "$N"

  section "Removing native messaging host manifests"
  local label datadir mf removed=0
  while IFS='|' read -r label datadir; do
    [ -n "$label" ] || continue
    mf="$datadir/NativeMessagingHosts/$HOST_NAME.json"
    if [ -f "$mf" ]; then
      rm -f "$mf"
      printf '    %s✓%s %-22s %s\n' "$G" "$N" "$label" "$(pretty_path "$mf")"
      removed=$((removed + 1))
    fi
  done <<< "$(browser_dirs)"
  [ "$removed" -gt 0 ] || sub_skip "nothing to remove"

  section "Stopping the broker"
  local pidfile pid killed=0
  while IFS= read -r pidfile; do
    [ -f "$pidfile" ] || continue
    pid="$(tr -dc '0-9' < "$pidfile" || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # A live pid under a predecessor repo's name is that repo's broker, and both are
      # meant to run side by side. Uninstalling us must not take it down; only
      # its pidfile is swept, and only once it is dead.
      case "$(basename "$pidfile")" in
        openbrowser-mcp-*) ;;
        *)
          sub_warn "$(basename "$pidfile") → pid $pid alive (another repo's broker) — left running"
          continue ;;
      esac
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
      sub_ok "pid $pid terminated"
      killed=$((killed + 1))
    fi
    rm -f "$pidfile"
  done <<< "$(pidfile_paths)"
  [ "$killed" -gt 0 ] || sub_skip "no broker running"

  section "Removing the Claude Code MCP entry"
  if command -v claude >/dev/null 2>&1; then
    if claude mcp remove "$SERVER_NAME" >/dev/null 2>&1; then
      sub_ok "claude mcp remove $SERVER_NAME"
    else
      sub_skip "no $SERVER_NAME entry registered"
    fi
  else
    sub_skip "claude CLI not found — remove the entry yourself if it exists"
  fi

  section "Removing local state"
  local cfg="$HOME/.config/openbrowser-mcp"
  if [ -d "$cfg" ]; then
    rm -rf "$cfg"
    sub_ok "$(pretty_path "$cfg")"
  else
    sub_skip "$(pretty_path "$cfg") already gone"
  fi
  if [ -f "$WRAPPER" ]; then
    rm -f "$WRAPPER"
    sub_ok "$(pretty_path "$WRAPPER")"
  fi

  printf '\n  The extension itself is still loaded — remove it from chrome://extensions.\n\n'
}

# --- main ------------------------------------------------------------------

case "${1-}" in
  --help|-h) usage; exit 0 ;;
esac

[ -f "$MANIFEST" ] || die "extension/manifest.json not found — run this from the repo checkout."
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js ${MIN_NODE_MAJOR}+ and re-run."

EXT_ID="$(node "$SCRIPT_DIR/host/lib/extid.js" "$MANIFEST")" \
  || die "could not derive the extension ID from $(pretty_path "$MANIFEST")"
case "$EXT_ID" in
  [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
  *) die "derived extension ID looks wrong: '$EXT_ID'" ;;
esac
PORT="$(config_port)"

case "${1-}" in
  "")          cmd_install ;;
  --doctor)    cmd_doctor ;;
  --uninstall) cmd_uninstall ;;
  *)           usage >&2; die "unknown argument: $1" ;;
esac
