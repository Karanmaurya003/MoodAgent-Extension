# ⚡ MoodAgent — Adaptive AI Browsing Assistant

A Chrome Extension (Manifest V3) that monitors user frustration heuristics in real-time and automatically deploys an AI assistant when friction is detected.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Target Website (DOM)                                         │
│     User inputs: clicks, scrolling, keystrokes, mouse movements │
└────────────────────────┬────────────────────────────────────────┘
                         │ Telemetry Events
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. content.js (Observer & Action Executor)                      │
│     • Rage Click Detector (≥3 clicks, Δt<500ms, d<30px → +10)   │
│     • Backspace Frustration (>5 backspaces / 3s → +8)           │
│     • Scroll Thrash Detector (V>2000px/s + reversals → +15)     │
│     • Erratic Mouse (path/displacement ratio > 5 → +5)          │
│     • Boredom Scroll (continuous >4s → +5)                      │
│     • Anti-flood: 3s cooldown per event type                     │
│     • Shadow DOM UI injected (mood indicator + assistant chat)   │
└────────────────────────┬────────────────────────────────────────┘
                         │ chrome.runtime.sendMessage (TELEMETRY_EVENT)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. background.js (Service Worker — Brain / State Manager)       │
│     • Aggregates frustration score                               │
│     • Mood: Calm(0) → Anxious(15) → Frustrated(30) → Angry(50)  │
│     • Score decay: -5 pts every 10s of inactivity               │
│     • Broadcasts STATE_UPDATE to content.js                      │
│     • Mock LLM: parses user intent → JSON action                 │
└────────────────────────┬────────────────────────────────────────┘
                         │ LLM JSON Response: {action, selector, value}
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Agent Execution                                              │
│     • __moodAgentExecuteAction() in content.js                  │
│     • Resolves CSS selector → visible DOM element               │
│     • Executes: click | type | scroll                           │
│     • React/Vue compatible (native input setter + events)        │
└─────────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest — permissions, service worker, content script |
| `background.js` | Service Worker: state machine, score management, mock LLM |
| `content.js` | Observer: telemetry detectors + Shadow DOM UI + action executor |
| `popup.html` | Extension popup: live score display, reset, manual trigger |
| `popup.js` | Popup logic: state sync, event log |
| `styles.css` | Supplemental styles reference |
| `icons/` | Extension icons (16px, 48px, 128px) |

## Telemetry Rules

### Rage Click (+10 pts)
- ≥3 clicks where each pair has Δt < 500ms AND distance < 30px
- Total window must be ≤ 1000ms

### Backspace Frustration (+8 pts)
- >5 backspace/delete keypresses within a 3-second window while an input is focused

### Scroll Thrash (+15 pts)
- Scroll velocity > 2000 px/s
- ≥3 direction reversals within a 5s window
- No pause exceeding 1000ms

### Erratic Mouse (+5 pts)
- (total path distance) / (straight-line displacement) > 5
- Measured over a 2s rolling window

### Boredom Scroll (+5 pts)
- Continuous scrolling without stopping for > 4 seconds

### Decay
- Every 10s with no events: score decreases by 5 (min 0)

## Mood Thresholds

| Score | Mood | Action |
|-------|------|--------|
| 0-14 | Calm 😌 | Passive indicator |
| 15-29 | Anxious 😰 | Pulse animation |
| 30-49 | Frustrated 😤 | **Assistant auto-opens** |
| 50+ | Angry 🤬 | **Assistant auto-opens** |

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this directory
5. Visit any website — the mood indicator appears in the bottom-right corner

## Usage

- **Mood Indicator**: Always visible in the bottom-right corner showing current emotional state and score
- **Auto-trigger**: The assistant automatically opens when frustration crosses the threshold
- **Manual open**: Click the 💬 button or use the popup's "Open Assistant" button
- **Commands**: Type natural language — "search for X", "click submit", "type my name", "scroll to top"
- **Reset**: Click "Reset Score" in the popup to reset state

## Privacy

All telemetry is processed locally. No data is sent to external servers. The mock LLM runs entirely in the background service worker.
