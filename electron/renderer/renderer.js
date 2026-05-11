let lastExcelPath = null;
let isCollecting = false;

const erpUrlInput = document.getElementById('erpUrl');
const btnOpenERP = document.getElementById('btnOpenERP');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnOpenExcel = document.getElementById('btnOpenExcel');
const btnUpload = document.getElementById('btnUpload');
const btnOpenLogs = document.getElementById('btnOpenLogs');
const loginHint = document.getElementById('loginHint');
const progressSection = document.getElementById('progressSection');
const resultSection = document.getElementById('resultSection');
const progressFill = document.getElementById('progressFill');
const progressCount = document.getElementById('progressCount');
const progressPct = document.getElementById('progressPct');
const currentUnit = document.getElementById('currentUnit');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const failSection = document.getElementById('failSection');
const failTitle = document.getElementById('failTitle');
const failList = document.getElementById('failList');

function setStatus(type, text) {
  statusDot.className = 'status-dot';
  if (type === 'green') statusDot.classList.add('green');
  else if (type === 'blue') statusDot.classList.add('blue');
  else if (type === 'red') statusDot.classList.add('red');
  else if (type === 'orange') statusDot.classList.add('orange');
  statusText.textContent = text;
}

// ERP URL 로드
window.api.getErpUrl().then((url) => {
  if (url) erpUrlInput.value = url;
});

// ERP 열기
btnOpenERP.addEventListener('click', async () => {
  const url = erpUrlInput.value.trim();
  if (!url) { setStatus('red', 'ERP URL을 입력해주세요.'); return; }
  btnOpenERP.disabled = true;
  setStatus('blue', 'ERP 브라우저 실행 중...');
  const result = await window.api.openERP(url);
  if (result.ok) {
    loginHint.style.display = 'block';
    btnStart.disabled = false;
    setStatus('orange', 'ERP 로그인 후 [수집 시작]을 클릭하세요.');
  } else {
    setStatus('red', '브라우저 실행 실패: ' + result.error);
  }
  btnOpenERP.disabled = false;
});

// 수집 시작
btnStart.addEventListener('click', async () => {
  isCollecting = true;
  btnStart.style.display = 'none';
  btnStop.style.display = 'block';
  btnStop.disabled = false;
  btnOpenERP.disabled = true;
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
  btnOpenERP.disabled = false;
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
  btnOpenERP.disabled = false;

  if (result && result.ok) {
    lastExcelPath = result.filePath;
    resultSection.classList.add('visible');
    setStatus('green', `수집 완료 — ${result.total}세대 (실패 ${result.failed}세대)`);

    if (result.failedUnits && result.failedUnits.length > 0) {
      failSection.classList.add('visible');
      failTitle.textContent = `실패 세대 ${result.failedUnits.length}건`;
      failList.innerHTML = result.failedUnits.map(u => `• ${u}`).join('<br>');
    }
    // 진행률 100%
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
