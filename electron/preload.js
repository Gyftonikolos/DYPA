const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getState: () => ipcRenderer.invoke("dashboard:get-state"),
  getLogs: () => ipcRenderer.invoke("dashboard:get-logs"),
  getAnalytics: () => ipcRenderer.invoke("dashboard:get-analytics"),
  exportLogs: () => ipcRenderer.invoke("logs:export"),
  exportSupportBundle: () => ipcRenderer.invoke("support:bundle-export"),
  getAppConfig: () => ipcRenderer.invoke("dashboard:get-app-config"),
  startBot: () => ipcRenderer.invoke("bot:start"),
  stopBot: () => ipcRenderer.invoke("bot:stop"),
  updateState: (patch) => ipcRenderer.invoke("dashboard:update-state", patch),
  transitionState: (payload) => ipcRenderer.invoke("dashboard:transition-state", payload),
  appendLog: (payload) => ipcRenderer.invoke("dashboard:append-log", payload),
  getProgressState: () => ipcRenderer.invoke("progress:get-state"),
  saveProgressState: (payload) => ipcRenderer.invoke("progress:save-state", payload),
  saveProgressStateVersioned: (payload) => ipcRenderer.invoke("progress:save-state-versioned", payload),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  testSettings: (payload) => ipcRenderer.invoke("settings:test", payload),
  testLoginOnly: (payload) => ipcRenderer.invoke("auth:test-login", payload),
  resolveSessionRange: (payload) => ipcRenderer.invoke("session:resolve-range", payload),
  pickSessionMinutes: (payload) => ipcRenderer.invoke("session:pick-minutes", payload),
  resolveLessonSelection: (payload) => ipcRenderer.invoke("session:resolve-selection", payload),
  setScheduledRun: (payload) => ipcRenderer.invoke("schedule:set-next-run", payload),
  getScheduledRun: () => ipcRenderer.invoke("schedule:get"),
  clearScheduledRun: () => ipcRenderer.invoke("schedule:clear"),
  consumeScheduledTrigger: (payload) => ipcRenderer.invoke("schedule:consume-trigger", payload),
  onWebviewWindowOpen: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("embedded:webview-window-open", listener);
    return () => {
      ipcRenderer.removeListener("embedded:webview-window-open", listener);
    };
  }
});
