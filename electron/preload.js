const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getState: () => ipcRenderer.invoke("dashboard:get-state"),
  getLogs: () => ipcRenderer.invoke("dashboard:get-logs"),
  getAppConfig: () => ipcRenderer.invoke("dashboard:get-app-config"),
  startBot: () => ipcRenderer.invoke("bot:start"),
  stopBot: () => ipcRenderer.invoke("bot:stop")
});
