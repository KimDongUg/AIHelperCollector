/**
 * MAIN world 스크립트 — 페이지의 실제 JS 컨텍스트에서 실행됨.
 * 1) XHR을 가로채서 관리비 상세조회(div_106/div_107.ajax) 요청의 viewInfo 템플릿을 확보
 * 2) window.IBSheet 데이터를 읽어 content.js(ISOLATED world)에 postMessage로 전달
 *
 * IBSheet 필드 값이 문자열이 아니라 DOM 엘리먼트로 오는 경우가 있어 gv()로 통일 처리.
 */
(function () {
  function gv(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
    try { return String(v.innerText ?? v.textContent ?? '').trim(); } catch { return ''; }
  }

  // ── 1) viewInfo 템플릿 캡처 ──────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aihelperUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__aihelperUrl || '';
      if (typeof body === 'string' && body.includes('viewInfo=') && /div_10[67]\.ajax/.test(url)) {
        window.postMessage({ __aihelper: true, kind: 'template', url, body }, '*');
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // ── 2) IBSheet 데이터 읽기 요청 처리 ─────────────────────────
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || !msg.__aihelper || msg.kind !== 'request') return;

    if (msg.action === 'READ_FEE_SHEET') {
      const sheet = window.IBSheet && window.IBSheet[0];
      const rows = [];
      if (sheet && sheet.Rows) {
        const arKeys = Object.keys(sheet.Rows)
          .filter(k => /^AR\d+$/.test(k))
          .sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
        for (const k of arKeys) {
          const r = sheet.Rows[k];
          if (!r) continue;
          const aptNo = gv(r.APT_NO);
          if (!aptNo || aptNo === '0000') continue;
          rows.push({
            aptNo,
            aptRoom: gv(r.APT_ROOM),
            vApt: gv(r.V_APT_NO),
            vRoom: gv(r.V_APT_ROOM),
            dongho: gv(r.APT_NO_ROOM).replace(/\s/g, ''),
            name: gv(r.HSHL_HEAD_NM),
            owner: gv(r.OWNER_NM),
            sellPyong: gv(r.SELL_PYONG),
            occuDate: gv(r.OCCU_DATE),
            imps19: gv(r.SUM_IMPS_AMT19),
          });
        }
      }
      const ymEl = document.querySelector('#imps_yymm') || document.querySelector('#first_yymm');
      const ymVal = gv(ymEl && (ymEl.value ?? ymEl.innerText));
      const m = ymVal.match(/(\d{4})\D?(\d{2})/);
      const yymm = m ? `${m[1]}${m[2]}` : '';
      window.postMessage({ __aihelper: true, kind: 'response', action: 'READ_FEE_SHEET', rows, yymm, reqId: msg.reqId }, '*');
      return;
    }

    if (msg.action === 'READ_RESIDENT_SHEET') {
      const RE_PHONE = /^01[0-9]\d{7,8}$/;
      const result = {};
      for (let i = 0; i < 10; i++) {
        const sheet = window.IBSheet && window.IBSheet[i];
        if (!sheet || !sheet.Rows) continue;
        const arKeys = Object.keys(sheet.Rows).filter(k => /^AR\d+$/.test(k));
        if (!arKeys.length) continue;
        // AR1은 "전체" 집계 행이라 PRT_APT_NO가 없을 수 있음 → 앞 몇 개 행을 확인
        const hasField = arKeys.slice(0, 5).some(k => sheet.Rows[k] && 'PRT_APT_NO' in sheet.Rows[k]);
        if (!hasField) continue;
        for (const k of arKeys) {
          const r = sheet.Rows[k];
          if (!r) continue;
          const dong = gv(r.PRT_APT_NO);
          const ho = gv(r.PRT_APT_ROOM);
          if (!dong || !ho) continue;
          const dk = `${parseInt(dong, 10)}-${parseInt(ho, 10)}`;
          let ph = gv(r.I_MOBILE_TEL_NO1).replace(/[-.\s]/g, '');
          if (!RE_PHONE.test(ph)) ph = gv(r.S_MOBILE_TEL_NO1).replace(/[-.\s]/g, '');
          result[dk] = {
            phone: RE_PHONE.test(ph) ? ph : '',
            sellArea: gv(r.SELL_PYONG),
            exclusiveArea: gv(r.EUSE_PYONG),
          };
        }
        break;
      }
      window.postMessage({ __aihelper: true, kind: 'response', action: 'READ_RESIDENT_SHEET', result, reqId: msg.reqId }, '*');
    }
  });
})();
