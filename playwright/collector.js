/**
 * XpERP 수집기 — IBSheet 이중 구조 대응
 *
 * IBSheet 이중 구조:
 *   div.cont_table → div#sheetDivX → table.IBMainTable (외부 래퍼)
 *     → tbody > tr > td.IBBodyMid > div.IBSectionScroll > div.IBPageOne
 *       → table.IBSection (내부 실제 데이터)
 *         → tbody > tr.IBDataRow (실제 데이터 행)
 *
 * 숨김 컬럼: style="width:0px" 만 필터
 *   ※ HideColXXX 클래스는 IBSheet 컬럼 식별자일 뿐 숨김과 무관 — 필터하지 않음
 *   실제 DOM 확인: td.HideCol0APT_NO_ROOM = "1 - 101" (동호, 실제 표시됨)
 *
 * 섹션 셀렉터:
 *   입주자현황       : .cont_table
 *   동호내역 (목록)  : .cont_table.left
 *   고지내역         : .cont_table.left.mgR5  (show0 제외)
 *   검침내역         : .cont_table.sheetDTap
 *   할인내역         : .cont_table.left.sheetETap
 *   항목별 부과 요약 : #lbl_item_amt / #lbl_curr_amt / #lbl_jul_amt
 *   항목별 부과 표   : .cont_table.left.mgR5.show0  (6컬럼: 3쌍/행)
 */

const path = require('path');
const fs   = require('fs');
const { getPage }     = require('./browser');
const { exportExcel } = require('./exportExcel');
const { saveErrorLog }= require('./logger');

let stopFlag = false;
function stopCollect() { stopFlag = true; }

const SEL_FEE      = 'iframe[src*="703m01"], iframe[src*="010m01"], iframe[src*="OCCP1010"]';
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
    onProgress({ current: 0, total: 0, unit: '① 입주자현황 읽는 중...' });
    const residentMap = await readResidentData(page);

    onProgress({ current: 0, total: 0, unit: '② 관리비조회 목록 읽는 중...' });
    const feeResult = await readFeeUnitList(page);
    const feeUnits  = Array.isArray(feeResult) ? feeResult : [];
    const feeDiag   = (!Array.isArray(feeResult) && feeResult?.__diag) ? feeResult.__diag : '';

    if (!feeUnits.length) {
      return {
        ok: false,
        error: `관리비조회 동호내역이 없습니다.\nXpERP에서 관리비조회 → 조회 버튼을 먼저 클릭해주세요.\n[진단: ${feeDiag}]`,
      };
    }

    const total = feeUnits.length;
    onProgress({ current: 0, total, unit: '수집 시작' });

    for (let i = 0; i < feeUnits.length; i++) {
      if (stopFlag) break;
      const unit = feeUnits[i];
      onProgress({ current: i + 1, total, unit: unit.dongho });

      try {
        await clickFeeUnit(page, unit.dong, unit.ho, i);
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
 *  입주자현황: 동/호 → 휴대폰 맵  (.cont_table → IBSheet)
 * ═══════════════════════════════════════════════════════════ */
async function readResidentData(page) {
  const fn = () => {
    // IBSheet 숨김 TD 필터 — width:0px 만 제거 (HideColXXX 클래스는 표시 컬럼에도 있음)
    function visTds(row) {
      return Array.from(row.querySelectorAll('td')).filter(td => {
        const w = td.style.width;
        return w !== '0px' && w !== '0' && td.style.display !== 'none';
      });
    }
    function findPhone(tds) {
      const RE = /^0[1][0-9][-\s]?\d{3,4}[-\s]?\d{4}$/;
      for (const td of tds) {
        const t = (td.innerText || '').trim().replace(/\s+/g, '');
        if (RE.test(t)) return t;
      }
      return tds[9]?.innerText.trim() || tds[8]?.innerText.trim() || '';
    }

    const map = {};
    const container = document.querySelector('.cont_table');
    // IBSection 내부 tr.IBDataRow 우선 (이중 IBSheet 구조)
    const rows = container
      ? Array.from(container.querySelectorAll('tr.IBDataRow'))
      : [];

    let lastDong = '';
    for (const row of rows) {
      const tds = visTds(row);
      if (tds.length < 2) continue;
      const c0 = (tds[0]?.innerText || '').trim().split(/[\t\n]/)[0].replace(/\s+/g, '');
      const c1 = (tds[1]?.innerText || '').trim().split(/[\t\n]/)[0].replace(/\s+/g, '');

      if (/^\d{1,4}$/.test(c0) && /^\d{2,4}$/.test(c1)) {
        lastDong = c0;
        map[`${lastDong}-${c1}`] = findPhone(tds);
      } else if (/^\d{2,4}$/.test(c0) && lastDong) {
        map[`${lastDong}-${c0}`] = findPhone(tds);
      }
    }
    return map;
  };

  try {
    return await page.frameLocator(SEL_RESIDENT).locator('body').evaluate(fn);
  } catch {
    return {};
  }
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 동호 목록 읽기
 *
 *  IBSheet 가상 스크롤 우회:
 *    evaluate 내부에서 Promise + setTimeout으로 IBSectionScroll을
 *    스크롤하며 모든 APT_NO_ROOM 셀을 수집
 *    (DOM에 ~28행만 렌더돼도 전체 847행+ 수집 가능)
 * ═══════════════════════════════════════════════════════════ */
async function readFeeUnitList(page) {
  // Promise 기반 스크롤 수집 — evaluate 내부에서 완결
  const fn = () => {
    const sheetA = document.querySelector('#sheetDivA');
    if (!sheetA) return [];

    const scrollEl = sheetA.querySelector('.IBSectionScroll');

    // ── 방법 A: IBSheet API (다양한 메서드명 시도) ───────────
    try {
      const m = (scrollEl?.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      const sheet = window.IBSheet?.[m ? parseInt(m[1]) : 0];
      if (sheet) {
        const getLastRow = sheet.LastRow   || sheet.GetRowCount ||
                           sheet.RowCount  || sheet.AllCount;
        const getCellVal = sheet.GetCellValue || sheet.GetValue;
        if (typeof getLastRow === 'function' && typeof getCellVal === 'function') {
          const last = getLastRow.call(sheet);
          if (last > 0) {
            const result = [], seen = new Set();
            for (let i = 1; i <= last; i++) {
              const v = getCellVal.call(sheet, i, 'APT_NO_ROOM');
              if (!v || v.trim() === '전체') continue;
              const m2 = v.trim().match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
              if (!m2) continue;
              const dk = `${m2[1]}-${m2[2]}`;
              if (!seen.has(dk)) { seen.add(dk); result.push({ dongho: dk, dong: m2[1], ho: m2[2] }); }
            }
            if (result.length) return result;
          }
        }
      }
    } catch (e) {}

    // ── 방법 B: Promise + setTimeout 스크롤 수집 ────────────
    if (!scrollEl) return [];

    return new Promise((resolve) => {
      scrollEl.scrollTop = 0;
      const allUnits = new Map();
      let stagnantCount = 0;

      const step = () => {
        const prevSize = allUnits.size;

        for (const row of sheetA.querySelectorAll('tr.IBDataRow')) {
          const td = row.querySelector('[class*="APT_NO_ROOM"]');
          if (!td) continue;
          const text = (td.innerText || '').trim();
          if (!text || text === '전체') continue;
          const m = text.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
          if (!m) continue;
          const dk = `${m[1]}-${m[2]}`;
          if (!allUnits.has(dk)) allUnits.set(dk, { dongho: dk, dong: m[1], ho: m[2] });
        }

        if (allUnits.size === prevSize) stagnantCount++;
        else stagnantCount = 0;

        const atBottom =
          scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;

        if (atBottom || stagnantCount >= 3) {
          resolve(Array.from(allUnits.values()));
          return;
        }

        scrollEl.scrollTop += scrollEl.clientHeight;
        setTimeout(step, 80);
      };

      setTimeout(step, 80); // 초기 렌더 대기
    });
  };

  // 방법 1: frameLocator
  try {
    const units = await page.frameLocator(SEL_FEE).locator('body').evaluate(fn);
    if (Array.isArray(units) && units.length) return units;
  } catch {}

  // 방법 2: 모든 frame
  const diagLines = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const url = f.url();
    if (url === 'about:blank' || url === 'about:srcdoc') continue;
    const urlShort = url.split('/').pop().substring(0, 30);
    try {
      const hasSheetA = await f.evaluate(() => !!document.querySelector('#sheetDivA'));
      if (!hasSheetA) continue;
      diagLines.push(`[${urlShort}:sheetA=true]`);
      const units = await f.evaluate(fn);
      if (Array.isArray(units) && units.length) return units;
    } catch (e) {
      diagLines.push(`[${urlShort}:ERR:${e.message.substring(0, 40)}]`);
    }
  }

  return { __diag: diagLines.join(' ') };
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 특정 호 행 클릭
 *
 *  listIndex(0-based) 기반 scroll → APT_NO_ROOM 셀 스캔 → 클릭
 *  IBSheet API 가능하면 정확한 위치로 스크롤, 아니면 근사값 사용
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, dong, ho, listIndex = 0) {
  const target = `${dong}-${ho}`;

  // Phase 1: 목표 행 위치로 스크롤 (스크롤만, 클릭 안 함)
  const scrollFn = (params) => {
    const { t, li } = params;
    const sheetA = document.querySelector('#sheetDivA');
    if (!sheetA) return false;
    const scrollEl = sheetA.querySelector('.IBSectionScroll');
    if (!scrollEl) return false;

    // IBSheet API로 정확한 위치 탐색
    try {
      const m = (scrollEl.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      const sheet = window.IBSheet?.[m ? parseInt(m[1]) : 0];
      if (sheet) {
        const getLastRow = sheet.LastRow || sheet.GetRowCount || sheet.RowCount;
        const getCellVal = sheet.GetCellValue || sheet.GetValue;
        if (typeof getLastRow === 'function' && typeof getCellVal === 'function') {
          const last = getLastRow.call(sheet);
          for (let i = 1; i <= last; i++) {
            const v = (getCellVal.call(sheet, i, 'APT_NO_ROOM') || '').trim()
              .replace(/\s+/g, '').replace(/[-–—]/g, '-');
            if (v !== t) continue;
            scrollEl.scrollTop = Math.max(0, (i - 1) * 20 - scrollEl.clientHeight / 2);
            return true;
          }
        }
      }
    } catch (e) {}

    // IBSheet API 없음 → listIndex 기반 근사 위치로 스크롤
    scrollEl.scrollTop = Math.max(0, li * 20 - scrollEl.clientHeight / 2);
    return true;
  };

  // Phase 2: 스크롤 후 APT_NO_ROOM 텍스트로 행 찾아 클릭
  const clickFn = (t) => {
    const sheetA = document.querySelector('#sheetDivA');
    if (!sheetA) return false;
    for (const row of sheetA.querySelectorAll('tr.IBDataRow')) {
      const td = row.querySelector('[class*="APT_NO_ROOM"]');
      if (!td) continue;
      const text = (td.innerText || '').trim().replace(/\s+/g, '').replace(/[-–—]/g, '-');
      if (text === t) { row.click(); return true; }
    }
    return false;
  };

  const executeClick = async (evalFn) => {
    // 먼저 visible 행에서 직접 시도
    if (await evalFn(clickFn, target)) return true;
    // 없으면 스크롤 후 재시도
    await evalFn(scrollFn, { t: target, li: listIndex });
    await page.waitForTimeout(100);
    return await evalFn(clickFn, target);
  };

  // 방법 1: frameLocator
  try {
    const fl = page.frameLocator(SEL_FEE);
    if (await executeClick((fn, arg) => fl.locator('body').evaluate(fn, arg))) return;
  } catch {}

  // 방법 2: 모든 frame
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      if (await executeClick((fn, arg) => f.evaluate(fn, arg))) return;
    } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 선택 호 전체 데이터 수집
 *
 *  모든 섹션이 IBSheet 이중 구조:
 *    container → tr.IBDataRow (IBSection 내부)
 *    숨김 제거: width:0px + HideCol 접두사 클래스
 *
 *  고지내역  : .cont_table.left.mgR5:not(.show0)  — 2컬럼 (항목명|금액)
 *  검침내역  : .cont_table.sheetDTap              — 항목|전월|당월|요금
 *  할인내역  : .cont_table.left.sheetETap         — 2컬럼 (항목명|금액)
 *  항목별요약: #lbl_item_amt / #lbl_curr_amt / #lbl_jul_amt
 *  항목별표  : .cont_table.left.mgR5.show0        — 6컬럼 (3쌍: 항목명|금액 반복)
 * ═══════════════════════════════════════════════════════════ */
async function collectFeeData(page) {
  const fn = () => {
    const data = {};

    // ── 공통 헬퍼 ────────────────────────────────────────────
    function txt(el) {
      if (!el) return '';
      const s = el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || '');
      return s.trim().replace(/,/g, '');
    }
    // width:0px AND HideCol 클래스 둘 다 필터
    function visTds(row) {
      return Array.from(row.querySelectorAll('td')).filter(td => {
        if (td.style.width === '0px' || td.style.width === '0') return false;
        for (const cls of td.classList) { if (cls.startsWith('HideCol')) return false; }
        return true;
      });
    }
    // IBDataRow 만 사용 — fallback 제거 (헤더행 오염 차단)
    function dataRows(container) {
      if (!container) return [];
      return Array.from(container.querySelectorAll('tr.IBDataRow'));
    }
    // IBSheet 빈 데이터 안내 메시지 목록
    const NODATA_MSGS = ['조회된 데이터가 없습니다.', '데이터가 없습니다.', '조회결과가 없습니다.'];

    // (항목명|금액) 쌍 반복 추출 — 2컬럼/4컬럼/6컬럼 모두 처리
    function extractPairs(container, prefix, skipKeys) {
      for (const row of dataRows(container)) {
        const cells = visTds(row);
        // IBSheet 빈 데이터 메시지 행 스킵
        if (cells.length === 1 && NODATA_MSGS.some(m => cells[0].innerText.includes(m))) continue;
        for (let i = 0; i + 1 < cells.length; i += 2) {
          const key = cells[i].innerText.trim();
          const val = txt(cells[i + 1]);
          // 빈 키, 헤더 스킵 키, 비정상 길이(헤더 연결 방지) 제외
          if (!key || key.length > 30 || skipKeys.includes(key)) continue;
          if (NODATA_MSGS.some(m => val.includes(m))) continue;
          data[prefix ? `${prefix}_${key}` : key] = val;
        }
      }
    }

    // ── 고지내역 ─────────────────────────────────────────────
    extractPairs(
      document.querySelector('.cont_table.left.mgR5:not(.show0)'),
      '',
      ['항목', '항목명', '순번', '합계', '']
    );

    // ── 검침내역 ─────────────────────────────────────────────
    const meterEl = document.querySelector('.cont_table.sheetDTap');
    for (const row of dataRows(meterEl)) {
      const cells = visTds(row);
      if (!cells.length) continue;
      if (cells.length === 1 && NODATA_MSGS.some(m => cells[0].innerText.includes(m))) continue;
      const item = cells[0]?.innerText.trim();
      if (!item || ['검침항목', '항목', '합계', ''].includes(item)) continue;
      const pfx = `검침_${item}`;
      if (cells[1]) data[`${pfx}_전월`] = txt(cells[1]);
      if (cells[2]) data[`${pfx}_당월`] = txt(cells[2]);
      if (cells[3]) data[`${pfx}_요금`] = txt(cells[3]);
    }

    // ── 할인내역 ─────────────────────────────────────────────
    extractPairs(
      document.querySelector('.cont_table.left.sheetETap'),
      '할인',
      ['할인항목명', '항목', '순번', '신청일자', '적용할인금액', '건수', '할인일자', '합계', '']
    );

    // ── 항목별 부과 — ID 요약값 ──────────────────────────────
    const itemAmt = document.querySelector('#lbl_item_amt');
    const currAmt = document.querySelector('#lbl_curr_amt');
    const julAmt  = document.querySelector('#lbl_jul_amt');
    if (itemAmt) data['부과항목계'] = txt(itemAmt);
    if (currAmt) data['당월부과액'] = txt(currAmt);
    if (julAmt)  data['절상차액']   = txt(julAmt);

    // ── 항목별 부과 — 6컬럼 쌍 테이블 ───────────────────────
    // 구조: 항목명|금액|항목명|금액|항목명|금액 (3쌍/행)
    extractPairs(
      document.querySelector('.cont_table.left.mgR5.show0'),
      '항목',
      ['항목명', '항목', '부과항목', '합계', '']
    );

    return data;
  };

  // 방법 1: frameLocator
  try {
    const d = await page.frameLocator(SEL_FEE).locator('body').evaluate(fn);
    if (Object.keys(d).length > 0) return d;
  } catch {}

  // 방법 2: 모든 frame 순회
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const d = await f.evaluate(fn);
      if (Object.keys(d).length > 0) return d;
    } catch {}
  }

  return {};
}

module.exports = { runCollect, stopCollect };
