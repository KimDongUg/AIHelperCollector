const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openErpBrowser: (port) => ipcRenderer.invoke('open-erp-browser', port),
  connectERP: (port) => ipcRenderer.invoke('connect-erp', port),
  startCollect: () => ipcRenderer.invoke('start-collect'),
  stopCollect: () => ipcRenderer.invoke('stop-collect'),
  openExcel: (filePath) => ipcRenderer.invoke('open-excel', filePath),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  uploadToServer: (filePath) => ipcRenderer.invoke('upload-to-server', filePath),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  onProgress: (callback) => ipcRenderer.on('progress-update', (_e, data) => callback(data)),
  removeProgressListener: () => ipcRenderer.removeAllListeners('progress-update'),
});
