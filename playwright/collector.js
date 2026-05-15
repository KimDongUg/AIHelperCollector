/**
 * XpERP 수집기 — 두 경로 방식
 *
 * 경로 1. 입주자 > 입주자현황  →  동 / 호 / 휴대폰
 * 경로 2. 부과 > 관리비조회   →  동호내역 목록 순회
 *          └─ 고지내역 / 검침내역 / 할인내역 / 항목별 부과내역
 */

const path = require('path');
const fs = require('fs');
const { getPage } = require('./browser');
const { exportExcel } = require('./exportExcel');
const { saveErrorLog } = require('./logger');

let stopFlag = false;
function stopCollect() { stopFlag = true; }

/* ═══════════════════════════════════════════════════════════
 *  MAIN
 * ═══════════════════════════════════════════════════════════ */
async function runCollect(onProgress) {
  stopFlag = false;
  const page = await getPage();
  const outputDir = path.join(__dirname, '..', 'output');
  const logsDir  = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const allData     = [];
  const failedUnits = [];

  try {
    // 1단계: 입주자현황 → 동-호 → 휴대폰 맵
    onProgress({ current: 0, total: 0, unit: '① 입주자현황 조회 중...' });
    const residentMap = await fetchResidentMap(page);

    // 2단계: 관리비조회 → 동호내역 목록
    onProgress({ current: 0, total: 0, unit: '② 관리비조회 목록 로딩 중...' });
    const feeUnits = await fetchFeeUnits(page);

    if (!feeUnits.length) {
      return { ok: false, error: '관리비조회 동호내역이 없습니다. 조회 결과를 확인하세요.' };
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
        await page.waitForTimeout(500);

        const feeData = await collectUnitFeeData(page);
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
async function fetchResidentMap(page) {
  await clickMenuByText(page, '입주자');
  await page.waitForTimeout(400);
  await clickMenuByText(page, '입주자현황');
  await page.waitForTimeout(1500);

  // 입주자현황 frame 탐지
  const target = (await findFrameByKeyword(page, ['입주자현황', '입주여부', '주거형태'])) || page;

  await checkPersonalInfoBox(target);
  await clickSearchButton(target);
  try {
    await target.waitForSelector('table tbody tr', { timeout: 10000 });
  } catch {
    await page.waitForTimeout(3000);
  }

  // 테이블 파싱 — 동 컬럼은 rowspan으로 병합되어 있음
  return await target.evaluate(() => {
    const map  = {};
    const rows = document.querySelectorAll('table tbody tr');
    let lastDong = '';

    for (const row of rows) {
      const tds = Array.from(row.querySelectorAll('td'));
      if (!tds.length) continue;

      let dong, ho, phone;

      // 동 컬럼 포함 여부: 전체 열 수로 판단
      // 헤더: 동(0) 호(1) 입주자(2) 생년월일(3) 소유주(4) 입주일(5)
      //       분양(6) 입주구분(7) 집전화(8) 휴대폰(9) ... (총 18열)
      if (tds.length >= 10) {
        // 동 컬럼 있음
        dong = tds[0].innerText.trim();
        if (dong && dong !== '합계') lastDong = dong;
        ho    = tds[1].innerText.trim();
        phone = tds[9].innerText.trim();
      } else if (tds.length >= 9) {
        // 동 컬럼 병합(없음) → 인덱스 -1 shift
        dong  = lastDong;
        ho    = tds[0].innerText.trim();
        phone = tds[8].innerText.trim();
      } else {
        continue;
      }

      if (!ho || ho === '합계') continue;
      map[`${lastDong}-${ho}`] = phone;
    }
    return map;
  });
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 동호 목록 취득
 * ═══════════════════════════════════════════════════════════ */
// 관리비조회 frame 캐시 (clickFeeUnit, collectUnitFeeData에서 재사용)
let _feeFrame = null;

async function fetchFeeUnits(page) {
  await clickMenuByText(page, '부과');
  await page.waitForTimeout(600);
  await clickMenuByText(page, '관리비조회');
  await page.waitForTimeout(2000);

  // 관리비조회 frame 탐지 — 최대 3회 재시도
  for (let i = 0; i < 3; i++) {
    _feeFrame = await findFrameByKeyword(page, ['동호내역', '부과년월', '고지내역']);
    if (_feeFrame) break;
    await page.waitForTimeout(1000);
  }
  if (!_feeFrame) _feeFrame = page;

  await checkPersonalInfoBox(_feeFrame);
  await clickSearchButton(_feeFrame);

  // 데이터 로딩 대기 (최대 20초)
  try {
    await _feeFrame.waitForSelector('table tbody tr', { timeout: 20000 });
  } catch {
    await page.waitForTimeout(5000);
  }

  // 동호내역(첫 번째 테이블)에서 목록 파싱
  return await _feeFrame.evaluate(() => {
    const result = [];
    // 동호내역 테이블: "1 - 101" 형식 행이 포함된 테이블 찾기
    const allTables = Array.from(document.querySelectorAll('table'));
    let donghoTable = null;
    for (const t of allTables) {
      const rows = Array.from(t.querySelectorAll('tr'));
      const hasDongho = rows.some(row => {
        const text = row.querySelector('td')?.innerText?.trim() || '';
        return /\d+\s*-\s*\d+/.test(text);
      });
      if (hasDongho) { donghoTable = t; break; }
    }
    if (!donghoTable) return result;

    const rows = Array.from(donghoTable.querySelectorAll('tbody tr'));
    rows.forEach((row, idx) => {
      const tds    = Array.from(row.querySelectorAll('td'));
      if (!tds.length) return;

      const dongho = tds[0].innerText.trim();
      const match  = dongho.match(/^(\d+)\s*-\s*(\d+)$/);
      if (!match) return;

      result.push({
        dongho,
        dong: match[1],
        ho:   match[2],
        _rowIndex: idx,
      });
    });
    return result;
  });
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 특정 호 클릭
 * ═══════════════════════════════════════════════════════════ */
async function clickFeeUnit(page, rowIndex) {
  const target = _feeFrame || page;
  const rows   = await target.$$('table tbody tr');
  if (rows[rowIndex]) await rows[rowIndex].evaluate(el => el.click());
}

/* ═══════════════════════════════════════════════════════════
 *  관리비조회: 선택된 호의 모든 데이터 수집
 *  (고지내역 / 검침내역 / 할인내역 / 항목별 부과내역)
 * ═══════════════════════════════════════════════════════════ */
async function collectUnitFeeData(page) {
  const target = _feeFrame || page;

  return await target.evaluate(() => {
    const data = {};

    // 첫 번째 테이블(동호내역)을 제외한 모든 테이블에서 데이터 수집
    const tables = Array.from(document.querySelectorAll('table')).slice(1);

    // 각 테이블에서 섹션 제목 찾기 (테이블 위 또는 테이블 내 th로 표시)
    tables.forEach((table) => {
      // 섹션 이름: 테이블 직전 요소의 텍스트에서 추출
      let sectionName = '';
      let prev = table.previousElementSibling;
      while (prev) {
        const t = prev.innerText ? prev.innerText.trim() : '';
        if (t && !t.startsWith('부과항목계') && t.length < 30) {
          sectionName = t.replace(/[•\s]/g, '');
          break;
        }
        prev = prev.previousElementSibling;
      }

      const rows = Array.from(table.querySelectorAll('tr'));

      // 헤더 행 감지 (th가 있는 첫 행)
      let headers = [];
      const firstRow = rows[0];
      if (firstRow) {
        headers = Array.from(firstRow.querySelectorAll('th, td'))
          .map(h => h.innerText.trim());
      }

      // 검침내역: 검침항목/전월지침/당월지침/사용량(요금) 패턴
      const isMeter = headers.some(h => h.includes('전월') || h.includes('당월지침'));

      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) return;

        if (isMeter) {
          // 검침: 첫 번째 셀=항목명, 나머지=전월/당월/요금
          const item = cells[0]?.innerText.trim();
          if (!item || item === '검침항목' || item === '항목') return;
          const prefix = `검침_${item}`;
          if (cells[1]) data[`${prefix}_전월`] = cells[1].innerText.trim().replace(/,/g, '');
          if (cells[2]) data[`${prefix}_당월`] = cells[2].innerText.trim().replace(/,/g, '');
          if (cells[3]) data[`${prefix}_요금`] = cells[3].innerText.trim().replace(/,/g, '');
        } else {
          // 일반: (항목명/금액) 쌍 반복
          for (let i = 0; i + 1 < cells.length; i += 2) {
            const key = cells[i].innerText.trim();
            const val = cells[i + 1].innerText.trim().replace(/,/g, '');
            if (!key || ['항목', '항목명', '순번', '할인항목명'].includes(key)) continue;
            if (key.startsWith('•') || key === '') continue;
            // 키 중복 방지: 이미 있으면 섹션명 접두어 추가
            const finalKey = data[key] !== undefined ? `${sectionName}_${key}` : key;
            data[finalKey] = val;
          }
        }
      });
    });

    // 항목별 부과내역 요약 숫자(input readonly)도 수집
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

/**
 * 페이지 내 모든 frame을 순회하여 특정 키워드가 포함된 frame 반환.
 * XpERP는 탭마다 별도 iframe을 사용하므로 키워드로 올바른 frame을 찾아야 함.
 */
async function findFrameByKeyword(page, keywords) {
  const frames = page.frames();
  for (const f of frames) {
    if (f === page.mainFrame()) continue;
    if (!f.url() || f.url().startsWith('about:')) continue;
    try {
      const found = await f.evaluate((kws) =>
        kws.some(k => document.body?.innerText?.includes(k)),
        keywords
      );
      if (found) return f;
    } catch {}
  }
  // 키워드 매칭 실패 시 메인 외 첫 번째 유효 frame 반환
  for (const f of frames) {
    if (f === page.mainFrame()) continue;
    if (!f.url() || f.url().startsWith('about:')) continue;
    try {
      const hasBody = await f.evaluate(() => (document.body?.innerText?.length || 0) > 50);
      if (hasBody) return f;
    } catch {}
  }
  return null;
}

/** 모든 frame에서 클릭 시도 — 성공한 frame 반환 */
async function clickInAnyFrame(page, selectors) {
  const selectorStr = Array.isArray(selectors) ? selectors.join(', ') : selectors;

  // 1. 각 frame 시도
  for (const f of page.frames()) {
    try {
      const el = f.locator(selectorStr).first();
      await el.evaluate(node => node.click());
      return f; // 성공
    } catch {}
  }
  return null;
}

async function checkPersonalInfoBox(target) {
  try {
    const cb = await target.$('input[type="checkbox"]');
    if (cb && !(await cb.isChecked())) {
      await cb.evaluate(el => el.click());
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}
}

async function clickMenuByText(page, text) {
  try {
    const el = await page.locator(`text="${text}"`).first();
    await el.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  } catch {}
}

/** 단일 frame 내에서 조회 버튼 클릭 */
async function clickSearchButton(target) {
  // 1) ID로 찾기
  try {
    const el = target.locator('#BTN_INQUIRY').first();
    if (await el.count() > 0) { await el.evaluate(n => n.click()); return; }
  } catch {}

  // 2) JS 직접 실행 — XpERP 내부 함수 호출 또는 BTN_INQUIRY.click()
  try {
    await target.evaluate(() => {
      const btn = document.getElementById('BTN_INQUIRY')
        || document.querySelector('a.basic_btn[class*="blue"]')
        || document.querySelector('a.btn_blue');
      if (btn) { btn.click(); return; }
      if (typeof doCommonSubmit === 'function') doCommonSubmit('inquiry');
      else if (typeof fnSearch === 'function') fnSearch();
      else if (typeof fn_search === 'function') fn_search();
    });
    return;
  } catch {}

  // 3) 클래스 기반 (메뉴 링크 제외)
  try {
    const el = target.locator('a.basic_btn, a.btn_blue').first();
    if (await el.count() > 0) { await el.evaluate(n => n.click()); return; }
  } catch {}
}

async function getFrame(page) {
  try {
    const frames = page.frames();
    const named  = frames.find(
      f => f.name() === 'mainFrame' || f.name() === 'contentFrame' || f.name() === 'iframe'
    );
    if (named) return named;
    const content = frames.find(
      f => f !== page.mainFrame() && f.url() && !f.url().startsWith('about:')
    );
    return content || null;
  } catch {
    return null;
  }
}

module.exports = { runCollect, stopCollect };
