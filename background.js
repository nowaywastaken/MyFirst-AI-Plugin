// ==========================================
// 🤖 Zeroutine-Plugin Background Service Worker
// ==========================================
// 架构 V2: 方案 B（命令式 AI）+ 方案 C（视觉模型）+ 项目级记忆
// 核心改进：一次性规划 + 确定性执行 + 视觉修复

// =================配置=================
const CONFIG = {
    maxSteps: 50,
    apiMinInterval: 500,
    defaultTimeout: 10000
};

// Rate limiting
let lastApiCallTime = 0;

// =================模块加载=================
// 在 Service Worker 中导入模块
importScripts(
    'lib/memory_manager.js',
    'lib/planner.js',
    'lib/executor.js',
    'lib/vision.js',
    'lib/session_memory.js' // V5 Session Memory
);

// =================全局状态=================
let globalState = {
    active: false,
    tabId: null,
    task: null,
    currentStepIndex: 0,
    stepInfo: '🚀 扩展已就绪',
    waitingForLoad: false,
    lastPrompt: ''
};

// 状态持久化
function saveState() {
    chrome.storage.local.set({ agentState: globalState });
}

async function restoreState() {
    const data = await chrome.storage.local.get('agentState');
    if (data.agentState) {
        globalState = { ...globalState, ...data.agentState };
    }
}

// 初始化
chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.set({
        agentState: { active: false, stepInfo: '🚀 扩展已就绪', waitingForLoad: false }
    });
    
    // 清理过期记忆
    if (self.MemoryManager) {
        const cleaned = await self.MemoryManager.cleanupExpiredMemory();
        if (cleaned > 0) {
            console.log(`🧹 清理了 ${cleaned} 个过期域名记忆`);
        }
    }
    
    chrome.alarms.clearAll();
});

// Service Worker 恢复
restoreState();

// =================消息处理=================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // 🚀 新的智能任务启动
    if (request.type === 'SMART_START') {
        console.log('🚀 收到任务请求:', request.prompt);
        sendResponse({ status: 'analyzing' });
        
        (async () => {
            try {
                await handleSmartStart(request.tabId, request.prompt, request.mode);
            } catch (e) {
                console.error('任务启动失败:', e);
                globalState.active = false;
                globalState.stepInfo = '❌ 启动失败: ' + e.message;
                saveState();
                updateOverlay(request.tabId, globalState.stepInfo);
            }
        })();
        return true;
    }
    
    // 传统任务启动（兼容）
    if (request.type === 'START_TASK') {
        handleSmartStart(request.tabId, request.prompt, 'AGENT');
        sendResponse({ status: 'ok' });
        return true;
    }
    
    // 停止任务
    if (request.type === 'STOP_TASK') {
        console.log('🛑 任务终止');
        globalState.active = false;
        globalState.stepInfo = '⛔️ 任务已由用户终止';
        globalState.waitingForLoad = false;
        saveState();
        chrome.alarms.clearAll();
        
        if (globalState.tabId) {
            updateOverlay(globalState.tabId, globalState.stepInfo);
        }
        sendResponse({ status: 'stopped' });
        return true;
    }
    
    // 获取状态
    if (request.type === 'GET_STATUS') {
        chrome.storage.local.get('agentState', (data) => {
            sendResponse(data.agentState || globalState);
        });
        return true;
    }
    
    // 脚本相关（保留原有功能）
    if (request.type === 'GENERATE_SCRIPT') {
        handleScriptGeneration(request.tabId, request.url, request.prompt)
            .then(() => sendResponse({ status: 'ok' }))
            .catch(err => sendResponse({ status: 'error', error: err.message }));
        return true;
    }
    
    if (request.type === 'REPAIR_SCRIPT') {
        handleScriptRepair(request.tabId, request.scriptId, request.complaint)
            .then(() => sendResponse({ status: 'ok' }))
            .catch(err => sendResponse({ status: 'error', error: err.message }));
        return true;
    }
    
    if (request.type === 'CONVERT_HISTORY_TO_SCRIPT') {
        if (!globalState.task?.steps) {
            sendResponse({ status: 'error', error: 'No task history found' });
            return true;
        }
        
        const targetTabId = request.tabId || globalState.tabId;
        chrome.tabs.get(targetTabId, (tab) => {
            // 将任务步骤转换为脚本
            convertTaskToScript(globalState.task, tab?.url || '*')
                .then(() => sendResponse({ status: 'ok' }))
                .catch(err => sendResponse({ status: 'error', error: err.message }));
        });
        return true;
    }
});

// =================新核心流程（迭代规划 V2）=================

/**
 * 智能任务启动 - 迭代模式
 */
async function handleSmartStart(tabId, prompt, mode) {
    // 0. 强制重置上一任务状态 (确保隔离)
    await resetTaskState(tabId);

    // 1. 初始化新状态
    const effectivePrompt = prompt || "AUTONOMOUS_MODE: Analyze page and infer intent";
    
    globalState = {
        active: true,
        tabId,
        userGoal: effectivePrompt,
        sessionId: null, // V5: Will be set below
        actionHistory: [], // Keep for backward compat, but use SessionMemory
        goalStack: [],
        stepInfo: '🔍 正在分析页面...',
        waitingForLoad: false,
        lastPrompt: prompt,
        lastPageHash: null,
        iterationCount: 0
    };
    
    // V5: 创建新会话
    const tab = await chrome.tabs.get(tabId);
    const sessionId = await self.SessionMemory.createSession(effectivePrompt, tabId, tab.url);
    globalState.sessionId = sessionId;
    
    saveState();
    
    // 2. 注入 Overlay
    await injectOverlay(tabId);
    updateOverlay(tabId, globalState.stepInfo);
    
    // 3. 检查受限页面
    // (tab already declared above for session creation)
    if (isRestrictedUrl(tab.url)) {
        globalState.stepInfo = '⚠️ 受限页面，无法执行自动化';
        globalState.active = false;
        saveState();
        updateOverlay(tabId, globalState.stepInfo);
        return;
    }
    
    // 4. 检查模式
    if (mode === 'SCRIPT') {
        updateOverlay(tabId, '📜 正在生成脚本...');
        await handleScriptGeneration(tabId, tab.url, prompt);
        return;
    }
    
    // 5. 获取配置
    const apiConfig = await chrome.storage.local.get(['apiKey', 'providerUrl', 'modelName']);
    if (!apiConfig.apiKey) {
        globalState.stepInfo = '❌ 请先在设置中配置 API Key';
        globalState.active = false;
        saveState();
        updateOverlay(tabId, globalState.stepInfo);
        return;
    }
    
    // 6. 启动看门狗 (Watchdog)
    const watchdogInterval = setInterval(() => {
        if (!globalState.active) {
            clearInterval(watchdogInterval);
            return;
        }
        
        const now = Date.now();
        const lastActive = globalState.lastActivity || now;
        if (now - lastActive > 45000) { // 45秒无响应
            console.error('🚨 Watchdog: Task stalled, forcing restart step...');
            clearInterval(watchdogInterval);
            
            // 尝试恢复或报错
            globalState.stepInfo = '⚠️ 任务响应超时，正在尝试自动恢复...';
            saveState();
            updateOverlay(tabId, globalState.stepInfo);
            
            // 简单策略：重置 lastActivity 并让循环继续（如果不卡死），或者强制抛错
            // 如果 runIterativeLoop 里的 await 卡死，这里也救不了，除非我们重启 loop
            // 但如果 JS 线程卡死，interval 也不跑。通常是 await fetch 卡住。
            // 最好是把 fetch 加上 timeout。
        }
    }, 5000);
    
    // 7. 开始迭代执行循环
    try {
        await runIterativeLoop(tabId, prompt, apiConfig);
    } finally {
        clearInterval(watchdogInterval);
    }
}

/**
 * 迭代执行循环 - 核心逻辑
 */
async function runIterativeLoop(tabId, userGoal, apiConfig) {
    const MAX_ITERATIONS = 30;
    const userMemoryData = await chrome.storage.local.get('userMemory');
    const userMemory = parseUserMemory(userMemoryData.userMemory || '');
    
    // 初始化活跃时间
    globalState.lastActivity = Date.now();
    
    while (globalState.active && globalState.iterationCount < MAX_ITERATIONS) {
        globalState.iterationCount++;
        globalState.lastActivity = Date.now(); // Update heartbeat
        
        try {
            // 1. 等待页面稳定
            await delay(300);
            
            // 2. 检查 tab 是否还存在
            let tab;
            try {
                tab = await chrome.tabs.get(tabId);
            } catch (e) {
                globalState.stepInfo = '❌ 页面已关闭';
                globalState.active = false;
                break;
            }
            
            // 3. 分析当前页面
            updateOverlay(tabId, `🔍 分析页面... (第 ${globalState.iterationCount} 轮)`);
            const pageData = await analyzePage(tabId);
            
            // 4. 获取项目记忆
            const domain = self.MemoryManager?.extractDomain(tab.url) || 'unknown';
            const memory = await self.MemoryManager?.getProjectMemory(domain) || {};
            
            // 5. 尝试获取截图
            let screenshot = null;
            try {
                if (self.Vision) {
                    screenshot = await self.Vision.captureScreenshot(tabId, { resize: true });
                }
            } catch (e) {
                // 截图失败不影响流程
            }
            
            // 6. 调用 AI 规划下一步
            updateOverlay(tabId, '🧠 AI 正在思考...');
            const planResult = await self.Planner.planNextStep({
                userGoal,
                pageData,
                screenshot,
                actionHistory: globalState.actionHistory,
                memory,
                apiConfig,
                memory,
                apiConfig,
                memory,
                apiConfig,
                tabId,  // 传递 tabId 用于流式思考显示
                goalStack: globalState.goalStack || [], // Cognitive State
                previousPageHash: globalState.lastPageHash // 🌟 Mechanical Guard
            });
            
            // 更新认知状态
            if (planResult.updatedGoalStack) {
                globalState.goalStack = planResult.updatedGoalStack;
            }
            
            // 更新页面指纹
            if (pageData.contentHash) {
                globalState.lastPageHash = pageData.contentHash;
            }
            
            // 7. 检查是否完成
            if (planResult.goalCompleted) {
                globalState.stepInfo = `✅ 任务完成！${planResult.completionReason || ''}`;
                globalState.active = false;
                saveState();
                updateOverlay(tabId, globalState.stepInfo);
                console.log('🎉 任务完成:', planResult.completionReason);
                break;
            }
            
            // 8. 检查是否有下一步
            if (!planResult.nextStep) {
                globalState.stepInfo = '❓ AI 无法确定下一步操作';
                globalState.active = false;
                saveState();
                updateOverlay(tabId, globalState.stepInfo);
                break;
            }
            
            // 9. 执行下一步
            const step = planResult.nextStep;
            const resolvedStep = self.Planner.resolveStepPlaceholders(step, userMemory);
            
            // 🛡️ V4: Repetition Detector
            const recentActions = globalState.actionHistory.slice(-3);
            const isDuplicate = recentActions.filter(a => 
                a.action === resolvedStep.action && a.target === resolvedStep.target
            ).length >= 2;
            
            if (isDuplicate) {
                console.warn('🔁 Repetition Detected: Same action+target 3 times. Forcing rethink.');
                updateOverlay(tabId, '⚠️ 检测到重复操作，尝试不同策略...');
                
                // 在 history 中标记循环，让下一轮 AI 知道
                globalState.actionHistory.push({
                    step: globalState.iterationCount,
                    action: 'SYSTEM_LOOP_DETECTED',
                    target: null,
                    description: `Repeated action blocked: ${resolvedStep.action} on ${resolvedStep.target}`,
                    success: false,
                    error: 'Loop prevention triggered'
                });
                
                // Skip to next iteration without executing
                continue;
            }
            
            // 记录执行前的页面指纹
            const beforeHash = pageData.contentHash;
            
            // 9.5 解析虚拟 Key (例如 ai_1, ai_2) 为真实 CSS 选择器
            // AI 现在返回 interactiveMap 中的 Key (ai-id)
            const targetKey = resolvedStep.target;
            if (targetKey && pageData.interactiveMap && pageData.interactiveMap[targetKey]) {
                const realSelector = pageData.interactiveMap[targetKey];
                console.log(`🔄 Resolving AI ID '${targetKey}' -> '${realSelector}'`);
                resolvedStep.target = realSelector;
            } else if (targetKey && (pageData.inputs || pageData.buttons)) {
                // 兼容旧版逻辑 (Run safe fallback)
                let realSelector = null;
                const matchedInput = pageData.inputs?.find(i => i.key === targetKey);
                if (matchedInput?.selector) realSelector = matchedInput.selector;
                
                if (!realSelector) {
                    const matchedButton = pageData.buttons?.find(b => b.key === targetKey);
                    if (matchedButton?.selector) realSelector = matchedButton.selector;
                }
                
                if (realSelector) {
                    resolvedStep.target = realSelector;
                }
            }
            
            updateOverlay(tabId, `⚡️ [${globalState.iterationCount}] ${resolvedStep.description}`);
            globalState.stepInfo = `⚡️ ${resolvedStep.description}`;
            saveState();
            
            // 10. 执行操作
            const stepResult = await self.Executor.executeStep(resolvedStep, {
                tabId,
                userMemory,
                pageUrl: tab.url
            });
            
            // 11. 记录历史 (V4: Rich Feedback)
            // 重新获取页面状态计算 afterHash
            let afterHash = beforeHash;
            try {
                const postPageData = await analyzePage(tabId);
                afterHash = postPageData.contentHash || beforeHash;
            } catch(e) { /* 忽略 */ }
            
            const stateChange = beforeHash !== afterHash ? 'PAGE_CHANGED' : 'PAGE_SAME';
            
            // 🆕 检查是否出现错误/成功消息 (让 AI 感知验证结果)
            let pageMessage = null;
            try {
                const msgCheck = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        // 查找常见的消息元素
                        const selectors = [
                            '.error', '.alert-error', '.alert-danger', '.message-error',
                            '.success', '.alert-success', '.message-success',
                            '[role="alert"]', '[role="status"]',
                            '.feedback', '.validation-message', '.form-error'
                        ];
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el && el.innerText?.trim()) {
                                return el.innerText.trim().substring(0, 100);
                            }
                        }
                        return null;
                    }
                });
                pageMessage = msgCheck[0]?.result;
            } catch(e) { /* ignore */ }
            
            // 构建丰富的状态反馈
            let richStateChange = stateChange;
            if (pageMessage) {
                richStateChange = `${stateChange} | PAGE_MESSAGE: "${pageMessage}"`;
            }
            
            globalState.actionHistory.push({
                step: globalState.iterationCount,
                action: resolvedStep.action,
                target: resolvedStep.target,
                description: resolvedStep.description,
                success: stepResult.success,
                error: stepResult.error,
                stateChange: richStateChange // 🌟 Enhanced Feedback
            });
            
            // V5: Persist to SessionMemory
            await self.SessionMemory.addStep(globalState.sessionId, {
                action: resolvedStep.action,
                target: resolvedStep.target,
                value: resolvedStep.value,
                description: resolvedStep.description,
                result: stateChange,
                success: stepResult.success,
                error: stepResult.error
            });
            
            saveState();
            
            // 12. 处理执行结果
            if (!stepResult.success) {
                console.warn(`⚠️ 步骤失败: ${stepResult.error}`);
                
                // 尝试视觉修复
                if (self.Vision) {
                    updateOverlay(tabId, '🔧 尝试视觉修复...');
                    const repairResult = await self.Vision.repairSelector(tabId, resolvedStep, apiConfig);
                    
                    if (repairResult.success) {
                        // 用新选择器重试
                        resolvedStep.target = repairResult.newSelector;
                        const retryResult = await self.Executor.executeStep(resolvedStep, {
                            tabId,
                            userMemory,
                            pageUrl: tab.url
                        });
                        
                        if (retryResult.success) {
                            globalState.actionHistory[globalState.actionHistory.length - 1].success = true;
                            globalState.actionHistory[globalState.actionHistory.length - 1].repaired = true;
                            
                            // 保存修复后的选择器
                            if (self.MemoryManager) {
                                await self.MemoryManager.saveSelector(
                                    tab.url,
                                    resolvedStep.description,
                                    repairResult.newSelector,
                                    true
                                );
                            }
                        }
                    }
                }
            }
            
            // 13. 如果是点击或导航，等待页面变化
            if (['click', 'navigate'].includes(resolvedStep.action)) {
                updateOverlay(tabId, '⏳ 等待页面响应...');
                await waitForPageStable(tabId, 3000);
            }
            
        } catch (error) {
            console.error('迭代循环错误:', error);
            const errorMsg = error.message || String(error);
            globalState.stepInfo = `❌ 错误: ${errorMsg.substring(0, 50)}...`; // 避免过长
            
            // 发送给 Overlay 显示详细错误
            updateOverlay(tabId, `❌ 未预期的错误: ${errorMsg}`);
            
            // 严重错误停止，但如果是临时网络错误等可以考虑重试（当前简化为停止）
            globalState.active = false;
            saveState();
            
            // 向 popup 发送错误以便调试
            chrome.runtime.sendMessage({ 
                type: 'TASK_ERROR', 
                error: errorMsg 
            }).catch(() => {});
            
            break;
        }
    }
    
    // 循环结束
    if (globalState.iterationCount >= MAX_ITERATIONS && globalState.active) {
        globalState.stepInfo = '⚠️ 达到最大迭代次数，任务停止';
        globalState.active = false;
        saveState();
        updateOverlay(tabId, globalState.stepInfo);
    }
}

/**
 * 重置任务状态 (隔离旧记忆)
 */
async function resetTaskState(tabId) {
    console.log('🧹 Cleaning up previous task state...');
    
    // 停止当前活动
    globalState.active = false;
    globalState.waitingForLoad = false;
    
    // 清除所有报警器/计时器
    await chrome.alarms.clearAll();
    
    // 如果有之前的 Overlay，尝试清除或更新状态
    if (tabId) {
        // 通知清除旧的思考内容
        chrome.tabs.sendMessage(tabId, { type: 'AI_THINKING_CLEAR' }).catch(() => {});
    }

    // 确保 globalState 被完全重置（虽然会被覆盖，这里做深度清理）
    globalState = {
        active: false,
        tabId: null,
        task: null,
        currentStepIndex: 0,
        stepInfo: '🚀 扩展已就绪',
        waitingForLoad: false,
        lastPrompt: ''
    };
    
    await saveState();
}

/**
 * 等待页面稳定
 */
async function waitForPageStable(tabId, timeout = 3000) {
    const startTime = Date.now();
    let lastUrl = '';
    let stableCount = 0;
    
    while (Date.now() - startTime < timeout) {
        try {
            const tab = await chrome.tabs.get(tabId);
            
            // 等待页面加载完成
            if (tab.status !== 'complete') {
                stableCount = 0;
                await delay(200);
                continue;
            }
            
            // 检查 URL 是否稳定
            if (tab.url === lastUrl) {
                stableCount++;
                if (stableCount >= 3) {
                    return; // 页面稳定
                }
            } else {
                lastUrl = tab.url;
                stableCount = 0;
            }
            
            await delay(200);
        } catch (e) {
            // Tab 可能已关闭
            return;
        }
    }
}

// =================辅助函数=================

/**
 * 检查是否为受限 URL
 */
function isRestrictedUrl(url) {
    return url.startsWith('chrome://') || 
           url.startsWith('edge://') || 
           url.startsWith('about:') || 
           url.startsWith('view-source:') ||
           url.startsWith('chrome-extension://');
}

/**
 * 分析页面元素
 */
async function analyzePage(tabId) {
    let result = await chrome.scripting.executeScript({
        target: { tabId },
        func: analyzePageElements
    });
    
    let data = result[0]?.result;
    
    // 如果 SnapshotGenerator 未加载，注入并重试
    if (data && data.error === 'SnapshotGenerator not loaded') {
        console.log('🔧 Injecting dom_tools.js for SnapshotGenerator...');
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['lib/dom_tools.js']
        });
        
        // Retry
        result = await chrome.scripting.executeScript({
            target: { tabId },
            func: analyzePageElements
        });
        data = result[0]?.result;
    }

    return data || { domTree: '', interactiveMap: {}, text: '', inputs: [], buttons: [] };
}

/**
 * 页面元素分析函数（注入到页面）
 */
/**
 * 页面元素分析函数（注入到页面）
 */
function analyzePageElements() {
    // 确保工具已加载
    if (!window.SnapshotGenerator) {
        return { error: 'SnapshotGenerator not loaded' };
    }
    
    const snapshot = window.SnapshotGenerator.generateSnapshot();
    
    // 序列化 interactiveMap (只保留 selector)
    const map = {};
    for (const [key, value] of Object.entries(snapshot.interactiveMap)) {
        map[key] = value.selector;
    }
    
    return {
        domTree: snapshot.domTree, // 伪HTML树字符串
        interactiveMap: map,       // ai_id -> selector
        contentHash: snapshot.contentHash, // 🌟 State Hash
        url: window.location.href,
        title: document.title
    };
}

/**
 * 注入 Overlay
 */
async function injectOverlay(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        });
    } catch (e) {
        console.warn('Overlay 注入失败:', e);
    }
}

/**
 * 更新 Overlay 显示
 */
function updateOverlay(tabId, text) {
    chrome.tabs.sendMessage(tabId, { type: 'UPDATE_OVERLAY', text }).catch(() => {});
}

/**
 * 解析用户记忆（从文本格式解析为对象）
 */
function parseUserMemory(memoryText) {
    const memory = {};
    if (!memoryText) return memory;
    
    // 支持 key: value 和 key=value 格式
    const lines = memoryText.split('\n');
    for (const line of lines) {
        const match = line.match(/^(\w+)\s*[:=]\s*(.+)$/);
        if (match) {
            memory[match[1].trim()] = match[2].trim();
        }
    }
    
    return memory;
}

/**
 * 延迟函数
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =================脚本生成（保留原有功能）=================

async function handleScriptGeneration(tabId, url, userPrompt) {
    // ... 保留原有的脚本生成逻辑
    // 这部分代码与原来一样，用于生成 Tampermonkey 风格的脚本
    
    const tab = await chrome.tabs.get(tabId);
    const actualUrl = url || tab?.url || '*';
    
    // 获取页面数据
    let pageData = { text: '' };
    try {
        const result = await chrome.scripting.executeScript({ target: { tabId }, function: analyzePageElements });
        pageData = result[0].result;
    } catch (e) {}
    
    // 调用 AI 生成脚本
    const apiConfig = await chrome.storage.local.get(['apiKey', 'providerUrl', 'modelName']);
    
    if (!apiConfig.apiKey) {
        throw new Error('API Key 未配置');
    }
    
    const prompt = `
    任务: 创建一个 Tampermonkey 风格的 JavaScript 脚本来实现: "${userPrompt}"
    
    页面 URL: ${actualUrl}
    页面标题: ${pageData.title || 'Unknown'}
    可用输入框: ${JSON.stringify(pageData.inputs?.slice(0, 10))}
    可用按钮: ${JSON.stringify(pageData.buttons?.slice(0, 10))}
    
    要求:
    1. 代码要能在页面加载后自动执行
    2. 使用稳定的选择器
    3. 添加适当的错误处理
    
    返回 JSON:
    {
      "code": "完整的 JavaScript 代码",
      "name": "脚本简短名称",
      "explanation": "脚本功能说明"
    }
    `;
    
    const response = await callAI(prompt, 'json_object', apiConfig);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 返回格式无效');
    
    const data = JSON.parse(jsonMatch[0]);
    
    // 保存脚本
    const { userScripts: currentScripts } = await chrome.storage.local.get('userScripts');
    const newScripts = currentScripts || [];
    
    const scriptId = crypto.randomUUID();
    newScripts.push({
        id: scriptId,
        name: data.name || 'AI Script',
        matches: actualUrl.split('?')[0] + '*',
        enabled: true,
        createdAt: Date.now()
    });
    
    await chrome.storage.local.set({
        userScripts: newScripts,
        [`ujs_${scriptId}`]: data.code
    });
    
    updateOverlay(tabId, `✅ 脚本已生成: ${data.name}`);
    globalState.active = false;
    saveState();
    
    return true;
}

async function handleScriptRepair(tabId, scriptId, complaint) {
    // 保留原有的脚本修复逻辑
    const { userScripts } = await chrome.storage.local.get('userScripts');
    const script = userScripts?.find(s => s.id === scriptId);
    if (!script) throw new Error('Script not found');
    
    const codeData = await chrome.storage.local.get(`ujs_${scriptId}`);
    const currentCode = codeData[`ujs_${scriptId}`] || '';
    
    const apiConfig = await chrome.storage.local.get(['apiKey', 'providerUrl', 'modelName']);
    
    const prompt = `
    修复这个脚本，用户反馈: "${complaint}"
    
    当前代码:
    ${currentCode}
    
    返回 JSON:
    {
      "code": "修复后的代码",
      "explanation": "修复说明"
    }
    `;
    
    const response = await callAI(prompt, 'json_object', apiConfig);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 返回格式无效');
    
    const data = JSON.parse(jsonMatch[0]);
    
    await chrome.storage.local.set({ [`ujs_${scriptId}`]: data.code });
    
    return true;
}

async function convertTaskToScript(task, url) {
    // 将任务步骤转换为可重复执行的脚本
    const steps = task.steps.map(step => {
        switch (step.action) {
            case 'fill':
                return `document.querySelector('${step.target}').value = '${step.value}';`;
            case 'click':
                return `document.querySelector('${step.target}').click();`;
            default:
                return `// ${step.action}: ${step.description}`;
        }
    }).join('\n');
    
    const code = `
// Auto-generated from task: ${task.intent || 'Unknown'}
(function() {
    function run() {
        ${steps}
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();
`;
    
    const { userScripts: currentScripts } = await chrome.storage.local.get('userScripts');
    const newScripts = currentScripts || [];
    
    const scriptId = crypto.randomUUID();
    newScripts.push({
        id: scriptId,
        name: task.intent || 'Converted Task',
        matches: url.split('?')[0] + '*',
        enabled: true,
        createdAt: Date.now()
    });
    
    await chrome.storage.local.set({
        userScripts: newScripts,
        [`ujs_${scriptId}`]: code
    });
    
    return scriptId;
}

// =================AI 调用=================

async function callAI(prompt, format = 'json_object', config = {}) {
    const { apiKey, providerUrl, modelName } = config.apiKey ? config : await chrome.storage.local.get(['apiKey', 'providerUrl', 'modelName']);
    
    if (!apiKey) {
        throw new Error('API Key 未配置');
    }
    
    // Rate limiting
    const now = Date.now();
    const elapsed = now - lastApiCallTime;
    if (elapsed < CONFIG.apiMinInterval) {
        await delay(CONFIG.apiMinInterval - elapsed);
    }
    lastApiCallTime = Date.now();
    
    const endpoint = providerUrl || 'https://openrouter.ai/api/v1/chat/completions';
    const model = modelName || 'google/gemini-2.0-flash-001';
    
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            response_format: { type: format },
            messages: [
                { role: 'system', content: '你是一个浏览器自动化专家。只输出 JSON。' },
                { role: 'user', content: prompt }
            ]
        })
    });
    
    const data = await response.json();
    
    if (data.error) {
        const safeMessage = data.error.message?.replace(/sk-[a-zA-Z0-9]+/g, '[REDACTED]') || 'Unknown API error';
        throw new Error(safeMessage);
    }
    
    return data.choices?.[0]?.message?.content || '';
}

// =================页面加载监听=================

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    
    // 用户脚本注入（保留原有功能）
    try {
        const { userScripts } = await chrome.storage.local.get('userScripts');
        if (userScripts?.length > 0) {
            const matchedScripts = userScripts.filter(script => {
                if (!script.enabled || !script.matches) return false;
                try {
                    const pattern = script.matches.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
                    return new RegExp(`^${pattern}$`).test(tab.url);
                } catch { return false; }
            });
            
            if (matchedScripts.length > 0) {
                const keys = matchedScripts.map(s => `ujs_${s.id}`);
                const codeMap = await chrome.storage.local.get(keys);
                
                for (const script of matchedScripts) {
                    const code = codeMap[`ujs_${script.id}`];
                    if (code) {
                        chrome.scripting.executeScript({
                            target: { tabId },
                            func: (code) => {
                                const el = document.createElement('script');
                                el.textContent = code;
                                (document.head || document.documentElement).appendChild(el);
                                el.remove();
                            },
                            args: [code],
                            world: 'MAIN'
                        }).catch(() => {});
                    }
                }
            }
        }
    } catch (e) {}
    
    // Agent 状态恢复
    if (globalState.active && tabId === globalState.tabId && globalState.waitingForLoad) {
        console.log('页面加载完成，继续执行...');
        globalState.waitingForLoad = false;
        saveState();
        
        // 重新注入 Overlay
        await injectOverlay(tabId);
        updateOverlay(tabId, globalState.stepInfo);
    }
});

// =================Alarm 处理=================

chrome.alarms.onAlarm.addListener((alarm) => {
    // 预留用于未来的定时任务
    console.log('Alarm:', alarm.name);
});

console.log('🤖 Zeroutine V2 已启动');
