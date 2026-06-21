// background.js — service worker: message hub, badge, side-panel control.

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Last-known serialized tool set per tab, so a freshly-opened panel can render
// immediately without waiting for a re-discovery round trip.
const tabTools = {};

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#8b6a3a' : '#666', tabId });
}

function toPanel(payload) {
  // The panel may not be open; swallow the "no receiver" rejection.
  chrome.runtime.sendMessage({ target: 'sidepanel', ...payload }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  // ── From the content script (has sender.tab) ──
  if (message.source === 'content' && sender.tab) {
    const tabId = sender.tab.id;
    if (message.type === 'TOOLS_DISCOVERED') {
      tabTools[tabId] = message.tools || [];
      setBadge(tabId, tabTools[tabId].length);
      toPanel({ type: 'TOOLS_UPDATED', tools: tabTools[tabId], tabId });
    } else if (message.type === 'NO_CONTEXT') {
      tabTools[tabId] = [];
      setBadge(tabId, 0);
      toPanel({ type: 'TOOLS_UPDATED', tools: [], tabId });
    } else if (message.type === 'ERROR') {
      toPanel({ type: 'DISCOVERY_ERROR', error: message.error, tabId });
    } else if (message.type === 'TOOL_RESULT') {
      toPanel({
        type: 'TOOL_RESULT',
        requestId: message.requestId,
        result: message.result,
        error: message.error,
      });
    }
    return;
  }

  // ── From the side panel ──
  if (message.type === 'REQUEST_TOOLS' && typeof message.tabId === 'number') {
    sendResponse({ tools: tabTools[message.tabId] || [] });
    return true; // keep the channel open for the response
  }

  if (message.type === 'REFRESH_TOOLS' && typeof message.tabId === 'number') {
    chrome.tabs.sendMessage(message.tabId, { target: 'content', type: 'DISCOVER' }).catch(() => {});
    return;
  }

  if (message.type === 'EXECUTE_TOOL_REQUEST' && typeof message.tabId === 'number') {
    chrome.tabs
      .sendMessage(message.tabId, {
        target: 'content',
        type: 'EXECUTE_TOOL',
        requestId: message.requestId,
        toolName: message.toolName,
        args: message.args,
      })
      .catch(() => {
        // No content script on this tab (e.g. chrome:// page or not yet injected).
        toPanel({
          type: 'TOOL_RESULT',
          requestId: message.requestId,
          error: 'this page has no WebMCP content script — reload the tab and try again',
        });
      });
    return;
  }
});

// A navigation invalidates the previous page's tools.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setBadge(tabId, 0);
    delete tabTools[tabId];
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabTools[tabId];
});
