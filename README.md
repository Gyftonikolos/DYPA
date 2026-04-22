# GoLearn Automation Starter

This is a small Playwright starter project for automating workflows on:

- `https://edu.golearn.gr/training/trainee/training`

It is designed to be easy to share with other people.

## Why this setup

- Works on Windows, macOS, and Linux
- Handles modern websites better than simple browser macros
- Keeps credentials in `.env` instead of hardcoding them
- Gives us one clear place to add the real workflow

## Setup

1. Install Node.js 18+.
2. Open this folder in a terminal.
3. Run:

```powershell
npm install
npx playwright install
Copy-Item .env.example .env
```

4. Edit `.env` and fill in credentials if needed.
5. Run the script once to create `storage-state.json`.

## Run

```powershell
npm start
```

On the first run, the site may redirect to a challenge or verification page. If that happens, complete it manually in the opened browser window. The script will save the session to `storage-state.json` so later runs can reuse it.

## Helpful for capturing selectors

```powershell
npm run codegen
```

Playwright's code generator opens a browser and helps record reliable selectors.

## Where to customize

- Main entry point: `src/index.js`
- Site settings: `src/config.js`
- Environment variables: `.env`
- Timer/progress state: `progress-state.json`
- Session event log: `session-log.jsonl`

## What is already implemented

- Opens the real GoLearn login page
- Fills `Input.Username` and `Input.Password`
- Submits the form and waits for the trainee portal to load
- Saves the authenticated browser session to `storage-state.json`
- Opens the `Κατάρτιση` section after login
- Opens the target Moodle course
- Selects the lesson section based on elapsed time from `progress-state.json`
- Follows the fixed lesson sequence `section-3` through `section-7`
- Enters the SCORM lesson in 40-minute sessions and exits safely before the cutoff
- Reopens the same lesson until the tracked daily total reaches 6 hours
- Saves both the current local state and an append-only local event log
- Tracks per-lesson local totals using the official chapter requirements: `29h` for `E1`, `30h` for `E2-E5`
- You can override test timings in `progress-state.json` with `scormSessionMinutes` and `dailyScormLimitMinutes`

## Next step

To finish the real automation, we still need the exact user flow, for example:

- how login works
- which buttons or menus should be clicked
- whether files are uploaded or downloaded
- what success looks like
