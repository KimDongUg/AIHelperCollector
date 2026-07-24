/**
 * ISOLATED world 스크립트 — chrome.storage 접근, fetch() 실행, 버튼 UI, CSV 다운로드 담당.
 * main-world.js와는 window.postMessage로 통신.
 */
(function () {
  let reqCounter = 0;
  const pending = {};
  const DEBUG_CAP_LIMIT = 80;
  let debugCaptures = []; // [{divNo, url, requestBody, responseText, ts}] — 디버그 다운로드용
  let latestDiv107Text = null; // 세대 클릭 시 XpERP가 통째로 내려주는 전체 세대 벌크 응답(원본)

  // 항목 코드 → 한글 라벨. div_3.ajax(XpERP 자체 항목코드 마스터 데이터, 2026-07-24
  // 디버그 캡처로 확인) 기준 06~36 전체 확정값 — 더 이상 추정이 아님.
  const ITEM_LABELS = {
    '06': '일반관리비', '07': '청소비', '08': '소독비', '09': '승강기유지비',
    '10': '수선유지비', '11': '장기수선충당금', '12': '법정의무점검비', '13': '제경비',
    '14': '건물보험료', '15': '제경비(비과세)', '16': '소상공인지원금', '17': '공동전력기금',
    '18': '냉난방동력전기', '19': '세대전기료', '20': '공동전기료', '21': '승강기전기',
    '22': 'TV수신료', '23': '세대전력기금', '24': '세대수도료', '25': '공동수도료',
    '26': '하수도료', '27': '세대난방비', '28': '기본냉난방비', '29': '공동냉난방비',
    '30': '세대급탕비', '31': '물이용부담금', '32': '이주정산/과입금', '33': '세대냉방비',
    '34': '바우처할인', '35': '청소용품비', '36': '에너지캐쉬백',
  };

  // div_107 응답의 METERn/USE_QTYn 인덱스 ↔ 검침 항목, 단가 계산에 쓸 항목 코드
  // (div_2.ajax 검침 마스터의 CD_CODE 01~05 순서와 일치, 2026-07-24 실측 검증:
  //  METER1 단가 ≈184원/kWh, METER3 단가 ≈665~670원/톤로 3세대 이상 교차확인)
  const METER_MAP = [
    { idx: 1, key: '전기', code: '19' },
    { idx: 2, key: '온수', code: '30' },
    { idx: 3, key: '수도', code: '24' },
    { idx: 4, key: '난방', code: '27' },
    { idx: 5, key: '냉방', code: '33' },
  ];

  // div_107 청구서 요약 필드 ↔ 백엔드 _SUMMARY_KEYS 라벨 (2026-07-24 실측 검증:
  // TAX_SUM+TAX_VALUE+TAX_FREE_SUM ≈ CURR_SUM, TAX_VALUE/TAX_SUM≈10%로 VAT 확인)
  const SUMMARY_FIELD_MAP = {
    '관리비소계': 'MNG_EXP_SUM',
    '징수대행소계': 'IM_PROXY_SUM',
    '합계(납기내)': 'DLY_APP_SUM',
    '연체료(납기후)': 'DLY_AFT_SUM',
    '공급가액': 'TAX_SUM',
    '부가가치세': 'TAX_VALUE',
    '비과세합계': 'TAX_FREE_SUM',
  };

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__aihelper) return;

    if (msg.kind === 'response' && pending[msg.reqId]) {
      pending[msg.reqId](msg);
      delete pending[msg.reqId];
    }

    if (msg.kind === 'debug_capture') {
      debugCaptures.push({
        divNo: msg.divNo, url: msg.url, requestBody: msg.requestBody,
        responseText: msg.responseText, ts: Date.now(),
      });
      if (debugCaptures.length > DEBUG_CAP_LIMIT) debugCaptures.shift();
      chrome.storage.local.set({ aihelper_debug_captures: debugCaptures });

      if (msg.divNo === '107') latestDiv107Text = msg.responseText;
    }
  });

  function requestFromPage(action, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const reqId = ++reqCounter;
      pending[reqId] = resolve;
      window.postMessage({ __aihelper: true, kind: 'request', action, reqId }, '*');
      setTimeout(() => {
        if (pending[reqId]) { pending[reqId]({}); delete pending[reqId]; }
      }, timeoutMs);
    });
  }

  function makeButton(label, bottom, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', bottom: bottom + 'px', zIndex: 2147483647,
      padding: '10px 16px', background: '#1565C0', color: '#fff', border: 'none',
      borderRadius: '6px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.35)',
    });
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    return btn;
  }

  function toCSV(rows, headers) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(esc).join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    return '﻿' + lines.join('\r\n');
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // 세대 클릭 시 동시에 호출되는 div_1/2/3/55/106/107 등의 원본 응답을
  // 지금까지 캡처된 만큼 JSON으로 다운로드 (검침값·청구서 요약값이 어느 div에 있는지 조사용).
  // 관리비조회 화면에서 세대 여러 개를 평소처럼 클릭해본 뒤 이 버튼을 누르면 됨.
  function downloadDebugCaptures(btn) {
    if (!debugCaptures.length) {
      btn.textContent = '캡처된 게 없음 — 세대를 먼저 클릭하세요';
      setTimeout(() => { btn.textContent = '디버그 원본 다운로드'; }, 3000);
      return;
    }
    const byDiv = {};
    for (const c of debugCaptures) (byDiv[c.divNo] = byDiv[c.divNo] || []).push(c);
    const text = JSON.stringify({ capturedAt: new Date().toISOString(), byDiv }, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    a.href = url; a.download = `aihelper_debug_${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    btn.textContent = `다운로드 완료 (${debugCaptures.length}건)`;
    setTimeout(() => { btn.textContent = '디버그 원본 다운로드'; }, 3000);
  }

  async function collectResidents(btn) {
    btn.disabled = true;
    btn.textContent = '입주자 읽는 중...';
    const resp = await requestFromPage('READ_RESIDENT_SHEET');
    const result = resp.result || {};
    await chrome.storage.local.set({ aihelper_residents: result });
    btn.textContent = `입주자 수집 완료 (${Object.keys(result).length}건)`;
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '입주자 수집'; }, 3000);
  }

  async function collectFees(btn) {
    btn.disabled = true;
    btn.textContent = '읽는 중...';
    const resp = await requestFromPage('READ_FEE_SHEET');
    const rows = resp.rows || [];
    if (!rows.length) {
      btn.textContent = '동호내역 없음 — 조회 먼저 눌러주세요';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '관리비 수집'; }, 3000);
      return;
    }

    // div_107(전체 세대 벌크 응답)은 세대를 1개만 클릭해도 XpERP가 자동으로
    // 같이 호출해줌 — 예전처럼 세대마다 반복 조회할 필요 없음.
    if (!latestDiv107Text) {
      btn.textContent = '세대 하나를 먼저 클릭해주세요';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '관리비 수집'; }, 3000);
      return;
    }

    let bulkData;
    try {
      bulkData = JSON.parse(latestDiv107Text).Data;
    } catch (e) {
      bulkData = null;
    }
    if (!Array.isArray(bulkData) || !bulkData.length) {
      btn.textContent = '전체 데이터 파싱 실패 — 세대를 다시 클릭해주세요';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '관리비 수집'; }, 3000);
      return;
    }

    const stored = await chrome.storage.local.get('aihelper_residents');
    const residents = stored.aihelper_residents || {};

    // IBSheet 동호내역(rows)을 APT_NO+APT_ROOM 내부코드 기준으로 lookup화
    // (div_107 응답도 같은 내부코드로 세대를 식별하므로 이 키로 매칭)
    const sheetByKey = {};
    for (const r of rows) sheetByKey[`${r.aptNo}${r.aptRoom}`] = r;

    const out = [];
    const itemKeys = new Set();
    for (const d of bulkData) {
      if (!d.APT_NO || d.APT_NO === '0000' || !d.APT_ROOM || d.APT_ROOM === '0000') continue; // 전체 집계행 제외
      const r = sheetByKey[`${d.APT_NO}${d.APT_ROOM}`];
      if (!r) continue;

      const dong = parseInt(r.vApt || r.aptNo, 10);
      const ho = parseInt(r.vRoom, 10) || '';
      const resident = residents[`${dong}-${ho}`] || {};

      const row = {
        동: dong, 호: ho,
        이름: r.name || '', 소유주: r.owner || '',
        휴대폰: resident.phone || '',
        분양면적: r.sellPyong || resident.sellArea || '',
        전용면적: resident.exclusiveArea || '',
        입주일: r.occuDate || '',
        당월부과액: r.imps19 || '',
      };

      // 항목별 부과내역 (ITEM_AMT1~40 와이드포맷 → 라벨 있는 06~36만 사용)
      for (const code in ITEM_LABELS) {
        const amt = d[`ITEM_AMT${parseInt(code, 10)}`];
        if (amt === undefined || amt === null || amt === '' || Number(amt) === 0) continue;
        const key = `항목_${ITEM_LABELS[code]}`;
        row[key] = amt;
        itemKeys.add(key);
      }

      // 청구서 요약값
      for (const label in SUMMARY_FIELD_MAP) {
        const v = d[SUMMARY_FIELD_MAP[label]];
        if (v === undefined || v === null || v === '') continue;
        row[label] = v;
        itemKeys.add(label);
      }
      if (d.DLY_APP_SUM != null && d.DLY_AFT_SUM != null) {
        row['합계(납기후)'] = Number(d.DLY_APP_SUM) + Number(d.DLY_AFT_SUM);
        itemKeys.add('합계(납기후)');
      }

      // 검침내역(사용량) — 단가는 항목 금액÷사용량으로 역산
      for (const m of METER_MAP) {
        const use = Number(d[`USE_QTY${m.idx}`] || 0);
        const amt = Number(d[`ITEM_AMT${m.code}`] || 0);
        if (!use && !amt) continue;
        row[`검침_${m.key}_전월`] = d[`BEF_METER${m.idx}`];
        row[`검침_${m.key}_당월`] = d[`CURR_METER${m.idx}`];
        row[`검침_${m.key}_요금`] = use > 0 ? Math.round(amt / use) : '';
        itemKeys.add(`검침_${m.key}_전월`);
        itemKeys.add(`검침_${m.key}_당월`);
        itemKeys.add(`검침_${m.key}_요금`);
      }

      out.push(row);
    }

    const headers = ['동', '호', '이름', '소유주', '휴대폰', '분양면적', '전용면적', '입주일', '당월부과액',
      ...Array.from(itemKeys).sort()];
    const csv = toCSV(out, headers);
    const now = new Date();
    const ym = resp.yymm || `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    download(`관리비데이터_${ym}.csv`, csv);

    btn.textContent = `완료 (${out.length}건) — 다시 수집`;
    btn.disabled = false;
  }

  // XpERP는 탭 전환 시 이전 화면의 iframe을 파괴/숨김(display:none) 하지 않고
  // 겹쳐서(z-index/absolute) 쌓아두는 방식이라 offsetParent/크기만으로는 구분이 안 됨.
  // → iframe 중앙 좌표에서 실제로 "맨 위에 그려지는 요소"가 이 iframe 자신인지 확인.
  function isFrameVisible() {
    if (window === window.top) return false; // 최상위 프레임엔 실제 데이터가 없음(하위 iframe 소관)
    const el = window.frameElement;
    if (!el) return false;
    if (el.offsetParent === null) return false; // display:none 계열로 숨겨짐
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const topEl = window.parent.document.elementFromPoint(cx, cy);
      return topEl === el || el.contains(topEl);
    } catch (e) {
      return true; // 부모 문서 접근 불가 시 기존 판정으로 폴백
    }
  }

  function removeButtons() {
    document.getElementById('__aihelper_res_btn')?.remove();
    document.getElementById('__aihelper_fee_btn')?.remove();
    document.getElementById('__aihelper_debug_btn')?.remove();
  }

  async function checkAndInjectButtons() {
    if (!isFrameVisible()) {
      removeButtons();
      return;
    }

    if (!document.getElementById('__aihelper_res_btn')) {
      const resp = await requestFromPage('READ_RESIDENT_SHEET');
      if (!isFrameVisible()) { removeButtons(); return; } // 응답 대기 중 탭이 바뀌었을 수 있음
      if (resp.result && Object.keys(resp.result).length > 0) {
        const b = makeButton('입주자 수집', 90, () => collectResidents(b));
        b.id = '__aihelper_res_btn';
      }
    }
    if (!document.getElementById('__aihelper_fee_btn')) {
      const resp = await requestFromPage('READ_FEE_SHEET');
      if (!isFrameVisible()) { removeButtons(); return; }
      if (resp.rows && resp.rows.length > 0) {
        const b = makeButton('관리비 수집', 30, () => collectFees(b));
        b.id = '__aihelper_fee_btn';
      }
    }
    if (!document.getElementById('__aihelper_debug_btn')) {
      const b = makeButton('디버그 원본 다운로드', 150, () => downloadDebugCaptures(b));
      b.id = '__aihelper_debug_btn';
      b.style.background = '#555';
    }
  }

  function init() {
    checkAndInjectButtons();
    setInterval(checkAndInjectButtons, 2000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
