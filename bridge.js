// bridge.js — MAIN WORLD
// Reads the page's WebMCP consumer surface and relays to content.js via postMessage.
// General-purpose: it discovers whatever tools the page registered. Nothing here is
// specific to any one site — tool names, schemas, and results are all dynamic.
//
// This script has the page's JS context (it can see modelContext) but NO access to
// chrome.* APIs, so it talks to the extension only through window.postMessage, which
// content.js (isolated world) forwards onward.

const MSG_PREFIX = 'webmcp-agent';

// WebMCP exposes more than one consumer surface depending on which Chrome flag is on:
//   • document.modelContext          — production imperative API: getTools()/executeTool()
//                                       (chrome://flags/#enable-experimental-web-platform-features)
//   • navigator.modelContextTesting  — testing variant: listTools()/executeTool()
//                                       (chrome://flags/#enable-webmcp-testing) — what the
//                                       Model Context Inspector uses
//   • navigator.modelContext         — older surface some builds still expose
// We feature-detect and use whichever is present, so the extension is flag-agnostic
// and doesn't break if the user enabled one flag but not the other.
function consumerContext() {
  const candidates = [
    typeof document !== 'undefined' ? document.modelContext : null,
    typeof navigator !== 'undefined' ? navigator.modelContextTesting : null,
    typeof navigator !== 'undefined' ? navigator.modelContext : null,
  ];
  for (const ctx of candidates) {
    if (ctx && (typeof ctx.getTools === 'function' || typeof ctx.listTools === 'function')) {
      return ctx;
    }
  }
  return null;
}

async function listToolsFrom(ctx) {
  if (typeof ctx.getTools === 'function') return await ctx.getTools();
  if (typeof ctx.listTools === 'function') return await ctx.listTools();
  return [];
}

// The WebMCP surfaces return inputSchema as a JSON *string* (per the Chrome docs),
// though some may hand back an object. Normalize to a parsed object so downstream
// (schema→Gemini conversion, arg reconciliation) sees real properties, not a string.
function toSchemaObject(schema) {
  if (schema && typeof schema === 'object') return schema;
  if (typeof schema === 'string') {
    try {
      const parsed = JSON.parse(schema);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// The original tool objects from discovery — executeTool() wants the object it handed
// us back, not a reconstructed one, so we keep them here keyed by lookup at call time.
let discovered = [];

function post(type, extra) {
  window.postMessage({ direction: MSG_PREFIX, type, ...extra }, '*');
}

async function discoverOnce() {
  const ctx = consumerContext();
  if (!ctx) return { ok: false, reason: 'no-context', count: 0 };
  try {
    const tools = (await listToolsFrom(ctx)) || [];
    discovered = tools;
    const serialized = tools.map((t) => ({
      name: t.name,
      description: t.description,
      // Accept either field name; parse the JSON-string schema into an object.
      inputSchema: toSchemaObject(t.inputSchema ?? t.input_schema),
    }));
    return { ok: true, tools: serialized, count: serialized.length };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || String(err), count: 0 };
  }
}

// A page can register tools asynchronously (after framework hydration / an event),
// so a single read at document_idle often races ahead of registration. Poll with
// backoff until tools appear or we exhaust attempts; always emit a final state.
let discovering = false;
async function discover() {
  if (discovering) return;
  discovering = true;
  try {
    const delays = [0, 250, 500, 1000, 1500, 2500];
    let last = { ok: false, reason: 'no-context', count: 0 };
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      last = await discoverOnce();
      if (last.ok && last.count > 0) break;
    }
    if (last.ok) post('TOOLS_DISCOVERED', { tools: last.tools });
    else if (last.reason === 'no-context') post('NO_CONTEXT', {});
    else post('ERROR', { error: last.reason });
  } finally {
    discovering = false;
  }
}

async function executeTool(requestId, toolName, args) {
  const ctx = consumerContext();
  const tool = discovered.find((t) => t.name === toolName);
  if (!ctx || !tool) {
    post('TOOL_RESULT', {
      requestId,
      error: tool ? 'no WebMCP context on this page' : `tool "${toolName}" not found`,
    });
    return;
  }
  try {
    // executeTool takes the tool object from discovery plus args as a JSON string.
    const result = await ctx.executeTool(tool, JSON.stringify(args || {}));
    post('TOOL_RESULT', { requestId, result });
  } catch (err) {
    post('TOOL_RESULT', { requestId, error: (err && err.message) || String(err) });
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.direction !== `${MSG_PREFIX}-command`) return;
  if (data.type === 'DISCOVER') discover();
  else if (data.type === 'EXECUTE_TOOL') executeTool(data.requestId, data.toolName, data.args);
});

// Re-discover when the tab becomes visible again — covers SPA route changes (e.g.
// Astro view transitions) that register a new tool set without a full page load.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') discover();
});

discover();
