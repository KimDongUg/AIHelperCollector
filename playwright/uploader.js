const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const MAX_RETRIES = 3;

async function uploadFile(filePath, uploadUrl, apiKey) {
  if (!uploadUrl) {
    return { ok: false, error: 'AIHELPER_UPLOAD_URL이 설정되지 않았습니다.' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: '업로드할 파일이 존재하지 않습니다: ' + filePath };
  }

  const filename = path.basename(filePath);
  const url = `${uploadUrl}?filename=${encodeURIComponent(filename)}`;

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const body    = fs.readFileSync(filePath);
      const headers = {
        'Content-Type': 'application/octet-stream',
      };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        body,
        headers,
        timeout: 60000,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`서버 응답 ${res.status}: ${text}`);
      }

      return { ok: true };
    } catch (err) {
      lastError = err.message;
      if (attempt < MAX_RETRIES) await sleep(2000);
    }
  }

  return { ok: false, error: `${MAX_RETRIES}회 재시도 실패 — ${lastError}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { uploadFile };
