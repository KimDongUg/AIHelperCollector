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

// 각 페이지 iframe 셀렉터 (URL 패턴)
const SEL_FEE      = 'iframe[src*="occp_010"]'; // 관리비조회
const SEL_RESIDENT = 'iframe[src*="occp_020"]'; // 입주자현황

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
    const feeUnits = await readFeeUnitList(page);

    if (!feeUnits.length) {
      // 프레임 목록을 진단 정보로 포함
      const frameUrls = page.frames().map(f => f.url().split('/').pop()).join(', ');
      return {
        ok: false,
        error: `관리비조회 동호내역이 없습니다.\nXpERP에서 관리비조회 → 조회 버튼을 먼저 클릭해주세요.\n[프레임: ${frameUrls}]`,
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
      const result = [];
      for (const table of document.querySelectorAll('table')) {
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
        if (result.length) break;
      }
      return result;
    });
    if (units.length) return units;
  } catch {}

  // 방법 2: 모든 frame에서 직접 evaluate
  for (const f of page.frames()) {
    if (!f.url().includes('occp_010')) continue;
    try {
      const units = await f.evaluate(() => {
        const result = [];
        for (const table of document.querySelectorAll('table')) {
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
          if (result.length) break;
        }
        return result;
      });
      if (units.length) return units;
    } catch {}
  }

  return [];
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

  // 방법 2: frame.evaluate
  for (const f of page.frames()) {
    if (!f.url().includes('occp_010')) continue;
    try {
      await f.evaluate((idx) => {
        for (const table of document.querySelectorAll('table')) {
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          if (rows[idx]) { rows[idx].click(); return; }
        }
      }, rowIndex);
      return;
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

  // 방법 2: frame.evaluate
  for (const f of page.frames()) {
    if (!f.url().includes('occp_010')) continue;
    try { return await f.evaluate(extractData); } catch {}
  }

  return {};
}

module.exports = { runCollect, stopCollect };
