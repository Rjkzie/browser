const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("quiet", {
  command: (action, data) => ipcRenderer.invoke("quiet:command", action, data),
  onState: (callback) =>
    ipcRenderer.on("quiet:state", (_e, value) => callback(value)),
  onFocusAddress: (callback) => ipcRenderer.on("quiet:focus-address", callback),
});
