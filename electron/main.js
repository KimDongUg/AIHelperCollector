const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 820,
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
  const { disconnectBrowser } = require('../playwright/browser');
  disconnectBrowser().catch(() => {});
  app.quit();
});

// ERP URL 읽기
ipcMain.handle('get-erp-url', () => process.env.ERP_URL || '');

// ERP 브라우저 열기 (remote-debugging 모드로 Edge/Chrome 실행, ERP URL로 바로 이동)
ipcMain.handle('open-erp-browser', async (_e, port, erpUrl) => {
  const cdpPort = port || 9222;
  const url = erpUrl || process.env.ERP_URL || '';
  const urlArg = url ? ` "${url}"` : '';
  // --user-data-dir로 기존 Edge와 분리된 CDP 전용 인스턴스 실행
  const profileDir = `%LOCALAPPDATA%\\AIHelperCollector\\erp-cdp-profile`;
  const flags = `--remote-debugging-port=${cdpPort} --user-data-dir="${profileDir}" --no-first-run`;

  return new Promise((resolve) => {
    exec(`start msedge ${flags}${urlArg}`, { shell: true }, (err) => {
      if (!err) { resolve({ ok: true }); return; }
      exec(`start chrome ${flags}${urlArg}`, { shell: true }, (err2) => {
        if (!err2) { resolve({ ok: true }); return; }
        resolve({ ok: false, error: 'Edge 또는 Chrome이 설치되어 있지 않습니다.' });
      });
    });
  });
});

// ERP 브라우저 CDP 연결
ipcMain.handle('connect-erp', async (_e, port) => {
  const { connectERP } = require('../playwright/browser');
  try {
    return await connectERP(port);
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
    return await uploadFile(filePath, process.env.AIHELPER_UPLOAD_URL, process.env.AIHELPER_API_KEY);
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
