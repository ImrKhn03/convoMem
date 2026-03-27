'use strict';

const CAPTURE_DEBOUNCE_MS = 8000;
const PREFETCH_DEBOUNCE_MS = 1500;
const PREFETCH_MIN_CHARS = 20;
const MAX_MESSAGES = 10;
const MAX_ASSISTANT_CHARS = 500;
const LOOKUP_RESULT_TTL = 60000;
const OBSERVER_THROTTLE_MS = 500;

// ChatGPT uses a ProseMirror contenteditable div, not a textarea
const INPUT_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror, div[contenteditable="true"][data-testid*="prompt"]';
const SUBMIT_SELECTOR = 'button[data-testid="send-button"], button[data-testid*="send"], button[aria-label*="Send" i], button[aria-label*="submit" i]';

const THUMBS_UP_SELECTORS = [
  'button[data-testid="thumbs-up-button"]',
  'button[aria-label*="thumbs up" i]',
  'button[aria-label*="good response" i]',
  'button[data-testid*="good"]',
].join(', ');

const THUMBS_DOWN_SELECTORS = [
  'button[data-testid="thumbs-down-button"]',
  'button[aria-label*="thumbs down" i]',
  'button[aria-label*="bad response" i]',
  'button[data-testid*="bad"]',
].join(', ');

let captureTimer = null;
let prefetchTimer = null;
let observerThrottleTimer = null;
let recoveryTimer = null;
let observer = null;
let lastMessageCount = 0;
let submitInterceptionReady = false;
let pendingFeedback = null;
let lastLookupResult = null; // { result, ts }
let lastInjectionTime = 0;

// ── Extension context handling ────────────────────────────────────────────────

function teardown() {
  if (observer) observer.disconnect();
  if (captureTimer) clearTimeout(captureTimer);
  if (prefetchTimer) clearTimeout(prefetchTimer);
  if (observerThrottleTimer) clearTimeout(observerThrottleTimer);
  console.warn('[ConvoMem] Extension context invalidated — attempting auto-recovery...');
  scheduleRecovery();
}

function scheduleRecovery() {
  if (recoveryTimer) return;
  console.warn('[ConvoMem] Starting recovery polling every 2s...');
  recoveryTimer = setInterval(() => {
    try {
      if (chrome.runtime?.id) {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
        lastLookupResult = null;
        lastInjectionTime = 0;
        observer.observe(document.body, { childList: true, subtree: true });
        console.warn('[ConvoMem] Extension context restored — observer reconnected.');
      }
    } catch (e) {
      console.warn('[ConvoMem] Recovery poll error:', e.message);
    }
  }, 2000);
}

function safeSend(msg, callback) {
  try {
    if (!chrome.runtime?.id) {
      console.warn('[ConvoMem] safeSend: no runtime id, triggering teardown');
      teardown();
      return;
    }
    chrome.runtime.sendMessage(msg, (response) => {
      try {
        const err = chrome.runtime.lastError;
        if (err) { console.warn('[ConvoMem] safeSend lastError:', err.message); return; }
        if (callback) callback(response);
      } catch (e) {
        if (e.message?.includes('Extension context invalidated')) teardown();
      }
    });
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) teardown();
  }
}

function getInputElement() {
  const el = document.querySelector(INPUT_SELECTOR);
  if (!el) console.warn('[ConvoMem] getInputElement: no input found');
  return el;
}

// Strip [CONVOMEM CONTEXT]...[END CONTEXT] so we never capture or prefetch it
function stripInjectedContext(text) {
  const end = '[END CONTEXT]';
  const idx = text.indexOf(end);
  return idx !== -1 ? text.slice(idx + end.length).trimStart() : text;
}

// ── Capture ───────────────────────────────────────────────────────────────────

function getMessages() {
  const nodes = document.querySelectorAll('[data-message-author-role]');
  return Array.from(nodes)
    .map((el) => {
      const role = el.getAttribute('data-message-author-role');
      let content = el.innerText.trim();
      if (role === 'user') content = stripInjectedContext(content);
      if (role === 'assistant' && content.length > MAX_ASSISTANT_CHARS) {
        content = content.slice(0, MAX_ASSISTANT_CHARS) + '…';
      }
      return { role, content };
    })
    .filter((m) => m.content.length > 0 && ['user', 'assistant'].includes(m.role));
}

function scheduleCapture() {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    const messages = getMessages();
    if (messages.length < lastMessageCount + 2) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const toSend = messages.slice(lastMessageCount, lastMessageCount + MAX_MESSAGES);
    lastMessageCount = messages.length;
    console.log(`[ConvoMem] Capturing ${toSend.length} messages`);
    safeSend({ type: 'CAPTURE', payload: { messages: toSend, platform: 'chatgpt' } }, (response) => {
      if (response?.error) console.warn('[ConvoMem] Capture error:', response.error);
      else console.log('[ConvoMem] Capture response:', response);
    });
  }, CAPTURE_DEBOUNCE_MS);
}

// ── Prefetch ──────────────────────────────────────────────────────────────────

function schedulePrefetch(inputEl) {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const raw = (inputEl.innerText || '').trim();
    const text = stripInjectedContext(raw).trim();
    if (!text || text.length < PREFETCH_MIN_CHARS) return;
    console.log('[ConvoMem] Prefetching lookup for topic:', text.slice(0, 80));
    safeSend({ type: 'LOOKUP', payload: { topic: text.slice(0, 200) } }, (response) => {
      if (!response || response.error) {
        console.warn('[ConvoMem] Lookup failed:', response?.error || 'no response');
        return;
      }
      lastLookupResult = { result: response, ts: Date.now() };
      console.log('[ConvoMem] Lookup cached —', response.memories?.length || 0, 'memories | will inject:', !!response.context);
    });
  }, PREFETCH_DEBOUNCE_MS);
}

// ── Inject ────────────────────────────────────────────────────────────────────

function injectContext(inputEl, context) {
  const current = inputEl.innerText || '';
  const newText = `${context}\n\n${current}`;
  console.log('[ConvoMem] injectContext: current length:', current.length, '| context length:', context.length);
  inputEl.focus();

  // Attempt 1: execCommand — most reliable path for ProseMirror.
  // Use built-in selectAll (more reliable than Range API with shadow DOM layers).
  document.execCommand('selectAll', false, null);
  const didInsert = document.execCommand('insertText', false, newText);
  if (didInsert) {
    console.log('[ConvoMem] injectContext: ✓ execCommand succeeded');
    return;
  }
  console.log('[ConvoMem] injectContext: ✗ execCommand returned false — trying paste simulation');

  // Attempt 2: ClipboardEvent paste simulation.
  // ProseMirror handles paste events and updates its own state, so this is the
  // safest DOM-agnostic fallback.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(inputEl);
  sel.removeAllRanges();
  sel.addRange(range);
  const dt = new DataTransfer();
  dt.setData('text/plain', newText);
  dt.setData('text/html', `<p>${newText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`);
  inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));

  // Verify asynchronously (ProseMirror reconciles on next microtask/tick).
  // Attempt 3 (direct DOM) only runs if paste also failed.
  setTimeout(() => {
    const afterPaste = inputEl.innerText || '';
    if (afterPaste.includes(context.slice(0, 30))) {
      console.log('[ConvoMem] injectContext: ✓ paste simulation succeeded');
      return;
    }
    console.warn('[ConvoMem] injectContext: ✗ paste simulation failed — falling back to direct DOM');

    // Attempt 3: direct DOM manipulation — last resort.
    // ProseMirror may reconcile and revert this, but combined with the 80ms send
    // delay it often survives long enough to be submitted.
    while (inputEl.firstChild) inputEl.removeChild(inputEl.firstChild);
    newText.split('\n').forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line || '\u00a0';
      inputEl.appendChild(p);
    });
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    console.log('[ConvoMem] injectContext: direct DOM done — editor starts with:', inputEl.innerText.slice(0, 60));
  }, 0);
}

function injectFromResult(inputEl, result) {
  if (!result.context) {
    console.warn('[ConvoMem] injectFromResult: no context to inject (value:', JSON.stringify(result.context), ')');
    return false;
  }
  console.log('[ConvoMem] injectFromResult: injecting', result.memories?.length || 0, 'memories, context length:', result.context.length);
  lastInjectionTime = Date.now();
  injectContext(inputEl, result.context);
  if (result.memories?.length > 0) {
    pendingFeedback = {
      memoryIds: result.memories.map((m) => m.id).filter(Boolean),
      topic: stripInjectedContext(inputEl.innerText || '').slice(0, 200),
      lookupId: result.lookupId || null,
    };
  }
  return true;
}

// ── Submit interception ───────────────────────────────────────────────────────

function setupSubmitInterception() {
  if (submitInterceptionReady) return;
  submitInterceptionReady = true;
  console.log('[ConvoMem] setupSubmitInterception: attaching listeners');

  // Prefetch as user types — skip for 1s after injection (DOM injection fires its own input event)
  document.addEventListener('input', (e) => {
    if (Date.now() - lastInjectionTime < 1000) return;
    const inputEl = e.target.closest(INPUT_SELECTOR) || getInputElement();
    if (inputEl) schedulePrefetch(inputEl);
  }, { capture: true });

  // Enter key — window-level capture fires before ChatGPT's own handlers
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const inputEl = getInputElement();
    if (!inputEl) return;
    const active = document.activeElement;
    if (!active || (!inputEl.contains(active) && active !== inputEl)) return;
    if (!lastLookupResult) return;
    const age = Date.now() - lastLookupResult.ts;
    if (age > LOOKUP_RESULT_TTL) {
      console.log('[ConvoMem] keydown: lookup result expired, submitting normally');
      return;
    }
    if (!lastLookupResult.result?.context) {
      console.log('[ConvoMem] keydown: lookup has no context, submitting normally');
      return;
    }

    console.log('[ConvoMem] keydown: intercepting Enter — injecting context then re-submitting');
    e.preventDefault();
    e.stopImmediatePropagation();

    const result = lastLookupResult.result;
    lastLookupResult = null;
    injectFromResult(inputEl, result);

    setTimeout(() => {
      const btn = document.querySelector(SUBMIT_SELECTOR);
      if (btn) btn.click();
      else console.warn('[ConvoMem] keydown: send button not found after 80ms');
    }, 80);
  }, { capture: true });

  // Send button — preventDefault on pointerdown cancels the natural click event
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest(SUBMIT_SELECTOR);
    if (!btn) return;
    const inputEl = getInputElement();
    if (!inputEl || !lastLookupResult) return;
    const age = Date.now() - lastLookupResult.ts;
    if (age > LOOKUP_RESULT_TTL) {
      console.log('[ConvoMem] pointerdown: lookup expired, submitting normally');
      return;
    }
    if (!lastLookupResult.result?.context) {
      console.log('[ConvoMem] pointerdown: no context, submitting normally');
      return;
    }

    console.log('[ConvoMem] pointerdown: intercepting send button — injecting context then re-clicking');
    e.preventDefault();
    e.stopImmediatePropagation();

    const result = lastLookupResult.result;
    lastLookupResult = null;
    injectFromResult(inputEl, result);

    setTimeout(() => btn.click(), 80);
  }, { capture: true });
}

// ── Feedback interception ─────────────────────────────────────────────────────

function setupProviderFeedbackInterception() {
  document.addEventListener('click', (e) => {
    if (!pendingFeedback) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    let wasHelpful = null;
    if (btn.matches(THUMBS_UP_SELECTORS)) wasHelpful = true;
    else if (btn.matches(THUMBS_DOWN_SELECTORS)) wasHelpful = false;
    else return;
    console.log('[ConvoMem] Feedback: wasHelpful =', wasHelpful, 'for', pendingFeedback.memoryIds.length, 'memories');
    safeSend({ type: 'FEEDBACK', payload: { ...pendingFeedback, wasHelpful } });
    pendingFeedback = null;
  }, { capture: true });
}

// ── Init ──────────────────────────────────────────────────────────────────────

observer = new MutationObserver(() => {
  if (observerThrottleTimer) return;
  observerThrottleTimer = setTimeout(() => {
    observerThrottleTimer = null;
    scheduleCapture();
  }, OBSERVER_THROTTLE_MS);
});

observer.observe(document.body, { childList: true, subtree: true });
setupSubmitInterception();
setupProviderFeedbackInterception();

// SPA navigation reset
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    console.log('[ConvoMem] SPA navigation detected:', lastUrl, '→', location.href);
    lastUrl = location.href;
    lastMessageCount = 0;
    lastLookupResult = null;
  }
}, 1000);

console.warn('[ConvoMem] ChatGPT content script loaded ✓');
