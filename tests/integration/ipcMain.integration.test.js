const assert = require("assert");
const Module = require("module");
const path = require("path");
const { makeTempDir, cleanupDir } = require("../helpers/testUtils");

async function main() {
  const tempDir = makeTempDir("dypa-ipc-int-");
  const originalLoad = Module._load;
  const originalEnv = { ...process.env };
  const handlers = {};

  process.env.DYPA_SETTINGS_DIR = path.join(tempDir, "settings");
  process.env.PROGRESS_STATE_PATH = path.join(tempDir, "progress-state.json");
  process.env.RUNTIME_STATE_PATH = path.join(tempDir, "runtime-state.json");
  process.env.SESSION_LOG_PATH = path.join(tempDir, "session-log.jsonl");

  const fakeApp = {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {}
  };
  const fakeIpcMain = {
    handle: (channel, fn) => {
      handlers[channel] = fn;
    }
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

  try {
    const mainPath = require.resolve("../../electron/main.js");
    delete require.cache[mainPath];
    require(mainPath);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(handlers["settings:get"]);
    assert.ok(handlers["settings:save"]);
    assert.ok(handlers["session:resolve-range"]);
    assert.ok(handlers["session:pick-minutes"]);
    assert.ok(handlers["dashboard:get-app-config"]);
    const appConfig = await handlers["dashboard:get-app-config"]();
    assert.strictEqual(
      appConfig.elearningAutologinUrl,
      "https://elearning.golearn.gr/local/mdl_autologin/autologin.php"
    );

    const settingsGet = await handlers["settings:get"]();
    assert.ok(settingsGet.settings);
    assert.strictEqual(settingsGet.settings.featureFlags.ui.simpleMode, false);

    const settingsSave = await handlers["settings:save"](null, {
      timeoutMs: 30000,
      scormSessionMinMinutes: 38,
      scormSessionMaxMinutes: 41,
      dailyScormLimitMinutes: 350,
      credentials: { username: "u", password: "p" },
      featureFlags: {
        ui: { simpleMode: true, lightTheme: true }
      }
    });
    assert.strictEqual(settingsSave.ok, true);
    assert.strictEqual(settingsSave.settings.featureFlags.ui.simpleMode, true);

    const range = await handlers["session:resolve-range"](null, {
      progressState: {},
      configLike: { scormSessionMinMinutes: 38, scormSessionMaxMinutes: 41 }
    });
    assert.strictEqual(range.min, 38);
    assert.strictEqual(range.max, 41);

    const picked = await handlers["session:pick-minutes"](null, {
      range: { min: 38, max: 41 },
      remainingMinutes: 39
    });
    assert.ok(picked >= 1 && picked <= 39);
    console.log("ipcMain integration tests passed");
  } finally {
    Module._load = originalLoad;
    process.env = originalEnv;
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
