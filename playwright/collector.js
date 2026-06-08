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
const SEL_FEE_RE   = /703m01|010m01|OCCP1010/;

/* ── 속도 최적화 헬퍼 ────────────────────────────────────────
 *  관리비조회 frame 직접 접근으로 waitForFunction 사용
 *  (page.frameLocator() 는 매번 frame 탐색 오버헤드 발생)
 * ──────────────────────────────────────────────────────────── */
function findFeeFrame(page) {
  return page.frames().find(f => SEL_FEE_RE.test(f.url())) || null;
}

// ERP 관리비조회 화면에서 청구 년월(YYYYMM) 읽기
// 년월 선택 select 또는 페이지 텍스트에서 "YYYY년 MM월" 파싱
async function readFeeYearMonth(page) {
  try {
    const feeFrame = findFeeFrame(page);
    if (!feeFrame) return null;
    return await feeFrame.evaluate(() => {
      const getVal = el => el?.value || el?.options?.[el?.selectedIndex]?.value || '';
      const year  = getVal(document.querySelector('select[id*="year" i],select[name*="year" i]'));
      const month = getVal(document.querySelector('select[id*="month" i],select[name*="month" i]'));
      if (year && month && /^\d{4}$/.test(year) && /^\d{1,2}$/.test(month)) {
        return `${year}${String(month).padStart(2, '0')}`;
      }
      const text = document.body.innerText || '';
      const m = text.match(/(\d{4})년\s*(\d{1,2})월/);
      if (m) return `${m[1]}${String(m[2]).padStart(2, '0')}`;
      return null;
    });
  } catch { return null; }
}

// 현재 관리비조회 IBSheet에서 선택(포커스)된 행의 동호 읽기
// IBCellFocusedCell 이 있는 tr 에서 APT_NO_ROOM 셀 텍스트 파싱
async function readCurrentUnit(page) {
  try {
    const f = findFeeFrame(page);
    if (!f) return null;
    return await f.evaluate(() => {
      const sheetA = document.querySelector('#sheetDivA');
      if (!sheetA) return null;
      // 포커스 셀을 포함한 행 찾기
      for (const row of sheetA.querySelectorAll('tr.IBDataRow')) {
        if (!row.querySelector('.IBCellFocusedCell')) continue;
        const aptCell = row.querySelector('[class*="APT_NO_ROOM"]');
        if (!aptCell) break;
        const text = (aptCell.innerText || '').trim();
        const m = text.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
        if (m) return { dong: String(parseInt(m[1])), ho: String(parseInt(m[2])) };
        break;
      }
      return null;
    });
  } catch { return null; }
}

// 클릭 전 #lbl_item_amt 현재 값 읽기
async function readLblAmt(page) {
  try {
    const f = findFeeFrame(page);
    if (!f) return '';
    return await f.evaluate(() =>
      (document.querySelector('#lbl_item_amt')?.innerText || '').replace(/,/g, '').trim()
    );
  } catch { return ''; }
}

// 클릭 후 #lbl_item_amt 값 변경 감지 (50ms 폴링, 최대 maxMs)
// → AJAX 응답 완료 즉시 다음 단계로 진행
async function waitForAmt(page, prevValue, maxMs = 3000) {
  // div_55(#lbl_item_amt, ~218ms) + div_1(고지내역, ~307ms) 모두 완료 대기.
  // 고지내역이 없으면 #lbl_item_amt 변경만으로도 진행.
  try {
    const f = findFeeFrame(page);
    if (!f) return;
    await f.waitForFunction(
      ([sel, prev]) => {
        const el = document.querySelector(sel);
        if (!el) return true;
        const curr = (el.innerText || '').replace(/,/g, '').trim();
        if (curr === prev || !curr) return false;
        // 고지내역 테이블이 존재하면 데이터 로드 완료 확인
        const noti = document.querySelector('.cont_table.left.mgR5:not(.show0)');
        if (noti && noti.querySelectorAll('tr').length < 2) return false;
        return true;
      },
      ['#lbl_item_amt', prevValue],
      { timeout: maxMs, polling: 50 }
    );
  } catch {} // timeout(같은 값인 세대) 시 그냥 진행
}

/* ═══════════════════════════════════════════════════════════
 *  STEP 1: 입주자현황 수집 → 이름/휴대폰 맵 반환
 * ═══════════════════════════════════════════════════════════ */
async function runResidentCollect(onProgress) {
  stopFlag = false;
  try {
    const page = await getPage();
    onProgress({ text: '입주자현황 읽는 중...' });
    const map = await readResidentData(page);
    const count = Object.keys(map).length;
    if (count === 0) {
      return {
        ok: false,
        error: '입주자현황 데이터를 읽지 못했습니다.\nXpERP 입주자현황 탭을 열고 첫 번째 행을 클릭한 뒤 다시 시도하세요.',
      };
    }
    return { ok: true, count, map };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════
 *  STEP 2: 관리비 수집 → 엑셀 생성
 *  residentMap: step 1에서 수집한 이름/휴대폰 맵 (없으면 빈 객체)
 * ═══════════════════════════════════════════════════════════ */
async function runFeeCollect(residentMap, onProgress) {
  stopFlag = false;
  const page      = await getPage();
  const outputDir = path.join(__dirname, '..', 'output');
  const logsDir   = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir))   fs.mkdirSync(logsDir,   { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const allData     = [];
  const failedUnits = [];
  const rMap        = residentMap || {};

  try {
    // 청구 년월 읽기 (ERP 화면 기준 — 수집 시점 날짜가 아닌 실제 청구월)
    const feeYearMonth = await readFeeYearMonth(page);

    onProgress({ current: 0, total: 0, unit: '관리비조회 목록 읽는 중...' });
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

    // ── 첫 행 자동 클릭 — 사용자 수동 클릭 불필요 ────────────
    // IBSheet ArrowDown이 동작하려면 .IBCellFocusedCell 상태 필요.
    // 수집 시작 전 첫 번째 IBDataRow를 Playwright locator.click()으로
    // 자동 선택해 포커스를 확보한다.
    try {
      const feeFrame = findFeeFrame(page);
      if (feeFrame) {
        onProgress({ current: 0, total, unit: '첫 행 자동 선택 중...' });
        const prevFirst = await readLblAmt(page);
        await feeFrame.locator('#sheetDivA tr.IBDataRow').first().click();
        await waitForAmt(page, prevFirst, 4000);
        await page.waitForTimeout(200); // 렌더링 안정화
      }
    } catch {}

    onProgress({ current: 0, total, unit: '수집 시작' });

    for (let i = 0; i < feeUnits.length; i++) {
      if (stopFlag) break;
      const unit = feeUnits[i];
      onProgress({ current: i + 1, total, unit: unit.dongho });

      try {
        const prevAmt = await readLblAmt(page);
        await clickFeeUnit(page, unit.dong, unit.ho, i);
        await waitForAmt(page, prevAmt);

        // ── 동호 검증: 현재 선택된 행이 예상 동호인지 확인 ────
        // 불일치 시 ArrowDown 한 번 더 시도 → 여전히 불일치면 조용히 스킵
        const actual = await readCurrentUnit(page);
        if (actual &&
            (parseInt(actual.dong) !== parseInt(unit.dong) ||
             parseInt(actual.ho)   !== parseInt(unit.ho))) {
          // 한 번 더 이동 후 재확인
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(200);
          const actual2 = await readCurrentUnit(page);
          if (!actual2 ||
              parseInt(actual2.dong) !== parseInt(unit.dong) ||
              parseInt(actual2.ho)   !== parseInt(unit.ho)) {
            // 복구 실패 → 로그 파일에만 기록, UI 실패 목록 미포함
            saveErrorLog(logsDir, unit.dongho,
              `동호 불일치 skip — 예상: ${unit.dong}-${unit.ho}, 실제: ${actual2?.dong}-${actual2?.ho}`);
            continue;
          }
          // 복구 성공 → 정상 진행
        }

        const feeData  = await collectFeeData(page);
        const resident = rMap[`${unit.dong}-${unit.ho}`] || {};

        allData.push({
          dong: unit.dong, ho: unit.ho,
          name: resident.name || unit.name || '',
          phone: resident.phone || unit.phone || '',
          ...feeData,
        });
      } catch (err) {
        failedUnits.push(unit.dongho);
        saveErrorLog(logsDir, unit.dongho, err.message);
      }
    }

    if (!allData.length) {
      return { ok: false, error: '수집된 데이터가 없습니다.' };
    }

    const filePath = await exportExcel(allData, outputDir, feeYearMonth);
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
 *  입주자현황: 동/호 → 이름/휴대폰 맵
 *
 *  IBSheet 가상 스크롤 특성:
 *    scrollHeight === clientHeight → DOM scrollTop 불가
 *    PageDown 키보드 이벤트로 IBSheet 내부 스크롤 유도
 *
 *  2단계 수집:
 *    Phase 1: 현재 보이는 행 DOM 직접 읽기 (~21행)
 *    Phase 2: PageDown 반복으로 전체 행 수집
 *      - force click으로 IBSheet 포커스 → PageDown → 수집 반복
 *      - 3회 연속 새 행 없으면 맨 아래로 판단하고 종료
 * ═══════════════════════════════════════════════════════════ */

// evaluate()에 직렬화해서 넘기는 헬퍼 — 브라우저 컨텍스트에서 실행됨
function collectVisible(lastDong) {
  const RE_PHONE = /^01[0-9]\d{7,8}$/;
  const container = document.querySelector('.cont_table');
  if (!container) return { rows: [], lastDong };
  let ld = lastDong || '';
  const rows = [];
  for (const row of container.querySelectorAll('tr.IBDataRow')) {
    const allTds = Array.from(row.querySelectorAll('td'));
    // 동/호 판별용: 너비 있는 컬럼만
    const visTds = allTds.filter(td => td.style.width !== '0px' && td.style.width !== '0');
    if (visTds.length < 2) continue;
    const vals = visTds.map(td => (td.innerText || '').split('\n')[0].trim());
    const c0 = vals[0] || '', c1 = vals[1] || '';
    const name = vals[2] || '';
    // 전화번호: 숨김 컬럼(width:0)도 포함해서 전체 td 스캔 (textContent 사용)
    const phone = allTds
      .map(td => (td.textContent || '').split('\n')[0].trim().replace(/[-.\s]/g, ''))
      .find(v => RE_PHONE.test(v)) || '';
    if (/^\d{1,2}$/.test(c0) && /^\d{2,4}$/.test(c1)) {
      ld = c0; rows.push({ dk: `${c0}-${c1}`, name, phone });
    } else if (/^\d{2,4}$/.test(c0) && ld) {
      rows.push({ dk: `${ld}-${c0}`, name, phone });
    }
  }
  return { rows, lastDong: ld };
}

async function readResidentData(page) {
  const RE_RESIDENT_URL = /020m02|IMPO2020|OCCP2020/i;
  const resFrame = page.frames().find(f => RE_RESIDENT_URL.test(f.url()))
    || page.frames().find(f => /020m/.test(f.url()) && f.url() !== page.url());
  if (!resFrame) return {};

  // ── Phase 1: 보이는 행 DOM 수집 ─────────────────────────────
  const map = {};
  const { rows: visRows, lastDong: initLastDong } = await resFrame.evaluate(collectVisible, '');

  for (const r of visRows) {
    if (!map[r.dk]) map[r.dk] = { name: r.name, phone: r.phone };
    else if (r.phone && !map[r.dk].phone) map[r.dk].phone = r.phone;
  }

  // ── Phase 2: PageDown 키보드 네비게이션으로 전체 행 수집 ────────
  try {
    await resFrame.locator('tr.IBDataRow').first().click({ force: true });
    await page.waitForTimeout(200);

    let lastDong   = initLastDong;
    let staleCount  = 0;
    let prevMapSize = Object.keys(map).length;

    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(160);

      const { rows, lastDong: ld } = await resFrame.evaluate(collectVisible, lastDong);
      lastDong = ld;
      for (const r of rows) {
        if (!map[r.dk])                       map[r.dk] = { name: r.name, phone: r.phone };
        else if (r.phone && !map[r.dk].phone) map[r.dk].phone = r.phone;
      }

      const newSize = Object.keys(map).length;
      if (newSize === prevMapSize) { staleCount++; }
      else { staleCount = 0; prevMapSize = newSize; }
      if (staleCount >= 3) break;
    }
  } catch {}

  // ── Phase 3: IBSheet.Rows / GetCellValue로 전체 846행 phone 보완 ────────
  // 확인된 컬럼 ID (XpERP occp_020m02 입주자현황):
  //   PRT_APT_NO      : 동 ("1")
  //   PRT_APT_ROOM    : 호 ("101")
  //   I_MOBILE_TEL_NO1: 입주자 휴대폰 ("010-xxxx-xxxx")
  //   S_MOBILE_TEL_NO1: 소유주 휴대폰 (fallback)
  try {
    const phoneMap = await resFrame.evaluate(() => {
      const RE_PHONE = /^01[0-9]\d{7,8}$/;
      const container = document.querySelector('.cont_table');
      if (!container) return {};

      const scrollEl = container.querySelector('.IBSectionScroll');
      const m = (scrollEl?.getAttribute('onscroll') || '').match(/IBSheet\[(\d+)\]/);
      const sheet = window.IBSheet?.[m ? parseInt(m[1]) : 0];
      if (!sheet) return {};

      const gv = v => {
        if (v == null) return '';
        if (typeof v === 'string') return v.trim();
        try { return String(v.innerText ?? v.textContent ?? '').trim(); } catch { return ''; }
      };

      // 방법 A: IBSheet.Rows 직접 접근 (하드코딩 컬럼 ID)
      const arKeys = Object.keys(sheet.Rows || {})
        .filter(k => /^AR\d+$/.test(k))
        .sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));

      if (arKeys.length > 0) {
        const result = {};
        for (const key of arKeys) {
          try {
            const row = sheet.Rows[key];
            if (!row) continue;
            const dong = gv(row['PRT_APT_NO']);
            const ho   = gv(row['PRT_APT_ROOM']);
            if (!dong || !ho) continue;
            const dk = `${parseInt(dong)}-${parseInt(ho)}`;
            let ph = gv(row['I_MOBILE_TEL_NO1']).replace(/[-.\s]/g, '');
            if (!RE_PHONE.test(ph)) ph = gv(row['S_MOBILE_TEL_NO1']).replace(/[-.\s]/g, '');
            if (RE_PHONE.test(ph)) result[dk] = ph;
          } catch {}
        }
        if (Object.keys(result).length > 0) return result;
      }

      // 방법 B: GetCellValue API fallback
      const gcv = sheet.GetCellValue?.bind(sheet) || sheet.GetValue?.bind(sheet);
      const lastRow = (sheet.LastRow || sheet.GetRowCount)?.call(sheet);
      if (!gcv || !lastRow || lastRow < 1) return {};

      const result = {};
      for (let r = 1; r <= lastRow; r++) {
        try {
          const dong = String(gcv(r, 'PRT_APT_NO') || '').trim();
          const ho   = String(gcv(r, 'PRT_APT_ROOM') || '').trim();
          if (!dong || !ho) continue;
          const dk = `${parseInt(dong)}-${parseInt(ho)}`;
          let ph = String(gcv(r, 'I_MOBILE_TEL_NO1') || '').replace(/[-.\s]/g, '');
          if (!RE_PHONE.test(ph)) ph = String(gcv(r, 'S_MOBILE_TEL_NO1') || '').replace(/[-.\s]/g, '');
          if (RE_PHONE.test(ph)) result[dk] = ph;
        } catch {}
      }
      return result;
    });

    for (const [dk, ph] of Object.entries(phoneMap)) {
      if (map[dk]) map[dk].phone = map[dk].phone || ph;
      else         map[dk] = { name: '', phone: ph };
    }
  } catch {}

  return map;
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
          // DOM element 또는 string 값 모두 처리하는 헬퍼
          const gv = v => {
            if (!v) return '';
            if (typeof v === 'string') return v.trim();
            try { return (v.innerText ?? v.textContent ?? '').trim(); } catch { return ''; }
          };
          const RE_PH = /^01[0-9]\d{7,8}$/;

          const result = [], seen = new Set();
          for (const key of arKeys) {
            const row = sheet.Rows[key];
            if (!row) continue;
            const v = gv(row['APT_NO_ROOM']);
            if (!v || v === '전체') continue;
            const m2 = v.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
            if (!m2) continue;
            const dk = `${m2[1]}-${m2[2]}`;
            if (!seen.has(dk)) {
              seen.add(dk);
              // 전화번호: DOM element 포함 전 필드 스캔
              let phone = '';
              for (const fk of Object.keys(row)) {
                try {
                  const s = gv(row[fk]).replace(/[-.\s]/g, '');
                  if (RE_PH.test(s)) { phone = s; break; }
                } catch {}
              }
              result.push({
                dongho: dk,
                dong: m2[1],
                ho: m2[2],
                name: gv(row['HSHL_HEAD_NM']),
                phone,
              });
            }
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
 *  ⚠️  폴백에서 page.frameLocator('iframe[src="..."]') 사용 시
 *      프레임 미매칭 → Playwright 기본 30초 타임아웃 발생 (2시간 원인)
 *      → SEL_FEE frameLocator 단독 사용, 폴백은 f.evaluate() 직접 사용
 *
 *  Phase 1: IBSheet 스크롤 (JS evaluate, dispatchEvent로 즉시 렌더)
 *  Phase 2: Playwright locator.click() — CDP 실제 마우스 이벤트 (isTrusted=true)
 *  Phase 3: JS 클릭 폴백 — Frame 객체 직접 evaluate (타임아웃 없음)
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, dong, ho, listIndex = 0) {
  // ArrowDown(CDP, isTrusted=true)으로 순차 행 이동.
  // 전제: 수집 시작 전 사용자가 첫 행(1-101)을 직접 클릭해야 함.
  //       → IBSheet가 .IBCellFocusedCell 상태를 가져야 ArrowDown이 작동.
  if (listIndex === 0) {
    // 첫 행은 사용자가 이미 클릭한 상태 → 아무것도 하지 않음
    return;
  }

  const feeFrame = findFeeFrame(page);
  if (!feeFrame) return;

  // .IBCellFocusedCell에 포커스 유지 → ArrowDown이 IBSheet에 도달
  try {
    await feeFrame.evaluate(() => {
      const cell = document.querySelector('.IBCellFocusedCell');
      if (cell) { cell.tabIndex = -1; cell.focus(); }
    });
  } catch {}

  await page.waitForTimeout(50);
  await page.keyboard.press('ArrowDown');
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
 *  항목별표  : .cont_table.left.mgR5.show0        — 세대별 항목(4쌍/행)
 * ═══════════════════════════════════════════════════════════ */
async function collectFeeData(page) {
  const fn = () => {
    const data = {};

    // ── 공통 헬퍼 ────────────────────────────────────────────
    function txt(el) {
      if (!el) return '';
      // IBSheet는 TD 안에 <input> 으로 값을 렌더링하는 경우가 있음
      const inp = el.querySelector && el.querySelector('input');
      if (inp) return (inp.value || '').trim().replace(/,/g, '');
      const s = el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || '');
      return s.trim().replace(/,/g, '');
    }
    // width:0px 만 필터 — HideCol 클래스는 IBSheet 컬럼 식별자일 뿐 숨김과 무관
    function visTds(row) {
      return Array.from(row.querySelectorAll('td')).filter(td =>
        td.style.width !== '0px' && td.style.width !== '0'
      );
    }
    // IBDataRow 만 사용 — fallback 제거 (헤더행 오염 차단)
    function dataRows(container) {
      if (!container) return [];
      return Array.from(container.querySelectorAll('tr.IBDataRow'));
    }
    // IBSheet 빈 데이터 안내 메시지 목록
    const NODATA_MSGS = ['조회된 데이터가 없습니다.', '데이터가 없습니다.', '조회결과가 없습니다.'];

    // (항목명|금액) 쌍 반복 추출 — 2컬럼/4컬럼/8컬럼 모두 처리
    function extractPairs(container, prefix, skipKeys) {
      for (const row of dataRows(container)) {
        const cells = visTds(row);
        // IBSheet 빈 데이터 메시지 행 스킵
        if (cells.length === 1 && NODATA_MSGS.some(m => cells[0].innerText.includes(m))) continue;
        for (let i = 0; i + 1 < cells.length; i += 2) {
          const key = cells[i].innerText.trim();
          const val = txt(cells[i + 1]);
          // 빈 키, 숫자 전용 키(순번), IBSheet 셀 ID(A5/B6 형태), 헤더 스킵 키, 비정상 길이 제외
          if (!key || /^\d+$/.test(key) || /^[A-Z]\d+$/.test(key) || key.length > 30 || skipKeys.includes(key)) continue;
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

    // ── 항목별 부과내역 — (항목명|금액|구분) 3열 구조 ──────────
    // 구분(과/비)은 width:0px 숨김 컬럼 → 모든 TD에서 3개씩 읽음
    const show0 = document.querySelector('.cont_table.left.mgR5.show0');
    if (show0) {
      for (const row of dataRows(show0)) {
        const allTds = Array.from(row.querySelectorAll('td'));
        if (allTds.length === 1 && NODATA_MSGS.some(m => allTds[0].innerText.includes(m))) continue;
        for (let i = 0; i + 2 < allTds.length; i += 3) {
          const name = (allTds[i].innerText || '').trim();
          const amt  = txt(allTds[i + 1]);
          const div  = (allTds[i + 2].innerText || '').trim();
          if (!name || /^\d+$/.test(name) || /^[A-Z]\d+$/.test(name) ||
              name.length > 30 || ['항목명','항목','금액','합계','구분',''].includes(name)) continue;
          data[`항목_${name}`] = amt;
          if (div === '과' || div === '비') data[`항목구분_${name}`] = div;
        }
      }
    }

    // ── 항목별 부과 — ID 요약값 ──────────────────────────────
    const itemAmt = document.querySelector('#lbl_item_amt');
    const currAmt = document.querySelector('#lbl_curr_amt');
    const julAmt  = document.querySelector('#lbl_jul_amt');
    if (itemAmt) data['부과항목계'] = txt(itemAmt);
    if (currAmt) data['당월부과액'] = txt(currAmt);
    if (julAmt)  data['절상차액']   = txt(julAmt);

    return data;
  };

  // 방법 1: findFeeFrame + 고지내역 로드 대기
  // frameLocator()는 직계 자식만 탐색 → 중첩 iframe 실패.
  // 고지내역 div_1 AJAX(~307ms)가 div_55(~218ms)보다 늦게 완료되므로 명시적 대기.
  const feeFrame = findFeeFrame(page);
  if (feeFrame) {
    await feeFrame.waitForFunction(() => {
      const t1 = document.querySelector('.cont_table.left.mgR5:not(.show0)');
      const t2 = document.querySelector('.cont_table.left.mgR5.show0');
      const ok1 = !t1 || t1.querySelectorAll('tr').length >= 2;
      const ok2 = !t2 || t2.querySelectorAll('tr').length >= 2;
      return ok1 && ok2;
    }, { timeout: 3000 }).catch(() => {});
    try {
      const d = await feeFrame.evaluate(fn);
      if (Object.keys(d).length > 0) return d;
    } catch {}
  }

  // 방법 2: 모든 frame 순회 (폴백)
  for (const f of page.frames()) {
    if (f === page.mainFrame() || f === feeFrame) continue;
    try {
      const d = await f.evaluate(fn);
      if (Object.keys(d).length > 0) return d;
    } catch {}
  }

  return {};
}

module.exports = { runResidentCollect, runFeeCollect, stopCollect };
