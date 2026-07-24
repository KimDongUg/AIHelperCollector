/**
 * ISOLATED world 스크립트 — chrome.storage 접근, fetch() 실행, 버튼 UI, CSV 다운로드 담당.
 * main-world.js와는 window.postMessage로 통신.
 */
(function () {
  let reqCounter = 0;
  const pending = {};
  let capturedTemplate = null; // URLSearchParams (div_106.ajax 원본 body에서 추출)

  // 확인된 항목 코드 → 한글 라벨 (미확인 코드는 코드 번호 그대로 사용)
  // 2026-07-24: 지난달(라벨 있음) vs 이번달(코드만 있음) 844세대 금액 상관분석으로 추정.
  // ratio~1.000인 고정비 항목은 확정, 사용량성 항목(전기/전력기금/급탕)은 유일 후보로 채택.
  const ITEM_LABELS = {
    '06': '일반관리비',
    '08': '소독비',
    '09': '승강기유지비',
    '11': '장기수선충당금',
    '12': '법정의무점검비',
    '14': '건물보험료',
    '22': 'TV수신료',
    '24': '세대수도료',
    '26': '하수도료',
    '28': '기본냉난방비',
    '31': '물이용부담금',
    '35': '청소용품비',
    '19': '세대전기료',
    '23': '세대전력기금',
    '30': '세대급탕비',
  };

  const FEE_DETAIL_URL = 'https://ags4.xperp.co.kr/impo/impo_703m01_div_106.ajax';

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__aihelper) return;

    if (msg.kind === 'template' && !capturedTemplate) {
      try {
        capturedTemplate = new URLSearchParams(msg.body);
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
      try { capturedTemplate = new URLSearchParams(saved.aihelper_template); } catch (e) {}
    }
    return capturedTemplate;
  }

  // 항상 impo_703m01_div_106.ajax(항목별 부과내역)로 고정 호출.
  // 예전엔 div_106/div_107을 정규식으로 같이 잡아서 엉뚱한 템플릿을 캡처하는 버그가 있었음.
  async function fetchUnitDetail(aptNo, aptRoom) {
    const tpl = await ensureTemplate();
    if (!tpl) return null;

    const p = new URLSearchParams(tpl);
    const combo = `${aptNo}${aptRoom}`;
    p.set('APT_NO_RM_FR', combo);
    p.set('APT_NO_RM_TO', combo);
    p.set('STRAPTNO_FR', aptNo);
    p.set('STRAPTRM_FR', aptRoom);

    try {
      const res = await fetch(`${FEE_DETAIL_URL}?${p.toString()}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: p.toString(),
        credentials: 'include',
      });
      const json = await res.json();
      return Array.isArray(json.Data) ? json.Data : [];
    } catch (e) {
      return null;
    }
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

      const detail = await fetchUnitDetail(r.aptNo, r.aptRoom);
      if (Array.isArray(detail)) {
        for (const d of detail) {
          const label = ITEM_LABELS[d.IMPS_ITEM_CD] || d.IMPS_ITEM_CD;
          const key = `항목_${label}`;
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
