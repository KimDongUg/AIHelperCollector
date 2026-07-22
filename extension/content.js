/**
 * ISOLATED world 스크립트 — chrome.storage 접근 및 fetch() 실행, 버튼 UI 담당.
 * main-world.js와는 window.postMessage로 통신.
 */
(function () {
  let capturedTemplate = null; // { url, params: URLSearchParams }
  let reqCounter = 0;
  const pending = {};

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__aihelper) return;

    if (msg.kind === 'template' && !capturedTemplate) {
      try {
        const params = new URLSearchParams(msg.body);
        capturedTemplate = { url: msg.url.split('?')[0], params };
        chrome.storage.local.set({ aihelper_template: msg.body });
      } catch (e) {}
    }

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

  async function ensureTemplate() {
    if (capturedTemplate) return capturedTemplate;
    const saved = await chrome.storage.local.get('aihelper_template');
    if (saved.aihelper_template) {
      try {
        capturedTemplate = {
          url: 'https://ags4.xperp.co.kr/impo/impo_703m01_div_106.ajax',
          params: new URLSearchParams(saved.aihelper_template),
        };
      } catch (e) {}
    }
    return capturedTemplate;
  }

  async function fetchUnitDetail(aptNo, aptRoom) {
    const tpl = await ensureTemplate();
    if (!tpl) return null;

    const p = new URLSearchParams(tpl.params);
    const combo = `${aptNo}${aptRoom}`;
    p.set('APT_NO_RM_FR', combo);
    p.set('APT_NO_RM_TO', combo);
    p.set('STRAPTNO_FR', aptNo);
    p.set('STRAPTRM_FR', aptRoom);

    try {
      const res = await fetch(`${tpl.url}?${p.toString()}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: p.toString(),
        credentials: 'include',
      });
      const text = await res.text();
      debugLog(aptNo, aptRoom, res.status, text);
      let json;
      try { json = JSON.parse(text); } catch (e) {
        console.warn('[AIHelper] JSON parse 실패', aptNo, aptRoom, text.slice(0, 200));
        return null;
      }
      if (!Array.isArray(json.Data)) {
        console.warn('[AIHelper] Data가 배열이 아님', aptNo, aptRoom, json);
        return [];
      }
      return json.Data;
    } catch (e) {
      console.warn('[AIHelper] fetch 실패', aptNo, aptRoom, e.message);
      return null;
    }
  }

  let __debugCount = 0;
  function debugLog(aptNo, aptRoom, status, text) {
    if (__debugCount >= 5) return;
    __debugCount++;
    console.log(`[AIHelper] #${__debugCount} ${aptNo}${aptRoom} status=${status}`, text.slice(0, 500));
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
    const resp = await requestFromPage('READ_FEE_SHEET');
    const rows = resp.rows || [];
    if (!rows.length) {
      btn.textContent = '동호내역 없음 — 조회 먼저 눌러주세요';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '관리비 수집'; }, 3000);
      return;
    }

    const tpl = await ensureTemplate();
    if (!tpl) {
      btn.textContent = '세대 하나를 먼저 클릭해주세요';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '관리비 수집'; }, 3000);
      return;
    }

    const stored = await chrome.storage.local.get('aihelper_residents');
    const residents = stored.aihelper_residents || {};

    const out = [];
    const itemKeys = new Set();
    let done = 0;
    for (const r of rows) {
      done++;
      btn.textContent = `수집 중 ${done}/${rows.length}`;
      const detail = await fetchUnitDetail(r.aptNo, r.aptRoom);

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
      if (Array.isArray(detail)) {
        for (const d of detail) {
          const key = `항목_${d.IMPS_ITEM_CD}`;
          row[key] = d.IMPS_AMT;
          itemKeys.add(key);
        }
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
