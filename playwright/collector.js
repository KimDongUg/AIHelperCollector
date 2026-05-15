/**
 * XpERP 수집기 — frameLocator 방식
 *
 * 사용 방법:
 *   1. XpERP에서 입주자현황 → 개인정보 표시 체크 → 조회
 *   2. XpERP에서 관리비조회 → 조회 (동호내역 목록 표시된 상태)
 *   3. AI Helper 수집기 [수집 시작] 클릭
 *
 * Playwright의 page.frameLocator() 를 사용하여 iframe 내부에 CDP로 직접 접근.
 */

const path = require('path');
const fs   = require('fs');
const { getPage }     = require('./browser');
const { exportExcel } = require('./exportExcel');
const { saveErrorLog }= require('./logger');

let stopFlag = false;
function stopCollect() { stopFlag = true; }

// 관리비조회 iframe: impo_703m01.do (T61, 동-호 포함)
const SEL_FEE      = 'iframe[src*="703m01"], iframe[src*="010m01"], iframe[src*="OCCP1010"]';
// 입주자현황 iframe: occp_020m02.do (T9)
const SEL_RESIDENT = 'iframe[src*="020m02"], iframe[src*="020m"], iframe[src*="IMPO2020"]';

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
    // 1단계: 입주자현황 동/호/휴대폰 읽기
    onProgress({ current: 0, total: 0, unit: '① 입주자현황 읽는 중...' });
    const residentMap = await readResidentData(page);

    // 2단계: 관리비조회 동호 목록 읽기
    onProgress({ current: 0, total: 0, unit: '② 관리비조회 목록 읽는 중...' });
    const feeResult = await readFeeUnitList(page);
    const feeUnits = Array.isArray(feeResult) ? feeResult : [];
    const feeDiag  = (!Array.isArray(feeResult) && feeResult?.__diag) ? feeResult.__diag : '';

    if (!feeUnits.length) {
      return {
        ok: false,
        error: `관리비조회 동호내역이 없습니다.\nXpERP에서 관리비조회 → 조회 버튼을 먼저 클릭해주세요.\n[진단: ${feeDiag}]`,
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
        await clickFeeUnit(page, unit._rowIndex);
        await page.waitForTimeout(400);

        const feeData = await collectFeeData(page);
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
 *  입주자현황: 동/호 → 휴대폰 맵
 * ═══════════════════════════════════════════════════════════ */
async function readResidentData(page) {
  try {
    // frameLocator를 통해 iframe 내부 body.evaluate() — CDP 직접 접근
    const fl = page.frameLocator(SEL_RESIDENT);
    return await fl.locator('body').evaluate(() => {
      const map = {};
      const rows = document.querySelectorAll('table tbody tr');
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
  } catch {
    return {}; // 입주자현황 없으면 빈 맵 (휴대폰 없이 수집 계속)
  }
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 동호내역 목록 읽기
 * ═══════════════════════════════════════════════════════════ */
async function readFeeUnitList(page) {
  // 방법 1: frameLocator 로 occp_010 iframe 접근
  try {
    const fl = page.frameLocator(SEL_FEE);
    const units = await fl.locator('body').evaluate(() => {
      // 셀에 탭/줄바꿈으로 복합값 포함 시 첫 번째 값만 추출
      function firstVal(el) {
        const raw = (el?.innerText || el?.textContent || '').trim();
        return (raw.split(/[\t\n]/)[0] || '').replace(/\s+/g, '').trim();
      }
      const result = [];
      for (const table of document.querySelectorAll('table')) {
        Array.from(table.querySelectorAll('tbody tr, tr')).forEach((row, idx) => {
          const tds = Array.from(row.querySelectorAll('td'));
          if (!tds.length) return;
          // 전략1: 첫 셀 첫 값이 "N-N" 또는 "N" (동-호 합치거나 분리)
          const c0 = firstVal(tds[0]);
          const m1 = c0.match(/^(\d+)[-–—](\d+)$/);
          if (m1) { result.push({ dongho: `${m1[1]}-${m1[2]}`, dong: m1[1], ho: m1[2], _rowIndex: idx }); return; }
          // 전략2: 앞쪽 셀에서 동(숫자) + 다음 셀 호(숫자) 탐색
          for (let ci = 0; ci < Math.min(tds.length - 1, 4); ci++) {
            const ca = firstVal(tds[ci]);
            const cb = firstVal(tds[ci + 1]);
            if (/^\d{1,4}$/.test(ca) && /^\d{2,4}$/.test(cb)) {
              result.push({ dongho: `${ca}-${cb}`, dong: ca, ho: cb, _rowIndex: idx });
              return;
            }
          }
        });
        if (result.length) break;
      }
      return result;
    });
    if (units.length) return units;
  } catch {}

  // 방법 2: URL 필터 없이 모든 frame 순회 (오류 진단 포함)
  const diagLines = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const url = f.url();
    if (url === 'about:blank' || url === 'about:srcdoc') continue;
    const urlShort = url.split('/').pop().substring(0, 30);
    try {
      const diag = await f.evaluate(() => {
        try {
          const tables = Array.from(document.querySelectorAll('table'));
          const firstCells = [];
          for (const t of tables) {
            for (const td of t.querySelectorAll('td')) {
              const txt = (td.innerText || '').trim();
              if (txt) { firstCells.push(txt.substring(0, 15)); }
              if (firstCells.length >= 3) break;
            }
            if (firstCells.length >= 3) break;
          }
          return { tables: tables.length, cells: firstCells };
        } catch (e) { return { innerErr: e.message }; }
      });
      diagLines.push(`[${urlShort}:T${diag.tables}:${JSON.stringify(diag.cells || [])}]`);
      // 동호 패턴 탐색
      const units = await f.evaluate(() => {
        function firstVal(el) {
          const raw = (el?.innerText || el?.textContent || '').trim();
          return (raw.split(/[\t\n]/)[0] || '').replace(/\s+/g, '').trim();
        }
        const result = [];
        for (const table of document.querySelectorAll('table')) {
          Array.from(table.querySelectorAll('tbody tr, tr')).forEach((row, idx) => {
            const tds = Array.from(row.querySelectorAll('td'));
            if (!tds.length) return;
            const c0 = firstVal(tds[0]);
            const m1 = c0.match(/^(\d+)[-–—](\d+)$/);
            if (m1) { result.push({ dongho: `${m1[1]}-${m1[2]}`, dong: m1[1], ho: m1[2], _rowIndex: idx }); return; }
            for (let ci = 0; ci < Math.min(tds.length - 1, 4); ci++) {
              const ca = firstVal(tds[ci]);
              const cb = firstVal(tds[ci + 1]);
              if (/^\d{1,4}$/.test(ca) && /^\d{2,4}$/.test(cb)) {
                result.push({ dongho: `${ca}-${cb}`, dong: ca, ho: cb, _rowIndex: idx }); return;
              }
            }
          });
          if (result.length) break;
        }
        return result;
      });
      if (units.length) return units;
    } catch (e) {
      diagLines.push(`[${urlShort}:ERR:${e.message.substring(0, 40)}]`);
    }
  }

  // 동호 미발견 시 진단 정보와 함께 빈 배열 반환
  return { __diag: diagLines.join(' ') };
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 특정 호 행 클릭
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, rowIndex) {
  // 방법 1: frameLocator
  try {
    const fl  = page.frameLocator(SEL_FEE);
    const rows = fl.locator('table tbody tr');
    await rows.nth(rowIndex).click({ timeout: 3000 });
    return;
  } catch {}

  // 방법 2: 모든 frame 순회
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const clicked = await f.evaluate((idx) => {
        for (const table of document.querySelectorAll('table')) {
          const hasDongho = Array.from(table.querySelectorAll('td')).some(
            td => /^\d+\s*-\s*\d+$/.test((td.innerText || '').trim())
          );
          if (!hasDongho) continue;
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          if (rows[idx]) { rows[idx].click(); return true; }
        }
        return false;
      }, rowIndex);
      if (clicked) return;
    } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 선택 호 전체 데이터 수집
 * ═══════════════════════════════════════════════════════════ */
async function collectFeeData(page) {
  const extractData = () => {
    const data = {};
    const tables = Array.from(document.querySelectorAll('table')).slice(1);
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

      document.querySelectorAll('input[readonly], input[disabled]').forEach(inp => {
        const label = inp.previousSibling?.textContent?.trim()
          || inp.parentElement?.previousElementSibling?.innerText?.trim();
        const val = inp.value?.replace(/,/g, '');
        if (label && val) data[`요약_${label}`] = val;
      });
    });
    return data;
  };

  // 방법 1: frameLocator
  try {
    return await page.frameLocator(SEL_FEE).locator('body').evaluate(extractData);
  } catch {}

  // 방법 2: 모든 frame 순회
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const d = await f.evaluate(extractData);
      if (Object.keys(d).length > 0) return d;
    } catch {}
  }

  return {};
}

module.exports = { runCollect, stopCollect };
