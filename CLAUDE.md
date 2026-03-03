# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blood Pressure Tracker is a vanilla JavaScript PWA (Progressive Web App) for recording and managing daily blood pressure measurements. It supports camera capture with OCR auto-fill, Google Sheets cloud sync, and offline operation via Service Worker. No build step or package manager is used — the app runs directly in a browser.

## Running the App

```bash
# Standard HTTP (no camera support — camera requires HTTPS or localhost)
python -m http.server 8000
# → http://localhost:8000

# HTTPS with self-signed cert (enables camera on non-localhost devices)
python https_server.py
# → https://localhost:4443

# Debug mode (enables OCR test button and debug panel)
# http://localhost:8000/?debug=1
```

Service Worker only registers on HTTPS (`location.protocol === 'https:'`). During development, use `http://localhost:8000` (SW will not register) or the HTTPS server.

## Architecture

All JS files are loaded via `<script defer>` in [index.html](index.html) in this fixed dependency order:

1. **[js/constants.js](js/constants.js)** — All magic numbers and configuration objects exposed as globals: `window.PREPROCESS_DEFAULTS`, `window.OCR_CONSTANTS`, `window.GRAPH_CONSTANTS`, `window.NOTIFICATION_CONSTANTS`
2. **[js/settings.js](js/settings.js)** — Persistent user settings (notification times, member names) backed by localStorage
3. **[js/notifications.js](js/notifications.js)** — Web Notifications API wrapper (permission request, SW-based and fallback dispatch)
4. **[js/reminder.js](js/reminder.js)** — Periodic reminder scheduler using `setTimeout`
5. **[js/image-preprocess.js](js/image-preprocess.js)** — Canvas-based image processing pipeline: ROI crop → resize → grayscale → binarization (Otsu/Adaptive) → optional median filter / morphology
6. **[js/seven-segment.js](js/seven-segment.js)** — LCD 7-segment pattern recognition as an alternative/complement to Tesseract OCR
7. **[js/ocr.js](js/ocr.js)** — OCR orchestration: multi-attempt strategy (up to 24 attempts across preprocess patterns A–M × PSM modes × resolutions), early-accept threshold, timeout, self-test via `window.OCR.runExtractionSelfTest()`
8. **[js/sheets-api.js](js/sheets-api.js)** — Google Apps Script Web App client (POST to save, GET to fetch); contains the deployed `SCRIPT_URL`
9. **[js/app.js](js/app.js)** — Main application: data model, localStorage CRUD, UI rendering, Chart.js graph, CSV export, OCR result confirmation UI

External CDN dependencies (loaded before the app scripts, no `defer`):
- Chart.js 4.4.1
- Tesseract.js 5.0.3

## Key Data Flows

**Recording a measurement:**
1. User fills form (manually or via OCR auto-fill) → `app.js` validates and saves to `localStorage` (`STORAGE_KEY = 'bp_records_v1'`)
2. Record is sent to Google Sheets via `sheets-api.js`; failures mark the record as unsynced
3. Unsynced records can be retried via the "未同期を再送" button

**OCR flow (camera capture):**
1. `camera.js` captures image → user confirms → `app.js` triggers `window.OCR.recognizeText()`
2. `ocr.js` runs multi-attempt pipeline: for each attempt in `OCR_CONSTANTS.EXPLORATION_ORDER`, it calls `image-preprocess.js` then Tesseract.js
3. Score = `OCR_CONF_WEIGHT × tesseractConf + EXTRACT_WEIGHT × extractScore`; early-accept at `SCORE_EARLY_ACCEPT = 85`; total timeout `OCR_TOTAL_TIMEOUT_MS = 10000ms`
4. Result populates form fields with confidence badges; user can edit before saving

**Graph display:**
- Chart.js renders bp trend/timeband/weekday views controlled by `GRAPH_CONSTANTS`
- State (selected range, chart type, view mode) persisted to `localStorage` (`bp_graph_state_v1`)

## OCR Tuning

All OCR constants live in `js/constants.js` under `OCR_CONSTANTS`:
- `ATTEMPTS_MAX` (24) — max total attempts
- `SCORE_EARLY_ACCEPT` (85) — score to short-circuit remaining attempts
- `OCR_TOTAL_TIMEOUT_MS` (10000) — hard timeout in ms
- `CONFIDENCE_HIGH` (80) / `CONFIDENCE_MEDIUM` (60) — thresholds for badge color
- `EXPLORATION_ORDER` — priority-ordered list of `{resolution, preprocess, psm}` combos
- `PREPROCESS_PATTERNS` — patterns A–M define the image processing pipeline per attempt

To run the extraction self-test in browser console:
```javascript
window.OCR.runExtractionSelfTest()
// Expected: 11/11 PASS
```

## PWA / Service Worker Cache

Cache name is `bp-cache-v1` in [service-worker.js](service-worker.js). When updating cached files, increment the version string in `service-worker.js`. Clear stale caches in DevTools → Application → Storage → "Clear site data".

## Google Sheets Integration

`SCRIPT_URL` in [js/sheets-api.js](js/sheets-api.js) points to the deployed Google Apps Script Web App. The GAS code (stored only in README.md) expects a sheet named `血圧記録` with columns: `ID | 日時 | メンバー | 最高血圧 | 最低血圧 | 脈拍`.

## Validation Ranges (app.js)

```javascript
systolic:  { min: 50,  max: 250 }
diastolic: { min: 30,  max: 150 }
pulse:     { min: 40,  max: 200 }
```

## Data Retention

Records older than 365 days are automatically deleted on app startup (`MAX_DATA_RETENTION_DAYS = 365`). Up to 10 records are shown in the list (`MAX_LIST_COUNT = 10`).
