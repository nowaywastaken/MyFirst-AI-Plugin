const writeBtn = document.getElementById("writeBtn");
const userPrompt = document.getElementById("userPrompt");
const statusDiv = document.getElementById("status");
const settingsBtn = document.getElementById("settingsBtn");

if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open(chrome.runtime.getURL('options.html'));
        }
    });
}

// === 🎒 记忆背包 UI 元素 (保持不变) ===
const toggleMemoryBtn = document.getElementById("toggleMemoryBtn");
const memoryArea = document.getElementById("memoryArea");
const memoryContent = document.getElementById("memoryContent");
const saveMemoryBtn = document.getElementById("saveMemoryBtn");

// 初始化：加载记忆
chrome.storage.local.get(["userMemory"], (result) => {
  if (result.userMemory) {
    memoryContent.value = result.userMemory;
  }
});

// 切换显示背包
toggleMemoryBtn.addEventListener("click", () => {
    if (memoryArea.style.display === "none") {
        memoryArea.style.display = "block";
        toggleMemoryBtn.innerText = "🎒 收起背包";
    } else {
        memoryArea.style.display = "none";
        toggleMemoryBtn.innerText = "🎒 我的记忆背包";
    }
});

// 保存记忆
saveMemoryBtn.addEventListener("click", () => {
    const memoryText = memoryContent.value;
    chrome.storage.local.set({ userMemory: memoryText }, () => {
        const originalText = saveMemoryBtn.innerText;
        saveMemoryBtn.innerText = "✅ 已保存";
        setTimeout(() => { saveMemoryBtn.innerText = originalText; }, 1000);
    });
});

const stopBtn = document.getElementById("stopBtn");

// =========================================
// 新逻辑：发送指令给 Background
// =========================================
writeBtn.addEventListener("click", async () => {
  const prompt = userPrompt.value;
  if (!prompt) {
    statusDiv.innerText = "⚠️ 请下达指令";
    return;
  }
  
  writeBtn.disabled = true;
  stopBtn.style.display = "block"; // 显示停止按钮
  statusDiv.innerText = "🚀 任务已发送给后台...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  chrome.runtime.sendMessage({
      type: "START_TASK",
      tabId: tab.id,
      prompt: prompt
  }, (response) => {
      // ... same error handling ...
      if (chrome.runtime.lastError) {
          statusDiv.innerText = "❌ 无法连接后台: " + chrome.runtime.lastError.message;
          writeBtn.disabled = false;
          stopBtn.style.display = "none";
      } else {
          statusDiv.innerText = "✅ 任务开始！";
          pollStatus();
      }
  });
});

stopBtn.addEventListener("click", () => {
    statusDiv.innerText = "⛔️ 正在尝试停止...";
    let stopped = false;

    // 1. 尝试礼貌地通知后台
    chrome.runtime.sendMessage({ type: "STOP_TASK" }, (response) => {
        stopped = true;
        statusDiv.innerText = "✅ 已停止";
        // Poll 马上会更新 UI
    });

    // 2. 如果后台死了 (500ms 没回音)，直接暴力强制重置 (Force Kill)
    setTimeout(() => {
        if (!stopped) {
            console.warn("后台未响应，强制重置状态 (Force Kill)");
            statusDiv.innerText = "⚠️ 后台无响应，强制重置中...";
            
            // 直接操作 Storage
            chrome.storage.local.set({ 
                "agentState": { 
                    active: false, 
                    stepInfo: "⛔️ 任务已被强制终止 (Zombie Task)",
                    lastPrompt: userPrompt.value // 尽可能保留现场
                } 
            }, () => {
                statusDiv.innerText = "✅ 已强制终止";
                // 手动刷新一下 UI
                writeBtn.disabled = false;
                writeBtn.innerText = "让 AI 生成并填写";
                stopBtn.style.display = "none";
            });
        }
    }, 500);
});

function pollStatus() {
    // 避免重复轮询
    if (window.statusInterval) clearInterval(window.statusInterval);
    
    window.statusInterval = setInterval(() => {
        chrome.runtime.sendMessage({ type: "GET_STATUS" }, (state) => {
            if (!state) return;

            // 1. 自动填入上次的 Prompt（方便重试）
            if (state.lastPrompt && !userPrompt.value) {
                userPrompt.value = state.lastPrompt;
            }

            // 2. 更新按钮状态
            if (state.active) {
                statusDiv.innerText = state.stepInfo;
                writeBtn.disabled = true; 
                writeBtn.innerText = "⏳ 任务进行中...";
                stopBtn.style.display = "block"; // 🔴 显示停止
            } else {
                // Not active
                stopBtn.style.display = "none"; // 隐藏停止
                writeBtn.disabled = false;
                writeBtn.innerText = "让 AI 生成并填写";
                
                if (state.stepInfo.startsWith("✅")) {
                     statusDiv.innerText = state.stepInfo;
                     clearInterval(window.statusInterval); 
                } else if (state.stepInfo.startsWith("⛔️")) {
                     statusDiv.innerText = state.stepInfo;
                } else {
                     // 避免显示 "Analyzing..." 等陈旧状态
                     statusDiv.innerText = "✨ 准备就绪";
                }
            }
        });
    }, 1000);
}

// 打开 Popup 时立即检查一次状态
pollStatus();