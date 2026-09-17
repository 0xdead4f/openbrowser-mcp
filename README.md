<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" width="300" alt="OpenBrowser MCP">
  </picture>
</p>

<p align="center">
  <em>A zero-dependency Claude in Chrome clone that attaches to your real browser profile.<br/>
  <strong>Any Chromium browser, every profile at once, Brave container support, no domain blocklist.</strong></em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 20+"> <img src="https://img.shields.io/badge/Chromium-any-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Any Chromium browser"> <img src="https://img.shields.io/badge/MCP-stdio-D97757?style=flat-square&logo=anthropic&logoColor=white" alt="MCP stdio server"> <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License">
</p>

<p align="center">
  <a href="#explanation">Explanation</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#workspaces-and-brave-temporary-containers">Workspaces &amp; Brave containers</a> ·
  <a href="#license">License</a>
</p>

---

## Explanation

An MCP server that drives real Chromium browsers over the Chrome DevTools Protocol, so a coding
agent can open a page, click through it, fill forms, read the console and network log, and pull
back whatever the page loaded.

It attaches to **your existing profile** rather than launching a clean automation profile. Whatever
you are already logged into, the agent can use — no separate login flow, no cookie export. There is
no domain blocklist.

A few things worth knowing:

- **Many profiles at once.** A detached broker process lets several agent sessions share one
  browser, and serves Chrome Default + Chrome work + Brave simultaneously. Each profile gets a
  stable id; `browser_select` pins one per agent session.
- **Every agent gets its own tab group.** Agents open background tabs in a named group of their
  own and never focus a window, so several can work in your browser while you keep using it.
- **Popup windows are drivable.** An OAuth consent window opened with `window.open` lands in a window
  of its own that Chromium will not let anything group or move. It is adopted into the tab group of
  whatever opened it, listed there by `tabs_context_mcp`, and driven like any other tab — with the same
  Brave container check, so the login happens as that agent's identity and not yours.
- **Brave container support.** In Brave, `tabs_create_mcp({temporaryContainer: true})` gives an
  agent's group its own temporary container: cookies and storage separate from your profile and
  from every other agent, so four agents can be logged in to the same site as four different users.
  See [Workspaces & Brave containers](#workspaces-and-brave-temporary-containers).
- **Refs, not screenshots.** `page_outline` or `read_page` hand back element refs like `e214` that
  you pass straight to `computer({action:"left_click", ref:"e214"})`. A screenshot costs ~1,296
  tokens; a `read_page` is roughly 15× cheaper. Take a screenshot when you need to *see* something,
  not to locate it.
- **Big things go to disk.** `sources_download` writes files to a tree and returns only counts and
  a manifest path, so a 100 MB download never becomes a 100 MB string in context.
- **Incognito** windows are supported, but all of them share one session: separate windows give you
  separate tab groups, not separate logins. For isolated cookie jars use Brave temporary containers
  or separate profiles.

> **Heads up:** this drives a real browser holding your real sessions, with `debugger` and
> `<all_urls>` permissions, and there is no approval prompt — whatever the agent asks for happens.

## Installation

**Prerequisites:** Node.js v20+, any Chromium browser (Chrome, Edge, Brave, Arc, Opera, Vivaldi),
and Claude Code or any MCP stdio client.

There is no `npm install` — the server has zero runtime dependencies.

```bash
git clone https://github.com/0xdead4f/openbrowser-mcp
cd openbrowser-mcp
./install.sh
```

The installer takes no arguments. It writes the native-messaging manifest for every Chromium
browser it finds, registers the MCP server with Claude Code, then waits for the extension to
connect. While it waits, do the one manual step:

1. open `chrome://extensions` (or `brave://extensions`, `edge://extensions`) → **Developer mode** on
2. **Load unpacked** → select the `extension/` directory
3. optional: **Details → Allow in Incognito**

It prints `✓ connected — Google Chrome / Default` and exits. Repeat step 2 once per browser; the
extension ID is pinned to `egpoedeomkhpkhiikghpjjcghafafbdc`, so one install covers every profile
of that browser.

### Registering with another coding agent

The installer only wires up Claude Code. Any other MCP stdio client needs the same two fields —
command `node`, args the absolute path to `host/mcp-server.js`:

```json
{
  "mcpServers": {
    "openbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/openbrowser-mcp/host/mcp-server.js"]
    }
  }
}
```

Put that in the client's MCP config and restart it. Where that config lives, and what the key is
called, is the only thing that differs:

| Client | Config | Key |
|---|---|---|
| Claude Code | done by `install.sh` — or `claude mcp add openbrowser -- node <repo>/host/mcp-server.js` | — |
| Cursor | `~/.cursor/mcp.json`, or `.cursor/mcp.json` per project | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| Cline / Roo | MCP Servers → Configure → `cline_mcp_settings.json` | `mcpServers` |
| VS Code (Copilot) | `.vscode/mcp.json` | `servers` |
| Zed | `settings.json` | `context_servers` |
| Codex CLI | `~/.codex/config.toml` | see below |

Codex uses TOML rather than JSON:

```toml
[mcp_servers.openbrowser]
command = "node"
args = ["/absolute/path/to/openbrowser-mcp/host/mcp-server.js"]
```

The broker is shared, so several agents — and several sessions of the same agent — can register at
once and drive the same browsers side by side. Check your client's own docs if a path above has
moved.

**If something breaks:** `./install.sh --doctor` checks every failure mode worth checking — the
manifest per browser, whether `node` resolves, the broker, stale pidfiles, and which profiles have
the extension loaded. `./install.sh --uninstall` starts over.

**After updating or changing code:** reload the extension for anything under `extension/` (this
version adds the `cookies` permission, so the browser may show a new permission warning); `pkill -f
"node.*mcp-server"` then `/mcp` for `host/`; restart the browser for `host/native-host.js`, which
Brave containers need.

## Tools

20 tools. `tabs_create_mcp` opens a tab in a group of your own and gives you its `tabId`;
everything else takes one.

| Tabs | |
|---|---|
| `tabs_context_mcp` | List every tab group — window, group id, name, colour, container — its tabs, and any popup window they opened. |
| `tabs_create_mcp` | Open a background tab in a new named group, or in `tabId`'s group; `temporaryContainer` in Brave. |
| `tabs_close_mcp` | Close one tab, or every tab of a `groupId` and the popup windows its pages opened. No `windowId`; a window closes only if nothing else was in it. |

| Interaction | |
|---|---|
| `navigate` | Go to a URL, back, or forward. |
| `computer` | Mouse, keyboard, scroll and screenshot — by `ref` or `coordinate`. |
| `form_input` | Set a form field's value by ref. |
| `javascript_tool` | Run JS in the page, isolated world by default. |
| `resize_window` | Re-point the emulated viewport; the OS window is left alone. |

| Reading the page | |
|---|---|
| `page_outline` | Headings, landmarks, forms and tables with refs — flat in page length. |
| `read_page` | Accessibility tree with refs; interactive-only by default. |
| `page_surface` | Page inventory as JSON: forms, inputs, links, scripts, iframes, storage, CSP. |
| `find` | Locate elements by text or attributes, returning refs. |
| `get_page_text` | Extract the article/main text. |
| `read_console_messages` | Console output, filtered. |

| Network & sources | |
|---|---|
| `read_network_requests` | Paginated request index, one line per request. |
| `read_network_request` | One request's headers or body, by index. |
| `sources_list` | Tree of everything the page loaded, per origin. |
| `sources_download` | Write those files to disk, sourcemaps unpacked and a URL index extracted. |

| Browsers | |
|---|---|
| `browsers_list` | Connected browsers/profiles with ids, brands and labels. |
| `browser_select` | Pin one browser as this session's default. |

Downloads land in `./source/` relative to your cwd — add it to your `.gitignore`.

## Workspaces and Brave temporary containers

An agent cannot tell which of your windows or tabs is meant for it, so each one starts its own
**workspace: a tab group**. `tabs_create_mcp({group: "checkout"})` always creates a new group (the
name defaults to the agent's working directory) with one tab, and returns that tab's id.

- **The name is a label, the tab id is the identity.** Nothing is looked up by name; two agents
  that pick the same name get two separate groups. To add a tab to a workspace, pass one of its
  tab ids: `tabs_create_mcp({tabId})`.
- **Your view stays yours.** Tabs open in the background, in the window you last used; a new
  window is only created (unfocused) when there is none. `resize_window` changes the emulated
  viewport, never the window. When a page an agent drives opens a new tab, your window is switched
  back to the tab you had. Background tabs never need activating: clicks, typing and timers work
  as if the tab were in front.
- **Any tab group is usable, ungrouped tabs are not.** An agent may act on a group you made
  yourself; a tab outside every group is refused — except by `sources_list` and `sources_download`,
  which read any tab.
- **A popup window belongs to whatever opened it.** Chromium lets nothing group or move a popup's
  tab, so it is attributed to the tab group of the page that opened it, following the chain when a
  popup opens another. A popup you opened from a tab of your own is refused like any ungrouped tab,
  and one opened from a container group must still prove it reads that container's cookie jar.

**Temporary containers (Brave only).** `tabs_create_mcp({group, temporaryContainer: true})` puts the
group's tab in a brand-new Brave temporary container, so its cookies and site storage are separate
from your profile and from every other group. On any other browser the flag is an error; without
it a group is a plain tab group with no isolation, in Brave too. It cannot be combined with
`incognito`.

```js
tabs_create_mcp({ group: "checkout as buyer", temporaryContainer: true })
// → Created tab 812 in group 4061 "checkout as buyer" (window 3, temporary container "checkout as buyer #7519").
tabs_create_mcp({ tabId: 812 })   // a second tab in the same group and the same container
```

- **One container per group.** A tab added with `tabs_create_mcp({tabId})`, and any tab a page in
  the group opens (`window.open`, `target=_blank`), stays in that group's container. Agents that
  ask at the same time each get their own container; creations run one after another, a few
  hundred milliseconds each.
- **Verified, not assumed.** Before handing out a container tab, and again before every tool call
  that acts in the page, the extension reads the tab's own cookie jar through its debugger session:
  it must carry the group's container stamp and must not see a canary cookie planted in your default
  jar. A tab that fails is refused with instructions, never used. `sources_list` and
  `sources_download` read without that check, and fetch without cookies for container tabs. In
  Brave, navigating to `about:blank` or a browser-internal page is refused for any tab not proven to
  be in your default jar — Brave silently moves a container tab into your default jar when the
  browser navigates it to `about:blank`.
- **Temporary is not wiped on close.** Closing a container's tabs does not delete its data. Brave
  removes a temporary container at a later browser restart, once nothing references it (no open
  tab, not in the last session, not among the recently closed tabs).
- **How it works.** No extension API can create a container, so the native host relaunches Brave's
  own binary with `--temporary-container --container=<name>` for your profile, and Brave hands that
  to the running browser (adding a tab to a container group works the same way). Brave opens that
  tab active and brings its app to the front: your window is switched back to the previous tab at
  once, and on macOS the native host hands focus back to the app you were in, so Brave is in front
  for roughly 20–40 ms. Works on macOS, Linux and Windows; it does not work when Brave was started
  with `--enable-automation`.
- **Known limitations.**
  - On Linux and Windows, Brave currently stays in front after each container creation (and each
    tab added to a container group); only macOS hands focus back.
  - A page an agent drives that opens a new tab (`window.open`, `target=_blank`) brings Brave to
    the front too; your tab is switched back, app focus is not.
  - When the last-focused Brave window is a popup, app or DevTools window, Brave opens the container
    tab in a new window, which closes again once the tab is moved into the chosen window.
  - Brave 1.95 has crashed when an extension edited the tab strip while a tab was being dragged
    with the mouse. The extension keeps its tab edits few and retries the ones Brave refuses during
    a drag, but avoid dragging tabs while agents are creating tabs.
  - A page an agent has driven reports itself as visible and focused, even in the background, until
    its tab closes or the broker retires (5 minutes after the last agent disconnects).

## License

MIT — see [LICENSE](LICENSE).
