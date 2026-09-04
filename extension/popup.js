const MOOD_COLORS = {
  Calm:       { bg: 'rgba(35,199,164,0.12)', text: '#84f1dd', border: 'rgba(35,199,164,0.22)' },
  Bored:      { bg: 'rgba(156,163,255,0.12)', text: '#c7cbff', border: 'rgba(156,163,255,0.2)' },
  Anxious:    { bg: 'rgba(248,184,76,0.14)', text: '#ffd795', border: 'rgba(248,184,76,0.24)' },
  Frustrated: { bg: 'rgba(255,146,87,0.14)', text: '#ffc59f', border: 'rgba(255,146,87,0.24)' },
  Angry:      { bg: 'rgba(255,107,107,0.14)', text: '#ffc3c3', border: 'rgba(255,107,107,0.24)' },
};

const eventLog = [];

function updateUI(mood, score) {
  const badge = document.getElementById('mood-badge');
  const scoreEl = document.getElementById('score-value');
  const bar = document.getElementById('score-bar');

  const cfg = MOOD_COLORS[mood] || MOOD_COLORS.Calm;
  badge.textContent = mood;
  badge.style.background = cfg.bg;
  badge.style.color = cfg.text;
  badge.style.borderColor = cfg.border;
  scoreEl.textContent = String(score);
  bar.style.width = `${Math.min(score, 100)}%`;
}

function renderEvents() {
  const list = document.getElementById('event-list');
  if (!eventLog.length) {
    list.innerHTML = '<div class="empty">No events yet</div>';
    return;
  }

  list.innerHTML = eventLog.slice(-8).reverse().map((event) => `
    <div class="event">
      <div class="dot"></div>
      <div>
        <div>${event.type}</div>
        <small>${event.time}</small>
      </div>
    </div>
  `).join('');
}

async function openFullAssistant() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const sourceTabId = tabs[0]?.id;
  await chrome.runtime.sendMessage({
    action: 'OPEN_STANDALONE_ASSISTANT',
    payload: { sourceTabId },
  });
  window.close();
}

function openPagePanel() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'OPEN_FULL_ASSISTANT_PANEL' }).catch?.(() => {});
    }
    window.close();
  });
}

function showOcrHelp() {
  chrome.tabs.create({ url: chrome.runtime.getURL('assistant.html#ocr-setup') });
  window.close();
}

chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
  if (response) updateUI(response.mood, response.score);
});

chrome.storage.local.get(['aiProvider', 'ollamaModel'], (stored) => {
  const provider = stored.aiProvider || 'ollama';
  const providerText = provider === 'gemini'
    ? 'Provider: Gemini'
    : `Provider: Ollama${stored.ollamaModel ? ` (${stored.ollamaModel})` : ''}`;
  document.getElementById('provider-pill').textContent = providerText;
});

chrome.runtime.sendMessage({ action: 'GET_OCR_STATUS' }, (result) => {
  document.getElementById('ocr-pill').textContent = result?.ok
    ? 'OCR helper: online'
    : 'OCR helper: offline';
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action !== 'STATE_UPDATE') return;
  updateUI(message.mood, message.score);

  if (message.eventType && !['DECAY', 'RESET'].includes(message.eventType)) {
    eventLog.push({
      type: message.eventType,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    });
    renderEvents();
  }
});

document.getElementById('btn-reset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'RESET_STATE' }, () => {
    updateUI('Calm', 0);
    eventLog.length = 0;
    renderEvents();
  });
});

document.getElementById('btn-fullpage').addEventListener('click', openFullAssistant);
document.getElementById('btn-open-panel').addEventListener('click', openPagePanel);
document.getElementById('btn-ocr-help').addEventListener('click', showOcrHelp);

renderEvents();
