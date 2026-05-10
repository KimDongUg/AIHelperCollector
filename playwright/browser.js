const { chromium } = require('playwright');
const path = require('path');

let browser = null;
let page = null;

async function openERP(erpUrl) {
  if (!erpUrl) throw new Error('ERP_URL이 설정되지 않았습니다. .env 파일을 확인하세요.');

  // 이미 열려 있으면 재사용
  if (browser && browser.isConnected()) {
    const pages = browser.contexts()[0]?.pages() || [];
    if (pages.length > 0) {
      page = pages[0];
      await page.bringToFront();
      return page;
    }
  }

  // 시스템에 설치된 Edge 또는 Chrome 사용 (설치 파일 크기 최소화)
  const launchOpts = {
    headless: false,
    slowMo: 80,
    args: ['--start-maximized'],
  };

  // 시스템 브라우저 채널 시도: msedge → chrome → 기본 chromium 순서
  for (const channel of ['msedge', 'chrome']) {
    try {
      browser = await chromium.launch({ ...launchOpts, channel });
      break;
    } catch {
      // 해당 채널 없으면 다음 시도
    }
  }
  if (!browser) {
    browser = await chromium.launch(launchOpts);
  }

  const context = await browser.newContext({
    viewport: null,
    locale: 'ko-KR',
  });

  page = await context.newPage();
  await page.goto(erpUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page;
}

async function getPage() {
  if (!browser || !browser.isConnected()) throw new Error('ERP 브라우저가 열려있지 않습니다. [ERP 열기]를 먼저 클릭하세요.');
  const pages = browser.contexts()[0]?.pages() || [];
  if (pages.length === 0) throw new Error('ERP 페이지가 닫혔습니다. 다시 열어주세요.');
  return pages[0];
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

module.exports = { openERP, getPage, closeBrowser };
