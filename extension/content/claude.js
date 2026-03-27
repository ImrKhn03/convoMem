'use strict';

const CAPTURE_DEBOUNCE_MS = 8000;  // Wait 8s of DOM silence before capturing
const PREFETCH_DEBOUNCE_MS = 1500;
const PREFETCH_MIN_CHARS = 20;
const MAX_MESSAGES = 10;
const MAX_ASSISTANT_CHARS = 500;
const LOOKUP_RESULT_TTL = 60000;
const OBSERVER_THROTTLE_MS = 500;

let captureTimer = null;
let prefetchTimer = null;
let observerThrottleTimer = null;
let recoveryTimer = null;
let lastMessageCount = 0;
let submitInterceptionReady = false;
let pendingFeedback = null;
let observer = null;
let userMessagePending = false;

// Single latest lookup result — no key matching, always use the most recent
let lastLookupResult = null; // { result, ts }

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
  recoveryTimer = setInterval(() => {
    try {
      if (chrome.runtime?.id) {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
        lastLookupResult = null;
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
      teardown();
      return;
    }
    chrome.runtime.sendMessage(msg, (response) => {
      try {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('[ConvoMem] safeSend lastError:', err.message);
          return;
        }
        if (callback) callback(response);
      } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) teardown();
      }
    });
  } catch (e) {
    if (e.message && e.message.includes('Extension context invalidated')) {
      teardown();
    }
  }
}

let selectors = {
  messageContainers: '[data-testid="user-message"], [data-testid="assistant-message"], .font-user-message, .font-claude-message, .human-turn, .ai-turn',
  userMessageCheck: '[data-testid="user-message"], .font-user-message, .human-turn',
  fallbackContainer: '[data-message-author-role]',
  inputSelector: '.ProseMirror[contenteditable="true"], [contenteditable="true"][data-testid*="input"], [contenteditable="true"]',
  submitButton: 'button[aria-label*="Send"], button[data-testid*="send"]',
  thumbsUp: 'button[aria-label*="thumbs up" i], button[aria-label*="good response" i], button[aria-label*="helpful" i], button[data-testid*="thumbs-up"], button[data-testid*="good"]',
  thumbsDown: 'button[aria-label*="thumbs down" i], button[aria-label*="bad response" i], button[aria-label*="not helpful" i], button[data-testid*="thumbs-down"], button[data-testid*="bad"]',
};

safeSend({ type: 'GET_SELECTORS' }, (response) => {
  if (response && response.claude) {
    selectors = { ...selectors, ...response.claude };
    console.log('[ConvoMem] Selectors loaded:', selectors);
  }
});

function stripInjectedContext(content) {
  const end = '[END CONTEXT]';
  const idx = content.indexOf(end);
  if (idx !== -1) return content.slice(idx + end.length).trimStart();
  return content;
}

function getMessages() {
  // ── Strategy 1: explicit message containers from selectors ──────────────────
  const turns = document.querySelectorAll(selectors.messageContainers);
  console.log('[ConvoMem] getMessages strategy 1: found', turns.length, 'elements via messageContainers');
  if (turns.length > 0) {
    const msgs = [];
    turns.forEach((el) => {
      const isUser =
        el.matches(selectors.userMessageCheck) ||
        el.getAttribute('data-message-author-role') === 'user';
      let content = el.innerText.trim();
      if (isUser) content = stripInjectedContext(content);
      if (!isUser && content.length > MAX_ASSISTANT_CHARS) content = content.slice(0, MAX_ASSISTANT_CHARS) + '…';
      if (content) msgs.push({ role: isUser ? 'user' : 'assistant', content });
    });
    const valid = msgs.filter((m) => m.content.length > 0);
    const hasUser = valid.some((m) => m.role === 'user');
    const hasAssistant = valid.some((m) => m.role === 'assistant');
    console.log('[ConvoMem] getMessages strategy 1 result:', valid.length, 'messages — hasUser:', hasUser, 'hasAssistant:', hasAssistant);
    // Only return if we got both sides; otherwise fall through so assistant
    // messages are not silently dropped when only one selector half matches.
    if (hasUser && hasAssistant) return valid;
    console.log('[ConvoMem] getMessages strategy 1: missing a role, trying next strategy');
  }

  // ── Strategy 2: data-message-author-role (ChatGPT-style fallback) ───────────
  const roleMsgs = document.querySelectorAll(selectors.fallbackContainer);
  console.log('[ConvoMem] getMessages strategy 2: found', roleMsgs.length, 'elements via fallbackContainer');
  if (roleMsgs.length > 0) {
    const msgs = [];
    roleMsgs.forEach((el) => {
      const role = el.getAttribute('data-message-author-role');
      let content = el.innerText.trim();
      if (role === 'user') content = stripInjectedContext(content);
      if (role === 'assistant' && content.length > MAX_ASSISTANT_CHARS) content = content.slice(0, MAX_ASSISTANT_CHARS) + '…';
      if (content && (role === 'user' || role === 'assistant')) msgs.push({ role, content });
    });
    const valid = msgs.filter((m) => m.content.length > 0);
    const hasUser = valid.some((m) => m.role === 'user');
    const hasAssistant = valid.some((m) => m.role === 'assistant');
    console.log('[ConvoMem] getMessages strategy 2 result:', valid.length, 'messages — hasUser:', hasUser, 'hasAssistant:', hasAssistant);
    if (hasUser && hasAssistant) return valid;
    console.log('[ConvoMem] getMessages strategy 2: missing a role, trying next strategy');
  }

  // ── Strategy 3: Claude.ai conversation-turn structure ───────────────────────
  // Claude.ai uses [data-testid^="conversation-turn-"] containers. Role is
  // determined by whether the turn contains a [data-testid="user-message"] child.
  const convTurns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
  console.log('[ConvoMem] getMessages strategy 3: found', convTurns.length, 'conversation-turn elements');
  if (convTurns.length > 0) {
    const msgs = [];
    convTurns.forEach((turn) => {
      const userMsgEl = turn.querySelector('[data-testid="user-message"]');
      let content, role;
      if (userMsgEl) {
        content = stripInjectedContext(userMsgEl.innerText.trim());
        role = 'user';
      } else {
        content = turn.innerText.trim();
        if (content.length > MAX_ASSISTANT_CHARS) content = content.slice(0, MAX_ASSISTANT_CHARS) + '…';
        role = 'assistant';
      }
      if (content) msgs.push({ role, content });
    });
    const valid = msgs.filter((m) => m.content.length > 0);
    console.log('[ConvoMem] getMessages strategy 3 result:', valid.length, 'messages —',
      valid.filter((m) => m.role === 'user').length, 'user,',
      valid.filter((m) => m.role === 'assistant').length, 'assistant');
    return valid;
  }

  // ── Strategy 4: DOM structural pairing ─────────────────────────────────────
  // Walks up from a known [data-testid="user-message"] until we reach the
  // conversation-level container (first ancestor with enough children to hold
  // all user messages + their assistant responses), then reads every direct
  // child as a turn — children containing [data-testid="user-message"] are
  // user turns, everything else is an assistant turn.
  const userMsgEls = document.querySelectorAll('[data-testid="user-message"]');
  console.log('[ConvoMem] getMessages strategy 4: found', userMsgEls.length, 'user-message elements');
  if (userMsgEls.length > 0) {
    // Walk up until the parent has at least as many children as we expect turns
    // (user count * 2 covers user + assistant pairs; fall back to >= 2).
    const minChildren = Math.max(userMsgEls.length * 2, 2);
    let turnEl = userMsgEls[0];
    while (turnEl.parentElement && turnEl.parentElement.children.length < minChildren) {
      turnEl = turnEl.parentElement;
    }
    const container = turnEl.parentElement;
    console.log('[ConvoMem] getMessages strategy 4: container has', container?.children.length, 'children');
    if (container) {
      const msgs = [];
      Array.from(container.children).forEach((child) => {
        const userMsgEl = child.matches('[data-testid="user-message"]')
          ? child
          : child.querySelector('[data-testid="user-message"]');
        if (userMsgEl) {
          const content = stripInjectedContext(userMsgEl.innerText.trim());
          if (content) msgs.push({ role: 'user', content });
        } else {
          let content = child.innerText.trim();
          if (!content) return;
          if (content.length > MAX_ASSISTANT_CHARS) content = content.slice(0, MAX_ASSISTANT_CHARS) + '…';
          msgs.push({ role: 'assistant', content });
        }
      });
      const valid = msgs.filter((m) => m.content.length > 0);
      const hasUser = valid.some((m) => m.role === 'user');
      const hasAssistant = valid.some((m) => m.role === 'assistant');
      console.log('[ConvoMem] getMessages strategy 4 result:', valid.length, 'messages — hasUser:', hasUser, 'hasAssistant:', hasAssistant);
      if (hasUser && hasAssistant) return valid;
      console.log('[ConvoMem] getMessages strategy 4: missing a role');
    }
  }

  console.warn('[ConvoMem] getMessages: all strategies failed — no messages found');
  return [];
}

function scheduleCapture() {
  if (!userMessagePending) return;
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    console.log('[ConvoMem] scheduleCapture: timer fired (lastMessageCount=' + lastMessageCount + ')');
    const messages = getMessages();
    if (messages.length < lastMessageCount + 2) {
      console.log('[ConvoMem] scheduleCapture: skip — need', lastMessageCount + 2, 'messages, have', messages.length);
      return;
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') {
      console.log('[ConvoMem] scheduleCapture: skip — last message role is', last?.role, '(need assistant)');
      return;
    }
    const toSend = messages.slice(lastMessageCount, lastMessageCount + MAX_MESSAGES);
    lastMessageCount = messages.length;
    userMessagePending = false;
    console.log('[ConvoMem] scheduleCapture: sending', toSend.length, 'messages to background');
    safeSend({
      type: 'CAPTURE',
      payload: { messages: toSend, platform: 'claude' },
    }, (response) => {
      if (response?.error) console.warn('[ConvoMem] Capture error:', response.error);
      else console.log('[ConvoMem] Capture response:', response);
    });
  }, CAPTURE_DEBOUNCE_MS);
}

function getInputElement() {
  return document.querySelector(selectors.inputSelector);
}

function schedulePrefetch(inputEl) {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const text = stripInjectedContext(inputEl.innerText.trim());
    if (!text || text.length < PREFETCH_MIN_CHARS) return;
    console.log('[ConvoMem] Prefetching lookup for topic:', text.slice(0, 50));
    safeSend(
      { type: 'LOOKUP', payload: { topic: text.slice(0, 200) } },
      (response) => {
        console.log('[ConvoMem] Lookup response:', response);
        lastLookupResult = { result: response, ts: Date.now() };
      }
    );
  }, PREFETCH_DEBOUNCE_MS);
}

function injectContext(inputEl, context) {
  const current = inputEl.innerText || '';
  inputEl.focus();
  // Select all then replace via execCommand — works with ProseMirror/React
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(inputEl);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, `${context}\n\n${current}`);
}

function injectFromLastResult(inputEl) {
  if (!lastLookupResult) {
    console.log('[ConvoMem] No lookup result cached yet');
    return false;
  }
  if (Date.now() - lastLookupResult.ts > LOOKUP_RESULT_TTL) {
    console.log('[ConvoMem] Lookup result expired');
    return false;
  }
  if (!lastLookupResult.result || !lastLookupResult.result.context) {
    console.log('[ConvoMem] No context to inject');
    return false;
  }

  console.log('[ConvoMem] Injecting context');
  const current = inputEl.innerText || '';
  injectContext(inputEl, lastLookupResult.result.context);

  const { memories, lookupId } = lastLookupResult.result;
  if (memories && memories.length > 0) {
    pendingFeedback = {
      memoryIds: memories.map((m) => m.id).filter(Boolean),
      topic: current.slice(0, 200),
      lookupId: lookupId || null,
    };
  }
  return true;
}

function setupSubmitInterception() {
  if (submitInterceptionReady) return;
  submitInterceptionReady = true;

  // Pre-warm on every input event — works for contenteditable
  document.addEventListener('input', (e) => {
    const inputEl = getInputElement();
    if (inputEl && (e.target === inputEl || inputEl.contains(e.target))) {
      schedulePrefetch(inputEl);
    }
  }, { capture: true });

  // Enter key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const inputEl = getInputElement();
      if (!inputEl || !inputEl.contains(document.activeElement || e.target)) return;

      // Cache warm — inject and let submit proceed
      if (injectFromLastResult(inputEl)) {
        userMessagePending = true;
        return;
      }

      // Cache cold — block submit, do quick lookup, inject, then click send
      const text = (inputEl.innerText || '').trim();
      if (!text || text.length < 3) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      let sent = false;
      const sendBtn = document.querySelector(selectors.submitButton);
      const doSend = () => { if (!sent) { sent = true; userMessagePending = true; if (sendBtn) sendBtn.click(); } };
      const timeout = setTimeout(doSend, 400);

      safeSend({ type: 'LOOKUP', payload: { topic: text.slice(0, 200) } }, (response) => {
        clearTimeout(timeout);
        if (response && !response.error) {
          lastLookupResult = { result: response, ts: Date.now() };
          injectFromLastResult(inputEl);
        }
        doSend();
      });
    }
  }, { capture: true });

  // Submit button click
  document.addEventListener('click', (e) => {
    const btn = e.target.closest(selectors.submitButton);
    if (btn) {
      const inputEl = getInputElement();
      if (inputEl) injectFromLastResult(inputEl);
      userMessagePending = true;
    }
  }, { capture: true });
}

function setupProviderFeedbackInterception() {
  document.addEventListener('click', (e) => {
    if (!pendingFeedback) return;
    const btn = e.target.closest('button');
    if (!btn) return;

    let wasHelpful = null;
    if (btn.matches(selectors.thumbsUp)) wasHelpful = true;
    else if (btn.matches(selectors.thumbsDown)) wasHelpful = false;
    else return;

    safeSend({ type: 'FEEDBACK', payload: { ...pendingFeedback, wasHelpful } });
    pendingFeedback = null;
  }, { capture: true });
}

observer = new MutationObserver(() => {
  if (observerThrottleTimer) return;
  observerThrottleTimer = setTimeout(() => {
    observerThrottleTimer = null;
    scheduleCapture();
  }, OBSERVER_THROTTLE_MS);
});

function init() {
  try {
    observer.observe(document.body, { childList: true, subtree: true });
    setupSubmitInterception();
    setupProviderFeedbackInterception();

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastMessageCount = 0;
        lastLookupResult = null;
        userMessagePending = false;
      }
    }, 1000);

    console.warn('[ConvoMem] Claude content script loaded');
  } catch (e) {
    console.error('[ConvoMem] Init error:', e);
  }
}

if (document.body) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
