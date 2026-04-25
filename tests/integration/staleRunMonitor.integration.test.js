const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const { makeTempDir, cleanupDir } = require("../helpers/testUtils");

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const tempDir = makeTempDir("dypa-stale-monitor-int-");
  const runtimeStatePath = path.join(tempDir, "runtime-state.json");
  const progressStatePath = path.join(tempDir, "progress-state.json");
  const sessionLogPath = path.join(tempDir, "session-log.jsonl");
  const originalLoad = Module._load;
  const originalEnv = { ...process.env };
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const intervalCallbacks = [];

  process.env.DYPA_SETTINGS_DIR = path.join(tempDir, "settings");
  process.env.PROGRESS_STATE_PATH = progressStatePath;
  process.env.RUNTIME_STATE_PATH = runtimeStatePath;
  process.env.SESSION_LOG_PATH = sessionLogPath;

  const fakeApp = {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {}
  };
  const fakeIpcMain = {
    handle: () => {}
  };
  class FakeBrowserWindow {
    constructor() {
      this.webContents = {
        setWindowOpenHandler: () => ({ action: "deny" }),
        on: () => {},
        send: () => {}
      };
    }
    loadFile() {}
    on() {}
    static getAllWindows() {
      return [];
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return { app: fakeApp, BrowserWindow: FakeBrowserWindow, ipcMain: fakeIpcMain };
    }
    if (request === "playwright") {
      return {
        chromium: {
          launch: async () => ({
            newContext: async () => ({
              newPage: async () => ({
                setDefaultTimeout: () => {},
                goto: async () => {},
                locator: () => ({ fill: async () => {}, first: () => ({ click: async () => {} }) }),
                waitForLoadState: async () => {},
                url: () => "https://edu.golearn.gr/training/trainee/training"
              }),
              close: async () => {}
            }),
            close: async () => {}
          })
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  global.setInterval = (cb) => {
    intervalCallbacks.push(cb);
    return intervalCallbacks.length;
  };
  global.clearInterval = () => {};

  try {
    const mainPath = require.resolve("../../electron/main.js");
    delete require.cache[mainPath];
    require(mainPath);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(intervalCallbacks.length >= 1, "Expected stale monitor interval registration.");
    const staleMonitorTick = intervalCallbacks[0];
    assert.strictEqual(typeof staleMonitorTick, "function");

    fs.writeFileSync(
      runtimeStatePath,
      JSON.stringify(
        {
          status: "running",
          processRunning: true,
          runtimeDiagnostics: {
            heartbeatAt: new Date(Date.now() - 180_000).toISOString()
          }
        },
        null,
        2
      )
    );

    staleMonitorTick();

    const nextState = readJson(runtimeStatePath, {});
    assert.strictEqual(nextState.status, "error");
    assert.strictEqual(nextState.processRunning, false);
    assert.strictEqual(nextState.runtimeDiagnostics?.lastSelectorFailure, "heartbeat_timeout");

    const logContent = fs.existsSync(sessionLogPath) ? fs.readFileSync(sessionLogPath, "utf8") : "";
    assert.ok(logContent.includes('"event":"stale_run_detected"'));

    console.log("stale run monitor integration tests passed");
  } finally {
    Module._load = originalLoad;
    process.env = originalEnv;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    cleanupDir(tempDir);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
