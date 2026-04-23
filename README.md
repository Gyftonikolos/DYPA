# DYPA GoLearn Automation

Simple desktop automation for `https://edu.golearn.gr` with an embedded browser, settings UI, scheduling, and local runtime tracking.

## Quick Start

1. Install Node.js 18+.
2. In this folder run:

```powershell
npm install
npx playwright install
Copy-Item .env.example .env
```

3. Fill credentials in `.env` (or later in the app Settings).
4. Start desktop app:

```powershell
npm run desktop
```

## Main Features

- Embedded browser automation flow (login -> training -> course -> SCORM loop)
- Settings with encrypted credentials
- Session range and daily target controls
- One-time scheduler (`Run at this time` / `Cancel Scheduled Run`)
- Cleaner action UX:
  - scheduled button state (green + disabled when pending)
  - cancel button state (red + enabled only when valid)
  - consistent Start/Stop button enable/disable behavior
- UI modes:
  - `Simple Mode` (hides dev-heavy UI)
  - `White Theme` (light mode)
- Simplified runtime status panel with optional technical details

## Defaults

Current defaults are:

- Session Min Minutes: `38`
- Session Max Minutes: `41`
- Daily Target Minutes: `350`
- Page Wait Time: `30000`

## Settings Priority

1. Saved desktop settings
2. `.env`
3. Built-in defaults

## Test Commands

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e-ui
npm run test:phase2
npm run test:phase3
npm run test:phase5
npm run test:ux-smoke
npm run quality:gate
```

## Useful Paths

- Main automation script: `src/index.js`
- Desktop main process: `electron/main.js`
- Renderer UI logic: `electron/renderer/renderer.js`
- Renderer styles: `electron/renderer/styles.css`
- Runtime state: `runtime-state.json`
- Progress state: `progress-state.json`
- Session log: `session-log.jsonl`
