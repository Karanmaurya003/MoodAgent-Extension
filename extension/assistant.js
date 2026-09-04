const messageList = document.getElementById('message-list');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const attachImageButton = document.getElementById('attach-image');
const imageInput = document.getElementById('image-input');
const attachmentBar = document.getElementById('attachment-bar');
const attachmentName = document.getElementById('attachment-name');
const removeImageButton = document.getElementById('remove-image');
const micButton = document.getElementById('mic-button');
const voiceToggleButton = document.getElementById('voice-toggle');
const speakToggle = document.getElementById('speak-toggle');
const providerStatus = document.getElementById('provider-status');
const ocrStatus = document.getElementById('ocr-status');
const refreshOcrButton = document.getElementById('refresh-ocr');
const clearChatButton = document.getElementById('clear-chat');
const openPopupButton = document.getElementById('open-popup');
const pageParams = new URLSearchParams(window.location.search);
const sourceTabId = Number(pageParams.get('sourceTabId')) || null;

let pendingImageDataUrl = '';
let pendingImageName = '';
let conversation = [];
let recognition = null;
let recognitionActive = false;

function renderEmptyState() {
  if (messageList.children.length) return;
  const empty = document.createElement('div');
  empty.className = 'empty-chat';
  empty.innerHTML = `
    <h3>Start a richer assistant session</h3>
    <p>Ask general questions, upload an image for OCR-assisted explanation, or use voice input and spoken replies.</p>
  `;
  messageList.appendChild(empty);
}

function clearEmptyState() {
  const empty = messageList.querySelector('.empty-chat');
  if (empty) empty.remove();
}

function addMessage(role, text) {
  clearEmptyState();
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.textContent = text;
  messageList.appendChild(el);
  messageList.scrollTop = messageList.scrollHeight;
  return el;
}

function updateAttachmentUi() {
  attachmentBar.hidden = !pendingImageDataUrl;
  if (pendingImageDataUrl) {
    attachmentName.textContent = pendingImageName || 'Image ready for OCR';
  }
}

function resizeComposer() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 220)}px`;
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  chatInput.disabled = isBusy;
  attachImageButton.disabled = isBusy;
  micButton.disabled = isBusy;
}

function speakText(text) {
  if (!speakToggle.checked || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function setRecognitionState(active) {
  recognitionActive = active;
  const label = active ? 'Stop' : 'Start';
  voiceToggleButton.textContent = label;
  micButton.textContent = active ? 'Listening…' : 'Mic';
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceToggleButton.disabled = true;
    micButton.disabled = true;
    addMessage('system', 'Voice input is not supported in this Chrome environment.');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => setRecognitionState(true);
  recognition.onend = () => setRecognitionState(false);
  recognition.onerror = () => setRecognitionState(false);
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || '')
      .join(' ')
      .trim();
    if (transcript) {
      chatInput.value = transcript;
      resizeComposer();
    }
  };
}

function toggleRecognition() {
  if (!recognition) return;
  if (recognitionActive) {
    recognition.stop();
  } else {
    recognition.start();
  }
}

async function refreshOcrStatus() {
  ocrStatus.textContent = 'Checking…';
  const result = await chrome.runtime.sendMessage({ action: 'GET_OCR_STATUS' });
  if (result?.ok) {
    ocrStatus.textContent = result.tesseract ? 'Online' : 'Online (Tesseract missing)';
    ocrStatus.style.color = result.tesseract ? '#a6f5e6' : '#ffd795';
  } else {
    ocrStatus.textContent = 'Offline';
    ocrStatus.style.color = '#ffc3c3';
  }
}

async function loadProviderStatus() {
  const stored = await chrome.storage.local.get(['aiProvider', 'ollamaModel']);
  const provider = stored.aiProvider || 'ollama';
  providerStatus.textContent = provider === 'gemini'
    ? 'Gemini'
    : `Ollama${stored.ollamaModel ? ` (${stored.ollamaModel})` : ''}`;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !pendingImageDataUrl) return;

  const outgoingText = text || 'Explain the uploaded image.';
  addMessage('user', pendingImageDataUrl ? `${outgoingText}\n\n[Image attached for OCR]` : outgoingText);
  conversation.push({ role: 'user', content: outgoingText });

  const imageDataUrl = pendingImageDataUrl;
  pendingImageDataUrl = '';
  pendingImageName = '';
  updateAttachmentUi();

  chatInput.value = '';
  resizeComposer();
  setBusy(true);
  const loading = addMessage('meta', 'Thinking…');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'ASK_STANDALONE_ASSISTANT',
      payload: {
        message: outgoingText,
        conversation,
        imageDataUrl,
      },
    });

    loading.remove();

    if (!response?.ok) {
      addMessage('system', response?.message || 'The assistant could not answer that request.');
      return;
    }

    const answer = response.result?.message || 'No answer returned.';
    conversation.push({ role: 'assistant', content: answer });
    addMessage('assistant', answer);

    const meta = response.result?._meta;
    if (meta?.usedImage) {
      const ocrNote = meta.ocrStatus === 'ok'
        ? 'Image OCR was used for this answer.'
        : 'Image OCR was requested, but OCR was unavailable.';
      addMessage('meta', ocrNote);
    }

    speakText(answer);
  } catch (error) {
    loading.remove();
    addMessage('system', `Unexpected error: ${error.message}`);
  } finally {
    setBusy(false);
    chatInput.focus();
  }
}

attachImageButton.addEventListener('click', () => imageInput.click());
removeImageButton.addEventListener('click', () => {
  pendingImageDataUrl = '';
  pendingImageName = '';
  imageInput.value = '';
  updateAttachmentUi();
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = String(reader.result || '');
    pendingImageName = file.name;
    updateAttachmentUi();
  };
  reader.readAsDataURL(file);
});

chatInput.addEventListener('input', resizeComposer);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

sendButton.addEventListener('click', sendMessage);
refreshOcrButton.addEventListener('click', refreshOcrStatus);
clearChatButton.addEventListener('click', () => {
  conversation = [];
  messageList.innerHTML = '';
  renderEmptyState();
});
openPopupButton.addEventListener('click', () => {
  if (!sourceTabId) {
    addMessage('system', 'This full assistant tab is not linked to a page yet. Open it from the extension popup on a website, then try again.');
    return;
  }

  chrome.tabs.sendMessage(sourceTabId, {
    action: 'OPEN_FULL_ASSISTANT_PANEL',
  }).catch?.(() => {});

  chrome.tabs.get(sourceTabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      addMessage('system', 'The original website tab is no longer available.');
      return;
    }

    if (typeof tab.windowId === 'number') {
      chrome.windows.update(tab.windowId, { focused: true }).catch?.(() => {});
    }
    chrome.tabs.update(sourceTabId, { active: true }).catch?.(() => {});
  });
});
micButton.addEventListener('click', toggleRecognition);
voiceToggleButton.addEventListener('click', toggleRecognition);

renderEmptyState();
resizeComposer();
initSpeechRecognition();
loadProviderStatus();
refreshOcrStatus();

if (!sourceTabId) {
  openPopupButton.disabled = true;
  openPopupButton.textContent = 'Page Panel Unavailable';
}

if (location.hash === '#ocr-setup') {
  document.getElementById('ocr-setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
