# Changelog

The version lives in `extension/manifest.json` only; the host reads it from there. To release, bump it,
move the Unreleased entries under the new version with today's date, commit, and tag `vX.Y.Z`.

## Unreleased

### Added
- `tabs_create_mcp({container: "<name>"})` opens a tab in one of the Brave profile's own named containers
  (Personal, Work, ...), verified like a temporary container. Needs the updated native host.

## 0.3.0 — 2026-11-14

### Added
- `computer({action: "accept_dialog"})` presses OK on an `alert`, `confirm` or `prompt`; `text` answers a
  prompt. A tool call stalled behind an open dialog now returns the dialog's message instead of hanging
  until the client's timeout.
- Agent workspaces as tab groups: `tabs_create_mcp` opens a background tab in a new named group, and every
  agent keeps to its own group.
- Brave temporary containers: `tabs_create_mcp({temporaryContainer: true})` gives a group its own cookies
  and storage, checked before every page tool call.
- Popup windows (OAuth consent and the like) are adopted into their opener's tab group and can be driven.
- README: registering the server with MCP clients other than Claude Code.

### Fixed
- `beforeunload` "Leave site?" prompts are accepted, so `navigate` and `tabs_close_mcp` no longer stall.
- `computer` measured coordinates before the viewport override landed, so clicks missed in small windows.
- `navigate` back/forward into an `about:` entry could move a Brave container tab into the default jar.
- `host/lib/extid.js` with no arguments looked for the manifest one directory too deep.

## 0.2.0 — 2026-07-29

First release.
