# Browser Bridge Ext

Let an AI coding agent drive your real Chrome, Edge, or Firefox — without headless, without Selenium, without
losing your login sessions. It turns your browser into a tool any local agent can use.

[![npm version](https://img.shields.io/npm/v/browser-bridge-ext.svg)](https://www.npmjs.com/package/browser-bridge-ext)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

### What you can do

| Use case | How |
|---|---|
| **Automate web flows** | Agent fills forms, clicks buttons, checks out on e-commerce sites |
| **Test web apps** | Agent navigates, takes screenshots, reads console/network logs |
| **AI-assisted browsing** | Agent reads page structure, runs JS, extracts data |
| **Record & replay** | Agent records actions as GIFs for debugging or documentation |

```
agent ──MCP stdio / CLI──► bridge (Node) ◄──native messaging or WebSocket──► extension (Chrome / Edge / Firefox)
```

## Built to save context

- **8 tools** with terse schemas, about 1k tokens in total. Set `BROWSERBRIDGE_TOOLS=nav,read,act` to expose fewer.
- **`read` returns a compact element list** instead of HTML or screenshots. It has one line per
  interactive element, each with a ref:
  ```
  Shop | http://localhost:3000/ [scroll 0/2361]
  # Checkout
  e4 input "Email" [email]
  e6 select "Country" ="United States" {United States|India}
  e7 checkbox "I agree"
  e9 button "Place order"
  ```
  Output is capped at 4000 chars per page, with `offset=` for more. `mode=find q=...` returns just the matches.
- **Actions return `ok`** plus the new URL if the page navigated. Pass `read=true` to get the updated list in
  the same call, which saves a round trip.
- **Screenshots are JPEG**, at most 1024px wide and about 1.6 MP. Pass `save=path` to keep the image out of
  the context entirely. GIFs and uploads go through files on disk, never through the context.
- **Logs are filtered**: repeated lines are de-duplicated and static assets hidden. `kind=errors` merges JS
  errors with failed requests.
- **The CLI mode costs nothing until it is used.** A harness without MCP only needs the short `dist/SKILL.md`.

## Setup

Full step-by-step guide, server details and troubleshooting: **[SETUP.md](SETUP.md)**.

Requires Node 18+.

```sh
npm install
npm run build                    # dist/bridge.cjs + dist/chrome, dist/edge, dist/firefox
node dist/bridge.cjs install     # registers the native messaging host (current user only)
```

### Load the extension

| Browser | Steps |
|---|---|
| Chrome | `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome` |
| Edge | `edge://extensions` → Developer mode → **Load unpacked** → `dist/edge` |
| Firefox | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox/manifest.json`, then open the toolbar popup → **Grant site access** |

The Chromium build ships with a fixed key, so its id is stable (`dist/ext-id.json`) and already allowed by
the native host. Temporary add-ons in Firefox are removed when Firefox restarts. To keep the add-on
permanently, sign it as an unlisted add-on (`npx web-ext sign --channel=unlisted`), or use Firefox Developer
Edition with `xpinstall.signatures.required=false`.

The popup shows a green dot when the extension is connected.

### Connect your agent

**MCP clients:** most agents accept the standard config:

```json
{ "mcpServers": { "browser": { "command": "node", "args": ["D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs"] } } }
```

**Hermes Agent** (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  browser:
    command: node
    args: ["D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs"]
```

**Pi, or any harness without MCP:** copy `dist/SKILL.md` into its skills folder, or paste it into
`AGENTS.md`. The agent then runs shell commands:

```sh
node dist/bridge.cjs call nav url=localhost:3000 read=true
node dist/bridge.cjs call act a=click ref=e9
node dist/bridge.cjs call act a=fill 'fields={"e4":"ann@x.io","e7":true}'
node dist/bridge.cjs call shot          # prints the path of a temp JPEG
node dist/bridge.cjs tools              # tool reference
```

Environment variables:

| Variable | Effect |
|---|---|
| `BROWSERBRIDGE_BROWSER=firefox` | Prefer this browser when several are connected (default: most recently connected) |
| `BROWSERBRIDGE_TOOLS=nav,read,act` | Expose only these tools over MCP |
| `BROWSERBRIDGE_PORT=47821` | Hub port |

## Tools

| Tool | Purpose |
|---|---|
| `tabs` | list / new / select / close / resize. New tabs join an orange "Agent" tab group (Chromium). |
| `nav` | URL, `back`, `forward`, `reload`. Waits for load. |
| `read` | `tree` (default), `all` (adds text and landmarks), `text`, `find` (words or `css:` selector). Covers shadow DOM and same-origin iframes. |
| `act` | `click dblclick rclick hover type key fill scroll drag upload wait`, by ref or by screenshot x,y |
| `shot` | viewport, element (`ref`), zoom (`region`), or full page (`full`); `save=path` |
| `js` | Evaluates code in the page. Top-level `await` works. |
| `logs` | `console`, `errors` (JS errors and failed requests), `network` |
| `gif` | `start`, `stop`, `save path=...`. Records a frame per action, with click markers. |

## How it connects

- **Hub.** The first bridge process to start (the native host or an MCP server) listens on
  `127.0.0.1:47821`. Later processes connect to it as clients, and if the hub process exits the others
  elect a new one. Several agents and several browsers can share the hub.
- **Native messaging (default).** The browser starts the bridge itself through the registered host, so
  nothing needs to be configured. Only this extension's id may connect to the host.
- **WebSocket (fallback).** Paste the output of `node dist/bridge.cjs token` into the panel under
  Connection. In `auto` mode the extension tries native messaging first.

## Safety

- **Per-site approval** by default: the first time an agent touches a site, a popup asks you to *Allow
  this session*, *Always allow* or *Deny*. Allowed and blocked sites are managed in the panel.
- **Pause** stops all agent actions instantly.
- An **orange glow** marks the tab the agent is controlling.
- **Hub access is restricted**: it listens on 127.0.0.1 only and needs a random token
  (`~/.browserbridge/token`). Connections that carry a web-page `Origin` are rejected, so websites cannot reach it.
- **Dialogs**: `alert`, `confirm` and `prompt` are auto-answered only in tabs the agent controls, and each
  one is logged.
- **Page content is untrusted.** The MCP server tells the agent this in its instructions.

## Browser differences

| | Chrome / Edge | Firefox |
|---|---|---|
| Input | Trusted events through the debugger API (shows the "debugging this browser" bar; can be turned off in the panel) | Synthetic DOM events, with emulated Enter-to-submit, Tab, Backspace and select-all |
| `js` | Ignores page CSP | Blocked on pages whose CSP forbids `eval` |
| Full-page shot | Debugger API | `tabs.captureTab` |
| Tab groups / side panel | Yes / side panel | No / sidebar |

## Commands

```
node dist/bridge.cjs            MCP server (stdio)
node dist/bridge.cjs serve      headless hub for startup tasks (start-browserbridge.cmd)
node dist/bridge.cjs call ...   one tool call
node dist/bridge.cjs status     hub, browsers, agents
node dist/bridge.cjs get-chromium | headless [--browser ..] [--setup]
node dist/bridge.cjs install | uninstall | token | tools
npm run check                   type-check
```

## Headless Chrome

Branded Chrome 137+ ignores `--load-extension`, so headless needs one of:

- **Chrome for Testing / Chromium** (no manual step): `node dist/bridge.cjs get-chromium` once, then
  `node dist/bridge.cjs headless --browser testing`.
- **Branded Chrome or Edge**: `node dist/bridge.cjs headless --browser chrome --setup` opens a window on a dedicated profile.
  Enable Developer mode, click *Load unpacked*, choose `dist\chrome`, close it. After that
  `node dist/bridge.cjs headless --browser chrome` starts it headless.

Headless instances report as `chrome-headless`; target them with `BROWSERBRIDGE_BROWSER=headless`. They run in
allow-all mode (no one can click the approval prompt) on a throwaway profile (`~/.browserbridge/headless-profile`).
After rebuilding the extension, delete that profile, because Chrome caches the old extension code in it.

## License

MIT License — free for personal, educational, and non-commercial use.
Commercial / business use requires a paid license. Contact [vikasrulez@gmail.com](mailto:vikasrulez@gmail.com).
