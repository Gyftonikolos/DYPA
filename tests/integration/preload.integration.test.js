const assert = require("assert");
const Module = require("module");

function main() {
  const originalLoad = Module._load;
  let exposedApi = null;
  const invokedChannels = [];
  const onSubscriptions = [];
  const removedSubscriptions = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: {
          exposeInMainWorld: (_name, api) => {
            exposedApi = api;
          }
        },
        ipcRenderer: {
          invoke: async (channel) => {
            invokedChannels.push(channel);
            return { ok: true };
          },
          on: (channel, listener) => {
            onSubscriptions.push({ channel, listener });
          },
          removeListener: (channel, listener) => {
            removedSubscriptions.push({ channel, listener });
          }
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const preloadPath = require.resolve("../../electron/preload.js");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  assert.ok(exposedApi, "preload should expose desktopApi");
  assert.strictEqual(typeof exposedApi.getSettings, "function");
  assert.strictEqual(typeof exposedApi.saveSettings, "function");
  assert.strictEqual(typeof exposedApi.onWebviewWindowOpen, "function");
  assert.strictEqual(typeof exposedApi.onWebviewJsDialog, "function");

  exposedApi.getSettings();
  exposedApi.getState();
  const unsubscribe = exposedApi.onWebviewWindowOpen(() => {});
  const unsubscribeDialog = exposedApi.onWebviewJsDialog(() => {});
  assert.ok(onSubscriptions.some((entry) => entry.channel === "embedded:webview-window-open"));
  assert.ok(onSubscriptions.some((entry) => entry.channel === "embedded:webview-js-dialog"));
  assert.strictEqual(typeof unsubscribe, "function");
  assert.strictEqual(typeof unsubscribeDialog, "function");
  unsubscribe();
  unsubscribeDialog();
  assert.ok(removedSubscriptions.some((entry) => entry.channel === "embedded:webview-window-open"));
  assert.ok(removedSubscriptions.some((entry) => entry.channel === "embedded:webview-js-dialog"));
  assert.ok(invokedChannels.includes("settings:get"));
  assert.ok(invokedChannels.includes("dashboard:get-state"));
  console.log("preload integration tests passed");
}

main();
