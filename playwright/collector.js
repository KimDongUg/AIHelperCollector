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
        await clickFeeUnit(page, unit.dong, unit.ho);
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
 *  관리비조회: 동호 목록 읽기 — 근본 수정
 *
 *  N-N 정규식 패턴 매칭 완전 제거.
 *  XpERP 동호내역 IBSheet 고유 식별자만 직접 사용:
 *    div#sheetDivA          → 동호내역 IBSheet 컨테이너 (관리비조회 전용)
 *    td[class*="APT_NO_ROOM"] → 동호 복합값 셀 ("1 - 101" 형태)
 *
 *  #sheetDivA 는 관리비조회 frame에만 존재 → 전화번호/사업자번호 오탐 원천 차단
 * ═══════════════════════════════════════════════════════════ */
async function readFeeUnitList(page) {
  const fn = () => {
    const sheetA = document.querySelector('#sheetDivA');
    if (!sheetA) return [];  // 관리비조회 미로드 → 즉시 빈 배열

    const result = [];
    const seen   = new Set();
    for (const row of sheetA.querySelectorAll('tr.IBDataRow')) {
      const td   = row.querySelector('[class*="APT_NO_ROOM"]');
      if (!td) continue;
      const text = (td.innerText || '').trim();
      if (!text || text === '전체') continue;
      // "1 - 101" 또는 "1-101" 파싱 — APT_NO_ROOM 셀 내부만 파싱하므로 오탐 불가
      const m = text.match(/(\d{1,4})\s*[-–—]\s*(\d{1,4})/);
      if (!m) continue;
      const dongho = `${m[1]}-${m[2]}`;
      if (!seen.has(dongho)) { seen.add(dongho); result.push({ dongho, dong: m[1], ho: m[2] }); }
    }
    return result;
  };

  // 방법 1: frameLocator (SEL_FEE 프레임 내 #sheetDivA)
  try {
    const units = await page.frameLocator(SEL_FEE).locator('body').evaluate(fn);
    if (units.length) return units;
  } catch {}

  // 방법 2: 모든 frame 순회 — #sheetDivA 없는 프레임은 fn이 [] 반환하므로 안전
  const diagLines = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const url = f.url();
    if (url === 'about:blank' || url === 'about:srcdoc') continue;
    const urlShort = url.split('/').pop().substring(0, 30);
    try {
      const diag = await f.evaluate(() => ({
        hasSheetA: !!document.querySelector('#sheetDivA'),
        ibRows: document.querySelector('#sheetDivA')
          ? document.querySelectorAll('#sheetDivA tr.IBDataRow').length : 0,
        sample: Array.from(document.querySelectorAll(
          '#sheetDivA tr.IBDataRow [class*="APT_NO_ROOM"]'
        )).slice(0, 3).map(td => (td.innerText || '').trim()),
      }));
      diagLines.push(`[${urlShort}:sheetA=${diag.hasSheetA}:IB=${diag.ibRows}:${JSON.stringify(diag.sample)}]`);
      const units = await f.evaluate(fn);
      if (units.length) return units;
    } catch (e) {
      diagLines.push(`[${urlShort}:ERR:${e.message.substring(0, 40)}]`);
    }
  }

  return { __diag: diagLines.join(' ') };
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 특정 호 행 클릭 — 근본 수정
 *
 *  #sheetDivA [class*="APT_NO_ROOM"] 셀 텍스트로 행 정확히 매칭.
 *  정규식 패턴 탐색 없음 → 오탐 불가
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, dong, ho) {
  const target = `${dong}-${ho}`;

  const fn = (t) => {
    const sheetA = document.querySelector('#sheetDivA');
    if (!sheetA) return false;
    for (const row of sheetA.querySelectorAll('tr.IBDataRow')) {
      const td = row.querySelector('[class*="APT_NO_ROOM"]');
      if (!td) continue;
      // "1 - 101" → 공백 제거 + 대시 통일 → "1-101"
      const text = (td.innerText || '').trim().replace(/\s+/g, '').replace(/[-–—]/g, '-');
      if (text === t) { row.click(); return true; }
    }
    return false;
  };

  // 방법 1: frameLocator
  try {
    const clicked = await page.frameLocator(SEL_FEE).locator('body').evaluate(fn, target);
    if (clicked) return;
  } catch {}

  // 방법 2: 모든 frame (#sheetDivA 없는 프레임은 false 반환으로 안전)
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const clicked = await f.evaluate(fn, target);
      if (clicked) return;
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
