const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let mainWindow;
let collectorProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 780,
    resizable: false,
    title: 'AI Helper 수집기',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (collectorProcess) collectorProcess.kill();
  app.quit();
});

// ERP URL 읽기
ipcMain.handle('get-erp-url', () => process.env.ERP_URL || '');

// ERP 브라우저 열기
ipcMain.handle('open-erp', async () => {
  const { openERP } = require('../playwright/browser');
  try {
    await openERP(process.env.ERP_URL);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 수집 시작
ipcMain.handle('start-collect', async () => {
  const { runCollect } = require('../playwright/collector');
  try {
    const outputDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const result = await runCollect((progress) => {
      mainWindow.webContents.send('progress-update', progress);
    });
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 수집 중단
ipcMain.handle('stop-collect', async () => {
  const { stopCollect } = require('../playwright/collector');
  stopCollect();
  return { ok: true };
});

// 엑셀 파일 열기
ipcMain.handle('open-excel', async (_e, filePath) => {
  shell.openPath(filePath);
});

// 저장 폴더 선택
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '저장 위치 선택',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// AI Helper 업로드
ipcMain.handle('upload-to-server', async (_e, filePath) => {
  const { uploadFile } = require('../playwright/uploader');
  try {
    const result = await uploadFile(filePath, process.env.AIHELPER_UPLOAD_URL, process.env.AIHELPER_API_KEY);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 로그 폴더 열기
ipcMain.handle('open-logs', () => {
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  shell.openPath(logsDir);
});
