// 保存设置
const saveBtn = document.getElementById('saveBtn');
const apiKeyInput = document.getElementById('apiKey');
const statusDiv = document.getElementById('status');

// 初始化：加载现有的 Key
chrome.storage.local.get(['apiKey'], (result) => {
    if (result.apiKey) {
        apiKeyInput.value = result.apiKey;
    }
});

saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    
    if (!key) {
        showStatus('❌ API Key 不能为空', 'error');
        return;
    }

    if (!key.startsWith('sk-orn-') && !key.startsWith('sk-or-')) { 
        // 简单的格式校验，OpenRouter Key 通常以 sk-or- 开头，但也不绝对，仅作为提示
        // 这里不做强校验，以免误杀
    }

    chrome.storage.local.set({ apiKey: key }, () => {
        showStatus('✅ 设置已保存', 'success');
        setTimeout(() => {
            statusDiv.innerText = '';
        }, 2000);
    });
});

function showStatus(msg, type) {
    statusDiv.textContent = msg;
    statusDiv.className = type;
}
