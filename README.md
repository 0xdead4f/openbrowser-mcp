<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" width="300" alt="OpenBrowser MCP">
  </picture>
</p>

<p align="center">
  <em>A Claude in Chrome clone that attaches to your real browser profile and drives it live.<br/>
  <strong>Any Chromium browser, every profile at once, no domain blocklist.</strong></em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 20+"> <img src="https://img.shields.io/badge/Chromium-any-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Any Chromium browser"> <img src="https://img.shields.io/badge/MCP-stdio-D97757?style=flat-square&logo=anthropic&logoColor=white" alt="MCP stdio server"> <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License">
</p>

<p align="center">
  <a href="#explanation">Explanation</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#tools">Tools</a> ·
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
- **Refs, not screenshots.** `page_outline` or `read_page` hand back element refs like `e214` that
  you pass straight to `computer({action:"left_click", ref:"e214"})`. A screenshot costs ~1,296
  tokens; a `read_page` is roughly 15× cheaper. Take a screenshot when you need to *see* something,
  not to locate it.
- **Big things go to disk.** `sources_download` writes files to a tree and returns only counts and
  a manifest path, so a 100 MB download never becomes a 100 MB string in context.
- **Incognito** windows are supported, but all of them share one session: separate windows give you
  separate tab groups, not separate logins. Use separate profiles for isolated cookie jars.

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

**If something breaks:** `./install.sh --doctor` checks every failure mode worth checking — the
manifest per browser, whether `node` resolves, the broker, stale pidfiles, and which profiles have
the extension loaded. `./install.sh --uninstall` starts over.

**After changing code:** reload the extension for anything under `extension/`; `pkill -f
"node.*mcp-server"` then `/mcp` for `host/`; restart the browser for `host/native-host.js`.

## Tools

20 tools. `tabs_context_mcp` gives you a `tabId`; everything else takes one.

| Tabs | |
|---|---|
| `tabs_context_mcp` | List MCP windows and their tabs. |
| `tabs_create_mcp` | Open a tab, optionally in a new or incognito window. |
| `tabs_close_mcp` | Close an MCP tab, or a whole MCP window. |

| Interaction | |
|---|---|
| `navigate` | Go to a URL, back, or forward. |
| `computer` | Mouse, keyboard, scroll and screenshot — by `ref` or `coordinate`. |
| `form_input` | Set a form field's value by ref. |
| `javascript_tool` | Run JS in the page, isolated world by default. |
| `resize_window` | Re-point the emulated viewport. |

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

## License

MIT — see [LICENSE](LICENSE).
