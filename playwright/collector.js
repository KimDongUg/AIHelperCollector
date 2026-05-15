/**
 * XpERP 자동 수집기 메인 모듈
 *
 * [수집 전략]
 * 1. 소유주변동처리 메뉴 → 전체 목록 조회 → 세대 목록(동/호) 추출
 * 2. 각 세대 클릭 → 관리비조회 탭 → 관리비 수집
 * 3. 입주등록 탭 → 세대주/입주자 수집
 * 4. 엑셀 생성
 *
 * [selector 안내]
 * 실제 ERP HTML에 맞게 아래 SELECTORS 객체를 수정하세요.
 * F12 → Elements 탭에서 확인 후 적용.
 */

const path = require('path');
const fs = require('fs');
const { getPage } = require('./browser');
const { exportExcel } = require('./exportExcel');
const { saveErrorLog } = require('./logger');

let stopFlag = false;

const SELECTORS = {
  // 왼쪽 메뉴: 입주자 > 입주처리
  menuResident: '입주자',
  menuResidentProcess: '입주처리',
  menuOwnerChange: '소유주변동처리',
  menuMoveIn: '입주등록',

  // 소유주변동처리 화면 - 조회 버튼
  btnSearch: '조회',

  // 세대 목록 테이블 행 (동/호 포함)
  // XpERP 기준: 테이블 tbody > tr
  unitTableRow: 'table tbody tr',

  // 동, 호 셀 인덱스 (0-based)
  colDong: 1,
  colHo: 2,
  colOwnerName: 5,
  colOwnerPhone: 8,
  colResidentName: 10,
  colResidentStatus: 11,

  // 관리비조회 탭
  tabFee: '관리비조회',

  // 입주등록 탭
  tabMoveIn: '입주등록',

  // 관리비조회 화면 - 항목별 selector
  // '총관내역' 테이블 기준 — 실제 ERP에서 F12로 확인 후 수정 필요
  fee: {
    // 세대 선택 후 관리비 테이블에서 현재 선택 세대 행
    selectedRow: 'tr.selected, tr.active, tr[class*="select"]',
    totalCharge: '[id*="total"], .totalAmt, td:nth-child(5)',
    prevUnpaid: '[id*="prev"], .prevUnpaid',
    electric: '[id*="elec"], .electric',
    water: '[id*="water"], .water',
    heat: '[id*="heat"], .heat',
    generalMgmt: '[id*="general"], .general',
    clean: '[id*="clean"], .clean',
    repair: '[id*="repair"], .repair',
    discount: '[id*="discount"], .discount',
    finalPay: '[id*="final"], .finalAmt',
    unpaid: '[id*="unpaid"], .unpaid',
  },

  // 입주등록 화면 - 세대주 섹션
  resident: {
    ownerName: 'input[id*="ownerNm"], input[name*="ownerNm"], .ownerName input',
    ownerPhone: 'input[id*="ownerHp"], input[name*="ownerHp"], input[id*="handphone"]',
    residentName: 'input[id*="resNm"], input[name*="resNm"]',
    residentPhone: 'input[id*="resHp"], input[name*="resHp"]',
    moveInDate: 'input[id*="moveInDt"], input[name*="moveInDt"]',
    memo: 'input[id*="memo"], textarea[id*="memo"]',
  },
};

function stopCollect() {
  stopFlag = true;
}

async function runCollect(onProgress) {
  stopFlag = false;
  const page = await getPage();
  const outputDir = path.join(__dirname, '..', 'output');
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const allData = [];
  const failedUnits = [];

  try {
    // 1. 소유주변동처리 메뉴 접근 → 전체 세대 목록 가져오기
    const units = await fetchUnitList(page);
    if (!units || units.length === 0) {
      return { ok: false, error: '세대 목록을 가져올 수 없습니다. ERP 화면을 확인해주세요.' };
    }

    const total = units.length;
    onProgress({ current: 0, total, unit: '세대 목록 로딩 완료' });

    // 2. 각 세대 순회
    for (let i = 0; i < units.length; i++) {
      if (stopFlag) break;

      const unit = units[i];
      const unitLabel = `${unit.dong}동 ${unit.ho}호`;
      onProgress({ current: i + 1, total, unit: unitLabel });

      try {
        const feeData = await collectFeeForUnit(page, unit);
        const residentData = await collectResidentForUnit(page, unit);
        allData.push({ ...unit, ...feeData, ...residentData });
      } catch (err) {
        failedUnits.push(unitLabel);
        saveErrorLog(logsDir, unitLabel, err.message);
      }

      // 세대 간 최소 간격
      await page.waitForTimeout(100);
    }

    if (allData.length === 0) {
      return { ok: false, error: '수집된 데이터가 없습니다.' };
    }

    // 3. 엑셀 생성
    const filePath = await exportExcel(allData, outputDir);

    onProgress({ current: total, total, done: true });

    return {
      ok: true,
      filePath,
      total: allData.length,
      failed: failedUnits.length,
      failedUnits,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 소유주변동처리 화면에서 전체 세대 목록 추출
 * XpERP: 왼쪽 메뉴 입주자 > 소유주변동처리 > 조회
 */
async function fetchUnitList(page) {
  // 왼쪽 사이드 메뉴 클릭: 입주자
  await clickMenuByText(page, SELECTORS.menuResident);
  await page.waitForTimeout(500);

  // 소유주변동처리 클릭
  await clickMenuByText(page, SELECTORS.menuOwnerChange);
  await page.waitForTimeout(1000);

  // 조회 버튼 클릭 → 테이블에 행이 나타날 때까지 대기 (최대 15초)
  await clickButtonByText(page, SELECTORS.btnSearch);
  const frame0 = await getFrame(page);
  const target0 = frame0 || page;
  try {
    await target0.waitForSelector('table tbody tr, tr.jqgrow, tbody tr', { timeout: 15000 });
  } catch {
    await page.waitForTimeout(4000); // fallback
  }

  // iframe 대응
  const frame = await getFrame(page);
  const target = frame || page;

  // 테이블 행 파싱 — 여러 셀렉터 시도
  let rows = await target.$$(SELECTORS.unitTableRow);
  if (rows.length === 0) rows = await target.$$('tr.jqgrow');
  if (rows.length === 0) rows = await target.$$('tbody tr');
  if (rows.length === 0) {
    const allTr = await target.$$('tr');
    throw new Error(`세대 목록 없음 (table tbody tr: 0개, 전체 tr: ${allTr.length}개). XpERP 화면에서 조회 결과가 표시되는지 확인하세요.`);
  }

  const units = [];

  for (const row of rows) {
    const cells = await row.$$('td');
    if (cells.length < 3) continue;

    const dong = (await cells[SELECTORS.colDong]?.innerText() || '').trim();
    const ho = (await cells[SELECTORS.colHo]?.innerText() || '').trim();
    if (!dong || !ho) continue;
    // 합계 행 제외
    if (dong === '합계' || ho === '합계' || dong.includes('합계')) continue;

    const ownerName = cells[SELECTORS.colOwnerName]
      ? (await cells[SELECTORS.colOwnerName].innerText()).trim()
      : '';
    const ownerPhone = cells[SELECTORS.colOwnerPhone]
      ? (await cells[SELECTORS.colOwnerPhone].innerText()).trim()
      : '';

    // _row 대신 인덱스 저장 (스테일 핸들 방지)
    units.push({ dong, ho, ownerName, ownerPhone, _rowIndex: units.length });
  }

  return units;
}

/**
 * 관리비조회 탭에서 해당 세대의 관리비 데이터 수집
 */
async function collectFeeForUnit(page, unit) {
  // 인덱스로 행 재조회 후 클릭 (스테일 핸들 방지)
  if (unit._rowIndex !== undefined) {
    const frame = await getFrame(page);
    const target = frame || page;
    let rows = await target.$$(SELECTORS.unitTableRow);
    if (rows.length === 0) rows = await target.$$('tr.jqgrow');
    if (rows.length === 0) rows = await target.$$('tbody tr');
    const row = rows[unit._rowIndex];
    if (row) await row.evaluate((el) => el.click());
    await page.waitForTimeout(300);
  }

  await clickTabByText(page, SELECTORS.tabFee);
  await page.waitForTimeout(400);

  const frame = await getFrame(page);
  const target = frame || page;

  const extract = async (selector) => {
    try {
      const el = await target.$(selector);
      if (!el) return '';
      const text = (await el.innerText()).trim();
      return text.replace(/,/g, '').replace(/[^0-9\-]/g, '') || text;
    } catch {
      return '';
    }
  };

  return {
    totalCharge: await extract(SELECTORS.fee.totalCharge),
    prevUnpaid: await extract(SELECTORS.fee.prevUnpaid),
    electric: await extract(SELECTORS.fee.electric),
    water: await extract(SELECTORS.fee.water),
    heat: await extract(SELECTORS.fee.heat),
    generalMgmt: await extract(SELECTORS.fee.generalMgmt),
    clean: await extract(SELECTORS.fee.clean),
    repair: await extract(SELECTORS.fee.repair),
    discount: await extract(SELECTORS.fee.discount),
    finalPay: await extract(SELECTORS.fee.finalPay),
    unpaid: await extract(SELECTORS.fee.unpaid),
  };
}

/**
 * 입주등록 탭에서 세대주/입주자 정보 수집
 */
async function collectResidentForUnit(page, unit) {
  await clickTabByText(page, SELECTORS.tabMoveIn);
  await page.waitForTimeout(400);

  const frame = await getFrame(page);
  const target = frame || page;

  const extractInput = async (selector) => {
    try {
      const el = await target.$(selector);
      if (!el) return '';
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      if (tag === 'input' || tag === 'textarea') return (await el.inputValue()).trim();
      return (await el.innerText()).trim();
    } catch {
      return '';
    }
  };

  return {
    residentOwnerName: await extractInput(SELECTORS.resident.ownerName),
    residentOwnerPhone: await extractInput(SELECTORS.resident.ownerPhone),
    residentName: await extractInput(SELECTORS.resident.residentName),
    residentPhone: await extractInput(SELECTORS.resident.residentPhone),
    moveInDate: await extractInput(SELECTORS.resident.moveInDate),
    memo: await extractInput(SELECTORS.resident.memo),
  };
}

// ── helpers ───────────────────────────────────────────────

async function clickMenuByText(page, text) {
  try {
    const el = await page.locator(`text="${text}"`).first();
    await el.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  } catch {
    // 메뉴가 없거나 이미 열려있을 수 있음
  }
}

async function clickButtonByText(page, text) {
  const frame = await getFrame(page);
  const target = frame || page;

  // XpERP 알려진 버튼 ID 매핑
  const knownIds = { '조회': '#BTN_INQUIRY' };
  if (knownIds[text]) {
    try {
      const el = target.locator(knownIds[text]).first();
      await el.evaluate((node) => node.click()); // JS 클릭 — 뷰포트 밖 요소도 처리
      return;
    } catch {}
  }

  const btn = target.locator(
    `button:text-is("${text}"), input[value="${text}"], a:text-is("${text}")`
  ).first();
  // JS 클릭으로 뷰포트 제한 우회
  await btn.evaluate((node) => node.click());
}

async function clickTabByText(page, text) {
  const frame = await getFrame(page);
  const target = frame || page;
  try {
    // :text-is() = 정확 일치 CSS 의사클래스
    const tab = await target.locator(`:text-is("${text}")`).first();
    await tab.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  } catch {
    // 탭 클릭 실패 시 무시하고 계속
  }
}

async function getFrame(page) {
  try {
    const frames = page.frames();
    // 1. 명칭으로 탐색
    const named = frames.find(
      (f) => f.name() === 'mainFrame' || f.name() === 'contentFrame' || f.name() === 'iframe'
    );
    if (named) return named;
    // 2. 메인 프레임 외 컨텐츠 프레임 탐색 (XpERP 탭 영역)
    const content = frames.find(
      (f) => f !== page.mainFrame() && f.url() && !f.url().startsWith('about:')
    );
    return content || null;
  } catch {
    return null;
  }
}

module.exports = { runCollect, stopCollect };
