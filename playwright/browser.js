const { chromium } = require('playwright');

let browser = null;
let connectedPage = null;

async function connectERP(cdpPort) {
  const port = cdpPort || 9222;

  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    connectedPage = null;
  }

  try {
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  } catch {
    return { ok: false, error: 'no_browser' };
  }

  const page = await findERPPage(browser);

  if (!page) {
    return { ok: false, error: 'no_erp_tab' };
  }

  connectedPage = page;
  return { ok: true };
}

async function findERPPage(browser) {
  const contexts = browser.contexts();
  if (!contexts || contexts.length === 0) return null;

  const erpKeywords = ['erp', 'xp-erp', 'xperp', '관리비', 'mms', 'apt', 'apartment'];

  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      try {
        const url = p.url().toLowerCase();
        const title = (await p.title()).toLowerCase();
        if (erpKeywords.some((k) => url.includes(k) || title.includes(k))) {
          return p;
        }
      } catch {
        // 접근 불가 탭 건너뜀
      }
    }
  }

  return null;
}

async function getPage() {
  if (!browser || !browser.isConnected()) {
    throw new Error('ERP 브라우저가 연결되지 않았습니다. [ERP 브라우저 연결]을 먼저 클릭하세요.');
  }
  if (!connectedPage) {
    throw new Error('ERP 페이지를 찾을 수 없습니다. 브라우저에서 ERP를 열어주세요.');
  }
  return connectedPage;
}

async function disconnectBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    connectedPage = null;
  }
}

module.exports = { connectERP, getPage, disconnectBrowser };
