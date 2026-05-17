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
        await page.waitForTimeout(600);

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
 *
 *  관리비조회와 동일하게 IBSheet[n].Rows 내부 메모리 접근으로
 *  가상 스크롤 우회 → 847행 전체 수집
 *
 *  컬럼 ID 자동 탐색:
 *    DOM 첫 IBDataRow의 HideColXXX 클래스에서 동/호 ID 추출
 *    전화번호 컬럼: 010/011... 패턴 값 가진 컬럼 자동 탐색
 * ═══════════════════════════════════════════════════════════ */
async function readResidentData(page) {
  const fn = () => {
    const map = {};
    const RE_PHONE = /^0[1][0-9][-\s]?\d{3,4}[-\s]?\d{4}$/;

    const container = document.querySelector('.cont_table');
    if (!container) return map;

    // IBSheet 인스턴스 가져오기
    const scrollEl = container.querySelector('.IBSectionScroll');
    const sheetIdx = (() => {
      const m = (scrollEl?.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      return m ? parseInt(m[1]) : 0;
    })();
    const sheet = window.IBSheet?.[sheetIdx];

    // HideColXXX 클래스에서 컬럼 ID 추출
    function getColId(td) {
      for (const cls of td.classList) {
        if (cls.startsWith('HideCol')) {
          return cls.slice('HideCol'.length).replace(/^\d+/, '');
        }
      }
      return null;
    }
    function visTds(row) {
      return Array.from(row.querySelectorAll('td'))
        .filter(td => td.style.width !== '0px' && td.style.width !== '0');
    }

    // ── 방법 A: IBSheet.Rows 전체 행 접근 ──────────────────
    if (sheet && sheet.Rows && typeof sheet.Rows === 'object') {
      // ── 컬럼 통계 탐색 (DOM 가시성 무관) ─────────────────────
      const arAllKeys = Object.keys(sheet.Rows)
        .filter(k => /^AR\d+$/.test(k))
        .sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));

      // 전화번호 컬럼: 010/011 패턴 값 보유
      let phoneColId = null;
      for (const key of arAllKeys) {
        const rd = sheet.Rows[key];
        if (!rd) continue;
        for (const [col, val] of Object.entries(rd)) {
          if (RE_PHONE.test(String(val || '').trim().replace(/\s+/g, ''))) {
            phoneColId = col; break;
          }
        }
        if (phoneColId) break;
      }
      // 패턴 미발견 시 컬럼 이름으로 추가 탐색
      if (!phoneColId) {
        const firstRd = sheet.Rows[arAllKeys[0]] || {};
        const kwds = ['HP_NO','HP','MOBILE','MOBILE_NO','CELL','PHONE','TEL'];
        phoneColId = Object.keys(firstRd)
          .find(k => kwds.some(w => k.toUpperCase().includes(w))) || null;
      }

      // 동/호 컬럼: 샘플 20행의 값 분포로 통계 탐색
      // 동 컬럼: 소수(1-99)이며 행 간 거의 동일
      // 호 컬럼: 101-9999 범위의 다양한 값
      const sample = arAllKeys.slice(0, 20)
        .map(k => sheet.Rows[k]).filter(Boolean);
      const colDongSets = {}, colHoSets = {};
      for (const rd of sample) {
        for (const [col, val] of Object.entries(rd)) {
          const v = String(val || '').trim();
          const n = parseInt(v);
          if (/^\d{1,2}$/.test(v) && n >= 1 && n <= 99) {
            colDongSets[col] = colDongSets[col] || new Set();
            colDongSets[col].add(v);
          }
          if (/^\d{3,4}$/.test(v) && n >= 101 && n <= 9999
              && !(n >= 1900 && n <= 2100)) {
            colHoSets[col] = colHoSets[col] || new Set();
            colHoSets[col].add(v);
          }
        }
      }
      // 동 컬럼: 작은 고유값 수 (같은 동 내 단위는 동 값이 동일)
      const dongColId = Object.entries(colDongSets)
        .sort(([,a],[,b]) => a.size - b.size)[0]?.[0] || null;
      // 호 컬럼: 많은 고유값 (각 세대마다 다른 호)
      const hoColId = Object.entries(colHoSets)
        .filter(([col]) => col !== dongColId)
        .sort(([,a],[,b]) => b.size - a.size)[0]?.[0] || null;

      if (dongColId && hoColId) {
        const arKeys = Object.keys(sheet.Rows)
          .filter(k => /^AR\d+$/.test(k))
          .sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));

        let lastDong = '';
        for (const key of arKeys) {
          const rd = sheet.Rows[key];
          if (!rd) continue;
          const dong  = String(rd[dongColId] || '').trim();
          const ho    = String(rd[hoColId]   || '').trim();
          const phone = phoneColId ? String(rd[phoneColId] || '').trim() : '';

          if (dong && /^\d{1,4}$/.test(dong) && dong !== '합계') lastDong = dong;
          if (ho && /^\d{2,4}$/.test(ho) && ho !== '합계' && lastDong) {
            map[`${lastDong}-${ho}`] = phone;
          }
        }
        if (Object.keys(map).length > 0) return map;
      }
    }

    // ── 방법 B: DOM visible 행 폴백 (부분 수집) ────────────
    let lastDong = '';
    for (const row of container.querySelectorAll('tr.IBDataRow')) {
      const tds = visTds(row);
      if (tds.length < 2) continue;
      const c0 = (tds[0]?.innerText || '').trim().split(/[\t\n]/)[0].replace(/\s+/g, '');
      const c1 = (tds[1]?.innerText || '').trim().split(/[\t\n]/)[0].replace(/\s+/g, '');
      const phone = tds.map(td => (td.innerText||'').trim().replace(/\s+/g,''))
        .find(v => RE_PHONE.test(v)) || '';

      if (/^\d{1,4}$/.test(c0) && /^\d{2,4}$/.test(c1)) {
        lastDong = c0;
        map[`${lastDong}-${c1}`] = phone;
      } else if (/^\d{2,4}$/.test(c0) && lastDong) {
        map[`${lastDong}-${c0}`] = phone;
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

    // ── 방법 A: IBSheet[n].Rows 내부 메모리 접근 ────────────
    // IBSheet는 모든 행 데이터를 Rows["AR1"], Rows["AR2"]... 로 메모리에 저장.
    // 스크롤/가시성과 무관하게 전체 847행 일괄 조회 가능.
    // DOM 확인: ontouchstart="IBSheet[0].ARow=IBSheet[0].Rows["AR1"];..."
    try {
      const m = (scrollEl?.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      const sheetIdx = m ? parseInt(m[1]) : 0;
      const sheet = window.IBSheet?.[sheetIdx];
      if (sheet && sheet.Rows && typeof sheet.Rows === 'object') {
        const arKeys = Object.keys(sheet.Rows)
          .filter(k => /^AR\d+$/.test(k))
          .sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
        if (arKeys.length > 0) {
          const result = [], seen = new Set();
          for (const key of arKeys) {
            const row = sheet.Rows[key];
            if (!row) continue;
            const v = row['APT_NO_ROOM'];
            if (!v || String(v).trim() === '전체') continue;
            const m2 = String(v).trim().match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
            if (!m2) continue;
            const dk = `${m2[1]}-${m2[2]}`;
            if (!seen.has(dk)) { seen.add(dk); result.push({ dongho: dk, dong: m2[1], ho: m2[2] }); }
          }
          if (result.length) return result;
        }
      }
    } catch (e) {}

    // ── 방법 B: IBSheet API 메서드 (다양한 이름 시도) ────────
    try {
      const m = (scrollEl?.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      const sheet = window.IBSheet?.[m ? parseInt(m[1]) : 0];
      if (sheet) {
        const getLastRow = sheet.LastRow || sheet.GetRowCount || sheet.RowCount;
        const getCellVal = sheet.GetCellValue || sheet.GetValue;
        if (typeof getLastRow === 'function' && typeof getCellVal === 'function') {
          const last = getLastRow.call(sheet);
          if (last > 0) {
            const result = [], seen = new Set();
            for (let i = 1; i <= last; i++) {
              const v = getCellVal.call(sheet, i, 'APT_NO_ROOM');
              if (!v || String(v).trim() === '전체') continue;
              const m2 = String(v).trim().match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
              if (!m2) continue;
              const dk = `${m2[1]}-${m2[2]}`;
              if (!seen.has(dk)) { seen.add(dk); result.push({ dongho: dk, dong: m2[1], ho: m2[2] }); }
            }
            if (result.length) return result;
          }
        }
      }
    } catch (e) {}

    // ── 방법 C: DOM visible 행 (폴백, 28행 한계) ────────────
    const result = [], seen = new Set();
    for (const row of sheetA.querySelectorAll('tr.IBDataRow')) {
      const td = row.querySelector('[class*="APT_NO_ROOM"]');
      if (!td) continue;
      const text = (td.innerText || '').trim();
      if (!text || text === '전체') continue;
      const m = text.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
      if (!m) continue;
      const dk = `${m[1]}-${m[2]}`;
      if (!seen.has(dk)) { seen.add(dk); result.push({ dongho: dk, dong: m[1], ho: m[2] }); }
    }
    return result;
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
 *  핵심: element.click() (isTrusted=false, which=0) → IBSheet 무시
 *  해결: Playwright locator.click() → CDP 레벨 실제 마우스 이벤트 (isTrusted=true)
 *
 *  Phase 1: JS evaluate로 IBSheet 스크롤 (렌더 강제)
 *  Phase 2: Playwright locator.click() 로 신뢰된 클릭 전송
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, dong, ho, listIndex = 0) {
  const target = `${dong}-${ho}`;

  // Phase 1: IBSheet 스크롤 (JS evaluate)
  const scrollFn = (params) => {
    const { t, li } = params;
    const sheetA = document.querySelector('#sheetDivA');
    const scrollEl = sheetA?.querySelector('.IBSectionScroll');
    if (!scrollEl) return;

    let newTop = Math.max(0, li * 20 - scrollEl.clientHeight / 2);
    try {
      const m = (scrollEl.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      const sheet = window.IBSheet?.[m ? parseInt(m[1]) : 0];
      if (sheet?.Rows) {
        for (const key of Object.keys(sheet.Rows)) {
          if (!/^AR\d+$/.test(key)) continue;
          const v = (sheet.Rows[key]?.['APT_NO_ROOM'] || '').trim()
            .replace(/\s+/g,'').replace(/[-–—]/g,'-');
          if (v !== t) continue;
          newTop = Math.max(0, (parseInt(key.slice(2)) - 1) * 20 - scrollEl.clientHeight / 2);
          break;
        }
      }
    } catch(e) {}

    scrollEl.scrollTop = newTop;
    scrollEl.dispatchEvent(new Event('scroll')); // IBSheet 재렌더 강제
  };

  // Phase 2: Playwright 네이티브 클릭 (CDP 이벤트 → isTrusted=true)
  const playwrightClick = async (fl) => {
    try {
      // 스크롤 먼저
      await fl.locator('body').evaluate(scrollFn, { t: target, li: listIndex });
      await page.waitForTimeout(150);

      // APT_NO_ROOM 셀 중 "N - NNN" 텍스트 매칭 → Playwright 클릭
      const re = new RegExp(`^\\s*${dong}\\s*[-–—]\\s*${ho}\\s*$`);
      const cellLoc = fl.locator('#sheetDivA [class*="APT_NO_ROOM"]').filter({ hasText: re });

      const cnt = await cellLoc.count();
      if (cnt === 0) return false;

      await cellLoc.first().click({ timeout: 1500, force: true });
      return true;
    } catch { return false; }
  };

  // 방법 1: frameLocator
  try {
    if (await playwrightClick(page.frameLocator(SEL_FEE))) return;
  } catch {}

  // 방법 2: 모든 frame
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const hasSheetA = await f.evaluate(() => !!document.querySelector('#sheetDivA'));
      if (!hasSheetA) continue;
      const fl = page.frameLocator(`iframe[src="${f.url()}"]`);
      if (await playwrightClick(fl)) return;
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
