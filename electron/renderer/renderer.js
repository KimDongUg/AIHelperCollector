let lastExcelPath = null;
let isCollecting = false;

const cdpPortInput     = document.getElementById('cdpPort');
const btnOpenErpBrowser = document.getElementById('btnOpenErpBrowser');
const btnConnectERP    = document.getElementById('btnConnectERP');
const connectStatus    = document.getElementById('connectStatus');
const btnStart         = document.getElementById('btnStart');
const btnStop          = document.getElementById('btnStop');
const btnOpenExcel     = document.getElementById('btnOpenExcel');
const btnUpload        = document.getElementById('btnUpload');
const btnOpenLogs      = document.getElementById('btnOpenLogs');
const progressSection  = document.getElementById('progressSection');
const resultSection    = document.getElementById('resultSection');
const progressFill     = document.getElementById('progressFill');
const progressCount    = document.getElementById('progressCount');
const progressPct      = document.getElementById('progressPct');
const currentUnit      = document.getElementById('currentUnit');
const statusDot        = document.getElementById('statusDot');
const statusText       = document.getElementById('statusText');
const failSection      = document.getElementById('failSection');
const failTitle        = document.getElementById('failTitle');
const failList         = document.getElementById('failList');

function setStatus(type, text) {
  statusDot.className = 'status-dot';
  if (type) statusDot.classList.add(type);
  statusText.textContent = text;
}

function showConnectStatus(type, text) {
  connectStatus.className = 'connect-status ' + type;
  connectStatus.textContent = text;
}

function hideConnectStatus() {
  connectStatus.className = 'connect-status';
  connectStatus.textContent = '';
}

// ERP 열기 — Edge/Chrome을 remote-debugging 모드로 실행
btnOpenErpBrowser.addEventListener('click', async () => {
  const port = parseInt(cdpPortInput.value, 10) || 9222;
  btnOpenErpBrowser.disabled = true;
  hideConnectStatus();
  setStatus('blue', 'ERP 브라우저 실행 중...');

  const result = await window.api.openErpBrowser(port);

  btnOpenErpBrowser.disabled = false;

  if (result.ok) {
    setStatus('orange', 'ERP 로그인 & 2차 인증 완료 후 [ERP 브라우저 연결]을 클릭하세요.');
  } else {
    setStatus('red', result.error || '브라우저 실행 실패');
  }
});

// ERP 브라우저 연결 — CDP로 연결 시도
btnConnectERP.addEventListener('click', async () => {
  const port = parseInt(cdpPortInput.value, 10) || 9222;
  btnConnectERP.disabled = true;
  hideConnectStatus();
  setStatus('blue', `CDP 연결 중 (포트 ${port})...`);

  const result = await window.api.connectERP(port);

  btnConnectERP.disabled = false;

  if (result.ok) {
    showConnectStatus('success', '✅ 현재 로그인된 ERP 연결 완료');
    btnStart.disabled = false;
    setStatus('green', 'ERP 연결됨 — 수집을 시작하세요.');
  } else if (result.error === 'no_browser') {
    showConnectStatus('error', '❌ ERP 브라우저를 먼저 실행해주세요');
    btnStart.disabled = true;
    setStatus('red', 'ERP 브라우저 미연결');
  } else if (result.error === 'no_erp_tab') {
    showConnectStatus('warning', '⚠️ ERP 페이지를 찾을 수 없습니다. 브라우저에서 ERP를 열어주세요');
    btnStart.disabled = true;
    setStatus('orange', 'ERP 탭 없음');
  } else {
    showConnectStatus('error', '❌ 연결 실패: ' + (result.error || '알 수 없는 오류'));
    btnStart.disabled = true;
    setStatus('red', '연결 실패');
  }
});

// 수집 시작
btnStart.addEventListener('click', async () => {
  isCollecting = true;
  btnStart.style.display = 'none';
  btnStop.style.display = 'block';
  btnStop.disabled = false;
  btnConnectERP.disabled = true;
  btnOpenErpBrowser.disabled = true;
  progressSection.classList.add('visible');
  resultSection.classList.remove('visible');
  lastExcelPath = null;
  setStatus('blue', '수집 중...');

  window.api.onProgress(handleProgress);

  const result = await window.api.startCollect();
  finishCollect(result);
});

// 수집 중단
btnStop.addEventListener('click', async () => {
  await window.api.stopCollect();
  setStatus('orange', '수집 중단됨');
  isCollecting = false;
  btnStop.style.display = 'none';
  btnStart.style.display = 'block';
  btnStart.disabled = false;
  btnConnectERP.disabled = false;
  btnOpenErpBrowser.disabled = false;
});

function handleProgress(data) {
  const { current, total, unit, done } = data;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressCount.textContent = `${current} / ${total} 세대`;
  progressPct.textContent = pct + '%';
  if (unit) currentUnit.textContent = `현재: ${unit}`;
  if (done) currentUnit.textContent = '완료!';
}

function finishCollect(result) {
  window.api.removeProgressListener();
  isCollecting = false;
  btnStop.style.display = 'none';
  btnStart.style.display = 'block';
  btnStart.disabled = false;
  btnConnectERP.disabled = false;
  btnOpenErpBrowser.disabled = false;

  if (result && result.ok) {
    lastExcelPath = result.filePath;
    resultSection.classList.add('visible');
    setStatus('green', `수집 완료 — ${result.total}세대 (실패 ${result.failed}세대)`);

    if (result.failedUnits && result.failedUnits.length > 0) {
      failSection.classList.add('visible');
      failTitle.textContent = `실패 세대 ${result.failedUnits.length}건`;
      failList.innerHTML = result.failedUnits.map((u) => `• ${u}`).join('<br>');
    }
    progressFill.style.width = '100%';
    progressCount.textContent = `${result.total} / ${result.total} 세대`;
    progressPct.textContent = '100%';
    currentUnit.textContent = '완료!';
  } else {
    setStatus('red', '수집 실패: ' + (result ? result.error : '알 수 없는 오류'));
  }
}

// 엑셀 열기
btnOpenExcel.addEventListener('click', () => {
  if (lastExcelPath) window.api.openExcel(lastExcelPath);
});

// 로그 보기
btnOpenLogs.addEventListener('click', () => window.api.openLogs());

// 업로드
btnUpload.addEventListener('click', async () => {
  if (!lastExcelPath) { setStatus('red', '업로드할 파일이 없습니다.'); return; }
  btnUpload.disabled = true;
  btnUpload.textContent = '업로드 중...';
  setStatus('blue', 'AI Helper 서버 업로드 중...');

  const result = await window.api.uploadToServer(lastExcelPath);

  btnUpload.disabled = false;
  btnUpload.textContent = 'AI Helper 업로드';

  if (result.ok) {
    setStatus('green', '업로드 완료!');
  } else {
    setStatus('red', '업로드 실패: ' + result.error);
  }
});
