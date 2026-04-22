const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const config = require("../src/config");

let botProcess = null;

function readJsonFile(filePath, fallback) {
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

  return {
    ...runtimeState,
    todayMinutes:
      progressState.dailyProgress?.completedMinutes ?? runtimeState.todayMinutes ?? 0,
    dailyLimitMinutes:
      progressState.dailyScormLimitMinutes ??
      runtimeState.dailyLimitMinutes ??
      config.dailyScormLimitMinutes,
    lessonTotals:
      Object.keys(runtimeState.lessonTotals || {}).length > 0
        ? runtimeState.lessonTotals
        : progressState.lessonProgress || {},
    currentLesson:
      runtimeState.currentLesson || progressState.lastResolvedSectionId || null,
    processRunning: Boolean(runtimeState.processRunning ?? botProcess)
  };
}

function writeJsonFile(filePath, payload) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  fs.writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
    appendJsonLine(config.sessionLogPath, {
      event: "desktop_bot_stdout",
      message: String(chunk).trim()
    });
  });

  botProcess.stderr.on("data", (chunk) => {
    appendJsonLine(config.sessionLogPath, {
      event: "desktop_bot_stderr",
      message: String(chunk).trim()
    });
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
  updateRuntimeState({
    status: "idle",
    paused: false,
    processRunning: false,
    nextPlannedExitAt: null
  });

  ipcMain.handle("dashboard:get-state", async () => getDashboardPayload());
  ipcMain.handle("dashboard:get-logs", async () => readRecentLogs(config.sessionLogPath));
  ipcMain.handle("dashboard:get-app-config", async () => ({
    loginUrl: "https://edu.golearn.gr/login?returnUrl=%2f",
    trainingUrl: config.baseUrl,
    courseUrl: "https://elearning.golearn.gr/course/view.php?id=7378",
    timeoutMs: config.timeoutMs,
    maxScormSessionMinutes: config.maxScormSessionMinutes,
    dailyScormLimitMinutes: config.dailyScormLimitMinutes,
    credentials: config.credentials
  }));
  ipcMain.handle("bot:start", async () => startBotProcess());
  ipcMain.handle("bot:stop", async () => stopBotProcess());
  ipcMain.handle("dashboard:update-state", async (_event, patch) => updateRuntimeState(patch || {}));
  ipcMain.handle("dashboard:append-log", async (_event, payload) => {
    appendJsonLine(config.sessionLogPath, payload || {});
    return { ok: true };
  });
  ipcMain.handle("progress:get-state", async () => readJsonFile(config.progressStatePath, {}));
  ipcMain.handle("progress:save-state", async (_event, payload) => {
    writeJsonFile(config.progressStatePath, payload || {});
    return { ok: true };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
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
