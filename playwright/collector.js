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
 *  관리비조회: 동호 목록 읽기  (.cont_table.left → IBSheet)
 *
 *  IBSection 내부 tr.IBDataRow 탐색
 *  N-N 합쳐진 셀 OR 동/호 분리 셀 모두 지원
 * ═══════════════════════════════════════════════════════════ */
async function readFeeUnitList(page) {
  const fn = () => {
    // 전화번호·사업자번호 오탐 방지
    //  ① 뒤에 또 다른 -숫자 → 사업자번호(NNN-NN-NNNNN) 제외
    //  ② 앞에 숫자- → 전화번호 중간 그룹(010-2722-0528에서 2722-0528) 제외
    const RE = /(?<!\d[-–—])\b(\d{1,4})\s*[-–—]\s*(\d{2,4})\b(?!\s*[-–—]\s*\d)/;

    function visTds(row) {
      return Array.from(row.querySelectorAll('td')).filter(td => {
        if (td.style.width === '0px' || td.style.width === '0') return false;
        for (const cls of td.classList) { if (cls.startsWith('HideCol')) return false; }
        return true;
      });
    }
    function dedup(arr) {
      const seen = new Set();
      return arr.filter(u => seen.has(u.dongho) ? false : (seen.add(u.dongho), true));
    }
    function parseRows(rows) {
      const result = [];
      for (const row of rows) {
        const tds = visTds(row);
        if (!tds.length) continue;
        let found = false;
        // N-N 합쳐진 셀 탐색
        for (let ci = 0; ci < Math.min(tds.length, 4); ci++) {
          const m = (tds[ci]?.innerText || '').match(RE);
          // ho가 0으로 시작하면 전화번호 구성요소 (0528, 0123 등) → 제외
          if (m && parseInt(m[1]) >= 1 && parseInt(m[2]) >= 1 && !m[2].startsWith('0')) {
            result.push({ dongho: `${m[1]}-${m[2]}`, dong: m[1], ho: m[2] });
            found = true; break;
          }
        }
        // 분리 셀: tds[0]=동, tds[1]=호
        if (!found && tds.length >= 2) {
          const d = (tds[0]?.innerText || '').trim().split(/[\t\n]/)[0].replace(/\s+/g, '');
          const h = (tds[1]?.innerText || '').trim().split(/[\t\n]/)[0].replace(/\s+/g, '');
          if (/^\d{1,4}$/.test(d) && /^\d{2,4}$/.test(h) && parseInt(h) >= 101 && !h.startsWith('0')) {
            result.push({ dongho: `${d}-${h}`, dong: d, ho: h });
          }
        }
      }
      return result;
    }

    // .cont_table.left → IBSection tr.IBDataRow
    const donghoEl = document.querySelector('.cont_table.left');
    if (donghoEl) {
      const ibRows = Array.from(donghoEl.querySelectorAll('tr.IBDataRow'));
      if (ibRows.length) {
        const units = dedup(parseRows(ibRows));
        if (units.length) return units;
      }
      // fallback: 일반 table tr
      for (const table of donghoEl.querySelectorAll('table')) {
        const units = dedup(parseRows(Array.from(table.querySelectorAll('tbody tr, tr'))));
        if (units.length) return units;
      }
    }

    // 최후 fallback: 전체 문서 탐색
    let best = [], bestCount = 0;
    for (const table of document.querySelectorAll('table')) {
      const rows = parseRows(Array.from(table.querySelectorAll('tbody tr, tr')));
      if (rows.length > bestCount) { bestCount = rows.length; best = rows; }
    }
    return dedup(best);
  };

  // 방법 1: frameLocator
  try {
    const units = await page.frameLocator(SEL_FEE).locator('body').evaluate(fn);
    if (units.length) return units;
  } catch {}

  // 방법 2: 모든 frame 순회 (진단 포함)
  const diagLines = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const url = f.url();
    if (url === 'about:blank' || url === 'about:srcdoc') continue;
    const urlShort = url.split('/').pop().substring(0, 30);
    try {
      const diag = await f.evaluate(() => {
        const ibRows  = document.querySelectorAll('tr.IBDataRow').length;
        const tables  = document.querySelectorAll('table').length;
        const donghoEl = document.querySelector('.cont_table.left');
        const ibInDH  = donghoEl ? donghoEl.querySelectorAll('tr.IBDataRow').length : 0;
        return { tables, ibRows, ibInDH };
      });
      const sample = await f.evaluate(() => {
        const el = document.querySelector('.cont_table.left');
        const rows = el ? Array.from(el.querySelectorAll('tr.IBDataRow')).slice(0, 3) : [];
        return rows.map(row =>
          Array.from(row.querySelectorAll('td')).filter(td => {
            if (td.style.width === '0px') return false;
            for (const c of td.classList) { if (c.startsWith('HideCol')) return false; }
            return true;
          }).slice(0, 3).map(td => (td.innerText || '').substring(0, 12))
        );
      }).catch(() => []);
      diagLines.push(`[${urlShort}:T${diag.tables}:IB${diag.ibRows}:DH${diag.ibInDH}:${JSON.stringify(sample)}]`);
      const units = await f.evaluate(fn);
      if (units.length) return units;
    } catch (e) {
      diagLines.push(`[${urlShort}:ERR:${e.message.substring(0, 40)}]`);
    }
  }

  return { __diag: diagLines.join(' ') };
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 특정 호 행 클릭
 *
 *  .cont_table.left → IBSection tr.IBDataRow에서 탐색
 *  동/호 분리 셀 OR N-N 합쳐진 셀 모두 처리
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, dong, ho) {
  const target = `${dong}-${ho}`;

  const fn = (t) => {
    // 전화번호·사업자번호 오탐 방지
    //  ① 뒤에 또 다른 -숫자 → 사업자번호(NNN-NN-NNNNN) 제외
    //  ② 앞에 숫자- → 전화번호 중간 그룹(010-2722-0528에서 2722-0528) 제외
    const RE = /(?<!\d[-–—])\b(\d{1,4})\s*[-–—]\s*(\d{2,4})\b(?!\s*[-–—]\s*\d)/;
    const [d, h] = t.split('-');

    function visTds(row) {
      return Array.from(row.querySelectorAll('td')).filter(td => {
        if (td.style.width === '0px' || td.style.width === '0') return false;
        for (const cls of td.classList) { if (cls.startsWith('HideCol')) return false; }
        return true;
      });
    }
    function fv(td) {
      return ((td?.innerText || '').trim().split(/[\t\n]/)[0] || '').replace(/\s+/g, '').trim();
    }

    const donghoEl = document.querySelector('.cont_table.left');
    const ibRows   = donghoEl ? Array.from(donghoEl.querySelectorAll('tr.IBDataRow')) : [];
    const rows     = ibRows.length
      ? ibRows
      : Array.from((donghoEl || document).querySelectorAll('tbody tr, tr'));

    for (const row of rows) {
      const tds = visTds(row);
      if (!tds.length) continue;
      const c0 = fv(tds[0]).replace(/[-–—]/g, '-');
      // N-N 합쳐진 셀
      if (c0 === t) { row.click(); return true; }
      const m = c0.match(RE);
      if (m && `${m[1]}-${m[2]}` === t) { row.click(); return true; }
      // 동/호 분리 셀
      if (fv(tds[0]) === d && tds.length >= 2 && fv(tds[1]) === h) {
        row.click(); return true;
      }
    }
    return false;
  };

  // 방법 1: frameLocator
  try {
    const clicked = await page.frameLocator(SEL_FEE).locator('body').evaluate(fn, target);
    if (clicked) return;
  } catch {}

  // 방법 2: 모든 frame
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
    // IBSection tr.IBDataRow 우선, fallback tbody tr
    function dataRows(container) {
      if (!container) return [];
      const ib = Array.from(container.querySelectorAll('tr.IBDataRow'));
      return ib.length ? ib : Array.from(container.querySelectorAll('tbody tr'));
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
