# Refraktor

Refraktor is a general-purpose Chrome extension that discovers the [WebMCP](https://github.com/webmachinelearning/webmcp)
tools a page registers and lets you drive them from a Gemini-powered chat in the side
panel. Point it at any WebMCP-enabled site; it reads whatever tools that page exposes —
nothing here is hard-coded to one site. 

Refraktor is available in the Chrome web store: [Refraktor](https://chromewebstore.google.com/detail/refraktor/nkafbaaanaamfjdljndmieichdgkhgii)

## How it works

```
page (MAIN world)        extension
  bridge.js  ──postMessage──▶ content.js ──chrome.runtime──▶ background.js ──▶ side panel
  reads modelContext           (isolated relay)                (message hub)      (chat + Gemini loop)
```

- **bridge.js** runs in the page's JS context and reads the WebMCP consumer surface.
  It feature-detects across surfaces so it's **flag-agnostic**:
  - `document.modelContext.getTools()` / `executeTool()` — production imperative API
  - `navigator.modelContextTesting.listTools()` / `executeTool()` — testing variant
    (what the Model Context Inspector uses)
  - `navigator.modelContext` — older fallback
  It **parses `inputSchema`** (the surfaces return it as a JSON string) so tool
  parameters actually reach the model. Tool results come back as
  `{ content: [{ type: "text", text }] }`.
- **content.js** is the isolated-world relay (it has `chrome.*`; the bridge doesn't).
- **background.js** is the message hub: per-tab tool cache, badge count, panel routing.
  It also **injects** `content.js` + `bridge.js` on demand — only into the tab whose
  toolbar icon you click (which grants `activeTab` for that tab). There are no static
  content scripts and no `<all_urls>` host permission by default; the extension can only
  reach a page you explicitly point it at.
- **Automatic scanning (opt-in).** The panel offers a *"Scan pages automatically"*
  control. It requests the **optional** `<all_urls>` host permission at runtime (no
  install-time warning); once granted, the SW registers dynamic content scripts on every
  page so tools appear automatically — the original always-on behaviour, now user-granted
  and revocable from the same toggle.
- **sidepanel.js** runs the autonomous loop (max 8 tool calls/turn) against Gemini:
  it keeps conversation history across messages (so follow-ups have context),
  reconciles model-invented argument keys against each tool's schema (e.g. `css`→`code`),
  executes each tool on the page, and feeds the result back.


## Try it (against sirocco.gallery)

Visit `https://sirocco.gallery/session`. The badge should show **5**. Then ask:

- "What palettes do you have?" → `list_instruments`
- "Recommend something for a dark financial dashboard" → `recommend_instrument`
- "Check this CSS: `.card { background: #1a1a1a; border-radius: 8px; }` against
  instrument 002" → `check_design_drift`

The agent chains calls on its own and summarizes the result.

## Constraints (v0.1)

- **BYO Gemini key** — the extension ships no key.
- **General-purpose** — tool names, schemas, and behavior are all discovered at
  runtime; the extension knows nothing site-specific.
- **Chrome flag required** — WebMCP is still behind a flag (see Install).
- **`activeTab` by default, not `<all_urls>`** — out of the box the extension only
  touches a page when you click its toolbar icon; it has no standing access to your
  browsing. Trade-off: a navigated page needs another click to re-scan. Flip on
  **"Scan pages automatically"** (optional `<all_urls>` grant) to get auto-scan on every
  page back.

## Verified

Across two independent providers in Chrome:

- **sirocco.gallery** (5 read-only tools): discovery; no-arg, single-arg, and multi-arg
  calls (`check_design_drift` → named color/radius drift); multi-turn memory.
- **A consultation-booking demo** (second provider): discovery; a read tool
  (`getAvailability`, two typed date args); two **state-mutating action tools**
  (`bookSlot` with four args → confirmation, then `cancelBooking`) — with the model
  carrying a `confirmationId` from one tool's result into the next, and parsing a
  name/email from conversational input.

Confirms the schema/arg-key fixes, non-standard (bare-object) result handling, and
cross-tool memory generalize beyond sirocco.


