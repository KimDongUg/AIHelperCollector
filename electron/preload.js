const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getErpUrl: () => ipcRenderer.invoke('get-erp-url'),
  openErpBrowser: (port, erpUrl) => ipcRenderer.invoke('open-erp-browser', port, erpUrl),
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
