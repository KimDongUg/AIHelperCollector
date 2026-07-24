/**
 * MV3 서비스워커 — content.js/popup.js에서 chrome.runtime.sendMessage로 요청받아
 * AccHelper 서버(acchelper.kr)로 크로스오리진 fetch를 대신 수행.
 * (content script에서 직접 fetch하면 페이지 CORS 제약을 받을 수 있어, host_permissions가
 *  적용되는 백그라운드에서 실행 — CORS 우회는 manifest의 host_permissions 덕분)
 */
const API_BASE = 'https://acchelper.kr';

async function callApi(path, { method = 'GET', apiKey, body } = {}) {
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, data };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__aihelper_bg) return false;

  (async () => {
    try {
      if (msg.action === 'VERIFY_KEY') {
        const r = await callApi('/api/collector/verify', { apiKey: msg.apiKey });
        sendResponse(r);
        return;
      }
      if (msg.action === 'UPLOAD_FEE') {
        const r = await callApi('/api/collector/upload-json', {
          method: 'POST',
          apiKey: msg.apiKey,
          body: { year_month: msg.yearMonth, rows: msg.rows },
        });
        sendResponse(r);
        return;
      }
      sendResponse({ ok: false, status: 0, data: { detail: '알 수 없는 요청' } });
    } catch (e) {
      sendResponse({ ok: false, status: 0, data: { detail: String(e) } });
    }
  })();

  return true; // 비동기 응답이므로 채널을 열어둠
});
