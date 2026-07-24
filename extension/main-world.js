/**
 * MAIN world 스크립트 — 페이지의 실제 JS 컨텍스트에서 실행됨.
 * 1) XHR을 가로채서 impo_703m01_div_*.ajax(세대 클릭 시 XpERP가 한번에 쏘는
 *    div_1/2/3/55/106/107 등) 응답 원본을 수동 캡처 — 이 중 div_107이 세대 1개
 *    클릭만으로 전체 세대의 항목별 금액+검침값+청구서요약을 한 번에 주는 벌크
 *    응답이라, 세대별 반복 조회(div_106) 없이 이걸로 전체 수집이 가능함
 *    (2026-07-24 디버그 캡처로 확인). content.js가 이 캡처를 실제 수집에 사용.
 * 2) window.IBSheet 데이터를 읽어 content.js(ISOLATED world)에 postMessage로 전달.
 *
 * IBSheet 필드 값이 문자열이 아니라 DOM 엘리먼트로 오는 경우가 있어 gv()로 통일 처리.
 */
(function () {
  function gv(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
    try { return String(v.innerText ?? v.textContent ?? '').trim(); } catch { return ''; }
  }

  // ── 1) div_*.ajax 응답 원본 캡처 ─────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const DIV_RE = /impo_703m01_div_(\d+)\.ajax/;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aihelperUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__aihelperUrl || '';
      const divMatch = url.match(DIV_RE);
      if (divMatch) {
        const divNo = divMatch[1];
        const reqBody = typeof body === 'string' ? body : '';
        this.addEventListener('load', function () {
          try {
            window.postMessage({
              __aihelper: true, kind: 'debug_capture',
              divNo, url, requestBody: reqBody, responseText: this.responseText,
            }, '*');
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

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

          const amtFields = {};
          for (const f in r) {
            if (/^SUM_IMPS_AMT\d+$/.test(f)) amtFields[f] = gv(r[f]);
          }

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
            amtFields,
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
