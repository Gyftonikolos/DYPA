#!/usr/bin/env node
/**
 * DYPA Interactive CLI
 * Run with: npm run cli
 *
 * Gives a terminal menu to control every aspect of the automation
 * without touching the desktop app or browser UI.
 */

"use strict";

const readline = require("readline");
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadSettings, saveSettings } = require("./settingsStore");
const {
  parseScheduleWindowsCsv,
  isNowWithinAnyWindow,
  computeNextWindowStart,
} = require("./scheduleWindows");
const {
  loadProgressState,
  saveProgressState,
  ensureProgressStarted,
  ensureDailyProgress,
  appendSessionLog,
} = require("./progressStore");

// ─── helpers ───────────────────────────────────────────────────────────────

const LESSON_SECTION_CONFIG = [
  { id: "3", targetHours: 29, lessonKey: "E1" },
  { id: "4", targetHours: 30, lessonKey: "E2" },
  { id: "5", targetHours: 30, lessonKey: "E3" },
  { id: "6", targetHours: 30, lessonKey: "E4" },
  { id: "7", targetHours: 30, lessonKey: "E5" },
];

const PROGRESS_STATE_PATH =
  process.env.PROGRESS_STATE_PATH || "progress-state.json";
const SESSION_LOG_PATH = process.env.SESSION_LOG_PATH || "session-log.jsonl";
const RUNTIME_STATE_PATH =
  process.env.RUNTIME_STATE_PATH || "runtime-state.json";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

function col(color, text) {
  return `${C[color] || ""}${text}${C.reset}`;
}

function fmtMinutes(m) {
  if (!Number.isFinite(m)) return "-";
  const h = Math.floor(m / 60);
  const min = m % 60;
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function bar(completed, total, width = 20) {
  if (!total || total <= 0) return "[" + " ".repeat(width) + "]";
  const pct = Math.min(completed / total, 1);
  const filled = Math.round(pct * width);
  return (
    "[" +
    col("green", "█".repeat(filled)) +
    col("gray", "░".repeat(width - filled)) +
    "]"
  );
}

function hr(char = "─", width = 60) {
  return col("gray", char.repeat(width));
}

function header(title) {
  const pad = Math.max(0, Math.floor((60 - title.length - 2) / 2));
  const line = " ".repeat(pad) + col("bold", title);
  console.log("\n" + hr("═") + "\n" + line + "\n" + hr("═"));
}

function section(title) {
  console.log("\n" + col("cyan", col("bold", `  ▸ ${title}`)));
  console.log(hr());
}

function note(msg) {
  console.log(col("gray", `  ${msg}`));
}

function ok(msg) {
  console.log(col("green", `  ✓ ${msg}`));
}

function warn(msg) {
  console.log(col("yellow", `  ⚠ ${msg}`));
}

function err(msg) {
  console.log(col("red", `  ✗ ${msg}`));
}

// ─── readline wrappers ──────────────────────────────────────────────────────

let rl;

function createRl() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // Keep process alive while menu is open.
  rl.on("close", () => process.exit(0));
  return rl;
}

function ask(prompt) {
  return new Promise((resolve) => {
    rl.question(`  ${col("cyan", "?")} ${prompt} `, (ans) =>
      resolve(ans.trim()),
    );
  });
}

function askRequired(prompt, validate) {
  return new Promise(async (resolve) => {
    while (true) {
      const ans = await ask(prompt);
      if (!validate || validate(ans)) {
        resolve(ans);
        return;
      }
      warn("Invalid input, please try again.");
    }
  });
}

// ─── menu engine ───────────────────────────────────────────────────────────

async function menu(title, items) {
  header(title);
  items.forEach(({ key, label, hint }, i) => {
    const k = col("bold", col("yellow", key ?? String(i + 1)));
    const l = col("white", label);
    const h = hint ? col("gray", `  ${hint}`) : "";
    console.log(`  ${k}  ${l}${h}`);
  });
  console.log(
    `  ${col("bold", col("yellow", "0"))}  ${col("gray", "Back / Exit")}`,
  );
  console.log();
  const choice = await ask("Choice:");
  return choice;
}

// ─── screens ───────────────────────────────────────────────────────────────

// ── 1. Show status ──────────────────────────────────────────────────────────

async function showStatus() {
  section("Current Status");

  // runtime state
  let rt = {};
  if (fs.existsSync(RUNTIME_STATE_PATH)) {
    try {
      rt = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, "utf8"));
    } catch {}
  }

  const statusColor =
    rt.status === "running"
      ? "green"
      : rt.status === "paused"
        ? "yellow"
        : rt.status === "error"
          ? "red"
          : "gray";

  console.log(
    `  Status          ${col(statusColor, col("bold", rt.status || "idle"))}`,
  );
  console.log(`  Last Action     ${col("white", rt.lastAction || "-")}`);
  console.log(`  Current URL     ${col("dim", rt.currentUrl || "-")}`);
  console.log(
    `  Today's Minutes ${col("white", fmtMinutes(rt.todayMinutes))} / ${fmtMinutes(rt.dailyLimitMinutes)}`,
  );
  console.log(
    `  Next Exit       ${col("white", fmtDate(rt.nextPlannedExitAt))}`,
  );
  console.log(`  Updated At      ${col("gray", fmtDate(rt.updatedAt))}`);

  // diagnostics
  const diag = rt.runtimeDiagnostics || {};
  if (diag.lastSuccessfulStep && diag.lastSuccessfulStep !== "-") {
    console.log(`  Last Step OK    ${col("green", diag.lastSuccessfulStep)}`);
  }
  if (diag.lastSelectorFailure && diag.lastSelectorFailure !== "-") {
    console.log(`  Last Failure    ${col("red", diag.lastSelectorFailure)}`);
  }

  // settings quick view
  const settings = loadSettings();
  const sched = settings.scheduler || {};
  console.log(
    `\n  Scheduler       ${sched.enabled ? col("green", "enabled") : col("gray", "disabled")}`,
  );
  if (sched.enabled && sched.allowedWindowsCsv) {
    const { windows } = parseScheduleWindowsCsv(sched.allowedWindowsCsv);
    const { within, activeWindow } = isNowWithinAnyWindow(windows);
    console.log(`  Windows         ${col("white", sched.allowedWindowsCsv)}`);
    console.log(
      `  Right now       ${within ? col("green", `inside window ${activeWindow?.start}-${activeWindow?.end}`) : col("yellow", "OUTSIDE window")}`,
    );
    if (!within) {
      const next = computeNextWindowStart(windows);
      console.log(
        `  Next open       ${col("white", fmtDate(next?.toISOString()))}`,
      );
    }
  }

  await ask("Press Enter to continue...");
}

// ── 2. Progress ─────────────────────────────────────────────────────────────

async function showProgress() {
  section("Lesson Progress");

  let ps;
  try {
    ps = loadProgressState(PROGRESS_STATE_PATH);
    ps = ensureProgressStarted(ps);
  } catch {
    err("Could not load progress-state.json");
    await ask("Press Enter to continue...");
    return;
  }

  const daily = ensureDailyProgress(ps);
  const dailyLimit = Number(ps.dailyScormLimitMinutes || 350);
  const todayPct =
    dailyLimit > 0
      ? Math.round((daily.completedMinutes / dailyLimit) * 100)
      : 0;

  console.log(
    `\n  Today       ${bar(daily.completedMinutes, dailyLimit)} ${col("white", fmtMinutes(daily.completedMinutes))} / ${fmtMinutes(dailyLimit)}  ${col("gray", `(${todayPct}%)`)}`,
  );
  console.log(`  Day key     ${col("dim", daily.dayKey || "-")}`);

  console.log();
  console.log(
    `  ${col("bold", "Lesson")}   ${col("bold", "Key")}   ${col("bold", "Completed")}   ${col("bold", "Target")}      ${col("bold", "Progress")}`,
  );
  console.log(hr());

  for (const cfg of LESSON_SECTION_CONFIG) {
    const lp = ps.lessonProgress?.[cfg.id];
    const completed = Number(lp?.completedMinutes || 0);
    const target = Number(lp?.targetHours ?? cfg.targetHours) * 60;
    const pct = target > 0 ? Math.round((completed / target) * 100) : 0;
    const done = pct >= 100;
    const lessonColor = done ? "green" : pct > 0 ? "yellow" : "gray";
    console.log(
      `  ${col(lessonColor, `Section ${cfg.id}`)}  ${col(lessonColor, cfg.lessonKey)}    ${String(fmtMinutes(completed)).padEnd(10)} ${String(fmtMinutes(target)).padEnd(10)} ${bar(completed, target, 16)} ${col("gray", `${pct}%`)}${done ? col("green", " ✓") : ""}`,
    );
  }

  console.log();
  console.log(`  Started      ${col("dim", fmtDate(ps.startedAt))}`);
  console.log(
    `  Sessions     ${col("white", String(ps.sessionLedger ? Object.keys(ps.sessionLedger).length : 0))}`,
  );

  await ask("Press Enter to continue...");
}

// ── 3. Scheduler ────────────────────────────────────────────────────────────

async function manageScheduler() {
  while (true) {
    const settings = loadSettings();
    const sched = settings.scheduler || {};
    const statusStr = sched.enabled
      ? col("green", "ENABLED  ") +
        col("gray", `(windows: ${sched.allowedWindowsCsv || "none"})`)
      : col("red", "DISABLED");

    const choice = await menu(`Scheduler  [${statusStr}${C.reset}]`, [
      {
        key: "1",
        label: "Enable with windows",
        hint: "e.g. 00:15-02:15,17:00-21:00",
      },
      { key: "2", label: "Disable (run anytime)" },
      { key: "3", label: "Show window status now" },
      { key: "4", label: "Set daily target minutes" },
    ]);

    if (choice === "0") return;

    if (choice === "1") {
      console.log(
        note("Example: 00:15-02:15,17:00-21:00  (leave blank to keep current)"),
      );
      const csv = await ask(
        `Windows CSV [current: ${col("white", sched.allowedWindowsCsv || "none")}]:`,
      );
      const windowsCsv = csv.trim() || sched.allowedWindowsCsv || "";
      if (!windowsCsv) {
        warn("No windows provided – scheduler NOT enabled.");
        continue;
      }
      const { windows, errors } = parseScheduleWindowsCsv(windowsCsv);
      if (errors.length) {
        err("Parse errors:");
        errors.forEach((e) => console.log(`    ${col("red", e)}`));
        continue;
      }
      const updated = {
        ...settings,
        scheduler: {
          ...sched,
          enabled: true,
          allowedWindowsCsv: windowsCsv,
        },
      };
      saveSettings(updated);
      ok(`Scheduler enabled with ${windows.length} window(s): ${windowsCsv}`);
      note(
        "Restart automation for the change to take effect on the running process.",
      );
    } else if (choice === "2") {
      const updated = {
        ...settings,
        scheduler: { ...sched, enabled: false },
      };
      saveSettings(updated);
      ok("Scheduler disabled – automation will run anytime.");
      note("Restart automation for the change to take effect.");
    } else if (choice === "3") {
      const { windows, errors } = parseScheduleWindowsCsv(
        sched.allowedWindowsCsv || "",
      );
      if (!sched.enabled || !windows.length) {
        note("Scheduler is disabled – no windows to check.");
      } else {
        const { within, activeWindow } = isNowWithinAnyWindow(windows);
        if (within) {
          ok(
            `Inside window ${activeWindow?.start}-${activeWindow?.end}. Automation may run.`,
          );
        } else {
          const next = computeNextWindowStart(windows);
          warn(
            `Outside all windows. Next open: ${fmtDate(next?.toISOString())}`,
          );
        }
        errors.forEach((e) => warn(e));
      }
      await ask("Press Enter to continue...");
    } else if (choice === "4") {
      const current = settings.dailyScormLimitMinutes ?? 350;
      const raw = await ask(
        `Daily target minutes [current: ${col("white", String(current))}]:`,
      );
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        warn("Invalid number – keeping current value.");
        continue;
      }
      const updated = { ...settings, dailyScormLimitMinutes: parsed };
      saveSettings(updated);
      ok(`Daily target set to ${parsed} minutes.`);
    }
  }
}

// ── 4. Settings ─────────────────────────────────────────────────────────────

async function manageSettings() {
  while (true) {
    const settings = loadSettings();
    const choice = await menu("Settings", [
      { key: "1", label: "Show current settings" },
      {
        key: "2",
        label: "Set session duration range",
        hint: "min/max minutes per SCORM session",
      },
      { key: "3", label: "Set daily target minutes" },
      { key: "4", label: "Set timeout (ms)" },
      { key: "5", label: "Toggle headless mode" },
    ]);

    if (choice === "0") return;

    if (choice === "1") {
      section("Current Settings");
      console.log(
        `  Session range      ${col("white", `${settings.scormSessionMinMinutes} – ${settings.scormSessionMaxMinutes} min`)}`,
      );
      console.log(
        `  Daily limit        ${col("white", fmtMinutes(settings.dailyScormLimitMinutes))}`,
      );
      console.log(
        `  Timeout            ${col("white", `${settings.timeoutMs} ms`)}`,
      );
      console.log(
        `  Headless           ${col("white", String(settings.headless))}`,
      );
      console.log(
        `  SlowMo             ${col("white", `${settings.slowMo} ms`)}`,
      );
      console.log(
        `  Dashboard port     ${col("white", String(settings.dashboardPort))}`,
      );
      console.log(
        `  Scheduler          ${settings.scheduler?.enabled ? col("green", "enabled") : col("gray", "disabled")}`,
      );
      if (settings.scheduler?.enabled) {
        console.log(
          `  Windows            ${col("white", settings.scheduler.allowedWindowsCsv || "-")}`,
        );
      }
      console.log(
        `  Username           ${col("dim", settings.credentials?.username || "-")}`,
      );
      await ask("Press Enter to continue...");
    } else if (choice === "2") {
      const minRaw = await ask(
        `Min session minutes [current: ${settings.scormSessionMinMinutes}]:`,
      );
      const maxRaw = await ask(
        `Max session minutes [current: ${settings.scormSessionMaxMinutes}]:`,
      );
      const minVal = Number(minRaw) || settings.scormSessionMinMinutes;
      const maxVal = Number(maxRaw) || settings.scormSessionMaxMinutes;
      if (minVal <= 0 || maxVal <= 0 || maxVal < minVal) {
        warn("Invalid range – min must be > 0 and max >= min.");
        continue;
      }
      saveSettings({
        ...settings,
        scormSessionMinMinutes: minVal,
        scormSessionMaxMinutes: maxVal,
        maxScormSessionMinutes: maxVal,
      });
      ok(`Session range set to ${minVal} – ${maxVal} min.`);
    } else if (choice === "3") {
      const raw = await ask(
        `Daily limit minutes [current: ${settings.dailyScormLimitMinutes}]:`,
      );
      const val = Number(raw);
      if (!Number.isFinite(val) || val <= 0) {
        warn("Invalid number.");
        continue;
      }
      saveSettings({ ...settings, dailyScormLimitMinutes: val });
      ok(`Daily limit set to ${val} min.`);
    } else if (choice === "4") {
      const raw = await ask(`Timeout ms [current: ${settings.timeoutMs}]:`);
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 5000) {
        warn("Timeout must be at least 5000 ms.");
        continue;
      }
      saveSettings({ ...settings, timeoutMs: val });
      ok(`Timeout set to ${val} ms.`);
    } else if (choice === "5") {
      const next = !settings.headless;
      saveSettings({ ...settings, headless: next });
      ok(`Headless set to ${next}.`);
    }
  }
}

// ── 5. Start automation ──────────────────────────────────────────────────────

async function startAutomation() {
  section("Start Automation");
  warn("This will launch a Playwright browser and run the full SCORM loop.");
  const confirm = await ask("Proceed? [y/N]");
  if (confirm.toLowerCase() !== "y") {
    note("Cancelled.");
    return;
  }

  // Pause readline so Playwright can use stdin/stdout freely.
  rl.pause();

  // Spawn automation in the same process as a child module call.
  try {
    const { spawn } = require("child_process");
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "index.js")],
      {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      },
    );

    await new Promise((resolve) => {
      child.on("exit", (code) => {
        if (code === 0) {
          ok("Automation finished successfully.");
        } else {
          err(`Automation exited with code ${code}.`);
        }
        resolve();
      });
    });
  } catch (e) {
    err(`Failed to start automation: ${e.message}`);
  } finally {
    rl.resume();
  }
}

// ── 6. Sync stats (read-only from progress-state) ───────────────────────────

async function syncStatsDisplay() {
  section("Sync Stats (from progress-state.json)");
  try {
    let ps = loadProgressState(PROGRESS_STATE_PATH);
    ps = ensureProgressStarted(ps);
    const daily = ensureDailyProgress(ps);
    ok(`Loaded progress for day ${daily.dayKey}.`);
    console.log(
      `  Today: ${col("white", fmtMinutes(daily.completedMinutes))} completed.`,
    );
    for (const cfg of LESSON_SECTION_CONFIG) {
      const lp = ps.lessonProgress?.[cfg.id];
      if (!lp) continue;
      const completed = Number(lp.completedMinutes || 0);
      const target = Number(lp.targetHours ?? cfg.targetHours) * 60;
      const pct = target > 0 ? Math.round((completed / target) * 100) : 0;
      console.log(
        `  ${cfg.lessonKey} (sec ${cfg.id}): ${fmtMinutes(completed)} / ${fmtMinutes(target)}  ${pct}%`,
      );
    }
  } catch (e) {
    err(`Could not read progress state: ${e.message}`);
  }
  await ask("Press Enter to continue...");
}

// ── 7. Logs tail ─────────────────────────────────────────────────────────────

async function tailLogs() {
  section("Recent Session Log (last 20 entries)");
  if (!fs.existsSync(SESSION_LOG_PATH)) {
    warn("session-log.jsonl not found.");
    await ask("Press Enter to continue...");
    return;
  }
  try {
    const lines = fs
      .readFileSync(SESSION_LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-20);

    if (!lines.length) {
      note("Log is empty.");
    } else {
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = entry.timestamp
            ? col("gray", new Date(entry.timestamp).toLocaleTimeString())
            : "";
          const ev = entry.event || "?";
          const evColor =
            ev.includes("failed") || ev.includes("error")
              ? "red"
              : ev.includes("warn") || ev.includes("drift")
                ? "yellow"
                : "white";
          const url = entry.url ? col("dim", `  ${entry.url}`) : "";
          console.log(`  ${ts}  ${col(evColor, ev)}${url}`);
        } catch {
          console.log(col("gray", `  ${line.slice(0, 120)}`));
        }
      }
    }
  } catch (e) {
    err(`Could not read log: ${e.message}`);
  }
  await ask("Press Enter to continue...");
}

// ── 8. Reset daily progress ──────────────────────────────────────────────────

async function resetDailyProgress() {
  section("Reset Today's Progress");
  warn("This resets the completed minutes counter for today only.");
  warn("Lesson totals are NOT affected.");
  const confirm = await ask("Type YES to confirm:");
  if (confirm !== "YES") {
    note("Cancelled.");
    return;
  }
  try {
    let ps = loadProgressState(PROGRESS_STATE_PATH);
    ps = ensureProgressStarted(ps);
    if (ps.dailyProgress) {
      ps.dailyProgress.completedMinutes = 0;
      ps.dailyProgress.updatedAt = new Date().toISOString();
    }
    saveProgressState(ps);
    appendSessionLog(SESSION_LOG_PATH, {
      event: "cli_daily_progress_reset",
      resetAt: new Date().toISOString(),
    });
    ok("Daily progress reset to 0.");
  } catch (e) {
    err(`Failed: ${e.message}`);
  }
  await ask("Press Enter to continue...");
}

// ── 9. Reset a lesson ────────────────────────────────────────────────────────

async function resetLesson() {
  section("Reset Lesson Minutes");
  LESSON_SECTION_CONFIG.forEach((cfg, i) => {
    console.log(
      `  ${col("yellow", String(i + 1))}  ${cfg.lessonKey}  (section ${cfg.id})`,
    );
  });
  const pick = await ask("Pick lesson number [1-5] or 0 to cancel:");
  const idx = Number(pick) - 1;
  if (pick === "0" || idx < 0 || idx >= LESSON_SECTION_CONFIG.length) {
    note("Cancelled.");
    return;
  }
  const cfg = LESSON_SECTION_CONFIG[idx];
  const confirm = await ask(
    `Reset ${cfg.lessonKey} (section ${cfg.id}) to 0 minutes? Type YES:`,
  );
  if (confirm !== "YES") {
    note("Cancelled.");
    return;
  }
  try {
    let ps = loadProgressState(PROGRESS_STATE_PATH);
    ps = ensureProgressStarted(ps);
    if (ps.lessonProgress?.[cfg.id]) {
      ps.lessonProgress[cfg.id].completedMinutes = 0;
      ps.lessonProgress[cfg.id].updatedAt = new Date().toISOString();
    }
    saveProgressState(ps);
    appendSessionLog(SESSION_LOG_PATH, {
      event: "cli_lesson_reset",
      sectionId: cfg.id,
      lessonKey: cfg.lessonKey,
      resetAt: new Date().toISOString(),
    });
    ok(`${cfg.lessonKey} reset.`);
  } catch (e) {
    err(`Failed: ${e.message}`);
  }
  await ask("Press Enter to continue...");
}

// ─── main loop ──────────────────────────────────────────────────────────────

async function main() {
  createRl();
  console.clear();
  console.log(
    col(
      "bold",
      col("magenta", "\n  DYPA GoLearn Automation — Interactive CLI"),
    ),
  );
  note(`Node ${process.version}  •  cwd: ${process.cwd()}`);

  while (true) {
    const choice = await menu("Main Menu", [
      { key: "1", label: "Status", hint: "runtime + scheduler" },
      { key: "2", label: "Progress", hint: "lesson/daily completion" },
      { key: "3", label: "Start Automation", hint: "runs full SCORM loop" },
      { key: "4", label: "Sync Stats", hint: "read from progress-state.json" },
      { key: "5", label: "Scheduler", hint: "enable / disable / set windows" },
      { key: "6", label: "Settings", hint: "duration, timeout, headless..." },
      { key: "7", label: "Log Tail", hint: "last 20 session-log entries" },
      {
        key: "8",
        label: "Reset Daily Progress",
        hint: "zero out today's counter",
      },
      {
        key: "9",
        label: "Reset Lesson Minutes",
        hint: "pick a lesson to zero",
      },
    ]);

    if (choice === "0") {
      note("Bye.");
      rl.close();
      return;
    }

    console.clear();

    switch (choice) {
      case "1":
        await showStatus();
        break;
      case "2":
        await showProgress();
        break;
      case "3":
        await startAutomation();
        break;
      case "4":
        await syncStatsDisplay();
        break;
      case "5":
        await manageScheduler();
        break;
      case "6":
        await manageSettings();
        break;
      case "7":
        await tailLogs();
        break;
      case "8":
        await resetDailyProgress();
        break;
      case "9":
        await resetLesson();
        break;
      default:
        warn(`Unknown option: ${choice}`);
    }

    console.clear();
  }
}

main().catch((e) => {
  console.error(col("red", `\nFatal: ${e.message}`));
  process.exit(1);
});
