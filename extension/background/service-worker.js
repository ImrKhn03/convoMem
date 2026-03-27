'use strict';

const DEFAULT_BASE_URL = 'http://localhost:8000';
const SELECTORS_TTL = 3600000; // 1 hour

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CAPTURE') {
    handleCapture(msg.payload).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'LOOKUP') {
    handleLookup(msg.payload).then(sendResponse).catch((e) => sendResponse({ error: e.message, context: '' }));
    return true;
  }
  if (msg.type === 'FEEDBACK') {
    handleFeedback(msg.payload).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'GET_CONFIG') {
    getConfig().then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_SELECTORS') {
    getSelectors().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.type === 'TEST_CONNECTION') {
    testConnection(msg.payload).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'baseUrl', 'enabled', 'captureEnabled', 'injectEnabled'], (data) => {
      resolve({
        apiKey: data.apiKey || '',
        baseUrl: data.baseUrl || DEFAULT_BASE_URL,
        enabled: data.enabled !== false,
        captureEnabled: data.captureEnabled !== false,
        injectEnabled: data.injectEnabled !== false,
      });
    });
  });
}

async function getSelectors() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['selectors', 'selectorsCachedAt', 'baseUrl'], async (data) => {
      const now = Date.now();
      const isFresh = data.selectors && data.selectorsCachedAt && (now - data.selectorsCachedAt) < SELECTORS_TTL;

      if (isFresh) return resolve(data.selectors);

      const baseUrl = data.baseUrl || DEFAULT_BASE_URL;
      try {
        const resp = await fetch(`${baseUrl}/api/extension/selectors`);
        if (!resp.ok) return resolve(data.selectors || null);
        const fresh = await resp.json();
        chrome.storage.local.set({ selectors: fresh, selectorsCachedAt: now });
        resolve(fresh);
      } catch {
        // Network error: return stale cache if available
        resolve(data.selectors || null);
      }
    });
  });
}

async function handleCapture({ messages, platform }) {
  const { apiKey, baseUrl, enabled, captureEnabled } = await getConfig();
  console.log('[ConvoMem SW] handleCapture config:', { baseUrl, enabled, captureEnabled, hasKey: !!apiKey });
  if (!enabled || !captureEnabled || !apiKey) return { skipped: true };

  const resp = await fetch(`${baseUrl}/api/memories/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ messages, platform }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function handleLookup({ topic }) {
  const { apiKey, baseUrl, enabled, injectEnabled } = await getConfig();
  console.log('[ConvoMem SW] handleLookup config:', { baseUrl, enabled, injectEnabled, hasKey: !!apiKey, topicLength: topic?.length });
  if (!enabled) { console.warn('[ConvoMem SW] handleLookup: skipped — extension disabled'); return { context: '' }; }
  if (!injectEnabled) { console.warn('[ConvoMem SW] handleLookup: skipped — inject disabled in settings'); return { context: '' }; }
  if (!apiKey) { console.warn('[ConvoMem SW] handleLookup: skipped — no API key configured'); return { context: '' }; }

  const url = new URL(`${baseUrl}/api/memories/lookup`);
  url.searchParams.set('topic', topic);
  console.log('[ConvoMem SW] handleLookup: fetching', url.toString());

  let resp;
  try {
    resp = await fetch(url.toString(), { headers: { 'X-API-Key': apiKey } });
  } catch (e) {
    console.error('[ConvoMem SW] handleLookup: network error —', e.message);
    return { context: '' };
  }

  console.log('[ConvoMem SW] handleLookup: response status', resp.status);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    console.warn('[ConvoMem SW] handleLookup: non-OK response —', body.error || `HTTP ${resp.status}`);
    return { context: '' };
  }

  const result = await resp.json();
  console.log('[ConvoMem SW] handleLookup: success —', result.memories?.length ?? 0, 'memories, context length:', result.context?.length ?? 0);
  return result;
}

async function handleFeedback({ memoryIds, wasHelpful, topic, lookupId }) {
  const { apiKey, baseUrl, enabled } = await getConfig();
  if (!enabled || !apiKey) return { skipped: true };

  const resp = await fetch(`${baseUrl}/api/memories/lookup-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ memoryIds, wasHelpful, topic, lookupId }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function testConnection({ apiKey, baseUrl }) {
  const url = new URL(`${baseUrl}/api/memories`);
  url.searchParams.set('limit', '1');
  const resp = await fetch(url.toString(), {
    headers: { 'X-API-Key': apiKey },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return { ok: true, memoryCount: data.total || 0 };
}
