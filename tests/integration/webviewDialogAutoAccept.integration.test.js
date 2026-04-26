const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const { makeTempDir, cleanupDir } = require("../helpers/testUtils");

async function main() {
  const tempDir = makeTempDir("dypa-webview-dialog-int-");
  const runtimeStatePath = path.join(tempDir, "runtime-state.json");
  const progressStatePath = path.join(tempDir, "progress-state.json");
  const sessionLogPath = path.join(tempDir, "session-log.jsonl");
  const originalLoad = Module._load;
  const originalEnv = { ...process.env };
  const appListeners = {};
  const windows = [];
  const handlers = {};

  process.env.DYPA_SETTINGS_DIR = path.join(tempDir, "settings");
  process.env.PROGRESS_STATE_PATH = progressStatePath;
  process.env.RUNTIME_STATE_PATH = runtimeStatePath;
  process.env.SESSION_LOG_PATH = sessionLogPath;

  const fakeApp = {
    whenReady: () => Promise.resolve(),
    on: (eventName, callback) => {
      appListeners[eventName] = callback;
    },
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
      windows.push(this);
    }
    loadFile() {}
    on() {}
    static getAllWindows() {
      return windows;
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

    assert.ok(handlers["dashboard:get-state"]);
    assert.strictEqual(typeof appListeners["web-contents-created"], "function");

    let jsDialogListener = null;
    const windowOpenSent = [];
    const dialogSent = [];
    windows[0].webContents.send = (channel, payload) => {
      if (channel === "embedded:webview-window-open") {
        windowOpenSent.push(payload);
      }
      if (channel === "embedded:webview-js-dialog") {
        dialogSent.push(payload);
      }
    };

    const fakeContents = {
      setWindowOpenHandler: (handler) => {
        fakeContents.windowOpenHandler = handler;
      },
      on: (eventName, listener) => {
        if (eventName === "javascript-dialog-opening") {
          jsDialogListener = listener;
        }
      },
      getURL: () => "https://elearning.golearn.gr/mod/scorm/player.php"
    };
    appListeners["web-contents-created"]({}, fakeContents);

    assert.strictEqual(typeof fakeContents.windowOpenHandler, "function");
    assert.strictEqual(typeof jsDialogListener, "function");

    fakeContents.windowOpenHandler({
      url: "https://elearning.golearn.gr/course/view.php?id=7378#section-3",
      referrer: { url: "https://edu.golearn.gr/training/trainee/training" }
    });
    assert.strictEqual(windowOpenSent.length, 1);

    let prevented = false;
    let callbackValue = null;
    jsDialogListener(
      {
        preventDefault: () => {
          prevented = true;
        }
      },
      {
        type: "alert",
        messageText: "You should refresh your page to keep time counting.",
        url: "https://elearning.golearn.gr/mod/scorm/player.php"
      },
      (accepted) => {
        callbackValue = accepted;
      }
    );

    assert.strictEqual(prevented, true);
    assert.strictEqual(callbackValue, true);
    assert.strictEqual(dialogSent.length, 1);
    assert.strictEqual(dialogSent[0].dialogType, "alert");
    assert.strictEqual(dialogSent[0].autoAccepted, true);

    const logContent = fs.existsSync(sessionLogPath) ? fs.readFileSync(sessionLogPath, "utf8") : "";
    assert.ok(logContent.includes('"event":"webview_javascript_dialog_auto_accepted"'));
    console.log("webview dialog auto-accept integration tests passed");
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
