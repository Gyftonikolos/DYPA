const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const { chromium } = require("playwright");
const config = require("../src/config");
const { resolveSessionRange, pickSessionMinutes } = require("../src/sessionPolicy");
const { resolveLessonSelection } = require("../src/sharedOrchestrator");
const { updateJsonFileVersioned, readJsonFile: readAtomicJson, writeJsonFileAtomic } = require("../src/atomicJsonStore");
const {
  DEFAULT_SETTINGS,
  getSettingsPaths,
  loadSettings,
  saveSettings,
  sanitizeForRenderer
} = require("../src/settingsStore");
const { parseScheduleWindowsCsv } = require("../src/scheduleWindows");

let botProcess = null;
let staleRunMonitor = null;
let scheduleMonitor = null;

function sanitizeRuntimePatch(patch) {
  const allowedKeys = new Set([
    "status",
    "paused",
    "processRunning",
    "currentLesson",
    "currentLessonTitle",
    "currentUrl",
    "lastAction",
    "nextPlannedExitAt",
    "todayMinutes",
    "dailyLimitMinutes",
    "lessonTotals",
    "testTotals",
    "runtimeDiagnostics",
    "supervisorTimeline",
    "scheduledRun"
  ]);
  const next = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowedKeys.has(key)) continue;
    next[key] = value;
  }
  return next;
}

function isValidProgressPayload(payload) {
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload));
}

function isValidRunAtLocalTime(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ""));
}

function computeNextOccurrenceIso(runAtLocalTime) {
  const [h, m] = String(runAtLocalTime).split(":").map((v) => Number(v));
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.toISOString();
}

function readJsonFile(filePath, fallback) {
  const atomicValue = readAtomicJson(filePath, null);
  if (atomicValue !== null) {
    return atomicValue;
  }
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(absolutePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readRecentLogs(filePath, limit = 40) {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(absolutePath)) {
      return [];
    }

    return fs
      .readFileSync(absolutePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { timestamp: null, event: "raw", message: line };
        }
      });
  } catch {
    return [];
  }
}

function getDashboardPayload() {
  const runtimeState = readJsonFile(config.runtimeStatePath, {});
  const progressState = readJsonFile(config.progressStatePath, {});
  const runtimeLessonTotals = runtimeState.lessonTotals || {};
  const runtimeLessonTargets = Object.values(runtimeLessonTotals).map((item) => Number(item?.targetHours || 0));
  const runtimeLessonTotalsSuspicious =
    runtimeLessonTargets.length > 0 && runtimeLessonTargets.every((value) => Number.isFinite(value) && value > 0 && value <= 0.25);

  return {
    ...runtimeState,
    todayMinutes:
      progressState.dailyProgress?.completedMinutes ?? runtimeState.todayMinutes ?? 0,
    dailyLimitMinutes:
      progressState.dailyScormLimitMinutes ??
      runtimeState.dailyLimitMinutes ??
      config.dailyScormLimitMinutes,
    lessonTotals:
      Object.keys(runtimeLessonTotals).length > 0 && !runtimeLessonTotalsSuspicious
        ? runtimeLessonTotals
        : progressState.lessonProgress || {},
    testTotals: Array.isArray(runtimeState.testTotals) ? runtimeState.testTotals : [],
    currentLesson:
      runtimeState.currentLesson || progressState.lastResolvedSectionId || null,
    processRunning: Boolean(runtimeState.processRunning ?? botProcess)
  };
}

function getAnalyticsSnapshot() {
  const payload = getDashboardPayload();
  const today = Number(payload.todayMinutes || 0);
  const limit = Number(payload.dailyLimitMinutes || 0);
  const remaining = Math.max(0, limit - today);
  const lessonTotals = Object.values(payload.lessonTotals || {});
  const totalCompleted = lessonTotals.reduce((sum, item) => sum + Number(item.completedMinutes || 0), 0);
  const totalTarget = lessonTotals.reduce((sum, item) => sum + Number(item.targetHours || 0) * 60, 0);
  const completionPct = totalTarget > 0 ? Math.round((totalCompleted / totalTarget) * 100) : 0;

  const recentLogs = readRecentLogs(config.sessionLogPath, 2000);
  const activeDays = Array.from(
    new Set(
      recentLogs
        .filter((log) => String(log.event || "").toLowerCase().includes("scorm_session_completed"))
        .map((log) => {
          try {
            return new Intl.DateTimeFormat("en-CA", {
              timeZone: "Europe/Athens",
              year: "numeric",
              month: "2-digit",
              day: "2-digit"
            }).format(new Date(log.timestamp));
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    )
  ).sort((a, b) => (a < b ? 1 : -1));

  let streak = 0;
  if (activeDays.length > 0) {
    let cursor = new Date();
    for (const dayKey of activeDays) {
      const cursorKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Athens",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(cursor);
      if (dayKey !== cursorKey) {
        break;
      }
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  const etaMinutes = today > 0 && limit > today ? remaining : 0;

  return {
    dailyCompletionPct: limit > 0 ? Math.round((today / limit) * 100) : 0,
    dailyRemainingMinutes: remaining,
    lessonForecastPct: completionPct,
    activeStreakDays: streak,
    etaToDailyTargetMinutes: etaMinutes
  };
}

function getMergedSettingsForUi() {
  const persisted = loadSettings();
  return sanitizeForRenderer({
    ...DEFAULT_SETTINGS,
    ...persisted,
    credentials: {
      username: persisted.credentials?.username || "",
      password: persisted.credentials?.password || ""
    }
  });
}

function coerceSettings(input) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...(input || {}),
    credentials: {
      username: String(input?.credentials?.username || ""),
      password: String(input?.credentials?.password || "")
    },
    featureFlags: {
      ...(DEFAULT_SETTINGS.featureFlags || {}),
      ...(input?.featureFlags || {}),
      notifications: {
        ...(DEFAULT_SETTINGS.featureFlags?.notifications || {}),
        ...(input?.featureFlags?.notifications || {})
      },
      logging: {
        ...(DEFAULT_SETTINGS.featureFlags?.logging || {}),
        ...(input?.featureFlags?.logging || {})
      },
      ui: {
        ...(DEFAULT_SETTINGS.featureFlags?.ui || {}),
        ...(input?.featureFlags?.ui || {})
      }
    },
    scheduler: {
      ...(DEFAULT_SETTINGS.scheduler || {}),
      ...(input?.scheduler || {})
    }
  };

  return next;
}

async function testLoginOnly(settings) {
  const launchHeadless =
    settings.headless === null || settings.headless === undefined ? true : Boolean(settings.headless);
  const browser = await chromium.launch({
    headless: launchHeadless,
    slowMo: Number(settings.slowMo || 0)
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const timeoutMs = Number(settings.timeoutMs || config.timeoutMs || 30_000);
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(settings.loginUrl || config.loginUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#Input_Username").fill(String(settings.credentials?.username || ""));
    await page.locator("#Input_Password").fill(String(settings.credentials?.password || ""));
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState("domcontentloaded");
    const url = page.url();
    if (/\/login/i.test(url)) {
      return {
        ok: false,
        url,
        message: "Login remained on login page. Verify credentials or network."
      };
    }
    return {
      ok: true,
      url,
      message: "Login succeeded."
    };
  } catch (error) {
    return {
      ok: false,
      url: page.url ? page.url() : null,
      message: error.message || "Login test failed."
    };
  } finally {
    await browser.close();
  }
}

function testSettingsPayload(settings) {
  const errors = [];
  if (!settings.credentials.username) {
    errors.push("Username is required.");
  }
  if (!settings.credentials.password) {
    errors.push("Password is required.");
  }

  const numericFields = [
    "dashboardPort",
    "slowMo",
    "timeoutMs",
    "scormSessionMinMinutes",
    "scormSessionMaxMinutes",
    "dailyScormLimitMinutes"
  ];
  for (const field of numericFields) {
    if (settings[field] !== null && settings[field] !== undefined && Number(settings[field]) < 0) {
      errors.push(`${field} must be a positive number.`);
    }
  }

  const minMinutes = Number(settings.scormSessionMinMinutes);
  const maxMinutes = Number(settings.scormSessionMaxMinutes);
  if (!Number.isInteger(minMinutes) || minMinutes <= 0) {
    errors.push("scormSessionMinMinutes must be a positive integer.");
  }
  if (!Number.isInteger(maxMinutes) || maxMinutes <= 0) {
    errors.push("scormSessionMaxMinutes must be a positive integer.");
  }
  if (Number.isInteger(minMinutes) && Number.isInteger(maxMinutes) && maxMinutes < minMinutes) {
    errors.push("scormSessionMaxMinutes must be greater than or equal to scormSessionMinMinutes.");
  }
  const defaultRunAtLocalTime = String(settings.scheduler?.defaultRunAtLocalTime || "");
  if (defaultRunAtLocalTime && !isValidRunAtLocalTime(defaultRunAtLocalTime)) {
    errors.push("scheduler.defaultRunAtLocalTime must follow HH:mm (24-hour) format.");
  }
  const allowedWindowsCsv = String(settings.scheduler?.allowedWindowsCsv || "").trim();
  if (allowedWindowsCsv) {
    const parsed = parseScheduleWindowsCsv(allowedWindowsCsv);
    if (parsed.errors.length > 0) {
      errors.push(`scheduler.allowedWindowsCsv invalid: ${parsed.errors.join("; ")}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function writeJsonFile(filePath, payload) {
  writeJsonFileAtomic(filePath, payload);
}

function sanitizeConfigForSupport() {
  return {
    ...config,
    credentials: {
      username: config.credentials?.username || "",
      password: config.credentials?.password ? "[REDACTED]" : ""
    }
  };
}

function updateRuntimeState(patch) {
  const current = readJsonFile(config.runtimeStatePath, {});
  const next = {
    ...current,
    ...patch,
    lastUpdatedAt: new Date().toISOString()
  };
  writeJsonFile(config.runtimeStatePath, next);
  return next;
}

function appendJsonLine(filePath, payload) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  fs.appendFileSync(
    absolutePath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
    "utf8"
  );
}

function startBotProcess() {
  if (botProcess) {
    return { started: false, reason: "already-running" };
  }

  botProcess = spawn(process.execPath, [path.join(process.cwd(), "src", "index.js")], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true
  });

  appendJsonLine(config.sessionLogPath, {
    event: "desktop_bot_started",
    pid: botProcess.pid
  });

  botProcess.stdout.on("data", (chunk) => {
    const text = String(chunk || "");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      appendJsonLine(config.sessionLogPath, {
        event: "desktop_bot_stdout",
        source: "electron.bot.stdout",
        errorCode: null,
        message: line
      });
    }
  });

  botProcess.stderr.on("data", (chunk) => {
    const text = String(chunk || "");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      appendJsonLine(config.sessionLogPath, {
        event: "desktop_bot_stderr",
        level: "error",
        source: "electron.bot.stderr",
        errorCode: "BOT_STDERR",
        message: line
      });
    }
  });

  botProcess.on("exit", (code, signal) => {
    appendJsonLine(config.sessionLogPath, {
      event: "desktop_bot_exited",
      code,
      signal
    });
    botProcess = null;
  });

  return { started: true };
}

function stopBotProcess() {
  if (!botProcess) {
    return { stopped: false, reason: "not-running" };
  }

  appendJsonLine(config.sessionLogPath, {
    event: "desktop_bot_stop_requested",
    pid: botProcess.pid
  });

  botProcess.kill();
  return { stopped: true };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#efe7d6",
    title: "DYPA Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  app.on("web-contents-created", (_event, contents) => {
    const broadcastToWindows = (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    };

    if (typeof contents.setWindowOpenHandler === "function") {
      contents.setWindowOpenHandler((details) => {
        const targetUrl = String(details?.url || "").trim();
        if (!targetUrl) {
          return { action: "deny" };
        }

        const sourceUrl = String(details?.referrer?.url || "").trim() || null;
        const shouldIntercept = /https?:\/\/(?:[^/]+\.)?golearn\.gr\//i.test(targetUrl);

        if (shouldIntercept) {
          appendJsonLine(config.sessionLogPath, {
            event: "webview_window_open_captured",
            targetUrl,
            sourceUrl
          });
          broadcastToWindows("embedded:webview-window-open", { targetUrl, sourceUrl });
        }

        return { action: "deny" };
      });
    }

    contents.on("javascript-dialog-opening", (...args) => {
      const [event, maybeDetails, maybeCallback] = args;
      const details = maybeDetails && typeof maybeDetails === "object" ? maybeDetails : {};
      const dialogType = String(details.type || details.dialogType || "unknown");
      const messageText = String(details.messageText || details.message || "");
      const sourceUrl = String(details.url || contents.getURL?.() || "").trim() || null;
      const payload = {
        dialogType,
        message: messageText,
        url: sourceUrl,
        autoAccepted: true
      };
      appendJsonLine(config.sessionLogPath, {
        event: "webview_javascript_dialog_auto_accepted",
        ...payload
      });
      broadcastToWindows("embedded:webview-js-dialog", payload);

      if (typeof event?.preventDefault === "function") {
        event.preventDefault();
      }

      if (typeof maybeCallback === "function") {
        maybeCallback(true);
      } else if (typeof event?.returnValue !== "undefined") {
        event.returnValue = true;
      }
    });
  });

  updateRuntimeState({
    status: "idle",
    paused: false,
    processRunning: false,
    nextPlannedExitAt: null
  });

  ipcMain.handle("dashboard:get-state", async () => getDashboardPayload());
  ipcMain.handle("dashboard:get-logs", async () => readRecentLogs(config.sessionLogPath));
  ipcMain.handle("dashboard:get-analytics", async () => getAnalyticsSnapshot());
  ipcMain.handle("logs:export", async () => ({
    exportedAt: new Date().toISOString(),
    logs: readRecentLogs(config.sessionLogPath, 500)
  }));
  ipcMain.handle("support:bundle-export", async () => {
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    const progressState = readJsonFile(config.progressStatePath, {});
    const logs = readRecentLogs(config.sessionLogPath, 1500);
    const recoveryTimeline = logs.filter((log) =>
      ["supervisor_step_failed", "supervisor_recovery_triggered", "recovery_playbook_applied"].includes(
        String(log.event || "")
      )
    );
    const uiTelemetryLogs = logs.filter((log) => String(log.event || "") === "ui_telemetry_action");
    const supervisorTimeline = Array.isArray(runtimeState.supervisorTimeline)
      ? runtimeState.supervisorTimeline.slice(-200)
      : [];
    return {
      bundleVersion: 1,
      generatedAt: new Date().toISOString(),
      diagnostics: {
        platform: process.platform,
        nodeVersion: process.version,
        electronVersion: process.versions.electron || null
      },
      state: {
        runtimeState,
        progressState
      },
      incident: {
        lastAction: runtimeState.lastAction || null,
        currentStep: runtimeState.runtimeDiagnostics?.currentStep || null,
        recoveryTimeline: recoveryTimeline.slice(-200),
        supervisorTimeline,
        uiTelemetry: uiTelemetryLogs.slice(-200)
      },
      config: sanitizeConfigForSupport(),
      logs
    };
  });
  ipcMain.handle("dashboard:get-app-config", async () => ({
    loginUrl: config.loginUrl || "https://edu.golearn.gr/login?returnUrl=%2f",
    trainingUrl: config.baseUrl,
    courseUrl: "https://elearning.golearn.gr/course/view.php?id=7378",
    elearningAutologinUrl: "https://elearning.golearn.gr/local/mdl_autologin/autologin.php",
    directCourseMode: Boolean(config.directCourseMode),
    timeoutMs: config.timeoutMs,
    scormSessionMinMinutes: config.scormSessionMinMinutes,
    scormSessionMaxMinutes: config.scormSessionMaxMinutes,
    maxScormSessionMinutes: config.maxScormSessionMinutes,
    dailyScormLimitMinutes: config.dailyScormLimitMinutes,
    credentials: config.credentials
  }));
  ipcMain.handle("settings:get", async () => {
    const paths = getSettingsPaths();
    return {
      settings: getMergedSettingsForUi(),
      paths
    };
  });
  ipcMain.handle("settings:save", async (_event, payload) => {
    const candidate = coerceSettings(payload);
    const validation = testSettingsPayload(candidate);
    if (!validation.ok) {
      return {
        ok: false,
        errors: validation.errors
      };
    }

    const saved = saveSettings(candidate);
    return {
      ok: true,
      settings: sanitizeForRenderer(saved)
    };
  });
  ipcMain.handle("settings:test", async (_event, payload) => {
    const candidate = coerceSettings(payload);
    return testSettingsPayload(candidate);
  });
  ipcMain.handle("auth:test-login", async (_event, payload) => {
    const candidate = coerceSettings(payload || getMergedSettingsForUi());
    const validation = testSettingsPayload(candidate);
    if (!validation.ok) {
      return {
        ok: false,
        url: null,
        message: validation.errors.join(" ")
      };
    }
    return testLoginOnly(candidate);
  });
  ipcMain.handle("session:resolve-range", async (_event, payload) => {
    const range = resolveSessionRange(payload?.progressState || {}, payload?.configLike || config);
    return range;
  });
  ipcMain.handle("session:pick-minutes", async (_event, payload) => {
    const minutes = pickSessionMinutes(payload?.range || { min: 30, max: 45 }, payload?.remainingMinutes || 0);
    return minutes;
  });
  ipcMain.handle("session:resolve-selection", async (_event, payload) => {
    return resolveLessonSelection(payload?.lessonSections || [], payload?.progressState || {});
  });
  ipcMain.handle("schedule:set-next-run", async (_event, payload) => {
    const runAtLocalTime = String(payload?.runAtLocalTime || "").trim();
    if (!isValidRunAtLocalTime(runAtLocalTime)) {
      return { ok: false, reason: "invalid_time_format" };
    }
    const scheduledForIso = computeNextOccurrenceIso(runAtLocalTime);
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    if (runtimeState.scheduledRun?.enabled) {
      return { ok: false, reason: "already_scheduled", scheduledRun: runtimeState.scheduledRun };
    }
    const scheduledRun = {
      enabled: true,
      runAtLocalTime,
      scheduledForIso,
      createdAt: new Date().toISOString(),
      status: "pending",
      triggerToken: null,
      consumedToken: runtimeState.scheduledRun?.consumedToken || null,
      lastTriggeredAt: runtimeState.scheduledRun?.lastTriggeredAt || null
    };
    updateRuntimeState({ scheduledRun });
    appendJsonLine(config.sessionLogPath, {
      event: "schedule_set",
      runAtLocalTime,
      scheduledForIso
    });
    return { ok: true, scheduledRun };
  });
  ipcMain.handle("schedule:get", async () => {
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    return runtimeState.scheduledRun || null;
  });
  ipcMain.handle("schedule:clear", async () => {
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    const next = {
      ...(runtimeState.scheduledRun || {}),
      enabled: false,
      status: "cancelled",
      runAtLocalTime: null,
      scheduledForIso: null,
      createdAt: null,
      triggerToken: null
    };
    updateRuntimeState({ scheduledRun: next });
    appendJsonLine(config.sessionLogPath, { event: "schedule_cancelled" });
    return { ok: true, scheduledRun: next };
  });
  ipcMain.handle("schedule:consume-trigger", async (_event, payload) => {
    const token = String(payload?.triggerToken || "");
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    const current = runtimeState.scheduledRun || {};
    if (!token || current.triggerToken !== token) {
      return { ok: false, reason: "token_mismatch" };
    }
    const next = {
      ...current,
      status: "trigger_consumed",
      consumedToken: token
    };
    updateRuntimeState({ scheduledRun: next });
    return { ok: true, scheduledRun: next };
  });
  ipcMain.handle("bot:start", async () => startBotProcess());
  ipcMain.handle("bot:stop", async () => stopBotProcess());
  ipcMain.handle("dashboard:update-state", async (_event, patch) => {
    const safePatch = sanitizeRuntimePatch(patch || {});
    return updateRuntimeState(safePatch);
  });
  ipcMain.handle("dashboard:transition-state", async (_event, payload) => {
    const allowed = {
      idle: ["running"],
      running: ["paused", "stopping", "error", "idle"],
      paused: ["running", "stopping", "error", "idle"],
      stopping: ["idle", "error"],
      error: ["idle", "running"]
    };
    const current = readJsonFile(config.runtimeStatePath, {});
    const from = current.status || "idle";
    const to = String(payload?.status || from);
    if (to !== from && !(allowed[from] || []).includes(to)) {
      return { ok: false, reason: "invalid_transition", from, to, current };
    }
    const next = updateRuntimeState({ ...sanitizeRuntimePatch(payload?.patch || {}), status: to });
    return { ok: true, state: next };
  });
  ipcMain.handle("dashboard:append-log", async (_event, payload) => {
    appendJsonLine(config.sessionLogPath, payload || {});
    return { ok: true };
  });
  ipcMain.handle("progress:get-state", async () => readJsonFile(config.progressStatePath, {}));
  ipcMain.handle("progress:save-state", async (_event, payload) => {
    if (!isValidProgressPayload(payload)) {
      return { ok: false, reason: "invalid_payload" };
    }
    writeJsonFile(config.progressStatePath, payload);
    return { ok: true };
  });
  ipcMain.handle("progress:save-state-versioned", async (_event, payload) => {
    if (!isValidProgressPayload(payload?.state)) {
      return { ok: false, reason: "invalid_payload" };
    }
    return updateJsonFileVersioned(
      config.progressStatePath,
      () => ({ ...(payload?.state || {}) }),
      {
        expectedVersion: payload?.expectedVersion,
        fallback: {}
      }
    );
  });

  createWindow();

  staleRunMonitor = setInterval(() => {
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    const heartbeatAt = runtimeState.runtimeDiagnostics?.heartbeatAt;
    if (!runtimeState.processRunning || !heartbeatAt) {
      return;
    }
    const staleMs = Date.now() - new Date(heartbeatAt).getTime();
    if (Number.isFinite(staleMs) && staleMs > 120_000) {
      appendJsonLine(config.sessionLogPath, {
        event: "stale_run_detected",
        warningCode: "HEARTBEAT_STALE",
        source: "electron.staleRunMonitor",
        staleMs,
        heartbeatAt
      });
      updateRuntimeState({
        status: "error",
        processRunning: false,
        lastAction: "Run heartbeat stale; moved to safe error state",
        runtimeDiagnostics: {
          ...(runtimeState.runtimeDiagnostics || {}),
          lastSelectorFailure: "heartbeat_timeout"
        }
      });
    }
  }, 20_000);

  scheduleMonitor = setInterval(() => {
    const runtimeState = readJsonFile(config.runtimeStatePath, {});
    const scheduledRun = runtimeState.scheduledRun;
    if (!scheduledRun?.enabled || scheduledRun.status !== "pending" || !scheduledRun.scheduledForIso) {
      return;
    }
    const dueMs = new Date(scheduledRun.scheduledForIso).getTime();
    if (!Number.isFinite(dueMs) || Date.now() < dueMs) {
      return;
    }
    if (runtimeState.processRunning) {
      const skipped = {
        ...scheduledRun,
        enabled: false,
        status: "skipped_running",
        lastTriggeredAt: new Date().toISOString(),
        triggerToken: null
      };
      updateRuntimeState({ scheduledRun: skipped });
      appendJsonLine(config.sessionLogPath, {
        event: "schedule_skipped_running",
        warningCode: "SCHEDULE_SKIPPED_ALREADY_RUNNING",
        source: "electron.scheduleMonitor",
        scheduledForIso: scheduledRun.scheduledForIso
      });
      return;
    }
    const triggerToken = `schedule-${Date.now()}`;
    const triggered = {
      ...scheduledRun,
      enabled: false,
      status: "triggered_pending_ui",
      lastTriggeredAt: new Date().toISOString(),
      triggerToken
    };
    updateRuntimeState({ scheduledRun: triggered });
    appendJsonLine(config.sessionLogPath, {
      event: "schedule_triggered",
      scheduledForIso: scheduledRun.scheduledForIso,
      triggerToken
    });
  }, 1_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (staleRunMonitor) {
    clearInterval(staleRunMonitor);
    staleRunMonitor = null;
  }
  if (scheduleMonitor) {
    clearInterval(scheduleMonitor);
    scheduleMonitor = null;
  }
  if (botProcess) {
    botProcess.kill();
    botProcess = null;
  }
  updateRuntimeState({
    status: "idle",
    paused: false,
    processRunning: false,
    nextPlannedExitAt: null
  });
  if (process.platform !== "darwin") {
    app.quit();
  }
});
