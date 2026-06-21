// sidepanel.js — chat UI + the Gemini autonomous agent loop.
// Executes tools via the content-script bridge (panel → SW → content → bridge → page).

import { callGemini, webmcpToolToGemini, reconcileArgs } from './gemini.js';

const MAX_LOOPS = 8;
const TOOL_TIMEOUT_MS = 20000;
// 2.5 Pro fills multi-argument / special-character tool calls (e.g. CSS strings)
// far more reliably than Flash; Flash is the fast option. Switchable in the panel.
const DEFAULT_MODEL = 'gemini-2.5-pro';

const els = {
  status: document.getElementById('status'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty-state'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  apikey: document.getElementById('apikey'),
  model: document.getElementById('model'),
  copy: document.getElementById('copy'),
  refresh: document.getElementById('refresh'),
};

const state = {
  tabId: null,
  host: '',
  tools: [],
  apiKey: '',
  model: DEFAULT_MODEL,
  busy: false,
  // Rolling Gemini turn history, persisted across messages so follow-ups keep
  // context. Reset when the active page changes (its tools no longer apply).
  conversation: [],
  // Human-readable transcript (you / calls+args / results / agent) for the copy button.
  trace: [],
};

// ── boot ──────────────────────────────────────────────────────────────────
init();

async function init() {
  const stored = await chrome.storage.local.get(['geminiApiKey', 'geminiModel']);
  if (stored.geminiApiKey) {
    state.apiKey = stored.geminiApiKey;
    els.apikey.value = stored.geminiApiKey;
    els.apikey.classList.add('saved');
  }
  if (stored.geminiModel) state.model = stored.geminiModel;
  els.model.value = state.model;

  await syncActiveTab();
  wireEvents();
  renderStatus();
}

async function syncActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (state.tabId !== null && state.tabId !== tab.id) {
    // Moved to a different page — its tools and context no longer apply, so drop
    // the model's memory to avoid it referencing tools that aren't here anymore.
    state.conversation = [];
  }
  state.tabId = tab.id;
  try {
    state.host = tab.url ? new URL(tab.url).host : '';
  } catch {
    state.host = '';
  }
  // Pull whatever the SW already cached, then ask for a fresh scan.
  const cached = await chrome.runtime.sendMessage({ type: 'REQUEST_TOOLS', tabId: tab.id }).catch(() => null);
  state.tools = (cached && cached.tools) || [];
  renderStatus();
  chrome.runtime.sendMessage({ type: 'REFRESH_TOOLS', tabId: tab.id }).catch(() => {});
}

function wireEvents() {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    onSend();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.input.addEventListener('input', autosize);

  els.apikey.addEventListener('change', async () => {
    state.apiKey = els.apikey.value.trim();
    await chrome.storage.local.set({ geminiApiKey: state.apiKey });
    els.apikey.classList.toggle('saved', !!state.apiKey);
  });

  els.model.addEventListener('change', async () => {
    state.model = els.model.value;
    await chrome.storage.local.set({ geminiModel: state.model });
  });

  els.refresh.addEventListener('click', () => {
    if (state.tabId != null) chrome.runtime.sendMessage({ type: 'REFRESH_TOOLS', tabId: state.tabId }).catch(() => {});
    els.statusText.textContent = 'Re-scanning…';
  });

  els.copy.addEventListener('click', async () => {
    const text = state.trace.length ? state.trace.join('\n') : '(nothing yet)';
    try {
      await navigator.clipboard.writeText(text);
      const prev = els.copy.textContent;
      els.copy.textContent = '✓';
      setTimeout(() => { els.copy.textContent = prev; }, 1200);
    } catch {
      els.copy.textContent = '✗';
    }
  });

  // Follow the active tab so the panel always reflects the page in front of you.
  chrome.tabs.onActivated.addListener(syncActiveTab);
  chrome.windows.onFocusChanged.addListener((wid) => {
    if (wid !== chrome.windows.WINDOW_ID_NONE) syncActiveTab();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'sidepanel') return;
    if (message.type === 'TOOLS_UPDATED' && message.tabId === state.tabId) {
      state.tools = message.tools || [];
      renderStatus();
    } else if (message.type === 'DISCOVERY_ERROR' && message.tabId === state.tabId) {
      els.statusText.textContent = 'Discovery error';
    }
    // TOOL_RESULT is handled by per-request listeners in executeToolOnPage().
  });
}

// ── status ────────────────────────────────────────────────────────────────
function renderStatus() {
  const n = state.tools.length;
  const where = state.host ? ` · ${state.host}` : '';
  if (n > 0) {
    els.statusDot.className = 'dot live';
    els.statusText.textContent = `${n} tool${n === 1 ? '' : 's'}${where}`;
  } else {
    els.statusDot.className = 'dot none';
    els.statusText.textContent = `No tools${where}`;
  }
}

// ── send / agent loop ───────────────────────────────────────────────────────
async function onSend() {
  if (state.busy) return;
  const text = els.input.value.trim();
  if (!text) return;

  if (!state.apiKey) {
    appendError('Enter your Gemini API key below to start.');
    els.apikey.focus();
    return;
  }

  els.input.value = '';
  autosize();
  appendMessage('user', text);
  state.trace.push('YOU: ' + text);

  if (state.tools.length === 0) {
    appendError('No WebMCP tools found on this page. Try ↻ to re-scan, or open a page that exposes tools.');
    return;
  }

  setBusy(true);
  const thinking = appendThinking();
  try {
    const reply = await runAgentLoop(text);
    thinking.remove();
    if (reply && reply.trim()) {
      appendMessage('agent', reply);
      state.trace.push('AGENT: ' + reply);
    }
  } catch (err) {
    thinking.remove();
    const msg = err.message || String(err);
    appendError(msg);
    state.trace.push('ERROR: ' + msg);
  } finally {
    setBusy(false);
  }
}

function buildSystemInstruction() {
  const where = state.host ? ` on ${state.host}` : '';
  const list = state.tools.map((t) => `- ${t.name}: ${t.description || ''}`).join('\n');
  return (
    `You are a WebMCP page agent${where}. The page exposes these tools:\n${list}\n\n` +
    `Use them to help the user, chaining calls when it helps. Always pull the concrete ` +
    `values out of the user's message — CSS code, instrument ids, free text — and pass them ` +
    `as the matching tool arguments. Use the exact argument names defined by each tool's input ` +
    `schema — copy the property keys verbatim; never rename, abbreviate, or invent a key. ` +
    `Never call a tool with an empty or missing required field. ` +
    `If a tool returns an error about missing or empty input, call it again with the arguments ` +
    `correctly filled in rather than giving up. After the tools run, give a concise, helpful ` +
    `summary. Do not invent tool results.`
  );
}

async function runAgentLoop(userMessage) {
  const geminiFunctions = state.tools.map(webmcpToolToGemini);
  const systemInstruction = buildSystemInstruction();

  // Append to the persisted history so the model sees prior turns (and its own
  // earlier tool calls / errors) and can self-correct on follow-ups.
  state.conversation.push({ role: 'user', parts: [{ text: userMessage }] });

  let loops = 0;
  while (loops < MAX_LOOPS) {
    const response = await callGemini(state.apiKey, state.conversation, geminiFunctions, state.model, systemInstruction);
    const candidate = response.candidates && response.candidates[0];
    if (!candidate) throw new Error('Gemini returned no candidates.');

    const parts = (candidate.content && candidate.content.parts) || [];
    state.conversation.push({ role: 'model', parts });

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (calls.length === 0) {
      return parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
    }

    loops += 1;
    const responseParts = [];
    for (const fc of calls) {
      const rawArgs = fc.args || {};
      // Fix sensible-but-wrong arg keys (e.g. css→code) against the tool's schema.
      const tool = state.tools.find((t) => t.name === fc.name);
      const callArgs = reconcileArgs(rawArgs, tool && tool.inputSchema);
      if (JSON.stringify(callArgs) !== JSON.stringify(rawArgs)) {
        console.info('[webmcp] reconciled ' + fc.name + ': ' + JSON.stringify(rawArgs) + ' -> ' + JSON.stringify(callArgs));
        state.trace.push('RECONCILED ' + fc.name + ': ' + JSON.stringify(rawArgs) + ' -> ' + JSON.stringify(callArgs));
      }
      // Ground-truth logging — open the panel's DevTools Console, or use the
      // Copy-transcript button, to see exactly what the model sent.
      console.info('[webmcp] call ' + fc.name + ' args: ' + JSON.stringify(callArgs));
      state.trace.push('CALL ' + fc.name + ' args=' + JSON.stringify(callArgs));
      appendToolCall(fc.name, callArgs);
      let resultText;
      let isErr = false;
      try {
        const result = await executeToolOnPage(fc.name, callArgs);
        if (result === NAVIGATION || result === null || result === undefined) {
          // executeTool returns null on navigation, and a page teardown mid-call
          // resolves to the NAVIGATION sentinel — report it instead of timing out.
          resultText = 'The tool triggered a page navigation; no value was returned. The page (and its tools) may have changed.';
        } else {
          resultText = textFromResult(result);
          isErr = resultIsError(result);
        }
      } catch (err) {
        resultText = `Error: ${err.message || String(err)}`;
        isErr = true;
      }
      console.info('[webmcp] result ' + fc.name + ' ' + (isErr ? 'ERROR' : 'ok') + ': ' + resultText);
      state.trace.push('RESULT ' + fc.name + ' ' + (isErr ? 'ERROR' : 'ok') + ': ' + resultText);
      appendToolResult(resultText, isErr);
      responseParts.push({ functionResponse: { name: fc.name, response: { result: resultText } } });
    }
    // Function results go back under role "user" (the consistently-supported
    // REST shape for Gemini function responses).
    state.conversation.push({ role: 'user', parts: responseParts });
  }

  return 'Reached the tool-call limit for one turn. Ask me to continue if you need more.';
}

// Sentinel for "the page navigated away mid-call" — a common outcome for
// side-effecting WebMCP tools (submit, navigate, etc.), distinct from a real error.
const NAVIGATION = Symbol('navigation');

// Execute one tool on the page, round-tripping through the SW + content bridge.
function executeToolOnPage(toolName, args) {
  return new Promise((resolve, reject) => {
    if (state.tabId == null) return reject(new Error('No active tab.'));
    const requestId = crypto.randomUUID();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onResult);
      chrome.tabs.onUpdated.removeListener(onNav);
    };
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    const timeout = setTimeout(() => finish(reject, new Error('Tool execution timed out.')), TOOL_TIMEOUT_MS);

    const onResult = (message) => {
      if (message && message.target === 'sidepanel' && message.type === 'TOOL_RESULT' && message.requestId === requestId) {
        if (message.error) finish(reject, new Error(message.error));
        else finish(resolve, message.result); // result may be null (navigation)
      }
    };
    // If the target tab starts navigating while the call is in flight, the content
    // script is being torn down and no result will arrive — resolve as navigation
    // rather than hanging until the timeout.
    const onNav = (tabId, info) => {
      if (tabId === state.tabId && info.status === 'loading') finish(resolve, NAVIGATION);
    };

    chrome.runtime.onMessage.addListener(onResult);
    chrome.tabs.onUpdated.addListener(onNav);

    chrome.runtime.sendMessage({
      type: 'EXECUTE_TOOL_REQUEST',
      tabId: state.tabId,
      requestId,
      toolName,
      args,
    });
  });
}

// ── rendering helpers ────────────────────────────────────────────────────────
function hideEmpty() {
  if (els.empty) els.empty.style.display = 'none';
}
function scroll() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function appendMessage(who, text) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = `msg ${who}`;
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'user' ? 'You' : 'Agent';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.append(label, bubble);
  els.messages.appendChild(wrap);
  scroll();
  return wrap;
}

function appendError(text) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg error';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  scroll();
}

function appendThinking() {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'thinking';
  el.textContent = 'thinking';
  els.messages.appendChild(el);
  scroll();
  return el;
}

function appendToolCall(name, args) {
  hideEmpty();
  const card = document.createElement('div');
  card.className = 'tool';
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span class="label">call</span><span class="name"></span>`;
  head.querySelector('.name').textContent = name;
  const pre = document.createElement('pre');
  const hasArgs = args && Object.keys(args).length > 0;
  pre.textContent = hasArgs ? JSON.stringify(args, null, 2) : '(no arguments)';
  if (!hasArgs) pre.classList.add('muted');
  card.append(head, pre);
  els.messages.appendChild(card);
  scroll();
}

function appendToolResult(text, isErr) {
  const card = document.createElement('div');
  card.className = `tool ${isErr ? 'err' : ''}`;
  const label = document.createElement('div');
  label.className = 'result-label';
  label.textContent = isErr ? 'error' : 'result';
  const pre = document.createElement('pre');
  pre.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…(truncated)' : text;
  card.append(label, pre);
  els.messages.appendChild(card);
  scroll();
}

// Render one content block to text. Handles text, image/audio, resource links,
// and anything else as JSON — so non-sirocco tools that return richer content
// still produce something sane for the model and the UI.
function blockToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'image') return `[image${c.mimeType ? ' ' + c.mimeType : ''}]`;
  if (c.type === 'audio') return `[audio${c.mimeType ? ' ' + c.mimeType : ''}]`;
  if (c.type === 'resource' || c.type === 'resource_link') {
    const r = c.resource || c;
    return `[resource${r.uri ? ' ' + r.uri : ''}]`;
  }
  return JSON.stringify(c);
}

// WebMCP/MCP tool results are usually { content: [...], isError?, structuredContent? },
// but tools may also return a bare string or object. Flatten any of these to text.
function textFromResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = [];
  if (Array.isArray(result.content)) {
    const text = result.content.map(blockToText).filter((t) => t !== '').join('\n');
    if (text) parts.push(text);
  }
  if (result.structuredContent !== undefined) {
    parts.push('structuredContent: ' + JSON.stringify(result.structuredContent));
  }
  if (parts.length === 0) return JSON.stringify(result);
  return parts.join('\n');
}

// A tool can signal failure structurally (isError) without throwing.
function resultIsError(result) {
  return !!(result && typeof result === 'object' && result.isError === true);
}

// ── misc ──────────────────────────────────────────────────────────────────
function setBusy(b) {
  state.busy = b;
  els.send.disabled = b;
  els.input.disabled = b;
}
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
}
