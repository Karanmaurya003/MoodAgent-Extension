// ============================================================
// content.js — MoodAgent v2  (Observer · Eyes · Hands)
// Responsibilities:
//   1. Telemetry collection → background.js (frustration scoring)
//   2. Shadow DOM UI  (mood indicator + assistant chat panel)
//   3. DOM scraper    (getInteractiveElements + getPageUnderstandingContext)
//   4. Action executor (executeAgentAction)
//   5. Receiving state / LLM results from background.js
// ============================================================

function isExtensionContextInvalidated(error) {
  return /Extension context invalidated/i.test(error?.message || '');
}

function safeSendRuntimeMessage(message, { onError, onInvalidated } = {}) {
  try {
    const maybePromise = chrome.runtime.sendMessage(message);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      return maybePromise.catch((error) => {
        if (isExtensionContextInvalidated(error)) {
          onInvalidated?.(error);
          return null;
        }
        return onError ? onError(error) : null;
      });
    }
    return Promise.resolve(maybePromise ?? null);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      onInvalidated?.(error);
      return Promise.resolve(null);
    }
    return onError ? Promise.resolve(onError(error)) : Promise.reject(error);
  }
}

function safeStorageLocalGet(keys, callback, { onError, onInvalidated } = {}) {
  try {
    chrome.storage.local.get(keys, (result) => callback?.(result || {}));
    return true;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      onInvalidated?.(error);
      return false;
    }
    onError?.(error);
    return false;
  }
}

function safeStorageLocalSet(value, callback, { onError, onInvalidated } = {}) {
  try {
    chrome.storage.local.set(value, () => callback?.());
    return true;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      onInvalidated?.(error);
      return false;
    }
    onError?.(error);
    return false;
  }
}

if (window.__moodAgentInjected) {
  safeSendRuntimeMessage({ action: 'HEARTBEAT' });
} else {
  window.__moodAgentInjected = true;
  const DEFAULT_AI_PROVIDER = 'ollama';
  const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11435';
  const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b';

  // ══════════════════════════════════════════════════════════
  // SECTION 0 — SHADOW DOM ASSETS (must be declared first —
  // const/let are NOT hoisted; bootUI() reads these at call-time
  // but if they were defined below bootUI in the same block scope
  // they'd be in the Temporal Dead Zone when the DOMContentLoaded
  // fires synchronously on pages where document is already loaded)
  // ══════════════════════════════════════════════════════════

  const UI_STYLES = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    #ma-root {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 14px;
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }

    /* Pill */
    #ma-pill {
      display: flex; align-items: center; gap: 8px;
      position: relative; cursor: pointer;
    }
    #ma-pulse {
      --ring-color: #22c55e;
      position: absolute; inset: -5px;
      border-radius: 50px;
      border: 2px solid var(--ring-color);
      opacity: 0; pointer-events: none;
    }
    #ma-pulse.pulsing { animation: maRing 1.3s ease-out infinite; opacity: 1; }
    @keyframes maRing {
      0%   { transform: scale(.94); opacity: .7; }
      70%  { transform: scale(1.28); opacity: 0; }
      100% { transform: scale(.94); opacity: 0; }
    }
    #ma-indicator {
      --mood-color: #22c55e;
      width: 44px; height: 44px; border-radius: 50%;
      background: rgba(8,12,24,.93);
      border: 2px solid var(--mood-color);
      box-shadow: 0 0 14px color-mix(in srgb, var(--mood-color) 35%, transparent), 0 4px 18px rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
      transition: border-color .35s, box-shadow .35s, transform .15s;
      backdrop-filter: blur(10px); cursor: pointer; user-select: none;
    }
    #ma-indicator:hover { transform: scale(1.09); }
    #ma-info {
      background: rgba(8,12,24,.9);
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 10px; padding: 4px 10px;
      backdrop-filter: blur(10px); cursor: pointer; min-width: 70px;
    }
    #ma-mood-label {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #94a3b8; display: block;
    }
    #ma-score-row { display: flex; align-items: baseline; gap: 2px; }
    #ma-score { font-size: 20px; font-weight: 800; color: #f1f5f9; line-height: 1.1; }
    .ma-unit { font-size: 10px; color: #475569; }
    #ma-toggle {
      position: absolute; top: -5px; right: -5px;
      width: 17px; height: 17px; border-radius: 50%;
      background: #3b82f6; border: none; color: #fff;
      font-size: 9px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      padding: 0; transition: background .2s;
    }
    #ma-toggle:hover { background: #2563eb; }

    /* Panel */
    #ma-assistant {
      position: absolute; bottom: 58px; right: 0;
      width: 345px;
      background: rgba(7,11,22,.97);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 18px;
      box-shadow: 0 24px 64px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.04);
      backdrop-filter: blur(24px);
      display: none; flex-direction: column; overflow: hidden;
    }
    #ma-assistant.visible {
      display: flex;
      animation: maSlide .22s cubic-bezier(.16,1,.3,1) forwards;
    }
    @keyframes maSlide {
      from { transform: translateY(10px) scale(.97); opacity: 0; }
      to   { transform: translateY(0)    scale(1);   opacity: 1; }
    }

    /* Header */
    #ma-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255,255,255,.06);
      background: rgba(255,255,255,.025);
      gap: 6px;
    }
    #ma-header-title {
      font-size: 13px; font-weight: 700; flex: 1;
      background: linear-gradient(120deg,#60a5fa,#a78bfa);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .ma-hbtn {
      background: none; border: none; color: #64748b; cursor: pointer;
      font-size: 14px; padding: 3px 7px; border-radius: 6px; line-height: 1;
      transition: color .2s, background .2s;
    }
    .ma-hbtn:hover { color: #e2e8f0; background: rgba(255,255,255,.08); }
    .ma-open-full {
      background: rgba(59,130,246,.14);
      border: 1px solid rgba(96,165,250,.22);
      color: #bfdbfe;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .02em;
      padding: 5px 9px;
      border-radius: 999px;
      cursor: pointer;
      transition: background .2s, border-color .2s, color .2s;
    }
    .ma-open-full:hover {
      background: rgba(59,130,246,.24);
      border-color: rgba(96,165,250,.34);
      color: #eff6ff;
    }

    /* Settings */
    #ma-settings {
      display: none; flex-direction: column; gap: 7px;
      padding: 11px 16px;
      border-bottom: 1px solid rgba(255,255,255,.06);
      background: rgba(255,255,255,.015);
    }
    #ma-settings.visible { display: flex; }
    #ma-settings label { font-size: 10.5px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; }
    #ma-settings-row { display: flex; gap: 6px; }
    #ma-provider,
    #ma-apikey,
    #ma-ollama-url,
    #ma-ollama-model {
      flex: 1; background: rgba(255,255,255,.07);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px; color: #e2e8f0; font-size: 12px;
      padding: 6px 10px; outline: none;
      transition: border-color .2s; font-family: monospace;
    }
    #ma-provider { font-family: inherit; }
    #ma-provider:focus,
    #ma-apikey:focus,
    #ma-ollama-url:focus,
    #ma-ollama-model:focus { border-color: rgba(96,165,250,.5); }
    #ma-save-settings {
      background: linear-gradient(135deg,#3b82f6,#6366f1);
      border: none; border-radius: 8px; color: #fff;
      font-size: 11px; font-weight: 700; padding: 6px 12px;
      cursor: pointer; white-space: nowrap; transition: opacity .2s;
    }
    #ma-save-settings:hover { opacity: .85; }
    #ma-settings-note { font-size: 10px; color: #475569; }

    /* Messages */
    #ma-messages {
      flex: 1; overflow-y: auto; padding: 12px 13px;
      display: flex; flex-direction: column; gap: 8px;
      max-height: 310px; min-height: 100px;
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.07) transparent;
    }
    .ma-msg {
      padding: 9px 13px; border-radius: 12px;
      font-size: 13px; line-height: 1.5; max-width: 92%;
      animation: maMsg .16s ease;
    }
    @keyframes maMsg {
      from { transform: translateY(5px); opacity: 0; }
      to   { transform: translateY(0);   opacity: 1; }
    }
    .ma-assistant {
      background: rgba(255,255,255,.055);
      border: 1px solid rgba(255,255,255,.08);
      color: #e2e8f0; align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .ma-user {
      background: linear-gradient(135deg,#1d4ed8,#4c1d95);
      color: #fff; align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .ma-system {
      background: rgba(99,102,241,.1);
      border: 1px solid rgba(99,102,241,.2);
      color: #a5b4fc; align-self: center; font-size: 11px;
      text-align: center; padding: 4px 12px; border-radius: 20px;
    }
    /* Answer mode — informational response */
    .ma-answer {
      background: rgba(96,165,250,.08);
      border: 1px solid rgba(96,165,250,.2);
      color: #bfdbfe; align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    /* Plan mode — multi-step list */
    .ma-plan {
      background: rgba(167,139,250,.08);
      border: 1px solid rgba(167,139,250,.2);
      color: #ddd6fe; align-self: flex-start;
      border-bottom-left-radius: 4px;
      padding: 10px 13px;
    }
    .ma-plan ol {
      margin: 6px 0 0 16px; padding: 0;
      font-size: 12.5px; line-height: 1.6;
    }
    .ma-badge {
      font-size: 12px; padding: 8px 12px; border-radius: 9px;
      display: flex; flex-direction: column; gap: 3px; align-self: stretch;
      line-height: 1.45; animation: maMsg .16s ease;
    }
    .ma-badge code {
      font-family: monospace; font-size: 11px;
      background: rgba(255,255,255,.07); padding: 1px 4px; border-radius: 3px;
    }
    .ma-badge-ok {
      background: rgba(34,197,94,.08);
      border: 1px solid rgba(34,197,94,.2); color: #86efac;
    }
    .ma-badge-err {
      background: rgba(239,68,68,.08);
      border: 1px solid rgba(239,68,68,.2); color: #fca5a5;
    }
    .ma-reasoning { font-size: 10.5px; color: #64748b; margin-top: 2px; }

    /* Loading dots */
    .ma-loading {
      display: flex; align-items: center; gap: 5px;
      padding: 11px 13px !important;
    }
    .ma-loading span {
      width: 6px; height: 6px; border-radius: 50%;
      background: #60a5fa; animation: maDot 1.2s ease infinite;
    }
    .ma-loading span:nth-child(2) { animation-delay: .2s; }
    .ma-loading span:nth-child(3) { animation-delay: .4s; }
    @keyframes maDot {
      0%,80%,100% { transform: scale(.75); opacity: .4; }
      40%         { transform: scale(1.2);  opacity: 1; }
    }

    /* Input */
    #ma-input-row {
      display: flex; align-items: center; gap: 7px;
      padding: 10px 12px;
      border-top: 1px solid rgba(255,255,255,.06);
      background: rgba(255,255,255,.015);
    }
    #ma-input {
      flex: 1; background: rgba(255,255,255,.07);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 10px; color: #e2e8f0;
      font-size: 13px; padding: 8px 12px; outline: none;
      transition: border-color .2s; font-family: inherit;
    }
    #ma-input::placeholder { color: #334155; }
    #ma-input:focus { border-color: rgba(96,165,250,.45); }
    #ma-input:disabled { opacity: .35; cursor: not-allowed; }
    #ma-send {
      width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0;
      background: linear-gradient(135deg,#3b82f6,#6366f1);
      border: none; color: #fff; font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .2s, transform .1s;
    }
    #ma-send:hover { transform: scale(1.07); }
    #ma-send:active { transform: scale(.93); }
    #ma-send:disabled { opacity: .35; cursor: not-allowed; transform: none; }
  `;

  const UI_HTML = `
    <div id="ma-pill">
      <div id="ma-pulse"></div>
      <div id="ma-indicator" title="MoodAgent">😌</div>
      <div id="ma-info">
        <span id="ma-mood-label">Calm</span>
        <div id="ma-score-row">
          <span id="ma-score">0</span>
          <span class="ma-unit">pts</span>
        </div>
      </div>
      <button id="ma-toggle" title="Toggle assistant">💬</button>
    </div>

    <div id="ma-assistant" role="dialog" aria-label="MoodAgent Assistant">
      <div id="ma-header">
        <span id="ma-header-title">⚡ MoodAgent</span>
        <button id="ma-fullpage" class="ma-open-full" title="Open the full assistant workspace">Full Page</button>
        <button class="ma-hbtn" id="ma-settings-btn" title="Settings">⚙️</button>
        <button class="ma-hbtn" id="ma-close" title="Close">✕</button>
      </div>

      <div id="ma-settings">
        <label for="ma-provider">Assistant Mode</label>
        <select id="ma-provider" name="ma-provider">
          <option value="ollama">Ollama</option>
          <option value="gemini">Gemini</option>
        </select>
        <label for="ma-apikey">Gemini API Key</label>
        <input type="password" id="ma-apikey" name="ma-apikey"
          placeholder="AIzaSy..." autocomplete="off" spellcheck="false" />
        <label for="ma-ollama-url">Ollama Base URL</label>
        <input type="text" id="ma-ollama-url" name="ma-ollama-url"
          placeholder="http://127.0.0.1:11435" autocomplete="off" spellcheck="false" />
        <label for="ma-ollama-model">Ollama Model</label>
        <input type="text" id="ma-ollama-model" name="ma-ollama-model"
          placeholder="llama3.2:3b" autocomplete="off" spellcheck="false" />
        <div id="ma-settings-row">
          <button id="ma-save-settings">Save Settings</button>
        </div>
        <span id="ma-settings-note">Stored locally in chrome.storage.local — never sent anywhere except Gemini</span>
      </div>

      <div id="ma-messages" role="log" aria-live="polite"></div>

      <div id="ma-input-row">
        <input type="text" id="ma-input" name="ma-input"
          placeholder="What should I do on this page?"
          disabled autocomplete="off" spellcheck="false" />
        <button id="ma-send" title="Send (Enter)" disabled>↑</button>
      </div>
    </div>
  `;

  // ══════════════════════════════════════════════════════════
  // SECTION 1 — TELEMETRY ENGINE
  // ══════════════════════════════════════════════════════════

  const _cooldowns = {};
  const COOLDOWN_MS = 3000;

  function _cooled(type) {
    const now = Date.now();
    return !_cooldowns[type] || (now - _cooldowns[type]) >= COOLDOWN_MS;
  }

  // Centralized Dispatcher — ALL telemetry goes through here
  function dispatchTelemetry(eventType, scoreDelta, context = {}) {
    if (!_cooled(eventType)) return;
    _cooldowns[eventType] = Date.now();
    safeSendRuntimeMessage({
      action: 'TELEMETRY_EVENT',
      payload: { eventType, scoreDelta, context, timestamp: Date.now(), url: location.href }
    });
  }

  function dist2D(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  // 1a. Rage Click: >=3 clicks, each dt<500ms AND d<30px, total<=1000ms
  let _clicks = [];
  document.addEventListener('click', (e) => {
    const now = Date.now();
    const pt = { x: e.clientX, y: e.clientY, t: now };
    _clicks = _clicks.filter(c => now - c.t <= 1000);
    _clicks.push(pt);
    if (_clicks.length < 3) return;
    const w = _clicks.slice(-3);
    if (w.at(-1).t - w[0].t > 1000) return;
    let ok = true;
    for (let i = 1; i < w.length; i++) {
      if (w[i].t - w[i-1].t >= 500 || dist2D(w[i], w[i-1]) >= 30) { ok = false; break; }
    }
    if (ok) { _clicks = []; dispatchTelemetry('RAGE_CLICK', 10, { x: pt.x, y: pt.y }); }
  }, true);

  // 1b. Backspace Frustration: >5 backspaces in 3s on input
  let _bsTs = [];
  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    const isInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (!isInput || (e.key !== 'Backspace' && e.key !== 'Delete')) return;
    const now = Date.now();
    _bsTs.push(now);
    _bsTs = _bsTs.filter(t => now - t <= 3000);
    if (_bsTs.length > 5) { _bsTs = []; dispatchTelemetry('BACKSPACE_FRUSTRATION', 8, {}); }
  }, true);

  // 1c. Scroll Thrash: V>2000px/s + >=3 reversals/5s + no pause>1000ms
  let _lastSY = scrollY, _lastST = Date.now(), _lastDir = 0, _sReversals = 0, _sEvts = [], _sThrottle = 0;
  window.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - _sThrottle < 150) return;
    _sThrottle = now;
    const dy = scrollY - _lastSY, dt = now - _lastST;
    if (!dt) return;
    const vel = Math.abs(dy / (dt / 1000));
    const dir = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    if (dir && dir !== _lastDir && _lastDir) _sReversals++;
    const gap = now - _lastST;
    _sEvts.push({ t: now, vel, dir, gap });
    _sEvts = _sEvts.filter(s => now - s.t <= 5000);
    if (vel > 2000 && _sReversals >= 3 && !_sEvts.some(s => s.gap > 1000)) {
      _sReversals = 0; _sEvts = [];
      dispatchTelemetry('SCROLL_THRASH', 15, { vel: Math.round(vel) });
    }
    _lastSY = scrollY; _lastST = now; _lastDir = dir;
  }, { passive: true });

  // 1d. Boredom Scroll: continuous >4s
  let _scrollStart = null, _scrollStop = null;
  window.addEventListener('scroll', () => {
    if (!_scrollStart) _scrollStart = Date.now();
    clearTimeout(_scrollStop);
    _scrollStop = setTimeout(() => {
      if (_scrollStart && Date.now() - _scrollStart >= 4000)
        dispatchTelemetry('BOREDOM_SCROLL', 5, { ms: Date.now() - _scrollStart });
      _scrollStart = null;
    }, 500);
  }, { passive: true });

  // 1e. Erratic Mouse: path/displacement > 5
  let _mEvts = [], _mThrottle = 0;
  document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - _mThrottle < 50) return;
    _mThrottle = now;
    _mEvts.push({ x: e.clientX, y: e.clientY, t: now });
    _mEvts = _mEvts.filter(m => now - m.t <= 2000);
    if (_mEvts.length < 5) return;
    let path = 0;
    for (let i = 1; i < _mEvts.length; i++) path += dist2D(_mEvts[i], _mEvts[i-1]);
    const disp = dist2D(_mEvts[0], _mEvts.at(-1));
    if (disp < 10) return;
    if (path / disp > 5) { _mEvts = []; dispatchTelemetry('ERRATIC_MOVEMENT', 5, { ratio: (path/disp).toFixed(1) }); }
  }, { passive: true });


  // ══════════════════════════════════════════════════════════
  // SECTION 2 — DOM SCRAPER  (The Eyes)
  // ══════════════════════════════════════════════════════════

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
  }

  function buildSelector(el) {
    // 1. Unique non-numeric id
    if (el.id && !/^\d|:/.test(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(_) {}
    }
    // 2. data-testid
    const testid = el.getAttribute('data-testid');
    if (testid) {
      const sel = `[data-testid="${CSS.escape(testid)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(_) {}
    }
    // 3. aria-label + tag
    const aria = el.getAttribute('aria-label');
    if (aria) {
      const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(_) {}
    }
    // 4. name attribute
    const name = el.getAttribute('name');
    if (name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(_) {}
    }
    // 5. Walk up the DOM tree (max 4 levels)
    const parts = [];
    let node = el;
    for (let d = 0; d < 4 && node && node !== document.body; d++) {
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
        : [];
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      const partial = parts.join(' > ');
      try { if (document.querySelectorAll(partial).length === 1) return partial; } catch(_) {}
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // ── CHANGE 6: getInteractiveElements — richer semantic context ────────────
  function getInteractiveElements() {
    const Q = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="searchbox"], [contenteditable="true"]';
    const results = [];
    for (const el of document.querySelectorAll(Q)) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();

      const placeholder = el.getAttribute('placeholder') || undefined;
      const ariaLabel   = el.getAttribute('aria-label') || undefined;
      const nameAttr    = el.getAttribute('name') || undefined;
      const titleAttr   = el.getAttribute('title') || undefined;
      const inputType   = el.getAttribute('type') || undefined;
      const roleAttr    = el.getAttribute('role') || undefined;

      // Derive nearby text from parent label or sibling
      let nearbyText = '';
      const parentLabel = el.closest('label');
      if (parentLabel) {
        nearbyText = parentLabel.innerText?.trim().slice(0, 60) || '';
      } else {
        const prev = el.previousElementSibling;
        if (prev && ['label', 'span', 'div', 'p'].includes(prev.tagName.toLowerCase())) {
          nearbyText = prev.innerText?.trim().slice(0, 60) || '';
        }
      }

      // Detect form role
      const form = el.closest('form');
      const formRole = form ? (form.getAttribute('role') || form.getAttribute('aria-label') || form.id || 'form') : undefined;

      // Heuristic: is this a search-like input?
      const searchNames = ['q', 'query', 'search', 's', 'keyword', 'keywords'];
      const isSearchLike = !!(
        inputType === 'search' ||
        (placeholder && /search/i.test(placeholder)) ||
        (ariaLabel && /search/i.test(ariaLabel)) ||
        (nameAttr && searchNames.includes(nameAttr.toLowerCase())) ||
        roleAttr === 'searchbox'
      );

      const text = (
        el.innerText?.trim() ||
        placeholder ||
        ariaLabel ||
        el.getAttribute('value') ||
        titleAttr ||
        nameAttr ||
        inputType ||
        tag
      ).slice(0, 80);

      results.push({
        tag,
        type: inputType,
        role: roleAttr,
        text,
        placeholder,
        ariaLabel,
        name: nameAttr,
        title: titleAttr,
        nearbyText: nearbyText || undefined,
        formRole,
        isSearchLike: isSearchLike || undefined,
        inputType,
        selector: buildSelector(el),
        href: tag === 'a' ? el.getAttribute('href')?.slice(0, 120) : undefined,
      });

      if (results.length >= 75) break;
    }
    return results;
  }

  // ── CHANGE 7: getPageUnderstandingContext — page text scraper ─────────────
  function getPageUnderstandingContext() {
    function pushTextChunks(target, rawText, { minLen = 10, maxLen = 300 } = {}) {
      String(rawText || '')
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length >= minLen && line.length <= maxLen)
        .forEach((line) => target.push(line));
    }

    function pushDocsEditorText(target) {
      const seen = new Set();
      const pushUnique = (rawText, options = {}) => {
        const before = target.length;
        pushTextChunks(target, rawText, options);
        for (let i = before; i < target.length; i++) {
          const line = target[i];
          if (seen.has(line)) {
            target.splice(i, 1);
            i--;
            continue;
          }
          seen.add(line);
        }
      };

      const docsRootSelectors = [
        '[role="textbox"]',
        '.kix-appview-editor',
        '.kix-page',
        '.kix-page-content-wrapper',
        '.docs-title-input-label-inner',
      ];

      docsRootSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          pushUnique(el.innerText || el.textContent || '', { minLen: 3, maxLen: 500 });
          const ariaLabel = el.getAttribute?.('aria-label');
          if (ariaLabel && ariaLabel.length > 20) {
            pushUnique(ariaLabel, { minLen: 3, maxLen: 500 });
          }
        });
      });

      const textNodeSelectors = [
        '.kix-wordhtmlgenerator-word-node',
        '.kix-lineview-text-block',
        '.kix-lineview-content',
        '.kix-lineview',
        '.kix-paragraphrenderer',
      ];

      textNodeSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          pushUnique(el.textContent || el.innerText || '', { minLen: 1, maxLen: 500 });
        });
      });

      if (!target.length) {
        const bodyText = (document.body?.innerText || '')
          .split(/\n+/)
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter((line) => line.length >= 10)
          .filter((line) => !/^(file|edit|view|insert|format|tools|extensions|help|share|100%|normal text|arial)$/i.test(line))
          .slice(0, 80)
          .join('\n');
        pushUnique(bodyText, { minLen: 10, maxLen: 500 });
      }
    }

    // Headings
    const headings = [];
    document.querySelectorAll('h1,h2,h3').forEach(h => {
      const t = h.innerText?.trim();
      if (t) headings.push(`${h.tagName}: ${t.slice(0, 100)}`);
    });

    // Visible paragraphs / list items / card-like blocks
    const textBlocks = [];
    const textSelectors = 'p, li, [class*="card"] [class*="title"], [class*="product"] [class*="name"], [class*="item"] [class*="title"]';
    document.querySelectorAll(textSelectors).forEach(el => {
      if (!isVisible(el)) return;
      pushTextChunks(textBlocks, el.innerText);
    });

    // Rich editors like Google Docs often render content outside normal <p>/<li> flow.
    const shouldScanEditorText =
      /docs\.google\.com$/i.test(location.hostname) ||
      textBlocks.length < 5;
    if (shouldScanEditorText) {
      if (/docs\.google\.com$/i.test(location.hostname)) {
        pushDocsEditorText(textBlocks);
      } else {
        const editorSelectors = [
          '[role="textbox"]',
          '[contenteditable="true"]',
          '.kix-wordhtmlgenerator-word-node',
          '.kix-lineview',
          '.kix-lineview-content',
          '.kix-paragraphrenderer',
          '.docs-title-input-label-inner',
        ].join(', ');

        document.querySelectorAll(editorSelectors).forEach(el => {
          const text = el.innerText || el.textContent || '';
          if (!text.trim()) return;
          pushTextChunks(textBlocks, text, { minLen: 3, maxLen: 500 });
        });
      }
    }

    if (!headings.length) {
      textBlocks
        .filter((line) => line.length <= 120)
        .filter((line) => /^[A-Z][A-Z\s0-9-]{2,}$/.test(line) || /^[A-Z][\w\s-]{2,40}$/.test(line))
        .slice(0, 5)
        .forEach((line) => headings.push(`TEXT: ${line}`));
    }

    // Prices (useful for product pages)
    const prices = [];
    document.querySelectorAll('[class*="price"], [class*="cost"], [itemprop="price"]').forEach(el => {
      if (!isVisible(el)) return;
      const t = el.innerText?.trim();
      if (t) prices.push(t.slice(0, 30));
    });

    // Visible button text (supplements interactive elements)
    const buttonTexts = [];
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      if (!isVisible(el)) return;
      const t = el.innerText?.trim();
      if (t) buttonTexts.push(t.slice(0, 40));
    });

    // Search candidates (for background.js prompt)
    const searchCandidates = [];
    document.querySelectorAll('input').forEach(el => {
      if (!isVisible(el)) return;
      const ph    = el.getAttribute('placeholder') || '';
      const name  = el.getAttribute('name') || '';
      const type  = el.getAttribute('type') || '';
      const aria  = el.getAttribute('aria-label') || '';
      const searchNames = ['q', 'query', 'search', 's', 'keyword', 'keywords'];
      if (
        type === 'search' ||
        /search/i.test(ph) ||
        /search/i.test(aria) ||
        searchNames.includes(name.toLowerCase())
      ) {
        searchCandidates.push({ selector: buildSelector(el), placeholder: ph || aria || name });
      }
    });

    // Combine text blocks into a summary (cap to keep prompt size manageable)
    const visibleText = [...new Set(textBlocks)].slice(0, 40).join(' | ').slice(0, 2200);

    return {
      headings: headings.slice(0, 15),
      visibleText,
      prices: prices.slice(0, 10),
      buttonTexts: [...new Set(buttonTexts)].slice(0, 15),
      searchCandidates,
    };
  }


  // ══════════════════════════════════════════════════════════
  // SECTION 3 — ACTION EXECUTOR  (The Hands)
  // ══════════════════════════════════════════════════════════

  // ── CHANGE 8: executeAgentAction — adds keypress, focus, submit ───────────
  function executeAgentAction(actionObj) {
    if (!actionObj || !actionObj.action) return { ok: false, error: 'No action provided' };
    const { action, selector, value } = actionObj;

    function resolveEl(sel) {
      if (!sel) return null;
      try {
        const all = [...document.querySelectorAll(sel)];
        return all.find(isVisible) || all[0] || null;
      } catch (_) { return null; }
    }

    function submitElement(el) {
      const evtProps = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', evtProps));
      el.dispatchEvent(new KeyboardEvent('keypress', evtProps));
      el.dispatchEvent(new KeyboardEvent('keyup', evtProps));

      const form = el.closest('form');
      if (form) {
        try {
          form.requestSubmit();
        } catch (_) {
          form.submit();
        }
        return 'form';
      }

      const searchButton = document.querySelector(
        'button[type="submit"], input[type="submit"], button[aria-label*="search" i], [role="button"][aria-label*="search" i]'
      );
      if (searchButton && isVisible(searchButton)) {
        searchButton.click();
        return 'button';
      }

      return 'keyboard';
    }

    if (action === 'click') {
      const el = resolveEl(selector);
      if (!el) return { ok: false, error: `No element found for: "${selector}"` };
      el.focus();
      el.click();
      return { ok: true, action: 'click', tag: el.tagName.toLowerCase() };
    }

    if (action === 'type') {
      const el = resolveEl(selector);
      if (!el) return { ok: false, error: `No element found for: "${selector}"` };
      el.focus();
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(el, value ?? '');
      } else if (el.isContentEditable) {
        el.textContent = value ?? '';
      } else {
        el.value = value ?? '';
      }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
      if (actionObj.autoSubmit) {
        const submittedVia = submitElement(el);
        return { ok: true, action: 'type', value, autoSubmit: true, submittedVia };
      }
      return { ok: true, action: 'type', value };
    }

    if (action === 'keypress') {
      const el = resolveEl(selector);
      if (!el) return { ok: false, error: `No element found for: "${selector}"` };
      el.focus();
      const key   = value || 'Enter';
      const code  = key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`;
      const keyCode = key === 'Enter' ? 13 : key.charCodeAt(0);
      const evtProps = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown',  evtProps));
      el.dispatchEvent(new KeyboardEvent('keypress', evtProps));
      el.dispatchEvent(new KeyboardEvent('keyup',    evtProps));
      // If Enter on a form input, also try submitting the parent form
      if (key === 'Enter') {
        const form = el.closest('form');
        if (form) {
          try { form.requestSubmit(); } catch (_) { form.submit(); }
        }
      }
      return { ok: true, action: 'keypress', key };
    }

    if (action === 'focus') {
      const el = resolveEl(selector);
      if (!el) return { ok: false, error: `No element found for: "${selector}"` };
      el.focus();
      return { ok: true, action: 'focus' };
    }

    if (action === 'submit') {
      const el = resolveEl(selector);
      if (!el) return { ok: false, error: `No element found for: "${selector}"` };
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (form) {
        try { form.requestSubmit(); } catch (_) { form.submit(); }
        return { ok: true, action: 'submit' };
      }
      el.click();
      return { ok: true, action: 'submit', fallback: 'click' };
    }

    if (action === 'scroll') {
      window.scrollTo({ top: parseInt(value) || 0, behavior: 'smooth' });
      return { ok: true, action: 'scroll' };
    }

    if (action === 'navigate') {
      if (value) { location.href = value; }
      return { ok: true, action: 'navigate', value };
    }

    return { ok: false, error: `Unknown action: "${action}"` };
  }


  // ══════════════════════════════════════════════════════════
  // SECTION 4 — MESSAGE BUS  (background.js → content.js)
  // ══════════════════════════════════════════════════════════

  // ── CHANGE 9: message bus — adds AGENT_ANSWER, AGENT_PLAN, DOM snapshot ──
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'STATE_UPDATE') {
      window.__maUI?.updateState(msg);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'OPEN_FULL_ASSISTANT_PANEL') {
      window.__maUI?.showPanel();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'AGENT_RESULT') {
      const result = executeAgentAction(msg.payload);
      window.__maUI?.onActionResult(result, msg.payload);
      sendResponse({ ok: true, result });
      return true;
    }

    if (msg.action === 'AGENT_REPLY') {
      window.__maUI?.onAgentReply(msg.payload.message, msg.payload._meta);
      sendResponse({ ok: true });
      return true;
    }

    // New: answer mode (informational response)
    if (msg.action === 'AGENT_ANSWER') {
      window.__maUI?.onAgentAnswer(msg.payload.message, msg.payload._meta);
      sendResponse({ ok: true });
      return true;
    }

    // New: plan mode (multi-step list)
    if (msg.action === 'AGENT_PLAN') {
      window.__maUI?.onAgentPlan(msg.payload.steps, msg.payload.message, msg.payload._meta);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'AGENT_ERROR') {
      window.__maUI?.onAgentError(msg.payload.error);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'AGENT_LOADING') {
      window.__maUI?.setLoading(msg.payload.loading);
      sendResponse({ ok: true });
      return true;
    }

    // New: background requests a fresh DOM snapshot for agentic re-scrape
    if (msg.action === 'REQUEST_DOM_SNAPSHOT') {
      sendResponse({
        domElements: getInteractiveElements(),
        pageContext:  getPageUnderstandingContext(),
        url:   location.href,
        title: document.title,
      });
      return true;
    }

    sendResponse({ ok: false });
    return true;
  });


  // ══════════════════════════════════════════════════════════
  // SECTION 5 — SHADOW DOM UI
  // ══════════════════════════════════════════════════════════

  function bootUI() {
    if (document.getElementById('__mood-agent-host')) return;

    const host = document.createElement('div');
    host.id = '__mood-agent-host';
    host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = UI_STYLES;
    shadow.appendChild(styleEl);

    const root = document.createElement('div');
    root.id = 'ma-root';
    root.innerHTML = UI_HTML;
    root.style.pointerEvents = 'auto';
    shadow.appendChild(root);

    // ── DOM refs ─────────────────────────────────────────
    const $ = (id) => shadow.getElementById(id);
    const indicator    = $('ma-indicator');
    const moodLabel    = $('ma-mood-label');
    const scoreEl      = $('ma-score');
    const pulseRing    = $('ma-pulse');
    const panel        = $('ma-assistant');
    const messages     = $('ma-messages');
    const input        = $('ma-input');
    const sendBtn      = $('ma-send');
    const closeBtn     = $('ma-close');
    const toggleBtn    = $('ma-toggle');
    const fullPageBtn  = $('ma-fullpage');
    const providerSelect = $('ma-provider');
    const apiKeyInput  = $('ma-apikey');
    const ollamaUrlInput = $('ma-ollama-url');
    const ollamaModelInput = $('ma-ollama-model');
    const saveSettingsBtn = $('ma-save-settings');
    const settingsBtn  = $('ma-settings-btn');
    const settingsPane = $('ma-settings');

    let panelOpen = false, settingsOpen = false, currentMood = 'Calm';
    let savedGeminiApiKey = '';
    let lastProviderNotice = '';
    let didLoseExtensionContext = false;
    let pendingAssistantTimeout = 0;
    const saveKeyBtn = { addEventListener: () => {} };

    function handleExtensionContextInvalidated() {
      if (didLoseExtensionContext) return;
      didLoseExtensionContext = true;
      clearPendingAssistantTimeout();
      setLoadingUI(false);
      shadow.querySelectorAll('input, select, button, textarea').forEach((el) => {
        if (!['ma-close', 'ma-toggle'].includes(el.id)) el.disabled = true;
      });
      addMsg('system', 'MoodAgent was reloaded. Refresh this tab to reconnect the assistant.');
    }

    function maskApiKey(value) {
      return value ? '****' + value.slice(-4) : '';
    }

    function normalizeProvider(value) {
      return ['gemini', 'ollama'].includes(value) ? value : DEFAULT_AI_PROVIDER;
    }

    function normalizeOllamaUrl(value) {
      const trimmed = (value || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
      if (trimmed === 'http://127.0.0.1:11434' || trimmed === 'http://localhost:11434') {
        return DEFAULT_OLLAMA_BASE_URL;
      }
      return trimmed || DEFAULT_OLLAMA_BASE_URL;
    }

    function maybeShowProviderNotice(meta) {
      if (!meta) return;
      const message = meta.fallbackMessage
        || (meta.provider === 'ollama'
          ? `Running with local Ollama${meta.model ? ` (${meta.model})` : ''}.`
          : '');
      if (!message || message === lastProviderNotice) return;
      lastProviderNotice = message;
      addMsg('system', message);
    }

    const MOOD_CFG = {
      Calm:       { emoji: '😌', color: '#22c55e', ring: '#16a34a' },
      Bored:      { emoji: '😴', color: '#a78bfa', ring: '#7c3aed' },
      Anxious:    { emoji: '😰', color: '#f59e0b', ring: '#d97706' },
      Frustrated: { emoji: '😤', color: '#f97316', ring: '#ea580c' },
      Angry:      { emoji: '🤬', color: '#ef4444', ring: '#dc2626' },
    };

    // ── Load saved key ────────────────────────────────────
    safeStorageLocalGet(['aiProvider', 'geminiApiKey', 'ollamaBaseUrl', 'ollamaModel'], (r) => {
      providerSelect.value = normalizeProvider(r.aiProvider);
      savedGeminiApiKey = r.geminiApiKey || '';
      ollamaUrlInput.value = normalizeOllamaUrl(r.ollamaBaseUrl);
      ollamaModelInput.value = (r.ollamaModel || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
      if (savedGeminiApiKey) apiKeyInput.value = maskApiKey(savedGeminiApiKey);
      if (r.geminiApiKey) apiKeyInput.value = '••••' + r.geminiApiKey.slice(-4);
    }, { onInvalidated: handleExtensionContextInvalidated });

    saveKeyBtn.addEventListener('click', () => {
      const raw = apiKeyInput.value.trim();
      if (!raw || raw.startsWith('•')) return;
      safeStorageLocalSet({ geminiApiKey: raw }, () => {
        apiKeyInput.value = '••••' + raw.slice(-4);
        addMsg('system', '✅ API key saved securely.');
        settingsPane.classList.remove('visible');
        settingsOpen = false;
      }, { onInvalidated: handleExtensionContextInvalidated });
    });

    saveSettingsBtn.addEventListener('click', () => {
      const provider = normalizeProvider(providerSelect.value);
      const raw = apiKeyInput.value.trim();
      const geminiApiKey = (!raw || raw.startsWith('*') || raw.startsWith('â')) ? savedGeminiApiKey : raw;
      const ollamaBaseUrl = normalizeOllamaUrl(ollamaUrlInput.value);
      const ollamaModel = (ollamaModelInput.value || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;

      safeStorageLocalSet({ aiProvider: provider, geminiApiKey, ollamaBaseUrl, ollamaModel }, () => {
        savedGeminiApiKey = geminiApiKey;
        apiKeyInput.value = maskApiKey(savedGeminiApiKey);
        ollamaUrlInput.value = ollamaBaseUrl;
        ollamaModelInput.value = ollamaModel;
        addMsg('system', `Settings saved. Mode: ${provider}.`);
        settingsPane.classList.remove('visible');
        settingsOpen = false;
      }, { onInvalidated: handleExtensionContextInvalidated });
    });

    const saveSettingsControl = saveSettingsBtn.cloneNode(true);
    saveSettingsBtn.replaceWith(saveSettingsControl);
    saveSettingsControl.addEventListener('click', () => {
      const provider = normalizeProvider(providerSelect.value);
      const raw = apiKeyInput.value.trim();
      const geminiApiKey = (!raw || raw === maskApiKey(savedGeminiApiKey))
        ? savedGeminiApiKey
        : raw;
      const ollamaBaseUrl = normalizeOllamaUrl(ollamaUrlInput.value);
      const ollamaModel = (ollamaModelInput.value || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;

      safeStorageLocalSet({ aiProvider: provider, geminiApiKey, ollamaBaseUrl, ollamaModel }, () => {
        savedGeminiApiKey = geminiApiKey;
        apiKeyInput.value = maskApiKey(savedGeminiApiKey);
        ollamaUrlInput.value = ollamaBaseUrl;
        ollamaModelInput.value = ollamaModel;
        addMsg('system', `Settings saved. Mode: ${provider}.`);
        settingsPane.classList.remove('visible');
        settingsOpen = false;
      }, { onInvalidated: handleExtensionContextInvalidated });
    });

    settingsBtn.addEventListener('click', () => {
      settingsOpen = !settingsOpen;
      settingsPane.classList.toggle('visible', settingsOpen);
    });

    // ── Mood indicator update ─────────────────────────────
    function updateMoodUI(mood, score) {
      currentMood = mood || 'Calm';
      const cfg = MOOD_CFG[currentMood] || MOOD_CFG.Calm;
      indicator.textContent = cfg.emoji;
      indicator.style.setProperty('--mood-color', cfg.color);
      pulseRing.style.setProperty('--ring-color', cfg.ring);
      moodLabel.textContent = currentMood;
      scoreEl.textContent = score ?? 0;
      pulseRing.classList.toggle('pulsing', ['Anxious','Frustrated','Angry'].includes(currentMood));
    }

    // ── Panel management ──────────────────────────────────
    function openPanel() {
      panelOpen = true;
      panel.classList.add('visible');
      input.disabled = false;
      sendBtn.disabled = false;
      setTimeout(() => input.focus(), 50);
      if (messages.children.length === 0) addMsg('assistant', getGreeting(currentMood));
    }
    function closePanel() {
      panelOpen = false;
      panel.classList.remove('visible');
    }
    function launchStandaloneAssistant() {
      safeSendRuntimeMessage({ action: 'OPEN_STANDALONE_ASSISTANT' }, {
        onInvalidated: handleExtensionContextInvalidated,
        onError: () => addMsg('system', 'Could not open the full assistant. Try reopening the extension.'),
      }).catch(() => {
        addMsg('system', 'Could not open the full assistant. Try reopening the extension.');
      });
    }
    function getGreeting(mood) {
      return {
        Anxious:    "I noticed some friction — I'm here. Ask me anything about this page or tell me what to do.",
        Frustrated: "Let me help. I can explain what's on this page or take action for you.",
        Angry:      "I've got you. Ask me anything — I can explain, summarize, or act on this page.",
      }[mood] || "Hi! Ask me what's on this page, or tell me what you'd like me to do.";
    }

    // ── Chat helpers ──────────────────────────────────────
    function addMsg(role, text) {
      const el = document.createElement('div');
      el.className = `ma-msg ma-${role}`;
      el.textContent = text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }

    function clearPendingAssistantTimeout() {
      if (!pendingAssistantTimeout) return;
      clearTimeout(pendingAssistantTimeout);
      pendingAssistantTimeout = 0;
    }

    function startPendingAssistantTimeout() {
      clearPendingAssistantTimeout();
      pendingAssistantTimeout = window.setTimeout(() => {
        pendingAssistantTimeout = 0;
        setLoadingUI(false);
        addMsg('assistant', 'The assistant did not respond. Check whether Ollama or Gemini is configured, then try again.');
      }, 20000);
    }

    // ── CHANGE 10: New distinct renderers for answer and plan modes ───────────
    function addAnswerMsg(text, meta) {
      const el = document.createElement('div');
      el.className = 'ma-msg ma-answer';
      el.textContent = text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }

    function addPlanMsg(steps, intro, meta) {
      const el = document.createElement('div');
      el.className = 'ma-plan';
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;color:#a78bfa;font-weight:700;margin-bottom:4px;';
      header.textContent = intro || '📋 Here is my plan:';
      el.appendChild(header);
      const ol = document.createElement('ol');
      (steps || []).forEach(step => {
        const li = document.createElement('li');
        li.textContent = step;
        ol.appendChild(li);
      });
      el.appendChild(ol);
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }

    function addActionBadge(result, actionObj) {
      const el = document.createElement('div');
      el.className = 'ma-badge ' + (result.ok ? 'ma-badge-ok' : 'ma-badge-err');
      const icon = result.ok ? '✅' : '❌';
      let label = '';
      if (result.ok) {
        if (actionObj.action === 'click') {
          label = `Clicked: <code>${actionObj.selector}</code>`;
        } else if (actionObj.action === 'type') {
          label = actionObj.autoSubmit
            ? `Typed "${(actionObj.value || '').slice(0,40)}" and submitted <code>${actionObj.selector}</code>`
            : `Typed "${(actionObj.value || '').slice(0,40)}" into <code>${actionObj.selector}</code>`;
        } else if (actionObj.action === 'keypress') {
          label = `Pressed <code>${actionObj.value || 'Enter'}</code> on <code>${actionObj.selector}</code>`;
        } else if (actionObj.action === 'focus') {
          label = `Focused: <code>${actionObj.selector}</code>`;
        } else if (actionObj.action === 'submit') {
          label = `Submitted form via <code>${actionObj.selector}</code>`;
        } else {
          label = `Done: ${actionObj.action}`;
        }
      } else {
        label = result.error || 'Unknown error';
      }
      el.innerHTML = `<span>${icon} ${label}</span>`;
      if (result.ok && actionObj.reasoning) {
        const note = document.createElement('div');
        note.className = 'ma-reasoning';
        note.textContent = '↳ ' + actionObj.reasoning;
        el.appendChild(note);
      }
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }

    // ── Loading indicator ─────────────────────────────────
    function setLoadingUI(loading) {
      sendBtn.disabled = loading;
      input.disabled = loading;
      sendBtn.textContent = loading ? '…' : '↑';
      const existing = shadow.getElementById('ma-loader');
      if (loading && !existing) {
        const loader = document.createElement('div');
        loader.id = 'ma-loader';
        loader.className = 'ma-msg ma-assistant ma-loading';
        loader.innerHTML = '<span></span><span></span><span></span>';
        messages.appendChild(loader);
        messages.scrollTop = messages.scrollHeight;
      } else if (!loading && existing) {
        existing.remove();
      }
    }

    // ── CHANGE 7 cont: sendQuery — includes pageContext ───────────────────────
    function sendQuery() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMsg('user', text);
      setLoadingUI(true);
      startPendingAssistantTimeout();

      const domElements = getInteractiveElements();
      const pageContext  = getPageUnderstandingContext();

      safeSendRuntimeMessage({
        action: 'ASSISTANT_QUERY',
        payload: { text, domElements, pageContext, url: location.href, title: document.title }
      }, {
        onInvalidated: handleExtensionContextInvalidated,
        onError: () => {
          clearPendingAssistantTimeout();
          setLoadingUI(false);
          addMsg('assistant', 'Could not reach background service. Try reloading the page.');
        }
      }).then((response) => {
        if (response?.ok === false) {
          clearPendingAssistantTimeout();
          setLoadingUI(false);
          addMsg('assistant', response.error || 'The assistant request could not be started.');
        }
      }).catch(() => {
        clearPendingAssistantTimeout();
        setLoadingUI(false);
        addMsg('assistant', 'Could not reach background service. Try reloading the page.');
      });
    }

    // ── Event listeners ───────────────────────────────────
    sendBtn.addEventListener('click', sendQuery);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuery(); }
    });
    closeBtn.addEventListener('click', closePanel);
    toggleBtn.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
    indicator.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
    fullPageBtn.addEventListener('click', launchStandaloneAssistant);

    // ── Public API (called by message listener above) ─────
    window.__maUI = {
      updateState({ mood, score, triggerAssistant }) {
        updateMoodUI(mood, score);
        if (triggerAssistant && !panelOpen) openPanel();
      },
      showPanel() {
        if (!panelOpen) {
          openPanel();
          return;
        }
        setTimeout(() => input.focus(), 50);
      },
      setLoading(on) {
        if (!on) clearPendingAssistantTimeout();
        setLoadingUI(on);
      },
      onActionResult(result, actionObj) {
        clearPendingAssistantTimeout();
        setLoadingUI(false);
        input.disabled = false;
        sendBtn.disabled = false;
        maybeShowProviderNotice(actionObj._meta);
        addActionBadge(result, actionObj);
        setTimeout(() => input.focus(), 50);
      },
      onAgentReply(text, meta) {
        clearPendingAssistantTimeout();
        setLoadingUI(false);
        input.disabled = false;
        sendBtn.disabled = false;
        maybeShowProviderNotice(meta);
        addMsg('assistant', text);
        setTimeout(() => input.focus(), 50);
      },
      // New: answer mode handler
      onAgentAnswer(text, meta) {
        clearPendingAssistantTimeout();
        setLoadingUI(false);
        input.disabled = false;
        sendBtn.disabled = false;
        maybeShowProviderNotice(meta);
        addAnswerMsg(text, meta);
        setTimeout(() => input.focus(), 50);
      },
      // New: plan mode handler
      onAgentPlan(steps, message, meta) {
        clearPendingAssistantTimeout();
        setLoadingUI(false);
        input.disabled = false;
        sendBtn.disabled = false;
        maybeShowProviderNotice(meta);
        addPlanMsg(steps, message, meta);
        setTimeout(() => input.focus(), 50);
      },
      onAgentError(err) {
        clearPendingAssistantTimeout();
        setLoadingUI(false);
        input.disabled = false;
        sendBtn.disabled = false;
        addMsg('assistant', `⚠️ ${err}`);
        setTimeout(() => input.focus(), 50);
      },
    };

    // ── Fetch initial state from background ───────────────
    safeSendRuntimeMessage({ action: 'GET_STATE' }, { onInvalidated: handleExtensionContextInvalidated })
      .then(r => { if (r) updateMoodUI(r.mood, r.score); })
      .catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootUI);
  } else {
    bootUI();
  }

} // end guard
