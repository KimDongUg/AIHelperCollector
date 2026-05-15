/**
 * XpERP 수집기 — 사용자 사전 조회 방식
 *
 * 사용 방법:
 *   1. XpERP에서 입주자현황 → 개인정보 표시 체크 → 조회
 *   2. XpERP에서 관리비조회 → 조회 (동호내역 목록 표시된 상태)
 *   3. AI Helper 수집기 [수집 시작] 클릭
 *
 * CDP 연결 방식에서는 frame.evaluate()가 하위 iframe에서 실패할 수 있어
 * page.evaluate() + iframe.contentDocument 접근 방식을 사용합니다.
 */

const path = require('path');
const fs   = require('fs');
const { getPage }     = require('./browser');
const { exportExcel } = require('./exportExcel');
const { saveErrorLog }= require('./logger');

let stopFlag = false;
function stopCollect() { stopFlag = true; }

/* ═══════════════════════════════════════════════════════════
 *  MAIN
 * ═══════════════════════════════════════════════════════════ */
async function runCollect(onProgress) {
  stopFlag = false;
  const page      = await getPage();
  const outputDir = path.join(__dirname, '..', 'output');
  const logsDir   = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir))   fs.mkdirSync(logsDir,   { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const allData     = [];
  const failedUnits = [];

  try {
    // 1단계: 입주자현황에서 동/호/휴대폰 읽기
    onProgress({ current: 0, total: 0, unit: '① 입주자현황 읽는 중...' });
    const residentMap = await readResidentViaIframe(page);

    // 2단계: 관리비조회 동호 목록 읽기
    onProgress({ current: 0, total: 0, unit: '② 관리비조회 목록 읽는 중...' });
    const feeUnits = await readFeeUnitsViaIframe(page);

    if (!feeUnits.length) {
      return {
        ok: false,
        error: '관리비조회 동호내역이 없습니다.\nXpERP에서 관리비조회 → 조회 버튼을 먼저 클릭해주세요.',
      };
    }

    const total = feeUnits.length;
    onProgress({ current: 0, total, unit: '수집 시작' });

    // 3단계: 각 호 클릭 → 데이터 수집
    for (let i = 0; i < feeUnits.length; i++) {
      if (stopFlag) break;
      const unit = feeUnits[i];
      onProgress({ current: i + 1, total, unit: unit.dongho });

      try {
        await clickFeeUnitViaIframe(page, unit._rowIndex);
        await page.waitForTimeout(400);

        const feeData = await collectFeeDataViaIframe(page);
        const phone   = residentMap[`${unit.dong}-${unit.ho}`] || '';

        allData.push({ dong: unit.dong, ho: unit.ho, phone, ...feeData });
      } catch (err) {
        failedUnits.push(unit.dongho);
        saveErrorLog(logsDir, unit.dongho, err.message);
      }

      await page.waitForTimeout(100);
    }

    if (!allData.length) {
      return { ok: false, error: '수집된 데이터가 없습니다.' };
    }

    const filePath = await exportExcel(allData, outputDir);
    onProgress({ current: total, total, done: true });
    return {
      ok: true, filePath,
      total: allData.length,
      failed: failedUnits.length,
      failedUnits,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════
 *  공통: page.evaluate()에서 특정 iframe의 document 찾기
 *  iframeKeyword: iframe URL에 포함된 문자열 (예: 'occp_020' = 입주자현황)
 * ═══════════════════════════════════════════════════════════ */
function getIframeDocScript(keyword) {
  // page.evaluate() 내에서 실행 — iframe.contentDocument 접근
  return `
    (function(kw) {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const f of iframes) {
        try {
          const src = f.src || '';
          if (kw && !src.includes(kw)) continue;
          const d = f.contentDocument || f.contentWindow && f.contentWindow.document;
          if (d && d.body) return d;
        } catch {}
      }
      // keyword 없으면 첫 번째 접근 가능한 iframe
      for (const f of iframes) {
        try {
          const d = f.contentDocument || f.contentWindow && f.contentWindow.document;
          if (d && d.body) return d;
        } catch {}
      }
      return null;
    })('${keyword}')
  `;
}

/* ═══════════════════════════════════════════════════════════
 *  입주자현황: 동/호 → 휴대폰 맵
 * ═══════════════════════════════════════════════════════════ */
async function readResidentViaIframe(page) {
  return await page.evaluate(() => {
    const map = {};
    // 입주자현황 iframe: occp_020 포함
    const iframes = Array.from(document.querySelectorAll('iframe'));
    let doc = null;
    for (const f of iframes) {
      try {
        const src = f.src || '';
        if (!src.includes('occp_020')) continue;
        const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (d && d.body) { doc = d; break; }
      } catch {}
    }
    if (!doc) return map;

    const rows = doc.querySelectorAll('table tbody tr');
    let lastDong = '';
    for (const row of rows) {
      const tds = Array.from(row.querySelectorAll('td'));
      if (!tds.length) continue;
      let dong, ho, phone;
      if (tds.length >= 10) {
        dong  = tds[0].innerText.trim();
        if (dong && dong !== '합계') lastDong = dong;
        ho    = tds[1].innerText.trim();
        phone = tds[9].innerText.trim();
      } else if (tds.length >= 9) {
        dong  = lastDong;
        ho    = tds[0].innerText.trim();
        phone = tds[8].innerText.trim();
      } else { continue; }
      if (!ho || ho === '합계') continue;
      map[`${lastDong}-${ho}`] = phone;
    }
    return map;
  });
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 동호 목록 읽기
 * ═══════════════════════════════════════════════════════════ */
async function readFeeUnitsViaIframe(page) {
  return await page.evaluate(() => {
    const result = [];
    // 관리비조회 iframe: occp_010 포함
    const iframes = Array.from(document.querySelectorAll('iframe'));
    let doc = null;
    for (const f of iframes) {
      try {
        const src = f.src || '';
        if (!src.includes('occp_010')) continue;
        const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (d && d.body) { doc = d; break; }
      } catch {}
    }
    // fallback: "N-N" 패턴 셀이 있는 iframe
    if (!doc) {
      for (const f of iframes) {
        try {
          const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (!d) continue;
          const hasDongho = Array.from(d.querySelectorAll('td')).some(
            td => /^\d+\s*-\s*\d+$/.test((td.innerText || '').trim())
          );
          if (hasDongho) { doc = d; break; }
        } catch {}
      }
    }
    if (!doc) return result;

    for (const table of doc.querySelectorAll('table')) {
      const hasDongho = Array.from(table.querySelectorAll('td')).some(
        td => /^\d+\s*-\s*\d+$/.test((td.innerText || '').trim())
      );
      if (!hasDongho) continue;

      Array.from(table.querySelectorAll('tbody tr')).forEach((row, idx) => {
        const tds    = Array.from(row.querySelectorAll('td'));
        const dongho = (tds[0]?.innerText || '').trim();
        const m      = dongho.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) result.push({ dongho, dong: m[1], ho: m[2], _rowIndex: idx });
      });
      if (result.length > 0) break;
    }
    return result;
  });
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 특정 호 행 클릭
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnitViaIframe(page, rowIndex) {
  await page.evaluate((idx) => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const f of iframes) {
      try {
        const src = f.src || '';
        const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (!d) continue;
        const hasDongho = src.includes('occp_010') ||
          Array.from(d.querySelectorAll('td')).some(
            td => /^\d+\s*-\s*\d+$/.test((td.innerText || '').trim())
          );
        if (!hasDongho) continue;

        for (const table of d.querySelectorAll('table')) {
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          if (rows[idx]) { rows[idx].click(); return; }
        }
      } catch {}
    }
  }, rowIndex);
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 선택된 호의 모든 데이터 수집
 * ═══════════════════════════════════════════════════════════ */
async function collectFeeDataViaIframe(page) {
  return await page.evaluate(() => {
    const data = {};
    const iframes = Array.from(document.querySelectorAll('iframe'));
    let doc = null;
    for (const f of iframes) {
      try {
        const src = f.src || '';
        if (!src.includes('occp_010')) continue;
        const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (d && d.body) { doc = d; break; }
      } catch {}
    }
    if (!doc) {
      // fallback: 첫 번째 접근 가능한 iframe
      for (const f of iframes) {
        try {
          const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (d && d.body) { doc = d; break; }
        } catch {}
      }
    }
    if (!doc) return data;

    const tables = Array.from(doc.querySelectorAll('table')).slice(1);
    tables.forEach((table) => {
      let sectionName = '';
      let prev = table.previousElementSibling;
      while (prev) {
        const t = prev.innerText ? prev.innerText.trim() : '';
        if (t && t.length < 30) { sectionName = t.replace(/[•\s]/g, ''); break; }
        prev = prev.previousElementSibling;
      }

      const rows    = Array.from(table.querySelectorAll('tr'));
      const headers = rows[0]
        ? Array.from(rows[0].querySelectorAll('th, td')).map(h => h.innerText.trim())
        : [];
      const isMeter = headers.some(h => h.includes('전월') || h.includes('당월지침'));

      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) return;

        if (isMeter) {
          const item = cells[0]?.innerText.trim();
          if (!item || ['검침항목', '항목'].includes(item)) return;
          const prefix = `검침_${item}`;
          if (cells[1]) data[`${prefix}_전월`] = cells[1].innerText.trim().replace(/,/g, '');
          if (cells[2]) data[`${prefix}_당월`] = cells[2].innerText.trim().replace(/,/g, '');
          if (cells[3]) data[`${prefix}_요금`] = cells[3].innerText.trim().replace(/,/g, '');
        } else {
          for (let i = 0; i + 1 < cells.length; i += 2) {
            const key = cells[i].innerText.trim();
            const val = cells[i + 1].innerText.trim().replace(/,/g, '');
            if (!key || ['항목', '항목명', '순번', '할인항목명'].includes(key)) continue;
            if (key.startsWith('•') || key === '') continue;
            const finalKey = data[key] !== undefined ? `${sectionName}_${key}` : key;
            data[finalKey] = val;
          }
        }
      });
    });

    // input readonly 요약값
    doc.querySelectorAll('input[readonly], input[disabled]').forEach(inp => {
      const label = inp.previousSibling?.textContent?.trim()
        || inp.parentElement?.previousElementSibling?.innerText?.trim();
      const val = inp.value?.replace(/,/g, '');
      if (label && val) data[`요약_${label}`] = val;
    });

    return data;
  });
}

module.exports = { runCollect, stopCollect };
