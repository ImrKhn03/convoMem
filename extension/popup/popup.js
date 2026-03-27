'use strict';

const $ = (id) => document.getElementById(id);

function showStatus(msg, isError = false) {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = `status-msg ${isError ? 'error' : 'success'}`;
  setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3000);
}

// Load saved config on open
chrome.storage.local.get(['apiKey', 'baseUrl', 'enabled', 'captureEnabled', 'injectEnabled'], (data) => {
  $('apiKey').value = data.apiKey || '';
  $('baseUrl').value = data.baseUrl || 'http://localhost:8000';
  $('enabled').checked = data.enabled !== false;
  $('captureEnabled').checked = data.captureEnabled !== false;
  $('injectEnabled').checked = data.injectEnabled !== false;
});

$('save').addEventListener('click', () => {
  const apiKey = $('apiKey').value.trim();
  const baseUrl = $('baseUrl').value.trim() || 'http://localhost:8000';
  const enabled = $('enabled').checked;
  const captureEnabled = $('captureEnabled').checked;
  const injectEnabled = $('injectEnabled').checked;

  chrome.storage.local.set({ apiKey, baseUrl, enabled, captureEnabled, injectEnabled }, () => {
    showStatus('Settings saved');
  });
});

$('testConn').addEventListener('click', () => {
  const apiKey = $('apiKey').value.trim();
  const baseUrl = $('baseUrl').value.trim() || 'http://localhost:8000';

  if (!apiKey) {
    showStatus('Enter an API key first', true);
    return;
  }

  $('testConn').disabled = true;
  $('testConn').textContent = 'Testing...';

  chrome.runtime.sendMessage(
    { type: 'TEST_CONNECTION', payload: { apiKey, baseUrl } },
    (response) => {
      $('testConn').disabled = false;
      $('testConn').textContent = 'Test Connection';

      const dot = $('statusDot');
      if (response?.ok) {
        showStatus(`Connected — ${response.memoryCount} memories stored`);
        dot.className = 'status-dot connected';
        $('memoryCount').textContent = `${response.memoryCount} memories`;
      } else {
        showStatus(response?.error || 'Connection failed', true);
        dot.className = 'status-dot disconnected';
      }
    }
  );
});
