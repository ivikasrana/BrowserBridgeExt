# Setup and Running Guide

This guide covers where everything lives, how to install it, how the server runs, and how to fix common problems.
For the feature overview and tool reference, see [README.md](README.md).

---

## 1. What is where

```
D:\.Net\Projects\BrowserBridgeExt\
├── src\
│   ├── bridge\          server source (Node / TypeScript)
│   │   ├── cli.ts         entry point, picks the mode (mcp / native / call / install …)
│   │   ├── mcp.ts         MCP server over stdio
│   │   ├── headless.ts    get-chromium and headless launcher
│   │   ├── native.ts      native messaging host (started by the browser)
│   │   ├── link.ts        hub election + WebSocket connection
│   │   ├── hub.ts         routes tool calls between agents and browsers
│   │   ├── client.ts      agent side: sends calls, writes images/GIFs to disk
│   │   ├── install.ts     registers the native host with the browsers
│   │   └── config.ts      token, port
│   ├── ext\             browser extension source
│   └── shared\          tool definitions, protocol, key parsing
├── skill\SKILL.md       template for harnesses without MCP
├── build.mjs            build script
└── dist\                build output (created by npm run build)
    ├── bridge.cjs         ← THE SERVER (one file, all modes)
    ├── chrome\            extension for Chrome
    ├── edge\              extension for Edge
    ├── firefox\           extension for Firefox
    ├── ext-id.json        extension ids the native host allows
    └── SKILL.md           ready-to-use skill file with this machine's path
```

Files created outside the project:

| Path | What |
|---|---|
| `%USERPROFILE%\.browserbridge\token` | Random secret the hub requires on every connection |
| `%USERPROFILE%\.browserbridge\browserbridge-host.bat` | Launcher the browser runs to start the native host |
| `%USERPROFILE%\.browserbridge\com.browserbridge.ext.chromium.json` | Native host manifest for Chrome, Edge, Chromium and Brave |
| `%USERPROFILE%\.browserbridge\com.browserbridge.ext.firefox.json` | Native host manifest for Firefox |
| `HKCU\Software\...\NativeMessagingHosts\com.browserbridge.ext` | Registry keys pointing each browser at those manifests |

On macOS and Linux, the launcher is `~/.browserbridge/browserbridge-host.sh` and the manifests go into each browser's
`NativeMessagingHosts` folder instead of the registry.

---

## 2. How the server works

`dist\bridge.cjs` is the only server, and it runs in different modes depending on who starts it:

| Started by | Command | Mode |
|---|---|---|
| Your agent | `node dist/bridge.cjs` | **MCP server** on stdio |
| The browser extension | `browserbridge-host.bat` → `bridge.cjs native` | **Native host** |
| Windows logon task | `start-browserbridge.cmd` → `bridge.cjs serve` | **Headless hub**, no stdin |
| You or a shell-based harness | `node dist/bridge.cjs call <tool> …` | **One-shot CLI** |

**The hub.** Every one of these processes tries to listen on `127.0.0.1:47821`:

- The **first** process to start gets the port and becomes the **hub**.
- Every later process **connects to the hub** as a client.
- If the hub process exits, the remaining processes **elect a new hub** automatically, within about a second.

```
 agent A ─┐                                      ┌─ Chrome extension
 agent B ─┼─► hub on 127.0.0.1:47821 (any bridge) ◄┼─ Edge extension
 CLI call ─┘                                      └─ Firefox extension
```

You never start the hub separately. As long as a browser with the extension is open, its native host keeps
a hub running.

**Browser to bridge transports:**

1. **Native messaging** (default). The browser starts `browserbridge-host.bat`. It needs the one-time `install` step.
2. **WebSocket** (fallback). The extension connects to `ws://127.0.0.1:47821` with the token. This needs no
   registry entries, but a bridge process (for example your agent's MCP server) must already be running.

---

## 3. First-time installation

### 3.1 Requirements

- Node.js 18 or newer (`node -v`)
- Chrome, Edge or Firefox 128+

### 3.2 Build

```powershell
cd D:\.Net\Projects\BrowserBridgeExt
npm install
npm run build
```

Expected output ends with:

```
built dist/ (bridge.cjs, chrome, edge, firefox)  chromium extension id: encfpbpnnljdbfaeinmgbengbfgedhoh
```

Re-run `npm run build` after changing any file in `src\`. Then reload the extension on the browser's
extensions page.

### 3.3 Register the native host (once per user)

```powershell
node dist/bridge.cjs install
```

This writes the files and registry keys listed in section 1 and prints:

```
Native host registered for Chrome, Edge, Chromium, Brave and Firefox.
  launcher:      C:\Users\<you>\.browserbridge\browserbridge-host.bat
  extension ids: encfpbpnnljdbfaeinmgbengbfgedhoh (Chromium), browser-bridge-ext@browserbridge.local (Firefox)
  hub:           ws://127.0.0.1:47821
  token:         <64 hex chars>
```

Run it again if you **move the project folder** or **change Node versions**, because the launcher stores
absolute paths.

If your Chromium extension id differs from `dist\ext-id.json` (for example after rebuilding on another
machine without the `keys\` folder), pass it explicitly:

```powershell
node dist/bridge.cjs install --chrome-id <id> --edge-id <id>
```

### 3.4 Load the extension

**Chrome**
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `D:\.Net\Projects\BrowserBridgeExt\dist\chrome`.

**Edge**
1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked** and choose `D:\.Net\Projects\BrowserBridgeExt\dist\edge`.

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and choose `D:\.Net\Projects\BrowserBridgeExt\dist\firefox\manifest.json`.
3. Click the extension's toolbar icon, then **Grant site access**.
4. Temporary add-ons are removed when Firefox restarts. To install permanently, either:
   - sign it as an unlisted add-on: `npx web-ext sign --channel=unlisted --source-dir dist/firefox`
     (needs a free addons.mozilla.org API key), or
   - use Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false` in
     `about:config`.

### 3.5 Check the connection

1. Click the extension icon. The dot should be **green**, with the status *connected via native host*.
2. In a terminal:

   ```powershell
   node dist/bridge.cjs status
   ```

   Expected:

   ```
   hub pid 12345
   browsers: chrome
   agents: cli
   ```

3. Try a real call:

   ```powershell
   node dist/bridge.cjs call tabs
   node dist/bridge.cjs call nav url=example.com read=true
   ```

   The first time the agent touches a site, an approval popup opens in the browser. Choose **Allow this session**.

---

## 4. Connecting an agent

### 4.1 Agents with MCP support

The server command is always:

```
node D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs
```

**Generic `mcpServers` JSON** (used by most MCP clients and editors):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs"]
    }
  }
}
```

**Agents with an `mcp add` command:**

```powershell
<agent-cli> mcp add browser -- node D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs
```

**Hermes Agent** (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  browser:
    command: node
    args: ["D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs"]
```

The agent starts and stops the server itself. You do not keep it running in a terminal.

### 4.3 Starting the hub with Windows

A stdio MCP server exits when its stdin closes, so it cannot run from a startup task. Use `serve` instead: it
hosts the hub with no stdin, and agents and browsers attach to it. `start-browserbridge.cmd` runs it. On this
machine it is an extra first action in the scheduled task **TencentDB Agent Memory Gateway** (runs at logon, 1 minute
delay, detached, logs to `bridge.log`). It must be first because the gateway action never exits and Task
Scheduler runs actions in order. The original task XML is backed up at `%TEMP%gateway-task-backup.xml`.
Stopping or disabling that task also stops the bridge.

### 4.4 Headless Chrome

Branded Chrome 137+ ignores `--load-extension`. Options:

- **Chrome for Testing (no manual step):** `node dist/bridge.cjs get-chromium` once, then
  `node dist/bridge.cjs headless --browser testing`.
- **Branded Chrome or Edge:** `headless --browser chrome --setup` opens a window on a dedicated profile. Enable
  Developer mode, *Load unpacked* `distchrome`, close it. Then `headless --browser chrome` runs headless.

Headless browsers report as `chrome-headless`; target them with `BROWSERBRIDGE_BROWSER=headless`. They skip the
site-approval prompt (nobody can click it) and run allow-all except blocked sites, on the profile
`~/.browserbridge/headless-profile`. After rebuilding, delete that profile: Chrome caches the old extension code in it.
Set `BROWSERBRIDGE_CHROME` to use a specific browser executable.

Optional environment variables, set in the same config under `env`:

```json
"env": { "BROWSERBRIDGE_TOOLS": "tabs,nav,read,act,shot", "BROWSERBRIDGE_BROWSER": "chrome" }
```

| Variable | Default | Effect |
|---|---|---|
| `BROWSERBRIDGE_TOOLS` | all 8 tools | Comma-separated list of tools to expose (smaller list = less context) |
| `BROWSERBRIDGE_BROWSER` | most recently connected | Prefer `chrome`, `edge` or `firefox` when several are connected |
| `BROWSERBRIDGE_PORT` | `47821` | Hub port; must match the extension's panel setting when using WebSocket |

### 4.2 Harnesses without MCP (Pi and others)

Use the CLI. `dist\SKILL.md` is generated by the build with this machine's absolute path already in it.

- **Skills-capable harness:** copy `dist\SKILL.md` into its skills folder, for example
  `.pi\skills\browser\SKILL.md` or `~/.pi/agent/skills/browser/SKILL.md`.
- **Others:** paste the contents of `dist\SKILL.md` into the project's `AGENTS.md`.

The agent then calls tools through its shell:

```powershell
node D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs call read
node D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs call act a=click ref=e12
node D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs call act a=fill 'fields={"e3":"ann@x.io","e5":true}'
node D:/.Net/Projects/BrowserBridgeExt/dist/bridge.cjs call shot          # prints: image C:\...\browserbridge-shot-<n>.jpg 1024x620
```

Arguments are `key=value` pairs. Values that parse as JSON become numbers, booleans, arrays or objects;
anything else stays text. A single JSON object also works: `call act '{"a":"click","ref":"e12"}'`.

---

## 5. Using the WebSocket transport instead of native messaging

Use this if you cannot write registry keys, or if native messaging is blocked by policy.

1. Get the token:

   ```powershell
   node dist/bridge.cjs token
   ```

2. Click the extension icon → **Connection**:
   - Transport: **WebSocket**, or **Auto** (tries native first)
   - Port: `47821`
   - Token: paste the value
   - Click **Save**.
3. Start your agent, or keep a bridge running:

   ```powershell
   node dist/bridge.cjs
   ```

   With WebSocket only, a hub exists only while a bridge process is running. The extension reconnects
   automatically, with backoff of up to 10 seconds.

---

## 6. Everyday use

| Task | How |
|---|---|
| Stop the agent immediately | Extension popup → **Pause agent** |
| Allow every site | Popup → Site access → Mode: *Allow all sites* |
| Block a site | Popup → Site access → Blocked → enter domain → **Block** |
| Revoke an allowed site | Popup → Site access → Allowed → **×** |
| Watch what the agent does | Popup → Activity, or **Open side panel** |
| Hide the "debugging this browser" bar (Chrome/Edge) | Popup → Connection → untick *Use debugger API* |

When *Use debugger API* is off, clicks and key presses are simulated rather than real input events.
Full-page screenshots are also unavailable on Chrome and Edge.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Popup: red dot, *Specified native messaging host not found* | `install` was not run, or ran before the build. Run `node dist/bridge.cjs install`, then click **Reconnect**. |
| Popup: *Access to the specified native messaging host is forbidden* | The extension id is not allowed. Compare the id on the extensions page with `dist\ext-id.json`, then run `install --chrome-id <id>`. |
| Popup: *native host exited* | Node is not at the path stored in `%USERPROFILE%\.browserbridge\browserbridge-host.bat` (for example after a Node upgrade). Re-run `install`. |
| Agent: *No browser connected* | The browser is closed, the extension is disabled, or the dot is red. Run `node dist/bridge.cjs status` to check. |
| Agent: *Bridge hub not reachable* | Another program is using port 47821. Set `BROWSERBRIDGE_PORT` for the agent, and set the same port in the extension panel. |
| Bridge stderr: *hub rejected connection (HTTP 401)* | Token mismatch. The token in the panel must equal `node dist/bridge.cjs token`. |
| *User denied access to <site>* | You clicked Deny, or the approval popup timed out after 2 minutes. Retry, or add the site under Allowed. |
| *Browser page chrome:// cannot be controlled* | The selected tab is an internal page. Call `nav` to a website first. |
| *ref e12 not found* | The page changed. Call `read` again to get fresh refs. |
| Firefox: nothing works on websites | Site access was not granted. Popup → **Grant site access**. |
| Firefox: `js` fails with *Page CSP blocks eval* | That site's security policy forbids `eval`. Use `read` / `act` instead. |

**Manual native host test.** This should print nothing and keep waiting; press Ctrl+C to quit. An error here means the launcher path is wrong.

```powershell
& "$env:USERPROFILE\.browserbridge\browserbridge-host.bat"
```

**Check the registry entry:**

```powershell
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserbridge.ext"
reg query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.browserbridge.ext"
reg query "HKCU\Software\Mozilla\NativeMessagingHosts\com.browserbridge.ext"
```

---

## 8. Updating and uninstalling

**After code changes:**

```powershell
npm run build
```

Then click the reload icon on the extension card (`chrome://extensions`, `edge://extensions`), or
**Reload** in Firefox's `about:debugging`. Restart your agent so it picks up the new server.

**Uninstall:**

```powershell
node dist/bridge.cjs uninstall                  # removes registry keys, manifests and launcher
Remove-Item -Recurse "$env:USERPROFILE\.browserbridge"    # optional: removes the token too
```

Then remove the extension from each browser and delete the MCP entry from your agent's config.

---

## 9. Command reference

```
node dist/bridge.cjs                           MCP server on stdio (default)
node dist/bridge.cjs serve                     headless hub (for startup tasks)
node dist/bridge.cjs call <tool> [k=v ...]     one tool call, prints the result
node dist/bridge.cjs get-chromium              download Chrome for Testing
node dist/bridge.cjs headless [--browser testing|chromium|chrome|edge] [--profile DIR] [--setup]
node dist/bridge.cjs tools                     compact tool reference
node dist/bridge.cjs status                    hub pid, connected browsers and agents
node dist/bridge.cjs install [--chrome-id ID] [--edge-id ID]
node dist/bridge.cjs uninstall
node dist/bridge.cjs token                     print the WebSocket token

npm run build                                  build server + all three extensions
npm run check                                  type-check all TypeScript
npm run setup                                  build + install in one step
```
