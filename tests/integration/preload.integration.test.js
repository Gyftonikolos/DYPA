const assert = require("assert");
const Module = require("module");

function main() {
  const originalLoad = Module._load;
  let exposedApi = null;
  const invokedChannels = [];
  let onSubscription = null;
  let removedSubscription = null;

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
            onSubscription = { channel, listener };
          },
          removeListener: (channel, listener) => {
            removedSubscription = { channel, listener };
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

  exposedApi.getSettings();
  exposedApi.getState();
  const unsubscribe = exposedApi.onWebviewWindowOpen(() => {});
  assert.strictEqual(onSubscription.channel, "embedded:webview-window-open");
  assert.strictEqual(typeof unsubscribe, "function");
  unsubscribe();
  assert.strictEqual(removedSubscription.channel, "embedded:webview-window-open");
  assert.ok(invokedChannels.includes("settings:get"));
  assert.ok(invokedChannels.includes("dashboard:get-state"));
  console.log("preload integration tests passed");
}

main();
