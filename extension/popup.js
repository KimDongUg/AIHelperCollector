(function () {
  const input = document.getElementById('apiKey');
  const btn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  chrome.storage.local.get('aihelper_api_key').then((v) => {
    if (v.aihelper_api_key) input.value = v.aihelper_api_key;
  });

  btn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) {
      setStatus('API 키를 입력해주세요.', 'err');
      return;
    }
    btn.disabled = true;
    setStatus('확인 중...', '');

    const resp = await chrome.runtime.sendMessage({ __aihelper_bg: true, action: 'VERIFY_KEY', apiKey: key });
    btn.disabled = false;

    if (resp && resp.ok) {
      await chrome.storage.local.set({ aihelper_api_key: key });
      setStatus(`✅ 저장됨 — "${resp.data.company_name}" 계정으로 업로드됩니다.`, 'ok');
    } else {
      const detail = (resp && resp.data && resp.data.detail) || '알 수 없는 오류';
      setStatus(`❌ 확인 실패: ${detail}`, 'err');
    }
  });
})();
