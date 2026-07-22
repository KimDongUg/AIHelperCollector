/**
 * ISOLATED world 스크립트 — chrome.storage 접근, 버튼 UI, CSV 다운로드 담당.
 * main-world.js와는 window.postMessage로 통신.
 */
(function () {
  let reqCounter = 0;
  const pending = {};

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__aihelper) return;
    if (msg.kind === 'response' && pending[msg.reqId]) {
      pending[msg.reqId](msg);
      delete pending[msg.reqId];
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

    const stored = await chrome.storage.local.get('aihelper_residents');
    const residents = stored.aihelper_residents || {};

    const out = [];
    const amtKeys = new Set();
    for (const r of rows) {
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
      for (const [k, v] of Object.entries(r.amtFields || {})) {
        row[k] = v;
        amtKeys.add(k);
      }
      out.push(row);
    }

    const headers = ['동', '호', '이름', '소유주', '휴대폰', '분양면적', '전용면적', '입주일', '당월부과액',
      ...Array.from(amtKeys).sort()];
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
  }

  function init() {
    checkAndInjectButtons();
    setInterval(checkAndInjectButtons, 2000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
