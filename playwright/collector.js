/**
 * XpERP 수집기 — 사용자 사전 조회 방식
 *
 * 사용 방법:
 *   1. XpERP에서 입주자현황 → 개인정보 표시 체크 → 조회
 *   2. XpERP에서 관리비조회 → 조회  (동호내역 목록 표시된 상태)
 *   3. AI Helper 수집기 [수집 시작] 클릭
 *
 * 수집기는 메뉴 탐색/버튼 클릭을 직접 하지 않고,
 * 이미 열린 탭의 데이터를 읽어 수집합니다.
 */

const path = require('path');
const fs   = require('fs');
const { getPage }    = require('./browser');
const { exportExcel} = require('./exportExcel');
const { saveErrorLog}= require('./logger');

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
    // 1단계: 이미 열린 입주자현황 탭에서 동/호/휴대폰 읽기
    onProgress({ current: 0, total: 0, unit: '① 입주자현황 데이터 읽는 중...' });
    const residentMap = await readResidentFromOpenTab(page);

    // 2단계: 이미 열린 관리비조회 탭에서 동호 목록 읽기
    onProgress({ current: 0, total: 0, unit: '② 관리비조회 목록 읽는 중...' });
    const feeUnitResult = await readFeeUnitsFromOpenTab(page);
    const { feeFrame, feeUnits } = feeUnitResult;

    if (!feeUnits.length) {
      const debug = feeUnitResult.debugInfo ? `\n[진단: ${feeUnitResult.debugInfo}]` : '';
      return {
        ok: false,
        error: `관리비조회 동호내역이 없습니다.\nXpERP에서 관리비조회 → 조회 버튼을 먼저 클릭해주세요.${debug}`,
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
        // 동호내역 행 클릭
        const rows = await feeFrame.$$('table tbody tr');
        if (rows[unit._rowIndex]) {
          await rows[unit._rowIndex].evaluate(el => el.click());
        }
        await page.waitForTimeout(400);

        const feeData = await collectUnitFeeData(feeFrame);
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
 *  입주자현황: 이미 열린 탭에서 동/호 → 휴대폰 맵 읽기
 * ═══════════════════════════════════════════════════════════ */
async function readResidentFromOpenTab(page) {
  // 입주자현황 frame 탐지 (키워드: 입주여부, 주거형태)
  const frame = await findFrameByKeywords(page, ['입주여부', '주거형태', '입주자현황']);
  if (!frame) return {}; // 탭이 없으면 빈 맵 반환 (휴대폰 없이 수집 계속)

  return await frame.evaluate(() => {
    const map  = {};
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
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 이미 열린 탭에서 동호 목록 읽기
 *  — 모든 frame에서 "1-101" 패턴 테이블을 직접 탐색
 * ═══════════════════════════════════════════════════════════ */
async function readFeeUnitsFromOpenTab(page) {
  const allFrames = page.frames();
  const frameUrls = allFrames.map(f => f.url().split('?')[0]).join(' | ');

  for (const f of allFrames) {
    const url = f.url();
    if (!url || url === 'about:blank' || url === 'about:srcdoc') continue;

    try {
      const units = await f.evaluate(() => {
        const result = [];
        // "N - N" 또는 "N-N" 패턴 셀이 있는 테이블 탐색
        for (const table of document.querySelectorAll('table')) {
          const hasDongho = Array.from(table.querySelectorAll('td')).some(
            td => /^\d+\s*-\s*\d+$/.test(td.innerText?.trim())
          );
          if (!hasDongho) continue;

          Array.from(table.querySelectorAll('tbody tr')).forEach((row, idx) => {
            const tds = Array.from(row.querySelectorAll('td'));
            const dongho = tds[0]?.innerText?.trim() || '';
            const m = dongho.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) result.push({ dongho, dong: m[1], ho: m[2], _rowIndex: idx });
          });
          if (result.length > 0) break;
        }
        return result;
      });

      if (units.length > 0) {
        return { feeFrame: f, feeUnits: units };
      }
    } catch {}
  }

  // 모든 frame 실패 시 진단 정보 포함 오류
  return {
    feeFrame: page,
    feeUnits: [],
    debugInfo: `열린 frame URLs: ${frameUrls}`,
  };
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 선택된 호의 모든 데이터 수집
 * ═══════════════════════════════════════════════════════════ */
async function collectUnitFeeData(frame) {
  return await frame.evaluate(() => {
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
    });

    // input readonly 요약값 수집
    document.querySelectorAll('input[readonly], input[disabled]').forEach(inp => {
      const label = inp.previousSibling?.textContent?.trim()
        || inp.parentElement?.previousElementSibling?.innerText?.trim();
      const val = inp.value?.replace(/,/g, '');
      if (label && val) data[`요약_${label}`] = val;
    });

    return data;
  });
}

/* ═══════════════════════════════════════════════════════════
 *  helpers
 * ═══════════════════════════════════════════════════════════ */

/** 키워드로 올바른 iframe frame 탐지 */
async function findFrameByKeywords(page, keywords) {
  // 메인 프레임 포함 전체 frame 순회
  for (const f of page.frames()) {
    const url = f.url();
    if (!url || url === 'about:blank' || url === 'about:srcdoc') continue;
    try {
      const ok = await f.evaluate(
        (kws) => kws.some(k => (document.body?.innerText || '').includes(k)),
        keywords
      );
      if (ok) return f;
    } catch {}
  }
  return null;
}

module.exports = { runCollect, stopCollect };
