// ============================================================
// background.js - MoodAgent v2 (Brain / State Manager)
// Manifest V3 Service Worker
// ============================================================

let frustrationScore = 0;
let currentMood = 'Calm';
let assistantTriggered = false;
let _lastEventTime = Date.now();

const _inFlight = new Map();
const _cache = new Map();
const _conversationByTab = new Map();
const _tabActionState = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;
const HISTORY_LIMIT = 8;

const THRESHOLDS = { ANXIOUS: 15, FRUSTRATED: 30, ANGRY: 50 };

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_AI_PROVIDER = 'ollama';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11435';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b';
const DEFAULT_OCR_ENDPOINT = 'http://127.0.0.1:8765/ocr';
const OCR_TEXT_LIMIT = 2500;
const STATE_STORAGE_KEY = 'moodAgentRuntimeState';
const DECAY_ALARM_MINUTES = 0.5;

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 16_000;

// Max agentic loop steps before stopping
const AGENT_MAX_STEPS = 4;

function computeMood(score) {
  if (score >= THRESHOLDS.ANGRY) return 'Angry';
  if (score >= THRESHOLDS.FRUSTRATED) return 'Frustrated';
  if (score >= THRESHOLDS.ANXIOUS) return 'Anxious';
  return 'Calm';
}

function isTriggerMood(mood) {
  return mood === 'Anxious' || mood === 'Frustrated' || mood === 'Angry';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function ensureMood(value) {
  return ['Calm', 'Anxious', 'Frustrated', 'Angry'].includes(value) ? value : 'Calm';
}

async function hydrateRuntimeState() {
  try {
    const stored = await chrome.storage.local.get([STATE_STORAGE_KEY]);
    const runtimeState = stored?.[STATE_STORAGE_KEY];
    if (!runtimeState || typeof runtimeState !== 'object') return;

    frustrationScore = clamp(Number(runtimeState.frustrationScore) || 0, 0, 100);
    currentMood = ensureMood(runtimeState.currentMood);
    assistantTriggered = Boolean(runtimeState.assistantTriggered);
    _lastEventTime = Number(runtimeState.lastEventTime) || Date.now();
  } catch (_) {
    frustrationScore = 0;
    currentMood = 'Calm';
    assistantTriggered = false;
    _lastEventTime = Date.now();
  }
}

const _stateReady = hydrateRuntimeState();

async function persistRuntimeState() {
  await chrome.storage.local.set({
    [STATE_STORAGE_KEY]: {
      frustrationScore,
      currentMood,
      assistantTriggered,
      lastEventTime: _lastEventTime,
    },
  });
}

function applyDelta(delta) {
  frustrationScore = clamp(frustrationScore + delta, 0, 100);
  _lastEventTime = Date.now();
  const newMood = computeMood(frustrationScore);
  const changed = newMood !== currentMood;
  currentMood = newMood;
  if (isTriggerMood(currentMood) && !assistantTriggered) assistantTriggered = true;
  return changed;
}

function broadcastState(tabId, extra = {}) {
  const payload = {
    action: 'STATE_UPDATE',
    mood: currentMood,
    score: frustrationScore,
    triggerAssistant: isTriggerMood(currentMood),
    ...extra,
  };

  const send = (id) => chrome.tabs.sendMessage(id, payload).catch(() => {});

  if (tabId) {
    send(tabId);
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs?.[0]) send(tabs[0].id);
  });
}

function ensureDecayAlarm() {
  chrome.alarms.create('decay', { periodInMinutes: DECAY_ALARM_MINUTES });
}

ensureDecayAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    await _stateReady;
    if (alarm.name !== 'decay') return;
    if (frustrationScore <= 0) return;
    if (Date.now() - _lastEventTime < 10_000) return;

    frustrationScore = clamp(frustrationScore - 5, 0, 100);
    const newMood = computeMood(frustrationScore);
    if (newMood !== currentMood) {
      currentMood = newMood;
      if (!isTriggerMood(currentMood)) assistantTriggered = false;
    }

    await persistRuntimeState();
    broadcastState(null, { eventType: 'DECAY' });
  })().catch(() => {});
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const exp = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  return exp / 2 + Math.random() * (exp / 2);
}

function normalizeProvider(value) {
  return ['gemini', 'ollama'].includes(value) ? value : DEFAULT_AI_PROVIDER;
}

function normalizeOllamaBaseUrl(value) {
  const trimmed = (value || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
  if (trimmed === 'http://127.0.0.1:11434' || trimmed === 'http://localhost:11434') {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  return trimmed || DEFAULT_OLLAMA_BASE_URL;
}

async function loadAISettings() {
  const stored = await chrome.storage.local.get([
    'aiProvider',
    'geminiApiKey',
    'ollamaBaseUrl',
    'ollamaModel',
  ]);

  return {
    aiProvider: normalizeProvider(stored.aiProvider),
    geminiApiKey: stored.geminiApiKey?.trim() || '',
    ollamaBaseUrl: normalizeOllamaBaseUrl(stored.ollamaBaseUrl),
    ollamaModel: (stored.ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL,
  };
}

function hashQuery(query, domElements) {
  const raw = query.trim().toLowerCase() + '|' +
    domElements.slice(0, 20).map((e) => e.selector + e.text).join(',');
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(key, result) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
  _cache.set(key, { result, ts: Date.now() });
}

function getConversationHistory(tabId) {
  if (!tabId) return [];
  if (!_conversationByTab.has(tabId)) _conversationByTab.set(tabId, []);
  return _conversationByTab.get(tabId);
}

function rememberConversationTurn(tabId, role, content) {
  const text = String(content || '').trim();
  if (!tabId || !text) return;
  const history = getConversationHistory(tabId);
  history.push({ role, content: text.slice(0, 400) });
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
}

function buildConversationContext(tabId) {
  const history = getConversationHistory(tabId);
  if (!history.length) return '(none yet)';
  return history
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
    .join('\n')
    .slice(0, 1500);
}

function detectIntent(userQuery) {
  const text = String(userQuery || '').trim().toLowerCase();
  if (!text) return 'reply';
  if (/\b(click|type|search|press|hit|open|go to|fill|submit|buy|select|navigate)\b/i.test(text)) {
    return 'action';
  }
  if (/\b(explain|summari[sz]e|describe|identify|list|understand|what is on this page|what can you see|what do you see|tell me what|tell me about)\b/i.test(text)) {
    return 'answer';
  }
  if (/\b(step by step|plan|steps)\b/i.test(text)) {
    return 'plan';
  }
  return 'reply';
}

function pageLikelyNeedsOCR(userQuery, pageUrl, pageContext = {}) {
  const query = String(userQuery || '').toLowerCase();
  const url = String(pageUrl || '').toLowerCase();
  const visibleText = String(pageContext?.visibleText || '');
  const headings = Array.isArray(pageContext?.headings) ? pageContext.headings.length : 0;

  return (
    /docs\.google\.com|drive\.google\.com/.test(url) ||
    /\.pdf(?:$|\?)/.test(url) ||
    /\.(png|jpe?g|webp|gif|bmp)(?:$|\?)/.test(url) ||
    /\b(pdf|image|photo|screenshot|scan|document|abstract)\b/.test(query) ||
    visibleText.length < 300 ||
    headings === 0
  );
}

async function captureTabScreenshot(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (_) {
    return '';
  }
}

async function runOcrOnImage(imageDataUrl) {
  if (!imageDataUrl) return { status: 'skipped', text: '' };

  try {
    const response = await fetch(DEFAULT_OCR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    });

    if (!response.ok) {
      return { status: 'error', text: '', reason: `ocr_http_${response.status}` };
    }

    const payload = await response.json();
    return {
      status: payload?.status || 'error',
      text: String(payload?.text || '').slice(0, OCR_TEXT_LIMIT),
      reason: payload?.reason || '',
    };
  } catch (_) {
    return { status: 'error', text: '', reason: 'ocr_unreachable' };
  }
}

async function getOcrHealth() {
  try {
    const response = await fetch('http://127.0.0.1:8765/health');
    if (!response.ok) return { ok: false, status: 'offline' };
    const payload = await response.json();
    return {
      ok: Boolean(payload?.status === 'ok'),
      status: payload?.status || 'offline',
      tesseract: Boolean(payload?.tesseract),
    };
  } catch (_) {
    return { ok: false, status: 'offline', tesseract: false };
  }
}

async function maybeCollectOcrContext(windowId, userQuery, pageUrl, pageContext = {}) {
  if (!pageLikelyNeedsOCR(userQuery, pageUrl, pageContext)) {
    return { ...pageContext, ocrText: '', ocrStatus: 'skipped' };
  }

  let screenshot = await captureTabScreenshot(windowId);
  if (!screenshot) {
    return { ...pageContext, ocrText: '', ocrStatus: 'capture_failed' };
  }

  const ocrResult = await runOcrOnImage(screenshot);
  screenshot = '';

  return {
    ...pageContext,
    ocrText: String(ocrResult.text || '').slice(0, OCR_TEXT_LIMIT),
    ocrStatus: ocrResult.status || 'error',
    ocrReason: ocrResult.reason || '',
  };
}

function getTabActionState(tabId) {
  if (!tabId) return {};
  if (!_tabActionState.has(tabId)) {
    _tabActionState.set(tabId, {
      lastInputSelector: '',
      lastSearchSelector: '',
    });
  }
  return _tabActionState.get(tabId);
}

function describeResultForHistory(result) {
  if (!result) return '';
  if (result.mode === 'answer' || result.mode === 'reply') return result.message || '';
  if (result.mode === 'plan') {
    const steps = Array.isArray(result.steps) ? result.steps.join(' | ') : '';
    return [result.message, steps].filter(Boolean).join(' ');
  }
  if (result.action === 'type') {
    const suffix = result.autoSubmit ? ' and pressed Enter' : '';
    return `Action: type "${String(result.value || '').slice(0, 120)}" into ${result.selector}${suffix}.`;
  }
  if (result.action === 'keypress') {
    return `Action: press ${result.value || 'Enter'} on ${result.selector}.`;
  }
  if (result.action === 'click') {
    return `Action: click ${result.selector}.`;
  }
  if (result.action === 'navigate') {
    return `Action: navigate to ${result.value || ''}.`;
  }
  if (result.action === 'submit') {
    return `Action: submit ${result.selector}.`;
  }
  return `Action: ${result.action || result.mode || 'unknown'}.`;
}

function rememberActionTarget(tabId, actionObj, domElements = []) {
  if (!tabId || !actionObj?.selector) return;
  const state = getTabActionState(tabId);
  state.lastInputSelector = actionObj.selector;

  const matched = (domElements || []).find((el) => el?.selector === actionObj.selector);
  const looksSearchLike = Boolean(
    actionObj.autoSubmit ||
    matched?.isSearchLike ||
    matched?.role === 'searchbox' ||
    /search/i.test([
      matched?.text,
      matched?.placeholder,
      matched?.ariaLabel,
      matched?.name,
    ].filter(Boolean).join(' '))
  );

  if (looksSearchLike) {
    state.lastSearchSelector = actionObj.selector;
  }
}

function stripWrappingQuotes(text) {
  const trimmed = String(text || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isPressEnterRequest(userQuery) {
  return /\b(press|hit|submit)(?:\s+the)?\s+enter\b/i.test(userQuery || '') || /^\s*enter\s*$/i.test(userQuery || '');
}

function extractSearchTerms(userQuery) {
  const raw = String(userQuery || '').trim();
  if (!raw) return '';

  const searchLead =
    /^(?:please\s+)?(?:can you\s+)?(?:search(?:\s+(?:for|about|on))?|look up|look for|find(?:\s+articles?)?(?:\s+(?:on|about|for))?)\s+/i;
  if (!searchLead.test(raw)) return '';

  let query = raw.replace(searchLead, '');
  query = query.replace(/\s+(?:and\s+)?(?:press|hit)\s+enter\b.*$/i, '');
  query = query.replace(/\s+(?:on|in)\s+(?:this\s+)?page\b.*$/i, '');
  return stripWrappingQuotes(query);
}

function findBestSearchSelector(domElements = []) {
  const candidates = domElements
    .filter((el) => el?.selector)
    .filter((el) => {
      const haystack = [
        el.text,
        el.placeholder,
        el.ariaLabel,
        el.name,
        el.role,
        el.type,
      ].filter(Boolean).join(' ');
      return el.isSearchLike || el.role === 'searchbox' || /search/i.test(haystack);
    })
    .sort((a, b) => {
      const score = (el) => (
        (el.isSearchLike ? 5 : 0) +
        (el.type === 'search' ? 3 : 0) +
        (el.role === 'searchbox' ? 2 : 0) +
        (el.tag === 'input' ? 2 : 0)
      );
      return score(b) - score(a);
    });

  return candidates[0]?.selector || '';
}

function extractNavigationTarget(userQuery) {
  const raw = String(userQuery || '').trim();
  const match = raw.match(/^(?:please\s+)?(?:can you\s+)?(?:go to|open|click)\s+(.+?)(?:\s+page)?$/i);
  if (!match) return '';
  return stripWrappingQuotes(match[1].replace(/^the\s+/i, '').trim());
}

function findElementByIntent(domElements = [], targetText = '') {
  const normalizedTarget = String(targetText || '').trim().toLowerCase();
  if (!normalizedTarget) return null;

  const tokens = normalizedTarget.split(/\s+/).filter(Boolean);
  const candidates = domElements
    .filter((el) => el?.selector)
    .map((el) => {
      const haystack = [
        el.text,
        el.placeholder,
        el.ariaLabel,
        el.name,
        el.title,
        el.href,
        el.nearbyText,
      ].filter(Boolean).join(' ').toLowerCase();
      const tokenMatches = tokens.filter((token) => haystack.includes(token)).length;
      const exactMatch = haystack.includes(normalizedTarget);
      const clickableBonus = ['a', 'button'].includes(el.tag) ? 2 : 0;
      return {
        el,
        score: tokenMatches + (exactMatch ? 3 : 0) + clickableBonus,
      };
    })
    .filter((candidate) => candidate.score >= Math.max(1, tokens.length))
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.el || null;
}

function maybeBuildShortcutAction(userQuery, domElements, pageContext, tabId) {
  if (isPressEnterRequest(userQuery)) {
    const state = getTabActionState(tabId);
    const selector = state.lastSearchSelector || state.lastInputSelector;
    if (selector) {
      return {
        mode: 'action',
        action: 'keypress',
        selector,
        value: 'Enter',
        reasoning: 'Submit previous input',
        _meta: { provider: 'router', providerLabel: 'Local Router' },
      };
    }
  }

  const searchTerms = extractSearchTerms(userQuery);
  if (searchTerms) {
    const selector = findBestSearchSelector(domElements)
      || (pageContext?.searchCandidates || [])
        .map((candidate) => candidate.selector)
        .find((candidateSelector) => (domElements || []).some((el) => el?.selector === candidateSelector))
      || '';
    if (selector) {
      return {
        mode: 'action',
        action: 'type',
        selector,
        value: searchTerms,
        autoSubmit: true,
        reasoning: 'Search requested by user',
        _meta: { provider: 'router', providerLabel: 'Local Router' },
      };
    }
  }

  const navigationTarget = extractNavigationTarget(userQuery);
  if (!navigationTarget) return null;

  const matchedElement = findElementByIntent(domElements, navigationTarget);
  if (!matchedElement) return null;

  return {
    mode: 'action',
    action: 'click',
    selector: matchedElement.selector,
    reasoning: `Open ${navigationTarget}`.slice(0, 40),
    _meta: { provider: 'router', providerLabel: 'Local Router' },
  };
}

// ── CHANGE 1: buildSystemInstruction — intent-aware dual-mode prompt ──────────
function buildSystemInstruction() {
  return `You are an intelligent browser assistant embedded in a Chrome extension.
You can both UNDERSTAND pages (answer questions, summarize content) and ACT on them (click, type, navigate).

FIRST: decide the user's intent from their message.

INTENT RULES:
- If the user asks to explain, summarize, describe, identify, list, or understand content → use mode "answer"
- If the user asks to click, type, search, press, open, go to, fill, submit, buy, select → use mode "action"
- If the task needs multiple ordered steps → use mode "plan"
- If none of the above apply → use mode "reply"

RESPONSE SCHEMA — return ONLY one JSON object, no markdown, no preamble:

For understanding / informational prompts:
{"mode":"answer","message":"Your clear explanation using the page content provided."}

For a single DOM action:
{"mode":"action","action":"click","selector":"css-selector-here","reasoning":"one line"}
{"mode":"action","action":"type","selector":"css-selector-here","value":"text to enter","reasoning":"one line"}
{"mode":"action","action":"keypress","selector":"css-selector-here","value":"Enter","reasoning":"one line"}
{"mode":"action","action":"scroll","selector":"body","value":"pixel-offset","reasoning":"one line"}
{"mode":"action","action":"navigate","selector":"","value":"https://...","reasoning":"one line"}
{"mode":"action","action":"focus","selector":"css-selector-here","reasoning":"one line"}
{"mode":"action","action":"submit","selector":"css-selector-here","reasoning":"one line"}

For multi-step plans:
{"mode":"plan","steps":["Step 1 description","Step 2 description"],"message":"Here is what I will do:"}

For fallback / cannot do:
{"mode":"reply","message":"Clear explanation of why this cannot be done and what to try instead."}

ACTION RULES:
1. The "selector" must be taken DIRECTLY from the provided INTERACTIVE ELEMENTS list. Never invent selectors.
2. Prefer the most semantically precise element. Prefer inputs marked isSearchLike=true for search tasks.
3. For "type" actions, value must be the literal text string to enter.
4. "reasoning" must be 10 words or fewer.
5. NEVER use navigate for informational prompts. Prefer "answer" instead.
6. NEVER click product cards or links unless the user explicitly asked to open one.
7. For search tasks: prefer type into search input → then keypress Enter (or click search button).
8. Use "answer" when the user wants to know something — do not perform DOM actions for understanding prompts.
  9. Use visible headings and page text (from VISIBLE HEADINGS and PAGE TEXT sections) to answer informational questions.
10. Do not return JSON schema, links arrays, or placeholder objects.
11. Do not return top-level "type":"search" or "type":"action" unless the response also exactly matches one of the schemas above.
12. If the previous turn typed into a search box and the user now says "press enter", return a keypress action for that same selector.`;
}

// ── CHANGE 2: buildUserPrompt — enriched with page text context ───────────────
function buildUserPrompt(userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext = '(none yet)') {
  const elementList = domElements
    .map((el, i) => {
      const parts = [`[${i}] tag=${el.tag}`];
      if (el.type)        parts.push(`type=${el.type}`);
      if (el.role)        parts.push(`role=${el.role}`);
      if (el.text)        parts.push(`text="${el.text}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.ariaLabel)   parts.push(`aria-label="${el.ariaLabel}"`);
      if (el.name)        parts.push(`name="${el.name}"`);
      if (el.isSearchLike) parts.push(`isSearchLike=true`);
      if (el.href)        parts.push(`href="${el.href}"`);
      parts.push(`selector="${el.selector}"`);
      return parts.join(' ');
    })
    .join('\n');

  const headings = (pageContext?.headings || []).slice(0, 15).join('\n') || '(none detected)';
  const pageText = (pageContext?.visibleText || '').slice(0, 800) || '(none detected)';
  const ocrText = (pageContext?.ocrText || '').slice(0, 1200) || '(none)';
  const searchCandidates = (pageContext?.searchCandidates || [])
    .map(s => `selector="${s.selector}" placeholder="${s.placeholder}"`)
    .join('\n') || '(none detected)';

  return `PAGE TITLE: ${pageTitle || 'Untitled'}
URL: ${pageUrl || ''}
RECENT CONVERSATION:
${conversationContext}

USER REQUEST: ${userQuery}

VISIBLE HEADINGS:
${headings}

VISIBLE PAGE TEXT SUMMARY:
${pageText}

OCR TEXT:
${ocrText}

SEARCH / INPUT CANDIDATES:
${searchCandidates}

INTERACTIVE ELEMENTS ON PAGE (${domElements.length} total, showing first ${Math.min(domElements.length, 75)}):
${elementList}

Return a single JSON object matching one of the schemas in your instructions.`;
}

function buildOllamaAnswerPrompt(userQuery, pageTitle, pageUrl, pageContext, conversationContext = '(none yet)') {
  const headings = (pageContext?.headings || []).slice(0, 15).join('\n') || '(none detected)';
  const pageText = (pageContext?.visibleText || '').slice(0, 1200) || '(none detected)';
  const ocrText = (pageContext?.ocrText || '').slice(0, 1800) || '(none)';
  const buttonTexts = (pageContext?.buttonTexts || []).slice(0, 15).join(' | ') || '(none detected)';
  const prices = (pageContext?.prices || []).slice(0, 10).join(' | ') || '(none detected)';

  return `You are answering a question about the current webpage.
Use only the supplied page information.
If the page details are sparse, say that clearly instead of guessing.
Respond in plain text only. Do not return JSON, markdown fences, schemas, or tool instructions.

PAGE TITLE: ${pageTitle || 'Untitled'}
URL: ${pageUrl || ''}

RECENT CONVERSATION:
${conversationContext}

USER REQUEST:
${userQuery}

VISIBLE HEADINGS:
${headings}

VISIBLE PAGE TEXT SUMMARY:
${pageText}

OCR TEXT:
${ocrText}

VISIBLE BUTTON TEXT:
${buttonTexts}

VISIBLE PRICES:
${prices}`;
}

function cleanModelText(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildStandaloneConversationContext(conversation = []) {
  if (!Array.isArray(conversation) || !conversation.length) return '(none yet)';
  return conversation
    .slice(-10)
    .map((entry) => `${String(entry.role || 'user').toUpperCase()}: ${String(entry.content || '').trim()}`)
    .join('\n')
    .slice(0, 2000);
}

function buildStandaloneAnswerPrompt(message, conversationContext = '(none yet)', ocrText = '') {
  return `You are MoodAgent, a helpful assistant inside a Chrome extension.
Answer naturally and clearly like a polished chat assistant.
If OCR text is provided from an uploaded image, use it as the primary source for describing the image.
If the OCR text is weak or incomplete, say so clearly instead of hallucinating.
Respond in plain text only. No JSON. No markdown code fences.

RECENT CONVERSATION:
${conversationContext}

USER MESSAGE:
${message}

IMAGE OCR TEXT:
${ocrText || '(none provided)'}`;
}

// ── CHANGE 3: tryParseAction — supports new modes and actions ─────────────────
function tryParseAction(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  function normalizeActionSchema(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // Handle legacy {actions:[...]} wrapping from older local models
    const candidate = Array.isArray(obj.actions) ? obj.actions[0] : obj;
    if (!candidate || typeof candidate !== 'object') return null;

    // New mode-based protocol
    const mode = candidate.mode
      || (['answer', 'plan', 'reply'].includes(candidate.type) ? candidate.type : null);
    if (mode === 'answer') {
      return {
        mode: 'answer',
        message: candidate.message || candidate.reply || '',
      };
    }

    if (mode === 'plan') {
      return {
        mode: 'plan',
        steps: Array.isArray(candidate.steps) ? candidate.steps : [],
        message: candidate.message || '',
      };
    }

    if (mode === 'reply') {
      return {
        mode: 'reply',
        action: 'reply',
        message: candidate.message || candidate.reply || '',
      };
    }

    if (candidate.type === 'error' && candidate.message) {
      return {
        mode: 'reply',
        action: 'reply',
        message: /invalid input/i.test(candidate.message)
          ? 'The local model could not turn that into a browser action. Please retry, or switch to Gemini for more reliable navigation.'
          : candidate.message,
      };
    }

    if (mode === 'action' || candidate.type === 'action' || candidate.type === 'search') {
      const action = candidate.action || candidate.actionType || candidate.kind || candidate.type;
      if (typeof action !== 'string') return null;

      const normalized = {
        mode: 'action',
        action,
        selector: candidate.selector || candidate.css || candidate.target || '',
        value: candidate.value ?? candidate.text ?? candidate.input ?? candidate.url ?? '',
        reasoning: candidate.reasoning || candidate.reason || '',
        message: candidate.message || '',
        autoSubmit: Boolean(candidate.autoSubmit ?? candidate.submitAfterType ?? candidate.pressEnter),
      };

      if (normalized.action === 'search') {
        normalized.action = 'type';
        normalized.autoSubmit = true;
      }
      if (normalized.action === 'navigate' && !normalized.value && candidate.href) {
        normalized.value = candidate.href;
      }
      if (normalized.action === 'reply' && !normalized.message && normalized.value) {
        normalized.message = String(normalized.value);
      }

      const allowed = ['click', 'type', 'scroll', 'navigate', 'reply', 'keypress', 'focus', 'submit', 'select'];
      if (!allowed.includes(normalized.action)) return null;
      if (['click', 'type', 'keypress', 'focus', 'submit'].includes(normalized.action) && !normalized.selector) return null;
      return normalized;
    }

    // Legacy fallback: old single-mode format without a "mode" field
    const action = candidate.action || candidate.actionType || candidate.kind || candidate.type;
    if (typeof action !== 'string') return null;

    if (action === 'reply') {
      return {
        mode: 'reply',
        action: 'reply',
        message: candidate.message || candidate.reply || candidate.explanation || String(candidate.value || ''),
      };
    }

    const normalized = {
      mode: 'action',
      action,
      selector: candidate.selector || candidate.css || candidate.target || '',
      value: candidate.value ?? candidate.text ?? candidate.input ?? candidate.url ?? '',
      reasoning: candidate.reasoning || candidate.reason || '',
      message: '',
      autoSubmit: Boolean(candidate.autoSubmit ?? candidate.submitAfterType ?? candidate.pressEnter),
    };

    if (normalized.action === 'search') {
      normalized.action = 'type';
      normalized.autoSubmit = true;
    }
    if (normalized.action === 'navigate' && !normalized.value && candidate.href) {
      normalized.value = candidate.href;
    }

    const allowed = ['click', 'type', 'scroll', 'navigate', 'keypress', 'focus', 'submit', 'select'];
    if (!allowed.includes(normalized.action)) return null;
    if (['click', 'type', 'keypress', 'focus', 'submit'].includes(normalized.action) && !normalized.selector) return null;
    return normalized;
  }

  try {
    return normalizeActionSchema(JSON.parse(cleaned));
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*?\}/);
    if (match) {
      try { return normalizeActionSchema(JSON.parse(match[0])); } catch (_) {}
    }
    return null;
  }
}

function tryParseError(text) {
  try {
    const obj = JSON.parse(text);
    return obj?.error?.message || text.slice(0, 100);
  } catch (_) {
    return text.slice(0, 100);
  }
}

// ── CHANGE 4: validateActionAgainstDom — supports new actions + modes ─────────
function validateActionAgainstDom(actionObj, domElements) {
  if (!actionObj || typeof actionObj !== 'object') return null;

  // answer, plan, reply modes don't need DOM validation
  if (actionObj.mode === 'answer' || actionObj.mode === 'plan' || actionObj.mode === 'reply') {
    return actionObj;
  }
  if (actionObj.action === 'reply') return actionObj;

  // scroll and navigate don't need selector validation
  if (actionObj.action === 'scroll' || actionObj.action === 'navigate') return actionObj;

  // Actions that need a real selector: click, type, keypress, focus, submit, select
  const selectorRequired = ['click', 'type', 'keypress', 'focus', 'submit', 'select'];
  if (selectorRequired.includes(actionObj.action)) {
    const allowedSelectors = new Set(
      (domElements || []).map((el) => el?.selector).filter(Boolean)
    );

    if (!allowedSelectors.has(actionObj.selector)) {
      return {
        mode: 'reply',
        action: 'reply',
        message: `I could not find a matching element for selector "${actionObj.selector}" on this page. Try asking for one step at a time, like "click Search", "type Nike in the search box", or "press Enter".`,
        _meta: actionObj._meta,
      };
    }
  }

  // Guard: if the model returns navigate for an informational-sounding context, convert to reply
  if (actionObj.action === 'navigate' && !actionObj.value) {
    return {
      mode: 'reply',
      action: 'reply',
      message: 'I was about to navigate but no URL was provided. Please specify a URL or a link to open.',
      _meta: actionObj._meta,
    };
  }

  return actionObj;
}

async function callGeminiAPI(settings, userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext) {
  if (!settings.geminiApiKey) {
    return {
      ok: false,
      code: 'missing_gemini_key',
      message: 'Please add your Gemini API key in the extension settings to enable Gemini.',
    };
  }

  const body = {
    system_instruction: {
      parts: [{ text: buildSystemInstruction() }],
    },
    contents: [{
      role: 'user',
      parts: [{ text: buildUserPrompt(userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext) }],
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 500,
      topP: 0.8,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  let lastError = null;
  let hitRateLimit = false;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1);
      console.log(`[MoodAgent] Gemini retry ${attempt}/${RETRY_ATTEMPTS - 1} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }

    let response;
    try {
      response = await fetch(`${GEMINI_ENDPOINT}?key=${settings.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      lastError = `Network error: ${networkErr.message}`;
      continue;
    }

    if (response.status === 429) {
      hitRateLimit = true;
      const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt);
      await sleep(wait);
      lastError = 'Rate limit (429)';
      continue;
    }

    if (response.status >= 500) {
      lastError = `Server error (${response.status})`;
      continue;
    }

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch (_) {}
      const parsed = tryParseError(errBody);

      if (response.status === 400) {
        return { ok: false, code: 'bad_request', message: `Gemini rejected the request: ${parsed}. Try rephrasing.` };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: 'invalid_gemini_key', message: 'Gemini API key is invalid or lacks permission. Check it in settings.' };
      }
      return { ok: false, code: 'gemini_api_error', message: `Gemini API error ${response.status}: ${parsed}` };
    }

    let data;
    try {
      data = await response.json();
    } catch (_) {
      lastError = 'Failed to parse Gemini response JSON';
      continue;
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') {
        return { ok: false, code: 'safety_block', message: 'The request was blocked by Gemini safety filters. Please rephrase your command.' };
      }
      lastError = 'Empty response from Gemini';
      continue;
    }

    const parsed = tryParseAction(rawText);
    if (!parsed) {
      lastError = `Could not parse action from: ${rawText.slice(0, 120)}`;
      continue;
    }

    return {
      ok: true,
      result: validateActionAgainstDom({
        ...parsed,
        _meta: { provider: 'gemini', providerLabel: 'Gemini' },
      }, domElements),
    };
  }

  if (hitRateLimit) {
    return {
      ok: false,
      code: 'rate_limit',
      message: 'Gemini is currently rate limited. Local Ollama fallback is a good option here.',
    };
  }

  return {
    ok: false,
    code: 'gemini_unavailable',
    message: `I couldn't complete the action after ${RETRY_ATTEMPTS} Gemini attempts. Last error: ${lastError}.`,
  };
}

async function callGeminiFreeformAnswerAPI(settings, promptText) {
  if (!settings.geminiApiKey) {
    return {
      ok: false,
      code: 'missing_gemini_key',
      message: 'Please add your Gemini API key in the extension settings to enable Gemini.',
    };
  }

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${settings.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: promptText }],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 700,
          topP: 0.9,
        },
      }),
    });

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch (_) {}
      return {
        ok: false,
        code: 'gemini_api_error',
        message: `Gemini API error ${response.status}: ${tryParseError(errBody)}`,
      };
    }

    const data = await response.json();
    const text = cleanModelText(data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    if (!text) {
      return {
        ok: false,
        code: 'gemini_empty_response',
        message: 'Gemini returned an empty response.',
      };
    }

    return {
      ok: true,
      result: {
        mode: 'answer',
        message: text,
        _meta: { provider: 'gemini', providerLabel: 'Gemini' },
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'gemini_network_error',
      message: `Gemini network error: ${error.message}`,
    };
  }
}

async function callOllamaAPI(settings, userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext) {
  const endpoint = `${settings.ollamaBaseUrl}/api/generate`;
  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel,
        system: buildSystemInstruction(),
        prompt: buildUserPrompt(userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext),
        format: 'json',
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.8,
        },
      }),
    });
  } catch (_) {
    return {
      ok: false,
      code: 'ollama_unreachable',
      message: `I couldn't reach Ollama at ${settings.ollamaBaseUrl}. Start the Ollama app and make sure the local server is running.`,
    };
  }

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (_) {}
    const parsed = tryParseError(errBody);

    if (response.status === 404) {
      return {
        ok: false,
        code: 'ollama_model_missing',
        message: `Ollama could not find the model "${settings.ollamaModel}". Pull that model first, then retry.`,
      };
    }

    return {
      ok: false,
      code: 'ollama_api_error',
      message: `Ollama error ${response.status}: ${parsed}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    return {
      ok: false,
      code: 'ollama_parse_error',
      message: 'Ollama returned a response that could not be parsed as JSON.',
    };
  }

  const rawText = data?.response?.trim();
  if (!rawText) {
    return {
      ok: false,
      code: 'ollama_empty_response',
      message: 'Ollama returned an empty response. Try a smaller local model or a simpler instruction.',
    };
  }

  const parsed = tryParseAction(rawText);
  if (!parsed) {
    console.warn('[MoodAgent] Ollama returned an unparseable payload:', rawText);
    return {
      ok: false,
      code: 'ollama_invalid_action',
      message: 'Ollama returned a malformed response for this request. Please retry, or use Gemini for more reliable structured actions.',
    };
  }

  return {
    ok: true,
    result: validateActionAgainstDom({
      ...parsed,
      _meta: {
        provider: 'ollama',
        providerLabel: 'Ollama',
        model: settings.ollamaModel,
      },
    }, domElements),
  };
}

async function callOllamaAnswerAPI(settings, userQuery, pageTitle, pageUrl, pageContext, conversationContext) {
  const endpoint = `${settings.ollamaBaseUrl}/api/generate`;
  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel,
        prompt: buildOllamaAnswerPrompt(userQuery, pageTitle, pageUrl, pageContext, conversationContext),
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.9,
        },
      }),
    });
  } catch (_) {
    return {
      ok: false,
      code: 'ollama_unreachable',
      message: `I couldn't reach Ollama at ${settings.ollamaBaseUrl}. Start the Ollama app and make sure the local server is running.`,
    };
  }

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (_) {}
    const parsed = tryParseError(errBody);

    if (response.status === 404) {
      return {
        ok: false,
        code: 'ollama_model_missing',
        message: `Ollama could not find the model "${settings.ollamaModel}". Pull that model first, then retry.`,
      };
    }

    return {
      ok: false,
      code: 'ollama_api_error',
      message: `Ollama error ${response.status}: ${parsed}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    return {
      ok: false,
      code: 'ollama_parse_error',
      message: 'Ollama returned a response that could not be parsed as JSON.',
    };
  }

  const message = cleanModelText(data?.response);
  if (!message) {
    return {
      ok: false,
      code: 'ollama_empty_response',
      message: 'Ollama returned an empty response. Try a smaller local model or a simpler instruction.',
    };
  }

  return {
    ok: true,
    result: {
      mode: 'answer',
      message,
      _meta: {
        provider: 'ollama',
        providerLabel: 'Ollama',
        model: settings.ollamaModel,
      },
    },
  };
}

async function callOllamaFreeformAnswerAPI(settings, promptText) {
  const endpoint = `${settings.ollamaBaseUrl}/api/generate`;
  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel,
        prompt: promptText,
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.9,
        },
      }),
    });
  } catch (_) {
    return {
      ok: false,
      code: 'ollama_unreachable',
      message: `I couldn't reach Ollama at ${settings.ollamaBaseUrl}. Start the Ollama app and make sure the local server is running.`,
    };
  }

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (_) {}
    return {
      ok: false,
      code: 'ollama_api_error',
      message: `Ollama error ${response.status}: ${tryParseError(errBody)}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    return {
      ok: false,
      code: 'ollama_parse_error',
      message: 'Ollama returned a response that could not be parsed as JSON.',
    };
  }

  const text = cleanModelText(data?.response || '');
  if (!text) {
    return {
      ok: false,
      code: 'ollama_empty_response',
      message: 'Ollama returned an empty response. Try a smaller local model or a simpler instruction.',
    };
  }

  return {
    ok: true,
    result: {
      mode: 'answer',
      message: text,
      _meta: {
        provider: 'ollama',
        providerLabel: 'Ollama',
        model: settings.ollamaModel,
      },
    },
  };
}

// ── Helper: ask model once and return parsed+validated result ─────────────────
async function askModel(settings, userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext) {
  const intent = detectIntent(userQuery);
  const response = settings.aiProvider === 'gemini'
    ? await callGeminiAPI(settings, userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext)
    : intent === 'answer'
      ? await callOllamaAnswerAPI(settings, userQuery, pageTitle, pageUrl, pageContext, conversationContext)
      : await callOllamaAPI(settings, userQuery, domElements, pageTitle, pageUrl, pageContext, conversationContext);

  if (response.ok) return { ok: true, result: response.result };
  return { ok: false, message: response.message };
}

async function askStandaloneAssistant(message, conversation = [], imageDataUrl = '') {
  const settings = await loadAISettings();
  const conversationContext = buildStandaloneConversationContext(conversation);
  const ocrResult = imageDataUrl ? await runOcrOnImage(imageDataUrl) : { status: 'skipped', text: '', reason: '' };
  const promptText = buildStandaloneAnswerPrompt(
    message,
    conversationContext,
    String(ocrResult.text || '').slice(0, OCR_TEXT_LIMIT)
  );

  const response = settings.aiProvider === 'gemini'
    ? await callGeminiFreeformAnswerAPI(settings, promptText)
    : await callOllamaFreeformAnswerAPI(settings, promptText);

  if (response.ok) {
    return {
      ok: true,
      result: {
        ...response.result,
        _meta: {
          ...(response.result._meta || {}),
          ocrStatus: ocrResult.status,
          ocrReason: ocrResult.reason || '',
          usedImage: Boolean(imageDataUrl),
        },
      },
    };
  }

  if (imageDataUrl && ocrResult.status !== 'ok') {
    return {
      ok: false,
      message: 'I could not read the uploaded image. Make sure the local OCR helper is running, then try again.',
    };
  }

  return { ok: false, message: response.message };
}

// ── Helper: request fresh DOM from the tab ────────────────────────────────────
function requestFreshDom(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'REQUEST_DOM_SNAPSHOT' }, (payload) => {
      if (chrome.runtime.lastError || !payload) return resolve(null);
      resolve(payload);
    });
  });
}

// ── CHANGE 5: callAssistantAPI — agentic multi-step loop ──────────────────────
async function callAssistantAPI(userQuery, domElements, pageTitle, pageUrl, pageContext, tabId, windowId) {
  const settings = await loadAISettings();
  const intent = detectIntent(userQuery);
  const conversationContext = buildConversationContext(tabId);
  const shortcutResult = maybeBuildShortcutAction(userQuery, domElements, pageContext, tabId);
  if (shortcutResult) {
    rememberActionTarget(tabId, shortcutResult, domElements);
    return shortcutResult;
  }
  const effectivePageContext = intent === 'answer'
    ? await maybeCollectOcrContext(windowId, userQuery, pageUrl, pageContext)
    : pageContext;
  if (
    intent === 'answer' &&
    pageLikelyNeedsOCR(userQuery, pageUrl, pageContext) &&
    String(effectivePageContext?.visibleText || '').length < 200 &&
    !String(effectivePageContext?.ocrText || '').trim()
  ) {
    return {
      mode: 'reply',
      action: 'reply',
      message: 'I could not read enough text from this page. Start the local OCR helper with `backend/start-ocr-server.ps1`, refresh the tab, and try again.',
      _meta: { provider: 'ocr', providerLabel: 'Local OCR' },
    };
  }
  const cacheKey = hashQuery(
    `${settings.aiProvider}|${settings.ollamaModel}|${pageUrl}|${conversationContext}|${userQuery}|${(effectivePageContext?.ocrText || '').slice(0, 300)}`,
    domElements
  );
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log('[MoodAgent] Cache hit:', cacheKey);
    return cached;
  }

  let currentElements = domElements;
  let currentContext = effectivePageContext;
  const metaBase = settings.aiProvider === 'gemini'
    ? { provider: 'gemini', providerLabel: 'Gemini' }
    : { provider: 'ollama', providerLabel: 'Ollama', model: settings.ollamaModel };

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
    const attempt = await askModel(
      settings,
      userQuery,
      currentElements,
      pageTitle,
      pageUrl,
      currentContext,
      conversationContext
    );

    if (!attempt.ok) {
      return {
        mode: 'reply',
        action: 'reply',
        message: attempt.message || 'The assistant could not complete that request.',
        _meta: metaBase,
      };
    }

    const result = attempt.result;
    if (result?.mode === 'action') {
      rememberActionTarget(tabId, result, currentElements);
    }

    // answer / plan / reply → return immediately, no further looping
    if (result.mode === 'answer' || result.mode === 'plan' || result.mode === 'reply' || result.action === 'reply') {
      if (result.mode === 'answer' || result.mode === 'plan') {
        cacheSet(cacheKey, result);
      }
      return result;
    }

    // It's a DOM action — return it for content.js to execute
    // On step 0 we always return immediately so the UI shows progress.
    // On subsequent steps (after re-scrape), we return the next action.
    cacheSet(cacheKey, result);
    return result;
  }

  // Safety: exhausted steps
  return {
    mode: 'reply',
    action: 'reply',
    message: 'I completed the maximum number of steps for this task. Please check the page and continue if needed.',
    _meta: metaBase,
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;

  if (request.action === 'TELEMETRY_EVENT') {
    void (async () => {
      await _stateReady;
      const { scoreDelta, eventType, context } = request.payload || {};
      applyDelta(scoreDelta || 0);
      await persistRuntimeState();
      broadcastState(tabId, { eventType, context });
      sendResponse({ ok: true, score: frustrationScore, mood: currentMood });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'HEARTBEAT') {
    void (async () => {
      await _stateReady;
      broadcastState(tabId);
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'ASSISTANT_QUERY') {
    void (async () => {
      await _stateReady;
      const { text, domElements, url, title, pageContext } = request.payload || {};

      if (_inFlight.get(tabId)) {
        sendResponse({ ok: false, error: 'Request already in flight' });
        return;
      }
      _inFlight.set(tabId, true);

      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: 'AGENT_LOADING',
          payload: { loading: true },
        }).catch(() => {});
      }

      sendResponse({ ok: true });

      try {
        const result = await callAssistantAPI(text, domElements || [], title, url, pageContext || {}, tabId, windowId);
        _inFlight.delete(tabId);
        if (!tabId) return;

        rememberConversationTurn(tabId, 'user', text);
        rememberConversationTurn(tabId, 'assistant', describeResultForHistory(result));

        if (result.mode === 'answer') {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_ANSWER',
            payload: { message: result.message, _meta: result._meta },
          }).catch(() => {});
          return;
        }

        if (result.mode === 'plan') {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_PLAN',
            payload: { steps: result.steps, message: result.message, _meta: result._meta },
          }).catch(() => {});
          return;
        }

        if (result.action === 'reply' || result.mode === 'reply') {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_REPLY',
            payload: { message: result.message, _meta: result._meta },
          }).catch(() => {});
          return;
        }

        chrome.tabs.sendMessage(tabId, {
          action: 'AGENT_RESULT',
          payload: result,
        }).catch(() => {});
      } catch (err) {
        _inFlight.delete(tabId);
        console.error('[MoodAgent] Unhandled error in callAssistantAPI:', err);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_ERROR',
            payload: { error: `Unexpected error: ${err.message}` },
          }).catch(() => {});
        }
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'GET_STATE') {
    void (async () => {
      await _stateReady;
      sendResponse({ score: frustrationScore, mood: currentMood });
    })().catch((error) => sendResponse({ score: 0, mood: 'Calm', error: error.message }));
    return true;
  }

  if (request.action === 'RESET_STATE') {
    void (async () => {
      await _stateReady;
      frustrationScore = 0;
      currentMood = 'Calm';
      assistantTriggered = false;
      _lastEventTime = Date.now();
      _cache.clear();
      if (tabId) {
        _conversationByTab.delete(tabId);
        _tabActionState.delete(tabId);
      }
      await persistRuntimeState();
      broadcastState(tabId, { eventType: 'RESET' });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'ASSISTANT_QUERY') {
    const { text, domElements, url, title, pageContext } = request.payload || {};

    if (_inFlight.get(tabId)) {
      sendResponse({ ok: false, error: 'Request already in flight' });
      return true;
    }
    _inFlight.set(tabId, true);

    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'AGENT_LOADING',
        payload: { loading: true },
      }).catch(() => {});
    }

    callAssistantAPI(text, domElements || [], title, url, pageContext || {}, tabId, windowId)
      .then((result) => {
        _inFlight.delete(tabId);
        if (!tabId) return;
        rememberConversationTurn(tabId, 'user', text);
        rememberConversationTurn(tabId, 'assistant', describeResultForHistory(result));

        // ── answer mode → AGENT_ANSWER ────────────────────
        if (result.mode === 'answer') {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_ANSWER',
            payload: { message: result.message, _meta: result._meta },
          }).catch(() => {});
          return;
        }

        // ── plan mode → AGENT_PLAN ────────────────────────
        if (result.mode === 'plan') {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_PLAN',
            payload: { steps: result.steps, message: result.message, _meta: result._meta },
          }).catch(() => {});
          return;
        }

        // ── reply / fallback ──────────────────────────────
        if (result.action === 'reply' || result.mode === 'reply') {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_REPLY',
            payload: { message: result.message, _meta: result._meta },
          }).catch(() => {});
          return;
        }

        // ── DOM action ────────────────────────────────────
        chrome.tabs.sendMessage(tabId, {
          action: 'AGENT_RESULT',
          payload: result,
        }).catch(() => {});
      })
      .catch((err) => {
        _inFlight.delete(tabId);
        console.error('[MoodAgent] Unhandled error in callAssistantAPI:', err);
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: 'AGENT_ERROR',
            payload: { error: `Unexpected error: ${err.message}` },
          }).catch(() => {});
        }
      });

    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'GET_STATE') {
    sendResponse({ score: frustrationScore, mood: currentMood });
    return true;
  }

  if (request.action === 'OPEN_STANDALONE_ASSISTANT') {
    const requestedSourceTabId = Number(request.payload?.sourceTabId) || tabId || 0;
    const params = new URLSearchParams();
    if (requestedSourceTabId) {
      params.set('sourceTabId', String(requestedSourceTabId));
    }

    const assistantUrl = chrome.runtime.getURL(
      `assistant.html${params.toString() ? `?${params.toString()}` : ''}`
    );

    chrome.tabs.create({ url: assistantUrl })
      .then(() => sendResponse({ ok: true, url: assistantUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'ASK_STANDALONE_ASSISTANT') {
    const { message, conversation, imageDataUrl } = request.payload || {};
    askStandaloneAssistant(String(message || ''), conversation || [], String(imageDataUrl || ''))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        message: `Unexpected error: ${error.message}`,
      }));
    return true;
  }

  if (request.action === 'GET_OCR_STATUS') {
    getOcrHealth().then(sendResponse).catch(() => sendResponse({ ok: false, status: 'offline', tesseract: false }));
    return true;
  }

  if (request.action === 'RESET_STATE') {
    frustrationScore = 0;
    currentMood = 'Calm';
    assistantTriggered = false;
    _cache.clear();
    if (tabId) {
      _conversationByTab.delete(tabId);
      _tabActionState.delete(tabId);
    }
    broadcastState(tabId, { eventType: 'RESET' });
    sendResponse({ ok: true });
    return true;
  }

  sendResponse({ ok: false, error: 'Unknown action' });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureDecayAlarm();
  chrome.storage.local.get(['aiProvider', 'ollamaBaseUrl', 'ollamaModel'], (stored) => {
    chrome.storage.local.set({
      aiProvider: stored.aiProvider || DEFAULT_AI_PROVIDER,
      ollamaBaseUrl: stored.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
      ollamaModel: stored.ollamaModel || DEFAULT_OLLAMA_MODEL,
    });
  });
  console.log('[MoodAgent] Extension installed / updated.');
});

chrome.runtime.onStartup?.addListener(() => {
  ensureDecayAlarm();
});

console.log('[MoodAgent] Background service worker started.');
